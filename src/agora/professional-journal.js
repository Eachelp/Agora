"use strict";

// V1.5 System Journal (AGORA_V1_5_PROPOSAL.md §10).
// 전문 실행 FSM의 전이를 감사 이벤트로 매핑하는 순수 로직이다. LLM이 아니라
// Runtime이 사실만 기록한다 — 새로운 결정·판정을 만들지 않는다.
// FSM snapshot(meta.json의 professionalRun)이 현재 상태의 기준이고, Journal은
// 그 전이와 artifact provenance를 설명하는 append-only 기록이다(§10.4).

const crypto = require("node:crypto");

const JOURNAL_SCHEMA_VERSION = 1;

// 제안서 §10.3의 이벤트 어휘. 여기 없는 종류를 만들어 붙이지 않는다.
const JOURNAL_EVENT_TYPES = Object.freeze([
  "INTERACTION_CLASSIFIED",
  "ROLE_STARTED",
  "ROLE_FINISHED",
  "HANDOFF_REQUESTED",
  "HANDOFF_ACCEPTED",
  "HANDOFF_REJECTED",
  "USER_DECISION_REQUIRED",
  "USER_DECISION_RECEIVED",
  "TASK_APPROVED",
  "TASK_FROZEN",
  "CHECKPOINT_CREATED",
  "CHECKPOINT_FAILED",
  "ARTIFACT_RECORDED",
  "REVIEW_VERDICT",
  "RUN_INTERRUPTED",
  "RUN_BLOCKED",
  "RUN_COMPLETED",
]);

function newEventId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `pe-${ts}-${rand}`;
}

function createJournalEvent(fields = {}) {
  if (!JOURNAL_EVENT_TYPES.includes(fields.type)) {
    return null;
  }
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    eventId: fields.eventId || newEventId(),
    sessionId: fields.sessionId || null,
    professionalRunId: fields.professionalRunId || null,
    frozenRunId: fields.frozenRunId || null,
    invocationId: fields.invocationId || null,
    type: fields.type,
    role: fields.role || null,
    purpose: fields.purpose || null,
    // HANDOFF 요청의 근거. 프롬프트가 REASON을 가르치므로 감사 이력에 남긴다
    // (없으면 null). purpose(무엇을 위한 계약인가)와는 다른 축이다.
    reason: fields.reason || null,
    status: fields.status || null,
    // artifact는 본문 복사가 아니라 ID/hash/경로 참조만 싣는다(§10.2).
    artifactRefs: Array.isArray(fields.artifactRefs) ? [...fields.artifactRefs] : [],
    createdAt: Number.isFinite(fields.createdAt) ? fields.createdAt : Date.now(),
  };
}

// FSM 전이 이벤트 → Journal 이벤트 매핑 테이블.
// 각 항목은 base(run 정보)를 받아 이벤트 필드 배열을 돌려준다.
const TRANSITION_MAP = Object.freeze({
  PLANNER_PLAN_READY: () => [
    { type: "ROLE_FINISHED", role: "planner", status: "PLAN_READY" },
  ],
  PLANNER_NEEDS_DECISION: () => [
    { type: "ROLE_FINISHED", role: "planner", status: "NEEDS_DECISION" },
    { type: "USER_DECISION_REQUIRED", role: "planner", purpose: "plan_question" },
  ],
  PLAN_REVIEW_PASS: () => [
    { type: "REVIEW_VERDICT", role: "reviewer", purpose: "plan_review", status: "PASS" },
  ],
  PLAN_REVIEW_FIX: () => [
    { type: "REVIEW_VERDICT", role: "reviewer", purpose: "plan_review", status: "FIX_REQUIRED" },
  ],
  PLAN_REVIEW_UNKNOWN: () => [
    { type: "REVIEW_VERDICT", role: "reviewer", purpose: "plan_review", status: "UNKNOWN" },
    { type: "USER_DECISION_REQUIRED", role: "reviewer", purpose: "plan_review_unknown" },
  ],
  USER_ANSWER_PLAN: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "plan_answer" },
  ],
  USER_EXECUTE: () => [{ type: "TASK_APPROVED" }],
  TASK_CHANGED_AFTER_REVIEW: () => [
    { type: "USER_DECISION_REQUIRED", purpose: "task_changed_after_review" },
  ],
  TASK_CONTRACT_INCOMPLETE: () => [
    { type: "USER_DECISION_REQUIRED", purpose: "task_contract_incomplete" },
  ],
  BUILDER_DONE: () => [{ type: "ROLE_FINISHED", role: "builder", status: "DONE" }],
  BUILDER_BLOCKED: () => [
    { type: "ROLE_FINISHED", role: "builder", status: "BLOCKED" },
    { type: "RUN_BLOCKED", role: "builder" },
  ],
  USER_CONTINUE_REVIEW: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "continue_review" },
  ],
  USER_CONTINUE_RECORD: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "continue_record" },
  ],
  USER_RETRY_RECORDER: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "retry_recorder" },
  ],
  CHECKPOINT_RETRY: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "checkpoint_retry" },
  ],
  PROCEED_UNPROTECTED: () => [
    { type: "USER_DECISION_RECEIVED", purpose: "proceed_unprotected" },
  ],
  REVIEW_PASS: () => [
    { type: "REVIEW_VERDICT", role: "reviewer", purpose: "implementation_review", status: "PASS" },
  ],
  REVIEW_FIX: () => [
    {
      type: "REVIEW_VERDICT",
      role: "reviewer",
      purpose: "implementation_review",
      status: "FIX_REQUIRED",
    },
  ],
  REVIEW_UNKNOWN: () => [
    {
      type: "REVIEW_VERDICT",
      role: "reviewer",
      purpose: "implementation_review",
      status: "UNKNOWN",
    },
    { type: "USER_DECISION_REQUIRED", role: "reviewer", purpose: "implementation_review_unknown" },
  ],
  RECORDER_DONE: (base, next) => [
    { type: "ROLE_FINISHED", role: "recorder", status: "DONE" },
    ...(next && next.node === "COMPLETED" ? [{ type: "RUN_COMPLETED" }] : []),
  ],
  RECORDER_FAILED: () => [{ type: "ROLE_FINISHED", role: "recorder", status: "FAILED" }],
  INTERRUPT: () => [{ type: "RUN_INTERRUPTED" }],
  INVALIDATE: () => [{ type: "RUN_INTERRUPTED", status: "INVALID" }],
  CHECKPOINT_FAILED: () => [{ type: "CHECKPOINT_FAILED" }],
  HOLD_BLOCKED: () => [{ type: "RUN_BLOCKED" }],
  REPLAN_RESET: () => [{ type: "RUN_INTERRUPTED", purpose: "replan" }],
});

// 성공한 FSM 전이 하나를 Journal 이벤트 배열로 바꾼다. 매핑에 없는 전이는
// 빈 배열이다 — §10.3 어휘 밖의 이벤트 종류를 만들어내지 않는다.
// frozenRunId는 전이 전/후 상태 중 하나에 있을 때만 싣는다. Freeze 전(계획
// 단계)에는 양쪽 다 null이므로, 존재하지 않았던 RUN-xxx에 계획 이벤트가
// 연결되는 P1 불일치가 구조적으로 차단된다(§10.2). 전이가 frozenRunId를
// 지우는 경우(REPLAN_RESET 등)에는 prev 쪽 값을 남긴다 — 폐기되는 Run의
// provenance가 그 interruption 이벤트에서 사라지면 안 된다.
function journalEventsForTransition(prevRun, event, nextRun, options = {}) {
  const eventType = String(event?.type || "").toUpperCase();
  const mapper = TRANSITION_MAP[eventType];
  if (!mapper) return [];
  const run = nextRun || prevRun || {};
  const base = {
    sessionId: options.sessionId || null,
    professionalRunId: run.professionalRunId || null,
    frozenRunId: (nextRun && nextRun.frozenRunId) || (prevRun && prevRun.frozenRunId) || null,
    createdAt: options.createdAt,
  };
  return mapper(base, nextRun)
    .map((fields) => {
      const event = createJournalEvent({ ...base, ...fields });
      // 매퍼는 내부 코드다 — 어휘 밖 type을 낸 것은 개발 실수(오타·등록 누락)다.
      // 운영은 fail-open을 유지하되(감사 실패가 실행을 막지 않는다) 개발/테스트에서는
      // 드러내, 미래의 오타가 무증상으로 이벤트를 통째로 잃지 않게 한다.
      if (!event && fields?.type && process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(`[journal] 어휘 밖 이벤트 type이 폐기됐습니다: ${fields.type}`);
      }
      return event;
    })
    .filter(Boolean);
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_EVENT_TYPES,
  newEventId,
  createJournalEvent,
  journalEventsForTransition,
};
