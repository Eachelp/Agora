/* global chatMarkdown, usageView */
const chatScroll = document.getElementById("chat-scroll");
const messageList = document.getElementById("message-list");
const typingRow = document.getElementById("typing-row");
const awaitingRow = document.getElementById("awaiting-row");
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
const specialistChoiceBar = document.getElementById("specialist-choice-bar");
const specialistApprovalsBar = document.getElementById("specialist-approvals");

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
const permissionWarning = document.getElementById("permission-warning");
const enforcementHint = document.getElementById("enforcement-hint");
const discussionButton = document.getElementById("btn-discussion");
const workflowButton = document.getElementById("btn-workflow");
const specialistButton = document.getElementById("btn-specialist");
const roomControlsActions = document.querySelector(".room-controls-actions");
const usageButton = document.getElementById("btn-usage");
const usageFoldToggle = document.getElementById("btn-usage-fold");
const usageStripItems = document.getElementById("usage-strip-items");
const professionalActions = document.getElementById("professional-actions");
const professionalPlanButton = document.getElementById("btn-professional-plan");
const professionalImplementationButton = document.getElementById("btn-professional-implementation");
const professionalRecordButton = document.getElementById("btn-professional-record");
const professionalFullButton = document.getElementById("btn-professional-full");
const professionalPlanViewButton = document.getElementById("btn-professional-plan-view");
const planAutoReviseToggle = document.getElementById("plan-auto-revise");
const planAutoLimitSelect = document.getElementById("plan-auto-limit");
const implementationAutoReviseToggle = document.getElementById("implementation-auto-revise");
const implementationAutoLimitSelect = document.getElementById("implementation-auto-limit");
const planPolicyBadge = document.getElementById("badge-professional-plan");
const implementationPolicyBadge = document.getElementById("badge-professional-implementation");
const storeWarning = document.getElementById("store-warning");
const popover = document.getElementById("popover");
const popoverBackdrop = document.getElementById("popover-backdrop");
const appEl = document.querySelector(".app");
const railAgentButtons = new Map([
  ["claude", document.getElementById("rail-claude")],
  ["codex", document.getElementById("rail-codex")],
  ["agy", document.getElementById("rail-agy")],
]);
const railSettingsButton = document.getElementById("rail-settings");
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
// 승인된 기획서를 실제로 들고 있어 구현을 시작할 수 있는가(백엔드 기준).
let specialistImplementationReady = false;
let specialistNode = null;
let specialistStatus = null;
// 작업 전 백업으로 되돌릴 수 있는지. 백엔드(canRestore)가 유일한 근거이며,
// 복원 계열 조작을 열지 말지 판단하는 데 쓴다.
let specialistCanRestore = false;
// 백엔드가 세는 라운드. 화면의 자동 보완 "설정값"과 혼동하면 안 되므로
// 진행 횟수로는 이 값만 쓴다.
let specialistPlanRound = 0;
let specialistImplementationRound = 0;
let specialistFrozenRunId = null;
// 완료 전에 사용자가 직접 확인해야 하는 항목(HUMAN_APPROVAL). 검수자가 대신
// 해소할 수 없어, 이 목록과 승인/거부 경로가 없으면 실행이 영영 대기에 남는다.
let specialistPendingApprovals = [];
let specialistApprovalContext = null;
let specialistApprovalRequest = 0;
let specialistApprovalsLoading = false;
let specialistApprovalsError = "";
// 한 번에 한 항목만 처리해 응답 순서에 따라 남은 목록이 되돌아가지 않게 한다.
let specialistApprovalsBusy = false;
// 막힘 처리 선택지를 상태 줄 아래에 펼치기 위한 상세(캔 복원 여부 등).
let specialistBlockInfo = null;
let specialistBlockFetch = "idle";
let professionalModeEnabled = false;
// 직전 상태에서 전문 실행이 살아 있었는지. "살아나는 순간"에만 전문 모드를 켜기
// 위한 것이며, 매 이벤트마다 켜서 사용자의 토글을 덮어쓰지 않기 위해 둔다.
let professionalRunWasLive = false;
// 기획안 미리보기 폭. 사용자가 조절한 값을 기억한다(popover는 열 때마다 재생성된다).
const PLAN_PREVIEW_WIDTH_KEY = "agora.chat.planPreviewWidth";
let planPreviewResizeObserver = null;

// 승인된 기획안(TASK.md) 경로/제목. "기획안 보기" 버튼으로 열람합니다.
let specialistPlanTaskPath = null;
let specialistPlanTaskId = null;
let specialistStopReason = null;
let specialistCheckpointProtection = null;
let specialistMissingSections = null;

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
  // V1.5 완료 후 사람용 정리(Archivist) 턴 — 라벨이 없으면 역할 배지·'응답 중' 단계가 붙지 않는다.
  archivist: "기록 정리",
});

function boundedRevisionLimit(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : fallback;
}

// 저장된 자동 보완 정책을 읽는다. 0(=끄기)이 유효한 값이라 boundedRevisionLimit
// (횟수 select 전용, 1~3으로 clamp)을 쓰면 "꺼짐"이 1회로 되살아난다.
function boundedAutoRevisions(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(3, Math.max(0, parsed)) : 0;
}

function boundedDiscussionTurns(value, fallback = 15) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(50, Math.max(3, parsed)) : fallback;
}

// 자동 보완 정책은 **프로젝트**가 갖는다(project.autoRevisions). 화면의 토글은
// 그 값에서 시작해 이번 실행만 임시로 바꾸는 자리다. 예전에는 localStorage에
// 저장돼 앱 전역이라, 한 프로젝트에서 3회로 바꾸면 다른 프로젝트도 3회가 됐다.
//
// 어느 프로젝트의 값을 올려 둔 상태인지 기억해, 프로젝트가 바뀔 때만 다시 채운다.
// 매 상태 갱신마다 덮으면 사용자가 방금 바꾼 임시 값이 사라진다.
let autoRevisionsProjectId = null;

function applyProjectAutoRevisions(force = false) {
  const project = activeProjectEntry();
  const projectId = project?.id || null;
  if (!force && projectId === autoRevisionsProjectId) return;
  autoRevisionsProjectId = projectId;
  const policy = project?.autoRevisions || {};
  const plan = boundedAutoRevisions(policy.plan);
  const implementation = boundedAutoRevisions(policy.implementation);
  planAutoReviseToggle.checked = plan > 0;
  if (plan > 0) planAutoLimitSelect.value = String(plan);
  implementationAutoReviseToggle.checked = implementation > 0;
  if (implementation > 0) implementationAutoLimitSelect.value = String(implementation);
  syncAutoRevisionControls();
}

function syncAutoRevisionControls() {
  planAutoLimitSelect.disabled = !planAutoReviseToggle.checked;
  implementationAutoLimitSelect.disabled = !implementationAutoReviseToggle.checked;
  renderProfessionalPolicyBadges();
}

// 자동 보완 설정이 실행 버튼의 의미를 바꾼다: 꺼져 있으면 검수가 수정을 요구할 때
// 멈추고 사용자에게 승인을 묻고, 켜져 있으면 정해진 횟수만큼 자동으로 다시 돈다
// (chat-specialist.js의 canAutoRevise / maxRounds). 그 사실이 버튼에 보이지 않아
// "왜 어떤 때는 멈추고 어떤 때는 쭉 가는지" 알 수 없었다. 버튼이 직접 말하게 한다.
function renderProfessionalPolicyBadges() {
  const policy = currentProfessionalPolicy();
  if (planPolicyBadge) planPolicyBadge.textContent = policyBadgeText(policy.planAutoRevisions);
  if (implementationPolicyBadge) {
    implementationPolicyBadge.textContent = policyBadgeText(policy.implementationAutoRevisions);
  }
}

function policyBadgeText(revisions) {
  return revisions > 0 ? `자동 보완 ${revisions}회` : "검수 후 확인";
}

// 눌릴 수 있는 버튼의 툴팁: 무엇을 하는지 + 이 설정에서 검수가 수정을 요구하면
// 어떻게 되는지. 비활성 버튼의 툴팁은 "왜 못 누르는지"가 우선이라 여기 오지 않는다.
function policyTooltip(description, revisions, stageLabel) {
  const consequence = revisions > 0
    ? `${stageLabel} 검수가 수정을 요구하면 최대 ${revisions}회까지 자동으로 다시 돌립니다.`
    : `${stageLabel} 검수가 수정을 요구하면 멈추고 물어봅니다(자동 보완 꺼짐).`;
  return `${description} ${consequence}`;
}

// 여기서 바꾼 값은 이번 실행에만 적용된다. 계속 쓸 값은 프로젝트 설정(⋯)에 둔다.
for (const control of [planAutoReviseToggle, implementationAutoReviseToggle]) {
  control.addEventListener("change", syncAutoRevisionControls);
}

for (const control of [planAutoLimitSelect, implementationAutoLimitSelect]) {
  control.addEventListener("change", () => {
    control.value = String(boundedRevisionLimit(control.value));
    renderProfessionalPolicyBadges();
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
  specialistResumePhase = specialistResumeAvailable ? state.resumePhase || null : null;
  specialistNeedsInput = Boolean(state.needsInput);
  specialistPlanReady = Boolean(state.planReady);
  // 기획 검수는 통과했지만 승인된 기획서를 실제로 들고 있는지는 별개다.
  // (앱을 다시 켰을 때 TASK.md를 읽지 못하면 통과 표시만 남는다.)
  specialistImplementationReady = Boolean(state.implementationReady);
  specialistNode = state.node || null;
  specialistStatus = state.status || null;
  specialistPlanTaskPath = state.planTaskPath || null;
  specialistPlanTaskId = state.planTaskId || null;
  specialistStopReason = state.stopReason || null;
  specialistCheckpointProtection = state.checkpointProtection || null;
  specialistCanRestore = Boolean(state.canRestore);
  specialistPlanRound = Number.isFinite(state.planRound) ? state.planRound : 0;
  specialistImplementationRound = Number.isFinite(state.implementationRound) ? state.implementationRound : 0;
  specialistFrozenRunId = state.frozenRunId || null;
  specialistMissingSections = Array.isArray(state.missingSections) && state.missingSections.length > 0
    ? [...state.missingSections]
    : null;
  const approvalFlow = awaitingHumanApproval() || canResumeAfterApproval();
  if (!approvalFlow || specialistApprovalContext?.sessionId !== activeSessionId
    || specialistApprovalContext?.runId !== specialistFrozenRunId) {
    resetSpecialistApprovals();
    if (approvalFlow && activeSessionId) {
      specialistApprovalContext = { sessionId: activeSessionId, runId: specialistFrozenRunId };
    }
  }
  if (awaitingHumanApproval()) {
    if (!specialistApprovalsBusy) void refreshPendingApprovals();
  } else {
    specialistApprovalRequest += 1;
    specialistPendingApprovals = [];
    specialistApprovalsLoading = false;
    specialistApprovalsError = "";
  }
  renderSpecialistApprovals();
  // 막힘도 같다 — 들어오면 상세를 받아 오고, 벗어나면 즉시 비운다. 이미 처리한
  // 막힘의 선택지가 남아 있으면 "골랐는데 그대로"로 보인다.
  if (specialistBlockedAvailable) refreshBlockInfo();
  else if (specialistBlockInfo || specialistBlockFetch !== "idle") {
    specialistBlockInfo = null;
    specialistBlockFetch = "idle";
    renderProfessionalBlocked();
  }
  // 전문 실행이 **새로 살아날 때** 그 조작 버튼을 한 번 드러낸다.
  //
  // professionalModeEnabled는 화면 로컬 값이라 사용자가 토글을 눌러야만 바뀌었다.
  // 그래서 앱을 다시 열어 실행이 복원되면 실행은 돌아가는데 화면은 일반 모드에
  // 머물러 PLAN·실행 버튼이 보이지 않았다.
  //
  // 다만 매 상태 이벤트마다 켜면 사용자가 내린 토글을 계속 덮어써, 실행 중에
  // 일반 대화로 빠져나가 말할 수가 없다. 기획자는 대화를 읽는 유일한 역할이므로
  // 그 길이 막히면 진행 방향을 다시 일러 줄 수단이 사라진다.
  // 그래서 "죽어 있다 → 살아났다"로 바뀌는 순간에만 켜고, 그 뒤 사용자가 끈 것은
  // 존중한다. 끄는 일은 어느 경우에도 코드가 하지 않는다.
  const runLive = Boolean(specialistNode)
    && !(specialistNode === "COMPLETED" && specialistStatus === "COMPLETED");
  if (runLive && !professionalRunWasLive) professionalModeEnabled = true;
  professionalRunWasLive = runLive;
}

// 전문 실행이 실제로 돌거나 사용자 입력을 기다리는 중인가 — 백엔드의
// isSpecialistLocked(active || resume || blocked)와 같은 기준이다.
// "노드가 남아 있다"(runLive)는 여기 쓰지 않는다: 중단된 실행도 노드는 남으므로
// 그 기준이면 전문 실행을 한 번 돌린 대화는 영영 메모 전용이 되어, 일반 모드에서
// @claude를 불러도 답이 오지 않았다.
function professionalRunBusy() {
  return Boolean(specialistActive || specialistResumeAvailable || specialistBlockedAvailable);
}

function specialistLocksComposer() {
  // READY 상태에서는 기획 수정을 허용하기 위해 composer를 잠그지 않는다.
  if (specialistNode === "READY" && !specialistActive) return false;
  // 일반 모드를 고른 사용자는 실행 중에도 메모를 남길 수 있어야 한다.
  // recordOnly는 턴을 예약하지 않아 진행 중인 실행에 끼어들지 않는다.
  if (!professionalModeEnabled) return false;
  return Boolean(specialistActive || specialistBlockedAvailable || (specialistResumeAvailable && !specialistNeedsInput));
}

function syncComposerLock() {
  lockComposer(Boolean(activeApproval || specialistLocksComposer()));
  renderSpecialistChoice();
  renderSpecialistApprovals();
  // 전문/일반 모드를 오가면 막힘 선택지가 위(상태 줄 아래)와 아래(입력창 옆)
  // 사이를 옮겨 간다. 둘을 같은 시점에 다시 그려야 한쪽이 사라진 채로 남지 않는다.
  renderProfessionalBlocked();
}

// 사용자가 골라야만 진행되는 지점의 선택지를 실제 버튼으로 만든다.
// 백엔드(resumeSpecialist/cancelSpecialist)는 예전부터 이 선택들을 처리했지만
// 화면에 버튼이 없어서, composer가 "선택 대기"로 잠긴 채 고를 방법이 없었다.
const SPECIALIST_CHOICES = {
  CHECKPOINT_FAILED: [
    { label: "재시도", title: "백업을 다시 만든 뒤 Builder를 시작합니다", run: () => window.chatApi.specialistResume(activeSessionId, "retry") },
    { label: "무보호 진행", title: "백업 없이 실행합니다. 사전 스냅샷이 없어 회귀 검증 신뢰도가 제한됩니다", confirm: "작업 전 상태 백업 없이 실행할까요? 문제가 생겨도 실행 전으로 되돌릴 수 없습니다.", run: () => window.chatApi.specialistResume(activeSessionId, "proceed_unprotected") },
    { label: "취소", title: "전문 실행을 중단합니다", run: () => window.chatApi.specialistCancel(activeSessionId) },
  ],
};

// composer를 잠그면서 "선택해 주세요"라고 안내하는 상태는 모두 여기에 선택지가
// 있어야 한다. BLOCKED는 선택지가 헤더의 모드 토글 버튼 뒤 모달에만 있어서,
// "아래에서 선택해 주세요"라는 안내와 실제 위치가 정반대였다. 선택지 자체는
// 모달이 이미 잘 설명하고 있으므로 여는 길만 안내한 자리에 만든다.
function specialistChoicesNow() {
  // 막힘 처리는 상태 줄 아래(#professional-blocked)에 펼쳐 둔다. 입력창 옆에
  // "다음 처리 선택" 칩을 또 두면 같은 일을 하는 자리가 둘이 되고, 실행이 멈춘
  // 그 순간 사용자가 봐야 할 곳이 갈린다. 일반 모드로 내려온 동안에는 위 영역이
  // 숨으므로 여기서 대신 보여 준다(고를 방법이 사라지면 안 된다).
  if (specialistBlockedAvailable) {
    if (professionalModeEnabled) return null;
    return [{
      label: "다음 처리 선택",
      title: "구현이 막혔습니다. 변경 유지·복원·재기획·지시서 수정 중에서 고릅니다",
      run: () => { openSpecialistDialog(); return Promise.resolve(null); },
    }];
  }
  return specialistNeedsInput ? SPECIALIST_CHOICES[specialistStopReason] : null;
}

function renderSpecialistChoice() {
  const choices = specialistChoicesNow();
  specialistChoiceBar.replaceChildren();
  specialistChoiceBar.hidden = !choices;
  if (!choices) return;
  const label = document.createElement("span");
  label.className = "response-mode-label";
  label.textContent = "다음 처리:";
  specialistChoiceBar.append(label);
  for (const choice of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-chip";
    button.textContent = choice.label;
    button.title = choice.title;
    button.addEventListener("click", async () => {
      if (choice.confirm && !window.confirm(choice.confirm)) return;
      specialistChoiceBar.hidden = true;
      const result = await call(choice.run());
      if (!result) {
        renderSpecialistChoice();
        return;
      }
      if (result.specialist) setSpecialistState(result.specialist);
      syncComposerLock();
      renderHeader();
    });
    specialistChoiceBar.append(button);
  }
}

// 승인 후에도 FSM의 stopReason은 기록 시작까지 남는다. 실제 재개 단계가
// review_pass이면 더 이상 승인 목록을 기다리지 않는다.
function awaitingHumanApproval() {
  if (specialistActive || specialistBlockedAvailable
    || ["INTERRUPTED", "BLOCKED", "INVALID", "COMPLETED"].includes(specialistStatus)
    || specialistResumePhase === "review_pass") return false;
  return specialistResumePhase === "awaiting_human_approval"
    || (specialistNode === "REVIEWING" && specialistStatus === "WAITING"
      && specialistStopReason === "HUMAN_APPROVAL_REQUIRED");
}

// 막힘 처리를 고른 뒤에는 상세가 낡는다. 다음 상태가 오면 다시 받아 온다.
function invalidateBlockInfo() {
  specialistBlockInfo = null;
  specialistBlockFetch = "idle";
}

function canResumeAfterApproval() {
  return specialistResumeAvailable && specialistResumePhase === "review_pass"
    && !specialistActive && !specialistBlockedAvailable && specialistStatus !== "INTERRUPTED";
}

function resetSpecialistApprovals() {
  specialistApprovalContext = null;
  specialistApprovalRequest += 1;
  specialistPendingApprovals = [];
  specialistApprovalsLoading = false;
  specialistApprovalsError = "";
  specialistApprovalsBusy = false;
}

function isCurrentApprovalContext(context) {
  return Boolean(context && context === specialistApprovalContext
    && context.sessionId === activeSessionId && context.runId === specialistFrozenRunId);
}

// 세션뿐 아니라 실행과 요청 순서도 대조한다. 이전 대화의 목록이나 늦게 온
// 조회 응답으로 다른 실행의 동일한 criterionId를 승인하면 안 된다.
async function refreshPendingApprovals() {
  const context = specialistApprovalContext;
  if (!isCurrentApprovalContext(context) || !awaitingHumanApproval() || specialistApprovalsBusy) return;
  const request = ++specialistApprovalRequest;
  specialistApprovalsLoading = true;
  specialistApprovalsError = "";
  renderSpecialistApprovals();
  try {
    const result = await window.chatApi.specialistPendingApprovals(context.sessionId);
    if (!isCurrentApprovalContext(context) || request !== specialistApprovalRequest) return;
    if (!result || result.ok === false || result.runId !== context.runId || !Array.isArray(result.pending)) {
      throw new Error(result?.error || "승인 목록을 확인하지 못했습니다. 다시 불러와 주세요.");
    }
    specialistPendingApprovals = result.pending;
  } catch (error) {
    if (!isCurrentApprovalContext(context) || request !== specialistApprovalRequest) return;
    specialistPendingApprovals = [];
    specialistApprovalsError = error?.message || "승인 목록을 불러오지 못했습니다.";
  }
  specialistApprovalsLoading = false;
  renderSpecialistApprovals();
  renderHeader();
}

// 승인/거부를 백엔드에 전달한다. 성공하면 백엔드가 돌려준 최신 상태와 남은
// 항목을 그대로 반영한다(프론트가 완료로 앞질러 표시하지 않는다).
async function resolveApproval(criterionId, approved, context = specialistApprovalContext) {
  if (!isCurrentApprovalContext(context) || !context.runId || !awaitingHumanApproval()
    || specialistApprovalsBusy || specialistApprovalsLoading) return;
  const item = specialistPendingApprovals.find((entry) => entry.criterionId === criterionId);
  if (!item) return;
  if (!approved) {
    const label = item?.statement ? `\n\n${item.statement}` : "";
    if (!window.confirm(`이 항목을 거부할까요? 거부하면 이 실행은 완료로 처리되지 않습니다.${label}`)) return;
  }
  specialistApprovalRequest += 1;
  specialistApprovalsBusy = true;
  renderSpecialistApprovals();
  const result = await call(window.chatApi.specialistResolveApproval(context.sessionId, criterionId, approved, null, context.runId));
  if (!isCurrentApprovalContext(context)) return;
  if (!result) {
    specialistApprovalsBusy = false;
    await refreshPendingApprovals();
    return;
  }
  if (result.specialist) setSpecialistState(result.specialist);
  if (isCurrentApprovalContext(context)) {
    specialistPendingApprovals = awaitingHumanApproval() && Array.isArray(result.pending) ? result.pending : [];
    specialistApprovalsBusy = false;
  }
  syncComposerLock();
  renderHeader();
  if (!isCurrentApprovalContext(context)) return;
  // 남은 승인이 없고 백엔드가 이어서 진행할 수 있다고 알려 준 경우에만 재개한다.
  // 승인되지 않았는데 화면만 완료로 넘어가지 않도록, 판단은 백엔드 값에 맡긴다.
  if (result.resumable && specialistPendingApprovals.length === 0) {
    await resumeAfterApproval(context);
  } else if (specialistPendingApprovals.length > 0) {
    flashNotice(`남은 확인 항목이 ${specialistPendingApprovals.length}건 있습니다.`, false);
  }
}

async function resumeAfterApproval(context = specialistApprovalContext) {
  if (!isCurrentApprovalContext(context) || !canResumeAfterApproval() || specialistApprovalsBusy) return;
  specialistApprovalsBusy = true;
  renderSpecialistApprovals();
  const result = await call(window.chatApi.specialistResume(context.sessionId, undefined, context.runId));
  if (!isCurrentApprovalContext(context)) return;
  specialistApprovalsBusy = false;
  if (result?.meta) sessionMeta = result.meta;
  if (result?.specialist) setSpecialistState(result.specialist);
  syncComposerLock();
  renderHeader();
}

// 승인 대기 항목 목록. 항목 본문과 사람이 필요한 이유를 함께 보여 준다.
function renderSpecialistApprovals() {
  if (!specialistApprovalsBar) return;
  specialistApprovalsBar.replaceChildren();
  const context = specialistApprovalContext;
  const show = isCurrentApprovalContext(context) && (awaitingHumanApproval() || canResumeAfterApproval());
  specialistApprovalsBar.hidden = !show;
  if (!show) return;

  const head = document.createElement("div");
  head.className = "specialist-approvals-head";
  head.textContent = canResumeAfterApproval() ? "확인이 끝났습니다. 기록을 이어서 진행할 수 있습니다."
    : specialistApprovalsLoading ? "확인할 항목을 불러오는 중입니다…"
      : specialistApprovalsError || (specialistPendingApprovals.length > 0
        ? `완료 전에 확인할 항목 ${specialistPendingApprovals.length}건`
        : "표시할 승인 항목이 없습니다. 목록을 다시 확인하거나 PLAN으로 재기획해 주세요.");
  specialistApprovalsBar.append(head);

  if (canResumeAfterApproval() || (!specialistApprovalsLoading && specialistPendingApprovals.length === 0)) {
    const resume = canResumeAfterApproval();
    const actions = document.createElement("div");
    actions.className = "specialist-approval-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = specialistApprovalsBusy ? "처리 중…" : resume ? "기록 이어서 진행" : "목록 다시 불러오기";
    button.disabled = specialistApprovalsBusy;
    button.addEventListener("click", () => {
      if (!isCurrentApprovalContext(context)) return;
      return resume ? resumeAfterApproval(context) : refreshPendingApprovals();
    });
    actions.append(button);
    if (!resume) {
      // 승인으로 풀 수 없게 된 실행(항목이 비었거나 목록을 못 받는 경우)에서
      // 빠져나갈 길. 이것이 없으면 입력창은 "확인 대기"로 잠긴 채 막다른 상태가
      // 된다. 새 기획은 PLAN 버튼이 맡는다.
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button";
      cancel.textContent = "실행 취소";
      cancel.title = "이 전문 실행을 중단합니다. 파일 변경은 그대로 남습니다";
      cancel.disabled = specialistApprovalsBusy;
      cancel.addEventListener("click", async () => {
        if (!isCurrentApprovalContext(context)) return;
        if (!window.confirm("이 전문 실행을 취소할까요? 구현자가 만든 파일 변경은 그대로 남습니다.")) return;
        const sessionId = context.sessionId;
        const result = await call(window.chatApi.specialistCancel(sessionId));
        if (sessionId !== activeSessionId) return;
        if (result?.specialist) setSpecialistState(result.specialist);
        syncComposerLock();
        renderHeader();
      });
      actions.append(cancel);
    }
    specialistApprovalsBar.append(actions);
    return;
  }
  if (specialistPendingApprovals.length === 0) return;

  const hint = document.createElement("p");
  hint.className = "popover-hint";
  hint.textContent = "각 항목을 직접 확인한 뒤 승인해 주세요.";
  specialistApprovalsBar.append(hint);

  for (const item of specialistPendingApprovals) {
    const row = document.createElement("div");
    row.className = "specialist-approval-item";
    const text = document.createElement("div");
    text.className = "specialist-approval-text";
    text.textContent = item.statement || item.criterionId;
    row.append(text);
    const reasons = (item.reasons || []).filter(Boolean);
    if (reasons.length > 0) {
      const why = document.createElement("p");
      why.className = "popover-hint";
      why.textContent = `사용자 확인이 필요한 이유: ${reasons.join(", ")}`;
      row.append(why);
    }
    const actions = document.createElement("div");
    actions.className = "specialist-approval-actions";
    const busy = specialistApprovalsBusy || specialistApprovalsLoading;
    for (const choice of [
      { label: busy ? "처리 중…" : "승인", approved: true, primary: true },
      { label: "거부", approved: false, primary: false },
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = choice.primary ? "button button-primary" : "button";
      button.textContent = choice.label;
      button.disabled = busy;
      button.addEventListener("click", () => resolveApproval(item.criterionId, choice.approved, context));
      actions.append(button);
    }
    row.append(actions);
    specialistApprovalsBar.append(row);
  }
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
      // 펼친 프로젝트마다 늘 보이는 '새 채팅' 줄. 행 우측의 흐린 +만으로는
      // 자주 쓰는 동작이 눈에 띄지 않았다(상단의 선명한 버튼은 프로젝트를 만든다).
      const newChat = document.createElement("li");
      newChat.className = "project-new-chat";
      const newChatButton = document.createElement("button");
      newChatButton.type = "button";
      newChatButton.className = "project-new-chat-button";
      newChatButton.textContent = "＋ 새 채팅";
      newChatButton.title = `${project.name}에 새 채팅 (Ctrl/⌘+N)`;
      newChatButton.addEventListener("click", () => { void createChatIn(project.id); });
      newChat.append(newChatButton);
      list.append(newChat);
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
        const fold = foldSavedModel(options, selectedModel, selectedEffort);
        selectedModel = fold.model;
        selectedEffort = fold.effort;
        if (selectedModel && !options.some((option) => option.id === selectedModel)) {
          options.push({ id: selectedModel, label: strayModelLabel(selectedModel), efforts: [] });
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

    // 전문 실행 자동 보완 정책 — 이 프로젝트에서 계속 쓸 값.
    // 검수가 수정을 요구할 때 몇 번까지 자동으로 다시 돌릴지 정한다(0이면 멈추고 물어봄).
    const autoSection = document.createElement("section");
    autoSection.className = "project-default-section";
    const autoTitle = document.createElement("strong");
    autoTitle.textContent = "전문 실행 자동 보완";
    const autoHint = document.createElement("p");
    autoHint.className = "popover-hint";
    autoHint.textContent = "검수가 수정을 요구하면 몇 번까지 자동으로 다시 돌릴지 정합니다. 끄면 멈추고 물어봅니다. 실행 줄의 토글로 이번 실행만 다르게 할 수 있습니다.";
    autoSection.append(autoTitle, autoHint);
    const autoControls = new Map();
    for (const [key, label] of [["plan", "기획"], ["implementation", "구현"]]) {
      const saved = boundedAutoRevisions(project.autoRevisions?.[key]);
      const row = document.createElement("div");
      row.className = "project-auto-revision-row";
      const on = document.createElement("input");
      on.type = "checkbox";
      on.checked = saved > 0;
      const count = document.createElement("select");
      for (const value of [1, 2, 3]) {
        const item = document.createElement("option");
        item.value = String(value);
        item.textContent = `${value}회`;
        count.append(item);
      }
      count.value = String(saved > 0 ? saved : (key === "plan" ? 2 : 1));
      count.disabled = !on.checked;
      on.addEventListener("change", () => { count.disabled = !on.checked; });
      row.append(makeField(label, on), makeField("횟수", count));
      autoSection.append(row);
      autoControls.set(key, { on, count });
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
      const autoRevisions = {};
      for (const [key, controls] of autoControls) {
        autoRevisions[key] = controls.on.checked ? boundedRevisionLimit(controls.count.value) : 0;
      }
      const result = await call(window.chatApi.projectsUpdate(project.id, {
        name: name.value,
        context: context.value,
        defaultPermissionMode: permission.value,
        defaultAgents,
        defaultRoles,
        autoRevisions,
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
      autoSection,
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
  const planReview = roleConfigFromProject(project, "plan_review");
  const implementation = roleConfigFromProject(project, "implementation");
  const review = roleConfigFromProject(project, "review");
  const recorder = roleConfigFromProject(project, "recorder");
  const effectivePlanReview = planReview.agentId ? planReview : review;
  // 단계별 IPC 요구 조건과 버튼 활성 조건을 맞춥니다.
  // PLAN은 기획자와 기획 검수(비어 있으면 검토 담당자 재사용)만 필요하고,
  // 구현은 구현자·검토자, 전체 실행만 세 역할을 모두 필요로 합니다.
  const planConfigured = Boolean(planner.agentId && effectivePlanReview.agentId);
  const implementationConfigured = Boolean(implementation.agentId && review.agentId);
  const fullConfigured = Boolean(
    planner.agentId && effectivePlanReview.agentId && implementation.agentId && review.agentId
      && recorder.agentId
  );
  // 모드 토글은 표시와 입력 라우팅만 바꾸고 실행 상태는 건드리지 않는다. 실행 중에
  // 잠그면 "실행 중 일반 모드로 메모를 남긴다"는 경로에 도달할 수가 없다.
  specialistButton.disabled = !activeSessionId;
  specialistButton.setAttribute("aria-checked", String(professionalModeEnabled));
  specialistButton.title = professionalModeEnabled
    ? "일반 대화 화면으로 돌아갑니다. 실행은 그대로 진행됩니다"
    : planConfigured
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
  const ordinaryTurnBusy = Boolean(
    roomTurnState.current ||
      // 독립 발언은 여러 턴이 동시에 돈다(current는 그중 첫 번째일 뿐).
      (roomTurnState.running || []).length > 0 ||
      (roomTurnState.queue || []).length > 0 ||
      (roomTurnState.deferred || []).length > 0
  );
  // "실행 중이라 바쁘다"와 "사용자를 기다린다"는 서로 다른 상태다. 예전에는 둘을
  // 한 값으로 묶어서, BLOCKED나 검수 답변 대기처럼 **사용자가 다시 시작하고 싶은
  // 바로 그 상태**에서 PLAN 버튼까지 꺼졌다. 그러면 걸려 있는 질문에 답하는 것
  // 말고 길이 없어, 계약이 잘못 잡혔을 때 그 계약 안에서만 맴돌게 된다.
  const specialistBusy = Boolean(specialistRunning || specialistActive || ordinaryTurnBusy);
  const awaitingUser = Boolean(specialistBlockedAvailable || specialistResumeAvailable);
  const blockedOrBusy = specialistBusy || awaitingUser;
  // READY는 기획이 승인만 된 상태다. Builder가 돌지 않았으니 되돌릴 변경도
  // checkpoint도 없고, FSM은 이미 READY -> PLANNING 복귀를 지원한다(USER_ANSWER_PLAN).
  // 여기서 PLAN을 막으면 승인 이후 단계에서 거부됐을 때(승인 입력 재대조 실패,
  // 검증 계획 거부 등) 같은 실행 버튼을 반복해서 누르는 것 말고 길이 없어진다.
  // 사용자를 기다리는 상태(BLOCKED·답변 대기·중단)는 전부 "처음부터 다시"가
  // 열려 있어야 한다. 백엔드도 plan/full은 busy 기준만 본다.
  const planStartable = !specialistNode
    || specialistNode === "COMPLETED"
    || specialistNode === "READY"
    || specialistStatus === "INTERRUPTED"
    || awaitingUser
    || specialistNeedsInput;
  // 사용자가 답해야 진행되는 대기(기획 질문·계약 보완·checkpoint 선택·완료 전 확인).
  // 이 상태에서는 구현을 시작하지 않고, 그 대기를 먼저 풀어야 한다.
  const awaitingAnswer = Boolean(specialistNeedsInput || awaitingHumanApproval());
  // 승인된 기획으로 구현을 시작할 수 있는 조건. 백엔드(startSpecialist의
  // implementation 분기)는 "기획 검수 통과 + 막힘 아님 + 실행 중 아님"만 본다.
  //
  // 예전에는 여기서 blockedOrBusy(=awaitingUser 포함)를 썼는데, READY에는 승인
  // 대기 resume이 늘 있으므로 awaitingUser가 항상 참이었다. 그래서 **기획 검수를
  // 통과한 바로 그 상태에서 '실행 ▶'이 영영 꺼져 있었다** — 툴팁은 실행할 수
  // 있다고 말하면서. 백엔드가 허용하는 조건과 같게 맞춘다.
  const canStartImplementation = canStartImplementationNow({
    implementationConfigured,
    busy: specialistBusy,
  });
  professionalPlanButton.disabled = !planConfigured || specialistBusy || !planStartable;
  professionalImplementationButton.disabled = !canStartImplementation;
  // 눌릴 수 있는 버튼의 툴팁은 "이 설정으로 무엇이 일어나는가"를 말한다.
  // 눌리지 않는 이유는 아래에서 그 자리를 덮어쓴다.
  renderProfessionalPolicyBadges();
  const canRegenerateRecord = specialistNode === "COMPLETED" || (specialistNode === "RECORDING" && specialistStatus === "WAITING");
  professionalRecordButton.hidden = !canRegenerateRecord;
  // 기록 다시 생성은 기록이 실패해 멈춘 상태(RECORDING/WAITING)에서 쓰라고 있는
  // 버튼이다. 그 상태에도 resume이 남아 있어 awaitingUser로 막으면 보이기만 하고
  // 누를 수 없다. 실행 중과 막힘만 막는다.
  professionalRecordButton.disabled = !recorder.agentId || specialistBusy || specialistBlockedAvailable;
  professionalFullButton.disabled = !fullConfigured || specialistBusy || !planStartable;
  // 버튼이 비활성인 이유를 툴팁으로 알려, 눌리지 않는 것처럼 보이지 않게 합니다.
  const roleSetupHint = "프로젝트 설정(⋯)에서 담당자를 지정하면 사용할 수 있습니다";
  professionalPlanButton.title = ordinaryTurnBusy
    ? "일반 응답이 끝난 뒤 전문 기획을 시작할 수 있습니다"
    : planConfigured
      ? policyTooltip("기획을 만들고 다른 담당자가 기획을 검수합니다.", currentProfessionalPolicy().planAutoRevisions, "기획")
      : `기획·검토 담당자가 필요합니다. ${roleSetupHint}`;
  professionalFullButton.title = ordinaryTurnBusy
    ? "일반 응답이 끝난 뒤 전체 전문 실행을 시작할 수 있습니다"
    : fullConfigured
      ? "기획 검수 PASS 후 별도 승인 없이 구현·검수·기록까지 이어서 실행합니다"
      : `기획·구현·검토·기록 담당자가 모두 필요합니다. ${roleSetupHint}`;
  // 기록 버튼도 다른 버튼처럼 비활성 이유를 알려 줍니다. 이유 없이 눌리지 않으면
  // 고장으로 보입니다.
  professionalRecordButton.title = recorder.agentId
    ? "완료된 실행의 기록을 다시 만듭니다"
    : `기록 담당자가 필요합니다. ${roleSetupHint}`;
  // 저장된 기획안이 있으면(승인 대기 중이거나 통과한 경우) 열람 버튼을 노출합니다.
  const hasPlanTask = Boolean(specialistPlanTaskPath);
  professionalPlanViewButton.hidden = !hasPlanTask;
  professionalPlanViewButton.disabled = specialistRunning || specialistActive;
  professionalPlanViewButton.textContent = specialistPlanTaskId
    ? `기획안 보기 (${specialistPlanTaskId})`
    : "기획안 보기";
  // 툴팁도 실제 활성 조건과 같은 값을 본다. "실행할 수 있습니다"라고 적힌 버튼이
  // 눌리지 않는 상태를 만들지 않는다.
  professionalImplementationButton.title = ordinaryTurnBusy
    ? "일반 응답이 끝난 뒤 구현·검수를 시작할 수 있습니다"
    : !implementationConfigured
      ? `구현·검토 담당자가 필요합니다. ${roleSetupHint}`
    : !specialistPlanReady
      ? "먼저 기획·검수를 통과시켜 주세요"
    : specialistBlockedAvailable
      ? "구현이 막혔습니다. 먼저 변경 유지·복원·재기획 중 하나를 선택해 주세요"
    : awaitingAnswer
      ? "먼저 대기 중인 질문이나 확인 항목을 처리해 주세요"
    : canStartImplementation
      ? policyTooltip("기획 검수를 통과한 작업을 구현·검수·기록까지 실행합니다.", currentProfessionalPolicy().implementationAutoRevisions, "구현")
      : "실행 중에는 새로 시작할 수 없습니다";
  // 다음에 실행할 단계를 강조합니다: 기획 통과 전이면 1단계, 통과 후면 2단계.
  // 강조와 활성 조건은 같은 값을 써야 "빛나는데 눌리지 않는" 버튼이 생기지 않는다.
  const nextIsImplementation = canStartImplementation;
  const nextIsPlan = planConfigured && !specialistPlanReady && !blockedOrBusy;
  professionalPlanButton.classList.toggle("is-next-step", nextIsPlan);
  professionalImplementationButton.classList.toggle("is-next-step", nextIsImplementation);
  renderProfessionalStatusDetail();
  renderProfessionalBlocked();
}

// 재기획·보완은 이전 작업으로 돌아간다. 순번으로 앞 단계의 완료를 추정하지
// 않고, 백엔드가 보고한 현재 작업과 라운드만 표시한다.
const PROFESSIONAL_NODE_LABELS = Object.freeze({
  PLANNING: "기획",
  PLAN_REVIEW: "기획 검수",
  READY: "실행 대기",
  IMPLEMENTING: "구현",
  REVIEWING: "구현 검수",
  RECORDING: "기록",
  COMPLETED: "완료",
});

function specialistRoundSummary() {
  const rounds = [];
  if (specialistPlanRound > 0) rounds.push(`기획 ${specialistPlanRound}차`);
  if (specialistImplementationRound > 0) rounds.push(`구현 ${specialistImplementationRound}차`);
  return rounds.join(" · ");
}

// 멈춤·대기 사유를 사용자 언어로 옮긴다. 내부 코드(USER_INTERRUPTED 같은)는
// 아래 "자세히"에만 남긴다. 모르는 코드는 정상 완료나 복원 가능으로 포장하지 않고
// 확인이 필요한 상태로 알린다.
const SPECIALIST_STOP_INFO = Object.freeze({
  PLAN_READY: { text: "기획 검수를 통과했습니다.", next: "‘기획안 보기’로 확인한 뒤 ‘실행 ▶’을 누르면 구현을 시작합니다." },
  NEEDS_DECISION: { text: "기획자가 결정을 요청했습니다.", next: "아래 입력칸에 답해 주시면 기획을 이어서 진행합니다." },
  HUMAN_APPROVAL_REQUIRED: { text: "완료 전에 확인할 항목이 있습니다.", next: "아래 목록에서 승인하거나 거부해 주세요." },
  CHECKPOINT_FAILED: { text: "작업 전 백업을 만들지 못했습니다.", next: "아래에서 재시도·무보호 진행·취소 중 하나를 골라 주세요." },
  TASK_CONTRACT_INCOMPLETE: { text: "기획안에 빠진 항목이 있습니다.", next: "아래 입력칸에 보완할 내용을 알려 주세요." },
  FIX_REQUIRED: { text: "검수에서 수정 요청이 나왔습니다.", next: "자동 보완 한도를 넘었다면 보완 내용을 직접 알려 주세요." },
  LIMIT_EXCEEDED: { text: "자동 보완 한도에 도달했습니다.", next: "보완 내용을 직접 알려 주거나 기획부터 다시 시작할 수 있습니다." },
  SCOPE_OUT: { text: "검수 지적이 기획안 범위 밖입니다.", next: "기획안을 고쳐 범위를 넓히거나 이 실행을 마무리해 주세요." },
  SCOPE_UNSPECIFIED: { text: "검수 지적의 범위가 분명하지 않습니다.", next: "기획안을 확인해 범위를 정해 주세요." },
  INSUFFICIENT_EVIDENCE: { text: "검수가 판정할 근거가 부족합니다.", next: "기획안의 검증 조건을 보완한 뒤 다시 실행해 주세요." },
  AMBIGUOUS_VERDICT: { text: "검수 판정이 명확하지 않습니다.", next: "검수 결과를 확인한 뒤 다시 실행할지 정해 주세요." },
  BUILDER_DONE: { text: "구현이 끝났습니다.", next: "이어서 검수를 진행할 수 있습니다." },
  REVIEW_PASS: { text: "구현 검수를 통과했습니다.", next: "이어서 기록 단계를 진행할 수 있습니다." },
  BLOCKED: { text: "구현이 막혀 안전하게 멈췄습니다.", next: "변경 유지·복원·재기획 중 하나를 고르세요." },
  // 막힘 처리를 끝낸 뒤의 정상 종료다. 표에 없으면 "확인이 필요한 상태로
  // 멈췄습니다"라는 미상 코드 문구가 떠서, 성공했는데 실패처럼 보인다.
  BLOCK_RESOLVED: { text: "막힌 실행을 정리했습니다.", next: "PLAN 또는 전체 실행으로 새로 시작할 수 있습니다." },
  EXECUTION_BLOCKED: { text: "구현이 막혀 안전하게 멈췄습니다.", next: "처리 방법을 고르세요." },
  ASSURANCE_BLOCKED: { text: "확인 조건을 충족하지 못해 완료를 보류했습니다.", next: "처리 방법을 고르세요." },
  ASSURANCE_INVALIDATED: { text: "확인한 뒤 결과물이나 입력 자료가 바뀌었습니다.", next: "다시 확인할 방법을 고르세요." },
  USER_INTERRUPTED: { text: "사용자가 실행을 중지했습니다.", next: "PLAN 또는 전체 실행으로 다시 시작할 수 있습니다." },
  EXECUTION_INTERRUPTED: { text: "실행이 중단되었습니다.", next: "PLAN 또는 전체 실행으로 다시 시작할 수 있습니다." },
  WORKSPACE_BUSY: { text: "같은 폴더를 다른 작업이 쓰고 있어 시작하지 못했습니다.", next: "그 작업이 끝난 뒤 다시 시도해 주세요." },
  RECORDER_FAILED: { text: "기록을 만들지 못했습니다.", next: "‘기록 다시 생성’으로 다시 시도할 수 있습니다." },
  TASK_CHANGED_AFTER_REVIEW: { text: "검수 뒤 기획안이 바뀌어 완료로 처리하지 않았습니다.", next: "기획안을 확인하고 다시 검수해 주세요." },
  FROZEN_TASK_MISSING: { text: "승인된 기획안을 찾지 못했습니다.", next: "기획부터 다시 시작해 주세요." },
  FROZEN_TASK_CORRUPTED: { text: "승인된 기획안이 손상됐습니다.", next: "처리 방법을 고르세요." },
  PROTOCOL_FINAL_MISSING: { text: "담당 AI의 최종 응답을 확인하지 못했습니다.", next: "다시 실행하거나 담당자를 바꿔 보세요." },
});

// 저장 실패 계열은 한 문장으로 묶는다(어느 파일에 실패했는지는 자세히에 남는다).
const SPECIALIST_WRITE_FAILURES = Object.freeze(new Set([
  "PROFESSIONAL_RUN_WRITE_FAILED",
  "RUN_STATE_WRITE_FAILED",
  "WORKFLOW_WRITE_FAILED",
  "EVIDENCE_WRITE_FAILED",
  "RECOVERY_JOURNAL_WRITE_FAILED",
  "ASSURANCE_STATE_WRITE_FAILED",
  "DIFF_COLLECTION_FAILED",
  "CHECKPOINT_CLEANUP_FAILED",
]));

function specialistStopInfo() {
  if (!specialistStopReason) return null;
  if (specialistStopReason === "TASK_CONTRACT_INCOMPLETE" && specialistMissingSections?.length > 0) {
    return {
      text: `기획안에 빠진 항목이 있습니다 (누락: ${specialistMissingSections.join(", ")}).`,
      next: "아래 입력칸에 보완할 내용을 알려 주세요.",
    };
  }
  if (SPECIALIST_WRITE_FAILURES.has(specialistStopReason)) {
    return { text: "실행 기록을 저장하지 못해 멈췄습니다.", next: "저장 공간과 폴더 권한을 확인한 뒤 다시 시도해 주세요." };
  }
  return SPECIALIST_STOP_INFO[specialistStopReason]
    || { text: "확인이 필요한 상태로 멈췄습니다.", next: "아래 ‘자세히’에서 사유 코드를 확인해 주세요." };
}

// 현재 상태 한 줄 + 다음 행동 한 줄. 우선순위는 "사용자가 지금 해야 하는 일"이
// 있는 상태부터다.
function specialistStatusView() {
  const stop = specialistStopInfo();
  if (!specialistNode && !specialistStopReason) {
    return { headline: "", next: "", tone: "idle" };
  }
  if (specialistBlockedAvailable || specialistStatus === "BLOCKED" || specialistStatus === "INVALID") {
    return {
      headline: stop?.text || "구현이 막혀 안전하게 멈췄습니다.",
      // 선택지가 있는 자리는 모드에 따라 다르다. 전문 모드에서는 이 줄 바로 아래에
      // 펼쳐 두고, 일반 모드에서는 입력창 옆 칩이 대신한다. 없는 것을 가리키면
      // 사용자는 화면에서 찾다가 길을 잃는다.
      next: professionalModeEnabled
        ? "바로 아래에서 변경 유지·복원·재기획 중 하나를 고르세요."
        : "입력창 옆 ‘다음 처리 선택’에서 변경 유지·복원·재기획 중 하나를 고르세요.",
      tone: "blocked",
    };
  }
  if (canResumeAfterApproval()) {
    return {
      headline: "확인이 끝났습니다. 기록 단계를 기다리고 있습니다.",
      next: "아래 ‘기록 이어서 진행’으로 다시 시도할 수 있습니다.",
      tone: "waiting",
    };
  }
  if (awaitingHumanApproval()) {
    const count = specialistPendingApprovals.length;
    return {
      headline: count > 0 ? `완료 전에 확인할 항목이 ${count}건 있습니다.` : "완료 전에 확인할 항목이 있습니다.",
      next: specialistApprovalsLoading ? "확인 목록을 불러오고 있습니다."
        : specialistApprovalsError || count === 0 ? "아래에서 목록을 다시 불러올 수 있습니다."
          : "아래 목록에서 승인하거나 거부해 주세요.",
      tone: "waiting",
    };
  }
  if (specialistNode === "COMPLETED") {
    // 완료 뒤의 기록 정리(Archivist)를 중지한 경우까지 실패로 보이지 않게 한다.
    const archivistStopped = specialistStopReason === "USER_INTERRUPTED";
    return {
      headline: specialistActive ? "본 실행이 완료되었습니다. 추가 기록 작업 중입니다."
        : archivistStopped ? "본 실행이 완료되었습니다. 추가 기록 정리는 중지했습니다." : "본 실행이 완료되었습니다.",
      next: "‘기록 다시 생성’으로 기록을 다시 만들거나, 새 작업을 요청할 수 있습니다.",
      tone: "done",
    };
  }
  // 중단됐더라도 READY로 돌아와 승인된 기획을 그대로 들고 있으면 '실행 ▶'을 바로
  // 누를 수 있다(백엔드는 status가 아니라 승인된 기획만 본다). 그때 중단 안내만
  // 내보내면 화면은 PLAN·전체 실행만 말하는데 정작 강조된 버튼은 '실행 ▶'이라,
  // 눌러도 되는 것인지 알 수 없게 된다. 스테퍼도 이미 '대기'로 그려진다.
  const interruptedButRunnable = specialistNode === "READY" && specialistImplementationReady;
  if (specialistStatus === "INTERRUPTED" && !interruptedButRunnable) {
    return {
      headline: stop?.text || "실행이 중단되었습니다.",
      next: stop?.next || "PLAN 또는 전체 실행으로 다시 시작할 수 있습니다.",
      tone: "stopped",
    };
  }
  if (specialistStatus === "RUNNING") {
    const label = PROFESSIONAL_NODE_LABELS[specialistNode];
    return {
      headline: label ? `${label} 진행 중입니다.` : "전문 실행이 진행 중입니다.",
      next: "일반 대화로 전환하면 실행 중에도 기획자에게 메모를 남길 수 있습니다.",
      tone: "running",
    };
  }
  // READY라도 사용자가 먼저 답해야 하는 대기(백업 실패 선택, 기획안 보완)가
  // 걸려 있으면 그쪽이 우선이다. 예전에는 node만 보고 "실행을 기다립니다"라고
  // 안내했는데, 그 순간 '실행 ▶'은 비활성이고 입력창은 다른 것을 요구하고 있었다.
  if (specialistNode === "READY" && !specialistNeedsInput) {
    // 검수는 통과했는데 승인된 기획서를 읽지 못한 경우(앱을 다시 켠 뒤 TASK.md가
    // 사라졌거나 바뀐 경우)에는 '실행 ▶'이 꺼져 있다. 왜 못 누르는지 밝힌다.
    if (!specialistImplementationReady) {
      return {
        headline: "기획 검수는 통과했지만 승인된 기획서를 읽지 못했습니다.",
        next: "작업 폴더에서 기획서(TASK.md)가 지워졌거나 바뀌었습니다. 입력칸에 수정 사항을 적어 기획을 다시 통과시켜 주세요.",
        tone: "waiting",
      };
    }
    return {
      // 중단됐다는 사실은 지우지 않는다 — 다만 "그래서 지금 무엇을 할 수 있는지"를
      // 함께 말한다.
      headline: specialistStatus === "INTERRUPTED"
        ? "이전 실행은 중단됐지만 승인된 기획은 그대로 남아 있습니다."
        : "기획 검수를 통과했습니다. 실행을 기다리고 있습니다.",
      next: "‘기획안 보기’로 확인한 뒤 ‘실행 ▶’을 누르면 구현을 시작합니다. 입력칸에 쓰면 기획을 수정합니다.",
      tone: "waiting",
    };
  }
  if (stop) return { headline: stop.text, next: stop.next, tone: "waiting" };
  return { headline: "다음 진행을 기다리고 있습니다.", next: "", tone: "waiting" };
}

// '실행 ▶'을 누를 수 있는가. 백엔드(startSpecialist의 implementation 분기)가
// 허용하는 조건과 같아야 한다: 기획 검수 통과 + 승인된 기획서 보유 + 막힘 아님
// + 실행 중 아님 + 사용자가 답해야 하는 대기 없음.
//
// 이 판정은 두 번 어긋난 적이 있다. 한 번은 READY에 늘 있는 재개 상태를 '바쁨'으로
// 세어 통과 직후 버튼이 영영 꺼져 있었고, 한 번은 앱을 다시 켠 뒤 기획서를 읽지
// 못했는데도 켜져서 누르면 백엔드가 거절했다. 그래서 화면 그리기에서 떼어 내
// 그 자체로 시험할 수 있게 둔다.
function canStartImplementationNow({ implementationConfigured, busy }) {
  return Boolean(
    implementationConfigured
    && specialistPlanReady
    && specialistImplementationReady
    && !busy
    && !specialistBlockedAvailable
    && !(specialistNeedsInput || awaitingHumanApproval())
  );
}

function renderProfessionalStatusDetail() {
  const box = document.getElementById("professional-status-detail");
  if (!box) return;
  const detailsOpen = Boolean(box.querySelector("details")?.open);
  box.replaceChildren();
  const view = specialistStatusView();
  box.dataset.tone = view.tone;
  box.hidden = !view.headline;
  if (!view.headline) return;

  const roundSummary = specialistRoundSummary();
  if (roundSummary) {
    const context = document.createElement("span");
    context.className = "professional-status-context";
    context.textContent = roundSummary;
    box.append(context);
  }
  const headline = document.createElement("span");
  headline.className = "professional-status-headline";
  headline.textContent = view.headline;
  box.append(headline);
  if (view.next) {
    const next = document.createElement("span");
    next.className = "professional-status-next";
    next.textContent = view.next;
    box.append(next);
  }

  // 기술 정보는 기본 화면에서 빼고, 필요할 때만 펼쳐 본다.
  const facts = [];
  if (specialistStopReason) facts.push(`사유 코드: ${specialistStopReason}`);
  if (specialistNode) facts.push(`상태: ${specialistNode}/${specialistStatus || "-"}`);
  if (specialistFrozenRunId) facts.push(`Run: ${specialistFrozenRunId}`);
  if (specialistPlanTaskId) facts.push(`기획안: ${specialistPlanTaskId}`);
  if (specialistCheckpointProtection) {
    facts.push(specialistCheckpointProtection === "protected"
      ? "작업 전 백업: 있음"
      : "작업 전 백업: 없음(무보호 실행)");
  } else if (specialistNode && specialistNode !== "PLANNING") {
    facts.push(specialistCanRestore ? "작업 전 백업: 있음" : "작업 전 백업: 없음");
  }
  if (facts.length === 0) return;
  const details = document.createElement("details");
  details.className = "professional-status-facts";
  details.open = detailsOpen;
  const summary = document.createElement("summary");
  summary.textContent = "자세히";
  const list = document.createElement("span");
  list.textContent = facts.join(" · ");
  details.append(summary, list);
  box.append(details);
}

// 막힘 상세(복원 가능 여부·Run·변경 요약)를 받아 온다. 세션을 바꾼 뒤 늦게 온
// 응답이 지금 화면을 덮지 않도록 요청 시점의 세션과 대조한다(승인 목록과 같은 계약).
async function refreshBlockInfo() {
  const sessionId = activeSessionId;
  if (!sessionId) return;
  if (specialistBlockFetch === "loading") return;
  specialistBlockFetch = "loading";
  renderProfessionalBlocked();
  const result = await call(window.chatApi.specialistBlockDetails(sessionId));
  if (sessionId !== activeSessionId) {
    // loading에 둔 채 나가면 위 가드에 막혀 다시 조회하지 못한다.
    specialistBlockFetch = "idle";
    return;
  }
  if (!result) {
    specialistBlockFetch = "error";
    renderProfessionalBlocked();
    return;
  }
  specialistBlockInfo = result.details || null;
  specialistBlockFetch = "ready";
  renderProfessionalBlocked();
}

// 막힘 처리 선택지를 상태 줄 바로 아래에 펼친다. 버튼은 모달과 같은 빌더
// (renderBlockedActions)로 만들어 두 곳이 갈라지지 않게 한다.
function renderProfessionalBlocked() {
  const box = document.getElementById("professional-blocked");
  if (!box) return;
  box.replaceChildren();
  const show = specialistBlockedAvailable && professionalModeEnabled;
  box.hidden = !show;
  if (!show) return;

  if (specialistBlockFetch === "loading") {
    const loading = document.createElement("p");
    loading.className = "popover-hint";
    loading.textContent = "막힘 정보를 불러오는 중…";
    box.append(loading);
    return;
  }
  if (specialistBlockFetch === "error") {
    const failed = document.createElement("p");
    failed.className = "popover-hint";
    failed.textContent = "막힘 정보를 불러오지 못했습니다.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "다시 불러오기";
    retry.addEventListener("click", () => { specialistBlockFetch = "idle"; void refreshBlockInfo(); });
    box.append(failed, retry);
    return;
  }

  const actions = document.createElement("div");
  actions.className = "professional-blocked-actions";
  renderBlockedActions(actions, specialistBlockInfo);
  box.append(actions);

  // 변경 내용·Run 같은 자세한 정보는 예전처럼 모달에서 본다.
  if (specialistBlockInfo?.block?.changes?.text || specialistBlockInfo?.runId) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "professional-blocked-more";
    more.textContent = "변경 내용 보기";
    more.addEventListener("click", () => { void openSpecialistDialog(); });
    box.append(more);
  }
}

// --- 에이전트 칩 + 팝오버 ---
function renderAgents() {
  renderRailLabels();
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
    if (agent.awaitingUser) chip.classList.add("is-awaiting");
    chip.title = agent.awaitingUser
      ? agent.awaitingQuestion
        ? `답변 대기 — ${agent.awaitingQuestion}`
        : "이 에이전트가 당신의 답을 기다립니다"
      : agent.available
        ? agent.enabled
          ? "클릭해 모델/속도 설정"
          : "이 세션에서 비활성화됨 · 클릭해 설정"
        : agent.reason || "CLI를 찾지 못했습니다";

    const avatar = makeAgentAvatar(agent, "agent-avatar");
    chip.append(avatar, document.createTextNode(`@${agent.id}`));
    if (agent.awaitingUser) {
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

// 되질문으로 턴을 끝낸 에이전트를 composer 위에 모아 보여준다. 알약을 누르면
// 그 에이전트에게 답하도록 @id를 채우고, 산문에서 뽑은 보기가 있으면 칩으로
// 띄운다. 칩을 누르면 "@id <보기>"까지 채워 준다(자동 전송 X — 사용자가 확인).
function renderAwaitingRow() {
  if (!awaitingRow) return;
  awaitingRow.textContent = "";
  const waiting = agents.filter((agent) => agent.awaitingUser);
  awaitingRow.hidden = waiting.length === 0;
  if (waiting.length === 0) return;
  const label = document.createElement("span");
  label.className = "awaiting-label";
  label.textContent = waiting.length > 1 ? `답변 대기 ${waiting.length}` : "답변 대기";
  awaitingRow.append(label);
  for (const agent of waiting) {
    const group = document.createElement("div");
    group.className = "awaiting-group";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "awaiting-pill";
    pill.style.setProperty("--agent-color", agent.color);
    pill.append(makeAgentAvatar(agent, "agent-avatar"));
    const text = document.createElement("span");
    text.className = "awaiting-pill-text";
    text.textContent = agent.awaitingQuestion
      ? `@${agent.id} · ${agent.awaitingQuestion}`
      : `@${agent.id}`;
    pill.append(text);
    pill.title = agent.awaitingQuestion
      ? `${agent.name}에게 답하기 — ${agent.awaitingQuestion}`
      : `${agent.name}에게 답하기`;
    pill.addEventListener("click", () => answerAwaitingAgent(agent.id));
    group.append(pill);

    const options = Array.isArray(agent.awaitingOptions) ? agent.awaitingOptions : [];
    if (options.length > 0) {
      const optionRow = document.createElement("div");
      optionRow.className = "awaiting-options";
      for (const option of options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "awaiting-option";
        chip.textContent = option;
        chip.title = `@${agent.id} ${option} (으)로 답하기`;
        chip.addEventListener("click", () => answerAwaitingAgent(agent.id, option));
        optionRow.append(chip);
      }
      group.append(optionRow);
    }
    awaitingRow.append(group);
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

function setRailActive(button) {
  document.querySelectorAll(".app-rail-button").forEach((item) => {
    item.classList.remove("is-active");
    item.removeAttribute("aria-current");
  });
  if (button) {
    button.classList.add("is-active");
    button.setAttribute("aria-current", "page");
  }
}

// 레일 라벨·툴팁을 참가자 이름에서 채운다. HTML에 이름을 또 박으면 개명할 때마다
// provider-capabilities와 chat.html이 어긋난다. 이름을 아직 못 받았으면 HTML의
// 초기값을 그대로 둔다.
function renderRailLabels() {
  for (const [agentId, button] of railAgentButtons) {
    const agent = agentById(agentId);
    const name = agent?.name;
    if (!button || !name) continue;
    const label = button.querySelector(".app-rail-label");
    if (label) label.textContent = name;
    // 헤더의 참가자 칩은 못 쓰는 참가자를 흐리게 보여 주는데 레일은 그러지
    // 않아, 설치되지 않은 AI가 설치된 것과 똑같이 켜져 보였다. 같은 기준을 쓴다.
    const unavailable = agentUnavailableReason(agent);
    button.classList.toggle("is-unavailable", Boolean(unavailable));
    const hint = unavailable ? `${name} · ${unavailable}` : `${name} 담당 모델·추론 설정`;
    button.title = hint;
    button.setAttribute("aria-label", hint);
  }
}

function openRailAgentSettings(agentId, button) {
  if (!agentById(agentId) || !providerById(agentId)) {
    flashNotice(`@${agentId} 담당 설정을 찾지 못했습니다.`);
    return;
  }
  setRailActive(button);
  openAgentPopover(button, agentId);
}

for (const [agentId, button] of railAgentButtons) {
  button?.addEventListener("click", () => openRailAgentSettings(agentId, button));
}

railSettingsButton?.addEventListener("click", () => document.getElementById("btn-settings")?.click());

const POPOVER_VARIANTS = ["is-project-settings", "is-new-project", "is-workflow", "plan-preview-popover", "is-menu", "is-usage"];

function closePopover() {
  popover.hidden = true;
  popover.textContent = "";
  popover.classList.remove(...POPOVER_VARIANTS);
  popoverBackdrop.hidden = true;
  usagePopoverOpen = false;
  // 레일 버튼은 팝오버를 여는 순간에만 강조합니다. 상시 "현재 페이지"가 아닙니다.
  setRailActive(null);
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
  const sessionId = activeSessionId;
  if (!sessionId) return;
  const result = await call(window.chatApi.specialistBlockDetails(sessionId));
  // 조회하는 사이 세션을 바꿨다면 이전 세션의 막힘 상태를 지금 화면에 띄우지 않는다.
  if (sessionId !== activeSessionId) return;
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
  renderBlockedActions(specialistBody, details);
  specialistCancelBtn.textContent = "닫기";
}

specialistButton.addEventListener("click", () => {
  if (!activeSessionId) return;
  // 이 버튼은 일반/전문 화면 전환만 한다. 예전에는 막힘(BLOCKED) 상태에서만
  // 몰래 막힘 처리 모달을 열어, 라벨("전환")과 실제 동작이 어긋났다. 막힘 처리는
  // 전문 모드에서는 상태 줄 아래 패널이, 일반 모드에서는 입력창 옆 칩이 맡는다.
  professionalModeEnabled = !professionalModeEnabled;
  // 모드가 바뀌면 입력창의 잠금·안내 문구·전송 버튼 라벨도 같은 순간에 바뀌어야
  // 한다. renderHeader만 부르면 화면은 전문 모드인데 입력창은 이전 모드의
  // 문구를 그대로 들고 있었다. 작성 중인 입력은 건드리지 않는다.
  renderHeader();
  syncComposerLock();
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
    // 조절한 폭을 기억한다. popover는 열 때마다 다시 만들어지므로 저장하지 않으면
    // 볼 때마다 다시 늘려야 해서 조절 기능이 반쪽이 된다.
    const savedWidth = Number(localStorage.getItem(PLAN_PREVIEW_WIDTH_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= 280) {
      root.style.width = `${Math.min(savedWidth, Math.round(window.innerWidth * 0.94))}px`;
    }
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        if (root.hidden) return;
        try { localStorage.setItem(PLAN_PREVIEW_WIDTH_KEY, String(Math.round(root.offsetWidth))); } catch {}
      });
      observer.observe(root);
      planPreviewResizeObserver?.disconnect();
      planPreviewResizeObserver = observer;
    }
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

// 화면의 자동 보완 토글을 실행 정책으로 읽는다. 버튼(PLAN/실행/전체 실행)과
// 멘션(`@팀 실행`)이 **같은 값**을 써야 한다 — 예전에는 멘션 경로가 1회로 고정돼
// 있어, 토글을 2회로 두고 `@팀 실행`을 치면 조용히 1회로 돌았다.
function currentProfessionalPolicy() {
  return {
    planAutoRevisions: planAutoReviseToggle.checked
      ? boundedRevisionLimit(planAutoLimitSelect.value, 2)
      : 0,
    implementationAutoRevisions: implementationAutoReviseToggle.checked
      ? boundedRevisionLimit(implementationAutoLimitSelect.value, 1)
      : 0,
  };
}

async function runProfessionalAction(action) {
  if (!activeSessionId || specialistRunning || specialistActive) return;
  // 대기 중인 실행이 있는데 기획을 새로 시작하면 그 실행과 작업 전 백업이 사라진다.
  // 되돌릴 수 없으므로 한 번 확인받는다.
  if ((action === "plan" || action === "full") && (specialistBlockedAvailable || specialistResumeAvailable)) {
    const keptChanges = "구현자가 만든 파일 변경은 그대로 남습니다.";
    if (!window.confirm(
      `진행 중이던 전문 실행을 버리고 기획부터 다시 시작할까요?\n\n작업 전 백업(checkpoint)과 대기 중인 답변 요청이 사라집니다. ${keptChanges}`
    )) {
      return;
    }
  }
  specialistRunning = true;
  specialistActive = true;
  renderHeader();
  syncComposerLock();
  const result = await call(
    window.chatApi.specialistStart(activeSessionId, {
      action,
      ...currentProfessionalPolicy(),
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
//
// 복원 계열은 백엔드가 실제로 되돌릴 수 있을 때만 엽니다(details.canRestore).
// 예전에는 이 값을 전달하지 않아 복원할 수 없는 실행에서도 버튼이 살아 있었고,
// 누르면 resolveBlocked가 "git workspace가 아니어서…"로 거부하거나(종결 경로),
// replanBlocked가 조용히 아무것도 복원하지 않은 채 재기획만 했습니다.
function renderBlockedActions(root, details = null) {
  const canRestore = Boolean(details?.canRestore);
  const noRestoreReason = "작업 전 백업이 없어 되돌릴 수 없습니다. git 저장소가 아니거나 백업을 만들지 못한 실행입니다.";

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
  replanRestoreBtn.disabled = !canRestore;
  replanRestoreBtn.title = canRestore
    ? "작업 전 상태로 복원한 뒤 막힌 사유를 기획자에게 전달해 재기획합니다"
    : noRestoreReason;
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
  changesHint.textContent = canRestore
    ? "구현자가 막히기 전까지 만든 변경은 아직 그대로 있습니다. 아래에서 처리 방법을 고르세요."
    : `구현자가 막히기 전까지 만든 변경은 아직 그대로 있습니다. ${noRestoreReason} 변경을 유지하는 처리만 고를 수 있습니다.`;
  root.append(changesHint);

  const changeSelect = document.createElement("select");
  for (const option of [
    { value: "", label: "변경사항 처리…" },
    { value: "keep", label: "현재 변경만 유지 (종결)" },
    { value: "restore", label: "작업 전으로 복원 (종결)", needsRestore: true },
    { value: "discard", label: "작업 폐기 (복원 + 지시서 폐기)", needsRestore: true },
  ]) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.needsRestore && !canRestore
      ? `${option.label} — 복원할 백업 없음`
      : option.label;
    el.disabled = Boolean(option.needsRestore) && !canRestore;
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
  const sessionId = activeSessionId;
  const result = await call(window.chatApi.specialistReplanBlocked(sessionId, workspaceAction));
  if (sessionId !== activeSessionId) return;
  if (!result) {
    // 실패하면 막힘 상태는 그대로다. 선택창만 닫힌 채 두면 길을 다시 찾아야 하므로
    // 같은 선택지를 다시 연다(오류 내용은 call이 이미 알렸다).
    openSpecialistDialog();
    return;
  }
  flashNotice("막힌 사유를 전달하고 재기획을 시작했습니다.", false);
  if (result.meta) sessionMeta = result.meta;
  // 막힘 상세는 낡았다. 새 상태가 다시 막힘이면 setSpecialistState가 다시 받아 온다.
  // blocked 자체는 백엔드 값만 믿는다 — 재기획이 다시 막혔는데 화면이 선택지를
  // 지우면 안 된다.
  invalidateBlockInfo();
  if (result.specialist) setSpecialistState(result.specialist);
  syncComposerLock();
  renderHeader();
}

// 선택한 후속 처리를 백엔드에 전달합니다.
async function resolveBlocked(action) {
  if (action === "discard" || action === "restore") {
    const label = action === "discard" ? "작업을 폐기" : "작업 전 상태로 복원";
    if (!window.confirm(`${label}하시겠습니까? 구현자가 만든 변경은 사라집니다. (실행 전부터 있던 변경은 보존됩니다)`)) {
      return;
    }
  }
  const sessionId = activeSessionId;
  const result = await call(window.chatApi.specialistResolveBlocked(sessionId, action));
  if (sessionId !== activeSessionId) return;
  if (!result) {
    // 거부되면 막힘 상태는 그대로다. 남은 선택지를 다시 보여 준다.
    openSpecialistDialog();
    return;
  }
  flashNotice(
    action === "keep"
      ? "현재 변경을 유지했습니다."
      : action === "restore"
        ? "작업 전 상태로 되돌렸습니다."
        : "작업을 폐기했습니다.",
    false
  );
  if (result?.meta) sessionMeta = result.meta;
  invalidateBlockInfo();
  if (result?.specialist) setSpecialistState(result.specialist);
  syncComposerLock();
  renderHeader();
}

// 막힌 사유를 기획자에게 넘겨 지시서를 다시 쓰게 합니다.
// 별도 실행 경로를 만들지 않고, 기존 Handoff로 마지막 구현자 메시지를 전달합니다.

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
      btn.textContent = "📊 결론 종합하기";
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

    // 2. 모델 배지 — 별칭(fable)으로 실행했으면 CLI가 보고한 실제 모델을 함께 적어
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

    // 5. 토론 결론 종합 배지
    const summaryMeta = message.discussionSummary || agentMeta.discussionSummary;
    if (summaryMeta) {
      const summaryBadge = document.createElement("span");
      summaryBadge.className = "role-badge role-discussion-summary";
      summaryBadge.textContent = summaryMeta.record ? "🗂 토론 기록" : "📊 토론 종합";
      summaryBadge.title = summaryMeta.record
        ? "토론 내용을 프로젝트 기억 초안으로 남긴 기록입니다"
        : "이전 토론을 종합한 요약 카드입니다";
      meta.append(summaryBadge);
    }

    if (message.simplifyMeta || agentMeta.simplifyMeta) {
      const simplifyBadge = document.createElement("span");
      simplifyBadge.className = "role-badge role-simplify-summary";
      simplifyBadge.textContent = "💡 쉬운 설명";
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

    // 쉽게 설명 독립 버튼: 원문 작성 에이전트를 기본 대상으로 즉시 실행
    const simplifyBtn = document.createElement("button");
    simplifyBtn.type = "button";
    simplifyBtn.className = "message-simplify-button";
    simplifyBtn.textContent = "\u{1F4A1} 쉽게 설명";
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
    if (specialistRunning || specialistLocksComposer() || !simplifyAuthorUsable) {
      simplifyBtn.disabled = true;
      simplifyBtn.classList.add("is-disabled");
    }
    simplifyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (specialistRunning || specialistLocksComposer()) return;
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
// V1.5 역할 멘션 항목. 별칭은 main의 chat-mention ROLE_ALIASES와 같은 완전
// 단어형이어야 한다 — 어긋나면 자동완성으로 넣은 멘션이 라우팅되지 않는다.
// label은 목록 한 줄에 들어갈 만큼 짧게 — 별칭이 이미 말하는 역할명을 되풀이하지
// 않는다("@기획자" 옆의 "기획자에게"는 같은 말이다). 무엇을 하는 호출인지의
// 자세한 설명은 hint로 툴팁에 둔다.
const ROLE_MENTION_TARGETS = Object.freeze([
  { alias: "기획자", label: "질문 · 읽기 전용", hint: "기획자에게 질문합니다 (읽기 전용 · 실행하지 않음)", roleId: "planning" },
  { alias: "구현자", label: "질문 · 읽기 전용", hint: "구현자에게 질문합니다 (읽기 전용 · 실행하지 않음)", roleId: "implementation" },
  { alias: "검토자", label: "질문 · 읽기 전용", hint: "검토자에게 질문합니다 (읽기 전용 · 실행하지 않음)", roleId: "review" },
  { alias: "기록자", label: "질문 · 읽기 전용", hint: "기록자에게 질문합니다 (읽기 전용 · 실행하지 않음)", roleId: "recorder" },
]);

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

// 역할 멘션을 쓸 수 있는가와, 못 쓴다면 왜인가. 회색 항목에 이유를 붙이기 위해
// boolean 대신 { available, reason }을 돌려준다.
function roleMentionStatus(project, roleId) {
  let config = roleConfigFromProject(project, roleId);
  // 기록 역할은 비워 두면 검토 담당자를 재사용한다(main의 fallback과 동일).
  if (!config.agentId && roleId === "recorder") {
    config = roleConfigFromProject(project, "review");
  }
  if (!config.agentId) {
    return {
      available: false,
      reason: "담당자 미지정 · 프로젝트 설정(⋯)에서 지정",
      reasonShort: "담당자 미지정",
    };
  }
  const agent = agents.find((entry) => entry.id === config.agentId);
  const reason = agentUnavailableReason(agent);
  if (!reason) return { available: true, reason: "", reasonShort: "" };
  return { available: false, reason, reasonShort: `담당자 ${agentUnavailableShort(agent)}` };
}

function roleMentionAvailable(project, roleId) {
  return roleMentionStatus(project, roleId).available;
}

function mentionTargets() {
  const project = activeProjectEntry();
  const teamRoles = [
    { roleId: "planning", name: "기획자" },
    { roleId: "review", name: "검토자" },
    { roleId: "implementation", name: "구현자" },
  ];
  const teamMissing = teamRoles.filter((role) => !roleMentionAvailable(project, role.roleId));
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
    ...ROLE_MENTION_TARGETS.map((role) => {
      const status = roleMentionStatus(project, role.roleId);
      return {
        alias: role.alias,
        label: role.label,
        hint: role.hint,
        color: "#7c6f64",
        available: status.available,
        reason: status.reason,
        reasonShort: status.reasonShort,
      };
    }),
    {
      alias: "팀",
      label: "순차 상담 · 읽기 전용",
      hint: "기획자 → 검토자 → 구현자 순서로 상담합니다 (읽기 전용 · 실행하지 않음)",
      color: "#7c6f64",
      available: teamMissing.length === 0,
      // 어느 역할이 비어 있는지 알아야 무엇을 지정할지 안다.
      reason: teamMissing.length > 0
        ? `${teamMissing.map((role) => role.name).join("·")} 담당자 미지정`
        : "",
      reasonShort: teamMissing.length > 0
        ? `${teamMissing.map((role) => role.name).join("·")} 미지정`
        : "",
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
  const text = composerInput.value.trim();
  // 기획 답변·기획 수정은 전문 모드의 조작이다. 사용자가 일반 모드를 골랐으면
  // 그 발화는 실행을 건드리지 않고 "다음 기획용 메모"로만 남는다(아래 send 경로).
  if (specialistNeedsInput && professionalModeEnabled) {
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
  // READY 상태에서 텍스트 입력은 기획 수정으로 라우팅한다(전문 모드일 때만).
  if (specialistNode === "READY" && !specialistActive && text && professionalModeEnabled) {
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
  const result = await call(
    window.chatApi.send(
      activeSessionId,
      text,
      attachmentIds,
      independent,
      // 전문 실행이 실제로 돌거나 입력을 기다리는 동안에는 일반 모드에서도
      // 메모로만 남긴다. 그러지 않으면 참가자 전원이 응답해 실행 맥락에 일반
      // 대화가 섞인다. 중단된 실행의 노드가 남은 것만으로는 메모로 만들지 않는다.
      professionalModeEnabled || professionalRunBusy(),
      // `@팀 실행`이 버튼과 같은 자동 보완 정책을 쓰도록 토글 값을 함께 보낸다.
      currentProfessionalPolicy()
    )
  );
  if (result) {
    pendingAttachments = [];
    renderPendingAttachments();
    // 역할 멘션이 상담(CONSULT)으로 라우팅된 전송은 메모가 아니다 — 곧 역할
    // 담당자의 답이 오므로 "기록했습니다" 안내를 띄우지 않는다.
    if (professionalModeEnabled && !result.consult) {
      flashNotice("작업 요청을 기록했습니다. PLAN 또는 전체 실행을 선택하세요.", false);
    }
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
  if (full.discussionPresets) discussionPresets = full.discussionPresets;
  if (full.projects) projects = full.projects;
  const projectsChanged = Boolean(full.projects);
  if (full.workflow) workflow = full.workflow;
  if (Object.hasOwn(full, "activeProjectId")) activeProjectId = full.activeProjectId;
  // 프로젝트가 바뀌면 그 프로젝트의 자동 보완 정책으로 토글을 채운다. 같은
  // 프로젝트에서 목록만 다시 온 경우에는(설정 저장 직후 등) 강제로 다시 채워
  // 방금 저장한 값이 화면에 반영되게 한다.
  applyProjectAutoRevisions(projectsChanged && activeProjectId === autoRevisionsProjectId);
  if (full.sessions) sessions = full.sessions;
  if (full.sessionsByProject) sessionsByProject = full.sessionsByProject;
  if (Object.hasOwn(full, "activeSessionId")) {
    if (activeSessionId !== full.activeSessionId) {
      resetSpecialistApprovals();
      renderSpecialistApprovals();
      closeSpecialistDialog();
    }
    activeSessionId = full.activeSessionId;
  }

  if (full.session) {
    sessionMeta = full.session.meta;
    agents = full.session.agents || [];
    setSpecialistState(full.session.specialist || {});
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
  if (Object.hasOwn(payload, "activeSessionId")) {
    if (activeSessionId !== payload.activeSessionId) {
      resetSpecialistApprovals();
      renderSpecialistApprovals();
      closeSpecialistDialog();
    }
    activeSessionId = payload.activeSessionId;
  }
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
  // 일반 모드를 고른 동안에는 전문 조작 문구를 쓰지 않는다. 그 발화는 실행을
  // 건드리지 않고 기획자가 다음 라운드에 읽을 메모로만 남는다.
  const noteOnly = !professionalModeEnabled && professionalRunBusy();
  if (noteOnly) {
    composerInput.disabled = false;
    sendButton.disabled = false;
    composerInput.placeholder = "기획자에게 남길 메모를 입력하세요. 전문 실행은 그대로 둡니다 (Enter 전송)";
    sendButton.textContent = "메모 남기기";
  } else if (awaitingHumanApproval()) {
    // 승인은 입력창 위 확인 목록에서 한다. "실행이 끝난 뒤"라고 안내하면
    // 사용자가 무엇을 기다리는지 모른 채 막힌다.
    composerInput.disabled = true;
    sendButton.disabled = true;
    composerInput.placeholder = "확인 목록에서 항목을 승인하거나 거부해 주세요";
    sendButton.textContent = "확인 대기";
  } else if (canResumeAfterApproval()) {
    composerInput.placeholder = "‘기록 이어서 진행’을 눌러 주세요";
    sendButton.textContent = "기록 대기";
  } else if (specialistNeedsInput) {
    if (specialistStopReason === "CHECKPOINT_FAILED") {
      composerInput.placeholder = "아래에서 다음 처리를 선택하세요";
      composerInput.disabled = true;
      sendButton.textContent = "선택 대기";
    } else if (specialistStopReason === "TASK_CONTRACT_INCOMPLETE") {
      composerInput.placeholder = "기획을 보완하려면 수정 사항을 입력하세요 (Enter 전송)";
      composerInput.disabled = false;
      sendButton.textContent = "기획 보완";
    } else {
      composerInput.placeholder = "기획자의 Open Question에 답하세요 (Enter 전송)";
      composerInput.disabled = false;
      sendButton.textContent = "답변 보내기";
    }
  } else if (locked && specialistBlockedAvailable) {
    // 막힘은 "실행이 도는 중"이 아니라 "사용자를 기다리는 중"이다. 여기서
    // "실행이 끝난 뒤"라고 안내하면 아무것도 끝나지 않는데 기다리게 된다
    // (승인 대기에서 이미 같은 문제를 고쳤다).
    //
    // locked를 함께 보는 이유: 일반 모드에서는 막혀 있어도 입력창을 잠그지
    // 않는다(기획자에게 메모를 남길 수 있어야 한다). 그 경우 위쪽 noteOnly
    // 분기가 맡는다.
    composerInput.disabled = true;
    sendButton.disabled = true;
    composerInput.placeholder = "위쪽 막힘 안내에서 변경 유지·복원·재기획 중 하나를 골라 주세요";
    sendButton.textContent = "선택 대기";
  } else if (specialistNode === "READY" && !specialistActive) {
    composerInput.disabled = false;
    sendButton.disabled = false;
    composerInput.placeholder = "기획을 수정하려면 변경사항을 입력하세요. '실행' 버튼으로 시작합니다 (Enter 전송)";
    sendButton.textContent = "기획 수정";
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
