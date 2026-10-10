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

test("건너뛰면 건너뛰었다는 한 줄이 남고, 중지로 닫힌 질문은 따로 줄을 더하지 않는다", async (t) => {
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
  assert.deepEqual(systemLines(second).filter((text) => text.includes("질문")), []);
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
