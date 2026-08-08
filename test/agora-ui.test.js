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
  assert.match(html, /id="btn-settings"/);
  assert.match(preload, /OPEN_SETTINGS: "chat:open-settings"/);
  assert.match(preload, /openSettings: \(\) => ipcRenderer\.send\(INVOKE\.OPEN_SETTINGS\)/);
  assert.match(renderer, /btn-settings[\s\S]*?chatApi\.openSettings/);
  assert.match(main, /ipcMain\.on\("chat:open-settings"[\s\S]*?openSettingsWindow/);
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
});
