"use strict";

// Stage C — AGYManagedAdapter behavior (fake runProcess; no real AGY/account/network).
//
// 핵심(실환경 AGY 1.1.13 hazard): invalid --conversation A는 not-found 후 fresh
// conversation B를 만들어 status SUCCESS/exit 0으로 반환한다. 따라서 exit/status가 아니라
// returned conversation_id === requested id (exact equality)만 continuity success다. fake는
// 이 위험한 실동작(SUCCESS + 새 ID)을 반드시 재현한다(§64).

const test = require("node:test");
const assert = require("node:assert/strict");

const { AGYManagedAdapter } = require("../src/harness/agy/agy-managed-adapter");
const { createDefaultHarnessRuntime } = require("../src/harness/create-default-harness-runtime");
const { HarnessAdapter } = require("../src/harness/harness-adapter");
const { createLineParser } = require("../src/chat/chat-events");
const { buildRunMetrics } = require("../src/chat/chat-run-metrics");

const ID_A = "3e956416-c263-47da-9ab0-052c056cf28e";
const ID_B = "11111111-2222-3333-4444-555555555555";

// 기존 standard one-shot AGY argv(§16)와 동형. --no-session-persistence류 없음.
// adapter는 이 배열을 받아 최소 변환한다(원본은 변형하지 않는다).
const BASE_ARGV = Object.freeze([
  "--sandbox", "--disable-slash-commands", "--output-format", "stream-json",
  "--print-timeout", "10h", "--model", "gemini-3.7-flash-low", "--mode", "plan",
]);

// 실환경에서 확인된 stream-json 위치에 conversation_id를 싣는 AGY 줄.
function agyLine(kind, id) {
  if (kind === "init") return JSON.stringify({ event: "init", conversation_id: id });
  if (kind === "step") return JSON.stringify({ event: "step_update", step_update: { conversation_id: id } });
  if (kind === "result") return JSON.stringify({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "ok" } });
  return "";
}

function inv(over = {}) {
  return { commandPath: "agy", needsShell: false, argv: [...BASE_ARGV], prompt: "AUTH-PROMPT", cwd: "/ws", promptTransport: "argv", requireFinal: true, ...over };
}
function ctx(over = {}) {
  return {
    projectId: "p", workspaceId: "/ws", professionalRunId: "pr-1", role: "implementation",
    providerId: "agy", modelKey: "gemini-3.7-flash-low", permissionMode: "workspace-write", effort: "low", ...over,
  };
}
const session = (key, generation = 1) => ({ key, generation });

// 실 실행이 남기는 것과 동형인 풍부한 결과(실 duration·evidence·output·RunMetrics).
function richOk(over = {}) {
  const evidence = {
    commands: [{ kind: "command-finished", command: "ls" }],
    commandSummary: { total: 3, failed: 1, truncated: 0 },
    toolSummary: { started: 4, finished: 4, failed: 0, truncated: 0, outputBytes: 100, uniqueTargets: 2, repeatedCalls: 1, maxRepeatCount: 2 },
    exploration: { status: "NORMAL" },
  };
  const output = { stdoutBytes: 4096, captureTruncated: true };
  const START = 1000, FINISH = 3500;
  const result = { ok: true, text: "trusted answer", evidence, output };
  result.runMetrics = buildRunMetrics({ provider: "agy", model: "gemini-3.7-flash-low", effort: "low", stage: "implementation", startedAt: START, finishedAt: FINISH, promptChars: 12, result });
  return { evidence, output, durationMs: FINISH - START, result: { ...result, ...over } };
}

// scripted fake runProcess.
// behavior: { conversationId?, emit?[{kind,id}], result?, pending?, throw?, onCancel? }
function makeAdapter(script) {
  const calls = [];
  let cancels = 0;
  const runProcess = (invocation) => {
    const index = calls.length;
    const beh = (typeof script === "function" ? script(index, invocation) : Array.isArray(script) ? script[index] : script) || {};
    if (beh.throw) { calls.push({ argv: invocation.argv, prompt: invocation.prompt, threw: true }); throw new Error(beh.throw); }
    let emits = beh.emit;
    if (!emits && beh.conversationId !== undefined) {
      emits = beh.conversationId == null ? [] : [{ kind: "init", id: beh.conversationId }, { kind: "result", id: beh.conversationId }];
    }
    for (const e of (emits || [])) {
      if (e && e.id != null && typeof invocation.parseLine === "function") invocation.parseLine(agyLine(e.kind, e.id));
    }
    calls.push({ argv: invocation.argv, prompt: invocation.prompt, parseLine: invocation.parseLine });
    if (beh.deferUntilCancel) {
      // run.cancel()이 호출될 때 비로소 result로 resolve된다(mismatch 관측 즉시 취소를 모델).
      let resolveFn;
      const promise = new Promise((res) => { resolveFn = res; });
      return { promise, cancel: () => { cancels += 1; if (beh.onCancel) beh.onCancel(); resolveFn(beh.result || { ok: false, cancelled: true, error: "중지됨" }); } };
    }
    const promise = beh.pending ? new Promise(() => {}) : Promise.resolve(beh.result || { ok: true, text: "answer" });
    return { promise, cancel: () => { cancels += 1; if (beh.onCancel) beh.onCancel(); } };
  };
  const adapter = new AGYManagedAdapter({ runProcess });
  return { adapter, calls, cancels: () => cancels };
}
const convIndex = (argv) => argv.indexOf("--conversation");

test("A. AGYManagedAdapter는 HarnessAdapter이며 id=agy-managed, persistent=true", () => {
  const a = new AGYManagedAdapter();
  assert.ok(a instanceof HarnessAdapter);
  assert.equal(a.id, "agy-managed");
  assert.equal(a.supportsPersistentSession, true);
});

test("B. 첫 turn: base argv 그대로(--conversation/--continue 없음) + conversation_id capture + binding", async () => {
  const { adapter, calls } = makeAdapter([{ conversationId: ID_A, result: { ok: true, text: "hello" } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, "hello");
  assert.equal(calls.length, 1);
  assert.equal(convIndex(calls[0].argv), -1, "첫 turn: --conversation 없음");
  assert.equal(calls[0].argv.includes("--continue"), false);
});

test("C. same key+generation 2번째 turn은 정확히 --conversation <capturedId>로 잇는다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true, text: i === 0 ? "one" : "two" } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) }).promise;
  assert.equal(r2.text, "two");
  const i = convIndex(calls[1].argv);
  assert.ok(i >= 0 && calls[1].argv[i + 1] === ID_A, "정확히 캡처된 conversation만 resume");
});

test("D. authoritative prompt는 매 turn 전체 재전송된다(resume이라고 축약하지 않는다)", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true, text: String(i) } }));
  const P = "=== 전문 모드: BUILDER ===\nRules/Frozen Task/current instruction 전체가 담긴 authoritative prompt";
  await adapter.runTurn({ context: ctx(), invocation: inv({ prompt: P }), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv({ prompt: P }), session: session("kA") }).promise;
  assert.equal(calls[0].prompt, P);
  assert.equal(calls[1].prompt, P, "resume turn도 프롬프트 전체 재전송");
});

test("E. role/run/workspace가 다르면 다른 native conversation이다(교차 resume 없음)", async () => {
  // 다른 lineage(role/run)는 old conversation이 살아 있으므로 switch-back 시 resume된다.
  // workspaceId는 project-wide WORKSPACE_CHANGED 이벤트가 lifecycle boundary이므로
  // (harness-runtime lifecycle 테스트에서 검증) 여기서는 키 격리만 확인한다.
  const dims = [
    ["role", { role: "implementation" }, { role: "review" }, "resume"],
    ["professionalRunId", { professionalRunId: "pr-1" }, { professionalRunId: "pr-2" }, "resume"],
    ["workspaceId", { workspaceId: "/wsA" }, { workspaceId: "/wsB" }, null],
  ];
  for (const [label, A, B, switchBack] of dims) {
    const { adapter, calls } = makeAdapter((i) =>
      i === 1 ? { conversationId: ID_B, result: { ok: true, text: "B1" } }
              : { conversationId: ID_A, result: { ok: true, text: "A" } });
    const rt = createDefaultHarnessRuntime({ agyAdapter: adapter });
    await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
    await rt.runTurn({ context: ctx(B), invocation: inv() }).promise;
    assert.equal(convIndex(calls[0].argv), -1, `${label}: A 첫 turn`);
    assert.equal(convIndex(calls[1].argv), -1, `${label}: B는 다른 conversation(첫 turn)`);
    if (switchBack === "resume") {
      await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
      const ci = convIndex(calls[2].argv);
      assert.ok(ci >= 0 && calls[2].argv[ci + 1] === ID_A, `${label}: 같은 키 A는 resume ID_A`);
    }
  }
});

test("E2. model/permission 전환 뒤 switch-back은 old conversation을 부활시키지 않는다(fresh 세대)", async () => {
  // Stage C lifecycle: 같은 lineage에서 modelKey/permissionMode가 바뀌면 old
  // sibling이 RETIRE되므로, A로 되돌아와도 old conversation을 --conversation으로 잇지 않는다.
  const dims = [
    ["modelKey", { modelKey: "gemini-3.7-flash-low" }, { modelKey: "gemini-3.6-flash-low" }],
    ["permissionMode", { permissionMode: "workspace-write" }, { permissionMode: "workspace-read" }],
  ];
  for (const [label, A, B] of dims) {
    const { adapter, calls } = makeAdapter((i) =>
      i === 1 ? { conversationId: ID_B, result: { ok: true, text: "B1" } }
              : { conversationId: ID_A, result: { ok: true, text: "A" } });
    const rt = createDefaultHarnessRuntime({ agyAdapter: adapter });
    const r1 = await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
    await rt.runTurn({ context: ctx(B), invocation: inv() }).promise;
    const r3 = await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
    assert.equal(convIndex(calls[0].argv), -1, `${label}: A 첫 turn`);
    assert.equal(convIndex(calls[1].argv), -1, `${label}: B는 다른 conversation(첫 turn)`);
    assert.equal(convIndex(calls[2].argv), -1, `${label}: switch-back A는 old resume 금지(fresh)`);
    assert.equal(r1.ok, true);
    assert.equal(r3.ok, true);
  }
});

test("J. same logical session 동시 turn -> SESSION_BUSY (registry single-flight)", async () => {
  const { adapter } = makeAdapter([{ pending: true }]);
  const rt = createDefaultHarnessRuntime({ agyAdapter: adapter });
  const run1 = rt.runTurn({ context: ctx(), invocation: inv() }); // pending
  const r2 = await rt.runTurn({ context: ctx(), invocation: inv() }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "SESSION_BUSY");
  run1.cancel();
});

test("K/L/AH. default runtime: Professional AGY -> managed; general chat/default model -> Process", async () => {
  const { adapter, calls } = makeAdapter([{ conversationId: ID_A, result: { ok: true, text: "m" } }]);
  const procCalls = [];
  const proc = { id: "process", supportsPersistentSession: false, runTurn(r) { procCalls.push(r); return { promise: Promise.resolve({ ok: true, tag: "proc" }), cancel() {} }; } };
  const rt = createDefaultHarnessRuntime({ agyAdapter: adapter, processAdapter: proc });
  await rt.runTurn({ context: ctx(), invocation: inv() }).promise;                                       // professional -> managed
  await rt.runTurn({ context: ctx({ role: null, professionalRunId: null }), invocation: inv() }).promise; // general chat -> process
  await rt.runTurn({ context: ctx({ modelKey: "default" }), invocation: inv() }).promise;                // default model -> process
  assert.equal(calls.length, 1, "managed는 professional 1회");
  assert.equal(procCalls.length, 2, "general chat/default는 Process");
});

test("M. 첫 turn 정상 완료지만 conversation_id 없음 -> AGY_CONVERSATION_ID_MISSING, binding 없음(재시도 허용)", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { emit: [], result: { ok: true, text: "no-id" } }
    : { conversationId: ID_A, result: { ok: true, text: "retry" } });
  const r1 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r1.ok, false);
  assert.equal(r1.stopReason, "AGY_CONVERSATION_ID_MISSING");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, true, "확정된 conversation이 없었으므로 재시도는 새 conversation으로 허용");
  assert.equal(convIndex(calls[1].argv), -1, "재시도는 첫 turn(새 conversation)");
});

test("N. 첫 turn 서로 다른 conversation_id(init A, result B) -> AGY_CONVERSATION_ID_MISMATCH, binding 없음", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { emit: [{ kind: "init", id: ID_A }, { kind: "result", id: ID_B }], result: { ok: true, text: "x" } }
    : { conversationId: ID_A, result: { ok: true, text: "retry" } });
  const r1 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r1.ok, false);
  assert.equal(r1.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, true, "binding 없음(poison 아님) -> 새 첫 turn 재시도");
  assert.equal(convIndex(calls[1].argv), -1);
});

test("O. resume success same ID -> success, binding 유지(연속 resume)", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true, text: `t${i}` } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  for (const idx of [1, 2]) {
    const ci = convIndex(calls[idx].argv);
    assert.ok(ci >= 0 && calls[idx].argv[ci + 1] === ID_A, `turn${idx + 1} resume ID_A`);
  }
});

test("P. [CRITICAL] AGY invalid-resume(provider SUCCESS + 새 conversation B): 채택 금지 -> MISMATCH + poison + 재실행 없음", async () => {
  // turn0 정상 -> binding A. turn1: A resume 요청, provider가 not-found 후 B를 만들어 SUCCESS 반환.
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [{ kind: "init", id: ID_B }, { kind: "step", id: ID_B }, { kind: "result", id: ID_B }], result: { ok: true, text: "INVALID" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false, "provider가 SUCCESS(ok:true)여도 Agora는 FAIL");
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  // 요청 argv는 정확히 bound A였다(B로 바꾸지 않았다)
  const ci = convIndex(calls[1].argv);
  assert.ok(ci >= 0 && calls[1].argv[ci + 1] === ID_A, "요청은 정확히 bound A");
  // B 채택 금지: 다음 turn은 poison된 handle로 fail-closed, 프로세스 미실행
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.ok, false);
  assert.equal(r3.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(calls.length, 2, "poison된 handle은 새 AGY 프로세스를 띄우지 않는다(B 재사용 금지)");
});

test("Q. resume 정상 완료지만 conversation_id 없음 -> AGY_CONVERSATION_ID_MISSING + poison", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [], result: { ok: true, text: "two" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISSING");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "AGY_CONVERSATION_ID_MISSING");
  assert.equal(calls.length, 2);
});

test("R. resume ordinary execution failure -> AGY_CONVERSATION_RESUME_FAILED (fresh fallback 없음) + poison", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [], result: { ok: false, error: "종료 코드 1" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_CONVERSATION_RESUME_FAILED");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "AGY_CONVERSATION_RESUME_FAILED");
  assert.equal(calls.length, 2);
});

test("S/T/U. resume cancel/timeout/output-limit -> 원래 verdict 보존 + poison + 다음 turn AGY_CONVERSATION_LOST", async () => {
  for (const abn of [{ cancelled: true }, { timedOut: true }, { outputLimited: true }]) {
    const { adapter, calls } = makeAdapter((i) => i === 0
      ? { conversationId: ID_A, result: { ok: true, text: "one" } }
      : { emit: [], result: { ok: false, ...abn, error: "x" } });
    await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    for (const k of Object.keys(abn)) assert.equal(r2[k], true, `${JSON.stringify(abn)} verdict 보존`);
    const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    assert.equal(r3.stopReason, "AGY_CONVERSATION_LOST", JSON.stringify(abn));
    assert.equal(calls.length, 2, JSON.stringify(abn));
  }
});

test("V. 실행 후 resume mismatch: 실 output/evidence/RunMetrics(duration·tool) 보존, 판정만 뒤집기", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [{ kind: "init", id: ID_B }, { kind: "result", id: ID_B }], result: rich.result });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(r2.output, rich.output, "실 output 보존");
  assert.equal(r2.evidence, rich.evidence, "실 evidence 보존");
  assert.equal(r2.runMetrics.durationMs, rich.durationMs, "실 duration 보존(zero-duration 아님)");
  assert.equal(r2.runMetrics.tools.started, 4, "tool metrics 보존");
  assert.equal(r2.runMetrics.commands.total, 3, "command metrics 보존");
  assert.equal(r2.runMetrics.stdoutBytes, 4096, "output metrics 보존");
  assert.equal(r2.runMetrics.ok, false);
  assert.equal(r2.runMetrics.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(r2.text, undefined, "신뢰 못하는 답변은 text에서 제거");
  assert.equal(r2.partialText, "trusted answer", "부분 출력으로 강등 보존");
});

test("W. 실행 후 resume missing-ID: 실 telemetry 보존 + AGY_CONVERSATION_ID_MISSING + poison", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [], result: rich.result });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISSING");
  assert.equal(r2.output, rich.output);
  assert.equal(r2.runMetrics.durationMs, rich.durationMs, "실 duration 보존");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.runMetrics.durationMs, 0, "poison된 재사용은 static(zero-duration)");
});

test("X. 실행하지 않은 static fail만 zero-duration metrics를 갖는다", async () => {
  const { adapter, calls } = makeAdapter([{ result: { ok: true } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: { generation: 1 } }).promise; // no key
  assert.equal(r.stopReason, "AGY_TURN_START_FAILED");
  assert.equal(r.runMetrics.durationMs, 0, "static fail은 zero-duration");
  assert.equal(r.runMetrics.startedAt, r.runMetrics.finishedAt);
  assert.equal(calls.length, 0);
});

test("Y. adapter는 base argv를 최소 변환한다(전 flag 보존, first=--conversation 없음, resume=exact 추가, 원본 불변)", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kY") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kY") }).promise;
  for (const flag of BASE_ARGV) assert.ok(calls[0].argv.includes(flag), `first 보존: ${flag}`);
  assert.equal(convIndex(calls[0].argv), -1, "first: --conversation 없음");
  for (const flag of BASE_ARGV) assert.ok(calls[1].argv.includes(flag), `resume 보존: ${flag}`);
  const ci = convIndex(calls[1].argv);
  assert.ok(ci >= 0 && calls[1].argv[ci + 1] === ID_A, "resume: exact --conversation");
  assert.deepEqual([...BASE_ARGV], ["--sandbox", "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "10h", "--model", "gemini-3.7-flash-low", "--mode", "plan"], "입력 원본 불변");
});

test("Z. managed argv는 --continue/-c를 절대 쓰지 않는다; base argv에 있으면 fail-closed", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kZ") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kZ") }).promise;
  for (const c of calls) {
    assert.equal(c.argv.includes("--continue"), false, "--continue 금지");
    assert.equal(c.argv.includes("-c"), false, "-c 금지");
  }
  // base argv에 --continue가 있으면 managed adapter는 fail-closed(모호한 native 선택 거부)
  const bad = makeAdapter([{ conversationId: ID_A, result: { ok: true } }]);
  const r = await bad.adapter.runTurn({ context: ctx(), invocation: inv({ argv: ["--sandbox", "--continue", "--output-format", "stream-json"] }), session: session("kBad") }).promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "AGY_TURN_START_FAILED");
  assert.equal(bad.calls.length, 0, "위험 argv는 실행하지 않음");
});

test("AA. resume turn은 캐시된 argv가 아니라 현재 turn의 model/effort argv를 사용한다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true, text: `t${i}` } }));
  const argv1 = ["--sandbox", "--output-format", "stream-json", "--model", "gemini-3.7-flash-low", "--effort", "low", "--mode", "plan"];
  const argv2 = ["--sandbox", "--output-format", "stream-json", "--model", "gemini-3.7-flash-high", "--effort", "high", "--mode", "plan"];
  await adapter.runTurn({ context: ctx(), invocation: inv({ argv: argv1 }), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv({ argv: argv2 }), session: session("kA") }).promise;
  const ei = calls[1].argv.indexOf("--effort");
  assert.ok(ei >= 0 && calls[1].argv[ei + 1] === "high", "turn2의 현재 effort 사용");
  assert.ok(calls[1].argv.includes("gemini-3.7-flash-high"), "turn2의 현재 model 사용");
  assert.equal(calls[1].argv.includes("gemini-3.7-flash-low"), false, "turn1 model 재사용 금지");
  const ci = calls[1].argv.indexOf("--conversation");
  assert.ok(ci >= 0 && calls[1].argv[ci + 1] === ID_A);
});

test("AB. resume turn은 현재 invocation의 permission/mode/sandbox/auto-approve argv를 사용한다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true } }));
  const argvA = ["--sandbox", "--output-format", "stream-json", "--mode", "plan", "--add-dir", "/wsA"];
  const argvB = ["--sandbox", "--output-format", "stream-json", "--mode", "accept-edits", "--add-dir", "/wsA", "--dangerously-skip-permissions"];
  await adapter.runTurn({ context: ctx(), invocation: inv({ argv: argvA }), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv({ argv: argvB }), session: session("kA") }).promise;
  assert.ok(calls[1].argv.includes("accept-edits"), "turn2의 현재 mode 사용");
  assert.ok(calls[1].argv.includes("--dangerously-skip-permissions"), "turn2의 현재 auto-approve 사용");
  assert.equal(calls[1].argv.includes("plan"), false, "turn1 mode 재사용 금지");
});

test("AC. conversation_id는 harness-only다: parser는 event로 노출하지 않고 onConversationId로만 알린다", () => {
  const seen = [];
  const parse = createLineParser("agy", { onConversationId: (id) => seen.push(id) });
  const initEvent = parse(agyLine("init", ID_A));
  assert.equal(initEvent, null, "init 줄은 정규화 이벤트를 만들지 않는다");
  assert.deepEqual(seen, [ID_A]);
  const stepEvent = parse(agyLine("step", ID_A));
  assert.equal(stepEvent, null, "도구 없는 step_update도 이벤트 없음");
  assert.deepEqual(seen, [ID_A, ID_A]);
  const resultEvent = parse(agyLine("result", ID_A));
  assert.equal(resultEvent.kind, "final");
  assert.equal(JSON.stringify(resultEvent).includes(ID_A), false, "정규화 event에 conversation_id leak 없음");
  assert.deepEqual(seen, [ID_A, ID_A, ID_A]);
});

test("AD. 정상 managed turn의 evidence/output/runMetrics는 변형 없이 그대로 통과한다", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter([{ conversationId: ID_A, result: rich.result }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.evidence, rich.evidence, "evidence 참조 그대로");
  assert.equal(r.runMetrics, rich.result.runMetrics, "runMetrics 참조 그대로(재계산 없음)");
  assert.equal(r.output, rich.output, "output 참조 그대로");
});

test("AE. strict-final 누락(protocolFailed, exit 0)이라도 conversation_id가 있으면 binding을 만든다", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: false, protocolFailed: true, stopReason: "PROTOCOL_FINAL_MISSING", partialText: "부분" } }
    : { conversationId: ID_A, result: { ok: true, text: "recovered" } });
  const r1 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r1.protocolFailed, true);
  assert.equal(r1.stopReason, "PROTOCOL_FINAL_MISSING", "결과 그대로 통과(성공 승격 아님)");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, true);
  const ci = convIndex(calls[1].argv);
  assert.ok(ci >= 0 && calls[1].argv[ci + 1] === ID_A, "protocolFailed 후에도 같은 conversation resume");
});

test("V2. cancel은 하부 runner cancel로 전달된다", () => {
  let cancelled = 0;
  const runProcess = () => ({ promise: new Promise(() => {}), cancel: () => { cancelled += 1; } });
  const adapter = new AGYManagedAdapter({ runProcess });
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") });
  run.cancel();
  assert.equal(cancelled, 1);
});

test("close(). close()는 provider-local binding/invalidation 상태를 비운다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ conversationId: ID_A, result: { ok: true, text: `t${i}` } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  adapter.close();
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(convIndex(calls[1].argv), -1, "close 후에는 binding이 없어 새 conversation(첫 turn)");
});


// ================= C-review safety fix: immediate mismatch termination + argv authority =================

test("P2. [REVIEW] resume 중 native id mismatch 관측 즉시 run cancel; verdict는 MISMATCH(CANCELLED/LOST 아님) + partial telemetry 보존", async () => {
  // turn0 정상 -> binding A. turn1: init이 B를 동기 emit, provider result는 run.cancel() 전까지 미결.
  const evidence = {
    commandSummary: { total: 2, failed: 0, truncated: 0 },
    toolSummary: { started: 1, finished: 1, failed: 0, truncated: 0, outputBytes: 10, uniqueTargets: 1, repeatedCalls: 0, maxRepeatCount: 1 },
    exploration: { status: "NORMAL" },
  };
  const output = { stdoutBytes: 128, captureTruncated: false };
  const partial = {
    ok: false, cancelled: true, error: "중지됨", evidence, output,
    runMetrics: buildRunMetrics({ provider: "agy", model: "gemini-3.7-flash-low", effort: "low", stage: "implementation", startedAt: 100, finishedAt: 900, promptChars: 5, result: { ok: false, cancelled: true, evidence, output } }),
  };
  const { adapter, calls, cancels } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [{ kind: "init", id: ID_B }], deferUntilCancel: true, result: partial });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;

  // mismatch 관측 즉시 하부 run을 취소했다(동기 emit race 포함).
  assert.equal(cancels(), 1, "mismatch 관측 즉시 run.cancel() 호출");
  // 최종 verdict는 MISMATCH — CANCELLED/LOST로 강등되지 않는다.
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(r2.cancelled, undefined, "cancelled verdict로 강등되지 않음");
  assert.equal(r2.runMetrics.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  // 종료 전까지 나온 Evidence/output/RunMetrics(duration·tool) 보존.
  assert.equal(r2.output, output, "종료 전 output 보존");
  assert.equal(r2.evidence, evidence, "종료 전 evidence 보존");
  assert.equal(r2.runMetrics.durationMs, 800, "종료 전 duration 보존(zero 아님)");
  assert.equal(r2.runMetrics.tools.started, 1, "종료 전 tool metrics 보존");
  assert.equal(r2.runMetrics.stdoutBytes, 128, "종료 전 output metrics 보존");
  // B 채택 금지 + poison + 다음 same-handle turn은 프로세스를 띄우지 않는다.
  const ci = calls[1].argv.indexOf("--conversation");
  assert.ok(ci >= 0 && calls[1].argv[ci + 1] === ID_A, "요청은 정확히 bound A(B로 바꾸지 않음)");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.ok, false);
  assert.equal(r3.stopReason, "AGY_CONVERSATION_ID_MISMATCH", "poison된 handle은 MISMATCH로 fail-closed");
  assert.equal(calls.length, 2, "poison된 handle은 새 AGY 프로세스를 띄우지 않는다");
});

test("P3. [REVIEW] mismatch 후 run이 결국 SUCCESS로 끝나도(취소 미반영) verdict는 여전히 MISMATCH", async () => {
  // 하부 run이 cancel을 무시하고 SUCCESS(ok:true, 새 conversation B)로 resolve되는 defense-in-depth.
  const { adapter, calls, cancels } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : { emit: [{ kind: "init", id: ID_B }, { kind: "step", id: ID_B }, { kind: "result", id: ID_B }], result: { ok: true, text: "INVALID (provider SUCCESS with B)" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(cancels(), 1, "SUCCESS로 끝나더라도 mismatch 관측 즉시 cancel은 시도된다");
  assert.equal(r2.ok, false, "provider SUCCESS여도 Agora FAIL");
  assert.equal(r2.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(r2.text, undefined, "B의 답변을 성공으로 채택하지 않음");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "AGY_CONVERSATION_ID_MISMATCH");
  assert.equal(calls.length, 2, "poison된 handle 재실행 없음");
});

test("AB2. [REVIEW] base argv가 이미 --conversation을 가지면 실행 전에 fail-closed(adapter가 유일한 conversation authority)", async () => {
  // 공백 형식
  const a = makeAdapter([{ conversationId: ID_A, result: { ok: true } }]);
  const r = await a.adapter.runTurn({ context: ctx(), invocation: inv({ argv: ["--sandbox", "--conversation", "injected-id", "--output-format", "stream-json"] }), session: session("kX") }).promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "AGY_TURN_START_FAILED");
  assert.equal(a.calls.length, 0, "위험 argv는 실행 전에 거부");
  // attached(=value) 형식
  const b = makeAdapter([{ conversationId: ID_A, result: { ok: true } }]);
  const r2 = await b.adapter.runTurn({ context: ctx(), invocation: inv({ argv: ["--sandbox", "--conversation=injected", "--output-format", "stream-json"] }), session: session("kY") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_TURN_START_FAILED");
  assert.equal(b.calls.length, 0, "attached --conversation=도 실행 전 거부");
});

// continuity 실패는 최종 판정이다. 승인 요청 플래그가 살아남으면 화면에는
// "도구 권한을 승인해 주세요" 카드가 뜨고, 승인하면 같은 실행을 한 번 더 돌린 뒤
// 같은 이유로 실패한다.
test("R-2. continuity 실패는 승인 요청으로 되살아나지 않는다", async () => {
  const { adapter } = makeAdapter((i) => i === 0
    ? { conversationId: ID_A, result: { ok: true, text: "one" } }
    : {
        emit: [],
        result: {
          ok: false,
          approvalRequired: true,
          approval: { summary: "도구 권한: run_command", detail: "승인 필요" },
          error: "도구 실행 권한이 필요합니다.",
        },
      });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "AGY_CONVERSATION_RESUME_FAILED");
  assert.equal(r2.approvalRequired, undefined, "승인 요청으로 둔갑하면 안 됩니다");
  assert.equal(r2.approval, undefined);
});
