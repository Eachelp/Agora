"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
