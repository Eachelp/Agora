"use strict";

// 전문 모드 제거 S1 — 옛 상태가 대화를 잠그지 않고, 옛 역할 호출은 안내만 받는다.
// 진입점(createChatFeature + fake ipcMain)으로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const NOTICE = "역할 호출·팀 실행은 없어졌습니다. @claude / @gpt / @gemini로 직접 부르거나 @모두를 쓰세요.";

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
    fakeRecord("agy", "Gemini", ["gemini", "agy"]),
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-compat-")));
}

// 옛 실행 상태가 meta.json에 남은 세션을 만들고, 새 feature(앱 재시작)로 연다.
async function openLegacySession(legacy) {
  const root = makeRoot();
  const first = makeFeature(root, []);
  const created = await first.invoke("chat:projects:create", { name: "예전 세션", workspace: null });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;
  const metaPath = path.join(root, "sessions", sessionId, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  Object.assign(meta, legacy);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  const calls = [];
  const feature = makeFeature(root, calls);
  return { feature, calls, sessionId, metaPath, legacy };
}

const LEGACY_SHAPES = {
  BLOCKED: {
    professionalRun: { schemaVersion: 1, professionalRunId: "pr-old", node: "IMPLEMENTING", status: "BLOCKED" },
    pendingRecovery: { stage: "implementation", status: "blocked", checkpointId: "cp-old" },
  },
  "READY/WAITING": {
    professionalRun: {
      schemaVersion: 1,
      professionalRunId: "pr-old2",
      node: "READY",
      status: "WAITING",
      taskPath: "TASK.md",
      stages: {},
      policy: {},
    },
  },
  "PLANNING/WAITING": {
    professionalRun: { schemaVersion: 1, professionalRunId: "pr-old3", node: "PLANNING", status: "WAITING", policy: {} },
  },
};

for (const [shape, legacy] of Object.entries(LEGACY_SHAPES)) {
  test(`예전 ${shape} 전문 실행이 남은 세션도 잠기지 않고 @claude가 답한다`, async () => {
    const { feature, calls, sessionId, metaPath } = await openLegacySession(legacy);

    const selected = await feature.invoke("chat:sessions:select", { sessionId });
    assert.equal(selected.ok, true);
    // 전문 실행 상태는 더 이상 화면으로 나가지 않는다 — 옛 실행이 대화를 잠그지 못한다.
    assert.equal(selected.session.specialist, undefined);

    const sent = await feature.invoke("chat:send", { sessionId, text: "@claude 안녕" });
    assert.equal(sent.ok, true, sent.error);
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);

    // 옛 필드는 읽지도 지우지도 않는다(파일은 그대로).
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.deepEqual(meta.professionalRun, legacy.professionalRun);
  });

  test(`예전 ${shape} 전문 실행이 남은 세션에서도 토론이 시작된다`, async () => {
    const { feature, calls, sessionId } = await openLegacySession(legacy);

    const started = await feature.invoke("chat:discussion:start", {
      sessionId,
      agentIds: ["claude", "codex"],
      turnBudget: 2,
    });
    assert.equal(started.ok, true, started.error);
    await waitFor(() => calls.length >= 2);
    assert.deepEqual([...new Set(calls.map((call) => call.agentId))].sort(), ["claude", "codex"]);
  });
}

for (const text of [
  "@팀 실행 로그인 기능 만들어줘",
  "@팀 이 설계 어떻게 봐?",
  "@기획자 이 구조 어때?",
  "@검토자 리스크 있어?",
  "@구현자 이거 만들어줘",
  "@기록자 정리해줘",
]) {
  test(`옛 역할 호출은 안내만 돌려주고 아무것도 저장·실행하지 않는다: ${text}`, async () => {
    const { feature, calls, sessionId, metaPath } = await openLegacySession(LEGACY_SHAPES.BLOCKED);
    const before = await feature.invoke("chat:state");
    const messagesBefore = before.session.messages.length;

    const sent = await feature.invoke("chat:send", { sessionId, text, professionalDraft: true });
    assert.equal(sent.ok, false);
    assert.equal(sent.error, NOTICE);
    await settle();

    assert.equal(calls.length, 0, "에이전트를 부르면 안 됩니다");
    const after = await feature.invoke("chat:state");
    assert.equal(after.session.messages.length, messagesBefore, "메시지도 시스템 안내도 저장하지 않는다");
    assert.equal(after.session.specialist, undefined, "전문 실행 상태를 만들지 않는다");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.deepEqual(meta.professionalRun, LEGACY_SHAPES.BLOCKED.professionalRun);

    // 다음 전송은 정상이다.
    const next = await feature.invoke("chat:send", { sessionId, text: "@gpt 이어서 얘기하자" });
    assert.equal(next.ok, true, next.error);
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  });
}

test("에이전트 멘션이 함께 있으면 그 호출은 기존대로 간다", async () => {
  const { feature, calls, sessionId } = await openLegacySession(LEGACY_SHAPES.BLOCKED);
  const sent = await feature.invoke("chat:send", { sessionId, text: "@claude 그리고 @기획자 관점도 궁금해" });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => calls.length >= 1);
  await settle();
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("@팀장 같은 다른 단어와 일반 메시지는 안내 대상이 아니다", async () => {
  const { feature, calls, sessionId } = await openLegacySession(LEGACY_SHAPES.BLOCKED);
  const sent = await feature.invoke("chat:send", { sessionId, text: "@팀장 회의 @gemini 의견은?" });
  assert.equal(sent.ok, true, sent.error);
  await waitFor(() => calls.length >= 1);
  assert.deepEqual(calls.map((call) => call.agentId), ["agy"]);
});
