"use strict";

// Stage D-A1 — Frozen Verification Plan
//
// Verification Plan을 자유 텍스트가 아니라 **구조화된 criterion 계약**으로 만든다.
// 자유 텍스트로 두면 "검사했다"는 주장만 남고 무엇을 검사했는지 기계가 다시
// 확인할 수 없다.
//
//   INV-1  Plan은 Task 승인 시 canonicalize + hash로 동결된다. 이후 Builder ·
//          Reviewer · auto-revision 누구도 고칠 수 없다. 바꾸려면 REPLAN이다.
//
//   INV-3  Agora가 기계적으로 확정할 수 없는 criterion은 VERIFIED가 아니라
//          REVIEW_REQUIRED / HUMAN_APPROVAL로 계획된다.
//
// 계획 표기 (Planner가 작성 — Charter §9 P-4):
//
//   ## Verification Plan
//
//   (사람이 읽을 산문은 자유롭게)
//
//   ```json
//   [
//     {"id":"V1","method":"process","statement":"전체 테스트 통과",
//      "executable":"npm","argv":["test"],"expect":{"exitCode":0}},
//     {"id":"V2","method":"predicate","statement":"보고서 존재",
//      "check":{"kind":"exists","path":"report.md"}},
//     {"id":"V3","method":"review","statement":"보고서 논조가 요구사항에 부합"},
//     {"id":"V4","method":"human","statement":"외부 발송 승인"}
//   ]
//   ```
//
// **JSON 블록이 없으면 실패시키지 않는다.** 산문 Plan 전체를 하나의 review
// criterion으로 강등하고 그 사실을 기록한다(R-4 — 검사 미정의는 차단이 아니라
// 정직한 라우팅). 여기서 fail-closed를 택하면 비코딩 과업이 실질적으로 막힌다.
//
// 범위 밖: criterion 실행(D-A2 engines), disposition 확정(D-A2 router).

const crypto = require("node:crypto");

const VERIFICATION_PLAN_SCHEMA_VERSION = 2;

const METHODS = Object.freeze({
  PROCESS: "process",
  PREDICATE: "predicate",
  REVIEW: "review",
  HUMAN: "human",
});

const DISPOSITIONS = Object.freeze({
  VERIFIED: "VERIFIED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  HUMAN_APPROVAL: "HUMAN_APPROVAL",
});

// method가 정해지면 계획 처분은 그로부터 따라온다. Plan이 임의로
// "review인데 VERIFIED" 같은 조합을 선언하지 못하게 한다.
const DEFAULT_DISPOSITION_FOR_METHOD = Object.freeze({
  [METHODS.PROCESS]: DISPOSITIONS.VERIFIED,
  [METHODS.PREDICATE]: DISPOSITIONS.VERIFIED,
  [METHODS.REVIEW]: DISPOSITIONS.REVIEW_REQUIRED,
  [METHODS.HUMAN]: DISPOSITIONS.HUMAN_APPROVAL,
});

const MAX_CRITERIA = 200;
const MAX_STATEMENT_CHARS = 500;

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function cleanText(value, limit = MAX_STATEMENT_CHARS) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, limit) : null;
}

// Verification Plan 섹션 본문에서 마지막 ```json 블록을 꺼낸다.
// 산문 안에 예시 JSON이 섞여도 실제 계획은 마지막 것으로 본다.
function extractPlanJsonBlock(body) {
  const text = String(body || "");
  const pattern = /```[ \t]*json[ \t]*\n([\s\S]*?)```/gi;
  let last = null;
  let match;
  while ((match = pattern.exec(text)) !== null) last = match[1];
  return last;
}

function normalizeMethod(value) {
  const raw = String(value || "").trim().toLowerCase();
  return Object.values(METHODS).includes(raw) ? raw : null;
}

// process step. shell 문자열을 받지 않는다 — D-A0 runner 계약과 같은 이유로,
// 계획 단계에서부터 executable + argv 구조를 강제한다.
function normalizeProcessStep(entry) {
  const executable = cleanText(entry.executable || entry.exec || entry.run, 4096);
  if (!executable) return { ok: false, error: "process criterion에 실행할 프로그램이 없습니다." };
  if (/[\r\n]/.test(executable) || /[&|;<>]/.test(executable)) {
    return { ok: false, error: "process criterion의 실행 선언에 셸 제어 문자가 있습니다." };
  }
  const rawArgv = Array.isArray(entry.argv) ? entry.argv : [];
  const argv = [];
  for (const [index, arg] of rawArgv.entries()) {
    // 숫자와 불리언은 문자열 형태가 하나뿐이고 셸을 거치지 않으므로 그대로 확정한다.
    // (`["--limit", 100]`처럼 쓰는 계획이 흔한데, 이걸 거부하면 사람이 고칠 수 없는
    // 이유로 계획 전체가 막힌다.) 배열·객체·null은 모양이 정해지지 않아 거부한다.
    const value =
      typeof arg === "number" && Number.isFinite(arg) ? String(arg)
      : typeof arg === "boolean" ? String(arg)
      : arg;
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      const shown = JSON.stringify(arg);
      return {
        ok: false,
        error: `process criterion의 ${index + 1}번째 실행 인자가 올바르지 않습니다: ${
          shown === undefined ? String(arg) : shown.slice(0, 120)
        }`,
      };
    }
    argv.push(value);
  }
  const expect = entry.expect && typeof entry.expect === "object" ? entry.expect : {};
  const expectedExit = Number.isInteger(expect.exitCode) ? expect.exitCode : 0;

  // 승인된 script는 경로가 아니라 내용으로 고정된다(D-A0 §2.7).
  // Plan이 파일을 지목하면 그 해시도 Plan에 있어야 한다.
  const frozenFiles = {};
  if (entry.frozenFiles && typeof entry.frozenFiles === "object" && !Array.isArray(entry.frozenFiles)) {
    for (const [key, value] of Object.entries(entry.frozenFiles)) {
      const digest = cleanText(value, 128);
      if (digest) frozenFiles[String(key)] = digest;
    }
  }

  return {
    ok: true,
    step: {
      backend: "process",
      executable,
      argv,
      cwd: cleanText(entry.cwd, 4096) || null,
      timeoutMs: Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0 ? entry.timeoutMs : null,
      envNames: Array.isArray(entry.envNames)
        ? entry.envNames.map((n) => cleanText(n, 200)).filter(Boolean)
        : [],
      scriptPath: cleanText(entry.scriptPath, 4096) || null,
      scriptSha256: cleanText(entry.scriptSha256, 128) || null,
      frozenFiles,
      expect: { exitCode: expectedExit },
    },
  };
}

// predicate step. 실제 술어 어휘는 artifact-predicate 엔진이 정의하고,
// 여기서는 형태만 확인한다(계획 시점에는 capability가 없을 수도 있다).
function normalizePredicateStep(entry) {
  const check = entry.check && typeof entry.check === "object" ? entry.check : null;
  if (!check) return { ok: false, error: "predicate criterion에 check가 없습니다." };
  const kind = cleanText(check.kind, 80);
  if (!kind) return { ok: false, error: "predicate criterion의 check.kind가 없습니다." };
  const target = cleanText(check.path || check.target, 4096);
  if (!target) return { ok: false, error: "predicate criterion의 대상 경로가 없습니다." };
  return {
    ok: true,
    step: {
      backend: "artifact-predicate",
      kind,
      target,
      // 술어별 인자는 엔진이 해석한다. 여기서 의미를 확정하지 않는다.
      args: check.args && typeof check.args === "object" ? { ...check.args } : {},
      expected: Object.hasOwn(check, "expected") ? check.expected : null,
      operator: cleanText(check.operator || check.op, 20) || "==",
    },
  };
}

function normalizeCriterion(entry, index) {
  if (!entry || typeof entry !== "object") {
    return { ok: false, error: `criterion ${index + 1}이 객체가 아닙니다.` };
  }
  const method = normalizeMethod(entry.method);
  if (!method) {
    return { ok: false, error: `criterion ${index + 1}의 method가 올바르지 않습니다(process/predicate/review/human).` };
  }
  const statement = cleanText(entry.statement || entry.description);
  if (!statement) {
    return { ok: false, error: `criterion ${index + 1}에 무엇을 확인하는지가 없습니다.` };
  }
  const criterionId = cleanText(entry.id || entry.criterionId, 80) || `V${index + 1}`;

  let step = null;
  if (method === METHODS.PROCESS || method === METHODS.PREDICATE) {
    const normalized = method === METHODS.PROCESS
      ? normalizeProcessStep(entry)
      : normalizePredicateStep(entry);
    // 어느 검사 항목이 문제인지 밝히지 않으면 사용자는 고칠 곳을 찾을 수 없다.
    if (!normalized.ok) return { ok: false, error: `${criterionId}: ${normalized.error}` };
    step = normalized.step;
  }

  // 계획 처분은 method에서 따라온다. Plan의 자기 선언을 신뢰하지 않는다.
  const plannedDisposition = DEFAULT_DISPOSITION_FOR_METHOD[method];

  return {
    ok: true,
    criterion: {
      criterionId,
      statement,
      plannedMethod: method,
      plannedDisposition,
      step,
      // 자동 검사가 불가능해질 때 어디로 보낼지. 기본은 Reviewer이며
      // Plan이 human을 지정하면 사용자에게 간다(Charter §9 P-3 사전 예고 대상).
      downgradeTo: normalizeMethod(entry.downgradeTo) === METHODS.HUMAN
        ? DISPOSITIONS.HUMAN_APPROVAL
        : DISPOSITIONS.REVIEW_REQUIRED,
    },
  };
}

// criterion 배열을 표기 차이에 흔들리지 않는 정규형으로 만든다.
// hash는 이 정규형에서 나온다 — 공백·키 순서가 바뀌어도 같은 계획은 같은 hash다.
function canonicalizePlan(criteria) {
  return JSON.stringify(
    criteria.map((c) => ({
      criterionId: c.criterionId,
      statement: c.statement,
      plannedMethod: c.plannedMethod,
      plannedDisposition: c.plannedDisposition,
      downgradeTo: c.downgradeTo,
      step: c.step
        ? Object.fromEntries(Object.entries(c.step).sort(([a], [b]) => a.localeCompare(b)))
        : null,
    }))
  );
}

// Verification Plan 섹션 본문 → Frozen Verification Plan.
//
// 반환은 항상 "계획"이다. 실패해도 계획이 없다고 하지 않고, 기계가 읽지 못한
// 계획을 review로 강등해 사람에게 보낸다(R-4).
function parseVerificationPlan(body, options = {}) {
  const raw = String(body || "").trim();
  const notes = [];

  if (!raw) {
    return {
      ok: false,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria: [],
      structured: false,
      error: "Verification Plan 섹션이 비어 있습니다.",
      notes,
      planHash: null,
      canonical: null,
    };
  }

  const jsonBlock = extractPlanJsonBlock(raw);
  if (!jsonBlock) {
    // 산문만 있는 계획. 검사를 없애지 않고 사람 판단으로 보낸다.
    notes.push("계획이 기계가 읽을 수 있는 형식이 아니라 전체를 Reviewer 판단으로 보냅니다.");
    const criteria = [
      {
        criterionId: "V1",
        statement: cleanText(raw, MAX_STATEMENT_CHARS) || "Verification Plan",
        plannedMethod: METHODS.REVIEW,
        plannedDisposition: DISPOSITIONS.REVIEW_REQUIRED,
        step: null,
        downgradeTo: DISPOSITIONS.REVIEW_REQUIRED,
      },
    ];
    const canonical = canonicalizePlan(criteria);
    return {
      ok: true,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria,
      structured: false,
      notes,
      canonical,
      planHash: hashText(canonical),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (error) {
    return {
      ok: false,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria: [],
      structured: false,
      error: `Verification Plan의 JSON을 읽을 수 없습니다: ${error?.message || "parse error"}`,
      notes,
      planHash: null,
      canonical: null,
    };
  }

  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.criteria) ? parsed.criteria : null;
  if (!entries) {
    return {
      ok: false,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria: [],
      structured: false,
      error: "Verification Plan JSON이 criterion 배열이 아닙니다.",
      notes,
      planHash: null,
      canonical: null,
    };
  }
  if (entries.length === 0) {
    return {
      ok: false,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria: [],
      structured: false,
      error: "Verification Plan에 criterion이 하나도 없습니다.",
      notes,
      planHash: null,
      canonical: null,
    };
  }
  if (entries.length > MAX_CRITERIA) {
    return {
      ok: false,
      schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
      criteria: [],
      structured: false,
      error: `Verification Plan의 criterion이 너무 많습니다 (${entries.length}/${MAX_CRITERIA}).`,
      notes,
      planHash: null,
      canonical: null,
    };
  }

  const criteria = [];
  const seen = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const normalized = normalizeCriterion(entries[i], i);
    if (!normalized.ok) {
      return {
        ok: false,
        schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
        criteria: [],
        structured: false,
        error: normalized.error,
        notes,
        planHash: null,
        canonical: null,
      };
    }
    if (seen.has(normalized.criterion.criterionId)) {
      return {
        ok: false,
        schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
        criteria: [],
        structured: false,
        error: `criterion id가 중복됩니다: ${normalized.criterion.criterionId}`,
        notes,
        planHash: null,
        canonical: null,
      };
    }
    seen.add(normalized.criterion.criterionId);
    criteria.push(normalized.criterion);
  }

  const canonical = canonicalizePlan(criteria);
  return {
    ok: true,
    schemaVersion: VERIFICATION_PLAN_SCHEMA_VERSION,
    criteria,
    structured: true,
    notes,
    canonical,
    planHash: hashText(canonical),
  };
}

// 계획된 처분 구성. 승인 화면(§9 P-2)과 사전 예고(P-3)의 원자료다.
function summarizePlan(plan) {
  const counts = { automatic: 0, review: 0, human: 0 };
  for (const criterion of plan?.criteria || []) {
    if (criterion.plannedDisposition === DISPOSITIONS.VERIFIED) counts.automatic += 1;
    else if (criterion.plannedDisposition === DISPOSITIONS.HUMAN_APPROVAL) counts.human += 1;
    else counts.review += 1;
  }
  return {
    total: plan?.criteria?.length || 0,
    ...counts,
    structured: Boolean(plan?.structured),
    plannedHumanApprovals: (plan?.criteria || [])
      .filter((c) => c.plannedDisposition === DISPOSITIONS.HUMAN_APPROVAL)
      .map((c) => ({ criterionId: c.criterionId, statement: c.statement })),
  };
}

module.exports = {
  VERIFICATION_PLAN_SCHEMA_VERSION,
  METHODS,
  DISPOSITIONS,
  DEFAULT_DISPOSITION_FOR_METHOD,
  MAX_CRITERIA,
  extractPlanJsonBlock,
  parseVerificationPlan,
  canonicalizePlan,
  summarizePlan,
  hashText,
};
