const test = require("node:test");
const assert = require("node:assert/strict");
const { detectRateLimit, rateLimitMessage, formatWait } = require("../src/chat/rate-limit-signal");

test("detectRateLimit: 한도 문구를 잡고 리셋 시간을 초로 뽑는다", () => {
  const a = detectRateLimit("Rate limit reached for gpt-x. Please try again in 12 minutes.");
  assert.equal(a.limited, true);
  assert.equal(a.resetInSeconds, 720);
  const b = detectRateLimit('{"error":{"message":"You exceeded your current quota","resets_in_seconds":540}}');
  assert.equal(b.limited, true);
  assert.equal(b.resetInSeconds, 540);
  const c = detectRateLimit("사용량 한도에 도달했습니다. 30분 후 다시 시도해 주세요.");
  assert.equal(c.limited, true);
  assert.equal(c.resetInSeconds, 1800);
  const d = detectRateLimit("HTTP 429 Too Many Requests");
  assert.equal(d.limited, true);
  assert.equal(d.resetInSeconds, null);
  const e = detectRateLimit("Usage limit exceeded, resets at 15:30");
  assert.equal(e.limited, true);
  assert.equal(e.resetText, "15:30");
});

test("detectRateLimit: 출력·컨텍스트 상한이나 무관한 오류는 한도가 아니다", () => {
  assert.equal(detectRateLimit("output limit reached, truncating"), null);
  assert.equal(detectRateLimit("context length limit exceeded"), null);
  assert.equal(detectRateLimit("프록시 연결 거부"), null);
  assert.equal(detectRateLimit(""), null);
  assert.equal(detectRateLimit(null), null);
});

test("rateLimitMessage: 대기 시간을 사람이 읽는 단위로 붙이고 탈출 방법을 안내한다", () => {
  assert.match(rateLimitMessage({ resetInSeconds: 720 }), /약 12분 후/);
  assert.match(rateLimitMessage({ resetInSeconds: 45 }), /약 45초 후/);
  assert.match(rateLimitMessage({ resetInSeconds: 5400 }), /약 1시간 30분 후/);
  assert.match(rateLimitMessage({ resetText: "15:30" }), /리셋: 15:30/);
  assert.match(rateLimitMessage({}), /다른 담당자에게 보내거나/);
  assert.equal(formatWait(0), null);
});
