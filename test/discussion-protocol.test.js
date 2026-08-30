const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DISCUSSION_PRESETS,
  DEFAULT_DISCUSSION_CYCLE_BUDGET,
  DISCUSSION_HARD_TURN_CEILING,
  maxCycleBudget,
  clampCycleBudget,
  resolveProtocol,
  speakerForTurn,
  isFinalStep,
} = require("../src/agora/discussion-protocol");
const { ChatRoom } = require("../src/chat/chat-room");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    { id: "agy", name: "Gemini", aliases: ["gemini", "agy"], available: true, enabled: true },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

// --- 순수 모듈 ---

test("Preset 3종(기획/Grill/Red Team)이 4단계 cycle로 정의되어 있다", () => {
  assert.deepEqual(Object.keys(DISCUSSION_PRESETS), ["shaping", "grill", "redteam"]);
  for (const preset of Object.values(DISCUSSION_PRESETS)) {
    assert.equal(preset.steps.length, 4);
    assert.equal(preset.slotCount, 3);
    // 마지막 단계는 항상 종합/판정 slot이다 — 조기 종료 권한의 근거.
    assert.equal(preset.steps[3].slot, 2);
  }
});

test("cycle 상한은 전체 hard ceiling(50턴)을 step 수로 나눠 유도한다", () => {
  assert.equal(DISCUSSION_HARD_TURN_CEILING, 50);
  // 4-step preset이면 12 cycle(48턴)까지 — 자유토론 50턴과 같은 천장을 쓴다.
  assert.equal(maxCycleBudget(4), 12);
  assert.equal(maxCycleBudget(5), 10);
  assert.equal(maxCycleBudget(undefined), 12);
});

test("clampCycleBudget: 1~max(stepCount 유도)로 자르고 비정수는 기본값", () => {
  assert.equal(clampCycleBudget(0, 4), 1);
  assert.equal(clampCycleBudget(9, 4), 9, "예전 magic number 5에 잘리지 않아야 합니다");
  assert.equal(clampCycleBudget(13, 4), 12);
  assert.equal(clampCycleBudget(2, 4), 2);
  assert.equal(clampCycleBudget("2", 4), DEFAULT_DISCUSSION_CYCLE_BUDGET);
  assert.equal(clampCycleBudget(undefined, 4), DEFAULT_DISCUSSION_CYCLE_BUDGET);
});

test("resolveProtocol: 미지 Preset과 잘못된 배정을 거부한다", () => {
  assert.equal(resolveProtocol({ presetId: "nope" }).ok, false);
  assert.equal(
    resolveProtocol({ presetId: "shaping", participantIds: ["a", "b"] }).ok,
    false,
    "참가자 수 부족"
  );
  assert.equal(
    resolveProtocol({ presetId: "shaping", participantIds: ["a", "a", "a"] }).ok,
    false,
    "서로 다른 참가자 2명 미만"
  );
});

test("resolveProtocol: slot 배정과 총 턴 수를 확정한다", () => {
  const resolved = resolveProtocol({
    presetId: "shaping",
    participantIds: ["claude", "codex", "agy"],
    cycleBudget: 2,
  });
  assert.equal(resolved.ok, true);
  const protocol = resolved.protocol;
  assert.equal(protocol.stepCount, 4);
  assert.equal(protocol.cycleBudget, 2);
  assert.equal(protocol.totalTurns, 8);
  assert.deepEqual(
    protocol.steps.map((step) => step.agentId),
    ["claude", "codex", "claude", "agy"]
  );
});

test("speakerForTurn: 발언 순서는 Preset이 정하고 cycle을 넘어 반복된다", () => {
  const { protocol } = resolveProtocol({
    presetId: "shaping",
    participantIds: ["a", "b", "c"],
    cycleBudget: 2,
  });
  const order = [];
  for (let turn = 1; turn <= protocol.totalTurns; turn += 1) {
    const speaker = speakerForTurn(protocol, turn);
    order.push(speaker.agentId);
    assert.equal(speaker.cycle, turn <= 4 ? 1 : 2);
  }
  assert.deepEqual(order, ["a", "b", "a", "c", "a", "b", "a", "c"]);
  assert.equal(speakerForTurn(protocol, 4).role.name, "종합자");
});

test("isFinalStep: cycle 마지막 단계만 true", () => {
  const { protocol } = resolveProtocol({
    presetId: "grill",
    participantIds: ["a", "b", "c"],
    cycleBudget: 2,
  });
  assert.equal(isFinalStep(protocol, 3), false);
  assert.equal(isFinalStep(protocol, 4), true);
  assert.equal(isFinalStep(protocol, 7), false);
  assert.equal(isFinalStep(protocol, 8), true);
});

// --- ChatRoom 통합 ---

test("구조화 토론은 Preset 순서대로 발언하고 cycle 예산에서 멈춘다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  await settle(room);

  assert.equal(result.ok, true);
  assert.equal(result.completed, 4);
  assert.equal(result.concluded, false);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "claude", "agy"]
  );
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.equal(conclusion.discussionMeta.protocol.presetId, "shaping");
  assert.equal(conclusion.discussionMeta.protocol.cyclesCompleted, 1);
  assert.equal(conclusion.discussionMeta.reason, "budget");
});

test("구조화 토론 프롬프트는 임시 역할과 단계 계약을 안내한다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  await settle(room);

  assert.match(calls[0].prompt, /임시 역할: 발안자/);
  assert.match(calls[0].prompt, /사이클 1\/1, 단계 1\/4/);
  assert.match(calls[0].prompt, /종료 판단은 사이클 마지막 순서만/);
  assert.match(calls[3].prompt, /임시 역할: 종합자/);
  assert.match(calls[3].prompt, /\[\[CODEPET_DISCUSSION:CONCLUDE\]\]/);
});

test("마지막 단계의 CONCLUDE만 조기 종료한다", async () => {
  const calls = [];
  const conclude = { ok: true, text: "결론입니다 [[CODEPET_DISCUSSION:CONCLUDE]]" };
  // 첫 답변은 토론 전 사용자 브로드캐스트가 소비하므로 filler를 앞에 둔다.
  const filler = { ok: true, text: "확인했습니다" };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ agy: [filler, conclude] }, calls),
  });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 3,
    },
  });
  await settle(room);

  assert.equal(result.completed, 4, "1사이클 종합 발언에서 끝나야 합니다");
  assert.equal(result.concluded, true);
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.equal(conclusion.discussionMeta.reason, "concluded");
  assert.equal(conclusion.discussionMeta.protocol.cyclesCompleted, 1);
});

test("중간 단계의 CONCLUDE와 AGREE는 순서를 바꾸지 못한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        // 첫 답변은 토론 전 사용자 브로드캐스트가 소비하므로 filler를 앞에 둔다.
        // 비평(2번째 순서)이 결론을 시도하고, 나머지는 전부 동의만 한다.
        codex: [
          { ok: true, text: "확인" },
          { ok: true, text: "끝내죠 [[CODEPET_DISCUSSION:CONCLUDE]]" },
        ],
        claude: [
          { ok: true, text: "확인" },
          { ok: true, text: "동의 [[CODEPET_DISCUSSION:AGREE]]" },
          { ok: true, text: "동의 [[CODEPET_DISCUSSION:AGREE]]" },
        ],
        agy: [
          { ok: true, text: "확인" },
          { ok: true, text: "동의 [[CODEPET_DISCUSSION:AGREE]]" },
        ],
      },
      calls
    ),
  });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  await settle(room);

  // 중간 CONCLUDE 무시 + 연속 AGREE 규칙 미적용 → 4턴 전부 실행.
  assert.equal(result.completed, 4);
  assert.equal(result.concluded, false);
});

test("구조화 토론은 step 실패 시 즉시 중단하고 이유를 표시한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        // 첫 답변은 토론 전 브로드캐스트가 소비. 비평(2번째 순서)이 실패한다.
        codex: [
          { ok: true, text: "확인" },
          { ok: false, error: "API 오류" },
        ],
      },
      calls
    ),
  });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 3,
    },
  });
  await settle(room);

  // 비평이 없는데 "비평 반영 수정"과 "종합"을 계속 실행하면 안 된다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.equal(conclusion.discussionMeta.reason, "failed");
  assert.equal(conclusion.discussionMeta.incomplete, true);
  // 실패한 cycle은 완료로 세지 않는다.
  assert.equal(conclusion.discussionMeta.protocol.cyclesCompleted, 0);
  assert.deepEqual(conclusion.discussionMeta.protocol.failedStep, {
    cycle: 1,
    step: 2,
    roleName: "비평가",
  });
  // 표시 문구가 reason과 일치해야 한다 — "예산 도달"로 위장하지 않는다.
  assert.match(conclusion.text, /비평가 단계 응답 실패로 구조화 토론을 중단했습니다/);
  assert.equal(result.ok, true);
});

test("구조화 토론 메시지에는 당시 역할 metadata가 남는다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);

  await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  await settle(room);

  const turnMessages = room.messages.filter((message) => message.discussionTurnMeta);
  assert.equal(turnMessages.length, 4);
  assert.deepEqual(turnMessages[1].discussionTurnMeta, {
    presetId: "shaping",
    cycle: 1,
    step: 2,
    roleName: "비평가",
  });
  assert.equal(turnMessages[1].author, "codex");
  // 역할 배정도 discussionMeta에 남아 과거 토론을 재현할 수 있다.
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.deepEqual(conclusion.discussionMeta.protocol.roleAssignments, [
    "claude",
    "codex",
    "agy",
  ]);
  // 자유토론 메시지에는 붙지 않는다.
  const before = room.messages.length;
  await room.startDiscussion({ turnBudget: 3 });
  await settle(room);
  const freeTurns = room.messages.slice(before).filter((message) => message.discussionTurnMeta);
  assert.equal(freeTurns.length, 0);
});

test("구조화 토론의 빈 PASS는 조용히 사라지지 않고 기록으로 남는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        // 첫 답변은 토론 전 브로드캐스트가 소비한다. 비평(2번째 순서)이
        // 지시를 무시하고 빈 PASS 마커만 낸다.
        codex: [
          { ok: true, text: "확인" },
          { ok: true, text: "[[CODEPET_DISCUSSION:PASS]]" },
        ],
      },
      calls
    ),
  });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  await settle(room);

  // 자유토론이라면 빈 PASS는 메시지 없이 넘어가지만, 구조화 토론에서는
  // 단계가 실행된 사실이 transcript에 남아야 다음 단계가 읽을 수 있다.
  assert.equal(result.completed, 4);
  const critic = room.messages.find(
    (message) => message.authorType === "agent" && message.author === "codex"
      && /덧붙일 내용이 없습니다/.test(message.text)
  );
  assert.ok(critic, "빈 PASS 단계가 기록으로 남아야 합니다");
});

test("자유토론의 빈 PASS는 기존대로 메시지를 남기지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        codex: [
          { ok: true, text: "확인" },
          { ok: true, text: "[[CODEPET_DISCUSSION:PASS]]" },
        ],
      },
      calls
    ),
  });
  room.sendUserMessage("주제입니다");
  await settle(room);
  const before = room.messages.length;

  await room.startDiscussion({ turnBudget: 3 });
  await settle(room);

  const codexMessages = room.messages
    .slice(before)
    .filter((message) => message.authorType === "agent" && message.author === "codex");
  assert.equal(codexMessages.length, 0, "자유토론의 빈 PASS는 메시지를 만들지 않아야 합니다");
});

test("사용할 수 없는 참가자가 배정되면 시작을 거부한다", async () => {
  const agents = makeAgents();
  agents[2].available = false;
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  room.sendUserMessage("주제입니다");
  await settle(room);

  const result = await room.startDiscussion({
    protocol: {
      presetId: "shaping",
      participantIds: ["claude", "codex", "agy"],
      cycleBudget: 1,
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /사용할 수 없습니다/);
});

test("자유토론 경로는 protocol 없이 기존 그대로다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("주제입니다");
  await settle(room);
  calls.length = 0;

  const result = await room.startDiscussion({ turnBudget: 3 });
  await settle(room);
  assert.equal(result.completed, 3);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "agy"]
  );
  assert.match(calls[0].prompt, /자율 토론 1\/3턴/);
  const conclusion = room.messages.findLast((message) => message.discussionMeta);
  assert.equal(conclusion.discussionMeta.protocol, undefined);
});
