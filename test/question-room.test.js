"use strict";

// 실행 중 질문(ask_user)을 방(ChatRoom)에 연결한 흐름. 진입점은 방이고, CLI 자리에는 MCP 서버와 똑같이
// 진짜 중계소에 HTTP로 묻는 가짜 러너를 둔다. 답이 오면 "같은 러너의 같은 promise"가 이어지는지 본다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { createUserQuestionBroker } = require("../src/chat/user-question-broker");
const {
  createRoomQuestionTool, questionBrokerHooks, USER_QUESTION_INSTRUCTION, SERVER_KEY, TOOL_NAME,
} = require("../src/chat/user-question-run");
const { waitFor, fakeClock, httpPost, scriptedRunner } = require("./question-helpers.cjs");

const AGENTS = () => [
  { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
  { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
  { id: "agy", name: "Antigravity", aliases: ["agy"], available: true, enabled: true },
];

const ASK_ONE = [{ question: "어느 쪽으로 할까요?", options: ["가", "나"] }];

// 중계소 하나 + 방 여러 개. 방은 sessionId로 찾아 콜백을 받는다(chat-ipc가 하는 일과 같다).
function setup(t, { sessions = ["s1"], runner, needsShellOf, brokerOptions = {}, roomOptions = {} } = {}) {
  const rooms = new Map();
  const broker = createUserQuestionBroker({
    ...questionBrokerHooks((sessionId) => rooms.get(sessionId) || null),
    onCallbackError: () => {},
    ...brokerOptions,
  });
  t.after(() => broker.stop());
  const events = [];
  for (const sessionId of sessions) {
    const room = new ChatRoom({
      sessionId,
      agents: AGENTS(),
      runAgent: runner,
      questionTool: createRoomQuestionTool({ broker, sessionId, needsShellOf }),
      ...roomOptions,
    });
    room.on("user-question", (question) => events.push({ sessionId, ...question }));
    rooms.set(sessionId, room);
  }
  return { broker, rooms, room: rooms.get(sessions[0]), events };
}

const pending = (room) => room.pendingUserQuestionList();
const statuses = (events, questionId) => events.filter((e) => e.questionId === questionId).map((e) => e.status);

test("답을 보내면 같은 실행이 이어져 결과가 대화에 실리고, 질문 기록은 요청→전달 중→답함 순으로 바뀐다", async (t) => {
  const log = {};
  const runner = scriptedRunner(async ({ ask }) => {
    const reply = await ask(ASK_ONE);
    return `고른 것: ${reply.body.answers[0].selected[0]}`;
  }, log);
  const { room, broker, events } = setup(t, { runner });

  room.sendUserMessage("@claude 진행해 줘");
  await waitFor(() => pending(room).length === 1, 3000, "질문 도착");
  const [question] = pending(room);
  assert.equal(question.status, "pending");
  assert.equal(question.sessionId, "s1");
  assert.equal(question.agentId, "claude");
  assert.match(question.runId, /^rs1-\d+$/);
  assert.equal(question.turnId, "t1");
  assert.deepEqual(question.questions, [{ question: "어느 쪽으로 할까요?", options: ["가", "나"], multiSelect: false }]);
  assert.equal(log.calls.length, 1, "질문이 도착하는 동안 실행은 하나뿐이다");

  const result = room.answerUserQuestion({ questionId: question.questionId, answers: [{ selected: ["나"] }] });
  assert.deepEqual(result, { ok: true });
  await room.waitForIdle();

  assert.equal(log.calls.length, 1, "답 때문에 새 실행이 생기지 않는다(같은 실행이 이어진다)");
  const reply = room.messages.find((message) => message.authorType === "agent");
  assert.equal(reply.text, "고른 것: 나");
  assert.deepEqual(statuses(events, question.questionId), ["pending", "submitting", "answered"]);
  const last = events.at(-1);
  assert.equal(last.status, "answered");
  assert.deepEqual(last.answers, [{ selected: ["나"] }]);
  assert.ok(last.answeredAt >= last.createdAt);
  assert.equal(pending(room).length, 0);
  assert.equal(broker.listPending().length, 0);
  // 실행이 끝나면 중계소 등록도 풀려, 옛 토큰으로는 더 물을 수 없다.
  const env = log.calls[0].userQuestion.server.env;
  const stale = await httpPost(env.AGORA_QUESTION_URL, env.AGORA_QUESTION_TOKEN, "ask", { questions: ASK_ONE });
  assert.equal(stale.status, 401);
});

test("질문 도구가 붙은 실행은 서버 설정과 도구 이름을 받고, 프롬프트에 사용법과 끝 줄 대체 수단이 함께 실린다", async (t) => {
  const log = {};
  const { room } = setup(t, { runner: scriptedRunner(async () => "끝", log) });
  room.sendUserMessage("@claude 안녕");
  await room.waitForIdle();
  const call = log.calls[0];
  assert.equal(call.userQuestion.serverKey, SERVER_KEY);
  assert.equal(call.userQuestion.toolName, TOOL_NAME);
  assert.match(call.userQuestion.server.env.AGORA_QUESTION_URL, /^http:\/\/127\.0\.0\.1:\d+\/runs\//);
  for (const line of USER_QUESTION_INSTRUCTION.split("\n")) assert.ok(call.prompt.includes(line), `프롬프트에 안내가 있어야 한다: ${line}`);
  assert.match(call.prompt, /ASK_USER: <질문 한 줄>/, "끝 ASK_USER 계약은 대체 수단으로 남는다");
  assert.match(call.prompt, /ask_user를 쓸 수 없거나 실패하면/);
});

test("중지하면 답을 기다리던 질문이 취소되고 프로세스는 끊기며, 방은 곧바로 다음 대화를 받는다", async (t) => {
  const log = {};
  const { room, broker, events } = setup(t, {
    runner: scriptedRunner(async ({ ask, args }) => {
      if (args.prompt.includes("두 번째")) return "두 번째 답";
      await ask(ASK_ONE);
      return "여기까지 오면 안 된다";
    }, log),
  });
  room.sendUserMessage("@claude 첫 번째");
  await waitFor(() => pending(room).length === 1);
  const questionId = pending(room)[0].questionId;

  room.stopAll();
  assert.equal(log.runs[0].cancelled, true, "프로세스(러너)는 예전처럼 끊긴다");
  assert.equal(pending(room).length, 0);
  assert.deepEqual(statuses(events, questionId), ["pending", "cancelled"]);
  assert.equal(events.at(-1).reason, "stopped");
  assert.equal(broker.listPending().length, 0);
  assert.deepEqual(log.runs[0].waiting, [true], "대기 표시는 한 번 켜졌다");
  assert.deepEqual(room.answerUserQuestion({ questionId, answers: [{ selected: ["가"] }] }).ok, false, "취소된 질문에는 더 답할 수 없다");

  room.sendUserMessage("@claude 두 번째");
  await room.waitForIdle();
  assert.equal(room.messages.filter((message) => message.authorType === "agent").at(-1).text, "두 번째 답");
});

test("잠깐(interject)도 답을 기다리던 질문을 끝낸다", async (t) => {
  const log = {};
  const { room, events } = setup(t, { runner: scriptedRunner(async ({ ask }) => { await ask(ASK_ONE); return "x"; }, log) });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  room.interject();
  assert.equal(pending(room).length, 0);
  assert.equal(events.at(-1).status, "cancelled");
  assert.equal(log.runs[0].cancelled, true);
  await room.waitForIdle();
});

test("앱 종료는 답을 기다리던 질문을 '중단됨'으로 남기고 프로세스를 끊는다", async (t) => {
  const log = {};
  const { room, broker, events } = setup(t, { runner: scriptedRunner(async ({ ask }) => { await ask(ASK_ONE); return "x"; }, log) });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  room.interruptQuestions();
  room.stopAllSilently();
  assert.equal(events.at(-1).status, "interrupted");
  assert.equal(events.at(-1).reason, "app-quit");
  assert.equal(pending(room).length, 0);
  assert.equal(log.runs[0].cancelled, true);
  assert.equal(broker.listPending().length, 0);
  await room.waitForIdle();
});

test("다시 켜면 답을 기다리던 질문은 '중단됨'이 되어 기록에는 남고 답할 수는 없다", () => {
  const base = { sessionId: "s1", agentId: "claude", runId: "rs1-1", turnId: "t1", questions: [], createdAt: 1 };
  const room = new ChatRoom({
    sessionId: "s1",
    agents: AGENTS(),
    runAgent: () => { throw new Error("실행되면 안 된다"); },
    initialQuestions: [
      { ...base, questionId: "q-pending", status: "pending" },
      { ...base, questionId: "q-submitting", status: "submitting" },
      { ...base, questionId: "q-done", status: "answered", answeredAt: 2 },
      { ...base, questionId: "q-cancel", status: "cancelled" },
    ],
  });
  const byId = Object.fromEntries(room.userQuestionList().map((question) => [question.questionId, question]));
  assert.equal(byId["q-pending"].status, "interrupted");
  assert.equal(byId["q-submitting"].status, "interrupted");
  assert.equal(byId["q-done"].status, "answered");
  assert.equal(byId["q-cancel"].status, "cancelled");
  assert.deepEqual(room.interruptedOnLoad.map((question) => question.questionId).sort(), ["q-pending", "q-submitting"]);
  assert.equal(room.pendingUserQuestionList().length, 0, "중단된 질문은 행동할 수 있는 목록에 없다");
  assert.equal(room.hasPendingQuestion(), false);
  for (const id of ["q-pending", "q-submitting"]) {
    assert.equal(room.answerUserQuestion({ questionId: id, answers: [] }).ok, false);
    assert.equal(room.cancelUserQuestion({ questionId: id }).ok, false);
  }
});

test("답하지 않기로 하면 모델에는 건너뛰었다는 결과가 돌아가고 같은 실행이 이어진다", async (t) => {
  const log = {};
  const { room, events } = setup(t, {
    runner: scriptedRunner(async ({ ask }) => {
      const reply = await ask(ASK_ONE);
      return `모델이 받은 것: ${reply.body.status}`;
    }, log),
  });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  assert.deepEqual(room.cancelUserQuestion({ questionId: pending(room)[0].questionId }), { ok: true });
  await room.waitForIdle();
  assert.equal(room.messages.find((m) => m.authorType === "agent").text, "모델이 받은 것: skipped");
  assert.equal(events.at(-1).status, "cancelled");
  assert.equal(events.at(-1).reason, "user-skip");
  assert.deepEqual(log.runs[0].waiting, [true, false]);
  assert.equal(log.calls.length, 1);
});

test("답하지 않기로 한 질문을 모델이 세 번 더 던지면 실행을 멈추고 이유를 알린다", async (t) => {
  const log = {};
  const { room } = setup(t, {
    runner: scriptedRunner(async ({ ask }) => {
      await ask(ASK_ONE);
      for (let i = 0; i < 5; i += 1) await ask(ASK_ONE);
      return "여기까지 오면 안 된다";
    }, log),
  });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  room.cancelUserQuestion({ questionId: pending(room)[0].questionId });
  await room.waitForIdle();
  assert.equal(log.runs[0].cancelled, true);
  assert.equal(room.messages.some((m) => m.authorType === "agent"), false, "멈춘 실행의 답은 대화에 싣지 않는다");
  assert.ok(room.messages.some((m) => m.authorType === "system" && /계속 던져 이번 실행을 멈췄습니다/.test(m.text)));
  assert.equal(pending(room).length, 0);
});

test("질문을 기다리는 동안 시간 제한이 멈추고, 답·건너뛰기·30분 시간 초과로 다시 흐른다", async (t) => {
  const clock = fakeClock();
  const log = {};
  let step = 0;
  const { room, events } = setup(t, {
    brokerOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    runner: scriptedRunner(async ({ ask }) => {
      const first = await ask(ASK_ONE);
      step = 1;
      return `1차 ${first.body.status}`;
    }, log),
  });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  assert.deepEqual(log.runs[0].waiting, [true]);
  clock.advance(30 * 60 * 1000 + 1);
  await room.waitForIdle();
  assert.equal(step, 1);
  assert.deepEqual(log.runs[0].waiting, [true, false]);
  assert.equal(events.at(-1).status, "cancelled");
  assert.equal(events.at(-1).reason, "timeout");
  assert.equal(room.messages.find((m) => m.authorType === "agent").text, "1차 timeout");
});

test("두 방이 같은 중계소를 써도 질문이 섞이지 않고, 한 방의 중지가 다른 방의 질문을 건드리지 않는다", async (t) => {
  const log = {};
  const { rooms, broker } = setup(t, {
    sessions: ["sa", "sb"],
    runner: scriptedRunner(async ({ ask, args }) => {
      const reply = await ask([{ question: `질문 ${args.runId}`, options: ["가", "나"] }]);
      return `답 ${reply.body.answers[0].selected[0]}`;
    }, log),
  });
  const a = rooms.get("sa");
  const b = rooms.get("sb");
  a.sendUserMessage("@claude A방");
  b.sendUserMessage("@claude B방");
  await waitFor(() => pending(a).length === 1 && pending(b).length === 1);
  const qa = pending(a)[0];
  const qb = pending(b)[0];
  assert.notEqual(qa.questionId, qb.questionId);
  assert.match(qa.questions[0].question, /rsa-/);
  assert.match(qb.questions[0].question, /rsb-/);

  const wrongRoom = b.answerUserQuestion({ questionId: qa.questionId, answers: [{ selected: ["가"] }] });
  assert.equal(wrongRoom.ok, false, "다른 방의 질문 id로는 답할 수 없다");
  const wrongRun = a.answerUserQuestion({ questionId: qa.questionId, runId: qb.runId, answers: [{ selected: ["가"] }] });
  assert.equal(wrongRun.ok, false, "다른 실행의 runId가 섞이면 거절한다");
  assert.equal(pending(a).length, 1);

  a.stopAll();
  assert.equal(pending(a).length, 0);
  assert.equal(pending(b).length, 1, "B방 질문은 그대로");
  assert.equal(broker.listPending().length, 1);
  assert.deepEqual(b.answerUserQuestion({ questionId: qb.questionId, answers: [{ selected: ["나"] }] }), { ok: true });
  await b.waitForIdle();
  assert.equal(b.messages.find((m) => m.authorType === "agent").text, "답 나");
});

test("한 방에서 두 에이전트가 동시에 물어도 각자의 질문·실행·턴에 묶인다", async (t) => {
  const log = {};
  const { room } = setup(t, {
    runner: scriptedRunner(async ({ ask, args }) => {
      const reply = await ask([{ question: `${args.agent.id} 질문`, options: ["가", "나"] }]);
      return `${args.agent.id}는 ${reply.body.answers[0].selected[0]}`;
    }, log),
  });
  room.sendUserMessage({ text: "@claude @codex 각자 해 줘", independent: true });
  await waitFor(() => pending(room).length === 2);
  const byAgent = Object.fromEntries(pending(room).map((question) => [question.agentId, question]));
  assert.notEqual(byAgent.claude.runId, byAgent.codex.runId);
  assert.notEqual(byAgent.claude.turnId, byAgent.codex.turnId);
  assert.equal(byAgent.claude.questions[0].question, "claude 질문");
  assert.equal(byAgent.codex.questions[0].question, "codex 질문");

  room.answerUserQuestion({ questionId: byAgent.codex.questionId, answers: [{ selected: ["나"] }] });
  await waitFor(() => room.messages.some((m) => m.author === "codex"));
  assert.equal(pending(room).length, 1);
  assert.equal(pending(room)[0].agentId, "claude");
  room.answerUserQuestion({ questionId: byAgent.claude.questionId, answers: [{ selected: ["가"] }] });
  await room.waitForIdle();
  const texts = Object.fromEntries(room.messages.filter((m) => m.authorType === "agent").map((m) => [m.author, m.text]));
  assert.deepEqual(texts, { claude: "claude는 가", codex: "codex는 나" });
});

test("토론·결론 종합·쉽게 설명 같은 도우미 턴, AGY, 셸 래퍼 설치에는 질문 도구를 붙이지 않는다", async (t) => {
  const log = {};
  const { room } = setup(t, {
    runner: scriptedRunner(async () => "[[CODEPET_DISCUSSION:CONCLUDE]]", log),
    needsShellOf: (agent) => agent.id === "codex",
  });
  // 일반 대화(claude)에는 붙는다.
  room.sendUserMessage("@claude 안녕");
  await room.waitForIdle();
  assert.ok(log.calls.at(-1).userQuestion, "일반 대화는 붙는다");

  const before = log.calls.length;
  room.sendUserMessage("@agy 안녕");
  room.sendUserMessage("@codex 안녕");
  await room.waitForIdle();
  const plain = log.calls.slice(before);
  assert.equal(plain.length, 2);
  for (const call of plain) {
    assert.equal("userQuestion" in call, false, `${call.agent.id}: 실행 인자에 질문 도구가 없다`);
    assert.doesNotMatch(call.prompt, /ask_user|agora_user_question/);
  }

  const mark = log.calls.length;
  const discussion = await room.startDiscussion({ agentIds: ["claude", "codex"], turnBudget: 3 });
  assert.equal(discussion.ok, true);
  const messageId = room.messages.find((m) => m.discussionMeta)?.discussionMeta.discussionId;
  await room.summarizeDiscussion(messageId, "claude");
  const source = room.messages.find((m) => m.authorType === "agent" && m.author === "claude");
  room.handoffMessage("claude", source.id, "SIMPLIFY");
  await room.waitForIdle();
  const helper = log.calls.slice(mark);
  assert.ok(helper.length >= 3, "토론 턴·결론 종합·쉽게 설명이 모두 실행됐다");
  for (const call of helper) {
    assert.equal("userQuestion" in call, false, "토론·도우미 턴에는 질문 도구가 없다");
    assert.doesNotMatch(call.prompt, /ask_user|agora_user_question/);
  }
});

test("질문 도구를 붙이지 못하면 이유를 알리고, 프롬프트도 도구 없는 예전 모양으로 실행한다", async (t) => {
  const calls = [];
  const room = new ChatRoom({
    sessionId: "s1",
    agents: AGENTS(),
    runAgent: (args) => { calls.push(args); return { promise: Promise.resolve({ ok: true, text: "완료" }), cancel() {} }; },
    questionTool: {
      broker: {},
      canAttach: () => true,
      attach: async () => ({ attached: false, reason: "중계소를 시작하지 못했습니다" }),
    },
  });
  room.sendUserMessage("@claude 안녕");
  await room.waitForIdle();
  assert.equal(calls.length, 1);
  assert.equal("userQuestion" in calls[0], false);
  assert.doesNotMatch(calls[0].prompt, /ask_user/);
  assert.match(calls[0].prompt, /ASK_USER: <질문 한 줄>/);
  assert.ok(room.messages.some((m) => m.authorType === "system" && /중계소를 시작하지 못했습니다/.test(m.text)), "붙이지 못한 이유를 알린다");
  assert.equal(room.messages.find((m) => m.authorType === "agent").text, "완료", "대화는 그대로 진행된다");
});

test("모델이 질문을 던진 채 실행이 끝나도 답을 기다리는 질문이 남지 않는다", async (t) => {
  const log = {};
  const { room, broker, events } = setup(t, {
    runner: scriptedRunner(async ({ base, token }) => {
      // 응답을 기다리지 않고 질문만 걸어 두고 끝난다(프로세스가 먼저 죽은 경우).
      void httpPost(base, token, "ask", { questions: ASK_ONE }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "끝";
    }, log),
  });
  room.sendUserMessage("@claude 시작");
  await room.waitForIdle();
  assert.equal(pending(room).length, 0);
  assert.equal(broker.listPending().length, 0);
  const last = events.at(-1);
  assert.equal(last.status, "cancelled");
  assert.equal(last.reason, "run-ended");
});

test("알림을 받는 쪽이 예외를 던져도 답은 전달되고 시간 제한은 풀린다", async (t) => {
  const log = {};
  const { room } = setup(t, {
    runner: scriptedRunner(async ({ ask }) => (await ask(ASK_ONE)).body.status, log),
  });
  let armed = false;
  room.on("user-question", () => { if (armed) throw new Error("저장 실패 흉내"); });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  armed = true;
  assert.deepEqual(room.answerUserQuestion({ questionId: pending(room)[0].questionId, answers: [{ selected: ["가"] }] }), { ok: true });
  await room.waitForIdle();
  assert.equal(room.messages.find((m) => m.authorType === "agent").text, "answered");
  assert.deepEqual(log.runs[0].waiting, [true, false], "예외가 나도 시간 제한은 풀렸다");
});

test("질문을 기다리는 동안 뒤 차례의 안내 문구는 사용자의 답을 기다린다고 알려 준다", async (t) => {
  const log = {};
  const { room } = setup(t, { runner: scriptedRunner(async ({ ask }) => { await ask(ASK_ONE); return "x"; }, log) });
  room.sendUserMessage("@claude 시작");
  await waitFor(() => pending(room).length === 1);
  room.sendUserMessage("@codex 이어서");
  const queuedTurn = room.turnQueue[0];
  assert.equal(queuedTurn.agent.id, "codex");
  // 대기 시작 시각을 직접 과거로 돌려 안내가 나오게 한다.
  room.turnStartedAt.set(queuedTurn.turnId, Date.now() - 200 * 1000);
  room.checkTurnStall(queuedTurn.turnId);
  assert.ok(room.messages.some((m) => m.authorType === "system" && /사용자의 답을 기다리는 질문이 있습니다/.test(m.text)));
  room.stopAll();
  await room.waitForIdle();
});
