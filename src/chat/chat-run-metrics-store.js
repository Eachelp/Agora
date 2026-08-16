"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildRunMetrics } = require("./chat-run-metrics");

const MAX_RUN_METRIC_FILES = 100;

function safeRunId(value) {
  return String(value || "").replace(/[^\w.-]/g, "_");
}

function pruneMetricFiles(store, sessionId, keepPath = null, limit = MAX_RUN_METRIC_FILES) {
  try {
    const dir = store.runLogsDir(sessionId);
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".metrics.json"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {}
        return { full, mtimeMs };
      })
      .filter((entry) => entry.full !== keepPath)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keepCount = keepPath ? Math.max(0, limit - 1) : limit;
    for (const entry of entries.slice(keepCount)) {
      try {
        fs.rmSync(entry.full, { force: true });
      } catch {}
    }
  } catch {}
}

function persistRunMetrics({
  store,
  sessionId,
  runId,
  provider = null,
  model = null,
  effort = null,
  stage = null,
  metrics = null,
} = {}) {
  if (!store || !sessionId || !runId || !metrics) return { ok: false, metrics: null };
  try {
    const normalized = buildRunMetrics({
      invocationId: runId,
      provider,
      model,
      effort,
      stage,
      startedAt: metrics.startedAt,
      finishedAt: metrics.finishedAt,
      promptChars: metrics.promptChars,
      result: {
        ok: metrics.ok,
        stopReason: metrics.stopReason === "COMPLETED" ? null : metrics.stopReason,
        approvalRequired: metrics.approvalRequired,
        output: {
          stdoutBytes: metrics.stdoutBytes,
          captureTruncated: metrics.captureTruncated,
        },
        evidence: {
          commandSummary: metrics.commands,
          toolSummary: metrics.tools,
          exploration: metrics.exploration,
        },
      },
    });
    // COMPLETED 입력을 buildRunMetrics에 다시 넣으면 ok=true가 우선되어 같은 taxonomy가 유지됩니다.
    const dir = store.runLogsDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeRunId(runId)}.metrics.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, file);
    pruneMetricFiles(store, sessionId, file);
    return { ok: true, metrics: normalized, fileName: path.basename(file) };
  } catch {
    return { ok: false, metrics: null };
  }
}

module.exports = {
  persistRunMetrics,
  pruneMetricFiles,
  MAX_RUN_METRIC_FILES,
};
