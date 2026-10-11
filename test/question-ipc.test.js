"use strict";

// 실행 중 질문(ask_user)의 앱 쪽 전체 흐름. 진입점은 createChatFeature + 가짜 ipcMain이고,
// CLI 자리에는 MCP 서버와 똑같이 진짜 중계소에 HTTP로 묻는 가짜 러너를 둔다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatStore } = require("../src/chat/chat-store");
const { DEFAULT_WAIT_MS } = require("../src/chat/user-question-broker");
const { waitFor, httpPost, scriptedRunner } = require("./question-helpers.cjs");

function fakeRecord(id, name, aliases, extra = {}) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: { chat: supported("tool-policy"), "workspace-read": supported("tool-policy"), "workspace-write": supported("sandbox") },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
    ...extra,
  };
}

const ASK_TWO = [
  { question: "무엇을 고를까요?", options: ["가", "나", "다"], multiSelect: true },
  { question: "이유를 적어 주세요." },
];

// 임시 폴더는 시험이 끝나면 지운다(윈도에서 막 닫은 파일이 잠깐 잡혀 있을 수 있어 몇 번 다시 시도한다).
const cleanup = (...dirs) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };

// permission: 방 권한. 일하는 도중 묻는 질문은 파일 작업 권한(읽기·쓰기)이 있는 방에서만 붙으므로 기본은 workspace-read다.
// 'chat'(대화 전용)이면 프로젝트 없이 기본 방을 쓴다.
async function setup(t, { runner, harnessAdapter, records = [fakeRecord("claude", "Claude", ["claude"])], storeRoot, permission = "workspace-read" } = {}) {
  const sent = [];
  const handlers = new Map();
  const windows = [];
  class FakeBrowserWindow {
    constructor() {
      windows.push(this);
      this.destroyed = false;
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) this[name] = () => {};
      this.isDestroyed = () => this.destroyed;
      this.isMinimized = () => false;
    }
  }
  const root = storeRoot || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-question-")));
  const workspace = !storeRoot && permission !== "chat" ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-question-ws-"))) : null;
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {}, send() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    ...(runner ? { runAgent: runner } : {}),
    ...(harnessAdapter ? { harnessAdapter } : {}),
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  t.after(() => {
    feature.shutdown();
    cleanup(...(storeRoot ? [] : [root]), ...(workspace ? [workspace] : []));
  });
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  const state = await invoke("chat:state");
  let sessionId = state.activeSessionId;
  if (workspace) {
    sessionId = (await invoke("chat:projects:create", { name: "질문", workspace })).session.meta.id;
    await invoke("chat:permission:set", { sessionId, mode: permission });
  }
  const env = { feature, invoke, sent, windows, root, handlers, sessionId, state };
  env.channel = (name) => sent.filter((entry) => entry.channel === name).map((entry) => entry.payload);
  env.statusOf = (sessionId) => {
    const last = sent.filter((entry) => entry.channel === "chat:sessions-changed").pop();
    return Object.values(last.payload.sessionsByProject || {}).flat().find((row) => row.id === sessionId)?.status;
  };
  env.pending = async (sessionId = env.sessionId) => (await invoke("chat:sessions:select", { sessionId })).session.pendingQuestions;
  return env;
}

const askAndEcho = (questions = ASK_TWO) => async ({ ask }) => {
  const reply = await ask(questions);
  return `받은 답: ${JSON.stringify(reply.body.answers ?? reply.body.status)}`;
};

test("질문이 오면 화면에 알리고, 상태 스냅숏에 실으며, 답하면 같은 실행이 이어지고 기록이 남는다", async (t) => {
  const log = {};
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), log) });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행해 줘" });
  await waitFor(() => env.channel("chat:user-question").some((p) => p.question.status === "pending"));

  const [pending] = await env.pending();
  assert.equal(pending.sessionId, env.sessionId);
  assert.equal(pending.agentId, "claude");
  assert.match(pending.runId, /^r.+-1$/);
  assert.equal(pending.turnId, "t1");
  assert.equal(pending.status, "pending");
  assert.equal(pending.questions.length, 2);
  assert.equal(typeof pending.createdAt, "number");
  assert.equal(env.statusOf(env.sessionId), "running", "답을 기다리는 방은 사이드바에서 실행 중이다");

  // 검증: 다른 방·없는 질문·다른 실행·잘못된 답은 모두 거절하고 질문은 그대로 기다린다.
  const other = (await env.invoke("chat:sessions:create", {})).session.meta.id;
  const answer = (input) => env.invoke("chat:question:answer", { sessionId: env.sessionId, questionId: pending.questionId, ...input });
  const rejected = [
    await env.invoke("chat:question:answer", { sessionId: other, questionId: pending.questionId, answers: [] }),
    await answer({ questionId: "q-없음", answers: [] }),
    await answer({ runId: "r다른-9", answers: [{ selected: ["가"] }, { text: "x" }] }),
    await answer({ answers: "문자열" }),
    await answer({ answers: [{ selected: ["가"] }] }),
    await answer({ answers: [{ selected: ["라"] }, { text: "x" }] }),
    await answer({ answers: [{ selected: ["가", "가"] }, { text: "x" }] }),
    await answer({ answers: [{ text: "가" }, { text: "x" }] }),
    await answer({ answers: [{ selected: ["가"] }, { text: "x".repeat(8001) }] }),
    await answer({ answers: [{ selected: ["가"] }, { text: "   " }] }),
  ];
  for (const result of rejected) {
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0, "이유가 한국어 문장으로 온다");
  }
  assert.equal((await env.pending()).length, 1, "거절된 시도 뒤에도 질문은 그대로다");
  assert.equal(log.calls.length, 1);

  const done = await answer({ answers: [{ selected: ["다", "가"] }, { text: "그냥요" }] });
  assert.deepEqual(done, { ok: true });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.authorType === "agent"));
  const reply = env.channel("chat:message").find((p) => p.message.authorType === "agent").message;
  assert.equal(reply.text, `받은 답: ${JSON.stringify([{ selected: ["가", "다"] }, { text: "그냥요" }])}`, "질문에 적힌 순서로 정리돼 같은 실행으로 돌아간다");
  assert.equal(log.calls.length, 1, "새 실행 없이 같은 실행이 이어졌다");

  const again = await answer({ answers: [{ selected: ["가"] }, { text: "x" }] });
  assert.equal(again.ok, false, "이미 답한 질문에는 다시 답할 수 없다");
  await waitFor(() => env.statusOf(env.sessionId) === "idle");
  assert.deepEqual((await env.pending()), []);

  const statuses = env.channel("chat:user-question").map((p) => p.question.status);
  assert.deepEqual(statuses, ["pending", "submitting", "answered"]);
  assert.ok(env.channel("chat:user-question").every((p) => p.sessionId === env.sessionId));
  const store = new ChatStore({ root: env.root }).init();
  const kinds = store.readTranscript(env.sessionId).map((event) => event.kind).filter((kind) => /^user_/.test(kind));
  assert.deepEqual(kinds, ["user_question_requested", "user_answer_submitted", "user_answer_delivered"]);
  assert.equal(store.readUserQuestions(env.sessionId)[0].status, "answered");
  const snapshot = (await env.invoke("chat:sessions:select", { sessionId: env.sessionId })).session;
  assert.equal(snapshot.userQuestions.length, 1, "끝난 질문도 기록으로 남아 있다");
  assert.equal(snapshot.userQuestions[0].status, "answered");
});

test("답하지 않기로 하면 취소 기록이 남고 같은 실행이 이어진다", async (t) => {
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), {}) });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => env.channel("chat:user-question").length >= 1);
  const [pending] = await env.pending();
  assert.deepEqual(await env.invoke("chat:question:cancel", { sessionId: env.sessionId, questionId: pending.questionId }), { ok: true });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.authorType === "agent"));
  assert.match(env.channel("chat:message").find((p) => p.message.authorType === "agent").message.text, /skipped/);
  assert.equal((await env.invoke("chat:question:cancel", { sessionId: env.sessionId, questionId: pending.questionId })).ok, false);
  const last = env.channel("chat:user-question").at(-1).question;
  assert.equal(last.status, "cancelled");
  assert.equal(last.reason, "user-skip");
});

test("중지하면 질문이 취소되고 사이드바는 쉼으로 돌아오며 다음 대화가 막히지 않는다", async (t) => {
  const log = {};
  const env = await setup(t, {
    runner: scriptedRunner(async (ctx) => (ctx.args.prompt.includes("다음 대화") ? "다음 답" : askAndEcho()(ctx)), log),
  });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => env.channel("chat:user-question").length >= 1);
  assert.equal(env.statusOf(env.sessionId), "running");

  assert.deepEqual(await env.invoke("chat:stop", { sessionId: env.sessionId }), { ok: true });
  assert.equal(log.runs[0].cancelled, true);
  assert.deepEqual(await env.pending(), []);
  assert.equal(env.channel("chat:user-question").at(-1).question.status, "cancelled");
  await waitFor(() => env.statusOf(env.sessionId) === "idle");

  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 다음 대화" });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.text === "다음 답"));
});

test("답을 기다리는 방을 지워도 멈추지 않고 질문 연결이 정리된다", async (t) => {
  const log = {};
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), log) });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => env.channel("chat:user-question").length >= 1);
  const [pending] = await env.pending();
  const env0 = log.calls[0].userQuestion.server.env;

  const deleted = await Promise.race([
    env.invoke("chat:sessions:delete", { sessionId: env.sessionId }),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ]);
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(log.runs[0].cancelled, true);
  const stale = await httpPost(env0.AGORA_QUESTION_URL, env0.AGORA_QUESTION_TOKEN, "ask", { questions: ASK_TWO });
  assert.equal(stale.status, 401, "지운 방의 실행 토큰은 더 통하지 않는다");
  const after = await env.invoke("chat:question:answer", { sessionId: env.sessionId, questionId: pending.questionId, answers: [] });
  assert.equal(after.ok, false);
});

test("앱을 끄면 답을 기다리던 질문은 '중단됨'으로 기록에 남고, 중계소도 멈춘다", async (t) => {
  const log = {};
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), log) });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => env.channel("chat:user-question").length >= 1);
  const uq = log.calls[0].userQuestion.server.env;

  env.feature.shutdown();
  assert.equal(log.runs[0].cancelled, true);
  const store = new ChatStore({ root: env.root }).init();
  const [saved] = store.readUserQuestions(env.sessionId);
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.reason, "app-quit");
  await assert.rejects(httpPost(uq.AGORA_QUESTION_URL, uq.AGORA_QUESTION_TOKEN, "ask", { questions: ASK_TWO }), "중계소는 멈췄다");
});

test("다시 켜면 답을 기다리던 질문은 '중단됨'이라 기록에만 남고 답할 수 없으며, 기록은 한 번만 덧붙는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-question-restart-")));
  t.after(() => cleanup(root));
  const seed = new ChatStore({ root }).init();
  const sessionId = seed.createSession({}).id;
  const question = {
    questionId: "q-old", sessionId, agentId: "claude", runId: `r${sessionId}-1`, turnId: "t1",
    questions: [{ question: "옛 질문", options: ["가", "나"], multiSelect: false }], status: "pending", createdAt: 1,
  };
  seed.appendEvent(sessionId, { kind: "user_question_requested", question });

  const env = await setup(t, { storeRoot: root, runner: scriptedRunner(async () => "x", {}) });
  const selected = (await env.invoke("chat:sessions:select", { sessionId })).session;
  assert.deepEqual(selected.pendingQuestions, []);
  assert.equal(selected.userQuestions.length, 1);
  assert.equal(selected.userQuestions[0].status, "interrupted");
  const result = await env.invoke("chat:question:answer", { sessionId, questionId: "q-old", answers: [{ selected: ["가"] }] });
  assert.equal(result.ok, false);
  assert.equal((await env.invoke("chat:question:cancel", { sessionId, questionId: "q-old" })).ok, false);

  const kinds = () => new ChatStore({ root }).init().readTranscript(sessionId).map((e) => e.kind).filter((k) => /^user_/.test(k));
  assert.deepEqual(kinds(), ["user_question_requested", "user_question_interrupted"]);
  // 대화에도 한 줄(시스템 줄)로 남는다. 카드가 아니라 기록이다.
  const interruptedLines = (session) => session.messages.filter((m) => m.authorType === "system" && /앱이 꺼져 답을 받지 못했습니다/.test(m.text));
  assert.equal(interruptedLines(selected).length, 1);
  // 방을 다시 만들어도(두 번째 시작) 중단 기록이 또 쌓이지 않는다.
  const env2 = await setup(t, { storeRoot: root, runner: scriptedRunner(async () => "x", {}) });
  const reopened = (await env2.invoke("chat:sessions:select", { sessionId })).session;
  assert.deepEqual(kinds(), ["user_question_requested", "user_question_interrupted"]);
  assert.equal(interruptedLines(reopened).length, 1, "다시 켜도 안내는 한 번만 남는다");
});

test("창이 닫혀 있던 사이에 온 질문도 창이 다시 붙으면 스냅숏으로 되살아나 답할 수 있다", async (t) => {
  const log = {};
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), log) });
  env.windows[0].destroyed = true; // 창 닫힘: 알림은 어디에도 닿지 않는다
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => log.runs.length === 1 && log.runs[0].waiting.length === 1);
  assert.equal(env.channel("chat:user-question").length, 0, "닫힌 창으로는 아무것도 가지 않았다");

  env.windows[0].destroyed = false; // 창이 다시 열렸다
  const fresh = await env.invoke("chat:state");
  assert.equal(fresh.session.pendingQuestions.length, 1);
  assert.equal(fresh.session.pendingQuestions[0].agentId, "claude");
  const answered = await env.invoke("chat:question:answer", {
    sessionId: env.sessionId, questionId: fresh.session.pendingQuestions[0].questionId,
    answers: [{ selected: ["나"] }, { text: "네" }],
  });
  assert.deepEqual(answered, { ok: true });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.authorType === "agent"));
});

test("질문 기록을 디스크에 쓰지 못해도 질문·답·실행은 멈추지 않고 알림이 한 번 나온다", async (t) => {
  const realAppend = fs.appendFileSync;
  let failing = false;
  fs.appendFileSync = function patched(file, data, ...rest) {
    if (failing && /"kind":"user_(question|answer)_/.test(String(data))) {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return realAppend.call(fs, file, data, ...rest);
  };
  const realWarn = console.warn;
  console.warn = () => {};
  t.after(() => { fs.appendFileSync = realAppend; console.warn = realWarn; });

  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), {}) });
  failing = true;
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행" });
  await waitFor(() => env.channel("chat:user-question").length >= 1);
  const [pending] = await env.pending();
  assert.equal(pending.status, "pending", "저장이 실패해도 화면에는 질문이 보인다");
  const done = await env.invoke("chat:question:answer", {
    sessionId: env.sessionId, questionId: pending.questionId, answers: [{ selected: ["가"] }, { text: "응" }],
  });
  assert.deepEqual(done, { ok: true });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.authorType === "agent"), 3000, "실행 이어짐");
  await waitFor(() => env.statusOf(env.sessionId) === "idle");
  const notices = env.channel("chat:system-notice").filter((p) => /질문과 답을 디스크에 저장하지 못했습니다/.test(p.text));
  assert.equal(notices.length, 1, "저장 실패 알림은 방마다 한 번");
  assert.deepEqual(env.channel("chat:user-question").map((p) => p.question.status), ["pending", "submitting", "answered"]);
});

test("방마다 질문이 따로이고, 한 방의 중지는 다른 방의 질문을 건드리지 않는다", async (t) => {
  const log = {};
  const env = await setup(t, { runner: scriptedRunner(askAndEcho(), log) });
  const a = env.sessionId;
  const b = (await env.invoke("chat:sessions:create", {})).session.meta.id;
  await env.invoke("chat:permission:set", { sessionId: b, mode: "workspace-read" });
  await env.invoke("chat:send", { sessionId: a, text: "@claude A" });
  await env.invoke("chat:send", { sessionId: b, text: "@claude B" });
  await waitFor(() => env.channel("chat:user-question").filter((p) => p.question.status === "pending").length === 2);
  const [qa] = await env.pending(a);
  const [qb] = await env.pending(b);
  assert.notEqual(qa.questionId, qb.questionId);
  assert.notEqual(qa.runId, qb.runId);
  assert.equal((await env.invoke("chat:question:answer", { sessionId: b, questionId: qa.questionId, answers: [] })).ok, false);

  await env.invoke("chat:stop", { sessionId: a });
  assert.deepEqual(await env.pending(a), []);
  assert.equal((await env.pending(b)).length, 1);
  assert.equal(env.statusOf(b), "running");
  assert.equal((await env.invoke("chat:question:answer", {
    sessionId: b, questionId: qb.questionId, answers: [{ selected: ["가"] }, { text: "응" }],
  })).ok, true);
  await waitFor(() => env.channel("chat:message").some((p) => p.sessionId === b && p.message.authorType === "agent"));
});

test("셸 래퍼로 설치된 CLI와 AGY에는 질문 도구를 붙이지 않고, 붙이지 않는 실행의 인자 모양은 그대로다", async (t) => {
  const log = {};
  const records = [
    fakeRecord("claude", "Claude", ["claude"], { needsShell: true }),
    fakeRecord("codex", "Codex", ["codex"]),
    fakeRecord("agy", "Antigravity", ["agy"]),
  ];
  const env = await setup(t, { records, runner: scriptedRunner(async () => "완료", log) });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 안녕" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@agy 안녕" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@codex 안녕" });
  await waitFor(() => log.calls.length === 3);
  const byAgent = Object.fromEntries(log.calls.map((call) => [call.agent.id, call]));
  assert.equal("userQuestion" in byAgent.claude, false, "셸 래퍼");
  assert.equal("userQuestion" in byAgent.agy, false, "AGY");
  assert.ok(byAgent.codex.userQuestion, "직접 실행하는 Codex에는 붙는다");
  assert.deepEqual(Object.keys(byAgent.claude).sort(), ["agent", "attachments", "autoApprove", "emitEvent", "permissionMode", "prompt", "runId"]);
  assert.doesNotMatch(byAgent.claude.prompt, /ask_user|agora_user_question/);
  assert.doesNotMatch(byAgent.agy.prompt, /ask_user|agora_user_question/);
  assert.match(byAgent.codex.prompt, /agora_user_question/);
});

// CLI 자리에 "앱이 만든 실행 인자의 --mcp-config를 읽어 진짜 MCP 서버를 띄우고 ask_user를 호출하는" 하네스를 둔다.
// 인자 만들기 → MCP 서버 → 중계소 → 방 → 화면 답 → 도구 결과까지 한 줄로 이어지는지 본다.
test("앱이 만든 실행 인자로 띄운 진짜 MCP 서버를 거쳐 답이 같은 실행의 도구 결과로 돌아간다", async (t) => {
  const captured = [];
  const waiting = [];
  const harnessAdapter = {
    runTurn({ invocation }) {
      captured.push(invocation);
      const flag = invocation.argv.indexOf("--mcp-config");
      assert.ok(flag >= 0, "Claude 실행 인자에 --mcp-config가 있다");
      const server = JSON.parse(invocation.argv[flag + 1]).mcpServers.agora_user_question;
      assert.equal(invocation.argv[invocation.argv.indexOf("--allowedTools") + 1], "mcp__agora_user_question__ask_user");
      const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      t.after(() => child.kill());
      const replies = new Map();
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        try { const message = JSON.parse(line); replies.set(message.id, message); } catch {}
      });
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const promise = (async () => {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_user", arguments: { questions: ASK_TWO } } });
        await waitFor(() => replies.has(2), 5000, "도구 결과");
        child.kill();
        return { ok: true, text: replies.get(2).result.content[0].text };
      })();
      return { promise, cancel: () => child.kill(), setWaitingUser: (value) => waiting.push(Boolean(value)) };
    },
  };
  const env = await setup(t, { harnessAdapter });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 진행해 줘" });
  await waitFor(() => env.channel("chat:user-question").some((p) => p.question.status === "pending"), 8000, "질문 도착");
  const [pending] = await env.pending();
  assert.deepEqual(pending.questions.map((q) => q.multiSelect), [true, false]);
  assert.deepEqual(waiting, [true], "러너의 시간 제한 손잡이가 방까지 이어져 대기 중에 켜진다");
  assert.deepEqual(await env.invoke("chat:question:answer", {
    sessionId: env.sessionId, questionId: pending.questionId, answers: [{ selected: ["나", "가"] }, { text: "그냥요" }],
  }), { ok: true });
  await waitFor(() => env.channel("chat:message").some((p) => p.message.authorType === "agent"), 8000, "실행 이어짐");
  const text = env.channel("chat:message").find((p) => p.message.authorType === "agent").message.text;
  assert.match(text, /Q: 무엇을 고를까요\?\nA:\n- 가\n- 나/);
  assert.match(text, /A: "그냥요"/);
  assert.match(text, /도구·파일 사용을 허락한 것이 아닙니다/);
  assert.equal(captured.length, 1, "실행은 한 번뿐이다");
  assert.deepEqual(captured[0].extraEnv, { MCP_TOOL_TIMEOUT: "2100000" }, "Claude의 MCP 도구 시간 제한은 중계소의 30분 대기보다 5분 길다");
  assert.ok(Number(captured[0].extraEnv.MCP_TOOL_TIMEOUT) > DEFAULT_WAIT_MS);
  assert.match(captured[0].prompt, /agora_user_question 서버의 ask_user 도구/);
  assert.deepEqual(waiting, [true, false]);
  await waitFor(() => env.channel("chat:user-question").at(-1).question.status === "answered", 5000, "전달 확인");
});

test("질문 도구를 붙이지 않는 실행은 실행 인자도 환경도 예전 모양 그대로 하네스에 간다", async (t) => {
  const captured = [];
  const harnessAdapter = { runTurn: ({ invocation }) => { captured.push(invocation); return { promise: Promise.resolve({ ok: true, text: "완료" }), cancel() {} }; } };
  const records = [fakeRecord("claude", "Claude", ["claude"], { needsShell: true }), fakeRecord("agy", "Antigravity", ["agy"])];
  const env = await setup(t, { harnessAdapter, records });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 안녕" });
  await waitFor(() => captured.length === 1);
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@agy 안녕" });
  await waitFor(() => captured.length === 2);
  for (const invocation of captured) {
    assert.equal("extraEnv" in invocation, false);
    assert.equal(invocation.argv.some((arg) => /^--mcp-config$|agora_user_question|^--allowedTools$/.test(arg)), false);
    assert.doesNotMatch(invocation.prompt, /ask_user|agora_user_question/);
  }
});

test("preload·main·화면이 같은 채널 이름을 쓴다", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const preload = read("src/chat-preload.js");
  const main = read("src/chat/chat-ipc.js");
  assert.match(preload, /QUESTION_ANSWER: "chat:question:answer"/);
  assert.match(preload, /QUESTION_CANCEL: "chat:question:cancel"/);
  assert.match(preload, /questionAnswer: \(sessionId, questionId, answers\) =>/);
  assert.match(preload, /questionCancel: \(sessionId, questionId\) =>/);
  assert.match(preload, /onUserQuestion: \(handler\) => subscribe\("chat:user-question", handler\)/);
  assert.match(main, /"chat:question:answer"/);
  assert.match(main, /"chat:question:cancel"/);
  assert.match(main, /broadcast\("chat:user-question"/);
});

// 대화 전용(chat) 권한의 방은 파일 작업이 없어 답도 짧게 끝난다. 일하는 도중 묻는 도구를 붙이면 시작이 느려지고
// 토큰만 늘므로(특히 Codex) 붙이지 않고, 예전처럼 응답 끝에서 묻는다. 중계소(루프백 서버)도 시작하지 않는다.
test("대화 전용 방의 실행에는 질문 도구도, 셸 래퍼 안내도, 중계소도 없고 인자·환경은 예전 그대로다", async (t) => {
  const http = require("node:http");
  const originalCreateServer = http.createServer;
  let servers = 0;
  http.createServer = (...args) => { servers += 1; return originalCreateServer.apply(http, args); };
  t.after(() => { http.createServer = originalCreateServer; });

  const captured = [];
  const harnessAdapter = { runTurn: ({ invocation }) => { captured.push(invocation); return { promise: Promise.resolve({ ok: true, text: "완료" }), cancel() {} }; } };
  const records = [
    fakeRecord("claude", "Claude", ["claude"]),
    fakeRecord("codex", "Codex", ["codex"], { needsShell: true }),
  ];
  const env = await setup(t, { harnessAdapter, records, permission: "chat" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 안녕" });
  await waitFor(() => captured.length === 1);
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@codex 안녕" });
  await waitFor(() => captured.length === 2);

  for (const invocation of captured) {
    assert.equal("extraEnv" in invocation, false, "MCP 도구 시간 제한 환경 변수도 더하지 않는다");
    assert.equal(invocation.argv.some((arg) => /^--mcp-config$|^--allowedTools$|mcp_servers|agora_user_question/.test(arg)), false);
    assert.doesNotMatch(invocation.prompt, /ask_user|agora_user_question/);
    assert.match(invocation.prompt, /ASK_USER: <질문 한 줄>/, "끝에서 묻는 방식은 그대로다");
  }
  assert.equal(servers, 0, "중계소는 시작하지 않는다");
  const session = (await env.invoke("chat:sessions:select", { sessionId: env.sessionId })).session;
  assert.equal(session.messages.some((m) => m.authorType === "system" && /셸 래퍼|\.cmd|질문 도구/.test(m.text)), false, "대화 전용 방에서는 설치 방식 안내가 나오지 않는다");
});
