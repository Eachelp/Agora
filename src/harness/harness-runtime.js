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
//   - persistent adapter가 없거나 context가 session 대상이 아니면 ProcessHarnessAdapter
//     one-shot 경로로 그대로 실행한다(registry 미사용). → C-2 production 실행 = C-1.
//
// C-2에는 실제 persistent adapter가 없어 register()로 등록된 adapter가 없다. 따라서
// production 실행은 항상 sessionless ProcessHarnessAdapter로 귀결된다. persistent 경로는
// 테스트용 fake adapter로만 검증한다.

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

    const persistentAdapter = this._persistentAdapterFor(context);
    const key = persistentAdapter ? deriveSessionKey(context) : null;

    // sessionless 경로: persistent adapter가 없거나 context가 session 대상이 아님.
    // ProcessHarnessAdapter로 그대로 위임하고 registry는 절대 건드리지 않는다.
    if (!persistentAdapter || !key) {
      return this._processAdapter.runTurn({ context, invocation });
    }

    // persistent 경로: role-scoped logical session을 확보하고 single-flight로 보호한다.
    const entry = this._registry.acquire(key, { adapterId: persistentAdapter.id });
    if (!this._registry.tryBeginTurn(entry)) {
      // 같은 logical session에 동시 turn 금지(fail-closed). 새 scheduler를 만들지 않는다.
      return {
        promise: Promise.resolve({
          ok: false,
          error: "동일한 logical harness session에서 이미 실행 중입니다.",
          stopReason: "SESSION_BUSY",
        }),
        cancel: () => {},
      };
    }

    let run;
    try {
      run = persistentAdapter.runTurn({
        context,
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
