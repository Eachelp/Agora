"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskManager } = require("../src/agora/task-manager");

const VALID_TASK_CONTRACT = [
  "## Goal",
  "작업 목표",
  "## Requirements",
  "요구사항",
  "## Implementation Approach",
  "구현 방식",
  "## Acceptance Criteria",
  "수용 기준",
  "## Verification",
  "검증 방법",
  "## Out of Scope",
  "제외 범위",
].join("\n");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(pathname) {
  fs.rmSync(pathname, { recursive: true, force: true });
}

function linkDirectory(target, link) {
  // Windows에서는 junction이 관리자 권한/Developer Mode 없이도 생성 가능한
  // 대표적인 디렉터리 재해석 지점이므로 실제 위협 모델을 그대로 검증합니다.
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("Planner Task 정상 create/update/freeze 경로는 그대로 동작한다", (t) => {
  const workspace = tempDir("agora-task-write-");
  t.after(() => cleanup(workspace));
  const manager = new TaskManager();

  const task = manager.createTaskFromPlanner(VALID_TASK_CONTRACT, workspace);
  assert.equal(fs.readFileSync(task.absPath, "utf8"), VALID_TASK_CONTRACT);

  const updated = manager.updateTaskFromPlanner(
    task,
    `${VALID_TASK_CONTRACT}\n보완 내용`,
    workspace
  );
  assert.equal(fs.readFileSync(updated.absPath, "utf8"), `${VALID_TASK_CONTRACT}\n보완 내용`);

  const run = manager.freezeTask(
    { contentSource: "file", taskPath: updated.relativePath },
    workspace
  );
  assert.equal(fs.readFileSync(run.taskPath, "utf8"), `${VALID_TASK_CONTRACT}\n보완 내용`);
});

test("Planner Task 생성은 tasks 디렉터리가 workspace 밖 symlink/junction이면 쓰기 전에 거부한다", (t) => {
  const workspace = tempDir("agora-task-write-");
  const outside = tempDir("agora-task-outside-");
  t.after(() => cleanup(workspace));
  t.after(() => cleanup(outside));

  const memoryRoot = path.join(workspace, ".project-memory");
  fs.mkdirSync(memoryRoot, { recursive: true });
  try {
    linkDirectory(outside, path.join(memoryRoot, "tasks"));
  } catch (error) {
    t.skip(`directory link 생성 불가: ${error?.code || error?.message || error}`);
    return;
  }

  const manager = new TaskManager();
  assert.throws(
    () => manager.createTaskFromPlanner(VALID_TASK_CONTRACT, workspace),
    (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Planner Task 생성은 .project-memory 자체가 workspace 밖 symlink/junction이면 거부한다", (t) => {
  const workspace = tempDir("agora-task-write-");
  const outside = tempDir("agora-task-outside-");
  t.after(() => cleanup(workspace));
  t.after(() => cleanup(outside));

  try {
    linkDirectory(outside, path.join(workspace, ".project-memory"));
  } catch (error) {
    t.skip(`directory link 생성 불가: ${error?.code || error?.message || error}`);
    return;
  }

  const manager = new TaskManager();
  assert.throws(
    () => manager.createTaskFromPlanner(VALID_TASK_CONTRACT, workspace),
    (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("Planner Task 갱신은 기존 TASK 파일이 symlink이면 외부 대상을 수정하지 않는다", (t) => {
  const workspace = tempDir("agora-task-write-");
  const outside = tempDir("agora-task-outside-");
  t.after(() => cleanup(workspace));
  t.after(() => cleanup(outside));

  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const outsideFile = path.join(outside, "outside.md");
  fs.writeFileSync(outsideFile, "SAFE", "utf8");
  try {
    fs.symlinkSync(outsideFile, path.join(tasksDir, "TASK-001.md"), "file");
  } catch (error) {
    t.skip(`file symlink 생성 불가: ${error?.code || error?.message || error}`);
    return;
  }

  const manager = new TaskManager();
  assert.throws(
    () => manager.updateTaskFromPlanner(
      { relativePath: path.join(".project-memory", "tasks", "TASK-001.md") },
      VALID_TASK_CONTRACT,
      workspace
    ),
    (error) => ["TASK_FILE_NOT_REGULAR", "TASK_PATH_OUTSIDE_WORKSPACE"].includes(error?.code)
  );
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "SAFE");
});

test("Planner Task 갱신은 .project-memory/tasks 밖의 임의 경로를 거부한다", (t) => {
  const workspace = tempDir("agora-task-write-");
  t.after(() => cleanup(workspace));
  const manager = new TaskManager();

  assert.throws(
    () => manager.updateTaskFromPlanner(
      { relativePath: path.join("somewhere", "TASK-001.md") },
      VALID_TASK_CONTRACT,
      workspace
    ),
    (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
  );
});
