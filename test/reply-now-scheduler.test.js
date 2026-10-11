"use strict";

// 바로 답하기(reply-now): 여러 모델이 답하는 중에 한 모델에게 답장하면 기다리지 않고 바로 답한다.
// 진입점은 ChatRoom.sendUserMessage이고 러너는 가짜(약속을 시험이 직접 푼다)다.
// 시나리오 번호(S1…)는 docs/design/AGORA_REVISION_2026-10-11_REPLY_NOW.md §6의 표를 따른다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom, ids, queued } = require("./reply-now-helpers.cjs");

const sorted = (list) => [...list].sort();

// claude는 끝났고 codex가 도는 중, agy가 기다리는 이어 발언 @모두.
async function chainWithCodexRunning(options) {
  const env = makeRoom(options);
  env.room.sendUserMessage("@all 질문");
  await settle();
  env.calls[0].finish("클로드 답");
  await settle();
  assert.deepEqual(ids(env.calls), ["claude", "codex"]);
  assert.deepEqual(queued(env.room), ["agy"]);
  return env;
}

test("S9 아무것도 안 도는 방에서 @claude는 같은 순간에 시작한다(큐에 보이지 않는다)", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude 안녕");
  assert.deepEqual(ids(calls), ["claude"]);
  assert.deepEqual(room.turnState().queue, []);
  assert.deepEqual(room.turnState().running, ["claude"]);
  calls[0].finish();
  await settle();
  assert.deepEqual(room.turnState().running, []);
});

test("S1 이어 발언 도중 끝난 모델에게 답장하면 도는 모델과 동시에 바로 시작하고, 기다리던 모델은 둘이 다 끝난 뒤 시작한다", async () => {
  const { room, calls, systems } = await chainWithCodexRunning();
  room.sendUserMessage("@claude 한 가지만 더");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude"], "큐에 서지 않고 바로 시작");
  assert.deepEqual(sorted(room.turnState().running), ["claude", "codex"]);
  assert.deepEqual(queued(room), ["agy"]);
  calls[1].finish("코덱스 답");
  await settle();
  assert.equal(calls.length, 3, "빠른 claude가 아직 도는 동안 일반 줄의 agy는 시작하지 않는다");
  calls[2].finish("클로드 둘째 답");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude", "agy"]);
  assert.ok(!systems.some((text) => /차례를 기다리고|유실/.test(text)), "바로 시작한 턴에는 정체 경고가 없다");
});

test("S2 도는 중인 모델에게 답장하면 대기(fast)로 서고, 그 실행이 끝난 바로 그 순간 일반 줄의 agy보다 먼저 시작한다", async () => {
  const { room, calls } = await chainWithCodexRunning();
  room.sendUserMessage("@codex 이건 이렇게");
  await settle();
  assert.deepEqual(queued(room), ["agy", "codex*"], "빠른 대기 항목이 표시된다");
  assert.equal(calls.length, 2, "같은 담당자는 동시에 돌지 않는다");
  calls[1].finish("코덱스 첫 답");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "codex"]);
  assert.match(calls[2].prompt, /코덱스 첫 답/, "빠른 턴은 자기 담당자의 직전 답까지 본다");
  assert.deepEqual(queued(room), ["agy"]);
  calls[2].finish();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "codex", "agy"]);
});

test("S3 기다리는 빠른 턴은 새 메시지로 제자리에서 갈아끼워져 한 번만 답한다", async () => {
  const { room, calls } = await chainWithCodexRunning();
  room.sendUserMessage("@codex 이건 이렇게");
  room.sendUserMessage("@codex 아니 이렇게");
  await settle();
  assert.deepEqual(queued(room), ["agy", "codex*"]);
  calls[1].finish();
  await settle();
  assert.equal(calls.filter((call) => call.agentId === "codex").length, 2, "codex는 한 번만 더 답한다");
  assert.match(calls[2].prompt, /이건 이렇게/);
  assert.match(calls[2].prompt, /아니 이렇게/);
});

test("S4 아직 시작 안 한 일반 대기 턴은 새 메시지로 큐 자리를 지키며 갈아끼워지고 빠른 턴이 되지 않는다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex", "agy", "gemini"] });
  room.sendUserMessage("@all 질문");
  await settle();
  assert.deepEqual(queued(room), ["codex", "agy", "gemini"]);
  room.sendUserMessage("@codex 질문");
  await settle();
  assert.deepEqual(queued(room), ["codex", "agy", "gemini"], "맨 뒤로 가지 않고 자리를 지킨다");
  calls[0].finish();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"]);
  assert.match(calls[1].prompt, /@codex 질문/);
});

test("S5 독립 발언이 도는 중 한 모델에게 답장하면 그 모델이 끝나는 순간(폴더 감시와 형제가 남아 있어도) 시작하고 나머지는 계속 돈다", async () => {
  const { room, calls } = makeRoom({ meta: { permissionMode: "workspace-write" } });
  const watch = Promise.withResolvers();
  room.reportFolderContractBreaches = () => watch.promise;
  room.sendUserMessage({ text: "@all 각자 해 봐", independent: true });
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy"], "독립 발언은 한꺼번에 시작한다");
  room.sendUserMessage("@claude 질문");
  await settle();
  assert.deepEqual(queued(room), ["claude*"]);
  calls[0].finish("클로드 각자 답");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy", "claude"]);
  assert.match(calls[3].prompt, /클로드 각자 답/, "시작 시점의 기록에는 @모두에 대한 자기 답이 있다");
  assert.deepEqual(sorted(room.turnState().running), ["agy", "claude", "codex"].sort());
  // 단위(독립 발언 묶음)가 끝나기 전에는 일반 항목이 시작하지 않는다.
  room.sendUserMessage("그 다음 질문");
  calls[1].finish();
  calls[2].finish();
  calls[3].finish();
  await settle();
  assert.equal(calls.length, 4, "폴더 감시가 끝나기 전에는 일반 줄이 시작하지 않는다");
  watch.resolve();
  await settle();
  assert.equal(calls.length, 5, "단위가 끝나면 일반 줄이 시작한다");
});

test("S6 이어 발언으로 둘 이상을 부른 메시지는 빠르지 않고 순서대로 돈다", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude @codex 이어서");
  await settle();
  assert.deepEqual(ids(calls), ["claude"]);
  assert.deepEqual(queued(room), ["codex"], "fast 표시가 없다");
  calls[0].finish();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"]);
});

test("S6 그룹 별칭이 섞인 메시지(@모두 @claude)와 멘션 없는 메시지는 빠르지 않다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex", "agy", "gemini"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  room.sendUserMessage("@모두 @claude 다 같이");
  room.sendUserMessage("멘션 없이");
  await settle();
  assert.ok(queued(room).every((label) => !label.endsWith("*")), queued(room).join());
  assert.equal(calls.length, 1, "일반 줄은 도는 턴이 끝나야 시작한다");
});

test("S7 토론 중의 @답장은 빠르지 않다: 보류됐다가 토론이 끝난 뒤 시작한다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  const discussion = room.startDiscussion({ turnBudget: 3 });
  await settle();
  assert.equal(calls.length, 1, "토론 첫 턴");
  room.sendUserMessage("@claude 질문");
  await settle();
  assert.deepEqual(room.turnState().queue, []);
  assert.deepEqual(room.turnState().deferred.map((entry) => entry.agentId), ["claude"]);
  assert.equal(calls.length, 1);
  for (let i = 0; i < 3; i += 1) {
    calls[i].finish("의견 [[CODEPET_DISCUSSION:CONTINUE]]");
    await settle();
  }
  assert.equal(calls.length, 4, "토론이 끝난 뒤 보류됐던 턴이 시작한다");
  assert.equal(calls[3].agentId, "claude");
  assert.doesNotMatch(calls[3].prompt, /자율 토론 d/);
  calls[3].finish();
  await discussion;
});

test("S8 토론 시작을 기다리는 중의 @답장은 일반 턴이 되어 토론보다 먼저 끝나고, 토론 턴과 겹쳐 돌지 않는다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  const discussion = room.startDiscussion({ turnBudget: 3 });
  await settle();
  room.sendUserMessage("@codex 질문");
  await settle();
  assert.deepEqual(queued(room), ["codex"], "빠르지 않다");
  assert.equal(calls.length, 1);
  calls[0].finish();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"], "토론보다 먼저");
  assert.deepEqual(room.turnState().running, ["codex"]);
  calls[1].finish();
  await settle();
  assert.equal(calls.length, 3, "토론 첫 턴은 코덱스가 끝난 뒤 시작");
  assert.match(calls[2].prompt, /자율 토론/);
  assert.equal(room.turnState().running.length, 1);
  for (let i = 2; i < 5; i += 1) {
    calls[i]?.finish("[[CODEPET_DISCUSSION:CONTINUE]]");
    await settle();
  }
  await discussion;
});

test("S17(F27) 갈아끼운 대기 턴은 옛 뿌리의 @멘션 호출을 받아 접고, 그 담당자는 한 번만 답한다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude @codex 의견 줘");
  await settle();
  assert.deepEqual(queued(room), ["codex"]);
  room.sendUserMessage("@codex 추가로 성능도 봐줘");
  await settle();
  assert.deepEqual(queued(room), ["codex"], "제자리에서 갈아끼워진다");
  calls[0].finish("의견입니다. @codex 확인해줘");
  await settle();
  assert.deepEqual(queued(room), []);
  assert.deepEqual(ids(calls), ["claude", "codex"], "옛 뿌리 호출은 새 턴을 만들지 않는다");
  assert.match(calls[1].prompt, /성능도 봐줘/);
  assert.match(calls[1].prompt, /확인해줘/);
  calls[1].finish();
  await settle();
  assert.equal(calls.length, 2);
});

test("F27 갈아끼운 턴이 시작한 뒤의 옛 뿌리 멘션 호출은 접히지 않고 새 턴이 된다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude @codex 의견 줘");
  await settle();
  room.sendUserMessage("@codex 추가로 성능도 봐줘");
  // 시험이 직접 만든 늦은 호출: 옛 뿌리 키는 대기 중인 동안만 접힌다.
  const oldRoot = room.messages[0].id;
  assert.ok(room.pendingTurns.has(`${oldRoot}:codex`), "대기 중에는 옛 키가 새 항목을 가리킨다");
  calls[0].finish("끝");
  await settle();
  assert.equal(calls.length, 2, "codex 시작");
  assert.ok(!room.pendingTurns.has(`${oldRoot}:codex`), "시작하면 별칭 키가 모두 지워진다");
  assert.equal(room.pendingTurns.size, 0);
});

test("S18 전달·결론 종합·기록관 턴은 빠르지 않고, 그것들이 기다리는 동안 온 같은 담당자의 메시지도 빠르지 않다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  const source = room.appendMessage({ authorType: "agent", author: "claude", text: "전달할 글" });
  room.handoffMessage("codex", source.id);
  assert.deepEqual(queued(room), ["codex"], "전달 턴은 일반 줄");
  room.sendUserMessage("@codex 질문");
  await settle();
  assert.deepEqual(queued(room), ["codex", "codex"], "갈아끼울 수 없는 전달 턴 뒤에 일반으로 선다");
  assert.equal(calls.length, 1);
  calls[0].finish();
  await settle();
  assert.match(calls[1].prompt, /전달/, "전달이 먼저");
  assert.doesNotMatch(calls[1].prompt, /@codex 질문/);
  calls[1].finish();
  await settle();
  assert.match(calls[2].prompt, /@codex 질문/);
});

test("S18 결론 종합·기록관 턴이 기다리는 동안 온 @메시지는 빠르지 않아 종합보다 먼저 답하지 않는다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  room.scheduleResponse(room.agents[1], {
    discussionSummary: { discussionId: "d1", record: true, incomplete: false, participants: [], failures: 0 },
    discussionSummaryMessages: [{ id: "x", authorType: "user", text: "논의" }],
  });
  room.sendUserMessage("@claude 또 질문");
  await settle();
  assert.ok(queued(room).every((label) => !label.endsWith("*")), queued(room).join());
  assert.equal(calls.length, 1);
});

test("S21 대기 중인 일반 독립 발언 묶음의 한 구성원만 갈아끼워도 남은 구성원은 한 단위로 함께 시작한다", async () => {
  const { room, calls } = makeRoom({ ids: ["hold", "claude", "codex", "agy"], meta: { permissionMode: "workspace-write" } });
  room.reportFolderContractBreaches = async () => {};
  room.scheduleResponse(room.agents[0]);
  await settle();
  assert.deepEqual(ids(calls), ["hold"]);
  room.setAgents(room.agents.map((agent) => (agent.id === "hold" ? { ...agent, enabled: false } : agent)));
  room.sendUserMessage({ text: "@모두 각자", independent: true });
  assert.deepEqual(queued(room), ["claude", "codex", "agy"]);
  room.sendUserMessage("@codex 이거만");
  assert.deepEqual(queued(room), ["claude", "codex", "agy"], "codex 자리를 지킨다");
  calls[0].finish();
  await settle();
  assert.deepEqual(ids(calls), ["hold", "claude", "agy"], "남은 둘이 한 단위로 시작한다");
  assert.match(calls[1].prompt, /참가자 2명이 같은 작업 폴더에서 동시에/, "참가자 수는 시작 때 다시 센다");
  calls[1].finish();
  calls[2].finish();
  await settle();
  assert.deepEqual(ids(calls), ["hold", "claude", "agy", "codex"], "새 codex 항목은 그 뒤에 일반 줄 순서로");
  assert.doesNotMatch(calls[3].prompt, /동시에 실행되고 있습니다/);
});

test("S22 대기 중인 빠른 독립 발언 묶음에서 한 구성원을 갈아끼우면 새 항목은 빠르고 즉시 시작하며, 남은 하나는 묶음 계약 없이 시작한다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"], meta: { permissionMode: "workspace-write" } });
  room.reportFolderContractBreaches = async () => {};
  room.sendUserMessage("@claude 길게");
  await settle();
  room.sendUserMessage({ text: "@claude @codex 각자", independent: true });
  await settle();
  assert.deepEqual(queued(room), ["claude*", "codex*"], "claude가 바쁘니 단위 전체가 대기");
  assert.equal(calls.length, 1);
  room.sendUserMessage("@codex 이거만");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"], "codex는 비어 있으니 즉시 시작");
  assert.deepEqual(queued(room), ["claude*"]);
  calls[0].finish();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude"]);
  assert.doesNotMatch(calls[2].prompt, /동시에 실행되고 있습니다/, "크기 1이면 묶음 계약이 없다");
});

test("S23 일반 줄의 같은 담당자 대기 턴이 있으면 메시지 전체가 일반이고, 새 묶음은 붙어서 가장 앞선 걷어낸 자리에 들어간다", async () => {
  const { room } = makeRoom({ ids: ["hold", "claude", "codex", "agy", "gemini"] });
  room.scheduleResponse(room.agents[0]);
  await settle();
  room.setAgents(room.agents.map((agent) => (agent.id === "hold" ? { ...agent, enabled: false } : agent)));
  room.scheduleResponse(room.agents[3], { turnRootId: "r-agy" });
  room.scheduleResponse(room.agents[1], { turnRootId: "r-claude" });
  room.scheduleResponse(room.agents[4], { turnRootId: "r-gemini" });
  room.scheduleResponse(room.agents[2], { turnRootId: "r-codex" });
  assert.deepEqual(queued(room), ["agy", "claude", "gemini", "codex"]);
  room.sendUserMessage({ text: "@claude @codex 각자", independent: true });
  assert.deepEqual(queued(room), ["agy", "claude", "codex", "gemini"], "붙어서 claude가 있던 자리에");
  const groupIds = room.turnQueue.map((item) => item.context.parallelGroupId || null);
  assert.deepEqual(groupIds, [null, groupIds[1], groupIds[1], null]);
  assert.ok(groupIds[1], "새 묶음");
  assert.ok(room.turnQueue.every((item) => item.lane !== "fast"));
});

test("S23 빠른 대기 항목과 일반 대기 항목을 함께 갈아끼우면 일반이 되고 일반 항목의 자리에 붙는다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex", "agy", "gemini"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  room.sendUserMessage("@claude 둘째");
  await settle();
  room.scheduleResponse(room.agents[2], { turnRootId: "r-agy" });
  room.scheduleResponse(room.agents[1], { turnRootId: "r-codex" });
  room.scheduleResponse(room.agents[3], { turnRootId: "r-gemini" });
  assert.deepEqual(queued(room), ["claude*", "agy", "codex", "gemini"]);
  room.sendUserMessage({ text: "@claude @codex 각자", independent: true });
  assert.deepEqual(queued(room), ["agy", "claude", "codex", "gemini"], "빠른 claude의 자리(맨 앞)가 아니라 일반 codex의 자리");
  assert.ok(room.turnQueue.every((item) => item.lane !== "fast"));
  assert.equal(calls.length, 1);
});

test("S25 중지한 프로세스가 끝나기 전에도 다른 담당자는 즉시 시작하고, 옛 프로세스의 종료는 busy를 잘못 내리지 않는다", async () => {
  const { room, calls, events } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 오래 걸리는 일");
  await settle();
  calls[0].holdCancel = true;
  room.stopAll();
  assert.deepEqual(events, [["busy", true], ["busy", false]]);
  room.sendUserMessage("@codex 안녕");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"], "codex는 즉시 시작");
  room.sendUserMessage("@claude 또");
  await settle();
  assert.equal(calls.length, 2, "취소 중인 claude 프로세스가 끝나기 전에는 같은 담당자가 시작하지 않는다");
  assert.deepEqual(queued(room), ["claude*"]);
  calls[0].endCancelled();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude"], "옛 프로세스가 끝난 그 순간 시작");
  assert.deepEqual(events, [["busy", true], ["busy", false], ["busy", true]], "옛 프로세스 종료가 busy:false를 내지 않는다");
  calls[1].finish();
  calls[2].finish();
  await settle();
  assert.deepEqual(events.at(-1), ["busy", false]);
  assert.equal(events.filter((event) => event[1] === false).length, 2);
  assert.equal(room.activeRuns, 0);
  assert.equal(room.liveRuns, 0);
});

test("대기 턴을 ×로 취소하면 막혀 있던 뒤 항목이 풀려 시작한다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 길게");
  await settle();
  room.sendUserMessage("@claude 둘째");
  await settle();
  const [fast] = room.turnState().queue;
  assert.equal(fast.fast, true);
  assert.equal(room.cancelTurn(fast.turnId), true);
  assert.deepEqual(room.turnState().queue, []);
  calls[0].finish();
  await settle();
  assert.equal(calls.length, 1, "취소한 턴은 시작하지 않는다");
  assert.equal(room.waitForIdle() instanceof Promise, true);
});

test("모든 약속은 정확히 한 번 풀리고, 방은 다 끝나면 유휴다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude a");
  room.sendUserMessage("@claude b");
  room.sendUserMessage("@codex c");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"]);
  calls[0].finish();
  await settle();
  calls[1].finish();
  calls[2].finish();
  await room.waitForIdle();
  assert.deepEqual(room.turnState(), { current: null, running: [], queue: [], deferred: [] });
  assert.equal(room.pendingTurns.size, 0);
});
