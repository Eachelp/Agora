const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRoleMentions } = require("../src/chat/chat-mention");
const { ChatRoom } = require("../src/chat/chat-room");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "GPT", aliases: ["gpt", "codex"], available: true, enabled: true },
    { id: "agy", name: "Gemini", aliases: ["gemini", "agy"], available: true, enabled: true },
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

function teamSteps() {
  return [
    { roleId: "planner", stage: "planner", roleLabel: "기획자", agent: { id: "claude" } },
    { roleId: "reviewer", stage: "review", roleLabel: "검토자", agent: { id: "codex" } },
    { roleId: "builder", stage: "implementation", roleLabel: "구현자", agent: { id: "agy" } },
  ];
}

test("parseRoleMentions: @팀/@team을 team으로 인식한다", () => {
  assert.deepEqual(parseRoleMentions("@팀 이 설계 어떻게 봐?"), ["team"]);
  assert.deepEqual(parseRoleMentions("@team what do you think?"), ["team"]);
});

test("parseRoleMentions: @팀장·@팀원 같은 다른 단어는 팀 상담을 발동하지 않는다", () => {
  assert.deepEqual(parseRoleMentions("@팀장 회의 잡아줘"), []);
  assert.deepEqual(parseRoleMentions("@팀원들 모여봐"), []);
  assert.deepEqual(parseRoleMentions("@teams 채널에 올려줘"), []);
});

test("consultTeam은 기획자 → 검토자 → 구현자 순서로 한 명씩 답한다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: fakeRunner({}, calls),
  });
  const result = await room.consultTeam(teamSteps());
  await settle(room);

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "agy"],
  );
  // 전원 읽기 전용 — Builder 순서도 쓰기 권한이 없다.
  assert.deepEqual(
    calls.map((call) => call.permissionMode),
    ["workspace-read", "workspace-read", "workspace-read"],
  );
  // Professional Run이 만들어지지 않는다.
  assert.equal(room.professionalRun, null);
  const notices = room.messages.filter((message) => message.authorType === "system");
  assert.ok(notices.some((message) => /팀 상담 시작/.test(message.text)));
  assert.ok(notices.some((message) => /팀 상담을 마쳤습니다/.test(message.text)));
});

test("consultTeam은 중간 실패에서 멈춘다", async () => {
  const agents = makeAgents();
  agents[1].available = false; // 검토자 담당(codex) 사용 불가
  const calls = [];
  const room = new ChatRoom({ agents, runAgent: fakeRunner({}, calls) });
  const result = await room.consultTeam(teamSteps());
  await settle(room);
  assert.equal(result.ok, false);
  // 기획자만 답하고 구현자 순서는 실행되지 않는다.
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
});

test("consultTeam이 중간에 막히면 이유를 채팅에 남긴다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: ({ agent, prompt, attachments, permissionMode }) => {
      calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
      // 첫 순서(기획자)가 답하는 사이 사용자가 토론 시작을 눌렀다고 가정한다.
      room.discussionRequested = true;
      return { promise: Promise.resolve({ ok: true, text: "…" }), cancel: () => {} };
    },
  });
  const result = await room.consultTeam(teamSteps());
  await settle(room);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.map((call) => call.agentId), ["claude"]);
  const notice = room.messages.find(
    (message) => message.authorType === "system" && /팀 상담이 중간에 중단되었습니다/.test(message.text)
  );
  assert.ok(notice, "중간 중단 사유가 시스템 메시지로 남아야 합니다");
  assert.match(notice.text, /토론/);
});

test("consultTeam은 토론·전문 실행 중에는 시작하지 않는다", async () => {
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({}) });
  room.discussionActive = true;
  assert.equal((await room.consultTeam(teamSteps())).ok, false);
  room.discussionActive = false;
  room.specialistActive = true;
  assert.equal((await room.consultTeam(teamSteps())).ok, false);
});

test("팀 상담 진행 중에는 토론 시작이 거부된다(순차 계약 보호)", async () => {
  let releasePlanner;
  const gate = new Promise((resolve) => {
    releasePlanner = resolve;
  });
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { permissionMode: "workspace-write" },
    runAgent: ({ agent }) => {
      // 첫 순서(기획자=claude) 상담을 붙잡아 팀 상담을 진행 중 상태로 유지한다.
      if (agent.id === "claude") {
        return { promise: gate.then(() => ({ ok: true, text: "기획자 의견" })), cancel: () => {} };
      }
      return { promise: Promise.resolve({ ok: true, text: "…" }), cancel: () => {} };
    },
  });
  const teamPromise = room.consultTeam(teamSteps());
  // 기획자 상담이 스케줄돼 팀 상담이 진행 중이 될 때까지 대기.
  const start = Date.now();
  while (!room.isConsultActive()) {
    if (Date.now() - start > 3000) throw new Error("상담 활성 대기 시간 초과");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(room.isConsultActive(), true);

  // 상담 도중 토론 시작은 거부된다 — step 사이에 끼어들어 순차 계약을 깨지 못한다.
  const disc = await room.startDiscussion({ agentIds: ["claude", "codex"] });
  assert.equal(disc.ok, false);
  assert.match(disc.error, /상담/);
  // 상담 도중 두 번째 팀 상담·개별 역할 상담도 거부된다 — 같은 큐에 끼어
  // step이 교차 실행(interleave)되면 "정해진 순서로 한 명씩" 계약이 깨진다.
  const secondTeam = await room.consultTeam(teamSteps());
  assert.equal(secondTeam.ok, false);
  assert.match(secondTeam.error, /상담이 진행 중/);
  const secondRole = await room.consultRole({ roleId: "reviewer", stage: "review", roleLabel: "검토자", agent: { id: "codex" } });
  assert.equal(secondRole.ok, false);
  assert.match(secondRole.error, /상담이 진행 중/);

  releasePlanner();
  await teamPromise;
  await settle(room);
  // 상담이 끝나면 다시 시작할 수 있다.
  assert.equal(room.isConsultActive(), false);
});
