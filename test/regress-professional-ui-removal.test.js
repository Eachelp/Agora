"use strict";

// 전문 모드 화면을 걷어낸 뒤에도 채팅 화면이 그대로 뜨고 일반 대화가 이어지는지 본다.
// 실제 chat.html의 id 목록으로 가짜 DOM을 만들고 chat.js를 통째로 실행하므로, 렌더러가
// 지워진 요소를 찾으면(null.addEventListener) 여기서 바로 실패한다. 옛 백엔드 응답
// (specialist 상태·역할 설정·자동 보완 정책)이 그대로 와도 화면이 읽고 무시해야 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const html = read("src/chat.html");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

function makeElement(id = "") {
  const listeners = {};
  const el = {
    id,
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    title: "",
    className: "",
    children: [],
    options: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    listeners,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    blur() {},
    select() {},
    setSelectionRange() {},
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    selectionStart: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    offsetWidth: 0,
  };
  return el;
}

function loadRenderer({ state }) {
  const elements = new Map();
  const missing = [];
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) { missing.push(id); return null; }
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    documentElement: makeElement("root"),
    body: makeElement("body"),
    addEventListener() {},
    activeElement: null,
    hasFocus: () => true,
  };
  const calls = [];
  const subscribers = {};
  const chatApi = new Proxy({}, {
    get(_target, name) {
      if (name === "state") return () => Promise.resolve(state);
      if (typeof name === "string" && name.startsWith("on")) {
        return (handler) => { subscribers[name] = handler; return () => {}; };
      }
      return (...args) => {
        calls.push({ name, args });
        return Promise.resolve({ ok: true });
      };
    },
  });
  const storage = new Map();
  const errors = [];
  const context = {
    document,
    window: {
      chatApi,
      innerWidth: 1280,
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    CSS: { escape: (value) => String(value) },
    console: { ...console, error: (...args) => errors.push(args.join(" ")) },
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0,
    clearTimeout() {},
    ResizeObserver: undefined,
  };
  context.window.document = document;
  vm.createContext(context);
  for (const file of ["src/chat-markdown.js", "src/usage-view.js", "src/awaiting-view.js"]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // 브라우저에서는 window가 전역이라 이 세 모듈이 그대로 전역 이름이 된다.
  Object.assign(context, {
    chatMarkdown: context.window.chatMarkdown,
    usageView: context.window.usageView,
    awaitingView: context.window.awaitingView,
  });
  return { context, elements, missing, calls, subscribers, errors, run: (code) => vm.runInContext(code, context, { filename: "src/chat.js" }) };
}

const fullState = () => ({
  providers: [],
  diagnostics: [],
  discussionPresets: [],
  workflow: { decisions: [], tasks: [], roles: [], statuses: [] },
  // 옛 백엔드가 아직 보내는 값들: 프로젝트 역할·자동 보완 정책, 방의 전문 실행 상태.
  projects: [{
    id: "p1", name: "프로젝트", workspace: "D:/work", context: "",
    defaultPermissionMode: "workspace-write", defaultAgents: {},
    defaultRoles: { planning: { agentId: "claude" }, review: { agentId: "claude" } },
    autoRevisions: { plan: 2, implementation: 1 },
  }],
  activeProjectId: "p1",
  sessions: [{ id: "s1", title: "대화", projectId: "p1" }],
  sessionsByProject: { p1: [{ id: "s1", title: "대화", projectId: "p1" }] },
  activeSessionId: "s1",
  session: {
    meta: { id: "s1", title: "대화", permissionMode: "workspace-write", workspace: "D:/work" },
    agents: [
      { id: "claude", name: "Claude", aliases: ["claude"], color: "#c96", available: true, enabled: true },
      { id: "codex", name: "GPT", aliases: ["gpt"], color: "#396", available: true, enabled: true },
    ],
    specialist: {
      active: true, available: true, blocked: true, node: "IMPLEMENTING", status: "BLOCKED",
      stopReason: "BLOCKED", needsInput: true, planReady: true, canRestore: true,
    },
    typing: [],
    turnState: { current: null, running: [], queue: [], deferred: [] },
    pendingAttachments: [],
    messages: [{
      id: "m1", authorType: "agent", author: "claude", text: "답",
      ts: 1, agentMeta: { specialistStage: "planner", taskId: "TASK-1", taskHash: "abcdef123" },
    }],
  },
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("chat.html에서 전문 모드 화면 요소가 모두 빠졌고 일반 화면 요소는 남았다", () => {
  for (const id of [
    "btn-specialist", "professional-actions", "btn-professional-plan", "btn-professional-implementation",
    "btn-professional-record", "btn-professional-full", "btn-professional-plan-view",
    "badge-professional-plan", "badge-professional-implementation", "professional-status-detail",
    "professional-blocked", "plan-auto-revise", "plan-auto-limit", "implementation-auto-revise",
    "implementation-auto-limit", "specialist-approvals", "specialist-choice-bar", "specialist-backdrop",
    "specialist-body", "specialist-cancel", "specialist-close", "permission-warning",
  ]) {
    assert.ok(!htmlIds.has(id), `${id} 요소가 남아 있습니다`);
  }
  assert.doesNotMatch(html, /work-mode|전문 실행|막힘 처리|일반 대화와 전문/);
  // 프로젝트 기록·토론·권한·답변 대기·이어/독립 발언·권한 요청 카드는 그대로다.
  for (const id of [
    "btn-workflow", "btn-discussion", "btn-workspace", "permission-select", "awaiting-row",
    "response-mode-bar", "btn-mode-sequential", "btn-mode-independent", "approval-backdrop",
    "approval-approve", "approval-deny", "composer-input", "btn-send", "btn-stop", "btn-attach",
  ]) {
    assert.ok(htmlIds.has(id), `${id} 요소가 없어졌습니다`);
  }
});

test("chat.js는 지워진 요소를 찾지 않고, 옛 백엔드 상태가 와도 화면이 그려진다", async () => {
  const { missing, errors, elements, run } = loadRenderer({ state: fullState() });
  run(read("src/chat.js"));
  await settle();
  await settle();
  assert.deepEqual(missing, [], "chat.html에 없는 id를 찾습니다");
  assert.deepEqual(errors, [], "렌더러가 오류를 냈습니다");
  // 옛 specialist 상태·프로젝트 역할이 와도 입력칸은 잠기지 않고 보통 입력이다.
  const composer = elements.get("composer-input");
  assert.equal(composer.disabled, false);
  assert.match(composer.placeholder, /질문이나 작업을 입력하세요/);
  assert.equal(elements.get("btn-send").disabled, false);
  assert.equal(elements.get("btn-send").textContent, "전송");
  // 권한 선택은 방 설정을 그대로 보이고, 참가자가 둘이면 @모두 응답 방식 줄이 열린다.
  assert.equal(elements.get("permission-select").value, "workspace-write");
  assert.equal(elements.get("response-mode-bar").hidden, false);
  // 메시지 한 건이 그려졌다(전문 단계 배지·Frozen Task 칩 없이).
  assert.ok(elements.get("message-list").children.length >= 1);
});

test("일반 전송은 4개 인자만 보내고, 전문 모드 인자(professionalDraft·정책)는 없다", async () => {
  const { elements, calls, run } = loadRenderer({ state: fullState() });
  run(read("src/chat.js"));
  await settle();
  await settle();
  const composer = elements.get("composer-input");
  composer.value = "@claude 안녕";
  const keydown = composer.listeners.keydown.at(-1);
  keydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  await settle();
  const send = calls.find((call) => call.name === "send");
  assert.ok(send, "chatApi.send가 불리지 않았습니다");
  assert.equal(send.args.length, 4, "전문 모드 인자가 남아 있습니다");
  assert.deepEqual(send.args.slice(0, 3), ["s1", "@claude 안녕", []]);
  assert.equal(send.args[3], false);
});

test("@ 자동완성 목록은 참가자와 @모두뿐이고 역할 호출·@팀은 없다", async () => {
  const { run } = loadRenderer({ state: fullState() });
  run(read("src/chat.js"));
  await settle();
  await settle();
  const targets = run("mentionTargets().map((target) => target.alias).join(',')");
  assert.equal(targets, "claude,gpt,모두");
});

test("preload는 전문 모드 API를 노출하지 않고 일반 대화·프로젝트 기록·끼어들기 API는 남긴다", () => {
  const preload = read("src/chat-preload.js");
  assert.doesNotMatch(preload, /specialist|SPECIALIST|TASK_OPEN_FILE|TASK_READ_FILE|openTaskFile|readTaskFile|professionalDraft/);
  for (const keep of [
    "memoryRead", "memoryAppend", "rulesRead", "rulesSave", "decisionsCreate", "decisionsResolve",
    "tasksCreate", "tasksResolve", "turnInterject", "turnCancel", "workspaceChoose", "workspaceClear",
    "projectsWorkspaceChoose", "projectsWorkspaceClear", "awaitingDismiss", "handoffMessage",
    "discussionStart", "approvalRespond", "openRunLogFolder",
  ]) {
    assert.match(preload, new RegExp(`\\b${keep}\\b`), `${keep}가 없어졌습니다`);
  }
});

test("프로젝트 설정에는 전문 모드 역할·자동 보완 항목이 없고, 저장해도 그 값을 건드리지 않는다", () => {
  const renderer = read("src/chat.js");
  assert.doesNotMatch(renderer, /전문 모드 역할 설정|전문 실행 자동 보완|기획 검수 \(선택\)|defaultRoles|autoRevisions/);
  // 저장 패치에는 이름·공통 맥락·권한·기본 에이전트만 실린다(생략된 필드는 백엔드가 보존한다).
  const save = renderer.slice(renderer.indexOf("window.chatApi.projectsUpdate(project.id, {"));
  const patch = save.slice(0, save.indexOf("}));"));
  assert.match(patch, /name: name\.value/);
  assert.match(patch, /defaultAgents/);
  assert.doesNotMatch(patch, /defaultRoles|autoRevisions/);
});
