"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationWindow,
  DEFAULT_RECENT_MESSAGES,
} = require("../src/chat/chat-summary-window");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

const AGENTS = [
  { id: "claude", name: "Claude", aliases: ["claude"] },
  { id: "codex", name: "Codex", aliases: ["codex"] },
];

function message(index, text = `메시지 ${index}`) {
  return {
    id: `m${index}`,
    author: index % 2 === 0 ? "user" : "claude",
    authorType: index % 2 === 0 ? "user" : "agent",
    text,
  };
}

test("짧은 일반 대화는 압축하지 않는다", () => {
  const source = Array.from({ length: 8 }, (_, index) => message(index));
  const window = buildConversationWindow(source, { maxMessages: 40 });

  assert.equal(window.compacted, false);
  assert.equal(window.recent.length, 8);
  assert.equal(window.pinned.length, 0);
  assert.equal(window.summary.length, 0);
});

test("긴 대화는 첫 사용자 목표 + 과거 압축 + 최근 원문으로 나눈다", () => {
  const source = Array.from({ length: 50 }, (_, index) => message(index));
  const window = buildConversationWindow(source, { maxMessages: 40 });

  assert.equal(window.compacted, true);
  assert.equal(window.pinned.length, 1);
  assert.equal(window.pinned[0].id, "m0");
  assert.ok(window.summary.length > 0);
  assert.ok(window.recent.length <= DEFAULT_RECENT_MESSAGES);
  assert.equal(window.recent.at(-1).id, "m49");
  assert.equal(window.omitted, 50 - window.recent.length);
});

test("메시지 수가 적어도 과거 본문이 크면 압축한다", () => {
  const source = Array.from({ length: 10 }, (_, index) => message(index, `내용-${index}-` + "x".repeat(1800)));
  const window = buildConversationWindow(source, { maxMessages: 40 });
  assert.equal(window.compacted, true);
  assert.equal(window.recent.at(-1).id, "m9");
});

test("일반 프롬프트는 긴 대화를 고정 배경/압축 기록/최근 원문으로 렌더링한다", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    author: "user",
    authorType: "user",
    text: `메시지 ${index}`,
  }));
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages,
    maxMessages: 10,
  });

  assert.match(prompt, /\(이전 메시지 40개 생략\)/);
  assert.match(prompt, /=== 대화 고정 배경 ===/);
  assert.match(prompt, /\[User\] 메시지 0/);
  assert.match(prompt, /=== 이전 대화 압축 기록 ===/);
  assert.match(prompt, /=== 최근 대화 ===/);
  assert.doesNotMatch(prompt, /\[User\] 메시지 39\n/);
  assert.match(prompt, /\[User\] 메시지 49/);
});

test("전문 실행 프롬프트에는 일반 대화 Summary Window 마커를 넣지 않는다", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    author: "user",
    authorType: "user",
    text: `메시지 ${index}`,
  }));
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages,
    specialist: { stage: "review", round: 1, maxRounds: 1 },
  });

  assert.doesNotMatch(prompt, /대화 고정 배경/);
  assert.doesNotMatch(prompt, /이전 대화 압축 기록/);
  assert.doesNotMatch(prompt, /최근 대화/);
});
