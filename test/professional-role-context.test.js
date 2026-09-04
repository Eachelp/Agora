"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");
const {
  ROLE_CONTEXT_POLICY,
  roleContextFor,
  roleContextNotice,
  includesPromptContext,
  roleSees,
} = require("../src/chat/professional-role-context");

test("모든 정의된 역할에 sees와 excludes가 있다", () => {
  for (const role of Object.keys(ROLE_CONTEXT_POLICY)) {
    const policy = roleContextFor(role);
    assert.ok(Array.isArray(policy.sees), role + " sees");
    assert.ok(Array.isArray(policy.excludes), role + " excludes");
    assert.ok(policy.sees.length > 0, role + " sees가 비어있음");
    assert.ok(policy.excludes.length > 0, role + " excludes가 비어있음");
  }
});

test("implementation은 conversationTranscript를 보지 않는다", () => {
  const policy = roleContextFor("implementation");
  assert.ok(policy.sees.includes("frozenTask"));
  assert.ok(policy.excludes.includes("conversationTranscript"));
});

test("review는 builderSelfReport를 보지 않는다", () => {
  const policy = roleContextFor("review");
  assert.ok(policy.sees.includes("builderDiff"));
  assert.ok(policy.excludes.includes("builderSelfReport"));
});

test("존재하지 않는 역할은 null을 반환한다", () => {
  assert.equal(roleContextFor("unknown_role"), null);
});

test("archivist는 Journal·canonical artifact만 보고 대화 전문을 보지 않는다", () => {
  // V1.5 §8-0 — 정책 없는 역할은 roleSees()가 전체 context를 돌려주므로,
  // archivist 정책 등록이 프롬프트·소비 연결보다 먼저여야 한다.
  const policy = roleContextFor("archivist");
  assert.ok(policy, "archivist 정책이 등록되어 있어야 합니다");
  assert.ok(policy.sees.includes("systemJournal"));
  assert.ok(policy.sees.includes("finalVerdict"));
  assert.equal(roleSees("archivist", "conversationTranscript"), false);
  assert.equal(includesPromptContext("archivist", "projectContext"), false);
  assert.equal(includesPromptContext("archivist", "memoryContext"), false);
});

test("archivist 프롬프트 계약: 사람용 정리, 새 판정 생성 금지", () => {
  const prompt = buildAgentPrompt({
    agent: { id: "claude", name: "Claude" },
    agents: [{ id: "claude", name: "Claude" }],
    messages: [],
    specialist: {
      stage: "archivist",
      journal: [{ type: "RUN_COMPLETED", professionalRunId: "pr-1" }],
      finalVerdict: "PASS",
    },
  });
  assert.match(prompt, /전문 모드: 기록 정리/);
  assert.match(prompt, /System Journal/);
  assert.match(prompt, /새로운 사실·결정·판정을 만들지 마세요/);
  assert.match(prompt, /derivedSummary/);
  // deterministic recorder의 JSON 출력 계약과는 다른 계약이다.
  assert.doesNotMatch(prompt, /"nextActions"/);
});

test("roleContextNotice는 sees와 excludes를 한국어 안내 형태로 반환한다", () => {
  const notice = roleContextNotice("planner");
  assert.ok(notice.includes("참고 입력:"));
  assert.ok(notice.includes("보지 않는 입력:"));
  assert.ok(notice.includes("userRequest"));
});

test("알 수 없는 역할의 roleContextNotice는 빈 문자열이다", () => {
  assert.equal(roleContextNotice("nope"), "");
});

test("includesPromptContext는 역할별 프롬프트 context 포함 여부를 정책으로 판정한다", () => {
  // Builder/Reviewer/Recorder는 대화 맥락·작업목록·누적 요약을 받지 않는다.
  for (const role of ["implementation", "review", "recorder"]) {
    assert.equal(includesPromptContext(role, "projectContext"), false, role);
    assert.equal(includesPromptContext(role, "workflowContext"), false, role);
    assert.equal(includesPromptContext(role, "memoryContext"), false, role);
  }
  // 기획자는 대화 맥락을 본다.
  assert.equal(includesPromptContext("planner", "projectContext"), true);
  assert.equal(includesPromptContext("planner", "memoryContext"), true);
  // 기획 검수자는 맥락은 보되 누적 대화 요약은 보지 않는다.
  assert.equal(includesPromptContext("plan_review", "projectContext"), true);
  assert.equal(includesPromptContext("plan_review", "memoryContext"), false);
});

// 정책이 "설명 문구 생성용"으로만 남지 않도록, 실제 프롬프트 조립이
// 정책 판정 함수를 사용하는지 검증한다.
test("chat-prompt는 context 조립에 역할 정책을 실제로 사용한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-prompt.js"), "utf8");
  assert.match(source, /includesPromptContext/, "정책 판정 함수를 import 해야 한다");
  assert.match(source, /roleAllows\("projectContext"\)/, "프로젝트 맥락은 정책으로 판정해야 한다");
  assert.match(source, /roleAllows\("workflowContext"\)/, "작업 목록은 정책으로 판정해야 한다");
  assert.match(source, /roleAllows\("memoryContext"\)/, "누적 요약은 정책으로 판정해야 한다");
  assert.match(source, /roleAllows\("rulesContext"\)/, "프로젝트 규칙은 정책으로 판정해야 한다");
});

// transcript(최근 대화) 포함 여부도 중앙 정책이 결정하도록 한다.
// 기존 하드코딩(isBuilder/isCleanReviewer/isProfessionalRecorder 등)을 걷어내고
// roleSees(specialistStage, "conversationTranscript")를 단일 authority로 쓴다.
test("chat-prompt는 최근 대화(transcript) 포함 여부를 roleSees로 판정한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-prompt.js"), "utf8");
  assert.match(source, /roleSees\(specialistRole, "conversationTranscript"\)/, "transcript 포함은 정책으로 판정해야 한다");
  // planner는 전체 transcript를 보지만 implementation/review/recorder는 보지 않는다.
  for (const role of ["implementation", "review", "recorder"]) {
    assert.equal(roleSees(role, "conversationTranscript"), false, role);
  }
  assert.equal(roleSees("planner", "conversationTranscript"), true);
  // plan_review는 transcript는 보지 않지만 conversationContext(사용자 메시지)는 본다.
  assert.equal(roleSees("plan_review", "conversationTranscript"), false);
  assert.equal(roleSees("plan_review", "conversationContext"), true);
});

test("Project Rules(rulesContext)는 중앙 정책을 통과하며 실제 생성 프롬프트에 반영된다", () => {
  // 1) includesPromptContext 판정
  assert.equal(includesPromptContext("planner", "rulesContext"), true);
  assert.equal(includesPromptContext("plan_review", "rulesContext"), true);
  assert.equal(includesPromptContext("implementation", "rulesContext"), true);
  assert.equal(includesPromptContext("review", "rulesContext"), true);
  assert.equal(includesPromptContext("recorder", "rulesContext"), false);

  const baseAgent = { id: "claude", name: "Claude" };
  const agents = [baseAgent];
  const RULE_SENTINEL = "RULE_SENTINEL_SECRET_TOKEN";

  // 2) Planner 프롬프트: rules 포함
  const plannerPrompt = buildAgentPrompt({
    agent: baseAgent,
    agents,
    messages: [{ author: "user", authorType: "user", text: "작업 요청" }],
    rulesContext: RULE_SENTINEL,
    specialist: { stage: "planner" },
  });
  assert.ok(plannerPrompt.includes(RULE_SENTINEL), "Planner는 규칙을 포함해야 한다");

  // 3) Reviewer 프롬프트: rules 포함
  const reviewerPrompt = buildAgentPrompt({
    agent: baseAgent,
    agents,
    messages: [{ author: "user", authorType: "user", text: "작업 요청" }],
    rulesContext: RULE_SENTINEL,
    specialist: { stage: "review" },
  });
  assert.ok(reviewerPrompt.includes(RULE_SENTINEL), "Reviewer는 규칙을 포함해야 한다");

  // 4) Builder 프롬프트: rules 포함
  const builderPrompt = buildAgentPrompt({
    agent: baseAgent,
    agents,
    messages: [{ author: "user", authorType: "user", text: "작업 요청" }],
    rulesContext: RULE_SENTINEL,
    specialist: { stage: "implementation" },
  });
  assert.ok(builderPrompt.includes(RULE_SENTINEL), "Builder는 규칙을 포함해야 한다");

  // 5) Recorder 프롬프트: rules 제외
  const recorderPrompt = buildAgentPrompt({
    agent: baseAgent,
    agents,
    messages: [{ author: "user", authorType: "user", text: "작업 요청" }],
    rulesContext: RULE_SENTINEL,
    specialist: { stage: "recorder", professional: true },
  });
  assert.ok(!recorderPrompt.includes(RULE_SENTINEL), "Recorder는 규칙을 포함하지 않아야 한다");

  // 6) Direct simplify 프롬프트: rules 제외
  const simplifyPrompt = buildAgentPrompt({
    agent: baseAgent,
    agents,
    messages: [{ author: "user", authorType: "user", text: "작업 요청" }],
    rulesContext: RULE_SENTINEL,
    simplifyMeta: { fromAgentId: "claude", text: "원문", messageId: "msg-1" },
  });
  assert.ok(!simplifyPrompt.includes(RULE_SENTINEL), "쉽게 설명은 규칙을 포함하지 않아야 한다");
});
