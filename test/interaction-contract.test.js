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
  validateResultControl,
  DEFAULT_HANDOFF_BUDGET,
  createHandoffLedger,
  serializeHandoffLedger,
  recoverHandoffLedger,
  recoverHandoffLedgerForRoot,
  validateHandoff,
  consumeHandoff,
  settleHandoff,
  parseControlOutput,
} = require("../src/agora/interaction-contract");
const { SPECIALIST_STAGE_CAPS } = require("../src/chat/chat-argv");

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

test("@recorder의 실행 계약은 deterministic finalizer가 아니라 archivist다", () => {
  // 기존 professional "recorder" stage는 finalizer가 가로채 LLM을 호출하지
  // 않는다. Handoff/CONSULT의 @기록자가 그 stage로 이어지면 "기록 역할을
  // 맡은 AI" 대신 finalizer가 불린다 — 계약 어휘에서부터 갈라 둔다.
  assert.equal(executionContractFor("recorder"), "archivist");
  assert.notEqual(executionContractFor("recorder"), "recorder");
  // archivist 계약의 권한 상한은 recorder와 같은 chat이다.
  assert.equal(SPECIALIST_STAGE_CAPS.archivist, "chat");
});

test("handoff ledger는 직렬화-복원 roundtrip으로 같은 판정을 유지한다", () => {
  const ledger = createHandoffLedger({ budget: 3 });
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  settleHandoff(ledger, "inv-1");
  consumeHandoff(
    { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-2" },
    { ledger },
  );

  const restored = createHandoffLedger(serializeHandoffLedger(ledger));
  // used를 복원하지 않으면 재시작이 곧 예산 리셋이 된다.
  assert.equal(restored.used, 2);
  assert.equal(restored.budget, 3);
  // 소비된 invocation 재사용은 복원 후에도 거부된다(재시작 중복 방지).
  assert.equal(
    validateHandoff(
      { sourceRole: "reviewer", targetRole: "planner", invocationId: "inv-1" },
      { ledger: restored },
    ).reason,
    "HANDOFF_DUPLICATE",
  );
  // active invocation(inv-2)도 복원되어 동시성 규칙이 유지된다.
  assert.equal(
    validateHandoff(
      { sourceRole: "builder", targetRole: "planner", invocationId: "inv-3" },
      { ledger: restored },
    ).reason,
    "HANDOFF_BUSY",
  );
  assert.equal(settleHandoff(restored, "inv-2"), true);
  // 연속 호출 금지(lastTargetRole)도 복원된다. 진짜 self-handoff와 구분되는
  // 별도 코드(HANDOFF_REPEAT)로 거부한다.
  assert.equal(
    validateHandoff(
      { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-3" },
      { ledger: restored },
    ).reason,
    "HANDOFF_REPEAT",
  );
  assert.equal(serializeHandoffLedger(null), null);
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
  // 진짜 self-handoff(fromRole===toRole)와 구분되는 별도 코드다.
  assert.equal(repeat.reason, "HANDOFF_REPEAT");
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

// --- 결과 축 × routing 축 조합 검증 ---

test("validateResultControl: 결과와 routing은 독립 축으로 함께 유효할 수 있다", () => {
  // Builder: STATUS: DONE + HANDOFF: @reviewer — 둘 다 유효.
  assert.deepEqual(
    validateResultControl({
      contract: "implementation",
      result: "DONE",
      control: { action: "HANDOFF", targetRole: "reviewer", ambiguous: false },
    }),
    { ok: true, reason: null },
  );
  // Reviewer: VERDICT: FIX_REQUIRED + HANDOFF: @builder.
  assert.equal(
    validateResultControl({
      contract: "review",
      result: "FIX_REQUIRED",
      control: { action: "HANDOFF", targetRole: "builder", ambiguous: false },
    }).ok,
    true,
  );
});

test("validateResultControl: 판정표의 허용 조합 전수", () => {
  const allowed = [
    ["planner", "PLAN_READY", { action: "HANDOFF", targetRole: "reviewer" }],
    ["planner", "NEEDS_DECISION", { action: "ASK_USER", question: "범위는?" }],
    ["plan_review", "PASS", { action: "HANDOFF", targetRole: "builder" }],
    ["plan_review", "FIX_REQUIRED", { action: "HANDOFF", targetRole: "planner" }],
    ["plan_review", "UNKNOWN", { action: "ASK_USER", question: "근거 부족" }],
    ["implementation", "DONE", { action: "HANDOFF", targetRole: "reviewer" }],
    ["implementation", "BLOCKED", { action: "ASK_USER", question: "권한 필요" }],
    ["implementation", "BLOCKED", { action: "HANDOFF", targetRole: "planner" }],
    ["review", "PASS", { action: "COMPLETE" }],
    ["review", "PASS", { action: "HANDOFF", targetRole: "recorder" }],
    ["review", "FIX_REQUIRED", { action: "HANDOFF", targetRole: "planner" }],
    ["review", "UNKNOWN", { action: "ASK_USER", question: "재현 불가" }],
    ["archivist", "DONE", { action: "COMPLETE" }],
  ];
  for (const [contract, result, control] of allowed) {
    const verdict = validateResultControl({
      contract,
      result,
      control: { ambiguous: false, ...control },
    });
    assert.equal(verdict.ok, true, `${contract}/${result}/${control.action}`);
  }
});

test("validateResultControl: 결과와 어긋나는 routing을 거부한다", () => {
  // 막힌 Builder가 완료를 선언할 수 없다.
  assert.equal(
    validateResultControl({
      contract: "implementation",
      result: "BLOCKED",
      control: { action: "COMPLETE", ambiguous: false },
    }).reason,
    "CONTROL_NOT_ALLOWED",
  );
  // 수정을 요구한 Reviewer가 완료를 선언할 수 없다.
  assert.equal(
    validateResultControl({
      contract: "review",
      result: "FIX_REQUIRED",
      control: { action: "COMPLETE", ambiguous: false },
    }).reason,
    "CONTROL_NOT_ALLOWED",
  );
  // PLAN_READY에서 Builder로 직행할 수 없다(검수·승인 우회 금지).
  assert.equal(
    validateResultControl({
      contract: "planner",
      result: "PLAN_READY",
      control: { action: "HANDOFF", targetRole: "builder", ambiguous: false },
    }).reason,
    "CONTROL_NOT_ALLOWED",
  );
});

test("validateResultControl: 미해결 결과·모호한 제어·미지 계약을 거부한다", () => {
  assert.equal(
    validateResultControl({
      contract: "implementation",
      result: "AMBIGUOUS",
      control: { action: "HANDOFF", targetRole: "reviewer", ambiguous: false },
    }).reason,
    "RESULT_UNRESOLVED",
  );
  assert.equal(
    validateResultControl({
      contract: "review",
      result: "PASS",
      control: { action: null, ambiguous: true },
    }).reason,
    "CONTROL_AMBIGUOUS",
  );
  assert.equal(
    validateResultControl({
      contract: "orchestrator",
      result: "DONE",
      control: { action: "COMPLETE", ambiguous: false },
    }).reason,
    "CONTROL_UNKNOWN_CONTRACT",
  );
});

test("validateResultControl: 제어가 없으면 기존 FSM 기본 흐름이 그대로다", () => {
  assert.deepEqual(
    validateResultControl({ contract: "planner", result: "PLAN_READY", control: null }),
    { ok: true, reason: null },
  );
});

test("recoverHandoffLedger: 죽은 active invocation은 INTERRUPTED로 폐기된다", () => {
  const ledger = createHandoffLedger({ budget: 8, rootMessageId: "msg-1" });
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-7" },
    { ledger },
  );
  // Reviewer 실행 중 앱 강제 종료 — settle 없이 직렬화된 상태로 재시작.
  const persisted = serializeHandoffLedger(ledger);
  assert.equal(persisted.activeInvocationId, "inv-7");

  const { ledger: recovered, interruptedInvocationId } = recoverHandoffLedger(persisted);
  assert.equal(interruptedInvocationId, "inv-7");
  assert.equal(recovered.activeInvocationId, null);
  // ghost BUSY가 사라져 새 Handoff가 흐른다.
  const next = validateHandoff(
    { sourceRole: "reviewer", targetRole: "builder", invocationId: "inv-8" },
    { ledger: recovered },
  );
  assert.equal(next.ok, true);
  // 중단된 invocation의 재실행(중복)은 계속 막힌다.
  const replay = validateHandoff(
    { sourceRole: "planner", targetRole: "builder", invocationId: "inv-7" },
    { ledger: recovered },
  );
  assert.equal(replay.reason, "HANDOFF_DUPLICATE");
  // used도 유지된다 — 복구가 예산 리셋이 되지 않는다.
  assert.equal(recovered.used, 1);
});

test("recoverHandoffLedgerForRoot: 새 사용자 발화는 새 budget epoch를 받는다", () => {
  const ledger = createHandoffLedger({ budget: 8, rootMessageId: "msg-1" });
  for (let i = 0; i < 6; i += 1) {
    consumeHandoff(
      {
        sourceRole: i % 2 === 0 ? "planner" : "reviewer",
        targetRole: i % 2 === 0 ? "reviewer" : "planner",
        invocationId: `inv-${i}`,
      },
      { ledger },
    );
    settleHandoff(ledger, `inv-${i}`);
  }
  const persisted = serializeHandoffLedger(ledger);
  assert.equal(persisted.used, 6);

  // 같은 발화의 복원 — 예산을 이어 쓴다(발화당 상한 유지).
  const sameRoot = recoverHandoffLedgerForRoot(persisted, "msg-1");
  assert.equal(sameRoot.ok, true);
  assert.equal(sameRoot.ledger.used, 6);
  assert.equal(sameRoot.ledger.rootMessageId, "msg-1");

  // 새 사용자 지시("아니, API는 건드리지 마. 다시 해.") — 새 epoch, 새 예산.
  // 이게 없으면 8회가 발화당이 아니라 Run 전체 예산으로 변질된다.
  const newRoot = recoverHandoffLedgerForRoot(persisted, "msg-2");
  assert.equal(newRoot.ok, true);
  assert.equal(newRoot.ledger.used, 0);
  assert.equal(newRoot.ledger.rootMessageId, "msg-2");
  assert.equal(newRoot.interruptedInvocationId, null);

  // 같은 root의 복원은 crash recovery 규칙도 함께 적용한다.
  consumeHandoff(
    { sourceRole: "planner", targetRole: "builder", invocationId: "inv-9" },
    { ledger },
  );
  const crashed = recoverHandoffLedgerForRoot(serializeHandoffLedger(ledger), "msg-1");
  assert.equal(crashed.ok, true);
  assert.equal(crashed.interruptedInvocationId, "inv-9");
  assert.equal(crashed.ledger.activeInvocationId, null);
});

test("recoverHandoffLedgerForRoot: rootMessageId 누락은 fail-closed로 거부한다", () => {
  const ledger = createHandoffLedger({ budget: 8, rootMessageId: "msg-1" });
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-1" },
    { ledger },
  );
  const persisted = serializeHandoffLedger(ledger);

  // 배선 버그로 root 전달이 누락되면 호출마다 새 epoch가 만들어져 budget이
  // 조용히 리셋된다 — 새 원장을 만들지 말고 거부해야 한다.
  for (const missing of [null, undefined, ""]) {
    const result = recoverHandoffLedgerForRoot(persisted, missing);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "HANDOFF_ROOT_REQUIRED");
    assert.equal(result.ledger, null, "새 epoch를 만들면 안 됩니다");
  }
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

test("parseControlOutput: 서로 다른 ASK_USER 질문이 여럿이면 ambiguous", () => {
  // 마지막 질문만 남기면 사용자가 내려야 할 결정 하나를 조용히 잃는다.
  const parsed = parseControlOutput(
    ["ASK_USER: API 버전을 유지할까요?", "ASK_USER: DB migration도 허용할까요?"].join("\n")
  );
  assert.equal(parsed.action, "ASK_USER");
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.question, null);
  // 동일 줄 반복은 하나로 본다(HANDOFF distinct 규칙과 같은 규율).
  const repeated = parseControlOutput(
    ["ASK_USER: API 버전을 유지할까요?", "ASK_USER: API 버전을 유지할까요?"].join("\n")
  );
  assert.equal(repeated.ambiguous, false);
  assert.equal(repeated.question, "API 버전을 유지할까요?");
});

test("parseControlOutput: 서로 다른 COMPLETE 요약이 여럿이면 ambiguous", () => {
  const parsed = parseControlOutput(["COMPLETE: 구현 완료", "COMPLETE: 검수 대기"].join("\n"));
  assert.equal(parsed.action, "COMPLETE");
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.summary, null);
});

test("parseControlOutput: 산문 속 COMPLETE는 제어가 아니다", () => {
  assert.equal(parseControlOutput("Please COMPLETE the task first."), null);
  assert.equal(parseControlOutput("이 단계를 COMPLETE 처리해 주세요."), null);
});

test("parseControlOutput: 일반 문장 속 멘션은 제어가 아니다", () => {
  assert.equal(parseControlOutput("@reviewer 이 부분을 봐 주세요."), null);
  assert.equal(parseControlOutput("다음 단계는 HANDOFF: @reviewer 입니다."), null);
});

test("parseControlOutput: 본문 중간의 마커는 end-anchor 규칙으로 무시된다", () => {
  // 코드펜스 없이 예시를 보여 준 뒤 산문이 이어지는 경우 — 실행 요청이 아니다.
  const midText = ["출력 예시는 다음과 같습니다.", "HANDOFF: @builder", "이렇게 쓰면 됩니다."].join(
    "\n"
  );
  assert.equal(parseControlOutput(midText), null);
  // 중간 마커 + 끝 제어 블록이면 끝의 블록만 유효하다(last-block-wins).
  const tail = ["예시: ", "HANDOFF: @builder", "설명이 이어집니다.", "", "COMPLETE: 끝"].join("\n");
  assert.deepEqual(parseControlOutput(tail), {
    action: "COMPLETE",
    summary: "끝",
    ambiguous: false,
  });
  // 끝 블록은 빈 줄 없이 연속이어야 한다.
  const split = ["HANDOFF: @builder", "", "PURPOSE: implementation"].join("\n");
  assert.equal(parseControlOutput(split), null, "PURPOSE만 남은 블록은 행동이 아니다");
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
