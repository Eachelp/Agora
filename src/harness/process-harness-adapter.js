"use strict";

const { HarnessAdapter } = require("./harness-adapter");
const { runAgentProcess } = require("../chat/chat-agent-runner");

// Stage C-1/C-2 — ProcessHarnessAdapter
//
// 현재의 process-per-invocation 실행(runAgentProcess → fresh CLI process)을
// HarnessAdapter 경계 뒤로 옮기는 compatibility 구현이다. sessionless이며
// supportsPersistentSession=false다 — C-2 production 실행은 항상 이 경로로 귀결된다.
//
// observable behavior는 0으로 유지한다: runTurn은 canonical { context, invocation }에서
// invocation만 꺼내 process runner에 그대로 위임하고, runner가 돌려주는
// { promise, cancel } handle을 변형 없이 반환한다. context는 실행 의미로 재해석하지
// 않는다(권한/모델/effort/argv/promptTransport/fail-closed semantics를 조용히 바꾸지 않음).
//
// runProcess는 테스트 주입용으로 열어두지만 기본값은 실제 runAgentProcess다. 이렇게 해서
// CLI spawn source of truth는 여전히 chat-agent-runner 한 곳뿐이다(로직 복제 없음).

class ProcessHarnessAdapter extends HarnessAdapter {
  constructor({ runProcess = runAgentProcess } = {}) {
    super({ id: "process", supportsPersistentSession: false });
    this._runProcess = runProcess;
  }

  runTurn(request = {}) {
    // canonical: { context, invocation }. context는 무시(sessionless).
    // 최소 호환 bridge: invocation 키가 없으면 request 자체를 flat invocation으로 본다.
    const invocation = request && Object.prototype.hasOwnProperty.call(request, "invocation")
      ? request.invocation
      : request;
    return this._runProcess(invocation);
  }
}

module.exports = { ProcessHarnessAdapter };
