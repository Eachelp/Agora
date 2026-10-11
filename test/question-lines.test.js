"use strict";

// 질문이 처리되면 방이 대화에 남기는 한 줄(답 요약·건너뜀·중단). 진입점은 방(ChatRoom)이고, CLI 자리에는
// 진짜 중계소에 HTTP로 묻는 가짜 러너를 둔다(question-room.test.js와 같은 방식).
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { createUserQuestionBroker } = require("../src/chat/user-question-broker");
const { createRoomQuestionTool, questionBrokerHooks } = require("../src/chat/user-question-run");
const { waitFor, scriptedRunner } = require("./question-helpers.cjs");

const AGENTS = () => [
  { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
  { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
];

function setup(t, runner, roomOptions = {}) {
  const rooms = new Map();
  const broker = createUserQuestionBroker({
    ...questionBrokerHooks((sessionId) => rooms.get(sessionId) || null),
    onCallbackError: () => {},
  });
  t.after(() => broker.stop());
  const room = new ChatRoom({
    sessionId: "s1",
    agents: AGENTS(),
    runAgent: runner,
    meta: { permissionMode: "workspace-read" }, // 일하는 도중 묻기는 파일 작업 권한이 있는 방에서만 붙는다
    questionTool: createRoomQuestionTool({ broker, sessionId: "s1" }),
    ...roomOptions,
  });
  rooms.set("s1", room);
  return { room, broker };
}

const systemLines = (room) => room.messages.filter((message) => message.authorType === "system").map((message) => message.text);
const pending = (room) => room.pendingUserQuestionList();

test("답을 보내면 '@에이전트의 질문 N개 → 답: ...' 한 줄이 한 번만 남고 AI 프롬프트에는 들어가지 않는다", async (t) => {
  const log = {};
  const runner = scriptedRunner(async ({ ask, args }) => {
    if (args.prompt.includes("다음 일")) return "ok";
    await ask([
      { question: "과일은?", options: ["사과", "바나나", "포도"], multiSelect: true },
      { question: "크기는?", options: ["작게", "크게"] },
      { question: "남길 말은?" },
    ]);
    return "끝";
  }, log);
  const { room } = setup(t, runner);
  room.sendUserMessage("@claude 진행해 줘");
  await waitFor(() => pending(room).length === 1);
  room.answerUserQuestion({
    questionId: pending(room)[0].questionId,
    answers: [{ selected: ["포도", "사과"], other: "딸기" }, { selected: [], other: "중간쯤" }, { text: "고마워요" }],
  });
  await room.waitForIdle();

  const lines = systemLines(room).filter((text) => text.includes("→ 답:"));
  assert.deepEqual(lines, ['@claude의 질문 3개 → 답: 1) 사과, 포도, 기타 "딸기" · 2) 기타 "중간쯤" · 3) "고마워요"']);

  room.sendUserMessage("@claude 다음 일");
  await room.waitForIdle();
  assert.equal(log.calls.at(-1).prompt.includes("→ 답:"), false, "시스템 줄은 프롬프트에 섞이지 않는다");
});

test("한 질문의 답 한 줄은 길면 줄여 남기고, 답이 하나뿐이면 번호를 붙이지 않는다", async (t) => {
  const runner = scriptedRunner(async ({ ask }) => { await ask([{ question: "의견은?" }]); return "끝"; });
  const { room } = setup(t, runner);
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  room.answerUserQuestion({ questionId: pending(room)[0].questionId, answers: [{ text: "가".repeat(500) }] });
  await room.waitForIdle();
  const [line] = systemLines(room).filter((text) => text.includes("→ 답:"));
  assert.match(line, /^@claude의 질문 1개 → 답: "가{60}…"$/);
});

test("건너뛰면 건너뛰었다는 한 줄이, 중지로 닫히면 무엇을 물었는지 한 줄이 남는다", async (t) => {
  const runner = scriptedRunner(async ({ ask, args }) => {
    await ask([{ question: "하나?", options: ["가", "나"] }]);
    return "계속";
  });
  const { room } = setup(t, runner);
  room.sendUserMessage("@claude 첫째");
  await waitFor(() => pending(room).length === 1);
  room.cancelUserQuestion({ questionId: pending(room)[0].questionId });
  await room.waitForIdle();
  assert.deepEqual(systemLines(room).filter((text) => text.includes("질문")), ["@claude의 질문 1개를 건너뛰었습니다. 답 없이 이어 가도록 알렸습니다."]);

  const stopRunner = scriptedRunner(async ({ ask }) => { await ask([{ question: "하나?", options: ["가", "나"] }]); return "x"; });
  const second = setup(t, stopRunner).room;
  second.sendUserMessage("@claude 둘째");
  await waitFor(() => pending(second).length === 1);
  second.stopAll();
  assert.equal(pending(second).length, 0);
  // 중지·삭제·잠깐은 모두 같은 닫힘이라, 무엇을 물었는지 한 줄을 남긴다(예전에는 아무 줄도 없었다).
  assert.deepEqual(systemLines(second).filter((text) => text.includes("질문")), ["@claude의 질문 1개: 중지로 닫혔습니다."]);

  const interjectRunner = scriptedRunner(async ({ ask }) => { await ask([{ question: "하나?" }, { question: "둘?" }]); return "x"; });
  const third = setup(t, interjectRunner).room;
  third.sendUserMessage("@claude 셋째");
  await waitFor(() => pending(third).length === 1);
  third.interject();
  assert.deepEqual(systemLines(third).filter((text) => text.includes("질문")), ["@claude의 질문 2개: 중지로 닫혔습니다."]);
});

test("여러 줄로 쓴 답도 대화에는 한 줄로 남고, 전체 답은 질문 기록에 그대로 있다", async (t) => {
  const runner = scriptedRunner(async ({ ask }) => { await ask([{ question: "의견은?" }, { question: "더?", options: ["가", "나"], multiSelect: true }]); return "끝"; });
  const { room } = setup(t, runner);
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  const questionId = pending(room)[0].questionId;
  room.answerUserQuestion({ questionId, answers: [{ text: "첫 줄\n\n  둘째 줄\t끝" }, { selected: ["가"], other: "기타\r\n줄" }] });
  await room.waitForIdle();
  const [line] = systemLines(room).filter((text) => text.includes("→ 답:"));
  assert.equal(line, '@claude의 질문 2개 → 답: 1) "첫 줄 둘째 줄 끝" · 2) 가, 기타 "기타 줄"');
  assert.equal(/[\r\n\t]/.test(line), false);
  assert.equal(room.userQuestionList().find((q) => q.questionId === questionId).answers[0].text, "첫 줄\n\n  둘째 줄\t끝", "전체 답은 그대로 보관한다");
});

test("호출한 쪽(CLI)이 도구 호출을 먼저 끊으면 '연결이 끊겨 닫혔다'고 알리고, 작업이 끝났다고 하지 않는다", async (t) => {
  const { httpPost } = require("./question-helpers.cjs");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = scriptedRunner(async ({ base, token }) => {
    const requests = new Set();
    const asking = httpPost(base, token, "ask", { questions: [{ question: "하나?", options: ["가", "나"] }] }, requests).catch(() => null);
    await waitFor(() => pending(room).length === 1);
    [...requests][0].destroy(); // CLI가 도구 시간 제한으로 포기한 것과 같다. 프로세스는 살아 있다.
    await asking;
    await gate;
    return "계속했습니다";
  });
  const { room } = setup(t, runner);
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  await waitFor(() => pending(room).length === 0);
  const lines = systemLines(room).filter((text) => text.includes("질문"));
  assert.deepEqual(lines, ["@claude의 질문 1개: 연결이 끊겨 닫혔습니다. 작업은 질문 없이 이어질 수 있습니다."]);
  assert.doesNotMatch(lines[0], /작업이 끝나/);
  release();
  await room.waitForIdle();
});

test("다시 켠 뒤 답을 기다리다 중단된 질문은 대화에 한 줄로 알리고, 카드로 되살아나지 않는다", () => {
  const room = new ChatRoom({
    sessionId: "s1",
    agents: AGENTS(),
    runAgent: () => { throw new Error("실행하지 않는다"); },
    initialQuestions: [
      { questionId: "q1", sessionId: "s1", agentId: "codex", runId: "r1", turnId: "t1", status: "pending", createdAt: 1, questions: [{ question: "?", options: ["가", "나"], multiSelect: false }] },
      { questionId: "q2", sessionId: "s1", agentId: "claude", runId: "r2", turnId: "t2", status: "answered", createdAt: 2, questions: [{ question: "?", options: [], multiSelect: false }] },
    ],
  });
  assert.equal(room.pendingUserQuestionList().length, 0, "중단된 질문은 답할 수 없다");
  assert.deepEqual(room.userQuestionList().map((question) => [question.questionId, question.status]), [["q1", "interrupted"], ["q2", "answered"]]);
  room.announceInterruptedQuestions();
  assert.deepEqual(systemLines(room), ["@codex의 질문 1개는 앱이 꺼져 답을 받지 못했습니다. 필요하면 다시 말을 걸어 주세요."]);
});

test("질문 카드를 기다리는 에이전트에게 메시지를 보내면 카드의 답이 아니라고 질문마다 한 번 알리고, 그 메시지는 카드를 처리한 뒤 전달된다", async (t) => {
  const log = {};
  const runner = scriptedRunner(async ({ ask, args }) => {
    if (args.agent.id === "codex" || args.prompt.includes("다른 이야기")) return "다른 답";
    await ask([{ question: "하나?", options: ["가", "나"] }]);
    return "첫 답";
  }, log);
  const { room } = setup(t, runner);
  const hints = () => systemLines(room).filter((text) => text.includes("질문 카드에 답을 기다리는 중"));
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);

  room.sendUserMessage("@codex 이건 다른 사람에게");
  room.sendUserMessage("@claude 다른 이야기");
  room.sendUserMessage("@claude 또 다른 이야기");
  assert.deepEqual(hints(), ["@claude가 질문 카드에 답을 기다리는 중입니다. 이 메시지는 카드에 답하거나 건너뛴 뒤 전달됩니다."], "질문 하나에 한 번, 다른 에이전트에게 간 메시지에는 없다");
  assert.equal(pending(room).length, 1, "메시지는 카드에 답하지 않는다");
  assert.equal(log.calls.filter((call) => call.agent.id === "claude").length, 1, "새 차례는 기다리는 실행 뒤에 줄을 선다");

  room.cancelUserQuestion({ questionId: pending(room)[0].questionId });
  await room.waitForIdle();
  assert.equal(log.calls.filter((call) => call.agent.id === "claude").length, 2, "카드를 처리한 뒤 전달된다");
  assert.equal(hints().length, 1);
});
