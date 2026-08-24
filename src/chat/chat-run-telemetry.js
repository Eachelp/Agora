"use strict";

const DEFAULT_RECENT_TOOL_EVENTS = 40;
const DEFAULT_REPEATED_TARGETS = 10;

const DEFAULT_LOOP_THRESHOLDS = Object.freeze({
  warningRepeatCount: 4,
  loopRepeatCount: 8,
  warningRepeatedCalls: 6,
  loopRepeatedCalls: 12,
  warningOutputBytes: 2 * 1024 * 1024,
  loopOutputBytes: 5 * 1024 * 1024,
});

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeTarget(value) {
  const text = String(value || "").trim();
  return text || null;
}

function targetKey(tool, target) {
  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget) return null;
  return `${String(tool || "tool").toLowerCase()}\u0000${normalizedTarget}`;
}

function normalizedThresholds(overrides = {}) {
  const result = { ...DEFAULT_LOOP_THRESHOLDS };
  for (const key of Object.keys(result)) {
    if (Number.isInteger(overrides[key]) && overrides[key] >= 0) result[key] = overrides[key];
  }
  return result;
}

function canonicalExplorationReason(reasons = []) {
  const first = Array.isArray(reasons) ? reasons[0] || "" : "";
  if (first.startsWith("same-target:")) return "repeated-target";
  if (first.startsWith("repeated-calls:")) return "repeated-calls";
  if (first.startsWith("tool-output-bytes:")) return "output-volume";
  if (first.startsWith("failure-loop:")) return "failure-loop";
  if (first.startsWith("failure-rate:")) return "failure-rate";
  return null;
}

function detectExplorationLoop(snapshot, overrides = {}) {
  const thresholds = normalizedThresholds(overrides);
  const summary = snapshot?.toolSummary || {};
  const maxRepeatCount = nonNegativeInteger(summary.maxRepeatCount);
  const repeatedCalls = nonNegativeInteger(summary.repeatedCalls);
  const outputBytes = nonNegativeInteger(summary.outputBytes);
  const failed = nonNegativeInteger(summary.failed);
  const finished = nonNegativeInteger(summary.finished);
  const failureRate = finished > 0 ? failed / finished : 0;

  const loopReasons = [];
  const warningReasons = [];

  if (maxRepeatCount >= thresholds.loopRepeatCount) {
    loopReasons.push(`same-target:${maxRepeatCount}`);
  } else if (maxRepeatCount >= thresholds.warningRepeatCount) {
    warningReasons.push(`same-target:${maxRepeatCount}`);
  }

  if (repeatedCalls >= thresholds.loopRepeatedCalls) {
    loopReasons.push(`repeated-calls:${repeatedCalls}`);
  } else if (repeatedCalls >= thresholds.warningRepeatedCalls) {
    warningReasons.push(`repeated-calls:${repeatedCalls}`);
  }

  if (outputBytes >= thresholds.loopOutputBytes) {
    loopReasons.push(`tool-output-bytes:${outputBytes}`);
  } else if (outputBytes >= thresholds.warningOutputBytes) {
    warningReasons.push(`tool-output-bytes:${outputBytes}`);
  }

  // 실패가 절반 이상인 상태에서 반복 호출도 함께 관찰되면 단순 대용량 탐색보다
  // 도구 실패 → 우회 → 재시도 루프일 가능성이 높습니다.
  if (finished >= 4 && failureRate >= 0.5 && repeatedCalls >= 2) {
    if (maxRepeatCount >= thresholds.warningRepeatCount || repeatedCalls >= thresholds.warningRepeatedCalls) {
      loopReasons.push(`failure-loop:${failed}/${finished}`);
    } else {
      warningReasons.push(`failure-rate:${failed}/${finished}`);
    }
  }

  const status = loopReasons.length > 0
    ? "LOOP_DETECTED"
    : warningReasons.length > 0
      ? "WARNING"
      : "NORMAL";
  const reasons = status === "LOOP_DETECTED" ? loopReasons : warningReasons;

  return {
    status,
    reason: canonicalExplorationReason(reasons),
    reasons,
    maxRepeatCount,
    repeatedCalls,
    outputBytes,
    failed,
    finished,
    failureRate,
  };
}

function createRunTelemetry(options = {}) {
  const recentToolLimit = Number.isInteger(options.recentToolLimit) && options.recentToolLimit > 0
    ? options.recentToolLimit
    : DEFAULT_RECENT_TOOL_EVENTS;
  const repeatedTargetLimit = Number.isInteger(options.repeatedTargetLimit) && options.repeatedTargetLimit > 0
    ? options.repeatedTargetLimit
    : DEFAULT_REPEATED_TARGETS;

  const targetCounts = new Map();
  const toolCounts = new Map();
  const recentTools = [];

  let commandFinished = 0;
  let commandFailed = 0;
  let commandTruncated = 0;

  let toolStarted = 0;
  let toolFinished = 0;
  let toolFailed = 0;
  let toolTruncated = 0;
  let toolOutputBytes = 0;

  function rememberTool(event) {
    recentTools.push({ ...event });
    if (recentTools.length > recentToolLimit) {
      recentTools.splice(0, recentTools.length - recentToolLimit);
    }
  }

  function observe(event) {
    if (!event || typeof event !== "object") return event;

    if (event.kind === "command-finished") {
      commandFinished += 1;
      if (Number.isInteger(event.exitCode) && event.exitCode !== 0) commandFailed += 1;
      if (event.truncated) commandTruncated += 1;
      return event;
    }

    if (event.kind === "tool-started") {
      toolStarted += 1;
      const tool = String(event.tool || "tool");
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
      const key = targetKey(tool, event.target);
      if (key) {
        const current = targetCounts.get(key) || {
          tool,
          target: normalizeTarget(event.target),
          count: 0,
        };
        current.count += 1;
        targetCounts.set(key, current);
      }
      rememberTool(event);
      return event;
    }

    if (event.kind === "tool-finished") {
      toolFinished += 1;
      if (event.executionStatus === "FAILED" || event.failed === true) toolFailed += 1;
      if (event.truncated) toolTruncated += 1;
      toolOutputBytes += nonNegativeInteger(event.outputBytes);
      rememberTool(event);
    }
    return event;
  }

  function snapshot() {
    const repeatedTargets = [...targetCounts.values()]
      .filter((entry) => entry.count > 1)
      .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
      .slice(0, repeatedTargetLimit)
      .map((entry) => ({ ...entry }));
    const repeatedCalls = [...targetCounts.values()]
      .reduce((sum, entry) => sum + Math.max(0, entry.count - 1), 0);
    const maxRepeatCount = [...targetCounts.values()]
      .reduce((max, entry) => Math.max(max, entry.count), 0);

    const snapshotValue = {
      commands: {
        total: commandFinished,
        failed: commandFailed,
        truncated: commandTruncated,
      },
      tools: recentTools.map((event) => ({ ...event })),
      toolSummary: {
        started: toolStarted,
        finished: toolFinished,
        failed: toolFailed,
        truncated: toolTruncated,
        outputBytes: toolOutputBytes,
        uniqueTargets: targetCounts.size,
        repeatedCalls,
        maxRepeatCount,
        repeatedTargets,
        byTool: [...toolCounts.entries()]
          .map(([tool, count]) => ({ tool, count }))
          .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
      },
    };
    return {
      ...snapshotValue,
      exploration: detectExplorationLoop(snapshotValue, options.loopThresholds),
    };
  }

  return { observe, snapshot };
}

module.exports = {
  createRunTelemetry,
  detectExplorationLoop,
  canonicalExplorationReason,
  DEFAULT_RECENT_TOOL_EVENTS,
  DEFAULT_REPEATED_TARGETS,
  DEFAULT_LOOP_THRESHOLDS,
};
