"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");
const { TaskManager } = require("../src/agora/task-manager");
const { createProfessionalRun } = require("../src/agora/professional-run");
const { serializeHandoffLedger, createHandoffLedger, consumeHandoff } = require("../src/agora/interaction-contract");

function makePlanContract(goal = "목표", extra = "") {
  return [
    "## Goal",
    goal,
    "## Requirements",
    "기능 요구사항",
    "## Implementation Approach",
    "구현 접근 방식",
    "## Acceptance Criteria",
    "완료 수용 기준",
    "## Verification",
    "검증 계획",
    "## Out of Scope",
    "제외 범위",
    extra,
    "STATUS: PLAN_READY",
  ].filter(Boolean).join("\n");
}

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

function fullStages(room) {
  return {
    planner: { agent: room.findAgent("claude") },
    implementation: { agent: room.findAgent("claude") },
    review: { agent: room.findAgent("codex") },
    recorder: { agent: room.findAgent("codex") },
  };
}

test("전체 실행에서 역할들의 HANDOFF 요청이 소비·기록되고 Archivist까지 이어진다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-handoff-full-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const journal = [];
  let persistedRun = null;
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    persistProfessionalRun: (run) => {
      persistedRun = run;
      return true;
    },
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
    readProfessionalEvents: () => journal.slice(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: `${makePlanContract("Handoff 전체 실행")}\n\nHANDOFF: @reviewer\nREASON: 계획 검증 필요` },
        { ok: true, text: "구현 완료\nSTATUS: DONE\n\nHANDOFF: @reviewer" },
      ],
      codex: [
        { ok: true, text: "기획 검수 통과\nVERDICT: PASS\n\nHANDOFF: @builder" },
        { ok: true, text: "구현 검수 통과\nVERDICT: PASS\n\nHANDOFF: @recorder" },
        { ok: true, text: "사람용 정리: 인증 모듈을 구현하고 검수를 통과했습니다." },
      ],
    }, calls),
  });
  // recordOnly로 root 사용자 발화만 남긴다(브로드캐스트 응답 예약 없음).
  room.sendUserMessage({ text: "로그인 기능을 구현해줘", recordOnly: true });

  const result = await room.startSpecialist({ action: "full", stages: fullStages(room) });

  assert.equal(result.ok, true);
  assert.equal(room.specialistState().node, "COMPLETED");
  // planner → plan_review → builder → review → archivist.
  // persistProfessionalRun이 있는 room의 recorder 단계는 deterministic
  // finalizer(Runtime)로 실행되므로 LLM 호출을 만들지 않는다.
  assert.deepEqual(
    calls.map((call) => call.agentId),
    ["claude", "codex", "claude", "codex", "codex"],
  );
  assert.equal(result.recorded, true);

  // 프롬프트에 routing 안내가 있고, Archivist 턴은 '기록 정리' 계약이다.
  assert.match(calls[0].prompt, /다음 역할 요청/);
  assert.match(calls[4].prompt, /전문 모드: 기록 정리/);
  assert.match(calls[4].prompt, /System Journal/);

  // 4개의 HANDOFF가 순서대로 수용됐다: reviewer → builder → reviewer → recorder.
  const accepted = journal.filter((event) => event.type === "HANDOFF_ACCEPTED");
  assert.deepEqual(
    accepted.map((event) => event.role),
    ["reviewer", "builder", "reviewer", "recorder"],
  );
  assert.equal(journal.some((event) => event.type === "HANDOFF_REJECTED"), false);

  // 원장 소비가 fail-closed 경로(professionalRun.handoffState)에 영속됐다.
  assert.ok(persistedRun?.handoffState);
  assert.equal(persistedRun.handoffState.used, 4);
  assert.equal(persistedRun.handoffState.lastTargetRole, "recorder");
  assert.ok(persistedRun.handoffState.rootMessageId, "root 사용자 발화가 기록돼야 합니다");

  // Archivist 실행 사실도 Journal에 남는다.
  const archivistEvents = journal.filter((event) => event.purpose === "archivist");
  assert.deepEqual(
    archivistEvents.map((event) => event.type),
    ["ROLE_STARTED", "ROLE_FINISHED"],
  );
  assert.equal(archivistEvents[1].status, "DONE");

  // 제어 블록은 표시 텍스트에서 벗겨진다.
  const agentMessages = room.messages.filter((message) => message.authorType === "agent");
  for (const message of agentMessages) {
    assert.ok(!/^HANDOFF:/m.test(message.text), "제어 줄이 화면 텍스트에 남으면 안 됩니다");
  }
});

test("결과와 어긋나는 제어(BLOCKED + COMPLETE)는 거부되고 기본 흐름이 유지된다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-handoff-reject-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const journal = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: makePlanContract("거부 조합") },
        { ok: true, text: "권한이 없어 멈춥니다\nSTATUS: BLOCKED\n\nCOMPLETE" },
      ],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS" }],
    }),
  });
  room.sendUserMessage({ text: "작업해줘", recordOnly: true });

  const result = await room.startSpecialist({ action: "full", stages: fullStages(room) });

  // 막힌 구현이 완료로 위장할 수 없다 — 기존 BLOCKED 처리로 사용자에게 간다.
  assert.equal(result.ok, false);
  const rejected = journal.find((event) => event.type === "HANDOFF_REJECTED");
  assert.ok(rejected);
  assert.equal(rejected.status, "CONTROL_NOT_ALLOWED");
  assert.ok(
    room.messages.some(
      (message) => message.authorType === "system" && /요청을 수용하지 않았습니다/.test(message.text)
    )
  );
  assert.equal(journal.some((event) => event.type === "HANDOFF_ACCEPTED" && event.role === "recorder"), false);
});

test("BLOCKED + HANDOFF: @planner는 수용하되 재기획 선택은 사용자에게 남긴다", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agora-handoff-replan-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const journal = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    meta: { workspace },
    taskManager: new TaskManager(),
    appendProfessionalEvent: (event) => {
      journal.push(event);
      return true;
    },
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: `${makePlanContract("재기획 요청")}\n\nHANDOFF: @reviewer` },
        { ok: true, text: "계획이 현실과 어긋납니다\nSTATUS: BLOCKED\n\nHANDOFF: @planner\nREASON: API 스키마가 계획과 다름" },
      ],
      codex: [{ ok: true, text: "기획 검수 통과\nVERDICT: PASS\n\nHANDOFF: @builder" }],
    }),
  });
  room.sendUserMessage({ text: "작업해줘", recordOnly: true });

  const result = await room.startSpecialist({ action: "full", stages: fullStages(room) });

  assert.equal(result.ok, false);
  const accepted = journal.filter((event) => event.type === "HANDOFF_ACCEPTED");
  assert.deepEqual(accepted.map((event) => event.role), ["reviewer", "builder", "planner"]);
  // 수용은 됐지만 자동 재기획은 하지 않는다(INV-5) — 안내가 남는다.
  assert.ok(
    room.messages.some(
      (message) => message.authorType === "system" && /재기획\(HANDOFF: @planner\)을 요청했습니다/.test(message.text)
    )
  );
  assert.equal(room.specialistState().blocked, true);
});

// --- 소비 seam 단위 동작 ---

function makeConsumerRoom(overrides = {}) {
  const room = Object.create(ChatRoom.prototype);
  room.professionalRun = createProfessionalRun({ node: "IMPLEMENTING", status: "RUNNING" });
  room.messages = [{ id: "msg-root", authorType: "user", text: "작업해줘" }];
  room.generation = 1;
  room.handoffLedger = null;
  room.journalWriteFailureNotified = false;
  room.persistProfessionalRun = () => true;
  room.emitSpecialistState = () => {};
  room.harnessLifecycle = null;
  room.systemNotices = [];
  room.appendSystem = (text) => room.systemNotices.push(text);
  room.journalEvents = [];
  room.appendProfessionalEvent = (event) => {
    room.journalEvents.push(event);
    return true;
  };
  Object.assign(room, overrides);
  return room;
}

test("consumeControlRequest: 영속 실패는 소비를 되돌리고 거부한다", () => {
  const room = makeConsumerRoom({ persistProfessionalRun: () => false });
  const result = room.consumeControlRequest({
    contract: "implementation",
    result: "DONE",
    outcome: {
      controlRequest: { action: "HANDOFF", targetRole: "reviewer", ambiguous: false },
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "HANDOFF_STATE_WRITE_FAILED");
  // in-memory 원장이 소비 전 상태로 돌아간다 — Journal이 아니라 fail-closed
  // 영속 경로가 authority이기 때문이다.
  assert.equal(room.handoffLedger.used, 0);
  assert.equal(room.handoffLedger.activeInvocationId, null);
  const rejected = room.journalEvents.find((event) => event.type === "HANDOFF_REJECTED");
  assert.equal(rejected.status, "HANDOFF_STATE_WRITE_FAILED");
});

test("ensureHandoffLedger: 같은 root의 crash 복원은 죽은 invocation을 기록하고 폐기한다", () => {
  const crashed = createHandoffLedger({ rootMessageId: "msg-root", budget: 8 });
  consumeHandoff(
    { sourceRole: "planner", targetRole: "reviewer", invocationId: "inv-crash" },
    { ledger: crashed },
  );
  const room = makeConsumerRoom();
  room.professionalRun = createProfessionalRun({
    node: "IMPLEMENTING",
    status: "RUNNING",
    handoffState: serializeHandoffLedger(crashed),
  });

  const ledger = room.ensureHandoffLedger();
  assert.equal(ledger.activeInvocationId, null, "ghost BUSY가 남으면 안 됩니다");
  assert.equal(ledger.used, 1, "복구가 예산 리셋이 되면 안 됩니다");
  const interrupted = room.journalEvents.find(
    (event) => event.type === "HANDOFF_REJECTED" && event.purpose === "crash_recovery"
  );
  assert.equal(interrupted.invocationId, "inv-crash");
});

test("ensureHandoffLedger: 새 사용자 발화는 새 budget epoch를 연다", () => {
  const previous = createHandoffLedger({ rootMessageId: "msg-old", budget: 8, used: 6 });
  const room = makeConsumerRoom();
  room.professionalRun = createProfessionalRun({
    node: "IMPLEMENTING",
    status: "RUNNING",
    handoffState: serializeHandoffLedger(previous),
  });
  room.messages = [
    { id: "msg-old", authorType: "user", text: "@팀 구현해" },
    { id: "msg-new", authorType: "user", text: "아니, API는 건드리지 마. 다시 해." },
  ];

  const ledger = room.ensureHandoffLedger();
  assert.equal(ledger.rootMessageId, "msg-new");
  assert.equal(ledger.used, 0);
});
