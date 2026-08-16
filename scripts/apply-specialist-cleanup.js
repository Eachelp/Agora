const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const specialistPath = path.join(root, "src", "chat", "chat-specialist.js");
const roomPath = path.join(root, "src", "chat", "chat-room.js");
const workflowPath = path.join(root, ".github", "workflows", "specialist-cleanup.yml");

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`${label}: expected source block not found`);
  if (text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block appears more than once`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

let specialist = fs.readFileSync(specialistPath, "utf8");
let room = fs.readFileSync(roomPath, "utf8");

if (specialist.includes('"PROTOCOL_FINAL_MISSING"')) {
  throw new Error("chat-specialist already contains PROTOCOL_FINAL_MISSING; aborting guarded cleanup");
}

specialist = replaceOnce(
  specialist,
  'const { describeWorkspaceChanges } = require("../agora/workspace-diff");\n',
  'const { describeWorkspaceChanges } = require("../agora/workspace-diff");\nconst {\n  executionAxes: professionalExecutionAxes,\n  buildProfessionalEvidencePayload,\n} = require("./chat-professional-evidence");\n',
  "specialist evidence import"
);

specialist = replaceOnce(
  specialist,
  '  "PROMPT_BUDGET_EXCEEDED",\n',
  '  "PROMPT_BUDGET_EXCEEDED",\n  "PROTOCOL_FINAL_MISSING",\n',
  "safe block reason"
);

const oldMethods = `  executionAxes({ builderResult = null, diff = null } = {}) {\n    const commands = builderResult?.evidence?.commands || [];\n    const hasFinished = commands.some((entry) => entry?.kind === "command-finished" || Number.isInteger(entry?.exitCode));\n    return {\n      transport: builderResult?.transport || "COMPLETED",\n      declaration: builderResult?.builderStatus || "MISSING",\n      changes: diff?.status || "UNSUPPORTED",\n      execution: hasFinished ? "OBSERVED" : commands.length > 0 ? "PARTIAL" : "UNAVAILABLE",\n    };\n  }\n\n  evidencePayload({ runInfo, builderResult, diff, round, provider }) {\n    const axes = this.executionAxes({ builderResult, diff });\n    const allCommands = (builderResult?.evidence?.commands || [])\n      .filter((entry) => entry?.kind === "command-finished" || Number.isInteger(entry?.exitCode))\n      .map((entry) => ({ ...entry }));\n    const commands = allCommands.slice(0, 20);\n    const payload = {\n      schemaVersion: 2,\n      round: round || 1,\n      invocationId: builderResult?.runId || null,\n      provider: provider || null,\n      source: { kind: "provider-event", provider: provider || null },\n      ...axes,\n      sessionPersisted: builderResult?.evidencePersisted !== false,\n      commands,\n      commandSummary: {\n        total: allCommands.length,\n        included: commands.length,\n        omitted: Math.max(0, allCommands.length - commands.length),\n        failed: allCommands.filter((entry) => Number.isInteger(entry.exitCode) && entry.exitCode !== 0).length,\n        truncated: allCommands.filter((entry) => entry.truncated).length,\n      },\n    };\n    if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };\n    const ok = this.taskManager.writeRunEvidence(runInfo, payload);\n    return ok ? { ok: true, payload } : { ok: false, payload };\n  }\n`;

const newMethods = `  executionAxes(options = {}) {\n    return professionalExecutionAxes(options);\n  }\n\n  evidencePayload(options = {}) {\n    const payload = buildProfessionalEvidencePayload(options);\n    const runInfo = options.runInfo || null;\n    if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };\n    const ok = this.taskManager.writeRunEvidence(runInfo, payload);\n    return ok ? { ok: true, payload } : { ok: false, payload };\n  }\n`;

specialist = replaceOnce(specialist, oldMethods, newMethods, "specialist evidence delegation");

room = replaceOnce(
  room,
  '  installSpecialistMethods,\n  SAFE_BLOCK_REASONS,\n  safeBlockReason,\n',
  '  installSpecialistMethods,\n  safeBlockReason,\n',
  "room SAFE_BLOCK_REASONS import"
);

room = replaceOnce(
  room,
  'const {\n  executionAxes: professionalExecutionAxes,\n  buildProfessionalEvidencePayload,\n} = require("./chat-professional-evidence");\n',
  "",
  "room evidence import"
);

room = replaceOnce(
  room,
  '// Runner가 새로 반환하는 protocol failure를 기존 specialist fail-closed 경로에서도\n// 일반 EXECUTION_BLOCKED로 뭉개지 않고 정확한 원인으로 보존합니다. exported Set은\n// chat-specialist 내부 safeBlockReason()이 참조하는 동일 객체입니다.\nSAFE_BLOCK_REASONS.add("PROTOCOL_FINAL_MISSING");\n\n',
  "",
  "room global Set mutation"
);

room = replaceOnce(
  room,
  '\n// Stage B: specialist FSM 자체는 그대로 두고 evidence shaping만 provider-neutral\n// 모듈로 교체합니다. Reviewer와 Run evidence가 같은 payload를 보게 하는 단일 경계입니다.\nChatRoom.prototype.executionAxes = function executionAxes(options = {}) {\n  return professionalExecutionAxes(options);\n};\n\nChatRoom.prototype.evidencePayload = function evidencePayload(options = {}) {\n  const payload = buildProfessionalEvidencePayload(options);\n  const runInfo = options.runInfo || null;\n  if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };\n  const ok = this.taskManager.writeRunEvidence(runInfo, payload);\n  return ok ? { ok: true, payload } : { ok: false, payload };\n};\n',
  "",
  "room prototype evidence override"
);

fs.writeFileSync(specialistPath, specialist, "utf8");
fs.writeFileSync(roomPath, room, "utf8");

// This helper is intentionally one-shot. Keep the final tree free of migration machinery.
for (const cleanupPath of [__filename, workflowPath]) {
  if (fs.existsSync(cleanupPath)) fs.unlinkSync(cleanupPath);
}

console.log("Applied guarded specialist cleanup and removed one-shot migration files.");
