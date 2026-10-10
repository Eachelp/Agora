"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agora-b3-"));
// F143 찢긴 JSONL 줄 뒤 첫 기록 유실.
const { ChatStore } = require("../src/chat/chat-store");

function storeWithSession() {
  const store = new ChatStore({ root: tmp() });
  store.init();
  const meta = store.createSession({ title: "t" });
  return { store, id: meta.id };
}
const msg = (text) => ({ kind: "message", message: { id: text, authorType: "user", text } });
const texts = (store, id) => store.readMessages(id).map((m) => m.text);

test("F143 찢긴 마지막 줄 뒤의 첫 기록이 조각에 붙어 사라지지 않는다", () => {
  const { store, id } = storeWithSession();
  store.appendEvent(id, msg("m1"));
  fs.appendFileSync(store.transcriptPath(id), '{"v":1,"ts":5,"kind":"mess'); // 개행 없이 끊김
  store.appendEvent(id, msg("m2"));
  store.appendEvent(id, msg("m3"));
  assert.deepEqual(texts(store, id), ["m1", "m2", "m3"]);
});

test("F143 이미 조각에 붙어 버린 옛 파일에서도 뒤쪽 온전한 기록을 읽는다", () => {
  const { store, id } = storeWithSession();
  store.appendEvent(id, msg("m1"));
  const entry = JSON.stringify({ v: 1, ts: 9, ...msg("m2") });
  fs.appendFileSync(store.transcriptPath(id), `{"v":1,"ts":5,"kind":"mess${entry}\n`);
  assert.deepEqual(texts(store, id), ["m1", "m2"]);
});

test("F143 NUL로 끝난 파일 뒤에도 새 줄에서 시작한다", () => {
  const { store, id } = storeWithSession();
  store.appendEvent(id, msg("m1"));
  fs.appendFileSync(store.transcriptPath(id), Buffer.alloc(8));
  store.appendEvent(id, msg("m2"));
  assert.deepEqual(texts(store, id), ["m1", "m2"]);
});

