const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
  fetchAntigravityIdentity,
  fetchClaudeUsage,
  fetchAntigravityUsage,
} = require("./provider-usage");
const { createAccountSwitching } = require("./agora/account-switching");
const {
  normalizeFontFamily,
  normalizeFontSize,
  normalizeUiTheme,
} = require("./appearance-settings");
const { rateWindowLabel } = require("./codex-usage-label");
const { createChatFeature } = require("./chat/chat-ipc");
const { getInstalledFonts } = require("./installed-fonts");
const {
  isLinuxAutoLaunchEnabled,
  setLinuxAutoLaunchEnabled,
} = require("./linux-auto-launch");

const APP_NAME = "Agora";
const APP_ID = "app.agora.desktop";
app.setName(APP_NAME);
if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
  app.setAppUserModelId(APP_ID);
}

// 중복 실행 방지: 두 번째 인스턴스가 뜨면 첫 번째 창을 포커스하고 종료합니다.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 이미 열린 채팅 창이 있으면 앞으로 가져옵니다.
    const chatWindow = chatFeature?.getWindow?.();
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (chatWindow.isMinimized()) chatWindow.restore();
      chatWindow.focus();
    } else {
      // 창이 없으면 새로 엽니다.
      openChatWindow();
    }
  });
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// 개발 모드에서는 프로젝트 루트, 패키징된 exe에서는 exe가 있는 폴더입니다.
// portable exe는 실행 시 임시 폴더에 풀리므로 process.execPath 대신
// electron-builder가 넣어주는 PORTABLE_EXECUTABLE_DIR(원래 exe 위치)를 사용해야 합니다.
function getBaseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..");
}

// 트레이 아이콘은 개발 중에는 build/icon.ico를, 패키징된 exe에서는 extraResources로 복사된 icon.ico를 우선 사용합니다.
// 아이콘 파일을 못 찾더라도 트레이 기능 자체가 죽지 않게 투명한 1px PNG를 fallback으로 만듭니다.
function createTrayIcon() {
  // macOS 메뉴바는 .ico를 읽지 못하므로 png를 우선 사용하고, 메뉴바 크기에 맞게 줄입니다.
  const iconNames = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"];
  const iconCandidates = iconNames.flatMap((name) => [
    path.join(process.resourcesPath || "", name),
    path.join(__dirname, "..", "build", name),
    path.join(getBaseDir(), name),
  ]);

  const iconPath = iconCandidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;
    }
  }

  console.warn("[agora] Tray icon not found. Using transparent fallback icon.");
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
  );
}

// 글꼴 같은 간단한 설정을 userData/settings.json에 저장합니다.
function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const current = readSettings();
  delete current.themeSource;
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.warn("[agora] Failed to save settings.", error.message);
  }
}

let settingsWindow = null;
let tray = null;
let isQuitting = false;
// prepareAgent 콜백은 나중(실제 에이전트 실행 시점)에만 호출되므로, accountSwitching이
// 뒤에서 할당돼도 안전합니다. (순환 초기화: chatFeature ↔ accountSwitching)
let accountSwitching = null;
// 채팅 기능은 창·세션·IPC·프로세스 실행을 chat/chat-ipc.js가 조립합니다.
const chatFeature = createChatFeature({
  electron: { ipcMain, dialog, BrowserWindow, shell },
  onWindowReady: () => sendAppearanceToWindows(),
  prepareAgent: ({ agent }) => accountSwitching.prepareChatAgent(agent),
  // 출력 hard limit은 기본값이 없습니다(상한 없음).
  // 사용자가 settings.json의 agentOutputHardLimitMB에 양수를 넣은 경우에만 적용됩니다.
  getHardOutputLimitBytes: () => {
    const megabytes = Number(readSettings().agentOutputHardLimitMB);
    return Number.isFinite(megabytes) && megabytes > 0 ? Math.floor(megabytes * 1024 * 1024) : null;
  },
});

// 계정 전환·로그인 스크립트·Codex 로컬 프록시 제어는 agora/account-switching.js가
// 담당합니다. 그 모듈은 트레이/채팅 UI를 소유하지 않으므로, 여기서 필요한 함수만 주입합니다.
accountSwitching = createAccountSwitching({
  electron: { app, shell },
  openChatWindow,
  refreshTrayMenu,
  readSettings,
  writeSettings,
  getChatFeature: () => chatFeature,
  // 앱 안 CLI 로그인의 진행 상황을 설정 창에 흘려보낸다. 끝나면 갱신된 계정
  // 목록을 함께 실어 화면이 다시 조회하지 않아도 되게 한다.
  notifyAccountLogin: async (event) => {
    let payload = event;
    if (event?.type === "exit") {
      try {
        payload = { ...event, data: await getSettingsData() };
      } catch {
        // 목록 조회가 막혀도 종료 사실은 알린다.
      }
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings:account-login", payload);
    }
  },
});
const {
  codexAccountSwitcher,
  claudeAccountSwitcher,
  antigravityAccountSwitcher,
  claudeLiveStore,
  isCodexProxyModeEnabled,
  setCodexProxyMode,
  restoreCodexProxyMode,
  teardownCodexProxyOnQuit,
  startCodexLogin,
  submitProviderLoginInput,
  cancelProviderLogin,
  openProviderLoginUrl,
  isProviderLoginRunning,
  switchCodexAccount,
  buildProviderAccountSubmenu,
  switchProviderAccount,
  deleteProviderAccount,
  startProviderLogin,
  getClaudeAuthStatus,
} = accountSwitching;

// 윈도우 로그인 시 자동 실행 설정입니다.
// - portable exe: 임시 폴더의 execPath가 아니라 원래 exe 경로를 등록해야 합니다.
// - 개발 모드(npm run dev): 실행 파일이 electron.exe라서 앱 경로를 인자로 함께 등록합니다.
// - 설치형/일반 패키징: 실행 파일 자체를 등록하면 됩니다.
function getLoginItemOptions() {
  if (process.platform === "linux") {
    return {
      path: process.env.APPIMAGE || process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    };
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return { path: process.env.PORTABLE_EXECUTABLE_FILE };
  }
  return app.isPackaged
    ? {}
    : { path: process.execPath, args: [app.getAppPath()] };
}

function isAutoLaunchEnabled() {
  if (process.platform === "linux") return isLinuxAutoLaunchEnabled();
  return app.getLoginItemSettings(getLoginItemOptions()).openAtLogin;
}

function toggleAutoLaunch() {
  if (process.platform === "linux") {
    const options = getLoginItemOptions();
    setLinuxAutoLaunchEnabled(!isAutoLaunchEnabled(), {
      executable: options.path,
      args: options.args,
    });
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: !isAutoLaunchEnabled(),
    ...getLoginItemOptions(),
  });
}

// 시스템 트레이 메뉴는 채팅 창이 닫혀 있어도 설정/계정/종료에 접근할 수 있는 안전장치입니다.
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "설정…",
      click: openSettingsWindow,
    },
    {
      label: "에이전트 채팅방…",
      click: openChatWindow,
    },
    { type: "separator" },
    { label: "계정", submenu: buildProviderAccountSubmenu() },
    {
      label: "Codex 재시작 없는 전환 (프록시)",
      type: "checkbox",
      checked: isCodexProxyModeEnabled(),
      click: () => setCodexProxyMode(!isCodexProxyModeEnabled()),
    },
    { type: "separator" },
    {
      label: "로그인 시 자동 실행",
      type: "checkbox",
      checked: isAutoLaunchEnabled(),
      click: toggleAutoLaunch,
    },
    { type: "separator" },
    {
      label: "완전 종료",
      click: quitApp,
    },
  ]);
}

// 트레이 메뉴는 현재 계정/프록시 상태를 반영해야 하므로 상태가 바뀔 때마다 다시 만듭니다.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip("Ἀγορά");
  tray.setContextMenu(buildTrayMenu());
}

// 시스템 트레이를 생성합니다.
// 아이콘을 더 바꾸고 싶으면 build/icon.ico를 교체한 뒤 다시 빌드하면 됩니다.
function createTray() {
  if (tray) return;

  tray = new Tray(createTrayIcon());
  tray.on("click", openChatWindow);
  tray.on("double-click", openChatWindow);
  refreshTrayMenu();
}

// 실제 앱 종료는 이 함수만 통하게 합니다.
// 일반 close는 트레이로 숨기고, "완전 종료"만 프로세스를 끝내도록 분리합니다.
function quitApp() {
  isQuitting = true;

  if (tray) {
    tray.destroy();
    tray = null;
  }

  app.quit();
}

// preload가 노출한 API 호출을 main process에서 처리합니다.
function registerIpcHandlers() {
  ipcMain.handle("settings:get", async () => ({
    ok: true,
    data: await getSettingsData(),
  }));
  ipcMain.handle("settings:usage", async () => ({
    ok: true,
    data: await getSettingsData({ forceUsage: true }),
  }));
  ipcMain.handle("settings:fonts", async () => ({
    ok: true,
    data: await getInstalledFonts(),
  }));
  ipcMain.handle("settings:save", async (_event, input) => {
    const next = input && typeof input === "object" ? input : {};
    const fonts = await getInstalledFonts();
    const patch = {};

    if (Object.hasOwn(next, "fontFamily")) {
      patch.fontFamily = normalizeFontFamily(next.fontFamily, fonts);
    }
    if (Object.hasOwn(next, "fontSize")) {
      patch.fontSize = normalizeFontSize(next.fontSize);
    }
    if (Object.hasOwn(next, "uiTheme")) {
      patch.uiTheme = normalizeUiTheme(next.uiTheme);
    }
    if (typeof next.autoStart === "boolean" && next.autoStart !== isAutoLaunchEnabled()) {
      toggleAutoLaunch();
    }

    writeSettings(patch);
    sendAppearanceToWindows();
    refreshTrayMenu();
    return { ok: true, data: await getSettingsData() };
  });
  ipcMain.handle("settings:account", async (_event, input) => {
    try {
      const provider = input?.provider;
      const action = input?.action;
      if (!["agy", "claude", "codex"].includes(provider)) {
        return { ok: false, error: "지원하지 않는 계정 유형입니다." };
      }
      // 앱 안 CLI 로그인의 진행 조작. 코드 붙여넣기(Claude)·취소·주소 열기는
      // 제공자와 무관하게 같은 러너를 쓴다.
      if (action === "login-input") {
        submitProviderLoginInput(provider, input.text);
        return { ok: true, login: { running: isProviderLoginRunning(provider) } };
      }
      if (action === "login-cancel") {
        cancelProviderLogin(provider);
        return { ok: true, login: { running: isProviderLoginRunning(provider) } };
      }
      if (action === "login-open-url") {
        await openProviderLoginUrl(provider, input.url);
        return { ok: true, login: { running: isProviderLoginRunning(provider) } };
      }

      let succeeded = false;
      if (action === "login") {
        succeeded = provider === "codex" ? await startCodexLogin() : await startProviderLogin(provider);
      } else if (action === "switch" && typeof input.profileKey === "string") {
        succeeded = provider === "codex"
          ? await switchCodexAccount(input.profileKey)
          : await switchProviderAccount(provider, input.profileKey);
      } else if (action === "delete" && typeof input.profileKey === "string") {
        succeeded = Boolean(deleteProviderAccount(provider, input.profileKey));
      } else {
        return { ok: false, error: "알 수 없는 계정 작업입니다." };
      }

      if (!succeeded) {
        return {
          ok: false,
          error: provider === "codex"
            ? "작업을 완료하지 못했습니다. 채팅 창의 안내를 확인해 주세요."
            : "작업을 완료하지 못했습니다.",
        };
      }
      return {
        ok: true,
        data: await getSettingsData(),
        login: { running: isProviderLoginRunning(provider) },
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.on("settings:minimize", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.minimize();
    }
  });
  ipcMain.on("settings:maximize", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMaximized()) {
        settingsWindow.unmaximize();
      } else {
        settingsWindow.maximize();
      }
    }
  });
  ipcMain.on("settings:close", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  ipcMain.handle("chat:usage", async (_event, input) => ({
    ok: true,
    data: await getUsageData({ forceUsage: input?.force === true }),
  }));

  // section을 그대로 넘겨 설정 창이 사용량 탭에서 바로 열리게 합니다.
  // openSettingsWindow가 허용 목록을 검증하므로 잘못된 값은 general로 떨어집니다.
  ipcMain.on("chat:open-settings", (_event, section) => {
    openSettingsWindow(section);
  });

  chatFeature.registerIpcHandlers();
}

// 앱 수명주기 진입점입니다.
app.whenReady().then(() => {
  // 트레이 상주형 앱이라 macOS Dock에는 남기지 않습니다.
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  registerIpcHandlers();
  createTray();
  if (process.argv.includes("--settings")) {
    openSettingsWindow();
  }
  if (process.argv.includes("--chat") || !process.argv.includes("--settings")) {
    openChatWindow();
  }
  // 반환된 promise는 accountSwitching 내부에서 codexProxyStartupPromise로 스스로
  // 추적합니다(ensureCodexProxyReadyForRun/switchCodexAccount가 내부적으로 대기).
  // main.js에서는 별도로 기다리거나 저장할 필요가 없습니다.
  restoreCodexProxyMode();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openChatWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  teardownCodexProxyOnQuit();
  chatFeature.shutdown();
});

app.on("window-all-closed", () => {
  // 채팅 창만 닫혀도 트레이 프로세스는 남습니다. "완전 종료"만 프로세스를 끝냅니다.
  if (isQuitting) {
    app.quit();
  }
});

function getAppearancePayload() {
  const settings = readSettings();
  return {
    fontFamily: settings.fontFamily || "",
    fontSize: normalizeFontSize(settings.fontSize),
    uiTheme: normalizeUiTheme(settings.uiTheme),
  };
}

function sendAppearanceToWindows() {
  const payload = getAppearancePayload();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("appearance:update", payload);
  }
  const chatWindow = chatFeature.getWindow();
  if (chatWindow) {
    chatWindow.webContents.send("appearance:update", payload);
  }
}

function codexAccountRows() {
  return codexAccountSwitcher.listProfiles().map((profile) => ({
    key: profile.key,
    label: profile.label,
    active: profile.active,
    email: profile.email,
    plan: profile.planType,
    hasAuth: profile.hasAuth,
  }));
}

// Codex 버전에 따라 reset_at 또는 resets_at으로 들어오므로 화면 로직에서는 이 helper만 사용합니다.
function getResetAtSec(rateWindow) {
  const resetAt = Number(rateWindow?.resets_at ?? rateWindow?.reset_at);
  return Number.isFinite(resetAt) ? resetAt : null;
}

// 현재 live ~/.codex/auth.json의 토큰으로 직접 조회한 rate_limits를 게이지 목록으로 바꿉니다.
// 설정 창과 채팅 사이드바의 사용량 카드가 같은 형태를 사용합니다.
function codexUsageGauges(usage) {
  const { rateLimits } = usage;
  const gauges = [];

  for (const window of rateLimits.windows || [rateLimits.primary, rateLimits.secondary]) {
    if (!window) continue;

    // 기록 이후 초기화 시각이 이미 지났으면 실제 사용량은 0으로 리셋된 상태입니다.
    // 오래된 used_percent를 그대로 보여주면 오해를 부르므로 초기화된 것으로 표시합니다.
    const resetAtSec = getResetAtSec(window);
    const resetPassed = Number.isFinite(resetAtSec) && resetAtSec * 1000 <= Date.now();

    gauges.push({
      label: rateWindowLabel(window),
      usedPercent: resetPassed ? 0 : Number(window.used_percent) || 0,
      // 다른 공급자처럼 원본 시각(ISO)만 넘깁니다. 표시 포맷은 usage-view.resetLabel
      // 한 곳에서만 만듭니다(채팅 사이드바와 설정 창이 그 함수를 공유).
      resetText: resetPassed
        ? "이미 초기화됨"
        : Number.isFinite(resetAtSec) ? new Date(resetAtSec * 1000).toISOString() : "",
    });
  }

  return gauges;
}

async function loadCodexUsage(forceUsage) {
  try {
    const usage = await codexAccountSwitcher.fetchCurrentUsage({ force: forceUsage });
    return { id: "codex", label: "Codex", gauges: codexUsageGauges(usage) };
  } catch {
    return { id: "codex", label: "Codex", error: "조회 불가", gauges: [] };
  }
}

async function loadAntigravityProvider(forceUsage) {
  let credential;
  try {
    credential = await antigravityAccountSwitcher.read();
  } catch {
    return {
      accounts: antigravityAccountSwitcher.listProfiles(),
      usage: { id: "agy", label: "AGY", error: "로그인 필요", gauges: [] },
    };
  }

  let identity = {};
  try {
    identity = await fetchAntigravityIdentity({ credential, force: forceUsage });
  } catch {
    // 계정 조회가 막혀도 저장된 힌트와 한도 조회는 각각 계속 시도합니다.
  }
  try {
    await antigravityAccountSwitcher.snapshotCurrent({ email: identity.email });
  } catch {
    // 로그인 정보 자체가 없으면 아래 한도 조회에서 로그인 오류로 처리합니다.
  }

  let usage;
  try {
    const data = await fetchAntigravityUsage({ credential, force: forceUsage });
    await antigravityAccountSwitcher.snapshotCurrent({
      email: data.email || identity.email,
      plan: data.plan,
    });
    usage = { id: "agy", label: "AGY", gauges: data.gauges };
  } catch {
    try {
      await antigravityAccountSwitcher.snapshotCurrent();
    } catch {
      // 로그인 정보 자체가 없으면 저장할 프로필도 없습니다.
    }
    usage = { id: "agy", label: "AGY", error: "조회 불가", gauges: [] };
  }
  return { accounts: antigravityAccountSwitcher.listProfiles(), usage };
}

async function loadClaudeProvider(forceUsage) {
  let status = {};
  try {
    status = await getClaudeAuthStatus();
  } catch {
    // 사용량과 저장된 프로필은 별도로 확인합니다.
  }
  try {
    claudeAccountSwitcher.snapshotCurrent({
      email: status.email,
      plan: status.subscriptionType,
    });
  } catch {
    return {
      accounts: claudeAccountSwitcher.listProfiles(),
      usage: { id: "claude", label: "Claude", error: "로그인 필요", gauges: [] },
    };
  }

  let usage;
  try {
    const data = await fetchClaudeUsage({ force: forceUsage, credentialStore: claudeLiveStore });
    // 토큰 갱신으로 live 파일이 바뀌었을 수 있으므로 최신 값을 다시 저장합니다.
    claudeAccountSwitcher.snapshotCurrent({
      email: status.email,
      plan: status.subscriptionType,
    });
    usage = { id: "claude", label: "Claude", gauges: data.gauges };
  } catch {
    usage = { id: "claude", label: "Claude", error: "조회 불가", gauges: [] };
  }
  return { accounts: claudeAccountSwitcher.listProfiles(), usage };
}

// 세 공급자의 계정·한도를 한 번에 읽습니다. 설정 창과 채팅 사이드바가 같은 경로를 씁니다.
async function loadProviderSnapshots(forceUsage) {
  const [codexUsage, agy, claude] = await Promise.all([
    loadCodexUsage(forceUsage),
    loadAntigravityProvider(forceUsage),
    loadClaudeProvider(forceUsage),
  ]);
  return { codexUsage, agy, claude };
}

// 한도 게이지만 필요한 호출자(채팅 사이드바)를 위한 가벼운 형태입니다.
// provider-usage.js의 60초 캐시가 그대로 작동하므로 force가 아니면 재조회하지 않습니다.
// 순서는 provider-capabilities/레일과 같은 Claude → Codex → AGY로 고정합니다.
async function getUsageData({ forceUsage = false } = {}) {
  const { codexUsage, agy, claude } = await loadProviderSnapshots(forceUsage);
  return [claude.usage, codexUsage, agy.usage];
}

async function getSettingsData({ forceUsage = false } = {}) {
  const settings = readSettings();
  const { codexUsage, agy, claude } = await loadProviderSnapshots(forceUsage);
  const codexAccounts = codexAccountRows();

  return {
    appearance: {
      fontFamily: settings.fontFamily || "",
      fontSize: normalizeFontSize(settings.fontSize),
      uiTheme: normalizeUiTheme(settings.uiTheme),
    },
    autoStart: isAutoLaunchEnabled(),
    // 순서는 provider-capabilities/레일과 같은 Claude → Codex → AGY로 고정합니다.
    providers: [
      { id: "claude", label: "Claude", accounts: claude.accounts },
      { id: "codex", label: "Codex", accounts: codexAccounts },
      { id: "agy", label: "AGY", accounts: agy.accounts },
    ],
    usage: [claude.usage, codexUsage, agy.usage],
  };
}

function openSettingsWindow(section = "general") {
  const requestedSection = ["general", "accounts", "usage"].includes(section)
    ? section
    : "general";
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send("settings:navigate", requestedSection);
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 620,
    minHeight: 500,
    show: false,
    frame: false,
    title: "Ἀγορά 설정",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow.on("maximize", () => {
    settingsWindow.webContents.send("settings:maximized-state", true);
  });
  settingsWindow.on("unmaximize", () => {
    settingsWindow.webContents.send("settings:maximized-state", false);
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    settingsWindow.focus();
    sendAppearanceToWindows();
    settingsWindow.webContents.send("settings:navigate", requestedSection);
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
}

// 채팅 창 열기: 트레이/컨텍스트 메뉴에서 호출됩니다. 실제 구현은 chat/chat-window.js.
function openChatWindow() {
  chatFeature.openWindow();
}
