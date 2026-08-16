const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { createLineParser } = require("../src/chat/chat-events");

const NODE = process.execPath;

test("runner는 모든 실행에 bounded runMetrics를 붙인다", async () => {
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", "process.stdout.write('완료')"],
    prompt: "abc",
    cwd: os.tmpdir(),
  });
  const result = await run.promise;

  assert.equal(result.ok, true);
  assert.equal(result.runMetrics.schemaVersion, 1);
  assert.equal(result.runMetrics.promptChars, 3);
  assert.ok(Number.isInteger(result.runMetrics.startedAt));
  assert.ok(Number.isInteger(result.runMetrics.finishedAt));
  assert.ok(result.runMetrics.durationMs >= 0);
  assert.ok(result.runMetrics.stdoutBytes > 0);
  assert.equal(result.runMetrics.stopReason, "COMPLETED");
});

test("runner는 종료 시 canonical run-metrics 이벤트를 정확히 한 번 보낸다", async () => {
  const events = [];
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", "process.stdout.write('완료')"],
    prompt: "metrics-event",
    cwd: os.tmpdir(),
    onEvent: (event) => events.push(event),
  });
  const result = await run.promise;

  const metricEvents = events.filter((event) => event.kind === "run-metrics");
  assert.equal(metricEvents.length, 1);
  assert.deepEqual(metricEvents[0].metrics, result.runMetrics);
  assert.equal(metricEvents[0].metrics.promptChars, "metrics-event".length);
  assert.equal(metricEvents[0].metrics.stopReason, "COMPLETED");
});

test("반복 탐색은 WARNING과 LOOP_DETECTED를 한 번씩 알리되 실행을 중단하지 않는다", async () => {
  const payloads = [];
  for (let i = 0; i < 8; i += 1) {
    payloads.push({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: `read-${i}`,
          name: "Read",
          input: { file_path: "src/large.js" },
        }],
      },
    });
    payloads.push({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: `read-${i}`,
          content: "x",
        }],
      },
    });
  }
  payloads.push({ type: "result", subtype: "success", result: "완료" });

  const script = `const items=${JSON.stringify(payloads)};for(const item of items) console.log(JSON.stringify(item));`;
  const events = [];
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script],
    prompt: "",
    cwd: os.tmpdir(),
    parseLine: createLineParser("claude"),
    onEvent: (event) => events.push(event),
  });
  const result = await run.promise;

  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  const warnings = events.filter((event) => event.kind === "status" && event.exploration?.status);
  assert.equal(warnings.filter((event) => event.exploration.status === "WARNING").length, 1);
  assert.equal(warnings.filter((event) => event.exploration.status === "LOOP_DETECTED").length, 1);
  assert.equal(result.runMetrics.exploration.status, "LOOP_DETECTED");
  assert.equal(result.runMetrics.exploration.reason, "repeated-target");
  assert.equal(result.runMetrics.tools.maxRepeatCount, 8);
});
