"use strict";

const { HarnessAdapter } = require("../harness-adapter");
const { runAgentProcess } = require("../../chat/chat-agent-runner");
const { createLineParser } = require("../../chat/chat-events");
const { buildRunMetrics } = require("../../chat/chat-run-metrics");

// Stage C — AGYManagedAdapter
//
// AGY의 provider-native conversation 연속성. 하나의 Agora logical Professional
// session(SessionKey+generation)을 하나의 native AGY conversation에 대응시킨다.
//   - 첫 turn: 기존 one-shot AGY argv 그대로(=--conversation/--continue 없음) 실행하고
//     stream-json의 conversation_id를 캡처해 binding으로 저장한다.
//   - 이후 turn: 같은 logicalHandle이면 정확히 그 native conversation만
//     `--conversation <id>`로 잇는다. 매 turn마다 fresh agy 프로세스를 띄운다.
//
// AGY-specific hazard(실환경 1.1.13에서 확인):
//   invalid --conversation A → "not found" warning → 자동으로 fresh conversation B 생성
//   → prompt/tool을 계속 실행 → status SUCCESS → exit 0. 즉 exit 0 / status SUCCESS는
//   continuity 증거가 아니다. 반드시 returned conversation_id === requested id (exact
//   equality)만 continuity success다. 더욱이 fresh B는 workspace-write turn에서 side effect를
//   일으킬 수 있으므로, resume turn에서 bound A와 다른 유효 conversation_id가 관측되는 즉시
//   fatal mismatch로 표시하고 진행 중인 run을 best-effort로 취소한다(원치 않은 B의 side effect
//   최소화). 취소/완료와 무관하게 최종 verdict는 AGY_CONVERSATION_ID_MISMATCH로 유지하고, 종료
//   전까지 나온 Evidence/output/RunMetrics는 보존하며, B는 절대 채택하지 않고 handle을 poison한다.
//
// 확정 계약(Claude/Codex managed와 동일 방향):
//   - control-plane authority 없음. Frozen Task/workspace/permission/Evidence/RunMetrics/
//     prompt는 상위가 소유한다. native conversation memory는 cache다.
//   - authoritative prompt는 매 turn 전체 재전송한다(resume이라고 축약하지 않는다).
//   - AGY resume 의미(--conversation/conversation_id 검증/invalid-resume 차단)는 오직 이
//     adapter 아래에만 둔다. chat-ipc/chat-argv는 관여하지 않는다. adapter는 control plane이
//     만든 기존 one-shot AGY argv를 받아 최소 변환(=--conversation 추가)만 한다. native
//     conversation 선택 authority는 오직 이 adapter다(§ base argv의 --conversation 거부).
//   - CLI spawn/parse/streaming/evidence/telemetry/strict-final/timeout/output-limit/cancel은
//     기존 runAgentProcess를 그대로 재사용한다(로직 복제 없음).
//   - SILENT FALLBACK 금지: adapter가 선택된 뒤 conversation missing/mismatch/resume 실패/
//     continuity ambiguity는 Process fallback이나 자동 fresh-conversation 채택 없이 fail-closed.
//   - logicalHandle = session.key + "#" + session.generation. binding은 process memory 전용
//     (disk 영속/앱 재시작 복구 없음). 손상된 handle은 재사용 시 fail-closed한다.
//   - model/permission/workspace가 바뀌면 SessionKey가 달라져(=다른 handle) 다른 native
//     conversation이 된다. conversation_id는 authority가 아니라 cache lookup value일 뿐이다.

// managed AGY가 절대 쓰지 않는 resume 플래그(--continue/-c = most-recent semantics로
// role/run isolation을 깨뜨린다). base argv에 있으면 fail-closed한다.
const CONTINUE_FLAGS = Object.freeze(["--continue", "-c"]);

// resume에 쓸 수 있는 conversation_id 형식(방어적). AGY의 UUID를 통과시키되, argv에
// 위험 문자가 실리지 않도록 제한한다. 형식 밖 id는 캡처/사용하지 않는다.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

class AGYManagedAdapter extends HarnessAdapter {
  constructor(options = {}) {
    super({ id: "agy-managed", supportsPersistentSession: true });
    this._runProcess = typeof options.runProcess === "function" ? options.runProcess : runAgentProcess;
    // logicalHandle -> { nativeConversationId }
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
        stopReason: (error && error.code) || "AGY_TURN_FAILED",
      });
    }
  }

  _runTurn({ context, invocation, session }) {
    if (!invocation || !session || !session.key) {
      return this._staticFail(context, invocation, {
        error: "잘못된 managed turn 요청입니다.",
        stopReason: "AGY_TURN_START_FAILED",
      });
    }
    const logicalHandle = `${session.key}#${session.generation != null ? session.generation : 0}`;

    // (1) native continuity가 손상된 handle은 조용히 재사용하지 않는다
    // (Process fallback/새 conversation 자동 채택 없음). 저장된 사유로 fail-closed한다.
    if (this._invalidatedHandles.has(logicalHandle)) {
      return this._staticFail(context, invocation, {
        error: "이 logical AGY session은 native continuity가 손상되어 재사용할 수 없습니다.",
        stopReason: this._invalidatedHandles.get(logicalHandle) || "AGY_CONVERSATION_LOST",
      });
    }

    // (2) binding이 있으면 그 native conversation을 이어받고(resume), 없으면 첫 turn.
    const binding = this._bindings.get(logicalHandle) || null;
    const boundId = binding ? binding.nativeConversationId : null;

    // (3) control plane이 만든 기존 one-shot AGY argv를 최소 변환한다.
    const sessionArgv = this._sessionArgv(invocation.argv, boundId);
    if (!sessionArgv) {
      // argv를 만들 수 없다(빈 argv / --continue 또는 base --conversation 존재 / 손상된
      // conversation id). 조용히 새 conversation으로 우회하지 않고 fail-closed한다. 살아있던
      // binding은 재사용 불가로 만든다.
      if (boundId != null) this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_RESUME_FAILED");
      return this._staticFail(context, invocation, {
        error: boundId != null ? "AGY resume argv를 생성하지 못했습니다." : "AGY 실행 argv가 유효하지 않습니다.",
        stopReason: boundId != null ? "AGY_CONVERSATION_RESUME_FAILED" : "AGY_TURN_START_FAILED",
      });
    }

    // (4) run 취소 배선. resume turn에서 bound와 다른 conversation_id를 관측하는 즉시 fatal
    // mismatch로 표시하고 진행 중인 run을 best-effort로 취소한다. run 확보 전(fake/실 transport의
    // 동기 emit)이면 여기서 취소하지 못하고 아래에서 재시도한다(§ synchronous emit race).
    const control = { run: null, mismatch: false, cancelInvoked: false };
    const requestCancel = () => {
      if (control.cancelInvoked) return;
      if (control.run && typeof control.run.cancel === "function") {
        control.cancelInvoked = true;
        try { control.run.cancel(); } catch {}
      }
    };

    // (5) native conversation_id 캡처 seam. harness-level metadata로만 쓰고 renderer/FSM/
    // Evidence로는 노출하지 않는다. 한 turn에서 서로 다른 id가 관측되면 conflict로 본다.
    let capturedId = null;
    let capturedConflict = false;
    const onConversationId = (id) => {
      const value = String(id || "").trim();
      if (!value || !CONVERSATION_ID_PATTERN.test(value)) return;
      if (capturedId && capturedId !== value) capturedConflict = true;
      capturedId = value;
      // resume turn에서 bound conversation과 다른 유효 id를 관측하면 즉시 fatal mismatch.
      if (boundId != null && value !== boundId) {
        control.mismatch = true;
        requestCancel();
      }
    };
    const sessionParseLine = createLineParser("agy", { onConversationId });

    // (6) 기존 process runner를 그대로 재사용한다. argv/parseLine만 managed 값으로 교체하고
    // 나머지(prompt/transport(argv,--print)/cwd/onEvent/onRawChunk/timeout/limit 등)는 보존.
    const procInvocation = { ...invocation, argv: sessionArgv, parseLine: sessionParseLine };

    let run;
    try {
      run = this._runProcess(procInvocation);
    } catch (error) {
      return this._staticFail(context, invocation, {
        error: error && error.message ? error.message : String(error),
        stopReason: "AGY_TURN_START_FAILED",
      });
    }

    control.run = run;
    // synchronous emit race: 콜백이 run 확보 전에 mismatch를 표시했다면 지금 취소한다.
    if (control.mismatch) requestCancel();

    const promise = Promise.resolve(run && run.promise).then((result) =>
      this._afterRun(
        { logicalHandle, boundId, isMismatch: () => control.mismatch, getCaptured: () => ({ capturedId, capturedConflict }) },
        result
      )
    );
    return { promise, cancel: run && typeof run.cancel === "function" ? run.cancel : () => {} };
  }

  // 기존 one-shot AGY argv를 managed conversation argv로 최소 변환한다:
  //   - --continue/-c가 들어 있으면 fail-closed(null). managed AGY는 exact --conversation만 쓴다.
  //   - base argv가 이미 --conversation(공백/attached 형식)을 갖고 있으면 fail-closed(null).
  //     native conversation 선택 authority는 오직 이 adapter다(외부 주입 거부).
  //   - resume 대상이 있으면 정확히 그 conversation만 --conversation <id>로 잇는다(형식 검증).
  // 그 외 argv(model/effort/mode/sandbox/add-dir/print-timeout/auto-approve 등 control plane
  // 결정)는 그대로 둔다. 원본 배열은 mutate하지 않는다.
  _sessionArgv(baseArgv, conversationId) {
    if (!Array.isArray(baseArgv) || baseArgv.length === 0) return null;
    for (const arg of baseArgv) {
      const a = String(arg);
      if (CONTINUE_FLAGS.includes(a)) return null;
      if (a === "--conversation" || a.startsWith("--conversation=")) return null;
    }
    const argv = [...baseArgv];
    if (conversationId != null) {
      if (!CONVERSATION_ID_PATTERN.test(String(conversationId))) return null;
      argv.push("--conversation", String(conversationId));
    }
    return argv;
  }

  _afterRun({ logicalHandle, boundId, isMismatch, getCaptured }, result) {
    const r = result && typeof result === "object"
      ? result
      : { ok: false, error: "빈 실행 결과입니다.", stopReason: "AGY_TURN_FAILED" };
    const { capturedId, capturedConflict } = getCaptured();

    // (최우선) resume turn에서 관측 즉시 감지된 native conversation mismatch. 실행이 (우리가
    // 유발한) 취소로 끝났든 provider가 SUCCESS로 끝났든 최종 verdict는 반드시
    // AGY_CONVERSATION_ID_MISMATCH다(CANCELLED/LOST로 강등 금지). 종료 전까지 나온 Evidence/
    // output/RunMetrics는 보존하고, fresh conversation은 절대 채택하지 않으며 handle을 poison한다.
    if (isMismatch()) {
      this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_ID_MISMATCH");
      return this._continuityFail(r, {
        stopReason: "AGY_CONVERSATION_ID_MISMATCH",
        error: "resume가 이어받으려던 것과 다른 native AGY conversation_id를 반환했습니다.",
      });
    }

    // 정상 종료 = 최종 답변 확정(ok) 또는 exit 0인데 strict-final만 누락(protocolFailed).
    const normal = r.ok === true || r.protocolFailed === true;

    if (!normal) {
      if (boundId != null) {
        // 살아있던 conversation을 이어받던 turn이 애매하게 끝났다(mismatch 아님) → 재사용 불가.
        if (r.cancelled || r.timedOut || r.outputLimited) {
          this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_LOST");
          return r;
        }
        this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_RESUME_FAILED");
        return this._continuityFail(r, {
          stopReason: "AGY_CONVERSATION_RESUME_FAILED",
          error: r.error || "이전 AGY conversation을 이어받지 못했습니다.",
        });
      }
      // 첫 turn 비정상 종료: 보호할 continuity가 없다. 결과 그대로 반환(재시도 허용).
      return r;
    }

    // 정상 종료: native conversation_id로 continuity를 확정/확인해야 한다.
    if (boundId == null) {
      // 첫 turn: 이후 resume을 위해 반드시 하나의 안정적인 conversation_id가 필요하다.
      if (capturedConflict) {
        return this._continuityFail(r, {
          stopReason: "AGY_CONVERSATION_ID_MISMATCH",
          error: "한 turn에서 서로 다른 AGY conversation_id가 관측되었습니다.",
        });
      }
      if (!capturedId) {
        return this._continuityFail(r, {
          stopReason: "AGY_CONVERSATION_ID_MISSING",
          error: "AGY가 native conversation_id를 반환하지 않아 conversation을 고정할 수 없습니다.",
        });
      }
      this._bindings.set(logicalHandle, { nativeConversationId: capturedId });
      return r;
    }

    // resume turn(mismatch 미관측): 모든 관측 id가 boundId와 같아야 한다. (이중 안전망: 위
    // isMismatch()에서 이미 다루지만, 관측 없이 완료된 경우의 missing도 여기서 판정한다.)
    if (capturedConflict || (capturedId && capturedId !== boundId)) {
      this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_ID_MISMATCH");
      return this._continuityFail(r, {
        stopReason: "AGY_CONVERSATION_ID_MISMATCH",
        error: "resume가 이어받으려던 것과 다른 native AGY conversation_id를 반환했습니다.",
      });
    }
    if (!capturedId) {
      this._invalidateHandle(logicalHandle, "AGY_CONVERSATION_ID_MISSING");
      return this._continuityFail(r, {
        stopReason: "AGY_CONVERSATION_ID_MISSING",
        error: "resume turn이 native AGY conversation_id를 확인해주지 않았습니다.",
      });
    }
    // continuity 확인됨(capturedId === boundId) — binding 유지.
    return r;
  }

  _invalidateHandle(logicalHandle, reason) {
    if (!logicalHandle) return;
    if (!this._invalidatedHandles.has(logicalHandle)) {
      this._invalidatedHandles.set(logicalHandle, reason || "AGY_CONVERSATION_LOST");
    }
    this._bindings.delete(logicalHandle);
  }

  // 실제 provider 실행이 끝난 뒤(취소 포함)의 continuity 실패. 실행이 남긴 output/evidence/
  // RunMetrics(실 duration·tool metrics)를 보존하고 실패 판정(ok/stopReason/error)만 덮어쓴다.
  // continuity 판정이 최종 verdict이므로, (우리가 유발한) 종료 형태 플래그(cancelled/timedOut/
  // outputLimited)는 제거해 CANCELLED/LOST로 오인되지 않게 한다. 신뢰할 수 없는 최종 답변은
  // partialText로 강등한다(성공 답변으로 오인 금지).
  _continuityFail(result, { stopReason, error }) {
    const next = {
      ...result,
      ok: false,
      stopReason,
      error: error || result.error || "native AGY conversation continuity를 확인하지 못했습니다.",
    };
    delete next.protocolFailed;
    delete next.cancelled;
    delete next.timedOut;
    delete next.outputLimited;
    if (typeof next.text === "string") {
      const trimmed = next.text.trim();
      if (trimmed && !next.partialText) next.partialText = trimmed;
      delete next.text;
    }
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

  // Stage C lifecycle cleanup hook: HarnessRuntime의 RETIRE/INVALIDATE 결정을 native
  // cache에 반영한다. logicalHandle → nativeConversationId binding과 poison 기록을
  // 제거한다. remote AGY conversation 삭제는 하지 않으며, strict mismatch/no-fallback
  // 계약(실행 중 continuity 검증)은 그대로 유지된다.
  forgetSession(session) {
    if (!session || !session.key) return;
    const logicalHandle = `${session.key}#${session.generation != null ? session.generation : 0}`;
    this._bindings.delete(logicalHandle);
    this._invalidatedHandles.delete(logicalHandle);
  }

  // Agora 종료 시 provider-local 상태 정리. process-per-turn이라 죽일 resident child는 없다.
  close() {
    this._bindings.clear();
    this._invalidatedHandles.clear();
  }
}

module.exports = { AGYManagedAdapter };
