// 작업 폴더에서 "언제부터 지금까지 무엇이 바뀌었는지"를 가볍게 훑습니다.
//
// 왜 git diff가 아닌가: git diff는 baseline(HEAD·checkpoint) 이후의 모든 변경을
// 보여 주므로 **사용자가 미리 갖고 있던 변경**까지 함께 잡힙니다. 여기서 답해야
// 하는 질문은 "이번 실행이 무엇을 바꿨는가" 하나뿐입니다. git이 아닌 폴더에서도
// 같은 방식으로 동작해야 하고요.
//
// 왜 실행 전후 스냅샷이 아닌가: 실행 전 스냅샷은 시작을 그만큼 늦추고(파일이 많은
// 저장소에서는 1초에 가깝습니다), 스냅샷을 뜨는 동안 들어온 쓰기를 기준선에
// 포함해 버립니다. 대신 실행을 시작한 시각을 기억해 두고, 끝난 뒤 그보다 나중에
// 수정된 파일을 찾습니다 — 훑는 것은 한 번뿐이고 답을 기다리는 동안이 아니라
// 답이 온 뒤에 돕니다.
//
// 내용은 읽지 않습니다(해시 없음). 필요한 것은 "바뀌었다"는 사실뿐입니다.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 실행 결과가 아니라 도구가 만드는 것들. 여기까지 세면 거의 항상 시끄럽습니다.
const SKIP_DIRS = Object.freeze(new Set([
  ".git",
  ".hg",
  ".svn",
  ".agora",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
]));

// 큰 저장소에서 감시가 실행보다 비싸지지 않도록 둔 상한입니다. 넘으면 결과를
// 버립니다 — 반쪽짜리 목록으로 "폴더 밖을 건드렸다"고 말하는 것보다 아무 말도
// 하지 않는 쪽이 낫습니다.
const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_DEADLINE_MS = 3000;

function normalizeRoot(root) {
  if (!root) return null;
  try {
    const resolved = fs.realpathSync(root);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// root 아래에서 sinceMs **이후에** 수정된 파일의 상대 경로(구분자는 항상 "/").
// 성공하면 { ok: true, paths }, 아니면 { ok: false, reason }.
//
// 경계는 열려 있습니다(mtime > sinceMs). 수정시각 해상도가 1초인 파일 시스템에서는
// 시각이 내림되므로, 실행 직전에 바뀐 파일이 경계에 걸리면 **빠지는** 쪽으로
// 기웁니다. 놓치는 것보다 엉뚱한 파일을 지목하는 쪽이 나쁘기 때문입니다.
async function filesModifiedSince(root, sinceMs, options = {}) {
  const base = normalizeRoot(root);
  if (!base) return { ok: false, reason: "NO_WORKSPACE" };
  if (!Number.isFinite(sinceMs)) return { ok: false, reason: "NO_BASELINE" };
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const deadlineMs = Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
    ? options.deadlineMs
    : DEFAULT_DEADLINE_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const paths = [];
  let seen = 0;

  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // 읽을 수 없는 폴더는 건너뜁니다. 감시 실패가 실행 실패가 되면 안 됩니다.
      return true;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > maxEntries) return false;
      if (now() - startedAt > deadlineMs) return false;
      // symlink는 따라가지 않습니다(순환·작업 폴더 밖 탈출).
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!(await walk(path.join(dir, entry.name), rel))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(path.join(dir, entry.name));
        if (stat.mtimeMs > sinceMs) paths.push(rel);
      } catch {
        // 훑는 사이 사라진 파일. 셀 것이 없습니다.
      }
    }
    return true;
  };

  const complete = await walk(base, "");
  if (!complete) return { ok: false, reason: seen > maxEntries ? "TOO_MANY_FILES" : "TIMED_OUT" };
  return { ok: true, paths: paths.sort() };
}

module.exports = {
  SKIP_DIRS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_DEADLINE_MS,
  filesModifiedSince,
};
