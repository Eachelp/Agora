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

function mkRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-readonly-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

// 읽기 전용 저장소에서는 활성 프로젝트를 저장하지 못하고 새 대화도 만들 수 없다. 대화가 없는 프로젝트를 그냥 받으면
// 응답이 옛 프로젝트·빈 대화로 돌아가 사이드바 선택이 아무 말 없이 되돌아가므로, 이유를 알리고 선택은 그대로 둔다.
test("읽기 전용 저장소에서 대화가 없는 프로젝트를 고르면 이유를 알리고 선택은 그대로 남는다", async (t) => {
  const root = mkRoot(t);
  let app = makeFeature(root);
  const start = await app.invoke("chat:state");
  const homeProject = start.activeProjectId;
  // 프로젝트를 만들면 대화가 하나 따라 생기므로, 그 대화를 처음 프로젝트로 옮겨 빈 프로젝트를 만든다.
  const created = await app.invoke("chat:projects:create", { name: "빈 프로젝트" });
  const emptyProject = created.activeProjectId;
  assert.notEqual(emptyProject, homeProject);
  await app.invoke("chat:sessions:move", { sessionId: created.activeSessionId, projectId: homeProject });
  const home = await app.invoke("chat:sessions:select", { sessionId: start.activeSessionId });
  assert.equal(home.sessionsByProject[emptyProject], undefined, "빈 프로젝트에는 대화가 없어야 한다");
  app.feature.shutdown?.();

  const configPath = path.join(root, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.schemaVersion = 999;
  fs.writeFileSync(configPath, JSON.stringify(config));

  app = makeFeature(root);
  const state = await app.invoke("chat:state");
  assert.equal(state.readOnly, true);
  assert.equal(state.activeProjectId, homeProject);

  const picked = await app.invoke("chat:projects:select", { projectId: emptyProject });
  assert.equal(picked.ok, false);
  assert.match(picked.error, /읽기 전용/);
  assert.match(picked.error, /대화가 없는 프로젝트/);
  const after = await app.invoke("chat:state");
  assert.equal(after.activeProjectId, homeProject, "거절된 선택이 활성 프로젝트를 옮기면 안 된다");
  assert.equal(after.activeSessionId, state.activeSessionId);

  // 대화가 있는 프로젝트는 읽기 전용에서도 그대로 둘러볼 수 있다.
  const browsed = await app.invoke("chat:projects:select", { projectId: homeProject });
  assert.equal(browsed.ok, true, browsed.error);
  assert.equal(browsed.activeProjectId, homeProject);
  assert.equal(browsed.session.meta.id, browsed.activeSessionId);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).schemaVersion, 999);
  app.feature.shutdown?.();
});
