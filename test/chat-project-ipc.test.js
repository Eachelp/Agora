const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-project-ipc-"));
  return fs.realpathSync(dir);
}

function makeFeature(root, dialogResult = { canceled: true, filePaths: [] }) {
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
      dialog: {
        async showOpenDialog() {
          return dialogResult;
        },
      },
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

test("대화 이동은 항상 대상 프로젝트의 워크스페이스를 상속한다", async () => {
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

  // 옵션 없이 이동해도 프로젝트 workspace를 무조건 상속합니다.
  const moved = await feature.invoke("chat:sessions:move", {
    sessionId,
    projectId,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.session.meta.projectId, projectId);
  assert.equal(moved.session.meta.workspace, root);
  assert.equal(moved.session.meta.permissionMode, "chat");
});

test("이동 시 프로젝트 기본 권한 모드를 상속한다", async () => {
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

  const moved = await feature.invoke("chat:sessions:move", {
    sessionId,
    projectId,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.session.meta.projectId, projectId);
  assert.equal(moved.session.meta.workspace, root);
  assert.equal(moved.session.meta.permissionMode, "workspace-read");
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

test("세션 워크스페이스 설정은 프로젝트 단위로 위임된다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root, { canceled: true, filePaths: [] });

  const created = await feature.invoke("chat:projects:create", {
    name: "워크스페이스 프로젝트",
    workspace: root,
  });
  assert.equal(created.ok, true);
  const s1 = created.session.meta.id;
  assert.equal(created.session.meta.workspace, root);

  // 세션 단위 호출은 프로젝트로 위임된다. 대화상자 취소시 canceled를 반환한다.
  const chosen = await feature.invoke("chat:workspace:choose", { sessionId: s1 });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.canceled, true);

  // 세션 단위 clear는 프로젝트 workspace를 해제하고 모든 세션을 chat 권한으로 돌리는다.
  const cleared = await feature.invoke("chat:workspace:clear", { sessionId: s1 });
  assert.equal(cleared.ok, true);
  const state = await feature.invoke("chat:state");
  for (const session of state.sessions) {
    assert.equal(session.workspace, null);
    assert.equal(session.permissionMode, "chat");
  }
});

test("프로젝트 workspace 변경은 모든 세션 meta에 일괄 반영된다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root, { canceled: false, filePaths: [root] });

  const created = await feature.invoke("chat:projects:create", {
    name: "일괄 반영 프로젝트",
  });
  assert.equal(created.ok, true);
  const projectId = created.activeProjectId;

  const second = await feature.invoke("chat:sessions:create");
  assert.equal(second.ok, true);
  assert.equal(second.session.meta.workspace, null);

  // 프로젝트 workspace 사용자 선택이 모든 세션에 반영된다.
  const changed = await feature.invoke("chat:projects:workspace:choose", { projectId });
  assert.equal(changed.ok, true);
  assert.equal(changed.project.workspace, root);
  const state = await feature.invoke("chat:state");
  for (const session of state.sessions) {
    assert.equal(session.workspace, root);
  }
});
