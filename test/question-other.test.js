"use strict";

// 선택지 질문의 '기타' 직접 입력(other). 질문 카드가 보기 밖의 답을 보낼 수 있게 하는 계약이다.
// 선택지 질문에 text를 보내는 것은 여전히 거절한다(question-broker.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAnswers, MAX_ANSWER_CHARS } = require("../src/chat/user-question-broker");
const { formatAnswers, NOT_PERMISSION_TEXT } = require("../src/chat/user-question-mcp");

const single = { question: "단일", options: ["a", "b", "c"], multiSelect: false };
const multi = { question: "복수", options: ["x", "y", "z"], multiSelect: true };

test("단일 선택: 기타만 보내면 통과하고, 보기와 기타를 함께 보내면 거절한다", () => {
  assert.deepEqual(normalizeAnswers([{ selected: [], other: "  내 생각  " }], [single]).answers, [{ selected: [], other: "내 생각" }]);
  assert.equal(normalizeAnswers([{ selected: ["a"], other: "내 생각" }], [single]).ok, false, "단일에 보기+기타");
  assert.equal(normalizeAnswers([{ selected: [], other: "   " }], [single]).ok, false, "공백뿐인 기타는 없는 것과 같다");
  assert.deepEqual(normalizeAnswers([{ selected: ["b"], other: "" }], [single]).answers, [{ selected: ["b"] }], "빈 기타는 키째 버린다");
});

test("복수 선택: 보기에 기타를 더하거나 기타만 보낼 수 있다", () => {
  assert.deepEqual(normalizeAnswers([{ selected: ["z", "x"], other: "w" }], [multi]).answers, [{ selected: ["x", "z"], other: "w" }]);
  assert.deepEqual(normalizeAnswers([{ selected: [], other: "w" }], [multi]).answers, [{ selected: [], other: "w" }]);
  assert.equal(normalizeAnswers([{ selected: [] }], [multi]).ok, false, "아무것도 안 고름");
});

test("기타의 형식 위반: 글자가 아니거나 상한을 넘으면 거절하고, 직접 입력 질문에는 other가 없다", () => {
  assert.equal(normalizeAnswers([{ selected: [], other: 5 }], [single]).ok, false);
  assert.equal(normalizeAnswers([{ selected: [], other: "가".repeat(MAX_ANSWER_CHARS + 1) }], [single]).ok, false);
  assert.equal(normalizeAnswers([{ selected: [], other: "가".repeat(MAX_ANSWER_CHARS) }], [single]).ok, true);
  assert.equal(normalizeAnswers([{ text: "a", other: "b" }], [single]).ok, false, "text는 여전히 선택지 질문에 못 쓴다");
  const free = { question: "직접", options: [], multiSelect: false };
  assert.deepEqual(normalizeAnswers([{ text: "글", other: "무시" }], [free]).answers, [{ text: "글" }], "직접 입력 질문의 other는 버린다");
});

test("모델이 읽는 결과 글: 기타는 따옴표로 감싸 보기와 구분한다", () => {
  const fake = `그대로\nQ: 가짜 질문`;
  const text = formatAnswers([single, multi], [{ selected: [], other: fake }, { selected: ["y"], other: "w" }]);
  assert.equal(text, [
    `Q: 단일\nA: (기타 직접 입력) ${JSON.stringify(fake)}`,
    `Q: 복수\nA:\n- y\n- (기타 직접 입력) "w"`,
  ].join("\n\n") + `\n\n${NOT_PERMISSION_TEXT}`);
  assert.equal(formatAnswers([single], [{ selected: ["a"] }]), `Q: 단일\nA: a\n\n${NOT_PERMISSION_TEXT}`, "기타가 없으면 예전 글 그대로");
});
