"use strict";

// 오케스트레이터 지휘 모델·노력·읽기 전용(2026-10-20)의 앱 쪽 IPC: 검증, 저장, 방 반영.
// 진입점은 createChatFeature + 가짜 ipcMain(orchestrator-ipc.test.js와 같은 방식).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeRecord(id, name, modelOptions) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: modelOptions.map((option) => option.id),
    modelOptions,
    efforts: ["medium", "high"], allowCustomModel: false, supportsImages: false,
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
  const records = [
    fakeRecord("claude", "Claude", [
      { id: "opus", label: "Opus", efforts: ["high", "max"] },
      { id: "sonnet", label: "Sonnet", efforts: ["medium", "high"] },
    ]),
    fakeRecord("codex", "Codex", [{ id: "gpt-6.1-sol", label: "Sol", efforts: ["high", "xhigh"] }]),
  ];
  const calls = [];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lead-")));
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
    runAgent: ({ agent, prompt, permissionMode }) => {
      const gate = Promise.withResolvers();
      const call = { agentId: agent.id, agent, prompt, permissionMode, finish: (text = "완료") => gate.resolve({ ok: true, text }) };
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
  env.set = (input) => invoke("chat:orchestrator:set", { sessionId: env.sessionId, ...input });
  env.session = async () => (await invoke("chat:state", { sessionId: env.sessionId })).session;
  env.systems = () => sent
    .filter((e) => e.channel === "chat:message" && e.payload?.message?.authorType === "system")
    .map((e) => e.payload.message.text);
  return env;
}

test("지휘 모델·노력·읽기 전용은 meta.orchestrator에 저장되고, 비운 값은 키를 만들지 않는다", async (t) => {
  const env = await setup(t);
  const ok = await env.set({ enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max", leadReadOnly: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.meta.orchestrator, { enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max", leadReadOnly: true });
  const plain = await env.set({ enabled: true, leadId: "claude", leadModel: "", leadEffort: null, leadReadOnly: false });
  assert.deepEqual(plain.meta.orchestrator, { enabled: true, leadId: "claude" });
});

test("지휘 AI 공급자의 모델 목록에 없는 모델과 그 모델이 지원하지 않는 노력 수준은 거절한다", async (t) => {
  const env = await setup(t);
  const badModel = await env.set({ enabled: true, leadId: "claude", leadModel: "gpt-6.1-sol" });
  assert.equal(badModel.ok, false);
  assert.match(badModel.error, /지휘 모델로 쓸 수 없는 모델/);
  const badEffort = await env.set({ enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "medium" });
  assert.equal(badEffort.ok, false);
  assert.match(badEffort.error, /쓸 수 없는 지휘 노력 수준/);
  const noModelEffort = await env.set({ enabled: true, leadId: "claude", leadEffort: "xhigh" });
  assert.equal(noModelEffort.ok, false, "모델을 정하지 않으면 참가자의 현재 모델 기준으로 본다");
  const session = await env.session();
  assert.equal(session.meta.orchestrator.enabled, false, "거절하면 아무것도 저장하지 않는다");
});

test("필드를 생략하면 저장값을 유지하고, 지휘 AI를 바꾸면 모델·노력은 비우되 읽기 전용은 유지한다", async (t) => {
  const env = await setup(t);
  await env.set({ enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max", leadReadOnly: true });
  const keep = await env.set({ enabled: true, leadId: "claude" });
  assert.deepEqual(keep.meta.orchestrator, { enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max", leadReadOnly: true });
  const moved = await env.set({ enabled: true, leadId: "codex" });
  assert.deepEqual(moved.meta.orchestrator, { enabled: true, leadId: "codex", leadReadOnly: true });
  const off = await env.set({ enabled: false, leadId: null });
  assert.deepEqual(off.meta.orchestrator, { enabled: false, leadId: null });
});

test("저장한 지휘 모델은 지휘 차례에만 쓰이고 작업자 차례는 참가자 설정 그대로 돈다", async (t) => {
  const env = await setup(t);
  await env.invoke("chat:agent:configure", { sessionId: env.sessionId, agentId: "claude", patch: { model: "sonnet", effort: "medium" } });
  await env.set({ enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 맡겨줘" });
  await settle();
  assert.equal(env.calls[0].agent.model, "opus");
  assert.equal(env.calls[0].agent.effort, "max");
  env.calls[0].finish("STAGE: @claude @codex");
  await settle();
  const selfWorker = env.calls.slice(1).find((call) => call.agentId === "claude");
  assert.ok(selfWorker, "지휘 모델을 정한 방에서는 지휘 AI 자신도 작업자로 불린다");
  assert.equal(selfWorker.agent.model, "sonnet");
  assert.equal(selfWorker.agent.effort, "medium");
});

test("진행 중에 지휘 모델·노력·읽기 전용을 바꿔도 오케스트레이션은 끝나지 않고, 지휘 AI를 바꾸면 끝난다", async (t) => {
  const env = await setup(t);
  await env.set({ enabled: true, leadId: "claude" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 맡겨줘" });
  await settle();
  env.calls[0].finish("STAGE: @codex");
  await settle();
  await env.set({ enabled: true, leadId: "claude", leadModel: "sonnet", leadReadOnly: true });
  await settle();
  assert.ok(!env.systems().some((text) => /오케스트레이션을 끝냅니다/.test(text)), "설정 변경은 오케스트레이션을 끝내지 않는다");
  await env.set({ enabled: true, leadId: "codex" });
  await settle();
  assert.ok(env.systems().some((text) => /지휘 AI를 바꿔서 오케스트레이션을 끝냅니다/.test(text)));
});
