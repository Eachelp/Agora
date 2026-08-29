// 전문 실행 직전의 workspace 상태를 보존하고, 중단 시 안전하게 되돌립니다.
// checkpoint의 영속 위치와 경로 해석은 이 모듈이 단일 책임으로 맡습니다.
"use strict";

const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sha256FileSync } = require("./assurance/file-digest");

const execFileAsync = promisify(execFile);
const CHECKPOINT_SCHEMA_VERSION = 2;
const CHECKPOINT_ID_PATTERN = /^cp-[a-z0-9-]{8,80}$/;

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// checkpoint artifact는 크기가 예측되지 않는다(tracked.patch가 수백 MB, untracked
// 사본이 100MB를 넘기도 한다). 통째로 읽어 해시하면 방금 스트리밍으로 피한 메모리
// 급증을 바로 다음 줄에서 다시 만든다. 청크 해시를 쓴다.
function sha256File(filePath) {
  try {
    const bytes = fs.statSync(filePath).size;
    const sha256 = sha256FileSync(filePath);
    return sha256 ? { bytes, sha256 } : null;
  } catch {
    return null;
  }
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

// git 출력을 메모리에 담지 않고 파일로 곧장 흘려보낸다.
//
// 예전에는 `git diff --binary HEAD` 전체를 execFile로 버퍼에 받은 뒤 파일에 썼다.
// 그런데 변경 파일이 많거나 바이너리 삭제가 섞이면 diff는 쉽게 수백 MB가 되고
// (실측: 변경 29,000여 건인 저장소에서 552MB), maxBuffer 상한에 걸려
// "Git 명령 실행에 실패했습니다"로 죽었다. 저장소 상태 문제가 아니라 받는 방식
// 문제였다. 어차피 곧바로 파일에 쓸 내용이므로 버퍼를 거칠 이유가 없다.
function gitToFile(root, args, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true });
    const out = fs.createWriteStream(outPath);
    let stderr = "";
    let exitCode = null;
    let closed = false;
    let failure = null;

    // 프로세스 종료와 파일 닫힘이 **둘 다** 끝나야 patch가 온전히 쓰였다고 말할 수 있다.
    const settle = () => {
      if (exitCode === null || !closed) return;
      if (failure) return reject(failure);
      if (exitCode === 0) return resolve();
      reject(new Error(`git ${args[0]} 실패 (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`));
    };

    child.stderr.on("data", (chunk) => {
      // 경고까지 다 모으면 메모리를 또 쓰게 된다. 진단에 필요한 만큼만 남긴다.
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on("error", (error) => {
      failure = error;
      exitCode = -1;
      closed = true;
      out.destroy();
      settle();
    });
    out.on("error", (error) => {
      failure = error;
      closed = true;
      settle();
    });
    out.on("close", () => {
      closed = true;
      settle();
    });
    child.on("close", (code) => {
      exitCode = code === null ? -1 : code;
      settle();
    });
    child.stdout.pipe(out);
  });
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

// checkpoint 실패는 항상 CHECKPOINT_* enum으로만 표현합니다. OS/라이브러리의
// raw error code(EACCES, ENOSPC, ENOENT 등)가 그대로 사용자·evidence까지
// 새어나가지 않도록, 각 실패 지점에서 typed error를 만들어 던집니다.
const CHECKPOINT_FAILURE_CODES = Object.freeze([
  "CHECKPOINT_GIT_FAILED",
  "CHECKPOINT_STORAGE_FAILED",
  "CHECKPOINT_MANIFEST_FAILED",
  "CHECKPOINT_COPY_FAILED",
  "CHECKPOINT_UNTRACKED_NOT_REGULAR",
  "CHECKPOINT_UNKNOWN",
]);

function checkpointError(code, message, cause) {
  const err = new Error(message);
  err.code = CHECKPOINT_FAILURE_CODES.includes(code) ? code : "CHECKPOINT_UNKNOWN";
  // 원인 추적을 위해 OS 코드는 별도 필드로만 보존합니다(사용자 노출용 아님).
  if (cause && typeof cause.code === "string") err.osCode = cause.code;
  if (cause instanceof Error) err.cause = cause;
  return err;
}

// 실패 지점별 typed 래퍼. 동기 fs 호출을 감싸 raw code 누출을 차단합니다.
function guard(code, message, fn) {
  try {
    return fn();
  } catch (error) {
    if (typeof error?.code === "string" && CHECKPOINT_FAILURE_CODES.includes(error.code)) throw error;
    throw checkpointError(code, message, error);
  }
}

async function guardAsync(code, message, fn) {
  try {
    return await fn();
  } catch (error) {
    if (typeof error?.code === "string" && CHECKPOINT_FAILURE_CODES.includes(error.code)) throw error;
    throw checkpointError(code, message, error);
  }
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

  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== "object") {
    return { ok: false, reason: "artifacts-missing" };
  }

  const patchPath = path.join(dir, "tracked.patch");
  const patchMeta = sha256File(patchPath);
  if (!patchMeta || patchMeta.bytes !== artifacts.trackedPatch?.bytes || patchMeta.sha256 !== artifacts.trackedPatch?.sha256) {
    return { ok: false, reason: "tracked-patch-corrupt" };
  }

  const listPath = path.join(dir, "untracked-list.txt");
  const listMeta = sha256File(listPath);
  if (!listMeta || listMeta.bytes !== artifacts.untrackedList?.bytes || listMeta.sha256 !== artifacts.untrackedList?.sha256) {
    return { ok: false, reason: "untracked-list-corrupt" };
  }

  const checkpointList = parseRelativeList(fs.readFileSync(listPath, "utf8"));
  if (!checkpointList) return { ok: false, reason: "untracked-list-invalid" };

  const manifestUntracked = Array.isArray(artifacts.untracked) ? artifacts.untracked : [];
  if (manifestUntracked.length !== checkpointList.length) {
    return { ok: false, reason: "untracked-count-mismatch" };
  }

  const baselineRoot = path.join(dir, "untracked");
  for (let i = 0; i < manifestUntracked.length; i++) {
    const entry = manifestUntracked[i];
    const safe = safeRelativePath(entry.path);
    if (!safe || safe !== checkpointList[i]) {
      return { ok: false, reason: "untracked-entry-invalid" };
    }
    const itemPath = path.resolve(baselineRoot, safe);
    if (!isWithin(baselineRoot, itemPath)) {
      return { ok: false, reason: "untracked-entry-outside-root" };
    }
    const itemMeta = sha256File(itemPath);
    if (!itemMeta || itemMeta.bytes !== entry.bytes || itemMeta.sha256 !== entry.sha256) {
      return { ok: false, reason: "untracked-copy-corrupt" };
    }
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
    guard("CHECKPOINT_STORAGE_FAILED", "checkpoint 저장 폴더를 만들 수 없습니다.", () =>
      fs.mkdirSync(dir, { recursive: true })
    );
    const stashOutput = await guardAsync("CHECKPOINT_GIT_FAILED", "git stash create에 실패했습니다.", () =>
      git(repo, ["stash", "create"])
    );
    let baselineSha = String(stashOutput || "").trim();
    if (!baselineSha) {
      const headOut = await guardAsync("CHECKPOINT_GIT_FAILED", "git rev-parse HEAD에 실패했습니다.", () =>
        git(repo, ["rev-parse", "HEAD"])
      );
      baselineSha = String(headOut).trim();
    }
    // diff는 크기가 예측되지 않으므로(바이너리 삭제 하나로 수백 MB가 된다)
    // 버퍼에 받지 않고 tracked.patch로 곧장 흘려보낸다.
    await guardAsync("CHECKPOINT_GIT_FAILED", "git diff 수집에 실패했습니다.", () =>
      gitToFile(repo, ["diff", "--binary", "HEAD"], path.join(dir, "tracked.patch"))
    );

    const untrackedOut = await guardAsync("CHECKPOINT_GIT_FAILED", "untracked 목록 수집에 실패했습니다.", () =>
      git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    );
    const untrackedPaths = String(untrackedOut || "").split("\0").filter(Boolean);
    const safePaths = [];
    const untrackedArtifacts = [];
    for (const rel of untrackedPaths) {
      const safe = safeRelativePath(rel);
      if (!safe || !isWithin(repo, path.resolve(repo, safe))) {
        throw checkpointError("CHECKPOINT_UNTRACKED_NOT_REGULAR", "checkpoint untracked 경로가 올바르지 않습니다.");
      }
      const src = path.resolve(repo, safe);
      // 저장소가 자체 checkpoint 디렉터리를 ignore하지 않는 환경에서도
      // checkpoint가 자기 자신의 patch/manifest를 baseline으로 복사하지 않게 한다.
      if (isWithin(storageRoot, src)) continue;
      const dest = path.resolve(dir, "untracked", safe);
      if (!isWithin(path.join(dir, "untracked"), dest)) {
        throw checkpointError("CHECKPOINT_COPY_FAILED", "checkpoint 사본 경로가 올바르지 않습니다.");
      }
      // lstat으로 symlink를 따라가지 않고 판별한다. symlink/디렉터리/특수 파일은
      // checkpoint 대상이 아니므로 생성을 실패시켜 Builder를 시작하지 않는다.
      const stat = guard("CHECKPOINT_COPY_FAILED", "checkpoint 대상 파일 정보를 읽을 수 없습니다: " + safe, () =>
        fs.lstatSync(src)
      );
      if (!stat.isFile()) {
        throw checkpointError(
          "CHECKPOINT_UNTRACKED_NOT_REGULAR",
          "checkpoint untracked 파일이 일반 파일이 아닙니다: " + safe
        );
      }
      safePaths.push(safe);
      if (fs.existsSync(src)) {
        guard("CHECKPOINT_COPY_FAILED", "checkpoint 사본 폴더를 만들 수 없습니다: " + safe, () =>
          fs.mkdirSync(path.dirname(dest), { recursive: true })
        );
        guard("CHECKPOINT_COPY_FAILED", "checkpoint 사본 복사에 실패했습니다: " + safe, () =>
          fs.copyFileSync(src, dest)
        );
        const copyMeta = sha256File(dest);
        if (!copyMeta) {
          throw checkpointError("CHECKPOINT_COPY_FAILED", "checkpoint 사본을 검증할 수 없습니다: " + safe);
        }
        untrackedArtifacts.push({
          path: safe,
          bytes: copyMeta.bytes,
          sha256: copyMeta.sha256,
        });
      }
    }
    const patchPath = path.join(dir, "tracked.patch");
    const trackedPatchMeta = sha256File(patchPath);
    if (!trackedPatchMeta) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "tracked.patch를 저장 후 검증할 수 없습니다.");
    }
    const listPath = path.join(dir, "untracked-list.txt");
    guard("CHECKPOINT_STORAGE_FAILED", "untracked 목록 저장에 실패했습니다.", () =>
      fs.writeFileSync(listPath, safePaths.join("\n"), "utf8")
    );
    const untrackedListMeta = sha256File(listPath);
    if (!untrackedListMeta) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "untracked-list.txt를 저장 후 검증할 수 없습니다.");
    }

    const manifest = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId: id,
      sessionId: options.sessionId || null,
      runId: options.runId || null,
      workspace: repo,
      baselineSha,
      createdAt: Number.isFinite(options.createdAt) ? options.createdAt : Date.now(),
      artifacts: {
        trackedPatch: {
          path: "tracked.patch",
          bytes: trackedPatchMeta.bytes,
          sha256: trackedPatchMeta.sha256,
        },
        untrackedList: {
          path: "untracked-list.txt",
          bytes: untrackedListMeta.bytes,
          sha256: untrackedListMeta.sha256,
        },
        untracked: untrackedArtifacts,
      },
    };
    guard("CHECKPOINT_MANIFEST_FAILED", "checkpoint manifest 저장에 실패했습니다.", () =>
      atomicJson(path.join(dir, "manifest.json"), manifest)
    );
    const descriptor = {
      supported: true,
      checkpointId: id,
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      workspace: repo,
      storageRoot,
      baselineSha,
    };
    // protected라고 선언하기 전에 artifact 무결성과 manifest descriptor를 자체 검증한다.
    const inspected = inspectCheckpoint(descriptor);
    if (!inspected.ok) {
      throw checkpointError(
        "CHECKPOINT_MANIFEST_FAILED",
        `checkpoint 자체 검증 실패: ${inspected.reason}`
      );
    }
    return descriptor;
  } catch (error) {
    try {
      if (isWithin(storageRoot, dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    // 여기 도달했다는 것은 Git 저장소인데 백업 생성에 실패했다는 뜻이다.
    // non-Git(supported:false)과 구분해 호출자가 Builder를 무방비로 시작하지
    // 않도록 failed 플래그를 남긴다.
    // reason은 항상 CHECKPOINT_* enum이다. 각 실패 지점에서 typed error를
    // 만들기 때문에 OS raw code(EACCES/ENOSPC 등)는 여기까지 오지 않으며,
    // 예기치 못한 경로는 CHECKPOINT_UNKNOWN으로 닫는다.
    const code = typeof error?.code === "string" && CHECKPOINT_FAILURE_CODES.includes(error.code)
      ? error.code
      : "CHECKPOINT_UNKNOWN";
    return {
      supported: false,
      failed: true,
      reason: code,
    };
  }
}

function validateCheckpoint(checkpoint, options = {}) {
  return inspectCheckpoint(checkpoint, options);
}

function inspectCheckpoint(checkpoint, options = {}) {
  const resolved = resolveCheckpoint(checkpoint, options);
  return { ok: resolved.ok, reason: resolved.reason || null, manifest: resolved.manifest || null };
}

// 실패 결과의 mutated 필드는 "workspace 변경(rewind)이 시작되었을 가능성"을 뜻한다.
// 첫 git 변경 명령(git checkout) 이전에 명확히 끝난 실패만 mutated:false이며, 그 외
// (부분 적용/원인 불명 실패)는 모두 mutated:true로 보수적으로 보고한다. 상위
// lifecycle 소비자는 이 fact로 "무변경 실패 → 세션 유지"와 "ambiguous/partial →
// conservative invalidate"를 구분한다. 이 모듈은 lifecycle 결정을 하지 않는다.
async function restoreCheckpoint(workspaceRoot, checkpoint, options = {}) {
  const resolved = resolveCheckpoint(checkpoint, options);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, mutated: false };
  const repo = resolveWorkspace(workspaceRoot);
  if (!repo || repo !== resolved.manifest.workspace) return { ok: false, reason: "workspace-mismatch", mutated: false };
  try {
    const listPath = path.join(resolved.dir, "untracked-list.txt");
    const checkpointList = parseRelativeList(fs.existsSync(listPath) ? fs.readFileSync(listPath, "utf8") : "");
    if (!checkpointList) return { ok: false, reason: "untracked-list-invalid", mutated: false };
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
      if (!safe) return { ok: false, reason: "current-untracked-invalid", mutated: true };
      const target = path.resolve(repo, safe);
      if (!isWithin(repo, target)) return { ok: false, reason: "current-untracked-outside-workspace", mutated: true };
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
      if (!isWithin(baselineRoot, src) || !isWithin(repo, dest)) return { ok: false, reason: "untracked-copy-outside-root", mutated: true };
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
    return { ok: true };
  } catch {
    // git checkout/apply 도중의 실패는 부분 적용 여부를 알 수 없다 → 보수적으로 mutated.
    return { ok: false, reason: "restore-failed", mutated: true };
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
  validateCheckpoint,
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_ID_PATTERN,
  CHECKPOINT_FAILURE_CODES,
  createCheckpoint,
  inspectCheckpoint,
  resolveCheckpoint,
  restoreCheckpoint,
  cleanupCheckpoint,
  safeRelativePath,
};
