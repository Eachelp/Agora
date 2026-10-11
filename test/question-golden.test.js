"use strict";

// 질문 도구를 붙이지 않는 실행의 프롬프트·실행 인자를 기준값(test/fixtures/question-golden.json의 expected)과 글자 하나까지 견준다.
// 기준값은 main(v1.2.1) 모듈의 출력과 같고 다른 곳은 한 군데뿐이다: 일반 대화 프롬프트(0·1·5·6번)의 끝 ASK_USER 줄에
// "보기를 여러 개 고를 수 있으면 … `MULTI: yes` 줄을 넣으세요." 한 문장이 더 있다(여러 개 고르기용으로 일부러 더한 것).
// 토론·결론 종합·쉽게 설명 프롬프트와 모든 실행 인자(argv)는 main과 같다. 실행 인자 계산 결과에는 questionToolAttached: false가
// 키 하나로 더 실린다(argv에는 영향이 없다).
const test = require("node:test");
const assert = require("node:assert/strict");
const golden = require("./fixtures/question-golden.json");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");
const { buildAgentInvocation } = require("../src/chat/chat-argv");

for (const item of golden.prompts) {
  test(`질문 도구 없는 프롬프트는 기준값과 같다: ${item.name}`, () => {
    assert.equal(buildAgentPrompt(item.input), item.expected);
    assert.equal(buildAgentPrompt({ ...item.input, userQuestionTool: false }), item.expected);
  });
}

for (const item of golden.invocations) {
  test(`질문 도구 없는 실행 인자는 기준값과 같다: ${item.name}`, () => {
    const result = buildAgentInvocation(item.input);
    assert.equal(result.questionToolAttached, false);
    assert.deepEqual(result, item.expected);
    // 붙이지 못하는 입력(셸 래퍼 등)에 도구 정보를 줘도 인자는 그대로다.
    const offered = buildAgentInvocation({
      ...item.input,
      userQuestion: { server: { command: "node", args: ["x.js"], env: {} }, serverKey: "agora_user_question", toolName: "mcp__agora_user_question__ask_user" },
    });
    if (item.input.provider.id === "agy" || item.input.provider.needsShell) {
      assert.equal(offered.questionToolAttached, false);
      assert.deepEqual(offered.argv, item.expected.argv);
    } else {
      assert.equal(offered.questionToolAttached, true);
      assert.deepEqual(offered.argv.slice(0, item.expected.argv.length), item.expected.argv, "붙는 인자는 끝에만 더해진다");
    }
  });
}

test("질문 도구가 붙은 프롬프트는 일반 대화에서만 달라지고, 도우미 턴은 플래그를 줘도 그대로다", () => {
  const [chat, , discussion, summary, simplify] = golden.prompts;
  const withTool = buildAgentPrompt({ ...chat.input, userQuestionTool: true }).split("\n");
  const start = withTool.findIndex((line) => line.startsWith("- 작업 중에 사용자의 결정이 꼭 필요하면 agora_user_question"));
  assert.ok(start > 0, "도구 안내가 있다");
  // 더해지는 것은 안내 3줄 + 사용 규칙 2줄뿐이고, 나머지 계약(끝 ASK_USER 포함)은 그대로다.
  withTool.splice(start, 5);
  assert.equal(withTool.join("\n"), chat.expected);
  for (const item of [discussion, summary, simplify]) {
    assert.equal(buildAgentPrompt({ ...item.input, userQuestionTool: true }), item.expected);
  }
});
