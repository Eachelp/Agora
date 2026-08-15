const { contextBridge, ipcRenderer, webUtils } = require("electron");

// invoke 채널은 모두 { ok, ... } 형태로 응답합니다.
const INVOKE = Object.freeze({
  STATE: "chat:state",
  PROVIDERS_REFRESH: "chat:providers:refresh",
  OPEN_EXTERNAL: "chat:open-external",
  OPEN_SETTINGS: "chat:open-settings",
  USAGE: "chat:usage",
  PROJECTS_CREATE: "chat:projects:create",
  PROJECTS_SELECT: "chat:projects:select",
  PROJECTS_UPDATE: "chat:projects:update",
  PROJECTS_DELETE: "chat:projects:delete",
  PROJECTS_WORKSPACE_CHOOSE: "chat:projects:workspace:choose",
  WORKSPACE_PICK: "chat:workspace:pick",
  PROJECTS_WORKSPACE_CLEAR: "chat:projects:workspace:clear",
  MEMORY_READ: "chat:memory:read",
  MEMORY_APPEND: "chat:memory:append",
  RULES_READ: "chat:memory:rules:read",
  RULES_SAVE: "chat:memory:rules:save",
  DECISIONS_CREATE: "chat:decisions:create",
  DECISIONS_UPDATE: "chat:decisions:update",
  DECISIONS_DELETE: "chat:decisions:delete",
  DECISIONS_RESOLVE: "chat:decisions:resolve",
  TASKS_CREATE: "chat:tasks:create",
  TASKS_UPDATE: "chat:tasks:update",
  TASKS_DELETE: "chat:tasks:delete",
  TASKS_RESOLVE: "chat:tasks:resolve",
  SESSIONS_CREATE: "chat:sessions:create",
  SESSIONS_SELECT: "chat:sessions:select",
  SESSIONS_MOVE: "chat:sessions:move",
  SESSIONS_RENAME: "chat:sessions:rename",
  SESSIONS_DELETE: "chat:sessions:delete",
  SEND: "chat:send",
  STOP: "chat:stop",
  TURN_INTERJECT: "chat:turn:interject",
  TURN_CANCEL: "chat:turn:cancel",
  DISCUSSION_START: "chat:discussion:start",
  SPECIALIST_START: "chat:specialist:start",
  SPECIALIST_PLAN_ANSWER: "chat:specialist:plan-answer",
  SPECIALIST_RESUME: "chat:specialist:resume",
  SPECIALIST_CANCEL: "chat:specialist:cancel",
  SPECIALIST_BLOCKED: "chat:specialist:blocked",
  SPECIALIST_BLOCK_DETAILS: "chat:specialist:block-details",
  SPECIALIST_REPLAN_BLOCKED: "chat:specialist:replan-blocked",
  TASK_OPEN_FILE: "chat:task:open-file",
  TASK_READ_FILE: "chat:task:read-file",
  MESSAGE_HANDOFF: "chat:message:handoff",
  APPROVAL_RESPOND: "chat:approval:respond",
  WORKSPACE_CHOOSE: "chat:workspace:choose",
  WORKSPACE_CLEAR: "chat:workspace:clear",
  PERMISSION_SET: "chat:permission:set",
  AGENT_CONFIGURE: "chat:agent:configure",
  ATTACH_ADD: "chat:attachments:add",
  ATTACH_ADD_DROPPED: "chat:attachments:add-dropped",
  ATTACH_REMOVE: "chat:attachments:remove",
  ATTACH_PREVIEW: "chat:attachments:preview",
});

function subscribe(channel, handler) {
  if (typeof handler !== "function") return () => {};
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("chatApi", {
  state: (input) => ipcRenderer.invoke(INVOKE.STATE, input),
  providersRefresh: () => ipcRenderer.invoke(INVOKE.PROVIDERS_REFRESH),
  openExternal: (url) => ipcRenderer.invoke(INVOKE.OPEN_EXTERNAL, { url }),
  openSettings: (section) => ipcRenderer.send(INVOKE.OPEN_SETTINGS, section),
  usage: (force = false) => ipcRenderer.invoke(INVOKE.USAGE, { force }),

  projectsCreate: (name, workspace) => ipcRenderer.invoke(INVOKE.PROJECTS_CREATE, { name, workspace }),
  projectsSelect: (projectId) => ipcRenderer.invoke(INVOKE.PROJECTS_SELECT, { projectId }),
  projectsUpdate: (projectId, patch) =>
    ipcRenderer.invoke(INVOKE.PROJECTS_UPDATE, { projectId, patch }),
  projectsDelete: (projectId) => ipcRenderer.invoke(INVOKE.PROJECTS_DELETE, { projectId }),
  workspacePick: () => ipcRenderer.invoke(INVOKE.WORKSPACE_PICK),
  projectsWorkspaceChoose: (projectId) =>
    ipcRenderer.invoke(INVOKE.PROJECTS_WORKSPACE_CHOOSE, { projectId }),
  projectsWorkspaceClear: (projectId) =>
    ipcRenderer.invoke(INVOKE.PROJECTS_WORKSPACE_CLEAR, { projectId }),
  memoryRead: (projectId) => ipcRenderer.invoke(INVOKE.MEMORY_READ, { projectId }),
  memoryAppend: (projectId, content, title) =>
    ipcRenderer.invoke(INVOKE.MEMORY_APPEND, { projectId, content, title }),
  rulesRead: (projectId) => ipcRenderer.invoke(INVOKE.RULES_READ, { projectId }),
  rulesSave: (projectId, content) => ipcRenderer.invoke(INVOKE.RULES_SAVE, { projectId, content }),

  decisionsCreate: (input) => ipcRenderer.invoke(INVOKE.DECISIONS_CREATE, input),
  decisionsUpdate: (projectId, decisionId, patch) =>
    ipcRenderer.invoke(INVOKE.DECISIONS_UPDATE, { projectId, decisionId, patch }),
  decisionsDelete: (projectId, decisionId) =>
    ipcRenderer.invoke(INVOKE.DECISIONS_DELETE, { projectId, decisionId }),
  decisionsResolve: (projectId, ids, action) =>
    ipcRenderer.invoke(INVOKE.DECISIONS_RESOLVE, { projectId, ids, action }),
  tasksCreate: (input) => ipcRenderer.invoke(INVOKE.TASKS_CREATE, input),
  tasksUpdate: (projectId, taskId, patch) =>
    ipcRenderer.invoke(INVOKE.TASKS_UPDATE, { projectId, taskId, patch }),
  tasksDelete: (projectId, taskId) => ipcRenderer.invoke(INVOKE.TASKS_DELETE, { projectId, taskId }),
  tasksResolve: (projectId, ids, action) =>
    ipcRenderer.invoke(INVOKE.TASKS_RESOLVE, { projectId, ids, action }),

  sessionsCreate: () => ipcRenderer.invoke(INVOKE.SESSIONS_CREATE),
  sessionsSelect: (sessionId) => ipcRenderer.invoke(INVOKE.SESSIONS_SELECT, { sessionId }),
  sessionsMove: (sessionId, projectId, applyProjectWorkspace = false) =>
    ipcRenderer.invoke(INVOKE.SESSIONS_MOVE, { sessionId, projectId, applyProjectWorkspace }),
  sessionsRename: (sessionId, title) =>
    ipcRenderer.invoke(INVOKE.SESSIONS_RENAME, { sessionId, title }),
  sessionsDelete: (sessionId) => ipcRenderer.invoke(INVOKE.SESSIONS_DELETE, { sessionId }),

  send: (sessionId, text, attachmentIds, independent = false) =>
    ipcRenderer.invoke(INVOKE.SEND, { sessionId, text, attachmentIds, independent }),
  stop: (sessionId) => ipcRenderer.invoke(INVOKE.STOP, { sessionId }),
  turnInterject: (sessionId) => ipcRenderer.invoke(INVOKE.TURN_INTERJECT, { sessionId }),
  turnCancel: (sessionId, turnId) =>
    ipcRenderer.invoke(INVOKE.TURN_CANCEL, { sessionId, turnId }),
  discussionStart: (sessionId, agentIds) =>
    ipcRenderer.invoke(INVOKE.DISCUSSION_START, { sessionId, agentIds }),
  specialistStart: (sessionId, options = {}) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_START, { sessionId, ...options }),
  specialistPlanAnswer: (sessionId, text) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_PLAN_ANSWER, { sessionId, text }),
  specialistResume: (sessionId) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_RESUME, { sessionId }),
  specialistCancel: (sessionId) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_CANCEL, { sessionId }),
  specialistResolveBlocked: (sessionId, action) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_BLOCKED, { sessionId, action }),
  specialistBlockDetails: (sessionId) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_BLOCK_DETAILS, { sessionId }),
  specialistReplanBlocked: (sessionId, workspaceAction) =>
    ipcRenderer.invoke(INVOKE.SPECIALIST_REPLAN_BLOCKED, { sessionId, workspaceAction }),
  openTaskFile: (sessionId, taskPath) =>
    ipcRenderer.invoke(INVOKE.TASK_OPEN_FILE, { sessionId, taskPath }),
  readTaskFile: (sessionId, taskPath) =>
    ipcRenderer.invoke(INVOKE.TASK_READ_FILE, { sessionId, taskPath }),
  handoffMessage: (sessionId, targetAgentId, messageId, intent) =>
    ipcRenderer.invoke(INVOKE.MESSAGE_HANDOFF, { sessionId, targetAgentId, messageId, intent }),
  approvalRespond: (sessionId, approvalId, decision) =>
    ipcRenderer.invoke(INVOKE.APPROVAL_RESPOND, { sessionId, approvalId, decision }),

  workspaceChoose: (sessionId) => ipcRenderer.invoke(INVOKE.WORKSPACE_CHOOSE, { sessionId }),
  workspaceClear: (sessionId) => ipcRenderer.invoke(INVOKE.WORKSPACE_CLEAR, { sessionId }),
  permissionSet: (sessionId, mode) =>
    ipcRenderer.invoke(INVOKE.PERMISSION_SET, { sessionId, mode }),
  agentConfigure: (sessionId, agentId, patch) =>
    ipcRenderer.invoke(INVOKE.AGENT_CONFIGURE, { sessionId, agentId, patch }),

  attachmentsAdd: (sessionId) => ipcRenderer.invoke(INVOKE.ATTACH_ADD, { sessionId }),
  attachmentsAddDropped: (sessionId, paths) =>
    ipcRenderer.invoke(INVOKE.ATTACH_ADD_DROPPED, { sessionId, paths }),
  attachmentsRemove: (sessionId, attachmentId) =>
    ipcRenderer.invoke(INVOKE.ATTACH_REMOVE, { sessionId, attachmentId }),
  attachmentsPreview: (sessionId, attachmentId) =>
    ipcRenderer.invoke(INVOKE.ATTACH_PREVIEW, { sessionId, attachmentId }),

  // 드래그된 File 객체 → 절대 경로 (main에서 다시 검증됩니다)
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  onMessage: (handler) => subscribe("chat:message", handler),
  onTyping: (handler) => subscribe("chat:typing", handler),
  onTurnState: (handler) => subscribe("chat:turn-state", handler),
  onSpecialistResumeState: (handler) => subscribe("chat:specialist-resume-state", handler),
  onReset: (handler) => subscribe("chat:reset", handler),
  onRunEvent: (handler) => subscribe("chat:run-event", handler),
  onSessionsChanged: (handler) => subscribe("chat:sessions-changed", handler),
  onWorkflowChanged: (handler) => subscribe("chat:workflow-changed", handler),
  onAgents: (handler) => subscribe("chat:agents", handler),
  onApprovalRequest: (handler) => subscribe("chat:approval-request", handler),
  onSystemNotice: (handler) => subscribe("chat:system-notice", handler),
  onAppearance: (handler) => subscribe("appearance:update", handler),
  onMaximizedState: (handler) => subscribe("chat:maximized-state", handler),

  minimize: () => ipcRenderer.send("chat:minimize"),
  maximize: () => ipcRenderer.send("chat:maximize"),
  close: () => ipcRenderer.send("chat:close"),
});
