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
} = require("../src/agora/task-manager");

function makeTempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

test("freezeTask는 RUN-xxx/task.md와 task-hash를 만든다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const made = mgr.createTaskFromPlanner("# 계약", ws);
  const fileTask = { contentSource: "file", taskPath: made.relativePath, description: "" };
  const run = mgr.freezeTask(fileTask, ws);
  assert.ok(run.runId.match(/^RUN-\d{3}$/));
  assert.ok(fs.existsSync(run.taskPath));
  assert.ok(fs.existsSync(path.join(run.runDir, "task-hash")));
  assert.equal(fs.readFileSync(path.join(run.runDir, "task-hash"), "utf8"), hashText("# 계약"));
});

test("freezeTask는 inline Task도 RUN/task.md로 정규화한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: "수동 작업 실행", taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  assert.equal(fs.readFileSync(run.taskPath, "utf8"), "수동 작업 실행");
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
  const inline = { contentSource: "inline", description: "원본 계약", taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  fs.writeFileSync(run.taskPath, "변경됨", "utf8");
  assert.throws(() => mgr.readFrozenTask(run.runDir));
});

test("readFrozenTask는 정상 Frozen Task를 그대로 반환한다", (t) => {
  const ws = makeTempWorkspace(t);
  const mgr = new TaskManager();
  const inline = { contentSource: "inline", description: "정상 계약", taskPath: null };
  const run = mgr.freezeTask(inline, ws);
  const frozen = mgr.readFrozenTask(run.runDir);
  assert.equal(frozen.content, "정상 계약");
  assert.equal(frozen.taskHash, run.taskHash);
});

test("stripControlMarkers는 STATUS 마커를 제거한다", () => {
  const out = stripControlMarkers("본문\nSTATUS: PLAN_READY\n뒷 내용");
  assert.ok(!/STATUS/.test(out));
  assert.ok(out.includes("본문"));
  assert.ok(out.includes("뒷 내용"));
});
