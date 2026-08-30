"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INTERACTION_TARGETS,
  INTERACTION_INTENTS,
  EXECUTION_POLICIES,
  normalizeInteraction,
  HANDOFF_ROLES,
  HANDOFF_TRANSITIONS,
  isHandoffAllowed,
  resolveReviewerContract,
  DEFAULT_HANDOFF_BUDGET,
  createHandoffLedger,
  validateHandoff,
  consumeHandoff,
  settleHandoff,
  parseHandoffRequest,
} = require("../src/agora/interaction-contract");

test("normalizeInteraction: metadata 없는 입력은 CONSULT/SINGLE/NONE 기본값", () => {
  assert.deepEqual(normalizeInteraction(), {
    target: null,
    intent: "CONSULT",
    scope: "SINGLE",
    executionPolicy: "NONE",
  });
  assert.deepEqual(normalizeInteraction({ target: "builder" }), {
    target: "builder",
    intent: "CONSULT",
    scope: "SINGLE",
    executionPolicy: "NONE",
  });
});

test("normalizeInteraction: 미지 값은 안전 기본값으로 강등된다", () => {
  const result = normalizeInteraction({
    target: "ceo",
    intent: "DEPLOY",
    scope: "FLEET",
    executionPolicy: "YOLO",
  });
  assert.equal(result.target, null);
  assert.equal(result.intent, "CONSULT");
  assert.equal(result.scope, "SINGLE");
  assert.equal(result.executionPolicy, "NONE");
});

test("normalizeInteraction: 유효한 값은 대문자로 정규화되어 보존된다", () => {
  const result = normalizeInteraction({
    target: "planner",
    intent: "execute",
    scope: "team",
    executionPolicy: "stop_at_ready",
  });
  assert.equal(result.intent, "EXECUTE");
  assert.equal(result.scope, "TEAM");
  assert.equal(result.executionPolicy, "STOP_AT_READY");
});

test("어휘 상수는 제안서 §6.1의 집합과 일치한다", () => {
  assert.deepEqual([...INTERACTION_TARGETS], ["planner", "builder", "reviewer", "recorder", "all"]);
  assert.deepEqual([...INTERACTION_INTENTS], ["CONSULT", "PLAN", "REVIEW", "EXECUTE", "SUMMARIZE"]);
  assert.deepEqual(
    [...EXECUTION_POLICIES],
    ["NONE", "STOP_AT_READY", "EXECUTE_READY", "PREAUTHORIZED_BOUNDED"],
  );
});

test("Handoff 전이표: 제안서 §8.2의 허용 전이만 통과한다", () => {
  const allowed = [
    ["planner", "plan_review"],
    ["planner", "user"],
    ["plan_review", "planner"],
    ["plan_review", "ready"],
    ["ready", "builder"],
    ["builder", "review"],
    ["builder", "planner"],
    ["builder", "user"],
    ["review", "builder"],
    ["review", "complete"],
    ["review", "user"],
    ["complete", "archivist"],
    ["archivist", "user"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(isHandoffAllowed(from, to), true, `${from} -> ${to}`);
  }
  // 표에 있는 전이 수와 위 목록이 일치하면 표에 몰래 늘어난 전이가 없다.
  const tableSize = Object.values(HANDOFF_TRANSITIONS).reduce((sum, list) => sum + list.length, 0);
  assert.equal(tableSize, allowed.length);
});

test("Handoff 전이표: 금지 전이는 전부 거부된다", () => {
  // 제안서 §8.2 하단의 명시적 금지 목록.
  assert.equal(isHandoffAllowed("review", "review"), false, "Reviewer 자기 재호출");
  assert.equal(isHandoffAllowed("recorder", "builder"), false, "Recorder의 Builder 호출");
  assert.equal(isHandoffAllowed("builder", "complete"), false, "검수 없는 Complete 선언");
  assert.equal(isHandoffAllowed("planner", "builder"), false, "승인 없는 Builder 시작");
  // 어휘 밖 역할.
  assert.equal(isHandoffAllowed("orchestrator", "planner"), false);
  assert.equal(isHandoffAllowed("planner", "orchestrator"), false);
  for (const from of HANDOFF_ROLES) {
    assert.equal(isHandoffAllowed(from, from), false, `${from} 자기 자신`);
  }
});

test("resolveReviewerContract: 문구가 아니라 출처와 artifact로 계약을 고른다", () => {
  assert.equal(resolveReviewerContract({ sourceRole: "planner" }), "plan_review");
  assert.equal(resolveReviewerContract({ sourceRole: "builder" }), "review");
  assert.equal(
    resolveReviewerContract({ sourceRole: "planner", hasFrozenArtifacts: true }),
    "review",
  );
  assert.equal(resolveReviewerContract({}), "plan_review");
});

test("validateHandoff: 허용 전이 + 예산 내 요청은 통과한다", () => {
  const ledger = createHandoffLedger();
  const verdict = validateHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  assert.deepEqual(verdict, { ok: true });
});

test("validateHandoff: 금지 전이와 자기 호출을 거부한다", () => {
  const ledger = createHandoffLedger();
  assert.equal(
    validateHandoff({ sourceRole: "recorder", targetRole: "builder" }, { ledger }).reason,
    "HANDOFF_NOT_ALLOWED",
  );
  assert.equal(
    validateHandoff({ sourceRole: "review", targetRole: "review" }, { ledger }).reason,
    "HANDOFF_SELF",
  );
});

test("validateHandoff: 동일 역할 연속 호출을 거부한다", () => {
  const ledger = createHandoffLedger();
  const first = consumeHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(first.ok, true);
  settleHandoff(ledger, "inv-1");
  const repeat = validateHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, "HANDOFF_SELF");
});

test("validateHandoff: 예산 소진 시 HANDOFF_BUDGET_REACHED", () => {
  const ledger = createHandoffLedger({ budget: 1 });
  const first = consumeHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(first.ok, true);
  settleHandoff(ledger, "inv-1");
  const second = validateHandoff(
    { sourceRole: "plan_review", targetRole: "planner", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(second.ok, false);
  assert.equal(second.reason, "HANDOFF_BUDGET_REACHED");
});

test("validateHandoff: 기본 예산은 DEFAULT_HANDOFF_BUDGET", () => {
  const ledger = createHandoffLedger();
  assert.equal(ledger.budget, DEFAULT_HANDOFF_BUDGET);
});

test("validateHandoff: 다른 run / 다른 generation의 stale 요청을 폐기한다", () => {
  const ledger = createHandoffLedger();
  const wrongRun = validateHandoff(
    {
      sourceRole: "planner",
      targetRole: "plan_review",
      professionalRunId: "pr-old",
    },
    { ledger, professionalRunId: "pr-new" },
  );
  assert.equal(wrongRun.reason, "HANDOFF_STALE");
  const wrongGeneration = validateHandoff(
    { sourceRole: "planner", targetRole: "plan_review", generation: 1 },
    { ledger, generation: 2 },
  );
  assert.equal(wrongGeneration.reason, "HANDOFF_STALE");
});

test("validateHandoff: 소비된 invocationId 재사용을 거부한다", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  settleHandoff(ledger, "inv-1");
  const replay = validateHandoff(
    { sourceRole: "plan_review", targetRole: "ready", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "HANDOFF_DUPLICATE");
});

test("validateHandoff: active invocation이 있으면 새 요청은 HANDOFF_BUSY", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  // settle 전 — 한 시점에 active invocation은 1개다.
  const busy = validateHandoff(
    { sourceRole: "plan_review", targetRole: "ready", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "HANDOFF_BUSY");
  assert.equal(settleHandoff(ledger, "inv-1"), true);
  const after = validateHandoff(
    { sourceRole: "plan_review", targetRole: "ready", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(after.ok, true);
});

test("settleHandoff: 다른 id의 늦은 완료 보고는 무시한다", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "plan_review", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(settleHandoff(ledger, "inv-999"), false);
  assert.equal(ledger.activeInvocationId, "inv-1");
});

test("consumeHandoff: 검증 실패 시 원장을 건드리지 않는다", () => {
  const ledger = createHandoffLedger();
  const verdict = consumeHandoff(
    { sourceRole: "recorder", targetRole: "builder", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(verdict.ok, false);
  assert.equal(ledger.used, 0);
  assert.equal(ledger.activeInvocationId, null);
  assert.equal(ledger.consumedInvocationIds.size, 0);
});

test("parseHandoffRequest: HANDOFF/PURPOSE/REASON 블록을 파싱한다", () => {
  const text = [
    "검토가 필요합니다.",
    "",
    "HANDOFF: @reviewer",
    "PURPOSE: plan_review",
    "REASON: 인증 경계와 rollback 조건 검증 필요",
  ].join("\n");
  const parsed = parseHandoffRequest(text);
  assert.deepEqual(parsed, {
    targetRole: "reviewer",
    purpose: "plan_review",
    reason: "인증 경계와 rollback 조건 검증 필요",
    ambiguous: false,
  });
});

test("parseHandoffRequest: 한국어 별칭과 @ 없는 표기도 인식한다", () => {
  assert.equal(parseHandoffRequest("HANDOFF: 검토자").targetRole, "reviewer");
  assert.equal(parseHandoffRequest("HANDOFF: @기획자").targetRole, "planner");
  assert.equal(parseHandoffRequest("HANDOFF: @구현자").targetRole, "builder");
});

test("parseHandoffRequest: 일반 문장 속 멘션은 Handoff가 아니다", () => {
  assert.equal(parseHandoffRequest("@reviewer 이 부분을 봐 주세요."), null);
  assert.equal(parseHandoffRequest("다음 단계는 HANDOFF: @reviewer 입니다."), null);
});

test("parseHandoffRequest: 코드펜스 안의 예시는 무시한다", () => {
  const text = ["출력 형식 예시:", "```", "HANDOFF: @reviewer", "```"].join("\n");
  assert.equal(parseHandoffRequest(text), null);
});

test("parseHandoffRequest: 서로 다른 대상이 여럿이면 ambiguous", () => {
  const text = ["HANDOFF: @reviewer", "HANDOFF: @planner"].join("\n");
  const parsed = parseHandoffRequest(text);
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.targetRole, null);
});

test("parseHandoffRequest: 같은 대상 반복은 ambiguous가 아니다", () => {
  const text = ["HANDOFF: @reviewer", "HANDOFF: @검토자"].join("\n");
  const parsed = parseHandoffRequest(text);
  assert.equal(parsed.ambiguous, false);
  assert.equal(parsed.targetRole, "reviewer");
});

test("parseHandoffRequest: 미지 대상은 targetRole null로 반환한다", () => {
  const parsed = parseHandoffRequest("HANDOFF: @nobody");
  assert.equal(parsed.targetRole, null);
  assert.equal(parsed.ambiguous, false);
});

test("parseHandoffRequest: 마커가 없으면 null", () => {
  assert.equal(parseHandoffRequest("그냥 일반 답변입니다."), null);
  assert.equal(parseHandoffRequest(""), null);
  assert.equal(parseHandoffRequest(null), null);
});
