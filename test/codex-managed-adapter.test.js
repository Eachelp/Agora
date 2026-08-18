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
    respond(id, result) { this.responses.push({ id, result }); return this.failRespond ? false : true; },
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

// provider-neutral same-turn approval 콜백 모의. 각 요청을 rec로 기록하고 test가 approve/
// deny로 resolve한다. signal abort는 rec.aborted로만 관측(promise는 resolve하지 않음 = 실제
// UI가 answer 없이 dismiss되는 상황을 모사).
function makeApprover() {
  const calls = [];
  const requestApproval = (req) => new Promise((resolve) => {
    const rec = { req, resolve, aborted: false };
    if (req && req.signal) {
      if (req.signal.aborted) rec.aborted = true;
      else req.signal.addEventListener("abort", () => { rec.aborted = true; }, { once: true });
    }
    calls.push(rec);
  });
  return {
    requestApproval,
    calls,
    approve: (i = 0) => calls[i].resolve(true),
    deny: (i = 0) => calls[i].resolve(false),
  };
}
const cmdApprovalParams = (t, over = {}) => ({ threadId: t.threadId, turnId: t.id, itemId: "c1", command: "cmd", commandActions: [{ type: "unknown", command: "cmd" }], ...over });

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

// ================= Stage C — Codex same-turn approval =================

async function startAppr(key, approver, ctxOver = {}, invOver = {}) {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({
    context: ctx(ctxOver),
    invocation: inv({ requestApproval: approver.requestApproval, ...invOver }),
    session: session(key),
  });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  return { adapter, getClient, run, client, t: client.turnsIssued[client.turnsIssued.length - 1] };
}

test("policy: 대화형 workspace-write turn은 turn/start에 on-request + approvalsReviewer=user를 싣는다", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("pol", approver);
  const ts = client.requests.find((r) => r.method === "turn/start");
  assert.equal(ts.params.approvalPolicy, "on-request");
  assert.equal(ts.params.approvalsReviewer, "user");
  assert.equal(ts.params.sandboxPolicy.type, "workspaceWrite");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("G/H/I/J command approve: deny-first 없음 -> accept 응답(same id) -> interrupt/finalize/새 turn 없음 -> same T/U 완료", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("g", approver);
  client.emit("item/started", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c1", command: "rm x" } });
  client.serverRequest(11, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c1", command: "rm x" }));
  await waitUntil(() => approver.calls.length >= 1);
  assert.equal(approver.calls[0].req.scope, "action");
  assert.equal(client.responses.length, 0, "human 결정 전에는 응답하지 않는다(deny-first 제거)");
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0], { id: 11, result: { decision: "accept" } });
  assert.equal(client.interrupts.length, 0, "정상 승인은 interrupt 없음");
  assert.equal(countTurnStarts(client), 1, "새 turn/start 없음");
  assert.equal(countThreadStarts(client), 1, "새 thread/start 없음");
  client.emit("item/completed", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c1", command: "rm x", exitCode: 0 } });
  await completeTurn(client, t.threadId, t.id, { finalText: "done" });
  const r = await run.promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, "done");
  assert.equal(r.approvalRequired, undefined, "same-turn 승인은 approvalRequired를 반환하지 않는다");
  assert.equal(client.turnsIssued.length, 1, "turnId 하나로 완료");
});

test("K/L/M command deny: decline(ONE action) 응답 -> whole-turn cancel 아님(interrupt 없음) -> 같은 turn 계속 완료", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("k", approver);
  client.serverRequest(12, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  approver.deny(0);
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0], { id: 12, result: { decision: "decline" } });
  assert.equal(client.interrupts.length, 0, "deny는 whole-turn cancel/interrupt가 아니다");
  await completeTurn(client, t.threadId, t.id, { finalText: "continued" });
  assert.equal((await run.promise).text, "continued");
});

test("N/O/P file approve: item/started 변경 경로 context -> detail 노출 -> accept -> 같은 turn 계속", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("file", approver);
  client.emit("item/started", { threadId: t.threadId, turnId: t.id, item: { type: "fileChange", id: "f1", changes: [{ path: "src/a.js", kind: "update", diff: "d" }, { path: "b.txt", kind: "add", diff: "d" }], status: "inProgress" } });
  client.serverRequest(21, "item/fileChange/requestApproval", { threadId: t.threadId, turnId: t.id, itemId: "f1", reason: "쓰기" });
  await waitUntil(() => approver.calls.length >= 1);
  assert.match(approver.calls[0].req.detail, /src\/a\.js/);
  assert.match(approver.calls[0].req.detail, /b\.txt/);
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0], { id: 21, result: { decision: "accept" } });
  await completeTurn(client, t.threadId, t.id, { finalText: "wrote" });
  assert.equal((await run.promise).text, "wrote");
});

test("Q/R file: deny -> decline; 변경 context 없는 fileChange는 blind 금지 -> human 없이 safe decline", async () => {
  const a1 = makeApprover();
  const s1 = await startAppr("fq", a1);
  s1.client.emit("item/started", { threadId: s1.t.threadId, turnId: s1.t.id, item: { type: "fileChange", id: "f1", changes: [{ path: "z.js", kind: "update", diff: "d" }], status: "inProgress" } });
  s1.client.serverRequest(22, "item/fileChange/requestApproval", { threadId: s1.t.threadId, turnId: s1.t.id, itemId: "f1" });
  await waitUntil(() => a1.calls.length >= 1);
  a1.deny(0);
  await waitUntil(() => s1.client.responses.length >= 1);
  assert.deepEqual(s1.client.responses[0], { id: 22, result: { decision: "decline" } });
  await completeTurn(s1.client, s1.t.threadId, s1.t.id, { finalText: "ok" });
  await s1.run.promise;

  const a2 = makeApprover();
  const s2 = await startAppr("fr", a2);
  s2.client.serverRequest(23, "item/fileChange/requestApproval", { threadId: s2.t.threadId, turnId: s2.t.id, itemId: "unknown", reason: "쓰기" });
  await waitUntil(() => s2.client.responses.length >= 1);
  assert.deepEqual(s2.client.responses[0], { id: 23, result: { decision: "decline" } });
  assert.equal(a2.calls.length, 0, "blind file은 human prompt를 띄우지 않는다");
  await completeTurn(s2.client, s2.t.threadId, s2.t.id, { finalText: "ok" });
  await s2.run.promise;
});

test("S sequential: 같은 T/U에서 approve -> deny -> 완료. callback 2, turn/start 1, interrupt 0, one RunMetrics", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("seq", approver);
  client.serverRequest(31, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c1", command: "cmd1" }));
  await waitUntil(() => approver.calls.length >= 1);
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  client.serverRequest(32, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c2", command: "cmd2" }));
  await waitUntil(() => approver.calls.length >= 2);
  approver.deny(1);
  await waitUntil(() => client.responses.length >= 2);
  assert.deepEqual(client.responses[0].result, { decision: "accept" });
  assert.deepEqual(client.responses[1].result, { decision: "decline" });
  await completeTurn(client, t.threadId, t.id, { finalText: "final" });
  const r = await run.promise;
  assert.equal(approver.calls.length, 2);
  assert.equal(countTurnStarts(client), 1);
  assert.equal(countThreadStarts(client), 1);
  assert.equal(client.interrupts.length, 0);
  assert.equal(r.runMetrics.stopReason, "COMPLETED");
});

test("T/U stale routing: wrong thread / wrong turn approval은 human 없이 safe decline, 현재 turn 불변", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("stale", approver);
  client.serverRequest(41, "item/commandExecution/requestApproval", cmdApprovalParams(t, { threadId: "other-thread" }));
  client.serverRequest(42, "item/commandExecution/requestApproval", cmdApprovalParams(t, { turnId: "other-turn" }));
  await waitUntil(() => client.responses.length >= 2);
  assert.equal(approver.calls.length, 0, "stale은 human prompt 없음");
  for (const resp of client.responses) assert.deepEqual(resp.result, { decision: "decline" });
  assert.equal(client.interrupts.length, 0, "stale은 현재 turn을 interrupt하지 않는다");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  assert.equal((await run.promise).text, "ok");
});

test("V stale after finalize: 종료된 turn에 늦게 온 approval은 human 없이 safe decline", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("v", approver);
  await completeTurn(client, t.threadId, t.id, { finalText: "done" });
  const r = await run.promise;
  const before = client.responses.length;
  client.serverRequest(51, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  assert.equal(approver.calls.length, 0);
  assert.equal(client.responses.length, before + 1);
  assert.deepEqual(client.responses[before].result, { decision: "decline" });
  assert.equal(r.text, "done");
});

test("W/X/Y serverRequest/resolved: pending 제거 + UI abort, late approve는 accept 안 함, 중복 resolved idempotent", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("res", approver);
  client.serverRequest(61, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  client.emit("serverRequest/resolved", { threadId: t.threadId, requestId: 61 });
  await waitUntil(() => approver.calls[0].aborted === true);
  client.emit("serverRequest/resolved", { threadId: t.threadId, requestId: 61 }); // idempotent
  approver.approve(0); // late
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(client.responses.length, 0, "resolved 이후 late approve는 accept 응답을 보내지 않는다");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("Z/AA cancel while pending: human 무효화 + late accept 없음 + native cancel best-effort + interrupt", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("cxl", approver);
  client.serverRequest(71, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  run.cancel();
  await waitUntil(() => client.interrupts.length >= 1);
  client.emit("turn/completed", { threadId: t.threadId, turn: { id: t.id, status: "interrupted" } });
  const r = await run.promise;
  approver.approve(0); // late
  await new Promise((rs) => setTimeout(rs, 10));
  assert.equal(r.cancelled, true);
  assert.ok(approver.calls[0].aborted, "human UI abort");
  const accepts = client.responses.filter((x) => x.result && x.result.decision === "accept");
  assert.equal(accepts.length, 0, "취소 후 accept 절대 없음");
  const cancels = client.responses.filter((x) => x.id === 71 && x.result && x.result.decision === "cancel");
  assert.equal(cancels.length, 1, "미응답 native 요청에 whole-turn cancel best-effort");
});

test("AB timeout while pending: timeout verdict 유지 + late accept 없음 + handle invalidate", async () => {
  const approver = makeApprover();
  const { adapter, run, client, t } = await startAppr("to", approver, {}, { timeoutMs: 40 });
  client.serverRequest(81, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  await new Promise((r) => setTimeout(r, 90)); // ref'd keepalive past timeout
  const r = await run.promise;
  approver.approve(0); // late
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(r.timedOut, true);
  const accepts = client.responses.filter((x) => x.result && x.result.decision === "accept");
  assert.equal(accepts.length, 0, "timeout 후 late accept 금지");
  // handle invalidated -> 다음 turn fail-closed
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv({ requestApproval: approver.requestApproval }), session: session("to") }).promise;
  assert.equal(r2.ok, false);
});

test("AC output-limit while pending: output-limit verdict 유지 + late accept 없음", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("ol", approver, {}, { hardOutputLimitBytes: 10 });
  client.serverRequest(82, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  // 큰 notification으로 hard output-limit 초과 유도(_noteActivity에서 강제 finalize)
  client.emit("item/agentMessage/delta", { threadId: t.threadId, turnId: t.id, itemId: "m", delta: "x".repeat(200) });
  const r = await run.promise;
  approver.approve(0); // late
  await new Promise((rs) => setTimeout(rs, 10));
  assert.equal(r.outputLimited, true);
  const accepts = client.responses.filter((x) => x.result && x.result.decision === "accept");
  assert.equal(accepts.length, 0, "output-limit 후 late accept 금지");
});

test("AD app-server close while pending: human 취소 + late 무효 + continuity-loss + handle invalidate", async () => {
  const approver = makeApprover();
  const { adapter, run, client, t } = await startAppr("cl", approver);
  client.serverRequest(91, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  client.die("CODEX_SESSION_LOST");
  const r = await run.promise;
  approver.approve(0); // late (client dead)
  await new Promise((rs) => setTimeout(rs, 10));
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_SESSION_LOST");
  const accepts = client.responses.filter((x) => x.result && x.result.decision === "accept");
  assert.equal(accepts.length, 0, "close 후 accept 없음");
  const r2 = await adapter.runTurn({ context: ctx(), invocation: inv({ requestApproval: approver.requestApproval }), session: session("cl") }).promise;
  assert.equal(r2.ok, false, "죽은 연결 재사용 fail-closed");
});

test("AE/AF callback error/absent: 자동 승인 금지 -> safe decline", async () => {
  const throwing = { requestApproval: () => { throw new Error("boom"); } };
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ requestApproval: throwing.requestApproval }), session: session("ae") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  client.serverRequest(101, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0].result, { decision: "decline" }, "throw는 자동 승인이 아니라 safe decline");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;

  // 콜백 부재: never policy지만 방어적으로 요청이 와도 safe decline
  const { adapter: a2, getClient: g2 } = makeAdapter();
  const run2 = a2.runTurn({ context: ctx(), invocation: inv(), session: session("af") });
  await waitUntil(() => g2() && countTurnStarts(g2()) >= 1);
  const c2 = g2();
  const t2 = c2.turnsIssued[0];
  c2.serverRequest(102, "item/commandExecution/requestApproval", cmdApprovalParams(t2));
  await waitUntil(() => c2.responses.length >= 1);
  assert.deepEqual(c2.responses[0].result, { decision: "decline" });
  await completeTurn(c2, t2.threadId, t2.id, { finalText: "ok" });
  await run2.promise;
});

test("AG/AH permissions request: full grant 없이 빈 grant + turn scope로 safe-deny(session/human 아님)", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("perm", approver);
  client.serverRequest(111, "item/permissions/requestApproval", { threadId: t.threadId, turnId: t.id, itemId: "p1", permissions: { network: { enabled: true }, fileSystem: null } });
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0].result, { permissions: {}, scope: "turn" });
  assert.equal(approver.calls.length, 0, "permissions는 boolean human 승인 대상이 아니다");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("AK duplicate request id: human prompt/accept 각각 최대 1회", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("dup", approver);
  client.serverRequest(121, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  client.serverRequest(121, "item/commandExecution/requestApproval", cmdApprovalParams(t)); // duplicate id
  await waitUntil(() => approver.calls.length >= 1);
  assert.equal(approver.calls.length, 1, "중복 id는 두 번째 prompt를 만들지 않는다");
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  assert.equal(client.responses.filter((r) => r.id === 121).length, 1, "중복 id 응답도 1회");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("AL 두 distinct pending id: 상태 교차/overwrite 없이 각자 정확히 응답", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("two", approver);
  client.serverRequest(131, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c1", command: "cmd1" }));
  client.serverRequest(132, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c2", command: "cmd2" }));
  await waitUntil(() => approver.calls.length >= 2);
  approver.approve(1); // 2번째 요청(132) 승인
  approver.deny(0);    // 1번째 요청(131) 거절
  await waitUntil(() => client.responses.length >= 2);
  const byId = Object.fromEntries(client.responses.map((r) => [r.id, r.result.decision]));
  assert.equal(byId[131], "decline");
  assert.equal(byId[132], "accept");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("AO approve 후 같은 handle의 다음 turn은 기존 thread를 재사용한다(새 thread 강제 없음)", async () => {
  const approver = makeApprover();
  const { adapter, run, client, t } = await startAppr("re", approver);
  client.serverRequest(141, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  await completeTurn(client, t.threadId, t.id, { finalText: "one" });
  await run.promise;
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv({ requestApproval: approver.requestApproval }), session: session("re") });
  await waitUntil(() => countTurnStarts(client) >= 2);
  assert.equal(countThreadStarts(client), 1, "approval 후에도 새 thread를 강제하지 않는다");
  const t2 = client.turnsIssued[1];
  assert.equal(t2.threadId, t.threadId, "같은 thread 재사용");
  await completeTurn(client, t2.threadId, t2.id, { finalText: "two" });
  assert.equal((await run2.promise).text, "two");
});

test("AP/AQ/AR Evidence/RunMetrics continuity: 승인 전후 command가 한 Evidence에, RunMetrics는 하나", async () => {
  const approver = makeApprover();
  const events = [];
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ requestApproval: approver.requestApproval, onEvent: (e) => events.push(e) }), session: session("ev") });
  await waitUntil(() => getClient() && countTurnStarts(getClient()) >= 1);
  const client = getClient();
  const t = client.turnsIssued[0];
  client.emit("item/started", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c1", command: "cmd1" } });
  client.emit("item/completed", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c1", command: "cmd1", exitCode: 0 } });
  client.serverRequest(151, "item/commandExecution/requestApproval", cmdApprovalParams(t, { itemId: "c2", command: "cmd2" }));
  await waitUntil(() => approver.calls.length >= 1);
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  client.emit("item/started", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c2", command: "cmd2" } });
  client.emit("item/completed", { threadId: t.threadId, turnId: t.id, item: { type: "commandExecution", id: "c2", command: "cmd2", exitCode: 0 } });
  await completeTurn(client, t.threadId, t.id, { finalText: "final" });
  const r = await run.promise;
  assert.ok(r.evidence, "evidence 존재");
  assert.equal(r.evidence.commandSummary.total, 2, "승인 전후 command가 한 Evidence에");
  const metricEvents = events.filter((e) => e.kind === "run-metrics");
  assert.equal(metricEvents.length, 1, "RunMetrics는 하나(invocation 당)");
  assert.equal(r.runMetrics.stopReason, "COMPLETED");
});

test("AK2 이미 응답한 request id 재전송은 재prompt/재응답 없음(idempotent, §duplicate)", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("dup2", approver);
  client.serverRequest(161, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  approver.approve(0);
  await waitUntil(() => client.responses.length >= 1);
  assert.deepEqual(client.responses[0], { id: 161, result: { decision: "accept" } });
  client.serverRequest(161, "item/commandExecution/requestApproval", cmdApprovalParams(t)); // 재전송
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(approver.calls.length, 1, "응답완료 id 재전송은 재prompt하지 않는다");
  assert.equal(client.responses.filter((x) => x.id === 161).length, 1, "재응답 없음");
  await completeTurn(client, t.threadId, t.id, { finalText: "ok" });
  await run.promise;
});

test("§53 turn/completed가 approval 대기 중 먼저 오면 late accept 없이 정상 finalize + pending cleanup", async () => {
  const approver = makeApprover();
  const { run, client, t } = await startAppr("tcp", approver);
  client.serverRequest(171, "item/commandExecution/requestApproval", cmdApprovalParams(t));
  await waitUntil(() => approver.calls.length >= 1);
  await completeTurn(client, t.threadId, t.id, { finalText: "done" }); // 비정상 race
  const r = await run.promise;
  approver.approve(0); // late
  await new Promise((rs) => setTimeout(rs, 10));
  assert.equal(r.ok, true);
  assert.equal(r.text, "done", "정상 finalize authority 유지");
  assert.ok(approver.calls[0].aborted, "pending human UI dismiss");
  const accepts = client.responses.filter((x) => x.result && x.result.decision === "accept");
  assert.equal(accepts.length, 0, "turn 완료 후 late accept 없음");
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
function spyAgy() { const calls = []; return { id: "agy-managed", supportsPersistentSession: true, calls, runTurn({ context, session }) { calls.push({ context, session }); return { promise: Promise.resolve({ ok: true, tag: "agy", key: session && session.key }), cancel() {} }; } }; }
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

test("49.10/49.11 Professional Claude/AGY는 각자 등록된 managed adapter로 라우팅된다", async () => {
  // Stage C 이후 Professional Claude/AGY 실행은 각각 Claude/AGY ManagedAdapter로 간다.
  const codex = spyCodex(); const claude = spyClaude(); const agy = spyAgy(); const proc = spyProcess();
  const rt = createDefaultHarnessRuntime({ processAdapter: proc, codexAdapter: codex, claudeAdapter: claude, agyAdapter: agy });
  await rt.runTurn({ context: rctx({ providerId: "claude" }), invocation: RINV }).promise;
  await rt.runTurn({ context: rctx({ providerId: "agy" }), invocation: RINV }).promise;
  assert.equal(claude.calls.length, 1, "Claude professional -> claude managed");
  assert.equal(agy.calls.length, 1, "AGY professional -> agy managed");
  assert.equal(codex.calls.length, 0, "Codex managed 미사용");
  assert.equal(proc.calls.length, 0, "professional은 Process 미사용");
});
