"use strict";

// Stage D-A0 — Verification Safety Boundary.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md D-A0):
//   INV-2  검증기는 Worker보다 강한 권한을 얻지 않는다. 어떤 경우에도 write 없음.
//   R-1    controlClass는 계산된다. 불확실하면 아래로 강등한다.
//   Runner Contract
//          shell 금지 · 작업 폴더 밖 실행 금지 · 승인된 script는 hash로 고정 ·
//          env 최소 allowlist · 출력 상한 · timeout 시 process tree kill.
//   side-effect accounting
//          검증 실행이 남긴 변경을 사실로 분리해 남긴다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  CONTROL_CLASS,
  RUNNER_ERRORS,
  DEFAULT_ENV_ALLOWLIST,
  VERIFICATION_MAX_PERMISSION,
  verificationPermissionFor,
  computeControlClass,
  admitVerificationStep,
  runVerificationProcess,
  fingerprintPaths,
  diffFingerprints,
} = require("../src/agora/verification-runner");
const { discoverVerificationCapabilities } = require("../src/agora/verification-capabilities");

function tempRoot(prefix = "agora-vrun-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function nodeSpec(root, code, extra = {}) {
  const scriptPath = path.join(root, "check.js");
  fs.writeFileSync(scriptPath, code);
  const digest = crypto.createHash("sha256").update(Buffer.from(code)).digest("hex");
  return {
    spec: {
      executable: process.execPath,
      argv: [scriptPath],
      timeoutMs: 15000,
      ...extra,
      frozenFiles: { [scriptPath]: digest, ...(extra.frozenFiles || {}) },
    },
    scriptPath,
    digest,
  };
}

function context(root, overrides = {}) {
  return {
    root,
    workerPermission: "workspace-write",
    capabilities: discoverVerificationCapabilities(),
    ...overrides,
  };
}

// ---- INV-2 · 권한 봉쇄 ----

test("검증 권한은 어떤 worker 권한이어도 write를 넘지 않는다", () => {
  assert.equal(verificationPermissionFor("workspace-write"), VERIFICATION_MAX_PERMISSION);
  assert.equal(verificationPermissionFor("workspace-read"), "workspace-read");
  // worker가 더 낮으면 그 이하를 따른다(검증이 worker보다 강해질 수 없다).
  assert.equal(verificationPermissionFor("chat"), "chat");
  assert.equal(verificationPermissionFor("unknown"), null);
  assert.equal(verificationPermissionFor(undefined), null);
});

test("worker 권한을 계산할 수 없으면 실행하지 않는다", () => {
  const root = tempRoot();
  try {
    const got = admitVerificationStep({ executable: process.execPath }, context(root, { workerPermission: null }));
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.PRIVILEGE_DENIED);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("실행 결과에 검증 권한이 기록된다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "process.exit(0);");
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.ok, true);
    assert.equal(result.permission, VERIFICATION_MAX_PERMISSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- R-1 · controlClass는 계산된다 ----

test("controlClass는 선언이 아니라 backend의 실제 통제 특성에서 나온다", () => {
  assert.equal(
    computeControlClass({ backend: "artifact-predicate", contained: true }),
    CONTROL_CLASS.ENFORCEABLE
  );
  assert.equal(computeControlClass({ backend: "process", contained: true }), CONTROL_CLASS.OBSERVABLE);
  // 모르는 backend를 위로 올리지 않는다(fail-closed floor).
  assert.equal(computeControlClass({ backend: "magic", contained: true }), CONTROL_CLASS.NEITHER);
  assert.equal(computeControlClass({ backend: "process", contained: false }), CONTROL_CLASS.NEITHER);
});

test("subprocess 검증은 OBSERVABLE로 기록된다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "process.exit(0);");
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.controlClass, CONTROL_CLASS.OBSERVABLE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("admission 실패는 NEITHER로 남는다", async () => {
  const root = tempRoot();
  try {
    const result = await runVerificationProcess({ executable: "" }, context(root));
    assert.equal(result.ok, false);
    assert.equal(result.controlClass, CONTROL_CLASS.NEITHER);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Runner contract ----

test("셸 문자열을 실행 선언에 밀어 넣을 수 없다", () => {
  const root = tempRoot();
  try {
    for (const executable of ["node check.js && rm -rf /", "node; echo hi", "node | tee x"]) {
      const got = admitVerificationStep({ executable }, context(root));
      assert.equal(got.ok, false, executable);
      assert.equal(got.code, RUNNER_ERRORS.INVALID_SPEC);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("셸 자체를 검증 실행 파일로 쓸 수 없다", () => {
  const root = tempRoot();
  try {
    for (const shell of ["cmd.exe", "CMD.EXE", "powershell.exe", "pwsh", "bash", "sh", "zsh"]) {
      const got = admitVerificationStep({ executable: shell }, context(root));
      assert.equal(got.ok, false, shell);
      assert.equal(got.code, RUNNER_ERRORS.SHELL_EXECUTABLE, shell);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("셸의 절대경로로 우회할 수 없다", () => {
  const root = tempRoot();
  try {
    const shellPath = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
      : "/bin/sh";
    if (fs.existsSync(shellPath)) {
      const got = admitVerificationStep({ executable: shellPath }, context(root));
      assert.equal(got.ok, false);
      assert.equal(got.code, RUNNER_ERRORS.SHELL_EXECUTABLE);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("줄바꿈이 섞인 인자는 거부한다", () => {
  const root = tempRoot();
  try {
    const got = admitVerificationStep(
      { executable: process.execPath, argv: ["ok", "bad\nvalue"] },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.INVALID_SPEC);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("작업 폴더 밖에서는 실행하지 않는다", () => {
  const root = tempRoot();
  try {
    const got = admitVerificationStep(
      { executable: process.execPath, cwd: path.join("..", "..") },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.CWD_OUTSIDE_ROOT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("승인된 스크립트는 경로가 아니라 내용으로 고정된다", () => {
  const root = tempRoot();
  try {
    const scriptPath = path.join(root, "verify.js");
    fs.writeFileSync(scriptPath, "process.exit(0);");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(scriptPath)).digest("hex");

    const ok = admitVerificationStep(
      { executable: process.execPath, argv: [scriptPath], scriptPath: "verify.js", scriptSha256: digest },
      context(root)
    );
    assert.equal(ok.ok, true);

    // 승인 이후 내용이 바뀌면 그것은 승인받은 검사가 아니다.
    fs.writeFileSync(scriptPath, "process.exit(1);");
    const tampered = admitVerificationStep(
      { executable: process.execPath, argv: [scriptPath], scriptPath: "verify.js", scriptSha256: digest },
      context(root)
    );
    assert.equal(tampered.ok, false);
    assert.equal(tampered.code, RUNNER_ERRORS.SCRIPT_DIGEST_MISMATCH);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("동결 해시 없는 스크립트는 실행하지 않는다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "verify.js"), "process.exit(0);");
    const got = admitVerificationStep(
      { executable: process.execPath, scriptPath: "verify.js" },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.INVALID_SPEC);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("argv의 workspace 파일은 frozenFiles 없이 실행할 수 없다", () => {
  const root = tempRoot();
  try {
    const script = path.join(root, "check.js");
    fs.writeFileSync(script, "process.exit(0);");
    const got = admitVerificationStep(
      { executable: process.execPath, argv: [script] },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.INVALID_SPEC);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frozenFiles로 해시를 선언하면 argv의 workspace 파일을 실행할 수 있다", async () => {
  const root = tempRoot();
  try {
    const code = "process.exit(0);";
    const script = path.join(root, "check.js");
    fs.writeFileSync(script, code);
    const digest = crypto.createHash("sha256").update(Buffer.from(code)).digest("hex");
    const result = await runVerificationProcess(
      { executable: process.execPath, argv: [script], frozenFiles: { [script]: digest } },
      context(root)
    );
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("argv의 workspace 파일이 승인 후 바뀌면 실행을 거부한다", () => {
  const root = tempRoot();
  try {
    const script = path.join(root, "check.js");
    fs.writeFileSync(script, "process.exit(0);");
    const digest = crypto.createHash("sha256").update(Buffer.from("process.exit(0);")).digest("hex");
    fs.writeFileSync(script, "process.exit(1);");
    const got = admitVerificationStep(
      { executable: process.execPath, argv: [script], frozenFiles: { [script]: digest } },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.SCRIPT_DIGEST_MISMATCH);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("이 PC에 없는 검증 프로그램은 실행 전에 막는다", () => {
  const root = tempRoot();
  try {
    const got = admitVerificationStep(
      { executable: "agora-definitely-not-a-real-tool-xyz" },
      context(root)
    );
    assert.equal(got.ok, false);
    assert.equal(got.code, RUNNER_ERRORS.EXECUTABLE_UNAVAILABLE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("검증기에게 process.env를 통째로 넘기지 않는다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(
      root,
      "console.log(JSON.stringify({ secret: process.env.AGORA_TEST_SECRET || null, path: Boolean(process.env.PATH || process.env.Path) }));"
    );
    const result = await runVerificationProcess(
      spec,
      context(root, { env: { ...process.env, AGORA_TEST_SECRET: "leaked-token" } })
    );
    assert.equal(result.ok, true);
    const seen = JSON.parse(result.stdout.trim());
    assert.equal(seen.secret, null, "allowlist 밖 환경변수가 새어 나갔다");
    assert.equal(seen.path, true, "실행에 필요한 최소 환경은 전달되어야 한다");
    assert.ok(DEFAULT_ENV_ALLOWLIST.includes("PATH"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("선언하면 추가 환경변수를 전달한다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "console.log(process.env.AGORA_TEST_ALLOWED || 'none');", {
      envNames: ["AGORA_TEST_ALLOWED"],
    });
    const result = await runVerificationProcess(
      spec,
      context(root, { env: { ...process.env, AGORA_TEST_ALLOWED: "declared" } })
    );
    assert.equal(result.stdout.trim(), "declared");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exit code와 출력을 사실로 포착한다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "console.log('out'); console.error('err'); process.exit(3);");
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.ok, true, "실행 자체는 성공이다(판정은 D-A2의 몫)");
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /out/);
    assert.match(result.stderr, /err/);
    assert.ok(Number.isFinite(result.durationMs));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("출력이 상한을 넘으면 잘라내고 사실로 표시한다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "process.stdout.write('x'.repeat(2 * 1024 * 1024));");
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 256 * 1024);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("멈춘 검증은 timeout으로 끝나고 결과가 성공으로 승격되지 않는다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "setInterval(() => {}, 1000);", { timeoutMs: 400 });
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_ERRORS.TIMEOUT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- side-effect accounting ----

test("검증 실행이 남긴 변경을 사실로 분리해 남긴다", async () => {
  const root = tempRoot();
  try {
    const deliverable = path.join(root, "result.txt");
    fs.writeFileSync(deliverable, "original");
    const { spec } = nodeSpec(
      root,
      `require("node:fs").writeFileSync(${JSON.stringify(deliverable)}, "verifier touched this");`
    );
    const result = await runVerificationProcess(
      spec,
      context(root, { sideEffectScope: ["result.txt"] })
    );
    assert.equal(result.sideEffects.accounted, true);
    assert.deepEqual(result.sideEffects.changedPaths, ["result.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("아무것도 건드리지 않은 검증은 변경 없음으로 남는다", async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "result.txt"), "original");
    const { spec } = nodeSpec(root, "process.exit(0);");
    const result = await runVerificationProcess(
      spec,
      context(root, { sideEffectScope: ["result.txt"] })
    );
    assert.deepEqual(result.sideEffects.changedPaths, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("대조 범위가 없으면 회계되지 않았다고 정직하게 표시한다", async () => {
  const root = tempRoot();
  try {
    const { spec } = nodeSpec(root, "process.exit(0);");
    const result = await runVerificationProcess(spec, context(root));
    assert.equal(result.sideEffects.accounted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("지문은 생성·삭제·수정을 모두 잡고 폴더 밖은 보지 않는다", () => {
  const root = tempRoot();
  try {
    const kept = path.join(root, "kept.txt");
    const removed = path.join(root, "removed.txt");
    fs.writeFileSync(kept, "same");
    fs.writeFileSync(removed, "bye");
    const before = fingerprintPaths(root, ["kept.txt", "removed.txt", "created.txt", "../outside.txt"]);
    assert.equal(before["created.txt"], null, "없던 파일은 null로 표현한다");
    assert.equal(Object.hasOwn(before, "../outside.txt"), false, "작업 폴더 밖은 대조 대상이 아니다");

    fs.rmSync(removed);
    fs.writeFileSync(path.join(root, "created.txt"), "new");
    const after = fingerprintPaths(root, ["kept.txt", "removed.txt", "created.txt"]);
    assert.deepEqual(diffFingerprints(before, after), ["created.txt", "removed.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
