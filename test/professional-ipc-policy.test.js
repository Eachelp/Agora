"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  allowedIpcFor,
  isActiveProfessionalRun,
  isStateAllowed,
} = require("../src/chat/professional-ipc-policy");

test("READY 상태에서는 startImpl·planEdit·cancel·recordOnly-send만 허용한다", () => {
  const allowed = allowedIpcFor({ node: "READY", status: "WAITING" });
  assert.ok(allowed.includes("startImpl"));
  assert.ok(allowed.includes("planEdit"));
  assert.ok(allowed.includes("cancel"));
  assert.ok(allowed.includes("recordOnly-send"));
  assert.ok(!allowed.includes("send"));
  assert.ok(!allowed.includes("discussion"));
});

test("IMPLEMENTING RUNNING에서는 cancel만 허용한다", () => {
  const allowed = allowedIpcFor({ node: "IMPLEMENTING", status: "RUNNING" });
  assert.deepEqual(allowed, ["cancel"]);
});

test("COMPLETED에서는 send·discussion·handoff·simplify 등이 허용된다", () => {
  const allowed = allowedIpcFor({ node: "COMPLETED", status: "COMPLETED" });
  assert.ok(allowed.includes("send"));
  assert.ok(allowed.includes("discussion"));
  assert.ok(allowed.includes("simplify"));
});

test("알 수 없는 상태 조합은 빈 배열을 반환한다 (fail-closed)", () => {
  const allowed = allowedIpcFor({ node: "UNKNOWN", status: "UNKNOWN" });
  assert.deepEqual(allowed, []);
});

test("isActiveProfessionalRun은 COMPLETED가 아닌 활성 실행을 식별한다", () => {
  assert.equal(isActiveProfessionalRun({ node: "IMPLEMENTING", status: "RUNNING" }), true);
  assert.equal(isActiveProfessionalRun({ node: "COMPLETED", status: "COMPLETED" }), false);
  assert.equal(isActiveProfessionalRun(null), false);
});

test("isStateAllowed는 활성 실행 없으면 모든 액션을 허용한다", () => {
  assert.equal(isStateAllowed(null, "send"), true);
  assert.equal(isStateAllowed({ node: "COMPLETED", status: "COMPLETED" }, "send"), true);
});

test("isStateAllowed는 활성 실행 중 정책에 없는 액션을 거부한다", () => {
  assert.equal(isStateAllowed({ node: "IMPLEMENTING", status: "RUNNING" }, "send"), false);
  assert.equal(isStateAllowed({ node: "IMPLEMENTING", status: "RUNNING" }, "cancel"), true);
});
