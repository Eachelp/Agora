"use strict";

// 지휘 AI·작업자 역할 문단(설계 §(11)). orchestration이 없으면 보통 턴과 글자 하나 다르지 않아야 한다
// (reply-now-prompt-matrix.test.js가 이미 그 바이트 동일성을 지킨다 — 여기서는 역할 문단 자체를 본다).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

const agent = (id) => ({ id, name: id.toUpperCase(), aliases: [id], available: true, enabled: true });
const AGENTS = ["claude", "codex", "agy"].map(agent);
const MESSAGES = [{ id: "m1", authorType: "user", author: "user", text: "맡겨줘" }];

function basePrompt(orchestration) {
  return buildAgentPrompt({
    agent: agent(orchestration?.role === "worker" ? "codex" : "claude"),
    agents: AGENTS,
    messages: MESSAGES,
    permissionMode: "chat",
    mentionsEnabled: orchestration?.role === "lead",
    orchestration,
  });
}

test("orchestration이 없으면 보통 '그룹 채팅 참가자' 문단이 그대로 나온다", () => {
  const prompt = basePrompt(null);
  assert.match(prompt, /그룹 채팅의 참가자 "@claude"/);
  assert.doesNotMatch(prompt, /지휘 AI/);
});

test("지휘 AI 역할 문단: 참가자 목록·위임 방법·결과 회신·종료 방법을 안내하고 호출 상한 문구가 없다", () => {
  const prompt = basePrompt({ role: "lead", leadId: "claude" });
  assert.match(prompt, /당신은 @claude, 이 방의 지휘 AI입니다/);
  assert.match(prompt, /@codex, @agy/);
  assert.match(prompt, /같이 시작합니다/);
  assert.match(prompt, /그 사람 혼자 보고 끝낼 수 있게 분명하게/);
  assert.match(prompt, /다음 당신의 차례에 자동으로 모여서 옵니다/);
  assert.match(prompt, /@ 없이\*\* 사용자에게 바로 답하세요/);
  assert.doesNotMatch(prompt, /호출은 꼭 필요할 때만 하세요/, "지휘 AI에겐 호출 상한 문구가 없다");
  assert.doesNotMatch(prompt, /여러 AI 코딩 에이전트가 사용자와 함께 있는 그룹 채팅의 참가자/);
  assert.doesNotMatch(prompt, /코딩/, "중립화: '코딩' 표현을 쓰지 않는다");
});

test("작업자 역할 문단: 다른 참가자를 못 부르고, 지휘 AI에게 전달됨을 안내하며, ASK_USER 두 줄이 작업자용으로 바뀐다", () => {
  const prompt = basePrompt({ role: "worker", leadId: "claude" });
  assert.match(prompt, /당신은 @codex, 지휘 AI @claude가 이번 라운드에 맡긴 일 하나를 처리합니다/);
  assert.match(prompt, /다른 참가자를 부르거나 사용자에게 직접 묻지 마세요/);
  assert.match(prompt, /당신의 답이 그대로 지휘 AI에게 전달됩니다/);
  assert.match(prompt, /\*\*지휘 AI의 판단\*\*이 꼭 필요할 때만/);
  assert.match(prompt, /지휘 AI에게 전달되어 다음 회신 턴에서 판단됩니다/);
  assert.doesNotMatch(prompt, /사용자의 결정이 꼭 필요할 때만/, "보통 문구는 작업자에게 안 남는다");
  assert.doesNotMatch(prompt, /'답변 대기' 표시와 선택 버튼으로 바뀝니다/, "보통 문구는 작업자에게 안 남는다");
  assert.doesNotMatch(prompt, /코딩/);
});

test("작업자는 mentionsEnabled=false라 '이번 턴에는 다른 참가자를 추가 호출할 수 없습니다' 문구가 그대로 붙는다", () => {
  const prompt = basePrompt({ role: "worker", leadId: "claude" });
  assert.match(prompt, /이번 턴에는 다른 참가자를 추가 호출할 수 없습니다/);
});

test("extraLines(작업자 결과·보류 메시지 블록)는 대화 블록 뒤, 맨 끝 문장 앞에 그대로 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: agent("claude"),
    agents: AGENTS,
    messages: MESSAGES,
    permissionMode: "chat",
    orchestration: { role: "lead", leadId: "claude" },
    mentionsEnabled: true,
    extraLines: ["=== 작업자 결과(라운드 1) ===\n[@codex] 완료\n끝\n---\n=== 작업자 결과 끝 ==="],
  });
  assert.match(prompt, /=== 대화 끝 ===\n=== 작업자 결과\(라운드 1\) ===/);
  assert.match(prompt, /지금 "@claude"로서 답할 차례입니다\.$/);
});
