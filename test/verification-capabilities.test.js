"use strict";

// Stage D-A0 — Runtime capability discovery.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md D-A0 · INV-3):
//   - Node 기본으로 되는 산출물 능력만 AVAILABLE로 시작한다(A안).
//   - 동봉하지 않은 형식(xlsx/docx/pdf)을 AVAILABLE로 가장하지 않는다.
//   - process 능력에는 언어 목록이 없다. 선언된 실행 파일의 존재만 확인한다.
//   - 능력 확인은 프로그램을 실행하지 않는다(확인 자체가 부수효과가 되면 안 된다).
//   - 같은 실행 안에서 능력 판정이 흔들리지 않게 스냅샷으로 고정한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AVAILABLE,
  UNAVAILABLE,
  discoverVerificationCapabilities,
  capabilityState,
  hasCapability,
  ensureExecutable,
  resolveExecutable,
  summarizeCapabilities,
} = require("../src/agora/verification-capabilities");

function snapshot(options = {}) {
  let t = 0;
  return discoverVerificationCapabilities({ now: () => (t += 1), ...options });
}

test("Node 기본으로 되는 산출물 능력은 AVAILABLE이다", () => {
  const snap = snapshot();
  for (const name of ["artifact.exists", "artifact.hash", "artifact.text", "artifact.json", "artifact.csv"]) {
    assert.equal(capabilityState(snap, name), AVAILABLE, name);
  }
  assert.equal(hasCapability(snap, "process.exec"), true);
});

test("동봉하지 않은 형식은 UNAVAILABLE로 정직하게 시작한다", () => {
  const snap = snapshot();
  for (const name of ["artifact.xlsx", "artifact.docx", "artifact.pdf"]) {
    assert.equal(capabilityState(snap, name), UNAVAILABLE, name);
  }
});

test("실제로 동봉되면 그때 AVAILABLE로 올라간다", () => {
  const snap = snapshot({ bundledArtifacts: ["artifact.xlsx"] });
  assert.equal(capabilityState(snap, "artifact.xlsx"), AVAILABLE);
  // 동봉하지 않은 나머지는 그대로 UNAVAILABLE이다.
  assert.equal(capabilityState(snap, "artifact.pdf"), UNAVAILABLE);
});

test("알 수 없는 능력은 AVAILABLE로 추정하지 않는다", () => {
  const snap = snapshot();
  assert.equal(capabilityState(snap, "artifact.psd"), UNAVAILABLE);
  assert.equal(capabilityState(snap, ""), UNAVAILABLE);
  assert.equal(capabilityState(null, "artifact.text"), UNAVAILABLE);
});

test("스냅샷은 실행 1회를 고정한다", () => {
  const snap = snapshot();
  assert.match(snap.snapshotId, /^vcap-/);
  assert.ok(Number.isFinite(snap.createdAt));
  // capabilities는 얼어 있어 실행 도중 바뀌지 않는다.
  assert.throws(() => {
    "use strict";
    snap.capabilities["artifact.pdf"] = AVAILABLE;
  });
});

// ---- process 능력: 언어 목록이 아니라 선언된 실행 파일 확인 ----

test("선언된 실행 파일의 존재만 확인한다", () => {
  const snap = snapshot();
  const nodeEntry = ensureExecutable(snap, process.execPath);
  assert.equal(nodeEntry.state, AVAILABLE);
  assert.ok(nodeEntry.resolvedPath);

  const missing = ensureExecutable(snap, "agora-definitely-not-a-real-tool-xyz");
  assert.equal(missing.state, UNAVAILABLE);
  assert.equal(missing.resolvedPath, null);
});

test("같은 실행 안에서 같은 실행 파일은 같은 판정을 유지한다", () => {
  const snap = snapshot();
  const first = ensureExecutable(snap, process.execPath);
  const second = ensureExecutable(snap, process.execPath);
  assert.equal(first, second, "판정이 실행 도중 흔들리면 안 된다");
});

test("확인은 프로그램을 실행하지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-vcap-"));
  const marker = path.join(dir, "ran.txt");
  const script = path.join(dir, process.platform === "win32" ? "probe.bat" : "probe.sh");
  fs.writeFileSync(
    script,
    process.platform === "win32" ? `@echo ran > "${marker}"\n` : `#!/bin/sh\necho ran > "${marker}"\n`
  );
  if (process.platform !== "win32") fs.chmodSync(script, 0o755);
  try {
    const snap = snapshot();
    const entry = ensureExecutable(snap, script);
    assert.equal(entry.state, AVAILABLE);
    assert.equal(fs.existsSync(marker), false, "능력 확인이 프로그램을 실행했다");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveExecutable은 PATH와 절대경로를 모두 다룬다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-vcap-path-"));
  const name = process.platform === "win32" ? "agora-probe.bat" : "agora-probe";
  const file = path.join(dir, name);
  fs.writeFileSync(file, "");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  try {
    assert.ok(resolveExecutable(file), "절대경로");
    const viaPath = resolveExecutable(process.platform === "win32" ? "agora-probe" : "agora-probe", {
      env: { PATH: dir, PATHEXT: ".BAT;.EXE" },
      platform: process.platform,
    });
    assert.ok(viaPath, "PATH 탐색");
    assert.equal(resolveExecutable("", { env: { PATH: dir } }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("디렉터리는 실행 파일로 인정하지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-vcap-dir-"));
  try {
    assert.equal(resolveExecutable(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("요약은 무엇이 왜 가능/불가능했는지 기록에 남긴다", () => {
  const snap = snapshot();
  ensureExecutable(snap, "agora-definitely-not-a-real-tool-xyz");
  const summary = summarizeCapabilities(snap);
  assert.equal(summary.snapshotId, snap.snapshotId);
  assert.equal(summary.capabilities["artifact.csv"], AVAILABLE);
  assert.equal(summary.capabilities["artifact.xlsx"], UNAVAILABLE);
  assert.equal(summary.executables["agora-definitely-not-a-real-tool-xyz"], UNAVAILABLE);
});
