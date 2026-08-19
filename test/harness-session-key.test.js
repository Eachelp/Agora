"use strict";

// Stage C-2 STEP 1 — SessionKey identity separation.

const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveSessionKey, isResolvedModel } = require("../src/harness/harness-session-key");

function ctx(over = {}) {
  return {
    projectId: "p1",
    workspaceId: "/ws/a",
    professionalRunId: "pr-1",
    role: "implementation",
    providerId: "claude",
    modelKey: "claude-sonnet-x",
    permissionMode: "workspace-write",
    ...over,
  };
}

test("동일 identity는 동일 key를 만든다", () => {
  assert.equal(deriveSessionKey(ctx()), deriveSessionKey(ctx()));
  assert.ok(deriveSessionKey(ctx()).startsWith("hsk1:"));
});

test("role만 다르면 다른 key다", () => {
  assert.notEqual(deriveSessionKey(ctx({ role: "implementation" })), deriveSessionKey(ctx({ role: "review" })));
});

test("professionalRunId가 다르면 다른 key다", () => {
  assert.notEqual(deriveSessionKey(ctx({ professionalRunId: "pr-1" })), deriveSessionKey(ctx({ professionalRunId: "pr-2" })));
});

test("permissionMode가 다르면 다른 key다", () => {
  assert.notEqual(deriveSessionKey(ctx({ permissionMode: "workspace-write" })), deriveSessionKey(ctx({ permissionMode: "workspace-read" })));
});

test("workspaceId가 다르면 다른 key다", () => {
  assert.notEqual(deriveSessionKey(ctx({ workspaceId: "/ws/a" })), deriveSessionKey(ctx({ workspaceId: "/ws/b" })));
});

test("provider/model이 다르면 다른 key다", () => {
  assert.notEqual(deriveSessionKey(ctx({ providerId: "claude" })), deriveSessionKey(ctx({ providerId: "codex" })));
  assert.notEqual(deriveSessionKey(ctx({ modelKey: "m1" })), deriveSessionKey(ctx({ modelKey: "m2" })));
});

test("model이 default/미해결이면 key가 null이다(persistent 대상 아님)", () => {
  assert.equal(deriveSessionKey(ctx({ modelKey: "default" })), null);
  assert.equal(deriveSessionKey(ctx({ modelKey: "" })), null);
  assert.equal(deriveSessionKey(ctx({ modelKey: null })), null);
  assert.equal(isResolvedModel("default"), false);
  assert.equal(isResolvedModel("claude-x"), true);
});

test("identity 필드가 하나라도 없으면 key가 null이다", () => {
  for (const field of ["projectId", "workspaceId", "professionalRunId", "role", "providerId", "permissionMode"]) {
    assert.equal(deriveSessionKey(ctx({ [field]: null })), null, `${field} 누락 시 null`);
  }
  assert.equal(deriveSessionKey(null), null);
});

test("구분자 충돌이 없다(encodeURIComponent)", () => {
  // 한 필드에 '|'를 넣어도 다른 필드 조합과 섞이지 않는다.
  assert.notEqual(
    deriveSessionKey(ctx({ projectId: "a|b", workspaceId: "c" })),
    deriveSessionKey(ctx({ projectId: "a", workspaceId: "b|c" }))
  );
});

test("effort / frozenRunId / taskHash는 key에 영향을 주지 않는다", () => {
  const base = deriveSessionKey(ctx());
  assert.equal(deriveSessionKey(ctx({ effort: "high", frozenRunId: "f1", taskHash: "h1" })), base);
});
