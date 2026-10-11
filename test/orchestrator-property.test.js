"use strict";

// 오케스트레이터(흐름 B) + "AI끼리 계속 부르기"의 속성 시험. 시드를 고정한 무작위 사건열을 돌리고
// 매 걸음·끝에서 docs/design/AGORA_REVISION_2026-10-11_ORCHESTRATOR.md §(13) 불변식을 점검한다.
// 돌 때마다 한 묶음(지휘 AI·작업자)의 러너는 가짜이고 손으로 약속을 푼다(reply-now-property.test.js와 같은 틀).
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

const IDS = ["claude", "codex", "agy", "gemini"]; // claude를 지휘 AI로 쓴다.

// 작은 안전선(ceiling)을 써서 적은 걸음 수로도 §(5)·§(13) 불변식 2·8을 실제로 건드린다.
function makeWorld(seed, overrides = {}) {
  const rand = lcg(seed);
  const calls = [];
  const systems = [];
  // agentId -> 그 담당자가 "지금" 실행 중인 턴의 context. 같은 담당자는 한 번에 하나만 돈다(불변식 10)는
  // 보장 위에서, runResponseTurn 진입 시점(동기, runAgent를 부르기 전)에 적어 두고 runAgent에서 읽는다.
  // (줄(lane)이 스케줄 순서와 실행 순서를 바꿀 수 있어 "스케줄한 순서=실행 순서"로 짝짓는 것은 안전하지 않다.)
  const contextByAgent = new Map();

  const room = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    meta: { permissionMode: "chat", orchestrator: { enabled: true, leadId: "claude" } },
    random: rand,
    roundCeiling: 2,
    executionCeiling: 3,
    keepCallingCeiling: 6,
    mentionChainLimit: 2,
    runAgent: ({ agent, prompt }) => {
      const gate = Promise.withResolvers();
      const context = contextByAgent.get(agent.id) || null;
      const call = {
        agentId: agent.id,
        prompt,
        context,
        startGen: room.generation,
        ended: false,
        resultText: null,
        finish(text = "완료") { call.ended = true; call.resultText = text; gate.resolve({ ok: true, text }); },
        fail(error = "실패") { call.ended = true; gate.resolve({ ok: false, error }); },
        endCancelled() { call.ended = true; gate.resolve({ ok: false, cancelled: true, error: "중지됨" }); },
      };
      calls.push(call);
      return {
        promise: gate.promise,
        cancel() { if (!call.holdCancel) call.endCancelled(); },
      };
    },
    ...overrides,
  });
  room.reportFolderContractBreaches = async () => {};
  room.on("message", (message) => { if (message?.authorType === "system") systems.push(message.text); });

  // scheduleTurn을 감싸 그 턴의 promise가 끝까지 풀리는지만 본다(불변식 1). dedupe로 기존 대기 항목을
  // 돌려줄 때(같은 promise)는 settleFlags에 중복으로 넣지 않는다.
  const originalScheduleTurn = room.scheduleTurn.bind(room);
  const settleFlags = [];
  const trackedPromises = new Set();
  room.scheduleTurn = (agent, context = {}, placement = {}) => {
    const item = originalScheduleTurn(agent, context, placement);
    if (!trackedPromises.has(item.promise)) {
      trackedPromises.add(item.promise);
      let settled = false;
      item.promise.then(() => { settled = true; }, () => { settled = true; });
      settleFlags.push({ turnId: item.turnId, agentId: agent.id, settled: () => settled });
    }
    return item;
  };

  // runResponseTurn 진입 시점(실행 직전, 동기)에 그 담당자가 "지금" 도는 턴의 context를 적어 둔다 —
  // 실제로 runAgent를 부를 호출과 1:1로 맞는, 줄 재배치에 영향받지 않는 유일하게 안전한 자리다.
  const originalRunResponseTurn = room.runResponseTurn.bind(room);
  room.runResponseTurn = (agent, context = {}, generation) => {
    contextByAgent.set(agent.id, context);
    return originalRunResponseTurn(agent, context, generation);
  };

  return {
    room, calls, systems, rand, settleFlags,
    endedSnapshot: new Map(), // orchId -> calls.length(그 orchId) 당시 — 끝난 뒤 늘지 않아야 한다(불변식 11·3).
    lastSnapshot: new Map(), // orchId -> {round, executions}(불변식 2 단조증가).
    prevOrchId: null,
    discussions: [],
    expectedWorkerMentionNotices: 0,
    ceilingHits: 0,
  };
}

function checkInvariants(world, label) {
  const { room, calls } = world;

  // 불변식: 같은 담당자가 동시에 두 턴을 돌지 않는다(§(13) 불변식 10 성립의 전제이자 일반 보장).
  const runningAgents = [...room.runningTurns].map((item) => item.agent.id);
  assert.equal(new Set(runningAgents).size, runningAgents.length, `${label}: 같은 담당자 동시 실행`);

  // 불변식 1: 오케스트레이션과 토론은 동시에 서지 않는다.
  assert.ok(!(room.orchestration && (room.discussionRequested || room.discussionActive)),
    `${label}: 오케스트레이션과 토론이 동시에 선다`);

  // 끝남 감지: this.orchestration이 이전과 다른 id(또는 null)로 바뀌면, 그 순간 큐에 죽은 형제가
  // 남아 있지 않아야 하고(불변식 4·14·15), 그 id의 실행 수를 못박아 둔다(불변식 3·11 — 늦게 자라면 안 된다).
  const currentId = room.orchestration?.id || null;
  if (world.prevOrchId && currentId !== world.prevOrchId) {
    const endedId = world.prevOrchId;
    world.endedSnapshot.set(endedId, calls.filter((c) => c.context?.orchestration?.id === endedId).length);
    for (const item of [...room.turnQueue, ...room.deferredTurnQueue]) {
      assert.notEqual(item.context?.orchestration?.id, endedId,
        `${label}: 끝난 오케스트레이션(${endedId})의 형제가 큐에 남아 있다`);
    }
  }
  world.prevOrchId = currentId;
  for (const [endedId, snapshot] of world.endedSnapshot) {
    const now = calls.filter((c) => c.context?.orchestration?.id === endedId).length;
    assert.equal(now, snapshot, `${label}: 끝난 오케스트레이션(${endedId})에 늦은 실행이 새로 들어왔다(폐기 실패)`);
  }

  // 불변식 8: 지휘 AI 턴은 한 라운드에 한 번만 claim된다(겹쳐 돌지 않는다).
  const leadRoundCounts = new Map();
  for (const call of calls) {
    const orch = call.context?.orchestration;
    if (!orch || orch.role !== "lead") continue;
    const key = `${orch.id}:${orch.round}`;
    leadRoundCounts.set(key, (leadRoundCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of leadRoundCounts) {
    assert.ok(count <= 1, `${label}: 오케스트레이션/라운드 ${key}에 지휘 AI 턴이 ${count}번 claim됐다(한 번의 회신이어야 한다)`);
  }

  // 불변식 2: round·executions는 오케스트레이션이 사는 동안 내려가지 않는다.
  if (room.orchestration) {
    const prev = world.lastSnapshot.get(room.orchestration.id) || { round: 0, executions: 0 };
    assert.ok(room.orchestration.round >= prev.round, `${label}: round가 줄었다`);
    assert.ok(room.orchestration.executions >= prev.executions, `${label}: executions가 줄었다`);
    world.lastSnapshot.set(room.orchestration.id, { round: room.orchestration.round, executions: room.orchestration.executions });
  }

  // 작업자는 못 부른다(불변식 3) — 묶음(workerUnitId)별로 같은 역할만 섞인다(§(4) 묶음 일관성 중 줄 부분).
  for (const item of room.turnQueue) {
    if (item.context?.workerUnitId) {
      assert.equal(item.lane, "fast", `${label}: 작업자 항목이 빠른 줄이 아니다`);
    }
  }

  // 일반 보장: 교착 없음(돌고 있는 단위 없이 큐만 남는 상태는 없다).
  assert.ok(!(room.activeUnits.size === 0 && room.turnQueue.length > 0), `${label}: 교착(돌고 있는 단위 없이 큐가 남음)`);
}

const OTHER_OF = (leadId) => IDS.filter((id) => id !== leadId);

function sendMessage(world, rand) {
  const { room } = world;
  const cfg = room.meta.orchestrator || {};
  const lead = cfg.enabled ? cfg.leadId : null;
  const pool = lead ? OTHER_OF(lead) : IDS;
  const a = pool[Math.floor(rand() * pool.length)];
  const restPool = pool.filter((id) => id !== a);
  const b = restPool.length > 0 ? restPool[Math.floor(rand() * restPool.length)] : a;
  const shapes = [
    () => "멘션 없이 그냥 메시지",
    () => (lead ? `@${lead} 맡겨줘` : `@${a} 맡아줘`),
    () => `@${a} 직접 처리해줘`,
    () => (lead ? `@${lead} @${a} 둘 다 봐줘` : `@${a} @${b} 둘 다 봐줘`),
    () => "@모두 다들 어때?",
    () => `@${a} @${b} 둘이서`,
  ];
  const text = shapes[Math.floor(rand() * shapes.length)]();
  room.sendUserMessage(text);
  return `send(${text})`;
}

function resolveCall(world, rand, alive) {
  const { room } = world;
  const call = alive[Math.floor(rand() * alive.length)];
  if (call.startGen !== room.generation) { call.endCancelled(); return `endCancelled(stale ${call.agentId})`; }
  const role = call.context?.orchestration?.role || null;
  const outcome = rand();

  if (role === "lead") {
    if (outcome < 0.12) { call.fail("TIMED_OUT"); return "lead fail"; }
    if (outcome < 0.32) {
      const others = IDS.filter((id) => id !== call.agentId);
      const n = 1 + Math.floor(rand() * 2);
      const picks = [];
      for (let i = 0; i < n; i += 1) picks.push(others[Math.floor(rand() * others.length)]);
      // 자기 자신·그룹 별칭·존재하지 않는 id를 섞어 §(4)의 "작업자 후보에서 뺀다" 경로도 돌린다.
      const junk = rand() < 0.35 ? ` @${call.agentId} @모두 @nope` : "";
      call.finish(`@${picks.join(" @")} 맡아줘${junk}`);
      return `lead delegate(${picks.join(",")})`;
    }
    if (outcome < 0.45) { call.finish("ASK_USER: 이대로 진행할까요?"); return "lead ask_user only"; }
    if (outcome < 0.55) {
      const other = IDS.find((id) => id !== call.agentId);
      call.finish(`@${other} 맡아줘\nASK_USER: 이대로 진행할까요?`); // O27
      return "lead delegate+ask_user";
    }
    if (outcome < 0.6) { call.finish(`${"x".repeat(5000)} 끝`); return "lead long"; }
    call.finish("다 끝났습니다.");
    return "lead finish-no-mention";
  }

  if (role === "worker") {
    if (outcome < 0.15) { call.fail("RATE_LIMITED"); return "worker fail"; }
    if (outcome < 0.32) {
      const leadId = room.orchestration?.leadId;
      const other = IDS.find((id) => id !== call.agentId && id !== leadId) || IDS.find((id) => id !== call.agentId);
      world.expectedWorkerMentionNotices += 1;
      call.finish(`@${other} 이거 대신 맡아줘`);
      return "worker tried mention";
    }
    if (outcome < 0.45) { call.finish("ASK_USER: 이거 맞나요?"); return "worker ask_user"; }
    call.finish("작업 끝");
    return "worker finish";
  }

  // 일반 자유 대화(직접 @other, 또는 오케스트레이션과 무관한 보통 멘션 연쇄).
  if (outcome < 0.15) { call.fail("실패"); return "plain fail"; }
  if (outcome < 0.5) {
    const other = IDS[Math.floor(rand() * IDS.length)];
    call.finish(`@${other} 또 불러봐`);
    return "plain mention";
  }
  call.finish("직접 답");
  return "plain finish";
}

function toggleOrchestrator(world, rand) {
  const { room } = world;
  const cfg = room.meta.orchestrator || { enabled: false, leadId: null };
  if (cfg.enabled) {
    const turnOff = rand() < 0.5;
    if (room.orchestration) {
      room.endOrchestration(turnOff
        ? "오케스트레이터 모드를 꺼서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다."
        : "지휘 AI를 바꿔서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.");
    }
    const nextLead = OTHER_OF(cfg.leadId)[Math.floor(rand() * 3)];
    room.setMeta({ orchestrator: turnOff ? { enabled: false, leadId: null } : { enabled: true, leadId: nextLead } });
    return turnOff ? "orchestrator off" : `orchestrator change-lead(${nextLead})`;
  }
  room.setMeta({ orchestrator: { enabled: true, leadId: "claude" } });
  return "orchestrator on";
}

function toggleAgentAvailability(world, rand) {
  const { room } = world;
  const id = IDS[Math.floor(rand() * IDS.length)];
  room.setAgents(room.agents.map((agent) => (agent.id === id ? { ...agent, enabled: agent.enabled === false } : agent)));
  return `toggle-enabled(${id})`;
}

async function step(world, rand) {
  const { room, calls } = world;
  const pick = rand();
  const alive = calls.filter((c) => !c.ended);
  if (pick < 0.3) return sendMessage(world, rand);
  if (pick < 0.62 && alive.length > 0) return resolveCall(world, rand, alive);
  const queued = [...room.turnQueue, ...room.deferredTurnQueue];
  if (pick < 0.68 && queued.length > 0) {
    const item = queued[Math.floor(rand() * queued.length)];
    room.cancelTurn(item.turnId);
    return "cancelTurn";
  }
  if (pick < 0.73) { room.stopAll(); return "stopAll"; }
  if (pick < 0.77) { room.interject(); return "interject"; }
  if (pick < 0.8) { room.clear(); return "clear(delete)"; }
  if (pick < 0.87) return toggleOrchestrator(world, rand);
  if (pick < 0.91) { room.setMeta({ keepCalling: !room.meta.keepCalling }); return "keepCalling toggle"; }
  if (pick < 0.96) return toggleAgentAvailability(world, rand);
  if (pick < 0.99 && !room.discussionRequested && !room.discussionActive) {
    world.discussions.push(room.startDiscussion({ turnBudget: 2 }).catch(() => {}));
    return "discussion request";
  }
  const held = alive.filter((c) => c.startGen !== room.generation);
  if (held.length > 0) { held[0].endCancelled(); return "endCancelled(held)"; }
  return "noop";
}

// 남은 모든 일을 끝내고(가능하면 위임 없이 답하게 해 오케스트레이션을 자연히 마감) 장부가 기준선으로
// 돌아오는지 본다. reply-now-property.test.js의 drain과 같은 생각.
async function drain(world, label) {
  const { room, calls, settleFlags } = world;
  for (let i = 0; i < 200
    && (room.activeUnits.size > 0 || room.turnQueue.length > 0 || room.deferredTurnQueue.length > 0
      || room.runningTurns.size > 0 || calls.some((c) => !c.ended)); i += 1) {
    for (const call of calls.filter((c) => !c.ended)) {
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
  assert.equal(room.orchestration, null, `${label}: orchestration`);
  // 불변식 1: 스케줄된 모든 턴의 promise가 끝까지 풀린다.
  for (const flag of settleFlags) {
    assert.ok(flag.settled(), `${label}: 턴 ${flag.turnId}(${flag.agentId})의 promise가 풀리지 않았다`);
  }
  // 불변식 5: 작업자가 다른 참가자를 부르려 하면 매번 안내 한 줄(더도 덜도 아니게)이 난다.
  const noticeCount = world.systems.filter((text) => /다른 참가자를 부를 수 없습니다/.test(text)).length;
  assert.equal(noticeCount, world.expectedWorkerMentionNotices, `${label}: 작업자 호출 차단 안내 수`);
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

test("오케스트레이터 속성 시험: 300개 시드, 시드마다 걸음마다 불변식을 점검하고 끝에 기준선으로 돌아온다", async () => {
  let ceilingHits = 0;
  let sawDelegation = false;
  let sawDirectWhileOrchestrating = false;
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const rand = lcg(seed * 97 + 13);
    for (let i = 0; i < 150; i += 1) {
      const what = await step(world, rand);
      await settle(1);
      checkInvariants(world, `seed ${seed} #${i} ${what}`);
      if (/delegate/.test(what)) sawDelegation = true;
      if (world.room.orchestration && /^plain|^worker finish/.test(what)) sawDirectWhileOrchestrating = true;
    }
    if (world.systems.some((text) => /안전선/.test(text))) ceilingHits += 1;
    await drain(world, `seed ${seed} 마무리`);
  }
  assert.ok(sawDelegation, "사건열이 위임을 실제로 만든다");
  assert.ok(ceilingHits > 0, `작은 안전선(round=2, exec=3)이 적어도 한 시드에서는 실제로 걸려야 한다(걸린 시드 ${ceilingHits}/300)`);
});

// ---- 불변식 6: @ 규칙은 모드·오케스트레이션 진행 여부와 무관하게 메시지 모양만 본다 ----

function matrixRoom(orchestratorOn) {
  const calls = [];
  const room = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    meta: { permissionMode: "chat", orchestrator: { enabled: orchestratorOn, leadId: "claude" } },
    random: () => 0.999, // 방송 셔플을 고정해 시험을 결정적으로 만든다(reply-now-helpers의 identityRandom과 같다).
    runAgent: ({ agent, prompt }) => {
      const gate = Promise.withResolvers();
      const call = {
        agentId: agent.id, prompt, resolved: false,
        finish(text = "완료") { call.resolved = true; gate.resolve({ ok: true, text }); },
      };
      calls.push(call);
      return { promise: gate.promise, cancel() { call.resolved = true; gate.resolve({ ok: false, cancelled: true }); } };
    },
  });
  return { room, calls };
}

// 묶이지 않은 방송(독립 발언이 아닌 @모두·동시 @둘 이상)은 "이어 발언"이라 한 번에 하나씩 돈다
// (앞 사람 답을 입력으로 쓰는 설계). 라우팅표는 "누가 받는가"만 보므로, keepCount 이후의 모든 호출을
// 다 끝내고(지휘 AI 자신의 진행 중인 라운드만 keepCount로 건드리지 않는다) 받은 사람 전체를 모은다.
async function drainFrom(room, calls, keepCount) {
  for (let i = 0; i < 10; i += 1) {
    const pending = calls.slice(keepCount).filter((c) => !c.resolved);
    if (pending.length === 0) break;
    for (const call of pending) call.finish("완료");
    await settle();
  }
}

const ROUTING_SHAPES = [
  { label: "@ 없음", text: () => "멘션 없이" },
  { label: "@지휘AI만", text: () => "@claude 맡겨줘" },
  { label: "@다른AI 하나", text: () => "@codex 직접" },
  { label: "@지휘AI + @다른AI", text: () => "@claude @codex 같이" },
  { label: "@모두", text: () => "@모두 다들 어때?" },
];

test("불변식 6: 라우팅표 — 꺼짐/켜짐·오케스트레이션 없음/진행 중 × 메시지 다섯 모양", async () => {
  for (const shape of ROUTING_SHAPES) {
    // 꺼짐: 지금과 같다(@ 없음·@모두는 전원, @지휘AI만/@다른AI/둘다는 그 대상에게).
    {
      const { room, calls } = matrixRoom(false);
      room.sendUserMessage(shape.text());
      await settle();
      await drainFrom(room, calls, 0);
      const ids = calls.map((c) => c.agentId).sort();
      if (shape.label === "@ 없음" || shape.label === "@모두") assert.deepEqual(ids, ["agy", "claude", "codex", "gemini"], `꺼짐·${shape.label}`);
      else if (shape.label === "@지휘AI만") assert.deepEqual(ids, ["claude"], `꺼짐·${shape.label}`);
      else if (shape.label === "@다른AI 하나") assert.deepEqual(ids, ["codex"], `꺼짐·${shape.label}`);
      else assert.deepEqual(ids, ["claude", "codex"], `꺼짐·${shape.label}`);
    }
    // 켜짐, 오케스트레이션 없음: @ 없음·@지휘AI만 = 지휘 AI에게만(맡기기 시작). 나머지는 꺼짐과 같다.
    {
      const { room, calls } = matrixRoom(true);
      room.sendUserMessage(shape.text());
      await settle();
      await drainFrom(room, calls, 0);
      const ids = calls.map((c) => c.agentId).sort();
      if (shape.label === "@ 없음" || shape.label === "@지휘AI만") assert.deepEqual(ids, ["claude"], `켜짐·오케없음·${shape.label}`);
      else if (shape.label === "@다른AI 하나") assert.deepEqual(ids, ["codex"], `켜짐·오케없음·${shape.label}`);
      else if (shape.label === "@모두") assert.deepEqual(ids, ["agy", "claude", "codex", "gemini"], `켜짐·오케없음·${shape.label}`);
      else assert.deepEqual(ids, ["claude", "codex"], `켜짐·오케없음·${shape.label}`);
    }
    // 켜짐, 오케스트레이션 진행 중: @ 없음·@지휘AI만 = 보류(새 호출 없음). 나머지는 바로 간다.
    {
      const { room, calls } = matrixRoom(true);
      room.sendUserMessage("claude에게 맡겨줘"); // 오케스트레이션 시작
      await settle();
      calls[0].finish("@agy 맡아줘"); // 지휘 AI가 작업자(agy)에게 위임한 뒤 쉰다(O25와 같은, 흔한 상태).
      await settle();
      const before = calls.length; // claude(지휘, 끝남) + agy(작업자, 도는 중)
      room.sendUserMessage(shape.text());
      await settle();
      await drainFrom(room, calls, before); // agy(작업자)는 그대로 두고 새로 생긴 호출만 끝낸다
      const added = calls.slice(before).map((c) => c.agentId).sort();
      if (shape.label === "@ 없음" || shape.label === "@지휘AI만") {
        assert.deepEqual(added, [], `켜짐·오케진행중·${shape.label}: 보류되어 새 턴이 없다`);
        assert.equal(room.orchestration.heldMessages.length, 1, `켜짐·오케진행중·${shape.label}: heldMessages에 쌓인다`);
      } else if (shape.label === "@다른AI 하나") {
        assert.deepEqual(added, ["codex"], `켜짐·오케진행중·${shape.label}`);
        assert.ok(room.orchestration, "오케스트레이션은 그대로다");
      } else if (shape.label === "@모두") {
        // agy는 지금 작업자로 도느라 바쁘다. @모두의 agy 몫은 같은 보통 방송(이어 발언, 독립 발언이
        // 아니다) 안의 한 항목일 뿐이라, 일반 줄의 엄격한 FIFO(앞 항목이 못 claim되면 뒤도 못 선다 —
        // reply-now-property.test.js가 이미 지키는 바로 그 보장)를 그대로 받는다: 셔플 순서상 agy 몫이
        // gemini 몫보다 앞에 서면 gemini도 agy가 자유로워질 때까지 막힌다. §2.4(c)가 보장하는 것은
        // "오케스트레이션 턴이 메인 줄 때문에 굶지 않는다"는 것뿐, 메인 줄 **안**의 FIFO 순서까지
        // 오케스트레이션이 있다고 바꾸지는 않는다 — 오케스트레이션과 무관하게 지금과 같다.
        assert.deepEqual(added, ["claude", "codex"],
          `켜짐·오케진행중·${shape.label}: claude(지휘, 쉬는 중)는 바로 가지만, agy(작업자) 몫이 막아 그 뒤는 기다린다`);
        assert.ok(room.orchestration, "오케스트레이션은 그대로다");
      } else {
        assert.deepEqual(added, ["claude", "codex"], `켜짐·오케진행중·${shape.label}: claude는 쉬는 중이라 바로 응답한다`);
        assert.ok(room.orchestration, "오케스트레이션은 그대로다");
      }
    }
  }
});

// ---- 불변식 11: 보류 메시지는 정확히 한 번만, 정확히 한 번의 회신 턴에 들어간다 ----

test("불변식 11: 라운드 중 두 번 보낸 보류 메시지가 다음 회신 턴에 정확히 한 번씩, 중복 없이 들어간다", async () => {
  const { room, calls } = matrixRoom(true);
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘");
  await settle();
  room.sendUserMessage("첫 번째 보류");
  room.sendUserMessage("두 번째 보류");
  await settle();
  assert.equal(room.orchestration.heldMessages.length, 2);
  calls[1].finish("agy 완료");
  await settle();
  // 같은 메시지 텍스트가 대화 기록(평소처럼 쌓인 사용자 메시지)에도 나오는 것은 설계대로다(§(7)) —
  // "정확히 한 번"은 지휘 AI에게 결과를 짚어 주는 보류 메시지 블록 안에서만 셀 수 있다.
  const block = calls[2].prompt.split("=== 사용자가 그 사이 보낸 메시지 ===")[1]?.split("=== 사용자가 그 사이 보낸 메시지 끝 ===")[0] || "";
  const firstCount = (block.match(/첫 번째 보류/g) || []).length;
  const secondCount = (block.match(/두 번째 보류/g) || []).length;
  assert.equal(firstCount, 1, "첫 번째 보류 메시지가 블록 안에 정확히 한 번만 나온다");
  assert.equal(secondCount, 1, "두 번째 보류 메시지가 블록 안에 정확히 한 번만 나온다");
  assert.equal(room.orchestration.heldMessages.length, 0, "실린 뒤 비운다");
  // 다음(세 번째) 라운드 회신 턴의 프롬프트에는 다시 나오지 않는다(잃지도, 중복되지도 않는다).
  calls[2].finish("다 끝났습니다.");
  await settle();
  assert.equal(room.orchestration, null);
});

test("불변식 4·10: 보류 메시지가 쌓인 채 라운드 안전선에 걸려 끝나면, 늦게라도 중복 전달되지 않고 유실 안내가 붙는다", async () => {
  const systems = [];
  // roundCeiling 기본값(50)이라 안전선을 빨리 보려면 작은 ceiling 방이 필요하다.
  const smallRoom = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    meta: { permissionMode: "chat", orchestrator: { enabled: true, leadId: "claude" } },
    roundCeiling: 1,
  });
  const calls2 = [];
  smallRoom.runAgent = ({ agent, prompt }) => {
    const gate = Promise.withResolvers();
    const call = {
      agentId: agent.id, prompt,
      finish(text = "완료") { gate.resolve({ ok: true, text }); },
    };
    calls2.push(call);
    return { promise: gate.promise, cancel() { gate.resolve({ ok: false, cancelled: true }); } };
  };
  smallRoom.on("message", (m) => { if (m.authorType === "system") systems.push(m.text); });
  smallRoom.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls2[0].finish("@agy 맡아줘"); // round 1 -> 작업자 묶음
  await settle();
  smallRoom.sendUserMessage("보류될 메시지");
  await settle();
  assert.equal(smallRoom.orchestration.heldMessages.length, 1);
  calls2[1].finish("agy 완료"); // round+1(=2) > ceiling(1) -> endOrchestration, heldMessages 유실
  await settle();
  assert.equal(smallRoom.orchestration, null);
  assert.ok(systems.some((text) => /라운드 안전선\(1\)에 닿아 멈췄습니다/.test(text) && /전달되지 않았습니다/.test(text)),
    "안전선 안내에 보류 메시지 유실 고지가 붙는다");
  assert.equal(smallRoom.messages.filter((m) => m.text === "보류될 메시지").length, 1, "대화 기록에는 그대로 한 번 남는다(사라지지 않는다)");
});
