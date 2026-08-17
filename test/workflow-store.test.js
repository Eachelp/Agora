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

test("reconcileProjectTasks는 디스크 상의 TASK 파일과 workflow 상태를 동기화하고 누락 및 디스크 변경을 반영한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const tasksDir = path.join(wsRoot, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  const file1 = path.join(tasksDir, "TASK-001.md");
  fs.writeFileSync(file1, "Task 1 content", "utf8");

  const store = new WorkflowStore({ root }).init();

  const res1 = store.reconcileProjectTasks("project-a", wsRoot);
  assert.equal(res1.ok, true);
  assert.equal(res1.tasks.length, 1);
  assert.equal(res1.tasks[0].title, "TASK-001.md");
  assert.equal(res1.tasks[0].origin, "planner");
  assert.equal(res1.tasks[0].syncState, "ok");

  fs.rmSync(file1);
  const res2 = store.reconcileProjectTasks("project-a", wsRoot);
  assert.equal(res2.tasks[0].syncState, "missing_file");

  fs.writeFileSync(file1, "Modified Task 1 content", "utf8");
  const res3 = store.reconcileProjectTasks("project-a", wsRoot);
  // disk 내용이 바뀌면 과거 entry를 덮어쓰지 않고 새 canonical을 만들고,
  // 과거 entry는 superseded로 내린다. 배열 순서에 의존하지 않고 검증한다.
  const modifiedHash = require("node:crypto").createHash("sha256").update("Modified Task 1 content").digest("hex");
  const visible3 = store.listTasks("project-a");
  assert.equal(visible3.length, 1, "기본 목록에는 canonical 하나만 보여야 한다");
  assert.equal(visible3[0].syncState, "ok");
  assert.equal(visible3[0].taskHash, modifiedHash);
  const stale3 = res3.tasks.filter((t) => t.taskHash !== modifiedHash);
  for (const entry of stale3) {
    assert.equal(entry.syncState, "superseded", "과거 hash entry는 superseded여야 한다");
  }
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

test("reconcileProjectTasks는 같은 taskPath의 hash 일치 항목을 canonical로 선택하고 나머지를 superseded 처리한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const tasksDir = path.join(wsRoot, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const content = "TASK-777 본문";
  fs.writeFileSync(path.join(tasksDir, "TASK-777.md"), content, "utf8");

  const store = new WorkflowStore({ root }).init();
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  // 같은 taskPath로 구버전(다른 hash)과 최신(hash 일치) 항목 두 개를 만든다.
  const stale = store.createTask({
    projectId: "p1",
    title: "TASK-777.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-777.md",
    taskHash: "oldhash",
    updatedAt: 1,
  });
  const canonical = store.createTask({
    projectId: "p1",
    title: "TASK-777.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-777.md",
    taskHash: hash,
    updatedAt: 2,
  });

  const res = store.reconcileProjectTasks("p1", wsRoot);
  assert.equal(res.ok, true);
  const byId = new Map(res.tasks.map((t) => [t.id, t]));
  assert.equal(byId.get(canonical.id).syncState, "ok");
  assert.equal(byId.get(stale.id).syncState, "superseded");
});

test("migrateOrphanedTasks는 프로젝트 workspace의 파일 hash를 기준으로 중복 항목을 정리한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const tasksDir = path.join(wsRoot, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const content = "TASK-999 본문";
  fs.writeFileSync(path.join(tasksDir, "TASK-999.md"), content, "utf8");

  const { ProjectStore } = require("../src/agora/project-store");
  const projectStore = new ProjectStore({ root }).init();
  const project = projectStore.createProject({ name: "마이그레이션 프로젝트", workspace: wsRoot });

  const store = new WorkflowStore({ root }).init();
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const a = store.createTask({
    projectId: project.id,
    title: "TASK-999.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-999.md",
    taskHash: hash,
  });
  const b = store.createTask({
    projectId: project.id,
    title: "TASK-999.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-999.md",
    taskHash: "stalehash",
  });
  assert.equal(a.id === b.id, false);

  const res = store.migrateOrphanedTasks();
  assert.equal(res.ok, true);
  const after = store.listTasks(project.id, { includeAll: true });
  const canonical = after.find((t) => t.taskHash === hash);
  const orphan = after.find((t) => t.taskHash === "stalehash");
  assert.ok(canonical, "hash 일치 항목이 남아 있어야 한다");
  assert.equal(canonical.syncState, "ok");
  assert.ok(orphan, "중복 항목은 삭제되지 않고 남는다");
  assert.equal(orphan.syncState, "superseded");
  assert.equal(store.listTasks(project.id).length, 1);
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

test("reconcileProjectTasks는 disk hash와 일치하는 기존 항목이 없으면 새 canonical을 만들고 기존 항목은 superseded 처리한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const tasksDir = path.join(wsRoot, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const content = "새로운 디스크 내용";
  fs.writeFileSync(path.join(tasksDir, "TASK-888.md"), content, "utf8");

  const store = new WorkflowStore({ root }).init();
  const old1 = store.createTask({
    projectId: "p1",
    title: "TASK-888.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-888.md",
    taskHash: "mismatch1",
    updatedAt: 10,
  });
  const old2 = store.createTask({
    projectId: "p1",
    title: "TASK-888.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-888.md",
    taskHash: "mismatch2",
    updatedAt: 20,
  });

  const res = store.reconcileProjectTasks("p1", wsRoot);
  assert.equal(res.ok, true);
 const tasks = res.tasks;
  // disk hash와 일치하는 기존 항목이 없으므로 새 canonical 항목을 생성하고,
  // 기존 항목(old1/old2)은 provenance 오염을 막기 위해 superseded 처리된다.
  const newCanonical = tasks.find((t) => t.taskHash && t.taskHash !== "mismatch1" && t.taskHash !== "mismatch2");
  const oldOne = tasks.find((t) => t.id === old1.id);
  const oldTwo = tasks.find((t) => t.id === old2.id);
  assert.ok(newCanonical, "새 canonical 항목이 있어야 한다");
  assert.equal(newCanonical.syncState, "ok");
  assert.ok(!newCanonical.lastRunId && !newCanonical.activeRunId, "새 canonical은 실행 상태가 없어야 한다");
  assert.equal(oldOne.syncState, "superseded");
  assert.equal(oldTwo.syncState, "superseded");
  // 기본 목록에는 새 canonical만 노출된다
  const visible = store.listTasks("p1");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].taskHash, newCanonical.taskHash);
});

test("reconcileProjectTasks는 기존 revision이 하나뿐이어도 disk hash가 다르면 superseded 처리한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const tasksDir = path.join(wsRoot, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "TASK-889.md"), "외부에서 수정된 내용", "utf8");

  const store = new WorkflowStore({ root }).init();
  // 기존 revision이 정확히 1개뿐이고, 활성 Run 상태를 들고 있는 상황.
  const stale = store.createTask({
    projectId: "p1",
    title: "TASK-889.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-889.md",
    taskHash: "stale-hash-does-not-match",
    status: "in_progress",
  });
  store.updateTask(stale.id, { activeRunId: "RUN-OLD-001", lastRunId: "RUN-OLD-001" });

  const res = store.reconcileProjectTasks("p1", wsRoot);
  assert.equal(res.ok, true);

  const staleAfter = res.tasks.find((t) => t.id === stale.id);
  assert.equal(staleAfter.syncState, "superseded", "단일 revision도 hash 불일치면 superseded여야 한다");

  const newCanonical = res.tasks.find((t) => t.id !== stale.id && t.taskPath);
  assert.ok(newCanonical, "새 canonical 항목이 생성되어야 한다");
  assert.equal(newCanonical.syncState, "ok");
  assert.ok(!newCanonical.activeRunId, "새 canonical에 과거 activeRunId가 붙으면 안 된다");

  // 기본 목록에는 새 canonical만 보이고, 과거 활성 Run 상태는 노출되지 않는다.
  const visible = store.listTasks("p1");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, newCanonical.id);
});

test("migrateOrphanedTasks는 단일(unique) file-backed task도 디스크에 파일이 없으면 missing_file로 정리한다", () => {
  const root = makeRoot();
  const wsRoot = makeRoot();
  const { ProjectStore } = require("../src/agora/project-store");
  const projectStore = new ProjectStore({ root }).init();
  const project = projectStore.createProject({ name: "단일 작업 프로젝트", workspace: wsRoot });

  const store = new WorkflowStore({ root }).init();
  const singleTask = store.createTask({
    projectId: project.id,
    title: "TASK-333.md",
    contentSource: "file",
    taskPath: ".project-memory/tasks/TASK-333.md",
    taskHash: "nonexistent",
    syncState: "ok",
  });

  const res = store.migrateOrphanedTasks();
  assert.equal(res.ok, true);
  const after = store.listTasks(project.id, { includeAll: true });
  assert.equal(after[0].id, singleTask.id);
  assert.equal(after[0].syncState, "missing_file");
  assert.equal(store.listTasks(project.id).length, 0);
});
