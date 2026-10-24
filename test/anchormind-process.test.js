"use strict";

// AnchorMind 켜기·끄기(src/agora/anchormind-process.js). 진짜 켜기·끄기 명령·서버·Gemini는 쓰지 않는다.
// 셸 실행(spawn·spawnSync), /health, 시계를 모두 가짜로 넣어 세 OS(CI Node 22)에서 같은 결과가 나온다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAnchorMindProcess } = require("../src/agora/anchormind-process");
const { waitFor, fakeClock } = require("./question-helpers.cjs");

const IDLE_MS = 30 * 60 * 1000;
const SHELL = { shell: true, windowsHide: true, stdio: "ignore" };
const SETTINGS = { folder: "anchormind-folder", startCommand: "my-start", stopCommand: "my-stop" };

// 가짜 셸 자식. pid가 없어야 killTree가 진짜 taskkill을 부르지 않고 child.kill()만 부른다.
function fakeChild(log) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    log.push("kill");
  };
  child.exit = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return child;
}

// log에 실행 순서(spawn·kill·sync·consolidate)가 남는다. health.up은 true · null(200이 아닌 답이나 시간 초과) · false(거부)이고,
// idle.hold에 약속을 넣으면 밀린 정리가 그 약속이 끝날 때까지 끝나지 않는다.
function setup(over = {}) {
  const clock = fakeClock();
  const log = [];
  const spawns = [];
  const syncs = [];
  const states = [];
  const health = { up: false, calls: 0 };
  const idle = { hold: null };
  const proc = createAnchorMindProcess({
    healthy: async () => {
      health.calls += 1;
      return health.up;
    },
    beforeIdleStop: async () => {
      log.push("consolidate");
      await idle.hold;
    },
    onState: (state) => states.push(state),
    spawn: (command, options) => {
      const child = fakeChild(log);
      spawns.push({ command, options, child });
      log.push(`spawn ${command}`);
      return child;
    },
    spawnSync: (command, options) => {
      syncs.push({ command, options });
      log.push(`sync ${command}`);
      return { status: 0 };
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
  // 켜기 대기를 1초 앞으로 돌리고, 그 사이 /health 확인이 한 번 끝날 때까지 기다린다.
  async function poll() {
    const before = health.calls;
    clock.advance(1000);
    await waitFor(() => health.calls > before, 3000, "/health 확인");
  }
  const spawned = (count = 1) => waitFor(() => spawns.length >= count, 3000, "셸 명령");
  return { proc, clock, log, spawns, syncs, states, health, idle, poll, spawned };
}

// 켜기를 끝까지 보낸다: 켜기 명령이 돌면 /health가 두 번 잇달아 응답한다.
async function started(s) {
  const result = s.proc.ensureStarted(SETTINGS);
  await s.spawned();
  s.health.up = true;
  await s.poll();
  await s.poll();
  assert.equal(await result, true);
}

// 이 규칙이 깨지면 켜기가 실제로 시작돼 가짜 시계가 가지 않으므로 기다림이 끝나지 않는다. 시간 제한으로 그 자리에서 실패하게 한다.
test("이미 켜진 서버, 200이 아닌 답을 하는 서버, 명령이 모자란 꺼진 서버는 켜지도 끄지도 않는다", { timeout: 5000 }, async () => {
  const up = setup();
  up.health.up = true;
  assert.equal(await up.proc.ensureStarted(SETTINGS), true);
  up.proc.touch();
  up.clock.advance(IDLE_MS);
  up.proc.stopOnQuitSync();
  assert.deepEqual(up.log, []);
  assert.deepEqual(up.states, []);

  const missing = setup();
  assert.equal(await missing.proc.ensureStarted({ ...SETTINGS, startCommand: "", stopCommand: "" }), false);
  assert.equal(await missing.proc.ensureStarted({ ...SETTINGS, stopCommand: "" }), false);
  assert.equal(await missing.proc.ensureStarted({ ...SETTINGS, startCommand: "" }), false);
  assert.deepEqual(missing.log, []);
  assert.deepEqual(missing.states, ["off", "off", "off"]);

  const other = setup();
  other.health.up = null;
  assert.equal(await other.proc.ensureStarted(SETTINGS), false);
  other.proc.stopOnQuitSync();
  assert.deepEqual(other.log, []);
  assert.deepEqual(other.states, ["error"]);
});

test("꺼져 있으면 켜기 명령을 폴더에서 숨긴 셸로 한 번만 돌리고, /health가 두 번 잇달아 응답해야 준비로 본다", async () => {
  const s = setup();
  const first = s.proc.ensureStarted(SETTINGS);
  assert.equal(s.proc.ensureStarted(SETTINGS), first);
  await s.spawned();
  assert.equal(s.spawns[0].command, "my-start");
  assert.deepEqual(s.spawns[0].options, { cwd: SETTINGS.folder, ...SHELL });
  let settled = false;
  first.then(() => {
    settled = true;
  });
  s.health.up = true;
  await s.poll();
  assert.equal(settled, false);
  await s.poll();
  assert.equal(await first, true);
  assert.equal(s.spawns.length, 1);
  assert.deepEqual(s.states, ["starting"]);
});

test("켜기가 실패하면 오류로 끝낸다: 한 번 응답하고 죽은 서버, 0이 아닌 종료, 실행조차 못 함. 0으로 끝나면 계속 본다", async () => {
  const dead = setup();
  const deadResult = dead.proc.ensureStarted(SETTINGS);
  await dead.spawned();
  dead.health.up = true;
  await dead.poll();
  dead.health.up = false;
  dead.clock.advance(3 * 60 * 1000);
  assert.equal(await deadResult, false);
  assert.equal(dead.spawns[0].child.killed, true);
  assert.deepEqual(dead.states, ["starting", "error"]);

  const exit0 = setup();
  const exit0Result = exit0.proc.ensureStarted(SETTINGS);
  await exit0.spawned();
  exit0.spawns[0].child.exit(0);
  exit0.health.up = null;
  await exit0.poll();
  exit0.health.up = true;
  await exit0.poll();
  await exit0.poll();
  assert.equal(await exit0Result, true);

  const exit1 = setup();
  const exit1Result = exit1.proc.ensureStarted(SETTINGS);
  await exit1.spawned();
  exit1.spawns[0].child.exit(1);
  await exit1.poll();
  assert.equal(await exit1Result, false);
  assert.deepEqual(exit1.states, ["starting", "error"]);
  // 켜기에 실패하면 Agora는 그 서버를 잊는다: 이어서 사용자가 직접 켠 서버는 유휴로도 앱 종료로도 끄지 않는다.
  exit1.health.up = true;
  assert.equal(await exit1.proc.ensureStarted(SETTINGS), true);
  exit1.clock.advance(IDLE_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exit1.log, ["spawn my-start"]);
  exit1.proc.stopOnQuitSync();
  assert.deepEqual(exit1.syncs, []);

  const broken = setup({
    spawn: () => {
      throw new Error("spawn EINVAL");
    },
  });
  assert.equal(await broken.proc.ensureStarted(SETTINGS), false);
  assert.deepEqual(broken.states, ["error"]);
  broken.proc.stopOnQuitSync();
  assert.deepEqual(broken.syncs, []);
});

test("30분 동안 쓰지 않으면 밀린 정리를 부른 뒤 Agora가 켠 서버를 끄고, 정리하는 동안 다시 쓰면 그만둔다", async () => {
  const s = setup();
  await started(s);
  let release;
  s.idle.hold = new Promise((resolve) => {
    release = resolve;
  });
  s.clock.advance(IDLE_MS);
  await waitFor(() => s.log.includes("consolidate"), 3000, "정리");
  assert.deepEqual(s.log, ["spawn my-start", "consolidate"]);
  s.proc.touch();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.spawns.length, 1);

  s.clock.advance(IDLE_MS);
  await s.spawned(2);
  assert.equal(s.spawns[1].command, "my-stop");
  assert.deepEqual(s.spawns[1].options, { cwd: SETTINGS.folder, ...SHELL, timeout: 15000 });
  s.spawns[1].child.exit(0);
  await waitFor(() => s.states.at(-1) === "off", 3000, "off 상태");
  s.proc.stopOnQuitSync();
  assert.deepEqual(s.syncs, []);
});

test("끄는 중에 켜 달라고 하면 끄기가 끝난 뒤에 켜고, 다시 켜는 동안에는 전에 걸린 유휴 타이머가 끄지 않는다", async () => {
  const stopping = setup();
  await started(stopping);
  stopping.clock.advance(IDLE_MS);
  await stopping.spawned(2);
  void stopping.proc.ensureStarted(SETTINGS);
  stopping.health.up = false;
  stopping.spawns[1].child.exit(0);
  await stopping.spawned(3);
  assert.deepEqual(stopping.spawns.map((entry) => entry.command), ["my-start", "my-stop", "my-start"]);
  assert.deepEqual(stopping.states, ["starting", "off", "starting"]);

  const restarted = setup();
  await started(restarted);
  restarted.health.up = false;
  restarted.clock.advance(IDLE_MS - 60 * 1000);
  void restarted.proc.ensureStarted(SETTINGS);
  await restarted.spawned(2);
  restarted.clock.advance(60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.spawns.length, 2);
  assert.equal(restarted.log.includes("consolidate"), false);

  // 이미 켜져 있는 서버를 확인하는 것도 쓴 것으로 센다: 유휴 시계가 그 시각부터 다시 간다.
  const checked = setup();
  await started(checked);
  checked.clock.advance(IDLE_MS - 60 * 1000);
  assert.equal(await checked.proc.ensureStarted(SETTINGS), true);
  checked.clock.advance(60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checked.spawns.length, 1);
  assert.equal(checked.log.includes("consolidate"), false);
});

test("설정이 다른 폴더를 가리키면 전에 켠 서버를 먼저 끄고(정리 중이던 유휴 끄기는 또 끄지 않고) 새 폴더의 서버를 켠다: 소유 표지를 덮어 옛 서버가 남지 않는다", async () => {
  const s = setup();
  await started(s);
  s.health.up = false;   // 바뀐 폴더의 서버는 꺼져 있다
  void s.proc.ensureStarted({ ...SETTINGS, folder: "other-folder" });
  await s.spawned(2);
  assert.deepEqual(s.log, ["spawn my-start", "spawn my-stop"]);
  assert.deepEqual(s.spawns[1].options, { cwd: SETTINGS.folder, ...SHELL, timeout: 15000 });
  s.spawns[1].child.exit(0);
  await s.spawned(3);
  assert.deepEqual(s.spawns[2].options, { cwd: "other-folder", ...SHELL });
  assert.deepEqual(s.states, ["starting", "off", "starting"]);
  s.proc.stopOnQuitSync();
  assert.deepEqual(s.syncs.map((entry) => entry.options.cwd), ["other-folder"]);

  // 밀린 정리가 도는 동안 켜기가 먼저 껐으면, 정리를 마친 유휴 끄기가 같은 서버를 또 끄지 않는다(끝난 뒤 새로 켠 서버의 표지를 지우게 된다).
  const idle = setup();
  await started(idle);
  let release;
  idle.idle.hold = new Promise((resolve) => {
    release = resolve;
  });
  idle.clock.advance(IDLE_MS);
  await waitFor(() => idle.log.includes("consolidate"), 3000, "정리");
  idle.health.up = false;
  void idle.proc.ensureStarted({ ...SETTINGS, folder: "other-folder" });
  await idle.spawned(2);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  idle.spawns[1].child.exit(0);
  await idle.spawned(3);
  assert.deepEqual(idle.spawns.map((entry) => entry.command), ["my-start", "my-stop", "my-start"]);
});

test("앱 종료 때는 켜는 중인 트리만 먼저 끊고 끄기 명령을 끝날 때까지 기다리며, 두 번 불려도 한 번만 끄고, 비동기 끄기가 도는 중에도 끈다", async () => {
  const starting = setup();
  void starting.proc.ensureStarted(SETTINGS);
  await starting.spawned();
  starting.proc.stopOnQuitSync();
  starting.proc.stopOnQuitSync();
  assert.deepEqual(starting.log, ["spawn my-start", "kill", "sync my-stop"]);
  assert.deepEqual(starting.syncs[0].options, { cwd: SETTINGS.folder, ...SHELL, timeout: 15000 });

  const ready = setup();
  await started(ready);
  ready.spawns[0].child.exit(0);
  ready.proc.stopOnQuitSync();
  assert.deepEqual(ready.log, ["spawn my-start", "sync my-stop"]);

  const stopping = setup();
  await started(stopping);
  stopping.clock.advance(IDLE_MS);
  await stopping.spawned(2);
  stopping.proc.stopOnQuitSync();
  assert.deepEqual(stopping.syncs.map((entry) => entry.command), ["my-stop"]);
});
