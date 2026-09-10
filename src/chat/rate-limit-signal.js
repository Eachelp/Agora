"use strict";
// 공급자(CLI/앱서버)가 "사용량 한도"에 걸렸다는 문구를 한 곳에서 판별한다.
//
// Codex app-server는 429를 만나면 종료 이벤트 없이 조용히 재시도하기도 한다.
// 그 오류 문구를 보고 즉시 턴을 끝내지 않으면 무음 감지(죽이지 않음)·큐 정체
// 경고(큐 턴만 봄)·하드 타임아웃(기본 없음)이 모두 비켜가, "입력 중"이 영원히
// 남는다. 러너(spawn)와 Codex 어댑터가 같은 판별식을 쓰도록 여기로 모은다.
//
// 출력 상한·컨텍스트 길이 같은 "다른 종류의 limit"은 한도가 아니다 — 그건
// 실행이 진행되다 잘린 것이지 계정이 막힌 게 아니므로 구분한다.

const STRONG_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /exceeded (?:your |the )?(?:current )?(?:usage|rate|request|api)?\s*(?:limit|quota)/i,
  /사용량?\s*한도/,
  /한도(?:에|를)?\s*(?:도달|초과)/,
  /요청이 너무 많/,
];
// "limit reached/exceeded"만 있으면 약한 신호다. 출력·컨텍스트·길이 상한을 말하는
// 문맥이면 한도로 보지 않는다.
const WEAK_PATTERN = /limit (?:has been |was )?(?:reached|exceeded)/i;
const NOT_A_QUOTA_PATTERN = /(?:output|context|character|size|length|line)\s*(?:window\s*)?limit/i;

function extractResetSeconds(source) {
  // JSON/헤더 모양: resets_in_seconds, reset_after_seconds, retry-after
  const keyed = /(?:resets?_in_seconds|reset_after_seconds|retry[-_]after)["']?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(source);
  if (keyed) return Math.ceil(Number(keyed[1]));
  // 영어 산문: "try again in 12 minutes", "resets in 30 seconds", "available in 1 hour"
  const english = /(?:try again|retry|resets?|available|wait)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(source);
  if (english) return toSeconds(Number(english[1]), english[2]);
  // 한국어: "30분 후", "1시간 뒤", "45초 후"
  const korean = /(\d+(?:\.\d+)?)\s*(초|분|시간)\s*(?:후|뒤)/.exec(source);
  if (korean) return toSeconds(Number(korean[1]), korean[2]);
  return null;
}

function toSeconds(value, unit) {
  const u = String(unit || "").toLowerCase();
  if (/^(h|hr|hrs|hour|hours|시간)$/.test(u)) return Math.ceil(value * 3600);
  if (/^(m|min|mins|minute|minutes|분)$/.test(u)) return Math.ceil(value * 60);
  return Math.ceil(value);
}

function extractResetText(source) {
  // "resets at 15:30" / "resets_at: 2026-09-10T15:30" 같은 시각 표기는 그대로 넘긴다.
  const at = /resets?(?:_at)?\s*(?:at|:)\s*["']?([0-9T:\-\/ ]{4,25}(?:[AP]M)?)/i.exec(source);
  return at ? at[1].trim() : null;
}

// 한도 문구면 { limited, resetInSeconds, resetText }, 아니면 null.
function detectRateLimit(text) {
  const source = String(text || "");
  if (!source.trim()) return null;
  const strong = STRONG_PATTERNS.some((re) => re.test(source));
  const weak = !strong && WEAK_PATTERN.test(source) && !NOT_A_QUOTA_PATTERN.test(source);
  if (!strong && !weak) return null;
  return {
    limited: true,
    resetInSeconds: extractResetSeconds(source),
    resetText: extractResetText(source),
  };
}

function formatWait(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)}초`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

// 사용자에게 보일 오류 문구. 누가 막혔는지는 말풍선(에이전트)이 이미 말하므로
// 공급자 이름을 넣지 않는다.
function rateLimitMessage(info = {}) {
  const wait = formatWait(info.resetInSeconds);
  let text = "사용 한도에 도달했습니다.";
  if (wait) text += ` 약 ${wait} 후 다시 시도할 수 있습니다.`;
  else if (info.resetText) text += ` (리셋: ${info.resetText})`;
  text += " 다른 담당자에게 보내거나 리셋 후 다시 보내 주세요.";
  return text;
}

const RATE_LIMITED_STOP_REASON = "PROVIDER_RATE_LIMITED";

module.exports = { detectRateLimit, rateLimitMessage, formatWait, RATE_LIMITED_STOP_REASON };
