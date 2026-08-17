"use strict";

const { HarnessAdapter } = require("./harness-adapter");
const { runAgentProcess } = require("../chat/chat-agent-runner");

// Stage C-1 — ProcessHarnessAdapter
//
// 현재의 process-per-invocation 실행(runAgentProcess → fresh CLI process)을
// HarnessAdapter 경계 뒤로 옮기는 compatibility 구현이다.
//
// 목표는 provider-native persistence를 지금 넣는 것이 아니라, 기존의 안전한
// one-shot 실행을 adapter 계약 뒤로 숨기는 것이다. 따라서 observable behavior는
// 0으로 유지한다: runTurn은 control plane이 확정한 실행 요청을 그대로 process
// runner에 위임하고, runner가 돌려주는 { promise, cancel } handle을 변형 없이
// 반환한다.
//
// runProcess는 테스트에서 주입할 수 있게 열어두지만 기본값은 실제 runAgentProcess다.
// 이렇게 해서 CLI spawn source of truth는 여전히 chat-agent-runner 한 곳뿐이며
// (production logic을 복사해 두 곳에서 유지하지 않는다), 어댑터는 요청의 권한 /
// 모델 / effort / argv / promptTransport / fail-closed semantics를 조용히 바꾸지
// 않는다.

class ProcessHarnessAdapter extends HarnessAdapter {
  constructor({ runProcess = runAgentProcess } = {}) {
    super({ id: "process" });
    this._runProcess = runProcess;
  }

  runTurn(request) {
    return this._runProcess(request);
  }
}

module.exports = { ProcessHarnessAdapter };
