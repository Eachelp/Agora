"use strict";

// F168: AGY 모델 표를 고치고 캐시 버전을 올리지 않으면 옛 캐시의 원시 id가 최대 6시간 남는다.
// F160: Finder로 띄운 macOS 앱의 PATH에는 node가 없어 `#!/usr/bin/env node` CLI 프로브가 실패한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const {
  AGY_MODEL_OPTIONS_VERSION,
  PROVIDER_DEFS,
  createCapabilityService,
  withCommonCliPaths,
} = require("../src/providers/provider-capabilities");

const win = path.win32;
const WIN_ENV = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" };

test("F168: 표를 고치기 전(버전 6)에 저장된 AGY 캐시는 신선해도 다시 조회해 표시명을 갱신한다", async () => {
  const agyPath = win.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const NOW = 1_000_000_000;
  const cacheStore = {
    value: {
      [`agy:${agyPath}`]: {
        mtimeMs: 5,
        size: 6,
        version: "agy 1.2.16",
        models: ["default", "claude-opus-5-5"],
        modelOptions: [
          { id: "default", label: "AGY 기본값", efforts: [] },
          { id: "claude-opus-5-5", label: "claude-opus-5-5", efforts: ["low", "medium", "high"] },
        ],
        probedAt: NOW - 60 * 60 * 1000,
        catalogSchemaVersion: 3,
        modelOptionsVersion: 6,
      },
    },
  };
  let modelsRuns = 0;
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    now: () => NOW,
    fs: {
      existsSync: (file) => file === agyPath,
      statSync: () => ({ mtimeMs: 5, size: 6 }),
    },
    runCommand: async (file, args) => {
      if (file === agyPath && args[0] === "--version") return { ok: true, stdout: "agy 1.2.16\n", stderr: "" };
      if (file === agyPath && args[0] === "models") {
        modelsRuns += 1;
        return { ok: true, stdout: "claude-opus-5-5-low\nclaude-opus-5-5-medium\nclaude-opus-5-5-high\n", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => cacheStore.value, set: (value) => { cacheStore.value = value; } },
  });
  const agy = (await service.discover()).find((record) => record.id === "agy");
  assert.equal(modelsRuns, 1, "옛 버전 캐시는 쓰지 않고 다시 조회해야 한다");
  assert.equal(agy.modelOptions.find((option) => option.id === "claude-opus-5-5").label, "Claude Opus 5.5");
});

test("F168: AGY 캐시 버전에 모델 표 내용의 지문이 들어 있어 표만 고쳐도 무효화된다", () => {
  const agy = PROVIDER_DEFS.find((def) => def.id === "agy");
  const fingerprint = crypto.createHash("sha1").update(JSON.stringify(agy.modelOptions)).digest("hex").slice(0, 10);
  assert.match(String(AGY_MODEL_OPTIONS_VERSION), new RegExp(`:${fingerprint}$`));
});

test("F160: macOS Finder PATH에 흔한 node 설치 위치를 덧붙인다(다른 OS는 그대로)", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/u" };
  const mac = withCommonCliPaths(env, { platform: "darwin", home: "/Users/u" });
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/Users/u/.local/bin"]) {
    assert.ok(mac.PATH.split(":").includes(dir), dir);
  }
  assert.ok(mac.PATH.startsWith("/usr/bin:/bin"), "기존 PATH 순서를 앞에 둔다");
  assert.equal(mac.HOME, "/Users/u");
  assert.equal(withCommonCliPaths({ PATH: "/usr/bin:/opt/homebrew/bin" }, { platform: "darwin", home: "/h" }).PATH.split(":").filter((d) => d === "/opt/homebrew/bin").length, 1);
  const winEnv = { Path: "C:"+String.fromCharCode(92)+"Windows" };
  assert.equal(withCommonCliPaths(winEnv, { platform: "win32", home: "/h" }), winEnv);
});

test("F160: CLI 버전·모델 프로브가 보강된 PATH를 받는다(Finder로 띄운 macOS)", async () => {
  const codexPath = "/opt/homebrew/bin/codex";
  const seen = [];
  let modelProbeEnv = null;
  const service = createCapabilityService({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    home: "/Users/u",
    fs: { existsSync: (file) => file === codexPath, statSync: () => ({ mtimeMs: 1, size: 2 }) },
    runCommand: async (file, args, options) => {
      seen.push({ file, args, env: options?.env });
      return args[0] === "--version" ? { ok: true, stdout: "codex-cli 0.146.0\n", stderr: "" } : { ok: false, stdout: "", stderr: "" };
    },
    codexModelProbe: async (_command, _needsShell, _timeout, deps) => {
      modelProbeEnv = deps?.env;
      return [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low"] }];
    },
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.equal(codex.status, "cli");
  const versionRun = seen.find((run) => run.file === codexPath && run.args[0] === "--version");
  assert.ok(versionRun.env.PATH.split(":").includes("/opt/homebrew/bin"));
  assert.ok(modelProbeEnv?.PATH.split(":").includes("/opt/homebrew/bin"));
});

test("F160: 앱 시작 때 process.env.PATH도 보강해 실행(spawn)이 같은 PATH를 물려받는다", () => {
  const main = require("node:fs").readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /process\.env\.PATH = withCommonCliPaths\(process\.env\)\.PATH/);
});
