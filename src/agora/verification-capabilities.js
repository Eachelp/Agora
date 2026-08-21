"use strict";

// Stage D-A0 — Runtime capability discovery
//
// "이 PC에서 Agora가 실제로 확정할 수 있는 검사가 무엇인가"를 실측한다.
// Charter의 요구는 능력을 늘리는 것이 아니라 **과장하지 않는 것**이다(INV-3).
// 확정할 수 없는 검사는 VERIFIED로 가장하지 않고 판단 주체를 바꿔 보낸다.
//
// 능력은 성격이 다른 둘로 나뉜다.
//
//   artifact.*  Agora 자신이 산출물을 열어 술어를 평가할 수 있는가.
//               외부 런타임이 아니라 Agora가 무엇을 들고 다니는지가 정한다.
//               초기 범위(A안)는 Node 기본으로 되는 것까지다. xlsx/docx/pdf는
//               라이브러리를 동봉해야 하므로 UNAVAILABLE로 시작한다.
//
//   process.*   선언된 실행 파일을 돌릴 수 있는가.
//               여기에는 언어 목록이 없다. Verification Plan이 executable을
//               선언하면 그것이 이 PC에 있는지 확인할 뿐이며, Agora가 특정
//               언어·도구를 특별 취급하지 않는다(도메인 지식은 Task가 공급한다).
//
// 범위 밖(넣지 않음): 검사 실행 자체(runner), disposition 결정(D-A2 router),
// 형식 파서 동봉, 능력 확장을 위한 외부 도구 설치.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const AVAILABLE = "AVAILABLE";
const UNAVAILABLE = "UNAVAILABLE";

// Node 기본으로 확정 가능한 산출물 능력.
const NATIVE_ARTIFACT_CAPABILITIES = Object.freeze([
  "artifact.exists",
  "artifact.hash",
  "artifact.text",
  "artifact.json",
  "artifact.csv",
]);

// 라이브러리를 동봉해야 가능한 능력. 지금은 없다고 정직하게 말한다.
// 여기에 올리려면 실제로 열 수 있게 된 뒤여야 한다(Charter non-goal:
// "NO xlsx/docx/pdf promises before runtime capability exists").
const BUNDLED_ARTIFACT_CAPABILITIES = Object.freeze([
  "artifact.xlsx",
  "artifact.docx",
  "artifact.pdf",
]);

function cleanName(value, limit = 200) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, limit) : null;
}

// PATH 탐색은 실행하지 않고 존재만 확인한다. 능력을 알아보려고 프로그램을
// 실행하면 그 자체가 부수효과가 되고, 검증기가 worker보다 먼저 무언가를
// 실행하는 셈이 된다(INV-2).
function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const raw = cleanName(name, 4096);
  if (!raw) return null;

  const isPathish = raw.includes("/") || raw.includes("\\");
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean)
    : [""];

  const candidates = [];
  if (isPathish || path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) candidates.push(path.join(dir, raw));
  }

  for (const candidate of candidates) {
    const variants = path.extname(candidate) ? [candidate] : [candidate, ...extensions.map((ext) => candidate + ext)];
    for (const variant of variants) {
      try {
        const stat = fs.statSync(variant);
        if (stat.isFile()) return fs.realpathSync(variant);
      } catch {
        // 다음 후보로 넘어간다.
      }
    }
  }
  return null;
}

// 검증 실행 1회당 한 번 만들고, 각 step이 이 스냅샷을 참조한다.
// (step마다 다시 재면 같은 실행 안에서 능력 판정이 달라질 수 있다.)
function discoverVerificationCapabilities({
  env = process.env,
  platform = process.platform,
  now = () => Date.now(),
  bundledArtifacts = [],
} = {}) {
  const capabilities = {};
  for (const name of NATIVE_ARTIFACT_CAPABILITIES) capabilities[name] = AVAILABLE;
  const bundled = new Set(bundledArtifacts);
  for (const name of BUNDLED_ARTIFACT_CAPABILITIES) {
    capabilities[name] = bundled.has(name) ? AVAILABLE : UNAVAILABLE;
  }
  // 선언된 실행 파일을 돌릴 수 있는 능력. 어떤 실행 파일이냐는 Plan이 정한다.
  capabilities["process.exec"] = AVAILABLE;

  const createdAt = now();
  const snapshot = {
    snapshotId: `vcap-${createdAt.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    createdAt,
    platform,
    capabilities: Object.freeze({ ...capabilities }),
    // 이 스냅샷이 만들어진 뒤 확인된 실행 파일들. 어떤 step이 무엇을 요구했는지가
    // 기록에 남아야 "왜 강등됐는지"를 나중에 설명할 수 있다.
    executables: {},
  };
  return snapshot;
}

function capabilityState(snapshot, name) {
  const key = cleanName(name, 80);
  if (!snapshot || !key) return UNAVAILABLE;
  return snapshot.capabilities?.[key] === AVAILABLE ? AVAILABLE : UNAVAILABLE;
}

function hasCapability(snapshot, name) {
  return capabilityState(snapshot, name) === AVAILABLE;
}

// 선언된 실행 파일의 존재를 확인하고 결과를 스냅샷에 기록한다.
// 같은 실행 안에서 두 번 물으면 처음 결과를 그대로 돌려준다.
function ensureExecutable(snapshot, name, { env = process.env, platform = process.platform } = {}) {
  const key = cleanName(name, 4096);
  if (!snapshot || !key) return { name: key, state: UNAVAILABLE, resolvedPath: null };
  if (Object.hasOwn(snapshot.executables, key)) return snapshot.executables[key];
  const resolvedPath = resolveExecutable(key, { env, platform });
  const entry = Object.freeze({
    name: key,
    state: resolvedPath ? AVAILABLE : UNAVAILABLE,
    resolvedPath,
  });
  snapshot.executables[key] = entry;
  return entry;
}

// 기록·전달용 요약. 사용자 표면에 그대로 노출하지 않는다(Charter §9).
function summarizeCapabilities(snapshot) {
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    platform: snapshot.platform,
    capabilities: { ...snapshot.capabilities },
    executables: Object.fromEntries(
      Object.entries(snapshot.executables).map(([name, entry]) => [name, entry.state])
    ),
  };
}

module.exports = {
  AVAILABLE,
  UNAVAILABLE,
  NATIVE_ARTIFACT_CAPABILITIES,
  BUNDLED_ARTIFACT_CAPABILITIES,
  discoverVerificationCapabilities,
  capabilityState,
  hasCapability,
  ensureExecutable,
  resolveExecutable,
  summarizeCapabilities,
};
