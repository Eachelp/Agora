/* global usageView */
const api = window.settingsApi;
const rootElement = document.documentElement;
const toastElement = document.querySelector("#toast");
const fontSelect = document.querySelector("#font");
const fontSearch = document.querySelector("#font-search");
const fontSizeInput = document.querySelector("#font-size");
const fontSizeValue = document.querySelector("#font-size-value");

let state = null;
let installedFonts = [];
let selectedFont = "";
let selectedFontSize = 12;
let toastTimer = null;

const UI_THEME_FIELDS = Object.freeze([
  { key: "page", defaultValue: "#f6f8fc" },
  { key: "sidebar", defaultValue: "#eef2f8" },
  { key: "surface", defaultValue: "#ffffff" },
  { key: "ink", defaultValue: "#102342" },
  { key: "muted", defaultValue: "#64748b" },
  { key: "accent", defaultValue: "#173f78" },
  { key: "line", defaultValue: "#dbe3ef" },
]);

function $(selector) {
  return document.querySelector(selector);
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function quoteFontFamily(fontFamily) {
  if (!fontFamily) return null;
  const escaped = String(fontFamily)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function createFontOption(label, value, fontFamily = "") {
  const option = new Option(label, value);
  option.style.fontFamily = fontFamily ? quoteFontFamily(fontFamily) : "var(--font-body)";
  return option;
}

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim());
}

function applyUiTheme(theme) {
  for (const field of UI_THEME_FIELDS) {
    const value = theme?.[field.key];
    if (isHexColor(value)) {
      rootElement.style.setProperty(`--${field.key}`, value);
      if (field.key === "surface") rootElement.style.setProperty("--surface-strong", value);
    } else {
      rootElement.style.removeProperty(`--${field.key}`);
      if (field.key === "surface") rootElement.style.removeProperty("--surface-strong");
    }
  }
}

function applyAppearance(appearance, fontFamily = appearance?.fontFamily || "") {
  const quotedFont = quoteFontFamily(fontFamily);
  if (quotedFont) {
    rootElement.style.setProperty("--user-font", quotedFont);
    rootElement.style.setProperty("--font-display", quotedFont);
  } else {
    rootElement.style.removeProperty("--user-font");
    rootElement.style.removeProperty("--font-display");
  }

  applyUiTheme(appearance?.uiTheme);

  const fontSize = Number(appearance?.fontSize);
  if (Number.isFinite(fontSize)) {
    rootElement.style.setProperty("--preview-font-size", `${fontSize}px`);
  } else {
    rootElement.style.removeProperty("--preview-font-size");
  }

  // 글꼴 미리보기 카드는 테마의 카드/글자 색을 따라갑니다.
  if (appearance?.uiTheme?.surface) {
    rootElement.style.setProperty("--preview-bg", appearance.uiTheme.surface);
  } else {
    rootElement.style.removeProperty("--preview-bg");
  }
  if (appearance?.uiTheme?.ink) {
    rootElement.style.setProperty("--preview-ink", appearance.uiTheme.ink);
  } else {
    rootElement.style.removeProperty("--preview-ink");
  }
}

function showError(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = String(message || "오류가 발생했습니다.");
  toastElement.hidden = false;
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
    toastElement.textContent = "";
  }, 4500);
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

function setButtonBusy(button, busy, busyLabel = "처리 중…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.wasDisabled = String(button.disabled);
    button.textContent = busyLabel;
    button.disabled = true;
    return;
  }
  if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
}

function replaceOptions(select, options, selectedValue) {
  select.replaceChildren(...options);
  select.value = selectedValue || "";
}

function resolveInstalledFontFamily(fontFamily) {
  const requested = String(fontFamily || "").trim();
  if (!requested) return "";
  const exact = installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === requested.toLocaleLowerCase("en")
  );
  if (exact) return exact;

  // 이전 버전은 Arial Bold처럼 개별 face 이름을 저장했습니다. 현재 목록은 CSS가 실제로
  // 인식하는 family 이름만 제공하므로, 남아 있는 style 꼬리표를 한 번 걷어내 이관합니다.
  const family = requested.replace(
    /\s+(?:Regular|Roman|Book|Medium|SemiBold|DemiBold|Bold|Light|Thin|Black|Italic)$/i,
    ""
  );
  return installedFonts.find(
    (font) => font.toLocaleLowerCase("en") === family.toLocaleLowerCase("en")
  ) || "";
}

function updateFontPreview() {
  $("#font-preview-name").textContent = selectedFont || "시스템 기본";
  fontSizeInput.value = String(selectedFontSize);
  fontSizeValue.value = `${selectedFontSize}px`;
  applyAppearance({ ...(state?.appearance || {}), fontSize: selectedFontSize }, selectedFont);
}

function renderFonts() {
  const query = fontSearch.value.trim().toLocaleLowerCase("ko");
  const filteredFonts = query
    ? installedFonts.filter((font) => font.toLocaleLowerCase("ko").includes(query))
    : installedFonts;
  const options = [createFontOption("시스템 기본", "")];

  if (selectedFont && !filteredFonts.includes(selectedFont)) {
    options.push(createFontOption(`${selectedFont} · 현재`, selectedFont, selectedFont));
  }
  options.push(...filteredFonts.map((font) => createFontOption(font, font, font)));
  if (query && filteredFonts.length === 0) {
    const empty = new Option("검색 결과 없음", "__empty__");
    empty.disabled = true;
    options.push(empty);
  }

  replaceOptions(fontSelect, options, selectedFont);
  $("#font-count").textContent = query
    ? `${filteredFonts.length} / ${installedFonts.length}개`
    : `${installedFonts.length}개`;
  updateFontPreview();
}

function renderGeneral({ resetAppearance = false } = {}) {
  if (!state) return;
  if (resetAppearance) {
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
  }
  renderUiTheme(state.appearance.uiTheme);
  $("#autostart").checked = state.autoStart;

  renderFonts();
}

function renderUiTheme(theme = {}) {
  for (const field of UI_THEME_FIELDS) {
    const value = isHexColor(theme[field.key]) ? theme[field.key].toLowerCase() : field.defaultValue;
    $(`#ui-${field.key}-color`).value = value;
    $(`#ui-${field.key}-picker`).value = value;
  }
}

function readUiTheme() {
  return Object.fromEntries(
    UI_THEME_FIELDS.map((field) => [field.key, $(`#ui-${field.key}-color`).value.trim()])
  );
}

function accountInitial(account, provider) {
  const source = account.email || account.label || provider.label || "C";
  return source.trim().slice(0, 1).toLocaleUpperCase("ko") || "C";
}

function createEmptyState(title) {
  const empty = createElement("div", "empty-state");
  empty.appendChild(createElement("strong", "", title));
  return empty;
}

function createProviderGroup(provider) {
  const group = createElement("section", "provider-group");
  const heading = createElement("header", "provider-heading");
  const title = createElement("div", "provider-title");
  title.append(
    createElement("span", "provider-mark", provider.label.slice(0, 1)),
    createElement("h2", "", provider.label)
  );

  const addButton = createElement("button", "button", "계정 추가");
  addButton.type = "button";
  addButton.addEventListener("click", () =>
    runAccountAction({ provider: provider.id, action: "login" }, addButton)
  );
  heading.append(title, addButton);
  group.appendChild(heading);

  const list = createElement("div", "stack-list");
  if (!provider.accounts?.length) {
    list.appendChild(createEmptyState("저장된 계정 없음"));
    group.appendChild(list);
    return group;
  }

  for (const account of provider.accounts) {
    const row = createElement("article", "list-row");
    const identity = createElement("div", "list-identity");
    identity.appendChild(
      createElement("span", "account-avatar", accountInitial(account, provider))
    );

    const copy = createElement("div", "list-copy");
    const titleRow = createElement("span");
    titleRow.appendChild(createElement("strong", "", account.email || account.label));
    if (account.active) titleRow.appendChild(createElement("span", "active-chip", "현재"));
    copy.appendChild(titleRow);
    if (account.plan) copy.appendChild(createElement("small", "", account.plan));
    identity.appendChild(copy);

    const actions = createElement("div", "list-actions");
    const switchButton = createElement(
      "button",
      "button",
      account.active ? "사용 중" : "전환"
    );
    switchButton.type = "button";
    switchButton.disabled = account.active;
    switchButton.addEventListener("click", () =>
      runAccountAction(
        { provider: provider.id, action: "switch", profileKey: account.key },
        switchButton
      )
    );
    actions.appendChild(switchButton);

    const deleteButton = createElement("button", "button danger-button", "삭제");
    deleteButton.type = "button";
    deleteButton.disabled = account.active;
    deleteButton.addEventListener("click", () => {
      const accountLabel = account.email || account.label || provider.label;
      if (!window.confirm(`"${accountLabel}" 저장 계정을 삭제할까요?`)) return;
      runAccountAction(
        { provider: provider.id, action: "delete", profileKey: account.key },
        deleteButton
      );
    });
    actions.appendChild(deleteButton);
    row.append(identity, actions);
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderAccounts() {
  const root = $("#provider-groups");
  root.replaceChildren();
  for (const provider of state?.providers || []) {
    root.appendChild(createProviderGroup(provider));
  }
}

// 게이지 계산 규칙(남은 %, 경고 임계값, 초기화 시각)은 채팅 화면과 공유합니다. → src/usage-view.js
function createUsageGauge(gauge) {
  const remaining = usageView.remainingPercent(gauge);
  const container = createElement("div", "usage-gauge");
  const row = createElement("div", "usage-row");
  row.append(
    createElement("span", "", gauge.label),
    createElement("strong", "", `${remaining}%`)
  );
  // 숫자와 막대가 모두 "남은 양"을 가리킵니다. 색만 사용량 기준으로 경고/위험을 표시합니다.
  const track = createElement("div", "usage-track");
  const fill = createElement("i", usageView.usageTone(gauge.usedPercent));
  fill.style.width = `${remaining}%`;
  track.appendChild(fill);
  container.append(row, track);
  if (gauge.resetText) {
    container.append(createElement("small", "", usageView.resetLabel(gauge.resetText)));
  }
  return container;
}

function renderUsage() {
  const root = $("#usage-cards");
  root.replaceChildren();
  for (const item of state?.usage || []) {
    const card = createElement("article", "usage-card");
    const heading = createElement("header", "usage-card-heading");
    heading.append(
      createElement("span", "provider-mark", item.label.slice(0, 1)),
      createElement("h2", "", item.label)
    );
    card.appendChild(heading);

    if (item.error) {
      card.appendChild(createElement("p", "usage-error", item.error));
    } else if (!item.gauges?.length) {
      card.appendChild(createElement("p", "usage-error", "한도 정보 없음"));
    } else {
      for (const gauge of item.gauges) card.appendChild(createUsageGauge(gauge));
    }
    root.appendChild(card);
  }
}

function renderAll(options = {}) {
  renderGeneral(options);
  renderAccounts();
  renderUsage();
}

async function runAccountAction(input, sourceButton) {
  const busyLabel = input.action === "switch"
    ? "전환 중…"
    : input.action === "delete"
      ? "삭제 중…"
      : "여는 중…";
  setButtonBusy(sourceButton, true, busyLabel);
  try {
    const response = await api.account(input);
    if (!response?.ok) throw new Error(responseError(response, "계정 작업에 실패했습니다."));
    state = response.data;
    renderAccounts();
    renderUsage();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    setButtonBusy(sourceButton, false);
  }
}

function activateSection(button, { focus = false } = {}) {
  const sectionId = button.dataset.section;
  for (const navButton of document.querySelectorAll(".nav-item")) {
    const active = navButton === button;
    navButton.classList.toggle("is-active", active);
    navButton.setAttribute("aria-selected", String(active));
    navButton.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".panel")) {
    const active = panel.id === sectionId;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  $("#section-label").textContent = button.dataset.label;
  if (focus) button.focus();
  $(".workspace").scrollTo({ top: 0, behavior: "smooth" });
}

function registerNavigation() {
  const buttons = [...document.querySelectorAll(".nav-item")];
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activateSection(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let targetIndex = index;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        targetIndex = (index + 1) % buttons.length;
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        targetIndex = (index - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = buttons.length - 1;
      }
      activateSection(buttons[targetIndex], { focus: true });
    });
  });
  api.onNavigate((section) => {
    const target = buttons.find((button) => button.dataset.section === section);
    if (target) activateSection(target);
  });
}

function registerAppearanceControls() {
  fontSearch.addEventListener("input", renderFonts);
  fontSelect.addEventListener("change", () => {
    if (fontSelect.value === "__empty__") return;
    selectedFont = fontSelect.value;
    updateFontPreview();
  });
  fontSizeInput.addEventListener("input", () => {
    selectedFontSize = Number(fontSizeInput.value) || 12;
    updateFontPreview();
  });
  $("#save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "적용 중…");
    try {
      const response = await api.save({
        fontFamily: selectedFont || null,
        fontSize: selectedFontSize,
        autoStart: $("#autostart").checked,
        uiTheme: readUiTheme(),
      });
      if (!response?.ok) throw new Error(responseError(response, "설정을 적용하지 못했습니다."));
      state = response.data;
      renderAll({ resetAppearance: true });
      applyAppearance(state.appearance, selectedFont);
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerProviderControls() {
  $("#refresh-accounts").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.get();
      if (!response?.ok) throw new Error(responseError(response, "계정을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });

  $("#refresh-usage").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, "확인 중…");
    try {
      const response = await api.usage();
      if (!response?.ok) throw new Error(responseError(response, "사용량을 확인하지 못했습니다."));
      state = response.data;
      renderAccounts();
      renderUsage();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setButtonBusy(button, false);
    }
  });
}

function registerAppearanceUpdates() {
  api.onAppearance((appearance) => {
    if (Number.isFinite(Number(appearance?.fontSize))) {
      selectedFontSize = Number(appearance.fontSize);
      fontSizeInput.value = String(selectedFontSize);
      fontSizeValue.value = `${selectedFontSize}px`;
    }
    applyAppearance(appearance, appearance?.fontFamily || selectedFont);
    if (appearance?.uiTheme) renderUiTheme(appearance.uiTheme);
    if (state) state.appearance = { ...state.appearance, ...appearance };
  });
}

function registerTitlebarControls() {
  $("#btn-minimize").addEventListener("click", () => api.minimize());
  $("#btn-maximize").addEventListener("click", () => api.maximize());
  $("#btn-close").addEventListener("click", () => api.close());

  api.onMaximizedState((isMaximized) => {
    const btn = $("#btn-maximize");
    const maxIcon = btn.querySelector(".icon-maximize");
    const restoreIcon = btn.querySelector(".icon-restore");
    if (isMaximized) {
      if (maxIcon) maxIcon.style.display = "none";
      if (restoreIcon) restoreIcon.style.display = "block";
      btn.setAttribute("aria-label", "이전 크기로 복원");
    } else {
      if (maxIcon) maxIcon.style.display = "block";
      if (restoreIcon) restoreIcon.style.display = "none";
      btn.setAttribute("aria-label", "최대화");
    }
  });
}

function registerColorPickerControls() {
  for (const field of UI_THEME_FIELDS) {
    const picker = $(`#ui-${field.key}-picker`);
    const input = $(`#ui-${field.key}-color`);
    picker.addEventListener("input", () => {
      input.value = picker.value;
      updateLiveUiTheme();
    });
    input.addEventListener("input", () => {
      const value = input.value.trim();
      if (isHexColor(value)) picker.value = value;
      updateLiveUiTheme();
    });
  }

  function updateLiveUiTheme() {
    for (const field of UI_THEME_FIELDS) {
      const value = $(`#ui-${field.key}-color`).value.trim();
      if (isHexColor(value)) {
        rootElement.style.setProperty(`--${field.key}`, value);
        if (field.key === "surface") rootElement.style.setProperty("--surface-strong", value);
      } else {
        rootElement.style.removeProperty(`--${field.key}`);
        if (field.key === "surface") rootElement.style.removeProperty("--surface-strong");
      }
    }
  }

  // 빠른 테마 프리셋: 7개 색 입력 필드를 한 번에 채우고 라이브 반영합니다.
  // 저장은 기존 저장 버튼이 담당하므로 별도 저장 로직을 두지 않습니다.
  const THEME_PRESETS = {
    "agora-blue": {
      page: "#f4f7fb", sidebar: "#eaf2f9", surface: "#ffffff",
      ink: "#102a43", muted: "#657d94", accent: "#0b67a1", line: "#d5e1ec",
    },
    "deep-navy": {
      page: "#f5f7fb", sidebar: "#e9edf5", surface: "#ffffff",
      ink: "#0f172a", muted: "#64748b", accent: "#1e3a8a", line: "#dbe2ee",
    },
    "aubergine": {
      page: "#faf6fb", sidebar: "#f1e8f2", surface: "#ffffff",
      ink: "#2a1730", muted: "#7c6a80", accent: "#7c3aed", line: "#e8dcec",
    },
    "emerald": {
      page: "#f3faf6", sidebar: "#e6f3ec", surface: "#ffffff",
      ink: "#0f2a1f", muted: "#5c7d6c", accent: "#059669", line: "#d3e7db",
    },
    "charcoal": {
      page: "#f6f6f7", sidebar: "#ececee", surface: "#ffffff",
      ink: "#1f2124", muted: "#6b6f76", accent: "#27272a", line: "#dcdde0",
    },
  };

  for (const presetButton of document.querySelectorAll(".theme-preset")) {
    presetButton.addEventListener("click", () => {
      const preset = THEME_PRESETS[presetButton.dataset.preset];
      if (!preset) return;
      for (const field of UI_THEME_FIELDS) {
        const value = preset[field.key];
        if (!value) continue;
        $(`#ui-${field.key}-color`).value = value;
        $(`#ui-${field.key}-picker`).value = value;
      }
      updateLiveUiTheme();
    });
  }
}

async function initialize() {
  registerTitlebarControls();
  registerColorPickerControls();
  registerNavigation();
  registerAppearanceControls();
  registerProviderControls();
  registerAppearanceUpdates();

  try {
    const [fontResponse, settingsResponse] = await Promise.all([api.fonts(), api.get()]);
    installedFonts = fontResponse?.ok && Array.isArray(fontResponse.data)
      ? fontResponse.data
      : [];
    if (!settingsResponse?.ok) {
      throw new Error(responseError(settingsResponse, "설정을 불러오지 못했습니다."));
    }
    state = settingsResponse.data;
    selectedFont = resolveInstalledFontFamily(state.appearance.fontFamily);
    selectedFontSize = Number(state.appearance.fontSize) || 12;
    renderAll({ resetAppearance: true });
    applyAppearance(state.appearance, selectedFont);
  } catch (error) {
    showError(error.message || String(error));
  }
}

initialize();
