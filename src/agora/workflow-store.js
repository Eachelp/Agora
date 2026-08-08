const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");
const { writeJsonAtomic } = require("../chat/chat-store");
const { ROLE_IDS } = require("./project-store");

const WORKFLOW_SCHEMA_VERSION = 1;
const TASK_STATUSES = Object.freeze(["todo", "in_progress", "review", "done", "blocked"]);
const ROLE_DEFS = Object.freeze([
  Object.freeze({ id: "planning", label: "기획" }),
  Object.freeze({ id: "implementation", label: "구현" }),
  Object.freeze({ id: "review", label: "검토" }),
  Object.freeze({ id: "recorder", label: "기록" }),
]);

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

function emptyData() {
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, decisions: [], tasks: [] };
}

function cleanText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function cleanId(value, limit = 120) {
  const id = String(value || "").trim();
  return id ? id.slice(0, limit) : null;
}

function cleanIds(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => cleanId(entry)).filter(Boolean))].slice(0, limit);
}

function newId(prefix, now) {
  idSeq += 1;
  return `${prefix}${now.toString(36)}-${String(idSeq).padStart(3, "0")}-${Math.random().toString(36).slice(2, 7)}`;
}

function validProjectId(value) {
  const id = cleanId(value, 80);
  return id && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}

function validAgentId(value) {
  const id = cleanId(value, 32);
  return id && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}

function normalizeDecision(input = {}, now = Date.now()) {
  const projectId = validProjectId(input.projectId);
  const content = cleanText(input.content, 20000);
  if (!projectId || !content) return null;
  return {
    id: cleanId(input.id, 160) || newId("d", now),
    projectId,
    title: cleanText(input.title, 120),
    content,
    chatId: cleanId(input.chatId, 160),
    messageIds: cleanIds(input.messageIds),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

function normalizeTask(input = {}, now = Date.now()) {
  const projectId = validProjectId(input.projectId);
  const title = cleanText(input.title, 160);
  if (!projectId || !title) return null;
  const role = ROLE_IDS.includes(input.role) ? input.role : "implementation";
  const status = TASK_STATUSES.includes(input.status) ? input.status : "todo";
  return {
    id: cleanId(input.id, 160) || newId("t", now),
    projectId,
    title,
    description: cleanText(input.description, 20000),
    status,
    role,
    agentId: validAgentId(input.agentId),
    decisionId: cleanId(input.decisionId, 160),
    chatId: cleanId(input.chatId, 160),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
  };
}

class WorkflowStore {
  constructor(options = {}) {
    this.root = options.root || defaultRoot(options.env);
    this.now = options.now || (() => Date.now());
    this.filePath = path.join(this.root, "workflow.json");
    this.data = emptyData();
    this.readOnly = false;
    this.initialized = false;
  }

  init() {
    if (this.initialized) return this;
    fs.mkdirSync(this.root, { recursive: true });
    const exists = fs.existsSync(this.filePath);
    const loaded = readJsonSafe(this.filePath);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      if (Number(loaded.schemaVersion) > WORKFLOW_SCHEMA_VERSION) {
        this.readOnly = true;
      }
      this.data = {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        decisions: Array.isArray(loaded.decisions)
          ? loaded.decisions.map((entry) => normalizeDecision(entry, this.now())).filter(Boolean)
          : [],
        tasks: Array.isArray(loaded.tasks)
          ? loaded.tasks.map((entry) => normalizeTask(entry, this.now())).filter(Boolean)
          : [],
      };
    } else if (exists) {
      // ponytail: 손상된 workflow 파일은 덮어쓰지 않고 읽기 전용으로 열어 데이터 손실을 막습니다.
      this.readOnly = true;
    } else {
      this.persist();
    }
    this.initialized = true;
    return this;
  }

  persist() {
    if (this.readOnly) return;
    writeJsonAtomic(this.filePath, this.data);
  }

  listDecisions(projectId) {
    return this.data.decisions
      .filter((entry) => !projectId || entry.projectId === projectId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getDecision(id) {
    return this.data.decisions.find((entry) => entry.id === id) || null;
  }

  createDecision(input = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const decision = normalizeDecision(input, this.now());
    if (!decision) throw new Error("결정 내용과 프로젝트가 필요합니다.");
    this.data.decisions.push(decision);
    this.persist();
    return decision;
  }

  updateDecision(id, patch = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const current = this.getDecision(id);
    if (!current) return null;
    const next = normalizeDecision({ ...current, ...patch, id, projectId: current.projectId }, this.now());
    if (!next) throw new Error("결정 내용을 확인해 주세요.");
    next.createdAt = current.createdAt;
    this.data.decisions = this.data.decisions.map((entry) => (entry.id === id ? next : entry));
    this.persist();
    return next;
  }

  deleteDecision(id) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    if (this.data.tasks.some((task) => task.decisionId === id)) return false;
    const before = this.data.decisions.length;
    this.data.decisions = this.data.decisions.filter((entry) => entry.id !== id);
    if (before === this.data.decisions.length) return false;
    this.persist();
    return true;
  }

  listTasks(projectId) {
    return this.data.tasks
      .filter((entry) => !projectId || entry.projectId === projectId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  getTask(id) {
    return this.data.tasks.find((entry) => entry.id === id) || null;
  }

  createTask(input = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const task = normalizeTask(input, this.now());
    if (!task) throw new Error("작업 제목과 프로젝트가 필요합니다.");
    this.data.tasks.push(task);
    this.persist();
    return task;
  }

  updateTask(id, patch = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const current = this.getTask(id);
    if (!current) return null;
    const next = normalizeTask({ ...current, ...patch, id, projectId: current.projectId }, this.now());
    if (!next) throw new Error("작업 내용을 확인해 주세요.");
    next.createdAt = current.createdAt;
    this.data.tasks = this.data.tasks.map((entry) => (entry.id === id ? next : entry));
    this.persist();
    return next;
  }

  deleteTask(id) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((entry) => entry.id !== id);
    if (before === this.data.tasks.length) return false;
    this.persist();
    return true;
  }

  moveProjectItems(projectId, targetProjectId) {
    if (this.readOnly || projectId === targetProjectId) return;
    let changed = false;
    for (const entry of [...this.data.decisions, ...this.data.tasks]) {
      if (entry.projectId !== projectId) continue;
      entry.projectId = targetProjectId;
      entry.updatedAt = this.now();
      changed = true;
    }
    if (changed) this.persist();
  }

  forProject(projectId) {
    return {
      decisions: this.listDecisions(projectId),
      tasks: this.listTasks(projectId),
      roles: ROLE_DEFS,
      statuses: TASK_STATUSES,
      readOnly: this.readOnly,
    };
  }
}

module.exports = {
  WorkflowStore,
  WORKFLOW_SCHEMA_VERSION,
  TASK_STATUSES,
  ROLE_DEFS,
  defaultRoot,
};
