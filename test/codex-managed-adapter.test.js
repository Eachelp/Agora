"use strict";

// Stage C-3 — CodexManagedAdapter behavior (fake client; no network/codex).

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");

const { CodexManagedAdapter } = require("../src/harness/codex/codex-managed-adapter");
const { createDefaultHarnessRuntime } = require("../src/harness/create-default-harness-runtime");

const REAL_TMP = fs.realpathSync(os.tmpdir());

function makeFakeClient() {
  return {
    state: "new",
    started: 0,
    requests: [],
    responses: [],
    interrupts: [],
    turnsIssued: [],
    _threadSeq: 0,
    _turnSeq: 0,
    _notify: null, _serverReq: null, _onClose: null,
    isReady() { return this.state === "ready"; },
    start() { this.state = "ready"; this.started += 1; return Promise.resolve(this); },
    request(method, params) {
      this.requests.push({ method, params });
      if (method === "thread/start") return Promise.resolve({ thread: { id: `thr_${++this._threadSeq}` } });
      if (method === "turn/start") {
        const id = `turn_${++this._turnSeq}`;
        this.turnsIssued.push({ threadId: params.threadId, id });
        return Promise.resolve({ turn: { id, status: "inProgress" } });
      }
      if (method === "turn/interrupt") { this.interrupts.push(params); return Promise.resolve({}); }
      return Promise.resolve({});
    },
    respond(id, result) { this.responses.push({ id, result }); return true; },
    notify() { return true; },
    close() { this.state = "closed"; this.closed = true; },
    emit(method, params) { this._notify(method, params); },
    serverRequest(id, method, params) { this._serverReq(id, method, params); },
    die(code) { if (this.state === "lost") return; this.state = "lost"; this._onClose({ reason: "lost", code: code || "CODEX_SESSION_LOST" }); },
  };
}

function makeAdapter() {
  let client = null;
  const adapter = new CodexManagedAdapter({
    createClient: (opts) => {
      client = makeFakeClient();
      client._notify = opts.onNotification;
      client._serverReq = opts.onServerRequest;
      client._onClose = opts.onClose;
      return client;
    },
  });
  return { adapter, getClient: () => client };
}

async function waitUntil(pred, ms = 1000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 1));
  }
}
function countTurnStarts(client) { return client.requests.filter((r) => r.method === "turn/start").length; }
function countThreadStarts(client) { return client.requests.filter((r) => r.method === "thread/start").length; }

function ctx(over = {}) {
  return {
    projectId: "p", workspaceId: REAL_TMP, professionalRunId: "pr-1",
    role: "implementation", providerId: "codex", modelKey: "gpt-x",
    permissionMode: "workspace-write", autoApprove: false, effort: "high",
    ...over,
  };
}
function inv(over = {}) {
  return { commandPath: "codex", needsShell: false, prompt: "작업", cwd: REAL_TMP, requireFinal: true, ...over };
}
const session = (key, generation = 1) => ({ key, generation });

async function completeTurn(client, threadId, turnId, { finalText = "최종", deltas = [], commands = [], status = "completed" } = {}) {
  for (const d of deltas) client.emit("item/agentMessage/delta", { threadId, turnId, itemId: "m", delta: d });
  for (const c of commands) {
    client.emit("item/started", { threadId, turnId, item: { type: "commandExecution", id: c.id, command: c.command } });
    client.emit("item/completed", { threadId, turnId, item: { type: "commandExecution", id: c.id, command: c.command, exitCode: c.exitCode, aggregatedOutput: c.output || "" } });
  }
  if (finalText != null) client.emit("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "m", text: finalText } });
  client.emit("turn/completed", { threadId, turn: { id: turnId, status } });
}

test("49.1 첫 logical session: thread/start 1 + turn/start 1", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const { threadId, id } = client.turnsIssued[0];
  await completeTurn(client, threadId, id, { finalText: "done" });
  const r = await run.promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, "done");
  assert.equal(countThreadStarts(client), 1);
  assert.equal(countTurnStarts(client), 1);
});

test("49.2 같은 key+generation 2번째 turn: thread/start 추가 없음, 같은 threadId로 turn/start", async () => {
  const { adapter, getClient } = makeAdapter();
  const run1 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  let t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id, { finalText: "one" });
  await run1.promise;

  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) });
  await waitUntil(() => countTurnStarts(client) >= 2);
  t = client.turnsIssued[1];
  await completeTurn(client, t.threadId, t.id, { finalText: "two" });
  const r2 = await run2.promise;

  assert.equal(r2.text, "two");
  assert.equal(countThreadStarts(client), 1, "thread/start는 한 번만");
  assert.equal(countTurnStarts(client), 2);
  assert.equal(client.turnsIssued[0].threadId, client.turnsIssued[1].threadId, "같은 threadId 재사용");
});

test("49.2b generation이 바뀌면 새 thread", async () => {
  const { adapter, getClient } = makeAdapter();
  const r1 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 1) });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  await completeTurn(client, client.turnsIssued[0].threadId, client.turnsIssued[0].id);
  await r1.promise;
  const r2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA", 2) });
  await waitUntil(() => countTurnStarts(client) >= 2);
  await completeTurn(client, client.turnsIssued[1].threadId, client.turnsIssued[1].id);
  await r2.promise;
  assert.equal(countThreadStarts(client), 2, "generation 변경 -> 새 thread");
});

test("49.7 하나의 App Server child에서 여러 thread를 multiplex", async () => {
  const { adapter, getClient } = makeAdapter();
  const rA = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const rB = adapter.runTurn({ context: ctx({ role: "review" }), invocation: inv(), session: session("kB") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  assert.equal(client.started, 1, "App Server child는 하나만 start");
  assert.equal(countThreadStarts(client), 2, "role별 별도 thread");
  const [a, b] = client.turnsIssued;
  await completeTurn(client, a.threadId, a.id, { finalText: "A" });
  await completeTurn(client, b.threadId, b.id, { finalText: "B" });
  assert.equal((await rA.promise).text, "A");
  assert.equal((await rB.promise).text, "B");
});

test("50 role leakage 금지: 같은 process를 공유해도 event가 섞이지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const evA = []; const evB = [];
  const rA = adapter.runTurn({ context: ctx(), invocation: inv({ onEvent: (e) => evA.push(e) }), session: session("kBuilder") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const rB = adapter.runTurn({ context: ctx({ role: "review" }), invocation: inv({ onEvent: (e) => evB.push(e) }), session: session("kReviewer") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  const a = client.turnsIssued[0]; const b = client.turnsIssued[1];

  // interleaved deltas with correct thread/turn correlation
  client.emit("item/agentMessage/delta", { threadId: a.threadId, turnId: a.id, itemId: "x", delta: "builder-secret" });
  client.emit("item/agentMessage/delta", { threadId: b.threadId, turnId: b.id, itemId: "y", delta: "reviewer-secret" });

  const aDeltas = evA.filter((e) => e.kind === "delta").map((e) => e.text);
  const bDeltas = evB.filter((e) => e.kind === "delta").map((e) => e.text);
  assert.deepEqual(aDeltas, ["builder-secret"]);
  assert.deepEqual(bDeltas, ["reviewer-secret"]);
  assert.ok(!evA.some((e) => JSON.stringify(e).includes("reviewer-secret")), "Builder에 Reviewer event 유입 금지");
  assert.ok(!evB.some((e) => JSON.stringify(e).includes("builder-secret")), "Reviewer에 Builder event 유입 금지");

  await completeTurn(client, a.threadId, a.id, { finalText: "A final" });
  await completeTurn(client, b.threadId, b.id, { finalText: "B final" });
  const [resA, resB] = await Promise.all([rA.promise, rB.promise]);
  assert.equal(resA.text, "A final");
  assert.equal(resB.text, "B final");
  assert.ok(!JSON.stringify(resA).includes("reviewer-secret"));
});

test("51 strict-final: final 있으면 성공, requireFinal인데 final 없으면 PROTOCOL_FINAL_MISSING", async () => {
  const { adapter, getClient } = makeAdapter();
  const r1 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("s1") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  let t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id, { finalText: "정답", deltas: ["부분"] });
  const res1 = await r1.promise;
  assert.equal(res1.ok, true);
  assert.equal(res1.text, "정답");

  const r2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("s2") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  t = client.turnsIssued[1];
  await completeTurn(client, t.threadId, t.id, { finalText: null, deltas: ["부분만"] });
  const res2 = await r2.promise;
  assert.equal(res2.ok, false);
  assert.equal(res2.protocolFailed, true);
  assert.equal(res2.stopReason, "PROTOCOL_FINAL_MISSING");
  assert.equal(res2.partialText, "부분만");
});

test("51b turn failed는 실패 + partialText 보존", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("sf") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  client.emit("item/agentMessage/delta", { threadId: t.threadId, turnId: t.id, itemId: "m", delta: "진행 중" });
  client.emit("turn/completed", { threadId: t.threadId, turn: { id: t.id, status: "failed", error: { message: "모델 오류" } } });
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_TURN_FAILED");
  assert.match(r.error, /모델 오류/);
  assert.equal(r.partialText, "진행 중");
});

test("52 command evidence: canonical command-started/finished + RunMetrics", async () => {
  const { adapter, getClient } = makeAdapter();
  const events = [];
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ onEvent: (e) => events.push(e) }), session: session("cmd") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id, {
    finalText: "완료",
    commands: [{ id: "c1", command: "npm test", exitCode: 0, output: "ok" }, { id: "c2", command: "bad", exitCode: 1, output: "err" }],
  });
  const r = await run.promise;
  assert.equal(r.evidence.commandSummary.total, 2);
  assert.equal(r.evidence.commandSummary.failed, 1);
  assert.ok(r.evidence.commands.some((c) => c.kind === "command-finished" && c.exitCode === 0));
  assert.equal(r.runMetrics.commands.total, 2);
  assert.equal(r.runMetrics.commands.failed, 1);
  const metricEvents = events.filter((e) => e.kind === "run-metrics");
  assert.equal(metricEvents.length, 1);
  const cmdEvents = events.filter((e) => e.kind === "command-started" || e.kind === "command-finished");
  assert.equal(cmdEvents.length, 4);
});

test("53 cancel은 active turn만 turn/interrupt하고 process를 죽이지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const rA = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("kA") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const rB = adapter.runTurn({ context: ctx({ role: "review" }), invocation: inv(), session: session("kB") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  const a = client.turnsIssued[0]; const b = client.turnsIssued[1];

  rA.cancel();
  await waitUntil(() => client.interrupts.length >= 1);
  assert.equal(client.interrupts.length, 1);
  assert.deepEqual(client.interrupts[0], { threadId: a.threadId, turnId: a.id });
  assert.equal(client.state, "ready", "shared App Server를 죽이지 않는다");

  // interrupted completion -> cancelled
  client.emit("turn/completed", { threadId: a.threadId, turn: { id: a.id, status: "interrupted" } });
  const resA = await rA.promise;
  assert.equal(resA.cancelled, true);

  // B는 영향 없음
  await completeTurn(client, b.threadId, b.id, { finalText: "B ok" });
  assert.equal((await rB.promise).text, "B ok");
});

test("53b turnId 확보 전 cancel race: turnId 확보 즉시 interrupt", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("race") });
  run.cancel(); // turn/start 응답 전(동기)에 취소 요청
  await waitUntil(() => getClient() && getClient().interrupts.length >= 1);
  const client = getClient();
  assert.equal(client.interrupts[0].turnId, client.turnsIssued[0].id);
});

test("54 approval: safe deny 응답 + approvalRequired 반환, 그리고 replay-required thread 재사용 금지", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("appr") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  client.serverRequest(99, "item/commandExecution/requestApproval", { threadId: t.threadId, turnId: t.id, command: ["rm", "x"], cwd: REAL_TMP, reason: "삭제" });
  const r = await run.promise;
  assert.equal(r.approvalRequired, true);
  assert.match(r.approval.summary, /rm x/);
  assert.deepEqual(client.responses[0], { id: 99, result: { decision: "cancel" } });

  // approved whole-turn retry(같은 session) -> 기존 thread 재사용 안 함(새 thread/start)
  const retry = adapter.runTurn({ context: ctx({ autoApprove: true }), invocation: inv(), session: session("appr") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  assert.equal(countThreadStarts(client), 2, "approval thread는 재사용하지 않고 새 thread 생성");
  const t2 = client.turnsIssued[1];
  await completeTurn(client, t2.threadId, t2.id, { finalText: "retried" });
  assert.equal((await retry.promise).text, "retried");
});

test("54b autoApprove는 turn/start의 sandboxPolicy=dangerFullAccess로 명시 반영", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx({ autoApprove: true }), invocation: inv(), session: session("auto") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const turnStart = client.requests.find((r) => r.method === "turn/start");
  assert.equal(turnStart.params.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(turnStart.params.approvalPolicy, "never");
  const t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id);
  await run.promise;
});

test("55 session loss: 새 App Server 자동 restart 금지, Process fallback 금지, fail-closed", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("k") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id, { finalText: "first ok" });
  assert.equal((await run.promise).text, "first ok");

  // 서버 사망
  client.die("CODEX_SESSION_LOST");
  // 같은 logical session 재실행 -> fail-closed, 자동 restart 없음
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_SESSION_LOST");
  assert.equal(client.started, 1, "App Server를 자동 재시작하지 않는다");
});

test("55b active turn 중 서버 사망은 fail-closed로 종료", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: session("mid") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  client.die("CODEX_SESSION_LOST");
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_SESSION_LOST");
});

test("56 permission: workspace-read는 readOnly, chat은 workspace를 cwd로 노출하지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx({ permissionMode: "workspace-read" }), invocation: inv(), session: session("wr") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const ts = client.requests.find((r) => r.method === "turn/start");
  assert.equal(ts.params.sandboxPolicy.type, "readOnly");
  assert.equal(ts.params.cwd, REAL_TMP);
  const t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id);
  await run.promise;

  const runChat = adapter.runTurn({ context: ctx({ permissionMode: "chat" }), invocation: inv({ cwd: "/chat-runtime" }), session: session("chat") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  const tsChat = client.requests.filter((r) => r.method === "turn/start")[1];
  assert.equal(tsChat.params.sandboxPolicy.type, "readOnly");
  assert.equal(tsChat.params.cwd, "/chat-runtime", "chat은 workspace가 아니라 chat runtime dir 사용");
  const t2 = client.turnsIssued[1];
  await completeTurn(client, t2.threadId, t2.id);
  await runChat.promise;
});

test("56b workspace realpath 불일치는 turn을 시작하지 않고 fail-closed", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({
    context: ctx({ permissionMode: "workspace-write", workspaceId: "/nonexistent/other" }),
    invocation: inv({ cwd: REAL_TMP }),
    session: session("mismatch"),
  });
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_WORKSPACE_MISMATCH");
  // turn/start는 시도조차 하지 않아야 한다
  if (getClient()) assert.equal(countTurnStarts(getClient()), 0);
});

test("57 image: turn/start input에 text + localImage가 들어간다", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ images: ["/img/a.png"] }), session: session("img") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const ts = client.requests.find((r) => r.method === "turn/start");
  assert.deepEqual(ts.params.input, [{ type: "text", text: "작업" }, { type: "localImage", path: "/img/a.png" }]);
  const t = client.turnsIssued[0];
  await completeTurn(client, t.threadId, t.id);
  await run.promise;
});

test("37 runtime identity 변경은 fail-closed", async () => {
  const { adapter, getClient } = makeAdapter();
  const r1 = adapter.runTurn({ context: ctx(), invocation: inv({ commandPath: "codex" }), session: session("k") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  await completeTurn(client, client.turnsIssued[0].threadId, client.turnsIssued[0].id);
  await r1.promise;
  const r2 = adapter.runTurn({ context: ctx(), invocation: inv({ commandPath: "/other/codex" }), session: session("k2") });
  const res2 = await r2.promise;
  assert.equal(res2.stopReason, "CODEX_APP_SERVER_RUNTIME_MISMATCH");
});

// ---- runtime-level selection & identity isolation (deriveSessionKey exercised) ----

function spyProcess() { const calls = []; return { id: "process", supportsPersistentSession: false, calls, runTurn(r) { calls.push(r); return { promise: Promise.resolve({ ok: true, tag: "process" }), cancel() {} }; } }; }
function spyCodex() { const calls = []; return { id: "codex-managed", supportsPersistentSession: true, calls, runTurn({ context, session }) { calls.push({ context, session }); return { promise: Promise.resolve({ ok: true, tag: "codex", key: session && session.key }), cancel() {} }; } }; }
function spyClaude() { const calls = []; return { id: "claude-managed", supportsPersistentSession: true, calls, runTurn({ context, session }) { calls.push({ context, session }); return { promise: Promise.resolve({ ok: true, tag: "claude", key: session && session.key }), cancel() {} }; } }; }
function rctx(over = {}) {
  return { projectId: "p", workspaceId: "/ws", professionalRunId: "pr-1", role: "implementation", providerId: "codex", modelKey: "gpt-x", permissionMode: "workspace-write", ...over };
}
const RINV = { commandPath: "codex", prompt: "" };

test("49.3-49.6 role/run/permission/model이 다르면 다른 Codex thread(session.key)로 라우팅된다", async () => {
  for (const [label, a, b] of [
    ["role", { role: "implementation" }, { role: "review" }],
    ["professionalRunId", { professionalRunId: "pr-1" }, { professionalRunId: "pr-2" }],
    ["permissionMode", { permissionMode: "workspace-write" }, { permissionMode: "workspace-read" }],
    ["modelKey", { modelKey: "m1" }, { modelKey: "m2" }],
  ]) {
    const codex = spyCodex();
    const rt = createDefaultHarnessRuntime({ processAdapter: spyProcess(), codexAdapter: codex });
    await rt.runTurn({ context: rctx(a), invocation: RINV }).promise;
    await rt.runTurn({ context: rctx(b), invocation: RINV }).promise;
    assert.equal(codex.calls.length, 2, label);
    assert.notEqual(codex.calls[0].session.key, codex.calls[1].session.key, `${label} 다르면 다른 session.key`);
  }
});

test("49.8/49.9 general chat과 default/미해결 model은 Codex managed를 쓰지 않고 Process", async () => {
  const codex = spyCodex(); const proc = spyProcess();
  const rt = createDefaultHarnessRuntime({ processAdapter: proc, codexAdapter: codex });
  // general chat: role/professionalRunId 없음 -> sessionless
  await rt.runTurn({ context: rctx({ role: null, professionalRunId: null }), invocation: RINV }).promise;
  // default model
  await rt.runTurn({ context: rctx({ modelKey: "default" }), invocation: RINV }).promise;
  assert.equal(codex.calls.length, 0, "Codex managed 미사용");
  assert.equal(proc.calls.length, 2, "Process 경로");
  assert.equal(rt.registry.size(), 0, "registry entry 없음");
});

test("49.10/49.11 AGY는 Process 경로; Claude는 등록된 managed adapter로 라우팅된다", async () => {
  // Stage C(Claude Resume) 이후 Professional Claude 실행은 ClaudeManagedAdapter로 간다.
  // AGY는 등록된 persistent adapter가 없어 그대로 Process 경로다.
  const codex = spyCodex(); const claude = spyClaude(); const proc = spyProcess();
  const rt = createDefaultHarnessRuntime({ processAdapter: proc, codexAdapter: codex, claudeAdapter: claude });
  await rt.runTurn({ context: rctx({ providerId: "claude" }), invocation: RINV }).promise;
  await rt.runTurn({ context: rctx({ providerId: "agy" }), invocation: RINV }).promise;
  assert.equal(codex.calls.length, 0, "Codex managed 미사용");
  assert.equal(claude.calls.length, 1, "Claude는 managed adapter로 라우팅");
  assert.equal(proc.calls.length, 1, "AGY만 Process 경로");
});
