"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager } = require("../src/agora/task-manager");
const { ChatRoom } = require("../src/chat/chat-room");
const { createProfessionalRun } = require("../src/agora/professional-run");

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

test("실행 게이트에서 필수 heading이 누락된 Task는 TASK_CONTRACT_INCOMPLETE로 중단하고 Builder/Checkpoint를 호출하지 않는다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-exec-gate-missing-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  // Out of Scope가 누락된 불완전한 Task 파일 직접 생성
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const invalidTaskContent = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근 방식",
    "## Acceptance Criteria",
    "완료 기준",
    "## Verification",
    "검증 계획",
  ].join("\n");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), invalidTaskContent, "utf8");

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({}, calls),
    checkpointEngine: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  // READY 상태 주입
  room.setProfessionalRun(createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
  }));
  room.professionalPlan = {
    stages: {
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "step",
    taskInfo: {
      relativePath: ".project-memory/tasks/TASK-001.md",
      filename: "TASK-001.md",
      content: invalidTaskContent,
    },
  };

  const result = await room.startSpecialist({
    action: "implementation",
    stages: room.professionalPlan.stages,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.deepEqual(result.missingSections, ["Out of Scope"]);
  // Builder 호출 0회
  assert.equal(calls.length, 0);
  // Checkpoint 생성 0회
  assert.equal(checkpointCalls.length, 0);

  // 전문 상태에 진단 정보 노출 및 planReady 차단
  const state = room.specialistState();
  assert.equal(state.status, "WAITING");
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(state.planReady, false);
  assert.equal(state.needsInput, true);
  assert.deepEqual(state.missingSections, ["Out of Scope"]);

  // 시스템 메시지가 1회만 등록되고 누락 섹션 진단이 포함되어 있어야 한다 (중복 메시지 방지)
  const systemMessages = room.messages.filter((m) => m.authorType === "system");
  const errorMessages = systemMessages.filter((m) => m.text.includes("동결된 Task의 계약이 불완전해"));
  assert.equal(errorMessages.length, 1, "에러 메시지는 1회만 출력되어야 한다");
  assert.match(errorMessages[0].text, /Out of Scope/);
});

test("heading은 있지만 meaningful body가 없는 Task도 실행 게이트에서 차단된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-exec-gate-empty-body-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  // Verification 본문이 빈 코드 펜스만 있는 Task
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const invalidTaskContent = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근 방식",
    "## Acceptance Criteria",
    "완료 기준",
    "## Verification",
    "```js\n// empty code fence only\n```",
    "## Out of Scope",
    "제외 범위",
  ].join("\n");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), invalidTaskContent, "utf8");

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({}, calls),
    checkpointEngine: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  room.professionalPlan = {
    stages: {
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "step",
    taskInfo: {
      relativePath: ".project-memory/tasks/TASK-001.md",
      filename: "TASK-001.md",
      content: invalidTaskContent,
    },
  };
  room.setProfessionalRun(createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
  }));

  const result = await room.startSpecialist({
    action: "implementation",
    stages: room.professionalPlan.stages,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.deepEqual(result.missingSections, ["Verification"]);
  assert.equal(calls.length, 0);
  assert.equal(checkpointCalls.length, 0);
});

test("TASK_CONTRACT_INCOMPLETE 상태에서 '기획 보완'으로 복구 후 정상 실행까지 완료된다 (불변성 유지)", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-replan-recovery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  // 1) 불완전한 Task로 시작
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const incompleteTask = [
    "## Goal",
    "불완전한 목표",
    "## Requirements",
    "요구사항",
  ].join("\n");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), incompleteTask, "utf8");

  const replies = {
    claude: [
      // 기획 보완 실행 시 Planner가 유효한 전체 계약 작성
      { ok: true, text: makeValidContract("보완 완료된 목표") },
      // 구현 단계 (Builder)
      { ok: true, text: "구현 완료\nSTATUS: DONE" },
    ],
    codex: [
      // 기획 검수 통과
      { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
      // 구현 검수 통과
      { ok: true, text: "구현 검수 통과\nVERDICT: PASS" },
    ],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
    checkpoint: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  room.professionalPlan = {
    stages: {
      planner: { agent: room.findAgent("claude") },
      planReview: { agent: room.findAgent("codex") },
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "step",
    taskInfo: {
      relativePath: ".project-memory/tasks/TASK-001.md",
      filename: "TASK-001.md",
      content: incompleteTask,
    },
  };
  room.setProfessionalRun(createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
  }));

  // 2) 실행 시도 -> TASK_CONTRACT_INCOMPLETE로 차단
  const execResult = await room.startSpecialist({
    action: "implementation",
    stages: room.professionalPlan.stages,
  });
  assert.equal(execResult.ok, false);
  assert.equal(execResult.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(room.specialistResume.phase, "task_contract_incomplete");

  // 3) 기획 보완 트리거 (answerPlanQuestion)
  const replanResult = await room.answerPlanQuestion("빠진 섹션들을 보완해서 다시 기획해줘");
  assert.equal(replanResult.ok, true);
  assert.equal(replanResult.planReady, true);

  // Planner 프롬프트에 계약 누락 진단 정보가 전달되었는지 확인
  const plannerCall = calls.find((c) => c.prompt.includes("기획서 계약 누락"));
  assert.ok(plannerCall, "Planner 프롬프트에 계약 누락 피드백이 전달되어야 한다");
  assert.match(plannerCall.prompt, /Implementation Approach/);

  // 4) 보완 후 정상 실행 재개
  const proceedResult = await room.startSpecialist({
    action: "implementation",
    stages: room.professionalPlan.stages,
  });
  assert.equal(proceedResult.ok, true);
  // Checkpoint가 정상 생성되고 Builder가 실행됨
  assert.ok(checkpointCalls.length > 0, "보완 후에는 Checkpoint가 생성되어야 한다");
  assert.ok(calls.some((c) => c.prompt.includes("Frozen Task")), "Builder가 정상 실행되어야 한다");
});

test("TASK_CONTRACT_INCOMPLETE 상태에서 '실행 중단(cancel)' 시 Builder 호출 없이 정상 종료된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-cancel-recovery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const incompleteTask = "## Goal\n목표만 있음";
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), incompleteTask, "utf8");

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner({}, calls),
  });

  room.professionalPlan = {
    stages: {
      implementation: { agent: room.findAgent("claude") },
      review: { agent: room.findAgent("codex") },
    },
    mode: "step",
    taskInfo: {
      relativePath: ".project-memory/tasks/TASK-001.md",
      filename: "TASK-001.md",
      content: incompleteTask,
    },
  };
  room.setProfessionalRun(createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
  }));

  // 1) 실행 시도 -> 차단
  await room.startSpecialist({
    action: "implementation",
    stages: room.professionalPlan.stages,
  });
  assert.equal(room.specialistState().status, "WAITING");

  // 2) 실행 중단
  const cancelResult = room.cancelSpecialist();
  assert.equal(cancelResult.ok, true);
  assert.equal(room.specialistState().status, "INTERRUPTED");
  assert.equal(calls.length, 0);
});
