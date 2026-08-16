"use strict";

const SUPPORTED_PROCESS_PROVIDERS = Object.freeze(new Set(["claude", "codex", "agy"]));

function processProviderPolicy(provider) {
  const id = String(provider?.id || "").trim();
  if (!id) {
    return { ok: false, reason: "PROVIDER_ID_MISSING", error: "프로바이더 식별자가 없습니다." };
  }
  if (!SUPPORTED_PROCESS_PROVIDERS.has(id)) {
    return {
      ok: false,
      reason: "UNSUPPORTED_PROCESS_PROVIDER",
      error: `등록되지 않은 Agent Harness(${id})는 Process runner로 직접 실행하지 않습니다. HarnessAdapter를 등록해 주세요.`,
    };
  }
  return { ok: true, providerId: id };
}

module.exports = {
  SUPPORTED_PROCESS_PROVIDERS,
  processProviderPolicy,
};
