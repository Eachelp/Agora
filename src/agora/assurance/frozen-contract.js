"use strict";

// Stage D-A1 — Frozen Assurance Contract
//
// Task 본문 · Verification Plan · Input binding을 하나의 동결 계약으로 묶는다.
// 승인 시점에 여기서 나온 hash들이 이후 모든 판정의 기준이 된다(INV-1).
//
//   Task 승인
//     → canonicalize(task) → taskHash
//     → parse(verification plan) → planHash
//     → bind(inputs) → inputBindingRef
//     → FREEZE (RUN-xxx/assurance-contract.json, immutable)
//
// 이후 Builder · Reviewer · auto-revision 누구도 이 파일을 고치지 않는다.
// 검사를 바꾸려면 REPLAN → 사용자 승인 → 새 Run lineage다.
//
// **v1 Frozen Task는 제자리 변환하지 않는다(Charter §6).** 옛 Run은 schemaVersion 1
// 그대로 두고, 새 Run만 v2 계약을 만든다. 이미 동결된 과거 계약을 다시 쓰는 것은
// "그때 승인받은 것"을 파괴하는 일이다.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const taskSchema = require("./task-schema-v2");
const verificationPlan = require("./verification-plan");

// Inputs 항목에 경로가 아니라 산문 한 줄이 들어오면(Planner가 참고 사항을 목록에
// 섞어 적으면) 오류 문구가 그 문장을 통째로 뱉어 무엇이 문제인지 읽을 수 없다.
// 따옴표로 경계를 보이고 길면 줄여서, 어느 항목이 경로가 아닌지 눈에 띄게 한다.
function quoteLocator(value) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `"${text.slice(0, 77)}…"` : `"${text}"`;
}
const inputBinding = require("./input-binding");

const CONTRACT_FILENAME = "assurance-contract.json";
const CONTRACT_SCHEMA_VERSION = 1;

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// 승인된 Task 본문에서 동결 계약을 만든다.
// 실패해도 "계약 없음"으로 통과시키지 않는다 — 무엇이 부족한지 돌려준다.
function buildFrozenContract(taskContent, context = {}) {
  const parsed = taskSchema.parseTaskV2(taskContent);
  const now = Number.isFinite(context.now) ? context.now : Date.now();

  if (!parsed.valid) {
    return {
      ok: false,
      code: "TASK_CONTRACT_INCOMPLETE",
      missing: parsed.missing,
      warnings: parsed.warnings,
      error: `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${parsed.missing.join(", ")}`,
    };
  }

  const plan = verificationPlan.parseVerificationPlan(parsed.verificationPlanBody);
  if (!plan.ok) {
    return {
      ok: false,
      code: "VERIFICATION_PLAN_INVALID",
      error: plan.error,
    };
  }

  const binding = inputBinding.bindInputs(parsed.inputs.items, {
    root: context.root || null,
    now,
  });

  // frozen 입력이 승인 시점에 이미 없으면 계약이 성립하지 않는다.
  // "나중에 만들어지겠지"로 넘기면 frozen의 의미가 사라진다.
  if (binding.missingFrozen.length > 0) {
    return {
      ok: false,
      code: "FROZEN_INPUT_MISSING",
      missingInputs: binding.missingFrozen,
      error: `승인된 입력 파일을 찾을 수 없습니다: ${binding.missingFrozen.map(quoteLocator).join(", ")}`,
    };
  }

  // frozen인데 지문을 뜰 수 없는 입력(디렉터리·URL·너무 큼·읽기 불가)도 계약을
  // 성립시키지 않는다. "같은 입력이어야 한다"를 확인할 수단이 없으면서 계약만
  // 통과시키면 frozen은 이름뿐이고, 재대조는 SKIPPED로 조용히 넘어간다(B7).
  //
  // 진행하려면 Plan이 그 입력을 live로 선언하거나(달라도 된다고 인정하거나),
  // 지문을 뜰 수 있는 대상으로 바꿔야 한다 — 둘 다 사용자 재승인 경로다.
  if (binding.unboundFrozen.length > 0) {
    return {
      ok: false,
      code: "FROZEN_INPUT_UNVERIFIABLE",
      unverifiableInputs: binding.unboundFrozen,
      error:
        `승인된 입력이 같은 내용인지 확인할 수 없습니다: ${binding.unboundFrozen
          .map((b) => `${quoteLocator(b.locator)}(${b.reason || "unsupported"})`)
          .join(", ")}`,
    };
  }

  const contract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    taskSchemaVersion: taskSchema.TASK_SCHEMA_VERSION,
    frozenAt: now,
    taskHash: parsed.taskHash,
    // M1 — 토론 결정 ↔ Frozen Task 링크(Charter §4).
    decisionIds: parsed.decisionIds,
    inputs: {
      state: parsed.inputs.state,
      items: parsed.inputs.items,
    },
    deliverables: {
      state: parsed.deliverables.state,
      items: parsed.deliverables.items,
    },
    verificationPlan: {
      schemaVersion: plan.schemaVersion,
      planHash: plan.planHash,
      structured: plan.structured,
      notes: plan.notes,
      criteria: plan.criteria,
    },
    inputBinding: binding,
    usedAliases: parsed.usedAliases,
  };

  // 계약 전체의 지문. 이 값이 달라지면 "다른 계약"이다.
  contract.contractHash = hashJson({
    taskHash: contract.taskHash,
    planHash: contract.verificationPlan.planHash,
    inputs: contract.inputs,
    deliverables: contract.deliverables,
  });

  return { ok: true, contract, parsed, plan };
}

function contractPathFor(runDir) {
  return path.join(runDir, CONTRACT_FILENAME);
}

// 동결. 이미 있으면 덮어쓰지 않는다 — 재freeze는 계약 위반이다.
function freezeContract(runDir, contract) {
  if (!runDir) return { ok: false, error: "Run 폴더가 없습니다." };
  const file = contractPathFor(runDir);
  if (fs.existsSync(file)) {
    return { ok: false, code: "ALREADY_FROZEN", error: "이미 동결된 계약이 있습니다." };
  }
  try {
    fs.mkdirSync(runDir, { recursive: true });
    writeJsonAtomic(file, contract);
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, error: error?.message || "계약을 저장하지 못했습니다." };
  }
}

// 동결된 계약 읽기. 손상되면 현재 Task로 fallback하지 않는다.
function readFrozenContract(runDir) {
  const file = contractPathFor(runDir);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, code: "CONTRACT_MISSING", error: "동결된 계약을 찾을 수 없습니다." };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "CONTRACT_CORRUPTED", error: "동결된 계약이 손상되었습니다." };
  }
  const expected = hashJson({
    taskHash: parsed.taskHash,
    planHash: parsed.verificationPlan?.planHash,
    inputs: parsed.inputs,
    deliverables: parsed.deliverables,
  });
  if (parsed.contractHash !== expected) {
    return { ok: false, code: "CONTRACT_CORRUPTED", error: "동결된 계약의 해시가 맞지 않습니다." };
  }
  return { ok: true, contract: parsed };
}

// Builder admission 직전 검문(Charter §3.1).
// frozen 입력이 승인 시점과 다르면 Run을 시작하지 않는다.
function admitBuilder(contract, context = {}) {
  const recheck = inputBinding.recheckFrozenInputs(contract?.inputBinding, {
    root: context.root || null,
    now: context.now,
  });
  if (!recheck.ok) {
    return {
      ok: false,
      code: "FROZEN_INPUT_CHANGED",
      error: `승인된 입력이 달라졌습니다: ${recheck.changed.map((c) => c.locator).join(", ")}`,
      recheck,
    };
  }
  return { ok: true, recheck };
}

// Frozen Verification Plan은 실행 중 바뀌지 않는다(INV-1).
// 이 함수는 "지금 들고 있는 plan이 동결된 그것인가"를 확인한다.
function verifyPlanIntegrity(contract, plan) {
  const canonical = verificationPlan.canonicalizePlan(plan?.criteria || []);
  const actual = verificationPlan.hashText(canonical);
  const expected = contract?.verificationPlan?.planHash || null;
  return {
    ok: Boolean(expected) && actual === expected,
    expected,
    actual,
  };
}

module.exports = {
  CONTRACT_FILENAME,
  CONTRACT_SCHEMA_VERSION,
  buildFrozenContract,
  freezeContract,
  readFrozenContract,
  contractPathFor,
  admitBuilder,
  verifyPlanIntegrity,
  hashJson,
};
