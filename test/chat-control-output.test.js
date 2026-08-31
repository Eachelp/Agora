"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { stripControlOutput } = require("../src/agora/interaction-contract");
const { createProfessionalRun } = require("../src/agora/professional-run");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "GPT", aliases: ["gpt", "codex"], available: true, enabled: true },
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

test("stripControlOutput: 꼬리 제어 블록만 표시 텍스트에서 제거한다", () => {
  const text = ["계획 검토가 필요합니다.", "", "HANDOFF: @reviewer", "PURPOSE: plan_review"].join(
    "\n"
  );
  assert.equal(stripControlOutput(text), "계획 검토가 필요합니다.");
  // 본문 중간의 마커는 산문이므로 남는다.
  const mid = ["예시: ", "HANDOFF: @builder", "이렇게 씁니다."].join("\n");
  assert.equal(stripControlOutput(mid), mid);
  // 코드펜스 안의 마커도 남는다.
  const fenced = ["설명", "```", "HANDOFF: @reviewer", "```"].join("\n");
  assert.equal(stripControlOutput(fenced), fenced);
  // 전체가 제어 블록이면 빈 문자열이다.
  assert.equal(stripControlOutput("COMPLETE"), "");
  // 여러 줄 코드펜스가 본문에 있고 그 뒤에 꼬리 제어 블록이 오면, 펜스 앞
  // 본문(닫는 ``` 포함)을 보존하고 제어 줄만 제거한다. maskCodeFences가
  // 펜스 내부 개행을 뭉개면 masked/원문 줄 수가 어긋나 본문을 잘라먹었다.
  const withFence = ["구현했습니다.", "```diff", "+const x = 1;", "```", "STATUS: DONE", "HANDOFF: @reviewer"].join("\n");
  assert.equal(
    stripControlOutput(withFence),
    ["구현했습니다.", "```diff", "+const x = 1;", "```", "STATUS: DONE"].join("\n")
  );
  // 펜스가 꼬리 제어 블록 바로 앞이어도 코드 본문이 통째로 유실되지 않는다.
  const fenceThenControl = ["설명 문단입니다.", "```js", "const a = 1;", "const b = 2;", "```", "HANDOFF: @reviewer"].join("\n");
  assert.equal(
    stripControlOutput(fenceThenControl),
    ["설명 문단입니다.", "```js", "const a = 1;", "const b = 2;", "```"].join("\n")
  );
});

test("전문 역할 턴의 제어 출력이 추출·기록되고 표시 텍스트에서 벗겨진다", async () => {
  const calls = [];
  const journal = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      {
        claude: [
          {
            ok: true,
            text: [
              "기획 초안입니다.",
              "STATUS: PLAN_READY",
              "",
              "HANDOFF: @reviewer",
              "PURPOSE: plan_review",
              "REASON: 인증 경계 검증 필요",
            ].join("\n"),
          },
        ],
      },
      calls
    ),
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
  });
  room.professionalRun = createProfessionalRun({
    node: "PLANNING",
    status: "RUNNING",
    professionalRunId: "pr-test",
  });

  const outcome = await room.scheduleResponse(room.agents[0], {
    specialist: { stage: "planner", controlOutputs: true },
  });
  await settle(room);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.controlRequest, {
    action: "HANDOFF",
    targetRole: "reviewer",
    purpose: "plan_review",
    reason: "인증 경계 검증 필요",
    ambiguous: false,
  });
  // 표시 텍스트에는 제어 블록이 남지 않는다.
  const message = room.messages.find((entry) => entry.authorType === "agent");
  assert.ok(!/HANDOFF:/.test(message.text));
  assert.match(message.text, /기획 초안입니다/);
  // 기존 STATUS 마커 파싱은 그대로 동작한다.
  assert.equal(outcome.plannerStatus, "PLAN_READY");
  // 요청 사실이 Journal에 남는다(소비 여부와 무관 — 모델은 요청하고
  // Runtime이 결정한다).
  const requested = journal.find((event) => event.type === "HANDOFF_REQUESTED");
  assert.ok(requested);
  assert.equal(requested.role, "reviewer");
  assert.equal(requested.purpose, "plan_review");
  assert.equal(requested.professionalRunId, "pr-test");
});

test("소비자 없는 specialist 턴(step mode)에서는 제어를 추출·기록·strip하지 않는다", async () => {
  const journal = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [
        {
          ok: true,
          text: ["기획 초안입니다.", "STATUS: PLAN_READY", "", "HANDOFF: @reviewer"].join("\n"),
        },
      ],
    }),
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
  });
  room.professionalRun = createProfessionalRun({
    node: "PLANNING",
    status: "RUNNING",
    professionalRunId: "pr-step",
  });

  // controlOutputs 플래그가 없는 specialist 턴 — step mode처럼 소비자가
  // 붙지 않은 경로다. 여기서 parse/strip하면 화면에서만 지워지고
  // HANDOFF_REQUESTED만 남는 ghost 요청이 생긴다.
  const outcome = await room.scheduleResponse(room.agents[0], {
    specialist: { stage: "planner" },
  });
  await settle(room);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.controlRequest, null);
  const message = room.messages.find((entry) => entry.authorType === "agent");
  assert.match(message.text, /HANDOFF: @reviewer/);
  assert.equal(journal.some((event) => event.type === "HANDOFF_REQUESTED"), false);
});

test("일반 채팅 턴의 제어 마커는 추출되지 않는다", async () => {
  const calls = [];
  const journal = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      { claude: [{ ok: true, text: "답변입니다.\nHANDOFF: @reviewer" }] },
      calls
    ),
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
  });
  room.sendUserMessage("@claude 알려줘");
  await settle(room);

  // 전문 역할 턴이 아니면 제어 채널이 아니다 — 텍스트도 그대로 남는다.
  const message = room.messages.find((entry) => entry.authorType === "agent");
  assert.match(message.text, /HANDOFF:/);
  assert.equal(journal.some((event) => event.type === "HANDOFF_REQUESTED"), false);
});

test("professionalRun은 handoffState를 보존한다", () => {
  const state = {
    rootMessageId: "msg-1",
    budget: 8,
    used: 2,
    consumedInvocationIds: ["inv-1", "inv-2"],
    lastTargetRole: "reviewer",
    activeInvocationId: null,
  };
  const run = createProfessionalRun({ handoffState: state });
  assert.deepEqual(run.handoffState, state);
  // rehydration(재생성)에서도 유지된다.
  const rehydrated = createProfessionalRun(run);
  assert.deepEqual(rehydrated.handoffState, state);
  // 기본값은 null이다.
  assert.equal(createProfessionalRun({}).handoffState, null);
});
