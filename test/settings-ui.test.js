const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const settingsHtml = source("src/settings.html");
const settingsJs = source("src/settings.js");
const settingsCss = source("src/settings.css");
const mainJs = source("src/main.js");
const accountSwitchingJs = source("src/agora/account-switching.js");
const packageJson = JSON.parse(source("package.json"));

test("설정 창은 전체 UI 색상, 글꼴, 세 provider, 사용량을 제공한다", () => {
  assert.doesNotMatch(settingsHtml, /name="theme"|data-theme/);
  assert.doesNotMatch(settingsJs, /themeSource|resolvedTheme|prefers-color-scheme/);
  assert.doesNotMatch(settingsCss, /data-theme|theme-option|theme-preview/);
  for (const key of ["page", "sidebar", "surface", "ink", "muted", "accent", "line"]) {
    assert.match(settingsHtml, new RegExp(`id="ui-${key}-picker"`));
    assert.match(settingsHtml, new RegExp(`id="ui-${key}-color"`));
  }
  assert.match(settingsJs, /const UI_THEME_FIELDS/);
  assert.match(settingsJs, /uiTheme: readUiTheme\(\)/);
  assert.match(mainJs, /normalizeUiTheme/);
  assert.match(settingsHtml, /id="font-search"/);
  assert.match(settingsHtml, /id="font-preview"/);
  assert.match(settingsHtml, /id="font-size"[^>]*min="10"[^>]*max="20"/);
  assert.match(settingsJs, /function resolveInstalledFontFamily/);
  assert.match(settingsJs, /fontSize:\s*selectedFontSize/);
  assert.match(settingsHtml, /id="provider-groups"/);
  assert.match(settingsHtml, /id="usage-cards"/);
  assert.match(settingsHtml, new RegExp(`VERSION ${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(settingsCss, /--font-body:\s*"Segoe UI Variable"/);
  assert.doesNotMatch(settingsHtml, /<link[^>]+href=["']https?:/);
  assert.doesNotMatch(settingsHtml, /\.\.\/assets\//);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "assets")), false);
});

test("펫/말풍선 설정 UI는 제거됐다", () => {
  assert.doesNotMatch(settingsHtml, /pet-enabled|bubble-mode|id="pet"|id="follow"|말풍선/);
  assert.doesNotMatch(settingsJs, /petKey|petEnabled|activityBubbleMode|followMouse|bubbleBgColor|bubbleTextColor/);
  assert.doesNotMatch(mainJs, /petKey|petEnabled|activityBubbleMode|followMouse|bubbleBgColor|bubbleTextColor/);
  assert.match(settingsHtml, /id="autostart"/);
});

test("설정 Footer는 짧은 창에서도 본문을 덮지 않고 글꼴 목록은 각 글꼴로 표시된다", () => {
  const panelActionsRule = settingsCss.match(/\.panel-actions\s*\{[^}]*\}/)?.[0] || "";
  assert.doesNotMatch(panelActionsRule, /position:\s*sticky|bottom\s*:/);
  assert.match(settingsJs, /function createFontOption/);
  assert.match(settingsJs, /option\.style\.fontFamily\s*=\s*fontFamily/);
  assert.match(settingsJs, /filteredFonts\.map\(\(font\) => createFontOption\(font, font, font\)\)/);
});

test("프로젝트 연결과 Codex 현재 저장·재실행 UI는 제거됐다", () => {
  assert.doesNotMatch(settingsHtml, /project-account|binding-list|save-binding|프로젝트 연결/);
  assert.doesNotMatch(settingsHtml, /현재 계정 저장|Codex Desktop 재실행/);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "project-account-bindings.js")), false);
});

test("사용량 카드는 한도만 렌더링하고 계정 action을 넣지 않는다", () => {
  const usageRenderer = settingsJs.slice(
    settingsJs.indexOf("function renderUsage"),
    settingsJs.indexOf("function renderAll")
  );
  assert.match(settingsJs, /function createUsageGauge/);
  assert.match(settingsJs, /function renderUsage/);
  assert.doesNotMatch(settingsHtml, /data-account=/);
  assert.doesNotMatch(usageRenderer, /runAccountAction\(/);
});

test("설정 renderer는 안전한 DOM API를 쓰고 성공 카드를 남기지 않는다", () => {
  assert.doesNotMatch(settingsJs, /\.innerHTML\s*=/);
  assert.match(settingsJs, /textContent/);
  assert.match(settingsHtml, /id="toast"/);
  assert.doesNotMatch(settingsHtml, /id="notice"/);
  assert.doesNotMatch(settingsJs, /완료했습니다|적용했습니다|setNotice/);
});

test("계정 설정은 비활성 프로필 삭제를 확인하고 삭제 중 상태를 표시한다", () => {
  assert.match(settingsJs, /action: "delete", profileKey: account\.key/);
  assert.match(settingsJs, /window\.confirm/);
  assert.match(settingsJs, /deleteButton\.disabled = account\.active/);
  assert.match(settingsJs, /"삭제 중…"/);
  assert.match(settingsCss, /\.danger-button/);
});

test("트레이 메뉴는 설정·채팅·계정·프록시·종료만 제공한다", () => {
  assert.match(mainJs, /label:\s*"설정…"/);
  assert.match(mainJs, /label:\s*"에이전트 채팅방…"/);
  assert.match(mainJs, /label:\s*"완전 종료"/);
  assert.doesNotMatch(mainJs, /펫 보이기|펫 숨기기|펫 바꾸기|마우스 따라가기|이동 일시 정지/);
  // isCodexProxyModeEnabled는 src/agora/account-switching.js에 있습니다.
  assert.match(accountSwitchingJs, /readSettings\(\)\.codexProxyMode === true/);
  assert.doesNotMatch(accountSwitchingJs, /readSettings\(\)\.codexProxyMode !== false/);
});

test("계정 안내는 펫 말풍선 대신 채팅 창 시스템 공지로 전달된다", () => {
  assert.match(accountSwitchingJs, /function showAccountNotice\(text\)/);
  assert.match(accountSwitchingJs, /chatFeature\.showSystemNotice\(text\)/);
  assert.doesNotMatch(accountSwitchingJs, /showBubble|playReaction|isPetEnabled|getPetWindow|getBubbleWindow/);
});
