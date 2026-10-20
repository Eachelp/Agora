"use strict";

// 실행별 토큰 기록(2026-10-20): 공급자별 사용량 줄 읽기, run-metrics 저장 형식, 러너 연결.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageCollector, normalizeTokens } = require("../src/chat/chat-usage");
const { createLineParser } = require("../src/chat/chat-events");
const { buildRunMetrics } = require("../src/chat/chat-run-metrics");
const { persistRunMetrics } = require("../src/chat/chat-run-metrics-store");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");

const json = (value) => JSON.stringify(value);

const CLAUDE_LINES = [
  json({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
  json({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 99 } } }),
  json({ type: "assistant", message: { content: [{ type: "text", text: "{\"type\":\"result\"} 라는 문자열이 본문에 있다" }] } }),
  // 실측 키 순서: type이 줄 끝쪽에 온다.
  json({
    duration_api_ms: 2014441,
    stop_reason: "end_turn",
    total_cost_usd: 21.18,
    usage: {
      input_tokens: 132,
      cache_creation_input_tokens: 461085,
      cache_read_input_tokens: 21777844,
      output_tokens: 281333,
      output_tokens_details: { thinking_tokens: 190000 },
    },
    subtype: "success",
    result: "완료",
    type: "result",
    duration_ms: 2100000,
  }),
];

test("Claude: result 줄의 usage와 비용을 읽고, 본문에 같은 문자열이 있는 줄은 무시한다", () => {
  const collector = createUsageCollector("claude");
  for (const line of CLAUDE_LINES) collector.observeLine(line);
  assert.deepEqual(collector.snapshot(), {
    inputTokens: 132,
    cacheReadTokens: 21777844,
    cacheWriteTokens: 461085,
    outputTokens: 281333,
    reasoningTokens: 190000,
    costUsd: 21.18,
  });
});

test("Codex: turn.completed마다 더하고, 입력에서 캐시 부분을 빼서 다른 공급자와 기준을 맞춘다", () => {
  const collector = createUsageCollector("codex");
  collector.observeLine(json({ type: "turn.started" }));
  collector.observeLine(json({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, reasoning_output_tokens: 20 } }));
  collector.observeLine(json({ type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 600, output_tokens: 10 } }));
  assert.deepEqual(collector.snapshot(), {
    inputTokens: 200,
    cacheReadTokens: 1400,
    cacheWriteTokens: 0,
    outputTokens: 60,
    reasoningTokens: 20,
    costUsd: null,
  });
});

test("AGY: result.usage를 읽고, 단계별 usage는 합산하지 않는다", () => {
  const collector = createUsageCollector("agy");
  collector.observeLine(json({ event: "step_update", step_update: { state: "DONE", usage: { input_tokens: 2303, output_tokens: 2688 } } }));
  collector.observeLine(json({
    event: "result",
    result: { status: "SUCCESS", usage: { input_tokens: 1235508, output_tokens: 144000, thinking_tokens: 47521, cache_read_tokens: 16639394, total_tokens: 1379508 } },
  }));
  assert.deepEqual(collector.snapshot(), {
    inputTokens: 1235508,
    cacheReadTokens: 16639394,
    cacheWriteTokens: 0,
    outputTokens: 144000,
    reasoningTokens: 47521,
    costUsd: null,
  });
});

test("사용량 줄이 없거나 알 수 없는 공급자면 기록하지 않는다", () => {
  const collector = createUsageCollector("claude");
  collector.observeLine(json({ type: "assistant", message: {} }));
  collector.observeLine("not json {");
  collector.observeLine(json({ type: "result", subtype: "error" }));
  assert.equal(collector.snapshot(), null);
  assert.equal(createUsageCollector("unknown"), null);
});

test("줄 파서가 사용량을 모아 getUsage로 내준다(공급자별)", () => {
  const claude = createLineParser("claude");
  for (const line of CLAUDE_LINES) claude(line);
  assert.equal(claude.getUsage().outputTokens, 281333);
  const codex = createLineParser("codex");
  codex(json({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }));
  assert.deepEqual(codex.getUsage(), { inputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, costUsd: null });
  assert.equal(createLineParser("agy").getUsage(), null);
});

test("run-metrics: tokens는 있을 때만 실리고, 저장 경계에서 모양을 한 번 더 맞춘다", () => {
  const base = { startedAt: 1, finishedAt: 2, result: { ok: true } };
  assert.equal("tokens" in buildRunMetrics(base), false);
  assert.equal("tokens" in buildRunMetrics({ ...base, tokens: null }), false);
  const metrics = buildRunMetrics({ ...base, tokens: { inputTokens: 5, outputTokens: -3, cacheReadTokens: "x", costUsd: -1, extra: 1 } });
  assert.deepEqual(metrics.tokens, { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null });
  assert.equal(metrics.schemaVersion, 1);
  assert.equal(normalizeTokens(undefined), null);
});

test("run-metrics 파일: tokens를 저장했다 읽어도 값이 그대로고, 없으면 필드가 없다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-usage-"));
  try {
    const store = { runLogsDir: (sessionId) => path.join(root, sessionId, "runs") };
    const metrics = { startedAt: 100, finishedAt: 350, promptChars: 10, stdoutBytes: 1, ok: true, stopReason: "COMPLETED" };
    const tokens = { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 5, costUsd: 0.5 };
    assert.equal(persistRunMetrics({ store, sessionId: "s", runId: "with", provider: "claude", metrics: { ...metrics, tokens } }).ok, true);
    assert.equal(persistRunMetrics({ store, sessionId: "s", runId: "without", provider: "claude", metrics }).ok, true);
    const read = (runId) => JSON.parse(fs.readFileSync(path.join(store.runLogsDir("s"), `${runId}.metrics.json`), "utf8"));
    assert.deepEqual(read("with").tokens, tokens);
    assert.equal("tokens" in read("without"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("러너: 공급자 출력의 사용량이 결과의 runMetrics.tokens로 나온다", async () => {
  const script = [
    `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'끝'}}))`,
    `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:900,cached_input_tokens:700,output_tokens:40,reasoning_output_tokens:12}}))`,
  ].join(";");
  const result = await runAgentProcess({
    commandPath: process.execPath,
    argv: ["-e", script],
    prompt: "",
    cwd: os.tmpdir(),
    parseLine: createLineParser("codex"),
  }).promise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.runMetrics.tokens, { inputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 0, outputTokens: 40, reasoningTokens: 12, costUsd: null });

  const plain = await runAgentProcess({ commandPath: process.execPath, argv: ["-e", "process.stdout.write('완료')"], prompt: "", cwd: os.tmpdir() }).promise;
  assert.equal("tokens" in plain.runMetrics, false, "파서가 없는 실행에는 tokens가 없다");
});

test("AGY: result 줄의 키 순서가 달라도 사용량을 읽고, 단계별 usage는 여전히 합산하지 않는다", () => {
  const collector = createUsageCollector("agy");
  collector.observeLine(json({ result: { status: "SUCCESS", usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 6 } }, event: "result" }));
  assert.deepEqual(collector.snapshot(), { inputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 2, costUsd: null });
  const steps = createUsageCollector("agy");
  steps.observeLine(json({ step_update: { state: "DONE", usage: { input_tokens: 5, output_tokens: 5 } }, event: "step_update" }));
  assert.equal(steps.snapshot(), null);
});
