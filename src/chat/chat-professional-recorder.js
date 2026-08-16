"use strict";

const { serializeDeterministicRecorderOutput } = require("../agora/deterministic-recorder");

const INSTALL_MARK = Symbol.for("agora.deterministicProfessionalRecorderInstalled");
const DETERMINISTIC_RECORDER_MODE = "deterministic";

function isDeterministicProfessionalRecorderContext(context = {}) {
  return context?.specialist?.stage === "recorder" && context?.specialist?.professional === true;
}

function usesDeterministicProfessionalRecorder(room) {
  return room?.meta?.professionalRecorderMode === DETERMINISTIC_RECORDER_MODE;
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
