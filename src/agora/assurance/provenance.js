"use strict";

// Stage D-C — Provenance & Audit
//
// D-C는 event emission을 새로 발명하는 단계가 **아니다.** 앞 단계들이 실행
// 시점에 이미 남긴 사실을 append-only event로 잇고, logical graph로 projection해
// 조회하는 단계다. **과거 사실을 소급해서 만들어내지 않는다(§25).**
//
// Graph DB를 도입하지 않는다(§28). append-only events + logical projection +
// query로 충분하다. 새 저장 엔진은 Agora를 무겁게 만들 뿐이다.
//
// 목표(§29): 특정 Run이 **왜 PASS였는지**를 저장된 사실만으로 재구성할 수 있다.

const crypto = require("node:crypto");

const PROVENANCE_SCHEMA_VERSION = 1;

// 최소 관계(§26). 새 노드 종류를 늘리기 전에 이 사슬이 끊기지 않는지부터 본다.
const NODE_TYPES = Object.freeze({
  DECISION: "decision",
  TASK: "task",
  VERIFICATION_PLAN: "verificationPlan",
  RUN: "run",
  INPUT: "input",
  CAPABILITY_SNAPSHOT: "capabilitySnapshot",
  WORKSPACE_MUTATION: "workspaceMutation",
  ASSURANCE_SUBJECT: "assuranceSubject",
  CRITERION_EXECUTION: "criterionExecution",
  // 판정 무효화도 사실이다. 원장에만 남기면 "PASS → INVALIDATED → 재검사 PASS"를
  // 저장된 사실만으로 재구성할 수 없다.
  INVALIDATION: "invalidation",
  REVIEWER_RESOLUTION: "reviewerResolution",
  HUMAN_APPROVAL: "humanApproval",
  FINAL_DISPOSITION: "finalDisposition",
  RECORDER: "recorder",
});

// Run lineage는 typed relation이다(§27).
// carriedFromRunId에 의미를 계속 덧붙이지 않는다.
const LINEAGE_RELATIONS = Object.freeze({
  REPLAN: "replan",
  RETRY: "retry",
  REVISION: "revision",
  CARRY: "carry",
});

const MAX_EVENTS = 20000;

function newEventId() {
  return `pv-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

class ProvenanceLog {
  constructor(options = {}) {
    this.runId = options.runId || null;
    this.now = options.now || (() => Date.now());
    this._events = [];
    this._overflow = 0;
  }

  get events() {
    return this._events.map((e) => ({ ...e }));
  }

  // append-only. 기록을 지우거나 고치는 메서드는 만들지 않는다.
  append(type, payload = {}) {
    if (this._events.length >= MAX_EVENTS) {
      this._overflow += 1;
      return null;
    }
    const event = Object.freeze({
      eventId: newEventId(),
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      runId: payload.runId || this.runId,
      type,
      at: this.now(),
      ...payload,
    });
    this._events.push(event);
    return event;
  }

  // --- 각 단계가 실제로 남긴 사실을 그대로 받는다 (소급 생성 없음) ---

  recordTaskFrozen({ runId, taskHash, planHash, contractHash, decisionIds = [], schemaVersion }) {
    return this.append(NODE_TYPES.TASK, { runId, taskHash, planHash, contractHash, decisionIds, taskSchemaVersion: schemaVersion });
  }

  recordPlanFrozen({ runId, planHash, criteria = [], structured }) {
    return this.append(NODE_TYPES.VERIFICATION_PLAN, {
      runId,
      planHash,
      structured: Boolean(structured),
      criterionIds: criteria.map((c) => c.criterionId),
    });
  }

  recordInputBinding({ runId, bindings = [] }) {
    return this.append(NODE_TYPES.INPUT, {
      runId,
      inputs: bindings.map((b) => ({
        inputId: b.inputId, locator: b.locator, mode: b.mode, state: b.state, sha256: b.sha256 || null,
      })),
    });
  }

  recordCapabilitySnapshot({ runId, snapshotId, capabilities = {}, executables = {} }) {
    return this.append(NODE_TYPES.CAPABILITY_SNAPSHOT, { runId, snapshotId, capabilities, executables });
  }

  recordWorkspaceMutation({ runId, event, resourceId, holderId, purpose }) {
    return this.append(NODE_TYPES.WORKSPACE_MUTATION, { runId, leaseEvent: event, resourceId, holderId, purpose });
  }

  recordAssuranceSubject({ runId, assuranceSubjectRef, entryCount, changeObservation, previousSubjectRef = null }) {
    return this.append(NODE_TYPES.ASSURANCE_SUBJECT, {
      runId, assuranceSubjectRef, entryCount, changeObservation, previousSubjectRef,
    });
  }

  recordCriterionExecution(record) {
    return this.append(NODE_TYPES.CRITERION_EXECUTION, {
      runId: record.runId,
      criterionId: record.criterionId,
      plannedMethod: record.plannedMethod,
      plannedDisposition: record.plannedDisposition,
      actualMethod: record.actualMethod,
      actualDisposition: record.actualDisposition,
      criterionOutcome: record.criterionOutcome,
      controlClass: record.controlClass,
      downgradeReason: record.downgradeReason || null,
      capabilitySnapshotRef: record.capabilitySnapshotRef || null,
      assuranceSubjectRef: record.assuranceSubjectRef || null,
    });
  }

  recordInvalidation({ runId, criterionId, reason, previousSubjectRef = null, assuranceSubjectRef = null }) {
    return this.append(NODE_TYPES.INVALIDATION, {
      runId, criterionId, reason, previousSubjectRef, assuranceSubjectRef,
      criterionOutcome: "INVALIDATED",
    });
  }

  recordReviewerResolution({ runId, criterionId, outcome, assuranceSubjectRef, rationale = null }) {
    return this.append(NODE_TYPES.REVIEWER_RESOLUTION, { runId, criterionId, outcome, assuranceSubjectRef, rationale });
  }

  recordHumanApproval({ runId, criterionId, outcome, assuranceSubjectRef, note = null }) {
    return this.append(NODE_TYPES.HUMAN_APPROVAL, { runId, criterionId, outcome, assuranceSubjectRef, note });
  }

  recordFinalDisposition({ runId, verdict, assuranceSubjectRef, blockers = [], summary = null }) {
    return this.append(NODE_TYPES.FINAL_DISPOSITION, {
      runId, verdict, assuranceSubjectRef,
      blockers: blockers.map((b) => ({ reason: b.reason, criterionId: b.criterionId || null })),
      summary,
    });
  }

  recordLineage({ runId, parentRunId, lineageRelation }) {
    if (!Object.values(LINEAGE_RELATIONS).includes(lineageRelation)) {
      return this.append(NODE_TYPES.RUN, { runId, parentRunId, lineageRelation: null, lineageRelationInvalid: lineageRelation });
    }
    return this.append(NODE_TYPES.RUN, { runId, parentRunId, lineageRelation });
  }

  recordRecorder({ runId, ok, outputPath = null, reason = null }) {
    return this.append(NODE_TYPES.RECORDER, { runId, ok: Boolean(ok), outputPath, reason });
  }

  toJSON() {
    return {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      runId: this.runId,
      overflow: this._overflow,
      events: this.events,
    };
  }

  static fromJSON(value, options = {}) {
    const log = new ProvenanceLog({ runId: value?.runId || options.runId || null, now: options.now });
    for (const event of value?.events || []) log._events.push(Object.freeze({ ...event }));
    log._overflow = Number.isInteger(value?.overflow) ? value.overflow : 0;
    return log;
  }
}

// --- Logical graph projection (graph DB 없이) ---
//
// events를 읽어 노드와 간선을 만든다. 저장 형태를 바꾸지 않고 조회 형태만
// 제공한다 — 이것이 "새 저장 엔진을 만들지 않는다"의 실제 의미다.
function projectGraph(log, { runId = null } = {}) {
  const events = (log?.events || log?._events || []).filter((e) => !runId || e.runId === runId);
  const nodes = new Map();
  const edges = [];

  const ensure = (type, id, data = {}) => {
    const key = `${type}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { key, type, id, ...data });
    else Object.assign(nodes.get(key), data);
    return key;
  };
  const link = (from, to, relation) => {
    if (from && to) edges.push({ from, to, relation });
  };

  for (const event of events) {
    const runKey = event.runId ? ensure(NODE_TYPES.RUN, event.runId) : null;

    switch (event.type) {
      case NODE_TYPES.TASK: {
        const taskKey = ensure(NODE_TYPES.TASK, event.taskHash, { contractHash: event.contractHash });
        link(taskKey, runKey, "frozen-into");
        for (const decisionId of event.decisionIds || []) {
          link(ensure(NODE_TYPES.DECISION, decisionId), taskKey, "decided");
        }
        break;
      }
      case NODE_TYPES.VERIFICATION_PLAN: {
        const planKey = ensure(NODE_TYPES.VERIFICATION_PLAN, event.planHash, {
          structured: event.structured,
          criterionIds: event.criterionIds,
        });
        link(planKey, runKey, "governs");
        break;
      }
      case NODE_TYPES.INPUT: {
        for (const input of event.inputs || []) {
          link(ensure(NODE_TYPES.INPUT, input.inputId, input), runKey, "used-by");
        }
        break;
      }
      case NODE_TYPES.CAPABILITY_SNAPSHOT:
        link(ensure(NODE_TYPES.CAPABILITY_SNAPSHOT, event.snapshotId), runKey, "measured-for");
        break;
      case NODE_TYPES.WORKSPACE_MUTATION:
        link(runKey, ensure(NODE_TYPES.WORKSPACE_MUTATION, `${event.resourceId}:${event.leaseEvent}:${event.at}`, {
          leaseEvent: event.leaseEvent, resourceId: event.resourceId,
        }), "mutated");
        break;
      case NODE_TYPES.ASSURANCE_SUBJECT: {
        const subjectKey = ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.assuranceSubjectRef, {
          entryCount: event.entryCount, changeObservation: event.changeObservation,
        });
        link(runKey, subjectKey, "produced");
        if (event.previousSubjectRef) {
          link(ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.previousSubjectRef), subjectKey, "superseded-by");
        }
        break;
      }
      case NODE_TYPES.CRITERION_EXECUTION: {
        const execKey = ensure(NODE_TYPES.CRITERION_EXECUTION, `${event.criterionId}@${event.at}`, {
          criterionId: event.criterionId,
          criterionOutcome: event.criterionOutcome,
          actualDisposition: event.actualDisposition,
          plannedDisposition: event.plannedDisposition,
          downgradeReason: event.downgradeReason,
          controlClass: event.controlClass,
        });
        link(execKey, ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.assuranceSubjectRef), "judges");
        if (event.capabilitySnapshotRef) {
          link(ensure(NODE_TYPES.CAPABILITY_SNAPSHOT, event.capabilitySnapshotRef), execKey, "enabled");
        }
        break;
      }
      case NODE_TYPES.INVALIDATION: {
        const key = ensure(NODE_TYPES.INVALIDATION, `${event.criterionId}@${event.at}`, {
          criterionId: event.criterionId, reason: event.reason || null,
        });
        if (event.previousSubjectRef) {
          link(key, ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.previousSubjectRef), "invalidates");
        }
        link(runKey, key, "invalidated");
        break;
      }
      case NODE_TYPES.REVIEWER_RESOLUTION:
      case NODE_TYPES.HUMAN_APPROVAL: {
        const key = ensure(event.type, `${event.criterionId}@${event.at}`, {
          criterionId: event.criterionId, outcome: event.outcome,
        });
        link(key, ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.assuranceSubjectRef), "judges");
        break;
      }
      case NODE_TYPES.FINAL_DISPOSITION: {
        const key = ensure(NODE_TYPES.FINAL_DISPOSITION, `${event.runId}@${event.at}`, {
          verdict: event.verdict, blockers: event.blockers, summary: event.summary,
        });
        link(runKey, key, "concluded");
        link(key, ensure(NODE_TYPES.ASSURANCE_SUBJECT, event.assuranceSubjectRef), "bound-to");
        break;
      }
      case NODE_TYPES.RUN:
        if (event.parentRunId) {
          link(ensure(NODE_TYPES.RUN, event.parentRunId), runKey, event.lineageRelation || "unknown-lineage");
        }
        break;
      case NODE_TYPES.RECORDER:
        link(runKey, ensure(NODE_TYPES.RECORDER, `${event.runId}@${event.at}`, { ok: event.ok }), "recorded");
        break;
      default:
        break;
    }
  }

  return { nodes: [...nodes.values()], edges };
}

// §29 — "왜 RUN-X가 PASS였는가?"를 저장된 사실만으로 재구성한다.
//
// 없는 것을 만들어내지 않는다. 기록되지 않은 것은 null로 남고, 그 자체가
// "그 사실이 기록되지 않았다"는 답이다.
function explainRun(log, runId) {
  const events = (log?.events || log?._events || []).filter((e) => e.runId === runId);
  const first = (type) => events.find((e) => e.type === type) || null;
  const all = (type) => events.filter((e) => e.type === type);

  const task = first(NODE_TYPES.TASK);
  const plan = first(NODE_TYPES.VERIFICATION_PLAN);
  const inputs = first(NODE_TYPES.INPUT);
  const capability = first(NODE_TYPES.CAPABILITY_SNAPSHOT);
  const subjects = all(NODE_TYPES.ASSURANCE_SUBJECT);
  const executions = all(NODE_TYPES.CRITERION_EXECUTION);
  const reviewerResolutions = all(NODE_TYPES.REVIEWER_RESOLUTION);
  const humanApprovals = all(NODE_TYPES.HUMAN_APPROVAL);
  const finals = all(NODE_TYPES.FINAL_DISPOSITION);
  const lineage = all(NODE_TYPES.RUN).filter((e) => e.parentRunId);
  const finalEvent = finals.length > 0 ? finals[finals.length - 1] : null;

  return {
    runId,
    // 어떤 Task/Plan hash였는가
    taskHash: task?.taskHash || null,
    planHash: plan?.planHash || task?.planHash || null,
    contractHash: task?.contractHash || null,
    decisionIds: task?.decisionIds || [],
    planStructured: plan?.structured ?? null,

    // 어떤 input을 썼는가
    inputs: inputs?.inputs || [],

    // 어떤 결과 snapshot을 검사했는가
    subjects: subjects.map((s) => ({
      assuranceSubjectRef: s.assuranceSubjectRef,
      entryCount: s.entryCount,
      changeObservation: s.changeObservation,
      previousSubjectRef: s.previousSubjectRef || null,
    })),
    finalSubjectRef: finalEvent?.assuranceSubjectRef || subjects[subjects.length - 1]?.assuranceSubjectRef || null,

    // 무슨 criterion을 실제로 실행했는가 / 무엇이 자동이고 무엇이 사람이었는가
    executions: executions.map((e) => ({
      criterionId: e.criterionId,
      criterionOutcome: e.criterionOutcome,
      plannedDisposition: e.plannedDisposition,
      actualDisposition: e.actualDisposition,
      downgradeReason: e.downgradeReason || null,
      controlClass: e.controlClass,
      assuranceSubjectRef: e.assuranceSubjectRef,
      at: e.at,
    })),
    automatic: executions.filter((e) => e.actualDisposition === "VERIFIED").map((e) => e.criterionId),
    reviewerJudged: reviewerResolutions.map((r) => ({ criterionId: r.criterionId, outcome: r.outcome })),
    humanApproved: humanApprovals.map((h) => ({ criterionId: h.criterionId, outcome: h.outcome })),

    // 어떤 capability downgrade가 있었는가
    downgrades: executions
      .filter((e) => e.downgradeReason)
      .map((e) => ({ criterionId: e.criterionId, from: e.plannedDisposition, to: e.actualDisposition, reason: e.downgradeReason })),
    capabilitySnapshotRef: capability?.snapshotId || null,

    // 판정 중 결과물이 바뀌거나 무효화된 적이 있는가.
    // 무효화는 전용 event로 남으므로 execution outcome에서 유추하지 않는다.
    invalidations: all(NODE_TYPES.INVALIDATION).map((e) => ({
      criterionId: e.criterionId,
      reason: e.reason || null,
      previousSubjectRef: e.previousSubjectRef || null,
      assuranceSubjectRef: e.assuranceSubjectRef || null,
      at: e.at,
    })),
    subjectChanges: subjects.filter((s) => s.previousSubjectRef).length,

    // 어떤 revision/replan lineage를 거쳤는가
    lineage: lineage.map((e) => ({ parentRunId: e.parentRunId, relation: e.lineageRelation })),

    // 왜 PASS였는가 (또는 왜 아니었는가)
    finalVerdict: finalEvent?.verdict || null,
    blockers: finalEvent?.blockers || [],
    summary: finalEvent?.summary || null,

    // 재구성 가능성 자체를 정직하게 표시한다. 없는 사실을 만들지 않는다.
    reconstructable: Boolean(task && plan && finalEvent),
    missingFacts: [
      !task ? "task" : null,
      !plan ? "verificationPlan" : null,
      !finalEvent ? "finalDisposition" : null,
      subjects.length === 0 ? "assuranceSubject" : null,
    ].filter(Boolean),
  };
}

module.exports = {
  PROVENANCE_SCHEMA_VERSION,
  NODE_TYPES,
  LINEAGE_RELATIONS,
  MAX_EVENTS,
  ProvenanceLog,
  projectGraph,
  explainRun,
};
