"use strict";

const { HarnessAdapter } = require("../harness-adapter");
const { CodexAppServerClient } = require("./codex-app-server-client");
const {
  mapCodexTurnPolicy,
  CodexPolicyError,
  denyResponseFor,
  isApprovalRequest,
  approvalSummaryFrom,
  createCodexTurnCollector,
} = require("./codex-app-server-events");
const { buildRunMetrics } = require("../../chat/chat-run-metrics");

// Stage C-3 — CodexManagedAdapter
//
// 하나의 long-lived `codex app-server --stdio` connection 위에서 role-scoped Codex
// thread를 관리하는 persistent adapter다. HarnessRuntime이 codex provider에 등록한다.
//
// 확정 계약:
//   - control-plane authority 없음. context/invocation이 authoritative input이며
//     argv를 reverse-parse하지 않는다.
//   - logicalHandle = session.key + "#" + session.generation. 같은 handle -> 같은 thread.
//     generation/role/provider/model/workspace/run/permission이 다르면 SessionKey가
//     달라져 새 thread다(HarnessSessionRegistry가 identity를 보장).
//   - native thread memory는 cache다. 매 turn에 현재 invocation.prompt 전체를 다시 보낸다.
//   - notification은 params.threadId로 정확히 active turn에 route한다(role leakage 금지).
//   - approval은 same-turn resume(C-6)이 아니다. deny + approvalRequired 반환(compat replay).
//   - session loss(process crash / protocol desync)면 fail-closed. Process fallback 금지,
//     자동 restart 금지.

const DEFAULT_SILENCE_WARNING_MS = 5 * 60 * 1000;
const SILENCE_CHECK_INTERVAL_MS = 30 * 1000;

class CodexManagedAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super({ id: "codex-managed", supportsPersistentSession: true });
    this._createClient = typeof options.createClient === "function"
      ? options.createClient
      : (opts) => new CodexAppServerClient(opts);
    this._client = null;
    this._clientStart = null;
    this._runtimeIdentity = null; // { commandPath, needsShell }
    this._threads = new Map();    // logicalHandle -> { threadId }
    this._activeTurns = new Map(); // threadId -> turnState
    this._replayRequired = new Set(); // logicalHandle: approval 발생 후 재사용 금지
  }

  // ---- HarnessAdapter.runTurn ----
  runTurn({ context = null, invocation, session } = {}) {
    // cancel을 동기적으로 배선해, turn/start 응답(=turnId 확보) 전에 취소가 와도
    // 잃지 않는다(section 24 race). ts가 만들어지면 control.ts로 연결한다.
    const control = { cancelRequested: false, ts: null };
    const cancel = () => {
      control.cancelRequested = true;
      const ts = control.ts;
      if (ts) {
        ts.cancelRequested = true;
        if (ts.turnId) this._interrupt(ts);
      }
    };
    const promise = new Promise((resolve) => {
      this._runTurnInner({ context, invocation, session, control }, resolve)
        .catch((error) => {
          resolve(this._failResult(context, invocation, {
            error: error?.message || String(error),
            stopReason: error?.code || "CODEX_TURN_FAILED",
          }));
        });
    });
    return { promise, cancel };
  }

  async _runTurnInner({ context, invocation, session, control }, resolve) {
    if (!invocation || !session || !session.key) {
      resolve(this._failResult(context, invocation, { error: "잘못된 managed turn 요청입니다.", stopReason: "CODEX_TURN_START_FAILED" }));
      return;
    }
    const logicalHandle = `${session.key}#${session.generation != null ? session.generation : 0}`;

    // (1) runtime identity 확인 (section 37): 다른 commandPath/shell이면 fail-closed.
    const identity = { commandPath: invocation.commandPath, needsShell: Boolean(invocation.needsShell) };
    if (this._runtimeIdentity) {
      if (this._runtimeIdentity.commandPath !== identity.commandPath
        || this._runtimeIdentity.needsShell !== identity.needsShell) {
        resolve(this._failResult(context, invocation, { error: "Codex 런타임 identity가 변경되었습니다.", stopReason: "CODEX_APP_SERVER_RUNTIME_MISMATCH" }));
        return;
      }
    }

    // (2) client 확보. LOST/CLOSED면 자동 restart 없이 fail-closed.
    try {
      await this._ensureClient(identity);
    } catch (error) {
      resolve(this._failResult(context, invocation, { error: error?.message, stopReason: error?.code || "CODEX_APP_SERVER_START_FAILED" }));
      return;
    }

    // (3) turn policy 매핑을 먼저 검증(fail-closed면 thread/turn을 시작하지 않는다).
    let policy;
    try {
      policy = mapCodexTurnPolicy({
        permissionMode: context && context.permissionMode,
        autoApprove: Boolean(context && context.autoApprove),
        cwd: invocation.cwd,
        workspaceId: context && context.workspaceId,
      });
    } catch (error) {
      const code = error instanceof CodexPolicyError ? error.code : "CODEX_PERMISSION_INVALID";
      resolve(this._failResult(context, invocation, { error: error?.message, stopReason: code }));
      return;
    }

    // (4) thread 확보. approval로 replay-required가 된 handle은 재사용하지 않는다.
    let threadId;
    try {
      threadId = await this._ensureThread(logicalHandle, { context, invocation, policy });
    } catch (error) {
      resolve(this._failResult(context, invocation, { error: error?.message, stopReason: error?.code || "CODEX_THREAD_START_FAILED" }));
      return;
    }

    // 같은 thread에 이미 active turn이 있으면 안 된다(HarnessRuntime single-flight가 보장).
    if (this._activeTurns.has(threadId)) {
      resolve(this._failResult(context, invocation, { error: "이미 실행 중인 turn이 있습니다.", stopReason: "SESSION_BUSY" }));
      return;
    }

    // (5) turn 상태 구성
    const startedAt = Date.now();
    const ts = {
      threadId,
      logicalHandle,
      turnId: null,
      settled: false,
      cancelRequested: false,
      timedOut: false,
      outputLimited: false,
      approval: null,
      requireFinal: Boolean(invocation.requireFinal),
      startedAt,
      promptChars: String(invocation.prompt || "").length,
      context,
      invocation,
      stdoutBytes: 0,
      silenceTimer: null,
      timeoutTimer: null,
      lastActivityAt: startedAt,
      resolve,
    };
    ts.collector = createCodexTurnCollector({ onEvent: invocation.onEvent });
    this._activeTurns.set(threadId, ts);

    // 이미 취소가 요청된 상태면 이어받는다. 이후 turn/start 응답에서 turnId 확보 시 interrupt.
    if (control) {
      control.ts = ts;
      if (control.cancelRequested) ts.cancelRequested = true;
    }

    // timeout (기존 계약: invocation.timeoutMs가 지정된 경우에만)
    if (Number.isFinite(invocation.timeoutMs) && invocation.timeoutMs > 0) {
      ts.timeoutTimer = setTimeout(() => {
        if (ts.settled) return;
        ts.timedOut = true;
        this._interrupt(ts);
        this._finalize(ts, {
          ok: false,
          timedOut: true,
          error: `시간 초과 (${Math.round(invocation.timeoutMs / 1000)}초)`,
          ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
        });
      }, invocation.timeoutMs);
      if (typeof ts.timeoutTimer.unref === "function") ts.timeoutTimer.unref();
    }

    // silence warning (status only, turn을 죽이지 않는다)
    const silenceMs = Number.isFinite(invocation.silenceWarningMs) && invocation.silenceWarningMs > 0
      ? invocation.silenceWarningMs
      : DEFAULT_SILENCE_WARNING_MS;
    let nextSilenceAt = startedAt + silenceMs;
    ts.silenceTimer = setInterval(() => {
      if (ts.settled) return;
      const now = Date.now();
      if (now < nextSilenceAt) return;
      const idleMinutes = Math.max(1, Math.round((now - ts.lastActivityAt) / 60000));
      if (typeof invocation.onEvent === "function") {
        try { invocation.onEvent({ kind: "status", label: `${idleMinutes}분째 응답 없음` }); } catch {}
      }
      nextSilenceAt = now + silenceMs;
    }, Math.min(silenceMs, SILENCE_CHECK_INTERVAL_MS));
    if (typeof ts.silenceTimer.unref === "function") ts.silenceTimer.unref();

    // (6) turn/start
    const input = this._buildTurnInput(invocation);
    const turnParams = {
      threadId,
      input,
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      cwd: policy.cwd,
    };
    if (context && context.modelKey) turnParams.model = context.modelKey;
    if (context && context.effort) turnParams.effort = context.effort;

    let turnResult;
    try {
      turnResult = await this._client.request("turn/start", turnParams);
    } catch (error) {
      if (ts.settled) return; // 이미 session-loss 등으로 종료됨
      this._finalize(ts, { ok: false, error: error?.message, stopReason: error?.code || "CODEX_TURN_START_FAILED" });
      return;
    }
    if (ts.settled) return;
    const turnId = turnResult && turnResult.turn && turnResult.turn.id;
    if (turnId) ts.turnId = turnId;
    // turn/start 응답이 오기 전에 취소가 요청됐다면 즉시 interrupt.
    if (ts.cancelRequested && ts.turnId) this._interrupt(ts);
    // 응답에 이미 완료 상태가 실려 온 경우(빠른 turn) 즉시 finalize.
    if (turnResult && turnResult.turn && turnResult.turn.status
      && turnResult.turn.status !== "inProgress") {
      this._finalizeFromTurn(ts, turnResult.turn);
    }
    // 그 외에는 turn/completed notification을 기다린다(_finalizeFromTurn).
  }

  _buildTurnInput(invocation) {
    const input = [];
    const prompt = String(invocation.prompt || "");
    input.push({ type: "text", text: prompt });
    // native local-image delivery. control plane이 준비한 metadata만 사용(argv --image 재파싱 금지).
    const images = Array.isArray(invocation.images) ? invocation.images : [];
    for (const image of images) {
      const path = typeof image === "string" ? image : (image && image.path);
      if (path) input.push({ type: "localImage", path });
    }
    return input;
  }

  async _ensureClient(identity) {
    if (this._client && (this._client.state === "lost" || this._client.state === "closed")) {
      // 이미 잃은 연결은 되살리지 않는다(section 38). fail-closed.
      const err = new Error("Codex App Server 연결이 종료되었습니다.");
      err.code = "CODEX_SESSION_LOST";
      throw err;
    }
    if (!this._client) {
      this._runtimeIdentity = identity;
      this._client = this._createClient({
        commandPath: identity.commandPath,
        needsShell: identity.needsShell,
        onNotification: (method, params) => this._onNotification(method, params),
        onServerRequest: (id, method, params) => this._onServerRequest(id, method, params),
        onClose: (info) => this._onClose(info),
      });
      this._clientStart = this._client.start();
    }
    await this._clientStart;
  }

  async _ensureThread(logicalHandle, { context, invocation, policy }) {
    // approval로 replay-required가 된 handle은 기존 thread를 재사용하지 않고 새로 만든다.
    if (this._replayRequired.has(logicalHandle)) {
      this._threads.delete(logicalHandle);
      this._replayRequired.delete(logicalHandle);
    }
    const existing = this._threads.get(logicalHandle);
    if (existing && existing.threadId) return existing.threadId;

    // thread/start baseline: least-privilege. 실제 실행 권한은 turn/start override에서 명시.
    const params = {
      cwd: invocation.cwd,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    };
    if (context && context.modelKey) params.model = context.modelKey;

    let result;
    try {
      result = await this._client.request("thread/start", params);
    } catch (error) {
      const err = new Error(error?.message || "thread/start 실패");
      err.code = error?.code === "CODEX_SESSION_LOST" ? "CODEX_SESSION_LOST" : "CODEX_THREAD_START_FAILED";
      throw err;
    }
    const threadId = result && result.thread && result.thread.id;
    if (!threadId) {
      const err = new Error("thread/start 응답에 thread.id가 없습니다.");
      err.code = "CODEX_THREAD_START_FAILED";
      throw err;
    }
    this._threads.set(logicalHandle, { threadId });
    return threadId;
  }

  _interrupt(ts) {
    if (!ts.turnId || !this._client || !this._client.isReady()) return;
    // best-effort. interrupt 실패로 turn 결과를 성공으로 바꾸지 않는다.
    this._client.request("turn/interrupt", { threadId: ts.threadId, turnId: ts.turnId }).catch(() => {});
  }

  _noteActivity(ts, method, params) {
    ts.lastActivityAt = Date.now();
    // 상관된 protocol 메시지만 per-run raw log에 기록(shared stdout 전체 금지).
    if (typeof ts.invocation.onRawChunk === "function") {
      try {
        const raw = JSON.stringify({ method, params });
        ts.stdoutBytes += Buffer.byteLength(raw, "utf8");
        ts.invocation.onRawChunk(raw + "\n");
      } catch {}
    } else {
      try { ts.stdoutBytes += Buffer.byteLength(JSON.stringify(params || {}), "utf8"); } catch {}
    }
    // hard output limit: 한 turn만 interrupt(shared server kill 금지).
    const limit = ts.invocation.hardOutputLimitBytes;
    if (Number.isFinite(limit) && limit > 0 && ts.stdoutBytes > limit && !ts.settled && !ts.outputLimited) {
      ts.outputLimited = true;
      this._interrupt(ts);
      this._finalize(ts, {
        ok: false,
        outputLimited: true,
        error: "출력이 설정된 상한을 넘어 실행을 중단했습니다.",
        ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
      });
    }
  }

  _onNotification(method, params) {
    const threadId = params && params.threadId;
    if (!threadId) return;
    const ts = this._activeTurns.get(threadId);
    if (!ts || ts.settled) return;

    if (method === "turn/started") {
      if (!ts.turnId && params.turn && params.turn.id) ts.turnId = params.turn.id;
      if (ts.cancelRequested && ts.turnId) this._interrupt(ts);
      this._noteActivity(ts, method, params);
      return;
    }
    if (method === "turn/completed") {
      this._noteActivity(ts, method, params);
      this._finalizeFromTurn(ts, params.turn);
      return;
    }
    // per-turn event
    this._noteActivity(ts, method, params);
    ts.collector.ingest(method, params);
  }

  _onServerRequest(id, method, params) {
    // 항상 안전한 deny/empty로 응답해 서버가 무한 대기하지 않게 한다.
    if (this._client && this._client.isReady()) {
      this._client.respond(id, denyResponseFor(method));
    }
    if (!isApprovalRequest(method)) return; // auth/attestation 등 infra 요청은 turn을 실패시키지 않는다.
    const threadId = params && params.threadId;
    const ts = threadId ? this._activeTurns.get(threadId) : null;
    if (!ts || ts.settled) return;
    // approval 발생: 이 thread를 replay-required로 표시하고 turn을 종료한다.
    ts.approval = approvalSummaryFrom(method, params);
    this._replayRequired.add(ts.logicalHandle);
    this._interrupt(ts);
    this._finalize(ts, {
      ok: false,
      approvalRequired: true,
      approval: ts.approval,
    });
  }

  _onClose(info) {
    // client lost/closed: 모든 active turn을 fail-closed로 종료. 자동 restart 없음.
    const code = (info && info.code) || "CODEX_SESSION_LOST";
    for (const ts of this._activeTurns.values()) {
      if (!ts.settled) {
        this._finalize(ts, {
          ok: false,
          error: (info && info.detail) || "Codex 세션이 종료되었습니다.",
          stopReason: code,
          ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
        });
      }
    }
    this._activeTurns.clear();
    this._threads.clear();
  }

  _finalizeFromTurn(ts, turn) {
    if (ts.settled) return;
    // approval이 이미 잡혔으면 approvalRequired가 우선(turn/completed=interrupted로 올 수 있음).
    if (ts.approval) {
      this._finalize(ts, { ok: false, approvalRequired: true, approval: ts.approval });
      return;
    }
    const status = turn && turn.status;
    const trusted = ts.collector.trustedFinal;
    if (status === "completed") {
      if (trusted && trusted.trim()) {
        this._finalize(ts, { ok: true, text: trusted });
        return;
      }
      if (ts.requireFinal) {
        this._finalize(ts, {
          ok: false,
          protocolFailed: true,
          stopReason: "PROTOCOL_FINAL_MISSING",
          error: "구조화된 최종 응답을 확인하지 못했습니다.",
          ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
        });
        return;
      }
      const fallback = ts.collector.deltaText.trim();
      if (fallback) {
        this._finalize(ts, { ok: true, text: fallback });
        return;
      }
      this._finalize(ts, { ok: false, error: ts.collector.lastError || "빈 응답" });
      return;
    }
    if (status === "failed") {
      const detail = (turn && turn.error && turn.error.message) || ts.collector.lastError || "실행 실패";
      this._finalize(ts, {
        ok: false,
        error: detail,
        stopReason: "CODEX_TURN_FAILED",
        ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
      });
      return;
    }
    if (status === "interrupted") {
      if (ts.timedOut) return; // timeout 경로에서 이미 finalize
      if (ts.outputLimited) return;
      this._finalize(ts, {
        ok: false,
        cancelled: true,
        error: "중지됨",
        ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
      });
      return;
    }
    // 알 수 없는 상태는 성공으로 승격하지 않는다.
    this._finalize(ts, { ok: false, error: `알 수 없는 turn 상태: ${status}`, stopReason: "CODEX_TURN_FAILED" });
  }

  _finalize(ts, partial) {
    if (ts.settled) return;
    ts.settled = true;
    if (ts.timeoutTimer) clearTimeout(ts.timeoutTimer);
    if (ts.silenceTimer) clearInterval(ts.silenceTimer);
    this._activeTurns.delete(ts.threadId);

    const evidence = ts.collector.buildEvidence();
    const output = { stdoutBytes: ts.stdoutBytes, captureTruncated: false };
    const base = { ...partial, output, ...(evidence ? { evidence } : {}) };
    const runMetrics = buildRunMetrics({
      provider: ts.context && ts.context.providerId,
      model: ts.context && ts.context.modelKey,
      effort: ts.context && ts.context.effort,
      stage: ts.context && ts.context.role,
      startedAt: ts.startedAt,
      finishedAt: Date.now(),
      promptChars: ts.promptChars,
      result: base,
    });
    if (typeof ts.invocation.onEvent === "function") {
      try { ts.invocation.onEvent({ kind: "run-metrics", metrics: runMetrics }); } catch {}
    }
    ts.resolve({ ...base, runMetrics });
  }

  _failResult(context, invocation, partial) {
    // thread/turn을 시작하지 못한 경우의 fail-closed 결과(+ bounded runMetrics).
    const startedAt = Date.now();
    const base = {
      ok: false,
      ...partial,
      output: { stdoutBytes: 0, captureTruncated: false },
    };
    const runMetrics = buildRunMetrics({
      provider: context && context.providerId,
      model: context && context.modelKey,
      effort: context && context.effort,
      stage: context && context.role,
      startedAt,
      finishedAt: startedAt,
      promptChars: String((invocation && invocation.prompt) || "").length,
      result: base,
    });
    return { ...base, runMetrics };
  }

  // Agora 종료 시 orphan child 방지(section 40). health/restart는 이후 Stage.
  close() {
    if (this._client) {
      try { this._client.close(); } catch {}
    }
    this._activeTurns.clear();
    this._threads.clear();
  }
}

module.exports = { CodexManagedAdapter };
