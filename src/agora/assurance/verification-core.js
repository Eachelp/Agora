"use strict";

// Stage D-A2 — Verification Core
//
// D-A0의 안전 경계와 D-A1의 동결 계약을 실제 실행에 연결한다.
//
//   Frozen Verification Plan
//         ↓
//   ┌─────────────────────┐
//   │ Process Engine      │──┐
//   │ Artifact Predicate  │──┤→ Criterion Result → Disposition Router → Ledger
//   └─────────────────────┘  │
//         capability snapshot ┘
//
// 엔진은 **둘뿐**이다. 도메인 Verifier(ExcelVerifier 등)를 core에 넣지 않는다.
// 도메인 지식은 Frozen Task가 공급한다.
//
// 능력 판정은 실행 1회당 스냅샷 하나로 고정한다(D-A0 §2.4). criterion마다 다시
// 재면 같은 실행 안에서 판정이 흔들리고, "왜 강등됐는가"를 재구성할 수 없다.
//
// runner는 여전히 PASS/FAIL을 자의적으로 판단하지 않는다. 여기서 Plan의 expect와
// 대조해 outcome을 만들고, disposition은 Router가 정한다(R-7).

const { discoverVerificationCapabilities } = require("../verification-capabilities");
const {
  runVerificationProcess,
  computeControlClass,
  CONTROL_CLASS,
  RUNNER_ERRORS,
} = require("../verification-runner");
const { evaluatePredicate } = require("./artifact-predicate");
const { routeDisposition, OUTCOMES } = require("./disposition-router");

// process 검증 결과 → outcome.
// runner가 남긴 사실을 Plan의 기대와 대조하는 자리이며, 여기가 유일한 판정 지점이다.
function outcomeForProcess(runResult, expect = {}) {
  if (!runResult) return { outcome: OUTCOMES.ERROR, error: "실행 결과가 없습니다." };

  if (!runResult.ok) {
    switch (runResult.code) {
      case RUNNER_ERRORS.EXECUTABLE_UNAVAILABLE:
        // 이 PC에 도구가 없다. 실패가 아니라 확정 불가다(INV-3).
        return {
          outcome: OUTCOMES.UNSUPPORTED,
          downgradeReason: `이 PC에서 검증 프로그램을 찾지 못했습니다: ${runResult.executable || "unknown"}`,
        };
      case RUNNER_ERRORS.TIMEOUT:
        return { outcome: OUTCOMES.ERROR, error: runResult.error || "검증 실행이 시간 안에 끝나지 않았습니다." };
      case RUNNER_ERRORS.SCRIPT_DIGEST_MISMATCH:
        // 승인받은 검사가 아니다. 통과로 만들 수 없다.
        return { outcome: OUTCOMES.ERROR, error: runResult.error || "승인된 검증 스크립트와 내용이 다릅니다." };
      default:
        return { outcome: OUTCOMES.ERROR, error: runResult.error || "검증을 실행하지 못했습니다." };
    }
  }

  const expectedExit = Number.isInteger(expect?.exitCode) ? expect.exitCode : 0;
  return {
    outcome: runResult.exitCode === expectedExit ? OUTCOMES.PASS : OUTCOMES.FAIL,
    expectedExitCode: expectedExit,
    actualExitCode: runResult.exitCode,
  };
}

// 검증 실행 1회. Frozen Plan의 criterion을 순서대로 수행한다.
//
// 중요: 이 함수는 Plan을 읽기만 한다. criterion을 추가·수정·건너뛰지 않는다(INV-1).
async function runVerification(plan, context = {}) {
  const criteria = Array.isArray(plan?.criteria) ? plan.criteria : [];
  const capabilities = context.capabilities || discoverVerificationCapabilities();
  const assuranceSubjectRef = context.assuranceSubjectRef || null;
  const ledger = context.ledger || null;
  const records = [];

  for (const criterion of criteria) {
    let outcome = null;
    let controlClass = CONTROL_CLASS.NEITHER;
    let downgradeReason = null;
    let evidence = null;

    if (criterion.plannedMethod === "process") {
      const step = criterion.step || {};
      const runResult = await runVerificationProcess(
        {
          executable: step.executable,
          argv: step.argv,
          cwd: step.cwd || undefined,
          timeoutMs: step.timeoutMs || undefined,
          envNames: step.envNames || [],
          scriptPath: step.scriptPath || undefined,
          scriptSha256: step.scriptSha256 || undefined,
          frozenFiles: step.frozenFiles || {},
        },
        {
          root: context.root,
          workerPermission: context.workerPermission,
          capabilities,
          env: context.env,
          platform: context.platform,
          // 검증기가 산출물을 건드리면 Builder 변경과 분리해 기록한다(D-A0 §2.8).
          sideEffectScope: context.sideEffectScope || null,
        }
      );
      const judged = outcomeForProcess(runResult, step.expect);
      outcome = judged.outcome;
      downgradeReason = judged.downgradeReason || null;
      // subprocess는 OBSERVABLE이 상한이다(Charter v0.5). admission 실패면 NEITHER.
      controlClass = runResult?.controlClass || CONTROL_CLASS.NEITHER;
      evidence = {
        backend: "process",
        startedAt: runResult?.startedAt ?? null,
        finishedAt: runResult?.finishedAt ?? null,
        durationMs: runResult?.durationMs ?? null,
        declaredExecutable: runResult?.executable ?? step.executable ?? null,
        resolvedExecutable: runResult?.resolvedExecutable ?? null,
        argv: runResult?.argv ?? step.argv ?? [],
        cwd: runResult?.cwd ?? null,
        exitCode: runResult?.exitCode ?? null,
        signal: runResult?.signal ?? null,
        expectedExitCode: judged.expectedExitCode ?? null,
        stdout: runResult?.stdout ?? null,
        stderr: runResult?.stderr ?? null,
        truncated: Boolean(runResult?.truncated),
        timedOut: runResult?.code === RUNNER_ERRORS.TIMEOUT,
        permission: runResult?.permission ?? null,
        sideEffects: runResult?.sideEffects ?? { accounted: false, changedPaths: [] },
        error: judged.error || runResult?.error || null,
      };
    } else if (criterion.plannedMethod === "predicate") {
      const evaluated = evaluatePredicate(criterion.step || {}, {
        root: context.root,
        capabilities,
      });
      outcome = evaluated.outcome;
      downgradeReason = evaluated.downgradeReason || null;
      // Agora 자체 read-only 평가는 봉쇄되어 있다. 다만 평가 자체가 오류면
      // 통제되었다고 말할 수 없으므로 NEITHER로 내린다.
      controlClass =
        evaluated.outcome === OUTCOMES.ERROR
          ? CONTROL_CLASS.NEITHER
          : computeControlClass({ backend: "artifact-predicate", contained: true });
      evidence = { ...evaluated, backend: "artifact-predicate" };
    } else {
      // review / human criterion은 검사 대상이 아니다. 라우터가 그대로 흘려보낸다.
      outcome = null;
      controlClass = null;
      evidence = { backend: criterion.plannedMethod };
    }

    const routed = routeDisposition({ criterion, outcome, controlClass, downgradeReason });
    const record = {
      criterionId: criterion.criterionId,
      statement: criterion.statement,
      ...routed,
      capabilitySnapshotRef: capabilities?.snapshotId || null,
      assuranceSubjectRef,
      evidence,
    };
    records.push(record);

    if (ledger) {
      ledger.appendExecution({
        criterionId: record.criterionId,
        statement: record.statement,
        plannedMethod: record.plannedMethod,
        plannedDisposition: record.plannedDisposition,
        actualMethod: record.actualMethod,
        actualDisposition: record.actualDisposition,
        criterionOutcome: record.criterionOutcome,
        controlClass: record.controlClass,
        downgradeReason: record.downgradeReason,
        capabilitySnapshotRef: record.capabilitySnapshotRef,
        assuranceSubjectRef,
        evidence,
      });
    }
  }

  return {
    ok: true,
    capabilitySnapshotRef: capabilities?.snapshotId || null,
    capabilities,
    assuranceSubjectRef,
    records,
  };
}

module.exports = {
  runVerification,
  outcomeForProcess,
};
