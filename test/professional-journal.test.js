const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatStore } = require("../src/chat/chat-store");
const {
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_EVENT_TYPES,
  createJournalEvent,
  journalEventsForTransition,
} = require("../src/agora/professional-journal");
const { createProfessionalRun } = require("../src/agora/professional-run");
const { ChatRoom } = require("../src/chat/chat-room");

function makeStore(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-journal-"));
  const store = new ChatStore({ root, ...options });
  store.init();
  return store;
}

// --- 저장 계층 (chat-store) ---

test("appendProfessionalEvent는 transcript와 분리된 파일에 append한다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  const saved = store.appendProfessionalEvent(meta.id, {
    schemaVersion: 1,
    eventId: "pe-1",
    type: "ROLE_FINISHED",
    role: "planner",
  });
  assert.equal(saved, true);
  assert.ok(fs.existsSync(store.professionalEventsPath(meta.id)));
  // transcript에는 섞이지 않는다(INV-7).
  assert.equal(fs.existsSync(store.transcriptPath(meta.id)), false);
  const events = store.readProfessionalEvents(meta.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "pe-1");
});

test("appendProfessionalEvent는 meta.json을 다시 쓰지 않는다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  const before = fs.readFileSync(store.metaPath(meta.id), "utf8");
  store.appendProfessionalEvent(meta.id, { eventId: "pe-1", type: "TASK_APPROVED" });
  const after = fs.readFileSync(store.metaPath(meta.id), "utf8");
  assert.equal(after, before);
});

test("같은 eventId는 읽기에서 첫 기록만 남는다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  store.appendProfessionalEvent(meta.id, { eventId: "pe-1", type: "TASK_APPROVED", status: "A" });
  store.appendProfessionalEvent(meta.id, { eventId: "pe-1", type: "TASK_APPROVED", status: "B" });
  store.appendProfessionalEvent(meta.id, { eventId: "pe-2", type: "RUN_COMPLETED" });
  const events = store.readProfessionalEvents(meta.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "A");
});

test("깨진 마지막 line은 건너뛰고 나머지를 읽는다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  store.appendProfessionalEvent(meta.id, { eventId: "pe-1", type: "TASK_APPROVED" });
  fs.appendFileSync(store.professionalEventsPath(meta.id), '{"eventId":"pe-torn', "utf8");
  const events = store.readProfessionalEvents(meta.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "pe-1");
});

test("readOnly 저장소에서는 false를 반환한다 — 조용한 성공 위장이 없다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  store.readOnly = true;
  assert.equal(
    store.appendProfessionalEvent(meta.id, { eventId: "pe-1", type: "TASK_APPROVED" }),
    false
  );
  assert.equal(store.appendProfessionalEvent(meta.id, null), false);
  assert.equal(store.appendProfessionalEvent("no-such-session", { type: "TASK_APPROVED" }), false);
});

// --- 이벤트 생성과 전이 매핑 (professional-journal) ---

test("createJournalEvent는 §10.3 스키마로 조립하고 미지 type을 거부한다", () => {
  const event = createJournalEvent({
    type: "REVIEW_VERDICT",
    role: "reviewer",
    purpose: "plan_review",
    status: "PASS",
    professionalRunId: "pr-1",
    createdAt: 123,
  });
  assert.equal(event.schemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.match(event.eventId, /^pe-/);
  assert.equal(event.type, "REVIEW_VERDICT");
  assert.equal(event.status, "PASS");
  assert.equal(event.createdAt, 123);
  assert.deepEqual(event.artifactRefs, []);
  assert.equal(createJournalEvent({ type: "MADE_UP_KIND" }), null);
  assert.ok(JOURNAL_EVENT_TYPES.includes("HANDOFF_REQUESTED"));
});

test("전이 매핑: 기획 완료·질문·검수 판정이 §10.3 이벤트로 나온다", () => {
  const prev = createProfessionalRun({ node: "PLANNING", status: "RUNNING" });
  const ready = journalEventsForTransition(prev, { type: "PLANNER_PLAN_READY" }, {
    ...prev,
    node: "PLAN_REVIEW",
  });
  assert.deepEqual(
    ready.map((event) => event.type),
    ["ROLE_FINISHED"]
  );
  assert.equal(ready[0].role, "planner");
  assert.equal(ready[0].status, "PLAN_READY");

  const question = journalEventsForTransition(prev, { type: "PLANNER_NEEDS_DECISION" }, prev);
  assert.deepEqual(
    question.map((event) => event.type),
    ["ROLE_FINISHED", "USER_DECISION_REQUIRED"]
  );

  const verdict = journalEventsForTransition(prev, { type: "REVIEW_FIX" }, prev);
  assert.equal(verdict[0].type, "REVIEW_VERDICT");
  assert.equal(verdict[0].purpose, "implementation_review");
  assert.equal(verdict[0].status, "FIX_REQUIRED");
});

test("계획 단계 이벤트에는 frozenRunId가 실리지 않는다", () => {
  const planning = createProfessionalRun({ node: "PLANNING", status: "RUNNING" });
  const events = journalEventsForTransition(planning, { type: "PLANNER_PLAN_READY" }, planning);
  assert.equal(events[0].frozenRunId, null);

  const frozen = createProfessionalRun({
    node: "IMPLEMENTING",
    status: "RUNNING",
    frozenRunId: "RUN-012",
    professionalRunId: "pr-x",
  });
  const done = journalEventsForTransition(frozen, { type: "BUILDER_DONE" }, frozen);
  assert.equal(done[0].frozenRunId, "RUN-012");
  assert.equal(done[0].professionalRunId, "pr-x");
});

test("RECORDER_DONE이 COMPLETED로 끝나면 RUN_COMPLETED가 함께 남는다", () => {
  const recording = createProfessionalRun({ node: "RECORDING", status: "RUNNING" });
  const completed = { ...recording, node: "COMPLETED", status: "COMPLETED" };
  const events = journalEventsForTransition(recording, { type: "RECORDER_DONE" }, completed);
  assert.deepEqual(
    events.map((event) => event.type),
    ["ROLE_FINISHED", "RUN_COMPLETED"]
  );
});

test("매핑에 없는 전이는 이벤트를 만들지 않는다", () => {
  const run = createProfessionalRun({});
  assert.deepEqual(journalEventsForTransition(run, { type: "SOMETHING_ELSE" }, run), []);
  assert.deepEqual(journalEventsForTransition(run, {}, run), []);
});

// --- FSM seam 통합 (transitionProfessional) ---

function makeMixinRoom(overrides = {}) {
  const room = Object.create(ChatRoom.prototype);
  room.professionalRun = createProfessionalRun({ node: "PLANNING", status: "RUNNING" });
  room.persistProfessionalRun = () => true;
  room.emitSpecialistState = () => {};
  room.harnessLifecycle = null;
  room.journalWriteFailureNotified = false;
  room.systemNotices = [];
  room.appendSystem = (text) => room.systemNotices.push(text);
  Object.assign(room, overrides);
  return room;
}

test("transitionProfessional이 Journal 이벤트를 발행한다", () => {
  const appended = [];
  const room = makeMixinRoom({
    appendProfessionalEvent: (event) => {
      appended.push(event);
      return true;
    },
  });
  const result = room.transitionProfessional({ type: "PLANNER_PLAN_READY" });
  assert.equal(result.ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "ROLE_FINISHED");
  assert.equal(appended[0].professionalRunId, room.professionalRun.professionalRunId);
  assert.equal(room.systemNotices.length, 0);
});

test("Journal 저장 실패는 실행을 멈추지 않되 한 번은 알린다", () => {
  const room = makeMixinRoom({ appendProfessionalEvent: () => false });
  const first = room.transitionProfessional({ type: "PLANNER_PLAN_READY" });
  assert.equal(first.ok, true, "Journal 실패가 FSM 전이를 막으면 안 됩니다");
  assert.equal(room.systemNotices.length, 1);
  assert.match(room.systemNotices[0], /System Journal/);

  // 두 번째 실패는 도배하지 않는다.
  const second = room.transitionProfessional({ type: "PLAN_REVIEW_FIX" });
  assert.equal(second.ok, true);
  assert.equal(room.systemNotices.length, 1);
});

test("appender가 없으면 Journal 발행을 건너뛴다(레거시 호환)", () => {
  const room = makeMixinRoom({ appendProfessionalEvent: undefined });
  const result = room.transitionProfessional({ type: "PLANNER_PLAN_READY" });
  assert.equal(result.ok, true);
  assert.equal(room.systemNotices.length, 0);
});

test("실패한 전이는 Journal에 남지 않는다", () => {
  const appended = [];
  const room = makeMixinRoom({
    appendProfessionalEvent: (event) => {
      appended.push(event);
      return true;
    },
  });
  // PLANNING 상태에서 BUILDER_DONE은 불법 전이다.
  const result = room.transitionProfessional({ type: "BUILDER_DONE" });
  assert.equal(result.ok, false);
  assert.equal(appended.length, 0);
});
