"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TaskManager,
  stripControlMarkers,
  hashText,
  MAX_TASK_READ_BYTES,
  MAX_TASK_CONTRACT_CHARS,
} = require("../src/agora/task-manager");

function makeTempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VALID_TASK_CONTRACT = [
  "## Goal",
  "작업 목표 내용",
  "## Requirements",
  "요구사항 설명",
  "## Implementation Approach",
  "구현 접근 방식",
  "## Acceptance Criteria",
  "완료 수용 기준",
  "## Verification",
  "테스트 및 검증 방법",
  "## Out of Scope",
  "제외 범위 설명",
].join("\n");

test("Planner 결과에서 TASK.md를 생성하고 제어 마커를 제거한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const plannerText = [
    "## 목표",
    "로그인 화면을 만든다.",
    "STATUS: PLAN_READY",
  ].join("\n");
  const task = mgr.createTaskFromPlanner(plannerText, ws);
  assert.ok(task.filename.match(/^TASK-\d{3}\.md$/));
  assert.ok(task.relativePath.includes(".project-memory"));
  assert.ok(fs.existsSync(task.absPath));
  const content = fs.readFileSync(task.absPath, "utf8");
  assert.ok(!/STATUS:\s*PLAN_READY/.test(content), "제어 마커가 제거되어야 한다");
  assert.ok(content.includes("로그인 화면"));
  assert.equal(task.hash, hashText(content));
});

test("TASK 번호는 기존 파일 기준으로 증가한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const first = mgr.createTaskFromPlanner("# one", ws);
  const second = mgr.createTaskFromPlanner("# two", ws);
  assert.match(second.filename, /TASK-002\.md$/);
  assert.notEqual(first.absPath, second.absPath);
});

test("기획 보완은 live TASK.md만 갱신하고 기존 Frozen Run은 바꾸지 않는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const task = mgr.createTaskFromPlanner(VALID_TASK_CONTRACT + "\nSTATUS: PLAN_READY", ws);
  const run = mgr.freezeTask({ contentSource: "file", taskPath: task.relativePath, description: "" }, ws);

  const updated = mgr.updateTaskFromPlanner(task, VALID_TASK_CONTRACT + "\n보완 내용\nSTATUS: PLAN_READY", ws);

  assert.equal(fs.readFileSync(updated.absPath, "utf8"), VALID_TASK_CONTRACT + "\n보완 내용");
  assert.equal(fs.readFileSync(run.taskPath, "utf8"), VALID_TASK_CONTRACT);
  assert.equal(updated.hash, hashText(VALID_TASK_CONTRACT + "\n보완 내용"));
});

test("빈 Planner 결과로는 TASK.md를 만들지 않는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  assert.throws(() => mgr.createTaskFromPlanner("   \n", ws));
});

test("workspace가 없으면 Planner Task를 만들지 않는다", () => {
  const mgr = new TaskManager();
  assert.throws(() => mgr.createTaskFromPlanner("# 목표", null));
});

test("resolveTaskContract는 inline(수동) Task의 description을 쓴다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: "작업 내용", taskPath: null };
  const resolved = mgr.resolveTaskContract(inline, ws);
  assert.equal(resolved.source, "inline");
  assert.equal(resolved.content, "작업 내용");
});

test("resolveTaskContract는 file Task의 TASK.md 본문을 읽는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const made = mgr.createTaskFromPlanner("실행 계약 본문", ws);
  const fileTask = { contentSource: "file", taskPath: made.relativePath, description: "" };
  const resolved = mgr.resolveTaskContract(fileTask, ws);
  assert.equal(resolved.source, "file");
  assert.equal(resolved.content, "실행 계약 본문");
});

test("file Task는 workspace 밖 상대 경로를 거부한다", (t) => {
  const ws = makeTempWorkspace(t);
  const outside = path.join(path.dirname(ws), `outside-${Date.now()}.md`);
  fs.writeFileSync(outside, "outside", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  const mgr = new TaskManager();
  assert.throws(
    () => mgr.resolveTaskContract({ contentSource: "file", taskPath: `../${path.basename(outside)}` }, ws),
    (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
  );
});

test("file Task는 절대 경로를 거부한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  assert.throws(
    () => mgr.resolveTaskContract({ contentSource: "file", taskPath: path.join(ws, "TASK.md") }, ws),
    (error) => error?.code === "TASK_PATH_INVALID"
  );
});

test("file Task는 5MiB 초과 파일을 실행 계약으로 읽지 않는다", (t) => {
  const ws = makeTempWorkspace(t);
  const file = path.join(ws, "TASK-big.md");
  fs.writeFileSync(file, Buffer.alloc(MAX_TASK_READ_BYTES + 1));
  const mgr = new TaskManager();
  assert.throws(
    () => mgr.resolveTaskContract({ contentSource: "file", taskPath: "TASK-big.md" }, ws),
    (error) => error?.code === "TASK_FILE_TOO_LARGE"
  );
});

test("실행 계약은 전문 프롬프트보다 큰 본문을 저장하지 않는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  assert.throws(
    () => mgr.createTaskFromPlanner("x".repeat(MAX_TASK_CONTRACT_CHARS + 1), ws),
    (error) => error?.code === "TASK_CONTRACT_TOO_LARGE"
  );
  assert.throws(
    () => mgr.freezeTask({ contentSource: "inline", description: "x".repeat(MAX_TASK_CONTRACT_CHARS + 1) }, ws),
    (error) => error?.code === "TASK_CONTRACT_TOO_LARGE"
  );
});

test("file Task symlink가 workspace 밖을 가리키면 거부한다", (t) => {
  const ws = makeTempWorkspace(t);
  const outside = path.join(path.dirname(ws), `outside-link-${Date.now()}.md`);
  const link = path.join(ws, "TASK-link.md");
  fs.writeFileSync(outside, "outside", "utf8");
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.symlinkSync(outside, link, "file");
  } catch {
    return;
  }
  const mgr = new TaskManager();
  assert.throws(
    () => mgr.resolveTaskContract({ contentSource: "file", taskPath: "TASK-link.md" }, ws),
    (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
  );
});

test("freezeTask는 RUN-xxx/task.md와 task-hash를 만든다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const made = mgr.createTaskFromPlanner(VALID_TASK_CONTRACT, ws);
  const fileTask = { contentSource: "file", taskPath: made.relativePath, description: "" };
  const run = mgr.freezeTask(fileTask, ws);
  assert.ok(run.runId.match(/^RUN-\d{3}$/));
  assert.ok(fs.existsSync(run.taskPath));
  assert.ok(fs.existsSync(path.join(run.runDir, "task-hash")));
  assert.equal(fs.readFileSync(path.join(run.runDir, "task-hash"), "utf8"), hashText(VALID_TASK_CONTRACT));
});

test("freezeTask는 inline Task도 RUN/task.md로 정규화한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  assert.equal(fs.readFileSync(run.taskPath, "utf8"), VALID_TASK_CONTRACT);
});

test("freezeTask는 필수 6개 섹션이 누락되면 TASK_CONTRACT_INCOMPLETE를 던진다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const incomplete = { contentSource: "inline", description: "## Goal\n목표만 있고 나머지 없음", taskPath: null };
  assert.throws(
    () => mgr.freezeTask(incomplete, ws),
    (error) => error?.code === "TASK_CONTRACT_INCOMPLETE"
  );
});

test("빈 Task는 freeze하지 못한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  assert.throws(() => mgr.freezeTask({ contentSource: "inline", description: "  ", taskPath: null }, ws));
});

test("누락된 file Task는 freeze하지 못한다 (fallback 금지)", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const fileTask = { contentSource: "file", taskPath: ".project-memory/tasks/TASK-999.md", description: "" };
  assert.throws(() => mgr.freezeTask(fileTask, ws));
});

test("readFrozenTask는 손상(해시 불일치)을 감지한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  fs.writeFileSync(run.taskPath, "변경됨", "utf8");
  assert.throws(() => mgr.readFrozenTask(run.runDir));
});

test("readFrozenTask는 정상 Frozen Task를 그대로 반환한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  const frozen = mgr.readFrozenTask(run.runDir);
  assert.equal(frozen.content, VALID_TASK_CONTRACT);
  assert.equal(frozen.taskHash, run.taskHash);
});

test("stripControlMarkers는 STATUS 마커를 제거한다", () => {
  const out = stripControlMarkers("본문\nSTATUS: PLAN_READY\n뒷 내용");
  assert.ok(!/STATUS/.test(out));
  assert.ok(out.includes("본문"));
  assert.ok(out.includes("뒷 내용"));
});

test("writeRunResult와 readRunResult는 실행 결과를 원자 저장하고 다시 읽는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const run = mgr.freezeTask({ contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null }, ws);

  const ok = mgr.writeRunResult(run, {
    status: "COMPLETED",
    finalVerdict: "PASS",
    recorded: true,
    round: 1,
  });
  assert.equal(ok, true);

  const read = mgr.readRunResult(run);
  assert.equal(read.status, "COMPLETED");
  assert.equal(read.finalVerdict, "PASS");
  assert.equal(read.recorded, true);
});

test("Run evidence는 원문 없이 commandSummary와 hash만 저장한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const run = mgr.freezeTask({ contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null }, ws);

  assert.equal(mgr.writeRunEvidence(run, {
    round: 2,
    provider: "codex",
    commands: [
      { command: "npm test", exitCode: 0, stdoutTail: "all tests passed", stderrTail: "" },
      { command: "npm run lint", exitCode: 1, stdoutTail: "", stderrTail: "lint error", truncated: true },
    ],
    commandSummary: { total: 4, included: 2, omitted: 2, failed: 1, truncated: 1 },
  }), true);

  const evidence = mgr.readRunEvidence(run);
  assert.equal(evidence.schemaVersion, 2);
  assert.deepEqual(evidence.commandSummary, { total: 4, included: 2, omitted: 2, failed: 1, truncated: 1 });
  assert.equal(evidence.commands[0].commandHash, hashText("npm test"));
  assert.equal(evidence.commands[0].stdoutHash, hashText("all tests passed"));
  assert.equal(Object.hasOwn(evidence.commands[0], "stdoutTail"), false);
});

test("writeRunBlock과 readRunBlock은 막힘 정보를 저장하고 다시 읽는다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const run = mgr.freezeTask({ contentSource: "inline", description: VALID_TASK_CONTRACT, taskPath: null }, ws);

  const ok = mgr.writeRunBlock(run, {
    stage: "implementation",
    reason: "BLOCKED",
    builderStatus: "BLOCKED",
    changes: { status: "CHANGED", text: "diff content" },
    axes: { transport: "COMPLETED", declaration: "BLOCKED" },
  });
  assert.equal(ok, true);

  const block = mgr.readRunBlock(run);
  assert.equal(block.reason, "BLOCKED");
  assert.equal(block.builderStatus, "BLOCKED");
  assert.equal(block.changes.text, "diff content");
});
