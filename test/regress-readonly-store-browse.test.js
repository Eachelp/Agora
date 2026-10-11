"use strict";

// F3 — 읽기 전용 저장소에서 다른 대화를 고르면 본문(session)과 activeSessionId가 서로 다른 방을
// 가리켰다. 진입점(createChatFeature + fake ipcMain)으로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: { chat: { supported: true, enforcement: "tool-policy" } },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function makeFeature(root) {
  const handlers = new Map();
  const records = [fakeRecord("claude"), fakeRecord("codex"), fakeRecord("agy")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class {},
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
  });
  feature.registerIpcHandlers();
  return { feature, invoke: (channel, input = {}) => handlers.get(channel)({}, input) };
}

test("읽기 전용 저장소에서도 고른 대화가 현재 대화가 되어 본문과 활성 id가 같다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-readonly-")));
  let app = makeFeature(root);
  const a = (await app.invoke("chat:state")).activeSessionId;
  const b = (await app.invoke("chat:sessions:create")).activeSessionId;
  await app.invoke("chat:sessions:select", { sessionId: a });
  app.feature.shutdown?.();

  const configPath = path.join(root, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.schemaVersion = 999;
  fs.writeFileSync(configPath, JSON.stringify(config));

  app = makeFeature(root);
  const state = await app.invoke("chat:state");
  assert.equal(state.readOnly, true);
  assert.equal(state.activeSessionId, a);

  const picked = await app.invoke("chat:sessions:select", { sessionId: b });
  assert.equal(picked.session.meta.id, b);
  assert.equal(picked.activeSessionId, b, "본문은 B인데 활성 id가 A로 남으면 전송·이벤트가 엉뚱한 방으로 간다");

  const back = await app.invoke("chat:sessions:select", { sessionId: a });
  assert.equal(back.session.meta.id, a);
  assert.equal(back.activeSessionId, a, "원래 대화로 돌아갈 수 있어야 한다");

  // 설정 파일은 읽기 전용이므로 그대로여야 한다.
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).schemaVersion, 999);
  app.feature.shutdown?.();
});
