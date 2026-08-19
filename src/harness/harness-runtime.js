"use strict";

const { ProcessHarnessAdapter } = require("./process-harness-adapter");
const { HarnessSessionRegistry, LIFECYCLE } = require("./harness-session-registry");
const { deriveSessionKey } = require("./harness-session-key");
const {
  RETIRE_REASONS,
  INVALIDATE_REASONS,
  LIFECYCLE_STOP_REASONS,
} = require("./harness-session-lifecycle");

// Stage C — HarnessRuntime
//
// control plane(makeRunAgent)이 만든 { context, invocation }을 받아 실행 adapter를
// 고르고, persistent-capable adapter를 쓸 때만 role-scoped logical session을 관리한다.
// Session Invalidation / Lifecycle의 결정 주체이기도 하다: 상위 control plane이
// 전달한 lifecycle facts/events(taskHash · Git HEAD · workspace 변경 · restore ·
// provider account 변경 · run 종료)를 비교/적용해 logical session의 RETIRE/INVALIDATE를
// 결정하고, provider adapter에는 native cache cleanup(forgetSession/resetRuntime)만
// 지시한다.
//
// 확정된 계약:
//   - 어떤 authority도 갖지 않는다(workspace/permission/Frozen Task/Evidence).
//     lifecycle facts는 항상 상위 control plane이 계산해 전달한다.
//   - provider-specific 정책은 이 경계 아래에만 존재한다(Professional FSM /
//     chat orchestration으로 새지 않는다).
//   - persistent adapter가 없거나 context가 의도적으로 sessionless 대상이면
//     ProcessHarnessAdapter one-shot 경로로 그대로 실행한다(registry 미사용).
//   - persistent adapter가 선택된 Professional 실행에서 필수 session identity를
//     만들 수 없으면 one-shot으로 우회하지 않고 fail-closed한다.
//   - provenance의 frozenRunId는 TaskManager가 만든 canonical RUN-###만 신뢰한다.
//     transport invocation id(r...)가 잘못 들어오면 adapter로 전달하지 않는다.
//   - 종료(RETIRED/INVALIDATED)된 old generation이 inflight인 동안에는 같은 key의
//     replacement generation을 실행하지 않는다(HARNESS_SESSION_LIFECYCLE_BUSY).
//   - 계정 변경은 provider-wide hard session boundary다: 해당 provider의 모든
//     managed session을 INVALIDATE하고, inflight turn이 settle될 때까지 새 turn을
//     차단한다(BUSY). 같은 계정으로 돌아와도 fresh session이다.
//   - lifecycle boundary 자체는 실행 Evidence/RunMetrics를 만들지 않는다. busy/
//     invalid static failure는 기존 no-execution semantics를 따른다.

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

  const nextProvenance = { ...provenance };
  delete nextProvenance.frozenRunId;
  return { ...context, provenance: nextProvenance };
}

class HarnessRuntime {
  constructor({ processAdapter, registry, now } = {}) {
    this._processAdapter = processAdapter || new ProcessHarnessAdapter();
    this._registry = registry || new HarnessSessionRegistry({ now });
    this._persistentAdapters = new Map(); // providerId -> adapter
    // professionalRunId -> { task, git } — run-wide freshness observation 상태.
    this._runFreshness = new Map();
    // entry -> cancel — lifecycle event에서 active turn을 best-effort로 취소하기
    // 위한 최소 추적. scheduler/lease manager가 아니다.
    this._activeTurnCancels = new Map();
    // providerId -> Set<entry> — 계정 전환으로 invalidated된 inflight entry가
    // settle될 때까지 해당 provider의 새 managed turn을 차단한다.
    this._accountSettleBarriers = new Map();
    this._closed = false;
  }

  get registry() {
    return this._registry;
  }

  register(providerId, adapter) {
    if (!providerId || !adapter) throw new Error("providerId와 adapter가 필요합니다.");
    this._persistentAdapters.set(String(providerId), adapter);
    return this;
  }

  // ---- Lifecycle events (상위 control plane이 호출하는 provider-neutral seam) ----

  workspaceChanged({ projectId } = {}) {
    if (projectId == null) return [];
    return this._applyLifecycle("retire", { projectId }, RETIRE_REASONS.WORKSPACE_CHANGED);
  }

  workspaceRestored({ projectId } = {}) {
    if (projectId == null) return [];
    return this._applyLifecycle("invalidate", { projectId }, INVALIDATE_REASONS.WORKSPACE_RESTORED);
  }

  // provider 계정 상태가 바뀌었다: provider-wide hard session boundary.
  // 해당 provider의 모든 ACTIVE managed session을 INVALIDATE하고,
  // inflight turn이 있으면 settle barrier에 등록한다. 이미 다른 lifecycle
  // 이벤트로 RETIRED/INVALIDATED되었지만 아직 inflight인 entry도 barrier에
  // 포함한다(lifecycle/reason은 보존).
  providerAccountChanged({ providerId } = {}) {
    if (providerId == null) return [];
    const pid = String(providerId);
    const affected = [];
    const barriered = new Set();
    for (const entry of this._registry.matching({ providerId: pid })) {
      if (entry.lifecycle !== LIFECYCLE.ACTIVE) {
        // 이미 RETIRED/INVALIDATED이지만 아직 inflight인 entry는 settle barrier에만
        // 추가한다. lifecycle/reason은 이전 이벤트가 남긴 것을 보존한다.
        if (entry.inflight) {
          const cancel = this._activeTurnCancels.get(entry);
          if (cancel) {
            try { cancel(); } catch {}
          }
          barriered.add(entry);
        }
        continue;
      }
      this._registry.invalidate(entry.key, INVALIDATE_REASONS.PROVIDER_ACCOUNT_CHANGED);
      const cancel = this._activeTurnCancels.get(entry);
      if (cancel) {
        try { cancel(); } catch {}
      }
      this._forgetSessionOnAdapter(entry);
      if (entry.inflight) {
        barriered.add(entry);
      }
      affected.push(entry);
    }
    if (barriered.size > 0) {
      let barrier = this._accountSettleBarriers.get(pid);
      if (!barrier) {
        barrier = new Set();
        this._accountSettleBarriers.set(pid, barrier);
      }
      for (const entry of barriered) barrier.add(entry);
    }
    const adapter = this._persistentAdapters.get(pid);
    if (adapter && typeof adapter.resetRuntime === "function") {
      adapter.resetRuntime(INVALIDATE_REASONS.PROVIDER_ACCOUNT_CHANGED);
    }
    return affected;
  }

  professionalRunEnded({ professionalRunId, invalid = false } = {}) {
    if (professionalRunId == null) return [];
    this._runFreshness.delete(String(professionalRunId));
    return this._applyLifecycle(
      invalid ? "invalidate" : "retire",
      { professionalRunId },
      invalid ? INVALIDATE_REASONS.PROFESSIONAL_RUN_ENDED : RETIRE_REASONS.PROFESSIONAL_RUN_ENDED
    );
  }

  close() {
    this._closed = true;
    this._applyLifecycle("retire", null, RETIRE_REASONS.RUNTIME_CLOSED);
    this._runFreshness.clear();
    for (const adapter of this._persistentAdapters.values()) {
      if (adapter && typeof adapter.close === "function") {
        try { adapter.close(); } catch {}
      }
    }
  }

  _applyLifecycle(kind, filter, reason) {
    const affected = kind === "invalidate"
      ? this._registry.invalidateWhere(filter, reason)
      : this._registry.retireWhere(filter, reason);
    for (const entry of affected) {
      const cancel = this._activeTurnCancels.get(entry);
      if (cancel) {
        try { cancel(); } catch {}
      }
      this._forgetSessionOnAdapter(entry);
    }
    return affected;
  }

  _forgetSessionOnAdapter(entry) {
    const providerId = entry?.identity?.providerId;
    if (!providerId) return;
    const adapter = this._persistentAdapters.get(providerId);
    if (adapter && typeof adapter.forgetSession === "function") {
      adapter.forgetSession({ key: entry.key, generation: entry.generation });
    }
  }

  _isProviderSettling(providerId) {
    const barrier = this._accountSettleBarriers.get(providerId);
    if (!barrier || barrier.size === 0) return false;
    for (const entry of barrier) {
      if (!entry.inflight) barrier.delete(entry);
    }
    return barrier.size > 0;
  }

  _persistentAdapterFor(context) {
    const providerId = context && context.providerId ? String(context.providerId) : null;
    if (!providerId) return null;
    const adapter = this._persistentAdapters.get(providerId);
    if (!adapter || adapter.supportsPersistentSession !== true) return null;
    return adapter;
  }

  // ---- run-wide freshness (Frozen Task hash · Git HEAD) ----
  _checkRunFreshness(context) {
    const runId = context.professionalRunId == null ? null : String(context.professionalRunId);
    if (!runId) return null;
    const provenance = context.provenance && typeof context.provenance === "object"
      ? context.provenance
      : {};

    const gitHead = provenance.gitHead && typeof provenance.gitHead === "object"
      ? provenance.gitHead
      : null;
    if (gitHead && gitHead.status === "error") {
      return "GIT_HEAD_UNAVAILABLE";
    }

    const tracked = this._runFreshness.get(runId) || {
      task: { state: "none" },
      git: { state: "none" },
    };

    const taskHash = provenance.taskHash == null || provenance.taskHash === ""
      ? null
      : String(provenance.taskHash);
    let nextTask = tracked.task;
    if (tracked.task.state === "none") {
      if (taskHash != null) nextTask = { state: "known", hash: taskHash };
    } else if (tracked.task.state === "known") {
      if (taskHash == null) {
        this._applyLifecycle(
          "retire",
          { professionalRunId: runId },
          RETIRE_REASONS.FROZEN_TASK_CHANGED
        );
        nextTask = { state: "unknown" };
      } else if (taskHash !== tracked.task.hash) {
        this._applyLifecycle(
          "retire",
          { professionalRunId: runId },
          RETIRE_REASONS.FROZEN_TASK_CHANGED
        );
        nextTask = { state: "known", hash: taskHash };
      }
    } else if (taskHash != null) {
      this._applyLifecycle(
        "retire",
        { professionalRunId: runId },
        RETIRE_REASONS.FROZEN_TASK_CHANGED
      );
      nextTask = { state: "known", hash: taskHash };
    }

    let nextGit = tracked.git;
    if (gitHead) {
      const observed = gitHead.status === "ok"
        ? { state: "ok", sha: String(gitHead.sha || "") }
        : { state: "unsupported" };
      if (tracked.git.state === "none") {
        nextGit = observed;
      } else if (
        tracked.git.state !== observed.state ||
        (observed.state === "ok" && tracked.git.sha !== observed.sha)
      ) {
        this._applyLifecycle(
          "retire",
          { professionalRunId: runId },
          RETIRE_REASONS.GIT_HEAD_CHANGED
        );
        nextGit = observed;
      }
    }

    this._runFreshness.set(runId, { task: nextTask, git: nextGit });
    return null;
  }

  // ---- role lineage sibling retire (model / permission switch-back 방지) ----
  //
  // 같은 lineage(projectId + professionalRunId + role + providerId)에서
  // modelKey / permissionMode가 바뀌면 old sibling을 RETIRE한다.
  _retireLineageSiblings(context) {
    const lineage = {
      projectId: context.projectId,
      professionalRunId: context.professionalRunId,
      role: context.role,
      providerId: context.providerId,
    };
    const modelKey = context.modelKey == null ? null : String(context.modelKey);
    const permissionMode = context.permissionMode == null ? null : String(context.permissionMode);
    for (const entry of this._registry.matching(lineage)) {
      if (entry.lifecycle !== LIFECYCLE.ACTIVE || !entry.identity) continue;
      if (entry.identity.modelKey !== modelKey) {
        this._retireEntry(entry, RETIRE_REASONS.MODEL_CHANGED);
      } else if (entry.identity.permissionMode !== permissionMode) {
        this._retireEntry(entry, RETIRE_REASONS.PERMISSION_CHANGED);
      }
    }
  }

  _retireEntry(entry, reason) {
    this._registry.retire(entry.key, reason);
    const cancel = this._activeTurnCancels.get(entry);
    if (cancel) {
      try { cancel(); } catch {}
    }
    this._forgetSessionOnAdapter(entry);
  }

  runTurn({ context = null, invocation } = {}) {
    if (!invocation) {
      throw new Error("HarnessRuntime.runTurn: invocation이 필요합니다.");
    }

    const runtimeContext = normalizeExecutionContext(context);
    const persistentAdapter = this._persistentAdapterFor(runtimeContext);

    if (!persistentAdapter) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    const professionalIntent = Boolean(runtimeContext?.role || runtimeContext?.professionalRunId);
    if (!professionalIntent) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    if (isUnresolvedModelKey(runtimeContext?.modelKey)) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    if (this._closed) {
      return failedRun(
        "Harness runtime이 이미 종료되어 managed session을 시작할 수 없습니다.",
        LIFECYCLE_STOP_REASONS.INVALID
      );
    }

    // account-switch inflight settle barrier: 계정 전환으로 invalidated된
    // inflight turn이 아직 settle되지 않았으면 새 managed turn을 차단한다.
    const pid = runtimeContext && runtimeContext.providerId ? String(runtimeContext.providerId) : null;
    if (pid && this._isProviderSettling(pid)) {
      return failedRun(
        "이전 계정의 inflight turn이 아직 종료 중이라 새 managed turn을 시작할 수 없습니다.",
        LIFECYCLE_STOP_REASONS.BUSY
      );
    }

    const freshnessFailure = this._checkRunFreshness(runtimeContext);
    if (freshnessFailure) {
      return failedRun(
        "authoritative Git HEAD를 확인할 수 없어 managed session을 시작하지 않습니다.",
        LIFECYCLE_STOP_REASONS.INVALID
      );
    }

    this._retireLineageSiblings(runtimeContext);

    const key = deriveSessionKey(runtimeContext);
    if (!key) {
      return failedRun(
        "Professional harness session identity를 안전하게 계산할 수 없습니다.",
        "HARNESS_SESSION_IDENTITY_INVALID"
      );
    }

    const entry = this._registry.acquire(key, {
      adapterId: persistentAdapter.id,
      identity: runtimeContext,
    });
    if (entry.lifecycle !== LIFECYCLE.ACTIVE) {
      return failedRun(
        "이전 세대 harness session이 아직 종료 중이라 새 세션을 시작할 수 없습니다.",
        LIFECYCLE_STOP_REASONS.BUSY
      );
    }
    if (!this._registry.tryBeginTurn(entry)) {
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

    const cancel = run && typeof run.cancel === "function" ? run.cancel : () => {};
    this._activeTurnCancels.set(entry, cancel);
    const settle = () => {
      this._activeTurnCancels.delete(entry);
      this._registry.endTurn(entry);
    };
    const promise = Promise.resolve(run.promise).then(
      (result) => {
        settle();
        return result;
      },
      (error) => {
        settle();
        throw error;
      }
    );
    return { promise, cancel };
  }
}

module.exports = { HarnessRuntime };
