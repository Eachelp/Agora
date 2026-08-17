"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager, hashText } = require("../src/agora/task-manager");
const { ChatRoom } = require("../src/chat/chat-room");
const { createProfessionalRun, transitionProfessionalRun } = require("../src/agora/professional-run");
const { WorkflowStore } = require("../src/agora/workflow-store");

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

test("Test A: Rehydration 시 invalid READY Task는 실행 버튼 클릭 전에 즉시 발견되어 recovery 상태로 복원된다", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-invalid-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const incompleteTask = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
  ].join("\n");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), incompleteTask, "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      planReview: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
      implementation: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      review: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  // ChatRoom 생성만 수행 (startSpecialist 호출하지 않음!)
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}, calls),
    checkpoint: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  const state = room.specialistState();
  assert.equal(state.planReady, false, "실행 클릭 전부터 planReady는 false여야 한다");
  assert.equal(state.needsInput, true, "사용자 입력 대기 상태여야 한다");
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.ok(Array.isArray(state.missingSections) && state.missingSections.includes("Out of Scope"), "missingSections가 정확히 노출되어야 한다");
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete", "specialistResume가 복구되어 있어야 한다");
  assert.equal(room.professionalPlan, null, "불완전한 Task는 professionalPlan으로 복원되지 않아야 한다");

  // AI 호출 및 Checkpoint 0회
  assert.equal(calls.length, 0, "앱 재시작만으로 AI 호출이 없어야 한다");
  assert.equal(checkpointCalls.length, 0, "Checkpoint 생성이 없어야 한다");
});

test("Test B: Rehydration 시 valid READY Task는 정상적으로 professionalPlan이 복원되고 planReady가 true이다", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-valid-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const validTask = makeValidContract("유효한 목표");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), validTask, "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    stopReason: "PLAN_READY",
    taskPath: ".project-memory/tasks/TASK-001.md",
    approvedTaskHash: hashText(validTask),
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}),
  });

  const state = room.specialistState();
  assert.equal(state.planReady, true, "유효한 Task는 planReady가 true여야 한다");
  assert.notEqual(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.ok(room.professionalPlan, "professionalPlan이 정상 복원되어야 한다");
  assert.equal(state.missingSections, null, "missingSections가 없어야 한다");
});

test("Test C: Rehydrated invalid Task 상태에서 기획 보완 실행 시 새 valid Task로 갱신되고 stale missingSections가 정리된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-replan-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), "## Goal\n불완전", "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
    approvedTaskHash: "old-stale-hash",
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      planReview: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
      implementation: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      review: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  const replies = {
    claude: [
      { ok: true, text: makeValidContract("보완 완료된 유효 목표") },
    ],
    codex: [
      { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
    ],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner(replies, calls),
  });

  // Rehydration 직후: invalid 확인
  assert.equal(room.specialistState().planReady, false);
  assert.ok(room.specialistState().missingSections.length > 0);

  // 기획 보완 실행
  const replanResult = await room.answerPlanQuestion("빠진 섹션들을 보완해줘");
  assert.equal(replanResult.ok, true);
  assert.equal(replanResult.planReady, true);

  // Planner 프롬프트에 진단 정보가 전달되었는지 확인
  const plannerCall = calls.find((c) => c.prompt.includes("기획서 계약 누락"));
  assert.ok(plannerCall);

  // 보완 완료 후 state 확인: stale missingSections가 정리되고 approvedTaskHash가 갱신되어야 한다
  const state = room.specialistState();
  assert.equal(state.planReady, true);
  assert.equal(state.missingSections, null, "보완 완료 후 missingSections는 null이어야 한다");
  assert.notEqual(room.professionalRun.approvedTaskHash, "old-stale-hash", "approvedTaskHash는 새 Task 기준이어야 한다");
});

test("Test D: USER_ANSWER_PLAN / PLAN_REVIEW_PASS / REPLAN_RESET 전이 시 stale missingSections가 clear된다", () => {
  let run = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    stopReason: "TASK_CONTRACT_INCOMPLETE",
    missingSections: ["Verification", "Out of Scope"],
  });

  // 1) USER_ANSWER_PLAN -> missingSections clear
  let res = transitionProfessionalRun(run, { type: "USER_ANSWER_PLAN" });
  assert.equal(res.ok, true);
  assert.equal(res.state.node, "PLANNING");
  assert.equal(res.state.missingSections, null, "USER_ANSWER_PLAN 시 missingSections가 null로 정리되어야 한다");

  // 2) PLAN_REVIEW_PASS -> missingSections clear
  let reviewRun = createProfessionalRun({
    node: "PLAN_REVIEW",
    status: "RUNNING",
    missingSections: ["Out of Scope"],
  });
  let passRes = transitionProfessionalRun(reviewRun, { type: "PLAN_REVIEW_PASS", approvedTaskHash: "hash-new" });
  assert.equal(passRes.ok, true);
  assert.equal(passRes.state.node, "READY");
  assert.equal(passRes.state.missingSections, null, "PLAN_REVIEW_PASS 시 missingSections가 null로 정리되어야 한다");

  // 3) REPLAN_RESET -> missingSections clear
  let resetRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    missingSections: ["Goal"],
  });
  let resetRes = transitionProfessionalRun(resetRun, { type: "REPLAN_RESET" });
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.state.missingSections, null, "REPLAN_RESET 시 missingSections가 null로 정리되어야 한다");
});

test("Test E: Rehydration 시 constructor가 transcript에 새로운 시스템 에러 메시지를 중복 append하지 않는다", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-no-msg-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), "## Goal\n불완전", "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}),
  });

  // Rehydration은 상태 복원이지 transcript mutation이 아니므로 새 system message가 없어야 한다
  const systemMessages = room.messages.filter((m) => m.authorType === "system");
  assert.equal(systemMessages.length, 0, "constructor rehydration 시 새 시스템 메시지가 append되지 않아야 한다");
});

test("READY + empty TASK.md rehydration: 생성 즉시 planReady:false, Builder/Checkpoint 0, AI 자동 호출 없음", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-empty-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  // 완전히 빈 TASK.md 파일 생성
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), "", "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-001.md",
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      review: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}, calls),
    checkpoint: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  const state = room.specialistState();
  assert.equal(state.planReady, false, "빈 TASK.md는 생성 즉시 planReady가 false여야 한다");
  assert.equal(state.needsInput, true, "사용자 입력 대기 상태여야 한다");
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(state.missingSections.length, 6, "필수 6개 섹션이 모두 missing이어야 한다");
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete");
  assert.equal(room.professionalPlan, null);
  assert.equal(calls.length, 0, "AI 호출이 없어야 한다");
  assert.equal(checkpointCalls.length, 0, "Checkpoint 호출이 없어야 한다");
});

test("Regression Test B: 여러 historical revision이 존재하는 taskPath에 새 Task가 복구될 때 이전 revision들이 superseded로 보존된다", () => {
  const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-b-wf-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-b-ws-"));
  const projectId = "proj-reg-b";
  const relPath = path.join(".project-memory", "tasks", "TASK-001.md");
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  const workflow = new WorkflowStore({ root: wfRoot }).init();
  // Revision A: superseded
  const revA = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-A",
    status: "done",
    lastRunId: "RUN-A",
    syncState: "superseded",
  });
  // Revision B: missing_file
  const revB = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-B",
    status: "done",
    lastRunId: "RUN-B",
    syncState: "missing_file",
  });

  // 디스크에 새 파일 content (hash C) 생성
  const contentC = makeValidContract("새 목표 C");
  const hashC = hashText(contentC);
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), contentC, "utf8");

  // reconcile
  workflow.reconcileProjectTasks(projectId, workspace);

  const all = workflow.listTasks(projectId, { includeAll: true });
  const entryA = all.find((t) => t.id === revA.id);
  const entryB = all.find((t) => t.id === revB.id);
  const canonical = workflow.listTasks(projectId).find((t) => t.taskPath === relPath);

  assert.equal(entryA.syncState, "superseded");
  assert.equal(entryA.taskHash, "hash-A");
  assert.equal(entryA.lastRunId, "RUN-A");

  assert.equal(entryB.syncState, "superseded");
  assert.equal(entryB.taskHash, "hash-B");
  assert.equal(entryB.lastRunId, "RUN-B");

  assert.ok(canonical);
  assert.equal(canonical.syncState, "ok");
  assert.equal(canonical.taskHash, hashC);
  assert.equal(canonical.lastRunId, null);
});

test("Regression Test C/D: onProfessionalTaskState는 missing_file 또는 superseded 태스크를 ok로 부활시키지 않고 거부한다", () => {
  const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-cd-wf-"));
  const projectId = "proj-reg-cd";
  const relPath = path.join(".project-memory", "tasks", "TASK-001.md");

  const workflow = new WorkflowStore({ root: wfRoot }).init();
  const missingEntry = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-old",
    status: "todo",
    syncState: "missing_file",
  });
  const supersededEntry = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-older",
    status: "done",
    syncState: "superseded",
  });

  // IPC onProfessionalTaskState 로직 시뮬레이션
  function applyProfessionalState({ taskPath, taskHash, status, activeRunId, lastRunId }) {
    const p = taskPath.replace(/[\\/]+/g, path.sep);
    const activeTasks = workflow
      .listTasks(projectId)
      .filter(
        (entry) =>
          entry.taskPath &&
          entry.taskPath.replace(/[\\/]+/g, path.sep) === p &&
          entry.syncState === "ok"
      );
    let task = null;
    if (taskHash) {
      task = activeTasks.find((entry) => entry.taskHash === taskHash) || null;
    } else if (activeTasks.length === 1) {
      task = activeTasks[0];
    }
    if (!task) return false;
    return Boolean(workflow.updateTask(task.id, { status, activeRunId, lastRunId }));
  }

  // missing_file 또는 superseded 태스크는 active 목록(ok)에 없으므로 fail-closed (false)
  assert.equal(applyProfessionalState({ taskPath: relPath, taskHash: "hash-old", status: "in_progress" }), false);
  assert.equal(applyProfessionalState({ taskPath: relPath, taskHash: "hash-older", status: "in_progress" }), false);

  // syncState가 변경되지 않고 유지됨
  assert.equal(workflow.getTask(missingEntry.id).syncState, "missing_file");
  assert.equal(workflow.getTask(supersededEntry.id).syncState, "superseded");
});

test("Regression Test E: exact canonical revision에만 실행 상태가 갱신되고 과거 revision은 영향받지 않는다", () => {
  const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-e-wf-"));
  const projectId = "proj-reg-e";
  const relPath = path.join(".project-memory", "tasks", "TASK-001.md");

  const workflow = new WorkflowStore({ root: wfRoot }).init();
  const oldEntry = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-OLD",
    status: "done",
    lastRunId: "RUN-OLD",
    syncState: "superseded",
  });
  const newEntry = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: "hash-NEW",
    status: "todo",
    lastRunId: null,
    syncState: "ok",
  });

  function applyProfessionalState({ taskPath, taskHash, status, activeRunId, lastRunId }) {
    const p = taskPath.replace(/[\\/]+/g, path.sep);
    const activeTasks = workflow
      .listTasks(projectId)
      .filter(
        (entry) =>
          entry.taskPath &&
          entry.taskPath.replace(/[\\/]+/g, path.sep) === p &&
          entry.syncState === "ok"
      );
    let task = null;
    if (taskHash) {
      task = activeTasks.find((entry) => entry.taskHash === taskHash) || null;
    } else if (activeTasks.length === 1) {
      task = activeTasks[0];
    }
    if (!task) return false;
    return Boolean(workflow.updateTask(task.id, { status, activeRunId, lastRunId }));
  }

  const updated = applyProfessionalState({
    taskPath: relPath,
    taskHash: "hash-NEW",
    status: "in_progress",
    activeRunId: "RUN-NEW",
    lastRunId: null,
  });
  assert.equal(updated, true);

  // NEW만 갱신됨
  const newRecord = workflow.getTask(newEntry.id);
  assert.equal(newRecord.status, "in_progress");
  assert.equal(newRecord.activeRunId, "RUN-NEW");
  assert.equal(newRecord.taskHash, "hash-NEW");
  assert.equal(newRecord.syncState, "ok");

  // OLD는 전혀 변경되지 않음
  const oldRecord = workflow.getTask(oldEntry.id);
  assert.equal(oldRecord.status, "done");
  assert.equal(oldRecord.lastRunId, "RUN-OLD");
  assert.equal(oldRecord.taskHash, "hash-OLD");
  assert.equal(oldRecord.syncState, "superseded");
  assert.equal(oldRecord.activeRunId, null);
});

test("Regression Test F: normal Planner revision provenance: 기존 파일 수정 시에도 old는 superseded되고 new가 canonical이 된다", () => {
  const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-f-wf-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-reg-f-ws-"));
  const projectId = "proj-reg-f";
  const relPath = path.join(".project-memory", "tasks", "TASK-001.md");
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  const workflow = new WorkflowStore({ root: wfRoot }).init();
  const oldContent = makeValidContract("초기 목표");
  const oldHash = hashText(oldContent);
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), oldContent, "utf8");

  const oldTask = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    contentSource: "file",
    taskPath: relPath,
    taskHash: oldHash,
    status: "todo",
    syncState: "ok",
  });

  // Planner가 같은 파일에 새 내용 작성
  const newContent = makeValidContract("재기획된 목표");
  const newHash = hashText(newContent);
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), newContent, "utf8");

  // reconcileProjectTasks 호출
  workflow.reconcileProjectTasks(projectId, workspace);

  const all = workflow.listTasks(projectId, { includeAll: true });
  const oldRecord = all.find((t) => t.id === oldTask.id);
  const canonical = workflow.listTasks(projectId).find((t) => t.taskPath === relPath);

  assert.equal(oldRecord.syncState, "superseded", "과거 task는 superseded 처리되어야 한다");
  assert.equal(oldRecord.taskHash, oldHash, "과거 taskHash는 보존되어야 한다");

  assert.ok(canonical, "새 canonical task가 존재해야 한다");
  assert.equal(canonical.syncState, "ok");
  assert.equal(canonical.taskHash, newHash);
});

test("Integration Test 1: missing_file 상태의 Workflow task가 기획 보완 recovery를 통해 정상 갱신 및 완료된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int1-missing-recovery-"));
  const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int1-wf-"));
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(wfRoot, { recursive: true, force: true });
  });

  const projectId = "proj-int-1";
  const sessionId = "sess-int-1";
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskFilePath = path.join(tasksDir, "TASK-001.md");
  const relTaskPath = path.join(".project-memory", "tasks", "TASK-001.md");
  const oldContent = makeValidContract("과거 목표");
  const oldHash = hashText(oldContent);
  fs.writeFileSync(taskFilePath, oldContent, "utf8");

  // 1) WorkflowStore 초기화 및 file-backed task 등록
  const workflow = new WorkflowStore({ root: wfRoot }).init();
  const createdEntry = workflow.createTask({
    projectId,
    title: "TASK-001.md",
    description: "",
    contentSource: "file",
    taskPath: relTaskPath,
    taskHash: oldHash,
    status: "done",
    lastRunId: "RUN-OLD",
    role: "implementation",
    chatId: sessionId,
    origin: "planner",
  });
  assert.ok(createdEntry);
  assert.equal(createdEntry.syncState, "ok");
  assert.equal(createdEntry.lastRunId, "RUN-OLD");

  // 2) TASK-001.md 삭제 후 reconcile
  fs.unlinkSync(taskFilePath);
  workflow.reconcileProjectTasks(projectId, workspace);
  const missingTask = workflow.listTasks(projectId, { includeMissing: true }).find((t) => t.taskPath === relTaskPath);
  assert.ok(missingTask);
  assert.equal(missingTask.syncState, "missing_file", "파일 삭제 후 syncState가 missing_file이어야 한다");
  assert.equal(missingTask.taskHash, oldHash);
  assert.equal(missingTask.lastRunId, "RUN-OLD");

  // 3) READY professionalRun으로 ChatRoom rehydrate
  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: relTaskPath,
    approvedTaskHash: oldHash,
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      planReview: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
      implementation: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      review: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  const calls = [];
  const newValidContent = makeValidContract("보완된 새 목표");
  const replies = {
    claude: [
      { ok: true, text: newValidContent },
    ],
    codex: [
      { ok: true, text: "기획 검수 통과\nVERDICT: PASS" },
    ],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner(replies, calls),
    onTaskCreated: (task) => {
      return Boolean(workflow.createTask({
        projectId,
        title: task.title || "Planner Task",
        description: task.description || "",
        contentSource: task.contentSource || "file",
        taskPath: task.taskPath || null,
        taskHash: task.taskHash || null,
        status: task.status || "todo",
        role: task.role || "implementation",
        chatId: sessionId,
        origin: "planner",
      }));
    },
    onTaskUpdated: ({ taskPath, taskHash, status }) => {
      const normPath = String(taskPath || "").replace(/[\\/]+/g, path.sep);
      let target = workflow
        .listTasks(projectId)
        .find(
          (t) =>
            t.taskPath &&
            t.taskPath.replace(/[\\/]+/g, path.sep) === normPath &&
            t.taskHash === taskHash &&
            t.syncState === "ok"
        );
      if (!target && workspace) {
        workflow.reconcileProjectTasks(projectId, workspace);
        target = workflow
          .listTasks(projectId)
          .find(
            (t) =>
              t.taskPath &&
              t.taskPath.replace(/[\\/]+/g, path.sep) === normPath &&
              t.taskHash === taskHash &&
              t.syncState === "ok"
          );
      }
      if (!target) return false;
      if (status && status !== target.status) {
        workflow.updateTask(target.id, { status });
      }
      return Boolean(target);
    },
  });

  // Rehydration 직후 검증
  const state = room.specialistState();
  assert.equal(state.planReady, false, "missing task는 rehydration 즉시 planReady false여야 한다");
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete");

  // 4) 사용자 기획 보완 실행
  const replanResult = await room.answerPlanQuestion("작업 지시서를 다시 작성해서 계속 진행해줘");
  assert.equal(replanResult.ok, true, "기획 보완이 성공해야 한다");
  assert.equal(replanResult.planReady, true);

  // 5) 결과 검증
  assert.ok(fs.existsSync(taskFilePath), "TASK.md 파일이 다시 생성되어 있어야 한다");
  const rehydratedState = room.specialistState();
  assert.equal(rehydratedState.planReady, true);
  assert.equal(rehydratedState.stopReason, "PLAN_READY");
  assert.notEqual(room.professionalRun.approvedTaskHash, oldHash);
  assert.equal(rehydratedState.missingSections, null);

  // Workflow Provenance 검증:
  // 1) OLD revision: superseded, taskHash: oldHash, lastRunId: "RUN-OLD" 보존
  const allTasks = workflow.listTasks(projectId, { includeAll: true });
  const oldTaskEntry = allTasks.find((t) => t.id === createdEntry.id);
  assert.ok(oldTaskEntry, "과거 task record가 보존되어야 한다");
  assert.equal(oldTaskEntry.syncState, "superseded", "과거 task는 superseded여야 한다");
  assert.equal(oldTaskEntry.taskHash, oldHash, "과거 task의 hash는 덮어쓰여지지 않아야 한다");
  assert.equal(oldTaskEntry.lastRunId, "RUN-OLD", "과거 run metadata가 보존되어야 한다");

  // 2) NEW canonical revision: syncState: "ok", taskHash: newHash, clean run metadata
  const canonicalTask = workflow.listTasks(projectId).find((t) => t.taskPath === relTaskPath);
  assert.ok(canonicalTask, "workflow에 활성 태스크로 존재해야 한다");
  assert.equal(canonicalTask.syncState, "ok");
  assert.equal(canonicalTask.taskHash, room.professionalRun.approvedTaskHash);
  assert.equal(canonicalTask.lastRunId, null, "새 canonical 태스크는 과거 lastRunId를 상속하지 않아야 한다");
  assert.equal(canonicalTask.activeRunId, null, "새 canonical 태스크는 과거 activeRunId를 상속하지 않아야 한다");
});

test("Integration Test 2: .project-memory/tasks 디렉터리 자체가 삭제된 경우에도 안전하게 디렉터리를 재생성하여 복구된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int2-tasks-dir-deleted-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const relTaskPath = path.join(".project-memory", "tasks", "TASK-001.md");
  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: relTaskPath,
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      planReview: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  // .project-memory 디렉터리 자체가 없는 상태에서 시작
  const validTask = makeValidContract("디렉터리 재생성 목표");
  const replies = {
    claude: [{ ok: true, text: validTask }],
    codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner(replies),
  });

  assert.equal(room.specialistState().planReady, false);
  const result = await room.answerPlanQuestion("디렉터리와 작업 지시서를 새로 생성해줘");
  assert.equal(result.ok, true);
  assert.equal(result.planReady, true);
  assert.ok(fs.existsSync(path.join(workspace, relTaskPath)), "tasks 디렉터리와 TASK.md 파일이 안전하게 생성되어야 한다");
});

test("Integration Test 3: persisted TASK_CONTRACT_INCOMPLETE 상태에서 외부에서 TASK.md를 valid하게 수정해도 자동 승인되지 않고 re-review recovery를 거친다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int3-external-repair-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, "TASK-001.md");
  const validContent = makeValidContract("외부에서 수정한 유효한 목표");
  // 파일 내용은 외부에서 유효하게 수정됨
  fs.writeFileSync(taskPath, validContent, "utf8");

  // professionalRun은 이전 실패로 인해 TASK_CONTRACT_INCOMPLETE 상태로 persist됨
  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    stopReason: "TASK_CONTRACT_INCOMPLETE",
    approvedTaskHash: null,
    missingSections: ["Out of Scope"],
    taskPath: ".project-memory/tasks/TASK-001.md",
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      planReview: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  const calls = [];
  const replies = {
    claude: [{ ok: true, text: validContent }],
    codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
  };

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner(replies, calls),
  });

  // Rehydrate 직후: 자동 승인 금지 확인
  const state = room.specialistState();
  assert.equal(state.planReady, false, "외부 수정이 valid하더라도 자동 승인되면 안 된다");
  assert.equal(state.needsInput, true, "재검수/보완 대기 상태여야 한다");
  assert.equal(room.professionalRun.approvedTaskHash, null);
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete");
  assert.equal(calls.length, 0, "앱 시작 시 AI 자동 호출이 없어야 한다");

  // 사용자 기획 보완 / 재검수 실행
  const replanResult = await room.answerPlanQuestion("현재 작성된 내용으로 기획 검수를 진행해줘");
  assert.equal(replanResult.ok, true);
  assert.equal(replanResult.planReady, true);
  assert.equal(room.specialistState().planReady, true);
  assert.ok(room.professionalRun.approvedTaskHash);
  assert.equal(room.specialistState().missingSections, null);
});

test("Integration Test 4: 정상 approved READY Task는 Rehydration 시 professionalPlan이 복원되고 planReady가 true이다", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int4-normal-approved-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const validContent = makeValidContract("정상 승인된 목표");
  const taskHash = hashText(validContent);
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), validContent, "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    stopReason: "PLAN_READY",
    approvedTaskHash: taskHash,
    taskPath: ".project-memory/tasks/TASK-001.md",
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}),
  });

  const state = room.specialistState();
  assert.equal(state.planReady, true, "정상 승인된 Task는 planReady가 true여야 한다");
  assert.equal(state.stopReason, "PLAN_READY");
  assert.ok(room.professionalPlan);
  assert.equal(room.specialistResume, null, "정상 READY 상태에서는 recovery resume이 없어야 한다");
});

test("Integration Test 5: valid Task지만 approvedTaskHash가 없는 READY 상태는 자동 승인되지 않고 recovery 대기로 복원된다", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-int5-no-hash-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const validContent = makeValidContract("해시 없는 유효 목표");
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), validContent, "utf8");

  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    stopReason: "PLAN_READY",
    approvedTaskHash: null, // 해시 누락/미승인
    taskPath: ".project-memory/tasks/TASK-001.md",
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}),
  });

  const state = room.specialistState();
  assert.equal(state.planReady, false, "approvedTaskHash가 없으면 자동 승인되지 않아야 한다");
  assert.equal(state.needsInput, true);
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete");
  assert.equal(room.professionalPlan, null);
});

test("READY + missing TASK.md rehydration: 파일 부재 시 생성 즉시 planReady:false, recovery 상태, Builder/Checkpoint 0, AI 자동 호출 없음", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-rehydrate-missing-file-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const checkpointCalls = [];

  // TASK.md 파일을 생성하지 않음 (파일 부재)
  const initialProfessionalRun = createProfessionalRun({
    node: "READY",
    status: "WAITING",
    taskPath: ".project-memory/tasks/TASK-NOT-EXISTS.md",
    stages: {
      planner: { agent: { id: "claude", name: "Claude", available: true, enabled: true } },
      review: { agent: { id: "codex", name: "Codex", available: true, enabled: true } },
    },
  });

  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    initialProfessionalRun,
    runAgent: fakeRunner({}, calls),
    checkpoint: {
      createCheckpoint: async (ws, opts) => {
        checkpointCalls.push({ ws, opts });
        return { supported: true, checkpointId: "cp-test" };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });

  const state = room.specialistState();
  assert.equal(state.planReady, false, "존재하지 않는 TASK.md는 생성 즉시 planReady가 false여야 한다");
  assert.equal(state.needsInput, true, "사용자 입력 대기 상태여야 한다");
  assert.equal(state.stopReason, "TASK_CONTRACT_INCOMPLETE");
  assert.equal(room.specialistResume?.phase, "task_contract_incomplete");
  assert.equal(room.professionalPlan, null);
  assert.equal(calls.length, 0, "AI 호출이 없어야 한다");
  assert.equal(checkpointCalls.length, 0, "Checkpoint 호출이 없어야 한다");
});
