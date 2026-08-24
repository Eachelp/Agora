"use strict";

const fs = require("node:fs");
const {
  commandStarted,
  commandFinished,
  toolStarted,
  toolFinished,
} = require("../../chat/chat-events");
const { createRunTelemetry } = require("../../chat/chat-run-telemetry");

// Stage C-3 — Codex App Server v2 이벤트 정규화 + turn permission 매핑.
//
// 이 모듈은 CodexManagedAdapter 아래에만 존재하는 provider-specific 코드다. 상위
// control plane(chat-ipc / Professional FSM)로 App Server 고유 이벤트 이름을 노출하지
// 않는다. 방향: Codex v2 notification -> Agora canonical event.
//
// 기존 parseCodexLine(codex exec --json one-shot)은 건드리지 않는다. canonical event
// shape는 chat-events.js의 builder를 재사용해 single source로 유지한다.

// ---- permission mapping (pure) --------------------------------------------
//
// 설치 스키마(codex 0.147.0) 기준:
//   turn/start.sandboxPolicy(SandboxPolicy union):
//     { type:"readOnly", networkAccess?:false }
//     { type:"workspaceWrite", writableRoots?:[], networkAccess?:false }
//     { type:"dangerFullAccess" }
//   turn/start.approvalPolicy(AskForApproval): "untrusted"|"on-request"|"never"|{granular}
//
// Agora permission -> Codex turn policy. 새 App Server 경로가 기존 codexArgv one-shot
// (read-only / workspace-write --cd / --dangerously-bypass-approvals-and-sandbox)보다
// 더 넓은 권한을 갖지 않도록 equivalent-or-more-restrictive로 매핑한다.
//   - approvalPolicy는 항상 "never": Agora는 turn 도중 대화형 승인을 하지 않는다.
//     승인은 기존 compatibility(approvalRequired -> whole-turn retry)로 처리한다.
//   - chat: cwd는 chat runtime dir(invocation.cwd) 유지. workspace를 cwd로 노출하지 않음.
//   - workspace-read/write: realpath(cwd) === context.workspaceId 검증. 불일치 fail-closed.

class CodexPolicyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "CodexPolicyError";
    this.code = code;
  }
}

function mapCodexTurnPolicy(input = {}, deps = {}) {
  const realpath = typeof deps.realpath === "function" ? deps.realpath : fs.realpathSync;
  const permissionMode = input.permissionMode;
  const autoApprove = Boolean(input.autoApprove);
  const interactiveApproval = Boolean(input.interactiveApproval);
  const cwd = input.cwd;
  const workspaceId = input.workspaceId || null;

  if (!cwd) {
    throw new CodexPolicyError("CODEX_TURN_START_FAILED", "실행 cwd가 없습니다.");
  }

  // 기본: turn 도중 대화형 승인을 하지 않는다(read-only 단계·autoApprove·승인 콜백 부재).
  const approvalPolicy = "never";

  if (permissionMode === "chat") {
    // workspace를 cwd로 노출하지 않는다(Recorder 등 chat permission 포함). read-only 단계는
    // 승인 UI를 통해 workspace-write로 승격되지 않는다(approvalPolicy never 고정).
    return { cwd, approvalPolicy, sandboxPolicy: { type: "readOnly" } };
  }

  if (permissionMode !== "workspace-read" && permissionMode !== "workspace-write") {
    throw new CodexPolicyError("CODEX_PERMISSION_INVALID", `알 수 없는 권한 모드: ${permissionMode}`);
  }

  // workspace 모드: cwd의 realpath identity가 control plane workspaceId와 일치해야 한다.
  if (!workspaceId) {
    throw new CodexPolicyError("CODEX_WORKSPACE_MISMATCH", "workspace identity가 없습니다.");
  }
  let resolved;
  try {
    resolved = realpath(cwd);
  } catch (error) {
    throw new CodexPolicyError("CODEX_WORKSPACE_MISMATCH", `cwd realpath 실패: ${error?.message || error}`);
  }
  if (resolved !== workspaceId) {
    throw new CodexPolicyError("CODEX_WORKSPACE_MISMATCH", "cwd realpath가 workspace identity와 일치하지 않습니다.");
  }

  if (permissionMode === "workspace-read") {
    // read-only 단계(Planner/Reviewer 등)는 승인 escalation을 열지 않는다.
    return { cwd, approvalPolicy, sandboxPolicy: { type: "readOnly" } };
  }
  // workspace-write
  if (autoApprove) {
    // 기존 --dangerously-bypass-approvals-and-sandbox 등가(danger/full-access 유지).
    return { cwd, approvalPolicy, sandboxPolicy: { type: "dangerFullAccess" } };
  }
  if (interactiveApproval) {
    // workspace-write + autoApprove=false + 사용자 승인 콜백 존재: Codex가 실행 중 특정
    // action 승인을 요청할 수 있게 on-request로 연다(설치 스키마 AskForApproval). 승인은
    // 항상 Agora 사용자에게 route한다(approvalsReviewer="user"). sandbox는 danger가 아니라
    // workspaceWrite 그대로다(승인은 sandbox 우회가 아니라 provider가 요청한 개별 escalation).
    return {
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
    };
  }
  // workspace-write지만 사용자 승인 콜백이 없다: fail-safe. 승인 요청을 조용히 자동 승인하지
  // 않도록 approvalPolicy를 never로 유지한다(요청이 와도 adapter가 safe-decline).
  return {
    cwd,
    approvalPolicy,
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
  };
}

// ---- server -> client approval requests: 안전한 deny 응답 --------------------
//
// 설치 스키마의 decision enum:
//   item/commandExecution/requestApproval -> { decision: "cancel" }  (deny + turn 중단)
//   item/fileChange/requestApproval       -> { decision: "cancel" }
//   execCommandApproval / applyPatchApproval(legacy) -> { decision: "abort" }
//   item/permissions/requestApproval      -> { permissions: {} }     (추가 권한 없음)
//   item/tool/requestUserInput            -> { answers: [] }
//   mcpServer/elicitation/request         -> { action: "cancel" }
// approvalPolicy="never"면 정상적으론 오지 않지만, 방어적으로 항상 deny한다.
function denyResponseFor(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "cancel" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "abort" };
    case "item/permissions/requestApproval":
      // 설치 스키마 PermissionsRequestApprovalResponse는 { permissions, scope } 필수.
      // 어떤 추가 권한도 grant하지 않고(빈 profile) turn scope로 fail-closed한다(§ granular
      // permission UI는 별도 future scope). session-persistent grant를 임의 생성하지 않는다.
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: [] };
    case "mcpServer/elicitation/request":
      return { action: "cancel" };
    default:
      return {};
  }
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

function isApprovalRequest(method) {
  return APPROVAL_METHODS.has(method);
}

function boundedText(value, limit = 2000) {
  const text = value == null ? "" : (typeof value === "string" ? value : JSON.stringify(value));
  return text.length > limit ? text.slice(0, limit) : text;
}

// approval request params에서 사용자 판단에 필요한 최소 정보만 뽑는다(bounded).
function approvalSummaryFrom(method, params = {}) {
  const p = params || {};
  const command = Array.isArray(p.command) ? p.command.join(" ") : p.command;
  const summaryParts = [];
  if (command) summaryParts.push(`명령: ${boundedText(command, 200)}`);
  if (p.cwd) summaryParts.push(`위치: ${boundedText(p.cwd, 200)}`);
  const summary = summaryParts.length > 0
    ? summaryParts.join(" · ")
    : (method.includes("fileChange") ? "파일 변경 승인이 필요합니다." : "도구 실행 권한이 필요합니다.");
  const detailParts = [];
  if (p.reason) detailParts.push(`사유: ${boundedText(p.reason)}`);
  if (command) detailParts.push(`명령: ${boundedText(command)}`);
  if (p.cwd) detailParts.push(`위치: ${boundedText(p.cwd, 400)}`);
  return { summary: boundedText(summary, 300), detail: boundedText(detailParts.join("\n"), 2000) };
}

// 지원되는 same-turn approval 분류(설치 스키마 ServerRequest union 기준):
//   command : item/commandExecution/requestApproval  (사용자 same-turn 승인 대상)
//   file    : item/fileChange/requestApproval          (사용자 same-turn 승인 대상)
//   permissions : item/permissions/requestApproval     (granular grant; boolean 아님 → safe-deny)
//   legacy  : execCommandApproval / applyPatchApproval  (v1; 기존 safe-deny 유지)
//   other   : 승인이 아닌 infra 요청(user-input/elicitation/tool-call/attestation 등)
function classifyApprovalRequest(method) {
  switch (method) {
    case "item/commandExecution/requestApproval": return "command";
    case "item/fileChange/requestApproval": return "file";
    case "item/permissions/requestApproval": return "permissions";
    case "execCommandApproval":
    case "applyPatchApproval": return "legacy";
    default: return "other";
  }
}

// command/file approval의 one-shot decision 응답(설치 스키마 Command/FileChangeApprovalDecision):
//   approve ONE action = "accept", deny ONE action = "decline", whole-turn = "cancel".
//   "acceptForSession"(session-persistent)은 일반 승인 버튼에 매핑하지 않는다.
function approvalDecisionResponse(method, decision) {
  const cls = classifyApprovalRequest(method);
  if (cls !== "command" && cls !== "file") return null;
  const allowed = decision === "accept" || decision === "decline" || decision === "cancel";
  return { decision: allowed ? decision : "decline" };
}

// 사용자에게 보여줄 bounded approval view. command는 request params(command/cwd/reason)에서,
// file은 request params(reason) + item context(변경 경로)에서 만든다. usable=false면 무엇을
// 승인하는지 안전하게 설명할 수 없다는 뜻이라 blind approve UI를 띄우지 않는다(safe decline).
function buildApprovalView(method, params = {}, itemContext = null) {
  const cls = classifyApprovalRequest(method);
  const p = params || {};
  if (cls === "command") {
    const command = Array.isArray(p.command) ? p.command.join(" ") : p.command;
    const cmd = command || (itemContext && itemContext.command) || null;
    const cwd = p.cwd || (itemContext && itemContext.cwd) || null;
    const summaryParts = [];
    if (cmd) summaryParts.push(`명령: ${boundedText(cmd, 200)}`);
    if (cwd) summaryParts.push(`위치: ${boundedText(cwd, 200)}`);
    const detailParts = [];
    if (p.reason) detailParts.push(`사유: ${boundedText(p.reason)}`);
    if (cmd) detailParts.push(`명령: ${boundedText(cmd)}`);
    if (cwd) detailParts.push(`위치: ${boundedText(cwd, 400)}`);
    return {
      usable: Boolean(cmd || (Array.isArray(p.commandActions) && p.commandActions.length)),
      summary: boundedText(summaryParts.join(" · ") || "명령 실행 승인이 필요합니다.", 300),
      detail: boundedText(detailParts.join("\n"), 2000),
    };
  }
  if (cls === "file") {
    const paths = itemContext && Array.isArray(itemContext.paths) ? itemContext.paths : [];
    const usable = paths.length > 0;
    const shown = paths.slice(0, 20);
    const more = paths.length > shown.length ? ` 외 ${paths.length - shown.length}개` : "";
    const detailParts = [];
    if (p.reason) detailParts.push(`사유: ${boundedText(p.reason)}`);
    if (usable) detailParts.push(`변경 파일:\n${shown.map((x) => `- ${boundedText(x, 300)}`).join("\n")}${more}`);
    return {
      usable,
      summary: boundedText(usable ? `파일 변경 승인: ${paths.length}개 파일` : "파일 변경 승인이 필요합니다.", 300),
      detail: boundedText(detailParts.join("\n"), 2000),
    };
  }
  return { usable: false, summary: "", detail: "" };
}

// ---- turn event collector --------------------------------------------------
//
// 한 turn(=한 thread의 활성 turn)의 v2 notification을 canonical event로 변환하고
// evidence/final/delta/error를 모은다. 상위 adapter가 threadId로 이미 필터링해서
// 넣어 주므로 여기서는 role leakage를 걱정하지 않는다(collector는 turn 전용).

function toolNameForItem(item) {
  if (!item || typeof item !== "object") return "tool";
  return String(item.tool || item.name || item.server || item.type || "tool");
}
function toolInputForItem(item) {
  if (!item || typeof item !== "object") return null;
  return item.input ?? item.arguments ?? item.query ?? item.command ?? item.path ?? null;
}

function createCodexTurnCollector({ onEvent } = {}) {
  const emitEvent = typeof onEvent === "function" ? onEvent : () => {};
  const telemetry = createRunTelemetry();
  const commandEvents = [];
  const pendingItems = new Map(); // itemId -> started canonical event
  let deltaText = "";
  let trustedFinal = null;
  let lastError = null;

  function emit(event) {
    if (!event) return;
    telemetry.observe(event);
    if (event.kind === "delta") deltaText += event.text || "";
    if (event.kind === "command-started" || event.kind === "command-finished") {
      commandEvents.push(event);
      if (commandEvents.length > 80) commandEvents.splice(0, commandEvents.length - 80);
    }
    emitEvent(event);
  }

  const itemContext = new Map(); // itemId -> bounded { kind, command?, paths?, status? } (approval detail 용)

  function captureItemContext(item) {
    if (!item || typeof item !== "object" || !item.id) return;
    if (item.type === "commandExecution") {
      const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
      itemContext.set(item.id, { kind: "command", command: command ? boundedText(command, 2000) : null });
      return;
    }
    if (item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => (c && typeof c.path === "string" ? c.path : null))
        .filter(Boolean)
        .slice(0, 50);
      itemContext.set(item.id, { kind: "file", paths, status: item.status || null });
    }
  }

  function startItem(item) {
    if (!item || typeof item !== "object") return;
    captureItemContext(item);
    const type = item.type;
    if (type === "commandExecution") {
      const ev = commandStarted(item.command, item.id || null);
      if (item.id) pendingItems.set(item.id, ev);
      emit(ev);
      return;
    }
    if (type === "reasoning") {
      emit({ kind: "status", label: "생각 중" });
      return;
    }
    if (type === "agentMessage" || type === "userMessage" || type === "plan") return;
    // 기타 도구성 item(mcpToolCall/dynamicToolCall/fileChange/webSearch 등): 관측용 tool 이벤트.
    const ev = toolStarted({ tool: toolNameForItem(item), input: toolInputForItem(item), toolUseId: item.id || null });
    if (item.id) pendingItems.set(item.id, ev);
    emit(ev);
  }

  function completeItem(item) {
    if (!item || typeof item !== "object") return;
    const type = item.type;
    if (type === "agentMessage") {
      if (item.text) {
        trustedFinal = String(item.text);
        emit({ kind: "final", text: trustedFinal });
      }
      return;
    }
    if (type === "commandExecution") {
      const started = item.id ? pendingItems.get(item.id) : null;
      if (item.id) pendingItems.delete(item.id);
      emit(commandFinished({
        command: item.command,
        toolUseId: item.id || null,
        exitCode: item.exitCode ?? item.exit_code,
        stdout: item.aggregatedOutput ?? item.aggregated_output ?? item.output,
        stderr: item.stderr,
        startedAt: started ? started.startedAt : null,
      }));
      return;
    }
    if (type === "reasoning" || type === "userMessage" || type === "plan") return;
    const started = item.id ? pendingItems.get(item.id) : null;
    if (item.id) pendingItems.delete(item.id);
    emit(toolFinished({
      tool: toolNameForItem(item),
      toolUseId: item.id || null,
      output: item.output ?? item.result ?? null,
      error: item.error ?? (item.status === "failed" || item.status === "declined" ? (item.status) : null),
      exitCode: item.exitCode ?? item.exit_code,
      startedAt: started ? started.startedAt : null,
    }));
  }

  // v2 notification 하나를 canonical event로 변환/집계한다.
  function ingest(method, params = {}) {
    const p = params || {};
    switch (method) {
      case "item/agentMessage/delta":
        if (typeof p.delta === "string" && p.delta) emit({ kind: "delta", text: p.delta });
        return;
      case "item/started":
        startItem(p.item);
        return;
      case "item/completed":
        completeItem(p.item);
        return;
      case "error":
        lastError = (p.error && p.error.message) ? String(p.error.message) : (lastError || null);
        if (p.error && p.error.message) {
          emit({ kind: "error", message: String(p.error.message).slice(0, 200) });
        }
        return;
      default:
        // delta 스트리밍(outputDelta) 등 나머지는 canonical evidence로 승격하지 않는다.
        return;
    }
  }

  function buildEvidence() {
    const snap = telemetry.snapshot();
    const finished = commandEvents.filter((e) => e.kind === "command-finished");
    const bounded = (finished.length > 0 ? finished : commandEvents).slice(-20);
    const hasTelemetry = Boolean(
      (snap.commands && snap.commands.total > 0) ||
      (snap.toolSummary && snap.toolSummary.started > 0) ||
      (snap.exploration && snap.exploration.status && snap.exploration.status !== "NORMAL")
    );
    if (bounded.length === 0 && !hasTelemetry) return null;
    return {
      commands: bounded,
      ...(snap.commands ? { commandSummary: snap.commands } : {}),
      ...(Array.isArray(snap.tools) ? { tools: snap.tools } : {}),
      ...(snap.toolSummary ? { toolSummary: snap.toolSummary } : {}),
      ...(snap.exploration ? { exploration: snap.exploration } : {}),
    };
  }

  return {
    ingest,
    buildEvidence,
    getItemContext: (id) => (id != null ? itemContext.get(id) || null : null),
    get deltaText() { return deltaText; },
    get trustedFinal() { return trustedFinal; },
    get lastError() { return lastError; },
  };
}

module.exports = {
  mapCodexTurnPolicy,
  CodexPolicyError,
  denyResponseFor,
  isApprovalRequest,
  classifyApprovalRequest,
  approvalDecisionResponse,
  approvalSummaryFrom,
  buildApprovalView,
  createCodexTurnCollector,
};
