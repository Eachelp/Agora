"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager } = require("../src/agora/task-manager");
const { ChatRoom } = require("../src/chat/chat-room");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
  ];
}

function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments }) => {
    calls.push({ agentId: agent.id, prompt, attachments });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

function makeValidContract(goal = "목표") {
  return [
    "## Goal",
    goal,
    "## Requirements",
    "요구사항 설명",
    "## Implementation Approach",
    "구현 접근 방식",
    "## Acceptance Criteria",
    "완료 수용 기준",
    "## Verification",
    "검증 계획",
    "## Out of Scope",
    "제외 범위",
    "STATUS: PLAN_READY",
  ].join("\n");
}

test("기획서에 필수 섹션이 누락되면 최대 2회까지 Planner에게 자동 보완을 요청하고 보완 성공 시 정상 진행한다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-contract-repair-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];

  const replies = {
    claude: [
      // Round 1: 필수 섹션 누락 (Goal만 있고 나머지 누락)
      { ok: true, text: "## Goal\n로그인 구현만 있음\nSTATUS: PLAN_READY" },
      // Round 2 (Repair 1회): 유효한 전체 계약 반환
      { ok: true, text: makeValidContract("보완된 로그인 목표") },
    ],
    codex: [
      // 기획 검수 통과
      { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
    ],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
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
  // claude(1차 기획 시도) -> claude(2차 보완 기획) -> codex(기획 검수)
  assert.deepEqual(calls.map((c) => c.agentId), ["claude", "claude", "codex"]);
  // 2차 기획 프롬프트에 검증 실패 피드백이 포함되어 있어야 한다
  assert.match(calls[1].prompt, /기획서 검증 실패/);
  assert.match(calls[1].prompt, /Requirements/);
});

test("기획서 필수 섹션 누락이 2회를 초과하여 반복되면 NEEDS_DECISION으로 멈춘다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-contract-fail-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];

  const replies = {
    claude: [
      // 1차 시도: 누락
      { ok: true, text: "## Goal\n1차 시도 불완전\nSTATUS: PLAN_READY" },
      // 2차 시도 (Repair 1회): 여전히 누락
      { ok: true, text: "## Goal\n2차 시도 여전히 불완전\nSTATUS: PLAN_READY" },
      // 3차 시도 (Repair 2회): 여전히 누락
      { ok: true, text: "## Goal\n3차 시도 여전히 불완전\nSTATUS: PLAN_READY" },
    ],
    codex: [],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
  });

  const result = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "planner");
  assert.equal(result.stopReason, "NEEDS_DECISION");
  assert.equal(result.needsUserDecision, true);
  // 3회 호출 후 검수(codex)로 넘어가지 않고 중단됨
  assert.deepEqual(calls.map((c) => c.agentId), ["claude", "claude", "claude"]);
  assert.equal(room.specialistState().status, "WAITING");
  assert.equal(room.specialistState().phase, "PLAN");
  assert.equal(room.specialistState().node, "PLANNING");
  assert.equal(room.specialistResume.phase, "needs_decision");
});
