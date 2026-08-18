"use strict";

// AGY stream-json 계약 테스트 — 1.1.14 실출력(사용자 로컬 캡처)을 기대값으로 고정한다.
// CLI 업데이트로 이 구조가 바뀌면 이 테스트가 먼저 깨져서 조용한 누락을 막는다.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAgyLine, createLineParser } = require("../src/chat/chat-events");

const CID = "e069598f-d168-497f-b632-ec7bf9d99331";

function initLine(id) {
  return JSON.stringify({
    event: "init",
    conversation_id: id,
    init: { cwd: "C:\\Users\\csm85", tools: ["run_command", "read_file"], permission_mode: "request-review" },
  });
}

function agentDelta(id, stepIndex, text, state) {
  return JSON.stringify({
    event: "step_update",
    step_update: { conversation_id: id, step_index: stepIndex, state: state || "ACTIVE", step_type: "agent_response", text_delta: text },
  });
}

function toolActive(id, stepIndex, toolName, commandLine) {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: id, step_index: stepIndex, state: "ACTIVE", step_type: "tool",
      tool_name: toolName, tool_info: { name: toolName, parameters: { CommandLine: commandLine } },
    },
  });
}

function toolDone(id, stepIndex, toolName, commandLine, output) {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: id, step_index: stepIndex, state: "DONE", step_type: "tool",
      tool_name: toolName, tool_info: { name: toolName, parameters: { CommandLine: commandLine }, output },
    },
  });
}

function toolPermissionError(id, stepIndex, toolName, commandLine) {
  return JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: id, step_index: stepIndex, state: "ERROR", step_type: "tool",
      tool_name: toolName,
      tool_info: { name: toolName, parameters: { CommandLine: commandLine }, error: { type: "TOOL_ERROR", message: "User denied permission to run command:\n" + commandLine } },
    },
  });
}

function resultLine(id, status, response) {
  return JSON.stringify({ event: "result", result: { conversation_id: id, status, response } });
}

test("agy 1.1.14: agent_response text_delta는 실시간 delta로 정규화된다", () => {
  const e = parseAgyLine(agentDelta(CID, 2, "Hello! How can I help?"));
  assert.deepEqual(e, { kind: "delta", text: "Hello! How can I help?" });
});

test("agy 1.1.14: run_command ACTIVE는 command-started, 실제 명령어를 담는다", () => {
  const e = parseAgyLine(toolActive(CID, 3, "run_command", "(Get-Location).Path"));
  assert.equal(e.kind, "command-started");
  assert.equal(e.command, "(Get-Location).Path");
  assert.equal(e.toolUseId, "3", "1.1.14는 step_index를 step id로 쓴다");
});

test("agy 1.1.14: run_command DONE은 command-finished(exit 0, 출력 포함)", () => {
  const e = parseAgyLine(toolDone(CID, 3, "run_command", "node -v", "v24.18.0\r\n"));
  assert.equal(e.kind, "command-finished");
  assert.equal(e.command, "node -v");
  assert.equal(e.exitCode, 0);
  assert.equal(e.stdoutTail, "v24.18.0\r\n");
  assert.equal(e.executionStatus, "OBSERVED");
});

test("agy 1.1.14: 권한 거부 ERROR는 approval-required로 유지된다", () => {
  const e = parseAgyLine(toolPermissionError(CID, 3, "run_command", "(Get-Location).Path"));
  assert.equal(e.kind, "approval-required");
  assert.match(e.detail, /permission/i);
});

test("agy 1.1.14: result SUCCESS + response는 final이다", () => {
  const e = parseAgyLine(resultLine(CID, "SUCCESS", "The command printed:\n```\nv24.18.0\n```\n"));
  assert.deepEqual(e, { kind: "final", text: "The command printed:\n```\nv24.18.0\n```\n" });
});

test("agy 1.1.14: createLineParser가 init/step/result의 conversation_id를 캡처한다", () => {
  const captured = [];
  const parser = createLineParser("agy", { onConversationId: (id) => captured.push(id) });
  parser(initLine(CID));
  parser(toolActive(CID, 3, "run_command", "node -v"));
  parser(resultLine(CID, "SUCCESS", "ok"));
  assert.ok(captured.length >= 3, "init/step_update/result 세 위치에서 캡처");
  for (const id of captured) assert.equal(id, CID);
});

