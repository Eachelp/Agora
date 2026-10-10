/* global chatMarkdown, usageView, awaitingView */
const chatScroll = document.getElementById("chat-scroll");
const messageList = document.getElementById("message-list");
const typingRow = document.getElementById("typing-row");
const awaitingRow = document.getElementById("awaiting-row");
// 설정 '답변 대기 표시'. 끄면 대기 바와 참가자 칩의 대기 점을 그리지 않는다.
// 대기 상태 자체는 방(main)이 계속 갖고 있어 다시 켜면 그대로 보인다.
let showAwaiting = true;
const agentChips = document.getElementById("agent-chips");
const composerInput = document.getElementById("composer-input");
const composerBox = document.getElementById("composer-box");
const sendButton = document.getElementById("btn-send");
const stopButton = document.getElementById("btn-stop");
const attachButton = document.getElementById("btn-attach");
const mentionPopup = document.getElementById("mention-popup");
const attachmentRow = document.getElementById("attachment-row");
const btnModeSequential = document.getElementById("btn-mode-sequential");
const btnModeIndependent = document.getElementById("btn-mode-independent");
const responseModeBar = document.getElementById("response-mode-bar");

let isIndependentResponseMode = false;

function setResponseMode(independent) {
  isIndependentResponseMode = independent;
  if (btnModeSequential && btnModeIndependent) {
    btnModeSequential.classList.toggle("is-active", !independent);
    btnModeIndependent.classList.toggle("is-active", independent);
  }
}

if (btnModeSequential) {
  btnModeSequential.addEventListener("click", () => setResponseMode(false));
}
if (btnModeIndependent) {
  btnModeIndependent.addEventListener("click", () => setResponseMode(true));
}
const projectListEl = document.getElementById("project-list");
const newProjectButton = document.getElementById("btn-new-project");
const refreshProvidersButton = document.getElementById("btn-refresh-providers");
const doctorButton = document.getElementById("btn-doctor");
const sessionTitleEl = document.getElementById("session-title");
const workspaceButton = document.getElementById("btn-workspace");
const workspaceLabel = document.getElementById("workspace-label");
const permissionSelect = document.getElementById("permission-select");
const enforcementHint = document.getElementById("enforcement-hint");
const discussionButton = document.getElementById("btn-discussion");
const workflowButton = document.getElementById("btn-workflow");
const usageButton = document.getElementById("btn-usage");
const usageFoldToggle = document.getElementById("btn-usage-fold");
const usageStripItems = document.getElementById("usage-strip-items");
const storeWarning = document.getElementById("store-warning");
const popover = document.getElementById("popover");
const popoverBackdrop = document.getElementById("popover-backdrop");
const appEl = document.querySelector(".app");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizer = document.getElementById("sidebar-resizer");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarOpenButton = document.getElementById("sidebar-open");
const approvalBackdrop = document.getElementById("approval-backdrop");
const approvalSummary = document.getElementById("approval-summary");
const approvalDetail = document.getElementById("approval-detail");
const approvalApprove = document.getElementById("approval-approve");
const approvalDeny = document.getElementById("approval-deny");
const confirmBackdrop = document.getElementById("confirm-backdrop");
const confirmMessage = document.getElementById("confirm-message");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");
const doctorBackdrop = document.getElementById("doctor-backdrop");
const doctorList = document.getElementById("doctor-list");
const doctorSummary = document.getElementById("doctor-summary");
const doctorRefresh = document.getElementById("doctor-refresh");
const doctorClose = document.getElementById("doctor-close");
const doctorDone = document.getElementById("doctor-done");

let providers = [];
let diagnostics = [];
let projects = [];
// V1.5 구조화 토론 Preset 목록. 정의는 main의 discussion-protocol.js가 갖고
// 렌더러는 fullState로 받은 요약본만 쓴다 — 하드코딩 중복을 두지 않는다.
let discussionPresets = [];
let activeProjectId = null;
let sessions = [];
// 트리 사이드바용: 프로젝트 id → 그 프로젝트의 세션 목록.
let sessionsByProject = {};
let activeSessionId = null;
let sessionMeta = null;
// 이름 편집 중인 대화 id. 값이 있으면 목록을 다시 그리지 않습니다.
let renamingSessionId = null;
// 편집 중에 들어온 갱신이 있었는지. 편집이 끝나면 그때 한 번만 다시 그립니다.
let renderSessionsPending = false;
// 사이드바 사용량 스트립 상태
let usageItems = [];
let usageLoadedAt = 0;
let usageLoading = false;
let usagePopoverOpen = false;
let agents = [];
let workflow = { decisions: [], tasks: [], roles: [], statuses: [] };
let chatMessages = [];
let pendingAttachments = [];
const approvalQueue = [];
let activeApproval = null;
const typingAgents = new Set();
let roomTurnState = { current: null, running: [], queue: [], deferred: [] };
const liveRuns = new Map(); // runId → { item, textEl, statusEl, text }
let mentionState = null;
let noticeTimer = null;
// 방마다 쓰던 입력 초안. 방을 옮겨도 쓰던 글이 따라가거나 사라지지 않게 한다.
const composerDrafts = new Map();
// 방 설정(sessionMeta)을 바꾸는 요청의 순번. 늦게 온 응답이 최신 설정을 덮지 않게 한다.
let sessionMetaRequest = 0;
// 창 안 확인창이 열려 있으면 그 결과를 돌려줄 함수.
let confirmResolve = null;

const SIDEBAR_WIDTH_KEY = "agora.chat.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "agora.chat.sidebarCollapsed";
const DOCTOR_SEEN_KEY = "agora.chat.doctorSeen.v1";
const DISCUSSION_LENGTH_KEY = "agora.chat.discussionLength";
const DISCUSSION_CUSTOM_TURNS_KEY = "agora.chat.discussionCustomTurns";
const DISCUSSION_MODE_KEY = "agora.chat.discussionMode";
const DISCUSSION_PRESET_KEY = "agora.chat.discussionPreset";
const DISCUSSION_CYCLES_KEY = "agora.chat.discussionCycles";
// V1.5 토론 길이 선택지. "manual"(직접 중단할 때까지)도 무한이 아니라
// 실행 상한 50턴을 가진다 — Runtime에 무한루프를 만들지 않는다.
const DISCUSSION_LENGTH_PRESETS = Object.freeze({
  short: 9,
  normal: 15,
  long: 30,
  manual: 50,
});
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
function boundedDiscussionTurns(value, fallback = 15) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(50, Math.max(3, parsed)) : fallback;
}

function clampSidebarWidth(value) {
  const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth * 0.46));
  return Math.round(Math.min(viewportMax, Math.max(SIDEBAR_MIN_WIDTH, Number(value) || 220)));
}

function applySidebarWidth(value, persist = true) {
  const width = clampSidebarWidth(value);
  appEl.style.setProperty("--sidebar-width", `${width}px`);
  sidebarResizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
  sidebarResizer.setAttribute("aria-valuemax", String(clampSidebarWidth(SIDEBAR_MAX_WIDTH)));
  sidebarResizer.setAttribute("aria-valuenow", String(width));
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}

// 접기 버튼은 사이드바 머리줄에, 펼치기 버튼은 대화 제목 앞에 있다. 접힌 사이드바는
// 폭만 0일 뿐 DOM에 남아 있어서 inert로 막지 않으면 Tab이 보이지 않는 목록 버튼으로
// 들어간다.
function setSidebarCollapsed(collapsed, persist = true) {
  appEl.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarEl.inert = collapsed;
  sidebarOpenButton.hidden = !collapsed;
  for (const button of [sidebarToggle, sidebarOpenButton]) {
    button.setAttribute("aria-expanded", String(!collapsed));
  }
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

applySidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY), false);
setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true", false);

// 누른 버튼은 곧 사라지므로 초점을 반대편 버튼으로 넘긴다. 그러지 않으면 키보드
// 사용자의 초점이 body로 떨어져 처음부터 다시 Tab을 눌러야 한다.
sidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed(true);
  sidebarOpenButton.focus();
});

sidebarOpenButton.addEventListener("click", () => {
  setSidebarCollapsed(false);
  sidebarToggle.focus();
});

sidebarResizer.addEventListener("pointerdown", (event) => {
  if (appEl.classList.contains("is-sidebar-collapsed")) return;
  event.preventDefault();
  sidebarResizer.setPointerCapture(event.pointerId);
  appEl.classList.add("is-resizing");
});

sidebarResizer.addEventListener("pointermove", (event) => {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return;
  applySidebarWidth(event.clientX - appEl.getBoundingClientRect().left, false);
});

function finishSidebarResize(event) {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return;
  sidebarResizer.releasePointerCapture(event.pointerId);
  appEl.classList.remove("is-resizing");
  const width = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(width, true);
}
sidebarResizer.addEventListener("pointerup", finishSidebarResize);
sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
// 접힌 동안 리사이저는 숨는다(펼치기는 #sidebar-open이 맡는다). 그래서 여기서는
// 펼친 상태만 다룬다.
sidebarResizer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setSidebarCollapsed(true);
    sidebarOpenButton.focus();
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(current + (event.key === "ArrowRight" ? 12 : -12));
});

window.addEventListener("resize", () => {
  const current = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(current, false);
});

const ENFORCEMENT_LABEL = {
  sandbox: "샌드박스",
  "tool-policy": "도구 정책",
  "prompt-only": "프롬프트 안내만",
  unavailable: "미지원",
};

const AGENT_VISUALS = Object.freeze({
  // 작업용 채팅에서는 캐릭터 그림 대신 각 공급자의 공식 로고를 사용합니다.
  claude: { icon: "./chat-assets/agent-claude.svg", background: "#fff4ed" },
  codex: { icon: "./chat-assets/agent-codex.svg", background: "#f2f4f6" },
  agy: { icon: "./chat-assets/agent-agy.png", background: "#eef4ff" },
});

// 예전 대화에는 캐릭터 이모티콘 이미지가 섞인 contentParts가 저장되어 있을 수 있습니다.
// 캐릭터 이미지 렌더링은 더 이상 하지 않지만, 텍스트 조각만 이어붙여
// 예전 대화를 열었을 때 내용이 비지 않도록 호환성을 유지합니다.
function renderAgentMessageContent(bubble, message) {
  if (!Array.isArray(message.contentParts)) {
    renderRichText(bubble, message.text);
    return;
  }
  const textParts = message.contentParts.filter((part) => part?.type === "text" && part.text);
  if (textParts.length === 0) {
    renderRichText(bubble, message.text);
    return;
  }
  for (const part of textParts) {
    const segment = document.createElement("div");
    segment.className = "message-text-segment";
    renderRichText(segment, part.text);
    bubble.append(segment);
  }
}

const EFFORT_LABELS = Object.freeze({
  default: "모델 고정",
  minimal: "최소",
  low: "낮음",
  medium: "중간",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
  ultra: "극대",
});

function effortLabel(value) {
  return EFFORT_LABELS[value] || value;
}

function applyAppearance(appearance) {
  const root = document.documentElement;
  const fontFamily = appearance && appearance.fontFamily;
  if (fontFamily) root.style.setProperty("--user-font", `"${fontFamily}"`);
  else root.style.removeProperty("--user-font");

  const theme = appearance?.uiTheme;
  for (const key of ["page", "sidebar", "surface", "ink", "muted", "accent", "line"]) {
    const value = theme?.[key];
    if (/^#[0-9a-f]{6}$/i.test(String(value || ""))) {
      root.style.setProperty(`--${key}`, value);
    } else {
      root.style.removeProperty(`--${key}`);
    }
  }

  const nextShowAwaiting = appearance?.showAwaiting !== false;
  if (nextShowAwaiting !== showAwaiting) {
    showAwaiting = nextShowAwaiting;
    renderAgents();
  }
}

function agentById(id) {
  return agents.find((agent) => agent.id === id) || null;
}

function providerById(id) {
  return providers.find((provider) => provider.id === id) || null;
}

function modelOptionsForProvider(provider, includeDefault = false) {
  const raw = provider.modelOptions || (provider.models || []).map((id) => ({ id, label: id }));
  const options = raw
    .filter((model) => model?.id)
    .map((model) => ({ ...model, label: model.label || model.id }))
    .filter((model, index, list) => list.findIndex((entry) => entry.id === model.id) === index);
  if (includeDefault && !options.some((model) => model.id === "default")) {
    options.unshift({ id: "default", label: "공급자 기본값", efforts: [] });
  }
  return includeDefault ? options : options.filter((model) => model.id !== "default");
}

function effortOptionsForModel(provider, modelId) {
  const model = modelOptionsForProvider(provider, true).find((entry) => entry.id === modelId);
  const efforts = Array.isArray(model?.efforts) ? model.efforts : provider.efforts || [];
  return efforts.filter((effort) => effort !== "default");
}

// 저장된 모델이 노력 변형 id(gemini-3.8-flash-high)면 목록에 있는 접힌 베이스
// (gemini-3.8-flash) + 노력으로 옮긴다. 접기 전에 저장한 값이라 그대로 두면
// 목록에 없는 모델로 취급돼 맨 위에 "…(현재 설정)" 원시 id가 튀어나온다.
// 백엔드도 실행 시 같은 방식으로 되돌린다(effortModels). 베이스가 지금 목록에
// 없으면(그 모델이 안 잡힘) 저장값을 그대로 둔다 — 사용자의 선택을 임의로 바꾸지 않는다.
function foldSavedModel(options, savedModel, savedEffort = "default") {
  if (!savedModel || savedModel === "default") return { model: savedModel || "default", effort: savedEffort };
  if ((options || []).some((option) => option.id === savedModel)) return { model: savedModel, effort: savedEffort };
  for (const option of options || []) {
    const variants = option.effortModels || {};
    const effort = Object.keys(variants).find((key) => variants[key] === savedModel);
    if (effort) {
      return { model: option.id, effort: savedEffort && savedEffort !== "default" ? savedEffort : effort };
    }
  }
  return { model: savedModel, effort: savedEffort };
}

// 노력 변형 id(gemini-3.8-flash-high)를 사람이 읽기 좋은 라벨로. 접힐 짝(베이스)이
// 지금 목록에 없어 "저장된 값"으로 남을 때 원시 id 대신 이 라벨을 쓴다.
function effortVariantLabel(id) {
  const match = /^(.+)-(low|medium|high)$/.exec(String(id || ""));
  if (!match) return null;
  const ko = { low: "낮음", medium: "중간", high: "높음" }[match[2]];
  return `${match[1]} (${ko})`;
}

// 목록에 없는 저장 모델을 드롭다운에 끼워 넣을 때의 라벨. 노력 변형이면 접힌
// 모양으로, 아니면 id 그대로. 값(option.value)은 그대로 둬 실행에 쓰인다.
function strayModelLabel(id, note = "현재 설정") {
  const pretty = effortVariantLabel(id);
  return pretty ? `${pretty} · ${note}` : `${id} (${note})`;
}

// 방을 옮길 때 그 방에 묶인 화면 상태를 함께 바꾼다. 쓰던 글은 방별로 보관한다.
// 이전 방의 팝오버·확인창은 닫는다. 남겨 두면 그 조작이 새 방에 적용된다.
function switchActiveSession(nextId) {
  if (activeSessionId === nextId) return;
  if (activeSessionId) {
    if (composerInput.value) composerDrafts.set(activeSessionId, composerInput.value);
    else composerDrafts.delete(activeSessionId);
  }
  closePopover();
  closeMentionPopup();
  settleConfirm(false);
  activeSessionId = nextId;
  composerInput.value = (nextId && composerDrafts.get(nextId)) || "";
  autoresize();
}

// 삭제한 방의 초안을 지운다.
function forgetRoom(sessionId) {
  composerDrafts.delete(sessionId);
}

// 전송이 실패하면 보냈던 글을 그 방의 입력칸으로 되돌린다. 그사이 다른 방으로
// 옮겼으면 그 방의 초안에 넣어 두고, 같은 방에서 새로 쓴 글이 있으면 그 앞에
// 붙여 둘 다 남긴다.
function restoreFailedDraft(sessionId, draftText) {
  if (!draftText) return;
  const join = (current) => (current.trim() ? `${draftText}\n${current}` : draftText);
  if (sessionId === activeSessionId) {
    composerInput.value = join(composerInput.value);
    autoresize();
    return;
  }
  composerDrafts.set(sessionId, join(composerDrafts.get(sessionId) || ""));
}

function syncComposerLock() {
  lockComposer(Boolean(activeApproval));
}

function doctorStatus(diagnostic) {
  if (diagnostic.installed !== true) {
    return {
      tone: "error",
      label: diagnostic.errorCode === "gui-only" ? "CLI 필요" : diagnostic.installed === null ? "실행 오류" : "설치 필요",
      detail: diagnostic.message || "CLI를 사용할 수 없습니다.",
    };
  }
  if (diagnostic.loggedIn === false) {
    return { tone: "error", label: "로그인 필요", detail: diagnostic.message || "로그인이 필요합니다." };
  }
  if (diagnostic.loggedIn === null) {
    return { tone: "warning", label: "CLI 확인됨", detail: diagnostic.message || "로그인 상태는 자동 확인할 수 없습니다." };
  }
  return { tone: "ready", label: "준비됨", detail: diagnostic.version || "CLI와 로그인을 확인했습니다." };
}

// 사이드바 하단 "환경 진단" 버튼에 확인이 필요한 에이전트 수를 표시합니다.
// AGY가 로그인 풀렸을 때처럼, 문제를 알아채는 곳과 고치는 버튼을 같은 자리에 둡니다.
function renderProviderHealth() {
  const attention = diagnostics.filter((diagnostic) => doctorStatus(diagnostic).tone === "error");
  doctorButton.classList.toggle("has-issue", attention.length > 0);
  doctorButton.dataset.issueCount = attention.length > 0 ? String(attention.length) : "";
  doctorButton.title = attention.length > 0
    ? `${attention.map((diagnostic) => diagnostic.name).join(", ")} 확인 필요 · 클릭해 진단`
    : "설치와 로그인 상태를 확인합니다";
}

function renderDoctor() {
  doctorList.textContent = "";
  const readyCount = diagnostics.filter((diagnostic) => doctorStatus(diagnostic).tone === "ready").length;
  const attentionCount = diagnostics.length - readyCount;
  doctorSummary.textContent = attentionCount > 0
    ? `${readyCount}개 준비됨 · ${attentionCount}개 확인이 필요해요.`
    : `${readyCount}개 에이전트가 모두 준비됐어요.`;

  for (const diagnostic of diagnostics) {
    const status = doctorStatus(diagnostic);
    const item = document.createElement("article");
    item.className = `doctor-item is-${status.tone}`;

    const marker = document.createElement("span");
    marker.className = "doctor-marker";
    marker.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "doctor-item-body";
    const title = document.createElement("div");
    title.className = "doctor-item-title";
    const name = document.createElement("strong");
    name.textContent = diagnostic.name;
    const badge = document.createElement("span");
    badge.className = "doctor-badge";
    badge.textContent = status.label;
    title.append(name, badge);
    const detail = document.createElement("p");
    detail.textContent = status.detail;
    body.append(title, detail);

    const actions = document.createElement("div");
    actions.className = "doctor-item-actions";
    if (diagnostic.installed !== true && diagnostic.installUrl) {
      const install = document.createElement("button");
      install.className = "button button-small";
      install.type = "button";
      install.textContent = "설치 안내";
      install.addEventListener("click", () => call(window.chatApi.openExternal(diagnostic.installUrl)));
      actions.append(install);
    } else if (diagnostic.loggedIn === false && diagnostic.loginCommand) {
      // 로그인은 설정의 계정 탭에서 앱 안으로 진행한다(터미널을 열지 않는다).
      // 명령 복사는 그 흐름이 막혔을 때의 대비책으로 남긴다.
      const login = document.createElement("button");
      login.className = "button button-small button-primary";
      login.type = "button";
      login.textContent = "로그인";
      login.title = "설정의 계정 탭에서 브라우저로 로그인합니다";
      login.addEventListener("click", () => {
        closeDoctor();
        window.chatApi.openSettings("accounts");
      });
      const copy = document.createElement("button");
      copy.className = "button button-small";
      copy.type = "button";
      copy.textContent = "명령 복사";
      copy.title = `터미널에서 직접 실행할 명령: ${diagnostic.loginCommand}`;
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(diagnostic.loginCommand);
          flashNotice(`${diagnostic.loginCommand} 명령을 복사했습니다.`, false);
        } catch {
          flashNotice(`터미널에서 ${diagnostic.loginCommand} 명령을 실행해 주세요.`);
        }
      });
      actions.append(login, copy);
    }
    item.append(marker, body, actions);
    doctorList.append(item);
  }
}

function openDoctor({ firstRun = false } = {}) {
  renderDoctor();
  doctorBackdrop.hidden = false;
  if (firstRun) doctorBackdrop.dataset.firstRun = "true";
  doctorDone.focus();
}

function closeDoctor() {
  doctorBackdrop.hidden = true;
  delete doctorBackdrop.dataset.firstRun;
  localStorage.setItem(DOCTOR_SEEN_KEY, "true");
}

function makeAgentAvatar(agent, className = "avatar") {
  const visual = AGENT_VISUALS[agent?.id];
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.style.setProperty("--agent-color", agent?.color || "#52525b");
  avatar.style.setProperty("--agent-bg", visual?.background || agent?.color || "#e4e4e7");
  if (visual?.icon) {
    const logo = document.createElement("img");
    logo.className = "agent-logo";
    logo.src = visual.icon;
    logo.alt = `${agent.name} 공식 로고`;
    logo.draggable = false;
    avatar.append(logo);
  } else {
    avatar.textContent = (agent?.name || agent?.id || "?").slice(0, 1).toUpperCase();
  }
  return avatar;
}

function flashNotice(text, isError = true) {
  const persistent = storeWarning.dataset.persistent;
  const previousText = storeWarning.textContent;
  storeWarning.textContent = text;
  storeWarning.classList.toggle("is-error", isError);
  storeWarning.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (persistent) {
      // 저장소 경고(읽기 전용·손상)는 원래 내용으로 복원하고 자동으로 숨기지 않는다.
      storeWarning.textContent = previousText;
      storeWarning.classList.add("is-error");
    } else {
      storeWarning.hidden = true;
    }
  }, 5000);
}

async function call(promise) {
  try {
    const result = await promise;
    if (result && result.ok === false) {
      if (result.error) flashNotice(result.error);
      return null;
    }
    return result;
  } catch (error) {
    flashNotice(error?.message || String(error));
    return null;
  }
}

// --- 세션 사이드바 ---
function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "방금";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return new Date(ts).toLocaleDateString();
}

function baseName(dirPath) {
  const parts = String(dirPath || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || dirPath || "";
}

function activeProjectEntry() {
  return projects.find((project) => project.id === activeProjectId) || null;
}

// 프로젝트별 접힘 상태입니다. 기본은 펼침이고, 사용자가 접은 프로젝트만 기억합니다.
const PROJECT_TREE_CLOSED_KEY = "agora.chat.projectTreeClosed";

function readClosedProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECT_TREE_CLOSED_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

const closedProjects = readClosedProjects();

function persistClosedProjects() {
  localStorage.setItem(PROJECT_TREE_CLOSED_KEY, JSON.stringify([...closedProjects]));
}

function setProjectOpen(projectId, open) {
  if (open) closedProjects.delete(projectId);
  else closedProjects.add(projectId);
  persistClosedProjects();
}

// 현재 보고 있는 채팅이 접힌 프로젝트 안에 있으면 어디에 있는지 알 수 없습니다.
// 편집기들이 하는 것처럼, 선택된 항목은 항상 드러냅니다(이후 수동으로 접는 것은 그대로 유지).
let revealedSessionId = null;

function revealActiveSession() {
  if (!activeSessionId || activeSessionId === revealedSessionId) return;
  for (const [projectId, entries] of Object.entries(sessionsByProject)) {
    if (entries.some((entry) => entry.id === activeSessionId)) {
      // 소속 프로젝트를 실제로 찾았을 때만 처리 완료로 표시합니다. 세션 목록이
      // 아직 도착하지 않은 첫 렌더에서 표시해 버리면 이후 렌더가 모두 건너뜁니다.
      revealedSessionId = activeSessionId;
      setProjectOpen(projectId, true);
      return;
    }
  }
}

// 사이드바는 프로젝트를 토글로 삼는 트리 하나입니다. 각 프로젝트 아래에 그 프로젝트의
// 채팅이 들어가고, 행 우측의 +(새 채팅)·⋯(설정)으로 프로젝트 단위 동작을 수행합니다.
function renderProjects() {
  // 이름을 고치는 중에는 다시 그리지 않습니다. 다른 창에서 온 갱신 때문에
  // 입력창이 통째로 사라져 편집이 날아가는 사고를 막습니다. (commit이 끝나면 직접 호출합니다)
  if (renamingSessionId) {
    renderSessionsPending = true;
    return;
  }
  renderSessionsPending = false;
  revealActiveSession();
  projectListEl.textContent = "";

  for (const project of projects) {
    const item = document.createElement("li");
    item.className = "project-item";
    const isActive = project.id === activeProjectId;
    if (isActive) item.classList.add("is-active");
    const open = !closedProjects.has(project.id);

    const row = document.createElement("div");
    row.className = "project-row";

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "project-caret";
    caret.textContent = "›";
    caret.title = open ? "채팅 목록 접기" : "채팅 목록 펼치기";
    caret.setAttribute("aria-expanded", String(open));
    caret.setAttribute("aria-label", `${project.name} 채팅 목록 ${open ? "접기" : "펼치기"}`);
    if (open) caret.classList.add("is-open");
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      setProjectOpen(project.id, !open);
      renderProjects();
    });

    const select = document.createElement("button");
    select.type = "button";
    select.className = "project-select";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;
    select.append(name);
    // 연결된 폴더는 이름 옆의 흐린 접미사로만 붙입니다(VS Code/Slack식 한 줄 행).
    // 폴더명이 프로젝트 이름과 같으면 같은 단어를 두 번 보여줄 뿐이라 생략합니다.
    if (project.workspace) {
      const folder = baseName(project.workspace);
      select.title = project.workspace;
      if (folder !== project.name) {
        const workspace = document.createElement("span");
        workspace.className = "project-meta";
        workspace.textContent = folder;
        select.append(workspace);
      }
    }
    // 행 클릭 = 프로젝트 선택 + 펼침. 접기는 화살표로만 합니다.
    select.addEventListener("click", () => {
      setProjectOpen(project.id, true);
      if (project.id === activeProjectId) renderProjects();
      else void selectProject(project.id);
    });

    const actions = document.createElement("span");
    actions.className = "project-actions";
    const addChat = document.createElement("button");
    addChat.type = "button";
    addChat.className = "project-action";
    addChat.title = `${project.name}에 새 채팅 (Ctrl/⌘+N)`;
    addChat.setAttribute("aria-label", `${project.name}에 새 채팅`);
    addChat.textContent = "+";
    addChat.addEventListener("click", (event) => {
      event.stopPropagation();
      void createChatIn(project.id);
    });
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "project-action";
    settings.dataset.projectSettings = project.id;
    settings.title = "프로젝트 설정";
    settings.textContent = "⋯";
    settings.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectSettings(settings, project);
    });
    actions.append(addChat, settings);

    row.append(caret, select, actions);
    item.append(row);

    if (open) {
      const list = document.createElement("ul");
      list.className = "session-list project-sessions";
      // 새 채팅은 프로젝트 행 우측의 +가 맡는다. 예전에는 목록 맨 위에도 같은
      // 동작의 '＋ 새 채팅' 줄을 뒀는데, 채팅 행과 자리·들여쓰기가 같아 목록의
      // 한 줄로 읽혔다. 입구를 하나로 줄이고 그 +를 눈에 띄게 만든다.
      const entries = sessionsByProject[project.id] || [];
      for (const entry of entries) list.append(buildSessionItem(entry));
      item.append(list);
    }

    projectListEl.append(item);
  }
}

// 프로젝트에 새 채팅을 만들고 바로 입력할 수 있게 한다. 사이드바의 +, 목록의
// '새 채팅' 줄, Ctrl/⌘+N이 전부 여기로 온다.
let creatingChat = false;
async function createChatIn(projectId) {
  if (!projectId || creatingChat) return;
  creatingChat = true;
  try {
    setProjectOpen(projectId, true);
    const result = await call(window.chatApi.sessionsCreate(projectId));
    if (result) {
      applyFullState(result);
      // 만들고 나서 다시 입력창을 클릭하게 하지 않는다.
      composerInput.focus();
    }
  } finally {
    creatingChat = false;
  }
}

function openProjectSettings(anchor, project) {
  openPopover(anchor, (target) => {
    target.classList.add("is-project-settings");
    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = "프로젝트 설정";

    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 80;
    name.value = project.name || "";

    const context = document.createElement("textarea");
    context.className = "project-context-input";
    context.rows = 5;
    context.maxLength = 12000;
    context.placeholder = "이 프로젝트의 목적, 규칙, 배경을 적어 두세요.";
    context.value = project.context || "";

    const permission = document.createElement("select");
    for (const [value, label] of [
      ["chat", "대화만"],
      ["workspace-read", "워크스페이스 읽기"],
      ["workspace-write", "워크스페이스 쓰기"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.disabled = value !== "chat" && !project.workspace;
      permission.append(option);
    }
    permission.value = project.defaultPermissionMode || "chat";

    const workspaceField = document.createElement("div");
    workspaceField.className = "project-workspace-field";
    const workspace = document.createElement("span");
    workspace.className = "project-workspace-value";
    workspace.textContent = project.workspace ? baseName(project.workspace) : "연결된 폴더 없음";
    workspace.title = project.workspace || "";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.className = "button button-small";
    choose.textContent = "폴더 선택";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "text-button";
    clear.textContent = "해제";
    clear.hidden = !project.workspace;
    const syncWorkspaceField = (next) => {
      const hasWorkspace = Boolean(next?.workspace);
      workspace.textContent = hasWorkspace ? baseName(next.workspace) : "폴더 없음";
      workspace.title = next?.workspace || "";
      clear.hidden = !hasWorkspace;
      for (const option of permission.options) {
        option.disabled = option.value !== "chat" && !hasWorkspace;
      }
      if (!hasWorkspace && permission.value !== "chat") permission.value = "chat";
    };
    choose.addEventListener("click", async () => {
      const result = await call(window.chatApi.projectsWorkspaceChoose(project.id));
      if (result && !result.canceled) {
        syncWorkspaceField(result.project);
        if (result.projects) projects = result.projects;
        renderProjects();
      }
    });
    clear.addEventListener("click", async () => {
      const result = await call(window.chatApi.projectsWorkspaceClear(project.id));
      if (result) {
        syncWorkspaceField(result.project);
        if (result.projects) projects = result.projects;
        renderProjects();
      }
    });
    workspaceField.append(workspace, choose, clear);

    const defaultAgentControls = new Map();
    const defaultAgentSection = document.createElement("section");
    defaultAgentSection.className = "project-default-section";
    const defaultAgentTitle = document.createElement("strong");
    defaultAgentTitle.textContent = "새 채팅 기본 에이전트";
    const defaultAgentHint = document.createElement("p");
    defaultAgentHint.className = "popover-hint";
    defaultAgentHint.textContent = "기존 채팅에는 영향을 주지 않습니다.";
    defaultAgentSection.append(defaultAgentTitle, defaultAgentHint);
    for (const agent of agents) {
      const provider = providerById(agent.id);
      if (!provider) continue;
      const saved = project.defaultAgents?.[agent.id] || {};
      const row = document.createElement("div");
      row.className = "project-agent-default";
      const head = document.createElement("div");
      head.className = "project-agent-default-head";
      const label = document.createElement("strong");
      label.textContent = `@${agent.id}`;
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = typeof saved.enabled === "boolean" ? saved.enabled : agent.enabled;
      head.append(label, enabled);

      const model = document.createElement("select");
      const modelOptions = modelOptionsForProvider(provider, true);
      const savedFold = foldSavedModel(modelOptions, saved.model || agent.model || "default", saved.effort || agent.effort || "default");
      const currentModel = savedFold.model;
      if (!modelOptions.some((option) => option.id === currentModel)) {
        modelOptions.push({ id: currentModel, label: strayModelLabel(currentModel), efforts: [] });
      }
      for (const option of modelOptions) {
        const item = document.createElement("option");
        item.value = option.id;
        item.textContent = option.label || option.id;
        model.append(item);
      }
      model.value = currentModel;
      model.disabled = !agent.available;

      const effort = document.createElement("select");
      const populateDefaultEfforts = (selected) => {
        effort.textContent = "";
        const options = effortOptionsForModel(provider, model.value);
        if (options.length === 0) {
          const item = document.createElement("option");
          item.value = "default";
          item.textContent = "모델 고정";
          effort.append(item);
          effort.disabled = true;
          return;
        }
        for (const value of options) {
          const item = document.createElement("option");
          item.value = value;
          item.textContent = effortLabel(value);
          effort.append(item);
        }
        effort.value = options.includes(selected) ? selected : options[0];
        effort.disabled = !agent.available || options.length <= 1;
      };
      populateDefaultEfforts(savedFold.effort || "default");
      model.addEventListener("change", () => populateDefaultEfforts("default"));
      row.append(head, makeField("모델", model), makeField("추론", effort));
      defaultAgentSection.append(row);
      defaultAgentControls.set(agent.id, { enabled, model, effort });
    }

    // 토론 자동 기록: 실제 적용값(저장한 recordAgent, 없으면 옛 recorder→review 역할)을 보여 준다.
    const record = document.createElement("select");
    const recordOff = document.createElement("option");
    recordOff.value = "";
    recordOff.textContent = "기록 안 함";
    record.append(recordOff);
    for (const agent of agents) {
      if (!agent.available || (project.defaultAgents?.[agent.id]?.enabled ?? agent.enabled) === false) continue;
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `${agent.name} (@${agent.id})`;
      record.append(option);
    }
    record.value = typeof project.recordAgent === "string" ? project.recordAgent : project.legacyRecorder?.agentId || "";
    if (record.selectedIndex < 0) record.value = "";
    const recordInitial = record.value;

    const actions = document.createElement("div");
    actions.className = "project-popover-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "button button-primary";
    save.textContent = "저장";
    save.addEventListener("click", async () => {
      const defaultAgents = {};
      for (const [agentId, controls] of defaultAgentControls) {
        defaultAgents[agentId] = {
          enabled: controls.enabled.checked,
          model: controls.model.value,
          effort: controls.effort.value,
        };
      }
      const result = await call(window.chatApi.projectsUpdate(project.id, {
        name: name.value,
        context: context.value,
        defaultPermissionMode: permission.value,
        defaultAgents,
        // 건드리지 않았으면 보내지 않아 옛 역할 폴백을 그대로 둔다.
        ...(record.value !== recordInitial ? { recordAgent: record.value } : {}),
      }));
      if (result) {
        closePopover();
        applyFullState(result);
      }
    });
    actions.append(save);
    if (project.id !== "uncategorized") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger";
      remove.textContent = "프로젝트 삭제";
      remove.addEventListener("click", async () => {
        const yes = await confirmInApp(
          `"${project.name}" 프로젝트를 삭제할까요?\n포함된 대화는 분류되지 않음으로 이동합니다.`
        );
        if (!yes) return;
        const result = await call(window.chatApi.projectsDelete(project.id));
        if (result) {
          closePopover();
          applyFullState(result);
        }
      });
      actions.append(remove);
    }

    target.append(
      title,
      makeField("프로젝트 이름", name),
      makeField("공통 맥락", context),
      makeField("새 대화 기본 권한", permission),
      makeField("프로젝트 폴더", workspaceField),
      defaultAgentSection,
      makeField("토론 자동 기록", record),
      actions
    );
  });
}

async function selectProject(projectId) {
  if (projectId === activeProjectId) return;
  const result = await call(window.chatApi.projectsSelect(projectId));
  if (result) applyFullState(result);
}

function openNewProjectPopover(anchor) {
  openPopover(anchor, (target) => {
    target.classList.add("is-new-project");
    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = "새 프로젝트";

    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 80;
    name.placeholder = "프로젝트 이름";

    // 폴더 선택 영역
    let selectedWorkspace = null;
    const workspaceField = document.createElement("div");
    workspaceField.className = "project-workspace-field";
    const workspaceLabel = document.createElement("span");
    workspaceLabel.className = "project-workspace-label";
    workspaceLabel.textContent = "폴더 없음";
    const chooseBtn = document.createElement("button");
    chooseBtn.type = "button";
    chooseBtn.className = "button button-small";
    chooseBtn.textContent = "폴더 선택";
    chooseBtn.addEventListener("click", async () => {
      const result = await call(window.chatApi.workspacePick());
      if (result?.workspace) {
        selectedWorkspace = result.workspace;
        workspaceLabel.textContent = baseName(selectedWorkspace);
        workspaceLabel.title = selectedWorkspace;
        clearBtn.hidden = false;
      }
    });
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "button button-small";
    clearBtn.textContent = "제거";
    clearBtn.hidden = true;
    clearBtn.addEventListener("click", () => {
      selectedWorkspace = null;
      workspaceLabel.textContent = "폴더 없음";
      workspaceLabel.title = "";
      clearBtn.hidden = true;
    });
    workspaceField.append(workspaceLabel, chooseBtn, clearBtn);

    const actions = document.createElement("div");
    actions.className = "project-popover-actions";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "button button-primary";
    create.textContent = "만들기";
    create.addEventListener("click", async () => {
      if (!name.value.trim()) {
        name.focus();
        return;
      }
      const result = await call(window.chatApi.projectsCreate(name.value, selectedWorkspace));
      if (result) {
        closePopover();
        applyFullState(result);
      }
    });
    actions.append(create);
    target.append(title, makeField("이름", name), makeField("프로젝트 폴더", workspaceField), actions);
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) create.click();
    });
    requestAnimationFrame(() => name.focus());
  });
}

function openSessionMovePopover(anchor, session) {
  openPopover(anchor, (target) => {
    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = "대화를 프로젝트로 이동";
    target.append(title);

    for (const project of projects) {
      const row = document.createElement("div");
      row.className = "project-move-row";

      const option = document.createElement("button");
      option.type = "button";
      option.className = "project-move-option";
      option.textContent = project.id === activeProjectId
        ? `${project.name} (현재)`
        : project.name;
      option.disabled = project.id === activeProjectId;
      row.append(option);

      option.addEventListener("click", async () => {
        const result = await call(
          window.chatApi.sessionsMove(session.id, project.id)
        );
        if (result) {
          closePopover();
          applyFullState(result);
        }
      });
      target.append(row);
    }
  });
}

// 채팅 목록은 프로젝트 트리 안에 그려지므로, 세션 렌더 = 트리 전체 렌더입니다.
// (이름 편집 가드는 renderProjects가 담당합니다)
function renderSessions() {
  renderProjects();
}

function buildSessionItem(entry) {
  {
    const item = document.createElement("li");
    item.className = "session-item";
    item.dataset.sessionId = entry.id;
    if (entry.id === activeSessionId) item.classList.add("is-active");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "session-select";

    const titleLine = document.createElement("span");
    titleLine.className = "session-title-line";
    if (entry.status === "running") {
      const dot = document.createElement("i");
      dot.className = "session-status is-running";
      dot.title = "실행 중";
      titleLine.append(dot);
    } else if (entry.status === "interrupted") {
      const dot = document.createElement("i");
      dot.className = "session-status is-interrupted";
      dot.title = "이전 실행이 중단되었습니다";
      titleLine.append(dot);
    }
    const titleText = document.createElement("span");
    titleText.className = "session-name";
    titleText.dataset.sessionName = entry.id;
    titleText.textContent = entry.title;
    titleLine.append(titleText);

    // 시각도 제목과 같은 줄에 흐리게 붙입니다. 부모(프로젝트)가 한 줄인데
    // 자식이 두 줄이면 위계가 뒤집혀 보입니다.
    // 워크스페이스는 프로젝트 단위 설정이라 채팅마다 다시 알리지 않습니다.
    const time = document.createElement("span");
    time.className = "session-meta";
    time.textContent = formatRelativeTime(entry.updatedAt);
    titleLine.append(time);
    main.append(titleLine);
    main.addEventListener("click", () => selectSession(entry.id));
    main.addEventListener("dblclick", () => startSessionRename(entry.id));

    // 아이콘 3개를 제목 위에 겹쳐 두는 대신 ⋯ 하나로 모았습니다.
    // 항상 자리를 차지하므로 제목을 가리지 않고, hover 전에도 조준할 수 있습니다.
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "session-action";
    moreBtn.dataset.sessionMore = entry.id;
    moreBtn.title = "이름 바꾸기 · 이동 · 삭제";
    moreBtn.setAttribute("aria-label", `${entry.title} 메뉴 열기`);
    moreBtn.setAttribute("aria-haspopup", "true");
    moreBtn.textContent = "⋯";
    moreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      // 이름 편집 중이었다면 blur → commit → 재렌더로 이 버튼이 교체됐을 수 있습니다.
      // 그때는 새로 그려진 같은 세션의 버튼을 기준점으로 씁니다.
      const anchor = sessionMoreAnchor(entry.id) || moreBtn;
      openSessionMenu(anchor.getBoundingClientRect(), entry);
    });

    // 목록 어디를 우클릭해도 같은 메뉴가 커서 위치에 열립니다.
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSessionMenu(pointRect(event), entry);
    });

    item.append(main, moreBtn);
    return item;
  }
}

function sessionMoreAnchor(sessionId) {
  return projectListEl.querySelector(`[data-session-more="${CSS.escape(sessionId)}"]`);
}

// 사이드바 목록에서 해당 대화의 제목을 인라인 편집으로 바꿉니다.
function startSessionRename(sessionId) {
  const titleEl = projectListEl.querySelector(`[data-session-name="${CSS.escape(sessionId)}"]`);
  if (!titleEl) return;
  titleEl.scrollIntoView({ block: "nearest" });
  startInlineRename(titleEl, sessionId);
}

// 상단 제목에서 바로 편집합니다. (사이드바가 접혀 있을 때의 F2 경로이기도 합니다)
// 버튼 안에 input을 넣으면 포커스가 먹지 않으므로 버튼 자체를 input으로 갈아 끼웁니다.
// startInlineRename이 commit에서 원래 요소를 되돌려 놓습니다.
function startHeaderRename() {
  const entry = activeSessionEntry();
  if (!entry || renamingSessionId) return;
  startInlineRename(sessionTitleEl, entry.id);
}

async function deleteSession(entry) {
  const yes = await confirmInApp(
    `"${entry.title}" 세션을 휴지통으로 옮길까요?\n첨부 사본도 함께 이동하며 30일 후 정리됩니다.`
  );
  if (!yes) return;
  const result = await call(window.chatApi.sessionsDelete(entry.id));
  if (!result) return;
  applyFullState(result);
  // 방을 옮기며 보관한 초안까지 지우도록 상태를 적용한 뒤에 정리한다.
  forgetRoom(entry.id);
}

function openSessionMenu(rect, entry) {
  openPopoverAt(rect, (target) => {
    buildPopoverMenu(target, [
      {
        label: "이름 바꾸기",
        hint: "F2",
        run: () => {
          closePopover();
          startSessionRename(entry.id);
        },
      },
      {
        label: "다른 프로젝트로 이동",
        run: () => {
          closePopover();
          // 팝오버 요소는 하나뿐이라, 닫고 다음 프레임에 이동 팝오버를 다시 엽니다.
          requestAnimationFrame(() => {
            const anchor = sessionMoreAnchor(entry.id);
            if (anchor) openSessionMovePopover(anchor, entry);
          });
        },
      },
      {
        label: "휴지통으로 이동",
        danger: true,
        run: () => {
          closePopover();
          void deleteSession(entry);
        },
      },
    ]);
  });
}

function startInlineRename(titleTextEl, sessionId) {
  if (renamingSessionId) return;
  renamingSessionId = sessionId;
  const current = titleTextEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.setAttribute("aria-label", "대화 이름");
  input.value = current;
  input.maxLength = 80;
  titleTextEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    renamingSessionId = null;
    const next = input.value.trim();
    input.replaceWith(titleTextEl);
    const changed = Boolean(save && next && next !== current);
    if (changed) {
      const result = await call(window.chatApi.sessionsRename(sessionId, next));
      if (result) {
        sessions = result.sessions || sessions;
        sessionsByProject = result.sessionsByProject || sessionsByProject;
        if (sessionMeta && sessionMeta.id === sessionId) {
          sessionMeta = { ...sessionMeta, title: next };
        }
      }
    }
    // 바뀐 게 없으면 목록을 건드리지 않습니다. blur 직후 목록을 통째로 새로 그리면
    // 그 blur를 일으킨 클릭(다른 항목의 ⋯ 등)이 사라진 요소 위에서 삼켜집니다.
    if (changed || renderSessionsPending) renderSessions();
    renderHeader();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) commit(true);
    if (event.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

async function selectSession(sessionId) {
  if (sessionId === activeSessionId) return;
  const result = await call(window.chatApi.sessionsSelect(sessionId));
  if (result) applyFullState(result);
}

// --- 헤더 ---
function activeSessionEntry() {
  return sessions.find((entry) => entry.id === activeSessionId) || null;
}

function renderHeader() {
  const entry = activeSessionEntry();
  sessionTitleEl.textContent = sessionMeta?.title || entry?.title || "세션";

  const workspace = activeProjectEntry()?.workspace || null;
  workspaceLabel.textContent = workspace ? baseName(workspace) : "워크스페이스 없음";
  workspaceButton.title = workspace
    ? `${workspace}\n프로젝트 설정(⋯)에서 변경합니다`
    : "프로젝트 설정(⋯)에서 사용할 폴더를 선택합니다";

  const mode = sessionMeta?.permissionMode || "chat";
  permissionSelect.value = mode;
  for (const option of permissionSelect.options) {
    if (option.value !== "chat") {
      option.disabled = !workspace;
      option.title = workspace ? "" : "먼저 워크스페이스를 선택하세요";
    }
  }

  const hints = [];
  const enforcementKinds = new Set();
  for (const provider of providers) {
    if (provider.status !== "cli") continue;
    const info = provider.permissions?.[mode];
    if (!info) continue;
    const label = ENFORCEMENT_LABEL[info.enforcement] || info.enforcement;
    hints.push(`${provider.name}: ${label}`);
    enforcementKinds.add(label);
  }
  // 좁은 상단 바에서 "적용 방식 — AGY: 샌드박스"가 "적…"으로 잘려 정보가 0이 되던 자리입니다.
  // 화면에는 적용 방식 종류만 짧게 남기고, 공급자별 상세는 툴팁으로 넘깁니다.
  const enforcementDetail = hints.length > 0 ? `적용 방식 — ${hints.join(" · ")}` : "";
  enforcementHint.textContent = [...enforcementKinds].join(" · ");
  enforcementHint.title = enforcementDetail;
  permissionSelect.title = enforcementDetail || "이 채팅에서 도구에 허용할 범위입니다";

  renderProviderHealth();

  const discussable = agents.filter((agent) => agent.available && agent.enabled).length >= 2;
  discussionButton.disabled = !discussable;
  discussionButton.title = discussable
    ? "활성 에이전트들이 정해진 라운드만큼 토론합니다"
    : "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다";
  // discussable = 사용 가능하고 참여 중인 에이전트가 둘 이상.
  responseModeBar.hidden = !discussable;
}

// 참가자 칩 툴팁. 칩 본문은 @id라 이름이 드러나지 않으므로, 세로 레일이 들고
// 있던 "이름 + 못 쓰는 이유"를 이 자리로 옮긴다. 레일을 지우면서 그 정보가
// 사라지지 않게 하는 유일한 자리다.
function agentChipHint(agent) {
  const name = agent?.name || `@${agent?.id ?? ""}`;
  const unavailable = agentUnavailableReason(agent);
  return unavailable ? `${name} · ${unavailable}` : `${name} 담당 모델·추론 설정`;
}

// --- 에이전트 칩 + 팝오버 ---
function renderAgents() {
  agentChips.textContent = "";
  for (const agent of agents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agent-chip";
    chip.dataset.agentId = agent.id;
    chip.style.setProperty("--agent-color", agent.color);
    if (!agent.available || !agent.enabled) chip.classList.add("is-unavailable");
    if (typingAgents.has(agent.id)) chip.classList.add("is-typing");
    // 되질문으로 끝나 답을 기다리는 에이전트는 칩에도 표시해, 참여자 줄만 봐도
    // 누가 대기 중인지 알 수 있게 한다(상세 질문은 아래 답변 대기 바에서).
    const awaiting = showAwaiting && Boolean(agent.awaitingUser);
    if (awaiting) chip.classList.add("is-awaiting");
    chip.title = awaiting
      ? agent.awaitingQuestion
        ? `답변 대기 — ${agent.awaitingQuestion}`
        : "이 에이전트가 당신의 답을 기다립니다"
      : agentChipHint(agent);
    chip.setAttribute("aria-label", chip.title);

    const avatar = makeAgentAvatar(agent, "agent-avatar");
    chip.append(avatar, document.createTextNode(`@${agent.id}`));
    if (awaiting) {
      const dot = document.createElement("span");
      dot.className = "agent-chip-await-dot";
      dot.setAttribute("aria-hidden", "true");
      chip.append(dot);
    }
    chip.addEventListener("click", () => openAgentPopover(chip, agent.id));
    agentChips.append(chip);
  }
  renderAwaitingRow();
}

// 되질문으로 턴을 끝낸 에이전트를 composer 위에 모아 보여준다(awaiting-view.js).
function renderAwaitingRow() {
  awaitingView.renderAwaitingRow({
    container: awaitingRow,
    agents: showAwaiting ? agents : [],
    document,
    makeAgentAvatar,
    onAnswer: answerAwaitingAgent,
    onDismiss: dismissAwaitingAgent,
  });
}

// ×: 답하지 않고 그 에이전트의 대기만 지운다. 상태는 방(main)이 갖고 있으므로
// IPC로 지우고, 갱신된 에이전트 목록(chat:agents)이 돌아오면 바가 다시 그려진다.
async function dismissAwaitingAgent(agentId) {
  try {
    await window.chatApi.awaitingDismiss(activeSessionId, agentId);
  } catch (error) {
    console.error("답변 대기를 지우지 못했습니다.", error);
  }
}

// 대기 중인 에이전트에게 곧장 답하도록 입력창에 @id를 채우고 포커스를 준다.
// 보기(option)를 주면 "@id <보기>"까지 채운다. 전송은 하지 않아 사용자가
// 문구를 다듬거나 다른 답으로 바꿀 수 있다.
function answerAwaitingAgent(agentId, option = "") {
  if (!composerInput) return;
  let current = composerInput.value || "";
  // @id가 앞에 없으면 붙인다(이미 그 에이전트를 겨냥해 쓰던 중이면 유지).
  if (!current.trimStart().startsWith(`@${agentId}`)) {
    current = `@${agentId} ${current.trimStart()}`;
  }
  if (option) {
    current = `${current.replace(/\s+$/, "")} ${option}`;
  }
  composerInput.value = current;
  composerInput.focus();
  const caret = composerInput.value.length;
  try {
    composerInput.setSelectionRange(caret, caret);
  } catch {}
  autoresize();
}

const POPOVER_VARIANTS = ["is-project-settings", "is-new-project", "is-workflow", "is-menu", "is-usage", "is-agent"];

function closePopover() {
  popover.hidden = true;
  popover.textContent = "";
  popover.classList.remove(...POPOVER_VARIANTS);
  popoverBackdrop.hidden = true;
  popoverBackdrop.classList.remove("is-pass-through");
  usagePopoverOpen = false;
}

// 버튼 대신 커서 좌표에도 띄울 수 있도록 위치 계산을 rect 기준으로 분리했습니다.
// (세션 우클릭 메뉴가 이 형태를 씁니다.)
function openPopoverAt(rect, build) {
  popover.textContent = "";
  popover.classList.remove(...POPOVER_VARIANTS);
  popoverBackdrop.classList.remove("is-pass-through");
  build(popover);
  popover.hidden = false;
  popoverBackdrop.hidden = false;
  // 위치 계산 전에 이전 위치를 지워 크기를 정확히 측정합니다.
  popover.style.top = "0px";
  popover.style.left = "0px";

  const margin = 8;
  const popRect = popover.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // 가로: 기준 버튼 왼쪽에 맞추되 화면 밖으로 나가지 않게 합니다.
  const left = Math.max(
    margin,
    Math.min(rect.left, viewportWidth - popRect.width - margin)
  );

  // 세로: 버튼 아래를 우선하고, 자리가 부족하면 위쪽에 붙입니다.
  // 양쪽 모두 부족하면(내용이 화면보다 긴 경우) 위에서 여백만큼 띄우고
  // 팝오버 내부 스크롤(CSS max-height)로 나머지를 처리합니다.
  const spaceBelow = viewportHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  let top;
  if (popRect.height <= spaceBelow) {
    top = rect.bottom + 6;
  } else if (popRect.height <= spaceAbove) {
    top = rect.top - popRect.height - 6;
  } else {
    top = Math.max(margin, viewportHeight - popRect.height - margin);
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function openPopover(anchor, build) {
  openPopoverAt(anchor.getBoundingClientRect(), build);
}

// 커서 좌표를 rect처럼 다룹니다. 폭·높이가 0이라 팝오버가 클릭 지점에 딱 붙습니다.
function pointRect(event) {
  return {
    left: event.clientX,
    right: event.clientX,
    top: event.clientY,
    bottom: event.clientY,
  };
}

// 팝오버를 단순 메뉴로 채웁니다. items: { label, hint?, danger?, run }
function buildPopoverMenu(target, items) {
  target.classList.add("is-menu");
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "popover-menu-item is-danger" : "popover-menu-item";
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    if (item.hint) {
      const hint = document.createElement("kbd");
      hint.className = "popover-menu-hint";
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener("click", () => item.run());
    target.append(button);
  }
}

popoverBackdrop.addEventListener("click", closePopover);

// 운영체제 확인창(window.confirm) 대신 쓰는 창 안 확인. Windows에서 네이티브
// 확인창을 닫고 돌아오면 입력칸에 파란 테두리는 보이는데 키 입력이 들어가지
// 않는 상태가 남을 수 있다(도구 자동 승인 재체크에서 겪은 증상). 사용자가
// 창 밖을 한 번 눌렀다 돌아와야 풀렸으므로, 채팅 창의 확인은 모두 이 창으로 받는다.
function confirmInApp(message) {
  settleConfirm(false);
  const returnFocus = document.activeElement;
  confirmMessage.textContent = message;
  confirmBackdrop.hidden = false;
  confirmCancel.focus();
  return new Promise((resolve) => {
    confirmResolve = (value) => {
      confirmResolve = null;
      confirmBackdrop.hidden = true;
      if (returnFocus?.isConnected && !returnFocus.disabled && typeof returnFocus.focus === "function") {
        returnFocus.focus();
      }
      resolve(value);
    };
  });
}

function settleConfirm(value) {
  confirmResolve?.(value);
}

confirmOk.addEventListener("click", () => settleConfirm(true));
confirmCancel.addEventListener("click", () => settleConfirm(false));
confirmBackdrop.addEventListener("click", (event) => {
  if (event.target === confirmBackdrop) settleConfirm(false);
});
// Escape는 확인만 닫는다. 창 전체 단축키(팝오버 닫기·새 채팅)까지 전달하지 않는다.
confirmBackdrop.addEventListener("keydown", (event) => {
  if (event.key === "Escape") settleConfirm(false);
  event.stopPropagation();
});
// 모델 팝오버는 바깥 클릭이 실제 입력창까지 닿게 한다. 배경막에서 focus()만
// 호출하면 Windows IME가 실제 클릭으로 포커스를 바꾼 것으로 인식하지 못할 수 있다.
document.addEventListener("pointerdown", (event) => {
  if (popover.hidden || !popover.classList.contains("is-agent") || popover.contains(event.target)) return;
  if (event.target === composerInput && document.activeElement === composerInput) composerInput.blur();
  closePopover();
}, true);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) closePopover();
  // Ctrl/⌘+N — 지금 프로젝트에 새 채팅. 이름을 고치는 중에는 그 편집이 우선이다.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
    && String(event.key).toLowerCase() === "n" && activeProjectId && !renamingSessionId) {
    event.preventDefault();
    void createChatIn(activeProjectId);
  }
  // F2로 현재 대화 이름을 바로 고칩니다. 사이드바가 접혀 있으면 상단 제목에서 편집합니다.
  if (event.key === "F2" && activeSessionId && !renamingSessionId) {
    event.preventDefault();
    if (appEl.classList.contains("is-sidebar-collapsed")) startHeaderRename();
    else startSessionRename(activeSessionId);
  }
});

// 창 크기가 바뀌면 기준 버튼과 어긋나므로 닫습니다.
window.addEventListener("resize", () => {
  if (!popover.hidden) closePopover();
});

function makeField(labelText, control) {
  const field = document.createElement("label");
  field.className = "popover-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

// 다른 에이전트의 메시지를 선택한 에이전트에게 전달(Handoff)해 이어서 답하게 합니다.
function openHandoffPopover(anchor, messageId, sourceAuthor) {
  const options = agents.filter((agent) => agent.available && agent.enabled !== false && agent.id !== sourceAuthor);
  if (options.length === 0) {
    openPopover(anchor, (root) => {
      const head = document.createElement("div");
      head.className = "popover-head";
      const title = document.createElement("strong");
      title.textContent = "전달할 에이전트가 없습니다";
      head.append(title);
      root.append(head);
      const p = document.createElement("p");
      p.className = "popover-status";
      p.textContent = "현재 사용 가능한 다른 에이전트가 없습니다.";
      root.append(p);
    });
    return;
  }

  openPopover(anchor, (root) => {
    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("strong");
    title.textContent = `메시지 전달 · 출처 @${sourceAuthor}`;
    head.append(title);
    root.append(head);

    const targetSelect = document.createElement("select");
    for (const agent of options) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `${agent.name} (@${agent.id})`;
      targetSelect.append(option);
    }
    root.append(makeField("전달할 에이전트", targetSelect));

    const intentSelect = document.createElement("select");
    const intentContinue = document.createElement("option");
    intentContinue.value = "CONTINUE";
    intentContinue.textContent = "이어서 작업";
    const intentReview = document.createElement("option");
    intentReview.value = "REVIEW_OPINION";
    intentReview.textContent = "검토 요청";
    const intentSimplify = document.createElement("option");
    intentSimplify.value = "SIMPLIFY";
    intentSimplify.textContent = "쉽게 설명";
    intentSelect.append(intentContinue, intentReview, intentSimplify);
    root.append(makeField("전달 목적", intentSelect));

    const actions = document.createElement("div");
    actions.className = "popover-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "취소";
    cancel.addEventListener("click", closePopover);
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "button-primary";
    confirm.textContent = "전달";
    confirm.addEventListener("click", async () => {
      const intent = intentSelect.value;
      const target = targetSelect.value;
      if (!target) {
        closePopover();
        flashNotice("전달 대상 에이전트를 찾을 수 없습니다.");
        return;
      }
      closePopover();
      await call(
        window.chatApi.handoffMessage(sessionMeta?.id, target, messageId, intent)
      );
    });
    actions.append(cancel, confirm);
    root.append(actions);
  });
}

// 토론 결론 종합 팝오버: 사용자가 요약할 에이전트를 선택합니다.
function openDiscussionSummaryPopover(anchor, discussionMeta) {
  const availableAgents = agents.filter((agent) => agent.available && agent.enabled !== false);
  if (availableAgents.length === 0) {
    flashNotice("사용 가능한 에이전트가 없습니다.");
    return;
  }
  openPopover(anchor, (root) => {
    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("strong");
    title.textContent = "토론 결론 종합";
    head.append(title);
    root.append(head);

    const p = document.createElement("p");
    p.className = "popover-status";
    p.textContent = discussionMeta.incomplete
      ? "토론이 미완성 상태로 종료되었습니다. 요약할 모델을 선택하세요."
      : "토론 내용을 분석하고 결론을 정리할 모델을 선택하세요.";
    root.append(p);

    const select = document.createElement("select");
    for (const agent of availableAgents) {
      const opt = document.createElement("option");
      opt.value = agent.id;
      opt.textContent = `${agent.name} (@${agent.id})`;
      select.append(opt);
    }
    root.append(makeField("요약자 선택", select));

    const actions = document.createElement("div");
    actions.className = "popover-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "취소";
    cancel.addEventListener("click", closePopover);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "button-primary";
    confirm.textContent = "요약 시작";
    confirm.addEventListener("click", async () => {
      const agentId = select.value;
      closePopover();
      anchor.disabled = true;
      const originalLabel = anchor.textContent;
      anchor.textContent = "요약 중...";
      try {
        await call(window.chatApi.discussionSummarize(sessionMeta?.id, discussionMeta.discussionId, agentId));
      } finally {
        anchor.disabled = false;
        anchor.textContent = originalLabel;
      }
    });
    actions.append(cancel, confirm);
    root.append(actions);
  });
}

function openAgentPopover(anchor, agentId) {
  const agent = agentById(agentId);
  const provider = providerById(agentId);
  if (!agent || !provider) return;
  const config = sessionMeta?.agents?.[agentId] || {};

  openPopover(anchor, (root) => {
    root.classList.add("is-agent");
    popoverBackdrop.classList.add("is-pass-through");
    const head = document.createElement("div");
    head.className = "popover-head";
    const dot = makeAgentAvatar(agent, "popover-avatar");
    const name = document.createElement("strong");
    name.textContent = `${agent.name} (@${agent.id})`;
    head.append(dot, name);
    root.append(head);

    const status = document.createElement("p");
    status.className = "popover-status";
    if (provider.status === "cli") {
      status.textContent = `CLI 확인됨 · ${provider.version || ""}`;
    } else {
      status.classList.add("is-warning");
      status.textContent = provider.reason || "CLI를 사용할 수 없습니다.";
    }
    root.append(status);

    // 참가 토글
    const enableToggle = document.createElement("input");
    enableToggle.type = "checkbox";
    enableToggle.checked = agent.enabled;
    enableToggle.disabled = !provider.available;
    enableToggle.addEventListener("change", () => {
      configureAgent(agentId, { enabled: enableToggle.checked });
    });
    root.append(makeField("이 세션에 참여", enableToggle));

    // 모델 선택
    const modelSelect = document.createElement("select");
    const modelOptions = modelOptionsForProvider(provider);
    // 저장된 노력 변형(gemini-3.8-flash-high)은 접힌 베이스로 옮겨 선택한다.
    const savedFold = foldSavedModel(modelOptions, agent.model, agent.effort);
    for (const model of modelOptions) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label || model.id;
      modelSelect.append(option);
    }
    const currentModel = savedFold.model;
    if (!modelOptions.some((option) => option.id === currentModel)) {
      const legacyOption = document.createElement("option");
      legacyOption.value = currentModel;
      legacyOption.textContent = strayModelLabel(currentModel, "현재 설정 · 목록에 없음");
      modelSelect.append(legacyOption);
    }
    modelSelect.value = currentModel;
    modelSelect.disabled = !provider.available;
    modelSelect.addEventListener("change", () => {
      const availableEfforts = effortOptionsForModel(provider, modelSelect.value);
      // 모델을 바꿔도 쓰던 노력 단계를 유지합니다. 그 모델에 없는 단계면 중간 → 첫 번째 순.
      const currentEffort = effortSelect.value;
      const nextEffort = availableEfforts.includes(currentEffort)
        ? currentEffort
        : availableEfforts.includes("medium") ? "medium" : availableEfforts[0] || "default";
      populateEfforts(modelSelect.value, nextEffort);
      configureAgent(agentId, { model: modelSelect.value, effort: nextEffort });
    });
    root.append(makeField("모델", modelSelect));

    // 속도/노력 선택
    const effortSelect = document.createElement("select");
    function populateEfforts(modelId, selected) {
      effortSelect.textContent = "";
      const efforts = effortOptionsForModel(provider, modelId);
      if (efforts.length === 0) {
        const option = document.createElement("option");
        option.value = "default";
        option.textContent = "모델 고정";
        effortSelect.append(option);
        effortSelect.value = "default";
        effortSelect.disabled = true;
        return;
      }
      for (const effort of efforts) {
        const option = document.createElement("option");
        option.value = effort;
        option.textContent = effortLabel(effort);
        effortSelect.append(option);
      }
      effortSelect.value = efforts.includes(selected) ? selected : efforts[0] || "";
      effortSelect.disabled = !provider.available || efforts.length <= 1;
    }
    populateEfforts(currentModel, savedFold.effort || agent.effort);
    if (effortSelect.disabled && provider.status !== "cli") {
      effortSelect.title = "CLI 설치 후 사용할 수 있습니다";
    } else if (effortOptionsForModel(provider, currentModel).length === 0) {
      effortSelect.title = "이 모델은 추론 강도가 고정되어 있습니다";
    } else if (effortOptionsForModel(provider, currentModel).length <= 1) {
      effortSelect.title = "이 모델에서 사용할 수 있는 추론 강도가 하나입니다";
    }
    effortSelect.addEventListener("change", () => {
      configureAgent(agentId, { effort: effortSelect.value });
    });
    root.append(makeField("속도/노력", effortSelect));

    const autoApproveToggle = document.createElement("input");
    autoApproveToggle.type = "checkbox";
    const isWriteMode = sessionMeta?.permissionMode === "workspace-write";
    // 저장된 autoApprove 값은 쓰기 모드에서만 실제로 적용됩니다.
    // 읽기 모드에서는 체크표시를 시각적으로 해제해 "자동 승인이 켜져 있다"는 오해를 막습니다.
    autoApproveToggle.checked = isWriteMode && Boolean(config.autoApprove);
    autoApproveToggle.disabled = !provider.available || !isWriteMode;
    autoApproveToggle.title = autoApproveToggle.disabled
      ? "워크스페이스 쓰기 권한에서만 사용할 수 있습니다"
      : "이 에이전트가 요청하는 도구 권한을 개별 확인 없이 승인합니다";
    root.append(makeField("도구 자동 승인", autoApproveToggle));
    // Windows의 동기 confirm 창에서 돌아오면 DOM focus와 키보드 focus가
    // 어긋날 수 있다. 같은 패널 안에서 명시적으로 확인받는다.
    const autoApproveConfirmation = document.createElement("div");
    autoApproveConfirmation.hidden = true;
    const warning = document.createElement("p");
    warning.className = "popover-hint";
    warning.textContent = `${agent.name}의 명령 실행과 파일 변경이 개별 확인 없이 진행됩니다. 신뢰하는 워크스페이스에서만 자동 승인을 켜세요.`;
    const confirmationActions = document.createElement("div");
    confirmationActions.className = "popover-actions";
    const cancelAutoApprove = document.createElement("button");
    cancelAutoApprove.type = "button";
    cancelAutoApprove.textContent = "취소";
    const confirmAutoApprove = document.createElement("button");
    confirmAutoApprove.type = "button";
    confirmAutoApprove.textContent = "자동 승인 켜기";
    confirmationActions.append(cancelAutoApprove, confirmAutoApprove);
    autoApproveConfirmation.append(warning, confirmationActions);
    root.append(autoApproveConfirmation);
    const configuredSessionId = activeSessionId;
    async function saveAutoApprove(enabled) {
      autoApproveConfirmation.hidden = true;
      if (configuredSessionId !== activeSessionId) return;
      autoApproveToggle.disabled = true;
      try {
        const result = await configureAgent(agentId, { autoApprove: enabled });
        if (result?.meta) autoApproveToggle.checked = enabled;
      } finally {
        autoApproveToggle.disabled = !provider.available || sessionMeta?.permissionMode !== "workspace-write";
      }
    }
    autoApproveToggle.addEventListener("change", () => {
      const enable = autoApproveToggle.checked;
      // 저장 성공 전까지 체크는 현재 설정을 나타낸다.
      autoApproveToggle.checked = !enable;
      if (enable) autoApproveConfirmation.hidden = false;
      else return saveAutoApprove(false);
    });
    cancelAutoApprove.addEventListener("click", () => {
      autoApproveConfirmation.hidden = true;
      autoApproveToggle.focus();
    });
    confirmAutoApprove.addEventListener("click", () => saveAutoApprove(true));

    if (provider.status === "gui-only" || provider.status === "absent") {
      const hint = document.createElement("p");
      hint.className = "popover-hint";
      hint.textContent =
        provider.status === "gui-only"
          ? "GUI 앱은 감지되었지만 CLI가 없어 채팅에는 참여할 수 없습니다."
          : "CLI가 설치되어 있지 않습니다.";
      root.append(hint);
    }
  });
}

async function configureAgent(agentId, patch) {
  return requestSessionMeta((sessionId) => window.chatApi.agentConfigure(sessionId, agentId, patch));
}

// 방 설정(참가자 모델·권한)을 바꾸고 응답을 화면에 적용한다. 기다리는 사이 방을
// 옮겼거나 더 나중 요청을 보냈으면 이 응답은 화면에 쓰지 않는다. 늦게 온 응답이
// 다른 방이나 더 최신 설정을 덮지 않게 하기 위해서다. 저장 성공 여부는 호출한
// 쪽이 알 수 있게 결과를 그대로 돌려준다.
async function requestSessionMeta(send) {
  const sessionId = activeSessionId;
  const request = ++sessionMetaRequest;
  const result = await call(send(sessionId));
  if (sessionId === activeSessionId && request === sessionMetaRequest) {
    if (result?.meta) sessionMeta = result.meta;
    renderHeader();
  }
  return result;
}

const WORKFLOW_STATUS_LABELS = Object.freeze({
  todo: "할 일",
  in_progress: "진행 중",
  review: "검토 중",
  done: "완료",
  blocked: "막힘",
});

function workflowRoleLabel(roleId) {
  return workflow.roles?.find((role) => role.id === roleId)?.label || roleId || "구현";
}

function workflowAgentLabel(agentId) {
  if (!agentId) return "담당자 미지정";
  const agent = agentById(agentId);
  return agent ? `@${agent.id}` : `@${agentId}`;
}

function workflowTextarea(placeholder, rows = 3) {
  const input = document.createElement("textarea");
  input.className = "workflow-textarea";
  input.rows = rows;
  input.maxLength = 20000;
  input.placeholder = placeholder;
  return input;
}

function makeDeliveryBadge(kind) {
  const badge = document.createElement("span");
  badge.className = "workflow-delivery-badge";
  if (kind === "always") {
    badge.classList.add("is-always");
    badge.textContent = "항상 전달";
  } else if (kind === "partial") {
    badge.classList.add("is-partial");
    badge.textContent = "최근 것만 전달";
  } else {
    badge.classList.add("is-none");
    badge.textContent = "전달 안 함";
  }
  return badge;
}

function openWorkflowPopover(anchor) {
  const project = activeProjectEntry();
  if (!project) return;

  openPopover(anchor, (root) => {
    root.classList.add("is-workflow");
    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = `${project.name} · 프로젝트 맥락`;
    root.append(title);

    const tabBar = document.createElement("div");
    tabBar.className = "workflow-tabs";
    const tabButtons = {};
    const tabPanels = {};
    const tabDefs = [
      ["memory", "메모리"],
      ["decisions", "결정"],
      ["tasks", "작업"],
    ];
    for (const [id, label] of tabDefs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workflow-tab-button";
      button.textContent = label;
      button.addEventListener("click", () => selectTab(id));
      tabBar.append(button);
      tabButtons[id] = button;
      const panel = document.createElement("div");
      panel.className = "workflow-tab-panel";
      tabPanels[id] = panel;
    }
    function selectTab(id) {
      for (const key of Object.keys(tabButtons)) {
        tabButtons[key].classList.toggle("is-active", key === id);
        tabPanels[key].classList.toggle("is-active", key === id);
      }
    }
    root.append(tabBar, tabPanels.memory, tabPanels.decisions, tabPanels.tasks);

    // === 메모리 탭: 개요 · 현재 규칙 · 누적 요약 ===
    const overviewSection = document.createElement("section");
    overviewSection.className = "workflow-section";
    const overviewTitle = document.createElement("strong");
    overviewTitle.append(
      document.createTextNode("프로젝트 개요 "),
      makeDeliveryBadge("always")
    );
    const overviewHint = document.createElement("p");
    overviewHint.className = "popover-hint";
    overviewHint.textContent = project.context
      ? project.context
      : "아직 개요가 없습니다. 프로젝트 설정에서 공통 맥락을 작성해 주세요.";
    overviewSection.append(overviewTitle, overviewHint);

    const rulesSection = document.createElement("section");
    rulesSection.className = "workflow-section";
    const rulesTitle = document.createElement("strong");
    rulesTitle.append(
      document.createTextNode("현재 규칙 "),
      makeDeliveryBadge("always")
    );
    const rulesHint = document.createElement("p");
    rulesHint.className = "popover-hint";
    rulesHint.textContent = "여기에 적은 내용은 모든 에이전트의 대화에 항상 함께 전달됩니다.";
    const rulesInput = workflowTextarea("예: 공개 API를 바꾸지 않는다.", 5);
    rulesInput.maxLength = 4000;
    const rulesCount = document.createElement("p");
    rulesCount.className = "workflow-count";
    const updateRulesCount = () => {
      rulesCount.textContent = `${rulesInput.value.length} / 4000`;
    };
    rulesInput.addEventListener("input", updateRulesCount);
    const rulesActions = document.createElement("div");
    rulesActions.className = "project-popover-actions";
    const rulesSave = document.createElement("button");
    rulesSave.type = "button";
    rulesSave.className = "button button-primary button-small";
    rulesSave.textContent = "규칙 저장";
    rulesSave.addEventListener("click", async () => {
      const result = await call(window.chatApi.rulesSave(project.id, rulesInput.value));
      if (result) {
        rulesInput.value = result.rules || "";
        updateRulesCount();
        flashNotice("규칙을 저장했습니다.", false);
      }
    });
    const historyToggle = document.createElement("button");
    historyToggle.type = "button";
    historyToggle.className = "button button-small";
    historyToggle.textContent = "이전 규칙 기록 보기";
    const historyBox = document.createElement("pre");
    historyBox.className = "workflow-card-text";
    historyBox.hidden = true;
    historyToggle.addEventListener("click", async () => {
      historyBox.hidden = !historyBox.hidden;
      if (!historyBox.hidden) {
        const result = await call(window.chatApi.rulesRead(project.id));
        historyBox.textContent = result?.history?.trim() || "기록된 변경 이력이 없습니다.";
      }
    });
    rulesActions.append(rulesSave, historyToggle);
    rulesSection.append(rulesTitle, rulesHint, rulesInput, rulesCount, rulesActions, historyBox);
    call(window.chatApi.rulesRead(project.id)).then((result) => {
      if (result) {
        rulesInput.value = result.rules || "";
        updateRulesCount();
      }
    });

    const memorySection = document.createElement("section");
    memorySection.className = "workflow-section";
    const memoryTitle = document.createElement("strong");
    memoryTitle.append(
      document.createTextNode("누적 요약 "),
      makeDeliveryBadge("partial")
    );
    const memoryHint = document.createElement("p");
    memoryHint.className = "popover-hint";
    memoryHint.textContent = "사람이 직접 추가한 기록과 기록관이 만든 초안이 이 프로젝트에 누적됩니다. 길어지면 오래된 순으로 일부만 전달됩니다.";
    const memoryPreviewLabel = document.createElement("p");
    memoryPreviewLabel.className = "workflow-field-label";
    memoryPreviewLabel.textContent = "\uD604\uC7AC \uAE30\uB85D (\uC77D\uAE30 \uC804\uC6A9)";
    const memoryPreview = document.createElement("textarea");
    memoryPreview.className = "project-context-input memory-preview";
    memoryPreview.rows = 6;
    memoryPreview.readOnly = true;
    memoryPreview.placeholder = "아직 기록이 없습니다.";
    const memoryInputLabel = document.createElement("p");
    memoryInputLabel.className = "workflow-field-label";
    memoryInputLabel.textContent = "\uC0C8 \uAE30\uB85D \uCD94\uAC00";
    const memoryInput = document.createElement("textarea");
    memoryInput.className = "project-context-input";
    memoryInput.rows = 3;
    memoryInput.maxLength = 24000;
    memoryInput.placeholder = "사람이 직접 남길 중요한 맥락";
    const memoryActions = document.createElement("div");
    memoryActions.className = "project-popover-actions";
    const memoryAdd = document.createElement("button");
    memoryAdd.type = "button";
    memoryAdd.className = "button button-small";
    memoryAdd.textContent = "기억 추가";
    memoryAdd.addEventListener("click", async () => {
      const content = memoryInput.value.trim();
      if (!content) {
        memoryInput.focus();
        return;
      }
      const result = await call(window.chatApi.memoryAppend(project.id, content, "사람이 추가한 기록"));
      if (result) {
        memoryPreview.value = result.memory || "";
        memoryInput.value = "";
        flashNotice("누적 요약에 기록했습니다.", false);
      }
    });
    memoryActions.append(memoryAdd);
    memorySection.append(
      memoryTitle,
      memoryHint,
      memoryPreviewLabel,
      memoryPreview,
      memoryInputLabel,
      memoryInput,
      memoryActions
    );
    call(window.chatApi.memoryRead(project.id)).then((result) => {
      if (result) memoryPreview.value = result.content || "";
    });

    tabPanels.memory.append(overviewSection, rulesSection, memorySection);

    // === 결정 탭 ===
    let editingDecisionId = null;
    const decisionTitle = document.createElement("input");
    decisionTitle.type = "text";
    decisionTitle.maxLength = 120;
    decisionTitle.placeholder = "결정 제목 (선택)";
    const decisionContent = workflowTextarea("예: 이번 프로젝트는 Agora의 기존 채팅 코어를 유지한다.", 4);
    const decisionActions = document.createElement("div");
    decisionActions.className = "project-popover-actions";
    const decisionSave = document.createElement("button");
    decisionSave.type = "button";
    decisionSave.className = "button button-primary";
    decisionSave.textContent = "결정 기록";
    const decisionCancel = document.createElement("button");
    decisionCancel.type = "button";
    decisionCancel.className = "button button-small";
    decisionCancel.textContent = "취소";
    decisionCancel.hidden = true;
    decisionActions.append(decisionSave, decisionCancel);
    const decisionForm = document.createElement("section");
    decisionForm.className = "workflow-section is-collapsed";
    decisionForm.hidden = true;
    const decisionFormToggle = document.createElement("button");
    decisionFormToggle.type = "button";
    decisionFormToggle.className = "button button-small";
    decisionFormToggle.textContent = "직접 결정 추가";
    decisionFormToggle.addEventListener("click", () => {
      decisionForm.hidden = !decisionForm.hidden;
    });
    const decisionFormTitle = document.createElement("strong");
    decisionFormTitle.textContent = "새 결정";
    const decisionLinkHint = document.createElement("p");
    decisionLinkHint.className = "popover-hint";
    const linkedMessageCount = Math.min(5, chatMessages.length);
    decisionLinkHint.textContent = linkedMessageCount > 0
      ? `현재 채팅과 최근 메시지 ${linkedMessageCount}개를 함께 기록합니다.`
      : "현재 채팅을 결정의 출처로 기록합니다.";
    decisionForm.append(
      decisionFormTitle,
      makeField("제목", decisionTitle),
      makeField("내용", decisionContent),
      decisionLinkHint,
      decisionActions
    );
    decisionCancel.addEventListener("click", () => {
      editingDecisionId = null;
      decisionTitle.value = "";
      decisionContent.value = "";
      decisionSave.textContent = "결정 기록";
      decisionCancel.hidden = true;
      decisionFormTitle.textContent = "새 결정";
    });
    decisionSave.addEventListener("click", async () => {
      const content = decisionContent.value.trim();
      if (!content) {
        flashNotice("결정 내용을 입력해 주세요.");
        decisionContent.focus();
        return;
      }
      const messageIds = chatMessages.slice(-5).map((message) => message.id).filter(Boolean);
      const result = editingDecisionId
        ? await call(window.chatApi.decisionsUpdate(project.id, editingDecisionId, {
            title: decisionTitle.value,
            content,
            chatId: activeSessionId,
            messageIds,
          }))
        : await call(window.chatApi.decisionsCreate({
            projectId: project.id,
            title: decisionTitle.value,
            content,
            chatId: activeSessionId,
            messageIds,
          }));
      if (!result) return;
      applyFullState(result);
      openWorkflowPopover(anchor);
    });

    const allDecisions = workflow.decisions || [];
    const proposedDecisions = allDecisions.filter((d) => d.status === "proposed");
    const confirmedDecisions = allDecisions.filter((d) => !d.status || d.status === "confirmed");
    const excludedDecisions = allDecisions.filter((d) => d.status === "rejected");

    const decisionProposalsSection = document.createElement("section");
    decisionProposalsSection.className = "workflow-section";
    if (proposedDecisions.length > 0) {
      const proposalsTitle = document.createElement("strong");
      proposalsTitle.textContent = `확인 대기 중인 결정 후보 (${proposedDecisions.length})`;
      decisionProposalsSection.append(proposalsTitle);
      for (const decision of proposedDecisions) {
        decisionProposalsSection.append(renderDecisionProposalCard(decision));
      }
    }

    function renderDecisionProposalCard(decision) {
      const card = document.createElement("article");
      card.className = "workflow-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "workflow-card-title";
      cardTitle.textContent = decision.title || "제목 없는 결정";
      const cardText = document.createElement("div");
      cardText.className = "workflow-card-text";
      cardText.textContent = decision.content;
      const actions = document.createElement("div");
      actions.className = "workflow-proposal-actions";
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "button button-primary button-small";
      approve.textContent = "승인";
      approve.addEventListener("click", async () => {
        const result = await call(window.chatApi.decisionsResolve(project.id, [decision.id], "approve"));
        if (result) { applyFullState(result); openWorkflowPopover(anchor); }
      });
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "button button-small";
      reject.textContent = "제외";
      reject.addEventListener("click", async () => {
        const result = await call(window.chatApi.decisionsResolve(project.id, [decision.id], "reject"));
        if (result) { applyFullState(result); openWorkflowPopover(anchor); }
      });
      actions.append(approve, reject);
      card.append(cardTitle, cardText, actions);
      return card;
    }

    const decisionsSection = document.createElement("section");
    decisionsSection.className = "workflow-section";
    const decisionsTitle = document.createElement("strong");
    decisionsTitle.textContent = "확정된 결정";
    decisionsSection.append(decisionsTitle);
    if (confirmedDecisions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "아직 확정된 결정이 없습니다.";
      decisionsSection.append(empty);
    }
    for (const decision of confirmedDecisions) {
      const card = document.createElement("article");
      card.className = "workflow-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "workflow-card-title";
      cardTitle.textContent = decision.title || "제목 없는 결정";
      const cardText = document.createElement("div");
      cardText.className = "workflow-card-text";
      cardText.textContent = decision.content;
      const meta = document.createElement("div");
      meta.className = "workflow-card-meta";
      const links = [decision.chatId ? "현재 채팅 연결" : "채팅 없음"];
      if (decision.messageIds?.length) links.push(`메시지 ${decision.messageIds.length}개`);
      meta.textContent = `${new Date(decision.updatedAt).toLocaleString()} · ${links.join(" · ")}`;
      const cardActions = document.createElement("div");
      cardActions.className = "workflow-card-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button button-small";
      edit.textContent = "수정";
      edit.addEventListener("click", () => {
        decisionForm.hidden = false;
        editingDecisionId = decision.id;
        decisionTitle.value = decision.title || "";
        decisionContent.value = decision.content;
        decisionSave.textContent = "결정 수정";
        decisionCancel.hidden = false;
        decisionFormTitle.textContent = "결정 수정";
        decisionContent.focus();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger button-small";
      remove.textContent = "삭제";
      remove.addEventListener("click", async () => {
        if (!(await confirmInApp("이 결정을 삭제할까요?"))) return;
        const result = await call(window.chatApi.decisionsDelete(project.id, decision.id));
        if (!result) return;
        applyFullState(result);
        openWorkflowPopover(anchor);
      });
      cardActions.append(edit, remove);
      card.append(cardTitle, cardText, meta, cardActions);
      decisionsSection.append(card);
    }

    const excludedSection = document.createElement("section");
    excludedSection.className = "workflow-section";
    const excludedTitle = document.createElement("strong");
    excludedTitle.textContent = `제외된 결정 (${excludedDecisions.length})`;
    excludedSection.append(excludedTitle);
    if (excludedDecisions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "제외된 결정이 없습니다.";
      excludedSection.append(empty);
    }
    for (const decision of excludedDecisions) {
      const card = document.createElement("article");
      card.className = "workflow-card is-excluded";
      const cardTitle = document.createElement("div");
      cardTitle.className = "workflow-card-title";
      cardTitle.textContent = decision.title || "제목 없는 결정";
      const cardText = document.createElement("div");
      cardText.className = "workflow-card-text";
      cardText.textContent = decision.content;
      const meta = document.createElement("div");
      meta.className = "workflow-card-meta";
      meta.textContent = new Date(decision.updatedAt).toLocaleString();
      const cardActions = document.createElement("div");
      cardActions.className = "workflow-card-actions";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "button button-small";
      restore.textContent = "복원";
      restore.addEventListener("click", async () => {
        const result = await call(window.chatApi.decisionsResolve(project.id, [decision.id], "restore"));
        if (!result) return;
        applyFullState(result);
        openWorkflowPopover(anchor);
      });
      cardActions.append(restore);
      card.append(cardTitle, cardText, meta, cardActions);
      excludedSection.append(card);
    }

    tabPanels.decisions.append(decisionProposalsSection, decisionFormToggle, decisionForm, decisionsSection, excludedSection);

    // === 작업 탭 ===
    const taskTitle = document.createElement("input");
    taskTitle.type = "text";
    taskTitle.maxLength = 160;
    taskTitle.placeholder = "작업 제목";
    const taskDescription = workflowTextarea("작업 설명 (선택)", 3);
    const taskDecision = document.createElement("select");
    const noDecision = document.createElement("option");
    noDecision.value = "";
    noDecision.textContent = "연결할 결정 없음";
    taskDecision.append(noDecision);
    for (const decision of confirmedDecisions) {
      const option = document.createElement("option");
      option.value = decision.id;
      option.textContent = decision.title || decision.content.slice(0, 35);
      taskDecision.append(option);
    }
    const taskRole = document.createElement("select");
    for (const role of workflow.roles || []) {
      const option = document.createElement("option");
      option.value = role.id;
      option.textContent = role.label || role.id;
      taskRole.append(option);
    }
    if (!taskRole.options.length) {
      for (const role of [
        ["planning", "기획"],
        ["implementation", "구현"],
        ["review", "검토"],
      ]) {
        const option = document.createElement("option");
        option.value = role[0];
        option.textContent = role[1];
        taskRole.append(option);
      }
    }
    taskRole.value = "implementation";
    const taskAgent = document.createElement("select");
    const defaultAgentOption = document.createElement("option");
    defaultAgentOption.value = "";
    defaultAgentOption.textContent = "담당자 미지정";
    taskAgent.append(defaultAgentOption);
    for (const agent of agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `@${agent.id} · ${agent.name}`;
      taskAgent.append(option);
    }
    let editingTaskId = null;
    const taskCreate = document.createElement("button");
    taskCreate.type = "button";
    taskCreate.className = "button button-primary";
    taskCreate.textContent = "작업 만들기";
    const taskCancel = document.createElement("button");
    taskCancel.type = "button";
    taskCancel.className = "button button-small";
    taskCancel.textContent = "취소";
    taskCancel.hidden = true;
    const resetTaskForm = () => {
      editingTaskId = null;
      taskTitle.value = "";
      taskDescription.value = "";
      taskDecision.value = "";
      taskRole.value = "implementation";
      taskAgent.value = "";
      taskCreate.textContent = "작업 만들기";
      taskCancel.hidden = true;
      taskFormTitle.textContent = "새 작업";
    };
    taskCancel.addEventListener("click", resetTaskForm);
    taskCreate.addEventListener("click", async () => {
      if (!taskTitle.value.trim()) {
        flashNotice("작업 제목을 입력해 주세요.");
        taskTitle.focus();
        return;
      }
      const result = editingTaskId
        ? await call(window.chatApi.tasksUpdate(project.id, editingTaskId, {
            title: taskTitle.value,
            description: taskDescription.value,
            role: taskRole.value,
            agentId: taskAgent.value,
            decisionId: taskDecision.value,
            chatId: activeSessionId,
          }))
        : await call(window.chatApi.tasksCreate({
            projectId: project.id,
            title: taskTitle.value,
            description: taskDescription.value,
            role: taskRole.value,
            agentId: taskAgent.value,
            decisionId: taskDecision.value,
            chatId: activeSessionId,
          }));
      if (!result) return;
      applyFullState(result);
      openWorkflowPopover(anchor);
    });
    const taskForm = document.createElement("section");
    taskForm.className = "workflow-section is-collapsed";
    taskForm.hidden = true;
    const taskFormToggle = document.createElement("button");
    taskFormToggle.type = "button";
    taskFormToggle.className = "button button-small";
    taskFormToggle.textContent = "직접 작업 추가";
    taskFormToggle.addEventListener("click", () => {
      taskForm.hidden = !taskForm.hidden;
    });
    const taskFormTitle = document.createElement("strong");
    taskFormTitle.textContent = "새 작업";
    taskForm.append(
      taskFormTitle,
      makeField("제목", taskTitle),
      makeField("설명", taskDescription),
      makeField("연결 결정", taskDecision),
      makeField("역할", taskRole),
      makeField("담당 에이전트", taskAgent),
      taskCreate,
      taskCancel
    );

    const allTasks = workflow.tasks || [];
    const proposedTasks = allTasks.filter((t) => t.status === "proposed");
    const activeTasks = allTasks.filter((t) => ["todo", "in_progress", "review", "blocked"].includes(t.status));
    const doneTasks = allTasks.filter((t) => ["done", "rejected", "archived"].includes(t.status));

    const taskProposalsSection = document.createElement("section");
    taskProposalsSection.className = "workflow-section";
    if (proposedTasks.length > 0) {
      const proposalsTitle = document.createElement("strong");
      proposalsTitle.textContent = `확인 대기 중인 작업 후보 (${proposedTasks.length})`;
      taskProposalsSection.append(proposalsTitle);
      for (const task of proposedTasks) {
        const card = document.createElement("article");
        card.className = "workflow-card";
        const cardTitle = document.createElement("div");
        cardTitle.className = "workflow-card-title";
        cardTitle.textContent = task.title;
        const cardText = document.createElement("div");
        cardText.className = "workflow-card-text";
        cardText.textContent = task.description || "설명 없음";
        const actions = document.createElement("div");
        actions.className = "workflow-proposal-actions";
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "button button-primary button-small";
        approve.textContent = "승인";
        approve.addEventListener("click", async () => {
          const result = await call(window.chatApi.tasksResolve(project.id, [task.id], "approve"));
          if (result) { applyFullState(result); openWorkflowPopover(anchor); }
        });
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "button button-small";
        reject.textContent = "제외";
        reject.addEventListener("click", async () => {
          const result = await call(window.chatApi.tasksResolve(project.id, [task.id], "reject"));
          if (result) { applyFullState(result); openWorkflowPopover(anchor); }
        });
        actions.append(approve, reject);
        card.append(cardTitle, cardText, actions);
        taskProposalsSection.append(card);
      }
    }

    const tasksSection = document.createElement("section");
    tasksSection.className = "workflow-section";
    const tasksTitle = document.createElement("strong");
    tasksTitle.textContent = "작업 목록";
    tasksSection.append(tasksTitle);
    if (activeTasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "아직 진행 중인 작업이 없습니다.";
      tasksSection.append(empty);
    }
    for (const task of activeTasks) {
      tasksSection.append(renderTaskCard(task));
    }

    let showDone = false;
    const doneToggle = document.createElement("button");
    doneToggle.type = "button";
    doneToggle.className = "button button-small";
    doneToggle.textContent = `완료 · 제외된 작업 보기 (${doneTasks.length})`;
    const doneSection = document.createElement("section");
    doneSection.className = "workflow-section";
    doneSection.hidden = true;
    doneToggle.addEventListener("click", () => {
      showDone = !showDone;
      doneSection.hidden = !showDone;
      if (showDone && doneSection.childElementCount === 0) {
        for (const task of doneTasks) doneSection.append(renderTaskCard(task));
      }
    });

    // 파일 기반 작업 카드(contentSource "file")는 본문이 프로젝트 폴더의 TASK 파일에만 있다.
    // 읽기 전용으로 펼쳐 보여 준다(textContent만 사용).
    function taskFileView(task) {
      if (task.contentSource !== "file" || !task.taskPath) return null;
      const box = document.createElement("div");
      box.className = "workflow-card-file";
      const label = document.createElement("span");
      label.className = "workflow-card-meta";
      label.textContent = `TASK 파일: ${String(task.taskPath).split(/[\\/]/).pop()} (프로젝트 폴더)`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "button button-small";
      toggle.textContent = "내용 보기";
      const body = document.createElement("pre");
      body.className = "workflow-card-file-body";
      body.hidden = true;
      let loaded = false;
      toggle.addEventListener("click", async () => {
        if (!body.hidden) {
          body.hidden = true;
          toggle.textContent = "내용 보기";
          return;
        }
        if (!loaded) {
          const result = await call(window.chatApi.tasksReadFile(project.id, task.taskPath));
          if (!result) return;
          body.textContent = result.content;
          loaded = true;
        }
        body.hidden = false;
        toggle.textContent = "내용 닫기";
      });
      box.append(label, toggle, body);
      return box;
    }

    function renderTaskCard(task) {
      const card = document.createElement("article");
      card.className = "workflow-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "workflow-card-title";
      cardTitle.textContent = task.title;
      const cardText = document.createElement("div");
      cardText.className = "workflow-card-text";
      cardText.textContent = task.description || (task.contentSource === "file" ? "본문은 TASK 파일에 있습니다." : "설명 없음");
      const meta = document.createElement("div");
      meta.className = "workflow-card-meta";
      const decisionLabel = task.decisionId
        ? workflow.decisions?.find((decision) => decision.id === task.decisionId)?.title || "연결 결정"
        : "결정 미연결";
      meta.textContent = `${workflowRoleLabel(task.role)} · ${workflowAgentLabel(task.agentId)} · ${decisionLabel}`;
      const controls = document.createElement("div");
      controls.className = "workflow-card-actions";
      const status = document.createElement("select");
      for (const value of workflow.statuses || Object.keys(WORKFLOW_STATUS_LABELS)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = WORKFLOW_STATUS_LABELS[value] || value;
        status.append(option);
      }
      status.value = task.status;
      const role = document.createElement("select");
      for (const item of workflow.roles || []) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label || item.id;
        role.append(option);
      }
      role.value = task.role;
      const owner = document.createElement("select");
      const projectDefault = document.createElement("option");
      projectDefault.value = "";
      projectDefault.textContent = "담당자 미지정";
      owner.append(projectDefault);
      for (const agent of agents) {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = `@${agent.id}`;
        owner.append(option);
      }
      owner.value = task.agentId || "";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button button-small";
      edit.textContent = "수정";
      edit.addEventListener("click", () => {
        taskForm.hidden = false;
        editingTaskId = task.id;
        taskTitle.value = task.title;
        taskDescription.value = task.description || "";
        taskDecision.value = task.decisionId || "";
        taskRole.value = task.role;
        taskAgent.value = task.agentId || "";
        taskCreate.textContent = "작업 수정";
        taskCancel.hidden = false;
        taskFormTitle.textContent = "작업 수정";
        taskTitle.focus();
      });
      const save = document.createElement("button");
      save.type = "button";
      save.className = "button button-small";
      save.textContent = "저장";
      save.addEventListener("click", async () => {
        const result = await call(window.chatApi.tasksUpdate(project.id, task.id, {
          status: status.value,
          role: role.value,
          agentId: owner.value,
        }));
        if (!result) return;
        applyFullState(result);
        openWorkflowPopover(anchor);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger button-small";
      remove.textContent = "삭제";
      remove.addEventListener("click", async () => {
        if (!(await confirmInApp("이 작업을 삭제할까요?"))) return;
        const result = await call(window.chatApi.tasksDelete(project.id, task.id));
        if (!result) return;
        applyFullState(result);
        openWorkflowPopover(anchor);
      });
      controls.append(status, role, owner, edit, save, remove);
      const fileView = taskFileView(task);
      card.append(cardTitle, cardText, ...(fileView ? [fileView] : []), meta, controls);
      return card;
    }

    tabPanels.tasks.append(taskProposalsSection, taskFormToggle, taskForm, tasksSection, doneToggle, doneSection);

    selectTab("memory");
  });
}

// --- 토론 팝오버 ---
workflowButton.addEventListener("click", () => openWorkflowPopover(workflowButton));
discussionButton.addEventListener("click", () => {
  openPopover(discussionButton, (root) => {
    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("strong");
    title.textContent = "에이전트 토론";
    head.append(title);
    root.append(head);

    const desc = document.createElement("p");
    desc.className = "popover-status";
    desc.textContent = "한 턴씩 차례로 말하고, 합의·결론·패스가 이어지면 스스로 끝냅니다.";
    root.append(desc);

    // V1.5: 자유토론과 구조화 토론을 한 팝오버에서 고른다. 구조화 토론은
    // Preset이 임시 역할과 발언 순서를 정하고, 길이는 cycle 수가 정한다.
    const modeSelect = document.createElement("select");
    for (const [value, label] of [
      ["free", "자유토론"],
      ["structured", "구조화 토론"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      modeSelect.append(option);
    }
    const savedMode = localStorage.getItem(DISCUSSION_MODE_KEY);
    modeSelect.value =
      savedMode === "structured" && discussionPresets.length > 0 ? "structured" : "free";
    if (discussionPresets.length === 0) modeSelect.disabled = true;
    root.append(makeField("토론 방식", modeSelect));

    const availableAgents = agents.filter((agent) => agent.available && agent.enabled);

    const checkboxes = [];
    const checkboxFields = [];
    for (const agent of availableAgents) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.agentId = agent.id;
      checkboxes.push(checkbox);
      const field = makeField(`@${agent.id} (${agent.name})`, checkbox);
      checkboxFields.push(field);
      root.append(field);
    }

    // --- 구조화 토론 설정 ---
    const presetSelect = document.createElement("select");
    for (const preset of discussionPresets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = `${preset.name} (${preset.stepNames.join(" → ")})`;
      presetSelect.append(option);
    }
    const savedPreset = localStorage.getItem(DISCUSSION_PRESET_KEY);
    if (savedPreset && discussionPresets.some((preset) => preset.id === savedPreset)) {
      presetSelect.value = savedPreset;
    }
    const presetField = makeField("Preset", presetSelect);

    // cycle 상한은 preset의 step 수에 따라 다르다(전체 hard ceiling 50턴 공유,
    // 4-step preset이면 12 cycle). preset을 바꾸면 선택지를 다시 만든다.
    const cycleSelect = document.createElement("select");
    const rebuildCycleOptions = () => {
      const preset = discussionPresets.find((entry) => entry.id === presetSelect.value);
      const maxCycles = Number.isInteger(preset?.maxCycles) && preset.maxCycles >= 1
        ? preset.maxCycles
        : 12;
      const previous = Number.parseInt(cycleSelect.value, 10);
      const saved = Number.parseInt(localStorage.getItem(DISCUSSION_CYCLES_KEY), 10);
      cycleSelect.replaceChildren();
      for (let cycles = 1; cycles <= maxCycles; cycles += 1) {
        const option = document.createElement("option");
        option.value = String(cycles);
        option.textContent = `${cycles} 사이클`;
        cycleSelect.append(option);
      }
      const wanted = Number.isInteger(previous) ? previous : saved;
      cycleSelect.value = String(
        Number.isInteger(wanted) && wanted >= 1 && wanted <= maxCycles
          ? wanted
          : Math.min(3, maxCycles)
      );
    };
    rebuildCycleOptions();
    const cycleField = makeField("반복", cycleSelect);

    const slotWrap = document.createElement("div");
    let slotSelects = [];
    const rebuildSlots = () => {
      slotWrap.replaceChildren();
      slotSelects = [];
      const preset = discussionPresets.find((entry) => entry.id === presetSelect.value);
      if (!preset) return;
      for (let slot = 0; slot < preset.slotCount; slot += 1) {
        const select = document.createElement("select");
        for (const agent of availableAgents) {
          const option = document.createElement("option");
          option.value = agent.id;
          option.textContent = `@${agent.id} (${agent.name})`;
          select.append(option);
        }
        if (availableAgents.length > 0) {
          select.value = availableAgents[slot % availableAgents.length].id;
        }
        slotSelects.push(select);
        slotWrap.append(makeField(preset.slotLabels[slot] || `역할 ${slot + 1}`, select));
      }
    };
    presetSelect.addEventListener("change", () => {
      rebuildSlots();
      rebuildCycleOptions();
    });
    rebuildSlots();

    root.append(presetField, cycleField, slotWrap);

    // V1.5: 토론 길이를 고를 수 있다. 저장된 선택이 없으면 기존 기본(9턴)
    // 그대로다. "직접 중단할 때까지"도 상한 50턴 안에서만 돈다.
    const lengthSelect = document.createElement("select");
    for (const [value, label] of [
      ["short", "짧게 (9턴)"],
      ["normal", "보통 (15턴)"],
      ["long", "길게 (30턴)"],
      ["custom", "직접 설정"],
      ["manual", "직접 중단할 때까지 (최대 50턴)"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      lengthSelect.append(option);
    }
    const savedLength = localStorage.getItem(DISCUSSION_LENGTH_KEY);
    lengthSelect.value =
      savedLength && (savedLength === "custom" || DISCUSSION_LENGTH_PRESETS[savedLength])
        ? savedLength
        : "short";

    const customInput = document.createElement("input");
    customInput.type = "number";
    customInput.min = "3";
    customInput.max = "50";
    customInput.value = String(
      boundedDiscussionTurns(localStorage.getItem(DISCUSSION_CUSTOM_TURNS_KEY))
    );
    const customField = makeField("발언 수 (3~50)", customInput);

    const lengthField = makeField("토론 길이", lengthSelect);
    root.append(lengthField, customField);

    // 자유토론에는 참가자 체크박스·길이를, 구조화 토론에는 Preset·반복·역할
    // 배정을 보여 준다(제안서 §11.1: 자유토론에서 cycle UI를 숨긴다).
    const syncModeFields = () => {
      const structured = modeSelect.value === "structured";
      for (const field of checkboxFields) field.hidden = structured;
      lengthField.hidden = structured;
      customField.hidden = structured || lengthSelect.value !== "custom";
      presetField.hidden = !structured;
      cycleField.hidden = !structured;
      slotWrap.hidden = !structured;
    };
    modeSelect.addEventListener("change", syncModeFields);
    lengthSelect.addEventListener("change", syncModeFields);
    syncModeFields();

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "button button-primary popover-submit";
    startBtn.textContent = "토론 시작";
    startBtn.addEventListener("click", async () => {
      if (modeSelect.value === "structured") {
        const preset = discussionPresets.find((entry) => entry.id === presetSelect.value);
        if (!preset) {
          flashNotice("구조화 토론 Preset을 선택해야 합니다.");
          return;
        }
        const roleAssignments = slotSelects.map((select) => select.value);
        if (new Set(roleAssignments).size < 2) {
          flashNotice("구조화 토론에는 서로 다른 참가자가 두 명 이상 필요합니다.");
          return;
        }
        const cycleBudget = Number.parseInt(cycleSelect.value, 10);
        localStorage.setItem(DISCUSSION_MODE_KEY, "structured");
        localStorage.setItem(DISCUSSION_PRESET_KEY, preset.id);
        localStorage.setItem(DISCUSSION_CYCLES_KEY, String(cycleBudget));
        closePopover();
        await call(
          window.chatApi.discussionStart(activeSessionId, undefined, {
            presetId: preset.id,
            cycleBudget,
            roleAssignments,
          })
        );
        return;
      }
      const agentIds = checkboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.dataset.agentId);
      if (agentIds.length < 2) {
        flashNotice("토론에는 두 명 이상을 선택해야 합니다.");
        return;
      }
      const lengthChoice = lengthSelect.value;
      const turnBudget =
        lengthChoice === "custom"
          ? boundedDiscussionTurns(customInput.value)
          : DISCUSSION_LENGTH_PRESETS[lengthChoice] || DISCUSSION_LENGTH_PRESETS.short;
      localStorage.setItem(DISCUSSION_MODE_KEY, "free");
      localStorage.setItem(DISCUSSION_LENGTH_KEY, lengthChoice);
      if (lengthChoice === "custom") {
        localStorage.setItem(DISCUSSION_CUSTOM_TURNS_KEY, String(turnBudget));
      }
      closePopover();
      await call(window.chatApi.discussionStart(activeSessionId, agentIds, { turnBudget }));
    });
    root.append(startBtn);
  });
});

// --- 워크스페이스 / 권한 ---
// 워크스페이스는 프로젝트 단위 설정이므로 이 칩은 현재 폴더를 보여 주기만 합니다.
// 변경은 프로젝트 설정(사이드바의 ⋯) 한 곳에서만 합니다 — 채팅 화면에서
// 클릭·우클릭으로 프로젝트 전체 설정이 바뀌던 숨은 경로를 없앴습니다.
workspaceButton.addEventListener("click", () => {
  const project = activeProjectEntry();
  if (!project) return;
  const anchor = projectListEl.querySelector(`[data-project-settings="${CSS.escape(project.id)}"]`);
  if (anchor) openProjectSettings(anchor, project);
  else flashNotice("워크스페이스는 프로젝트 설정(⋯)에서 변경할 수 있습니다.");
});

permissionSelect.addEventListener("change", () => {
  const mode = permissionSelect.value;
  void requestSessionMeta((sessionId) => window.chatApi.permissionSet(sessionId, mode));
});

// --- 메시지 렌더링 (모든 텍스트는 textContent로만 삽입) ---
function renderInlineTokens(container, tokens) {
  for (const token of tokens) {
    if (token.type === "code") {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = token.text;
      container.append(code);
    } else if (token.type === "bold") {
      const strong = document.createElement("strong");
      strong.textContent = token.text;
      container.append(strong);
    } else if (token.type === "file") {
      // 임의 경로 열기는 막혀 있습니다.
      // 그래서 이동시키지 않고, 읽을 수 있는 파일 이름 + 전체 경로 툴팁 + 경로 복사만 제공합니다.
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip";
      chip.textContent = token.text;
      chip.title = `${token.path}\n클릭하면 경로를 복사합니다`;
      chip.addEventListener("click", async () => {
        const original = chip.textContent;
        try {
          await navigator.clipboard.writeText(token.path);
          chip.textContent = "경로 복사됨";
        } catch {
          chip.textContent = "복사 실패";
        }
        setTimeout(() => {
          chip.textContent = original;
        }, 1200);
      });
      container.append(chip);
    } else if (token.type === "link") {
      const anchor = document.createElement("a");
      anchor.href = token.href;
      anchor.textContent = token.text;
      anchor.rel = "noreferrer noopener";
      anchor.addEventListener("click", (event) => event.preventDefault());
      anchor.title = "외부 링크는 채팅창에서 열리지 않습니다";
      container.append(anchor);
    } else if (token.type === "mention") {
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = token.text;
      container.append(span);
    } else {
      container.append(document.createTextNode(token.text));
    }
  }
}

// LaTeX 수식을 렌더링합니다. KaTeX 스크립트를 불러오지 못한 예외적인 상황(오프라인 파일
// 손상 등)에서도 채팅 자체는 계속 동작해야 하므로 조용히 건너뜁니다. 본문에 자연스럽게 쓰이는
// "$100"류 표기와 충돌하지 않도록 $...$ 한 글자짜리 구분자는 지원하지 않습니다.
function renderMathIfAvailable(container) {
  if (typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
    });
  } catch {}
}

function renderRichText(container, text) {
  const blocks = chatMarkdown.tokenizeBlocks(text);
  if (blocks.length === 0) {
    container.textContent = text;
    renderMathIfAvailable(container);
    return;
  }
  for (const block of blocks) {
    if (block.type === "fence") {
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      const bar = document.createElement("div");
      bar.className = "code-bar";
      const lang = document.createElement("span");
      lang.textContent = block.lang || "code";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-copy";
      copyBtn.textContent = "복사";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(block.code);
          copyBtn.textContent = "복사됨";
          setTimeout(() => {
            copyBtn.textContent = "복사";
          }, 1500);
        } catch {}
      });
      bar.append(lang, copyBtn);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.code;
      pre.append(code);
      wrap.append(bar, pre);
      container.append(wrap);
    } else if (block.type === "heading") {
      // 에이전트가 흔히 쓰는 ## 제목. h1~h6을 그대로 만들되 크기는 CSS가 정합니다.
      const heading = document.createElement("h" + block.level);
      heading.className = "md-heading";
      renderInlineTokens(heading, block.tokens);
      container.append(heading);
    } else if (block.type === "table") {
      // 좁은 사이드바/말풍선에서 표가 넘칠 수 있으므로 표만 가로 스크롤합니다.
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      table.className = "md-table";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const cellTokens of block.header) {
        const th = document.createElement("th");
        renderInlineTokens(th, cellTokens);
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement("tbody");
      for (const rowTokens of block.rows) {
        const tr = document.createElement("tr");
        for (const cellTokens of rowTokens) {
          const td = document.createElement("td");
          renderInlineTokens(td, cellTokens);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      container.append(wrap);
    } else if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      list.className = "md-list";
      for (const itemTokens of block.items) {
        const item = document.createElement("li");
        renderInlineTokens(item, itemTokens);
        list.append(item);
      }
      container.append(list);
    } else {
      const paragraph = document.createElement("p");
      paragraph.className = "md-paragraph";
      block.lines.forEach((lineTokens, lineIndex) => {
        if (lineIndex > 0) paragraph.append(document.createElement("br"));
        renderInlineTokens(paragraph, lineTokens);
      });
      container.append(paragraph);
    }
  }
  renderMathIfAvailable(container);
}

function renderTextWithMentions(container, text) {
  renderInlineTokens(
    container,
    chatMarkdown.tokenizeInline(text).map((token) =>
      token.type === "mention" ? token : { type: "text", text: token.text ?? token.href ?? "" }
    )
  );
  renderMathIfAvailable(container);
}

// 그림 대신 확장자를 적는다. 📄/📦 두 가지로는 PDF와 ZIP이 구분되지 않았다.
function makeAttachmentIcon(attachment) {
  const icon = document.createElement("span");
  icon.className = "attachment-icon";
  const extension = /\.([a-z0-9]{1,5})$/i.exec(String(attachment.name || ""))?.[1];
  icon.textContent = extension ? extension.toUpperCase() : attachment.kind === "text" ? "TXT" : "FILE";
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
function makeAttachmentPill(attachment, { removable = false } = {}) {
  const pill = document.createElement("span");
  pill.className = "attachment-pill";
  pill.title = `${attachment.name} · ${attachment.mime} · ${formatBytes(attachment.size)}`;

  if (attachment.kind === "image") {
    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.alt = attachment.name;
    window.chatApi
      .attachmentsPreview(activeSessionId, attachment.id)
      .then((result) => {
        if (result?.ok && result.dataUrl) {
          img.src = result.dataUrl;
        } else {
          // 큰 이미지는 미리보기가 제한되므로 아이콘으로 대체한다.
          img.replaceWith(makeAttachmentIcon(attachment));
        }
      })
      .catch(() => img.replaceWith(makeAttachmentIcon(attachment)));
    pill.append(img);
  } else {
    pill.append(makeAttachmentIcon(attachment));
  }

  const name = document.createElement("span");
  name.className = "attachment-name";
  name.textContent = attachment.name;
  pill.append(name);

  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.title = "첨부 제거";
    remove.addEventListener("click", async () => {
      const sessionId = activeSessionId;
      const result = await call(window.chatApi.attachmentsRemove(sessionId, attachment.id));
      if (result && sessionId === activeSessionId) {
        pendingAttachments = result.pendingAttachments || [];
        renderPendingAttachments();
      }
    });
    pill.append(remove);
  }
  return pill;
}

function formatTime(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
}

// 마크다운 기호를 걷어내 순수 텍스트로 만듭니다.
// 메모장·메신저처럼 마크다운을 해석하지 않는 곳에 붙여넣기 위한 용도입니다.
function stripMarkdown(text) {
  let out = String(text || "");
  // 코드 펜스는 내용만 남깁니다.
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");
  // 이미지 → 대체 텍스트, 링크 → 표시 텍스트만.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 제목·인용 기호 제거.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // 강조 기호 제거 (굵게/기울임/취소선/인라인 코드).
  out = out.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");
  // 목록 기호는 가운뎃점으로, 수평선은 제거.
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, "· ");
  out = out.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "");
  // 표 구분선 제거.
  out = out.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// 클릭하면 클립보드에 넣고 잠시 "복사됨"으로 바뀌는 작은 버튼을 만듭니다.
function makeCopyButton(label, title, getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-copy-button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const text = getText();
    if (!text) {
      flashNotice("복사할 내용이 없습니다.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "복사됨";
      button.classList.add("is-copied");
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove("is-copied");
      }, 1200);
    } catch {
      flashNotice("복사하지 못했습니다.");
    }
  });
  return button;
}

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = "message";

  if (message.authorType === "system") {
    item.classList.add("is-system");
    if (message.error) item.classList.add("is-error");
    // 바로 앞 알림과 같은지 비교하는 열쇠입니다. 오류 여부가 다르면 다른 알림으로 봅니다.
    const discId = message.discussionMeta?.discussionId;
    item.dataset.systemKey = discId ? `disc-${discId}` : `${message.error ? "!" : ""}${message.text}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const textSpan = document.createElement("span");
    textSpan.textContent = message.text;
    bubble.append(textSpan);

    if (message.discussionMeta && message.discussionMeta.discussionId) {
      const actions = document.createElement("div");
      actions.className = "discussion-summary-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "discussion-summary-button";
      btn.textContent = "결론 종합하기";
      btn.title = "원하는 AI를 선택해 토론 결론을 요약 카드로 정리합니다";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        openDiscussionSummaryPopover(btn, message.discussionMeta);
      });
      actions.append(btn);
      bubble.append(actions);
    }
    item.append(bubble);
    return item;
  }

  const isUser = message.authorType === "user";
  if (isUser) item.classList.add("is-user");
  if (message.error) item.classList.add("is-error");

  const agent = isUser ? null : agentById(message.author);
  const name = isUser ? "나" : agent ? agent.name : message.author;
  const color = isUser ? "var(--accent)" : agent ? agent.color : "#52525b";

  const body = document.createElement("div");
  body.className = "body";

  const meta = document.createElement("div");
  meta.className = "meta";
  const nameEl = document.createElement("span");
  nameEl.className = "name";
  const agentMeta = message.agentMeta || {};
  nameEl.textContent = isUser ? name : `${name} (@${message.author})`;
  meta.append(nameEl);

  if (!isUser) {
    // 1. 모델 배지 — 별칭(fable)으로 실행했으면 CLI가 보고한 실제 모델을 함께 적어
    //    "최신"이 지금 어떤 버전인지 보이게 합니다.
    const shownModel = agentMeta.model && agentMeta.model !== "default" ? agentMeta.model : agent?.model;
    if (shownModel) {
      const modelBadge = document.createElement("span");
      modelBadge.className = "meta-pill model-pill";
      const resolved = agentMeta.resolvedModel && agentMeta.resolvedModel !== shownModel
        ? agentMeta.resolvedModel
        : "";
      modelBadge.textContent = resolved ? `${shownModel} · ${resolved}` : shownModel;
      if (resolved) modelBadge.title = `${shownModel} 별칭이 실제로 실행한 모델: ${resolved}`;
      meta.append(modelBadge);
    }

    // 2. 노력/속도 배지
    const shownEffort = agentMeta.effort && agentMeta.effort !== "default" ? agentMeta.effort : agent?.effort;
    if (shownEffort) {
      const effortBadge = document.createElement("span");
      effortBadge.className = "meta-pill effort-pill";
      effortBadge.textContent = effortLabel(shownEffort);
      meta.append(effortBadge);
    }

    // 3. 토론 결론 종합 배지
    const summaryMeta = message.discussionSummary || agentMeta.discussionSummary;
    if (summaryMeta) {
      const summaryBadge = document.createElement("span");
      summaryBadge.className = "role-badge role-discussion-summary";
      summaryBadge.textContent = summaryMeta.record ? "토론 기록" : "토론 종합";
      summaryBadge.title = summaryMeta.record
        ? "토론 내용을 프로젝트 기억 초안으로 남긴 기록입니다"
        : "이전 토론을 종합한 요약 카드입니다";
      meta.append(summaryBadge);
    }

    if (message.simplifyMeta || agentMeta.simplifyMeta) {
      const simplifyBadge = document.createElement("span");
      simplifyBadge.className = "role-badge role-simplify-summary";
      simplifyBadge.textContent = "쉬운 설명";
      simplifyBadge.title = "복잡한 기술 용어를 비개발자도 이해하기 쉬운 말로 깔끔하게 풀어주는 요약본입니다";
      meta.append(simplifyBadge);
    }
  }

  const timeEl = document.createElement("span");
  timeEl.className = "meta-time";
  timeEl.textContent = formatTime(message.ts);
  meta.append(timeEl);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (message.error) {
    renderFailedMessage(bubble, message);
  } else if (isUser) {
    renderTextWithMentions(bubble, message.text);
  } else {
    bubble.classList.add("is-rich");
    renderAgentMessageContent(bubble, message);
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attachWrap = document.createElement("div");
    attachWrap.className = "message-attachments";
    for (const attachment of message.attachments) {
      attachWrap.append(makeAttachmentPill(attachment));
    }
    bubble.append(attachWrap);
  }

  // 사용량(Usage) 표기: 토큰 사용량 정보가 제공된 경우 노출합니다.
  const usage = message.usage || agentMeta.usage || message.runOutput?.usage;
  if (usage && (usage.promptTokens || usage.completionTokens || usage.totalTokens)) {
    const usageEl = document.createElement("div");
    usageEl.className = "message-usage";
    const prompt = usage.promptTokens ? `입력 ${usage.promptTokens.toLocaleString()}` : "";
    const completion = usage.completionTokens ? `출력 ${usage.completionTokens.toLocaleString()}` : "";
    const total = usage.totalTokens ? `합계 ${usage.totalTokens.toLocaleString()}` : "";
    const details = [prompt, completion, total].filter(Boolean).join(" · ");
    usageEl.textContent = `토큰 ${details}`;
    bubble.append(usageEl);
  }

  // 전달 배지: 일부 첨부가 이 에이전트로 전달되지 못한 경우 표시
  if (Array.isArray(message.deliveries)) {
    const failed = message.deliveries.filter((delivery) => delivery.method === "unsupported");
    if (failed.length > 0) {
      const badge = document.createElement("div");
      badge.className = "delivery-badge";
      badge.textContent = `첨부 ${failed.length}개는 이 에이전트에 전달되지 않았습니다`;
      bubble.append(badge);
    }
  }

  body.append(meta, bubble);

  // 전달(Handoff) 버튼: 다른 AI가 보낸 에이전트 메시지를 다른 에이전트에게 이어서 전달합니다.
  if (!isUser && message.id) {
    // 말풍선 하단 액션 줄: 복사 2종 + 전달을 한 줄에 나란히 놓습니다.
    const actions = document.createElement("div");
    actions.className = "message-actions";

    // 복사 버튼 2종: 마크다운 원본(옵시디언/노션용)과 서식 없는 순수 텍스트(메모장/메신저용).
    const copyMarkdownBtn = makeCopyButton("복사", "마크다운 원본 그대로 복사", () => message.text || "");
    const copyPlainBtn = makeCopyButton("서식 없이 복사", "굵게·제목 등 기호를 걷어낸 순수 텍스트로 복사", () =>
      stripMarkdown(message.text || "")
    );
    actions.append(copyMarkdownBtn, copyPlainBtn);

    // 쉽게 설명 독립 버튼: 원문 작성 에이전트를 기본 대상으로 즉시 실행
    const simplifyBtn = document.createElement("button");
    simplifyBtn.type = "button";
    simplifyBtn.className = "message-simplify-button";
    simplifyBtn.textContent = "쉽게 설명";
    // 같은 저자 + 같은 모델 고정 계약: 원문 작성 에이전트만 수행할 수 있고
    // 다른 에이전트로 대체하지 않습니다. 실제 구체적 모델 정보가 없거나 사용할 수 없으면 버튼을 비활성화합니다.
    const simplifyAuthor = agentById(message.author);
    const simplifyModel =
      message.agentMeta?.resolvedModel ||
      (message.agentMeta?.model && message.agentMeta.model !== "default"
        ? message.agentMeta.model
        : null);
    const simplifyAuthorUsable = Boolean(
      simplifyAuthor && simplifyAuthor.available && simplifyAuthor.enabled !== false && simplifyModel
    );
    simplifyBtn.title = !simplifyModel
      ? "원문 작성 당시 실제 모델을 확인할 수 없어 쉽게 설명을 실행할 수 없습니다"
      : simplifyAuthorUsable
        ? "원문을 작성한 에이전트가 같은 모델로 알기 쉽게 다시 설명합니다"
        : "원문을 작성한 에이전트를 사용할 수 없어 쉽게 설명을 실행할 수 없습니다";
    if (!simplifyAuthorUsable) {
      simplifyBtn.disabled = true;
      simplifyBtn.classList.add("is-disabled");
    }
    simplifyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      // fallback 금지: 원문 작성 에이전트나 실제 모델 정보를 쓸 수 없으면 실행하지 않습니다.
      const target = agentById(message.author);
      const targetModel =
        message.agentMeta?.resolvedModel ||
        (message.agentMeta?.model && message.agentMeta.model !== "default"
          ? message.agentMeta.model
          : null);
      if (!target || !target.available || target.enabled === false || !targetModel) {
        flashNotice("원문 작성 에이전트나 실제 모델 정보를 확인할 수 없어 쉽게 설명을 실행할 수 없습니다.");
        return;
      }
      await call(window.chatApi.handoffMessage(sessionMeta?.id, target.id, message.id, "SIMPLIFY_SELF"));
    });
    actions.append(simplifyBtn);

    const handoffBtn = document.createElement("button");
    handoffBtn.type = "button";
    handoffBtn.className = "message-handoff-button";
    handoffBtn.title = "이 메시지를 다른 AI에게 전달";
    handoffBtn.textContent = "다른 AI에게 전달";
    handoffBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openHandoffPopover(handoffBtn, message.id, message.author);
    });
    actions.append(handoffBtn);
    body.append(actions);
  }

  if (!isUser) {
    const avatar = makeAgentAvatar(agent || { id: message.author, name, color });
    item.append(avatar, body);
  } else {
    item.append(body);
  }
  return item;
}

// 같은 시스템 알림이 연달아 오면 줄을 늘리지 않고 횟수만 올립니다.
// (같은 안내가 반복되면 똑같은 문장이 화면을 채웁니다)
function mergeIntoPreviousSystem(item) {
  if (!item.classList.contains("is-system")) return false;
  if (item.querySelector(".discussion-summary-button")) return false;
  const last = messageList.lastElementChild;
  if (!last || !last.classList.contains("is-system")) return false;
  if (last.querySelector(".discussion-summary-button")) return false;
  if (last.dataset.systemKey !== item.dataset.systemKey) return false;

  const count = Number(last.dataset.systemCount || "1") + 1;
  last.dataset.systemCount = String(count);
  let badge = last.querySelector(".system-count");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "system-count";
    last.querySelector(".bubble").append(badge);
  }
  badge.textContent = `×${count}`;
  return true;
}

// 연달아 붙은 시스템 알림 묶음에서 최근 몇 개만 남기고 접습니다.
// 스크린샷처럼 "시작 → 취소"가 번갈아 반복되면 같은 문장이 아니라서 위의 ×N 병합으로는
// 줄지 않고, 정작 대화가 화면 밖으로 밀려납니다.
const SYSTEM_RUN_VISIBLE = 3;
let systemToggle = null;

function trailingSystemRun() {
  const run = [];
  let cursor = messageList.lastElementChild;
  while (cursor && cursor.classList.contains("is-system")) {
    if (cursor.querySelector(".discussion-summary-button")) break;
    if (cursor !== systemToggle) run.unshift(cursor);
    cursor = cursor.previousElementSibling;
  }
  return run;
}

function updateSystemToggleLabel() {
  if (!systemToggle) return;
  const expanded = messageList.classList.contains("show-system-history");
  systemToggle.querySelector(".system-toggle-button").textContent = expanded
    ? "이전 알림 접기"
    : `이전 알림 ${systemToggle.dataset.hiddenCount}개 보기`;
}

function syncSystemRun() {
  if (systemToggle && !systemToggle.isConnected) systemToggle = null;

  const run = trailingSystemRun();
  const hiddenCount = Math.max(0, run.length - SYSTEM_RUN_VISIBLE);
  run.forEach((item, index) => item.classList.toggle("is-collapsed", index < hiddenCount));

  if (hiddenCount === 0) {
    if (systemToggle) systemToggle.remove();
    systemToggle = null;
    return;
  }

  if (!systemToggle) {
    systemToggle = document.createElement("li");
    systemToggle.className = "message is-system system-toggle";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "system-toggle-button";
    button.addEventListener("click", () => {
      messageList.classList.toggle("show-system-history");
      updateSystemToggleLabel();
    });
    systemToggle.append(button);
  }
  systemToggle.dataset.hiddenCount = String(hiddenCount);
  run[0].before(systemToggle);
  updateSystemToggleLabel();
}

function appendMessageItem(item) {
  if (mergeIntoPreviousSystem(item)) {
    syncSystemRun();
    return;
  }
  messageList.append(item);
  syncSystemRun();
}

function appendMessage(message) {
  const stick = isNearBottom();
  // 같은 runId의 라이브 초안이 있으면 정식 메시지로 대체합니다.
  if (message.runId && liveRuns.has(message.runId)) {
    const live = liveRuns.get(message.runId);
    live.item.remove();
    liveRuns.delete(message.runId);
  }
  chatMessages.push(message);
  appendMessageItem(renderMessage(message));
  scrollToBottom(stick || message.authorType === "user");
}

function renderAllMessages(messages) {
  messageList.textContent = "";
  liveRuns.clear();
  chatMessages = [...(messages || [])];
  systemToggle = null;
  messageList.classList.remove("show-system-history");
  for (const message of chatMessages) {
    appendMessageItem(renderMessage(message));
  }
}

// --- 실시간 실행 이벤트 (스트리밍/상태) ---
// 실패한 실행을 그리는 부분입니다. 오류 문구만 남기지 않고,
// 실패 원인 구분과 마지막까지 받은 중간 출력, 진단 정보를 함께 보여줍니다.
const FAILURE_LABELS = {
  "output-limit": "출력 상한 초과로 중단",
  timeout: "시간 초과로 중단",
  error: "실행 오류",
};

const FAILED_PARTIAL_DISPLAY_CHARS = 20000;

function renderFailedMessage(bubble, message) {
  bubble.classList.add("is-failed");

  const label = FAILURE_LABELS[message.failureKind] || FAILURE_LABELS.error;
  const headline = document.createElement("div");
  headline.className = "failure-headline";
  headline.textContent = label;
  bubble.append(headline);

  const detail = document.createElement("div");
  detail.className = "failure-detail";
  detail.textContent = message.text || "알 수 없는 오류";
  bubble.append(detail);

  if (message.partialText) {
    const partialWrap = document.createElement("details");
    partialWrap.className = "failure-partial";
    partialWrap.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "중단 전까지 받은 출력";
    const partialText = document.createElement("div");
    partialText.className = "failure-partial-text";
    const shown = message.partialText.slice(-FAILED_PARTIAL_DISPLAY_CHARS);
    partialText.textContent = shown;
    partialWrap.append(summary, partialText);
    if (shown.length < message.partialText.length) {
      const trimmed = document.createElement("div");
      trimmed.className = "live-notice";
      trimmed.textContent = "출력이 길어 일부 내용을 접었습니다.";
      partialWrap.append(trimmed);
    }
    bubble.append(partialWrap);
  }

  const output = message.runOutput;
  if (output && (output.stdoutBytes || output.rawLogName || output.captureTruncated)) {
    const diag = document.createElement("div");
    diag.className = "failure-diagnostics";
    const parts = [];
    if (Number.isFinite(output.stdoutBytes)) {
      parts.push(`총 출력 ${formatBytes(output.stdoutBytes)}`);
    }
    if (output.captureTruncated) parts.push("중간 일부는 보존되지 않음");
    diag.textContent = parts.join(" · ");
    // 실패 문구가 "원본 로그를 확인해 주세요"라고 안내하면서 그 로그로 가는 길이
    // 화면에 없었다. 이름만 적어 두는 대신 보관 폴더를 여는 버튼을 준다.
    if (output.rawLogName) {
      if (parts.length > 0) diag.append(" · ");
      diag.append("원본 로그 보관됨: ");
      const openLog = document.createElement("button");
      openLog.type = "button";
      openLog.className = "failure-log-link";
      openLog.textContent = output.rawLogName;
      openLog.title = "이 로그가 보관된 폴더를 엽니다";
      openLog.addEventListener("click", async () => {
        if (!activeSessionId) return;
        await call(window.chatApi.openRunLogFolder(activeSessionId));
      });
      diag.append(openLog);
    }
    bubble.append(diag);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

// 화면 표시 한도입니다. provider 출력 한도나 프로세스 수집 한도와 별개이며,
// 이 한도를 넘어도 실행은 그대로 계속되고 최종 답변을 계속 기다립니다.
const LIVE_DISPLAY_LIMIT_CHARS = 200000;
const LIVE_DISPLAY_TAIL_CHARS = 120000;

function handleRunEvent(payload) {
  if (payload.sessionId !== activeSessionId) return;
  const { runId, agentId, kind } = payload;

  if (kind === "run-start") {
    const agent = agentById(agentId);
    const item = document.createElement("li");
    item.className = "message is-live";
    const avatar = makeAgentAvatar(agent || { id: agentId, name: agentId });
    const body = document.createElement("div");
    body.className = "body";
    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    const liveMeta = [agent?.name || agentId, `@${agentId}`];
    liveMeta.push(payload.model || agent?.model || "모델 확인 중");
    liveMeta.push(effortLabel(payload.effort || agent?.effort || "추론 강도 확인 중"));
    liveMeta.push("응답 중");
    nameEl.textContent = liveMeta.join(" · ");
    meta.append(nameEl);
    const bubble = document.createElement("div");
    bubble.className = "bubble is-live-bubble";
    const statusEl = document.createElement("div");
    statusEl.className = "live-status";
    statusEl.textContent = "…";
    const textEl = document.createElement("div");
    textEl.className = "live-text";
    const noticeEl = document.createElement("div");
    noticeEl.className = "live-notice";
    noticeEl.hidden = true;
    bubble.append(statusEl, textEl, noticeEl);
    body.append(meta, bubble);
    item.append(avatar, body);
    messageList.append(item);
    liveRuns.set(runId, { item, statusEl, textEl, noticeEl, text: "", displayTrimmed: false });
    scrollToBottom();
    return;
  }

  const live = liveRuns.get(runId);
  if (!live) return;
  if (kind === "status") {
    live.statusEl.textContent = payload.label || "";
  } else if (kind === "delta") {
    live.text += payload.text || "";
    // 표시량이 너무 커지면 앞부분을 접습니다. 실행은 중단하지 않습니다.
    if (live.text.length > LIVE_DISPLAY_LIMIT_CHARS) {
      live.text = live.text.slice(live.text.length - LIVE_DISPLAY_TAIL_CHARS);
      live.displayTrimmed = true;
    }
    live.textEl.textContent = live.text;
    if (live.displayTrimmed && live.noticeEl) {
      live.noticeEl.hidden = false;
      live.noticeEl.textContent = "출력이 길어 일부 내용을 접었습니다. 실행은 계속 진행됩니다.";
    }
    live.statusEl.textContent = "";
    scrollToBottom();
  } else if (kind === "run-end") {
    // 정식 메시지(성공 답변 또는 실패 기록)가 곧 도착해 이 초안을 대체합니다.
    // 실패했다고 해서 여기서 지우면 중간 출력이 화면에서 사라지므로 그대로 둡니다.
    live.statusEl.textContent = payload.ok ? "" : "실행이 끝났습니다. 결과를 정리합니다…";
  }
}

// --- 타이핑 표시 ---
function renderTyping() {
  typingRow.textContent = "";
  const active = [...typingAgents].map(agentById).filter(Boolean);
  typingRow.hidden = active.length === 0;
  stopButton.hidden = active.length === 0;
  for (const agent of active) {
    const pill = document.createElement("span");
    pill.className = "typing-pill";
    pill.style.setProperty("--agent-color", agent.color);
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    pill.append(dots, document.createTextNode(`${agent.name} 입력 중`));
    typingRow.append(pill);
  }
  renderAgents();
  scrollToBottom();
}

// --- 첨부 (작성 중) ---
function renderPendingAttachments() {
  attachmentRow.textContent = "";
  attachmentRow.hidden = pendingAttachments.length === 0;
  for (const attachment of pendingAttachments) {
    attachmentRow.append(makeAttachmentPill(attachment, { removable: true }));
  }
}

attachButton.addEventListener("click", async () => {
  const sessionId = activeSessionId;
  const result = await call(window.chatApi.attachmentsAdd(sessionId));
  if (!result) return;
  if (sessionId !== activeSessionId) return;
  pendingAttachments = result.pendingAttachments || pendingAttachments;
  for (const failure of result.errors || []) {
    flashNotice(`${failure.name}: ${failure.error}`);
  }
  renderPendingAttachments();
});

composerBox.addEventListener("dragover", (event) => {
  event.preventDefault();
  composerBox.classList.add("is-dragover");
});
composerBox.addEventListener("dragleave", () => composerBox.classList.remove("is-dragover"));
composerBox.addEventListener("drop", async (event) => {
  event.preventDefault();
  composerBox.classList.remove("is-dragover");
  const paths = [...(event.dataTransfer?.files || [])]
    .map((file) => window.chatApi.pathForFile(file))
    .filter(Boolean);
  if (paths.length === 0) return;
  const sessionId = activeSessionId;
  const result = await call(window.chatApi.attachmentsAddDropped(sessionId, paths));
  if (!result) return;
  if (sessionId !== activeSessionId) return;
  pendingAttachments = result.pendingAttachments || pendingAttachments;
  for (const failure of result.errors || []) {
    flashNotice(`${failure.name}: ${failure.error}`);
  }
  renderPendingAttachments();
});

// --- 멘션 자동완성 ---
// 참가자를 부를 수 없는 이유. "사용 불가"만 적으면 무엇을 고쳐야 하는지 알 수 없다.
function agentUnavailableReason(agent) {
  if (!agent) return "담당자를 찾을 수 없음";
  if (agent.enabled === false) return `${agent.name}이(가) 이 세션에서 꺼져 있음`;
  if (!agent.available) return agent.reason || `${agent.name} CLI 없음`;
  return "";
}

// 한 줄 목록에 들어갈 만큼 짧은 사유. 전체 문장(설치 명령·주소 포함)은 툴팁이 맡는다.
function agentUnavailableShort(agent) {
  if (!agent) return "담당자 없음";
  if (agent.enabled === false) return "세션에서 꺼짐";
  if (!agent.available) return "CLI 없음";
  return "";
}

function mentionTargets() {
  return [
    ...agents.map((agent) => ({
      alias: agent.aliases[0],
      label: agent.name,
      color: agent.color,
      available: agent.available && agent.enabled,
      reason: agentUnavailableReason(agent),
      reasonShort: agentUnavailableShort(agent),
    })),
    {
      alias: "모두",
      label: "모든 에이전트",
      color: "#52525b",
      available: agents.some((agent) => agent.available && agent.enabled),
      reason: "쓸 수 있는 참가자가 없음",
      reasonShort: "참가자 없음",
    },
  ];
}

function closeMentionPopup() {
  mentionState = null;
  mentionPopup.hidden = true;
  mentionPopup.textContent = "";
}

function updateMentionPopup() {
  const caret = composerInput.selectionStart;
  const value = composerInput.value.slice(0, caret);
  const match = value.match(/(^|[\s([{])@([\p{L}\p{N}_-]*)$/u);
  if (!match) {
    closeMentionPopup();
    return;
  }
  const query = match[2].toLowerCase();
  const options = mentionTargets().filter((target) =>
    target.alias.toLowerCase().startsWith(query)
  );
  if (options.length === 0) {
    closeMentionPopup();
    return;
  }
  const start = caret - query.length;
  const previousAlias =
    mentionState && mentionState.options[mentionState.index]
      ? mentionState.options[mentionState.index].alias
      : null;
  const keptIndex = options.findIndex((option) => option.alias === previousAlias);
  mentionState = { start, query, options, index: keptIndex >= 0 ? keptIndex : 0 };

  mentionPopup.textContent = "";
  options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mention-option";
    button.setAttribute("role", "option");
    if (index === mentionState.index) button.classList.add("is-active");
    if (!option.available) button.classList.add("is-unavailable");
    button.style.setProperty("--agent-color", option.color);

    const dot = document.createElement("i");
    dot.className = "dot";
    const alias = document.createElement("span");
    alias.className = "alias";
    alias.textContent = `@${option.alias}`;
    const desc = document.createElement("span");
    desc.className = "desc";
    // 회색 항목에는 "사용 불가"가 아니라 **왜** 못 쓰는지를 적는다. 목록에는
    // 한 줄에 들어가는 짧은 형태를, 툴팁에는 설치 명령·주소까지 있는 전체 사유를.
    desc.textContent = option.available
      ? option.label
      : `${option.label} · ${option.reasonShort || option.reason || "사용 불가"}`;
    const detail = option.hint || option.label;
    button.title = option.available || !option.reason ? detail : `${detail} · ${option.reason}`;
    button.append(dot, alias, desc);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptMention(index);
    });
    mentionPopup.append(button);
  });
  mentionPopup.hidden = false;
}

function acceptMention(index) {
  if (!mentionState) return;
  const option = mentionState.options[index];
  if (!option) return;
  const caret = composerInput.selectionStart;
  const before = composerInput.value.slice(0, mentionState.start);
  const after = composerInput.value.slice(caret);
  const inserted = `${option.alias} `;
  composerInput.value = `${before}${inserted}${after}`;
  const nextCaret = mentionState.start + inserted.length;
  composerInput.setSelectionRange(nextCaret, nextCaret);
  closeMentionPopup();
  autoresize();
  composerInput.focus();
}

function moveMentionSelection(delta) {
  if (!mentionState) return;
  const count = mentionState.options.length;
  mentionState.index = (mentionState.index + delta + count) % count;
  [...mentionPopup.children].forEach((child, index) => {
    child.classList.toggle("is-active", index === mentionState.index);
  });
}

// --- 입력창 ---
function autoresize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 132)}px`;
}

async function sendCurrentMessage() {
  // 응답은 보낸 방에만 적용한다. 기다리는 사이 다른 방으로 옮기면 그 방의 입력칸·
  // 첨부를 건드리지 않는다.
  const sessionId = activeSessionId;
  const text = composerInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
  // 전송 실패 시 작성 중이던 내용을 복원하기 위해 보관해 둔다.
  const draftText = composerInput.value;
  composerInput.value = "";
  closeMentionPopup();
  autoresize();
  const independent = isIndependentResponseMode;
  const result = await call(
    window.chatApi.send(sessionId, text, attachmentIds, independent)
  );
  if (!result) {
    // 첨부는 전송 전까지 목록에서 빼지 않았으므로 글만 되돌린다.
    restoreFailedDraft(sessionId, draftText);
  } else if (sessionId === activeSessionId) {
    // 보낸 첨부만 뺀다. 기다리는 사이 새로 붙인 첨부는 남긴다.
    pendingAttachments = pendingAttachments.filter((attachment) => !attachmentIds.includes(attachment.id));
    renderPendingAttachments();
  }
  if (sessionId === activeSessionId) composerInput.focus();
}

composerInput.addEventListener("input", () => {
  autoresize();
  updateMentionPopup();
});

composerInput.addEventListener("click", updateMentionPopup);

composerInput.addEventListener("keydown", (event) => {
  if (mentionState && !mentionPopup.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMentionSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMentionSelection(-1);
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      acceptMention(mentionState.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionPopup();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendCurrentMessage();
  }
});

composerInput.addEventListener("blur", () => {
  setTimeout(closeMentionPopup, 120);
});

// Windows IME focus hardening.
//
// 계측으로 확인한 사실: 창이 blur될 때 Chromium은 focus된 요소에 DOM blur
// 이벤트만 보내고 document.activeElement는 그 요소로 남겨 둔다. 그래서 다른
// 창에 갔다가 돌아와 composer를 다시 클릭해도 이미 activeElement라서 focus
// 전환이 전혀 일어나지 않는다(복귀 후 클릭에 mousedown/click만 있고 focus
// 이벤트 없음). IME 입력 컨텍스트가 갱신될 계기가 없는 상태가 이렇게 만들어진다.
//
// 그래서 창이 blur되면 DOM focus를 실제로 놓고, 복귀 시 창 활성화가 끝난 다음
// 프레임에 되돌려 준다. 이렇게 해야 진짜 focus 전환이 생겨 IME 입력 컨텍스트가
// 새로 만들어진다. focus()를 반복 호출하는 방식은 전환 없이 같은 상태를 덮어쓸
// 뿐이라 쓰지 않는다.
//
// 주의: 보고된 증상(조합 문자열이 화면 좌상단 흰 상자에 표시)은 자동화
// 하네스에서 재현되지 않았다. 이 코드는 위에서 측정한 stale focus 상태를
// 제거하는 hardening이며, 그 증상의 확정된 원인 수정으로 단정하지 않는다.
let imeRefocusTarget = null;

window.addEventListener("blur", () => {
  const active = document.activeElement;
  if (active === composerInput) {
    imeRefocusTarget = active;
    active.blur();
  } else {
    imeRefocusTarget = null;
  }
});

window.addEventListener("focus", () => {
  const target = imeRefocusTarget;
  imeRefocusTarget = null;
  if (!target || target.disabled) return;
  requestAnimationFrame(() => {
    // 사용자가 복귀 직후 다른 곳을 눌렀다면 그 focus를 빼앗지 않습니다.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (target.disabled) return;
    target.focus();
  });
});

// 알려진 상위 계층(Electron/Chromium + Windows 한국어 IME) 동작:
// 조합 중에 창이 blur되면 조합 중이던 마지막 음절이 commit되지 않고
// compositionend 직후 deleteContentBackward로 삭제된다. 이미 확정된 문자열은
// 그대로 남는다. Agora 코드가 없는 최소 Electron textarea에서도 동일하게
// 재현되므로 앱 계층 결함이 아니며, 여기서 문자열을 되살리는 보정은 하지 않는다
// (강제 복원은 조합 상태와 어긋날 수 있어 더 나쁜 실패를 만든다).
sendButton.addEventListener("click", sendCurrentMessage);
stopButton.addEventListener("click", () => call(window.chatApi.stop(activeSessionId)));

newProjectButton.addEventListener("click", async () => {
  openNewProjectPopover(newProjectButton);
});

// 재탐지 버튼은 글자 없는 아이콘이라, 도는 동안 aria-busy로 아이콘을 돌려
// 눌렸다는 것과 아직 끝나지 않았다는 것을 보여 주고 중복 실행을 막는다.
refreshProvidersButton.addEventListener("click", async () => {
  if (refreshProvidersButton.getAttribute("aria-busy") === "true") return;
  refreshProvidersButton.setAttribute("aria-busy", "true");
  try {
    const result = await call(window.chatApi.providersRefresh());
    if (result?.providers) {
      providers = result.providers;
      diagnostics = result.diagnostics || diagnostics;
      flashNotice("CLI 탐지를 새로 고쳤습니다.", false);
      renderHeader();
      if (!doctorBackdrop.hidden) renderDoctor();
    }
  } finally {
    refreshProvidersButton.removeAttribute("aria-busy");
  }
});

doctorButton.addEventListener("click", () => openDoctor());
doctorClose.addEventListener("click", closeDoctor);
doctorDone.addEventListener("click", closeDoctor);
doctorBackdrop.addEventListener("click", (event) => {
  if (event.target === doctorBackdrop) closeDoctor();
});
doctorRefresh.addEventListener("click", async () => {
  doctorRefresh.disabled = true;
  doctorRefresh.textContent = "진단 중…";
  const result = await call(window.chatApi.providersRefresh());
  if (result?.providers) providers = result.providers;
  if (result?.diagnostics) diagnostics = result.diagnostics;
  renderDoctor();
  renderHeader();
  doctorRefresh.disabled = false;
  doctorRefresh.textContent = "다시 진단";
});

sessionTitleEl.addEventListener("click", startHeaderRename);

// --- 타이틀바 ---
document.getElementById("btn-settings").addEventListener("click", () => window.chatApi.openSettings());
document.getElementById("btn-minimize").addEventListener("click", () => window.chatApi.minimize());
document.getElementById("btn-maximize").addEventListener("click", () => window.chatApi.maximize());
document.getElementById("btn-close").addEventListener("click", () => window.chatApi.close());
window.chatApi.onMaximizedState((isMaximized) => {
  document.querySelector(".icon-maximize").style.display = isMaximized ? "none" : "";
  document.querySelector(".icon-restore").style.display = isMaximized ? "" : "none";
});

// --- 상태 적용 ---
function applyFullState(full) {
  if (full.providers) providers = full.providers;
  if (full.diagnostics) diagnostics = full.diagnostics;
  if (full.discussionPresets) discussionPresets = full.discussionPresets;
  if (full.projects) projects = full.projects;
  if (full.workflow) workflow = full.workflow;
  if (Object.hasOwn(full, "activeProjectId")) activeProjectId = full.activeProjectId;
  if (full.sessions) sessions = full.sessions;
  if (full.sessionsByProject) sessionsByProject = full.sessionsByProject;
  if (Object.hasOwn(full, "activeSessionId")) switchActiveSession(full.activeSessionId);

  if (full.session) {
    sessionMeta = full.session.meta;
    agents = full.session.agents || [];
    typingAgents.clear();
    for (const agentId of full.session.typing || []) typingAgents.add(agentId);
    roomTurnState = full.session.turnState || { current: null, queue: [], deferred: [] };
    pendingAttachments = full.session.pendingAttachments || [];
    renderAllMessages(full.session.messages);
    scrollToBottom(true);
  }

  if (full.error) {
    storeWarning.dataset.persistent = "1";
    storeWarning.textContent = `저장소 문제: ${full.error} — 대화가 저장되지 않을 수 있습니다.`;
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
    clearTimeout(noticeTimer);
  } else if (full.readOnly) {
    storeWarning.dataset.persistent = "1";
    storeWarning.textContent =
      "이 .agora 저장소는 더 새로운 버전이 만든 것이라 읽기 전용으로 열렸습니다.";
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
    clearTimeout(noticeTimer);
  } else {
    delete storeWarning.dataset.persistent;
  }

  // renderSessions는 트리 전체를 다시 그리므로 한 번만 호출합니다.
  renderProjects();
  renderHeader();
  renderAgents();
  renderTyping();
  renderPendingAttachments();
  syncComposerLock();
}

// --- 이벤트 구독 ---
window.chatApi.onMessage(({ sessionId, message }) => {
  if (sessionId !== activeSessionId) return;
  appendMessage(message);
});
window.chatApi.onTyping(({ sessionId, agentId, busy }) => {
  if (sessionId !== activeSessionId) return;
  if (busy) typingAgents.add(agentId);
  else typingAgents.delete(agentId);
  renderTyping();
});
window.chatApi.onTurnState(({ sessionId, ...state }) => {
  if (sessionId !== activeSessionId) return;
  roomTurnState = {
    current: state.current || null,
    // 독립 발언은 여러 담당자가 동시에 돈다. current 하나만 받으면 나머지가
    // 화면 판단에서 사라진다.
    running: Array.isArray(state.running) ? state.running : [],
    queue: Array.isArray(state.queue) ? state.queue : [],
    deferred: Array.isArray(state.deferred) ? state.deferred : [],
  };
  renderHeader();
});
window.chatApi.onReset(({ sessionId }) => {
  if (sessionId !== activeSessionId) return;
  renderAllMessages([]);
  chatMessages = [];
  typingAgents.clear();
  // 세션 비우기 시 백엔드도 대기를 지웠지만 agents emit이 따로 오지 않을 수
  // 있어, 화면의 대기 배지를 로컬에서도 즉시 내린다.
  for (const agent of agents) {
    agent.awaitingUser = false;
    agent.awaitingQuestion = null;
  }
  renderAgents();
  roomTurnState = { current: null, running: [], queue: [], deferred: [] };
  // Stage C — 방 reset(중지/초기화) 시 남은 승인 카드를 모두 제거한다(late accept 방지 UX).
  approvalQueue.length = 0;
  activeApproval = null;
  approvalBackdrop.hidden = true;
  syncComposerLock();
  renderTyping();
});
window.chatApi.onSystemNotice(({ text }) => {
  appendMessage({ authorType: "system", error: true, text, ts: Date.now() });
});
window.chatApi.onRunEvent(handleRunEvent);
window.chatApi.onSessionsChanged((payload) => {
  if (payload.projects) projects = payload.projects;
  if (payload.workflow) workflow = payload.workflow;
  if (Object.hasOwn(payload, "activeProjectId")) activeProjectId = payload.activeProjectId;
  sessions = payload.sessions || sessions;
  // 초기 chat:state(CLI 탐지 포함)가 느릴 때 이 이벤트가 먼저 도착합니다.
  // 트리 데이터를 함께 받지 않으면 그 사이 사이드바가 "채팅 없음"으로 그려집니다.
  if (payload.sessionsByProject) sessionsByProject = payload.sessionsByProject;
  if (Object.hasOwn(payload, "activeSessionId")) switchActiveSession(payload.activeSessionId);
  renderProjects();
  const entry = activeSessionEntry();
  if (entry && sessionMeta && entry.title !== sessionMeta.title) {
    sessionMeta = { ...sessionMeta, title: entry.title };
    renderHeader();
  }
});
window.chatApi.onWorkflowChanged(({ projectId, workflow: nextWorkflow }) => {
  if (projectId !== activeProjectId || !nextWorkflow) return;
  workflow = nextWorkflow;
});
window.chatApi.onAgents(({ sessionId, agents: nextAgents }) => {
  if (sessionId !== activeSessionId) return;
  agents = nextAgents || [];
  renderAgents();
  renderHeader();
});
// 시작 뒤 백그라운드로 CLI 버전·모델 목록이 갱신되면 main이 새 목록을 밀어 줍니다.
// 열려 있는 모델 선택(팝오버·프로젝트 설정)은 다시 열어야 새 목록을 봅니다.
window.chatApi.onProviders?.((payload) => {
  if (!payload) return;
  if (Array.isArray(payload.providers)) providers = payload.providers;
  if (Array.isArray(payload.diagnostics)) diagnostics = payload.diagnostics;
  renderHeader();
  if (!doctorBackdrop.hidden) renderDoctor();
  if (payload.modelsChanged) {
    flashNotice("모델 목록을 새로 불러왔습니다. 모델 선택을 다시 열면 반영됩니다.", false);
  }
});
function lockComposer(locked) {
  composerInput.disabled = locked;
  sendButton.disabled = locked;
  attachButton.disabled = locked;
  composerInput.placeholder = locked
    ? "도구 실행 권한 요청에 답한 뒤 입력할 수 있습니다"
    : "질문이나 작업을 입력하세요  (@로 대상 지정 · Enter 전송)";
  sendButton.textContent = "전송";
  if (locked) composerInput.blur();
}

function showNextApproval() {
  if (activeApproval || approvalQueue.length === 0) return;
  activeApproval = approvalQueue.shift();
  const agent = agentById(activeApproval.agentId);
  approvalSummary.textContent = `${agent?.name || activeApproval.agentId}: ${activeApproval.summary}`;
  approvalDetail.textContent = activeApproval.detail || "세부 정보가 없습니다.";
  approvalBackdrop.hidden = false;
  syncComposerLock();
}
async function answerApproval(decision) {
  if (!activeApproval) return;
  const current = activeApproval;
  activeApproval = null;
  approvalBackdrop.hidden = true;
  await call(window.chatApi.approvalRespond(current.sessionId, current.approvalId, decision));
  syncComposerLock();
  composerInput.focus();
  showNextApproval();
}
approvalApprove.addEventListener("click", () => answerApproval("approve"));
approvalDeny.addEventListener("click", () => answerApproval("deny"));
window.chatApi.onApprovalRequest((payload) => {
  approvalQueue.push(payload);
  showNextApproval();
});
// Stage C — same-turn 승인 카드가 turn 종료/취소/서버 resolved로 무효화되면 dismiss한다
// (native protocol id 노출 없음; Agora approvalId만 사용). late accept를 UX에서도 막는다.
function dismissApproval(approvalId) {
  const idx = approvalQueue.findIndex((a) => a.approvalId === approvalId);
  if (idx >= 0) approvalQueue.splice(idx, 1);
  if (activeApproval && activeApproval.approvalId === approvalId) {
    activeApproval = null;
    approvalBackdrop.hidden = true;
    syncComposerLock();
    showNextApproval();
  }
}
window.chatApi.onApprovalResolved(({ sessionId, approvalId }) => {
  if (sessionId !== activeSessionId) return;
  dismissApproval(approvalId);
});
window.chatApi.onAppearance(applyAppearance);

// --- 사용량 (사이드바 스트립 + 팝오버) ---
const USAGE_STALE_MS = 60000;

async function loadUsage({ force = false } = {}) {
  if (usageLoading) return;
  usageLoading = true;
  renderUsageStrip();
  try {
    const response = await window.chatApi.usage(force);
    if (response?.ok && Array.isArray(response.data)) {
      usageItems = response.data;
      usageLoadedAt = Date.now();
    }
  } catch {
    // 사용량 조회 실패는 대화를 막지 않습니다. 스트립에 "—"로만 남깁니다.
  } finally {
    usageLoading = false;
    renderUsageStrip();
    if (usagePopoverOpen) openUsagePopover();
  }
}

function refreshUsageIfStale() {
  if (usageLoading) return Promise.resolve();
  if (Date.now() - usageLoadedAt < USAGE_STALE_MS) return Promise.resolve();
  return loadUsage();
}

function makeStripHead(text) {
  const cell = document.createElement("span");
  cell.className = "usage-strip-head";
  cell.textContent = text;
  return cell;
}

function renderUsageStrip() {
  usageStripItems.textContent = "";
  if (usageItems.length === 0) {
    const empty = document.createElement("span");
    empty.className = "usage-strip-empty";
    empty.textContent = usageLoading ? "사용량 확인 중…" : "사용량 정보 없음";
    usageStripItems.append(empty);
    return;
  }

  const summaries = usageItems.map((item) => usageView.summarizeWindows(item)).filter(Boolean);
  // 창 이름은 머리글에 한 번만 적고 아래 칸에는 숫자만 남깁니다. 좁은 사이드바에서
  // 같은 라벨을 공급자마다 반복하면 정작 숫자가 들어갈 자리가 없습니다.
  const headers = summaries.find((summary) => summary.windows.length === 2)
    ?.windows.map((window) => window.label) || ["5시간", "주간"];
  usageStripItems.append(makeStripHead("사용량"), ...headers.map(makeStripHead));

  for (const summary of summaries) {
    const name = document.createElement("span");
    name.className = "usage-row-name";
    name.textContent = summary.label;
    usageStripItems.append(name);

    if (summary.error) {
      const unknown = document.createElement("span");
      unknown.className = "usage-mini is-unknown";
      unknown.textContent = summary.error;
      usageStripItems.append(unknown);
      continue;
    }

    // 칸 자체가 막대입니다. 머리글(5시간/주간)과 일치하는 창을 찾아 알맞은 열에 넣습니다.
    for (const header of headers) {
      const window = summary.windows.find((w) => w.label === header);
      if (window) {
        const cell = document.createElement("span");
        cell.className = window.tone ? `usage-mini ${window.tone}` : "usage-mini";
        cell.style.setProperty("--fill", `${window.remaining}%`);
        const value = document.createElement("strong");
        value.textContent = `${window.remaining}%`;
        cell.append(value);
        cell.title = window.resetText
          ? `${summary.label} ${window.label} · 남음 ${window.remaining}% · ${usageView.resetLabel(window.resetText)}`
          : `${summary.label} ${window.label} · 남음 ${window.remaining}%`;
        usageStripItems.append(cell);
      } else {
        const emptyCell = document.createElement("span");
        emptyCell.className = "usage-mini usage-mini-empty";
        const emptyVal = document.createElement("span");
        emptyVal.className = "usage-mini-blank";
        emptyVal.textContent = "—";
        emptyCell.append(emptyVal);
        emptyCell.title = `${summary.label} ${header} 한도 없음`;
        usageStripItems.append(emptyCell);
      }
    }
  }
}

function createUsageGaugeRow(gauge) {
  const remaining = usageView.remainingPercent(gauge);
  const row = document.createElement("div");
  row.className = "usage-gauge";

  const head = document.createElement("div");
  head.className = "usage-gauge-head";
  const label = document.createElement("span");
  label.textContent = gauge.label;
  const value = document.createElement("strong");
  value.textContent = `${remaining}%`;
  head.append(label, value);

  // 막대도 "남은 양"으로 채웁니다. 숫자와 막대가 같은 방향을 가리켜야 한눈에 읽힙니다.
  const track = document.createElement("div");
  track.className = "usage-track";
  const fill = document.createElement("i");
  fill.className = usageView.usageTone(gauge.usedPercent);
  fill.style.width = `${remaining}%`;
  track.append(fill);
  row.append(head, track);

  // 초기화 시각을 모르면 줄을 아예 만들지 않습니다. (빈 "—"가 줄줄이 남지 않도록)
  if (gauge.resetText) {
    const reset = document.createElement("small");
    reset.textContent = usageView.resetLabel(gauge.resetText);
    row.append(reset);
  }
  return row;
}

function openUsagePopover() {
  usagePopoverOpen = true;
  openPopover(usageButton, (target) => {
    target.classList.add("is-usage");

    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = "남은 사용량";
    target.append(title);

    if (usageItems.length === 0) {
      const empty = document.createElement("p");
      empty.className = "usage-empty";
      empty.textContent = usageLoading ? "확인 중…" : "사용량을 불러오지 못했습니다.";
      target.append(empty);
    }

    for (const item of usageItems) {
      const card = document.createElement("section");
      card.className = "usage-card";
      const heading = document.createElement("h3");
      heading.textContent = item.label;
      card.append(heading);

      if (item.error) {
        const error = document.createElement("p");
        error.className = "usage-empty";
        error.textContent = item.error;
        const diagnose = document.createElement("button");
        diagnose.type = "button";
        diagnose.className = "usage-diagnose";
        diagnose.textContent = "환경 진단";
        diagnose.addEventListener("click", () => {
          closePopover();
          openDoctor();
        });
        error.append(" ", diagnose);
        card.append(error);
      } else if (!item.gauges?.length) {
        const error = document.createElement("p");
        error.className = "usage-empty";
        error.textContent = "한도 정보 없음";
        card.append(error);
      } else {
        for (const gauge of item.gauges) card.append(createUsageGaugeRow(gauge));
      }
      target.append(card);
    }

    const actions = document.createElement("div");
    actions.className = "usage-popover-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "button button-small";
    refresh.textContent = usageLoading ? "확인 중…" : "새로고침";
    refresh.disabled = usageLoading;
    refresh.addEventListener("click", () => {
      // 완료되면 loadUsage가 열려 있는 팝오버를 그대로 다시 그립니다.
      void loadUsage({ force: true });
    });
    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "button button-small";
    detail.textContent = "설정에서 보기";
    detail.addEventListener("click", () => {
      closePopover();
      window.chatApi.openSettings("usage");
    });
    actions.append(refresh, detail);
    target.append(actions);
  });
}

usageButton.addEventListener("click", () => {
  if (usagePopoverOpen) {
    closePopover();
    return;
  }
  openUsagePopover();
  void refreshUsageIfStale();
});

// 사용량은 항상 떠 있는 대신 접기/펼치기입니다. 기본은 접힘이고, 펼친 상태를 기억합니다.
// 접혀 있는 동안에는 사용량 조회 자체를 하지 않아 시작이 가볍습니다.
const USAGE_FOLD_KEY = "agora.chat.usageOpen";
let usageOpen = localStorage.getItem(USAGE_FOLD_KEY) === "true";

function applyUsageFold() {
  usageButton.hidden = !usageOpen;
  usageFoldToggle.setAttribute("aria-expanded", String(usageOpen));
  usageFoldToggle.classList.toggle("is-open", usageOpen);
}

usageFoldToggle.addEventListener("click", () => {
  usageOpen = !usageOpen;
  localStorage.setItem(USAGE_FOLD_KEY, String(usageOpen));
  applyUsageFold();
  if (usageOpen) void refreshUsageIfStale();
});
applyUsageFold();

// 다른 창에서 사용량을 쓰고 돌아왔을 수 있으므로 포커스 복귀 때 한 번 확인합니다. (60초 스로틀)
// 접혀 있고 팝오버도 닫혀 있으면 확인할 필요가 없습니다.
window.addEventListener("focus", () => {
  if (usageOpen || usagePopoverOpen) void refreshUsageIfStale();
});



// --- 초기화 ---
(async () => {
  if (usageOpen) void loadUsage();
  const full = await call(window.chatApi.state());
  if (full) {
    applyFullState(full);
    if (localStorage.getItem(DOCTOR_SEEN_KEY) !== "true") openDoctor({ firstRun: true });
  }
  composerInput.focus();
})();
