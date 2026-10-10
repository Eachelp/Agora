"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");

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

// 프롬프트 문구로 strict-final을 추론하지 않는다. 옛 전문 모드 표식이 들어 있어도 같다.
test("프롬프트에 옛 전문 모드 표식이 있어도 requireFinal을 추론하지 않는다", async () => {
  const prompt = "=== 전문 모드: 구현 ===\n실행 계약\n=== 대화 ===\n[User] 구현해 주세요";
  const result = await deltaOnly(prompt).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "부분 응답");
});

test("명시적 requireFinal=true는 final이 없으면 delta를 완료로 승격하지 않는다", async () => {
  const result = await deltaOnly("안녕", { requireFinal: true }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "PROTOCOL_FINAL_MISSING");
});

test("명시적 requireFinal=false는 delta를 결과로 쓴다", async () => {
  const result = await deltaOnly("안녕", { requireFinal: false }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "부분 응답");
});
