"use strict";

// 채팅 렌더러 상태 회귀: F2 대화 이동 팝오버, F6 저장소 경고 문구, F12 작업 맥락 팝오버, F14 접힌 시스템 알림.
// chat.js의 실제 함수를 격리된 컨텍스트에서 돌리고 DOM·IPC만 대체한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { UiNode, makeUiDocument } = require("./regress-ui-dom.cjs");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "구간을 찾지 못했습니다: " + start);
  return source.slice(from, to);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("F2 대화 이동 팝오버는 대화가 실제로 속한 프로젝트를 '(현재)'로 막는다", async () => {
  const moves = [];
  const context = {
    document: makeUiDocument(),
    // 활성 프로젝트는 P1이지만 이동할 대화 X는 펼쳐 둔 P2 소속이다.
    activeProjectId: "p1",
    projects: [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }],
    sessionsByProject: { p1: [{ id: "a", projectId: "p1" }], p2: [{ id: "x", projectId: "p2" }] },
    openPopover: (anchor, build) => build(context.target),
    target: new UiNode("div"),
    closePopover() {},
    applyFullState() {},
    call: async (promise) => promise,
    window: { chatApi: { sessionsMove: async (sessionId, projectId) => { moves.push([sessionId, projectId]); return {}; } } },
  };
  vm.createContext(context);
  vm.runInContext(section("function sessionOwnerProjectId(", "function renderSessions("), context);

  context.openSessionMovePopover({}, { id: "x", projectId: "p2" });
  const options = context.target.byClass("project-move-option");
  assert.deepEqual(options.map((option) => option.textContent), ["P1", "P2 (현재)"]);
  assert.deepEqual(options.map((option) => option.disabled), [false, true]);
  options[0].click();
  await tick();
  assert.deepEqual(moves, [["x", "p1"]], "활성 프로젝트 P1로 옮길 수 있어야 한다");
});

test("F6 알림이 연달아 떠도 영구 저장소 경고 문구는 원래대로 돌아온다", () => {
  const timers = [];
  const banner = new UiNode("div");
  const context = {
    storeWarning: banner,
    noticeTimer: null,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  };
  vm.createContext(context);
  vm.runInContext(section("function showPersistentWarning(", "async function call("), context);

  const warning = "이 .agora 저장소는 더 새로운 버전이 만든 것이라 읽기 전용으로 열렸습니다.";
  context.showPersistentWarning(warning);
  context.flashNotice("첫 번째 오류");
  context.flashNotice("두 번째 오류");
  assert.equal(banner.textContent, "두 번째 오류");
  for (const fire of timers) if (fire) fire();
  assert.equal(banner.textContent, warning);
  assert.equal(banner.hidden, false, "영구 경고는 자동으로 숨지 않는다");
});

function loadWorkflowPopover() {
  const popover = new UiNode("div");
  popover.hidden = true;
  const decision = { id: "d1", status: "proposed", title: "후보", content: "내용", updatedAt: 1 };
  const context = {
    document: makeUiDocument(),
    popover,
    activeProjectEntry: () => ({ id: "p", name: "P", context: "" }),
    workflow: { decisions: [decision], tasks: [], statuses: [] },
    agents: [],
    chatMessages: [],
    activeSessionId: "s",
    resolves: 0,
    rulesOnDisk: "디스크 규칙",
    pending: null,
    call: async (promise) => promise,
    flashNotice() {},
    confirmInApp: async () => true,
    taskFileView: () => null,
    makeField(label, control) { const field = new UiNode("label"); field.append(control); return field; },
    openPopover(anchor, build) {
      popover.textContent = "";
      popover.classList.remove("is-workflow");
      build(popover);
      popover.hidden = false;
    },
    applyFullState() {},
    window: {
      chatApi: {
        rulesRead: async () => ({ rules: context.rulesOnDisk, history: "" }),
        memoryRead: async () => ({ content: "" }),
        memoryAppend: async () => ({ memory: "저장된 기록" }),
        decisionsResolve: () => {
          context.resolves += 1;
          return new Promise((resolve) => { context.pending = resolve; });
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    section("const WORKFLOW_STATUS_LABELS", "workflowButton.addEventListener("),
    context
  );
  const openTab = () => popover.byClass("workflow-tab-panel").findIndex((panel) => panel.classList.contains("is-active"));
  const tabButton = (label) => popover.byClass("workflow-tab-button").find((button) => button.textContent === label);
  const rules = () => popover.findAll((node) => node.tagName === "TEXTAREA").find((node) => node.maxLength === 4000);
  return { context, popover, openTab, tabButton, rules };
}

test("F12 결정 탭에서 승인해도 보던 탭과 다른 탭의 미저장 입력이 유지된다", async () => {
  const view = loadWorkflowPopover();
  const anchor = { getBoundingClientRect: () => ({}) };
  view.context.openWorkflowPopover(anchor);
  await tick();
  assert.equal(view.rules().value, "디스크 규칙");

  view.rules().type_("저장하지 않은 규칙");
  view.tabButton("결정").click();
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "승인").click();
  view.context.pending({ ok: true });
  await tick();

  assert.equal(view.openTab(), 1, "결정 탭에 머물러야 한다");
  assert.equal(view.rules().value, "저장하지 않은 규칙", "다른 탭의 미저장 입력이 사라지면 안 된다");
  assert.equal(view.context.resolves, 1);
});

test("F12 응답을 기다리는 사이 사용자가 닫은 팝오버는 다시 열리지 않는다", async () => {
  const view = loadWorkflowPopover();
  view.context.openWorkflowPopover({ getBoundingClientRect: () => ({}) });
  await tick();
  view.tabButton("결정").click();
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "승인").click();
  // 사용자가 팝오버를 닫는다.
  view.popover.hidden = true;
  view.popover.textContent = "";
  view.popover.classList.remove("is-workflow");
  view.context.pending({ ok: true });
  await tick();
  assert.equal(view.popover.hidden, true);
  assert.equal(view.popover.children.length, 0);
});

// 입력 초안 표시(dataset.dirty)는 글을 쓸 때 켜지고 폼을 비울 때 꺼져야 한다. 꺼지지 않으면 취소한 폼이 빈 글로
// 초안에 잡혀, 상관없는 승인·삭제 뒤 팝오버를 다시 만들 때 빈 '새 결정·새 작업' 폼이 다시 열린다.
const approveFirstProposal = async (view) => {
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "승인").click();
  view.context.pending({ ok: true });
  await tick();
};

test("F12 고치다 취소한 결정 입력은 다시 그릴 때 빈 '새 결정' 폼을 다시 열지 않는다", async () => {
  const view = loadWorkflowPopover();
  view.context.workflow = {
    decisions: [
      { id: "d1", status: "proposed", title: "후보", content: "내용", updatedAt: 1 },
      { id: "c1", status: "confirmed", title: "확정", content: "확정된 내용", updatedAt: 1 },
    ],
    tasks: [],
    statuses: [],
  };
  view.context.openWorkflowPopover({ getBoundingClientRect: () => ({}) });
  await tick();
  view.tabButton("결정").click();

  const decisionForm = () => view.popover.byClass("is-collapsed")[0];
  const content = () => decisionForm().find((node) => node.tagName === "TEXTAREA");
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "수정").click();
  assert.equal(decisionForm().hidden, false, "수정을 누르면 폼이 열린다");
  content().type_("고치던 글");
  decisionForm().find((node) => node.tagName === "BUTTON" && node.textContent === "취소").click();
  assert.equal(content().value, "", "취소하면 폼이 비워진다");

  await approveFirstProposal(view);
  assert.equal(decisionForm().hidden, true, "취소한 입력은 초안이 아니므로 빈 새 결정 폼이 다시 열리면 안 된다");
  assert.equal(content().value, "");
});

test("F12 고치다 취소한 작업 입력은 다시 그릴 때 빈 '새 작업' 폼을 다시 열지 않는다", async () => {
  const view = loadWorkflowPopover();
  view.context.workflow = {
    decisions: [{ id: "d1", status: "proposed", title: "후보", content: "내용", updatedAt: 1 }],
    tasks: [{ id: "t1", status: "todo", title: "작업", description: "설명", decisionId: "", agentId: "" }],
    statuses: [],
  };
  view.context.openWorkflowPopover({ getBoundingClientRect: () => ({}) });
  await tick();

  const taskForm = () => view.popover.byClass("is-collapsed")[1];
  const title = () => taskForm().find((node) => node.tagName === "INPUT" && node.placeholder === "작업 제목");
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "수정").click();
  assert.equal(taskForm().hidden, false, "수정을 누르면 폼이 열린다");
  title().type_("고치던 제목");
  taskForm().find((node) => node.tagName === "BUTTON" && node.textContent === "취소").click();
  assert.equal(title().value, "", "취소하면 폼이 비워진다");

  await approveFirstProposal(view);
  assert.equal(taskForm().hidden, true, "취소한 입력은 초안이 아니므로 빈 새 작업 폼이 다시 열리면 안 된다");
  assert.equal(title().value, "");
});

test("F12 기억을 추가한 입력은 저장됐으므로 다시 그릴 때 초안으로 이어지지 않는다", async () => {
  const view = loadWorkflowPopover();
  view.context.openWorkflowPopover({ getBoundingClientRect: () => ({}) });
  await tick();
  const memoryInput = () => view.popover.find((node) => node.tagName === "TEXTAREA" && node.placeholder === "사람이 직접 남길 중요한 맥락");
  memoryInput().type_("남길 맥락");
  view.popover.find((node) => node.tagName === "BUTTON" && node.textContent === "기억 추가").click();
  await tick();
  assert.equal(memoryInput().value, "", "저장하면 입력칸이 비워진다");

  await approveFirstProposal(view);
  assert.equal(memoryInput().dataset.dirty, undefined, "저장한 입력은 미저장 초안으로 남으면 안 된다");
});

test("F14 접힌 시스템 알림은 뒤에 다른 메시지가 붙어도 다시 펼칠 수 있다", () => {
  const list = new UiNode("ul");
  list.rootMark = true;
  const context = {
    document: makeUiDocument(),
    messageList: list,
    systemToggle: null,
  };
  vm.createContext(context);
  vm.runInContext(
    [section("function mergeIntoPreviousSystem(", "function appendMessage(")].join("\n"),
    context
  );
  let key = 0;
  const notice = (text) => {
    const item = new UiNode("li");
    item.className = "message is-system";
    item.dataset.systemKey = `k${key += 1}`;
    item.textContent = text;
    return item;
  };
  const user = (text) => {
    const item = new UiNode("li");
    item.className = "message is-user";
    item.textContent = text;
    return item;
  };
  const texts = ["오래된 오류", "B", "C", "D"].map(notice);
  for (const item of texts) context.appendMessageItem(item);
  assert.equal(texts[0].classList.contains("is-collapsed"), true, "가장 오래된 알림은 접힌다");
  const toggle = list.byClass("system-toggle")[0];
  assert.ok(toggle, "접힌 알림을 펼칠 토글이 있다");

  context.appendMessageItem(user("사용자 메시지"));
  assert.equal(list.byClass("system-toggle").length, 1, "다음 메시지가 붙어도 토글이 남아야 한다");
  assert.equal(toggle.parent, list);
  assert.match(toggle.textContent, /이전 알림 1개 보기/);

  // 새 알림 묶음은 자기 토글을 따로 만들고, 앞 묶음 토글을 가져가지 않는다.
  for (const item of ["E", "F", "G", "H"].map(notice)) context.appendMessageItem(item);
  assert.equal(list.byClass("system-toggle").length, 2);
  assert.ok(list.children.indexOf(toggle) < list.children.indexOf(texts[3]) + 3, "앞 묶음 토글은 제자리에 있다");

  // 펼치기 버튼을 누르면 모든 토글의 글자가 함께 바뀐다.
  toggle.byClass("system-toggle-button")[0].click();
  assert.equal(list.classList.contains("show-system-history"), true);
  for (const each of list.byClass("system-toggle")) assert.match(each.textContent, /이전 알림 접기/);
});
