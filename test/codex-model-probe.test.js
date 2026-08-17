"use strict";

// Stage C-3 보정 — BLOCKER 3: probeCodexModelCatalog가 App Server handshake를
// (initialize -> initialize response -> initialized notification -> model/list)로 완성한다.
// fake child(injected spawnFn)만 사용(no network/codex).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { probeCodexModelCatalog } = require("../src/providers/provider-capabilities");

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.written = [];
  child.stdin = { on() {}, write(str) { child.written.push(String(str)); return true; } };
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.pushLine = (obj) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  child.sent = () => child.written.map((w) => { try { return JSON.parse(w); } catch { return w; } });
  return child;
}

test("A: initialize response 전에는 model/list를 보내지 않는다", async () => {
  const child = makeChild();
  const p = probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => child });
  // 아직 응답 전: initialize만 전송돼 있어야 한다
  const sent = child.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "initialize");
  // cleanup: 응답 주고 종료
  child.pushLine({ id: 1, result: { codexHome: "/x" } });
  child.pushLine({ id: 2, result: { data: [] } });
  await p;
});

test("B/C: initialize response 후 initialized notification을 먼저, 그 다음 model/list", async () => {
  const child = makeChild();
  const p = probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => child });
  child.pushLine({ id: 1, result: { codexHome: "/x", platformOs: "linux" } });
  const sent = child.sent();
  assert.equal(sent[0].method, "initialize");
  assert.equal(sent[1].method, "initialized");
  assert.equal(sent[1].id, undefined, "initialized는 notification(id 없음)");
  assert.equal(sent[2].method, "model/list");
  assert.equal(sent[2].id, 2);
  child.pushLine({ id: 2, result: { data: [] } });
  await p;
});

test("D: 정상 catalog 응답을 파싱한다", async () => {
  const child = makeChild();
  const p = probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => child });
  child.pushLine({ id: 1, result: { codexHome: "/x" } });
  child.pushLine({
    id: 2,
    result: {
      data: [
        { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        { model: "hidden-x", hidden: true },
      ],
    },
  });
  const result = await p;
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "gpt-5.6-sol");
  assert.equal(result[0].isDefault, true);
  assert.deepEqual(result[0].efforts, ["low", "high"]);
});

test("E1: handshake timeout 시 null로 안전하게 종료", async () => {
  const child = makeChild();
  const pr = probeCodexModelCatalog("codex", false, 30, { spawnFn: () => child });
  // unref된 probe timeout timer가 발화하도록 이벤트 루프를 잠깐 ref로 유지한다
  await new Promise((r) => setTimeout(r, 60));
  const result = await pr;
  assert.equal(result, null);
  assert.equal(child.killed, true, "timeout 시 child를 정리한다");
});

test("E2: child close/실패 시 null", async () => {
  const child = makeChild();
  const p = probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => child });
  child.emit("close", 1);
  assert.equal(await p, null);
});

test("E3: spawn throw 시 null(기존 fail-safe 유지)", async () => {
  const result = await probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => { throw new Error("ENOENT"); } });
  assert.equal(result, null);
});

test("malformed protocol line은 무시하고 계속(기존 fail-safe 유지)", async () => {
  const child = makeChild();
  const p = probeCodexModelCatalog("codex", false, 5000, { spawnFn: () => child });
  child.stdout.emit("data", Buffer.from("not-json-banner\n"));
  child.pushLine({ id: 1, result: { codexHome: "/x" } });
  child.pushLine({ id: 2, result: { data: [{ model: "m1" }] } });
  const result = await p;
  assert.equal(result[0].id, "m1");
});
