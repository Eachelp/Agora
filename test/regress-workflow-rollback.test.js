"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agora-b3-"));
// F94 workflow 저장 실패 롤백.
const { WorkflowStore } = require("../src/agora/workflow-store");

test("F94 저장 실패 롤백이 schemaVersion과 제자리 수정까지 되돌린다", () => {
  const root = tmp();
  const store = new WorkflowStore({ root }).init();
  const task = store.createTask({ projectId: "p", title: "원래 제목", chatId: "c" });
  const before = structuredClone(store.data);
  const realPersist = store.persist.bind(store);
  store.persist = () => { throw new Error("EPERM"); };
  assert.throws(() => store.mutateAndPersist(() => {
    store.data.tasks.find((t) => t.id === task.id).title = "바뀐 제목";
    store.data.decisions.push({ id: "x" });
  }), /EPERM/);
  assert.deepEqual(store.data, before);
  assert.ok(store.data.schemaVersion);
  store.persist = realPersist;
  store.createTask({ projectId: "p", title: "다시" });
  const onDisk = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.equal(onDisk.schemaVersion, before.schemaVersion);
});

