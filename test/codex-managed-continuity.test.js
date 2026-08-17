"use strict";

// Stage C-3 보정 — BLOCKER 1(turnId correlation) & BLOCKER 2(ambiguous RPC/interrupt continuity).
// fake client transport only (no network/codex).

const test = require("node:test");
const assert = require("node:assert/strict");

const { CodexManagedAdapter } = require("../src/harness/codex/codex-managed-adapter");

function makeFakeClient(opts = {}) {
  return {
    state: "new", started: 0, requests: [], responses: [], interrupts: [], turnsIssued: [],
    _threadSeq: 0, _turnSeq: 0, _notify: null, _serverReq: null, _onClose: null,
    isReady() { return this.state === "ready"; },
    start() { this.state = "ready"; this.started += 1; return Promise.resolve(this); },
    request(method, params) {
      this.requests.push({ method, params });
      if (method === "thread/start") return Promise.resolve({ thread: { id: `thr_${++this._threadSeq}` } });
      if (method === "turn/start") {
        if (opts.turnStartError) { const e = new Error(opts.turnStartError.message || "turn/start error"); e.code = opts.turnStartError.code; return Promise.reject(e); }
        const id = `turn_${++this._turnSeq}`;
        this.turnsIssued.push({ threadId: params.threadId, id });
        return Promise.resolve({ turn: { id, status: "inProgress" } });
      }
      if (method === "turn/interrupt") {
        this.interrupts.push(params);
        if (opts.interruptPending) return new Promise(() => {}); // 영원히 pending(resolve/reject 안 됨)
        if (opts.interruptFails) { const e = new Error("interrupt failed"); e.code = "CODEX_APP_SERVER_PROTOCOL_ERROR"; return Promise.reject(e); }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    respond(id, result) { this.responses.push({ id, result }); return true; },
    notify() { return true; },
    close() { this.state = "closed"; },
    emit(m, p) { this._notify(m, p); },
    serverRequest(id, m, p) { this._serverReq(id, m, p); },
    die(code) { if (this.state === "lost") return; this.state = "lost"; this._onClose({ reason: "lost", code: code || "CODEX_SESSION_LOST" }); },
  };
}
function makeAdapter(opts = {}) {
  let client = null;
  const adapter = new CodexManagedAdapter({
    createClient: (o) => { client = makeFakeClient(opts); client._notify = o.onNotification; client._serverReq = o.onServerRequest; client._onClose = o.onClose; return client; },
  });
  return { adapter, getClient: () => client };
}
async function waitUntil(pred, ms = 1000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timeout waiting"); await new Promise((r) => setTimeout(r, 1)); }
}
async function tick(n = 3) { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 1)); }
function turnStarts(c) { return c.requests.filter((r) => r.method === "turn/start").length; }
function threadStarts(c) { return c.requests.filter((r) => r.method === "thread/start").length; }

const ctx = (over = {}) => ({ projectId: "p", workspaceId: null, professionalRunId: "pr", role: "implementation", providerId: "codex", modelKey: "gpt-x", permissionMode: "chat", ...over });
const inv = (over = {}) => ({ commandPath: "codex", needsShell: false, prompt: "작업", cwd: "/chat-runtime", requireFinal: true, ...over });
const sess = (key, generation = 1) => ({ key, generation });

async function runAndComplete(adapter, getClient, key, { finalText = "ok" } = {}) {
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess(key) });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  const t = c.turnsIssued[c.turnsIssued.length - 1];
  c.emit("item/completed", { threadId: t.threadId, turnId: t.id, item: { type: "agentMessage", id: "m", text: finalText } });
  c.emit("turn/completed", { threadId: t.threadId, turn: { id: t.id, status: "completed" } });
  await run.promise;
  return { threadId: t.threadId, turnId: t.id };
}

// ---------------- BLOCKER 1 ----------------

test("B1-A: 이전 turn의 늦은 delta가 다음 turn collector/evidence에 들어가지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const a = await runAndComplete(adapter, getClient, "k");
  const c = getClient();

  const evB = [];
  const runB = adapter.runTurn({ context: ctx(), invocation: inv({ onEvent: (e) => evB.push(e) }), session: sess("k") });
  await waitUntil(() => turnStarts(c) >= 2);
  const b = c.turnsIssued[1];
  assert.equal(b.threadId, a.threadId, "같은 session -> 같은 thread 재사용");

  // 이전 turn A의 늦은 delta(turnId=A) 도착
  c.emit("item/agentMessage/delta", { threadId: a.threadId, turnId: a.turnId, itemId: "x", delta: "A-STALE" });
  // 현재 turn B의 정상 delta
  c.emit("item/agentMessage/delta", { threadId: b.threadId, turnId: b.id, itemId: "y", delta: "B-live" });

  const bDeltas = evB.filter((e) => e.kind === "delta").map((e) => e.text);
  assert.deepEqual(bDeltas, ["B-live"], "A의 stale delta는 drop되어야 한다");

  c.emit("item/completed", { threadId: b.threadId, turnId: b.id, item: { type: "agentMessage", id: "m", text: "B done" } });
  c.emit("turn/completed", { threadId: b.threadId, turn: { id: b.id, status: "completed" } });
  const rB = await runB.promise;
  assert.equal(rB.text, "B done");
  assert.ok(!JSON.stringify(rB).includes("A-STALE"));
});

test("B1-B: 이전 turn의 늦은 turn/completed가 현재 turn을 finalize하지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const a = await runAndComplete(adapter, getClient, "k");
  const c = getClient();
  const runB = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await waitUntil(() => turnStarts(c) >= 2);
  const b = c.turnsIssued[1];
  let bDone = false; runB.promise.then(() => { bDone = true; });

  // A의 늦은 turn/completed(turnId=A) 도착
  c.emit("turn/completed", { threadId: a.threadId, turn: { id: a.turnId, status: "completed" } });
  await tick();
  assert.equal(bDone, false, "stale turn/completed로 B가 완료되면 안 된다");

  c.emit("item/completed", { threadId: b.threadId, turnId: b.id, item: { type: "agentMessage", id: "m", text: "B done" } });
  c.emit("turn/completed", { threadId: b.threadId, turn: { id: b.id, status: "completed" } });
  const rB = await runB.promise;
  assert.equal(rB.text, "B done");
});

test("B1-C: 이전 turn의 늦은 approval request가 현재 turn을 approvalRequired로 만들지 않는다", async () => {
  const { adapter, getClient } = makeAdapter();
  const a = await runAndComplete(adapter, getClient, "k");
  const c = getClient();
  const runB = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await waitUntil(() => turnStarts(c) >= 2);
  const b = c.turnsIssued[1];
  let bDone = false; runB.promise.then(() => { bDone = true; });

  // A의 늦은 approval(turnId=A)
  c.serverRequest(77, "item/commandExecution/requestApproval", { threadId: a.threadId, turnId: a.turnId, command: ["x"], cwd: "/w" });
  await tick();
  assert.equal(bDone, false, "stale approval로 B가 종료되면 안 된다");
  // 그래도 서버 unblock 위해 deny 응답은 보냈다
  assert.deepEqual(c.responses.find((r) => r.id === 77).result, { decision: "cancel" });

  c.emit("item/completed", { threadId: b.threadId, turnId: b.id, item: { type: "agentMessage", id: "m", text: "B done" } });
  c.emit("turn/completed", { threadId: b.threadId, turn: { id: b.id, status: "completed" } });
  const rB = await runB.promise;
  assert.equal(rB.ok, true);
  assert.equal(rB.approvalRequired, undefined);
});

test("B1-D: authoritative source(turn/start 응답 vs turn/started)의 turnId 충돌은 fail-closed", async () => {
  const { adapter, getClient } = makeAdapter();
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await waitUntil(() => getClient() && turnStarts(getClient()) >= 1);
  const c = getClient();
  const t = c.turnsIssued[0]; // RPC 응답이 확정한 turnId
  // turn/started가 다른 id를 주장
  c.emit("turn/started", { threadId: t.threadId, turn: { id: "DIFFERENT" } });
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_APP_SERVER_PROTOCOL_ERROR");
  // 다음 turn은 손상된 handle을 재사용하지 않는다(fail-closed)
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_APP_SERVER_PROTOCOL_ERROR");
});

// ---------------- BLOCKER 2 ----------------

test("B2-A: turn/start ambiguous timeout -> handle continuity 불신, 다음 run fail-closed", async () => {
  const { adapter, getClient } = makeAdapter({ turnStartError: { code: "CODEX_APP_SERVER_PROTOCOL_ERROR", message: "RPC timeout" } });
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.equal(r.stopReason, "CODEX_TURN_START_AMBIGUOUS");
  const c = getClient();
  assert.equal(turnStarts(c), 1);

  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_TURN_START_AMBIGUOUS");
  assert.equal(turnStarts(c), 1, "손상된 handle에 turn/start를 다시 보내지 않는다");
});

test("B2-A2: 명시적 rpc error(서버 거부)는 continuity를 손상시키지 않고 thread 재사용 가능", async () => {
  const { adapter, getClient } = makeAdapter({ turnStartError: { code: "CODEX_APP_SERVER_RPC_ERROR", message: "invalid params" } });
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r = await run.promise;
  assert.equal(r.ok, false);
  assert.notEqual(r.stopReason, "CODEX_TURN_START_AMBIGUOUS", "clean rejection은 ambiguous가 아니다");
  const c = getClient();
  // 두 번째 run: handle이 invalidate되지 않았으므로 기존 thread를 재사용하고 turn/start를 다시 시도한다
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await run2.promise;
  assert.equal(threadStarts(c), 1, "thread는 재사용(추가 thread/start 없음)");
  assert.equal(turnStarts(c), 2, "clean rejection 후에도 다음 turn을 정상 시도");
});

test("B2-B: timeout 후 interrupt 실패 -> 같은 native thread를 다음 turn에서 재사용하지 않는다", async () => {
  const { adapter, getClient } = makeAdapter({ interruptFails: true });
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ timeoutMs: 20 }), session: sess("k") });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  // unref된 timeout(20ms)이 확실히 발화하도록 이벤트 루프를 잠깐 ref로 유지한다
  await new Promise((r) => setTimeout(r, 60));
  const r = await run.promise; // timeout 발생
  assert.equal(r.timedOut, true);
  await waitUntil(() => c.interrupts.length >= 1);
  await tick(); // interrupt reject -> invalidate 반영

  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_TURN_INTERRUPT_FAILED");
  assert.equal(turnStarts(c), 1, "손상된 native thread에 다음 turn을 이어서 실행하지 않는다");
});

test("B2-C: output-limit interrupt 실패도 동일하게 continuity를 안전하게 처리", async () => {
  const { adapter, getClient } = makeAdapter({ interruptFails: true });
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ hardOutputLimitBytes: 10 }), session: sess("k") });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  const t = c.turnsIssued[0];
  // 상한을 넘기는 delta
  c.emit("item/agentMessage/delta", { threadId: t.threadId, turnId: t.id, itemId: "x", delta: "x".repeat(200) });
  const r = await run.promise;
  assert.equal(r.outputLimited, true);
  await waitUntil(() => c.interrupts.length >= 1);
  await tick();
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.stopReason, "CODEX_TURN_INTERRUPT_FAILED");
});

test("B2-D: 정상 interrupt 성공 + 정상 흐름은 thread 재사용을 막지 않는다", async () => {
  const { adapter, getClient } = makeAdapter(); // interrupt 성공
  const run = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  const t = c.turnsIssued[0];
  run.cancel();
  await waitUntil(() => c.interrupts.length >= 1);
  c.emit("turn/completed", { threadId: t.threadId, turn: { id: t.id, status: "interrupted" } });
  const r = await run.promise;
  assert.equal(r.cancelled, true);
  await tick();
  // 정상 cancel 후 같은 session은 계속 사용 가능(handle 손상 아님)
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  await waitUntil(() => turnStarts(c) >= 2);
  const t2 = c.turnsIssued[1];
  c.emit("item/completed", { threadId: t2.threadId, turnId: t2.id, item: { type: "agentMessage", id: "m", text: "again" } });
  c.emit("turn/completed", { threadId: t2.threadId, turn: { id: t2.id, status: "completed" } });
  const r2 = await run2.promise;
  assert.equal(r2.text, "again");
  assert.equal(threadStarts(c), 1, "정상 cancel 후 같은 thread 재사용");
});


// interrupt Promise가 확정되기 전(pending)에 다음 turn이 native thread를 선점하지 못하는지 검증한다.
// 이것이 진짜 BLOCKER 2 close 조건이다: forced local finalize 시 handle은 즉시 invalidate되어야 한다.

test("B2-B2: timeout + interrupt Promise가 pending이어도 다음 turn이 같은 native thread에 turn/start를 보내지 않는다", async () => {
  const { adapter, getClient } = makeAdapter({ interruptPending: true });
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ timeoutMs: 20 }), session: sess("k") });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  // unref된 timeout(20ms)이 발화하도록 이벤트 루프를 잠깐 ref로 유지
  await new Promise((r) => setTimeout(r, 60));
  const r = await run.promise;
  assert.equal(r.timedOut, true);
  assert.equal(c.interrupts.length, 1, "best-effort interrupt는 보냈다");

  // interrupt Promise는 여전히 pending(resolve/reject 안 됨). 그래도 handle은 이미 invalidate됨.
  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_TURN_INTERRUPT_FAILED");
  assert.equal(turnStarts(c), 1, "pending interrupt 상태에서도 손상 native thread에 turn/start를 보내지 않는다");
});

test("B2-C2: output-limit + interrupt Promise pending도 동일하게 race 없이 fail-closed", async () => {
  const { adapter, getClient } = makeAdapter({ interruptPending: true });
  const run = adapter.runTurn({ context: ctx(), invocation: inv({ hardOutputLimitBytes: 10 }), session: sess("k") });
  await waitUntil(() => getClient() && getClient().turnsIssued.length >= 1);
  const c = getClient();
  const t = c.turnsIssued[0];
  c.emit("item/agentMessage/delta", { threadId: t.threadId, turnId: t.id, itemId: "x", delta: "x".repeat(200) });
  const r = await run.promise;
  assert.equal(r.outputLimited, true);
  assert.equal(c.interrupts.length, 1);

  const run2 = adapter.runTurn({ context: ctx(), invocation: inv(), session: sess("k") });
  const r2 = await run2.promise;
  assert.equal(r2.ok, false);
  assert.equal(r2.stopReason, "CODEX_TURN_INTERRUPT_FAILED");
  assert.equal(turnStarts(c), 1, "pending interrupt 상태에서도 손상 native thread에 turn/start를 보내지 않는다");
});
