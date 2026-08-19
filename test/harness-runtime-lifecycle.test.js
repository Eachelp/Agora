"use strict";

// Stage C — Session Invalidation / Lifecycle: HarnessRuntime lifecycle coordinator.
//
// 검증 목표(요구 matrix F~Z):
//   - model/permission switch-back에서 old sibling RETIRE + fresh generation.
//   - taskHash / Git HEAD run-wide freshness(RETIRE) · working-tree-only 비-trigger.
//   - Git HEAD 판독 불가 시 typed fail-closed(HARNESS_SESSION_LIFECYCLE_INVALID).
//   - workspace change/restore · provider account change · run end · runtime close.
//   - inflight lifecycle race: busy fail-closed + best-effort cancel + settle 후 fresh.
//   - provider cleanup hook(forgetSession) · Codex deliberate account reset(resetRuntime).
//   - effort/autoApprove는 non-trigger. lifecycle 실패는 Evidence/RunMetrics를 만들지 않는다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");

const { HarnessRuntime } = require("../src/harness/harness-runtime");
const { HarnessAdapter } = require("../src/harness/harness-adapter");
const { LIFECYCLE } = require("../src/harness/harness-session-registry");
const { CodexManagedAdapter } = require("../src/harness/codex/codex-managed-adapter");
const { ClaudeManagedAdapter } = require("../src/harness/claude/claude-managed-adapter");
const { AGYManagedAdapter } = require("../src/harness/agy/agy-managed-adapter");

// 세션/turn 기록 + lifecycle hook 스파이를 갖춘 fake persistent adapter.
class FakeLifecycleAdapter extends HarnessAdapter {
  constructor(id = "fake-persistent") {
    super({ id, supportsPersistentSession: true });
    this.calls = [];
    this.forgets = [];
    this.resets = [];
    this.cancels = 0;
    this.pending = false; // true면 turn이 수동 settle될 때까지 미완료로 남는다
    this._resolvers = [];
  }
  runTurn({ context, invocation, session }) {
    this.calls.push({ context, invocation, session });
    if (this.pending) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this._resolvers.push(resolve);
      return { promise, cancel: () => { this.cancels += 1; } };
    }
    return { promise: Promise.resolve({ ok: true, session }), cancel: () => { this.cancels += 1; } };
  }
  settleAll(result = { ok: false, cancelled: true }) {
    for (const resolve of this._resolvers.splice(0)) resolve(result);
  }
  forgetSession(session) { this.forgets.push(session); }
  resetRuntime(reason) { this.resets.push(reason); }
}

function spyProcessAdapter() {
  const calls = [];
  return {
    id: "process",
    supportsPersistentSession: false,
    calls,
    runTurn(req) {
      calls.push(req);
      return { promise: Promise.resolve({ ok: true, tag: "process" }), cancel: () => {} };
    },
  };
}

function ctx(over = {}) {
  return {
    projectId: "p1",
    workspaceId: "/ws/a",
    professionalRunId: "pr-1",
    role: "implementation",
    providerId: "claude",
    modelKey: "claude-x",
    permissionMode: "workspace-write",
    effort: "high",
    autoApprove: false,
    ...over,
  };
}
const INV = { commandPath: "node", argv: [], prompt: "" };

function makeRuntime() {
  const fake = new FakeLifecycleAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  return { rt, fake };
}

const activeEntries = (rt) => rt.registry.entries().filter((e) => e.lifecycle === LIFECYCLE.ACTIVE);

// ---- F/G. model / permission lineage switch-back ----

test("F. model A→B→A: old A는 MODEL_CHANGED로 RETIRE되고 switch-back은 fresh generation이다", async () => {
  const { rt, fake } = makeRuntime();
  const a1 = await rt.runTurn({ context: ctx({ modelKey: "mA" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ modelKey: "mB" }), invocation: INV }).promise;

  const oldA = rt.registry.entries().find((e) => e.identity.modelKey === "mA");
  assert.equal(oldA.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(oldA.invalidationReason, "MODEL_CHANGED");
  assert.deepEqual(fake.forgets.at(-1), { key: a1.session.key, generation: 1 }, "old sibling native cache forget");

  const a2 = await rt.runTurn({ context: ctx({ modelKey: "mA" }), invocation: INV }).promise;
  assert.equal(a2.session.key, a1.session.key);
  assert.equal(a2.session.generation, 2, "switch-back은 old 부활이 아니라 fresh 세대");
  // B lineage sibling도 A 복귀 시점에 RETIRE된다.
  const oldB = rt.registry.entries().find((e) => e.identity.modelKey === "mB");
  assert.equal(oldB.lifecycle, LIFECYCLE.RETIRED);
});

test("G. permission write→read→write: old write 세션 재사용 금지(PERMISSION_CHANGED)", async () => {
  const { rt } = makeRuntime();
  const w1 = await rt.runTurn({ context: ctx({ permissionMode: "workspace-write" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ permissionMode: "workspace-read" }), invocation: INV }).promise;
  const oldW = rt.registry.entries().find((e) => e.identity.permissionMode === "workspace-write");
  assert.equal(oldW.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(oldW.invalidationReason, "PERMISSION_CHANGED");
  const w2 = await rt.runTurn({ context: ctx({ permissionMode: "workspace-write" }), invocation: INV }).promise;
  assert.equal(w2.session.generation, 2);
  assert.equal(w2.session.key, w1.session.key);
});

test("다른 role/run lineage는 model 변경의 sibling-retire 영향을 받지 않는다", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx({ role: "review", modelKey: "mA" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "implementation", modelKey: "mB" }), invocation: INV }).promise;
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.ACTIVE, "다른 lineage는 유지");
});

// ---- H. workspace change ----

test("H. workspace A→B→A: WORKSPACE_CHANGED 이벤트가 project 전체를 RETIRE하고 old cache 재사용을 막는다", async () => {
  const { rt, fake } = makeRuntime();
  const a1 = await rt.runTurn({ context: ctx({ workspaceId: "/ws/a" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "review", workspaceId: "/ws/a" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ projectId: "p-other" }), invocation: INV }).promise;

  const affected = rt.workspaceChanged({ projectId: "p1" });
  assert.equal(affected.length, 2, "해당 project의 세션만 RETIRE");
  for (const e of affected) {
    assert.equal(e.lifecycle, LIFECYCLE.RETIRED);
    assert.equal(e.invalidationReason, "WORKSPACE_CHANGED");
  }
  assert.equal(fake.forgets.length, 2);
  const other = rt.registry.entries().find((e) => e.identity.projectId === "p-other");
  assert.equal(other.lifecycle, LIFECYCLE.ACTIVE);

  // B로 갔다가 A로 돌아와도 old A generation은 선택되지 않는다.
  await rt.runTurn({ context: ctx({ workspaceId: "/ws/b" }), invocation: INV }).promise;
  rt.workspaceChanged({ projectId: "p1" });
  const a2 = await rt.runTurn({ context: ctx({ workspaceId: "/ws/a" }), invocation: INV }).promise;
  assert.equal(a2.session.key, a1.session.key);
  assert.equal(a2.session.generation, 2, "old A native cache 부활 금지");
});

// ---- I/J/K. run-wide freshness: taskHash / Git HEAD ----

const prov = (over = {}) => ({ frozenRunId: "RUN-001", taskHash: null, gitHead: { status: "unsupported" }, ...over });

test("I. same run에서 taskHash A→B면 run-wide RETIRE(FROZEN_TASK_CHANGED) 후 fresh 세대로 진행한다", async () => {
  const { rt } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "review", provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;

  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashB" }) }), invocation: INV }).promise;
  assert.equal(b2.ok, true);
  assert.equal(b2.session.key, b1.session.key);
  assert.equal(b2.session.generation, 2, "hash 변경 후 같은 key는 fresh 세대");
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.RETIRED, "run-wide RETIRE");
  assert.equal(reviewer.invalidationReason, "FROZEN_TASK_CHANGED");
});

test("I2. 알고 있던 taskHash가 unknown/null로 사라지면 conservative RETIRE로 stale resume을 막는다", async () => {
  const { rt } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation + 1);
});

test("I3. pre-freeze null taskHash는 정상이며 세션 continuity를 유지한다", async () => {
  const { rt } = makeRuntime();
  const p1 = await rt.runTurn({ context: ctx({ role: "planner", provenance: prov() }), invocation: INV }).promise;
  const p2 = await rt.runTurn({ context: ctx({ role: "planner", provenance: prov() }), invocation: INV }).promise;
  assert.equal(p2.session.generation, p1.session.generation, "null→null은 trigger가 아니다");
  // 이후 freeze되어 hash가 생기는 것도 change가 아니다(최초 확정).
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  assert.equal(b1.session.generation, 1);
});

test("J. Git HEAD abc→def면 run-wide RETIRE(GIT_HEAD_CHANGED)", async () => {
  const { rt } = makeRuntime();
  const gh = (sha) => ({ status: "ok", sha });
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "review", provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("def222") }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation + 1);
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(reviewer.invalidationReason, "GIT_HEAD_CHANGED");
});

test("K. HEAD 동일 + working-tree 변경은 lifecycle trigger가 아니다(continuity 유지)", async () => {
  const { rt } = makeRuntime();
  const gh = { status: "ok", sha: "abc111" };
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh, taskHash: "hashA" }) }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh, taskHash: "hashA" }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation, "같은 HEAD/hash면 같은 세대");
});

test("K2. non-Git workspace(unsupported)는 정상 지원 상태다(HEAD 추적 없음, continuity 유지)", async () => {
  const { rt } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov() }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov() }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation);
});

test("J2. Git HEAD를 판독할 수 없으면(HARNESS_SESSION_LIFECYCLE_INVALID) stale resume 대신 fail-closed한다", async () => {
  const { rt, fake } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "ok", sha: "abc111" } }) }), invocation: INV }).promise;
  const failed = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "error" } }) }), invocation: INV }).promise;
  assert.equal(failed.ok, false);
  assert.equal(failed.stopReason, "HARNESS_SESSION_LIFECYCLE_INVALID");
  assert.equal(fake.calls.length, 1, "adapter는 호출되지 않는다(실행 없음)");
  // 세션은 종료되지 않고 유지된다(판단 불가 상태에서의 conservative hold).
  const entry = rt.registry.get(b1.session.key);
  assert.equal(entry.lifecycle, LIFECYCLE.ACTIVE);
  // HEAD가 다시 판독되고 값이 같으면 continuity가 이어진다.
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "ok", sha: "abc111" } }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation);
});

// ---- 리뷰 F4. freshness 관측 상태: known→unknown→known / Git 환경 status 전이 ----
//
// unknown/unsupported 구간에 만들어진 fresh 세션은 authority가 (같은 값으로라도)
// 복귀하는 전이를 절대 살아서 건너지 못한다.

const gh = (sha) => ({ status: "ok", sha });

test("RF-A. pre-freeze null → 최초 hash A는 확립이며 불필요한 retire가 없다", async () => {
  const { rt } = makeRuntime();
  const p1 = await rt.runTurn({ context: ctx({ provenance: prov() }), invocation: INV }).promise;
  const p2 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  assert.equal(p2.session.generation, p1.session.generation, "최초 확립은 boundary가 아니다");
});

test("RF-B. hash A → null → A: 양쪽 전이 모두 RETIRE(unknown 세대는 authoritative로 못 넘어온다)", async () => {
  const { rt } = makeRuntime();
  const g1 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  const g2 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  assert.equal(g2.session.generation, g1.session.generation + 1, "known→unknown RETIRE");
  // unknown 구간에 만들어진 다른 role 세션 — authoritative 복귀를 살아서 넘으면 안 된다.
  await rt.runTurn({ context: ctx({ role: "review", provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  // 반복 unknown은 같은 fresh unknown 세대를 유지한다.
  const g2b = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  assert.equal(g2b.session.generation, g2.session.generation, "unknown→unknown은 trigger가 아니다");
  const g3 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  assert.equal(g3.session.generation, g2.session.generation + 1, "같은 hash 복귀도 unknown 세대를 RETIRE");
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.RETIRED, "unknown 구간 세션은 복귀 전이에서 run-wide RETIRE");
  assert.equal(reviewer.invalidationReason, "FROZEN_TASK_CHANGED");
});

test("RF-C. hash A → null → B: unknown 세대는 B로도 상속되지 않는다", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  const g2 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "review", provenance: prov({ taskHash: null }) }), invocation: INV }).promise;
  const g3 = await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashB" }) }), invocation: INV }).promise;
  assert.equal(g3.session.generation, g2.session.generation + 1);
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(reviewer.invalidationReason, "FROZEN_TASK_CHANGED");
});

test("RF-D. Git unsupported → unsupported는 continuity다", async () => {
  const { rt } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation);
});

test("RF-E. Git unsupported → ok(A)는 환경 전이로서 RETIRE + fresh generation이다", async () => {
  const { rt } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ role: "review", provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  const b2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation + 1, "unsupported 구간 세대는 Git 복귀를 못 넘는다");
  const reviewer = rt.registry.entries().find((e) => e.identity.role === "review");
  assert.equal(reviewer.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(reviewer.invalidationReason, "GIT_HEAD_CHANGED");
});

test("RF-F. Git ok(A) → unsupported → ok(A): 양쪽 전이 모두 RETIRE된다", async () => {
  const { rt } = makeRuntime();
  const g1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  const g2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  assert.equal(g2.session.generation, g1.session.generation + 1, "ok→unsupported RETIRE");
  const g3 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  assert.equal(g3.session.generation, g2.session.generation + 1, "같은 HEAD로 복귀해도 unsupported 세대 RETIRE");
});

test("RF-G. Git ok(A) → unsupported → ok(B): 양쪽 전이 모두 RETIRE된다", async () => {
  const { rt } = makeRuntime();
  const g1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  const g2 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "unsupported" } }) }), invocation: INV }).promise;
  assert.equal(g2.session.generation, g1.session.generation + 1);
  const g3 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("def222") }) }), invocation: INV }).promise;
  assert.equal(g3.session.generation, g2.session.generation + 1);
});

test("RF-H. git status:error는 typed fail-closed이며 마지막 신뢰 관측 상태를 조용히 바꾸지 않는다", async () => {
  const { rt, fake } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  const failed = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: { status: "error" } }) }), invocation: INV }).promise;
  assert.equal(failed.ok, false);
  assert.equal(failed.stopReason, "HARNESS_SESSION_LIFECYCLE_INVALID");
  assert.equal(fake.calls.length, 1, "실행 없음");
  // error가 관측 상태를 지웠다면 (1) 같은 HEAD 복귀가 continuity를 잃거나
  // (2) 다른 HEAD가 '최초 확립'으로 잘못 통과한다. 둘 다 아니어야 한다.
  const same = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("abc111") }) }), invocation: INV }).promise;
  assert.equal(same.session.generation, b1.session.generation, "error 이후 같은 HEAD는 continuity");
  const moved = await rt.runTurn({ context: ctx({ provenance: prov({ gitHead: gh("def222") }) }), invocation: INV }).promise;
  assert.equal(moved.session.generation, b1.session.generation + 1, "error 이후에도 이전 신뢰 상태와 비교해 RETIRE");
});

// ---- L. workspace restore ----

test("L. workspaceRestored는 HEAD가 같아도 explicit INVALIDATE(WORKSPACE_RESTORED)다", async () => {
  const { rt, fake } = makeRuntime();
  const b1 = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  const affected = rt.workspaceRestored({ projectId: "p1" });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].lifecycle, LIFECYCLE.INVALIDATED);
  assert.equal(affected[0].invalidationReason, "WORKSPACE_RESTORED");
  assert.equal(fake.forgets.length, 1);
  const b2 = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(b2.session.generation, b1.session.generation + 1);
});

// ---- N/O/P/R. provider account change (session-selection boundary) ----

test("N. providerAccountChanged: parked 세션은 보존(파괴 금지)하고 resetRuntime hook만 부른다", async () => {
  const fakeClaude = new FakeLifecycleAdapter("claude-fake");
  const fakeCodex = new FakeLifecycleAdapter("codex-fake");
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fakeClaude);
  rt.register("codex", fakeCodex);
  await rt.runTurn({ context: ctx({ providerId: "claude", providerAccountKey: "acctA" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ providerId: "codex", modelKey: "gpt-x" }), invocation: INV }).promise;

  // 계정 A→B 전환: 비-inflight(parked) 세션은 selection boundary 뒤에 그대로 남는다.
  const affected = rt.providerAccountChanged({ providerId: "claude", accountKey: "acctB" });
  assert.equal(affected.length, 0, "parked 세션은 오염이 아니므로 INVALIDATE하지 않는다");
  const parked = rt.registry.entries().find((e) => e.identity.providerAccountKey === "acctA");
  assert.equal(parked.lifecycle, LIFECYCLE.ACTIVE, "A namespace parked 유지");
  assert.equal(fakeClaude.forgets.length, 0, "parked native binding은 보존된다");
  assert.deepEqual(fakeClaude.resets, ["PROVIDER_ACCOUNT_CHANGED"], "resident runtime deliberate reset hook은 항상 호출");
  assert.equal(fakeCodex.forgets.length, 0, "다른 provider는 영향 없음");
  assert.deepEqual(fakeCodex.resets, []);

  // 계정 B namespace는 별도 key → 별도 logical session(1세대)이다.
  const b = await rt.runTurn({ context: ctx({ providerId: "claude", providerAccountKey: "acctB" }), invocation: INV }).promise;
  assert.equal(b.session.generation, 1, "B는 A의 교체 세대가 아니라 자체 namespace의 첫 세대");
  assert.notEqual(b.session.key, parked.key);

  // A로 돌아오면(A→B→A) parked 세션이 같은 key/세대로 다시 선택된다(native resume 대상).
  const back = await rt.runTurn({ context: ctx({ providerId: "claude", providerAccountKey: "acctA" }), invocation: INV }).promise;
  assert.equal(back.session.key, parked.key);
  assert.equal(back.session.generation, parked.generation, "switch-back은 parked 세션 resume이다");
});

test("N2. providerAccountChanged: 다른 계정 inflight turn만 오염으로 INVALIDATE하고 같은 계정 inflight는 지나간다", async () => {
  const { rt, fake } = makeRuntime();
  fake.pending = true;
  const runA = rt.runTurn({ context: ctx({ providerAccountKey: "acctA" }), invocation: INV });

  // 같은 계정으로의 재확정(중복 전환)은 오염이 아니다.
  assert.equal(rt.providerAccountChanged({ providerId: "claude", accountKey: "acctA" }).length, 0);
  assert.equal(fake.cancels, 0, "same-account 재확정은 inflight를 취소하지 않는다");

  // 다른 계정으로의 전환은 credential mutation을 지나는 inflight turn을 오염으로 본다.
  const affected = rt.providerAccountChanged({ providerId: "claude", accountKey: "acctB" });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].lifecycle, LIFECYCLE.INVALIDATED);
  assert.equal(affected[0].invalidationReason, "PROVIDER_ACCOUNT_CHANGED");
  assert.equal(fake.cancels, 1, "오염된 inflight turn best-effort cancel");
  assert.equal(fake.forgets.length, 1, "오염된 generation의 native binding forget");

  fake.settleAll({ ok: false, cancelled: true });
  await runA.promise;
});

test("R. 계정 전환이 inflight turn과 겹치면: best-effort cancel + 즉시 replacement 금지 + settle 후 fresh", async () => {
  const { rt, fake } = makeRuntime();
  fake.pending = true;
  const run1 = rt.runTurn({ context: ctx(), invocation: INV });

  const affected = rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(affected.length, 1);
  assert.equal(fake.cancels, 1, "active turn best-effort cancel");

  // old turn settle 전에는 replacement generation을 실행하지 않는다.
  fake.pending = false;
  const blocked = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");
  assert.equal(fake.calls.length, 1, "새 adapter turn 시작 금지");
  assert.equal(blocked.evidence, undefined, "lifecycle busy는 Evidence를 만들지 않는다");
  assert.equal(blocked.runMetrics, undefined, "lifecycle busy는 RunMetrics를 만들지 않는다");

  // settle 후에만 fresh generation이 허용된다.
  fake.settleAll({ ok: false, cancelled: true });
  await run1.promise;
  const fresh = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(fresh.ok, true);
  assert.equal(fresh.session.generation, 2);
});

test("R2. late gen1 settle은 이미 시작된 gen2 inflight 상태를 바꾸지 않는다", async () => {
  const { rt, fake } = makeRuntime();
  fake.pending = true;
  const run1 = rt.runTurn({ context: ctx(), invocation: INV });
  const gen1Resolve = fake._resolvers.splice(0)[0];
  // gen1이 settle된 뒤 retire → gen2 pending 시작.
  rt.registry.endTurn(rt.registry.get(rt.registry.entries()[0].key));
  rt.workspaceChanged({ projectId: "p1" });
  const run2 = rt.runTurn({ context: ctx(), invocation: INV });
  const gen2Entry = rt.registry.entries()[0];
  assert.equal(gen2Entry.generation, 2);
  assert.equal(gen2Entry.inflight, true);
  // 늦게 도착한 gen1 결과 — gen2 inflight는 그대로여야 한다.
  gen1Resolve({ ok: false, cancelled: true });
  await run1.promise;
  assert.equal(gen2Entry.inflight, true, "late gen1 settle이 gen2를 오염시키면 안 된다");
  fake.settleAll({ ok: true });
  await run2.promise;
  assert.equal(gen2Entry.inflight, false);
});

// ---- S. professional run end ----

test("S. Run terminal(completed/cancel) → run-scoped RETIRE + binding forget, 새 Run은 fresh", async () => {
  const { rt, fake } = makeRuntime();
  await rt.runTurn({ context: ctx({ professionalRunId: "pr-1" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ professionalRunId: "pr-1", role: "review" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ professionalRunId: "pr-2" }), invocation: INV }).promise;

  const affected = rt.professionalRunEnded({ professionalRunId: "pr-1" });
  assert.equal(affected.length, 2);
  for (const e of affected) {
    assert.equal(e.lifecycle, LIFECYCLE.RETIRED);
    assert.equal(e.invalidationReason, "PROFESSIONAL_RUN_ENDED");
  }
  assert.equal(fake.forgets.length, 2);
  const other = rt.registry.entries().find((e) => e.identity.professionalRunId === "pr-2");
  assert.equal(other.lifecycle, LIFECYCLE.ACTIVE);

  // 같은 run id로 다시 실행하면(이론상) fresh generation, 새 run은 어차피 새 key다.
  const again = await rt.runTurn({ context: ctx({ professionalRunId: "pr-1" }), invocation: INV }).promise;
  assert.equal(again.session.generation, 2);
});

test("S2. invalid run 종료는 INVALIDATE로 기록된다", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  const affected = rt.professionalRunEnded({ professionalRunId: "pr-1", invalid: true });
  assert.equal(affected[0].lifecycle, LIFECYCLE.INVALIDATED);
  assert.equal(affected[0].invalidationReason, "PROFESSIONAL_RUN_ENDED");
});

test("S3. run 종료는 freshness 추적을 정리해 재시작 run이 stale 비교를 하지 않는다", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx({ provenance: prov({ taskHash: "hashA" }) }), invocation: INV }).promise;
  rt.professionalRunEnded({ professionalRunId: "pr-1" });
  // 같은 run id가 재사용되어도(REPLAN_RESET) pre-freeze null은 change로 취급되지 않는다.
  const p1 = await rt.runTurn({ context: ctx({ role: "planner", provenance: prov() }), invocation: INV }).promise;
  const p2 = await rt.runTurn({ context: ctx({ role: "planner", provenance: prov() }), invocation: INV }).promise;
  assert.equal(p2.session.generation, p1.session.generation, "추적이 정리되어 continuity 유지");
});

// ---- T/U/V. unchanged context / non-triggers ----

test("T. 모든 identity/facts가 unchanged면 same key + same generation(continuity)", async () => {
  const { rt } = makeRuntime();
  const c = () => ctx({ provenance: prov({ taskHash: "hashA", gitHead: { status: "ok", sha: "abc111" } }) });
  const a = await rt.runTurn({ context: c(), invocation: INV }).promise;
  const b = await rt.runTurn({ context: c(), invocation: INV }).promise;
  assert.equal(a.session.key, b.session.key);
  assert.equal(a.session.generation, b.session.generation);
});

test("U/V. effort/autoApprove 변경은 lifecycle trigger가 아니다(같은 세션, 매 turn 재전달)", async () => {
  const { rt, fake } = makeRuntime();
  const a = await rt.runTurn({ context: ctx({ effort: "high", autoApprove: false }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ effort: "low", autoApprove: true }), invocation: INV }).promise;
  assert.equal(a.session.key, b.session.key);
  assert.equal(a.session.generation, b.session.generation);
  assert.equal(rt.registry.entries()[0].lifecycle, LIFECYCLE.ACTIVE);
  // 현재 effort/autoApprove는 매 turn context로 다시 전달된다.
  assert.equal(fake.calls[1].context.effort, "low");
  assert.equal(fake.calls[1].context.autoApprove, true);
});

// ---- runtime close ----

test("close: 모든 entry RUNTIME_CLOSED + adapter close + 이후 managed 실행 fail-closed", async () => {
  const fake = new FakeLifecycleAdapter();
  let adapterClosed = 0;
  fake.close = () => { adapterClosed += 1; };
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  await rt.runTurn({ context: ctx(), invocation: INV }).promise;

  rt.close();
  const entry = rt.registry.entries()[0];
  assert.equal(entry.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(entry.invalidationReason, "RUNTIME_CLOSED");
  assert.equal(fake.forgets.length, 1);
  assert.equal(adapterClosed, 1);

  const after = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(after.ok, false);
  assert.equal(after.stopReason, "HARNESS_SESSION_LIFECYCLE_INVALID");
  assert.equal(fake.calls.length, 1, "close 이후 stale managed 실행 금지");
});

// ---- W/X. Claude/AGY forgetSession (native cache cleanup) ----

test("W. Claude forgetSession은 binding/poison 기록을 제거한다(runtime retire의 native 반영)", async () => {
  const runs = [];
  const runProcess = (invocation) => {
    runs.push(invocation);
    if (typeof invocation.parseLine === "function") {
      invocation.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1", tools: [] }));
    }
    return { promise: Promise.resolve({ ok: true, text: "answer" }), cancel: () => {} };
  };
  const adapter = new ClaudeManagedAdapter({ runProcess });
  const session = { key: "k", generation: 1 };
  const invocation = { commandPath: "claude", argv: ["-p"], prompt: "p" };
  await adapter.runTurn({ context: null, invocation, session }).promise;
  assert.equal(adapter._bindings.size, 1);
  adapter.forgetSession(session);
  assert.equal(adapter._bindings.size, 0, "binding forget");
  assert.equal(adapter._invalidatedHandles.size, 0);
  // forget된 handle로는(설령 재사용돼도) resume이 아니라 fresh 첫 turn이 된다.
  await adapter.runTurn({ context: null, invocation, session }).promise;
  assert.equal(runs[1].argv.includes("--resume"), false);
});

test("X. AGY forgetSession은 conversation binding/poison 기록을 제거한다", async () => {
  const runs = [];
  const runProcess = (invocation) => {
    runs.push(invocation);
    if (typeof invocation.parseLine === "function") {
      invocation.parseLine(JSON.stringify({ event: "init", conversation_id: "22222222-1111-4111-8111-111111111111" }));
    }
    return { promise: Promise.resolve({ ok: true, text: "answer" }), cancel: () => {} };
  };
  const adapter = new AGYManagedAdapter({ runProcess });
  const session = { key: "k", generation: 1 };
  const invocation = { commandPath: "agy", argv: ["--print"], prompt: "p" };
  await adapter.runTurn({ context: null, invocation, session }).promise;
  assert.equal(adapter._bindings.size, 1);
  adapter.forgetSession(session);
  assert.equal(adapter._bindings.size, 0);
  assert.equal(adapter._invalidatedHandles.size, 0);
  await adapter.runTurn({ context: null, invocation, session }).promise;
  assert.equal(runs[1].argv.includes("--conversation"), false, "forget 후 fresh 첫 turn(--conversation 없음)");
});

// ---- Y/Z/P. Codex: normal retire vs deliberate account reset ----

function makeCodexHarness() {
  const clients = [];
  const adapter = new CodexManagedAdapter({
    createClient: (opts) => {
      const client = {
        state: "new",
        requests: [],
        _threadSeq: 0,
        _turnSeq: 0,
        turnsIssued: [],
        interrupts: [],
        isReady() { return this.state === "ready"; },
        start() { this.state = "ready"; return Promise.resolve(this); },
        request(method, params) {
          this.requests.push({ method, params });
          if (method === "thread/start") return Promise.resolve({ thread: { id: `thr_${clients.length}_${++this._threadSeq}` } });
          if (method === "turn/start") {
            const id = `turn_${++this._turnSeq}`;
            this.turnsIssued.push({ threadId: params.threadId, id });
            return Promise.resolve({ turn: { id, status: "inProgress" } });
          }
          if (method === "turn/interrupt") { this.interrupts.push(params); return Promise.resolve({}); }
          return Promise.resolve({});
        },
        responses: [],
        respond(id, result) { this.responses.push({ id, result }); return true; },
        serverRequest(id, method, params) { this._serverReq(id, method, params); },
        close() {
          if (this.state === "closed") return;
          const prev = this.state;
          this.state = "closed";
          // 실제 client와 동일하게 close 시 onClose를 전달한다(lost 제외).
          if (prev !== "lost") this._onClose({ reason: "closed" });
        },
        emit(method, params) { this._notify(method, params); },
        die(code) { if (this.state === "lost") return; this.state = "lost"; this._onClose({ reason: "lost", code: code || "CODEX_SESSION_LOST" }); },
      };
      client._notify = opts.onNotification;
      client._onClose = opts.onClose;
      client._serverReq = opts.onServerRequest;
      clients.push(client);
      return client;
    },
  });
  return { adapter, clients };
}

const REAL_TMP = fs.realpathSync(os.tmpdir());
const codexCtx = (over = {}) => ({
  projectId: "p", workspaceId: REAL_TMP, professionalRunId: "pr-1", role: "implementation",
  providerId: "codex", modelKey: "gpt-x", permissionMode: "workspace-write", autoApprove: false, ...over,
});
const codexInv = () => ({ commandPath: "codex", needsShell: false, prompt: "작업", cwd: REAL_TMP, requireFinal: true });

async function waitUntil(pred, ms = 1000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 1));
  }
}
const threadStarts = (client) => client.requests.filter((r) => r.method === "thread/start").length;

async function completeCodexTurn(client, index = 0, text = "done") {
  const t = client.turnsIssued[index];
  client.emit("item/completed", { threadId: t.threadId, turnId: t.id, item: { type: "agentMessage", id: "m", text } });
  client.emit("turn/completed", { threadId: t.threadId, turn: { id: t.id, status: "completed" } });
}

test("Y. Codex normal retire: forgetSession은 thread binding만 잊고 resident App Server는 유지한다", async () => {
  const { adapter, clients } = makeCodexHarness();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("codex", adapter);

  const run1 = rt.runTurn({ context: codexCtx({ modelKey: "mA" }), invocation: codexInv() });
  await waitUntil(() => clients.length === 1 && clients[0].turnsIssued.length === 1);
  await completeCodexTurn(clients[0], 0);
  await run1.promise;

  // model 변경 → old sibling RETIRE + forgetSession(thread binding forget).
  const run2 = rt.runTurn({ context: codexCtx({ modelKey: "mB" }), invocation: codexInv() });
  await waitUntil(() => clients[0].turnsIssued.length === 2);
  await completeCodexTurn(clients[0], 1);
  await run2.promise;

  assert.equal(clients.length, 1, "resident App Server는 유지(재시작 없음)");
  assert.equal(threadStarts(clients[0]), 2, "새 lineage는 fresh thread");

  // switch-back: old thread 재사용 금지 — 세 번째 thread/start가 새로 나간다.
  const run3 = rt.runTurn({ context: codexCtx({ modelKey: "mA" }), invocation: codexInv() });
  await waitUntil(() => clients[0].turnsIssued.length === 3);
  const thirdThread = clients[0].turnsIssued[2].threadId;
  assert.notEqual(thirdThread, clients[0].turnsIssued[0].threadId, "old A thread 부활 금지");
  await completeCodexTurn(clients[0], 2);
  await run3.promise;
  assert.equal(clients.length, 1, "normal retire 경로에서 server reset 없음");
});

test("Z/P. Codex account change: parked logical 세션 보존 + deliberate server reset → 같은 namespace의 다음 turn은 fresh server/thread", async () => {
  const { adapter, clients } = makeCodexHarness();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("codex", adapter);

  const run1 = rt.runTurn({ context: codexCtx({ providerAccountKey: "acctA" }), invocation: codexInv() });
  await waitUntil(() => clients.length === 1 && clients[0].turnsIssued.length === 1);
  await completeCodexTurn(clients[0], 0);
  await run1.promise;
  const parked = rt.registry.entries()[0];
  assert.equal(parked.identity.providerAccountKey, "acctA");

  // 계정 A→B: parked A 세션은 파괴되지 않고, resident App Server만 deliberate reset.
  const affected = rt.providerAccountChanged({ providerId: "codex", accountKey: "acctB" });
  assert.equal(affected.length, 0, "parked 세션은 INVALIDATE 대상이 아니다");
  assert.equal(clients[0].state, "closed", "old resident App Server close/reset");
  assert.equal(parked.lifecycle, LIFECYCLE.ACTIVE, "A namespace logical 세션은 parked로 남는다");

  // A로 돌아오면(A→B→A) 같은 logical 세션(같은 key/세대)이 재선택된다. Codex thread는
  // ephemeral(cross-process reattach 미지원)이라 native thread만 fresh로 새로 시작한다.
  const run2 = rt.runTurn({ context: codexCtx({ providerAccountKey: "acctA" }), invocation: codexInv() });
  await waitUntil(() => clients.length === 2 && clients[1].turnsIssued.length === 1);
  assert.equal(threadStarts(clients[1]), 1, "fresh App Server + fresh thread");
  assert.notEqual(clients[1].turnsIssued[0].threadId, clients[0].turnsIssued[0].threadId);
  await completeCodexTurn(clients[1], 0);
  const r2 = await run2.promise;
  assert.equal(r2.ok, true);
  assert.equal(rt.registry.entries().length, 1, "A 복귀는 새 entry가 아니라 parked 세션 재선택이다");
  assert.equal(rt.registry.entries()[0], parked, "같은 logical entry(같은 key/세대)");
  assert.equal(parked.generation, 1, "parked 세션 resume(교체 세대 아님)");
  assert.equal(r2.runMetrics && typeof r2.runMetrics, "object");
});

test("Z2. account change가 inflight Codex turn과 겹치면: interrupt + settle 전 replacement 금지 + settle 후 fresh server", async () => {
  const { adapter, clients } = makeCodexHarness();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("codex", adapter);

  const run1 = rt.runTurn({ context: codexCtx(), invocation: codexInv() });
  await waitUntil(() => clients.length === 1 && clients[0].turnsIssued.length === 1);

  rt.providerAccountChanged({ providerId: "codex" });
  // best-effort cancel(interrupt) 후 server close가 active turn을 fail-closed로 종료한다.
  const r1 = await run1.promise;
  assert.equal(r1.ok, false);

  // old turn settle이 위에서 끝났으므로 fresh 세대가 허용되고 fresh server가 뜬다.
  const run2 = rt.runTurn({ context: codexCtx(), invocation: codexInv() });
  await waitUntil(() => clients.length === 2 && clients[1].turnsIssued.length === 1);
  assert.notEqual(clients[1], clients[0], "다음 turn은 fresh App Server");
  await completeCodexTurn(clients[1], 0);
  const r2 = await run2.promise;
  assert.equal(r2.ok, true);
});

test("Z3. approval pending 중 account change: 승인 UI stale/dismiss + late accept가 old turn을 되살리지 못한다", async () => {
  const { adapter, clients } = makeCodexHarness();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("codex", adapter);

  const approvals = [];
  const invocation = {
    ...codexInv(),
    requestApproval: (req) => new Promise((resolve) => {
      const rec = { req, resolve, aborted: false };
      if (req?.signal) req.signal.addEventListener("abort", () => { rec.aborted = true; }, { once: true });
      approvals.push(rec);
    }),
  };

  const run1 = rt.runTurn({ context: codexCtx(), invocation });
  await waitUntil(() => clients.length === 1 && clients[0].turnsIssued.length === 1);
  const turn = clients[0].turnsIssued[0];
  clients[0].serverRequest("req-1", "item/commandExecution/requestApproval", {
    threadId: turn.threadId, turnId: turn.id, itemId: "c1", command: "rm -rf x",
    commandActions: [{ type: "unknown", command: "rm -rf x" }],
  });
  await waitUntil(() => approvals.length === 1, 500);

  rt.providerAccountChanged({ providerId: "codex" });
  const r1 = await run1.promise;
  assert.equal(r1.ok, false, "old turn은 lifecycle event로 종료");
  assert.equal(approvals[0].aborted, true, "pending 승인 UI는 dismiss(stale)");

  // 늦은 accept: old native turn에 accept가 전송되면 안 된다.
  approvals[0].resolve(true);
  await new Promise((r) => setImmediate(r));
  const accepts = clients[0].responses.filter((res) => res.result && res.result.decision === "accept");
  assert.equal(accepts.length, 0, "late accept가 old turn을 되살리면 안 된다");

  // 새 generation turn은 fresh server/thread에서 시작되고 old approval과 연결되지 않는다.
  const run2 = rt.runTurn({ context: codexCtx(), invocation: codexInv() });
  await waitUntil(() => clients.length === 2 && clients[1].turnsIssued.length === 1);
  assert.equal(clients[1].responses.length, 0);
  await completeCodexTurn(clients[1], 0);
  const r2 = await run2.promise;
  assert.equal(r2.ok, true);
});

test("P2. CODEX_SESSION_LOST(provider failure)는 자동 restart를 만들지 않는다(deliberate reset과 구분)", async () => {
  const { adapter, clients } = makeCodexHarness();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("codex", adapter);

  const run1 = rt.runTurn({ context: codexCtx(), invocation: codexInv() });
  await waitUntil(() => clients.length === 1 && clients[0].turnsIssued.length === 1);
  clients[0].die("CODEX_SESSION_LOST");
  const r1 = await run1.promise;
  assert.equal(r1.ok, false);
  assert.equal(r1.stopReason, "CODEX_SESSION_LOST");

  const r2 = await rt.runTurn({ context: codexCtx(), invocation: codexInv() }).promise;
  assert.equal(r2.ok, false, "잃은 연결은 fail-closed(자동 restart 금지)");
  assert.equal(r2.stopReason, "CODEX_SESSION_LOST");
  assert.equal(clients.length, 1, "새 App Server를 만들지 않는다");
});

// ---- AN. provider 계정 namespace (providerAccountKey selection boundary) ----
//
// 계정 변경은 provider-wide 세션 파괴가 아니라 session-selection boundary다:
//   - A→B→A에서 A의 logical/native 세션은 parked로 보존되고 그대로 resume된다.
//   - A와 B는 logical/native binding을 절대 공유하지 않는다.
//   - 계정 identity가 unresolved면 Professional managed 실행은 fail-closed되고
//     parked 세션은 저장된 채 남는다. 재확립되면 matching namespace만 선택된다.
//   - 다른 lifecycle trigger(workspace/run 종료)는 계정 세션도 정상 종료시킨다.

// resume 요청(--resume/--conversation <id>)은 정확히 그 id를 echo하고, 첫 turn은
// 새 id를 발급하는 fake CLI runner. native 연속성 검증(요청 id === 반환 id)을 통과시킨다.
function makeEchoRunner(flag, kind) {
  const runs = [];
  let seq = 0;
  const runProcess = (invocation) => {
    runs.push(invocation);
    const at = invocation.argv.indexOf(flag);
    const id = at >= 0 ? invocation.argv[at + 1] : `${kind}-${++seq}`;
    if (typeof invocation.parseLine === "function") {
      invocation.parseLine(
        kind === "sid"
          ? JSON.stringify({ type: "system", subtype: "init", session_id: id, tools: [] })
          : JSON.stringify({ event: "init", conversation_id: id })
      );
    }
    return { promise: Promise.resolve({ ok: true, text: "answer" }), cancel: () => {} };
  };
  return { runs, runProcess };
}

test("AN-A. Claude 계정 A→B→A: A의 native session_id로 정확히 resume되고 B와 binding을 공유하지 않는다", async () => {
  const { runs, runProcess } = makeEchoRunner("--resume", "sid");
  const adapter = new ClaudeManagedAdapter({ runProcess });
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", adapter);
  const inv = { commandPath: "claude", argv: ["-p"], prompt: "p" };

  // 계정 A 첫 turn: fresh native session(sid-1) 생성.
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctA" }), invocation: inv }).promise;
  assert.equal(runs[0].argv.includes("--resume"), false);

  // A→B 전환(선택 경계). B의 turn은 별도 logical key라 fresh native 세션이다.
  rt.providerAccountChanged({ providerId: "claude", accountKey: "acctB" });
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB" }), invocation: inv }).promise;
  assert.equal(runs[1].argv.includes("--resume"), false, "B는 A의 native 세션을 이어받지 않는다");

  // B에서 이어지는 turn은 B 자신의 세션(sid-2)만 resume한다.
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB" }), invocation: inv }).promise;
  assert.deepEqual(runs[2].argv.slice(-2), ["--resume", "sid-2"]);

  // B→A 복귀: parked A 세션이 같은 logical key로 재선택되고 정확히 sid-1로 resume된다.
  rt.providerAccountChanged({ providerId: "claude", accountKey: "acctA" });
  const back = await rt.runTurn({ context: ctx({ providerAccountKey: "acctA" }), invocation: inv }).promise;
  assert.equal(back.ok, true);
  assert.deepEqual(runs[3].argv.slice(-2), ["--resume", "sid-1"], "A 복귀는 A의 native session_id resume이다");

  const entries = rt.registry.entries();
  assert.equal(entries.length, 2, "A/B namespace는 각자 하나의 logical 세션이다");
  for (const entry of entries) assert.equal(entry.lifecycle, LIFECYCLE.ACTIVE);
  assert.equal(new Set(entries.map((e) => e.key)).size, 2, "logical binding 공유 금지");
});

test("AN-B. AGY 계정 A→B→A: A의 conversation_id로 정확히 resume된다", async () => {
  const { runs, runProcess } = makeEchoRunner("--conversation", "conv");
  const adapter = new AGYManagedAdapter({ runProcess });
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("agy", adapter);
  const inv = { commandPath: "agy", argv: ["--print"], prompt: "p" };
  const agyCtx = (key) => ctx({ providerId: "agy", providerAccountKey: key });

  await rt.runTurn({ context: agyCtx("acctA"), invocation: inv }).promise;
  assert.equal(runs[0].argv.includes("--conversation"), false);

  rt.providerAccountChanged({ providerId: "agy", accountKey: "acctB" });
  await rt.runTurn({ context: agyCtx("acctB"), invocation: inv }).promise;
  assert.equal(runs[1].argv.includes("--conversation"), false, "B는 A의 conversation을 이어받지 않는다");

  rt.providerAccountChanged({ providerId: "agy", accountKey: "acctA" });
  const back = await rt.runTurn({ context: agyCtx("acctA"), invocation: inv }).promise;
  assert.equal(back.ok, true);
  const at = runs[2].argv.indexOf("--conversation");
  assert.ok(at >= 0, "A 복귀는 resume turn이다");
  assert.equal(runs[2].argv[at + 1], "conv-1", "정확히 A의 conversation_id만 잇는다");
});

test("AN-C. 계정 fact가 unresolved면 managed 실행은 typed fail-closed되고 parked 세션은 보존된다", async () => {
  const { rt, fake } = makeRuntime();
  // 계정 A로 확립된 parked 세션.
  const a = await rt.runTurn({
    context: ctx({ providerAccount: { status: "known", key: "acctA" } }),
    invocation: INV,
  }).promise;
  assert.equal(a.ok, true);
  assert.equal(rt.registry.entries()[0].identity.providerAccountKey, "acctA", "fact.key가 identity로 주입된다");

  // 외부 로그인 진행 등으로 identity가 unresolved인 동안에는 A/B 어느 namespace도
  // 선택하지 않는다.
  for (const fact of [{ status: "unknown" }, { status: "known" }, { status: "known", key: "" }]) {
    const blocked = await rt.runTurn({ context: ctx({ providerAccount: fact }), invocation: INV }).promise;
    assert.equal(blocked.ok, false);
    assert.equal(blocked.stopReason, "HARNESS_PROVIDER_ACCOUNT_UNRESOLVED");
  }
  assert.equal(fake.calls.length, 1, "unresolved 동안 adapter turn이 시작되지 않는다");
  assert.equal(rt.registry.entries().length, 1, "unresolved는 어떤 entry도 만들거나 파괴하지 않는다");
  assert.equal(rt.registry.entries()[0].lifecycle, LIFECYCLE.ACTIVE, "parked 세션은 그대로 저장된다");
  assert.equal(fake.forgets.length, 0, "parked native binding도 보존된다");
});

test("AN-D. identity 재확립은 matching namespace만 선택한다", async () => {
  const { rt, fake } = makeRuntime();
  const known = (key) => ctx({ providerAccount: { status: "known", key } });
  await rt.runTurn({ context: known("acctA"), invocation: INV }).promise;
  const parkedA = rt.registry.entries()[0];

  // unknown window: 선택 불가(위 AN-C), parked 유지.
  const blocked = await rt.runTurn({ context: ctx({ providerAccount: { status: "unknown" } }), invocation: INV }).promise;
  assert.equal(blocked.stopReason, "HARNESS_PROVIDER_ACCOUNT_UNRESOLVED");

  // B로 재확립: B namespace의 첫 세대만 선택된다. A는 여전히 parked.
  const b = await rt.runTurn({ context: known("acctB"), invocation: INV }).promise;
  assert.equal(b.ok, true);
  assert.equal(b.session.generation, 1);
  assert.notEqual(b.session.key, parkedA.key, "재확립된 B는 A namespace를 선택하지 않는다");
  assert.equal(parkedA.lifecycle, LIFECYCLE.ACTIVE);

  // A로 재확립: 정확히 A의 parked 세션이 선택된다(fresh 교체 세대 아님).
  const backA = await rt.runTurn({ context: known("acctA"), invocation: INV }).promise;
  assert.equal(backA.session.key, parkedA.key);
  assert.equal(backA.session.generation, parkedA.generation);
  assert.equal(fake.forgets.length, 0, "전 과정에서 어떤 native binding도 파괴되지 않았다");
});

test("AN-E. 계정 namespace와 무관한 lifecycle trigger는 A/B 세션을 모두 정상 종료시킨다", async () => {
  const { rt, fake } = makeRuntime();
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctA" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB" }), invocation: INV }).promise;

  const affected = rt.workspaceChanged({ projectId: "p1" });
  assert.equal(affected.length, 2, "workspace authority 변경은 계정 namespace를 가리지 않는다");
  for (const entry of affected) {
    assert.equal(entry.lifecycle, LIFECYCLE.RETIRED);
    assert.equal(entry.invalidationReason, "WORKSPACE_CHANGED");
  }
  assert.equal(fake.forgets.length, 2, "계정별 native binding 모두 forget");
});

test("AN-F. run 종료는 parked 다른-계정 세션도 함께 정리한다", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctA" }), invocation: INV }).promise;
  rt.providerAccountChanged({ providerId: "claude", accountKey: "acctB" });
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB" }), invocation: INV }).promise;

  const affected = rt.professionalRunEnded({ professionalRunId: "pr-1" });
  assert.equal(affected.length, 2, "terminal run boundary는 parked A까지 포함한다");
  for (const entry of affected) assert.equal(entry.lifecycle, LIFECYCLE.RETIRED);
});

test("AN-G. lineage sibling retire는 계정 namespace 안에서만 작동한다(B의 model 변경이 parked A를 파괴하지 않는다)", async () => {
  const { rt } = makeRuntime();
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctA", modelKey: "mX" }), invocation: INV }).promise;
  rt.providerAccountChanged({ providerId: "claude", accountKey: "acctB" });

  // B에서 같은 role/run으로 mY → mZ 전환: B의 old sibling만 RETIRE된다.
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB", modelKey: "mY" }), invocation: INV }).promise;
  await rt.runTurn({ context: ctx({ providerAccountKey: "acctB", modelKey: "mZ" }), invocation: INV }).promise;

  const entries = rt.registry.entries();
  const parkedA = entries.find((e) => e.identity.providerAccountKey === "acctA");
  const oldB = entries.find((e) => e.identity.providerAccountKey === "acctB" && e.identity.modelKey === "mY");
  const newB = entries.find((e) => e.identity.providerAccountKey === "acctB" && e.identity.modelKey === "mZ");
  assert.equal(parkedA.lifecycle, LIFECYCLE.ACTIVE, "다른 계정의 parked sibling은 lineage 대상이 아니다");
  assert.equal(oldB.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(oldB.invalidationReason, "MODEL_CHANGED");
  assert.equal(newB.lifecycle, LIFECYCLE.ACTIVE);
});
