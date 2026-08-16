"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_TASK_FILE_BYTES,
  resolveTaskFileBoundary,
} = require("../src/agora/task-file-boundary");

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-boundary-"));
}

test("workspace 안 regular file만 실제 경로로 해석한다", () => {
  const workspace = tempWorkspace();
  try {
    const file = path.join(workspace, "TASK.md");
    fs.writeFileSync(file, "hello", "utf8");
    const result = resolveTaskFileBoundary(workspace, "TASK.md");
    assert.equal(result.target, fs.realpathSync(file));
    assert.equal(result.stat.isFile(), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("상위 경로 탈출과 Windows 절대 경로를 모두 거부한다", () => {
  const workspace = tempWorkspace();
  try {
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "../outside.md"),
      (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
    );
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "C:\\outside\\TASK.md"),
      (error) => error?.code === "TASK_PATH_INVALID"
    );
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "\\\\server\\share\\TASK.md"),
      (error) => error?.code === "TASK_PATH_INVALID"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("directory와 5MiB 초과 파일은 작업 지시서로 열지 않는다", () => {
  const workspace = tempWorkspace();
  try {
    fs.mkdirSync(path.join(workspace, "folder"));
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "folder"),
      (error) => error?.code === "TASK_FILE_NOT_REGULAR"
    );

    const large = path.join(workspace, "large.md");
    fs.writeFileSync(large, Buffer.alloc(MAX_TASK_FILE_BYTES + 1));
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "large.md"),
      (error) => error?.code === "TASK_FILE_TOO_LARGE"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspace 밖을 가리키는 symlink는 거부한다", (t) => {
  const workspace = tempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-task-outside-"));
  try {
    const outside = path.join(outsideDir, "secret.md");
    fs.writeFileSync(outside, "secret", "utf8");
    const link = path.join(workspace, "linked.md");
    try {
      fs.symlinkSync(outside, link, "file");
    } catch (error) {
      t.skip(`symlink 생성 불가: ${error?.code || error?.message || error}`);
      return;
    }
    assert.throws(
      () => resolveTaskFileBoundary(workspace, "linked.md"),
      (error) => error?.code === "TASK_PATH_OUTSIDE_WORKSPACE"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
