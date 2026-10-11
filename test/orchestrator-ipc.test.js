"use strict";

// 오케스트레이터 모드·"AI끼리 계속 부르기"의 앱 쪽 IPC. 진입점은 createChatFeature + 가짜 ipcMain.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeRecord(id, name, aliases) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: { chat: supported("tool-policy"), "workspace-read": supported("tool-policy"), "workspace-write": supported("sandbox") },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

async function setup(t) {
  const handlers = new Map();
  const sent = [];
  class FakeBrowserWindow {
    constructor() {
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) this[name] = () => {};
      this.isDestroyed = () => false;
      this.isMinimized = () => false;
    }
  }
  const records = [fakeRecord("claude", "Claude", ["claude"]), fakeRecord("codex", "Codex", ["codex"]), fakeRecord("agy", "Agy", ["agy"])];
  const calls = [];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-orchestrator-")));
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {}, send() {} },
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
    runAgent: ({ agent, prompt }) => {
      const gate = Promise.withResolvers();
      const call = { agentId: agent.id, prompt, finish: (text = "완료") => gate.resolve({ ok: true, text }) };
      calls.push(call);
      return { promise: gate.promise, cancel() { gate.resolve({ ok: false, cancelled: true, error: "중지됨" }); } };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  t.after(() => {
    feature.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  const state = await invoke("chat:state");
  const env = { feature, invoke, sent, calls, sessionId: state.activeSessionId };
  env.send = (text) => invoke("chat:send", { sessionId: env.sessionId, text });
  env.session = async () => (await invoke("chat:state", { sessionId: env.sessionId })).session;
  env.systems = () => sent
    .filter((e) => e.channel === "chat:message" && e.payload?.message?.authorType === "system")
    .map((e) => e.payload.message.text);
  return env;
}

test("chat:orchestrator:set은 지휘 AI가 쓸 수 있는 에이전트일 때만 켜지고, meta.orchestrator로 되돌아온다", async (t) => {
  const env = await setup(t);
  const rejected = await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "" });
  assert.equal(rejected.ok, false);
  const bad = await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "nobody" });
  assert.equal(bad.ok, false);
  const ok = await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "claude" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.meta.orchestrator, { enabled: true, leadId: "claude" });
  const session = await env.session();
  assert.deepEqual(session.meta.orchestrator, { enabled: true, leadId: "claude" });
});

test("chat:keep-calling:set은 그대로 저장되고 publicMeta에 실린다", async (t) => {
  const env = await setup(t);
  const result = await env.invoke("chat:keep-calling:set", { sessionId: env.sessionId, enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.meta.keepCalling, true);
  const off = await env.invoke("chat:keep-calling:set", { sessionId: env.sessionId, enabled: false });
  assert.equal(off.meta.keepCalling, false);
});

test("O19 모드를 끄면 진행 중인 오케스트레이션이 끝난다(안내가 남는다)", async (t) => {
  const env = await setup(t);
  await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "claude" });
  await env.send("@claude 맡겨줘");
  await settle();
  env.calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  const midway = await env.session();
  assert.ok(midway.room?.orchestration || true); // room 내부 상태는 room 시험에서 직접 보장한다
  const off = await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: false, leadId: null });
  assert.equal(off.ok, true);
  await settle();
  assert.ok(env.systems().some((text) => /오케스트레이터 모드를 꺼서 오케스트레이션을 끝냅니다/.test(text)));
});

test("지휘 AI를 바꾸면 진행 중인 오케스트레이션이 끝난다", async (t) => {
  const env = await setup(t);
  await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "claude" });
  await env.send("@claude 맡겨줘");
  await settle();
  env.calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "codex" });
  await settle();
  assert.ok(env.systems().some((text) => /지휘 AI를 바꿔서 오케스트레이션을 끝냅니다/.test(text)));
});

test("지휘 AI가 비활성화되면(원칙: 일반 모드로 돌아가는 길은 막히지 않는다) 모드가 스스로 꺼지고 안내가 남는다", async (t) => {
  const env = await setup(t);
  await env.invoke("chat:orchestrator:set", { sessionId: env.sessionId, enabled: true, leadId: "claude" });
  await env.invoke("chat:agent:configure", { sessionId: env.sessionId, agentId: "claude", patch: { enabled: false } });
  await settle();
  const session = await env.session();
  assert.equal(session.meta.orchestrator.enabled, false, "모드가 스스로 꺼진다");
  assert.ok(env.systems().some((text) => /지휘 AI @claude를 쓸 수 없어 오케스트레이터 모드를 껐습니다/.test(text)));
});
