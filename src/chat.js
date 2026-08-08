/* global chatMarkdown */
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
const enforcementHint = document.getElementById("enforcement-hint");
const discussionButton = document.getElementById("btn-discussion");
const workflowButton = document.getElementById("btn-workflow");
const specialistButton = document.getElementById("btn-specialist");
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

let providers = [];
let diagnostics = [];
let projects = [];
let activeProjectId = null;
let sessions = [];
let activeSessionId = null;
let sessionMeta = null;
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

const SIDEBAR_WIDTH_KEY = "agora.chat.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "agora.chat.sidebarCollapsed";
const DOCTOR_SEEN_KEY = "agora.chat.doctorSeen.v1";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;

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
  storeWarning.textContent = text;
  storeWarning.classList.toggle("is-error", isError);
  storeWarning.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    storeWarning.hidden = true;
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
      ["workspace-read", "새 대화: 워크스페이스 읽기"],
      ["workspace-write", "새 대화: 워크스페이스 쓰기"],
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
    choose.addEventListener("click", async () => {
      const result = await call(window.chatApi.projectsWorkspaceChoose(project.id));
      if (result && !result.canceled) {
        closePopover();
        applyFullState(result);
      }
    });
    workspaceField.append(workspace, choose);
    if (project.workspace) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "text-button";
      clear.textContent = "해제";
      clear.addEventListener("click", async () => {
        const result = await call(window.chatApi.projectsWorkspaceClear(project.id));
        if (result) {
          closePopover();
          applyFullState(result);
        }
      });
      workspaceField.append(clear);
    }

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
    roleHint.textContent = "기본 모드는 현재 채팅 설정을 쓰고, 전문 모드는 여기 지정한 담당자·모델을 씁니다.";
    roleSection.append(roleTitle, roleHint);
    const roleDefs = workflow.roles?.length
      ? workflow.roles
      : [
          { id: "planning", label: "기획" },
          { id: "implementation", label: "구현" },
          { id: "review", label: "검토" },
          { id: "recorder", label: "기록" },
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

    const memorySection = document.createElement("section");
    memorySection.className = "project-default-section";
    const memoryTitle = document.createElement("strong");
    memoryTitle.textContent = "프로젝트 Memory Bank";
    const memoryHint = document.createElement("p");
    memoryHint.className = "popover-hint";
    memoryHint.textContent = "사람이 직접 추가한 기록과 기록관이 만든 초안이 이 프로젝트에 누적됩니다.";
    const memoryPreview = document.createElement("textarea");
    memoryPreview.className = "project-context-input memory-preview";
    memoryPreview.rows = 5;
    memoryPreview.readOnly = true;
    memoryPreview.placeholder = "아직 기록이 없습니다.";
    const memoryInput = document.createElement("textarea");
    memoryInput.className = "project-context-input";
    memoryInput.rows = 3;
    memoryInput.maxLength = 24000;
    memoryInput.placeholder = "사람이 직접 남길 중요한 맥락·결정·규칙";
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
        flashNotice("Memory Bank에 기록했습니다.", false);
      }
    });
    memoryActions.append(memoryAdd);
    memorySection.append(
      memoryTitle,
      memoryHint,
      makeField("현재 기록", memoryPreview),
      makeField("새 사람 기록", memoryInput),
      memoryActions
    );
    call(window.chatApi.memoryRead(project.id)).then((result) => {
      if (result) memoryPreview.value = result.content || "";
    });

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
      memorySection,
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
  sessionListEl.textContent = "";
  for (const entry of sessions) {
    const item = document.createElement("li");
    item.className = "session-item";
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
    main.addEventListener("dblclick", () => startInlineRename(titleText, entry.id));

    const actions = document.createElement("span");
    actions.className = "session-actions";
    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "session-action";
    moveBtn.title = "다른 프로젝트로 이동";
    moveBtn.textContent = "↗";
    moveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openSessionMovePopover(moveBtn, entry);
    });
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "session-action";
    renameBtn.title = "이름 바꾸기";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      startInlineRename(titleText, entry.id);
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-action";
    deleteBtn.title = "휴지통으로 이동 (30일 후 정리)";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const yes = window.confirm(
        `"${entry.title}" 세션을 휴지통으로 옮길까요?\n첨부 사본도 함께 이동하며 30일 후 정리됩니다.`
      );
      if (!yes) return;
      const result = await call(window.chatApi.sessionsDelete(entry.id));
      if (result) applyFullState(result);
    });
    actions.append(moveBtn, renameBtn, deleteBtn);

    item.append(main, actions);
    sessionListEl.append(item);
  }
}

function startInlineRename(titleTextEl, sessionId) {
  const current = titleTextEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = current;
  input.maxLength = 80;
  titleTextEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.replaceWith(titleTextEl);
    if (save && next && next !== current) {
      const result = await call(window.chatApi.sessionsRename(sessionId, next));
      if (result) {
        sessions = result.sessions || sessions;
        if (sessionMeta && sessionMeta.id === sessionId) {
          sessionMeta = { ...sessionMeta, title: next };
        }
        renderSessions();
        renderHeader();
      }
    }
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

  const hints = [];
  for (const provider of providers) {
    if (provider.status !== "cli") continue;
    const info = provider.permissions?.[mode];
    if (info) {
      hints.push(`${provider.name}: ${ENFORCEMENT_LABEL[info.enforcement] || info.enforcement}`);
    }
  }
  enforcementHint.textContent = hints.length > 0 ? `적용 방식 — ${hints.join(" · ")}` : "";

  const discussable = agents.filter((agent) => agent.available && agent.enabled).length >= 2;
  discussionButton.disabled = !discussable;
  discussionButton.title = discussable
    ? "활성 에이전트들이 정해진 라운드만큼 토론합니다"
    : "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다";
  const project = projects.find((entry) => entry.id === activeProjectId);
  const implementation = roleConfigFromProject(project, "implementation");
  const review = roleConfigFromProject(project, "review");
  specialistButton.disabled = !activeSessionId || specialistRunning;
  specialistButton.title = implementation.agentId && review.agentId
    ? "프로젝트 설정의 구현·검토·기록 담당자로 진행합니다"
    : "프로젝트 설정에서 구현·검토 담당자를 지정하면 사용할 수 있습니다";
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

function closePopover() {
  popover.hidden = true;
  popover.textContent = "";
  popover.classList.remove("is-project-settings", "is-workflow");
  popoverBackdrop.hidden = true;
}

function openPopover(anchor, build) {
  popover.textContent = "";
  popover.classList.remove("is-project-settings", "is-workflow");
  build(popover);
  popover.hidden = false;
  popoverBackdrop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - popRect.width - 12);
  let top = rect.bottom + 6;
  if (top + popRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - popRect.height - 6);
  }
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${top}px`;
}

popoverBackdrop.addEventListener("click", closePopover);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) closePopover();
});

function makeField(labelText, control) {
  const field = document.createElement("label");
  field.className = "popover-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  return field;
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
      const suffixEffort = modelSelect.value.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
      const nextEffort = availableEfforts.includes(suffixEffort)
        ? suffixEffort
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
    autoApproveToggle.checked = Boolean(config.autoApprove);
    autoApproveToggle.disabled = !provider.available || sessionMeta?.permissionMode !== "workspace-write";
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

function openWorkflowPopover(anchor) {
  const project = activeProjectEntry();
  if (!project) return;

  openPopover(anchor, (root) => {
    root.classList.add("is-workflow");
    const title = document.createElement("strong");
    title.className = "project-popover-title";
    title.textContent = `${project.name} · 결정과 작업`;
    root.append(title);

    const summary = document.createElement("p");
    summary.className = "popover-status";
    summary.textContent = `결정 ${workflow.decisions?.length || 0}개 · 작업 ${workflow.tasks?.length || 0}개`;
    root.append(summary);

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
    decisionForm.className = "workflow-section";
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

    const decisionsSection = document.createElement("section");
    decisionsSection.className = "workflow-section";
    const decisionsTitle = document.createElement("strong");
    decisionsTitle.textContent = "기록된 결정";
    decisionsSection.append(decisionsTitle);
    if (!workflow.decisions?.length) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "아직 기록된 결정이 없습니다.";
      decisionsSection.append(empty);
    }
    for (const decision of workflow.decisions || []) {
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
    for (const decision of workflow.decisions || []) {
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
    taskForm.className = "workflow-section";
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

    const tasksSection = document.createElement("section");
    tasksSection.className = "workflow-section";
    const tasksTitle = document.createElement("strong");
    tasksTitle.textContent = "작업 목록";
    tasksSection.append(tasksTitle);
    if (!workflow.tasks?.length) {
      const empty = document.createElement("p");
      empty.className = "workflow-empty";
      empty.textContent = "아직 등록된 작업이 없습니다.";
      tasksSection.append(empty);
    }
    for (const task of workflow.tasks || []) {
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
      tasksSection.append(card);
    }

    root.append(decisionForm, decisionsSection, taskForm, tasksSection);
  });
}

// --- 토론 팝오버 ---
workflowButton.addEventListener("click", () => openWorkflowPopover(workflowButton));
specialistButton.addEventListener("click", async () => {
  if (!activeSessionId) return;
  const project = projects.find((entry) => entry.id === activeProjectId);
  const implementation = roleConfigFromProject(project, "implementation");
  const review = roleConfigFromProject(project, "review");
  if (!implementation.agentId || !review.agentId) {
    flashNotice("프로젝트 설정에서 구현·검토 담당자를 먼저 지정해 주세요.");
    return;
  }
  specialistRunning = true;
  specialistButton.disabled = true;
  specialistButton.textContent = "전문 실행 중…";
  const result = await call(window.chatApi.specialistStart(activeSessionId));
  if (result) flashNotice("전문 모드를 시작했습니다.", false);
  specialistRunning = false;
  specialistButton.disabled = false;
  specialistButton.textContent = "전문 실행";
  renderHeader();
});
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
        if (result?.ok && result.dataUrl) img.src = result.dataUrl;
      })
      .catch(() => {});
    pill.append(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "attachment-icon";
    icon.textContent = attachment.kind === "text" ? "📄" : "📦";
    pill.append(icon);
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
      const result = await call(window.chatApi.attachmentsRemove(activeSessionId, attachment.id));
      if (result) {
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

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = "message";

  if (message.authorType === "system") {
    item.classList.add("is-system");
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
  const metaParts = isUser ? [name] : [name, `@${message.author}`];
  if (!isUser) {
    const shownModel = agentMeta.model && agentMeta.model !== "default" ? agentMeta.model : agent?.model;
    const shownEffort = agentMeta.effort && agentMeta.effort !== "default" ? agentMeta.effort : agent?.effort;
    metaParts.push(shownModel || "모델 확인 불가", effortLabel(shownEffort || "추론 강도 확인 불가"));
  }
  nameEl.textContent = metaParts.join(" · ");
  const timeEl = document.createElement("span");
  timeEl.textContent = formatTime(message.ts);
  meta.append(nameEl, timeEl);

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

  if (!isUser) {
    const avatar = makeAgentAvatar(agent || { id: message.author, name, color });
    item.append(avatar, body);
  } else {
    item.append(body);
  }
  return item;
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
  messageList.append(renderMessage(message));
  scrollToBottom(stick || message.authorType === "user");
}

function renderAllMessages(messages) {
  messageList.textContent = "";
  liveRuns.clear();
  chatMessages = [...(messages || [])];
  for (const message of chatMessages) {
    messageList.append(renderMessage(message));
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
    liveMeta.push(agent?.model || "모델 확인 중");
    liveMeta.push(effortLabel(agent?.effort || "추론 강도 확인 중"));
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
  const result = await call(window.chatApi.attachmentsAdd(activeSessionId));
  if (!result) return;
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
  const result = await call(window.chatApi.attachmentsAddDropped(activeSessionId, paths));
  if (!result) return;
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
  if (!text && pendingAttachments.length === 0) return;
  const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
  composerInput.value = "";
  closeMentionPopup();
  autoresize();
  const result = await call(window.chatApi.send(activeSessionId, text, attachmentIds));
  if (result) {
    pendingAttachments = [];
    renderPendingAttachments();
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

sessionTitleEl.addEventListener("dblclick", () => {
  const entry = activeSessionEntry();
  if (!entry) return;
  const span = document.createElement("span");
  span.textContent = sessionTitleEl.textContent;
  sessionTitleEl.textContent = "";
  sessionTitleEl.append(span);
  startInlineRename(span, entry.id);
});

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
    typingAgents.clear();
    for (const agentId of full.session.typing || []) typingAgents.add(agentId);
    pendingAttachments = full.session.pendingAttachments || [];
    renderAllMessages(full.session.messages);
    scrollToBottom(true);
  }

  if (full.error) {
    storeWarning.textContent = `저장소 문제: ${full.error} — 대화가 저장되지 않을 수 있습니다.`;
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
  } else if (full.readOnly) {
    storeWarning.textContent =
      "이 .agora 저장소는 더 새로운 버전이 만든 것이라 읽기 전용으로 열렸습니다.";
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
  }

  renderProjects();
  renderSessions();
  renderHeader();
  renderAgents();
  renderTyping();
  renderPendingAttachments();
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
function showNextApproval() {
  if (activeApproval || approvalQueue.length === 0) return;
  activeApproval = approvalQueue.shift();
  const agent = agentById(activeApproval.agentId);
  approvalSummary.textContent = `${agent?.name || activeApproval.agentId}: ${activeApproval.summary}`;
  approvalDetail.textContent = activeApproval.detail || "세부 정보가 없습니다.";
  approvalBackdrop.hidden = false;
}
async function answerApproval(decision) {
  if (!activeApproval) return;
  const current = activeApproval;
  activeApproval = null;
  approvalBackdrop.hidden = true;
  await call(window.chatApi.approvalRespond(current.sessionId, current.approvalId, decision));
  showNextApproval();
}
approvalApprove.addEventListener("click", () => answerApproval("approve"));
approvalDeny.addEventListener("click", () => answerApproval("deny"));
window.chatApi.onApprovalRequest((payload) => {
  approvalQueue.push(payload);
  showNextApproval();
});
window.chatApi.onAppearance(applyAppearance);

// --- 초기화 ---
(async () => {
  const full = await call(window.chatApi.state());
  if (full) {
    applyFullState(full);
    if (localStorage.getItem(DOCTOR_SEEN_KEY) !== "true") openDoctor({ firstRun: true });
  }
  composerInput.focus();
})();
