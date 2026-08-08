const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore } = require("../src/chat/chat-store");
const {
  ProjectStore,
  UNCATEGORIZED_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  sessionDefaultsFromProject,
  migrateSessionsToProjects,
  roleConfigFor,
} = require("../src/agora/project-store");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-project-store-"));
}

test("프로젝트 저장소는 기본 분류 프로젝트와 프로젝트 메타데이터를 보존한다", () => {
  let clock = 1000;
  const root = makeRoot();
  const projects = new ProjectStore({ root, now: () => (clock += 1) }).init();

  const uncategorized = projects.getProject(UNCATEGORIZED_PROJECT_ID);
  assert.equal(uncategorized.name, DEFAULT_PROJECT_NAME);

  const project = projects.createProject({
    name: "Agora 개발",
    workspace: "D:/Projects/Agora",
    context: "기존 채팅 코어를 유지한다.",
    defaultPermissionMode: "workspace-read",
    defaultAgents: { codex: { model: "gpt-5", effort: "high" } },
  });
  const reloaded = new ProjectStore({ root }).init().getProject(project.id);

  assert.equal(reloaded.name, "Agora 개발");
  assert.equal(reloaded.workspace, "D:/Projects/Agora");
  assert.equal(reloaded.context, "기존 채팅 코어를 유지한다.");
  assert.equal(reloaded.defaultPermissionMode, "workspace-read");
  assert.equal(reloaded.defaultAgents.codex.model, "gpt-5");

  assert.equal(projects.updateProject(project.id, { name: "   " }).name, "Agora 개발");
});

test("역할별 담당자·모델·추론 설정을 저장하고 기존 문자열 역할도 읽는다", () => {
  const root = makeRoot();
  const projects = new ProjectStore({ root }).init();
  const project = projects.createProject({
    name: "전문 실행",
    defaultRoles: {
      implementation: { agentId: "codex", model: "gpt-5", effort: "high" },
      review: "claude",
      recorder: { agentId: "claude", model: "default", effort: "default" },
    },
  });

  const reloaded = new ProjectStore({ root }).init().getProject(project.id);
  assert.deepEqual(roleConfigFor(reloaded, "implementation"), {
    agentId: "codex",
    model: "gpt-5",
    effort: "high",
  });
  assert.deepEqual(roleConfigFor(reloaded, "review"), {
    agentId: "claude",
    model: "",
    effort: "",
  });
  assert.deepEqual(roleConfigFor(reloaded, "recorder"), {
    agentId: "claude",
    model: "default",
    effort: "default",
  });
});

test("기존 세션과 없어진 프로젝트의 세션은 기본 프로젝트로 안전하게 이전된다", () => {
  const root = makeRoot();
  const chats = new ChatStore({ root }).init();
  const unassigned = chats.createSession({ title: "기존 대화" });
  const missing = chats.createSession({ title: "사라진 프로젝트", projectId: "missing-project" });
  const projects = new ProjectStore({ root }).init();

  assert.equal(migrateSessionsToProjects(chats, projects), 2);
  assert.equal(chats.readMeta(unassigned.id).projectId, UNCATEGORIZED_PROJECT_ID);
  assert.equal(chats.readMeta(missing.id).projectId, UNCATEGORIZED_PROJECT_ID);
  assert.equal(
    chats.listSessions().every((session) => session.projectId === UNCATEGORIZED_PROJECT_ID),
    true
  );
});

test("새 대화에는 프로젝트 기본 설정만 복사하고 기존 대화 설정은 바꾸지 않는다", () => {
  const root = makeRoot();
  const projects = new ProjectStore({ root }).init();
  const project = projects.createProject({
    name: "문서 작업",
    workspace: "D:/Projects/Docs",
    defaultPermissionMode: "workspace-write",
    defaultAgents: { claude: { enabled: false, model: "sonnet" } },
  });
  const chats = new ChatStore({ root }).init();
  const existing = chats.createSession({
    title: "기존 대화",
    projectId: project.id,
    permissionMode: "chat",
    agents: { claude: { enabled: true, model: "opus" } },
  });
  const created = chats.createSession(sessionDefaultsFromProject(project));

  assert.equal(chats.readMeta(existing.id).permissionMode, "chat");
  assert.equal(chats.readMeta(existing.id).agents.claude.model, "opus");
  assert.equal(created.projectId, project.id);
  assert.equal(created.workspace, "D:/Projects/Docs");
  assert.equal(created.permissionMode, "workspace-write");
  assert.equal(created.agents.claude.enabled, false);
});
