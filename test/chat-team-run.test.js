"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTeamRunDirective } = require("../src/chat/chat-mention");
const { createChatFeature } = require("../src/chat/chat-ipc");

// --- parseTeamRunDirective 단위 규칙 ---

test("parseTeamRunDirective: 멘션 바로 다음 토큰이 '실행'일 때만 발동한다", () => {
  assert.equal(parseTeamRunDirective("@팀 실행 로그인 기능 만들어줘"), true);
  assert.equal(parseTeamRunDirective("@팀 실행: 로그인 기능"), true);
  assert.equal(parseTeamRunDirective("@team run build the login flow"), true);
  assert.equal(parseTeamRunDirective("@팀 실행"), true);
  // 본문 임의 위치의 "실행"은 상담 질문을 실행으로 승격하지 않는다.
  assert.equal(parseTeamRunDirective("@팀 이 실행 계획 어때?"), false);
  assert.equal(parseTeamRunDirective("@팀 어떻게 봐? 실행해도 될까"), false);
  // 팀 멘션 자체가 아니면 아무것도 아니다.
  assert.equal(parseTeamRunDirective("@팀장 실행 준비해줘"), false);
  assert.equal(parseTeamRunDirective("실행 @팀"), false);
  assert.equal(parseTeamRunDirective("@팀"), false);
  // 코드 블록 안의 멘션은 호출이 아니다(기존 마스킹 규칙 공유).
  assert.equal(parseTeamRunDirective("`@팀 실행` 문법 설명"), false);
});

test("parseTeamRunDirective: '실행 <명사>' 복합어 상담은 실행으로 승격하지 않는다", () => {
  // "실행 계획/방안/..."은 명사구다 — CONSULT가 EXECUTE 경계를 넘지 않는다(INV-2).
  assert.equal(parseTeamRunDirective("@팀 실행 계획을 같이 검토해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 방안 제안해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 결과를 정리해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 순서 알려줘"), false);
  // 실제 실행 지시는 그대로 발동한다(다음 토큰이 복합어 머리가 아니다).
  assert.equal(parseTeamRunDirective("@팀 실행 로그인 기능 만들어줘"), true);
  assert.equal(parseTeamRunDirective("@팀 실행 해줘"), true);
});

test("parseTeamRunDirective: 앞선 @팀 뒤에 토큰이 없어도 뒤의 '@팀 실행'을 놓치지 않는다", () => {
  // 첫 @팀에서 조기 종료하지 않고 계속 스캔한다.
  assert.equal(parseTeamRunDirective("@팀\n실행 로그인 기능"), true);
  assert.equal(parseTeamRunDirective("@팀. 그리고 @팀 실행 진행"), true);
});

// --- IPC 라우팅 (chat-team-consult.test.js의 harness 패턴) ---

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

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

function makeFeature(root, extraOptions = {}) {
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
      dialog: {
        async showOpenDialog() {
          return { canceled: true, filePaths: [] };
        },
      },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    ...extraOptions,
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

function makePlanContract(goal = "목표") {
  return [
    "## Goal",
    goal,
    "## Requirements",
    "기능 요구사항",
    "## Implementation Approach",
    "구현 접근 방식",
    "## Acceptance Criteria",
    "완료 수용 기준",
    "## Verification",
    "검증 계획",
    "## Out of Scope",
    "제외 범위",
    "STATUS: PLAN_READY",
  ].join("\n");
}

test("chat:send의 '@팀 실행'은 팀 자율 실행을 시작하고 READY 승인 게이트에서 멈춘다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-team-run-ipc-")));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-team-run-ws-")));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("팀 자율 실행") }],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
    }, calls),
  });

  const created = await feature.invoke("chat:projects:create", { name: "팀 실행", workspace });
  assert.equal(created.ok, true);
  const sessionId = created.session.meta.id;
  await feature.invoke("chat:projects:update", {
    projectId: created.activeProjectId,
    patch: {
      defaultRoles: {
        planning: { agentId: "claude" },
        review: { agentId: "codex" },
        implementation: { agentId: "agy" },
      },
    },
  });

  const sent = await feature.invoke("chat:send", {
    sessionId,
    text: "@팀 실행 로그인 기능 만들어줘",
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.teamRun, true);

  await waitFor(() => calls.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 기획 → 기획 검수만 자동 실행되고, 구현(agy)은 승인 게이트 앞에서 멈춘다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);

  const state = await feature.invoke("chat:state");
  assert.equal(state.session.meta.id, sessionId);
  assert.equal(state.session.specialist.planReady, true);
  assert.equal(state.session.specialist.active, false);
  const systemTexts = state.session.messages
    .filter((message) => message.authorType === "system")
    .map((message) => message.text);
  assert.ok(systemTexts.some((text) => /팀 자율 실행을 시작합니다/.test(text)));
  // 상담이 아니라 실행 경로다.
  assert.ok(!systemTexts.some((text) => /팀 상담 시작/.test(text)));
});

test("워크스페이스 없는 세션의 '@팀 실행'은 실행을 시작하지 않고 이유를 남긴다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-team-run-nows-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const feature = makeFeature(root, {
    capabilities: fakeCapabilities(),
    runAgent: fakeRunner({}, calls),
  });

  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sent = await feature.invoke("chat:send", { sessionId, text: "@팀 실행 로그인 기능" });
  assert.equal(sent.ok, true);
  assert.equal(sent.teamRun, false);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(calls.length, 0);
  const after = await feature.invoke("chat:state");
  const systemTexts = after.session.messages
    .filter((message) => message.authorType === "system")
    .map((message) => message.text);
  assert.ok(systemTexts.some((text) => /워크스페이스가 필요합니다/.test(text)));
});
