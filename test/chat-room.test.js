const test = require("node:test");
const assert = require("node:assert/strict");
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

test("전문 모드는 구현 결과를 검토하고 수정 필요면 구현으로 되돌린다", async () => {
  const calls = [];
  const replies = {
    codex: [
      { ok: true, text: "첫 구현" },
      { ok: true, text: "수정 구현" },
    ],
    claude: [
      { ok: true, text: "테스트가 부족합니다.\n[[CODEPET_REVIEW:REVISE]]" },
      { ok: true, text: "검토 통과\n[[CODEPET_REVIEW:PASS]]" },
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
    maxIterations: 3,
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

test("전문 모드 실행 중에는 @멘션 호출이 꺼진다", async () => {
  const calls = [];
  const replies = {
    codex: [
      { ok: true, text: "구현 완료. @claude 이어서 확인 부탁" },
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
    maxIterations: 3,
  });

  assert.equal(result.ok, true);
  // 구현 응답에 @claude가 들어 있어도 멘션 호출이 일어나지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["codex", "claude", "codex"]);
  const implementationPrompt = calls[0].prompt;
  assert.match(implementationPrompt, /위임하지 마세요/);
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
