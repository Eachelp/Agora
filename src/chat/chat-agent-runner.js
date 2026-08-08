const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");

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
  const marker = "\n\n[AGY CLI 명령줄 한도로 이전 대화 일부 생략]\n\n";
  const headLength = Math.min(6000, Math.floor((limit - marker.length) / 3));
  const tailLength = limit - marker.length - headLength;
  return text.slice(0, headLength) + marker + text.slice(-tailLength);
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
// - argv는 chat-argv가 만든 검증된 배열이며, 프롬프트는 항상 stdin으로 전달합니다.
// - parseLine이 있으면 stdout을 줄 단위로 정규화 이벤트로 바꿔 onEvent로 알립니다.
// - 최종 답변 우선순위: outputFile(codex -o) → parser의 final → stdout 원문.
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
}) {
  let child = null;
  let settled = false;
  let cancelled = false;
  let outputLimitHit = false;
  let timer = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (outputFile) {
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {}
    }
  };

  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
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

    const emit = (event) => {
      if (!event || settled) return;
      if (event.kind === "final") parsedFinal = event.text;
      // 재연결 과정에서는 여러 오류가 연속으로 옵니다. 첫 경고보다 마지막
      // turn.failed 원인이 사용자에게 더 유용하므로 최신 오류를 보존합니다.
      if (event.kind === "error") parsedError = event.message;
      if (event.kind === "approval-required" && !parsedApproval) parsedApproval = event;
      if (event.kind === "delta") deltaText += event.text;
      if (typeof onEvent === "function") {
        try {
          onEvent(event);
        } catch {}
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
      const looksLikePermissionIssue =
        /permission|approval|권한|승인/i.test(permissionText) &&
        /denied|required|prompt|거부|필요/i.test(permissionText);

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
      // parser가 명시적으로 보낸 approval-required 이벤트는 항상 신뢰합니다.
      if (parsedApproval) {
        finish({ ok: false, approvalRequired: true, approval: parsedApproval, output: outputInfo });
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

      // 정상 종료(code 0, 오류 신호 없음)인데 final 이벤트만 누락된 경우는
      // 중간 답변을 최종 결과로 승격합니다 (기존 호환성 유지).
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
  MAX_ARGV_PROMPT_CHARS,
};
