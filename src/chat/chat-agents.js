// 채팅방 에이전트 구성 유틸.
// CLI 탐지/검증은 src/providers/provider-capabilities.js 한 곳에서만 수행하고,
// 이 모듈은 탐지 결과(capability record)와 세션별 설정을 방 참가자로 합칩니다.

const { resolveEffortVariant } = require("../providers/provider-capabilities");

const GROUP_ALIASES = Object.freeze(["all", "everyone", "모두", "전원", "얘들아"]);

function concreteModelOptions(record) {
  return (record.modelOptions || []).filter((option) => option.id && option.id !== "default");
}

function resolvedModel(record, configured) {
  const options = concreteModelOptions(record);
  if (configured && configured !== "default" && options.some((option) => option.id === configured)) {
    return configured;
  }
  if (record.id === "claude") {
    // 별칭(fable/opus/sonnet/haiku)은 설치된 CLI가 아는 그 계열의 최신 모델을
    // 가리키므로 그대로 넘긴다. 예전에는 별칭을 목록의 전체 이름(claude-fable-5 —
    // --help 예시에서 온 옛 고정 버전)으로 바꿔 넘겨, "최신"을 고른 사용자가 조용히
    // 옛 버전을 쓰게 됐다.
    //
    // 목록에 없는 저장값은 **같은 계열의 별칭**으로 돌린다(claude-opus-4 → opus).
    // 예전에는 계열과 무관하게 전부 fable로 보냈는데, 그러면 조회가 한 번 실패해
    // 목록이 기본값으로 줄어든 순간 haiku를 고른 사용자가 아무 안내 없이 더 비싼
    // 모델로 옮겨 갔다. 계열을 알 수 없으면 CLI 기본값에 맡긴다.
    const family = String(configured || "").match(/^(?:claude-)?(fable|opus|sonnet|haiku)\b/i)?.[1]?.toLowerCase();
    const sameFamily = family ? options.find((option) => option.id === family) : null;
    if (sameFamily) return sameFamily.id;
    return options.find((option) => option.id === "fable")?.id || options[0]?.id || "default";
  }
  // 모델 옵션을 조회하지 못하면 "unknown"을 넘겨 호출을 실패시키는 대신
  // 기본 모델(모델 옵션 생략)로 실행하게 한다.
  return options.find((option) => option.isDefault)?.id || options[0]?.id || "default";
}

function resolvedEffort(record, model, configured) {
  if (record.id === "agy" && /^(claude-|gpt-oss-)/i.test(String(model || ""))) {
    return "default";
  }
  const option = concreteModelOptions(record).find((entry) => entry.id === model);
  const efforts = (Array.isArray(option?.efforts) ? option.efforts : record.efforts || [])
    .filter((effort) => effort !== "default");
  if (configured && configured !== "default" && efforts.includes(configured)) return configured;
  const suffix = String(model).match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
  if (suffix && efforts.includes(suffix)) return suffix;
  if (efforts.includes("medium")) return "medium";
  return efforts[0] || "default";
}

// 예전 세션은 노력이 붙은 변형 id(gemini-3.7-flash-high)를 모델로 저장해 두었습니다.
// 지금 목록은 모델과 노력을 나눠 두므로 저장값을 (모델, 노력) 쌍으로 옮겨 읽습니다.
// 그대로 두면 목록에 없는 모델이라 엉뚱한 기본 모델로 떨어집니다.
function migrateEffortVariant(record, config) {
  const variant = resolveEffortVariant(record.modelOptions, config.model);
  if (!variant) return { model: config.model, effort: config.effort };
  return {
    model: variant.model,
    effort: config.effort && config.effort !== "default" ? config.effort : variant.effort,
  };
}

// capability record + 세션 설정 → 채팅방 참가자.
// commandPath/needsShell 같은 실행 정보는 여기서 제거되어 방/renderer로 가지 않습니다.
function roomAgentFromCapability(record, config = {}) {
  const migrated = migrateEffortVariant(record, config);
  const model = resolvedModel(record, migrated.model);
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    aliases: [...(record.aliases || [record.id])],
    available: record.status === "cli",
    enabled: config.enabled !== false,
    reason: record.reason || "",
    version: record.version || "",
    model,
    effort: resolvedEffort(record, model, migrated.effort),
    autoApprove: Boolean(config.autoApprove),
  };
}

function roomAgentsFromCapabilities(records, sessionAgents = {}) {
  return (records || []).map((record) =>
    roomAgentFromCapability(record, sessionAgents[record.id] || {})
  );
}

module.exports = {
  GROUP_ALIASES,
  concreteModelOptions,
  migrateEffortVariant,
  resolvedModel,
  resolvedEffort,
  roomAgentFromCapability,
  roomAgentsFromCapabilities,
};
