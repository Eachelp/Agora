"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseRecorderOutput } = require("../src/agora/recorder-output");
const {
  DETERMINISTIC_RECORDER_MODE,
  installDeterministicProfessionalRecorder,
} = require("../src/chat/chat-professional-recorder");

class FakeRoom {
  constructor({ deterministic = true } = {}) {
    this.calls = [];
    this.meta = deterministic
      ? { professionalRecorderMode: DETERMINISTIC_RECORDER_MODE }
      : {};
  }

  scheduleResponse(agent, context = {}) {
    this.calls.push({ agent, context });
    return Promise.resolve({ ok: true, text: "provider recorder" });
  }
}

installDeterministicProfessionalRecorder(FakeRoom);

test("명시적 policy의 professional recorder는 provider를 호출하지 않고 deterministic JSON을 반환한다", async () => {
  const room = new FakeRoom();
  const result = await room.scheduleResponse({ id: "claude" }, {
    specialist: {
      stage: "recorder",
      professional: true,
      round: 2,
      frozenTask: {
        runId: "RUN-007",
        taskId: "TASK-003",
        taskHash: "abc123",
      },
      finalVerdict: "PASS",
      reviewDiff: "diff --git a/src/a.js b/src/a.js\n+++ b/src/a.js\n",
      evidence: {
        transport: "COMPLETED",
        declaration: "DONE",
        changes: "CHANGED",
        execution: "OBSERVED",
        commandSummary: { total: 3, failed: 0, truncated: 0 },
        toolSummary: { started: 4, finished: 4, failed: 0, repeatedCalls: 1, maxRepeatCount: 2 },
        exploration: { status: "NORMAL", reason: null },
      },
    },
  });

  assert.equal(room.calls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.transport, "LOCAL_DETERMINISTIC");
  assert.equal(result.deterministicRecorder, true);
  const parsed = parseRecorderOutput(result.text);
  assert.match(parsed.summary, /RUN-007/);
  assert.match(parsed.summary, /TASK-003/);
  assert.match(parsed.summary, /src\/a\.js/);
  assert.deepEqual(parsed.decisions, []);
  assert.deepEqual(parsed.nextActions, []);
});

test("policy가 없으면 professional recorder도 기존 provider 경로를 유지한다", async () => {
  const room = new FakeRoom({ deterministic: false });
  const result = await room.scheduleResponse({ id: "claude" }, {
    specialist: { stage: "recorder", professional: true },
  });
  assert.equal(room.calls.length, 1);
  assert.equal(result.text, "provider recorder");
});

test("토론/수동 recorder는 deterministic policy에서도 기존 provider 경로를 유지한다", async () => {
  const room = new FakeRoom();
  const result = await room.scheduleResponse({ id: "claude" }, {
    specialist: { stage: "recorder", professional: false },
  });

  assert.equal(room.calls.length, 1);
  assert.equal(result.text, "provider recorder");
});

test("installer는 같은 class에 중복 wrapping하지 않는다", () => {
  assert.equal(installDeterministicProfessionalRecorder(FakeRoom), false);
});
