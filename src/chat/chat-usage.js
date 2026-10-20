"use strict";

// 실행별 토큰 사용량(2026-10-20). 공급자 CLI가 원본 출력에 남기는 사용량 줄만 골라 읽어, 공급자마다 다른 필드를
// 한 모양으로 맞춘다: { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, costUsd }.
// inputTokens는 캐시를 뺀 새 입력이다(Codex는 input_tokens에 캐시가 들어 있어 빼 준다). 공급자가 주지 않는 값은 0,
// costUsd는 Claude만 준다(그 밖은 null). 사용량 줄이 하나도 없으면 snapshot()은 null이라 기록에 필드가 생기지 않는다.
//
// 줄 전체를 JSON으로 읽기 전에 줄 안의 표지 문자열로 먼저 거른다 — Claude 스트림은 줄이 수천 개고 파서가 이미 한 번 읽는다.
// Claude의 result 줄은 "type" 키가 줄 끝쪽에 있으므로(실측: duration_api_ms, … , usage, …, type, …) 줄 머리 모양에 기대지 않는다.

function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// 공급자별 읽기. mode: "replace"는 마지막으로 읽은 값이 실행 전체의 값, "add"는 읽을 때마다 더한다.
const READERS = Object.freeze({
  claude: {
    mode: "replace",
    matches: (line) => line.includes('"usage"') && /"type"\s*:\s*"result"/.test(line),
    read(raw) {
      const usage = raw?.type === "result" ? raw.usage : null;
      if (!usage || typeof usage !== "object") return null;
      return {
        inputTokens: count(usage.input_tokens),
        cacheReadTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens),
        outputTokens: count(usage.output_tokens),
        reasoningTokens: count(usage.output_tokens_details?.thinking_tokens),
        costUsd: Number.isFinite(raw.total_cost_usd) && raw.total_cost_usd >= 0 ? raw.total_cost_usd : null,
      };
    },
  },
  codex: {
    mode: "add",
    matches: (line) => /"type"\s*:\s*"turn\.completed"/.test(line),
    read(raw) {
      const usage = raw?.type === "turn.completed" ? raw.usage : null;
      if (!usage || typeof usage !== "object") return null;
      const cached = count(usage.cached_input_tokens);
      return {
        inputTokens: Math.max(0, count(usage.input_tokens) - cached),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: count(usage.output_tokens),
        reasoningTokens: count(usage.reasoning_output_tokens),
        costUsd: null,
      };
    },
  },
  agy: {
    mode: "replace",
    // JSON 키 순서에 기대지 않는다. 걸러진 줄은 read()가 event를 한 번 더 확인한다.
    matches: (line) => line.includes('"usage"') && /"event"\s*:\s*"result"/.test(line),
    read(raw) {
      const usage = raw?.event === "result" ? raw.result?.usage : null;
      if (!usage || typeof usage !== "object") return null;
      return {
        inputTokens: count(usage.input_tokens),
        cacheReadTokens: count(usage.cache_read_tokens),
        cacheWriteTokens: 0,
        outputTokens: count(usage.output_tokens),
        reasoningTokens: count(usage.thinking_tokens),
        costUsd: null,
      };
    },
  },
});

function createUsageCollector(providerId) {
  const reader = READERS[providerId];
  if (!reader) return null;
  let total = null;
  return {
    observeLine(line) {
      const text = String(line || "");
      if (!reader.matches(text)) return;
      const read = reader.read(parseJson(text));
      if (!read) return;
      if (reader.mode === "replace" || !total) {
        total = { ...read };
        return;
      }
      for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"]) total[key] += read[key];
    },
    snapshot() {
      return total ? { ...total } : null;
    },
  };
}

// 저장 경계에서 한 번 더 모양을 맞춘다(chat-run-metrics가 쓴다).
function normalizeTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  return {
    inputTokens: count(tokens.inputTokens),
    cacheReadTokens: count(tokens.cacheReadTokens),
    cacheWriteTokens: count(tokens.cacheWriteTokens),
    outputTokens: count(tokens.outputTokens),
    reasoningTokens: count(tokens.reasoningTokens),
    costUsd: Number.isFinite(tokens.costUsd) && tokens.costUsd >= 0 ? tokens.costUsd : null,
  };
}

module.exports = { createUsageCollector, normalizeTokens };
