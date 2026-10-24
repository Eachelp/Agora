"use strict";

// 기억 애드온 화면(채팅 창): 기억하기, 방 머리줄, 프로젝트 설정 스위치, 프로젝트 기록의 AnchorMind 탭.
// chat.js의 실제 함수를 격리된 컨텍스트에서 돌리고 DOM·IPC만 대체한다. Google 호출은 없다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { UiNode, makeUiDocument } = require("./regress-ui-dom.cjs");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const source = read("src/chat.js");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "구간을 찾지 못했습니다: " + start);
  return source.slice(from, to);
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const button = (root, label) => root.find((node) => node.tagName === "BUTTON" && node.textContent === label);
const press = (node) => node.dispatch("click", { stopPropagation() {} });

// 실제 call()과 주어진 구간을 한 스크립트로 돌린다. 팝오버는 화면에 붙은 것으로 둔다(rootMark → isConnected).
function load(sections, globals) {
  const popover = new UiNode("div");
  popover.rootMark = true;
  const notices = [];
  const context = {
    document: makeUiDocument(),
    popover,
    notices,
    flashNotice: (text, isError = true) => notices.push({ text, isError }),
    openPopover(_anchor, build) { popover.textContent = ""; popover.className = ""; build(popover); popover.hidden = false; },
    closePopover() { popover.textContent = ""; popover.hidden = true; },
    makeField(_label, control) { const field = new UiNode("label"); field.append(control); return field; },
    requestAnimationFrame: (fn) => fn(),
    ...globals,
  };
  vm.createContext(context);
  vm.runInContext([section("async function call(", "// --- 세션 사이드바 ---"), ...sections].join("\n"), context);
  return context;
}

const REMEMBER = () => section("const ANCHORMIND_TYPE_LABELS", "// 토론 결론 종합 팝오버");
const TYPES = [["fact", "사실"], ["decision", "결정"], ["procedure", "절차"], ["error", "에러"], ["preference", "선호"]];

test("기억하기: 오류가 아닌 AI 답과 사용자 말에 있고, 고른 유형과 다듬은 글을 그 방·메시지로 한 번만 보낸다", async () => {
  const calls = [];
  const ui = load([
    section("function stripMarkdown(", "// 클릭하면 클립보드에 넣고"),
    section("function workflowTextarea(", "function makeDeliveryBadge("),
    section("function makeCopyButton(", "// 같은 시스템 알림이 연달아 오면"),
    REMEMBER(),
  ], {
    activeSessionId: "room-a", sessionMeta: { id: "room-a" }, agentById: () => null, formatTime: () => "12:00",
    renderTextWithMentions: (bubble, text) => { bubble.textContent = text; },
    renderAgentMessageContent: (bubble, message) => { bubble.textContent = message.text; },
    renderFailedMessage: (bubble, message) => { bubble.textContent = message.text; },
    makeAgentAvatar: () => new UiNode("span"),
    window: { chatApi: { anchorMindRemember: async (...args) => {
      calls.push(args);
      return calls.length === 1 ? { ok: false, error: "저장하지 못했습니다." } : { ok: true };
    } } },
  });
  const long = "**배포는** 승인 뒤에만 한다. ".repeat(40);
  const labels = (item) => item.findAll((node) => node.tagName === "BUTTON").map((node) => node.textContent);

  assert.deepEqual(labels(ui.renderMessage({ id: "a1", authorType: "agent", author: "claude", text: long, ts: 1 })),
    ["복사", "서식 없이 복사", "쉽게 설명", "다른 AI에게 전달", "기억하기"]);
  assert.deepEqual(labels(ui.renderMessage({ id: "a2", authorType: "agent", author: "claude", text: "실패", error: true, ts: 1 })),
    ["복사", "서식 없이 복사", "쉽게 설명", "다른 AI에게 전달"], "오류 메시지에는 기억하기가 없다");
  const user = ui.renderMessage({ id: "u1", authorType: "user", text: long, ts: 1 });
  assert.deepEqual(labels(user), ["기억하기"]);

  press(button(user, "기억하기"));
  const select = ui.popover.find((node) => node.tagName === "SELECT");
  const text = ui.popover.find((node) => node.tagName === "TEXTAREA");
  assert.deepEqual(plain(select.children.map((option) => [option.value, option.textContent])), TYPES);
  assert.equal(text.value, ui.stripMarkdown(long).slice(0, 300));
  assert.equal(text.maxLength, 300);
  assert.equal(ui.popover.byClass("workflow-count")[0].textContent, "300 / 300");

  const save = button(ui.popover, "저장");
  save.click();
  save.click(); // 보내는 동안은 꺼져 있어 두 번째는 반응하지 않는다
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(save.disabled, false, "실패하면 다시 누를 수 있다");
  assert.equal(ui.popover.hidden, false, "실패하면 팝오버가 남는다");
  assert.equal(ui.notices.at(-1).text, "저장하지 못했습니다.");

  select.value = "decision";
  text.type_("배포는 별도 승인 뒤에만 한다.");
  assert.equal(ui.popover.byClass("workflow-count")[0].textContent, "17 / 300");
  save.click();
  await settle();
  assert.deepEqual(plain(calls[1]), ["room-a", "u1", "decision", "배포는 별도 승인 뒤에만 한다."]);
  assert.equal(ui.popover.hidden, true);
  assert.deepEqual(plain(ui.notices.at(-1)), { text: "AnchorMind에 기억했습니다.", isError: false });
});

test("방 머리줄: 앱 전체 스위치와 이 프로젝트의 스위치가 모두 켜졌을 때만 상태를 보이고 기억하기 표시를 켠다", async () => {
  const messageList = new UiNode("ol");
  const statusEl = new UiNode("span");
  let project = { id: "p", anchorMindEnabled: true };
  let push = null;
  const ui = load([
    section("let anchorMindStatus", "function renderHeader("),
    section("window.chatApi.onAnchorMindStatus?.(", "function lockComposer("),
  ], {
    messageList, anchorMindStatusEl: statusEl, activeProjectEntry: () => project,
    window: { chatApi: {
      anchorMindStatus: async () => ({ ok: true, status: { enabled: true, state: "starting" } }),
      onAnchorMindStatus: (handler) => { push = handler; },
    } },
  });
  const shown = () => !statusEl.hidden && messageList.classList.contains("is-anchormind");
  ui.renderAnchorMindStatus(); // 상태를 아직 모를 때의 첫 그림은 던지지 않고 숨는다
  assert.equal(statusEl.hidden, true);
  assert.equal(statusEl.textContent, "기억 · 꺼짐");
  await settle();
  assert.equal(statusEl.textContent, "기억 · 켜는 중");
  assert.equal(shown(), true);

  push({ enabled: true, state: "connected" });
  assert.equal(statusEl.textContent, "기억 · 연결됨");
  push({ enabled: false, state: "off" }); // 앱 전체 스위치가 꺼지면 프로젝트 스위치가 켜져 있어도 숨는다
  assert.equal(statusEl.hidden, true);
  assert.equal(messageList.classList.contains("is-anchormind"), false);
  push({ enabled: true, state: "error" });
  assert.equal(statusEl.textContent, "기억 · 오류");
  assert.equal(shown(), true);

  project = { id: "p" }; // 이 프로젝트에서 기억을 끔
  ui.renderAnchorMindStatus();
  assert.equal(statusEl.hidden, true);
  assert.equal(messageList.classList.contains("is-anchormind"), false);
  assert.match(section("function renderHeader()", "const orchestrator = sessionMeta?.orchestrator"), /renderAnchorMindStatus\(\);/);
});

test("프로젝트 설정: 'AnchorMind 기억 사용'은 바꿨을 때만 보내고, 미분류 프로젝트에는 두지 않는다", async () => {
  const patches = [];
  const open = (project) => {
    const ui = load([section("function openProjectSettings(", "async function selectProject(")], {
      agents: [], applyFullState() {}, confirmInApp: async () => true,
      window: { chatApi: { projectsUpdate: async (_id, patch) => { patches.push(plain(patch)); return {}; } } },
    });
    ui.openProjectSettings({}, { name: "P", context: "", defaultPermissionMode: "chat", defaultAgents: {}, ...project });
    return ui;
  };
  const checkbox = (ui) => ui.popover.find((node) => node.tagName === "INPUT" && node.type === "checkbox");
  const save = async (ui) => { button(ui.popover, "저장").click(); await settle(); };

  assert.equal(checkbox(open({ id: "uncategorized" })), null);
  const off = open({ id: "p" });
  assert.equal(checkbox(off).checked, false);
  await save(off);
  assert.equal("anchorMindEnabled" in patches[0], false, "건드리지 않으면 보내지 않는다");
  const turnOn = open({ id: "p" });
  checkbox(turnOn).click();
  await save(turnOn);
  assert.equal(patches[1].anchorMindEnabled, true);
  const turnOff = open({ id: "p", anchorMindEnabled: true });
  assert.equal(checkbox(turnOff).checked, true);
  checkbox(turnOff).click();
  await save(turnOff);
  assert.equal(patches[2].anchorMindEnabled, false);
});

// 프로젝트 기록 팝오버를 실제 chat.js 구간으로 연다. 목록·지우기·고치기 호출은 calls에 쌓는다.
function loadWorkflow(project, { status = { enabled: true }, items = [], confirmAnswer = true } = {}) {
  const calls = [];
  const confirm = { asked: [], answer: confirmAnswer };
  const ui = load([REMEMBER(), section("const WORKFLOW_STATUS_LABELS", "workflowButton.addEventListener(")], {
    activeProjectEntry: () => project, anchorMindStatus: status,
    workflow: { decisions: [], tasks: [], statuses: [] }, agents: [], chatMessages: [], activeSessionId: "s", applyFullState() {},
    confirmInApp: async (message) => { confirm.asked.push(message); return confirm.answer; },
    window: { chatApi: {
      rulesRead: async () => ({ rules: "", history: "" }),
      memoryRead: async () => ({ content: "" }),
      anchorMindList: async (projectId) => { calls.push(["list", projectId]); return { ok: true, items }; },
      anchorMindForget: async (projectId, id) => { calls.push(["forget", projectId, id]); return { ok: true }; },
      anchorMindAmend: async (...args) => { calls.push(["amend", ...args]); return { ok: true }; },
    } },
  });
  ui.openWorkflowPopover({ getBoundingClientRect: () => ({}) });
  const tabs = () => ui.popover.byClass("workflow-tab-button").map((tab) => tab.textContent);
  const cards = () => ui.popover.byClass("workflow-card");
  const labels = (card) => card.findAll((node) => node.tagName === "BUTTON").map((node) => node.textContent);
  const open = async () => { button(ui.popover, "AnchorMind").click(); await settle(); };
  return { ui, calls, confirm, tabs, cards, labels, open };
}
const ON = { id: "p", name: "P", context: "", anchorMindEnabled: true };
const ITEMS = [
  { id: "f1", type: "decision", content: "배포는 별도 승인 뒤에만 한다.", createdAt: "2026-10-24T01:02:03.000Z" },
  { id: "e1", type: "episode", content: "토론 요약입니다.", createdAt: "2026-10-23T00:00:00.000Z" },
];

test("AnchorMind 탭: 앱 전체와 프로젝트에서 모두 기억을 켰을 때만 맨 뒤에 생기고, 고를 때 그 프로젝트의 목록을 읽는다", async () => {
  const base = ["메모리", "결정", "작업"];
  assert.deepEqual(loadWorkflow({ ...ON, anchorMindEnabled: false }).tabs(), base);
  assert.deepEqual(loadWorkflow(ON, { status: { enabled: false } }).tabs(), base, "앱 전체 스위치가 꺼져 있으면 없다");
  assert.deepEqual(loadWorkflow(ON, { status: null }).tabs(), base, "상태를 아직 모르면 없다");

  const view = loadWorkflow(ON, { items: ITEMS });
  assert.deepEqual(view.tabs(), [...base, "AnchorMind"]);
  assert.deepEqual(view.calls, [], "탭을 고르기 전에는 읽지 않는다");
  await view.open();
  assert.deepEqual(plain(view.calls), [["list", "p"]]);
  const cards = view.cards();
  assert.deepEqual(cards.map((card) => card.find((node) => node.className === "workflow-card-title").textContent), ["결정", "요약"]);
  assert.deepEqual(cards.map((card) => card.find((node) => node.className === "workflow-card-text").textContent),
    ["배포는 별도 승인 뒤에만 한다.", "토론 요약입니다."]);
  for (const card of cards) assert.doesNotMatch(card.find((node) => node.className === "workflow-card-meta").textContent, /Invalid Date/);
  assert.deepEqual(view.labels(cards[0]), ["고치기", "지우기"]);
  assert.deepEqual(view.labels(cards[1]), ["지우기"], "기록관 요약은 지우기만 있다");

  // 탭을 보던 중 앱 전체 스위치가 꺼진 뒤 팝오버가 다시 만들어져도, 없어진 탭 대신 메모리 탭이 열린다
  view.ui.anchorMindStatus = { enabled: false };
  view.ui.refreshWorkflowPopover({ getBoundingClientRect: () => ({}) });
  const active = view.ui.popover.byClass("workflow-tab-button").filter((tab) => tab.classList.contains("is-active"));
  assert.deepEqual(active.map((tab) => tab.textContent), ["메모리"]);

  const lastPanel = (v) => v.ui.popover.byClass("workflow-tab-panel").at(-1).textContent;
  const empty = loadWorkflow(ON, { items: [] });
  await empty.open();
  assert.match(lastPanel(empty), /아직 저장한 기억이 없습니다/);
  const failing = loadWorkflow(ON);
  failing.ui.window.chatApi.anchorMindList = async () => ({ ok: false, error: "연결하지 못했습니다." });
  await failing.open();
  assert.match(lastPanel(failing), /기억을 불러오지 못했습니다/);
});

test("AnchorMind 탭: 지우기는 확인을 받은 뒤 그 프로젝트의 그 기억만 지우고 목록을 다시 읽는다", async () => {
  const view = loadWorkflow(ON, { items: ITEMS, confirmAnswer: false });
  await view.open();
  button(view.cards()[0], "지우기").click();
  await settle();
  assert.deepEqual(plain(view.calls), [["list", "p"]], "아니라고 하면 지우지 않는다");
  assert.deepEqual(view.confirm.asked, ["이 기억을 지울까요?\nAnchorMind에서 지우며 되돌릴 수 없습니다."]);

  view.confirm.answer = true;
  button(view.cards()[0], "지우기").click();
  await settle();
  assert.deepEqual(plain(view.calls), [["list", "p"], ["forget", "p", "f1"], ["list", "p"]]);
});

test("AnchorMind 탭: 고치기는 카드 안에서 유형·내용을 바꿔 한 번만 보내고, 취소하면 원래 카드로 돌아간다", async () => {
  const view = loadWorkflow(ON, { items: [{ id: "f1", type: "procedure", content: "원래 내용입니다.", createdAt: "2026-10-24T01:02:03.000Z" }] });
  await view.open();
  const card = () => view.cards()[0];
  button(card(), "고치기").click();
  const select = card().find((node) => node.tagName === "SELECT");
  const text = card().find((node) => node.tagName === "TEXTAREA");
  assert.equal(select.value, "procedure");
  assert.deepEqual(view.labels(card()), ["저장", "취소"], "고치기 화면에는 보기 화면의 버튼이 남지 않는다");
  assert.deepEqual(plain(select.children.map((option) => [option.value, option.textContent])), TYPES);
  assert.equal(text.value, "원래 내용입니다.");
  assert.equal(text.maxLength, 300);
  button(card(), "취소").click();
  assert.equal(card().find((node) => node.className === "workflow-card-text").textContent, "원래 내용입니다.");
  assert.deepEqual(view.labels(card()), ["고치기", "지우기"]);

  button(card(), "고치기").click();
  card().find((node) => node.tagName === "SELECT").value = "preference";
  card().find((node) => node.tagName === "TEXTAREA").type_("고친 내용입니다");
  const save = button(card(), "저장");
  save.click();
  save.click();
  await settle();
  assert.deepEqual(plain(view.calls), [["list", "p"], ["amend", "p", "f1", "preference", "고친 내용입니다"], ["list", "p"]]);
});

test("기억 애드온 화면 연결: 꺼 두면 숨기는 CSS 규칙과 버튼 클래스, 기억하기 팝오버 변형, 설정 창이 찾는 id가 서로 맞는다", () => {
  assert.match(read("src/chat.css"), /\.message-list:not\(\.is-anchormind\) \.message-remember-button,\s*\.message-list:not\(\.is-anchormind\) \.message\.is-user \.message-actions \{\s*display: none;/);
  assert.match(source, /rememberBtn\.className = "message-remember-button"/);
  assert.match(source, /const POPOVER_VARIANTS = \[[^\]]*"is-remember"/);
  const settingsHtml = read("src/settings.html");
  const ids = [...read("src/settings.js").matchAll(/\$\("#(anchormind-[\w-]+)"\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 8, "설정 창이 쓰는 기억 애드온 id를 찾지 못했습니다");
  for (const id of ids) assert.match(settingsHtml, new RegExp('id="' + id + '"'), "settings.html에 #" + id + "가 없습니다");
});

test("기억 애드온 화면이 부르는 API는 preload가 모두 내놓는다", () => {
  const preload = read("src/chat-preload.js");
  const used = [...new Set([...source.matchAll(/chatApi\.((?:on)?[aA]nchorMind\w*)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(used, ["anchorMindAmend", "anchorMindForget", "anchorMindList", "anchorMindRemember", "anchorMindStatus", "onAnchorMindStatus"]);
  for (const name of used) assert.match(preload, new RegExp(`\\b${name}: \\(`), `chat-preload.js에 ${name}이 없습니다`);
  const settings = read("src/settings.js");
  for (const action of ["check", "choose-folder"]) assert.match(settings, new RegExp(`action: "${action}"`));
  assert.match(settings, /api\.anchorMind\b/);
  assert.match(read("src/settings-preload.js"), /anchorMind: \(/);
});
