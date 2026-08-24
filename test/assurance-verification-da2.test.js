"use strict";

// Stage D-A2 — Verification Core.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md):
//   INV-3  자동으로 증명 못 한 것을 VERIFIED라 부르지 않는다.
//   INV-5  모든 판정은 특정 결과 snapshot에 귀속된다.
//   R-2    controlClass = NEITHER는 VERIFIED를 낼 수 없다.
//   R-3    planned와 actual을 분리 기록한다.
//   R-7    outcome과 disposition은 직교한다.
//   R-8    판정은 덮어쓰지 않는다.
//   §18    Final PASS 집계 규칙.
//   Agora는 코딩 전용 도구가 아니다 — 문서/데이터 산출물 검사가 1급이어야 한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CONTROL_CLASS } = require("../src/agora/verification-runner");
const { discoverVerificationCapabilities } = require("../src/agora/verification-capabilities");
const subject = require("../src/agora/assurance/assurance-subject");
const predicate = require("../src/agora/assurance/artifact-predicate");
const router = require("../src/agora/assurance/disposition-router");
const { AssuranceLedger } = require("../src/agora/assurance/assurance-ledger");
const core = require("../src/agora/assurance/verification-core");
const final = require("../src/agora/assurance/final-disposition");

function tempRoot(prefix = "agora-da2-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function reviewCriterion(id = "V1") {
  return { criterionId: id, statement: "판단", plannedMethod: "review", plannedDisposition: "REVIEW_REQUIRED", step: null, downgradeTo: "REVIEW_REQUIRED" };
}

// ---- Assurance Subject (INV-5) ----

test("Builder 종료 시 결과물 snapshot이 만들어진다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "report.md"), "# 보고서");
    const snap = subject.createAssuranceSubject({
      root,
      deliverables: [{ locator: "report.md", kind: "path" }],
      changedPaths: ["notes.txt"],
      runId: "RUN-001",
    });
    assert.match(snap.assuranceSubjectRef, /^subj-/);
    const report = snap.entries.find((e) => e.path === "report.md");
    assert.equal(report.state, "PRESENT");
    assert.equal(report.origin, "deliverable");
    // 없는 관측 변경은 ABSENT로 남는다 — 조용히 빠지지 않는다.
    assert.equal(snap.entries.find((e) => e.path === "notes.txt").state, "ABSENT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agora 자신의 run artifact는 subject에서 제외된다", () => {
  const root = tempRoot();
  try {
    const snap = subject.createAssuranceSubject({
      root,
      deliverables: [],
      changedPaths: [".project-memory/runs/RUN-001/evidence.json", "out.txt"],
    });
    assert.deepEqual(snap.entries.map((e) => e.path), ["out.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("판정 직전 결과물이 바뀌면 재확인이 잡는다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "report.md");
    fs.writeFileSync(file, "원본");
    const snap = subject.createAssuranceSubject({ root, deliverables: ["report.md"] });
    assert.equal(subject.recheckSubject(snap, { root }).ok, true);

    fs.writeFileSync(file, "누가 바꿈");
    const after = subject.recheckSubject(snap, { root });
    assert.equal(after.ok, false);
    assert.equal(after.changed[0].path, "report.md");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-Git workspace에서도 Deliverables 지문은 그대로 뜬다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "report.md"), "본문");
    const snap = subject.createAssuranceSubject({
      root,
      deliverables: ["report.md"],
      changedPaths: [],
      changeObservation: "unsupported_non_git",
    });
    assert.equal(snap.entries[0].state, "PRESENT");
    assert.equal(subject.summarizeSubject(snap).changeObservation, "unsupported_non_git");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Artifact Predicate Engine ----

test("문서 산출물의 필수 섹션 검사가 1급으로 동작한다 (비코딩)", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "report.md"), "# 보고서\n\n## 결론\n요약\n");
    const caps = discoverVerificationCapabilities();
    const pass = predicate.evaluatePredicate(
      { kind: "text.section", target: "report.md", expected: "결론" },
      { root, capabilities: caps }
    );
    assert.equal(pass.outcome, "PASS");
    const fail = predicate.evaluatePredicate(
      { kind: "text.section", target: "report.md", expected: "출처" },
      { root, capabilities: caps }
    );
    assert.equal(fail.outcome, "FAIL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CSV 행 수·열 값 검사가 동작한다 (데이터 과업)", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "out.csv"), 'name,score\n"김, 철수",90\n이영희,85\n');
    const caps = discoverVerificationCapabilities();
    assert.equal(
      predicate.evaluatePredicate({ kind: "csv.rows", target: "out.csv", operator: ">=", expected: 2 }, { root, capabilities: caps }).outcome,
      "PASS"
    );
    assert.equal(
      predicate.evaluatePredicate({ kind: "csv.rows", target: "out.csv", operator: ">=", expected: 5 }, { root, capabilities: caps }).outcome,
      "FAIL"
    );
    // 따옴표 안의 쉼표를 열 구분자로 세지 않는다.
    const col = predicate.evaluatePredicate(
      { kind: "csv.column", target: "out.csv", args: { column: "name", row: 0 }, expected: "김, 철수" },
      { root, capabilities: caps }
    );
    assert.equal(col.outcome, "PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("JSON 경로 검사가 동작하고 없는 경로를 통과시키지 않는다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "c.json"), JSON.stringify({ meta: { version: "2.0" }, items: [1, 2, 3] }));
    const caps = discoverVerificationCapabilities();
    assert.equal(
      predicate.evaluatePredicate({ kind: "json.path", target: "c.json", args: { path: "$.meta.version" }, expected: "2.0" }, { root, capabilities: caps }).outcome,
      "PASS"
    );
    assert.equal(
      predicate.evaluatePredicate({ kind: "json.path", target: "c.json", args: { path: "$.meta.missing" }, expected: "x" }, { root, capabilities: caps }).outcome,
      "FAIL"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("동봉하지 않은 형식은 PASS로 가장하지 않고 UNSUPPORTED로 강등한다 (INV-3)", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "book.xlsx"), "not really xlsx");
    const caps = discoverVerificationCapabilities();
    const got = predicate.evaluatePredicate(
      { kind: "xlsx", target: "book.xlsx", expected: 1 },
      { root, capabilities: caps }
    );
    assert.equal(got.outcome, "UNSUPPORTED");
    assert.ok(got.downgradeReason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("확인 대상이 작업 폴더 밖이면 평가하지 않는다", () => {
  const root = tempRoot();
  try {
    const got = predicate.evaluatePredicate(
      { kind: "exists", target: "../../etc/passwd" },
      { root, capabilities: discoverVerificationCapabilities() }
    );
    assert.equal(got.outcome, "ERROR");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Disposition Router ----

test("outcome과 disposition은 직교한다 — FAIL + VERIFIED는 정확한 의미다 (R-7)", () => {
  const routed = router.routeDisposition({
    criterion: { plannedMethod: "process", plannedDisposition: "VERIFIED" },
    outcome: "FAIL",
    controlClass: CONTROL_CLASS.OBSERVABLE,
  });
  assert.equal(routed.criterionOutcome, "FAIL");
  assert.equal(routed.actualDisposition, "VERIFIED");
});

test("controlClass가 NEITHER면 VERIFIED를 낼 수 없다 (R-2)", () => {
  const routed = router.routeDisposition({
    criterion: { plannedMethod: "process", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED" },
    outcome: "PASS",
    controlClass: CONTROL_CLASS.NEITHER,
  });
  assert.equal(routed.actualDisposition, "REVIEW_REQUIRED");
  assert.equal(routed.downgraded, true);
  assert.ok(routed.downgradeReason);
});

test("UNSUPPORTED는 VERIFIED가 아니라 Reviewer로 간다 (INV-3)", () => {
  const routed = router.routeDisposition({
    criterion: { plannedMethod: "predicate", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED" },
    outcome: "UNSUPPORTED",
    controlClass: CONTROL_CLASS.ENFORCEABLE,
  });
  assert.equal(routed.actualDisposition, "REVIEW_REQUIRED");
  assert.equal(routed.criterionOutcome, "UNSUPPORTED");
});

test("planned와 actual 차이가 기록에 남는다 (R-3)", () => {
  const routed = router.routeDisposition({
    criterion: { criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED" },
    outcome: "UNSUPPORTED",
    controlClass: CONTROL_CLASS.ENFORCEABLE,
    downgradeReason: "artifact.xlsx unavailable",
  });
  const summary = router.summarizeDispositions([{ ...routed, criterionId: "V1" }]);
  assert.equal(summary.downgrades.length, 1);
  assert.equal(summary.downgrades[0].plannedDisposition, "VERIFIED");
  assert.equal(summary.downgrades[0].actualDisposition, "REVIEW_REQUIRED");
  assert.match(summary.downgrades[0].downgradeReason, /xlsx/);
});

test("계획부터 사람 판단인 criterion은 강등이 아니다", () => {
  const routed = router.routeDisposition({
    criterion: { plannedMethod: "human", plannedDisposition: "HUMAN_APPROVAL" },
    outcome: null,
    controlClass: null,
  });
  assert.equal(routed.actualDisposition, "HUMAN_APPROVAL");
  assert.equal(routed.downgraded, false);
});

// ---- Ledger (R-8) ----

test("Reviewer 판정이 기존 UNSUPPORTED 기록을 지우지 않는다 (R-8)", () => {
  const ledger = new AssuranceLedger({ runId: "RUN-001" });
  ledger.appendExecution({
    criterionId: "V1",
    plannedMethod: "predicate",
    plannedDisposition: "VERIFIED",
    actualMethod: "predicate",
    actualDisposition: "REVIEW_REQUIRED",
    criterionOutcome: "UNSUPPORTED",
    controlClass: CONTROL_CLASS.ENFORCEABLE,
    assuranceSubjectRef: "subj-a",
  });
  ledger.appendReviewerResolution({ criterionId: "V1", outcome: "PASS", assuranceSubjectRef: "subj-a" });

  const history = ledger.historyFor("V1");
  assert.equal(history.length, 2);
  assert.equal(history[0].criterionOutcome, "UNSUPPORTED", "자동검사를 못 했다는 사실이 남아야 한다");
  const effective = ledger.effectiveFor("V1", { assuranceSubjectRef: "subj-a" });
  assert.equal(effective.criterionOutcome, "PASS");
  assert.equal(effective.resolved, true);
});

test("PASS → INVALIDATED → 재검사 PASS 세 기록이 모두 남는다 (R-8 · INV-5)", () => {
  const ledger = new AssuranceLedger({ runId: "RUN-001" });
  ledger.appendExecution({
    criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED",
    actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS",
    controlClass: CONTROL_CLASS.ENFORCEABLE, assuranceSubjectRef: "subj-a",
  });
  ledger.appendInvalidation({ criterionIds: ["V1"], reason: "결과물 변경", previousSubjectRef: "subj-a", assuranceSubjectRef: "subj-b" });
  ledger.appendExecution({
    criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED",
    actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS",
    controlClass: CONTROL_CLASS.ENFORCEABLE, assuranceSubjectRef: "subj-b",
  });

  const history = ledger.historyFor("V1");
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.criterionOutcome), ["PASS", "INVALIDATED", "PASS"]);
  assert.equal(ledger.effectiveFor("V1", { assuranceSubjectRef: "subj-b" }).resolved, true);
});

test("다른 subject의 판정은 유효 판정이 되지 않는다 (INV-5)", () => {
  const ledger = new AssuranceLedger({ runId: "RUN-001" });
  ledger.appendExecution({
    criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED",
    actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS",
    controlClass: CONTROL_CLASS.ENFORCEABLE, assuranceSubjectRef: "subj-a",
  });
  assert.equal(ledger.effectiveFor("V1", { assuranceSubjectRef: "subj-b" }), null);
});

test("원장 기록은 외부에서 바꿀 수 없다", () => {
  const ledger = new AssuranceLedger({ runId: "RUN-001" });
  ledger.appendExecution({
    criterionId: "V1", plannedMethod: "process", plannedDisposition: "VERIFIED",
    actualMethod: "process", actualDisposition: "VERIFIED", criterionOutcome: "PASS",
    controlClass: CONTROL_CLASS.OBSERVABLE,
  });
  const copy = ledger.records;
  copy[0].criterionOutcome = "FAIL";
  assert.equal(ledger.historyFor("V1")[0].criterionOutcome, "PASS");
});

// ---- Verification Core (통합) ----

test("process criterion이 실제로 실행되고 exit code로 판정된다", async () => {
  const root = tempRoot();
  try {
    const plan = {
      criteria: [{
        criterionId: "V1", statement: "검사 통과", plannedMethod: "process",
        plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED",
        step: { backend: "process", executable: process.execPath, argv: ["-e", "process.exit(0)"], expect: { exitCode: 0 }, frozenFiles: {} },
      }],
    };
    const ledger = new AssuranceLedger({ runId: "RUN-001" });
    const result = await core.runVerification(plan, {
      root, workerPermission: "workspace-write", assuranceSubjectRef: "subj-a", ledger,
    });
    assert.equal(result.records[0].criterionOutcome, "PASS");
    assert.equal(result.records[0].actualDisposition, "VERIFIED");
    assert.equal(result.records[0].controlClass, CONTROL_CLASS.OBSERVABLE, "subprocess는 OBSERVABLE이다");
    assert.ok(result.records[0].evidence.exitCode === 0);
    assert.equal(ledger.historyFor("V1").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("이 PC에 없는 도구는 FAIL이 아니라 UNSUPPORTED로 강등된다", async () => {
  const root = tempRoot();
  try {
    const plan = {
      criteria: [{
        criterionId: "V1", statement: "x", plannedMethod: "process",
        plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED",
        step: { backend: "process", executable: "agora-definitely-not-a-real-tool-xyz", argv: [], expect: { exitCode: 0 }, frozenFiles: {} },
      }],
    };
    const result = await core.runVerification(plan, { root, workerPermission: "workspace-write" });
    assert.equal(result.records[0].criterionOutcome, "UNSUPPORTED");
    assert.equal(result.records[0].actualDisposition, "REVIEW_REQUIRED");
    assert.ok(result.records[0].downgradeReason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("검증 실행 1회는 하나의 capability snapshot을 참조한다 (§11)", async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "a.md"), "x");
    const plan = {
      criteria: [
        { criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED", step: { kind: "exists", target: "a.md" } },
        { criterionId: "V2", statement: "b", plannedMethod: "predicate", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED", step: { kind: "exists", target: "a.md" } },
      ],
    };
    const result = await core.runVerification(plan, { root, workerPermission: "workspace-read" });
    assert.equal(result.records[0].capabilitySnapshotRef, result.records[1].capabilitySnapshotRef);
    assert.ok(result.capabilitySnapshotRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("검증 프로세스가 산출물을 건드리면 별도로 기록된다 (D-A0 §2.8)", async () => {
  const root = tempRoot();
  try {
    const deliverable = path.join(root, "report.md");
    fs.writeFileSync(deliverable, "원본");
    const plan = {
      criteria: [{
        criterionId: "V1", statement: "x", plannedMethod: "process",
        plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED",
        step: {
          backend: "process", executable: process.execPath,
          argv: ["-e", `require("fs").writeFileSync(${JSON.stringify(deliverable)},"검증기가 건드림")`],
          expect: { exitCode: 0 }, frozenFiles: {},
        },
      }],
    };
    const result = await core.runVerification(plan, {
      root, workerPermission: "workspace-write", sideEffectScope: ["report.md"],
    });
    assert.equal(result.records[0].evidence.sideEffects.accounted, true);
    assert.deepEqual(result.records[0].evidence.sideEffects.changedPaths, ["report.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Final disposition (§18) ----

function ledgerWith(records) {
  const ledger = new AssuranceLedger({ runId: "RUN-001" });
  for (const r of records) ledger.appendExecution({ assuranceSubjectRef: "subj-a", ...r });
  return ledger;
}

test("자동검사 FAIL 하나면 Final PASS가 될 수 없다 (규칙 1)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "process", plannedDisposition: "VERIFIED" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "process", plannedDisposition: "VERIFIED", actualMethod: "process", actualDisposition: "VERIFIED", criterionOutcome: "FAIL", controlClass: CONTROL_CLASS.OBSERVABLE }]);
  const result = final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" });
  assert.equal(result.finalPass, false);
  assert.equal(result.blockers[0].reason, "AUTOMATIC_FAIL");
});

test("REVIEW_REQUIRED 미해결이면 Final PASS가 될 수 없다 (규칙 3)", () => {
  const plan = { criteria: [reviewCriterion("V1")] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "review", plannedDisposition: "REVIEW_REQUIRED", actualMethod: "review", actualDisposition: "REVIEW_REQUIRED", criterionOutcome: null, controlClass: null }]);
  const result = final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" });
  assert.equal(result.finalPass, false);
  assert.equal(result.blockers[0].reason, "UNRESOLVED_REVIEW");

  ledger.appendReviewerResolution({ criterionId: "V1", outcome: "PASS", assuranceSubjectRef: "subj-a" });
  assert.equal(final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" }).finalPass, true);
});

test("HUMAN_APPROVAL 미해결이면 Reviewer가 대신 통과시킬 수 없다 (규칙 4)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "발송 승인", plannedMethod: "human", plannedDisposition: "HUMAN_APPROVAL" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "human", plannedDisposition: "HUMAN_APPROVAL", actualMethod: "human", actualDisposition: "HUMAN_APPROVAL", criterionOutcome: null, controlClass: null }]);
  assert.equal(final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" }).blockers[0].reason, "UNRESOLVED_HUMAN_APPROVAL");

  ledger.appendHumanApproval({ criterionId: "V1", outcome: "PASS", assuranceSubjectRef: "subj-a" });
  assert.equal(final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" }).finalPass, true);
});

test("UNSUPPORTED 미해결이면 Final PASS가 될 수 없다 (규칙 2)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", actualMethod: "predicate", actualDisposition: "REVIEW_REQUIRED", criterionOutcome: "UNSUPPORTED", controlClass: CONTROL_CLASS.ENFORCEABLE }]);
  assert.equal(final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" }).blockers[0].reason, "UNRESOLVED_UNSUPPORTED");
});

test("Final 직전 결과물이 바뀌면 자동 승격되지 않는다 (규칙 6·8)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS", controlClass: CONTROL_CLASS.ENFORCEABLE }]);
  const result = final.aggregateFinalDisposition({
    plan, ledger, assuranceSubjectRef: "subj-a",
    subjectRecheck: { ok: false, changed: [{ path: "report.md" }] },
  });
  assert.equal(result.finalPass, false);
  assert.equal(result.verdict, "INVALIDATED");
});

test("Final 직전 frozen input이 바뀌면 PASS가 될 수 없다 (규칙 7)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS", controlClass: CONTROL_CLASS.ENFORCEABLE }]);
  const result = final.aggregateFinalDisposition({
    plan, ledger, assuranceSubjectRef: "subj-a",
    inputRecheck: { ok: false, changed: [{ locator: "source/ko.txt" }] },
  });
  assert.equal(result.finalPass, false);
  assert.equal(result.blockers.some((b) => b.reason === "FROZEN_INPUT_CHANGED"), true);
});

test("동결 계획이 실행 중 바뀌면 Final PASS가 될 수 없다 (INV-1)", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" }] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS", controlClass: CONTROL_CLASS.ENFORCEABLE }]);
  const result = final.aggregateFinalDisposition({
    plan, ledger, assuranceSubjectRef: "subj-a",
    planIntegrity: { ok: false, expected: "a", actual: "b" },
  });
  assert.equal(result.finalPass, false);
  assert.equal(result.blockers[0].reason, "PLAN_TAMPERED");
});

test("계획된 criterion에 판정 기록이 없으면 통과로 세지 않는다", () => {
  const plan = { criteria: [{ criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" }] };
  const result = final.aggregateFinalDisposition({
    plan, ledger: new AssuranceLedger({ runId: "RUN-001" }), assuranceSubjectRef: "subj-a",
  });
  assert.equal(result.finalPass, false);
});

test("모두 해소되면 Final PASS다 (규칙 9)", () => {
  const plan = {
    criteria: [
      { criterionId: "V1", statement: "a", plannedMethod: "predicate", plannedDisposition: "VERIFIED" },
      reviewCriterion("V2"),
    ],
  };
  const ledger = ledgerWith([
    { criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED", actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS", controlClass: CONTROL_CLASS.ENFORCEABLE },
    { criterionId: "V2", plannedMethod: "review", plannedDisposition: "REVIEW_REQUIRED", actualMethod: "review", actualDisposition: "REVIEW_REQUIRED", criterionOutcome: null, controlClass: null },
  ]);
  ledger.appendReviewerResolution({ criterionId: "V2", outcome: "PASS", assuranceSubjectRef: "subj-a" });
  const result = final.aggregateFinalDisposition({
    plan, ledger, assuranceSubjectRef: "subj-a",
    subjectRecheck: { ok: true, changed: [] },
    inputRecheck: { ok: true, changed: [] },
    planIntegrity: { ok: true },
  });
  assert.equal(result.finalPass, true);
  assert.equal(result.summary.automatic, 1);
  assert.equal(result.summary.review, 1);
});

test("차단 사유는 내부 어휘가 아니라 읽을 수 있는 설명으로 요약된다 (§9)", () => {
  const plan = { criteria: [reviewCriterion("V1")] };
  const ledger = ledgerWith([{ criterionId: "V1", plannedMethod: "review", plannedDisposition: "REVIEW_REQUIRED", actualMethod: "review", actualDisposition: "REVIEW_REQUIRED", criterionOutcome: null, controlClass: null }]);
  const described = final.describeBlockers(final.aggregateFinalDisposition({ plan, ledger, assuranceSubjectRef: "subj-a" }));
  assert.equal(described[0].count, 1);
  assert.ok(described[0].label.includes("검수자"));
});

test("평가할 수 없는 비교는 FAIL이 아니라 ERROR다 (조용한 강등 금지)", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "a.md"), "본문");
    const caps = discoverVerificationCapabilities();

    // 잘못된 정규식: 계약의 문제이지 산출물의 결함이 아니다.
    const badPattern = predicate.evaluatePredicate(
      { kind: "text.matches", target: "a.md", expected: "([unclosed" },
      { root, capabilities: caps }
    );
    assert.equal(badPattern.outcome, "ERROR");

    // 모르는 비교 방식도 마찬가지다.
    const badOperator = predicate.evaluatePredicate(
      { kind: "text.lines", target: "a.md", operator: "≈", expected: 1 },
      { root, capabilities: caps }
    );
    assert.equal(badOperator.outcome, "ERROR");

    // ERROR는 VERIFIED가 될 수 없다 (INV-3).
    const routed = router.routeDisposition({
      criterion: { plannedMethod: "predicate", plannedDisposition: "VERIFIED", downgradeTo: "REVIEW_REQUIRED" },
      outcome: badPattern.outcome,
      controlClass: CONTROL_CLASS.NEITHER,
    });
    assert.equal(routed.actualDisposition, "REVIEW_REQUIRED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
