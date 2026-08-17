"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROLE_CONTEXT_POLICY,
  roleContextFor,
  roleContextNotice,
  includesPromptContext,
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
});
