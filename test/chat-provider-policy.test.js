"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  processProviderPolicy,
  SUPPORTED_PROCESS_PROVIDERS,
} = require("../src/chat/chat-provider-policy");

test("현재 Process runner가 명시적으로 지원하는 harness만 허용한다", () => {
  assert.deepEqual([...SUPPORTED_PROCESS_PROVIDERS].sort(), ["agy", "claude", "codex"]);
  for (const id of SUPPORTED_PROCESS_PROVIDERS) {
    assert.deepEqual(processProviderPolicy({ id }), { ok: true, providerId: id });
  }
});

test("등록되지 않은 harness는 빈 argv fallback 대신 fail-closed 한다", () => {
  const result = processProviderPolicy({ id: "future-harness" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNSUPPORTED_PROCESS_PROVIDER");
  assert.match(result.error, /HarnessAdapter/);
});

test("provider id가 없으면 실행하지 않는다", () => {
  const result = processProviderPolicy({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROVIDER_ID_MISSING");
});
