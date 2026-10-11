"use strict";

// 바로 답하기 스케줄러의 속성 시험(설계 §5, S10·S24). 시드를 고정한 무작위 사건열(메시지 종류, 러너 종료·실패,
// 취소, 중지, 잠깐, 토론, 모든 종류의 갈아끼우기)을 돌리고 사건마다 불변식을 점검한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { settle, makeAgent } = require("./reply-now-helpers.cjs");

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const IDS = ["claude", "codex", "agy", "gemini"];

function makeWorld(seed, { meta, configure } = {}) {
  const rand = lcg(seed);
  const calls = [];
  const events = [];
  const room = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    meta: { permissionMode: "chat", ...(meta || {}) },
    random: rand,
    runAgent: ({ agent, prompt }) => {
      const gate = Promise.withResolvers();
      const call = {
        agentId: agent.id, prompt, startGen: room.generation, ended: false, holdCancel: rand() < 0.3,
        finish(text = "완료") { call.ended = true; gate.resolve({ ok: true, text }); },
        fail() { call.ended = true; gate.resolve({ ok: false, error: "실패" }); },
        endCancelled() { call.ended = true; gate.resolve({ ok: false, cancelled: true, error: "중지됨" }); },
      };
      calls.push(call);
      return {
        promise: gate.promise,
        cancel() { if (!call.holdCancel) call.endCancelled(); },
      };
    },
  });
  room.reportFolderContractBreaches = async () => {};
  room.on("busy", (value) => events.push(value));
  const claims = [];
  const originalClaim = room.claimUnit.bind(room);
  room.claimUnit = (members) => {
    claims.push(members.map((item) => ({ lane: item.lane, agent: item.agent.id })));
    // 담당자 게이트: 단위의 담당자는 모두 비어 있어야 한다(inv 1).
    for (const member of members) assert.equal(room.agentIsRunning(member.agent.id), false, `게이트 위반: ${member.agent.id}`);
    if (members[0].lane !== "fast") {
      // 일반 단위는 돌고 있는 단위가 없을 때만, 일반 줄에서 가장 앞선 단위로 시작한다(inv 2·3).
      assert.equal(room.activeUnits.size, 0, "일반 단위는 돌고 있는 단위가 없을 때만 시작");
      assert.ok(members.includes(room.turnQueue.find((item) => item.lane !== "fast")), "일반 줄은 FIFO");
    }
    return originalClaim(members);
  };
  if (configure) configure(room);
  return { room, calls, events, rand, claims };
}

function checkInvariants(world, label) {
  const { room, calls, events } = world;
  const running = [...room.runningTurns];
  world.maxRunning = Math.max(world.maxRunning || 0, running.length);
  // 1. 담당자 단독 실행
  const agents = running.map((item) => item.agent.id);
  assert.equal(new Set(agents).size, agents.length, `${label}: 같은 담당자 동시 실행`);
  // 5. 빠른 턴 시작: 큐에 남은 빠른 항목은 반드시 걸려 있다.
  for (const item of room.turnQueue) {
    if (item.lane !== "fast") continue;
    const unit = room.unitOfQueued(item);
    assert.ok(unit.some((member) => room.agentIsRunning(member.agent.id)), `${label}: 걸림 없이 큐에 머무는 빠른 항목`);
  }
  // 6. 진행성
  assert.ok(!(room.activeUnits.size === 0 && room.turnQueue.length > 0), `${label}: 교착(돌고 있는 단위 없이 큐가 남음)`);
  // 17. 묶음 일관성
  const lanes = new Map();
  for (const item of room.turnQueue) {
    const group = item.context.parallelGroupId;
    if (!group) continue;
    const lane = item.lane === "fast" ? "fast" : "main";
    assert.equal(lanes.get(group) ?? lane, lane, `${label}: 한 묶음에 줄이 섞임`);
    lanes.set(group, lane);
  }
  // 7. 토론 배타: 토론 턴이 돌면 다른 턴이 돌지 않는다.
  if (running.some((item) => item.context.discussion)) assert.equal(running.length, 1, `${label}: 토론 중 다른 턴`);
  if (room.discussionActive) assert.ok(!room.turnQueue.some((item) => item.lane === "fast"), `${label}: 토론 중 빠른 항목`);
  // 15. 표시 일관성
  const state = room.turnState();
  assert.equal(new Set(state.running).size, state.running.length);
  const queuedIds = new Set(state.queue.map((turn) => turn.turnId));
  for (const item of room.liveTurns()) assert.ok(!queuedIds.has(item.turnId), `${label}: 큐와 실행에 동시에 나옴`);
  for (const [index, turn] of state.queue.entries()) assert.equal(turn.fast, room.turnQueue[index].lane === "fast");
  // 19. 실행 계수
  const liveNow = calls.filter((call) => !call.ended && call.startGen === room.generation).length;
  assert.equal(room.activeRuns, liveNow, `${label}: activeRuns`);
  assert.equal(room.liveRuns, calls.filter((call) => !call.ended).length, `${label}: liveRuns`);
  for (let i = 1; i < events.length; i += 1) assert.notEqual(events[i], events[i - 1], `${label}: busy 이벤트가 같은 값을 연달아 냄`);
  assert.equal(events.at(-1) ?? false, room.activeRuns > 0, `${label}: busy 이벤트와 activeRuns 불일치`);
}

const MESSAGES = [
  (rand) => `@${IDS[Math.floor(rand() * IDS.length)]} 질문`,
  (rand) => `@${IDS[Math.floor(rand() * IDS.length)]} 또`,
  () => "@모두 다 같이",
  () => "멘션 없이",
  (rand) => `@${IDS[Math.floor(rand() * 2)]} @${IDS[2 + Math.floor(rand() * 2)]} 이어서`,
  () => "@claude @codex 각자",
  () => "@agy @gemini 각자",
  () => "@모두 각자",
];

async function step(world, rand) {
  const { room, calls } = world;
  const pick = rand();
  const running = calls.filter((call) => !call.ended);
  if (pick < 0.42) {
    const make = MESSAGES[Math.floor(rand() * MESSAGES.length)];
    const text = make(rand);
    room.sendUserMessage({ text, independent: /각자/.test(text) || rand() < 0.15 });
    return `send ${text}`;
  }
  if (pick < 0.7 && running.length > 0) {
    const call = running[Math.floor(rand() * running.length)];
    const outcome = rand();
    if (call.startGen !== room.generation) call.endCancelled();
    else if (outcome < 0.12) call.fail();
    else call.finish(rand() < 0.2 ? `답 @${IDS[Math.floor(rand() * IDS.length)]} 부탁` : "답");
    return "finish";
  }
  if (pick < 0.8 && room.turnQueue.length > 0) {
    const item = room.turnQueue[Math.floor(rand() * room.turnQueue.length)];
    room.cancelTurn(item.turnId);
    return "cancelTurn";
  }
  if (pick < 0.85) {
    room.stopAll();
    return "stopAll";
  }
  if (pick < 0.88) {
    room.interject();
    return "interject";
  }
  if (pick < 0.91 && !room.discussionActive && !room.discussionRequested) {
    world.discussions.push(room.startDiscussion({ turnBudget: 3 }));
    return "discussion";
  }
  // 중지로 취소만 되고 아직 안 끝난 프로세스를 끝낸다.
  const held = running.filter((call) => call.startGen !== room.generation);
  if (held.length > 0) held[0].endCancelled();
  return "endCancelled";
}

// 남은 일을 모두 끝내고 장부가 기준선으로 돌아오는지 본다(inv 10).
async function drain(world, label) {
  const { room, calls } = world;
  for (let i = 0; i < 200 && (room.activeUnits.size > 0 || room.turnQueue.length > 0 || room.deferredTurnQueue.length > 0 || room.runningTurns.size > 0 || calls.some((call) => !call.ended)); i += 1) {
    for (const call of calls.filter((entry) => !entry.ended)) {
      if (call.startGen !== room.generation) call.endCancelled();
      else call.finish("마무리");
    }
    await settle(2);
  }
  await Promise.all(world.discussions);
  await settle(2);
  assert.equal(room.runningTurns.size, 0, `${label}: runningTurns`);
  assert.equal(room.activeUnits.size, 0, `${label}: activeUnits`);
  assert.equal(room.turnQueue.length + room.deferredTurnQueue.length, 0, `${label}: 큐`);
  assert.equal(room.pendingTurns.size, 0, `${label}: pendingTurns`);
  assert.equal(room.turnStartedAt.size, 0, `${label}: turnStartedAt`);
  assert.equal(room.pumping, false);
  assert.equal(room.pumpSuspended, 0);
  assert.equal(room.pumpAgain, false);
  assert.equal(room.activeRuns, 0);
  assert.equal(room.liveRuns, 0);
  assert.equal(room.typingCounts.size, 0, `${label}: 입력 중 표시`);
  assert.equal(room.discussionActive, false);
  assert.equal(room.discussionRequested, false);
  assert.equal(world.events.at(-1) ?? false, false, `${label}: 마지막 busy`);
}

for (const seed of [1, 7, 20261011, 4242]) {
  for (const permissionMode of ["chat", "workspace-write"]) {
    test(`S10·S24 속성: 시드 ${seed}, ${permissionMode} 방에서 무작위 사건열 160개 뒤에도 불변식이 성립하고 장부가 기준선으로 돌아온다`, async () => {
      const world = makeWorld(seed, { meta: { permissionMode } });
      world.discussions = [];
      const rand = lcg(seed * 31 + 5);
      for (let i = 0; i < 160; i += 1) {
        const what = await step(world, rand);
        await settle(1);
        checkInvariants(world, `seed ${seed} #${i} ${what}`);
      }
      if (process.env.REPLY_NOW_STATS) {
        const fast = world.claims.filter((unit) => unit[0].lane === "fast").length;
        console.log(`stats seed ${seed} ${permissionMode}: calls ${world.calls.length} claims ${world.claims.length} fast ${fast} concurrent-max ${world.maxRunning}`);
      }
      assert.ok(world.claims.some((unit) => unit[0].lane === "fast") && world.claims.some((unit) => unit[0].lane !== "fast"), "사건열이 두 줄을 모두 지난다");
      assert.ok(world.calls.length >= 30, "사건열이 충분히 많은 실행을 만든다");
      assert.ok(world.maxRunning >= 2, "동시에 도는 턴이 실제로 나온다");
      await drain(world, `seed ${seed} 마무리`);
    });
  }
}

test("S24 속성: 파일 작업 방(쓰기·읽기)의 동시 작업 계약은 '같은 단위가 아닌 도는 턴이 있을 때'에만 있고, 대화 전용 방에는 없다", async () => {
  for (const permissionMode of ["workspace-write", "workspace-read", "chat"]) {
    const world = makeWorld(99, { meta: { permissionMode } });
    world.discussions = [];
    const rand = lcg(77);
    for (let i = 0; i < 120; i += 1) {
      await step(world, rand);
      await settle(1);
    }
    await drain(world, "계약");
    for (const call of world.calls) {
      const notYet = /그 답이 아직 없습니다/.test(call.prompt);
      const contract = /동시에 일하고 있습니다/.test(call.prompt);
      if (permissionMode === "chat") assert.equal(contract, false, "대화 전용 방에는 폴더 계약이 없다");
      else assert.equal(contract, notYet, `${permissionMode}: 폴더 계약은 알림 줄과 함께 (같은 조건)`);
      assert.equal(contract && !notYet, false, "계약이 있으면 알림 줄도 있다");
      if (/자율 토론/.test(call.prompt)) assert.equal(notYet || contract, false, "토론 턴에는 동시 작업 줄이 없다");
    }
    assert.ok(world.calls.some((call) => /그 답이 아직 없습니다/.test(call.prompt)), `${permissionMode}: 시험이 동시 작업 턴을 실제로 만들었다`);
  }
});

test("예외 복원력: 리스너·러너·프롬프트 생성이 던져도 장부가 기준선으로 돌아오고 예외는 방 밖으로 새지 않는다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const injections = {
    "turn-state 리스너": (room) => { room.on("turn-state", () => { throw new Error("화면 오류"); }); },
    "에이전트 메시지 리스너": (room) => { room.on("message", (message) => { if (message.authorType === "agent") throw new Error("저장 오류"); }); },
    "프롬프트 생성": (room) => { room.setMeta({ projectContext: { toString() { throw new Error("맥락 오류"); } } }); },
  };
  for (const [name, configure] of Object.entries(injections)) {
    const world = makeWorld(5, { configure });
    world.discussions = [];
    const rand = lcg(11);
    for (let i = 0; i < 100; i += 1) {
      await step(world, rand);
      await settle(1);
      // 리스너·프롬프트 오류가 있어도 담당자 게이트와 교착 없음은 지켜진다.
      const agents = [...world.room.runningTurns].map((item) => item.agent.id);
      assert.equal(new Set(agents).size, agents.length, `${name}: 같은 담당자 동시 실행`);
      assert.ok(!(world.room.activeUnits.size === 0 && world.room.turnQueue.length > 0), `${name}: 교착`);
    }
    await drain(world, name);
  }
});

test("러너가 던지면(실행 시작 실패) 그 턴만 실패로 끝나고 방은 계속 돈다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const room = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    runAgent: ({ agent }) => {
      if (agent.id === "claude") throw new Error("실행 파일 없음");
      return { promise: Promise.resolve({ ok: true, text: "답" }), cancel() {} };
    },
  });
  room.sendUserMessage("@claude 안녕");
  room.sendUserMessage("@codex 안녕");
  await settle(3);
  assert.equal(room.isIdle(), true);
  assert.equal(room.runningTurns.size, 0);
  assert.equal(room.activeRuns, 0);
  assert.equal(room.liveRuns, 0);
  assert.ok(room.messages.some((message) => message.error && message.author === "claude"));
  assert.ok(room.messages.some((message) => message.author === "codex" && message.text === "답"));
});
