// Task Contract validator - checks required sections and non-empty content
// before professional execution begins.
//
// Design:
// - 6 required sections: Goal, Requirements, Implementation Approach,
//   Acceptance Criteria, Verification, Out of Scope
// - Heading matching supports ## and ### (h2/h3) only.
// - Content below a heading must be non-empty after stripping fenced code
//   blocks (a section containing only a fenced block is treated as empty).
// - Recommended sections produce warnings only, never block execution.
"use strict";

// Required sections: missing heading or empty content => contract invalid.
const REQUIRED_SECTIONS = [
  "Goal",
  "Requirements",
  "Implementation Approach",
  "Acceptance Criteria",
  "Verification",
  "Out of Scope",
];

// Recommended sections: missing heading or empty content => warning only.
const RECOMMENDED_SECTIONS = [
  "Current State / Evidence",
  "Affected Modules",
  "Invariants / Must Preserve",
  "Risks / Open Questions",
  "Dependencies",
  "Related Tasks",
];

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Candidate normalized keys for a section label.
// For required sections we only allow the exact normalized heading so the
// prompt-mandated headings cannot be satisfied by shortened aliases.
// Recommended sections still accept shortened aliases since they are non-blocking.
function candidateKeys(label) {
  const toks = tokens(label);
  const keys = new Set();
  for (let i = 1; i <= toks.length; i += 1) {
    keys.add(toks.slice(0, i).join(""));
  }
  keys.add(toks.join(""));
  return keys;
}

// Exact normalized match for required sections (no aliases).
function exactKey(label) {
  return normalizeHeading(label);
}

function normalizeHeading(value) {
  return tokens(value).join("");
}

function isFenceLine(trimmed) {
  return trimmed.startsWith(String.fromCharCode(96, 96, 96)) || trimmed.startsWith("~~~");
}

function isProtocolControlLine(trimmed) {
  if (/^STATUS:\s*[A-Z_]+(?:\s.*)?$/i.test(trimmed)) return true;
  if (/^VERDICT:\s*[A-Z_]+(?:\s.*)?$/i.test(trimmed)) return true;
  if (/^\[\[CODEPET_[A-Z0-9_]+(?::[^\]]*)?\]\]$/i.test(trimmed)) return true;
  return false;
}

// Accept ## and ### only. Returns the heading text or null.
function parseHeading(trimmed) {
  let idx = 0;
  while (idx < trimmed.length && trimmed[idx] === "#") idx += 1;
  if (idx < 2 || idx > 3) return null;
  if (idx < trimmed.length && trimmed[idx] !== " ") return null;
  let rest = trimmed.slice(idx).trim();
  if (!rest) return null;
  if (rest.endsWith(":")) rest = rest.slice(0, -1).trim();
  return rest || null;
}

// Remove fenced code blocks so a section that only contains code is treated as
// empty content.
function stripFences(lines) {
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Drop standalone protocol control lines outside code fences so a heading whose body only
    // contains control markers is treated as empty content.
    if (isProtocolControlLine(trimmed)) continue;
    out.push(line);
  }
  return out.join(String.fromCharCode(10));
}

// Extract the body of a section heading up to the next heading.
function sectionBody(headings, index, lines) {
  const start = headings[index].lineIndex + 1;
  const end = index + 1 < headings.length ? headings[index + 1].lineIndex : lines.length;
  return stripFences(lines.slice(start, end)).trim();
}

// Validate a Task Contract document.
// Returns { valid, missing, warnings, sections }.
function validateTaskContract(content) {
  const CR = String.fromCharCode(13);
  const NL = String.fromCharCode(10);
  const text = String(content || "");
  const lines = text
    .split(NL)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line));
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (inFence) {
      if (isFenceLine(trimmed)) inFence = false;
      continue;
    }
    if (isFenceLine(trimmed)) {
      inFence = true;
      continue;
    }
    const heading = parseHeading(trimmed);
    if (heading) headings.push({ heading, lineIndex: i });
  }

  const missing = [];
  const warnings = [];
  const sections = [];

  function collect(label, required) {
    const keys = new Set(required ? [exactKey(label)] : [...candidateKeys(label)]);
    let idx = -1;
    for (let i = 0; i < headings.length; i += 1) {
      if (keys.has(normalizeHeading(headings[i].heading))) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      (required ? missing : warnings).push(label);
      return;
    }
    const body = sectionBody(headings, idx, lines);
    if (!body) {
      (required ? missing : warnings).push(label);
      return;
    }
    sections.push({
      key: normalizeHeading(label),
      label,
      heading: headings[idx].heading,
      present: true,
      content: body,
    });
  }

  for (const label of REQUIRED_SECTIONS) collect(label, true);
  for (const label of RECOMMENDED_SECTIONS) collect(label, false);

  return { valid: missing.length === 0, missing, warnings, sections };
}

module.exports = {
  REQUIRED_SECTIONS,
  RECOMMENDED_SECTIONS,
  validateTaskContract,
};
