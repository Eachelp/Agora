"use strict";

// F144: settings.json을 쓰다 끊겨도 설정이 남는다. F134: 글꼴 조회 실패를 세션 내내 굳히지 않는다.
// F133: Windows 종료·재시작 때(session-end)도 Codex 프록시 정리를 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readSettingsFile, writeSettingsFile } = require("../src/settings-file");
const { getInstalledFonts } = require("../src/installed-fonts");
const { registerSessionEndTeardown } = require("../src/session-end");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agora-settings-"));
const SAVED = { fontFamily: "Malgun Gothic", fontSize: 14, codexProxyMode: true, showAwaiting: false };

test("F144: 쓰는 도중 끊겨도(파일 일부만 기록) 기존 설정과 프록시 모드가 그대로 읽힌다", () => {
  const file = path.join(tmpDir(), "settings.json");
  writeSettingsFile(file, SAVED);
  // 프로세스가 쓰다 죽은 것처럼: 대상 경로에 일부만 쓰고 던진다.
  const crashingFs = {
    ...fs,
    writeFileSync(target, data, ...rest) {
      fs.writeFileSync(target, String(data).slice(0, 10), ...rest);
      throw new Error("강제 종료");
    },
  };
  const warnings = [];
  writeSettingsFile(file, { fontSize: 16 }, { fs: crashingFs, warn: (...args) => warnings.push(args.join(" ")) });
  assert.deepEqual(readSettingsFile(file), SAVED);
  assert.equal(warnings.length, 1, "실패는 조용히 지나가지 않고 경고로 남긴다");
});

test("F144: 이미 깨진 settings.json은 직전 정상 사본에서 읽고, 다음 저장이 나머지 설정을 지우지 않는다", () => {
  const file = path.join(tmpDir(), "settings.json");
  writeSettingsFile(file, SAVED);
  writeSettingsFile(file, { fontSize: 15 });
  fs.writeFileSync(file, '{"fontFamily": "Malg'); // 옛 버전이 남긴 잘린 파일
  assert.equal(readSettingsFile(file).codexProxyMode, true);
  writeSettingsFile(file, { showAwaiting: true });
  const after = readSettingsFile(file);
  assert.equal(after.codexProxyMode, true);
  assert.equal(after.fontFamily, "Malgun Gothic");
  assert.equal(after.showAwaiting, true);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), "본문도 정상 JSON으로 복구된다");
});

test("F144: 정상 저장은 patch를 합치고 themeSource를 지우며 임시 파일을 남기지 않는다", () => {
  const dir = tmpDir();
  const file = path.join(dir, "settings.json");
  writeSettingsFile(file, { themeSource: "dark", fontSize: 12 });
  writeSettingsFile(file, { fontSize: 13 });
  assert.deepEqual(readSettingsFile(file), { fontSize: 13 });
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(readSettingsFile(path.join(dir, "none.json")), {});
});

test("F134: 앱이 실제로 쓰는 경로(기본 execFile)에서 조회가 한 번 실패해도 빈 목록이 굳지 않는다", async () => {
  // main.js는 getInstalledFonts()를 인자 없이 부른다. 그 기본 execFile만 가짜로 바꿔 끼워 본다.
  const childProcess = require("node:child_process");
  const realExecFile = childProcess.execFile;
  const modulePath = require.resolve("../src/installed-fonts");
  let attempts = 0;
  childProcess.execFile = (_cmd, _args, _options, callback) => {
    attempts += 1;
    if (attempts === 1) callback(new Error("시간 초과"));
    else callback(null, "Malgun Gothic (TrueType)\r\nArial (TrueType)\r\n");
  };
  delete require.cache[modulePath];
  try {
    const fresh = require("../src/installed-fonts");
    assert.deepEqual(await fresh.getInstalledFonts({ platform: "win32" }), []);
    assert.deepEqual(await fresh.getInstalledFonts({ platform: "win32" }), ["Arial", "Malgun Gothic"]);
    // 성공한 목록은 계속 캐시한다.
    await fresh.getInstalledFonts({ platform: "win32" });
    assert.equal(attempts, 2);
  } finally {
    childProcess.execFile = realExecFile;
    delete require.cache[modulePath];
  }
});

test("F134: 같은 시각에 겹쳐 부른 조회는 한 번만 실행한다", async () => {
  let attempts = 0;
  const run = (_cmd, _args, _options, callback) => {
    attempts += 1;
    setImmediate(() => callback(null, "Arial\n"));
  };
  await Promise.all([getInstalledFonts({ run, platform: "linux" }), getInstalledFonts({ run, platform: "linux" })]);
  assert.equal(attempts, 1);
});

test("F134: 설정 저장(settings:save)은 글꼴 목록이 비었을 때 저장된 글꼴을 지우지 않는다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(
    main,
    /if \(Object\.hasOwn\(next, "fontFamily"\)\) \{\s*const fonts = await getInstalledFonts\(\);\s*if \(fonts\.length > 0 \|\| !next\.fontFamily\) \{/
  );
});

test("F134: 설정 저장(settings:save)은 글꼴을 바꾸지 않는 저장에서는 글꼴 목록을 조회하지 않는다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const start = main.indexOf('ipcMain.handle("settings:save"');
  const end = main.indexOf('ipcMain.handle("settings:account"');
  assert.ok(start > 0 && end > start, "settings:save 핸들러를 찾는다");
  const handler = main.slice(start, end);
  // 조회는 핸들러 안에 한 번뿐이고, fontFamily가 들어 있는 분기 안에만 있다.
  assert.equal(handler.split("getInstalledFonts()").length - 1, 1);
  assert.ok(handler.indexOf('Object.hasOwn(next, "fontFamily")') < handler.indexOf("getInstalledFonts()"));
});

test("F133: 어떤 창이든 session-end가 오면 프록시 정리를 한다(before-quit이 없는 Windows 종료)", () => {
  const app = new EventEmitter();
  let teardowns = 0;
  registerSessionEndTeardown(app, () => { teardowns += 1; });
  const hiddenChatWindow = new EventEmitter();
  const settingsWindow = new EventEmitter();
  app.emit("browser-window-created", {}, hiddenChatWindow);
  app.emit("browser-window-created", {}, settingsWindow);
  hiddenChatWindow.emit("session-end", {});
  assert.equal(teardowns, 1);
  // 정리가 던져도 종료 경로를 막지 않는다.
  const throwing = new EventEmitter();
  const app2 = new EventEmitter();
  registerSessionEndTeardown(app2, () => { throw new Error("config 잠김"); });
  app2.emit("browser-window-created", {}, throwing);
  assert.doesNotThrow(() => throwing.emit("session-end", {}));
});

test("F133: main.js가 session-end 정리를 teardownCodexProxyOnQuit에 연결한다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /registerSessionEndTeardown\(app, teardownCodexProxyOnQuit\)/);
});

test("F144: main.js의 설정 읽기·쓰기는 원자적 저장 모듈을 거친다", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /return readSettingsFile\(getSettingsPath\(\)\)/);
  assert.match(main, /writeSettingsFile\(getSettingsPath\(\), patch\)/);
  assert.doesNotMatch(main, /fs\.writeFileSync\(getSettingsPath/);
});
