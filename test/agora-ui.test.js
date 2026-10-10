const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

// 답변 대기 ×는 렌더러 → preload → IPC → 방으로 이어진다. 채널 이름이 한 곳이라도
// 어긋나면 버튼이 조용히 아무 일도 하지 않으므로 소스에서 맞춰 본다.
test("답변 대기 × 버튼의 IPC 채널이 preload·main·렌더러에서 일치한다", () => {
  const preload = read("src/chat-preload.js");
  const ipc = read("src/chat/chat-ipc.js");
  const renderer = read("src/chat.js");
  const view = read("src/awaiting-view.js");
  assert.match(preload, /AWAITING_DISMISS: "chat:awaiting:dismiss"/);
  assert.match(
    preload,
    /awaitingDismiss: \(sessionId, agentId\) =>\s*ipcRenderer\.invoke\(INVOKE\.AWAITING_DISMISS, \{ sessionId, agentId \}\)/
  );
  assert.match(ipc, /ipcMain\.handle\(\s*"chat:awaiting:dismiss"[\s\S]*?clearAwaitingUser\(/);
  assert.match(renderer, /chatApi\.awaitingDismiss\(activeSessionId, agentId\)/);
  assert.match(renderer, /onDismiss: dismissAwaitingAgent/);
  assert.match(view, /className = "awaiting-dismiss"/);
});

// 설정 '답변 대기 표시'를 끄면 채팅 화면은 대기 바와 칩의 대기 점을 그리지 않는다.
// 상태는 방이 계속 갖고 있으므로 다시 켜면 그대로 보인다.
test("채팅 화면은 appearance.showAwaiting으로 답변 대기 표시를 끄고 켠다", () => {
  const renderer = read("src/chat.js");
  assert.match(renderer, /let showAwaiting = true;/);
  assert.match(renderer, /const nextShowAwaiting = appearance\?\.showAwaiting !== false;[\s\S]*?renderAgents\(\);/);
  assert.match(renderer, /const awaiting = showAwaiting && Boolean\(agent\.awaitingUser\);/);
  assert.match(renderer, /agents: showAwaiting \? agents : \[\],/);
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

test("중복 실행이면 quit 이후 채팅 기능도 트레이도 세우지 않는다", () => {
  const vm = require("node:vm");
  const Module = require("node:module");
  const filename = path.join(ROOT, "src", "main.js");
  let quits = 0;
  const unexpected = () => { throw new Error("중복 인스턴스가 초기화를 계속했습니다"); };
  const fakeRequire = (id) => {
    if (id === "electron") {
      return { app: {
        setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false,
        quit: () => { quits += 1; }, on: unexpected, whenReady: unexpected,
        getPath: unexpected, commandLine: { appendSwitch: unexpected },
      } };
    }
    if (id === "./chat/chat-ipc") return { createChatFeature: unexpected };
    if (id === "./agora/account-switching") return { createAccountSwitching: unexpected };
    if (id.startsWith("node:")) return require(id);
    return {};
  };
  const entry = new vm.Script(Module.wrap(read("src/main.js")), { filename })
    .runInNewContext({ console, process: { platform: "win32", argv: ["electron", "."], env: {}, on() {} } });
  entry({}, fakeRequire, { exports: {} }, filename, path.dirname(filename));
  assert.equal(quits, 1);
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
  // 행의 +와 목록의 '새 채팅' 줄, Ctrl/⌘+N은 모두 한 곳(createChatIn)을 거쳐
  // 그 프로젝트에 세션을 만들고 입력창에 포커스를 준다.
  assert.match(renderer, /createChatIn\(project\.id\)/);
  assert.match(renderer, /sessionsCreate\(projectId\)/);
  // 새 채팅 입구는 프로젝트 행의 + 하나다. 목록 맨 위의 같은 동작 줄은 없앴다.
  assert.doesNotMatch(renderer, /project-new-chat/);
  assert.doesNotMatch(read("src/chat.css"), /project-new-chat/);
  // 선택된 채팅이 접힌 프로젝트 안에 숨지 않도록 항상 드러냅니다.
  assert.match(renderer, /function revealActiveSession/);
  // 백엔드는 프로젝트별 세션 목록을 내려주고, 새 채팅은 대상 프로젝트를 지정할 수 있습니다.
  assert.match(ipc, /sessionsByProject: sessionsByProjectPayload\(\)/);
  assert.match(ipc, /createSessionForProject\(projectId \? requireProject\(projectId\)\.id : undefined\)/);
});

// 접기 버튼이 사이드바와 대화 사이 경계선 위에 떠 있으면 목록을 가리고, 접었을 때
// 창 왼쪽 끝에 반쯤 잘렸다. 접기는 사이드바 머리줄에, 펼치기는 대화 제목 앞에 둔다.
test("사이드바 접기는 머리줄에, 펼치기는 대화 제목 앞에 있다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");
  const head = html.slice(html.indexOf('class="sidebar-head"'), html.indexOf('id="project-list"'));
  assert.match(head, /id="sidebar-toggle"/, "접기 버튼은 사이드바 머리줄에 있어야 합니다");
  const resizer = html.slice(html.indexOf('id="sidebar-resizer"'), html.indexOf('class="chat-main"'));
  assert.doesNotMatch(resizer, /<button/, "경계선 손잡이 안에 버튼을 두지 않습니다");
  assert.match(html, /class="room-info">\s*<button\s+class="sidebar-open"\s+id="sidebar-open"[^>]*hidden/);
  const setter = renderer.slice(renderer.indexOf("function setSidebarCollapsed"));
  const body = setter.slice(0, setter.indexOf("\n}\n"));
  // 접힌 사이드바는 폭만 0이라 inert로 막지 않으면 Tab이 보이지 않는 버튼으로 들어간다.
  assert.match(body, /sidebarEl\.inert = collapsed/);
  assert.match(body, /sidebarOpenButton\.hidden = !collapsed/);
  assert.match(css, /\.app\.is-sidebar-collapsed \.sidebar-resizer \{\s*display: none;/);
});

// 하단은 사용량 · 환경 진단 · 설정이 같은 아이콘 칸과 이름 칸을 쓰는 세로 목록이다.
// 예전에는 가운데 정렬 버튼 셋이 한 줄에 끼어 위 "사용량"과 왼쪽 끝선이 어긋났다.
test("사이드바 하단은 아이콘·이름 칸이 맞는 세로 목록이다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  const foot = html.slice(html.indexOf('class="sidebar-foot"'), html.indexOf("</aside>"));
  for (const id of ["btn-usage-fold", "btn-doctor", "btn-settings"]) {
    const start = foot.indexOf(`id="${id}"`);
    const button = foot.slice(start, foot.indexOf("</button>", start));
    assert.match(button, /class="foot-icon"/, `${id}에 아이콘 칸이 있어야 합니다`);
    assert.match(button, /class="foot-label"/, `${id}에 이름 칸이 있어야 합니다`);
  }
  // 재탐지는 진단 줄 끝 칸의 아이콘 버튼이라 이름은 aria-label이 맡고, 도는 동안 aria-busy다.
  assert.match(foot, /class="foot-action" id="btn-refresh-providers"[^>]*aria-label="CLI 다시 탐지"/);
  assert.match(renderer, /refreshProvidersButton\.setAttribute\("aria-busy", "true"\)/);
});

// 배지·버튼 문구의 이모지(📊 📋 🗂 💡 ⚡ ⚠ 📄 📦)는 같은 줄의 다른 배지와 크기·색이
// 맞지 않아 눈에 거슬렸고, 파일 아이콘 두 가지로는 PDF와 ZIP도 구분되지 않았다.
test("메시지 배지·버튼 문구에 이모지를 쓰지 않는다", () => {
  const renderer = read("src/chat.js");
  assert.doesNotMatch(renderer, /textContent = [`"'][^`"'\n]*(📊|📋|🗂|💡|⚡|⚠|📄|📦|\\u\{1F4A1\})/u);
  assert.match(renderer, /extension\.toUpperCase\(\)/, "첨부는 확장자로 표시합니다");
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

test("자동 승인은 패널에서 명시적으로 확인한 뒤에만 저장한다", async () => {
  const source = read("src/chat.js");
  const start = source.indexOf('    const autoApproveToggle = document.createElement("input");');
  const end = source.indexOf('\n    if (provider.status === "gui-only"', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  function element() {
    return { hidden: false, append() {}, focus() {}, addEventListener(type, handler) { this[type] = handler; } };
  }
  const context = vm.createContext({
    document: { createElement: element }, root: element(), makeField: () => element(),
    agent: { name: "Claude" }, agentId: "claude", provider: { available: true },
    config: { autoApprove: true }, sessionMeta: { permissionMode: "workspace-write" }, activeSessionId: "session-a",
    configureAgent: async (id, patch) => { calls.push(patch.autoApprove); return { meta: {} }; },
    window: { confirm() { throw new Error("Native confirm must not open"); } },
  });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext('autoApproveToggle.checked = false; autoApproveToggle.change()', context);
  assert.deepEqual(calls, [false]);
  vm.runInContext('autoApproveToggle.checked = true; autoApproveToggle.change()', context);
  assert.equal(vm.runInContext('autoApproveToggle.checked', context), false);
  assert.equal(vm.runInContext('autoApproveConfirmation.hidden', context), false);
  assert.deepEqual(calls, [false]);
  vm.runInContext('cancelAutoApprove.click()', context);
  assert.equal(vm.runInContext('autoApproveConfirmation.hidden', context), true);
  assert.deepEqual(calls, [false]);
  vm.runInContext('autoApproveToggle.checked = true; autoApproveToggle.change()', context);
  await vm.runInContext('confirmAutoApprove.click()', context);
  assert.deepEqual(calls, [false, true]);
  assert.equal(vm.runInContext('autoApproveToggle.checked', context), true);
  vm.runInContext('activeSessionId = "session-b"', context);
  await vm.runInContext('saveAutoApprove(false)', context);
  assert.deepEqual(calls, [false, true]);
});

test("모델 설정을 닫는 첫 클릭이 입력칸에 그대로 전달된다", () => {
  const renderer = read("src/chat.js");
  const css = read("src/chat.css");
  assert.match(css, /\.popover-backdrop\.is-pass-through\s*\{\s*pointer-events:\s*none;/);
  const agentPopover = renderer.slice(renderer.indexOf("function openAgentPopover("), renderer.indexOf("async function configureAgent("));
  assert.match(agentPopover, /root\.classList\.add\("is-agent"\);[\s\S]*?popoverBackdrop\.classList\.add\("is-pass-through"\);/);

  const start = renderer.indexOf('document.addEventListener("pointerdown", (event) => {');
  const end = renderer.indexOf('\nwindow.addEventListener("keydown"', start);
  assert.ok(start >= 0 && end > start);
  let onPointerDown;
  let closed = 0;
  let blurred = 0;
  const composerInput = { blur() { blurred++; } };
  const popover = {
    hidden: false,
    classList: { contains: (name) => name === "is-agent" },
    contains: (target) => target === popover,
  };
  const document = {
    activeElement: composerInput,
    addEventListener(type, handler, capture) {
      assert.equal(type, "pointerdown");
      assert.equal(capture, true);
      onPointerDown = handler;
    },
  };
  vm.runInNewContext(renderer.slice(start, end), {
    document, popover, composerInput, closePopover: () => { closed++; },
  });
  onPointerDown({ target: popover });
  assert.equal(closed, 0);
  onPointerDown({ target: composerInput });
  assert.equal(closed, 1);
  assert.equal(blurred, 1);
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
  // 이름보다 부차 정보가 먼저 물러난다. 예전 shrink 계수(flex: 0 100 auto)는 이름도
  // 1px 미만으로 함께 줄여 자리가 넉넉한데도 이름 끝이 말줄임됐다. 폴더명은 basis 0이라
  // 이름을 다 쓰고 남는 자리만 받고, 최소 폭도 못 받으면 둘째 줄로 넘어가 가려진다.
  assert.match(css, /\.project-meta \{[^}]*flex: 1 1 0/, "폴더명은 이름이 쓰고 남는 자리만 받아야 합니다");
  assert.match(css, /\.project-select \{[^}]*flex-wrap: wrap[^}]*overflow: hidden/, "자리가 모자라면 폴더명은 가려져야 합니다");
  // 채팅 시각("방금")은 짧아서 자르면 읽을 수 없으니 줄이지 않고, 제목이 먼저 말줄임된다.
  assert.match(css, /\.session-meta \{[^}]*flex: none/, "채팅 시각은 줄지 않아야 합니다");
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

test("사용량 스트립은 접기/펼치기이고 접힌 동안 조회하지 않는다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  assert.match(html, /id="btn-usage-fold"/);
  assert.match(html, /id="btn-usage"[^>]*hidden/);
  assert.match(renderer, /agora\.chat\.usageOpen/);
  assert.match(renderer, /if \(usageOpen\) void loadUsage\(\)/);
  assert.match(renderer, /if \(usageOpen \|\| usagePopoverOpen\) void refreshUsageIfStale\(\)/);
});

// 모델·추론 설정 진입점은 대화방 참가자 칩 하나다. 예전에는 왼쪽 세로 레일에도
// 같은 팝오버를 여는 버튼이 있었는데, 68px를 아이콘 세 개에 쓰면서 대화 폭을
// 깎았고 같은 기능의 입구가 둘이라 어느 쪽이 정본인지도 흐렸다.
test("모델 설정 진입점은 대화방 참가자 칩 하나다", () => {
  const html = read("src/chat.html");
  const renderer = read("src/chat.js");
  // 세로 레일의 흔적이 마크업·렌더러 어디에도 남지 않아야 한다.
  assert.doesNotMatch(html, /app-rail|id="rail-/);
  assert.doesNotMatch(renderer, /railAgentButtons|renderRailLabels|setRailActive|openRailAgentSettings/);
  // 칩이 유일한 입구다.
  assert.match(html, /id="agent-chips"/);
  assert.match(renderer, /chip\.addEventListener\("click", \(\) => openAgentPopover\(chip, agent\.id\)\)/);
  // 앱 설정은 사이드바 하단 버튼 하나만 남는다(레일 버튼이 이것을 대신 눌렀었다).
  assert.match(html, /id="btn-settings"/);
});

test("Agora 채팅 화면은 기능 라벨을 간결하게 유지한다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");
  assert.doesNotMatch(html, /HUMAN-LED WORKSPACE|DISCUSSION ROOM|MESSAGE THE ROOM|AGORA DOCTOR/);
  assert.match(html, /id="btn-settings"/);
  assert.match(css, /\.titlebar-btn\.btn-settings[\s\S]*?width: 52px/);
  assert.match(css, /\.titlebar-btn\.btn-settings svg[\s\S]*?width: 16px/);
});

test("작업공간은 창 전체를 쓰고 상단 줄은 역할별로 한 줄씩 쌓인다", () => {
  const html = read("src/chat.html");
  const css = read("src/chat.css");
  const renderer = read("src/chat.js");
  assert.match(html, /class="workspace-shell"[^>]*>[\s\S]*id="sidebar"[\s\S]*id="chat-scroll"/);
  // 레일을 걷어낸 뒤로 강조색 테두리는 창 가장자리 파란 선으로만 남았다.
  assert.match(css, /\.workspace-shell \{[^}]*margin: 0/);
  assert.match(css, /\.workspace-shell \{[^}]*border: 0/);
  assert.match(css, /\.workspace-shell \{[^}]*border-radius: 0/);
  // 상단 줄은 두 줄로 고정한다: 제목+동작 / 작업공간·권한+참가자.
  assert.match(css, /grid-template-areas:\s*\n\s*"info buttons"\s*\n\s*"controls chips"/);
  assert.match(css, /\.room-actions \{\s*display: contents;/);
  assert.match(css, /\.agent-chips \{[^}]*grid-area: chips/);
  assert.match(css, /\.room-controls-actions \{[^}]*grid-area: buttons/);
  assert.match(css, /\.chat-main \{[^}]*margin: 0/);
  // 세로 레일을 걷어냈으므로 레일 치수 규칙도 남기지 않는다.
  assert.doesNotMatch(css, /app-rail/);
  // 레일이 가리던 사이드바 설정 버튼을 다시 드러낸다.
  assert.doesNotMatch(css, /\.sidebar-foot \.foot-button-icon \{[^}]*display: none/);
  assert.match(html, /class="room-actions"[\s\S]*id="btn-workflow"[\s\S]*id="btn-discussion"/);
  // 일반/전문 전환 스위치와 전문 실행 줄은 없어졌다 — 그 자리를 비워 둔다.
  assert.doesNotMatch(html, /btn-specialist|work-mode-switch|professional-actions|specialist-backdrop/);
  assert.doesNotMatch(css, /work-mode|professional-|specialist-|auto-revise/);
  // 칩은 CSS가 display:flex로 켜 두는 자리라 hidden 표기를 달지 않는다.
  assert.doesNotMatch(html, /id="agent-chips"[^>]*hidden/);
  assert.match(renderer, /function agentChipHint\(agent\)/);
  assert.ok(!/\.step-num \{/.test(css), "쓰지 않는 단계 번호 뱃지 규칙은 남기지 않습니다");
  assert.match(css, /\.chat-scroll \{\s*background: var\(--surface\)/);
  assert.match(css, /\.composer \{\s*background: var\(--surface\)/);
});

test("좁은 창에서도 상단 줄의 칸 이름이 어긋나지 않는다", () => {
  const css = read("src/chat.css");
  // 자식이 찾는 칸 이름이 격자에 없으면 그 자식은 이름 없는 칸을 새로 만들어
  // 격자 밖으로 흘러 나간다. 넓은 창과 좁은 창이 같은 이름을 쓰는지 본다.
  const templates = [...css.matchAll(/\.room-bar \{[^}]*grid-template-areas:([^;]+);/g)]
    .map((match) => [...new Set(match[1].match(/[a-z-]+/g))].sort());
  assert.ok(templates.length >= 2, "넓은 창과 좁은 창의 배치가 모두 있어야 합니다");
  for (const areas of templates) {
    assert.deepEqual(areas, ["buttons", "chips", "controls", "info"]);
  }
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
  // 전문 모드 화면(전환 스위치·전문 실행 줄·막힘 처리 창)은 없어졌다.
  for (const id of [
    "btn-specialist",
    "professional-actions",
    "btn-professional-plan",
    "professional-status-detail",
    "plan-auto-revise",
    "specialist-backdrop",
    "specialist-approvals",
    "specialist-choice-bar",
    "permission-warning",
  ]) {
    assert.doesNotMatch(html, new RegExp('id="' + id + '"'));
  }
  assert.doesNotMatch(renderer, /specialistNode|runProfessionalAction|openPlanPreview/);
  // 백그라운드 모델 목록 갱신은 main이 밀어 주고 renderer가 받아 새로 그린다.
  assert.match(preload, /onProviders: \(handler\) => subscribe\("chat:providers", handler\)/);
  assert.match(renderer, /window\.chatApi\.onProviders\?\.\(\(payload\) => \{[\s\S]*?providers = payload\.providers;[\s\S]*?renderHeader\(\);/);
  assert.match(renderer, /payload\.modelsChanged[\s\S]*?flashNotice\("모델 목록을 새로 불러왔습니다/);
  assert.match(preload, /projectsCreate: \(name, workspace\)/);
  assert.match(preload, /projectsSelect: \(projectId\)/);
  assert.match(preload, /projectsUpdate: \(projectId, patch\)/);
  assert.match(preload, /projectsDelete: \(projectId\)/);
  assert.match(preload, /sessionsMove: \(sessionId, projectId\)/);
  assert.doesNotMatch(preload, /specialist|readTaskFile|openTaskFile/i);
  assert.match(preload, /memoryAppend: \(projectId, content, title\)/);
  assert.match(preload, /decisionsCreate: \(input\)/);
  assert.match(preload, /tasksCreate: \(input\)/);
  assert.match(renderer, /function renderProjects\(\)/);
  assert.match(renderer, /function selectProject\(projectId\)/);
  assert.match(renderer, /function openWorkflowPopover\(anchor\)/);
  assert.match(renderer, /defaultAgents/);
  assert.doesNotMatch(renderer, /defaultRoles|autoRevisions/);
  assert.match(renderer, /function openSessionMovePopover\(anchor, session\)/);
  assert.match(renderer, /sessionsMove\(session\.id, project\.id\)/);
  assert.doesNotMatch(renderer, /project-move-apply-workspace/);
  assert.match(renderer, /payload\.model \|\| agent\?\.model/);
  assert.match(renderer, /누적 요약/);
  assert.doesNotMatch(ipc, /applyProjectWorkspace = false/);
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
  // 설정은 사이드바 하단 목록의 한 줄(아이콘 + "설정")이다.
  assert.match(html, /class="foot-button" id="btn-settings"/);

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
  assert.match(renderer, /responseModeBar\.hidden = !discussable/);
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

// 참가자 이름은 provider-capabilities 한 곳에서만 온다. HTML에 이름을 또 박으면
// 개명할 때마다 어긋나는데, 레일을 지우면서 그 중복이 함께 사라졌다.
test("참가자 이름은 HTML에 박지 않고 렌더러가 채운다", () => {
  const renderer = read("src/chat.js");
  const html = read("src/chat.html");
  // 칩 본문은 @id뿐이고 사람이 읽는 이름은 툴팁이 맡는다.
  assert.ok(renderer.includes("function agentChipHint(agent)"), "칩 툴팁 함수가 있어야 합니다");
  assert.match(renderer, /chip\.title = awaiting[\s\S]*?agentChipHint\(agent\);/);
  assert.match(renderer, /chip\.setAttribute\("aria-label", chip\.title\);/);
  // 참가자 이름(Claude/GPT/Gemini)을 마크업에 고정해 두지 않는다.
  assert.doesNotMatch(html, /app-rail-label/);
});

test("동시에 도는 턴 목록이 화면 상태까지 전달된다", () => {
  const renderer = read("src/chat.js");
  // 방이 running을 실어 보내는데 렌더러가 버리면 그 필드는 죽은 값이 된다.
  assert.match(renderer, /running: Array\.isArray\(state\.running\) \? state\.running : \[\]/);
  assert.match(renderer, /roomTurnState = \{ current: null, running: \[\]/);
});

// 입력칸 잠금 문구는 "지금 무엇을 기다리는지"를 말해야 한다. 실제 판정 함수를
// DOM 스텁 위에서 그대로 돌린다(문자열 검사가 아니라 동작 확인).
function loadComposerLock(locked) {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const start = src.indexOf("function lockComposer(locked) {");
  assert.ok(start > 0, "입력칸 잠금 코드를 찾지 못했습니다");
  // 다음 최상위 함수 직전까지가 lockComposer의 본문이다.
  const end = src.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "입력칸 잠금 코드의 끝을 찾지 못했습니다");
  const context = {
    composerInput: { disabled: false, placeholder: "", blur() {} },
    sendButton: { disabled: false, textContent: "" },
    attachButton: { disabled: false },
  };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  context.lockComposer(locked);
  return {
    placeholder: context.composerInput.placeholder,
    button: context.sendButton.textContent,
    inputDisabled: context.composerInput.disabled,
    sendDisabled: context.sendButton.disabled,
    attachDisabled: context.attachButton.disabled,
  };
}

test("도구 실행 권한 요청 중에만 입력칸이 잠기고, 끝나면 보통 입력으로 돌아온다", () => {
  const open = loadComposerLock(false);
  assert.equal(open.inputDisabled, false);
  assert.equal(open.sendDisabled, false);
  assert.equal(open.attachDisabled, false);
  assert.equal(open.button, "전송");
  assert.match(open.placeholder, /질문이나 작업을 입력하세요/);

  const locked = loadComposerLock(true);
  assert.equal(locked.inputDisabled, true);
  assert.equal(locked.sendDisabled, true);
  assert.equal(locked.attachDisabled, true);
  assert.match(locked.placeholder, /권한 요청/, "무엇을 기다리는지 말해야 합니다");
  assert.ok(!/전문 실행/.test(locked.placeholder), "없어진 기능을 가리키면 안 됩니다");
});

// 멘션 자동완성의 회색 항목은 "사용 불가"가 아니라 **왜** 못 쓰는지를 말해야 한다.
// 실제 mentionTargets()를 스텁 위에서 돌린다.
function loadMentionTargets({ agents }) {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const start = src.indexOf("function agentUnavailableReason(agent) {");
  const end = src.indexOf("function closeMentionPopup(");
  assert.ok(start > 0 && end > start, "멘션 대상 코드를 찾지 못했습니다");
  const context = {
    agents,
  };
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  return context.mentionTargets();
}

test("부를 수 없는 멘션 대상에는 이유가 붙는다", () => {
  const agents = [
    { id: "claude", name: "Claude", aliases: ["claude"], color: "#000", available: true, enabled: true },
    { id: "codex", name: "GPT", aliases: ["gpt"], color: "#000", available: false, enabled: true, reason: "Codex CLI가 필요합니다." },
    { id: "agy", name: "Gemini", aliases: ["gemini"], color: "#000", available: true, enabled: false },
  ];
  const targets = loadMentionTargets({ agents });
  const byAlias = Object.fromEntries(targets.map((t) => [t.alias, t]));

  // 참가자와 @모두만 있다 — 역할 호출(@기획자 등)·@팀은 없어졌다.
  assert.equal(targets.map((t) => t.alias).join(","), "claude,gpt,gemini,모두");
  assert.equal(byAlias.gpt.available, false);
  assert.match(byAlias.gpt.reason, /Codex CLI가 필요/, "참가자는 탐지 결과의 사유를 그대로 쓴다");
  assert.match(byAlias.gemini.reason, /이 세션에서 꺼져/);
  assert.equal(byAlias.claude.available, true);
  assert.equal(byAlias.claude.reason, "");
  assert.equal(byAlias.모두.available, true);
  for (const target of targets) {
    assert.ok(target.label.length <= 16, "목록 라벨이 깁니다: " + target.alias + " — " + target.label);
  }
  // 목록에는 한 줄에 들어가는 짧은 형태를 쓴다(전체 문장은 툴팁). 설치 명령·주소가
  // 목록에 들어가면 별칭까지 줄바꿈돼 갈라진다.
  assert.equal(byAlias.gpt.reasonShort, "CLI 없음");
  assert.equal(byAlias.gemini.reasonShort, "세션에서 꺼짐");
  assert.ok(byAlias.gpt.reasonShort.length < byAlias.gpt.reason.length);
  // 쓸 수 있는 참가자가 없으면 @모두도 쓸 수 없다.
  const none = loadMentionTargets({ agents: [agents[1], agents[2]] });
  assert.equal(none.find((t) => t.alias === "모두").available, false);
  assert.match(none.find((t) => t.alias === "모두").reason, /쓸 수 있는 참가자가 없음/);
});


// 칩 툴팁은 "이름 + 못 쓰는 이유"를 말해야 한다. 칩 본문은 @id뿐이라 설치되지
// 않았거나 꺼진 참가자의 사정이 툴팁 말고는 드러날 자리가 없다.
// 실제 agentChipHint를 격리해 돌린다.
test("참가자 칩 툴팁은 이름과 못 쓰는 이유를 말한다", () => {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const start = src.indexOf("function agentChipHint(agent) {");
  const end = src.indexOf("\n}\n", start) + 3;
  const reasonStart = src.indexOf("function agentUnavailableReason(agent) {");
  const reasonEnd = src.indexOf("\n}\n", reasonStart) + 3;
  assert.ok(start > 0 && reasonStart > 0, "칩 툴팁 코드를 찾지 못했습니다");
  const agents = {
    claude: { id: "claude", name: "Claude", available: true, enabled: true },
    codex: { id: "codex", name: "GPT", available: false, enabled: true, reason: "Codex CLI가 필요합니다." },
    agy: { id: "agy", name: "Gemini", available: true, enabled: false },
  };
  const context = {};
  vm.createContext(context);
  vm.runInContext(src.slice(reasonStart, reasonEnd) + src.slice(start, end), context);
  const hint = (id) => context.agentChipHint(agents[id]);

  assert.match(hint("claude"), /^Claude 담당 모델·추론 설정$/, "쓸 수 있으면 이름과 용도만");
  assert.match(hint("codex"), /^GPT · /, "이름이 앞에 선다");
  assert.match(hint("codex"), /Codex CLI가 필요/, "설치되지 않은 이유는 툴팁에");
  assert.match(hint("agy"), /^Gemini · /);
  assert.match(hint("agy"), /꺼져 있음/, "세션에서 꺼진 이유도 툴팁에");
});

// 저장된 노력 변형 id는 모델 드롭다운에서 접힌 베이스 + 노력으로 표시돼야 한다.
// 접기 전에 gemini-3.8-flash-high를 저장했다면, 목록엔 접힌 gemini-3.8-flash만
// 있으므로 그대로 두면 맨 위에 원시 id가 "…(현재 설정)"으로 튀어나온다.
test("모델 드롭다운은 저장된 노력 변형 id를 접힌 베이스+노력으로 옮긴다", () => {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const start = src.indexOf("function foldSavedModel(");
  const end = src.indexOf("\n}\n", start) + 2;
  assert.ok(start > 0 && end > start, "foldSavedModel를 찾지 못했습니다");
  const context = {};
  vm.createContext(context);
  vm.runInContext(src.slice(start, end), context);
  const options = [
    { id: "default" },
    { id: "gemini-3.8-flash", efforts: ["low", "medium", "high"], effortModels: { high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium", low: "gemini-3.8-flash-low" } },
  ];
  // vm 컨텍스트가 만든 객체는 프로토타입이 달라 strict deep-equal이 걸린다 — 값으로 비교한다.
  const fold = (m, e) => { const r = context.foldSavedModel(options, m, e); return `${r.model}|${r.effort}`; };
  // 저장된 원시 변형 → 접힌 베이스 + 그 노력.
  assert.equal(fold("gemini-3.8-flash-high", "default"), "gemini-3.8-flash|high");
  // 사용자가 따로 고른 노력이 있으면 그 값을 지킨다.
  assert.equal(fold("gemini-3.8-flash-high", "low"), "gemini-3.8-flash|low");
  // 이미 접힌 베이스는 그대로.
  assert.equal(fold("gemini-3.8-flash", "high"), "gemini-3.8-flash|high");
  // 지금 목록에 없는 모델(그 CLI가 안 잡음)은 저장값을 임의로 바꾸지 않는다.
  assert.equal(fold("gemini-9-flash-high", "default"), "gemini-9-flash-high|default");
  assert.equal(fold("default", "default"), "default|default");
  // 두 렌더 지점(프로젝트 기본 에이전트·참가자 팝오버) 모두 이 접기를 지난다 —
  // 원시 변형이 어느 드롭다운에서도 그대로 새지 않게.
  const renderer = src;
  assert.equal((renderer.match(/foldSavedModel\(/g) || []).length >= 3, true, "두 렌더 지점 + 정의");
  assert.match(renderer, /const savedFold = foldSavedModel\(modelOptions, saved\.model/);
  assert.match(renderer, /const savedFold = foldSavedModel\(modelOptions, agent\.model, agent\.effort\)/);
});

// 접힐 베이스가 지금 목록에 없는 저장 변형은 원시 id 대신 접힌 라벨로 보여준다.
test("목록에 없는 저장 노력 변형은 드롭다운에 접힌 라벨로 끼워 넣는다", () => {
  const vm = require("node:vm");
  const src = read("src/chat.js");
  const context = {};
  vm.createContext(context);
  for (const name of ["effortVariantLabel", "strayModelLabel"]) {
    const start = src.indexOf(`function ${name}(`);
    const end = src.indexOf("\n}\n", start) + 2;
    assert.ok(start > 0, `${name}를 찾지 못했습니다`);
    vm.runInContext(src.slice(start, end), context);
  }
  assert.equal(context.effortVariantLabel("gemini-3.8-flash-high"), "gemini-3.8-flash (높음)");
  assert.equal(context.effortVariantLabel("claude-opus-4-6-thinking"), null);
  // 원시 접미사가 그대로 노출되지 않는다.
  assert.equal(context.strayModelLabel("gemini-3.8-flash-high"), "gemini-3.8-flash (높음) · 현재 설정");
  assert.equal(context.strayModelLabel("gemini-3.8-flash-high", "현재 설정 · 목록에 없음"), "gemini-3.8-flash (높음) · 현재 설정 · 목록에 없음");
  assert.equal(context.strayModelLabel("some-model"), "some-model (현재 설정)");
});
