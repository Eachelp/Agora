"use strict";

// Stage D-C — Typed Run Lineage (§27)
//
// `carriedFromRunId`에 의미를 계속 덧붙이면 "이 Run이 왜 생겼는가"를 나중에
// 구분할 수 없다. replan(계약이 바뀜)과 retry(같은 계약 재시도)와
// revision(같은 Run 안의 보완)은 감사에서 전혀 다른 의미다.
//
//   parentRunId + lineageRelation
//
// 기존 필드는 호환으로 유지한다. **기존 기록을 파괴하지 않는다** — 옛 Run은
// carriedFromRunId만 가지고 있고, 그것을 `carry` 관계로 읽어 준다.

const LINEAGE_RELATIONS = Object.freeze({
  REPLAN: "replan",       // 계약/검사가 바뀌었다 → 새 lineage
  RETRY: "retry",         // 같은 계약을 다시 실행
  REVISION: "revision",   // 같은 Run 안에서 결과물을 고침
  CARRY: "carry",         // 옛 carriedFromRunId의 의미(구분 없음)
});

function isValidRelation(value) {
  return Object.values(LINEAGE_RELATIONS).includes(value);
}

// Run 상태에 typed lineage를 붙인다. 기존 필드도 함께 유지한다.
function attachLineage(run, { parentRunId = null, lineageRelation = null } = {}) {
  if (!run || typeof run !== "object") return run;
  const relation = isValidRelation(lineageRelation) ? lineageRelation : null;
  return {
    ...run,
    parentRunId: parentRunId || run.parentRunId || null,
    lineageRelation: relation || run.lineageRelation || null,
    // 호환: 기존 소비자가 계속 읽을 수 있게 남긴다.
    carriedFromRunId: parentRunId || run.carriedFromRunId || null,
  };
}

// 옛 Run 상태를 typed 형태로 읽는다. **저장된 값을 고치지 않는다.**
// 마이그레이션이 아니라 읽기 어댑터다(§6과 같은 정신).
function readLineage(run) {
  if (!run || typeof run !== "object") return { parentRunId: null, lineageRelation: null, inferred: false };
  if (run.parentRunId && isValidRelation(run.lineageRelation)) {
    return { parentRunId: run.parentRunId, lineageRelation: run.lineageRelation, inferred: false };
  }
  if (run.carriedFromRunId) {
    // 옛 기록은 왜 이어졌는지를 담지 않았다. 지어내지 않고 carry로 읽는다.
    return { parentRunId: run.carriedFromRunId, lineageRelation: LINEAGE_RELATIONS.CARRY, inferred: true };
  }
  return { parentRunId: null, lineageRelation: null, inferred: false };
}

// lineage 사슬을 거슬러 올라간다. 순환은 잘라낸다.
function traceLineage(runsById, startRunId, { maxDepth = 50 } = {}) {
  const chain = [];
  const seen = new Set();
  let current = startRunId;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (seen.has(current)) {
      chain.push({ runId: current, lineageRelation: null, cycle: true });
      break;
    }
    seen.add(current);
    const run = runsById instanceof Map ? runsById.get(current) : runsById?.[current];
    if (!run) break;
    const lineage = readLineage(run);
    chain.push({
      runId: current,
      parentRunId: lineage.parentRunId,
      lineageRelation: lineage.lineageRelation,
      inferred: lineage.inferred,
    });
    current = lineage.parentRunId;
    depth += 1;
  }
  return chain;
}

module.exports = {
  LINEAGE_RELATIONS,
  isValidRelation,
  attachLineage,
  readLineage,
  traceLineage,
};
