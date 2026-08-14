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

test("default 설정을 실제 Claude Fable 모델과 중간 추론으로 해석한다", () => {
  const agent = roomAgentFromCapability(record("claude", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "fable", efforts: ["default", "low", "medium", "high"] },
    { id: "claude-fable-5", efforts: ["default", "low", "medium", "high"] },
  ]), { model: "default", effort: "default" });
  assert.equal(agent.model, "claude-fable-5");
  assert.equal(agent.effort, "medium");
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
