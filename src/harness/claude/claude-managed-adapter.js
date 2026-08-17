"use strict";

const { HarnessAdapter } = require("../harness-adapter");
const { runAgentProcess } = require("../../chat/chat-agent-runner");
const { createLineParser } = require("../../chat/chat-events");
const { buildRunMetrics } = require("../../chat/chat-run-metrics");

// Stage C — ClaudeManagedAdapter
//
// Claude의 첫 provider-native session 연속성. 하나의 Agora logical Professional
// session(SessionKey+generation)을 하나의 native Claude 대화에 대응시킨다.
//   - 첫 turn: native 세션을 새로 만들고(=기존 one-shot argv에서 --no-session-persistence
//     제거) 출력의 top-level session_id를 캡처해 binding으로 저장한다.
//   - 이후 turn: 같은 logicalHandle이면 정확히 그 native 세션만 `--resume <id>`로
//     잇는다. 매 turn마다 fresh CLI 프로세스를 띄운다(resident process 아님).
//
// 확정 계약:
//   - control-plane authority 없음. Frozen Task/workspace/permission/Evidence/
//     RunMetrics/prompt는 상위(control plane)가 소유한다. native 세션 memory는 cache다.
//   - authoritative prompt는 매 turn 전체 재전송된다(resume이라고 축약하지 않는다).
//   - Claude resume 의미(argv 변환/session_id 검증)는 오직 이 adapter 아래에만 둔다.
//     chat-ipc / chat-argv는 provider-specific Claude resume 분기를 갖지 않는다. adapter는
//     control plane이 만든 기존 one-shot Claude argv를 받아 최소 변환만 한다.
//   - CLI spawn/parse/streaming/evidence/telemetry/strict-final/timeout/output-limit/
//     cancel은 기존 runAgentProcess를 그대로 재사용한다(로직 복제 없음).
//   - SILENT FALLBACK 금지: adapter가 선택된 뒤 session-missing/mismatch/resume 실패/
//     continuity ambiguity는 Process fallback이나 자동 fresh-session 없이 fail-closed한다.
//   - logicalHandle = session.key + "#" + session.generation. binding은 process memory
//     전용이다(disk 영속/앱 재시작 복구 없음). 손상된 handle은 재사용 시 fail-closed한다.
//   - model/permission/workspace가 바뀌면 SessionKey가 달라져(=다른 handle) 다른 native
//     세션이 된다. adapter는 Claude의 turn-level model override를 continuity로 쓰지 않는다.

// 기존 one-shot Claude argv에서 native 세션을 남기지 않게 하는 플래그. managed 경로에서는
// 이 플래그만 제거해 native 세션을 남긴다(나머지 argv는 control plane 결정 그대로).
const NO_SESSION_PERSISTENCE_FLAG = "--no-session-persistence";

// resume에 쓸 수 있는 session_id 형식(방어적). Claude의 UUID를 통과시키되, 셸(.cmd)
// 경유 argv에 위험 문자가 실리지 않도록 제한한다. 형식 밖 id는 캡처/사용하지 않는다.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

class ClaudeManagedAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super({ id: "claude-managed", supportsPersistentSession: true });
    this._runProcess = typeof options.runProcess === "function" ? options.runProcess : runAgentProcess;
    // logicalHandle -> { nativeSessionId }
    this._bindings = new Map();
    // logicalHandle -> stopReason(string). native continuity가 손상된 handle은 재사용 금지.
    this._invalidatedHandles = new Map();
  }

  // ---- HarnessAdapter.runTurn ----
  runTurn({ context = null, invocation, session } = {}) {
    try {
      return this._runTurn({ context, invocation, session });
    } catch (error) {
      return this._staticFail(context, invocation, {
        error: error && error.message ? error.message : String(error),
        stopReason: (error && error.code) || "CLAUDE_TURN_FAILED",
      });
    }
  }

  _runTurn({ context, invocation, session }) {
    if (!invocation || !session || !session.key) {
      return this._staticFail(context, invocation, {
        error: "잘못된 managed turn 요청입니다.",
        stopReason: "CLAUDE_TURN_START_FAILED",
      });
    }
    const logicalHandle = `${session.key}#${session.generation != null ? session.generation : 0}`;

    // (1) native continuity가 손상된 handle은 조용히 재사용하지 않는다
    // (Process fallback/새 세션 자동 생성 없음). 저장된 사유로 fail-closed한다.
    if (this._invalidatedHandles.has(logicalHandle)) {
      return this._staticFail(context, invocation, {
        error: "이 logical Claude session은 native continuity가 손상되어 재사용할 수 없습니다.",
        stopReason: this._invalidatedHandles.get(logicalHandle) || "CLAUDE_SESSION_LOST",
      });
    }

    // (2) binding이 있으면 그 native 세션을 이어받고(resume), 없으면 첫 turn(새 세션 생성).
    const binding = this._bindings.get(logicalHandle) || null;
    const resumeId = binding ? binding.nativeSessionId : null;

    // (3) control plane이 만든 기존 one-shot Claude argv를 최소 변환한다.
    const sessionArgv = this._sessionArgv(invocation.argv, resumeId);
    if (!sessionArgv) {
      // argv를 만들 수 없다(빈 argv 또는 손상된 resume id). 조용히 새 세션으로 우회하지
      // 않고 fail-closed한다. 살아있던 binding이 있었다면 재사용 불가로 만든다.
      if (resumeId != null) this._invalidateHandle(logicalHandle, "CLAUDE_SESSION_RESUME_FAILED");
      return this._staticFail(context, invocation, {
        error: resumeId != null ? "Claude resume argv를 생성하지 못했습니다." : "Claude 실행 argv가 유효하지 않습니다.",
        stopReason: resumeId != null ? "CLAUDE_SESSION_RESUME_FAILED" : "CLAUDE_TURN_START_FAILED",
      });
    }

    // (4) native session_id 캡처 seam. harness-level metadata로만 쓰고 renderer/FSM/
    // Evidence로는 노출하지 않는다. 한 turn에서 서로 다른 id가 관측되면 conflict로 본다.
    let capturedId = null;
    let capturedConflict = false;
    const onSessionId = (id) => {
      const value = String(id || "").trim();
      if (!value || !SESSION_ID_PATTERN.test(value)) return;
      if (capturedId && capturedId !== value) capturedConflict = true;
      capturedId = value;
    };
    const sessionParseLine = createLineParser("claude", { onSessionId });

    // (5) 기존 process runner를 그대로 재사용한다. argv/parseLine만 managed 값으로 교체하고
    // 나머지(prompt/transport/cwd/onEvent/onRawChunk/timeout/requireFinal/limit/images)는 보존.
    const procInvocation = { ...invocation, argv: sessionArgv, parseLine: sessionParseLine };

    let run;
    try {
      run = this._runProcess(procInvocation);
    } catch (error) {
      return this._staticFail(context, invocation, {
        error: error && error.message ? error.message : String(error),
        stopReason: "CLAUDE_TURN_START_FAILED",
      });
    }

    const promise = Promise.resolve(run && run.promise).then((result) =>
      this._afterRun(
        { logicalHandle, resumeId, getCaptured: () => ({ capturedId, capturedConflict }) },
        result
      )
    );
    return { promise, cancel: run && typeof run.cancel === "function" ? run.cancel : () => {} };
  }

  // 기존 one-shot Claude argv를 managed 세션 argv로 최소 변환한다:
  //   - --no-session-persistence 제거(native 세션을 남긴다)
  //   - resume 대상이 있으면 정확히 그 세션만 --resume <id>로 잇는다(형식 검증)
  // 그 외 argv(모델/권한/도구/add-dir 등 control plane 결정)는 그대로 둔다.
  _sessionArgv(baseArgv, resumeId) {
    if (!Array.isArray(baseArgv) || baseArgv.length === 0) return null;
    const argv = baseArgv.filter((arg) => arg !== NO_SESSION_PERSISTENCE_FLAG);
    if (resumeId != null) {
      if (!SESSION_ID_PATTERN.test(String(resumeId))) return null;
      argv.push("--resume", String(resumeId));
    }
    return argv;
  }

  _afterRun({ logicalHandle, resumeId, getCaptured }, result) {
    const r = result && typeof result === "object"
      ? result
      : { ok: false, error: "빈 실행 결과입니다.", stopReason: "CLAUDE_TURN_FAILED" };
    const { capturedId, capturedConflict } = getCaptured();
    // 정상 종료 = 최종 답변 확정(ok) 또는 exit 0인데 strict-final만 누락(protocolFailed).
    // 두 경우 native 세션은 살아있다(연속성 유지 가능). 그 외는 비정상 종료다.
    const normal = r.ok === true || r.protocolFailed === true;

    if (!normal) {
      // 비정상 종료: native completion을 확인하지 못했다.
      if (resumeId != null) {
        // 살아있던 세션을 이어받던 turn이 애매하게 끝났다 → binding 즉시 재사용 불가.
        if (r.cancelled || r.timedOut || r.outputLimited) {
          // 사용자 취소/시간초과/출력상한: 이미 합당한 실패 판정이므로 결과(및 실 telemetry)를
          // 그대로 두고 continuity만 무효화한다.
          this._invalidateHandle(logicalHandle, "CLAUDE_SESSION_LOST");
          return r;
        }
        // 그 외 실패(예: resume 대상 세션 없음 → "No conversation found" exit 1)는 resume
        // 자체 실패로 본다. 실행이 남긴 output/evidence/RunMetrics는 보존하고 판정만 덮어쓴다.
        this._invalidateHandle(logicalHandle, "CLAUDE_SESSION_RESUME_FAILED");
        return this._continuityFail(r, {
          stopReason: "CLAUDE_SESSION_RESUME_FAILED",
          error: r.error || "이전 Claude 세션을 이어받지 못했습니다.",
        });
      }
      // 첫 turn 비정상 종료: 아직 확정된 세션이 없어 보호할 continuity가 없다.
      // handle을 poison하지 않고 결과를 그대로 반환한다(다음 turn 새 세션으로 재시도 허용).
      return r;
    }

    // 정상 종료: native session_id로 continuity를 확정/확인해야 한다.
    if (resumeId == null) {
      // 첫 turn: 이후 resume을 위해 반드시 하나의 안정적인 session_id가 필요하다.
      // 확정하지 못하면 이 turn만 fail-closed한다(살아있는 세션이 없으므로 poison하지 않음).
      if (capturedConflict) {
        return this._continuityFail(r, {
          stopReason: "CLAUDE_SESSION_ID_MISMATCH",
          error: "한 turn에서 서로 다른 Claude session_id가 관측되었습니다.",
        });
      }
      if (!capturedId) {
        return this._continuityFail(r, {
          stopReason: "CLAUDE_SESSION_ID_MISSING",
          error: "Claude가 native session_id를 반환하지 않아 세션을 고정할 수 없습니다.",
        });
      }
      this._bindings.set(logicalHandle, { nativeSessionId: capturedId });
      return r;
    }

    // resume turn: 캡처된 id가 정확히 이어붙이려던 세션과 같아야 한다. 어긋나면 continuity가
    // 깨진 것이므로 살아있던 binding을 즉시 재사용 불가로 만들고 fail-closed한다.
    if (capturedConflict || (capturedId && capturedId !== resumeId)) {
      this._invalidateHandle(logicalHandle, "CLAUDE_SESSION_ID_MISMATCH");
      return this._continuityFail(r, {
        stopReason: "CLAUDE_SESSION_ID_MISMATCH",
        error: "resume가 이어받으려던 것과 다른 native session_id를 반환했습니다.",
      });
    }
    if (!capturedId) {
      this._invalidateHandle(logicalHandle, "CLAUDE_SESSION_ID_MISSING");
      return this._continuityFail(r, {
        stopReason: "CLAUDE_SESSION_ID_MISSING",
        error: "resume turn이 native session_id를 확인해주지 않았습니다.",
      });
    }
    // continuity 확인됨 — binding 유지.
    return r;
  }

  _invalidateHandle(logicalHandle, reason) {
    if (!logicalHandle) return;
    if (!this._invalidatedHandles.has(logicalHandle)) {
      this._invalidatedHandles.set(logicalHandle, reason || "CLAUDE_SESSION_LOST");
    }
    this._bindings.delete(logicalHandle);
  }

  // 실제 provider 실행이 끝난 뒤의 continuity 실패. 실행이 남긴 output/evidence/
  // RunMetrics(실 duration·tool metrics)를 보존하고 실패 판정(ok/stopReason/error)만
  // 덮어쓴다. 신뢰할 수 없는 최종 답변은 partialText로 강등한다(성공 답변으로 오인 금지).
  _continuityFail(result, { stopReason, error }) {
    const next = {
      ...result,
      ok: false,
      stopReason,
      error: error || result.error || "native session continuity를 확인하지 못했습니다.",
    };
    // strict-final 누락 표식은 continuity 판정으로 대체한다(stopReason 모순 방지).
    delete next.protocolFailed;
    if (typeof next.text === "string") {
      const trimmed = next.text.trim();
      if (trimmed && !next.partialText) next.partialText = trimmed;
      delete next.text;
    }
    // RunMetrics 판정도 새 실패에 맞추되 실 timing/telemetry는 유지한다(재계산 입력이 실
    // startedAt/finishedAt/output/evidence이므로 duration·tool·stdout metrics가 보존된다).
    next.runMetrics = this._reverdictRunMetrics(result.runMetrics, next);
    return next;
  }

  _reverdictRunMetrics(priorMetrics, failedResult) {
    const prior = priorMetrics && typeof priorMetrics === "object" ? priorMetrics : {};
    return buildRunMetrics({
      invocationId: prior.invocationId || null,
      provider: prior.provider || null,
      model: prior.model || null,
      effort: prior.effort || null,
      stage: prior.stage || null,
      startedAt: prior.startedAt != null ? prior.startedAt : null,
      finishedAt: prior.finishedAt != null ? prior.finishedAt : null,
      promptChars: prior.promptChars || 0,
      result: failedResult,
    });
  }

  _staticFail(context, invocation, partial) {
    return { promise: Promise.resolve(this._failResult(context, invocation, partial)), cancel: () => {} };
  }

  // turn을 시작하지 못한(=실제 실행하지 않은) 경우의 fail-closed 결과. 실행이 없었으므로
  // zero-duration bounded runMetrics만 남긴다(실행 후 실패는 _continuityFail이 처리).
  _failResult(context, invocation, partial) {
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

  // Agora 종료 시 provider-local 상태 정리. process-per-turn이라 죽일 resident child는 없다.
  close() {
    this._bindings.clear();
    this._invalidatedHandles.clear();
  }
}

module.exports = { ClaudeManagedAdapter };
