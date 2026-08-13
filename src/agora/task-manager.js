// TASK-007 Task Manager — Task Contract를 불변 Frozen Run Contract로 정규화합니다.
//
// 설계 원칙 (AGORA_V1_DESIGN.md §8.4):
// - Agora V1은 inline Task(description이 본문)와 file-backed Task(TASK.md가 본문)를 모두
//   허용하되, 실행 시 두 형식을 반드시 하나의 immutable Frozen Run Contract로 정규화합니다.
// - contentSource는 "Run 생성 전까지 Task 본문을 어디서 가져올지"만 결정합니다.
//   Run이 생긴 순간부터 실행 계약의 유일한 기준은 RUN-xxx/task.md입니다.
// - RUN/task.md는 immutable입니다. Agora 내부 API에 frozen snapshot 갱신 함수를
//   만들지 않고, 누락/손상 시 현재 TASK.md로 fallback 하지 않고 오류로 중단합니다.
// - Checkpoint(workspace 복원용)와 Freeze(실행 계약 보존용)는 구분합니다.
//   실행 순서: Task 승인 → Run 생성/Freeze → Checkpoint → Builder
// - non-Git workspace에서도 TASK.md와 Run Freeze는 정상 동작해야 합니다.
//   (checkpoint 지원 여부와 분리)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 프로젝트 작업 영역 내부의 표준 메타 데이터 폴더 이름.
// .gitignore가 이를 무시하는지 여부와 무관하게, Run snapshot은 이 폴더에 둡니다.
const MEMORY_DIR = ".project-memory";
const TASKS_DIR = "tasks";
const RUNS_DIR = "runs";

function stripControlMarkers(text) {
  // Planner 출력의 파싱용 제어 마커(STATUS: PLAN_READY 등)를 본문에서 제거합니다.
  // Task lifecycle status와 구분되는 파싱용 마커이므로 파일에 저장할 필요가 없습니다.
  return String(text || "")
    .replace(/^\s*STATUS:\s*(PLAN_READY|NEEDS_DECISION|DONE|BLOCKED)\b.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw == null) return null;
    return raw;
  } catch {
    return null;
  }
}

// Planner Task용 TASK-xxx.md 파일명을 만듭니다. 기존 번호와 충돌하지 않도록
// tasks 폴더에 이미 있는 파일 번호를 기준으로 다음 번호를 계산합니다.
function nextTaskNumber(tasksDir) {
  let max = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const match = /^TASK-(\d+)\.md$/i.exec(name);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return max + 1;
}

function nextRunNumber(runsDir) {
  let max = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const match = /^RUN-(\d+)$/i.exec(name);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  return max + 1;
}

function resolveWorkspace(workspaceRoot) {
  if (!workspaceRoot) return null;
  try {
    const resolved = fs.realpathSync(workspaceRoot);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

class TaskManager {
  constructor(options = {}) {
    this.memoryRoot = options.memoryRoot || null;
    this.now = options.now || (() => Date.now());
  }

  // workspace 루트에 .project-memory 루트 경로를 계산합니다.
  memoryRootFor(workspace) {
    const root = resolveWorkspace(workspace);
    if (!root) return null;
    return this.memoryRoot || path.join(root, MEMORY_DIR);
  }

  // Planner의 PLAN_READY 결과를 file-backed Task로 저장합니다.
  // 1. .project-memory/tasks/TASK-xxx.md 생성 (본문 SoT)
  // 2. workflow.json metadata(index) 등록은 호출 측에서 수행
  // 반환: { filename, absPath, relativePath, content, hash, taskNumber }
  createTaskFromPlanner(plannerText, workspace) {
    const memoryRoot = this.memoryRootFor(workspace);
    if (!memoryRoot) throw new Error("작업 공간이 없어 Planner Task를 만들 수 없습니다.");
    const tasksDir = path.join(memoryRoot, TASKS_DIR);
    ensureDir(tasksDir);
    const number = nextTaskNumber(tasksDir);
    const filename = `TASK-${String(number).padStart(3, "0")}.md`;
    const absPath = path.join(tasksDir, filename);
    const content = stripControlMarkers(plannerText);
    if (!content.trim()) {
      throw new Error("Planner 결과가 비어 있어 TASK.md를 만들 수 없습니다.");
    }
    fs.writeFileSync(absPath, content, "utf8");
    const relativePath = path.join(MEMORY_DIR, TASKS_DIR, filename);
    return {
      filename,
      absPath,
      relativePath,
      content,
      hash: hashText(content),
      taskNumber: number,
    };
  }

  // 기획 검수 후 Planner가 같은 작업 지시서를 보완할 때만 live TASK.md를 갱신합니다.
  // 이미 동결된 RUN-xxx/task.md는 이 경로로 절대 건드리지 않습니다.
  updateTaskFromPlanner(taskInfo, plannerText, workspace) {
    const root = resolveWorkspace(workspace);
    const memoryRoot = this.memoryRootFor(workspace);
    const relativePath = String(taskInfo?.relativePath || "");
    const absPath = root && relativePath
      ? path.resolve(root, relativePath.replace(/^\.\/+/, ""))
      : null;
    const safeRoot = memoryRoot ? `${path.resolve(memoryRoot)}${path.sep}` : "";
    const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    if (!absPath || !safeRoot || !normalize(absPath).startsWith(normalize(safeRoot))) {
      throw new Error("갱신할 Planner Task 경로가 올바르지 않습니다.");
    }
    const content = stripControlMarkers(plannerText);
    if (!content.trim()) {
      throw new Error("Planner 결과가 비어 있어 TASK.md를 갱신할 수 없습니다.");
    }
    fs.writeFileSync(absPath, content, "utf8");
    return {
      ...taskInfo,
      absPath,
      relativePath,
      content,
      hash: hashText(content),
    };
  }

  // Task Contract 본문을 가져옵니다. file 기반이면 TASK.md를 읽고,
  // inline(기존/수동)이면 description을 사용합니다.
  resolveTaskContract(task, workspace) {
    if (!task) return null;
    if (task.contentSource === "file") {
      const root = resolveWorkspace(workspace);
      if (!root) return null;
      const abs = task.taskPath
        ? path.resolve(root, task.taskPath.replace(/^\.\/+/, ""))
        : null;
      const content = abs ? readText(abs) : null;
      if (content == null) return null;
      return { source: "file", taskPath: task.taskPath, content };
    }
    return { source: "inline", taskPath: null, content: String(task.description || "") };
  }

  // Builder 실행 직전에 Task Contract를 RUN-xxx/task.md로 동결(Freeze)합니다.
  // - RUN-xxx/task.md 와 task-hash 생성 (immutable)
  // - Frozen Task 누락/손상 시 현재 TASK.md로 fallback 하지 않고 throw
  // 반환: { runNumber, runDir, taskPath, taskHash, content }
  freezeTask(task, workspace) {
    const contract = this.resolveTaskContract(task, workspace);
    if (!contract || !contract.content.trim()) {
      throw new Error("실행 계약(Task)을 읽을 수 없습니다. Task를 확인해 주세요.");
    }
    const memoryRoot = this.memoryRootFor(workspace);
    if (!memoryRoot) throw new Error("작업 공간이 없어 Run을 만들 수 없습니다.");
    const runsDir = path.join(memoryRoot, RUNS_DIR);
    ensureDir(runsDir);
    const runNumber = nextRunNumber(runsDir);
    const runDir = path.join(runsDir, `RUN-${String(runNumber).padStart(3, "0")}`);
    ensureDir(runDir);
    const taskPath = path.join(runDir, "task.md");
    const hashPath = path.join(runDir, "task-hash");
    const content = contract.content;
    const hash = hashText(content);
    fs.writeFileSync(taskPath, content, "utf8");
    fs.writeFileSync(hashPath, hash, "utf8");
    return {
      runNumber,
      runDir,
      runId: `RUN-${String(runNumber).padStart(3, "0")}`,
      taskPath,
      taskHash: hash,
      content,
    };
  }

  // 기존 Run의 Frozen Task를 읽습니다. 누락/손상 시 throw (fallback 금지).
  readFrozenTask(runDir, expectedHash = null) {
    if (!runDir) throw new Error("Frozen Task 경로가 없습니다.");
    const taskPath = path.join(runDir, "task.md");
    const hashPath = path.join(runDir, "task-hash");
    const content = readText(taskPath);
    if (content == null || !content.trim()) {
      throw new Error(`Frozen Task(task.md)가 누락되었습니다: ${runDir}`);
    }
    const savedHash = readText(hashPath);
    if (savedHash == null || !savedHash.trim()) {
      throw new Error(`Frozen Task 해시가 누락되었습니다: ${runDir}`);
    }
    const currentHash = hashText(content);
    const normalizedSavedHash = savedHash.trim();
    if (normalizedSavedHash !== currentHash) {
      throw new Error(`Frozen Task가 손상되었습니다(해시 불일치): ${runDir}`);
    }
    if (expectedHash != null && String(expectedHash).trim() !== normalizedSavedHash) {
      throw new Error(`Frozen Task가 원래 Run 해시와 다릅니다: ${runDir}`);
    }
    return { content, taskHash: normalizedSavedHash };
  }

  markRunInvalid(runInfo, reason = "FROZEN_TASK_CORRUPTED") {
    if (!runInfo?.runDir || !runInfo?.runId) return false;
    try {
      ensureDir(runInfo.runDir);
      writeJsonAtomic(path.join(runInfo.runDir, "invalid.json"), {
        schemaVersion: 1,
        runId: runInfo.runId,
        reason,
        invalidAt: this.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  isRunInvalid(runInfo) {
    if (!runInfo?.runDir) return false;
    return readText(path.join(runInfo.runDir, "invalid.json")) != null;
  }

  writeRunEvidence(runInfo, evidence = {}) {
    if (!runInfo?.runDir) return false;
    try {
      ensureDir(runInfo.runDir);
      const commands = Array.isArray(evidence.commands)
        ? evidence.commands.slice(0, 20).map((entry) => ({
            commandHash: hashText(entry.command || ""),
            exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
            stdoutHash: entry.stdoutHash || (entry.stdoutTail != null ? hashText(entry.stdoutTail) : entry.stdout != null ? hashText(entry.stdout) : null),
            stderrHash: entry.stderrHash || (entry.stderrTail != null ? hashText(entry.stderrTail) : entry.stderr != null ? hashText(entry.stderr) : null),
            stdoutBytes: Number.isFinite(entry.stdoutBytes) ? entry.stdoutBytes : String(entry.stdoutTail ?? entry.stdout ?? "").length,
            stderrBytes: Number.isFinite(entry.stderrBytes) ? entry.stderrBytes : String(entry.stderrTail ?? entry.stderr ?? "").length,
            truncated: Boolean(entry.truncated),
          }))
        : [];
      writeJsonAtomic(path.join(runInfo.runDir, "evidence.json"), {
        schemaVersion: 1,
        round: evidence.round || 1,
        invocationId: evidence.invocationId || null,
        transport: evidence.transport || "COMPLETED",
        declaration: evidence.declaration || "MISSING",
        changes: evidence.changes || "NO_CHANGES",
        execution: evidence.execution || "UNAVAILABLE",
        sessionPersisted: evidence.sessionPersisted !== false,
        source: { kind: evidence.source?.kind || "provider-event", provider: evidence.source?.provider || null },
        provider: evidence.provider || evidence.source?.provider || null,
        commands,
        persistedAt: this.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  runInfoForId(runId, workspace) {
    const id = String(runId || "");
    if (!/^RUN-\d+$/i.test(id)) return null;
    const memoryRoot = this.memoryRootFor(workspace);
    if (!memoryRoot) return null;
    const runDir = path.join(memoryRoot, RUNS_DIR, id);
    if (!fs.existsSync(runDir)) return null;
    const content = readText(path.join(runDir, "task.md"));
    const taskHash = readText(path.join(runDir, "task-hash"));
    return {
      runId: id,
      runDir,
      taskPath: path.join(runDir, "task.md"),
      content,
      taskHash: taskHash == null ? null : taskHash.trim(),
    };
  }
}

module.exports = {
  TaskManager,
  MEMORY_DIR,
  TASKS_DIR,
  RUNS_DIR,
  stripControlMarkers,
  hashText,
};
