const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

// 실제 IPC 핸들러를 가짜 ipcMain으로 구동한다(electron/capabilities만 가짜).
function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "",
    commandPath: null, needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function makeFeature(root, workspace) {
  const handlers = new Map();
  const records = ["claude", "codex", "agy"].map(fakeRecord);
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [workspace] }) },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input) };
}

const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));

test("F63: 프로젝트를 지우면 옮겨진 대화의 workspace·권한이 비워지고, 재시작해도 폴더가 되살아나지 않는다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-proj-del-")));
  const ws = path.join(root, "deleted-folder");
  fs.mkdirSync(ws);
  const feature = makeFeature(root, ws);

  const created = await feature.invoke("chat:projects:create", { name: "지울 프로젝트" });
  const projectId = created.activeProjectId;
  const sessionId = created.session.meta.id;
  assert.equal((await feature.invoke("chat:projects:workspace:choose", { projectId })).ok, true);
  assert.equal((await feature.invoke("chat:permission:set", { sessionId, mode: "workspace-write" })).ok, true);
  const before = readJson(root, "sessions", sessionId, "meta.json");
  assert.equal(before.workspace, ws);
  assert.equal(before.permissionMode, "workspace-write");

  const deleted = await feature.invoke("chat:projects:delete", { projectId });
  assert.equal(deleted.ok, true);

  const after = readJson(root, "sessions", sessionId, "meta.json");
  assert.equal(after.projectId, "uncategorized");
  assert.equal(after.workspace, null);
  assert.equal(after.permissionMode, "chat");

  // 앱을 다시 켠 것과 같다: 같은 root로 새 feature를 만들고 상태를 읽는다.
  const restarted = makeFeature(root, ws);
  assert.equal((await restarted.invoke("chat:state")).ok, true);
  assert.equal(readJson(root, "projects", "uncategorized.json").workspace ?? null, null);
  assert.equal(readJson(root, "sessions", sessionId, "meta.json").workspace, null);
});
