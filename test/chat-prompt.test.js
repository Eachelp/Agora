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
