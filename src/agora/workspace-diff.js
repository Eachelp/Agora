// Checkpoint 이후 Git-visible 변경을 수집해 Reviewer payload로 변환합니다.
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const turnCheckpoint = require("./turn-checkpoint");

const execFileAsync = promisify(execFile);
const DIFF_STATUSES = Object.freeze(["CHANGED", "NO_CHANGES", "UNSUPPORTED", "FAILED"]);
const MAX_INLINE_FILE_BYTES = 64 * 1024;

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
  return Boolean(root && fs.existsSync(path.join(root, ".git")));
}

function safeRelative(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const normalized = path.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  return normalized;
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(file);
  hash.update(data);
  return hash.digest("hex");
}

function fileInfo(root, rel, { includeContent = true } = {}) {
  const safe = safeRelative(rel);
  if (!safe) throw new Error("untracked 경로가 올바르지 않습니다.");
  const file = path.resolve(root, safe);
  const rootPath = path.resolve(root);
  const normalizedRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const normalizedFile = process.platform === "win32" ? file.toLowerCase() : file;
  if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("untracked 경로가 workspace 밖입니다.");
  }
  if (!fs.existsSync(file)) return { path: safe, status: "DELETED" };
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { path: safe, status: "CHANGED", size: stat.size, hash: null, binary: true };
  const data = fs.readFileSync(file);
  const binary = data.includes(0);
  const info = {
    path: safe,
    status: "ADDED",
    size: stat.size,
    hash: hashFile(file),
    binary,
  };
  if (includeContent && !binary && stat.size <= MAX_INLINE_FILE_BYTES) {
    info.content = data.toString("utf8");
  }
  return info;
}

function checkpointBaseline(checkpoint) {
  if (!checkpoint?.supported || !checkpoint.checkpointId) return null;
  const resolved = typeof turnCheckpoint.resolveCheckpoint === "function"
    ? turnCheckpoint.resolveCheckpoint(checkpoint)
    : null;
  if (!resolved?.ok) return null;
  const listPath = path.join(resolved.dir, "untracked-list.txt");
  let list = [];
  try {
    list = fs.readFileSync(listPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(safeRelative);
  } catch {
    list = [];
  }
  if (list.some((entry) => !entry)) throw new Error("checkpoint untracked 목록이 손상되었습니다.");
  const files = new Map();
  for (const rel of list) {
    const source = path.resolve(resolved.dir, "untracked", rel);
    if (!fs.existsSync(source)) {
      files.set(rel, { path: rel, status: "DELETED" });
      continue;
    }
    const stat = fs.statSync(source);
    const data = fs.readFileSync(source);
    const binary = data.includes(0);
    files.set(rel, {
      path: rel,
      status: "BASELINE",
      size: stat.size,
      hash: hashFile(source),
      binary,
      ...(binary || stat.size > MAX_INLINE_FILE_BYTES ? {} : { content: data.toString("utf8") }),
    });
  }
  return { baselineSha: resolved.manifest.baselineSha || checkpoint.baselineSha || null, files };
}

function normalizeExcludes(excludePaths = []) {
  return new Set((Array.isArray(excludePaths) ? excludePaths : []).map(safeRelative).filter(Boolean));
}

function statusForFile(before, after) {
  if (!before && after) return "ADDED";
  if (before && !after) return "DELETED";
  if (!before || !after) return "CHANGED";
  return before.hash === after.hash && before.size === after.size ? null : "MODIFIED";
}

function summarize(diff) {
  const parts = [];
  const trackedCount = diff.trackedDiff ? diff.trackedDiff.split(/^diff --git /m).filter(Boolean).length : 0;
  if (trackedCount) parts.push(`tracked 파일 ${trackedCount}개`);
  if (diff.untrackedFiles.length) parts.push(`untracked 변경 ${diff.untrackedFiles.length}개`);
  return parts.length ? parts.join(" · ") : "작업공간 변경 없음";
}

// git diff --name-status -z 출력 파싱. 토큰 나열은 "상태, 경로" 쌍(또는
// rename/copy의 "상태, 이전경로, 새경로" 3쌍)이고 null로 구분된다. 마지막
// 토큰 뒤에는 null이 오므로 filter(Boolean)이 안전하다.
function parseNameStatusPaths(raw) {
  const tokens = String(raw || "").split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!/^(?:[ADMTUXB]|[MRC]\d{1,3})$/.test(status)) return null;
    const first = tokens[++index];
    if (first == null) return null;
    paths.push(first);
    if (status[0] === "R" || status[0] === "C") {
      const second = tokens[++index];
      if (second == null) return null;
      paths.push(second);
    }
  }
  return paths.map(safeRelative);
}

// 반환 status는 CHANGED/NO_CHANGES/UNSUPPORTED/FAILED로 고정합니다.
async function collectBuilderDiff(workspaceRoot, options = {}) {
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || !isGitRepo(repo)) {
    return {
      status: "UNSUPPORTED",
      supported: false,
      trackedDiff: "",
      changedPaths: [],
      untracked: [],
      untrackedFiles: [],
      hasChanges: false,
      summary: "",
    };
  }
  const excludes = normalizeExcludes(options.excludePaths);
  try {
    if (options.checkpoint?.supported && options.checkpoint.checkpointId) {
      const resolvedCheckpoint = typeof turnCheckpoint.resolveCheckpoint === "function"
        ? turnCheckpoint.resolveCheckpoint(options.checkpoint)
        : null;
      if (!resolvedCheckpoint?.ok) throw new Error(`checkpoint 검증 실패: ${resolvedCheckpoint?.reason || "invalid"}`);
    }
    const baseline = checkpointBaseline(options.checkpoint);
    const baselineSha = options.checkpoint?.baselineSha || baseline?.baselineSha || "HEAD";
    const trackedDiff = await git(repo, ["diff", "--binary", baselineSha]);
    // 변경된 tracked 경로 목록. captureSubject에서 diff.changedPaths를 사용하므로
    // 수집 실패는 결과 전체를 FAILED로 만든다(부분 정보 전달 금지).
    const nameStatusOut = await git(repo, ["diff", "--name-status", "-z", baselineSha]);
    const parsedTrackedPaths = parseNameStatusPaths(nameStatusOut);
    if (!parsedTrackedPaths || parsedTrackedPaths.some((entry) => !entry)) {
      throw new Error("변경 경로 수집에 실패했습니다.");
    }
    const untrackedOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const currentPaths = String(untrackedOut || "").split("\0").filter(Boolean).map(safeRelative);
    if (currentPaths.some((entry) => !entry)) throw new Error("현재 untracked 경로가 올바르지 않습니다.");
    const current = new Map();
    for (const rel of currentPaths) {
      if (excludes.has(rel)) continue;
      current.set(rel, fileInfo(repo, rel));
    }
    const before = baseline?.files || new Map();
    const untrackedFiles = [];
    const allPaths = new Set([...before.keys(), ...current.keys()]);
    for (const rel of allPaths) {
      if (excludes.has(rel)) continue;
      const info = current.get(rel);
      const prior = before.get(rel);
      const status = statusForFile(prior, info);
      if (!status) continue;
      untrackedFiles.push({
        ...(info || prior),
        status,
        ...(status === "MODIFIED" && info?.content != null ? { content: info.content } : {}),
      });
    }
    const hasChanges = trackedDiff.trim().length > 0 || untrackedFiles.length > 0;
    const seenPaths = new Set(untrackedFiles.map((entry) => entry.path));
    const changedPaths = [];
    for (const rel of parsedTrackedPaths) {
      if (excludes.has(rel) || seenPaths.has(rel)) continue;
      seenPaths.add(rel);
      changedPaths.push(rel);
    }
    const result = {
      status: hasChanges ? "CHANGED" : "NO_CHANGES",
      supported: true,
      baselineSha,
      changedPaths,
      trackedDiff,
      untracked: untrackedFiles.map((entry) => entry.path),
      untrackedFiles,
      hasChanges,
      summary: "",
    };
    result.summary = summarize(result);
    return result;
  } catch (error) {
    return {
      status: "FAILED",
      supported: false,
      trackedDiff: "",
      changedPaths: [],
      untracked: [],
      untrackedFiles: [],
      hasChanges: false,
      summary: "",
      error: error?.message || "diff 수집 실패",
    };
  }
}

function formatFileInfo(entry) {
  const meta = `${entry.status} · ${entry.size == null ? "size unavailable" : `${entry.size} bytes`}${entry.hash ? ` · sha256 ${entry.hash}` : ""}`;
  const lines = [`- ${entry.path} (${meta})`];
  if (entry.content != null) {
    lines.push("```text");
    lines.push(entry.content);
    lines.push("```");
  }
  return lines.join("\n");
}

function formatBuilderDiff(diff) {
  if (!diff || diff.status === "UNSUPPORTED") return "작업공간 변경(Diff)을 사용할 수 없습니다. 현재 파일을 읽어 검수하되 자동 PASS는 금지됩니다.";
  if (diff.status === "FAILED") return `변경(Diff) 수집에 실패했습니다. 자동 검수를 중단합니다. (${diff.error || "알 수 없는 오류"})`;
  if (diff.status === "NO_CHANGES") return "checkpoint 이후 작업공간에 실제 변경(Diff)이 없습니다.";
  const lines = [`변경 상태: ${diff.status}`, `변경 요약: ${diff.summary || "변경 있음"}`];
  if (diff.trackedDiff?.trim()) {
    lines.push("--- 실제 변경 (Diff) 시작 ---");
    lines.push(diff.trackedDiff.trim());
    lines.push("--- 실제 변경 (Diff) 끝 ---");
  }
  if (diff.untrackedFiles?.length) {
    lines.push("checkpoint 이후 untracked 변경:");
    for (const entry of diff.untrackedFiles) lines.push(formatFileInfo(entry));
  }
  return lines.join("\n");
}

async function describeWorkspaceChanges(workspaceRoot, options = {}) {
  const diff = await collectBuilderDiff(workspaceRoot, options);
  return { diff, text: formatBuilderDiff(diff) };
}

module.exports = {
  DIFF_STATUSES,
  MAX_INLINE_FILE_BYTES,
  collectBuilderDiff,
  formatBuilderDiff,
  describeWorkspaceChanges,
};
