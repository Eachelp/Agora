const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRoleMentions } = require("../src/chat/chat-mention");
const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "GPT", aliases: ["gpt", "codex"], available: true, enabled: true },
    { id: "agy", name: "Gemini", aliases: ["gemini", "agy"], available: true, enabled: true },
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

function teamSteps() {
  return [
    { roleId: "planner", stage: "planner", roleLabel: "기획자", agent: { id: "claude" } },
    { roleId: "reviewer", stage: "review", roleLabel: "검토자", agent: { id: "codex" } },
    { roleId: "builder", stage: "implementation", roleLabel: "구현자", agent: { id: "agy" } },
  ];
}

test("parseRoleMentions: @팀/@team을 team으로 인식한다", () => {
  assert.deepEqual(parseRoleMentions("@팀 이 설계 어떻게 봐?"), ["team"]);
  assert.deepEqual(parseRoleMentions("@team what do you think?"), ["team"]);
});

test("parseRoleMentions: @팀장·@팀원 같은 다른 단어는 팀 상담을 발동하지 않는다", () => {
  assert.deepEqual(parseRoleMentions("@팀장 회의 잡아줘"), []);
  assert.deepEqual(parseRoleMentions("@팀원들 모여봐"), []);
  assert.deepEqual(parseRoleMentions("@teams 채널에 올려줘"), []);
});

test("consultTeam은 기획자 → 검토자 → 구현자 순서로 한 명씩 답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: fakeRunner({}, calls),
  });
  const result = await room.consultTeam(teamSteps());
  await settle(room);

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "agy"],
  );
  // 전원 읽기 전용 — Builder 순서도 쓰기 권한이 없다.
  assert.deepEqual(
    calls.map((call) => call.permissionMode),
    ["workspace-read", "workspace-read", "workspace-read"],
  );
  // Professional Run이 만들어지지 않는다.
  assert.equal(room.professionalRun, null);
  const notices = room.messages.filter((message) => message.authorType === "system");
  assert.ok(notices.some((message) => /팀 상담 시작/.test(message.text)));
  assert.ok(notices.some((message) => /팀 상담을 마쳤습니다/.test(message.text)));
});

test("consultTeam은 중간 실패에서 멈춘다", async () => {
  const agents = makeAgents();
  agents[1].available = false; // 검토자 담당(codex) 사용 불가
  const calls = [];
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}, calls) });
  const result = await room.consultTeam(teamSteps());
  await settle(room);
  assert.equal(result.ok, false);
  // 기획자만 답하고 구현자 순서는 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("consultTeam이 중간에 막히면 이유를 채팅에 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt, attachments, permissionMode }) => {
      calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
      // 첫 순서(기획자)가 답하는 사이 사용자가 토론 시작을 눌렀다고 가정한다.
      room.discussionRequested = true;
      return { promise: Promise.resolve({ ok: true, text: "…" }), cancel: () => {} };
    },
  });
  const result = await room.consultTeam(teamSteps());
  await settle(room);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  const notice = room.messages.find(
    (message) => message.authorType === "system" && /팀 상담이 중간에 중단되었습니다/.test(message.text)
  );
  assert.ok(notice, "중간 중단 사유가 시스템 메시지로 남아야 합니다");
  assert.match(notice.text, /토론/);
});

test("consultTeam은 토론·전문 실행 중에는 시작하지 않는다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  room.discussionActive = true;
  assert.equal((await room.consultTeam(teamSteps())).ok, false);
  room.discussionActive = false;
  room.specialistActive = true;
  assert.equal((await room.consultTeam(teamSteps())).ok, false);
});

// --- IPC 라우팅 ---

function fakeRecord(id, name, aliases) {
  return {
    id,
    name,
    color: "#333333",
    aliases,
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
  const records = [
    fakeRecord("claude", "Claude", ["claude"]),
    fakeRecord("codex", "GPT", ["gpt", "codex"]),
    fakeRecord("agy", "Gemini", ["gemini", "agy"]),
  ];
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

test("chat:send의 @팀 멘션이 세 역할 순차 상담으로 라우팅된다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-team-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:projects:update", {
    projectId: state.activeProjectId,
    patch: {
      defaultRoles: {
        planning: { agentId: "claude" },
        review: { agentId: "codex" },
        implementation: { agentId: "agy" },
      },
    },
  });

  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@팀 이 설계를 어떻게 봐?",
  });
  assert.equal(sent.ok, true);
  await waitFor(() => calls.length >= 3);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "agy"]);
  assert.match(calls[0].prompt, /역할 상담: 기획자/);
  assert.match(calls[1].prompt, /역할 상담: 검토자/);
  assert.match(calls[2].prompt, /역할 상담: 구현자/);
  // 뒤 순서는 앞 상담 답변을 대화 기록으로 읽는다.
  assert.match(calls[1].prompt, /…|기획자/);
});

test("@팀은 역할 담당이 비면 시작하지 않고 안내를 남긴다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-team-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sent = await feature.invoke("chat:send", { sessionId, text: "@팀 어떻게 봐?" });
  assert.equal(sent.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0);

  const after = await feature.invoke("chat:state");
  assert.ok(
    after.session.messages.some(
      (message) =>
        message.authorType === "system" && /팀 상담을 시작하지 못했습니다/.test(message.text)
    )
  );
});
