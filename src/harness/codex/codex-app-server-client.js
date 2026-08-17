"use strict";

const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

// Stage C-3 — Codex App Server client (installed codex-cli 0.147.0, app-server v2).
//
// 하나의 long-lived `codex app-server --stdio` child에 대한 JSON-RPC-유사 transport다.
// 설치 스키마 기준(source of truth: 사용자 머신 generate-json-schema):
//   - envelope에 "jsonrpc" 필드가 없다.
//       request      { id, method, params? }
//       notification { method, params? }
//       response     { id, result }
//       error        { id, error }
//     id = string|int. 한 줄에 JSON 하나(newline-delimited).
//   - handshake: initialize(request) -> result -> `initialized`(notification) -> READY.
//
// 이 client는 transport일 뿐이다. thread/turn/approval/permission 의미는 상위
// CodexManagedAdapter가 결정한다. 여기서는 어떤 control-plane authority도 갖지 않는다.
//
// 안전 계약:
//   - handshake 완료(READY) 전에는 thread/turn 요청을 보내지 않는다(호출자 계약).
//   - request id는 connection 내에서 unique. out-of-order response도 정확히 correlation.
//   - chunk 경계에 의존하지 않는다(한 chunk에 여러 줄 / 한 줄이 여러 chunk 모두 처리).
//   - stdout은 protocol channel이다. 정상 JSON object가 아닌 non-empty 줄은 protocol
//     desync로 보고 fail-closed한다. 정상 JSON이지만 미사용 notification은 forward
//     compatibility로 무시(호출자에게 전달만)한다.
//   - READY 이후 child가 죽으면 자동 restart하지 않는다(연속성 증명 불가 → lost).

const STATE = Object.freeze({
  NEW: "new",
  STARTING: "starting",
  READY: "ready",
  LOST: "lost",
  CLOSED: "closed",
});

const DEFAULT_RPC_TIMEOUT_MS = 30 * 1000;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_LINE_BUFFER_CHARS = 512 * 1024;

class CodexAppServerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

class CodexAppServerClient {
  constructor(options = {}) {
    this.commandPath = options.commandPath;
    this.needsShell = Boolean(options.needsShell);
    this._spawn = options.spawnFn || spawn;
    this._clientInfo = options.clientInfo || { name: "agora", version: "1.0.1" };
    this._rpcTimeoutMs = Number.isFinite(options.rpcTimeoutMs) && options.rpcTimeoutMs > 0
      ? options.rpcTimeoutMs
      : DEFAULT_RPC_TIMEOUT_MS;
    // 상위(adapter)로의 콜백. transport는 해석하지 않고 그대로 전달만 한다.
    this._onNotification = typeof options.onNotification === "function" ? options.onNotification : () => {};
    this._onServerRequest = typeof options.onServerRequest === "function" ? options.onServerRequest : () => {};
    this._onClose = typeof options.onClose === "function" ? options.onClose : () => {};

    this.state = STATE.NEW;
    this._child = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._stdoutDecoder = new StringDecoder("utf8");
    this._lineBuffer = "";
    this._stderr = "";
    this._startPromise = null;
    this._lostReason = null;
  }

  isReady() {
    return this.state === STATE.READY;
  }

  // spawn + handshake. 성공 시 READY. 중복 호출은 같은 promise를 돌려준다.
  start() {
    if (this._startPromise) return this._startPromise;
    if (this.state !== STATE.NEW) {
      return Promise.reject(new CodexAppServerError("CODEX_APP_SERVER_START_FAILED", `잘못된 상태에서 start: ${this.state}`));
    }
    this.state = STATE.STARTING;
    this._startPromise = new Promise((resolve, reject) => {
      let child;
      try {
        const command = this.needsShell ? `"${this.commandPath}"` : this.commandPath;
        child = this._spawn(command, ["app-server", "--stdio"], {
          shell: Boolean(this.needsShell),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        this._markLost("CODEX_APP_SERVER_START_FAILED", error?.message);
        reject(new CodexAppServerError("CODEX_APP_SERVER_START_FAILED", error?.message));
        return;
      }
      this._child = child;
      child.on("error", (error) => {
        this._markLost("CODEX_APP_SERVER_START_FAILED", error?.message);
      });
      child.on("close", () => {
        // READY 이전이면 시작 실패, 이후면 session lost. 어느 쪽도 자동 restart 없음.
        this._markLost(this.state === STATE.READY ? "CODEX_SESSION_LOST" : "CODEX_APP_SERVER_START_FAILED", "app-server process closed");
      });
      if (child.stdout) child.stdout.on("data", (chunk) => this._onStdout(chunk));
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          if (this._stderr.length < MAX_STDERR_BYTES) this._stderr += String(chunk);
        });
      }
      if (child.stdin) child.stdin.on("error", () => {});

      // handshake: initialize -> initialized notification -> READY
      this._request("initialize", {
        clientInfo: this._clientInfo,
        // capabilities.experimentalApi는 켜지 않는다(stable surface만 사용).
        capabilities: {},
      }).then(() => {
        if (this.state !== STATE.STARTING) {
          reject(new CodexAppServerError("CODEX_APP_SERVER_INIT_FAILED", `handshake 중 상태 변화: ${this.state}`));
          return;
        }
        try {
          this._writeMessage({ method: "initialized" });
        } catch (error) {
          this._markLost("CODEX_APP_SERVER_INIT_FAILED", error?.message);
          reject(new CodexAppServerError("CODEX_APP_SERVER_INIT_FAILED", error?.message));
          return;
        }
        this.state = STATE.READY;
        resolve(this);
      }).catch((error) => {
        this._markLost("CODEX_APP_SERVER_INIT_FAILED", error?.message);
        reject(error instanceof CodexAppServerError ? error : new CodexAppServerError("CODEX_APP_SERVER_INIT_FAILED", error?.message));
      });
    });
    return this._startPromise;
  }

  // READY 상태에서만 허용되는 mutating/일반 request.
  request(method, params) {
    if (this.state !== STATE.READY) {
      return Promise.reject(new CodexAppServerError("CODEX_SESSION_LOST", `연결이 READY가 아닙니다: ${this.state}`));
    }
    return this._request(method, params);
  }

  // handshake 포함 내부 request. id 상관관계 + bounded timeout.
  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId;
      this._nextId += 1;
      let message;
      try {
        message = { id, method };
        if (params !== undefined) message.params = params;
        this._writeMessage(message);
      } catch (error) {
        reject(new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", error?.message));
        return;
      }
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new CodexAppServerError("CODEX_APP_SERVER_PROTOCOL_ERROR", `RPC timeout: ${method}`));
        }
      }, this._rpcTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  // server -> client request에 대한 응답(result). approval decline 등에 사용.
  respond(id, result) {
    if (this.state !== STATE.READY) return false;
    try {
      this._writeMessage({ id, result: result === undefined ? {} : result });
      return true;
    } catch {
      return false;
    }
  }

  notify(method, params) {
    if (this.state !== STATE.READY) return false;
    try {
      const message = { method };
      if (params !== undefined) message.params = params;
      this._writeMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (this.state === STATE.CLOSED) return;
    const prev = this.state;
    this.state = STATE.CLOSED;
    this._rejectAllPending(new CodexAppServerError("CODEX_SESSION_LOST", "client closed"));
    if (this._child) {
      try { this._child.kill(); } catch {}
    }
    if (prev !== STATE.LOST) this._onClose({ reason: "closed" });
  }

  // ---- internals ----

  _writeMessage(obj) {
    if (!this._child || !this._child.stdin || !this._child.stdin.writable) {
      throw new Error("app-server stdin을 사용할 수 없습니다.");
    }
    this._child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _onStdout(chunk) {
    if (this.state === STATE.CLOSED || this.state === STATE.LOST) return;
    this._lineBuffer += this._stdoutDecoder.write(chunk);
    let index = this._lineBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this._lineBuffer.slice(0, index);
      this._lineBuffer = this._lineBuffer.slice(index + 1);
      this._handleLine(line);
      if (this.state === STATE.LOST || this.state === STATE.CLOSED) return;
      index = this._lineBuffer.indexOf("\n");
    }
    // 줄바꿈 없이 비정상적으로 커지는 버퍼는 desync 신호로 본다.
    if (this._lineBuffer.length > MAX_LINE_BUFFER_CHARS) {
      this._markLost("CODEX_APP_SERVER_PROTOCOL_ERROR", "protocol line buffer overflow");
    }
  }

  _handleLine(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") return; // 빈 줄은 무시
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout은 protocol channel이다. JSON이 아니면 desync → fail-closed.
      this._markLost("CODEX_APP_SERVER_PROTOCOL_ERROR", "non-JSON on protocol stdout");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this._markLost("CODEX_APP_SERVER_PROTOCOL_ERROR", "non-object protocol message");
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const hasMethod = typeof message.method === "string";

    // response / error (id 있고 method 없음)
    if (hasId && !hasMethod) {
      const pending = this._pending.get(message.id);
      if (!pending) {
        // 짝 없는 response id = desync.
        this._markLost("CODEX_APP_SERVER_PROTOCOL_ERROR", "response for unknown request id");
        return;
      }
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        const err = message.error || {};
        pending.reject(new CodexAppServerError("CODEX_APP_SERVER_RPC_ERROR", err.message || `RPC error (${err.code ?? "?"})`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // server -> client request (id 있고 method 있음): approval 등
    if (hasId && hasMethod) {
      this._onServerRequest(message.id, message.method, message.params);
      return;
    }

    // notification (method 있고 id 없음). 미사용 method도 그대로 전달(forward-compat).
    if (hasMethod) {
      this._onNotification(message.method, message.params);
      return;
    }

    // id도 method도 없는 메시지 = desync.
    this._markLost("CODEX_APP_SERVER_PROTOCOL_ERROR", "message without id or method");
  }

  _rejectAllPending(error) {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      try { pending.reject(error); } catch {}
    }
    this._pending.clear();
  }

  _markLost(code, detail) {
    if (this.state === STATE.LOST || this.state === STATE.CLOSED) return;
    this.state = STATE.LOST;
    this._lostReason = { code, detail: detail || null };
    this._rejectAllPending(new CodexAppServerError(code, detail));
    if (this._child) {
      try { this._child.kill(); } catch {}
    }
    this._onClose({ reason: "lost", code, detail: detail || null });
  }
}

module.exports = { CodexAppServerClient, CodexAppServerError, STATE };
