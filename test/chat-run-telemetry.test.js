"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRunTelemetry,
  detectExplorationLoop,
} = require("../src/chat/chat-run-telemetry");

test("tool target 반복 호출과 출력 byte를 집계한다", () => {
  const telemetry = createRunTelemetry();
  telemetry.observe({ kind: "tool-started", tool: "Read", target: "src/a.js" });
  telemetry.observe({ kind: "tool-finished", tool: "Read", outputBytes: 500000, executionStatus: "OBSERVED" });
  telemetry.observe({ kind: "tool-started", tool: "Read", target: "src/a.js" });
  telemetry.observe({ kind: "tool-finished", tool: "Read", outputBytes: 500000, executionStatus: "OBSERVED" });
  telemetry.observe({ kind: "tool-started", tool: "Grep", target: "foo" });
  telemetry.observe({ kind: "tool-finished", tool: "Grep", outputBytes: 100, executionStatus: "FAILED" });

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.toolSummary.started, 3);
  assert.equal(snapshot.toolSummary.finished, 3);
  assert.equal(snapshot.toolSummary.failed, 1);
  assert.equal(snapshot.toolSummary.outputBytes, 1000100);
  assert.equal(snapshot.toolSummary.uniqueTargets, 2);
  assert.equal(snapshot.toolSummary.repeatedCalls, 1);
  assert.equal(snapshot.toolSummary.maxRepeatCount, 2);
  assert.deepEqual(snapshot.toolSummary.repeatedTargets[0], {
    tool: "Read",
    target: "src/a.js",
    count: 2,
  });
  assert.equal(snapshot.exploration.status, "NORMAL");
});

test("command 전체 성공/실패/잘림 횟수를 별도 집계한다", () => {
  const telemetry = createRunTelemetry();
  telemetry.observe({ kind: "command-finished", command: "npm test", exitCode: 0, truncated: false });
  telemetry.observe({ kind: "command-finished", command: "npm run lint", exitCode: 1, truncated: true });
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.commands, { total: 2, failed: 1, truncated: 1 });
});

test("최근 도구 이벤트는 제한하지만 aggregate는 전체를 유지한다", () => {
  const telemetry = createRunTelemetry({ recentToolLimit: 2 });
  for (let i = 0; i < 5; i += 1) {
    telemetry.observe({ kind: "tool-started", tool: "Read", target: `file-${i}.js` });
  }
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.tools.length, 2);
  assert.equal(snapshot.toolSummary.started, 5);
  assert.equal(snapshot.toolSummary.uniqueTargets, 5);
});

test("같은 파일 4회 반복은 WARNING으로 탐지한다", () => {
  const telemetry = createRunTelemetry();
  for (let i = 0; i < 4; i += 1) {
    telemetry.observe({ kind: "tool-started", tool: "Read", target: "large.js" });
    telemetry.observe({ kind: "tool-finished", tool: "Read", outputBytes: 1000, executionStatus: "OBSERVED" });
  }
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.exploration.status, "WARNING");
  assert.ok(snapshot.exploration.reasons.includes("same-target:4"));
});

test("같은 파일 8회 반복은 LOOP_DETECTED로 탐지한다", () => {
  const telemetry = createRunTelemetry();
  for (let i = 0; i < 8; i += 1) {
    telemetry.observe({ kind: "tool-started", tool: "Read", target: "large.js" });
    telemetry.observe({ kind: "tool-finished", tool: "Read", outputBytes: 500000, executionStatus: "OBSERVED" });
  }
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.exploration.status, "LOOP_DETECTED");
  assert.ok(snapshot.exploration.reasons.includes("same-target:8"));
});

test("실패가 반복 탐색과 결합되면 failure-loop로 승격한다", () => {
  const snapshot = {
    toolSummary: {
      maxRepeatCount: 4,
      repeatedCalls: 3,
      outputBytes: 1000,
      failed: 3,
      finished: 4,
    },
  };
  const result = detectExplorationLoop(snapshot);
  assert.equal(result.status, "LOOP_DETECTED");
  assert.ok(result.reasons.includes("failure-loop:3/4"));
});
