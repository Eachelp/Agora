"use strict";

// 오케스트레이터 화면: 머리줄 칩 + 지휘 AI 팝오버, 입력창 안내문, "AI끼리 계속 부르기" 체크,
// 라운드·실행 횟수 상태 줄. 실제 chat.js 구간을 격리된 컨텍스트에서 돌리고
// DOM·IPC만 대체한다(reply-now-ui.test.js·question-ui.test.js와 같은 방식).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FakeNode, makeDocument } = require("./question-fake-dom.cjs");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const source = read("src/chat.js");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `구간을 찾지 못했습니다: ${start}`);
  return source.slice(from, to);
}

// 칩 강조·입력창 안내문만 떼어 둔다(renderHeader 전체는 provider·권한 선택 등 상관없는
// 의존이 많다 — 바뀐 자리만 함수로 감싸 돌린다).
function loadHeaderBits() {
  const composerInput = new FakeNode("textarea");
  composerInput.placeholder = "질문이나 작업을 입력하세요  (@로 대상 지정 · Enter 전송)";
  const context = {
    sessionMeta: null,
    composerInput,
    orchestratorChip: new FakeNode("button"),
    chkKeepCalling: new FakeNode("input"),
    DEFAULT_COMPOSER_PLACEHOLDER: composerInput.placeholder,
  };
  context.chkKeepCalling.type = "checkbox";
  vm.createContext(context);
  vm.runInContext(
    `function renderHeaderOrchestratorBits() {\n${section(
      "const orchestrator = sessionMeta?.orchestrator",
      "}\n\nfunction orchestratorLeadCandidates"
    )}\n}`,
    context
  );
  return context;
}

test("칩: 꺼짐일 때는 '오케스트레이터'만 보이고, 켜짐일 때는 지휘 AI까지 강조 스타일로 보인다", () => {
  const ui = loadHeaderBits();
  ui.renderHeaderOrchestratorBits();
  assert.equal(ui.orchestratorChip.textContent, "오케스트레이터");
  assert.equal(ui.orchestratorChip.classList.contains("is-active"), false);
  assert.equal(ui.composerInput.placeholder, ui.DEFAULT_COMPOSER_PLACEHOLDER);

  ui.sessionMeta = { orchestrator: { enabled: true, leadId: "claude" } };
  ui.renderHeaderOrchestratorBits();
  assert.equal(ui.orchestratorChip.textContent, "오케스트레이터 · @claude");
  assert.equal(ui.orchestratorChip.classList.contains("is-active"), true);
});

test("켜짐: 입력창 안내문이 지휘 AI·@ 규칙·이름만 쓰는 법을 담고, 꺼지면 원래 글로 돌아간다", () => {
  const ui = loadHeaderBits();
  ui.sessionMeta = { orchestrator: { enabled: true, leadId: "codex" } };
  ui.renderHeaderOrchestratorBits();
  assert.match(ui.composerInput.placeholder, /@codex/);
  assert.match(ui.composerInput.placeholder, /@로 부르면/);
  assert.match(ui.composerInput.placeholder, /codex에게 시켜/);

  ui.sessionMeta = { orchestrator: { enabled: false, leadId: null } };
  ui.renderHeaderOrchestratorBits();
  assert.equal(ui.composerInput.placeholder, ui.DEFAULT_COMPOSER_PLACEHOLDER);
});

test("AI끼리 계속 부르기 체크는 저장된 방 설정을 그대로 반영한다(기본 꺼짐)", () => {
  const ui = loadHeaderBits();
  ui.renderHeaderOrchestratorBits();
  assert.equal(ui.chkKeepCalling.checked, false);
  ui.sessionMeta = { keepCalling: true };
  ui.renderHeaderOrchestratorBits();
  assert.equal(ui.chkKeepCalling.checked, true);
});

// 칩 팝오버(지휘 AI 선택 + 켜기)와 라운드·실행 횟수 상태 줄, 실시간 구독 핸들러를 한 컨텍스트에서.
function loadOrchestratorBlock(agents, initialMeta, providers = []) {
  const calls = { orchestratorSet: [], orchestratorLead: [], keepCallingSet: [] };
  const popover = new FakeNode("div");
  const handlers = {};
  let sessionMeta = initialMeta;
  const context = {
    document: makeDocument(),
    agents,
    providers,
    effortLabel: (value) => value,
    get sessionMeta() { return sessionMeta; },
    set sessionMeta(value) { sessionMeta = value; },
    orchestratorChip: new FakeNode("button"),
    chkKeepCalling: new FakeNode("input"),
    orchestrationStatusRow: Object.assign(new FakeNode("div"), { hidden: true }), // chat.html에서 처음에는 숨겨져 있다.
    orchestration: null,
    activeSessionId: "room-a",
    approvalQueue: [],
    activeApproval: null,
    questionCards: { hasPending: () => false, isWaiting: () => false },
    agentById: (id) => agents.find((agent) => agent.id === id) || null,
    openPopover(anchor, build) {
      popover.textContent = "";
      build(popover);
    },
    makeField(label, control) {
      const field = new FakeNode("label");
      field.append(control);
      return field;
    },
    // call()이 {ok:false}를 null로 거두는 것과 같은 모양(chat.js:587).
    requestSessionMeta: async (send) => {
      const result = await send("room-a");
      if (result && result.ok === false) return null;
      if (result?.meta) sessionMeta = result.meta;
      return result;
    },
    orchestratorRejectLeadId: null,
    renderHeader() {}, // 이 블록은 전체 renderHeader를 안 들여온다 — onMeta가 부르는 자리만 비워 둔다.
    window: {
      chatApi: {
        orchestratorSet: async (sessionId, enabled, leadId, lead = {}) => {
          calls.orchestratorSet.push([sessionId, enabled, leadId]);
          calls.orchestratorLead.push(lead);
          if (enabled && leadId === context.orchestratorRejectLeadId) {
            return { ok: false, error: "지휘 AI로 쓸 수 있는 에이전트를 골라 주세요." };
          }
          // 서버(chat:orchestrator:set)와 같은 모양으로 저장한다: 비운 값은 키를 만들지 않는다.
          sessionMeta = {
            ...sessionMeta,
            orchestrator: {
              enabled,
              leadId: enabled ? leadId : null,
              ...(enabled && lead.leadModel ? { leadModel: lead.leadModel } : {}),
              ...(enabled && lead.leadEffort ? { leadEffort: lead.leadEffort } : {}),
              ...(enabled && lead.leadReadOnly ? { leadReadOnly: true } : {}),
            },
          };
          return { ok: true, meta: sessionMeta };
        },
        keepCallingSet: async (sessionId, enabled) => {
          calls.keepCallingSet.push([sessionId, enabled]);
          sessionMeta = { ...sessionMeta, keepCalling: enabled };
          return { ok: true, meta: sessionMeta };
        },
        onOrchestration: (handler) => { handlers.orchestration = handler; },
        onMeta: (handler) => { handlers.meta = handler; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      section("function providerById(id)", "// 저장된 모델이 노력 변형 id"),
      section("function orchestratorLeadCandidates()", "// 참가자 칩 툴팁."),
      section("window.chatApi.onOrchestration(", "window.chatApi.onUserQuestion?.("),
    ].join("\n"),
    context
  );
  return { ui: context, calls, popover, handlers };
}

const CANDIDATE_AGENTS = () => [
  { id: "claude", name: "Claude", available: false, enabled: true },
  { id: "codex", name: "Codex", available: true, enabled: true },
  { id: "agy", name: "AGY", available: true, enabled: false },
];

test("팝오버 기본 지휘 AI는 사용 가능하고 참여 중인 첫 후보다(비활성·불참은 빠진다)", () => {
  const { ui, popover } = loadOrchestratorBlock(CANDIDATE_AGENTS(), { orchestrator: { enabled: false, leadId: null } });
  ui.openOrchestratorPopover({});
  const select = popover.find((node) => node.tagName === "SELECT");
  assert.deepEqual(select.children.map((option) => option.value), ["codex"], "claude는 비활성, agy는 불참이라 빠진다");
  assert.equal(select.value, "codex");
});

test("후보가 하나도 없으면 안내만 보이고 선택지를 만들지 않는다", () => {
  const agents = [{ id: "claude", name: "Claude", available: false, enabled: true }];
  const { ui, popover } = loadOrchestratorBlock(agents, { orchestrator: { enabled: false, leadId: null } });
  ui.openOrchestratorPopover({});
  assert.equal(popover.find((node) => node.tagName === "SELECT"), null);
  assert.match(popover.textContent, /지휘 AI로 쓸 수 있는 에이전트가 없습니다/);
});

test("체크를 켜면 orchestratorSet을 부르고 저장된 설정을 반영한다", async () => {
  const { ui, popover, calls } = loadOrchestratorBlock(
    [
      { id: "claude", name: "Claude", available: true, enabled: true },
      { id: "codex", name: "Codex", available: true, enabled: true },
    ],
    { orchestrator: { enabled: false, leadId: null } }
  );
  ui.openOrchestratorPopover({});
  const enableToggle = popover.find((node) => node.tagName === "INPUT" && node.type === "checkbox");
  enableToggle.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.orchestratorSet, [["room-a", true, "claude"]]);
  assert.equal(enableToggle.checked, true, "성공하면 되돌리지 않는다");
  assert.deepEqual(ui.sessionMeta.orchestrator, { enabled: true, leadId: "claude" });
});

test("지휘 AI를 쓸 수 없다고 거절되면 체크가 켜짐으로 되돌아간다", async () => {
  const { ui, popover, calls } = loadOrchestratorBlock(
    [
      { id: "claude", name: "Claude", available: true, enabled: true },
      { id: "codex", name: "Codex", available: true, enabled: true },
    ],
    { orchestrator: { enabled: false, leadId: null } }
  );
  ui.orchestratorRejectLeadId = "claude";
  ui.openOrchestratorPopover({});
  const enableToggle = popover.find((node) => node.tagName === "INPUT" && node.type === "checkbox");
  enableToggle.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.orchestratorSet, [["room-a", true, "claude"]]);
  assert.equal(enableToggle.checked, false, "거절되면 꺼짐으로 되돌린다");
  assert.equal(ui.sessionMeta.orchestrator.enabled, false, "저장된 설정도 바뀌지 않았다");
});

test("AI끼리 계속 부르기 체크를 바꾸면 keepCallingSet을 부른다(오케스트레이터 켜짐과 무관)", async () => {
  const { ui, calls } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" }, keepCalling: false }
  );
  ui.chkKeepCalling.checked = true;
  ui.chkKeepCalling.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.keepCallingSet, [["room-a", true]]);
});

test("상태 줄: 오케스트레이션이 없으면 숨고, 있으면 지휘 AI·라운드·실행 횟수를 보인다", () => {
  const { ui } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.hidden, true);

  ui.orchestration = { active: true, round: 2, executions: 5, leadId: "claude" };
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.hidden, false);
  assert.equal(ui.orchestrationStatusRow.textContent, "오케스트레이터 · @claude · 라운드 2 · 실행 5회");

  ui.orchestration = null;
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.hidden, true);
  assert.equal(ui.orchestrationStatusRow.textContent, "");
});

test("상태 줄: 승인 대기·질문 대기면 라운드·실행 횟수 옆에 일시 정지를 덧붙인다(지휘 AI·작업자 몫만)", () => {
  const { ui } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  ui.orchestration = { active: true, round: 1, executions: 1, leadId: "claude", agentIds: ["claude", "agy"] };

  ui.approvalQueue.push({ sessionId: "room-a", agentId: "claude" });
  ui.renderOrchestrationStatus();
  assert.match(ui.orchestrationStatusRow.textContent, /일시 정지\(승인 대기\)$/);
  ui.approvalQueue.length = 0;

  ui.questionCards = { isWaiting: (id) => id === "agy" };
  ui.renderOrchestrationStatus();
  assert.match(ui.orchestrationStatusRow.textContent, /일시 정지\(질문 대기\)$/);
});

test("상태 줄: 오케스트레이션과 무관한 곁가지 대화(@other)의 승인·질문은 일시 정지로 세지 않는다", () => {
  // 적대적 검토 발견(review-behaviour, major): waitingApproval이 sessionId만 보고 agentId를 보지
  // 않아, 직접 @codex로 건 무관한 대화의 승인 카드가 claude 하나만 지휘하는 오케스트레이션을
  // "일시 정지"로 잘못 보이게 했다. agentIds 범위로 좁혀 고친 것을 이 시험이 지킨다.
  const { ui } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  ui.orchestration = { active: true, round: 1, executions: 2, leadId: "claude", agentIds: ["claude"] };

  ui.approvalQueue.push({ sessionId: "room-a", agentId: "codex" });
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.textContent, "오케스트레이터 · @claude · 라운드 1 · 실행 2회");
  ui.approvalQueue.length = 0;

  ui.questionCards = { isWaiting: (id) => id === "codex" };
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.textContent, "오케스트레이터 · @claude · 라운드 1 · 실행 2회");
});

test("실시간 구독: 지금 방 것만 받고, 다른 방 알림은 무시한다(방마다 따로 보인다)", () => {
  const { ui, handlers } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  handlers.orchestration({ sessionId: "room-b", orchestration: { active: true, round: 9, executions: 9, leadId: "claude" } });
  assert.equal(ui.orchestration, null, "다른 방 알림은 반영하지 않는다");
  assert.equal(ui.orchestrationStatusRow.hidden, true);

  handlers.orchestration({ sessionId: "room-a", orchestration: { active: true, round: 1, executions: 2, leadId: "claude" } });
  assert.deepEqual(ui.orchestration, { active: true, round: 1, executions: 2, leadId: "claude" });
  assert.equal(ui.orchestrationStatusRow.hidden, false);

  handlers.orchestration({ sessionId: "room-a", orchestration: null });
  assert.equal(ui.orchestration, null, "끝나면 다시 숨는다");
  assert.equal(ui.orchestrationStatusRow.hidden, true);
});

test("meta 구독: 요청자 없이 meta가 바뀌어도(지휘 AI 자동 꺼짐 등) 지금 방이면 sessionMeta를 새로 받는다", () => {
  // review-behaviour 발견(major): refreshRoomAgents가 meta를 되돌려도 chat:agents emit만 나가 머리줄
  // 칩이 낡은 "오케스트레이터 켜짐"에 멈춰 있었다. onMeta 구독이 생겼는지 확인한다.
  const { ui, handlers } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  handlers.meta({ sessionId: "room-b", meta: { orchestrator: { enabled: false, leadId: null } } });
  assert.deepEqual(ui.sessionMeta.orchestrator, { enabled: true, leadId: "claude" }, "다른 방 meta는 반영하지 않는다");

  handlers.meta({ sessionId: "room-a", meta: { orchestrator: { enabled: false, leadId: null } } });
  assert.deepEqual(ui.sessionMeta.orchestrator, { enabled: false, leadId: null }, "지금 방 meta는 바로 반영한다");
});

// 방을 새로고침·재선택해도 room.orchestrationSnapshot()이 그대로 다시 오므로(설계 §(5)),
// applyFullState가 매번 이 스냅숏으로 orchestration을 맞춘다는 것을 소스에서 확인한다
// (applyFullState 전체를 돌리려면 renderProjects·renderAgents 등 상관없는 의존이 너무 많다).
test("새로고침·방 재선택: applyFullState가 그 방의 오케스트레이션 스냅숏으로 다시 맞춘다", () => {
  assert.match(source, /orchestration = full\.session\?\.orchestration \|\| null;/);
  assert.match(
    source,
    /orchestration = full\.session\?\.orchestration \|\| null;[\s\S]{0,200}if \(full\.session\) \{/
  );
});

// chat:sessions-changed처럼 applyFullState 없이 switchActiveSession만 부르는 경로에서도
// 이전 방의 라운드·실행 횟수가 새지 않아야 한다(room-isolation-ui.test.js와 같은 방식).
test("방을 옮기면(스냅숏 없이도) 이전 방의 라운드·실행 횟수가 새 방에 새지 않는다", () => {
  const context = {
    activeSessionId: "room-a",
    orchestration: { active: true, round: 3, executions: 7, leadId: "claude" },
    composerDrafts: new Map(),
    composerInput: { value: "" },
    closePopover() {}, closeMentionPopup() {}, settleConfirm() {}, parkApproval() {}, autoresize() {},
  };
  vm.createContext(context);
  vm.runInContext(section("function switchActiveSession(", "function syncComposerLock("), context);
  context.switchActiveSession("room-b");
  assert.equal(context.orchestration, null, "이전 방(room-a)의 스냅숏이 room-b로 넘어가면 안 된다");
});

test("오케스트레이터 켜짐: 입력창 위 'AI끼리 계속 부르기' 체크는 흐려지지 않는다(지휘 AI·작업자 호출에는 적용되지 않지만, 곁가지 대화 멘션 연쇄에는 그대로 적용되므로)", () => {
  const html = read("src/chat.html");
  assert.match(html, /id="chk-keep-calling"/);
  assert.doesNotMatch(html, /id="chk-keep-calling"[^>]*disabled/);
  assert.match(html, /id="keep-calling-toggle"[\s\S]{0,40}title="[^"]*오케스트레이터[^"]*지휘 AI[^"]*작업자[^"]*적용되지 않고/);
});

test("오케스트레이터·AI끼리 계속 부르기 IPC 채널이 preload·main에서 일치한다", () => {
  const preload = read("src/chat-preload.js");
  const ipc = read("src/chat/chat-ipc.js");
  assert.match(preload, /ORCHESTRATOR_SET: "chat:orchestrator:set"/);
  assert.match(preload, /KEEP_CALLING_SET: "chat:keep-calling:set"/);
  assert.match(
    preload,
    /orchestratorSet: \(sessionId, enabled, leadId, lead = \{\}\) =>\s*ipcRenderer\.invoke\(INVOKE\.ORCHESTRATOR_SET, \{\s*sessionId,\s*enabled,\s*leadId,/
  );
  assert.match(
    preload,
    /keepCallingSet: \(sessionId, enabled\) =>\s*ipcRenderer\.invoke\(INVOKE\.KEEP_CALLING_SET, \{ sessionId, enabled \}\)/
  );
  assert.match(preload, /onOrchestration: \(handler\) => subscribe\("chat:orchestration", handler\)/);
  assert.match(ipc, /ipcMain\.handle\(\s*"chat:orchestrator:set"/);
  assert.match(ipc, /ipcMain\.handle\(\s*"chat:keep-calling:set"/);
});

test("머리줄에 [오케스트레이터] 칩이 있고, 입력창 위 체크·상태 줄 자리가 있다", () => {
  const html = read("src/chat.html");
  assert.match(html, /id="btn-orchestrator"[\s\S]{0,300}>오케스트레이터</);
  assert.match(html, /id="orchestration-status-row"/);
  assert.match(html, /id="keep-calling-toggle"/);
});

// ─── 지휘 모델·노력·읽기 전용(2026-10-20) ───────────────────────

const PROVIDERS = () => [
  {
    id: "claude",
    efforts: ["medium", "high"],
    modelOptions: [
      { id: "default", label: "공급자 기본값", efforts: [] },
      { id: "opus", label: "Opus", efforts: ["high", "max"] },
      { id: "sonnet", label: "Sonnet", efforts: ["medium", "high"] },
    ],
  },
  { id: "codex", efforts: ["high"], modelOptions: [{ id: "gpt-6.1-sol", label: "Sol", efforts: ["high"] }] },
];
const LEAD_AGENTS = () => [
  { id: "claude", name: "Claude", available: true, enabled: true, model: "sonnet" },
  { id: "codex", name: "Codex", available: true, enabled: true, model: "gpt-6.1-sol" },
];
const selectsOf = (popover) => popover.findAll((node) => node.tagName === "SELECT");
const flush = () => new Promise((resolve) => setImmediate(resolve));
// vm 컨텍스트 안에서 만든 객체는 프로토타입이 달라 deepEqual이 구조가 같아도 실패한다.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("지휘 모델 칸: 첫 선택지는 '참가자 설정 그대로'고, 지휘 AI 공급자의 모델·노력 목록이 이어진다", () => {
  const { ui, popover } = loadOrchestratorBlock(LEAD_AGENTS(), { orchestrator: { enabled: false, leadId: null } }, PROVIDERS());
  ui.openOrchestratorPopover({});
  const [lead, model, effort] = selectsOf(popover);
  assert.deepEqual(model.children.map((option) => option.value), ["", "opus", "sonnet"], "default는 빠진다");
  assert.equal(model.children[0].textContent, "참가자 설정 그대로");
  assert.equal(model.value, "");
  assert.deepEqual(effort.children.map((option) => option.value), ["", "medium", "high"], "모델을 안 고르면 참가자의 현재 모델(sonnet) 기준");
  assert.equal(lead.value, "claude");
});

test("지휘 모델 칸: 저장된 지휘 모델·노력·읽기 전용을 그대로 보여 준다", () => {
  const meta = { permissionMode: "workspace-write", orchestrator: { enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max", leadReadOnly: true } };
  const { ui, popover } = loadOrchestratorBlock(LEAD_AGENTS(), meta, PROVIDERS());
  ui.openOrchestratorPopover({});
  const [, model, effort] = selectsOf(popover);
  assert.equal(model.value, "opus");
  assert.deepEqual(effort.children.map((option) => option.value), ["", "high", "max"]);
  assert.equal(effort.value, "max");
  const readOnly = popover.findAll((node) => node.tagName === "INPUT" && node.type === "checkbox")[1];
  assert.equal(readOnly.checked, true);
  assert.equal(readOnly.disabled, false);
});

test("지휘 모델을 고르면 켜진 상태에서 그 값을 orchestratorSet에 실어 보내고, 노력 목록이 그 모델 기준으로 바뀐다", async () => {
  const meta = { orchestrator: { enabled: true, leadId: "claude" } };
  const { ui, popover, calls } = loadOrchestratorBlock(LEAD_AGENTS(), meta, PROVIDERS());
  ui.openOrchestratorPopover({});
  const [, model, effort] = selectsOf(popover);
  model.value = "opus";
  model.dispatch("change");
  await flush();
  assert.deepEqual(effort.children.map((option) => option.value), ["", "high", "max"]);
  assert.deepEqual(plain(calls.orchestratorLead.at(-1)), { leadModel: "opus", leadEffort: null, leadReadOnly: false });
  assert.equal(ui.sessionMeta.orchestrator.leadModel, "opus");
  effort.value = "max";
  effort.dispatch("change");
  await flush();
  assert.deepEqual(plain(calls.orchestratorLead.at(-1)), { leadModel: "opus", leadEffort: "max", leadReadOnly: false });
  assert.deepEqual(ui.sessionMeta.orchestrator, { enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max" });
});

test("지휘 AI를 바꾸면 모델·노력 선택이 비워지고 새 공급자의 목록으로 바뀐다", async () => {
  const meta = { orchestrator: { enabled: true, leadId: "claude", leadModel: "opus", leadEffort: "max" } };
  const { ui, popover, calls } = loadOrchestratorBlock(LEAD_AGENTS(), meta, PROVIDERS());
  ui.openOrchestratorPopover({});
  const [lead, model, effort] = selectsOf(popover);
  lead.value = "codex";
  lead.dispatch("change");
  await flush();
  assert.deepEqual(model.children.map((option) => option.value), ["", "gpt-6.1-sol"]);
  assert.equal(model.value, "");
  assert.equal(effort.value, "");
  assert.deepEqual(plain(calls.orchestratorLead.at(-1)), { leadModel: null, leadEffort: null, leadReadOnly: false });
  assert.deepEqual(ui.sessionMeta.orchestrator, { enabled: true, leadId: "codex" });
});

test("읽기 전용 토글: 쓰기 권한 방에서만 켤 수 있고, 켜면 leadReadOnly를 보낸다", async () => {
  const noWrite = loadOrchestratorBlock(LEAD_AGENTS(), { permissionMode: "chat", orchestrator: { enabled: true, leadId: "claude" } }, PROVIDERS());
  noWrite.ui.openOrchestratorPopover({});
  assert.equal(noWrite.popover.findAll((node) => node.tagName === "INPUT" && node.type === "checkbox")[1].disabled, true);

  const write = loadOrchestratorBlock(LEAD_AGENTS(), { permissionMode: "workspace-write", orchestrator: { enabled: true, leadId: "claude" } }, PROVIDERS());
  write.ui.openOrchestratorPopover({});
  write.popover.findAll((node) => node.tagName === "INPUT" && node.type === "checkbox")[1].click();
  await flush();
  assert.equal(write.calls.orchestratorLead.at(-1).leadReadOnly, true);
  assert.equal(write.ui.sessionMeta.orchestrator.leadReadOnly, true);
});

test("꺼진 상태에서 지휘 모델을 고르면 저장하지 않고, 사용을 켤 때 함께 보낸다", async () => {
  const { ui, popover, calls } = loadOrchestratorBlock(LEAD_AGENTS(), { orchestrator: { enabled: false, leadId: null } }, PROVIDERS());
  ui.openOrchestratorPopover({});
  const [, model] = selectsOf(popover);
  model.value = "opus";
  model.dispatch("change");
  await flush();
  assert.equal(calls.orchestratorSet.length, 0);
  popover.find((node) => node.tagName === "INPUT" && node.type === "checkbox").click();
  await flush();
  assert.deepEqual(plain(calls.orchestratorLead.at(-1)), { leadModel: "opus", leadEffort: null, leadReadOnly: false });
});

test("칩: 지휘 모델을 정했으면 괄호로 함께 보이고, 상태 줄은 단계 중일 때만 k/n단계를 덧붙인다", () => {
  const header = loadHeaderBits();
  header.sessionMeta = { orchestrator: { enabled: true, leadId: "claude", leadModel: "opus" } };
  header.renderHeaderOrchestratorBits();
  assert.equal(header.orchestratorChip.textContent, "오케스트레이터 · @claude(opus)");

  const { ui } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  ui.orchestration = { active: true, round: 2, executions: 4, leadId: "claude", stage: { index: 2, total: 3, agentIds: ["codex"] } };
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.textContent, "오케스트레이터 · @claude · 라운드 2 · 실행 4회 · 2/3단계");
  ui.orchestration = { active: true, round: 3, executions: 5, leadId: "claude", stage: null };
  ui.renderOrchestrationStatus();
  assert.equal(ui.orchestrationStatusRow.textContent, "오케스트레이터 · @claude · 라운드 3 · 실행 5회");
});

