"use strict";

// 묶음 B6 — 토론 프롬프트·기록. 진입점(ChatRoom + 가짜 러너, createChatFeature + 가짜 ipcMain)으로 확인한다.
//  F191 긴 토론에서 토론 주제가 후반 발언자 프롬프트에서 빠짐   F194 구조화 토론 프롬프트에 단계 역할이 없음
//  F81  자동 기록이 끝난 토론 구간이 아니라 세션 전체를 근거로 삼음
//  F189 토론 도중 앱 종료 시 결론 메시지가 없어 '결론 종합하기' 불가
//  F190 결론 직후 자동 기록 턴이 앱 종료로 끊기면 다시 만들 방법이 없음
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

const CONTINUE = "[[CODEPET_DISCUSSION:CONTINUE]]";
const CONCLUDE = "[[CODEPET_DISCUSSION:CONCLUDE]]";
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await tick();
  }
}

const roomAgents = () => [
  { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
  { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
];

// ---- F191 ------------------------------------------------------------------

test("F191: 45턴 자유토론의 마지막 발언자 프롬프트에도 토론 주제(사용자 질문)가 남는다", async () => {
  const prompts = [];
  let n = 0;
  const room = new ChatRoom({
    agents: roomAgents(),
    runAgent: ({ prompt }) => {
      prompts.push(prompt);
      n += 1;
      return { promise: Promise.resolve({ ok: true, text: `발언 ${n} ${CONTINUE}` }), cancel: () => {} };
    },
  });
  room.appendMessage({ authorType: "user", author: "user", text: "제약: 예산은 반드시 100만원 이하" });
  const result = await room.startDiscussion({ turnBudget: 45 });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 45);
  const last = prompts[44];
  assert.match(last, /제약: 예산은 반드시 100만원 이하/);
  assert.match(last, /=== 토론 주제 \(고정\) ===/);
  assert.match(last, /\[@codex\] 발언 3[^\n]*|\[@claude\] 발언 4[^\n]*/, "최근 발언은 그대로 이어 붙는다");
  assert.ok(!/발언 1 /.test(last), "오래된 발언은 여전히 창 밖이다");
  // 주제가 최근 창 안에 있는 짧은 토론은 주제를 두 번 넣지 않는다.
  assert.equal((prompts[2].match(/제약: 예산은 반드시 100만원 이하/g) || []).length, 1);
  assert.ok(!/토론 주제 \(고정\)/.test(prompts[2]));
});

// ---- F194 ------------------------------------------------------------------

test("F194: 한 에이전트가 여러 단계를 맡아도 종합자와 결론 종합 프롬프트에 단계 역할이 보인다", async () => {
  const prompts = [];
  const room = new ChatRoom({
    agents: roomAgents(),
    runAgent: ({ agent, prompt }) => {
      prompts.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: `${agent.id} 발언 ${prompts.length} ${CONTINUE}` }), cancel: () => {} };
    },
  });
  room.appendMessage({ authorType: "user", author: "user", text: "주제" });
  const result = await room.startDiscussion({
    protocol: { presetId: "shaping", cycleBudget: 1, participantIds: ["claude", "claude", "codex"] },
  });
  assert.equal(result.ok, true);
  const synth = prompts[3].prompt;
  assert.match(synth, /\[@claude · 발안자\]/);
  assert.match(synth, /\[@claude · 비평가\]/);
  assert.match(synth, /\[@claude · 발안자\(수정\)\]/);

  const summaryPrompts = [];
  room.runAgent = ({ prompt }) => {
    summaryPrompts.push(prompt);
    return { promise: Promise.resolve({ ok: true, text: "요약" }), cancel: () => {} };
  };
  const summary = await room.summarizeDiscussion(result.discussionId, "codex");
  assert.equal(summary.ok, true);
  assert.match(summaryPrompts[0], /\[@claude · 비평가\]/);
});

// ---- 기능 수준(F81 · F189 · F190) ---------------------------------------------

function rec(id, name) {
  return {
    id, name, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null,
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

const isRecord = (prompt) => prompt.includes("토론 기록자");
const isSummary = (prompt) => prompt.includes("토론 결론 종합자");

function startApp(root, runAgent) {
  const records = [rec("claude", "Claude"), rec("codex", "GPT")];
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
    runAgent,
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input), quit: () => feature.shutdown() };
}

function mkRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-b6-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const done = (value) => ({ promise: Promise.resolve(value), cancel: () => {} });
const never = () => ({ promise: new Promise(() => {}), cancel: () => {} });

async function newProjectSession(app, { record = true } = {}) {
  const created = await app.invoke("chat:projects:create", { name: "토론 시험" });
  if (record) await app.invoke("chat:projects:update", { projectId: created.activeProjectId, patch: { recordAgent: "claude" } });
  const state = await app.invoke("chat:state");
  return { projectId: created.activeProjectId, sessionId: state.activeSessionId };
}

test("F81: 자동 기록은 끝난 그 토론 구간만 근거로 삼고, 앞선 토론의 대화는 섞이지 않는다", async (t) => {
  const prompts = [];
  const app = startApp(mkRoot(t), ({ agent, prompt }) => {
    prompts.push({ agentId: agent.id, prompt });
    return done({ ok: true, text: isRecord(prompt) ? "기록 본문" : `의견 ${CONCLUDE}` });
  });
  t.after(() => app.quit());
  const { sessionId } = await newProjectSession(app);

  await app.invoke("chat:send", { sessionId, text: "@claude 첫째주제AAA" });
  await waitFor(() => prompts.length >= 1);
  await tick(50);
  await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 3 });
  await waitFor(() => prompts.filter((p) => isRecord(p.prompt)).length === 1);
  await tick(100);

  await app.invoke("chat:send", { sessionId, text: "@claude 둘째주제BBB" });
  await waitFor(() => prompts.length >= 4);
  await tick(50);
  await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 3 });
  await waitFor(() => prompts.filter((p) => isRecord(p.prompt)).length === 2);

  const records = prompts.filter((p) => isRecord(p.prompt));
  assert.match(records[0].prompt, /첫째주제AAA/);
  assert.match(records[1].prompt, /둘째주제BBB/);
  assert.ok(!/첫째주제AAA/.test(records[1].prompt), "두 번째 토론 기록에 앞선 토론의 주제가 섞이면 안 된다");
});

test("F189: 토론 도중 앱이 끝나도 다시 켜면 그 토론이 '중단됨' 결론으로 닫혀 결론 종합이 된다", async (t) => {
  const root = mkRoot(t);
  const first = [];
  let turn = 0;
  const app = startApp(root, ({ agent, prompt }) => {
    first.push(prompt);
    turn += 1;
    // 둘째 발언부터 끝나지 않는다(앱 종료 때 자식 프로세스가 close를 못 보낸 경우).
    return turn === 1 ? done({ ok: true, text: `첫 발언 ${CONTINUE}` }) : never();
  });
  const { sessionId } = await newProjectSession(app, { record: false });
  await app.invoke("chat:send", { sessionId, text: "@claude 토론주제CCC" });
  await waitFor(() => first.length >= 1);
  await tick(50);
  first.length = 0;
  turn = 0;
  await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 6 });
  await waitFor(() => first.length >= 2);
  app.quit();

  const summaryPrompts = [];
  const again = startApp(root, ({ prompt }) => {
    summaryPrompts.push(prompt);
    return done({ ok: true, text: "종합 카드" });
  });
  t.after(() => again.quit());
  const state = await again.invoke("chat:state");
  const closing = state.session.messages.find((m) => m.discussionMeta);
  assert.ok(closing, "끊긴 토론에 결론 메시지가 있어야 한다");
  assert.equal(closing.discussionMeta.reason, "interrupted");
  assert.equal(closing.discussionMeta.incomplete, true);
  const resumed = await again.invoke("chat:discussion:summarize", { sessionId, discussionId: closing.discussionMeta.discussionId, agentId: "claude" });
  assert.equal(resumed.ok, true);
  assert.equal(summaryPrompts.filter(isSummary).length, 1);
  assert.match(summaryPrompts[0], /첫 발언/);
});

test("F190: 결론 직후 자동 기록이 앱 종료로 끊기면 다음에 그 대화를 열 때 한 번 더 만든다", async (t) => {
  const root = mkRoot(t);
  const calls = [];
  const app = startApp(root, ({ prompt }) => {
    calls.push(prompt);
    if (isRecord(prompt)) return never();
    return done({ ok: true, text: `의견 ${CONCLUDE}` });
  });
  const { sessionId } = await newProjectSession(app);
  await app.invoke("chat:send", { sessionId, text: "@claude 기록주제DDD" });
  await waitFor(() => calls.length >= 1);
  await tick(50);
  await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 3 });
  await waitFor(() => calls.some(isRecord));
  app.quit();
  assert.equal(((await startApp(root, () => done({ ok: true, text: "" })).invoke("chat:memory:read", {})).content || "").includes("토론 요약 초안"), false);

  const retried = [];
  const again = startApp(root, ({ prompt }) => {
    retried.push(prompt);
    return done({ ok: true, text: isRecord(prompt) ? "다시 만든 기록" : "" });
  });
  t.after(() => again.quit());
  await again.invoke("chat:state");
  await waitFor(async () => ((await again.invoke("chat:memory:read", {})).content || "").includes("다시 만든 기록"));
  assert.equal(retried.filter(isRecord).length, 1);
  assert.match(retried.find(isRecord), /기록주제DDD/);

  // 저장이 끝난 뒤 다시 열면 또 만들지 않는다.
  const third = startApp(root, ({ prompt }) => {
    retried.push(prompt);
    return done({ ok: true, text: "" });
  });
  t.after(() => third.quit());
  await third.invoke("chat:state");
  await tick(150);
  assert.equal(retried.filter(isRecord).length, 1);
});

test("F190: 앱 종료가 아닌 실패는 다시 시도하지 않고 대화에 알린다", async (t) => {
  const root = mkRoot(t);
  const calls = [];
  const app = startApp(root, ({ prompt }) => {
    calls.push(prompt);
    return isRecord(prompt) ? done({ ok: false, error: "실행 실패" }) : done({ ok: true, text: `의견 ${CONCLUDE}` });
  });
  t.after(() => app.quit());
  const { sessionId } = await newProjectSession(app);
  await app.invoke("chat:send", { sessionId, text: "@claude 실패주제" });
  await waitFor(() => calls.length >= 1);
  await tick(50);
  await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 3 });
  await waitFor(async () => (await app.invoke("chat:state")).session.messages.some((m) => /토론 자동 기록을 만들지 못했습니다/.test(m.text || "")));

  const meta = JSON.parse(fs.readFileSync(path.join(root, "sessions", sessionId, "meta.json"), "utf8"));
  assert.ok(!meta.pendingDiscussionRecord, "표식이 남으면 열 때마다 재시도한다");
});
