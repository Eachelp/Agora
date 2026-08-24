const test = require("node:test");
const assert = require("node:assert/strict");

const { parseClaudeLine, parseCodexLine, parseAgyLine, createLineParser } = require("../src/chat/chat-events");

test("claude: 텍스트 델타 스트림 이벤트", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "안녕" } },
  });
  assert.deepEqual(parseClaudeLine(line), { kind: "delta", text: "안녕" });
});

test("claude: Read 도구는 탐색 이벤트로 정규화", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "src/chat/chat-room.js" },
      }],
    },
  });
  const parsed = parseClaudeLine(line);
  assert.equal(parsed.kind, "tool-started");
  assert.equal(parsed.tool, "Read");
  assert.equal(parsed.target, "src/chat/chat-room.js");
  assert.equal(parsed.toolUseId, "tool-1");
  assert.ok(Number.isFinite(parsed.startedAt));
});

test("claude: Bash는 기존 command-started 계약을 유지", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }] },
  });
  const parsed = parseClaudeLine(line);
  assert.equal(parsed.kind, "command-started");
  assert.equal(parsed.command, "npm test");
  assert.equal(parsed.toolUseId, "bash-1");
});

test("claude: tool_result는 tool-finished와 output bytes를 남긴다", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "파일 내용",
      }],
    },
  });
  const parsed = parseClaudeLine(line);
  assert.equal(parsed.kind, "tool-finished");
  assert.equal(parsed.toolUseId, "tool-1");
  assert.equal(parsed.outputBytes, Buffer.byteLength("파일 내용", "utf8"));
});

test("claude: 실제 line parser는 Bash 결과를 command-finished로 복원한다", () => {
  const parser = createLineParser("claude");
  const started = parser(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }] },
  }));
  assert.equal(started.kind, "command-started");

  const finished = parser(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "525 passed", exit_code: 0 }] },
  }));
  assert.equal(finished.kind, "command-finished");
  assert.equal(finished.command, "npm test");
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.stdoutTail, "525 passed");
  assert.equal(finished.toolUseId, "bash-1");
});

test("claude: 실제 line parser는 Read 결과에 도구와 target을 복원한다", () => {
  const parser = createLineParser("claude");
  parser(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/main.js" } }] },
  }));
  const finished = parser(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "abc" }] },
  }));
  assert.equal(finished.kind, "tool-finished");
  assert.equal(finished.tool, "Read");
  assert.equal(finished.target, "src/main.js");
  assert.equal(finished.outputBytes, 3);
});

test("line parser는 실행 단위 telemetry snapshot을 노출한다", () => {
  const parser = createLineParser("claude");
  assert.equal(typeof parser.getTelemetry, "function");
  for (let i = 0; i < 4; i += 1) {
    const id = `read-${i}`;
    parser(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "src/large.js" } }] },
    }));
    parser(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(100) }] },
    }));
  }
  const telemetry = parser.getTelemetry();
  assert.equal(telemetry.toolSummary.started, 4);
  assert.equal(telemetry.toolSummary.finished, 4);
  assert.equal(telemetry.toolSummary.maxRepeatCount, 4);
  assert.equal(telemetry.exploration.status, "WARNING");
});

test("claude: result 성공은 final, 실패는 error", () => {
  const success = JSON.stringify({ type: "result", subtype: "success", result: "최종 답변" });
  assert.deepEqual(parseClaudeLine(success), { kind: "final", text: "최종 답변" });

  const failure = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "한도" });
  assert.equal(parseClaudeLine(failure).kind, "error");
});

test("claude: 알 수 없는 이벤트/비JSON은 무시", () => {
  assert.equal(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init" })), null);
  assert.equal(parseClaudeLine("plain text line"), null);
  assert.equal(parseClaudeLine('{"broken json'), null);
});

test("codex: 신형 item.completed agent_message는 final", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "코덱스 답변" },
  });
  assert.deepEqual(parseCodexLine(line), { kind: "final", text: "코덱스 답변" });
});

test("codex: 명령 실행 시작은 공통 command-started 이벤트", () => {
  const line = JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "ls -al" },
  });
  const parsed = parseCodexLine(line);
  assert.equal(parsed.kind, "command-started");
  assert.equal(parsed.command, "ls -al");
  assert.ok(Number.isFinite(parsed.startedAt));
});

test("codex: turn.failed의 중첩 오류 원인을 표시한다", () => {
  const line = JSON.stringify({
    type: "turn.failed",
    error: { message: "127.0.0.1 프록시 연결 거부" },
  });
  assert.deepEqual(parseCodexLine(line), {
    kind: "error",
    message: "127.0.0.1 프록시 연결 거부",
  });
});

test("codex: 구형 msg 스키마도 처리한다", () => {
  const finalLine = JSON.stringify({ id: "1", msg: { type: "agent_message", message: "구형 답변" } });
  assert.deepEqual(parseCodexLine(finalLine), { kind: "final", text: "구형 답변" });

  const execLine = JSON.stringify({ id: "2", msg: { type: "exec_command_begin", command: ["git", "status"] } });
  const started = parseCodexLine(execLine);
  assert.equal(started.kind, "command-started");
  assert.equal(started.command, "git status");

  const errorLine = JSON.stringify({ id: "3", msg: { type: "error", message: "문제 발생" } });
  assert.equal(parseCodexLine(errorLine).kind, "error");
});

test("agy stream-json의 최종 응답과 권한 거부를 정규화한다", () => {
  assert.equal(typeof createLineParser("claude"), "function");
  assert.equal(typeof createLineParser("codex"), "function");
  assert.equal(typeof createLineParser("agy"), "function");
  assert.deepEqual(parseAgyLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "안녕" } })), { kind: "final", text: "안녕" });
  const denied = parseAgyLine(JSON.stringify({ event: "step_update", step_update: { state: "ERROR", tool_name: "run_command", tool_info: { error: { message: "permission denied" } } } }));
  assert.equal(denied.kind, "approval-required");
});

test("agy의 비-command 도구는 tool-started/tool-finished로 정규화", () => {
  const started = parseAgyLine(JSON.stringify({
    event: "step_update",
    step_update: {
      id: "s-1",
      state: "STARTED",
      tool_name: "read_file",
      input: { path: "src/main.js" },
    },
  }));
  assert.equal(started.kind, "tool-started");
  assert.equal(started.tool, "read_file");
  assert.equal(started.target, "src/main.js");

  const finished = parseAgyLine(JSON.stringify({
    event: "step_update",
    step_update: {
      id: "s-1",
      state: "SUCCESS",
      tool_name: "read_file",
      output: "abc",
    },
  }));
  assert.equal(finished.kind, "tool-finished");
  assert.equal(finished.tool, "read_file");
  assert.equal(finished.outputBytes, 3);
});
