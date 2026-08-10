// TASK-006 Turn Checkpoint — 전문 모드 Builder 실행 직전 상태를 보존하고
// 실패/중단 시 그 상태로 안전하게 복원합니다.
//
// 설계 원칙 (AGORA_V1_DESIGN.md §8.3):
// - workspace가 git 저장소일 때만 동작합니다. git이 아니거나 경로가 없으면
//   안전하게 건너뛰고 { supported: false }를 반환합니다.
// - workspace 전체를 HEAD로 되돌리는 destructive reset은 사용하지 않습니다.
//   대신 checkpoint 시점의 diff와 untracked 파일을 보존해 두고,
//   복원 시 그 시점(사용자 사전 변경 포함)으로 정확히 되돌립니다.
// - Builder가 새로 만든 untracked 파일은 제거하고, 실행 전부터 있던
//   untracked 파일은 보존합니다.
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function resolveWorkspace(root) {
  if (!root) return null;
  try {
    const resolved = fs.realpathSync(root);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// workspace가 git 저장소인지 프로세스 spawn 없이 판별합니다.
// .git 항목(디렉터리 또는 worktree 파일)이 있으면 git 저장소로 봅니다.
// v1의 "가장 단순하고 안전한 방법"에 따라, .git이 없으면 git이 아니므로
// git 명령을 실행하지 않고 안전하게 건너뜁니다.
function isGitRepo(root) {
  return fs.existsSync(path.join(root, ".git"));
}

// Builder 실행 직전 workspace 상태를 임시 폴더에 보존합니다.
async function createCheckpoint(workspaceRoot) {
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || !isGitRepo(repo)) {
    return { supported: false };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-checkpoint-"));
  try {
    // tracked 파일의 변경분(사용자 사전 변경 포함)을 diff로 보존.
    const diffOut = await git(repo, ["diff", "--binary", "HEAD"]);
    fs.writeFileSync(path.join(dir, "tracked.patch"), diffOut, "utf8");

    // 실행 전부터 존재하던 untracked 파일을 원본 내용 그대로 보존.
    const untrackedOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untrackedPaths = String(untrackedOut || "").split("\0").filter(Boolean);
    for (const rel of untrackedPaths) {
      const src = path.join(repo, rel);
      const dest = path.join(dir, "untracked", rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    fs.writeFileSync(path.join(dir, "untracked-list.txt"), untrackedPaths.join("\n"), "utf8");

    return { supported: true, dir, workspace: repo };
  } catch (error) {
    cleanupCheckpoint(dir);
    return { supported: false };
  }
}

// checkpoint 시점 상태로 복원합니다. 지원되지 않는 경우는 아무것도 하지 않습니다.
async function restoreCheckpoint(workspaceRoot, checkpoint) {
  if (!checkpoint || checkpoint.supported !== true || !checkpoint.dir) {
    return { ok: false, reason: "unsupported" };
  }
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo) {
    return { ok: false, reason: "workspace-missing" };
  }

  try {
    // tracked 파일을 HEAD로 되돌린 뒤, checkpoint 시점의 diff(사용자 사전 변경)를
    // 다시 적용해 Builder 변경만 제거하고 사용자 변경은 보존합니다.
    await git(repo, ["checkout", "--", "."]);
    const patchPath = path.join(checkpoint.dir, "tracked.patch");
    const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
    if (patch.trim().length > 0) {
      await git(repo, ["apply", "--binary", patchPath]);
    }

    // untracked 파일: Builder가 새로 만든 파일은 제거하고,
    // 실행 전부터 있던 파일은 checkpoint 내용으로 되살립니다.
    const listPath = path.join(checkpoint.dir, "untracked-list.txt");
    const checkpointList = fs.existsSync(listPath)
      ? fs.readFileSync(listPath, "utf8").split("\n").filter(Boolean).map((p) => path.normalize(p))
      : [];
    const checkpointSet = new Set(checkpointList);

    const currentOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const currentPaths = String(currentOut || "").split("\0").filter(Boolean);
    for (const rel of currentPaths) {
      if (!checkpointSet.has(path.normalize(rel))) {
        const target = path.join(repo, rel);
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      }
    }
    for (const rel of checkpointList) {
      const src = path.join(checkpoint.dir, "untracked", rel);
      const dest = path.join(repo, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "restore-failed" };
  }
}

function cleanupCheckpoint(checkpoint) {
  if (!checkpoint || !checkpoint.dir) return;
  try {
    fs.rmSync(checkpoint.dir, { recursive: true, force: true });
  } catch {
    // 임시 폴더 정리 실패는 치명적이지 않습니다.
  }
}

module.exports = {
  createCheckpoint,
  restoreCheckpoint,
  cleanupCheckpoint,
};
