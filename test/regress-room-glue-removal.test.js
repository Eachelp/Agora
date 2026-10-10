"use strict";

// 전문 모드 제거 S4 — 방·저장소·러너에서 전문 실행/상담 연결을 걷어낸 뒤에도
// 옛 세션 데이터는 그대로 읽히고, 대화는 잠기지 않는다.
// 진입점(createChatFeature + fake ipcMain, ChatRoom)으로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatRoom } = require("../src/chat/chat-room");
const { ChatStore } = require("../src/chat/chat-store");

function fakeRecord(id, name, aliases) {
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function makeFeature(root, calls) {
  const records = [fakeRecord("claude", "Claude", ["claude"]), fakeRecord("codex", "GPT", ["gpt", "codex"])];
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: "답변" }), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input) };
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// 옛 전문 실행이 meta.json에 남은 세션을 만들고 새 feature(앱 재시작)로 연다.
async function openLegacySession(legacy) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-glue-")));
  const created = await makeFeature(root, []).invoke("chat:projects:create", { name: "예전", workspace: null });
  const sessionId = created.session.meta.id;
  const metaPath = path.join(root, "sessions", sessionId, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  Object.assign(meta, legacy);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  const calls = [];
  return { feature: makeFeature(root, calls), calls, sessionId, metaPath, root };
}

test("RUNNING으로 남은 옛 전문 실행도 열기·전송 뒤 meta를 다시 쓰지 않고 대화는 잠기지 않는다", async () => {
  const legacy = { professionalRun: { schemaVersion: 1, professionalRunId: "pr-run", node: "IMPLEMENTING", status: "RUNNING" } };
  const { feature, calls, sessionId, metaPath } = await openLegacySession(legacy);
  const sent = await feature.invoke("chat:send", { sessionId, text: "@claude 안녕" });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => calls.length >= 1);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  // 예전에는 열 때 RUNNING을 INTERRUPTED로 바꿔 저장했다. 이제 그 필드는 읽고 무시한다.
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.deepEqual(meta.professionalRun, legacy.professionalRun);
});

test("pendingRecovery만 남은 옛 세션은 professionalRun으로 옮겨지지 않고 그대로 보존된다", async () => {
  const legacy = { pendingRecovery: { stage: "implementation", status: "blocked", checkpointId: "cp-old" } };
  const { feature, calls, sessionId, metaPath } = await openLegacySession(legacy);
  const sent = await feature.invoke("chat:send", { sessionId, text: "@gpt 이어서" });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => calls.length >= 1);
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.deepEqual(meta.pendingRecovery, legacy.pendingRecovery);
  assert.equal(meta.professionalRun, undefined, "옛 필드를 새 실행 상태로 바꾸지 않는다");
});

test("ChatStore는 옛 checkpoints·professional-events 폴더·파일을 건드리지 않는다", async () => {
  const { sessionId, root, feature } = await openLegacySession({});
  const dir = path.join(root, "sessions", sessionId);
  fs.mkdirSync(path.join(dir, "checkpoints", "cp-1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "checkpoints", "cp-1", "note.txt"), "keep", "utf8");
  fs.writeFileSync(path.join(dir, "professional-events.jsonl"), '{"type":"OLD"}\n', "utf8");
  const calls = [];
  const again = makeFeature(root, calls);
  await again.invoke("chat:send", { sessionId, text: "@claude 하나" });
  await waitFor(() => calls.length >= 1);
  assert.equal(fs.readFileSync(path.join(dir, "checkpoints", "cp-1", "note.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(dir, "professional-events.jsonl"), "utf8"), '{"type":"OLD"}\n');
  void feature;
});

test("방은 옛 professionalRun meta를 받아도 상태를 만들지 않고 recordOnly 같은 옛 옵션도 일반 전송으로 처리한다", async () => {
  const persisted = [];
  const calls = [];
  const room = new ChatRoom({
    agents: [{ id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true }],
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: "응답" }), cancel: () => {} };
    },
    meta: { professionalRun: { professionalRunId: "pr-x", node: "IMPLEMENTING", status: "BLOCKED" } },
    persistProfessionalRun: (run) => persisted.push(run),
  });
  // recordOnly는 응답을 예약하지 않고 메시지만 남기던 옛 경로였다. 이제 그런 경로는 없다.
  room.sendUserMessage({ text: "@claude 안녕", recordOnly: true });
  await room.waitForIdle();
  assert.equal(calls.length, 1, "옛 recordOnly로 응답이 조용히 사라지면 안 된다");
  assert.equal(persisted.length, 0, "옛 실행 상태를 다시 저장하지 않는다");
  for (const name of [
    "specialistState", "isSpecialistLocked", "resumeSpecialist", "cancelSpecialist",
    "consultRole", "consultTeam", "isConsultActive", "releaseConsultDeferred",
  ]) {
    assert.equal(typeof room[name], "undefined", `${name}은 없어졌다`);
  }
});

test("ChatStore.readMeta는 옛 필드를 읽기만 하고 만들어 내지 않는다", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-glue-store-")));
  const store = new ChatStore({ root });
  const meta = store.createSession({ title: "새 대화" });
  const created = store.readMeta(meta.id);
  assert.equal("professionalRun" in created, false);
  assert.equal("pendingRecovery" in created, false);
  assert.equal(typeof store.appendProfessionalEvent, "undefined");
  assert.equal(typeof store.readProfessionalEvents, "undefined");
  assert.equal(typeof store.checkpointsDir, "undefined");
});
