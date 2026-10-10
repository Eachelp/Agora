"use strict";

// 다른 방을 보는 동안 승인 카드를 기다리는 방도 사이드바에 "실행 중"으로 보여야 한다.
// 승인 대기 중에는 실행 중인 턴(activeRuns)이 0이라 예전에는 idle로 보였다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

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

async function setup() {
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
  let calls = 0;
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {}, send() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
    },
    storeRoot: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-sbstatus-root-"))),
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: () => {
      calls += 1;
      const result = calls === 1
        ? { ok: false, approvalRequired: true, approval: { summary: "도구 실행 권한", detail: "파일 쓰기" } }
        : { ok: true, text: "완료" };
      return { promise: Promise.resolve(result), cancel() {} };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-sbstatus-ws-")));
  const a = (await invoke("chat:projects:create", { name: "권한", workspace })).session.meta.id;
  await invoke("chat:permission:set", { sessionId: a, mode: "workspace-write" });
  const b = (await invoke("chat:sessions:create", {})).session?.meta?.id;
  return { feature, invoke, sent, a, b, calls: () => calls };
}

// 마지막 sessions-changed 알림에서 한 방의 상태를 읽는다.
function statusOf(sent, sessionId) {
  const last = sent.filter((entry) => entry.channel === "chat:sessions-changed").pop();
  const rows = Object.values(last.payload.sessionsByProject || {}).flat();
  return rows.find((row) => row.id === sessionId)?.status;
}

test("승인 카드를 기다리는 방은 다른 방을 보는 중에도 사이드바에서 실행 중이고, 답하면 쉼으로 돌아온다", async () => {
  const env = await setup();
  assert.ok(env.b, "두 번째 방이 만들어져야 한다");
  await env.invoke("chat:send", { sessionId: env.a, text: "@claude 파일을 고쳐 줘" });
  await settle();
  assert.equal(env.sent.filter((e) => e.channel === "chat:approval-request").length, 1);
  assert.equal(statusOf(env.sent, env.a), "running", "승인 대기 방이 idle로 보이면 안 된다");

  const request = env.sent.find((e) => e.channel === "chat:approval-request").payload;
  assert.equal(request.sessionId, env.a);
  await env.invoke("chat:approval:respond", { sessionId: env.a, approvalId: request.approvalId, decision: "deny" });
  await settle();
  assert.equal(statusOf(env.sent, env.a), "idle", "거부해 끝난 방은 쉼으로 돌아온다");
});

test("승인 대기 중인 방을 중지하면 사이드바 상태가 쉼으로 돌아온다", async () => {
  const env = await setup();
  await env.invoke("chat:send", { sessionId: env.a, text: "@claude 파일을 고쳐 줘" });
  await settle();
  assert.equal(statusOf(env.sent, env.a), "running");
  await env.invoke("chat:stop", { sessionId: env.a });
  await settle();
  assert.equal(statusOf(env.sent, env.a), "idle");
});
