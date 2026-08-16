"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager } = require("../src/agora/task-manager");

test("Run evidence에 tool summary와 exploration 판정을 보존한다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-evidence-"));
  const runDir = path.join(root, "RUN-001");
  fs.mkdirSync(runDir, { recursive: true });
  const manager = new TaskManager({ now: () => 1234 });
  const runInfo = { runId: "RUN-001", runDir };

  const ok = manager.writeRunEvidence(runInfo, {
    round: 2,
    invocationId: "r1",
    provider: "claude",
    source: { kind: "provider-event", provider: "claude" },
    transport: "COMPLETED",
    declaration: "DONE",
    changes: "CHANGED",
    execution: "OBSERVED",
    commands: [],
    commandSummary: { total: 0, included: 0, failed: 0, truncated: 0 },
    toolSummary: {
      started: 8,
      finished: 8,
      failed: 0,
      truncated: 0,
      outputBytes: 4096,
      uniqueTargets: 1,
      repeatedCalls: 7,
      maxRepeatCount: 8,
      repeatedTargets: [{ tool: "Read", target: "src/a.js", count: 8 }],
      byTool: [{ tool: "Read", count: 8 }],
    },
    exploration: {
      status: "LOOP_DETECTED",
      reason: "repeated-target",
      reasons: ["same-target:8"],
      maxRepeatCount: 8,
      repeatedCalls: 7,
      outputBytes: 4096,
      failed: 0,
      finished: 8,
      failureRate: 0,
    },
  });

  assert.equal(ok, true);
  const evidence = manager.readRunEvidence(runInfo);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.toolSummary.maxRepeatCount, 8);
  assert.equal(evidence.toolSummary.repeatedTargets[0].target, "src/a.js");
  assert.equal(evidence.exploration.status, "LOOP_DETECTED");
  assert.equal(evidence.exploration.reason, "repeated-target");
  assert.deepEqual(evidence.exploration.reasons, ["same-target:8"]);

  fs.rmSync(root, { recursive: true, force: true });
});

test("telemetry evidence는 target/reason 배열을 bounded 형태로 저장한다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-evidence-bounded-"));
  const runDir = path.join(root, "RUN-001");
  fs.mkdirSync(runDir, { recursive: true });
  const manager = new TaskManager();
  const runInfo = { runId: "RUN-001", runDir };

  const repeatedTargets = Array.from({ length: 30 }, (_, index) => ({
    tool: "Read",
    target: `file-${index}.js`,
    count: index + 2,
  }));
  const reasons = Array.from({ length: 20 }, (_, index) => `reason-${index}`);

  assert.equal(manager.writeRunEvidence(runInfo, {
    toolSummary: { repeatedTargets, byTool: [], started: 30 },
    exploration: { status: "WARNING", reason: "repeated-target", reasons },
  }), true);

  const evidence = manager.readRunEvidence(runInfo);
  assert.equal(evidence.toolSummary.repeatedTargets.length, 10);
  assert.equal(evidence.exploration.reasons.length, 8);

  fs.rmSync(root, { recursive: true, force: true });
});
