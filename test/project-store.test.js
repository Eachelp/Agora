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
      plan_review: { agentId: "agy", model: "gemini-3-flash", effort: "medium" },
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
  assert.deepEqual(roleConfigFor(reloaded, "plan_review"), {
    agentId: "agy",
    model: "gemini-3-flash",
    effort: "medium",
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

test("migrateSessionsToProjects는 고유 세션 workspace를 프로젝트로 승격하고 충돌 시 임의 선택하지 않는다", () => {
  const root = makeRoot();
  const chats = new ChatStore({ root }).init();
  const projects = new ProjectStore({ root }).init();

  // 케이스 1: 프로젝트 workspace가 null이고 세션들의 workspace가 동일하게 1개 존재 -> 프로젝트로 승격
  const p1 = projects.createProject({ name: "승격 프로젝트" });
  const s1 = chats.createSession({ title: "대화 1", projectId: p1.id, workspace: "D:/Work/Project1" });
  const s2 = chats.createSession({ title: "대화 2", projectId: p1.id, workspace: "D:/Work/Project1" });

  // 케이스 2: 프로젝트 workspace가 null이고 세션들의 workspace가 서로 다름 (충돌) -> 승격하지 않고 유지
  const p2 = projects.createProject({ name: "충돌 프로젝트" });
  chats.createSession({ title: "대화 A", projectId: p2.id, workspace: "D:/Work/A" });
  chats.createSession({ title: "대화 B", projectId: p2.id, workspace: "D:/Work/B" });

  // 케이스 3: 프로젝트 workspace가 이미 설정되어 있음 -> 모든 세션에 프로젝트 workspace 반영
  const p3 = projects.createProject({ name: "기존 폴더 프로젝트", workspace: "D:/Work/Canonical" });
  const s3 = chats.createSession({ title: "대화 X", projectId: p3.id, workspace: "D:/Work/Old" });

  migrateSessionsToProjects(chats, projects);

  // 검증 1: 승격 확인
  const reloadedP1 = projects.getProject(p1.id);
  assert.equal(reloadedP1.workspace, "D:/Work/Project1");
  assert.equal(chats.readMeta(s1.id).workspace, "D:/Work/Project1");
  assert.equal(chats.readMeta(s2.id).workspace, "D:/Work/Project1");

  // 검증 2: 충돌 시 임의 선택 금지 (null 유지)
  const reloadedP2 = projects.getProject(p2.id);
  assert.equal(reloadedP2.workspace, null);

  // 검증 3: canonical 프로젝트 workspace 일괄 적용
  assert.equal(chats.readMeta(s3.id).workspace, "D:/Work/Canonical");
});
