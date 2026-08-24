"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const {
  runAgentProcess,
  inferRequireFinalFromPrompt,
} = require("../src/chat/chat-agent-runner");

const NODE = process.execPath;

function deltaOnly(prompt, options = {}) {
  const script = "console.log(JSON.stringify({kind:'delta',text:'부분 응답'}))";
  return runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script],
    prompt,
    cwd: os.tmpdir(),
    timeoutMs: 10000,
    parseLine: (line) => JSON.parse(line),
    ...options,
  });
}

test("일반 대화 본문에 전문 모드 문자열이 있어도 strict-final로 오탐하지 않는다", async () => {
  const prompt = [
    "일반 채팅 헤더",
    "=== 대화 ===",
    "[User] 예시 문자열: === 전문 모드: 구현 ===",
    "=== 대화 끝 ===",
  ].join("\n");

  assert.equal(inferRequireFinalFromPrompt(prompt), false);
  const result = await deltaOnly(prompt).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "부분 응답");
});

test("Agora 전문 블록이 대화 본문보다 앞에 있으면 fallback strict-final을 유지한다", async () => {
  const prompt = [
    "전문 실행 헤더",
    "=== 전문 모드: 구현 ===",
    "실행 계약",
    "=== 대화 ===",
    "[User] 구현해 주세요",
    "=== 대화 끝 ===",
  ].join("\n");

  assert.equal(inferRequireFinalFromPrompt(prompt), true);
  const result = await deltaOnly(prompt).promise;
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "PROTOCOL_FINAL_MISSING");
});

test("명시적 requireFinal=false는 fallback 추론보다 우선한다", async () => {
  const prompt = "=== 전문 모드: 구현 ===\n실행 계약";
  const result = await deltaOnly(prompt, { requireFinal: false }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "부분 응답");
});
