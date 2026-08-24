"use strict";

// Stage D-A1 — Input Binding (frozen / live)
//
// Charter §3.1의 의미 계약을 코드로 만든다.
//
//   frozen  "동일한 입력이어야 한다."
//           freeze 시 fingerprint를 남기고, Builder admission 직전과 Final PASS
//           직전에 재대조한다. 불일치면 실행하지 않고 REPLAN / 재승인으로 보낸다.
//
//   live    "달라도 되지만 실제로 무엇을 썼는지는 남긴다."
//           freeze hash를 강제하지 않는다. 대신 retrieval마다 언제·무엇을
//           가져왔는지 기록한다.
//
// **fingerprint를 기록만 하는 것은 frozen이 아니다.** 재대조가 있어야 frozen이다
// (charter v0.3에서 사용자가 명시한 지점).
//
// 범위 밖: 네트워크 fetch 자체(Agora는 입력을 대신 가져오지 않는다 — retrieval
// metadata를 받아 기록할 뿐이다), live 입력의 내용 검증(REVIEW_REQUIRED).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INPUT_BINDING_SCHEMA_VERSION = 1;

const BINDING_STATES = Object.freeze({
  BOUND: "BOUND",           // frozen: fingerprint 확보
  MISSING: "MISSING",       // frozen인데 대상이 없다
  UNBOUND: "UNBOUND",       // live: freeze hash 없음(정상)
  UNSUPPORTED: "UNSUPPORTED", // fingerprint를 뜰 수 없는 대상
});

const RECHECK_RESULTS = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  DISAPPEARED: "DISAPPEARED",
  APPEARED: "APPEARED",
  SKIPPED: "SKIPPED", // live 입력은 재대조 대상이 아니다
  // frozen인데 같은지 확인할 수단이 없다. SKIPPED와 구분한다 —
  // "볼 필요가 없다"와 "봐야 하는데 못 봤다"는 다른 사실이다.
  UNVERIFIABLE: "UNVERIFIABLE",
});

const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;

function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInside(root, target) {
  const a = realOrResolved(root);
  const b = realOrResolved(target);
  const na = process.platform === "win32" ? a.toLowerCase() : a;
  const nb = process.platform === "win32" ? b.toLowerCase() : b;
  return nb === na || nb.startsWith(na.endsWith(path.sep) ? na : `${na}${path.sep}`);
}

// 파일 하나의 지문. 크기와 내용 해시를 함께 남긴다.
// 디렉터리는 지원하지 않는다 — 재귀 해시는 비용이 크고, 무엇이 바뀌었는지
// 설명하지 못한다. 필요하면 Plan이 파일을 개별 선언한다.
function fingerprintFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { state: BINDING_STATES.MISSING, sha256: null, size: null };
  }
  if (stat.isDirectory()) {
    return { state: BINDING_STATES.UNSUPPORTED, sha256: null, size: null, reason: "directory" };
  }
  if (!stat.isFile()) {
    return { state: BINDING_STATES.UNSUPPORTED, sha256: null, size: null, reason: "not-a-regular-file" };
  }
  if (stat.size > MAX_FINGERPRINT_BYTES) {
    return { state: BINDING_STATES.UNSUPPORTED, sha256: null, size: stat.size, reason: "too-large" };
  }
  try {
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
    return { state: BINDING_STATES.BOUND, sha256, size: stat.size };
  } catch {
    return { state: BINDING_STATES.UNSUPPORTED, sha256: null, size: stat.size, reason: "unreadable" };
  }
}

// 승인·동결 시점의 입력 결합. frozen 입력만 지문을 뜬다.
function bindInputs(inputs = [], context = {}) {
  const root = context.root ? realOrResolved(context.root) : null;
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const bindings = [];

  for (const input of inputs) {
    if (!input || !input.locator) continue;
    const base = {
      inputId: input.inputId,
      locator: input.locator,
      kind: input.kind,
      mode: input.mode,
      boundAt: now,
    };

    if (input.mode !== "frozen") {
      // live 입력은 지문을 강제하지 않는다. 실제 사용 기록은 retrieval에서 남는다.
      bindings.push({ ...base, state: BINDING_STATES.UNBOUND, sha256: null, size: null, retrievals: [] });
      continue;
    }

    if (input.kind === "url") {
      // frozen으로 선언된 URL은 Agora가 내용을 고정할 수단이 없다.
      // 조용히 live로 바꾸지 않고 지원 불가로 남긴다(정직한 강등).
      bindings.push({
        ...base,
        state: BINDING_STATES.UNSUPPORTED,
        sha256: null,
        size: null,
        reason: "frozen-url-unsupported",
        retrievals: [],
      });
      continue;
    }

    if (!root) {
      bindings.push({ ...base, state: BINDING_STATES.UNSUPPORTED, sha256: null, size: null, reason: "no-workspace" });
      continue;
    }
    const abs = path.resolve(root, input.locator);
    if (!isInside(root, abs)) {
      bindings.push({ ...base, state: BINDING_STATES.UNSUPPORTED, sha256: null, size: null, reason: "outside-workspace" });
      continue;
    }
    bindings.push({ ...base, ...fingerprintFile(abs) });
  }

  return {
    schemaVersion: INPUT_BINDING_SCHEMA_VERSION,
    boundAt: now,
    bindings,
    // frozen인데 대상이 없으면 그 자체가 계약 문제다. 승인 화면이 알아야 한다.
    missingFrozen: bindings.filter((b) => b.mode === "frozen" && b.state === BINDING_STATES.MISSING)
      .map((b) => b.locator),
    // frozen인데 지문을 뜰 수 없는 입력. 재대조가 불가능하므로 frozen 계약을
    // 실제로 보증할 수 없다 — 계약 단계에서 걸러야 한다.
    unboundFrozen: bindings
      .filter((b) => b.mode === "frozen" && b.state === BINDING_STATES.UNSUPPORTED)
      .map((b) => ({ inputId: b.inputId, locator: b.locator, reason: b.reason || "unsupported" })),
  };
}

// Builder admission 직전 / Final PASS 직전 재대조.
// 이 함수가 없으면 fingerprint는 장식이고 frozen은 이름뿐이다.
function recheckFrozenInputs(binding, context = {}) {
  const root = context.root ? realOrResolved(context.root) : null;
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const results = [];

  for (const bound of binding?.bindings || []) {
    if (bound.mode !== "frozen") {
      results.push({ inputId: bound.inputId, locator: bound.locator, result: RECHECK_RESULTS.SKIPPED });
      continue;
    }
    // frozen 입력에 대해 "같다고 확인하지 못함"을 "같음"으로 취급하지 않는다.
    // 계약 단계(buildFrozenContract)가 이런 입력을 이미 거르지만, 저장된 계약을
    // 다시 읽는 경로에서도 같은 규칙이 서야 한다.
    if (bound.state === BINDING_STATES.UNSUPPORTED) {
      results.push({
        inputId: bound.inputId,
        locator: bound.locator,
        result: RECHECK_RESULTS.UNVERIFIABLE,
        reason: bound.reason || "unsupported",
      });
      continue;
    }
    if (!root) {
      results.push({ inputId: bound.inputId, locator: bound.locator, result: RECHECK_RESULTS.UNVERIFIABLE, reason: "no-workspace" });
      continue;
    }
    const abs = path.resolve(root, bound.locator);
    if (!isInside(root, abs)) {
      results.push({ inputId: bound.inputId, locator: bound.locator, result: RECHECK_RESULTS.UNVERIFIABLE, reason: "outside-workspace" });
      continue;
    }
    const current = fingerprintFile(abs);
    if (current.state === BINDING_STATES.UNSUPPORTED) {
      // 승인 시점에는 읽혔는데 지금은 읽을 수 없다. 같다고 말할 근거가 없다.
      results.push({
        inputId: bound.inputId,
        locator: bound.locator,
        result: RECHECK_RESULTS.UNVERIFIABLE,
        reason: current.reason || "unsupported",
        expected: bound.sha256,
      });
      continue;
    }

    if (bound.state === BINDING_STATES.MISSING) {
      // 없던 입력이 생겼다. 이것도 "승인 시점과 다른 입력"이다.
      results.push({
        inputId: bound.inputId,
        locator: bound.locator,
        result: current.state === BINDING_STATES.MISSING ? RECHECK_RESULTS.MATCH : RECHECK_RESULTS.APPEARED,
        expected: null,
        actual: current.sha256,
      });
      continue;
    }
    if (current.state === BINDING_STATES.MISSING) {
      results.push({
        inputId: bound.inputId,
        locator: bound.locator,
        result: RECHECK_RESULTS.DISAPPEARED,
        expected: bound.sha256,
        actual: null,
      });
      continue;
    }
    results.push({
      inputId: bound.inputId,
      locator: bound.locator,
      result: current.sha256 === bound.sha256 ? RECHECK_RESULTS.MATCH : RECHECK_RESULTS.MISMATCH,
      expected: bound.sha256,
      actual: current.sha256,
    });
  }

  const changed = results.filter((r) =>
    r.result === RECHECK_RESULTS.MISMATCH ||
    r.result === RECHECK_RESULTS.DISAPPEARED ||
    r.result === RECHECK_RESULTS.APPEARED ||
    // 확인하지 못한 것을 통과로 세지 않는다.
    r.result === RECHECK_RESULTS.UNVERIFIABLE
  );

  return {
    checkedAt: now,
    ok: changed.length === 0,
    results,
    changed: changed.map((r) => ({ inputId: r.inputId, locator: r.locator, result: r.result })),
  };
}

// live 입력의 실제 사용 기록. 호출자가 retrieval metadata를 주면 append한다.
// Agora가 대신 fetch하지 않는다 — 무엇을 썼는지 사실만 받아 남긴다.
function recordLiveRetrieval(binding, inputId, metadata = {}) {
  const target = (binding?.bindings || []).find((b) => b.inputId === inputId);
  if (!target) return { ok: false, error: `알 수 없는 입력입니다: ${inputId}` };
  if (target.mode !== "live") {
    return { ok: false, error: `live 입력이 아닙니다: ${inputId}` };
  }
  const entry = {
    retrievedAt: Number.isFinite(metadata.retrievedAt) ? metadata.retrievedAt : Date.now(),
    version: metadata.version != null ? String(metadata.version).slice(0, 200) : null,
    etag: metadata.etag != null ? String(metadata.etag).slice(0, 200) : null,
    contentHash: metadata.contentHash != null ? String(metadata.contentHash).slice(0, 128) : null,
    note: metadata.note != null ? String(metadata.note).slice(0, 500) : null,
    // 이 기록이 어떻게 생겼는가. Agora 자신의 관측과 외부 보고를 섞지 않는다.
    //   workspace-observation  실행 시점에 Agora가 직접 본 파일 내용
    //   reported               외부(도구·에이전트)가 보고한 metadata
    basis: metadata.basis === "workspace-observation" ? "workspace-observation" : "reported",
  };
  if (!Array.isArray(target.retrievals)) target.retrievals = [];
  target.retrievals.push(entry);
  return { ok: true, entry };
}

module.exports = {
  INPUT_BINDING_SCHEMA_VERSION,
  BINDING_STATES,
  RECHECK_RESULTS,
  fingerprintFile,
  bindInputs,
  recheckFrozenInputs,
  recordLiveRetrieval,
};
