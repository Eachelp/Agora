"use strict";

// Stage C-1 — HarnessAdapter / ProcessHarnessAdapter 계약 회귀 테스트.
//
// 검증 목표:
//   1) HarnessAdapter 경계 자체의 최소 contract(runTurn)와 fail-closed 기본 동작.
//   2) ProcessHarnessAdapter가 기존 process 실행을 "그대로" 위임하는지
//      (요청 재작성 없음, 반환 handle 변형 없음, cancel 통과).
//   3) 기본 어댑터가 실제 runAgentProcess로 프로세스를 띄워 one-shot 실행
//      semantics를 그대로 보존하는지(end-to-end).

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { HarnessAdapter } = require("../src/harness/harness-adapter");
const { ProcessHarnessAdapter } = require("../src/harness/process-harness-adapter");

const NODE = process.execPath;

test("HarnessAdapter 기본 runTurn은 fail-closed로 명시적 오류를 던진다", () => {
  const base = new HarnessAdapter({ id: "base" });
  assert.equal(base.id, "base");
  assert.throws(() => base.runTurn({}), /runTurn을 구현하지 않았습니다/);
});

test("HarnessAdapter id는 주지 않으면 null이다", () => {
  const base = new HarnessAdapter();
  assert.equal(base.id, null);
});

test("ProcessHarnessAdapter는 HarnessAdapter이며 id는 process다", () => {
  const adapter = new ProcessHarnessAdapter({ runProcess: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }) });
  assert.ok(adapter instanceof HarnessAdapter);
  assert.equal(adapter.id, "process");
});

test("runTurn은 요청 객체를 재작성 없이 그대로 process runner에 위임한다", async () => {
  let received = null;
  const handle = { promise: Promise.resolve({ ok: true, text: "위임됨" }), cancel() {} };
  const adapter = new ProcessHarnessAdapter({
    runProcess: (request) => {
      received = request;
      return handle;
    },
  });

  const request = {
    commandPath: NODE,
    needsShell: false,
    argv: ["-e", "process.stdout.write('x')"],
    prompt: "계약",
    promptTransport: "stdin",
    cwd: os.tmpdir(),
    requireFinal: true,
  };
  const returned = adapter.runTurn(request);

  // 요청은 동일 객체 그대로 전달되어야 한다(권한/모델/argv/effort 재해석 금지).
  assert.equal(received, request);
  // 반환 handle도 변형 없이 그대로 넘어와야 한다({ promise, cancel } 계약 보존).
  assert.equal(returned, handle);
  const result = await returned.promise;
  assert.equal(result.text, "위임됨");
});

test("runTurn의 cancel은 하부 runner의 cancel을 그대로 통과시킨다", () => {
  let cancelled = 0;
  const adapter = new ProcessHarnessAdapter({
    runProcess: () => ({ promise: new Promise(() => {}), cancel: () => { cancelled += 1; } }),
  });
  const run = adapter.runTurn({});
  run.cancel();
  assert.equal(cancelled, 1);
});

test("기본 ProcessHarnessAdapter는 실제 프로세스를 띄워 one-shot 실행을 보존한다", async () => {
  const adapter = new ProcessHarnessAdapter();
  const run = adapter.runTurn({
    commandPath: NODE,
    argv: ["-e", "process.stdout.write('완료')"],
    prompt: "abc",
    cwd: os.tmpdir(),
  });
  const result = await run.promise;

  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  // 기존 runner의 canonical 산출물(runMetrics)이 어댑터 경유에도 그대로 붙는다.
  assert.equal(result.runMetrics.schemaVersion, 1);
  assert.equal(result.runMetrics.stopReason, "COMPLETED");
});
