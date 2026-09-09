"use strict";

// Stage D — 2차 독립 검수 잔여 blocker(B3·B5·B7) 회귀 테스트.
//
// 2차 검수는 1차의 9건 중 3건이 절반만 닫혔다고 판정했다.
//
//   B3  persist() 실패가 아직 fail-open — 기록 못 한 판정으로 PASS까지 감
//   B5  승인은 assurance만 풀고 Run은 BLOCKED에 남음 — Recorder/COMPLETED 미도달
//   B7  frozen은 닫혔으나 live retrieval provenance seam 없음
//
// production 진입점(`resumeSpecialist`)에서 시작한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatRoom } = require("../src/chat/chat-room");
const { TaskManager } = require("../src/agora/task-manager");
const { WorkflowStore } = require("../src/agora/workflow-store");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
  ];
}

function fakeRunner(replies, calls = []) {
  return ({ agent, prompt }) => {
    calls.push({ agentId: agent.id, prompt });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

const PLAN_PREDICATE = "```json\n" + JSON.stringify([
  { id: "V1", method: "predicate", statement: "보고서가 만들어졌다", check: { kind: "exists", path: "report.md" } },
]) + "\n```";

const PLAN_WITH_HUMAN = "```json\n" + JSON.stringify([
  { id: "V1", method: "predicate", statement: "보고서가 만들어졌다", check: { kind: "exists", path: "report.md" } },
  { id: "V2", method: "human", statement: "외부 발송 승인" },
]) + "\n```";

function v2Task({ inputs = "- 없음", plan = PLAN_PREDICATE } = {}) {
  return [
    "## Goal\n보고서를 만든다.",
    `## Inputs / Source Data\n${inputs}`,
    "## Requirements\n요구사항 설명.",
    "## Work Approach\n작업 접근 방식.",
    "## Deliverables\n- `report.md`",
    "## Acceptance Criteria\n완료 수용 기준.",
    `## Verification Plan\n${plan}`,
    "## Out of Scope\n제외 범위.",
  ].join("\n\n");
}

function setupWorkspace(taskContent) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-rep2-")));
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), taskContent, "utf8");
  return {
    workspace,
    taskInfo: { filename: "TASK-001.md", relativePath: path.join(".project-memory", "tasks", "TASK-001.md") },
  };
}

function makeRoom(workspace, replies, calls = [], { withProfessionalRun = false } = {}) {
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
    checkpointEngine: {
      createCheckpoint: async () => ({ supported: false }),
      cleanupCheckpoint: () => ({ ok: true }),
      restoreCheckpoint: async () => ({ ok: true }),
    },
    // Run FSM까지 실제로 도는지 보려면 professionalRun이 있어야 한다.
    // 승인 → 기록 → COMPLETED가 상태로도 확인되어야 B5가 닫힌다.
    // plan_ready 재개 시점의 실제 FSM 상태는 "승인된 기획, 실행 대기"다.
    ...(withProfessionalRun
      ? { initialProfessionalRun: { node: "READY", status: "WAITING", stopReason: "PLAN_READY" } }
      : {}),
  });
  return room;
}

function stepStages(room) {
  return {
    implementation: { agent: room.findAgent("claude") },
    review: { agent: room.findAgent("codex") },
    recorder: { agent: room.findAgent("codex") },
  };
}

function primeStep(room, taskInfo) {
  room.specialistResume = {
    stages: stepStages(room),
    mode: "step",
    phase: "plan_ready",
    taskInfo,
    feedback: "",
    maxAutoRevisions: 0,
  };
}

function trackWorkflowTask(room, workspace, taskInfo) {
  const root = path.join(workspace, "workflow-test");
  const workflow = new WorkflowStore({ root }).init();
  const task = workflow.createTask({
    projectId: "approval-test", title: taskInfo.filename,
    contentSource: "file", taskPath: taskInfo.relativePath, status: "todo",
  });
  room.onProfessionalTaskState = ({ status, activeRunId, lastRunId }) =>
    Boolean(workflow.updateTask(task.id, { status, activeRunId, lastRunId }));
  return () => new WorkflowStore({ root }).init().getTask(task.id);
}

const BUILDER_DONE = { ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" };

// ---- B5 — 승인이 workflow를 실제로 이어야 한다 ----

test("B5: 사용자 승인 후 Recorder까지 진행되어 Run이 COMPLETED가 된다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const room = makeRoom(
      workspace,
      {
        claude: [BUILDER_DONE],
        codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
      },
      [],
      { withProfessionalRun: true }
    );
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    primeStep(room, taskInfo);
    await room.resumeSpecialist();                  // builder
    const reviewed = await room.resumeSpecialist(); // review → 승인 대기

    // 승인 대기는 실패가 아니라 예고된 대기다(§9 P-3). BLOCKED로 만들지 않는다.
    assert.equal(reviewed.stopReason, "HUMAN_APPROVAL_REQUIRED");
    assert.ok(!room.specialistBlocked, "승인 대기를 BLOCKED로 만들면 사용자가 빠져나올 수 없다");
    assert.equal(room.specialistResume.phase, "awaiting_human_approval");

    // 승인 전에는 그냥 진행할 수 없다(§20).
    const premature = await room.resumeSpecialist();
    assert.equal(premature.stopReason, "HUMAN_APPROVAL_REQUIRED");

    const resolved = room.resolveHumanApproval({ criterionId: "V2", approved: true });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.final.finalPass, true, JSON.stringify(resolved.final?.blockers));
    assert.equal(resolved.resumable, true, "승인 후 이어서 진행할 수 있어야 한다");

    // 여기까지 가야 B5가 닫힌다 — 승인이 assurance만 풀고 끝나면 안 된다.
    const completed = await room.resumeSpecialist();
    assert.equal(completed.ok, true, JSON.stringify(completed));
    assert.equal(completed.recorded, true, "Recorder가 실제로 실행되어야 한다");
    // 그리고 그 사실이 provenance에도 남는다(§26).
    const explained = room.assuranceRun.explain();
    assert.equal(explained.finalVerdict, "PASS");
    assert.deepEqual(explained.humanApproved, [{ criterionId: "V2", outcome: "PASS" }]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 승인 이후 결과물이 바뀌면 기록 직전에 다시 막힌다 (INV-5)", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const room = makeRoom(
      workspace,
      {
        claude: [BUILDER_DONE],
        codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
      },
      [],
      { withProfessionalRun: true }
    );
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    primeStep(room, taskInfo);
    await room.resumeSpecialist();
    await room.resumeSpecialist();
    assert.equal(room.resolveHumanApproval({ criterionId: "V2", approved: true }).final.finalPass, true);

    // 승인 이후 외부 에디터가 결과물을 고쳤다.
    fs.writeFileSync(path.join(workspace, "report.md"), "# 누가 바꿈");
    const blocked = await room.resumeSpecialist();
    assert.equal(blocked.ok, false, "바뀐 결과물로 기록까지 가면 안 된다");
    assert.notEqual(room.professionalRun.status, "COMPLETED");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 거부는 진행 허가가 아니다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const room = makeRoom(
      workspace,
      {
        claude: [BUILDER_DONE],
        codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
      },
      [],
      { withProfessionalRun: true }
    );
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    primeStep(room, taskInfo);
    await room.resumeSpecialist();
    await room.resumeSpecialist();

    const rejected = room.resolveHumanApproval({ criterionId: "V2", approved: false, note: "보류" });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.final.finalPass, false);
    assert.equal(rejected.resumable, false);
    assert.equal(room.professionalRun.status, "BLOCKED");
    assert.equal(room.specialistState().blocked, true, "거부 후 변경 유지·복원·재기획을 고를 수 있어야 한다");
    assert.equal(room.specialistState().available, false, "빈 승인 대기에 남으면 안 된다");
    assert.equal(room.specialistBlockDetails().canRestore, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- B3 — canonical state persist 실패는 fail-closed ----

async function withFailingPersist(fn) {
  const { AssuranceRun } = require("../src/agora/assurance/assurance-run");
  const original = AssuranceRun.prototype.persist;
  AssuranceRun.prototype.persist = () => ({ ok: false, error: "디스크에 쓸 수 없습니다." });
  try {
    return await fn();
  } finally {
    AssuranceRun.prototype.persist = original;
  }
}

test("B3: 계약 기록을 저장하지 못하면 실행을 시작하지 않는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task());
  try {
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [] });
    primeStep(room, taskInfo);
    const result = await withFailingPersist(async () => room.resumeSpecialist());
    assert.equal(result.ok, false);
    assert.equal(result.stopReason, "ASSURANCE_STATE_WRITE_FAILED");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B3: 검증 결과를 저장하지 못하면 검수로 넘어가지 않는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task());
  try {
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [{ ok: true, text: "VERDICT: PASS" }] });
    primeStep(room, taskInfo);

    // freeze는 성공시키고, Builder 종료 후의 저장만 실패시킨다.
    const { AssuranceRun } = require("../src/agora/assurance/assurance-run");
    const original = AssuranceRun.prototype.persist;
    let calls = 0;
    AssuranceRun.prototype.persist = function persistOnceThenFail() {
      calls += 1;
      if (calls === 1) return original.call(this);
      return { ok: false, error: "디스크에 쓸 수 없습니다." };
    };
    let result;
    try {
      result = await room.resumeSpecialist();
    } finally {
      AssuranceRun.prototype.persist = original;
    }
    assert.equal(result.ok, false, "기록하지 못한 검증 결과로 진행하면 안 된다");
    assert.notEqual(result.stopReason, "BUILDER_DONE");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B3: 저장 실패는 사용자에게 설명되는 사유로 남는다", () => {
  const { describeBlockers } = require("../src/agora/assurance/final-disposition");
  const described = describeBlockers({
    blockers: [{ reason: "ASSURANCE_STATE_WRITE_FAILED" }],
  });
  assert.equal(described.length, 1);
  assert.ok(described[0].label.includes("저장"));
});

// ---- B7 — live input의 실제 사용이 기록된다 ----

test("B7: live 입력의 실제 사용이 provenance에 남는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(
    v2Task({ inputs: "- `feed.csv` (live)\n- https://example.com/rates (live)" })
  );
  try {
    fs.writeFileSync(path.join(workspace, "feed.csv"), "a,b\n1,2\n");
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [] });

    primeStep(room, taskInfo);
    await room.resumeSpecialist();

    const usage = room.assuranceInputUsage();
    assert.ok(usage, "입력 사용 기록을 조회할 수 있어야 한다");

    // 작업 폴더 안의 live 파일은 Agora가 실제로 관측한다.
    assert.equal(usage.retrievals.length, 1, "관측한 입력만 사용 기록이 남는다");
    const observed = usage.retrievals[0];
    assert.equal(observed.inputId, "IN-01");
    assert.equal(observed.observed, true);
    assert.ok(observed.contentHash, "실제로 무엇을 썼는지가 남아야 한다");
    assert.equal(observed.basis, "workspace-observation", "어떻게 알게 된 사실인지 구분된다");

    // **URL은 Builder가 실제로 썼는지조차 모른다.**
    // "관측 못 했다"를 사용 기록으로 남기면 그보다 상위 사실인 "사용했다"를
    // 만들어내는 셈이 된다. 기록을 만들지 않는 것이 정직하다.
    assert.equal(
      usage.retrievals.some((r) => r.inputId === "IN-02"),
      false,
      "관측하지 못한 입력에 사용 기록을 만들면 안 된다"
    );
    assert.deepEqual(
      usage.withoutRetrieval.map((i) => i.inputId),
      ["IN-02"],
      "선언은 됐지만 사용 기록이 없다는 사실이 감사에 그대로 보여야 한다"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B7: 외부에서 보고한 retrieval metadata를 기록하고 조회할 수 있다", async () => {
  const { workspace, taskInfo } = setupWorkspace(
    v2Task({ inputs: "- https://example.com/rates (live)" })
  );
  try {
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [] });

    primeStep(room, taskInfo);
    await room.resumeSpecialist();

    // 보고가 오기 전에는 사용 기록이 없다 — 그것이 정직한 상태다.
    const before = room.assuranceInputUsage();
    assert.equal(before.retrievals.length, 0);
    assert.deepEqual(before.withoutRetrieval.map((i) => i.inputId), ["IN-01"]);

    const etag = 'W/"abc123"';
    const recorded = room.recordLiveInputRetrieval({
      inputId: "IN-01",
      version: "2026-08-24",
      etag,
      contentHash: "deadbeef",
    });
    assert.equal(recorded.ok, true);

    const usage = room.assuranceInputUsage();
    const reported = usage.retrievals.find((r) => r.etag === etag);
    assert.ok(reported, "보고받은 metadata가 남아야 한다");
    assert.equal(reported.version, "2026-08-24");
    assert.equal(reported.observed, true);
    assert.equal(reported.basis, "reported", "외부 보고를 Agora 자신의 관측과 섞지 않는다");
    assert.equal(usage.withoutRetrieval.length, 0, "보고가 오면 '기록 없음'에서 빠진다");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B7: frozen 입력에는 live retrieval을 기록할 수 없다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ inputs: "- `src.txt` (frozen)" }));
  try {
    fs.writeFileSync(path.join(workspace, "src.txt"), "원문");
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [] });

    primeStep(room, taskInfo);
    await room.resumeSpecialist();

    const denied = room.recordLiveInputRetrieval({ inputId: "IN-01", etag: "x" });
    assert.equal(denied.ok, false, "frozen 입력은 retrieval 기록 대상이 아니다");
    // frozen 입력에는 사용 기록이 붙지 않는다.
    assert.equal(room.assuranceInputUsage().retrievals.length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B7: live 입력 기록 경로가 IPC와 preload에 실제로 노출된다", () => {
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  assert.match(ipc, /chat:specialist:record-input-retrieval/);
  assert.match(ipc, /chat:specialist:input-usage/);
  assert.match(ipc, /room\.recordLiveInputRetrieval/);

  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "chat-preload.js"), "utf8");
  assert.match(preload, /specialistRecordInputRetrieval/);
  assert.match(preload, /specialistInputUsage/);
});

test("B5: block 모드에서 승인 후 professional Run이 실제로 COMPLETED가 된다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const room = makeRoom(
      workspace,
      {
        claude: [BUILDER_DONE],
        codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
      },
      [],
      { withProfessionalRun: true }
    );
    const readTask = trackWorkflowTask(room, workspace, taskInfo);
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    room.professionalPlan = { taskInfo };

    // block 모드는 Builder→Reviewer를 한 번에 돈다. 승인만 남으면 멈춘다.
    const started = await room.startSpecialist({
      action: "implementation",
      mode: "auto",
      stages: stepStages(room),
      maxAutoRevisions: 0,
    });
    assert.equal(started.stopReason, "HUMAN_APPROVAL_REQUIRED", JSON.stringify(started));
    assert.equal(room.professionalRun.node, "REVIEWING");
    assert.equal(room.specialistState().phase, "ACT");
    assert.equal(room.specialistState().resumePhase, "awaiting_human_approval");
    const runId = room.specialistState().frozenRunId;
    assert.equal(runId, room.currentRunInfo().runId);
    const stale = room.resolveHumanApproval({ criterionId: "V2", approved: true, expectedRunId: "previous-run" });
    assert.equal(stale.ok, false, "다른 실행에서 본 항목의 승인은 현재 실행에 적용하면 안 된다");
    assert.deepEqual(room.pendingHumanApprovals().map((item) => item.criterionId), ["V2"]);

    const resolved = room.resolveHumanApproval({ criterionId: "V2", approved: true, expectedRunId: runId });
    assert.equal(resolved.final.finalPass, true, JSON.stringify(resolved.final?.blockers));
    assert.equal(resolved.resumable, true);
    assert.equal(room.specialistState().resumePhase, "review_pass", "자동 재개 실패 시 화면에서 기록을 다시 이어야 한다");

    const completed = await room.resumeSpecialist();
    assert.equal(completed.ok, true, JSON.stringify(completed));
    assert.equal(completed.recorded, true);
    // 승인이 workflow를 실제로 이어야 B5가 닫힌다.
    assert.equal(room.professionalRun.node, "COMPLETED");
    assert.equal(room.professionalRun.status, "COMPLETED");
    const savedTask = readTask();
    assert.equal(savedTask.status, "done", "승인 후 Task도 완료로 저장되어야 한다");
    assert.equal(savedTask.activeRunId, null);
    assert.equal(savedTask.lastRunId, runId);
    const savedResult = room.taskManager.readRunResult(room.currentRunInfo());
    assert.equal(savedResult.status, "COMPLETED");
    assert.equal(savedResult.recorded, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 승인 후 완료 상태 저장 실패는 완료 표시 없이 백업과 복구 상태를 유지한다", async (t) => {
  for (const failure of ["workflow", "run-result"]) {
    await t.test(failure, async () => {
      const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
      try {
        const cleaned = [];
        const room = makeRoom(workspace, {
          claude: [BUILDER_DONE],
          codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
        }, [], { withProfessionalRun: true });
        const readTask = trackWorkflowTask(room, workspace, taskInfo);
        room.checkpointEngine = {
          createCheckpoint: async () => ({ supported: true, checkpointId: "cp-completion-write" }),
          cleanupCheckpoint: (checkpoint) => {
            cleaned.push(checkpoint.checkpointId);
            return { ok: true };
          },
        };
        fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서", "utf8");
        room.professionalPlan = { taskInfo };
        await room.startSpecialist({ action: "implementation", mode: "auto", stages: stepStages(room), maxAutoRevisions: 0 });
        assert.equal(room.resolveHumanApproval({ criterionId: "V2", approved: true }).resumable, true);
        const states = [];
        room.on("specialist-resume-state", (state) => states.push(state.status));
        if (failure === "workflow") {
          const saveTask = room.onProfessionalTaskState;
          room.onProfessionalTaskState = (patch) => patch.status === "done" ? false : saveTask(patch);
        } else {
          const writeResult = room.taskManager.writeRunResult.bind(room.taskManager);
          room.taskManager.writeRunResult = (runInfo, result) => result.status === "COMPLETED" ? false : writeResult(runInfo, result);
        }

        const completed = await room.resumeSpecialist();
        assert.equal(completed.ok, false);
        assert.equal(completed.stopReason, failure === "workflow" ? "WORKFLOW_WRITE_FAILED" : "RUN_STATE_WRITE_FAILED");
        assert.equal(states.includes("COMPLETED"), false, "저장되지 않은 완료를 화면에 먼저 알리지 않는다");
        assert.equal(room.specialistState().status, "BLOCKED");
        assert.equal(room.professionalRun.checkpointId, "cp-completion-write");
        assert.deepEqual(cleaned, []);
        const runInfo = room.currentRunInfo();
        assert.equal(readTask().status, "blocked");
        assert.equal(readTask().activeRunId, runInfo.runId);
        assert.equal(room.taskManager.readRunResult(runInfo).status, "BLOCKED");
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});

test("B5: 승인 후 기록 실패는 재시도 가능한 RECORDING/WAITING으로 남는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const cleaned = [];
    const room = makeRoom(workspace, {
      claude: [BUILDER_DONE],
      codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: false, error: "기록 실패" }, { ok: true, text: "기록 완료" }],
    }, [], { withProfessionalRun: true });
    room.checkpointEngine = {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-recorder-retry" }),
      cleanupCheckpoint: (checkpoint) => {
        cleaned.push(checkpoint.checkpointId);
        return { ok: true };
      },
    };
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    room.professionalPlan = { taskInfo };
    const started = await room.startSpecialist({
      action: "implementation", mode: "auto", stages: stepStages(room), maxAutoRevisions: 0,
    });
    assert.equal(started.stopReason, "HUMAN_APPROVAL_REQUIRED");
    assert.equal(room.resolveHumanApproval({ criterionId: "V2", approved: true }).resumable, true);
    const failed = await room.resumeSpecialist();
    assert.equal(failed.recorded, false);
    assert.equal(room.specialistState().node, "RECORDING");
    assert.equal(room.specialistState().status, "WAITING");
    assert.equal(room.specialistState().stopReason, "RECORDER_FAILED");
    assert.equal(room.pendingHumanApprovals().length, 0, "이미 끝낸 승인을 다시 요구하지 않는다");
    assert.equal(room.professionalRun.checkpointId, "cp-recorder-retry");
    assert.deepEqual(cleaned, [], "기록에 실패하면 백업을 유지한다");
    const retried = await room.startSpecialist({ action: "record", stages: stepStages(room) });
    assert.equal(retried.ok, true);
    assert.equal(room.specialistState().node, "COMPLETED");
    assert.equal(room.professionalRun.checkpointId, null);
    assert.deepEqual(cleaned, ["cp-recorder-retry"]);
    const { AssuranceRun } = require("../src/agora/assurance/assurance-run");
    const saved = AssuranceRun.load(room.currentRunInfo().runDir, { root: workspace });
    assert.deepEqual(saved.provenance.toJSON().events.filter((event) => event.type === "recorder").map((event) => event.ok), [false, true],
      "디스크에도 기록 실패 뒤 재시도 성공이 남아야 한다");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 기록 재시도는 승인 뒤 바뀐 결과물을 완료하지 않고 백업을 유지한다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ plan: PLAN_WITH_HUMAN }));
  try {
    const calls = [];
    const cleaned = [];
    const room = makeRoom(workspace, {
      claude: [BUILDER_DONE],
      codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: false, error: "기록 실패" }, { ok: true, text: "기록 완료" }],
    }, calls, { withProfessionalRun: true });
    room.checkpointEngine = {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-recorder-changed" }),
      cleanupCheckpoint: (checkpoint) => {
        cleaned.push(checkpoint.checkpointId);
        return { ok: true };
      },
    };
    fs.writeFileSync(path.join(workspace, "report.md"), "# 승인한 보고서", "utf8");
    room.professionalPlan = { taskInfo };
    await room.startSpecialist({ action: "implementation", mode: "auto", stages: stepStages(room), maxAutoRevisions: 0 });
    assert.equal(room.resolveHumanApproval({ criterionId: "V2", approved: true }).resumable, true);
    assert.equal((await room.resumeSpecialist()).recorded, false);
    const callsBeforeRetry = calls.length;

    fs.writeFileSync(path.join(workspace, "report.md"), "# 승인 후 바뀐 보고서", "utf8");
    const retried = await room.startSpecialist({ action: "record", stages: stepStages(room) });
    assert.equal(retried.ok, false);
    assert.equal(retried.stopReason, "ASSURANCE_INVALIDATED");
    assert.equal(calls.length, callsBeforeRetry, "승인이 무효인 결과물에는 기록관을 실행하지 않는다");
    assert.equal(room.specialistState().status, "BLOCKED");
    assert.equal(room.specialistState().canRestore, true);
    assert.equal(room.professionalRun.checkpointId, "cp-recorder-changed");
    assert.deepEqual(cleaned, [], "다시 확인이 필요하므로 백업을 삭제하지 않는다");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B7: 읽지 못한 live 파일에도 사용 기록을 만들지 않는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2Task({ inputs: "- `feed.csv` (live)" }));
  try {
    // live로 선언됐지만 실행 시점에 존재하지 않는다 — 무엇을 썼는지 알 수 없다.
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");
    const room = makeRoom(workspace, { claude: [BUILDER_DONE], codex: [] });

    primeStep(room, taskInfo);
    await room.resumeSpecialist();

    const usage = room.assuranceInputUsage();
    assert.equal(usage.retrievals.length, 0, "관측하지 못한 파일에 기록을 만들면 안 된다");
    assert.deepEqual(usage.withoutRetrieval.map((i) => i.inputId), ["IN-01"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
