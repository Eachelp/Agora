"use strict";

// Stage C-2 STEP 2 — memory-only registry semantics.

const test = require("node:test");
const assert = require("node:assert/strict");

const { HarnessSessionRegistry, LIFECYCLE } = require("../src/harness/harness-session-registry");

function reg() {
  let t = 0;
  return new HarnessSessionRegistry({ now: () => (t += 1) });
}

test("동일 key는 같은 active entry를 재사용한다", () => {
  const r = reg();
  const a = r.acquire("k", { adapterId: "fake" });
  const b = r.acquire("k");
  assert.equal(a, b);
  assert.equal(a.lifecycle, LIFECYCLE.ACTIVE);
  assert.equal(a.generation, 1);
  assert.equal(r.size(), 1);
});

test("다른 key는 격리된다", () => {
  const r = reg();
  assert.notEqual(r.acquire("k1"), r.acquire("k2"));
  assert.equal(r.size(), 2);
});

test("invalidated entry는 재사용되지 않고 새 세대로 대체된다", () => {
  const r = reg();
  const a = r.acquire("k");
  r.invalidate("k", "WORKSPACE_CHANGED");
  assert.equal(a.lifecycle, LIFECYCLE.INVALIDATED);
  assert.equal(a.invalidationReason, "WORKSPACE_CHANGED");
  const b = r.acquire("k");
  assert.notEqual(b, a);
  assert.equal(b.lifecycle, LIFECYCLE.ACTIVE);
  assert.equal(b.generation, 2);
});

test("retired entry도 재사용되지 않는다", () => {
  const r = reg();
  const a = r.acquire("k");
  r.retire("k", "RUN_COMPLETED");
  assert.equal(a.lifecycle, LIFECYCLE.RETIRED);
  const b = r.acquire("k");
  assert.notEqual(b, a);
  assert.equal(b.generation, 2);
});

test("single-flight: 같은 세션에 동시 turn을 막고, 끝나면 다시 허용한다", () => {
  const r = reg();
  const e = r.acquire("k");
  assert.equal(r.tryBeginTurn(e), true);
  assert.equal(r.tryBeginTurn(e), false); // 이미 inflight
  r.endTurn(e);
  assert.equal(r.tryBeginTurn(e), true);
});

test("종료 상태 entry는 tryBeginTurn이 실패한다", () => {
  const r = reg();
  const e = r.acquire("k");
  r.invalidate("k");
  assert.equal(r.tryBeginTurn(e), false);
});

test("없는 key에 대한 invalidate/retire는 null이며 안전하다", () => {
  const r = reg();
  assert.equal(r.invalidate("nope"), null);
  assert.equal(r.retire("nope"), null);
  assert.equal(r.get("nope"), null);
});
