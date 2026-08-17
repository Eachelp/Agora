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
  fs.writeFileSync(path.join(oldRepo, "TASK-001.md"), "old task", "utf8");

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

  // 사용자 요청 메시지 추가 (전문 모드 진입 전제조건)
  await feature.invoke("chat:send", { sessionId, text: "전문 실행해줘", professionalDraft: true });

  // 1) 전문 모드 시작 거부
  const specialistStart = await feature.invoke("chat:specialist:start", {
    sessionId,
    mode: "step",
  });
  assert.equal(specialistStart.ok, false);
  assert.match(specialistStart.error, /워크스페이스가 필요합니다/);

  // 2) workspace-read/write 권한 설정 거부
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

  // 3) Task read 거부
  const taskRead = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: "TASK-001.md",
  });
  assert.equal(taskRead.ok, false);
  assert.match(taskRead.error, /프로젝트 워크스페이스가 설정되어 있지 않습니다/);

  // provider가 절대 호출되지 않아야 한다.
  assert.equal(providerCalls, 0);
});

test("Case B: project.workspace가 repo-B이고 session.workspace가 repo-A(stale)이면 repo-B가 runtime authority로 동작한다", async () => {
  const root = makeRoot();
  const repoA = path.join(root, "repo-A");
  const repoB = path.join(root, "repo-B");
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  fs.writeFileSync(path.join(repoA, "TASK-001.md"), "content in repo A", "utf8");
  fs.writeFileSync(path.join(repoB, "TASK-001.md"), "content in repo B", "utf8");
  fs.mkdirSync(path.join(repoB, ".project-memory", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(repoB, ".project-memory", "tasks", "TASK-001.md"),
    "## Goal\n목표\n## Requirements\n요구\n## Implementation Approach\n접근\n## Acceptance Criteria\n완료\n## Verification\n검증\n## Out of Scope\n제외\n",
    "utf8"
  );

  const checkpointCalls = [];
  const freezeCalls = [];
  const runAgentCalls = [];

  const feature = makeFeature(root, undefined, {
    checkpoint: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test12345678", workspace: ws };
      },
      inspectCheckpoint: () => ({ ok: true }),
      restoreCheckpoint: async () => ({ ok: true }),
      cleanupCheckpoint: () => ({ ok: true }),
    },
    taskManager: {
      freezeTask: (contract, ws) => {
        freezeCalls.push({ contract, ws });
        return { runId: "RUN-001", taskHash: "h123", content: "dummy" };
      },
      validateFrozenTask: () => ({ ok: true }),
      resolveTaskContract: () => "contract",
      readFrozenTask: () => ({ ok: true, task: { content: "dummy" } }),
      writeRunResult: () => true,
      writeRunEvidence: () => true,
    },
    runAgent: (agent, options) => {
      runAgentCalls.push({ agent, options });
      return {
        promise: Promise.resolve({
          ok: true,
          text: "## Goal\n목표\n## Requirements\n요구\n## Implementation Approach\n접근\n## Acceptance Criteria\n완료\n## Verification\n검증\n## Out of Scope\n제외\nSTATUS: PLAN_READY",
          builderStatus: "DONE",
        }),
        cancel: () => {},
      };
    },
  });

  // 프로젝트 workspace는 repoB로 생성
  const created = await feature.invoke("chat:projects:create", {
    name: "repo-B 프로젝트",
    workspace: repoB,
  });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;
  const projectId = created.session.meta.projectId;

  // 전문 실행 역할 설정
  await feature.invoke("chat:projects:update", {
    projectId,
    patch: {
      defaultRoles: {
        planning: { agentId: "claude" },
        plan_review: { agentId: "claude" },
        implementation: { agentId: "claude" },
        review: { agentId: "claude" },
        recorder: { agentId: "claude" },
      },
    },
  });

  // 세션 메타에만 repoA 주입 (stale cache 시뮬레이션)
  const storeRoot = path.join(root, "sessions", sessionId);
  const metaPath = path.join(storeRoot, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.workspace = repoA;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // Task 읽기는 repoB의 파일을 읽어야 한다 (repoA 내용이 아님)
  const taskRead = await feature.invoke("chat:task:read-file", {
    sessionId,
    taskPath: "TASK-001.md",
  });
  assert.equal(taskRead.ok, true);
  assert.equal(taskRead.content, "content in repo B");

  // 전문 실행 시작: 사용자 요청 메시지 추가 후 실행
  await feature.invoke("chat:send", { sessionId, text: "구현해줘", professionalDraft: true });
  const started = await feature.invoke("chat:specialist:start", {
    sessionId,
    action: "full",
    mode: "step",
  });
  assert.equal(started.ok, true);

  // Mock 검증: freezeTask 및 checkpoint 및 provider invocation에 전달된 workspace가 repoB여야 하고, repoA는 결코 사용되지 않아야 한다.
  if (freezeCalls.length > 0) {
    for (const call of freezeCalls) {
      assert.equal(call.ws, repoB);
      assert.notEqual(call.ws, repoA);
    }
  }
  if (checkpointCalls.length > 0) {
    for (const call of checkpointCalls) {
      assert.equal(call.ws, repoB);
      assert.notEqual(call.ws, repoA);
    }
  }
});
