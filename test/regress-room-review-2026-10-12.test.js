"use strict";

// 2026-10-12 코드 검토에서 확인한 방(ChatRoom) 결함 네 가지의 회귀 시험.
// 첨부는 러너에 넘어간 attachments 인자로, 호출 허용 여부는 러너가 받은 프롬프트 전문으로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom } = require("./reply-now-helpers.cjs");

const file = (id) => ({ id, name: `${id}.txt`, kind: "text", mime: "text/plain", size: 3 });

function withLead(meta = {}) {
  return makeRoom({
    ids: ["claude", "codex", "agy"],
    meta: { orchestrator: { enabled: true, leadId: "claude" }, ...meta },
  });
}

test("대기 중인 턴을 세 번 이상 갈아끼워도 앞 메시지들의 첨부가 실행까지 전달된다", async () => {
  const { room, calls } = makeRoom({ ids: ["claude", "codex"] });
  const [a, b, c] = [file("a"), file("b"), file("c")];
  room.sendUserMessage("@claude 먼저 이것부터");
  await settle();
  assert.equal(calls.length, 1, "claude가 일하는 중이라 뒤따르는 메시지는 대기 턴이 된다");
  room.sendUserMessage({ text: "@claude 요청 1", attachments: [a] });
  room.sendUserMessage({ text: "@claude 요청 2", attachments: [b] });
  room.sendUserMessage({ text: "@claude 요청 3", attachments: [c] });
  const waiting = room.turnQueue.filter((item) => item.agent.id === "claude");
  assert.equal(waiting.length, 1, "대기 턴은 마지막 메시지 기준 하나로 갈아끼워진다");
  assert.deepEqual(waiting[0].context.attachments, [a, b, c]);
  calls[0].finish("완료");
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].attachments, [a, b, c], "첫 메시지의 첨부까지 실행에 실려야 한다");
});

test("오케스트레이션 중 보류된 메시지의 첨부가 지휘 AI 회신 턴과 이후 라운드·작업자 턴에 실제로 실린다", async () => {
  const { room, calls } = withLead();
  const spec = file("spec");
  const extra = file("extra");
  const shot = { id: "shot", name: "shot.png", kind: "image", mime: "image/png", size: 3 };
  room.sendUserMessage({ text: "claude에게 맡겨줘", attachments: [spec] });
  await settle();
  calls[0].finish("@codex 맡아줘");
  await settle();
  // 작업자가 도는 동안 사용자가 파일을 덧붙여 보낸다(보류 메시지가 된다).
  room.sendUserMessage({ text: "이 파일도 참고해", attachments: [extra] });
  room.sendUserMessage({ text: "", attachments: [shot] });
  await settle();
  calls[1].finish("codex 완료");
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].agentId, "claude");
  assert.deepEqual(calls[2].attachments, [spec, extra, shot], "보류 메시지의 파일이 안내 줄만이 아니라 실제로 지휘 AI에게 실려야 한다");
  calls[2].finish("@agy 이어서 맡아줘");
  await settle();
  assert.equal(calls[3].agentId, "agy");
  assert.deepEqual(calls[3].attachments, [spec, extra, shot], "지휘 AI가 받은 파일은 그 라운드의 작업자에게도 실려야 한다");
  calls[3].finish("agy 완료");
  await settle();
  assert.equal(calls[4].agentId, "claude");
  assert.deepEqual(calls[4].attachments, [spec, extra, shot], "보류 목록은 비워졌어도 이후 라운드에 파일이 계속 실려야 한다");
});

test("'AI끼리 계속 부르기'를 켜면 연쇄 깊이 상한에 닿은 턴의 프롬프트도 호출을 허용한다", async () => {
  const promptAtDepthTwo = async (keepCalling) => {
    const { room, calls } = makeRoom({ meta: { keepCalling } });
    room.sendUserMessage("@claude 시작해");
    await settle();
    calls[0].finish("@codex 이어서 봐줘"); // 깊이 0 -> 1
    await settle();
    calls[1].finish("@agy 이어서 봐줘"); // 깊이 1 -> 2: 꺼져 있으면 호출 상한(2)에 닿는 턴
    await settle();
    assert.equal(calls[2].agentId, "agy");
    return calls[2].prompt;
  };
  const on = await promptAtDepthTwo(true);
  assert.doesNotMatch(on, /추가 호출할 수 없습니다/);
  assert.match(on, /다른 참가자를 호출하려면 @이름/);
  const off = await promptAtDepthTwo(false);
  assert.match(off, /추가 호출할 수 없습니다/, "꺼져 있으면 지금처럼 상한 턴에서 호출을 막는다");
});

test("keepCalling을 켜도 토론 턴과 작업자 턴은 다른 참가자를 호출할 수 없다", async () => {
  const discussion = makeRoom({ ids: ["claude", "codex"], meta: { keepCalling: true } });
  const started = discussion.room.startDiscussion({ agentIds: ["claude", "codex"], turnBudget: 4 });
  await settle();
  assert.match(discussion.calls[0].prompt, /추가 호출할 수 없습니다/);
  discussion.calls[0].finish("의견입니다.\n[[CODEPET_DISCUSSION:CONCLUDE]]");
  await started;

  const { room, calls } = withLead({ keepCalling: true });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex 맡아줘");
  await settle();
  assert.equal(calls[1].agentId, "codex");
  assert.match(calls[1].prompt, /추가 호출할 수 없습니다/);
});

test("일부 작업자만 쓸 수 없을 때도 그 누락이 지휘 AI의 결과 블록에 적힌다", async () => {
  const { room, calls } = withLead();
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  // 지휘 AI가 답하는 동안 agy가 비활성화된다.
  room.setAgents(room.agents.map((agent) => (agent.id === "agy" ? { ...agent, enabled: false } : agent)));
  calls[0].finish("@codex 첫째 일 @agy 둘째 일");
  await settle();
  assert.deepEqual(calls.slice(1).map((call) => call.agentId), ["codex"], "쓸 수 있는 작업자만 시작한다");
  calls[1].finish("codex 완료");
  await settle();
  assert.equal(calls[2].agentId, "claude");
  const block = calls[2].prompt.split("=== 작업자 결과(라운드 1) ===")[1].split("=== 작업자 결과 끝 ===")[0];
  assert.match(block, /\[@codex\] 완료/);
  assert.match(block, /\[@agy\] 사용할 수 없음\(비활성화되었거나 설치되지 않음\)/, "시작 전에 걸러진 작업자도 결과 블록에 있어야 한다");
  assert.equal(room.orchestration.executions, 3, "claim하지 않은 작업자는 실행 횟수에 들어가지 않는다(지휘 AI 두 번 + codex)");
});
