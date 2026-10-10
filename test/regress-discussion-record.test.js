"use strict";

// 토론 자동 기록은 v1.1.1처럼 "기록 담당을 정한 프로젝트에서만" 돈다.
// 담당: 프로젝트 recordAgent(id, ""은 끔) > 옛 defaultRoles.recorder > 옛 defaultRoles.review > 없음.
// 진입점(createChatFeature + fake ipcMain + fake runner)으로 확인한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function fakeRecord(id, name, aliases) {
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: true, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

const CONCLUDE = "[[CODEPET_DISCUSSION:CONCLUDE]]";
const isRecord = (prompt) => prompt.includes("토론 기록자");

function makeFeature(root, calls) {
  const records = [
    fakeRecord("claude", "Claude", ["claude"]),
    fakeRecord("codex", "GPT", ["gpt", "codex"]),
    fakeRecord("agy", "AGY", ["agy"]),
  ];
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
      calls.push({ agentId: agent.id, model: agent.model, effort: agent.effort, prompt });
      const text = isRecord(prompt) ? "기록 본문" : `의견 ${CONCLUDE}`;
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await sleep(10);
  }
}

// 새 프로젝트를 만들고, 디스크의 프로젝트 JSON에 옛 키를 심은 뒤 토론할 준비를 한다.
async function setup({ legacy = {}, patch = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-discussion-record-")));
  const calls = [];
  const feature = makeFeature(root, calls);
  const created = await feature.invoke("chat:projects:create", { name: "기록 시험" });
  const projectId = created.activeProjectId;
  const file = path.join(root, "projects", `${projectId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...legacy }), "utf8");
  if (patch) await feature.invoke("chat:projects:update", { projectId, patch });
  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:send", { sessionId, text: "토론 주제입니다" });
  await waitFor(() => calls.length >= 2);
  await sleep(50);
  calls.length = 0;
  return { feature, calls, projectId, file, sessionId };
}

const FREE = { agentIds: ["codex", "claude"], turnBudget: 4 };
const STRUCTURED = { presetId: "shaping", cycleBudget: 1, roleAssignments: ["claude", "codex", "codex"] };

async function memoryOf(feature) {
  return (await feature.invoke("chat:memory:read", {})).content || "";
}

async function discuss(ctx, input) {
  const started = await ctx.feature.invoke("chat:discussion:start", { sessionId: ctx.sessionId, ...input });
  assert.equal(started.ok, true, started.error);
}

// 기록이 돌아야 하는 경우: 메모리에 쌓일 때까지 기다린 뒤 기록 호출을 돌려준다.
async function recorded(ctx, input) {
  await discuss(ctx, input);
  await waitFor(async () => (await memoryOf(ctx.feature)).includes("토론 요약 초안"));
  return ctx.calls.filter((call) => isRecord(call.prompt));
}

// 기록이 돌지 않아야 하는 경우: 토론이 끝나고 기록 호출이 올 만한 시간을 둔 뒤 확인한다.
async function notRecorded(ctx, input) {
  await discuss(ctx, input);
  await waitFor(() => ctx.calls.length >= 1);
  await sleep(300);
  assert.equal(ctx.calls.filter((call) => isRecord(call.prompt)).length, 0, "기록 호출이 없어야 합니다");
  assert.equal((await memoryOf(ctx.feature)).includes("토론 요약 초안"), false, "기록이 저장되면 안 됩니다");
}

test("기록 담당을 정하지 않은 프로젝트에서는 토론이 끝나도 기록 호출·저장이 없다(자유·구조화)", async () => {
  await notRecorded(await setup(), FREE);
  await notRecorded(await setup(), STRUCTURED);
});

test("옛 defaultRoles.recorder가 있으면 그 에이전트·모델·노력도로 기록한다(자유·구조화)", async () => {
  for (const input of [FREE, STRUCTURED]) {
    const ctx = await setup({ legacy: { defaultRoles: { recorder: { agentId: "agy", model: "m-rec", effort: "high" } } } });
    const records = await recorded(ctx, input);
    assert.equal(records.length, 1);
    assert.equal(records[0].agentId, "agy");
    assert.equal(records[0].model, "m-rec");
    assert.equal(records[0].effort, "high");
  }
});

test("recorder 역할이 없고 review 역할만 있으면 그 담당으로 폴백한다", async () => {
  const ctx = await setup({ legacy: { defaultRoles: { review: "codex" } } });
  const records = await recorded(ctx, FREE);
  assert.equal(records.length, 1);
  assert.equal(records[0].agentId, "codex");
});

test("recordAgent가 옛 역할보다 우선하고, 그 에이전트의 현재 모델·노력도를 쓴다", async () => {
  const ctx = await setup({
    legacy: { defaultRoles: { recorder: { agentId: "agy", model: "m-rec" } } },
    patch: { recordAgent: "claude", defaultAgents: { claude: { model: "m-claude", effort: "low" } } },
  });
  const records = await recorded(ctx, FREE);
  assert.equal(records.length, 1);
  assert.equal(records[0].agentId, "claude");
  assert.equal(records[0].model, "m-claude");
  assert.equal(records[0].effort, "low");
});

test('recordAgent ""는 옛 역할이 있어도 기록을 끈다', async () => {
  const ctx = await setup({
    legacy: { defaultRoles: { recorder: { agentId: "agy" }, review: "codex" } },
    patch: { recordAgent: "" },
  });
  await notRecorded(ctx, FREE);
});

test("담당 에이전트가 이 채팅에서 꺼져 있으면 조용히 건너뛴다", async () => {
  const ctx = await setup({ legacy: { defaultRoles: { recorder: { agentId: "agy" } } } });
  await ctx.feature.invoke("chat:agent:configure", { sessionId: ctx.sessionId, agentId: "agy", patch: { enabled: false } });
  await notRecorded(ctx, FREE);
});

test("recordAgent 저장은 옛 역할 키를 지우지 않고, 값은 chat:projects:update와 화면이 읽는 상태에 그대로 나온다", async () => {
  const legacy = { defaultRoles: { recorder: { agentId: "agy", model: "m-rec", effort: "high" } }, autoRevisions: { plan: 2 } };
  const ctx = await setup({ legacy });

  // 아직 저장하지 않았다: 화면에는 옛 역할에서 풀어 낸 담당만 보이고 역할 전체는 나가지 않는다.
  let state = await ctx.feature.invoke("chat:state");
  const project = state.projects.find((entry) => entry.id === ctx.projectId);
  assert.equal("recordAgent" in project, false);
  assert.equal(project.legacyRecorder.agentId, "agy");
  assert.equal("defaultRoles" in project, false);

  const saved = await ctx.feature.invoke("chat:projects:update", { projectId: ctx.projectId, patch: { recordAgent: "codex" } });
  assert.equal(saved.project.recordAgent, "codex");
  state = await ctx.feature.invoke("chat:state");
  assert.equal(state.projects.find((entry) => entry.id === ctx.projectId).recordAgent, "codex");
  let disk = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  assert.equal(disk.recordAgent, "codex");
  assert.deepEqual(disk.defaultRoles, legacy.defaultRoles);
  assert.deepEqual(disk.autoRevisions, legacy.autoRevisions);
  assert.equal("legacyRecorder" in disk, false, "풀어 낸 값이 디스크에 쓰이면 안 됩니다");

  // 끄기도 저장되고, 다른 항목을 저장해도 값이 유지된다.
  await ctx.feature.invoke("chat:projects:update", { projectId: ctx.projectId, patch: { recordAgent: "" } });
  await ctx.feature.invoke("chat:projects:update", { projectId: ctx.projectId, patch: { name: "이름만 변경" } });
  disk = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  assert.equal(disk.recordAgent, "");
  assert.equal(disk.name, "이름만 변경");
  assert.deepEqual(disk.defaultRoles, legacy.defaultRoles);

  // 잘못된 값은 무시한다.
  await ctx.feature.invoke("chat:projects:update", { projectId: ctx.projectId, patch: { recordAgent: "bad id!" } });
  assert.equal(JSON.parse(fs.readFileSync(ctx.file, "utf8")).recordAgent, "");
});

test("프로젝트 설정 화면에 '토론 자동 기록' 한 줄이 있고, 건드렸을 때만 recordAgent를 보낸다", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");
  assert.match(renderer, /makeField\("토론 자동 기록", record\)/);
  assert.match(renderer, /"기록 안 함"/);
  assert.match(renderer, /project\.legacyRecorder\?\.agentId/);
  assert.match(renderer, /record\.value !== recordInitial \? \{ recordAgent: record\.value \}/);
});
