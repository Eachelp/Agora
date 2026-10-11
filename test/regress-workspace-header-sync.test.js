"use strict";

// F1 — 프로젝트 설정에서 폴더를 고르거나 해제하면 헤더의 워크스페이스·권한 표시와 보고 있는 대화의
// meta가 함께 갱신돼야 한다. 백엔드는 응답에 보고 있는 대화의 meta(activeMeta)를 싣고,
// 렌더러는 그것으로 sessionMeta를 맞춘 뒤 헤더를 다시 그린다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createChatFeature } = require("../src/chat/chat-ipc");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");

function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
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

function makeFeature(root, pickedDir) {
  const handlers = new Map();
  const records = [fakeRecord("claude"), fakeRecord("codex"), fakeRecord("agy")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: false, filePaths: [pickedDir] }; } },
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

test("폴더를 고르고 해제하면 응답이 보고 있는 대화의 meta를 함께 돌려준다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-wsync-")));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-wsync-dir-")));
  const app = makeFeature(root, folder);
  const created = await app.invoke("chat:projects:create", { name: "폴더 시험" });
  const projectId = created.activeProjectId;
  const sessionId = created.session.meta.id;

  const chosen = await app.invoke("chat:projects:workspace:choose", { projectId });
  assert.equal(chosen.activeMeta.id, sessionId);
  assert.equal(chosen.activeMeta.workspace, folder);

  const perm = await app.invoke("chat:permission:set", { sessionId, mode: "workspace-write" });
  assert.equal(perm.meta.permissionMode, "workspace-write");
  const cleared = await app.invoke("chat:projects:workspace:clear", { projectId });
  assert.equal(cleared.activeMeta.workspace, null);
  assert.equal(cleared.activeMeta.permissionMode, "chat", "해제하면 백엔드가 권한을 chat으로 내린다");
  app.feature.shutdown?.();
});

test("렌더러는 폴더 변경 응답으로 projects·sessionMeta를 맞추고 헤더를 다시 그린다", () => {
  const start = rendererSource.indexOf("function applyWorkspaceChange(");
  assert.ok(start >= 0, "applyWorkspaceChange가 있어야 한다");
  const body = rendererSource.slice(start, rendererSource.indexOf("\nfunction ", start + 10));
  const calls = [];
  const context = {
    activeSessionId: "s1",
    projects: [{ id: "p", workspace: null }],
    sessionMeta: { id: "s1", permissionMode: "workspace-write", workspace: "C:/old" },
    renderProjects: () => calls.push("projects"),
    renderHeader: () => calls.push("header"),
  };
  vm.createContext(context);
  vm.runInContext(body, context);

  context.applyWorkspaceChange({
    projects: [{ id: "p", workspace: null }],
    activeMeta: { id: "s1", permissionMode: "chat", workspace: null },
  });
  assert.equal(context.sessionMeta.permissionMode, "chat");
  assert.deepEqual(calls, ["projects", "header"]);

  // 다른 대화의 meta는 지금 화면의 sessionMeta를 덮지 않는다.
  context.applyWorkspaceChange({ activeMeta: { id: "other", permissionMode: "workspace-read" } });
  assert.equal(context.sessionMeta.id, "s1");

  // 폴더 선택·해제 두 버튼 모두 이 함수를 거친다.
  assert.equal(rendererSource.match(/^\s+applyWorkspaceChange\(result\);/gm).length, 2);
});
