"use strict";

const MAX_CHANGED_FILES = 50;
const MAX_FILE_PATH_CHARS = 300;

function cleanLine(value, limit = 300) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, limit);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function changedFilesFromDiff(diffText, limit = MAX_CHANGED_FILES) {
  const text = String(diffText || "");
  const seen = new Set();
  const files = [];

  const remember = (value) => {
    const file = cleanLine(value, MAX_FILE_PATH_CHARS);
    if (!file || file === "/dev/null" || seen.has(file)) return;
    seen.add(file);
    if (files.length < limit) files.push(file);
  };

  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    remember(match[2]);
  }
  for (const match of text.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    remember(match[1]);
  }

  return files;
}

function evidenceFacts(evidence = {}) {
  const commandSummary = evidence?.commandSummary || {};
  const toolSummary = evidence?.toolSummary || {};
  const exploration = evidence?.exploration || {};
  return {
    transport: cleanLine(evidence?.transport || "UNAVAILABLE", 40) || "UNAVAILABLE",
    declaration: cleanLine(evidence?.declaration || "UNAVAILABLE", 40) || "UNAVAILABLE",
    changes: cleanLine(evidence?.changes || "UNSUPPORTED", 40) || "UNSUPPORTED",
    execution: cleanLine(evidence?.execution || "UNAVAILABLE", 40) || "UNAVAILABLE",
    commands: {
      total: nonNegativeInteger(commandSummary.total),
      failed: nonNegativeInteger(commandSummary.failed),
      truncated: nonNegativeInteger(commandSummary.truncated),
    },
    tools: {
      started: nonNegativeInteger(toolSummary.started),
      finished: nonNegativeInteger(toolSummary.finished),
      failed: nonNegativeInteger(toolSummary.failed),
      truncated: nonNegativeInteger(toolSummary.truncated),
      outputBytes: nonNegativeInteger(toolSummary.outputBytes),
      uniqueTargets: nonNegativeInteger(toolSummary.uniqueTargets),
      repeatedCalls: nonNegativeInteger(toolSummary.repeatedCalls),
      maxRepeatCount: nonNegativeInteger(toolSummary.maxRepeatCount),
    },
    exploration: {
      status: ["NORMAL", "WARNING", "LOOP_DETECTED"].includes(exploration.status)
        ? exploration.status
        : "NORMAL",
      reason: exploration.reason ? cleanLine(exploration.reason, 80) : null,
    },
  };
}

function buildDeterministicRecorderOutput({
  runId = null,
  taskId = null,
  taskHash = null,
  finalVerdict = "PASS",
  round = 1,
  reviewDiff = "",
  evidence = null,
} = {}) {
  const verdict = cleanLine(finalVerdict || "UNKNOWN", 40) || "UNKNOWN";
  const facts = evidenceFacts(evidence || {});
  const changedFiles = changedFilesFromDiff(reviewDiff);
  const safeRunId = runId ? cleanLine(runId, 128) : null;
  const safeTaskId = taskId ? cleanLine(taskId, 128) : null;
  const safeTaskHash = taskHash ? cleanLine(taskHash, 128) : null;
  const safeRound = Number.isInteger(round) && round > 0 ? round : 1;

  const lines = ["## 전문 실행 결과"];
  if (safeRunId) lines.push(`- Run: ${safeRunId}`);
  if (safeTaskId) lines.push(`- Task: ${safeTaskId}`);
  if (safeTaskHash) lines.push(`- Frozen Task hash: ${safeTaskHash}`);
  lines.push(`- 최종 판정: ${verdict}`);
  lines.push(`- 구현 라운드: ${safeRound}`);
  lines.push(`- 실행 상태: transport=${facts.transport}, declaration=${facts.declaration}, changes=${facts.changes}, execution=${facts.execution}`);
  lines.push(`- 명령 실행: ${facts.commands.total}회 · 실패 ${facts.commands.failed}회 · 잘림 ${facts.commands.truncated}회`);
  lines.push(`- 도구 탐색: 시작 ${facts.tools.started}회 · 실패 ${facts.tools.failed}회 · 고유 target ${facts.tools.uniqueTargets}개 · 반복 호출 ${facts.tools.repeatedCalls}회`);
  lines.push(`- 탐색 상태: ${facts.exploration.status}${facts.exploration.reason ? ` (${facts.exploration.reason})` : ""}`);

  if (changedFiles.length > 0) {
    lines.push("");
    lines.push("## 변경 파일");
    for (const file of changedFiles) lines.push(`- ${file}`);
  }

  lines.push("");
  lines.push("## 기록 범위");
  lines.push("- 이 기록은 Frozen Task, 실제 변경 상태, 최종 검수 판정과 구조화 Evidence에서 결정론적으로 생성되었습니다.");
  lines.push("- 상세 diff와 command/tool 원문은 해당 Run의 evidence 및 실행 로그를 참조합니다.");
  lines.push("- transcript를 보지 않았으므로 새로운 결정이나 다음 할 일을 추론해 만들지 않았습니다.");

  return {
    summary: lines.join("\n"),
    decisions: [],
    nextActions: [],
    provenance: {
      kind: "deterministic-professional-recorder",
      schemaVersion: 1,
      runId: safeRunId,
      taskId: safeTaskId,
      taskHash: safeTaskHash,
      finalVerdict: verdict,
      round: safeRound,
      changedFiles,
      facts,
    },
  };
}

function serializeDeterministicRecorderOutput(input = {}) {
  const output = buildDeterministicRecorderOutput(input);
  return JSON.stringify({
    summary: output.summary,
    decisions: output.decisions,
    nextActions: output.nextActions,
  });
}

module.exports = {
  buildDeterministicRecorderOutput,
  serializeDeterministicRecorderOutput,
  changedFilesFromDiff,
  evidenceFacts,
  MAX_CHANGED_FILES,
};
