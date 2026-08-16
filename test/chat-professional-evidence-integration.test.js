"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ChatRoom } = require("../src/chat/chat-room");
const { safeBlockReason } = require("../src/chat/chat-specialist");

test("ChatRoom evidencePayload가 telemetry와 전체 command summary를 저장 경계까지 전달한다", () => {
  let persisted = null;
  const room = Object.create(ChatRoom.prototype);
  room.taskManager = {
    writeRunEvidence(runInfo, payload) {
      persisted = { runInfo, payload };
      return true;
    },
  };

  const result = room.evidencePayload({
    runInfo: { runId: "RUN-001", runDir: "unused" },
    builderResult: {
      runId: "r-builder",
      transport: "COMPLETED",
      builderStatus: "DONE",
      evidence: {
        commands: [{ kind: "command-finished", command: "npm test", exitCode: 0 }],
        commandSummary: { total: 42, failed: 3, truncated: 2 },
        toolSummary: {
          started: 9,
          finished: 9,
          outputBytes: 12345,
          repeatedCalls: 8,
          maxRepeatCount: 9,
        },
        exploration: {
          status: "LOOP_DETECTED",
          reason: "repeated-target",
          reasons: ["same-target:9"],
        },
      },
    },
    diff: { status: "CHANGED" },
    round: 1,
    provider: "claude",
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.commandSummary.total, 42);
  assert.equal(result.payload.commandSummary.omitted, 41);
  assert.equal(result.payload.toolSummary.maxRepeatCount, 9);
  assert.equal(result.payload.exploration.status, "LOOP_DETECTED");
  assert.equal(persisted.payload.exploration.reason, "repeated-target");
});

test("PROTOCOL_FINAL_MISSING은 specialist 안전 사유로 그대로 보존된다", () => {
  assert.equal(safeBlockReason("PROTOCOL_FINAL_MISSING"), "PROTOCOL_FINAL_MISSING");
});
