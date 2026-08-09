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

// \uae30\ub85d\uad00 \ucd9c\ub825\uc744 \ud30c\uc2f1\ud574 \uc694\uc57d\uacfc \uacb0\uc815\u00b7\uc791\uc5c5 \ud6c4\ubcf4\ub85c \ubd84\ub9ac\ud569\ub2c8\ub2e4.
// \uc5b4\ub5a4 \uc785\ub825\uc774\ub77c\ub3c4 \uc608\uc678\ub97c \ub358\uc9c0\uc9c0 \uc54a\uace0, \ud30c\uc2f1\uc5d0 \uc2e4\ud328\ud558\uba74 \uc6d0\ubb38 \uc804\uccb4\ub97c \uc694\uc57d\uc73c\ub85c \ub3cc\ub824\ubcf4\ub0b4\uc11c
// \uae30\ub85d\uad00\uc758 \uc791\uc5c5 \uacb0\uacfc\uac00 \uc0ac\ub77c\uc9c0\uc9c0 \uc54a\uac8c \ud569\ub2c8\ub2e4.
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
