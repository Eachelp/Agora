"use strict";

// Stage D-A0 — Verification Safety Boundary
//
// 검증을 "실행하는 엔진"이 아니라, 나중에 들어올 엔진이 지켜야 할 **경계**다.
// D-A2의 Process/Artifact 엔진은 이 경계 안에서만 동작한다.
//
// Charter가 이 단계에 요구하는 것:
//
//   INV-2  검증기는 Worker보다 강한 권한을 얻지 않는다.
//          Verification이 governance 우회로가 되면 안 된다.
//          기본은 READ + bounded EXECUTE이며 외부 부수효과는 금지다.
//
//   R-1    controlClass는 선언되지 않고 계산된다. 불확실하면 아래로 강등한다.
//
//   Runner Contract
//          shell 문자열 금지 · executable + argv + cwd + timeout ·
//          승인된 script는 hash까지 freeze(불일치면 실행 거부) ·
//          env 최소 allowlist · 출력 크기 상한 · timeout 시 process tree kill.
//
//   side-effect accounting
//          검증 실행이 남긴 변경을 Builder의 변경과 분리해 표기한다.
//          섞이면 Reviewer가 보는 diff가 오염된다.
//
// 범위 밖(넣지 않음): criterion 평가·disposition 결정(D-A2 router), 산출물 형식
// 파서, Verification Plan 스키마(D-A1), sandbox(현재 subprocess는 강제 불가라
// OBSERVABLE로 정직하게 기록한다).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { killTree } = require("../chat/chat-agent-runner");
const { ensureExecutable, AVAILABLE } = require("./verification-capabilities");

// 실행 당시의 실제 통제 가능성. 엔진 타입 상수가 아니다(R-1).
const CONTROL_CLASS = Object.freeze({
  ENFORCEABLE: "ENFORCEABLE",
  OBSERVABLE: "OBSERVABLE",
  NEITHER: "NEITHER",
});

const RUNNER_ERRORS = Object.freeze({
  INVALID_SPEC: "INVALID_SPEC",
  PRIVILEGE_DENIED: "PRIVILEGE_DENIED",
  CWD_OUTSIDE_ROOT: "CWD_OUTSIDE_ROOT",
  EXECUTABLE_UNAVAILABLE: "EXECUTABLE_UNAVAILABLE",
  SCRIPT_DIGEST_MISMATCH: "SCRIPT_DIGEST_MISMATCH",
  SHELL_EXECUTABLE: "SHELL_EXECUTABLE",
  SPAWN_FAILED: "SPAWN_FAILED",
  TIMEOUT: "TIMEOUT",
});

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const MAX_ARGV_ITEMS = 200;

// 검증기에게 넘기는 환경변수의 기본 최소 집합.
// process.env를 통째로 넘기면 자격증명·토큰이 그대로 흘러간다.
const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
]);

// 검증 실행이 절대 가질 수 없는 권한. worker가 무엇을 갖고 있든 상관없다.
const VERIFICATION_MAX_PERMISSION = "workspace-read";
const PERMISSION_RANK = Object.freeze({ chat: 0, "workspace-read": 1, "workspace-write": 2 });

const SHELL_BASENAMES = new Set([
  "cmd", "powershell", "pwsh",
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash", "ash",
]);

function isShellExecutable(name) {
  const basename = path.basename(name).toLowerCase();
  const withoutExt = basename.replace(/\.(exe|cmd|bat)$/i, "");
  return SHELL_BASENAMES.has(basename) || SHELL_BASENAMES.has(withoutExt);
}

function cleanText(value, limit = 4096) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, limit) : null;
}

function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInside(root, target) {
  const normalizedRoot = realOrResolved(root);
  const normalizedTarget = realOrResolved(target);
  const a = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const b = process.platform === "win32" ? normalizedTarget.toLowerCase() : normalizedTarget;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
}

function sha256File(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

// 검증 전후 대조용 지문. 존재하지 않는 경로는 null로 남겨 "없었다"를 표현한다.
function fingerprintPaths(root, relPaths = []) {
  const out = {};
  for (const rel of relPaths) {
    const safe = cleanText(rel, 1024);
    if (!safe) continue;
    const target = path.resolve(root, safe);
    if (!isInside(root, target)) continue;
    out[safe] = sha256File(target);
  }
  return out;
}

function diffFingerprints(before = {}, after = {}) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

// 검증 권한은 worker 권한 이하이면서, 어떤 경우에도 write를 넘지 않는다(INV-2).
function verificationPermissionFor(workerPermission) {
  const worker = PERMISSION_RANK[workerPermission] == null ? null : workerPermission;
  if (!worker) return null;
  return PERMISSION_RANK[worker] < PERMISSION_RANK[VERIFICATION_MAX_PERMISSION]
    ? worker
    : VERIFICATION_MAX_PERMISSION;
}

// 실행 당시의 실제 통제 특성에서 계산한다. 선언값은 받지 않는다(R-1).
// D-B가 자원/행동 차원의 통제 신호를 주면 그 신호로 다시 계산할 자리다.
function computeControlClass({ backend, contained }) {
  if (!contained) return CONTROL_CLASS.NEITHER;
  // Agora 자신의 read-only 평가: 무엇을 읽었는지까지 Agora가 통제한다.
  if (backend === "artifact-predicate") return CONTROL_CLASS.ENFORCEABLE;
  // 일반 subprocess: 시작·종료·출력은 관측하지만 그 안의 행동은 강제하지 못한다.
  if (backend === "process") return CONTROL_CLASS.OBSERVABLE;
  // 모르는 backend는 위로 올리지 않는다(fail-closed floor).
  return CONTROL_CLASS.NEITHER;
}

function buildEnv({ allowlist = DEFAULT_ENV_ALLOWLIST, extraNames = [], sourceEnv = process.env }) {
  const names = [...allowlist, ...extraNames.map((name) => cleanText(name, 200)).filter(Boolean)];
  const env = {};
  for (const name of names) {
    if (sourceEnv[name] != null) env[name] = String(sourceEnv[name]);
  }
  return env;
}

function failure(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

// 실행 전에 계약을 검사한다. 여기서 통과하지 못하면 프로세스를 띄우지 않는다.
function admitVerificationStep(spec = {}, context = {}) {
  const root = cleanText(context.root, 4096);
  if (!root) return failure(RUNNER_ERRORS.INVALID_SPEC, "검증 실행의 기준 폴더가 없습니다.");

  const permission = verificationPermissionFor(context.workerPermission);
  if (!permission) {
    return failure(RUNNER_ERRORS.PRIVILEGE_DENIED, "검증 실행 권한을 계산할 수 없습니다.");
  }

  const executable = cleanText(spec.executable, 4096);
  if (!executable) return failure(RUNNER_ERRORS.INVALID_SPEC, "실행할 프로그램이 선언되지 않았습니다.");
  // shell 문자열을 executable에 밀어 넣는 우회를 막는다.
  if (/[\r\n]/.test(executable) || /[&|;<>]/.test(executable)) {
    return failure(RUNNER_ERRORS.INVALID_SPEC, "실행 선언에 셸 제어 문자가 있습니다.");
  }
  if (isShellExecutable(executable)) {
    return failure(RUNNER_ERRORS.SHELL_EXECUTABLE, "셸 자체를 검증 실행 파일로 쓸 수 없습니다.");
  }

  const argv = Array.isArray(spec.argv) ? spec.argv : [];
  if (argv.length > MAX_ARGV_ITEMS) {
    return failure(RUNNER_ERRORS.INVALID_SPEC, "실행 인자가 허용 개수를 넘었습니다.");
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || /[\r\n\0]/.test(arg)) {
      return failure(RUNNER_ERRORS.INVALID_SPEC, "실행 인자가 올바르지 않습니다.");
    }
  }

  const cwd = spec.cwd ? path.resolve(root, spec.cwd) : realOrResolved(root);
  if (!isInside(root, cwd)) {
    return failure(RUNNER_ERRORS.CWD_OUTSIDE_ROOT, "검증 실행 위치가 작업 폴더 밖입니다.");
  }

  // 승인된 script는 경로가 아니라 내용으로 고정된다. 승인 이후 내용이 바뀌면
  // 그것은 승인받은 검사가 아니다.
  const scriptPath = spec.scriptPath ? path.resolve(root, spec.scriptPath) : null;
  if (scriptPath) {
    if (!isInside(root, scriptPath)) {
      return failure(RUNNER_ERRORS.CWD_OUTSIDE_ROOT, "검증 스크립트가 작업 폴더 밖입니다.");
    }
    const expected = cleanText(spec.scriptSha256, 128);
    if (!expected) {
      return failure(RUNNER_ERRORS.INVALID_SPEC, "검증 스크립트의 동결 해시가 없습니다.");
    }
    const actual = sha256File(scriptPath);
    if (actual !== expected) {
      return failure(RUNNER_ERRORS.SCRIPT_DIGEST_MISMATCH, "승인된 검증 스크립트와 내용이 다릅니다.", {
        expected,
        actual,
      });
    }
  }

  const declaredScriptReal = scriptPath ? realOrResolved(scriptPath) : null;
  const frozenFiles = (spec.frozenFiles && typeof spec.frozenFiles === "object" && !Array.isArray(spec.frozenFiles))
    ? spec.frozenFiles : {};
  for (const arg of argv) {
    let absArg;
    try { absArg = path.resolve(root, arg); } catch { continue; }
    if (!isInside(root, absArg)) continue;
    const realArg = realOrResolved(absArg);
    if (declaredScriptReal && realArg === declaredScriptReal) continue;
    let stat;
    try { stat = fs.statSync(absArg); } catch { continue; }
    if (!stat.isFile()) continue;
    const relArg = path.relative(realOrResolved(root), realArg);
    const expectedHash = cleanText(
      frozenFiles[relArg] || frozenFiles[arg] || frozenFiles[absArg], 128
    );
    if (!expectedHash) {
      return failure(RUNNER_ERRORS.INVALID_SPEC,
        "argv가 참조하는 workspace 파일의 동결 해시가 없습니다.");
    }
    const actualHash = sha256File(absArg);
    if (actualHash !== expectedHash) {
      return failure(RUNNER_ERRORS.SCRIPT_DIGEST_MISMATCH,
        "argv가 참조하는 파일의 내용이 승인 시점과 다릅니다.",
        { path: arg, expected: expectedHash, actual: actualHash });
    }
  }

  const resolved = context.capabilities
    ? ensureExecutable(context.capabilities, executable, { env: context.env, platform: context.platform })
    : null;
  if (resolved && resolved.state !== AVAILABLE) {
    return failure(RUNNER_ERRORS.EXECUTABLE_UNAVAILABLE, "이 PC에서 검증 프로그램을 찾지 못했습니다.", {
      executable,
    });
  }
  if (resolved?.resolvedPath && isShellExecutable(resolved.resolvedPath)) {
    return failure(RUNNER_ERRORS.SHELL_EXECUTABLE, "셸 자체를 검증 실행 파일로 쓸 수 없습니다.");
  }

  const timeoutMs = Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0
    ? Math.min(spec.timeoutMs, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  return {
    ok: true,
    admitted: {
      executable: resolved?.resolvedPath || executable,
      declaredExecutable: executable,
      argv: [...argv],
      cwd,
      timeoutMs,
      permission,
      scriptPath,
      env: buildEnv({
        allowlist: context.envAllowlist || DEFAULT_ENV_ALLOWLIST,
        extraNames: Array.isArray(spec.envNames) ? spec.envNames : [],
        sourceEnv: context.env || process.env,
      }),
    },
  };
}

// 선언된 프로세스를 실행하고 실제 결과를 포착한다.
// 이 함수는 판정하지 않는다 — 무엇이 일어났는지만 사실로 남긴다(D-A2가 판정).
async function runVerificationProcess(spec = {}, context = {}) {
  const admission = admitVerificationStep(spec, context);
  const startedAt = (context.now || Date.now)();
  if (!admission.ok) {
    return {
      ok: false,
      code: admission.code,
      error: admission.error,
      backend: "process",
      controlClass: CONTROL_CLASS.NEITHER,
      startedAt,
      finishedAt: startedAt,
      sideEffects: { accounted: false, changedPaths: [] },
    };
  }

  const step = admission.admitted;
  const scope = Array.isArray(context.sideEffectScope) ? context.sideEffectScope : null;
  const before = scope ? fingerprintPaths(context.root, scope) : null;

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(step.executable, step.argv, {
        cwd: step.cwd,
        env: step.env,
        windowsHide: true,
        // shell은 절대 쓰지 않는다. 문자열 해석 경로가 생기는 순간 argv 검증이 무의미해진다.
        shell: false,
      });
    } catch (error) {
      resolve({ spawnFailed: true, error: error?.message || "실행에 실패했습니다." });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const capture = (chunk, target) => {
      const text = String(chunk);
      const current = target === "out" ? stdout : stderr;
      if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_CAPTURED_OUTPUT_BYTES - current.length;
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (target === "out") stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on("data", (chunk) => capture(chunk, "out"));
    child.stderr?.on("data", (chunk) => capture(chunk, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, step.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ spawnFailed: true, error: error?.message || "실행에 실패했습니다." });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, truncated, timedOut });
    });
  });

  const finishedAt = (context.now || Date.now)();
  const after = scope ? fingerprintPaths(context.root, scope) : null;
  const sideEffects = scope
    ? { accounted: true, changedPaths: diffFingerprints(before, after) }
    : { accounted: false, changedPaths: [] };

  const base = {
    backend: "process",
    // subprocess의 행동은 강제하지 못하고 관측만 한다.
    controlClass: computeControlClass({ backend: "process", contained: true }),
    permission: step.permission,
    executable: step.declaredExecutable,
    resolvedExecutable: step.executable,
    argv: step.argv,
    cwd: step.cwd,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    sideEffects,
  };

  if (result.spawnFailed) {
    return { ...base, ok: false, code: RUNNER_ERRORS.SPAWN_FAILED, error: result.error };
  }
  if (result.timedOut) {
    return {
      ...base,
      ok: false,
      code: RUNNER_ERRORS.TIMEOUT,
      error: `검증 실행이 ${step.timeoutMs}ms 안에 끝나지 않았습니다.`,
      exitCode: result.exitCode ?? null,
      signal: result.signal || null,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  }
  return {
    ...base,
    ok: true,
    exitCode: result.exitCode ?? null,
    signal: result.signal || null,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

module.exports = {
  CONTROL_CLASS,
  RUNNER_ERRORS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_CAPTURED_OUTPUT_BYTES,
  DEFAULT_ENV_ALLOWLIST,
  VERIFICATION_MAX_PERMISSION,
  verificationPermissionFor,
  computeControlClass,
  admitVerificationStep,
  runVerificationProcess,
  fingerprintPaths,
  diffFingerprints,
};
