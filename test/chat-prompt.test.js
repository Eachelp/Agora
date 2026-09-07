const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentPrompt, boundedText, MAX_SPECIALIST_PROMPT_CHARS } = require("../src/chat/chat-prompt");

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

test("전문 모드 검토는 clean-room 지침과 계약 검수 지침을 포함한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "확정된 작업", "user")],
    memoryContext: "Builder transcript와 무관한 메모리",
    specialist: { stage: "review", round: 2, maxRounds: 3, feedback: "테스트 결과를 확인하세요." },
  });
  assert.match(prompt, /clean-room/);
  assert.doesNotMatch(prompt, /프로젝트 누적 요약/);
  assert.doesNotMatch(prompt, /Builder transcript와 무관한 메모리/);
  assert.match(prompt, /현재 단계: 검토 · 반복 2\/3/);
  assert.match(prompt, /테스트 결과를 확인하세요/);
  assert.match(prompt, /VERDICT: PASS/);
  assert.match(prompt, /VERDICT: FIX_REQUIRED/);
  assert.match(prompt, /VERDICT: UNKNOWN/);
});

test("기획 검수는 Open Question이 남아 있으면 통과시키지 않는다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "작업을 계획해", "user")],
    specialist: { stage: "plan_review", round: 1, maxRounds: 1, feedback: "## 목표\n화면 개선" },
  });
  assert.match(prompt, /전문 모드: 기획 검수/);
  assert.match(prompt, /구현을 시작하지 마세요/);
  assert.match(prompt, /scope: IN\/OUT/);
  assert.match(prompt, /사용자 결정이 필요한 문제는 `## Open Questions`/);
  assert.match(prompt, /Open Question이 남아 있으면 PASS로 처리하지 말고/);
});

test("기획 검수는 사용자 메시지와 구조화 입력만 보고 다른 에이전트 자유 대화는 제외한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [
      message("user", "사용자 요구사항", "user"),
      message("claude", "기획자의 자유 설명은 검수 근거가 아니어야 합니다"),
    ],
    memoryContext: "기록관 초안도 기획 검수에 넣지 않습니다",
    specialist: {
      stage: "plan_review",
      feedback: "## Goal\n현재 TASK",
      previousIssues: "1.\nseverity: BLOCKING\nrepeat: YES\nproblem: 이전 지적",
    },
  });

  assert.match(prompt, /사용자 요구사항/);
  assert.match(prompt, /현재 TASK/);
  assert.match(prompt, /=== 이전 구조화 이슈 ===/);
  assert.match(prompt, /repeat: YES/);
  assert.doesNotMatch(prompt, /기획자의 자유 설명/);
  assert.doesNotMatch(prompt, /기록관 초안/);
  assert.doesNotMatch(prompt, /그룹 채팅의 참가자/);
});

test("기획 검수의 현재 TASK는 자르지 않고 예산 초과 시 호출을 막는다", () => {
  assert.throws(
    () => buildAgentPrompt({
      agent: AGENTS[1],
      agents: AGENTS,
      messages: [message("user", "검수해", "user")],
      specialist: { stage: "plan_review", feedback: "x".repeat(MAX_SPECIALIST_PROMPT_CHARS + 1024) },
    }),
    (error) => error?.code === "PROMPT_BUDGET_EXCEEDED"
  );
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

test("Builder 프롬프트는 그룹채팅 프레이밍과 대화 transcript를 제외한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "사용자 원문", "user"), message("claude", "이전 에이전트 의견")],
    projectContext: "프로젝트 개요",
    workflowContext: "진행 중 작업",
    specialist: {
      stage: "implementation",
      round: 1,
      maxRounds: 1,
      frozenTask: { runId: "RUN-1", content: "Frozen Task" },
    },
  });
  assert.match(prompt, /Agora 전문 실행의 Builder/);
  assert.match(prompt, /Frozen Task/);
  assert.doesNotMatch(prompt, /그룹 채팅의 참가자/);
  assert.doesNotMatch(prompt, /참가자:/);
  assert.doesNotMatch(prompt, /=== 대화 ===/);
  assert.doesNotMatch(prompt, /사용자 원문/);
  assert.doesNotMatch(prompt, /프로젝트 공통 맥락/);
  assert.doesNotMatch(prompt, /채팅에 어울리게 간결히/);
});

test("전문 Recorder는 transcript 대신 Frozen Task와 최종 실행 근거만 받는다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "일반 대화 원문", "user"), message("claude", "Builder 자기보고", "agent")],
    specialist: {
      stage: "recorder",
      professional: true,
      frozenTask: { runId: "RUN-001", content: "Frozen Task 본문" },
      reviewDiff: "diff --git a/a.js b/a.js",
      finalVerdict: "PASS",
      evidence: { execution: "OBSERVED" },
    },
  });
  assert.match(prompt, /Frozen Task 본문/);
  assert.match(prompt, /최종 검수 판정: PASS/);
  assert.match(prompt, /diff --git/);
  assert.doesNotMatch(prompt, /=== 대화 ===/);
  assert.doesNotMatch(prompt, /일반 대화 원문/);
  assert.doesNotMatch(prompt, /Builder 자기보고/);
});

test("Planner와 plan_review 프롬프트가 NEEDS_DECISION 및 repeat 규칙을 명시한다", () => {
  const planner = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [],
    specialist: { stage: "planner" },
  });
  const review = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [],
    specialist: { stage: "plan_review" },
  });
  assert.match(planner, /TASK를 고친 것처럼 다시 쓰지 마세요/);
  assert.match(planner, /STATUS: NEEDS_DECISION/);
  assert.match(planner, /관련된 파일·호출 경로·테스트를 필요한 범위에서 읽어/);
  assert.match(planner, /Current State \/ Evidence/);
  assert.match(review, /repeat: YES\|NO/);
  assert.match(review, /BLOCKING 이슈가 아직 해소되지 않았다면 반드시/);
  assert.match(review, /워크스페이스를 읽어 확인하세요/);
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

// 토론 기록은 전문 실행 Recorder가 아니다. Recorder 역할은 context 정책상 대화를
// 전혀 못 보므로, 그 경로로 보내면 "요약할 대화가 없는 요약자"가 된다.
// 기록은 대화를 읽는 일반 턴이고 출력 형식만 기록 계약(JSON)을 따른다.
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

// 스키마가 받는 필드를 프롬프트가 알려주지 않으면 Planner는 산문·괄호로 우회하고,
// 그 우회는 조용히 실패한다. 실제로 cwd를 산문에만 적어 저장소 루트에서 실행돼
// 임포트가 깨졌고, Deliverable 경로에 괄호 설명을 붙여 ABSENT로 판정됐다.
// 그래서 안내 문구만이 아니라 **프롬프트의 예시가 실제로 파싱되는지**까지 본다.
test("기획 프롬프트의 process 예시는 실행기가 받는 형태다 (cwd 포함)", () => {
  const { parseVerificationPlan } = require("../src/agora/assurance/verification-plan");
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [],
    specialist: { stage: "planner" },
  });
  assert.match(prompt, /"cwd"/, "cwd 필드를 알려줘야 합니다");
  assert.match(prompt, /설명 문장에만 적으면/, "산문으로 적으면 안 된다고 알려줘야 합니다");

  // 프롬프트에 실린 cwd 예시를 그대로 떼어 실행기 스키마에 넣어 본다.
  const example = prompt.match(/\{"id":"V1"[^\n]*"cwd":"[^"]*"\}/);
  assert.ok(example, "cwd가 든 예시가 있어야 합니다");
  const plan = parseVerificationPlan("```json\n[" + example[0] + "]\n```");
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.criteria[0].step.cwd, "20_projects/01_어휘");
});

test("기획 프롬프트는 Deliverable 설명을 대시로 붙이라고 알려준다", () => {
  const taskSchema = require("../src/agora/assurance/task-schema-v2");
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [],
    specialist: { stage: "planner" },
  });
  assert.match(prompt, /경로 — 설명/);
  assert.match(prompt, /괄호까지 경로로 읽혀/);

  // 파서 계약을 함께 고정한다. 대시는 분리되고 괄호는 경로에 남는다.
  const parsed = taskSchema.parseTaskV2(
    ["## Goal", "g", "## Inputs / Source Data", "- 없음", "## Requirements", "r",
      "## Work Approach", "w", "## Deliverables",
      "- out/a.json — 신규 사본", "- out/b (신규 사본).json",
      "## Acceptance Criteria", "a", "## Verification Plan", "v", "## Out of Scope", "o"].join("\n")
  );
  const items = parsed.deliverables.items;
  assert.equal(items[0].locator, "out/a.json");
  assert.equal(items[0].description, "신규 사본");
  // 괄호는 분리되지 않는다 — 그래서 프롬프트가 쓰지 말라고 해야 한다.
  assert.equal(items[1].locator, "out/b (신규 사본).json");
});

test("Archivist 프롬프트는 전용 페르소나를 쓰고 그룹채팅 프레이밍·대화를 제외한다", () => {
  const base = {
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "일반 대화 원문", "user"), message("claude", "Builder 자기보고", "agent")],
  };
  const prompt = buildAgentPrompt({
    ...base,
    specialist: {
      stage: "archivist",
      journal: [{ type: "ROLE_FINISHED", role: "reviewer", status: "DONE" }],
      finalVerdict: "PASS",
      frozenTask: { runId: "RUN-001", content: "Frozen Task 본문" },
      reviewDiff: "diff --git a/a.js b/a.js",
      evidence: { execution: "OBSERVED" },
    },
  });
  // 정책(ROLE_CONTEXT_POLICY.archivist)이 transcript를 차단하므로, "아래 대화의
  // 마지막 메시지에 이어 답하라"는 그룹 채팅 페르소나로 떨어지면 지시가 모순된다.
  assert.match(prompt, /Archivist/);
  assert.match(prompt, /전문 모드: 기록 정리/);
  assert.match(prompt, /^현재 단계: 기록 정리$/m);
  assert.doesNotMatch(prompt, /반복 1\/3/);
  assert.doesNotMatch(prompt, /그룹 채팅의 참가자/);
  assert.doesNotMatch(prompt, /마지막 메시지에 이어/);
  assert.doesNotMatch(prompt, /=== 대화 ===/);
  assert.doesNotMatch(prompt, /일반 대화 원문/);
  assert.doesNotMatch(prompt, /Builder 자기보고/);
  assert.match(prompt, /=== System Journal \(실행 사실 기록\) ===/);
  assert.match(prompt, /ROLE_FINISHED/);
  assert.match(prompt, /Frozen Task 본문/);
  assert.match(prompt, /diff --git/);
  assert.match(prompt, /최종 검수 판정: PASS/);
  // 빈 journal([])은 빈 섹션을 그리지 않는다.
  const empty = buildAgentPrompt({
    ...base,
    specialist: { stage: "archivist", journal: [], finalVerdict: "PASS" },
  });
  assert.doesNotMatch(empty, /=== System Journal/);
  assert.match(empty, /Archivist/);
});

test("검토자 제어 안내는 UNKNOWN이면 ASK_USER를 붙이라고 알려준다", () => {
  const base = {
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [message("user", "확정된 작업", "user")],
  };
  const guided = buildAgentPrompt({
    ...base,
    specialist: { stage: "review", round: 1, maxRounds: 3, controlOutputs: true },
  });
  assert.match(guided, /다음 역할 요청/);
  assert.match(guided, /UNKNOWN이면 `ASK_USER: <질문 한 줄>`/);
  assert.match(guided, /HANDOFF: @recorder/);
  assert.match(guided, /HANDOFF: @builder/);
  // 소비자가 없는 경로(step mode)에는 routing 안내가 붙지 않는다.
  const plain = buildAgentPrompt({
    ...base,
    specialist: { stage: "review", round: 1, maxRounds: 3 },
  });
  assert.doesNotMatch(plain, /다음 역할 요청/);
  assert.doesNotMatch(plain, /UNKNOWN이면/);
});

test("구현자 상담 안내는 세션 권한이 chat이면 파일 읽기를 약속하지 않는다", () => {
  const base = {
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "왜 느려?", "user")],
    consult: { role: "builder", label: "구현자" },
  };
  const chat = buildAgentPrompt({ ...base, permissionMode: "chat" });
  assert.match(chat, /역할 상담: 구현자/);
  assert.match(chat, /대화로만 답하세요/);
  assert.doesNotMatch(chat, /읽기만 할 수 있습니다/);
  assert.match(chat, /파일을 읽을 수 없으므로/);
  const read = buildAgentPrompt({ ...base, permissionMode: "workspace-read" });
  assert.match(read, /읽기만 할 수 있습니다/);
  assert.doesNotMatch(read, /파일을 읽을 수 없으므로/);
});

test("boundedText는 상한이 작아 꼬리 예산이 0이어도 원문 전체를 돌려주지 않는다", () => {
  const text = "가".repeat(400);
  // tail===0이면 slice(-0)===slice(0)이라 원문 전체가 돌아와 상한을 우회했다.
  for (let limit = 1; limit <= 80; limit += 1) {
    const out = boundedText(text, limit, "T");
    assert.equal(out.truncated, true);
    assert.ok(out.text.length < text.length, `limit=${limit}: ${out.text.length}`);
    assert.match(out.text, /일부 생략/);
  }
  const intact = boundedText("짧다", 100, "T");
  assert.equal(intact.truncated, false);
  assert.equal(intact.text, "짧다");
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
