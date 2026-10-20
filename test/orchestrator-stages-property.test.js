"use strict";

// 오케스트레이터 단계 실행의 속성 시험(2026-10-20 개정). 시드를 고정한 무작위 사건열을 돌린다.
//   지휘 AI: STAGE 계획(중복·모르는 이름·자기 호출·4단계 초과·DONE/ASK_USER 동봉), 옛 @멘션, DONE, 질문, 표시 없음, 실패
//   작업자: 성공·실패·질문(ASK_USER)
//   바깥: 중지·잠깐·삭제·×·모드 끔, 취소 신호를 받고도 바로 끝나지 않는 프로세스의 늦은 결과, 참가자 비활성화, 지휘 모델 켜고 끄기
// 매 걸음과 끝의 기준선에서 다음 네 성질을 점검한다.
//   1. 단계 순서: 앞 단계 작업자가 모두 끝나기 전에는 다음 단계 작업자가 시작하지 않고, 한 참가자는 라운드 안에서 한 단계에만 든다.
//   2. 회신 한 번: 단계 계획 하나마다 지휘 AI 회신 차례는 한 번만 열리고, 마지막 단계(또는 조기 종료)가 끝나기 전에는 열리지 않는다.
//   3. 실행 횟수: orchestration.executions는 실제로 시작한 오케스트레이션 차례 수와 같다.
//   4. 종료 뒤 침묵: 끝나거나 바뀐 오케스트레이션은 새 차례도 새 단계도 시작하지 않고, 늦은 결과는 버려진다.
// 러너는 가짜이고 시험이 약속을 손으로 푼다(orchestrator-property.test.js와 같은 틀).
// 설계: docs/design/AGORA_REVISION_2026-10-20_ORCHESTRATOR_STAGES.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { settle, makeAgent } = require("./reply-now-helpers.cjs");

function lcg(seed) {
  let state = Math.imul(seed + 1, 2654435761) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < 4; i += 1) next(); // 이웃한 시드의 첫 값이 닮지 않게 몇 번 흘려보낸다.
  return next;
}

const LEAD = "claude";
const WORKERS = ["codex", "agy", "docs"];
const IDS = [LEAD, ...WORKERS];
const MAX_STAGES = 4;
// STAGE 줄에 쓰는 이름. 지휘 AI 자신(지휘 모델을 따로 정한 방에서만 맡길 수 있다)과 모르는 이름도 섞는다.
const NAME_POOL = ["codex", "codex", "agy", "agy", "docs", "docs", LEAD, "nope"];
// 사건열이 실제로 닿았는지 보는 표. 하나라도 0이면 시험이 그 경로를 놓친 것이다.
const COVERAGE_KEYS = [
  "multiStage", "stoppedEarly", "nudged", "selfCall", "ceilingHit",
  "lateDiscarded", "replied", "legacyMention", "planNotes", "stoppedMidPlan",
];

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

function makeWorld(seed, coverage) {
  const rand = lcg(seed);
  const world = {
    seed,
    rand,
    coverage,
    // 세 시드 중 하나는 참가자를 중간에 비활성화한다. 시작하지 못한 차례가 생길 수 있어 실행 횟수는 "이상"으로만 본다.
    toggleAvailability: seed % 3 === 0,
    // 네 시드 중 하나는 지휘 모델이 늘 있고, 둘은 중간에 켜고 끈다. 한 번도 켠 적 없는 방에서는 자기 호출이 없어야 한다.
    leadModelMode: seed % 4,
    leadModelEverSet: seed % 4 === 1,
    roundCeiling: 3 + Math.floor(rand() * 4),
    executionCeiling: 6 + Math.floor(rand() * 9),
    calls: [],
    systems: [],
    plans: [],
    violations: [],
    requestSeq: 0,
    seenGroups: new Set(),
    seenReplies: new Set(),
  };
  const contextByAgent = new Map();
  const room = new ChatRoom({
    agents: IDS.map((id) => makeAgent(id)),
    meta: {
      permissionMode: "chat",
      orchestrator: { enabled: true, leadId: LEAD, ...(world.leadModelMode === 1 ? { leadModel: "lead-model" } : {}) },
    },
    random: lcg(seed + 9000),
    roundCeiling: world.roundCeiling,
    executionCeiling: world.executionCeiling,
    runAgent: ({ agent, prompt }) => {
      const gate = Promise.withResolvers();
      const context = contextByAgent.get(agent.id) || null;
      const call = {
        agentId: agent.id,
        prompt,
        marker: context?.orchestration || null,
        startGen: room.generation,
        ended: false,
        outcome: null,
        // 일부 프로세스는 취소 신호를 받고도 바로 끝나지 않는다: 중지된 오케스트레이션의 늦은 결과를 만든다.
        holdCancel: rand() < 0.12,
        finish(text = "완료") { call.ended = true; call.outcome = /ASK_USER/.test(text) ? "ask" : "ok"; gate.resolve({ ok: true, text }); },
        fail(error = "실패", extra = {}) { call.ended = true; call.outcome = "fail"; gate.resolve({ ok: false, error, ...extra }); },
        endCancelled() { call.ended = true; call.outcome = "cancelled"; gate.resolve({ ok: false, cancelled: true, error: "중지됨" }); },
      };
      onStart(world, call);
      world.calls.push(call);
      return { promise: gate.promise, cancel() { if (!call.holdCancel) call.endCancelled(); } };
    },
  });
  world.room = room;
  room.reportFolderContractBreaches = async () => {};
  room.on("message", (message) => { if (message?.authorType === "system") world.systems.push(message.text); });

  // 러너가 이 차례의 오케스트레이션 표식(어느 오케스트레이션·라운드·단계)을 알 수 있게 실행 직전에 적어 둔다.
  // 같은 담당자는 한 번에 한 차례만 돌므로, 실행 진입 시점(동기)에 적은 값을 runAgent가 바로 읽으면 짝이 맞는다.
  const originalRunResponseTurn = room.runResponseTurn.bind(room);
  room.runResponseTurn = (agent, context = {}, generation) => {
    contextByAgent.set(agent.id, context);
    return originalRunResponseTurn(agent, context, generation);
  };
  // 지휘 AI의 답이 단계 계획을 열 때마다 하나 적는다(회신 한 번을 계획 단위로 세기 위해).
  const originalStartStages = room.startStages.bind(room);
  room.startStages = (leadItem, leadMessageId, stages) => {
    world.plans.push({ orchId: room.orchestration.id, round: leadItem.context.orchestration.round, stageCount: stages.length });
    return originalStartStages(leadItem, leadMessageId, stages);
  };
  return world;
}

// 차례가 시작되는 순간(러너 진입)에만 보이는 위반을 모은다. 러너 안에서 assert를 던지면 방이 삼키므로 목록에 쌓았다가 걸음마다 한꺼번에 본다.
function onStart(world, call) {
  const { room, calls, violations } = world;
  const marker = call.marker;
  if (!marker) return;
  const label = call.agentId + " " + marker.role + " 라운드" + marker.round + (marker.stage ? " " + marker.stage + "단계" : "");
  // 4. 종료 뒤 침묵
  if (!room.orchestration || room.orchestration.id !== marker.id) violations.push(label + ": 끝났거나 바뀐 오케스트레이션의 차례가 시작됐다");
  const mine = calls.filter((entry) => entry.marker?.id === marker.id);
  call.execsBefore = mine.length;
  const roundLead = mine.find((entry) => entry.marker.role === "lead" && entry.marker.round === marker.round);
  // 어떤 차례든 시작하는 순간 실행 횟수가 안전선을 넘으면 안 된다(지휘 AI 회신·재촉 포함).
  if (mine.length + 1 > world.executionCeiling) violations.push(label + ": 실행 횟수 안전선(" + world.executionCeiling + ")을 넘어 차례가 시작됐다");
  if (marker.role === "lead") {
    if (marker.round > world.roundCeiling) violations.push(label + ": 라운드 안전선(" + world.roundCeiling + ")을 넘었다");
    if (roundLead) violations.push(label + ": 같은 라운드의 지휘 차례가 두 번 열렸다");
    for (const entry of mine) {
      if (entry.marker.role === "worker" && entry.marker.round === marker.round - 1 && !entry.ended) {
        violations.push(label + ": 앞 라운드 작업자 " + entry.agentId + "가 끝나기 전에 회신 차례가 열렸다");
      }
    }
    return;
  }
  // 1. 단계 순서
  if (!roundLead || !roundLead.ended) violations.push(label + ": 이 라운드를 연 지휘 차례가 끝나기 전에 작업자가 시작했다");
  if (!(marker.stage >= 1 && marker.stage <= Math.min(marker.stageTotal, MAX_STAGES))) {
    violations.push(label + ": 단계 번호가 범위를 벗어난다(전체 " + marker.stageTotal + ")");
  }
  for (const entry of mine) {
    if (entry.marker.role !== "worker" || entry.marker.round !== marker.round) continue;
    if (entry.marker.stage < marker.stage && !entry.ended) violations.push(label + ": 앞 단계의 " + entry.agentId + "가 끝나기 전에 시작했다");
    if (entry.marker.stage > marker.stage) violations.push(label + ": 더 뒤 단계(" + entry.marker.stage + ")가 먼저 시작돼 있었다");
    if (entry.agentId === call.agentId) violations.push(label + ": 한 라운드에 같은 참가자가 두 번 시작했다");
  }
}

// ─── 사건 ───────────────────────────────────────────────

function stagePlanText(world) {
  const { rand } = world;
  const lines = [];
  const stageCount = 1 + Math.floor(rand() * 6); // 4를 넘는 줄은 방이 버린다
  for (let index = 0; index < stageCount; index += 1) {
    const names = [];
    const size = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < size; n += 1) names.push(pick(rand, NAME_POOL));
    lines.push("STAGE: " + names.map((name) => "@" + name).join(" "));
  }
  const tail = rand();
  const body = rand() < 0.15 ? "@agy 도 같이 봐 주세요. 단계로 나눕니다." : "단계로 나눕니다.";
  return [body, ...lines, ...(tail < 0.08 ? ["DONE"] : tail < 0.16 ? ["ASK_USER: 이대로 진행할까요?"] : [])].join("\n");
}

function resolveLead(world, call) {
  const { rand, coverage } = world;
  const roll = rand();
  if (roll < 0.04) { call.fail("TIMED_OUT"); return "lead fail"; }
  if (roll < 0.60) { call.finish(stagePlanText(world)); return "lead stage"; }
  if (roll < 0.68) {
    coverage.legacyMention += 1;
    call.finish("@" + pick(rand, WORKERS) + " @" + pick(rand, WORKERS) + " 맡아줘");
    return "lead legacy mention";
  }
  if (roll < 0.80) { call.finish("모두 끝났습니다.\nDONE"); return "lead done"; }
  if (roll < 0.85) { call.finish("ASK_USER: 어떻게 할까요?"); return "lead ask"; }
  call.finish("알겠습니다."); // 표시 없음: 1라운드면 최종 답, 작업 결과를 받은 뒤면 한 번 재촉한다
  return "lead no marker";
}

function resolveWorker(world, call) {
  const { rand } = world;
  const roll = rand();
  if (roll < 0.17) { call.fail("RATE_LIMITED", rand() < 0.5 ? { partialText: "받아 둔 본문" } : {}); return "worker fail"; }
  if (roll < 0.28) { call.finish("ASK_USER: 이대로 구현할까요?"); return "worker ask"; }
  call.finish(rand() < 0.06 ? "가".repeat(6500) : "작업 끝");
  return "worker finish";
}

function resolveCall(world, call) {
  const { room, rand, coverage } = world;
  const marker = call.marker;
  const late = call.startGen !== room.generation || Boolean(marker && room.orchestration?.id !== marker.id);
  if (late) {
    // 중지됐거나 끝난 오케스트레이션의 프로세스가 뒤늦게 결과를 낸다. 방은 이것으로 새 차례도 새 단계도 열면 안 된다.
    coverage.lateDiscarded += 1;
    const roll = rand();
    if (roll < 0.55) {
      call.finish(marker?.role === "lead" ? "늦은 지휘 답입니다.\nSTAGE: @codex\nSTAGE: @agy" : "늦은 보고");
      return "late finish";
    }
    if (roll < 0.75) { call.fail("늦은 실패"); return "late fail"; }
    call.endCancelled();
    return "late cancelled";
  }
  if (marker?.role === "lead") return resolveLead(world, call);
  if (marker?.role === "worker") return resolveWorker(world, call);
  call.finish("직접 답");
  return "plain finish";
}

function sendRequest(world) {
  world.requestSeq += 1;
  world.room.sendUserMessage("claude에게 맡겨줘 #" + world.requestSeq);
  return "request";
}

function interrupt(world, kind) {
  const { room, rand, coverage } = world;
  if (room.orchestration?.plan) coverage.stoppedMidPlan += 1;
  if (kind === "stopAll") { room.stopAll(); return "stopAll"; }
  if (kind === "interject") { room.interject(); return "interject"; }
  if (kind === "clear") { room.clear(); return "clear"; }
  if (kind === "cancelTurn") {
    const queued = [...room.turnQueue, ...room.deferredTurnQueue];
    if (queued.length === 0) return "cancelTurn(none)";
    room.cancelTurn(pick(rand, queued).turnId);
    return "cancelTurn";
  }
  // 모드 끔: 오케스트레이션을 끝내고 곧바로 다시 켠다(꺼 둔 채로는 일반 대화가 섞여 이 시험의 대상이 흐려진다).
  if (room.orchestration) room.endOrchestration("오케스트레이터 모드를 꺼서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.");
  room.setMeta({ orchestrator: { ...room.meta.orchestrator, enabled: false } });
  room.setMeta({ orchestrator: { ...room.meta.orchestrator, enabled: true } });
  return "modeOff";
}

function toggleLeadModel(world) {
  const { room } = world;
  const current = room.meta.orchestrator || {};
  const next = current.leadModel ? null : "lead-model";
  if (next) world.leadModelEverSet = true;
  room.setMeta({ orchestrator: { ...current, leadModel: next } });
  return "leadModel(" + (next || "none") + ")";
}

function toggleAvailability(world) {
  const { room, rand } = world;
  const id = pick(rand, WORKERS);
  room.setAgents(room.agents.map((agent) => (agent.id === id ? { ...agent, enabled: agent.enabled === false } : agent)));
  return "toggle-enabled(" + id + ")";
}

function step(world) {
  const { room, calls, rand } = world;
  const alive = calls.filter((call) => !call.ended);
  const idle = !room.orchestration && alive.length === 0 && room.turnQueue.length + room.deferredTurnQueue.length === 0;
  if (idle) return sendRequest(world);
  const roll = rand();
  if (roll < 0.58 && alive.length > 0) return resolveCall(world, pick(rand, alive));
  if (roll < 0.68) return sendRequest(world);
  if (roll < 0.72) return interrupt(world, "stopAll");
  if (roll < 0.74) return interrupt(world, "interject");
  if (roll < 0.76) return interrupt(world, "clear");
  if (roll < 0.80) return interrupt(world, "cancelTurn");
  if (roll < 0.84) return interrupt(world, "modeOff");
  if (roll < 0.88 && world.leadModelMode >= 2) return toggleLeadModel(world);
  if (roll < 0.92 && world.toggleAvailability) return toggleAvailability(world);
  return "noop";
}

// ─── 불변식 ───────────────────────────────────────────────

// (오케스트레이션, 라운드)마다 작업자 호출을 단계 번호로 묶는다.
function workerRounds(calls) {
  const rounds = new Map();
  for (const call of calls) {
    const marker = call.marker;
    if (!marker || marker.role !== "worker") continue;
    const key = marker.id + ":" + marker.round;
    if (!rounds.has(key)) rounds.set(key, { id: marker.id, round: marker.round, stages: new Map() });
    const stages = rounds.get(key).stages;
    if (!stages.has(marker.stage)) stages.set(marker.stage, []);
    stages.get(marker.stage).push(call);
  }
  return rounds;
}

// 그 라운드의 지휘 AI 차례 수: 이미 시작한 것과 큐에서 기다리는 것을 합한다.
function leadTurnsOf(world, orchId, round) {
  const { room, calls } = world;
  const started = calls.filter((call) => call.marker?.id === orchId && call.marker.role === "lead" && call.marker.round === round).length;
  const queued = [...room.turnQueue, ...room.deferredTurnQueue].filter((item) => {
    const marker = item.context?.orchestration;
    return marker?.id === orchId && marker.role === "lead" && marker.round === round;
  }).length;
  return started + queued;
}

function checkInvariants(world, label) {
  const { room, calls, plans, violations, coverage } = world;
  assert.deepEqual(violations, [], label + ": " + violations.join(" / "));
  const live = room.orchestration;

  // 같은 담당자가 동시에 두 차례를 돌지 않는다.
  const running = [...room.runningTurns].map((item) => item.agent.id);
  assert.equal(new Set(running).size, running.length, label + ": 같은 담당자 동시 실행");
  // 교착 없음: 돌고 있는 단위 없이 큐만 남지 않는다.
  assert.ok(!(room.activeUnits.size === 0 && room.turnQueue.length > 0), label + ": 교착(돌고 있는 단위 없이 큐가 남음)");

  // 4. 종료 뒤 침묵: 큐에는 살아 있는 오케스트레이션의 항목만 남는다(끝난 쪽의 형제는 모두 치워져 있다).
  for (const item of [...room.turnQueue, ...room.deferredTurnQueue]) {
    const id = item.context?.orchestration?.id;
    assert.ok(!id || (live && live.id === id), label + ": 끝난 오케스트레이션(" + id + ")의 항목이 큐에 남아 있다");
  }

  if (live) {
    assert.ok(live.round <= world.roundCeiling, label + ": 라운드가 안전선을 넘었다");
    // 살아 있는 오케스트레이션에는 돌거나 기다리는 차례가 반드시 있다(없으면 멈춘 것이다).
    const pending = [...room.runningTurns, ...room.turnQueue, ...room.deferredTurnQueue].some((item) => item.context?.orchestration?.id === live.id);
    assert.ok(pending, label + ": 살아 있는 오케스트레이션에 돌거나 기다리는 차례가 없다(멈춤)");
    // 3. 실행 횟수
    const started = calls.filter((call) => call.marker?.id === live.id).length;
    if (world.toggleAvailability) {
      assert.ok(started <= live.executions, label + ": 시작한 차례(" + started + ")가 실행 횟수(" + live.executions + ")보다 많다");
    } else {
      assert.equal(live.executions, started, label + ": 실행 횟수가 실제로 시작한 차례 수와 다르다");
    }
    // 단계 표시: 계획이 열려 있는 동안에만 있고, 범위 안이다.
    const shown = room.state().orchestration.stage;
    assert.equal(Boolean(shown), Boolean(live.plan), label + ": 단계 표시와 계획 상태가 어긋난다");
    if (shown) {
      assert.ok(shown.index >= 1 && shown.index <= shown.total && shown.total <= MAX_STAGES, label + ": 단계 표시 범위");
      assert.ok(shown.agentIds.length > 0 && shown.agentIds.every((id) => IDS.includes(id)), label + ": 단계 표시 참가자");
    }
  }

  // 지휘 모델을 한 번도 켠 적 없는 방에서는 지휘 AI가 자기 자신을 작업자로 부르지 않는다.
  if (!world.leadModelEverSet) {
    assert.ok(!calls.some((call) => call.marker?.role === "worker" && call.agentId === LEAD), label + ": 지휘 모델 없이 지휘 AI가 자기를 작업자로 불렀다");
  }

  const rounds = workerRounds(calls);
  for (const entry of rounds.values()) {
    const where = entry.id + " 라운드" + entry.round;
    const numbers = [...entry.stages.keys()].sort((a, b) => a - b);
    const maxStage = numbers[numbers.length - 1];
    assert.deepEqual(numbers, Array.from({ length: maxStage }, (_, index) => index + 1), label + ": " + where + " 단계 번호가 1부터 빠짐없이 이어지지 않는다");
    const plan = plans.find((candidate) => candidate.orchId === entry.id && candidate.round === entry.round);
    assert.ok(plan, label + ": " + where + " 작업자가 단계 계획 없이 시작했다");
    assert.ok(maxStage <= Math.min(plan.stageCount, MAX_STAGES), label + ": " + where + " 계획(" + plan.stageCount + "단계)보다 뒤 단계가 시작됐다");
    for (const [stage, group] of entry.stages) {
      // 2. 안전선: 단계를 시작하기 전 실행 수 + 그 단계 인원이 실행 횟수 안전선 안이다(단계마다 시작 전에 본다).
      const before = Math.min(...group.map((call) => call.execsBefore));
      assert.ok(before + group.length <= world.executionCeiling, label + ": " + where + " " + stage + "단계가 실행 횟수 안전선(" + world.executionCeiling + ")을 넘어 시작했다");
      // 조기 종료: 끝난 단계의 참가자가 모두 실패했거나 누가 질문을 남겼으면 그 뒤 단계는 열리지 않는다.
      const finished = group.every((call) => call.ended);
      const stopped = finished && (group.every((call) => call.outcome === "fail") || group.some((call) => call.outcome === "ask"));
      if (stopped) {
        assert.ok(maxStage <= stage, label + ": " + where + " " + stage + "단계가 모두 실패했거나 질문을 남겼는데 뒤 단계가 열렸다");
        const key = entry.id + ":" + entry.round + ":" + stage;
        if (plan.stageCount > stage && !world.seenGroups.has(key)) { world.seenGroups.add(key); coverage.stoppedEarly += 1; }
      }
    }
  }

  // 2. 회신 한 번
  plans.forEach((plan, index) => {
    const replies = leadTurnsOf(world, plan.orchId, plan.round + 1);
    assert.ok(replies <= 1, label + ": " + plan.orchId + " 라운드" + plan.round + " 계획에 지휘 AI 회신이 " + replies + "번 열렸다");
    if (live && live.id === plan.orchId) {
      const open = Boolean(live.plan) && live.plan.round === plan.round;
      assert.equal(replies, open ? 0 : 1, label + ": " + plan.orchId + " 라운드" + plan.round + " 계획이 " + (open ? "진행 중인데 회신이 열렸다" : "끝났는데 회신이 열리지 않았다"));
    }
    if (replies === 1 && !world.seenReplies.has(index)) { world.seenReplies.add(index); coverage.replied += 1; }
    if (replies >= 1 && !world.toggleAvailability) {
      // 회신이 열렸다면: 모든 단계를 돌았거나, 마지막으로 돈 단계가 전부 실패했거나 질문이 있어 나머지를 건너뛴 것이다.
      const entry = rounds.get(plan.orchId + ":" + plan.round);
      const stages = entry ? entry.stages : new Map();
      const last = stages.get(stages.size) || [];
      const skipped = last.length > 0 && (last.every((call) => call.outcome === "fail") || last.some((call) => call.outcome === "ask"));
      assert.ok(stages.size === plan.stageCount || skipped, label + ": " + plan.orchId + " 라운드" + plan.round + " 계획이 " + stages.size + "/" + plan.stageCount + "단계에서 이유 없이 회신으로 넘어갔다");
    }
  });
}

// 시드 하나가 끝난 뒤 그 시드가 닿은 경로를 합산한다.
function tally(world) {
  const { calls, systems, coverage } = world;
  if (calls.some((call) => call.marker?.role === "worker" && call.marker.stage >= 2)) coverage.multiStage += 1;
  if (calls.some((call) => call.marker?.role === "lead" && call.prompt.includes("=== 지휘 차례 안내 ==="))) coverage.nudged += 1;
  if (calls.some((call) => call.marker?.role === "worker" && call.agentId === LEAD)) coverage.selfCall += 1;
  if (systems.some((line) => /안전선/.test(line))) coverage.ceilingHit += 1;
  if (systems.some((line) => line.startsWith("STAGE 줄에서 일부를 뺐습니다"))) coverage.planNotes += 1;
}

// 남은 일을 모두 끝내고(지휘 AI에게는 DONE으로 답하게 한다) 장부가 기준선으로 돌아오는지 본다.
async function drain(world, label) {
  const { room, calls } = world;
  for (let round = 0; round < 300; round += 1) {
    const busy = room.activeUnits.size > 0 || room.turnQueue.length > 0 || room.deferredTurnQueue.length > 0
      || room.runningTurns.size > 0 || calls.some((call) => !call.ended);
    if (!busy && !room.orchestration) break;
    for (const call of calls.filter((entry) => !entry.ended)) {
      const dead = Boolean(call.marker && room.orchestration?.id !== call.marker.id);
      if (call.startGen !== room.generation || dead) call.endCancelled();
      else if (call.marker?.role === "lead") call.finish("마무리했습니다.\nDONE");
      else call.finish("마무리");
    }
    await settle(2);
  }
  checkInvariants(world, label);
  assert.equal(room.runningTurns.size, 0, label + ": runningTurns");
  assert.equal(room.activeUnits.size, 0, label + ": activeUnits");
  assert.equal(room.turnQueue.length + room.deferredTurnQueue.length, 0, label + ": 큐");
  assert.equal(room.pendingTurns.size, 0, label + ": pendingTurns");
  assert.equal(room.orchestration, null, label + ": orchestration");
}

const SEEDS = Array.from({ length: 160 }, (_, index) => index + 1);
const STEPS = 130;

test("단계 실행 속성 시험: 시드마다 걸음마다 단계 순서·회신 한 번·실행 횟수·종료 뒤 침묵을 점검하고 끝에 기준선으로 돌아온다", async (t) => {
  const coverage = Object.fromEntries(COVERAGE_KEYS.map((key) => [key, 0]));
  for (const seed of SEEDS) {
    const world = makeWorld(seed, coverage);
    for (let index = 0; index < STEPS; index += 1) {
      const what = step(world);
      await settle();
      checkInvariants(world, "시드 " + seed + " #" + index + " " + what);
    }
    tally(world);
    await drain(world, "시드 " + seed + " 마무리");
  }
  const missing = COVERAGE_KEYS.filter((key) => coverage[key] === 0);
  // 시드 수(multiStage·nudged·selfCall·ceilingHit·planNotes) 또는 사건 수(나머지)다. 줄어들면 사건열이 그 경로를 덜 건드린다는 뜻이다.
  t.diagnostic("닿은 경로 " + JSON.stringify(coverage));
  assert.deepEqual(missing, [], "사건열이 닿지 못한 경로: " + missing.join(", ") + " " + JSON.stringify(coverage));
});
