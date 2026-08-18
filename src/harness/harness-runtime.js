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

  // chat transport runId(r...)가 frozenRunId로 잘못 라벨링된 legacy 입력을
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
    // professionalRunId -> { taskHash, headSha } — run-wide freshness fact 추적.
    // memory-only이며 run 종료(professionalRunEnded)나 close에서 정리된다.
    this._runFreshness = new Map();
    // entry -> cancel — lifecycle event에서 active turn을 best-effort로 취소하기
    // 위한 최소 추적. scheduler/lease manager가 아니다.
    this._activeTurnCancels = new Map();
    this._closed = false;
  }

  get registry() {
    return this._registry;
  }

  // provider-native adapter 등록점. provider-specific 정책은 이 아래에만 둔다.
  register(providerId, adapter) {
    if (!providerId || !adapter) throw new Error("providerId와 adapter가 필요합니다.");
    this._persistentAdapters.set(String(providerId), adapter);
    return this;
  }

  // ---- Lifecycle events (상위 control plane이 호출하는 provider-neutral seam) ----

  // ProjectStore.workspace가 바뀌었다: 해당 project의 managed session 전체 RETIRE.
  workspaceChanged({ projectId } = {}) {
    if (projectId == null) return [];
    return this._applyLifecycle("retire", { projectId }, RETIRE_REASONS.WORKSPACE_CHANGED);
  }

  // checkpoint restore로 filesystem이 rewind되었다(HEAD가 같아도 explicit boundary):
  // 해당 project의 managed session 전체 INVALIDATE.
  workspaceRestored({ projectId } = {}) {
    if (projectId == null) return [];
    return this._applyLifecycle("invalidate", { projectId }, INVALIDATE_REASONS.WORKSPACE_RESTORED);
  }

  // provider 계정이 실제로 바뀌었다(성공한 switch 또는 partial-mutation ambiguous
  // failure의 conservative 처리): 해당 provider의 managed session 전체 INVALIDATE.
  // Codex처럼 resident runtime이 old account context를 들고 있을 수 있는 provider는
  // adapter의 deliberate reset hook(resetRuntime)까지 호출한다. 이는 provider
  // continuity failure(CODEX_SESSION_LOST)의 자동 restart와 다른, 명시적 account
  // trust-boundary reset이다.
  providerAccountChanged({ providerId } = {}) {
    if (providerId == null) return [];
    const affected = this._applyLifecycle(
      "invalidate",
      { providerId },
      INVALIDATE_REASONS.PROVIDER_ACCOUNT_CHANGED
    );
    const adapter = this._persistentAdapters.get(String(providerId));
    if (adapter && typeof adapter.resetRuntime === "function") {
      adapter.resetRuntime(INVALIDATE_REASONS.PROVIDER_ACCOUNT_CHANGED);
    }
    return affected;
  }

  // Professional Run이 canonical terminal 상태에 도달했다(completed/interrupted/
  // reset → RETIRE, invalid → INVALIDATE). run-wide freshness 추적도 함께 정리한다.
  professionalRunEnded({ professionalRunId, invalid = false } = {}) {
    if (professionalRunId == null) return [];
    this._runFreshness.delete(String(professionalRunId));
    return this._applyLifecycle(
      invalid ? "invalidate" : "retire",
      { professionalRunId },
      invalid ? INVALIDATE_REASONS.PROFESSIONAL_RUN_ENDED : RETIRE_REASONS.PROFESSIONAL_RUN_ENDED
    );
  }

  // Agora 종료: 모든 logical entry를 non-selectable로 만들고(RUNTIME_CLOSED),
  // active turn을 best-effort 취소한 뒤 provider-local binding/resident child를
  // 정리한다. 이후 stale session selection은 불가능하다.
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

  // 결정된 lifecycle을 registry에 반영하고, 영향받은 entry마다 (1) active turn
  // best-effort cancel (2) provider adapter native cache cleanup을 지시한다.
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

  // provider에 등록된 persistent-capable adapter가 있으면 반환한다. 없거나 capability를
  // 켜지 않았으면 null(→ sessionless 경로).
  _persistentAdapterFor(context) {
    const providerId = context && context.providerId ? String(context.providerId) : null;
    if (!providerId) return null;
    const adapter = this._persistentAdapters.get(providerId);
    if (!adapter || adapter.supportsPersistentSession !== true) return null;
    return adapter;
  }

  // ---- run-wide freshness (Frozen Task hash · Git HEAD) ----
  //
  // 상위 control plane이 매 Professional managed turn에 전달한 facts를 같은
  // professionalRunId의 직전 값과 비교한다. authority가 바뀐 흔적이 보이면 그 run의
  // 모든 managed session을 RETIRE해 과거 native cache가 다시 선택되지 못하게 한다.
  // 반환: null(진행 가능) 또는 fail-closed 사유 문자열.
  _checkRunFreshness(context) {
    const runId = context.professionalRunId == null ? null : String(context.professionalRunId);
    if (!runId) return null;
    const provenance = context.provenance && typeof context.provenance === "object"
      ? context.provenance
      : {};

    // Git HEAD fact: { status: "ok", sha } | { status: "unsupported" } | { status: "error" }.
    // fact가 아예 없으면(비-Professional 조립 등) HEAD 추적을 하지 않는다.
    const gitHead = provenance.gitHead && typeof provenance.gitHead === "object"
      ? provenance.gitHead
      : null;
    if (gitHead && gitHead.status === "error") {
      // Git 저장소로 확인된 workspace에서 HEAD를 읽지 못했다: freshness를 판단할 수
      // 없으므로 stale native resume 대신 typed fail-closed한다(세션 상태는 유지).
      return "GIT_HEAD_UNAVAILABLE";
    }

    const tracked = this._runFreshness.get(runId) || { taskHash: null, headSha: null };
    let nextTaskHash = tracked.taskHash;
    let nextHeadSha = tracked.headSha;

    // Frozen Task hash: pre-freeze 단계의 null은 정상이다. 그러나 같은 run에서 이미
    // authoritative hash를 알고 있었는데 다른 값(또는 unknown/null)이 되면 run-wide
    // RETIRE로 과거 세션 재사용을 막는다(conservative retire → 이번 turn은 fresh
    // generation으로 진행).
    const taskHash = provenance.taskHash == null || provenance.taskHash === ""
      ? null
      : String(provenance.taskHash);
    if (tracked.taskHash != null && taskHash !== tracked.taskHash) {
      this._applyLifecycle(
        "retire",
        { professionalRunId: runId },
        RETIRE_REASONS.FROZEN_TASK_CHANGED
      );
      nextTaskHash = taskHash;
    } else if (taskHash != null) {
      nextTaskHash = taskHash;
    }

    // Git HEAD: working-tree-only 변경은 trigger가 아니다(HEAD 동일 → 유지).
    // HEAD가 실제로 바뀐 경우(commit 등)만 run-wide RETIRE한다. non-Git(unsupported)
    // 은 정상 지원 상태이며, 이전에 HEAD를 추적하던 run이 unsupported로 바뀌면
    // 환경이 이동한 것이므로 동일하게 RETIRE 후 추적을 중단한다.
    if (gitHead) {
      const headSha = gitHead.status === "ok" ? String(gitHead.sha || "") : null;
      if (tracked.headSha != null && headSha !== tracked.headSha) {
        this._applyLifecycle(
          "retire",
          { professionalRunId: runId },
          RETIRE_REASONS.GIT_HEAD_CHANGED
        );
      }
      nextHeadSha = headSha;
    }

    this._runFreshness.set(runId, { taskHash: nextTaskHash, headSha: nextHeadSha });
    return null;
  }

  // ---- role lineage sibling retire (model / permission switch-back 방지) ----
  //
  // 같은 lineage(projectId + professionalRunId + role + providerId)에서 modelKey /
  // permissionMode가 바뀌면 old sibling을 RETIRE한다. 그래야 switch-back 시 ACTIVE로
  // 남아 있던 old native session이 부활하지 못한다. effort/autoApprove는 identity도
  // trigger도 아니다(매 turn 재전달되는 turn-level 설정).
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

    // provider-native persistent adapter가 없으면 C-1과 동일한 one-shot process 경로다.
    if (!persistentAdapter) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    // General chat은 의도적으로 sessionless다. role/professionalRunId가 모두
    // 없으면 persistent-capable provider여도 registry를 만들지 않고 one-shot으로 실행한다.
    const professionalIntent = Boolean(runtimeContext?.role || runtimeContext?.professionalRunId);
    if (!professionalIntent) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    // resolved concrete model이 없으면 persistent identity를 고정할 수 없으므로 계약상
    // sessionless process 경로를 사용한다. 이 경우는 identity 손상이 아니라 의도된 fallback이다.
    if (isUnresolvedModelKey(runtimeContext?.modelKey)) {
      return this._processAdapter.runTurn({ context: runtimeContext, invocation });
    }

    // close 이후의 stale managed 실행 금지(모든 entry는 이미 RUNTIME_CLOSED).
    if (this._closed) {
      return failedRun(
        "Harness runtime이 이미 종료되어 managed session을 시작할 수 없습니다.",
        LIFECYCLE_STOP_REASONS.INVALID
      );
    }

    // run-wide freshness gate: Frozen Task hash / Git HEAD fact 비교. HEAD를 판단할
    // 수 없는 비정상 상태면 stale resume 대신 typed fail-closed한다.
    const freshnessFailure = this._checkRunFreshness(runtimeContext);
    if (freshnessFailure) {
      return failedRun(
        "authoritative Git HEAD를 확인할 수 없어 managed session을 시작하지 않습니다.",
        LIFECYCLE_STOP_REASONS.INVALID
      );
    }

    // lineage sibling retire: model/permission이 바뀐 old sibling의 switch-back 부활 방지.
    this._retireLineageSiblings(runtimeContext);

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
    const entry = this._registry.acquire(key, {
      adapterId: persistentAdapter.id,
      identity: runtimeContext,
    });
    if (entry.lifecycle !== LIFECYCLE.ACTIVE) {
      // 종료된 old generation이 아직 inflight다: settle 전에는 replacement generation을
      // 만들지도, 실행하지도 않는다(section 16 inflight lifecycle race).
      return failedRun(
        "이전 세대 harness session이 아직 종료 중이라 새 세션을 시작할 수 없습니다.",
        LIFECYCLE_STOP_REASONS.BUSY
      );
    }
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

    const cancel = run && typeof run.cancel === "function" ? run.cancel : () => {};
    this._activeTurnCancels.set(entry, cancel);
    const settle = () => {
      // entry 객체 기준으로만 정리한다: late settle이 이미 교체된 새 generation의
      // inflight/추적 상태를 건드리지 않는다.
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
