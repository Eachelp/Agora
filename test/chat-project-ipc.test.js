const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-project-ipc-"));
}

function makeFeature(root) {
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
      dialog: {},
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
  });
  feature.registerIpcHandlers();
  return {
    async invoke(channel, input = {}) {
      return handlers.get(channel)({}, input);
    },
  };
}

test("IPC는 프로젝트를 만들고 기존 채팅을 다른 프로젝트로 옮긴다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);

  const initial = await feature.invoke("chat:state");
  assert.equal(initial.ok, true);
  assert.equal(initial.projects.length, 1);
  assert.equal(initial.sessions.length, 1);
  assert.ok(fs.existsSync(path.join(root, "projects", "uncategorized.json")));

  const created = await feature.invoke("chat:projects:create", { name: "실험 프로젝트" });
  assert.equal(created.ok, true);
  assert.equal(created.projects.some((project) => project.name === "실험 프로젝트"), true);
  assert.equal(created.session.meta.projectId, created.activeProjectId);

  const moved = await feature.invoke("chat:sessions:move", {
    sessionId: created.session.meta.id,
    projectId: "uncategorized",
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.session.meta.projectId, "uncategorized");
  assert.equal(moved.activeProjectId, "uncategorized");
  assert.equal(moved.sessions.some((session) => session.id === created.session.meta.id), true);
});

test("대화 이동은 명시적으로 선택하지 않으면 워크스페이스를 그대로 둔다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);

  const withFolder = await feature.invoke("chat:projects:create", {
    name: "폴더 있는 프로젝트",
    workspace: root,
  });
  assert.equal(withFolder.ok, true);
  const projectId = withFolder.activeProjectId;

  const plain = await feature.invoke("chat:projects:create", { name: "폴더 없는 프로젝트" });
  assert.equal(plain.ok, true);
  const sessionId = plain.session.meta.id;
  assert.equal(plain.session.meta.workspace, null);

  const movedWithoutApply = await feature.invoke("chat:sessions:move", {
    sessionId,
    projectId,
  });
  assert.equal(movedWithoutApply.ok, true);
  assert.equal(movedWithoutApply.session.meta.projectId, projectId);
  assert.equal(movedWithoutApply.session.meta.workspace, null);
  assert.equal(movedWithoutApply.session.meta.permissionMode, "chat");
});

test("대화 이동에서 명시적으로 선택하면 프로젝트 폴더/권한을 함께 적용한다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);

  const withFolder = await feature.invoke("chat:projects:create", {
    name: "폴더 있는 프로젝트",
    workspace: root,
  });
  const projectId = withFolder.activeProjectId;
  await feature.invoke("chat:projects:update", {
    projectId,
    patch: { defaultPermissionMode: "workspace-read" },
  });

  const plain = await feature.invoke("chat:projects:create", { name: "폴더 없는 프로젝트" });
  const sessionId = plain.session.meta.id;

  const movedWithApply = await feature.invoke("chat:sessions:move", {
    sessionId,
    projectId,
    applyProjectWorkspace: true,
  });
  assert.equal(movedWithApply.ok, true);
  assert.equal(movedWithApply.session.meta.projectId, projectId);
  assert.equal(movedWithApply.session.meta.workspace, root);
  assert.equal(movedWithApply.session.meta.permissionMode, "workspace-read");
});

test("작업 지시서 읽기는 워크스페이스 안 파일만 크기 상한 안에서 허용한다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);

  const created = await feature.invoke("chat:projects:create", {
    name: "폴더 있는 프로젝트",
    workspace: root,
  });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;

  fs.writeFileSync(path.join(root, "TASK-001.md"), "기획안 내용", "utf8");
  const ok = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: "TASK-001.md",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.content, "기획안 내용");

  // 워크스페이스 밖(../) 경로는 거부됩니다.
  const outside = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: "../secret.md",
  });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /워크스페이스 밖/);

  // 크기 상한(5 MiB)을 넘는 파일은 읽지 않습니다.
  const bigPath = path.join(root, "TASK-big.md");
  fs.writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1));
  const tooBig = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: "TASK-big.md",
  });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /너무 커서/);

  // 절대 경로는 거부됩니다.
  const absolute = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: path.join(root, "TASK-001.md"),
  });
  assert.equal(absolute.ok, false);
});
