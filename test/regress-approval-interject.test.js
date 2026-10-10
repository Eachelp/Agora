"use strict";

// 권한 요청 카드가 떠 있는 동안 끼어들기(chat:turn:interject)를 하면 카드는 정확히 한 번
// approval-resolved로 닫히고, 그 뒤 늦은 응답은 거절된다. 보통의 승인/거부는 이 이벤트를
// 내지 않는다(카드는 사용자가 직접 닫는다). 진입점(createChatFeature + fake ipcMain)으로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function fakeRecord(id, name, aliases) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: supported("tool-policy"),
      "workspace-read": supported("tool-policy"),
      "workspace-write": supported("sandbox"),
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function setup() {
  const sent = [];
  const handlers = new Map();
  class FakeBrowserWindow {
    constructor() {
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) {
        this[name] = () => {};
      }
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
    storeRoot: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-approval-root-"))),
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    // 첫 실행은 권한이 필요하다고 답하고, 승인 뒤 다시 돌린 실행은 성공한다.
    runAgent: () => {
      calls.push(calls.length);
      const result = calls.length === 1
        ? { ok: false, approvalRequired: true, approval: { summary: "도구 실행 권한", detail: "파일 쓰기" } }
        : { ok: true, text: "완료" };
      return { promise: Promise.resolve(result), cancel() {} };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  return { invoke, sent, calls };
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

// 쓰기 권한 방에서 @claude를 불러 권한 요청 카드가 뜰 때까지 진행한다.
async function openApprovalCard() {
  const env = setup();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-approval-ws-")));
  const created = await env.invoke("chat:projects:create", { name: "권한", workspace });
  assert.equal(created.ok, true, created.error);
  const sessionId = created.session.meta.id;
  const mode = await env.invoke("chat:permission:set", { sessionId, mode: "workspace-write" });
  assert.equal(mode.ok, true, mode.error);
  const sent = await env.invoke("chat:send", { sessionId, text: "@claude 파일을 고쳐 줘" });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => env.sent.some((entry) => entry.channel === "chat:approval-request"));
  const request = env.sent.find((entry) => entry.channel === "chat:approval-request").payload;
  return { ...env, sessionId, approvalId: request.approvalId };
}

const resolvedEvents = (sent) => sent.filter((entry) => entry.channel === "chat:approval-resolved");

test("권한 카드가 떠 있을 때 끼어들면 approval-resolved가 정확히 한 번 나가고 늦은 응답은 거절된다", async () => {
  const { invoke, sent, calls, sessionId, approvalId } = await openApprovalCard();
  assert.equal(resolvedEvents(sent).length, 0);

  const interjected = await invoke("chat:turn:interject", { sessionId });
  assert.equal(interjected.ok, true, interjected.error);
  await settle();

  const events = resolvedEvents(sent);
  assert.equal(events.length, 1, "approval-resolved는 한 번만 나가야 합니다");
  assert.equal(events[0].payload.approvalId, approvalId);
  assert.equal(events[0].payload.sessionId, sessionId);

  const late = await invoke("chat:approval:respond", { sessionId, approvalId, decision: "approve" });
  assert.equal(late.ok, false);
  assert.match(late.error, /이미 처리되었거나 존재하지 않는 권한 요청/);
  await settle();
  assert.equal(calls.length, 1, "늦은 승인으로 다시 실행하면 안 됩니다");
  assert.equal(resolvedEvents(sent).length, 1, "늦은 응답이 이벤트를 더 만들면 안 됩니다");
});

test("보통의 승인은 approval-resolved를 내지 않고 다시 실행한다", async () => {
  const { invoke, sent, calls, sessionId, approvalId } = await openApprovalCard();
  const result = await invoke("chat:approval:respond", { sessionId, approvalId, decision: "approve" });
  assert.equal(result.ok, true, result.error);
  await waitFor(() => calls.length >= 2);
  await settle();
  assert.equal(resolvedEvents(sent).length, 0);
  // 같은 요청에 다시 답하면 거절된다.
  assert.equal((await invoke("chat:approval:respond", { sessionId, approvalId, decision: "approve" })).ok, false);
});

test("보통의 거부도 approval-resolved를 내지 않고 다시 실행하지 않는다", async () => {
  const { invoke, sent, calls, sessionId, approvalId } = await openApprovalCard();
  const result = await invoke("chat:approval:respond", { sessionId, approvalId, decision: "deny" });
  assert.equal(result.ok, true, result.error);
  await settle();
  assert.equal(resolvedEvents(sent).length, 0);
  assert.equal(calls.length, 1);
});
