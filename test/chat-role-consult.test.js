const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseMentions,
  parseRoleMentions,
  ROLE_ALIASES,
} = require("../src/chat/chat-mention");
const { GROUP_ALIASES } = require("../src/chat/chat-agents");
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

// --- 역할 멘션 파싱 ---

test("parseRoleMentions: 역할 별칭을 한국어·영어로 인식한다", () => {
  assert.deepEqual(parseRoleMentions("@기획자 이 구조 괜찮아?"), ["planner"]);
  assert.deepEqual(parseRoleMentions("@planner 계획 관점에서 봐줘"), ["planner"]);
  assert.deepEqual(parseRoleMentions("@구현자 이 코드가 왜 이래?"), ["builder"]);
  assert.deepEqual(parseRoleMentions("@검토자 리스크 있어?"), ["reviewer"]);
  assert.deepEqual(parseRoleMentions("@검수자 봐줘"), ["reviewer"]);
  assert.deepEqual(parseRoleMentions("@기록자 정리해줘"), ["recorder"]);
});

test("parseRoleMentions: 조사 허용·코드펜스 무시·미지 토큰 무시", () => {
  assert.deepEqual(parseRoleMentions("@기획자야 어때?"), ["planner"]);
  assert.deepEqual(parseRoleMentions("```\n@기획자\n```"), []);
  assert.deepEqual(parseRoleMentions("@Planner2 어때?"), []);
  assert.deepEqual(parseRoleMentions("메일은 a@기획자.com 입니다"), []);
  assert.deepEqual(parseRoleMentions("역할 없음"), []);
});

test("역할 별칭은 provider·group 별칭과 겹치지 않는다", () => {
  const providerAliases = ["claude", "gpt", "codex", "gemini", "agy", "antigravity"];
  for (const aliases of Object.values(ROLE_ALIASES)) {
    for (const alias of aliases) {
      assert.ok(!providerAliases.includes(alias), alias);
      assert.ok(!GROUP_ALIASES.includes(alias), alias);
    }
  }
});

test("provider 멘션 해석은 역할 멘션 추가 후에도 그대로다", () => {
  const agents = makeAgents();
  assert.deepEqual(parseMentions("@기획자 어때?", agents, GROUP_ALIASES), []);
  assert.deepEqual(parseMentions("@claude 어때?", agents, GROUP_ALIASES), ["claude"]);
  assert.deepEqual(
    parseMentions("@모두 어때?", agents, GROUP_ALIASES),
    ["claude", "codex", "agy"],
  );
});

// --- ChatRoom.consultRole ---

test("consultRole은 읽기 전용 단일 응답을 만든다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: fakeRunner({}, calls),
  });
  const result = await room.consultRole({
    roleId: "builder",
    stage: "implementation",
    roleLabel: "구현자",
    agent: { id: "codex" },
  });
  await settle(room);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "codex");
  // Builder stage cap이 write여도 CONSULT는 read로 강등된다(INV-3).
  assert.equal(calls[0].permissionMode, "workspace-read");
  assert.match(calls[0].prompt, /역할 상담: 구현자/);
  assert.match(calls[0].prompt, /실행 승인이 아닙니다/);
  assert.match(calls[0].prompt, /PLAN → 실행 경로/);
  // 시작 안내 시스템 메시지.
  assert.ok(
    room.messages.some(
      (message) => message.authorType === "system" && /읽기 전용 상담/.test(message.text)
    )
  );
});

test("consultRole은 질문의 첨부를 상담 턴에 전달한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({}, calls),
  });
  const attachment = { id: "att-1", fileName: "diagram.png" };
  await room.consultRole({
    roleId: "planner",
    stage: "planner",
    roleLabel: "기획자",
    agent: { id: "claude" },
    attachments: [attachment],
  });
  await settle(room);
  assert.deepEqual(calls[0].attachments, [attachment]);
});

test("consultRole은 Role Invocation을 Journal에 남긴다", async () => {
  const appended = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({}),
    appendProfessionalEvent: (event) => {
      appended.push(event);
      return true;
    },
  });
  await room.consultRole({
    roleId: "builder",
    stage: "implementation",
    roleLabel: "구현자",
    agent: { id: "codex" },
  });
  await settle(room);
  assert.deepEqual(
    appended.map((event) => [event.type, event.role, event.purpose, event.status]),
    [
      ["ROLE_STARTED", "builder", "consult", null],
      ["ROLE_FINISHED", "builder", "consult", "DONE"],
    ],
  );
});

test("consultRole은 배타적 workspace mutation lease를 잡지 않는다", async () => {
  const leaseCalls = [];
  const mutationLease = {
    acquire(request) {
      leaseCalls.push(request);
      return { ok: true, token: `t${leaseCalls.length}` };
    },
    release: () => true,
  };
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace: "/tmp/agora-lease-test" },
    mutationLease,
    runAgent: fakeRunner({}, calls),
  });

  // 일반 workspace-write 턴은 lease를 잡는다(스텁 동작 확인).
  room.sendUserMessage("@claude 파일 좀 봐줘");
  await settle(room);
  assert.equal(leaseCalls.length, 1);

  // 읽기 전용 상담은 mutation 참여자가 아니므로 lease를 잡지 않아야 한다.
  leaseCalls.length = 0;
  const result = await room.consultRole({
    roleId: "builder",
    stage: "implementation",
    roleLabel: "구현자",
    agent: { id: "codex" },
  });
  await settle(room);
  assert.equal(result.ok, true);
  assert.equal(leaseCalls.length, 0, "CONSULT 턴이 workspace lease를 잡으면 안 됩니다");
});

test("consultRole은 세션 권한보다 높은 권한을 얻지 못한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "chat" },
    runAgent: fakeRunner({}, calls),
  });
  await room.consultRole({
    roleId: "builder",
    stage: "implementation",
    roleLabel: "구현자",
    agent: { id: "codex" },
  });
  await settle(room);
  assert.equal(calls[0].permissionMode, "chat");
});

test("recorder 상담은 chat 권한으로 실행된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: fakeRunner({}, calls),
  });
  await room.consultRole({
    roleId: "recorder",
    stage: "recorder",
    roleLabel: "기록자",
    agent: { id: "agy" },
  });
  await settle(room);
  assert.equal(calls[0].permissionMode, "chat");
});

test("consultRole 응답은 멘션 연쇄를 만들지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      { codex: [{ ok: true, text: "@claude 네 생각은 어때?" }] },
      calls
    ),
  });
  await room.consultRole({
    roleId: "reviewer",
    stage: "review",
    roleLabel: "검토자",
    agent: { id: "codex" },
  });
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
});

test("consultRole은 토론·전문 실행 중에는 거부한다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  room.discussionActive = true;
  const duringDiscussion = await room.consultRole({
    roleId: "planner",
    stage: "planner",
    agent: { id: "claude" },
  });
  assert.equal(duringDiscussion.ok, false);
  assert.match(duringDiscussion.error, /토론/);
  room.discussionActive = false;
  room.specialistActive = true;
  const duringSpecialist = await room.consultRole({
    roleId: "planner",
    stage: "planner",
    agent: { id: "claude" },
  });
  assert.equal(duringSpecialist.ok, false);
  assert.match(duringSpecialist.error, /전문 실행/);
});

test("consultRole은 사용할 수 없는 담당자를 거부한다", async () => {
  const agents = makeAgents();
  agents[1].available = false;
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  const result = await room.consultRole({
    roleId: "builder",
    stage: "implementation",
    agent: { id: "codex" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /사용할 수 없습니다/);
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

test("chat:send의 역할 멘션은 담당자 상담으로 라우팅된다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  // 검토 역할 담당자를 codex로 지정한다.
  const projectId = state.activeProjectId;
  await feature.invoke("chat:projects:update", {
    projectId,
    patch: { defaultRoles: { review: { agentId: "codex" } } },
  });

  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@검토자 이 설계에 리스크가 있어?",
  });
  assert.equal(sent.ok, true);
  await waitFor(() => calls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 브로드캐스트가 아니라 검토 담당자 1명만 응답한다.
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  assert.match(calls[0].prompt, /역할 상담: 검토자/);
});

test("역할 담당자가 없으면 조용히 무시하지 않고 안내를 남긴다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@기획자 이 구조 어때?",
  });
  assert.equal(sent.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0, "담당자 없는 역할 멘션이 브로드캐스트되면 안 됩니다");

  const after = await feature.invoke("chat:state");
  const systemNotice = after.session.messages.find(
    (message) => message.authorType === "system" && /기획자 상담을 시작하지 못했습니다/.test(message.text)
  );
  assert.ok(systemNotice, "시작 실패 안내가 채팅에 남아야 합니다");
});

test("professionalDraft가 켜져 있어도 방이 놀고 있으면 역할 멘션은 상담으로 간다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:projects:update", {
    projectId: state.activeProjectId,
    patch: { defaultRoles: { review: { agentId: "codex" } } },
  });

  // 전문 실행이 한 번 살아난 세션의 렌더러는 이후 모든 전송에
  // professionalDraft=true를 붙인다. 실행이 끝난(놀고 있는) 방에서는 그래도
  // 역할 멘션이 CONSULT로 라우팅되어야 한다 — 플래그만 보고 막으면 역할
  // 멘션이 설계된 문맥에서 기능이 영구히 죽는다.
  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@검토자 이 계획 리스크 있어?",
    professionalDraft: true,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.consult, true, "상담 라우팅 여부를 렌더러에 알려야 합니다");
  await waitFor(() => calls.length >= 1);
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  assert.match(calls[0].prompt, /역할 상담: 검토자/);
});

test("professionalDraft 메모(역할 멘션 없음)는 여전히 기록만 한다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "다음 계획에서 로그인 흐름을 고려해줘",
    professionalDraft: true,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.consult, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0, "메모는 어떤 응답도 예약하지 않아야 합니다");
});

test("agent 멘션이 함께 있으면 기존 동작이 우선한다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:send", {
    sessionId,
    text: "@claude 그리고 @기획자 관점도 궁금해",
  });
  await waitFor(() => calls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // @claude가 있으므로 역할 라우팅이 아니라 기존 멘션 응답이다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  assert.ok(!/역할 상담/.test(calls[0].prompt));
});

test("여러 역할을 함께 멘션하면 첫 역할만 답하고 제외 안내를 남긴다", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-consult-ipc-multi-")));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:projects:update", {
    projectId: state.activeProjectId,
    patch: { defaultRoles: { planning: { agentId: "claude" }, review: { agentId: "codex" } } },
  });

  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@검토자 @기획자 이 설계 어때?",
  });
  assert.equal(sent.ok, true);
  await waitFor(() => calls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 첫 역할(검토자) 담당자만 답한다 — 브로드캐스트도, 두 번째 상담도 아니다.
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  const after = await feature.invoke("chat:state");
  const notice = after.session.messages.find(
    (message) => message.authorType === "system" && /한 번에 한 명만/.test(message.text)
  );
  assert.ok(notice, "제외된 역할 안내가 채팅에 남아야 합니다");
  assert.match(notice.text, /검토자만 응답하며/);
  assert.match(notice.text, /기획자.*이번에 제외/);
  assert.match(notice.text, /@팀/);
  // 안내는 상담이 실제로 시작된 뒤에 남는다(시작 실패 안내보다 먼저 오지 않는다).
  const messages = after.session.messages;
  const consultReply = messages.findIndex((message) => message.authorType === "agent");
  const noticeIndex = messages.indexOf(notice);
  assert.ok(consultReply >= 0);
  assert.ok(!messages.some((message) => /상담을 시작하지 못했습니다/.test(message.text || "")));
  assert.ok(noticeIndex >= 0);

  // 첫 역할 시작이 실패하면 제외 안내는 남지 않는다 — "구현자만 응답하며…"
  // 뒤에 "시작하지 못했습니다"가 이어지는 모순을 막는다.
  calls.length = 0;
  const failed = await feature.invoke("chat:send", {
    sessionId,
    text: "@구현자 @검토자 이건 왜 느려?",
  });
  assert.equal(failed.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0);
  const afterFailed = await feature.invoke("chat:state");
  const texts = afterFailed.session.messages
    .filter((message) => message.authorType === "system")
    .map((message) => message.text);
  assert.ok(texts.some((text) => /구현자 상담을 시작하지 못했습니다/.test(text)), texts.join(" | "));
  assert.equal(texts.filter((text) => /한 번에 한 명만/.test(text)).length, 1);
});
