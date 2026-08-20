"use strict";

// Stage D-0 — Workspace Mutation Lease core semantics.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md D-0):
//   - 같은 canonical workspace에는 writer가 최대 하나(one-writer).
//   - 충돌은 fail-closed(BUSY)다 — 대기열도 강탈도 없다.
//   - 같은 holder는 재진입 가능(전문 실행 중 checkpoint restore가 교착되면 안 됨).
//   - canonical identity 정규화(후행 구분자/상대 경로/win32 대소문자)로 우회 불가.
//   - resourceKind는 workspace만 지원하고 나머지는 fail-closed로 거부.
//   - 비정상 종료 정리(releaseAllFor)와 token 오사용 안전성.
//   - 결정 시점 provenance event 방출(D-C가 나중에 읽는 seam).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  WorkspaceMutationLease,
  LEASE_ERRORS,
  LEASE_EVENTS,
  normalizeResourceId,
} = require("../src/agora/workspace-mutation-lease");

const WS = path.resolve("/ws/alpha");
const OTHER_WS = path.resolve("/ws/beta");

function lease(onEvent = null) {
  let t = 0;
  return new WorkspaceMutationLease({ now: () => (t += 1), onEvent });
}

test("첫 acquire는 성공하고 holder를 기록한다", () => {
  const l = lease();
  const got = l.acquire({
    resourceId: WS,
    holderId: "session-a",
    runId: "RUN-1",
    role: "implementation",
    purpose: "professional-mutation",
  });
  assert.equal(got.ok, true);
  assert.equal(got.reentered, false);
  assert.equal(got.lease.holderId, "session-a");
  assert.equal(got.lease.runId, "RUN-1");
  assert.equal(got.lease.role, "implementation");
  assert.equal(got.lease.depth, 1);
  assert.equal(l.isHeld(WS), true);
});

test("다른 holder는 같은 workspace를 얻지 못한다 (fail-closed BUSY)", () => {
  const l = lease();
  l.acquire({ resourceId: WS, holderId: "session-a", runId: "RUN-1" });
  const denied = l.acquire({ resourceId: WS, holderId: "session-b" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, LEASE_ERRORS.BUSY);
  // 누가 쥐고 있는지 알려주되, 대기열에 넣거나 빼앗지 않는다.
  assert.equal(denied.holder.holderId, "session-a");
  assert.equal(denied.holder.runId, "RUN-1");
  assert.equal(l.holderOf(WS).holderId, "session-a");
});

test("다른 workspace는 서로 막지 않는다", () => {
  const l = lease();
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-a" }).ok, true);
  assert.equal(l.acquire({ resourceId: OTHER_WS, holderId: "session-b" }).ok, true);
});

test("같은 holder는 재진입할 수 있고 depth가 쌓인다", () => {
  const l = lease();
  const outer = l.acquire({ resourceId: WS, holderId: "session-a", purpose: "professional-mutation" });
  const inner = l.acquire({ resourceId: WS, holderId: "session-a", purpose: "checkpoint-restore" });
  assert.equal(inner.ok, true);
  assert.equal(inner.reentered, true);
  assert.equal(l.holderOf(WS).depth, 2);

  // 안쪽만 놓으면 아직 소유권이 유지되어야 한다.
  l.release(inner.token);
  assert.equal(l.isHeld(WS), true);
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-b" }).code, LEASE_ERRORS.BUSY);

  // 바깥까지 놓아야 해제된다.
  l.release(outer.token);
  assert.equal(l.isHeld(WS), false);
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-b" }).ok, true);
});

test("해제 후에는 다른 holder가 얻을 수 있다", () => {
  const l = lease();
  const a = l.acquire({ resourceId: WS, holderId: "session-a" });
  l.release(a.token);
  const b = l.acquire({ resourceId: WS, holderId: "session-b" });
  assert.equal(b.ok, true);
  assert.equal(b.lease.holderId, "session-b");
});

test("같은 경로의 다른 표기로 lease를 우회할 수 없다", () => {
  const l = lease();
  l.acquire({ resourceId: WS, holderId: "session-a" });
  const variants = [`${WS}${path.sep}`, path.join(WS, "sub", ".."), path.join(WS, ".")];
  for (const variant of variants) {
    const denied = l.acquire({ resourceId: variant, holderId: "session-b" });
    assert.equal(denied.code, LEASE_ERRORS.BUSY, `우회 가능: ${variant}`);
  }
});

test("win32에서는 대소문자가 달라도 같은 workspace로 본다", (t) => {
  if (process.platform !== "win32") {
    t.skip("win32 전용 대소문자 정규화");
    return;
  }
  const l = lease();
  l.acquire({ resourceId: "D:\\Projects\\Agora", holderId: "session-a" });
  const denied = l.acquire({ resourceId: "d:\\projects\\agora", holderId: "session-b" });
  assert.equal(denied.code, LEASE_ERRORS.BUSY);
});

test("workspace 외의 resourceKind는 거부한다 (범용 Resource Registry는 D-B 범위)", () => {
  const l = lease();
  const got = l.acquire({ resourceKind: "database", resourceId: "db://x", holderId: "session-a" });
  assert.equal(got.ok, false);
  assert.equal(got.code, LEASE_ERRORS.UNSUPPORTED_RESOURCE_KIND);
  assert.equal(l.list().length, 0);
});

test("resourceId나 holderId가 없으면 조용히 통과시키지 않는다", () => {
  const l = lease();
  assert.equal(l.acquire({ resourceId: "", holderId: "session-a" }).code, LEASE_ERRORS.INVALID_RESOURCE);
  assert.equal(l.acquire({ resourceId: null, holderId: "session-a" }).code, LEASE_ERRORS.INVALID_RESOURCE);
  assert.equal(l.acquire({ resourceId: WS, holderId: "" }).code, LEASE_ERRORS.INVALID_HOLDER);
  assert.equal(l.acquire({ resourceId: WS, holderId: null }).code, LEASE_ERRORS.INVALID_HOLDER);
  assert.equal(l.isHeld(WS), false);
});

test("release는 알 수 없는 token이나 중복 호출에 안전하다", () => {
  const l = lease();
  const a = l.acquire({ resourceId: WS, holderId: "session-a" });
  assert.equal(l.release("없는-token"), false);
  assert.equal(l.release(""), false);
  assert.equal(l.release(null), false);
  assert.equal(l.isHeld(WS), true);

  assert.equal(l.release(a.token), true);
  // 두 번째 release가 다른 holder의 새 lease를 해제하면 안 된다.
  const b = l.acquire({ resourceId: WS, holderId: "session-b" });
  assert.equal(l.release(a.token), false);
  assert.equal(l.holderOf(WS).holderId, "session-b");
  assert.equal(l.holderOf(WS).leaseId, b.lease.leaseId);
});

test("releaseAllFor는 depth와 무관하게 해당 holder의 lease를 정리한다", () => {
  const l = lease();
  l.acquire({ resourceId: WS, holderId: "session-a" });
  l.acquire({ resourceId: WS, holderId: "session-a" });
  l.acquire({ resourceId: OTHER_WS, holderId: "session-a" });
  l.acquire({ resourceId: path.resolve("/ws/gamma"), holderId: "session-b" });

  assert.equal(l.releaseAllFor("session-a"), 2);
  assert.equal(l.isHeld(WS), false);
  assert.equal(l.isHeld(OTHER_WS), false);
  // 다른 holder의 lease는 건드리지 않는다.
  assert.equal(l.isHeld(path.resolve("/ws/gamma")), true);
  // 강제 정리 후 새 holder가 정상적으로 얻을 수 있다.
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-c" }).ok, true);
});

test("강제 정리된 lease의 잔여 token은 새 lease를 해제하지 못한다", () => {
  const l = lease();
  const stale = l.acquire({ resourceId: WS, holderId: "session-a" });
  l.releaseAllFor("session-a");
  const fresh = l.acquire({ resourceId: WS, holderId: "session-b" });
  assert.equal(l.release(stale.token), false);
  assert.equal(l.holderOf(WS).leaseId, fresh.lease.leaseId);
});

test("결정 시점에 provenance event를 남긴다", () => {
  const events = [];
  const l = lease((event) => events.push(event));
  const a = l.acquire({ resourceId: WS, holderId: "session-a", runId: "RUN-1", role: "implementation" });
  const nested = l.acquire({ resourceId: WS, holderId: "session-a", purpose: "checkpoint-restore" });
  l.acquire({ resourceId: WS, holderId: "session-b" });
  l.release(nested.token);
  l.release(a.token);

  assert.deepEqual(
    events.map((event) => event.type),
    [
      LEASE_EVENTS.ACQUIRED,
      LEASE_EVENTS.REENTERED,
      LEASE_EVENTS.DENIED,
      // 재진입 해제는 소유권 변화가 아니므로 released를 만들지 않는다.
      LEASE_EVENTS.RELEASED,
    ]
  );
  assert.equal(events[0].runId, "RUN-1");
  assert.equal(events[2].holderId, "session-b");
  assert.equal(events[2].heldBy.holderId, "session-a");
  assert.ok(events.every((event) => Number.isFinite(event.at)));
});

test("provenance 기록 실패가 mutation 통제를 무너뜨리지 않는다", () => {
  const l = lease(() => {
    throw new Error("provenance sink down");
  });
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-a" }).ok, true);
  assert.equal(l.acquire({ resourceId: WS, holderId: "session-b" }).code, LEASE_ERRORS.BUSY);
});

test("normalizeResourceId는 workspace가 아닌 kind의 값을 경로로 재해석하지 않는다", () => {
  assert.equal(normalizeResourceId("workspace", WS), process.platform === "win32" ? WS.toLowerCase() : WS);
  assert.equal(normalizeResourceId("database", "db://x"), "db://x");
  assert.equal(normalizeResourceId("workspace", "   "), null);
});
