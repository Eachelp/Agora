"use strict";

const { ProcessHarnessAdapter } = require("./process-harness-adapter");
const { HarnessSessionRegistry } = require("./harness-session-registry");
const { deriveSessionKey } = require("./harness-session-key");

// Stage C-2 — HarnessRuntime
//
// control plane(makeRunAgent)이 만든 { context, invocation }을 받아 실행 adapter를
// 고르고, persistent-capable adapter를 쓸 때만 role-scoped logical session을 관리한다.
//
// 확정된 계약:
//   - 어떤 authority도 갖지 않는다(workspace/permission/Frozen Task/Evidence).
//   - provider-specific 정책은 이 경계 아래에만 존재한다(Professional FSM /
//     chat orchestration으로 새지 않는다).
//   - persistent adapter가 없거나 context가 의도적으로 sessionless 대상이면
//     ProcessHarnessAdapter one-shot 경로로 그대로 실행한다(registry 미사용).
//   - persistent adapter가 선택된 Professional 실행에서 필수 session identity를
//     만들 수 없으면 one-shot으로 우회하지 않고 fail-closed한다.
//   - provenance의 frozenRunId는 TaskManager가 만든 canonical RUN-###만 신뢰한다.
//     transport invocation id(r...)가 잘못 들어오면 adapter로 전달하지 않는다.
//
// C-2에는 실제 persistent adapter가 없어 register()로 등록된 adapter가 없다. 따라서
// production 실행은 항상 sessionless ProcessHarnessAdapter로 귀결된다. persistent 경로는
// 테스트용 fake adapter로만 검증한다.

function failedRun(error, stopReason) {
  return {
    promise: Promise.resolve({ ok: false, error, stopReason }),
    cancel: () => {},
  };
}

function isUnresolvedModelKey(value) {
  const modelKey = String(value || "").trim().toLowerCase();
  return !modelKey || modelKey === "default";
}

function normalizeExecutionContext(context) {
  if (!context || typeof context !== "object") return context;
  const provenance = context.provenance;
  if (!provenance || typeof provenance !== "object" || !Object.hasOwn(provenance, "frozenRunId")) {
    return context;
  }

  const frozenRunId = provenance.frozenRunId == null
    ? ""
    : String(provenance.frozenRunId).trim();
  if (!frozenRunId || /^RUN-\d+$/i.test(frozenRunId)) {
    return context;
  }

  // C-2에서 chat transport runId(r...)가 frozenRunId로 잘못 라벨링된 legacy 입력을
  // provider adapter까지 전파하지 않는다. Frozen provenance는 없다고 보는 것이
  // 거짓 provenance를 보존하는 것보다 안전하다. 올바른 RUN-### 값은 그대로 통과한다.
  const nextProvenance = { ...provenance };
  delete nextProvenance.frozenRunId;
  return { ...context, provenance: nextProvenance };
}

class HarnessRuntime {
  constructor({ processAdapter, registry, now } = {}) {
    this._processAdapter = processAdapter || new ProcessHarnessAdapter();
    this._registry = registry || new HarnessSessionRegistry({ now });
    this._persistentAdapters = new Map(); // providerId -> adapter
  }

  get registry() {
    return this._registry;
  }

  // 향후 provider-native adapter 등록점. provider-specific 정책은 이 아래에만 둔다.
  register(providerId, adapter) {
    if (!providerId || !adapter) throw new Error("providerId와 adapter가 필요합니다.");
    this._persistentAdapters.set(String(providerId), adapter);
    return this;
  }

  // provider에 등록된 persistent-capable adapter가 있으면 반환한다. 없거나 capability를
  // 켜지 않았으면 null(→ sessionless 경로).
  _persistentAdapterFor(context) {
    const providerId = context && context.providerId ? String(context.providerId) : null;
    if (!providerId) return null;
    const adapter = this._persistentAdapters.get(providerId);
    if (!adapter || adapter.supportsPersistentSession !== true) return null;
    return adapter;
  }

  runTurn({ context = null, invocation } = {}) {
    if (!invocation) {
      throw new Error("HarnessRuntime.runTurn: invocation이 필요합니다.");
    }

    const runtimeContext = normalizeExecutionContext(context);
    const persistentAdapter = this._persistentAdapterFor(runtimeContext);

    // provider-native persistent adapter가 없으면 C-1과 동일한 one-shot process 경로다.
    if (!persistentAdapter) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    // General chat은 C-2에서 의도적으로 sessionless다. role/professionalRunId가 모두
    // 없으면 persistent-capable provider여도 registry를 만들지 않고 one-shot으로 실행한다.
    const professionalIntent = Boolean(runtimeContext?.role || runtimeContext?.professionalRunId);
    if (!professionalIntent) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    // resolved concrete model이 없으면 persistent identity를 고정할 수 없으므로 C-2 계약상
    // sessionless process 경로를 사용한다. 이 경우는 identity 손상이 아니라 의도된 fallback이다.
    if (isUnresolvedModelKey(runtimeContext?.modelKey)) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    const key = deriveSessionKey(runtimeContext);
    if (!key) {
      // persistent provider + Professional 실행에서 workspace/project/run/role/provider/model/
      // permission identity 중 하나라도 빠졌다면 fresh process로 조용히 우회하면 안 된다.
      return failedRun(
        "Professional harness session identity를 안전하게 계산할 수 없습니다.",
        "HARNESS_SESSION_IDENTITY_INVALID"
      );
    }

    // persistent 경로: role-scoped logical session을 확보하고 single-flight로 보호한다.
    const entry = this._registry.acquire(key, { adapterId: persistentAdapter.id });
    if (!this._registry.tryBeginTurn(entry)) {
      // 같은 logical session에 동시 turn 금지(fail-closed). 새 scheduler를 만들지 않는다.
      return failedRun(
        "동일한 logical harness session에서 이미 실행 중입니다.",
        "SESSION_BUSY"
      );
    }

    let run;
    try {
      run = persistentAdapter.runTurn({
        context: runtimeContext,
        invocation,
        session: { key, generation: entry.generation },
      });
    } catch (error) {
      this._registry.endTurn(entry);
      throw error;
    }

    const promise = Promise.resolve(run.promise).then(
      (result) => {
        this._registry.endTurn(entry);
        return result;
      },
      (error) => {
        this._registry.endTurn(entry);
        throw error;
      }
    );
    return { promise, cancel: typeof run.cancel === "function" ? run.cancel : () => {} };
  }
}

module.exports = { HarnessRuntime };
