"use strict";

// 방 이벤트(busy·approval-wait·message …)를 듣는 쪽의 저장 실패가 방(턴 시작·승인 카드·중지)으로
// 번지지 않는다. 진입점(createChatFeature + 가짜 ipcMain)에서 세션 meta.json 교체만 실패시킨다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatRoom } = require("../src/chat/chat-room");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
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

// meta.json 교체만 실패시킨다(디스크 가득·백신 잠금). 끄면 정상으로 돌아온다.
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

function setup({ approval = false } = {}) {
  const handlers = new Map();
  const sent = [];
  class FakeBrowserWindow {
    constructor() {
      this.webContents = { send: (channel, payload) => { sent.push({ channel, payload }); } };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) this[name] = () => {};
      this.isDestroyed = () => false;
      this.isMinimized = () => false;
    }
  }
  const records = [fakeRecord("claude", "Claude", ["claude"])];
  const calls = [];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {}, send() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
    },
    storeRoot: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-listener-root-"))),
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: () => {
      calls.push(calls.length);
      const result = approval && calls.length === 1
        ? { ok: false, approvalRequired: true, approval: { summary: "도구 실행 권한", detail: "파일 쓰기" } }
        : { ok: true, text: "완료" };
      return { promise: Promise.resolve(result), cancel() {} };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  return { feature, invoke, sent, calls };
}

async function newRoom(env) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-listener-ws-")));
  const created = await env.invoke("chat:projects:create", { name: "저장 실패", workspace });
  assert.equal(created.ok, true, created.error);
  const sessionId = created.session.meta.id;
  assert.equal((await env.invoke("chat:permission:set", { sessionId, mode: "workspace-write" })).ok, true);
  return sessionId;
}
const sessionOf = async (env, sessionId) => (await env.invoke("chat:state", { sessionId })).session;

test("meta.json 저장이 실패해도 chat:send는 에이전트를 실행하고, 입력 중·실행 표시가 남지 않아 방을 지울 수 있다", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const env = setup();
  const sessionId = await newRoom(env);
  failMeta = true;
  try {
    const sent = await env.invoke("chat:send", { sessionId, text: "@claude 안녕" });
    assert.equal(sent.ok, true, sent.error);
    await waitFor(() => env.calls.length >= 1);
    await settle();
    const session = await sessionOf(env, sessionId);
    assert.ok(session.messages.some((message) => message.author === "claude" && message.text === "완료"), "답이 방에 남는다");
    assert.deepEqual(session.typing, [], "입력 중 표시가 남지 않는다");
    assert.ok(warn.mock.calls.some((call) => /방 이벤트\(busy\)/.test(String(call.arguments[0]))), "실패는 기록으로만 남는다");
  } finally {
    failMeta = false;
  }
  // 중지도, 삭제도 막히지 않는다(liveRuns가 남으면 "답변 중인 작업이 아직 끝나지 않아" 로 거절된다).
  assert.equal((await env.invoke("chat:stop", { sessionId })).ok, true);
  const deleted = await env.invoke("chat:sessions:delete", { sessionId });
  assert.equal(deleted.ok, true, deleted.error);
});

async function pendingCard(env) {
  failMeta = false; // 방 만들기는 정상 저장으로, 그 뒤부터 실패시킨다.
  const sessionId = await newRoom(env);
  failMeta = true;
  assert.equal((await env.invoke("chat:send", { sessionId, text: "@claude 고쳐 줘" })).ok, true);
  await waitFor(() => env.calls.length >= 1);
  await settle();
  const [card] = (await sessionOf(env, sessionId)).pendingApprovals;
  assert.ok(card, "카드는 떠 있고 턴은 살아 있다");
  return { sessionId, card };
}

test("승인 카드가 떠 있을 때 저장이 실패해도 승인하면 같은 턴이 이어서 실행된다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const env = setup({ approval: true });
  try {
    const { sessionId, card } = await pendingCard(env);
    const answered = await env.invoke("chat:approval:respond", { sessionId, approvalId: card.approvalId, decision: "approve" });
    assert.equal(answered.ok, true, answered.error);
    await waitFor(() => env.calls.length >= 2);
    await settle();
    const after = await sessionOf(env, sessionId);
    assert.deepEqual(after.pendingApprovals, []);
    assert.ok(after.messages.some((message) => message.author === "claude" && message.text === "완료"));
  } finally {
    failMeta = false;
  }
});

test("승인 카드가 떠 있을 때 저장이 실패해도 거부·중지가 막히지 않고 삭제도 실행 표시에 걸리지 않는다", async (t) => {
  t.mock.method(console, "warn", () => {});
  try {
    const denyEnv = setup({ approval: true });
    const deny = await pendingCard(denyEnv);
    const denied = await denyEnv.invoke("chat:approval:respond", { sessionId: deny.sessionId, approvalId: deny.card.approvalId, decision: "deny" });
    assert.equal(denied.ok, true, denied.error);
    await settle();
    assert.deepEqual((await sessionOf(denyEnv, deny.sessionId)).pendingApprovals, []);

    const stopEnv = setup({ approval: true });
    const stop = await pendingCard(stopEnv);
    const stopped = await stopEnv.invoke("chat:stop", { sessionId: stop.sessionId });
    assert.equal(stopped.ok, true, stopped.error);
    const idle = await sessionOf(stopEnv, stop.sessionId);
    assert.deepEqual(idle.pendingApprovals, []);
    assert.equal(idle.turnState.current, null);
    assert.ok(stopEnv.sent.some((entry) => entry.channel === "chat:approval-resolved"), "열린 창의 카드는 거둬진다");
    failMeta = false;
    assert.equal((await stopEnv.invoke("chat:sessions:delete", { sessionId: stop.sessionId })).ok, true);

    const delEnv = setup({ approval: true });
    const del = await pendingCard(delEnv);
    // 저장소가 계속 실패하면 새 대화 만들기에서 삭제가 오류를 낼 수 있다. 그래도 승인 대기는 풀리고
    // 실행 표시가 남아 "답변 중인 작업이 아직 끝나지 않아" 로 거절되지는 않는다.
    const deleted = await delEnv.invoke("chat:sessions:delete", { sessionId: del.sessionId });
    assert.doesNotMatch(String(deleted.error || ""), /답변 중인 작업/);
    assert.ok(delEnv.sent.some((entry) => entry.channel === "chat:approval-resolved"));

  } finally {
    failMeta = false;
  }
});

test("방: 중지는 approval-wait 리스너가 던져도 실행 중인 프로세스를 먼저 취소하고 상태를 비운다", () => {
  let cancelled = 0;
  const room = new ChatRoom({
    sessionId: "s1",
    agents: [{ id: "claude", name: "C", aliases: ["claude"], available: true, enabled: true }],
    meta: { permissionMode: "workspace-write" },
    runAgent: () => ({ promise: new Promise(() => {}), cancel() {} }),
  });
  room.on("approval-wait", () => { throw new Error("disk"); });
  room.cancels.add(() => { cancelled += 1; });
  room.pendingApprovals.set("a1", { resolve() {}, payload: { approvalId: "a1" } });
  room.typingCounts.set("claude", 1);
  room.activeRuns = 1;
  assert.throws(() => room.stopAllSilently(), /disk/, "리스너 예외는 마지막 emit에서만 올라온다");
  assert.equal(cancelled, 1, "취소가 먼저 실행됐다");
  assert.equal(room.typingCounts.size, 0);
  assert.equal(room.activeRuns, 0);
  assert.equal(room.pendingApprovals.size, 0);
});
