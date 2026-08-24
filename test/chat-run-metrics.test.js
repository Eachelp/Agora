const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRunMetrics, stopReasonFor } = require("../src/chat/chat-run-metrics");

test("RunMetrics는 실행 시간과 전체 command/tool 집계를 보존한다", () => {
  const metrics = buildRunMetrics({
    invocationId: "r1",
    provider: "claude",
    model: "model-x",
    effort: "medium",
    stage: "implementation",
    startedAt: 1000,
    finishedAt: 1750,
    promptChars: 12000,
    result: {
      ok: true,
      output: { stdoutBytes: 4096, captureTruncated: true },
      evidence: {
        commandSummary: { total: 13, failed: 2, truncated: 1 },
        toolSummary: {
          started: 20,
          finished: 19,
          failed: 3,
          truncated: 2,
          outputBytes: 900000,
          uniqueTargets: 6,
          repeatedCalls: 14,
          maxRepeatCount: 8,
          // 장기 metrics에는 target 원문이 들어가면 안 된다.
          repeatedTargets: [{ tool: "Read", target: "secret/file.txt", count: 8 }],
        },
        exploration: {
          status: "LOOP_DETECTED",
          reason: "repeated-target",
          reasons: ["same-target:8"],
        },
      },
    },
  });

  assert.equal(metrics.durationMs, 750);
  assert.equal(metrics.promptChars, 12000);
  assert.equal(metrics.stdoutBytes, 4096);
  assert.deepEqual(metrics.commands, { total: 13, failed: 2, truncated: 1 });
  assert.equal(metrics.tools.started, 20);
  assert.equal(metrics.tools.repeatedCalls, 14);
  assert.equal(metrics.tools.maxRepeatCount, 8);
  assert.deepEqual(metrics.exploration, { status: "LOOP_DETECTED", reason: "repeated-target" });
  assert.equal(JSON.stringify(metrics).includes("secret/file.txt"), false);
  assert.equal(metrics.stopReason, "COMPLETED");
});

test("RunMetrics 실패 사유는 안정된 taxonomy로 정규화한다", () => {
  assert.equal(stopReasonFor({ ok: false, stopReason: "PROTOCOL_FINAL_MISSING" }), "PROTOCOL_FINAL_MISSING");
  assert.equal(stopReasonFor({ ok: false, timedOut: true }), "TIMED_OUT");
  assert.equal(stopReasonFor({ ok: false, outputLimited: true }), "OUTPUT_LIMITED");
  assert.equal(stopReasonFor({ ok: false, approvalRequired: true }), "APPROVAL_REQUIRED");
  assert.equal(stopReasonFor({ ok: false }), "FAILED");
});

test("잘못된 숫자와 exploration 값은 안전한 기본값으로 정규화한다", () => {
  const metrics = buildRunMetrics({
    startedAt: 500,
    finishedAt: 400,
    promptChars: -1,
    result: {
      ok: false,
      evidence: {
        commandSummary: { total: -3 },
        toolSummary: { outputBytes: -9 },
        exploration: { status: "UNKNOWN", reason: "x".repeat(200) },
      },
    },
  });

  assert.equal(metrics.durationMs, 0);
  assert.equal(metrics.promptChars, 0);
  assert.equal(metrics.commands.total, 0);
  assert.equal(metrics.tools.outputBytes, 0);
  assert.equal(metrics.exploration.status, "NORMAL");
  assert.equal(metrics.exploration.reason.length, 80);
});
