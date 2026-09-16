const test = require("node:test");
const assert = require("node:assert/strict");
const { renderAwaitingRow } = require("../src/awaiting-view");

// 최소 DOM 노드: className/textContent/title/hidden/append/setProperty/click만 흉내.
function makeNode(tag = "div") {
  const node = {
    tagName: tag,
    className: "",
    _text: "",
    title: "",
    hidden: false,
    children: [],
    dataset: {},
    listeners: {},
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    click() {
      if (typeof this.listeners.click === "function") this.listeners.click();
    },
    append(...items) {
      for (const item of items) this.children.push(item);
    },
  };
  Object.defineProperty(node, "textContent", {
    get() {
      return this._text;
    },
    set(value) {
      this._text = value;
      // 실제 DOM처럼 textContent 설정은 자식을 비운다.
      this.children = [];
    },
  });
  return node;
}

function runRender(agents, onAnswer = () => {}) {
  const awaitingRow = makeNode("div");
  renderAwaitingRow({
    container: awaitingRow,
    agents,
    document: { createElement: (tag) => makeNode(tag) },
    makeAgentAvatar: () => makeNode("span"),
    onAnswer,
  });
  return awaitingRow;
}

// pill(button) 안의 텍스트 조각을 모은다.
function pillText(pill) {
  return pill.children
    .map((child) => (typeof child._text === "string" ? child._text : ""))
    .join("");
}

// 대기 바 안의 에이전트 그룹들(각 그룹 = 알약 + 보기 칩)을 모은다.
function groupsOf(row) {
  return row.children.filter((child) => child.className === "awaiting-group");
}
function pillOf(group) {
  return group.children.find((child) => child.className === "awaiting-pill");
}
function optionChips(group) {
  const optRow = group.children.find((child) => child.className === "awaiting-options");
  return optRow ? optRow.children.filter((child) => child.className === "awaiting-option") : [];
}

test("답변 대기 에이전트가 없으면 대기 바는 숨겨진다", () => {
  const row = runRender([
    { id: "claude", name: "Claude", color: "#111", awaitingUser: false, awaitingQuestion: null },
  ]);
  assert.equal(row.hidden, true);
  assert.equal(row.children.length, 0);
});

test("되질문한 에이전트 하나면 라벨과 질문이 담긴 알약 하나가 뜬다", () => {
  const row = runRender([
    { id: "claude", name: "Claude", color: "#111", awaitingUser: true, awaitingQuestion: "어느 것부터 파볼까요?", awaitingOptions: [] },
    { id: "codex", name: "Codex", color: "#222", awaitingUser: false, awaitingQuestion: null, awaitingOptions: [] },
  ]);
  assert.equal(row.hidden, false);
  const label = row.children.find((child) => child.className === "awaiting-label");
  assert.equal(label.textContent, "답변 대기");
  const groups = groupsOf(row);
  assert.equal(groups.length, 1);
  assert.match(pillText(pillOf(groups[0])), /@claude · 어느 것부터 파볼까요\?/);
  // 보기가 없으면 칩도 없다.
  assert.equal(optionChips(groups[0]).length, 0);
});

test("보기가 있으면 알약 아래에 클릭 가능한 보기 칩이 뜬다", () => {
  const row = runRender([
    {
      id: "claude",
      name: "Claude",
      color: "#111",
      awaitingUser: true,
      awaitingQuestion: "어느 것부터?",
      awaitingOptions: ["실시요약 확보", "7문항 정답 보완", "풀이시간 정의"],
    },
  ]);
  const groups = groupsOf(row);
  assert.equal(groups.length, 1);
  const chips = optionChips(groups[0]);
  assert.deepEqual(chips.map((chip) => chip.textContent), ["실시요약 확보", "7문항 정답 보완", "풀이시간 정의"]);
});

// 알약은 @id만, 칩은 @id와 보기를 함께 넘긴다. 전송은 chat.js(answerAwaitingAgent)가
// 입력창 프리필로만 처리하므로 여기서는 콜백 인자만 본다.
test("알약과 보기 칩을 누르면 에이전트 id와 보기가 콜백으로 넘어간다", () => {
  const answers = [];
  const row = runRender(
    [{ id: "claude", name: "Claude", color: "#111", awaitingUser: true, awaitingQuestion: "어느 쪽?", awaitingOptions: ["A안", "B안"] }],
    (agentId, option) => answers.push([agentId, option])
  );
  const group = groupsOf(row)[0];
  pillOf(group).click();
  optionChips(group)[1].click();
  assert.deepEqual(answers, [["claude", undefined], ["claude", "B안"]]);
});

test("여러 에이전트가 대기하면 개수 라벨과 그룹이 각각 뜬다", () => {
  const row = runRender([
    { id: "claude", name: "Claude", color: "#111", awaitingUser: true, awaitingQuestion: "A?", awaitingOptions: [] },
    { id: "codex", name: "Codex", color: "#222", awaitingUser: true, awaitingQuestion: null, awaitingOptions: [] },
  ]);
  assert.equal(row.hidden, false);
  const label = row.children.find((child) => child.className === "awaiting-label");
  assert.equal(label.textContent, "답변 대기 2");
  const groups = groupsOf(row);
  assert.equal(groups.length, 2);
  // 질문 본문이 없으면 @id만 보여 준다.
  assert.equal(pillText(pillOf(groups[1])), "@codex");
});
