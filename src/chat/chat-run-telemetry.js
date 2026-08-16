"use strict";

const DEFAULT_RECENT_TOOL_EVENTS = 40;
const DEFAULT_REPEATED_TARGETS = 10;

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

    return {
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
  }

  return { observe, snapshot };
}

module.exports = {
  createRunTelemetry,
  DEFAULT_RECENT_TOOL_EVENTS,
  DEFAULT_REPEATED_TARGETS,
};
