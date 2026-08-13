// 전문 실행 직전의 workspace 상태를 보존하고, 중단 시 안전하게 되돌립니다.
// checkpoint의 영속 위치와 경로 해석은 이 모듈이 단일 책임으로 맡습니다.
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const execFileAsync = promisify(execFile);
const CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_ID_PATTERN = /^cp-[a-z0-9-]{8,80}$/;

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

function pathKey(value) {
  return String(value || "").replace(/[\\/]+/g, path.sep);
}

function isWithin(root, target) {
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const base = normalize(path.resolve(root));
  const candidate = normalize(path.resolve(target));
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

// git path 목록은 workspace 기준의 상대 경로만 허용합니다. 절대 경로와
// .. 탈출을 거부해야 restore/cleanup의 입력이 불신 상태에서도 안전합니다.
function safeRelativePath(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const normalized = path.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    return null;
  }
  return normalized;
}

function parseRelativeList(raw) {
  const values = String(raw || "").split(/\r?\n/).filter(Boolean);
  const result = [];
  for (const value of values) {
    const safe = safeRelativePath(value);
    if (!safe) return null;
    result.push(safe);
  }
  return result;
}

function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function checkpointId() {
  return `cp-${crypto.randomBytes(12).toString("hex")}`;
}

function defaultStorageRoot(repo) {
  // Product 호출은 항상 ChatStore의 session checkpoint root를 전달합니다.
  // 직접 호출하는 legacy/test API도 OS 임시 폴더를 사용하지 않고 workspace의
  // gitignore 대상 .agora 아래에 둡니다. 실제 제품 경로는 sessionId별 root입니다.
  return path.join(repo, ".agora", "checkpoints");
}

function descriptorRoot(checkpoint, options = {}) {
  return options.storageRoot || checkpoint?.storageRoot || checkpoint?.checkpointRoot || null;
}

function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null;
  }
}

function resolveCheckpoint(checkpoint, options = {}) {
  if (!checkpoint || checkpoint.supported !== true) return { ok: false, reason: "unsupported" };
  const id = String(checkpoint.checkpointId || "");
  if (!CHECKPOINT_ID_PATTERN.test(id)) return { ok: false, reason: "invalid-checkpoint-id" };
  const root = descriptorRoot(checkpoint, options);
  if (!root) return { ok: false, reason: "missing-checkpoint-root" };
  const checkpointRoot = path.resolve(root);
  const dir = path.resolve(checkpointRoot, id);
  if (!isWithin(checkpointRoot, dir) || path.basename(dir) !== id || !fs.existsSync(dir)) {
    return { ok: false, reason: "checkpoint-outside-root" };
  }
  const manifest = readManifest(dir);
  if (!manifest || manifest.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || manifest.checkpointId !== id) {
    return { ok: false, reason: "manifest-invalid" };
  }
  if (checkpoint.sessionId != null && manifest.sessionId !== checkpoint.sessionId) {
    return { ok: false, reason: "session-mismatch" };
  }
  if (checkpoint.runId != null && manifest.runId !== checkpoint.runId) {
    return { ok: false, reason: "run-mismatch" };
  }
  if (!manifest.workspace || !path.isAbsolute(manifest.workspace)) {
    return { ok: false, reason: "workspace-invalid" };
  }
  return { ok: true, dir, manifest, checkpointRoot };
}

async function createCheckpoint(workspaceRoot, options = {}) {
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || !isGitRepo(repo)) return { supported: false };

  const storageRoot = path.resolve(options.storageRoot || defaultStorageRoot(repo));
  const id = checkpointId();
  const dir = path.join(storageRoot, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stashOutput = await git(repo, ["stash", "create"]);
    let baselineSha = String(stashOutput || "").trim();
    if (!baselineSha) baselineSha = String(await git(repo, ["rev-parse", "HEAD"])).trim();
    const diffOut = await git(repo, ["diff", "--binary", "HEAD"]);
    fs.writeFileSync(path.join(dir, "tracked.patch"), diffOut, "utf8");

    const untrackedOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untrackedPaths = String(untrackedOut || "").split("\0").filter(Boolean);
    const safePaths = [];
    for (const rel of untrackedPaths) {
      const safe = safeRelativePath(rel);
      if (!safe || !isWithin(repo, path.resolve(repo, safe))) throw new Error("checkpoint untracked 경로가 올바르지 않습니다.");
      const src = path.resolve(repo, safe);
      // 저장소가 자체 checkpoint 디렉터리를 ignore하지 않는 환경에서도
      // checkpoint가 자기 자신의 patch/manifest를 baseline으로 복사하지 않게 한다.
      if (isWithin(storageRoot, src)) continue;
      const dest = path.resolve(dir, "untracked", safe);
      if (!isWithin(path.join(dir, "untracked"), dest)) throw new Error("checkpoint 사본 경로가 올바르지 않습니다.");
      safePaths.push(safe);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    fs.writeFileSync(path.join(dir, "untracked-list.txt"), safePaths.join("\n"), "utf8");
    const manifest = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId: id,
      sessionId: options.sessionId || null,
      runId: options.runId || null,
      workspace: repo,
      baselineSha,
      createdAt: Number.isFinite(options.createdAt) ? options.createdAt : Date.now(),
    };
    atomicJson(path.join(dir, "manifest.json"), manifest);
    return {
      supported: true,
      checkpointId: id,
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      workspace: repo,
      storageRoot,
      baselineSha,
    };
  } catch {
    try {
      if (isWithin(storageRoot, dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    return { supported: false };
  }
}

function inspectCheckpoint(checkpoint, options = {}) {
  const resolved = resolveCheckpoint(checkpoint, options);
  return { ok: resolved.ok, reason: resolved.reason || null, manifest: resolved.manifest || null };
}

async function restoreCheckpoint(workspaceRoot, checkpoint, options = {}) {
  const resolved = resolveCheckpoint(checkpoint, options);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || repo !== resolved.manifest.workspace) return { ok: false, reason: "workspace-mismatch" };
  try {
    const listPath = path.join(resolved.dir, "untracked-list.txt");
    const checkpointList = parseRelativeList(fs.existsSync(listPath) ? fs.readFileSync(listPath, "utf8") : "");
    if (!checkpointList) return { ok: false, reason: "untracked-list-invalid" };
    const checkpointSet = new Set(checkpointList.map(pathKey));
    const preserveSet = new Set(
      (Array.isArray(options.preservePaths) ? options.preservePaths : [])
        .map(safeRelativePath)
        .filter(Boolean)
        .map(pathKey)
    );
    await git(repo, ["checkout", "--", "."]);
    const patchPath = path.join(resolved.dir, "tracked.patch");
    if (fs.existsSync(patchPath) && fs.readFileSync(patchPath, "utf8").trim()) {
      await git(repo, ["apply", "--binary", patchPath]);
    }

    const currentOut = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const currentPaths = String(currentOut || "").split("\0").filter(Boolean);
    for (const rel of currentPaths) {
      const safe = safeRelativePath(rel);
      if (!safe) return { ok: false, reason: "current-untracked-invalid" };
      const target = path.resolve(repo, safe);
      if (!isWithin(repo, target)) return { ok: false, reason: "current-untracked-outside-workspace" };
      // 테스트/구형 저장소가 .agora를 ignore하지 않아도 현재 checkpoint
      // 자체를 Builder 산출물로 오인해 삭제하지 않는다.
      if (isWithin(resolved.checkpointRoot, target)) continue;
      if (!checkpointSet.has(pathKey(safe)) && !preserveSet.has(pathKey(safe)) && fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    const baselineRoot = path.join(resolved.dir, "untracked");
    for (const safe of checkpointList) {
      const src = path.resolve(baselineRoot, safe);
      const dest = path.resolve(repo, safe);
      if (!isWithin(baselineRoot, src) || !isWithin(repo, dest)) return { ok: false, reason: "untracked-copy-outside-root" };
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "restore-failed" };
  }
}

function cleanupCheckpoint(checkpoint, options = {}) {
  const resolved = resolveCheckpoint(checkpoint, options);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  try {
    fs.rmSync(resolved.dir, { recursive: true, force: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "cleanup-failed" };
  }
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_ID_PATTERN,
  createCheckpoint,
  inspectCheckpoint,
  resolveCheckpoint,
  restoreCheckpoint,
  cleanupCheckpoint,
  safeRelativePath,
};
