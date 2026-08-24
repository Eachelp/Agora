const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  persistRunMetrics,
  pruneMetricFiles,
  MAX_RUN_METRIC_FILES,
} = require("../src/chat/chat-run-metrics-store");

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-metrics-"));
  return {
    root,
    store: {
      runLogsDir(sessionId) {
        return path.join(root, sessionId, "runs");
      },
    },
  };
}

test("RunMetrics는 provider/model/stage를 붙여 별도 metrics 파일로 저장한다", () => {
  const { root, store } = tempStore();
  try {
    const saved = persistRunMetrics({
      store,
      sessionId: "s1",
      runId: "r1",
      provider: "claude",
      model: "model-x",
      effort: "medium",
      stage: "implementation",
      metrics: {
        startedAt: 100,
        finishedAt: 350,
        promptChars: 9000,
        stdoutBytes: 1234,
        captureTruncated: false,
        approvalRequired: false,
        ok: true,
        stopReason: "COMPLETED",
        commands: { total: 4, failed: 1, truncated: 0 },
        tools: {
          started: 8,
          finished: 8,
          failed: 0,
          truncated: 0,
          outputBytes: 5000,
          uniqueTargets: 2,
          repeatedCalls: 6,
          maxRepeatCount: 4,
        },
        exploration: { status: "WARNING", reason: "repeated-target" },
      },
    });

    assert.equal(saved.ok, true);
    const file = path.join(store.runLogsDir("s1"), "r1.metrics.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(value.provider, "claude");
    assert.equal(value.model, "model-x");
    assert.equal(value.stage, "implementation");
    assert.equal(value.durationMs, 250);
    assert.equal(value.commands.total, 4);
    assert.equal(value.exploration.status, "WARNING");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metrics 보존량은 raw log보다 길게 100개로 제한한다", () => {
  const { root, store } = tempStore();
  try {
    const dir = store.runLogsDir("s1");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < MAX_RUN_METRIC_FILES + 5; i += 1) {
      const file = path.join(dir, `r-${String(i).padStart(3, "0")}.metrics.json`);
      fs.writeFileSync(file, "{}", "utf8");
      const at = new Date(1000 + i * 1000);
      fs.utimesSync(file, at, at);
    }
    pruneMetricFiles(store, "s1");
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".metrics.json"));
    assert.equal(files.length, MAX_RUN_METRIC_FILES);
    assert.equal(files.includes("r-000.metrics.json"), false);
    assert.equal(files.includes(`r-${String(MAX_RUN_METRIC_FILES + 4).padStart(3, "0")}.metrics.json`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
