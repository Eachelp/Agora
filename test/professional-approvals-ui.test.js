"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

// 실제 렌더러 함수와 버튼 이벤트를 실행한다. DOM·IPC만 대체하므로 Electron이나
// CLI 프로세스를 시작하지 않는다. 응답 순서는 각 테스트가 직접 제어한다.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function waiting(overrides = {}) {
  return {
    available: true, phase: "ACT", resumePhase: "awaiting_human_approval",
    node: "REVIEWING", status: "WAITING", frozenRunId: "run-a",
    stopReason: "HUMAN_APPROVAL_REQUIRED", ...overrides,
  };
}

function item(id, statement = id) { return { criterionId: id, statement, reasons: [] }; }

function loadUI() {
  const reads = [];
  const resolutions = [];
  const resumes = [];
  const context = {
    activeSessionId: "session-a", sessionMeta: {},
    specialistActive: false, specialistResumeAvailable: false,
    specialistBlockedAvailable: false, specialistResumePhase: null,
    specialistNeedsInput: false, specialistPlanReady: false,
    specialistNode: null, specialistStatus: null, specialistStopReason: null,
    specialistPlanTaskPath: null, specialistPlanTaskId: null,
    specialistCheckpointProtection: null, specialistCanRestore: false,
    specialistPlanRound: 0, specialistImplementationRound: 0,
    specialistFrozenRunId: null, specialistMissingSections: null,
    specialistPendingApprovals: [], specialistApprovalContext: null,
    specialistApprovalRequest: 0, specialistApprovalsLoading: false,
    specialistApprovalsError: "", specialistApprovalsBusy: false,
    professionalModeEnabled: false, professionalRunWasLive: false,
    // 막힘 선택지 패널(상태 줄 아래)은 이 테스트의 관심사가 아니다 — DOM 없이 돌린다.
    specialistBlockInfo: null, specialistBlockFetch: "idle",
    refreshBlockInfo: () => {}, renderProfessionalBlocked: () => {},
    specialistApprovalsBar: new Element("div"),
    document: { createElement: (tag) => new Element(tag) },
    window: {
      confirm: () => true,
      chatApi: {
        specialistPendingApprovals: (sessionId) => {
          const request = deferred();
          reads.push({ sessionId, ...request });
          return request.promise;
        },
        specialistResolveApproval: (...args) => {
          const request = deferred();
          resolutions.push({ args, ...request });
          return request.promise;
        },
        specialistResume: (...args) => {
          const request = deferred();
          resumes.push({ args, ...request });
          return request.promise;
        },
      },
    },
    call: async (promise) => {
      try { const result = await promise; return result?.ok === false ? null : result; }
      catch { return null; }
    },
    flashNotice: () => {}, renderHeader: () => {},
    syncComposerLock: () => context.renderSpecialistApprovals(),
    SPECIALIST_CHOICES: {}, openSpecialistDialog: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    section("function setSpecialistState(", "function specialistLocksComposer("),
    section("function specialistChoicesNow(", "function renderSpecialistChoice("),
    section("function awaitingHumanApproval(", "function doctorStatus("),
    section("async function replanBlocked(", "async function resolveBlocked("),
  ].join("\n"), context);
  function descendants(element = context.specialistApprovalsBar) {
    return [element, ...element.children.flatMap((child) => descendants(child))];
  }
  return {
    ui: context, reads, resolutions, resumes,
    buttons: () => descendants().filter((el) => el.tag === "button"),
    text: () => descendants().map((el) => el.textContent || "").join(" "),
  };
}

test("대화를 바꾸면 이전 승인 항목과 버튼이 즉시 무효화된다", async () => {
  const { ui, reads, resolutions, buttons, text } = loadUI();
  ui.setSpecialistState(waiting());
  reads[0].resolve({ runId: "run-a", pending: [item("V1", "A 대화의 발송 승인")] });
  await settle();
  const oldApprove = buttons()[0];
  ui.activeSessionId = "session-b";
  ui.setSpecialistState(waiting({ frozenRunId: "run-b" }));
  assert.equal(ui.specialistPendingApprovals.length, 0);
  assert.doesNotMatch(text(), /A 대화의 발송 승인/);
  await oldApprove.listeners.click();
  assert.equal(resolutions.length, 0, "이전 버튼은 새 대화의 같은 V1을 승인하면 안 된다");
  reads[1].resolve({ runId: "run-b", pending: [item("V1", "B 대화의 검토 승인")] });
  await settle();
  assert.match(text(), /B 대화의 검토 승인/);
  const previousRunApprove = buttons()[0];
  ui.setSpecialistState(waiting({ frozenRunId: "run-b-new" }));
  await previousRunApprove.listeners.click();
  assert.equal(resolutions.length, 0, "같은 대화의 새 실행에도 이전 승인을 적용하면 안 된다");
});

test("같은 대화로 돌아와도 이전 방문에서 시작한 조회는 현재 목록을 덮지 않는다", async () => {
  const { ui, reads, text } = loadUI();
  ui.setSpecialistState(waiting());
  ui.activeSessionId = "session-b";
  ui.setSpecialistState(waiting({ frozenRunId: "run-b" }));
  ui.activeSessionId = "session-a";
  ui.setSpecialistState(waiting());
  reads[2].resolve({ runId: "run-a", pending: [item("V2", "현재 항목")] });
  await settle();
  reads[0].resolve({ runId: "run-a", pending: [item("V1", "처리 전 항목")] });
  reads[1].resolve({ runId: "run-b", pending: [item("V3", "다른 대화 항목")] });
  await settle();
  assert.match(text(), /현재 항목/);
  assert.doesNotMatch(text(), /처리 전 항목|다른 대화 항목/);
});

test("같은 실행의 조회가 역순으로 끝나도 마지막 요청의 목록만 반영한다", async () => {
  const { ui, reads } = loadUI();
  ui.setSpecialistState(waiting());
  const latest = ui.refreshPendingApprovals();
  reads[1].resolve({ runId: "run-a", pending: [item("V2")] });
  await latest;
  reads[0].resolve({ runId: "run-a", pending: [item("V1"), item("V2")] });
  await settle();
  assert.equal(ui.specialistPendingApprovals.length, 1);
  assert.equal(ui.specialistPendingApprovals[0].criterionId, "V2");
});

test("처리 중 다른 항목 클릭과 상태 이벤트가 오래된 목록을 다시 제출하지 않는다", async () => {
  const { ui, reads, resolutions, buttons } = loadUI();
  ui.setSpecialistState(waiting());
  reads[0].resolve({ runId: "run-a", pending: [item("V1"), item("V2")] });
  await settle();
  const [first, , second] = buttons();
  const approved = first.listeners.click();
  await second.listeners.click();
  ui.setSpecialistState(waiting());
  assert.equal(resolutions.length, 1);
  assert.equal(reads.length, 1, "승인 응답보다 먼저 상태 이벤트가 와도 중복 조회하지 않는다");
  assert.ok(buttons().every((button) => button.disabled));
  assert.deepEqual(resolutions[0].args, ["session-a", "V1", true, null, "run-a"]);
  resolutions[0].resolve({ pending: [item("V2")], resumable: false, specialist: waiting() });
  await approved;
  assert.equal(ui.specialistPendingApprovals.length, 1);
  assert.equal(ui.specialistPendingApprovals[0].criterionId, "V2");
  assert.ok(buttons().every((button) => !button.disabled));
});

test("승인 직후 자동 재개가 실패해도 기록을 다시 이어갈 버튼이 남는다", async () => {
  const { ui, reads, resolutions, resumes, buttons } = loadUI();
  ui.setSpecialistState(waiting());
  reads[0].resolve({ runId: "run-a", pending: [item("V1")] });
  await settle();
  const approved = buttons()[0].listeners.click();
  const readyToRecord = waiting({ resumePhase: "review_pass" });
  // 실제 IPC처럼 상태 이벤트가 승인 응답보다 먼저 도착한다.
  ui.setSpecialistState(readyToRecord);
  resolutions[0].resolve({ pending: [], resumable: true, specialist: readyToRecord });
  await settle();
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].args, ["session-a", undefined, "run-a"]);
  resumes[0].resolve({ ok: false, error: "같은 작업 폴더를 다른 실행이 사용 중입니다." });
  await approved;
  assert.equal(ui.awaitingHumanApproval(), false, "남은 stopReason으로 승인 대기에 갇히면 안 된다");
  assert.equal(buttons()[0].textContent, "기록 이어서 진행");
  assert.equal(buttons()[0].disabled, false);
  const retry = buttons()[0].listeners.click();
  assert.equal(resumes.length, 2);
  resumes[1].resolve({ specialist: { node: "COMPLETED", status: "COMPLETED", frozenRunId: "run-a" } });
  await retry;
  assert.equal(ui.specialistNode, "COMPLETED");
  assert.equal(ui.specialistApprovalsBar.hidden, true);
});

test("마지막 항목을 거부하면 승인 패널 대신 기존 복구 선택이 열린다", async () => {
  const { ui, reads, resolutions, resumes, buttons } = loadUI();
  ui.setSpecialistState(waiting());
  reads[0].resolve({ runId: "run-a", pending: [item("V1")] });
  await settle();
  const rejected = buttons()[1].listeners.click();
  resolutions[0].resolve({ pending: [], resumable: false, specialist: waiting({
    blocked: true, status: "BLOCKED", stopReason: "ASSURANCE_BLOCKED", available: false, resumePhase: null,
  }) });
  await rejected;
  assert.equal(resumes.length, 0);
  assert.equal(ui.specialistApprovalsBar.hidden, true);
  // 복구 선택은 전문 모드에서는 상태 줄 아래 패널(#professional-blocked)이, 일반
  // 모드에서는 입력창 옆 칩이 맡는다. 실행이 살아나면 화면이 전문 모드로 켜지므로
  // 여기서는 패널 쪽이다 — 칩은 일반 모드로 내려왔을 때만 나타난다.
  assert.equal(ui.specialistBlockedAvailable, true);
  assert.equal(ui.specialistChoicesNow(), null, "전문 모드에서는 칩 대신 상태 줄 아래 패널이 맡는다");
  ui.professionalModeEnabled = false;
  assert.equal(ui.specialistChoicesNow()[0].label, "다음 처리 선택");
});

test("실행이 바뀐 조회 응답과 조회 실패는 승인 대신 다시 불러오기를 제공한다", async () => {
  const { ui, reads, buttons, text } = loadUI();
  ui.setSpecialistState(waiting());
  reads[0].resolve({ runId: "different-run", pending: [item("V1", "다른 실행 항목")] });
  await settle();
  assert.doesNotMatch(text(), /다른 실행 항목/);
  const retry = buttons()[0].listeners.click();
  reads[1].resolve({ ok: false, error: "목록 조회 실패" });
  await retry;
  assert.match(text(), /목록 조회 실패/);
  assert.equal(buttons()[0].textContent, "목록 다시 불러오기");
  assert.equal(buttons()[0].disabled, false);
});

test("승인 화면에서 벗어난 뒤 도착하는 응답은 패널을 다시 열지 않는다", async () => {
  const { ui, reads } = loadUI();
  ui.setSpecialistState(waiting());
  ui.setSpecialistState({ node: "COMPLETED", status: "COMPLETED", frozenRunId: "run-a" });
  reads[0].resolve({ runId: "run-a", pending: [item("V1")] });
  await settle();
  assert.equal(ui.specialistApprovalsBar.hidden, true);
  assert.equal(ui.specialistPendingApprovals.length, 0);
});

test("재기획 응답이 다시 막힌 상태면 화면이 복구 선택을 지우지 않는다", async () => {
  const { ui } = loadUI();
  ui.window.chatApi.specialistReplanBlocked = async () => ({ specialist: {
    blocked: true, node: "PLANNING", status: "BLOCKED", stopReason: "WORKFLOW_WRITE_FAILED",
  } });
  await ui.replanBlocked("keep");
  assert.equal(ui.specialistBlockedAvailable, true);
  // 복구 선택은 전문 모드에서는 상태 줄 아래 패널(#professional-blocked)이, 일반
  // 모드에서는 입력창 옆 칩이 맡는다. 실행이 살아나면 화면이 전문 모드로 켜지므로
  // 여기서는 패널 쪽이다 — 칩은 일반 모드로 내려왔을 때만 나타난다.
  assert.equal(ui.specialistBlockedAvailable, true);
  assert.equal(ui.specialistChoicesNow(), null, "전문 모드에서는 칩 대신 상태 줄 아래 패널이 맡는다");
  ui.professionalModeEnabled = false;
  assert.equal(ui.specialistChoicesNow()[0].label, "다음 처리 선택");
});
