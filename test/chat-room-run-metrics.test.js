const test = require("node:test");
const assert = require("node:assert/strict");

const { ChatRoom } = require("../src/chat/chat-room");

function agent(overrides = {}) {
  return {
    id: "claude",
    name: "Claude",
    aliases: ["claude"],
    available: true,
    enabled: true,
    model: "claude-default",
    effort: "high",
    ...overrides,
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("일반 실행의 run-metrics 이벤트에 run/provider model provenance를 붙인다", async () => {
  const events = [];
  const room = new ChatRoom({
    sessionId: "s-metrics",
    agents: [agent()],
    runAgent: ({ emitEvent }) => {
      emitEvent({
        kind: "run-metrics",
        metrics: {
          schemaVersion: 1,
          durationMs: 123,
          promptChars: 456,
          stopReason: "COMPLETED",
        },
      });
      return {
        promise: Promise.resolve({ ok: true, text: "완료" }),
        cancel: () => {},
      };
    },
  });
  room.on("run-event", (event) => events.push(event));

  room.sendUserMessage("@claude 확인해줘");
  await settle(room);

  const metric = events.find((event) => event.kind === "run-metrics");
  assert.ok(metric);
  assert.equal(metric.runId, "rs-metrics-1");
  assert.equal(metric.agentId, "claude");
  assert.equal(metric.model, "claude-default");
  assert.equal(metric.effort, "high");
  assert.equal(metric.specialistStage, undefined);
  assert.equal(metric.metrics.durationMs, 123);
  assert.equal(metric.metrics.promptChars, 456);
});
