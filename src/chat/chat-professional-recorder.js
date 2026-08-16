"use strict";

const { serializeDeterministicRecorderOutput } = require("../agora/deterministic-recorder");

const INSTALL_MARK = Symbol.for("agora.deterministicProfessionalRecorderInstalled");
const DETERMINISTIC_RECORDER_MODE = "deterministic";

function isDeterministicProfessionalRecorderContext(context = {}) {
  return context?.specialist?.stage === "recorder" && context?.specialist?.professional === true;
}

function usesDeterministicProfessionalRecorder(room) {
  // 실제 Agora 앱의 새 Professional Run은 professional journal을 영속화한다.
  // 명시적 mode가 있으면 그것을 우선하고, mode가 없는 기존 production room은
  // persistProfessionalRun 계약을 기준으로 deterministic recorder를 기본 사용한다.
  const mode = room?.meta?.professionalRecorderMode;
  if (mode != null) return mode === DETERMINISTIC_RECORDER_MODE;
  return typeof room?.persistProfessionalRun === "function";
}

function deterministicRecorderResult(context = {}) {
  const specialist = context.specialist || {};
  const frozenTask = specialist.frozenTask || {};
  const text = serializeDeterministicRecorderOutput({
    runId: frozenTask.runId || null,
    taskId: frozenTask.taskId || null,
    taskHash: frozenTask.taskHash || null,
    finalVerdict: specialist.finalVerdict || "PASS",
    round: specialist.round || 1,
    reviewDiff: specialist.reviewDiff || "",
    evidence: specialist.evidence || null,
  });
  return {
    ok: true,
    text,
    transport: "LOCAL_DETERMINISTIC",
    deterministicRecorder: true,
  };
}

function installDeterministicProfessionalRecorder(ChatRoom) {
  if (!ChatRoom?.prototype) throw new TypeError("ChatRoom class is required");
  if (ChatRoom.prototype[INSTALL_MARK]) return false;
  const original = ChatRoom.prototype.scheduleResponse;
  if (typeof original !== "function") throw new TypeError("ChatRoom.scheduleResponse is required");

  Object.defineProperty(ChatRoom.prototype, INSTALL_MARK, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  ChatRoom.prototype.scheduleResponse = function scheduleResponseWithDeterministicRecorder(agent, context = {}) {
    if (
      usesDeterministicProfessionalRecorder(this) &&
      isDeterministicProfessionalRecorderContext(context)
    ) {
      return Promise.resolve(deterministicRecorderResult(context));
    }
    return original.call(this, agent, context);
  };
  return true;
}

module.exports = {
  DETERMINISTIC_RECORDER_MODE,
  installDeterministicProfessionalRecorder,
  isDeterministicProfessionalRecorderContext,
  usesDeterministicProfessionalRecorder,
  deterministicRecorderResult,
};
