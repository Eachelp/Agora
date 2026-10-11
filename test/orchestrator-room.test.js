"use strict";

// 오케스트레이터 모드(흐름 B): 지휘 AI가 작업자를 묶음으로 부르고, 묶음이 끝나면 지휘 AI에게 한 번만
// 회신한다. 시나리오 번호는 docs/design/AGORA_REVISION_2026-10-11_ORCHESTRATOR.md §(14)를 따른다.
// 진입점은 ChatRoom.sendUserMessage/interject/stopAll/cancelTurn이고 러너는 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom, ids } = require("./reply-now-helpers.cjs");

function withLead(options = {}) {
  return makeRoom({
    ids: ["claude", "codex", "agy"],
    meta: { orchestrator: { enabled: true, leadId: "claude" }, ...(options.meta || {}) },
    ...options,
  });
}

test("O1 평범한 대화: 지휘 AI가 @ 없이 답하면 오케스트레이션이 생겼다 사라진다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("@claude 이거 조사해줘");
  await settle();
  assert.ok(room.orchestration, "claim 시점에 오케스트레이션이 생긴다");
  assert.equal(room.orchestration.round, 1);
  calls[0].finish("조사했습니다. 결론은 이렇습니다.");
  await settle();
  assert.equal(room.orchestration, null, "@ 없이 답하면 끝난다");
  assert.equal(room.state().orchestration, null);
});

test("O2 지휘 AI가 @codex @agy를 부르면 한 묶음으로 같이 claim되고, 둘 다 끝나면 회신이 한 번만 claim된다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  assert.deepEqual(ids(calls).slice(1).sort(), ["agy", "codex"], "같은 패스에서 같이 claim된다");
  assert.equal(room.orchestration.round, 1);
  assert.equal(room.orchestration.executions, 3, "claude+codex+agy");
  calls[1].finish("codex 완료");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy"], "agy가 아직 도는 중이면 회신이 서지 않는다");
  calls[2].finish("agy 완료");
  await settle();
  assert.deepEqual(ids(calls).map((id) => id), ["claude", "codex", "agy", "claude"], "묶음이 모두 끝나면 회신이 한 번만 claim된다");
  assert.equal(room.orchestration.round, 2);
  assert.match(calls[3].prompt, /작업자 결과\(라운드 1\)/);
  assert.match(calls[3].prompt, /\[@codex\] 완료/);
  assert.match(calls[3].prompt, /\[@agy\] 완료/);
});

test("O3 작업자가 끝난 뒤 그 작업자에게 직접 @답장을 보내면 바로 답하고, 그 답은 결과 블록에 안 들어간다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  calls[1].finish("codex 완료"); // codex 끝, agy는 아직 돈다
  await settle();
  room.sendUserMessage("@codex 그건 이렇게 다시");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy", "codex"], "codex가 비어 있으므로 바로 답한다");
  assert.ok(room.orchestration, "오케스트레이션은 그대로다(agy가 계속 돈다)");
  calls[3].finish("직접 답");
  calls[2].finish("agy 완료");
  await settle();
  const resultBlock = calls[4].prompt.split("=== 작업자 결과(라운드 1) ===")[1].split("=== 작업자 결과 끝 ===")[0];
  assert.match(resultBlock, /\[@codex\] 완료/, "결과 블록에는 codex의 작업자 결과만 있다");
  assert.doesNotMatch(resultBlock, /직접 답/, "직접 @codex 응답은 결과 블록에 들어가지 않는다(대화 기록에는 보통 메시지로 보인다)");
});

test("O4 작업자 묶음이 아직 claim 전(동료가 바빠서)일 때 그중 한 명에게 @로 직접 보내도 그 작업자 항목을 걷어내지 않는다", async () => {
  const { room, calls } = withLead();
  // codex를 다른 일로 바쁘게 만든다(@로 직접 불러 빠른 턴으로 즉시 시작, 끝내지 않고 둔다).
  room.sendUserMessage("@codex 다른 일");
  await settle();
  room.sendUserMessage("@claude 맡겨줘"); // 명시적 @claude라 codex가 바빠도(메인 줄이 아니라) 바로 시작한다
  await settle();
  calls[1].finish("@codex @agy 각자 맡아줘");
  await settle();
  // codex가 아직 돌고 있으므로(agentIsRunning) 작업자 묶음 전체가 claim되지 않고 큐에 남는다(§(4) 불변식 6).
  const workerItem = room.turnQueue.find((item) => item.context.orchestration?.role === "worker" && item.agent.id === "agy");
  assert.ok(workerItem, "agy의 작업자 항목이 claim 전 상태로 큐에 있다");
  room.sendUserMessage("@agy 그건 빼고");
  await settle();
  const stillThere = room.turnQueue.includes(workerItem);
  assert.equal(stillThere, true, "새 메시지가 agy의 작업자 항목을 걷어내지 않는다(설계 §(4) 교차점)");
});

test("O5 작업자 중 하나가 실패해도 결과 블록에 실패 사유가 함께 들어간다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  calls[1].fail("TIMED_OUT");
  calls[2].finish("agy 완료");
  await settle();
  assert.match(calls[3].prompt, /\[@codex\] 실패/);
  assert.match(calls[3].prompt, /TIMED_OUT/);
  assert.match(calls[3].prompt, /\[@agy\] 완료/);
});

test("O6 작업자의 끝 ASK_USER는 사용자에게 보이지 않고 결과 블록으로 지휘 AI에게 간다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 이거 맡아줘");
  await settle();
  calls[1].finish("ASK_USER: 이대로 할까요?");
  await settle();
  assert.equal(room.awaitingUsers.has("agy"), false, "작업자 자신은 답변 대기로 서지 않는다");
  assert.match(calls[2].prompt, /\[@agy\] 질문 있음: 이대로 할까요\?/);
});

test("O7 오케스트레이션 중 직접 @other 메시지는 오케스트레이션을 끝내지 않는다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘");
  await settle();
  room.sendUserMessage("@codex 이건 별개로 봐줘");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "codex"]);
  assert.ok(room.orchestration);
  calls[1].finish("agy 완료");
  calls[2].finish("직접 답");
  await settle();
  assert.equal(room.orchestration.round, 2, "agy가 끝나면 지휘 AI의 회신 턴(라운드 2)이 claim된다");
});

test("O8·O9 지휘 AI에게 가는 메시지는 보류되고, 여러 번 보내면 모두 쌓여 다음 회신에 한 번에 들어간다", async () => {
  const { room, calls, systems } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘");
  await settle();
  room.sendUserMessage("상황이 바뀌었는데");
  room.sendUserMessage("그리고 이것도");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy"], "턴이 새로 서지 않는다");
  assert.equal(room.orchestration.heldMessages.length, 2);
  assert.ok(systems.filter((text) => /결과가 모이면 이 메시지까지/.test(text)).length === 2, "메시지마다 안내");
  calls[1].finish("agy 완료");
  await settle();
  assert.match(calls[2].prompt, /사용자가 그 사이 보낸 메시지/);
  assert.match(calls[2].prompt, /"상황이 바뀌었는데"/);
  assert.match(calls[2].prompt, /"그리고 이것도"/);
  assert.equal(room.orchestration.heldMessages.length, 0, "다음 회신 턴에 실리면 비운다");
});

test("O10 잠깐: 오케스트레이션을 끝내고, 늦게 끝나는 작업자 결과는 조용히 버린다", async () => {
  const { room, calls, systems } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  room.interject();
  await settle();
  assert.equal(room.orchestration, null);
  calls[1].finish("늦은 codex 결과");
  calls[2].finish("늦은 agy 결과");
  await settle();
  assert.equal(calls.length, 3, "늦은 결과가 새 회신 턴을 만들지 않는다");
  assert.ok(systems.some((text) => /개입해 진행 중인 응답과 대기 턴을 중지했습니다/.test(text)));
});

test("O11 라운드 안전선에 닿으면 회신 턴을 시작하지 않고 멈춘다", async () => {
  const { room, calls, systems } = withLead({ roundCeiling: 1 });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘"); // round 1 -> 작업자 묶음
  await settle();
  calls[1].finish("agy 완료"); // round+1(=2) > ceiling(1) -> 회신 턴을 시작하지 않는다
  await settle();
  assert.equal(calls.length, 2, "지휘 AI의 다음 회신 턴이 claim되지 않는다");
  assert.equal(room.orchestration, null);
  assert.ok(systems.some((text) => /라운드 안전선\(1\)에 닿아 멈췄습니다/.test(text)));
});

test("O12 실행 횟수 안전선에 닿으면 작업자 묶음을 시작하지 않는다", async () => {
  const { room, calls, systems } = withLead({ executionCeiling: 1 });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  // claude 자신의 claim으로 executions=1, 여기서 +2(codex,agy)=3 > 1
  calls[0].finish("@codex @agy 각자 맡아줘");
  await settle();
  assert.equal(calls.length, 1, "작업자 묶음이 시작하지 않는다");
  assert.equal(room.orchestration, null);
  assert.ok(systems.some((text) => /실행 횟수 안전선\(1회\)에 닿아 더 맡기지 않았습니다/.test(text)));
});

test("O13·O14 자기 자신과 그룹 별칭은 작업자 후보에서 빠진다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@claude @all @codex 부탁해");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"], "@claude(자기 자신)과 @all(그룹 별칭)은 작업자가 아니다");
});

test("O15 비활성 id만 불렀으면 맡기지 못했다는 안내로 끝난다", async () => {
  const { room, calls, systems } = withLead({ ids: ["claude", "codex", "teamx"] });
  room.setAgents(room.agents.map((agent) => (agent.id === "teamx" ? { ...agent, enabled: false } : agent)));
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@teamx 맡아줘");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(room.orchestration, null);
  assert.ok(systems.some((text) => /⟦teamx⟧을 부를 수 없어 맡기지 못했습니다/.test(text)));
});

test("O18 오케스트레이션 중에는 토론을 시작할 수 없다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘");
  await settle();
  const result = await room.startDiscussion({ turnBudget: 3 });
  assert.equal(result.ok, false);
  assert.match(result.error, /오케스트레이션이 끝난 뒤에 토론을 시작할 수 있습니다/);
  assert.equal(room.discussionRequested, false);
});

test("O24 대기 중인 작업자 항목을 ×로 지우면 그 항목만이 아니라 오케스트레이션 전체가 끝난다", async () => {
  const { room, calls, systems } = withLead();
  room.sendUserMessage("@codex 바쁜 일");
  await settle();
  room.sendUserMessage("@claude 맡겨줘");
  await settle();
  calls[1].finish("@codex @agy 각자 맡아줘");
  await settle();
  const pendingWorker = room.turnState().queue.find((entry) => entry.agentId === "codex" || entry.agentId === "agy");
  assert.ok(pendingWorker, "codex가 바쁘므로 작업자 묶음 전체가 대기 중이다");
  const cancelled = room.cancelTurn(pendingWorker.turnId);
  assert.equal(cancelled, true);
  assert.equal(room.orchestration, null, "오케스트레이션 전체가 끝난다");
  assert.ok(systems.some((text) => /오케스트레이션을 여기서 끝냅니다/.test(text)));
});

test("O25 오케스트레이션이 도는 동안에도 @all 메시지는 굶지 않고 바로 시작한다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("@claude 맡겨줘");
  await settle();
  calls[0].finish("@agy 맡아줘"); // agy가 작업자로 도는 동안(활성 단위가 전부 오케스트레이션 턴)
  await settle();
  room.sendUserMessage("@all 다들 어떻게 생각해?");
  await settle();
  assert.equal(ids(calls).filter((id) => id === "claude").length, 2, "@all의 claude 몫이 agy(작업자)를 기다리지 않고 바로 시작한다(§2.4(c))");
});

test("O26 모드를 끄면(room.endOrchestration) 대기 중인 작업자 항목이 큐에서 치워진다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("@codex 바쁜 일");
  await settle();
  room.sendUserMessage("@claude 맡겨줘");
  await settle();
  calls[1].finish("@codex @agy 각자 맡아줘");
  await settle();
  assert.ok(room.turnState().queue.length > 0, "codex가 바쁘므로 작업자 묶음 전체가 대기 중이다");
  room.endOrchestration("오케스트레이터 모드를 꺼서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.");
  await settle();
  assert.equal(room.turnState().queue.length, 0, "대기 중이던 작업자 항목이 치워진다");
  calls[0].finish("바쁜 일 끝");
  await settle();
  assert.ok(!ids(calls).includes("agy"), "치워진 작업자는 나중에도 실행되지 않는다");
});

test("O27 지휘 AI가 작업자를 부르면서 동시에 끝 ASK_USER를 남기면 질문 카드가 서지 않는다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex 맡아줘\nASK_USER: 이대로 진행할까요?");
  await settle();
  assert.equal(room.awaitingUsers.has("claude"), false, "작업자를 부른 라운드의 질문은 조용히 버려진다");
  calls[1].finish("codex 완료");
  await settle();
  calls[2].finish("ASK_USER: 다음엔 어떻게 할까요?"); // 다음 라운드엔 작업자를 더 안 부르고 끝맺는다
  await settle();
  assert.equal(room.awaitingUsers.has("claude"), true, "작업자 호출 없이 끝맺을 때는 정상적으로 카드가 선다");
});

test("불변식: 방에 오케스트레이션은 한 번에 하나뿐이다(지휘 AI에게 가는 두 번째 메시지도 둘째 오케스트레이션을 만들지 않는다)", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  const first = room.orchestration.id;
  room.sendUserMessage("또 맡겨줘"); // 진행 중이므로 보류될 뿐, 둘째 오케스트레이션을 만들지 않는다
  await settle();
  assert.equal(room.orchestration.id, first);
  calls[0].finish("완료");
  await settle();
  assert.equal(room.orchestration, null);
});
