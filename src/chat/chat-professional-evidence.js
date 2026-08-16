"use strict";

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function executionAxes({ builderResult = null, diff = null } = {}) {
  const evidence = builderResult?.evidence || {};
  const commands = Array.isArray(evidence.commands) ? evidence.commands : [];
  const summaryTotal = nonNegativeInteger(evidence.commandSummary?.total, 0);
  const hasFinished = summaryTotal > 0 || commands.some(
    (entry) => entry?.kind === "command-finished" || Number.isInteger(entry?.exitCode)
  );
  return {
    transport: builderResult?.transport || "COMPLETED",
    declaration: builderResult?.builderStatus || "MISSING",
    changes: diff?.status || "UNSUPPORTED",
    execution: hasFinished ? "OBSERVED" : commands.length > 0 ? "PARTIAL" : "UNAVAILABLE",
  };
}

function buildProfessionalEvidencePayload({ builderResult = null, diff = null, round = 1, provider = null } = {}) {
  const axes = executionAxes({ builderResult, diff });
  const evidence = builderResult?.evidence || {};
  const allCommands = (Array.isArray(evidence.commands) ? evidence.commands : [])
    .filter((entry) => entry?.kind === "command-finished" || Number.isInteger(entry?.exitCode))
    .map((entry) => ({ ...entry }));
  const commands = allCommands.slice(0, 20);
  const sourceSummary = evidence.commandSummary || {};
  const total = Math.max(
    allCommands.length,
    nonNegativeInteger(sourceSummary.total, allCommands.length)
  );
  const failed = Number.isInteger(sourceSummary.failed)
    ? nonNegativeInteger(sourceSummary.failed)
    : allCommands.filter((entry) => Number.isInteger(entry.exitCode) && entry.exitCode !== 0).length;
  const truncated = Number.isInteger(sourceSummary.truncated)
    ? nonNegativeInteger(sourceSummary.truncated)
    : allCommands.filter((entry) => entry.truncated).length;

  return {
    schemaVersion: 2,
    round: round || 1,
    invocationId: builderResult?.runId || null,
    provider: provider || null,
    source: { kind: "provider-event", provider: provider || null },
    ...axes,
    sessionPersisted: builderResult?.evidencePersisted !== false,
    commands,
    commandSummary: {
      total,
      included: commands.length,
      omitted: Math.max(0, total - commands.length),
      failed,
      truncated,
    },
    ...(evidence.toolSummary ? { toolSummary: evidence.toolSummary } : {}),
    ...(evidence.exploration ? { exploration: evidence.exploration } : {}),
  };
}

module.exports = {
  executionAxes,
  buildProfessionalEvidencePayload,
};
