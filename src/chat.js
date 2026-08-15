/* global chatMarkdown, usageView */
const chatScroll = document.getElementById("chat-scroll");
const messageList = document.getElementById("message-list");
const typingRow = document.getElementById("typing-row");
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
const sessionListEl = document.getElementById("session-list");
const newSessionButton = document.getElementById("btn-new-session");
const projectListEl = document.getElementById("project-list");
const newProjectButton = document.getElementById("btn-new-project");
const chatsHeading = document.getElementById("chats-heading");
const refreshProvidersButton = document.getElementById("btn-refresh-providers");
const doctorButton = document.getElementById("btn-doctor");
const sessionTitleEl = document.getElementById("session-title");
const workspaceButton = document.getElementById("btn-workspace");
const workspaceLabel = document.getElementById("workspace-label");
const permissionSelect = document.getElementById("permission-select");
const permissionWarning = document.getElementById("permission-warning");
const enforcementHint = document.getElementById("enforcement-hint");
const discussionButton = document.getElementById("btn-discussion");
const workflowButton = document.getElementById("btn-workflow");
const specialistButton = document.getElementById("btn-specialist");
const roomControlsActions = document.querySelector(".room-controls-actions");
const usageButton = document.getElementById("btn-usage");
const usageStripItems = document.getElementById("usage-strip-items");
const professionalActions = document.getElementById("professional-actions");
const professionalPlanButton = document.getElementById("btn-professional-plan");
const professionalImplementationButton = document.getElementById("btn-professional-implementation");
const professionalRecordButton = document.getElementById("btn-professional-record");
const professionalFullButton = document.getElementById("btn-professional-full");
const professionalPlanViewButton = document.getElementById("btn-professional-plan-view");
const professionalProgress = document.getElementById("professional-progress");
const planAutoReviseToggle = document.getElementById("plan-auto-revise");
const planAutoLimitSelect = document.getElementById("plan-auto-limit");
const implementationAutoReviseToggle = document.getElementById("implementation-auto-revise");
const implementationAutoLimitSelect = document.getElementById("implementation-auto-limit");
const storeWarning = document.getElementById("store-warning");
const popover = document.getElementById("popover");
const popoverBackdrop = document.getElementById("popover-backdrop");
const appEl = document.querySelector(".app");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizer = document.getElementById("sidebar-resizer");
const sidebarToggle = document.getElementById("sidebar-toggle");
const approvalBackdrop = document.getElementById("approval-backdrop");
const approvalSummary = document.getElementById("approval-summary");
const approvalDetail = document.getElementById("approval-detail");
const approvalApprove = document.getElementById("approval-approve");
const approvalDeny = document.getElementById("approval-deny");
const doctorBackdrop = document.getElementById("doctor-backdrop");
const doctorList = document.getElementById("doctor-list");
const doctorSummary = document.getElementById("doctor-summary");
const doctorRefresh = document.getElementById("doctor-refresh");
const doctorClose = document.getElementById("doctor-close");
const doctorDone = document.getElementById("doctor-done");
const specialistBackdrop = document.getElementById("specialist-backdrop");
const specialistBody = document.getElementById("specialist-body");
const specialistCancelBtn = document.getElementById("specialist-cancel");
const specialistCloseBtn = document.getElementById("specialist-close");

let providers = [];
let diagnostics = [];
let projects = [];
let activeProjectId = null;
let sessions = [];
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
const liveRuns = new Map(); // runId → { item, textEl, statusEl, text }
let mentionState = null;
let noticeTimer = null;
let specialistRunning = false;
let specialistResumeAvailable = false;
// 구현이 막힘(BLOCKED)으로 멈춰 사용자의 후속 선택을 기다리는 중인지.
let specialistBlockedAvailable = false;
// 단계별(step) 실행에서 현재 멈춘 단계(plan_ready/builder_done/review_fix_required/review_pass).
let specialistResumePhase = null;
// 전문 실행 진행 상태(진행 표시·입력창 잠금에 사용).
let specialistActive = false;
let specialistNeedsInput = false;
let specialistPlanReady = false;
let specialistNode = null;
let specialistStatus = null;
let professionalModeEnabled = false;
// 승인된 기획안(TASK.md) 경로/제목. "기획안 보기" 버튼으로 열람합니다.
let specialistPlanTaskPath = null;
let specialistPlanTaskId = null;

const SIDEBAR_WIDTH_KEY = "agora.chat.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "agora.chat.sidebarCollapsed";
const DOCTOR_SEEN_KEY = "agora.chat.doctorSeen.v1";
const PLAN_AUTO_REVISE_KEY = "agora.chat.planAutoRevise";
const PLAN_AUTO_LIMIT_KEY = "agora.chat.planAutoLimit";
const IMPLEMENTATION_AUTO_REVISE_KEY = "agora.chat.implementationAutoRevise";
const IMPLEMENTATION_AUTO_LIMIT_KEY = "agora.chat.implementationAutoLimit";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;
const SPECIALIST_STAGE_LABELS = Object.freeze({
  planner: "기획",
  planning: "기획",
  design: "기획",
  plan_review: "기획 검수",
  implementation: "구현",
  builder: "구현",
  review: "검수",
  reviewer: "검수",
  recorder: "기록",
});

function boundedRevisionLimit(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : fallback;
}

planAutoReviseToggle.checked = localStorage.getItem(PLAN_AUTO_REVISE_KEY) === "true";
planAutoLimitSelect.value = String(
  boundedRevisionLimit(localStorage.getItem(PLAN_AUTO_LIMIT_KEY), 2)
);
implementationAutoReviseToggle.checked =
  localStorage.getItem(IMPLEMENTATION_AUTO_REVISE_KEY) === "true";
implementationAutoLimitSelect.value = String(
  boundedRevisionLimit(localStorage.getItem(IMPLEMENTATION_AUTO_LIMIT_KEY), 1)
);

function syncAutoRevisionControls() {
  planAutoLimitSelect.disabled = !planAutoReviseToggle.checked;
  implementationAutoLimitSelect.disabled = !implementationAutoReviseToggle.checked;
}

for (const [control, key] of [
  [planAutoReviseToggle, PLAN_AUTO_REVISE_KEY],
  [implementationAutoReviseToggle, IMPLEMENTATION_AUTO_REVISE_KEY],
]) {
  control.addEventListener("change", () => {
    localStorage.setItem(key, String(control.checked));
    syncAutoRevisionControls();
  });
}

for (const [control, key] of [
  [planAutoLimitSelect, PLAN_AUTO_LIMIT_KEY],
  [implementationAutoLimitSelect, IMPLEMENTATION_AUTO_LIMIT_KEY],
]) {
  control.addEventListener("change", () => {
    control.value = String(boundedRevisionLimit(control.value));
    localStorage.setItem(key, control.value);
  });
}
syncAutoRevisionControls();

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

function setSidebarCollapsed(collapsed, persist = true) {
  appEl.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarToggle.textContent = collapsed ? "›" : "‹";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "세션 사이드바 펼치기" : "세션 사이드바 접기");
  sidebarToggle.title = collapsed ? "사이드바 펼치기" : "사이드바 접기";
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

applySidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY), false);
setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true", false);

sidebarToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setSidebarCollapsed(!appEl.classList.contains("is-sidebar-collapsed"));
});

sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.target === sidebarToggle || appEl.classList.contains("is-sidebar-collapsed")) return;
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
sidebarResizer.addEventListener("keydown", (event) => {
  if (event.target === sidebarToggle) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setSidebarCollapsed(!appEl.classList.contains("is-sidebar-collapsed"));
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  if (appEl.classList.contains("is-sidebar-collapsed")) setSidebarCollapsed(false);
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

function roleConfigFromProject(project, roleId) {
  const raw = project?.defaultRoles?.[roleId];
  if (typeof raw === "string") return { agentId: raw, model: "", effort: "" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { agentId: "", model: "", effort: "" };
  }
  return {
    agentId: String(raw.agentId || ""),
    model: String(raw.model || ""),
    effort: String(raw.effort || ""),
  };
}

function setSpecialistState(state = {}) {
  specialistActive = Boolean(state.active);
  specialistResumeAvailable = Boolean(state.available);
  specialistBlockedAvailable = Boolean(state.blocked);
  specialistResumePhase = specialistResumeAvailable ? state.phase || null : null;
  specialistNeedsInput = Boolean(state.needsInput);
  specialistPlanReady = Boolean(state.planReady);
  specialistNode = state.node || null;
  specialistStatus = state.status || null;
  specialistPlanTaskPath = state.planTaskPath || null;
  specialistPlanTaskId = state.planTaskId || null;
}

function specialistLocksComposer() {
  return Boolean(specialistActive || specialistBlockedAvailable || (specialistResumeAvailable && !specialistNeedsInput));
}

function syncComposerLock() {
  lockComposer(Boolean(activeApproval || specialistLocksComposer()));
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
      const login = document.createElement("button");
      login.className = "button button-small";
      login.type = "button";
      login.textContent = "로그인 명령 복사";
      login.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(diagnostic.loginCommand);
          flashNotice(`${diagnostic.loginCommand} 명령을 복사했습니다.`, false);
        } catch {
          flashNotice(`터미널에서 ${diagnostic.loginCommand} 명령을 실행해 주세요.`);
        }
      });
      actions.append(login);
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

function renderProjects() {
  projectListEl.textContent = "";
  const activeProject = activeProjectEntry();
  chatsHeading.textContent = activeProject ? `${activeProject.name}의 대화` : "대화";

  for (const project of projects) {
    const item = document.createElement("li");
    item.className = "project-item";
    if (project.id === activeProjectId) item.classList.add("is-active");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "project-select";
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;
    select.append(name);
    if (project.workspace) {
      const workspace = document.createElement("span");
      workspace.className = "project-meta";
      workspace.textContent = `폴더 · ${baseName(project.workspace)}`;
      workspace.title = project.workspace;
      select.append(workspace);
    }
    select.addEventListener("click", () => selectProject(project.id));

    const actions = document.createElement("span");
    actions.className = "project-actions";
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "project-action";
    settings.title = "프로젝트 설정";
    settings.textContent = "⋯";
    settings.addEventListener("click", (event) => {
      event.stopPropagation();
      openProjectSettings(settings, project);
    });
    actions.append(settings);
    item.append(select, actions);
    projectListEl.append(item);
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
      const currentModel = saved.model || agent.model || "default";
      if (!modelOptions.some((option) => option.id === currentModel)) {
        modelOptions.push({ id: currentModel, label: `${currentModel} (현재 설정)`, efforts: [] });
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
      populateDefaultEfforts(saved.effort || agent.effort || "default");
      model.addEventListener("change", () => populateDefaultEfforts("default"));
      row.append(head, makeField("모델", model), makeField("추론", effort));
      defaultAgentSection.append(row);
      defaultAgentControls.set(agent.id, { enabled, model, effort });
    }

    const roleControls = new Map();
    const roleSection = document.createElement("section");
    roleSection.className = "project-default-section";
    const roleTitle = document.createElement("strong");
    roleTitle.textContent = "전문 모드 역할 설정";
    const roleHint = document.createElement("p");
    roleHint.className = "popover-hint";
    roleHint.textContent = "기본 모드는 현재 채팅 설정을 쓰고, 전문 모드는 여기 지정한 담당자·모델을 씁니다. 기획 검수 담당자는 선택이며 비우면 검토 담당자를 사용합니다.";
    roleSection.append(roleTitle, roleHint);
    const workflowRoleDefs = workflow.roles?.length
      ? workflow.roles
      : [
          { id: "planning", label: "기획" },
          { id: "implementation", label: "구현" },
          { id: "review", label: "검토" },
          { id: "recorder", label: "기록" },
        ];
    // workflow 작업 역할을 늘리지 않고, 전문 실행 설정에만 선택형 기획 검수자를
    // 노출한다. 비워 두면 main 프로세스가 검토 담당자를 재사용한다.
    const roleDefs = [
      ...workflowRoleDefs.slice(0, 1),
      { id: "plan_review", label: "기획 검수 (선택)" },
      ...workflowRoleDefs.slice(1),
    ];
    for (const role of roleDefs) {
      const savedRole = roleConfigFromProject(project, role.id);
      const select = document.createElement("select");
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "지정 안 함";
      select.append(none);
      for (const agent of agents) {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = `@${agent.id} · ${agent.name}`;
        select.append(option);
      }
      select.value = savedRole.agentId || "";

      const model = document.createElement("select");
      const effort = document.createElement("select");
      const roleRow = document.createElement("div");
      roleRow.className = "project-agent-default";

      const populateEfforts = (provider, selected) => {
        effort.textContent = "";
        const defaultOption = document.createElement("option");
        defaultOption.value = "default";
        defaultOption.textContent = "공급자 기본값";
        effort.append(defaultOption);
        const options = provider ? effortOptionsForModel(provider, model.value) : [];
        for (const value of options) {
          const item = document.createElement("option");
          item.value = value;
          item.textContent = effortLabel(value);
          effort.append(item);
        }
        effort.value = options.includes(selected) ? selected : "default";
        effort.disabled = !provider || options.length === 0;
      };

      const populateModels = (selectedModel = "default", selectedEffort = "default") => {
        model.textContent = "";
        const agent = agentById(select.value);
        const provider = agent ? providerById(agent.id) : null;
        if (!provider) {
          const item = document.createElement("option");
          item.value = "default";
          item.textContent = "담당자를 먼저 선택하세요";
          model.append(item);
          model.value = "default";
          model.disabled = true;
          populateEfforts(null, "default");
          return;
        }
        const options = modelOptionsForProvider(provider, true);
        if (selectedModel && !options.some((option) => option.id === selectedModel)) {
          options.push({ id: selectedModel, label: `${selectedModel} (현재 설정)`, efforts: [] });
        }
        for (const option of options) {
          const item = document.createElement("option");
          item.value = option.id;
          item.textContent = option.label || option.id;
          model.append(item);
        }
        model.value = selectedModel || "default";
        model.disabled = !agent.available;
        populateEfforts(provider, selectedEffort);
      };

      select.addEventListener("change", () => populateModels("default", "default"));
      model.addEventListener("change", () => {
        const provider = providerById(select.value);
        populateEfforts(provider, "default");
      });
      populateModels(savedRole.model || "default", savedRole.effort || "default");
      roleRow.append(
        makeField(role.label || role.id, select),
        makeField("모델", model),
        makeField("추론", effort)
      );
      roleSection.append(roleRow);
      roleControls.set(role.id, { agent: select, model, effort });
    }

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
      const defaultRoles = {};
      for (const [roleId, controls] of roleControls) {
        if (controls.agent.value) {
          defaultRoles[roleId] = {
            agentId: controls.agent.value,
            model: controls.model.value,
            effort: controls.effort.value,
          };
        }
      }
      const result = await call(window.chatApi.projectsUpdate(project.id, {
        name: name.value,
        context: context.value,
        defaultPermissionMode: permission.value,
        defaultAgents,
        defaultRoles,
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
        const yes = window.confirm(
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
      roleSection,
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

      // 프로젝트 폴더가 이 대화의 현재 폴더와 다를 때만 적용 여부를 물어봅니다.
      // 기본값은 기존 대화의 워크스페이스/권한을 그대로 유지하는 것입니다.
      let applyWorkspace = false;
      if (project.id !== activeProjectId && project.workspace && project.workspace !== session.workspace) {
        const applyRow = document.createElement("label");
        applyRow.className = "project-move-apply-workspace";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.addEventListener("change", () => {
          applyWorkspace = checkbox.checked;
        });
        const text = document.createElement("span");
        text.textContent = `이 대화에도 "${baseName(project.workspace)}" 폴더 적용`;
        applyRow.append(checkbox, text);
        row.append(applyRow);
      }

      option.addEventListener("click", async () => {
        const result = await call(
          window.chatApi.sessionsMove(session.id, project.id, applyWorkspace)
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

function renderSessions() {
  // 이름을 고치는 중에는 다시 그리지 않습니다. 다른 창에서 온 갱신 때문에
  // 입력창이 통째로 사라져 편집이 날아가는 사고를 막습니다. (commit이 끝나면 직접 호출합니다)
  if (renamingSessionId) {
    renderSessionsPending = true;
    return;
  }
  renderSessionsPending = false;
  sessionListEl.textContent = "";
  for (const entry of sessions) {
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

    const metaLine = document.createElement("span");
    metaLine.className = "session-meta";
    const time = document.createElement("span");
    time.textContent = formatRelativeTime(entry.updatedAt);
    metaLine.append(time);
    if (entry.workspace) {
      const workspace = document.createElement("span");
      workspace.className = "session-workspace";
      workspace.textContent = `📁 ${baseName(entry.workspace)}`;
      workspace.title = entry.workspace;
      metaLine.append(workspace);
    }
    main.append(titleLine, metaLine);
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
    sessionListEl.append(item);
  }
}

function sessionMoreAnchor(sessionId) {
  return sessionListEl.querySelector(`[data-session-more="${CSS.escape(sessionId)}"]`);
}

// 사이드바 목록에서 해당 대화의 제목을 인라인 편집으로 바꿉니다.
function startSessionRename(sessionId) {
  const titleEl = sessionListEl.querySelector(`[data-session-name="${CSS.escape(sessionId)}"]`);
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
  const yes = window.confirm(
    `"${entry.title}" 세션을 휴지통으로 옮길까요?\n첨부 사본도 함께 이동하며 30일 후 정리됩니다.`
  );
  if (!yes) return;
  const result = await call(window.chatApi.sessionsDelete(entry.id));
  if (result) applyFullState(result);
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

  const workspace = sessionMeta?.workspace || null;
  workspaceLabel.textContent = workspace ? baseName(workspace) : "워크스페이스 없음";
  workspaceButton.title = workspace
    ? `${workspace}\n클릭해 변경 · 우클릭으로 해제`
    : "세션에서 사용할 폴더를 선택합니다";

  const mode = sessionMeta?.permissionMode || "chat";
  permissionSelect.value = mode;
  for (const option of permissionSelect.options) {
    if (option.value !== "chat") {
      option.disabled = !workspace;
      option.title = workspace ? "" : "먼저 워크스페이스를 선택하세요";
    }
  }

  // 전문 모드는 쓰기 권한이 필요하므로, 그렇지 않으면 눈에 띄게 안내합니다.
  const projectForWarning = projects.find((entry) => entry.id === activeProjectId);
  const specialistConfigured = Boolean(
    roleConfigFromProject(projectForWarning, "implementation").agentId &&
      roleConfigFromProject(projectForWarning, "review").agentId
  );
  if (specialistConfigured && mode !== "workspace-write") {
    permissionWarning.hidden = false;
    permissionWarning.textContent = workspace
      ? "전문 모드엔 쓰기 권한 필요"
      : "전문 모드엔 폴더+쓰기 권한 필요";
    permissionWarning.title =
      "전문 모드는 워크스페이스 쓰기 권한으로 실행됩니다. 클릭하면 이 채팅을 쓰기 권한으로 바꿉니다.";
  } else {
    permissionWarning.hidden = true;
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
  const project = projects.find((entry) => entry.id === activeProjectId);
  const planner = roleConfigFromProject(project, "planning");
  const implementation = roleConfigFromProject(project, "implementation");
  const review = roleConfigFromProject(project, "review");
  const configured = Boolean(planner.agentId && implementation.agentId && review.agentId);
  specialistButton.disabled = !activeSessionId || specialistRunning || specialistActive;
  specialistButton.setAttribute("aria-checked", String(professionalModeEnabled));
  specialistButton.title = specialistBlockedAvailable
    ? "구현이 막혔습니다. 다음 처리 방법을 선택하세요"
    : professionalModeEnabled
      ? "일반 대화 화면으로 돌아갑니다"
      : configured
        ? "PLAN, 실행, 전체 실행 버튼을 표시합니다"
        : "프로젝트 설정에서 기획·구현·검토 담당자를 지정하면 사용할 수 있습니다";
  specialistButton.setAttribute(
    "aria-label",
    professionalModeEnabled ? "전문 실행에서 일반 대화로 전환" : "일반 대화에서 전문 실행으로 전환"
  );
  professionalActions.hidden = !professionalModeEnabled;
  roomControlsActions.classList.toggle("is-professional-mode", professionalModeEnabled);
  // discussable = 사용 가능하고 참여 중인 에이전트가 둘 이상.
  responseModeBar.hidden = professionalModeEnabled || !discussable;
  const blockedOrBusy = specialistRunning || specialistActive || specialistBlockedAvailable || specialistResumeAvailable;
  const planStartable = !specialistNode || specialistNode === "COMPLETED" || specialistStatus === "INTERRUPTED" || specialistNeedsInput;
  professionalPlanButton.disabled = !configured || blockedOrBusy || !planStartable;
  professionalImplementationButton.disabled = !configured || blockedOrBusy || !specialistPlanReady;
  const canRegenerateRecord = specialistNode === "COMPLETED" || (specialistNode === "RECORDING" && specialistStatus === "WAITING");
  professionalRecordButton.hidden = !canRegenerateRecord;
  professionalRecordButton.disabled = !review.agentId || blockedOrBusy;
  professionalRecordButton.title = "완료된 실행의 기록을 다시 만듭니다";
  professionalFullButton.disabled = !configured || blockedOrBusy || !planStartable;
  // 저장된 기획안이 있으면(승인 대기 중이거나 통과한 경우) 열람 버튼을 노출합니다.
  const hasPlanTask = Boolean(specialistPlanTaskPath);
  professionalPlanViewButton.hidden = !hasPlanTask;
  professionalPlanViewButton.disabled = specialistRunning || specialistActive;
  professionalPlanViewButton.textContent = specialistPlanTaskId
    ? `기획안 보기 (${specialistPlanTaskId})`
    : "기획안 보기";
  professionalImplementationButton.title = specialistPlanReady
    ? "기획 검수를 통과한 작업을 구현·검수·기록까지 실행합니다"
    : "먼저 기획·검수를 통과시켜 주세요";
  // 다음에 실행할 단계를 강조합니다: 기획 통과 전이면 1단계, 통과 후면 2단계.
  const nextIsImplementation = configured && specialistPlanReady && !blockedOrBusy;
  const nextIsPlan = configured && !specialistPlanReady && !blockedOrBusy;
  professionalPlanButton.classList.toggle("is-next-step", nextIsPlan);
  professionalImplementationButton.classList.toggle("is-next-step", nextIsImplementation);
  if (professionalProgress) {
    const indexByNode = {
      PLANNING: 0,
      PLAN_REVIEW: 1,
      READY: 1,
      IMPLEMENTING: 2,
      REVIEWING: 3,
      RECORDING: 4,
      COMPLETED: 4,
    };
    const current = Number.isInteger(indexByNode[specialistNode]) ? indexByNode[specialistNode] : -1;
    const steps = ["plan", "plan-review", "implementation", "review", "record"];
    steps.forEach((step, index) => {
      const item = professionalProgress.querySelector(`[data-professional-step="${step}"]`);
      if (!item) return;
      item.classList.toggle("is-current", index === current);
      item.classList.toggle("is-complete", current >= 0 && index < current);
    });
  }
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
    chip.title = agent.available
      ? agent.enabled
        ? "클릭해 모델/속도 설정"
        : "이 세션에서 비활성화됨 · 클릭해 설정"
      : agent.reason || "CLI를 찾지 못했습니다";

    const avatar = makeAgentAvatar(agent, "agent-avatar");
    chip.append(avatar, document.createTextNode(`@${agent.id}`));
    chip.addEventListener("click", () => openAgentPopover(chip, agent.id));
    agentChips.append(chip);
  }
}

const POPOVER_VARIANTS = ["is-project-settings", "is-workflow", "plan-preview-popover", "is-menu", "is-usage"];

function closePopover() {
  popover.hidden = true;
  popover.textContent = "";
  popover.classList.remove(...POPOVER_VARIANTS);
  popoverBackdrop.hidden = true;
  usagePopoverOpen = false;
}

// 버튼 대신 커서 좌표에도 띄울 수 있도록 위치 계산을 rect 기준으로 분리했습니다.
// (세션 우클릭 메뉴가 이 형태를 씁니다.)
function openPopoverAt(rect, build) {
  popover.textContent = "";
  popover.classList.remove(...POPOVER_VARIANTS);
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
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) closePopover();
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
  const source = agentById(sourceAuthor);
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
    const intentReview = document.createElement("option");
    intentReview.value = "REVIEW_OPINION";
    intentReview.textContent = "검토 요청";
    const intentContinue = document.createElement("option");
    intentContinue.value = "CONTINUE";
    intentContinue.textContent = "이어서 작업";
    intentSelect.append(intentContinue, intentReview);
    root.append(makeField("전달 의도", intentSelect));

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
        const target = targetSelect.value;
        const intent = intentSelect.value;
        closePopover();
        await call(
          window.chatApi.handoffMessage(sessionMeta?.id, target, messageId, intent)
        );
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
    for (const model of modelOptions) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label || model.id;
      modelSelect.append(option);
    }
    const currentModel = agent.model;
    if (!modelOptions.some((option) => option.id === currentModel)) {
      const legacyOption = document.createElement("option");
      legacyOption.value = currentModel;
      legacyOption.textContent = `${currentModel} (현재 설정 · 목록에 없음)`;
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
    populateEfforts(currentModel, agent.effort);
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
    autoApproveToggle.addEventListener("change", async () => {
      if (autoApproveToggle.checked) {
        const confirmed = window.confirm(
          `${agent.name}의 도구 자동 승인을 켤까요?\n명령 실행과 파일 변경이 개별 확인 없이 진행됩니다. 신뢰하는 워크스페이스에서만 사용하세요.`
        );
        if (!confirmed) { autoApproveToggle.checked = false; return; }
      }
      await configureAgent(agentId, { autoApprove: autoApproveToggle.checked });
    });
    root.append(makeField("도구 자동 승인", autoApproveToggle));

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
  const result = await call(window.chatApi.agentConfigure(activeSessionId, agentId, patch));
  if (result?.meta) {
    sessionMeta = result.meta;
    renderHeader();
  }
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
        if (!window.confirm("이 결정을 삭제할까요?")) return;
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
    defaultAgentOption.textContent = "프로젝트 기본 담당자";
    taskAgent.append(defaultAgentOption);
    for (const agent of agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `@${agent.id} · ${agent.name}`;
      taskAgent.append(option);
    }
    const syncTaskAgent = () => {
      const defaultAgent = roleConfigFromProject(project, taskRole.value).agentId || "";
      taskAgent.value = defaultAgent || "";
    };
    syncTaskAgent();
    taskRole.addEventListener("change", syncTaskAgent);
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
      syncTaskAgent();
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

    function renderTaskCard(task) {
      const card = document.createElement("article");
      card.className = "workflow-card";
      const cardTitle = document.createElement("div");
      cardTitle.className = "workflow-card-title";
      cardTitle.textContent = task.title;
      const cardText = document.createElement("div");
      cardText.className = "workflow-card-text";
      cardText.textContent = task.description || "설명 없음";
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
      projectDefault.textContent = "프로젝트 기본";
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
        if (!window.confirm("이 작업을 삭제할까요?")) return;
        const result = await call(window.chatApi.tasksDelete(project.id, task.id));
        if (!result) return;
        applyFullState(result);
        openWorkflowPopover(anchor);
      });
      controls.append(status, role, owner, edit, save, remove);
      card.append(cardTitle, cardText, meta, controls);
      return card;
    }

    tabPanels.tasks.append(taskProposalsSection, taskFormToggle, taskForm, tasksSection, doneToggle, doneSection);

    selectTab("memory");
  });
}

// --- 토론 팝오버 ---
workflowButton.addEventListener("click", () => openWorkflowPopover(workflowButton));
// 작업 시작 모달을 열고 상태에 따라 본문을 채웁니다.
async function openSpecialistDialog() {
  if (!activeSessionId) return;
  const result = await call(window.chatApi.specialistBlockDetails(activeSessionId));
  if (!activeSessionId) return;
  renderSpecialistDialog(result?.details || null);
  specialistBackdrop.hidden = false;
}

function closeSpecialistDialog() {
  specialistBackdrop.hidden = true;
  specialistBody.textContent = "";
}

// 이 모달은 구현이 막혔을 때(BLOCKED)의 후속 처리 전용입니다.
// 기획·구현·검수 실행은 전문 실행 줄의 버튼(runProfessionalAction)이 담당합니다.
function renderSpecialistDialog(details = null) {
  specialistBody.textContent = "";
  const hint = document.createElement("p");
  hint.className = "specialist-missing";
  const reason = details?.blockReason || "BLOCKED";
  hint.textContent = `전문 실행이 안전하게 중단되었습니다 (${reason}). 현재 변경은 보존되어 있습니다. 다음 처리를 선택해 주세요.`;
  specialistBody.append(hint);
  if (details?.runId || details?.taskPath) {
    const meta = document.createElement("p");
    meta.className = "popover-hint";
    const parts = [];
    if (details.runId) parts.push(`Run: ${details.runId}`);
    if (details.taskPath) parts.push(`Task: ${details.taskPath}`);
    meta.textContent = parts.join(" · ");
    specialistBody.append(meta);
  }
  if (details?.block?.changes?.text) {
    const changeDetails = document.createElement("details");
    changeDetails.className = "specialist-block-changes";
    const summary = document.createElement("summary");
    summary.textContent = details.block.changes.truncated
      ? "부분 변경 보기 (일부만 표시)"
      : "부분 변경 보기";
    const code = document.createElement("pre");
    code.textContent = details.block.changes.text;
    changeDetails.append(summary, code);
    specialistBody.append(changeDetails);
  }
  renderBlockedActions(specialistBody);
  specialistCancelBtn.textContent = "닫기";
}

specialistButton.addEventListener("click", () => {
  if (!activeSessionId || specialistRunning || specialistActive) return;
  if (specialistBlockedAvailable) {
    openSpecialistDialog();
    return;
  }
  professionalModeEnabled = !professionalModeEnabled;
  renderHeader();
});

professionalPlanButton.addEventListener("click", () => runProfessionalAction("plan"));
professionalImplementationButton.addEventListener("click", () => runProfessionalAction("implementation"));
professionalRecordButton.addEventListener("click", () => runProfessionalAction("record"));
professionalFullButton.addEventListener("click", () => runProfessionalAction("full"));
professionalPlanViewButton.addEventListener("click", () => openPlanPreview(professionalPlanViewButton));

// 승인된 기획안(TASK.md)을 읽어 팝오버로 보여줍니다. 구현 담당에게 넘기기 전에
// 사용자가 "이 기획안 기준으로 진행되는 게 맞는지" 확인하는 지점입니다.
async function openPlanPreview(anchor) {
  if (!activeSessionId || !specialistPlanTaskPath) return;
  const taskPath = specialistPlanTaskPath;
  const taskId = specialistPlanTaskId;
  const result = await call(window.chatApi.readTaskFile(activeSessionId, taskPath));
  if (!result) return;
  openPopover(anchor, (root) => {
    root.classList.add("plan-preview-popover");
    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("strong");
    title.textContent = taskId ? `기획안 ${taskId}` : "기획안";
    head.append(title);
    root.append(head);

    const note = document.createElement("p");
    note.className = "popover-status";
    note.textContent = "구현 담당은 이 기획안(Frozen Task)만 기준으로 작업합니다.";
    root.append(note);

    const body = document.createElement("div");
    body.className = "plan-preview-body";
    const content = String(result.content || "").trim();
    if (content) renderRichText(body, content);
    else body.textContent = "기획안 내용이 비어 있습니다.";
    root.append(body);

    const actions = document.createElement("div");
    actions.className = "popover-actions";
    const openInEditor = document.createElement("button");
    openInEditor.type = "button";
    openInEditor.textContent = "편집기로 열기";
    openInEditor.title = "OS 기본 편집기로 TASK.md를 엽니다";
    openInEditor.addEventListener("click", async () => {
      closePopover();
      await call(window.chatApi.openTaskFile(activeSessionId, taskPath));
    });
    actions.append(openInEditor);
    root.append(actions);
  });
}

// 이 모달은 BLOCKED 후속 처리 전용이라, 시작 버튼은 숨겨져 있고 닫기만 동작합니다.
specialistCancelBtn.addEventListener("click", closeSpecialistDialog);
specialistCloseBtn.addEventListener("click", closeSpecialistDialog);
specialistBackdrop.addEventListener("click", (event) => {
  if (event.target === specialistBackdrop) closeSpecialistDialog();
});

async function runProfessionalAction(action) {
  if (!activeSessionId || specialistRunning || specialistActive) return;
  specialistRunning = true;
  specialistActive = true;
  renderHeader();
  syncComposerLock();
  const planAutoRevisions = planAutoReviseToggle.checked
    ? boundedRevisionLimit(planAutoLimitSelect.value, 2)
    : 0;
  const implementationAutoRevisions = implementationAutoReviseToggle.checked
    ? boundedRevisionLimit(implementationAutoLimitSelect.value, 1)
    : 0;
  const result = await call(
    window.chatApi.specialistStart(activeSessionId, {
      action,
      planAutoRevisions,
      implementationAutoRevisions,
    })
  );
  if (result) {
    const labels = {
      plan: "PLAN을 시작했습니다.",
      implementation: "실행을 시작했습니다.",
      record: "기록을 다시 만들기 시작했습니다.",
      full: "전체 실행을 시작했습니다. 기획 검수 PASS 후 구현까지 이어집니다.",
    };
    flashNotice(labels[action], false);
  }
  if (result?.meta) sessionMeta = result.meta;
  if (result?.specialist) setSpecialistState(result.specialist);
  else if (!result) specialistActive = false;
  specialistRunning = false;
  syncComposerLock();
  renderHeader();
}

// 구현이 막혔을 때(BLOCKED) 고를 수 있는 후속 처리를 그립니다.
// 주 액션 2개는 바로 노출하고, 되돌리기 계열은 접이식 메뉴로 묶습니다.
function renderBlockedActions(root) {
  const replanKeepBtn = document.createElement("button");
  replanKeepBtn.type = "button";
  replanKeepBtn.className = "button button-primary";
  replanKeepBtn.textContent = "변경 유지 후 재기획";
  replanKeepBtn.title = "구현 변경을 유지한 채 막힌 사유를 기획자에게 전달해 재기획합니다";
  replanKeepBtn.addEventListener("click", () => {
    closeSpecialistDialog();
    replanBlocked("keep");
  });
  root.append(replanKeepBtn);

  const replanRestoreBtn = document.createElement("button");
  replanRestoreBtn.type = "button";
  replanRestoreBtn.className = "button";
  replanRestoreBtn.textContent = "작업 전 복원 후 재기획";
  replanRestoreBtn.title = "작업 전 상태로 복원한 뒤 막힌 사유를 기획자에게 전달해 재기획합니다";
  replanRestoreBtn.addEventListener("click", () => {
    closeSpecialistDialog();
    replanBlocked("restore");
  });
  root.append(replanRestoreBtn);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "button";
  editBtn.textContent = "작업 지시서 직접 수정";
  editBtn.title = "TASK.md를 직접 열어 빠진 조건을 보완합니다";
  editBtn.addEventListener("click", () => {
    closeSpecialistDialog();
    openTaskFileForEdit();
  });
  root.append(editBtn);

  const changesHint = document.createElement("p");
  changesHint.className = "popover-hint";
  changesHint.textContent = "구현자가 막히기 전까지 만든 변경은 아직 그대로 있습니다. 아래에서 처리 방법을 고르세요.";
  root.append(changesHint);

  const changeSelect = document.createElement("select");
  for (const option of [
    { value: "", label: "변경사항 처리…" },
    { value: "keep", label: "현재 변경만 유지 (종결)" },
    { value: "restore", label: "작업 전으로 복원 (종결)" },
    { value: "discard", label: "작업 폐기 (복원 + 지시서 폐기)" },
  ]) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    changeSelect.append(el);
  }
  changeSelect.addEventListener("change", () => {
    const action = changeSelect.value;
    if (!action) return;
    changeSelect.value = "";
    closeSpecialistDialog();
    resolveBlocked(action);
  });
  root.append(changeSelect);
}

async function replanBlocked(workspaceAction) {
  if (workspaceAction === "restore") {
    if (!window.confirm("작업 전 상태로 복원 후 재기획하시겠습니까? 구현자가 만든 변경은 사라집니다. (실행 전부터 있던 변경은 보존됩니다)")) {
      return;
    }
  }
  const result = await call(window.chatApi.specialistReplanBlocked(activeSessionId, workspaceAction));
  if (result) {
    flashNotice("막힌 사유를 전달하고 재기획을 시작했습니다.", false);
    if (result.meta) sessionMeta = result.meta;
    if (result.specialist) setSpecialistState(result.specialist);
    specialistBlockedAvailable = false;
    renderHeader();
  }
}

// 선택한 후속 처리를 백엔드에 전달합니다.
async function resolveBlocked(action) {
  if (action === "discard" || action === "restore") {
    const label = action === "discard" ? "작업을 폐기" : "작업 전 상태로 복원";
    if (!window.confirm(`${label}하시겠습니까? 구현자가 만든 변경은 사라집니다. (실행 전부터 있던 변경은 보존됩니다)`)) {
      return;
    }
  }
  const result = await call(window.chatApi.specialistResolveBlocked(activeSessionId, action));
  if (!result) return;
  flashNotice(
    action === "keep"
      ? "현재 변경을 유지했습니다."
      : action === "restore"
        ? "작업 전 상태로 되돌렸습니다."
        : "작업을 폐기했습니다.",
    false
  );
  if (result?.meta) sessionMeta = result.meta;
  specialistBlockedAvailable = false;
  renderHeader();
}

// 막힌 사유를 기획자에게 넘겨 지시서를 다시 쓰게 합니다.
// 별도 실행 경로를 만들지 않고, 기존 Handoff로 마지막 구현자 메시지를 전달합니다.
function handoffBlockedToPlanner() {
  const project = projects.find((entry) => entry.id === activeProjectId);
  const planner = roleConfigFromProject(project, "planning");
  if (!planner?.agentId) {
    flashNotice("프로젝트 설정에서 기획 담당자를 먼저 지정해 주세요.");
    return;
  }
  const lastAgentMessage = [...messages].reverse().find(
    (message) => message.authorType === "agent" && message.id
  );
  if (!lastAgentMessage) {
    flashNotice("전달할 구현자 메시지를 찾지 못했습니다.");
    return;
  }
  call(
    window.chatApi.handoffMessage(activeSessionId, planner.agentId, lastAgentMessage.id, "REVIEW")
  ).then((result) => {
    if (result) flashNotice("기획자에게 막힘 사유를 전달했습니다.", false);
    if (result?.meta) sessionMeta = result.meta;
  });
}

// 작업 지시서(TASK.md)를 OS 기본 편집기로 엽니다.
function openTaskFileForEdit() {
  const workspace = sessionMeta?.workspace;
  if (!workspace) {
    flashNotice("워크스페이스가 연결되어 있지 않습니다.");
    return;
  }
  const activeTask = (workflow?.tasks || []).find(
    (task) => task.contentSource === "file" && task.taskPath && task.status !== "rejected"
  );
  if (!activeTask) {
    flashNotice("수정할 작업 지시서를 찾지 못했습니다.");
    return;
  }
  call(window.chatApi.openTaskFile(activeSessionId, activeTask.taskPath)).then((result) => {
    if (result) flashNotice("작업 지시서를 열었습니다. 수정 후 전문 실행을 다시 시작하세요.", false);
  });
}
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

    const checkboxes = [];
    for (const agent of agents) {
      if (!agent.available || !agent.enabled) continue;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.agentId = agent.id;
      checkboxes.push(checkbox);
      root.append(makeField(`@${agent.id} (${agent.name})`, checkbox));
    }

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "button button-primary popover-submit";
    startBtn.textContent = "토론 시작";
    startBtn.addEventListener("click", async () => {
      const agentIds = checkboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.dataset.agentId);
      if (agentIds.length < 2) {
        flashNotice("토론에는 두 명 이상을 선택해야 합니다.");
        return;
      }
      closePopover();
      await call(window.chatApi.discussionStart(activeSessionId, agentIds));
    });
    root.append(startBtn);
  });
});

// --- 워크스페이스 / 권한 ---
workspaceButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.workspaceChoose(activeSessionId));
  if (result && !result.canceled && result.meta) {
    sessionMeta = result.meta;
    sessions = result.sessions || sessions;
    renderSessions();
    renderHeader();
  }
});

workspaceButton.addEventListener("contextmenu", async (event) => {
  event.preventDefault();
  if (!sessionMeta?.workspace) return;
  const result = await call(window.chatApi.workspaceClear(activeSessionId));
  if (result?.meta) {
    sessionMeta = result.meta;
    sessions = result.sessions || sessions;
    renderSessions();
    renderHeader();
  }
});

permissionSelect.addEventListener("change", async () => {
  const result = await call(window.chatApi.permissionSet(activeSessionId, permissionSelect.value));
  if (result?.meta) {
    sessionMeta = result.meta;
  }
  renderHeader();
});

permissionWarning.addEventListener("click", async () => {
  const result = await call(window.chatApi.permissionSet(activeSessionId, "workspace-write"));
  if (result?.meta) {
    sessionMeta = result.meta;
    flashNotice("이 채팅을 워크스페이스 쓰기 권한으로 바꿨습니다.", false);
  }
  renderHeader();
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
      // 임의 경로 열기는 막혀 있습니다(chat:task:open-file은 워크스페이스 안만 허용).
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

function formatBytes(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function makeAttachmentIcon(attachment) {
  const icon = document.createElement("span");
  icon.className = "attachment-icon";
  icon.textContent = attachment.kind === "text" ? "📄" : "📦";
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
    item.dataset.systemKey = `${message.error ? "!" : ""}${message.text}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
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
    // 1. 역할 배지 — 전문 모드로 실행된 응답에만 붙입니다.
    //    일반 대화·토론 응답에는 specialistStage가 없으므로 배지도 생기지 않습니다.
    //    (알 수 없는 값은 배지로 만들지 않아 엉뚱한 라벨이 뜨지 않게 합니다.)
    const stageKey = String(agentMeta.specialistStage || "").toLowerCase();
    const stageLabel = SPECIALIST_STAGE_LABELS[stageKey];
    if (stageLabel) {
      const roleBadge = document.createElement("span");
      roleBadge.className = `role-badge role-${stageKey}`;
      roleBadge.textContent = stageLabel;
      roleBadge.title = `전문 모드 ${stageLabel} 단계에서 나온 응답입니다`;
      meta.append(roleBadge);
    }

    // 2. 모델 배지
    const shownModel = agentMeta.model && agentMeta.model !== "default" ? agentMeta.model : agent?.model;
    if (shownModel) {
      const modelBadge = document.createElement("span");
      modelBadge.className = "meta-pill model-pill";
      modelBadge.textContent = shownModel;
      meta.append(modelBadge);
    }

    // 3. 노력/속도 배지
    const shownEffort = agentMeta.effort && agentMeta.effort !== "default" ? agentMeta.effort : agent?.effort;
    if (shownEffort) {
      const effortBadge = document.createElement("span");
      effortBadge.className = "meta-pill effort-pill";
      effortBadge.textContent = effortLabel(shownEffort);
      meta.append(effortBadge);
    }

    // 4. 불변 실행 계약 (Frozen Task) 인디케이터 칩
    const taskId = agentMeta.taskId || message.taskMeta?.taskId;
    const taskHash = agentMeta.taskHash || agentMeta.frozenHash || message.taskMeta?.hash;
    if (taskId || taskHash) {
      const taskChip = document.createElement("span");
      taskChip.className = "meta-chip frozen-task-chip";
      const hashShort = taskHash ? `@${String(taskHash).slice(0, 7)}` : "";
      taskChip.textContent = `📋 ${taskId || "TASK"}${hashShort}`;
      taskChip.title = `불변 스냅샷 실행 계약: ${taskId || "TASK"}${hashShort}`;
      meta.append(taskChip);
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
    const prompt = usage.promptTokens ? `입력: ${usage.promptTokens.toLocaleString()}` : "";
    const completion = usage.completionTokens ? `출력: ${usage.completionTokens.toLocaleString()}` : "";
    const total = usage.totalTokens ? `총계: ${usage.totalTokens.toLocaleString()}` : "";
    const details = [prompt, completion, total].filter(Boolean).join(" · ");
    usageEl.textContent = `⚡ 토큰 사용량 ${details}`;
    bubble.append(usageEl);
  }

  // 전달 배지: 일부 첨부가 이 에이전트로 전달되지 못한 경우 표시
  if (Array.isArray(message.deliveries)) {
    const failed = message.deliveries.filter((delivery) => delivery.method === "unsupported");
    if (failed.length > 0) {
      const badge = document.createElement("div");
      badge.className = "delivery-badge";
      badge.textContent = `⚠ 첨부 ${failed.length}개는 이 에이전트에 전달되지 않았습니다`;
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

    const handoffBtn = document.createElement("button");
    handoffBtn.type = "button";
    handoffBtn.className = "message-handoff-button";
    if (specialistRunning || specialistLocksComposer()) {
      handoffBtn.disabled = true;
      handoffBtn.classList.add("is-disabled");
      handoffBtn.title = "실행/토론 진행 중에는 다른 AI에게 전달할 수 없습니다 (완료 후 가능)";
    } else {
      handoffBtn.title = "이 메시지를 다른 AI에게 전달";
    }
    handoffBtn.textContent = "다른 AI에게 전달";
    handoffBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (specialistRunning || specialistLocksComposer()) return;
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
// (전문 실행을 여러 번 취소하면 똑같은 문장이 화면을 채웁니다)
function mergeIntoPreviousSystem(item) {
  if (!item.classList.contains("is-system")) return false;
  const last = messageList.lastElementChild;
  if (!last || !last.classList.contains("is-system")) return false;
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
  headline.textContent = `⚠ ${label}`;
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
    if (output.rawLogName) parts.push(`원본 로그 보관됨: ${output.rawLogName}`);
    diag.textContent = parts.join(" · ");
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
    const stageLabel = SPECIALIST_STAGE_LABELS[String(payload.specialistStage || "").toLowerCase()];
    if (stageLabel) liveMeta.push(stageLabel);
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
function mentionTargets() {
  return [
    ...agents.map((agent) => ({
      alias: agent.aliases[0],
      label: agent.name,
      color: agent.color,
      available: agent.available && agent.enabled,
    })),
    {
      alias: "모두",
      label: "모든 에이전트",
      color: "#52525b",
      available: agents.some((agent) => agent.available && agent.enabled),
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
    desc.textContent = option.available ? option.label : `${option.label} · 사용 불가`;
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
  const text = composerInput.value.trim();
  if (specialistNeedsInput) {
    if (!text) return;
    const draftText = composerInput.value;
    composerInput.value = "";
    closeMentionPopup();
    autoresize();
    const result = await call(window.chatApi.specialistPlanAnswer(activeSessionId, text));
    if (!result) {
      composerInput.value = draftText;
      autoresize();
    } else {
      if (result.meta) sessionMeta = result.meta;
      if (result.specialist) setSpecialistState(result.specialist);
    }
    syncComposerLock();
    renderHeader();
    composerInput.focus();
    return;
  }
  if (specialistLocksComposer()) {
    flashNotice("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
    return;
  }
  if (!text && pendingAttachments.length === 0) return;
  const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
  // 전송 실패 시 작성 중이던 내용을 복원하기 위해 보관해 둔다.
  const draftText = composerInput.value;
  const draftAttachments = pendingAttachments;
  composerInput.value = "";
  closeMentionPopup();
  autoresize();
  const independent = isIndependentResponseMode;
  const result = await call(window.chatApi.send(activeSessionId, text, attachmentIds, independent));
  if (result) {
    pendingAttachments = [];
    renderPendingAttachments();
  } else {
    // 실패 시 작성 중이던 내용을 그대로 복원한다.
    composerInput.value = draftText;
    pendingAttachments = draftAttachments;
    renderPendingAttachments();
    autoresize();
  }
  composerInput.focus();
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

sendButton.addEventListener("click", sendCurrentMessage);
stopButton.addEventListener("click", () => call(window.chatApi.stop(activeSessionId)));

newProjectButton.addEventListener("click", async () => {
  openNewProjectPopover(newProjectButton);
});

newSessionButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.sessionsCreate());
  if (result) applyFullState(result);
});

refreshProvidersButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.providersRefresh());
  if (result?.providers) {
    providers = result.providers;
    diagnostics = result.diagnostics || diagnostics;
    flashNotice("CLI 탐지를 새로 고쳤습니다.", false);
    renderHeader();
    if (!doctorBackdrop.hidden) renderDoctor();
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
  if (full.projects) projects = full.projects;
  if (full.workflow) workflow = full.workflow;
  if (Object.hasOwn(full, "activeProjectId")) activeProjectId = full.activeProjectId;
  if (full.sessions) sessions = full.sessions;
  if (Object.hasOwn(full, "activeSessionId")) activeSessionId = full.activeSessionId;

  if (full.session) {
    sessionMeta = full.session.meta;
    agents = full.session.agents || [];
    setSpecialistState(full.session.specialist || {});
    typingAgents.clear();
    for (const agentId of full.session.typing || []) typingAgents.add(agentId);
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

  renderProjects();
  renderSessions();
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
window.chatApi.onReset(({ sessionId }) => {
  if (sessionId !== activeSessionId) return;
  renderAllMessages([]);
  chatMessages = [];
  typingAgents.clear();
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
  if (Object.hasOwn(payload, "activeSessionId")) activeSessionId = payload.activeSessionId;
  renderProjects();
  renderSessions();
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
window.chatApi.onSpecialistResumeState(({ sessionId, ...state }) => {
  if (sessionId !== activeSessionId) return;
  setSpecialistState(state);
  syncComposerLock();
  renderHeader();
});
function lockComposer(locked) {
  composerInput.disabled = locked;
  sendButton.disabled = locked;
  attachButton.disabled = locked || specialistNeedsInput;
  if (specialistNeedsInput) {
    composerInput.placeholder = "기획자의 Open Question에 답하세요 (Enter 전송)";
    sendButton.textContent = "답변 보내기";
  } else {
    composerInput.placeholder = locked ? "전문 실행이 끝난 뒤 입력할 수 있습니다" : "질문이나 작업을 입력하세요  (@로 대상 지정 · Enter 전송)";
    sendButton.textContent = "전송";
  }
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

// 다른 창에서 사용량을 쓰고 돌아왔을 수 있으므로 포커스 복귀 때 한 번 확인합니다. (60초 스로틀)
window.addEventListener("focus", () => {
  void refreshUsageIfStale();
});

// --- 초기화 ---
(async () => {
  void loadUsage();
  const full = await call(window.chatApi.state());
  if (full) {
    applyFullState(full);
    if (localStorage.getItem(DOCTOR_SEEN_KEY) !== "true") openDoctor({ firstRun: true });
  }
  composerInput.focus();
})();
