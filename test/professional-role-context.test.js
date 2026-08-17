"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ROLE_CONTEXT_POLICY,
  roleContextFor,
  roleContextNotice,
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
