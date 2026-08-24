"use strict";

// Stage D — 1차 독립 검수 blocker(B1~B9) 회귀 테스트.
//
// 각 테스트는 검수가 지적한 **실제 실패 모드**를 재현한다. 모듈을 직접
// 부르는 것이 아니라, 가능한 한 production 진입점에서 시작한다
// (D-0에서 배운 원칙: wrapper를 직접 부르는 테스트는 진입 경로 우회를 못 잡는다).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const taskSchema = require("../src/agora/assurance/task-schema-v2");
const frozenContract = require("../src/agora/assurance/frozen-contract");
const inputBinding = require("../src/agora/assurance/input-binding");
const assuranceSubject = require("../src/agora/assurance/assurance-subject");
const gov = require("../src/agora/assurance/resource-governance");
const prov = require("../src/agora/assurance/provenance");
const { AssuranceRun, MODES } = require("../src/agora/assurance/assurance-run");
const { transitionProfessionalRun, createProfessionalRun } = require("../src/agora/professional-run");
const { readLineage } = require("../src/agora/assurance/run-lineage");

function tempRoot(prefix = "agora-rep-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PLAN = "```json\n" + JSON.stringify([
  { id: "V1", method: "predicate", statement: "보고서 존재", check: { kind: "exists", path: "report.md" } },
  { id: "V2", method: "review", statement: "논조 판단" },
]) + "\n```";

function v2Task({ inputs, deliverables, plan, omit = [] } = {}) {
  const sections = [
    ["Goal", "보고서를 만든다."],
    ["Inputs / Source Data", inputs ?? "- 없음"],
    ["Requirements", "요구사항."],
    ["Work Approach", "접근."],
    ["Deliverables", deliverables ?? "- `report.md`"],
    ["Acceptance Criteria", "기준."],
    ["Verification Plan", plan ?? PLAN],
    ["Out of Scope", "제외."],
  ].filter(([label]) => !omit.includes(label));
  return sections.map(([label, body]) => `## ${label}\n${body}`).join("\n\n");
}

// ---- B2 — v2 intent가 조용히 legacy로 내려가면 안 된다 ----

test("B2: v2 어휘를 쓰면서 Inputs를 빠뜨린 계약은 legacy가 아니라 계약 오류다", () => {
  const root = tempRoot();
  try {
    const content = v2Task({ omit: ["Inputs / Source Data"] });
    const classified = taskSchema.classifyTaskSchema(content);
    assert.equal(classified.intent, "V2_INCOMPLETE");
    assert.ok(classified.missing.includes("Inputs / Source Data"));

    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    const frozen = run.freeze(content);
    assert.equal(frozen.ok, false, "legacy로 조용히 내려가면 안 된다");
    assert.equal(frozen.mode, MODES.ASSURED);
    assert.equal(frozen.code, "TASK_CONTRACT_INCOMPLETE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B2: Deliverables만 빠져도 마찬가지다", () => {
  const root = tempRoot();
  try {
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    const frozen = run.freeze(v2Task({ omit: ["Deliverables"] }));
    assert.equal(frozen.ok, false);
    assert.equal(frozen.code, "TASK_CONTRACT_INCOMPLETE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B2: 순수 v1 문서는 그대로 legacy로 흐른다 (회귀 없음)", () => {
  const root = tempRoot();
  try {
    const v1 = [
      "## Goal\n목표", "## Requirements\n요구", "## Implementation Approach\n방법",
      "## Acceptance Criteria\n기준", "## Verification\n검증", "## Out of Scope\n제외",
    ].join("\n\n");
    assert.equal(taskSchema.classifyTaskSchema(v1).intent, "LEGACY_V1");
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    const frozen = run.freeze(v1);
    assert.equal(frozen.ok, true);
    assert.equal(frozen.mode, MODES.LEGACY);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B2: 완전한 v2는 assured로 간다", () => {
  const root = tempRoot();
  try {
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    const frozen = run.freeze(v2Task());
    assert.equal(frozen.ok, true, frozen.error);
    assert.equal(run.assured, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- B7 — frozen 입력을 보증할 수 없으면 계약이 성립하지 않는다 ----

test("B7: 지문을 뜰 수 없는 frozen 입력은 계약 단계에서 막힌다", () => {
  const root = tempRoot();
  try {
    // 디렉터리를 frozen 입력으로 선언 — 내용 동일성을 확인할 수단이 없다.
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const built = frozenContract.buildFrozenContract(
      v2Task({ inputs: "- `data` (frozen)" }),
      { root }
    );
    assert.equal(built.ok, false);
    assert.equal(built.code, "FROZEN_INPUT_UNVERIFIABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B7: frozen URL도 계약 단계에서 막힌다 (조용히 진행하지 않는다)", () => {
  const root = tempRoot();
  try {
    const built = frozenContract.buildFrozenContract(
      v2Task({ inputs: "- https://example.com/x (frozen)" }),
      { root }
    );
    assert.equal(built.ok, false);
    assert.equal(built.code, "FROZEN_INPUT_UNVERIFIABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B7: 같은 입력을 live로 선언하면 진행된다 (달라도 된다고 인정한 것)", () => {
  const root = tempRoot();
  try {
    const built = frozenContract.buildFrozenContract(
      v2Task({ inputs: "- https://example.com/x (live)" }),
      { root }
    );
    assert.equal(built.ok, true, built.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B7: 재대조에서 '확인 불가'를 통과로 세지 않는다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "원본");
    const binding = inputBinding.bindInputs(
      [{ inputId: "IN-01", locator: "a.txt", kind: "path", mode: "frozen" }],
      { root }
    );
    assert.equal(inputBinding.recheckFrozenInputs(binding, { root }).ok, true);

    // 파일이 디렉터리로 바뀌어 더 이상 같은지 확인할 수 없다.
    fs.rmSync(file);
    fs.mkdirSync(file);
    const after = inputBinding.recheckFrozenInputs(binding, { root });
    assert.equal(after.ok, false, "확인하지 못한 것을 같다고 하면 안 된다");
    assert.equal(after.results[0].result, "UNVERIFIABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- B8 — subject 재확인에서 '확인 불가'는 성공이 아니다 ----

test("B8: 판정 당시 읽혔던 산출물을 지금 읽을 수 없으면 recheck는 실패다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "report.md");
    fs.writeFileSync(file, "본문");
    const snap = assuranceSubject.createAssuranceSubject({ root, deliverables: ["report.md"] });
    assert.equal(assuranceSubject.recheckSubject(snap, { root }).ok, true);

    fs.rmSync(file);
    fs.mkdirSync(file);
    const after = assuranceSubject.recheckSubject(snap, { root });
    assert.equal(after.ok, false);
    assert.equal(after.changed[0].unverifiable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B8: workspace를 잃으면 확인 불가로 잡힌다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "report.md"), "본문");
    const snap = assuranceSubject.createAssuranceSubject({ root, deliverables: ["report.md"] });
    const after = assuranceSubject.recheckSubject(snap, { root: null });
    assert.equal(after.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- B4 — 보완된 결과물은 새 subject + 새 검증 ----

test("B4: Builder가 다시 실행되면 새 subject와 새 검증이 붙고 과거는 무효화된다", async () => {
  const root = tempRoot();
  try {
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    assert.equal(run.freeze(v2Task()).ok, true);

    // 1차 결과물 — 산출물이 없어 FAIL.
    run.captureSubject({ changedPaths: [], changeObservation: "observed" });
    const first = await run.verify({ workerPermission: "workspace-write" });
    assert.equal(first.records[0].criterionOutcome, "FAIL");
    const firstSubject = run.assuranceSubjectRef;

    // 보완 — Builder가 산출물을 만들었다.
    fs.writeFileSync(path.join(root, "report.md"), "# 보고서");
    run.captureSubject({ changedPaths: ["report.md"], changeObservation: "observed" });
    const secondSubject = run.assuranceSubjectRef;
    assert.notEqual(secondSubject, firstSubject, "결과물이 바뀌면 새 subject다");

    const second = await run.verify({ workerPermission: "workspace-write" });
    assert.equal(second.records[0].criterionOutcome, "PASS");

    // 과거 FAIL 기록은 남고, 그 사이에 무효화가 들어간다(R-8).
    const history = run.ledger.historyFor("V1");
    assert.deepEqual(
      history.map((h) => h.criterionOutcome),
      ["FAIL", "INVALIDATED", "PASS"]
    );

    run.resolveByReviewer({ criterionId: "V2", outcome: "PASS" });
    const final = run.finalize();
    assert.equal(final.finalPass, true, JSON.stringify(final.blockers));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- B9 — 무효화·lineage가 provenance에 남는다 ----

test("B9: PASS → INVALIDATED → 재검사 PASS를 provenance만으로 재구성한다", async () => {
  const root = tempRoot();
  try {
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    run.freeze(v2Task());
    fs.writeFileSync(path.join(root, "report.md"), "v1");
    run.captureSubject({ changedPaths: ["report.md"], changeObservation: "observed" });
    await run.verify({ workerPermission: "workspace-write" });

    fs.writeFileSync(path.join(root, "report.md"), "v2");
    run.captureSubject({ changedPaths: ["report.md"], changeObservation: "observed" });
    await run.verify({ workerPermission: "workspace-write" });

    const explained = run.explain();
    assert.ok(explained.invalidations.length > 0, "무효화가 provenance에 남아야 한다");
    assert.ok(explained.invalidations[0].previousSubjectRef, "어떤 결과물의 판정이 무효화됐는지 남는다");
    assert.equal(explained.subjectChanges, 1);

    const graph = prov.projectGraph(run.provenance, { runId: "R1" });
    assert.ok(graph.edges.some((e) => e.relation === "invalidates"));
    assert.ok(graph.edges.some((e) => e.relation === "superseded-by"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B9: REPLAN이 typed lineage로 기록되고 Run flow에 전달된다", () => {
  const run = createProfessionalRun({ professionalRunId: "pr-1" });
  const replanned = transitionProfessionalRun(run, {
    type: "REPLAN_RESET",
    carriedFromRunId: "RUN-001",
  });
  assert.equal(replanned.ok, true);
  assert.equal(replanned.state.parentRunId, "RUN-001");
  assert.equal(replanned.state.lineageRelation, "replan");
  // 호환 필드도 유지된다.
  assert.equal(replanned.state.carriedFromRunId, "RUN-001");

  const read = readLineage(replanned.state);
  assert.equal(read.lineageRelation, "replan");
  assert.equal(read.inferred, false, "지어낸 것이 아니라 실제로 기록된 관계다");
});

test("B9: freeze에 lineage를 넘기면 provenance에 typed edge가 생긴다", () => {
  const root = tempRoot();
  try {
    const run = new AssuranceRun({ runId: "RUN-002", runDir: path.join(root, "R2"), root });
    run.freeze(v2Task(), { lineage: { parentRunId: "RUN-001", lineageRelation: "replan" } });
    const graph = prov.projectGraph(run.provenance);
    assert.ok(
      graph.edges.some((e) => e.from === "run:RUN-001" && e.to === "run:RUN-002" && e.relation === "replan")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- B6 — D-B 관문이 실제 실행 앞에 선다 ----

test("B6: 승인이 필요한 프로세스 검사는 승인 없이 실행되지 않는다", async () => {
  const root = tempRoot();
  try {
    const plan = "```json\n" + JSON.stringify([
      { id: "V1", method: "process", statement: "검산", executable: process.execPath, argv: ["-e", "process.exit(0)"] },
    ]) + "\n```";
    const run = new AssuranceRun({ runId: "R1", runDir: path.join(root, "R1"), root });
    run.freeze(v2Task({ plan }));
    run.captureSubject({ changedPaths: [], changeObservation: "observed" });

    // 권한을 계산할 수 없으면 관문이 막는다(사후 자기보고로 승격되지 않는다).
    const blocked = await run.verify({ workerPermission: "unknown-permission" });
    assert.notEqual(blocked.records[0].actualDisposition, "VERIFIED");
    assert.equal(blocked.records[0].criterionOutcome, "UNSUPPORTED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("B6: 되돌릴 수 없는 외부 행동은 승인 없이 실행되지 않는다", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "external", action: "external-effect", resourceId: "mail:send", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write" }
  );
  assert.equal(gov.admitAction(adjudication, { humanApprovalGranted: false }).ok, false);
  assert.equal(gov.admitAction(adjudication, { humanApprovalGranted: true }).ok, true);
});

test("B6: lease를 든 정상 workspace 변경은 승인 없이 진행된다 (오탐 없음)", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "workspace", action: "mutate", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write", leaseHeld: true, checkpointProtected: true }
  );
  assert.equal(gov.admitAction(adjudication, {}).ok, true);

  // checkpoint가 없어도(비-Git) 막지 않는다 — 기존 동작 회귀 방지.
  const unprotected = gov.adjudicateAction(
    { resourceKind: "workspace", action: "mutate", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write", leaseHeld: true, checkpointProtected: false }
  );
  assert.equal(gov.admitAction(unprotected, {}).ok, true);
});
