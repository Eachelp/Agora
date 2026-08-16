"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { createLineParser } = require("../src/chat/chat-events");

const NODE = process.execPath;

function runClaudeEvents(events) {
  const script = events
    .map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`)
    .join(";");
  return runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script],
    prompt: "professional telemetry test",
    cwd: os.tmpdir(),
    timeoutMs: 10000,
    requireFinal: true,
    parseLine: createLineParser("claude"),
  });
}

test("runner evidence에 반복 탐색 telemetry snapshot을 보존한다", async () => {
  const events = [];
  for (let index = 0; index < 4; index += 1) {
    events.push({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: `read-${index}`,
          name: "Read",
          input: { file_path: "src/chat/chat-room.js" },
        }],
      },
    });
    events.push({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: `read-${index}`,
          content: "abc",
        }],
      },
    });
  }
  events.push({ type: "result", subtype: "success", result: "완료" });

  const result = await runClaudeEvents(events).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  assert.ok(result.evidence);
  assert.equal(result.evidence.toolSummary.started, 4);
  assert.equal(result.evidence.toolSummary.finished, 4);
  assert.equal(result.evidence.toolSummary.outputBytes, 12);
  assert.equal(result.evidence.toolSummary.repeatedCalls, 3);
  assert.equal(result.evidence.toolSummary.maxRepeatCount, 4);
  assert.equal(result.evidence.exploration.status, "WARNING");
  assert.equal(result.evidence.exploration.reason, "repeated-target");
  assert.deepEqual(result.evidence.toolSummary.repeatedTargets[0], {
    tool: "Read",
    target: "src/chat/chat-room.js",
    count: 4,
  });
});

test("Claude Bash evidence와 전체 command summary를 함께 보존한다", async () => {
  const result = await runClaudeEvents([
    {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "bash-1",
          name: "Bash",
          input: { command: "npm test" },
        }],
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "bash-1",
          content: "525 passed",
          exit_code: 0,
        }],
      },
    },
    { type: "result", subtype: "success", result: "완료" },
  ]).promise;

  assert.equal(result.ok, true);
  assert.equal(result.evidence.commands.length, 1);
  assert.equal(result.evidence.commands[0].kind, "command-finished");
  assert.equal(result.evidence.commands[0].command, "npm test");
  assert.equal(result.evidence.commands[0].exitCode, 0);
  assert.deepEqual(result.evidence.commandSummary, {
    total: 1,
    failed: 0,
    truncated: 0,
  });
});
