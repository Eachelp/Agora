"use strict";

// 바로 답하기 화면: 여러 담당자가 동시에 돌 때 입력 중 표시·중지 버튼·대기 줄(× 취소)이 맞는지.
// 실제 chat.js 구간을 격리된 컨텍스트에서 돌리고 DOM·IPC만 대체한다(question-ui.test.js와 같은 방식).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FakeNode, makeDocument } = require("./question-fake-dom.cjs");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `구간을 찾지 못했습니다: ${start}`);
  return source.slice(from, to);
}

function loadUi() {
  const handlers = {};
  const cancels = [];
  const typingRow = new FakeNode("div");
  const queueRow = new FakeNode("div");
  const agents = [
    { id: "claude", name: "Claude", color: "#d97706" },
    { id: "codex", name: "Codex", color: "#2563eb" },
    { id: "agy", name: "AGY", color: "#16a34a" },
  ];
  const context = {
    document: makeDocument(),
    activeSessionId: "room-a",
    agents,
    typingAgents: new Set(),
    approvalQueue: [],
    activeApproval: null,
    roomTurnState: { current: null, running: [], queue: [], deferred: [] },
    questionCards: { isWaiting: () => false, hasPending: () => false },
    typingRow,
    queueRow,
    stopButton: new FakeNode("button"),
    interjectButton: new FakeNode("button"),
    isNearBottom: () => true,
    scrollToBottom() {},
    renderAgents() {},
    renderHeader() {},
    call: async (promise) => promise,
    agentById: (id) => agents.find((agent) => agent.id === id) || null,
    window: {
      chatApi: {
        onTyping: (handler) => { handlers.typing = handler; },
        onTurnState: (handler) => { handlers.turnState = handler; },
        turnCancel: async (...args) => { cancels.push(args); return { ok: true }; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    section("function renderTyping()", "// --- 첨부 (작성 중) ---"),
    section("window.chatApi.onTyping(", "window.chatApi.onUserQuestion?.("),
  ].join("\n"), context);
  return { ui: context, handlers, cancels };
}

const turn = (turnId, agentId, fast) => ({ turnId, agentId, discussion: false, fast });

test("여러 담당자가 동시에 돌면 입력 중 표시가 담당자마다 나오고, 하나가 끝나도 나머지는 남는다", () => {
  const { ui, handlers } = loadUi();
  handlers.typing({ sessionId: "room-a", agentId: "claude", busy: true });
  handlers.typing({ sessionId: "room-a", agentId: "codex", busy: true });
  assert.deepEqual(ui.typingRow.children.map((pill) => pill.textContent), ["Claude 입력 중", "Codex 입력 중"]);
  assert.equal(ui.typingRow.hidden, false);
  assert.equal(ui.stopButton.hidden, false);

  handlers.typing({ sessionId: "room-a", agentId: "claude", busy: false });
  assert.deepEqual(ui.typingRow.children.map((pill) => pill.textContent), ["Codex 입력 중"]);
  assert.equal(ui.stopButton.hidden, false, "아직 도는 담당자가 있으면 중지 버튼이 남는다");

  handlers.typing({ sessionId: "room-b", agentId: "agy", busy: true });
  assert.equal(ui.typingRow.children.length, 1, "다른 방의 알림은 무시한다");
});

test("돌고 있는 턴이 입력 중 표시 없이 둘이어도 방은 바쁘고 중지·잠깐 버튼이 보인다", () => {
  const { ui, handlers } = loadUi();
  handlers.turnState({ sessionId: "room-a", current: "claude", running: ["claude", "codex"], queue: [], deferred: [] });
  assert.equal(ui.roomIsBusy(), true);
  assert.equal(ui.stopButton.hidden, false);
  assert.equal(ui.interjectButton.hidden, false);
  assert.deepEqual([...ui.roomTurnState.running], ["claude", "codex"]);
  handlers.turnState({ sessionId: "room-a", current: null, running: [], queue: [], deferred: [] });
  assert.equal(ui.roomIsBusy(), false);
  assert.equal(ui.stopButton.hidden, true);
});

test("자기 담당자 뒤에서 기다리는 빠른 턴은 '대기' 줄에 안내와 × 취소가 있고, 취소는 그 턴만 가리킨다", async () => {
  const { ui, handlers, cancels } = loadUi();
  handlers.typing({ sessionId: "room-a", agentId: "claude", busy: true });
  handlers.typing({ sessionId: "room-a", agentId: "codex", busy: true });
  handlers.turnState({
    sessionId: "room-a",
    current: "claude",
    running: ["claude", "codex"],
    queue: [turn("t-fast", "claude", true), turn("t-main", "agy", false)],
    deferred: [],
  });
  assert.equal(ui.queueRow.hidden, false);
  const [fast, main] = ui.queueRow.children;
  assert.match(fast.textContent, /^Claude 대기×?$/);
  assert.equal(fast.title, "Claude의 하던 답변이 끝나면 바로 이어서 답합니다");
  assert.match(main.textContent, /^AGY 대기×?$/);
  assert.equal(main.title, "", "일반 줄 대기에는 빠른 줄 안내가 없다");

  const cancel = fast.children.find((node) => node.className === "queue-cancel");
  cancel.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancels, [["room-a", "t-fast"]]);
});
