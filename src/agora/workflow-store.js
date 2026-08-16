const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { defaultAgoraHome } = require("../app-paths");
const { writeJsonAtomic } = require("../chat/chat-store");
const { ROLE_IDS, ProjectStore } = require("./project-store");

const WORKFLOW_SCHEMA_VERSION = 4;
const SYNC_STATES = Object.freeze(["ok", "missing_file", "hash_mismatch", "duplicate_index", "superseded"]);
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
  const contentSource = input.contentSource === "file" ? "file" : "inline";
  const origin = ["manual", "planner", "recorder"].includes(input.origin) ? input.origin : (input.origin === "recorder" ? "recorder" : "manual");
  const syncState = (typeof SYNC_STATES !== "undefined" && SYNC_STATES.includes(input.syncState)) ? input.syncState : "ok";
  return {
    id: cleanId(input.id, 160) || newId("t", now),
    projectId,
    title,
    description: cleanText(input.description, 20000),
    contentSource,
    taskPath: contentSource === "file" ? cleanId(input.taskPath, 500) : null,
    taskHash: contentSource === "file" ? cleanId(input.taskHash, 96) : null,
    status,
    role,
    agentId: validAgentId(input.agentId),
    decisionId: cleanId(input.decisionId, 160),
    chatId: cleanId(input.chatId, 160),
    origin,
    recorderAgentId: validAgentId(input.recorderAgentId),
    runId: cleanId(input.runId, 160),
    activeRunId: cleanId(input.activeRunId, 160),
    lastRunId: cleanId(input.lastRunId, 160),
    syncState,
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
      } else {
        this.data = {
          schemaVersion: WORKFLOW_SCHEMA_VERSION,
          decisions: Array.isArray(loaded.decisions)
            ? loaded.decisions.map((entry) => normalizeDecision(entry, this.now())).filter(Boolean)
            : [],
          tasks: Array.isArray(loaded.tasks)
            ? loaded.tasks.map((entry) => normalizeTask(entry, this.now())).filter(Boolean)
            : [],
        };
        // 스키마 3 → 4: 프로젝트 workspace 기준으로 같은 taskPath의 중복 항목을
        // 해시로 canonical 하나만 남기고 나머지는 superseded로 표시합니다.
        // schemaVersion bump는 마이그레이션 게이트로만 사용하고 실제 로직은
        // migrateOrphanedTasks가 담당합니다.
        if (Number(loaded.schemaVersion) < WORKFLOW_SCHEMA_VERSION) {
          this.migrateOrphanedTasks();
        }
      }
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

  listTasks(projectId, options = {}) {
    const includeMissing = Boolean(options.includeMissing);
    const includeAll = Boolean(options.includeAll);
    if (includeAll) {
      return this.data.tasks
        .filter((entry) => !projectId || entry.projectId === projectId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    return this.data.tasks
      .filter((entry) => {
        if (projectId && entry.projectId !== projectId) return false;
        if (includeMissing) return true;
        return entry.syncState !== "missing_file" && entry.syncState !== "superseded";
      })
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

  reconcileProjectTasks(projectId, workspace) {
    if (this.readOnly || !projectId || !workspace) return { ok: false };
    try {
      const resolvedRoot = fs.realpathSync(workspace);
      const memoryTasksDir = path.join(resolvedRoot, ".project-memory", "tasks");
      let taskFiles = [];
      if (fs.existsSync(memoryTasksDir)) {
        taskFiles = fs.readdirSync(memoryTasksDir).filter((name) => /^TASK-\d+\.md$/i.test(name));
      }
      const fileMap = new Map();
      for (const filename of taskFiles) {
        const absPath = path.join(memoryTasksDir, filename);
        const content = fs.readFileSync(absPath, "utf8");
        const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
        const relPath = path.join(".project-memory", "tasks", filename);
        fileMap.set(relPath, { filename, hash, content });
      }

      this.mutateAndPersist(() => {
        let changed = false;
        // 동일 taskPath 그룹: 현재 워크스페이스 파일 hash와 일치하는 항목을
        // canonical로 선택합니다. 일치하는 게 없으면 가장 최근 업데이트 항목을
        // canonical로 삼고, 나머지는 superseded로 표시해 기본 목록에서 숨깁니다.
        const pathGroups = new Map();
        for (const task of this.data.tasks) {
          if (task.projectId !== projectId || task.contentSource !== "file" || !task.taskPath) continue;
          const normPath = task.taskPath.replace(/[\\/]+/g, path.sep);
          if (!pathGroups.has(normPath)) pathGroups.set(normPath, []);
          pathGroups.get(normPath).push(task);
        }

        for (const [normPath, group] of pathGroups) {
          const onDisk = fileMap.get(normPath);
          let canonical = null;
          if (onDisk) {
            canonical =
              group.find((task) => task.taskHash && task.taskHash === onDisk.hash) ||
              [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
          }
          for (const task of group) {
            if (group.length > 1 && task !== canonical) {
              if (task.syncState !== "superseded") {
                task.syncState = "superseded";
                task.updatedAt = this.now();
                changed = true;
              }
              continue;
            }
            if (!onDisk) {
              if (task.syncState !== "missing_file") {
                task.syncState = "missing_file";
                task.updatedAt = this.now();
                changed = true;
              }
            } else {
              if (task.taskHash && task.taskHash !== onDisk.hash) {
                if (task.syncState !== "hash_mismatch") {
                  task.syncState = "hash_mismatch";
                  task.updatedAt = this.now();
                  changed = true;
                }
              } else if (task.syncState !== "ok") {
                task.syncState = "ok";
                task.updatedAt = this.now();
                changed = true;
              }
            }
          }
        }

        for (const [relPath, info] of fileMap.entries()) {
          const existing = this.data.tasks.find((t) => t.projectId === projectId && t.contentSource === "file" && t.taskPath && t.taskPath.replace(/[\\/]+/g, path.sep) === relPath);
          if (!existing) {
            const newTask = normalizeTask({
              projectId,
              title: info.filename,
              description: "",
              contentSource: "file",
              taskPath: relPath,
              taskHash: info.hash,
              status: "todo",
              role: "implementation",
              origin: "planner",
              syncState: "ok",
            }, this.now());
            if (newTask) {
              this.data.tasks.push(newTask);
              changed = true;
            }
          }
        }

        return changed;
      });
      // 동기화 결과는 missing_file/superseded까지 포함해 반환해야 호출자가
      // 상태를 볼 수 있습니다. 기본 목록(listTasks)에서는 숨겨집니다.
      return { ok: true, tasks: this.listTasks(projectId, { includeMissing: true }) };
    } catch {
      return { ok: false };
    }
  }

  // 스키마 3 → 4 마이그레이션: 프로젝트 workspace 기준으로 같은 taskPath의
  // 중복 인덱스 항목을 canonical 하나로 정리합니다. 파일 hash가 일치하는 항목을
  // canonical로 선택하고, 없으면 가장 최근 업데이트 항목을 사용합니다.
  // 파일 자체가 사라진 항목은 missing_file로 유지되며, 같은 taskPath에서
  // canonical이 아닌 항목은 superseded로 표시합니다. 실제 삭제는 하지 않습니다.
  migrateOrphanedTasks() {
    if (this.readOnly) return { ok: false, changed: false };
    let changed = false;
    try {
      const projects = new ProjectStore({ root: this.root }).init();
      const projectList = projects?.listProjects() || [];
      const byId = new Map(projectList.map((entry) => [entry.id, entry]));

      // 프로젝트별 workspace로 taskPath 그룹 구성
      const groupsByProject = new Map();
      for (const task of this.data.tasks) {
        if (task.contentSource !== "file" || !task.taskPath || !task.projectId) continue;
        if (!groupsByProject.has(task.projectId)) groupsByProject.set(task.projectId, new Map());
        const groups = groupsByProject.get(task.projectId);
        const normPath = task.taskPath.replace(/[\\/]+/g, path.sep);
        if (!groups.has(normPath)) groups.set(normPath, []);
        groups.get(normPath).push(task);
      }

      for (const [projectId, groups] of groupsByProject) {
        const project = byId.get(projectId);
        const workspace = project?.workspace || null;
        let fileMap = new Map();
        if (workspace) {
          try {
            const resolvedRoot = fs.realpathSync(workspace);
            const memoryTasksDir = path.join(resolvedRoot, ".project-memory", "tasks");
            if (fs.existsSync(memoryTasksDir)) {
              const taskFiles = fs.readdirSync(memoryTasksDir).filter((name) => /^TASK-\d+\.md$/i.test(name));
              for (const filename of taskFiles) {
                const absPath = path.join(memoryTasksDir, filename);
                const content = fs.readFileSync(absPath, "utf8");
                const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
                const relPath = path.join(".project-memory", "tasks", filename);
                fileMap.set(relPath, { filename, hash });
              }
            }
          } catch {
            fileMap = new Map();
          }
        }

        for (const [normPath, group] of groups) {
          if (group.length < 2) continue;
          const onDisk = fileMap.get(normPath);
          let canonical =
            (onDisk && group.find((task) => task.taskHash && task.taskHash === onDisk.hash)) ||
            [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
          for (const task of group) {
            if (task === canonical) continue;
            task.syncState = "superseded";
            task.updatedAt = this.now();
            changed = true;
          }
        }
      }
    } catch (error) {
      console.warn("[agora] workflow 마이그레이션 중 오류:", error?.message || error);
    }
    if (changed) this.persist();
    this.data.schemaVersion = WORKFLOW_SCHEMA_VERSION;
    this.persist();
    return { ok: true, changed };
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
  SYNC_STATES,
  WorkflowStore,
  WORKFLOW_SCHEMA_VERSION,
  TASK_STATUSES,
  DECISION_STATUSES,
  ROLE_DEFS,
  defaultRoot,
};
