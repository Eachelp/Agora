"use strict";

// 전문 모드 제거 S3 — 전문 모드 전용 IPC 채널·정책 게이트가 사라지고,
// 남은 채널(전송·토론·넘기기·중단·workflow)은 옛 전문 실행 상태와 무관하게 동작한다.
// 진입점(createChatFeature + fake ipcMain)으로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

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
  ];
  return {
    defs: records.map((record) => ({ id: record.id })),
    getRecord: (id) => records.find((record) => record.id === id) || null,
    discover: async () => records,
  };
}

function makeFeature(root, calls) {
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
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: "답변" }), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  return {
    has: (channel) => handlers.has(channel),
    channels: () => [...handlers.keys()],
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

const makeRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-ipc-removal-")));

// 옛 BLOCKED 전문 실행이 meta.json에 남은 세션을 새 feature(앱 재시작)로 연다.
async function openLegacySession() {
  const root = makeRoot();
  const first = makeFeature(root, []);
  const created = await first.invoke("chat:projects:create", { name: "예전 세션", workspace: null });
  const sessionId = created.session.meta.id;
  const metaPath = path.join(root, "sessions", sessionId, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.professionalRun = { schemaVersion: 1, professionalRunId: "pr-old", node: "IMPLEMENTING", status: "BLOCKED" };
  meta.pendingRecovery = { stage: "implementation", status: "blocked", checkpointId: "cp-old" };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  const calls = [];
  return { feature: makeFeature(root, calls), calls, sessionId };
}

test("전문 모드 전용 IPC 채널(chat:specialist:*, chat:task:*)은 등록되지 않는다", () => {
  const feature = makeFeature(makeRoot(), []);
  const leftovers = feature.channels().filter((name) => /^chat:(specialist|task):/.test(name));
  assert.deepEqual(leftovers, []);
  for (const gone of [
    "chat:specialist:start",
    "chat:specialist:resume",
    "chat:specialist:plan-answer",
    "chat:specialist:cancel",
    "chat:specialist:blocked",
    "chat:specialist:block-details",
    "chat:specialist:pending-approvals",
    "chat:specialist:record-input-retrieval",
    "chat:specialist:input-usage",
    "chat:specialist:resolve-approval",
    "chat:specialist:replan-blocked",
    "chat:task:open-file",
    "chat:task:read-file",
  ]) {
    assert.equal(feature.has(gone), false, gone);
  }
});

test("남기는 채널은 그대로 등록되어 있다", () => {
  const feature = makeFeature(makeRoot(), []);
  for (const kept of [
    "chat:send",
    "chat:stop",
    "chat:turn:interject",
    "chat:turn:cancel",
    "chat:awaiting:dismiss",
    "chat:discussion:start",
    "chat:discussion:summarize",
    "chat:message:handoff",
    "chat:approval:respond",
    "chat:permission:set",
    "chat:run-log:open-folder",
  ]) {
    assert.equal(feature.has(kept), true, kept);
  }
});

test("옛 professionalDraft 인자를 붙여도 기록만 하지 않고 일반 전송으로 에이전트가 답한다", async () => {
  const { feature, calls, sessionId } = await openLegacySession();
  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@claude 안녕",
    professionalDraft: true,
    professionalPolicy: { planAutoRevisions: 1 },
  });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => calls.length >= 1);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("옛 전문 실행이 남은 세션에서도 넘기기·중단·끼어들기 채널이 전문 실행 문구로 막히지 않는다", async () => {
  const { feature, calls, sessionId } = await openLegacySession();
  await feature.invoke("chat:send", { sessionId, text: "@claude 설명해줘" });
  let reply = null;
  for (let i = 0; i < 300 && !reply; i += 1) {
    const state = await feature.invoke("chat:state");
    reply = state.session.messages.find((m) => m.authorType === "agent") || null;
    if (!reply) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(reply, "에이전트 답변이 있어야 한다");

  const handoff = await feature.invoke("chat:message:handoff", {
    sessionId,
    targetAgentId: "codex",
    messageId: reply.id,
    intent: "CONTINUE",
  });
  assert.equal(handoff.ok, true, handoff.error);
  await waitFor(() => calls.some((call) => call.agentId === "codex"));

  const easy = await feature.invoke("chat:message:handoff", {
    sessionId,
    targetAgentId: "codex",
    messageId: reply.id,
    intent: "SIMPLIFY",
  });
  assert.equal(easy.ok, true, easy.error);

  assert.equal((await feature.invoke("chat:stop", { sessionId })).ok, true);
  const interjected = await feature.invoke("chat:turn:interject", { sessionId });
  assert.doesNotMatch(String(interjected?.error || ""), /전문 실행/);
});
