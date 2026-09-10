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
  // 삭제 버튼은 비활성 계정 행에만 그린다(활성은 로그아웃). 예전엔 활성이면
  // disabled로 두어 계정이 하나면 영영 못 지웠다.
  assert.match(settingsJs, /if \(account\.active\) \{/);
  assert.match(settingsJs, /\} else \{[\s\S]{0,400}createElement\("button", "button danger-button", "삭제"\)/);
  assert.ok(!/deleteButton\.disabled = account\.active/.test(settingsJs), "활성 계정을 disabled 삭제로 막지 않는다");
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

// [계정 추가]는 터미널 창을 열지 않는다. CLI 로그인은 앱이 자식 프로세스로 돌리고,
// 설정 창의 패널에서 브라우저 열기·인증 코드 붙여넣기·취소만 한다.
test("계정 추가는 터미널 대신 앱 안 로그인 패널로 진행한다", () => {
  const preload = source("src/settings-preload.js");
  assert.match(preload, /settings:account-login/);
  assert.match(preload, /onAccountLogin/);
  assert.match(settingsJs, /api\.onAccountLogin\?\.\(/);
  for (const label of ["브라우저 열기", "코드 보내기", "취소", "다시 시도", "로그인 진행 중"]) {
    assert.ok(settingsJs.includes(label), `로그인 패널에 '${label}'이 있어야 합니다`);
  }
  for (const action of ["login-input", "login-open-url", "login-cancel"]) {
    assert.match(settingsJs, new RegExp(`action: "${action}"`));
    assert.match(mainJs, new RegExp(`"${action}"`));
  }
  assert.match(settingsCss, /\.login-panel/);
  // 터미널 스크립트 경로는 전부 사라졌다.
  assert.ok(
    !/openCodexLoginTerminal|writeClaudeLoginScript|writeCodexLoginScript|openLoginScript|unix-login/.test(accountSwitchingJs),
    "터미널 스크립트 로그인 경로가 남아 있으면 안 됩니다"
  );
  assert.ok(!/openCodexLoginTerminal/.test(mainJs));
  assert.equal(fs.existsSync(path.join(__dirname, "..", "src", "unix-login.js")), false);
  // 로그인 주소는 그 로그인이 실제로 출력한 것만 연다.
  assert.match(accountSwitchingJs, /knowsUrl\(provider, url\)/);
});

// 활성 계정도 이 PC에서 지울 수 있어야 한다(로그아웃). 반납용 전체 지우기 버튼도.
test("계정 화면은 활성 계정 로그아웃과 이 PC 전체 지우기를 제공한다", () => {
  // 활성 계정 행: 비활성 삭제 버튼 대신 로그아웃.
  assert.match(settingsJs, /account\.active/);
  assert.match(settingsJs, /"로그아웃"/);
  assert.match(settingsJs, /action: "logout"/);
  // 전체 지우기 버튼과 IPC.
  assert.match(settingsHtml, /id="wipe-all"/);
  assert.match(settingsJs, /api\.wipeAll\(\)/);
  const preload = source("src/settings-preload.js");
  assert.match(preload, /settings:wipe-all/);
  assert.match(preload, /wipeAll:/);
  assert.match(mainJs, /"settings:wipe-all"/);
  // 로그아웃·전체 지우기는 계정 경계 뒤에서 한다(라이브 인증 삭제).
  assert.match(accountSwitchingJs, /async function logoutProvider\(provider\)/);
  assert.match(accountSwitchingJs, /async function wipeAllAccounts\(\)/);
  assert.match(accountSwitchingJs, /await installAccountBoundaryOrFail\(provider\)[\s\S]{0,200}switcher\.logout\(\)/);
});
