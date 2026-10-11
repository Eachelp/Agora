"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasGroupMention, parseMentions } = require("../src/chat/chat-mention");
const { GROUP_ALIASES } = require("../src/chat/chat-agents");
const { ChatRoom } = require("../src/chat/chat-room");
const { makeAgent } = require("./reply-now-helpers.cjs");

test("hasGroupMention은 그룹 별칭이 호출로 들어 있을 때만 참이다", () => {
  for (const text of ["@all 안녕", "@모두 봐줘", "@전원에게", "@everyone", "@얘들아 모여", "@claude @all 같이", "앞 @모두야"]) {
    assert.equal(hasGroupMention(text, GROUP_ALIASES), true, text);
  }
  for (const text of ["@claude 안녕", "@claude @codex 둘", "멘션 없음", "메일 a@all.com", "`@all` 은 코드", "```\n@모두\n```", "@allergy", "@모두X"]) {
    assert.equal(hasGroupMention(text, GROUP_ALIASES), false, text);
  }
  assert.equal(hasGroupMention("@all", []), false);
});

test("이름으로 부른 에이전트(그룹 별칭 제외)와 그룹 별칭을 따로 읽는다", () => {
  const agents = [makeAgent("claude"), makeAgent("codex")];
  assert.deepEqual(parseMentions("@all 안녕", agents), []);
  assert.deepEqual(parseMentions("@all @claude", agents), ["claude"]);
  assert.deepEqual(parseMentions("@all @claude", agents, GROUP_ALIASES), ["claude", "codex"]);
});

test("바로 답하기 자격: 그룹 별칭이 섞인 메시지와 이어 발언 둘 이상은 빠른 줄에 서지 않는다", () => {
  const room = new ChatRoom({ agents: [makeAgent("claude"), makeAgent("codex"), makeAgent("agy")] });
  const order = (...ids) => ids.map((id) => room.findAgent(id));
  assert.equal(room.isFastEligible("@claude 질문", order("claude"), false), true);
  assert.equal(room.isFastEligible("@claude @codex 각자", order("claude", "codex"), true), true);
  assert.equal(room.isFastEligible("@claude @codex 이어서", order("claude", "codex"), false), false);
  assert.equal(room.isFastEligible("@all @claude", order("claude"), false), false);
  assert.equal(room.isFastEligible("멘션 없음", order("claude"), false), false);
  room.discussionRequested = true;
  assert.equal(room.isFastEligible("@claude 질문", order("claude"), false), false);
  room.discussionRequested = false;
  room.discussionActive = true;
  assert.equal(room.isFastEligible("@claude 질문", order("claude"), false), false);
});
