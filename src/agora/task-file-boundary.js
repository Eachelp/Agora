"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_TASK_FILE_BYTES = 5 * 1024 * 1024;

function isAbsoluteOnAnyPlatform(value) {
  const text = String(value || "");
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function taskBoundaryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveTaskFileBoundary(workspace, taskPath, { maxBytes = MAX_TASK_FILE_BYTES } = {}) {
  if (!workspace) throw taskBoundaryError("TASK_WORKSPACE_MISSING", "워크스페이스가 연결되어 있지 않습니다.");

  let root;
  try {
    root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new Error("not-directory");
  } catch {
    throw taskBoundaryError("TASK_WORKSPACE_INVALID", "워크스페이스를 확인할 수 없습니다.");
  }

  const relative = String(taskPath || "");
  if (!relative || relative.includes("\0") || isAbsoluteOnAnyPlatform(relative)) {
    throw taskBoundaryError("TASK_PATH_INVALID", "올바르지 않은 작업 지시서 경로입니다.");
  }

  const lexicalTarget = path.resolve(root, relative.replace(/^\.\/+/, ""));
  if (!isInside(root, lexicalTarget)) {
    throw taskBoundaryError("TASK_PATH_OUTSIDE_WORKSPACE", "워크스페이스 밖의 파일은 접근할 수 없습니다.");
  }
  if (!fs.existsSync(lexicalTarget)) {
    throw taskBoundaryError("TASK_FILE_MISSING", "작업 지시서 파일을 찾을 수 없습니다.");
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(lexicalTarget);
  } catch {
    throw taskBoundaryError("TASK_FILE_MISSING", "작업 지시서 파일을 찾을 수 없습니다.");
  }
  if (!isInside(root, realTarget)) {
    throw taskBoundaryError("TASK_PATH_OUTSIDE_WORKSPACE", "워크스페이스 밖을 가리키는 작업 지시서는 접근할 수 없습니다.");
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    throw taskBoundaryError("TASK_FILE_MISSING", "작업 지시서 파일을 찾을 수 없습니다.");
  }
  if (!stat.isFile()) {
    throw taskBoundaryError("TASK_FILE_NOT_REGULAR", "작업 지시서 파일을 찾을 수 없습니다.");
  }
  if (Number.isFinite(maxBytes) && maxBytes > 0 && stat.size > maxBytes) {
    throw taskBoundaryError("TASK_FILE_TOO_LARGE", "작업 지시서 파일이 너무 커서 열 수 없습니다.");
  }

  return { root, target: realTarget, stat };
}

module.exports = {
  MAX_TASK_FILE_BYTES,
  isAbsoluteOnAnyPlatform,
  isInside,
  resolveTaskFileBoundary,
};
