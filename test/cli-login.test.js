"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCliLoginRunner, extractUrls, needsShell } = require("../src/agora/cli-login");

// 실제 CLI 대신 쓰는 자식 프로세스 double. 출력은 테스트가 밀어 넣고, 표준입력에
// 쓰인 내용은 기록한다.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { written: [], destroyed: false, write(text) { this.written.push(text); return true; } };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit("exit", null, "SIGTERM"));
  };
  return child;
}

function makeRunner(over = {}) {
  const spawns = [];
  let child = null;
  const runner = createCliLoginRunner({
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      child = fakeChild();
      return child;
    },
    ...over,
  });
  return { runner, spawns, child: () => child };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("주소 추출은 문장 부호를 떼고 https 주소만 가져온다", () => {
  assert.deepEqual(
    extractUrls("If the browser didn't open, visit: https://claude.com/cai/oauth?code=true&x=1.\nPaste code here >"),
    ["https://claude.com/cai/oauth?code=true&x=1"]
  );
  assert.deepEqual(extractUrls("no urls here"), []);
  assert.equal(needsShell("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"), true);
  assert.equal(needsShell("/usr/local/bin/claude"), false);
});

test("로그인 프로세스의 출력에서 주소를 찾아 알리고, 붙여 넣은 코드를 표준입력으로 넘긴다", async () => {
  const { runner, spawns, child } = makeRunner();
  const events = [];
  runner.start({
    provider: "claude",
    command: "/usr/local/bin/claude",
    args: ["auth", "login"],
    env: { PATH: "/bin" },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(spawns[0].args, ["auth", "login"]);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.deepEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(runner.isRunning("claude"), true);

  child().stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\n");
  child().stdout.write("Paste code here if prompted > ");
  await settle();

  const url = events.find((event) => event.type === "url");
  assert.equal(url.url, "https://claude.com/cai/oauth/authorize?code=true&state=abc");
  assert.equal(runner.knowsUrl("claude", url.url), true);
  assert.equal(runner.knowsUrl("claude", "https://evil.example/"), false);
  // 줄바꿈 없이 끝난 출력은 입력을 기다리는 프롬프트다.
  const prompt = events.filter((event) => event.type === "output").pop();
  assert.equal(prompt.prompt, true);

  runner.input("claude", "  abc123#xyz  ");
  assert.deepEqual(child().stdin.written, ["abc123#xyz\n"]);
  assert.throws(() => runner.input("claude", "   "), /비어 있습니다/);

  child().stdout.write("Login successful\n");
  child().emit("exit", 0, null);
  await settle();
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit.ok, true);
  assert.equal(exit.code, 0);
  assert.ok(exit.tail.includes("Login successful"));
  assert.equal(runner.isRunning("claude"), false);
  assert.throws(() => runner.input("claude", "late"), /진행 중인 로그인이 없습니다/);
});

test("실패한 종료는 마지막 출력을 함께 돌려주고, 같은 제공자의 동시 로그인은 거부한다", async () => {
  const { runner, child } = makeRunner();
  const exits = [];
  runner.start({ provider: "codex", command: "codex", args: ["login"], onExit: (result) => exits.push(result) });
  assert.throws(() => runner.start({ provider: "codex", command: "codex", args: ["login"] }), /이미 로그인이 진행 중/);
  child().stderr.write("error: could not bind localhost:1455\n");
  child().emit("exit", 1, null);
  await settle();
  assert.equal(exits[0].ok, false);
  assert.equal(exits[0].code, 1);
  assert.deepEqual(exits[0].tail, ["error: could not bind localhost:1455"]);
  // 끝난 뒤에는 다시 시작할 수 있다.
  runner.start({ provider: "codex", command: "codex", args: ["login"] });
  assert.equal(runner.isRunning("codex"), true);
});

test("취소와 시간 초과는 프로세스를 끊고 성공으로 보고하지 않는다", async () => {
  const cancelled = makeRunner();
  const events = [];
  cancelled.runner.start({ provider: "claude", command: "claude", args: ["auth", "login"], onEvent: (event) => events.push(event) });
  assert.equal(cancelled.runner.cancel("claude"), true);
  await settle();
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit.ok, false);
  assert.equal(exit.cancelled, true);
  assert.equal(cancelled.runner.cancel("claude"), false, "끝난 로그인은 취소할 것이 없다");

  const timed = makeRunner({ timeoutMs: 5 });
  const timedEvents = [];
  timed.runner.start({ provider: "claude", command: "claude", args: ["auth", "login"], onEvent: (event) => timedEvents.push(event) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  const timedExit = timedEvents.find((event) => event.type === "exit");
  assert.ok(timedExit, "시간 초과로 종료 이벤트가 와야 합니다");
  assert.equal(timedExit.ok, false);
  assert.equal(timedExit.timedOut, true);
  assert.equal(timed.child().killed, true);
});

test("Windows의 .cmd 래퍼는 cmd.exe를 거쳐 실행하고 경로를 따옴표로 감싼다", () => {
  const { runner, spawns } = makeRunner();
  runner.start({ provider: "codex", command: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", args: ["login"] });
  assert.equal(spawns[0].command, '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"');
  assert.equal(spawns[0].options.shell, true);
});

test("spawn 자체가 실패하면 로그인을 시작하지 않고 이유를 던진다", () => {
  const runner = createCliLoginRunner({ spawn: () => { throw new Error("EPERM"); } });
  assert.throws(() => runner.start({ provider: "claude", command: "claude", args: [] }), /실행하지 못했습니다: EPERM/);
  assert.equal(runner.isRunning("claude"), false);
  assert.throws(() => runner.start({ provider: "claude", command: "", args: [] }), /명령을 찾지 못했습니다/);
});
