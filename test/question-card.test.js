"use strict";

// 실행 중 질문 카드(src/question-card.js)의 화면 동작. 진입점은 createQuestionCards이고, DOM은 시험용 최소
// 흉내(question-fake-dom.cjs)다. 보내기·건너뛰기는 chat.js가 넘기는 콜백이라 여기서는 가짜로 둔다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuestionCards } = require("../src/question-card");
const { FakeNode, makeDocument } = require("./question-fake-dom.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

let seq = 0;
function record(extra = {}) {
  seq += 1;
  return {
    questionId: `q${seq}`, sessionId: "room-a", agentId: "claude", runId: "r1", turnId: "t1", status: "pending",
    createdAt: seq,
    questions: [{ question: "어느 쪽으로 갈까요?", options: ["가", "나", "다"], multiSelect: false }],
    ...extra,
  };
}

function setup({ answer, skip } = {}) {
  const container = new FakeNode("div");
  container.hidden = true;
  const state = { session: "room-a", answers: [], skips: [], changes: 0 };
  const agents = { claude: { id: "claude", name: "Claude", color: "#d97706" }, codex: { id: "codex", name: "Codex", color: "#10a37f" } };
  const cards = createQuestionCards({
    container,
    document: makeDocument(),
    makeAgentAvatar: (agent, className) => { const node = new FakeNode("span"); node.className = className; node.own = agent.id; return node; },
    agentById: (id) => agents[id] || null,
    getSessionId: () => state.session,
    answer: answer || (async (question, answers) => { state.answers.push({ question, answers }); return { ok: true }; }),
    skip: skip || (async (question) => { state.skips.push(question); return { ok: true }; }),
    onChange: () => { state.changes += 1; },
  });
  const card = (index = 0) => container.children[index];
  const send = (index = 0) => card(index).byClass("question-send")[0];
  const skipLink = (index = 0) => card(index).byClass("question-skip")[0];
  const inputs = (index = 0) => card(index).findAll((node) => node.tagName === "INPUT" && node.type !== "text");
  const other = (index = 0, question = 0) => card(index).byClass("question-other")[question];
  return { container, cards, state, card, send, skipLink, inputs, other };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("단일 선택: 누가 묻는지와 질문·보기·직접 입력 칸이 보이고, 고르기 전에는 보내기가 막혀 있다", () => {
  const ui = setup();
  ui.cards.replaceAll([record()]);
  assert.equal(ui.container.hidden, false);
  assert.equal(ui.container.children.length, 1);
  const card = ui.card();
  assert.match(card.attributes["aria-label"], /Claude의 질문/);
  assert.equal(card.byClass("question-who")[0].textContent, "Claude");
  assert.ok(card.find((node) => node.className === "agent-avatar"), "아바타가 있다");
  assert.equal(card.byClass("question-text")[0].textContent, "어느 쪽으로 갈까요?");
  const radios = ui.inputs();
  assert.deepEqual(radios.map((node) => [node.type, node.value]), [["radio", "가"], ["radio", "나"], ["radio", "다"]]);
  assert.equal(new Set(radios.map((node) => node.name)).size, 1, "한 질문의 라디오는 한 묶음이다");
  assert.equal(ui.other().placeholder, "기타 — 직접 입력");
  assert.equal(ui.send().disabled, true);
  assert.equal(ui.skipLink().disabled, false);

  radios[1].click();
  assert.equal(ui.send().disabled, false);
  ui.send().click();
  assert.deepEqual(ui.state.answers.map((entry) => entry.answers), [[{ selected: ["나"] }]]);
});

test("보낸 뒤에는 처리됨 알림을 기다리지 않고 카드가 거두어진다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record()]);
  ui.inputs()[0].click();
  ui.send().click();
  await settle();
  assert.equal(ui.container.children.length, 0);
  assert.equal(ui.container.hidden, true);
  assert.equal(ui.cards.hasPending(), false);
});

test("복수 선택: 체크박스로 켜고 끄고, 답은 보기에 적힌 순서이며 기타는 더해서 보낸다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record({ questions: [{ question: "무엇을?", options: ["가", "나", "다"], multiSelect: true }] })]);
  const boxes = ui.inputs();
  assert.ok(boxes.every((node) => node.type === "checkbox"));
  boxes[2].click();
  boxes[0].click();
  boxes[1].click();
  boxes[1].click(); // 다시 눌러 뺀다
  assert.equal(ui.send().disabled, false);
  ui.other().type_("  라  ");
  ui.send().click();
  await settle();
  assert.deepEqual(ui.state.answers[0].answers, [{ selected: ["가", "다"], other: "라" }]);
});

test("복수 선택은 보기를 하나도 안 골라도 기타만 쓰면 보낼 수 있다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record({ questions: [{ question: "무엇을?", options: ["가", "나"], multiSelect: true }] })]);
  assert.equal(ui.send().disabled, true);
  ui.other().type_("다른 것");
  assert.equal(ui.send().disabled, false);
  ui.send().click();
  await settle();
  assert.deepEqual(ui.state.answers[0].answers, [{ selected: [], other: "다른 것" }]);
});

test("단일 선택에서 기타를 쓰면 고른 보기를 대신하고, 다시 보기를 고르면 기타가 지워진다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record()]);
  const radios = ui.inputs();
  radios[0].click();
  ui.other().type_("내 생각");
  assert.deepEqual(radios.map((node) => node.checked), [false, false, false], "기타를 쓰면 고른 보기가 풀린다");
  radios[2].click();
  assert.equal(ui.other().value, "", "보기를 고르면 쓰던 기타가 비워진다");
  ui.other().type_("다시 기타");
  ui.send().click();
  await settle();
  assert.deepEqual(ui.state.answers[0].answers, [{ selected: [], other: "다시 기타" }]);
});

test("직접 입력 질문: 입력 칸 하나뿐이고 글이 있어야 보낼 수 있다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record({ questions: [{ question: "남길 말은?", options: [], multiSelect: false }] })]);
  assert.equal(ui.inputs().length, 0, "고르는 칸이 없다");
  assert.equal(ui.other().placeholder, "직접 입력");
  assert.equal(ui.other().maxLength, 8000);
  assert.equal(ui.send().disabled, true);
  ui.other().type_("   ");
  assert.equal(ui.send().disabled, true, "공백뿐인 글은 답이 아니다");
  ui.other().type_(" 고마워요 ");
  assert.equal(ui.send().disabled, false);
  ui.send().click();
  await settle();
  assert.deepEqual(ui.state.answers[0].answers, [{ text: "고마워요" }]);
});

test("질문이 여럿이면 번호가 붙고, 모든 질문에 답이 있어야 보내기가 열린다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record({
    questions: [
      { question: "하나", options: ["가", "나"], multiSelect: false },
      { question: "둘", options: ["x", "y"], multiSelect: true },
      { question: "셋", options: [], multiSelect: false },
    ],
  })]);
  assert.deepEqual(ui.card().byClass("question-text").map((node) => node.textContent), ["1. 하나", "2. 둘", "3. 셋"]);
  const [first, second, third] = [ui.other(0, 0), ui.other(0, 1), ui.other(0, 2)];
  assert.equal(ui.inputs().length, 4);
  ui.inputs()[0].click();
  assert.equal(ui.send().disabled, true);
  ui.inputs()[3].click();
  assert.equal(ui.send().disabled, true, "직접 입력 질문이 남았다");
  third.type_("글");
  assert.equal(ui.send().disabled, false);
  assert.ok(first && second);
  ui.send().click();
  await settle();
  assert.deepEqual(ui.state.answers[0].answers, [{ selected: ["가"] }, { selected: ["y"] }, { text: "글" }]);
});

test("입력 칸에서 Enter를 누르면 답이 다 찼을 때만 보낸다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record({ questions: [{ question: "말?", options: [], multiSelect: false }] })]);
  ui.other().dispatch("keydown", { key: "Enter" });
  assert.equal(ui.state.answers.length, 0, "비어 있으면 보내지 않는다");
  ui.other().type_("네");
  ui.other().dispatch("keydown", { key: "Enter", isComposing: true });
  assert.equal(ui.state.answers.length, 0, "한글 조합 중의 Enter는 글자 확정이다");
  const event = ui.other().dispatch("keydown", { key: "Enter" });
  assert.equal(event.prevented, true);
  await settle();
  assert.equal(ui.state.answers.length, 1);
});

test("보내기를 두 번 눌러도 한 번만 나가고, 실패하면 이유를 보이고 다시 보낼 수 있다", async () => {
  const pending = [];
  const calls = [];
  const ui = setup({ answer: (question, answers) => { calls.push(answers); const d = deferred(); pending.push(d); return d.promise; } });
  ui.cards.replaceAll([record()]);
  ui.inputs()[0].click();
  const send = ui.send();
  send.click();
  send.click();
  send.dispatch("click"); // 비활성이어도 이벤트가 직접 와도
  assert.equal(calls.length, 1, "응답 전 연타는 첫 번만 나간다");
  assert.equal(send.disabled, true);
  assert.equal(send.textContent, "보내는 중…");
  assert.equal(ui.skipLink().disabled, true, "보내는 중에는 건너뛰기도 막는다");

  pending[0].resolve({ ok: false, error: "이 질문은 이미 처리되었습니다." });
  await settle();
  assert.equal(ui.container.children.length, 1, "실패하면 카드가 남는다");
  assert.equal(send.disabled, false);
  assert.equal(send.textContent, "보내기");
  const error = ui.card().byClass("question-error")[0];
  assert.equal(error.textContent, "이 질문은 이미 처리되었습니다.");
  assert.equal(error.hidden, false);
  assert.equal(ui.inputs()[0].checked, true, "고르던 답은 그대로다");

  send.click();
  assert.equal(calls.length, 2);
  assert.equal(error.textContent, "", "다시 보내면 이전 오류는 지워진다");
  pending[1].resolve({ ok: true });
  await settle();
  assert.equal(ui.container.children.length, 0);
});

test("보내는 중 예외가 나도 카드가 멈춘 채 남지 않는다", async () => {
  const ui = setup({ answer: async () => { throw new Error("연결 끊김"); } });
  ui.cards.replaceAll([record()]);
  ui.inputs()[0].click();
  ui.send().click();
  await settle();
  assert.equal(ui.card().byClass("question-error")[0].textContent, "연결 끊김");
  assert.equal(ui.send().disabled, false);
});

test("건너뛰기는 답 없이 카드를 거두고, 실패하면 카드가 남는다", async () => {
  const ui = setup();
  ui.cards.replaceAll([record()]);
  const question = ui.card().dataset.questionId;
  ui.skipLink().click();
  await settle();
  assert.deepEqual(ui.state.skips.map((entry) => entry.questionId), [question]);
  assert.equal(ui.state.answers.length, 0);
  assert.equal(ui.container.children.length, 0);

  const failing = setup({ skip: async () => ({ ok: false, error: "이 대화에 없는 질문입니다." }) });
  failing.cards.replaceAll([record()]);
  failing.skipLink().click();
  await settle();
  assert.equal(failing.container.children.length, 1);
  assert.equal(failing.card().byClass("question-error")[0].textContent, "이 대화에 없는 질문입니다.");
});

test("다른 방의 질문은 카드로 뜨지 않고, 그 방에 돌아와 상태 스냅숏이 오면 다시 뜬다", () => {
  const ui = setup();
  ui.cards.apply(record({ sessionId: "room-b", agentId: "codex" }));
  assert.equal(ui.container.children.length, 0, "다른 방 알림은 무시한다");
  ui.cards.replaceAll([record({ sessionId: "room-b" }), record({ sessionId: "room-a" })]);
  assert.equal(ui.container.children.length, 1, "스냅숏에 섞여 온 다른 방 것도 거른다");

  const mine = ui.card().dataset.questionId;
  ui.state.session = "room-b"; // 방을 옮겼지만 새 스냅숏은 아직 안 왔다
  ui.cards.render();
  assert.equal(ui.container.children.length, 0, "옮긴 순간 이전 방 카드가 사라진다");
  assert.equal(ui.container.hidden, true);
  assert.equal(ui.cards.hasPending(), false);

  ui.cards.replaceAll([record({ sessionId: "room-b", questionId: "qb" })]);
  assert.equal(ui.card().dataset.questionId, "qb");
  ui.state.session = "room-a";
  ui.cards.replaceAll([record({ sessionId: "room-a", questionId: mine })]);
  assert.equal(ui.card().dataset.questionId, mine);
});

test("방을 옮겼다 돌아와도 쓰던 답은 그대로이고, 다른 경로로 처리된 질문의 쓰던 답은 버려진다", () => {
  const ui = setup();
  const question = record({ questionId: "keep" });
  ui.cards.replaceAll([question]);
  ui.inputs()[1].click();
  ui.other().type_("메모");
  ui.state.session = "room-b";
  ui.cards.replaceAll([]);
  ui.state.session = "room-a";
  ui.cards.replaceAll([question]);
  assert.deepEqual(ui.inputs().map((node) => node.checked), [false, false, false], "단일 선택은 기타를 쓰면 보기가 풀려 있다");
  assert.equal(ui.other().value, "메모");

  ui.cards.apply({ ...question, status: "cancelled", reason: "user-skip" });
  ui.cards.replaceAll([question]);
  assert.equal(ui.other().value, "", "처리된 질문의 초안은 버려지므로 새로 그리면 비어 있다");
});

test("어디서든 처리되면 카드가 사라진다: 답함·건너뜀·중지·중단 모두, 늦게 온 '대기' 알림은 되살리지 못한다", () => {
  for (const status of ["submitting", "answered", "cancelled", "interrupted"]) {
    const ui = setup();
    const question = record();
    ui.cards.apply(question);
    assert.equal(ui.container.children.length, 1);
    ui.cards.apply({ ...question, status });
    assert.equal(ui.container.children.length, 0, `${status}`);
    assert.equal(ui.container.hidden, true);
    ui.cards.apply(question); // 늦게 도착한 옛 알림
    assert.equal(ui.container.children.length, 0, "되살아나지 않는다");
  }
});

test("다시 켠 뒤의 중단된 질문은 카드가 아니다(대화에 남은 기록 한 줄뿐)", () => {
  const ui = setup();
  ui.cards.replaceAll([record({ status: "interrupted", reason: "app-restart" }), record({ status: "answered" })]);
  assert.equal(ui.container.children.length, 0);
  assert.equal(ui.container.hidden, true);
  assert.equal(ui.cards.hasPending(), false);
});

test("카드가 여럿 쌓여도 이미 그린 카드는 다시 만들거나 옮기지 않아 입력 중인 글과 위치가 유지된다", () => {
  const ui = setup();
  const first = record({ agentId: "claude", createdAt: 10 });
  ui.cards.replaceAll([first]);
  ui.other().type_("쓰는 중");
  const firstCard = ui.card();
  const second = record({ agentId: "codex", createdAt: 20 });
  ui.cards.apply(second);
  assert.equal(ui.container.children.length, 2);
  assert.equal(ui.card(0), firstCard, "먼저 온 카드가 그대로 앞에 있다");
  assert.equal(firstCard.moves, 0);
  assert.equal(ui.other(0).value, "쓰는 중");
  // 같은 질문의 다른 알림(스냅숏 재전송 등)이 와도 같은 카드다.
  ui.cards.replaceAll([first, second]);
  assert.equal(ui.card(0), firstCard);
  assert.equal(firstCard.moves, 0);
  assert.equal(ui.other(0).value, "쓰는 중");
  // 앞 카드를 지워도 뒤 카드는 같은 요소다.
  const secondCard = ui.card(1);
  ui.cards.apply({ ...first, status: "answered" });
  assert.equal(ui.card(0), secondCard);
  assert.equal(secondCard.dataset.questionId, second.questionId);
});

test("만들어진 시각 순서로 쌓이고, 늦게 온 오래된 질문은 제자리에 끼워진다", () => {
  const ui = setup();
  const late = record({ createdAt: 30 });
  ui.cards.replaceAll([late]);
  ui.cards.apply(record({ createdAt: 5 }));
  assert.deepEqual(ui.container.children.map((node) => node.dataset.questionId === late.questionId), [false, true]);
});

test("대기 질문이 생기고 사라질 때만 onChange가 불린다(중지·잠깐 버튼 표시용)", async () => {
  const ui = setup();
  const question = record();
  ui.cards.replaceAll([question]);
  assert.equal(ui.state.changes, 1);
  ui.cards.apply(question);
  ui.other().type_("글");
  assert.equal(ui.state.changes, 1, "같은 질문의 다시 그리기는 알리지 않는다");
  ui.cards.apply({ ...question, status: "answered" });
  assert.equal(ui.state.changes, 2);
});

test("카드는 문서 전역에 리스너를 걸지 않는다", () => {
  const ui = setup();
  assert.doesNotThrow(() => {
    ui.cards.replaceAll([record(), record(), record()]);
    ui.cards.replaceAll([]);
  });
});
