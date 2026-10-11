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
function loadOrchestratorBlock(agents, initialMeta) {
  const calls = { orchestratorSet: [], keepCallingSet: [] };
  const popover = new FakeNode("div");
  const handlers = {};
  let sessionMeta = initialMeta;
  const context = {
    document: makeDocument(),
    agents,
    get sessionMeta() { return sessionMeta; },
    set sessionMeta(value) { sessionMeta = value; },
    orchestratorChip: new FakeNode("button"),
    chkKeepCalling: new FakeNode("input"),
    orchestrationStatusRow: Object.assign(new FakeNode("div"), { hidden: true }), // chat.html에서 처음에는 숨겨져 있다.
    orchestration: null,
    activeSessionId: "room-a",
    approvalQueue: [],
    activeApproval: null,
    questionCards: { hasPending: () => false },
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
    window: {
      chatApi: {
        orchestratorSet: async (sessionId, enabled, leadId) => {
          calls.orchestratorSet.push([sessionId, enabled, leadId]);
          if (enabled && leadId === context.orchestratorRejectLeadId) {
            return { ok: false, error: "지휘 AI로 쓸 수 있는 에이전트를 골라 주세요." };
          }
          sessionMeta = { ...sessionMeta, orchestrator: { enabled, leadId: enabled ? leadId : null } };
          return { ok: true, meta: sessionMeta };
        },
        keepCallingSet: async (sessionId, enabled) => {
          calls.keepCallingSet.push([sessionId, enabled]);
          sessionMeta = { ...sessionMeta, keepCalling: enabled };
          return { ok: true, meta: sessionMeta };
        },
        onOrchestration: (handler) => { handlers.orchestration = handler; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
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

test("상태 줄: 승인 대기·질문 대기면 라운드·실행 횟수 옆에 일시 정지를 덧붙인다", () => {
  const { ui } = loadOrchestratorBlock(
    [{ id: "claude", name: "Claude", available: true, enabled: true }],
    { orchestrator: { enabled: true, leadId: "claude" } }
  );
  ui.orchestration = { active: true, round: 1, executions: 1, leadId: "claude" };

  ui.approvalQueue.push({ sessionId: "room-a" });
  ui.renderOrchestrationStatus();
  assert.match(ui.orchestrationStatusRow.textContent, /일시 정지\(승인 대기\)$/);
  ui.approvalQueue.length = 0;

  ui.questionCards = { hasPending: () => true };
  ui.renderOrchestrationStatus();
  assert.match(ui.orchestrationStatusRow.textContent, /일시 정지\(질문 대기\)$/);
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
    /orchestratorSet: \(sessionId, enabled, leadId\) =>\s*ipcRenderer\.invoke\(INVOKE\.ORCHESTRATOR_SET, \{ sessionId, enabled, leadId \}\)/
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
