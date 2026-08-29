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

// 예전에는 알 수 없는 조합이 빈 배열이었는데, INTERRUPTED 계열이 전부 표에 없어서
// 중단된 실행이 세션을 영구히 잠갔다. 이제 실행을 진전시키는 동작만 fail-closed로
// 막고, 나가는 방향의 동작은 남긴다.
test("알 수 없는 상태 조합은 나가는 동작만 허용한다 (실행 진전은 fail-closed)", () => {
  const allowed = allowedIpcFor({ node: "UNKNOWN", status: "UNKNOWN" });
  assert.ok(allowed.includes("cancel"));
  assert.ok(allowed.includes("send"));
  for (const action of ["startImpl", "startFull", "resume", "planAnswer", "planEdit"]) {
    assert.ok(!allowed.includes(action), `${action}이 열리면 안 됩니다`);
  }
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

test("chat:message:handoff는 SIMPLIFY/SIMPLIFY_SELF를 simplify 액션으로 분류한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  const handoffSection = source.slice(
    source.indexOf("chat:message:handoff"),
    source.indexOf("chat:specialist:blocked")
  );
  assert.ok(
    handoffSection.includes('intent === "SIMPLIFY" || intent === "SIMPLIFY_SELF"'),
    "handoff는 SIMPLIFY와 SIMPLIFY_SELF를 simplify intent로 분류해야 한다"
  );
  const ternary = handoffSection.match(/\? "([a-z-]+)"\s*:\s*"([a-z-]+)"/);
  assert.ok(ternary, "policyAction 분류식이 존재해야 한다");
  assert.equal(ternary[1], "simplify", "SIMPLIFY/SIMPLIFY_SELF는 simplify 액션이어야 한다");
  assert.equal(ternary[2], "handoff", "일반 intent는 handoff 액션이어야 한다");
});

// 전문 실행을 한 번이라도 돌린 세션은 professionalRun이 계속 남는다. 그래서 이 값을
// 게이트 없이 실으면 이후 모든 일반 턴(채팅·토론 종합·토론 기록)이 professional intent로
// 오인되고, role이 없어 SessionKey를 만들 수 없어 harness가 fail-closed한다.
// professionalRunId와 role은 반드시 같은 조건으로 실려야 한다.
test("일반 턴은 professionalRunId를 달고 나가지 않는다", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "chat", "chat-ipc.js"),
    "utf8"
  );
  const runId = source.match(/^\s*professionalRunId: (.+),$/m);
  const role = source.match(/^\s*role: (.+),$/m);
  assert.ok(runId && role, "ExecutionContext에 professionalRunId와 role이 있어야 합니다");
  assert.ok(
    runId[1].startsWith("specialistStage ?"),
    `professionalRunId는 specialistStage로 게이트해야 합니다: ${runId[1]}`
  );
  assert.ok(role[1].startsWith("specialistStage"), `role 게이트가 바뀌었습니다: ${role[1]}`);
});

// role 없이 professionalRunId만 있는 context는 harness에서 반드시 실패한다.
// 위 게이트가 지키려는 대상을 명시적으로 고정해 둔다.
test("role 없는 professionalRunId는 SessionKey를 만들 수 없다", () => {
  const { deriveSessionKey } = require("../src/harness/harness-session-key");
  const base = {
    projectId: "p1",
    workspaceId: "w1",
    providerId: "agy",
    modelKey: "gemini-3.7-flash",
    permissionMode: "chat",
  };
  assert.equal(deriveSessionKey({ ...base, professionalRunId: "PR-1", role: null }), null);
  assert.ok(deriveSessionKey({ ...base, professionalRunId: "PR-1", role: "recorder" }));
});

// INTERRUPT 전이는 어떤 node에서든 status를 INTERRUPTED로 바꾸고, 앱을 실행 도중
// 닫아도 복원 시 INTERRUPTED가 된다. 그 조합이 표에 하나도 없어서 허용 목록이
// 비었고, PLAN을 취소하기만 해도 그 세션에서 다시는 대화·토론·취소를 할 수 없었다.
test("중단된 전문 실행은 일반 대화로 돌아가는 길을 막지 않는다", () => {
  for (const node of ["PLANNING", "PLAN_REVIEW", "READY", "IMPLEMENTING", "REVIEWING", "RECORDING"]) {
    const state = { node, status: "INTERRUPTED" };
    for (const action of ["send", "discussion", "handoff", "simplify", "cancel"]) {
      assert.ok(isStateAllowed(state, action), `${node}:INTERRUPTED에서 ${action}이 막혔습니다`);
    }
  }
});

// 탈출구를 열어도 실행을 진전시키는 동작은 여전히 allowlist에만 있어야 한다.
test("표에 없는 상태에서도 실행을 진전시키는 동작은 열리지 않는다", () => {
  const state = { node: "PLANNING", status: "INTERRUPTED" };
  for (const action of ["startImpl", "startFull", "resume", "planAnswer", "planEdit", "continueReview", "retryRecorder"]) {
    assert.equal(isStateAllowed(state, action), false, `${action}이 열리면 안 됩니다`);
  }
});

// turn이 실제로 떠 있는 동안에는 끼어들지 못하게 취소만 남긴다.
test("표에 없는 RUNNING 상태는 취소만 허용한다", () => {
  const state = { node: "NEW_NODE", status: "RUNNING" };
  assert.deepEqual(allowedIpcFor(state), ["cancel"]);
  assert.equal(isStateAllowed(state, "send"), false);
});

// 기존 표의 차단은 그대로여야 한다(fallback이 표를 덮어쓰면 안 된다).
test("표에 있는 상태의 차단은 fallback이 덮어쓰지 않는다", () => {
  assert.equal(isStateAllowed({ node: "PLANNING", status: "RUNNING" }, "send"), false);
  assert.equal(isStateAllowed({ node: "PLANNING", status: "WAITING" }, "discussion"), false);
  assert.equal(isStateAllowed({ node: "IMPLEMENTING", status: "RUNNING" }, "handoff"), false);
});
