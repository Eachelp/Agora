"use strict";

// R3: 검토 후속 2건을 진입점에서 확인한다.
//  1) 자유 토론의 합의는 서로 다른 참가자 전원이 동의해야 성립한다.
//  2) 대화 기록 저장 실패 안내는 방마다 한 번만, 그 방(sessionId)에 붙여서 보낸다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

const AGREE = "[[CODEPET_DISCUSSION:AGREE]]";
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await tick();
  }
}

test("자유 토론: 한 참가자가 두 번 동의해도 다른 참가자가 답하지 않았으면 끝나지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: [
      { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
      { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    ],
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      // codex는 계속 실패(한도 아님) — claude만 매번 동의한다.
      const value = agent.id === "claude" ? { ok: true, text: `동의 ${AGREE}` } : { ok: false, error: "일시적 오류" };
      return { promise: Promise.resolve(value), cancel: () => {} };
    },
  });
  room.sendUserMessage("@claude 주제");
  await room.waitForIdle();
  calls.length = 0;
  const result = await room.startDiscussion({ turnBudget: 6 });
  await room.waitForIdle();
  assert.equal(result.concluded, false);
  assert.equal(calls.length, 6, "합의가 성립하지 않아 예산까지 진행");
});

function makeApp(root) {
  const handlers = new Map();
  const notices = [];
  const record = (id) => ({
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: [] }], efforts: [],
    allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  });
  const records = [record("claude"), record("codex")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class {
        constructor() {
          this.webContents = { send: (channel, payload) => { if (channel === "chat:system-notice") notices.push(payload); } };
        }
        isDestroyed() { return false; }
        on() {}
        once() {}
        setMenuBarVisibility() {}
        loadFile() {}
      },
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
    runAgent: () => ({ promise: Promise.resolve({ ok: true, text: "네." }), cancel: () => {} }),
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  return { notices, invoke: (channel, input = {}) => handlers.get(channel)({}, input), quit: () => feature.shutdown() };
}

test("저장 실패 안내는 방마다 한 번만, 해당 방 sessionId와 함께 가고 저장이 되살아나면 다시 안내한다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-notice-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root);
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;

  const original = fs.appendFileSync;
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { fs.appendFileSync = original; console.warn = warn; });
  const failing = (on) => {
    fs.appendFileSync = on
      ? function patched(file, ...rest) {
          if (String(file).includes(sessionId)) throw Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" });
          return original.call(this, file, ...rest);
        }
      : original;
  };

  failing(true);
  await app.invoke("chat:send", { sessionId, text: "@claude 하나" });
  await app.invoke("chat:send", { sessionId, text: "@codex 둘" });
  await waitFor(async () => (await app.invoke("chat:state")).sessions.length >= 1);
  await tick(150);
  assert.equal(app.notices.length, 1, "여러 번 실패해도 안내는 한 번");
  assert.equal(app.notices[0].sessionId, sessionId);
  assert.match(app.notices[0].text, /저장하지 못했습니다/);

  failing(false);
  await app.invoke("chat:send", { sessionId, text: "@claude 셋" });
  await tick(150);
  assert.equal(app.notices.length, 1);

  failing(true);
  await app.invoke("chat:send", { sessionId, text: "@claude 넷" });
  await tick(150);
  assert.equal(app.notices.length, 2, "저장이 한 번 성공한 뒤의 새 실패는 다시 안내");
});

test("렌더러는 sessionId가 붙은 시스템 안내를 그 방에서만 보여 준다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");
  // 다른 방에는 그리지 않는다. 버리지 않고 pendingNotices에 두었다가 그 방이 열릴 때 보여 준다
  // (동작은 regress-final-repair.test.js에서 확인한다).
  assert.match(src, /onSystemNotice\(\(\{ text, sessionId \}\) => \{\s*if \(sessionId && sessionId !== activeSessionId\) \{[^}]*pendingNotices[^}]*return;\s*\}\s*appendMessage/);
});
