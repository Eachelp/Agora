const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_TIMEOUT_MS = null;
const DEFAULT_CAPTURE_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_HARD_OUTPUT_LIMIT_BYTES = null;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_ARGV_PROMPT_CHARS = 24 * 1024;
const MAX_LINE_BUFFER_CHARS = 256 * 1024;
const MAX_DELTA_TEXT_CHARS = 2 * 1024 * 1024;
const DEFAULT_SILENCE_WARNING_MS = 5 * 60 * 1000;
const SILENCE_CHECK_INTERVAL_MS = 30 * 1000;
const CAPTURE_HEAD_RATIO = 0.25;
const CAPTURE_ELLIPSIS = "\n[...중략: 출력이 길어 중간 일부를 보존하지 않았습니다...]\n";
const PROFESSIONAL_PROMPT_MARKER = "=== 전문 모드:";

function createTailBuffer(limitBytes) {
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : null;
  const headLimit = limit ? Math.max(1, Math.floor(limit * CAPTURE_HEAD_RATIO)) : null;
  const tailLimit = limit ? Math.max(1, limit - headLimit) : null;
  let head = "";
  let tail = "";
  let totalChars = 0;
  let dropped = false;

  return {
    push(text) {
      if (!text) return;
      totalChars += text.length;
      if (!limit) {
        head += text;
        return;
      }
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
        if (!text) return;
      }
      tail += text;
      if (tail.length > tailLimit) {
        tail = tail.slice(tail.length - tailLimit);
        dropped = true;
      }
    },
    get truncated() {
      return dropped;
    },
    get totalChars() {
      return totalChars;
    },
    toString() {
      if (!limit) return head;
      if (!dropped) return head + tail;
      return head + CAPTURE_ELLIPSIS + tail;
    },
  };
}

function quoteForShell(commandPath) {
  return /\s/.test(commandPath) ? `"${commandPath}"` : commandPath;
}

function quoteArgForShell(arg) {
  const text = String(arg);
  if (text === "") return '""';
  if (/[\s&|<>^()"]/.test(text)) return `"${text.replace(/"/g, "")}"`;
  return text;
}

function compactArgvPrompt(prompt, limit = MAX_ARGV_PROMPT_CHARS) {
  const text = String(prompt || "");
  if (text.length <= limit) return text;
  const dialogueMarkers = ["=== 대화 ==="];
  let splitIndex = -1;
  for (const candidate of dialogueMarkers) {
    const idx = text.indexOf(candidate);
    if (idx >= 0) { splitIndex = idx; break; }
  }

  const notice = "\nAGY CLI 명령줄 한도로 이전 대화 일부 생략\n";
  if (splitIndex < 0) {
    const headLen = Math.max(0, Math.min(4000, limit - notice.length - 100));
    const tailLen = Math.max(0, limit - notice.length - headLen);
    return text.slice(0, headLen) + notice + text.slice(-tailLen);
  }
  const header = text.slice(0, splitIndex);
  const body = text.slice(splitIndex);
  if (header.length > limit) return text.slice(0, limit);
  const bodyBudget = Math.max(0, limit - header.length - notice.length);
  if (body.length <= bodyBudget) return text;
  const headLength = Math.min(4000, Math.floor(bodyBudget / 2));
  const tailLength = bodyBudget - headLength;
  return header + notice + body.slice(0, headLength) + body.slice(-tailLength);
}

function killTree(child, platform = process.platform) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {}
    try {
      child.kill();
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
}

function runAgentProcess({
  commandPath,
  needsShell = false,
  argv = [],
  prompt,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  outputFile = null,
  parseLine = null,
  onEvent = null,
  captureOutputBytes = DEFAULT_CAPTURE_OUTPUT_BYTES,
  hardOutputLimitBytes = DEFAULT_HARD_OUTPUT_LIMIT_BYTES,
  onRawChunk = null,
  promptTransport = "stdin",
  silenceWarningMs = DEFAULT_SILENCE_WARNING_MS,
  requireFinal = null,
}) {
  // RuntimeAdapter 도입 전까지는 ChatRoom이 만든 전문 프롬프트의 고정 마커를
  // 안전한 내부 신호로 사용합니다. 호출자가 명시하면 그 값을 우선합니다.
  const strictFinal = requireFinal == null
    ? String(prompt || "").includes(PROFESSIONAL_PROMPT_MARKER)
    : Boolean(requireFinal);
  let child = null;
  let settled = false;
  let cancelled = false;
  let outputLimitHit = false;
  let timer = null;
  let silenceTimer = null;
  const commandEvents = [];
  const pendingCommands = [];

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (silenceTimer) clearInterval(silenceTimer);
    if (outputFile) {
      try { fs.rmSync(outputFile, { force: true }); } catch {}
    }
  };

  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      const finishedCommands = commandEvents.filter((event) => event.kind === "command-finished");
      const boundedCommands = (finishedCommands.length > 0 ? finishedCommands : commandEvents).slice(-20);
      resolve(boundedCommands.length > 0
        ? { ...result, evidence: { commands: boundedCommands } }
        : result);
    };

    if (promptTransport === "argv" && needsShell) {
      finish({ ok: false, error: "셸 래퍼에는 argv 프롬프트를 안전하게 전달할 수 없습니다." });
      return;
    }
    const executionArgv = [...argv];
    if (promptTransport === "argv") executionArgv.push("--print", compactArgvPrompt(prompt));
    const command = needsShell ? quoteForShell(commandPath) : commandPath;
    const args = needsShell ? executionArgv.map(quoteArgForShell) : executionArgv;
    try {
      child = spawn(command, args, {
        cwd,
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, error: `실행 실패: ${error.message}` });
      return;
    }

    const stdoutBuffer = createTailBuffer(captureOutputBytes);
    let stderr = "";
    let stdoutBytes = 0;
    let lineBuffer = "";
    let lineBufferTrimmed = false;
    let parsedFinal = null;
    let parsedError = null;
    let parsedApproval = null;
    let deltaText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    let lastActivityAt = Date.now();
    let nextSilenceWarnAt = lastActivityAt + silenceWarningMs;
    const noteActivity = () => {
      lastActivityAt = Date.now();
      nextSilenceWarnAt = lastActivityAt + silenceWarningMs;
    };
    if (Number.isFinite(silenceWarningMs) && silenceWarningMs > 0) {
      silenceTimer = setInterval(() => {
        if (settled) return;
        const now = Date.now();
        if (now < nextSilenceWarnAt) return;
        const idleMinutes = Math.max(1, Math.round((now - lastActivityAt) / 60000));
        emit({ kind: "status", label: `${idleMinutes}분째 응답 없음` });
        nextSilenceWarnAt = now + silenceWarningMs;
      }, Math.min(silenceWarningMs, SILENCE_CHECK_INTERVAL_MS));
      if (typeof silenceTimer.unref === "function") silenceTimer.unref();
    }

    const emit = (event) => {
      if (!event || settled) return;
      if (event.kind === "final") parsedFinal = event.text;
      if (event.kind === "error") parsedError = event.message;
      if (event.kind === "approval-required" && !parsedApproval) parsedApproval = event;
      if (event.kind === "command-started") {
        pendingCommands.push(event);
        commandEvents.push(event);
        if (commandEvents.length > 80) commandEvents.splice(0, commandEvents.length - 80);
      }
      if (event.kind === "command-finished") {
        const commandValue = event.command || null;
        let index = -1;
        for (let i = pendingCommands.length - 1; i >= 0; i -= 1) {
          if (!commandValue || !pendingCommands[i].command || pendingCommands[i].command === commandValue) {
            index = i;
            break;
          }
        }
        const started = index >= 0 ? pendingCommands.splice(index, 1)[0] : null;
        const normalized = {
          ...event,
          ...(event.command || started?.command ? { command: event.command || started.command } : {}),
          ...(event.startedAt != null || started?.startedAt != null
            ? { startedAt: event.startedAt ?? started.startedAt }
            : {}),
        };
        commandEvents.push(normalized);
        if (commandEvents.length > 80) commandEvents.splice(0, commandEvents.length - 80);
      }
      if (event.kind === "delta") {
        deltaText += event.text;
        if (deltaText.length > MAX_DELTA_TEXT_CHARS) deltaText = deltaText.slice(-MAX_DELTA_TEXT_CHARS);
      }
      if (typeof onEvent === "function") {
        try { onEvent(event); } catch {}
      }
    };

    const handleLines = (chunk, flush = false) => {
      if (!parseLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      const pending = flush ? "" : lines.pop() || "";
      const trimmedForThisBatch = lineBufferTrimmed;
      lineBufferTrimmed = false;
      for (const line of lines) {
        emit(parseLine(line));
        if (trimmedForThisBatch || line.length > 8192) {
          const jsonStart = line.lastIndexOf("{");
          if (jsonStart > 0) emit(parseLine(line.slice(jsonStart)));
        }
      }
      if (flush && lines.length === 0 && chunk) emit(parseLine(chunk));
      if (pending.length > MAX_LINE_BUFFER_CHARS) {
        lineBuffer = pending.slice(pending.length - MAX_LINE_BUFFER_CHARS);
        lineBufferTrimmed = true;
        return;
      }
      lineBuffer = pending;
    };

    child.stdout.on("data", (chunk) => {
      noteActivity();
      const text = stdoutDecoder.write(chunk);
      stdoutBytes += chunk.length;
      if (typeof onRawChunk === "function" && text) {
        try { onRawChunk(text); } catch {}
      }
      stdoutBuffer.push(text);
      if (
        Number.isFinite(hardOutputLimitBytes) &&
        hardOutputLimitBytes > 0 &&
        stdoutBytes > hardOutputLimitBytes
      ) {
        outputLimitHit = true;
        handleLines(text);
        emit({ kind: "status", label: "출력 상한에 도달해 실행을 중단합니다" });
        killTree(child, platform);
        return;
      }
      handleLines(text);
    });
    child.stderr.on("data", (chunk) => {
      noteActivity();
      if (stderr.length < MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => finish({ ok: false, error: `실행 실패: ${error.message}` }));
    child.on("close", (code) => {
      if (cancelled && !outputLimitHit) {
        finish({ ok: false, error: "중지됨", cancelled: true });
        return;
      }
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) {
        stdoutBuffer.push(stdoutTail);
        handleLines(stdoutTail);
      }
      if (stderrTail && stderr.length < MAX_STDERR_BYTES) stderr += stderrTail;
      if (lineBuffer) handleLines("", true);

      const stdout = stdoutBuffer.toString();
      const outputInfo = {
        stdoutBytes,
        captureTruncated: stdoutBuffer.truncated,
        ...(Number.isFinite(hardOutputLimitBytes) && hardOutputLimitBytes > 0
          ? { hardOutputLimitBytes }
          : {}),
      };

      let text = "";
      if (outputFile) {
        try { text = fs.readFileSync(outputFile, "utf8"); } catch { text = ""; }
      }
      if (!String(text || "").trim() && parsedFinal) text = parsedFinal;
      if (!String(text || "").trim() && !parseLine && !outputLimitHit) text = stdout;
      const trustedText = String(text || "").trim();

      const permissionText = `${parsedError || ""}\n${stderr || ""}`;
      const looksLikePermissionIssue =
        /permission|approval|권한|승인/i.test(permissionText) &&
        /denied|required|prompt|거부|필요/i.test(permissionText);
      if (!trustedText && !parsedApproval && looksLikePermissionIssue) {
        parsedApproval = {
          kind: "approval-required",
          summary: "도구 실행 권한이 필요합니다.",
          detail: permissionText.trim().slice(-2000),
        };
      }
      if (parsedApproval) {
        finish({ ok: false, approvalRequired: true, approval: parsedApproval, output: outputInfo });
        return;
      }
      if (trustedText) {
        finish({
          ok: true,
          text: trustedText,
          output: outputLimitHit ? { ...outputInfo, outputLimited: true } : outputInfo,
        });
        return;
      }
      if (outputLimitHit) {
        const partial = (deltaText.trim() || (parseLine ? "" : stdout.trim())).trim();
        finish({
          ok: false,
          outputLimited: true,
          error: "출력이 설정된 상한을 넘어 실행을 중단했습니다.",
          ...(partial ? { partialText: partial } : {}),
          output: { ...outputInfo, outputLimited: true },
        });
        return;
      }
      if (code !== 0 || parsedError) {
        const detail = parsedError || String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
        finish({
          ok: false,
          error: detail || `종료 코드 ${code}`,
          ...(deltaText.trim() ? { partialText: deltaText.trim() } : {}),
          output: outputInfo,
        });
        return;
      }
      if (strictFinal && parseLine) {
        const partial = deltaText.trim();
        finish({
          ok: false,
          protocolFailed: true,
          stopReason: "PROTOCOL_FINAL_MISSING",
          error: "구조화된 최종 응답을 확인하지 못했습니다.",
          ...(partial ? { partialText: partial } : {}),
          output: outputInfo,
        });
        return;
      }
      const fallbackText = deltaText.trim();
      if (fallbackText) {
        finish({ ok: true, text: fallbackText, output: outputInfo });
        return;
      }
      finish({ ok: false, error: parsedError || "빈 응답", output: outputInfo });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(promptTransport === "stdin" ? prompt : "", "utf8");

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        cancelled = true;
        killTree(child, platform);
        finish({
          ok: false,
          timedOut: true,
          error: `시간 초과 (${Math.round(timeoutMs / 1000)}초)`,
          ...(deltaText.trim() ? { partialText: deltaText.trim() } : {}),
        });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  });

  const cancel = () => {
    cancelled = true;
    killTree(child, platform);
  };

  return { promise, cancel };
}

module.exports = {
  runAgentProcess,
  killTree,
  quoteForShell,
  quoteArgForShell,
  compactArgvPrompt,
  createTailBuffer,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CAPTURE_OUTPUT_BYTES,
  DEFAULT_HARD_OUTPUT_LIMIT_BYTES,
  DEFAULT_SILENCE_WARNING_MS,
  MAX_ARGV_PROMPT_CHARS,
  PROFESSIONAL_PROMPT_MARKER,
};
