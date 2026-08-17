"use strict";

// Stage C-1 — HarnessAdapter 경계 (transport / runtime abstraction)
//
// Agora control plane(Professional FSM · Frozen Task · project workspace
// authority · permission · Evidence · RunMetrics)은 이 경계 "위"에 남는다.
// HarnessAdapter는 control plane이 이미 확정한 provider-neutral 실행 요청을
// 받아 한 번의 turn을 실행하고 canonical run handle을 돌려주는 transport일 뿐이다.
//
// 어댑터가 계약상 하지 않는 것 (= control-plane authority를 가져가지 않는다):
//   - Frozen Task / Requirements truth를 소유하지 않는다.
//   - project workspace authority를 결정하지 않는다.
//   - role context를 스스로 추가하거나 변경하지 않는다.
//   - permission mode를 완화하지 않는다.
//   - 기존 fail-closed 경로에 fallback을 추가하지 않는다.
//   - self-report만으로 Evidence를 PASS 처리하지 않는다.
//
// C-1에서 실제로 필요한 최소 contract는 runTurn 하나다. 개발일지 §10의 장기
// 방향(startSession / resumeSession / invalidateSession / approve / health /
// shutdown 등)은 아직 도입하지 않는다 — 지금부터 세션 semantics를 억지로
// 넣지 않기 위해서다. 후속 Stage C-2+에서 실제 필요가 생길 때 확장한다.
//
// runTurn(request) 계약
// ---------------------
//   request : control plane이 이미 해석한, provider-neutral 한 turn 실행 요청.
//             어댑터는 이를 불투명(opaque) payload로 취급하고 재해석/재작성하지
//             않는다. (C-1의 ProcessHarnessAdapter는 그대로 process runner에
//             위임하므로 구조는 runAgentProcess의 입력과 동일하다.)
//   반환    : { promise, cancel }
//             promise -> 실행 결과(result)로 resolve.
//             cancel() -> 진행 중인 turn 취소.
//             이 handle 모양은 기존 호출자(ChatRoom)가 그대로 사용한다.

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
