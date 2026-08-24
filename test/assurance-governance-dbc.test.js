"use strict";

// Stage D-B / D-C — Resource Governance · Provenance & Audit.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md):
//   §22  controlClass는 실제 runtime enforcement에서 계산한다. 선언을 믿지 않는다.
//        D-A0의 process = OBSERVABLE baseline을 보존한다.
//   §23  side effect + NEITHER → 행동 전 HUMAN_APPROVAL.
//        사후 자기보고를 verified evidence로 승격하지 않는다.
//   §24  sandbox를 목표 자체로 삼지 않는다. 강제 가능할 때만 올린다.
//   §25  D-C는 과거 사실을 소급해서 만들어내지 않는다.
//   §27  Run lineage는 typed relation이다. 기존 기록을 파괴하지 않는다.
//   §29  "왜 PASS였는가"를 저장된 사실만으로 재구성할 수 있다.

const test = require("node:test");
const assert = require("node:assert/strict");

const { CONTROL_CLASS } = require("../src/agora/verification-runner");
const gov = require("../src/agora/assurance/resource-governance");
const prov = require("../src/agora/assurance/provenance");
const lineage = require("../src/agora/assurance/run-lineage");

// ---- D-B: control class는 계산된다 (§22) ----

test("Agora 자체 artifact read는 ENFORCEABLE이다", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "artifact", action: "read" }),
    CONTROL_CLASS.ENFORCEABLE
  );
});

test("workspace mutation은 lease가 있을 때만 ENFORCEABLE이다", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "workspace", action: "mutate", leaseHeld: true }),
    CONTROL_CLASS.ENFORCEABLE
  );
  // lease 없이 변경하면 Agora가 실제로 막는 것이 없다.
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "workspace", action: "mutate", leaseHeld: false }),
    CONTROL_CLASS.NEITHER
  );
});

test("generic subprocess는 OBSERVABLE 그대로다 (D-A0 baseline 보존)", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "process", action: "execute" }),
    CONTROL_CLASS.OBSERVABLE
  );
});

test("외부 side effect는 관측 신호가 없으면 NEITHER다", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "external", action: "external-effect" }),
    CONTROL_CLASS.NEITHER
  );
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "external", action: "external-effect", observable: true }),
    CONTROL_CLASS.OBSERVABLE
  );
});

test("실제 containment가 생겼을 때만 controlClass를 올린다 (§24)", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "process", action: "execute", containment: "os-sandbox" }),
    CONTROL_CLASS.ENFORCEABLE
  );
  // 아무 문자열이나 넣는다고 올라가지 않는다.
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "process", action: "execute", containment: "we-promise" }),
    CONTROL_CLASS.OBSERVABLE
  );
});

test("모르는 자원/행동 조합은 위로 올리지 않는다 (fail-closed floor)", () => {
  assert.equal(
    gov.computeResourceControlClass({ resourceKind: "artifact", action: "mutate" }),
    CONTROL_CLASS.NEITHER
  );
});

// ---- D-B: 권한과 승인 ----

test("요청 권한이 역할 상한을 넘지 못한다", () => {
  assert.equal(gov.effectivePermission("workspace-write", "workspace-read"), "workspace-read");
  assert.equal(gov.effectivePermission("chat", "workspace-write"), "chat");
  assert.equal(gov.effectivePermission("workspace-write", "unknown"), null);
});

test("되돌릴 수 없는 외부 행동은 사전 사용자 승인이 필요하다 (§23)", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "external", action: "external-effect", resourceId: "mail:send", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write" }
  );
  assert.equal(adjudication.ok, true);
  assert.equal(adjudication.controlClass, CONTROL_CLASS.NEITHER);
  assert.equal(adjudication.reversibility, "IRREVERSIBLE");
  assert.equal(adjudication.approvalRequirement, "HUMAN_APPROVAL");
  assert.equal(adjudication.autoExecutable, false);
});

test("승인 없이 실행하려는 시도는 관문에서 막힌다", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "external", action: "external-effect", resourceId: "deploy", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write" }
  );
  const denied = gov.admitAction(adjudication, { humanApprovalGranted: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "HUMAN_APPROVAL_REQUIRED");

  const allowed = gov.admitAction(adjudication, { humanApprovalGranted: true });
  assert.equal(allowed.ok, true);
});

test("lease 아래의 workspace 변경은 사전 승인 없이 진행할 수 있다", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "workspace", action: "mutate", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-write", leaseHeld: true, checkpointProtected: true }
  );
  assert.equal(adjudication.controlClass, CONTROL_CLASS.ENFORCEABLE);
  assert.equal(adjudication.reversibility, "REVERSIBLE");
  assert.equal(adjudication.approvalRequirement, "NONE");
  assert.equal(adjudication.autoExecutable, true);
});

test("변경 권한이 없으면 변경 행동을 허용하지 않는다", () => {
  const adjudication = gov.adjudicateAction(
    { resourceKind: "workspace", action: "mutate", requestedPermission: "workspace-write" },
    { permissionCap: "workspace-read", leaseHeld: true }
  );
  assert.equal(adjudication.ok, false);
  assert.equal(adjudication.code, "PERMISSION_DENIED");
});

test("계획된 사용자 승인 지점을 사전에 뽑아낼 수 있다 (§9 P-3)", () => {
  const planned = gov.plannedApprovals(
    [
      { resourceKind: "workspace", action: "mutate", requestedPermission: "workspace-write" },
      { resourceKind: "external", action: "external-effect", resourceId: "mail:send", requestedPermission: "workspace-write" },
    ],
    { permissionCap: "workspace-write", leaseHeld: true, checkpointProtected: true }
  );
  assert.equal(planned.length, 1);
  assert.equal(planned[0].resourceId, "mail:send");
});

// ---- D-C: provenance ----

function buildLog() {
  const log = new prov.ProvenanceLog({ runId: "RUN-001" });
  log.recordTaskFrozen({ runId: "RUN-001", taskHash: "task-a", planHash: "plan-a", contractHash: "c-a", decisionIds: ["D-12"], schemaVersion: 2 });
  log.recordPlanFrozen({ runId: "RUN-001", planHash: "plan-a", structured: true, criteria: [{ criterionId: "V1" }, { criterionId: "V2" }] });
  log.recordInputBinding({ runId: "RUN-001", bindings: [{ inputId: "IN-01", locator: "src.txt", mode: "frozen", state: "BOUND", sha256: "abc" }] });
  log.recordCapabilitySnapshot({ runId: "RUN-001", snapshotId: "vcap-1" });
  log.recordWorkspaceMutation({ runId: "RUN-001", event: "acquired", resourceId: "/ws", holderId: "room-1", purpose: "builder" });
  log.recordAssuranceSubject({ runId: "RUN-001", assuranceSubjectRef: "subj-a", entryCount: 2, changeObservation: "git" });
  log.recordCriterionExecution({
    runId: "RUN-001", criterionId: "V1", plannedMethod: "predicate", plannedDisposition: "VERIFIED",
    actualMethod: "predicate", actualDisposition: "VERIFIED", criterionOutcome: "PASS",
    controlClass: CONTROL_CLASS.ENFORCEABLE, capabilitySnapshotRef: "vcap-1", assuranceSubjectRef: "subj-a",
  });
  log.recordCriterionExecution({
    runId: "RUN-001", criterionId: "V2", plannedMethod: "predicate", plannedDisposition: "VERIFIED",
    actualMethod: "predicate", actualDisposition: "REVIEW_REQUIRED", criterionOutcome: "UNSUPPORTED",
    controlClass: CONTROL_CLASS.ENFORCEABLE, downgradeReason: "artifact.xlsx unavailable",
    capabilitySnapshotRef: "vcap-1", assuranceSubjectRef: "subj-a",
  });
  log.recordReviewerResolution({ runId: "RUN-001", criterionId: "V2", outcome: "PASS", assuranceSubjectRef: "subj-a" });
  log.recordFinalDisposition({ runId: "RUN-001", verdict: "PASS", assuranceSubjectRef: "subj-a", blockers: [], summary: { total: 2 } });
  log.recordRecorder({ runId: "RUN-001", ok: true });
  return log;
}

test("provenance 기록은 append-only다", () => {
  const log = buildLog();
  const before = log.events.length;
  const copy = log.events;
  copy[0].taskHash = "tampered";
  assert.equal(log.events[0].taskHash, "task-a");
  assert.equal(log.events.length, before);
});

test("'왜 PASS였는가'를 저장된 사실만으로 재구성한다 (§29)", () => {
  const explained = prov.explainRun(buildLog(), "RUN-001");
  assert.equal(explained.reconstructable, true);
  assert.deepEqual(explained.missingFacts, []);
  assert.equal(explained.taskHash, "task-a");
  assert.equal(explained.planHash, "plan-a");
  assert.deepEqual(explained.decisionIds, ["D-12"]);
  assert.deepEqual(explained.inputs.map((i) => i.locator), ["src.txt"]);
  assert.equal(explained.finalSubjectRef, "subj-a");
  assert.deepEqual(explained.automatic, ["V1"]);
  assert.deepEqual(explained.reviewerJudged, [{ criterionId: "V2", outcome: "PASS" }]);
  assert.equal(explained.downgrades.length, 1);
  assert.match(explained.downgrades[0].reason, /xlsx/);
  assert.equal(explained.finalVerdict, "PASS");
});

test("기록되지 않은 사실을 만들어내지 않는다 (§25)", () => {
  const log = new prov.ProvenanceLog({ runId: "RUN-002" });
  log.recordTaskFrozen({ runId: "RUN-002", taskHash: "t", planHash: "p", contractHash: "c", schemaVersion: 2 });
  const explained = prov.explainRun(log, "RUN-002");
  assert.equal(explained.reconstructable, false);
  assert.ok(explained.missingFacts.includes("verificationPlan"));
  assert.ok(explained.missingFacts.includes("finalDisposition"));
  assert.equal(explained.finalVerdict, null, "없는 판정을 지어내지 않는다");
});

test("logical graph projection이 decision→task→run→subject 사슬을 만든다 (§26)", () => {
  const graph = prov.projectGraph(buildLog(), { runId: "RUN-001" });
  const has = (from, to, relation) =>
    graph.edges.some((e) => e.from.includes(from) && e.to.includes(to) && (!relation || e.relation === relation));
  assert.ok(has("decision:D-12", "task:task-a", "decided"));
  assert.ok(has("task:task-a", "run:RUN-001", "frozen-into"));
  assert.ok(has("run:RUN-001", "assuranceSubject:subj-a", "produced"));
  assert.ok(has("criterionExecution:V1", "assuranceSubject:subj-a", "judges"));
  assert.ok(has("capabilitySnapshot:vcap-1", "criterionExecution:V1", "enabled"));
});

test("subject가 교체되면 supersede 관계로 남는다 (INV-5)", () => {
  const log = new prov.ProvenanceLog({ runId: "RUN-001" });
  log.recordAssuranceSubject({ runId: "RUN-001", assuranceSubjectRef: "subj-a", entryCount: 1, changeObservation: "git" });
  log.recordAssuranceSubject({ runId: "RUN-001", assuranceSubjectRef: "subj-b", entryCount: 1, changeObservation: "git", previousSubjectRef: "subj-a" });
  const graph = prov.projectGraph(log, { runId: "RUN-001" });
  assert.ok(graph.edges.some((e) => e.from.includes("subj-a") && e.to.includes("subj-b") && e.relation === "superseded-by"));
  assert.equal(prov.explainRun(log, "RUN-001").subjectChanges, 1);
});

// ---- D-C: typed lineage (§27) ----

test("lineage는 typed relation으로 기록된다", () => {
  const run = lineage.attachLineage({ runId: "RUN-002" }, { parentRunId: "RUN-001", lineageRelation: "replan" });
  assert.equal(run.parentRunId, "RUN-001");
  assert.equal(run.lineageRelation, "replan");
  // 호환 필드도 유지된다.
  assert.equal(run.carriedFromRunId, "RUN-001");
});

test("알 수 없는 관계를 임의로 받아들이지 않는다", () => {
  const run = lineage.attachLineage({ runId: "RUN-002" }, { parentRunId: "RUN-001", lineageRelation: "made-up" });
  assert.equal(run.lineageRelation, null);
});

test("옛 carriedFromRunId 기록을 파괴하지 않고 carry로 읽는다", () => {
  const legacy = { runId: "RUN-002", carriedFromRunId: "RUN-001" };
  const read = lineage.readLineage(legacy);
  assert.equal(read.parentRunId, "RUN-001");
  assert.equal(read.lineageRelation, "carry");
  assert.equal(read.inferred, true, "왜 이어졌는지는 지어내지 않는다");
  // 원본은 그대로다.
  assert.equal(legacy.lineageRelation, undefined);
});

test("replan/retry/revision 사슬을 거슬러 올라갈 수 있다", () => {
  const runs = new Map([
    ["RUN-003", { runId: "RUN-003", parentRunId: "RUN-002", lineageRelation: "retry" }],
    ["RUN-002", { runId: "RUN-002", parentRunId: "RUN-001", lineageRelation: "replan" }],
    ["RUN-001", { runId: "RUN-001" }],
  ]);
  const chain = lineage.traceLineage(runs, "RUN-003");
  assert.deepEqual(chain.map((c) => c.lineageRelation), ["retry", "replan", null]);
});

test("순환 lineage는 무한히 돌지 않는다", () => {
  const runs = new Map([
    ["A", { runId: "A", parentRunId: "B", lineageRelation: "retry" }],
    ["B", { runId: "B", parentRunId: "A", lineageRelation: "retry" }],
  ]);
  const chain = lineage.traceLineage(runs, "A");
  assert.ok(chain.some((c) => c.cycle === true));
  assert.ok(chain.length <= 3);
});

test("lineage event가 graph에 typed edge로 들어간다", () => {
  const log = new prov.ProvenanceLog({ runId: "RUN-002" });
  log.recordLineage({ runId: "RUN-002", parentRunId: "RUN-001", lineageRelation: "revision" });
  const graph = prov.projectGraph(log);
  assert.ok(graph.edges.some((e) => e.from === "run:RUN-001" && e.to === "run:RUN-002" && e.relation === "revision"));
});
