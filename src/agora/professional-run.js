"use strict";

const crypto = require("node:crypto");

const PROFESSIONAL_SCHEMA_VERSION = 1;

const PROFESSIONAL_NODES = Object.freeze([
  "PLANNING",
  "PLAN_REVIEW",
  "READY",
  "IMPLEMENTING",
  "REVIEWING",
  "RECORDING",
  "COMPLETED",
]);

const PROFESSIONAL_STATUSES = Object.freeze([
  "RUNNING",
  "WAITING",
  "BLOCKED",
  "INTERRUPTED",
  "INVALID",
  "COMPLETED",
]);

function newRunId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `pr-${ts}-${rand}`;
}

function phaseForNode(node) {
  const norm = String(node || "").toUpperCase();
  if (["PLANNING", "PLAN_REVIEW", "READY"].includes(norm)) return "PLAN";
  if (["IMPLEMENTING", "REVIEWING", "RECORDING", "COMPLETED"].includes(norm)) return "ACT";
  return null;
}

function createProfessionalRun(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const policy = options.policy || {};
  return {
    schemaVersion: PROFESSIONAL_SCHEMA_VERSION,
    professionalRunId: options.professionalRunId || newRunId(),
    taskId: options.taskId || null,
    taskPath: options.taskPath || null,
    approvedTaskHash: options.approvedTaskHash || null,
    frozenRunId: options.frozenRunId || null,
    node: PROFESSIONAL_NODES.includes(options.node) ? options.node : "PLANNING",
    status: PROFESSIONAL_STATUSES.includes(options.status) ? options.status : "RUNNING",
    policy: {
      autoContinueReady: Boolean(policy.autoContinueReady),
      pauseBeforeReview: Boolean(policy.pauseBeforeReview),
      pauseBeforeRecord: Boolean(policy.pauseBeforeRecord),
      planAutoRevisions: Number.isInteger(policy.planAutoRevisions) ? Math.max(0, Math.min(3, policy.planAutoRevisions)) : 0,
      implementationAutoRevisions: Number.isInteger(policy.implementationAutoRevisions) ? Math.max(0, Math.min(3, policy.implementationAutoRevisions)) : 0,
    },
    stages: options.stages || null,
    checkpointId: options.checkpointId || null,
    carriedFromRunId: options.carriedFromRunId || null,
    planRound: Number.isInteger(options.planRound) ? Math.max(1, options.planRound) : 1,
    implementationRound: Number.isInteger(options.implementationRound) ? Math.max(0, options.implementationRound) : 0,
    planRevisionCount: Number.isInteger(options.planRevisionCount) ? Math.max(0, options.planRevisionCount) : 0,
    implementationRevisionCount: Number.isInteger(options.implementationRevisionCount) ? Math.max(0, options.implementationRevisionCount) : 0,
    feedbackMessageId: options.feedbackMessageId || null,
    lastVerdict: options.lastVerdict || null,
    stopReason: options.stopReason || null,
    blockReason: options.blockReason || null,
    createdAt: Number.isFinite(options.createdAt) ? options.createdAt : now,
    updatedAt: now,
  };
}

function transitionProfessionalRun(current, event = {}) {
  if (!current || typeof current !== "object") {
    throw new Error("전이 대상 ProfessionalRun 상태가 없습니다.");
  }
  const eventType = String(event.type || "").toUpperCase();
  const next = {
    ...current,
    policy: { ...(current.policy || {}) },
    updatedAt: Number.isFinite(event.now) ? event.now : Date.now(),
  };

  switch (eventType) {
    case "PLANNER_PLAN_READY": {
      if (current.node !== "PLANNING") return { ok: false, reason: `잘못된 전이: ${current.node} -> PLANNER_PLAN_READY` };
      next.node = "PLAN_REVIEW";
      next.status = "RUNNING";
      next.stopReason = null;
      if (event.taskPath) next.taskPath = event.taskPath;
      if (event.taskId) next.taskId = event.taskId;
      break;
    }
    case "PLANNER_NEEDS_DECISION": {
      if (current.node !== "PLANNING") return { ok: false, reason: `잘못된 전이: ${current.node} -> PLANNER_NEEDS_DECISION` };
      next.node = "PLANNING";
      next.status = "WAITING";
      next.stopReason = "NEEDS_DECISION";
      if (event.stopReason) next.stopReason = event.stopReason;
      break;
    }
    case "PLAN_REVIEW_PASS": {
      if (current.node !== "PLAN_REVIEW") return { ok: false, reason: `잘못된 전이: ${current.node} -> PLAN_REVIEW_PASS` };
      next.node = "READY";
      next.status = "WAITING";
      next.lastVerdict = "PASS";
      next.stopReason = "PLAN_READY";
      if (event.approvedTaskHash) next.approvedTaskHash = event.approvedTaskHash;
      if (event.taskPath) next.taskPath = event.taskPath;
      break;
    }
    case "PLAN_REVIEW_FIX": {
      if (current.node !== "PLAN_REVIEW") return { ok: false, reason: `잘못된 전이: ${current.node} -> PLAN_REVIEW_FIX` };
      const canAuto = Boolean(event.canAutoRevise) && next.planRevisionCount < next.policy.planAutoRevisions;
      if (canAuto) {
        next.planRevisionCount += 1;
        next.planRound += 1;
        next.node = "PLANNING";
        next.status = "RUNNING";
        next.stopReason = null;
      } else {
        next.node = "PLAN_REVIEW";
        next.status = "WAITING";
        next.stopReason = event.stopReason || "FIX_REQUIRED";
      }
      next.lastVerdict = "FIX_REQUIRED";
      break;
    }
    case "PLAN_REVIEW_UNKNOWN": {
      if (current.node !== "PLAN_REVIEW") return { ok: false, reason: `잘못된 전이: ${current.node} -> PLAN_REVIEW_UNKNOWN` };
      next.node = "PLAN_REVIEW";
      next.status = "WAITING";
      next.lastVerdict = "UNKNOWN";
      next.stopReason = event.stopReason || "INSUFFICIENT_EVIDENCE";
      break;
    }
    case "USER_ANSWER_PLAN": {
      if (current.status !== "WAITING" || (current.node !== "PLANNING" && current.node !== "PLAN_REVIEW")) {
        return { ok: false, reason: "답변 가능한 대기 상태가 아닙니다." };
      }
      next.node = "PLANNING";
      next.status = "RUNNING";
      next.stopReason = null;
      break;
    }
    case "USER_EXECUTE": {
      if (current.node !== "READY") return { ok: false, reason: `실행 가능한 상태가 아닙니다: ${current.node}` };
      next.node = "IMPLEMENTING";
      next.status = "RUNNING";
      next.stopReason = null;
      if (event.frozenRunId) next.frozenRunId = event.frozenRunId;
      if (event.checkpointId) next.checkpointId = event.checkpointId;
      next.implementationRound = 1;
      break;
    }
    case "BUILDER_DONE": {
      if (current.node !== "IMPLEMENTING") return { ok: false, reason: `잘못된 전이: ${current.node} -> BUILDER_DONE` };
      if (next.policy.pauseBeforeReview) {
        next.node = "IMPLEMENTING";
        next.status = "WAITING";
        next.stopReason = "BUILDER_DONE";
      } else {
        next.node = "REVIEWING";
        next.status = "RUNNING";
        next.stopReason = null;
      }
      break;
    }
    case "USER_CONTINUE_REVIEW": {
      if (current.node !== "IMPLEMENTING" || current.status !== "WAITING") {
        return { ok: false, reason: "검수 대기 상태가 아닙니다." };
      }
      next.node = "REVIEWING";
      next.status = "RUNNING";
      next.stopReason = null;
      break;
    }
    case "BUILDER_BLOCKED": {
      if (current.node !== "IMPLEMENTING") return { ok: false, reason: `잘못된 전이: ${current.node} -> BUILDER_BLOCKED` };
      next.node = "IMPLEMENTING";
      next.status = "BLOCKED";
      next.stopReason = "BLOCKED";
      next.blockReason = event.blockReason || "BLOCKED";
      break;
    }
    case "REVIEW_PASS": {
      if (current.node !== "REVIEWING") return { ok: false, reason: `잘못된 전이: ${current.node} -> REVIEW_PASS` };
      next.lastVerdict = "PASS";
      if (next.policy.pauseBeforeRecord) {
        next.node = "REVIEWING";
        next.status = "WAITING";
        next.stopReason = "REVIEW_PASS";
      } else {
        next.node = "RECORDING";
        next.status = "RUNNING";
        next.stopReason = null;
      }
      break;
    }
    case "USER_CONTINUE_RECORD": {
      if (current.node !== "REVIEWING" || current.status !== "WAITING") {
        return { ok: false, reason: "기록 대기 상태가 아닙니다." };
      }
      next.node = "RECORDING";
      next.status = "RUNNING";
      next.stopReason = null;
      break;
    }
    case "REVIEW_FIX": {
      if (current.node !== "REVIEWING") return { ok: false, reason: `잘못된 전이: ${current.node} -> REVIEW_FIX` };
      const canAuto = Boolean(event.canAutoRevise) && next.implementationRevisionCount < next.policy.implementationAutoRevisions;
      if (canAuto) {
        next.implementationRevisionCount += 1;
        next.implementationRound += 1;
        next.node = "IMPLEMENTING";
        next.status = "RUNNING";
        next.stopReason = null;
      } else {
        next.node = "REVIEWING";
        next.status = "WAITING";
        next.stopReason = event.stopReason || "FIX_REQUIRED";
      }
      next.lastVerdict = "FIX_REQUIRED";
      break;
    }
    case "REVIEW_UNKNOWN": {
      if (current.node !== "REVIEWING") return { ok: false, reason: `잘못된 전이: ${current.node} -> REVIEW_UNKNOWN` };
      next.node = "REVIEWING";
      next.status = "WAITING";
      next.lastVerdict = "UNKNOWN";
      next.stopReason = event.stopReason || "INSUFFICIENT_EVIDENCE";
      break;
    }
    case "RECORDER_DONE": {
      if (current.node !== "RECORDING") return { ok: false, reason: `잘못된 전이: ${current.node} -> RECORDER_DONE` };
      next.node = "COMPLETED";
      next.status = "COMPLETED";
      next.stopReason = null;
      break;
    }
    case "RECORDER_FAILED": {
      if (current.node !== "RECORDING") return { ok: false, reason: `잘못된 전이: ${current.node} -> RECORDER_FAILED` };
      next.node = "RECORDING";
      next.status = "WAITING";
      next.stopReason = event.stopReason || "RECORDER_FAILED";
      break;
    }
    case "INTERRUPT": {
      next.status = "INTERRUPTED";
      next.stopReason = event.stopReason || "USER_INTERRUPTED";
      break;
    }
    case "INVALIDATE": {
      next.status = "INVALID";
      next.stopReason = event.stopReason || "FROZEN_TASK_CORRUPTED";
      next.blockReason = next.stopReason;
      break;
    }
    case "HOLD_BLOCKED": {
      next.status = "BLOCKED";
      next.stopReason = event.stopReason || "BLOCKED";
      next.blockReason = event.blockReason || next.stopReason;
      break;
    }
    case "REPLAN_RESET": {
      next.node = "PLANNING";
      next.status = "RUNNING";
      next.stopReason = null;
      next.blockReason = null;
      next.checkpointId = null;
      next.frozenRunId = null;
      next.approvedTaskHash = null;
      next.planRound = 1;
      next.planRevisionCount = 0;
      next.implementationRound = 0;
      next.implementationRevisionCount = 0;
      if (event.carriedFromRunId) next.carriedFromRunId = event.carriedFromRunId;
      break;
    }
    default:
      return { ok: false, reason: `알 수 없는 전이 이벤트: ${eventType}` };
  }

  return { ok: true, state: next };
}

function publicProfessionalState(run, options = {}) {
  if (!run || typeof run !== "object") {
    return {
      active: false,
      phase: null,
      node: null,
      status: null,
      needsInput: false,
      planReady: false,
      blocked: false,
      blockReason: null,
      canRestore: false,
      hasTask: false,
      taskPath: null,
      taskId: null,
      frozenRunId: null,
      planRound: 1,
      implementationRound: 0,
    };
  }

  const phase = phaseForNode(run.node);
  const active = run.status === "RUNNING";
  const blocked = run.status === "BLOCKED" || run.status === "INVALID";
  const needsInput = run.status === "WAITING" && ["PLANNING", "PLAN_REVIEW"].includes(run.node);
  const planReady = run.node === "READY" && run.status === "WAITING";
  const hasTask = Boolean(run.taskPath);
  const taskId = run.taskPath ? run.taskPath.replace(/^.*[\\/]/, "").replace(/\.md$/i, "") : null;

  return {
    active,
    phase,
    node: run.node,
    status: run.status,
    needsInput,
    planReady,
    blocked,
    blockReason: run.blockReason || run.stopReason || null,
    canRestore: Boolean(options.canRestore),
    hasTask,
    taskPath: run.taskPath || null,
    taskId: run.taskId || taskId,
    frozenRunId: run.frozenRunId || null,
    planRound: run.planRound || 1,
    implementationRound: run.implementationRound || 0,
    stopReason: run.stopReason || null,
  };
}

module.exports = {
  PROFESSIONAL_SCHEMA_VERSION,
  PROFESSIONAL_NODES,
  PROFESSIONAL_STATUSES,
  phaseForNode,
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
};
