"use strict";

// Stage C-3 — CodexAppServerClient transport (fake child; no network/codex).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { CodexAppServerClient } = require("../src/harness/codex/codex-app-server-client");

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.written = [];
  child.stdin = {
    writable: true,
    on() {},
    end() {},
    write(s) { child.written.push(String(s)); return true; },
  };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.pushLine = (obj) => child.stdout.emit("data", Buffer.from((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n"));
  child.pushRaw = (s) => child.stdout.emit("data", Buffer.from(s));
  child.sent = () => child.written.map((w) => { try { return JSON.parse(w); } catch { return w; } });
  return child;
}

function makeClient(child, hooks = {}) {
  let spawnCount = 0;
  const client = new CodexAppServerClient({
    commandPath: "codex",
    needsShell: false,
    spawnFn: () => { spawnCount += 1; return child; },
    onNotification: hooks.onNotification || (() => {}),
    onServerRequest: hooks.onServerRequest || (() => {}),
    onClose: hooks.onClose || (() => {}),
  });
  client._spawnCount = () => spawnCount;
  return client;
}

async function handshake(child, client) {
  const startP = client.start();
  const initReq = child.sent()[0];
  child.pushLine({ id: initReq.id, result: { codexHome: "/home/.codex", platformOs: "linux" } });
  await startP;
  return initReq;
}

test("1) 최초 전송은 initialize request다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  assert.equal(child.sent()[0].method, "initialize");
  assert.ok(child.sent()[0].id != null);
});

test("2) initialize 응답 후 initialized notification을 보낸다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  const msgs = child.sent();
  assert.equal(msgs[0].method, "initialize");
  assert.equal(msgs[1].method, "initialized");
  assert.equal(msgs[1].id, undefined); // notification: id 없음
  assert.equal(client.state, "ready");
});

test("3) handshake 완료 전에는 request가 거부된다(fail-closed)", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await assert.rejects(() => client.request("thread/start", {}), /READY가 아닙니다/);
});

test("4) out-of-order response도 정확히 correlation된다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  const p2 = client.request("thread/start", {});
  const p3 = client.request("turn/start", {});
  const r2 = child.sent()[2];
  const r3 = child.sent()[3];
  child.pushLine({ id: r3.id, result: { turn: { id: "t" } } });
  child.pushLine({ id: r2.id, result: { thread: { id: "thr" } } });
  assert.deepEqual(await p2, { thread: { id: "thr" } });
  assert.deepEqual(await p3, { turn: { id: "t" } });
});

test("5) 한 줄이 여러 chunk로 나뉘어도 파싱한다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  const p = client.request("thread/start", {});
  const req = child.sent()[2];
  const full = JSON.stringify({ id: req.id, result: { thread: { id: "thr" } } }) + "\n";
  child.pushRaw(full.slice(0, 10));
  child.pushRaw(full.slice(10));
  assert.deepEqual(await p, { thread: { id: "thr" } });
});

test("6) 한 chunk에 여러 JSONL 메시지가 와도 파싱한다", async () => {
  const child = makeFakeChild();
  const notes = [];
  const client = makeClient(child, { onNotification: (m, p) => notes.push([m, p]) });
  await handshake(child, client);
  child.pushRaw(JSON.stringify({ method: "turn/started", params: { a: 1 } }) + "\n" + JSON.stringify({ method: "turn/completed", params: { b: 2 } }) + "\n");
  assert.deepEqual(notes.map((n) => n[0]), ["turn/started", "turn/completed"]);
});

test("7) 미사용이지만 유효한 notification은 protocol crash가 아니다", async () => {
  const child = makeFakeChild();
  const notes = [];
  const client = makeClient(child, { onNotification: (m) => notes.push(m) });
  await handshake(child, client);
  child.pushLine({ method: "some/futureNotification", params: {} });
  assert.equal(client.state, "ready");
  assert.deepEqual(notes, ["some/futureNotification"]);
});

test("8) malformed protocol stdout은 fail-closed", async () => {
  const child = makeFakeChild();
  let closeInfo = null;
  const client = makeClient(child, { onClose: (i) => { closeInfo = i; } });
  await handshake(child, client);
  child.pushLine("this is not json");
  assert.equal(client.state, "lost");
  assert.equal(closeInfo.reason, "lost");
  assert.equal(closeInfo.code, "CODEX_APP_SERVER_PROTOCOL_ERROR");
});

test("9) child spawn 실패는 명시적 start 실패", async () => {
  const client = new CodexAppServerClient({
    commandPath: "codex",
    spawnFn: () => { throw new Error("ENOENT"); },
  });
  await assert.rejects(() => client.start(), (e) => e.code === "CODEX_APP_SERVER_START_FAILED");
});

test("10) READY 이후 child close는 session lost", async () => {
  const child = makeFakeChild();
  let closeInfo = null;
  const client = makeClient(child, { onClose: (i) => { closeInfo = i; } });
  await handshake(child, client);
  child.emit("close", 0);
  assert.equal(client.state, "lost");
  assert.equal(closeInfo.code, "CODEX_SESSION_LOST");
});

test("11) READY 이후 죽어도 자동 restart하지 않는다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  child.emit("close", 0);
  // 이후 request는 새 spawn 없이 fail-closed
  await assert.rejects(() => client.request("turn/start", {}), /READY가 아닙니다/);
  assert.equal(client._spawnCount(), 1);
});

test("12) stderr 버퍼는 무한정 커지지 않는다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  for (let i = 0; i < 100; i += 1) child.stderr.emit("data", Buffer.from("x".repeat(10000)));
  assert.ok(client._stderr.length < 300 * 1024); // MAX(256KB)+한 chunk 이내로 bounded(무한정 아님)
  assert.equal(client.state, "ready");
});

test("pending request는 연결 상실 시 reject된다", async () => {
  const child = makeFakeChild();
  const client = makeClient(child);
  await handshake(child, client);
  const p = client.request("turn/start", {});
  child.emit("close", 0);
  await assert.rejects(() => p, (e) => e.code === "CODEX_SESSION_LOST");
});
