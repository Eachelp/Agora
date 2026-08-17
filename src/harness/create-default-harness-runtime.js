"use strict";

const { HarnessRuntime } = require("./harness-runtime");
const { ProcessHarnessAdapter } = require("./process-harness-adapter");
const { CodexManagedAdapter } = require("./codex/codex-managed-adapter");

// Stage C-3 — default Managed Harness Runtime 조립.
//
// provider-specific adapter 등록은 이 composition 모듈에만 존재한다. chat-ipc /
// Professional FSM / chat-specialist에 `if (provider === "codex")` 같은 분기를
// 두지 않는다. HarnessRuntime이 capability(supportsPersistentSession)와 SessionKey
// 대상 여부로 adapter를 고르며, 대상이 아니면 ProcessHarnessAdapter one-shot으로
// 귀결된다(general chat / Claude / AGY / default-model Codex는 그대로 process 경로).
//
// C-3에서 native persistent runtime을 붙이는 provider는 Codex 하나뿐이다.

function createDefaultHarnessRuntime(options = {}) {
  const runtime = new HarnessRuntime({
    processAdapter: options.processAdapter || new ProcessHarnessAdapter(),
  });
  const codexAdapter = options.codexAdapter || new CodexManagedAdapter(options.codexOptions || {});
  runtime.register("codex", codexAdapter);
  return runtime;
}

module.exports = { createDefaultHarnessRuntime };
