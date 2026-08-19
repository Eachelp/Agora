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
    // professionalRunId -> { task, git } — run-wide freshness observation 상태.
    // nullable 값이 아니라 명시적 관측 상태(state)를 저장해 known→unknown→known
    // switch-back에서도 unknown 구간에 만들어진 세션이 살아남지 못하게 한다.
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

  // provider 계정 상태가 바뀌었다(성공한 switch는 accountKey와 함께, 외부 로그인
  // 시작/partial-mutation ambiguous failure는 accountKey 없이 = unknown 전이).
  //
  // 계정 변경은 session-selection boundary이지 provider-wide 세션 파괴가 아니다:
  //   - parked(비-inflight) 세션은 절대 건드리지 않는다. SessionKey가
  //     providerAccountKey를 포함하므로 다른 계정의 세션은 선택되지 않을 뿐이고,
  //     같은 계정으로 돌아오면(A→B→A) 같은 key로 native resume된다.
  //   - 오염된 inflight turn만 INVALIDATE한다: live credential이 turn 도중에
  //     mutation을 지나면 그 turn의 출력/부작용이 어느 계정 namespace에 속하는지
  //     보증할 수 없다. accountKey가 확정된 전환에서 이미 그 계정 key로 실행 중이던
  //     turn(중복 same-account 전환)은 오염이 아니므로 제외한다.
  //   - Codex처럼 resident runtime이 old account context를 들고 있을 수 있는
  //     provider는 adapter의 deliberate reset hook(resetRuntime)을 항상 호출한다.
  //     이 reset은 native cache(thread binding)만 비운다 — parked logical 세션은
  //     보존되며, 같은 계정 namespace로 돌아온 다음 turn은 (cross-process thread
  //     reattach가 지원되지 않으므로) 같은 logical session 아래 fresh native
  //     thread로 시작한다. provider continuity failure(CODEX_SESSION_LOST)의 자동
  //     restart와 다른, 명시적 account trust-boundary reset이다.
  providerAccountChanged({ providerId, accountKey = null } = {}) {
    if (providerId == null) return [];
    const pid = String(providerId);
    const nextKey = accountKey == null || accountKey === "" ? null : String(accountKey);
    const affected = [];
    for (const entry of this._registry.matching({ providerId: pid })) {
      if (entry.lifecycle !== LIFECYCLE.ACTIVE || !entry.inflight) continue;
      if (nextKey != null && entry.identity && entry.identity.providerAccountKey === nextKey) {
        continue; // 같은 계정으로의 재확정 — credential 의미가 그대로라 오염이 아니다.
      }
      this._registry.invalidate(entry.key, INVALIDATE_REASONS.PROVIDER_ACCOUNT_CHANGED);
      const cancel = this._activeTurnCancels.get(entry);
      if (cancel) {
        try { cancel(); } catch {}
      }
      this._forgetSessionOnAdapter(entry);
      affected.push(entry);
    }
    const adapter = this._persistentAdapters.get(pid);
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
  // professionalRunId의 명시적 관측 상태와 비교한다. authority가 바뀐 흔적이 보이면
  // 그 run의 모든 managed session을 RETIRE해 과거 native cache가 다시 선택되지
  // 못하게 한다. 관측 상태:
  //   task: { state: "none" } | { state: "known", hash } | { state: "unknown" }
  //     - "none"    = 아직 authoritative hash를 본 적 없음(pre-freeze 정상 구간).
  //     - "known"   = authoritative hash 확립.
  //     - "unknown" = known 이후 authority를 잃음. 이 구간에 만들어진 fresh 세션은
  //       authoritative hash가 (같은 값이어도) 복귀하는 순간 다시 RETIRE된다.
  //   git: { state: "none" } | { state: "ok", sha } | { state: "unsupported" }
  //     - 환경 status 전이(ok↔unsupported)도 sha 변경과 동일한 boundary다.
  //       unsupported 구간에 만들어진 세션은 Git 환경 복귀 시 살아남지 못한다.
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
      // 없으므로 stale native resume 대신 typed fail-closed한다. 마지막으로 신뢰한
      // 관측 상태는 절대 여기서 바꾸지 않는다(세션 상태도 유지).
      return "GIT_HEAD_UNAVAILABLE";
    }

    const tracked = this._runFreshness.get(runId) || {
      task: { state: "none" },
      git: { state: "none" },
    };

    // Frozen Task hash 관측 전이.
    const taskHash = provenance.taskHash == null || provenance.taskHash === ""
      ? null
      : String(provenance.taskHash);
    let nextTask = tracked.task;
    if (tracked.task.state === "none") {
      // pre-freeze null은 trigger가 아니고, 최초 authoritative hash는 확립이다.
      if (taskHash != null) nextTask = { state: "known", hash: taskHash };
    } else if (tracked.task.state === "known") {
      if (taskHash == null) {
        // known → unknown: authority 상실. RETIRE 후 unknown 상태로 전이해,
        // 이 구간에 만들어질 fresh 세션이 authoritative 복귀를 넘지 못하게 한다.
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
      // unknown → authoritative 복귀(같은 hash여도): unknown 구간 세션은 authoritative
      // 상태로 건너올 수 없다. RETIRE 후 복귀한 hash를 확립한다.
      this._applyLifecycle(
        "retire",
        { professionalRunId: runId },
        RETIRE_REASONS.FROZEN_TASK_CHANGED
      );
      nextTask = { state: "known", hash: taskHash };
    }
    // unknown → unknown: 같은 fresh unknown 세대가 유지된다(trigger 없음).

    // Git HEAD 관측 전이. working-tree-only 변경은 trigger가 아니다(ok + 같은 sha).
    let nextGit = tracked.git;
    if (gitHead) {
      const observed = gitHead.status === "ok"
        ? { state: "ok", sha: String(gitHead.sha || "") }
        : { state: "unsupported" };
      if (tracked.git.state === "none") {
        // 최초 관측은 확립이다(unsupported든 ok든 trigger 없음).
        nextGit = observed;
      } else if (
        tracked.git.state !== observed.state ||
        (observed.state === "ok" && tracked.git.sha !== observed.sha)
      ) {
        // sha 변경 + 환경 status 전이(ok→unsupported, unsupported→ok) 모두 boundary다.
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
  // 같은 lineage(projectId + professionalRunId + role + providerId +
  // providerAccountKey)에서 modelKey / permissionMode가 바뀌면 old sibling을
  // RETIRE한다. 그래야 switch-back 시 ACTIVE로 남아 있던 old native session이
  // 부활하지 못한다. lineage에 계정 key를 포함해 다른 계정 namespace의 parked
  // sibling(예: 계정 A의 Builder)이 계정 B에서의 model 변경으로 파괴되지 않게
  // 한다. effort/autoApprove는 identity도 trigger도 아니다(매 turn 재전달되는
  // turn-level 설정).
  _retireLineageSiblings(context) {
    const lineage = {
      projectId: context.projectId,
      professionalRunId: context.professionalRunId,
      role: context.role,
      providerId: context.providerId,
      providerAccountKey: context.providerAccountKey == null ? null : String(context.providerAccountKey),
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

    // provider 계정 identity gate. control plane이 계정 fact를 전달한 조립에서는
    // (chat-ipc Professional turn) 반드시 known 계정 key가 있어야 하고, unknown이면
    // A/B 어느 namespace도 선택하지 않고 fail-closed한다(parked 세션은 그대로 보존).
    // fact가 아예 없는 조립(구형/테스트)은 계정 미추적으로 두고 진행한다.
    const accountFact = runtimeContext ? runtimeContext.providerAccount : null;
    let accountContext = runtimeContext;
    if (accountFact != null) {
      const known = typeof accountFact === "object"
        && accountFact.status === "known"
        && accountFact.key != null
        && accountFact.key !== "";
      if (!known) {
        return failedRun(
          "provider 계정 identity가 확인되지 않아 managed session을 시작하지 않습니다.",
          LIFECYCLE_STOP_REASONS.ACCOUNT_UNRESOLVED
        );
      }
      // 확정된 opaque 계정 key를 flat identity 필드로 주입한다(SessionKey/Registry
      // identity의 단일 출처 = fact.key).
      accountContext = { ...runtimeContext, providerAccountKey: String(accountFact.key) };
    }

    // run-wide freshness gate: Frozen Task hash / Git HEAD fact 비교. HEAD를 판단할
    // 수 없는 비정상 상태면 stale resume 대신 typed fail-closed한다.
    const freshnessFailure = this._checkRunFreshness(accountContext);
    if (freshnessFailure) {
      return failedRun(
        "authoritative Git HEAD를 확인할 수 없어 managed session을 시작하지 않습니다.",
        LIFECYCLE_STOP_REASONS.INVALID
      );
    }

    // lineage sibling retire: model/permission이 바뀐 old sibling의 switch-back 부활 방지.
    this._retireLineageSiblings(accountContext);

    const key = deriveSessionKey(accountContext);
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
      identity: accountContext,
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
        context: accountContext,
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
