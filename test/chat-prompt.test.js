const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

const AGENTS = [
  { id: "claude", name: "Claude", aliases: ["claude"] },
  { id: "codex", name: "Codex", aliases: ["codex"] },
];

function message(author, text, authorType = "agent") {
  return { author, authorType, text };
}

test("프롬프트에 역할, 참가자, 대화 기록이 화자 라벨과 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [
      message("user", "@codex, @claude 응답해라", "user"),
      message("claude", "안녕하세요!"),
    ],
  });

  assert.match(prompt, /참가자 "@codex"\(Codex\)/);
  assert.match(prompt, /사용자\(User\), @claude\(Claude\), @codex\(Codex\)/);
  assert.match(prompt, /\[User\] @codex, @claude 응답해라/);
  assert.match(prompt, /\[@claude\] 안녕하세요!/);
  assert.match(prompt, /지금 "@codex"로서 답할 차례입니다\./);
});

test("@멘션은 실제 호출이고 이름만 쓰면 언급이라는 규칙이 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
  });
  assert.match(prompt, /그러면 그 참가자가 이어서 답합니다/);
  assert.match(prompt, /@ 없이 이름만 쓰세요/);
  assert.doesNotMatch(prompt, /자동으로 호출되지는 않습니다/);
});

test("긴 대화는 최근 메시지만 남기고 생략 안내를 넣는다", () => {
  const messages = Array.from({ length: 50 }, (_, index) =>
    message("user", `메시지 ${index}`, "user")
  );
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages,
    maxMessages: 10,
  });

  assert.match(prompt, /\(이전 메시지 40개 생략\)/);
  assert.doesNotMatch(prompt, /\[User\] 메시지 39\n/);
  assert.match(prompt, /\[User\] 메시지 49/);
});

test("다른 참가자가 없으면 멘션 규칙을 생략한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: [AGENTS[0]],
    messages: [message("user", "안녕", "user")],
  });
  assert.doesNotMatch(prompt, /다른 참가자/);
});

test("권한 모드에 따라 도구 규칙이 달라진다", () => {
  const chat = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "chat",
  });
  assert.match(chat, /대화로만 답하세요/);

  const read = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-read",
  });
  assert.match(read, /읽고 검색할 수 있지만/);

  const write = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-write",
  });
  assert.match(write, /읽고 수정할 수 있습니다/);
});

test("토론 컨텍스트가 자율 종료 신호와 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "주제", "user")],
    discussion: { turn: 2, maxTurns: 9 },
  });
  assert.match(prompt, /자율 토론 2\/9턴/);
  assert.match(prompt, /CODEPET_DISCUSSION:CONCLUDE/);
});

test("전문 모드 구현·검토·기록 지침과 누적 요약이 프롬프트에 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "확정된 작업", "user")],
    memoryContext: "사람이 정한 규칙",
    specialist: { stage: "review", round: 2, maxRounds: 3, feedback: "테스트 결과를 확인하세요." },
  });
  assert.match(prompt, /프로젝트 누적 요약/);
  assert.match(prompt, /현재 단계: 검토 · 반복 2\/3/);
  assert.match(prompt, /테스트 결과를 확인하세요/);
  assert.match(prompt, /CODEPET_REVIEW:PASS/);
  assert.match(prompt, /CODEPET_REVIEW:REVISE/);
});

test("전문 모드 구현자는 위임 금지, 검토자는 위임 시 되돌림 지침을 받는다", () => {
  const implementation = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "진행해", "user")],
    specialist: { stage: "implementation", round: 1, maxRounds: 3 },
  });
  assert.match(implementation, /위임하지 마세요/);
  assert.match(implementation, /다른 참가자에게 맡기지 말고/);

  const review = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "진행해", "user")],
    specialist: { stage: "review", round: 1, maxRounds: 3 },
  });
  assert.match(review, /통과시키지 말고 구현 단계로 되돌리세요/);
});

test("첨부가 있는 메시지는 첨부 이름이 함께 표기된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      {
        author: "user",
        authorType: "user",
        text: "이 파일 봐줘",
        attachments: [{ name: "정리.md" }, { name: "shot.png" }],
      },
    ],
  });
  assert.match(prompt, /\[첨부: 정리\.md, shot\.png\]/);
});

test("extraLines가 대화 끝 뒤에 추가된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    extraLines: ["=== 첨부 내용 ===", "파일: note.txt"],
  });
  assert.match(prompt, /=== 대화 끝 ===\n=== 첨부 내용 ===\n파일: note\.txt/);
});

test("이모티콘 지시는 프롬프트에 주입하지 않는다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "검토해줘", "user")],
  });
  assert.doesNotMatch(prompt, /CODEPET_EMOTE/);
  assert.doesNotMatch(prompt, /이모티콘/);
});

test("프로젝트 공통 맥락은 해당 대화의 프롬프트에만 추가된다", () => {
  const withContext = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "검토해줘", "user")],
    projectContext: "이 프로젝트에서는 공개 API를 바꾸지 않는다.",
  });
  const withoutContext = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "검토해줘", "user")],
  });

  assert.match(withContext, /프로젝트 공통 맥락/);
  assert.match(withContext, /공개 API를 바꾸지 않는다/);
  assert.doesNotMatch(withoutContext, /프로젝트 공통 맥락/);
});

test("\uB124 \uC601\uC5ED\uC774 \uADDC\uCE59 \uD68C\uC0C9 \uB9E5\uB77D \uACB0\uC815\uBCF4 \uC21C\uC11C\uB85C \uB098\uC628\uB2E4", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    rulesContext: "\uADDC\uCE59 A",
    projectContext: "\uAC1C\uC694 B",
    workflowContext: "\uACB0\uC815 C",
    memoryContext: "\uC694\uC57D D",
  });
  const rulesIdx = prompt.indexOf("\uD604\uC7AC \uADDC\uCE59");
  const contextIdx = prompt.indexOf("\uACF5\uD1B5 \uB9E5\uB77D");
  const workflowIdx = prompt.indexOf("\uD655\uC815\uB41C \uACB0\uC815");
  const memoryIdx = prompt.indexOf("\uB204\uC801 \uC694\uC57D");
  assert.ok(rulesIdx > -1 && contextIdx > -1 && workflowIdx > -1 && memoryIdx > -1);
  assert.ok(rulesIdx < contextIdx);
  assert.ok(contextIdx < workflowIdx);
  assert.ok(workflowIdx < memoryIdx);
});

test("\uADDC\uCE59\uC774 \uBE44\uC5B4 \uC788\uC73C\uBA74 \uADDC\uCE59 \uAD6C\uC5ED\uC774 \uC5C6\uB2E4", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
  });
  assert.doesNotMatch(prompt, /\uD604\uC7AC \uADDC\uCE59/);
});

test("\uC804\uCCB4\uAC00 \uC0C1\uD55C\uC744 \uB118\uC73C\uBA74 \uC694\uC57D\uB9CC \uC904\uACE0 \uADDC\uCE59\uACFC \uB9E5\uB77D\uC740 \uC628\uC804\uD558\uB2E4", () => {
  const rules = "\uADDC\uCE59".repeat(2000);
  const context = "\uAC1C\uC694".repeat(2000);
  const memory = "\uC694\uC57D\uBCF8\uBB38".repeat(5000);
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    rulesContext: rules,
    projectContext: context,
    memoryContext: memory,
  });
  assert.ok(prompt.includes(rules));
  assert.ok(prompt.includes(context));
  assert.match(prompt, /\uB204\uC801 \uC694\uC57D \uC55E\uBD80\uBD84\uC740 \uC0DD\uB7B5\uB428/);
});

test("\uD1A0\uB860 \uD0DC\uADF8 \uC9C0\uC2DC\uBB38\uC774 \uADF8\uB300\uB85C \uB0A8\uC544\uC788\uB2E4", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    discussion: { turn: 1, maxTurns: 5 },
  });
  assert.match(prompt, /\[\[CODEPET_DISCUSSION:CONTINUE\]\]/);
  assert.match(prompt, /\[\[CODEPET_DISCUSSION:CONCLUDE\]\]/);
});
