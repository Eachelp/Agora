"use strict";

// HarnessAdapter 경계 (transport / runtime abstraction)
//
// Agora control plane(project workspace authority · permission · RunMetrics)은
// 이 경계 "위"에 남는다. (옛 Professional FSM·Frozen Task·Evidence는 단계 3에서 제거됐다.)
// HarnessAdapter는 control plane이 이미 확정한 실행 요청을 받아 한 번의 turn을
// 실행하고 canonical run handle을 돌려주는 transport일 뿐이다.
//
// 어댑터가 계약상 하지 않는 것 (= control-plane authority를 가져가지 않는다):
//   - project workspace authority를 결정하지 않는다.
//   - role context를 스스로 추가하거나 변경하지 않는다.
//   - permission mode를 완화하지 않는다.
//   - 기존 fail-closed 경로에 fallback을 추가하지 않는다.
//
// runTurn({ context, invocation }) 계약
// ---------------------------------------------------------------------
//   context    : control plane이 이미 결정한 logical/session/security metadata
//                (projectId, workspaceId, providerId, modelKey,
//                 permissionMode, effort ...).
//                transport는 이를 실행 의미로 재해석하지 않는다.
//   invocation : 현재 process runner(runAgentProcess)가 소비하는 실행 payload.
//   반환       : { promise, cancel } — 기존 호출자(ChatRoom)가 그대로 사용한다.

class HarnessAdapter {
  constructor({ id } = {}) {
    this.id = id || null;
  }

  // 하위 어댑터가 반드시 구현한다. 기본 구현은 조용히 성공을 흉내내지 않고
  // fail-closed로 명시적 오류를 던진다(현재 process runner의 실패를 성공으로
  // 승격하지 않는다는 계약과 동일한 방향).
  runTurn() {
    throw new Error(
      `HarnessAdapter(${this.id || "unknown"})가 runTurn을 구현하지 않았습니다.`
    );
  }
}

module.exports = { HarnessAdapter };
