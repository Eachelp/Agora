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
} = require("../agora/project-store");
const {
  WorkflowStore,
  TASK_STATUSES,
  ROLE_DEFS,
} = require("../agora/workflow-store");
const { MemoryStore } = require("../agora/memory-store");
const { WorkspaceMutationLease } = require("../agora/workspace-mutation-lease");
const { parseRecorderOutput } = require("../agora/recorder-output");
const {
  createCapabilityService,
  claudeResolvedModelLabel,
  claudeObservationContext,
  toPublicProviders,
} = require("../providers/provider-capabilities");
const { toDiagnostics } = require("../providers/provider-diagnostics");
const { roomAgentsFromCapabilities, GROUP_ALIASES } = require("./chat-agents");
const { parseMentions, hasLegacyRoleMention } = require("./chat-mention");
const {
  ChatRoom,
  DEFAULT_DISCUSSION_RUN_BUDGET,
  clampDiscussionTurnBudget,
} = require("./chat-room");
const { DISCUSSION_PRESETS, maxCycleBudget } = require("../agora/discussion-protocol");
const {
  buildAgentInvocation,
  PERMISSION_MODES,
  INLINE_TEXT_LIMIT,
  minPermissionMode,
} = require("./chat-argv");
const { createLineParser } = require("./chat-events");
const { ProcessHarnessAdapter } = require("../harness/process-harness-adapter");
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
// 앱을 켜 둔 동안 CLI 버전·로그인·모델 목록을 다시 확인하는 간격입니다.
// (버전 확인은 가볍고, 모델 카탈로그는 캐시 TTL이 지났을 때만 다시 조회합니다.)
const PROVIDER_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
// 옛 역할 호출(@기획자 등)을 받았을 때 chat:send가 돌려주는 안내.
const LEGACY_ROLE_NOTICE =
  "역할 호출·팀 실행은 없어졌습니다. @claude / @gpt / @gemini로 부르거나 오케스트레이터 모드를 쓰세요.";
// Stage D-0 workspace mutation provenance journal의 상한(process 수명 기준).
const MAX_WORKSPACE_MUTATION_EVENTS = 2000;

// end() 이후 파일 핸들이 실제로 닫힐 때까지의 Promise. 세션 삭제가 기다린다(Windows는 열린 파일이 있으면
// 폴더를 옮기거나 지울 수 없다).
const closingRunLogs = new Set();

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
          const closed = new Promise((resolve) => (stream.closed ? resolve() : stream.once("close", resolve)));
          stream.end(() => pruneRunLogs(store, sessionId, closedPath));
          closingRunLogs.add(closed);
          closed.then(() => closingRunLogs.delete(closed));
        } catch {}
      } else if (closedPath) {
        pruneRunLogs(store, sessionId, closedPath);
      }
      return failed ? null : filePath;
    },
  };
}

function persistInvocationMetrics({ store, sessionId, runId, agent, result }) {
  if (!result?.runMetrics) return false;
  const saved = persistRunMetrics({
    store,
    sessionId,
    runId,
    provider: agent?.id || null,
    model: agent?.model || null,
    effort: agent?.effort || null,
    stage: null,
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
  let providerRecheckTimer = null;
  let chatWindow = null;
  let shuttingDown = false;
  const rooms = new Map();
  // 세션별 "아직 전송 전" 첨부: id → 내부 레코드(fileName 포함)
  const pendingAttachments = new Map();
  // 프로바이더 실행은 HarnessAdapter 경계 뒤에 둔다. ProcessHarnessAdapter는 턴마다 CLI
  // 프로세스를 새로 띄우는 runAgentProcess에 그대로 위임한다. 권한·작업 폴더·argv 계산은
  // makeRunAgent에 남는다. 테스트는 options로 주입한다.
  const harnessAdapter = options.harnessAdapter || new ProcessHarnessAdapter();
  // 계정 전환 트랜잭션이 열린 provider → token. 같은 provider에서 전환·로그아웃·로그인 준비·
  // 초기화가 겹치지 않게 막는다(마지막 writer가 이기는 상황 방지).
  const accountTransitions = new Map();
  let accountTransitionSeq = 0;

  // Stage D-0: canonical workspace one-writer. 프로젝트 하나에 workspace 하나이고
  // 그 아래 세션(room)이 여럿이므로, 서로 다른 room이 같은 폴더를 동시에 바꾸는 것을
  // 막는 소유권은 room 밖(control plane)에 있어야 한다. memory-only이며 보증 경계는
  // 단일 main process다(main.js requestSingleInstanceLock).
  //
  // Charter는 provenance를 D-C에서 몰아 만들지 말고 각 단계가 "결정 시점"에 남기라고
  // 요구한다. 그래서 emit seam만 내지 않고 실제 sink를 여기서 연결한다. 기록의 수명은
  // lease 자체와 같은 process 수명이다(lease가 memory-only이므로 그보다 오래 남는
  // 기록은 의미가 없다). 영속 저장과 graph projection은 D-C 범위다.
  const workspaceMutationJournal = [];
  const workspaceMutationLease = options.workspaceMutationLease || new WorkspaceMutationLease({
    onEvent: (event) => {
      workspaceMutationJournal.push(event);
      if (workspaceMutationJournal.length > MAX_WORKSPACE_MUTATION_EVENTS) {
        workspaceMutationJournal.splice(0, workspaceMutationJournal.length - MAX_WORKSPACE_MUTATION_EVENTS);
      }
      // 거부는 사용자가 재시도로 마주치는 유일한 사건이라 운영 로그에도 남긴다.
      if (event?.type === "lease-denied") {
        console.warn(
          `[agora] workspace mutation denied (sameHolder=${Boolean(event.sameHolder)}) held by run=${event.heldBy?.runId || "-"} purpose=${event.heldBy?.purpose || "-"}`
        );
      }
    },
  });

  const CLAUDE_MODEL_ALIASES = Object.freeze(["fable", "opus", "sonnet", "haiku"]);

  function normalizeClaudeResolvedModels(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const alias of CLAUDE_MODEL_ALIASES) {
      const entry = value[alias];
      const resolvedModel = typeof entry === "string" ? entry : entry?.model;
      if (claudeResolvedModelLabel(alias, resolvedModel)) {
        result[alias] = {
          model: resolvedModel,
          observedAt: Number.isFinite(entry?.observedAt) ? entry.observedAt : 0,
          // 확인할 때의 CLI 버전·API 공급자. 이 둘이 없는 예전 기록도 그대로 읽는다.
          ...claudeObservationContext(entry && typeof entry === "object" ? entry : {}),
        };
      }
    }
    return result;
  }

  // v1.1 계열부터 Claude 응답에는 실제 resolved model이 저장됩니다. 기존 사용자도
  // 업데이트 직후 버전 표기를 바로 볼 수 있도록 최근 대화에서 alias별 마지막 관측값을
  // 한 번 복구해 config에 넣습니다. 이후에는 새 Claude 응답이 올 때 증분 갱신합니다.
  function hydrateClaudeResolvedModels(chatStore) {
    if (!chatStore) return {};
    const config = chatStore.getConfig() || {};
    const current = normalizeClaudeResolvedModels(config.claudeResolvedModels);
    // 기존 transcript 전체 스캔은 업데이트 뒤 딱 한 번만 합니다. 사용하지 않은 alias가
    // 영원히 비어 있다고 매 시작마다 모든 대화를 다시 읽으면 시작 시간이 계속 늘어납니다.
    if (config.claudeResolvedModelsHydrated !== 1) {
      const missing = new Set(CLAUDE_MODEL_ALIASES.filter((alias) => !current[alias]));
      for (const session of chatStore.listSessions()) {
        const messages = chatStore.readMessages(session.id);
        for (let i = messages.length - 1; i >= 0 && missing.size > 0; i -= 1) {
          const message = messages[i];
          if (message?.authorType !== "agent" || message?.author !== "claude") continue;
          const alias = String(message.agentMeta?.model || "").trim().toLowerCase();
          const resolvedModel = String(message.agentMeta?.resolvedModel || "").trim();
          if (!missing.has(alias) || !claudeResolvedModelLabel(alias, resolvedModel)) continue;
          current[alias] = { model: resolvedModel, observedAt: Number(message.ts) || 0 };
          missing.delete(alias);
        }
        if (missing.size === 0) break;
      }
      if (!chatStore.readOnly) {
        chatStore.patchConfig({
          claudeResolvedModels: current,
          claudeResolvedModelsHydrated: 1,
        });
      }
    }
    return current;
  }

  function rememberClaudeResolvedModel(message) {
    if (!store || message?.authorType !== "agent" || message?.author !== "claude") return false;
    const alias = String(message.agentMeta?.model || "").trim().toLowerCase();
    const resolvedModel = String(message.agentMeta?.resolvedModel || "").trim();
    if (!claudeResolvedModelLabel(alias, resolvedModel)) return false;
    // 별칭이 가리키는 모델은 CLI 버전·API 공급자에 따라 바뀐다. 표시할 때 이 확인값을
    // 아직 믿어도 되는지 따질 수 있게 확인한 때의 맥락을 함께 남긴다. 모델이 같아도
    // 맥락이 바뀌었으면 다시 저장해야 새 CLI에서도 확인값으로 인정된다.
    const record = ensureCapabilityService()?.getRecord?.("claude");
    const context = claudeObservationContext({
      cliVersion: record?.version,
      apiProvider: record?.authApiProvider,
    });
    const current = normalizeClaudeResolvedModels(store.getConfig()?.claudeResolvedModels);
    const previous = current[alias];
    if (
      previous?.model === resolvedModel
      && previous.cliVersion === context.cliVersion
      && previous.apiProvider === context.apiProvider
    ) return false;
    current[alias] = { model: resolvedModel, observedAt: Number(message.ts) || Date.now(), ...context };
    if (!store.readOnly) store.patchConfig({ claudeResolvedModels: current });
    return true;
  }

  // 실행에서 확인해 저장해 둔 { 별칭: { model, cliVersion?, apiProvider? } }. 표시명에
  // 어떻게 반영할지는 provider-capabilities의 toPublicProvider가 정한다.
  function claudeObservations() {
    return normalizeClaudeResolvedModels(store?.getConfig()?.claudeResolvedModels);
  }

  function ensureStore() {
    if (store || storeError) return store;
    try {
      store = new ChatStore({ root: options.storeRoot }).init();
      hydrateClaudeResolvedModels(store);
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

  // renderer로 가는 공급자 목록은 전부 여기서 만든다(첫 화면 상태·broadcast·재탐지).
  function providersPayload(records) {
    return {
      providers: toPublicProviders(records, { claudeObservations: claudeObservations() }),
      diagnostics: toDiagnostics(records),
    };
  }

  // 모델 목록이 바뀌면 방 참가자의 모델 해석(fable → 실제 옵션 등)도 다시 계산하고
  // 화면에 새 목록을 밀어 넣습니다. 열려 있는 모델 선택은 다시 열어야 반영됩니다.
  function publishProviders(records, { modelsChanged = false } = {}) {
    for (const sessionId of rooms.keys()) refreshRoomAgents(sessionId);
    broadcast("chat:providers", { ...providersPayload(records), modelsChanged });
  }

  // discover()가 캐시로 응답해 둔 오래된 모델 카탈로그를 뒤에서 다시 조회합니다.
  // 시작(chat:state)을 막지 않으려고 기다리지 않고, 실제로 바뀌었을 때만 알립니다.
  async function refreshStaleModelCatalogs(service) {
    if (typeof service?.refreshStaleCatalogs !== "function") return;
    if (typeof service.hasStaleCatalogs === "function" && !service.hasStaleCatalogs()) return;
    try {
      const result = await service.refreshStaleCatalogs();
      if (result?.changed && !shuttingDown) publishProviders(result.records, { modelsChanged: true });
    } catch (error) {
      console.warn("[agora] 모델 목록 갱신 실패:", error?.message || error);
    }
  }

  // 앱을 켜 둔 채 CLI를 업데이트하거나 로그인이 바뀐 경우를 잡기 위해 주기적으로
  // 버전·로그인을 다시 확인합니다. 캐시가 유효하면 카탈로그 조회는 생기지 않습니다.
  async function recheckProviders() {
    if (shuttingDown) return;
    const service = ensureCapabilityService();
    if (typeof service?.discover !== "function") return;
    try {
      const before = JSON.stringify(providersPayload(await service.discover()));
      const records = await service.discover({ recheck: true });
      if (shuttingDown) return;
      if (JSON.stringify(providersPayload(records)) !== before) publishProviders(records);
      await refreshStaleModelCatalogs(service);
    } catch (error) {
      console.warn("[agora] CLI 재확인 실패:", error?.message || error);
    }
  }

  function startProviderRecheck() {
    // 종료 뒤에 들어온 요청이 타이머를 되살리면, shutdown()은 이미 한 번
    // 지웠으므로 아무도 걷어 가지 않는 interval이 남는다.
    if (shuttingDown) return;
    if (providerRecheckTimer || !Number.isFinite(PROVIDER_RECHECK_INTERVAL_MS)) return;
    providerRecheckTimer = setInterval(() => {
      recheckProviders();
    }, PROVIDER_RECHECK_INTERVAL_MS);
    if (typeof providerRecheckTimer.unref === "function") providerRecheckTimer.unref();
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
  // workspace를 설정할 때는 세션의 기존 권한을 유지하고, 해제할 때만 chat으로
  // 되돌립니다(해제 전에 workspace 권한으로 실행 중이던 세션 보호).
  function syncProjectWorkspaceToSessions(projectId, workspace) {
    if (!ensureStore() || !projectId) return;
    const project = ensureProjectStore()?.getProject(projectId);
    for (const entry of listSessionsForProject(projectId)) {
      const patch = { workspace };
      if (workspace == null) {
        patch.permissionMode = "chat";
      }
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

  // 프로젝트 트리 사이드바용: 모든 세션을 프로젝트별로 묶어 내려줍니다.
  function sessionsByProjectPayload() {
    if (!ensureStore()) return {};
    const grouped = {};
    for (const entry of store.listSessions()) {
      const projectId = projectIdForMeta(entry);
      if (!grouped[projectId]) grouped[projectId] = [];
      grouped[projectId].push(entry);
    }
    return grouped;
  }

  function sessionsPayload() {
    const activeProjectId = getActiveProjectId();
    const list = listSessionsForProject(activeProjectId);
    return {
      projects: ensureProjectStore()?.listProjects() || [],
      workflow: workflowForProject(activeProjectId),
      activeProjectId,
      sessions: list,
      sessionsByProject: sessionsByProjectPayload(),
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

  // 이미 보낸 메시지(대기 중인 턴 포함)가 같은 사본 파일을 쓰는지 확인합니다.
  // 사본 이름이 내용 해시라 같은 파일을 다시 붙이면 보낸 첨부와 같은 파일을 가리킵니다.
  function isAttachmentCopyInUse(sessionId, fileName) {
    const room = rooms.get(sessionId);
    const messages = room ? room.messages : ensureStore() ? store.readMessages(sessionId) : [];
    return messages.some((message) =>
      (message.attachments || []).some((attachment) => attachment.fileName === fileName)
    );
  }

  function makeRunAgent(sessionId) {
    return ({
      agent,
      prompt,
      runId,
      attachments,
      emitEvent,
      permissionMode: requestedPermission,
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
      // 권한은 방 권한과 요청 권한 중 낮은 쪽이다. 방은 결론 종합·쉽게 설명을
      // 대화 전용(chat)으로 요청한다.
      const permissionMode = minPermissionMode(
        sessionPermission,
        requestedPermission || sessionPermission,
        sessionPermission
      );
      if (!permissionMode) {
        return {
          promise: Promise.resolve({ ok: false, error: "실행 권한을 안전하게 계산할 수 없습니다." }),
          cancel: () => {},
        };
      }
      // 실행 authority는 프로젝트 workspace가 canonical이다. 세션 workspace는
      // 마이그레이션 호환 캐시일 뿐이며, 프로젝트 workspace를 덮어쓰지 않는다.
      const canonicalWorkspace = canonicalWorkspaceForMeta(meta);
      // workspace를 필요로 하는 권한(workspace-read/write)인데 프로젝트 workspace가
      // 없으면 fail-closed로 차단한다. (migration conflict로 프로젝트 workspace가
      // null인 경우가 대표적이며, 이때 세션별 workspace로 실행되면 같은 프로젝트의
      // 다른 채팅이 서로 다른 repo에서 실행될 수 있기 때문.)
      if ((permissionMode === "workspace-read" || permissionMode === "workspace-write") && !canonicalWorkspace) {
        return {
          promise: Promise.resolve({ ok: false, error: "프로젝트 workspace가 설정되어 있지 않아 실행할 수 없습니다. 프로젝트 워크스페이스 폴더를 먼저 선택해 주세요." }),
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

      // Stage C-3: effective auto-approval을 한 번만 계산해 process invocation과
      // managed context(Codex turn approval policy)에서 동일하게 사용한다.
      const effectiveAutoApprove = permissionMode === "workspace-write" && Boolean(config.autoApprove || autoApprove);
      const invocation = buildAgentInvocation({
        provider: record,
        permissionMode,
        workspace: canonicalWorkspace,
        model: agent.model,
        effort: agent.effort,
        attachments: enriched,
        chatCwd: store.runtimeChatDir(),
        attachmentsDir,
        outputFile,
        autoApprove: effectiveAutoApprove,
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
      // 원본 출력은 필요할 때만 파일로 흘려보냅니다. 메모리에 전체를 들고 있지 않으므로
      // 아주 긴 실행에서도 진단 정보를 잃지 않습니다.
      const rawLog = createRunLogWriter(store, sessionId, runId);

      const hardOutputLimitBytes = resolveHardOutputLimit();

      const harnessInvocation = {
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
        // 출력이 길다는 이유로 실행을 죽이지 않습니다. hard limit은 사용자가
        // 명시적으로 켜지 않으면 undefined(=상한 없음)로 남습니다.
        ...(Number.isFinite(options.captureOutputBytes) && options.captureOutputBytes > 0
          ? { captureOutputBytes: options.captureOutputBytes }
          : {}),
        ...(hardOutputLimitBytes ? { hardOutputLimitBytes } : {}),
        onRawChunk: rawLog.write,
      };
      // 대화 턴은 매번 새 CLI 프로세스로 돈다(세션을 이어 붙이지 않는다).
      const run = harnessAdapter.runTurn({ invocation: harnessInvocation });
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
            result: enrichedResult,
          });
          return enrichedResult.ok
            ? { ...enrichedResult, deliveries: invocation.deliveries, metricsPersisted }
            : { ...enrichedResult, metricsPersisted };
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

function canonicalWorkspaceForMeta(meta) {
  const project = projectForSession(meta);
  return project?.workspace || null;
}

function roomMeta(meta) {
  const project = projectForSession(meta);
  const memory = ensureMemoryStore();
  return {
    permissionMode: meta?.permissionMode || "chat",
    workspace: canonicalWorkspaceForMeta(meta),
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
      // 옛 Planner 카드(origin "planner")는 진행 중에 머문 채 매 프롬프트에 새지 않게 뺀다. 데이터는 그대로 둔다.
      .filter((t) => t.origin !== "planner" && ["todo", "in_progress", "review", "blocked"].includes(t.status));
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

  // 토론 자동 기록 담당: 방금 끝난 구조화 토론의 마지막 단계(종합/판정) 발언자가 있으면 그 에이전트,
  // 없으면 첫 활성 에이전트. 쓸 수 있는 에이전트가 없으면 null(조용히 건너뜀).
  function recordAgentFor(project, room) {
    const usable = (agent) => agent && agent.available && agent.enabled !== false;
    const meta = room.messages.findLast((m) => m.discussionMeta)?.discussionMeta;
    const stepCount = meta?.protocol?.stepCount;
    let agent = null;
    if (stepCount) {
      const from = room.messages.findIndex((m) => m.id === meta.startMessageId);
      const synth = room.messages
        .slice(Math.max(from, 0))
        .findLast((m) => m.authorType === "agent" && m.discussionTurnMeta?.step === stepCount);
      agent = room.findAgent(synth?.author);
    }
    if (!usable(agent)) agent = room.enabledAgents()[0] || null;
    if (!agent) return null;
    const projectDefault = project.defaultAgents?.[agent.id] || {};
    return {
      agent,
      agentConfig: {
        model: projectDefault.model || agent.model || "default",
        effort: projectDefault.effort || agent.effort || "default",
      },
    };
  }

  async function recordDiscussion(sessionId) {
    const room = getRoom(sessionId);
    const meta = store.readMeta(sessionId);
    const project = projectForSession(meta);
    if (!room || !project) return { ok: false, error: "토론 프로젝트를 찾을 수 없습니다." };
    const recorder = recordAgentFor(project, room);
    if (!recorder) return { ok: false, error: "기록을 맡을 에이전트를 사용할 수 없습니다." };
    // 토론 기록은 전문 실행이 아닙니다. 전문 실행 Recorder 단계로 보내면 run 권한과
    // Professional session identity(professionalRunId)를 요구하는데 토론에는 Run이
    // 없어 매번 실패했고, recorder 역할의 context 경계 때문에 정작 요약할 대화조차
    // 보지 못했습니다. 대화를 읽는 일반 턴으로 실행하고 출력 형식만 기록 계약을 씁니다.
    const result = await room.scheduleResponse(recorder.agent, {
      discussionSummary: { record: true },
      agentConfig: recorder.agentConfig,
    });
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

    const room = new ChatRoom({
      sessionId,
      agents: buildRoomAgents(session.meta),
      initialMessages: session.messages,
      runAgent: options.runAgent || makeRunAgent(sessionId),
      prepareAgent: options.prepareAgent,
      meta: roomMeta(session.meta),
      // Stage D-0 — workspace mutation ownership. room은 자기 sessionId를 holder로
      // 소유권을 요청할 뿐, 누가 쥐고 있는지·어느 room과 경합하는지는 모른다.
      mutationLease: workspaceMutationLease,
    });

    room.on("message", (message) => {
      store.appendEvent(sessionId, { kind: "message", message });
      const claudeObservationChanged = rememberClaudeResolvedModel(message);
      // renderer로는 첨부 내부 레코드(fileName/sha256)를 제거한 사본만 보냅니다.
      const outbound = message.attachments
        ? { ...message, attachments: message.attachments.map(publicAttachment) }
        : message;
      broadcast("chat:message", { sessionId, message: outbound });
      broadcast("chat:sessions-changed", sessionsPayload());
      if (claudeObservationChanged) {
        // 실행 id는 계속 fable/opus/sonnet 별칭을 쓰고, 표시명만 방금 확인한 실제
        // 버전으로 갱신합니다. 모델 카탈로그 자체가 바뀐 것은 아니므로 알림 토스트는
        // 띄우지 않습니다.
        const service = ensureCapabilityService();
        if (typeof service?.discover === "function") {
          void Promise.resolve(service.discover())
            .then((records) => {
              if (!shuttingDown) publishProviders(records);
            })
            .catch((error) => {
              console.warn("[agora] Claude 모델 표시명 갱신 실패:", error?.message || error);
            });
        }
      }
    });
    room.on("typing", (payload) => broadcast("chat:typing", { sessionId, ...payload }));
    room.on("turn-state", (payload) => broadcast("chat:turn-state", { sessionId, ...payload }));
    room.on("reset", () => broadcast("chat:reset", { sessionId }));
    room.on("run-event", (payload) => broadcast("chat:run-event", { sessionId, ...payload }));
    room.on("agents", (agents) => broadcast("chat:agents", { sessionId, agents }));
    room.on("approval-request", (payload) => broadcast("chat:approval-request", { sessionId, ...payload }));
    room.on("approval-resolved", (payload) => broadcast("chat:approval-resolved", { sessionId, ...payload }));
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

  // 렌더러가 구조화 토론 UI를 그릴 때 쓰는 Preset 목록. 정의는
  // discussion-protocol.js 한 곳에만 있고 렌더러는 이 요약본만 본다.
  function publicDiscussionPresets() {
    return Object.values(DISCUSSION_PRESETS).map((preset) => {
      const slotLabels = [];
      for (const step of preset.steps) {
        if (!slotLabels[step.slot]) slotLabels[step.slot] = step.roleName;
      }
      return {
        id: preset.id,
        name: preset.name,
        slotCount: preset.slotCount,
        slotLabels,
        stepNames: preset.steps.map((step) => step.roleName),
        // cycle 상한은 토론 전체 hard ceiling(50턴)에서 유도된다.
        maxCycles: maxCycleBudget(preset.steps.length),
      };
    });
  }

  async function fullState({ refreshProviders = false } = {}) {
    ensureStore();
    const service = ensureCapabilityService();
    const records = await service.discover({ force: refreshProviders });
    // 오래된 모델 목록은 캐시로 먼저 응답했으니 뒤에서 갱신하고, 이후에는 주기적으로
    // CLI 업데이트를 다시 확인합니다.
    if (!refreshProviders) void refreshStaleModelCatalogs(service);
    startProviderRecheck();

    if (store && !store.readOnly && store.listSessions().length === 0) {
      store.createSession(sessionDefaultsFromProject(ensureProjectStore()?.getProject(getActiveProjectId())));
    }
    const activeSessionId = getActiveSessionId();
    return {
      // 저장소 문제는 하드 실패가 아니라 경고 배너로 전달합니다.
      error: storeError || null,
      // 공급자 목록은 broadcast·재탐지와 같은 providersPayload로 만든다. 예전에는 여기서만
      // 목록을 따로 조립해, 실행에서 확인해 저장해 둔 Claude 버전 표시가 앱을 켠 첫
      // 화면에는 빠지고 CLI 버전 추측값("Opus 5")이 나왔다.
      ...providersPayload(records),
      permissionModes: PERMISSION_MODES,
      discussionMaxTurns: DEFAULT_DISCUSSION_RUN_BUDGET,
      discussionPresets: publicDiscussionPresets(),
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
        return providersPayload(records);
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

    // 실패한 실행의 원본 로그가 있는 폴더를 OS 파일 탐색기로 엽니다.
    // 화면에는 파일 이름만 보여 주고 경로는 내보내지 않으므로, 경로를 renderer로
    // 건네는 대신 여기서 직접 엽니다. 대상은 세션 저장소가 관리하는 로그 폴더
    // 하나뿐이라 임의 경로 열기가 되지 않습니다.
    ipcMain.handle(
      "chat:run-log:open-folder",
      wrap(async ({ sessionId }) => {
        const store = ensureStore();
        if (!store) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
        const id = String(sessionId || "");
        if (!store.getSession(id)) throw new Error("세션을 찾을 수 없습니다.");
        const dir = store.runLogsDir(id);
        if (!fs.existsSync(dir)) throw new Error("이 대화에는 아직 보관된 실행 로그가 없습니다.");
        const error = await shell.openPath(dir);
        if (error) throw new Error(error);
        return {};
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
        // 옮겨진 대화는 chat:sessions:move와 같이 대상(기본 프로젝트) 기준으로
        // workspace·권한을 다시 씁니다. 옛 폴더가 남으면 재시작 때 기본 프로젝트의
        // workspace로 되살아납니다.
        const target = ensureProjectStore().getProject(UNCATEGORIZED_PROJECT_ID);
        for (const entry of store.listSessions()) {
          const meta = store.readMeta(entry.id);
          if (projectIdForMeta(meta) !== project.id) continue;
          const patch = { projectId: UNCATEGORIZED_PROJECT_ID };
          if (target?.workspace) {
            patch.workspace = target.workspace;
            patch.permissionMode = defaultPermissionMode(target.defaultPermissionMode, target.workspace);
          } else {
            patch.workspace = null;
            patch.permissionMode = "chat";
          }
          store.updateMeta(entry.id, patch);
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
        const task = workflow.createTask({
          projectId: project.id,
          title,
          description,
          status,
          role: selectedRole,
          agentId: agentId || null,
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
      wrap(async ({ projectId } = {}) => {
        if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
        // 트리 사이드바의 프로젝트별 + 버튼이 대상 프로젝트를 지정합니다.
        // 지정이 없으면 기존처럼 활성 프로젝트에 만듭니다.
        const meta = createSessionForProject(projectId ? requireProject(projectId).id : undefined);
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
          // Stage D-0: 실행이 남아 있지 않은 방의 소유권만 정리한다.
          // stopAllSilently가 activeRuns를 0으로 만들기 전에 판단해야 한다.
          room.releaseWorkspaceMutationsIfIdle();
          room.stopAllSilently();
          // 실행이 실제로 끝나 로그 파일이 닫힐 때까지 기다린다. 열린 파일이 있으면
          // Windows에서 폴더를 옮기거나 지울 수 없어 삭제가 중간에 끊긴다.
          const deadline = Date.now() + 8000;
          while (room.liveRuns > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (room.liveRuns > 0) {
            throw new Error("답변 중인 작업이 아직 끝나지 않아 삭제하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
          }
          // 실행이 끝나도 원본 로그 핸들은 잠시 더 열려 있다. 닫힐 때까지 기다린다.
          await Promise.all([...closingRunLogs]);
        }
        // 실패하면 던진다: 세션은 그대로 남고 화면에 오류가 보인다(좀비 세션 방지).
        store.deleteSession(sessionId);
        rooms.delete(sessionId);
        pendingAttachments.delete(sessionId);
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
      wrap(async ({ sessionId, text, attachmentIds, independent }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        // 옛 역할 호출(@기획자·@검토자·@구현자·@기록자·@팀, "@팀 실행" 포함)은 없어졌다.
        // 첨부를 꺼내거나 메시지를 저장하기 전에 거절해 입력칸의 글이 그대로 남게 한다.
        // @claude 같은 에이전트 멘션이 함께 있으면 그 호출은 기존대로 간다.
        if (
          hasLegacyRoleMention(text) &&
          parseMentions(String(text || ""), room.agents, GROUP_ALIASES).length === 0
        ) {
          return { ok: false, error: LEGACY_ROLE_NOTICE };
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
        const room = getRoom(sessionId);
        return room.interject();
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

    // 답변 대기 ×. 답하지 않고 그 에이전트의 대기만 지운다. 방이 갱신된
    // 에이전트 목록(chat:agents)을 밀어 주므로 렌더러는 그걸로 다시 그린다.
    ipcMain.handle(
      "chat:awaiting:dismiss",
      wrap(async ({ sessionId, agentId }) => {
        requireSession(sessionId);
        getRoom(sessionId).clearAwaitingUser(String(agentId || ""));
        return {};
      })
    );

    ipcMain.handle(
      "chat:discussion:start",
      wrap(async ({ sessionId, agentIds, turnBudget, presetId, cycleBudget, roleAssignments }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const cleanIds = Array.isArray(agentIds)
          ? agentIds.filter((id) => typeof id === "string")
          : undefined;
        // V1.5: 토론 길이는 호출별 옵션이다. 정수가 아니면 넘기지 않아 방
        // 기본값(9) 경로를 그대로 탄다. 범위는 방 계층에서 한 번 더 clamp된다.
        const cleanTurnBudget = Number.isInteger(turnBudget)
          ? clampDiscussionTurnBudget(turnBudget, undefined)
          : undefined;
        // 구조화 토론: preset id는 정의된 것만 통과시키고, 세부 검증(역할
        // 배정 수·cycle clamp)은 resolveProtocol 한 곳에서 한다.
        let protocol;
        if (typeof presetId === "string" && presetId) {
          // 소유 프로퍼티만 인정한다. presetId가 'constructor'/'toString' 같은
          // 상속 키면 DISCUSSION_PRESETS[presetId]가 Object.prototype 멤버라
          // truthy가 되어, IPC의 빠른 실패가 뚫리고 resolveProtocol이
          // 'Object Preset...' 같은 혼란스러운 에러를 던진다.
          if (!Object.prototype.hasOwnProperty.call(DISCUSSION_PRESETS, presetId)) {
            throw new Error(`알 수 없는 토론 Preset입니다: ${presetId}`);
          }
          protocol = {
            presetId,
            participantIds: Array.isArray(roleAssignments)
              ? roleAssignments.filter((id) => typeof id === "string")
              : [],
            cycleBudget: Number.isInteger(cycleBudget) ? cycleBudget : undefined,
          };
        }
        // 토론은 오래 걸리므로 시작 확인만 동기로 반환하고, 진행은 이벤트로 전달됩니다.
        const started = room.startDiscussion({
          agentIds: cleanIds,
          turnBudget: cleanTurnBudget,
          protocol,
        });
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
      "chat:message:handoff",
      wrap(async ({ sessionId, targetAgentId, messageId, intent }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const result = room.handoffMessage(targetAgentId, messageId, intent);
        if (result.ok === false) throw new Error(result.error);
        return { meta: publicMeta(store.readMeta(sessionId)) };
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
        const workspace = canonicalWorkspaceForMeta(meta);
        if (mode !== "chat" && !workspace) {
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
        // 전송이 완료돼 대화에 저장된 첨부(같은 내용을 다시 붙인 경우 포함)는 여기서 지우지 않습니다.
        if (record?.fileName && !isAttachmentCopyInUse(sessionId, record.fileName)) {
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
    if (providerRecheckTimer) {
      clearInterval(providerRecheckTimer);
      providerRecheckTimer = null;
    }
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

  // 계정 전환 경계: account-switching이 live credential을 바꾸기 전에 await한다.
  // 같은 provider의 전환이 이미 열려 있으면 거부한다(fail-closed). 호출자는 credential
  // 변경이 확정된 뒤 finally에서 complete()를 불러 닫는다.
  async function notifyProviderAccountChanged(providerId) {
    if (!providerId) {
      throw new Error("provider account lifecycle boundary: providerId가 필요합니다.");
    }
    const pid = String(providerId);
    if (accountTransitions.has(pid)) {
      const error = new Error(`${pid} 계정 전환이 이미 진행 중입니다.`);
      error.accountSwitchSafe = true;
      throw error;
    }
    const token = `apt-${pid}-${++accountTransitionSeq}`;
    accountTransitions.set(pid, token);
    return {
      ok: true,
      providerId: pid,
      token,
      // 오래 늦은 complete가 더 새 전환을 열어 주지 않도록 토큰이 같을 때만 닫는다.
      complete: () => {
        if (accountTransitions.get(pid) !== token) return false;
        accountTransitions.delete(pid);
        return true;
      },
    };
  }

  return {
    registerIpcHandlers,
    openWindow,
    getWindow,
    shutdown,
    showSystemNotice,
    notifyProviderAccountChanged,
  };
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
