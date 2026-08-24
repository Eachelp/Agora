"use strict";

// Stage D-A1 — Assurance Contract: Frozen Task schema v2
//
// Charter가 이 단계에 요구하는 것:
//
//   INV-1  검사는 실행 전에 승인·동결된다. Task와 Verification Plan은 승인 시점에
//          canonicalize되어 hash와 함께 얼어붙는다.
//
//   INV-4  Verification Plan 자체가 충분한지는 Agora가 보증하지 않는다. 여기서는
//          "무엇이 승인되었는가"를 기계가 다시 읽을 수 있게 고정할 뿐이다.
//
// schema v1 → v2 일반화 (Charter §3):
//
//   Implementation Approach  →  Work Approach
//   Affected Modules         →  Affected Resources
//   Verification             →  Verification Plan
//   (신규) Inputs / Source Data · Deliverables
//
// 이름을 바꾼 이유는 취향이 아니다. "Implementation"과 "Modules"는 과업이 코드라고
// 전제한다. 번역·조사·보고서 과업이 같은 계약 경로로 흐르려면 어휘가 중립이어야
// 한다(Agora는 코딩 전용 도구가 아니다).
//
// 범위 밖(넣지 않음): 기존 v1 Frozen Task의 제자리 변환(§6 — 이미 동결된 과거
// 계약은 다시 쓰지 않는다), 검증 실행(D-A2), UI 표현(§9).

const crypto = require("node:crypto");

const TASK_SCHEMA_VERSION = 2;

// v2 필수 섹션. 하나라도 없거나 본문이 비면 계약이 아니다.
const V2_REQUIRED_SECTIONS = Object.freeze([
  "Goal",
  "Inputs / Source Data",
  "Requirements",
  "Work Approach",
  "Deliverables",
  "Acceptance Criteria",
  "Verification Plan",
  "Out of Scope",
]);

const V2_RECOMMENDED_SECTIONS = Object.freeze([
  "Affected Resources",
  "Current State / Evidence",
  "Invariants / Must Preserve",
  "Risks / Open Questions",
  "Dependencies",
  "Related Tasks",
]);

// v1 헤딩을 v2 의미로 읽어 주는 전이기 alias(§6 transition).
// 읽기 전용이다 — 원본 문서를 이 이름으로 다시 쓰지 않는다.
const SECTION_ALIASES = Object.freeze({
  workapproach: ["implementationapproach"],
  verificationplan: ["verification"],
  affectedresources: ["affectedmodules"],
  inputssourcedata: ["inputs", "sourcedata", "inputsdata"],
});

// "입력 없음"을 명시한 표현. 생략과 "없음"은 다른 의미이므로(Charter §3.1)
// 명시적 none만 이 목록으로 인정한다.
const EXPLICIT_NONE = Object.freeze([
  "none", "n/a", "na", "-", "없음", "해당없음", "해당 없음", "(none)", "(없음)",
]);

const INPUT_MODES = Object.freeze({ FROZEN: "frozen", LIVE: "live" });

function normalizeHeading(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .join("");
}

function isFenceLine(trimmed) {
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

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

// 문서를 헤딩 단위로 쪼갠다. fence 안의 `#`는 헤딩이 아니다.
function splitSections(content) {
  const lines = String(content || "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = parseHeading(trimmed);
    if (heading) headings.push({ heading, key: normalizeHeading(heading), lineIndex: i });
  }
  const sections = [];
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].lineIndex + 1;
    const end = i + 1 < headings.length ? headings[i + 1].lineIndex : lines.length;
    sections.push({
      heading: headings[i].heading,
      key: headings[i].key,
      body: lines.slice(start, end).join("\n").trim(),
      raw: lines.slice(start, end),
    });
  }
  return sections;
}

// 섹션 조회. 정식 이름 → alias 순으로 찾는다.
function findSection(sections, label) {
  const canonical = normalizeHeading(label);
  const keys = [canonical, ...(SECTION_ALIASES[canonical] || [])];
  for (const key of keys) {
    const found = sections.find((s) => s.key === key);
    if (found) return { ...found, matchedAlias: key !== canonical ? key : null };
  }
  return null;
}

// fence 블록만으로 내용이 성립하는 섹션. Verification Plan의 실제 계약은
// ```json 블록이므로 여기서 "본문 없음"으로 보면 구조화된 계획을 쓸 수 없다.
const FENCE_IS_CONTENT = new Set([
  normalizeHeading("Verification Plan"),
  normalizeHeading("Verification"),
]);

// fence와 프로토콜 제어줄을 걷어낸 뒤에도 내용이 남는가.
function hasSubstance(section) {
  if (!section) return false;
  let inFence = false;
  for (const line of section.raw) {
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      // fence가 내용인 섹션은 블록이 열린 것만으로 본문이 있다고 본다.
      if (FENCE_IS_CONTENT.has(section.key)) return true;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) continue;
    if (/^STATUS:\s*[A-Z_]+/i.test(trimmed)) continue;
    if (/^VERDICT:\s*[A-Z_]+/i.test(trimmed)) continue;
    if (/^\[\[CODEPET_[A-Z0-9_]+(?::[^\]]*)?\]\]$/i.test(trimmed)) continue;
    return true;
  }
  return false;
}

function listItems(body) {
  const out = [];
  let inFence = false;
  for (const line of String(body || "").split("\n")) {
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^[-*+]\s+(.*)$/.exec(trimmed) || /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (match && match[1].trim()) out.push(match[1].trim());
  }
  return out;
}

function isExplicitNone(body) {
  const items = listItems(body);
  const candidates = items.length > 0 ? items : [String(body || "").trim()];
  if (candidates.length !== 1) return false;
  const only = candidates[0].toLowerCase().replace(/[`*_]/g, "").trim();
  return EXPLICIT_NONE.includes(only);
}

function stripDecorations(value) {
  return String(value || "").replace(/^[`"']+|[`"']+$/g, "").trim();
}

function looksLikeUrl(value) {
  return /^(https?|ftp):\/\//i.test(String(value || "").trim());
}

// "`data/sales.csv` (frozen) — 매출 원본" 형태의 한 줄을 input으로 읽는다.
// mode를 명시하지 않으면 URL은 live, 그 외(작업 폴더 파일)는 frozen이 기본이다.
// 파일은 "같은 내용이어야 한다"가 기본 기대이기 때문이다.
function parseInputItem(text, index) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let mode = null;
  const modeMatch = /\((frozen|live|동결|실시간)\)/i.exec(raw);
  if (modeMatch) {
    const token = modeMatch[1].toLowerCase();
    mode = token === "live" || token === "실시간" ? INPUT_MODES.LIVE : INPUT_MODES.FROZEN;
  }
  const withoutMode = raw.replace(/\((frozen|live|동결|실시간)\)/gi, " ").trim();
  const [locatorPart, ...descParts] = withoutMode.split(/\s+[—–-]{1,2}\s+/);
  const locator = stripDecorations(locatorPart);
  if (!locator) return null;
  const isUrl = looksLikeUrl(locator);
  return {
    inputId: `IN-${String(index + 1).padStart(2, "0")}`,
    locator,
    kind: isUrl ? "url" : "path",
    mode: mode || (isUrl ? INPUT_MODES.LIVE : INPUT_MODES.FROZEN),
    modeDeclared: Boolean(mode),
    description: descParts.join(" — ").trim() || null,
  };
}

function parseDeliverableItem(text, index) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const [locatorPart, ...descParts] = raw.split(/\s+[—–-]{1,2}\s+/);
  const locator = stripDecorations(locatorPart);
  if (!locator) return null;
  return {
    deliverableId: `DL-${String(index + 1).padStart(2, "0")}`,
    locator,
    kind: looksLikeUrl(locator) ? "url" : "path",
    description: descParts.join(" — ").trim() || null,
  };
}

// Inputs / Deliverables는 셋 중 하나로 판정된다.
//   declared  실제 항목이 있음
//   none      "없음"이라고 명시함
//   missing   섹션이 없거나 비어 있음 → 계약 불완전
//
// 생략과 "없음"을 같은 것으로 처리하면 Planner가 입력 검토를 건너뛴 것을
// "입력이 없는 과업"으로 위장할 수 있다(Charter §3.1).
function parseItemSection(sections, label, itemParser) {
  const section = findSection(sections, label);
  if (!section || !hasSubstance(section)) {
    return { state: "missing", items: [], matchedAlias: section?.matchedAlias || null };
  }
  if (isExplicitNone(section.body)) {
    return { state: "none", items: [], matchedAlias: section.matchedAlias || null };
  }
  const items = listItems(section.body)
    .map((text, index) => itemParser(text, index))
    .filter(Boolean);
  if (items.length === 0) {
    // 본문은 있는데 항목을 못 읽었다. 조용히 "없음"으로 만들지 않는다.
    return { state: "unparsed", items: [], matchedAlias: section.matchedAlias || null, body: section.body };
  }
  return { state: "declared", items, matchedAlias: section.matchedAlias || null };
}

// M1 — 토론 결정과 Frozen Task를 잇는다(Charter §4).
// "Decision: D-12, D-15" / "결정: D-12" / 리스트 항목 어디에 있어도 읽는다.
function parseDecisionIds(content) {
  const found = new Set();
  const pattern = /(?:^|\n)\s*(?:[-*+]\s*)?(?:decisions?|결정(?:\s*사항)?)\s*(?:ids?)?\s*[::]\s*([^\n]+)/gi;
  let match;
  while ((match = pattern.exec(String(content || ""))) !== null) {
    for (const token of match[1].split(/[,、·\s]+/)) {
      const id = stripDecorations(token);
      if (id && id.toLowerCase() !== "none" && !EXPLICIT_NONE.includes(id.toLowerCase())) {
        found.add(id.slice(0, 120));
      }
    }
  }
  return [...found];
}

// canonicalize — 표기 차이로 hash가 흔들리지 않게 정규화한다.
// 줄 끝 공백·CRLF·문서 끝 공백만 정리하고 내용은 건드리지 않는다.
// (내용을 고치기 시작하면 "사용자가 승인한 그 문서"가 아니게 된다.)
function canonicalizeTaskContent(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// 문서가 v2 계약인지, v1인지 판정한다. v1 문서를 v2로 가장하지 않는다.
function detectSchemaVersion(content) {
  const sections = splitSections(content);
  const hasV2Only = ["Inputs / Source Data", "Deliverables"].every((label) => {
    const section = findSection(sections, label);
    return Boolean(section && hasSubstance(section));
  });
  return hasV2Only ? 2 : 1;
}

// v2 계약을 읽어 구조화한다. 파싱 실패를 통과로 만들지 않는다.
function parseTaskV2(content) {
  const canonical = canonicalizeTaskContent(content);
  const sections = splitSections(canonical);

  const missing = [];
  const warnings = [];
  const usedAliases = [];
  const resolved = {};

  for (const label of V2_REQUIRED_SECTIONS) {
    const section = findSection(sections, label);
    if (!section || !hasSubstance(section)) {
      missing.push(label);
      continue;
    }
    if (section.matchedAlias) usedAliases.push({ label, alias: section.matchedAlias });
    resolved[normalizeHeading(label)] = section;
  }
  for (const label of V2_RECOMMENDED_SECTIONS) {
    const section = findSection(sections, label);
    if (!section || !hasSubstance(section)) warnings.push(label);
    else if (section.matchedAlias) usedAliases.push({ label, alias: section.matchedAlias });
  }

  const inputs = parseItemSection(sections, "Inputs / Source Data", parseInputItem);
  const deliverables = parseItemSection(sections, "Deliverables", parseDeliverableItem);

  // 섹션은 있는데 항목을 읽지 못한 경우는 계약 불완전으로 본다.
  if (inputs.state === "unparsed") missing.push("Inputs / Source Data (항목을 읽을 수 없음)");
  if (deliverables.state === "unparsed") missing.push("Deliverables (항목을 읽을 수 없음)");

  const verificationSection = findSection(sections, "Verification Plan");

  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    valid: missing.length === 0,
    missing,
    warnings,
    usedAliases,
    canonicalContent: canonical,
    taskHash: hashText(canonical),
    sections: sections.map((s) => ({ heading: s.heading, key: s.key })),
    goal: resolved[normalizeHeading("Goal")]?.body || null,
    requirements: resolved[normalizeHeading("Requirements")]?.body || null,
    workApproach: resolved[normalizeHeading("Work Approach")]?.body || null,
    acceptanceCriteria: resolved[normalizeHeading("Acceptance Criteria")]?.body || null,
    outOfScope: resolved[normalizeHeading("Out of Scope")]?.body || null,
    affectedResources: findSection(sections, "Affected Resources")?.body || null,
    inputs,
    deliverables,
    verificationPlanBody: verificationSection?.body || null,
    decisionIds: parseDecisionIds(canonical),
  };
}

module.exports = {
  TASK_SCHEMA_VERSION,
  V2_REQUIRED_SECTIONS,
  V2_RECOMMENDED_SECTIONS,
  SECTION_ALIASES,
  INPUT_MODES,
  normalizeHeading,
  splitSections,
  findSection,
  listItems,
  isExplicitNone,
  canonicalizeTaskContent,
  hashText,
  detectSchemaVersion,
  parseTaskV2,
  parseDecisionIds,
};
