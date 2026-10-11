"use strict";

// 앱 종료 때 도는 CLI가 둘 이상이어도 모두 끝나야 한다. 종료 경로(shutdown)가 지금까지 쓰던
// 비동기 taskkill은 앱이 먼저 사라지면 같이 죽어(자식 프로세스 묶음), 실행 중이던 CLI가 남았다.
// 그래서 종료 경로에서는 taskkill이 끝날 때까지 기다린다. 진짜 자식 프로세스 트리로 시험한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { killTree } = require("../src/chat/chat-agent-runner");
const { createChatFeature } = require("../src/chat/chat-ipc");

const win = process.platform === "win32";
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// 손자 프로세스를 하나 더 띄우고 pid를 알려 주는 자식. 오래 산다.
const PARENT_SRC = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
console.log("GRAND " + g.pid);
setTimeout(()=>{}, 60000);
`;

async function startTree() {
  const child = spawn(process.execPath, ["-e", PARENT_SRC], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const grand = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      const match = /GRAND (\d+)/.exec(String(chunk));
      if (match) resolve(Number(match[1]));
    });
    child.on("error", reject);
  });
  return { child, grand };
}

test("shutdown 뒤의 killTree는 돌아오기 전에 자식 트리를 모두 끝낸다", { skip: !win }, async (t) => {
  const feature = createChatFeature({
    electron: { ipcMain: { handle() {}, on() {}, send() {} }, dialog: {}, BrowserWindow: class {}, shell: {} },
    storeRoot: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "agora-quitkill-")),
    capabilities: { defs: [], getRecord: () => null, discover: async () => [] },
  });
  const trees = await Promise.all([startTree(), startTree(), startTree()]);
  t.after(() => { for (const { child, grand } of trees) { try { child.kill(); } catch {} try { process.kill(grand); } catch {} } });
  feature.shutdown();
  for (const { child } of trees) killTree(child);
  // 기다리지 않고 바로 본다: 비동기 taskkill이면 아직 살아 있다.
  for (const { child, grand } of trees) {
    assert.equal(alive(grand), false, "손자 프로세스가 남았습니다");
    assert.equal(alive(child.pid), false, "자식 프로세스가 남았습니다");
  }
});
