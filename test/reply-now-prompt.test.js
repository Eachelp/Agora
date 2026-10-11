"use strict";

// 바로 답하기가 프롬프트에 남기는 것: 시작 시점 기록(F24), 답할 메시지 줄, 동시 작업 알림·계약.
// 시나리오 번호는 docs/design/AGORA_REVISION_2026-10-11_REPLY_NOW.md §6을 따른다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");
const { settle, makeRoom, makeAgent, identityRandom, ids } = require("./reply-now-helpers.cjs");

const WRITE_CONTRACT = /동시에 일하고 있습니다/;
const NOT_YET = /그 답이 아직 없습니다/;

test("S12 쓰기 방에서 혼자 도는 턴에는 동시 작업 안내도 계약도 없다", async () => {
  const { room, calls } = makeRoom({ meta: { permissionMode: "workspace-write" } });
  room.sendUserMessage("@claude 혼자 해");
  await settle();
  assert.doesNotMatch(calls[0].prompt, WRITE_CONTRACT);
  assert.doesNotMatch(calls[0].prompt, NOT_YET);
});

for (const [mode, hasContract] of [["workspace-write", true], ["workspace-read", false], ["chat", false]]) {
  test(`S13 ${mode} 방: 다른 턴이 도는 중에 시작하는 턴은 "아직 대화에 없는 답" 줄${hasContract ? "과 쓰기 계약" : "만"} 받고, 이미 보낸 프롬프트는 그대로다`, async () => {
    const { room, calls } = makeRoom({ meta: { permissionMode: mode } });
    room.sendUserMessage("@claude 길게");
    await settle();
    const before = calls[0].prompt;
    room.sendUserMessage("@codex 파일 만들어");
    await settle();
    assert.deepEqual(ids(calls), ["claude", "codex"]);
    assert.match(calls[1].prompt, /지금 @claude가 답하는 중이라 위 대화에는 그 답이 아직 없습니다/);
    assert.equal(WRITE_CONTRACT.test(calls[1].prompt), hasContract);
    if (hasContract) assert.match(calls[1].prompt, /다른 AI\(@claude\)가 같은 작업 폴더에서/);
    assert.equal(calls[0].prompt, before);
  });
}

test("S13 도는 턴이 둘이면 담당자를 모두 적고, 같은 단위의 형제는 세지 않는다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex", "agy", "gemini"], meta: { permissionMode: "workspace-write" } });
  room.reportFolderContractBreaches = async () => {};
  room.sendUserMessage({ text: "@claude @codex 각자", independent: true });
  await settle();
  room.sendUserMessage("@agy 질문");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy"]);
  assert.match(calls[2].prompt, /지금 @claude, @codex가 답하는 중/);
  // 같은 패스에서 시작한 독립 발언 형제끼리는 "동시 작업"이 아니라 묶음 계약만 받는다.
  assert.doesNotMatch(calls[0].prompt, NOT_YET);
  assert.match(calls[0].prompt, /참가자 2명이 같은 작업 폴더에서 동시에 실행되고 있습니다/);
});

test("S13 같은 패스에서 시작하는 서로 다른 빠른 단위는 서로를 동시에 도는 턴으로 본다", async () => {
  const { room, calls } = makeRoom({ meta: { permissionMode: "workspace-write" } });
  room.sendUserMessage("@claude 길게");
  await settle();
  room.sendUserMessage("@claude 둘째");
  room.sendUserMessage("@codex 셋째");
  room.sendUserMessage("@agy 넷째");
  await settle();
  // codex·agy는 바로 시작했다. 앞 둘은 claude를, 그다음 시작한 agy는 claude·codex를 안다.
  assert.match(calls[1].prompt, /지금 @claude가 답하는 중/);
  assert.match(calls[2].prompt, /지금 @claude, @codex가 답하는 중/);
});

test("S14 승인 카드를 기다리는 담당자도 돌고 있는 턴이다: 다른 담당자는 시작하며 계약을 받고, 같은 담당자는 기다린다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: [makeAgent("claude"), makeAgent("codex")],
    meta: { permissionMode: "workspace-write" },
    random: identityRandom,
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      const needs = agent.id === "claude" && calls.filter((call) => call.agentId === "claude").length === 1;
      return {
        promise: needs
          ? Promise.resolve({ ok: false, approvalRequired: true, approval: { summary: "쓰기 권한" } })
          : new Promise(() => {}),
        cancel() {},
      };
    },
  });
  room.sendUserMessage("@claude 고쳐 줘");
  await settle();
  assert.equal(room.pendingApprovals.size, 1);
  room.sendUserMessage("@codex 이건 다른 일");
  room.sendUserMessage("@claude 또");
  await settle();
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  assert.match(calls[1].prompt, WRITE_CONTRACT);
  assert.match(calls[1].prompt, /@claude/);
  assert.deepEqual(room.turnState().queue.map((entry) => `${entry.agentId}${entry.fast ? "*" : ""}`), ["claude*"]);
  room.stopAll();
  await settle();
  assert.equal(room.pendingApprovals.size, 0);
  assert.deepEqual(room.turnState().queue, []);
});

test("S16(F24) 독립 발언 모드에서 앞 질문의 답이 늦게 끝나도 다음 독립 발언 단위는 그 답을 읽는다(형제 답은 서로 안 본다)", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage({ text: "@claude 계획 써줘", independent: true });
  await settle();
  room.sendUserMessage({ text: "@claude @codex 위 계획을 각자 검토해", independent: true });
  await settle();
  assert.equal(calls.length, 1, "claude가 바빴으니 단위 전체가 기다린다");
  calls[0].finish("계획: 가나다 라마바");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "claude", "codex"]);
  for (const call of calls.slice(1)) assert.match(call.prompt, /계획: 가나다 라마바/);
  calls[1].finish("클로드 검토 의견");
  await settle();
  // codex 프롬프트는 이미 만들어졌고, 다시 만들어도(질문 도구를 못 붙인 경우) 형제 답은 들어가지 않는다.
  assert.doesNotMatch(calls[2].prompt, /클로드 검토 의견/);
  const root = room.messages.find((message) => message.text.startsWith("@claude @codex")).id;
  const rebuilt = room.promptMessages(room.messages.length, true, root);
  assert.ok(rebuilt.some((message) => message.text === "계획: 가나다 라마바"), "앞 질문의 답은 본다");
  assert.ok(rebuilt.every((message) => !(message.turnRootId === root && message.authorType === "agent")), "형제 답은 뺀다");
});

test("S16 이어 발언 모드의 예약 시점 기록은 그대로다(같은 뿌리의 뒤 메시지만 더 본다)", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@all 질문");
  await settle();
  calls[0].finish("클로드 의견");
  await settle();
  assert.match(calls[1].prompt, /클로드 의견/);
  assert.match(calls[1].prompt, /아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요/);
  assert.match(calls[1].prompt, /한 번에 한 명만 발언합니다/);
  assert.doesNotMatch(calls[1].prompt, /이번에 답할 메시지는/);
});

test("S26 빠른 턴의 답할 메시지 뒤에 다른 답이 끝나 들어와 있으면 프롬프트가 답할 메시지를 직접 가리키고 '마지막 메시지에 이어'·'한 번에 한 명만' 줄이 없다", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@all 질문");
  await settle();
  room.sendUserMessage("@claude   이건\n이렇게 해 줘"); // claude가 아직 도는 중: 빠른 턴이 기다린다
  await settle();
  calls[0].finish("클로드 답"); // 답할 메시지 뒤에 claude 자신의 답이 들어온다
  await settle();
  const fast = calls.find((call, index) => index >= 1 && call.agentId === "claude");
  assert.ok(fast, "빠른 claude가 시작했다");
  assert.match(fast.prompt, /이번에 답할 메시지는 사용자의 "@claude 이건 이렇게 해 줘"입니다/);
  assert.match(fast.prompt, /마지막 메시지가 아닐 수 있고/);
  assert.doesNotMatch(fast.prompt, /아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요/);
  assert.doesNotMatch(fast.prompt, /한 번에 한 명만 발언합니다/);
  assert.match(fast.prompt, /답을 마치면 사용자에게 결정을 넘기거나/);
  assert.match(fast.prompt, /클로드 답/, "시작 시점에 끝난 답을 본다");
});

test("S26 답할 메시지가 기록의 마지막이면(아무도 안 도는 방의 직접 답장) 프롬프트는 예전과 한 글자도 다르지 않다", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude 안녕");
  await settle();
  assert.doesNotMatch(calls[0].prompt, /이번에 답할 메시지는/);
  assert.match(calls[0].prompt, /아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요/);
  assert.match(calls[0].prompt, /한 번에 한 명만 발언합니다/);
  assert.doesNotMatch(calls[0].prompt, /그 답이 아직 없습니다|동시에 일하고 있습니다/);
});

test("S26 다른 턴이 함께 도는 빠른 턴은 '한 번에 한 명만 발언합니다'를 뺀다(답할 메시지가 마지막이어도)", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude 오래 걸리는 일");
  await settle();
  room.sendUserMessage("@codex 안녕");
  await settle();
  assert.equal(calls[1].agentId, "codex");
  assert.doesNotMatch(calls[1].prompt, /이번에 답할 메시지는/);
  assert.match(calls[1].prompt, /아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요/);
  assert.doesNotMatch(calls[1].prompt, /한 번에 한 명만 발언합니다/);
  assert.match(calls[1].prompt, /지금 @claude가 답하는 중이라 위 대화에는 그 답이 아직 없습니다/);
});

test("S26 replyTarget은 400자까지만 쓰고, 독립 발언 단위의 모든 구성원에게 붙는다", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude 앞 질문");
  await settle();
  room.sendUserMessage({ text: `@claude @codex ${"가".repeat(500)}`, independent: true }); // claude가 바빠 단위 전체가 기다린다
  await settle();
  calls[0].finish("앞 답");
  await settle();
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) {
    const quoted = /사용자의 "([^"]*)"/.exec(call.prompt)[1];
    assert.equal(quoted.length, 400);
  }
});

test("S26 일반 줄의 이어 발언·멘션 호출·토론의 프롬프트는 replyTarget 없이 지금과 한 글자도 다르지 않다", async () => {
  const input = {
    agent: makeAgent("claude"),
    agents: [makeAgent("claude"), makeAgent("codex")],
    messages: [{ id: "m1", authorType: "user", author: "user", text: "안녕" }],
  };
  const plain = buildAgentPrompt(input);
  assert.equal(buildAgentPrompt({ ...input, replyTarget: null, concurrentWork: [] }), plain);
  assert.match(plain, /아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요/);
  assert.match(plain, /한 번에 한 명만 발언합니다/);
  const withTarget = buildAgentPrompt({ ...input, replyTarget: "안녕" });
  assert.notEqual(withTarget, plain);
  // 토론·결론 종합·쉽게 설명에는 동시 작업 줄이 붙지 않는다.
  const discussion = buildAgentPrompt({ ...input, discussion: { turn: 1, maxTurns: 3 }, concurrentWork: ["codex"], permissionMode: "workspace-write" });
  assert.doesNotMatch(discussion, /동시에 일하고 있습니다|그 답이 아직 없습니다/);
});
