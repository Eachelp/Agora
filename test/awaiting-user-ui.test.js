const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(ROOT, "src/chat.js"), "utf8");

// chat.js에서 top-level 함수 하나의 소스를 중괄호 깊이로 잘라 낸다.
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}를 찾지 못했습니다`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name}의 끝을 찾지 못했습니다`);
}

// 최소 DOM 노드: className/textContent/title/hidden/append/setProperty 등만 흉내.
function makeNode(tag = "div") {
  const node = {
    tagName: tag,
    className: "",
    _text: "",
    title: "",
    hidden: false,
    children: [],
    dataset: {},
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener() {},
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

function runRender(agents) {
  const awaitingRow = makeNode("div");
  const document = { createElement: (tag) => makeNode(tag) };
  const context = {
    awaitingRow,
    agents,
    document,
    makeAgentAvatar: () => makeNode("span"),
    answerAwaitingAgent: () => {},
  };
  const src = sliceFunction(renderer, "renderAwaitingRow");
  vm.runInNewContext(`${src}\nrenderAwaitingRow();`, context);
  return awaitingRow;
}

// pill(button) 안의 텍스트 조각을 모은다.
function pillText(pill) {
  return pill.children
    .map((child) => (typeof child._text === "string" ? child._text : ""))
    .join("");
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
    { id: "claude", name: "Claude", color: "#111", awaitingUser: true, awaitingQuestion: "어느 것부터 파볼까요?" },
    { id: "codex", name: "Codex", color: "#222", awaitingUser: false, awaitingQuestion: null },
  ]);
  assert.equal(row.hidden, false);
  const label = row.children.find((child) => child.className === "awaiting-label");
  assert.equal(label.textContent, "답변 대기");
  const pills = row.children.filter((child) => child.className === "awaiting-pill");
  assert.equal(pills.length, 1);
  assert.match(pillText(pills[0]), /@claude · 어느 것부터 파볼까요\?/);
});

test("여러 에이전트가 대기하면 개수 라벨과 알약이 각각 뜬다", () => {
  const row = runRender([
    { id: "claude", name: "Claude", color: "#111", awaitingUser: true, awaitingQuestion: "A?" },
    { id: "codex", name: "Codex", color: "#222", awaitingUser: true, awaitingQuestion: null },
  ]);
  assert.equal(row.hidden, false);
  const label = row.children.find((child) => child.className === "awaiting-label");
  assert.equal(label.textContent, "답변 대기 2");
  const pills = row.children.filter((child) => child.className === "awaiting-pill");
  assert.equal(pills.length, 2);
  // 질문 본문이 없으면 @id만 보여 준다.
  assert.equal(pillText(pills[1]), "@codex");
});
