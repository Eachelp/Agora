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
  assert.match(preload, /openSettings: \(section\) => ipcRenderer\.send\(INVOKE\.OPEN_SETTINGS, section\)/);
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
    "btn-workflow",
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

test("저장된 UI 테마가 채팅 화면의 색상 변수에 적용된다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /appearance\?\.uiTheme/);
  assert.match(renderer, /root\.style\.setProperty\(`--\$\{key\}`, value\)/);
});

test("에이전트 아바타는 애니메이션 캐릭터 대신 공급자 로고를 사용한다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /claude: \{ icon: "\.\/chat-assets\/agent-claude\.svg"/);
  assert.match(renderer, /codex: \{ icon: "\.\/chat-assets\/agent-codex\.svg"/);
  assert.match(renderer, /agy: \{ icon: "\.\/chat-assets\/agent-agy\.png"/);
  for (const file of [
    "src/chat-assets/agent-claude.svg",
    "src/chat-assets/agent-codex.svg",
    "src/chat-assets/agent-agy.png",
  ]) {
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 0, `${file}이 비어 있지 않아야 합니다`);
  }
  assert.match(read("src/chat.css"), /\.agent-logo/);
  assert.doesNotMatch(renderer, /agent-glyph/);
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

test("프로젝트 아래에 여러 대화를 묶는 화면과 IPC 연결이 있다", () => {
  const html = read("src/chat.html");
  const preload = read("src/chat-preload.js");
  const renderer = read("src/chat.js");
  const ipc = read("src/chat/chat-ipc.js");

  for (const id of ["project-list", "btn-new-project", "chats-heading", "session-list"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="btn-specialist"/);
  for (const id of [
    "professional-actions",
    "btn-professional-plan",
    "btn-professional-implementation",
    "btn-professional-record",
    "btn-professional-full",
    "btn-professional-plan-view",
    "professional-progress",
    "plan-auto-revise",
    "plan-auto-limit",
    "implementation-auto-revise",
    "implementation-auto-limit",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // 전문 실행은 PLAN → ACT 흐름과 보조 기록 동작을 분리해 보여 준다.
  assert.match(html, /id="btn-professional-plan"[^>]*>PLAN<\/button>/);
  assert.match(html, /id="btn-professional-implementation"[^>]*>실행 ▶<\/button>/);
  assert.match(html, /id="btn-professional-full"[^>]*>전체 실행 ⚡<\/button>/);
  assert.match(html, /data-professional-step="plan-review"/);
  assert.match(renderer, /specialistNode/);
  // 옛 모달 시작 화면(3방식 선택)은 제거되어 renderer에 남지 않는다.
  assert.doesNotMatch(renderer, /function buildStartDialog/);
  assert.doesNotMatch(renderer, /async function runSpecialist\(/);
  assert.match(preload, /projectsCreate: \(name, workspace\)/);
  assert.match(preload, /projectsSelect: \(projectId\)/);
  assert.match(preload, /projectsUpdate: \(projectId, patch\)/);
  assert.match(preload, /projectsDelete: \(projectId\)/);
  assert.match(preload, /sessionsMove: \(sessionId, projectId, applyProjectWorkspace = false\)/);
  assert.match(preload, /specialistStart: \(sessionId, options = \{\}\)/);
  assert.match(preload, /specialistPlanAnswer: \(sessionId, text\)/);
  assert.match(preload, /specialistBlockDetails: \(sessionId\)/);
  assert.match(renderer, /부분 변경 보기/);
  assert.match(preload, /readTaskFile: \(sessionId, taskPath\)/);
  assert.match(preload, /memoryAppend: \(projectId, content, title\)/);
  assert.match(preload, /decisionsCreate: \(input\)/);
  assert.match(preload, /tasksCreate: \(input\)/);
  assert.match(renderer, /function renderProjects\(\)/);
  assert.match(renderer, /function selectProject\(projectId\)/);
  assert.match(renderer, /function openWorkflowPopover\(anchor\)/);
  assert.match(renderer, /defaultAgents/);
  assert.match(renderer, /defaultRoles/);
  assert.match(renderer, /function openSessionMovePopover\(anchor, session\)/);
  assert.match(renderer, /sessionsMove\(session\.id, project\.id, applyWorkspace\)/);
  assert.match(renderer, /project-move-apply-workspace/);
  assert.match(renderer, /전문 모드 역할 설정/);
  assert.match(renderer, /기획 검수 \(선택\)/);
  assert.match(renderer, /runProfessionalAction\(action\)/);
  assert.match(renderer, /planAutoRevisions/);
  assert.match(renderer, /implementationAutoRevisions/);
  assert.match(renderer, /payload\.model \|\| agent\?\.model/);
  assert.match(html, /role="switch"/);
  assert.match(renderer, /function openPlanPreview\(anchor\)/);
  assert.match(renderer, /누적 요약/);
  assert.match(ipc, /applyProjectWorkspace = false/);
  assert.match(ipc, /"chat:specialist:start"/);
  assert.match(ipc, /"chat:specialist:plan-answer"/);
  assert.match(ipc, /"chat:task:read-file"/);
  assert.match(ipc, /"chat:memory:append"/);
  assert.match(ipc, /"chat:projects:create"/);
  assert.match(ipc, /"chat:projects:select"/);
  assert.match(ipc, /"chat:projects:delete"/);
  assert.match(ipc, /"chat:sessions:move"/);
  assert.match(ipc, /"chat:decisions:create"/);
  assert.match(ipc, /"chat:tasks:create"/);
  assert.ok(fs.existsSync(path.join(ROOT, "src/agora/project-store.js")));
  assert.ok(fs.existsSync(path.join(ROOT, "src/agora/workflow-store.js")));
});

test("KaTeX 수식 렌더러가 오프라인 자산으로 채팅 화면에 포함된다", () => {
  const html = read("src/chat.html");
  assert.match(html, /vendor\/katex\/katex\.min\.css/);
  assert.match(html, /vendor\/katex\/katex\.min\.js/);
  assert.match(html, /vendor\/katex\/auto-render\.min\.js/);
  for (const file of [
    "src/vendor/katex/katex.min.js",
    "src/vendor/katex/katex.min.css",
    "src/vendor/katex/auto-render.min.js",
  ]) {
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 0, file + " should not be empty");
  }
  const renderer = read("src/chat.js");
  assert.match(renderer, /function renderMathIfAvailable\(container\)/);
  assert.match(renderer, /renderMathInElement/);
});

test("대화 이름 바꾸기는 우클릭 메뉴·⋯ 버튼·F2·제목 클릭으로 열린다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");

  // 제목은 클릭 가능한 버튼이라 한 번 클릭으로 편집에 들어갑니다.
  assert.match(html, /<button class="room-title-button" id="session-title"/);
  assert.match(renderer, /sessionTitleEl\.addEventListener\("click", startHeaderRename\)/);

  // 좌표 기준 팝오버 + 우클릭 메뉴
  assert.match(renderer, /function openPopoverAt\(rect, build\)/);
  assert.match(renderer, /function openPopover\(anchor, build\)/);
  assert.match(renderer, /function pointRect\(event\)/);
  assert.match(renderer, /function openSessionMenu\(rect, entry\)/);
  assert.match(renderer, /item\.addEventListener\("contextmenu"/);

  // F2 단축키와 편집 중 리렌더 가드
  assert.match(renderer, /event\.key === "F2"/);
  assert.match(renderer, /function startSessionRename\(sessionId\)/);
  assert.match(renderer, /if \(renamingSessionId\) return;/);

  // 아이콘 3개를 겹쳐 두던 hover 전용 오버레이는 사라졌습니다.
  assert.doesNotMatch(renderer, /session-actions/);
  assert.doesNotMatch(css, /\.session-actions/);
  assert.match(css, /\.session-item \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/s);
});

test("사용량은 채팅 사이드바에서 바로 보이고 설정은 사용량 탭으로 열린다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const preload = read("src/chat-preload.js");
  const main = read("src/main.js");
  const css = read("src/chat.css");

  assert.match(html, /id="btn-usage"/);
  assert.match(html, /id="usage-strip-items"/);
  assert.match(html, /<script src="\.\/usage-view\.js"><\/script>/);
  assert.match(read("src/settings.html"), /<script src="\.\/usage-view\.js"><\/script>/);

  assert.match(preload, /USAGE: "chat:usage"/);
  assert.match(preload, /usage: \(force = false\) => ipcRenderer\.invoke\(INVOKE\.USAGE, \{ force \}\)/);
  assert.match(main, /ipcMain\.handle\("chat:usage"/);
  assert.match(main, /async function loadProviderSnapshots\(forceUsage\)/);
  assert.match(main, /async function getUsageData\(\{ forceUsage = false \} = \{\}\)/);
  assert.match(main, /ipcMain\.on\("chat:open-settings", \(_event, section\) => \{\s*\n\s*openSettingsWindow\(section\);/);

  assert.match(renderer, /function renderUsageStrip\(\)/);
  assert.match(renderer, /function openUsagePopover\(\)/);
  assert.match(renderer, /chatApi\.openSettings\("usage"\)/);
  // 좌하단 스트립은 "사용량 | 5시간 | 주간" 격자로 두 칸을 다 보여 줍니다.
  assert.match(renderer, /usageView\.summarizeWindows\(item\)/);
  assert.match(renderer, /for \(const window of summary\.windows\)/);
  assert.match(renderer, /function makeStripHead\(text\)/);
  assert.match(renderer, /makeStripHead\("사용량"\)/);
  assert.match(css, /\.usage-strip-items \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  // 연결이 끊긴 공급자는 진단 버튼에 표시가 붙습니다.
  assert.match(renderer, /function renderProviderHealth\(\)/);
  assert.match(renderer, /doctorButton\.classList\.toggle\("has-issue"/);
  assert.match(read("src/settings.js"), /usageView\.remainingPercent\(gauge\)/);
  assert.ok(fs.existsSync(path.join(ROOT, "src/usage-view.js")));
});

test("채팅 화면 컨트롤은 인라인 스타일 없이 공통 크기 토큰을 쓴다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");

  // 설정 버튼에 박혀 있던 인라인 style·onmouseover 핸들러 제거
  assert.doesNotMatch(html, /onmouseover=/);
  assert.doesNotMatch(html, /onmouseout=/);
  assert.doesNotMatch(html, /<button[^>]*id="btn-settings"[^>]*style=/);
  assert.match(html, /class="foot-button foot-button-icon" id="btn-settings"/);

  // 진단·재탐지는 문제가 생겼을 때 찾는 버튼이라 사이드바 하단에 그대로 둡니다.
  // (메뉴 안에 숨기면 연결이 끊겼을 때 복구 경로가 멀어집니다)
  const foot = html.slice(html.indexOf('class="sidebar-foot"'), html.indexOf("</aside>"));
  for (const id of ["btn-usage", "btn-doctor", "btn-refresh-providers", "btn-settings"]) {
    assert.match(foot, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /room-more/);
  assert.match(html, /id="btn-workflow"[^>]*>프로젝트 기록/);

  // 공통 컨트롤 토큰
  assert.match(css, /--control-h: 32px/);
  assert.match(css, /--control-h-sm: 26px/);
  assert.match(css, /\.room-controls \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/s);
  assert.doesNotMatch(css, /\.discussion-button \{\s*\n\s*margin-left: auto;/);
});

test("에이전트가 낸 파일 경로와 링크가 읽을 수 있는 형태로 나온다", () => {
  const renderer = read("src/chat.js");
  const markdown = read("src/chat-markdown.js");
  const css = read("src/chat.css");

  // file://은 이동 가능한 link가 아니라 별도 file 토큰입니다. (임의 경로 열기 차단 유지)
  assert.match(markdown, /type: "file", href, path, text/);
  assert.match(markdown, /function decodeUrlText\(value\)/);
  assert.match(markdown, /function makeUrlToken\(href, label\)/);
  // [제목](주소) 문법도 인식합니다.
  assert.match(markdown, /markdownLink\.lastIndexOf\("\]\("\)/);

  assert.match(renderer, /token\.type === "file"/);
  assert.match(renderer, /clipboard\.writeText\(token\.path\)/);
  assert.match(css, /\.file-chip \{/);
});

test("상단 적용 방식은 짧은 라벨로 두고 상세는 툴팁으로 넘긴다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /enforcementHint\.textContent = \[\.\.\.enforcementKinds\]\.join/);
  assert.match(renderer, /enforcementHint\.title = enforcementDetail/);
  assert.match(renderer, /permissionSelect\.title = enforcementDetail/);
  // 참여 에이전트가 둘 미만이면 @all 응답 방식은 숨깁니다.
  assert.match(renderer, /responseModeBar\.hidden = professionalModeEnabled \|\| !discussable/);
});

test("연속된 시스템 알림은 접히고 다시 펼칠 수 있다", () => {
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");
  assert.match(renderer, /const SYSTEM_RUN_VISIBLE = 3/);
  assert.match(renderer, /function trailingSystemRun\(\)/);
  assert.match(renderer, /function syncSystemRun\(\)/);
  // 같은 문장이 연달아 오면 x N으로 묶습니다.
  assert.match(renderer, /function mergeIntoPreviousSystem\(item\)/);
  assert.match(css, /\.message-list\.show-system-history \.message\.is-collapsed/);
});
