const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCapabilityService } = require("../src/providers/provider-capabilities");
const { createAccountSwitching } = require("../src/agora/account-switching");

const onWindows = process.platform === "win32";
const system32 = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32");

// 한국어 Windows의 where.exe는 '한글'을 CP949(C8 AB B1 E6 B5 BF)로 내보낸다.
// 앱이 이를 UTF-8로 읽으면 U+FFFD가 섞인 깨진 경로가 된다.
const BROKEN_HANGUL = Buffer.from("c8abb1e6b5bf", "hex").toString("utf8");

test("F153: where.exe 출력이 CP949로 깨져도 PATH를 직접 훑어 한글 경로의 CLI를 찾는다", async () => {
  const dir = "C:\\Users\\홍길동\\AppData\\Roaming\\npm";
  const real = `${dir}\\codex.cmd`;
  const broken = `C:\\Users\\${BROKEN_HANGUL}\\AppData\\Roaming\\npm\\codex.cmd`;
  const service = createCapabilityService({
    platform: "win32",
    env: { PATH: `C:\\Windows\\System32;${dir}`, PATHEXT: ".exe;.cmd", LOCALAPPDATA: "C:\\Users\\홍길동\\AppData\\Local" },
    home: "C:\\Users\\홍길동",
    fs: {
      existsSync: (file) => file === real,
      statSync: (file) => {
        if (file !== real) throw new Error("ENOENT");
        return { mtimeMs: 1, size: 1 };
      },
    },
    runCommand: async (file, args) => {
      if (file === "where.exe") {
        return args[0] === "codex"
          ? { ok: true, stdout: `${broken}\r\n`, stderr: "" }
          : { ok: false, stdout: "", stderr: "" };
      }
      // 실제 경로로만 --version이 성공한다(깨진 경로는 실행되지 않는다).
      return file === real && args[0] === "--version"
        ? { ok: true, stdout: "codex-cli 0.0.0-fake\n", stderr: "" }
        : { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => null, set: () => {} },
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.equal(codex.status, "cli");
  assert.equal(codex.commandPath, real);
});

// 진짜 where.exe와 cmd.exe를 거치는 시험: 한글+공백 폴더의 .cmd를 기본 runCommand로 탐지한다.
test("F153+F120: 한글과 공백이 든 폴더의 codex.cmd가 실제 탐지(where/cmd.exe)를 통과한다", { skip: !onWindows }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-detect-"));
  const dir = path.join(root, "한글 폴더", "npm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo codex-cli 0.0.0-fake\r\n");
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir};${system32()}`;
  t.after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const service = createCapabilityService({
    platform: "win32",
    env: process.env,
    home: root,
    cache: { get: () => null, set: () => {} },
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.equal(codex.status, "cli");
  assert.equal(codex.commandPath.toLowerCase(), path.join(dir, "codex.cmd").toLowerCase());
  assert.match(codex.version, /codex-cli 0\.0\.0-fake/);
});

test("F120: 공백이 든 경로의 claude.cmd로 계정 상태 확인(getClaudeAuthStatus)이 된다", { skip: !onWindows }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-auth-"));
  const dir = path.join(root, "John Smith", "npm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "claude.cmd"),
    '@echo {"loggedIn":true,"email":"a@example.com","subscriptionType":"pro"}\r\n'
  );
  const savedPath = process.env.PATH;
  const savedProfile = process.env.USERPROFILE;
  process.env.PATH = `${dir};${system32()}`;
  process.env.USERPROFILE = root; // 이 PC의 실제 ~/.local/bin/claude.exe가 먼저 잡히지 않게 한다
  t.after(() => {
    process.env.PATH = savedPath;
    process.env.USERPROFILE = savedProfile;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const switching = createAccountSwitching({
    electron: { app: { getPath: () => root }, shell: {} },
    readSettings: () => ({}),
    writeSettings: () => {},
    getChatFeature: () => null,
  });
  const status = await switching.getClaudeAuthStatus();
  assert.equal(status.email, "a@example.com");
});
