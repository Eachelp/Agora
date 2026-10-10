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

// 공통 질문 계약 안내는 chat-room이 계약을 읽는 일반 채팅 턴에만 붙는다. 토론
// 턴에 붙으면 모델이 안내받은 제어를 아무도 읽지 않는다.
test("ASK_USER + OPTION 질문 계약 안내는 일반 채팅 턴에만 들어간다", () => {
  const base = { agent: AGENTS[0], agents: AGENTS, messages: [message("user", "안녕", "user")] };
  const general = buildAgentPrompt(base);
  assert.match(general, /`ASK_USER: <질문 한 줄>`/);
  assert.match(general, /`OPTION: <보기>` 줄을 2~5개/);
  // "막혀서 묻는 것"과 "방향 메뉴를 제안하며 마무리하는 것"을 가른다. 후자에
  // 붙으면 답할 필요 없는 질문까지 답변 대기로 선다.
  assert.match(general, /맡은 작업을 이어가려면 사용자의 결정이 꼭 필요할 때만/);
  assert.match(general, /선택지를 제안하며 마무리하는 경우나 .*마무리 인사에는 붙이지 마세요/);
  const guidance = /`OPTION: <보기>`/;
  assert.doesNotMatch(buildAgentPrompt({ ...base, discussion: { turn: 1, maxTurns: 3 } }), guidance);
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

test("네 영역이 규칙 회색 맥락 결정보 순서로 나온다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    rulesContext: "규칙 A",
    projectContext: "개요 B",
    workflowContext: "결정 C",
    memoryContext: "요약 D",
  });
  const rulesIdx = prompt.indexOf("현재 규칙");
  const contextIdx = prompt.indexOf("공통 맥락");
  const workflowIdx = prompt.indexOf("확정된 결정");
  const memoryIdx = prompt.indexOf("누적 요약");
  assert.ok(rulesIdx > -1 && contextIdx > -1 && workflowIdx > -1 && memoryIdx > -1);
  assert.ok(rulesIdx < contextIdx);
  assert.ok(contextIdx < workflowIdx);
  assert.ok(workflowIdx < memoryIdx);
});

test("규칙이 비어 있으면 규칙 구역이 없다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
  });
  assert.doesNotMatch(prompt, /현재 규칙/);
});

test("전체가 상한을 넘으면 요약만 줄고 규칙과 맥락은 온전하다", () => {
  const rules = "규칙".repeat(2000);
  const context = "개요".repeat(2000);
  const memory = "요약본문".repeat(5000);
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
  assert.match(prompt, /누적 요약 앞부분은 생략됨/);
});

test("\uADDC\uCE59\uACFC \uAC1C\uC694\uAC00 \uC608\uC0B0\uC744 \uB2E4 \uC368\uBC84\uB9AC\uBA74 \uB204\uC801 \uC694\uC57D\uC744 \uC544\uC608 \uB123\uC9C0 \uC54A\uB294\uB2E4", () => {
  const rules = "\uADDC".repeat(9000);
  const context = "\uAC1C".repeat(9000);
  const memory = "\uC694\uC57D\uBCF8\uBB38".repeat(500);
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    rulesContext: rules,
    projectContext: context,
    memoryContext: memory,
  });
  assert.ok(!prompt.includes(memory));
  assert.ok(!prompt.includes("\uD504\uB85C\uC81D\uD2B8 \uB204\uC801 \uC694\uC57D"));
});

test("토론 태그 지시문이 그대로 남아있다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    discussion: { turn: 1, maxTurns: 5 },
  });
  assert.match(prompt, /\[\[CODEPET_DISCUSSION:CONTINUE\]\]/);
  assert.match(prompt, /\[\[CODEPET_DISCUSSION:CONCLUDE\]\]/);
});

test("Handoff(검토 요청)은 전달 메시지를 검토 의도로 주입한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    handoff: { intent: "REVIEW_OPINION", text: "이 구현 결과를 검토해 주세요." },
  });
  assert.match(prompt, /이전 메시지 전달 \(Handoff\)/);
  assert.match(prompt, /검토 요청/);
  assert.match(prompt, /이 구현 결과를 검토해 주세요\./);
  assert.match(prompt, /검토 의견만 제시/);
});

test("Handoff(이어서 작업)은 전달 메시지를 후속 작업으로 주입한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "hi" }],
    handoff: { intent: "CONTINUE", text: "여기서 이어서 작업하세요." },
  });
  assert.match(prompt, /이전 메시지 전달 \(Handoff\)/);
  assert.match(prompt, /이어서 작업/);
  assert.match(prompt, /여기서 이어서 작업하세요\./);
  assert.match(prompt, /후속 작업을 이어가/);
});

test("토론 종합 프롬프트는 고정 요약 섹션과 미완성 경고 지침을 포함한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      message("user", "토론 주제 질문", "user"),
      message("claude", "클로드 토론 발언"),
      message("codex", "코덱스 토론 발언"),
    ],
    discussionSummary: {
      discussionId: "disc-123",
      incomplete: true,
      participants: ["claude", "codex"],
    },
  });
  assert.match(prompt, /Agora의 토론 결론 종합자/);
  assert.match(prompt, /## 논의 주제/);
  assert.match(prompt, /## 공통 합의점/);
  assert.match(prompt, /## 주요 쟁점과 입장/);
  assert.match(prompt, /## 권장 결론/);
  assert.match(prompt, /## 사용자 결정 사항 \/ 다음 행동/);
  assert.match(prompt, /미완성.*상태로 종료/);
  assert.match(prompt, /토론 주제 질문/);
  assert.match(prompt, /클로드 토론 발언/);
  assert.doesNotMatch(prompt, /그룹 채팅의 참가자/);
  assert.doesNotMatch(prompt, /다른 참가자를 호출하려면 @이름/);
});


test("쉬운 설명(simplifyMeta) 프롬프트는 통역 규칙과 원문 메시지만을 포함한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [{ author: "user", authorType: "user", text: "이전 대화" }],
    simplifyMeta: {
      fromAgentId: "claude",
      text: "어려운 기술 용어 원문",
      messageId: "msg-1",
    },
  });
  assert.match(prompt, /비개발자도 이해하기 쉽게 풀어주는 통역가/);
  assert.match(prompt, /전문 개발 용어나 내부 아키텍처, 단순 로그 설명을 걷어내세요/);
  assert.match(prompt, /풀어볼 원문 메시지/);
  assert.match(prompt, /작성자: claude/);
  assert.match(prompt, /어려운 기술 용어 원문/);
  assert.doesNotMatch(prompt, /이전 대화/);
});

// 토론 기록은 대화를 읽는 일반 턴이고 출력 형식만 기록 계약(JSON)을 따른다.
test("토론 기록 프롬프트는 대화를 보면서 기록 JSON 계약을 요구한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      message("user", "캐시 전략을 정하자", "user"),
      message("codex", "LRU로 갑시다"),
    ],
    discussionSummary: { record: true },
  });
  assert.match(prompt, /캐시 전략을 정하자/);
  assert.match(prompt, /LRU로 갑시다/);
  assert.match(prompt, /"nextActions"/);
  assert.match(prompt, /토론 기록자/);
  // 종합 카드의 고정 섹션 구조는 기록에 쓰지 않는다(출력 형식이 서로 다르다).
  assert.doesNotMatch(prompt, /## 공통 합의점/);
});

test("record 플래그가 없으면 기존 토론 종합 카드 형식을 그대로 쓴다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "정리해줘", "user")],
    discussionSummary: { discussionId: "D-1" },
  });
  assert.match(prompt, /## 공통 합의점/);
  assert.match(prompt, /토론 결론 종합자/);
  assert.doesNotMatch(prompt, /"nextActions"/);
});

// 독립 발언은 여럿이 같은 폴더에서 동시에 돈다. 파일 단위 충돌은 프로그램이
// 막지 않으므로(같은 파일을 둘이 고치면 나중 쓰기가 이긴다), 쓰기 권한일 때만
// "각자 자기 폴더에서만" 계약을 준다. 읽기는 겹쳐도 안전하다.
test("동시 실행 + 쓰기 권한일 때만 담당자별 폴더 규칙을 준다", () => {
  const agents = [
    { id: "claude", name: "Claude" },
    { id: "codex", name: "GPT" },
    { id: "agy", name: "Gemini" },
  ];
  const messages = [{ id: "m1", authorType: "user", author: "user", text: "각자 시안 만들어줘" }];
  const build = (permissionMode, parallel) =>
    buildAgentPrompt({ agent: agents[0], agents, messages, permissionMode, parallel });

  const write = build("workspace-write", { folder: "claude", total: 3 });
  assert.match(write, /참가자 3명이 같은 작업 폴더에서 동시에 실행/);
  assert.match(write, /`claude\/` 하위에만/);
  assert.match(write, /읽기는 자유입니다/);
  // 폴더 전체에 영향을 주는 명령은 병렬에서 서로 섞인다.
  assert.match(write, /git·패키지 설치·빌드/);

  // 읽기 전용이면 덮어쓸 것이 없으므로 규칙을 붙이지 않는다.
  assert.ok(!build("workspace-read", { folder: "claude", total: 3 }).includes("동시에 실행되고"));
  // 혼자 도는 턴에도 붙이지 않는다.
  assert.ok(!build("workspace-write", null).includes("동시에 실행되고"));
});
