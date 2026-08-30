const test = require("node:test");
const assert = require("node:assert");
const { ChatRoom } = require("../src/chat/chat-room");

function makeAgent(id, name) {
  return { id, name: name || id, provider: "fake", model: "fake" };
}

function makeRoom(systems) {
  const agents = [makeAgent("a"), makeAgent("b")];
  const room = new ChatRoom({
    agents,
    runAgent: () => ({ promise: Promise.resolve({ ok: true, text: "ok" }), cancel: () => {} }),
  });
  room.on("message", (msg) => {
    if (msg && msg.authorType === "system") systems.push(msg.text);
  });
  return room;
}

test("stopping the room notifies about dropped general turns", async () => {
  const systems = [];
  const room = makeRoom(systems);
  const gate = Promise.withResolvers();
  room.runAgent = () => ({ promise: gate.promise, cancel: () => {} });
  room.scheduleResponse(room.agents[1]);
  room.scheduleResponse(room.agents[0]);
  room.stopAllSilently();
  gate.resolve();
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(systems.some((text) => text.includes("다시 보내")), JSON.stringify(systems));
});

test("discussion context turns are dropped without loss notices", async () => {
  const systems = [];
  const room = makeRoom(systems);
  room.scheduleResponse(room.agents[0], { discussion: true });
  room.stopAllSilently();
  await room.waitForIdle();
  assert.deepStrictEqual(systems, []);
});

test("generation mismatch in the pump notifies about the lost turn", async () => {
  const systems = [];
  const room = makeRoom(systems);
  const item = {
    turnId: "tX",
    agent: room.agents[0],
    context: {},
    generation: room.generation + 1,
    dedupeKey: null,
    promise: Promise.resolve(),
    resolve: () => {},
    promptLimit: 0,
  };
  room.turnQueue.push(item);
  await room.pumpTurnQueue();
  assert.ok(systems.some((text) => text.includes("다시 보내")), JSON.stringify(systems));
});

test("stall watchdog fires only while the turn is still queued", () => {
  const systems = [];
  const room = makeRoom(systems);
  const item = {
    turnId: "tY",
    agent: room.agents[0],
    context: {},
    generation: room.generation,
    dedupeKey: null,
    promise: Promise.resolve(),
    resolve: () => {},
    promptLimit: 0,
  };
  room.turnQueue.push(item);
  room.turnStartedAt.set("tY", Date.now() - 121 * 1000);
  room.checkTurnStall("tY");
  assert.ok(systems.some((text) => text.includes("다시 보내")), JSON.stringify(systems));
  room.checkTurnStall("tY");
  assert.strictEqual(systems.length, 1);
});
