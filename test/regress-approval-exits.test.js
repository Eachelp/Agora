"use strict";

// 권한 요청(승인 카드)과 바쁜 방에서 빠져나오는 길을 진입점부터 확인한다.
//  - IPC/방: 창이 닫힌 사이 온 승인 요청은 상태 스냅숏으로 되살아나고, 중지·삭제·종료는 승인 대기를
//    풀어 턴 큐가 막히지 않으며, 끼어들기(잠깐)·대기 턴 취소 IPC가 실제로 일한다.
//  - 렌더러: chat.html의 id로 만든 가짜 DOM에서 chat.js를 통째로 실행해, 승인 카드가 제 방에서만
//    뜨고, 승인 대기 중에도 중지·잠깐 버튼이 보이고, 대기 중인 발언을 × 로 하나씩 취소할 수 있다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createChatFeature } = require("../src/chat/chat-ipc");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------- IPC / 방

function fakeRecord(id, name, aliases) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: supported("tool-policy"),
      "workspace-read": supported("tool-policy"),
      "workspace-write": supported("sandbox"),
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

// 첫 실행은 권한이 필요하다고 답하고, 그 뒤 실행은 성공한다.
function setup() {
  const sent = [];
  const handlers = new Map();
  const windows = [];
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = { send: (channel, payload) => { if (!this.destroyed) sent.push({ channel, payload }); } };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) {
        this[name] = () => {};
      }
      this.isDestroyed = () => this.destroyed;
      this.isMinimized = () => false;
      windows.push(this);
    }
  }
  const records = [fakeRecord("claude", "Claude", ["claude"]), fakeRecord("codex", "GPT", ["gpt", "codex"])];
  const calls = [];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {}, send() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
    },
    storeRoot: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-exits-root-"))),
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: () => {
      calls.push(calls.length);
      const result = calls.length === 1
        ? { ok: false, approvalRequired: true, approval: { summary: "도구 실행 권한", detail: "파일 쓰기" } }
        : { ok: true, text: "완료" };
      return { promise: Promise.resolve(result), cancel() {} };
    },
  });
  feature.registerIpcHandlers();
  feature.openWindow();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  return { feature, invoke, sent, calls, windows };
}

// 쓰기 권한 방에서 @claude를 불러 첫 실행이 승인 요청으로 멈출 때까지 진행한다.
async function pendingApproval({ closeWindowFirst = false } = {}) {
  const env = setup();
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-exits-ws-")));
  const created = await env.invoke("chat:projects:create", { name: "권한", workspace });
  assert.equal(created.ok, true, created.error);
  const sessionId = created.session.meta.id;
  assert.equal((await env.invoke("chat:permission:set", { sessionId, mode: "workspace-write" })).ok, true);
  if (closeWindowFirst) env.windows[0].destroyed = true;
  const sentResult = await env.invoke("chat:send", { sessionId, text: "@claude 파일을 고쳐 줘" });
  assert.equal(sentResult.ok, true, sentResult.error);
  await waitFor(() => env.calls.length >= 1);
  await settle();
  return { ...env, sessionId, workspace };
}

const sessionOf = async (env) => (await env.invoke("chat:state", {})).session;
const eventsOf = (sent, channel) => sent.filter((entry) => entry.channel === channel);

test("F57: 창이 닫힌 사이 온 승인 요청은 창을 다시 열면 상태 스냅숏으로 되살아나 답할 수 있다", async () => {
  const env = await pendingApproval({ closeWindowFirst: true });
  assert.equal(eventsOf(env.sent, "chat:approval-request").length, 0, "닫힌 창에는 이벤트가 닿지 않는다");

  env.feature.openWindow(); // 닫혔던 창이 다시 붙는다(새 창).
  const session = await sessionOf(env);
  assert.equal(session.pendingApprovals.length, 1);
  const [request] = session.pendingApprovals;
  assert.equal(request.sessionId, env.sessionId);
  assert.equal(request.agentId, "claude");
  assert.equal(request.summary, "도구 실행 권한");
  assert.equal(request.detail, "파일 쓰기");
  assert.equal(session.turnState.current, "claude", "승인을 기다리는 턴은 계속 실행 중으로 보인다");

  const answered = await env.invoke("chat:approval:respond", {
    sessionId: env.sessionId, approvalId: request.approvalId, decision: "approve",
  });
  assert.equal(answered.ok, true, answered.error);
  await waitFor(() => env.calls.length >= 2);
  await settle();
  const after = await sessionOf(env);
  assert.deepEqual(after.pendingApprovals, []);
  assert.equal(after.turnState.current, null);
  assert.ok(after.messages.some((message) => message.author === "claude" && message.text === "완료"));
});

test("F57: 승인을 기다리는 동안 보낸 메시지는 대기열에 서고, 중지하면 승인이 풀려 새 메시지가 실행된다", async () => {
  const env = await pendingApproval({ closeWindowFirst: true });
  env.feature.openWindow();
  const queued = await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 하나 더" });
  assert.equal(queued.ok, true, queued.error);
  await settle();
  assert.equal((await sessionOf(env)).turnState.queue.length, 1, "승인 대기 뒤 턴은 큐에서 기다린다");
  assert.equal(env.calls.length, 1);

  const stopped = await env.invoke("chat:stop", { sessionId: env.sessionId });
  assert.equal(stopped.ok, true, stopped.error);
  const idle = await sessionOf(env);
  assert.deepEqual(idle.pendingApprovals, []);
  assert.equal(idle.turnState.current, null);
  assert.deepEqual(idle.turnState.queue, []);
  assert.ok(
    idle.messages.some((message) => message.authorType === "system" && /중지/.test(message.text)),
    "승인 대기만 있던 방을 멈춰도 중지했다는 기록이 남는다",
  );
  assert.equal(eventsOf(env.sent, "chat:approval-resolved").length, 1, "열린 창의 카드는 거둬진다");

  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 다시" });
  await waitFor(() => env.calls.length >= 2);
  await settle();
  assert.ok((await sessionOf(env)).messages.some((message) => message.author === "claude" && message.text === "완료"));
});

test("F57: 승인 대기 중인 방을 지워도 대기가 풀리고 카드가 거둬진다", async () => {
  const env = await pendingApproval();
  assert.equal(eventsOf(env.sent, "chat:approval-request").length, 1);
  const deleted = await env.invoke("chat:sessions:delete", { sessionId: env.sessionId });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(eventsOf(env.sent, "chat:approval-resolved").length, 1);
  await settle();
  assert.equal(env.calls.length, 1, "삭제된 방이 다시 실행하면 안 된다");
});

test("F57: 앱을 끝낼 때 승인 대기도 풀리고 다시 실행되지 않는다", async () => {
  const env = await pendingApproval();
  env.feature.shutdown();
  await settle();
  assert.equal(eventsOf(env.sent, "chat:approval-resolved").length, 1);
  assert.equal(env.calls.length, 1);
});

test("끼어들기(chat:turn:interject)는 승인 대기와 대기 턴을 모두 멈추고 사용자에게 발언권을 돌린다", async () => {
  const env = await pendingApproval();
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 대기 중인 질문" });
  await settle();
  const result = await env.invoke("chat:turn:interject", { sessionId: env.sessionId });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.interrupted, true);
  assert.equal(result.dropped, 1);
  const session = await sessionOf(env);
  assert.deepEqual(session.pendingApprovals, []);
  assert.equal(session.turnState.current, null);
  assert.deepEqual(session.turnState.queue, []);
  assert.ok(session.messages.some((message) => message.authorType === "system" && /사용자가 개입/.test(message.text)));
});

test("chat:turn:cancel은 대기 중인 턴 하나만 취소하고, 이미 시작된 턴·없는 턴은 거절한다", async () => {
  const env = await pendingApproval();
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@claude 둘째" });
  await env.invoke("chat:send", { sessionId: env.sessionId, text: "@codex 셋째" });
  await settle();
  const before = await sessionOf(env);
  assert.equal(before.turnState.queue.length, 2);
  const [first, second] = before.turnState.queue;

  const cancelled = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: first.turnId });
  assert.equal(cancelled.ok, true, cancelled.error);
  const after = await sessionOf(env);
  assert.deepEqual(after.turnState.queue.map((turn) => turn.turnId), [second.turnId], "다른 대기 턴은 그대로");
  assert.equal(after.turnState.current, "claude", "실행 중인 턴도 그대로");

  const again = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: first.turnId });
  assert.equal(again.ok, false);
  assert.match(again.error, /이미 시작되었거나 존재하지 않는 턴/);
  const running = await env.invoke("chat:turn:cancel", { sessionId: env.sessionId, turnId: "t1" });
  assert.equal(running.ok, false, "실행 중인 턴은 취소가 아니라 중지로 멈춘다");
});

// ---------------------------------------------------------------- 렌더러

const html = read("src/chat.html");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
// chat.html에서 처음부터 숨겨진 요소(hidden 속성).
const htmlHidden = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\shidden\b[^>]*>/g)].map((match) => match[1]));

function makeElement(id = "") {
  const listeners = {};
  let text = "";
  const el = {
    id, hidden: htmlHidden.has(id), disabled: false, value: "", title: "", className: "", placeholder: "",
    // 브라우저처럼 textContent를 새로 쓰면 자식이 비워진다.
    get textContent() { return text; },
    set textContent(value) { text = String(value); el.children = []; },
    children: [], options: [], dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    remove() {}, setAttribute() {}, getAttribute: () => null, focus() {}, blur() {}, select() {},
    setSelectionRange() {}, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    selectionStart: 0, scrollHeight: 0, scrollTop: 0, clientHeight: 0, offsetWidth: 0,
  };
  return el;
}

const agentList = () => [
  { id: "claude", name: "Claude", aliases: ["claude"], color: "#c96", available: true, enabled: true },
  { id: "codex", name: "GPT", aliases: ["gpt"], color: "#396", available: true, enabled: true },
];
const IDLE = { current: null, running: [], queue: [], deferred: [] };
const roomState = (id, extra = {}) => ({
  meta: { id, title: id, permissionMode: "workspace-write", workspace: "D:/work" },
  agents: agentList(), typing: [], turnState: { ...IDLE }, pendingApprovals: [], pendingAttachments: [], messages: [],
  ...extra,
});
const request = (sessionId, approvalId, agentId = "claude") => ({
  sessionId, approvalId, agentId, summary: `${sessionId} 권한`, detail: "세부", retryScope: "turn",
});

function loadRenderer(sessionsById) {
  const elements = new Map();
  const missing = [];
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) { missing.push(id); return null; }
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => makeElement(), querySelectorAll: () => [],
    createElement: () => makeElement(), createTextNode: (text) => ({ textContent: text }),
    documentElement: makeElement("root"), body: makeElement("body"), addEventListener() {},
    activeElement: null, hasFocus: () => true,
  };
  const calls = [];
  const subscribers = {};
  const fullFor = (id) => ({
    sessions: [{ id: "s1", title: "s1", projectId: "p1" }, { id: "s2", title: "s2", projectId: "p1" }],
    sessionsByProject: { p1: [{ id: "s1", title: "s1", projectId: "p1" }, { id: "s2", title: "s2", projectId: "p1" }] },
    projects: [{ id: "p1", name: "프로젝트", workspace: "D:/work", defaultPermissionMode: "workspace-write", defaultAgents: {} }],
    activeProjectId: "p1",
    providers: [], diagnostics: [], discussionPresets: [], workflow: { decisions: [], tasks: [], roles: [], statuses: [] },
    activeSessionId: id,
    session: sessionsById[id],
  });
  const chatApi = new Proxy({}, {
    get(_target, name) {
      if (name === "state") return () => Promise.resolve(fullFor("s1"));
      if (name === "sessionsSelect") {
        return (id) => { calls.push({ name, args: [id] }); return Promise.resolve({ ok: true, ...fullFor(id) }); };
      }
      if (typeof name === "string" && name.startsWith("on")) {
        return (handler) => { subscribers[name] = handler; return () => {}; };
      }
      return (...args) => { calls.push({ name, args }); return Promise.resolve({ ok: true }); };
    },
  });
  const errors = [];
  const context = {
    document,
    window: {
      chatApi, innerWidth: 1280, addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    localStorage: { getItem: () => null, setItem() {} },
    CSS: { escape: (value) => String(value) },
    console: { ...console, error: (...args) => errors.push(args.join(" ")) },
    requestAnimationFrame: (fn) => fn(), setTimeout: () => 0, clearTimeout() {}, ResizeObserver: undefined,
  };
  context.window.document = document;
  vm.createContext(context);
  for (const file of ["src/chat-markdown.js", "src/usage-view.js", "src/awaiting-view.js"]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  Object.assign(context, {
    chatMarkdown: context.window.chatMarkdown, usageView: context.window.usageView, awaitingView: context.window.awaitingView,
  });
  const run = (code) => vm.runInContext(code, context, { filename: "src/chat.js" });
  run(read("src/chat.js"));
  const el = (id) => elements.get(id);
  return { el, calls, subscribers, errors, missing, run };
}

async function boot(sessionsById) {
  const ui = loadRenderer(sessionsById);
  await settle();
  await settle();
  assert.deepEqual(ui.missing, []);
  assert.deepEqual(ui.errors, []);
  return ui;
}

test("F57 화면: 상태 스냅숏의 승인 요청이 창이 다시 붙을 때 카드로 뜨고 중지·잠깐 버튼이 보인다", async () => {
  const ui = await boot({
    s1: roomState("s1", {
      turnState: { current: "claude", running: ["claude"], queue: [], deferred: [] },
      pendingApprovals: [request("s1", "as1-1")],
    }),
  });
  assert.equal(ui.el("approval-backdrop").hidden, false);
  assert.equal(ui.el("approval-summary").textContent, "Claude: s1 권한");
  assert.equal(ui.el("btn-stop").hidden, false);
  assert.equal(ui.el("btn-interject").hidden, false);
  assert.equal(ui.el("composer-input").disabled, true, "카드가 떠 있는 동안 입력칸은 잠긴다");

  // 같은 요청이 이벤트로 또 와도 카드는 하나다. 거부하면 카드가 닫힌다.
  ui.subscribers.onApprovalRequest(request("s1", "as1-1"));
  ui.el("approval-deny").listeners.click.at(-1)();
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, true, "중복 카드가 다시 떠서는 안 된다");
  assert.deepEqual(ui.calls.filter((call) => call.name === "approvalRespond").map((call) => call.args), [["s1", "as1-1", "deny"]]);
});

test("중지 버튼은 입력 중 표시가 없어도 방이 바쁘면(실행·대기·승인 대기) 보이고, 한가하면 숨는다", async () => {
  const ui = await boot({ s1: roomState("s1") });
  assert.equal(ui.el("btn-stop").hidden, true);
  assert.equal(ui.el("btn-interject").hidden, true);

  const busy = { current: "claude", running: ["claude"], queue: [], deferred: [] };
  ui.subscribers.onTurnState({ sessionId: "s1", ...busy });
  assert.equal(ui.el("btn-stop").hidden, false, "승인 대기 중에는 입력 중 표시가 꺼져도 중지가 보여야 한다");
  assert.equal(ui.el("btn-interject").hidden, false);

  ui.subscribers.onTurnState({ sessionId: "s1", ...IDLE });
  assert.equal(ui.el("btn-stop").hidden, true);

  // 실행 중인 턴은 없고 대기만 남은 경우도 빠져나올 길이 열려 있다.
  ui.subscribers.onTurnState({ sessionId: "s1", current: null, running: [], queue: [{ turnId: "t5", agentId: "claude", discussion: false }], deferred: [] });
  assert.equal(ui.el("btn-stop").hidden, false);
  // 다른 방의 상태는 이 방의 버튼을 바꾸지 않는다.
  ui.subscribers.onTurnState({ sessionId: "s2", ...IDLE });
  assert.equal(ui.el("btn-stop").hidden, false);
});

test("잠깐은 chat:turn:interject로, 중지는 chat:stop으로 간다", async () => {
  const ui = await boot({ s1: roomState("s1", { turnState: { current: "claude", running: ["claude"], queue: [], deferred: [] } }) });
  ui.el("btn-interject").listeners.click.at(-1)();
  ui.el("btn-stop").listeners.click.at(-1)();
  await settle();
  assert.deepEqual(ui.calls.filter((call) => call.name === "turnInterject").map((call) => call.args), [["s1"]]);
  assert.deepEqual(ui.calls.filter((call) => call.name === "stop").map((call) => call.args), [["s1"]]);
  // 버튼이 실제로 하는 일(발언권을 사용자에게 돌리고 AI끼리의 호출을 막는다)을 그대로 알린다.
  assert.match(html, /id="btn-interject"[^>]*title="[^"]*발언권을 내게 돌립니다[^"]*AI끼리/);
});

test("대기 중인 발언마다 ×가 있고, 누르면 그 턴만 취소한다", async () => {
  const ui = await boot({
    s1: roomState("s1", {
      turnState: {
        current: "claude", running: ["claude"],
        queue: [{ turnId: "t2", agentId: "codex", discussion: false }, { turnId: "t3", agentId: "claude", discussion: false }],
        deferred: [{ turnId: "t9", agentId: "codex", discussion: true }],
      },
    }),
  });
  const pills = ui.el("queue-row").children;
  assert.equal(ui.el("queue-row").hidden, false);
  assert.equal(pills.length, 3);
  assert.match(pills[0].children[0].textContent, /GPT 대기/);
  assert.match(pills[2].children[0].textContent, /토론/);
  pills[1].children[1].listeners.click.at(-1)();
  await settle();
  assert.deepEqual(ui.calls.filter((call) => call.name === "turnCancel").map((call) => call.args), [["s1", "t3"]]);

  ui.subscribers.onTurnState({ sessionId: "s1", ...IDLE });
  assert.equal(ui.el("queue-row").hidden, true);
  assert.equal(ui.el("queue-row").children.length, 0);
});

test("F4 화면: 다른 방의 승인 카드는 그 방에서만 뜨고, 그 방 요청이 풀리면 어느 방에서든 거둬진다", async () => {
  const ui = await boot({ s1: roomState("s1"), s2: roomState("s2") });

  ui.subscribers.onApprovalRequest(request("s2", "as2-1", "codex"));
  assert.equal(ui.el("approval-backdrop").hidden, true, "방 A에 방 B의 카드가 뜨면 안 된다");
  assert.equal(ui.el("composer-input").disabled, false);
  assert.equal(ui.el("btn-stop").hidden, true, "다른 방의 승인 대기가 이 방을 바쁘게 만들면 안 된다");

  // 방 B로 가면 그 방의 카드가 뜬다.
  await ui.run('selectSession("s2")');
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, false);
  assert.equal(ui.el("approval-summary").textContent, "GPT: s2 권한");

  // 방 A로 돌아오면 B의 카드는 내려가고 입력칸이 풀린다. 다시 B로 가면 되돌아온다.
  await ui.run('selectSession("s1")');
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, true, "방을 떠나면 낡은 모달이 남지 않는다");
  assert.equal(ui.el("composer-input").disabled, false);
  await ui.run('selectSession("s2")');
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, false);

  // B 카드가 떠 있는 채로 B 요청이 풀리면(시간 초과·취소) 카드가 닫힌다.
  ui.subscribers.onApprovalResolved({ sessionId: "s2", approvalId: "as2-1" });
  assert.equal(ui.el("approval-backdrop").hidden, true);
  assert.equal(ui.el("composer-input").disabled, false);
});

test("F4 화면: 다른 방을 보는 동안 그 방 요청이 풀리면 나중에 그 방에 가도 카드가 없다", async () => {
  const ui = await boot({ s1: roomState("s1"), s2: roomState("s2") });
  ui.subscribers.onApprovalRequest(request("s2", "as2-7"));
  ui.subscribers.onApprovalResolved({ sessionId: "s2", approvalId: "as2-7" });
  await ui.run('selectSession("s2")');
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, true, "이미 풀린 요청이 되살아나면 안 된다");
  assert.equal(ui.el("composer-input").disabled, false);
});

test("F4 화면: 방 초기화는 그 방의 카드만 거두고 다른 방의 요청은 남긴다", async () => {
  const ui = await boot({ s1: roomState("s1", { pendingApprovals: [request("s1", "as1-3")] }), s2: roomState("s2") });
  assert.equal(ui.el("approval-backdrop").hidden, false);
  ui.subscribers.onApprovalRequest(request("s2", "as2-4"));
  ui.subscribers.onReset({ sessionId: "s1" });
  assert.equal(ui.el("approval-backdrop").hidden, true);
  await ui.run('selectSession("s2")');
  await settle();
  assert.equal(ui.el("approval-backdrop").hidden, false, "다른 방의 요청까지 지우면 그 방의 턴이 영영 막힌다");
});
