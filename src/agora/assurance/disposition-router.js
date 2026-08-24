"use strict";

// Stage D-A2 — Disposition Router
//
// Process/Predicate 엔진의 형제가 아니라 **모든 검사 위의 상위 라우터**다.
// 엔진은 사실을 만들고, Router는 그 사실을 누가 판정할지를 정한다.
//
//   R-7  outcome과 disposition은 직교하는 두 축이다.
//        outcome      검사가 무엇을 확정했는가   (PASS/FAIL/ERROR/UNSUPPORTED/INVALIDATED)
//        disposition  그 확정을 누가 내리는가    (VERIFIED/REVIEW_REQUIRED/HUMAN_APPROVAL)
//
//        `FAIL + VERIFIED`는 모순이 아니라 "자동검사로 요구사항 위반이 확정됨"이라는
//        정확한 의미다. 즉시 revision 경로로 보낼 수 있다.
//
//   R-2  controlClass = NEITHER인 step은 VERIFIED를 낼 수 없다.
//        강제도 관찰도 못 했다는 것은 Agora가 그 검사를 수행하지 않았다는 뜻이다.
//
//   R-3  planned와 actual을 분리 기록한다. 정직한 강등이 조용한 강등이 되면 안 된다.
//
//   INV-3  Agora가 자동으로 증명하지 못한 것을 VERIFIED라고 부르지 않는다.

const { CONTROL_CLASS } = require("../verification-runner");

const OUTCOMES = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  ERROR: "ERROR",
  UNSUPPORTED: "UNSUPPORTED",
  INVALIDATED: "INVALIDATED",
});

const DISPOSITIONS = Object.freeze({
  VERIFIED: "VERIFIED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  HUMAN_APPROVAL: "HUMAN_APPROVAL",
});

// 기계가 확정한 것으로 부를 수 있는 outcome.
// UNSUPPORTED와 ERROR는 여기 없다 — 확정하지 못한 것이기 때문이다.
const MACHINE_DETERMINED = new Set([OUTCOMES.PASS, OUTCOMES.FAIL]);

// 실제 처분을 계산한다. 선언을 신뢰하지 않는다.
//
// 입력:
//   criterion       Frozen Plan의 계획(plannedMethod / plannedDisposition / downgradeTo)
//   outcome         엔진이 만든 사실
//   controlClass    실행 당시 실제 통제 특성 (R-1에 따라 계산된 값)
//
// 출력에는 항상 planned와 actual이 함께 들어간다(R-3).
function routeDisposition({ criterion, outcome, controlClass, downgradeReason = null } = {}) {
  const plannedMethod = criterion?.plannedMethod || null;
  const plannedDisposition = criterion?.plannedDisposition || null;
  const fallback = criterion?.downgradeTo === DISPOSITIONS.HUMAN_APPROVAL
    ? DISPOSITIONS.HUMAN_APPROVAL
    : DISPOSITIONS.REVIEW_REQUIRED;

  const reasons = [];
  if (downgradeReason) reasons.push(downgradeReason);

  // 계획부터 사람 판단인 criterion은 검사 대상이 아니다. 그대로 보낸다.
  if (plannedMethod === "review" || plannedMethod === "human") {
    return {
      plannedMethod,
      plannedDisposition,
      actualMethod: plannedMethod,
      actualDisposition: plannedDisposition,
      criterionOutcome: outcome || null,
      controlClass: controlClass || null,
      downgradeReason: null,
      downgraded: false,
    };
  }

  // INVALIDATED는 판정이 결과물에 귀속되지 못했다는 뜻이다(INV-5).
  // 자동 확정으로 남길 수 없다.
  if (outcome === OUTCOMES.INVALIDATED) {
    reasons.push("판정 대상 결과물이 확정 이후 바뀌었습니다.");
    return {
      plannedMethod,
      plannedDisposition,
      actualMethod: plannedMethod,
      actualDisposition: fallback,
      criterionOutcome: outcome,
      controlClass: controlClass || null,
      downgradeReason: reasons.join(" "),
      downgraded: true,
    };
  }

  // R-2 — 강제도 관찰도 못 한 검사는 수행되지 않은 것이다.
  if (controlClass === CONTROL_CLASS.NEITHER) {
    reasons.push("이 검사를 Agora가 통제하거나 관측하지 못했습니다.");
    return {
      plannedMethod,
      plannedDisposition,
      actualMethod: plannedMethod,
      actualDisposition: fallback,
      criterionOutcome: outcome || OUTCOMES.UNSUPPORTED,
      controlClass: controlClass || null,
      downgradeReason: reasons.join(" "),
      downgraded: true,
    };
  }

  // INV-3 — 확정하지 못한 것은 VERIFIED가 아니다.
  if (!MACHINE_DETERMINED.has(outcome)) {
    if (!downgradeReason) {
      reasons.push(
        outcome === OUTCOMES.UNSUPPORTED
          ? "이 PC에서 자동으로 확인할 수 없는 검사입니다."
          : "검사를 끝까지 수행하지 못했습니다."
      );
    }
    return {
      plannedMethod,
      plannedDisposition,
      actualMethod: plannedMethod,
      actualDisposition: fallback,
      criterionOutcome: outcome || OUTCOMES.ERROR,
      controlClass: controlClass || null,
      downgradeReason: reasons.join(" "),
      downgraded: true,
    };
  }

  // 여기까지 오면 기계가 확정했다. PASS든 FAIL이든 VERIFIED다.
  // VERIFIED는 "통과"가 아니라 "기계적으로 확정됨"이다.
  return {
    plannedMethod,
    plannedDisposition,
    actualMethod: plannedMethod,
    actualDisposition: DISPOSITIONS.VERIFIED,
    criterionOutcome: outcome,
    controlClass: controlClass || null,
    downgradeReason: null,
    downgraded: plannedDisposition !== DISPOSITIONS.VERIFIED,
  };
}

// 처분 구성 요약. "✓ 8개 통과"로 뭉개지 않기 위한 원자료다(§9 P-2).
function summarizeDispositions(records = []) {
  const byDisposition = { VERIFIED: 0, REVIEW_REQUIRED: 0, HUMAN_APPROVAL: 0 };
  const byOutcome = { PASS: 0, FAIL: 0, ERROR: 0, UNSUPPORTED: 0, INVALIDATED: 0 };
  const downgrades = [];

  for (const record of records) {
    if (byDisposition[record.actualDisposition] != null) byDisposition[record.actualDisposition] += 1;
    if (byOutcome[record.criterionOutcome] != null) byOutcome[record.criterionOutcome] += 1;
    if (record.downgraded && record.plannedDisposition !== record.actualDisposition) {
      downgrades.push({
        criterionId: record.criterionId,
        plannedDisposition: record.plannedDisposition,
        actualDisposition: record.actualDisposition,
        downgradeReason: record.downgradeReason || null,
      });
    }
  }

  return {
    total: records.length,
    byDisposition,
    byOutcome,
    downgrades,
    // 사용자 표면 문구는 UI가 만든다. 여기서는 사실만 제공한다(§9).
    automatic: byDisposition.VERIFIED,
    review: byDisposition.REVIEW_REQUIRED,
    human: byDisposition.HUMAN_APPROVAL,
  };
}

module.exports = {
  OUTCOMES,
  DISPOSITIONS,
  MACHINE_DETERMINED,
  routeDisposition,
  summarizeDispositions,
};
