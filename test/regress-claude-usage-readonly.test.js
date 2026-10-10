"use strict";

// F165 사용량 조회가 Claude refresh 토큰을 소비하지 않는다(저장 실패 시 CLI 로그인이 풀리던 문제).

const test = require("node:test");
const assert = require("node:assert/strict");

const { clearUsageCache, fetchClaudeUsage } = require("../src/provider-usage");

function makeStore(oauth) {
  const calls = { write: 0 };
  return {
    calls,
    read: () => ({ claudeAiOauth: oauth }),
    write: () => { calls.write += 1; throw new Error("EPERM: 저장 실패"); },
  };
}

function withFetch(t, handler) {
  const original = global.fetch;
  const urls = [];
  global.fetch = async (url, options) => {
    urls.push(String(url));
    return handler(String(url), options);
  };
  t.after(() => {
    global.fetch = original;
    clearUsageCache("claude");
  });
  return urls;
}

test("F165: 만료 직전 토큰이어도 refresh 요청을 보내지 않고 저장소에 쓰지 않는다", async (t) => {
  clearUsageCache("claude");
  const urls = withFetch(t, () => ({ ok: true, status: 200, json: async () => ({}) }));
  const store = makeStore({ accessToken: "a", refreshToken: "r-live", expiresAt: Date.now() + 1000 });

  await fetchClaudeUsage({ credentialStore: store, force: true });
  assert.deepEqual(urls, ["https://api.anthropic.com/api/oauth/usage"]);
  assert.equal(store.calls.write, 0);
});

test("F165: 401이면 refresh하지 않고 만료 안내로 끝낸다", async (t) => {
  clearUsageCache("claude");
  const urls = withFetch(t, () => ({ ok: false, status: 401, json: async () => ({}) }));
  const store = makeStore({ accessToken: "a", refreshToken: "r-live", expiresAt: Date.now() + 3600000 });

  await assert.rejects(
    () => fetchClaudeUsage({ credentialStore: store, force: true }),
    (error) => error.expired === true && /토큰 만료/.test(error.message)
  );
  assert.equal(urls.some((url) => /oauth\/token/.test(url)), false, "토큰 교환을 보내지 않는다");
  assert.equal(store.calls.write, 0);
});
