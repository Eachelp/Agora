"use strict";

const { HarnessRuntime } = require("./harness-runtime");
const { ProcessHarnessAdapter } = require("./process-harness-adapter");
const { CodexManagedAdapter } = require("./codex/codex-managed-adapter");
const { ClaudeManagedAdapter } = require("./claude/claude-managed-adapter");

// Stage C-3 — default Managed Harness Runtime 조립.
//
// provider-specific adapter 등록은 이 composition 모듈에만 존재한다. chat-ipc /
// Professional FSM / chat-specialist에 `if (provider === "codex")` 같은 분기를
// 두지 않는다. HarnessRuntime이 capability(supportsPersistentSession)와 SessionKey
// 대상 여부로 adapter를 고르며, 대상이 아니면 ProcessHarnessAdapter one-shot으로
// 귀결된다(일반 채팅 · AGY · 기본 모델 · 비전문(non-professional) Claude는 그대로 process 경로).
//
// native persistent runtime을 붙이는 provider는 Codex(App Server thread)와
// Claude(--resume 기반 role-scoped session) 둘이다. 나머지(AGY/일반 채팅/기본
// 모델)는 그대로 ProcessHarnessAdapter one-shot으로 귀결된다.

function createDefaultHarnessRuntime(options = {}) {
  const runtime = new HarnessRuntime({
    processAdapter: options.processAdapter || new ProcessHarnessAdapter(),
  });
  const codexAdapter = options.codexAdapter || new CodexManagedAdapter(options.codexOptions || {});
  runtime.register("codex", codexAdapter);
  const claudeAdapter = options.claudeAdapter || new ClaudeManagedAdapter(options.claudeOptions || {});
  runtime.register("claude", claudeAdapter);
  return runtime;
}

module.exports = { createDefaultHarnessRuntime };
