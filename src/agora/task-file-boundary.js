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

function resolveWorkspaceRoot(workspace) {
  if (!workspace) {
    throw taskBoundaryError("TASK_WORKSPACE_MISSING", "워크스페이스가 연결되어 있지 않습니다.");
  }
  try {
    const root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new Error("not-directory");
    return root;
  } catch {
    throw taskBoundaryError("TASK_WORKSPACE_INVALID", "워크스페이스를 확인할 수 없습니다.");
  }
}

function resolveRelativeTarget(root, taskPath) {
  const relative = String(taskPath || "");
  if (!relative || relative.includes("\0") || isAbsoluteOnAnyPlatform(relative)) {
    throw taskBoundaryError("TASK_PATH_INVALID", "올바르지 않은 작업 지시서 경로입니다.");
  }
  const target = path.resolve(root, relative.replace(/^\.\/+/, ""));
  if (!isInside(root, target)) {
    throw taskBoundaryError("TASK_PATH_OUTSIDE_WORKSPACE", "워크스페이스 밖의 파일은 접근할 수 없습니다.");
  }
  return target;
}

function resolveTaskFileBoundary(workspace, taskPath, { maxBytes = MAX_TASK_FILE_BYTES } = {}) {
  const root = resolveWorkspaceRoot(workspace);
  const lexicalTarget = resolveRelativeTarget(root, taskPath);
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

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw taskBoundaryError("TASK_PATH_INVALID", "작업 지시서 경로를 확인할 수 없습니다.");
  }
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (!lstatOrNull(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function realDirectoryInside(root, target, outsideMessage) {
  const stat = lstatOrNull(target);
  if (!stat) return null;
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    throw taskBoundaryError("TASK_PATH_INVALID", "작업 지시서 디렉터리를 확인할 수 없습니다.");
  }
  if (!isInside(root, realTarget)) {
    throw taskBoundaryError("TASK_PATH_OUTSIDE_WORKSPACE", outsideMessage);
  }
  if (!fs.statSync(realTarget).isDirectory()) {
    throw taskBoundaryError("TASK_PATH_INVALID", "작업 지시서 상위 경로가 디렉터리가 아닙니다.");
  }
  return realTarget;
}

// Planner의 live TASK.md 쓰기 경계.
// lexical containment에 더해 existing parent/target의 realpath를 검증하므로
// symlink/junction을 통해 workspace 밖으로 쓰는 경로를 허용하지 않습니다.
function resolveTaskWriteBoundary(workspace, taskPath, { allowedRoot = null } = {}) {
  const root = resolveWorkspaceRoot(workspace);
  const lexicalTarget = resolveRelativeTarget(root, taskPath);
  const lexicalAllowedRoot = allowedRoot ? path.resolve(String(allowedRoot)) : root;

  if (!isInside(root, lexicalAllowedRoot) || !isInside(lexicalAllowedRoot, lexicalTarget)) {
    throw taskBoundaryError(
      "TASK_PATH_OUTSIDE_WORKSPACE",
      "Planner 작업 지시서 경로가 허용된 Task 폴더를 벗어났습니다."
    );
  }

  const allowedAncestor = nearestExistingAncestor(lexicalAllowedRoot);
  if (!allowedAncestor) {
    throw taskBoundaryError("TASK_PATH_INVALID", "Planner 작업 지시서 폴더를 확인할 수 없습니다.");
  }
  realDirectoryInside(
    root,
    allowedAncestor,
    "Planner 작업 지시서 폴더가 workspace 밖을 가리킵니다."
  );

  const realAllowedRoot = lstatOrNull(lexicalAllowedRoot)
    ? realDirectoryInside(
        root,
        lexicalAllowedRoot,
        "Planner 작업 지시서 폴더가 workspace 밖을 가리킵니다."
      )
    : null;

  const parent = path.dirname(lexicalTarget);
  const parentAncestor = nearestExistingAncestor(parent);
  if (!parentAncestor) {
    throw taskBoundaryError("TASK_PATH_INVALID", "Planner 작업 지시서 상위 경로를 확인할 수 없습니다.");
  }
  realDirectoryInside(
    root,
    parentAncestor,
    "Planner 작업 지시서 상위 경로가 workspace 밖을 가리킵니다."
  );
  const realParent = lstatOrNull(parent)
    ? realDirectoryInside(
        root,
        parent,
        "Planner 작업 지시서 상위 경로가 workspace 밖을 가리킵니다."
      )
    : null;

  if (realAllowedRoot && realParent && !isInside(realAllowedRoot, realParent)) {
    throw taskBoundaryError(
      "TASK_PATH_OUTSIDE_WORKSPACE",
      "Planner 작업 지시서 상위 경로가 허용된 Task 폴더를 벗어났습니다."
    );
  }

  // allowedRoot/parent가 아직 없다면 기존 조상의 realpath 검증만으로 충분합니다.
  // caller가 mkdir한 뒤 이 함수를 다시 호출해 최종 parent realpath를 검증합니다.
  const targetStat = lstatOrNull(lexicalTarget);
  if (targetStat) {
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw taskBoundaryError("TASK_FILE_NOT_REGULAR", "Planner 작업 지시서는 실제 regular file이어야 합니다.");
    }
    const realTarget = fs.realpathSync(lexicalTarget);
    if (!isInside(root, realTarget) || (realAllowedRoot && !isInside(realAllowedRoot, realTarget))) {
      throw taskBoundaryError("TASK_PATH_OUTSIDE_WORKSPACE", "Planner 작업 지시서가 허용된 Task 폴더를 벗어났습니다.");
    }
    return { root, target: realTarget, parent: realParent || parent, exists: true };
  }

  return {
    root,
    target: realParent ? path.join(realParent, path.basename(lexicalTarget)) : lexicalTarget,
    parent: realParent || parent,
    exists: false,
  };
}

module.exports = {
  MAX_TASK_FILE_BYTES,
  isAbsoluteOnAnyPlatform,
  isInside,
  resolveTaskFileBoundary,
  resolveTaskWriteBoundary,
};
