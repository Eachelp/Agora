"use strict";

// Stage C-1/C-2 — HarnessAdapter / ProcessHarnessAdapter 계약 회귀 테스트.
//
// 검증 목표:
//   1) HarnessAdapter 경계의 최소 contract(runTurn)와 fail-closed 기본 동작.
//   2) capability hook(supportsPersistentSession) 기본값.
//   3) ProcessHarnessAdapter가 canonical { context, invocation }에서 invocation만
//      꺼내 process runner에 재작성 없이 위임하는지(+ flat 최소 호환).
//   4) 기본 어댑터가 실제 runAgentProcess로 one-shot 실행을 그대로 보존하는지.

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

test("HarnessAdapter id는 주지 않으면 null, capability 기본은 false다", () => {
  const base = new HarnessAdapter();
  assert.equal(base.id, null);
  assert.equal(base.supportsPersistentSession, false);
  assert.equal(new HarnessAdapter({ supportsPersistentSession: true }).supportsPersistentSession, true);
});

test("ProcessHarnessAdapter는 HarnessAdapter이며 id=process, persistent=false다", () => {
  const adapter = new ProcessHarnessAdapter({ runProcess: () => ({ promise: Promise.resolve({ ok: true }), cancel() {} }) });
  assert.ok(adapter instanceof HarnessAdapter);
  assert.equal(adapter.id, "process");
  assert.equal(adapter.supportsPersistentSession, false);
});

test("runTurn은 canonical { context, invocation }에서 invocation만 재작성 없이 위임한다", async () => {
  let received = null;
  const handle = { promise: Promise.resolve({ ok: true, text: "위임됨" }), cancel() {} };
  const adapter = new ProcessHarnessAdapter({
    runProcess: (invocation) => {
      received = invocation;
      return handle;
    },
  });

  const invocation = {
    commandPath: NODE,
    needsShell: false,
    argv: ["-e", "process.stdout.write('x')"],
    prompt: "계약",
    promptTransport: "stdin",
    cwd: os.tmpdir(),
    requireFinal: true,
  };
  const context = { role: "implementation", providerId: "claude" };
  const returned = adapter.runTurn({ context, invocation });

  // invocation 객체 그대로(권한/모델/argv/effort 재해석 금지). context는 실행에 안 쓰임.
  assert.equal(received, invocation);
  assert.equal(returned, handle);
  assert.equal((await returned.promise).text, "위임됨");
});

test("flat invocation 최소 호환 bridge: invocation 키가 없으면 request 자체를 위임한다", () => {
  let received = null;
  const adapter = new ProcessHarnessAdapter({
    runProcess: (invocation) => { received = invocation; return { promise: Promise.resolve({ ok: true }), cancel() {} }; },
  });
  const flat = { commandPath: NODE, argv: [], prompt: "" };
  adapter.runTurn(flat);
  assert.equal(received, flat);
});

test("runTurn의 cancel은 하부 runner의 cancel을 그대로 통과시킨다", () => {
  let cancelled = 0;
  const adapter = new ProcessHarnessAdapter({
    runProcess: () => ({ promise: new Promise(() => {}), cancel: () => { cancelled += 1; } }),
  });
  const run = adapter.runTurn({ context: null, invocation: {} });
  run.cancel();
  assert.equal(cancelled, 1);
});

test("기본 ProcessHarnessAdapter는 실제 프로세스를 띄워 one-shot 실행을 보존한다", async () => {
  const adapter = new ProcessHarnessAdapter();
  const run = adapter.runTurn({
    context: null,
    invocation: {
      commandPath: NODE,
      argv: ["-e", "process.stdout.write('완료')"],
      prompt: "abc",
      cwd: os.tmpdir(),
    },
  });
  const result = await run.promise;

  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  assert.equal(result.runMetrics.schemaVersion, 1);
  assert.equal(result.runMetrics.stopReason, "COMPLETED");
});
