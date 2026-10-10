"use strict";

// 전문 모드 제거 S6 — 프로젝트 역할·자동 보완 설정 제거, Planner 작업 카드 프롬프트 제외,
// 토론 자동 기록 담당 선정. 진입점(createChatFeature + fake ipcMain)으로 확인한다.

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
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function makeFeature(root, calls = [], reply = () => "답변") {
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
      return { promise: Promise.resolve({ ok: true, text: reply({ agent, prompt }) }), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input) };
}

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-records-roles-")));
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CONCLUDE = "[[CODEPET_DISCUSSION:CONCLUDE]]";
// 토론 기록 호출은 토론 발언과 달리 결론 신호 없이 본문만 돌려준다.
const reply = ({ prompt }) => (prompt.includes("토론 기록자") ? "기록 본문" : `의견 ${CONCLUDE}`);

async function recordedBy(feature, calls, discussionInput) {
  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  await feature.invoke("chat:send", { sessionId, text: "토론 주제입니다" });
  await waitFor(() => calls.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  calls.length = 0;
  const started = await feature.invoke("chat:discussion:start", { sessionId, ...discussionInput });
  assert.equal(started.ok, true, started.error);
  // 토론이 끝나면 자동으로 기록 턴이 한 번 더 돈다 — 기록이 메모리에 쌓일 때까지 기다린다.
  await waitFor(async () => (await feature.invoke("chat:memory:read", {})).content.includes("토론 요약 초안"));
  return calls[calls.length - 1].agentId;
}

test("자유 토론이 끝나면 첫 활성 에이전트가 자동 기록을 맡는다", async () => {
  const calls = [];
  const feature = makeFeature(makeRoot(), calls, reply);
  const agent = await recordedBy(feature, calls, { agentIds: ["codex", "claude"], turnBudget: 4 });
  assert.equal(agent, "claude", "활성 에이전트 목록의 첫 에이전트가 기록한다(발언 순서와 무관)");
});

test("구조화 토론이 끝나면 마지막 단계(종합/판정) 발언자가 자동 기록을 맡는다", async () => {
  const calls = [];
  const feature = makeFeature(makeRoot(), calls, reply);
  // shaping의 종합자 slot은 세 번째 배정(codex)이다.
  const agent = await recordedBy(feature, calls, {
    presetId: "shaping", cycleBudget: 1, roleAssignments: ["claude", "codex", "codex"],
  });
  assert.equal(agent, "codex");
});

test("옛 프로젝트 JSON의 역할·자동 보완 키는 읽을 때만 걸러지고 파일에는 그대로 남는다", async () => {
  const root = makeRoot();
  const first = makeFeature(root);
  const created = await first.invoke("chat:projects:create", { name: "옛 프로젝트" });
  const projectId = created.session.meta.projectId;
  const file = path.join(root, "projects", `${projectId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.defaultRoles = { planning: { agentId: "claude" }, review: "claude" };
  raw.autoRevisions = { plan: 3, implementation: 2 };
  raw.context = "공통 맥락";
  fs.writeFileSync(file, JSON.stringify(raw), "utf8");

  const feature = makeFeature(root);
  const state = await feature.invoke("chat:state");
  const project = state.projects.find((entry) => entry.id === projectId);
  assert.equal(project.context, "공통 맥락");
  assert.equal("defaultRoles" in project, false);
  assert.equal("autoRevisions" in project, false);

  // 옛 화면이 보내는 패치 키는 무시하고, 디스크의 옛 값은 그대로 둔다.
  const saved = await feature.invoke("chat:projects:update", {
    projectId, patch: { name: "새 이름", defaultRoles: { review: "codex" }, autoRevisions: { plan: 1 } },
  });
  assert.equal(saved.project.name, "새 이름");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.name, "새 이름");
  assert.equal(onDisk.context, "공통 맥락");
  assert.deepEqual(onDisk.defaultRoles, raw.defaultRoles);
  assert.deepEqual(onDisk.autoRevisions, raw.autoRevisions);
});

test("옛 Planner 작업 카드는 목록에는 남지만 프롬프트의 진행 중 작업에는 들어가지 않는다", async () => {
  const root = makeRoot();
  const seed = makeFeature(root);
  const state0 = await seed.invoke("chat:state");
  const projectId = state0.activeProjectId;
  const now = Date.now();
  const base = { projectId, description: "", contentSource: "inline", syncState: "ok", createdAt: now, updatedAt: now };
  fs.writeFileSync(path.join(root, "workflow.json"), JSON.stringify({
    schemaVersion: 4,
    decisions: [],
    tasks: [
      { ...base, id: "t-planner", title: "옛 Planner 카드", status: "in_progress", origin: "planner", role: "planning" },
      { ...base, id: "t-manual", title: "직접 만든 카드", status: "in_progress", origin: "manual", role: "plan_review" },
    ],
  }), "utf8");

  const calls = [];
  const feature = makeFeature(root, calls);
  const state = await feature.invoke("chat:state");
  await feature.invoke("chat:send", { sessionId: state.activeSessionId, text: "@claude 안녕" });
  await waitFor(() => calls.length >= 1);
  assert.match(calls[0].prompt, /직접 만든 카드/);
  assert.doesNotMatch(calls[0].prompt, /옛 Planner 카드/);

  // 데이터는 지우지 않는다: 화면 목록에는 그대로 있고 저장 파일도 그대로다.
  assert.deepEqual(state.workflow.tasks.map((task) => task.id).sort(), ["t-manual", "t-planner"]);
  const stored = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
  assert.equal(stored.tasks.find((task) => task.id === "t-manual").role, "plan_review");
});
