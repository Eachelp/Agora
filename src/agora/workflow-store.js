const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");
const { writeJsonAtomic } = require("../chat/chat-store");
const { ROLE_IDS } = require("./project-store");

const WORKFLOW_SCHEMA_VERSION = 2;
const TASK_STATUSES = Object.freeze([
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
  "proposed",
  "rejected",
  "archived",
]);
const DECISION_STATUSES = Object.freeze(["proposed", "confirmed", "superseded", "rejected", "archived"]);
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
    status: DECISION_STATUSES.includes(input.status) ? input.status : "confirmed",
    origin: input.origin === "recorder" ? "recorder" : "manual",
    recorderAgentId: validAgentId(input.recorderAgentId),
    runId: cleanId(input.runId, 160),
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
    origin: input.origin === "recorder" ? "recorder" : "manual",
    recorderAgentId: validAgentId(input.recorderAgentId),
    runId: cleanId(input.runId, 160),
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

  // persist()가 실패해도 메모리 상태를 되돌려, 다음 재시도가 "이미 있는
  // 내용"으로 오판해 저장을 건너뛰지 않게 합니다. mutate가 데이터를 바꾸고,
  // 실패하면 restore로 이전 스냅숏을 되돌린 뒤 오류를 다시 던집니다.
  mutateAndPersist(mutate) {
    const snapshot = { decisions: [...this.data.decisions], tasks: [...this.data.tasks] };
    const result = mutate();
    try {
      this.persist();
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
    return result;
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
    if (decision.chatId) {
      const dup = this.data.decisions.find(
        (entry) =>
          entry.projectId === decision.projectId &&
          entry.chatId === decision.chatId &&
          entry.title === decision.title &&
          entry.content === decision.content
      );
      if (dup) return dup;
    }
    return this.mutateAndPersist(() => {
      this.data.decisions.push(decision);
      return decision;
    });
  }

  updateDecision(id, patch = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const current = this.getDecision(id);
    if (!current) return null;
    const now = this.now();
    const next = normalizeDecision(
      { ...current, ...patch, id, projectId: current.projectId, updatedAt: now },
      now
    );
    if (!next) throw new Error("결정 내용을 확인해 주세요.");
    next.createdAt = current.createdAt;
    return this.mutateAndPersist(() => {
      this.data.decisions = this.data.decisions.map((entry) => (entry.id === id ? next : entry));
      return next;
    });
  }

  deleteDecision(id) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    if (this.data.tasks.some((task) => task.decisionId === id)) return false;
    const before = this.data.decisions.length;
    if (!this.data.decisions.some((entry) => entry.id === id)) return false;
    return this.mutateAndPersist(() => {
      this.data.decisions = this.data.decisions.filter((entry) => entry.id !== id);
      return before !== this.data.decisions.length;
    });
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
    if (task.chatId) {
      const dup = this.data.tasks.find(
        (entry) =>
          entry.projectId === task.projectId &&
          entry.chatId === task.chatId &&
          entry.title === task.title &&
          entry.description === task.description
      );
      if (dup) return dup;
    }
    return this.mutateAndPersist(() => {
      this.data.tasks.push(task);
      return task;
    });
  }

  updateTask(id, patch = {}) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const current = this.getTask(id);
    if (!current) return null;
    const now = this.now();
    const next = normalizeTask(
      { ...current, ...patch, id, projectId: current.projectId, updatedAt: now },
      now
    );
    if (!next) throw new Error("작업 내용을 확인해 주세요.");
    next.createdAt = current.createdAt;
    return this.mutateAndPersist(() => {
      this.data.tasks = this.data.tasks.map((entry) => (entry.id === id ? next : entry));
      return next;
    });
  }

  deleteTask(id) {
    if (this.readOnly) throw new Error("작업 기록 저장소가 읽기 전용 상태입니다.");
    const before = this.data.tasks.length;
    if (!this.data.tasks.some((entry) => entry.id === id)) return false;
    return this.mutateAndPersist(() => {
      this.data.tasks = this.data.tasks.filter((entry) => entry.id !== id);
      return before !== this.data.tasks.length;
    });
  }

  moveProjectItems(projectId, targetProjectId) {
    if (this.readOnly || projectId === targetProjectId) return;
    if (!this.data.decisions.some((entry) => entry.projectId === projectId) &&
        !this.data.tasks.some((entry) => entry.projectId === projectId)) {
      return;
    }
    this.mutateAndPersist(() => {
      let changed = false;
      for (const entry of [...this.data.decisions, ...this.data.tasks]) {
        if (entry.projectId !== projectId) continue;
        entry.projectId = targetProjectId;
        entry.updatedAt = this.now();
        changed = true;
      }
      return changed;
    });
  }


  // 대화가 다른 프로젝트로 이동할 때, 해당 대화에 연결된 결정/작업의 chatId와 프로젝트 연결을 정리합니다.
  detachChatItems(chatId) {
    if (this.readOnly || !chatId) return;
    const items = [...this.data.decisions, ...this.data.tasks].filter((entry) => entry.chatId === chatId);
    if (items.length === 0) return;
    this.mutateAndPersist(() => {
      let changed = false;
      for (const entry of items) {
        entry.chatId = null;
        entry.updatedAt = this.now();
        changed = true;
      }
      return changed;
    });
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
  DECISION_STATUSES,
  ROLE_DEFS,
  defaultRoot,
};
