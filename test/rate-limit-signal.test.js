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

test("rateLimitMessage: 공급자 원문 안내는 지우지 않고 앞에 두고, 리셋을 이미 말했으면 대기 시간을 중복해 붙이지 않는다", () => {
  // Claude CLI가 준 깔끔한 안내는 그대로 살아야 한다(리셋 시각 "5pm (Asia/Seoul)" 포함).
  const claudeText = "You've hit your usage limit. Your limit will reset at 5pm (Asia/Seoul).";
  const claude = rateLimitMessage(detectRateLimit(claudeText), claudeText);
  assert.ok(claude.startsWith(claudeText), "원문이 그대로 앞에 남는다");
  assert.ok(!/약 \d+분 후/.test(claude) && !/리셋: /.test(claude), "원문이 리셋을 말하면 덧붙이지 않는다");
  assert.match(claude, /다른 담당자에게/);
  const codex = rateLimitMessage({ resetInSeconds: 720 }, "Rate limit reached. Please try again in 12 minutes.");
  assert.ok(codex.startsWith("Rate limit reached. Please try again in 12 minutes."));
  assert.ok(!/약 12분/.test(codex));
  // 원문이 리셋을 말하지 않으면 계산한 대기 시간을 덧붙인다.
  const bare = rateLimitMessage({ resetInSeconds: 300 }, "Error: You exceeded your current quota, resets_in_seconds: 300");
  assert.ok(bare.startsWith("Error: You exceeded your current quota"));
  assert.match(bare, /약 5분 후/);
  // 원문이 JSON 조각이면 사람용 기본 문구로 바꾸고 계산한 대기 시간을 붙인다.
  const raw = rateLimitMessage({ resetInSeconds: 540 }, '{"error":{"message":"You exceeded your current quota","resets_in_seconds":540}}');
  assert.match(raw, /^사용 한도에 도달했습니다\./);
  assert.match(raw, /약 9분 후/);
});

test("extractResetText: 'resets at 5pm (Asia/Seoul)' 같은 시각+시간대도 그대로 살린다", () => {
  assert.equal(detectRateLimit("Usage limit hit, resets at 5pm (Asia/Seoul)").resetText, "5pm (Asia/Seoul)");
  assert.equal(detectRateLimit("Usage limit exceeded, resets at 15:30").resetText, "15:30");
  assert.equal(detectRateLimit("rate limit; reset_at: 2026-09-10T15:30").resetText, "2026-09-10T15:30");
  assert.equal(detectRateLimit("Rate limited. Resets at 5:00 PM").resetText, "5:00 PM");
});
