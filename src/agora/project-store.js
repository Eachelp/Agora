const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");
const { writeJsonAtomic } = require("../chat/chat-store");

const PROJECT_SCHEMA_VERSION = 1;
const UNCATEGORIZED_PROJECT_ID = "uncategorized";
const DEFAULT_PROJECT_NAME = "분류되지 않음";
const PERMISSION_MODES = new Set(["chat", "workspace-read", "workspace-write"]);

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
    const existing = this.getProject(UNCATEGORIZED_PROJECT_ID);
    if (existing) return existing;
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
  const projectIds = new Set(projectStore.listProjects().map((project) => project.id));
  let migrated = 0;
  for (const entry of chatStore.listSessions()) {
    const meta = chatStore.readMeta(entry.id);
    if (!meta || meta.readOnly) continue;
    const projectId = projectIds.has(meta.projectId)
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
  defaultRoot,
  sessionDefaultsFromProject,
  migrateSessionsToProjects,
};
