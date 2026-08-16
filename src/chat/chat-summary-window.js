"use strict";

const DEFAULT_WINDOW_TRIGGER_MESSAGES = 18;
const DEFAULT_WINDOW_TRIGGER_CHARS = 12 * 1024;
const DEFAULT_RECENT_MESSAGES = 12;
const DEFAULT_SUMMARY_CHARS = 6 * 1024;
const DEFAULT_SUMMARY_ITEM_CHARS = 600;
const DEFAULT_PINNED_MESSAGE_CHARS = 1200;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function compactText(value, limit) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  const notice = " … ";
  const budget = Math.max(0, limit - notice.length);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return `${text.slice(0, head)}${notice}${text.slice(-tail)}`;
}

function firstPinnedIndex(messages, recentStart) {
  for (let index = 0; index < recentStart; index += 1) {
    if (messages[index]?.authorType === "user") return index;
  }
  return recentStart > 0 ? 0 : -1;
}

function buildConversationWindow(messages, options = {}) {
  const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const maxMessages = positiveInteger(options.maxMessages, 40);
  const triggerMessages = Math.min(
    maxMessages,
    positiveInteger(options.triggerMessages, DEFAULT_WINDOW_TRIGGER_MESSAGES)
  );
  const triggerChars = positiveInteger(options.triggerChars, DEFAULT_WINDOW_TRIGGER_CHARS);
  const recentLimit = Math.min(
    maxMessages,
    positiveInteger(options.recentMessages, DEFAULT_RECENT_MESSAGES)
  );
  const summaryChars = positiveInteger(options.summaryChars, DEFAULT_SUMMARY_CHARS);
  const summaryItemChars = positiveInteger(options.summaryItemChars, DEFAULT_SUMMARY_ITEM_CHARS);
  const totalChars = source.reduce((sum, message) => sum + String(message?.text || "").length, 0);

  const shouldCompact = source.length > triggerMessages || totalChars > triggerChars;
  if (!shouldCompact) {
    const recent = source.slice(-maxMessages);
    return {
      compacted: false,
      pinned: [],
      summary: [],
      recent,
      omitted: Math.max(0, source.length - recent.length),
      sourceCount: source.length,
      sourceChars: totalChars,
    };
  }

  const recentCount = Math.max(1, Math.min(recentLimit, source.length));
  const recentStart = Math.max(0, source.length - recentCount);
  const recent = source.slice(recentStart);
  const pinnedIndex = firstPinnedIndex(source, recentStart);
  const pinned = pinnedIndex >= 0
    ? [{
        ...source[pinnedIndex],
        text: compactText(source[pinnedIndex]?.text, DEFAULT_PINNED_MESSAGE_CHARS),
      }]
    : [];

  const candidates = [];
  for (let index = 0; index < recentStart; index += 1) {
    if (index === pinnedIndex) continue;
    const message = source[index];
    candidates.push({
      ...message,
      text: compactText(message?.text, summaryItemChars),
    });
  }

  // 첫 사용자 요청은 pinned로 별도 보존하므로, 압축 기록은 최근에 가까운
  // 과거를 우선한다. budget 안에 들어온 항목의 원래 순서는 유지한다.
  const summary = [];
  let used = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const cost = String(candidate.text || "").length + 32;
    if (summary.length > 0 && used + cost > summaryChars) break;
    if (summary.length === 0 && cost > summaryChars) {
      summary.push({ ...candidate, text: compactText(candidate.text, Math.max(1, summaryChars - 32)) });
      break;
    }
    summary.push(candidate);
    used += cost;
  }
  summary.reverse();

  return {
    compacted: true,
    pinned,
    summary,
    recent,
    // 기존 maxMessages 계약과 동일하게, recent 원문에서 제외된 raw 메시지 수다.
    omitted: Math.max(0, source.length - recent.length),
    sourceCount: source.length,
    sourceChars: totalChars,
  };
}

module.exports = {
  buildConversationWindow,
  compactText,
  DEFAULT_WINDOW_TRIGGER_MESSAGES,
  DEFAULT_WINDOW_TRIGGER_CHARS,
  DEFAULT_RECENT_MESSAGES,
  DEFAULT_SUMMARY_CHARS,
  DEFAULT_SUMMARY_ITEM_CHARS,
};
