"use strict";

// V1.5 구조화 토론 Protocol (AGORA_V1_5_PROPOSAL.md §5).
// 세 모델은 그대로 두고 토론 중에만 유효한 임시 역할을 덧씌운다. 이 모듈은
// 순수 로직이다 — Preset이 시작된 뒤에는 cycle 순서를 모델이 바꿀 수 없고
// (INV-1), 발언자 선택은 여기의 speakerForTurn만이 결정한다.

const DISCUSSION_CYCLE_BUDGET_MIN = 1;
const DEFAULT_DISCUSSION_CYCLE_BUDGET = 3;
// 토론 전체의 hard ceiling. 자유토론의 turnBudget 상한과 같은 값을 공유한다 —
// 구조화 토론이라고 별도의 magic number(예: 5 cycle)를 둘 이유가 없다.
// 4-step preset이면 최대 12 cycle(48턴)이다.
const DISCUSSION_HARD_TURN_CEILING = 50;

function maxCycleBudget(stepCount) {
  const steps = Number.isInteger(stepCount) && stepCount > 0 ? stepCount : 4;
  return Math.max(DISCUSSION_CYCLE_BUDGET_MIN, Math.floor(DISCUSSION_HARD_TURN_CEILING / steps));
}

// slot은 참가자 배열 인덱스다. 발안과 수정처럼 같은 참가자가 한 cycle에서
// 두 단계를 맡을 수 있으므로 step 수와 참가자 수는 다르다.
const DISCUSSION_PRESETS = Object.freeze({
  shaping: Object.freeze({
    id: "shaping",
    name: "기획",
    slotCount: 3,
    steps: Object.freeze([
      Object.freeze({ slot: 0, roleName: "발안자", charter: "논의 주제에 대한 구체적인 안을 제시합니다." }),
      Object.freeze({ slot: 1, roleName: "비평가", charter: "앞선 안의 약점·누락·리스크를 근거와 함께 짚습니다." }),
      Object.freeze({ slot: 0, roleName: "발안자(수정)", charter: "비평을 반영해 안을 수정하거나 반박 근거를 제시합니다." }),
      Object.freeze({ slot: 2, roleName: "종합자", charter: "이번 사이클의 합의점과 남은 쟁점을 정리합니다." }),
    ]),
  }),
  grill: Object.freeze({
    id: "grill",
    name: "Grill",
    slotCount: 3,
    steps: Object.freeze([
      Object.freeze({ slot: 0, roleName: "제안자", charter: "검증받을 제안을 명확한 주장으로 제시합니다." }),
      Object.freeze({ slot: 1, roleName: "질문자", charter: "제안의 전제와 근거를 파고드는 날카로운 질문을 던집니다." }),
      Object.freeze({ slot: 0, roleName: "제안자(답변)", charter: "질문에 정면으로 답하고, 답할 수 없으면 모른다고 밝힙니다." }),
      Object.freeze({ slot: 2, roleName: "판정자", charter: "문답을 평가해 제안의 현재 상태를 판정하고 정리합니다." }),
    ]),
  }),
  redteam: Object.freeze({
    id: "redteam",
    name: "Red Team",
    slotCount: 3,
    steps: Object.freeze([
      Object.freeze({ slot: 0, roleName: "제안자", charter: "방어할 제안을 제시합니다." }),
      Object.freeze({ slot: 1, roleName: "공격자", charter: "제안을 무너뜨릴 수 있는 공격 시나리오와 반례를 제시합니다." }),
      Object.freeze({ slot: 0, roleName: "방어자", charter: "공격에 맞서 제안을 방어하거나 수정합니다." }),
      Object.freeze({ slot: 2, roleName: "종합자", charter: "공방 결과 살아남은 것과 무너진 것을 정리합니다." }),
    ]),
  }),
});

function clampCycleBudget(value, stepCount) {
  if (!Number.isInteger(value)) return DEFAULT_DISCUSSION_CYCLE_BUDGET;
  return Math.max(DISCUSSION_CYCLE_BUDGET_MIN, Math.min(maxCycleBudget(stepCount), value));
}

// Preset·참가자 매핑·cycle 수를 실행 가능한 protocol로 확정한다.
// 시작 이후에는 이 결과가 발언 순서의 유일한 기준이다.
function resolveProtocol({ presetId, participantIds, cycleBudget } = {}) {
  const preset = DISCUSSION_PRESETS[String(presetId || "")];
  if (!preset) {
    return { ok: false, error: `알 수 없는 토론 Preset입니다: ${presetId}` };
  }
  const ids = Array.isArray(participantIds)
    ? participantIds.filter((id) => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length !== preset.slotCount) {
    return {
      ok: false,
      error: `${preset.name} Preset에는 참가자 ${preset.slotCount}명의 역할 배정이 필요합니다.`,
    };
  }
  if (new Set(ids).size < 2) {
    return { ok: false, error: "토론에는 서로 다른 참가자가 두 명 이상 필요합니다." };
  }
  const cycles = clampCycleBudget(cycleBudget, preset.steps.length);
  const steps = preset.steps.map((step) => ({
    agentId: ids[step.slot],
    slot: step.slot,
    roleName: step.roleName,
    charter: step.charter,
  }));
  return {
    ok: true,
    protocol: {
      presetId: preset.id,
      presetName: preset.name,
      participantIds: ids,
      steps,
      stepCount: steps.length,
      cycleBudget: cycles,
      totalTurns: steps.length * cycles,
    },
  };
}

// turn(1부터)의 발언자와 임시 역할. 모델 출력이 무엇이든 순서는 여기서만 나온다.
function speakerForTurn(protocol, turn) {
  const index = (turn - 1) % protocol.stepCount;
  const step = protocol.steps[index];
  return {
    agentId: step.agentId,
    role: { name: step.roleName, charter: step.charter },
    cycle: Math.floor((turn - 1) / protocol.stepCount) + 1,
    step: index + 1,
  };
}

// 조기 종료(CONCLUDE)는 cycle의 마지막 단계(종합/판정 slot)에서만 인정한다.
// 중간 단계의 CONCLUDE는 순서 변경 시도로 보고 무시한다(INV-1).
function isFinalStep(protocol, turn) {
  return turn % protocol.stepCount === 0;
}

module.exports = {
  DISCUSSION_PRESETS,
  DISCUSSION_CYCLE_BUDGET_MIN,
  DEFAULT_DISCUSSION_CYCLE_BUDGET,
  DISCUSSION_HARD_TURN_CEILING,
  maxCycleBudget,
  clampCycleBudget,
  resolveProtocol,
  speakerForTurn,
  isFinalStep,
};
