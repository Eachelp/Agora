const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const winPath = path.win32;

const {
  MODEL_CATALOG_TTL_MS,
  cliCandidates,
  collapseEffortVariants,
  guiEvidencePaths,
  createCapabilityService,
  parseClaudeHelpModels,
  resolveEffortVariant,
  toPublicProviders,
} = require("../src/providers/provider-capabilities");

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
};

// 실제 claude 2.1.x `--help`의 --model 항목. 별칭 목록과 전체 이름 예시 하나를 함께 적는다.
const CLAUDE_HELP = [
  "Options:",
  "  --model <model>                       Model for the current session. Provide",
  "                                        an alias for the latest model (e.g.",
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name (e.g.",
  "                                        'claude-fable-5').",
  "  --effort <effort>                     Reasoning effort",
  "",
].join("\n");

function makeService({
  files = new Set(),
  whereResults = {},
  probes = {},
  helpText = {},
  cacheStore = {},
  codexModelProbe = null,
  now = null,
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
      if (args[0] === "--help") {
        const help = typeof helpText === "function" ? helpText(file) : helpText[file];
        return help ? { ok: true, stdout: help, stderr: "" } : { ok: false, stdout: "", stderr: "" };
      }
      const probe = typeof probes === "function" ? probes(file, args) : probes[file];
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
    ...(now ? { now } : {}),
  });
  return { service, calls };
}

function countRuns(calls, file, arg) {
  return calls.runs.filter((run) => run.file === file && run.args[0] === arg).length;
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

test("모델 카탈로그는 같은 CLI 버전이면 캐시를 쓰고, 버전은 시작마다 다시 확인한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {};
  let clock = 1_000_000;
  const now = () => clock;
  const helpText = { [claudePath]: CLAUDE_HELP };
  const first = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, helpText, cacheStore, now });
  const firstRecords = await first.service.discover();
  assert.equal(countRuns(first.calls, claudePath, "--version"), 1);
  assert.equal(countRuns(first.calls, claudePath, "--help"), 1);
  const cached = cacheStore.value[`claude:${claudePath}`];
  assert.equal(cached.version, "2.1.198");
  assert.equal(cached.probedAt, clock);
  assert.deepEqual(firstRecords.find((record) => record.id === "claude").models, ["default", "fable", "opus", "sonnet"]);

  // 앱 재시작: 버전은 다시 확인하지만(--version 1회) 카탈로그(--help)는 캐시를 쓴다.
  clock += 60 * 1000;
  const second = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, helpText, cacheStore, now });
  const records = await second.service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(claude.version, "2.1.198");
  assert.equal(countRuns(second.calls, claudePath, "--version"), 1);
  assert.equal(countRuns(second.calls, claudePath, "--help"), 0);
  assert.equal(countRuns(second.calls, claudePath, "auth"), 1);
  assert.equal(second.service.hasStaleCatalogs(), false);
  assert.equal(claude.modelCatalogStale, undefined);
});

test("실행 파일 크기·수정시각이 같아도 CLI 버전이 바뀌면 모델 목록을 뒤에서 다시 조회한다", async () => {
  // Windows의 npm .cmd 셸이나 런처는 CLI가 업데이트돼도 파일이 그대로다. 버전으로
  // 판단하지 않으면 새 모델(예: gpt-6)이 영영 목록에 오르지 않는다.
  const codexPath = "C:\\tools\\codex.cmd";
  const cacheStore = {};
  let clock = 5_000_000;
  const now = () => clock;
  const oldCatalog = [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low", "high"] }];
  const newCatalog = [
    { id: "gpt-6", label: "GPT-6", isDefault: true, efforts: ["low", "high", "xhigh"] },
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: false, efforts: ["low", "high"] },
  ];
  const files = new Set([codexPath]);
  const first = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => oldCatalog,
    cacheStore,
    now,
  });
  await first.service.discover();
  assert.deepEqual(
    (await first.service.discover()).find((record) => record.id === "codex").models,
    ["default", "gpt-5.6-sol"]
  );
  assert.equal(cacheStore.value[`codex:${codexPath}`].version, "codex-cli 0.146.0");

  // CLI 업데이트: where 결과·stat(.cmd 셸은 그대로)은 같고 --version만 바뀐다.
  let catalogProbes = 0;
  const second = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.150.0\n" },
    codexModelProbe: async () => {
      catalogProbes += 1;
      return newCatalog;
    },
    cacheStore,
    now,
  });
  const records = await second.service.discover();
  const codex = records.find((record) => record.id === "codex");
  // 시작은 막지 않는다: 마지막 목록으로 먼저 응답하고 stale로 표시한다.
  assert.equal(codex.version, "codex-cli 0.150.0");
  assert.deepEqual(codex.models, ["default", "gpt-5.6-sol"]);
  assert.equal(codex.modelCatalogStale, true);
  assert.equal(second.service.hasStaleCatalogs(), true);
  assert.equal(catalogProbes, 0);

  const result = await second.service.refreshStaleCatalogs();
  assert.equal(catalogProbes, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(second.service.getRecord("codex").models, ["default", "gpt-6", "gpt-5.6-sol"]);
  assert.equal(second.service.getRecord("codex").modelCatalogStale, undefined);
  assert.equal(second.service.hasStaleCatalogs(), false);
  // 캐시도 새 버전·새 목록으로 바뀐다.
  const cached = cacheStore.value[`codex:${codexPath}`];
  assert.equal(cached.version, "codex-cli 0.150.0");
  assert.deepEqual(cached.models, ["default", "gpt-6", "gpt-5.6-sol"]);
  assert.equal(cached.probedAt, clock);

  // 목록이 그대로면 구독자에게 알리지 않는다.
  const again = await second.service.refreshStaleCatalogs();
  assert.equal(again.changed, false);
  assert.equal(catalogProbes, 1);
});

test("카탈로그 캐시는 TTL이 지나면 오래된 것으로 보고 뒤에서 다시 조회한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {};
  let clock = 10_000_000;
  const now = () => clock;
  const helpText = { [claudePath]: CLAUDE_HELP };
  const first = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, helpText, cacheStore, now });
  await first.service.discover();

  clock += MODEL_CATALOG_TTL_MS + 1;
  const second = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, helpText, cacheStore, now });
  const claude = (await second.service.discover()).find((record) => record.id === "claude");
  assert.equal(claude.modelCatalogStale, true);
  assert.equal(countRuns(second.calls, claudePath, "--help"), 0);
  await second.service.refreshStaleCatalogs();
  assert.equal(countRuns(second.calls, claudePath, "--help"), 1);
  assert.equal(cacheStore.value[`claude:${claudePath}`].probedAt, clock);
});

test("카탈로그 재조회에 실패하면 이전 목록을 유지하고 캐시를 덮어쓰지 않는다", async () => {
  const codexPath = "C:\\tools\\codex.cmd";
  const files = new Set([codexPath]);
  const cacheStore = {};
  let clock = 20_000_000;
  const now = () => clock;
  const first = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low"] }],
    cacheStore,
    now,
  });
  await first.service.discover();
  const cachedBefore = JSON.stringify(cacheStore.value[`codex:${codexPath}`]);

  clock += MODEL_CATALOG_TTL_MS + 1;
  const second = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => null,
    cacheStore,
    now,
  });
  await second.service.discover();
  const result = await second.service.refreshStaleCatalogs();
  assert.equal(result.changed, false);
  const codex = second.service.getRecord("codex");
  assert.deepEqual(codex.models, ["default", "gpt-5.6-sol"]);
  // 다음 기회에 다시 시도할 수 있게 stale 표시와 캐시는 그대로 둔다.
  assert.equal(codex.modelCatalogStale, true);
  assert.equal(JSON.stringify(cacheStore.value[`codex:${codexPath}`]), cachedBefore);

  // 강제 새로고침(CLI 다시 탐지)도 실패한 조회로 목록을 "기본값만"으로 깎지 않는다.
  const forced = (await second.service.discover({ force: true })).find((record) => record.id === "codex");
  assert.deepEqual(forced.models, ["default", "gpt-5.6-sol"]);
});

test("recheck는 이미 탐지한 뒤에도 버전·로그인을 다시 확인하고 캐시는 존중한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {};
  let clock = 30_000_000;
  const now = () => clock;
  let version = "2.1.198\n";
  const { service, calls } = makeService({
    files,
    probes: (file) => (file === claudePath ? version : null),
    helpText: { [claudePath]: CLAUDE_HELP },
    cacheStore,
    now,
  });
  await service.discover();
  assert.equal(countRuns(calls, claudePath, "--version"), 1);
  // 같은 버전: 재확인은 --version만 더 돌고 카탈로그는 그대로다.
  await service.discover({ recheck: true });
  assert.equal(countRuns(calls, claudePath, "--version"), 2);
  assert.equal(countRuns(calls, claudePath, "--help"), 1);
  assert.equal(service.hasStaleCatalogs(), false);
  // 앱을 켜 둔 채 CLI가 업데이트됨: 재확인이 새 버전을 잡고 카탈로그를 stale로 만든다.
  version = "2.2.0\n";
  const records = await service.discover({ recheck: true });
  assert.equal(records.find((record) => record.id === "claude").version, "2.2.0");
  assert.equal(service.hasStaleCatalogs(), true);
  await service.refreshStaleCatalogs();
  assert.equal(countRuns(calls, claudePath, "--help"), 2);
  assert.equal(cacheStore.value[`claude:${claudePath}`].version, "2.2.0");
});

test("수동 재탐지는 진행 중인 탐지 뒤에 실행되어 이전 목록에 덮이지 않는다", async () => {
  const codexPath = "C:\\tools\\codex.cmd";
  const cacheStore = {};
  let releaseFirst;
  let firstEntered;
  let probes = 0;
  const slowCatalog = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const { service } = makeService({
    files: new Set([codexPath]),
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.150.0\n" },
    cacheStore,
    codexModelProbe: async () => {
      probes += 1;
      if (probes === 1) {
        firstEntered();
        return slowCatalog;
      }
      return [{ id: "new-model", efforts: ["high"] }];
    },
  });
  const initial = service.discover();
  await entered;
  const forced = service.discover({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  const probesBeforeRelease = probes;
  releaseFirst([{ id: "old-model", efforts: ["low"] }]);
  await Promise.all([initial, forced]);
  assert.equal(probesBeforeRelease, 1, "수동 조회와 이전 조회를 동시에 실행하지 않는다");
  assert.equal(probes, 2);
  assert.deepEqual(service.getRecord("codex").models, ["default", "new-model"]);
  assert.deepEqual(cacheStore.value[`codex:${codexPath}`].models, ["default", "new-model"]);
});

for (const discoveryOptions of [{ force: true }, { recheck: true }]) {
  test(`${discoveryOptions.force ? "실패한 수동 재탐지는" : "자동 재확인은"} 배경 갱신의 최신 목록을 유지한다`, async () => {
    const codexPath = "C:\\tools\\codex.cmd";
    const cacheStore = {};
    let clock = 40_000_000;
    let releaseRefresh;
    let refreshEntered;
    let catalogProbes = 0;
    const slowRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
    const entered = new Promise((resolve) => { refreshEntered = resolve; });
    const { service, calls } = makeService({
      files: new Set([codexPath]),
      whereResults: { codex: `${codexPath}\r\n` },
      probes: { [codexPath]: "codex-cli 0.150.0\n" },
      cacheStore,
      now: () => clock,
      codexModelProbe: async () => {
        catalogProbes += 1;
        if (catalogProbes === 1) return [{ id: "old-model", efforts: ["low"] }];
        if (catalogProbes === 2) {
          refreshEntered();
          return slowRefresh;
        }
        return null; // 수동 재탐지 실패 시에도 직전 배경 갱신 목록을 폴백으로 써야 한다.
      },
    });
    await service.discover();
    clock += MODEL_CATALOG_TTL_MS + 1;
    await service.discover({ recheck: true });
    const refresh = service.refreshStaleCatalogs();
    await entered;
    const rediscovery = service.discover(discoveryOptions);
    await new Promise((resolve) => setImmediate(resolve));
    const versionsBeforeRelease = countRuns(calls, codexPath, "--version");
    releaseRefresh([{ id: "new-model", efforts: ["high"] }]);
    const [refreshed] = await Promise.all([refresh, rediscovery]);

    assert.equal(versionsBeforeRelease, 2, "배경 갱신이 끝나기 전에 재탐지를 시작하지 않는다");
    assert.equal(refreshed.changed, true);
    assert.equal(catalogProbes, discoveryOptions.force ? 3 : 2);
    assert.deepEqual(service.getRecord("codex").models, ["default", "new-model"]);
    assert.deepEqual(cacheStore.value[`codex:${codexPath}`].models, ["default", "new-model"]);
    // 실패한 수동 조회는 '아직 못 받은 목록'으로 남겨 backoff 뒤 다시 조회한다
    // (refreshCatalog). 목록 자체는 방금 갱신된 것을 유지한다 — 위 단언이 그것이다.
    assert.equal(service.hasStaleCatalogs(), Boolean(discoveryOptions.force));
    if (discoveryOptions.force) assert.ok(service.getRecord("codex").catalogRetryAt > clock);
  });
}

test("claude --help의 별칭만 모델 목록에 올리고 전체 이름 예시는 제외한다", () => {
  assert.deepEqual(parseClaudeHelpModels(CLAUDE_HELP), ["default", "fable", "opus", "sonnet"]);
  // 도움말 문구가 바뀌어 "full name" 구절이 없어도 claude- 전체 이름은 예시로 본다.
  assert.deepEqual(
    parseClaudeHelpModels("  --model <model>  Provide 'opus' or 'sonnet' (e.g. 'claude-opus-4-1').\n  --effort <e>  x"),
    ["default", "opus", "sonnet"]
  );
  assert.equal(parseClaudeHelpModels("  --model <model>  Model.\n  --effort <e>  x"), null);
  assert.equal(parseClaudeHelpModels(""), null);
});

test("claude 별칭에는 최신 모델임을 알리는 표시 이름이 붙는다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({
    files,
    probes: { [claudePath]: "2.1.198\n" },
    helpText: { [claudePath]: CLAUDE_HELP },
  });
  const claude = (await service.discover()).find((record) => record.id === "claude");
  // 도움말이 알려 준 별칭만 담는다(haiku는 이 도움말에 없다).
  assert.deepEqual(claude.models, ["default", "fable", "opus", "sonnet"]);
  assert.deepEqual(
    claude.modelOptions.map((option) => [option.id, option.label]),
    [
      ["default", "Claude 기본값 (CLI 설정 따름)"],
      ["fable", "Fable (최신)"],
      ["opus", "Opus (최신)"],
      ["sonnet", "Sonnet (최신)"],
    ]
  );
  assert.ok(claude.modelOptions.every((option) => option.efforts.includes("max")));
  // 전체 이름 예시는 별칭과 같은 계열이 두 줄로 보이지 않도록 목록에 없다.
  assert.equal(claude.modelOptions.some((option) => /^claude-/.test(option.id)), false);
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
  // 조회 실패 시 쓰는 기본 목록은 노출 목록(CLAUDE_MODEL_OPTIONS)과 같은 집합이어야
  // 한다. 한쪽에서만 빠진 모델을 골라 둔 사용자는 조용히 다른 모델로 옮겨 간다.
  assert.deepEqual(claude.models, ["default", "fable", "opus", "sonnet", "haiku"]);
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
  assert.equal(cached.modelOptionsVersion, 6);
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

// 예전 파서가 저장해 둔 목록에는 도움말의 전체 이름 예시(claude-fable-5)가 모델로
// 들어 있다. 형식 버전으로 걸러 내지 않으면 새 파서를 넣어도 사용자는 계속 그
// 옛 고정 버전을 고르게 된다 — 게다가 `claude --help`가 실패하는 환경에서는
// 다시 조회할 기회조차 없어 영영 남는다.
test("예전 형식으로 저장된 모델 목록은 신뢰하지 않는다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {
    value: {
      [`claude:${claudePath}`]: {
        mtimeMs: 111,
        size: 222,
        version: "2.1.198",
        probedAt: Date.now(),
        // catalogSchemaVersion 없음 = 예전 형식
        models: ["default", "fable", "claude-fable-5"],
        modelOptions: [
          { id: "default", efforts: ["default"] },
          { id: "fable", efforts: ["default"] },
          { id: "claude-fable-5", efforts: ["default"] },
        ],
      },
    },
  };
  // --help가 실패하는 환경: 캐시를 신뢰하면 되돌릴 방법이 없다.
  const { service } = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, cacheStore });
  const claude = (await service.discover()).find((record) => record.id === "claude");
  assert.equal(
    claude.modelOptions.some((option) => option.id === "claude-fable-5"),
    false,
    "예전 형식 캐시의 고정 버전이 그대로 살아 있으면 안 됩니다"
  );
  assert.deepEqual(claude.models, ["default", "fable", "opus", "sonnet", "haiku"]);
});

// 캐시가 없는 첫 실행에서 조회가 실패하면 기본값만 남는다. 다시 조회할 대상으로
// 표시해 두지 않으면 그 목록이 다음 정기 재확인(1시간)까지 그대로 굳는다.
test("캐시 없이 카탈로그 조회에 실패하면 다시 조회할 대상으로 남는다", async () => {
  const codexPath = "C:\\Users\\u\\.local\\bin\\codex.exe";
  const files = new Set([codexPath]);
  let probeOk = false;
  let clock = 1000;
  const { service } = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => (probeOk
      ? [{ id: "gpt-6", label: "GPT-6", isDefault: true, efforts: ["medium"] }]
      : null),
    cacheStore: {},
    now: () => clock,
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.deepEqual(codex.models, ["default"], "조회 실패 시 기본값만 남습니다");
  assert.equal(codex.modelCatalogStale, true, "다시 조회할 대상이어야 합니다");
  assert.equal(service.hasStaleCatalogs(), true);

  // 실패 직후 연달아 찌르지는 않는다.
  probeOk = true;
  assert.equal((await service.refreshStaleCatalogs()).changed, false, "실패 직후에는 쉬어야 합니다");

  // 잠시 뒤에는 다시 시도한다.
  clock += 10 * 60 * 1000;
  const result = await service.refreshStaleCatalogs();
  assert.equal(result.changed, true);
  assert.deepEqual(service.getRecord("codex").models, ["default", "gpt-6"]);
  assert.equal(service.hasStaleCatalogs(), false);
});

// 강제 새로고침 버튼은 연타할 수 있다(화면에 두 개 있고 둘 다 스스로 잠기지 않는다).
// 두 탐지가 겹치면 records는 늦게 끝난 쪽이 이겨, 화면에 돌려준 목록과 실제 실행에
// 쓰는 목록이 달라진다.
test("강제 새로고침이 겹쳐도 탐지는 한 번에 하나씩 돈다", async () => {
  const codexPath = "C:\\Users\\u\\.local\\bin\\codex.exe";
  const files = new Set([codexPath]);
  let inFlight = 0;
  let maxInFlight = 0;
  let round = 0;
  const { service } = makeService({
    files,
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      round += 1;
      return [{ id: `gpt-${round}`, label: `GPT ${round}`, isDefault: true, efforts: ["medium"] }];
    },
  });
  const [a, b] = await Promise.all([
    service.discover({ force: true }),
    service.discover({ force: true }),
  ]);
  assert.equal(maxInFlight, 1, "동시에 두 탐지가 돌면 안 됩니다");
  // 각 호출은 자기 시점의 목록을 돌려주고, 나중에 끝난 쪽이 records를 갖는다.
  // 겹쳐 돌 때처럼 "화면에 준 목록"과 "실행이 쓰는 목록"이 엇갈리지 않는다.
  const live = service.getRecord("codex").models;
  assert.deepEqual(b.find((record) => record.id === "codex").models, live);
  assert.deepEqual(a.find((record) => record.id === "codex").models, ["default", "gpt-1"]);
  assert.deepEqual(live, ["default", "gpt-2"]);
});

test("collapseEffortVariants: 자동 발견한 노력 변형(efforts 표기 없음)도 접미사로 접는다", () => {
  // agy models가 아직 규칙에 없는 신모델을 노력마다 따로 보고하면(efforts 빈 채로
  // 들어와도) 같은 베이스의 변형이 2개 이상이면 한 모델로 접어야 한다. 예전에는
  // efforts가 비었다는 이유로 gemini-3.8-flash-high/-medium/-low가 별도 3줄로 떴다.
  const out = collapseEffortVariants([
    { id: "default", label: "AGY 기본값", efforts: [] },
    { id: "gemini-3.8-flash-high", label: "gemini-3.8-flash-high", efforts: [] },
    { id: "gemini-3.8-flash-medium", label: "gemini-3.8-flash-medium", efforts: [] },
    { id: "gemini-3.8-flash-low", label: "gemini-3.8-flash-low", efforts: [] },
    { id: "gpt-oss-99b-medium", label: "gpt-oss-99b-medium", efforts: [] },
  ]);
  const ids = out.map((o) => o.id);
  assert.ok(ids.includes("gemini-3.8-flash"), "베이스 한 줄로 접힌다");
  assert.equal(ids.includes("gemini-3.8-flash-high"), false, "원시 변형은 목록에서 사라진다");
  const folded = out.find((o) => o.id === "gemini-3.8-flash");
  assert.deepEqual(folded.efforts, ["low", "medium", "high"], "노력은 접미사에서 추론한다");
  assert.deepEqual(folded.effortModels, {
    high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium", low: "gemini-3.8-flash-low",
  });
  // 접미사가 하나뿐인 항목(고정 변형일 수 있음)은 접지 않고 그대로 둔다.
  assert.ok(ids.includes("gpt-oss-99b-medium"), "노력 변형이 하나뿐이면 접지 않는다");
});

test("collapseEffortVariants: 같은 계열이 이미 접혔으면 단일 변형(-high)도 접고 라벨은 베이스로 정리한다", () => {
  // 사용자가 gemini-3.8-flash-high 하나만 추가해도, 같은 gemini-#-flash 계열의
  // 다른 버전(3.7)이 노력으로 접혔으므로 그 계열은 노력을 쓴다는 근거가 된다.
  const out = collapseEffortVariants([
    { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (높음)", efforts: ["high"] },
    { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (낮음)", efforts: ["low"] },
    // 자동 발견/사용자 추가: 라벨이 id와 같고 형제도 없다.
    { id: "gemini-3.8-flash-high", label: "gemini-3.8-flash-high", efforts: [] },
    // 계열 근거가 없는 고정 변형은 그대로 raw로 남는다.
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (중간)", efforts: [] },
  ]);
  const ids = out.map((o) => o.id);
  assert.ok(ids.includes("gemini-3.8-flash"), "계열 근거가 있으면 단일 변형도 베이스로 접힌다");
  assert.equal(ids.includes("gemini-3.8-flash-high"), false, "원시 변형은 목록에서 사라진다");
  const folded = out.find((o) => o.id === "gemini-3.8-flash");
  assert.equal(folded.label, "gemini-3.8-flash", "라벨에 노력 접미사가 남지 않는다");
  assert.deepEqual(folded.efforts, ["high"]);
  assert.deepEqual(folded.effortModels, { high: "gemini-3.8-flash-high" });
  // curated 고정 변형(계열 근거 없음)은 접지 않는다.
  assert.ok(ids.includes("gpt-oss-120b-medium"), "계열 근거가 없는 고정 변형은 그대로 둔다");
});

test("자동 발견한 gemini-3.8-flash 노력 변형이 실제 probe 경로에서 한 모델로 접힌다", async () => {
  const agyPath = winPath.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const cacheStore = {};
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: { existsSync: (file) => files.has(file), statSync: () => ({ mtimeMs: 7, size: 8 }) },
    runCommand: async (file, args) => {
      if (file === agyPath && args[0] === "--version") return { ok: true, stdout: "agy 1.2.0\n", stderr: "" };
      if (file === agyPath && args[0] === "models") {
        return { ok: true, stdout: [
          "gemini-3.8-flash-high     Gemini 3.8 Flash (High)",
          "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
          "gemini-3.8-flash-low      Gemini 3.8 Flash (Low)",
          "",
        ].join("\n"), stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => cacheStore.value || null, set: (value) => { cacheStore.value = value; } },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.deepEqual(agy.models, ["default", "gemini-3.8-flash"], "목록은 접힌 한 줄이다");
  const folded = agy.modelOptions.find((option) => option.id === "gemini-3.8-flash");
  assert.deepEqual(folded.efforts, ["low", "medium", "high"]);
  assert.equal(folded.effortModels.high, "gemini-3.8-flash-high");
  assert.equal(agy.modelOptions.some((option) => option.id === "gemini-3.8-flash-high"), false);
});
