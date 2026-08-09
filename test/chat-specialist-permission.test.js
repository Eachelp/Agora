const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-specialist-ipc-"));
}

function fakeRecord(id, name) {
  return {
    id,
    name,
    color: "#333333",
    aliases: [id],
    status: "cli",
    reason: "",
    commandPath: null,
    needsShell: false,
    version: "1.0.0",
    models: ["default", "test-model"],
    modelOptions: [{ id: "default", label: "기본값", efforts: ["medium"] }, { id: "test-model", efforts: ["medium"] }],
    efforts: ["medium"],
    allowCustomModel: false,
    supportsImages: false,
    streaming: true,
    permissions: {
      chat: { supported: true, enforcement: "prompt" },
      "workspace-read": { supported: true, enforcement: "tools" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false,
    authStatus: "authenticated",
    authReason: "",
    installUrl: null,
    loginCommand: null,
  };
}

function fakeCapabilities() {
  const records = [fakeRecord("claude", "Claude"), fakeRecord("codex", "Codex")];
  return {
    defs: records.map((record) => ({ id: record.id })),
    getRecord: (id) => records.find((record) => record.id === id) || null,
    discover: async () => records,
  };
}

function fakeRunAgent(calls = []) {
  return ({ agent, prompt }) => {
    calls.push({ agentId: agent.id, prompt });
    const text = agent.id === "codex" ? "검토 통과\n[[CODEPET_REVIEW:PASS]]" : "구현 완료";
    return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
  };
}

function makeFeature(root, workspaceDir, calls) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on() {},
  };
  const feature = createChatFeature({
    electron: {
      ipcMain,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [workspaceDir] }) },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(),
    runAgent: fakeRunAgent(calls),
  });
  feature.registerIpcHandlers();
  return {
    async invoke(channel, input = {}) {
      const handler = handlers.get(channel);
      assert.ok(handler, `IPC handler missing: ${channel}`);
      return handler({}, input);
    },
  };
}

async function setup(feature) {
  const initial = await feature.invoke("chat:state");
  const projectId = initial.activeProjectId;
  const sessionId = initial.activeSessionId;
  await feature.invoke("chat:projects:update", {
    projectId,
    patch: { defaultRoles: { implementation: "claude", review: "codex" } },
  });
  return { projectId, sessionId };
}

test("워크스페이스가 없으면 전문 모드 시작을 거부한다", async () => {
  const calls = [];
  const feature = makeFeature(makeRoot(), makeRoot(), calls);
  const { sessionId } = await setup(feature);

  const denied = await feature.invoke("chat:specialist:start", { sessionId });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /쓰기 권한/);
  assert.equal(calls.length, 0);
});

test("워크스페이스가 있으면 전문 모드가 쓰기 권한으로 자동 승격된다", async () => {
  const calls = [];
  const feature = makeFeature(makeRoot(), makeRoot(), calls);
  const { sessionId } = await setup(feature);

  const chosen = await feature.invoke("chat:workspace:choose", { sessionId });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.meta.permissionMode, "chat");

  const started = await feature.invoke("chat:specialist:start", { sessionId });
  assert.equal(started.ok, true);
  assert.equal(started.meta.permissionMode, "workspace-write");

  // 백그라운드 실행이 끝나기를 잠시 기다립니다.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(calls.length >= 2, "구현·검토 단계가 실행되어야 합니다");
});

test("이미 쓰기 권한인 채팅은 그대로 전문 모드를 실행한다", async () => {
  const calls = [];
  const feature = makeFeature(makeRoot(), makeRoot(), calls);
  const { sessionId } = await setup(feature);
  await feature.invoke("chat:workspace:choose", { sessionId });
  await feature.invoke("chat:permission:set", { sessionId, mode: "workspace-write" });

  const started = await feature.invoke("chat:specialist:start", { sessionId });
  assert.equal(started.ok, true);
  assert.equal(started.meta.permissionMode, "workspace-write");
});
