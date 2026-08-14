const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const winPath = path.win32;

const {
  cliCandidates,
  collapseEffortVariants,
  guiEvidencePaths,
  createCapabilityService,
  resolveEffortVariant,
  toPublicProviders,
} = require("../src/providers/provider-capabilities");

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
};

function makeService({
  files = new Set(),
  whereResults = {},
  probes = {},
  cacheStore = {},
  codexModelProbe = null,
} = {}) {
  const calls = { runs: [] };
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: (file) => {
        if (!files.has(file)) throw new Error("ENOENT");
        return { mtimeMs: 111, size: 222 };
      },
    },
    runCommand: async (file, args) => {
      calls.runs.push({ file, args });
      if (file === "where.exe") {
        const out = whereResults[args[0]];
        return out ? { ok: true, stdout: out, stderr: "" } : { ok: false, stdout: "", stderr: "" };
      }
      const probe = probes[file];
      if (probe) return { ok: true, stdout: probe, stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: {
      get: () => cacheStore.value || null,
      set: (value) => {
        cacheStore.value = value;
      },
    },
    ...(codexModelProbe ? { codexModelProbe } : {}),
  });
  return { service, calls };
}

test("agy 후보에 공식 Windows 설치 경로가 포함된다", () => {
  const candidates = cliCandidates("agy", "win32", WIN_ENV, "C:\\Users\\u");
  assert.ok(candidates.includes(winPath.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe")));
});

test("GUI 흔적 경로는 Antigravity.exe를 가리키지만 실행 후보에는 없다", () => {
  const gui = guiEvidencePaths("agy", "win32", WIN_ENV);
  assert.ok(gui.some((entry) => entry.endsWith("Antigravity.exe")));
  const candidates = cliCandidates("agy", "win32", WIN_ENV, "C:\\Users\\u");
  assert.ok(!candidates.some((entry) => entry.endsWith("Antigravity.exe")));
});

test("CLI 없음 + GUI 설치 → gui-only 상태와 설치 안내", async () => {
  const files = new Set([
    winPath.join(WIN_ENV.LOCALAPPDATA, "Programs", "antigravity", "Antigravity.exe"),
  ]);
  const { service } = makeService({ files });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.status, "gui-only");
  assert.equal(agy.guiInstalled, true);
  assert.ok(agy.reason.includes("IDE는 설치되어 있지만"));
});

test("CLI가 어디에도 없으면 absent + 설치 힌트", async () => {
  const { service } = makeService({});
  const records = await service.discover();
  for (const record of records) {
    assert.equal(record.status, "absent");
    assert.ok(record.reason.length > 0);
  }
});

test("where 결과에서 .exe를 고르고 --version 프로브로 cli 상태가 된다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({
    files,
    probes: { [claudePath]: "2.1.198 (Claude Code)\n" },
  });
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(claude.version, "2.1.198 (Claude Code)");
  assert.equal(claude.reason, "");
});

test("프로브 실패 시 error 상태와 이유를 보고한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({ files, probes: {} });
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "error");
  assert.ok(claude.reason.includes("--version"));
});

test("버전 프로브 결과는 경로/크기/수정시각 키로 캐시된다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {};
  const first = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, cacheStore });
  await first.service.discover();
  const probeRuns = first.calls.runs.filter(
    (run) => run.file === claudePath && run.args[0] === "--version"
  ).length;
  assert.equal(probeRuns, 1);
  assert.ok(cacheStore.value[`claude:${claudePath}`]);

  // 새 서비스(앱 재시작 시뮬레이션)는 캐시를 재사용해 프로브를 생략한다.
  const second = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, cacheStore });
  const records = await second.service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(
    second.calls.runs.filter((run) => run.file === claudePath && run.args[0] === "--version").length,
    0
  );
  assert.equal(
    second.calls.runs.filter((run) => run.file === claudePath && run.args[0] === "auth").length,
    1
  );
});

test("Claude 로그인 상태는 공개 진단 값으로만 노출되고 계정 정보는 버린다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 1, size: 2 }),
    },
    runCommand: async (file, args) => {
      if (file === claudePath && args[0] === "--version") {
        return { ok: true, stdout: "2.1.198\n", stderr: "" };
      }
      if (file === claudePath && args[0] === "auth") {
        return {
          ok: true,
          stdout: JSON.stringify({ loggedIn: true, email: "private@example.com", token: "secret" }),
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => null, set: () => {} },
  });
  const publicClaude = toPublicProviders(await service.discover()).find(
    (record) => record.id === "claude"
  );
  assert.equal(publicClaude.authStatus, "authenticated");
  assert.ok(!JSON.stringify(publicClaude).includes("private@example.com"));
  assert.ok(!JSON.stringify(publicClaude).includes("secret"));
});

test("로그인 상태 명령 실패는 CLI 설치 오류와 구분한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const authFailureService = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 1, size: 2 }),
    },
    runCommand: async (file, args) => ({
      ok: file === claudePath && args[0] === "--version",
      stdout: args[0] === "--version" ? "2.1.198\n" : "",
      stderr: "",
    }),
    cache: { get: () => null, set: () => {} },
  });
  const claude = (await authFailureService.discover()).find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(claude.authStatus, "unauthenticated");
});

test("공개 뷰에는 commandPath/needsShell이 절대 포함되지 않는다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({ files, probes: { [claudePath]: "2.1.198\n" } });
  const records = await service.discover();
  const publicView = toPublicProviders(records);
  const json = JSON.stringify(publicView);
  assert.ok(!json.includes("commandPath"));
  assert.ok(!json.includes("needsShell"));
  assert.ok(!json.includes(claudePath.replace(/\\/g, "\\\\")));
  const claude = publicView.find((record) => record.id === "claude");
  assert.equal(claude.available, true);
  assert.ok(Array.isArray(claude.models));
  assert.ok(claude.permissions.chat.enforcement);
});

test("claude 검증된 모델/노력 옵션이 노출된다", async () => {
  const { service } = makeService({});
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.deepEqual(claude.models, ["default", "fable", "opus", "sonnet"]);
  assert.ok(claude.efforts.includes("max"));
  const codex = records.find((record) => record.id === "codex");
  assert.deepEqual(codex.models, ["default"]);
  assert.equal(codex.allowCustomModel, false);
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.permissions["workspace-write"].supported, true);
  assert.equal(agy.permissions.chat.enforcement, "sandbox");
  assert.ok(agy.efforts.includes("high"));
  // 같은 모델의 노력 변형(high/medium/low)은 한 줄로 접히고 단계는 노력 선택이 맡습니다.
  const geminiFlash = agy.modelOptions.find((option) => option.id === "gemini-3.6-flash");
  assert.deepEqual(geminiFlash.efforts, ["low", "medium", "high"]);
  assert.equal(geminiFlash.label, "Gemini 3.6 Flash");
  assert.equal(geminiFlash.effortModels.high, "gemini-3.6-flash-high");
  assert.equal(agy.modelOptions.some((option) => option.id === "gemini-3.6-flash-high"), false);
  assert.deepEqual(
    agy.modelOptions.find((option) => option.id === "claude-sonnet-4-6").efforts,
    []
  );
});

test("agy models가 \"이름 + 설명\" 두 열로 출력되어도 모델 이름만 뽑아낸다", async () => {
  // 실제 agy CLI는 `gemini-3.7-flash-high     Gemini 3.7 Flash (High)`처럼
  // 이름 뒤에 공백으로 구분된 설명을 붙여 출력합니다. 줄 전체를 모델 이름으로
  // 취급하면 이런 줄이 통째로 걸러져 새 모델이 목록에서 빠지게 됩니다.
  const agyPath = winPath.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const cacheStore = {};
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 5, size: 6 }),
    },
    runCommand: async (file, args) => {
      if (file === agyPath && args[0] === "--version") {
        return { ok: true, stdout: "agy 1.1.10\n", stderr: "" };
      }
      if (file === agyPath && args[0] === "models") {
        return {
          ok: true,
          stdout: [
            "gemini-3.7-flash-high     Gemini 3.7 Flash (High)",
            "gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)",
            "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: {
      get: () => cacheStore.value || null,
      set: (value) => {
        cacheStore.value = value;
      },
    },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  // 두 열 출력에서 모델 이름만 뽑은 뒤 노력 변형끼리 접힙니다.
  assert.deepEqual(agy.models, ["default", "gemini-3.7-flash", "claude-sonnet-4-6"]);
  assert.deepEqual(
    agy.modelOptions.find((option) => option.id === "gemini-3.7-flash").effortModels,
    { high: "gemini-3.7-flash-high", medium: "gemini-3.7-flash-medium" }
  );
});

test("Codex app-server 카탈로그를 공개 모델과 모델별 노력 목록으로 변환한다", async () => {
  const codexPath = "C:\\tools\\codex.cmd";
  const { service } = makeService({
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => [
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low", "max"] },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", isDefault: false, efforts: ["medium"] },
    ],
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.deepEqual(codex.models, ["default", "gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(codex.modelOptions[0].efforts, ["low", "max"]);
  assert.equal(codex.modelOptions[1].label, "GPT-5.6-Sol");
});

test("agy CLI가 공식 후보 경로에 있으면 PATH 없이도 cli 상태가 된다", async () => {
  const agyPath = winPath.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const { service, calls } = makeService({
    files,
    probes: { [agyPath]: "agy 1.1.10\n" },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.status, "cli");
  assert.equal(agy.version, "agy 1.1.10");
  // where.exe 조회 없이 후보 경로만으로 해석되어야 한다.
  assert.ok(!calls.runs.some((run) => run.file === "where.exe" && run.args[0] === "agy"));
});

test("agy 모델 목록은 `agy models` 프로브로 갱신된다", async () => {
  const agyPath = winPath.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const cacheStore = {};
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 5, size: 6 }),
    },
    runCommand: async (file, args) => {
      if (file === agyPath && args[0] === "--version") {
        return { ok: true, stdout: "agy 1.1.10\n", stderr: "" };
      }
      if (file === agyPath && args[0] === "models") {
        return {
          ok: true,
          stdout: "gemini-3.6-flash-high\ngemini-3.1-pro-low\nclaude-sonnet-4-6\n",
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: {
      get: () => cacheStore.value || null,
      set: (value) => {
        cacheStore.value = value;
      },
    },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  // 목록에는 접힌 모델만 남습니다.
  assert.deepEqual(agy.models, [
    "default",
    "gemini-3.6-flash",
    "gemini-3.1-pro",
    "claude-sonnet-4-6",
  ]);
  // 캐시에도 모델 목록이 함께 저장된다.
  const cached = cacheStore.value[`agy:${agyPath}`];
  assert.ok(Array.isArray(cached.models));
  assert.equal(cached.modelOptionsVersion, 4);
  // CLI에 넘길 변형 id는 effortModels에 보존됩니다.
  assert.deepEqual(
    agy.modelOptions.find((option) => option.id === "gemini-3.6-flash").effortModels,
    { high: "gemini-3.6-flash-high" }
  );
  assert.deepEqual(
    agy.modelOptions.find((option) => option.id === "claude-sonnet-4-6").efforts,
    []
  );
});

test("AGY 노력 변형은 한 줄로 접히고 고정 변형 모델은 그대로 남는다", () => {
  const collapsed = collapseEffortVariants([
    { id: "default", label: "AGY 기본값", efforts: [] },
    { id: "gemini-9-flash-high", label: "Gemini 9 Flash (높음)", efforts: ["high"] },
    { id: "gemini-9-flash-low", label: "Gemini 9 Flash (낮음)", efforts: ["low"] },
    { id: "gemini-9-flash-medium", label: "Gemini 9 Flash (중간)", efforts: ["medium"] },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: [] },
    // 아직 규칙을 모르는 새 모델은 추측하지 않고 그대로 둡니다.
    { id: "gemini-99-pro-high", label: "gemini-99-pro-high", efforts: [] },
  ]);

  assert.deepEqual(collapsed.map((option) => option.id), [
    "default",
    "gemini-9-flash",
    "claude-opus-4-6-thinking",
    "gemini-99-pro-high",
  ]);
  const flash = collapsed[1];
  assert.equal(flash.label, "Gemini 9 Flash");
  // 노력은 낮음 → 중간 → 높음 순으로 정렬됩니다.
  assert.deepEqual(flash.efforts, ["low", "medium", "high"]);
  assert.deepEqual(flash.effortModels, {
    low: "gemini-9-flash-low",
    medium: "gemini-9-flash-medium",
    high: "gemini-9-flash-high",
  });
});

test("예전 세션이 저장한 변형 id는 모델과 노력 쌍으로 옮겨진다", () => {
  const modelOptions = collapseEffortVariants([
    { id: "gemini-9-flash-high", label: "Gemini 9 Flash (높음)", efforts: ["high"] },
    { id: "gemini-9-flash-low", label: "Gemini 9 Flash (낮음)", efforts: ["low"] },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", efforts: [] },
  ]);

  assert.deepEqual(resolveEffortVariant(modelOptions, "gemini-9-flash-low"), {
    model: "gemini-9-flash",
    effort: "low",
  });
  // 이미 목록에 있는 id는 옮길 것이 없습니다.
  assert.equal(resolveEffortVariant(modelOptions, "gemini-9-flash"), null);
  assert.equal(resolveEffortVariant(modelOptions, "claude-opus-4-6-thinking"), null);
  assert.equal(resolveEffortVariant(modelOptions, ""), null);
});
