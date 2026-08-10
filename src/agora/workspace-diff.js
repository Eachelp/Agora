"use strict";

// TASK-008 — Builder가 만든 실제 변경(Diff)을 수집해 Reviewer에게 전달합니다.
//
// 설계 원칙 (AGORA_V1_DESIGN.md §3.3 / §8):
// - Reviewer는 "실제 변경(Diff)·테스트 결과"를 기준으로 검수해야 하므로,
//   Frozen Task만 전달하는 것으로는 부족하고, Builder가 실제로 만든 diff를
//   함께 주입해야 합니다.
// - git 저장소일 때는 `git diff HEAD`(tracked)와 untracked 파일 목록을
//   수집합니다. diff가 없으면 빈 결과를 반환합니다.
// - git이 아니거나 workspace가 없으면 안전하게 빈 결과를 반환합니다.
//   (checkpoint 지원 여부와 무관하게 동작)
// - checkpoint(workspace 복원용)와는 별개로, diff는 "읽기 전용 스냅샷"이며
//   workspace를 변경하지 않습니다.

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
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

function isGitRepo(root) {
  return fs.existsSync(path.join(root, ".git"));
}

// Builder 실행 직후의 실제 변경분을 수집합니다.
// 반환: { supported, trackedDiff, untracked: string[], hasChanges, summary }
async function collectBuilderDiff(workspaceRoot) {
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || !isGitRepo(repo)) {
    return { supported: false, trackedDiff: "", untracked: [], hasChanges: false, summary: "" };
  }

  try {
    const trackedDiff = await git(repo, ["diff", "HEAD"]);
    const untrackedOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untracked = String(untrackedOut || "").split("\0").filter(Boolean);
    const hasChanges = trackedDiff.trim().length > 0 || untracked.length > 0;

    const summary = [];
    if (trackedDiff.trim().length > 0) {
      const files = trackedDiff
        .split("\ndiff --git ")
        .map((chunk) => chunk.split("\n")[0].trim())
        .filter(Boolean);
      summary.push(`수정/추가된 tracked 파일 ${files.length}개`);
    }
    if (untracked.length > 0) {
      summary.push(`새로 만들어진 untracked 파일 ${untracked.length}개`);
    }
    if (summary.length === 0) summary.push("작업공간 변경 없음");

    return {
      supported: true,
      trackedDiff,
      untracked,
      hasChanges,
      summary: summary.join(" · "),
    };
  } catch {
    return { supported: false, trackedDiff: "", untracked: [], hasChanges: false, summary: "" };
  }
}

// 수집한 diff를 Reviewer용 프롬프트 텍스트로 포매팅합니다.
function formatBuilderDiff(diff) {
  if (!diff || !diff.hasChanges) {
    return "작업공간에 실제 변경(Diff)이 없습니다.";
  }
  const lines = [];
  lines.push(`변경 요약: ${diff.summary || "변경 있음"}`);
  if (diff.trackedDiff && diff.trackedDiff.trim().length > 0) {
    lines.push("--- 실제 변경 (Diff) 시작 ---");
    lines.push(diff.trackedDiff.trim());
    lines.push("--- 실제 변경 (Diff) 끝 ---");
  }
  if (diff.untracked && diff.untracked.length > 0) {
    lines.push("새로 만들어진 파일(untracked):");
    for (const rel of diff.untracked) {
      lines.push(`- ${rel}`);
    }
  }
  return lines.join("\n");
}

// Builder 실행 직후의 diff를 수집하고 프롬프트 텍스트로 변환합니다.
async function describeWorkspaceChanges(workspaceRoot) {
  const diff = await collectBuilderDiff(workspaceRoot);
  return {
    diff,
    text: formatBuilderDiff(diff),
  };
}

module.exports = {
  collectBuilderDiff,
  formatBuilderDiff,
  describeWorkspaceChanges,
};
