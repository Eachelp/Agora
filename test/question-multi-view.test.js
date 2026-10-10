const test = require("node:test");
const assert = require("node:assert/strict");
const { renderAwaitingRow } = require("../src/awaiting-view");

// 최소 DOM: aria 속성과 disabled까지 기록한다.
function makeNode(tag = "div") {
  const node = {
    tagName: tag, className: "", title: "", hidden: false, disabled: false,
    children: [], attrs: {}, listeners: {}, style: { setProperty() {} }, _text: "",
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    click() { if (!this.disabled) this.listeners.click?.(); },
    append(...items) { this.children.push(...items); },
  };
  Object.defineProperty(node, "textContent", {
    get() { return this._text; },
    set(value) { this._text = value; this.children = []; },
  });
  return node;
}

const AGENT = {
  id: "claude", name: "Claude", color: "#111",
  awaitingUser: true, awaitingQuestion: "무엇을 포함할까요?",
  awaitingOptions: ["개요", "일정", "예산"], awaitingMulti: true,
};

function render(agents, answers = []) {
  const container = makeNode("div");
  renderAwaitingRow({
    container, agents, document: { createElement: makeNode }, makeAgentAvatar: () => makeNode("span"),
    onAnswer: (...args) => answers.push(args), onDismiss() {},
  });
  return container;
}
const group = (row) => row.children.find((child) => child.className === "awaiting-group");
const optionRow = (row) => group(row).children.find((child) => child.className === "awaiting-options");
const chips = (row) => optionRow(row).children.filter((child) => child.className.startsWith("awaiting-option"));
const fillButton = (row) => optionRow(row).children.find((child) => child.className === "awaiting-fill");

test("여러 개 고르기: 칩은 토글(aria-pressed)이고 누른 칩이 체크 상태가 된다", () => {
  const row = render([{ ...AGENT, id: "t1" }]);
  assert.deepEqual(chips(row).map((chip) => chip.attrs["aria-pressed"]), ["false", "false", "false"]);
  chips(row)[1].click();
  assert.equal(chips(row)[1].attrs["aria-pressed"], "true");
  assert.match(chips(row)[1].className, /is-checked/);
  chips(row)[1].click();
  assert.equal(chips(row)[1].attrs["aria-pressed"], "false");
  assert.doesNotMatch(chips(row)[1].className, /is-checked/);
});

test("여러 개 고르기: 칩을 누르는 것만으로는 답이 채워지지 않고 '선택 넣기'가 입력창 문구를 만든다", () => {
  const answers = [];
  const row = render([{ ...AGENT, id: "t2" }], answers);
  const fill = fillButton(row);
  assert.equal(fill.textContent, "선택 넣기");
  assert.equal(fill.disabled, true, "고른 것이 없으면 비활성");
  fill.click();
  assert.deepEqual(answers, []);
  // 보기 순서대로 쉼표로 잇는다(누른 순서와 무관).
  chips(row)[2].click();
  chips(row)[0].click();
  assert.equal(fill.disabled, false);
  assert.deepEqual(answers, [], "칩 토글은 자동 전송·자동 채움이 아니다");
  fill.click();
  assert.deepEqual(answers, [["t2", "개요, 예산"]]);
  // 채운 뒤에는 선택이 비워져 다시 누르면 중복으로 붙지 않는다.
  assert.equal(fill.disabled, true);
  assert.deepEqual(chips(row).map((chip) => chip.attrs["aria-pressed"]), ["false", "false", "false"]);
});

test("여러 개 고르기: 다른 에이전트 이벤트로 바가 다시 그려져도 고르던 칩이 유지된다", () => {
  const agent = { ...AGENT, id: "t3" };
  const first = render([agent]);
  chips(first)[1].click();
  const again = render([agent, { id: "codex", name: "Codex", color: "#222", awaitingUser: false }]);
  assert.equal(chips(again)[1].attrs["aria-pressed"], "true");
  assert.equal(fillButton(again).disabled, false);
  // 대기가 끝났다가 같은 질문이 다시 서면 새 선택으로 시작한다.
  render([{ ...agent, awaitingUser: false }]);
  const fresh = render([agent]);
  assert.equal(chips(fresh)[1].attrs["aria-pressed"], "false");
});

test("단일 선택은 그대로: 토글·선택 넣기 없이 칩을 누르면 바로 보기가 콜백으로 간다", () => {
  const answers = [];
  const row = render([{ ...AGENT, id: "t4", awaitingMulti: false }], answers);
  assert.equal(fillButton(row), undefined);
  assert.equal(chips(row)[0].attrs["aria-pressed"], undefined);
  chips(row)[1].click();
  assert.deepEqual(answers, [["t4", "일정"]]);
});

test("알약 안내문에 입력창에 직접 쓰는 길이 적힌다", () => {
  const row = render([{ ...AGENT, id: "t5" }]);
  const pill = group(row).children[0].children[0];
  assert.match(pill.title, /입력창에 답을 적으세요/);
});
