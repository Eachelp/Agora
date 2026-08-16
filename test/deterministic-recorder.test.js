const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDeterministicRecorderOutput,
  serializeDeterministicRecorderOutput,
  changedFilesFromDiff,
} = require("../src/agora/deterministic-recorder");
const { parseRecorderOutput } = require("../src/agora/recorder-output");

test("deterministic recorder는 구조화 evidence에서 실행 사실만 기록한다", () => {
  const output = buildDeterministicRecorderOutput({
    runId: "RUN-007",
    taskId: "TASK-003",
    taskHash: "abc123",
    finalVerdict: "PASS",
    round: 2,
    reviewDiff: [
      "diff --git a/src/a.js b/src/a.js",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "diff --git a/test/a.test.js b/test/a.test.js",
      "--- a/test/a.test.js",
      "+++ b/test/a.test.js",
    ].join("\n"),
    evidence: {
      transport: "COMPLETED",
      declaration: "DONE",
      changes: "CHANGED",
      execution: "OBSERVED",
      commandSummary: { total: 14, failed: 1, truncated: 2 },
      toolSummary: {
        started: 20,
        finished: 20,
        failed: 2,
        truncated: 1,
        outputBytes: 12345,
        uniqueTargets: 8,
        repeatedCalls: 12,
        maxRepeatCount: 8,
      },
      exploration: { status: "LOOP_DETECTED", reason: "repeated-target" },
    },
  });

  assert.equal(output.decisions.length, 0);
  assert.equal(output.nextActions.length, 0);
  assert.equal(output.provenance.kind, "deterministic-professional-recorder");
  assert.equal(output.provenance.facts.commands.total, 14);
  assert.equal(output.provenance.facts.tools.maxRepeatCount, 8);
  assert.equal(output.provenance.facts.exploration.status, "LOOP_DETECTED");
  assert.deepEqual(output.provenance.changedFiles, ["src/a.js", "test/a.test.js"]);
  assert.match(output.summary, /최종 판정: PASS/);
  assert.match(output.summary, /명령 실행: 14회 · 실패 1회/);
  assert.match(output.summary, /탐색 상태: LOOP_DETECTED \(repeated-target\)/);
  assert.match(output.summary, /src\/a\.js/);
});

test("serialize 결과는 기존 parseRecorderOutput 계약과 호환된다", () => {
  const text = serializeDeterministicRecorderOutput({
    runId: "RUN-001",
    finalVerdict: "PASS",
    evidence: {
      commandSummary: { total: 1, failed: 0, truncated: 0 },
      exploration: { status: "NORMAL" },
    },
  });
  const parsed = parseRecorderOutput(text);

  assert.match(parsed.summary, /RUN-001/);
  assert.equal(parsed.decisions.length, 0);
  assert.equal(parsed.nextActions.length, 0);
});

test("changed file 목록은 중복을 제거하고 bounded 한다", () => {
  const parts = [];
  for (let i = 0; i < 80; i += 1) {
    parts.push(`diff --git a/src/f${i}.js b/src/f${i}.js`);
    parts.push(`+++ b/src/f${i}.js`);
  }
  const files = changedFilesFromDiff(parts.join("\n"));

  assert.equal(files.length, 50);
  assert.equal(files[0], "src/f0.js");
  assert.equal(files[49], "src/f49.js");
});

test("원문 diff와 tool target은 summary에 그대로 복제하지 않는다", () => {
  const secretLikeTarget = "C:/very/private/path/secret.txt";
  const output = buildDeterministicRecorderOutput({
    reviewDiff: "@@ -1 +1 @@\n-secret-value\n+new-value",
    evidence: {
      toolSummary: {
        started: 1,
        finished: 1,
        repeatedTargets: [{ tool: "Read", target: secretLikeTarget, count: 4 }],
      },
      exploration: { status: "WARNING", reason: "repeated-target" },
    },
  });

  assert.doesNotMatch(output.summary, /secret-value/);
  assert.doesNotMatch(output.summary, /very\/private/);
  assert.match(output.summary, /탐색 상태: WARNING/);
});
