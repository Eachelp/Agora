"use strict";

// 전문 모드 제거 — 옛 프로젝트 JSON의 defaultRoles·autoRevisions는 수정·저장해도 파일에 남는다.
// 진입점(createChatFeature + fake ipcMain)으로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

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

test("프로젝트를 이름 변경·폴더 선택/해제로 저장해도 옛 defaultRoles·autoRevisions가 파일에 남고, 화면 쪽에는 나가지 않는다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-proj-legacy-")));
  const ws = path.join(root, "folder");
  fs.mkdirSync(ws);
  const feature = makeFeature(root, ws);

  const created = await feature.invoke("chat:projects:create", { name: "옛 설정 프로젝트" });
  const projectId = created.activeProjectId;
  const file = path.join(root, "projects", `${projectId}.json`);
  const legacy = {
    defaultRoles: { recorder: { agentId: "codex", model: "m1", effort: "high" } },
    autoRevisions: { planning: 2 },
  };
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...legacy }));

  const renamed = await feature.invoke("chat:projects:update", { projectId, patch: { name: "새 이름" } });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.project.name, "새 이름");
  assert.equal("defaultRoles" in renamed.project, false);
  assert.equal("autoRevisions" in renamed.project, false);

  assert.equal((await feature.invoke("chat:projects:workspace:choose", { projectId })).ok, true);
  assert.equal((await feature.invoke("chat:projects:workspace:clear", { projectId })).ok, true);

  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(disk.name, "새 이름");
  assert.deepEqual(disk.defaultRoles, legacy.defaultRoles);
  assert.deepEqual(disk.autoRevisions, legacy.autoRevisions);
});
