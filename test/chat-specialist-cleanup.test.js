const test = require("node:test");
const assert = require("node:assert/strict");

const { ChatRoom } = require("../src/chat/chat-room");
const {
  SAFE_BLOCK_REASONS,
  safeBlockReason,
} = require("../src/chat/chat-specialist");
const {
  executionAxes,
  buildProfessionalEvidencePayload,
} = require("../src/chat/chat-professional-evidence");

test("PROTOCOL_FINAL_MISSING is a canonical specialist safe block reason", () => {
  assert.equal(SAFE_BLOCK_REASONS.has("PROTOCOL_FINAL_MISSING"), true);
  assert.equal(safeBlockReason("PROTOCOL_FINAL_MISSING"), "PROTOCOL_FINAL_MISSING");
});

test("ChatRoom specialist evidence delegates to the provider-neutral evidence contract", () => {
  const writes = [];
  const room = new ChatRoom({
    agents: [],
    runAgent: () => ({ promise: Promise.resolve({ ok: true, text: "" }), cancel() {} }),
    taskManager: {
      writeRunEvidence(runInfo, payload) {
        writes.push({ runInfo, payload });
        return true;
      },
      resolveTaskContract() {
        return null;
      },
    },
  });

  const options = {
    runInfo: { runId: "RUN-cleanup" },
    provider: "codex",
    round: 2,
    diff: { status: "CHANGED" },
    builderResult: {
      runId: "r-cleanup",
      transport: "COMPLETED",
      builderStatus: "DONE",
      evidencePersisted: true,
      evidence: {
        commands: [],
        commandSummary: { total: 3, failed: 1, truncated: 0 },
        toolSummary: {
          started: 4,
          finished: 4,
          failed: 0,
          truncated: 0,
          outputBytes: 128,
          uniqueTargets: 2,
          repeatedCalls: 1,
          maxRepeatCount: 2,
        },
        exploration: { status: "WARNING", reason: "repeated-target" },
      },
    },
  };

  assert.deepEqual(room.executionAxes(options), executionAxes(options));

  const result = room.evidencePayload(options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, buildProfessionalEvidencePayload(options));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].runInfo, options.runInfo);
  assert.deepEqual(writes[0].payload, result.payload);
});
