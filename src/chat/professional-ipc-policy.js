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
  "PLANNING:WAITING": ["planAnswer", "cancel"],
  "PLAN_REVIEW:RUNNING": ["cancel"],
  "PLAN_REVIEW:WAITING": ["planAnswer", "cancel"],
  "READY:WAITING": ["startImpl", "startFull", "planEdit", "cancel"],
  "IMPLEMENTING:RUNNING": ["cancel"],
  "IMPLEMENTING:WAITING": ["resume", "cancel"],
  "IMPLEMENTING:BLOCKED": ["blockedAction", "blockDetails", "cancel"],
  "REVIEWING:RUNNING": ["cancel"],
  "REVIEWING:WAITING": ["resume", "continueReview", "continueRecord", "cancel"],
  "RECORDING:RUNNING": ["cancel"],
  "RECORDING:WAITING": ["retryRecorder", "recordRegen", "cancel"],
  "COMPLETED:COMPLETED": ["send", "startImpl", "startFull", "recordRegen", "discussion", "handoff", "simplify"],
};

// 표에 없는 (node, status) 조합에서도 남겨 두는 탈출 동작.
// 전문 실행을 시작하거나 진전시키는 동작(startImpl/startFull/resume/planAnswer/
// planEdit/continue*/retry*)은 절대 포함하지 않는다. 여기 있는 것들은 실행을
// 앞으로 밀지 않고 권한도 넓히지 않는, 나가는 방향의 동작뿐이다.
const EXIT_ACTIONS = Object.freeze(["send", "discussion", "handoff", "simplify", "blockDetails", "cancel"]);

// 전문 실행이 활성(COMPLETED 아님)인 상태에서 허용되는 IPC만 반환한다.
function allowedIpcFor(runState = {}) {
  const key = nodeStatusKey(runState);
  if (POLICY_TABLE[key] !== undefined) return POLICY_TABLE[key];
  // 표에 없는 조합은 여전히 fail-closed지만, 사용자를 상태에 가두지는 않는다.
  // INTERRUPT 전이는 어떤 node에서든 status를 INTERRUPTED로 바꿀 수 있고 앱을
  // 실행 도중 닫아도 복원 시 INTERRUPTED가 되는데, 그 조합이 표에 하나도 없어서
  // 허용 목록이 비었다. 그래서 PLAN을 취소하기만 해도 그 세션에서는 다시 대화도
  // 토론도 취소도 할 수 없었다. fail-closed는 실행을 진전시키는 동작에 적용하는
  // 것이지 일반 대화로 돌아가는 것을 막는 데 쓰는 것이 아니다.
  // 실제로 turn이 떠 있는 상태(RUNNING)에서는 취소만 남긴다.
  if (runState.status === "RUNNING") return ["cancel"];
  return EXIT_ACTIONS;
}

// runState가 활성 전문 실행을 나타내는지(COMPLETED/COMPLETED가 아님) 여부.
// 일관되지 않은 상태(COMPLETED/WAITING, READY/COMPLETED 등)도 모두 활성으로 보아
// fail-closed로 차단한다.
function isActiveProfessionalRun(runState = null) {
  if (!runState) return false;
  return !(
    runState.node === "COMPLETED" &&
    runState.status === "COMPLETED"
  );
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
