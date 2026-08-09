const CODE_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/i;

function cleanText(value, limit = 20000) {
  return String(value || "").trim().slice(0, limit);
}

function cleanIds(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))].slice(0, limit);
}

function normalizeDecisionCandidate(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = cleanText(entry.title, 120);
  const content = cleanText(entry.content, 20000);
  if (!content) return null;
  return { title, content, messageIds: cleanIds(entry.messageIds) };
}

function normalizeActionCandidate(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = cleanText(entry.title, 160);
  if (!title) return null;
  const description = cleanText(entry.description ?? entry.content, 20000);
  return { title, description, messageIds: cleanIds(entry.messageIds) };
}

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fallthrough
  }
  return null;
}

function extractJsonCandidate(text) {
  const codeBlockMatch = text.match(CODE_BLOCK_RE);
  if (codeBlockMatch) {
    const parsed = tryParseJson(codeBlockMatch[1].trim());
    if (parsed) return parsed;
  }
  const directParsed = tryParseJson(text.trim());
  if (directParsed) return directParsed;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start > -1 && end > start) {
    const parsed = tryParseJson(text.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

// 기록관 출력을 파싱해 요약과 결정·작업 후보로 분리합니다.
// 어떤 입력이라도 예외를 던지지 않고, 파싱에 실패하면 원문 전체를 요약으로 돌려보내서
// 기록관의 작업 결과가 사라지지 않게 합니다.
function parseRecorderOutput(text) {
  const raw = String(text || "");
  const fallback = { summary: raw.trim(), decisions: [], nextActions: [] };
  if (!raw.trim()) return fallback;

  const parsed = extractJsonCandidate(raw);
  if (!parsed) return fallback;

  const summary = cleanText(parsed.summary, 20000) || fallback.summary;
  const decisions = Array.isArray(parsed.decisions)
    ? parsed.decisions.map(normalizeDecisionCandidate).filter(Boolean)
    : [];
  const nextActions = Array.isArray(parsed.nextActions)
    ? parsed.nextActions.map(normalizeActionCandidate).filter(Boolean)
    : [];

  return { summary, decisions, nextActions };
}

module.exports = { parseRecorderOutput };
