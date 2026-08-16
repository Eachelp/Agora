"use strict";

const fs = require("node:fs");

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRegexOnce(source, pattern, replacement, label) {
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`}`));
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, got ${matches?.length || 0}`);
  }
  return source.replace(pattern, replacement);
}

const specialistPath = "src/chat/chat-specialist.js";
let specialist = fs.readFileSync(specialistPath, "utf8");

specialist = replaceOnce(
  specialist,
  'const { describeWorkspaceChanges } = require("../agora/workspace-diff");\n',
  'const { describeWorkspaceChanges } = require("../agora/workspace-diff");\nconst {\n  executionAxes: professionalExecutionAxes,\n  buildProfessionalEvidencePayload,\n} = require("./chat-professional-evidence");\n',
  "specialist evidence import"
);

specialist = replaceOnce(
  specialist,
  '  "OUTPUT_LIMITED",\n  "EXECUTION_BLOCKED",',
  '  "OUTPUT_LIMITED",\n  "PROTOCOL_FINAL_MISSING",\n  "EXECUTION_BLOCKED",',
  "protocol final safe reason"
);

specialist = replaceRegexOnce(
  specialist,
  /  executionAxes\([\s\S]*?\n  prepareReviewEvidence\(/,
  `  executionAxes(options = {}) {\n    return professionalExecutionAxes(options);\n  }\n\n  evidencePayload(options = {}) {\n    const payload = buildProfessionalEvidencePayload(options);\n    const runInfo = options.runInfo || null;\n    if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };\n    const ok = this.taskManager.writeRunEvidence(runInfo, payload);\n    return ok ? { ok: true, payload } : { ok: false, payload };\n  }\n\n  prepareReviewEvidence(`,
  "specialist evidence methods"
);

fs.writeFileSync(specialistPath, specialist, "utf8");

const roomPath = "src/chat/chat-room.js";
let room = fs.readFileSync(roomPath, "utf8");
room = replaceOnce(
  room,
  '  installSpecialistMethods,\n  SAFE_BLOCK_REASONS,\n  safeBlockReason,',
  '  installSpecialistMethods,\n  safeBlockReason,',
  "room SAFE_BLOCK_REASONS import"
);
room = replaceOnce(
  room,
  'const {\n  executionAxes: professionalExecutionAxes,\n  buildProfessionalEvidencePayload,\n} = require("./chat-professional-evidence");\n',
  "",
  "room evidence import"
);
room = replaceRegexOnce(
  room,
  /\/\/ Runner가 새로 반환하는 protocol failure[\s\S]*?SAFE_BLOCK_REASONS\.add\("PROTOCOL_FINAL_MISSING"\);\n\n/,
  "",
  "room set mutation"
);
room = replaceRegexOnce(
  room,
  /\n\/\/ Stage B: specialist FSM 자체는 그대로 두고 evidence shaping만 provider-neutral[\s\S]*?\n};\n?$/,
  "\n",
  "room evidence overrides"
);
fs.writeFileSync(roomPath, room, "utf8");

console.log("Stage B cleanup replacements applied successfully.");
