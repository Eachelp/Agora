const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ChatRoom,
  DEFAULT_DISCUSSION_RUN_BUDGET,
  DISCUSSION_TURN_BUDGET_MIN,
  DISCUSSION_TURN_BUDGET_MAX,
  clampDiscussionTurnBudget,
} = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("clampDiscussionTurnBudget: 범위 밖 값은 3~50으로 자르고 비정수는 기본값", () => {
  assert.equal(clampDiscussionTurnBudget(2, 9), DISCUSSION_TURN_BUDGET_MIN);
  assert.equal(clampDiscussionTurnBudget(100, 9), DISCUSSION_TURN_BUDGET_MAX);
  assert.equal(clampDiscussionTurnBudget(15, 9), 15);
  assert.equal(clampDiscussionTurnBudget("15", 9), 9);
  assert.equal(clampDiscussionTurnBudget(undefined, 9), 9);
  assert.equal(clampDiscussionTurnBudget(null, 9), 9);
});

test("토론 turnBudget 옵션이 발언 수 상한을 바꾼다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ turnBudget: 4 });
  await settle(room);

  assert.equal(result.ok, true);
  assert.equal(result.completed, 4);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "claude", "codex"],
  );
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.equal(conclusion.discussionMeta.budget, 4);
  assert.match(conclusion.text, /예산/);
});

test("토론 프롬프트의 턴 표기는 설정된 budget을 따른다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  await room.startDiscussion({ turnBudget: 4 });
  await settle(room);

  assert.match(calls[0].prompt, /자율 토론 1\/4턴/);
});

test("turnBudget 없는 토론은 기존 기본 9턴 그대로다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({});
  await settle(room);

  assert.equal(result.completed, DEFAULT_DISCUSSION_RUN_BUDGET);
  assert.match(calls[0].prompt, /자율 토론 1\/9턴/);
});

test("turnBudget은 방 계층에서 3~50으로 다시 잘린다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ turnBudget: 2 });
  await settle(room);
  assert.equal(result.completed, DISCUSSION_TURN_BUDGET_MIN);
});

test("레거시 rounds 옵션은 계속 무시된다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ rounds: 2 });
  await settle(room);
  assert.equal(result.completed, DEFAULT_DISCUSSION_RUN_BUDGET);
});

// --- IPC 경계 ---

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
    models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
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

function makeFeature(root, extraOptions = {}) {
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
          return { canceled: true, filePaths: [] };
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

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("chat:discussion:start가 turnBudget을 실행까지 전달한다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-discussion-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  assert.equal(state.ok, true);
  const sessionId = state.activeSessionId;

  await feature.invoke("chat:send", { sessionId, text: "토론 주제입니다" });
  await waitFor(() => calls.length >= 3);
  calls.length = 0;

  const started = await feature.invoke("chat:discussion:start", {
    sessionId,
    agentIds: ["claude", "codex"],
    turnBudget: 4,
  });
  assert.equal(started.ok, true);

  await waitFor(() => calls.length >= 4);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 4);
  assert.match(calls[0].prompt, /자율 토론 1\/4턴/);
});

test("chat:discussion:start의 비정수 turnBudget은 기본 9턴 경로를 탄다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-discussion-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:send", { sessionId, text: "토론 주제입니다" });
  await waitFor(() => calls.length >= 3);
  calls.length = 0;

  await feature.invoke("chat:discussion:start", {
    sessionId,
    agentIds: ["claude", "codex"],
    turnBudget: "40",
  });
  await waitFor(() => calls.length >= 1);
  assert.match(calls[0].prompt, /자율 토론 1\/9턴/);
});
