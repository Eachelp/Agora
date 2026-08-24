"use strict";

// Stage D-A2 — Assurance Ledger (R-8: 판정은 덮어쓰지 않는다)
//
// criterion 실행 결과와 Reviewer/Human resolution은 **append-only**다.
// 재검사·revision·resolution은 기존 기록을 수정하지 않고 새 판정을 추가한다.
//
//   나쁜 예   UNSUPPORTED → Reviewer PASS 로 덮어쓰기
//             "자동검사를 실제로 못 했었다"는 사실이 세탁된다.
//
//   옳은 예   execution   outcome=UNSUPPORTED  (남는다)
//             resolution  outcome=PASS          (추가된다)
//
// INV-5의 INVALIDATED도 같다: PASS → INVALIDATED → 재검사 PASS 세 기록이
// 모두 남는다. 이것이 없으면 D-C의 "왜 PASS였는가"를 재구성할 수 없다.
//
// 모든 판정은 assuranceSubjectRef에 귀속된다. 어떤 결과물에 대한 판정인지
// 모르는 판정은 판정이 아니다.

const crypto = require("node:crypto");

const LEDGER_SCHEMA_VERSION = 1;

const RECORD_TYPES = Object.freeze({
  EXECUTION: "criterion-execution",       // 엔진이 실제로 검사한 결과
  REVIEWER_RESOLUTION: "reviewer-resolution", // Reviewer가 내린 판정
  HUMAN_APPROVAL: "human-approval",       // 사용자가 내린 승인/거부
  INVALIDATION: "invalidation",           // subject 변경으로 기존 판정 무효화
});

const RESOLUTION_OUTCOMES = Object.freeze(["PASS", "FAIL", "DEFERRED"]);

function newRecordId() {
  return `ar-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

class AssuranceLedger {
  constructor(options = {}) {
    this.runId = options.runId || null;
    this.now = options.now || (() => Date.now());
    // append-only. 이 배열에서 원소를 지우거나 바꾸는 메서드는 만들지 않는다.
    this._records = [];
  }

  get records() {
    return this._records.map((r) => ({ ...r }));
  }

  _append(record) {
    const entry = Object.freeze({
      recordId: newRecordId(),
      runId: this.runId,
      createdAt: this.now(),
      ...record,
    });
    this._records.push(entry);
    return entry;
  }

  // 엔진이 실제로 검사한 결과. Router가 만든 planned/actual을 그대로 받는다.
  appendExecution({
    criterionId,
    statement = null,
    plannedMethod,
    plannedDisposition,
    actualMethod,
    actualDisposition,
    criterionOutcome,
    controlClass,
    downgradeReason = null,
    capabilitySnapshotRef = null,
    assuranceSubjectRef = null,
    evidence = null,
    actor = "agora",
  }) {
    return this._append({
      type: RECORD_TYPES.EXECUTION,
      criterionId,
      statement,
      plannedMethod,
      plannedDisposition,
      actualMethod,
      actualDisposition,
      criterionOutcome,
      controlClass,
      downgradeReason,
      capabilitySnapshotRef,
      assuranceSubjectRef,
      evidence,
      actor,
    });
  }

  // 이 criterion이 실제로 어떤 처분으로 라우팅됐는가. 없으면 null.
  _routedDispositionFor(criterionId) {
    const executions = this._records.filter(
      (r) => r.criterionId === criterionId && r.type === RECORD_TYPES.EXECUTION
    );
    return executions.length > 0 ? executions[executions.length - 1].actualDisposition : null;
  }

  // Reviewer의 판정. 기존 execution을 수정하지 않고 그 위에 쌓는다.
  //
  // **Reviewer는 사용자 승인을 대신할 수 없다(§20).** HUMAN_APPROVAL로 라우팅된
  // criterion에 Reviewer 판정을 쌓으면 승인 관문이 무력화되므로 거부한다.
  // 조용히 무시하지 않고 거부 사실을 돌려준다.
  appendReviewerResolution({ criterionId, outcome, rationale = null, assuranceSubjectRef = null, actor = "reviewer" }) {
    if (!RESOLUTION_OUTCOMES.includes(outcome)) {
      return { ok: false, error: `알 수 없는 판정입니다: ${outcome}` };
    }
    if (this._routedDispositionFor(criterionId) === "HUMAN_APPROVAL") {
      return {
        ok: false,
        code: "HUMAN_APPROVAL_REQUIRED",
        error: `이 항목은 사용자 승인이 필요합니다: ${criterionId}`,
      };
    }
    return {
      ok: true,
      record: this._append({
        type: RECORD_TYPES.REVIEWER_RESOLUTION,
        criterionId,
        criterionOutcome: outcome,
        rationale: rationale != null ? String(rationale).slice(0, 4000) : null,
        assuranceSubjectRef,
        actor,
      }),
    };
  }

  // 사용자 승인. Reviewer가 대신 내릴 수 없다.
  appendHumanApproval({ criterionId, outcome, note = null, assuranceSubjectRef = null, actor = "user" }) {
    if (!RESOLUTION_OUTCOMES.includes(outcome)) {
      return { ok: false, error: `알 수 없는 승인 결과입니다: ${outcome}` };
    }
    return {
      ok: true,
      record: this._append({
        type: RECORD_TYPES.HUMAN_APPROVAL,
        criterionId,
        criterionOutcome: outcome,
        note: note != null ? String(note).slice(0, 4000) : null,
        assuranceSubjectRef,
        actor,
      }),
    };
  }

  // subject가 바뀌어 기존 판정이 무효가 됐다. 기존 기록은 그대로 두고 추가한다.
  appendInvalidation({ criterionIds = [], reason, previousSubjectRef = null, assuranceSubjectRef = null }) {
    const entries = [];
    for (const criterionId of criterionIds) {
      entries.push(
        this._append({
          type: RECORD_TYPES.INVALIDATION,
          criterionId,
          criterionOutcome: "INVALIDATED",
          reason: reason != null ? String(reason).slice(0, 1000) : null,
          previousSubjectRef,
          assuranceSubjectRef,
          actor: "agora",
        })
      );
    }
    return entries;
  }

  // criterion 하나의 전체 이력. 시간 순서 그대로 — 요약이 아니다.
  historyFor(criterionId) {
    return this._records.filter((r) => r.criterionId === criterionId).map((r) => ({ ...r }));
  }

  // 지금 유효한 판정. **기록을 지우는 것이 아니라 최신을 고르는 것**이다.
  //
  // 우선순위: 사용자 승인 > Reviewer 판정 > 실행 결과.
  // 단, 특정 subject에 귀속되지 않은(다른 subject의) 판정은 유효하지 않다.
  effectiveFor(criterionId, { assuranceSubjectRef = null } = {}) {
    const history = this._records.filter((r) => r.criterionId === criterionId);
    if (history.length === 0) return null;

    const boundToSubject = (record) =>
      !assuranceSubjectRef ||
      !record.assuranceSubjectRef ||
      record.assuranceSubjectRef === assuranceSubjectRef;

    // subject가 바뀐 뒤의 무효화가 있으면 그 이후 기록만 본다.
    let cutoff = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].type === RECORD_TYPES.INVALIDATION && boundToSubject(history[i])) {
        cutoff = i;
        break;
      }
    }
    const live = history.slice(cutoff + 1).filter(boundToSubject);
    if (live.length === 0) {
      const invalidation = cutoff >= 0 ? history[cutoff] : null;
      return invalidation ? { ...invalidation, resolved: false } : null;
    }

    // resolution 기록은 "누가 판정했는가"만 담는다. 그 criterion이 애초에 어떤
    // 처분으로 라우팅됐는지(자동/Reviewer/사용자)는 execution에만 있으므로 함께
    // 실어 보낸다 — 여기서 잃으면 §9 P-2의 처분 구성이 "✓" 하나로 뭉개진다.
    const lastExecution = [...live].reverse().find((r) => r.type === RECORD_TYPES.EXECUTION);
    const routing = {
      actualDisposition: lastExecution?.actualDisposition || null,
      plannedDisposition: lastExecution?.plannedDisposition || null,
      plannedMethod: lastExecution?.plannedMethod || null,
      actualMethod: lastExecution?.actualMethod || null,
      controlClass: lastExecution?.controlClass || null,
      downgradeReason: lastExecution?.downgradeReason || null,
    };

    const human = [...live].reverse().find((r) => r.type === RECORD_TYPES.HUMAN_APPROVAL);
    if (human) return { ...routing, ...human, resolvedBy: human.type, resolved: true };

    const reviewer = [...live].reverse().find((r) => r.type === RECORD_TYPES.REVIEWER_RESOLUTION);
    if (reviewer) {
      // 방어선: 외부에서 로드된 기록에 Reviewer 판정이 섞여 있어도 사용자 승인
      // 관문을 대신하지 못한다(§20). append 시점 거부와 같은 규칙이다.
      if (routing.actualDisposition === "HUMAN_APPROVAL") {
        return { ...routing, ...reviewer, resolvedBy: reviewer.type, resolved: false };
      }
      return { ...routing, ...reviewer, resolvedBy: reviewer.type, resolved: true };
    }
    const execution = lastExecution;
    if (!execution) return null;
    return {
      ...execution,
      // 자동 확정된 것만 해소된 것이다. 나머지는 아직 누군가의 판단을 기다린다.
      resolved: execution.actualDisposition === "VERIFIED",
    };
  }

  // 직렬화. provenance와 run artifact에 그대로 실린다.
  toJSON() {
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      runId: this.runId,
      records: this.records,
    };
  }

  static fromJSON(value, options = {}) {
    const ledger = new AssuranceLedger({ runId: value?.runId || options.runId || null, now: options.now });
    for (const record of value?.records || []) {
      ledger._records.push(Object.freeze({ ...record }));
    }
    return ledger;
  }
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  RECORD_TYPES,
  RESOLUTION_OUTCOMES,
  AssuranceLedger,
};
