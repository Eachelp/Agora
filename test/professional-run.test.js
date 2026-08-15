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
});
