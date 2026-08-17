"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (file, content) => {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.replace(/\r\n/g, "\n"), "utf8");
};
function replaceOnce(file, before, after) {
  const source = read(file);
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${file}: expected exactly one match, found ${count}: ${before.slice(0, 100)}`);
  write(file, source.replace(before, after));
}
function replaceAllChecked(file, before, after, expected) {
  const source = read(file);
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${file}: expected ${expected} matches, found ${count}: ${before.slice(0, 100)}`);
  write(file, source.split(before).join(after));
}
function append(file, content) {
  write(file, read(file).replace(/\s*$/, "\n") + content.replace(/^\n/, ""));
}

// ---------------------------------------------------------------------------
// Stage 2 residual: strict Task Contract headings + protocol-marker-safe body.
// ---------------------------------------------------------------------------
write("src/agora/task-contract-validator.js", `"use strict";

const REQUIRED_SECTIONS = Object.freeze([
  "Goal",
  "Requirements",
  "Implementation Approach",
  "Acceptance Criteria",
  "Verification",
  "Out of Scope",
]);

const RECOMMENDED_SECTIONS = Object.freeze([
  "Current State / Evidence",
  "Affected Modules",
  "Invariants / Must Preserve",
  "Risks / Open Questions",
  "Dependencies",
  "Related Tasks",
]);

function normalizeHeading(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\\s_/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\\s+/g, " ")
    .trim();
}

function recommendedKeys(label) {
  const normalized = normalizeHeading(label);
  const parts = normalized.split(" ").filter(Boolean);
  const keys = new Set([normalized]);
  if (parts.length >= 2) keys.add(parts.slice(0, 2).join(" "));
  if (parts.length >= 1) keys.add(parts[0]);
  return [...keys];
}

function stripProtocolMarkers(value) {
  return String(value || "")
    .replace(/^\\s*(?:STATUS|VERDICT):\\s*[^\\r\\n]*$/gim, "")
    .replace(/^\\s*\\[\\[CODEPET_[^\\]\\r\\n]+\\]\\]\\s*$/gim, "");
}

function parseSections(content) {
  const lines = String(content || "").replace(/\\r\\n/g, "\\n").split("\\n");
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\\s*```/.test(line)) {
      if (current) current.body.push(line);
      fenced = !fenced;
      continue;
    }
    const heading = !fenced ? /^\\s*#{2,3}\\s+(.+?)\\s*$/.exec(line) : null;
    if (heading) {
      current = { heading: heading[1].trim(), key: normalizeHeading(heading[1]), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections;
}

function meaningfulBody(section) {
  if (!section) return "";
  let fenced = false;
  const kept = [];
  for (const line of section.body || []) {
    if (/^\\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) kept.push(line);
  }
  return stripProtocolMarkers(kept.join("\\n")).trim();
}

function validateTaskContract(content) {
  const parsed = parseSections(content);
  const byKey = new Map();
  for (const section of parsed) {
    if (!byKey.has(section.key)) byKey.set(section.key, section);
  }

  const missing = [];
  const sections = [];
  for (const label of REQUIRED_SECTIONS) {
    // Required headings are deliberately exact. Planner prompt and validator share
    // one canonical Markdown contract instead of accepting ambiguous abbreviations.
    const section = byKey.get(normalizeHeading(label));
    if (!section || !meaningfulBody(section)) missing.push(label);
    else sections.push(label);
  }

  const warnings = [];
  for (const label of RECOMMENDED_SECTIONS) {
    const section = recommendedKeys(label)
      .map((key) => byKey.get(key))
      .find((entry) => entry && meaningfulBody(entry));
    if (!section) warnings.push(label);
  }

  return { valid: missing.length === 0, missing, warnings, sections };
}

module.exports = {
  REQUIRED_SECTIONS,
  RECOMMENDED_SECTIONS,
  validateTaskContract,
};
`);

append("test/task-contract-validator.test.js", `

test("필수 헤딩은 축약형이 아니라 canonical 이름과 정확히 일치해야 한다", () => {
  const contract = [
    "## Goal", "목표",
    "## Requirements", "요구사항",
    "## Implementation", "접근",
    "## Acceptance", "완료",
    "## Verification", "검증",
    "## Out", "범위밖",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Implementation Approach"));
  assert.ok(result.missing.includes("Acceptance Criteria"));
  assert.ok(result.missing.includes("Out of Scope"));
});

test("STATUS/VERDICT 제어 마커만 있는 필수 섹션은 빈 본문으로 본다", () => {
  const contract = [
    "## Goal", "목표",
    "## Requirements", "요구사항",
    "## Implementation Approach", "접근",
    "## Acceptance Criteria", "완료",
    "## Verification", "검증",
    "## Out of Scope", "STATUS: PLAN_READY",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Out of Scope"));
});
`);

// ---------------------------------------------------------------------------
// Stage 1 residual: project-owned runtime workspace + provenance-safe task index.
// ---------------------------------------------------------------------------
replaceOnce("src/agora/workflow-store.js", "const WORKFLOW_SCHEMA_VERSION = 4;", "const WORKFLOW_SCHEMA_VERSION = 5;");
replaceOnce(
  "src/agora/workflow-store.js",
  `          if (onDisk && !canonical) {
            canonical = [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
            if (canonical) {
              canonical.taskHash = onDisk.hash;
              canonical.syncState = "ok";
              canonical.updatedAt = this.now();
              changed = true;
            }
          }`,
  `          if (onDisk && !canonical) {
            // Disk content is a new Task revision. Never rewrite an old completed
            // entry's hash in-place: that would attach old run provenance to new
            // instructions. Create a fresh canonical revision and supersede history.
            const latest = [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
            canonical = normalizeTask({
              ...(latest || {}),
              id: null,
              projectId,
              title: latest?.title || onDisk.filename,
              contentSource: "file",
              taskPath: normPath,
              taskHash: onDisk.hash,
              status: "todo",
              runId: null,
              activeRunId: null,
              lastRunId: null,
              syncState: "ok",
              createdAt: this.now(),
              updatedAt: this.now(),
            }, this.now());
            if (canonical) {
              this.data.tasks.push(canonical);
              group.push(canonical);
              changed = true;
            }
          }`
);
replaceOnce(
  "src/agora/workflow-store.js",
  `          let canonical =
            group.find((task) => task.taskHash && task.taskHash === onDisk.hash) ||
            [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
          if (canonical) {
            if (canonical.taskHash !== onDisk.hash) {
              canonical.taskHash = onDisk.hash;
              canonical.syncState = "ok";
              canonical.updatedAt = this.now();
              changed = true;
            } else if (canonical.syncState !== "ok") {
              canonical.syncState = "ok";
              canonical.updatedAt = this.now();
              changed = true;
            }
          }`,
  `          let canonical = group.find((task) => task.taskHash && task.taskHash === onDisk.hash) || null;
          if (!canonical) {
            const latest = [...group].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
            canonical = normalizeTask({
              ...(latest || {}),
              id: null,
              projectId,
              title: latest?.title || onDisk.filename,
              contentSource: "file",
              taskPath: normPath,
              taskHash: onDisk.hash,
              status: "todo",
              runId: null,
              activeRunId: null,
              lastRunId: null,
              syncState: "ok",
              createdAt: this.now(),
              updatedAt: this.now(),
            }, this.now());
            if (canonical) {
              this.data.tasks.push(canonical);
              group.push(canonical);
              changed = true;
            }
          } else if (canonical.syncState !== "ok") {
            canonical.syncState = "ok";
            canonical.updatedAt = this.now();
            changed = true;
          }`
);
replaceAllChecked("src/agora/workflow-store.js", "스키마 3 → 4", "스키마 3/4 → 5", 2);

// Project is the runtime authority. Session workspace remains a compatibility cache only.
replaceOnce(
  "src/chat/chat-ipc.js",
  `  function roomMeta(meta) {
    const project = projectForSession(meta);
    return {
      permissionMode: meta?.permissionMode || "chat",
      workspace: meta?.workspace || null,`,
  `  function roomMeta(meta) {
    const project = projectForSession(meta);
    return {
      permissionMode: meta?.permissionMode || "chat",
      workspace: project?.workspace || null,`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        workspace: meta.workspace || null,
        model: agent.model,`,
  `        workspace: projectForSession(meta)?.workspace || null,
        model: agent.model,`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `      if (workflow && sessionProject && session.meta.workspace && !workflow.readOnly) {
        workflow.reconcileProjectTasks(sessionProject.id, session.meta.workspace);`,
  `      if (workflow && sessionProject?.workspace && !workflow.readOnly) {
        workflow.reconcileProjectTasks(sessionProject.id, sessionProject.workspace);`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `      if (permissionMode !== "chat" && !meta.workspace) {
        return { ok: false, error: "워크스페이스를 먼저 선택해 주세요." };
      }`,
  `      if (permissionMode !== "chat" && !projectForSession(meta)?.workspace) {
        return { ok: false, error: "프로젝트 워크스페이스를 먼저 선택해 주세요." };
      }`
);

// ---------------------------------------------------------------------------
// Stage 3: typed checkpoint failures + persistent protection state.
// ---------------------------------------------------------------------------
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}`,
  `function checkpointError(code, message, cause = null) {
  const error = new Error(message || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    throw checkpointError("CHECKPOINT_GIT_FAILED", "Git 명령으로 checkpoint 기준 상태를 읽지 못했습니다.", error);
  }
}`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `  try {
    fs.mkdirSync(dir, { recursive: true });
    const stashOutput = await git(repo, ["stash", "create"]);`,
  `  try {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "checkpoint 저장 폴더를 만들지 못했습니다.", error);
    }
    const stashOutput = await git(repo, ["stash", "create"]);`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `    fs.writeFileSync(path.join(dir, "tracked.patch"), diffOut, "utf8");`,
  `    try {
      fs.writeFileSync(path.join(dir, "tracked.patch"), diffOut, "utf8");
    } catch (error) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "tracked patch를 저장하지 못했습니다.", error);
    }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `      if (!safe || !isWithin(repo, path.resolve(repo, safe))) throw new Error("checkpoint untracked 경로가 올바르지 않습니다.");`,
  `      if (!safe || !isWithin(repo, path.resolve(repo, safe))) {
        throw checkpointError("CHECKPOINT_COPY_FAILED", "checkpoint untracked 경로가 올바르지 않습니다.");
      }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `      if (!isWithin(path.join(dir, "untracked"), dest)) throw new Error("checkpoint 사본 경로가 올바르지 않습니다.");`,
  `      if (!isWithin(path.join(dir, "untracked"), dest)) {
        throw checkpointError("CHECKPOINT_COPY_FAILED", "checkpoint 사본 경로가 올바르지 않습니다.");
      }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `      const stat = fs.lstatSync(src);
      if (!stat.isFile()) throw new Error("checkpoint untracked 파일이 일반 파일이 아닙니다: " + safe);`,
  `      let stat;
      try {
        stat = fs.lstatSync(src);
      } catch (error) {
        throw checkpointError("CHECKPOINT_COPY_FAILED", "checkpoint 대상 파일 상태를 읽지 못했습니다: " + safe, error);
      }
      if (!stat.isFile()) {
        throw checkpointError("CHECKPOINT_UNTRACKED_NOT_REGULAR", "checkpoint untracked 항목이 일반 파일이 아닙니다: " + safe);
      }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        const copyMeta = sha256File(dest);`,
  `        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
        } catch (error) {
          throw checkpointError("CHECKPOINT_COPY_FAILED", "untracked 파일 사본을 만들지 못했습니다: " + safe, error);
        }
        const copyMeta = sha256File(dest);
        if (!copyMeta) throw checkpointError("CHECKPOINT_COPY_FAILED", "untracked 사본을 검증하지 못했습니다: " + safe);`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `    fs.writeFileSync(listPath, safePaths.join("\\n"), "utf8");`,
  `    try {
      fs.writeFileSync(listPath, safePaths.join("\\n"), "utf8");
    } catch (error) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "untracked 목록을 저장하지 못했습니다.", error);
    }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `    atomicJson(path.join(dir, "manifest.json"), manifest);`,
  `    try {
      atomicJson(path.join(dir, "manifest.json"), manifest);
    } catch (error) {
      throw checkpointError("CHECKPOINT_STORAGE_FAILED", "checkpoint manifest를 저장하지 못했습니다.", error);
    }`
);
replaceOnce(
  "src/agora/turn-checkpoint.js",
  `  } catch {
    try {
      if (isWithin(storageRoot, dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    // 여기 도달했다는 것은 Git 저장소인데 백업 생성에 실패했다는 뜻이다.
    // non-Git(supported:false)과 구분해 호출자가 Builder를 무방비로 시작하지
    // 않도록 failed 플래그를 남긴다.
    return { supported: false, failed: true };
  }`,
  `  } catch (error) {
    try {
      if (isWithin(storageRoot, dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    // Git workspace에서 checkpoint 생성이 실패한 원인을 보존합니다.
    return {
      supported: false,
      failed: true,
      reason: error?.code || "UNKNOWN",
      detail: error?.message || null,
    };
  }`
);

// Professional Run schema additions and transitions.
replaceOnce("src/agora/professional-run.js", "const PROFESSIONAL_SCHEMA_VERSION = 1;", "const PROFESSIONAL_SCHEMA_VERSION = 2;");
replaceOnce(
  "src/agora/professional-run.js",
  `const PROFESSIONAL_STATUSES = Object.freeze([
  "RUNNING",
  "WAITING",
  "BLOCKED",
  "INTERRUPTED",
  "INVALID",
  "COMPLETED",
]);`,
  `const PROFESSIONAL_STATUSES = Object.freeze([
  "RUNNING",
  "WAITING",
  "BLOCKED",
  "INTERRUPTED",
  "INVALID",
  "COMPLETED",
]);

const CHECKPOINT_PROTECTIONS = Object.freeze([
  "protected",
  "unavailable_non_git",
  "unavailable_checkpoint_failed",
  "unavailable_user_approved",
]);`
);
replaceOnce(
  "src/agora/professional-run.js",
  `    checkpointId: options.checkpointId || null,
    carriedFromRunId: options.carriedFromRunId || null,`,
  `    checkpointId: options.checkpointId || null,
    checkpointProtection: CHECKPOINT_PROTECTIONS.includes(options.checkpointProtection)
      ? options.checkpointProtection
      : null,
    checkpointFailReason: options.checkpointFailReason || null,
    carriedFromRunId: options.carriedFromRunId || null,`
);
replaceOnce(
  "src/agora/professional-run.js",
  `    case "USER_ANSWER_PLAN": {
      if (current.status !== "WAITING" || (current.node !== "PLANNING" && current.node !== "PLAN_REVIEW")) {
        return { ok: false, reason: "답변 가능한 대기 상태가 아닙니다." };
      }
      next.node = "PLANNING";
      next.status = "RUNNING";
      next.stopReason = null;
      break;
    }`,
  `    case "USER_ANSWER_PLAN": {
      const readyEdit = current.node === "READY" && current.status === "WAITING" && current.stopReason === "PLAN_READY";
      if (current.status !== "WAITING" || (!readyEdit && current.node !== "PLANNING" && current.node !== "PLAN_REVIEW")) {
        return { ok: false, reason: "답변 가능한 대기 상태가 아닙니다." };
      }
      next.node = "PLANNING";
      next.status = "RUNNING";
      next.stopReason = null;
      if (readyEdit) {
        next.approvedTaskHash = null;
        next.frozenRunId = null;
        next.checkpointId = null;
        next.checkpointProtection = null;
        next.checkpointFailReason = null;
      }
      break;
    }`
);
replaceOnce(
  "src/agora/professional-run.js",
  `      if (event.frozenRunId) next.frozenRunId = event.frozenRunId;
      if (event.checkpointId) next.checkpointId = event.checkpointId;
      next.implementationRound = 1;
      break;
    }
    case "TASK_CHANGED_AFTER_REVIEW": {`,
  `      if (event.frozenRunId) next.frozenRunId = event.frozenRunId;
      if (event.checkpointId) next.checkpointId = event.checkpointId;
      next.checkpointProtection = CHECKPOINT_PROTECTIONS.includes(event.checkpointProtection)
        ? event.checkpointProtection
        : (event.checkpointId ? "protected" : "unavailable_non_git");
      next.checkpointFailReason = null;
      next.implementationRound = 1;
      break;
    }
    case "CHECKPOINT_FAILED": {
      if (current.node !== "READY") return { ok: false, reason: "checkpoint 실패를 기록할 수 있는 READY 상태가 아닙니다." };
      next.node = "READY";
      next.status = "WAITING";
      next.stopReason = "CHECKPOINT_FAILED";
      next.blockReason = "CHECKPOINT_FAILED";
      if (event.frozenRunId) next.frozenRunId = event.frozenRunId;
      next.checkpointId = null;
      next.checkpointProtection = "unavailable_checkpoint_failed";
      next.checkpointFailReason = event.checkpointFailReason || "UNKNOWN";
      break;
    }
    case "CHECKPOINT_RETRY": {
      if (current.node !== "READY" || current.status !== "WAITING" || current.stopReason !== "CHECKPOINT_FAILED") {
        return { ok: false, reason: "checkpoint를 재시도할 수 있는 상태가 아닙니다." };
      }
      next.status = "RUNNING";
      next.stopReason = null;
      next.blockReason = null;
      next.checkpointProtection = null;
      next.checkpointFailReason = null;
      break;
    }
    case "PROCEED_UNPROTECTED": {
      if (current.node !== "READY" || current.status !== "WAITING" || current.stopReason !== "CHECKPOINT_FAILED") {
        return { ok: false, reason: "무보호 실행을 승인할 수 있는 상태가 아닙니다." };
      }
      next.node = "IMPLEMENTING";
      next.status = "RUNNING";
      next.stopReason = null;
      next.blockReason = null;
      next.checkpointId = null;
      next.checkpointProtection = "unavailable_user_approved";
      next.implementationRound = 1;
      break;
    }
    case "TASK_CHANGED_AFTER_REVIEW": {`
);
replaceOnce(
  "src/agora/professional-run.js",
  `      next.checkpointId = null;
      next.frozenRunId = null;
      next.approvedTaskHash = null;`,
  `      next.checkpointId = null;
      next.checkpointProtection = null;
      next.checkpointFailReason = null;
      next.frozenRunId = null;
      next.approvedTaskHash = null;`
);
replaceOnce(
  "src/agora/professional-run.js",
  `      implementationRound: 0,
    };`,
  `      implementationRound: 0,
      checkpointProtection: null,
      checkpointFailReason: null,
      stopReason: null,
    };`
);
replaceOnce(
  "src/agora/professional-run.js",
  `  const blocked = run.status === "BLOCKED" || run.status === "INVALID";
  const needsInput = run.status === "WAITING" && ["PLANNING", "PLAN_REVIEW"].includes(run.node);`,
  `  const blocked = run.status === "BLOCKED" || run.status === "INVALID" ||
    (run.status === "WAITING" && run.stopReason === "CHECKPOINT_FAILED");
  const needsInput = run.status === "WAITING" && (
    ["PLANNING", "PLAN_REVIEW"].includes(run.node) ||
    (run.node === "READY" && run.stopReason === "PLAN_READY")
  );`
);
replaceOnce(
  "src/agora/professional-run.js",
  `    implementationRound: run.implementationRound || 0,
    stopReason: run.stopReason || null,`,
  `    implementationRound: run.implementationRound || 0,
    checkpointProtection: run.checkpointProtection || null,
    checkpointFailReason: run.checkpointFailReason || null,
    stopReason: run.stopReason || null,`
);
replaceOnce(
  "src/agora/professional-run.js",
  `  PROFESSIONAL_STATUSES,
  phaseForNode,`,
  `  PROFESSIONAL_STATUSES,
  CHECKPOINT_PROTECTIONS,
  phaseForNode,`
);

// Evidence carries checkpoint protection end to end.
replaceOnce(
  "src/chat/chat-professional-evidence.js",
  `function buildProfessionalEvidencePayload({ runInfo, builderResult, diff, round, provider } = {}) {`,
  `function buildProfessionalEvidencePayload({ runInfo, builderResult, diff, round, provider, checkpointProtection = null } = {}) {`
);
replaceOnce(
  "src/chat/chat-professional-evidence.js",
  `    schemaVersion: 2,
    capturedAt: new Date().toISOString(),`,
  `    schemaVersion: 3,
    capturedAt: new Date().toISOString(),
    checkpointProtection: checkpointProtection || null,`
);
replaceOnce(
  "src/agora/task-manager.js",
  `      schemaVersion: 2,
      runId: info.runId,`,
  `      schemaVersion: 3,
      runId: info.runId,
      checkpointProtection: ["protected", "unavailable_non_git", "unavailable_checkpoint_failed", "unavailable_user_approved"].includes(evidence.checkpointProtection)
        ? evidence.checkpointProtection
        : null,`
);

// ---------------------------------------------------------------------------
// Stage 4: centralized role context and IPC policy.
// ---------------------------------------------------------------------------
write("src/chat/professional-role-context.js", `"use strict";

const ROLE_CONTEXT_POLICY = Object.freeze({
  planner: Object.freeze({
    transcript: "all", projectContext: true, workflow: true, memory: true,
    sees: ["user request", "confirmed decisions", "relevant conversation", "related tasks", "project rules", "workspace"],
    excludes: [],
  }),
  plan_review: Object.freeze({
    transcript: "user", projectContext: true, workflow: true, memory: false,
    sees: ["user messages", "current TASK", "confirmed project context", "project rules", "workspace"],
    excludes: ["other-agent free chat", "memory summary"],
  }),
  implementation: Object.freeze({
    transcript: "none", projectContext: false, workflow: false, memory: false,
    sees: ["Frozen Task", "project rules", "workspace"],
    excludes: ["conversation transcript", "global task list", "other-agent output"],
  }),
  review: Object.freeze({
    transcript: "none", projectContext: false, workflow: false, memory: false,
    sees: ["Frozen Task", "actual Diff", "Evidence", "project rules", "workspace"],
    excludes: ["conversation transcript", "Builder self-report", "global task list"],
  }),
  recorder: Object.freeze({
    transcript: "none", projectContext: false, workflow: false, memory: false,
    sees: ["Frozen Task", "final Diff", "Evidence", "final verdict"],
    excludes: ["conversation transcript", "other-agent free chat"],
  }),
});

function roleContextPolicy(stage) {
  return ROLE_CONTEXT_POLICY[String(stage || "").toLowerCase()] || null;
}

function roleContextPromptLines(stage) {
  const policy = roleContextPolicy(stage);
  if (!policy) return [];
  const lines = ["[Professional Context Boundary]"];
  if (policy.sees.length) lines.push("참고 입력: " + policy.sees.join(", "));
  if (policy.excludes.length) lines.push("보지 않는 입력: " + policy.excludes.join(", "));
  return lines;
}

module.exports = { ROLE_CONTEXT_POLICY, roleContextPolicy, roleContextPromptLines };
`);

write("src/chat/professional-ipc-policy.js", `"use strict";

const TABLE = Object.freeze({
  "PLANNING:RUNNING": new Set(["cancel"]),
  "PLANNING:WAITING": new Set(["plan-answer", "cancel", "recordOnly-send"]),
  "PLAN_REVIEW:RUNNING": new Set(["cancel"]),
  "PLAN_REVIEW:WAITING": new Set(["plan-answer", "cancel", "recordOnly-send"]),
  "READY:WAITING": new Set(["start", "plan-answer", "cancel", "recordOnly-send", "checkpoint-choice"]),
  "READY:RUNNING": new Set(["cancel", "checkpoint-choice"]),
  "IMPLEMENTING:RUNNING": new Set(["cancel"]),
  "IMPLEMENTING:WAITING": new Set(["resume", "cancel"]),
  "IMPLEMENTING:BLOCKED": new Set(["blocked", "block-details", "replan", "cancel"]),
  "REVIEWING:RUNNING": new Set(["cancel"]),
  "REVIEWING:WAITING": new Set(["resume", "continue-review", "continue-record", "cancel"]),
  "RECORDING:RUNNING": new Set(["cancel"]),
  "RECORDING:WAITING": new Set(["retry-recorder", "cancel"]),
});

function isOpenProfessionalRun(run) {
  return Boolean(run && run.status !== "COMPLETED" && run.node !== "COMPLETED");
}

function professionalActionAllowed(run, action) {
  if (!isOpenProfessionalRun(run)) return true;
  return Boolean(TABLE[String(run.node) + ":" + String(run.status)]?.has(action));
}

function assertProfessionalAction(run, action) {
  if (professionalActionAllowed(run, action)) return { ok: true };
  return { ok: false, error: "현재 Professional 상태에서는 이 동작을 사용할 수 없습니다." };
}

module.exports = { TABLE, isOpenProfessionalRun, professionalActionAllowed, assertProfessionalAction };
`);

// Prompt context assembly uses the same policy it documents.
replaceOnce(
  "src/chat/chat-prompt.js",
  `const path = require("node:path");`,
  `const path = require("node:path");
const { roleContextPolicy, roleContextPromptLines } = require("./professional-role-context");`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  const isPlanReviewer = specialist?.stage === "plan_review";
  const isBuilder = specialist?.stage === "implementation";
  const isCleanReviewer = specialist?.stage === "review";
  const isProfessionalRecorder = specialist?.stage === "recorder" && specialist?.professional === true;
  const sourceMessages = isPlanReviewer
    ? messages.filter((message) => message.authorType === "user")
    : messages;`,
  `  const isPlanReviewer = specialist?.stage === "plan_review";
  const isBuilder = specialist?.stage === "implementation";
  const isCleanReviewer = specialist?.stage === "review";
  const isProfessionalRecorder = specialist?.stage === "recorder" && specialist?.professional === true;
  const rolePolicy = specialist?.stage ? roleContextPolicy(specialist.stage) : null;
  const sourceMessages = rolePolicy?.transcript === "user"
    ? messages.filter((message) => message.authorType === "user")
    : rolePolicy?.transcript === "none"
      ? []
      : messages;`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  const recent = isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify
    ? []
    : sourceMessages.slice(-MAX_RECENT_MESSAGES);`,
  `  const recent = rolePolicy?.transcript === "none" || isSimplify
    ? []
    : sourceMessages.slice(-MAX_RECENT_MESSAGES);`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  const context = (isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify)
    ? ""
    : compactText(projectContext, MAX_PROJECT_CONTEXT_CHARS);`,
  `  const context = (rolePolicy && !rolePolicy.projectContext) || isSimplify
    ? ""
    : compactText(projectContext, MAX_PROJECT_CONTEXT_CHARS);`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  const workflow = (isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify)
    ? ""
    : compactText(workflowContext, MAX_WORKFLOW_CONTEXT_CHARS);`,
  `  const workflow = (rolePolicy && !rolePolicy.workflow) || isSimplify
    ? ""
    : compactText(workflowContext, MAX_WORKFLOW_CONTEXT_CHARS);`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  const memory = (isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify)
    ? ""
    : compactText(memoryContext, MAX_MEMORY_CONTEXT_CHARS);`,
  `  const memory = (rolePolicy && !rolePolicy.memory) || isSimplify
    ? ""
    : compactText(memoryContext, MAX_MEMORY_CONTEXT_CHARS);`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `  if (specialist) {
    lines.push("", "[전문 실행]");`,
  `  if (specialist) {
    lines.push("", "[전문 실행]");
    lines.push(...roleContextPromptLines(specialist.stage));`
);
replaceOnce(
  "src/chat/chat-prompt.js",
  `    if (specialist.stage === "review") {
      lines.push("당신은 독립 검수자입니다.");`,
  `    if (specialist.stage === "review") {
      lines.push("당신은 독립 검수자입니다.");
      const checkpointProtection = specialist.evidence?.checkpointProtection;
      if (String(checkpointProtection || "").startsWith("unavailable_")) {
        lines.push("⚠ 이 실행은 사전 workspace snapshot이 없습니다 (" + checkpointProtection + "). 회귀 검증 신뢰도가 제한됩니다.");
      }`
);

// Specialist: preserve typed freeze error, checkpoint resume flow, evidence enum.
replaceOnce(
  "src/chat/chat-specialist.js",
  `  "CHECKPOINT_CLEANUP_FAILED",
]);`,
  `  "CHECKPOINT_CLEANUP_FAILED",
  "CHECKPOINT_FAILED",
  "TASK_CONTRACT_INCOMPLETE",
]);`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `  evidencePayload(options = {}) {
    const payload = buildProfessionalEvidencePayload(options);`,
  `  evidencePayload(options = {}) {
    const payload = buildProfessionalEvidencePayload({
      ...options,
      checkpointProtection: options.checkpointProtection || this.professionalRun?.checkpointProtection || null,
    });`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `  async runExecutionBlock({ stages, mode, maxAutoRevisions, feedback, taskInfo, round, requestedGeneration, recordAfter = true }) {`,
  `  async runExecutionBlock({ stages, mode, maxAutoRevisions, feedback, taskInfo, round, requestedGeneration, recordAfter = true, runInfo: existingRunInfo = null, checkpointOverride = undefined, executionAlreadyTransitioned = false }) {`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `    let runInfo = null;
    const workspace = this.meta.workspace;
    if (taskInfo) {`,
  `    let runInfo = existingRunInfo || null;
    const workspace = this.meta.workspace;
    if (taskInfo && !runInfo) {`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `          stopReason: "FROZEN_TASK_MISSING",
          taskError: error?.message || "알 수 없는 오류",`,
  `          stopReason: error?.code === "TASK_CONTRACT_INCOMPLETE" ? "TASK_CONTRACT_INCOMPLETE" : "FROZEN_TASK_MISSING",
          taskError: error?.message || "알 수 없는 오류",`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `    const checkpoint = this.checkpointEngine
      ? await this.checkpointEngine.createCheckpoint(this.meta.workspace, {
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: runInfo?.runId || null,
        })
      : null;`,
  `    let checkpoint = checkpointOverride;
    if (checkpoint === undefined) {
      checkpoint = this.checkpointEngine
        ? await this.checkpointEngine.createCheckpoint(this.meta.workspace, {
            storageRoot: this.checkpointRoot,
            sessionId: this.sessionId,
            runId: runInfo?.runId || null,
          })
        : null;
    }`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `    if (checkpoint?.failed === true) {
      this.clearRecoveryState();
      this.appendSystem("작업 전 상태 백업(checkpoint)을 만들지 못해 전문 실행을 시작하지 않았습니다. 워크스페이스의 Git 상태를 확인해 주세요.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "CHECKPOINT_FAILED",
      };
    }`,
  `    if (checkpoint?.failed === true) {
      this.clearRecoveryState();
      const transition = this.transitionProfessional({
        type: "CHECKPOINT_FAILED",
        frozenRunId: runInfo?.runId || null,
        checkpointFailReason: checkpoint.reason || "UNKNOWN",
      });
      if (!transition.ok) return this.professionalTransitionFailure("implementation", transition);
      this.specialistResume = {
        phase: "checkpoint_failed",
        stages,
        mode,
        maxAutoRevisions,
        feedback,
        taskInfo,
        round,
        requestedGeneration,
        recordAfter,
        runInfo,
      };
      this.specialistActive = false;
      this.emitSpecialistState();
      const reason = checkpoint.reason || "UNKNOWN";
      const reasonText = {
        CHECKPOINT_GIT_FAILED: "Git 기준 상태를 읽지 못했습니다",
        CHECKPOINT_UNTRACKED_NOT_REGULAR: "일반 파일이 아닌 untracked 항목이 있습니다",
        CHECKPOINT_COPY_FAILED: "untracked 파일 사본을 만들지 못했습니다",
        CHECKPOINT_STORAGE_FAILED: "checkpoint 저장소에 기록하지 못했습니다",
        UNKNOWN: "알 수 없는 checkpoint 오류가 발생했습니다",
      }[reason] || reason;
      this.appendSystem("작업 전 checkpoint를 만들지 못했습니다 (" + reasonText + "). 재시도, 백업 없이 실행, 취소 중 하나를 선택해 주세요.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "CHECKPOINT_FAILED",
        checkpointFailReason: reason,
      };
    }`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `    const executeTransition = this.transitionProfessional({
      type: "USER_EXECUTE",
      frozenRunId: runInfo?.runId || null,
      checkpointId: checkpoint?.checkpointId || null,
    });
    if (!executeTransition.ok) {`,
  `    const executeTransition = executionAlreadyTransitioned
      ? { ok: true, state: this.professionalRun }
      : this.transitionProfessional({
          type: "USER_EXECUTE",
          frozenRunId: runInfo?.runId || null,
          checkpointId: checkpoint?.checkpointId || null,
          checkpointProtection: checkpoint?.supported ? "protected" : "unavailable_non_git",
        });
    if (!executeTransition.ok) {`
);

// READY composer input is a normal plan amendment; checkpoint failures get a dedicated resolver.
replaceOnce(
  "src/chat/chat-specialist.js",
  `  async _answerPlanQuestion(answer) {
    const resume = this.specialistResume;
    if (!resume || !["needs_decision", "plan_review_fix_required"].includes(resume.phase)) {
      return { ok: false, error: "답변을 기다리는 기획 질문이 없습니다." };
    }`,
  `  async _answerPlanQuestion(answer) {
    const readyEdit = this.professionalRun?.node === "READY" &&
      this.professionalRun?.status === "WAITING" &&
      this.professionalRun?.stopReason === "PLAN_READY" &&
      this.professionalPlan?.taskInfo;
    const resume = readyEdit
      ? {
          stages: this.professionalPlan.stages,
          mode: this.professionalPlan.mode,
          planAutoRevisions: this.professionalRun?.policy?.planAutoRevisions || 0,
          implementationAutoRevisions: this.professionalPlan.implementationAutoRevisions || 0,
          action: "plan",
          feedback: this.professionalPlan.feedback || "",
          taskInfo: this.professionalPlan.taskInfo,
          previousIssues: "",
          phase: "ready_edit",
        }
      : this.specialistResume;
    if (!resume || !["needs_decision", "plan_review_fix_required", "ready_edit"].includes(resume.phase)) {
      return { ok: false, error: "답변을 기다리는 기획 질문이 없습니다." };
    }`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `    this.appendMessage({ authorType: "user", author: "user", text: \`[기획 답변] \${text}\` });`,
  `    this.appendMessage({ authorType: "user", author: "user", text: readyEdit ? \`[기획 수정] \${text}\` : \`[기획 답변] \${text}\` });`
);
replaceOnce(
  "src/chat/chat-specialist.js",
  `  // 기존 호출 경로는 유지합니다. action을 명시한 새 화면만 버튼형 전문 실행을 씁니다.`,
  `  async resolveCheckpointFailure(action) {
    return this.withProfessionalAuthorization("workspace-write", () => this._resolveCheckpointFailure(action));
  }

  async _resolveCheckpointFailure(action) {
    const resume = this.specialistResume;
    if (!resume || resume.phase !== "checkpoint_failed" || this.professionalRun?.stopReason !== "CHECKPOINT_FAILED") {
      return { ok: false, error: "checkpoint 실패에 대한 선택을 기다리는 상태가 아닙니다." };
    }
    const choice = String(action || "").toLowerCase();
    if (choice === "cancel") {
      const transition = this.transitionProfessional({ type: "INTERRUPT", stopReason: "USER_INTERRUPTED" });
      if (!transition.ok) return this.professionalTransitionFailure("implementation", transition);
      this.specialistResume = null;
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem("전문 실행을 취소했습니다. Frozen Task는 실행되지 않았습니다.");
      return { ok: true, cancelled: true };
    }
    const transition = this.transitionProfessional({
      type: choice === "retry" ? "CHECKPOINT_RETRY" : choice === "proceed" ? "PROCEED_UNPROTECTED" : "UNKNOWN_CHECKPOINT_ACTION",
    });
    if (!transition.ok) return this.professionalTransitionFailure("implementation", transition);
    this.specialistResume = null;
    this.specialistActive = true;
    this.emitSpecialistState();
    try {
      return await this.runExecutionBlock({
        ...resume,
        runInfo: resume.runInfo,
        checkpointOverride: choice === "proceed" ? null : undefined,
        executionAlreadyTransitioned: choice === "proceed",
      });
    } finally {
      this.specialistActive = false;
      this.emitSpecialistState();
    }
  }

  // 기존 호출 경로는 유지합니다. action을 명시한 새 화면만 버튼형 전문 실행을 씁니다.`
);

// ---------------------------------------------------------------------------
// ChatRoom public state + same-author simplify model preservation.
// ---------------------------------------------------------------------------
replaceOnce(
  "src/chat/chat-room.js",
  `      implementationRound: professional?.implementationRound || 0,
    };`,
  `      implementationRound: professional?.implementationRound || 0,
      checkpointProtection: professional?.checkpointProtection || null,
      checkpointFailReason: professional?.checkpointFailReason || null,
      stopReason: professional?.stopReason || null,
    };`
);
replaceOnce(
  "src/chat/chat-room.js",
  `    if (this.isSpecialistLocked()) {
      throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
    }`,
  `    if (this.isSpecialistLocked() && !recordOnly) {
      throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
    }`
);
replaceOnce(
  "src/chat/chat-room.js",
  `      this.appendSystem(\`@\${target.id}에게 \${source.author}의 메시지를 알기 쉽게 풀어달라고 요청합니다.\`);
      this.scheduleResponse(target, { simplifyMeta });`,
  `      this.appendSystem(\`@\${target.id}에게 \${source.author}의 메시지를 알기 쉽게 풀어달라고 요청합니다.\`);
      const sourceAgentConfig = target.id === source.author
        ? {
            model: source.agentMeta?.model || target.model,
            effort: source.agentMeta?.effort || target.effort,
          }
        : null;
      this.scheduleResponse(target, { simplifyMeta, ...(sourceAgentConfig ? { agentConfig: sourceAgentConfig } : {}) });`
);

// ---------------------------------------------------------------------------
// IPC fail-closed policy and checkpoint choice endpoint.
// ---------------------------------------------------------------------------
replaceOnce(
  "src/chat/chat-ipc.js",
  `const { ChatRoom, DEFAULT_DISCUSSION_RUN_BUDGET } = require("./chat-room");`,
  `const { ChatRoom, DEFAULT_DISCUSSION_RUN_BUDGET } = require("./chat-room");
const { assertProfessionalAction, isOpenProfessionalRun } = require("./professional-ipc-policy");`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `  function requireRoom(sessionId) {
    const room = getRoom(sessionId);
    if (!room) throw new Error("세션을 찾을 수 없습니다.");
    return room;
  }`,
  `  function requireRoom(sessionId) {
    const room = getRoom(sessionId);
    if (!room) throw new Error("세션을 찾을 수 없습니다.");
    return room;
  }

  function requireProfessionalAction(room, action) {
    const checked = assertProfessionalAction(room?.professionalRun, action);
    if (!checked.ok) throw new Error(checked.error);
  }`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        if (room.isSpecialistLocked()) {
          throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
        }`,
  `        if (isOpenProfessionalRun(room.professionalRun)) {
          requireProfessionalAction(room, professionalDraft ? "recordOnly-send" : "send");
        } else if (room.isSpecialistLocked()) {
          throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
        }`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        const room = requireRoom(sessionId);
        room.interjectTurn();`,
  `        const room = requireRoom(sessionId);
        requireProfessionalAction(room, "interject");
        room.interjectTurn();`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        const room = requireRoom(sessionId);
        const result = await room.startDiscussion({ agentIds });`,
  `        const room = requireRoom(sessionId);
        requireProfessionalAction(room, "discussion");
        const result = await room.startDiscussion({ agentIds });`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        const room = requireRoom(sessionId);
        const result = room.handoffMessage(targetAgentId, messageId, intent);`,
  `        const room = requireRoom(sessionId);
        requireProfessionalAction(room, intent === "SIMPLIFY" ? "simplify" : "handoff");
        const result = room.handoffMessage(targetAgentId, messageId, intent);`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `        const room = requireRoom(sessionId);
        const result = await room.answerPlanQuestion(answer);`,
  `        const room = requireRoom(sessionId);
        requireProfessionalAction(room, "plan-answer");
        const result = await room.answerPlanQuestion(answer);`
);
replaceOnce(
  "src/chat/chat-ipc.js",
  `    ipcMain.handle(
      "chat:specialist:blocked",`,
  `    ipcMain.handle(
      "chat:specialist:checkpoint",
      wrap(async ({ sessionId, action }) => {
        requireWritable();
        const room = requireRoom(sessionId);
        requireProfessionalAction(room, "checkpoint-choice");
        const result = await room.resolveCheckpointFailure(action);
        return { ...result, meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:specialist:blocked",`
);

// preload endpoint
replaceOnce(
  "src/chat-preload.js",
  `  specialistPlanAnswer: (sessionId, answer) => ipcRenderer.invoke("chat:specialist:plan-answer", { sessionId, answer }),`,
  `  specialistPlanAnswer: (sessionId, answer) => ipcRenderer.invoke("chat:specialist:plan-answer", { sessionId, answer }),
  specialistCheckpoint: (sessionId, action) => ipcRenderer.invoke("chat:specialist:checkpoint", { sessionId, action }),`
);

// ---------------------------------------------------------------------------
// Renderer Stage 3/4/5: state-aware composer/status and easy-explain action.
// ---------------------------------------------------------------------------
replaceOnce(
  "src/chat.html",
  `            <div id="professional-progress" class="professional-progress" aria-label="전문 실행 진행 단계">`,
  `            <div id="professional-progress" class="professional-progress" aria-label="전문 실행 진행 단계">`
);
replaceOnce(
  "src/chat.html",
  `            </div>
            <div class="professional-auto-controls">`,
  `            </div>
            <span id="professional-status-detail" class="professional-status-detail"></span>
            <div class="professional-auto-controls">`
);

replaceOnce(
  "src/chat.js",
  `const professionalProgress = document.getElementById("professional-progress");`,
  `const professionalProgress = document.getElementById("professional-progress");
const professionalStatusDetail = document.getElementById("professional-status-detail");`
);
replaceOnce(
  "src/chat.js",
  `let specialistStatus = null;
let professionalModeEnabled = false;`,
  `let specialistStatus = null;
let specialistStopReason = null;
let specialistCheckpointProtection = null;
let specialistCheckpointFailReason = null;
let specialistFrozenRunId = null;
let professionalModeEnabled = false;`
);
replaceOnce(
  "src/chat.js",
  `  specialistStatus = state.status || null;
  specialistPlanTaskPath = state.planTaskPath || null;`,
  `  specialistStatus = state.status || null;
  specialistStopReason = state.stopReason || null;
  specialistCheckpointProtection = state.checkpointProtection || null;
  specialistCheckpointFailReason = state.checkpointFailReason || null;
  specialistFrozenRunId = state.frozenRunId || null;
  specialistPlanTaskPath = state.planTaskPath || null;`
);
replaceOnce(
  "src/chat.js",
  `  if (professionalProgress) {
    const indexByNode = {`,
  `  if (professionalStatusDetail) {
    const details = [];
    if (specialistPlanTaskId) details.push(specialistPlanTaskId);
    if (specialistFrozenRunId) details.push("Frozen: " + specialistFrozenRunId);
    if (specialistCheckpointProtection === "protected") details.push("Checkpoint ✓");
    else if (specialistCheckpointProtection === "unavailable_user_approved") details.push("Checkpoint ✗ (승인됨)");
    else if (specialistCheckpointProtection === "unavailable_non_git") details.push("Checkpoint ─ (non-Git)");
    else if (specialistCheckpointProtection === "unavailable_checkpoint_failed") details.push("Checkpoint ✗");
    professionalStatusDetail.textContent = details.join(" · ");
  }
  if (professionalProgress) {
    const indexByNode = {`
);
replaceOnce(
  "src/chat.js",
  `function renderSpecialistDialog(details = null) {
  specialistBody.textContent = "";
  const hint = document.createElement("p");
  hint.className = "specialist-missing";
  const reason = details?.blockReason || "BLOCKED";
  hint.textContent = \`전문 실행이 안전하게 중단되었습니다 (\${reason}). 현재 변경은 보존되어 있습니다. 다음 처리를 선택해 주세요.\`;
  specialistBody.append(hint);`,
  `function renderSpecialistDialog(details = null) {
  specialistBody.textContent = "";
  const hint = document.createElement("p");
  hint.className = "specialist-missing";
  const reason = details?.blockReason || specialistStopReason || "BLOCKED";
  if (reason === "CHECKPOINT_FAILED") {
    hint.textContent = "작업 전 checkpoint를 만들지 못했습니다 (" + (specialistCheckpointFailReason || "UNKNOWN") + "). 다음 처리를 선택해 주세요.";
    specialistBody.append(hint);
    renderCheckpointFailureActions(specialistBody);
    specialistCancelBtn.textContent = "닫기";
    return;
  }
  hint.textContent = \`전문 실행이 안전하게 중단되었습니다 (\${reason}). 현재 변경은 보존되어 있습니다. 다음 처리를 선택해 주세요.\`;
  specialistBody.append(hint);`
);
replaceOnce(
  "src/chat.js",
  `// 구현이 막혔을 때(BLOCKED) 고를 수 있는 후속 처리를 그립니다.`,
  `function renderCheckpointFailureActions(root) {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button button-primary";
  retry.textContent = "Checkpoint 다시 시도";
  retry.addEventListener("click", () => resolveCheckpointFailure("retry"));
  const proceed = document.createElement("button");
  proceed.type = "button";
  proceed.className = "button";
  proceed.textContent = "백업 없이 실행";
  proceed.title = "복원 지점 없이 실행합니다. Reviewer 결과의 신뢰도 제한이 Evidence에 기록됩니다.";
  proceed.addEventListener("click", () => resolveCheckpointFailure("proceed"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button";
  cancel.textContent = "취소";
  cancel.addEventListener("click", () => resolveCheckpointFailure("cancel"));
  root.append(retry, proceed, cancel);
}

async function resolveCheckpointFailure(action) {
  if (action === "proceed" && !window.confirm("checkpoint 없이 실행하시겠습니까? 자동 복원이 불가능하고 검수 신뢰도가 제한됩니다.")) return;
  closeSpecialistDialog();
  const result = await call(window.chatApi.specialistCheckpoint(activeSessionId, action));
  if (!result) return;
  if (result.meta) sessionMeta = result.meta;
  if (result.specialist) setSpecialistState(result.specialist);
  syncComposerLock();
  renderHeader();
}

// 구현이 막혔을 때(BLOCKED) 고를 수 있는 후속 처리를 그립니다.`
);

// Easy-explain direct action: same author agent, same model/effort when possible.
replaceOnce(
  "src/chat.js",
  `    actions.append(copyMarkdownBtn, copyPlainBtn);

    const handoffBtn = document.createElement("button");`,
  `    actions.append(copyMarkdownBtn, copyPlainBtn);

    const simplifyBtn = document.createElement("button");
    simplifyBtn.type = "button";
    simplifyBtn.className = "message-simplify-button";
    simplifyBtn.textContent = "💡 쉽게 설명";
    const sourceAgent = agentById(message.author);
    const simplifyTarget = sourceAgent?.available && sourceAgent?.enabled !== false
      ? sourceAgent
      : agents.find((entry) => entry.available && entry.enabled !== false) || null;
    const simplifyLocked = specialistRunning || specialistLocksComposer() ||
      (specialistNode && specialistNode !== "COMPLETED");
    simplifyBtn.disabled = simplifyLocked || !simplifyTarget;
    simplifyBtn.title = simplifyLocked
      ? "전문 실행 중에는 쉽게 설명을 실행할 수 없습니다"
      : "이 메시지를 작성한 AI가 같은 모델로 쉽게 풀어 설명합니다";
    simplifyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!simplifyTarget || simplifyBtn.disabled) return;
      simplifyBtn.disabled = true;
      try {
        await call(window.chatApi.handoffMessage(sessionMeta?.id, simplifyTarget.id, message.id, "SIMPLIFY"));
      } finally {
        simplifyBtn.disabled = false;
      }
    });
    actions.append(simplifyBtn);

    const handoffBtn = document.createElement("button");`
);

// State-aware composer placeholders. READY stays editable for plan amendments.
replaceOnce(
  "src/chat.js",
  `function lockComposer(locked) {
  composerInput.disabled = locked;
  sendButton.disabled = locked;
  attachButton.disabled = locked || specialistNeedsInput;
  if (specialistNeedsInput) {
    composerInput.placeholder = "기획자의 Open Question에 답하세요 (Enter 전송)";
    sendButton.textContent = "답변 보내기";
  } else {
    composerInput.placeholder = locked ? "전문 실행이 끝난 뒤 입력할 수 있습니다" : "질문이나 작업을 입력하세요  (@로 대상 지정 · Enter 전송)";
    sendButton.textContent = "전송";
  }
  if (locked) composerInput.blur();
}`,
  `function lockComposer(locked) {
  const readyEdit = professionalModeEnabled && specialistNode === "READY" && specialistStatus === "WAITING" && specialistStopReason === "PLAN_READY";
  const needsPlanInput = specialistNeedsInput || readyEdit;
  const effectiveLocked = locked && !readyEdit && !needsPlanInput;
  composerInput.disabled = effectiveLocked;
  sendButton.disabled = effectiveLocked;
  attachButton.disabled = effectiveLocked || needsPlanInput || professionalModeEnabled;
  if (needsPlanInput) {
    composerInput.placeholder = specialistNode === "READY"
      ? "기획을 수정하려면 변경사항을 입력하세요. '실행'으로 시작합니다"
      : specialistNode === "PLAN_REVIEW"
        ? "기획 검수 피드백에 대한 의견을 입력하세요"
        : "기획자의 질문에 답하세요";
    sendButton.textContent = specialistNode === "READY" ? "기획 수정" : "답변 보내기";
  } else if (professionalModeEnabled && !specialistNode) {
    composerInput.placeholder = "작업 요청을 입력하세요. PLAN 버튼으로 기획을 시작합니다";
    sendButton.textContent = "작업 요청 기록";
  } else if (professionalModeEnabled && specialistBlockedAvailable) {
    composerInput.placeholder = "아래에서 다음 처리를 선택하세요";
    sendButton.textContent = "전송";
  } else if (professionalModeEnabled && ["IMPLEMENTING", "REVIEWING", "RECORDING"].includes(specialistNode)) {
    composerInput.placeholder = "전문 실행 중입니다...";
    sendButton.textContent = "전송";
  } else {
    composerInput.placeholder = effectiveLocked ? "전문 실행이 끝난 뒤 입력할 수 있습니다" : "질문이나 작업을 입력하세요  (@로 대상 지정 · Enter 전송)";
    sendButton.textContent = "전송";
  }
  if (effectiveLocked) composerInput.blur();
}`
);

// CSS: reuse existing handoff treatment for the new action + status detail.
append("src/chat.css", `

.message-simplify-button {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 2px 4px;
}
.message-simplify-button:hover:not(:disabled) { color: var(--ink); }
.message-simplify-button:disabled { cursor: default; opacity: 0.45; }
.professional-status-detail {
  color: var(--muted);
  font-size: 11px;
  min-height: 1em;
}
`);

// ---------------------------------------------------------------------------
// Tests for the new policy/state contracts.
// ---------------------------------------------------------------------------
append("test/professional-run.test.js", `

test("checkpoint 실패/재시도/무보호 승인은 Frozen Run을 유지한다", () => {
  let run = createProfessionalRun({ node: "READY", status: "WAITING", approvedTaskHash: "h" });
  let result = transitionProfessionalRun(run, { type: "CHECKPOINT_FAILED", frozenRunId: "RUN-9", checkpointFailReason: "CHECKPOINT_COPY_FAILED" });
  assert.equal(result.ok, true);
  run = result.state;
  assert.equal(run.frozenRunId, "RUN-9");
  assert.equal(run.checkpointProtection, "unavailable_checkpoint_failed");
  assert.equal(run.checkpointFailReason, "CHECKPOINT_COPY_FAILED");
  result = transitionProfessionalRun(run, { type: "CHECKPOINT_RETRY" });
  assert.equal(result.ok, true);
  assert.equal(result.state.frozenRunId, "RUN-9");
  assert.equal(result.state.node, "READY");
  assert.equal(result.state.status, "RUNNING");

  result = transitionProfessionalRun(result.state, { type: "CHECKPOINT_FAILED", frozenRunId: "RUN-9", checkpointFailReason: "CHECKPOINT_GIT_FAILED" });
  run = result.state;
  result = transitionProfessionalRun(run, { type: "PROCEED_UNPROTECTED" });
  assert.equal(result.ok, true);
  assert.equal(result.state.node, "IMPLEMENTING");
  assert.equal(result.state.frozenRunId, "RUN-9");
  assert.equal(result.state.checkpointProtection, "unavailable_user_approved");
});

test("READY에서 사용자 기획 수정은 승인 hash를 무효화하고 PLANNING으로 돌아간다", () => {
  const run = createProfessionalRun({ node: "READY", status: "WAITING", stopReason: "PLAN_READY", approvedTaskHash: "approved" });
  const result = transitionProfessionalRun(run, { type: "USER_ANSWER_PLAN" });
  assert.equal(result.ok, true);
  assert.equal(result.state.node, "PLANNING");
  assert.equal(result.state.status, "RUNNING");
  assert.equal(result.state.approvedTaskHash, null);
});
`);

write("test/professional-ipc-policy.test.js", `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { professionalActionAllowed, isOpenProfessionalRun } = require("../src/chat/professional-ipc-policy");

test("active Professional run blocks ordinary chat/discussion/handoff/simplify", () => {
  const run = { node: "IMPLEMENTING", status: "RUNNING" };
  assert.equal(isOpenProfessionalRun(run), true);
  for (const action of ["send", "discussion", "handoff", "simplify", "interject"]) {
    assert.equal(professionalActionAllowed(run, action), false, action);
  }
  assert.equal(professionalActionAllowed(run, "cancel"), true);
});

test("READY allows plan amendment/start but not ordinary broadcast", () => {
  const run = { node: "READY", status: "WAITING" };
  assert.equal(professionalActionAllowed(run, "plan-answer"), true);
  assert.equal(professionalActionAllowed(run, "start"), true);
  assert.equal(professionalActionAllowed(run, "send"), false);
});

test("completed Professional run no longer blocks ordinary actions", () => {
  const run = { node: "COMPLETED", status: "COMPLETED" };
  assert.equal(professionalActionAllowed(run, "send"), true);
  assert.equal(professionalActionAllowed(run, "simplify"), true);
});
`);

write("test/professional-role-context.test.js", `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { roleContextPolicy, roleContextPromptLines } = require("../src/chat/professional-role-context");

test("Builder와 Reviewer는 clean-room transcript 정책을 공유한다", () => {
  assert.equal(roleContextPolicy("implementation").transcript, "none");
  assert.equal(roleContextPolicy("review").transcript, "none");
  assert.ok(roleContextPolicy("implementation").sees.includes("Frozen Task"));
  assert.ok(roleContextPolicy("review").sees.includes("Evidence"));
});

test("Plan Reviewer는 사용자 메시지만 transcript로 본다", () => {
  assert.equal(roleContextPolicy("plan_review").transcript, "user");
  assert.ok(roleContextPromptLines("plan_review").some((line) => line.includes("참고 입력")));
});
`);

append("test/chat-professional-evidence.test.js", `

test("checkpointProtection enum은 Professional evidence payload에 포함된다", () => {
  const payload = buildProfessionalEvidencePayload({ checkpointProtection: "unavailable_user_approved" });
  assert.equal(payload.checkpointProtection, "unavailable_user_approved");
});
`);

// Stage 2 design contract sync.
replaceOnce(
  "docs/design/AGORA_V1_DESIGN.md",
  `## Goal
...

## Requirements
...

## Constraints
...

## Acceptance Criteria
...

## Out of Scope
...

## Open Questions / Risks
...`,
  `## Goal
...

## Requirements
...

## Implementation Approach
...

## Acceptance Criteria
...

## Verification
...

## Out of Scope
...

권장 섹션: Current State / Evidence, Affected Modules, Invariants / Must Preserve, Risks / Open Questions, Dependencies / Related Tasks.`
);

console.log("Professional stabilization transform applied successfully.");
