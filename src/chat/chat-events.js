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
// CLI가 보고한 모델 id만 통과시킵니다(argv 안전 문자와 같은 범위).
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

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

  // stream-json의 첫 줄(system/init)은 --model 별칭(fable)이 실제로 어떤 모델로
  // 풀렸는지(model) 알려준다. 응답 헤더에 "fable · claude-fable-5-1"처럼 보여 주기
  // 위한 정보라 본문에는 영향이 없다.
  if (event.type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model.trim() : "";
    return model && SAFE_MODEL_ID.test(model) ? { kind: "session-info", model } : null;
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
    // Observed in AGY 1.1.14 stream-json: agent_response streams text via
    // text_delta.
    // final is authoritative from result.response; delta is for live display.
    if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
      return { kind: "delta", text: String(step.text_delta) };
    }
    // Observed in AGY 1.1.14 stream-json: tool start is ACTIVE and completion
    // is DONE. The real command lives in tool_info.parameters.CommandLine and
    // tool steps carry step_index instead of an id.
    const toolUseId = step.id || step.step_id || (step.step_index != null ? String(step.step_index) : null);
    const command = step.command || step.tool_info?.parameters?.CommandLine || tool;
    if (step.state === "ERROR" && /permission|approval|권한|승인/i.test(error)) {
      return {
        kind: "approval-required",
        summary: tool ? `도구 권한: ${tool}` : "도구 실행 권한",
        detail: String(error),
      };
    }
    if (tool && /^(START|STARTED|RUNNING|PENDING|ACTIVE)$/i.test(String(step.state || ""))) {
      if (isCommandTool(tool)) return commandStarted(command, toolUseId);
      return toolStarted({
        tool,
        input: step.input ?? step.arguments ?? step.tool_info?.input ?? step.tool_info?.parameters ?? command,
        toolUseId,
      });
    }
    if (tool && /^(DONE|COMPLETED|SUCCESS|ERROR|FAILED)$/i.test(String(step.state || ""))) {
      if (isCommandTool(tool)) {
        // DONE/COMPLETED는 command-finished 발생 근거일 뿐 exit code 근거가
        // 아니다. 명시적 exit_code가 없으면 합성 0을 만들지 않고 null(PARTIAL)로
        // 둔다. 실행 Evidence는 관측값만 신뢰한다.
        return commandFinished({
          command,
          toolUseId,
          exitCode: step.exit_code ?? step.exitCode ?? null,
          stdout: step.stdout ?? step.output ?? step.tool_info?.output,
          stderr: step.stderr ?? error,
        });
      }
      return toolFinished({
        tool,
        toolUseId,
        output: step.stdout ?? step.output ?? step.tool_info?.output,
        error: step.stderr ?? error,
        exitCode: step.exit_code ?? step.exitCode,
      });
    }
    if (tool) return { kind: "status", label: `도구: ${truncateLabel(tool)}` };
  }
  if (event.event === "result") {
    const result = event.result || {};
    // status가 SUCCESS가 아니면 response가 있어도 final로 승격하지 않는다.
    // provider failure가 성공처럼 보이는 것을 막는다(fail-closed 방향).
    if (result.status && result.status !== "SUCCESS") {
      return { kind: "error", message: truncateLabel(result.error || result.response || `AGY ${result.status}`, 200) };
    }
    if (result.response) return { kind: "final", text: String(result.response) };
  }
  return null;
}

// instrumentParser는 baseParser의 정규화 이벤트에 run telemetry를 붙인다. Stage C에서는
// 여기에 더해 provider CLI가 내보내는 native session/conversation id를 harness-level
// metadata로만 추출한다. 작은 provider-neutral seam이다: extractNativeId(각 provider가
// 실환경에서 확인된 위치만 읽는 추출기)가 값을 주면 onNativeId로 알린다(renderer/FSM/
// generic Evidence로는 노출하지 않는다). 추출기가 없으면 sniff 자체를 하지 않는다.
function instrumentParser(baseParser, { onNativeId = null, extractNativeId = null } = {}) {
  const telemetry = createRunTelemetry();
  const notifyNativeId = typeof onNativeId === "function" ? onNativeId : null;
  const extract = typeof extractNativeId === "function" ? extractNativeId : null;
  const parser = (line) => {
    if (notifyNativeId && extract) {
      const raw = parseJsonLine(line);
      if (raw) {
        const id = extract(raw);
        if (typeof id === "string" && id) {
          try { notifyNativeId(id); } catch {}
        }
      }
    }
    const event = baseParser(line);
    if (!event) return null;
    telemetry.observe(event);
    return event;
  };
  parser.getTelemetry = () => telemetry.snapshot();
  return parser;
}

// provider-native id 추출기(harness metadata 전용). 실환경에서 확인된 위치만 읽고,
// JSON 전체를 임의 recursive search하지 않는다.
function extractClaudeSessionId(raw) {
  return typeof raw.session_id === "string" ? raw.session_id : null;
}
function extractAgyConversationId(raw) {
  // 실환경 AGY 1.1.13 stream-json에서 conversation_id가 관찰된 세 위치만 읽는다.
  if (raw.event === "init") {
    return typeof raw.conversation_id === "string" ? raw.conversation_id : null;
  }
  if (raw.event === "step_update" && raw.step_update) {
    return typeof raw.step_update.conversation_id === "string" ? raw.step_update.conversation_id : null;
  }
  if (raw.event === "result" && raw.result) {
    return typeof raw.result.conversation_id === "string" ? raw.result.conversation_id : null;
  }
  return null;
}

function createLineParser(providerId, options = {}) {
  if (providerId === "claude") {
    return instrumentParser(createClaudeLineParser(), { onNativeId: options.onSessionId, extractNativeId: extractClaudeSessionId });
  }
  if (providerId === "codex") return instrumentParser(parseCodexLine);
  if (providerId === "agy") {
    return instrumentParser(parseAgyLine, { onNativeId: options.onConversationId, extractNativeId: extractAgyConversationId });
  }
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
