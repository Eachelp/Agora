"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INTERACTION_TARGETS,
  INTERACTION_INTENTS,
  EXECUTION_POLICIES,
  normalizeInteraction,
  HANDOFF_TARGETS,
  CONTROL_ACTIONS,
  isHandoffTarget,
  resolveReviewerContract,
  executionContractFor,
  DEFAULT_HANDOFF_BUDGET,
  createHandoffLedger,
  validateHandoff,
  consumeHandoff,
  settleHandoff,
  parseControlOutput,
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

// --- 역할과 workflow state의 분리 ---

test("Handoff 대상은 사람 역할뿐이다 — 상태·행동·계약은 그래프에 없다", () => {
  assert.deepEqual([...HANDOFF_TARGETS], ["planner", "builder", "reviewer", "recorder"]);
  // ready/complete는 상태, user 반환은 ASK_USER 행동, archivist·plan_review는
  // 실행 계약이다. 역할 그래프에 이런 것이 들어가면 role routing과 workflow
  // state가 다시 섞인다.
  for (const notARole of ["ready", "complete", "archivist", "plan_review", "review", "user"]) {
    assert.equal(isHandoffTarget(notARole), false, notARole);
  }
  assert.deepEqual([...CONTROL_ACTIONS], ["HANDOFF", "COMPLETE", "ASK_USER"]);
});

test("executionContractFor: 표면 역할을 실행 계약으로 정규화한다", () => {
  assert.equal(executionContractFor("planner"), "planner");
  assert.equal(executionContractFor("builder"), "implementation");
  assert.equal(executionContractFor("recorder"), "recorder");
  // @reviewer라는 표면 어휘가 검증에서 거부되지 않고, 출처·artifact에 따라
  // 계약이 갈린다 — 표면과 내부 어휘의 어긋남을 여기서 흡수한다.
  assert.equal(executionContractFor("reviewer", { sourceRole: "planner" }), "plan_review");
  assert.equal(executionContractFor("reviewer", { sourceRole: "builder" }), "review");
  assert.equal(
    executionContractFor("reviewer", { sourceRole: "planner", hasFrozenArtifacts: true }),
    "review",
  );
  assert.equal(executionContractFor("orchestrator"), null);
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

// --- 구조적 Handoff 검증 (업무 순서는 판정하지 않는다) ---

test("validateHandoff: 실존 역할 사이의 요청은 통과한다 — 업무 순서는 런타임 몫", () => {
  const ledger = createHandoffLedger();
  assert.deepEqual(
    validateHandoff({ sourceRole: "planner", targetRole: "reviewer" }, { ledger }),
    { ok: true },
  );
  // 초판 전이표는 이런 요청을 업무 의미로 거부했다. 새 계약에서 구조 검증은
  // 통과하고, "Builder를 실행해도 되는가"는 READY Task·Frozen hash 같은
  // 실행 전제조건 검증이 런타임에서 판정한다.
  assert.equal(
    validateHandoff({ sourceRole: "recorder", targetRole: "builder" }, { ledger }).ok,
    true,
  );
});

test("validateHandoff: 어휘 밖 역할과 자기 호출을 거부한다", () => {
  const ledger = createHandoffLedger();
  assert.equal(
    validateHandoff({ sourceRole: "orchestrator", targetRole: "planner" }, { ledger }).reason,
    "HANDOFF_NOT_ALLOWED",
  );
  assert.equal(
    validateHandoff({ sourceRole: "planner", targetRole: "ready" }, { ledger }).reason,
    "HANDOFF_NOT_ALLOWED",
  );
  assert.equal(
    validateHandoff({ sourceRole: "reviewer", targetRole: "reviewer" }, { ledger }).reason,
    "HANDOFF_SELF",
  );
});

test("validateHandoff: 동일 역할 연속 호출을 거부한다", () => {
  const ledger = createHandoffLedger();
  const first = consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(first.ok, true);
  settleHandoff(ledger, "inv-1");
  const repeat = validateHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, "HANDOFF_SELF");
});

test("validateHandoff: 예산 소진 시 HANDOFF_BUDGET_REACHED", () => {
  const ledger = createHandoffLedger({ budget: 1 });
  const first = consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(first.ok, true);
  settleHandoff(ledger, "inv-1");
  const second = validateHandoff(
    { sourceRole: "reviewer", targetRole: "planner", invocationId: "inv-2" },
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
      targetRole: "reviewer",
      professionalRunId: "pr-old",
    },
    { ledger, professionalRunId: "pr-new" },
  );
  assert.equal(wrongRun.reason, "HANDOFF_STALE");
  const wrongGeneration = validateHandoff(
    { sourceRole: "planner", targetRole: "reviewer", generation: 1 },
    { ledger, generation: 2 },
  );
  assert.equal(wrongGeneration.reason, "HANDOFF_STALE");
});

test("validateHandoff: 소비된 invocationId 재사용을 거부한다", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  settleHandoff(ledger, "inv-1");
  const replay = validateHandoff(
    { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "HANDOFF_DUPLICATE");
});

test("validateHandoff: active invocation이 있으면 새 요청은 HANDOFF_BUSY", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  // settle 전 — 한 시점에 active invocation은 1개다.
  const busy = validateHandoff(
    { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "HANDOFF_BUSY");
  assert.equal(settleHandoff(ledger, "inv-1"), true);
  const after = validateHandoff(
    { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-2" },
    { ledger },
  );
  assert.equal(after.ok, true);
});

test("settleHandoff: 다른 id의 늦은 완료 보고는 무시한다", () => {
  const ledger = createHandoffLedger();
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(settleHandoff(ledger, "inv-999"), false);
  assert.equal(ledger.activeInvocationId, "inv-1");
});

test("consumeHandoff: 검증 실패 시 원장을 건드리지 않는다", () => {
  const ledger = createHandoffLedger();
  const verdict = consumeHandoff(
    { sourceRole: "planner", targetRole: "ready", invocationId: "inv-1" },
    { ledger },
  );
  assert.equal(verdict.ok, false);
  assert.equal(ledger.used, 0);
  assert.equal(ledger.activeInvocationId, null);
  assert.equal(ledger.consumedInvocationIds.size, 0);
});

// --- 제어 출력 파싱 ---

test("parseControlOutput: HANDOFF/PURPOSE/REASON 블록을 파싱한다", () => {
  const text = [
    "검토가 필요합니다.",
    "",
    "HANDOFF: @reviewer",
    "PURPOSE: plan_review",
    "REASON: 인증 경계와 rollback 조건 검증 필요",
  ].join("\n");
  const parsed = parseControlOutput(text);
  assert.deepEqual(parsed, {
    action: "HANDOFF",
    targetRole: "reviewer",
    purpose: "plan_review",
    reason: "인증 경계와 rollback 조건 검증 필요",
    ambiguous: false,
  });
});

test("parseControlOutput: 한국어 별칭과 @ 없는 표기도 인식한다", () => {
  assert.equal(parseControlOutput("HANDOFF: 검토자").targetRole, "reviewer");
  assert.equal(parseControlOutput("HANDOFF: @기획자").targetRole, "planner");
  assert.equal(parseControlOutput("HANDOFF: @구현자").targetRole, "builder");
  assert.equal(parseControlOutput("HANDOFF: @기록자").targetRole, "recorder");
});

test("parseControlOutput: COMPLETE와 ASK_USER 행동을 파싱한다", () => {
  assert.deepEqual(parseControlOutput("작업을 끝냈습니다.\nCOMPLETE"), {
    action: "COMPLETE",
    summary: null,
    ambiguous: false,
  });
  assert.deepEqual(parseControlOutput("COMPLETE: 인증 모듈 구현과 검수 통과"), {
    action: "COMPLETE",
    summary: "인증 모듈 구현과 검수 통과",
    ambiguous: false,
  });
  assert.deepEqual(parseControlOutput("ASK_USER: 배포 대상 환경이 스테이징인가요?"), {
    action: "ASK_USER",
    question: "배포 대상 환경이 스테이징인가요?",
    ambiguous: false,
  });
});

test("parseControlOutput: 산문 속 COMPLETE는 제어가 아니다", () => {
  assert.equal(parseControlOutput("Please COMPLETE the task first."), null);
  assert.equal(parseControlOutput("이 단계를 COMPLETE 처리해 주세요."), null);
});

test("parseControlOutput: 일반 문장 속 멘션은 제어가 아니다", () => {
  assert.equal(parseControlOutput("@reviewer 이 부분을 봐 주세요."), null);
  assert.equal(parseControlOutput("다음 단계는 HANDOFF: @reviewer 입니다."), null);
});

test("parseControlOutput: 코드펜스 안의 예시는 무시한다", () => {
  const text = ["출력 형식 예시:", "```", "HANDOFF: @reviewer", "COMPLETE", "```"].join("\n");
  assert.equal(parseControlOutput(text), null);
});

test("parseControlOutput: 서로 다른 행동이 섞이면 ambiguous", () => {
  const parsed = parseControlOutput(["HANDOFF: @reviewer", "COMPLETE"].join("\n"));
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.action, null);
});

test("parseControlOutput: 서로 다른 HANDOFF 대상이 여럿이면 ambiguous", () => {
  const parsed = parseControlOutput(["HANDOFF: @reviewer", "HANDOFF: @planner"].join("\n"));
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.targetRole, null);
});

test("parseControlOutput: 같은 대상 반복은 ambiguous가 아니다", () => {
  const parsed = parseControlOutput(["HANDOFF: @reviewer", "HANDOFF: @검토자"].join("\n"));
  assert.equal(parsed.ambiguous, false);
  assert.equal(parsed.targetRole, "reviewer");
});

test("parseControlOutput: 미지 대상은 targetRole null로 반환한다", () => {
  const parsed = parseControlOutput("HANDOFF: @nobody");
  assert.equal(parsed.action, "HANDOFF");
  assert.equal(parsed.targetRole, null);
  assert.equal(parsed.ambiguous, false);
});

test("parseControlOutput: 마커가 없으면 null", () => {
  assert.equal(parseControlOutput("그냥 일반 답변입니다."), null);
  assert.equal(parseControlOutput(""), null);
  assert.equal(parseControlOutput(null), null);
});
