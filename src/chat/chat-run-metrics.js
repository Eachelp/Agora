"use strict";

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function finiteTimestamp(value, fallback = null) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function stopReasonFor(result = {}) {
  if (result.ok) return "COMPLETED";
  if (result.stopReason) return String(result.stopReason).slice(0, 80);
  if (result.cancelled) return "CANCELLED";
  if (result.timedOut) return "TIMED_OUT";
  if (result.outputLimited) return "OUTPUT_LIMITED";
  if (result.approvalRequired) return "APPROVAL_REQUIRED";
  if (result.protocolFailed) return "PROTOCOL_FAILED";
  return "FAILED";
}

function buildRunMetrics({
  invocationId = null,
  provider = null,
  model = null,
  effort = null,
  stage = null,
  startedAt = null,
  finishedAt = null,
  promptChars = 0,
  result = {},
} = {}) {
  const start = finiteTimestamp(startedAt, null);
  const finish = finiteTimestamp(finishedAt, start);
  const evidence = result?.evidence || {};
  const commands = evidence.commandSummary || {};
  const tools = evidence.toolSummary || {};
  const exploration = evidence.exploration || {};
  const output = result?.output || {};

  return {
    schemaVersion: 1,
    invocationId: invocationId ? String(invocationId).slice(0, 128) : null,
    provider: provider ? String(provider).slice(0, 80) : null,
    model: model ? String(model).slice(0, 128) : null,
    effort: effort ? String(effort).slice(0, 32) : null,
    stage: stage ? String(stage).slice(0, 48) : null,
    startedAt: start,
    finishedAt: finish,
    durationMs: start != null && finish != null ? Math.max(0, finish - start) : null,
    promptChars: nonNegativeInteger(promptChars),
    stdoutBytes: nonNegativeInteger(output.stdoutBytes),
    captureTruncated: Boolean(output.captureTruncated),
    approvalRequired: Boolean(result?.approvalRequired),
    ok: Boolean(result?.ok),
    stopReason: stopReasonFor(result),
    commands: {
      total: nonNegativeInteger(commands.total),
      failed: nonNegativeInteger(commands.failed),
      truncated: nonNegativeInteger(commands.truncated),
    },
    tools: {
      started: nonNegativeInteger(tools.started),
      finished: nonNegativeInteger(tools.finished),
      failed: nonNegativeInteger(tools.failed),
      truncated: nonNegativeInteger(tools.truncated),
      outputBytes: nonNegativeInteger(tools.outputBytes),
      uniqueTargets: nonNegativeInteger(tools.uniqueTargets),
      repeatedCalls: nonNegativeInteger(tools.repeatedCalls),
      maxRepeatCount: nonNegativeInteger(tools.maxRepeatCount),
    },
    exploration: {
      status: ["NORMAL", "WARNING", "LOOP_DETECTED"].includes(exploration.status)
        ? exploration.status
        : "NORMAL",
      reason: exploration.reason ? String(exploration.reason).slice(0, 80) : null,
    },
  };
}

module.exports = {
  buildRunMetrics,
  stopReasonFor,
};
