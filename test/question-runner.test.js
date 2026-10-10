"use strict";

// 질문 도구로 사용자의 답을 기다리는 동안 러너의 실행 시간 제한과 무음 경고가 멈추고, 그 시간이 지표에 따로 남는다.
// 실제 자식 프로세스(node -e)와 짧은 실시간 타이머로 확인한다(여유를 넉넉히 둔다).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { persistRunMetrics } = require("../src/chat/chat-run-metrics-store");
const { buildRunMetrics } = require("../src/chat/chat-run-metrics");

const SLOW_CHILD = "setTimeout(() => process.stdout.write('끝'), 800)";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runSlow(options = {}) {
  return runAgentProcess({
    commandPath: process.execPath,
    argv: ["-e", SLOW_CHILD],
    prompt: "",
    cwd: os.tmpdir(),
    ...options,
  });
}

test("대조: 기다림을 알리지 않으면 짧은 시간 제한에 걸리고 무음 경고도 난다", async () => {
  const events = [];
  const run = runSlow({ timeoutMs: 500, silenceWarningMs: 150, onEvent: (event) => events.push(event) });
  const result = await run.promise;
  assert.equal(result.timedOut, true);
  assert.ok(events.some((event) => event.kind === "status" && /분째 응답 없음/.test(event.label)), "무음 경고가 났다");
  assert.equal("userWaitingMs" in result.runMetrics, false, "질문을 쓰지 않은 실행의 지표에는 대기 시간 필드가 없다");
});

test("답을 기다리는 동안은 시간 제한이 멈추고 무음 경고가 나지 않으며, 답이 오면 이어서 끝난다", async () => {
  let waiting = false;
  const violations = [];
  const run = runSlow({
    timeoutMs: 500,
    silenceWarningMs: 100,
    onEvent: (event) => {
      if (waiting && event.kind === "status" && /분째 응답 없음/.test(event.label)) violations.push(event.label);
    },
  });
  await sleep(100);
  waiting = true;
  run.setWaitingUser(true);
  await sleep(500); // 총 경과 600ms > timeoutMs(500)지만 이 시간은 세지 않는다.
  waiting = false;
  run.setWaitingUser(false);
  const result = await run.promise;
  assert.equal(result.ok, true, "시간 제한으로 죽지 않았다");
  assert.equal(result.text, "끝");
  assert.deepEqual(violations, [], "기다리는 동안 무음 경고가 없다");
  assert.ok(result.runMetrics.userWaitingMs >= 450, `대기 시간이 따로 남는다: ${result.runMetrics.userWaitingMs}`);
  assert.equal(
    result.runMetrics.modelDurationMs,
    result.runMetrics.durationMs - result.runMetrics.userWaitingMs,
    "모델 실행 시간은 전체에서 대기를 뺀 값이다"
  );
});

test("기다림이 끝난 뒤 남은 시간만큼은 다시 제한이 걸린다(제한이 영영 사라지지 않는다)", async () => {
  const run = runAgentProcess({
    commandPath: process.execPath,
    argv: ["-e", "setTimeout(() => {}, 5000)"],
    prompt: "",
    cwd: os.tmpdir(),
    timeoutMs: 400,
    silenceWarningMs: 0,
  });
  await sleep(100);
  run.setWaitingUser(true);
  await sleep(300);
  const resumedAt = Date.now();
  run.setWaitingUser(false);
  const result = await run.promise;
  assert.equal(result.timedOut, true);
  const spent = Date.now() - resumedAt;
  assert.ok(spent >= 150 && spent < 1500, `남은 약 300ms 뒤에 멈춘다: ${spent}ms`);
});

test("답을 기다리다 끝난 실행도 기다린 시간을 지표에 남기고, 끝난 뒤의 호출은 아무 일도 하지 않는다", async () => {
  const run = runAgentProcess({
    commandPath: process.execPath,
    argv: ["-e", "setTimeout(() => process.stdout.write('x'), 300)"],
    prompt: "",
    cwd: os.tmpdir(),
    silenceWarningMs: 0,
  });
  await sleep(50);
  run.setWaitingUser(true);
  const result = await run.promise;
  assert.ok(result.runMetrics.userWaitingMs >= 200, `${result.runMetrics.userWaitingMs}`);
  assert.doesNotThrow(() => run.setWaitingUser(false));
  assert.doesNotThrow(() => run.setWaitingUser(true));
});

test("extraEnv는 그 실행의 자식 프로세스에만 더해지고, 주지 않으면 환경을 건드리지 않는다", async () => {
  const script = "process.stdout.write(String(process.env.AGORA_TEST_EXTRA_ENV))";
  const base = { commandPath: process.execPath, argv: ["-e", script], prompt: "", cwd: os.tmpdir(), silenceWarningMs: 0 };
  assert.equal((await runAgentProcess({ ...base, extraEnv: { AGORA_TEST_EXTRA_ENV: "켜짐" } }).promise).text, "켜짐");
  assert.equal((await runAgentProcess(base).promise).text, "undefined");
  assert.equal(process.env.AGORA_TEST_EXTRA_ENV, undefined);
});

test("대기 시간은 지표 파일에도 저장된다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-qmetrics-"));
  const metrics = buildRunMetrics({ startedAt: 1000, finishedAt: 9000, promptChars: 5, userWaitingMs: 6000, result: { ok: true } });
  assert.equal(metrics.userWaitingMs, 6000);
  assert.equal(metrics.modelDurationMs, 2000);
  const saved = persistRunMetrics({ store: { runLogsDir: () => dir }, sessionId: "s", runId: "r1", provider: "claude", metrics });
  assert.equal(saved.ok, true);
  const written = JSON.parse(fs.readFileSync(saved.file, "utf8"));
  assert.equal(written.userWaitingMs, 6000);
  assert.equal(written.modelDurationMs, 2000);
  // 질문을 쓰지 않은 지표는 모양이 그대로다.
  const plain = buildRunMetrics({ startedAt: 1000, finishedAt: 2000, result: { ok: true } });
  assert.equal("userWaitingMs" in plain, false);
  assert.equal("modelDurationMs" in plain, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
