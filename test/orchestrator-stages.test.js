"use strict";

// 오케스트레이터 개선(2026-10-20): 보고 보존, 단계 실행, 제어 줄, 자동 재촉.
// 설계: docs/design/AGORA_REVISION_2026-10-20_ORCHESTRATOR_STAGES.md. 러너는 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom, makeAgent, ids } = require("./reply-now-helpers.cjs");

function withLead(options = {}) {
  return makeRoom({
    ids: ["claude", "codex", "agy"],
    meta: { orchestrator: { enabled: true, leadId: "claude" }, ...(options.meta || {}) },
    ...options,
  });
}

async function startRound(room, calls, leadReply) {
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish(leadReply);
  await settle();
}

test("보고 보존: 실패한 작업자가 실패 전에 받은 응답(partialText)도 결과 블록에 들어간다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "@agy 문서를 현행화해 줘");
  calls[1].fail("API error (attempt 1): INTERNAL (code 500)", { partialText: "문서 8건을 현행화했습니다. 자체검수 완료." });
  await settle();
  assert.match(calls[2].prompt, /\[@agy\] 실패/);
  assert.match(calls[2].prompt, /INTERNAL \(code 500\)/);
  assert.match(calls[2].prompt, /실패 전까지 받은 응답/);
  assert.match(calls[2].prompt, /문서 8건을 현행화했습니다/);
});

test("보고 보존: 작업자 보고는 6000자까지 그대로 싣고, 넘으면 전체 글자 수와 함께 자른다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "@codex 검수해 줘");
  calls[1].finish("가".repeat(5900) + "끝");
  await settle();
  assert.ok(calls[2].prompt.includes("가".repeat(5900) + "끝"), "6000자 이하 보고는 잘리지 않는다");

  const second = withLead();
  await startRound(second.room, second.calls, "@codex 검수해 줘");
  second.calls[1].finish("나".repeat(6500));
  await settle();
  assert.ok(second.calls[2].prompt.includes("나".repeat(6000) + "…(생략, 전체 6500자)"));
  // 같은 보고 원문은 대화 기록에도 남으므로, 결과 블록 안에서만 잘린다.
  const block = second.calls[2].prompt.split("=== 작업자 결과(라운드 1) ===")[1].split("=== 작업자 결과 끝 ===")[0];
  assert.ok(!block.includes("나".repeat(6001)));
  assert.deepEqual(ids(second.calls), ["claude", "codex", "claude"]);
});

// ─── 제어 줄 해석 ───────────────────────────────────────────────

const { parseOrchestrationControl, parseControlOutput } = require("../src/chat/control-output");
const { resolveStageTargets } = require("../src/chat/chat-mention");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

test("제어 줄: 여러 줄 STAGE와 DONE을 읽고, 그 줄만 본문에서 뺀다(사이의 빈 줄 허용)", () => {
  const parsed = parseOrchestrationControl("구현을 먼저 하고 검수합니다.\n\nSTAGE: @claude @agy\n\nSTAGE: @codex\n");
  assert.deepEqual(parsed.stages, ["@claude @agy", "@codex"]);
  assert.equal(parsed.done, false);
  assert.equal(parsed.text, "구현을 먼저 하고 검수합니다.");
  const done = parseOrchestrationControl("모두 끝났습니다.\nDONE");
  assert.equal(done.done, true);
  assert.equal(done.text, "모두 끝났습니다.");
});

test("제어 줄: 코드펜스 안의 예시와 본문 중간의 STAGE는 제어가 아니다", () => {
  const fenced = "예시입니다.\n\x60\x60\x60\nSTAGE: @codex\nDONE\n\x60\x60\x60\n";
  assert.deepEqual(parseOrchestrationControl(fenced), { stages: [], done: false, text: fenced });
  const middle = "STAGE: @codex\n그리고 이어지는 설명입니다.";
  assert.deepEqual(parseOrchestrationControl(middle), { stages: [], done: false, text: middle });
  assert.deepEqual(parseOrchestrationControl("DONE the task 라는 문장은 산문이다"), { stages: [], done: false, text: "DONE the task 라는 문장은 산문이다" });
});

test("제어 줄: STAGE 뒤에 ASK_USER가 오면 STAGE만 빼고 ASK_USER는 기존 해석기가 읽는다", () => {
  const parsed = parseOrchestrationControl("본문\nSTAGE: @agy\nASK_USER: 이대로 진행할까요?");
  assert.deepEqual(parsed.stages, ["@agy"]);
  assert.equal(parsed.text, "본문\nASK_USER: 이대로 진행할까요?");
  assert.equal(parseControlOutput(parsed.text).action, "ASK_USER");
});

test("제어 줄: 기존 parseControlOutput은 STAGE·DONE을 제어로 읽지 않는다", () => {
  assert.equal(parseControlOutput("본문\nSTAGE: @agy"), null);
  assert.equal(parseControlOutput("본문\nDONE"), null);
});

test("STAGE 줄의 참가자: 별칭·조사·이름만 쓴 줄을 읽고, 모르는 이름과 그룹 별칭은 unknown으로 돌려준다", () => {
  const agents = [makeAgent("claude"), makeAgent("codex", { aliases: ["gpt", "codex"] }), makeAgent("agy", { aliases: ["gemini", "agy"] })];
  assert.deepEqual(resolveStageTargets("@gemini @gpt야 @claude", agents), { ids: ["agy", "codex", "claude"], unknown: [] });
  assert.deepEqual(resolveStageTargets("claude, gemini", agents), { ids: ["claude", "agy"], unknown: [] });
  assert.deepEqual(resolveStageTargets("@nobody @codex @codex", agents), { ids: ["codex"], unknown: ["nobody"] });
  assert.deepEqual(resolveStageTargets("@all", agents), { ids: [], unknown: ["all"] });
});

// ─── 단계 실행 ───────────────────────────────────────────────

const visibleText = (room, author) => room.messages.filter((message) => message.author === author).map((message) => message.text);

test("단계 실행: 앞 단계가 모두 끝나야 다음 단계가 시작되고, 다음 단계는 앞 단계 결과를 받는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "구현과 검수를 차례로 진행합니다.\nSTAGE: @agy\nSTAGE: @codex");
  assert.deepEqual(ids(calls), ["claude", "agy"], "1단계만 시작한다");
  assert.deepEqual(room.state().orchestration.stage, { index: 1, total: 2, agentIds: ["agy"] });
  calls[1].finish("agy 구현 보고");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "codex"], "1단계가 끝나자 2단계가 시작된다");
  assert.deepEqual(room.state().orchestration.stage, { index: 2, total: 2, agentIds: ["codex"] });
  assert.match(calls[2].prompt, /=== 앞 단계 결과\(라운드 1\) ===/);
  assert.match(calls[2].prompt, /\[1단계\]\n\[@agy\] 완료\nagy 구현 보고/);
  assert.match(calls[2].prompt, /당신은 2\/2단계입니다/);
  assert.doesNotMatch(calls[1].prompt, /앞 단계 결과/, "1단계는 받을 앞 단계가 없다");
  calls[2].finish("codex 검수 보고");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "codex", "claude"], "마지막 단계가 끝나면 지휘 AI 회신이 한 번 열린다");
  assert.equal(room.orchestration.round, 2);
  assert.equal(room.state().orchestration.stage, null);
  const block = calls[3].prompt.split("=== 작업자 결과(라운드 1) ===")[1].split("=== 작업자 결과 끝 ===")[0];
  assert.match(block, /\[1단계\]\n\[@agy\] 완료\nagy 구현 보고\n---\n\[2단계\]\n\[@codex\] 완료\ncodex 검수 보고\n---/);
  assert.deepEqual(visibleText(room, "claude"), ["구현과 검수를 차례로 진행합니다."], "STAGE 줄은 화면 텍스트에서 빠진다");
});

test("단계 실행: 같은 단계의 참가자는 동시에 시작한다", async () => {
  const { room, calls } = withLead({ ids: ["claude", "codex", "agy", "docs"] });
  await startRound(room, calls, "STAGE: @codex @agy\nSTAGE: @docs");
  assert.deepEqual(ids(calls).slice(1).sort(), ["agy", "codex"]);
  calls[1].finish("하나 끝");
  await settle();
  assert.equal(calls.length, 3, "같은 단계의 나머지가 끝나기 전에는 다음 단계가 시작되지 않는다");
  calls[2].finish("둘 끝");
  await settle();
  assert.equal(ids(calls)[3], "docs");
});

test("단계 실행: 다음 단계에는 보고를 40000자까지 그대로 넘기고, 지휘 AI에게는 6000자까지만 싣는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  calls[1].finish("가".repeat(7000));
  await settle();
  assert.ok(calls[2].prompt.includes("가".repeat(7000)), "검수자는 보고를 온전히 받는다");
  assert.ok(!calls[2].prompt.includes("…(생략"), "40000자 아래는 잘리지 않는다");
  calls[2].finish("검수 끝");
  await settle();
  const block = calls[3].prompt.split("=== 작업자 결과(라운드 1) ===")[1].split("=== 작업자 결과 끝 ===")[0];
  assert.ok(block.includes("가".repeat(6000) + "…(생략, 전체 7000자)"));
  assert.ok(!block.includes("가".repeat(6001)));
});

test("단계 실행: 한 단계의 일부만 실패하면 다음 단계를 계속한다", async () => {
  const { room, calls } = withLead({ ids: ["claude", "codex", "agy", "docs"] });
  await startRound(room, calls, "STAGE: @codex @agy\nSTAGE: @docs");
  calls[1].fail("TIMED_OUT");
  calls[2].finish("agy 완료");
  await settle();
  assert.equal(ids(calls)[3], "docs", "한 명이 성공했으므로 2단계가 이어진다");
  assert.match(calls[3].prompt, /\[@codex\] 실패\(/);
});

test("단계 실행: 단계의 참가자가 모두 실패하면 남은 단계를 건너뛰고 지휘 AI에게 돌아간다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  calls[1].fail("API error", { partialText: "받아 둔 본문" });
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "claude"], "codex 2단계는 시작하지 않는다");
  assert.match(calls[2].prompt, /\[1단계\]\n\[@agy\] 실패/);
  assert.match(calls[2].prompt, /받아 둔 본문/);
  assert.match(calls[2].prompt, /\[2단계\]\n\[@codex\] 건너뜀\(앞 단계가 모두 실패했거나 쓸 수 없어\)/);
});

test("단계 실행: 참가자가 질문(ASK_USER)을 남기면 남은 단계를 건너뛰고 질문이 지휘 AI에게 간다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  calls[1].finish("ASK_USER: 이대로 구현할까요?");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "claude"]);
  assert.match(calls[2].prompt, /\[@agy\] 질문 있음: 이대로 구현할까요\?/);
  assert.match(calls[2].prompt, /\[@codex\] 건너뜀\(앞 단계에서 질문이 나와\)/);
});

test("단계 실행: 쓸 수 없는(비활성) 참가자뿐인 단계는 시작하지 않고 결과에 '사용할 수 없음'으로 적는다", async () => {
  const { room, calls } = withLead({ agents: [makeAgent("claude"), makeAgent("codex"), makeAgent("agy", { enabled: false })] });
  await startRound(room, calls, "STAGE: @agy");
  assert.deepEqual(ids(calls), ["claude", "claude"], "agy는 시작하지 않고 곧바로 지휘 AI 회신이 열린다");
  assert.match(calls[1].prompt, /\[@agy\] 사용할 수 없음/);
});

test("단계 실행: 중복·단계 수 초과·알 수 없는 이름·지휘 AI 자신은 빼고 한 줄로 알린다", async () => {
  const { room, calls, systems } = withLead({ ids: ["claude", "alpha", "bravo", "charlie", "delta", "echo"] });
  await startRound(room, calls, "STAGE: @alpha @nobody @claude\nSTAGE: @alpha @bravo\nSTAGE: @charlie\nSTAGE: @delta\nSTAGE: @echo");
  assert.deepEqual(ids(calls), ["claude", "alpha"]);
  const note = systems.find((line) => line.startsWith("STAGE 줄에서 일부를 뺐습니다"));
  assert.ok(note, "안내가 한 줄 나온다");
  for (const part of ["⟦nobody⟧", "지휘 AI @claude 자신", "중복 @alpha", "4단계를 넘은 줄(@echo)"]) assert.ok(note.includes(part), part);
  assert.equal(room.orchestration.plan.stages.length, 4);
});

test("단계 실행: STAGE 줄에서 맡길 참가자를 하나도 못 찾으면 안내하고 끝낸다", async () => {
  const { room, calls, systems } = withLead();
  await startRound(room, calls, "STAGE: @nobody");
  assert.equal(room.orchestration, null);
  assert.ok(systems.some((line) => line.includes("맡길 수 있는 참가자를 찾지 못해")));
});

test("단계 실행: STAGE가 있으면 함께 쓴 ASK_USER는 버려지고, 본문의 @멘션은 단계에 영향을 주지 않는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "@codex 도 보고 있어요.\nSTAGE: @agy\nASK_USER: 이대로 갈까요?");
  assert.deepEqual(ids(calls), ["claude", "agy"], "STAGE 줄에 적힌 agy만 시작한다");
  assert.equal(room.awaitingUsers.has("claude"), false);
});

test("DONE: 오케스트레이션을 끝내고 DONE 줄은 화면에서 빠지며, 본문의 @멘션은 호출되지 않는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "@codex 가 말한 대로 정리했습니다.\nDONE");
  assert.equal(room.orchestration, null);
  assert.deepEqual(ids(calls), ["claude"]);
  assert.deepEqual(visibleText(room, "claude"), ["@codex 가 말한 대로 정리했습니다."]);
});

test("DONE만 쓴 답도 빈 말풍선으로 남지 않는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "DONE");
  assert.deepEqual(visibleText(room, "claude"), ["(완료)"]);
  assert.equal(room.orchestration, null);
});

// ─── 자동 재촉 ───────────────────────────────────────────────

async function toRoundTwo(room, calls) {
  await startRound(room, calls, "STAGE: @agy");
  calls[1].finish("agy 완료");
  await settle();
  assert.equal(room.orchestration.round, 2);
}

test("재촉: 작업 결과를 받은 라운드(2+)에서 STAGE·DONE·질문·멘션이 모두 없으면 한 번 더 묻는다", async () => {
  const { room, calls } = withLead();
  await toRoundTwo(room, calls);
  calls[2].finish("모두 끝났습니다.");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy", "claude", "claude"], "재촉 차례가 열린다");
  assert.equal(room.orchestration.round, 3, "재촉 차례도 라운드에 들어간다");
  assert.match(calls[3].prompt, /=== 지휘 차례 안내 ===/);
  assert.match(calls[3].prompt, /=== 작업자 결과\(라운드 1\) ===[\s\S]*\[@agy\] 완료/, "앞 라운드의 결과 블록을 다시 싣는다");
  calls[3].finish("DONE");
  await settle();
  assert.equal(room.orchestration, null);
});

test("재촉: 재촉한 답에도 표시가 없으면 안내하고 멈춘다(연속 한 번까지)", async () => {
  const { room, calls, systems } = withLead();
  await toRoundTwo(room, calls);
  calls[2].finish("끝");
  await settle();
  calls[3].finish("정말 끝");
  await settle();
  assert.equal(room.orchestration, null);
  assert.equal(calls.length, 4, "더 재촉하지 않는다");
  assert.ok(systems.some((line) => line.startsWith("지휘 AI가 다음 단계나 완료를 표시하지 않아 멈췄습니다")));
});

test("재촉: 재촉에 STAGE로 답하면 계속 진행하고, 그 뒤 다시 표시를 빠뜨리면 또 한 번 재촉할 수 있다", async () => {
  const { room, calls } = withLead();
  await toRoundTwo(room, calls);
  calls[2].finish("끝");
  await settle();
  calls[3].finish("STAGE: @codex");
  await settle();
  assert.equal(ids(calls)[4], "codex");
  calls[4].finish("codex 완료");
  await settle();
  calls[5].finish("또 표시 없음");
  await settle();
  assert.equal(calls.length, 7, "새 재촉이 열린다");
  assert.ok(room.orchestration);
});

test("재촉: 첫 라운드의 표시 없는 답은 지금처럼 최종 답이다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "그냥 답합니다.");
  assert.equal(room.orchestration, null);
  assert.equal(calls.length, 1);
});

test("재촉: 질문(ASK_USER)이나 옛 @멘션 호출은 표시로 인정한다", async () => {
  const asking = withLead();
  await toRoundTwo(asking.room, asking.calls);
  asking.calls[2].finish("ASK_USER: 다음엔 어떻게 할까요?");
  await settle();
  assert.equal(asking.calls.length, 3);
  assert.equal(asking.room.awaitingUsers.has("claude"), true);

  const mention = withLead();
  await toRoundTwo(mention.room, mention.calls);
  mention.calls[2].finish("@codex 이어서 해줘");
  await settle();
  assert.equal(mention.calls[3].agentId, "codex", "옛 방식의 멘션은 한 단계로 시작된다");
});

// ─── 안전선과 정리 ───────────────────────────────────────────────

test("안전선: 다음 단계를 시작하기 전에 실행 횟수를 확인한다", async () => {
  const { room, calls, systems } = withLead({ executionCeiling: 2 });
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  calls[1].finish("agy 완료");
  await settle();
  assert.equal(calls.length, 2, "2단계는 시작하지 않는다");
  assert.equal(room.orchestration, null);
  assert.ok(systems.some((line) => line.includes("실행 횟수 안전선(2회)")));
});

test("정리: 단계 도중 중지하면 다음 단계도 지휘 AI 회신도 열리지 않는다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  calls[1].holdCancel = true;
  room.stopAll();
  await settle();
  assert.equal(room.orchestration, null);
  calls[1].endCancelled();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy"]);
});

test("정리: 단계 도중 모드를 끄면 대기 중인 다음 단계 없이 끝나고, 늦은 결과는 버려진다", async () => {
  const { room, calls } = withLead();
  await startRound(room, calls, "STAGE: @agy\nSTAGE: @codex");
  room.endOrchestration("모드를 껐습니다.");
  calls[1].finish("늦은 결과");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy"], "죽은 오케스트레이션의 다음 단계를 열지 않는다");
});

// ─── 지휘 모델·읽기 전용·자기 호출 ───────────────────────────────

const leadRoom = (leadMeta, extra = {}) => makeRoom({
  agents: [makeAgent("claude", { model: "sonnet", effort: "high", autoApprove: true }), makeAgent("codex"), makeAgent("agy")],
  meta: { orchestrator: { enabled: true, leadId: "claude", ...leadMeta }, ...(extra.meta || {}) },
});

test("지휘 모델: 지휘 차례만 leadModel·leadEffort로 돌고, 작업자 차례와 설정 변경은 다음 지휘 차례부터 반영된다", async () => {
  const { room, calls } = leadRoom({ leadModel: "opus", leadEffort: "max" });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  assert.equal(calls[0].agent.model, "opus");
  assert.equal(calls[0].agent.effort, "max");
  calls[0].finish("STAGE: @claude @agy");
  await settle();
  const selfWorker = calls.find((call, index) => index > 0 && call.agentId === "claude");
  assert.equal(selfWorker.agent.model, "sonnet", "자기 호출 작업자는 참가자의 원래 모델이다");
  assert.equal(selfWorker.agent.effort, "high");
  assert.match(selfWorker.prompt, /지휘 AI @claude\(같은 참가자의 지휘 차례\)/);
  // 진행 중에 지휘 모델을 바꾸면 다음 지휘 차례부터 적용한다(진행 중인 오케스트레이션은 끝나지 않는다).
  room.setMeta({ orchestrator: { enabled: true, leadId: "claude", leadModel: "fable", leadEffort: "low" } });
  for (const call of calls.filter((entry) => !entry.done)) call.finish("작업 완료");
  await settle();
  const nextLead = calls.filter((call) => call.agentId === "claude").at(-1);
  assert.equal(nextLead.agent.model, "fable");
  assert.equal(nextLead.agent.effort, "low");
});

test("지휘 모델: 지정하지 않으면 참가자 설정 그대로고, 지휘 AI 자신을 단계에 넣으면 빠진다", async () => {
  const { room, calls, systems } = leadRoom({});
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  assert.equal(calls[0].agent.model, "sonnet");
  assert.doesNotMatch(calls[0].prompt, /자신도 맡길 수 있습니다/);
  calls[0].finish("STAGE: @claude @agy");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "agy"]);
  assert.ok(systems.some((line) => line.includes("지휘 AI @claude 자신")));
});

test("지휘 모델: 지정한 방에서는 지휘 프롬프트가 자기 자신도 후보로 안내한다", async () => {
  const { room, calls } = leadRoom({ leadModel: "opus" });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  assert.match(calls[0].prompt, /맡기세요: @claude, @codex, @agy\./);
  assert.match(calls[0].prompt, /@claude 자신도 맡길 수 있습니다/);
});

test("읽기 전용: 쓰기 방에서 leadReadOnly를 켜면 지휘 차례만 읽기 권한(자동 승인 끔)으로 돈다", async () => {
  const { room, calls } = leadRoom({ leadReadOnly: true }, { meta: { permissionMode: "workspace-write" } });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  assert.equal(calls[0].permissionMode, "workspace-read");
  assert.equal(calls[0].autoApprove, false);
  assert.match(calls[0].prompt, /지휘 AI는 파일을 읽기만 할 수 있습니다/);
  calls[0].finish("STAGE: @codex");
  await settle();
  assert.equal(calls[1].permissionMode, "workspace-write", "작업자는 방 권한 그대로");
  calls[1].finish("완료");
  await settle();
  assert.equal(calls[2].permissionMode, "workspace-read", "다음 지휘 차례도 읽기 전용");
});

test("읽기 전용: 쓰기 방이 아니면 아무것도 바꾸지 않는다", async () => {
  const { room, calls } = leadRoom({ leadReadOnly: true }, { meta: { permissionMode: "chat" } });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  assert.equal(calls[0].permissionMode, "chat");
  assert.doesNotMatch(calls[0].prompt, /지휘 AI는 파일을 읽기만 할 수 있습니다/);
});

// ─── 프롬프트 ───────────────────────────────────────────────

test("프롬프트: 단계가 둘 이상인 라운드의 작업자는 몇 번째 단계인지 안내받고, 단계가 하나면 예전 문구 그대로다", () => {
  const agents = ["claude", "codex", "agy"].map((id) => makeAgent(id));
  const build = (stage) => buildAgentPrompt({
    agent: agents[1],
    agents,
    messages: [{ id: "m1", authorType: "user", author: "user", text: "맡겨줘" }],
    permissionMode: "chat",
    mentionsEnabled: false,
    orchestration: { role: "worker", leadId: "claude", stage },
  });
  assert.match(build({ index: 2, total: 3 }), /당신은 2\/3단계입니다\. 앞 단계 결과는 아래 '앞 단계 결과' 블록에 있습니다/);
  assert.match(build({ index: 1, total: 3 }), /당신은 1\/3단계입니다\.$/m);
  assert.doesNotMatch(build(null), /단계/);
});

