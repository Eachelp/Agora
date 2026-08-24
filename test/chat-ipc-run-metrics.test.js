"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { persistInvocationMetrics } = require("../src/chat/chat-ipc");

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-ipc-metrics-"));
  return {
    root,
    store: {
      runLogsDir(sessionId) {
        return path.join(root, sessionId, "runs");
      },
    },
  };
}

test("IPC 실행 경계는 runner의 runMetrics를 세션 metrics 파일로 저장한다", () => {
  const { root, store } = tempStore();
  try {
    const persisted = persistInvocationMetrics({
      store,
      sessionId: "session-1",
      runId: "run-1",
      agent: { id: "claude", model: "claude-model", effort: "high" },
      specialistStage: "implementation",
      result: {
        runMetrics: {
          startedAt: 100,
          finishedAt: 400,
          promptChars: 1200,
          stdoutBytes: 300,
          captureTruncated: false,
          approvalRequired: false,
          ok: true,
          stopReason: "COMPLETED",
          commands: { total: 2, failed: 0, truncated: 0 },
          tools: {
            started: 5,
            finished: 5,
            failed: 0,
            truncated: 0,
            outputBytes: 900,
            uniqueTargets: 2,
            repeatedCalls: 3,
            maxRepeatCount: 2,
          },
          exploration: { status: "NORMAL", reason: null },
        },
      },
    });

    assert.equal(persisted, true);
    const file = path.join(store.runLogsDir("session-1"), "run-1.metrics.json");
    assert.equal(fs.existsSync(file), true);
    const metrics = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(metrics.invocationId, "run-1");
    assert.equal(metrics.provider, "claude");
    assert.equal(metrics.model, "claude-model");
    assert.equal(metrics.effort, "high");
    assert.equal(metrics.stage, "implementation");
    assert.equal(metrics.durationMs, 300);
    assert.equal(metrics.commands.total, 2);
    assert.equal(metrics.tools.started, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metrics 저장 실패는 실행 결과를 던지지 않고 false로만 보고한다", () => {
  const persisted = persistInvocationMetrics({
    store: null,
    sessionId: "session-1",
    runId: "run-1",
    agent: { id: "claude" },
    result: { runMetrics: { ok: true } },
  });
  assert.equal(persisted, false);
});

test("실제 IPC runner 연결은 전문 단계 여부를 strict-final 계약으로 명시 전달한다", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "chat", "chat-ipc.js"),
    "utf8"
  );
  assert.match(source, /requireFinal:\s*Boolean\(specialistStage\)/);
  assert.match(source, /const metricsPersisted = persistInvocationMetrics\(/);
});
