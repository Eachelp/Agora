const test = require("node:test");
const assert = require("node:assert/strict");

const { PetWatcherGate } = require("../src/agora/pet-watcher-gate");

function makeGate() {
  const calls = [];
  const gate = new PetWatcherGate({
    start: [() => calls.push("codex:start"), () => calls.push("agy:start"), () => calls.push("claude:start")],
    stop: [() => calls.push("codex:stop"), () => calls.push("agy:stop"), () => calls.push("claude:stop")],
  });
  return { gate, calls };
}

test("펫이 켜져 있지 않으면 watcher start가 호출되지 않는다", () => {
  const { gate, calls } = makeGate();
  gate.setPetEnabled(false);
  assert.deepEqual(calls, []);
  assert.equal(gate.running, false);
});

test("펫을 켜면 모든 watcher가 시작된다", () => {
  const { gate, calls } = makeGate();
  gate.setPetEnabled(true);
  assert.deepEqual(calls, ["codex:start", "agy:start", "claude:start"]);
  assert.equal(gate.running, true);
});

test("이미 시작된 상태에서 다시 켜도 중복 start가 없다", () => {
  const { gate, calls } = makeGate();
  gate.setPetEnabled(true);
  gate.setPetEnabled(true);
  gate.start();
  assert.deepEqual(calls, ["codex:start", "agy:start", "claude:start"]);
});

test("펫을 끄면 모든 watcher가 멈춘다", () => {
  const { gate, calls } = makeGate();
  gate.setPetEnabled(true);
  gate.setPetEnabled(false);
  assert.deepEqual(calls, [
    "codex:start", "agy:start", "claude:start",
    "codex:stop", "agy:stop", "claude:stop",
  ]);
  assert.equal(gate.running, false);
});

test("이미 멈춘 상태에서 다시 꺼도 중복 stop이 없다", () => {
  const { gate, calls } = makeGate();
  gate.setPetEnabled(false);
  gate.setPetEnabled(false);
  gate.stop();
  assert.deepEqual(calls, []);
});

test("main.js는 펫이 켜질 때만 watcher를 시작한다", () => {
  const fs = require("node:fs");
  const main = fs.readFileSync("src/main.js", "utf8");
  assert.match(main, /if \(petEnabled\) petWatcherGate\.start\(\);/);
  assert.doesNotMatch(main, /codexWatcher\.start\(\);\s*$/m);
  assert.match(main, /new PetWatcherGate\(/);
});