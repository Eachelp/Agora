"use strict";

// Stage D-A2 — Final Disposition Aggregation
//
// Run이 최종 PASS가 되는 조건을 코드로 명시한다. 이 규칙이 흐릿하면 Stage D
// 전체가 "검증처럼 보이는 자동화"가 된다.
//
//   1. 자동검사 FAIL이 하나라도 있으면          → Final PASS 금지 (revision)
//   2. ERROR / UNSUPPORTED가 미해결이면          → Final PASS 금지
//   3. REVIEW_REQUIRED가 미해결이면              → Final PASS 금지
//   4. HUMAN_APPROVAL이 미해결이면               → Final PASS 금지
//   5. 모든 판정이 동일한 최신 subjectRef에 귀속 → 아니면 금지
//   6. Final 직전 subject fingerprint 재확인      → 바뀌었으면 금지
//   7. Final 직전 frozen input 재확인             → 바뀌었으면 금지
//   8. 변경이 있으면 INVALIDATED — 자동 승격 금지
//   9. 모두 해소될 때만 Final PASS
//
// **차단은 실패가 아니다.** 무엇이 남았는지를 구조로 돌려주어 UI가 다음 행동을
// 안내할 수 있게 한다(§9 — 복잡도는 Agora가 부담한다).

const { OUTCOMES, DISPOSITIONS } = require("./disposition-router");

const FINAL_VERDICTS = Object.freeze({
  PASS: "PASS",
  BLOCKED: "BLOCKED",
  INVALIDATED: "INVALIDATED",
});

const BLOCK_REASONS = Object.freeze({
  AUTOMATIC_FAIL: "AUTOMATIC_FAIL",
  UNRESOLVED_ERROR: "UNRESOLVED_ERROR",
  UNRESOLVED_UNSUPPORTED: "UNRESOLVED_UNSUPPORTED",
  UNRESOLVED_REVIEW: "UNRESOLVED_REVIEW",
  UNRESOLVED_HUMAN_APPROVAL: "UNRESOLVED_HUMAN_APPROVAL",
  SUBJECT_CHANGED: "SUBJECT_CHANGED",
  FROZEN_INPUT_CHANGED: "FROZEN_INPUT_CHANGED",
  SUBJECT_MISMATCH: "SUBJECT_MISMATCH",
  NO_CRITERIA: "NO_CRITERIA",
  PLAN_TAMPERED: "PLAN_TAMPERED",
});

function blocker(reason, detail = {}) {
  return { reason, ...detail };
}

// 최종 판정을 집계한다.
//
// 입력:
//   plan                Frozen Verification Plan (criterion 목록의 진실)
//   ledger              append-only 판정 원장
//   assuranceSubjectRef 지금 유효한 결과물 snapshot
//   subjectRecheck      Final 직전 재확인 결과
//   inputRecheck        Final 직전 frozen input 재확인 결과
//   planIntegrity       Frozen Plan이 그대로인지
function aggregateFinalDisposition({
  plan,
  ledger,
  assuranceSubjectRef = null,
  subjectRecheck = null,
  inputRecheck = null,
  planIntegrity = null,
} = {}) {
  const criteria = Array.isArray(plan?.criteria) ? plan.criteria : [];
  const blockers = [];
  const perCriterion = [];

  // INV-1 — 동결된 계획이 실행 중 바뀌었으면 그 위의 모든 판정은 의미가 없다.
  if (planIntegrity && planIntegrity.ok === false) {
    blockers.push(
      blocker(BLOCK_REASONS.PLAN_TAMPERED, {
        expected: planIntegrity.expected,
        actual: planIntegrity.actual,
      })
    );
  }

  if (criteria.length === 0) {
    blockers.push(blocker(BLOCK_REASONS.NO_CRITERIA));
  }

  for (const criterion of criteria) {
    const effective = ledger?.effectiveFor(criterion.criterionId, { assuranceSubjectRef }) || null;
    const entry = {
      criterionId: criterion.criterionId,
      statement: criterion.statement,
      plannedMethod: criterion.plannedMethod,
      plannedDisposition: criterion.plannedDisposition,
      actualDisposition: effective?.actualDisposition || null,
      criterionOutcome: effective?.criterionOutcome || null,
      resolved: Boolean(effective?.resolved),
      recordType: effective?.type || null,
    };
    perCriterion.push(entry);

    if (!effective) {
      // 계획된 검사인데 아무 기록도 없다. 통과로 셀 수 없다.
      blockers.push(blocker(BLOCK_REASONS.UNRESOLVED_ERROR, { criterionId: criterion.criterionId, detail: "판정 기록 없음" }));
      continue;
    }

    // 다른 subject에 귀속된 판정은 이 결과물에 대한 판정이 아니다(INV-5 · 규칙 5).
    if (
      assuranceSubjectRef &&
      effective.assuranceSubjectRef &&
      effective.assuranceSubjectRef !== assuranceSubjectRef
    ) {
      blockers.push(blocker(BLOCK_REASONS.SUBJECT_MISMATCH, { criterionId: criterion.criterionId }));
      continue;
    }

    if (effective.criterionOutcome === OUTCOMES.INVALIDATED) {
      blockers.push(blocker(BLOCK_REASONS.SUBJECT_CHANGED, { criterionId: criterion.criterionId }));
      continue;
    }

    // 규칙 1 — 자동검사 FAIL은 하나라도 있으면 PASS가 될 수 없다.
    if (effective.criterionOutcome === OUTCOMES.FAIL) {
      blockers.push(blocker(BLOCK_REASONS.AUTOMATIC_FAIL, { criterionId: criterion.criterionId }));
      continue;
    }

    // 규칙 2 — ERROR / UNSUPPORTED는 해소되어야 한다.
    // 해소는 "무시"가 아니라 Reviewer/Human의 명시적 판정이다.
    if (!effective.resolved) {
      if (effective.criterionOutcome === OUTCOMES.UNSUPPORTED) {
        blockers.push(blocker(BLOCK_REASONS.UNRESOLVED_UNSUPPORTED, { criterionId: criterion.criterionId }));
      } else if (effective.criterionOutcome === OUTCOMES.ERROR) {
        blockers.push(blocker(BLOCK_REASONS.UNRESOLVED_ERROR, { criterionId: criterion.criterionId }));
      } else if (effective.actualDisposition === DISPOSITIONS.HUMAN_APPROVAL) {
        // 규칙 4 — 사용자 승인 없이는 해결된 것으로 처리하지 않는다.
        blockers.push(blocker(BLOCK_REASONS.UNRESOLVED_HUMAN_APPROVAL, { criterionId: criterion.criterionId }));
      } else {
        // 규칙 3 — Reviewer가 실제로 판정해야 한다.
        blockers.push(blocker(BLOCK_REASONS.UNRESOLVED_REVIEW, { criterionId: criterion.criterionId }));
      }
      continue;
    }

    // 해소되었더라도 판정 자체가 FAIL이면 PASS가 아니다.
    if (effective.criterionOutcome === "FAIL") {
      blockers.push(blocker(BLOCK_REASONS.AUTOMATIC_FAIL, { criterionId: criterion.criterionId }));
    }
  }

  // 규칙 6 — Final 확정 직전 결과물 재확인.
  if (subjectRecheck && subjectRecheck.ok === false) {
    blockers.push(
      blocker(BLOCK_REASONS.SUBJECT_CHANGED, {
        changed: (subjectRecheck.changed || []).map((c) => c.path),
      })
    );
  }

  // 규칙 7 — Final 확정 직전 frozen input 재확인.
  if (inputRecheck && inputRecheck.ok === false) {
    blockers.push(
      blocker(BLOCK_REASONS.FROZEN_INPUT_CHANGED, {
        changed: (inputRecheck.changed || []).map((c) => c.locator),
      })
    );
  }

  // 규칙 8 — 결과물/입력이 바뀌었으면 자동 승격 금지. 별도 verdict로 구분해
  // "재검사가 필요하다"와 "검사가 남았다"를 UI가 다르게 안내할 수 있게 한다.
  const invalidated = blockers.some(
    (b) => b.reason === BLOCK_REASONS.SUBJECT_CHANGED || b.reason === BLOCK_REASONS.FROZEN_INPUT_CHANGED
  );

  const verdict = blockers.length === 0
    ? FINAL_VERDICTS.PASS
    : invalidated
      ? FINAL_VERDICTS.INVALIDATED
      : FINAL_VERDICTS.BLOCKED;

  return {
    verdict,
    finalPass: verdict === FINAL_VERDICTS.PASS,
    assuranceSubjectRef,
    blockers,
    perCriterion,
    summary: {
      total: criteria.length,
      resolved: perCriterion.filter((c) => c.resolved).length,
      automatic: perCriterion.filter((c) => c.actualDisposition === DISPOSITIONS.VERIFIED).length,
      review: perCriterion.filter((c) => c.actualDisposition === DISPOSITIONS.REVIEW_REQUIRED).length,
      human: perCriterion.filter((c) => c.actualDisposition === DISPOSITIONS.HUMAN_APPROVAL).length,
    },
  };
}

// 사용자에게 보여줄 문장을 만들 원자료. 내부 어휘를 그대로 노출하지 않는다(§9).
function describeBlockers(result) {
  const counts = new Map();
  for (const b of result?.blockers || []) {
    counts.set(b.reason, (counts.get(b.reason) || 0) + 1);
  }
  const labels = {
    [BLOCK_REASONS.AUTOMATIC_FAIL]: "확인 결과 요구사항을 충족하지 못한 항목",
    [BLOCK_REASONS.UNRESOLVED_ERROR]: "확인을 끝내지 못한 항목",
    [BLOCK_REASONS.UNRESOLVED_UNSUPPORTED]: "이 PC에서 자동 확인이 안 되는 항목",
    [BLOCK_REASONS.UNRESOLVED_REVIEW]: "검수자 판단이 남은 항목",
    [BLOCK_REASONS.UNRESOLVED_HUMAN_APPROVAL]: "사용자 승인이 남은 항목",
    [BLOCK_REASONS.SUBJECT_CHANGED]: "확인 이후 결과물이 바뀐 항목",
    [BLOCK_REASONS.FROZEN_INPUT_CHANGED]: "작업 중 입력 자료가 바뀜",
    [BLOCK_REASONS.SUBJECT_MISMATCH]: "다른 결과물에 대한 판정",
    [BLOCK_REASONS.NO_CRITERIA]: "확인 항목이 없음",
    [BLOCK_REASONS.PLAN_TAMPERED]: "승인된 확인 목록이 실행 중 바뀜",
    // 배선 계층이 만드는 사유. 기록하지 못한 판정은 통과시키지 않는다(B3).
    ASSURANCE_STATE_WRITE_FAILED: "확인 기록을 저장하지 못함",
    ASSURANCE_INTERNAL_ERROR: "확인을 끝까지 수행하지 못함",
  };
  return [...counts.entries()].map(([reason, count]) => ({
    reason,
    count,
    label: labels[reason] || reason,
  }));
}

module.exports = {
  FINAL_VERDICTS,
  BLOCK_REASONS,
  aggregateFinalDisposition,
  describeBlockers,
};
