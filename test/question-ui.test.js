"use strict";

// 질문 카드가 chat.js(렌더러)에 어떻게 이어져 있는지. 실제 chat.js 구간을 격리된 컨텍스트에서 돌리고
// DOM·IPC만 대체한다(room-isolation-ui.test.js와 같은 방식). 카드 자체의 동작은 question-card.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const questionCard = require("../src/question-card");
const { FakeNode, makeDocument } = require("./question-fake-dom.cjs");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src", "chat.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "src", "chat.html"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "구간을 찾지 못했습니다: " + start);
  return source.slice(from, to);
}

function loadUi() {
  const calls = [];
  const handlers = {};
  const questionRow = new FakeNode("div");
  const context = {
    questionCard,
    document: makeDocument(),
    questionRow,
    activeSessionId: "room-a",
    agents: [{ id: "claude", name: "Claude", color: "#d97706" }],
    sessionMeta: null,
    typingAgents: new Set(),
    approvalQueue: [],
    activeApproval: null,
    roomTurnState: { current: null, running: [], queue: [], deferred: [] },
    stopButton: new FakeNode("button"),
    interjectButton: new FakeNode("button"),
    queueRow: new FakeNode("div"),
    storeWarning: new FakeNode("div"),
    pendingAttachments: [],
    chatMessages: [],
    providers: [], diagnostics: [], discussionPresets: [], projects: [], workflow: {}, sessions: [], sessionsByProject: {},
    activeProjectId: null,
    noticeTimer: null,
    makeAgentAvatar: (agent, className) => { const node = new FakeNode("span"); node.className = className; return node; },
    clearTimeout() {},
    window: {
      chatApi: {
        onUserQuestion: (handler) => { handlers.userQuestion = handler; },
        questionAnswer: async (...args) => { calls.push({ name: "answer", args }); return { ok: true }; },
        questionCancel: async (...args) => { calls.push({ name: "cancel", args }); return { ok: true }; },
        turnCancel: async () => ({ ok: true }),
      },
    },
    switchActiveSession(id) { context.activeSessionId = id; },
    renderAllMessages() {}, showPendingNotices() {}, scrollToBottom() {}, renderProjects() {}, renderHeader() {},
    renderAgents() {}, renderTyping() {}, renderPendingAttachments() {}, showNextApproval() {}, syncComposerLock() {},
    addApproval() {}, call: async (promise) => promise,
    agentById(id) { return context.agents.find((agent) => agent.id === id) || null; },
  };
  vm.createContext(context);
  vm.runInContext([
    section("const questionCards = questionCard.createQuestionCards({", "const typingAgents"),
    section("function roomIsBusy(", "// --- 첨부 (작성 중) ---"),
    section("function applyFullState(", "// --- 이벤트 구독 ---"),
    section("window.chatApi.onUserQuestion?.(", "window.chatApi.onReset("),
  ].join("\n"), context);
  return { ui: context, calls, handlers, questionRow };
}

const pendingQuestion = (extra = {}) => ({
  questionId: "q1", sessionId: "room-a", agentId: "claude", runId: "r1", turnId: "t1", status: "pending", createdAt: 1,
  questions: [{ question: "어느 쪽?", options: ["가", "나"], multiSelect: false }],
  ...extra,
});
const snapshot = (sessionId, userQuestions) => ({ activeSessionId: sessionId, session: { meta: { id: sessionId }, agents: [], typing: [], messages: [], userQuestions } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("상태 스냅숏의 질문 기록으로 카드가 되살아나고, 처리된 기록은 카드가 되지 않는다", () => {
  const { ui, questionRow } = loadUi();
  ui.applyFullState(snapshot("room-a", [
    pendingQuestion(),
    pendingQuestion({ questionId: "q0", status: "interrupted", reason: "app-restart" }),
    pendingQuestion({ questionId: "q9", status: "answered" }),
  ]));
  assert.equal(questionRow.children.length, 1);
  assert.equal(questionRow.children[0].dataset.questionId, "q1");
  assert.equal(questionRow.hidden, false);
});

test("방을 고르면 그 방의 질문만 보인다(다른 방 카드는 사라지고, 돌아오면 스냅숏으로 되살아난다)", () => {
  const { ui, questionRow } = loadUi();
  ui.applyFullState(snapshot("room-a", [pendingQuestion()]));
  assert.equal(questionRow.children.length, 1);
  ui.applyFullState(snapshot("room-b", []));
  assert.equal(questionRow.children.length, 0, "B에는 A의 카드가 없다");
  assert.equal(questionRow.hidden, true);
  ui.applyFullState(snapshot("room-a", [pendingQuestion()]));
  assert.equal(questionRow.children.length, 1);
});

test("실시간 알림: 지금 방 것만 받고, 처리됨 알림이 오면 카드가 거두어진다", () => {
  const { ui, handlers, questionRow } = loadUi();
  handlers.userQuestion({ sessionId: "room-b", question: pendingQuestion({ sessionId: "room-b" }) });
  assert.equal(questionRow.children.length, 0, "다른 방 알림은 무시한다");
  handlers.userQuestion({ sessionId: "room-a", question: pendingQuestion() });
  assert.equal(questionRow.children.length, 1);
  handlers.userQuestion({ sessionId: "room-a", question: pendingQuestion({ status: "cancelled", reason: "stopped" }) });
  assert.equal(questionRow.children.length, 0, "중지로 닫히면 카드도 사라진다");
});

test("카드의 보내기·건너뛰기는 그 질문이 속한 방과 질문 id로 IPC를 부른다", async () => {
  const { ui, calls, handlers, questionRow } = loadUi();
  handlers.userQuestion({ sessionId: "room-a", question: pendingQuestion() });
  const radio = questionRow.find((node) => node.type === "radio" && node.value === "나");
  radio.click();
  questionRow.byClass("question-send")[0].click();
  await settle();
  assert.deepEqual(calls, [{ name: "answer", args: ["room-a", "q1", [{ selected: ["나"] }]] }]);

  handlers.userQuestion({ sessionId: "room-a", question: pendingQuestion({ questionId: "q2" }) });
  questionRow.byClass("question-skip")[0].click();
  await settle();
  assert.deepEqual(calls[1], { name: "cancel", args: ["room-a", "q2"] });
});

test("질문 카드가 떠 있는 동안은 방이 바쁘다: 실행 중 표시가 없어도 중지·잠깐 버튼이 남는다", () => {
  const { ui, handlers } = loadUi();
  assert.equal(ui.roomIsBusy(), false);
  ui.renderBusyControls();
  assert.equal(ui.stopButton.hidden, true);

  // 창이 다시 붙어 스냅숏만 받은 경우: 턴 상태가 비어 있어도 카드가 있으면 멈출 길을 둔다.
  ui.applyFullState(snapshot("room-a", [pendingQuestion()]));
  ui.renderBusyControls();
  assert.equal(ui.roomIsBusy(), true);
  assert.equal(ui.stopButton.hidden, false);
  assert.equal(ui.interjectButton.hidden, false);

  handlers.userQuestion({ sessionId: "room-a", question: pendingQuestion({ status: "cancelled" }) });
  assert.equal(ui.roomIsBusy(), false, "카드가 사라지면 다시 한가하다");
  assert.equal(ui.stopButton.hidden, true, "onChange가 버튼 표시를 맞춘다");
});

test("카드가 떠 있어도 입력창은 잠기지 않는다(승인 카드와 다르다)", () => {
  const lockComposer = section("function lockComposer(", "// 승인 카드는 그 요청이");
  const syncComposerLock = section("function syncComposerLock(", "function doctorStatus(");
  assert.doesNotMatch(lockComposer + syncComposerLock, /question/i);
});

test("연결 지점: 방을 비우는 reset과 방 전환 알림도 카드를 맞추고, html·preload가 같은 이름을 쓴다", () => {
  assert.match(section("window.chatApi.onReset(", "window.chatApi.onSystemNotice("), /questionCards\.replaceAll\(\[\]\)/);
  assert.match(section("window.chatApi.onSessionsChanged(", "window.chatApi.onWorkflowChanged("), /questionCards\.render\(\)/);
  assert.match(html, /id="question-row"/);
  assert.ok(html.indexOf("./question-card.js") > 0 && html.indexOf("./question-card.js") < html.indexOf("./chat.js"), "카드 스크립트는 chat.js보다 먼저 불러온다");
  // 카드는 입력창 안이 아니라 위에 있고, 답변 대기 줄과 같은 영역(composer) 안이다.
  assert.ok(html.indexOf('id="question-row"') < html.indexOf('id="composer-box"'));
  const preload = fs.readFileSync(path.join(ROOT, "src", "chat-preload.js"), "utf8");
  assert.match(preload, /questionAnswer: /);
  assert.match(preload, /questionCancel: /);
  assert.match(preload, /onUserQuestion: /);
});
