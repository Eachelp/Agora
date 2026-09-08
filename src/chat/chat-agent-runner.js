const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const { buildRunMetrics } = require("./chat-run-metrics");
const { isInternalToolError } = require("./chat-events");

// 에이전트 작업은 며칠간 이어질 수도 있으므로 기본 실행 시간 제한을 두지 않습니다.
// timeoutMs는 테스트나 명시적인 호출자가 양수를 전달한 경우에만 적용됩니다.
const DEFAULT_TIMEOUT_MS = null;

// 출력 한도는 서로 다른 세 가지 목적을 가지며 절대 하나로 합치지 않습니다.
//
//   1) captureBytes  — 메모리 보호용 stdout 보존량. 초과해도 실행을 죽이지 않고
//                      앞/뒤만 남기는 tail buffer로 잘라냅니다.
//   2) hardLimitBytes — 명시적으로 요청했을 때만 동작하는 안전 상한. 초과 시
//                      실행을 중단하되 outputLimited 상태로 구분해 보고합니다.
//   3) 표시 한도      — renderer가 담당하며 이 파일에서 다루지 않습니다.
//
// hard limit 기본값이 null인 이유: stdout이 길다는 사실만으로는 실패가 아니고,
// 정상 완료 직전의 run을 죽이면 최종 답변 자체를 잃기 때문입니다.
const DEFAULT_CAPTURE_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_HARD_OUTPUT_LIMIT_BYTES = null;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_ARGV_PROMPT_CHARS = 24 * 1024;

// 줄 파서가 미완성 줄로 들고 있을 최대 길이입니다.
// 프로바이더가 줄바꿈 없이 거대한 텍스트를 쏟아내면 이 버퍼가 무한정 커지고,
// 뒤이어 붙는 이벤트 JSON까지 같은 미완성 줄에 묻혀 final을 놓칩니다.
// 한도를 넘으면 앞부분을 버리고 최근 구간만 유지합니다. 이벤트 JSON은 한 줄
// 기준으로 이 길이보다 훨씬 짧으므로 최근 구간만 있어도 복구할 수 있습니다.
const MAX_LINE_BUFFER_CHARS = 256 * 1024;

// 화면에 실시간으로 보이던 중간 답변(deltaText)도 무한정 쌓이지 않도록 상한을 둡니다.
// 초과 시 앞부분은 버리고 최근 구간만 유지해, 오류 진단과 부분 출력 보존에 씁니다.
const MAX_DELTA_TEXT_CHARS = 2 * 1024 * 1024;

// 무음(정체) 감지: 실행 시간 제한은 없지만(위 DEFAULT_TIMEOUT_MS 참고), CLI가
// 크래시 없이 조용히 멈추면 사용자에게는 "입력 중" 표시만 남고 아무 신호가 없습니다.
// 여기서는 실행을 죽이지 않고, stdout/stderr가 이 시간만큼 조용하면 상태 이벤트만
// 남겨 사용자가 판단할 근거를 줍니다. 침묵이 계속되면 같은 간격으로 반복 알립니다.
const DEFAULT_SILENCE_WARNING_MS = 5 * 60 * 1000;
// 위 간격보다 촘촘하게 확인해, 경고가 실제 무음 시각에서 너무 늦게 뜨지 않게 합니다.
const SILENCE_CHECK_INTERVAL_MS = 30 * 1000;

// ChatRoom이 생성하는 전문 실행 프롬프트의 고정 내부 마커입니다.
// HarnessAdapter가 도입되기 전까지 runner가 전문 실행 strict-final 여부를 구분하는 데만 씁니다.
const PROFESSIONAL_PROMPT_MARKER = "=== 전문 모드:";

// fallback 마커 감지는 Agora가 프롬프트 헤더에 넣은 전문 블록만 인정합니다.
// 일반 채팅에서 사용자가 같은 문자열을 입력하면 그 텍스트는 `=== 대화 ===` 뒤에
// 놓이므로 strict-final을 켜지 않습니다. 명시적인 requireFinal 값이 있으면 이
// 추론보다 항상 우선합니다.
function inferRequireFinalFromPrompt(prompt) {
  const text = String(prompt || "");
  const markerIndex = text.indexOf(PROFESSIONAL_PROMPT_MARKER);
  if (markerIndex < 0) return false;
  const dialogueIndex = text.indexOf("=== 대화 ===");
  return dialogueIndex < 0 || markerIndex < dialogueIndex;
}

// tail buffer가 유지하는 머리 부분 비율. 초반 지시/헤더와 최신 출력이 모두
// 진단에 필요하므로 양쪽을 남기고 중간만 버립니다.
const CAPTURE_HEAD_RATIO = 0.25;
const CAPTURE_ELLIPSIS = "\n[...중략: 출력이 길어 중간 일부를 보존하지 않았습니다...]\n";

// 앞/뒤를 남기고 중간을 버리는 누적 버퍼입니다.
// stdout 전체를 메모리에 들고 있지 않으면서도 최종 답변(보통 마지막에 옵니다)과
// 초반 컨텍스트를 함께 보존합니다.
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

// cmd.exe(shell:true) 경유 시 인자를 개별 인용합니다.
// 참고: cmd는 따옴표 안에서도 %VAR% 확장을 수행하지만, 우리 인자는
// 검증된 플래그/경로뿐이라 %를 포함한 사용자 텍스트가 argv에 실릴 일이 없습니다.
function quoteArgForShell(arg) {
  const text = String(arg);
  if (text === "") return '""';
  if (/[\s&|<>^()"]/.test(text)) return `"${text.replace(/"/g, "")}"`;
  return text;
}
function compactArgvPrompt(prompt, limit = MAX_ARGV_PROMPT_CHARS) {
  const text = String(prompt || "");
  if (text.length <= limit) return text;

  // 규칙·프로젝트 맥락·결정·작업·최근 기록은 우선순위가 높아 보존한다.
  // 자를 부분은 오직 대화 본문 구간뿐이다. 대화 마커 이전은 그대로 둔다.
  const dialogueMarkers = ["=== 대화 ==="];
  let splitIndex = -1;
  for (const candidate of dialogueMarkers) {
    const idx = text.indexOf(candidate);
    if (idx >= 0) { splitIndex = idx; break; }
  }

  const notice = "\nAGY CLI 명령줄 한도로 이전 대화 일부 생략\n";
  if (splitIndex < 0) {
    // 대화 마커를 찾지 못한 경우: 앞부분을 우선 보존하고 생략 공지를 붙인다.
    const headLen = Math.max(0, Math.min(4000, limit - notice.length - 100));
    const tailLen = Math.max(0, limit - notice.length - headLen);
    return text.slice(0, headLen) + notice + text.slice(-tailLen);
  }
  const header = text.slice(0, splitIndex);
  const body = text.slice(splitIndex);
  if (header.length > limit) {
    // 헤더만으로도 한도를 넘는 드문 경우: 앞부분을 보존한다.
    return text.slice(0, limit);
  }
  const bodyBudget = Math.max(0, limit - header.length - notice.length);
  if (body.length <= bodyBudget) return text;
  const headLength = Math.min(4000, Math.floor(bodyBudget / 2));
  const tailLength = bodyBudget - headLength;
  return header + notice + body.slice(0, headLength) + body.slice(-tailLength);
}

function killTree(child, platform = process.platform) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (platform === "win32") {
    // shell(cmd.exe) 경유 실행 시 자식까지 함께 종료해야 합니다.
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {}
    // taskkill 자체가 보안 정책으로 막히는 경우에도 직계 프로세스는 닫습니다.
    try {
      child.kill();
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
}

// 프로바이더 프로세스 1회 실행.
// - argv는 chat-argv가 만든 검증된 배열이며, 프롬프트는 provider transport에 따라 stdin/argv로 전달합니다.
// - parseLine이 있으면 stdout을 줄 단위로 정규화 이벤트로 바꿔 onEvent로 알립니다.
// - 최종 답변 우선순위: outputFile(codex -o) → parser의 final → stdout 원문.
// - 전문 실행은 명시적인 final이 없으면 delta-only 출력을 성공으로 승격하지 않습니다.
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
  const strictFinal = requireFinal == null
    ? inferRequireFinalFromPrompt(prompt)
    : Boolean(requireFinal);
  const runStartedAt = Date.now();
  let child = null;
  let settled = false;
  let cancelled = false;
  let outputLimitHit = false;
  let timer = null;
  let silenceTimer = null;
  let explorationWarningRank = 0;
  const commandEvents = [];
  const pendingCommands = [];

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (silenceTimer) clearInterval(silenceTimer);
    if (outputFile) {
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {}
    }
  };

  const promise = new Promise((resolve) => {
    // CLI가 세션 시작 줄에서 보고한 실제 모델 id(별칭 fable → claude-fable-5-1 등).
    // 성공·실패와 무관하게 결과에 실어 응답 헤더가 실제 모델을 보여 줄 수 있게 합니다.
    let resolvedModel = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      const finishedCommands = commandEvents.filter((event) => event.kind === "command-finished");
      const boundedCommands = (finishedCommands.length > 0 ? finishedCommands : commandEvents).slice(-20);
      const telemetry = typeof parseLine?.getTelemetry === "function"
        ? parseLine.getTelemetry()
        : null;
      const hasTelemetry = Boolean(
        telemetry && (
          telemetry.commands?.total > 0 ||
          telemetry.toolSummary?.started > 0 ||
          telemetry.exploration?.status
        )
      );
      const evidence = boundedCommands.length > 0 || hasTelemetry
        ? {
            commands: boundedCommands,
            ...(telemetry?.commands ? { commandSummary: telemetry.commands } : {}),
            ...(Array.isArray(telemetry?.tools) ? { tools: telemetry.tools } : {}),
            ...(telemetry?.toolSummary ? { toolSummary: telemetry.toolSummary } : {}),
            ...(telemetry?.exploration ? { exploration: telemetry.exploration } : {}),
          }
        : null;
      const baseResult = {
        ...result,
        ...(evidence ? { evidence } : {}),
        ...(resolvedModel ? { resolvedModel } : {}),
      };
      const runMetrics = buildRunMetrics({
        startedAt: runStartedAt,
        finishedAt: Date.now(),
        promptChars: String(prompt || "").length,
        result: baseResult,
      });
      if (typeof onEvent === "function") {
        try {
          onEvent({ kind: "run-metrics", metrics: runMetrics });
        } catch {}
      }
      resolve({ ...baseResult, runMetrics });
    };

    if (promptTransport === "argv" && needsShell) {
      finish({ ok: false, error: "셸 래퍼에는 argv 프롬프트를 안전하게 전달할 수 없습니다." });
      return;
    }
    const executionArgv = [...argv];
    if (promptTransport === "argv") {
      executionArgv.push("--print", compactArgvPrompt(prompt));
    }
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
    // 미완성 줄이 한도를 넘어 앞부분을 버린 적이 있는지 표시합니다.
    // 이 경우 그 줄은 통째로 파싱할 수 없으므로, JSON 시작 위치를 찾아 복구합니다.
    let lineBufferTrimmed = false;
    let parsedFinal = null;
    let parsedError = null;
    let parsedApproval = null;
    let deltaText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    // 무음 감지: stdout/stderr가 silenceWarningMs만큼 조용하면 실행은 그대로 두고
    // 상태 이벤트만 알립니다. 침묵이 계속되면 같은 간격으로 반복 알립니다.
    let lastActivityAt = Date.now();
    let nextSilenceWarnAt = lastActivityAt + silenceWarningMs;
    const noteActivity = () => {
      lastActivityAt = Date.now();
      nextSilenceWarnAt = lastActivityAt + silenceWarningMs;
    };

    const notifyExplorationStatus = () => {
      if (typeof parseLine?.getTelemetry !== "function") return;
      const exploration = parseLine.getTelemetry()?.exploration;
      const rank = exploration?.status === "LOOP_DETECTED"
        ? 2
        : exploration?.status === "WARNING"
          ? 1
          : 0;
      if (rank <= explorationWarningRank) return;
      explorationWarningRank = rank;
      if (rank === 0 || typeof onEvent !== "function") return;
      const label = rank === 2
        ? "반복 탐색 루프가 감지되었습니다. 실행은 계속합니다."
        : "반복 탐색이 늘고 있습니다. 실행은 계속합니다.";
      try {
        onEvent({
          kind: "status",
          label,
          exploration: {
            status: exploration.status,
            reason: exploration.reason || null,
          },
        });
      } catch {}
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
      // 재연결 과정에서는 여러 오류가 연속으로 옵니다. 첫 경고보다 마지막
      // turn.failed 원인이 사용자에게 더 유용하므로 최신 오류를 보존합니다.
      if (event.kind === "error") parsedError = event.message;
      if (event.kind === "approval-required" && !parsedApproval) parsedApproval = event;
      if (event.kind === "session-info" && typeof event.model === "string" && event.model) {
        resolvedModel = event.model;
      }
      if (event.kind === "command-started") {
        pendingCommands.push(event);
        commandEvents.push(event);
        if (commandEvents.length > 80) commandEvents.splice(0, commandEvents.length - 80);
      }
      if (event.kind === "command-finished") {
        const command = event.command || null;
        let index = -1;
        for (let i = pendingCommands.length - 1; i >= 0; i -= 1) {
          if (!command || !pendingCommands[i].command || pendingCommands[i].command === command) {
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
        if (deltaText.length > MAX_DELTA_TEXT_CHARS) {
          deltaText = deltaText.slice(-MAX_DELTA_TEXT_CHARS);
        }
      }
      if (typeof onEvent === "function") {
        try {
          onEvent(event);
        } catch {}
      }
      if (event.kind === "tool-started" || event.kind === "tool-finished") {
        notifyExplorationStatus();
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
        // 대량 텍스트 뒤에 이벤트 JSON이 같은 줄로 이어붙는 경우가 있습니다.
        // 줄 전체로는 파싱되지 않으므로 마지막 '{'부터 한 번 더 시도합니다.
        if (trimmedForThisBatch || line.length > 8192) {
          const jsonStart = line.lastIndexOf("{");
          if (jsonStart > 0) emit(parseLine(line.slice(jsonStart)));
        }
      }
      if (flush && lines.length === 0 && chunk) emit(parseLine(chunk));

      // 줄바꿈 없이 계속 커지는 미완성 줄은 앞부분을 버리고 최근 구간만 유지합니다.
      // 프로세스는 그대로 두고, 이후에 도착하는 이벤트 JSON을 계속 인식합니다.
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

      // 원본 출력은 호출자가 파일 등으로 따로 보존할 수 있게 항상 먼저 넘깁니다.
      if (typeof onRawChunk === "function" && text) {
        try {
          onRawChunk(text);
        } catch {}
      }

      // 출력이 길다는 사실만으로 실행을 끝내지 않습니다. 보존량이 넘치면
      // tail buffer가 중간을 버리고, 프로세스는 최종 답변까지 계속 진행합니다.
      stdoutBuffer.push(text);

      // hard limit은 호출자가 명시적으로 요청한 경우에만 적용합니다.
      if (
        Number.isFinite(hardOutputLimitBytes) &&
        hardOutputLimitBytes > 0 &&
        stdoutBytes > hardOutputLimitBytes
      ) {
        outputLimitHit = true;
        handleLines(text);
        emit({
          kind: "status",
          label: "출력 상한에 도달해 실행을 중단합니다",
        });
        killTree(child, platform);
        return;
      }

      handleLines(text);
    });
    child.stderr.on("data", (chunk) => {
      noteActivity();
      if (stderr.length < MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => {
      finish({ ok: false, error: `실행 실패: ${error.message}` });
    });
    child.on("close", (code) => {
      // 사용자 중지/타임아웃과 출력 상한을 구분합니다. 출력 상한은 아래 정상
      // 판정 경로로 내려가서 partial output과 진단 정보를 함께 보고합니다.
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
      // 출력 관련 진단은 성공/실패와 무관하게 항상 같은 모양으로 보고합니다.
      const outputInfo = {
        stdoutBytes,
        captureTruncated: stdoutBuffer.truncated,
        ...(Number.isFinite(hardOutputLimitBytes) && hardOutputLimitBytes > 0
          ? { hardOutputLimitBytes }
          : {}),
      };

      let text = "";
      if (outputFile) {
        try {
          text = fs.readFileSync(outputFile, "utf8");
        } catch {
          text = "";
        }
      }
      if (!String(text || "").trim() && parsedFinal) text = parsedFinal;
      // 파서가 없는 프로바이더는 stdout 전체가 답변입니다. 다만 출력 상한으로
      // 강제 종료했다면 그 stdout은 중간에 잘린 상태이므로 최종 답변으로 승격하지
      // 않고 아래에서 부분 출력으로 다룹니다.
      if (!String(text || "").trim() && !parseLine && !outputLimitHit) text = stdout;
      // trustedText는 확정된 최종 답변(outputFile/parser의 final/파서 없이 받은 stdout
      // 전체)만 가리킵니다. deltaText(화면에 실시간으로 보이던 조각)는 여기 포함하지
      // 않습니다 — 아직 완성되지 않은 상태라 성공으로 단정할 수 없기 때문입니다.
      const trustedText = String(text || "").trim();

      const permissionText = `${parsedError || ""}\n${stderr || ""}`;
      // 파서가 놓친 승인 요청을 stderr 문구로 마지막에 한 번 더 잡는 휴리스틱입니다.
      // 파서와 같은 배제 조건을 씁니다(chat-events.js의 isAgyApprovalError): 도구를
      // 잘못 호출했다는 내부 오류 문구에도 "declaring permissions" 같은 권한 단어가
      // 섞여 나오는데, 그걸 승인 요청으로 읽으면 실패 사유가 사라지고 화면에는
      // 뜰 수 없는 승인 카드만 남습니다.
      const looksLikePermissionIssue =
        /permission|approval|권한|승인/i.test(permissionText) &&
        /denied|required|prompt|거부|필요/i.test(permissionText) &&
        !isInternalToolError(permissionText);

      // 신뢰 가능한 최종 답변이 없을 때만 권한 문제 휴리스틱을 적용합니다.
      // trustedText가 있으면(=실제로 정상 완료됐으면) stderr에 섞인 권한 관련
      // 문구(경고, probe 등)로 성공한 턴을 오탐 폐기하지 않습니다.
      if (!trustedText && !parsedApproval && looksLikePermissionIssue) {
        parsedApproval = {
          kind: "approval-required",
          summary: "도구 실행 권한이 필요합니다.",
          detail: permissionText.trim().slice(-2000),
        };
      }
      // 승인 요청은 "답을 못 내고 멈췄다"는 신호다. 확정된 최종 답변이 이미
      // 도착했다면 그 실행은 끝난 것이므로 승인 이벤트로 버리지 않는다.
      //
      // 실제로 이것 때문에 성공한 실행이 통째로 사라졌다: AGY의 내부 오류 문구
      // ("declaring permissions: ... invalid tool call error")를 파서가 승인
      // 요청으로 읽었고, 그 뒤에 정상 final이 도착했는데도 여기서 먼저 끊겼다.
      // 게다가 이 결과에는 사유가 없어 화면에는 "알 수 없는 오류"만 남았다.
      if (parsedApproval && !trustedText) {
        finish({
          ok: false,
          approvalRequired: true,
          approval: parsedApproval,
          // 자동 승인이 켜진 방은 이 결과를 그대로 실패로 그린다. 사유가 없으면
          // "알 수 없는 오류"가 되므로 어떤 경우에도 읽을 수 있는 이유를 싣는다.
          error: parsedApproval.summary || "도구 실행 권한이 필요합니다.",
          output: outputInfo,
        });
        return;
      }

      // hard limit으로 끊었더라도 최종 답변이 이미 도착했다면 성공으로 봅니다.
      // 상한의 목적은 메모리 보호이지, 완성된 답변을 버리는 것이 아닙니다.
      if (trustedText) {
        finish({
          ok: true,
          text: trustedText,
          output: outputLimitHit ? { ...outputInfo, outputLimited: true } : outputInfo,
        });
        return;
      }

      // hard limit 때문에 끊긴 경우는 timeout이나 provider 실패와 구분해서
      // 보고하고, 화면에 보였던 중간 출력을 partialText로 보존합니다.
      if (outputLimitHit) {
        // 파서가 있으면 화면에 보였던 delta가, 없으면 보존된 stdout이 부분 출력입니다.
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

      // 여기부터는 확정된 최종 답변이 없는 경우입니다. 화면에 중간 답변
      // (deltaText)이 떠 있었더라도, 오류로 끝났다면 그걸 성공으로 둔갑시키지
      // 않고 오류로 표시합니다.
      if (code !== 0 || parsedError) {
        const detail =
          parsedError || String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
        finish({
          ok: false,
          error: detail || `종료 코드 ${code}`,
          ...(deltaText.trim() ? { partialText: deltaText.trim() } : {}),
          output: outputInfo,
        });
        return;
      }

      // 전문 실행은 구조화된 final이 없으면 중간 delta를 완료 결과로 승격하지 않습니다.
      // 일반 채팅은 CLI 버전 호환을 위해 기존 fallback 동작을 유지합니다.
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

      // 정상 종료(code 0, 오류 신호 없음)인데 final 이벤트만 누락된 경우는
      // 중간 답변을 최종 결과로 승격합니다 (일반 채팅 호환성 유지).
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
  inferRequireFinalFromPrompt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CAPTURE_OUTPUT_BYTES,
  DEFAULT_HARD_OUTPUT_LIMIT_BYTES,
  DEFAULT_SILENCE_WARNING_MS,
  MAX_ARGV_PROMPT_CHARS,
  PROFESSIONAL_PROMPT_MARKER,
};