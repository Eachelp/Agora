"use strict";

// Stage C-2 STEP 3 — HarnessRuntime: adapter selection + role-scoped session lifecycle.
// persistent semantics는 테스트용 fake adapter로만 검증한다(production엔 persistent 없음).

const test = require("node:test");
const assert = require("node:assert/strict");

const { HarnessRuntime } = require("../src/harness/harness-runtime");
const { HarnessAdapter } = require("../src/harness/harness-adapter");

class FakePersistentAdapter extends HarnessAdapter {
  constructor() {
    super({ id: "fake-persistent", supportsPersistentSession: true });
    this.calls = [];
    this._pending = false;
  }
  runTurn({ context, invocation, session }) {
    this.calls.push({ context, invocation, session });
    if (this._pending) {
      return { promise: new Promise(() => {}), cancel: () => {} };
    }
    return { promise: Promise.resolve({ ok: true, session }), cancel: () => {} };
  }
}

// context/invocation을 기록만 하는 sessionless process adapter 대역.
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
    ...over,
  };
}
const INV = { commandPath: "node", argv: [], prompt: "" };

test("persistent adapter가 없으면 sessionless로 실행하고 registry를 만들지 않는다", async () => {
  const spy = spyProcessAdapter();
  const rt = new HarnessRuntime({ processAdapter: spy });
  const run = rt.runTurn({ context: ctx(), invocation: INV });
  const res = await run.promise;
  assert.equal(res.tag, "process");
  assert.equal(rt.registry.size(), 0);
  assert.equal(spy.calls.length, 1);
  // sessionless 경로는 { context, invocation }을 그대로 넘긴다.
  assert.equal(spy.calls[0].invocation, INV);
});

test("등록된 persistent adapter는 role-scoped session을 만든다", async () => {
  const spy = spyProcessAdapter();
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spy });
  rt.register("claude", fake);
  const run = rt.runTurn({ context: ctx(), invocation: INV });
  const res = await run.promise;
  assert.equal(res.ok, true);
  assert.equal(rt.registry.size(), 1);
  assert.equal(spy.calls.length, 0);
  assert.ok(res.session.key.startsWith("hsk1:"));
});

test("persistent provider의 Professional identity가 불완전하면 one-shot으로 우회하지 않고 fail-closed한다", async () => {
  const spy = spyProcessAdapter();
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spy });
  rt.register("claude", fake);

  const res = await rt.runTurn({ context: ctx({ workspaceId: null }), invocation: INV }).promise;

  assert.equal(res.ok, false);
  assert.equal(res.stopReason, "HARNESS_SESSION_IDENTITY_INVALID");
  assert.equal(spy.calls.length, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(rt.registry.size(), 0);
});

test("persistent-capable provider여도 general chat은 의도적으로 sessionless one-shot이다", async () => {
  const spy = spyProcessAdapter();
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spy });
  rt.register("claude", fake);

  const res = await rt.runTurn({
    context: ctx({ professionalRunId: null, role: null }),
    invocation: INV,
  }).promise;

  assert.equal(res.tag, "process");
  assert.equal(spy.calls.length, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(rt.registry.size(), 0);
});

test("transport runId가 frozenRunId로 잘못 들어오면 persistent adapter에 전달하지 않는다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);

  const res = await rt.runTurn({
    context: ctx({ provenance: { frozenRunId: "rsession-12" } }),
    invocation: INV,
  }).promise;

  assert.equal(res.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(Object.hasOwn(fake.calls[0].context.provenance, "frozenRunId"), false);
});

test("canonical Frozen Task RUN-### provenance는 persistent adapter에 그대로 전달한다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);

  const res = await rt.runTurn({
    context: ctx({ provenance: { frozenRunId: "RUN-007" } }),
    invocation: INV,
  }).promise;

  assert.equal(res.ok, true);
  assert.equal(fake.calls[0].context.provenance.frozenRunId, "RUN-007");
});

test("role이 다르면 다른 session이다(Builder ≠ Reviewer)", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx({ role: "implementation" }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ role: "review" }), invocation: INV }).promise;
  assert.notEqual(a.session.key, b.session.key);
  assert.equal(rt.registry.size(), 2);
});

test("동일 identity는 같은 logical session(같은 generation)을 재사용한다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(a.session.key, b.session.key);
  assert.equal(a.session.generation, b.session.generation);
  assert.equal(rt.registry.size(), 1);
});

test("professionalRunId가 다르면 이전 run session을 재사용하지 않는다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx({ professionalRunId: "pr-1" }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ professionalRunId: "pr-2" }), invocation: INV }).promise;
  assert.notEqual(a.session.key, b.session.key);
});

test("permissionMode가 다르면 session을 재사용하지 않는다(security scope)", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx({ permissionMode: "workspace-write" }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ permissionMode: "workspace-read" }), invocation: INV }).promise;
  assert.notEqual(a.session.key, b.session.key);
});

test("workspaceId(realpath identity)가 다르면 session을 재사용하지 않는다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx({ workspaceId: "/ws/a" }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ workspaceId: "/ws/b" }), invocation: INV }).promise;
  assert.notEqual(a.session.key, b.session.key);
});

test("modelKey가 다르면 session을 재사용하지 않는다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx({ modelKey: "m1" }), invocation: INV }).promise;
  const b = await rt.runTurn({ context: ctx({ modelKey: "m2" }), invocation: INV }).promise;
  assert.notEqual(a.session.key, b.session.key);
});

test("model이 미해결/default이면 persistent session을 만들지 않는다(sessionless)", async () => {
  const spy = spyProcessAdapter();
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spy });
  rt.register("claude", fake);
  const res = await rt.runTurn({ context: ctx({ modelKey: "default" }), invocation: INV }).promise;
  assert.equal(res.tag, "process");
  assert.equal(rt.registry.size(), 0);
  assert.equal(fake.calls.length, 0);
});

test("invalidated session은 재사용되지 않고 새 세대로 재생성된다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  rt.registry.invalidate(a.session.key, "WORKSPACE_CHANGED");
  const b = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(a.session.key, b.session.key);
  assert.equal(b.session.generation, a.session.generation + 1);
});

test("같은 logical session에 동시 turn을 막는다(SESSION_BUSY)", async () => {
  const fake = new FakePersistentAdapter();
  fake._pending = true; // 첫 turn이 끝나지 않게 한다
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const first = rt.runTurn({ context: ctx(), invocation: INV }); // inflight 유지
  const second = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(second.ok, false);
  assert.equal(second.stopReason, "SESSION_BUSY");
  assert.ok(typeof first.cancel === "function");
});

test("turn이 끝나면 single-flight가 풀려 재실행된다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  const again = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(again.ok, true);
  assert.equal(again.stopReason, undefined);
});

test("invocation이 없으면 fail-closed로 던진다", () => {
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  assert.throws(() => rt.runTurn({ context: ctx() }), /invocation이 필요/);
});

// ---- Fix 1 regression: pre-mutation boundary ordering ----

test("providerAccountChanged는 모든 ACTIVE entry를 INVALIDATE하고 settle barrier에 등록한다", async () => {
  const fake = new FakePersistentAdapter();
  fake._pending = true;
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  rt.runTurn({ context: ctx(), invocation: INV });
  const affected = rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].lifecycle, "invalidated");
  assert.equal(affected[0].invalidationReason, "PROVIDER_ACCOUNT_CHANGED");
  const busy = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(busy.ok, false);
  assert.equal(busy.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");
});

test("providerAccountChanged 후 settle되면 fresh session(새 generation)을 만든다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const a = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  rt.providerAccountChanged({ providerId: "claude" });
  const b = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(b.ok, true);
  assert.equal(b.session.key, a.session.key);
  assert.equal(b.session.generation, a.session.generation + 1);
});

test("A→B→A 계정 순환은 항상 fresh session이다(resume 금지)", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  const gen1 = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  rt.providerAccountChanged({ providerId: "claude" });
  const gen2 = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(gen2.session.generation, gen1.session.generation + 1);
  rt.providerAccountChanged({ providerId: "claude" });
  const gen3 = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(gen3.session.generation, gen2.session.generation + 1);
});

// ---- Fix 2 regression: settle barrier covers non-ACTIVE inflight ----

test("이미 RETIRED된 inflight entry도 settle barrier에 포함된다", async () => {
  const fake = new FakePersistentAdapter();
  fake._pending = true;
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  rt.runTurn({ context: ctx(), invocation: INV });
  rt.registry.retire(rt.registry.get(rt.registry.entries()[0].key).key, "WORKSPACE_CHANGED");
  const entry = rt.registry.entries()[0];
  assert.equal(entry.lifecycle, "retired");
  assert.equal(entry.inflight, true);
  rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(entry.invalidationReason, "WORKSPACE_CHANGED", "기존 retire reason 보존");
  const busy = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(busy.ok, false);
  assert.equal(busy.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");
});

test("이미 INVALIDATED된 inflight entry도 settle barrier에 포함된다", async () => {
  const fake = new FakePersistentAdapter();
  fake._pending = true;
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  rt.runTurn({ context: ctx(), invocation: INV });
  rt.registry.invalidate(rt.registry.entries()[0].key, "WORKSPACE_RESTORED");
  const entry = rt.registry.entries()[0];
  assert.equal(entry.lifecycle, "invalidated");
  assert.equal(entry.inflight, true);
  rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(entry.invalidationReason, "WORKSPACE_RESTORED", "기존 invalidate reason 보존");
  const busy = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(busy.ok, false);
  assert.equal(busy.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");
});

test("비-inflight 종료 entry는 settle barrier에 포함되지 않는다", async () => {
  const fake = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  rt.registry.retire(rt.registry.entries()[0].key, "WORKSPACE_CHANGED");
  rt.providerAccountChanged({ providerId: "claude" });
  const res = await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  assert.equal(res.ok, true, "비-inflight 종료 entry는 barrier를 만들지 않는다");
});

test("다른 provider의 inflight entry는 계정 경계에 영향받지 않는다", async () => {
  const fake1 = new FakePersistentAdapter();
  fake1._pending = true;
  const fake2 = new FakePersistentAdapter();
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake1);
  rt.register("codex", fake2);
  rt.runTurn({ context: ctx({ providerId: "claude" }), invocation: INV });
  rt.providerAccountChanged({ providerId: "codex" });
  const codexRun = await rt.runTurn({
    context: ctx({ providerId: "codex", modelKey: "codex-m" }),
    invocation: INV,
  }).promise;
  assert.equal(codexRun.ok, true, "codex barrier는 claude inflight에 영향 없다");
});

test("providerAccountChanged는 adapter.resetRuntime을 호출한다", async () => {
  const fake = new FakePersistentAdapter();
  let resetReason = null;
  fake.resetRuntime = (reason) => { resetReason = reason; };
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  await rt.runTurn({ context: ctx(), invocation: INV }).promise;
  rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(resetReason, "PROVIDER_ACCOUNT_CHANGED");
});

test("providerAccountChanged는 inflight turn을 best-effort cancel한다", async () => {
  const fake = new FakePersistentAdapter();
  fake._pending = true;
  let cancelled = false;
  const originalRunTurn = fake.runTurn.bind(fake);
  fake.runTurn = (req) => {
    const run = originalRunTurn(req);
    return { promise: run.promise, cancel: () => { cancelled = true; } };
  };
  const rt = new HarnessRuntime({ processAdapter: spyProcessAdapter() });
  rt.register("claude", fake);
  rt.runTurn({ context: ctx(), invocation: INV });
  rt.providerAccountChanged({ providerId: "claude" });
  assert.equal(cancelled, true, "inflight turn이 cancel되어야 한다");
});
