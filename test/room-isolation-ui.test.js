"use strict";

// 대화방을 오가는 동안 화면 상태가 방끼리 섞이지 않는지 확인한다. 실제 렌더러
// 함수를 격리된 컨텍스트에서 돌리고 DOM·IPC만 대체한다. IPC 응답 순서는 각
// 테스트가 직접 정해, 방을 옮긴 뒤 늦게 도착하는 응답을 재현한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src", "chat.js"), "utf8");
const MODE_KEY = "agora.chat.professionalModeRooms";

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "구간을 찾지 못했습니다: " + start);
  return source.slice(from, to);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function loadRoom(storage = new Map()) {
  const requests = [];
  const pending = (name) => (...args) => {
    const request = deferred();
    requests.push({ name, args, ...request });
    return request.promise;
  };
  const applied = [];
  const context = {
    activeSessionId: null,
    sessionMeta: null,
    professionalModeEnabled: false,
    specialistRunning: false,
    specialistActive: false,
    specialistResumeAvailable: false,
    specialistBlockedAvailable: false,
    specialistNeedsInput: false,
    specialistNode: null,
    pendingAttachments: [],
    isIndependentResponseMode: false,
    sessionMetaRequest: 0,
    composerDrafts: new Map(),
    PROFESSIONAL_MODE_ROOMS_KEY: MODE_KEY,
    composerInput: { value: "", style: {}, focus() {} },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    window: {
      chatApi: {
        specialistStart: pending("specialistStart"),
        send: pending("send"),
        specialistPlanAnswer: pending("specialistPlanAnswer"),
        agentConfigure: pending("agentConfigure"),
        permissionSet: pending("permissionSet"),
      },
    },
    setSpecialistState: (state) => applied.push(state),
    specialistLocksComposer: () => false,
    currentProfessionalPolicy: () => ({}),
    confirmInApp: async () => true,
    resetSpecialistApprovals() {}, renderSpecialistApprovals() {}, closeSpecialistDialog() {},
    closePopover() {}, closeMentionPopup() {}, settleConfirm() {}, autoresize() {},
    renderHeader() {}, syncComposerLock() {}, renderPendingAttachments() {}, flashNotice() {},
  };
  vm.createContext(context);
  vm.runInContext([
    section("async function call(", "// --- 세션 사이드바 ---"),
    section("function readProfessionalModeRooms(", "// 전문 실행이 실제로 돌거나"),
    section("function professionalRunBusy(", "function specialistLocksComposer("),
    section("async function configureAgent(", "const WORKFLOW_STATUS_LABELS"),
    section("async function runProfessionalAction(", "// 구현이 막혔을 때"),
    section("async function sendCurrentMessage(", 'composerInput.addEventListener("input"'),
  ].join("\n"), context);
  context.professionalModeRooms = context.readProfessionalModeRooms();
  // applyFullState가 방을 옮길 때 하는 일: 방 전환 뒤 그 방의 상태를 채운다.
  const enter = (sessionId, room = {}) => {
    context.switchActiveSession(sessionId);
    context.sessionMeta = room.meta || { id: sessionId };
    context.specialistActive = Boolean(room.active);
    context.pendingAttachments = room.pendingAttachments || [];
  };
  return { ui: context, requests, applied, storage, enter };
}

test("방마다 고른 모드를 기억하고, 새 방은 일반 모드로 시작한다", () => {
  const { ui, storage, enter } = loadRoom();
  enter("room-a");
  assert.equal(ui.professionalModeEnabled, false, "새 방은 일반 모드입니다");
  ui.setProfessionalMode(true);
  enter("room-b");
  assert.equal(ui.professionalModeEnabled, false, "전문 모드가 다른 방으로 따라가면 안 됩니다");
  enter("room-a");
  assert.equal(ui.professionalModeEnabled, true);

  // 앱을 다시 켜도 방별 선택이 남는다.
  const restarted = loadRoom(storage);
  restarted.enter("room-a");
  assert.equal(restarted.ui.professionalModeEnabled, true);
  restarted.ui.setProfessionalMode(false);
  restarted.enter("room-b");
  restarted.enter("room-a");
  assert.equal(restarted.ui.professionalModeEnabled, false);

  // 삭제한 방의 기록은 지운다.
  restarted.ui.setProfessionalMode(true);
  restarted.ui.forgetRoom("room-a");
  assert.deepEqual(JSON.parse(storage.get(MODE_KEY)), []);
});

test("방을 옮기면 쓰던 글이 그 방에 남는다", () => {
  const { ui, enter } = loadRoom();
  enter("room-a");
  ui.composerInput.value = "A에서 쓰던 글";
  enter("room-b");
  assert.equal(ui.composerInput.value, "", "다른 방의 글이 따라오면 안 됩니다");
  ui.composerInput.value = "B에서 쓰던 글";
  enter("room-a");
  assert.equal(ui.composerInput.value, "A에서 쓰던 글");
  enter("room-b");
  assert.equal(ui.composerInput.value, "B에서 쓰던 글");
});

test("다른 방으로 옮긴 뒤 도착한 전문 실행 응답은 지금 방을 바꾸지 않는다", async () => {
  const { ui, requests, applied, enter } = loadRoom();
  enter("room-a");
  ui.setProfessionalMode(true);
  const started = ui.runProfessionalAction("plan");
  assert.equal(requests[0].args[0], "room-a");
  enter("room-b");
  assert.equal(ui.specialistRunning, false, "이전 방의 시작 표시가 새 방 버튼을 막으면 안 됩니다");
  requests[0].resolve({
    meta: { id: "room-a", late: true },
    specialist: { active: true, node: "PLANNING", status: "RUNNING" },
  });
  await started;
  assert.equal(applied.length, 0, "이전 방의 실행 상태를 지금 방에 적용하면 안 됩니다");
  assert.deepEqual(ui.sessionMeta, { id: "room-b" });
  assert.equal(ui.professionalModeEnabled, false);
  assert.equal(ui.specialistActive, false);
});

test("전송 실패는 보낸 방의 글로 돌아가고, 그사이 쓴 글을 지우지 않는다", async () => {
  const { ui, requests, enter } = loadRoom();
  enter("room-a", { pendingAttachments: [{ id: "file-a" }] });
  ui.composerInput.value = "A에서 보낸 글";
  const sent = ui.sendCurrentMessage();
  assert.equal(ui.composerInput.value, "");
  enter("room-b", { pendingAttachments: [{ id: "file-b" }] });
  ui.composerInput.value = "B에서 쓰는 글";
  requests[0].resolve({ ok: false, error: "전송 실패" });
  await sent;
  assert.equal(ui.composerInput.value, "B에서 쓰는 글");
  assert.deepEqual(ui.pendingAttachments.map((item) => item.id), ["file-b"]);
  enter("room-a");
  assert.equal(ui.composerInput.value, "A에서 보낸 글");

  // 같은 방에서 새로 쓴 글이 있으면 실패한 글을 앞에 붙여 둘 다 남긴다.
  ui.composerInput.value = "첫 글";
  const again = ui.sendCurrentMessage();
  ui.composerInput.value = "이어서 쓴 글";
  requests[1].resolve({ ok: false, error: "전송 실패" });
  await again;
  assert.equal(ui.composerInput.value, "첫 글\n이어서 쓴 글");
});

test("전송 성공은 보낸 첨부만 빼고, 다른 방의 첨부는 건드리지 않는다", async () => {
  const { ui, requests, enter } = loadRoom();
  enter("room-a", { pendingAttachments: [{ id: "file-a" }] });
  ui.composerInput.value = "첨부와 함께";
  const sent = ui.sendCurrentMessage();
  ui.pendingAttachments = [...ui.pendingAttachments, { id: "file-later" }];
  requests[0].resolve({ consult: false });
  await sent;
  assert.deepEqual(ui.pendingAttachments.map((item) => item.id), ["file-later"]);

  ui.composerInput.value = "다시";
  const second = ui.sendCurrentMessage();
  enter("room-b", { pendingAttachments: [{ id: "file-b" }] });
  requests[1].resolve({ consult: false });
  await second;
  assert.deepEqual(ui.pendingAttachments.map((item) => item.id), ["file-b"]);
});

test("늦게 온 설정 응답은 다른 방이나 더 최신 설정을 덮지 않는다", async () => {
  const { ui, requests, enter } = loadRoom();
  enter("room-a", { meta: { id: "room-a", version: 0 } });
  const older = ui.configureAgent("claude", { model: "old" });
  const newer = ui.configureAgent("claude", { model: "new" });
  requests[1].resolve({ meta: { id: "room-a", version: 2 } });
  await newer;
  requests[0].resolve({ meta: { id: "room-a", version: 1 } });
  const olderResult = await older;
  assert.equal(ui.sessionMeta.version, 2, "먼저 보낸 요청의 응답이 최신 설정을 덮으면 안 됩니다");
  assert.equal(olderResult.meta.version, 1, "저장 결과는 호출한 쪽에 그대로 돌려줍니다");

  const permission = ui.requestSessionMeta((sessionId) => ui.window.chatApi.permissionSet(sessionId, "workspace-write"));
  assert.equal(requests[2].args[0], "room-a");
  enter("room-b");
  requests[2].resolve({ meta: { id: "room-a", permissionMode: "workspace-write" } });
  await permission;
  assert.deepEqual(ui.sessionMeta, { id: "room-b" });
});

test("채팅 창의 확인은 운영체제 확인창 대신 창 안에서 받는다", async () => {
  assert.doesNotMatch(source, /window\.confirm\(/);
  const html = fs.readFileSync(path.join(ROOT, "src", "chat.html"), "utf8");
  assert.match(html, /id="confirm-backdrop"[\s\S]*id="confirm-cancel"[\s\S]*id="confirm-ok"/);

  const element = () => ({
    hidden: true, textContent: "", listeners: {}, focused: 0, isConnected: true,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    focus() { this.focused += 1; },
  });
  const trigger = element();
  const context = {
    confirmResolve: null,
    confirmBackdrop: element(), confirmMessage: element(), confirmOk: element(), confirmCancel: element(),
    document: { activeElement: trigger },
  };
  vm.createContext(context);
  vm.runInContext(section("function confirmInApp(", "// 모델 팝오버는 바깥 클릭이"), context);

  const first = context.confirmInApp("삭제할까요?");
  assert.equal(context.confirmBackdrop.hidden, false);
  assert.equal(context.confirmMessage.textContent, "삭제할까요?");
  assert.equal(context.confirmCancel.focused, 1, "기본 초점은 취소 버튼입니다");
  context.confirmOk.listeners.click();
  assert.equal(await first, true);
  assert.equal(context.confirmBackdrop.hidden, true);
  assert.equal(trigger.focused, 1, "닫히면 누른 버튼으로 초점을 돌려줍니다");

  let stopped = 0;
  const escaped = context.confirmInApp("취소할까요?");
  context.confirmBackdrop.listeners.keydown({ key: "Escape", stopPropagation() { stopped += 1; } });
  assert.equal(await escaped, false);
  assert.equal(stopped, 1, "Escape가 창 전체 단축키로 번지면 안 됩니다");

  // 새 확인이 열리면 앞의 확인은 취소로 끝난다(두 약속이 동시에 남지 않는다).
  const replaced = context.confirmInApp("첫 번째");
  const current = context.confirmInApp("두 번째");
  assert.equal(await replaced, false);
  context.confirmBackdrop.listeners.click({ target: context.confirmBackdrop });
  assert.equal(await current, false);
});
