"use strict";

// Professional Mode 상태별 허용 IPC를 fail-closed로 정의하는 중앙 정책 테이블.
// 일반 채팅·토론·Handoff 메시지가 활성 전문 실행 중에 섞여 들어오지 않게
// 차단의 기준이 된다. 허용 목록에 없는 IPC는 항상 거부(fail-closed)한다.
//
// 상태는 (node, status) 조합으로 식별한다. COMPLETED는 전문 실행이 끝나
// 일반 채팅/Handoff/기록 재생성이 허용되는 상태다.
//
// IPC 액션 식별자:
//   send             일반 채팅 메시지 전송(전문 실행이 없을 때 허용)
//   planAnswer       기획 질문/검수 피드백 답변 (chat:specialist:answer)
//   planEdit         승인된 기획을 수정 -> PLANNING 복귀
//   cancel           전문 실행 취소
//   startImpl        구현 시작 (USER_EXECUTE)
//   startFull        전체 실행 승인
//   resume           전문 실행 재개 (구현/검수 등)
//   blockedAction    BLOCKED 후속 처리 (keep/restore/replan)
//   blockDetails     BLOCKED 상세 보기
//   continueReview   검수 이어가기
//   continueRecord   기록 이어가기
//   retryRecorder    기록 재시도
//   recordRegen      기록 재생성
//   discussion       자율 토론 시작
//   handoff          메시지 전달 (다른 AI에게)
//   simplify         쉽게 설명(메시지 재작성)
//   interject        사용자 개입(말 끼어들기)
//   recordOnly-send  전문 실행 중 사용자 작업 요청만 기록(드래프트)

const nodeStatusKey = ({ node, status }) => `${node || "?"}:${status || "?"}`;

const POLICY_TABLE = {
  "PLANNING:RUNNING": ["cancel"],
  "PLANNING:WAITING": ["planAnswer", "cancel", "recordOnly-send"],
  "PLAN_REVIEW:RUNNING": ["cancel"],
  "PLAN_REVIEW:WAITING": ["planAnswer", "cancel", "recordOnly-send"],
  "READY:WAITING": ["startImpl", "startFull", "planEdit", "cancel", "recordOnly-send"],
  "IMPLEMENTING:RUNNING": ["cancel"],
  "IMPLEMENTING:WAITING": ["resume", "cancel"],
  "IMPLEMENTING:BLOCKED": ["blockedAction", "blockDetails", "cancel"],
  "REVIEWING:RUNNING": ["cancel"],
  "REVIEWING:WAITING": ["resume", "continueReview", "continueRecord", "cancel"],
  "RECORDING:RUNNING": ["cancel"],
  "RECORDING:WAITING": ["retryRecorder", "recordRegen", "cancel"],
  "COMPLETED:COMPLETED": ["send", "startImpl", "startFull", "recordRegen", "discussion", "handoff", "simplify"],
};

// 전문 실행이 활성(COMPLETED 아님)인 상태에서 허용되는 IPC만 반환한다.
function allowedIpcFor(runState = {}) {
  const key = nodeStatusKey(runState);
  if (POLICY_TABLE[key] !== undefined) return POLICY_TABLE[key];
  return [];
}

// runState가 활성 전문 실행을 나타내는지(COMPLETED 아님) 여부.
function isActiveProfessionalRun(runState = {}) {
  return runState != null && runState.node !== "COMPLETED" && runState.status !== "COMPLETED";
}

function isStateAllowed(runState, action) {
  if (!isActiveProfessionalRun(runState)) return true;
  return allowedIpcFor(runState).includes(action);
}

module.exports = {
  allowedIpcFor,
  isActiveProfessionalRun,
  isStateAllowed,
  POLICY_TABLE,
};
