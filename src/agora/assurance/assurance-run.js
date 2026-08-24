"use strict";

// Stage D — Assurance Run orchestrator
//
// D-A1/D-A2/D-B/D-C의 조각들을 professional execution의 실제 흐름에 붙인다.
// chat-specialist는 여기 있는 다섯 지점만 호출하면 된다.
//
//   freeze()            Task 승인 → 계약·계획 동결, 입력 결합      (D-A1)
//   admitBuilder()      Builder 시작 직전 frozen input 재대조      (D-A1)
//   captureSubject()    Builder 종료 → 결과물 snapshot 확정        (D-A2 / INV-5)
//   verify()            동결된 계획 실행 → outcome + disposition   (D-A2)
//   finalize()          재확인 → Final PASS 집계                   (D-A2 §18)
//
// **v1 Task는 그대로 흐른다.** 기존 과업이 Stage D 때문에 막히면 안 된다.
// v2 계약이 아니면 `mode: "legacy"`로 통과시키고, 그 사실을 정직하게 남긴다
// (Charter §6 — 이미 동결된 과거 계약을 다시 쓰지 않는다).
//
// Recorder까지 끝나면 toJSON()으로 RUN 폴더에 남고, D-C가 그것을 읽어
// "왜 PASS였는가"를 재구성한다.

const fs = require("node:fs");
const path = require("node:path");

const taskSchema = require("./task-schema-v2");
const frozenContract = require("./frozen-contract");
const inputBinding = require("./input-binding");
const assuranceSubject = require("./assurance-subject");
const { AssuranceLedger } = require("./assurance-ledger");
const verificationCore = require("./verification-core");
const finalDisposition = require("./final-disposition");
const provenance = require("./provenance");
const runLineage = require("./run-lineage");
const resourceGovernance = require("./resource-governance");
const { discoverVerificationCapabilities, summarizeCapabilities } = require("../verification-capabilities");

const ASSURANCE_STATE_FILENAME = "assurance-state.json";

const MODES = Object.freeze({
  ASSURED: "assured", // v2 계약 — Stage D 전체가 적용된다
  LEGACY: "legacy",   // v1 계약 — 기존 동작 그대로
});

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

class AssuranceRun {
  constructor(options = {}) {
    this.runId = options.runId || null;
    this.runDir = options.runDir || null;
    this.root = options.root || null;
    this.now = options.now || (() => Date.now());
    this.mode = MODES.LEGACY;
    this.contract = null;
    this.plan = null;
    this.subject = null;
    this.previousSubjectRef = null;
    this.ledger = new AssuranceLedger({ runId: this.runId, now: this.now });
    this.provenance = new provenance.ProvenanceLog({ runId: this.runId, now: this.now });
    this.capabilities = null;
    this.lastVerification = null;
    this.lastFinal = null;
  }

  get assured() {
    return this.mode === MODES.ASSURED;
  }

  get assuranceSubjectRef() {
    return this.subject?.assuranceSubjectRef || null;
  }

  // --- 1. 동결 (Task 승인 직후, Builder 시작 전) ---
  //
  // v1 계약이면 legacy로 통과시킨다. 막지 않는다.
  freeze(taskContent, { lineage = null } = {}) {
    if (lineage?.parentRunId) {
      this.provenance.recordLineage({
        runId: this.runId,
        parentRunId: lineage.parentRunId,
        lineageRelation: lineage.lineageRelation,
      });
    }

    const classified = taskSchema.classifyTaskSchema(taskContent);

    // v2 흔적이 전혀 없는 문서만 legacy로 흘린다.
    if (classified.intent === taskSchema.SCHEMA_INTENT.LEGACY_V1) {
      this.mode = MODES.LEGACY;
      return { ok: true, mode: MODES.LEGACY, reason: "v1 계약이므로 기존 경로로 실행합니다." };
    }

    // 여기서부터는 작성자가 v2를 쓰려 한 문서다. 이후의 어떤 실패도
    // legacy 승격 사유가 되지 않는다(B2·B3).
    this.mode = MODES.ASSURED;
    this.schemaIntent = classified.intent;

    if (classified.intent === taskSchema.SCHEMA_INTENT.V2_INCOMPLETE) {
      return {
        ok: false,
        mode: MODES.ASSURED,
        code: "TASK_CONTRACT_INCOMPLETE",
        missing: classified.missing,
        error: `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${classified.missing.join(", ")}`,
      };
    }

    const built = frozenContract.buildFrozenContract(taskContent, { root: this.root, now: this.now() });
    if (!built.ok) {
      // 계약을 만들 수 없다. 조용히 legacy로 내려가지 않는다 — v2를 표방한
      // 계약이 불완전한 것은 계약 문제이지 "구형 과업"이 아니다.
      return { ok: false, mode: MODES.ASSURED, ...built };
    }

    this.contract = built.contract;
    this.plan = { criteria: built.contract.verificationPlan.criteria, structured: built.contract.verificationPlan.structured };

    if (this.runDir) {
      const frozen = frozenContract.freezeContract(this.runDir, this.contract);
      if (!frozen.ok && frozen.code !== "ALREADY_FROZEN") {
        return { ok: false, mode: MODES.ASSURED, code: "CONTRACT_FREEZE_FAILED", error: frozen.error };
      }
    }

    this.provenance.recordTaskFrozen({
      runId: this.runId,
      taskHash: this.contract.taskHash,
      planHash: this.contract.verificationPlan.planHash,
      contractHash: this.contract.contractHash,
      decisionIds: this.contract.decisionIds,
      schemaVersion: this.contract.taskSchemaVersion,
    });
    this.provenance.recordPlanFrozen({
      runId: this.runId,
      planHash: this.contract.verificationPlan.planHash,
      structured: this.contract.verificationPlan.structured,
      criteria: this.contract.verificationPlan.criteria,
    });
    this.provenance.recordInputBinding({
      runId: this.runId,
      bindings: this.contract.inputBinding.bindings,
    });

    return {
      ok: true,
      mode: MODES.ASSURED,
      contract: this.contract,
      plan: this.plan,
      notes: built.contract.verificationPlan.notes,
    };
  }

  // --- 2. Builder admission (되돌릴 수 없는 상태를 소비하기 전) ---
  admitBuilder() {
    if (!this.assured) return { ok: true, mode: MODES.LEGACY };
    const admitted = frozenContract.admitBuilder(this.contract, { root: this.root, now: this.now() });
    if (!admitted.ok) return { ok: false, ...admitted };
    return { ok: true, recheck: admitted.recheck };
  }

  // --- 3. Assurance Subject 확정 (Builder 종료 직후) ---
  captureSubject({ changedPaths = [], changeObservation = "unknown", excludedPrefixes = [], reason = null } = {}) {
    if (!this.assured) return { ok: true, mode: MODES.LEGACY, subject: null };
    this.previousSubjectRef = this.subject?.assuranceSubjectRef || null;
    this.subject = assuranceSubject.createAssuranceSubject({
      root: this.root,
      runId: this.runId,
      now: this.now(),
      deliverables: this.contract.deliverables.items,
      changedPaths,
      changeObservation,
      excludedPrefixes,
    });
    this.provenance.recordAssuranceSubject({
      runId: this.runId,
      assuranceSubjectRef: this.subject.assuranceSubjectRef,
      entryCount: this.subject.entries.length,
      changeObservation: this.subject.changeObservation,
      previousSubjectRef: this.previousSubjectRef,
    });

    // 결과물이 교체되면(auto-revision 등) 이전 결과물에 귀속된 판정은 더 이상
    // 이 결과물에 대한 판정이 아니다. 기존 기록을 지우지 않고 무효화를 추가한다(R-8).
    if (this.previousSubjectRef && this.previousSubjectRef !== this.subject.assuranceSubjectRef) {
      this.invalidateAgainst({
        previousSubjectRef: this.previousSubjectRef,
        reason: reason || "결과물이 다시 만들어져 이전 확인 결과가 이 결과물에 적용되지 않습니다.",
      });
    }

    return { ok: true, subject: this.subject, summary: assuranceSubject.summarizeSubject(this.subject) };
  }

  // 무효화는 원장과 provenance **양쪽**에 남는다.
  // 원장에만 남기면 D-C가 "PASS → INVALIDATED → 재검사 PASS"를 재구성하지 못한다(B9).
  invalidateAgainst({ previousSubjectRef, reason }) {
    const criterionIds = (this.plan?.criteria || []).map((c) => c.criterionId);
    if (criterionIds.length === 0) return [];
    const entries = this.ledger.appendInvalidation({
      criterionIds,
      reason,
      previousSubjectRef,
      assuranceSubjectRef: this.assuranceSubjectRef,
    });
    for (const criterionId of criterionIds) {
      this.provenance.recordInvalidation({
        runId: this.runId,
        criterionId,
        reason,
        previousSubjectRef,
        assuranceSubjectRef: this.assuranceSubjectRef,
      });
    }
    return entries;
  }

  // --- live input retrieval (Charter §3.1) ---
  //
  // live 계약의 의미는 "안 얼려도 된다"가 아니라 **"달라도 되지만 실제로 무엇을
  // 썼는지는 남긴다"**이다. Agora가 URL을 대신 가져오지는 않지만(non-goal),
  // 실제 사용 사실은 기록되어야 감사에서 "그때 무엇을 봤는가"를 답할 수 있다.
  //
  // 두 경로가 있다:
  //   1) Agora가 직접 관측 가능한 것(작업 폴더 안의 live 파일) → 사용 시점 지문
  //   2) 외부에서 온 metadata(etag/version) → 그대로 받아 append
  recordLiveRetrieval(inputId, metadata = {}) {
    if (!this.assured) return { ok: false, error: "이 실행에는 입력 계약이 없습니다." };
    const appended = inputBinding.recordLiveRetrieval(this.contract.inputBinding, inputId, metadata);
    if (!appended.ok) return appended;
    const bound = this.contract.inputBinding.bindings.find((b) => b.inputId === inputId);
    this.provenance.recordInputRetrieval({
      runId: this.runId,
      inputId,
      locator: bound?.locator || null,
      ...appended.entry,
    });
    return appended;
  }

  // 실행 시점에 Agora가 관측할 수 있는 live 입력의 사용 사실을 남긴다.
  // 관측할 수 없는 것(URL 등)은 **관측하지 못했다고** 남긴다 — 지어내지 않는다.
  captureLiveInputUse({ now = null } = {}) {
    if (!this.assured) return [];
    const captured = [];
    for (const bound of this.contract.inputBinding.bindings || []) {
      if (bound.mode !== "live") continue;
      if (bound.kind === "path" && this.root) {
        const fingerprint = inputBinding.fingerprintFile(path.resolve(this.root, bound.locator));
        const recorded = this.recordLiveRetrieval(bound.inputId, {
          retrievedAt: Number.isFinite(now) ? now : this.now(),
          contentHash: fingerprint.sha256,
          note: fingerprint.sha256 ? null : `관측 불가: ${fingerprint.reason || fingerprint.state}`,
        });
        if (recorded.ok) captured.push({ inputId: bound.inputId, observed: Boolean(fingerprint.sha256) });
        continue;
      }
      // Agora가 내용을 볼 수 없는 live 입력. 사용됐다는 사실과 못 봤다는 사실을 남긴다.
      const recorded = this.recordLiveRetrieval(bound.inputId, {
        retrievedAt: Number.isFinite(now) ? now : this.now(),
        contentHash: null,
        note: "Agora가 내용을 관측할 수 없는 입력입니다.",
      });
      if (recorded.ok) captured.push({ inputId: bound.inputId, observed: false });
    }
    return captured;
  }

  // --- 4. 검증 실행 ---
  async verify({ workerPermission = "workspace-read", env, platform } = {}) {
    if (!this.assured) return { ok: true, mode: MODES.LEGACY, records: [] };

    // 동결된 계획이 그대로인지 먼저 확인한다(INV-1).
    const integrity = frozenContract.verifyPlanIntegrity(this.contract, this.plan);
    if (!integrity.ok) {
      return { ok: false, code: "PLAN_TAMPERED", error: "승인된 확인 목록이 실행 중 바뀌었습니다.", integrity };
    }

    this.capabilities = discoverVerificationCapabilities({ env, platform });
    const summary = summarizeCapabilities(this.capabilities);
    this.provenance.recordCapabilitySnapshot({
      runId: this.runId,
      snapshotId: summary.snapshotId,
      capabilities: summary.capabilities,
      executables: summary.executables,
    });

    const result = await verificationCore.runVerification(this.plan, {
      root: this.root,
      workerPermission,
      capabilities: this.capabilities,
      assuranceSubjectRef: this.assuranceSubjectRef,
      ledger: this.ledger,
      env,
      platform,
      // 검증기가 산출물을 건드리면 Builder 변경과 분리해 기록한다.
      sideEffectScope: (this.subject?.entries || []).map((e) => e.path),
    });

    for (const record of result.records) {
      this.provenance.recordCriterionExecution({ runId: this.runId, ...record });
    }
    this.lastVerification = result;
    return result;
  }

  // --- Reviewer / Human resolution (append-only) ---
  resolveByReviewer({ criterionId, outcome, rationale = null }) {
    if (!this.assured) return { ok: false, error: "이 실행에는 확인 항목이 없습니다." };
    const appended = this.ledger.appendReviewerResolution({
      criterionId, outcome, rationale, assuranceSubjectRef: this.assuranceSubjectRef,
    });
    if (!appended.ok) return appended;
    this.provenance.recordReviewerResolution({
      runId: this.runId, criterionId, outcome, assuranceSubjectRef: this.assuranceSubjectRef, rationale,
    });
    return appended;
  }

  resolveByHuman({ criterionId, outcome, note = null }) {
    if (!this.assured) return { ok: false, error: "이 실행에는 확인 항목이 없습니다." };
    const appended = this.ledger.appendHumanApproval({
      criterionId, outcome, note, assuranceSubjectRef: this.assuranceSubjectRef,
    });
    if (!appended.ok) return appended;
    this.provenance.recordHumanApproval({
      runId: this.runId, criterionId, outcome, assuranceSubjectRef: this.assuranceSubjectRef, note,
    });
    return appended;
  }

  // --- 5. Final disposition (§18) ---
  //
  // 재확인은 각 판정 확정 경계 직전에 한다. 여기가 마지막 경계다.
  finalize() {
    if (!this.assured) {
      return { ok: true, mode: MODES.LEGACY, finalPass: true, verdict: "PASS", blockers: [] };
    }

    const subjectRecheck = this.subject
      ? assuranceSubject.recheckSubject(this.subject, { root: this.root, now: this.now() })
      : { ok: false, changed: [] };
    const inputRecheck = inputBinding.recheckFrozenInputs(this.contract.inputBinding, {
      root: this.root, now: this.now(),
    });
    const planIntegrity = frozenContract.verifyPlanIntegrity(this.contract, this.plan);

    // subject가 바뀌었으면 기존 판정을 무효화한다. 기존 기록은 지우지 않는다(R-8).
    if (!subjectRecheck.ok) {
      this.invalidateAgainst({
        previousSubjectRef: this.assuranceSubjectRef,
        reason: `판정 이후 결과물이 바뀌었습니다: ${subjectRecheck.changed.map((c) => c.path).join(", ")}`,
      });
    }

    const result = finalDisposition.aggregateFinalDisposition({
      plan: this.plan,
      ledger: this.ledger,
      assuranceSubjectRef: this.assuranceSubjectRef,
      subjectRecheck,
      inputRecheck,
      planIntegrity,
    });

    this.provenance.recordFinalDisposition({
      runId: this.runId,
      verdict: result.verdict,
      assuranceSubjectRef: this.assuranceSubjectRef,
      blockers: result.blockers,
      summary: result.summary,
    });

    this.lastFinal = { ...result, subjectRecheck, inputRecheck, planIntegrity };
    return this.lastFinal;
  }

  // Reviewer에게 넘길 구조화 payload(§19).
  // Builder의 주장만 보여주지 않는다 — 무엇이 자동으로 확정됐고 무엇이 남았는지,
  // 무엇이 강등됐는지를 함께 준다.
  reviewerPayload() {
    if (!this.assured) return null;
    const records = this.lastVerification?.records || [];
    const pending = records.filter((r) => r.actualDisposition !== "VERIFIED");
    return {
      contract: {
        taskHash: this.contract.taskHash,
        planHash: this.contract.verificationPlan.planHash,
        structured: this.contract.verificationPlan.structured,
        decisionIds: this.contract.decisionIds,
        inputs: this.contract.inputs,
        deliverables: this.contract.deliverables,
      },
      subject: this.subject ? assuranceSubject.summarizeSubject(this.subject) : null,
      automatic: records
        .filter((r) => r.actualDisposition === "VERIFIED")
        .map((r) => ({ criterionId: r.criterionId, statement: r.statement, outcome: r.criterionOutcome })),
      // Reviewer가 실제로 판정해야 하는 항목.
      reviewRequired: pending
        .filter((r) => r.actualDisposition === "REVIEW_REQUIRED")
        .map((r) => ({
          criterionId: r.criterionId, statement: r.statement,
          outcome: r.criterionOutcome, downgradeReason: r.downgradeReason,
        })),
      // Reviewer가 대신 승인할 수 없는 항목.
      humanApproval: pending
        .filter((r) => r.actualDisposition === "HUMAN_APPROVAL")
        .map((r) => ({ criterionId: r.criterionId, statement: r.statement })),
      // planned vs actual — 정직한 강등이 조용한 강등이 되면 안 된다(R-3).
      downgrades: records
        .filter((r) => r.downgraded && r.plannedDisposition !== r.actualDisposition)
        .map((r) => ({
          criterionId: r.criterionId,
          plannedDisposition: r.plannedDisposition,
          actualDisposition: r.actualDisposition,
          downgradeReason: r.downgradeReason,
        })),
      // 검증기가 남긴 부수효과. Builder 변경과 섞지 않는다.
      verificationSideEffects: records
        .filter((r) => r.evidence?.sideEffects?.changedPaths?.length)
        .map((r) => ({ criterionId: r.criterionId, changedPaths: r.evidence.sideEffects.changedPaths })),
      previousResolutions: this.ledger.records.filter(
        (r) => r.type === "reviewer-resolution" || r.type === "human-approval" || r.type === "invalidation"
      ),
    };
  }

  // 승인 화면 요약(§9 P-1/P-2/P-3). 내부 어휘를 노출하지 않는다.
  approvalSummary() {
    if (!this.assured) return null;
    const criteria = this.plan?.criteria || [];
    return {
      inputs: this.contract.inputs,
      deliverables: this.contract.deliverables,
      // criterion은 그룹화할 수 있지만 생략할 수 없다(P-1).
      criteria: criteria.map((c) => ({
        criterionId: c.criterionId, statement: c.statement, method: c.plannedMethod,
      })),
      composition: {
        automatic: criteria.filter((c) => c.plannedDisposition === "VERIFIED").length,
        review: criteria.filter((c) => c.plannedDisposition === "REVIEW_REQUIRED").length,
        human: criteria.filter((c) => c.plannedDisposition === "HUMAN_APPROVAL").length,
      },
      // 계획된 사용자 승인은 사전 예고한다(P-3). REPLAN 횟수는 약속하지 않는다.
      //
      // human criterion은 되돌릴 수 없는 외부 행동을 뜻하므로, 계획 단계에서도
      // D-B의 심사를 거쳐 "왜 사람이 필요한지"를 함께 보여 준다(§23).
      plannedHumanApprovals: criteria
        .filter((c) => c.plannedDisposition === "HUMAN_APPROVAL")
        .map((c) => {
          const adjudication = resourceGovernance.adjudicateAction(
            {
              resourceKind: resourceGovernance.RESOURCE_KINDS.EXTERNAL,
              action: resourceGovernance.ACTIONS.EXTERNAL_EFFECT,
              resourceId: c.criterionId,
              requestedPermission: "workspace-write",
            },
            { permissionCap: "workspace-write" }
          );
          return {
            criterionId: c.criterionId,
            statement: c.statement,
            reasons: adjudication.ok ? adjudication.approvalReasons : [],
          };
        }),
      replanNote: "계약 변경이 필요한 경우 별도 재승인이 발생할 수 있습니다.",
    };
  }

  recordWorkspaceMutation(event) {
    this.provenance.recordWorkspaceMutation({ runId: this.runId, ...event });
  }

  recordRecorder(result) {
    this.provenance.recordRecorder({ runId: this.runId, ...result });
  }

  toJSON() {
    return {
      schemaVersion: 1,
      runId: this.runId,
      mode: this.mode,
      contractHash: this.contract?.contractHash || null,
      taskHash: this.contract?.taskHash || null,
      planHash: this.contract?.verificationPlan?.planHash || null,
      assuranceSubjectRef: this.assuranceSubjectRef,
      subject: this.subject,
      ledger: this.ledger.toJSON(),
      provenance: this.provenance.toJSON(),
      final: this.lastFinal
        ? { verdict: this.lastFinal.verdict, finalPass: this.lastFinal.finalPass, blockers: this.lastFinal.blockers, summary: this.lastFinal.summary }
        : null,
    };
  }

  // RUN 폴더에 남긴다. 실패해도 실행을 무너뜨리지 않는다 —
  // 기록 실패는 governance 실패가 아니라 관측 실패다.
  persist() {
    if (!this.runDir) return { ok: false, error: "Run 폴더가 없습니다." };
    try {
      fs.mkdirSync(this.runDir, { recursive: true });
      writeJsonAtomic(path.join(this.runDir, ASSURANCE_STATE_FILENAME), this.toJSON());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "assurance 기록을 저장하지 못했습니다." };
    }
  }

  static load(runDir, options = {}) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(runDir, ASSURANCE_STATE_FILENAME), "utf8"));
    } catch {
      return null;
    }
    const run = new AssuranceRun({ runId: parsed.runId, runDir, root: options.root, now: options.now });
    run.mode = parsed.mode || MODES.LEGACY;
    run.subject = parsed.subject || null;
    run.ledger = AssuranceLedger.fromJSON(parsed.ledger, { runId: parsed.runId, now: options.now });
    run.provenance = provenance.ProvenanceLog.fromJSON(parsed.provenance, { runId: parsed.runId, now: options.now });
    const contract = frozenContract.readFrozenContract(runDir);
    if (contract.ok) {
      run.contract = contract.contract;
      run.plan = {
        criteria: contract.contract.verificationPlan.criteria,
        structured: contract.contract.verificationPlan.structured,
      };
    }
    return run;
  }

  // "왜 PASS였는가"를 저장된 사실만으로 재구성한다(§29).
  explain() {
    return provenance.explainRun(this.provenance, this.runId);
  }
}

module.exports = {
  ASSURANCE_STATE_FILENAME,
  MODES,
  AssuranceRun,
  LINEAGE_RELATIONS: runLineage.LINEAGE_RELATIONS,
};
