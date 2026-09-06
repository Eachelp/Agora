const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("Agora는 채팅으로 시작하고 CodePet 레거시가 남아 있지 않다", () => {
  const main = read("src/main.js");
  assert.match(main, /app\.whenReady\(\)[\s\S]*?openChatWindow\(\)/);
  // --settings만 넘기면 설정 창만 뜨고, 그 외에는 항상 채팅 창을 엽니다.
  assert.match(main, /--settings[\s\S]*?openSettingsWindow\(\)/);
  // 펫/말풍선/워처 레거시는 완전히 제거되었습니다.
  assert.doesNotMatch(main, /isPetEnabled|petWindow|bubbleWindow|Watcher|movement|sprite/i);
  for (const removed of [
    "src/renderer.js",
    "src/index.html",
    "src/preload.js",
    "src/bubble.js",
    "src/codex-watcher.js",
    "src/agora/pet-sprites.js",
    "src/default-pet",
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, removed)), `${removed}는 삭제되어야 합니다`);
  }
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
  // 창이 모두 닫혀도 "완전 종료" 전에는 트레이 프로세스가 남습니다.
  assert.match(main, /app\.on\("window-all-closed"[\s\S]*?if \(isQuitting\)/);
  assert.match(main, /app\.on\("before-quit"[\s\S]*?chatFeature\.shutdown\(\)/);
});

test("Agora 화면 재배치는 기존 채팅 제어 연결을 유지한다", () => {
  const html = read("src/chat.html");
  for (const id of [
    "project-list",
    "btn-new-project",
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

test("사이드바는 프로젝트 토글 트리 하나로 통합된다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const ipc = read("src/chat/chat-ipc.js");
  // 별도 "채팅" 섹션은 사라지고 채팅은 각 프로젝트 아래에 중첩됩니다.
  assert.doesNotMatch(html, /id="chats-heading"|id="btn-new-session"|id="session-list"/);
  assert.match(html, /class="project-list project-tree"/);
  // 트리: 접기/펼치기 화살표 + 행별 새 채팅(+)·설정(⋯), 접힘 상태는 기억합니다.
  assert.match(renderer, /project-caret/);
  assert.match(renderer, /agora\.chat\.projectTreeClosed/);
  assert.match(renderer, /function buildSessionItem\(entry\)/);
  assert.match(renderer, /sessionsCreate\(project\.id\)/);
  // 선택된 채팅이 접힌 프로젝트 안에 숨지 않도록 항상 드러냅니다.
  assert.match(renderer, /function revealActiveSession/);
  // 백엔드는 프로젝트별 세션 목록을 내려주고, 새 채팅은 대상 프로젝트를 지정할 수 있습니다.
  assert.match(ipc, /sessionsByProject: sessionsByProjectPayload\(\)/);
  assert.match(ipc, /createSessionForProject\(projectId \? requireProject\(projectId\)\.id : undefined\)/);
});

// Windows 한국어 IME: 창 blur 동안 composer가 activeElement로 남으면 복귀 후
// 클릭해도 focus 전환이 없어 IME 입력 컨텍스트가 갱신되지 않는다(계측으로 확인).
// blur 시 실제로 focus를 놓고 복귀 시 다음 프레임에 되돌려 준다.
test("창 blur 시 composer focus를 실제로 놓고 복귀 시 되돌린다", () => {
  const renderer = read("src/chat.js");
  assert.ok(renderer.includes("imeRefocusTarget"), "IME 복구 대상을 기억해야 합니다");
  assert.ok(renderer.includes("active.blur()"), "창 blur 시 DOM focus를 실제로 놓아야 합니다");
  assert.ok(renderer.includes("requestAnimationFrame"), "복귀 후 다음 프레임에 focus를 돌려줘야 합니다");
  // 사용자가 복귀 후 다른 곳을 눌렀다면 focus를 빼앗지 않는다.
  assert.ok(renderer.includes("active !== document.body"), "다른 요소의 focus를 빼앗지 않아야 합니다");
});

// 사이드바 행은 VS Code / Slack처럼 한 줄이다. 연결 폴더와 시각은 줄바꿈 없이
// 이름 옆에 흐리게 붙고, 폴더명이 프로젝트 이름과 같으면 중복이라 숨긴다.
test("사이드바 행은 한 줄이고 부차 정보가 먼저 줄어든다", () => {
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");
  // 폴더명이 이름과 같으면 표시하지 않는다.
  assert.ok(renderer.includes("folder !== project.name"), "폴더명 중복은 숨겨야 합니다");
  // 시각은 별도 줄(metaLine)이 아니라 제목줄에 붙는다.
  assert.ok(renderer.includes("titleLine.append(time)"), "시각은 제목과 같은 줄이어야 합니다");
  assert.ok(!renderer.includes("main.append(titleLine, metaLine)"), "두 줄 구성이 남아 있으면 안 됩니다");
  // 이름보다 부차 정보가 먼저 말줄임된다(shrink 계수).
  assert.ok(css.includes("flex: 0 100 auto"), "부차 정보가 먼저 줄어들어야 합니다");
});

// 토론에는 Run이 없다. 전문 실행 Recorder 단계로 보내면 run 권한과 Professional
// session identity를 요구해 합의로 끝날 때마다 실패했다. 일반 턴으로 실행해야 한다.
test("토론 자동 기록은 전문 실행 경로를 타지 않는다", () => {
  const ipc = read("src/chat/chat-ipc.js");
  const body = ipc.slice(ipc.indexOf("async function recordDiscussion"));
  const fn = body.slice(0, body.indexOf("\n  function "));
  assert.ok(fn.includes("discussionSummary: { record: true }"), "토론 기록은 대화를 읽는 일반 턴이어야 합니다");
  assert.ok(!fn.includes("runRecorder"), "전문 실행 Recorder 단계를 쓰면 안 됩니다");
  assert.ok(!fn.includes("withProfessionalAuthorization"), "run-scoped 권한을 요구하면 안 됩니다");
});

// 버튼 활성 조건과 백엔드 요구 역할이 어긋나면 "눌리는데 실패하는 버튼"이 된다.
test("전문 실행 버튼은 백엔드가 요구하는 역할을 기준으로 활성화된다", () => {
  const renderer = read("src/chat.js");
  // 기록 버튼은 검토자가 아니라 기록 담당자를 본다.
  assert.ok(renderer.includes("professionalRecordButton.disabled = !recorder.agentId"));
  // 전체 실행은 백엔드가 기록 담당자까지 요구한다.
  assert.ok(renderer.includes("&& recorder.agentId"));
  // 비활성 이유를 툴팁으로 알린다.
  assert.ok(renderer.includes("기록 담당자가 필요합니다"));
});

test("사용량 스트립은 접기/펼치기이고 접힌 동안 조회하지 않는다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  assert.match(html, /id="btn-usage-fold"/);
  assert.match(html, /id="btn-usage"[^>]*hidden/);
  assert.match(renderer, /agora\.chat\.usageOpen/);
  assert.match(renderer, /if \(usageOpen\) void loadUsage\(\)/);
  assert.match(renderer, /if \(usageOpen \|\| usagePopoverOpen\) void refreshUsageIfStale\(\)/);
});

test("Showcase 레일은 기존 에이전트 설정과 설정 창으로 연결된다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  for (const id of ["app-rail", "rail-claude", "rail-codex", "rail-agy", "rail-settings"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // 앱이 Agora 하나뿐이라 앱 전환기 모양의 "아고라" 버튼은 두지 않습니다.
  assert.doesNotMatch(html, /id="rail-agora"/);
  assert.match(renderer, /openRailAgentSettings\(agentId, button\)/);
  assert.match(renderer, /openAgentPopover\(button, agentId\)/);
  assert.match(renderer, /railSettingsButton[\s\S]*?btn-settings[\s\S]*?click\(\)/);
});

test("Agora 채팅 화면은 기능 라벨을 간결하게 유지한다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");
  assert.doesNotMatch(html, /HUMAN-LED WORKSPACE|DISCUSSION ROOM|MESSAGE THE ROOM|AGORA DOCTOR/);
  assert.match(html, /id="btn-settings"/);
  assert.match(css, /\.titlebar-btn\.btn-settings[\s\S]*?width: 52px/);
  assert.match(css, /\.titlebar-btn\.btn-settings svg[\s\S]*?width: 16px/);
});

test("사이드바 2열부터 메인 대화까지 얇은 색 테두리의 둥근 패널로 이어진다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");
  const renderer = read("src/chat.js");
  assert.match(html, /class="workspace-shell"[^>]*>[\s\S]*id="sidebar"[\s\S]*id="chat-scroll"/);
  assert.match(css, /\.workspace-shell \{[^}]*margin: 4px 4px 4px 0/);
  assert.match(css, /\.workspace-shell \{[^}]*border: 1px solid color-mix/);
  assert.match(css, /\.workspace-shell \{[^}]*border-left: 0/);
  assert.match(css, /\.workspace-shell \{[^}]*border-radius: 10px/);
  assert.match(css, /\.app \{\s*background: var\(--accent\)/);
  assert.match(css, /\.chat-main \{[^}]*margin: 0/);
  assert.match(css, /\.app-rail \{[^}]*border-right: 0/);
  assert.match(css, /\.app-rail \{[^}]*width: 68px/);
  assert.match(css, /\.app-rail-button \{[^}]*font-size: 10\.5px/);
  assert.match(css, /\.app-rail-button img,[\s\S]*?\.app-rail-glyph \{[^}]*width: 28px/);
  assert.match(css, /\.app-rail-settings svg \{[^}]*width: 24px/);
  assert.match(html, /class="room-actions"[\s\S]*id="btn-workflow"[\s\S]*id="btn-discussion"[\s\S]*id="btn-specialist"/);
  assert.match(html, /id="agent-chips"[^>]*hidden/);
  assert.match(renderer, /function openRailAgentSettings\(agentId, button\)[\s\S]*?openAgentPopover\(button, agentId\)/);
  // 화면에 뜨지 않는 라벨(display:none)과 만드는 코드가 없는 단계 번호 뱃지는
  // 마크업·CSS에서 지웠다. 다시 들어오면 "보이지 않는 요소를 위한 규칙"이 쌓인다.
  assert.ok(!html.includes("professional-actions-label"), "숨겨진 라벨 요소는 남기지 않습니다");
  assert.ok(!css.includes("professional-actions-label"), "숨겨진 라벨 규칙은 남기지 않습니다");
  assert.ok(!/\.step-num \{/.test(css), "쓰지 않는 단계 번호 뱃지 규칙은 남기지 않습니다");
  // 같은 선택자를 여러 번 덮어쓰면 최종값을 읽으려면 파일 전체를 훑어야 한다.
  for (const selector of [".professional-actions", ".professional-auto-options", ".professional-progress"]) {
    const count = css.split(`\n${selector} {`).length - 1;
    assert.equal(count, 1, `${selector} 규칙은 한 블록으로 유지합니다 (현재 ${count}개)`);
  }
  assert.match(html, /class="professional-action-row"[\s\S]*id="btn-professional-full"[\s\S]*id="professional-progress"/);
  assert.match(css, /\.professional-action-row \{[^}]*grid-area: actions[^}]*justify-content: flex-start/);
  assert.match(css, /\.professional-actions \{[^}]*grid-template-areas:[\s\S]*"actions"[\s\S]*"progress"/);
  assert.match(css, /\.professional-progress \{[^}]*grid-area: progress[\s\S]*?justify-content: flex-start/);
  assert.match(css, /\.professional-auto-options \{[^}]*order: 2/);
  assert.match(css, /\.chat-scroll \{\s*background: var\(--surface\)/);
  assert.match(css, /\.composer \{\s*background: var\(--surface\)/);
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

test("Agora 채팅 브랜드는 고정 이미지를 반복하지 않고 그리스 문자 표식을 사용한다", () => {
  const chat = read("src/chat.html");
  assert.match(chat, /<span class="titlebar-logo"[^>]*>Ἀ<\/span>/);
  assert.doesNotMatch(chat, /class="app-rail-brand"/);
  assert.doesNotMatch(chat, /src="\.\.\/build\/icon\.png"/);
  assert.match(read("src/settings.html"), /src="\.\.\/build\/icon\.png"/);
  for (const file of ["build/icon.png", "build/icon-mac.png", "build/icon.ico"]) {
    assert.ok(fs.statSync(path.join(ROOT, file)).size > 0, `${file}이 비어 있지 않아야 합니다`);
  }
  const ico = fs.readFileSync(path.join(ROOT, "build/icon.ico"));
  assert.equal(ico.readUInt16LE(4), 7, "Windows 아이콘은 작은 크기별 이미지를 포함해야 합니다");
});

// v1.1.0 macOS 패키징은 256px 아이콘 때문에 IconConversionError(ERR_ICON_TOO_SMALL)로
// 실패했습니다. electron-builder는 macOS 아이콘에 512x512 이상을 요구합니다.
test("앱 아이콘은 Ἀ 기반이고 macOS 최소 크기(512)를 충족한다", () => {
  const readPng = (file) => {
    const png = fs.readFileSync(path.join(ROOT, file));
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      file + "는 PNG여야 합니다"
    );
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  };
  for (const file of ["build/icon-mac.png", "build/icon.png"]) {
    const { width, height } = readPng(file);
    assert.ok(width >= 512 && height >= 512, file + "는 512x512 이상이어야 합니다 (현재 " + width + "x" + height + ")");
  }
  // 아이콘은 생성 스크립트로 재현 가능해야 합니다(수작업 바이너리 금지).
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/make-icons.ps1")));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/make-icons.js")));
  // CodePet 캐릭터 프리뷰 에셋은 남아 있지 않습니다.
  assert.ok(!fs.existsSync(path.join(ROOT, "build/icon-preview.png")));
});

test("프로젝트 아래에 여러 대화를 묶는 화면과 IPC 연결이 있다", () => {
  const html = read("src/chat.html");
  const preload = read("src/chat-preload.js");
  const renderer = read("src/chat.js");
  const ipc = read("src/chat/chat-ipc.js");

  for (const id of ["project-list", "btn-new-project"]) {
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
  // 백그라운드 모델 목록 갱신은 main이 밀어 주고 renderer가 받아 새로 그린다.
  assert.match(preload, /onProviders: \(handler\) => subscribe\("chat:providers", handler\)/);
  assert.match(renderer, /window\.chatApi\.onProviders\?\.\(\(payload\) => \{[\s\S]*?providers = payload\.providers;[\s\S]*?renderHeader\(\);/);
  assert.match(renderer, /payload\.modelsChanged[\s\S]*?flashNotice\("모델 목록을 새로 불러왔습니다/);
  assert.match(preload, /projectsCreate: \(name, workspace\)/);
  assert.match(preload, /projectsSelect: \(projectId\)/);
  assert.match(preload, /projectsUpdate: \(projectId, patch\)/);
  assert.match(preload, /projectsDelete: \(projectId\)/);
  assert.match(preload, /sessionsMove: \(sessionId, projectId\)/);
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
  assert.match(renderer, /sessionsMove\(session\.id, project\.id\)/);
  assert.doesNotMatch(renderer, /project-move-apply-workspace/);
  assert.match(renderer, /전문 모드 역할 설정/);
  assert.match(renderer, /기획 검수 \(선택\)/);
  assert.match(renderer, /runProfessionalAction\(action\)/);
  assert.match(renderer, /planAutoRevisions/);
  assert.match(renderer, /implementationAutoRevisions/);
  assert.match(renderer, /payload\.model \|\| agent\?\.model/);
  assert.match(html, /role="switch"/);
  assert.match(renderer, /function openPlanPreview\(anchor\)/);
  assert.match(renderer, /누적 요약/);
  assert.doesNotMatch(ipc, /applyProjectWorkspace = false/);
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
  assert.match(renderer, /for \(const header of headers\)/);
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

test("토론 종료 알림은 결론 종합 버튼을 제공하고 토론 종합 배지 스타일이 정의되어 있다", () => {
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");
  assert.match(renderer, /openDiscussionSummaryPopover/);
  assert.match(renderer, /discussion-summary-button/);
  assert.match(renderer, /role-discussion-summary/);
  assert.match(css, /\.role-badge\.role-discussion-summary/);
  assert.match(css, /\.discussion-summary-button/);
});

// 승인 이후 단계(입력 재대조, 검증 계획 검사 등)에서 거부되면 run은 READY:WAITING에
// 머무는데, 예전에는 그 상태에서 PLAN 버튼이 꺼져 있어 같은 실행 버튼을 반복해서
// 누르는 것 말고 길이 없었다. READY는 Builder가 돌기 전이라 되돌릴 것이 없고
// FSM도 READY -> PLANNING 복귀를 지원하므로 다시 기획할 수 있어야 한다.
test("승인 상태(READY)에서도 기획을 처음부터 다시 시작할 수 있다", () => {
  const renderer = read("src/chat.js");
  const line = renderer.slice(renderer.indexOf("const planStartable"));
  const decl = line.slice(0, line.indexOf(";"));
  assert.ok(decl.includes('specialistNode === "READY"'), "READY에서 PLAN을 다시 시작할 수 있어야 합니다");
  // 사용자를 기다리는 상태(BLOCKED·답변 대기)에서도 다시 시작할 수 있어야 한다.
  assert.ok(decl.includes("awaitingUser"), "대기 상태에서도 새 기획을 시작할 수 있어야 합니다");
  // 실행 중에는 여전히 막혀야 한다(리셋 통로가 진행 중 실행을 덮어쓰면 안 된다).
  assert.ok(
    renderer.includes("professionalPlanButton.disabled = !planConfigured || specialistBusy || !planStartable"),
    "진행 중 실행은 여전히 막아야 합니다"
  );
  // "바쁨"과 "대기"가 다시 한 값으로 합쳐지면 같은 결함이 되살아난다.
  assert.ok(renderer.includes("const specialistBusy = Boolean(specialistRunning || specialistActive || ordinaryTurnBusy)"));
  assert.ok(renderer.includes("const awaitingUser = Boolean(specialistBlockedAvailable || specialistResumeAvailable)"));
  // 되돌릴 수 없는 폐기이므로 확인을 받는다.
  assert.ok(renderer.includes("기획부터 다시 시작할까요"), "폐기 전에 확인해야 합니다");
});

// checkpoint 실패는 사용자가 골라야 진행된다. 백엔드(resumeSpecialist)는 예전부터
// retry / proceed_unprotected를 처리했지만 화면에 버튼이 없고 preload가 action을
// 전달하지도 않아서, composer가 "선택 대기"로 잠긴 채 고를 방법이 없었다.
test("사용자가 골라야 진행되는 지점에는 실제 선택 버튼이 있다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const preload = read("src/chat-preload.js");
  assert.match(html, /id="specialist-choice-bar"/);
  assert.ok(renderer.includes("CHECKPOINT_FAILED: ["), "checkpoint 실패 선택지가 정의되어야 합니다");
  for (const action of ["retry", "proceed_unprotected"]) {
    assert.ok(renderer.includes(`"${action}"`), `${action} 선택지가 있어야 합니다`);
  }
  assert.ok(renderer.includes("specialistCancel(activeSessionId)"), "취소 선택지가 있어야 합니다");
  // composer를 잠그는 곳에서 반드시 선택지도 함께 그린다(잠금과 선택지는 한 쌍이다).
  assert.ok(renderer.includes("renderSpecialistChoice();"), "잠금과 함께 선택지를 그려야 합니다");
  // BLOCKED도 composer를 잠그고 "아래에서 선택해 주세요"라고 안내한다. 선택지가
  // 헤더 모드 토글 뒤 모달에만 있으면 안내와 위치가 정반대가 된다.
  assert.ok(renderer.includes("if (specialistBlockedAvailable) {"), "BLOCKED에도 선택 경로가 있어야 합니다");
  const blockedBranch = renderer.slice(renderer.indexOf("function specialistChoicesNow"));
  assert.ok(
    blockedBranch.slice(0, 600).includes("openSpecialistDialog()"),
    "BLOCKED 선택지는 기존 모달로 이어져야 합니다"
  );
  // preload가 action을 넘기지 않으면 어떤 버튼도 의미가 없다.
  assert.match(preload, /SPECIALIST_RESUME, \{ sessionId, action \}/);
});

// professionalModeEnabled는 화면 로컬 값이라 토글을 눌러야만 바뀌었다. 그래서
// BLOCKED 모달에서 재기획을 시작하거나 앱을 다시 열어 실행이 복원되면, 실행은
// 돌아가는데 화면은 일반 모드에 머물러 PLAN·실행 버튼이 보이지 않았다.
test("살아 있는 전문 실행은 조작 버튼을 스스로 드러낸다", () => {
  const renderer = read("src/chat.js");
  const setter = renderer.slice(renderer.indexOf("function setSpecialistState"));
  const body = setter.slice(0, setter.indexOf("\nfunction "));
  assert.ok(body.includes("professionalModeEnabled = true"), "실행이 살아나면 켜져야 합니다");
  assert.ok(
    body.includes('specialistNode === "COMPLETED" && specialistStatus === "COMPLETED"'),
    "끝난 실행까지 켜지 않아야 합니다"
  );
  // **살아나는 순간에만** 켠다. 매 이벤트마다 켜면 사용자가 내린 토글을 계속
  // 덮어써, 실행 중에 일반 대화로 빠져나가 기획자에게 말할 수가 없어진다.
  assert.ok(
    body.includes("if (runLive && !professionalRunWasLive) professionalModeEnabled = true;"),
    "전이 시점에만 켜야 사용자의 토글이 유지됩니다"
  );
  assert.ok(body.includes("professionalRunWasLive = runLive;"), "직전 상태를 기억해야 합니다");
  // 끄지는 않는다 — 숨기는 것은 사용자의 선택으로 남긴다.
  assert.ok(!body.includes("professionalModeEnabled = false"), "자동으로 끄면 사용자의 선택을 덮습니다");
});

// "실행 중 → 일반 모드 → 메모"가 계약인데, 토글이 실행 중에 잠기고 입력창도
// specialistActive면 닫혀 그 경로에 도달할 수가 없었다. 토글은 표시·라우팅만
// 바꾸고 실행 상태는 건드리지 않으므로 실행 중에도 열려 있어야 한다.
test("실행 중에도 일반 모드로 내려 메모를 남길 수 있다", () => {
  const renderer = read("src/chat.js");
  // 토글은 세션 유무로만 막는다.
  assert.ok(
    renderer.includes("specialistButton.disabled = !activeSessionId;"),
    "실행 중이라고 모드 토글을 잠그면 메모 경로에 도달할 수 없습니다"
  );
  assert.ok(
    renderer.includes('specialistButton.addEventListener("click", () => {\n  if (!activeSessionId) return;'),
    "클릭 가드도 실행 중을 막으면 안 됩니다"
  );
  // 일반 모드면 실행 중에도 입력창이 열린다.
  assert.ok(
    renderer.includes("if (!professionalModeEnabled) return false;"),
    "일반 모드에서는 실행 중에도 메모를 남길 수 있어야 합니다"
  );
});

// 레일 라벨을 HTML에만 박으면 참가자 이름을 바꿀 때 provider-capabilities와
// chat.html이 어긋난다. 이름을 받으면 renderAgents가 덮어쓰고, HTML 값은 첫 페인트용
// 기본값으로만 남는다.
test("레일 라벨은 참가자 이름에서 채워지고 HTML은 기본값만 갖는다", () => {
  const renderer = read("src/chat.js");
  const html = read("src/chat.html");
  assert.ok(renderer.includes("function renderRailLabels()"), "레일 라벨 갱신 함수가 있어야 합니다");
  // 호출부 4곳에 흩지 않고 renderAgents 안에서 한 번에 맞춘다.
  assert.match(renderer, /function renderAgents\(\) \{\s*\n\s*renderRailLabels\(\);/);
  // 첫 페인트 기본값도 새 이름이어야 잠깐 옛 이름이 보이지 않는다.
  assert.ok(html.includes('<span class="app-rail-label">GPT</span>'), "레일 기본값이 옛 이름입니다");
  assert.ok(html.includes('<span class="app-rail-label">Gemini</span>'), "레일 기본값이 옛 이름입니다");
  assert.ok(!html.includes('<span class="app-rail-label">Codex</span>'));
  assert.ok(!html.includes('<span class="app-rail-label">AGY</span>'));
});

// ---- 전문 실행 상태 표시: node만이 아니라 status와 대기 사유까지 본다 ----
//
// 아래 테스트는 문자열 존재 확인이 아니라 실제 판정 함수를 실행한다. 렌더러는
// DOM 스크립트라 통째로 불러올 수 없으므로, 상태 판정 부분만 떼어 내 격리된
// 컨텍스트에서 돌린다(그 부분은 모듈 전역 상태만 읽는 순수 함수다).
function loadSpecialistView(state = {}) {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const start = src.indexOf("const PROFESSIONAL_STEPS = Object.freeze([");
  const end = src.indexOf("function renderProfessionalStatusDetail(");
  assert.ok(start > 0 && end > start, "상태 판정 코드를 찾지 못했습니다");
  const context = {
    specialistNode: null,
    specialistStatus: null,
    specialistStopReason: null,
    specialistMissingSections: null,
    specialistBlockedAvailable: false,
    specialistResumePhase: null,
    specialistPendingApprovals: [],
    ...state,
  };
  context.awaitingHumanApproval = () =>
    context.specialistStopReason === "HUMAN_APPROVAL_REQUIRED"
    || context.specialistResumePhase === "awaiting_human_approval";
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  return {
    progress: context.specialistProgressView(),
    status: context.specialistStatusView(),
    steps: context.PROFESSIONAL_STEPS,
  };
}

test("READY는 기획검수 진행 중이 아니라 '검수 통과·실행 대기'로 보인다", () => {
  const { progress, status } = loadSpecialistView({ specialistNode: "READY", specialistStatus: "WAITING" });
  // 기획과 기획검수는 끝났다. 강조는 아직 시작하지 않은 구현으로 간다.
  assert.equal(progress.completeThrough, 1);
  assert.equal(progress.highlight, 2);
  assert.equal(progress.tone, "waiting");
  assert.match(status.headline, /기획 검수를 통과했습니다/);
  assert.match(status.next, /실행/);
});

test("COMPLETED는 기록 단계가 계속 돌고 있는 것처럼 보이지 않는다", () => {
  const { progress, status } = loadSpecialistView({ specialistNode: "COMPLETED", specialistStatus: "COMPLETED" });
  assert.equal(progress.completeThrough, 4, "다섯 단계 모두 끝난 것으로 표시합니다");
  assert.equal(progress.highlight, -1, "완료 뒤에는 진행 중인 단계가 없습니다");
  assert.equal(progress.tone, "done");
  assert.match(status.headline, /완료/);
});

test("완료 뒤 기록 정리(Archivist) 중지는 본 실행의 완료를 뒤집지 않는다", () => {
  const { progress, status } = loadSpecialistView({
    specialistNode: "COMPLETED",
    specialistStatus: "COMPLETED",
    specialistStopReason: "USER_INTERRUPTED",
  });
  assert.equal(progress.tone, "done");
  assert.match(status.headline, /본 실행이 완료되었습니다/);
  assert.match(status.headline, /기록 정리는 중지/);
});

test("중단과 실행 중은 다른 상태로 표시된다", () => {
  const running = loadSpecialistView({ specialistNode: "IMPLEMENTING", specialistStatus: "RUNNING" });
  const stopped = loadSpecialistView({
    specialistNode: "IMPLEMENTING",
    specialistStatus: "INTERRUPTED",
    specialistStopReason: "USER_INTERRUPTED",
  });
  assert.equal(running.progress.tone, "running");
  assert.match(running.status.headline, /구현 진행 중/);
  assert.equal(stopped.progress.tone, "stopped");
  assert.match(stopped.status.headline, /중지|중단/);
  assert.match(stopped.status.next, /다시 시작/);
});

test("멈춤 사유는 내부 코드가 아니라 사용자 문장으로 보여 준다", () => {
  for (const [stopReason, expected] of [
    ["PLAN_READY", /기획 검수를 통과/],
    ["HUMAN_APPROVAL_REQUIRED", /확인할 항목/],
    ["RECORDER_FAILED", /기록을 만들지 못했습니다/],
    ["CHECKPOINT_FAILED", /백업을 만들지 못했습니다/],
    ["LIMIT_EXCEEDED", /자동 보완 한도/],
  ]) {
    const { status } = loadSpecialistView({
      specialistNode: "REVIEWING",
      specialistStatus: "WAITING",
      specialistStopReason: stopReason,
      specialistPendingApprovals: stopReason === "HUMAN_APPROVAL_REQUIRED" ? [{ criterionId: "V2" }] : [],
    });
    assert.match(status.headline, expected, `${stopReason}는 사용자 문장으로 옮겨야 합니다`);
    assert.ok(!status.headline.includes(stopReason), `${stopReason} 코드를 그대로 노출하면 안 됩니다`);
  }
});

test("모르는 멈춤 사유를 완료나 복원 가능으로 포장하지 않는다", () => {
  const { status } = loadSpecialistView({
    specialistNode: "REVIEWING",
    specialistStatus: "WAITING",
    specialistStopReason: "SOME_NEW_REASON",
  });
  assert.match(status.headline, /확인이 필요한 상태/);
  assert.ok(!/완료|복원할 수 있|되돌릴 수 있/.test(status.headline));
  assert.match(status.next, /자세히/);
});

test("BLOCKED는 막힌 이유와 다음 선택을 함께 안내한다", () => {
  const { progress, status } = loadSpecialistView({
    specialistNode: "IMPLEMENTING",
    specialistStatus: "BLOCKED",
    specialistStopReason: "BLOCKED",
    specialistBlockedAvailable: true,
  });
  assert.equal(progress.tone, "blocked");
  assert.match(status.headline, /막혀/);
  assert.match(status.next, /다음 처리 선택/);
});

// ---- 완료 전 사용자 확인(HUMAN_APPROVAL) ----
//
// 백엔드는 이 대기를 REVIEWING/WAITING + HUMAN_APPROVAL_REQUIRED로 두고, 검수자가
// 대신 해소할 수 없게 막아 둔다. 화면에 승인/거부 경로가 없으면 실행이 영영
// 대기에 남는다 — IPC와 preload에만 있고 렌더러에서 부르지 않던 상태였다.
test("승인 대기 항목을 화면에서 보고 승인·거부할 수 있다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  assert.match(html, /id="specialist-approvals"/);
  assert.match(renderer, /window\.chatApi\.specialistPendingApprovals\(sessionId\)/);
  assert.match(renderer, /window\.chatApi\.specialistResolveApproval\(sessionId, criterionId, approved, null\)/);
  // 항목 본문과 사람이 필요한 이유를 함께 보여 준다.
  assert.match(renderer, /item\.statement \|\| item\.criterionId/);
  assert.match(renderer, /사용자 확인이 필요한 이유/);
  // 중복 제출 방지.
  assert.match(renderer, /specialistApprovalsInFlight\.has\(criterionId\)/);
  assert.match(renderer, /button\.disabled = busy/);
  // 응답 뒤에는 백엔드가 준 최신 목록과 상태를 그대로 반영한다.
  assert.match(renderer, /specialistPendingApprovals = Array\.isArray\(result\.pending\)/);
  assert.match(renderer, /if \(result\.specialist\) setSpecialistState\(result\.specialist\)/);
  // 승인되지 않았는데 화면만 넘어가지 않도록, 재개는 백엔드 판단(resumable)에 맡긴다.
  assert.match(renderer, /if \(result\.resumable && specialistPendingApprovals\.length === 0\)/);
  // 세션을 바꾼 뒤 늦게 온 응답이 지금 화면을 덮지 않는다.
  assert.match(renderer, /if \(sessionId !== activeSessionId\) return;/);
  // 승인 대기 중 입력창은 "실행이 끝난 뒤"가 아니라 무엇을 기다리는지 알려 준다.
  assert.match(renderer, /awaitingHumanApproval\(\)[\s\S]{0,400}아래에서 확인 항목을 승인하거나 거부해 주세요/);
});

// ---- 복원 가능 여부와 복원 조작 ----
//
// specialistBlockDetails()는 canRestore를 돌려주는데 화면이 쓰지 않아, 복원할 수
// 없는 실행에서도 복원 버튼이 살아 있었다. 누르면 백엔드가 거부하거나(종결 경로)
// 아무것도 복원하지 않은 채 재기획만 됐다(재기획 경로).
test("복원 조작은 백엔드의 canRestore를 따른다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /renderBlockedActions\(specialistBody, details\)/);
  assert.match(renderer, /function renderBlockedActions\(root, details = null\)/);
  assert.match(renderer, /const canRestore = Boolean\(details\?\.canRestore\)/);
  assert.match(renderer, /replanRestoreBtn\.disabled = !canRestore/);
  // 종결 경로(복원·폐기)도 같은 근거로 잠근다.
  assert.match(renderer, /el\.disabled = Boolean\(option\.needsRestore\) && !canRestore/);
  // 왜 못 하는지 설명한다.
  assert.match(renderer, /작업 전 백업이 없어 되돌릴 수 없습니다/);
  // 변경 유지 경로는 계속 쓸 수 있어야 한다.
  const blocked = renderer.slice(renderer.indexOf("function renderBlockedActions"));
  assert.ok(!/replanKeepBtn\.disabled/.test(blocked.slice(0, 2000)), "변경 유지는 항상 열려 있어야 합니다");
  // 처리에 실패하면 선택창만 사라지지 않고 다시 열린다.
  assert.match(renderer, /if \(!result\) \{\s*\/\/[^\n]*\n\s*openSpecialistDialog\(\);/);
});

// ---- 모드 전환과 입력창 ----
test("모드 토글은 라벨대로 전환만 하고 입력창을 함께 갱신한다", () => {
  const renderer = read("src/chat.js");
  const handler = renderer.slice(renderer.indexOf('specialistButton.addEventListener("click"'));
  const body = handler.slice(0, handler.indexOf("});"));
  // 예전에는 BLOCKED일 때만 몰래 막힘 모달을 열어 라벨과 동작이 어긋났다.
  assert.ok(!body.includes("openSpecialistDialog()"), "토글은 전환만 합니다");
  assert.ok(body.includes("professionalModeEnabled = !professionalModeEnabled"), "전환은 그대로 유지합니다");
  assert.ok(body.includes("syncComposerLock()"), "전환 직후 입력창 잠금·문구를 갱신해야 합니다");
  // 실행을 취소하거나 상태를 초기화하지 않는다.
  assert.ok(!/specialistCancel|setSpecialistState/.test(body), "전환이 실행 상태를 건드리면 안 됩니다");
  // 막힘 처리는 입력창 위 '다음 처리 선택'이 전담한다(두 모드 모두에서 보인다).
  const choices = renderer.slice(renderer.indexOf("function specialistChoicesNow"));
  assert.ok(choices.slice(0, 600).includes("openSpecialistDialog()"));
});

// ---- 버튼 활성 조건이 백엔드 조건과 같은가 ----
test("기획 검수를 통과하면 '실행 ▶'이 실제로 눌린다", () => {
  const renderer = read("src/chat.js");
  const decl = renderer.slice(renderer.indexOf("const canStartImplementation"));
  const expr = decl.slice(0, decl.indexOf(";"));
  // READY에는 승인 대기 resume이 늘 있으므로 awaitingUser로 막으면 영영 꺼져 있다.
  assert.ok(!expr.includes("blockedOrBusy"), "READY의 승인 대기를 '바쁨'으로 세면 안 됩니다");
  assert.ok(!expr.includes("awaitingUser"), "READY의 승인 대기를 '바쁨'으로 세면 안 됩니다");
  for (const needed of ["implementationConfigured", "specialistPlanReady", "!specialistBusy", "!specialistBlockedAvailable", "!awaitingAnswer"]) {
    assert.ok(expr.includes(needed), `${needed} 조건이 있어야 합니다`);
  }
  assert.match(renderer, /professionalImplementationButton\.disabled = !canStartImplementation/);
  // 강조와 활성 조건이 갈라지면 "빛나는데 눌리지 않는" 버튼이 생긴다.
  assert.match(renderer, /const nextIsImplementation = canStartImplementation/);
  // 기록 다시 생성도 대기 상태(RECORDING/WAITING)에서 눌려야 한다.
  assert.match(
    renderer,
    /professionalRecordButton\.disabled = !recorder\.agentId \|\| specialistBusy \|\| specialistBlockedAvailable/
  );
});

test("기록이 실패해 멈춘 상태는 기록 단계에서 기다리는 것으로 보인다", () => {
  const { progress, status } = loadSpecialistView({
    specialistNode: "RECORDING",
    specialistStatus: "WAITING",
    specialistStopReason: "RECORDER_FAILED",
  });
  assert.equal(progress.highlight, 4, "기록 단계를 가리켜야 합니다");
  assert.equal(progress.tone, "waiting");
  assert.equal(progress.completeThrough, 3, "구현 검수까지는 끝난 상태입니다");
  assert.match(status.next, /기록 다시 생성/);
});

test("승인 대기는 남은 항목 수와 할 일을 함께 알려 준다", () => {
  const { status } = loadSpecialistView({
    specialistNode: "REVIEWING",
    specialistStatus: "WAITING",
    specialistStopReason: "HUMAN_APPROVAL_REQUIRED",
    specialistResumePhase: "awaiting_human_approval",
    specialistPendingApprovals: [{ criterionId: "V2" }, { criterionId: "V3" }],
  });
  assert.match(status.headline, /2건/);
  assert.match(status.next, /승인하거나 거부/);
});
