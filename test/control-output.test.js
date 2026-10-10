"use strict";

// 대화 응답 꼬리의 제어 줄 파싱. 예전 interaction-contract.test.js에서 대화가 쓰는
// 부분만 옮겼다(D48로 역할 간 Handoff 실행은 지웠지만 줄 인식 규칙은 같다).
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseControlOutput } = require("../src/chat/control-output");

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
    options: [],
    ambiguous: false,
  });
});

// 고르는 질문은 ASK_USER 아래 OPTION 줄로 보기를 준다. 소비 지점(답변 대기 칩)이
// 산문 추출 없이 그대로 쓰는 검증된 보기다.
test("parseControlOutput: ASK_USER 아래 OPTION 줄을 보기로 읽고, OPTION만 있으면 제어가 아니다", () => {
  const { stripControlOutput } = require("../src/chat/control-output");
  const text =["정리했습니다. 어느 쪽으로 갈까요?", "", "ASK_USER: 어느 쪽으로 갈까요?", "OPTION: A안", "OPTION: B안", "OPTION: A안"].join("\n");
  assert.deepEqual(parseControlOutput(text), {
    action: "ASK_USER",
    question: "어느 쪽으로 갈까요?",
    options: ["A안", "B안"],
    ambiguous: false,
  });
  // OPTION 줄도 꼬리 제어 블록의 일부라 표시 텍스트에서 함께 사라진다.
  assert.equal(stripControlOutput(text), "정리했습니다. 어느 쪽으로 갈까요?");
  // ASK_USER 없이 OPTION만 있으면 제어가 아니고, 산문으로 남는다.
  const lone = ["둘 중 하나입니다.", "OPTION: A안", "OPTION: B안"].join("\n");
  assert.equal(parseControlOutput(lone), null);
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
