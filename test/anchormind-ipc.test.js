"use strict";

// AnchorMind 기억 애드온이 main 쪽에서 이어지는 곳(방 열기·찾기·자동 저장·IPC 다섯 채널)을 진입점
// (createChatFeature + 가짜 ipcMain)에서 확인한다. 설계: docs/design/AGORA_PROPOSAL_2026-10-23_ANCHORMIND_ADDON.md.
// 시험 2만 진짜 입구(createAnchorMind)와 가짜 서버를 쓰고, 나머지는 같은 모양의 가짜 입구를 쓴다.
// 실제 AnchorMind(127.0.0.1:57332)와 Gemini는 부르지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { UNCATEGORIZED_PROJECT_ID } = require("../src/agora/project-store");
const { waitFor } = require("./question-helpers.cjs");
const { startFakeAnchorMind, createTestAnchorMind, memoryFragment } = require("./anchormind-helpers.cjs");

function fakeRecord(id, name, aliases) {
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: true, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

const CONCLUDE = "[[CODEPET_DISCUSSION:CONCLUDE]]";
const RECORD = JSON.stringify({
  summary: "배포는 승인을 받은 뒤에만 한다고 정했다.",
  decisions: [
    { title: "배포 규칙", content: "배포는 별도 승인 뒤에만 한다." },
    { title: "롤백", content: "문제가 생기면 바로 되돌린다." },
  ],
  nextActions: [],
});

// 실제 앱처럼 createChatFeature에 입구(anchorMind)를 넘긴다. 안 넘기면 기존 시험이 쓰는 모양이다.
// runAgent는 기록관 차례에만 RECORD를 주고, 받은 프롬프트를 prompts에 쌓는다. 창은 보낸 알림만 모은다.
function makeApp(t, anchorMind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-anchormind-ipc-")));
  const records = [fakeRecord("claude", "Claude", ["claude"]), fakeRecord("codex", "GPT", ["gpt", "codex"])];
  const handlers = new Map();
  const sent = [];
  const prompts = [];
  class FakeBrowserWindow {
    constructor() {
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
      this.isDestroyed = () => false;
      this.isMinimized = () => false;
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) this[name] = () => {};
    }
  }
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: ({ prompt }) => {
      prompts.push(prompt);
      return { promise: Promise.resolve({ ok: true, text: prompt.includes("토론 기록자") ? RECORD : `의견 ${CONCLUDE}` }), cancel: () => {} };
    },
    anchorMind,
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  t.after(() => {
    feature.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const outbound = (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  return {
    root,
    prompts,
    invoke: (channel, input = {}) => handlers.get(channel)({}, input),
    messages: () => outbound("chat:message").map((payload) => payload.message),
    notices: () => outbound("chat:system-notice").map((payload) => payload.text),
  };
}

// 입구와 같은 모양의 가짜. 부른 것을 calls에 쌓는다(status()는 뺀다).
function fakeAnchorMind() {
  const calls = [];
  const fake = {
    calls,
    enabled: true,
    failRemember: false,
    of: (name) => calls.filter((call) => call[0] === name),
    status: () => ({ enabled: fake.enabled, state: "connected" }),
    ensureStarted: async () => { calls.push(["ensureStarted"]); },
    recall: async (input) => { calls.push(["recall", input]); return { block: "- [결정] 배포는 승인 뒤에만 한다. (2026-10-24)", reason: null }; },
    remember: async (...args) => {
      calls.push(["remember", ...args]);
      if (fake.failRemember) throw new Error("AnchorMind가 꺼져 있습니다.");
    },
    list: async (projectId) => { calls.push(["list", projectId]); return [{ id: "m1", type: "fact", content: "배포는 승인 뒤에만 한다.", createdAt: "2026-10-24T12:00:00.000Z" }]; },
    forget: async (...args) => { calls.push(["forget", ...args]); },
    amend: async (...args) => { calls.push(["amend", ...args]); },
  };
  return fake;
}

// 새 프로젝트를 만들고 '기억 사용'과 기록 담당을 켠다.
async function enabledProject(app, name = "기억 시험") {
  const created = await app.invoke("chat:projects:create", { name });
  const projectId = created.activeProjectId;
  const updated = await app.invoke("chat:projects:update", { projectId, patch: { anchorMindEnabled: true, recordAgent: "claude" } });
  assert.equal(updated.ok, true, updated.error);
  return { projectId, sessionId: created.session.meta.id };
}

test("애드온이 꺼졌거나 기억을 쓰지 않는 방은 AnchorMind를 켜지도 부르지도 않는다", async (t) => {
  const fake = fakeAnchorMind();
  const app = makeApp(t, fake);
  const flagged = await enabledProject(app);
  const plain = await app.invoke("chat:projects:create", { name: "칸 없음" });
  // 방 1: 프로젝트 칸은 켰지만 애드온이 꺼져 있다. 방 2: 애드온은 켜졌지만 프로젝트 칸이 없다.
  // 시험할 방을 먼저 고른다. 고르기 전에 chat:state를 부르면 앞 방(칸 켬)이 열려 미리 깨우기가 정상으로 일어난다.
  let turns = 0;
  for (const [sessionId, enabled] of [[flagged.sessionId, false], [plain.session.meta.id, true]]) {
    fake.enabled = enabled;
    await app.invoke("chat:sessions:select", { sessionId });
    await app.invoke("chat:state");
    await app.invoke("chat:send", { sessionId, text: "@claude 배포는 언제 해도 돼?" });
    turns += 1;
    await waitFor(() => app.prompts.length >= turns, 4000);
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(app.prompts.some((prompt) => /AnchorMind/.test(prompt)), false);
});

test("기억을 쓰는 방은 열 때 AnchorMind를 미리 깨우고, 사용자 메시지마다 한 번 찾아 그 결과가 프롬프트에 들어간다", async (t) => {
  // 진짜 입구와 가짜 서버로 chat:send부터 프롬프트까지 이어서 본다(Gemini도 실제 서버도 쓰지 않는다).
  const fake = await startFakeAnchorMind(t, {
    tools: {
      recall: (args) => ({
        success: true,
        fragments: [memoryFragment(args.workspace, { type: "decision", content: "배포는 승인 뒤에만 한다." })],
        _meta: { evidence: { status: "supported" } },
      }),
    },
  });
  const app = makeApp(t, createTestAnchorMind(t, fake).client);
  const { projectId, sessionId } = await enabledProject(app);
  await app.invoke("chat:sessions:select", { sessionId });
  await waitFor(() => fake.calls.length > 0, 4000);   // 방을 열면 서버 확인이 간다
  assert.equal(fake.toolCalls("recall").length, 0);
  await app.invoke("chat:send", { sessionId, text: "@claude @gpt 배포는 언제 해도 돼?" });
  await waitFor(() => app.prompts.length >= 2, 4000);
  assert.equal(fake.toolCalls("recall").length, 1, "같은 메시지의 두 차례는 한 번 찾은 결과를 나눠 쓴다");
  const [{ args }] = fake.toolCalls("recall");
  assert.equal(args.workspace, `agora-${projectId}`);
  assert.match(args.text, /배포는 언제 해도 돼\?/);
  for (const prompt of app.prompts) {
    assert.match(prompt, /=== AnchorMind 기억 ===[\s\S]*- \[결정\] 배포는 승인 뒤에만 한다\./);
  }
});

test("'AnchorMind 기억 사용'은 다른 설정을 저장해도 남고, 기본 프로젝트(분류되지 않음)에서는 켤 수 없다", async (t) => {
  const app = makeApp(t, fakeAnchorMind());
  const { projectId } = await enabledProject(app);
  const file = path.join(app.root, "projects", `${projectId}.json`);
  const flag = () => JSON.parse(fs.readFileSync(file, "utf8")).anchorMindEnabled;
  assert.equal(flag(), true);
  await app.invoke("chat:projects:update", { projectId, patch: { name: "이름만 변경" } });
  assert.equal(flag(), true);
  await app.invoke("chat:projects:update", { projectId, patch: { anchorMindEnabled: "yes" } });
  assert.equal(flag(), true);
  const state = await app.invoke("chat:state");
  assert.equal(state.projects.find((entry) => entry.id === projectId).anchorMindEnabled, true);
  await app.invoke("chat:projects:update", { projectId, patch: { anchorMindEnabled: false } });
  assert.equal(flag(), false);
  const blocked = await app.invoke("chat:projects:update", { projectId: UNCATEGORIZED_PROJECT_ID, patch: { anchorMindEnabled: true } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /AnchorMind/);
});

test("기록관 요약은 기록할 때 에피소드로 남기고, 결정은 사람이 확정할 때(확정으로 만들 때 포함)만 남긴다", async (t) => {
  const fake = fakeAnchorMind();
  const app = makeApp(t, fake);
  const { projectId, sessionId } = await enabledProject(app);
  await app.invoke("chat:send", { sessionId, text: "@claude 배포 규칙을 정하자" });
  await waitFor(() => app.messages().some((message) => message.authorType === "agent"), 4000);
  const started = await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 4 });
  assert.equal(started.ok, true, started.error);
  await waitFor(() => fake.of("remember").length === 1, 4000);
  const [, rememberedIn, { idempotencyKey, ...episode }] = fake.of("remember")[0];
  assert.equal(rememberedIn, projectId);
  assert.deepEqual(episode, { type: "episode", content: "배포는 승인을 받은 뒤에만 한다고 정했다." });
  assert.match(idempotencyKey, /^agora-e-disc-\d+-[a-z0-9]+$/);

  // 기록관이 낸 후보는 아직 제안 상태다. 거부한 것은 보내지 않고, 승인한 것만 보낸다.
  const { workflow } = await app.invoke("chat:state");
  const rule = workflow.decisions.find((decision) => decision.title === "배포 규칙");
  const rollback = workflow.decisions.find((decision) => decision.title === "롤백");
  assert.deepEqual([rule.status, rollback.status], ["proposed", "proposed"]);
  assert.equal(fake.of("remember").length, 1);
  await app.invoke("chat:decisions:resolve", { projectId, ids: [rollback.id], action: "reject" });
  await app.invoke("chat:decisions:resolve", { projectId, ids: [rule.id], action: "approve" });
  await waitFor(() => fake.of("remember").length === 2, 4000);
  assert.deepEqual(fake.of("remember")[1], ["remember", projectId, {
    type: "decision", content: "배포 규칙: 배포는 별도 승인 뒤에만 한다.", idempotencyKey: `agora-d-${rule.id}`,
  }]);

  // 사람이 직접 만든 결정은 확정으로 저장되므로 만들 때 남는다.
  const created = await app.invoke("chat:decisions:create", { projectId, title: "", content: "릴리스 노트는 한국어로 쓴다." });
  await waitFor(() => fake.of("remember").length === 3, 4000);
  assert.deepEqual(fake.of("remember")[2], ["remember", projectId, {
    type: "decision", content: "릴리스 노트는 한국어로 쓴다.", idempotencyKey: `agora-d-${created.decision.id}`,
  }]);
});

test("자동 저장이 실패하면 다시 보내지 않고, 그 방에 한 번만 알린다(다시 성공하면 다음 실패를 또 알린다)", async (t) => {
  const fake = fakeAnchorMind();
  const app = makeApp(t, fake);
  const { projectId } = await enabledProject(app);
  let count = 0;
  const confirmDecision = async (failing) => {
    fake.failRemember = failing;
    count += 1;
    const result = await app.invoke("chat:decisions:create", { projectId, title: `결정 ${count}`, content: `내용 ${count}` });
    assert.equal(result.ok, true, result.error);
    await waitFor(() => fake.of("remember").length === count, 4000);
    await new Promise((resolve) => setImmediate(resolve));   // 실패 처리기가 돈 뒤에 안내를 센다
  };
  await confirmDecision(true);
  await confirmDecision(true);
  assert.equal(app.notices().length, 1);
  assert.match(app.notices()[0], /AnchorMind에 확정한 결정을 저장하지 못했습니다[\s\S]*꺼져 있습니다/);
  await confirmDecision(false);
  await confirmDecision(true);
  assert.equal(app.notices().length, 2);
  assert.equal(fake.of("remember").length, 4);
});

test("기억하기·목록·지우기·고치기는 기억을 쓰는 프로젝트에서 값을 그대로 넘기고, 입구가 없으면 꺼진 상태로만 답한다", async (t) => {
  const fake = fakeAnchorMind();
  const app = makeApp(t, fake);
  const { projectId, sessionId } = await enabledProject(app);
  await app.invoke("chat:send", { sessionId, text: "@claude 배포 규칙을 알려 줘" });
  await waitFor(() => app.messages().some((message) => message.authorType === "agent"), 4000);
  const user = app.messages().find((message) => message.authorType === "user");
  const agent = app.messages().find((message) => message.authorType === "agent");
  const handlerCalls = () => fake.calls.filter(([name]) => name !== "recall");
  const remember = (messageId, type, content) => app.invoke("chat:anchormind:remember", { sessionId, messageId, type, content });

  // 기록관 요약 유형과 없는 메시지는 입구에 닿기 전에 거절한다.
  assert.equal((await remember(user.id, "episode", "기록관 요약은 직접 만들 수 없다.")).ok, false);
  assert.equal((await remember("없는-메시지", "fact", "배포는 승인 뒤에만 한다.")).ok, false);
  assert.equal((await app.invoke("chat:anchormind:amend", { projectId, id: "m1", type: "episode", content: "기록관 요약으로 바꾸려는 시도입니다." })).ok, false);
  assert.deepEqual(handlerCalls(), []);

  assert.equal((await remember(user.id, "decision", "배포 규칙: 승인 뒤에만 배포한다.")).ok, true);
  assert.equal((await remember(agent.id, "fact", "배포는 승인 뒤에만 한다.")).ok, true);
  const listed = await app.invoke("chat:anchormind:list", { projectId });
  assert.deepEqual(listed.items.map((item) => item.id), ["m1"]);
  assert.equal((await app.invoke("chat:anchormind:forget", { projectId, id: "m1" })).ok, true);
  assert.equal((await app.invoke("chat:anchormind:amend", { projectId, id: "m1", type: "procedure", content: "배포 절차를 지킨다." })).ok, true);
  assert.deepEqual(handlerCalls(), [
    ["remember", projectId, { type: "decision", content: "배포 규칙: 승인 뒤에만 배포한다." }],
    ["remember", projectId, { type: "fact", content: "배포는 승인 뒤에만 한다." }],
    ["list", projectId],
    ["forget", projectId, "m1"],
    ["amend", projectId, "m1", { type: "procedure", content: "배포 절차를 지킨다." }],
  ]);
  assert.deepEqual(await app.invoke("chat:anchormind:status"), { ok: true, status: { enabled: true, state: "connected" } });

  // 프로젝트 칸이 없는 프로젝트에서는 네 채널 모두 거절하고 입구를 부르지 않는다.
  const plain = await app.invoke("chat:projects:create", { name: "칸 없음" });
  const attempts = [
    ["remember", { sessionId: plain.session.meta.id, messageId: user.id, type: "fact", content: "배포는 승인 뒤에만 한다." }],
    ["list", { projectId: plain.activeProjectId }],
    ["forget", { projectId: plain.activeProjectId, id: "m1" }],
    ["amend", { projectId: plain.activeProjectId, id: "m1", type: "fact", content: "배포는 승인 뒤에만 한다." }],
  ];
  const before = handlerCalls().length;
  for (const [channel, input] of attempts) {
    const result = await app.invoke(`chat:anchormind:${channel}`, input);
    assert.equal(result.ok, false, channel);
    assert.match(result.error, /AnchorMind 기억을 쓸 수 없습니다/);
  }
  assert.equal(handlerCalls().length, before);

  // 입구를 넘기지 않은 앱(기존 시험이 쓰는 모양)은 꺼진 상태로만 답한다.
  const bare = makeApp(t);
  assert.deepEqual(await bare.invoke("chat:anchormind:status"), { ok: true, status: { enabled: false, state: "off" } });
  assert.equal((await bare.invoke("chat:anchormind:list", { projectId: UNCATEGORIZED_PROJECT_ID })).ok, false);
});

test("preload·main.js 연결: 채널 이름, 입구 만들기와 넘기기, 종료 때 동기로 끄기", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const chatPreload = read("src/chat-preload.js");
  const main = read("src/main.js");
  for (const name of ["Status", "Remember", "List", "Forget", "Amend"]) {
    assert.match(chatPreload, new RegExp(`ANCHORMIND_${name.toUpperCase()}: "chat:anchormind:${name.toLowerCase()}"`));
    assert.match(chatPreload, new RegExp(`anchorMind${name}: \\([^)]*\\) =>\\s*ipcRenderer\\.invoke\\(INVOKE\\.ANCHORMIND_${name.toUpperCase()}[,)]`));
  }
  assert.match(chatPreload, /onAnchorMindStatus: \(handler\) => subscribe\("chat:anchormind-status", handler\)/);
  assert.match(read("src/settings-preload.js"), /ANCHORMIND: "settings:anchormind"[\s\S]*anchorMind: \(value\) => ipcRenderer\.invoke\(CHANNELS\.ANCHORMIND, value\)/);
  assert.match(main, /ipcMain\.handle\("settings:anchormind"/);
  assert.match(main, /webContents\.send\("chat:anchormind-status", status\)/);
  // 입구는 설정 파일 전체를 다루는 main.js의 함수로 만든다(anchorMind 칸만 넘기면 입구는 꺼진 채로 남는다).
  assert.match(main, /const anchorMind = createAnchorMind\(\{\s*getSettings: readSettings,\s*saveSettings: writeSettings,\s*storeRoot: defaultAgoraHome\(\),\s*onStatus: sendAnchorMindStatus,?\s*\}\);/);
  assert.match(main, /createChatFeature\(\{[\s\S]*?\n  anchorMind,\n\}\);/);
  assert.match(main, /patch\.anchorMind = \{ \.\.\.readSettings\(\)\.anchorMind, \.\.\.changed \};/);
  assert.match(main, /app\.on\("will-quit", \(\) => anchorMind\.stopOnQuitSync\(\)\);/);
  assert.match(main, /registerSessionEndTeardown\(app, \(\) => anchorMind\.stopOnQuitSync\(\)\);/);
});
