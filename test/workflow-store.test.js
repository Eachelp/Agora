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
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-workflow-store-"));
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
