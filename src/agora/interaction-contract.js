"use strict";

// V1.5 Interaction/Handoff 계약 (AGORA_V1_5_PROPOSAL.md §6, §8).
// 이 모듈은 순수 로직이다 — 저장, IPC, ChatRoom 상태를 만지지 않는다.
// Target/Intent/Scope/executionPolicy의 의미와 역할 Handoff 허용 전이표를
// 데이터로 고정해, 이후 단계(직접 역할 호출, @모두, AI Handoff)가 전부
// 여기서 검증을 받게 한다.

const crypto = require("node:crypto");

const INTERACTION_TARGETS = Object.freeze(["planner", "builder", "reviewer", "recorder", "all"]);

const INTERACTION_INTENTS = Object.freeze(["CONSULT", "PLAN", "REVIEW", "EXECUTE", "SUMMARIZE"]);

const INTERACTION_SCOPES = Object.freeze(["SINGLE", "TEAM"]);

const EXECUTION_POLICIES = Object.freeze([
  "NONE",
  "STOP_AT_READY",
  "EXECUTE_READY",
  "PREAUTHORIZED_BOUNDED",
]);

// 멘션은 Target이지 실행 승인이 아니다(INV-2). 명시 metadata가 없으면
// 항상 읽기 전용 단일 응답으로 정규화한다(제안서 §6.2). 자연어 추측만으로
// executionPolicy를 올리는 경로는 이 모듈에 존재하지 않는다.
function normalizeInteraction(input = {}) {
  const target = INTERACTION_TARGETS.includes(input.target) ? input.target : null;
  const rawIntent = String(input.intent || "").toUpperCase();
  const intent = INTERACTION_INTENTS.includes(rawIntent) ? rawIntent : "CONSULT";
  const rawScope = String(input.scope || "").toUpperCase();
  const scope = INTERACTION_SCOPES.includes(rawScope) ? rawScope : "SINGLE";
  const rawPolicy = String(input.executionPolicy || "").toUpperCase();
  const executionPolicy = EXECUTION_POLICIES.includes(rawPolicy) ? rawPolicy : "NONE";
  return { target, intent, scope, executionPolicy };
}

// Handoff 전이표의 역할 어휘. "reviewer"는 사용자 표면 이름이며, 실제 계약은
// resolveReviewerContract가 출처와 artifact로 고른다(제안서 §7.2).
const HANDOFF_ROLES = Object.freeze([
  "planner",
  "plan_review",
  "ready",
  "builder",
  "review",
  "complete",
  "archivist",
  "user",
]);

// 제안서 §8.2 허용 전이표. 여기 없는 전이는 전부 거부된다(fail-closed).
const HANDOFF_TRANSITIONS = Object.freeze({
  planner: Object.freeze(["plan_review", "user"]),
  plan_review: Object.freeze(["planner", "ready"]),
  ready: Object.freeze(["builder"]),
  builder: Object.freeze(["review", "planner", "user"]),
  review: Object.freeze(["builder", "complete", "user"]),
  complete: Object.freeze(["archivist"]),
  archivist: Object.freeze(["user"]),
});

// 역할 출력에서 HANDOFF 대상을 지목할 때 쓰는 표면 별칭.
// 전부 완전 단어형만 둔다 — tokenMatchesAlias류의 prefix 매칭에 한글 별칭이
// 더 긴 단어에 삼켜지는 위험(기획 ↔ 기획자)을 피한다.
const HANDOFF_TARGET_ALIASES = Object.freeze({
  planner: Object.freeze(["planner", "기획자"]),
  builder: Object.freeze(["builder", "implementation", "구현자"]),
  reviewer: Object.freeze(["reviewer", "검토자", "검수자"]),
  recorder: Object.freeze(["recorder", "기록자"]),
  archivist: Object.freeze(["archivist"]),
  user: Object.freeze(["user", "사용자"]),
});

function isHandoffAllowed(fromRole, toRole) {
  const allowed = HANDOFF_TRANSITIONS[String(fromRole || "")];
  if (!allowed) return false;
  return allowed.includes(String(toRole || ""));
}

// Reviewer 계약 선택은 요청 문구가 아니라 출처 역할과 artifact 종류로 한다
// (제안서 §7.2, §16 P1 "잘못된 Reviewer 계약 선택" 방어).
function resolveReviewerContract({ sourceRole, hasFrozenArtifacts } = {}) {
  if (hasFrozenArtifacts) return "review";
  if (sourceRole === "builder") return "review";
  return "plan_review";
}

const DEFAULT_HANDOFF_BUDGET = 8;

// 사용자 발화 1회에서 파생되는 AI Handoff의 소비 원장(제안서 §8.3, §8.4).
// - 총 상한(budget)
// - 한 시점 active invocation 1개
// - 같은 invocationId 재소비 금지 (취소 뒤 늦게 도착한 요청, 재시작 중복 방어)
// - 동일 역할 연속 호출 금지
function createHandoffLedger(options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget > 0
    ? options.budget
    : DEFAULT_HANDOFF_BUDGET;
  return {
    budget,
    used: 0,
    consumedInvocationIds: new Set(
      Array.isArray(options.consumedInvocationIds) ? options.consumedInvocationIds : [],
    ),
    lastTargetRole: options.lastTargetRole || null,
    activeInvocationId: options.activeInvocationId || null,
  };
}

function newInvocationId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `inv-${ts}-${rand}`;
}

// Handoff 요청 검증. 통과해도 실행하지 않는다 — 모델은 요청하고 Runtime이
// 결정한다(INV-6). 실제 소비는 consumeHandoff로만 기록한다.
function validateHandoff(request = {}, state = {}) {
  const fromRole = String(request.sourceRole || "");
  const toRole = String(request.targetRole || "");
  const ledger = state.ledger || null;

  if (!HANDOFF_ROLES.includes(fromRole) || !HANDOFF_ROLES.includes(toRole)) {
    return { ok: false, reason: "HANDOFF_NOT_ALLOWED" };
  }
  if (fromRole === toRole) {
    return { ok: false, reason: "HANDOFF_SELF" };
  }
  if (!isHandoffAllowed(fromRole, toRole)) {
    return { ok: false, reason: "HANDOFF_NOT_ALLOWED" };
  }

  // 취소·세대 교체 뒤 늦게 도착한 요청과 다른 run의 요청을 폐기한다(§8.4).
  if (
    state.professionalRunId != null &&
    request.professionalRunId != null &&
    String(request.professionalRunId) !== String(state.professionalRunId)
  ) {
    return { ok: false, reason: "HANDOFF_STALE" };
  }
  if (
    state.generation != null &&
    request.generation != null &&
    request.generation !== state.generation
  ) {
    return { ok: false, reason: "HANDOFF_STALE" };
  }

  if (ledger) {
    if (request.invocationId && ledger.consumedInvocationIds.has(request.invocationId)) {
      return { ok: false, reason: "HANDOFF_DUPLICATE" };
    }
    if (ledger.activeInvocationId && ledger.activeInvocationId !== request.invocationId) {
      return { ok: false, reason: "HANDOFF_BUSY" };
    }
    if (ledger.lastTargetRole && ledger.lastTargetRole === toRole) {
      return { ok: false, reason: "HANDOFF_SELF" };
    }
    if (ledger.used >= ledger.budget) {
      return { ok: false, reason: "HANDOFF_BUDGET_REACHED" };
    }
  }

  return { ok: true };
}

// 검증을 통과한 요청을 원장에 소비 기록한다. 실패한 검증 결과를 되돌려주며
// 원장은 건드리지 않는다(fail-closed).
function consumeHandoff(request = {}, state = {}) {
  const verdict = validateHandoff(request, state);
  if (!verdict.ok) return verdict;
  const ledger = state.ledger;
  if (ledger) {
    ledger.used += 1;
    const invocationId = request.invocationId || newInvocationId();
    ledger.consumedInvocationIds.add(invocationId);
    ledger.activeInvocationId = invocationId;
    ledger.lastTargetRole = String(request.targetRole);
    return { ok: true, invocationId };
  }
  return { ok: true, invocationId: request.invocationId || newInvocationId() };
}

// active invocation이 끝났음을 기록한다. id가 다르면 무시한다(늦은 완료 보고).
function settleHandoff(ledger, invocationId) {
  if (!ledger) return false;
  if (!invocationId || ledger.activeInvocationId !== invocationId) return false;
  ledger.activeInvocationId = null;
  return true;
}

const HANDOFF_LINE_PATTERN = /^[ \t]*HANDOFF:[ \t]*@?([\p{L}\p{N}_-]+)[ \t]*$/gimu;
const PURPOSE_LINE_PATTERN = /^[ \t]*PURPOSE:[ \t]*([^\r\n]+?)[ \t]*$/im;
const REASON_LINE_PATTERN = /^[ \t]*REASON:[ \t]*([^\r\n]+?)[ \t]*$/im;

function maskCodeFences(text) {
  return String(text || "")
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\r\n]*`/g, (match) => " ".repeat(match.length));
}

function handoffTargetForToken(token) {
  const lowered = String(token || "").toLowerCase();
  for (const [role, aliases] of Object.entries(HANDOFF_TARGET_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === lowered)) return role;
  }
  return null;
}

// 역할 출력에서 구조화 Handoff 요청을 파싱한다(제안서 §8.1).
// - 일반 문장 속 @reviewer는 Handoff가 아니다. 줄 전체가
//   `HANDOFF: @<role>` 형태일 때만 인식한다.
// - 코드펜스 안의 예시는 무시한다.
// - 마커가 없으면 null. 서로 다른 대상이 여럿이면 ambiguous로 표시하고
//   대상을 확정하지 않는다(findControlMarker의 ambiguity 규율 준용).
function parseHandoffRequest(text) {
  const source = maskCodeFences(text);
  const targets = [];
  for (const match of source.matchAll(HANDOFF_LINE_PATTERN)) {
    const role = handoffTargetForToken(match[1]);
    targets.push(role || match[1].toLowerCase());
  }
  if (targets.length === 0) return null;
  const distinct = [...new Set(targets)];
  const known = handoffTargetForToken(targets[targets.length - 1]) || null;
  const purposeMatch = source.match(PURPOSE_LINE_PATTERN);
  const reasonMatch = source.match(REASON_LINE_PATTERN);
  return {
    targetRole: distinct.length === 1 ? known : null,
    purpose: purposeMatch ? purposeMatch[1].trim() : null,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
    ambiguous: distinct.length > 1,
  };
}

module.exports = {
  INTERACTION_TARGETS,
  INTERACTION_INTENTS,
  INTERACTION_SCOPES,
  EXECUTION_POLICIES,
  normalizeInteraction,
  HANDOFF_ROLES,
  HANDOFF_TRANSITIONS,
  HANDOFF_TARGET_ALIASES,
  isHandoffAllowed,
  resolveReviewerContract,
  DEFAULT_HANDOFF_BUDGET,
  createHandoffLedger,
  newInvocationId,
  validateHandoff,
  consumeHandoff,
  settleHandoff,
  parseHandoffRequest,
};
