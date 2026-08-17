const { createRunTelemetry } = require("./chat-run-telemetry");

// 프로바이더 CLI의 구조화 출력(JSONL)을 공통 이벤트로 정규화합니다.
//   { kind: "delta", text }   — 실시간 본문 조각 (claude stream-json)
//   { kind: "status", label } — 사고 등 상태 표시
//   { kind: "final", text }   — 신뢰 가능한 최종 답변
//   { kind: "error", message }
//   { kind: "command-started|command-finished", ... } — shell/command 실행
//   { kind: "tool-started|tool-finished", ... }       — Read/Grep/Glob 등 비-command 도구
// 알 수 없는 줄은 null(무시)로 처리해, CLI 버전이 바뀌어도 조용히 동작합니다.

function parseJsonLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function truncateLabel(text, limit = 80) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

const COMMAND_TAIL_CHARS = 2 * 1024;
const TOOL_TARGET_CHARS = 512;

function tailOutput(value, limit = COMMAND_TAIL_CHARS) {
  if (value == null) return { text: "", truncated: false };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(-limit), truncated: true };
}

function commandValue(value) {
  if (Array.isArray(value)) return value.map((part) => String(part)).join(" ");
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function commandStarted(command, toolUseId = null) {
  const value = commandValue(command);
  return {
    kind: "command-started",
    command: value,
    toolUseId: toolUseId || null,
    startedAt: Date.now(),
  };
}

function commandFinished({ command = null, exitCode = null, stdout = null, stderr = null, startedAt = null, toolUseId = null } = {}) {
  const out = tailOutput(stdout);
  const err = tailOutput(stderr);
  return {
    kind: "command-finished",
    command: commandValue(command),
    toolUseId: toolUseId || null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    stdoutTail: out.text,
    stderrTail: err.text,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: Date.now(),
    truncated: Boolean(out.truncated || err.truncated),
    executionStatus: Number.isInteger(exitCode) ? "OBSERVED" : "PARTIAL",
  };
}

function compactToolTarget(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > TOOL_TARGET_CHARS
    ? `${compact.slice(0, TOOL_TARGET_CHARS)}…`
    : compact;
}

function toolTarget(input) {
  if (!input || typeof input !== "object") return compactToolTarget(input);
  for (const key of ["file_path", "path", "pattern", "query", "glob", "command"]) {
    if (input[key] != null) return compactToolTarget(input[key]);
  }
  return null;
}

function toolStarted({ tool, input = null, toolUseId = null } = {}) {
  return {
    kind: "tool-started",
    tool: truncateLabel(tool || "tool", 80),
    target: toolTarget(input),
    toolUseId: toolUseId || null,
    startedAt: Date.now(),
  };
}

function toolFinished({ tool = null, output = null, error = null, toolUseId = null, startedAt = null, exitCode = null } = {}) {
  const out = tailOutput(output);
  const err = tailOutput(error);
  return {
    kind: "tool-finished",
    tool: tool ? truncateLabel(tool, 80) : null,
    toolUseId: toolUseId || null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    outputBytes: typeof output === "string" ? Buffer.byteLength(output, "utf8") : out.text.length,
    outputTail: out.text,
    errorTail: err.text,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    finishedAt: Date.now(),
    truncated: Boolean(out.truncated || err.truncated),
    executionStatus: error ? "FAILED" : Number.isInteger(exitCode) ? "OBSERVED" : "PARTIAL",
  };
}

function isCommandTool(name) {
  return /^(bash|shell|run_command|run-command|command|exec)$/i.test(String(name || ""));
}

function parseClaudeLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;

  if (event.type === "stream_event" && event.event) {
    const inner = event.event;
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { kind: "delta", text: String(inner.delta.text || "") };
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      return { kind: "status", label: `도구: ${truncateLabel(inner.content_block.name)}` };
    }
    return null;
  }

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_use" && block.name) {
        if (isCommandTool(block.name) && block.input?.command) {
          return commandStarted(block.input.command, block.id || null);
        }
        return toolStarted({ tool: block.name, input: block.input, toolUseId: block.id });
      }
    }
    return null;
  }

  if (event.type === "result") {
    if (event.subtype === "success" && typeof event.result === "string") {
      return { kind: "final", text: event.result };
    }
    if (event.is_error || (event.subtype && event.subtype !== "success")) {
      return { kind: "error", message: truncateLabel(event.result || event.subtype || "실행 오류", 200) };
    }
    return null;
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    const result = event.message.content.find((block) => block?.type === "tool_result");
    if (result) {
      return toolFinished({
        toolUseId: result.tool_use_id,
        output: result.content,
        error: result.is_error ? result.content : null,
        exitCode: result.exit_code,
      });
    }
  }

  return null;
}

function createClaudeLineParser() {
  const pending = new Map();
  return (line) => {
    const parsed = parseClaudeLine(line);
    if (!parsed) return null;

    if ((parsed.kind === "command-started" || parsed.kind === "tool-started") && parsed.toolUseId) {
      pending.set(parsed.toolUseId, parsed);
      return parsed;
    }

    if (parsed.kind === "tool-finished" && parsed.toolUseId) {
      const started = pending.get(parsed.toolUseId) || null;
      pending.delete(parsed.toolUseId);
      if (started?.kind === "command-started") {
        return commandFinished({
          command: started.command,
          toolUseId: parsed.toolUseId,
          exitCode: parsed.exitCode,
          stdout: parsed.outputTail,
          stderr: parsed.errorTail,
          startedAt: started.startedAt,
        });
      }
      if (started?.kind === "tool-started") {
        return {
          ...parsed,
          tool: parsed.tool || started.tool,
          target: started.target || null,
          startedAt: parsed.startedAt ?? started.startedAt,
        };
      }
    }

    return parsed;
  };
}

function parseCodexLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;
  const item = event.item;
  if (typeof event.type === "string" && item && typeof item === "object") {
    if (event.type.startsWith("item.") && item.type === "agent_message" && item.text) {
      return event.type === "item.completed" ? { kind: "final", text: String(item.text) } : null;
    }
    if (item.type === "command_execution") {
      if (event.type === "item.started") return commandStarted(item.command);
      if (event.type === "item.completed") {
        return commandFinished({
          command: item.command,
          exitCode: item.exit_code ?? item.exitCode,
          stdout: item.aggregated_output ?? item.output ?? item.stdout,
          stderr: item.stderr,
        });
      }
      return null;
    }
    if (item.type === "reasoning") {
      return event.type === "item.started" ? { kind: "status", label: "생각 중" } : null;
    }
    if (item.type === "error") {
      return { kind: "error", message: truncateLabel(item.message || "실행 오류", 200) };
    }
    return null;
  }
  if (event.type === "error" && event.message) {
    return { kind: "error", message: truncateLabel(event.message, 200) };
  }
  if (event.type === "turn.failed" && event.error?.message) {
    return { kind: "error", message: truncateLabel(event.error.message, 200) };
  }
  const msg = event.msg;
  if (msg && typeof msg === "object") {
    if (msg.type === "agent_message" && msg.message) {
      return { kind: "final", text: String(msg.message) };
    }
    if (msg.type === "agent_reasoning") return { kind: "status", label: "생각 중" };
    if (msg.type === "exec_command_begin" && Array.isArray(msg.command)) {
      return commandStarted(msg.command);
    }
    if (msg.type === "exec_command_end" || msg.type === "exec_command_complete") {
      return commandFinished({
        command: msg.command,
        exitCode: msg.exit_code ?? msg.exitCode,
        stdout: msg.stdout ?? msg.output,
        stderr: msg.stderr,
      });
    }
    if (msg.type === "error" && msg.message) {
      return { kind: "error", message: truncateLabel(msg.message, 200) };
    }
    return null;
  }
  return null;
}

function parseAgyLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;
  if (event.event === "step_update") {
    const step = event.step_update || {};
    const tool = step.tool_name || step.tool_info?.name;
    const error = step.tool_info?.error?.message || step.error?.message || "";
    if (step.state === "ERROR" && /permission|approval|권한|승인/i.test(error)) {
      return {
        kind: "approval-required",
        summary: tool ? `도구 권한: ${tool}` : "도구 실행 권한",
        detail: String(error),
      };
    }
    if (tool && /^(START|STARTED|RUNNING|PENDING)$/i.test(String(step.state || ""))) {
      if (isCommandTool(tool)) return commandStarted(step.command || tool, step.id || step.step_id || null);
      return toolStarted({
        tool,
        input: step.input ?? step.arguments ?? step.tool_info?.input ?? step.command,
        toolUseId: step.id || step.step_id || null,
      });
    }
    if (tool && /^(DONE|COMPLETED|SUCCESS|ERROR|FAILED)$/i.test(String(step.state || ""))) {
      if (isCommandTool(tool)) {
        return commandFinished({
          command: step.command || tool,
          toolUseId: step.id || step.step_id || null,
          exitCode: step.exit_code ?? step.exitCode ?? (String(step.state).toUpperCase() === "SUCCESS" ? 0 : null),
          stdout: step.stdout ?? step.output ?? step.tool_info?.output,
          stderr: step.stderr ?? error,
        });
      }
      return toolFinished({
        tool,
        toolUseId: step.id || step.step_id || null,
        output: step.stdout ?? step.output ?? step.tool_info?.output,
        error: step.stderr ?? error,
        exitCode: step.exit_code ?? step.exitCode,
      });
    }
    if (tool) return { kind: "status", label: `도구: ${truncateLabel(tool)}` };
  }
  if (event.event === "result") {
    const result = event.result || {};
    if (result.response) return { kind: "final", text: String(result.response) };
    if (result.status && result.status !== "SUCCESS") {
      return { kind: "error", message: truncateLabel(result.error || `AGY ${result.status}`, 200) };
    }
  }
  return null;
}

function instrumentParser(baseParser) {
  const telemetry = createRunTelemetry();
  const parser = (line) => {
    const event = baseParser(line);
    if (!event) return null;
    telemetry.observe(event);
    return event;
  };
  parser.getTelemetry = () => telemetry.snapshot();
  return parser;
}

function createLineParser(providerId) {
  if (providerId === "claude") return instrumentParser(createClaudeLineParser());
  if (providerId === "codex") return instrumentParser(parseCodexLine);
  if (providerId === "agy") return instrumentParser(parseAgyLine);
  return null;
}

module.exports = {
  createLineParser,
  parseClaudeLine,
  parseCodexLine,
  parseAgyLine,
  commandStarted,
  commandFinished,
  toolStarted,
  toolFinished,
};
