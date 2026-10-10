const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WorkflowStore,
  TASK_STATUSES,
  ROLE_DEFS,
} = require("../src/agora/workflow-store");

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-workflow-store-"));
  return fs.realpathSync(dir);
}

test("결정과 작업은 안정적인 id로 저장하고 다시 읽을 수 있다", () => {
  const root = makeRoot();
  let clock = 100;
  const store = new WorkflowStore({ root, now: () => (clock += 1) }).init();
  const decision = store.createDecision({
    projectId: "project-a",
    title: "채팅 코어 유지",
    content: "기존 멀티에이전트 채팅을 유지한다.",
    chatId: "session-a",
    messageIds: ["m1", "m1", "m2"],
  });
  const task = store.createTask({
    projectId: "project-a",
    title: "작업 화면 만들기",
    description: "프로젝트 작업을 기록한다.",
    role: "implementation",
    agentId: "codex",
    decisionId: decision.id,
    chatId: "session-a",
  });

  assert.match(decision.id, /^d/);
  assert.match(task.id, /^t/);
  assert.deepEqual(decision.messageIds, ["m1", "m2"]);
  assert.equal(task.status, "todo");
  assert.equal(store.deleteDecision(decision.id), false);
  assert.deepEqual(store.forProject("project-a").roles, ROLE_DEFS);
  assert.deepEqual(store.forProject("project-a").statuses, TASK_STATUSES);

  const reloaded = new WorkflowStore({ root }).init();
  assert.equal(reloaded.getDecision(decision.id).content, decision.content);
  assert.equal(reloaded.getTask(task.id).decisionId, decision.id);
  assert.equal(reloaded.listTasks("other-project").length, 0);
});

test("작업 상태를 바꾸고 프로젝트 삭제 시 기록을 기본 프로젝트로 옮긴다", () => {
  const root = makeRoot();
  const store = new WorkflowStore({ root }).init();
  const task = store.createTask({ projectId: "project-a", title: "검토하기", role: "review" });
  const updated = store.updateTask(task.id, { status: "review", agentId: "claude" });

  assert.equal(updated.status, "review");
  assert.equal(updated.agentId, "claude");
  store.moveProjectItems("project-a", "uncategorized");
  assert.equal(store.listTasks("project-a").length, 0);
  assert.equal(store.listTasks("uncategorized")[0].id, task.id);
});

test("손상된 workflow 파일은 덮어쓰지 않고 읽기 전용으로 연다", () => {
  const root = makeRoot();
  const file = path.join(root, "workflow.json");
  fs.writeFileSync(file, "{깨진 JSON", "utf8");
  const store = new WorkflowStore({ root }).init();
  assert.equal(store.readOnly, true);
  assert.throws(() => store.createTask({ projectId: "p", title: "실행" }), /읽기 전용/);
  assert.equal(fs.readFileSync(file, "utf8"), "{깨진 JSON");
});

test("file 기반 Task는 contentSource/taskPath/taskHash를 저장하고 description은 복제하지 않는다", () => {
  const root = makeRoot();
  const store = new WorkflowStore({ root }).init();
  const task = store.createTask({
    projectId: "project-a",
    title: "TASK-001.md",
    description: "",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-001.md",
    taskHash: "abc123",
    status: "todo",
    role: "implementation",
  });
  assert.equal(task.contentSource, "file");
  assert.equal(task.taskPath, ".project-memory/tasks/TASK-001.md");
  assert.equal(task.taskHash, "abc123");
  assert.equal(task.description, "");

  const reloaded = new WorkflowStore({ root }).init();
  const got = reloaded.getTask(task.id);
  assert.equal(got.contentSource, "file");
  assert.equal(got.taskPath, ".project-memory/tasks/TASK-001.md");
  assert.equal(got.taskHash, "abc123");
});

test("contentSource가 없는 기존 Task는 legacy inline으로 취급된다", () => {
  const root = makeRoot();
  const store = new WorkflowStore({ root }).init();
  const task = store.createTask({
    projectId: "project-a",
    title: "수동 작업",
    description: "본문 내용",
  });
  assert.equal(task.contentSource, "inline");
  assert.equal(task.taskPath, null);
  assert.equal(task.taskHash, null);
  assert.equal(task.description, "본문 내용");
});

test("listTasks 기본 목록에서 missing_file/superseded를 숨기고 includeAll로 전체를 볼 수 있다", () => {
  const root = makeRoot();
  const store = new WorkflowStore({ root }).init();
  const okTask = store.createTask({ projectId: "p1", title: "정상", syncState: "ok" });
  const missing = store.createTask({ projectId: "p1", title: "파일 없음", syncState: "missing_file" });
  const superseded = store.createTask({ projectId: "p1", title: "밀림", syncState: "superseded" });
  assert.equal(okTask.syncState, "ok");
  assert.equal(missing.syncState, "missing_file");
  assert.equal(superseded.syncState, "superseded");

  const shown = store.listTasks("p1");
  assert.deepEqual(shown.map((t) => t.id), [okTask.id]);
  const withMissing = store.listTasks("p1", { includeMissing: true });
  assert.deepEqual(withMissing.map((t) => t.id).sort(), [missing.id, okTask.id, superseded.id].sort());
  const all = store.listTasks("p1", { includeAll: true });
  assert.deepEqual(all.map((t) => t.id).sort(), [missing.id, okTask.id, superseded.id].sort());
});

test("미래의 스키마 버전(forward-schema)도 readOnly 상태에서 기존 decisions와 tasks를 정상적으로 읽어 표시한다", () => {
  const root = makeRoot();
  const file = path.join(root, "workflow.json");
  const futureData = {
    schemaVersion: 999,
    decisions: [
      { id: "d-future-1", projectId: "p-future", title: "미래 결정", content: "내용", status: "confirmed", createdAt: 100, updatedAt: 100 }
    ],
    tasks: [
      { id: "t-future-1", projectId: "p-future", title: "미래 작업", status: "todo", contentSource: "inline", createdAt: 100, updatedAt: 100 }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(futureData), "utf8");

  const store = new WorkflowStore({ root }).init();
  assert.equal(store.readOnly, true);
  const decisions = store.listDecisions("p-future");
  const tasks = store.listTasks("p-future");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].title, "미래 결정");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "미래 작업");
  assert.throws(() => store.createTask({ projectId: "p-future", title: "새 작업" }), /읽기 전용/);
});
