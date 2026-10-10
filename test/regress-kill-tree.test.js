// F71/F86: Windows에서 .cmd 셈(cmd.exe → node)으로 띄운 CLI는 중지/취소 뒤에도 자손이 남고
// 실행이 끝나지 않던 문제. 실제 프로세스 트리로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { createCliLoginRunner } = require("../src/agora/cli-login");

const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// cmd.exe가 부모, node.exe(오래 도는 CLI 흉내)가 손자가 되는 npm 셈 모양.
function makeShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kill-tree-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const script = path.join(dir, "fakecli.js");
  fs.writeFileSync(
    script,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      "setTimeout(() => {}, 30000);\n"
  );
  const shim = path.join(dir, "fakecli.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return { dir, pidFile, shim };
}

async function waitForPid(pidFile) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid) return pid;
    } catch {}
    await sleep(50);
  }
  throw new Error("손자 프로세스가 시작되지 않았습니다.");
}

async function waitDead(pid, ms = 5000) {
  for (let t = 0; t < ms && alive(pid); t += 50) await sleep(50);
  return !alive(pid);
}

test("중지하면 .cmd 셈 뒤의 CLI 손자까지 끝나고 실행도 곧 끝난다", { skip: !WIN }, async () => {
  const { dir, pidFile, shim } = makeShim();
  let grandchild = null;
  try {
    const run = runAgentProcess({
      commandPath: shim,
      needsShell: true,
      argv: [],
      prompt: "hi",
      cwd: dir,
      timeoutMs: 60000,
    });
    grandchild = await waitForPid(pidFile);
    run.cancel();
    const result = await Promise.race([run.promise, sleep(15000).then(() => "hang")]);
    assert.notEqual(result, "hang", "중지한 실행이 끝나지 않았습니다");
    assert.equal(result.cancelled, true);
    assert.equal(await waitDead(grandchild), true, "CLI 손자가 살아 있습니다");
  } finally {
    if (grandchild && alive(grandchild)) process.kill(grandchild);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test("로그인 취소도 .cmd 셈 뒤의 CLI 손자까지 끝낸다", { skip: !WIN }, async () => {
  const { dir, pidFile, shim } = makeShim();
  let grandchild = null;
  try {
    const events = [];
    const runner = createCliLoginRunner();
    runner.start({ provider: "codex", command: shim, args: [], onEvent: (e) => events.push(e) });
    grandchild = await waitForPid(pidFile);
    assert.equal(runner.cancel("codex"), true);
    for (let i = 0; i < 160 && !events.some((e) => e.type === "exit"); i += 1) await sleep(50);
    assert.ok(events.some((e) => e.type === "exit"), "로그인 종료 이벤트가 와야 합니다");
    assert.equal(await waitDead(grandchild), true, "CLI 손자가 살아 있습니다");
  } finally {
    if (grandchild && alive(grandchild)) process.kill(grandchild);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
