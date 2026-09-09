"use strict";
// CLI 로그인을 터미널 창 없이 앱 안에서 돌린다.
//
// 로그인 명령(`claude auth login`, `codex login`)은 TTY 없이 띄워도 브라우저 주소를
// 출력하고, Claude는 이어서 "Paste code here if prompted >"로 인증 코드를 기다린다.
// 예전에는 이 명령을 담은 스크립트를 터미널 창에서 열었다 — 사용자는 로그인할
// 때마다 터미널을 만나야 했고, 그 창에서 무슨 일이 일어나는지 앱은 알 수 없었다.
//
// 여기서는 그 프로세스를 자식으로 띄워 출력에서 주소를 찾아 알리고, 사용자가
// 붙여 넣은 코드를 표준입력으로 넘기며, 종료 코드로 성공을 판정한다. 로그인이
// 실제로 무엇을 바꿨는지(자격 증명)는 호출자가 끝난 뒤 다시 확인한다.
//
// 제공자별로 한 번에 하나만 돈다. 사용자가 브라우저에서 끝내지 않으면 timeoutMs
// 뒤 프로세스를 끊는다 — 호출자가 그 동안 잡아 둔 계정 경계도 그때 풀린다.
const { spawn: defaultSpawn } = require("node:child_process");

const URL_PATTERN = /https?:\/\/[^\s"'<>()\]]+/g;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_LINES = 12;
const MAX_LINES = 200;

// Windows의 npm 셸 래퍼(.cmd/.bat)는 cmd.exe를 거쳐야 실행된다.
function needsShell(command) {
  return /\.(cmd|bat)$/i.test(String(command || ""));
}

// 주소 뒤에 붙은 문장 부호는 주소가 아니다("…callback). 다음을 보세요" 같은 출력).
function extractUrls(text) {
  return (String(text || "").match(URL_PATTERN) || []).map((raw) => raw.replace(/[.,;:!?]+$/, ""));
}

function createCliLoginRunner(options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const sessions = new Map();

  function tail(session) {
    return session.lines.slice(-TAIL_LINES);
  }

  // onEvent: 진행 상황(started · url · output · exit)을 화면으로 나르는 통로.
  // onExit: 종료 뒤 호출자의 정리(계정 경계 해제, 자격 증명 재확인).
  function start({ provider, command, args = [], env, cwd, onEvent, onExit } = {}) {
    if (!provider) throw new Error("provider가 필요합니다.");
    if (sessions.has(provider)) throw new Error("이미 로그인이 진행 중입니다.");
    if (!command) throw new Error("로그인 명령을 찾지 못했습니다.");

    const session = {
      provider,
      urls: [],
      lines: [],
      child: null,
      timer: null,
      finished: false,
      timedOut: false,
      cancelled: false,
    };
    const emit = (event) => {
      try {
        if (typeof onEvent === "function") onEvent({ provider, ...event });
      } catch {
        // 화면 통지 실패가 로그인 자체를 멈추면 안 된다.
      }
    };

    const shell = needsShell(command);
    let child;
    try {
      child = spawn(shell ? `"${command}"` : command, args, {
        env,
        cwd,
        shell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`로그인 명령을 실행하지 못했습니다: ${error?.message || String(error)}`);
    }
    session.child = child;
    sessions.set(provider, session);

    const onChunk = (chunk) => {
      const text = String(chunk || "");
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        session.lines.push(trimmed);
        if (session.lines.length > MAX_LINES) session.lines.shift();
      }
      for (const url of extractUrls(text)) {
        if (session.urls.includes(url)) continue;
        session.urls.push(url);
        emit({ type: "url", url });
      }
      // 줄바꿈 없이 끝나는 출력은 입력을 기다리는 프롬프트다(Claude의 "Paste code here").
      emit({ type: "output", text, prompt: !/\r?\n\s*$/.test(text) });
    };
    if (child.stdout) {
      if (typeof child.stdout.setEncoding === "function") child.stdout.setEncoding("utf8");
      child.stdout.on("data", onChunk);
    }
    if (child.stderr) {
      if (typeof child.stderr.setEncoding === "function") child.stderr.setEncoding("utf8");
      child.stderr.on("data", onChunk);
    }

    // 호출자의 정리(onExit: 경계 해제 · 자격 증명 재확인)를 먼저 끝내고 나서 화면에
    // 종료를 알린다. 순서가 반대면 화면이 아직 갱신되지 않은 계정 목록을 받는다.
    const finish = async (result) => {
      if (session.finished) return;
      session.finished = true;
      clearTimeout(session.timer);
      sessions.delete(provider);
      const summary = { ...result, tail: tail(session) };
      try {
        if (typeof onExit === "function") await onExit({ provider, ...summary });
      } catch {
        // 정리 실패는 호출자의 로그로 남길 일이지 여기서 던질 일이 아니다.
      }
      emit({ type: "exit", ...summary });
    };
    child.once("error", (error) => {
      void finish({ ok: false, code: null, error: error?.message || String(error) });
    });
    // "close"가 아니라 "exit"를 본다. 로그인 명령이 브라우저를 여는 자식(xdg-open 등)에
    // 파이프를 물려주면 그 자식이 살아 있는 동안 "close"가 오지 않는다.
    child.once("exit", (code, signal) => {
      void finish({
        ok: code === 0 && !session.timedOut && !session.cancelled,
        code,
        signal: signal || null,
        timedOut: session.timedOut,
        cancelled: session.cancelled,
      });
    });

    session.timer = setTimeout(() => {
      session.timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    if (typeof session.timer.unref === "function") session.timer.unref();

    emit({ type: "started", command, args });
    return { provider };
  }

  // 사용자가 붙여 넣은 인증 코드를 CLI에 넘긴다(Claude 흐름).
  function input(provider, text) {
    const session = sessions.get(provider);
    if (!session) throw new Error("진행 중인 로그인이 없습니다.");
    const value = String(text ?? "").trim();
    if (!value) throw new Error("입력할 코드가 비어 있습니다.");
    if (!session.child.stdin || session.child.stdin.destroyed) {
      throw new Error("로그인 명령이 입력을 받지 않습니다.");
    }
    session.child.stdin.write(`${value}\n`);
    return true;
  }

  function cancel(provider) {
    const session = sessions.get(provider);
    if (!session) return false;
    session.cancelled = true;
    try {
      session.child.kill();
    } catch {}
    return true;
  }

  function isRunning(provider) {
    return sessions.has(provider);
  }

  // 화면이 열어 달라는 주소는 이 로그인이 실제로 출력한 것이어야 한다.
  function knowsUrl(provider, url) {
    const session = sessions.get(provider);
    return Boolean(session && session.urls.includes(String(url || "")));
  }

  return { start, input, cancel, isRunning, knowsUrl };
}

module.exports = { createCliLoginRunner, needsShell, extractUrls, DEFAULT_TIMEOUT_MS };
