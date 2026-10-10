"use strict";

// 관리형 하네스를 걷어낸 뒤: 대화 턴은 주입된 HarnessAdapter(기본은 ProcessHarnessAdapter)로 바로 가고,
// 계정 전환 가드는 chat-ipc 안의 in-memory 가드가 맡는다. createChatFeature 입구로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatFeature } = require("../src/chat/chat-ipc");

function claudeRecord() {
  return {
    id: "claude", name: "Claude", color: "#333", aliases: ["claude"], status: "cli", reason: "",
    commandPath: "C:\\fake\\claude.exe", needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: [] }],
    efforts: [], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function startApp(root, harnessAdapter) {
  const handlers = new Map();
  const records = [claudeRecord()];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (c, h) => handlers.set(c, h), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class {}, shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
    harnessAdapter,
  });
  feature.registerIpcHandlers();
  return { feature, invoke: (c, i = {}) => handlers.get(c)({}, i) };
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("대화 턴은 주입된 adapter.runTurn({ invocation })으로 바로 가고 세션 문맥·승인 콜백·이미지 필드는 없다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-harness-direct-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const app = startApp(root, {
    runTurn: (request) => {
      calls.push(request);
      return { promise: Promise.resolve({ ok: true, text: "네." }), cancel: () => {} };
    },
  });
  t.after(() => app.feature.shutdown());

  const before = await app.invoke("chat:state");
  const sessionId = before.activeSessionId;
  const sent = await app.invoke("chat:send", { sessionId, text: "@claude 안녕" });
  assert.equal(sent.ok, true);
  await waitFor(() => calls.length >= 1);

  assert.deepEqual(Object.keys(calls[0]), ["invocation"], "context를 따로 넘기지 않는다");
  const invocation = calls[0].invocation;
  assert.equal(invocation.commandPath, "C:\\fake\\claude.exe");
  assert.ok(Array.isArray(invocation.argv));
  assert.equal("images" in invocation, false);
  assert.equal("requestApproval" in invocation, false);
});

test("종료(shutdown)는 adapter에 close가 없어도 던지지 않는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-harness-shutdown-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = startApp(root, { runTurn: () => ({ promise: Promise.resolve({ ok: true }), cancel: () => {} }) });
  assert.doesNotThrow(() => app.feature.shutdown());
});

test("계정 전환 가드: 같은 provider는 겹치지 못하고 다른 provider는 독립이며 complete 뒤에 다시 열린다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-harness-guard-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = startApp(root, { runTurn: () => ({ promise: Promise.resolve({ ok: true }), cancel: () => {} }) });

  const first = await app.feature.notifyProviderAccountChanged("codex");
  await assert.rejects(
    () => app.feature.notifyProviderAccountChanged("codex"),
    (error) => /계정 전환이 이미 진행 중/.test(error.message) && error.accountSwitchSafe === true
  );
  const other = await app.feature.notifyProviderAccountChanged("agy");
  other.complete();
  first.complete();
  const again = await app.feature.notifyProviderAccountChanged("codex");
  assert.equal(again.complete(), true);
});
