"use strict";

// Stage C — ClaudeManagedAdapter behavior (fake runProcess; no real Claude/account/network).
//
// 검증 목표:
//   - adapter가 기존 one-shot Claude argv를 최소 변환한다(--no-session-persistence 제거,
//     첫 turn=native 세션 생성, 이후=정확한 --resume <id>). chat-ipc/chat-argv는 관여 안 함.
//   - authoritative prompt 매 turn 전체 재전송.
//   - role/run/model/permission/workspace 격리(교차 resume 없음, 같은 키는 resume).
//   - fail-closed(SILENT FALLBACK 금지): resume-not-found/missing-id/mismatch/argv 실패.
//   - cancel/timeout/output-limit continuity ambiguity -> binding poison.
//   - 실제 실행 후 continuity 실패는 실 output/evidence/RunMetrics(duration·tool metrics)를
//     보존하고 판정(ok/stopReason/error)만 덮어쓴다. 실행 안 한 static fail만 zero-duration.
//   - strict-final(protocolFailed)/성공 evidence·RunMetrics 회귀(그대로 통과).
//   - general chat/default model -> ProcessHarnessAdapter 경로. session_id는 harness-only.

const test = require("node:test");
const assert = require("node:assert/strict");

const { ClaudeManagedAdapter } = require("../src/harness/claude/claude-managed-adapter");
const { createDefaultHarnessRuntime } = require("../src/harness/create-default-harness-runtime");
const { HarnessAdapter } = require("../src/harness/harness-adapter");
const { createLineParser } = require("../src/chat/chat-events");
const { buildRunMetrics } = require("../src/chat/chat-run-metrics");

const ID_A = "69a872f3-51b6-425c-969d-8e27533dbe9d";
const ID_B = "11111111-2222-3333-4444-555555555555";

// 기존 one-shot Claude argv(비관리)와 동형: --no-session-persistence를 포함한다.
// adapter는 이 배열을 받아 최소 변환한다(원본은 변형하지 않는다).
const BASE_ARGV = Object.freeze([
  "-p", "--no-session-persistence", "--output-format", "stream-json",
  "--include-partial-messages", "--verbose", "--model", "sonnet",
]);

function inv(over = {}) {
  return { commandPath: "claude", needsShell: false, argv: [...BASE_ARGV], prompt: "AUTH-PROMPT", cwd: "/ws", requireFinal: true, ...over };
}
function ctx(over = {}) {
  return {
    projectId: "p", workspaceId: "/ws", professionalRunId: "pr-1", role: "implementation",
    providerId: "claude", modelKey: "sonnet", permissionMode: "workspace-write", effort: "high", ...over,
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
  result.runMetrics = buildRunMetrics({ provider: "claude", model: "sonnet", effort: "high", stage: "implementation", startedAt: START, finishedAt: FINISH, promptChars: 12, result });
  return { evidence, output, durationMs: FINISH - START, result: { ...result, ...over } };
}

// scripted fake runProcess.
// behavior: { sessionId?, sessionIds?, result?, pending?, throw?, onCancel? }
function makeAdapter(script) {
  const calls = [];
  let cancels = 0;
  const runProcess = (invocation) => {
    const index = calls.length;
    const beh = (typeof script === "function"
      ? script(index, invocation)
      : Array.isArray(script) ? script[index] : script) || {};
    if (beh.throw) { calls.push({ argv: invocation.argv, prompt: invocation.prompt, threw: true }); throw new Error(beh.throw); }
    const ids = beh.sessionIds !== undefined ? beh.sessionIds : (beh.sessionId !== undefined ? [beh.sessionId] : []);
    for (const id of ids) {
      if (id == null) continue;
      if (typeof invocation.parseLine === "function") {
        invocation.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: id, tools: [] }));
      }
    }
    calls.push({ argv: invocation.argv, prompt: invocation.prompt, parseLine: invocation.parseLine });
    const promise = beh.pending ? new Promise(() => {}) : Promise.resolve(beh.result || { ok: true, text: "answer" });
    return { promise, cancel: () => { cancels += 1; if (beh.onCancel) beh.onCancel(); } };
  };
  const adapter = new ClaudeManagedAdapter({ runProcess });
  return { adapter, calls, cancels: () => cancels };
}
const resumeIndex = (argv) => argv.indexOf("--resume");
const hasNoPersist = (argv) => argv.includes("--no-session-persistence");

test("W. ClaudeManagedAdapter는 HarnessAdapter이며 id=claude-managed, persistent=true", () => {
  const a = new ClaudeManagedAdapter();
  assert.ok(a instanceof HarnessAdapter);
  assert.equal(a.id, "claude-managed");
  assert.equal(a.supportsPersistentSession, true);
});

test("Y. adapter는 기존 one-shot argv를 최소 변환한다(--no-session-persistence 제거, 나머지 보존, 원본 불변)", async () => {
  const { adapter, calls } = makeAdapter([{ sessionId: ID_A, result: { ok: true, text: "1" } }, { sessionId: ID_A, result: { ok: true, text: "2" } }]);
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kY") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kY") }).promise;
  // 첫 turn: 플래그 제거, --resume 없음, 나머지 그대로
  assert.equal(hasNoPersist(calls[0].argv), false, "첫 turn: --no-session-persistence 제거");
  assert.equal(resumeIndex(calls[0].argv), -1, "첫 turn: --resume 없음");
  for (const flag of ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", "sonnet"]) {
    assert.ok(calls[0].argv.includes(flag), `control plane argv 보존: ${flag}`);
  }
  // resume turn: 여전히 플래그 없음 + 정확한 --resume ID_A
  assert.equal(hasNoPersist(calls[1].argv), false);
  const ri = resumeIndex(calls[1].argv);
  assert.ok(ri >= 0 && calls[1].argv[ri + 1] === ID_A, "resume turn: 정확한 --resume <capturedId>");
  // 입력 원본 argv 배열은 변형되지 않는다
  assert.deepEqual([...BASE_ARGV], ["-p", "--no-session-persistence", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model", "sonnet"]);
});

test("A. 첫 turn은 native 세션을 새로 만들고(--resume 없음) session_id를 캡처한다", async () => {
  const { adapter, calls } = makeAdapter([{ sessionId: ID_A, result: { ok: true, text: "hello" } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, "hello");
  assert.equal(calls.length, 1);
  assert.equal(resumeIndex(calls[0].argv), -1);
});

test("B. 같은 key+generation 2번째 turn은 정확히 --resume <capturedId>로 잇는다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ sessionId: ID_A, result: { ok: true, text: i === 0 ? "one" : "two" } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) }).promise;
  assert.equal(r2.text, "two");
  const i = resumeIndex(calls[1].argv);
  assert.ok(i >= 0 && calls[1].argv[i + 1] === ID_A, "정확히 캡처된 세션만 resume");
});

test("C. authoritative prompt는 매 turn 전체 재전송된다(resume이라고 축약하지 않는다)", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ sessionId: ID_A, result: { ok: true, text: String(i) } }));
  const P = "=== 전문 모드: BUILDER ===\n규칙/맥락/결정/작업/최근기록이 모두 담긴 긴 authoritative prompt";
  await adapter.runTurn({ context: ctx(), invocation: inv({ prompt: P }), session: session("kA") }).promise;
  await adapter.runTurn({ context: ctx(), invocation: inv({ prompt: P }), session: session("kA") }).promise;
  assert.equal(calls[0].prompt, P);
  assert.equal(calls[1].prompt, P, "resume turn도 프롬프트 전체 재전송");
});

test("E. role/run/model/permission/workspace가 다르면 다른 native 세션(교차 resume 없음, 같은 키는 resume)", async () => {
  const dims = [
    ["role", { role: "implementation" }, { role: "review" }],
    ["professionalRunId", { professionalRunId: "pr-1" }, { professionalRunId: "pr-2" }],
    ["modelKey", { modelKey: "sonnet" }, { modelKey: "opus" }],
    ["permissionMode", { permissionMode: "workspace-write" }, { permissionMode: "workspace-read" }],
    ["workspaceId", { workspaceId: "/wsA" }, { workspaceId: "/wsB" }],
  ];
  for (const [label, A, B] of dims) {
    const { adapter, calls } = makeAdapter((i) =>
      i === 1 ? { sessionId: ID_B, result: { ok: true, text: "B1" } }
              : { sessionId: ID_A, result: { ok: true, text: "A" } });
    const rt = createDefaultHarnessRuntime({ claudeAdapter: adapter });
    await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
    await rt.runTurn({ context: ctx(B), invocation: inv() }).promise;
    await rt.runTurn({ context: ctx(A), invocation: inv() }).promise;
    assert.equal(resumeIndex(calls[0].argv), -1, `${label}: A 첫 turn`);
    assert.equal(resumeIndex(calls[1].argv), -1, `${label}: B는 다른 세션(첫 turn)`);
    const ri = resumeIndex(calls[2].argv);
    assert.ok(ri >= 0 && calls[2].argv[ri + 1] === ID_A, `${label}: 같은 키 A는 resume ID_A`);
  }
});

test("O. Professional claude는 managed adapter로, 일반 채팅/기본 모델은 Process 경로로 라우팅된다", async () => {
  const { adapter, calls } = makeAdapter([{ sessionId: ID_A, result: { ok: true, text: "m" } }]);
  const procCalls = [];
  const proc = { id: "process", supportsPersistentSession: false, runTurn(r) { procCalls.push(r); return { promise: Promise.resolve({ ok: true, tag: "proc" }), cancel() {} }; } };
  const rt = createDefaultHarnessRuntime({ claudeAdapter: adapter, processAdapter: proc });
  await rt.runTurn({ context: ctx(), invocation: inv() }).promise;
  await rt.runTurn({ context: ctx({ role: null, professionalRunId: null }), invocation: inv() }).promise;
  await rt.runTurn({ context: ctx({ modelKey: "default" }), invocation: inv() }).promise;
  assert.equal(calls.length, 1, "managed는 professional 1회");
  assert.equal(procCalls.length, 2, "일반 채팅/기본 모델은 Process");
});

test("G. resume 대상 세션이 없으면 RESUME_FAILED로 fail-closed(실 telemetry 보존) + poison", async () => {
  const rich = richOk({ ok: false, text: undefined, error: `No conversation found with session ID: ${ID_A}` });
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: true, text: "one" } }
    : { result: rich.result });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CLAUDE_SESSION_RESUME_FAILED");
  assert.match(r2.error, /No conversation found/);
  assert.equal(r2.output, rich.output, "실 output 보존");
  assert.equal(r2.runMetrics.durationMs, rich.durationMs, "실 duration 보존");
  assert.equal(r2.runMetrics.stopReason, "CLAUDE_SESSION_RESUME_FAILED", "판정은 실패로 재계산");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "CLAUDE_SESSION_RESUME_FAILED", "poison된 handle 재사용 fail-closed");
  assert.equal(calls.length, 2, "poison된 handle은 새 프로세스를 띄우지 않는다");
});

test("H. 첫 turn이 session_id를 반환하지 않으면 CLAUDE_SESSION_ID_MISSING로 이 turn만 fail-closed(poison 아님)", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { result: { ok: true, text: "no-id" } }
    : { sessionId: ID_A, result: { ok: true, text: "retry-ok" } });
  const r1 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r1.ok, false);
  assert.equal(r1.stopReason, "CLAUDE_SESSION_ID_MISSING");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, true, "확정된 세션이 없었으므로 재시도는 새 세션으로 허용");
  assert.equal(resumeIndex(calls[1].argv), -1, "재시도는 첫 turn(새 세션)");
});

test("I. resume turn이 다른 session_id를 반환하면 CLAUDE_SESSION_ID_MISMATCH로 fail-closed + poison", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: true, text: "one" } }
    : { sessionId: ID_B, result: { ok: true, text: "two" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CLAUDE_SESSION_ID_MISMATCH");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "CLAUDE_SESSION_ID_MISMATCH", "poison 유지");
  assert.equal(calls.length, 2);
});

test("J. resume turn 취소는 continuity를 무효화한다(결과 그대로 통과, 다음 turn CLAUDE_SESSION_LOST)", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: true, text: "one" } }
    : { result: { ok: false, cancelled: true, error: "중지됨" } });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.cancelled, true, "취소 결과는 그대로 통과(판정 덮어쓰기 없음)");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.ok, false);
  assert.equal(r3.stopReason, "CLAUDE_SESSION_LOST");
  assert.equal(calls.length, 2, "poison된 handle 재실행 금지");
});

test("K. resume turn의 timeout/output-limit도 continuity를 무효화한다(CLAUDE_SESSION_LOST)", async () => {
  for (const abnormal of [{ timedOut: true }, { outputLimited: true }]) {
    const { adapter, calls } = makeAdapter((i) => i === 0
      ? { sessionId: ID_A, result: { ok: true, text: "one" } }
      : { result: { ok: false, ...abnormal, error: "x" } });
    await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    assert.equal(r2.ok, false, JSON.stringify(abnormal));
    const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
    assert.equal(r3.stopReason, "CLAUDE_SESSION_LOST", JSON.stringify(abnormal));
    assert.equal(calls.length, 2, JSON.stringify(abnormal));
  }
});

test("M. strict-final 누락(protocolFailed, exit 0)이라도 session_id가 있으면 native 세션은 살아있어 binding을 만든다", async () => {
  const { adapter, calls } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: false, protocolFailed: true, stopReason: "PROTOCOL_FINAL_MISSING", partialText: "부분" } }
    : { sessionId: ID_A, result: { ok: true, text: "recovered" } });
  const r1 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r1.protocolFailed, true);
  assert.equal(r1.stopReason, "PROTOCOL_FINAL_MISSING", "결과 그대로 통과(성공 승격 아님)");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, true);
  const ri = resumeIndex(calls[1].argv);
  assert.ok(ri >= 0 && calls[1].argv[ri + 1] === ID_A, "protocolFailed 후에도 같은 세션 resume");
});

test("N. 정상 turn의 evidence/runMetrics/output은 변형 없이 그대로 통과한다", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter([{ sessionId: ID_A, result: rich.result }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.evidence, rich.evidence, "evidence 참조 그대로");
  assert.equal(r.runMetrics, rich.result.runMetrics, "runMetrics 참조 그대로(재계산 없음)");
  assert.equal(r.output, rich.output, "output 참조 그대로");
  assert.equal(r.text, "trusted answer");
});

test("Z1. 실행 후 session_id mismatch: 실 output/evidence/RunMetrics(duration·tool) 보존, 판정만 뒤집기", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: true, text: "one" } }
    : { sessionId: ID_B, result: rich.result });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CLAUDE_SESSION_ID_MISMATCH");
  assert.equal(r2.output, rich.output, "실 output 보존");
  assert.equal(r2.evidence, rich.evidence, "실 evidence 보존");
  assert.equal(r2.runMetrics.durationMs, rich.durationMs, "실 duration 보존(zero-duration 아님)");
  assert.equal(r2.runMetrics.tools.started, 4, "tool metrics 보존");
  assert.equal(r2.runMetrics.commands.total, 3, "command metrics 보존");
  assert.equal(r2.runMetrics.stdoutBytes, 4096, "output metrics 보존");
  assert.equal(r2.runMetrics.ok, false, "runMetrics 판정도 실패로");
  assert.equal(r2.runMetrics.stopReason, "CLAUDE_SESSION_ID_MISMATCH");
  assert.equal(r2.text, undefined, "신뢰 못하는 답변은 text에서 제거");
  assert.equal(r2.partialText, "trusted answer", "부분 출력으로 강등 보존");
});

test("Z2. 실행 후 session_id missing(resume turn): 실 telemetry 보존 + CLAUDE_SESSION_ID_MISSING + poison", async () => {
  const rich = richOk();
  const { adapter } = makeAdapter((i) => i === 0
    ? { sessionId: ID_A, result: { ok: true, text: "one" } }
    : { result: rich.result });
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CLAUDE_SESSION_ID_MISSING");
  assert.equal(r2.output, rich.output);
  assert.equal(r2.evidence, rich.evidence);
  assert.equal(r2.runMetrics.durationMs, rich.durationMs, "실 duration 보존");
  assert.equal(r2.runMetrics.stopReason, "CLAUDE_SESSION_ID_MISSING");
  const r3 = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r3.stopReason, "CLAUDE_SESSION_ID_MISSING", "poison 유지");
  assert.equal(r3.runMetrics.durationMs, 0, "poison된 재사용은 static(zero-duration)");
});

test("Z3. 실행하지 않은 static fail만 zero-duration metrics를 갖는다", async () => {
  const { adapter, calls } = makeAdapter([{ result: { ok: true } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: { generation: 1 } }).promise; // no key -> static
  assert.equal(r.stopReason, "CLAUDE_TURN_START_FAILED");
  assert.equal(r.runMetrics.durationMs, 0, "static fail은 zero-duration");
  assert.equal(r.runMetrics.startedAt, r.runMetrics.finishedAt);
  assert.equal(calls.length, 0, "실행하지 않음");
});

test("Q. 빈 argv는 fail-closed(CLAUDE_TURN_START_FAILED)로 처리하고 프로세스를 띄우지 않는다", async () => {
  const { adapter, calls } = makeAdapter([{ result: { ok: true } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv({ argv: [] }), session: session("kA") }).promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CLAUDE_TURN_START_FAILED");
  assert.equal(calls.length, 0);
});

test("R. resume turn에서 argv 생성 실패는 조용히 새 세션으로 우회하지 않고 RESUME_FAILED + poison", async () => {
  const b = makeAdapter((i) => i === 0 ? { sessionId: ID_A, result: { ok: true, text: "one" } } : { result: { ok: true } });
  await b.adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kB") }).promise;
  const r2 = await b.adapter.runTurn({ context: ctx(), invocation: inv({ argv: [] }), session: session("kB") }).promise;
  assert.equal(r2.stopReason, "CLAUDE_SESSION_RESUME_FAILED");
  const r3 = await b.adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kB") }).promise;
  assert.equal(r3.stopReason, "CLAUDE_SESSION_RESUME_FAILED", "poison 유지");
  assert.equal(b.calls.length, 1, "resume argv 실패/poison 후 프로세스 미실행");
});

test("S. session.key가 없으면 fail-closed(CLAUDE_TURN_START_FAILED)", async () => {
  const { adapter } = makeAdapter([{ result: { ok: true } }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: { generation: 1 } }).promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CLAUDE_TURN_START_FAILED");
});

test("T. runProcess가 throw하면 fail-closed(CLAUDE_TURN_START_FAILED)로 감싼다", async () => {
  const { adapter } = makeAdapter([{ throw: "spawn 실패" }]);
  const r = await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CLAUDE_TURN_START_FAILED");
});

test("U. close()는 provider-local binding/invalidation 상태를 비운다", async () => {
  const { adapter, calls } = makeAdapter((i) => ({ sessionId: ID_A, result: { ok: true, text: `t${i}` } }));
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  adapter.close();
  await adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") }).promise;
  assert.equal(resumeIndex(calls[1].argv), -1, "close 후에는 binding이 없어 새 세션(첫 turn)");
});

test("V. runTurn의 cancel은 하부 runner의 cancel로 그대로 전달된다", () => {
  let cancelled = 0;
  const runProcess = () => ({ promise: new Promise(() => {}), cancel: () => { cancelled += 1; } });
  const adapter = new ClaudeManagedAdapter({ runProcess });
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") });
  run.cancel();
  assert.equal(cancelled, 1);
});

test("X. session_id는 harness-only다: parser는 session_id를 이벤트로 노출하지 않고 onSessionId로만 알린다", () => {
  const seen = [];
  const parse = createLineParser("claude", { onSessionId: (id) => seen.push(id) });
  const initEvent = parse(JSON.stringify({ type: "system", subtype: "init", session_id: ID_A, tools: [] }));
  assert.equal(initEvent, null, "init 줄은 정규화 이벤트를 만들지 않는다");
  assert.deepEqual(seen, [ID_A], "session_id는 onSessionId로만 전달");
  const delta = parse(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }));
  assert.equal(delta.kind, "delta");
  assert.equal(delta.text, "hi");
  assert.deepEqual(seen, [ID_A], "delta엔 session_id가 없어 onSessionId 추가 호출 없음");
});
