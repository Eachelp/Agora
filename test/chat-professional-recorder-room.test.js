"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ChatRoom } = require("../src/chat/chat-room");
const { parseRecorderOutput } = require("../src/agora/recorder-output");
const { DETERMINISTIC_RECORDER_MODE } = require("../src/chat/chat-professional-recorder");

function recorderAgent() {
  return {
    id: "claude",
    name: "Claude",
    aliases: ["claude"],
    available: true,
    enabled: true,
    model: "default",
    effort: "default",
  };
}

test("explicit policy의 실제 ChatRoom professional recorder는 runAgent를 호출하지 않는다", async () => {
  let providerCalls = 0;
  const agent = recorderAgent();
  const room = new ChatRoom({
    sessionId: "s-recorder",
    agents: [agent],
    meta: { professionalRecorderMode: DETERMINISTIC_RECORDER_MODE },
    runAgent() {
      providerCalls += 1;
      return {
        promise: Promise.resolve({ ok: true, text: "provider should not run" }),
        cancel: () => {},
      };
    },
  });

  const result = await room.scheduleResponse(agent, {
    specialist: {
      stage: "recorder",
      professional: true,
      round: 1,
      frozenTask: { runId: "RUN-101", taskId: "TASK-101", taskHash: "hash" },
      finalVerdict: "PASS",
      reviewDiff: "diff --git a/a.js b/a.js\n+++ b/a.js\n",
      evidence: {
        transport: "COMPLETED",
        declaration: "DONE",
        changes: "CHANGED",
        execution: "OBSERVED",
        commandSummary: { total: 1, failed: 0, truncated: 0 },
      },
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.transport, "LOCAL_DETERMINISTIC");
  assert.equal(result.deterministicRecorder, true);
  const parsed = parseRecorderOutput(result.text);
  assert.match(parsed.summary, /RUN-101/);
  assert.deepEqual(parsed.decisions, []);
  assert.deepEqual(parsed.nextActions, []);
});
