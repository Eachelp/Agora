const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("Agora는 펫을 기본으로 만들지 않고 채팅으로 시작한다", () => {
  const main = read("src/main.js");
  assert.match(main, /function isPetEnabled\(\)[\s\S]*?petEnabled === true/);
  assert.match(main, /const petEnabled = isPetEnabled\(\);[\s\S]*?if \(petEnabled\) \{[\s\S]*?createWindow\(\);/);
  assert.match(main, /!petEnabled && !process\.argv\.includes\("--settings"\)[\s\S]*?openChatWindow\(\)/);
});

test("채팅 화면의 설정 버튼이 기존 설정 창을 연다", () => {
  const html = read("src/chat.html");
  const preload = read("src/chat-preload.js");
  const renderer = read("src/chat.js");
  const main = read("src/main.js");
  const chatWindow = read("src/chat/chat-window.js");
  assert.match(html, /id="btn-settings"/);
  assert.match(preload, /OPEN_SETTINGS: "chat:open-settings"/);
  assert.match(preload, /openSettings: \(\) => ipcRenderer\.send\(INVOKE\.OPEN_SETTINGS\)/);
  assert.match(renderer, /btn-settings[\s\S]*?chatApi\.openSettings/);
  assert.match(main, /ipcMain\.on\("chat:open-settings"[\s\S]*?openSettingsWindow/);
  assert.match(chatWindow, /icon: path\.join\(__dirname, "\.\.", "\.\.", "build", "icon\.ico"\)/);
  assert.match(main, /title: "Ἀγορά 설정"[\s\S]*?icon: path\.join\(__dirname, "\.\.", "build", "icon\.ico"\)/);
});

test("채팅 아이콘 경로는 실제 Agora build 폴더를 가리킨다", () => {
  const chatIconPath = path.resolve(ROOT, "src", "chat", "..", "..", "build", "icon.ico");
  assert.equal(chatIconPath, path.resolve(ROOT, "build", "icon.ico"));
});

test("창을 닫아도 트레이 앱은 다음 실행에서 채팅창을 다시 연다", () => {
  const main = read("src/main.js");
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /second-instance[\s\S]*?openChatWindow\(\)/);
  assert.match(main, /app\.on\("before-quit"[\s\S]*?codexWatcher\.stop\(\)/);
  assert.doesNotMatch(main, /app\.on\("window-all-closed"[\s\S]*?codexWatcher\.stop\(\)/);
});

test("Agora 화면 재배치는 기존 채팅 제어 연결을 유지한다", () => {
  const html = read("src/chat.html");
  for (const id of [
    "btn-new-session",
    "session-list",
    "btn-workspace",
    "permission-select",
    "btn-discussion",
    "agent-chips",
    "btn-attach",
    "composer-input",
    "btn-stop",
    "btn-send",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="session-title"/);
  assert.match(html, /Ἀγορά/);
});

test("Agora 채팅 화면은 기능 라벨을 간결하게 유지한다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");
  assert.doesNotMatch(html, /HUMAN-LED WORKSPACE|DISCUSSION ROOM|MESSAGE THE ROOM|AGORA DOCTOR/);
  assert.match(html, /id="btn-settings"/);
  assert.match(css, /\.titlebar-btn\.btn-settings[\s\S]*?width: 52px/);
  assert.match(css, /\.titlebar-btn\.btn-settings svg[\s\S]*?width: 16px/);
});

test("에이전트 아바타는 애니메이션 캐릭터 대신 기본 기호를 사용한다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /claude: \{ glyph:/);
  assert.match(renderer, /codex: \{ glyph:/);
  assert.match(renderer, /agy: \{ glyph:/);
  assert.doesNotMatch(renderer, /chat-assets\//);
  assert.match(read("src/chat.css"), /\.agent-glyph/);
});

test("Agora 아이콘은 파란 배경과 흰색 Ἀ를 사용한다", () => {
  assert.match(read("src/chat.html"), /src="\.\.\/build\/icon\.png"/);
  assert.match(read("src/settings.html"), /src="\.\.\/build\/icon\.png"/);
  for (const file of ["build/icon.png", "build/icon-mac.png", "build/icon.ico"]) {
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 0, `${file}이 비어 있지 않아야 합니다`);
  }
  const ico = fs.readFileSync(path.join(ROOT, "build/icon.ico"));
  assert.equal(ico.readUInt16LE(4), 7, "Windows 아이콘은 작은 크기별 이미지를 포함해야 합니다");
});
