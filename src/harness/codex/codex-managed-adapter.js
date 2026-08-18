"use strict";

const { HarnessAdapter } = require("../harness-adapter");
const { CodexAppServerClient } = require("./codex-app-server-client");
const {
  mapCodexTurnPolicy,
  CodexPolicyError,
  denyResponseFor,
  classifyApprovalRequest,
  approvalDecisionResponse,
  buildApprovalView,
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
//   - command/file approval은 same-turn이다: 사용자 승인 콜백(invocation.requestApproval)을
//     기다렸다가 같은 native turn에 accept/decline으로 응답하고 turn을 계속 진행한다. 정상
//     승인/거절로 turn을 interrupt하거나 whole-turn replay하지 않는다. permissions(granular)/
//     legacy(v1)/non-approval infra server request는 기존처럼 즉시 safe response한다.
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
    // BLOCKER 2: native continuity가 손상된 logicalHandle -> 다음 turn에서 재사용 fail-closed.
    this._invalidatedHandles = new Map(); // logicalHandle -> reason
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
        // 사용자 same-turn 승인 콜백이 있을 때만 on-request를 연다(없으면 fail-safe never).
        interactiveApproval: typeof invocation.requestApproval === "function",
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
      pendingApprovals: new Map(), // requestId(string) -> { id, method, itemId, responded, abort }
      seenApprovalIds: new Set(),  // 이 turn에서 이미 prompt한 request id(중복/재전송 idempotent)
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
        // native completion을 확인하지 않고 로컬에서 강제 finalize한다. interrupt 결과(성공/
        // 지연/실패/timeout)와 무관하게 이 handle을 "즉시" invalidate해, 다음 turn이 아직
        // 살아있을 수 있는 native thread에 turn/start를 먼저 보내는 race를 원천 차단한다.
        this._invalidateHandle(ts.logicalHandle, "CODEX_TURN_INTERRUPT_FAILED");
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
    // 대화형 승인 turn에서만 승인 라우팅을 명시적으로 사용자에게 고정한다(설치 스키마 지원 값).
    if (policy.approvalsReviewer) turnParams.approvalsReviewer = policy.approvalsReviewer;
    if (context && context.modelKey) turnParams.model = context.modelKey;
    if (context && context.effort) turnParams.effort = context.effort;

    let turnResult;
    try {
      turnResult = await this._client.request("turn/start", turnParams);
    } catch (error) {
      if (ts.settled) return; // 이미 session-loss 등으로 종료됨
      const code = error && error.code;
      if (code === "CODEX_APP_SERVER_PROTOCOL_ERROR") {
        // ambiguous: 서버가 turn을 시작했는지 알 수 없다(응답 유실/timeout). native
        // continuity를 신뢰할 수 없으므로 이 handle을 재사용 불가로 표시한다(BLOCKER 2).
        this._invalidateHandle(ts.logicalHandle, "CODEX_TURN_START_AMBIGUOUS");
        this._finalize(ts, { ok: false, error: error?.message, stopReason: "CODEX_TURN_START_AMBIGUOUS" });
      } else {
        // 명시적 rpc error 등(서버가 turn을 시작하지 않고 거부): turn은 시작되지 않았으므로
        // thread continuity는 유지된다. handle을 invalidate하지 않는다.
        this._finalize(ts, { ok: false, error: error?.message, stopReason: code || "CODEX_TURN_START_FAILED" });
      }
      return;
    }
    if (ts.settled) return;
    // turn/start 응답의 turn.id는 authoritative turnId source다. 이미 turn/started가
    // 다른 id로 확정했다면 protocol mismatch로 fail-closed한다(BLOCKER 1 principle 5).
    const rpcTurn = turnResult && turnResult.turn;
    if (this._correlateTurn(ts, rpcTurn && rpcTurn.id, true) === "mismatch") {
      this._protocolMismatch(ts, "turn/start 응답과 turn/started의 turnId 충돌");
      return;
    }
    // turn/start 응답 전에 취소가 요청됐다면 즉시 interrupt.
    if (ts.cancelRequested && ts.turnId) this._interrupt(ts);
    // 응답에 이미 완료 상태가 실려 온 경우(빠른 turn) 즉시 finalize.
    if (rpcTurn && rpcTurn.status && rpcTurn.status !== "inProgress") {
      this._finalizeFromTurn(ts, rpcTurn);
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
    // BLOCKER 2: native continuity가 손상된 handle은 재사용하지 않고 fail-closed한다
    // (조용한 재사용/새 thread 생성/Process fallback/자동 restart 없음).
    if (this._invalidatedHandles.has(logicalHandle)) {
      const err = new Error("이 logical Codex session은 native continuity가 손상되어 재사용할 수 없습니다.");
      err.code = this._invalidatedHandles.get(logicalHandle) || "CODEX_SESSION_LOST";
      throw err;
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
    if (!ts.turnId || !this._client || !this._client.isReady()) {
      // interrupt를 보내야 하는데 보낼 수 없다(turnId 미확보/연결 불가). turn이 실제로
      // 멈췄는지 확인 불가 -> native continuity 손상으로 표시(다음 turn 재사용 fail-closed).
      this._invalidateHandle(ts.logicalHandle, "CODEX_TURN_INTERRUPT_FAILED");
      return;
    }
    // active turn만 interrupt한다(shared App Server process는 죽이지 않는다).
    this._client.request("turn/interrupt", { threadId: ts.threadId, turnId: ts.turnId })
      .catch(() => {
        // interrupt 실패/timeout -> turn이 실제로 중단됐는지 확인 불가 -> 재사용 금지.
        this._invalidateHandle(ts.logicalHandle, "CODEX_TURN_INTERRUPT_FAILED");
      });
  }

  // turnId 상관관계. 반환: "match" | "stale" | "mismatch".
  // authoritative source(turn/start RPC 응답, turn/started notification)만 최초 turnId를
  // 확정하며, 확정 후 authoritative source가 다른 id를 주장하면 "mismatch"(protocol 위반)다.
  // 비-authoritative message(item/*, turn/completed, error, approval)가 확정 turnId와 다르면
  // "stale"(이전 turn의 지연 도착)로 보고 버린다.
  _correlateTurn(ts, observedTurnId, authoritative) {
    if (observedTurnId == null) return authoritative ? "match" : "stale";
    if (ts.turnId == null) {
      if (authoritative) { ts.turnId = String(observedTurnId); return "match"; }
      return "stale";
    }
    if (ts.turnId === String(observedTurnId)) return "match";
    return authoritative ? "mismatch" : "stale";
  }

  // native continuity를 신뢰할 수 없게 된 logical thread를 재사용 불가로 표시한다.
  // C7 health framework가 아니라 이 patch에 필요한 최소 상태만 둔다.
  _invalidateHandle(logicalHandle, reason) {
    if (!logicalHandle) return;
    if (!this._invalidatedHandles.has(logicalHandle)) {
      this._invalidatedHandles.set(logicalHandle, reason || "CODEX_SESSION_LOST");
    }
    this._threads.delete(logicalHandle);
  }

  _protocolMismatch(ts, detail) {
    this._invalidateHandle(ts.logicalHandle, "CODEX_APP_SERVER_PROTOCOL_ERROR");
    this._finalize(ts, {
      ok: false,
      error: `Codex 프로토콜 불일치: ${detail}`,
      stopReason: "CODEX_APP_SERVER_PROTOCOL_ERROR",
    });
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
      // 강제 local finalize -> handle을 즉시 invalidate(위 timeout과 동일 이유: interrupt
      // Promise가 pending/성공/실패 어느 쪽이든 다음 turn의 thread 선점 race를 없앤다).
      this._invalidateHandle(ts.logicalHandle, "CODEX_TURN_INTERRUPT_FAILED");
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

    // serverRequest/resolved는 { threadId, requestId }만 갖고 turnId가 없다(설치 스키마).
    // generic turnId 필터에 묻히지 않게 먼저 처리한다: pending native approval을 정리하고
    // 대기 중인 사용자 UI를 dismiss한다(late decision 무효화). turn을 finalize하지 않는다.
    if (method === "serverRequest/resolved") {
      this._onServerRequestResolved(ts, params);
      return;
    }

    if (method === "turn/started") {
      // authoritative turnId source. 확정 id와 충돌하면 protocol mismatch로 fail-closed.
      if (this._correlateTurn(ts, params.turn && params.turn.id, true) === "mismatch") {
        this._protocolMismatch(ts, "turn/started turnId 충돌");
        return;
      }
      if (ts.cancelRequested && ts.turnId) this._interrupt(ts);
      this._noteActivity(ts, method, params);
      return;
    }
    if (method === "turn/completed") {
      // 이전 turn의 지연 turn/completed가 현재 turn을 finalize하면 안 된다(BLOCKER 1-B).
      if (this._correlateTurn(ts, params.turn && params.turn.id, false) !== "match") return;
      this._noteActivity(ts, method, params);
      this._finalizeFromTurn(ts, params.turn);
      return;
    }
    // per-turn event(item/*, error 등): turnId가 현재 active turn과 일치할 때만 수용.
    // 이전 turn의 지연 delta/evidence가 현재 turn에 유입되면 안 된다(BLOCKER 1-A).
    if (this._correlateTurn(ts, params.turnId, false) !== "match") return;
    this._noteActivity(ts, method, params);
    ts.collector.ingest(method, params);
  }

  _respondSafely(id, result) {
    if (this._client && this._client.isReady()) {
      try { return this._client.respond(id, result); } catch { return false; }
    }
    return false;
  }

  _onServerRequest(id, method, params) {
    const cls = classifyApprovalRequest(method);
    // command/file approval만 사용자 same-turn 승인 대상이다. 즉시 deny-first 하지 않고
    // 아래 비동기 흐름에서 사용자 결정을 기다렸다가 같은 request id에 응답한다.
    if (cls === "command" || cls === "file") {
      this._onApprovalRequest(id, method, params, cls);
      return;
    }
    // permissions(granular grant -> 빈 grant fail-closed) / legacy(v1 abort) / non-approval
    // infra(user-input/elicitation/tool-call/attestation 등)는 즉시 안전 응답한다. turn은
    // 계속되며 사용자 승인 UI를 띄우거나 finalize하지 않는다.
    this._respondSafely(id, denyResponseFor(method));
  }

  // command/file same-turn approval: correlate -> register -> await human -> respond same id.
  async _onApprovalRequest(id, method, params, cls) {
    const rid = String(id);
    const threadId = params && params.threadId;
    const ts = threadId ? this._activeTurns.get(threadId) : null;
    // (a) active turn correlation(wrong thread/turn/missing turnId): 현재 active turn과
    // threadId+turnId가 정확히 일치할 때만 사용자에게 띄운다. 아니면 stale로 보고 사용자 UI
    // 없이 이 action만 safe decline한다(현재 turn 상태를 변경하지 않는다).
    if (!ts || ts.settled || this._correlateTurn(ts, params.turnId, false) !== "match") {
      this._respondSafely(id, approvalDecisionResponse(method, "decline"));
      return;
    }
    // (b) duplicate/재전송 request id: 이 turn에서 이미 prompt한 id면(pending이든 이미 응답됐든)
    //     두 번째 human prompt도, 두 번째 accept/decline 응답도 만들지 않는다(idempotent ignore).
    if (ts.seenApprovalIds.has(rid)) return;
    // (c) 사용자 승인 콜백이 없으면 자동 승인하지 않고 safe decline.
    const requestApproval = ts.invocation && ts.invocation.requestApproval;
    if (typeof requestApproval !== "function") {
      this._respondSafely(id, approvalDecisionResponse(method, "decline"));
      return;
    }
    // (d) bounded human view. file인데 무엇이 바뀌는지 설명할 수 없으면 blind approve 대신 safe decline.
    const view = buildApprovalView(method, params, ts.collector.getItemContext(params.itemId));
    if (cls === "file" && !view.usable) {
      this._respondSafely(id, approvalDecisionResponse(method, "decline"));
      return;
    }
    // (e) native pending 등록(per-turn state; role/session boundary 우회 금지). abort로 turn
    // 종료 시 사용자 UI를 dismiss하고 late accept를 막는다.
    const abort = new AbortController();
    const pending = { id, method, itemId: params.itemId || null, responded: false, abort };
    ts.seenApprovalIds.add(rid);
    ts.pendingApprovals.set(rid, pending);
    this._noteActivity(ts, method, params);

    let approved = false;
    try {
      approved = Boolean(await requestApproval({
        summary: view.summary,
        detail: view.detail,
        scope: "action",
        signal: abort.signal,
      }));
    } catch {
      approved = false; // 콜백 throw/reject -> 자동 승인 금지, 아래 stillActive면 safe decline.
    }

    // (f) 결정이 온 뒤 turn/request가 여전히 "정상 active"한지 재확인한다. 취소/timeout/output-
    // limit/turn 종료/serverRequest-resolved 이후에는 accept/decline을 절대 보내지 않는다(late
    // accept 금지). 남은 native 응답(cancel)과 UI dismiss는 cleanup/resolved 경로가 담당한다.
    const stillActive = !ts.settled
      && !ts.cancelRequested && !ts.timedOut && !ts.outputLimited
      && this._activeTurns.get(ts.threadId) === ts
      && ts.pendingApprovals.get(rid) === pending
      && !pending.responded;
    if (!stillActive) return;

    pending.responded = true;
    ts.pendingApprovals.delete(rid);
    // (g) boolean 결정 -> 설치 스키마 one-shot decision. approve="accept"(ONE action),
    // deny="decline"(ONE action; whole-turn cancel 아님). same request id로 응답한다.
    const sent = this._respondSafely(id, approvalDecisionResponse(method, approved ? "accept" : "decline"));
    if (!sent) {
      // (h) 응답 전송 실패: native continuity가 애매하다. 조용히 승인 처리하지 않고 fail-closed
      // 한다(handle invalidate + best-effort interrupt + typed stopReason).
      this._invalidateHandle(ts.logicalHandle, "CODEX_APPROVAL_RESPONSE_FAILED");
      this._interrupt(ts);
      this._finalize(ts, {
        ok: false,
        error: "승인 응답을 안전하게 전송하지 못했습니다.",
        stopReason: "CODEX_APPROVAL_RESPONSE_FAILED",
        ...(ts.collector.deltaText.trim() ? { partialText: ts.collector.deltaText.trim() } : {}),
      });
      return;
    }
    // (i) 정상: interrupt/finalize/replay 없이 같은 native turn의 다음 notification을 기다린다.
  }

  // serverRequest/resolved: 해당 requestId의 pending을 정리하고 대기 UI를 dismiss한다(idempotent).
  // 이미 응답을 보냈든 아니든, resolved 이후의 late human 결정은 무효가 된다.
  _onServerRequestResolved(ts, params) {
    const rid = params && params.requestId != null ? String(params.requestId) : null;
    if (!rid) return;
    const pending = ts.pendingApprovals.get(rid);
    if (!pending) return; // 이미 응답/정리됨 -> idempotent.
    ts.pendingApprovals.delete(rid);
    pending.responded = true;
    try { pending.abort.abort(); } catch {}
  }

  // turn 종료 시 pending native approval 정리: 사용자 UI dismiss(abort) + 아직 응답하지 않은
  // native 요청은 서버가 무한 대기하지 않도록 whole-turn cancel로 best-effort 응답한다(late
  // accept 금지). 정상 완료 turn에는 미응답 pending이 남지 않는다(응답 즉시 map에서 제거).
  _cleanupPendingApprovals(ts) {
    if (!ts.pendingApprovals || ts.pendingApprovals.size === 0) return;
    for (const pending of ts.pendingApprovals.values()) {
      try { pending.abort.abort(); } catch {}
      if (!pending.responded) {
        pending.responded = true;
        this._respondSafely(pending.id, approvalDecisionResponse(pending.method, "cancel"));
      }
    }
    ts.pendingApprovals.clear();
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
    this._cleanupPendingApprovals(ts);
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

  // Stage C lifecycle cleanup hook: HarnessRuntime의 RETIRE/INVALIDATE 결정을 native
  // cache에 반영한다. normal retire boundary(MODEL/PERMISSION/TASK/HEAD/RUN_END 등)
  // 에서는 logicalHandle → thread binding만 잊고 resident App Server는 유지한다.
  forgetSession(session) {
    if (!session || !session.key) return;
    const logicalHandle = `${session.key}#${session.generation != null ? session.generation : 0}`;
    this._threads.delete(logicalHandle);
    this._invalidatedHandles.delete(logicalHandle);
  }

  // Stage C deliberate runtime reset(account/runtime trust boundary 전용).
  // resident App Server가 old account context를 들고 있을 수 있으므로, 명시적
  // account change에서는 (runtime이 logical invalidation + active turn cancel을
  // 이미 지시한 뒤) old server를 닫고 다음 managed turn이 fresh App Server +
  // fresh thread로 시작하게 한다.
  //
  // provider continuity failure(CODEX_SESSION_LOST)의 자동 restart와는 다르다:
  // 실패 경로에서는 client가 lost/closed 상태로 남아 fail-closed되지만, 이
  // deliberate reset만 client 참조를 비워 fresh start를 허용한다.
  resetRuntime() {
    if (this._client) {
      // close는 남아 있던 active turn을 fail-closed로 종료하고(pending approval
      // dismiss 포함) _onClose에서 turn/thread 상태를 정리한다.
      try { this._client.close(); } catch {}
    }
    this._client = null;
    this._clientStart = null;
    this._runtimeIdentity = null;
    this._activeTurns.clear();
    this._threads.clear();
    // old generation은 registry가 다시 선택하지 않으므로 poison 기록도 함께 비운다.
    this._invalidatedHandles.clear();
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
