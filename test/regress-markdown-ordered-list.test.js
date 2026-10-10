"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
// F17 순서 목록 번호 보존.
const { tokenizeBlocks } = require("../src/chat-markdown");
const textOf = (lines) => lines.flat().map((t) => t.text).join("");

test("F17 한국식 날짜 줄은 연도가 지워지지 않고 원문 그대로 남는다", () => {
  const blocks = tokenizeBlocks("일정:\n2026. 10. 10. 배포\n2026. 10. 17. 회고");
  const dates = blocks.find((b) => b.type === "paragraph" && textOf(b.lines).includes("배포"));
  assert.ok(dates, "목록이 아닌 문단으로 남아야 한다");
  assert.deepEqual(dates.lines.map((l) => l.map((t) => t.text).join("")), [
    "2026. 10. 10. 배포",
    "2026. 10. 17. 회고",
  ]);
});

test("F17 3번부터 시작하는 순서 목록은 번호가 1로 바뀌지 않는다", () => {
  const blocks = tokenizeBlocks("3. 세 번째 단계부터 다시 하세요");
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(textOf(blocks[0].lines), "3. 세 번째 단계부터 다시 하세요");
});

test("F17 하위 불릿으로 끊긴 단계 목록도 각 단계 번호가 유지된다", () => {
  const blocks = tokenizeBlocks("1. 설치\n   - npm install\n2. 실행\n   - npm start\n3. 확인");
  const shown = blocks.filter((b) => b.type !== "list" || b.ordered).map((b) =>
    b.type === "list" ? b.items.map((i, n) => `${n + 1}. ${textOf([i])}`) : b.lines.map((l) => textOf([l])));
  assert.deepEqual(shown.flat(), ["1. 설치", "2. 실행", "3. 확인"]);
});

test("F17 1부터 이어지는 목록은 그대로 순서 목록이다", () => {
  const [list] = tokenizeBlocks("1. 하나\n2. 둘\n3. 셋");
  assert.equal(list.type, "list");
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
});

