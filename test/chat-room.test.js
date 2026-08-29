const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager } = require("../src/agora/task-manager");
const turnCheckpoint = require("../src/agora/turn-checkpoint");
const { ChatRoom } = require("../src/chat/chat-room");


function makePlanContract(goal = "목표", extra = "") {
  return [
    "## Goal",
    goal,
    "## Requirements",
    "기능 요구사항",
    "## Implementation Approach",
    "구현 접근 방식",
    "## Acceptance Criteria",
    "완료 수용 기준",
    "## Verification",
    "검증 계획",
    "## Out of Scope",
    "제외 범위",
    extra,
    "STATUS: PLAN_READY",
  ].filter(Boolean).join("\n");
}

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    {
      id: "agy",
      name: "Antigravity",
      aliases: ["agy", "antigravity"],
      available: false,
      enabled: true,
      reason: "agy CLI가 설치되어 있지 않습니다.",
    },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments }) => {
    calls.push({ agentId: agent.id, prompt, attachments });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("멘션된 에이전트만 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: true, text: "네!" }] }, calls),
  });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].author, "codex");
  assert.equal(agentMessages[0].text, "네!");
});

test("[[CODEPET_EMOTE:...]] 표기는 화면에 노출되지 않도록 조용히 제거된다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{
        ok: true,
        text: "검토 끝났습니다.\n[[CODEPET_EMOTE:검토완료]]\n[[CODEPET_EMOTE:좋은데]]",
      }],
    }),
  });
  room.sendUserMessage("@codex 검토해줘");
  await settle(room);

  const response = room.messages.find((message) => message.author === "codex");
  assert.equal(response.text, "검토 끝났습니다.");
  assert.equal(response.emoticons, undefined);
  assert.equal(response.contentParts, undefined);
});

test("에이전트 실행 전 준비 단계를 기다리고 실제 오류를 대화에 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    prepareAgent: async ({ agent }) => {
      calls.push(`prepare:${agent.id}`);
      throw new Error("Codex 로컬 프록시 복구 실패: 포트 연결 거부");
    },
    runAgent: () => {
      calls.push("run");
      return { promise: Promise.resolve({ ok: true, text: "실행되면 안 됨" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 검토해");
  await settle(room);

  assert.deepEqual(calls, ["prepare:codex"]);
  const error = room.messages.find((message) => message.author === "codex" && message.error);
  assert.match(error.text, /프록시 복구 실패: 포트 연결 거부/);
});

test("제한 자동 실행은 검토 수정 요구를 범위 안에서 자동 보완하고 통과하면 기록한다", async () => {
  const calls = [];
  const replies = {
    codex: [
      { ok: true, text: "첫 구현\nSTATUS: DONE" },
      { ok: true, text: "수정 구현\nSTATUS: DONE" },
    ],
    claude: [
      {
        ok: true,
        text: "테스트가 부족합니다.\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nlocation: src/chat.js:1\nproblem: 테스트 누락\nevidence: ...\nimpact: ...",
      },
      { ok: true, text: "검토 통과\nVERDICT: PASS" },
      { ok: true, text: "## 완료\n- 구현과 검토가 끝났습니다." },
    ],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, model: agent.model, prompt });
      const reply = replies[agent.id].shift();
      return { promise: Promise.resolve(reply), cancel: () => {} };
    },
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex"), agentConfig: { model: "gpt-5" } },
      review: { agent: room.findAgent("claude"), agentConfig: { model: "claude-review" } },
      recorder: { agent: room.findAgent("claude"), agentConfig: { model: "claude-record" } },
    },
    mode: "auto",
    maxAutoRevisions: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedIterations, 2);
  assert.equal(result.recording, "## 완료\n- 구현과 검토가 끝났습니다.");
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude", "codex", "claude", "claude"]);
  assert.deepEqual(calls.map((call) => call.model), ["gpt-5", "claude-review", "gpt-5", "claude-review", "claude-record"]);
  assert.match(calls[2].prompt, /테스트가 부족합니다/);
  assert.match(calls[4].prompt, /summary에는/);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 5);
});

test("빠른 실행도 Frozen Task와 검토 피드백을 유지하며 제한 자동 보완한다", async (t) => {
  const calls = [];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-quick-revise-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const replies = {
    claude: [
      { ok: true, text: makePlanContract("빠른 실행 보완") },
      { ok: true, text: "누락된 검증을 추가하세요.\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nlocation: src/a.js\nproblem: 검증 누락\nevidence: 테스트 실패\nimpact: 회귀 가능" },
      { ok: true, text: "통과\nVERDICT: PASS" },
      { ok: true, text: "기록 완료" },
    ],
    codex: [
      { ok: true, text: "첫 구현\nSTATUS: DONE" },
      { ok: true, text: "보완 구현\nSTATUS: DONE" },
    ],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      recorder: { agent: room.findAgent("claude") },
    },
    mode: "quick",
    maxAutoRevisions: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude", "codex", "claude", "claude"]);
  assert.match(calls[3].prompt, /누락된 검증을 추가하세요/);
  assert.match(calls[3].prompt, /실행 계약 \(Frozen Task\)/);
});

test("전문 실행 승인 대기 중에는 일반 메시지를 받지 않고 취소 후 다시 받을 수 있다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "기획 완료\nSTATUS: PLAN_READY" }],
    }),
  });

  const started = await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });
  assert.equal(started.stopReason, "PLAN_READY");
  assert.equal(room.specialistState().available, true);
  assert.throws(() => room.sendUserMessage("일반 대화가 끼면 안 됩니다"), /전문 실행/);

  const cancelled = room.cancelSpecialist();
  assert.equal(cancelled.ok, true);
  assert.equal(room.specialistState().available, false);
  assert.ok(room.sendUserMessage("이제 일반 대화가 됩니다"));
});

test("단계별 실행은 구현 후 검토 결과를 사용자에게 반환하고 자동 보완하지 않는다", async () => {
  const calls = [];
  const replies = {
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
    claude: [
      {
        ok: true,
        text: "수정 필요\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nlocation: a.js\nproblem: 버그",
      },
    ],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
  });

  // 기본은 step 모드 → 검토 FIX_REQUIRED 후 자동 보완 없이 사용자에게 반환.
  assert.equal(result.ok, false);
  assert.equal(result.needsUserDecision, true);
  assert.equal(result.stopReason, "FIX_REQUIRED");
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude"]);
});

test("검토자 판정이 범위 밖이면 자동 보완하지 않고 SCOPE_OUT으로 반환한다", async () => {
  const calls = [];
  const replies = {
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
    claude: [
      {
        ok: true,
        text: "범위 밖 제안\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: OUT\nseverity: BLOCKING\nlocation: b.js\nproblem: 리팩터링",
      },
    ],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "auto",
    maxAutoRevisions: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "SCOPE_OUT");
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude"]);
});

test("검토자 판정이 UNKNOWN이면 자동 보완하지 않고 반환한다", async () => {
  const calls = [];
  const replies = {
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
    claude: [{ ok: true, text: "판단 불가\nVERDICT: UNKNOWN" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "auto",
    maxAutoRevisions: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude"]);
});

test("기획 단계가 NEEDS_DECISION을 반환하면 구현을 시작하지 않고 멈춘다", async () => {
  const calls = [];
  const replies = {
    claude: [{ ok: true, text: "결정 필요\nSTATUS: NEEDS_DECISION" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      planner: { agent: room.findAgent("claude") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "planner");
  assert.equal(result.stopReason, "NEEDS_DECISION");
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("단계 실행에서 기획이 PLAN_READY면 승인을 기다리며 구현을 시작하지 않는다", async () => {
  const calls = [];
  const states = [];
  const replies = {
    claude: [{ ok: true, text: "기획 완료\nSTATUS: PLAN_READY" }],
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });
  room.on("specialist-resume-state", (state) => states.push(state));

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      planner: { agent: room.findAgent("claude") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "planner");
  assert.equal(result.stopReason, "PLAN_READY");
  assert.equal(result.needsUserDecision, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  assert.equal(states.at(-1).active, false);
  assert.equal(states.at(-1).available, true);
  assert.equal(states.at(-1).phase, "plan_ready");
});

test("승인(resume) 후 기획을 이어서 구현·검토를 진행한다", async () => {
  const calls = [];
  const replies = {
    claude: [
      { ok: true, text: "기획 완료\nSTATUS: PLAN_READY" },
      { ok: true, text: "검토 통과\nVERDICT: PASS" },
    ],
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const started = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      planner: { agent: room.findAgent("claude") },
    },
  });

  assert.equal(started.ok, false);
  assert.equal(started.stopReason, "PLAN_READY");

  // step 모드: 승인 1회 → Builder 실행 후 builder_done에서 멈춤.
  const afterBuilder = await room.resumeSpecialist();
  assert.equal(afterBuilder.ok, false);
  assert.equal(afterBuilder.stopReason, "BUILDER_DONE");

  // 승인 2회 → Reviewer 실행 후 review_pass로 멈춤.
  const afterReview = await room.resumeSpecialist();
  assert.equal(afterReview.ok, false);
  assert.equal(afterReview.stopReason, "REVIEW_PASS");

  // 승인 3회 → 기록 후 완료.
  const afterRecord = await room.resumeSpecialist();
  assert.equal(afterRecord.ok, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude"]);
});

test("빠른 실행은 기획이 PLAN_READY면 승인 없이 구현·검토까지 한 번에 진행한다", async () => {
  const calls = [];
  const replies = {
    claude: [
      { ok: true, text: "기획 완료\nSTATUS: PLAN_READY" },
      { ok: true, text: "검토 통과\nVERDICT: PASS" },
    ],
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      planner: { agent: room.findAgent("claude") },
    },
    mode: "quick",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude"]);
});

test("검토 계약 파서는 VERDICT와 ISSUES를 정확히 해석한다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const pass = room.parseReviewContract("잘 했습니다\nVERDICT: PASS", "PASS");
  assert.equal(pass.verdict, "PASS");

  const fixIn = room.parseReviewContract(
    "수정 필요\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nlocation: a.js\nproblem: 버그",
    "FIX_REQUIRED"
  );
  assert.equal(fixIn.verdict, "FIX_REQUIRED");
  assert.equal(fixIn.canAutoRevise, true);
  assert.deepEqual(fixIn.blockingScopes, ["IN"]);

  const fixOut = room.parseReviewContract(
    "범위 밖\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: OUT\nseverity: BLOCKING\nlocation: b.js\nproblem: 리팩터링",
    "FIX_REQUIRED"
  );
  assert.equal(fixOut.verdict, "FIX_REQUIRED");
  assert.equal(fixOut.canAutoRevise, false);
  assert.equal(fixOut.stopReason, "SCOPE_OUT");

  const fixUnspecified = room.parseReviewContract(
    "수정 필요\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nseverity: BLOCKING\nlocation: c.js\nproblem: 버그",
    "FIX_REQUIRED"
  );
  assert.equal(fixUnspecified.canAutoRevise, false);
  assert.equal(fixUnspecified.stopReason, "SCOPE_UNSPECIFIED");

  const unknown = room.parseReviewContract("판단 불가\nVERDICT: UNKNOWN", "UNKNOWN");
  assert.equal(unknown.verdict, "UNKNOWN");
  assert.equal(unknown.stopReason, "INSUFFICIENT_EVIDENCE");

  const noNotBlocking = room.parseReviewContract(
    "사소한 제안\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: NON_BLOCKING\nproblem: 개선",
    "FIX_REQUIRED"
  );
  assert.equal(noNotBlocking.canAutoRevise, false);
  assert.equal(noNotBlocking.stopReason, "SCOPE_UNSPECIFIED");
});

test("검토 계약 파서는 코드펜스 안의 VERDICT 인용을 판정에 쓰지 않는다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  // 검토자가 예시/과거 답변을 코드펜스로 인용한 경우, 그 안의 VERDICT: PASS가
  // 실제 판정으로 오인되면 안 된다. 앵커 신호가 없으면 UNKNOWN으로 반환해야 한다.
  const quoted = room.parseReviewContract(
    "이전 검토는 다음과 같았습니다:\n```\nVERDICT: PASS\n```\n이번에는 통과로 보기 어렵습니다.",
    null
  );
  assert.equal(quoted.verdict, "UNKNOWN");
  assert.equal(quoted.stopReason, "INSUFFICIENT_EVIDENCE");
});

test("검토 계약 파서는 서로 다른 VERDICT가 여러 번 나오면 자동으로 단정하지 않는다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  // "VERDICT: PASS를 줄 수는 없습니다. VERDICT: FIX_REQUIRED" 같은 부정문·수정
  // 흔적에서 앵커 신호 없이 첫/마지막 매치만 보고 자동 PASS로 단정하면 안 된다.
  const ambiguous = room.parseReviewContract(
    "여기서 VERDICT: PASS를 줄 수는 없습니다. VERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nproblem: 버그",
    null
  );
  assert.equal(ambiguous.verdict, "UNKNOWN");
  assert.equal(ambiguous.stopReason, "AMBIGUOUS_VERDICT");
  assert.equal(ambiguous.canAutoRevise, false);

  // 같은 값이 반복되는 것은 모호하지 않다.
  const repeated = room.parseReviewContract(
    "통과입니다. VERDICT: PASS. 다시 말해 VERDICT: PASS.",
    null
  );
  assert.equal(repeated.verdict, "PASS");
});

test("검토 계약 파서는 끝줄 앵커 마커를 본문 VERDICT 언급보다 우선한다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  // 본문에 VERDICT: PASS가 있어도, respond()가 넘긴 앵커 신호(signal)가
  // FIX_REQUIRED라면 앵커가 이긴다 — 위조하기 쉬운 본문 문자열이 이겨서는 안 된다.
  const contract = room.parseReviewContract(
    "이전에는 VERDICT: PASS였지만 이번 변경으로 회귀가 생겼습니다.",
    "FIX_REQUIRED"
  );
  assert.equal(contract.verdict, "FIX_REQUIRED");
});

test("전문 모드 검토에서 서로 다른 VERDICT가 반복되면 자동 진행하지 않고 사용자에게 반환한다", async () => {
  const replies = {
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
    claude: [
      {
        ok: true,
        text: "결론을 내리기 애매합니다. VERDICT: PASS 라고 볼 수도 있지만 VERDICT: FIX_REQUIRED가 더 맞습니다.",
      },
    ],
  };
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner(replies) });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "auto",
    maxAutoRevisions: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "AMBIGUOUS_VERDICT");
  const notice = room.messages.find(
    (message) => message.authorType === "system" && /서로 다른 VERDICT/.test(message.text)
  );
  assert.ok(notice, "모호한 판정에 대한 안내 메시지가 있어야 한다");
});

test("기존 REVISE 마커는 FIX_REQUIRED로 정규화된다", async () => {
  const calls = [];
  const replies = {
    codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
    claude: [{ ok: true, text: "수정 필요\n[[CODEPET_REVIEW:REVISE]]" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(replies, calls),
  });
  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "SCOPE_UNSPECIFIED");
});

test("전문 모드 실행 중에는 @멘션 호출이 꺼진다", async () => {
  const calls = [];
  const replies = {
    codex: [
      { ok: true, text: "구현 완료. @claude 이어서 확인 부탁\nSTATUS: DONE" },
      { ok: true, text: "기록" },
    ],
    claude: [{ ok: true, text: "검토 통과\n[[CODEPET_REVIEW:PASS]]" }],
  };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      const reply = replies[agent.id].shift();
      return { promise: Promise.resolve(reply), cancel: () => {} };
    },
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
      recorder: { agent: room.findAgent("codex") },
    },
    mode: "auto",
    maxAutoRevisions: 3,
  });

  assert.equal(result.ok, true);
  // 구현 응답에 @claude가 들어 있어도 멘션 호출이 일어나지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude", "codex"]);
  const implementationPrompt = calls[0].prompt;
  assert.match(implementationPrompt, /위임하지 마세요/);
});

test("Professional Mode 변경 후에도 일반 채팅은 기존 권한·transcript·호출 경계를 유지한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: ({ agent, prompt, permissionMode, specialistStage, autoApprove }) => {
      calls.push({ agentId: agent.id, prompt, permissionMode, specialistStage, autoApprove });
      return { promise: Promise.resolve({ ok: true, text: "일반 답변" }), cancel: () => {} };
    },
  });

  room.sendUserMessage("@codex 일반 채팅으로 답해줘");
  await settle(room);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].permissionMode, "workspace-write");
  assert.equal(calls[0].specialistStage, null);
  assert.equal(calls[0].autoApprove, false);
  assert.match(calls[0].prompt, /=== 대화 ===/);
  assert.match(calls[0].prompt, /\[User\] @codex 일반 채팅으로 답해줘/);
  assert.match(calls[0].prompt, /그룹 채팅의 참가자/);
  assert.doesNotMatch(calls[0].prompt, /clean-room/);
});

test("Builder STATUS가 누락되면 DONE이 아니라 사용자 결정으로 멈춘다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{ ok: true, text: "구현은 끝났습니다" }],
      claude: [{ ok: true, text: "검수하면 안 됩니다\nVERDICT: PASS" }],
    }, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "auto",
    maxAutoRevisions: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "BUILDER_STATUS_MISSING");
  assert.equal(result.blocked, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
  assert.equal(room.specialistBlocked.blockReason, "BUILDER_STATUS_MISSING");
});

test("Builder STATUS가 서로 다르면 AMBIGUOUS로 멈춘다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{ ok: true, text: "STATUS: DONE\n중간 기록\nSTATUS: BLOCKED" }],
      claude: [{ ok: true, text: "검수하면 안 됩니다\nVERDICT: PASS" }],
    }, calls),
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "auto",
    maxAutoRevisions: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "BUILDER_STATUS_AMBIGUOUS");
  assert.equal(result.blocked, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["codex"]);
});

test("멘션이 없으면 세션에 참여 중인 모든 에이전트가 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId).sort(), ["claude", "codex"]);
});

test("여러 에이전트가 답할 때는 한 명씩 차례로, 뒤 순서는 앞 답변을 읽고 답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99, // Fisher-Yates에서 스왑 없음 → [claude, codex] 순서 고정
    runAgent: fakeRunner(
      {
        claude: [{ ok: true, text: "첫 번째 의견이야" }],
        codex: [{ ok: true, text: "이어서 보완할게요" }],
      },
      calls
    ),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  // 첫 순서는 순차 안내가 없고, 두 번째는 앞 답변이 대화 기록에 있고 반복 금지 안내를 받는다.
  assert.doesNotMatch(calls[0].prompt, /차례로 답하는 중/);
  assert.match(calls[1].prompt, /2번째입니다/);
  assert.match(calls[1].prompt, /첫 번째 의견이야/);
});

test("브로드캐스트 응답 순서는 주입한 난수원에 따라 섞인다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0, // Fisher-Yates에서 항상 스왑 → [codex, claude] 순서
    runAgent: fakeRunner({}, calls),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude"]);
});

test("방 전체에서 에이전트 실행은 언제나 한 번에 하나뿐이다", async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return {
        promise: new Promise((resolve) => setImmediate(() => {
          active -= 1;
          resolve({ ok: true, text: `${agent.id} 답변` });
        })),
        cancel: () => {},
      };
    },
  });
  room.sendUserMessage("모두 한 턴씩 말해");
  await settle(room);

  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(maxActive, 1);
});

test("브로드캐스트 대기 턴과 멘션 호출이 겹치면 한 턴으로 병합한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex 이어서 말해줘" }],
      codex: [{ ok: true, text: "한 번만 답할게요" }],
    }, calls),
  });
  room.sendUserMessage("둘 다 의견 줘");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
});

test("서로 다른 사용자 메시지의 같은 에이전트 턴은 합치지 않는다", async () => {
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: "두 번째 답" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 첫 질문");
  room.sendUserMessage("@codex 둘째 질문");
  releaseFirst({ ok: true, text: "첫 번째 답" });
  await settle(room);

  assert.deepEqual(calls, ["codex", "codex"]);
});

test("한 답변에서 여러 명을 호출해도 전역 큐 순서대로 한 명씩 답한다", async () => {
  const agents = makeAgents();
  agents[2].available = true;
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const replies = {
    claude: [{ ok: true, text: "@codex 먼저, @agy도 다음에 답해줘" }],
    codex: [{ ok: true, text: "Codex 답" }],
    agy: [{ ok: true, text: "AGY 답" }],
  };
  const room = new ChatRoom({
    agents,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = replies[agent.id].shift();
      return {
        promise: new Promise((resolve) => setImmediate(() => {
          active -= 1;
          resolve(result);
        })),
        cancel: () => {},
      };
    },
  });
  room.sendUserMessage("@claude 의견을 이어가줘");
  await settle(room);

  assert.deepEqual(calls, ["claude", "codex", "agy"]);
  assert.equal(maxActive, 1);
});

test("설치되지 않은 에이전트를 부르면 이유가 담긴 시스템 안내를 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("@agy 있니?");
  await settle(room);

  assert.equal(calls.length, 0);
  const systemMessages = room.messages.filter((message) => message.authorType === "system");
  assert.equal(systemMessages.length, 1);
  assert.match(systemMessages[0].text, /설치되어 있지 않습니다/);
});

test("세션에서 비활성화된 에이전트는 멘션해도 실행되지 않는다", async () => {
  const agents = makeAgents();
  agents[1].enabled = false;
  const calls = [];
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}, calls) });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  assert.equal(calls.length, 0);
  const systemMessages = room.messages.filter((message) => message.authorType === "system");
  assert.match(systemMessages[0].text, /비활성화/);
});

test("에이전트가 @이름으로 부르면 그 에이전트가 이어서 응답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        claude: [{ ok: true, text: "@codex 네 생각은? Antigravity 얘기도 참고해." }],
        codex: [{ ok: true, text: "불려서 답합니다." }],
      },
      calls
    ),
  });
  room.sendUserMessage("@claude 의견 줘");
  await settle(room);

  // @codex는 실제 호출, @ 없는 "Antigravity"는 언급이라 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 2);
  assert.equal(agentMessages[1].author, "codex");
});

test("멘션 연쇄는 깊이 상한에서 멈추고 자기 호출은 무시된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        // claude(깊이 0) → codex(1) → claude(2)에서 상한 도달, codex 재호출 없음.
        claude: [
          { ok: true, text: "@claude 나 말고 @codex 어때?" },
          { ok: true, text: "@codex 다시 부른다!" },
        ],
        codex: [{ ok: true, text: "@claude 되물을게요." }],
      },
      calls
    ),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);

  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude"]);
  assert.match(calls[1].prompt, /그러면 그 참가자가 이어서 답합니다/);
  assert.match(calls[2].prompt, /추가 호출할 수 없습니다/);
});

test("코드·이메일·그룹 별칭은 에이전트 답변에서 추가 호출을 만들지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "`@codex` contact@codex.dev @모두" }],
    }, calls),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("토론 답변의 @멘션은 자체 턴 외 추가 호출을 만들지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    discussionRunBudget: 1,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex 확인해줘\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
    }, calls),
  });
  await room.startDiscussion();
  await settle(room);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  assert.match(calls[0].prompt, /추가 호출할 수 없습니다/);
});

test("멘션 연쇄 응답에도 원래 첨부를 전달한다", async () => {
  const calls = [];
  const attachment = { id: "a", name: "review.txt", kind: "text" };
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "@codex도 파일을 확인해줘" }],
      codex: [{ ok: true, text: "확인했어요" }],
    }, calls),
  });
  room.sendUserMessage({ text: "@claude 검토해", attachments: [attachment] });
  await settle(room);
  assert.deepEqual(calls.map((call) => call.attachments), [[attachment], [attachment]]);
});

test("멘션 호출도 비활성·미설치 에이전트는 건너뛴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      { claude: [{ ok: true, text: "@agy 있어?" }] },
      calls
    ),
  });
  room.sendUserMessage("@claude 시작해");
  await settle(room);

  // agy는 available:false라 멘션 호출로도 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("자율 토론은 차례로 말하고 결론 신호에서 즉시 끝난다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "첫 의견\n[[CODEPET_DISCUSSION:CONTINUE]]" }],
      codex: [{ ok: true, text: "최종 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
    }, calls),
  });
  const result = await room.startDiscussion();
  await settle(room);

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex"]
  );
  assert.match(calls[0].prompt, /자율 토론 1\/9턴/);
  assert.equal(result.concluded, true);
  const notices = room.messages.filter((message) => message.authorType === "system");
  assert.match(notices[0].text, /토론 시작/);
  assert.match(notices.at(-1).text, /합의하거나 결론/);
});

test("Professional Mode 변경 후에도 자율 토론은 기존 권한과 앞선 transcript를 전달한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-read" },
    runAgent: ({ agent, prompt, permissionMode, specialistStage }) => {
      calls.push({ agentId: agent.id, prompt, permissionMode, specialistStage });
      const text = agent.id === "claude"
        ? "첫 토론 의견\n[[CODEPET_DISCUSSION:CONTINUE]]"
        : "두 번째 토론 의견\n[[CODEPET_DISCUSSION:CONCLUDE]]";
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });

  const result = await room.startDiscussion({ rounds: 1 });
  await settle(room);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.permissionMode, "workspace-read");
    assert.equal(call.specialistStage, null);
    assert.match(call.prompt, /=== 대화 ===/);
    assert.doesNotMatch(call.prompt, /clean-room/);
  }
  assert.match(calls[1].prompt, /첫 토론 의견/);
});

test("모든 참가자가 새 내용 없이 동의/패스하면 토론을 끝낸다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "동의합니다.\n[[CODEPET_DISCUSSION:AGREE]]" }],
      codex: [{ ok: true, text: "[[CODEPET_DISCUSSION:PASS]]" }],
    }, calls),
  });
  const result = await room.startDiscussion();
  assert.equal(result.concluded, true);
  assert.equal(calls.length, 2);
});

test("토론 총 실행 예산이 라운드와 독립적으로 강제된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    discussionRunBudget: 3,
    runAgent: fakeRunner({}, calls),
  });
  const result = await room.startDiscussion({ rounds: 2 });
  await settle(room);

  assert.equal(result.truncated, true);
  assert.equal(calls.length, 3);
  const budgetNotice = room.messages.find(
    (message) => message.authorType === "system" && /예산/.test(message.text)
  );
  assert.ok(budgetNotice);
});

test("토론에는 사용 가능한 에이전트가 두 명 이상 필요하다", async () => {
  const agents = makeAgents();
  agents[1].enabled = false; // codex 비활성화 → claude만 남음
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  const result = await room.startDiscussion({ rounds: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /두 명 이상/);
});

test("중지하면 토론 나머지 실행이 취소된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return {
        promise: new Promise((resolve) => {
          setImmediate(() => {
            if (calls.length === 1) room.stopAll();
            resolve({ ok: true, text: "답" });
          });
        }),
        cancel: () => {},
      };
    },
  });
  await room.startDiscussion({ rounds: 3 });
  await settle(room);

  // 첫 실행 도중 stopAll → 이후 슬롯은 세대 검사로 모두 건너뛴다.
  assert.equal(calls.length, 1);
});

test("토론 종료 표기는 이모티콘 위치 데이터나 화면 본문에 남지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    discussionRunBudget: 1,
    runAgent: fakeRunner({
      claude: [{
        ok: true,
        text: "결론입니다.\n[[CODEPET_EMOTE:검토완료]]\n[[CODEPET_DISCUSSION:CONCLUDE]]",
      }],
    }),
  });
  await room.startDiscussion();
  await settle(room);

  const response = room.messages.find((message) => message.author === "claude");
  assert.equal(response.text, "결론입니다.");
  assert.equal(response.contentParts, undefined);
});

test("토론 중 예약된 일반 응답은 토론이 끝날 때까지 발언하지 않는다", async () => {
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents: makeAgents(),
    discussionRunBudget: 2,
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, discussion: /자율 토론/.test(prompt) });
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      const text = /자율 토론/.test(prompt)
        ? "토론 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]"
        : "별도 질문 답변";
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });

  const discussion = room.startDiscussion();
  await new Promise((resolve) => setImmediate(resolve));
  room.sendUserMessage("@codex 별도 질문");
  releaseFirst({ ok: true, text: "첫 의견\n[[CODEPET_DISCUSSION:CONTINUE]]" });
  await discussion;
  await settle(room);

  assert.deepEqual(calls, [
    { agentId: "claude", discussion: true },
    { agentId: "codex", discussion: true },
    { agentId: "codex", discussion: false },
  ]);
});


test("토론 종료 시 discussionMeta가 남고 summarizeDiscussion으로 결론을 요약한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: "첫 토론 의견\n[[CODEPET_DISCUSSION:CONTINUE]]" },
        { ok: true, text: "## 논의 주제\n주제\n## 공통 합의점\n합의" },
      ],
      codex: [{ ok: true, text: "두 번째 의견 및 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
    }, calls),
  });

  room.appendMessage({ authorType: "user", author: "user", text: "이전 세션 질문" });
  room.appendMessage({ authorType: "user", author: "user", text: "이번 토론 질문" });
  const discResult = await room.startDiscussion();
  await settle(room);
  assert.equal(discResult.ok, true);

  const endNotice = room.messages.find((m) => m.discussionMeta);
  assert.ok(endNotice);
  assert.ok(endNotice.discussionMeta.discussionId);
  assert.equal(endNotice.discussionMeta.concluded, true);
  assert.equal(endNotice.discussionMeta.incomplete, false);

  // 토론 종료 후 추가 발언
  room.appendMessage({ authorType: "agent", author: "codex", text: "토론 이후 발언" });

  // Claude로 토론 결론 종합
  const summaryResult = await room.summarizeDiscussion(endNotice.discussionMeta.discussionId, "claude");
  await settle(room);
  assert.equal(summaryResult.ok, true);

  const summaryCall = calls.at(-1);
  assert.equal(summaryCall.agentId, "claude");
  // 이번 토론 질문과 토론 발언은 포함되고, 토론 이후 발언은 포함되지 않아야 함
  assert.match(summaryCall.prompt, /이번 토론 질문/);
  assert.match(summaryCall.prompt, /첫 토론 의견/);
  assert.match(summaryCall.prompt, /두 번째 의견 및 결론/);
  assert.doesNotMatch(summaryCall.prompt, /토론 이후 발언/);
  assert.match(summaryCall.prompt, /Agora의 토론 결론 종합자/);

  const summaryMessage = room.messages.at(-1);
  assert.equal(summaryMessage.author, "claude");
  assert.ok(summaryMessage.discussionSummary);
  assert.equal(summaryMessage.discussionSummary.discussionId, endNotice.discussionMeta.discussionId);
});

test("존재하지 않는 토론 ID나 비활성 에이전트의 summarizeDiscussion 요청은 거부된다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({}),
  });
  const invalidDisc = await room.summarizeDiscussion("non-existent", "claude");
  assert.equal(invalidDisc.ok, false);
  assert.match(invalidDisc.error, /토론 기록을 찾을 수 없습니다/);

  const invalidAgent = await room.summarizeDiscussion("any", "unknown-agent");
  assert.equal(invalidAgent.ok, false);
  assert.match(invalidAgent.error, /사용할 수 없습니다/);
});

test("사용자가 중지한 토론도 discussionMeta가 보존되어 요약할 수 있다", async () => {
  const calls = [];
  let releaseFirst;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      if (calls.length === 1) {
        return {
          promise: new Promise((resolve) => { releaseFirst = resolve; }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: "요약 결과" }), cancel: () => {} };
    },
  });

  room.appendMessage({ authorType: "user", author: "user", text: "토론 질문" });
  const discPromise = room.startDiscussion();
  await new Promise((resolve) => setImmediate(resolve));

  // 토론 진행 중 사용자 중지
  room.stopAll();
  releaseFirst({ ok: true, text: "첫 발언 진행 중 취소" });
  await discPromise;
  await settle(room);

  const endNotice = room.messages.find((m) => m.discussionMeta);
  assert.ok(endNotice);
  assert.equal(endNotice.discussionMeta.incomplete, true);
  assert.equal(endNotice.discussionMeta.reason, "interrupted");

  // 중지된 토론도 요약 가능
  const summaryResult = await room.summarizeDiscussion(endNotice.discussionMeta.discussionId, "claude");
  await settle(room);
  assert.equal(summaryResult.ok, true);
  const lastCall = calls.at(-1);
  assert.match(lastCall.prompt, /미완성.*상태로 종료/);
});

test("동일 토론에 대한 동시 summarizeDiscussion 호출은 중복 실행되지 않는다", async () => {
  const calls = [];
  let resolveSummary;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "토론 결론\n[[CODEPET_DISCUSSION:CONCLUDE]]" }],
      codex: [{ ok: true, text: "동의\n[[CODEPET_DISCUSSION:AGREE]]" }],
    }),
  });

  room.appendMessage({ authorType: "user", author: "user", text: "토론 질문" });
  await room.startDiscussion();
  await settle(room);

  const endNotice = room.messages.find((m) => m.discussionMeta);
  assert.ok(endNotice);

  // 러너를 지연 러너로 변경
  room.runAgent = ({ agent, prompt }) => {
    calls.push({ agentId: agent.id, prompt });
    return {
      promise: new Promise((resolve) => { resolveSummary = resolve; }),
      cancel: () => {},
    };
  };

  // 2번 연속 호출
  const p1 = room.summarizeDiscussion(endNotice.discussionMeta.discussionId, "claude");
  const p2 = room.summarizeDiscussion(endNotice.discussionMeta.discussionId, "claude");
  assert.equal(p1, p2); // 동일 promise 반환 (deduplication)

  resolveSummary({ ok: true, text: "요약 완료" });
  await p1;
  await settle(room);
  assert.equal(calls.length, 1); // 1번만 실행됨
});

test("토론 결론 종합 시 오류 메시지는 요약 대상에서 제외된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: false, text: "오류 발생!", error: "연결 실패" }],
    }, calls),
  });

  room.appendMessage({ authorType: "user", author: "user", text: "토론 질문" });
  const discResult = await room.startDiscussion();
  await settle(room);
  
  // 실패를 포함해 조기 종료됨을 확인
  assert.equal(discResult.ok, true);
  const endNotice = room.messages.find((m) => m.discussionMeta);
  assert.ok(endNotice);
  assert.equal(endNotice.discussionMeta.incomplete, true);
  assert.equal(endNotice.discussionMeta.failures, 1);

  // 러너 변경 (codex로 요약)
  room.runAgent = ({ agent, prompt }) => {
    calls.push({ agentId: agent.id, prompt });
    return {
      promise: Promise.resolve({ ok: true, text: "요약 완료" }),
      cancel: () => {},
    };
  };

  const summaryResult = await room.summarizeDiscussion(endNotice.discussionMeta.discussionId, "codex");
  await settle(room);
  assert.equal(summaryResult.ok, true);
  
  const lastCall = calls.at(-1);
  assert.equal(lastCall.agentId, "codex");
  // 질문은 포함됨
  assert.match(lastCall.prompt, /토론 질문/);
  // 실패 메시지 원문이나 "응답 실패 오류" 같은 문구가 없어야 함
  assert.doesNotMatch(lastCall.prompt, /연결 실패/);
  assert.doesNotMatch(lastCall.prompt, /오류 발생!/);
  assert.doesNotMatch(lastCall.prompt, /응답 실패 오류/);
});


test("중지하면 진행 중인 턴뿐 아니라 전역 큐의 대기 턴도 폐기한다", async () => {
  const calls = [];
  let resolveActive;
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return {
        promise: new Promise((resolve) => { resolveActive = resolve; }),
        cancel: () => resolveActive({ ok: false, cancelled: true }),
      };
    },
  });
  room.sendUserMessage("둘 다 답해");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAll();
  await settle(room);

  assert.deepEqual(calls, ["claude"]);
  assert.equal(room.turnQueue.length, 0);
});

test("턴 상태는 현재 발언자와 취소 가능한 대기 턴을 공개한다", async () => {
  let releaseActive;
  const states = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => ({
      promise: agent.id === "claude"
        ? new Promise((resolve) => { releaseActive = resolve; })
        : Promise.resolve({ ok: true, text: "두 번째 답" }),
      cancel: () => {},
    }),
  });
  room.on("turn-state", (state) => states.push(state));

  room.sendUserMessage("둘 다 답해");
  await new Promise((resolve) => setImmediate(resolve));

  const snapshot = room.turnState();
  assert.equal(snapshot.current, "claude");
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.queue[0].agentId, "codex");
  assert.equal(room.cancelTurn(snapshot.queue[0].turnId), true);
  assert.equal(room.turnState().queue.length, 0);

  releaseActive({ ok: true, text: "첫 번째 답" });
  await settle(room);
  assert.ok(states.some((state) => state.current === "claude"));
  assert.equal(states.at(-1).current, null);
});

test("사용자 개입은 현재 응답과 대기 턴을 함께 중지하고 늦은 결과를 버린다", async () => {
  const calls = [];
  let cancelled = false;
  let resolveActive;
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.99,
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return {
        promise: new Promise((resolve) => { resolveActive = resolve; }),
        cancel: () => {
          cancelled = true;
          resolveActive({ ok: true, text: "취소 뒤 늦은 답변 @codex" });
        },
      };
    },
  });
  room.sendUserMessage("둘 다 답해");
  await new Promise((resolve) => setImmediate(resolve));

  const result = room.interject();
  await settle(room);

  assert.deepEqual(result, { dropped: 1, interrupted: true });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ["claude"]);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
  assert.equal(room.turnState().queue.length, 0);
  assert.match(room.messages.at(-1).text, /다음 차례는 사용자/);
});

test("권한 요청을 승인하면 같은 턴을 자동 승인으로 한 번 다시 실행한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, autoApprove }) => {
      calls.push({ agentId: agent.id, autoApprove });
      return {
        promise: Promise.resolve(autoApprove
          ? { ok: true, text: "승인 후 완료" }
          : { ok: false, approvalRequired: true, approval: { summary: "명령 권한" } }),
        cancel: () => {},
      };
    },
  });
  room.once("approval-request", ({ approvalId }) => room.resolveApproval(approvalId, "approve"));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);
  assert.deepEqual(calls, [
    { agentId: "codex", autoApprove: false },
    { agentId: "codex", autoApprove: true },
  ]);
  assert.equal(room.messages.at(-1).text, "승인 후 완료");
});

test("실패한 응답은 오류 메시지로 남는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: false, error: "시간 초과 (300초)" }] }),
  });
  room.sendUserMessage("@codex 응답해라");
  await settle(room);

  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(agentMessages.length, 1);
  assert.equal(agentMessages[0].error, true);
});

test("오류 메시지는 다음 프롬프트의 대화 기록에서 제외된다", async () => {
  const prompts = [];
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt }) => {
      calls.push(agent.id);
      prompts.push(prompt);
      const result =
        calls.length === 1 ? { ok: false, error: "빈 응답" } : { ok: true, text: "복구!" };
      return { promise: Promise.resolve(result), cancel: () => {} };
    },
  });
  room.sendUserMessage("@codex 하나");
  await settle(room);
  room.sendUserMessage("@codex 둘");
  await settle(room);

  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1], /빈 응답/);
});

test("출력 상한으로 중단되면 timeout이나 일반 오류와 구분해 기록한다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [
        {
          ok: false,
          outputLimited: true,
          error: "출력이 설정된 상한을 넘어 실행을 중단했습니다.",
          partialText: "여기까지 진행했습니다",
          output: { stdoutBytes: 4096, outputLimited: true, captureTruncated: true },
        },
      ],
    }),
  });
  room.sendUserMessage("@codex 실행해");
  await settle(room);

  const failure = room.messages.find((message) => message.error);
  assert.equal(failure.failureKind, "output-limit");
  // 중단 전까지 받은 출력이 사라지지 않아야 합니다.
  assert.equal(failure.partialText, "여기까지 진행했습니다");
  assert.equal(failure.runOutput.outputLimited, true);
  assert.equal(failure.runOutput.stdoutBytes, 4096);
});

test("시간 초과 실패는 timeout으로 표시하고 중간 출력을 보존한다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [
        {
          ok: false,
          timedOut: true,
          error: "시간 초과 (30초)",
          partialText: "부분 응답",
        },
      ],
    }),
  });
  room.sendUserMessage("@codex 실행해");
  await settle(room);

  const failure = room.messages.find((message) => message.error);
  assert.equal(failure.failureKind, "timeout");
  assert.equal(failure.partialText, "부분 응답");
});

test("일반 실패는 error로 표시되고 출력 상한 표시가 붙지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{ ok: false, error: "네트워크 오류" }],
    }),
  });
  room.sendUserMessage("@codex 실행해");
  await settle(room);

  const failure = room.messages.find((message) => message.error);
  assert.equal(failure.failureKind, "error");
  assert.equal(failure.partialText, undefined);
});

test("중지하면 진행 중인 실행을 취소하고 늦은 결과를 버린다", async () => {
  let cancelled = false;
  let resolveRun;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: () => ({
      promise: new Promise((resolve) => {
        resolveRun = resolve;
      }),
      cancel: () => {
        cancelled = true;
        resolveRun({ ok: false, error: "중지됨", cancelled: true });
      },
    }),
  });
  room.sendUserMessage("@claude 오래 걸리는 일");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAll();
  await settle(room);

  assert.equal(cancelled, true);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
  assert.equal(room.state().typing.length, 0);
});

test("세대가 바뀐 뒤 도착한 성공 결과도 버려진다 (stale-run 가드)", async () => {
  let resolveRun;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: () => ({
      promise: new Promise((resolve) => {
        resolveRun = resolve;
      }),
      cancel: () => {},
    }),
  });
  room.sendUserMessage("@claude 질문");
  await new Promise((resolve) => setImmediate(resolve));
  room.stopAllSilently();
  resolveRun({ ok: true, text: "늦은 응답" });
  await settle(room);

  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
});

test("run-event가 시작/진행/종료 순으로 전달된다", async () => {
  const events = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ emitEvent }) => ({
      promise: new Promise((resolve) => {
        setImmediate(() => {
          emitEvent({ kind: "status", label: "생각 중" });
          emitEvent({ kind: "delta", text: "부분" });
          resolve({ ok: true, text: "최종" });
        });
      }),
      cancel: () => {},
    }),
  });
  room.on("run-event", (event) => events.push(event));
  room.sendUserMessage("@claude 진행 보여줘");
  await settle(room);

  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds, ["run-start", "status", "delta", "run-end"]);
  assert.equal(events[0].agentId, "claude");
  assert.ok(events[0].runId);
});

test("전문 실행 이벤트와 메시지는 일반 채팅 모델 대신 실제 역할 모델을 남긴다", async () => {
  const events = [];
  const room = new ChatRoom({
    agents: makeAgents().map((agent) =>
      agent.id === "codex" ? { ...agent, model: "gpt-chat-default", effort: "medium" } : agent
    ),
    runAgent: fakeRunner({
      codex: [{ ok: true, text: "구현 완료\nSTATUS: DONE" }],
      claude: [{ ok: true, text: "검수 통과\nVERDICT: PASS" }],
    }),
  });
  room.on("run-event", (event) => events.push(event));

  const result = await room.startSpecialist({
    stages: {
      implementation: {
        agent: room.findAgent("codex"),
        agentConfig: { model: "gpt-role-builder", effort: "high" },
      },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });

  assert.equal(result.ok, true);
  const start = events.find(
    (event) => event.kind === "run-start" && event.specialistStage === "implementation"
  );
  assert.equal(start.model, "gpt-role-builder");
  assert.equal(start.effort, "high");
  const message = room.messages.find(
    (entry) => entry.agentMeta?.specialistStage === "implementation"
  );
  assert.equal(message.agentMeta.model, "gpt-role-builder");
  assert.equal(message.agentMeta.effort, "high");
});

test("첨부가 있는 사용자 메시지는 첨부 메타와 함께 저장되고 러너로 전달된다", async () => {
  const received = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ attachments, prompt }) => {
      received.push({ attachments, prompt });
      return { promise: Promise.resolve({ ok: true, text: "봤어요" }), cancel: () => {} };
    },
  });
  const attachment = { id: "abc", name: "shot.png", mime: "image/png", size: 10, kind: "image" };
  room.sendUserMessage({ text: "@claude 이것 봐", attachments: [attachment] });
  await settle(room);

  const userMessage = room.messages.find((message) => message.authorType === "user");
  assert.deepEqual(userMessage.attachments, [attachment]);
  assert.deepEqual(received[0].attachments, [attachment]);
  assert.match(received[0].prompt, /\[첨부: shot\.png\]/);
});

test("텍스트 없이 첨부만으로도 메시지를 보낼 수 있다", () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const entry = room.sendUserMessage({
    text: "",
    attachments: [{ id: "a", name: "f.txt", mime: "text/plain", size: 1, kind: "text" }],
  });
  assert.ok(entry);
  assert.equal(room.messages.length, 1);
});

test("대화 지우기는 메시지를 비우고 reset 이벤트를 낸다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  let resetCount = 0;
  room.on("reset", () => {
    resetCount += 1;
  });
  room.sendUserMessage("안녕");
  room.clear();

  assert.equal(room.messages.length, 0);
  assert.equal(resetCount, 1);
});

test("publicAgents에는 실행 경로 정보가 없다", () => {
  const agents = makeAgents();
  agents[0].commandPath = "C:\\secret\\claude.exe";
  agents[0].needsShell = true;
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}) });
  const json = JSON.stringify(room.state());
  assert.ok(!json.includes("commandPath"));
  assert.ok(!json.includes("needsShell"));
  assert.ok(!json.includes("secret"));
});

test("독립 발언 모드(independent: true)에서는 같은 턴의 형제 응답을 포함하지 않고 broadcast 힌트를 억제한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: [
      { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
      { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    ],
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: `${agent.id}의 독립 응답` }), cancel: () => {} };
    },
  });

  room.sendUserMessage({ text: "@all 문제점 조사해", independent: true });
  await settle(room);

  assert.equal(calls.length, 2);
  // 두 에이전트의 프롬프트 모두에 형제 메시지나 broadcast 문구가 없어야함
  for (const call of calls) {
    assert.ok(!call.prompt.includes("앞선 참가자의 답변을 읽고"));
    assert.ok(!call.prompt.includes("독립 응답"));
  }
});

test("이어 발언 모드(independent: false)에서는 같은 턴의 앞선 답변이 다음 에이전트에 포함된다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: [
      { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
      { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
    ],
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: `${agent.id}의 순차 응답` }), cancel: () => {} };
    },
  });

  room.sendUserMessage({ text: "@all 문제점 조사해", independent: false });
  await settle(room);

  assert.equal(calls.length, 2);
  // 두번째 호출된 에이전트는 첫번째 에이전트의 응답을 참조함
  const secondCall = calls[1];
  assert.ok(secondCall.prompt.includes("앞선 참가자의 답변을 읽고"));
  assert.ok(secondCall.prompt.includes("의 순차 응답"));
});

test("handoffMessage의 SIMPLIFY_SELF intent는 원문 작성자에게 당시 모델로 쉬운 말 번역을 요청한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "쉽게 풀어서 설명한 내용입니다." }] }, calls),
  });
  room.messages.push({
    id: "msg-complex",
    authorType: "agent",
    author: "claude",
    text: "복잡한 아키텍처 및 뮤텍스 락 설명",
    agentMeta: { model: "sonnet-legacy", effort: "high" },
  });

  // 직접 버튼: 같은 저자 + 같은 모델 고정
  const result = room.handoffMessage("claude", "msg-complex", "SIMPLIFY_SELF");
  assert.equal(result.ok, true);
  await settle(room);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "claude");
  assert.match(calls[0].prompt, /비개발자도 이해하기 쉽게 풀어주는 통역가/);
  assert.match(calls[0].prompt, /풀어볼 원문 메시지/);
  assert.match(calls[0].prompt, /복잡한 아키텍처 및 뮤텍스 락 설명/);

  const responseMsg = room.messages.at(-1);
  assert.equal(responseMsg.author, "claude");
  assert.equal(responseMsg.agentMeta.model, "sonnet-legacy");
  assert.equal(responseMsg.agentMeta.effort, "high");
  assert.ok(responseMsg.simplifyMeta);
  assert.equal(responseMsg.simplifyMeta.messageId, "msg-complex");
});

test("handoffMessage의 SIMPLIFY_SELF는 원문 작성자가 아닌 에이전트로는 실행되지 않는다(fallback 금지)", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: true, text: "대체 실행" }] }, calls),
  });
  room.messages.push({ id: "msg-x", authorType: "agent", author: "claude", text: "원문", agentMeta: { model: "sonnet-3.5" } });

  const result = room.handoffMessage("codex", "msg-x", "SIMPLIFY_SELF");
  assert.equal(result.ok, false, "다른 에이전트로 대체 실행되면 안 된다");
  assert.match(result.error, /원문을 작성한 에이전트/);
  await settle(room);
  assert.equal(calls.length, 0, "대체 에이전트가 실행되면 안 된다");
});

test("handoffMessage의 SIMPLIFY_SELF는 원문 모델 메타데이터가 없으면 fail한다(현재 모델 fallback 금지)", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "fallback 실행" }] }, calls),
  });
  // agentMeta가 없는 레거시 메시지
  room.messages.push({ id: "msg-nometa", authorType: "agent", author: "claude", text: "원문" });

  const result = room.handoffMessage("claude", "msg-nometa", "SIMPLIFY_SELF");
  assert.equal(result.ok, false, "모델 메타데이터가 없으면 실패해야 한다");
  assert.match(result.error, /원문 작성 당시 실제 모델/);
  await settle(room);
  assert.equal(calls.length, 0, "fallback 실행되면 안 된다");
});

test("handoffMessage의 SIMPLIFY_SELF는 default 모델만 있고 resolvedModel이 없으면 fail한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "fallback 실행" }] }, calls),
  });
  room.messages.push({
    id: "msg-default-only",
    authorType: "agent",
    author: "claude",
    text: "default 모델 원문",
    agentMeta: { model: "default", effort: "default" },
  });

  const result = room.handoffMessage("claude", "msg-default-only", "SIMPLIFY_SELF");
  assert.equal(result.ok, false, "resolvedModel이 없는 default 모델은 fail해야 한다");
  assert.match(result.error, /원문 작성 당시 실제 모델/);
  await settle(room);
  assert.equal(calls.length, 0);
});

test("handoffMessage의 SIMPLIFY_SELF는 resolvedModel이 있으면 해당 실제 모델을 고정해 재실행한다", async () => {
  const calls = [];
  const agents = makeAgents();
  // 현재 claude의 설정은 opus로 변경된 상태
  const claudeAgent = agents.find((a) => a.id === "claude");
  claudeAgent.model = "claude-opus-latest";

  const room = new ChatRoom({
    agents,
    runAgent: fakeRunner({ claude: [{ ok: true, text: "resolved 모델로 실행" }] }, calls),
  });
  // 원문 작성 당시에는 "default" 설정이었지만 실제로는 resolvedModel("claude-sonnet-legacy")로 실행됨
  room.messages.push({
    id: "msg-default-model",
    authorType: "agent",
    author: "claude",
    text: "default 모델 원문",
    agentMeta: { model: "default", resolvedModel: "claude-sonnet-legacy", effort: "default" },
  });

  const result = room.handoffMessage("claude", "msg-default-model", "SIMPLIFY_SELF");
  assert.equal(result.ok, true);
  await settle(room);

  assert.equal(calls.length, 1);
  // 현재 설정(claude-opus-latest)으로 drift되지 않고 agentConfig에 실제 원문 모델(claude-sonnet-legacy)이 pin되어야 한다
  const responseMsg = room.messages.at(-1);
  assert.equal(responseMsg.agentMeta.model, "claude-sonnet-legacy");
});

test("handoffMessage의 Handoff SIMPLIFY는 선택한 다른 AI가 자신의 모델로 원문을 쉽게 설명한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: true, text: "Codex가 쉽게 풀어서 설명한 내용입니다." }] }, calls),
  });
  // 원문은 claude가 sonnet-legacy 모델로 작성
  room.messages.push({
    id: "msg-model",
    authorType: "agent",
    author: "claude",
    text: "Claude가 작성한 어려운 원문",
    agentMeta: { model: "sonnet-legacy", effort: "high" },
  });

  // Handoff로 codex를 선택해 쉽게 설명 요청
  const result = room.handoffMessage("codex", "msg-model", "SIMPLIFY");
  assert.equal(result.ok, true);
  await settle(room);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "codex");
  assert.match(calls[0].prompt, /Claude가 작성한 어려운 원문/);

  const responseMsg = room.messages.at(-1);
  assert.equal(responseMsg.author, "codex");
  // Claude의 과거 모델(sonnet-legacy)이 Codex에 강제되지 않는다
  assert.notEqual(responseMsg.agentMeta?.model, "sonnet-legacy");
  assert.ok(responseMsg.simplifyMeta);
  assert.equal(responseMsg.simplifyMeta.messageId, "msg-model");
  assert.equal(responseMsg.simplifyMeta.fromAgentId, "claude");
});

test("handoffMessage는 다른 AI의 메시지를 대상 에이전트에게 전달해 이어서 답하게 한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ codex: [{ ok: true, text: "전달받아 이어서 답합니다." }] }, calls),
  });
  // 다른 AI(claude)가 보낸 메시지를 소스로 준비한다.
  room.messages.push({ id: "msg-h1", authorType: "agent", author: "claude", text: "구현 이슈 요약" });

  const result = room.handoffMessage("codex", "msg-h1", "REVIEW_OPINION");
  assert.equal(result.ok, true);
  await settle(room);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "codex");
  assert.ok(calls[0].prompt.includes("이전 메시지 전달 (Handoff)"));
  assert.ok(calls[0].prompt.includes("검토 요청"));
  assert.ok(calls[0].prompt.includes("구현 이슈 요약"));
});

test("handoffMessage는 없는 메시지나 사용자 메시지를 전달할 수 없다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  room.messages.push({ id: "msg-user", authorType: "user", author: "user", text: "안녕" });

  const noTarget = room.handoffMessage("codex", "없는-id", "CONTINUE");
  assert.equal(noTarget.ok, false);

  const noUser = room.handoffMessage("codex", "msg-user", "CONTINUE");
  assert.equal(noUser.ok, false);
});

test("TASK-007: Planner PLAN_READY 결과로 TASK.md를 만들고 workflow에 등록한다", async () => {
  const calls = [];
  const created = [];
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-task-"));
  const taskManager = new TaskManager();
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    taskManager,
    onTaskCreated: (task) => created.push(task),
    runAgent: fakeRunner(
      {
        claude: [
          { ok: true, text: makePlanContract("로그인") },
        ],
        codex: [
          { ok: true, text: "구현 완료\nSTATUS: DONE" },
          { ok: true, text: "검토 통과\nVERDICT: PASS" },
        ],
      },
      calls
    ),
  });

  const result = await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "quick",
  });

  // quick 모드: planner PLAN_READY → TASK 저장 → freeze → builder → review PASS
  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].contentSource, "file");
  assert.ok(created[0].taskPath.includes("TASK-001.md"));

  // TASK.md가 실제로 생성되었고 STATUS 마커가 제거되었는지 확인.
  const taskPath = path.join(ws, created[0].taskPath);
  assert.ok(fs.existsSync(taskPath));
  const taskContent = fs.readFileSync(taskPath, "utf8");
  assert.ok(!/STATUS:\s*PLAN_READY/.test(taskContent));
  assert.ok(taskContent.includes("로그인"));

  const builderPrompt = calls.find((call) => call.agentId === "codex").prompt;
  const frozenTaskBlock = builderPrompt.slice(
    builderPrompt.indexOf("=== 실행 계약 (Frozen Task) ==="),
    builderPrompt.indexOf("=== 실행 계약 끝 ===")
  );
  assert.ok(frozenTaskBlock.includes("로그인"));
  assert.ok(!frozenTaskBlock.includes("STATUS: PLAN_READY"));

  // Run snapshot이 생성되었는지 확인.
  const runsDir = path.join(ws, ".project-memory", "runs");
  assert.ok(fs.existsSync(runsDir));
});

test("TASK-007: step 모드에서 승인(resume) 후 같은 Frozen Task로 Builder/Reviewer가 실행된다", async () => {
  const calls = [];
  const created = [];
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-step-"));
  const taskManager = new TaskManager();
  let plannerReply = true;
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    taskManager,
    onTaskCreated: (task) => created.push(task),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      let reply;
      if (agent.id === "claude" && plannerReply) {
        plannerReply = false;
        reply = { ok: true, text: makePlanContract("메서드 분리") };
      } else if (agent.id === "codex") {
        reply = { ok: true, text: "수정 완료\nSTATUS: DONE" };
      } else {
        reply = { ok: true, text: "통과\nVERDICT: PASS" };
      }
      return { promise: Promise.resolve(reply), cancel: () => {} };
    },
  });

  const first = await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });

  // step 모드: PLAN_READY 후 승인 Gate에서 멈춤.
  assert.equal(first.ok, false);
  assert.equal(first.stopReason, "PLAN_READY");
  assert.equal(created.length, 1);

  // 승인 전에는 Run이 아직 생성되지 않아야 한다 (freeze는 승인 시점).
  const runsBefore = path.join(ws, ".project-memory", "runs");
  assert.ok(!fs.existsSync(runsBefore), "승인 전에는 Run이 없어야 한다");

  // 승인(resume) 후 Builder 실행 → step 모드라 builder_done에서 멈춤.
  const second = await room.resumeSpecialist();
  assert.equal(second.ok, false);
  assert.equal(second.stopReason, "BUILDER_DONE");
  assert.ok(calls.some((call) => call.agentId === "codex"), "Builder가 실행되어야 한다");

  // 다시 승인 → Reviewer 실행 → review_pass로 멈춤.
  const third = await room.resumeSpecialist();
  assert.equal(third.ok, false);
  assert.equal(third.stopReason, "REVIEW_PASS");

  // 마지막 승인 → 기록 후 완료.
  const fourth = await room.resumeSpecialist();
  assert.equal(fourth.ok, true);

  // Builder와 Reviewer 프롬프트 모두 같은 Frozen Task 본문을 봐야 한다.
  const builderPrompt = calls.find((call) => call.agentId === "codex").prompt;
  const reviewPrompt = calls.find((call) => call.agentId === "claude" && call.prompt.includes("Frozen Task")).prompt;
  assert.ok(builderPrompt.includes("실행 계약 (Frozen Task)"));
  assert.ok(builderPrompt.includes("메서드 분리"));
  assert.ok(reviewPrompt.includes("실행 계약 (Frozen Task)"));
  assert.ok(reviewPrompt.includes("메서드 분리"));

  // TASK-008: Reviewer 프롬프트에 Builder Diff 섹션이 주입되어야 한다.
  assert.ok(reviewPrompt.includes("실제 변경 (Builder Diff)"), "Reviewer에 Builder Diff 섹션이 있어야 한다");
});

test("step 모드가 완료·판단 불가로 끝나면 임시 Checkpoint를 정리한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-step-cleanup-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const checkpoint = { supported: true, id: "step-checkpoint" };
  const cleaned = [];
  let plannerReply = true;
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    checkpoint: {
      createCheckpoint: async () => checkpoint,
      cleanupCheckpoint: (value) => cleaned.push(value),
    },
    runAgent: ({ agent }) => {
      let text = "";
      if (agent.id === "claude" && plannerReply) {
        plannerReply = false;
        text = makePlanContract("정리");
      } else if (agent.id === "codex") {
        text = "구현 완료\nSTATUS: DONE";
      } else {
        text = "통과\nVERDICT: PASS";
      }
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });

  await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });
  await room.resumeSpecialist();
  await room.resumeSpecialist();
  const completed = await room.resumeSpecialist();

  assert.equal(completed.ok, true);
  assert.deepEqual(cleaned, [checkpoint]);
});

test("TASK-008: git workspace에서 Builder가 파일을 바꾸면 Reviewer가 실제 Diff를 받는다", async (t) => {
  const calls = [];
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-diff-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "init"]);

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      let reply;
      if (agent.id === "codex") {
        // Builder가 실제로 파일을 수정한다.
        fs.writeFileSync(path.join(ws, "a.txt"), "hello modified\n", "utf8");
        reply = { ok: true, text: "수정 완료\nSTATUS: DONE" };
      } else {
        reply = { ok: true, text: "통과\nVERDICT: PASS" };
      }
      return { promise: Promise.resolve(reply), cancel: () => {} };
    },
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });
  assert.equal(result.ok, true);

  const reviewPrompt = calls.find((call) => call.agentId === "claude").prompt;
  assert.ok(reviewPrompt.includes("실제 변경 (Builder Diff)"), "Reviewer에 Diff 섹션이 있어야 한다");
  assert.ok(reviewPrompt.includes("a.txt"), "Diff에 변경된 파일명이 포함되어야 한다");
  assert.ok(reviewPrompt.includes("hello modified"), "Diff에 실제 변경 내용이 포함되어야 한다");
});

// --- BLOCKED 후속 처리 (A안: 즉시 복원하지 않고 사용자 선택까지 보류) ---

test("BLOCKED이면 즉시 되돌리지 않고 Builder 변경을 남긴 채 사용자 선택을 기다린다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-blocked-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "init"]);

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    checkpoint: turnCheckpoint,
    runAgent: ({ agent }) => {
      if (agent.id === "codex") {
        // Builder가 절반쯤 고치고 막힌 상황.
        fs.writeFileSync(path.join(ws, "a.txt"), "half done\n", "utf8");
        return {
          promise: Promise.resolve({ ok: true, text: "명세가 모호합니다\nSTATUS: BLOCKED" }),
          cancel: () => {},
        };
      }
      return { promise: Promise.resolve({ ok: true, text: "통과\nVERDICT: PASS" }), cancel: () => {} };
    },
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "BLOCKED");
  assert.equal(result.blocked, true);
  assert.equal(result.canRestore, true);
  // A안 핵심: 이 시점에는 아직 되돌리지 않았으므로 Builder 변경이 남아 있어야 한다.
  assert.equal(
    fs.readFileSync(path.join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
    "half done\n"
  );
  assert.ok(room.specialistBlocked, "후속 선택을 기다리는 보류 상태가 있어야 한다");
});

test("BLOCKED 후 keep을 고르면 변경을 그대로 두고 보류 상태만 해제한다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-blocked-keep-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "init"]);

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    checkpoint: turnCheckpoint,
    runAgent: ({ agent }) => {
      if (agent.id === "codex") {
        fs.writeFileSync(path.join(ws, "a.txt"), "half done\n", "utf8");
        return { promise: Promise.resolve({ ok: true, text: "STATUS: BLOCKED" }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "VERDICT: PASS" }), cancel: () => {} };
    },
  });

  await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });

  const resolved = await room.resolveBlocked("keep");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.action, "keep");
  assert.equal(
    fs.readFileSync(path.join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
    "half done\n"
  );
  assert.equal(room.specialistBlocked, null);
});

test("BLOCKED 후 restore를 고르면 작업 전 상태로 되돌린다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-blocked-restore-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "init"]);

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    checkpoint: turnCheckpoint,
    runAgent: ({ agent }) => {
      if (agent.id === "codex") {
        fs.writeFileSync(path.join(ws, "a.txt"), "half done\n", "utf8");
        fs.writeFileSync(path.join(ws, "new-file.txt"), "builder made this\n", "utf8");
        return { promise: Promise.resolve({ ok: true, text: "STATUS: BLOCKED" }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "VERDICT: PASS" }), cancel: () => {} };
    },
  });

  await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });

  const resolved = await room.resolveBlocked("restore");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.restored, true);
  // 실행 전 내용으로 복원되고, Builder가 새로 만든 파일은 제거되어야 한다.
  // (Windows에서는 git이 줄바꿈을 CRLF로 바꿀 수 있어 줄바꿈은 정규화해 비교한다.)
  assert.equal(
    fs.readFileSync(path.join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"),
    "hello\n"
  );
  assert.equal(fs.existsSync(path.join(ws, "new-file.txt")), false);
  assert.equal(room.specialistBlocked, null);
});

test("보류 중인 BLOCKED가 없으면 후속 처리를 거부한다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, []) });
  const resolved = await room.resolveBlocked("keep");
  assert.equal(resolved.ok, false);
});

test("BLOCKED 후속 처리 동작 이름이 올바르지 않으면 거부한다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-blocked-bad-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    runAgent: ({ agent }) =>
      agent.id === "codex"
        ? { promise: Promise.resolve({ ok: true, text: "STATUS: BLOCKED" }), cancel: () => {} }
        : { promise: Promise.resolve({ ok: true, text: "VERDICT: PASS" }), cancel: () => {} },
  });
  await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
    mode: "step",
  });
  const resolved = await room.resolveBlocked("nope");
  assert.equal(resolved.ok, false);
});

// --- Frozen Task 인디케이터 (메시지 agentMeta 연결) ---

test("전문 실행 메시지에 Frozen Task 정보(runId/taskId/taskHash)가 실린다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-chip-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const taskManager = new TaskManager();
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    taskManager,
    runAgent: fakeRunner(
      {
        claude: [{ ok: true, text: makePlanContract("로그인") }],
        codex: [
          { ok: true, text: "구현 완료\nSTATUS: DONE" },
          { ok: true, text: "검토 통과\nVERDICT: PASS" },
        ],
      },
      []
    ),
  });

  const result = await room.startSpecialist({
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "quick",
  });
  assert.equal(result.ok, true);

  const builderMessage = room.messages.find(
    (message) => message.agentMeta?.specialistStage === "implementation"
  );
  assert.ok(builderMessage, "구현 단계 메시지가 있어야 한다");
  assert.equal(builderMessage.agentMeta.taskId, "TASK-001");
  assert.ok(builderMessage.agentMeta.runId?.startsWith("RUN-"));
  assert.ok(builderMessage.agentMeta.taskHash, "Task revision 해시가 있어야 한다");

  const reviewMessage = room.messages.find(
    (message) => message.agentMeta?.specialistStage === "review"
  );
  // Reviewer도 같은 Run/Task revision 기준이어야 한다.
  assert.equal(reviewMessage.agentMeta.runId, builderMessage.agentMeta.runId);
  assert.equal(reviewMessage.agentMeta.taskHash, builderMessage.agentMeta.taskHash);
});

test("일반 대화 메시지에는 Frozen Task 정보가 붙지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "안녕하세요" }] }, []),
  });
  room.sendUserMessage("@claude 안녕");
  await room.waitForIdle();
  const agentMessage = room.messages.find((message) => message.authorType === "agent");
  assert.ok(agentMessage);
  assert.equal(agentMessage.agentMeta.taskId, undefined);
  assert.equal(agentMessage.agentMeta.runId, undefined);
});

test("버튼형 기획·검수는 Planner와 Reviewer를 차례로 호출하고 구현 대기 상태를 남긴다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-plan-review-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("로그인 화면 개선") }],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(room.specialistState().planReady, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
  assert.match(calls[1].prompt, /전문 모드: 기획 검수/);
  // 승인된 기획안을 채팅에서 열어볼 수 있도록 경로/제목이 상태로 노출된다.
  const state = room.specialistState();
  assert.match(state.planTaskPath, /TASK-001\.md$/);
  assert.equal(state.planTaskId, "TASK-001");
  assert.equal(state.node, "READY");
  assert.equal(state.status, "WAITING");
});

test("기획 자동 보완은 범위 안의 검수 지적만 제한 횟수 안에서 다시 기획한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-plan-auto-revise-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("초안") },
        { ok: true, text: makePlanContract("검증 조건을 보완한 기획") },
      ],
      codex: [
        {
          ok: true,
          text: "검증 조건을 추가하세요.\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nrepeat: NO\nproblem: 검증 조건 누락\nevidence: 완료 조건에 테스트가 없음\nimpact: 완료 판단 불가",
        },
        { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
      ],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    planAutoRevisions: 2,
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude", "codex"]);
  assert.equal(room.specialistState().planTaskId, "TASK-001");
  assert.match(fs.readFileSync(path.join(workspace, ".project-memory", "tasks", "TASK-001.md"), "utf8"), /검증 조건을 보완한 기획/);
  assert.match(calls[3].prompt, /=== 이전 구조화 이슈 ===/);
  assert.match(calls[3].prompt, /repeat: NO/);
});

test("기획 자동 보완 중에도 Open Question은 사용자에게 반환한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-plan-auto-question-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("초안") }],
      codex: [{
        ok: true,
        text: "사용자 결정이 필요합니다.\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nproblem: 대상 미정\nevidence: 대화에 없음\nimpact: 범위 불명확\n## Open Questions\n1. 어느 화면까지 포함할까요?",
      }],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    planAutoRevisions: 3,
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "NEEDS_DECISION");
  assert.equal(room.specialistState().needsInput, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);

  // 화면에는 "기획 자동 보완 3회"가 켜져 있는데 이 경로는 그 예산을 한 번도 쓰지
  // 않는다. 그 사실을 밝히지 않으면 설정이 동작하지 않는 것처럼 보인다.
  const systemText = room.messages
    .filter((message) => message.authorType === "system")
    .map((message) => message.text)
    .join("\n");
  assert.match(systemText, /자동 보완\(0\/3회\)은 쓰지 않았습니다/);
});

test("구현 자동 보완 스위치 값은 버튼형 구현·검수의 제한 루프에 적용된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-implementation-auto-revise-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("자동 보완 구현") },
        { ok: true, text: "첫 구현\nSTATUS: DONE" },
        { ok: true, text: "보완 구현\nSTATUS: DONE" },
      ],
      codex: [
        { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
        {
          ok: true,
          text: "테스트를 보완하세요.\nVERDICT: FIX_REQUIRED\nISSUES:\n1.\nscope: IN\nseverity: BLOCKING\nlocation: test/a.test.js\nproblem: 테스트 누락\nevidence: 신규 경로 미검증\nimpact: 회귀 가능",
        },
        { ok: true, text: "구현 검수 통과\nVERDICT: PASS" },
      ],
    }, calls),
  });

  const plan = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });
  assert.equal(plan.ok, true);

  const result = await room.startSpecialist({
    action: "implementation",
    implementationAutoRevisions: 1,
    stages: {
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedIterations, 2);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "claude", "codex", "claude", "codex"]
  );
});

test("Open Question은 PLAN_READY 마커가 있어도 답변 대기로 멈추고 답변 후 기획을 다시 검수한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-plan-question-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("화면 개선", "## Open Question\n1. 어느 화면까지 포함할까요?") },
        { ok: true, text: makePlanContract("로그인 화면만 개선") },
      ],
      codex: [{ ok: true, text: "검수 통과\nVERDICT: PASS" }],
    }, calls),
  });
  const stages = {
    planner: { agent: room.findAgent("claude") },
    review: { agent: room.findAgent("codex") },
  };

  const first = await room.startSpecialist({ action: "plan", stages });
  assert.equal(first.stopReason, "NEEDS_DECISION");
  assert.equal(room.specialistState().needsInput, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);

  const second = await room.answerPlanQuestion("로그인 화면만 포함하세요.");
  assert.equal(second.ok, true);
  assert.equal(room.specialistState().planReady, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "claude", "codex"]);
  assert.match(calls[1].prompt, /로그인 화면만 포함하세요/);
});

test("전체 실행은 기획 검수 통과 뒤 구현·검수·기록까지 같은 전문 블록으로 이어간다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-professional-full-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("전체 실행") },
        { ok: true, text: "구현 완료\nSTATUS: DONE" },
      ],
      codex: [
        { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
        { ok: true, text: "구현 검수 통과\nVERDICT: PASS" },
        { ok: true, text: "{\"summary\":\"완료\",\"decisions\":[],\"nextActions\":[]}" },
      ],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "full",
    maxAutoRevisions: 1,
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude", "codex", "codex"]);
  assert.equal(room.specialistState().node, "COMPLETED");
  assert.equal(room.specialistState().status, "COMPLETED");
});

test("전체 실행은 Run 결과와 Workflow 수명주기를 함께 저장한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-run-lifecycle-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const lifecycle = [];
  const taskManager = new TaskManager();
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager,
    onTaskCreated: () => true,
    onProfessionalTaskState: (patch) => {
      lifecycle.push(patch);
      return true;
    },
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("수명주기 기록") },
        { ok: true, text: "구현 완료\nSTATUS: DONE" },
      ],
      codex: [
        { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
        { ok: true, text: "구현 검수 통과\nVERDICT: PASS" },
        { ok: true, text: '{"summary":"완료","decisions":[],"nextActions":[]}' },
      ],
    }),
  });

  const result = await room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(lifecycle.map((entry) => entry.status), ["in_progress", "review", "done"]);
  const runInfo = taskManager.runInfoForId("RUN-001", workspace);
  assert.equal(taskManager.readRunResult(runInfo).status, "COMPLETED");
  assert.equal(taskManager.readRunResult(runInfo).finalVerdict, "PASS");
});

test("Workflow 시작 기록에 실패하면 Builder를 실행하지 않는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-workflow-start-fail-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    onTaskCreated: () => true,
    onProfessionalTaskState: ({ status }) => status !== "in_progress",
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("저장 실패") }],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "WORKFLOW_WRITE_FAILED");
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
});

test("Planner TASK 파일은 Workflow 등록 실패 뒤에도 보존하고 TASK_INDEX_FAILED로 멈춘다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-index-fail-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    onTaskCreated: () => false,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("색인 실패") }],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.stopReason, "TASK_INDEX_FAILED");
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(path.join(workspace, ".project-memory", "tasks", "TASK-001.md")), true);
});

test("ACT 중 사용자 중지는 변경·Run 결과를 BLOCKED로 남기고 checkpoint를 정리하지 않는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-user-interrupt-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const taskManager = new TaskManager();
  let releaseBuilder;
  const builderStarted = new Promise((resolve) => { releaseBuilder = resolve; });
  let signalBuilderStarted;
  const builderBegan = new Promise((resolve) => { signalBuilderStarted = resolve; });
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager,
    onTaskCreated: () => true,
    runAgent: ({ agent, prompt }) => {
      if (agent.id === "claude" && /전문 모드: 기획 ===/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: makePlanContract("중지 보존") }), cancel: () => {} };
      }
      if (agent.id === "codex" && /전문 모드: 기획 검수/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "VERDICT: PASS" }), cancel: () => {} };
      }
      if (agent.id === "claude" && /전문 모드: 구현/.test(prompt)) {
        signalBuilderStarted();
        return {
          promise: builderStarted,
          cancel: () => releaseBuilder({ ok: false, cancelled: true }),
        };
      }
      throw new Error(`예상하지 않은 실행: ${agent.id}`);
    },
  });

  const execution = room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });
  await builderBegan;
  assert.equal(room.professionalRun.node, "IMPLEMENTING");
  const cancelled = room.cancelSpecialist();
  const result = await execution;

  assert.equal(cancelled.ok, true, "사용자 중지는 IPC에서 오류가 아닌 정상 동작이다");
  assert.equal(result.cancelled, true);
  assert.equal(room.specialistState().blocked, true);
  assert.equal(room.professionalRun.stopReason, "USER_INTERRUPTED");
  const runInfo = taskManager.runInfoForId("RUN-001", workspace);
  assert.equal(taskManager.readRunResult(runInfo).status, "BLOCKED");
});

test("PLAN 중 사용자 중지는 자동 재실행 없이 INTERRUPTED 상태로 남긴다", async () => {
  let releasePlanner;
  const plannerStarted = new Promise((resolve) => { releasePlanner = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => {
      assert.equal(agent.id, "claude");
      signalStarted();
      return { promise: plannerStarted, cancel: () => releasePlanner({ ok: false, cancelled: true }) };
    },
  });

  const execution = room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });
  await started;
  const cancelled = room.cancelSpecialist();
  const result = await execution;

  assert.equal(cancelled.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(room.professionalRun.node, "PLANNING");
  assert.equal(room.professionalRun.status, "INTERRUPTED");
  assert.equal(room.professionalRun.stopReason, "USER_INTERRUPTED");
  assert.equal(room.specialistState().blocked, false);
});

test("Professional Reviewer의 FIX_REQUIRED는 자동 복원 대신 BLOCKED로 남긴다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-review-fix-blocked-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const taskManager = new TaskManager();
  const lifecycle = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager,
    onTaskCreated: () => true,
    onProfessionalTaskState: (patch) => {
      lifecycle.push(patch);
      return true;
    },
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("검수 보류") },
        { ok: true, text: "구현 완료\nSTATUS: DONE" },
      ],
      codex: [
        { ok: true, text: "VERDICT: PASS" },
        { ok: true, text: "VERDICT: FIX_REQUIRED\nISSUES:\n- scope: IN\n  severity: BLOCKING\n  problem: 검증 보완 필요" },
      ],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "FIX_REQUIRED");
  assert.equal(room.specialistState().blocked, true);
  assert.equal(room.professionalRun.status, "BLOCKED");
  assert.equal(taskManager.readRunResult(taskManager.runInfoForId("RUN-001", workspace)).status, "BLOCKED");
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex", "claude", "codex"]);
  assert.equal(lifecycle.at(-1).status, "blocked");
  assert.equal(lifecycle.at(-1).activeRunId, "RUN-001");

  const resolved = await room.resolveBlocked("keep");
  assert.equal(resolved.ok, true);
  assert.equal(lifecycle.at(-1).status, "blocked");
  assert.equal(lifecycle.at(-1).activeRunId, null);
  assert.equal(lifecycle.at(-1).lastRunId, "RUN-001");
});

test("재시작한 Professional Run은 자동 재실행하지 않고 INTERRUPTED로 열린다", () => {
  const persisted = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    initialProfessionalRun: {
      professionalRunId: "pr-restart",
      node: "IMPLEMENTING",
      status: "RUNNING",
      taskPath: ".project-memory/tasks/TASK-001.md",
      policy: {},
    },
    persistProfessionalRun: (run) => {
      persisted.push(run);
      return true;
    },
    runAgent: () => {
      throw new Error("재시작만으로 agent를 호출하면 안 됩니다.");
    },
  });

  assert.equal(room.specialistState().active, false);
  assert.equal(room.specialistState().node, "IMPLEMENTING");
  assert.equal(room.specialistState().status, "INTERRUPTED");
  assert.equal(room.professionalRun.stopReason, "EXECUTION_INTERRUPTED");
  assert.equal(persisted.length, 1);
});

test("v3 Professional Run은 checkpoint 복구 참조를 단일 Run journal에 저장한다", () => {
  const runs = [];
  const legacyRecoveries = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    initialProfessionalRun: {
      professionalRunId: "pr-checkpoint-journal",
      node: "IMPLEMENTING",
      status: "BLOCKED",
      taskPath: ".project-memory/tasks/TASK-001.md",
      frozenRunId: "RUN-001",
      checkpointId: "cp-abc123",
      policy: {},
    },
    persistProfessionalRun: (run) => {
      runs.push(run);
      return true;
    },
    persistRecovery: (recovery) => {
      legacyRecoveries.push(recovery);
      return true;
    },
  });

  const checkpoint = { checkpointId: "cp-abc123" };
  assert.equal(room.persistRecoveryState(room.recoveryFor(checkpoint, {
    status: "blocked",
    runId: "RUN-001",
    taskPath: ".project-memory/tasks/TASK-001.md",
  })), true);
  assert.equal(runs.at(-1).checkpointId, "cp-abc123");
  assert.deepEqual(legacyRecoveries, [null]);

  assert.equal(room.clearRecoveryState(), undefined);
  assert.equal(runs.at(-1).checkpointId, null);
  assert.deepEqual(legacyRecoveries, [null, null]);
});

test("기록 재생성은 RECORDING 대기 상태를 완료로 닫는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-record-retry-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const taskManager = new TaskManager();
  const task = taskManager.createTaskFromPlanner(makePlanContract("기록 재생성"), workspace);
  const runInfo = taskManager.freezeTask({ contentSource: "file", taskPath: task.relativePath }, workspace);
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager,
    initialProfessionalRun: {
      professionalRunId: "pr-record-retry",
      node: "RECORDING",
      status: "WAITING",
      taskPath: task.relativePath,
      frozenRunId: runInfo.runId,
      policy: {},
    },
    runAgent: fakeRunner({
      codex: [{ ok: true, text: '{"summary":"재기록","decisions":[],"nextActions":[]}' }],
    }),
  });

  const result = await room.startSpecialist({
    action: "record",
    stages: { recorder: { agent: room.findAgent("codex") } },
  });

  assert.equal(result.ok, true);
  assert.equal(room.specialistState().node, "COMPLETED");
  assert.equal(room.specialistState().status, "COMPLETED");
});

test("기획 검수 뒤 TASK.md가 바뀌면 Builder를 시작하지 않는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-changed-after-review-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    onTaskCreated: () => true,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("기획 검수 후 변경") }],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
    }, calls),
  });
  const stages = {
    planner: { agent: room.findAgent("claude") },
    implementation: { agent: room.findAgent("claude") },
    review: { agent: room.findAgent("codex") },
  };

  const planned = await room.startSpecialist({ action: "plan", stages });
  assert.equal(planned.ok, true);
  fs.appendFileSync(path.join(workspace, room.professionalPlan.taskInfo.relativePath), "\n외부 변경", "utf8");

  const result = await room.startSpecialist({ action: "implementation", stages });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "TASK_CHANGED_AFTER_REVIEW");
  assert.deepEqual(calls.map((call) => call.agentId), ["claude", "codex"]);
});

test("Professional Run 시작 상태 저장에 실패하면 Planner를 호출하지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    persistProfessionalRun: () => false,
    runAgent: fakeRunner({
      claude: [{ ok: true, text: makePlanContract("시작 실패") }],
      codex: [{ ok: true, text: "VERDICT: PASS" }],
    }, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "PROFESSIONAL_RUN_WRITE_FAILED");
  assert.equal(calls.length, 0);
});

test("전체 실행의 기획·검수 통과 사이에는 일반 응답을 끼워 넣지 않는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-professional-full-lock-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let releasePlanReview;
  const planReviewPromise = new Promise((resolve) => { releasePlanReview = resolve; });
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      if (/전문 모드: 기획 ===/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: makePlanContract("전체 실행") }), cancel: () => {} };
      }
      if (/전문 모드: 기획 검수/.test(prompt)) {
        return { promise: planReviewPromise, cancel: () => {} };
      }
      if (/전문 모드: 구현/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "구현 완료\nSTATUS: DONE" }), cancel: () => {} };
      }
      if (/전문 모드: 검토/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "검수 통과\nVERDICT: PASS" }), cancel: () => {} };
      }
      if (/전문 모드: 기록/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "{\"summary\":\"완료\",\"decisions\":[],\"nextActions\":[]}" }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "일반 답변" }), cancel: () => {} };
    },
  });
  const started = room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => room.sendUserMessage("이 응답은 끼면 안 됩니다"), /전문 실행/);
  releasePlanReview({ ok: true, text: "기획 검수 통과\nVERDICT: PASS" });
  const result = await started;
  assert.equal(result.ok, true);
});

test("구현·검수는 기획 검수 통과 전에는 시작하지 않는다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}, []) });
  const result = await room.startSpecialist({
    action: "implementation",
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /기획 검수/);
});

test("replanBlocked는 keep 선택 시 부분 변경을 유지하고 기획자에게 막힘 사유를 전달해 재기획을 시작한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-replan-keep-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    checkpoint: turnCheckpoint,
    taskManager: new TaskManager(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      if (/전문 모드: 기획 ===/.test(prompt)) {
        if (/이전 구현.*막혔습니다/.test(prompt)) {
          return { promise: Promise.resolve({ ok: true, text: makePlanContract("재기획 완료") }), cancel: () => {} };
        }
        return { promise: Promise.resolve({ ok: true, text: makePlanContract("초기 기획") }), cancel: () => {} };
      }
      if (/전문 모드: 기획 검수/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "기획 통과\nVERDICT: PASS" }), cancel: () => {} };
      }
      if (/전문 모드: 구현/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "사유: DB 접근 불가\nSTATUS: BLOCKED" }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "기타" }), cancel: () => {} };
    },
  });

  const started = await room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });
  assert.equal(started.stopReason, "BLOCKED");

  const details = room.specialistBlockDetails();
  assert.ok(details);
  assert.equal(details.blockReason, "BLOCKED");

  const replan = await room.replanBlocked("keep");
  assert.equal(replan.ok, true);
  assert.equal(replan.planReady, true);
  assert.match(calls[calls.length - 2].prompt, /이전 구현.*막혔습니다/);
});

test("replanBlocked는 restore 선택 시 작업 전으로 복원 후 재기획을 시작한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-replan-restore-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    checkpoint: turnCheckpoint,
    taskManager: new TaskManager(),
    runAgent: ({ agent, prompt }) => {
      calls.push({ agentId: agent.id, prompt });
      if (/전문 모드: 기획 ===/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: makePlanContract("기획") }), cancel: () => {} };
      }
      if (/전문 모드: 기획 검수/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "기획 통과\nVERDICT: PASS" }), cancel: () => {} };
      }
      if (/전문 모드: 구현/.test(prompt)) {
        return { promise: Promise.resolve({ ok: true, text: "STATUS: BLOCKED" }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "기타" }), cancel: () => {} };
    },
  });

  await room.startSpecialist({
    action: "full",
    stages: {
      planner: { agent: room.findAgent("claude") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
      recorder: { agent: room.findAgent("codex") },
    },
  });

  const replan = await room.replanBlocked("restore");
  assert.equal(replan.ok, true);
  assert.equal(replan.planReady, true);
});

test("전문 실행은 실행 동안만 run-scoped 권한을 켜고, 러너에는 workspace-write로 전달한 뒤 종료 시 해제한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "chat" },
    runAgent: ({ agent, permissionMode, specialistStage }) => {
      calls.push({ agentId: agent.id, permissionMode, specialistStage });
      const text = specialistStage === "review" ? "통과\nVERDICT: PASS" : "구현 완료\nSTATUS: DONE";
      return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
    },
  });

  // 실행 전에는 run 권한이 없다.
  assert.equal(room.activeRunAuthorization, null);

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
  });
  assert.equal(result.ok, true);

  const builderCall = calls.find((call) => call.specialistStage === "implementation");
  assert.ok(builderCall, "구현 단계가 실행되어야 한다");
  assert.equal(builderCall.permissionMode, "workspace-write");

  // 실행이 끝나면 run 권한은 다시 꺼지고, 세션 권한(meta)은 chat 그대로다.
  assert.equal(room.activeRunAuthorization, null);
  assert.equal(room.meta.permissionMode, "chat");
});

test("Git 저장소인데 checkpoint 생성이 실패하면 Builder를 시작하지 않고 CHECKPOINT_FAILED로 멈춘다", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-cpfail-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const run = (args) => require("node:child_process").execFileSync("git", args, { cwd: ws, encoding: "utf8" });
  run(["init"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "init"]);

  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace: ws },
    // non-Git과 구분되는 Git 백업 실패를 흉내낸다.
    checkpoint: {
      createCheckpoint: async () => ({ supported: false, failed: true }),
      restoreCheckpoint: async () => ({ ok: true }),
      cleanupCheckpoint: () => {},
      inspectCheckpoint: () => ({ ok: false }),
    },
    runAgent: ({ agent }) => {
      calls.push(agent.id);
      return { promise: Promise.resolve({ ok: true, text: "구현 완료\nSTATUS: DONE" }), cancel: () => {} };
    },
  });

  const result = await room.startSpecialist({
    stages: {
      implementation: { agent: room.findAgent("codex") },
      review: { agent: room.findAgent("claude") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "CHECKPOINT_FAILED");
  assert.equal(calls.length, 0, "백업 실패 시 Builder를 호출하지 않아야 한다");
});


// ================= Stage C — provider-neutral 승인 seam lifecycle =================

test("승인 seam: interactive 요청은 approval-request를 내보내고 pendingApprovals에 담긴다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const reqs = [];
  room.on("approval-request", (p) => reqs.push(p));
  const p = room.requestInteractiveApproval({ id: "codex" }, { summary: "명령 실행", detail: "rm x", scope: "action" });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].retryScope, "action");
  assert.equal(reqs[0].summary, "명령 실행");
  assert.equal(room.pendingApprovals.size, 1);
  room.resolveApproval(reqs[0].approvalId, "deny");
  assert.equal(await p, false);
});

test("승인 seam: stopAllSilently는 pending 승인마다 approval-resolved를 정확히 1회 내보내고 dismiss한다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const resolved = [];
  room.on("approval-resolved", (p) => resolved.push(p.approvalId));
  let reqId = null;
  room.on("approval-request", (p) => { reqId = p.approvalId; });
  const controller = new AbortController();
  const p = room.requestInteractiveApproval({ id: "codex" }, { summary: "s", detail: "d", scope: "action", signal: controller.signal });
  assert.equal(room.pendingApprovals.size, 1);

  room.stopAllSilently();

  assert.equal(await p, false, "Stop 시 승인 Promise는 false로 resolve");
  assert.deepEqual(resolved, [reqId], "approval-resolved는 해당 approvalId로 정확히 1회");
  assert.equal(room.pendingApprovals.size, 0, "pendingApprovals 비워짐");
  assert.equal(room.resolveApproval(reqId, "approve"), false, "late resolveApproval은 no-op(false)");

  // adapter가 뒤늦게 AbortController를 abort해도 이미 settled -> 중복 approval-resolved 없음
  controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(resolved, [reqId], "abort 후 중복 approval-resolved 없음");
});

test("승인 seam: interject 경로도 pending 승인을 dismiss한다(stale 승인 없음)", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const resolved = [];
  room.on("approval-resolved", (p) => resolved.push(p.approvalId));
  let reqId = null;
  room.on("approval-request", (p) => { reqId = p.approvalId; });
  const p = room.requestInteractiveApproval({ id: "codex" }, { summary: "s", detail: "d", scope: "action" });
  room.interject();
  assert.equal(await p, false);
  assert.deepEqual(resolved, [reqId]);
  assert.equal(room.pendingApprovals.size, 0);
});

test("승인 seam: 정상 approve/deny는 approval-resolved를 내보내지 않는다(클라이언트 dismiss)", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const resolved = [];
  room.on("approval-resolved", (p) => resolved.push(p.approvalId));
  let reqId = null;
  room.on("approval-request", (p) => { reqId = p.approvalId; });
  const p = room.requestInteractiveApproval({ id: "codex" }, { summary: "s", detail: "d", scope: "action" });
  assert.equal(room.resolveApproval(reqId, "approve"), true);
  assert.equal(await p, true, "approve -> Promise true");
  assert.equal(resolved.length, 0, "정상 결정은 approval-resolved를 내보내지 않는다");
  assert.equal(room.pendingApprovals.size, 0);
});

test("승인 seam: legacy whole-turn requestApproval도 stopAllSilently에서 approval-resolved로 dismiss된다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  const resolved = [];
  room.on("approval-resolved", (p) => resolved.push(p.approvalId));
  let reqId = null;
  room.on("approval-request", (p) => { reqId = p.approvalId; });
  const p = room.requestApproval({ id: "codex" }, { summary: "명령 권한" }); // legacy whole-turn seam
  assert.equal(room.pendingApprovals.size, 1);
  room.stopAllSilently();
  assert.equal(await p, false);
  assert.deepEqual(resolved, [reqId]);
  assert.equal(room.pendingApprovals.size, 0);
});
