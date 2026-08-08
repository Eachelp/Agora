const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-workflow-ipc-"));
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
      const handler = handlers.get(channel);
      assert.ok(handler, `IPC handler missing: ${channel}`);
      return handler({}, input);
    },
  };
}

test("프로젝트 기본 에이전트와 역할 담당자를 저장한다", async () => {
  const feature = makeFeature(makeRoot());
  const initial = await feature.invoke("chat:state");
  const projectId = initial.activeProjectId;
  const updated = await feature.invoke("chat:projects:update", {
    projectId,
    patch: {
      defaultAgents: { codex: { enabled: true, model: "gpt-5", effort: "high" } },
      defaultRoles: { implementation: "codex", review: "claude" },
    },
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.project.defaultAgents.codex.model, "gpt-5");
  assert.equal(updated.project.defaultRoles.review, "claude");
  assert.equal(updated.workflow.tasks.length, 0);

  const nextChat = await feature.invoke("chat:sessions:create");
  assert.equal(nextChat.ok, true);
  assert.equal(nextChat.session.meta.projectId, projectId);
  assert.equal(nextChat.session.meta.agents.codex.model, "gpt-5");
  assert.equal(nextChat.session.meta.agents.codex.effort, "high");
});

test("Decision과 Task를 프로젝트에 연결하고 상태를 변경한다", async () => {
  const feature = makeFeature(makeRoot());
  const initial = await feature.invoke("chat:state");
  const projectId = initial.activeProjectId;
  const chatId = initial.activeSessionId;
  const decisionResult = await feature.invoke("chat:decisions:create", {
    projectId,
    title: "이번 단계 범위",
    content: "Decision과 Task까지 구현한다.",
    chatId,
    messageIds: ["m1", "m2"],
  });
  assert.equal(decisionResult.ok, true);
  assert.equal(decisionResult.workflow.decisions.length, 1);

  const decisionId = decisionResult.decision.id;
  const taskResult = await feature.invoke("chat:tasks:create", {
    projectId,
    title: "작업 저장 화면 구현",
    description: "결정에서 실행할 작업을 만든다.",
    role: "implementation",
    agentId: "codex",
    decisionId,
    chatId,
  });
  assert.equal(taskResult.ok, true);
  assert.equal(taskResult.task.decisionId, decisionId);
  assert.equal(taskResult.task.status, "todo");

  const updated = await feature.invoke("chat:tasks:update", {
    projectId,
    taskId: taskResult.task.id,
    patch: { status: "review", role: "review", agentId: "claude" },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.task.status, "review");
  assert.equal(updated.task.agentId, "claude");

  const blockedDelete = await feature.invoke("chat:decisions:delete", { projectId, decisionId });
  assert.equal(blockedDelete.ok, false);
  assert.match(blockedDelete.error, /연결된 작업/);

  const taskDelete = await feature.invoke("chat:tasks:delete", {
    projectId,
    taskId: taskResult.task.id,
  });
  assert.equal(taskDelete.ok, true);
  const decisionDelete = await feature.invoke("chat:decisions:delete", { projectId, decisionId });
  assert.equal(decisionDelete.ok, true);
  assert.equal(decisionDelete.workflow.decisions.length, 0);
});
