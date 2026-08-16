const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore } = require("./chat-store");
const {
  ProjectStore,
  UNCATEGORIZED_PROJECT_ID,
  sessionDefaultsFromProject,
  migrateSessionsToProjects,
  defaultPermissionMode,
  roleConfigFor,
} = require("../agora/project-store");
const {
  WorkflowStore,
  TASK_STATUSES,
  ROLE_DEFS,
} = require("../agora/workflow-store");
const { MemoryStore } = require("../agora/memory-store");
const { parseRecorderOutput } = require("../agora/recorder-output");
const turnCheckpoint = require("../agora/turn-checkpoint");
const { TaskManager } = require("../agora/task-manager");
const { resolveTaskFileBoundary } = require("../agora/task-file-boundary");
const {
  createCapabilityService,
  toPublicProviders,
} = require("../providers/provider-capabilities");
const { toDiagnostics } = require("../providers/provider-diagnostics");
const { roomAgentsFromCapabilities } = require("./chat-agents");
const { ChatRoom, DEFAULT_DISCUSSION_RUN_BUDGET } = require("./chat-room");
const { MAX_SPECIALIST_PROMPT_CHARS } = require("./chat-prompt");
const {
  buildAgentInvocation,
  PERMISSION_MODES,
  INLINE_TEXT_LIMIT,
  minPermissionMode,
  specialistPermissionMode,
} = require("./chat-argv");
const { createLineParser } = require("./chat-events");
const { runAgentProcess } = require("./chat-agent-runner");
const { persistRunMetrics } = require("./chat-run-metrics-store");
const {
  importAttachment,
  readImagePreview,
  readInlineText,
} = require("./chat-attachments");
const { createChatWindow } = require("./chat-window");

// 채팅 기능 전체(저장소·세션·프로바이더 실행·IPC·창)를 묶는 조립 모듈.
// main.js는 createChatFeature() 한 번과 openWindow()/shutdown()만 호출합니다.

// 세션별로 남겨두는 실행 원본 로그 개수. 진단에는 최근 실행만 필요하므로
// 무한히 쌓이지 않게 오래된 파일부터 지웁니다.
const MAX_RUN_LOG_FILES = 20;
const MAX_TASK_READ_BYTES = 5 * 1024 * 1024;

// 실행 원본 stdout을 파일로 흘려보내는 writer.
// 메모리에 전체를 들고 있지 않으므로 출력이 아무리 길어도 진단 정보를 남길 수 있습니다.
// 파일을 만들 수 없는 환경에서는 조용히 비활성화되고 실행에는 영향을 주지 않습니다.
function createRunLogWriter(store, sessionId, runId) {
  if (!store || !sessionId || !runId) return { write: null, close: () => null };
  let stream = null;
  let filePath = null;
  let failed = false;

  const ensureStream = () => {
    if (stream || failed) return stream;
    try {
      const dir = store.runLogsDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, `${String(runId).replace(/[^\w.-]/g, "_")}.log`);
      stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
      stream.on("error", () => {
        failed = true;
        stream = null;
      });
    } catch {
      failed = true;
      stream = null;
      filePath = null;
    }
    return stream;
  };

  return {
    write(chunk) {
      if (!chunk) return;
      const target = ensureStream();
      if (!target) return;
      try {
        target.write(chunk);
      } catch (error) {
        failed = true;
        console.error("[Agora] 실행 원본 로그 기록 실패:", error && (error.message || error));
      }
    },
    close() {
      const closedPath = filePath;
      if (stream) {
        try {
          // 정리는 flush 이후에 합니다. 그렇지 않으면 방금 만든 로그의 mtime이
          // 아직 갱신되지 않아 스스로 삭제 대상이 될 수 있습니다.
          stream.end(() => pruneRunLogs(store, sessionId, closedPath));
        } catch {}
      } else if (closedPath) {
        pruneRunLogs(store, sessionId, closedPath);
      }
      return failed ? null : filePath;
    },
  };
}

function writeBoundedEvidence(store, sessionId, runId, provider, evidence) {
  if (!store || !sessionId || !runId || !evidence) return true;
  try {
    const dir = store.runLogsDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const safeId = String(runId).replace(/[^\w.-]/g, "_");
    const file = path.join(dir, `${safeId}.evidence.json`);
    const commands = Array.isArray(evidence.commands)
      ? evidence.commands
        .filter((entry) => entry?.kind === "command-finished" || Number.isInteger(entry?.exitCode))
        .slice(0, 20)
        .map((entry) => ({
          kind: entry.kind || "command-finished",
          command: entry.command || null,
          exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
          stdoutTail: String(entry.stdoutTail || "").slice(-2 * 1024),
          stderrTail: String(entry.stderrTail || "").slice(-2 * 1024),
          startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : null,
          finishedAt: Number.isFinite(entry.finishedAt) ? entry.finishedAt : null,
          truncated: Boolean(entry.truncated),
          source: { kind: "provider-event", provider },
        }))
      : [];
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, invocationId: runId, provider, commands }, null, 2), "utf8");
    fs.renameSync(tmp, file);
    pruneRunLogs(store, sessionId, file);
    return true;
  } catch {
    return false;
  }
}

function persistInvocationMetrics({ store, sessionId, runId, agent, specialistStage = null, result }) {
  if (!result?.runMetrics) return false;
  const saved = persistRunMetrics({
    store,
    sessionId,
    runId,
    provider: agent?.id || null,
    model: agent?.model || null,
    effort: agent?.effort || null,
    stage: specialistStage || null,
    metrics: result.runMetrics,
  });
  return Boolean(saved?.ok);
}

// 오래된 실행 로그를 정리합니다. 실패해도 실행에는 영향을 주지 않습니다.
// keepPath로 지정한 파일(방금 기록한 로그)은 항상 보존합니다.
function pruneRunLogs(store, sessionId, keepPath = null) {
  try {
    const dir = store.runLogsDir(sessionId);
    for (const suffix of [".log", ".evidence.json"]) {
      const entries = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(suffix))
        .map((name) => {
          const full = path.join(dir, name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {}
          return { full, mtimeMs };
        })
        .filter((entry) => entry.full !== keepPath)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      // keepPath가 이미 한 자리를 차지하므로 남길 개수에서 제외합니다.
      const keepCount = keepPath && keepPath.endsWith(suffix)
        ? Math.max(0, MAX_RUN_LOG_FILES - 1)
        : MAX_RUN_LOG_FILES;
      for (const entry of entries.slice(keepCount)) {
        try {
          fs.rmSync(entry.full, { force: true });
        } catch {}
      }
    }
  } catch {}
}

function publicMeta(meta) {
  if (!meta) return null;
  return {
    id: meta.id,
    title: meta.title,
    projectId: meta.projectId || UNCATEGORIZED_PROJECT_ID,
    workspace: meta.workspace || null,
    permissionMode: meta.permissionMode || "chat",
    agents: meta.agents || {},
    status: meta.status || "idle",
    readOnly: Boolean(meta.readOnly),
  };
}

// renderer로 보내는 첨부 레코드: 원본 경로/저장 경로는 제외합니다.
// fileName은 내용 해시라 경로 정보가 없지만, 뷰에서는 쓰지 않습니다.
function publicAttachment(record) {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    kind: record.kind,
    size: record.size,
  };
}

function attachmentContextLines({ attachments, deliveries, attachmentsDir }) {
  const lines = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const delivery = deliveries[index];
    if (!delivery) continue;
    if (delivery.method === "inline") {
      const text = readInlineText({
        attachmentsDir,
        fileName: attachment.fileName,
        limit: INLINE_TEXT_LIMIT,
      });
      if (text !== null) {
        lines.push(`=== 첨부 파일: ${attachment.name} ===`);
        lines.push(text);
        lines.push("=== 첨부 끝 ===");
      } else {
        delivery.method = "unsupported";
      }
    } else if (delivery.method === "path") {
      lines.push(
        `첨부 파일 "${attachment.name}" 경로: ${path.join(attachmentsDir, attachment.fileName)} (읽기 도구로 열 수 있습니다)`
      );
    } else if (delivery.method === "native-image") {
      lines.push(`(이미지 "${attachment.name}"가 함께 전달되었습니다.)`);
    } else if (delivery.method === "unsupported") {
      lines.push(`(첨부 "${attachment.name}"는 이 에이전트로 전달할 수 없었습니다.)`);
    }
  }
  return lines;
}

function createChatFeature(options) {
  const { electron, onWindowReady } = options;
  const { ipcMain, dialog, BrowserWindow, shell } = electron;

  // 출력 hard limit은 사용자 설정입니다. 설정이 없거나 0 이하이면 상한 없이 실행합니다.
  // getHardOutputLimitBytes를 주입하지 않으면 상한은 항상 비활성입니다.
  function resolveHardOutputLimit() {
    if (typeof options.getHardOutputLimitBytes !== "function") return null;
    try {
      const value = Number(options.getHardOutputLimitBytes());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  let store = null;
  let storeError = null;
  let projectStore = null;
  let projectStoreError = null;
  let workflowStore = null;
  let workflowStoreError = null;
  let memoryStore = null;
  let memoryStoreError = null;
  let capabilityService = null;
  let chatWindow = null;
  let shuttingDown = false;
  const rooms = new Map();
  // 세션별 "아직 전송 전" 첨부: id → 내부 레코드(fileName 포함)
  const pendingAttachments = new Map();

  function ensureStore() {
    if (store || storeError) return store;
    try {
      store = new ChatStore({ root: options.storeRoot }).init();
    } catch (error) {
      storeError = error?.message || String(error);
      console.warn("[agora] 채팅 저장소 초기화 실패:", storeError);
    }
    return store;
  }

  function ensureProjectStore() {
    if (projectStore || projectStoreError) return projectStore;
    const chatStore = ensureStore();
    if (!chatStore) return null;
    try {
      projectStore = new ProjectStore({ root: chatStore.root }).init();
      migrateSessionsToProjects(chatStore, projectStore);
    } catch (error) {
      projectStoreError = error?.message || String(error);
      console.warn("[agora] 프로젝트 저장소 초기화 실패:", projectStoreError);
    }
    return projectStore;
  }

  function ensureWorkflowStore() {
    if (workflowStore || workflowStoreError) return workflowStore;
    const chatStore = ensureStore();
    if (!chatStore) return null;
    try {
      workflowStore = new WorkflowStore({ root: chatStore.root }).init();
    } catch (error) {
      workflowStoreError = error?.message || String(error);
      console.warn("[agora] 작업 기록 저장소 초기화 실패:", workflowStoreError);
    }
    return workflowStore;
  }

  function ensureMemoryStore() {
    if (memoryStore || memoryStoreError) return memoryStore;
    const chatStore = ensureStore();
    if (!chatStore) return null;
    try {
      memoryStore = new MemoryStore({ root: chatStore.root }).init();
    } catch (error) {
      memoryStoreError = error?.message || String(error);
      console.warn("[agora] Memory Bank 초기화 실패:", memoryStoreError);
    }
    return memoryStore;
  }

  function ensureCapabilityService() {
    if (capabilityService) return capabilityService;
    capabilityService = options.capabilities || createCapabilityService({
      cache: {
        get: () => ensureStore()?.getConfig()?.capabilityCache || null,
        set: (value) => ensureStore()?.patchConfig({ capabilityCache: value }),
      },
    });
    return capabilityService;
  }

  function broadcast(channel, payload) {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(channel, payload);
    }
  }

  // Show account/proxy errors in the chat window when the pet is off.
  function showSystemNotice(text) {
    broadcast("chat:system-notice", { text });
  }

  function projectIdForMeta(meta) {
    const projects = ensureProjectStore();
    if (meta?.projectId && projects?.hasProject(meta.projectId)) return meta.projectId;
    return UNCATEGORIZED_PROJECT_ID;
  }

  function getActiveProjectId() {
    const projects = ensureProjectStore();
    if (!ensureStore() || !projects) return null;
    const configured = store.getConfig().activeProjectId;
    if (configured && projects.hasProject(configured)) return configured;
    const activeSessionId = store.getConfig().activeSessionId;
    const activeMeta = activeSessionId && store.hasSession(activeSessionId)
      ? store.readMeta(activeSessionId)
      : null;
    if (activeMeta) return projectIdForMeta(activeMeta);
    return projects.getProject(UNCATEGORIZED_PROJECT_ID)?.id || projects.listProjects()[0]?.id || null;
  }

  function setActiveProjectId(projectId) {
    if (!ensureStore() || store.readOnly || !projectId) return;
    store.patchConfig({ activeProjectId: projectId });
  }

  function listSessionsForProject(projectId) {
    if (!ensureStore() || !projectId) return [];
    return store.listSessions().filter((entry) => projectIdForMeta(entry) === projectId);
  }

  // 프로젝트 workspace 변경을 프로젝트에 속한 모든 세션 meta에 일괄 반영합니다.
  // 워크스페이스의 유일한 출처는 프로젝트이며 세션 개별 폴더 설계는 없습니다.
  // workspace가 null이면 권한도 chat으로 되돌립니다.
  function syncProjectWorkspaceToSessions(projectId, workspace) {
    if (!ensureStore() || !projectId) return;
    const project = ensureProjectStore()?.getProject(projectId);
    const targetMode = defaultPermissionMode(project?.defaultPermissionMode, workspace);
    for (const entry of listSessionsForProject(projectId)) {
      const patch = { workspace, permissionMode: targetMode };
      store.updateMeta(entry.id, patch);
      refreshRoomAgents(entry.id);
    }
  }

  function workflowForProject(projectId = getActiveProjectId()) {
    const workflow = ensureWorkflowStore();
    if (!workflow || !projectId) {
      return {
        decisions: [],
        tasks: [],
        roles: ROLE_DEFS,
        statuses: TASK_STATUSES,
        readOnly: Boolean(workflowStoreError),
      };
    }
    return workflow.forProject(projectId);
  }

  function getActiveSessionId(projectId = getActiveProjectId()) {
    if (!ensureStore() || !projectId) return null;
    const config = store.getConfig();
    const configured = config.activeSessionIdsByProject?.[projectId];
    if (configured && store.hasSession(configured) && projectIdForMeta(store.readMeta(configured)) === projectId) {
      return configured;
    }
    if (config.activeSessionId && store.hasSession(config.activeSessionId)) {
      const meta = store.readMeta(config.activeSessionId);
      if (projectIdForMeta(meta) === projectId) return config.activeSessionId;
    }
    const first = listSessionsForProject(projectId)[0];
    return first ? first.id : null;
  }

  function setActiveSessionId(sessionId) {
    if (!ensureStore() || store.readOnly || !sessionId) return;
    const meta = store.readMeta(sessionId);
    if (!meta) return;
    const projectId = projectIdForMeta(meta);
    const activeSessionIdsByProject = {
      ...(store.getConfig().activeSessionIdsByProject || {}),
      [projectId]: sessionId,
    };
    store.patchConfig({ activeProjectId: projectId, activeSessionId: sessionId, activeSessionIdsByProject });
  }

  function createSessionForProject(projectId = getActiveProjectId()) {
    const projects = ensureProjectStore();
    const project = projects?.getProject(projectId) || projects?.getProject(UNCATEGORIZED_PROJECT_ID);
    return store.createSession(sessionDefaultsFromProject(project));
  }

  async function chooseWorkspace(title) {
    const result = await dialog.showOpenDialog(chatWindow || undefined, {
      properties: ["openDirectory"],
      title,
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    try {
      const workspace = fs.realpathSync(result.filePaths[0]);
      if (!fs.statSync(workspace).isDirectory()) throw new Error("not a directory");
      return workspace;
    } catch {
      throw new Error("선택한 폴더를 확인할 수 없습니다.");
    }
  }

  function sessionsPayload() {
    const activeProjectId = getActiveProjectId();
    const list = listSessionsForProject(activeProjectId);
    return {
      projects: ensureProjectStore()?.listProjects() || [],
      workflow: workflowForProject(activeProjectId),
      activeProjectId,
      sessions: list,
      activeSessionId: getActiveSessionId(activeProjectId),
      readOnly: Boolean(store?.readOnly || storeError || projectStoreError || workflowStoreError || memoryStoreError),
    };
  }

  function pendingFor(sessionId) {
    if (!pendingAttachments.has(sessionId)) pendingAttachments.set(sessionId, new Map());
    return pendingAttachments.get(sessionId);
  }

  // 세션 대화에 이미 저장된 첨부에서 id로 내부 레코드를 찾습니다(미리보기용).
  function findAttachmentRecord(sessionId, attachmentId) {
    const pending = pendingFor(sessionId).get(attachmentId);
    if (pending) return pending;
    const room = rooms.get(sessionId);
    const messages = room ? room.messages : ensureStore() ? store.readMessages(sessionId) : [];
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        if (attachment.id === attachmentId) return attachment;
      }
    }
    return null;
  }

  function makeRunAgent(sessionId) {
    return ({
      agent,
      prompt,
      runId,
      attachments,
      emitEvent,
      permissionMode: requestedPermission,
      specialistStage = null,
      autoApprove = false,
    }) => {
      const record = ensureCapabilityService().getRecord(agent.id);
      const meta = store?.readMeta(sessionId);
      if (!record || !meta) {
        return {
          promise: Promise.resolve({ ok: false, error: "세션 정보를 읽지 못했습니다." }),
          cancel: () => {},
        };
      }
      const config = meta.agents?.[agent.id] || {};
      const sessionPermission = meta.permissionMode || "chat";
      const room = getRoom(sessionId);
      const runAuth = room?.activeRunAuthorization || null;
      let stagePermission = null;
      if (specialistStage) {
        if (!runAuth) {
          return {
            promise: Promise.resolve({ ok: false, error: "전문 실행 권한이 없어 실행할 수 없습니다." }),
            cancel: () => {},
          };
        }
        stagePermission = specialistPermissionMode(specialistStage, runAuth);
      } else {
        stagePermission = sessionPermission;
      }
      if (!stagePermission) {
        return {
          promise: Promise.resolve({ ok: false, error: "알 수 없는 전문 실행 단계라 권한을 계산할 수 없습니다." }),
          cancel: () => {},
        };
      }
      const authority = specialistStage ? (runAuth || "workspace-write") : sessionPermission;
      const permissionMode = minPermissionMode(
        authority,
        requestedPermission || authority,
        stagePermission
      );
      if (!permissionMode) {
        return {
          promise: Promise.resolve({ ok: false, error: "전문 실행 권한을 안전하게 계산할 수 없습니다." }),
          cancel: () => {},
        };
      }
      const attachmentsDir = store.attachmentsDir(sessionId);
      const enriched = (attachments || []).map((attachment) => ({
        ...attachment,
        path: path.join(attachmentsDir, attachment.fileName || ""),
      }));

      let outputFile = null;
      if (agent.id === "codex") {
        outputFile = path.join(
          os.tmpdir(),
          `agora-chat-${agent.id}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
        );
      }

      const invocation = buildAgentInvocation({
        provider: record,
        permissionMode,
        workspace: meta.workspace || null,
        model: agent.model,
        effort: agent.effort,
        attachments: enriched,
        chatCwd: store.runtimeChatDir(),
        attachmentsDir,
        outputFile,
        autoApprove: permissionMode === "workspace-write" && Boolean(config.autoApprove || autoApprove),
      });
      if (!invocation.ok) {
        return {
          promise: Promise.resolve({ ok: false, error: invocation.error, ...(invocation.stopReason ? { stopReason: invocation.stopReason } : {}) }),
          cancel: () => {},
        };
      }

      let fullPrompt = prompt;
      const extraLines = attachmentContextLines({
        attachments: enriched,
        deliveries: invocation.deliveries,
        attachmentsDir,
      });
      if (extraLines.length > 0) fullPrompt = `${prompt}\n${extraLines.join("\n")}`;
      if (specialistStage && fullPrompt.length > MAX_SPECIALIST_PROMPT_CHARS) {
        const error = new Error(`전문 실행 프롬프트 예산을 초과했습니다 (${fullPrompt.length}/${MAX_SPECIALIST_PROMPT_CHARS}자).`);
        error.code = "PROMPT_BUDGET_EXCEEDED";
        return {
          promise: Promise.resolve({ ok: false, error: error.message, stopReason: error.code }),
          cancel: () => {},
        };
      }

      // 원본 출력은 필요할 때만 파일로 흘려보냅니다. 메모리에 전체를 들고 있지 않으므로
      // 아주 긴 실행에서도 진단 정보를 잃지 않습니다.
      const rawLog = createRunLogWriter(store, sessionId, runId);

      const hardOutputLimitBytes = resolveHardOutputLimit();

      const run = runAgentProcess({
        commandPath: record.commandPath,
        needsShell: record.needsShell,
        argv: invocation.argv,
        prompt: fullPrompt,
        promptTransport: invocation.promptTransport,
        cwd: invocation.cwd,
        outputFile,
        parseLine: createLineParser(agent.id),
        onEvent: emitEvent,
        timeoutMs: options.timeoutMs,
        requireFinal: Boolean(specialistStage),
        // 출력이 길다는 이유로 실행을 죽이지 않습니다. hard limit은 사용자가
        // 명시적으로 켜지 않으면 undefined(=상한 없음)로 남습니다.
        ...(Number.isFinite(options.captureOutputBytes) && options.captureOutputBytes > 0
          ? { captureOutputBytes: options.captureOutputBytes }
          : {}),
        ...(hardOutputLimitBytes ? { hardOutputLimitBytes } : {}),
        onRawChunk: rawLog.write,
      });
      return {
        promise: run.promise.then((result) => {
          const logPath = rawLog.close();
          // renderer에는 파일 시스템 경로를 보내지 않습니다(기존 보안 경계 유지).
          // 진단에는 파일 이름만 노출하고, 실제 경로는 main 프로세스에만 둡니다.
          const diagnostics =
            result.output || logPath
              ? {
                  ...(result.output || {}),
                  ...(logPath ? { rawLogName: path.basename(logPath) } : {}),
                }
              : null;
          const enrichedResult = diagnostics ? { ...result, output: diagnostics } : result;
          const metricsPersisted = persistInvocationMetrics({
            store,
            sessionId,
            runId,
            agent,
            specialistStage,
            result: enrichedResult,
          });
          const persistedEvidence = specialistStage
            ? writeBoundedEvidence(
                store,
                sessionId,
                runId,
                agent.id,
                enrichedResult.evidence || { commands: [] }
              )
            : true;
          return enrichedResult.ok
            ? {
                ...enrichedResult,
                deliveries: invocation.deliveries,
                evidencePersisted: persistedEvidence,
                metricsPersisted,
              }
            : { ...enrichedResult, evidencePersisted: persistedEvidence, metricsPersisted };
        }),
        cancel: run.cancel,
      };
    };
  }

  function buildRoomAgents(meta) {
    const records = ensureCapabilityService();
    const discovered = [];
    for (const def of records.defs) {
      const record = records.getRecord(def.id);
      if (record) discovered.push(record);
    }
    return roomAgentsFromCapabilities(discovered, meta?.agents || {});
  }

  function projectForSession(meta) {
    const projects = ensureProjectStore();
    return projects?.getProject(projectIdForMeta(meta)) || null;
  }

const TASK_STATUS_LABELS = Object.freeze({
  todo: "할 일",
  in_progress: "진행 중",
  review: "검토 중",
  blocked: "막힘",
});

function roomMeta(meta) {
  const project = projectForSession(meta);
  const memory = ensureMemoryStore();
  return {
    permissionMode: meta?.permissionMode || "chat",
    workspace: meta?.workspace || null,
    projectContext: project?.context || "",
      memoryContext: memory && project ? memory.readForPrompt(project.id) : "",
      rulesContext: memory && project ? memory.readRules(project.id) : "",
      workflowContext: project ? buildWorkflowContext(project.id) : "",
    };
  }

  function buildWorkflowContext(projectId) {
    const workflow = ensureWorkflowStore();
    if (!workflow || !projectId) return "";
    const decisions = workflow.listDecisions(projectId).filter((d) => d.status === "confirmed");
    const tasks = workflow
      .listTasks(projectId)
      .filter((t) => ["todo", "in_progress", "review", "blocked"].includes(t.status));
    if (decisions.length === 0 && tasks.length === 0) return "";
    const lines = [];
    if (decisions.length > 0) {
      lines.push("[확정된 결정]");
      for (const d of decisions) {
        const summary = d.content.length > 200 ? `${d.content.slice(0, 200)}...` : d.content;
        lines.push(`- ${d.title || "(제목 없음)"}: ${summary}`);
      }
    }
    if (tasks.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[진행 중 작업]");
      for (const t of tasks) {
        lines.push(`- ${t.title} (${TASK_STATUS_LABELS[t.status] || t.status})`);
      }
    }
    return lines.join("\n");
  }

  function specialistStageFor(project, room, roleId) {
    const roleLabel = {
      planning: "기획",
      plan_review: "기획 검수",
      implementation: "구현",
      review: "검토",
      recorder: "기록",
    }[roleId] || roleId;
    let config = roleConfigFor(project, roleId);
    // 기획 검수와 기록 역할은 선택 사항이다. 비워 둔 경우에는 기존 검토 담당자를
    // 재사용하므로, 새 역할 슬롯을 추가해도 기존 프로젝트 설정은 그대로 동작한다.
    if (!config.agentId && ["plan_review", "recorder"].includes(roleId)) {
      config = roleConfigFor(project, "review");
    }
    if (!config.agentId) {
      return { ok: false, error: `전문 모드의 ${roleLabel} 담당자를 프로젝트 설정에서 지정해 주세요.` };
    }
    const agent = room.findAgent(config.agentId);
    if (!agent || !agent.available || agent.enabled === false) {
      return { ok: false, error: `전문 모드의 ${roleLabel} 담당 에이전트 @${config.agentId}를 사용할 수 없습니다.` };
    }
    const projectDefault = project.defaultAgents?.[config.agentId] || {};
    const agentConfig = {
      model: config.model && config.model !== "default"
        ? config.model
        : projectDefault.model || agent.model || "default",
      effort: config.effort && config.effort !== "default"
        ? config.effort
        : projectDefault.effort || agent.effort || "default",
    };
    return { ok: true, agent, agentConfig };
  }

  function specialistStagesFor(project, room, action = "full") {
    const stages = {};
    const requiredRoles = action === "record"
      ? ["recorder"]
      : action === "plan"
        ? ["planning", "plan_review"]
        : action === "implementation"
          ? ["implementation", "review", "recorder"]
          : ["planning", "plan_review", "implementation", "review", "recorder"];
    for (const roleId of requiredRoles) {
      const stage = specialistStageFor(project, room, roleId);
      if (!stage.ok) return stage;
      const stageKey = roleId === "planning"
        ? "planner"
        : roleId === "plan_review"
          ? "planReview"
          : roleId;
      stages[stageKey] = stage;
    }
    return { ok: true, stages };
  }

  async function recordDiscussion(sessionId) {
    const room = getRoom(sessionId);
    const meta = store.readMeta(sessionId);
    const project = projectForSession(meta);
    if (!room || !project) return { ok: false, error: "토론 프로젝트를 찾을 수 없습니다." };
    const recorder = specialistStageFor(project, room, "recorder");
    if (!recorder.ok) return recorder;
    const result = await room.runRecorder(recorder);
    if (result?.ok && result.text) {
      const entry = saveRecorderOutput(project.id, result.text, "토론 요약 초안", {
        chatId: sessionId,
        recorderAgentId: recorder.agent?.id || null,
      });
      return { ok: Boolean(entry), entry };
    }
    return { ok: false, error: "기록관이 요약을 만들지 못했습니다." };
  }

  function getRoom(sessionId) {
    if (rooms.has(sessionId)) return rooms.get(sessionId);
    if (!ensureStore()) return null;
    const session = store.getSession(sessionId);
    if (!session) return null;
    const sessionProject = projectForSession(session.meta);
    const workflow = ensureWorkflowStore();
    if (workflow && sessionProject && session.meta.workspace && !workflow.readOnly) {
      try {
        workflow.reconcileProjectTasks(sessionProject.id, session.meta.workspace);
      } catch {}
    }

    const room = new ChatRoom({
      sessionId,
      agents: buildRoomAgents(session.meta),
      initialMessages: session.messages,
      runAgent: options.runAgent || makeRunAgent(sessionId),
      prepareAgent: options.prepareAgent,
      meta: roomMeta(session.meta),
      checkpoint: options.checkpoint || turnCheckpoint,
      checkpointRoot: store.checkpointsDir(sessionId),
      strictReviewDiff: true,
      initialRecovery: session.meta.pendingRecovery || null,
      persistRecovery: (pendingRecovery) => {
        const updated = store.updateMeta(sessionId, { pendingRecovery: pendingRecovery || null });
        return Boolean(updated);
      },
      initialProfessionalRun: session.meta.professionalRun || null,
      persistProfessionalRun: (professionalRun) => {
        const updated = store.updateMeta(sessionId, { professionalRun: professionalRun || null });
        return Boolean(updated);
      },
      taskManager: options.taskManager || new TaskManager(),
      // TASK-007: Planner가 TASK.md를 만들면 workflow.json에 metadata를 등록합니다.
      // 조기 등록 → 사용자가 승인 전에도 작업 목록에서 확인 가능 (status: todo)
      onTaskCreated: (task) => {
        try {
          const workflow = ensureWorkflowStore();
          const project = projectForSession(store.readMeta(sessionId));
          if (!workflow || !project) return false;
          const entry = workflow.createTask({
            projectId: project.id,
            title: task.title || "Planner Task",
            description: task.description || "",
            contentSource: task.contentSource || "file",
            taskPath: task.taskPath || null,
            taskHash: task.taskHash || null,
            status: task.status || "todo",
            role: task.role || "implementation",
            chatId: sessionId,
            origin: "planner",
          });
          if (entry) {
            refreshWorkflowForProject(project.id);
            broadcast("chat:workflow-changed", {
              projectId: project.id,
              workflow: workflowForProject(project.id),
            });
          }
          return Boolean(entry);
        } catch (error) {
          console.warn("[agora] Planner Task workflow 등록 실패:", error?.message || error);
          return false;
        }
      },
      onTaskUpdated: ({ taskPath, taskHash, status }) => {
        try {
          const workflow = ensureWorkflowStore();
          const project = projectForSession(store.readMeta(sessionId));
          if (!workflow || !project) return false;
          const target = workflow.listTasks(project.id).find((task) => task.taskPath === taskPath);
          if (!target) return false;
          workflow.updateTask(target.id, { taskHash, status });
          refreshWorkflowForProject(project.id);
          broadcast("chat:workflow-changed", {
            projectId: project.id,
            workflow: workflowForProject(project.id),
          });
          return Boolean(target);
        } catch (error) {
          console.warn("[agora] Planner Task workflow 갱신 실패:", error?.message || error);
          return false;
        }
      },
      onProfessionalTaskState: ({ taskPath, status, activeRunId = null, lastRunId = null }) => {
        try {
          const workflow = ensureWorkflowStore();
          const project = projectForSession(store.readMeta(sessionId));
          if (!workflow || !project || !taskPath) return false;
          const task = workflow.listTasks(project.id).find((entry) => entry.taskPath === taskPath);
          if (!task || task.syncState !== "ok") return false;
          const updated = workflow.updateTask(task.id, {
            status,
            activeRunId,
            lastRunId,
          });
          if (!updated) return false;
          refreshWorkflowForProject(project.id);
          broadcast("chat:workflow-changed", {
            projectId: project.id,
            workflow: workflowForProject(project.id),
          });
          return true;
        } catch (error) {
          console.warn("[agora] 전문 실행 Workflow 갱신 실패:", error?.message || error);
          return false;
        }
      },
    });

    room.on("message", (message) => {
      store.appendEvent(sessionId, { kind: "message", message });
      // renderer로는 첨부 내부 레코드(fileName/sha256)를 제거한 사본만 보냅니다.
      const outbound = message.attachments
        ? { ...message, attachments: message.attachments.map(publicAttachment) }
        : message;
      broadcast("chat:message", { sessionId, message: outbound });
      broadcast("chat:sessions-changed", sessionsPayload());
    });
    room.on("typing", (payload) => broadcast("chat:typing", { sessionId, ...payload }));
    room.on("turn-state", (payload) => broadcast("chat:turn-state", { sessionId, ...payload }));
    room.on("specialist-resume-state", (payload) => broadcast("chat:specialist-resume-state", { sessionId, ...payload }));
    room.on("reset", () => broadcast("chat:reset", { sessionId }));
    room.on("run-event", (payload) => broadcast("chat:run-event", { sessionId, ...payload }));
    room.on("agents", (agents) => broadcast("chat:agents", { sessionId, agents }));
    room.on("approval-request", (payload) => broadcast("chat:approval-request", { sessionId, ...payload }));
    room.on("busy", (busy) => {
      if (shuttingDown) return;
      store.setSessionStatus(sessionId, busy ? "running" : "idle");
      broadcast("chat:sessions-changed", sessionsPayload());
    });

    rooms.set(sessionId, room);
    return room;
  }

  function refreshRoomAgents(sessionId) {
    const room = rooms.get(sessionId);
    if (!room || !store) return;
    const meta = store.readMeta(sessionId);
    room.setAgents(buildRoomAgents(meta));
    if (meta) room.setMeta(roomMeta(meta));
  }

  function sessionState(sessionId) {
    const room = getRoom(sessionId);
    const meta = store?.readMeta(sessionId);
    if (!room || !meta) return null;
    return {
      meta: publicMeta(meta),
      agents: room.publicAgents(),
      messages: room.messages.map((message) => ({
        ...message,
        attachments: (message.attachments || []).map(publicAttachment),
      })),
      typing: room.state().typing,
      turnState: room.turnState(),
      specialist: room.specialistState(),
      pendingAttachments: [...pendingFor(sessionId).values()].map(publicAttachment),
    };
  }

  function refreshMemoryForProject(projectId) {
    for (const [sessionId] of rooms) {
      const meta = store.readMeta(sessionId);
      if (projectIdForMeta(meta) === projectId) refreshRoomAgents(sessionId);
    }
  }

  // Refresh open rooms' workflow context after decision/task changes.
  function refreshWorkflowForProject(projectId) {
    for (const [sessionId] of rooms) {
      const meta = store.readMeta(sessionId);
      if (projectIdForMeta(meta) === projectId) refreshRoomAgents(sessionId);
    }
  }

  function saveRecorderOutput(projectId, content, title, options = {}) {
    const memory = ensureMemoryStore();
    if (!memory || !content) return null;
    const { chatId = null, recorderAgentId = null, runId = null } = options;
    const parsed = parseRecorderOutput(content);
    const entry = memory.append(projectId, {
      source: "agent",
      status: "draft",
      title,
      content: parsed.summary,
    });
    if (entry) {
      refreshMemoryForProject(projectId);
    }
    const workflow = ensureWorkflowStore();
    if (workflow) {
      try {
        for (const decision of parsed.decisions) {
          workflow.createDecision({
            projectId,
            title: decision.title,
            content: decision.content,
            chatId,
            messageIds: decision.messageIds,
            status: "proposed",
            origin: "recorder",
            recorderAgentId,
            runId,
          });
        }
        for (const action of parsed.nextActions) {
          workflow.createTask({
            projectId,
            title: action.title,
            description: action.description,
            chatId,
            status: "proposed",
            origin: "recorder",
            recorderAgentId,
            runId,
          });
        }
      } catch (error) {
        // 요약 저장 자체는 유지하되, 후보 등록 실패는 조용히 넘기지 않고 로그로 남깁니다.
        if (entry) console.error("[Agora] 기록관 후보 등록 실패:", error && (error.message || error));
      }
    }
    if (entry) broadcast("chat:sessions-changed", sessionsPayload());
    return entry;
  }

  async function fullState({ refreshProviders = false } = {}) {
    ensureStore();
    const service = ensureCapabilityService();
    const records = await service.discover({ force: refreshProviders });

    if (store && !store.readOnly && store.listSessions().length === 0) {
      store.createSession(sessionDefaultsFromProject(ensureProjectStore()?.getProject(getActiveProjectId())));
    }
    const activeSessionId = getActiveSessionId();
    return {
      // 저장소 문제는 하드 실패가 아니라 경고 배너로 전달합니다.
      error: storeError || null,
      providers: toPublicProviders(records),
      diagnostics: toDiagnostics(records),
      permissionModes: PERMISSION_MODES,
      discussionMaxTurns: DEFAULT_DISCUSSION_RUN_BUDGET,
      ...sessionsPayload(),
      activeSessionId,
      session: activeSessionId ? sessionState(activeSessionId) : null,
    };
  }

  function requireSession(sessionId) {
    if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
    if (!sessionId || !store.hasSession(sessionId)) throw new Error("세션을 찾을 수 없습니다.");
  }

  function requireProject(projectId) {
    const projects = ensureProjectStore();
    if (!projects) throw new Error(projectStoreError || "프로젝트 저장소를 사용할 수 없습니다.");
    // 채팅 저장소가 읽기 전용(더 새 버전이 만든 데이터)이면 프로젝트·메모리·
    // 결정·작업 쓰기 IPC도 함께 막습니다. 화면에는 읽기 전용으로 표시되므로
    // 실제 쓰기가 조용히 성공해 데이터가 어긋나는 일을 막습니다.
    if (store && store.readOnly) throw new Error("이 .agora 저장소는 읽기 전용 상태라 변경할 수 없습니다.");
    const project = projects.getProject(projectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    if (project.readOnly) throw new Error("이 프로젝트는 더 새로운 버전에서 만들어져 읽기 전용입니다.");
    return project;
  }

  function requireSessionForProject(sessionId, projectId) {
    if (!sessionId) return null;
    requireSession(sessionId);
    if (projectIdForMeta(store.readMeta(sessionId)) !== projectId) {
      throw new Error("선택한 채팅이 프로젝트에 속하지 않습니다.");
    }
    return sessionId;
  }

  // 세션 워크스페이스 안의 작업 지시서 경로를 검증해 실제 regular file 경로로 돌려줍니다.
  // open-file/read-file 모두 realpath containment와 같은 5MiB 상한을 공유합니다.
  function resolveTaskFilePath(sessionId, taskPath) {
    requireSession(sessionId);
    const meta = store.readMeta(sessionId);
    return resolveTaskFileBoundary(meta?.workspace, taskPath, {
      maxBytes: MAX_TASK_READ_BYTES,
    }).target;
  }

  function wrap(handler) {
    return async (_event, input) => {
      try {
        const data = await handler(input || {});
        return { ok: true, ...(data || {}) };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    };
  }

  function registerIpcHandlers() {
    ipcMain.handle("chat:state", wrap(async (input) => fullState(input)));

    ipcMain.handle(
      "chat:providers:refresh",
      wrap(async () => {
        const records = await ensureCapabilityService().discover({ force: true });
        for (const sessionId of rooms.keys()) refreshRoomAgents(sessionId);
        return { providers: toPublicProviders(records), diagnostics: toDiagnostics(records) };
      })
    );

    ipcMain.handle(
      "chat:open-external",
      wrap(async ({ url }) => {
        const allowedUrls = new Set(
          ensureCapabilityService().defs.map((def) => def.installUrl).filter(Boolean)
        );
        if (!allowedUrls.has(url)) throw new Error("허용되지 않은 외부 주소입니다.");
        await shell.openExternal(url);
        return {};
      })
    );

    // 작업 지시서(TASK.md)를 OS 기본 편집기로 엽니다.
    // 임의 경로 열기를 막기 위해 해당 세션 workspace 안의 regular file만 허용합니다.
    ipcMain.handle(
      "chat:task:open-file",
      wrap(async ({ sessionId, taskPath }) => {
        const target = resolveTaskFilePath(sessionId, taskPath);
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
        return {};
      })
    );

    // 작업 지시서(TASK.md) 내용을 읽어 채팅 화면 안에서 보여줍니다(읽기 전용).
    // open-file과 같은 경로·realpath·regular file·크기 검증을 공유합니다.
    ipcMain.handle(
      "chat:task:read-file",
      wrap(async ({ sessionId, taskPath }) => {
        const target = resolveTaskFilePath(sessionId, taskPath);
        const content = fs.readFileSync(target, "utf8");
        return { content, taskPath: String(taskPath || "") };
      })
    );

    ipcMain.handle(
      "chat:projects:create",
      wrap(async ({ name, workspace }) => {
        if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
        if (store.readOnly) throw new Error("이 .agora 저장소는 읽기 전용 상태라 변경할 수 없습니다.");
        const project = ensureProjectStore().createProject({ name, workspace });
        const meta = createSessionForProject(project.id);
        setActiveSessionId(meta.id);
        await ensureCapabilityService().discover();
        return { ...sessionsPayload(), session: sessionState(meta.id) };
      })
    );

    ipcMain.handle(
      "chat:projects:select",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId);
        setActiveProjectId(project.id);
        let sessionId = getActiveSessionId(project.id);
        if (!sessionId && !store.readOnly) sessionId = createSessionForProject(project.id).id;
        if (sessionId) setActiveSessionId(sessionId);
        await ensureCapabilityService().discover();
        return { ...sessionsPayload(), session: sessionId ? sessionState(sessionId) : null };
      })
    );

    ipcMain.handle(
      "chat:projects:update",
      wrap(async ({ projectId, patch }) => {
        requireProject(projectId);
        const next = {};
        if (typeof patch?.name === "string") next.name = patch.name;
        if (typeof patch?.context === "string") next.context = patch.context;
        if (typeof patch?.defaultPermissionMode === "string") {
          next.defaultPermissionMode = patch.defaultPermissionMode;
        }
        if (patch?.defaultAgents && typeof patch.defaultAgents === "object" && !Array.isArray(patch.defaultAgents)) {
          next.defaultAgents = patch.defaultAgents;
        }
        if (patch?.defaultRoles && typeof patch.defaultRoles === "object" && !Array.isArray(patch.defaultRoles)) {
          next.defaultRoles = patch.defaultRoles;
        }
        const project = ensureProjectStore().updateProject(projectId, next);
        for (const [sessionId] of rooms) {
          const meta = store.readMeta(sessionId);
          if (projectIdForMeta(meta) === projectId) refreshRoomAgents(sessionId);
        }
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, project };
      })
    );

    ipcMain.handle(
      "chat:projects:workspace:choose",
      wrap(async ({ projectId }) => {
        requireProject(projectId);
        const workspace = await chooseWorkspace("프로젝트 워크스페이스 선택");
        if (!workspace) return { canceled: true, ...sessionsPayload() };
        const project = ensureProjectStore().updateProject(projectId, { workspace });
        syncProjectWorkspaceToSessions(projectId, workspace);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, project };
      })
    );

    ipcMain.handle(
      "chat:projects:workspace:clear",
      wrap(async ({ projectId }) => {
        requireProject(projectId);
        const project = ensureProjectStore().updateProject(projectId, { workspace: null });
        syncProjectWorkspaceToSessions(projectId, null);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, project };
      })
    );

    ipcMain.handle(
      "chat:memory:read",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const memory = ensureMemoryStore();
        if (!memory) throw new Error(memoryStoreError || "Memory Bank를 사용할 수 없습니다.");
        return { projectId: project.id, content: memory.read(project.id) };
      })
    );

    ipcMain.handle(
      "chat:memory:append",
      wrap(async ({ projectId, content, title }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const memory = ensureMemoryStore();
        if (!memory) throw new Error(memoryStoreError || "Memory Bank를 사용할 수 없습니다.");
        const entry = memory.append(project.id, { source: "human", title, content });
        if (!entry) throw new Error("추가할 기억을 입력해 주세요.");
        refreshMemoryForProject(project.id);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, memory: memory.read(project.id), entry };
      })
    );

    ipcMain.handle(
      "chat:memory:rules:read",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const memory = ensureMemoryStore();
        if (!memory) throw new Error(memoryStoreError || "Memory Bank를 사용할 수 없습니다.");
        return { rules: memory.readRules(project.id), history: memory.readRulesHistory(project.id) };
      })
    );

    ipcMain.handle(
      "chat:memory:rules:save",
      wrap(async ({ projectId, content }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const memory = ensureMemoryStore();
        if (!memory) throw new Error(memoryStoreError || "Memory Bank를 사용할 수 없습니다.");
        const result = memory.saveRules(project.id, content);
        if (result.changed) refreshMemoryForProject(project.id);
        return { rules: result.rules, history: memory.readRulesHistory(project.id), changed: result.changed };
      })
    );

    ipcMain.handle(
      "chat:projects:delete",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId);
        if (project.id === UNCATEGORIZED_PROJECT_ID) {
          throw new Error("기본 프로젝트는 삭제할 수 없습니다.");
        }
        const deletingActive = getActiveProjectId() === project.id;
        for (const entry of store.listSessions()) {
          const meta = store.readMeta(entry.id);
          if (projectIdForMeta(meta) !== project.id) continue;
          store.updateMeta(entry.id, { projectId: UNCATEGORIZED_PROJECT_ID });
          refreshRoomAgents(entry.id);
        }
        ensureWorkflowStore()?.moveProjectItems(project.id, UNCATEGORIZED_PROJECT_ID);
        if (!ensureProjectStore().deleteProject(project.id)) {
          throw new Error("프로젝트를 삭제하지 못했습니다.");
        }
        // 프로젝트 파일을 지운 뒤에만 메모리·규칙 파일을 정리합니다.
        // 순서를 바꾸면 삭제가 실패했을 때 기록만 사라질 수 있습니다.
        try {
          ensureMemoryStore()?.deleteProject(project.id);
        } catch {}
        const nextProjectId = deletingActive ? UNCATEGORIZED_PROJECT_ID : getActiveProjectId();
        setActiveProjectId(nextProjectId);
        let sessionId = getActiveSessionId(nextProjectId);
        if (!sessionId && !store.readOnly) sessionId = createSessionForProject(nextProjectId).id;
        if (sessionId) setActiveSessionId(sessionId);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, session: sessionId ? sessionState(sessionId) : null };
      })
    );

    ipcMain.handle(
      "chat:decisions:create",
      wrap(async ({ projectId, title, content, chatId, messageIds }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const sourceChatId = requireSessionForProject(chatId || getActiveSessionId(project.id), project.id);
        const decision = ensureWorkflowStore().createDecision({
          projectId: project.id,
          title,
          content,
          chatId: sourceChatId,
          messageIds,
        });
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return { ...payload, decision };
      })
    );

    ipcMain.handle(
      "chat:decisions:update",
      wrap(async ({ projectId, decisionId, patch }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getDecision(decisionId);
        if (!current || current.projectId !== project.id) throw new Error("결정을 찾을 수 없습니다.");
        const next = {};
        if (typeof patch?.title === "string") next.title = patch.title;
        if (typeof patch?.content === "string") next.content = patch.content;
        if (Array.isArray(patch?.messageIds)) next.messageIds = patch.messageIds;
        if (typeof patch?.chatId === "string" || patch?.chatId === null) {
          next.chatId = requireSessionForProject(patch.chatId, project.id);
        }
        const decision = workflow.updateDecision(decisionId, next);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return { ...payload, decision };
      })
    );

    ipcMain.handle(
      "chat:decisions:delete",
      wrap(async ({ projectId, decisionId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getDecision(decisionId);
        if (!current || current.projectId !== project.id) throw new Error("결정을 찾을 수 없습니다.");
        if (workflow.listTasks(project.id).some((task) => task.decisionId === decisionId)) {
          throw new Error("연결된 작업이 있어 결정을 삭제할 수 없습니다.");
        }
        workflow.deleteDecision(decisionId);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return payload;
      })
    );

    ipcMain.handle(
      "chat:decisions:resolve",
      wrap(async ({ projectId, ids, action }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        if (action !== "approve" && action !== "reject" && action !== "restore") {
          throw new Error("올바르지 않은 승인 동작입니다.");
        }
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          const current = workflow.getDecision(id);
          if (!current || current.projectId !== project.id) continue;
          if (action === "restore") {
            if (current.status === "rejected") workflow.updateDecision(id, { status: "proposed" });
          } else if (current.status === "proposed") {
            workflow.updateDecision(id, { status: action === "reject" ? "rejected" : "confirmed" });
          }
        }
        refreshMemoryForProject(project.id);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return payload;
      })
    );

    ipcMain.handle(
      "chat:tasks:create",
      wrap(async ({ projectId, title, description, status, role, agentId, decisionId, chatId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const sourceChatId = requireSessionForProject(chatId || getActiveSessionId(project.id), project.id);
        if (decisionId) {
          const decision = workflow.getDecision(decisionId);
          if (!decision || decision.projectId !== project.id) throw new Error("연결할 결정을 찾을 수 없습니다.");
        }
        const selectedRole = ROLE_DEFS.some((entry) => entry.id === role) ? role : "implementation";
        const roleConfig = roleConfigFor(project, selectedRole);
        const task = workflow.createTask({
          projectId: project.id,
          title,
          description,
          status,
          role: selectedRole,
          agentId: agentId || roleConfig.agentId || null,
          decisionId,
          chatId: sourceChatId,
        });
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return { ...payload, task };
      })
    );

    ipcMain.handle(
      "chat:tasks:update",
      wrap(async ({ projectId, taskId, patch }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getTask(taskId);
        if (!current || current.projectId !== project.id) throw new Error("작업을 찾을 수 없습니다.");
        if (patch?.decisionId) {
          const decision = workflow.getDecision(patch.decisionId);
          if (!decision || decision.projectId !== project.id) throw new Error("연결할 결정을 찾을 수 없습니다.");
        }
        const next = {};
        for (const field of ["title", "description", "status", "role", "agentId", "decisionId", "chatId"]) {
          if (Object.hasOwn(patch || {}, field)) next[field] = patch[field];
        }
        if (Object.hasOwn(next, "chatId")) next.chatId = requireSessionForProject(next.chatId, project.id);
        const task = workflow.updateTask(taskId, next);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return { ...payload, task };
      })
    );

    ipcMain.handle(
      "chat:tasks:delete",
      wrap(async ({ projectId, taskId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getTask(taskId);
        if (!current || current.projectId !== project.id) throw new Error("작업을 찾을 수 없습니다.");
        workflow.deleteTask(taskId);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return payload;
      })
    );

    ipcMain.handle(
      "chat:tasks:resolve",
      wrap(async ({ projectId, ids, action }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        if (action !== "approve" && action !== "reject") throw new Error("올바르지 않은 승인 동작입니다.");
        const nextStatus = action === "reject" ? "rejected" : "todo";
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          const current = workflow.getTask(id);
          if (current && current.projectId === project.id && current.status === "proposed") {
            workflow.updateTask(id, { status: nextStatus });
          }
        }
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        refreshWorkflowForProject(project.id);
        return payload;
      })
    );

    ipcMain.handle(
      "chat:sessions:create",
      wrap(async () => {
        if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
        const meta = createSessionForProject();
        setActiveSessionId(meta.id);
        await ensureCapabilityService().discover();
        return { ...sessionsPayload(), session: sessionState(meta.id) };
      })
    );

    ipcMain.handle(
      "chat:sessions:select",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        setActiveSessionId(sessionId);
        await ensureCapabilityService().discover();
        return { ...sessionsPayload(), session: sessionState(sessionId) };
      })
    );

    ipcMain.handle(
      "chat:sessions:move",
      wrap(async ({ sessionId, projectId }) => {
        requireSession(sessionId);
        const targetProject = requireProject(projectId);
        const currentMeta = store.readMeta(sessionId);
        const wasActive = getActiveSessionId() === sessionId;
        const projectChanged = projectIdForMeta(currentMeta) !== targetProject.id;
        if (projectChanged) {
          const patch = { projectId: targetProject.id };
          // 대화가 프로젝트로 이동하면 항상 대상 프로젝트의 workspace를 상속합니다.
          // 채팅 단위 workspace는 설계에서 제거되었으므로 선택지가 없습니다.
          if (targetProject.workspace) {
            patch.workspace = targetProject.workspace;
            patch.permissionMode = defaultPermissionMode(
              targetProject.defaultPermissionMode,
              targetProject.workspace
            );
          } else {
            patch.workspace = null;
            patch.permissionMode = "chat";
          }
          store.updateMeta(sessionId, patch);
          // 대화가 다른 프로젝트로 옮겨지면, 이 대화에 연결된 결정/작업의 프로젝트 연결을 정리합니다.
          const workflowMove = ensureWorkflowStore();
          if (workflowMove) workflowMove.detachChatItems(sessionId);
          refreshRoomAgents(sessionId);
        }
        if (wasActive) {
          setActiveProjectId(targetProject.id);
          setActiveSessionId(sessionId);
        }
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return {
          ...payload,
          session: wasActive ? sessionState(sessionId) : null,
        };
      })
    );

    ipcMain.handle(
      "chat:sessions:rename",
      wrap(async ({ sessionId, title }) => {
        requireSession(sessionId);
        store.renameSession(sessionId, title);
        return { ...sessionsPayload(), meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:sessions:delete",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const room = rooms.get(sessionId);
        if (room) {
          room.stopAllSilently();
          rooms.delete(sessionId);
        }
        pendingAttachments.delete(sessionId);
        store.deleteSession(sessionId);
        let nextId = getActiveSessionId();
        if (!nextId && !store.readOnly) {
          nextId = createSessionForProject().id;
        }
        if (nextId) setActiveSessionId(nextId);
        return { ...sessionsPayload(), session: nextId ? sessionState(nextId) : null };
      })
    );

    ipcMain.handle(
      "chat:send",
      wrap(async ({ sessionId, text, attachmentIds, independent, professionalDraft }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        if (room.isSpecialistLocked()) {
          throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
        }
        const pending = pendingFor(sessionId);
        const attachments = [];
        for (const id of Array.isArray(attachmentIds) ? attachmentIds : []) {
          const record = pending.get(id);
          if (record) {
            attachments.push(record);
            pending.delete(id);
          }
        }
        const entry = room.sendUserMessage({
          text,
          attachments,
          independent,
          recordOnly: Boolean(professionalDraft),
        });
        if (!entry) throw new Error("보낼 내용이 없습니다.");
        return {};
      })
    );

    ipcMain.handle(
      "chat:stop",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        getRoom(sessionId)?.stopAll();
        return {};
      })
    );

    ipcMain.handle(
      "chat:turn:interject",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        return getRoom(sessionId).interject();
      })
    );

    ipcMain.handle(
      "chat:turn:cancel",
      wrap(async ({ sessionId, turnId }) => {
        requireSession(sessionId);
        if (!getRoom(sessionId).cancelTurn(String(turnId || ""))) {
          throw new Error("이미 시작되었거나 존재하지 않는 턴입니다.");
        }
        return {};
      })
    );

    ipcMain.handle(
      "chat:discussion:start",
      wrap(async ({ sessionId, agentIds }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const cleanIds = Array.isArray(agentIds)
          ? agentIds.filter((id) => typeof id === "string")
          : undefined;
        // 토론은 오래 걸리므로 시작 확인만 동기로 반환하고, 진행은 이벤트로 전달됩니다.
        const started = room.startDiscussion({ agentIds: cleanIds });
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started
          .then((result) => {
            if (result?.ok && result.concluded) {
              recordDiscussion(sessionId).catch(() => {});
            }
          })
          .catch(() => {});
        if (result && result.ok === false) throw new Error(result.error);
        return {};
      })
    );

    ipcMain.handle(
      "chat:discussion:summarize",
      wrap(async ({ sessionId, discussionId, agentId }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const result = await room.summarizeDiscussion(discussionId, agentId);
        if (result && result.ok === false) throw new Error(result.error);
        return result || {};
      })
    );

    ipcMain.handle(
      "chat:specialist:start",
      wrap(async ({
        sessionId,
        action,
        mode,
        maxAutoRevisions,
        planAutoRevisions,
        implementationAutoRevisions,
      }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        if (!room.messages.some((message) => message.authorType === "user")) {
          throw new Error("전문 실행을 시작하려면 먼저 이 대화에 작업 요청을 남겨 주세요.");
        }
        const project = projectForSession(store.readMeta(sessionId));
        const selectedAction = ["plan", "implementation", "record", "full"].includes(action)
          ? action
          : null;
        const planned = specialistStagesFor(project, room, selectedAction || "full");
        if (!planned.ok) throw new Error(planned.error);
        // 전문 실행은 워크스페이스가 있어야 하지만, 세션 권한(meta.permissionMode)은
        // 영구히 바꾸지 않는다. 실행 동안만 유효한 run-scoped 권한은 ChatRoom이
        // withProfessionalAuthorization로 관리하므로 일반 대화 권한은 그대로 유지된다.
        const meta = store.readMeta(sessionId);
        if (!meta.workspace) {
          throw new Error(
            "전문 모드는 워크스페이스가 필요합니다. 채팅 상단의 워크스페이스 버튼으로 폴더를 먼저 선택해 주세요."
          );
        }
        const started = room.startSpecialist({
          stages: planned.stages,
          ...(selectedAction ? { action: selectedAction } : {}),
          mode: mode === "auto" ? "auto" : mode === "quick" ? "quick" : "step",
          planAutoRevisions:
            Number.isInteger(planAutoRevisions) && planAutoRevisions >= 0
              ? Math.min(planAutoRevisions, 3)
              : 0,
          implementationAutoRevisions:
            Number.isInteger(implementationAutoRevisions) && implementationAutoRevisions >= 0
              ? Math.min(implementationAutoRevisions, 3)
              : Number.isInteger(maxAutoRevisions) && maxAutoRevisions >= 0
                ? Math.min(maxAutoRevisions, 3)
                : 0,
          maxAutoRevisions:
            Number.isInteger(maxAutoRevisions) && maxAutoRevisions >= 0
              ? maxAutoRevisions
              : 1,
        });
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started
          .then((completed) => {
            if (completed?.ok && completed.recording) {
              saveRecorderOutput(project.id, completed.recording, "전문 모드 실행 요약 초안", {
                chatId: sessionId,
                recorderAgentId: planned.stages.recorder?.agent?.id || null,
              });
            }
          })
          .catch(() => {});
        // PLAN_READY 등 사람 판단을 기다리는 정상 STOP은 오류가 아닙니다.
        if (result && result.ok === false && !result.needsUserDecision && !result.cancelled) {
          throw new Error(result.error || "전문 실행을 시작하지 못했습니다.");
        }
        return { meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:specialist:resume",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const project = projectForSession(store.readMeta(sessionId));
        const recorderAgentId = room.specialistResume?.stages?.recorder?.agent?.id || null;
        const started = room.resumeSpecialist();
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started
          .then((completed) => {
            if (completed?.ok && completed.recording) {
              saveRecorderOutput(project.id, completed.recording, "전문 모드 실행 요약 초안", {
                chatId: sessionId,
                recorderAgentId,
              });
            }
          })
          .catch(() => {});
        // 단계별 실행의 다음 Gate(BUILDER_DONE/REVIEW_PASS)도 정상 STOP입니다.
        if (result && result.ok === false && !result.needsUserDecision && !result.cancelled) {
          throw new Error(result.error || "전문 실행을 이어서 진행하지 못했습니다.");
        }
        return { meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:specialist:plan-answer",
      wrap(async ({ sessionId, text }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const project = projectForSession(store.readMeta(sessionId));
        const started = room.answerPlanQuestion(text);
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started
          .then((completed) => {
            if (completed?.ok && completed.recording) {
              const recorderAgentId = room.professionalPlan?.stages?.recorder?.agent?.id || null;
              saveRecorderOutput(project.id, completed.recording, "전문 모드 실행 요약 초안", {
                chatId: sessionId,
                recorderAgentId,
              });
            }
          })
          .catch(() => {});
        if (result && result.ok === false && !result.needsUserDecision && !result.cancelled) {
          throw new Error(result.error || "기획 답변을 처리하지 못했습니다.");
        }
        return { meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:specialist:cancel",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const result = room.cancelSpecialist();
        if (!result.ok) throw new Error(result.error);
        return { meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:message:handoff",
      wrap(async ({ sessionId, targetAgentId, messageId, intent }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const result = room.handoffMessage(targetAgentId, messageId, intent);
        if (result.ok === false) throw new Error(result.error);
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    // BLOCKED 후속 처리 (keep / restore / discard).
    // discard는 되돌린 뒤 해당 Task를 폐기(rejected) 상태로 표시합니다.
    ipcMain.handle(
      "chat:specialist:blocked",
      wrap(async ({ sessionId, action }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const result = await room.resolveBlocked(action);
        if (result.ok === false) throw new Error(result.error);
        // discard: 되돌린 뒤 해당 file-backed Task를 폐기(rejected) 상태로 표시합니다.
        if (action === "discard" && result.taskPath) {
          const meta = store.readMeta(sessionId);
          const projectId = meta?.projectId || getActiveProjectId();
          const workflow = ensureWorkflowStore();
          if (workflow && !workflow.readOnly && projectId) {
            const target = workflow
              .listTasks(projectId)
              .find((task) => task.taskPath === result.taskPath);
            if (target) {
              workflow.updateTask(target.id, { status: "rejected" });
              broadcast("chat:workflow-changed", {
                projectId,
                workflow: workflowForProject(projectId),
              });
              refreshWorkflowForProject(projectId);
            }
          }
        }
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    // BLOCKED 상세 조회: renderer가 막힘 사유와 부분 변경 요약을 안전하게 읽습니다.
    ipcMain.handle(
      "chat:specialist:block-details",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        return { details: room.specialistBlockDetails() };
      })
    );

    // BLOCKED 재기획: 현재 변경을 유지(keep)하거나 작업 전으로 복원(restore)한 뒤
    // 막힌 사유를 기획자에게 전달해 재기획을 시작합니다.
    ipcMain.handle(
      "chat:specialist:replan-blocked",
      wrap(async ({ sessionId, workspaceAction }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const project = projectForSession(store.readMeta(sessionId));
        const started = room.replanBlocked(workspaceAction);
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started
          .then((completed) => {
            if (completed?.ok && completed.recording) {
              saveRecorderOutput(project.id, completed.recording, "전문 모드 실행 요약 초안", {
                chatId: sessionId,
                recorderAgentId: room.stagesForSpecialist()?.recorder?.agent?.id || null,
              });
            }
          })
          .catch(() => {});
        if (result && result.ok === false && !result.needsUserDecision && !result.cancelled) {
          throw new Error(result.error || "재기획을 시작하지 못했습니다.");
        }
        return { meta: publicMeta(store.readMeta(sessionId)), specialist: room.specialistState() };
      })
    );

    ipcMain.handle(
      "chat:approval:respond",
      wrap(async ({ sessionId, approvalId, decision }) => {
        requireSession(sessionId);
        if (!getRoom(sessionId)?.resolveApproval(approvalId, decision)) {
          throw new Error("이미 처리되었거나 존재하지 않는 권한 요청입니다.");
        }
        return {};
      })
    );

    ipcMain.handle(
      "chat:workspace:choose",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        // 워크스페이스는 이제 프로젝트 단위입니다. 세션 호출은 프로젝트로 위임합니다.
        const project = projectForSession(store.readMeta(sessionId));
        if (!project) return { canceled: true };
        const workspace = await chooseWorkspace("프로젝트 워크스페이스 선택");
        if (!workspace) return { canceled: true };
        ensureProjectStore().updateProject(project.id, { workspace });
        syncProjectWorkspaceToSessions(project.id, workspace);
        return { meta: publicMeta(store.readMeta(sessionId)), ...sessionsPayload() };
      })
    );

    ipcMain.handle(
      "chat:workspace:pick",
      wrap(async () => {
        const workspace = await chooseWorkspace("폴더 선택");
        if (!workspace) return { canceled: true };
        return { workspace };
      })
    );

    ipcMain.handle(
      "chat:workspace:clear",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        // 프로젝트 단위 해제. 같은 프로젝트의 모든 세션 권한을 chat으로 되돌립니다.
        const project = projectForSession(store.readMeta(sessionId));
        if (project) {
          ensureProjectStore().updateProject(project.id, { workspace: null });
          syncProjectWorkspaceToSessions(project.id, null);
        }
        return { meta: publicMeta(store.readMeta(sessionId)), ...sessionsPayload() };
      })
    );

    ipcMain.handle(
      "chat:permission:set",
      wrap(async ({ sessionId, mode }) => {
        requireSession(sessionId);
        if (!PERMISSION_MODES.includes(mode)) throw new Error("알 수 없는 권한 모드입니다.");
        const meta = store.readMeta(sessionId);
        if (mode !== "chat" && !meta.workspace) {
          throw new Error("먼저 워크스페이스 폴더를 선택해 주세요.");
        }
        store.updateMeta(sessionId, { permissionMode: mode });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:agent:configure",
      wrap(async ({ sessionId, agentId, patch }) => {
        requireSession(sessionId);
        const service = ensureCapabilityService();
        const record = service.getRecord(agentId);
        if (!record) throw new Error("알 수 없는 에이전트입니다.");
        const meta = store.readMeta(sessionId);
        const current = meta.agents?.[agentId] || {};
        const next = { ...current };
        if (typeof patch?.enabled === "boolean") next.enabled = patch.enabled;
        if (typeof patch?.model === "string") next.model = patch.model.slice(0, 64);
        if (typeof patch?.effort === "string") next.effort = patch.effort.slice(0, 16);
        if (typeof patch?.autoApprove === "boolean") {
          if (patch.autoApprove && meta.permissionMode !== "workspace-write") {
            throw new Error("자동 승인은 워크스페이스 쓰기 권한에서만 켤 수 있습니다.");
          }
          next.autoApprove = patch.autoApprove;
        }
        store.updateMeta(sessionId, { agents: { ...meta.agents, [agentId]: next } });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:attachments:add",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const result = await dialog.showOpenDialog(chatWindow || undefined, {
          properties: ["openFile", "multiSelections"],
          title: "첨부할 파일 선택",
        });
        if (result.canceled) return { attachments: [], errors: [] };
        return importPaths(sessionId, result.filePaths || []);
      })
    );

    ipcMain.handle(
      "chat:attachments:add-dropped",
      wrap(async ({ sessionId, paths }) => {
        requireSession(sessionId);
        const cleanPaths = (Array.isArray(paths) ? paths : [])
          .filter((entry) => typeof entry === "string" && entry.trim())
          .slice(0, 10);
        return importPaths(sessionId, cleanPaths);
      })
    );

    ipcMain.handle(
      "chat:attachments:remove",
      wrap(async ({ sessionId, attachmentId }) => {
        requireSession(sessionId);
        const pending = pendingFor(sessionId);
        const record = pending.get(String(attachmentId || ""));
        pending.delete(String(attachmentId || ""));
        // 미전송 첨부만 취소한 경우에만 복사본을 함께 삭제해 디스크 낭비를 막습니다.
        // 전송이 완료돼 대화에 저장된 첨부는 여기서 지우지 않습니다.
        if (record?.fileName) {
          try {
            const filePath = path.join(store.attachmentsDir(sessionId), record.fileName);
            if (path.dirname(filePath) === path.normalize(store.attachmentsDir(sessionId))) {
              fs.unlinkSync(filePath);
            }
          } catch {
            // 파일이 이미 없거나 삭제할 수 없어도 첨부 목록에서는 제거합니다.
          }
        }
        return { pendingAttachments: [...pending.values()].map(publicAttachment) };
      })
    );

    ipcMain.handle(
      "chat:attachments:preview",
      wrap(async ({ sessionId, attachmentId }) => {
        requireSession(sessionId);
        const record = findAttachmentRecord(sessionId, String(attachmentId || ""));
        if (!record || !record.fileName) throw new Error("첨부를 찾을 수 없습니다.");
        const preview = readImagePreview({
          attachmentsDir: store.attachmentsDir(sessionId),
          fileName: record.fileName,
        });
        if (!preview.ok) throw new Error(preview.error);
        return { dataUrl: preview.dataUrl };
      })
    );

    ipcMain.on("chat:minimize", () => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.minimize();
    });
    ipcMain.on("chat:maximize", () => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        if (chatWindow.isMaximized()) chatWindow.unmaximize();
        else chatWindow.maximize();
      }
    });
    ipcMain.on("chat:close", () => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
    });
  }

  function importPaths(sessionId, filePaths) {
    const pending = pendingFor(sessionId);
    const attachments = [];
    const errors = [];
    let sessionBytes = store.sessionAttachmentsSize(sessionId);
    const sourceCount = filePaths.length;
    for (const filePath of filePaths.slice(0, 10)) {
      const result = importAttachment({
        sourcePath: filePath,
        attachmentsDir: store.attachmentsDir(sessionId),
        currentSessionBytes: sessionBytes,
      });
      if (result.ok) {
        sessionBytes += result.attachment.size;
        pending.set(result.attachment.id, result.attachment);
        attachments.push(publicAttachment(result.attachment));
      } else {
        errors.push({ name: path.basename(String(filePath)), error: result.error });
      }
    }
    if (sourceCount > 10) {
      errors.push({ name: "첨부 제한", error: `한 번에 최대 10개까지 첨부할 수 있습니다. (${sourceCount - 10}개 제외)` });
    }
    return {
      attachments,
      errors,
      pendingAttachments: [...pending.values()].map(publicAttachment),
    };
  }

  function openWindow() {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
      return chatWindow;
    }
    chatWindow = createChatWindow({
      BrowserWindow,
      onReady: () => {
        if (typeof onWindowReady === "function") onWindowReady(chatWindow);
      },
      onClosed: () => {
        chatWindow = null;
      },
    });
    return chatWindow;
  }

  function getWindow() {
    return chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
  }

  // 앱 종료: 진행 중이던 세션은 interrupted로 남겨 다음 시작 때 안내합니다.
  function shutdown() {
    shuttingDown = true;
    for (const [sessionId, room] of rooms) {
      try {
        if (room.activeRuns > 0 && store && !store.readOnly) {
          store.setSessionStatus(sessionId, "running");
        } else if (store && !store.readOnly) {
          const meta = store.readMeta(sessionId);
          if (meta && meta.status === "running") store.setSessionStatus(sessionId, "idle");
        }
        room.stopAllSilently();
      } catch {}
    }
  }

  return { registerIpcHandlers, openWindow, getWindow, shutdown, showSystemNotice };
}

module.exports = {
  createChatFeature,
  publicMeta,
  publicAttachment,
  attachmentContextLines,
  createRunLogWriter,
  persistInvocationMetrics,
  MAX_RUN_LOG_FILES,
};
