﻿const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore } = require("./chat-store");
const {
  ProjectStore,
  UNCATEGORIZED_PROJECT_ID,
  sessionDefaultsFromProject,
  migrateSessionsToProjects,
} = require("../agora/project-store");
const {
  WorkflowStore,
  TASK_STATUSES,
  ROLE_DEFS,
} = require("../agora/workflow-store");
const {
  createCapabilityService,
  toPublicProviders,
} = require("../providers/provider-capabilities");
const { toDiagnostics } = require("../providers/provider-diagnostics");
const { roomAgentsFromCapabilities } = require("./chat-agents");
const { ChatRoom, DEFAULT_DISCUSSION_RUN_BUDGET } = require("./chat-room");
const { buildAgentInvocation, PERMISSION_MODES, INLINE_TEXT_LIMIT } = require("./chat-argv");
const { createLineParser } = require("./chat-events");
const { runAgentProcess } = require("./chat-agent-runner");
const {
  importAttachment,
  readImagePreview,
  readInlineText,
} = require("./chat-attachments");
const { createChatWindow } = require("./chat-window");

// 채팅 기능 ?�체(?�?�소·?�션·?�로바이???�행·IPC·�?�?묶는 조립 모듈.
// main.js??createChatFeature() ??번과 openWindow()/shutdown()�??�출?�니??

// ?�션별로 ?�겨?�는 ?�행 ?�본 로그 개수. 진단?�는 최근 ?�행�??�요?��?�?// 무한???�이지 ?�게 ?�래???�일부??지?�니??
const MAX_RUN_LOG_FILES = 20;

// ?�행 ?�본 stdout???�일�??�려보내??writer.
// 메모리에 ?�체�??�고 ?��? ?�으므�?출력???�무�?길어??진단 ?�보�??�길 ???�습?�다.
// ?�일??만들 ???�는 ?�경?�서??조용??비활?�화?�고 ?�행?�는 ?�향??주�? ?�습?�다.
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
      } catch {
        failed = true;
      }
    },
    close() {
      const closedPath = filePath;
      if (stream) {
        try {
          // ?�리??flush ?�후???�니?? 그렇지 ?�으�?방금 만든 로그??mtime??          // ?�직 갱신?��? ?�아 ?�스�???�� ?�?�이 ?????�습?�다.
          stream.end(() => pruneRunLogs(store, sessionId, closedPath));
        } catch {}
      } else if (closedPath) {
        pruneRunLogs(store, sessionId, closedPath);
      }
      return failed ? null : filePath;
    },
  };
}

// ?�래???�행 로그�??�리?�니?? ?�패?�도 ?�행?�는 ?�향??주�? ?�습?�다.
// keepPath�?지?�한 ?�일(방금 기록??로그)?� ??�� 보존?�니??
function pruneRunLogs(store, sessionId, keepPath = null) {
  try {
    const dir = store.runLogsDir(sessionId);
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
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
    // keepPath가 ?��? ???�리�?차�??��?�??�길 개수?�서 ?�외?�니??
    const keepCount = keepPath ? Math.max(0, MAX_RUN_LOG_FILES - 1) : MAX_RUN_LOG_FILES;
    for (const entry of entries.slice(keepCount)) {
      try {
        fs.rmSync(entry.full, { force: true });
      } catch {}
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

// renderer�?보내??첨�? ?�코?? ?�본 경로/?�??경로???�외?�니??
// fileName?� ?�용 ?�시??경로 ?�보가 ?��?�? 뷰에?�는 ?��? ?�습?�다.
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
        lines.push(`=== 첨�? ?�일: ${attachment.name} ===`);
        lines.push(text);
        lines.push("=== 첨�? ??===");
      } else {
        delivery.method = "unsupported";
      }
    } else if (delivery.method === "path") {
      lines.push(
        `첨�? ?�일 "${attachment.name}" 경로: ${path.join(attachmentsDir, attachment.fileName)} (?�기 ?�구�??????�습?�다)`
      );
    } else if (delivery.method === "native-image") {
      lines.push(`(?��?지 "${attachment.name}"가 ?�께 ?�달?�었?�니??)`);
    } else if (delivery.method === "unsupported") {
      lines.push(`(첨�? "${attachment.name}"?????�이?�트�??�달?????�었?�니??)`);
    }
  }
  return lines;
}

function createChatFeature(options) {
  const { electron, onWindowReady } = options;
  const { ipcMain, dialog, BrowserWindow, shell } = electron;

  // 출력 hard limit?� ?�용???�정?�니?? ?�정???�거??0 ?�하?�면 ?�한 ?�이 ?�행?�니??
  // getHardOutputLimitBytes�?주입?��? ?�으�??�한?� ??�� 비활?�입?�다.
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
  let capabilityService = null;
  let chatWindow = null;
  let shuttingDown = false;
  const rooms = new Map();
  // ?�션�?"?�직 ?�송 ?? 첨�?: id ???��? ?�코??fileName ?�함)
  const pendingAttachments = new Map();

  function ensureStore() {
    if (store || storeError) return store;
    try {
      store = new ChatStore({ root: options.storeRoot }).init();
    } catch (error) {
      storeError = error?.message || String(error);
      console.warn("[agora] 채팅 ?�?�소 초기???�패:", storeError);
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
      console.warn("[agora] ?�로?�트 ?�?�소 초기???�패:", projectStoreError);
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
      console.warn("[agora] ?�업 기록 ?�?�소 초기???�패:", workflowStoreError);
    }
    return workflowStore;
  }

  function ensureCapabilityService() {
    if (capabilityService) return capabilityService;
    capabilityService = createCapabilityService({
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
      throw new Error("?�택???�더�??�인?????�습?�다.");
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
      readOnly: Boolean(store?.readOnly || storeError || projectStoreError || workflowStoreError),
    };
  }

  function pendingFor(sessionId) {
    if (!pendingAttachments.has(sessionId)) pendingAttachments.set(sessionId, new Map());
    return pendingAttachments.get(sessionId);
  }

  // ?�션 ?�?�에 ?��? ?�?�된 첨�??�서 id�??��? ?�코?��? 찾습?�다(미리보기??.
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
    return ({ agent, prompt, runId, attachments, emitEvent, autoApprove = false }) => {
      const record = ensureCapabilityService().getRecord(agent.id);
      const meta = store?.readMeta(sessionId);
      if (!record || !meta) {
        return {
          promise: Promise.resolve({ ok: false, error: "?�션 ?�보�??��? 못했?�니??" }),
          cancel: () => {},
        };
      }
      const config = meta.agents?.[agent.id] || {};
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
        permissionMode: meta.permissionMode || "chat",
        workspace: meta.workspace || null,
        model: agent.model,
        effort: agent.effort,
        attachments: enriched,
        chatCwd: store.runtimeChatDir(),
        attachmentsDir,
        outputFile,
        autoApprove: (meta.permissionMode || "chat") === "workspace-write" && Boolean(config.autoApprove || autoApprove),
      });
      if (!invocation.ok) {
        return {
          promise: Promise.resolve({ ok: false, error: invocation.error }),
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

      // ?�본 출력?� ?�요???�만 ?�일�??�려보냅?�다. 메모리에 ?�체�??�고 ?��? ?�으므�?      // ?�주 �??�행?�서??진단 ?�보�??��? ?�습?�다.
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
        // 출력??길다???�유�??�행??죽이지 ?�습?�다. hard limit?� ?�용?��?
        // 명시?�으�?켜�? ?�으�?undefined(=?�한 ?�음)�??�습?�다.
        ...(Number.isFinite(options.captureOutputBytes) && options.captureOutputBytes > 0
          ? { captureOutputBytes: options.captureOutputBytes }
          : {}),
        ...(hardOutputLimitBytes ? { hardOutputLimitBytes } : {}),
        onRawChunk: rawLog.write,
      });
      return {
        promise: run.promise.then((result) => {
          const logPath = rawLog.close();
          // renderer?�는 ?�일 ?�스??경로�?보내지 ?�습?�다(기존 보안 경계 ?��?).
          // 진단?�는 ?�일 ?�름�??�출?�고, ?�제 경로??main ?�로?�스?�만 ?�니??
          const diagnostics =
            result.output || logPath
              ? {
                  ...(result.output || {}),
                  ...(logPath ? { rawLogName: path.basename(logPath) } : {}),
                }
              : null;
          const enrichedResult = diagnostics ? { ...result, output: diagnostics } : result;
          return enrichedResult.ok
            ? { ...enrichedResult, deliveries: invocation.deliveries }
            : enrichedResult;
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

  function roomMeta(meta) {
    const project = projectForSession(meta);
    return {
      permissionMode: meta?.permissionMode || "chat",
      projectContext: project?.context || "",
    };
  }

  function getRoom(sessionId) {
    if (rooms.has(sessionId)) return rooms.get(sessionId);
    if (!ensureStore()) return null;
    const session = store.getSession(sessionId);
    if (!session) return null;

    const room = new ChatRoom({
      sessionId,
      agents: buildRoomAgents(session.meta),
      initialMessages: session.messages,
      runAgent: makeRunAgent(sessionId),
      prepareAgent: options.prepareAgent,
      meta: roomMeta(session.meta),
    });

    room.on("message", (message) => {
      store.appendEvent(sessionId, { kind: "message", message });
      // renderer로는 첨�? ?��? ?�코??fileName/sha256)�??�거???�본�?보냅?�다.
      const outbound = message.attachments
        ? { ...message, attachments: message.attachments.map(publicAttachment) }
        : message;
      broadcast("chat:message", { sessionId, message: outbound });
      broadcast("chat:sessions-changed", sessionsPayload());
    });
    room.on("typing", (payload) => broadcast("chat:typing", { sessionId, ...payload }));
    room.on("turn-state", (payload) => broadcast("chat:turn-state", { sessionId, ...payload }));
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
      pendingAttachments: [...pendingFor(sessionId).values()].map(publicAttachment),
    };
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
      // ?�?�소 문제???�드 ?�패가 ?�니??경고 배너�??�달?�니??
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
    if (!ensureStore()) throw new Error(storeError || "?�?�소�??�용?????�습?�다.");
    if (!sessionId || !store.hasSession(sessionId)) throw new Error("?�션??찾을 ???�습?�다.");
  }

  function requireProject(projectId) {
    const projects = ensureProjectStore();
    if (!projects) throw new Error(projectStoreError || "?�로?�트 ?�?�소�??�용?????�습?�다.");
    const project = projects.getProject(projectId);
    if (!project) throw new Error("?�로?�트�?찾을 ???�습?�다.");
    if (project.readOnly) throw new Error("???�로?�트?????�로??버전?�서 만들?�져 ?�기 ?�용?�니??");
    return project;
  }

  function requireSessionForProject(sessionId, projectId) {
    if (!sessionId) return null;
    requireSession(sessionId);
    if (projectIdForMeta(store.readMeta(sessionId)) !== projectId) {
      throw new Error("?�택??채팅???�로?�트???�하지 ?�습?�다.");
    }
    return sessionId;
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
        if (!allowedUrls.has(url)) throw new Error("?�용?��? ?��? ?��? 주소?�니??");
        await shell.openExternal(url);
        return {};
      })
    );

    ipcMain.handle(
      "chat:projects:create",
      wrap(async ({ name, workspace }) => {
        if (!ensureStore()) throw new Error(storeError || "?�?�소�??�용?????�습?�다.");
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
        const workspace = await chooseWorkspace("?�로?�트 ?�크?�페?�스 ?�택");
        if (!workspace) return { canceled: true, ...sessionsPayload() };
        const project = ensureProjectStore().updateProject(projectId, { workspace });
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
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        return { ...payload, project };
      })
    );

    ipcMain.handle(
      "chat:projects:delete",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId);
        if (project.id === UNCATEGORIZED_PROJECT_ID) {
          throw new Error("기본 ?�로?�트????��?????�습?�다.");
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
          throw new Error("?�로?�트�???��?��? 못했?�니??");
        }
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
        return { ...payload, decision };
      })
    );

    ipcMain.handle(
      "chat:decisions:update",
      wrap(async ({ projectId, decisionId, patch }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getDecision(decisionId);
        if (!current || current.projectId !== project.id) throw new Error("결정??찾을 ???�습?�다.");
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
        return { ...payload, decision };
      })
    );

    ipcMain.handle(
      "chat:decisions:delete",
      wrap(async ({ projectId, decisionId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getDecision(decisionId);
        if (!current || current.projectId !== project.id) throw new Error("결정??찾을 ???�습?�다.");
        if (workflow.listTasks(project.id).some((task) => task.decisionId === decisionId)) {
          throw new Error("연결된 작업이 있어 결정을 삭제할 수 없습니다.")
        }
        workflow.deleteDecision(decisionId);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
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
          if (!decision || decision.projectId !== project.id) throw new Error("?�결??결정??찾을 ???�습?�다.");
        }
        const selectedRole = ROLE_DEFS.some((entry) => entry.id === role) ? role : "implementation";
        const task = workflow.createTask({
          projectId: project.id,
          title,
          description,
          status,
          role: selectedRole,
          agentId: agentId || project.defaultRoles?.[selectedRole] || null,
          decisionId,
          chatId: sourceChatId,
        });
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        return { ...payload, task };
      })
    );

    ipcMain.handle(
      "chat:tasks:update",
      wrap(async ({ projectId, taskId, patch }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getTask(taskId);
        if (!current || current.projectId !== project.id) throw new Error("?�업??찾을 ???�습?�다.");
        if (patch?.decisionId) {
          const decision = workflow.getDecision(patch.decisionId);
          if (!decision || decision.projectId !== project.id) throw new Error("?�결??결정??찾을 ???�습?�다.");
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
        return { ...payload, task };
      })
    );

    ipcMain.handle(
      "chat:tasks:delete",
      wrap(async ({ projectId, taskId }) => {
        const project = requireProject(projectId || getActiveProjectId());
        const workflow = ensureWorkflowStore();
        const current = workflow.getTask(taskId);
        if (!current || current.projectId !== project.id) throw new Error("?�업??찾을 ???�습?�다.");
        workflow.deleteTask(taskId);
        const payload = sessionsPayload();
        broadcast("chat:sessions-changed", payload);
        broadcast("chat:workflow-changed", { projectId: project.id, workflow: workflowForProject(project.id) });
        return payload;
      })
    );

    ipcMain.handle(
      "chat:sessions:create",
      wrap(async () => {
        if (!ensureStore()) throw new Error(storeError || "?�?�소�??�용?????�습?�다.");
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
        if (projectIdForMeta(currentMeta) !== targetProject.id) {
          store.updateMeta(sessionId, { projectId: targetProject.id });
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
      wrap(async ({ sessionId, text, attachmentIds }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const pending = pendingFor(sessionId);
        const attachments = [];
        for (const id of Array.isArray(attachmentIds) ? attachmentIds : []) {
          const record = pending.get(id);
          if (record) {
            attachments.push(record);
            pending.delete(id);
          }
        }
        const entry = room.sendUserMessage({ text, attachments });
        if (!entry) throw new Error("보낼 ?�용???�습?�다.");
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
          throw new Error("?��? ?�작?�었거나 존재?��? ?�는 ?�입?�다.");
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
        // ?�론?� ?�래 걸리므�??�작 ?�인�??�기�?반환?�고, 진행?� ?�벤?�로 ?�달?�니??
        const started = room.startDiscussion({ agentIds: cleanIds });
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started.catch(() => {});
        if (result && result.ok === false) throw new Error(result.error);
        return {};
      })
    );

    ipcMain.handle(
      "chat:approval:respond",
      wrap(async ({ sessionId, approvalId, decision }) => {
        requireSession(sessionId);
        if (!getRoom(sessionId)?.resolveApproval(approvalId, decision)) {
          throw new Error("?��? 처리?�었거나 존재?��? ?�는 권한 ?�청?�니??");
        }
        return {};
      })
    );

    ipcMain.handle(
      "chat:workspace:choose",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        // ?�크?�페?�스 경로???�일??출처: OS ?�더 ?�택 ?�?�상??
        const workspace = await chooseWorkspace("?�션 ?�크?�페?�스 ?�택");
        if (!workspace) return { canceled: true };
        store.updateMeta(sessionId, { workspace });
        refreshRoomAgents(sessionId);
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
        // ?�크?�페?�스가 ?�으�?workspace 권한 모드???��?가 ?�어 chat?�로 ?�돌립니??
        store.updateMeta(sessionId, { workspace: null, permissionMode: "chat" });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)), ...sessionsPayload() };
      })
    );

    ipcMain.handle(
      "chat:permission:set",
      wrap(async ({ sessionId, mode }) => {
        requireSession(sessionId);
        if (!PERMISSION_MODES.includes(mode)) throw new Error("?????�는 권한 모드?�니??");
        const meta = store.readMeta(sessionId);
        if (mode !== "chat" && !meta.workspace) {
          throw new Error("먼�? ?�크?�페?�스 ?�더�??�택??주세??");
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
        if (!record) throw new Error("?????�는 ?�이?�트?�니??");
        const meta = store.readMeta(sessionId);
        const current = meta.agents?.[agentId] || {};
        const next = { ...current };
        if (typeof patch?.enabled === "boolean") next.enabled = patch.enabled;
        if (typeof patch?.model === "string") next.model = patch.model.slice(0, 64);
        if (typeof patch?.effort === "string") next.effort = patch.effort.slice(0, 16);
        if (typeof patch?.autoApprove === "boolean") {
          if (patch.autoApprove && meta.permissionMode !== "workspace-write") {
            throw new Error("?�동 ?�인?� ?�크?�페?�스 ?�기 권한?�서�?�????�습?�다.");
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
          title: "첨�????�일 ?�택",
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
        pendingFor(sessionId).delete(String(attachmentId || ""));
        return { pendingAttachments: [...pendingFor(sessionId).values()].map(publicAttachment) };
      })
    );

    ipcMain.handle(
      "chat:attachments:preview",
      wrap(async ({ sessionId, attachmentId }) => {
        requireSession(sessionId);
        const record = findAttachmentRecord(sessionId, String(attachmentId || ""));
        if (!record || !record.fileName) throw new Error("첨�?�?찾을 ???�습?�다.");
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

  // ??종료: 진행 중이???�션?� interrupted�??�겨 ?�음 ?�작 ???�내?�니??
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

  return { registerIpcHandlers, openWindow, getWindow, shutdown };
}

module.exports = {
  createChatFeature,
  publicMeta,
  publicAttachment,
  attachmentContextLines,
  createRunLogWriter,
  MAX_RUN_LOG_FILES,
};
