"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildRunMetrics } = require("./chat-run-metrics");

const MAX_RUN_METRIC_FILES = 100;

function safeRunId(value) {
  return String(value || "run").replace(/[^\w.-]/g, "_").slice(0, 120) || "run";
}

function pruneMetricFiles(store, sessionId, keepPath = null) {
  try {
    const dir = store.runLogsDir(sessionId);
    const entries = fs.readdirSync(dir)
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
    const keepCount = keepPath ? Math.max(0, MAX_RUN_METRIC_FILES - 1) : MAX_RUN_METRIC_FILES;
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
  if (!store || !sessionId || !runId || !metrics) return { ok: false, reason: "missing-input" };
  try {
    // 저장 경계에서도 같은 normalizer를 한 번 더 통과시킵니다. 성공 실행의
    // stopReason은 buildRunMetrics 계약에 따라 항상 COMPLETED이고, 실패 실행만
    // 구체적인 종료 사유를 보존합니다.
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
        stopReason: metrics.stopReason,
        output: {
          stdoutBytes: metrics.stdoutBytes,
          captureTruncated: metrics.captureTruncated,
        },
        approvalRequired: metrics.approvalRequired,
        evidence: {
          commandSummary: metrics.commands,
          toolSummary: metrics.tools,
          exploration: metrics.exploration,
        },
      },
    });

    const dir = store.runLogsDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeRunId(runId)}.metrics.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(tmp, file);
    pruneMetricFiles(store, sessionId, file);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, reason: error?.message || "metrics-write-failed" };
  }
}

module.exports = {
  MAX_RUN_METRIC_FILES,
  persistRunMetrics,
  pruneMetricFiles,
};
