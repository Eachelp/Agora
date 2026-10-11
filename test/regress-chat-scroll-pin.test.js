"use strict";

// 창을 줄이거나 질문 카드 영역이 커져 대화 영역이 작아져도, 바닥을 보던 사람은 바닥에 붙어 있고
// 위로 올려 읽던 사람은 움직이지 않는다. chat.js의 실제 코드를 가짜 스크롤러로 돌린다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");

function loadScroller() {
  const from = source.indexOf("let pinnedToBottom = true;");
  const to = source.indexOf("// --- 초기화 ---", from);
  assert.ok(from >= 0 && to > from);
  const listeners = {};
  let resize = null;
  const chatScroll = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600, // 바닥
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const context = {
    chatScroll,
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} },
  };
  vm.createContext(context);
  // isNearBottom은 앞쪽에 있으므로 함께 싣는다.
  vm.runInContext(source.slice(source.indexOf("function isNearBottom()"), source.indexOf("function scrollToBottom(")) + source.slice(from, to), context);
  return {
    chatScroll,
    // 사용자가 직접 스크롤한다.
    userScroll(top) { chatScroll.scrollTop = top; listeners.scroll(); },
    // 대화 영역의 높이가 바뀐다(스크롤 위치는 그대로다).
    resizeTo(height, { scrollFirst = false } = {}) {
      chatScroll.clientHeight = height;
      if (scrollFirst) listeners.scroll(); // 크기 변화 때문에 먼저 도착한 스크롤 이벤트
      resize();
    },
  };
}

test("바닥을 보던 사람은 대화 영역이 작아져도 바닥에 붙어 있다", () => {
  const view = loadScroller();
  view.userScroll(600);
  view.resizeTo(300);
  assert.equal(view.chatScroll.scrollTop, 1000, "가장 새 줄이 보이는 부분 아래로 밀리면 안 된다");
  view.resizeTo(200);
  assert.equal(view.chatScroll.scrollTop, 1000);
});

test("위로 올려 읽던 사람은 크기가 바뀌어도 움직이지 않는다", () => {
  const view = loadScroller();
  view.userScroll(100);
  view.resizeTo(300);
  assert.equal(view.chatScroll.scrollTop, 100);
});

test("크기 변화 때문에 생긴 스크롤 이벤트는 사용자가 위로 올린 것으로 보지 않는다", () => {
  const view = loadScroller();
  view.userScroll(600);
  // 높이가 줄면서 바닥에서 멀어진 상태로 스크롤 이벤트가 먼저 도착한다.
  view.resizeTo(300, { scrollFirst: true });
  assert.equal(view.chatScroll.scrollTop, 1000);
});

test("올려 읽다가 다시 바닥으로 내려오면 다시 붙는다", () => {
  const view = loadScroller();
  view.userScroll(100);
  view.userScroll(600);
  view.resizeTo(300);
  assert.equal(view.chatScroll.scrollTop, 1000);
});
