const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

// Deterministic capability service so CI results do not depend on locally installed CLIs.
function fakeRecord(id) {
  return {
    id,
    name: id,
    color: "#333333",
    aliases: [id],
    status: "cli",
    reason: "",
    commandPath: null,
    needsShell: false,
    version: "1.0.0",
    models: ["default", "test-model"],
    modelOptions: [
      { id: "default", label: "default", efforts: ["medium"] },
      { id: "test-model", label: "test-model", efforts: ["medium"] },
    ],
    efforts: ["medium"],
    allowCustomModel: false,
    supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
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
  const records = [fakeRecord("claude"), fakeRecord("codex"), fakeRecord("agy")];
  return {
    defs: records.map((record) => ({ id: record.id })),
    getRecord: (id) => records.find((record) => record.id === id) || null,
    discover: async () => records,
  };
}

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-project-ipc-"));
  return fs.realpathSync(dir);
}

function makeFeature(root, dialogResult = { canceled: true, filePaths: [] }, extraOptions = {}) {
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
    ...extraOptions,
  });
  feature.registerIpcHandlers();
  return {
    async invoke(channel, input = {}) {
      return handlers.get(channel)({}, input);
    },
  };
}

test("트리 사이드바용 sessionsByProject는 모든 프로젝트의 채팅을 내려준다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);

  const initial = await feature.invoke("chat:state");
  assert.equal(initial.ok, true);
  const grouped = initial.sessionsByProject;
  assert.ok(grouped && typeof grouped === "object", "sessionsByProject가 내려와야 합니다");
  const allIds = Object.values(grouped).flat().map((entry) => entry.id);
  assert.ok(allIds.includes(initial.activeSessionId), "활성 세션이 자기 프로젝트 그룹에 있어야 합니다");

  // 프로젝트를 지정한 새 채팅은 그 프로젝트 그룹으로 들어가고 활성이 된다.
  const created = await feature.invoke("chat:projects:create", { name: "트리 프로젝트" });
  const projectId = created.activeProjectId;
  const withNew = await feature.invoke("chat:sessions:create", { projectId });
  assert.equal(withNew.ok, true);
  assert.ok(
    (withNew.sessionsByProject[projectId] || []).some((entry) => entry.id === withNew.activeSessionId),
    "지정한 프로젝트 그룹에 새 채팅이 있어야 합니다"
  );
});

// 답변 대기 ×(chat:awaiting:dismiss)는 세션의 방에 대기 해제를 전달한다. 대기 중이
// 아닌 에이전트라도 오류 없이 끝난다(렌더러가 재시도할 일이 없다). 없는 세션은 거부.
test("IPC chat:awaiting:dismiss는 세션의 답변 대기를 지우고, 없는 세션은 거부한다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root);
  const created = await feature.invoke("chat:projects:create", { name: "대기 프로젝트" });
  const withNew = await feature.invoke("chat:sessions:create", { projectId: created.activeProjectId });
  const result = await feature.invoke("chat:awaiting:dismiss", {
    sessionId: withNew.activeSessionId,
    agentId: "claude",
  });
  assert.equal(result.ok, true);
  const missing = await feature.invoke("chat:awaiting:dismiss", { sessionId: "없는-세션", agentId: "claude" });
  assert.equal(missing.ok, false);
});

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

test("Case A: project.workspace가 null이면 session.workspace 캐시가 있어도 런타임 작업이 거부된다", async () => {
  const root = makeRoot();
  let providerCalls = 0;
  const feature = makeFeature(root, undefined, {
    runAgent: () => {
      providerCalls += 1;
      return { promise: Promise.resolve({ ok: true, text: "should not be called" }), cancel: () => {} };
    },
  });
  const oldRepo = path.join(root, "old-repo");
  fs.mkdirSync(oldRepo, { recursive: true });

  // 프로젝트 workspace는 null이지만 세션 메타에 과거 workspace 캐시가 남아있는 상태를 구성
  const created = await feature.invoke("chat:projects:create", {
    name: "프로젝트 workspace 없음",
    workspace: null,
  });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;

  // 세션 메타에만 과거 workspace 직접 주입 (stale cache 시뮬레이션)
  const storeRoot = path.join(root, "sessions", sessionId);
  const metaPath = path.join(storeRoot, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.workspace = oldRepo;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // workspace-read/write 권한 설정 거부
  const permRead = await feature.invoke("chat:permission:set", {
    sessionId,
    mode: "workspace-read",
  });
  assert.equal(permRead.ok, false);
  assert.match(permRead.error, /워크스페이스 폴더를 선택/);

  const permWrite = await feature.invoke("chat:permission:set", {
    sessionId,
    mode: "workspace-write",
  });
  assert.equal(permWrite.ok, false);
  assert.match(permWrite.error, /워크스페이스 폴더를 선택/);

  // provider가 절대 호출되지 않아야 한다.
  assert.equal(providerCalls, 0);
});

test("Case B: project.workspace가 repo-B이고 session.workspace가 repo-A(stale)이면 repo-B가 runtime authority로 동작한다", async () => {
  const root = makeRoot();
  const repoA = path.join(root, "repo-A");
  const repoB = path.join(root, "repo-B");
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  const feature = makeFeature(root, undefined, {
    capabilities: fakeCapabilities(),
    runAgent: () => ({ promise: Promise.resolve({ ok: true, text: "응답" }), cancel: () => {} }),
  });

  // 프로젝트 workspace는 repoB로 생성
  const created = await feature.invoke("chat:projects:create", {
    name: "repo-B 프로젝트",
    workspace: repoB,
  });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;
  const projectId = created.session.meta.projectId;

  // 세션 메타에만 repoA 주입 (stale cache 시뮬레이션)
  const storeRoot = path.join(root, "sessions", sessionId);
  const metaPath = path.join(storeRoot, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.workspace = repoA;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // 권한 설정은 프로젝트 workspace(repoB)를 기준으로 허용된다.
  const perm = await feature.invoke("chat:permission:set", { sessionId, mode: "workspace-read" });
  assert.equal(perm.ok, true);
  assert.equal(perm.meta.permissionMode, "workspace-read");
  // 화면의 프로젝트 목록도 repoB를 가리킨다. 실행 때 쓰는 canonical workspace는
  // 아래 makeRunAgent 소스 시험이 고정한다.
  const state = await feature.invoke("chat:state");
  assert.equal(state.projects.find((entry) => entry.id === projectId).workspace, repoB);
});

// chat-ipc.js의 makeRunAgent는 canonicalWorkspaceForMeta(meta)를 메타에서 계산해
// buildAgentInvocation({ workspace: canonicalWorkspace })로 전달한다. 이 경로는
// runAgent seam과 별개로 provider invocation builder까지 canonical workspace가
// 전달됨을 결정적으로 검증한다.
test("makeRunAgent passes canonical workspace to provider invocation builder", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "chat", "chat-ipc.js"),
    "utf8"
  );
  assert.match(
    source,
    /const canonicalWorkspace = canonicalWorkspaceForMeta\(meta\)/,
    "canonical workspace must be computed from the canonical meta authority"
  );
  assert.match(
    source,
    /buildAgentInvocation/,
    "buildAgentInvocation must receive the canonical workspace"
  );
  const builderCall = source.slice(source.indexOf("buildAgentInvocation"));
  assert.ok(
    builderCall.includes("workspace: canonicalWorkspace"),
    "buildAgentInvocation must receive the canonical workspace"
  );
});

// 전문 실행 자동 보완 정책은 프로젝트가 갖는다. 예전에는 화면(localStorage)에만
// 있어서 한 프로젝트에서 바꾸면 모든 프로젝트가 함께 바뀌었다.
test("자동 보완 정책은 프로젝트마다 따로 저장된다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root, { canceled: true, filePaths: [] });

  // chat:projects:create는 만들어진 세션을 돌려준다 — 프로젝트 id는 그 meta에 있다.
  const a = (await feature.invoke("chat:projects:create", { name: "실험" })).session.meta.projectId;
  const b = (await feature.invoke("chat:projects:create", { name: "실제 코드" })).session.meta.projectId;
  const listed = (payload, id) => (payload.projects || []).find((entry) => entry.id === id);
  // 새 프로젝트의 기본값은 "자동 보완 없음"이다(검수가 멈추고 물어본다).
  assert.deepEqual(listed(await feature.invoke("chat:state"), a).autoRevisions, { plan: 0, implementation: 0 });

  const saved = await feature.invoke("chat:projects:update", {
    projectId: a,
    patch: { autoRevisions: { plan: 3, implementation: 2 } },
  });
  assert.deepEqual(saved.project.autoRevisions, { plan: 3, implementation: 2 });

  // 다른 프로젝트는 그대로다.
  assert.deepEqual(listed(saved, b).autoRevisions, { plan: 0, implementation: 0 });

  // 범위를 벗어난 값은 잘라 낸다(0~3).
  const clamped = await feature.invoke("chat:projects:update", {
    projectId: a,
    patch: { autoRevisions: { plan: 99, implementation: -5 } },
  });
  assert.deepEqual(clamped.project.autoRevisions, { plan: 3, implementation: 0 });

  // 다른 항목만 저장해도 정책은 유지된다.
  const renamed = await feature.invoke("chat:projects:update", {
    projectId: a,
    patch: { name: "이름만 변경" },
  });
  assert.deepEqual(renamed.project.autoRevisions, { plan: 3, implementation: 0 });
});

// 이 필드가 없던 시절에 만든 프로젝트 파일도 같은 모양으로 읽혀야 한다.
test("예전 프로젝트 파일에도 자동 보완 기본값이 채워진다", async () => {
  const root = makeRoot();
  const feature = makeFeature(root, { canceled: true, filePaths: [] });
  const created = await feature.invoke("chat:projects:create", { name: "옛 프로젝트" });
  const projectId = created.session.meta.projectId;
  const file = path.join(root, "projects", `${projectId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  delete raw.autoRevisions;
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");

  const state = await feature.invoke("chat:state");
  const project = state.projects.find((entry) => entry.id === projectId);
  assert.deepEqual(project.autoRevisions, { plan: 0, implementation: 0 });
});
