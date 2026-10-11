"use strict";

// 채팅 렌더러의 글 처리 회귀: F16 서식 없이 복사, F17 순서 목록 시작 번호, F18 내 말풍선, F19 멘션 팝업,
// F20 파일 칩, F23 링크 가운데 클릭. chat.js의 실제 함수를 격리된 컨텍스트에서 돌린다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const chatMarkdown = require("../src/chat-markdown");
const { UiNode, makeUiDocument } = require("./regress-ui-dom.cjs");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "구간을 찾지 못했습니다: " + start);
  return source.slice(from, to);
}

function load(code, extra = {}) {
  const timers = [];
  const context = {
    chatMarkdown,
    document: makeUiDocument(),
    renderMathIfAvailable() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    navigator: { clipboard: { writeText: async () => {} } },
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, runTimers: () => { for (const fire of timers) if (fire) fire(); } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const INLINE = () => section("function renderInlineTokens(", "// LaTeX 수식을");

test("F16 서식 없이 복사는 파일 이름·식별자·주소의 밑줄과 코드 블록을 그대로 둔다", () => {
  const { context } = load(section("function stripMarkdown(", "// 클릭하면 클립보드에 넣고"));
  const strip = context.stripMarkdown;
  assert.equal(strip("최종 파일은 2026_예산_최종.xlsx 입니다."), "최종 파일은 2026_예산_최종.xlsx 입니다.");
  assert.equal(strip("설정값 MAX_RETRY_COUNT 를 3으로"), "설정값 MAX_RETRY_COUNT 를 3으로");
  assert.equal(strip("https://example.com/my_page_name 과 /_a_/ 경로"), "https://example.com/my_page_name 과 /_a_/ 경로");
  assert.equal(strip("```bash\n# 의존성 설치\nnpm install\n```"), "# 의존성 설치\nnpm install");
  assert.equal(
    strip("```python\nclass A:\n    def __init__(self):\n        self.my_value = 1\n- 항목\n```"),
    "class A:\n    def __init__(self):\n        self.my_value = 1\n- 항목"
  );
  assert.equal(strip("`__init__` 과 `a_b_c`"), "__init__ 과 a_b_c");
  assert.equal(strip("2*3*4 계산"), "2*3*4 계산");
  // 서식은 여전히 걷어낸다.
  assert.equal(strip("## 제목\n**굵게** 와 [링크](https://x.y) 그리고 *기울임*\n- 항목"), "제목\n굵게 와 링크 그리고 기울임\n· 항목");
});

test("F17 시작 번호가 1이 아닌 순서 목록은 목록으로 그리되 원문 번호를 유지한다", () => {
  const [list] = chatMarkdown.tokenizeBlocks("3. 세 번째\n4. 네 번째");
  assert.equal(list.type, "list");
  assert.equal(list.start, 3);
  assert.deepEqual(list.numbers, [3, 4]);

  const { context } = load([INLINE(), section("function renderRichText(", "function renderTextWithMentions(")].join("\n"));
  const render = (text) => {
    const container = new UiNode("div");
    context.renderRichText(container, text);
    return container;
  };
  const ol = render("3. 세 번째\n4. 네 번째").children[0];
  assert.equal(ol.tagName, "OL");
  assert.equal(ol.start, 3, "<ol start>로 3부터 번호를 매긴다");
  assert.equal(ol.children[0].value, "", "이어지는 번호는 따로 지정하지 않는다");

  // 건너뛴 번호는 li.value로 원문 번호를 지킨다.
  const skipped = render("1. 하나\n3. 셋\n7. 일곱").children[0];
  assert.equal(skipped.start, undefined);
  assert.deepEqual(skipped.children.map((li) => li.value), ["", 3, 7]);

  // 날짜 줄은 목록이 아니라 문단이다.
  assert.equal(render("2026. 10. 10. 배포").children[0].tagName, "P");
});

test("F18 내 말풍선은 쓴 글(**, 백틱, 링크 주소, 파일 경로)을 그대로 보여 준다", () => {
  const { context } = load([INLINE(), section("function renderTextWithMentions(", "// 그림 대신 확장자를")].join("\n"));
  const show = (text) => {
    const container = new UiNode("div");
    context.renderTextWithMentions(container, text);
    return container;
  };
  for (const text of [
    "@claude 2**3**4 계산",
    "[문서](https://example.com/a) 봐줘",
    "file:///C:/work/report.xlsx 확인",
    "`npm test` 돌려줘",
    "https://example.com/x 확인",
  ]) {
    assert.equal(show(text).textContent, text);
  }
  const mention = show("@claude 안녕").byClass("mention");
  assert.equal(mention.length, 1);
  assert.equal(mention[0].textContent, "@claude");
  assert.equal(show("`@claude` 예시").byClass("mention").length, 0, "코드 안의 @는 멘션이 아니다");
});

test("F20 파일 칩을 연달아 눌러도 라벨은 파일 이름으로 돌아온다", async () => {
  const { context, runTimers } = load(INLINE());
  const container = new UiNode("div");
  context.renderInlineTokens(container, [{ type: "file", href: "file:///C:/r/report.xlsx", path: "C:/r/report.xlsx", text: "report.xlsx" }]);
  const chip = container.byClass("file-chip")[0];
  chip.click();
  await tick();
  chip.click();
  await tick();
  assert.equal(chip.textContent, "경로 복사됨");
  runTimers();
  assert.equal(chip.textContent, "report.xlsx");
});

test("F23 링크는 가운데 클릭(auxclick)으로도 이동하지 않는다", () => {
  const { context } = load(INLINE());
  const container = new UiNode("div");
  context.renderInlineTokens(container, [{ type: "link", href: "https://example.com/", text: "예" }]);
  const anchor = container.children[0];
  for (const type of ["click", "auxclick"]) {
    assert.equal(anchor.dispatch(type, { button: type === "click" ? 0 : 1 }).prevented, true, `${type}이 막혀야 한다`);
  }
});

test("F23 채팅 창은 새 창 열기를 모두 거절한다", () => {
  const { createChatWindow } = require("../src/chat/chat-window");
  let handler = null;
  class FakeWindow {
    constructor() {
      this.webContents = { send() {}, setWindowOpenHandler: (fn) => { handler = fn; } };
    }
    on() {}
    once() {}
    setMenuBarVisibility() {}
    loadFile() {}
  }
  createChatWindow({ BrowserWindow: FakeWindow });
  assert.deepEqual(handler({ url: "https://example.com/", disposition: "background-tab" }), { action: "deny" });
});

function loadMention(text, caret) {
  const listeners = {};
  const composerInput = {
    value: text,
    selectionStart: caret,
    setSelectionRange(start) { this.selectionStart = start; },
    focus() {},
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  let sent = 0;
  const { context } = load(
    [
      "var mentionState = null;",
      section("function closeMentionPopup(", "// --- 입력창 ---"),
      section('composerInput.addEventListener("keydown"', 'composerInput.addEventListener("blur"'),
    ].join("\n"),
    {
      composerInput,
      mentionPopup: new UiNode("div"),
      mentionTargets: () => [{ alias: "claude", label: "Claude", color: "#111", available: true }],
      autoresize() {},
      sendCurrentMessage() { sent += 1; },
    }
  );
  const press = (key) => {
    const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.keydown(event);
    return event;
  };
  return { context, composerInput, press, sent: () => sent };
}

test("F19 멘션 팝업이 열린 채 캐럿만 옮긴 뒤 Enter를 눌러도 쓰던 글이 지워지지 않는다", () => {
  const body = "@cl 이 함수의 경계 조건을 검토해 주세요. 특히 null 입력";
  const view = loadMention(body, 3);
  view.context.updateMentionPopup();
  assert.equal(view.context.mentionState.query, "cl");

  // End로 끝까지 옮긴다(팝업 상태는 갱신되지 않는다).
  view.composerInput.selectionStart = body.length;
  const event = view.press("Enter");
  assert.equal(view.composerInput.value, body, "쓰던 글이 그대로여야 한다");
  assert.equal(view.context.mentionState, null, "어긋난 팝업은 닫힌다");
  assert.equal(view.sent(), 1, "팝업이 닫혔으니 Enter는 보내기로 이어진다");
  assert.equal(event.prevented, true);
});

test("F19 캐럿이 그대로면 Enter가 멘션을 완성한다", () => {
  const view = loadMention("앞글 @cl 뒷글", 6);
  view.context.updateMentionPopup();
  view.press("Enter");
  assert.equal(view.composerInput.value, "앞글 @claude  뒷글");
  assert.equal(view.sent(), 0);
});
