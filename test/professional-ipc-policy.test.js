"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  allowedIpcFor,
  isActiveProfessionalRun,
  isStateAllowed,
} = require("../src/chat/professional-ipc-policy");

test("READY 상태에서는 startImpl·startFull·planEdit·cancel만 허용한다 (recordOnly-send 제외)", () => {
  const allowed = allowedIpcFor({ node: "READY", status: "WAITING" });
  assert.ok(allowed.includes("startImpl"));
  assert.ok(allowed.includes("startFull"));
  assert.ok(allowed.includes("planEdit"));
  assert.ok(allowed.includes("cancel"));
  assert.ok(!allowed.includes("recordOnly-send"));
  assert.ok(!allowed.includes("send"));
  assert.ok(!allowed.includes("discussion"));
});

test("PLANNING WAITING 및 PLAN_REVIEW WAITING에서도 recordOnly-send는 제외된다", () => {
  const planningAllowed = allowedIpcFor({ node: "PLANNING", status: "WAITING" });
  assert.deepEqual(planningAllowed, ["planAnswer", "cancel"]);
  const reviewAllowed = allowedIpcFor({ node: "PLAN_REVIEW", status: "WAITING" });
  assert.deepEqual(reviewAllowed, ["planAnswer", "cancel"]);
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

test("isActiveProfessionalRun은 COMPLETED/COMPLETED만 비활성으로 보고 나머지는 활성(fail-closed)으로 식별한다", () => {
  assert.equal(isActiveProfessionalRun({ node: "IMPLEMENTING", status: "RUNNING" }), true);
  assert.equal(isActiveProfessionalRun({ node: "COMPLETED", status: "COMPLETED" }), false);
  assert.equal(isActiveProfessionalRun(null), false);

  // 일관되지 않은 상태 조합도 모두 활성으로 판단(fail-closed)
  assert.equal(isActiveProfessionalRun({ node: "COMPLETED", status: "WAITING" }), true);
  assert.equal(isActiveProfessionalRun({ node: "READY", status: "COMPLETED" }), true);
  assert.equal(isActiveProfessionalRun({ node: "UNKNOWN", status: "UNKNOWN" }), true);
});

test("isStateAllowed는 활성 실행 없으면 모든 액션을 허용한다", () => {
  assert.equal(isStateAllowed(null, "send"), true);
  assert.equal(isStateAllowed({ node: "COMPLETED", status: "COMPLETED" }, "send"), true);
});

test("isStateAllowed는 활성 실행 중 정책에 없는 액션을 거부한다", () => {
  assert.equal(isStateAllowed({ node: "IMPLEMENTING", status: "RUNNING" }, "send"), false);
  assert.equal(isStateAllowed({ node: "IMPLEMENTING", status: "RUNNING" }, "cancel"), true);
});

// 정책 테이블이 "존재만 하고 아무도 안 쓰는" 상태로 되돌아가지 않도록,
// chat-ipc가 실제 runtime authority로 이 모듈을 사용하는지 검증한다.
test("chat-ipc는 정책 모듈을 실제 runtime authority로 사용한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  assert.match(source, /require\("\.\/professional-ipc-policy"\)/, "정책 모듈을 import 해야 한다");
  assert.match(source, /function enforceProfessionalPolicy/, "정책 게이트 헬퍼가 있어야 한다");

  // 사용자 입력이 들어오는 4개 경계가 모두 정책 게이트를 통과해야 한다.
  for (const action of ["send", "recordOnly-send", "interject", "discussion", "handoff", "simplify"]) {
    assert.ok(
      source.includes(`"${action}"`),
      `${action} 액션이 chat-ipc 게이트에서 사용되어야 한다`
    );
  }
  const gateCalls = source.match(/enforceProfessionalPolicy\(/g) || [];
  assert.ok(gateCalls.length >= 5, `정책 게이트 호출이 충분해야 한다(실제: ${gateCalls.length})`);
});
