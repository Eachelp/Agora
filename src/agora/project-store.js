const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");
const { writeJsonAtomic } = require("../chat/chat-store");

const PROJECT_SCHEMA_VERSION = 1;
const UNCATEGORIZED_PROJECT_ID = "uncategorized";
const DEFAULT_PROJECT_NAME = "분류되지 않음";
const PERMISSION_MODES = new Set(["chat", "workspace-read", "workspace-write"]);
const ROLE_IDS = Object.freeze(["planning", "implementation", "review", "recorder"]);

let idSeq = 0;

function defaultRoot(env = process.env) {
  return defaultAgoraHome(env);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// "프로젝트가 없음"과 "프로젝트 파일이 있지만 손상되어 못 읽음"을 구분합니다.
// 후자를 앞의 경우처럼 취급하면, 일시적으로 손상된 프로젝트 파일 하나 때문에
// 그 프로젝트의 대화가 전부 uncategorized로 영구 이동해 버립니다.
function readJsonStatus(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { exists: false, data: null };
  }
  try {
    return { exists: true, data: JSON.parse(raw) };
  } catch {
    return { exists: true, data: null, corrupted: true };
  }
}

function newProjectId(now) {
  idSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `p${now.toString(36)}${String(idSeq % 1296).padStart(2, "0")}-${rand}`;
}

function sanitizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function sanitizeWorkspace(value) {
  const workspace = String(value || "").trim();
  return workspace || null;
}

function sanitizeContext(value) {
  return String(value || "").trim().slice(0, 12000);
}

function sanitizeAgents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const agents = {};
  for (const [id, config] of Object.entries(value)) {
    if (!id || !config || typeof config !== "object" || Array.isArray(config)) continue;
    agents[id] = { ...config };
  }
  return agents;
}

function sanitizeRoleValue(value) {
  if (typeof value === "string") {
    const agentId = value.trim();
    return /^[a-z0-9_-]{1,32}$/i.test(agentId) ? agentId : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agentId = String(value.agentId || "").trim();
  if (!/^[a-z0-9_-]{1,32}$/i.test(agentId)) return null;
  const model = String(value.model || "").trim().slice(0, 160);
  const effort = String(value.effort || "").trim().slice(0, 32);
  return {
    agentId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function sanitizeRoles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const roles = {};
  for (const roleId of ROLE_IDS) {
    const role = sanitizeRoleValue(value[roleId]);
    if (role) roles[roleId] = role;
  }
  return roles;
}

function roleConfigFor(project, roleId) {
  const role = sanitizeRoleValue(project?.defaultRoles?.[roleId]);
  if (!role) return { agentId: null, model: "", effort: "" };
  if (typeof role === "string") return { agentId: role, model: "", effort: "" };
  return { agentId: role.agentId, model: role.model || "", effort: role.effort || "" };
}

function defaultPermissionMode(value, workspace) {
  return workspace && PERMISSION_MODES.has(value) ? value : "chat";
}

function projectDefaults(input = {}) {
  const workspace = sanitizeWorkspace(input.workspace);
  return {
    name: sanitizeName(input.name) || "새 프로젝트",
    workspace,
    context: sanitizeContext(input.context),
    defaultPermissionMode: defaultPermissionMode(input.defaultPermissionMode, workspace),
    defaultAgents: sanitizeAgents(input.defaultAgents),
    defaultRoles: sanitizeRoles(input.defaultRoles),
  };
}

function sessionDefaultsFromProject(project) {
  const workspace = sanitizeWorkspace(project?.workspace);
  return {
    projectId: project?.id || UNCATEGORIZED_PROJECT_ID,
    workspace,
    permissionMode: defaultPermissionMode(project?.defaultPermissionMode, workspace),
    agents: sanitizeAgents(project?.defaultAgents),
  };
}

class ProjectStore {
  constructor(options = {}) {
    this.root = options.root || defaultRoot(options.env);
    this.now = options.now || (() => Date.now());
    this.initialized = false;
  }

  projectsRoot() {
    return path.join(this.root, "projects");
  }

  projectPath(id) {
    return path.join(this.projectsRoot(), `${id}.json`);
  }

  init() {
    if (this.initialized) return this;
    fs.mkdirSync(this.projectsRoot(), { recursive: true });
    this.ensureUncategorizedProject();
    this.initialized = true;
    return this;
  }

  ensureUncategorizedProject() {
    const status = readJsonStatus(this.projectPath(UNCATEGORIZED_PROJECT_ID));
    if (status.exists) {
      // 파일이 있으면(정상이든 손상됐든) 절대 덮어쓰지 않습니다. 손상된 경우
      // 기본 프로젝트가 목록에서 조용히 빠지는 게, 사용자 데이터가 담긴 파일을
      // 자동으로 새 기본값으로 지우는 것보다 안전합니다.
      this.corruptedUncategorized = Boolean(status.corrupted);
      return status.data && status.data.id === UNCATEGORIZED_PROJECT_ID ? status.data : null;
    }
    const now = this.now();
    const project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: UNCATEGORIZED_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      createdAt: now,
      updatedAt: now,
      workspace: null,
      context: "",
      defaultPermissionMode: "chat",
      defaultAgents: {},
      defaultRoles: {},
    };
    writeJsonAtomic(this.projectPath(project.id), project);
    return project;
  }

  getProject(id) {
    if (!id || !/^[a-z0-9-]+$/i.test(id)) return null;
    const project = readJsonSafe(this.projectPath(id));
    if (!project || project.id !== id) return null;
    if (Number(project.schemaVersion) > PROJECT_SCHEMA_VERSION) {
      return { ...project, readOnly: true };
    }
    return project;
  }

  hasProject(id) {
    return Boolean(this.getProject(id));
  }

  // hasProject()와 달리 파일이 손상되어 읽지 못하는 경우도 "존재함"으로
  // 봅니다. migrateSessionsToProjects가 손상된 프로젝트의 대화를
  // uncategorized로 잘못 옮기지 않도록 구분하는 용도입니다.
  hasProjectFile(id) {
    if (!id || !/^[a-z0-9-]+$/i.test(id)) return false;
    return fs.existsSync(this.projectPath(id));
  }

  listProjects() {
    let names = [];
    try {
      names = fs.readdirSync(this.projectsRoot());
    } catch {
      return [];
    }
    const projects = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.getProject(name.slice(0, -5)))
      .filter(Boolean);
    return projects.sort((a, b) => {
      if (a.id === UNCATEGORIZED_PROJECT_ID) return 1;
      if (b.id === UNCATEGORIZED_PROJECT_ID) return -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  createProject(input = {}) {
    const now = this.now();
    const defaults = projectDefaults(input);
    const project = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: newProjectId(now),
      createdAt: now,
      updatedAt: now,
      ...defaults,
    };
    writeJsonAtomic(this.projectPath(project.id), project);
    return project;
  }

  updateProject(id, patch = {}) {
    const current = this.getProject(id);
    if (!current || current.readOnly) return current;
    const requestedName = Object.hasOwn(patch, "name") ? sanitizeName(patch.name) : current.name;
    const defaults = projectDefaults({
      name: requestedName || current.name,
      workspace: Object.hasOwn(patch, "workspace") ? patch.workspace : current.workspace,
      context: Object.hasOwn(patch, "context") ? patch.context : current.context,
      defaultPermissionMode: Object.hasOwn(patch, "defaultPermissionMode")
        ? patch.defaultPermissionMode
        : current.defaultPermissionMode,
      defaultAgents: Object.hasOwn(patch, "defaultAgents") ? patch.defaultAgents : current.defaultAgents,
      defaultRoles: Object.hasOwn(patch, "defaultRoles") ? patch.defaultRoles : current.defaultRoles,
    });
    const next = {
      ...current,
      ...defaults,
      id,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      updatedAt: this.now(),
    };
    writeJsonAtomic(this.projectPath(id), next);
    return next;
  }

  renameProject(id, name) {
    return this.updateProject(id, { name });
  }

  deleteProject(id) {
    if (!id || id === UNCATEGORIZED_PROJECT_ID) return false;
    const current = this.getProject(id);
    if (!current || current.readOnly) return false;
    fs.rmSync(this.projectPath(id), { force: true });
    return true;
  }
}

function migrateSessionsToProjects(chatStore, projectStore) {
  if (!chatStore || !projectStore) return 0;
  projectStore.ensureUncategorizedProject();
  let migrated = 0;
  for (const entry of chatStore.listSessions()) {
    const meta = chatStore.readMeta(entry.id);
    if (!meta || meta.readOnly) continue;
    // 파일이 손상되어 목록에 못 나오는 프로젝트는 "삭제됨"이 아니라
    // "일시적으로 읽지 못함"으로 취급해 대화를 옮기지 않습니다.
    const projectId = meta.projectId && projectStore.hasProjectFile(meta.projectId)
      ? meta.projectId
      : UNCATEGORIZED_PROJECT_ID;
    if (meta.projectId === projectId) continue;
    chatStore.updateMeta(meta.id, { projectId });
    migrated += 1;
  }
  return migrated;
}

module.exports = {
  ProjectStore,
  PROJECT_SCHEMA_VERSION,
  UNCATEGORIZED_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  ROLE_IDS,
  defaultRoot,
  sessionDefaultsFromProject,
  migrateSessionsToProjects,
  defaultPermissionMode,
  roleConfigFor,
};
