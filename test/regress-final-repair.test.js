"use strict";

// v1.2.0 직전 마지막 보수 라운드(9a 점검 결과).
//  2. 저장 실패 안내: 보던 방이 아니면 버리지 않고 그 방을 열 때 보여 주며, 받은 창이 없으면 '알림'으로 치지 않는다.
//  3. 프로젝트 설정의 "토론 자동 기록": 저장된 담당이 목록에 없어도 숨기지 않고, "기록 안 함"이 실제로 저장된다.
//  4. 중지·승인 재시도로 끝난 실행의 '응답 중' 점선 초안 말풍선은 거둔다.
//  5. 대기 턴 안내: × 로 지운 턴은 유실 안내가 없고, 잠깐·중지는 한 줄로 알린다.
//  6. 작업 카드에 역할 선택·역할 표기가 없다(저장된 값은 그대로 읽고 쓴다).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatRoom } = require("../src/chat/chat-room");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

// ---------------------------------------------------------------- IPC 진입점

function fakeRecord(id, name, aliases) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name, color: "#333333", aliases, status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: { chat: supported("tool-policy"), "workspace-read": supported("tool-policy"), "workspace-write": supported("sandbox") },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function makeFeature({ gate } = {}) {
  const handlers = new Map();
  const sent = [];
  const windowState = { destroyed: true };
  class FakeBrowserWindow {
    constructor() {
      windowState.destroyed = false;
      this.webContents = { send: (channel, payload) => { sent.push({ channel, payload }); } };
      for (const name of ["show", "focus", "restore", "on", "once", "setMenuBarVisibility", "loadFile", "close"]) this[name] = () => {};
      this.isDestroyed = () => windowState.destroyed;
      this.isMinimized = () => false;
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
    storeRoot: tmp("agora-final-root-"),
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return { promise: gate ? gate.promise : Promise.resolve({ ok: true, text: "완료" }), cancel() {} };
    },
  });
  feature.registerIpcHandlers();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  return { feature, invoke, sent, calls };
}

async function newProject(env, name = "프로젝트") {
  const created = await env.invoke("chat:projects:create", { name, workspace: tmp("agora-final-ws-") });
  assert.equal(created.ok, true, created.error);
  return { projectId: created.activeProjectId || created.session.meta.projectId, sessionId: created.session.meta.id };
}

// meta.json 교체만 실패시킨다(디스크 가득). 저장 실패 안내 경로를 만든다.
const realRename = fs.renameSync;
let failMeta = false;
fs.renameSync = function patchedRename(from, to, ...rest) {
  if (failMeta && String(to).endsWith("meta.json")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  return realRename.call(fs, from, to, ...rest);
};
test.after(() => { fs.renameSync = realRename; });

test("2. 저장 실패 안내를 받은 창이 없으면 '안내함'으로 치지 않고, 창이 생긴 뒤 실패에서 그 방으로 다시 알린다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const env = makeFeature();
  const { sessionId } = await newProject(env);
  const notices = () => env.sent.filter((entry) => entry.channel === "chat:system-notice");

  failMeta = true;
  try {
    // 창이 없다(openWindow 전): 알림이 아무 데도 닿지 않는다.
    assert.equal((await env.invoke("chat:send", { sessionId, text: "@claude 첫째" })).ok, true);
    await settle();
    assert.equal(notices().length, 0);

    env.feature.openWindow();
    assert.equal((await env.invoke("chat:send", { sessionId, text: "@claude 둘째" })).ok, true);
    await settle();
    assert.equal(notices().length, 1, "닿지 않은 알림은 소비되지 않아 창이 생긴 뒤 한 번 알린다");
    assert.equal(notices()[0].payload.sessionId, sessionId, "알림은 그 방의 것으로 나간다");
    assert.match(notices()[0].payload.text, /저장하지 못했습니다/);

    assert.equal((await env.invoke("chat:send", { sessionId, text: "@claude 셋째" })).ok, true);
    await settle();
    assert.equal(notices().length, 1, "방마다 한 번만 알린다");
  } finally {
    failMeta = false;
  }
});

test("3. IPC: 목록에 없는 기록 담당이 저장돼 있어도 '기록 안 함'(빈 문자열)이 실제로 저장된다", async () => {
  const env = makeFeature();
  const { projectId } = await newProject(env);
  const set = await env.invoke("chat:projects:update", { projectId, patch: { recordAgent: "ghost" } });
  assert.equal(set.ok, true, set.error);
  const recordOf = async () => (await env.invoke("chat:state", {})).projects.find((project) => project.id === projectId).recordAgent;
  assert.equal(await recordOf(), "ghost");
  const off = await env.invoke("chat:projects:update", { projectId, patch: { recordAgent: "" } });
  assert.equal(off.ok, true, off.error);
  assert.equal(await recordOf(), "", "빈 값도 저장돼 옛 담당 폴백까지 끈다");
});

test("5. IPC: 사용자가 × 로 지운 대기 턴은 '전달되지 않았을 수 있다'는 안내를 남기지 않는다", async () => {
  const gate = Promise.withResolvers();
  const env = makeFeature({ gate });
  const { sessionId } = await newProject(env);
  assert.equal((await env.invoke("chat:send", { sessionId, text: "@claude 하나" })).ok, true);
  assert.equal((await env.invoke("chat:send", { sessionId, text: "@codex 둘" })).ok, true);
  await settle();
  const before = (await env.invoke("chat:state", { sessionId })).session;
  assert.equal(before.turnState.queue.length, 1);
  const cancelled = await env.invoke("chat:turn:cancel", { sessionId, turnId: before.turnState.queue[0].turnId });
  assert.equal(cancelled.ok, true, cancelled.error);
  const after = (await env.invoke("chat:state", { sessionId })).session;
  assert.deepEqual(after.turnState.queue, []);
  assert.deepEqual(after.messages.filter((message) => message.authorType === "system"), [], "일부러 지운 턴에는 안내가 없다");
  await env.invoke("chat:stop", { sessionId });
  gate.resolve({ ok: true, text: "" });
});

test("6. IPC: 저장된 작업의 역할 값은 화면에서 빠져도 읽고 쓸 때 그대로 남는다", async () => {
  const env = makeFeature();
  const { projectId, sessionId } = await newProject(env);
  const created = await env.invoke("chat:tasks:create", { projectId, title: "옛 작업", role: "review", chatId: sessionId });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.task.role, "review");
  // 화면은 이제 role을 보내지 않는다: 상태·담당자만 바꿔도 역할이 지워지거나 바뀌지 않는다.
  const updated = await env.invoke("chat:tasks:update", { projectId, taskId: created.task.id, patch: { status: "done", agentId: "claude" } });
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.task.role, "review");
  assert.equal(updated.task.status, "done");
  // role 없이 새로 만들면 기본 역할로 정규화된다.
  const plain = await env.invoke("chat:tasks:create", { projectId, title: "새 작업", chatId: sessionId });
  assert.equal(plain.task.role, "implementation");
});

// ---------------------------------------------------------------- 방(ChatRoom)

function makeRoom(systems, runAgent) {
  const agents = [
    { id: "a", name: "a", aliases: ["a"], available: true, enabled: true },
    { id: "b", name: "b", aliases: ["b"], available: true, enabled: true },
  ];
  const room = new ChatRoom({
    agents,
    runAgent: runAgent || (() => ({ promise: Promise.resolve({ ok: true, text: "ok" }), cancel: () => {} })),
  });
  room.on("message", (message) => {
    if (message && message.authorType === "system") systems.push(message.text);
  });
  return room;
}

// b가 실행 중이고 a 대기 턴이 하나 있는 방.
function busyRoom(systems) {
  const gate = Promise.withResolvers();
  const room = makeRoom(systems, () => ({ promise: gate.promise, cancel: () => {} }));
  room.scheduleResponse(room.agents[1]);
  room.scheduleResponse(room.agents[0]);
  return { room, gate };
}

test("5. 방: cancelTurn(×)은 유실 안내를 남기지 않는다", async () => {
  const systems = [];
  const { room, gate } = busyRoom(systems);
  await settle();
  const [queued] = room.turnState().queue;
  assert.ok(queued, "대기 턴이 있어야 한다");
  assert.equal(room.cancelTurn(queued.turnId), true);
  assert.deepEqual(systems, []);
  room.stopAllSilently();
  gate.resolve({ ok: true, text: "" });
});

test("5. 방: 잠깐(interject)은 한 줄만 남기고, 버려진 질문 수를 거기서 알린다", async () => {
  const systems = [];
  const { room, gate } = busyRoom(systems);
  await settle();
  room.interject();
  assert.equal(systems.length, 1, JSON.stringify(systems));
  assert.match(systems[0], /사용자가 개입해/);
  assert.match(systems[0], /대기 중이던 질문 1개는 전달되지 않았으니/);
  gate.resolve({ ok: true, text: "" });
});

test("5. 방: 중지(stopAll)는 한 줄만 남긴다. 버릴 질문이 없으면 덧붙이지 않는다", async () => {
  const systems = [];
  const { room, gate } = busyRoom(systems);
  await settle();
  room.stopAll();
  assert.equal(systems.length, 1, JSON.stringify(systems));
  assert.match(systems[0], /^응답을 중지했습니다\./);
  assert.match(systems[0], /대기 중이던 질문 1개/);
  gate.resolve({ ok: true, text: "" });

  const quiet = [];
  const idle = busyRoom(quiet);
  await settle();
  idle.room.cancelTurn(idle.room.turnState().queue[0].turnId);
  quiet.length = 0;
  idle.room.stopAll();
  assert.deepEqual(quiet, ["응답을 중지했습니다."]);
  idle.gate.resolve({ ok: true, text: "" });
});

test("5. 방: 진전 없음 안내는 화면의 버튼 이름(중지)대로 안내한다", async () => {
  const systems = [];
  const gate = Promise.withResolvers();
  const room = makeRoom(systems, ({ emitEvent }) => {
    emitEvent({ kind: "status", label: "12분째 응답 없음" });
    return { promise: gate.promise, cancel: () => {} };
  });
  room.scheduleResponse(room.agents[0]);
  await settle();
  assert.equal(systems.length, 1);
  assert.match(systems[0], /중지한 뒤 다시 보내거나/);
  assert.doesNotMatch(systems[0], /■/);
  room.stopAllSilently();
  gate.resolve({ ok: true, text: "" });
});

test("4. 방: 중지로 끝난 실행과 승인 재시도 앞 실행은 run-discard로 초안을 거둔다", async () => {
  // 중지: 실행 중인 턴을 중지하면 그 runId의 초안을 거두라는 이벤트가 나간다.
  const stopEvents = [];
  const gate = Promise.withResolvers();
  const room = makeRoom([], () => ({ promise: gate.promise, cancel: () => gate.resolve({ ok: false, cancelled: true }) }));
  room.on("run-event", (event) => stopEvents.push(event));
  room.scheduleResponse(room.agents[0]);
  await settle();
  const started = stopEvents.find((event) => event.kind === "run-start");
  assert.ok(started);
  room.stopAll();
  await settle();
  const discard = stopEvents.find((event) => event.kind === "run-discard");
  assert.ok(discard, JSON.stringify(stopEvents.map((event) => event.kind)));
  assert.equal(discard.runId, started.runId);
  assert.equal(stopEvents.some((event) => event.kind === "run-end"), false);

  // 승인 재시도: 첫 실행의 초안은 카드를 기다리는 동안 이미 거둬져 있다.
  const retryEvents = [];
  let runs = 0;
  const retry = new ChatRoom({
    sessionId: "s1",
    agents: [{ id: "a", name: "a", provider: "fake", model: "fake", available: true, enabled: true }],
    meta: { permissionMode: "workspace-write" },
    runAgent: () => {
      runs += 1;
      const result = runs === 1 ? { ok: false, approvalRequired: true, approval: { summary: "권한" } } : { ok: true, text: "끝" };
      return { promise: Promise.resolve(result), cancel() {} };
    },
  });
  retry.on("run-event", (event) => retryEvents.push(event));
  retry.on("approval-request", () => retryEvents.push({ kind: "approval-request" }));
  retry.scheduleResponse(retry.agents[0]);
  await settle();
  const kinds = retryEvents.map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 4), ["run-start", "run-end", "run-discard", "approval-request"], kinds.join(","));
  retry.resolveApproval([...retry.pendingApprovals.keys()][0], "approve");
  await settle();
  assert.equal(runs, 2);
});

// ---------------------------------------------------------------- 렌더러(chat.js를 가짜 DOM에서 실행)

const html = read("src/chat.html");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

function makeElement(id = "", tag = "") {
  const listeners = {};
  let text = "";
  const el = {
    id, tagName: tag.toUpperCase(), hidden: false, disabled: false, value: "", title: "", className: "", placeholder: "",
    get textContent() { return text; },
    set textContent(value) { text = String(value); el.children = []; },
    children: [], options: [], dataset: {}, parent: null, listeners,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    append(...nodes) { for (const node of nodes) { if (node && typeof node === "object") node.parent = el; el.children.push(node); } },
    appendChild(node) { el.append(node); return node; },
    replaceChildren(...nodes) { el.children = []; el.append(...nodes); },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((child) => child !== el); },
    setAttribute() {}, getAttribute: () => null, focus() {}, blur() {}, select() {},
    setSelectionRange() {}, scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    selectionStart: 0, scrollHeight: 0, scrollTop: 0, clientHeight: 0, offsetWidth: 0,
  };
  return el;
}

function findAll(node, predicate, found = []) {
  if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    for (const child of node.children || []) findAll(child, predicate, found);
  }
  return found;
}

// 노드 밑의 글자를 모두 모은다.
function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return (node.textContent || "") + (node.children || []).map(textOf).join(" ");
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

function loadRenderer({ sessions, project = {}, tasks = [] }) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => makeElement(), querySelectorAll: () => [],
    createElement: (tag) => makeElement("", tag), createTextNode: (text) => ({ textContent: text }),
    documentElement: makeElement("root"), body: makeElement("body"), addEventListener() {},
    activeElement: null, hasFocus: () => true,
  };
  const calls = [];
  const subscribers = {};
  const projectInfo = { id: "p1", name: "프로젝트", workspace: "D:/work", context: "", defaultPermissionMode: "workspace-write", defaultAgents: {}, ...project };
  const fullFor = (id) => ({
    sessions: [{ id: "s1", title: "s1", projectId: "p1" }, { id: "s2", title: "s2", projectId: "p1" }],
    sessionsByProject: { p1: [{ id: "s1", title: "s1", projectId: "p1" }, { id: "s2", title: "s2", projectId: "p1" }] },
    projects: [projectInfo],
    activeProjectId: "p1",
    providers: [], diagnostics: [], discussionPresets: [],
    workflow: { decisions: [], tasks, roles: [{ id: "implementation", label: "구현" }, { id: "review", label: "검토" }], statuses: ["todo", "done"] },
    activeSessionId: id,
    session: sessions[id],
  });
  const chatApi = new Proxy({}, {
    get(_target, name) {
      if (name === "state") return () => Promise.resolve(fullFor("s1"));
      if (typeof name === "string" && name.startsWith("on")) return (handler) => { subscribers[name] = handler; return () => {}; };
      return (...args) => { calls.push({ name, args }); return Promise.resolve({ ok: true }); };
    },
  });
  const errors = [];
  const context = {
    document,
    window: { chatApi, innerWidth: 1280, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
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
  return {
    el, calls, subscribers, errors, run,
    // 다른 방으로 옮겨 가는 상태 적용(사이드바 선택이 받는 응답과 같은 모양).
    apply(id) { context.__full = fullFor(id); run("applyFullState(__full)"); },
    project: projectInfo,
    openProjectSettings() { context.__project = projectInfo; run("openProjectSettings(document.createElement('div'), __project)"); },
  };
}

async function boot(options) {
  const ui = loadRenderer(options);
  await settle();
  await settle();
  assert.deepEqual(ui.errors, []);
  return ui;
}

test("2. 화면: 보지 않는 방의 저장 실패 안내는 버리지 않고 그 방이 열릴 때 한 번 보여 준다", async () => {
  const ui = await boot({ sessions: { s1: roomState("s1"), s2: roomState("s2") } });
  const list = ui.el("message-list");
  const notice = "대화 기록을 디스크에 저장하지 못했습니다.";
  ui.subscribers.onSystemNotice({ text: notice, sessionId: "s2" });
  ui.subscribers.onSystemNotice({ text: notice, sessionId: "s2" }); // 같은 안내가 또 와도 한 줄
  assert.equal(findAll(list, (node) => textOf(node).includes(notice)).length, 0, "열려 있지 않은 방에는 그리지 않는다");

  ui.apply("s2");
  assert.ok(textOf(list).includes(notice), "그 방을 열면 보인다");
  assert.equal(textOf(list).split(notice).length - 1, 1, "한 번만 보인다");

  ui.apply("s1");
  ui.apply("s2");
  assert.equal(textOf(list).split(notice).length - 1, 0, "보여 준 안내는 비워진다(다시 오지 않는다)");

  // 열려 있는 방의 안내는 지금 바로 보인다.
  ui.subscribers.onSystemNotice({ text: "지금 방 안내", sessionId: "s2" });
  assert.ok(textOf(list).includes("지금 방 안내"));
});

test("3. 화면: 목록에 없는 기록 담당도 옵션으로 보여 선택돼 있고, '기록 안 함'은 빈 값으로 저장된다", async () => {
  const sessions = { s1: roomState("s1") };
  // (a) 사용할 수 없는 담당(꺼짐)을 저장한 프로젝트
  const ui = await boot({ sessions, project: { recordAgent: "ghost", defaultAgents: { claude: { enabled: false } } } });
  ui.openProjectSettings();
  const popover = ui.el("popover");
  const [select] = findAll(popover, (node) => node.tagName === "SELECT" && node.children.some((child) => child.textContent === "기록 안 함"));
  assert.ok(select, "토론 자동 기록 선택이 있어야 한다");
  const labels = select.children.map((child) => child.textContent);
  assert.ok(labels.includes("(지금 사용할 수 없음) ghost"), labels.join(" | "));
  assert.equal(select.value, "ghost", "저장된 담당이 선택돼 있다");
  assert.ok(!labels.some((label) => label.includes("Claude")), "꺼진 에이전트는 목록에 없다");

  const [saveButton] = findAll(popover, (node) => node.textContent === "저장"); // 저장하면 팝오버가 닫히므로 미리 잡는다.
  const clickSave = () => saveButton.listeners.click.at(-1)();
  clickSave();
  await settle();
  const untouched = ui.calls.filter((call) => call.name === "projectsUpdate").at(-1);
  assert.equal("recordAgent" in untouched.args[1], false, "건드리지 않으면 보내지 않는다");

  select.value = "";
  clickSave();
  await settle();
  const off = ui.calls.filter((call) => call.name === "projectsUpdate").at(-1);
  assert.equal(off.args[1].recordAgent, "", "기록 안 함은 빈 문자열로 저장된다");

  // (b) 옛 recorder 역할만 있는 프로젝트는 그 담당이 선택돼 보이고, 쓸 수 없으면 라벨이 붙는다.
  const legacy = await boot({ sessions, project: { legacyRecorder: { agentId: "codex" }, defaultAgents: { codex: { enabled: false } } } });
  legacy.openProjectSettings();
  const [legacySelect] = findAll(legacy.el("popover"), (node) => node.tagName === "SELECT" && node.children.some((child) => child.textContent === "기록 안 함"));
  assert.equal(legacySelect.value, "codex");
  assert.ok(legacySelect.children.some((child) => child.value === "codex" && /지금 사용할 수 없음/.test(child.textContent) && /GPT/.test(child.textContent)));

  // (c) 쓸 수 있는 담당은 라벨 없이 그대로 선택된다.
  const fine = await boot({ sessions, project: { recordAgent: "claude" } });
  fine.openProjectSettings();
  const [fineSelect] = findAll(fine.el("popover"), (node) => node.tagName === "SELECT" && node.children.some((child) => child.textContent === "기록 안 함"));
  assert.equal(fineSelect.value, "claude");
  assert.equal(fineSelect.children.filter((child) => child.value === "claude").length, 1);
  assert.ok(!fineSelect.children.some((child) => /지금 사용할 수 없음/.test(child.textContent)));
});

test("4. 화면: run-discard가 오면 점선 초안 말풍선을 거두고, 다른 방의 이벤트는 건드리지 않는다", async () => {
  const ui = await boot({ sessions: { s1: roomState("s1") } });
  const list = ui.el("message-list");
  const live = () => findAll(list, (node) => /(^|\s)is-live(\s|$)/.test(node.className));
  ui.subscribers.onRunEvent({ sessionId: "s1", runId: "r1", agentId: "claude", kind: "run-start" });
  ui.subscribers.onRunEvent({ sessionId: "s1", runId: "r2", agentId: "codex", kind: "run-start" });
  assert.equal(live().length, 2);
  assert.equal(ui.run("liveRuns.size"), 2);

  ui.subscribers.onRunEvent({ sessionId: "s2", runId: "r1", agentId: "claude", kind: "run-discard" });
  assert.equal(live().length, 2, "다른 방의 이벤트는 무시한다");
  ui.subscribers.onRunEvent({ sessionId: "s1", runId: "r1", agentId: "claude", kind: "run-discard" });
  assert.equal(live().length, 1);
  assert.equal(ui.run("liveRuns.has('r1')"), false);
  // 이미 사라진 초안에 또 와도 오류가 없다.
  ui.subscribers.onRunEvent({ sessionId: "s1", runId: "r1", agentId: "claude", kind: "run-discard" });
  // 성공한 실행은 기존처럼 정식 메시지가 초안을 대체한다.
  ui.subscribers.onMessage({ sessionId: "s1", message: { id: "m1", authorType: "agent", author: "codex", text: "답", runId: "r2", ts: 1 } });
  assert.equal(live().length, 0);
  assert.deepEqual(ui.errors, []);
});

test("6. 화면: 작업 카드와 새 작업 폼에 역할 선택·역할 표기가 없다", async () => {
  const tasks = [
    { id: "t1", projectId: "p1", title: "옛 작업", description: "", contentSource: "inline", taskPath: null, status: "todo", role: "review", agentId: null },
    { id: "t2", projectId: "p1", title: "담당 있는 작업", description: "", contentSource: "inline", taskPath: null, status: "todo", role: "planning", agentId: "claude" },
  ];
  const ui = await boot({ sessions: { s1: roomState("s1") }, tasks });
  ui.el("btn-workflow").listeners.click.at(-1)();
  const popover = ui.el("popover");

  const cards = findAll(popover, (node) => node.className === "workflow-card");
  assert.equal(cards.length, 2);
  const metas = findAll(popover, (node) => node.className === "workflow-card-meta").map((node) => node.textContent);
  assert.deepEqual(metas, ["담당자 미지정 · 결정 미연결", "@claude · 결정 미연결"]);
  for (const card of cards) {
    const [actions] = findAll(card, (node) => node.className === "workflow-card-actions");
    assert.equal(actions.children.filter((node) => node.tagName === "SELECT").length, 2, "상태·담당자 선택만 남는다");
  }
  const labels = findAll(popover, (node) => node.tagName === "LABEL").map((node) => node.children[0]?.textContent);
  assert.ok(labels.includes("담당 에이전트"));
  assert.ok(!labels.includes("역할"), "새 작업 폼에도 역할 칸이 없다");
  for (const word of ["기획", "검토", "구현"]) {
    assert.equal(findAll(popover, (node) => textOf(node) === word).length, 0, `${word} 선택지가 남아 있다`);
  }

  // 저장·수정은 역할을 보내지 않아 저장된 값을 건드리지 않는다.
  findAll(cards[0], (node) => node.textContent === "저장")[0].listeners.click.at(-1)();
  await settle();
  const update = ui.calls.filter((call) => call.name === "tasksUpdate").at(-1);
  assert.deepEqual(Object.keys(update.args[2]).sort(), ["agentId", "status"]);
  const [titleField] = findAll(popover, (node) => node.tagName === "INPUT" && node.placeholder === "작업 제목");
  titleField.value = "새로 만든 작업";
  findAll(popover, (node) => node.textContent === "작업 만들기")[0].listeners.click.at(-1)();
  await settle();
  const create = ui.calls.filter((call) => call.name === "tasksCreate").at(-1);
  assert.equal("role" in create.args[0], false);
});
