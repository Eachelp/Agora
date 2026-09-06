const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { selectCommandPath, commandNeedsShell } = require("../command-resolution");

// 채팅과 계정 전환이 함께 쓰는 단일 프로바이더 탐지 모듈입니다.
// - 후보 경로 → where/which 순서로 실행 파일을 찾고,
// - --version 프로브로 실제 실행 가능 여부를 확인하며,
// - renderer에는 경로/셸 정보가 없는 안전한 뷰만 내보냅니다.

const PROBE_TIMEOUT_MS = 5000;
const MODEL_PROBE_TIMEOUT_MS = 15000;
// 모델 카탈로그는 CLI 버전이 같아도 서버 쪽에서 바뀔 수 있습니다(Codex model/list는
// 계정에 열린 모델을 보고합니다). 이 시간이 지나면 캐시로 먼저 응답하고 뒤에서 다시
// 조회해 갱신합니다.
const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,63}$/;

function probeCodexModelCatalog(commandPath, needsShell, timeoutMs = 8000, deps = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    const spawnFn = deps.spawnFn || spawn;
    try {
      child = spawnFn(needsShell ? `"${commandPath}"` : commandPath, ["app-server", "--stdio"], {
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          // C3 App Server client와 동일한 handshake: initialize 응답 후 initialized
          // notification을 먼저 보낸 뒤 model/list를 요청한다(BLOCKER 3).
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false, limit: 100 } })}\n`);
        }
        if (message.id === 2 && Array.isArray(message.result?.data)) {
          const modelOptions = message.result.data
            .filter((item) => !item.hidden && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(item.model))
            .map((item) => ({
              id: item.model,
              label: item.displayName || item.model,
              isDefault: Boolean(item.isDefault),
              efforts: (item.supportedReasoningEfforts || [])
                .map((entry) => entry.reasoningEffort)
                .filter((effort) => /^[A-Za-z0-9._-]+$/.test(effort)),
            }));
          finish(modelOptions.length > 0 ? modelOptions : null);
        }
      }
    });
    child.stdin.on("error", () => finish(null));
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "agora", version: "1.0.1" }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
}

function probeAgyModelCatalog(commandPath, needsShell, timeoutMs = MODEL_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let output = "";
    let quietTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try { child?.kill(); } catch {}
      // agy models는 "모델이름   설명" 두 열로 출력됩니다. 줄 전체가 아니라
      // 앞쪽 첫 토큰(모델 이름)만 뽑아 검증해야, 뒤에 붙는 설명 때문에
      // 정상 모델 줄이 통째로 걸러지지 않습니다.
      const models = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[0])
        .filter((token) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(token));
      resolve(models.length > 0 ? ["default", ...models] : null);
    };
    const hardTimer = setTimeout(finish, timeoutMs);
    if (typeof hardTimer.unref === "function") hardTimer.unref();
    try {
      child = spawn(needsShell ? `"${commandPath}"` : commandPath, ["models"], {
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish();
      return;
    }
    child.on("error", finish);
    child.on("close", finish);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (quietTimer) clearTimeout(quietTimer);
      // agy 1.1.10은 목록을 모두 출력한 뒤에도 파이프를 오래 열어두는
      // 경우가 있어, 마지막 출력 후 짧은 정적 구간을 완료로 봅니다.
      quietTimer = setTimeout(finish, 350);
    });
  });
}

// AGY는 모델마다 reasoning effort를 받는 방식이 다릅니다. Gemini 변형은
// 명시된 low/medium/high만 허용하지만, Claude Thinking·GPT-OSS Medium은
// 모델 자체가 고정 변형이라 --effort를 추가하면 CLI가 거부할 수 있습니다.
const AGY_MODEL_OPTIONS = Object.freeze([
  Object.freeze({ id: "default", label: "AGY 기본값", efforts: Object.freeze([]) }),
  Object.freeze({ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (높음)", efforts: Object.freeze(["high"]) }),
  Object.freeze({ id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (중간)", efforts: Object.freeze(["medium"]) }),
  Object.freeze({ id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (낮음)", efforts: Object.freeze(["low"]) }),
  Object.freeze({ id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (높음)", efforts: Object.freeze(["high"]) }),
  Object.freeze({ id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (중간)", efforts: Object.freeze(["medium"]) }),
  Object.freeze({ id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (낮음)", efforts: Object.freeze(["low"]) }),
  Object.freeze({ id: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (높음)", efforts: Object.freeze(["high"]) }),
  Object.freeze({ id: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (중간)", efforts: Object.freeze(["medium"]) }),
  Object.freeze({ id: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (낮음)", efforts: Object.freeze(["low"]) }),
  Object.freeze({ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (높음)", efforts: Object.freeze(["high"]) }),
  Object.freeze({ id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (낮음)", efforts: Object.freeze(["low"]) }),
  Object.freeze({ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", efforts: Object.freeze([]) }),
  Object.freeze({ id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: Object.freeze([]) }),
  Object.freeze({ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (중간)", efforts: Object.freeze([]) }),
]);
// 노력 변형을 접는 규칙이 바뀌면 올려서 저장된 capability 캐시를 무효화합니다.
const AGY_MODEL_OPTIONS_VERSION = 4;

const EFFORT_VARIANT_ID = /^(.+)-(low|medium|high)$/;
const EFFORT_ORDER = Object.freeze(["low", "medium", "high"]);

// "Gemini 3.7 Flash (높음)" → "Gemini 3.7 Flash".
function baseModelLabel(label, baseId) {
  const stripped = String(label || "")
    .replace(/\s*[(（]\s*(?:높음|중간|낮음|high|medium|low)\s*[)）]\s*$/i, "")
    .trim();
  return stripped || baseId;
}

// `agy models`는 같은 모델을 gemini-3.7-flash-high / -medium / -low 처럼
// 노력 단계마다 따로 보고합니다. 목록에 세 줄씩 늘어놓으면 옆의 "노력" 선택이
// 늘 비활성이 되고 같은 선택을 두 곳에서 하게 됩니다. 모델 한 줄로 접고 단계는
// 노력 선택이 맡되, CLI에 넘길 실제 id는 effortModels에 남겨 둡니다.
function collapseEffortVariants(options) {
  const collapsed = [];
  const byBase = new Map();

  for (const option of options) {
    const match = EFFORT_VARIANT_ID.exec(option.id || "");
    // 모델 자체가 고정 변형인 항목(Claude Thinking·GPT-OSS Medium)과 아직 규칙을
    // 모르는 새 모델(efforts 없음)은 접지 않고 그대로 둡니다.
    if (!match || (option.efforts || []).length === 0) {
      collapsed.push(option);
      continue;
    }
    const [, baseId, effort] = match;
    let entry = byBase.get(baseId);
    if (!entry) {
      entry = {
        ...option,
        id: baseId,
        label: baseModelLabel(option.label, baseId),
        efforts: [],
        effortModels: {},
      };
      byBase.set(baseId, entry);
      collapsed.push(entry);
    }
    if (!entry.efforts.includes(effort)) entry.efforts.push(effort);
    entry.effortModels[effort] = option.id;
    if (option.isDefault) entry.isDefault = true;
  }

  for (const entry of byBase.values()) {
    entry.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  }
  return collapsed;
}

// 예전 세션이 저장해 둔 변형 id(gemini-3.7-flash-high)를 지금 목록의
// (모델, 노력) 쌍으로 옮깁니다. 이미 목록에 있는 id면 옮길 것이 없어 null입니다.
function resolveEffortVariant(modelOptions, model) {
  if (!model) return null;
  const options = modelOptions || [];
  if (options.some((option) => option.id === model)) return null;
  for (const option of options) {
    const found = Object.entries(option.effortModels || {})
      .find(([, variantId]) => variantId === model);
    if (found) return { model: option.id, effort: found[0] };
  }
  return null;
}

function modelOptionsFor(def, models) {
  const mapped = (models || []).map((id) => {
    const known = (def.modelOptions || []).find((option) => option.id === id);
    if (known) return { ...known, efforts: [...(known.efforts || [])] };
    // `agy models`가 새 모델을 먼저 알려도 지원 여부를 추측해 잘못된
    // --effort를 붙이지 않습니다. 다음 앱 업데이트에서 규칙을 추가하면 됩니다.
    return { id, label: id, efforts: def.id === "agy" ? [] : [...def.efforts] };
  });
  return def.id === "agy" ? collapseEffortVariants(mapped) : mapped;
}

const CLAUDE_EFFORTS = Object.freeze(["default", "low", "medium", "high", "xhigh", "max"]);
// Claude는 모델을 별칭(fable/opus/sonnet)으로 고릅니다. 별칭은 설치된 CLI가 아는
// 그 계열의 최신 모델을 가리키므로 목록에서도 "최신"으로 적어, 같은 계열의 전체
// 이름(claude-fable-5 같은 고정 버전)과 헷갈리지 않게 합니다. 실제로 어떤 모델로
// 풀렸는지는 실행 뒤 응답 헤더(stream-json init의 model)가 보여 줍니다.
const CLAUDE_MODEL_OPTIONS = Object.freeze([
  Object.freeze({ id: "default", label: "Claude 기본값 (CLI 설정 따름)", efforts: CLAUDE_EFFORTS }),
  Object.freeze({ id: "fable", label: "Fable (최신)", efforts: CLAUDE_EFFORTS }),
  Object.freeze({ id: "opus", label: "Opus (최신)", efforts: CLAUDE_EFFORTS }),
  Object.freeze({ id: "sonnet", label: "Sonnet (최신)", efforts: CLAUDE_EFFORTS }),
  Object.freeze({ id: "haiku", label: "Haiku (최신)", efforts: CLAUDE_EFFORTS }),
]);

// `claude --help`의 --model 설명에서 모델 별칭을 뽑습니다. 도움말은
//   "alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's
//    full name (e.g. 'claude-fable-5')"
// 처럼 별칭 목록과 전체 이름 **예시 하나**를 함께 적습니다. 별칭은 열거된 목록이라
// 그대로 쓰고, 전체 이름은 예시일 뿐 목록이 아니며(도움말이 갱신되지 않아 옛 버전을
// 가리키기도 합니다) 별칭과 같은 계열이 두 줄로 보여 헷갈리므로 올리지 않습니다.
function parseClaudeHelpModels(helpText) {
  const modelSection = String(helpText || "")
    .match(/--model[\s\S]{0,500}?(?=\n\s{2}--|\n\s{2}-[a-z])/i)?.[0] || "";
  const aliasSection = modelSection.split(/full\s+name/i)[0];
  const aliases = [...aliasSection.matchAll(/'([A-Za-z0-9][A-Za-z0-9._:/-]{1,63})'/g)]
    .map((match) => match[1])
    .filter((id) => !/^claude-/i.test(id));
  return aliases.length > 0 ? ["default", ...new Set(aliases)] : null;
}

// 모델/노력 옵션은 설치된 CLI --help에서 검증된 플래그에만 연결됩니다.
// (claude 2.1.x: --model fable|opus|sonnet, --effort low..max /
//  codex 0.146: -m/--model, -c model_reasoning_effort=...)
const PROVIDER_DEFS = Object.freeze([
  Object.freeze({
    id: "claude",
    name: "Claude",
    color: "#d97757",
    aliases: Object.freeze(["claude"]),
    command: "claude",
    installHint: "Claude Code CLI가 필요합니다. https://claude.com/claude-code 참고",
    installUrl: "https://claude.com/claude-code",
    authProbeArgs: Object.freeze(["auth", "status"]),
    loginCommand: "claude auth login",
    // 별칭 목록은 발견 시 `claude --help`로 갱신되며, 아래는 그 폴백입니다.
    models: Object.freeze(["default", "fable", "opus", "sonnet"]),
    modelOptions: CLAUDE_MODEL_OPTIONS,
    modelsFromHelp: true,
    efforts: CLAUDE_EFFORTS,
    allowCustomModel: false,
    supportsImages: "workspace-read-required",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "tool-policy" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "tool-policy" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "tool-policy" }),
    }),
  }),
  Object.freeze({
    id: "codex",
    // 이름표는 도구가 아니라 대화 상대(모델 계열)로 적는다. 모델 드롭다운이 이미
    // "GPT-5.6-Sol"이라 "Codex"와 어긋났다. 설치·계정 문구는 실제 도구 이름인
    // Codex CLI를 그대로 쓴다 — 설치하는 것과 대화하는 것은 다르다.
    name: "GPT",
    color: "#10a37f",
    // 첫 별칭이 @ 자동완성 목록에 뜬다(chat.js의 mentionTargets). 새 이름을 앞에
    // 두되 옛 별칭을 남겨 @codex 습관과 저장된 대화 속 호출이 계속 동작하게 한다.
    aliases: Object.freeze(["gpt", "codex"]),
    command: "codex",
    installHint: "Codex CLI가 필요합니다. npm i -g @openai/codex 참고",
    installUrl: "https://developers.openai.com/codex/cli",
    authProbeArgs: Object.freeze(["login", "status"]),
    loginCommand: "codex login",
    // 모델 이름 목록은 CLI에서 열람할 수 없어 기본값 + 직접 입력만 제공합니다.
    models: Object.freeze(["default"]),
    efforts: Object.freeze(["default", "minimal", "low", "medium", "high", "xhigh"]),
    allowCustomModel: false,
    modelCatalogProbe: "codex-app-server",
    supportsImages: "native",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "sandbox" }),
    }),
  }),
  Object.freeze({
    id: "agy",
    name: "Gemini",
    color: "#4285f4",
    aliases: Object.freeze(["gemini", "agy", "antigravity"]),
    command: "agy",
    installHint: "agy CLI가 설치되어 있지 않습니다. https://antigravity.google/docs/cli/install 참고",
    installUrl: "https://antigravity.google/docs/cli/install",
    guiOnlyHint:
      "Antigravity IDE는 설치되어 있지만 agy CLI가 없습니다. https://antigravity.google/docs/cli/install 참고",
    // agy 1.1.10 --help에서 검증된 플래그: -p/--print, --model, --effort low|medium|high,
    // --mode accept-edits|plan, --sandbox, --disable-slash-commands, --add-dir.
    // 모델 목록은 발견 시 `agy models`로 갱신되며, 아래는 그 폴백입니다.
    models: Object.freeze(AGY_MODEL_OPTIONS.map((option) => option.id)),
    modelOptions: AGY_MODEL_OPTIONS,
    efforts: Object.freeze(["default", "low", "medium", "high"]),
    allowCustomModel: false,
    modelsProbeArgs: Object.freeze(["models"]),
    supportsImages: "unsupported",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "sandbox" }),
    }),
  }),
]);

function cliCandidates(providerId, platform, env, home) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (providerId === "claude") {
    if (platform === "win32") return [pathApi.join(home, ".local", "bin", "claude.exe")];
    return [
      pathApi.join(home, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
  }
  if (providerId === "codex") {
    if (platform === "win32") return [];
    return [
      pathApi.join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
  }
  if (providerId === "agy") {
    if (platform === "win32") {
      return [
        pathApi.join(env.LOCALAPPDATA || "", "agy", "bin", "agy.exe"),
        pathApi.join(env.LOCALAPPDATA || "", "Antigravity", "agy.exe"),
      ].filter((candidate) => candidate && !candidate.startsWith(path.sep));
    }
    return [
      pathApi.join(home, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ];
  }
  return [];
}

// GUI 설치 흔적은 "설치됨" 안내에만 쓰고, 절대 CLI처럼 실행하지 않습니다.
function guiEvidencePaths(providerId, platform, env) {
  if (providerId !== "agy") return [];
  if (platform === "darwin") return ["/Applications/Antigravity.app"];
  if (platform === "linux") return ["/opt/Antigravity/antigravity", "/usr/share/antigravity"];
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return [
    pathApi.join(env.LOCALAPPDATA || "", "Programs", "antigravity", "Antigravity.exe"),
    pathApi.join(env.ProgramFiles || "", "Antigravity", "Antigravity.exe"),
  ].filter((candidate) => candidate && !candidate.startsWith(path.sep));
}

function defaultRunCommand(file, args, { timeoutMs = PROBE_TIMEOUT_MS, shell = false } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, shell, encoding: "utf8" },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        }
      );
    } catch (error) {
      // Windows 보안 도구가 프로세스 생성을 동기적으로 거부하더라도
      // 한 프로바이더의 실패가 전체 doctor/설정 창을 깨뜨리지 않게 합니다.
      resolve({ ok: false, stdout: "", stderr: String(error?.message || error) });
    }
  });
}

async function whichCommand(command, { platform, runCommand }) {
  const finder = platform === "win32" ? "where.exe" : "which";
  const result = await runCommand(finder, [command], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok) return null;
  return selectCommandPath(result.stdout, platform) || null;
}

function createCapabilityService(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const fsApi = options.fs || fs;
  const runCommand = options.runCommand || defaultRunCommand;
  const codexModelProbe = options.codexModelProbe ||
    (options.runCommand ? null : probeCodexModelCatalog);
  const agyModelProbe = options.agyModelProbe ||
    (options.runCommand ? null : probeAgyModelCatalog);
  // cache: { get(): object|null, set(object): void } — 저장 위치는 호출자가 결정합니다.
  const cache = options.cache || { get: () => null, set: () => {} };
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  let records = null;
  let discovering = null;
  let refreshing = null;
  const listeners = new Set();

  function statSafe(file) {
    try {
      const stat = fsApi.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  function existsSafe(file) {
    try {
      return fsApi.existsSync(file);
    } catch {
      return false;
    }
  }

  async function resolveCommandPath(def) {
    for (const candidate of cliCandidates(def.id, platform, env, home)) {
      if (candidate && existsSafe(candidate)) return candidate;
    }
    return whichCommand(def.command, { platform, runCommand });
  }

  async function probeVersion(commandPath, needsShell) {
    const result = await runCommand(commandPath, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (!result.ok) return null;
    const line = String(result.stdout || "").split(/\r?\n/).find((entry) => entry.trim());
    return line ? line.trim().slice(0, 120) : "unknown";
  }

  async function probeAuth(def, commandPath, needsShell) {
    if (!def.authProbeArgs) {
      return {
        authStatus: "unknown",
        authReason: "이 CLI는 비대화형 로그인 상태 확인을 지원하지 않습니다.",
      };
    }
    const result = await runCommand(commandPath, [...def.authProbeArgs], {
      timeoutMs: PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (!result.ok) {
      return {
        authStatus: "unauthenticated",
        authReason: `${def.name} 로그인이 필요합니다.`,
      };
    }
    if (def.id === "claude") {
      try {
        const parsed = JSON.parse(String(result.stdout || ""));
        if (parsed.loggedIn === false) {
          return {
            authStatus: "unauthenticated",
            authReason: `${def.name} 로그인이 필요합니다.`,
          };
        }
      } catch {}
    }
    return { authStatus: "authenticated", authReason: "" };
  }

  // 모델 목록을 CLI 스스로 보고할 수 있는 경우(`agy models`) 프로브로 갱신합니다.
  async function probeModels(def, commandPath, needsShell) {
    if (def.modelsFromHelp) {
      const result = await runCommand(commandPath, ["--help"], {
        timeoutMs: MODEL_PROBE_TIMEOUT_MS,
        shell: needsShell,
      });
      if (!result.ok) return null;
      return parseClaudeHelpModels(result.stdout);
    }
    if (!def.modelsProbeArgs) return null;
    const result = await runCommand(commandPath, [...def.modelsProbeArgs], {
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (!result.ok) return null;
    // agy models처럼 "이름   설명" 두 열로 나오는 CLI도 있어, 줄 전체가 아니라
    // 앞쪽 첫 토큰만 모델 이름으로 취급합니다.
    const models = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
      .filter((token) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(token));
    return models.length > 0 ? ["default", ...models] : null;
  }

  async function discoverOne(def, persistedCache, { force = false } = {}) {
    const record = {
      id: def.id,
      name: def.name,
      color: def.color,
      aliases: [...def.aliases],
      status: "absent",
      reason: def.installHint,
      commandPath: null,
      needsShell: false,
      version: null,
      // AGY는 노력 변형을 접어 보여주므로 models 목록도 접힌 id와 맞춥니다.
      models: def.id === "agy"
        ? modelOptionsFor(def, def.models).map((option) => option.id)
        : [...def.models],
      modelOptions: modelOptionsFor(def, def.models),
      efforts: [...def.efforts],
      allowCustomModel: def.allowCustomModel,
      supportsImages: def.supportsImages,
      permissions: def.permissions,
      guiInstalled: false,
      authStatus: "unavailable",
      authReason: "CLI를 먼저 설치해야 합니다.",
      installUrl: def.installUrl,
      loginCommand: def.loginCommand || null,
    };

    record.guiInstalled = guiEvidencePaths(def.id, platform, env).some((entry) => existsSafe(entry));

    const commandPath = await resolveCommandPath(def);
    if (!commandPath) {
      if (record.guiInstalled && def.guiOnlyHint) {
        record.status = "gui-only";
        record.reason = def.guiOnlyHint;
      }
      return record;
    }

    record.commandPath = commandPath;
    record.needsShell = commandNeedsShell(commandPath, platform);

    const stat = statSafe(commandPath);
    const cacheKey = `${def.id}:${commandPath}`;
    const cached = persistedCache?.[cacheKey];

    // 버전은 캐시하지 않고 매번 확인합니다. 예전에는 실행 파일의 크기·수정시각이
    // 같으면 버전 확인까지 건너뛰었는데, Windows의 npm .cmd 셸(codex.cmd)이나
    // 런처 실행 파일은 CLI가 업데이트돼도 그대로라 새 버전을 영영 알아채지
    // 못했고, 그 결과 모델 목록도 갱신되지 않았습니다. --version 한 번은 로그인
    // 확인과 비슷한 비용이라 시작마다 감당할 만합니다.
    const version = await probeVersion(commandPath, record.needsShell);
    if (!version) {
      record.status = "error";
      record.reason = `${def.name} CLI를 찾았지만 실행 확인(--version)에 실패했습니다.`;
      return record;
    }
    record.version = version;
    record.status = "cli";
    record.reason = "";
    Object.assign(record, await probeAuth(def, commandPath, record.needsShell));

    const cachedCatalog = catalogFromCache(def, cached);
    if (!force && cachedCatalog && catalogIsFresh(cached, stat, version)) {
      applyCatalog(record, cachedCatalog);
      return record;
    }
    if (!force && cachedCatalog) {
      // CLI 버전이 바뀌었거나 카탈로그가 오래됐습니다. 시작을 막지 않도록 지금은
      // 마지막 목록으로 응답하고, refreshStaleCatalogs()가 뒤에서 다시 조회해
      // 갱신합니다(호출자는 갱신 알림을 구독해 화면을 새로 그립니다).
      applyCatalog(record, cachedCatalog);
      record.modelCatalogStale = true;
      return record;
    }
    // 캐시가 없는 첫 실행이거나 강제 새로고침이면 지금 조회합니다. 강제 새로고침이
    // 실패해도 마지막 목록이 있으면 그것을 유지합니다.
    await refreshCatalog(def, record, { stat, cacheKey, fallbackCatalog: cachedCatalog });
    return record;
  }

  // 저장된 카탈로그가 쓸 만한 모양이면 돌려줍니다(모델 옵션이 비어 있으면 없는 것).
  function catalogFromCache(def, cached) {
    if (!cached || !Array.isArray(cached.modelOptions) || cached.modelOptions.length === 0) return null;
    if (def.id === "agy" && cached.modelOptionsVersion !== AGY_MODEL_OPTIONS_VERSION) return null;
    const models = Array.isArray(cached.models) && cached.models.length > 0
      ? cached.models
      : cached.modelOptions.map((option) => option.id);
    return { models, modelOptions: cached.modelOptions };
  }

  // 같은 CLI(버전·실행 파일)에서 TTL 안에 조회한 카탈로그만 그대로 신뢰합니다.
  function catalogIsFresh(cached, stat, version) {
    if (!cached || !stat || cached.version !== version) return false;
    if (cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return false;
    if (!Number.isFinite(cached.probedAt)) return false;
    return Math.abs(now() - cached.probedAt) < MODEL_CATALOG_TTL_MS;
  }

  function applyCatalog(record, catalog) {
    record.models = [...catalog.models];
    record.modelOptions = catalog.modelOptions.map((option) => ({ ...option }));
  }

  // CLI에 실제 모델 목록을 물어봅니다. 실패하면 null(호출자가 이전 목록을 유지).
  async function probeCatalog(def, commandPath, needsShell) {
    if (def.modelCatalogProbe === "codex-app-server") {
      if (!codexModelProbe) return null;
      const catalog = await codexModelProbe(commandPath, needsShell);
      if (!catalog?.length) return null;
      const defaultCatalogModel = catalog.find((option) => option.isDefault);
      const modelOptions = [
        {
          id: "default",
          label: "기본값 (Codex 설정 따름)",
          efforts: defaultCatalogModel?.efforts?.length
            ? [...defaultCatalogModel.efforts]
            : [...def.efforts],
        },
        ...catalog,
      ];
      return { models: modelOptions.map((option) => option.id), modelOptions };
    }
    const probedModels = def.id === "agy" && agyModelProbe
      ? await agyModelProbe(commandPath, needsShell)
      : await probeModels(def, commandPath, needsShell);
    if (!probedModels) return null;
    const modelOptions = modelOptionsFor(def, probedModels);
    return {
      // AGY는 노력 변형을 접어 보여주므로 models 목록도 접힌 id와 맞춥니다.
      models: def.id === "agy" ? modelOptions.map((option) => option.id) : probedModels,
      modelOptions,
    };
  }

  // 카탈로그를 다시 조회해 record와 캐시 patch에 반영합니다. 조회에 실패하면
  // 이전 목록(fallbackCatalog)을 유지하고 캐시도 건드리지 않아, 일시적 실패가
  // "기본값만 있는 목록"으로 굳어 다음 시작 때까지 남는 일이 없게 합니다.
  async function refreshCatalog(def, record, { stat, cacheKey, fallbackCatalog }) {
    const probed = await probeCatalog(def, record.commandPath, record.needsShell);
    if (!probed) {
      if (fallbackCatalog) applyCatalog(record, fallbackCatalog);
      return false;
    }
    applyCatalog(record, probed);
    delete record.modelCatalogStale;
    if (stat) {
      record.cachePatch = {
        [cacheKey]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          version: record.version,
          models: probed.models,
          modelOptions: probed.modelOptions,
          probedAt: now(),
          ...(def.id === "agy" ? { modelOptionsVersion: AGY_MODEL_OPTIONS_VERSION } : {}),
        },
      };
    }
    return true;
  }

  function persistPatches(results) {
    const patches = {};
    for (const record of results) {
      if (record.cachePatch) {
        Object.assign(patches, record.cachePatch);
        delete record.cachePatch;
      }
    }
    if (Object.keys(patches).length > 0) {
      try {
        cache.set({ ...(cache.get() || {}), ...patches });
      } catch {}
    }
  }

  // force: 캐시의 유효성을 무시하고 전부 지금 조회(사용자의 "CLI 다시 탐지"). 조회에
  //        실패한 항목은 캐시된 마지막 목록으로 돌아갑니다.
  // recheck: 이미 탐지한 뒤라도 버전·로그인을 다시 확인(주기적 재확인). 캐시는 그대로
  //          존중하므로 바뀐 것이 없으면 카탈로그 조회는 생기지 않습니다.
  async function discover({ force = false, recheck = false } = {}) {
    if (records && !force && !recheck) return records;
    if (discovering && !force) return discovering;
    discovering = (async () => {
      let persistedCache = null;
      try {
        persistedCache = cache.get() || null;
      } catch {}
      // Windows에서는 여러 CLI를 동시에 프로브하면 .cmd 실행이 간헐적으로
      // EPERM을 내는 환경이 있어 순차 탐지합니다. 시작 시 한 번뿐이라 체감
      // 지연보다 안정성이 중요합니다.
      const results = [];
      for (const def of PROVIDER_DEFS) {
        results.push(await discoverOne(def, persistedCache, { force }));
      }
      persistPatches(results);
      records = results;
      return records;
    })();
    try {
      return await discovering;
    } finally {
      discovering = null;
    }
  }

  function hasStaleCatalogs() {
    return (records || []).some((record) => record.modelCatalogStale);
  }

  // discover()가 캐시로 응답해 둔 오래된 카탈로그를 뒤에서 다시 조회합니다.
  // 목록이 실제로 바뀐 경우에만 구독자에게 알립니다. 동시에 여러 번 불려도
  // 조회는 한 번만 돕니다.
  async function refreshStaleCatalogs() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (discovering) await discovering;
      const current = records || [];
      const stale = current.filter((record) => record.modelCatalogStale && record.commandPath);
      let changed = false;
      for (const record of stale) {
        const def = PROVIDER_DEFS.find((entry) => entry.id === record.id);
        if (!def) continue;
        const before = catalogSignature(record);
        const refreshed = await refreshCatalog(def, record, {
          stat: statSafe(record.commandPath),
          cacheKey: `${def.id}:${record.commandPath}`,
          fallbackCatalog: { models: record.models, modelOptions: record.modelOptions },
        });
        // 조회 중에 다시 탐지돼 record가 교체됐으면 이 결과는 버립니다.
        if (records !== current) {
          delete record.cachePatch;
          continue;
        }
        if (refreshed && catalogSignature(record) !== before) changed = true;
      }
      if (records === current) persistPatches(stale);
      if (changed) {
        for (const listener of listeners) {
          try {
            listener(records);
          } catch {}
        }
      }
      return { changed, records };
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  function catalogSignature(record) {
    return JSON.stringify((record.modelOptions || []).map((option) => [
      option.id,
      option.label || "",
      option.isDefault ? 1 : 0,
      option.efforts || [],
      option.effortModels || null,
    ]));
  }

  // 백그라운드 카탈로그 갱신으로 모델 목록이 바뀌면 호출됩니다. 해제 함수를 돌려줍니다.
  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getRecord(id) {
    return (records || []).find((record) => record.id === id) || null;
  }

  return { discover, refreshStaleCatalogs, hasStaleCatalogs, subscribe, getRecord, defs: PROVIDER_DEFS };
}

// renderer로 보내는 안전한 뷰: 실행 경로/셸/환경 정보는 제외합니다.
function toPublicProvider(record) {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    aliases: record.aliases,
    status: record.status,
    available: record.status === "cli",
    reason: record.reason || "",
    version: record.version,
    models: record.models,
    modelOptions: record.modelOptions,
    efforts: record.efforts,
    allowCustomModel: record.allowCustomModel,
    supportsImages: record.supportsImages,
    permissions: record.permissions,
    guiInstalled: Boolean(record.guiInstalled),
    authStatus: record.authStatus || "unknown",
    authReason: record.authReason || "",
    installUrl: record.installUrl || null,
    loginCommand: record.loginCommand || null,
  };
}

function toPublicProviders(records) {
  return (records || []).map(toPublicProvider);
}

module.exports = {
  PROVIDER_DEFS,
  PROBE_TIMEOUT_MS,
  MODEL_PROBE_TIMEOUT_MS,
  MODEL_CATALOG_TTL_MS,
  collapseEffortVariants,
  resolveEffortVariant,
  parseClaudeHelpModels,
  probeCodexModelCatalog,
  probeAgyModelCatalog,
  cliCandidates,
  guiEvidencePaths,
  createCapabilityService,
  toPublicProvider,
  toPublicProviders,
};
