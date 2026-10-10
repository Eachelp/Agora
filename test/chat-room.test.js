const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");


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
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
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

test("계약으로 물은 에이전트는 답변 대기로 표시되고 새 턴에서 풀린다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: "정리했습니다. 어느 것부터 파볼까요?\nASK_USER: 어느 것부터 파볼까요?\nOPTION: 스키마 정리\nOPTION: 테스트 보강" },
        { ok: true, text: "네, 스키마부터 하겠습니다." },
      ],
    }),
  });
  room.sendUserMessage("@claude 검토해줘");
  await settle(room);
  const afterAsk = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(afterAsk.awaitingUser, true);
  assert.equal(afterAsk.awaitingQuestion, "어느 것부터 파볼까요?");
  assert.deepEqual(afterAsk.awaitingOptions, ["스키마 정리", "테스트 보강"]);

  // 사용자가 그 에이전트에게 답하면(새 턴 시작) 대기가 먼저 풀리고,
  // 계약 없이 끝난 이번 답변은 다시 대기로 세우지 않는다.
  room.sendUserMessage("@claude 스키마부터");
  await settle(room);
  const afterReply = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(afterReply.awaitingUser, false);
  assert.equal(afterReply.awaitingQuestion, null);
});

// 산문의 물음표·목록은 더 이상 대기를 세우지 않는다. 뜻을 못 읽어 도움 제안
// 마무리나 방향 메뉴까지 질문으로 오인했기 때문이다. 계약(ASK_USER)만 세운다.
test("계약 없이 물음표·목록으로 끝난 답변은 답변 대기로 세우지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "정리했습니다.\n1. 스키마 정리\n2. 테스트 보강\n어느 것부터 파볼까요?" }],
      codex: [{ ok: true, text: "무엇을 도와드릴까요?" }],
    }),
  });
  room.sendUserMessage("@claude @codex 검토해줘");
  await settle(room);
  for (const id of ["claude", "codex"]) {
    const agent = room.publicAgents().find((entry) => entry.id === id);
    assert.equal(agent.awaitingUser, false, `${id}는 계약 없이 물었으므로 대기가 아닙니다`);
    assert.deepEqual(agent.awaitingOptions, []);
  }
});

// ×(답변 대기 지우기)는 답하지 않고 그 에이전트의 대기만 내린다. 다른 에이전트의
// 대기는 그대로다.
test("clearAwaitingUser는 그 에이전트의 대기만 내리고 에이전트 목록을 다시 알린다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "A?\nASK_USER: A?" }],
      codex: [{ ok: true, text: "B?\nASK_USER: B?" }],
    }),
  });
  room.sendUserMessage("@claude @codex 각자 물어봐");
  await settle(room);
  const emitted = [];
  room.on("agents", (agents) => emitted.push(agents));
  room.clearAwaitingUser("claude");
  assert.equal(emitted.length, 1, "지운 뒤 에이전트 목록을 한 번 알립니다");
  assert.equal(emitted[0].find((agent) => agent.id === "claude").awaitingUser, false);
  assert.equal(emitted[0].find((agent) => agent.id === "codex").awaitingUser, true);
  // 대기 중이 아닌 에이전트를 지우는 것은 아무 일도 하지 않는다.
  room.clearAwaitingUser("claude");
  assert.equal(emitted.length, 1);
});

// 공통 질문 계약. 에이전트가 ASK_USER + OPTION으로 명시적으로 물으면 산문 추출
// 없이 그 질문·보기로 대기가 서고, 제어 줄은 화면 텍스트에서 사라진다.
test("계약(ASK_USER + OPTION)으로 끝난 일반 턴은 그 질문·보기로 답변 대기가 서고 제어 줄은 화면에서 사라진다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{
        ok: true,
        text: "정리했습니다. 어느 쪽으로 갈까요?\n\nASK_USER: 어느 쪽으로 갈까요?\nOPTION: A안\nOPTION: B안",
      }],
    }),
  });
  room.sendUserMessage("@claude 정리해줘");
  await settle(room);
  const claude = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(claude.awaitingUser, true);
  assert.equal(claude.awaitingQuestion, "어느 쪽으로 갈까요?");
  assert.deepEqual(claude.awaitingOptions, ["A안", "B안"]);
  const reply = room.messages.find((message) => message.authorType === "agent");
  assert.equal(reply.text, "정리했습니다. 어느 쪽으로 갈까요?");
});

// 산문 휴리스틱과 달리 계약 ASK_USER는 보기가 없어도 대기로 선다 — 에이전트가
// 명시적으로 물었기 때문이다.
test("계약 ASK_USER는 보기가 없어도 답변 대기로 선다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "확인 부탁드립니다.\nASK_USER: 이대로 진행할까요?" }] }),
  });
  room.sendUserMessage("@claude 확인");
  await settle(room);
  const claude = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(claude.awaitingUser, true);
  assert.equal(claude.awaitingQuestion, "이대로 진행할까요?");
  assert.deepEqual(claude.awaitingOptions, []);
  assert.equal(room.messages.find((message) => message.authorType === "agent").text, "확인 부탁드립니다.");
});

// HANDOFF·COMPLETE는 역할 실행의 제어다. 일반 채팅에서는 실행도 strip도 하지 않는다.
test("일반 채팅에서 HANDOFF·COMPLETE 제어 줄은 무시하고 화면에도 그대로 남긴다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "끝냈습니다.\nCOMPLETE" }] }),
  });
  room.sendUserMessage("@claude 마무리");
  await settle(room);
  const claude = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(claude.awaitingUser, false);
  assert.equal(room.messages.find((message) => message.authorType === "agent").text, "끝냈습니다.\nCOMPLETE");
});

test("평서문으로 끝난 일반 답변은 답변 대기가 아니고, 핸드오프한 에이전트도 대기가 아니다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      codex: [{ ok: true, text: "@claude 이 부분만 봐줄래?" }],
      claude: [{ ok: true, text: "확인했습니다. 문제없습니다." }],
    }),
  });
  room.sendUserMessage("@codex 검토");
  await settle(room);
  const publicAgents = room.publicAgents();
  // codex는 다른 에이전트로 넘겼으니 대기가 아니다.
  assert.equal(publicAgents.find((agent) => agent.id === "codex").awaitingUser, false);
  // 이어 응답한 claude도 평서문으로 끝나 대기가 아니다.
  assert.equal(publicAgents.find((agent) => agent.id === "claude").awaitingUser, false);
});

test("세션 비우기(clear)는 남은 답변 대기를 모두 내린다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "어느 것부터 할까요?\nASK_USER: 어느 것부터 할까요?" }] }),
  });
  room.sendUserMessage("@claude 검토");
  await settle(room);
  assert.equal(room.publicAgents().find((agent) => agent.id === "claude").awaitingUser, true);
  room.clear();
  assert.equal(room.publicAgents().find((agent) => agent.id === "claude").awaitingUser, false);
});

test("러너가 보고한 실제 모델(resolvedModel)은 응답의 agentMeta에 남는다", async () => {
  const agents = makeAgents().map((agent) =>
    agent.id === "claude" ? { ...agent, model: "fable", effort: "medium" } : agent
  );
  const room = new ChatRoom({
    agents,
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: "첫 답", resolvedModel: "claude-fable-5-1" },
        { ok: false, error: "실패", resolvedModel: "claude-fable-5-1" },
        { ok: true, text: "보고 없음" },
      ],
    }),
  });
  room.sendUserMessage("@claude 하나");
  await settle(room);
  room.sendUserMessage("@claude 둘");
  await settle(room);
  room.sendUserMessage("@claude 셋");
  await settle(room);

  const replies = room.messages.filter((message) => message.authorType === "agent");
  assert.equal(replies.length, 3);
  // 별칭(fable)은 그대로 두고, 실제로 풀린 모델을 따로 적는다.
  assert.equal(replies[0].agentMeta.model, "fable");
  assert.equal(replies[0].agentMeta.resolvedModel, "claude-fable-5-1");
  // 실패 응답의 헤더도 실제 모델을 안다.
  assert.equal(replies[1].error, true);
  assert.equal(replies[1].agentMeta.resolvedModel, "claude-fable-5-1");
  // 보고가 없으면 이전 실행의 값이 새지 않고, 설정한 모델(별칭)만 남는다.
  assert.equal(replies[2].agentMeta.resolvedModel, "fable");
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

test("일반 채팅은 방 권한·transcript·호출 경계를 그대로 쓴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: ({ agent, prompt, permissionMode, autoApprove }) => {
      calls.push({ agentId: agent.id, prompt, permissionMode, autoApprove });
      return { promise: Promise.resolve({ ok: true, text: "일반 답변" }), cancel: () => {} };
    },
  });

  room.sendUserMessage("@codex 일반 채팅으로 답해줘");
  await settle(room);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].permissionMode, "workspace-write");
  assert.equal(calls[0].autoApprove, false);
  assert.match(calls[0].prompt, /=== 대화 ===/);
  assert.match(calls[0].prompt, /\[User\] @codex 일반 채팅으로 답해줘/);
  assert.match(calls[0].prompt, /그룹 채팅의 참가자/);
  assert.doesNotMatch(calls[0].prompt, /clean-room/);
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

test("자율 토론은 방 권한과 앞선 transcript를 전달한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-read" },
    runAgent: ({ agent, prompt, permissionMode }) => {
      calls.push({ agentId: agent.id, prompt, permissionMode });
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
    // 재시도는 자동 승인을 실어 보내는 것이고, 자동 승인은 이 권한에서만 유효하다.
    meta: { permissionMode: "workspace-write" },
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


// ================= 승인 카드 lifecycle =================

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

// 자동 승인이 켜진 방에서는 승인 요청 결과가 그대로 실패로 그려진다. 그때 사유가
// 비어 있으면 화면에 "알 수 없는 오류"만 남아 무엇이 막혔는지 알 수 없었다.
test("승인 요청으로 끝난 실행도 사유와 원문을 남긴다", async () => {
  const agents = makeAgents().map((agent) =>
    agent.id === "claude" ? { ...agent, autoApprove: true } : agent
  );
  const room = new ChatRoom({
    agents,
    runAgent: () => ({
      promise: Promise.resolve({
        ok: false,
        approvalRequired: true,
        error: "도구 권한: write_to_file",
        approval: { summary: "도구 권한: write_to_file", detail: "is not a valid artifact path" },
        output: { stdoutBytes: 58163, captureTruncated: false },
      }),
      cancel: () => {},
    }),
  });
  room.sendUserMessage("@claude 파일 만들어줘");
  await settle(room);

  const reply = room.messages.filter((message) => message.authorType === "agent").at(-1);
  assert.equal(reply.error, true);
  assert.ok(!reply.text.includes("알 수 없는 오류"), "사유 없이 끝내면 안 됩니다");
  assert.match(reply.text, /도구 권한: write_to_file/);
  // CLI가 준 원문도 함께 남겨 무엇이 막혔는지 알 수 있게 한다.
  assert.match(reply.text, /is not a valid artifact path/);
});

// 독립 발언은 서로의 답을 입력으로 쓰지 않는다 = 앞 사람을 기다릴 이유가 없다.
// 예전에는 pumpTurnQueue가 무조건 한 명씩 돌려서, 세 명에게 각자 시안을 시키면
// 뒤 두 명이 큐에서 120초를 넘겨 "응답이 유실됐을 수 있다"는 안내까지 떴다.
function gatedRunner() {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release: () => release(),
    runAgent: ({ agent }) => {
      started.push(agent.id);
      return { promise: gate.then(() => ({ ok: true, text: `${agent.id} 답` })), cancel: () => {} };
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

// 공유 /tmp를 작업 폴더로 쓰면 담당자 폴더 계약 감시가 이 머신 전체의 변경을
// 훑는다. 테스트마다 자기 폴더를 쓴다.
function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-room-ws-"));
}

test("독립 발언은 서로를 기다리지 않고 동시에 시작한다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 각자 시안 만들어줘", independent: true });
  await tick();

  assert.deepEqual([...runner.started].sort(), ["claude", "codex"], "둘 다 시작해야 합니다");
  // 실행 중인 턴이 여럿임을 상태에도 드러낸다.
  assert.deepEqual([...room.turnState().running].sort(), ["claude", "codex"]);
  assert.equal(room.turnState().queue.length, 0, "뒤 사람이 큐에서 기다리면 안 됩니다");

  runner.release();
  await settle(room);
  const replies = room.messages.filter((message) => message.authorType === "agent");
  assert.deepEqual(replies.map((message) => message.author).sort(), ["claude", "codex"]);
});

test("이어 발언은 앞 답이 다음 입력이라 예전처럼 한 명씩 돈다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 이어서 얘기해줘", independent: false });
  await tick();

  assert.equal(runner.started.length, 1, "이어 발언은 동시에 시작하면 안 됩니다");
  assert.equal(room.turnState().queue.length, 1);
  runner.release();
  await settle(room);
});

// 쓰기 권한에서도 독립 발언은 모두 동시에 시작해야 하고, 폴더 때문에 튕기는 안내가 없어야 한다.
test("쓰기 권한에서도 독립 발언은 서로를 막지 않는다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({
    sessionId: "parallel-write-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace: makeWorkspace() },
    runAgent: runner.runAgent,
  });
  room.sendUserMessage({ text: "@claude @codex 각자 폴더에 만들어줘", independent: true });
  await tick();

  assert.deepEqual([...runner.started].sort(), ["claude", "codex"], "둘 다 실행돼야 합니다");
  // 폴더가 잠겨 튕긴 경우 남는 안내가 없어야 한다.
  const busy = room.messages.filter(
    (message) => message.authorType === "system" && /작업 폴더/.test(message.text || "")
  );
  assert.equal(busy.length, 0, `폴더 잠금으로 막히면 안 됩니다: ${busy.map((m) => m.text).join(" / ")}`);

  runner.release();
  await settle(room);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 2);
});

// 승인 카드를 승인하면 같은 담당자가 자동 승인으로 한 번 더 실행된다.
test("승인 카드를 승인하면 자동 승인으로 한 번 더 실행해 답을 남긴다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-approval-retry-"));
  const calls = [];
  const room = new ChatRoom({
    sessionId: "approval-retry-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace },
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

  let approvalId = null;
  room.once("approval-request", (event) => { approvalId = event.approvalId; });
  room.sendUserMessage("@codex 실행해줘");
  await tick();

  assert.ok(approvalId, "승인 카드가 떠야 합니다");
  room.resolveApproval(approvalId, "approve");
  await settle(room);
  assert.deepEqual(calls, [
    { agentId: "codex", autoApprove: false },
    { agentId: "codex", autoApprove: true },
  ]);
  assert.equal(room.messages.at(-1).text, "승인 후 완료");
  fs.rmSync(workspace, { recursive: true, force: true });
});

// 자동 승인은 workspace-write에서만 유효하다(chat-argv.js). 그 아래 권한에서 카드를
// 띄우면 승인해도 같은 실행이 같은 이유로 실패한다.
test("쓰기 권한이 아니면 승인 카드 대신 권한을 올리라고 알린다", async () => {
  const calls = [];
  const events = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "chat" },
    runAgent: ({ agent, autoApprove }) => {
      calls.push({ agentId: agent.id, autoApprove });
      return {
        promise: Promise.resolve({
          ok: false,
          approvalRequired: true,
          approval: { summary: "명령 권한", detail: "rm -rf 실행 권한이 필요합니다" },
        }),
        cancel: () => {},
      };
    },
  });
  room.on("approval-request", (event) => events.push(event));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  assert.equal(events.length, 0, "승인해도 통하지 않는 카드를 띄우면 안 됩니다");
  assert.deepEqual(calls, [{ agentId: "codex", autoApprove: false }], "같은 실행을 반복하면 안 됩니다");
  const last = room.messages.at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /워크스페이스 쓰기/);
  // 무슨 권한이 막혔는지 원문도 남긴다.
  assert.match(last.text, /rm -rf 실행 권한이 필요합니다/);
});

test("동시 실행 시 담당자별 폴더 계약이 실제 프롬프트에 실린다", async () => {
  const prompts = [];
  const room = new ChatRoom({
    sessionId: "parallel-prompt-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace: makeWorkspace() },
    runAgent: ({ agent, prompt }) => {
      prompts.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve({ ok: true, text: `${agent.id} 답` }), cancel: () => {} };
    },
  });
  room.sendUserMessage({ text: "@claude @codex 각자 시안 만들어줘", independent: true });
  await settle(room);

  assert.equal(prompts.length, 2);
  for (const { agentId, prompt } of prompts) {
    // 폴더 이름은 담당자 id다 — 누가 만들었는지 결과에 그대로 남는다.
    assert.match(prompt, new RegExp("`" + agentId + "/` 하위에만"));
    assert.match(prompt, /동시에 실행되고 있습니다/);
  }

  // 이어 발언(순차)에는 붙이지 않는다. 덮어쓸 동시 실행이 없다.
  prompts.length = 0;
  room.sendUserMessage({ text: "@claude @codex 이어서 얘기해줘", independent: false });
  await settle(room);
  assert.ok(prompts.every(({ prompt }) => !prompt.includes("동시에 실행되고 있습니다")));
});

test("큐에서 차례를 기다리는 턴을 '유실'로 안내하지 않는다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 이어서 얘기해줘", independent: false });
  await tick();

  const waiting = room.turnState().queue[0];
  assert.ok(waiting, "대기 중인 턴이 있어야 합니다");
  // 실행 중인 턴이 있는 동안의 안내는 "기다리는 중"이어야 한다.
  room.turnStartedAt.set(waiting.turnId, Date.now() - 999_000);
  room.checkTurnStall(waiting.turnId);
  const notice = room.messages.filter((message) => message.authorType === "system").at(-1);
  assert.match(notice.text, /차례를 기다리고 있습니다/);
  assert.ok(!/유실/.test(notice.text), "정상 대기를 유실로 안내하면 안 됩니다");

  runner.release();
  await settle(room);
});

test("대기 안내는 유실 안내 표시를 태우지 않는다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 이어서 얘기해줘", independent: false });
  await tick();

  const waiting = room.turnState().queue[0];
  room.turnStartedAt.set(waiting.turnId, Date.now() - 999_000);
  room.checkTurnStall(waiting.turnId);
  assert.match(room.messages.at(-1).text, /차례를 기다리고 있습니다/);

  // 그 뒤 중지로 실제 버려지면 그 사실을 알려야 한다. 대기 안내가
  // lostTurnNotified를 소비하면 이 안내가 조용히 사라진다.
  room.stopAllSilently();
  const notices = room.messages.filter((m) => m.authorType === "system").map((m) => m.text);
  assert.ok(
    notices.some((text) => /중지로 @codex 응답 대기가 취소/.test(text) || /중지로 @claude 응답 대기가 취소/.test(text)),
    `중지 안내가 있어야 합니다: ${notices.join(" / ")}`
  );
  runner.release();
});

test("중지하면 실행 중이던 턴도 상태에서 즉시 사라진다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 각자 만들어줘", independent: true });
  await tick();
  assert.equal(room.turnState().running.length, 2);

  room.stopAllSilently();
  assert.deepEqual(room.turnState().running, [], "중지한 턴을 계속 실행 중으로 알리면 안 됩니다");
  assert.equal(room.turnState().current, null);
  runner.release();
  await settle(room);
});

// 전문 실행 단계 상한(읽기 전용)으로 막힌 경우에는 방 설정을 올려도 풀리지 않는다.
test("대화 전용으로 도는 응답의 권한 요청은 방 권한을 올리라고 하지 않는다", async () => {
  const events = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: () => ({
      promise: Promise.resolve({
        ok: false,
        approvalRequired: true,
        approval: { summary: "명령 권한" },
      }),
      cancel: () => {},
    }),
  });
  room.on("approval-request", (event) => events.push(event));
  const agent = room.findAgent("codex");
  // 토론 결론 종합은 방 권한이 쓰기여도 대화 전용(chat)으로 돈다.
  await room.respond(agent, { discussionSummary: { discussionId: "d1" } });

  assert.equal(events.length, 0);
  const last = room.messages.at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /대화 전용/);
  assert.ok(!last.text.includes("방 권한"), "방 설정을 올려도 풀리지 않는 경우입니다");
});

// 실행 중인 턴은 방금 도착한 @멘션을 대신 볼 수 없다. 그 promise를 돌려주면
// 호출이 조용히 사라진다 — 순차 실행과 같게 새 턴으로 잡아야 한다.
test("동시 실행 중인 담당자를 @멘션으로 부르면 순차 실행과 똑같이 이어서 답한다", async () => {
  async function run(independent) {
    const calls = [];
    const room = new ChatRoom({
      agents: makeAgents(),
      random: () => 0.9,
      runAgent: ({ agent }) => {
        calls.push(agent.id);
        if (agent.id === "claude") {
          return {
            promise: new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: "claude 답" }), 120)),
            cancel: () => {},
          };
        }
        return { promise: Promise.resolve({ ok: true, text: "시안 완료. @claude 확인해줘" }), cancel: () => {} };
      },
    });
    room.sendUserMessage({ text: "@claude @codex 각자 시안 만들어줘", independent });
    await settle(room);
    await new Promise((resolve) => setTimeout(resolve, 160));
    await settle(room);
    return calls;
  }
  assert.deepEqual(await run(false), ["claude", "codex", "claude"], "순차 실행의 기준 동작");
  assert.deepEqual(await run(true), ["claude", "codex", "claude"], "동시 실행에서도 멘션이 살아 있어야 합니다");
});

// 같은 사용자 메시지가 같은 담당자를 두 번 배정하는 것은 그대로 접는다.
test("같은 사용자 메시지가 같은 담당자를 두 번 배정하지는 않는다", async () => {
  const runner = gatedRunner();
  const room = new ChatRoom({ agents: makeAgents(), runAgent: runner.runAgent });
  room.sendUserMessage({ text: "@claude @codex 각자 해줘", independent: true });
  await tick();
  const claude = room.findAgent("claude");
  const rootId = room.messages.find((message) => message.authorType === "user")?.id;
  room.scheduleResponse(claude, { turnRootId: rootId });
  assert.equal(room.turnState().queue.length, 0, "같은 배정이 큐에 또 쌓이면 안 됩니다");
  runner.release();
  await settle(room);
  assert.deepEqual(runner.started.sort(), ["claude", "codex"]);
});

// 사용자가 생각을 나눠 보내면 아직 시작하지 않은 턴은 앞 조각만 보고 답하고,
// 조각마다 턴이 하나씩 생겨 같은 담당자가 여러 번 답했다. 대기 턴은 새 메시지로
// 갈아끼워 전체를 보고 한 번만 답한다. 실행 중인 턴은 그대로 둔다.
test("연속 사용자 메시지는 대기 중인 턴을 갈아끼워 담당자마다 한 번만, 전체를 보고 답한다", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const room = new ChatRoom({
    agents: makeAgents(),
    random: () => 0.9,
    runAgent: ({ agent, prompt, attachments }) => {
      calls.push({ agentId: agent.id, prompt, attachments });
      return { promise: gate.then(() => ({ ok: true, text: `${agent.id} 답` })), cancel: () => {} };
    },
  });
  const first = room.sendUserMessage({
    text: "표집 후 임시로 보낼 모의 HTML 결과표 같은 걸 만들 수도 있고",
    attachments: [{ name: "표집.csv" }],
  });
  await tick();
  assert.equal(calls.length, 1, "순차 실행이라 한 명만 시작합니다");
  const running = calls[0].agentId;
  const waiting = room.turnQueue[0].agent.id;
  assert.notEqual(waiting, running);

  const second = room.sendUserMessage("검사설계도 같은 것도 제작할 수 있겠고");
  await tick();
  const queued = room.turnQueue.map((item) => ({ agentId: item.agent.id, root: item.context.turnRootId }));
  assert.deepEqual(
    queued.filter((item) => item.agentId === waiting),
    [{ agentId: waiting, root: second.id }],
    "대기하던 담당자의 턴은 새 메시지 기준 하나로 갈아끼워집니다"
  );
  assert.deepEqual(
    queued.filter((item) => item.agentId === running),
    [{ agentId: running, root: second.id }],
    "실행 중이던 담당자는 건드리지 않고 새 턴 하나만 뒤에 섭니다"
  );
  assert.ok(!room.turnQueue.some((item) => item.context.turnRootId === first.id), "첫 메시지 턴은 남지 않습니다");

  release();
  await settle(room);
  assert.equal(calls.length, 3, "실행 중이던 1 + 갈아끼운 1 + 실행 중이던 담당자의 새 턴 1");
  const superseded = calls.find((call) => call.agentId === waiting);
  assert.match(superseded.prompt, /모의 HTML 결과표/);
  assert.match(superseded.prompt, /검사설계도/);
  assert.deepEqual(superseded.attachments, [{ name: "표집.csv" }], "앞 턴에 딸린 첨부를 이어받습니다");
  assert.ok(
    !room.messages.some((message) => message.authorType === "system" && /다시 보내/.test(message.text)),
    "갈아끼우기는 유실이 아니므로 다시 보내라는 안내가 없어야 합니다"
  );
});

// 중지는 subprocess 종료를 기다리지 않는다. 화면 표시용 카운터(activeRuns)는
// 즉시 0이 되지만, 세션 삭제가 기다리는 liveRuns는 실행이 실제로 끝날 때까지 남는다.
test("중지 직후에도 실행이 실제로 끝날 때까지 liveRuns는 남는다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-stop-live-"));
  const finishers = [];
  const room = new ChatRoom({
    sessionId: "stop-live-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace },
    runAgent: () => ({
      // 실제 CLI처럼 cancel()은 종료 신호만 보내고, promise는 프로세스가
      // 실제로 끝날 때 풀린다.
      promise: new Promise((resolve) => { finishers.push(() => resolve({ ok: false, cancelled: true })); }),
      cancel: () => {},
    }),
  });
  room.sendUserMessage({ text: "@claude @codex 각자 만들어줘", independent: true });
  await tick();
  assert.equal(room.liveRuns, 2);

  room.interject();
  assert.equal(room.activeRuns, 0, "화면 표시는 즉시 멈춥니다");
  assert.equal(room.liveRuns, 2, "실행은 아직 살아 있습니다");

  for (const finish of finishers) finish();
  await settle(room);
  assert.equal(room.liveRuns, 0);
  fs.rmSync(workspace, { recursive: true, force: true });
});

// 실패 문구가 "원본 로그를 확인해 주세요"라고 안내하는데, 거부한 경우에만
// 그 로그 이름과 부분 출력을 버리고 있었다.
test("권한 요청을 거부해도 진단 정보는 남는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: () => ({
      promise: Promise.resolve({
        ok: false,
        approvalRequired: true,
        approval: { summary: "명령 권한" },
        partialText: "중간까지 만든 결과",
        output: { stdoutBytes: 4096, rawLogName: "r1.log" },
      }),
      cancel: () => {},
    }),
  });
  room.once("approval-request", ({ approvalId }) => room.resolveApproval(approvalId, "reject"));
  room.sendUserMessage("@codex 실행해줘");
  await settle(room);

  const last = room.messages.at(-1);
  assert.equal(last.error, true);
  assert.equal(last.text, "권한 요청을 거부했습니다.");
  assert.equal(last.partialText, "중간까지 만든 결과");
  assert.equal(last.runOutput.rawLogName, "r1.log");
});

// 담당자별 폴더 계약은 프롬프트로 준 지시이고 강제가 아니다. 그래서 지켜지지
// 않았을 때 조용히 넘어가면, 서로 덮어쓴 결과를 사용자가 한참 뒤에 발견한다.
test("동시 실행이 담당자 폴더 밖을 건드리면 알린다", async () => {
  const workspace = makeWorkspace();
  // 사용자가 실행 전부터 갖고 있던 변경. 이것을 담당자 탓으로 돌리면 안 된다.
  fs.writeFileSync(path.join(workspace, "사용자-메모.txt"), "미리 적어 둔 것", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const room = new ChatRoom({
    sessionId: "folder-contract-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace },
    // 실제 CLI처럼 프로세스가 뜬 뒤에 파일을 쓴다.
    runAgent: ({ agent }) => ({
      promise: new Promise((resolve) => setTimeout(() => {
        // claude는 계약대로 자기 폴더에, codex는 공용 파일에 쓴다.
        const rel = agent.id === "claude" ? path.join("claude", "시안.md") : "README.md";
        const file = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${agent.id} 작업`, "utf8");
        resolve({ ok: true, text: `${agent.id} 답` });
      }, 25)),
      cancel: () => {},
    }),
  });
  room.sendUserMessage({ text: "@claude @codex 각자 시안 만들어줘", independent: true });
  await settle(room);

  const notice = room.messages.filter(
    (message) => message.authorType === "system" && /담당자 폴더/.test(message.text || "")
  );
  assert.equal(notice.length, 1, "폴더 밖 변경을 알려야 합니다");
  assert.match(notice[0].text, /README\.md/);
  assert.ok(!notice[0].text.includes("시안.md"), "계약을 지킨 변경까지 지목하면 안 됩니다");
  assert.ok(!notice[0].text.includes("사용자-메모"), "실행 전 사용자 변경을 담당자 탓으로 돌리면 안 됩니다");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("모두 자기 폴더 안에서 작업하면 아무 말도 하지 않는다", async () => {
  const workspace = makeWorkspace();
  const room = new ChatRoom({
    sessionId: "folder-contract-clean-room",
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write", workspace },
    runAgent: ({ agent }) => ({
      promise: new Promise((resolve) => setTimeout(() => {
        const file = path.join(workspace, agent.id, "시안.md");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${agent.id} 작업`, "utf8");
        resolve({ ok: true, text: `${agent.id} 답` });
      }, 25)),
      cancel: () => {},
    }),
  });
  room.sendUserMessage({ text: "@claude @codex 각자 시안 만들어줘", independent: true });
  await settle(room);

  const notice = room.messages.filter(
    (message) => message.authorType === "system" && /담당자 폴더/.test(message.text || "")
  );
  assert.equal(notice.length, 0, `계약을 지켰는데 지적하면 안 됩니다: ${notice.map((m) => m.text).join(" / ")}`);
  fs.rmSync(workspace, { recursive: true, force: true });
});

// 읽기 전용 권한에서는 쓸 수 없으므로 훑을 이유가 없다.
test("쓰기 권한이 아니면 폴더 계약을 감시하지 않는다", async () => {
  const workspace = makeWorkspace();
  const room = new ChatRoom({
    sessionId: "folder-contract-read-room",
    agents: makeAgents(),
    meta: { permissionMode: "chat", workspace },
    runAgent: ({ agent }) => ({
      promise: Promise.resolve({ ok: true, text: `${agent.id} 답` }),
      cancel: () => {},
    }),
  });
  let scans = 0;
  const original = room.reportFolderContractBreaches.bind(room);
  room.reportFolderContractBreaches = async (...args) => { scans += 1; return original(...args); };
  room.sendUserMessage({ text: "@claude @codex 각자 답해줘", independent: true });
  await settle(room);
  assert.equal(scans, 0);
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function untilTrue(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("조건을 기다리다 시간이 지났습니다");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("실행 중 턴이 10분째 진전이 없으면 한도 가능성과 뒤에 막힌 턴을 한 번만 안내한다", async () => {
  let captured = null;
  let resolveRun = null;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, emitEvent }) => {
      if (agent.id === "claude") {
        captured = emitEvent;
        return { promise: new Promise((resolve) => { resolveRun = resolve; }), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "codex 답" }), cancel: () => {} };
    },
  });
  room.sendUserMessage("@claude 검토해줘");
  await untilTrue(() => captured);
  // claude가 도는 동안 codex 턴을 보내 큐에 세운다(이어 발언 = 단일 큐라 함께 막힌다).
  room.sendUserMessage("@codex 이것도");
  await new Promise((resolve) => setImmediate(resolve));
  captured({ kind: "status", label: "5분째 응답 없음" });
  captured({ kind: "status", label: "10분째 응답 없음" });
  captured({ kind: "status", label: "15분째 응답 없음" });
  const notes = room.messages.filter((message) => /진전이 없습니다/.test(message.text || ""));
  assert.equal(notes.length, 1, "임계 이후 반복 경고에도 한 번만 안내한다");
  assert.match(notes[0].text, /@claude 응답이 10분째/);
  assert.match(notes[0].text, /한도/);
  assert.match(notes[0].text, /중지/);
  assert.match(notes[0].text, /@codex/);
  resolveRun({ ok: true, text: "끝" });
  await settle(room);
});

test("한도로 끝난 실행 뒤에 기다리던 턴이 있으면 이어서 실행됨을 알린다", async () => {
  let resolveRun = null;
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent }) => agent.id === "claude"
      ? { promise: new Promise((resolve) => { resolveRun = resolve; }), cancel: () => {} }
      : { promise: Promise.resolve({ ok: true, text: "codex 답" }), cancel: () => {} },
  });
  room.sendUserMessage("@claude 검토");
  await untilTrue(() => resolveRun);
  room.sendUserMessage("@codex 이것도");
  await new Promise((resolve) => setImmediate(resolve));
  resolveRun({ ok: false, rateLimited: true, stopReason: "PROVIDER_RATE_LIMITED", error: "사용 한도에 도달했습니다." });
  await settle(room);
  const note = room.messages.find((message) => /사용 한도로 멈춰/.test(message.text || ""));
  assert.ok(note, "뒤에 막혔던 턴이 이어진다는 안내가 있다");
  assert.match(note.text, /@codex/);
  // 큐에 있던 codex는 실제로 이어서 실행됐다.
  assert.ok(room.messages.some((message) => message.author === "codex" && message.text === "codex 답"));
});
