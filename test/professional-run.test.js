"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROFESSIONAL_SCHEMA_VERSION,
  PROFESSIONAL_NODES,
  PROFESSIONAL_STATUSES,
  phaseForNode,
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
} = require("../src/agora/professional-run");

test("phaseForNode maps nodes to PLAN and ACT phases correctly", () => {
  assert.equal(phaseForNode("PLANNING"), "PLAN");
  assert.equal(phaseForNode("PLAN_REVIEW"), "PLAN");
  assert.equal(phaseForNode("READY"), "PLAN");
  assert.equal(phaseForNode("IMPLEMENTING"), "ACT");
  assert.equal(phaseForNode("REVIEWING"), "ACT");
  assert.equal(phaseForNode("RECORDING"), "ACT");
  assert.equal(phaseForNode("COMPLETED"), "ACT");
  assert.equal(phaseForNode("UNKNOWN"), null);
});

test("createProfessionalRun initializes default state correctly", () => {
  const run = createProfessionalRun();
  assert.equal(run.schemaVersion, PROFESSIONAL_SCHEMA_VERSION);
  assert.equal(run.node, "PLANNING");
  assert.equal(run.status, "RUNNING");
  assert.equal(run.planRound, 1);
  assert.equal(run.implementationRound, 0);
  assert.equal(run.policy.autoContinueReady, false);
});

test("transitionProfessionalRun handles PLAN -> ACT progression", () => {
  let run = createProfessionalRun({ policy: { autoContinueReady: false } });
  
  let res = transitionProfessionalRun(run, { type: "PLANNER_PLAN_READY", taskPath: "tasks/TASK-001.md", taskId: "TASK-001" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "PLAN_REVIEW");
  assert.equal(run.status, "RUNNING");

  res = transitionProfessionalRun(run, { type: "PLAN_REVIEW_PASS", approvedTaskHash: "hash-123" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "READY");
  assert.equal(run.status, "WAITING");
  assert.equal(run.approvedTaskHash, "hash-123");

  res = transitionProfessionalRun(run, { type: "USER_EXECUTE", frozenRunId: "RUN-001", checkpointId: "cp-001" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "IMPLEMENTING");
  assert.equal(run.status, "RUNNING");
  assert.equal(run.frozenRunId, "RUN-001");

  res = transitionProfessionalRun(run, { type: "BUILDER_DONE" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "REVIEWING");
  assert.equal(run.status, "RUNNING");

  res = transitionProfessionalRun(run, { type: "REVIEW_PASS" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "RECORDING");
  assert.equal(run.status, "RUNNING");

  res = transitionProfessionalRun(run, { type: "RECORDER_DONE" });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "COMPLETED");
  assert.equal(run.status, "COMPLETED");
});

test("transitionProfessionalRun handles revision loops within policy bounds", () => {
  let run = createProfessionalRun({
    node: "PLAN_REVIEW",
    policy: { planAutoRevisions: 2, implementationAutoRevisions: 1 },
  });

  let res = transitionProfessionalRun(run, { type: "PLAN_REVIEW_FIX", canAutoRevise: true });
  assert.equal(res.ok, true);
  run = res.state;
  assert.equal(run.node, "PLANNING");
  assert.equal(run.status, "RUNNING");
  assert.equal(run.planRevisionCount, 1);
  assert.equal(run.planRound, 2);

  res = transitionProfessionalRun(run, { type: "PLANNER_PLAN_READY" });
  run = res.state;
  res = transitionProfessionalRun(run, { type: "PLAN_REVIEW_FIX", canAutoRevise: true });
  run = res.state;
  assert.equal(run.planRevisionCount, 2);

  res = transitionProfessionalRun(run, { type: "PLANNER_PLAN_READY" });
  run = res.state;
  res = transitionProfessionalRun(run, { type: "PLAN_REVIEW_FIX", canAutoRevise: true });
  run = res.state;
  assert.equal(run.node, "PLAN_REVIEW");
  assert.equal(run.status, "WAITING");
  assert.equal(run.stopReason, "FIX_REQUIRED");
});

test("publicProfessionalState projects safe UI view", () => {
  const run = createProfessionalRun({
    taskPath: ".project-memory/tasks/TASK-005.md",
    approvedTaskHash: "hash-555",
    node: "READY",
    status: "WAITING",
  });
  const view = publicProfessionalState(run, { canRestore: true });
  assert.equal(view.phase, "PLAN");
  assert.equal(view.planReady, true);
  assert.equal(view.taskId, "TASK-005");
  assert.equal(view.canRestore, true);
  assert.equal(view.active, false);
});

test("recorder failure waits at RECORDING for an explicit retry", () => {
  const run = createProfessionalRun({ node: "RECORDING", status: "RUNNING" });
  const result = transitionProfessionalRun(run, {
    type: "RECORDER_FAILED",
    stopReason: "RECORDER_FAILED",
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.node, "RECORDING");
  assert.equal(result.state.status, "WAITING");
  assert.equal(result.state.stopReason, "RECORDER_FAILED");

  const retry = transitionProfessionalRun(result.state, { type: "USER_RETRY_RECORDER" });
  assert.equal(retry.ok, true);
  assert.equal(retry.state.status, "RUNNING");
});

test("TASK 변경은 READY에서 기획 재검수 대기로 되돌린다", () => {
  const run = createProfessionalRun({ node: "READY", status: "WAITING" });
  const result = transitionProfessionalRun(run, { type: "TASK_CHANGED_AFTER_REVIEW" });

  assert.equal(result.ok, true);
  assert.equal(result.state.node, "PLAN_REVIEW");
  assert.equal(result.state.status, "WAITING");
  assert.equal(result.state.stopReason, "TASK_CHANGED_AFTER_REVIEW");
});

test("USER_EXECUTE는 checkpoint 보호 상태를 enum으로 기록한다", () => {
  let run = createProfessionalRun({ node: "READY", status: "WAITING", frozenRunId: "RUN-001" });
  const res = transitionProfessionalRun(run, {
    type: "USER_EXECUTE",
    frozenRunId: "RUN-001",
    checkpointProtection: "protected",
  });
  assert.equal(res.ok, true);
  assert.equal(res.state.node, "IMPLEMENTING");
  assert.equal(res.state.checkpointProtection, "protected");
  assert.equal(res.state.frozenRunId, "RUN-001");

  // checkpointProtection 미지정 시 기본 protected
  let run2 = createProfessionalRun({ node: "READY", status: "WAITING" });
  const res2 = transitionProfessionalRun(run2, { type: "USER_EXECUTE" });
  assert.equal(res2.state.checkpointProtection, "protected");
});

test("CHECKPOINT_FAILED는 READY/IMPLEMENTING에서만 가능하고 frozenRunId를 유지한다", () => {
  for (const node of ["READY", "IMPLEMENTING"]) {
    const run = createProfessionalRun({
      node,
      status: node === "READY" ? "WAITING" : "RUNNING",
      frozenRunId: "RUN-009",
    });
    const res = transitionProfessionalRun(run, { type: "CHECKPOINT_FAILED", checkpointFailReason: "CHECKPOINT_GIT_FAILED" });
    assert.equal(res.ok, true);
    assert.equal(res.state.status, "WAITING");
    assert.equal(res.state.stopReason, "CHECKPOINT_FAILED");
    assert.equal(res.state.checkpointFailReason, "CHECKPOINT_GIT_FAILED");
    assert.equal(res.state.checkpointProtection, "unavailable_checkpoint_failed");
    assert.equal(res.state.frozenRunId, "RUN-009", node + " 노드에서 frozenRunId 유지");
  }

  // READY/IMPLEMENTING 외에는 거부
  const bad = createProfessionalRun({ node: "PLANNING", status: "RUNNING" });
  const badRes = transitionProfessionalRun(bad, { type: "CHECKPOINT_FAILED" });
  assert.equal(badRes.ok, false);
});

test("CHECKPOINT_RETRY는 재시도 시 frozenRunId를 유지하고 체크포인트 보호 상태를 해제한다", () => {
  const run = createProfessionalRun({ node: "IMPLEMENTING", status: "WAITING", stopReason: "CHECKPOINT_FAILED", frozenRunId: "RUN-009" });
  const res = transitionProfessionalRun(run, { type: "CHECKPOINT_RETRY" });
  assert.equal(res.ok, true);
  assert.equal(res.state.status, "RUNNING");
  assert.equal(res.state.stopReason, null);
  assert.equal(res.state.checkpointProtection, null);
  assert.equal(res.state.frozenRunId, "RUN-009");
});

test("PROCEED_UNPROTECTED는 무보호 진행 시 IMPLEMENTING으로 전이하고 enum을 남긴다", () => {
  const run = createProfessionalRun({ node: "IMPLEMENTING", status: "WAITING", stopReason: "CHECKPOINT_FAILED", frozenRunId: "RUN-010" });
  const res = transitionProfessionalRun(run, { type: "PROCEED_UNPROTECTED" });
  assert.equal(res.ok, true);
  assert.equal(res.state.node, "IMPLEMENTING");
  assert.equal(res.state.status, "RUNNING");
  assert.equal(res.state.checkpointProtection, "unavailable_user_approved");
  assert.equal(res.state.frozenRunId, "RUN-010");
});

test("CHECKPOINT_FAILED 상태의 public state는 needsInput과 checkpoint 정보를 노출한다", () => {
  const run = createProfessionalRun({ node: "IMPLEMENTING", status: "WAITING", stopReason: "CHECKPOINT_FAILED", checkpointProtection: "unavailable_checkpoint_failed", checkpointFailReason: "CHECKPOINT_COPY_FAILED", frozenRunId: "RUN-011" });
  const view = publicProfessionalState(run, { canRestore: true });
  assert.equal(view.needsInput, true);
  assert.equal(view.stopReason, "CHECKPOINT_FAILED");
  assert.equal(view.checkpointProtection, "unavailable_checkpoint_failed");
  assert.equal(view.checkpointFailReason, "CHECKPOINT_COPY_FAILED");
});

test("REPLAN_RESET은 checkpoint 보호·실패 사유를 리셋한다", () => {
  const run = createProfessionalRun({ node: "READY", status: "WAITING", checkpointProtection: "unavailable_user_approved", checkpointFailReason: "X" });
  const res = transitionProfessionalRun(run, { type: "REPLAN_RESET" });
  assert.equal(res.ok, true);
  assert.equal(res.state.checkpointProtection, null);
  assert.equal(res.state.checkpointFailReason, null);
});
