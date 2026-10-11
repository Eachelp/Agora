"use strict";

// 바로 답하기의 앱 쪽 전체 흐름(S11·S19·S25). 진입점은 createChatFeature + 가짜 ipcMain이고
// CLI 자리에는 시험이 약속을 푸는 가짜 러너를 둔다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

// 메시지 저장(meta.json 교체)만 실패시킬 수 있다. 방 이벤트 리스너의 저장 실패가 스케줄러로 번지지 않는지 본다.
const realRename = fs.renameSync;
let failMeta = false;
fs.renameSync = function patchedRename(from, to, ...rest) {
  if (failMeta && String(to).endsWith("meta.json")) {
    const error = new Error("ENOSPC: no space left on device");
    error.code = "ENOSPC";
    throw error;
  }
  return realRename.call(fs, from, to, ...rest);
};
test.after(() => { fs.renameSync = realRename; });

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-replynow-")));
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
      const call = {
        agentId: agent.id, prompt, cancelled: false, holdCancel: false,
        finish: (text = "완료") => gate.resolve({ ok: true, text }),
        endCancelled: () => gate.resolve({ ok: false, cancelled: true, error: "중지됨" }),
      };
      calls.push(call);
      return {
        promise: gate.promise,
        cancel() {
          call.cancelled = true;
          if (!call.holdCancel) call.endCancelled();
        },
      };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  t.after(() => {
    failMeta = false;
    feature.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  const state = await invoke("chat:state");
  const env = { feature, invoke, sent, calls, sessionId: state.activeSessionId };
  env.send = (text, extra = {}) => invoke("chat:send", { sessionId: env.sessionId, text, ...extra });
  env.session = async () => (await invoke("chat:state", { sessionId: env.sessionId })).session;
  env.turnState = async () => (await env.session()).turnState;
  return env;
}

const label = (turn) => `${turn.agentId}${turn.fast ? "*" : ""}`;

test("S19 chat:send 연속: 도는 중인 모델에게는 빠른 대기, 다른 모델은 바로 시작하고, 상태 스냅숏과 이벤트에 running과 queue[].fast가 나온다", async (t) => {
  const env = await setup(t);
  assert.equal((await env.send("@claude 하나")).ok, true);
  assert.equal((await env.send("@claude 둘")).ok, true);
  assert.equal((await env.send("@codex 셋")).ok, true);
  await waitFor(() => env.calls.length === 2);
  assert.deepEqual(env.calls.map((call) => call.agentId), ["claude", "codex"]);
  const turns = await env.turnState();
  assert.deepEqual([...turns.running].sort(), ["claude", "codex"]);
  assert.deepEqual(turns.queue.map(label), ["claude*"]);
  // 창을 닫았다 다시 붙으면 같은 스냅숏을 받는다.
  const again = await env.turnState();
  assert.deepEqual(again, turns);
  const events = env.sent.filter((entry) => entry.channel === "chat:turn-state").map((entry) => entry.payload);
  assert.ok(events.some((payload) => payload.queue.some((turn) => turn.fast === true)), "대기 항목의 fast가 화면에 간다");
  assert.ok(events.some((payload) => payload.running.length === 2), "동시에 도는 턴이 둘로 보인다");

  env.calls[0].finish("첫 답");
  await waitFor(() => env.calls.length === 3);
  assert.equal(env.calls[2].agentId, "claude", "첫 claude가 끝난 순간 빠른 claude가 시작");
  env.calls[1].finish();
  env.calls[2].finish();
  await settle();
  assert.deepEqual(await env.turnState(), { current: null, running: [], queue: [], deferred: [] });
});

test("S19 chat:turn:cancel은 빠른 대기 항목 하나만 취소하고 안내를 남기지 않으며, 시작한 턴·없는 턴은 거절한다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 하나");
  await env.send("@claude 둘");
  await settle();
  const [queued] = (await env.turnState()).queue;
  assert.equal(queued.fast, true);
  const cancelled = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: queued.turnId });
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.deepEqual((await env.turnState()).queue, []);
  const again = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: queued.turnId });
  assert.equal(again.ok, false);
  const running = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: "t1" });
  assert.equal(running.ok, false);
  const systems = (await env.session()).messages.filter((message) => message.authorType === "system");
  assert.deepEqual(systems, [], "×로 지운 턴에는 안내가 없다");
  env.calls[0].finish();
  await settle();
  assert.equal(env.calls.length, 1, "취소한 턴은 시작하지 않는다");
});

test("S11 chat:stop은 돌고 있는 빠른 턴과 대기 중인 빠른 턴을 모두 정리하고 '전달되지 않았으니 다시 보내 주세요'에 센다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 하나");
  await env.send("@codex 둘");
  await env.send("@claude 셋");
  await settle();
  assert.equal((await env.turnState()).running.length, 2);
  assert.equal((await env.turnState()).queue.length, 1);
  const stopped = await env.invoke("chat:stop", { sessionId: env.sessionId });
  assert.equal(stopped.ok, true, stopped.error);
  const session = await env.session();
  assert.deepEqual(session.turnState, { current: null, running: [], queue: [], deferred: [] });
  const note = session.messages.filter((message) => message.authorType === "system").map((message) => message.text).join("\n");
  assert.match(note, /응답을 중지했습니다\. 대기 중이던 메시지 1개는 전달되지 않았으니/);
  await settle();
  assert.equal(env.calls.length, 2, "중지 뒤에는 아무것도 새로 시작하지 않는다");
  assert.deepEqual(session.typing, []);
});

test("S11 chat:turn:interject(잠깐)도 같은 정리를 하고 방은 곧바로 새 메시지를 받는다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 하나");
  await env.send("@claude 둘");
  await settle();
  const result = await env.invoke("chat:turn:interject", { sessionId: env.sessionId });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(await env.turnState(), { current: null, running: [], queue: [], deferred: [] });
  await env.send("@claude 다시");
  await settle();
  assert.equal(env.calls.length, 2, "취소한 프로세스는 곧 끝났으니 같은 담당자의 새 턴이 시작한다");
});

test("S25 중지한 프로세스가 아직 끝나지 않아도 다른 담당자는 즉시 시작하고, 옛 프로세스의 종료는 입력 중·실행 표시를 깎지 않는다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 오래 걸리는 일");
  await waitFor(() => env.calls.length === 1);
  env.calls[0].holdCancel = true;
  await env.invoke("chat:stop", { sessionId: env.sessionId });
  await env.send("@codex 안녕");
  await waitFor(() => env.calls.length === 2);
  await env.send("@claude 또");
  await settle();
  assert.equal(env.calls.length, 2, "취소 중인 claude 프로세스가 끝나기 전에는 같은 담당자가 시작하지 않는다");
  env.calls[0].endCancelled();
  await waitFor(() => env.calls.length === 3);
  assert.deepEqual(env.calls.map((call) => call.agentId), ["claude", "codex", "claude"]);
  const statuses = () => {
    const last = env.sent.filter((entry) => entry.channel === "chat:sessions-changed").pop();
    return Object.values(last.payload.sessionsByProject || {}).flat().find((row) => row.id === env.sessionId)?.status;
  };
  assert.equal(statuses(), "running", "새 claude와 codex가 도는 동안 옛 프로세스가 끝나도 실행 표시가 남는다");
  env.calls[1].finish();
  env.calls[2].finish();
  await settle();
  const deleted = await env.invoke("chat:sessions:delete", { sessionId: env.sessionId });
  assert.equal(deleted.ok, true, deleted.error);
});

test("S11 대화 삭제: 돌고 있는 턴과 대기 중인 빠른 턴이 있어도 지울 수 있고, 지운 뒤에는 아무것도 시작하지 않는다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 하나");
  await env.send("@claude 둘");
  await env.send("@codex 셋");
  await settle();
  const before = env.calls.length;
  const deleted = await env.invoke("chat:sessions:delete", { sessionId: env.sessionId });
  assert.equal(deleted.ok, true, deleted.error);
  await settle();
  assert.equal(env.calls.length, before);
});

test("S11 앱 종료(shutdown): 빠른 대기 항목까지 정리하고 종료 뒤 새 턴을 시작하지 않는다", async (t) => {
  const env = await setup(t);
  await env.send("@claude 하나");
  await env.send("@claude 둘");
  await settle();
  const before = env.calls.length;
  env.feature.shutdown();
  env.calls[0].finish();
  await settle();
  assert.equal(env.calls.length, before);
});

test("저장이 실패해도(메시지 리스너 예외) 빠른 턴은 시작·종료되고 방을 지울 수 있다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const env = await setup(t);
  failMeta = true;
  try {
    await env.send("@claude 하나");
    await env.send("@claude 둘");
    await env.send("@codex 셋");
    await settle();
    assert.equal(env.calls.length, 2);
    env.calls[0].finish("첫 답");
    await waitFor(() => env.calls.length === 3);
    env.calls[1].finish();
    env.calls[2].finish();
    await settle();
  } finally {
    failMeta = false;
  }
  const session = await env.session();
  assert.deepEqual(session.turnState, { current: null, running: [], queue: [], deferred: [] });
  assert.deepEqual(session.typing, []);
  assert.equal((await env.invoke("chat:sessions:delete", { sessionId: env.sessionId })).ok, true);
});
