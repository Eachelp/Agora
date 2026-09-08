const test = require("node:test");
const assert = require("node:assert/strict");
const { roomAgentFromCapability } = require("../src/chat/chat-agents");

function record(id, modelOptions, efforts = ["default", "low", "medium", "high"]) {
  return {
    id,
    name: id,
    status: "cli",
    aliases: [id],
    modelOptions,
    efforts,
  };
}

test("default 설정을 Claude 최신 별칭(fable)과 중간 추론으로 해석한다", () => {
  const options = [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "fable", efforts: ["default", "low", "medium", "high"] },
    { id: "opus", efforts: ["default", "low", "medium", "high"] },
  ];
  const agent = roomAgentFromCapability(record("claude", options), { model: "default", effort: "default" });
  assert.equal(agent.model, "fable");
  assert.equal(agent.effort, "medium");
  // 사용자가 고른 별칭은 그대로 CLI에 넘긴다(다른 이름으로 바꾸지 않는다).
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "opus" }).model, "opus");
});

test("Claude 별칭(fable)을 목록의 고정 전체 이름으로 바꿔 넘기지 않는다", () => {
  // 예전에는 --help 예시에서 온 claude-fable-5(옛 고정 버전)가 목록에 있으면
  // "fable"을 고른 사용자도 그 옛 버전으로 실행됐다. 별칭은 최신을 뜻하므로 그대로 둔다.
  const options = [
    { id: "default", efforts: ["default", "low"] },
    { id: "fable", efforts: ["default", "low"] },
    { id: "claude-fable-5", efforts: ["default", "low"] },
  ];
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "fable" }).model, "fable");
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "default" }).model, "fable");
  // 목록에 있는 전체 이름을 직접 고른 경우는 존중한다.
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "claude-fable-5" }).model, "claude-fable-5");
  // 예전 목록에서 저장된 전체 이름이 지금 목록에 없으면 최신 별칭으로 돌아간다.
  const current = [
    { id: "default", efforts: ["default", "low"] },
    { id: "fable", efforts: ["default", "low"] },
  ];
  assert.equal(roomAgentFromCapability(record("claude", current), { model: "claude-fable-5" }).model, "fable");
});

test("Codex 카탈로그의 실제 기본 모델을 선택하고 default 문자열을 남기지 않는다", () => {
  const agent = roomAgentFromCapability(record("codex", [
    { id: "default", efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-sol", isDefault: true, efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-terra", efforts: ["medium"] },
  ]), {});
  assert.equal(agent.model, "gpt-5.6-sol");
  assert.equal(agent.effort, "medium");
});

test("AGY 모델명에 포함된 추론 강도를 실제 effort로 맞춘다", () => {
  const agent = roomAgentFromCapability(record("agy", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "gemini-3.6-flash-high", efforts: ["default", "low", "medium", "high"] },
  ]), {});
  assert.equal(agent.model, "gemini-3.6-flash-high");
  assert.equal(agent.effort, "high");
});

test("AGY 고정 모델은 예전에 저장된 effort를 실행 전에 제거한다", () => {
  const options = [
    { id: "default", efforts: [] },
    // 오래된 AGY capability cache가 잘못된 effort 목록을 가지고 있는 경우도 포함한다.
    { id: "claude-sonnet-4-6", efforts: ["default", "low", "medium", "high"] },
    { id: "claude-opus-4-6-thinking", efforts: ["default", "low", "medium", "high"] },
    { id: "gpt-oss-120b-medium", efforts: ["default", "low", "medium", "high"] },
  ];
  const claude = roomAgentFromCapability(record("agy", options), {
    model: "claude-sonnet-4-6",
    effort: "medium",
  });
  const gpt = roomAgentFromCapability(record("agy", options), {
    model: "gpt-oss-120b-medium",
    effort: "high",
  });
  assert.equal(claude.effort, "default");
  const opus = roomAgentFromCapability(record("agy", options), {
    model: "claude-opus-4-6-thinking",
    effort: "medium",
  });
  assert.equal(gpt.effort, "default");
  assert.equal(opus.effort, "default");
});

test("예전에 저장한 gemini 변형 id는 접힌 모델과 노력으로 이관된다", () => {
  const modelOptions = [
    { id: "default", efforts: [] },
    {
      id: "gemini-3.7-flash",
      efforts: ["low", "medium", "high"],
      effortModels: {
        low: "gemini-3.7-flash-low",
        medium: "gemini-3.7-flash-medium",
        high: "gemini-3.7-flash-high",
      },
    },
    { id: "claude-sonnet-4-6", efforts: [] },
  ];

  // 이관이 없으면 목록에 없는 모델이라 엉뚱한 기본 모델로 떨어집니다.
  const migrated = roomAgentFromCapability(record("agy", modelOptions), {
    model: "gemini-3.7-flash-low",
    effort: "default",
  });
  assert.equal(migrated.model, "gemini-3.7-flash");
  assert.equal(migrated.effort, "low");

  // 사용자가 노력을 따로 골라 뒀다면 그 선택을 유지합니다.
  const kept = roomAgentFromCapability(record("agy", modelOptions), {
    model: "gemini-3.7-flash-low",
    effort: "high",
  });
  assert.equal(kept.model, "gemini-3.7-flash");
  assert.equal(kept.effort, "high");

  // 이미 접힌 id로 저장된 설정은 그대로 둡니다.
  const current = roomAgentFromCapability(record("agy", modelOptions), {
    model: "gemini-3.7-flash",
    effort: "medium",
  });
  assert.equal(current.model, "gemini-3.7-flash");
  assert.equal(current.effort, "medium");
});

test("목록에 없는 저장값은 같은 계열의 별칭으로 돌아간다", () => {
  const options = [
    { id: "default", efforts: ["default", "low"] },
    { id: "fable", efforts: ["default", "low"] },
    { id: "opus", efforts: ["default", "low"] },
    { id: "haiku", efforts: ["default", "low"] },
  ];
  // 계열을 알 수 있으면 그 계열의 최신 별칭으로 간다. 예전에는 계열과 무관하게
  // 전부 fable로 보내, 목록이 잠깐 줄어든 사이 사용자가 고른 것보다 비싼 모델로
  // 조용히 옮겨 갔다.
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "claude-opus-4" }).model, "opus");
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "claude-haiku-4-5" }).model, "haiku");
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "claude-fable-5" }).model, "fable");
  // 계열조차 알 수 없으면 예전처럼 최신 별칭으로 돌아간다.
  assert.equal(roomAgentFromCapability(record("claude", options), { model: "무엇인지-모를-이름" }).model, "fable");
});
