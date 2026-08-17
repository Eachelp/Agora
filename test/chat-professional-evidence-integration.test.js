"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ChatRoom } = require("../src/chat/chat-room");
const { safeBlockReason } = require("../src/chat/chat-specialist");

test("ChatRoom evidencePayload가 telemetry와 전체 command summary를 저장 경계까지 전달한다", () => {
  let persisted = null;
  const room = Object.create(ChatRoom.prototype);
  room.taskManager = {
    writeRunEvidence(runInfo, payload) {
      persisted = { runInfo, payload };
      return true;
    },
  };

  const result = room.evidencePayload({
    runInfo: { runId: "RUN-001", runDir: "unused" },
    builderResult: {
      runId: "r-builder",
      transport: "COMPLETED",
      builderStatus: "DONE",
      evidence: {
        commands: [{ kind: "command-finished", command: "npm test", exitCode: 0 }],
        commandSummary: { total: 42, failed: 3, truncated: 2 },
        toolSummary: {
          started: 9,
          finished: 9,
          outputBytes: 12345,
          repeatedCalls: 8,
          maxRepeatCount: 9,
        },
        exploration: {
          status: "LOOP_DETECTED",
          reason: "repeated-target",
          reasons: ["same-target:9"],
        },
      },
    },
    diff: { status: "CHANGED" },
    round: 1,
    provider: "claude",
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.commandSummary.total, 42);
  assert.equal(result.payload.commandSummary.omitted, 41);
  assert.equal(result.payload.toolSummary.maxRepeatCount, 9);
  assert.equal(result.payload.exploration.status, "LOOP_DETECTED");
  assert.equal(persisted.payload.exploration.reason, "repeated-target");
});

test("PROTOCOL_FINAL_MISSING은 specialist 안전 사유로 그대로 보존된다", () => {
  assert.equal(safeBlockReason("PROTOCOL_FINAL_MISSING"), "PROTOCOL_FINAL_MISSING");
});

test("evidencePayload는 명시 인자 없으면 professionalRun의 checkpointProtection을 end-to-end로 전달한다", () => {
  let persisted = null;
  const room = Object.create(ChatRoom.prototype);
  room.taskManager = {
    writeRunEvidence(runInfo, payload) {
      persisted = { runInfo, payload };
      return true;
    },
  };
  room.professionalRun = { checkpointProtection: "unavailable_user_approved" };

  const result = room.evidencePayload({
    runInfo: { runId: "RUN-001", runDir: "unused" },
    builderResult: { runId: "r1", transport: "COMPLETED", builderStatus: "DONE" },
    diff: { status: "NO_CHANGES" },
    round: 1,
    provider: "claude",
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.checkpointProtection, "unavailable_user_approved");
  assert.equal(persisted.payload.checkpointProtection, "unavailable_user_approved");
});

test("resumeCheckpointFailure는 action에 따라 재시도/무보호 진행을 라우팅한다", async () => {
  const room = Object.create(ChatRoom.prototype);
  const transitions = [];
  room.professionalRun = { node: "IMPLEMENTING", status: "WAITING", stopReason: "CHECKPOINT_FAILED" };
  room.transitionProfessional = (event) => {
    transitions.push(event);
    room.professionalRun = { ...room.professionalRun, ...event };
    return { ok: true };
  };
  room.professionalTransitionFailure = () => ({ ok: false });
  room.appendSystem = () => {};
  room.emitSpecialistState = () => {};
  const execCalls = [];
  room.runExecutionBlock = async (opts) => {
    execCalls.push(opts);
    return { ok: true };
  };

  const resume = {
    phases: { implementation: { agent: { id: "claude" } } },
    mode: "step",
    maxAutoRevisions: 2,
    runInfo: { runId: "RUN-009" },
    checkpointFailReason: "CHECKPOINT_GIT_FAILED",
  };

  // retry 기본 동작
  await room.resumeCheckpointFailure(resume, 1, "retry");
  assert.equal(transitions[0].type, "CHECKPOINT_RETRY");
  assert.equal(execCalls[0].allowUnprotected, false);
  assert.equal(execCalls[0].resumedRun.runId, "RUN-009");
  // checkpoint 재시도가 원래 실행 정책(자동 보완 횟수)을 잃지 않아야 한다.
  assert.equal(execCalls[0].maxAutoRevisions, 2);
  assert.equal(execCalls[0].checkpointFailReason, "CHECKPOINT_GIT_FAILED");

  // 무보호 진행
  transitions.length = 0;
  execCalls.length = 0;
  await room.resumeCheckpointFailure(resume, 1, "proceed_unprotected");
  assert.equal(transitions[0].type, "PROCEED_UNPROTECTED");
  assert.equal(execCalls[0].allowUnprotected, true);
  assert.equal(execCalls[0].resumedRun.runId, "RUN-009");
  assert.equal(execCalls[0].maxAutoRevisions, 2);
  assert.equal(execCalls[0].checkpointFailReason, "CHECKPOINT_GIT_FAILED");
});

test("READY 상태에서 answerPlanQuestion이 기획 수정으로 동작한다", async () => {
  const room = Object.create(ChatRoom.prototype);
  const transitions = [];
  room.professionalRun = { node: "READY", status: "WAITING", approvedTaskHash: "hash-123" };
  room.transitionProfessional = (event) => {
    transitions.push(event);
    room.professionalRun = { ...room.professionalRun, node: "PLANNING", status: "RUNNING", approvedTaskHash: null };
    return { ok: true, state: room.professionalRun };
  };
  room.professionalTransitionFailure = () => ({ ok: false });
  room.specialistResume = { phase: "plan_ready", stages: {}, feedback: "" };
  room.specialistActive = false;
  room.messages = [];
  room.appendMessage = (msg) => room.messages.push(msg);
  room.appendSystem = () => {};
  room.emitSpecialistState = () => {};
  room.setProfessionalRun = () => true;
  room.onProfessionalTaskState = null;
  const planCalls = [];
  room.runPlanBlock = async (opts) => { planCalls.push(opts); return { ok: true }; };
  room.withProfessionalAuthorization = async (cap, fn) => fn();

  const result = await room.answerPlanQuestion("이 기획서에 테스트 절차를 추가해 주세요");
  assert.equal(result.ok, true);
  assert.equal(transitions[0].type, "USER_ANSWER_PLAN");
  assert.ok(room.messages[0].text.includes("[기획 수정]"));
  assert.ok(planCalls[0].feedback.includes("기획 수정 요청"));
  assert.equal(room.specialistResume, null);
});
