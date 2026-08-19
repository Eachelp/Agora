const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFile } = require("node:child_process");
const { CodexAccountSwitcher } = require("../codex-account-switcher");
const { ClaudeAccountSwitcher } = require("../claude-account-switcher");
const { normalizeClaudeAccountMetadata } = require("../claude-account-metadata");
const { AntigravityAccountSwitcher } = require("../antigravity-account-switcher");
const {
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchAntigravityUsage,
} = require("../provider-usage");
const { deleteCredential, readCredential, writeCredential } = require("../credential-store");
const { createClaudeLiveStore } = require("../claude-live-credentials");
const { fingerprint, secretFingerprint } = require("../provider-profile-store");
const {
  CodexProxy,
  disableProxyInConfig,
  enableProxyInConfig,
} = require("../codex-proxy");
const { buildAccountSubmenu } = require("../account-submenu");
const { commandNeedsShell, selectCommandPath } = require("../command-resolution");
const { cliCandidates } = require("../providers/provider-capabilities");
const { buildWindowsCodexLaunchScript } = require("../codex-desktop-launch");
const { linuxTerminalInvocation, writeUnixLoginScript } = require("../unix-login");

// Codex/Claude/AGY 계정 전환, 로그인 스크립트 생성, Codex 로컬 프록시 제어를 모아 놓은
// 모듈입니다. main.js는 이 모듈을 조립만 하고, 펫 창·말풍선·트레이 같은 UI는 소유하지
// 않습니다 — 그 UI들을 다루는 함수/상태는 ui 인자로 주입받습니다.

// Codex 계정 전환 뒤 Codex Desktop App을 다시 띄우는 설정입니다.
// codex-auth/codex-profile류 스위처들은 auth를 바꾼 뒤 실행 중인 클라이언트를 재시작해야
// 새 auth가 확실히 적용되는 구조를 씁니다.
// enabledAfterAccountSwitch를 false로 바꾸면 active 프로필만 저장하고 재시작은 하지 않습니다.
const CODEX_DESKTOP_RESTART_CONFIG = Object.freeze({
  enabledAfterAccountSwitch: true,
  windowsProcessPathMarker: "\\WindowsApps\\OpenAI.Codex_",
  launchDelayMs: 900,
  timeoutMs: 20000,
});

// Codex 로컬 프록시용 계정 캐시 TTL입니다.
// listProfiles()는 디렉토리 스캔 + auth.json 해시 등 무거운 동기 fs라서, 프록시가 요청마다
// 호출하면 메인 프로세스가 매번 블로킹됩니다. 프로필은 명시적 전환/로그인 때만 바뀌므로
// 짧은 TTL로 캐시하고, 전환 지점에서 명시적으로 무효화합니다.
const PROXY_ACCOUNTS_TTL_MS = 1500;

// ui: main.js가 소유한 UI/설정 계층에 대한 접근을 주입받는 인자입니다.
//   electron: { app, shell, Menu }
//   isPetEnabled, openChatWindow, showPetWindowFromTray, showBubble,
//   restoreActiveActivityBubble, playReaction, refreshTrayMenu,
//   readSettings, writeSettings
//   getBubbleWindow, getPetWindow — 현재 창 인스턴스 조회(메뉴 팝업 대상 선택용)
//   getBubbleHideTimer, setBubbleHideTimer — bubbleWindow와 공유하는 자동 숨김 타이머
//   getChatFeature — chat/chat-ipc.js가 만든 chatFeature (showSystemNotice용).
//     chatFeature 생성 시점의 prepareAgent 콜백이 이 모듈의 prepareChatAgent를 먼저
//     참조해야 해서(순환 초기화), main.js는 chatFeature 생성 후에 이 함수를 호출하고
//     getChatFeature는 그 결과를 지연 조회합니다.
//   bubbleDoneAutoHideMs — 계정/오류 말풍선 자동 숨김 지연(ms)
function createAccountSwitching(ui) {
  const {
    electron: { app, shell, Menu },
    isPetEnabled,
    openChatWindow,
    showPetWindowFromTray,
    showBubble,
    restoreActiveActivityBubble,
    playReaction,
    refreshTrayMenu,
    readSettings,
    writeSettings,
    getBubbleWindow,
    getPetWindow,
    getBubbleHideTimer,
    setBubbleHideTimer,
    getChatFeature,
    bubbleDoneAutoHideMs,
  } = ui;

  // userData에 남기는 간단한 디버그 로그입니다.
  // 로그인 터미널처럼 사용자가 "아무 일도 안 일어났다"고 느끼는 작업은 실제 launcher 오류를 남겨야 추적이 됩니다.
  function appendDebugLog(message) {
    try {
      const line = `[${new Date().toISOString()}] ${message}\n`;
      fs.appendFileSync(path.join(app.getPath("userData"), "agora.log"), line, "utf8");
    } catch {
      // 로그 쓰기 실패 때문에 앱 기능 자체를 막지는 않습니다.
    }
  }

  function resolveCommand(command, candidates = []) {
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    try {
      const lookup = process.platform === "win32" ? "where.exe" : "which";
      const result = spawnSync(lookup, [command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status !== 0) return null;
      return selectCommandPath(result.stdout, process.platform);
    } catch {
      return null;
    }
  }

  // GUI로 실행된 macOS 앱은 셸 PATH를 물려받지 않으므로 자주 쓰이는 설치 경로를 후보로
  // 함께 넘깁니다. 후보 목록 자체는 provider-capabilities.js의 cliCandidates가 채팅
  // 기능과 공유하는 단일 기준이며, 여기서는 목록만 가져와 동기 조회(resolveCommand,
  // spawnSync 기반)에 씁니다.
  function claudeCommandCandidates() {
    return cliCandidates("claude", process.platform, process.env, os.homedir());
  }

  function codexCommandCandidates() {
    return cliCandidates("codex", process.platform, process.env, os.homedir());
  }

  function resolveAntigravityExecutable() {
    if (process.platform === "darwin") {
      const appPath = "/Applications/Antigravity.app";
      return fs.existsSync(appPath) ? appPath : null;
    }
    if (process.platform === "linux") {
      return resolveCommand("antigravity", [
        path.join(os.homedir(), ".local", "bin", "antigravity"),
        "/usr/local/bin/antigravity",
        "/usr/bin/antigravity",
        "/opt/Antigravity/antigravity",
      ]);
    }
    return resolveCommand("Antigravity.exe", [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "antigravity", "Antigravity.exe"),
      path.join(process.env.ProgramFiles || "", "Antigravity", "Antigravity.exe"),
    ]);
  }

  // osascript로 앱 종료를 요청합니다. 앱이 떠 있지 않아도 실패로 보지 않습니다.
  function quitMacApp(appName, timeoutMs = 15000) {
    return new Promise((resolve) => {
      execFile(
        "osascript",
        ["-e", `if application "${appName}" is running then quit app "${appName}"`],
        { timeout: timeoutMs },
        (error, stdout, stderr) => {
          resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
        }
      );
    });
  }

  // PowerShell 명령 문자열에 파일 경로를 안전하게 넣기 위한 작은 helper입니다.
  // 경로 안에 작은따옴표가 있어도 PowerShell single-quoted string 규칙에 맞게 이스케이프합니다.
  function quotePowerShellString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  // cmd.exe /c start 안에 들어갈 경로를 큰따옴표로 감쌉니다.
  // Windows 파일 경로에는 보통 큰따옴표가 없지만, 혹시 모를 값을 이스케이프해 둡니다.
  function quoteCmdArgument(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }

  function quoteShellArgument(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  // macOS에서 더블클릭(shell.openPath)하면 Terminal이 실행하는 .command 셸 스크립트를 만듭니다.
  function writeMacLoginScript(fileName, lines) {
    return writeUnixLoginScript(app.getPath("userData"), fileName, lines);
  }

  // PowerShell helper를 숨김 창으로 실행합니다.
  // Codex Desktop 재시작처럼 Windows 프로세스 목록을 다뤄야 하는 작업만 이 helper를 사용합니다.
  function runHiddenPowerShell(command, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({
          ok: false,
          code: null,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", (error) => {
        finish({
          ok: false,
          code: null,
          stdout,
          stderr: error.message || String(error),
        });
      });

      child.once("close", (code) => {
        finish({
          ok: code === 0,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });
    });
  }

  async function restartAntigravityApp() {
    if (process.platform === "darwin") {
      const executable = resolveAntigravityExecutable();
      if (!executable) throw new Error("AGY 실행 파일을 찾지 못했습니다.");
      await quitMacApp("Antigravity");
      await new Promise((resolve) => setTimeout(resolve, 700));
      const child = spawn("open", ["-a", executable], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }

    if (process.platform === "linux") {
      const executable = resolveAntigravityExecutable();
      if (!executable) throw new Error("AGY 실행 파일을 찾지 못했습니다.");
      spawnSync("pkill", ["-x", path.basename(executable)], {
        stdio: "ignore",
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const child = spawn(executable, [], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    }

    const executable = resolveAntigravityExecutable();
    if (!executable) throw new Error("AGY 실행 파일을 찾지 못했습니다.");
    const executablePath = quotePowerShellString(path.resolve(executable));
    const directoryPath = quotePowerShellString(`${path.dirname(path.resolve(executable))}${path.sep}`);
    const command = `
$ErrorActionPreference = 'Stop'
$executable = ${executablePath}
$directory = ${directoryPath}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and ($_.ExecutablePath -eq $executable -or $_.ExecutablePath.StartsWith($directory)))
})
foreach ($process in $processes) {
  try { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Milliseconds 700
Write-Output "Stopped $($processes.Count) AGY process(es)."
`.trim();
    const result = await runHiddenPowerShell(command, 15000);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "AGY를 종료하지 못했습니다.");
    }
    const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  }

  async function openLoginScript(scriptPath) {
    if (process.platform !== "linux") return shell.openPath(scriptPath);

    const terminal = [
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "xterm",
    ].map((name) => resolveCommand(name)).find(Boolean);
    if (!terminal) return "Linux terminal emulator was not found.";

    const invocation = linuxTerminalInvocation(terminal, scriptPath);
    return new Promise((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("spawn", () => {
        child.unref();
        resolve("");
      });
      child.once("error", (error) => resolve(error.message || String(error)));
    });
  }

  // Codex 공식 로그인 흐름을 실행할 스크립트를 만듭니다. (Windows: .cmd / macOS: .command)
  // Agora는 토큰을 직접 받지 않고, pending profile CODEX_HOME 안에서 `codex login`만 실행하게 합니다.
  function writeCodexLoginScript(profile) {
    if (["darwin", "linux"].includes(process.platform)) {
      const codexCommand = resolveCommand("codex", codexCommandCandidates());
      const fileName = process.platform === "darwin"
        ? "agora-codex-login.command"
        : "agora-codex-login.sh";
      const scriptPath = writeMacLoginScript(fileName, [
        `echo "Agora Codex Login - ${profile.id}"`,
        `export CODEX_HOME=${quoteShellArgument(profile.homePath)}`,
        `${codexCommand ? quoteShellArgument(codexCommand) : "codex"} login`,
      ]);
      appendDebugLog(
        `login script written: ${scriptPath}; profile=${profile.key}; home=${profile.homePath}; codex=${codexCommand || "PATH"}`
      );
      return scriptPath;
    }

    const scriptPath = path.join(app.getPath("userData"), "agora-codex-login.cmd");
    const codexCommand = codexAccountSwitcher.resolveCodexCommandForBatch();
    const codexLoginLine = codexCommand
      ? `call ${quoteCmdArgument(codexCommand)} login`
      : "call codex login";

    fs.writeFileSync(
      scriptPath,
      [
        "@echo off",
        `title Agora Codex Login - ${profile.id}`,
        "echo Agora Codex Login",
        "echo.",
        `echo Profile: ${profile.id}`,
        `echo CODEX_HOME: ${profile.homePath}`,
        "set \"CODEX_HOME=" + profile.homePath + "\"",
        "echo.",
        codexCommand
          ? `echo Using Codex command: ${codexCommand}`
          : "echo Codex command was not resolved by Agora. Trying PATH lookup...",
        "echo.",
        codexCommand ? "" : "where codex >nul 2>nul",
        codexCommand ? "" : "if errorlevel 1 (",
        codexCommand ? "" : "  echo codex command was not found in PATH.",
        codexCommand ? "" : "  echo Install Codex CLI or open a terminal where codex works.",
        codexCommand ? "" : "  echo.",
        codexCommand ? "" : "  pause",
        codexCommand ? "" : "  exit /b 1",
        codexCommand ? "" : ")",
        codexLoginLine,
        "set AGORA_LOGIN_EXIT=%ERRORLEVEL%",
        "echo.",
        "if not \"%AGORA_LOGIN_EXIT%\"==\"0\" (",
        "  echo Codex login exited with code %AGORA_LOGIN_EXIT%.",
        ") else (",
        "  echo Codex login command finished.",
        ")",
        "echo Return to Agora and open the account switch menu.",
        "echo.",
        "pause",
        "",
      ].filter((line) => line !== "").join("\r\n"),
      "utf8"
    );

    appendDebugLog(
      `login script written: ${scriptPath}; profile=${profile.key}; home=${profile.homePath}; codex=${codexCommand || "PATH"}`
    );
    return scriptPath;
  }

  function writeClaudeLoginScript() {
    const claudeCommand = resolveCommand("claude", claudeCommandCandidates());
    if (!claudeCommand) throw new Error("Claude 명령을 찾지 못했습니다.");

    if (["darwin", "linux"].includes(process.platform)) {
      const fileName = process.platform === "darwin"
        ? "agora-claude-login.command"
        : "agora-claude-login.sh";
      return writeMacLoginScript(fileName, [
        'echo "Agora Claude Login"',
        `${quoteShellArgument(claudeCommand)} auth login`,
      ]);
    }

    const scriptPath = path.join(app.getPath("userData"), "agora-claude-login.cmd");
    fs.writeFileSync(
      scriptPath,
      [
        "@echo off",
        "title Agora Claude Login",
        `call ${quoteCmdArgument(claudeCommand)} auth login`,
        "echo.",
        "pause",
        "",
      ].join("\r\n"),
      "utf8"
    );
    return scriptPath;
  }

  function getClaudeAuthStatus() {
    return new Promise((resolve, reject) => {
      const command = resolveCommand("claude", claudeCommandCandidates());
      if (!command) {
        reject(new Error("Claude 명령을 찾지 못했습니다."));
        return;
      }
      execFile(
        command,
        ["auth", "status", "--json"],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          shell: commandNeedsShell(command, process.platform),
        },
        (error, stdout) => {
          if (error) {
            reject(new Error("Claude 로그인 상태를 확인하지 못했습니다."));
            return;
          }
          try {
            resolve(normalizeClaudeAccountMetadata(JSON.parse(stdout)));
          } catch {
            reject(new Error("Claude 로그인 상태 형식이 올바르지 않습니다."));
          }
        }
      );
    });
  }

  let codexLoginLaunchInProgress = false;

  // Codex 로그인은 브라우저/OAuth/터미널 상호작용이 필요하므로 Agora 내부에서 직접 처리하지 않습니다.
  // 대신 pending profile CODEX_HOME을 만든 뒤 별도 터미널에서 `codex login`을 한 번만 실행합니다.
  async function openCodexLoginTerminal() {
    if (codexLoginLaunchInProgress) {
      showCodexAccountBubble("이미 Codex 로그인 터미널을 여는 중입니다.");
      return false;
    }

    codexLoginLaunchInProgress = true;

    try {
      codexAccountSwitcher.ensureCurrentAccountProfile();
      if (!["win32", "darwin", "linux"].includes(process.platform)) {
        throw new Error(`Agora 로그인 실행기는 ${process.platform}을 지원하지 않습니다.`);
      }

      const profile = codexAccountSwitcher.createLoginProfile();
      const scriptPath = writeCodexLoginScript(profile);

      showCodexAccountBubble(
        "새 Codex 로그인 터미널을 여는 중입니다."
      );

      // 여러 launcher를 순차 시도하면 실패 판정이 애매해서 터미널이 여러 개 뜹니다.
      // ShellExecute 한 경로만 사용하고, 실패하면 사용자가 직접 실행할 스크립트 경로를 보여줍니다.
      const error = await openLoginScript(scriptPath);
      appendDebugLog(`login terminal ShellExecute: ${error || "ok"}`);

      if (error) {
        showCodexAccountBubble(
          `Codex 로그인 터미널을 열지 못했어요.\n직접 이 파일을 실행해 주세요:\n${scriptPath}\n\n${error}`
        );
        return false;
      }

      showCodexAccountBubble(
        "Codex 로그인 터미널을 열었어요.\n로그인이 끝나면 '전환' 목록에 실제 계정명으로 나타납니다."
      );
      return true;
    } catch (error) {
      showCodexAccountBubble(
        `Codex 로그인 터미널을 열지 못했어요.\n${error.message || String(error)}`
      );
      return false;
    } finally {
      setTimeout(() => {
        codexLoginLaunchInProgress = false;
      }, 3000);
    }
  }

  // Windows의 Codex Desktop App만 선별적으로 종료합니다.
  // 일반 터미널 Codex CLI 세션까지 죽이지 않기 위해 WindowsApps 패키지 경로를 가진 프로세스만 대상으로 삼습니다.
  async function stopCodexDesktopApp() {
    if (!CODEX_DESKTOP_RESTART_CONFIG.enabledAfterAccountSwitch) {
      return { ok: true, skipped: true, stdout: "Restart disabled by config." };
    }

    if (process.platform === "darwin") {
      const result = await quitMacApp("Codex", CODEX_DESKTOP_RESTART_CONFIG.timeoutMs);
      // osascript 실패(자동화 권한 거부/타임아웃)를 성공으로 보고하면, 실제로는 멈추지 않은 앱을
      // 멈춘 것으로 오인해 사용자에게 "전환됨"이라고 잘못 알립니다. 실제 결과를 그대로 전달합니다.
      if (!result.ok) {
        throw new Error(result.stderr || "Codex Desktop 종료에 실패했습니다. (자동화 권한을 확인하세요)");
      }
      return { ok: true, skipped: false, stdout: result.stderr || "Codex Desktop quit requested." };
    }

    if (process.platform !== "win32") {
      return { ok: true, skipped: true, stdout: "Codex Desktop restart is not available on Linux." };
    }

    const marker = quotePowerShellString(CODEX_DESKTOP_RESTART_CONFIG.windowsProcessPathMarker);
    const launchDelayMs = CODEX_DESKTOP_RESTART_CONFIG.launchDelayMs;
    const command = `
$ErrorActionPreference = 'Stop'
$marker = ${marker}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.Contains($marker)) -or
  ($_.CommandLine -and $_.CommandLine.Contains($marker))
})
$ids = @($processes | Select-Object -ExpandProperty ProcessId -Unique)
foreach ($id in $ids) {
  try {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  } catch {}
}
Start-Sleep -Milliseconds ${launchDelayMs}
Write-Output "Stopped $($ids.Count) Codex Desktop process(es)."
`.trim();

    const result = await runHiddenPowerShell(command, CODEX_DESKTOP_RESTART_CONFIG.timeoutMs);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Codex Desktop stop failed.");
    }

    return result;
  }

  // 현재 ~/.codex/auth.json 기준으로 Codex Desktop App을 실행합니다.
  function launchCodexDesktopApp() {
    if (process.platform === "darwin") {
      const codexCommand = resolveCommand("codex", codexCommandCandidates());
      const child = codexCommand
        ? spawn(codexCommand, ["app"], { detached: true, stdio: "ignore" })
        : spawn("open", ["-a", "Codex"], { detached: true, stdio: "ignore" });
      child.unref();
      return Promise.resolve({ ok: true, skipped: false, stdout: "Launched Codex Desktop." });
    }

    if (process.platform !== "win32") {
      return Promise.resolve({
        ok: true,
        skipped: true,
        stdout: "Codex Desktop restart is not available on Linux.",
      });
    }

    return runHiddenPowerShell(
      buildWindowsCodexLaunchScript(),
      CODEX_DESKTOP_RESTART_CONFIG.timeoutMs
    ).then((result) => {
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Codex Desktop launch failed.");
      }
      return result;
    });
  }

  // Codex 계정은 저장된 auth profile 단위로 표시합니다.
  // 빈 pending 로그인 폴더는 codex-account-switcher.js에서 걸러서 UI에 나오지 않습니다.
  function formatCodexAccountLabel(profile) {
    const label = profile.hasAuth
      ? profile.label || `Codex ${profile.shortId || "unknown"}`
      : `${profile.id || profile.key} (로그인 필요)`;
    return profile.active ? `${label} (현재)` : label;
  }

  // Stage C — provider account selection boundary를 harness lifecycle에 알립니다.
  // 계정 변경은 provider-wide 세션 파괴가 아니라 session-selection boundary입니다:
  // runtime은 오염된 inflight turn만 정리하고, parked 세션은 계정 namespace
  // (providerAccountKey)로 격리된 채 보존됩니다. 확정된 전환(switchToProfile 성공)
  // 은 detail.accountKey로 새 계정의 stable key를 함께 전달하고, unknown 전이
  // (외부 로그인 시작 · partial-mutation 가능성이 있는 ambiguous 실패)는 key 없이
  // 호출합니다(전환 시작 전 검증 실패처럼 credential이 확실히 그대로인 실패는
  // 어떤 통지도 만들지 않습니다). 이 모듈은 adapter internals를 만지지 않고
  // chatFeature의 provider-neutral seam만 부릅니다.
  function notifyAccountLifecycle(provider, detail = {}) {
    try {
      const chatFeature = getChatFeature();
      if (chatFeature && typeof chatFeature.notifyProviderAccountChanged === "function") {
        chatFeature.notifyProviderAccountChanged(provider, {
          accountKey: detail.accountKey == null ? null : String(detail.accountKey),
        });
      }
    } catch (error) {
      appendDebugLog(`account lifecycle notify failed (${provider}): ${error?.message || String(error)}`);
    }
  }

  // ---- Stage C — provider 계정 identity 해석(SessionKey namespace용) ----
  //
  // chat-ipc control plane이 Professional managed turn 직전에 호출해, 현재 live
  // credential이 어느 계정 namespace인지 opaque stable key로 확정합니다.
  //   - 저장된 프로필이 live secret과 일치하면 그 프로필 key(안정적인 local profile
  //     key)를 씁니다. 프로필이 없으면 토큰 원문이 아닌 secret fingerprint
  //     (provider-profile-store의 profile key 파생 규칙과 동일한 16-hex 해시)로만
  //     식별합니다. 어떤 경우에도 access/refresh token 원문이나 표시용 이메일
  //     라벨을 identity로 노출하지 않습니다.
  //   - 확정할 수 없으면 { status: "unknown" }을 돌려주고, runtime이 Professional
  //     managed 실행을 fail-closed합니다(parked 세션은 보존).

  function stableStoreKeyFor(store, secret) {
    if (!secret) return null;
    try {
      const matched = store.findKeyBySecret(secret);
      if (matched) return matched;
    } catch {
      // 프로필 저장소를 읽지 못해도 fingerprint 경로는 시도할 수 있습니다.
    }
    try {
      return secretFingerprint(secret);
    } catch {
      return null;
    }
  }

  // 외부 `claude auth login` launcher가 열린 뒤에는 old credential이 그대로 남아
  // 있어 로그인 완료 여부를 live 상태만으로 구별할 수 없습니다(unknown window).
  // launch 시점의 baseline key와 다른 live key가 관측되는 순간에만 identity가
  // 재확립됩니다. 명시적 switchToProfile 성공도 window를 닫습니다.
  const claudeLoginWindow = { pending: false, baselineKey: null };

  function readClaudeAccountKey() {
    let live = null;
    try {
      live = claudeLiveStore.read();
    } catch {
      live = null;
    }
    if (!ClaudeAccountSwitcher.hasClaudeToken(live)) return null;
    return stableStoreKeyFor(claudeAccountSwitcher.store, live);
  }

  function resolveClaudeAccount() {
    const key = readClaudeAccountKey();
    if (claudeLoginWindow.pending) {
      if (key != null && key !== claudeLoginWindow.baselineKey) {
        // live credential이 baseline과 다르게 확정됐다 = 외부 로그인이 완료됐다.
        claudeLoginWindow.pending = false;
        claudeLoginWindow.baselineKey = null;
        return { status: "known", key };
      }
      return { status: "unknown" };
    }
    return key != null ? { status: "known", key } : { status: "unknown" };
  }

  async function resolveAgyAccount() {
    // AGY의 unknown window는 live 상태 자체가 인코딩합니다: prepareLogin이 live
    // credential을 지우므로, 자격 증명이 없으면 unknown이고 새 credential이
    // 존재하는 순간이 곧 재확립입니다(별도 pending 플래그 불필요).
    let secret = null;
    try {
      secret = await antigravityAccountSwitcher.read();
    } catch {
      secret = null;
    }
    if (!secret?.token?.refresh_token) return { status: "unknown" };
    const key = stableStoreKeyFor(antigravityAccountSwitcher.store, secret);
    return key != null ? { status: "known", key } : { status: "unknown" };
  }

  function resolveCodexAccount() {
    // Codex add-login은 pending profile CODEX_HOME에서 진행되어 live auth.json을
    // 건드리지 않으므로 unknown window를 만들지 않습니다. 계정 변경은 항상 명시적
    // switchToProfile / proxy auto-switch 경로를 지납니다.
    let summary = null;
    try {
      summary = codexAccountSwitcher.readCurrentAuthSummary();
    } catch {
      summary = null;
    }
    if (!summary || !summary.hasAuth) return { status: "unknown" };
    try {
      const matched = codexAccountSwitcher.findMatchingProfile(summary);
      if (matched) return { status: "known", key: matched };
    } catch {
      // 프로필 스캔 실패 시에도 안정 identity 필드 fingerprint로 식별을 시도합니다.
    }
    // accountId는 워크스페이스 공유 가능성이 있어 단독 identity가 아닙니다. 저장
    // 프로필 매칭(sameIdentity)과 같은 안정 필드 조합을 fingerprint합니다.
    const identity = [summary.subject, summary.accountId, summary.email]
      .filter(Boolean)
      .join("|");
    return identity
      ? { status: "known", key: fingerprint(`codex-account:${identity}`) }
      : { status: "unknown" };
  }

  async function resolveProviderAccount(providerId) {
    const provider = String(providerId || "");
    try {
      if (provider === "claude") return resolveClaudeAccount();
      if (provider === "agy") return resolveAgyAccount();
      if (provider === "codex") return resolveCodexAccount();
    } catch (error) {
      appendDebugLog(`account resolve failed (${provider}): ${error?.message || String(error)}`);
      return { status: "unknown" };
    }
    // 계정 개념이 연결되지 않은 provider는 unknown으로 fail-closed합니다.
    return { status: "unknown" };
  }

  // switchToProfile 실패가 live credential 무변경(사전 검증 실패)임이 확실한지.
  // 스위처가 mutation 시작 전에 던지는 오류에만 accountSwitchSafe 표식이 있습니다.
  function isCredentialUnchangedFailure(error) {
    return error?.accountSwitchSafe === true;
  }

  // 계정 프로필 실행/전환 결과를 펫 말풍선으로 알려줍니다.
  function showCodexAccountBubble(text) {
    // When the pet is off, surface account errors in the chat window instead of a pet bubble.
    if (!isPetEnabled()) {
      openChatWindow();
      const chatFeature = getChatFeature();
      if (chatFeature && typeof chatFeature.showSystemNotice === "function") {
        chatFeature.showSystemNotice(text);
      }
      return;
    }

    clearTimeout(getBubbleHideTimer());
    setBubbleHideTimer(null);

    showPetWindowFromTray();
    showBubble({
      kind: "activity",
      title: "Codex 계정",
      busy: false,
      text,
    });

    setBubbleHideTimer(setTimeout(() => {
      restoreActiveActivityBubble();
    }, bubbleDoneAutoHideMs));
  }

  // 현재 live ~/.codex/auth.json을 Agora 저장소에 저장합니다.
  function saveCurrentCodexAccount() {
    try {
      const profile = codexAccountSwitcher.saveCurrentAccount();
      invalidateProxyAccountsCache();
      refreshTrayMenu();
      showCodexAccountBubble(
        `"${profile.label}" 계정을 저장했습니다.\n전환 목록에는 로그인된 계정만 표시됩니다.`
      );
    } catch (error) {
      showCodexAccountBubble(
        `현재 Codex 계정을 저장하지 못했어요.\n${error.message || String(error)}`
      );
    }
  }

  // 저장된 계정 목록을 네이티브 메뉴로 띄웁니다.
  // auth.json이 없는 pending/빈 프로필은 codex-account-switcher.js에서 제거되어 여기에 나오지 않습니다.
  function showCodexAccountSwitchMenu() {
    clearTimeout(getBubbleHideTimer());
    setBubbleHideTimer(null);

    const profiles = codexAccountSwitcher.listProfiles();

    if (profiles.length === 0) {
      showCodexAccountBubble(
        "저장된 Codex 계정이 없습니다.\n먼저 '현재 저장'을 누르거나 '계정 추가'로 새 계정에 로그인하세요."
      );
      return;
    }

    const template = profiles.map((profile) => ({
      label: formatCodexAccountLabel(profile),
      type: "radio",
      checked: profile.active,
      enabled: profile.hasAuth,
      click: () => switchCodexAccount(profile.key),
    }));

    const bubbleWindow = getBubbleWindow();
    Menu.buildFromTemplate(template).popup({
      window: bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()
        ? bubbleWindow
        : getPetWindow(),
    });
  }

  // 실제 계정 전환입니다.
  // Codex Desktop을 먼저 멈추고, 저장된 auth를 ~/.codex/auth.json으로 교체한 뒤 다시 실행합니다.
  // 이미 떠 있는 일반 Codex CLI 터미널 세션은 사용자가 새로 시작해야 합니다.
  async function switchCodexAccount(profileKey) {
    const proxyModeRequested = isCodexProxyModeEnabled();
    if (proxyModeRequested && codexProxyStartupPromise) {
      await codexProxyStartupPromise;
    }

    if (proxyModeRequested && !codexProxyActive) {
      const reason = codexProxyLastError?.message || "프록시가 아직 활성화되지 않았습니다.";
      showCodexAccountBubble(
        `Codex 계정을 전환하지 않았습니다.\n재시작 없는 프록시 모드 시작에 실패했습니다.\n${reason}`
      );
      return false;
    }

    // 프록시가 실제로 config에 주입되어 트래픽이 프록시를 탈 때만 무재시작 경로를 씁니다.
    // (start만 되고 주입이 실패한 상태에서 이 경로로 빠지면 전환이 조용히 무시됩니다.)
    if (codexProxyActive) {
      try {
        const result = codexAccountSwitcher.switchToProfile(profileKey);
        invalidateProxyAccountsCache();
        // Stage C: 성공한 Codex 계정 전환은 selection boundary다 — 새 계정 key를
        // 전달해 오염된 inflight turn만 정리되고(parked 세션 보존), resident App
        // Server는 deliberate reset된다(다음 turn은 fresh server/thread).
        notifyAccountLifecycle("codex", { accountKey: profileKey });
        refreshTrayMenu();
        showCodexAccountBubble(
          `"${result.profile.label}" 계정으로 전환했습니다.\n프록시 모드: 재시작 없이 다음 요청부터 바로 적용됩니다.`
        );
        return true;
      } catch (error) {
        if (!isCredentialUnchangedFailure(error)) notifyAccountLifecycle("codex");
        showCodexAccountBubble(`Codex auth 전환에 실패했습니다.\n${error.message || String(error)}`);
        return false;
      }
    }

    try {
      showCodexAccountBubble(
        "Codex Desktop App을 멈추고 계정 전환을 준비하는 중입니다."
      );

      let stopError = null;
      try {
        await stopCodexDesktopApp();
      } catch (error) {
        stopError = error;
        appendDebugLog(`Codex Desktop stop failed before switch: ${error.message || String(error)}`);
      }

      try {
        const result = codexAccountSwitcher.switchToProfile(profileKey);
        notifyAccountLifecycle("codex", { accountKey: profileKey });
        refreshTrayMenu();

        let launchText = "Codex Desktop App 재실행을 요청했습니다.";
        try {
          const restartResult = await launchCodexDesktopApp();
          launchText = restartResult.skipped
            ? "재시작 설정이 꺼져 있어 auth만 교체했습니다."
            : "Codex Desktop App 재실행을 요청했습니다.";
        } catch (launchError) {
          launchText = `auth 교체는 완료됐지만 Codex Desktop 재실행은 실패했습니다.\n${launchError.message || String(launchError)}`;
          appendDebugLog(`Codex Desktop launch failed after switch: ${launchError.message || String(launchError)}`);
        }

        const stopText = stopError
          ? `Codex Desktop 종료 확인은 실패했지만 auth 교체는 진행했습니다.\n${stopError.message || String(stopError)}\n`
          : "";

        showCodexAccountBubble(
          `"${result.profile.label}" 계정으로 전환했습니다.\n${stopText}${launchText}\n열려 있던 Codex CLI 터미널은 새로 시작해야 적용됩니다.`
        );
        return true;
      } catch (switchError) {
        if (!isCredentialUnchangedFailure(switchError)) notifyAccountLifecycle("codex");
        showCodexAccountBubble(
          `Codex auth 전환에 실패했습니다.\n${switchError.message || String(switchError)}`
        );
        return false;
      }
    } catch (error) {
      showCodexAccountBubble(
        `Codex 계정을 전환하지 못했어요.\n${error.message || String(error)}`
      );
      return false;
    }
  }

  // 트레이/우클릭 메뉴에서도 같은 기능을 쓸 수 있게 작은 서브메뉴를 만듭니다.
  function buildCodexAccountSubmenu() {
    const profiles = codexAccountSwitcher.listProfiles();
    return buildAccountSubmenu({
      profiles,
      formatLabel: formatCodexAccountLabel,
      onSwitch: (key) => switchCodexAccount(key),
      onLogin: () => openCodexLoginTerminal(),
    });
  }

  async function switchProviderAccount(provider, profileKey) {
    if (provider === "codex") return switchCodexAccount(profileKey);
    const switcher = provider === "agy" ? antigravityAccountSwitcher : claudeAccountSwitcher;
    try {
      await switcher.switchToProfile(profileKey);
    } catch (error) {
      // credential이 부분 변경됐을 수 있는 ambiguous 실패는 unknown 전이다: 오염된
      // inflight turn만 정리되도록 key 없이 통지한다. 무변경 검증 실패는 그대로 둔다.
      if (!isCredentialUnchangedFailure(error)) notifyAccountLifecycle(provider);
      throw error;
    }
    // Stage C: 성공한 계정 전환은 selection boundary다 — 새 계정의 stable profile
    // key를 전달한다(runtime은 오염 inflight만 정리하고 parked 세션은 계정
    // namespace로 격리 보존한다). 명시적 전환은 Claude 외부 로그인 unknown
    // window도 닫는다(live credential이 방금 확정된 프로필로 재작성됐다).
    if (provider === "claude") {
      claudeLoginWindow.pending = false;
      claudeLoginWindow.baselineKey = null;
    }
    notifyAccountLifecycle(provider, { accountKey: profileKey });
    clearUsageCache(provider);
    refreshTrayMenu();
    return true;
  }

  function deleteProviderAccount(provider, profileKey) {
    if (typeof profileKey !== "string" || !profileKey) {
      throw new Error("올바르지 않은 계정 키입니다.");
    }
    const switcher = provider === "codex"
      ? codexAccountSwitcher
      : provider === "agy"
        ? antigravityAccountSwitcher
        : provider === "claude"
          ? claudeAccountSwitcher
          : null;
    if (!switcher) throw new Error("지원하지 않는 계정 유형입니다.");
    const deleted = switcher.deleteProfile(profileKey);
    if (provider === "codex") invalidateProxyAccountsCache();
    clearUsageCache(provider);
    refreshTrayMenu();
    return deleted;
  }

  async function startProviderLogin(provider) {
    if (provider === "codex") return Boolean(await openCodexLoginTerminal());

    if (provider === "agy") {
      let meta = {};
      try {
        const credential = await antigravityAccountSwitcher.read();
        try {
          const identity = await fetchAntigravityIdentity({ credential, force: true });
          meta.email = identity.email;
        } catch {
          // 한도 API와 별개인 계정 조회가 막히면 기존 저장 메타데이터를 유지합니다.
        }
        try {
          const current = await fetchAntigravityUsage({ credential, force: true });
          meta = { email: current.email || meta.email, plan: current.plan };
        } catch {
          // 한도 조회가 막혀도 확인한 이메일과 현재 자격 증명은 저장할 수 있습니다.
        }
      } catch {
        // 처음 로그인하는 PC라면 저장할 현재 계정이 없습니다.
      }
      try {
        await antigravityAccountSwitcher.prepareLogin(meta);
      } catch (error) {
        // clear/restart가 시작된 뒤의 실패는 live credential이 부분 변경됐을 수 있는
        // ambiguous 상태다: unknown 전이로 통지해 오염된 inflight AGY turn만
        // 정리한다(parked 세션은 계정 namespace에 보존). clear 이전(무변경 증명,
        // accountSwitchSafe) 실패는 어떤 통지도 만들지 않는다.
        if (!isCredentialUnchangedFailure(error)) notifyAccountLifecycle("agy");
        throw error;
      }
      // 성공한 prepareLogin은 live credential을 비우고 AGY를 재시작한 상태다 —
      // 계정 identity의 unknown window가 시작된다(live credential 부재 자체가
      // resolver의 unknown 표식이고, 새 로그인으로 credential이 생기는 순간이
      // 재확립이다). key 없이 통지해 오염된 inflight turn만 정리하고, old 계정의
      // parked 세션은 namespace에 그대로 남겨 되돌아오면 resume되게 한다.
      notifyAccountLifecycle("agy");
      clearUsageCache("agy");
      refreshTrayMenu();
      return true;
    }

    if (provider === "claude") {
      try {
        const status = await getClaudeAuthStatus();
        claudeAccountSwitcher.snapshotCurrent({
          email: status.email,
          plan: status.subscriptionType,
        });
      } catch {
        // 처음 로그인하는 PC라면 저장할 현재 계정이 없습니다.
      }
      // launcher가 열리기 전에 baseline key를 캡처한다(로그인이 아주 빨리 끝나도
      // baseline과의 차이로 재확립을 판정할 수 있게).
      const baselineKey = readClaudeAccountKey();
      const scriptPath = writeClaudeLoginScript();
      const error = await openLoginScript(scriptPath);
      if (error) throw new Error(error);
      // 외부 `claude auth login` 터미널은 완료 콜백이 없고 old credential은 로그인
      // 완료 전까지 그대로 남는다: launcher가 실제로 열린 순간부터 계정 identity
      // unknown window를 시작한다. window 동안 Professional managed 실행은
      // fail-closed되고(parked 세션 보존), baseline과 다른 live key가 관측되거나
      // 명시적 계정 전환이 성공해야 identity가 재확립된다. key 없이 통지해 오염
      // 가능성이 있는 inflight turn만 정리한다. launcher 실패는 live credential
      // 환경이 그대로이므로 window도 통지도 만들지 않는다.
      claudeLoginWindow.pending = true;
      claudeLoginWindow.baselineKey = baselineKey;
      notifyAccountLifecycle("claude");
      clearUsageCache("claude");
      return true;
    }

    throw new Error("지원하지 않는 계정 유형입니다.");
  }

  function showProviderAccountError(providerLabel, error) {
    playReaction("failed");
    showBubble({
      kind: "activity",
      title: `${providerLabel} 계정`,
      busy: false,
      text: error?.message || String(error),
    });
    setBubbleHideTimer(setTimeout(restoreActiveActivityBubble, bubbleDoneAutoHideMs));
  }

  function buildSimpleProviderSubmenu(switcher, provider, providerLabel) {
    const profiles = switcher.listProfiles();
    return buildAccountSubmenu({
      profiles,
      formatLabel: (profile) => profile.active ? `${profile.label} (현재)` : profile.label,
      onSwitch: (key) => switchProviderAccount(provider, key)
        .catch((error) => showProviderAccountError(providerLabel, error)),
      onLogin: () => startProviderLogin(provider)
        .catch((error) => showProviderAccountError(providerLabel, error)),
    });
  }

  function buildProviderAccountSubmenu() {
    return [
      { label: "Codex", submenu: buildCodexAccountSubmenu() },
      { label: "AGY", submenu: buildSimpleProviderSubmenu(antigravityAccountSwitcher, "agy", "AGY") },
      { label: "Claude", submenu: buildSimpleProviderSubmenu(claudeAccountSwitcher, "claude", "Claude") },
    ];
  }

  // Agora는 원래 Codex 설정/프록시를 건드리지 않습니다.
  // 사용자가 메뉴에서 명시적으로 켠 경우에만 프록시를 사용합니다.
  function isCodexProxyModeEnabled() {
    return readSettings().codexProxyMode === true;
  }

  let cachedProxyAccounts = null;
  let cachedProxyAccountsAt = 0;

  function invalidateProxyAccountsCache() {
    cachedProxyAccounts = null;
  }

  function listCodexProxyAccounts() {
    const now = Date.now();
    if (cachedProxyAccounts && now - cachedProxyAccountsAt < PROXY_ACCOUNTS_TTL_MS) {
      return cachedProxyAccounts;
    }

    const profiles = codexAccountSwitcher.listProfiles().filter((profile) => profile.hasAuth);
    const activeKey = codexAccountSwitcher.readActiveProfileKey();
    const accounts = profiles.map((profile) => ({
      key: profile.key,
      label: profile.label,
      authPath: path.join(profile.homePath, "auth.json"),
    }));
    accounts.sort((left, right) =>
      (right.key === activeKey ? 1 : 0) - (left.key === activeKey ? 1 : 0)
    );
    if (accounts.length === 0 && fs.existsSync(codexAccountSwitcher.targetAuthPath)) {
      accounts.push({ key: "live", label: "현재 계정", authPath: codexAccountSwitcher.targetAuthPath });
    }

    cachedProxyAccounts = accounts;
    cachedProxyAccountsAt = now;
    return accounts;
  }

  // 프록시가 실제로 config.toml에 주입되어 Codex 트래픽이 프록시를 타는 상태인지입니다.
  // start()만 성공하고 주입이 실패하면 running은 true여도 이 값은 false입니다.
  let codexProxyActive = false;
  let codexProxyStartupPromise = null;
  let codexProxyLastError = null;
  let codexProxyRecoveryPromise = null;

  // 채팅에서 Codex를 실행하기 직전에 설정과 실제 리스너 상태를 다시 맞춥니다.
  // 앱 강제 종료나 오래된 인스턴스가 남긴 죽은 localhost 주소 때문에 새 CLI가
  // 재시도만 반복하는 상황을 시작 시점뿐 아니라 매 실행마다 복구합니다.
  async function ensureCodexProxyReadyForRun() {
    if (codexProxyRecoveryPromise) return codexProxyRecoveryPromise;
    codexProxyRecoveryPromise = (async () => {
      if (codexProxyStartupPromise) await codexProxyStartupPromise;

      if (!isCodexProxyModeEnabled()) {
        disableProxyInConfig();
        if (codexProxy.running) codexProxy.stop();
        codexProxyActive = false;
        codexProxyLastError = null;
        return;
      }

      if (codexProxyActive && codexProxy.running) return;

      try {
        disableProxyInConfig();
        codexProxy.stop();
        const port = await codexProxy.start();
        enableProxyInConfig(port);
        codexProxyActive = true;
        codexProxyLastError = null;
      } catch (error) {
        codexProxyActive = false;
        codexProxyLastError = error;
        try {
          disableProxyInConfig();
        } catch {}
        codexProxy.stop();
        throw new Error(`Codex 로컬 프록시 복구 실패: ${error?.message || String(error)}`);
      }
    })().finally(() => {
      codexProxyRecoveryPromise = null;
    });
    return codexProxyRecoveryPromise;
  }

  async function prepareChatAgent(agent) {
    if (agent?.id === "codex") await ensureCodexProxyReadyForRun();
  }

  async function setCodexProxyMode(enabled) {
    try {
      if (enabled) {
        const port = await codexProxy.start();
        enableProxyInConfig(port);
        codexProxyActive = true;
        codexProxyLastError = null;
        writeSettings({ codexProxyMode: true });
        showCodexAccountBubble(
          "재시작 없는 전환(프록시)을 켰습니다.\n실행 중인 Codex CLI/앱은 한 번만 다시 시작하면 이후 전환부터는 재시작이 필요 없습니다."
        );
      } else {
        disableProxyInConfig();
        codexProxy.stop();
        codexProxyActive = false;
        codexProxyLastError = null;
        writeSettings({ codexProxyMode: false });
        showCodexAccountBubble("재시작 없는 전환(프록시)을 껐습니다.\nCodex는 원래 방식으로 되돌아갑니다.");
      }
    } catch (error) {
      appendDebugLog(`codex proxy toggle failed: ${error.message || String(error)}`);
      showCodexAccountBubble(`프록시 모드 전환에 실패했습니다.\n${error.message || String(error)}`);
      if (enabled) {
        // 주입이 실패했으면 Codex가 반쯤 걸린 상태가 되지 않도록 config를 원복하고 완전히 끕니다.
        codexProxyActive = false;
        codexProxyLastError = error;
        try {
          disableProxyInConfig();
        } catch {
          // 원복 실패는 무시합니다.
        }
        codexProxy.stop();
        writeSettings({ codexProxyMode: false });
      }
    }
    refreshTrayMenu();
  }

  // 앱 시작 시 프록시를 복원합니다.
  function restoreCodexProxyMode() {
    codexProxyStartupPromise = (async () => {
      // crash/강제 종료로 이전 실행이 남긴 죽은 프록시 마커를 항상 먼저 정리합니다. (fail-closed)
      // 이렇게 하지 않으면 config.toml이 죽은 포트를 가리켜 Codex 전체가 막힙니다.
      try {
        disableProxyInConfig();
      } catch (error) {
        appendDebugLog(`codex proxy stale cleanup failed: ${error.message || String(error)}`);
      }
      if (!isCodexProxyModeEnabled()) return;
      try {
        const port = await codexProxy.start();
        enableProxyInConfig(port);
        codexProxyActive = true;
        codexProxyLastError = null;
      } catch (error) {
        // 주입 실패(예: 사용자가 직접 openai_base_url을 설정)면 프록시를 완전히 끕니다.
        // 그래야 switchCodexAccount가 프록시 경로로 잘못 빠져 조용히 아무것도 안 하는 상황을 막습니다.
        appendDebugLog(`codex proxy restore failed: ${error.message || String(error)}`);
        codexProxyActive = false;
        codexProxyLastError = error;
        codexProxy.stop();
      }
    })();
    return codexProxyStartupPromise;
  }

  // 종료 시 모드와 무관하게 주입된 마커를 항상 제거합니다. (다음 실행 때 필요하면 재주입)
  function teardownCodexProxyOnQuit() {
    try {
      disableProxyInConfig();
    } catch {
      // 종료 경로에서는 실패해도 앱 종료를 막지 않습니다.
    }
    codexProxy.stop();
    codexProxyActive = false;
  }

  const codexAccountSwitcher = new CodexAccountSwitcher();
  codexAccountSwitcher.cleanupStalePendingProfiles();
  codexAccountSwitcher.ensureCurrentAccountProfile();

  // Codex 재시작 없는 전환 + 한도 자동 로테이션용 로컬 프록시입니다. (명시적 opt-in)
  // 선호 순서: 활성 프로필 → 나머지 저장 프로필. 저장 프로필이 하나도 없으면 live auth.json 하나로 동작.
  // 저장 프로필에서 직접 읽으므로 실행 중인 Codex 앱이 auth.json을 되덮어써도 전환이 유지됩니다.
  const codexProxy = new CodexProxy({
    log: appendDebugLog,
    resolveAccounts: async () => listCodexProxyAccounts(),
    readAuth: (authPath) => {
      const summary = codexAccountSwitcher.readAuthSummaryFromFile(authPath);
      return summary.hasAuth ? { accessToken: summary.accessToken, accountId: summary.accountId } : null;
    },
    notifySwitch: (account, reason) => {
      // 프록시는 이미 이 계정으로 응답을 스트리밍하는 중입니다. 활성 프로필 영속화(디스크 백업 복사 등
      // 무거운 동기 작업)와 UI 갱신은 응답 중계를 지연시키지 않도록 다음 tick으로 미룹니다.
      setImmediate(() => {
        // Stage C: 프록시 auto-switch는 이 시점에 이미 실제 계정이 바뀐 상태다
        // (영속화 성공 여부와 무관). 전환된 프로필 key와 함께 selection boundary를
        // 즉시 알린다(오염 inflight 정리 + resident App Server reset, parked 보존).
        // 저장 프로필이 하나도 없는 "live" fallback은 key를 확정할 수 없어 unknown
        // 전이로 알린다.
        notifyAccountLifecycle(
          "codex",
          account.key !== "live" ? { accountKey: account.key } : {}
        );
        try {
          if (account.key !== "live") {
            codexAccountSwitcher.switchToProfile(account.key);
            invalidateProxyAccountsCache();
            refreshTrayMenu();
          }
        } catch (error) {
          appendDebugLog(`auto-switch persist failed: ${error.message || String(error)}`);
        }
        appendDebugLog(`codex auto-switch to ${account.key} (${reason})`);
        showCodexAccountBubble(
          `Codex 한도가 소진돼 "${account.label}" 계정으로 자동 전환했습니다.\n재시작 없이 바로 적용됐어요.`
        );
      });
    },
  });

  // macOS에서는 Claude Code live 자격 증명이 Keychain에 있으므로 플랫폼 저장소를 주입합니다.
  const claudeLiveStore = createClaudeLiveStore();
  const claudeAccountSwitcher = new ClaudeAccountSwitcher({ liveStore: claudeLiveStore });
  const antigravityAccountSwitcher = new AntigravityAccountSwitcher({
    read: async () => JSON.parse(await readCredential("gemini:antigravity")),
    write: async (value) => writeCredential("gemini:antigravity", value),
    clear: async () => deleteCredential("gemini:antigravity"),
    restart: restartAntigravityApp,
  });

  return {
    // 계정 전환기/자격 증명 저장소 인스턴스. main.js의 설정 데이터 조립부
    // (codexAccountRows/loadCodexUsage/loadAntigravityProvider/loadClaudeProvider)가
    // 직접 조회합니다.
    codexAccountSwitcher,
    claudeAccountSwitcher,
    antigravityAccountSwitcher,
    claudeLiveStore,

    prepareChatAgent,
    // Stage C — Professional managed turn의 계정 namespace 확정(chat-ipc가 turn
    // 직전에 호출). unknown이면 runtime이 fail-closed한다.
    resolveProviderAccount,
    isCodexProxyModeEnabled,
    setCodexProxyMode,
    restoreCodexProxyMode,
    teardownCodexProxyOnQuit,
    openCodexLoginTerminal,
    saveCurrentCodexAccount,
    showCodexAccountSwitchMenu,
    switchCodexAccount,
    buildProviderAccountSubmenu,
    switchProviderAccount,
    deleteProviderAccount,
    startProviderLogin,
    getClaudeAuthStatus,
  };
}

module.exports = { createAccountSwitching };
