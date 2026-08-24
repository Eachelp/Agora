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
    // Stage D-C §27 — typed lineage. 옛 Run은 이 필드가 없고
    // run-lineage.readLineage()가 carriedFromRunId를 carry로 읽어 준다.
    parentRunId: options.parentRunId || null,
    lineageRelation: options.lineageRelation || null,
    planRound: Number.isInteger(options.planRound) ? Math.max(1, options.planRound) : 1,
    implementationRound: Number.isInteger(options.implementationRound) ? Math.max(0, options.implementationRound) : 0,
    planRevisionCount: Number.isInteger(options.planRevisionCount) ? Math.max(0, options.planRevisionCount) : 0,
    implementationRevisionCount: Number.isInteger(options.implementationRevisionCount) ? Math.max(0, options.implementationRevisionCount) : 0,
    feedbackMessageId: options.feedbackMessageId || null,
    lastVerdict: options.lastVerdict || null,
    // checkpoint 무보호 실행 여부를 evidence/Reviewer/UI까지 end-to-end로 전달한다.
    // enum: "protected" | "unavailable_non_git" | "unavailable_checkpoint_failed" | "unavailable_user_approved"
    checkpointProtection: options.checkpointProtection || null,
    // checkpoint 생성 실패 원인(거버넌스 실패 taxonomy)을 보존한다.
    checkpointFailReason: options.checkpointFailReason || null,
    // 사용자가 백업 없이 실행하겠다고 명시 승인했는지 여부를 영속 보존한다.
    // checkpointProtection enum과 함께 evidence/Reviewer 판단 근거가 된다.
    userApprovedUnprotectedExecution: Boolean(options.userApprovedUnprotectedExecution),
    missingSections: Array.isArray(options.missingSections) ? [...options.missingSections] : null,
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
      next.missingSections = null;
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
      if (current.status !== "WAITING" || (current.node !== "PLANNING" && current.node !== "PLAN_REVIEW" && current.node !== "READY")) {
        return { ok: false, reason: "답변/기획 수정 가능한 대기 상태가 아닙니다." };
      }
      next.node = "PLANNING";
      next.status = "RUNNING";
      next.stopReason = null;
      next.missingSections = null;
      // READY에서 기획 수정으로 복귀하면 승인된 기획 해시를 리셋한다.
      if (current.node === "READY") {
        next.approvedTaskHash = null;
        next.planRound = (current.planRound || 1) + 1;
      }
      break;
    }
    case "USER_EXECUTE": {
      // 정상 경로는 READY에서 시작한다. 그러나 checkpoint 실패 → PROCEED_UNPROTECTED
      // 로 무보호 실행을 승인하면 node가 이미 IMPLEMENTING/RUNNING으로 전이된 뒤
      // runExecutionBlock이 USER_EXECUTE를 다시 호출한다.
      // 단순히 IMPLEMENTING/RUNNING이라는 이유만으로 재진입을 열지 않고,
      // 실제 PROCEED_UNPROTECTED를 거친 상태(checkpointProtection === "unavailable_user_approved" + userApprovedUnprotectedExecution === true)
      // 에서만 무보호 재개로 허용한다.
      const unprotectedResume =
        current.node === "IMPLEMENTING" &&
        current.status === "RUNNING" &&
        current.checkpointProtection === "unavailable_user_approved" &&
        current.userApprovedUnprotectedExecution === true;
      if (current.node !== "READY" && !unprotectedResume) {
        return { ok: false, reason: `실행 가능한 상태가 아닙니다: ${current.node}` };
      }
      next.node = "IMPLEMENTING";
      next.status = "RUNNING";
      next.stopReason = null;
      if (event.frozenRunId) next.frozenRunId = event.frozenRunId;
      if (event.checkpointId) next.checkpointId = event.checkpointId;
      // checkpoint 보호 상태 기록: 성공 시 protected, non-Git/무보호 승인 등
      // enum이 명시되면 그 값을 쓴다. 명시가 없으면 현재 값을 보존해
      // PROCEED_UNPROTECTED가 기록한 unavailable_user_approved를 덮어쓰지 않는다.
      next.checkpointProtection = event.checkpointProtection !== undefined
        ? event.checkpointProtection
        : (current.checkpointProtection || "protected");
      // checkpoint 실패 원인은 무보호 실행 재개 시 덮어쓰지 않고 유지한다.
      // 이벤트에 명시적으로 주어지면 그 값, 아니면 현재 값(또는 null)을 보존한다.
      next.checkpointFailReason = event.checkpointFailReason !== undefined
        ? event.checkpointFailReason
        : (current.checkpointFailReason || null);
      next.implementationRound = 1;
      break;
    }
    case "TASK_CHANGED_AFTER_REVIEW": {
      if (current.node !== "READY") return { ok: false, reason: `잘못된 전이: ${current.node} -> TASK_CHANGED_AFTER_REVIEW` };
      next.node = "PLAN_REVIEW";
      next.status = "WAITING";
      next.stopReason = "TASK_CHANGED_AFTER_REVIEW";
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
    case "USER_RETRY_RECORDER": {
      if (current.node !== "RECORDING" || current.status !== "WAITING") {
        return { ok: false, reason: "기록을 다시 실행할 수 있는 대기 상태가 아닙니다." };
      }
      next.status = "RUNNING";
      next.stopReason = null;
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
    case "CHECKPOINT_FAILED": {
      if (current.node !== "READY" && current.node !== "IMPLEMENTING") {
        return { ok: false, reason: `checkpoint 실패 전이는 READY/IMPLEMENTING에서만 가능합니다: ${current.node}` };
      }
      // 상태 노드는 그대로 두고 WAITING으로만 전환한다(재시도 시 동일 노드 복귀).
      next.status = "WAITING";
      next.stopReason = "CHECKPOINT_FAILED";
      next.checkpointFailReason = event.checkpointFailReason || null;
      // frozenRunId는 유지해 Frozen Run 재사용/복구가 가능하게 한다.
      next.checkpointProtection = "unavailable_checkpoint_failed";
      break;
    }
    case "TASK_CONTRACT_INCOMPLETE": {
      if (current.node !== "READY" && current.node !== "IMPLEMENTING") {
        return { ok: false, reason: `계약 불완전 전이는 READY/IMPLEMENTING에서만 가능합니다: ${current.node}` };
      }
      next.node = "READY";
      next.status = "WAITING";
      next.stopReason = "TASK_CONTRACT_INCOMPLETE";
      next.approvedTaskHash = null;
      if (event.missingSections) next.missingSections = [...event.missingSections];
      break;
    }
    case "CHECKPOINT_RETRY": {
      if (current.status !== "WAITING" || current.stopReason !== "CHECKPOINT_FAILED") {
        return { ok: false, reason: "checkpoint 재시도는 CHECKPOINT_FAILED 대기 상태에서만 가능합니다." };
      }
      // CHECKPOINT_FAILED는 READY/IMPLEMENTING에서만 진입하므로 node는 그대로 유지한다.
      next.status = "RUNNING";
      next.stopReason = null;
      next.checkpointFailReason = null;
      // 재시도는 기존 Frozen Run을 재사용한다(frozenRunId 유지).
      next.checkpointProtection = null;
      break;
    }
    case "PROCEED_UNPROTECTED": {
      if (current.status !== "WAITING" || current.stopReason !== "CHECKPOINT_FAILED") {
        return { ok: false, reason: "무보호 실행은 CHECKPOINT_FAILED 대기 상태에서만 가능합니다." };
      }
      next.node = "IMPLEMENTING";
      next.status = "RUNNING";
      next.stopReason = null;
      // 사용자가 승인한 무보호 실행이라도 "왜 백업이 없었는지"는 남긴다.
      // 이 값은 evidence/Reviewer까지 전달되어 회귀 검증 신뢰도 판단 근거가
      // 되므로 여기서 지우면 provenance가 끊긴다.
      next.checkpointFailReason = current.checkpointFailReason || event.checkpointFailReason || null;
      // 사용자가 무보호 실행을 명시 승인했음을 enum으로 기록한다.
      next.checkpointProtection = "unavailable_user_approved";
      // 사용자 승인 사실 자체를 별도 영속 필드로 보존한다.
      next.userApprovedUnprotectedExecution = true;
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
      next.checkpointProtection = null;
      next.checkpointFailReason = null;
      next.missingSections = null;
      next.planRound = 1;
      next.userApprovedUnprotectedExecution = false;
      next.planRevisionCount = 0;
      next.implementationRound = 0;
      next.implementationRevisionCount = 0;
      if (event.carriedFromRunId) {
        next.carriedFromRunId = event.carriedFromRunId;
        // Stage D-C §27 — 왜 이어졌는지를 typed relation으로 남긴다.
        // carriedFromRunId는 호환을 위해 그대로 유지한다.
        next.parentRunId = event.carriedFromRunId;
        next.lineageRelation = "replan";
      }
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
  const needsInput =
    run.status === "WAITING" &&
    (["PLANNING", "PLAN_REVIEW"].includes(run.node) ||
      run.stopReason === "CHECKPOINT_FAILED" ||
      run.stopReason === "TASK_CONTRACT_INCOMPLETE");
  const planReady =
    run.node === "READY" &&
    run.status === "WAITING" &&
    run.stopReason !== "TASK_CONTRACT_INCOMPLETE";
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
    checkpointProtection: run.checkpointProtection || null,
    checkpointFailReason: run.checkpointFailReason || null,
    userApprovedUnprotectedExecution: Boolean(run.userApprovedUnprotectedExecution),
    missingSections: run.missingSections || options.missingSections || null,
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
