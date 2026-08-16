"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  executionAxes,
  buildProfessionalEvidencePayload,
} = require("../src/chat/chat-professional-evidence");

test("runner의 전체 command summary와 탐색 telemetry를 Reviewer payload에 보존한다", () => {
  const builderResult = {
    runId: "r1",
    transport: "COMPLETED",
    builderStatus: "DONE",
    evidence: {
      commands: [
        { kind: "command-finished", command: "npm test", exitCode: 0 },
        { kind: "command-finished", command: "npm lint", exitCode: 1 },
      ],
      commandSummary: { total: 37, failed: 4, truncated: 3 },
      toolSummary: {
        started: 8,
        finished: 8,
        failed: 0,
        outputBytes: 9000,
        uniqueTargets: 2,
        repeatedCalls: 6,
        maxRepeatCount: 7,
        repeatedTargets: [{ tool: "Read", target: "src/chat/chat-room.js", count: 7 }],
      },
      exploration: {
        status: "WARNING",
        reason: "repeated-target",
        reasons: ["same-target:7"],
        maxRepeatCount: 7,
        repeatedCalls: 6,
        outputBytes: 9000,
        failed: 0,
        finished: 8,
        failureRate: 0,
      },
    },
  };

  const payload = buildProfessionalEvidencePayload({
    builderResult,
    diff: { status: "CHANGED" },
    round: 2,
    provider: "claude",
  });

  assert.equal(payload.execution, "OBSERVED");
  assert.deepEqual(payload.commandSummary, {
    total: 37,
    included: 2,
    omitted: 35,
    failed: 4,
    truncated: 3,
  });
  assert.equal(payload.toolSummary.maxRepeatCount, 7);
  assert.equal(payload.exploration.status, "WARNING");
  assert.equal(payload.exploration.reason, "repeated-target");
});

test("최근 command 배열이 비어도 전체 command summary가 있으면 execution은 OBSERVED", () => {
  const axes = executionAxes({
    builderResult: {
      transport: "COMPLETED",
      builderStatus: "DONE",
      evidence: { commands: [], commandSummary: { total: 23, failed: 0, truncated: 0 } },
    },
    diff: { status: "NO_CHANGES" },
  });
  assert.equal(axes.execution, "OBSERVED");
});

test("탐색 telemetry만 있고 명령 실행이 없으면 execution 축은 별도로 UNAVAILABLE 유지", () => {
  const payload = buildProfessionalEvidencePayload({
    builderResult: {
      transport: "COMPLETED",
      builderStatus: "DONE",
      evidence: {
        commands: [],
        commandSummary: { total: 0, failed: 0, truncated: 0 },
        toolSummary: { started: 8, finished: 8, repeatedCalls: 7, maxRepeatCount: 8 },
        exploration: { status: "LOOP_DETECTED", reason: "repeated-target" },
      },
    },
    diff: { status: "CHANGED" },
  });
  assert.equal(payload.execution, "UNAVAILABLE");
  assert.equal(payload.exploration.status, "LOOP_DETECTED");
});
