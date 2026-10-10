"use strict";

// 3.5단계 S35A: 토론·큐 버그 5건(F26·F31·F173·F192·F167)을 진입점에서 확인한다.
// 방 동작은 가짜 러너를 꽂은 ChatRoom으로, runId·저장 실패는 createChatFeature(가짜 ipcMain)로 본다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

const agents = () => [
  { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
  { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
];

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await tick();
  }
}
async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

const AGREE = "[[CODEPET_DISCUSSION:AGREE]]";
const CONCLUDE = "[[CODEPET_DISCUSSION:CONCLUDE]]";

// replies[id]는 응답 배열(소비 후에는 마지막 값을 반복). 함수면 호출 시 계산한다.
function scripted(replies, calls) {
  return ({ agent, prompt, attachments }) => {
    calls.push({ agentId: agent.id, prompt, attachments });
    const entry = replies[agent.id];
    const value = typeof entry === "function" ? entry() : entry;
    return { promise: Promise.resolve(value), cancel: () => {} };
  };
}

// F26: 같은 메시지·토론에 대한 요청이라도 담당 AI가 다르면 각자 실행돼야 한다.
test("F26: 쉽게 설명을 다른 AI에게 한 두 번째 요청이 첫 요청에 먹히지 않는다", async () => {
  const calls = [];
  const gates = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      gates.push(release);
      return { promise: gate.then(() => ({ ok: true, text: `${agent.id} 설명` })), cancel: () => {} };
    },
  });
  const source = room.appendMessage({ authorType: "agent", author: "claude", text: "어려운 말" });

  assert.equal(room.handoffMessage("claude", source.id, "SIMPLIFY").ok, true);
  await waitFor(() => calls.length === 1);
  assert.equal(room.handoffMessage("codex", source.id, "SIMPLIFY").ok, true);
  gates.splice(0).forEach((release) => release());
  await waitFor(() => calls.length === 2);
  gates.splice(0).forEach((release) => release());
  await settle(room);

  assert.deepEqual(calls.sort(), ["claude", "codex"]);
  assert.deepEqual(
    room.messages.filter((m) => m.simplifyMeta).map((m) => m.author).sort(),
    ["claude", "codex"],
  );
});

test("F26: 토론 결론 종합도 담당 AI가 다르면 각자 실행되고, 같은 AI의 이중 호출은 여전히 접힌다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: scripted({ claude: { ok: true, text: `의견 ${CONCLUDE}` }, codex: { ok: true, text: "요약" } }, calls),
  });
  room.sendUserMessage("주제");
  await settle(room);
  await room.startDiscussion({ turnBudget: 3 });
  await settle(room);
  const { discussionId } = room.messages.findLast((m) => m.discussionMeta).discussionMeta;
  calls.length = 0;

  const first = room.summarizeDiscussion(discussionId, "claude");
  const dup = room.summarizeDiscussion(discussionId, "claude");
  const other = room.summarizeDiscussion(discussionId, "codex");
  await Promise.all([first, dup, other]);
  await settle(room);

  assert.deepEqual(calls.map((c) => c.agentId).sort(), ["claude", "codex"]);
});

// F31: 기록 저장이 실패해도 토론 플래그가 남아 대화가 멈추면 안 된다.
test("F31: 토론 결론 메시지 기록이 예외를 던져도 토론 상태가 풀리고 이후 대화가 이어진다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: scripted({ claude: { ok: true, text: `의견 ${CONCLUDE}` }, codex: { ok: true, text: "답" } }, calls),
  });
  room.sendUserMessage("주제");
  await settle(room);
  room.on("message", (message) => {
    if (message.discussionMeta) throw new Error("EPERM: rename meta.json");
  });

  await assert.rejects(room.startDiscussion({ turnBudget: 3 }), /EPERM/);
  assert.equal(room.discussionActive, false);
  assert.equal(room.discussionRequested, false);

  calls.length = 0;
  room.sendUserMessage("@claude 토론 뒤 질문");
  await settle(room);
  assert.equal(calls.some((c) => c.agentId === "claude"), true, "일반 턴이 실행돼야 합니다");
  const again = await room.startDiscussion({ turnBudget: 3 }).catch((e) => ({ error: e.message }));
  assert.doesNotMatch(again.error || "", /이미 토론이 진행 중/);
});

test("F31: 토론 시작 안내 기록이 예외를 던져도 플래그가 남지 않는다", async () => {
  const room = new ChatRoom({ agents: agents(), runAgent: scripted({ claude: { ok: true, text: "x" }, codex: { ok: true, text: "x" } }, []) });
  room.sendUserMessage("주제");
  await settle(room);
  room.once("message", () => { throw new Error("디스크 가득 참"); });
  await assert.rejects(room.startDiscussion({ turnBudget: 3 }), /디스크 가득 참/);
  assert.equal(room.discussionActive, false);
  assert.equal(room.discussionRequested, false);
});

// 실제 진입점: 저장소 쓰기가 실패해도 토론이 정상 종료되고 사용자에게 알림이 간다.
test("F31: IPC 진입점에서 대화 기록 저장이 실패해도 토론이 끝나고 대화가 이어지며 알림이 간다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-disc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root, { runAgent: ({ agent }) => ({ promise: Promise.resolve({ ok: true, text: `의견 ${CONCLUDE}` }), cancel: () => {} }) });
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  await app.invoke("chat:send", { sessionId, text: "토론 주제" });
  await waitFor(() => app.runs.length >= 2);
  await tick(50);

  const original = fs.appendFileSync;
  fs.appendFileSync = function patched(file, data, ...rest) {
    if (String(data).includes("토론을 마쳤습니다")) throw Object.assign(new Error("EPERM: disk"), { code: "EPERM" });
    return original.call(this, file, data, ...rest);
  };
  t.after(() => { fs.appendFileSync = original; });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });

  await app.invoke("chat:discussion:start", { sessionId, turnBudget: 3 });
  await waitFor(() => app.notices.length > 0);
  assert.match(app.notices[0], /저장하지 못했습니다/);
  fs.appendFileSync = original;

  app.runs.length = 0;
  await app.invoke("chat:send", { sessionId, text: "@claude 이어서" });
  await waitFor(() => app.runs.length >= 1);
  const second = await app.invoke("chat:discussion:start", { sessionId, turnBudget: 3 });
  assert.equal(second.ok === false, false);
});

// F173: 한도에 걸린 참가자는 남은 토론에서 빠지고, 실패가 합의 카운터를 되돌리지 않는다.
test("F173: 사용 한도에 걸린 참가자는 한 번 알린 뒤 차례에서 빠지고 토론은 낭비 없이 끝난다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: [...agents(), { id: "agy", name: "AGY", aliases: ["agy"], available: true, enabled: true }],
    runAgent: scripted({
      claude: { ok: true, text: `동의 ${AGREE}` },
      agy: { ok: true, text: `동의 ${AGREE}` },
      codex: { ok: false, rateLimited: true, stopReason: "PROVIDER_RATE_LIMITED", error: "사용 한도에 도달했습니다." },
    }, calls),
  });
  room.sendUserMessage("@claude 주제");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ turnBudget: 12 });
  await settle(room);

  assert.equal(calls.filter((c) => c.agentId === "codex").length, 1, "한도에 걸린 참가자는 한 번만 호출");
  assert.equal(result.concluded, true, "남은 참가자 전원 합의로 끝나야 함");
  assert.ok(result.completed < 12);
  const notices = room.messages.filter((m) => m.authorType === "system" && /@codex.*한도.*제외/.test(m.text));
  assert.equal(notices.length, 1);
  assert.equal(room.messages.filter((m) => m.error && m.author === "codex").length, 1);
});

test("F173: 한도에 걸리지 않은 참가자가 한 명만 남으면 예산을 쓰지 않고 이유를 밝히며 마친다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: scripted({
      claude: { ok: true, text: `동의 ${AGREE}` },
      codex: { ok: false, rateLimited: true, stopReason: "PROVIDER_RATE_LIMITED", error: "사용 한도에 도달했습니다." },
    }, calls),
  });
  room.sendUserMessage("@claude 주제");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ turnBudget: 9 });
  await settle(room);

  assert.equal(calls.length, 2, "claude 1회 + codex 1회에서 멈춘다");
  assert.equal(result.concluded, false);
  const conclusion = room.messages.findLast((m) => m.discussionMeta);
  assert.equal(conclusion.discussionMeta.reason, "failed");
  assert.equal(conclusion.discussionMeta.incomplete, true);
  assert.match(conclusion.text, /한 명뿐/);
});

test("F173: 한도가 아닌 일시 실패는 합의 기록을 되돌리지 않고, 참가자 전원이 동의해야 끝난다", async () => {
  const codexReplies = [
    { ok: false, error: "일시적 오류" },
    { ok: true, text: `동의 ${AGREE}` },
  ];
  const calls = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: scripted({ claude: { ok: true, text: `동의 ${AGREE}` }, codex: () => codexReplies.shift() }, calls),
  });
  room.sendUserMessage("@claude 주제");
  await settle(room);
  calls.length = 0;
  const result = await room.startDiscussion({ turnBudget: 9 });
  await settle(room);
  // claude 동의 → codex 실패(기록 유지) → claude 또 동의(같은 사람이라 합의 아님) → codex 동의 → 전원 합의
  assert.equal(result.concluded, true);
  assert.equal(calls.map((c) => c.agentId).join(","), "claude,codex,claude,codex");
});

// F192: 주제 메시지의 첨부가 토론 참가자 턴에도 전달돼야 한다.
test("F192: 토론 주제 메시지의 첨부가 모든 참가자 턴에 전달된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: agents(),
    runAgent: scripted({ claude: { ok: true, text: "의견" }, codex: { ok: true, text: "의견" } }, calls),
  });
  const attachment = { id: "att-1", name: "report.csv", mime: "text/csv", kind: "text", size: 3, fileName: "abc" };
  room.sendUserMessage({ text: "@claude 이 파일 봐줘", attachments: [attachment] });
  await settle(room);
  assert.equal(calls[0].attachments.length, 1, "사전 답 턴은 첨부를 받는다");
  calls.length = 0;

  await room.startDiscussion({ turnBudget: 4 });
  await settle(room);

  assert.equal(calls.length, 4);
  for (const call of calls) assert.deepEqual(call.attachments, [attachment]);
});

// F167: 앱 재시작 뒤에도 runId가 이전 실행과 겹치지 않아야 한다.
function makeApp(root, { runAgent } = {}) {
  const handlers = new Map();
  const runs = [];
  const notices = [];
  const record = (id) => ({
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: [] }], efforts: [],
    allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  });
  const records = [record("claude"), record("codex")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      // 채팅 창은 알림(webContents.send)만 받아 적는 가짜다.
      BrowserWindow: class {
        constructor() {
          this.webContents = { send: (channel, payload) => { if (channel === "chat:system-notice") notices.push(payload.text); } };
        }
        isDestroyed() { return false; }
        on() {}
        once() {}
        setMenuBarVisibility() {}
        loadFile() {}
      },
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
    runAgent: (input) => {
      runs.push({ agentId: input.agent.id, runId: input.runId });
      return runAgent
        ? runAgent(input)
        : { promise: Promise.resolve({ ok: true, text: "네." }), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  return {
    runs, notices,
    invoke: (channel, input = {}) => handlers.get(channel)({}, input),
    quit: () => feature.shutdown(),
  };
}

test("F167: 앱을 다시 켠 뒤 같은 대화의 첫 실행 runId가 이전 실행과 겹치지 않는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-runid-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = makeApp(root);
  const sessionId = (await first.invoke("chat:state")).activeSessionId;
  await first.invoke("chat:send", { sessionId, text: "@claude 하나" });
  await waitFor(() => first.runs.length >= 1);
  await tick(50);
  const before = first.runs.map((r) => r.runId);
  await first.quit();

  // 앱 재시작: 같은 저장소 위에 새 기능 인스턴스
  const second = makeApp(root);
  await second.invoke("chat:state");
  await second.invoke("chat:send", { sessionId, text: "@claude 둘" });
  await waitFor(() => second.runs.length >= 1);
  const after = second.runs.map((r) => r.runId);
  await second.quit();

  assert.equal(before.length, 1);
  assert.equal(before.includes(after[0]), false, `재시작 뒤 runId가 겹침: ${after[0]}`);
  const num = (id) => Number(String(id).split("-").pop());
  assert.ok(num(after[0]) > num(before[0]));
});

test("F167: 디스크에만 남은 로그·지표·증거 파일의 번호도 건너뛴다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-runid-disk-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const seed = makeApp(root);
  const sessionId = (await seed.invoke("chat:state")).activeSessionId;
  await seed.quit();
  const dir = path.join(root, "sessions", sessionId, "run-logs");
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `r${sessionId}-`;
  for (const name of [`${prefix}3.log`, `${prefix}7.metrics.json`, `${prefix}12.evidence.json`, "r다른세션-99.log"]) {
    fs.writeFileSync(path.join(dir, name), "{}");
  }

  const app = makeApp(root);
  await app.invoke("chat:state");
  await app.invoke("chat:send", { sessionId, text: "@claude 하나" });
  await waitFor(() => app.runs.length >= 1);
  await app.quit();

  assert.equal(app.runs[0].runId, `${prefix}13`);
});
