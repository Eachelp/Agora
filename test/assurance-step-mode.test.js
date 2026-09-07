"use strict";

// Stage D — step mode 통합 (B1) · 사용자 승인 경로 (B5).
//
// **production 진입점에서 시작한다.** wrapper를 직접 부르는 테스트는 진입 경로
// 우회를 잡지 못한다(D-0에서 배운 원칙). 여기서는 실제 사용자가 밟는 경로인
// `startSpecialist` → `resumeSpecialist`로만 실행한다.
//
// 검수 B1이 지적한 실패 모드: step 모드가 runExecutionBlock을 타지 않아
// Stage D 전체(계약 동결·subject·검증·final)를 통째로 우회했다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatRoom } = require("../src/chat/chat-room");
const { TaskManager } = require("../src/agora/task-manager");
const { AssuranceRun } = require("../src/agora/assurance/assurance-run");

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

// 비코딩 v2 계약: 보고서를 만들고 존재·구조를 확인한다.
function v2TaskContent(plan) {
  return [
    "## Goal\n보고서를 만든다.",
    "## Inputs / Source Data\n- 없음",
    "## Requirements\n요구사항 설명.",
    "## Work Approach\n작업 접근 방식.",
    "## Deliverables\n- `report.md`",
    "## Acceptance Criteria\n완료 수용 기준.",
    `## Verification Plan\n${plan}`,
    "## Out of Scope\n제외 범위.",
  ].join("\n\n");
}

const PLAN_PREDICATE = "```json\n" + JSON.stringify([
  { id: "V1", method: "predicate", statement: "보고서가 만들어졌다", check: { kind: "exists", path: "report.md" } },
]) + "\n```";

const PLAN_WITH_HUMAN = "```json\n" + JSON.stringify([
  { id: "V1", method: "predicate", statement: "보고서가 만들어졌다", check: { kind: "exists", path: "report.md" } },
  { id: "V2", method: "human", statement: "외부 발송 승인" },
]) + "\n```";

function setupWorkspace(taskContent) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-step-")));
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), taskContent, "utf8");
  return { workspace, taskInfo: { filename: "TASK-001.md", relativePath: path.join(".project-memory", "tasks", "TASK-001.md") } };
}

// Builder가 산출물을 실제로 만들도록 하는 runner.
function builderWritesReport(workspace) {
  return {
    ok: true,
    text: "구현했습니다.\nSTATUS: DONE",
    builderStatus: "DONE",
    transport: "COMPLETED",
    evidence: null,
    onBefore: () => fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서"),
  };
}

function makeRoom(workspace, replies, calls) {
  return new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    runAgent: fakeRunner(replies, calls),
    checkpointEngine: {
      createCheckpoint: async () => ({ supported: false }),
      cleanupCheckpoint: () => ({ ok: true }),
      restoreCheckpoint: async () => ({ ok: true }),
    },
  });
}

function stepStages(room) {
  return {
    implementation: { agent: room.findAgent("claude") },
    review: { agent: room.findAgent("codex") },
    recorder: { agent: room.findAgent("codex") },
  };
}

// step 실행을 phase 끝까지 몰고 간다.
async function driveStep(room, stages, { maxHops = 8 } = {}) {
  const results = [];
  let result = await room.startSpecialist({
    action: "implement",
    mode: "step",
    stages,
    maxAutoRevisions: 0,
  });
  results.push(result);
  let hops = 0;
  while (result?.needsUserDecision && hops < maxHops) {
    hops += 1;
    result = await room.resumeSpecialist();
    results.push(result);
  }
  return { result, results };
}

// ---- B1: step mode도 Stage D를 통과한다 ----

test("B1: step 모드에서도 검사 계약이 동결되고 실제 검증이 수행된다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_PREDICATE));
  try {
    const calls = [];
    const room = makeRoom(
      workspace,
      {
        claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
        codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
      },
      calls
    );
    room.specialistResume = null;
    // Builder가 산출물을 만든 상태를 재현한다.
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    const stages = stepStages(room);
    room.specialistResume = {
      stages, mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();

    // 계약이 실제로 동결됐는지 RUN 폴더에서 확인한다(메모리 상태가 아니라 디스크).
    const runsDir = path.join(workspace, ".project-memory", "runs");
    const runDirs = fs.readdirSync(runsDir);
    assert.equal(runDirs.length, 1, "Run이 하나 만들어져야 한다");
    const runDir = path.join(runsDir, runDirs[0]);
    assert.ok(
      fs.existsSync(path.join(runDir, "assurance-contract.json")),
      "step 모드가 Stage D 계약 동결을 우회하면 안 된다"
    );

    const loaded = AssuranceRun.load(runDir, { root: workspace });
    assert.ok(loaded, "assurance 상태가 남아야 한다");
    assert.equal(loaded.mode, "assured");
    assert.equal(loaded.plan.criteria.length, 1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B1: step 모드에서 Builder 종료 후 subject와 검증 기록이 남는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_PREDICATE));
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [],
    }, []);
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();

    const runDir = path.join(
      workspace, ".project-memory", "runs",
      fs.readdirSync(path.join(workspace, ".project-memory", "runs"))[0]
    );
    const loaded = AssuranceRun.load(runDir, { root: workspace });
    assert.ok(loaded.assuranceSubjectRef, "결과물 snapshot이 확정되어야 한다 (INV-5)");
    const history = loaded.ledger.historyFor("V1");
    assert.ok(history.length > 0, "step 모드에서도 검증 기록이 남아야 한다");
    assert.equal(history[0].criterionOutcome, "PASS");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B1: step 모드에서 자동검사 FAIL이면 Reviewer PASS로도 완료되지 않는다", async () => {
  // 산출물을 만들지 않아 predicate가 FAIL이 되는 상황.
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_PREDICATE));
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
    }, []);

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();           // plan_ready → builder
    const reviewed = await room.resumeSpecialist(); // builder_done → review

    // Reviewer가 PASS를 냈어도 자동검사 FAIL이 남아 완료로 가지 않는다.
    assert.equal(reviewed.ok, false);
    assert.notEqual(reviewed.stopReason, "REVIEW_PASS");
    assert.match(String(reviewed.stopReason), /ASSURANCE/);

    const messages = room.messages.filter((m) => m.authorType === "system").map((m) => m.text).join("\n");
    assert.match(messages, /남은 확인|완료로 처리/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B1: v1 계약의 step 모드는 그대로 완료된다 (회귀 없음)", async () => {
  const v1 = [
    "## Goal\n목표", "## Requirements\n요구사항 설명", "## Implementation Approach\n구현 접근",
    "## Acceptance Criteria\n완료 기준", "## Verification\n검증 계획", "## Out of Scope\n제외",
  ].join("\n\n");
  const { workspace, taskInfo } = setupWorkspace(v1);
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
    }, []);

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();
    const reviewed = await room.resumeSpecialist();
    assert.equal(reviewed.stopReason, "REVIEW_PASS", "v1은 Stage D에 막히지 않는다");

    const runDir = path.join(
      workspace, ".project-memory", "runs",
      fs.readdirSync(path.join(workspace, ".project-memory", "runs"))[0]
    );
    assert.equal(
      fs.existsSync(path.join(runDir, "assurance-contract.json")),
      false,
      "v1 계약에는 assurance 계약을 만들지 않는다"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- B5: 사용자 승인 진입점 ----

test("B5: 사용자 승인이 필요한 항목을 조회하고 실제로 해소할 수 있다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_WITH_HUMAN));
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [{ ok: true, text: "VERDICT: PASS" }, { ok: true, text: "기록 완료" }],
    }, []);
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();
    await room.resumeSpecialist();

    // 사용자가 승인해야 할 항목이 조회된다.
    const pending = room.pendingHumanApprovals();
    assert.equal(pending.length, 1, "사용자 승인 항목이 보여야 한다");
    assert.equal(pending[0].criterionId, "V2");

    // 그리고 실제로 해소할 수 있다 — 이 경로가 없으면 Run이 영원히 막힌다.
    const resolved = room.resolveHumanApproval({ criterionId: "V2", approved: true });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.final.finalPass, true, JSON.stringify(resolved.final?.blockers));
    assert.equal(room.pendingHumanApprovals().length, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 승인 대상이 아닌 항목은 승인 경로로 해소할 수 없다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_WITH_HUMAN));
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [{ ok: true, text: "VERDICT: PASS" }],
    }, []);
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();

    // V1은 자동 확정된 항목이다. 사용자 승인 경로로 건드릴 수 없다.
    const denied = room.resolveHumanApproval({ criterionId: "V1", approved: true });
    assert.equal(denied.ok, false);
    // 존재하지 않는 항목도 마찬가지.
    assert.equal(room.resolveHumanApproval({ criterionId: "V999", approved: true }).ok, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("B5: 사용자 거부는 Final PASS로 이어지지 않는다", async () => {
  const { workspace, taskInfo } = setupWorkspace(v2TaskContent(PLAN_WITH_HUMAN));
  try {
    const room = makeRoom(workspace, {
      claude: [{ ok: true, text: "구현 완료\nSTATUS: DONE", builderStatus: "DONE", transport: "COMPLETED" }],
      codex: [{ ok: true, text: "VERDICT: PASS" }],
    }, []);
    fs.writeFileSync(path.join(workspace, "report.md"), "# 보고서");

    room.specialistResume = {
      stages: stepStages(room), mode: "step", phase: "plan_ready", taskInfo, feedback: "", maxAutoRevisions: 0,
    };
    await room.resumeSpecialist();

    const rejected = room.resolveHumanApproval({ criterionId: "V2", approved: false, note: "발송 보류" });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.final.finalPass, false, "거부했는데 통과하면 안 된다");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- B5: production 노출 경로가 실제로 존재하는가 ----

test("B5: 승인 경로가 IPC와 preload에 실제로 노출된다", () => {
  // 테스트가 room 메서드만 부르면 "API는 있는데 사용자가 못 쓰는" 상태를
  // 통과시킨다. 실제 노출 지점을 소스에서 확인한다.
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  assert.match(ipc, /chat:specialist:pending-approvals/);
  assert.match(ipc, /chat:specialist:resolve-approval/);
  assert.match(ipc, /room\.resolveHumanApproval/);

  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "chat-preload.js"), "utf8");
  assert.match(preload, /specialistPendingApprovals/);
  assert.match(preload, /specialistResolveApproval/);

  // IPC와 preload까지만 확인하면 "배선은 있는데 화면에 버튼이 없는" 상태를 그대로
  // 통과시킨다. 실제로 그랬다 — 렌더러에 호출부가 하나도 없어서, 승인 대기에 들어간
  // 실행은 입력창이 잠긴 채 사용자가 풀 방법이 없었다.
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "chat.html"), "utf8");
  assert.match(renderer, /chatApi\.specialistPendingApprovals\(/, "렌더러가 승인 항목을 조회해야 합니다");
  assert.match(renderer, /chatApi\.specialistResolveApproval\(/, "렌더러가 승인·거부를 보낼 수 있어야 합니다");
  assert.match(html, /id="specialist-approvals"/, "승인 항목을 보여 줄 자리가 있어야 합니다");
});
