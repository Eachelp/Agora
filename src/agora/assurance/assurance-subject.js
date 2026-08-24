"use strict";

// Stage D-A2 — Assurance Subject (INV-5)
//
// 검사를 동결하는 것(INV-1)만으로는 부족하다. **검사받은 결과물 자체가 판정과
// 묶여야 한다.** Builder 종료 시 실제 결과물의 fingerprint 집합을 확정하고,
// 이후 모든 판정(criterion 결과 · Reviewer 판정 · Human approval · Final
// disposition)이 이 ref에 귀속된다.
//
//   subject 범위 = 선언된 Deliverables
//                + checkpoint 이후 관측된 변경 집합
//                - Agora가 관리하는 run/checkpoint/provenance artifact
//
// 재확인은 지속 감시가 아니라 **각 판정을 확정하는 경계 직전**에 한다. subject가
// 바뀌었으면 기존 판정은 INVALIDATED되고 재검사가 필요하다. D-0 lease가 막지
// 못하는 변경(외부 에디터, lease 경계 밖 프로세스)도 이 계약이 잡는다.
//
// Git은 optional adapter다. non-Git workspace에서도 Deliverables 지문은 그대로
// 뜬다 — 변경 집합만 관측되지 않을 뿐이며 그 사실을 정직하게 기록한다.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SUBJECT_SCHEMA_VERSION = 1;

// Agora 자신이 만드는 기록물. 결과물이 아니므로 subject에서 제외한다.
// 이것을 빼지 않으면 evidence를 쓰는 행위가 subject를 바꿔 자기 자신을
// INVALIDATED시킨다.
const DEFAULT_EXCLUDED_PREFIXES = Object.freeze([
  ".project-memory/runs",
  ".project-memory/checkpoints",
  ".agora",
]);

const MAX_SUBJECT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SUBJECT_ENTRIES = 5000;

function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeRel(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || raw.includes("\0")) return null;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  return normalized;
}

function isExcluded(rel, excludedPrefixes) {
  const lower = rel.toLowerCase();
  return excludedPrefixes.some((prefix) => {
    const p = prefix.toLowerCase().replace(/\\/g, "/");
    return lower === p || lower.startsWith(`${p}/`);
  });
}

function fingerprintOne(root, rel) {
  const abs = path.resolve(root, rel);
  const realRoot = realOrResolved(root);
  const realAbs = realOrResolved(abs);
  const a = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  const b = process.platform === "win32" ? realAbs.toLowerCase() : realAbs;
  if (b !== a && !b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`)) {
    return { state: "OUTSIDE", sha256: null, size: null };
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { state: "ABSENT", sha256: null, size: null };
  }
  if (stat.isDirectory()) return { state: "DIRECTORY", sha256: null, size: null };
  if (!stat.isFile()) return { state: "UNSUPPORTED", sha256: null, size: null };
  if (stat.size > MAX_SUBJECT_FILE_BYTES) {
    return { state: "UNSUPPORTED", sha256: null, size: stat.size, reason: "too-large" };
  }
  try {
    return {
      state: "PRESENT",
      sha256: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
      size: stat.size,
    };
  } catch {
    return { state: "UNSUPPORTED", sha256: null, size: stat.size, reason: "unreadable" };
  }
}

// Builder 종료 시점의 결과물 스냅샷.
//
// deliverables  Frozen Task가 선언한 산출물(계약상 반드시 봐야 하는 것)
// changedPaths  checkpoint 이후 관측된 변경(있으면; Git 없으면 빈 배열)
function createAssuranceSubject(options = {}) {
  const root = options.root ? realOrResolved(options.root) : null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const excludedPrefixes = [
    ...DEFAULT_EXCLUDED_PREFIXES,
    ...(Array.isArray(options.excludedPrefixes) ? options.excludedPrefixes : []),
  ];

  const declared = [];
  for (const item of options.deliverables || []) {
    const locator = typeof item === "string" ? item : item?.locator;
    // URL 산출물은 Agora가 지문을 뜰 수 없다. 조용히 빼지 않고 남긴다.
    if (typeof item === "object" && item?.kind === "url") {
      declared.push({ path: String(locator || ""), origin: "deliverable", state: "UNSUPPORTED", sha256: null, size: null, reason: "url" });
      continue;
    }
    const rel = normalizeRel(locator);
    if (!rel) continue;
    declared.push({ path: rel, origin: "deliverable" });
  }

  const observed = [];
  for (const entry of options.changedPaths || []) {
    const rel = normalizeRel(typeof entry === "string" ? entry : entry?.path);
    if (!rel) continue;
    if (isExcluded(rel, excludedPrefixes)) continue;
    observed.push({ path: rel, origin: "observed-change" });
  }

  // 선언된 산출물이 우선한다. 같은 경로가 양쪽에 있으면 deliverable로 본다.
  const merged = new Map();
  for (const entry of [...declared, ...observed]) {
    if (!merged.has(entry.path)) merged.set(entry.path, entry);
  }

  const entries = [];
  let truncated = false;
  for (const entry of merged.values()) {
    if (entries.length >= MAX_SUBJECT_ENTRIES) {
      truncated = true;
      break;
    }
    if (entry.state) {
      entries.push(entry);
      continue;
    }
    entries.push({ ...entry, ...(root ? fingerprintOne(root, entry.path) : { state: "UNSUPPORTED", sha256: null, size: null, reason: "no-workspace" }) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const subject = {
    schemaVersion: SUBJECT_SCHEMA_VERSION,
    boundRunId: options.runId || null,
    createdAt: now,
    // 변경 관측이 지원되지 않는 workspace였는지를 남긴다(non-Git 등).
    changeObservation: options.changeObservation || "unknown",
    excludedPrefixes,
    truncated,
    entries,
  };
  subject.assuranceSubjectRef = `subj-${crypto
    .createHash("sha256")
    .update(JSON.stringify(entries.map((e) => [e.path, e.state, e.sha256])))
    .digest("hex")
    .slice(0, 32)}`;
  return subject;
}

// 판정 확정 경계 직전 재확인. 지속 watcher가 아니다.
function recheckSubject(subject, options = {}) {
  const root = options.root ? realOrResolved(options.root) : null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const changed = [];

  for (const entry of subject?.entries || []) {
    // 애초에 지문을 못 뜬 항목은 확정된 판정의 근거가 아니므로 대조 대상이 아니다.
    if (entry.state !== "PRESENT" && entry.state !== "ABSENT") continue;

    const current = root
      ? fingerprintOne(root, entry.path)
      : { state: "UNSUPPORTED", sha256: null, reason: "no-workspace" };

    // **"같다고 확인하지 못함"을 "같음"으로 취급하지 않는다(INV-5).**
    // 판정 당시 읽혔던 산출물이 지금 읽히지 않는다면, 그 판정이 여전히 그
    // 결과물에 귀속된다고 말할 근거가 없다.
    if (current.state === "UNSUPPORTED" || current.state === "OUTSIDE" || current.state === "DIRECTORY") {
      changed.push({
        path: entry.path,
        was: entry.state,
        now: current.state,
        expectedSha256: entry.sha256,
        actualSha256: null,
        unverifiable: true,
        reason: current.reason || current.state,
      });
      continue;
    }

    if (current.state !== entry.state || current.sha256 !== entry.sha256) {
      changed.push({
        path: entry.path,
        was: entry.state,
        now: current.state,
        expectedSha256: entry.sha256,
        actualSha256: current.sha256,
      });
    }
  }

  return {
    checkedAt: now,
    ok: changed.length === 0,
    assuranceSubjectRef: subject?.assuranceSubjectRef || null,
    changed,
  };
}

// subject가 바뀌었을 때 만드는 새 스냅샷. 기존 subject를 수정하지 않는다(R-8).
function resnapshotSubject(subject, options = {}) {
  return createAssuranceSubject({
    root: options.root,
    now: options.now,
    runId: subject?.boundRunId || options.runId || null,
    changeObservation: options.changeObservation || subject?.changeObservation || "unknown",
    excludedPrefixes: (subject?.excludedPrefixes || []).filter(
      (p) => !DEFAULT_EXCLUDED_PREFIXES.includes(p)
    ),
    deliverables: (subject?.entries || [])
      .filter((e) => e.origin === "deliverable")
      .map((e) => e.path),
    changedPaths: (subject?.entries || [])
      .filter((e) => e.origin === "observed-change")
      .map((e) => e.path),
  });
}

function summarizeSubject(subject) {
  const counts = { present: 0, absent: 0, unsupported: 0 };
  for (const entry of subject?.entries || []) {
    if (entry.state === "PRESENT") counts.present += 1;
    else if (entry.state === "ABSENT") counts.absent += 1;
    else counts.unsupported += 1;
  }
  return {
    assuranceSubjectRef: subject?.assuranceSubjectRef || null,
    total: subject?.entries?.length || 0,
    ...counts,
    changeObservation: subject?.changeObservation || "unknown",
    truncated: Boolean(subject?.truncated),
  };
}

module.exports = {
  SUBJECT_SCHEMA_VERSION,
  DEFAULT_EXCLUDED_PREFIXES,
  MAX_SUBJECT_ENTRIES,
  createAssuranceSubject,
  recheckSubject,
  resnapshotSubject,
  summarizeSubject,
  normalizeRel,
};
