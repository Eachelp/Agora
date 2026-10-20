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
  resolveRecordTarget,
} = require("../agora/project-store");
const {
  WorkflowStore,
  TASK_STATUSES,
  ROLE_DEFS,
} = require("../agora/workflow-store");
const { MemoryStore } = require("../agora/memory-store");
const { parseRecorderOutput } = require("../agora/recorder-output");
const {
  createCapabilityService,
  claudeResolvedModelLabel,
  claudeObservationContext,
  toPublicProviders,
  resolveEffortVariant,
} = require("../providers/provider-capabilities");
const { toDiagnostics } = require("../providers/provider-diagnostics");
const { roomAgentsFromCapabilities, concreteModelOptions, GROUP_ALIASES } = require("./chat-agents");
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
  QUESTION_TOOL_TIMEOUT_SEC,
} = require("./chat-argv");
const { createLineParser } = require("./chat-events");
const { useSynchronousTreeKill } = require("./chat-agent-runner");
const { ProcessHarnessAdapter } = require("../harness/process-harness-adapter");
const { persistRunMetrics } = require("./chat-run-metrics-store");
const {
  importAttachment,
  readImagePreview,
  readInlineText,
} = require("./chat-attachments");
const { createChatWindow } = require("./chat-window");
const { createUserQuestionBroker } = require("./user-question-broker");
const { createRoomQuestionTool, questionBrokerHooks } = require("./user-question-run");

// 채팅 기능 전체(저장소·세션·프로바이더 실행·IPC·창)를 묶는 조립 모듈.
// main.js는 createChatFeature() 한 번과 openWindow()/shutdown()만 호출합니다.

// 세션별로 남겨두는 실행 원본 로그 개수. 진단에는 최근 실행만 필요하므로
// 무한히 쌓이지 않게 오래된 파일부터 지웁니다.
const MAX_RUN_LOG_FILES = 20;
const MAX_TASK_FILE_BYTES = 256 * 1024;
// 앱을 켜 둔 동안 CLI 버전·로그인·모델 목록을 다시 확인하는 간격입니다.
// (버전 확인은 가볍고, 모델 카탈로그는 캐시 TTL이 지났을 때만 다시 조회합니다.)
const PROVIDER_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
// 옛 역할 호출(@기획자 등)을 받았을 때 chat:send가 돌려주는 안내.
const LEGACY_ROLE_NOTICE =
  "역할 호출·팀 실행은 없어졌습니다. @claude / @gpt / @gemini로 직접 부르거나 @모두를 쓰세요.";

// 질문 이벤트(방의 user-question)를 대화 기록에 남길 때의 종류. 상태마다 한 줄씩 쌓이고,
// 다시 켤 때는 질문별 마지막 줄이 그 질문의 상태다(chat-store readUserQuestions).
const QUESTION_EVENT_KINDS = Object.freeze({
  pending: "user_question_requested",
  submitting: "user_answer_submitted",
  answered: "user_answer_delivered",
  cancelled: "user_question_cancelled",
  interrupted: "user_question_interrupted",
});

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

// 파일 기반 작업 카드(contentSource "file")의 본문을 읽기 전용으로 읽는다.
// 허용: <워크스페이스>/.project-memory/tasks/<이름>.md 일반 파일, 256KB 이하,
// realpath가 그 폴더 안에 있을 것(심볼릭 링크로 밖을 가리키면 거절).
function readTaskFileText(workspace, taskPath) {
  const fail = (message) => { throw new Error(message); };
  if (!workspace) fail("프로젝트 폴더가 연결되어 있지 않습니다.");
  const match = /^(?:\.\/)?\.project-memory\/tasks\/([A-Za-z0-9._-]+\.md)$/.exec(
    String(taskPath || "").replace(/\\/g, "/")
  );
  if (!match) fail("올바르지 않은 TASK 파일 경로입니다.");
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  let real;
  try {
    const expectedDir = path.join(fs.realpathSync(workspace), ".project-memory", "tasks");
    const dir = fs.realpathSync(expectedDir);
    if (!same(dir, expectedDir)) fail("프로젝트 폴더 밖을 가리키는 TASK 폴더는 열 수 없습니다.");
    real = fs.realpathSync(path.join(dir, match[1]));
    if (!same(path.dirname(real), dir)) fail("TASK 폴더 밖을 가리키는 파일은 열 수 없습니다.");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail("TASK 파일을 찾을 수 없습니다.");
    throw error;
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail("TASK 파일을 찾을 수 없습니다.");
  if (stat.size > MAX_TASK_FILE_BYTES) fail("TASK 파일이 너무 커서 열 수 없습니다.");
  return fs.readFileSync(real, "utf8");
}

// 이 세션이 지금까지 쓴 가장 큰 runId 번호. 디스크의 로그·지표·증거 파일 이름과
// 대화 기록의 runId를 함께 본다(로그만 정리돼도 말풍선이 가리키는 번호는 남는다).
// 앱을 다시 켜면 방이 새로 만들어지므로, 여기서 이어 매기지 않으면 번호가 겹쳐
// 이전 실행의 원본 로그에 덧붙고 지표·증거 파일을 덮어쓴다.
function maxRunSeq(store, sessionId, messages = []) {
  // 파일 이름은 runId를 [^\w.-] → "_"로 바꾼 것이라 같은 규칙으로 맞춰 비교한다.
  const safe = (value) => String(value || "").replace(/[^\w.-]/g, "_");
  const prefix = safe(`r${sessionId}-`);
  const seqOf = (name) => {
    const text = safe(name);
    if (!text.startsWith(prefix)) return 0;
    const match = /^(\d+)(?:\.|$)/.exec(text.slice(prefix.length));
    return match ? Number(match[1]) : 0;
  };
  let max = 0;
  for (const message of messages) max = Math.max(max, seqOf(message?.runId));
  try {
    for (const name of fs.readdirSync(store.runLogsDir(sessionId))) max = Math.max(max, seqOf(name));
  } catch {}
  return max;
}

// 오래된 실행 로그를 정리합니다. 실패해도 실행에는 영향을 주지 않습니다.
// keepPath로 지정한 파일(방금 기록한 로그)은 항상 보존합니다.
function pruneRunLogs(store, sessionId, keepPath = null) {
  try {
    const dir = store.runLogsDir(sessionId);
    // 옛 전문 모드가 남긴 *.evidence.json은 보존 대상이라 정리하지 않는다.
    for (const suffix of [".log"]) {
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
    orchestrator: meta.orchestrator || { enabled: false, leadId: null },
    keepCalling: Boolean(meta.keepCalling),
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
  // 실행 중 질문 중계소: 앱 전체에서 하나, 처음 질문 도구를 붙일 때 시작하고 종료 때 멈춘다.
  // 콜백은 질문이 속한 방(sessionId)으로 전달된다.
  let questionBroker = null;
  function ensureQuestionBroker() {
    if (!questionBroker) {
      questionBroker = createUserQuestionBroker({
        ...(options.questionBrokerOptions || {}),
        ...questionBrokerHooks((sessionId) => rooms.get(sessionId) || null),
        onCallbackError: (error, name) => console.warn(`[agora] 질문 중계소 콜백(${name}) 오류:`, error?.message || error),
      });
    }
    return questionBroker;
  }
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

  // 오케스트레이터의 지휘 모델·노력·읽기 전용을 검증하고 저장할 값으로 정리한다. 모델은 지휘 AI 공급자의 모델 목록 안에서,
  // 노력은 그 모델(없으면 참가자의 현재 모델)이 지원하는 목록 안에서만 받는다. 빈 문자열·"default"·null은 "참가자 설정 그대로"다.
  function resolveLeadSettings({ current, nextLeadId, leadModel, leadEffort, leadReadOnly, room }) {
    const clean = (value) => {
      const text = typeof value === "string" ? value.trim().slice(0, 64) : "";
      return text && text !== "default" ? text : null;
    };
    const sameLead = Boolean(current.enabled) && current.leadId === nextLeadId;
    let model = sameLead ? clean(current.leadModel) : null;
    let effort = sameLead ? clean(current.leadEffort) : null;
    const readOnly = leadReadOnly === undefined ? Boolean(current.leadReadOnly) : Boolean(leadReadOnly);
    if (leadModel !== undefined) model = clean(leadModel);
    if (leadEffort !== undefined) effort = clean(leadEffort);
    const record = ensureCapabilityService().getRecord(nextLeadId);
    const modelOptions = record ? concreteModelOptions(record) : [];
    if (model && !modelOptions.some((option) => option.id === model)) {
      throw new Error("지휘 모델로 쓸 수 없는 모델입니다.");
    }
    if (effort) {
      const effectiveModel = model || room?.findAgent(nextLeadId)?.model;
      const option = modelOptions.find((entry) => entry.id === effectiveModel);
      const efforts = (Array.isArray(option?.efforts) ? option.efforts : record?.efforts || []).filter((value) => value !== "default");
      if (!efforts.includes(effort)) throw new Error("이 모델에서 쓸 수 없는 지휘 노력 수준입니다.");
    }
    return { model, effort, readOnly };
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

  // 창이 있어 실제로 보냈으면 true. 안내처럼 "받았는지"가 중요한 쪽이 이 값을 본다.
  function broadcast(channel, payload) {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(channel, payload);
      return true;
    }
    return false;
  }

  // Show account/proxy errors in the chat window when the pet is off.
  // sessionId가 있으면 그 방에서만 보인다(없으면 지금 열린 방).
  function showSystemNotice(text, sessionId) {
    return broadcast("chat:system-notice", sessionId ? { text, sessionId } : { text });
  }

  // 저장 실패 안내는 방마다 한 번만 낸다. 다시 저장에 성공하면 다음 실패 때 또 알린다.
  const saveFailureNoticed = new Set();

  function projectIdForMeta(meta) {
    const projects = ensureProjectStore();
    if (meta?.projectId && projects?.hasProject(meta.projectId)) return meta.projectId;
    return UNCATEGORIZED_PROJECT_ID;
  }

  // 읽기 전용 저장소는 설정 파일을 못 쓰므로, 둘러보는 중인 대화는 메모리에만 둔다.
  // (그러지 않으면 화면은 고른 대화를 그리는데 활성 대화는 옛것으로 남아 전송·이벤트가 엉뚱한 방으로 간다)
  let browsingReadOnly = null;

  function getActiveProjectId() {
    const projects = ensureProjectStore();
    if (!ensureStore() || !projects) return null;
    if (store.readOnly && browsingReadOnly && projects.hasProject(browsingReadOnly.projectId)) {
      return browsingReadOnly.projectId;
    }
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
    if (store.readOnly && browsingReadOnly?.projectId === projectId && store.hasSession(browsingReadOnly.sessionId)) {
      return browsingReadOnly.sessionId;
    }
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
    if (!ensureStore() || !sessionId) return;
    const meta = store.readMeta(sessionId);
    if (!meta) return;
    const projectId = projectIdForMeta(meta);
    if (store.readOnly) {
      browsingReadOnly = { projectId, sessionId };
      return;
    }
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
  // 사용자의 답을 기다리는 질문 카드가 있는 방에는 표시를 단다(다른 방을 보고 있어도 사이드바에서 알 수 있게).
  // 이미 방이 들고 있는 상태에서 계산하므로 따로 조회하거나 주기적으로 확인하지 않는다.
  function withQuestionWaiting(entry) {
    return rooms.get(entry.id)?.hasPendingQuestion() ? { ...entry, waitingQuestion: true } : entry;
  }

  function sessionsByProjectPayload() {
    if (!ensureStore()) return {};
    const grouped = {};
    for (const entry of store.listSessions()) {
      const projectId = projectIdForMeta(entry);
      if (!grouped[projectId]) grouped[projectId] = [];
      grouped[projectId].push(withQuestionWaiting(entry));
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
      sessions: list.map(withQuestionWaiting),
      sessionsByProject: sessionsByProjectPayload(),
      activeSessionId: getActiveSessionId(activeProjectId),
      readOnly: Boolean(store?.readOnly || storeError || projectStoreError || workflowStoreError || memoryStoreError),
    };
  }

  function pendingFor(sessionId) {
    if (!pendingAttachments.has(sessionId)) {
      // 이 프로세스에서 이 대화의 보류 목록이 처음 만들어지는 순간입니다. 목록은 메모리에만 있어
      // 이전 실행이 보내지 않고 끝났다면 그때의 사본이 고아 파일로 남아 있으므로 지워 한도를 돌려줍니다.
      sweepOrphanAttachments(sessionId);
      pendingAttachments.set(sessionId, new Map());
    }
    return pendingAttachments.get(sessionId);
  }

  // transcript를 엄격하게 읽어 메시지 배열로 돌려줍니다. 저장소의 관대한 읽기(store.readMessages)는
  // 못 읽거나 깨진 줄을 조용히 건너뛰어 그 줄이 가리키던 첨부까지 '쓰지 않는 사본'으로 보이게 합니다 —
  // 여기서는 깨진 줄이 하나라도 있으면 그대로 던져, 부르는 쪽이 "모른다"를 "지운다"로 바꾸지 않게 합니다.
  function readTranscriptMessagesStrict(sessionId) {
    let raw = "";
    try {
      raw = fs.readFileSync(store.transcriptPath(sessionId), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const messages = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event?.kind === "message" && event.message) messages.push(event.message);
    }
    return messages;
  }

  // 보낸 메시지가 쓰지 않는 사본(보내지 않은 보류 첨부, 복사 도중 끊긴 .tmp)만 지웁니다.
  // 대화 기록을 읽지 못하면 보낸 첨부를 지울 수 있으니 아무것도 지우지 않습니다.
  function sweepOrphanAttachments(sessionId) {
    if (!ensureStore() || store.readOnly) return;
    try {
      const dir = store.attachmentsDir(sessionId);
      if (!fs.existsSync(dir)) return;
      const room = rooms.get(sessionId);
      const used = new Set();
      const messages = [...(room ? room.messages : []), ...readTranscriptMessagesStrict(sessionId)];
      for (const message of messages) {
        for (const attachment of message.attachments || []) used.add(attachment.fileName);
      }
      for (const name of fs.readdirSync(dir)) {
        if (used.has(name)) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (error) {
          console.error("[Agora] 보내지 않은 첨부 사본을 지우지 못했습니다:", name, error && (error.message || error));
        }
      }
    } catch (error) {
      console.error("[Agora] 보내지 않은 첨부 사본을 정리하지 못했습니다:", error && (error.message || error));
    }
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
    const usesFile = (list) => list.some((message) =>
      (message.attachments || []).some((attachment) => attachment.fileName === fileName));
    const room = rooms.get(sessionId);
    if (room && usesFile(room.messages)) return true;
    if (!ensureStore()) return false;
    try {
      // room.messages는 세션을 열 때 store.readMessages(관대한 읽기)로 채워져 깨진 줄의 첨부를
      // 놓칠 수 있습니다 — transcript를 직접 엄격히 다시 봅니다.
      return usesFile(readTranscriptMessagesStrict(sessionId));
    } catch {
      // 못 읽거나 깨진 줄이 있으면 '쓰는 중'으로 보고 지우지 않습니다(fail-safe).
      return true;
    }
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
      grantDirs = [],
      userQuestion = null,
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

      // effective auto-approval을 한 번만 계산해 process invocation에 넘긴다.
      const effectiveAutoApprove = permissionMode === "workspace-write" && Boolean(config.autoApprove || autoApprove);
      // 접히기 전에 저장된 AGY 변형 id(gemini-3.8-flash-high)는 목록에서 사라져 있다. 세션 참가자는 방을 만들 때
      // (모델, 노력) 쌍으로 옮겨 오지만, 프로젝트 역할(기록 담당 등)이 싣는 저장값은 그대로 들어온다. 이때 노력이
      // 다른 모델 기준값이면 '--model 변형 --effort 다른 단계'가 함께 나가므로, 변형 id가 담은 노력을 따른다.
      const variant = resolveEffortVariant(record.modelOptions, agent.model);
      const invocation = buildAgentInvocation({
        provider: record,
        permissionMode,
        workspace: canonicalWorkspace,
        model: variant ? variant.model : agent.model,
        effort: variant ? variant.effort : agent.effort,
        attachments: enriched,
        chatCwd: store.runtimeChatDir(),
        attachmentsDir,
        outputFile,
        autoApprove: effectiveAutoApprove,
        // 승인 카드에서 허락한 폴더. 쓰기 권한에서만 연다(argv가 다시 막는다).
        extraDirs: permissionMode === "workspace-write" ? grantDirs : [],
        userQuestion,
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
        // Claude CLI는 MCP 도구 호출마다 시간 제한을 둔다. 사용자가 답을 고민하는 동안 도구 호출이 끊기지 않게
        // 질문 중계소의 대기 상한(30분)보다 5분 길게 둔다. 같거나 짧으면 CLI가 먼저 포기해 중계소의
        // "시간 초과" 결과가 모델에 닿지 않는다. 질문 도구를 붙이지 않은 실행에는 더하지 않는다.
        ...(invocation.questionToolAttached && agent.id === "claude" ? { extraEnv: { MCP_TOOL_TIMEOUT: String(QUESTION_TOOL_TIMEOUT_SEC * 1000) } } : {}),
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
        // 질문 도구로 답을 기다리는 동안 실행 시간 제한·무음 경고를 멈추는 손잡이(러너가 줄 때만).
        ...(typeof run.setWaitingUser === "function" ? { setWaitingUser: (value) => run.setWaitingUser(value) } : {}),
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
      orchestrator: meta?.orchestrator || { enabled: false, leadId: null },
      keepCalling: Boolean(meta?.keepCalling),
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

  // 아직 끝나지 않은 토론 기록의 표식. 기록 턴이 앱 종료로 끊기면 표식이 남아, 그 대화를 다음에 열 때 한 번 더 만든다.
  // 대화마다 하나만 둔다(토론이 연달아 끝나도 가장 최근 것만 다시 만든다).
  function setPendingDiscussionRecord(sessionId, discussionId) {
    try {
      const next = discussionId || null;
      if (store && !store.readOnly && (store.readMeta(sessionId)?.pendingDiscussionRecord || null) !== next) {
        store.updateMeta(sessionId, { pendingDiscussionRecord: next });
      }
    } catch (error) {
      console.warn("[agora] 토론 기록 표식 저장 실패:", error?.message || error);
    }
  }

  async function recordDiscussion(sessionId, discussionId) {
    const room = getRoom(sessionId);
    const meta = store.readMeta(sessionId);
    const project = projectForSession(meta);
    if (!room || !project) return { ok: false, error: "토론 프로젝트를 찾을 수 없습니다." };
    // 기록 담당을 정한 프로젝트에서만 기록한다(recordAgent, 없으면 옛 recorder→review 역할).
    const recorder = resolveRecordTarget(project, room.enabledAgents());
    // 기록할 필요가 없거나 할 수 없는 경우는 표식을 남기지 않는다(다시 시도해도 같다).
    if (!recorder) {
      setPendingDiscussionRecord(sessionId, null);
      return { ok: false, error: "이 프로젝트는 토론 자동 기록을 쓰지 않거나, 담당 에이전트를 사용할 수 없습니다." };
    }
    // 방 전체가 아니라 끝난 그 토론의 구간만 기록 근거로 쓴다.
    const range = room.discussionRecordOf(discussionId);
    if (!range.ok) {
      setPendingDiscussionRecord(sessionId, null);
      return range;
    }
    setPendingDiscussionRecord(sessionId, discussionId);
    // 토론 기록은 대화를 읽는 일반 턴으로 실행하고 출력 형식만 기록 계약을 씁니다.
    const result = await room.scheduleResponse(recorder.agent, {
      discussionSummary: { record: true, discussionId },
      discussionSummaryMessages: range.messages,
      agentConfig: recorder.agentConfig,
    });
    if (result?.ok && result.text) {
      const entry = saveRecorderOutput(project.id, result.text, "토론 요약 초안", {
        chatId: sessionId,
        recorderAgentId: recorder.agent?.id || null,
      });
      if (entry) {
        setPendingDiscussionRecord(sessionId, null);
        return { ok: true, entry };
      }
    }
    // 앱이 끝나는 중이면 표식을 남겨 다음에 다시 만든다. 그 밖의 실패(중지·실행 오류)는 다시 시도하지 않고 알린다.
    if (shuttingDown) return { ok: false, error: "앱 종료로 토론 기록이 끊겼습니다." };
    setPendingDiscussionRecord(sessionId, null);
    try {
      room.appendSystem("토론 자동 기록을 만들지 못했습니다. 필요하면 토론의 '결론 종합하기'로 요약을 받아 메모리에 직접 남겨 주세요.");
    } catch {}
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
      runSeqStart: maxRunSeq(store, sessionId, session.messages),
      runAgent: options.runAgent || makeRunAgent(sessionId),
      prepareAgent: options.prepareAgent,
      meta: roomMeta(session.meta),
      // 실행 중 질문(ask_user) 도구. CLI가 셸 래퍼로 설치됐는지는 방이 모르므로 여기서 알려 준다.
      questionTool: createRoomQuestionTool({
        broker: ensureQuestionBroker(),
        sessionId,
        needsShellOf: (agent) => ensureCapabilityService().getRecord(agent.id)?.needsShell,
      }),
      initialQuestions: store.readUserQuestions(sessionId),
    });

    // 방 이벤트 리스너에서 난 예외는 emit한 방 코드(턴 시작·승인 카드·중지)로 올라가 응답을
    // 삼키거나 중지를 막는다. 저장소·화면 쓰기 실패는 기록만 남기고 방에는 올리지 않는다.
    const on = (event, listener) => room.on(event, (...args) => {
      try {
        listener(...args);
      } catch (error) {
        console.warn(`[agora] 방 이벤트(${event}) 처리 실패:`, error?.message || error);
      }
    });

    on("message", (message) => {
      // 저장이 실패해도 예외를 방 안쪽(토론·턴 진행)으로 올리지 않는다. 올리면 토론 플래그가
      // 남아 대화가 멈춘다. 대신 화면에는 그대로 보여 주고, 저장 실패는 알림으로 알린다.
      try {
        store.appendEvent(sessionId, { kind: "message", message });
        saveFailureNoticed.delete(sessionId);
      } catch (error) {
        console.warn("[agora] 대화 기록 저장 실패:", error?.message || error);
        // 받은 창이 없으면(닫힘·펫 모드) 알린 것으로 치지 않는다. 다음 실패 때 다시 알린다.
        if (!saveFailureNoticed.has(sessionId)) {
          const delivered = showSystemNotice(`대화 기록을 디스크에 저장하지 못했습니다. 방금 메시지는 다시 열면 보이지 않을 수 있습니다. (${error?.message || error})`, sessionId);
          if (delivered) saveFailureNoticed.add(sessionId);
        }
      }
      let claudeObservationChanged = false;
      try {
        claudeObservationChanged = rememberClaudeResolvedModel(message);
      } catch (error) {
        console.warn("[agora] Claude 모델 확인값 저장 실패:", error?.message || error);
      }
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
    on("typing", (payload) => broadcast("chat:typing", { sessionId, ...payload }));
    on("turn-state", (payload) => broadcast("chat:turn-state", { sessionId, ...payload }));
    // 오케스트레이션 상태(라운드·실행 횟수, 설계 §(5)) — turnState()의 기존 모양은 바꾸지 않고 별도로 낸다.
    on("orchestration", (orchestration) => broadcast("chat:orchestration", { sessionId, orchestration }));
    on("reset", () => broadcast("chat:reset", { sessionId }));
    on("run-event", (payload) => broadcast("chat:run-event", { sessionId, ...payload }));
    on("agents", (agents) => broadcast("chat:agents", { sessionId, agents }));
    // room.setMeta가 요청자 없이(예: refreshRoomAgents의 지휘 AI 자동 꺼짐) 불려도 화면이 머리줄
    // 칩·안내문을 다시 그릴 수 있게 최신 meta를 밀어 준다(store가 이미 갱신된 뒤라 다시 읽기만 한다).
    on("meta", () => broadcast("chat:meta", { sessionId, meta: publicMeta(store.readMeta(sessionId)) }));
    on("approval-request", (payload) => broadcast("chat:approval-request", { sessionId, ...payload }));
    on("approval-resolved", (payload) => broadcast("chat:approval-resolved", { sessionId, ...payload }));
    // 질문 기록은 저장이 실패해도 화면에는 그대로 알린다. 저장 실패는 방(실행·답)으로 올리지 않고 알림으로만 알린다.
    const persistQuestion = (question) => {
      const noticeKey = `question:${sessionId}`;
      try {
        store.appendEvent(sessionId, { kind: QUESTION_EVENT_KINDS[question.status] || "user_question_interrupted", question });
        saveFailureNoticed.delete(noticeKey);
      } catch (error) {
        console.warn("[agora] 질문 기록 저장 실패:", error?.message || error);
        if (!saveFailureNoticed.has(noticeKey)) {
          const delivered = showSystemNotice(`질문과 답을 디스크에 저장하지 못했습니다. 다시 열면 방금 질문이 보이지 않을 수 있습니다.`, sessionId);
          if (delivered) saveFailureNoticed.add(noticeKey);
        }
      }
    };
    on("user-question", (question) => {
      persistQuestion(question);
      broadcast("chat:user-question", { sessionId, question });
    });
    // 앱을 다시 켜기 전에 답을 기다리던 질문은 방이 '중단됨'으로 돌려놓았다. 그 줄도 기록에 남긴다.
    for (const question of room.interruptedOnLoad) persistQuestion(question);
    room.announceInterruptedQuestions();
    // 승인 카드를 기다리는 방은 실행 중 턴이 없어도 일하는 중이다. 다른 방을 보고 있어도
    // 사이드바에 표시가 남도록 상태를 함께 센다.
    const syncRoomStatus = () => {
      if (shuttingDown) return;
      const writeStatus = () => {
        const working = room.activeRuns > 0 || room.pendingApprovals.size > 0 || room.hasPendingQuestion();
        store.setSessionStatus(sessionId, working ? "running" : "idle");
      };
      try {
        writeStatus();
      } catch (error) {
        // 저장이 한 번 실패해도 디스크에 'running'이 남아 다시 켠 뒤 "앱 종료로 중단" 안내가 잘못 뜨지
        // 않게, 잠시 뒤 지금 상태로 한 번 더 쓰고 사이드바도 맞춘다. 이번 예외는 on()이 기록만 남긴다.
        setTimeout(() => {
          if (shuttingDown) return;
          try {
            writeStatus();
            broadcast("chat:sessions-changed", sessionsPayload());
          } catch (retryError) {
            console.warn("[agora] 대화 상태 저장 재시도 실패:", retryError?.message || retryError);
          }
        }, 500).unref?.();
        throw error;
      } finally {
        broadcast("chat:sessions-changed", sessionsPayload());
      }
    };
    on("busy", syncRoomStatus);
    on("approval-wait", syncRoomStatus);
    // 질문이 생기거나 처리되면 사이드바의 '질문 대기' 표시도 맞춘다(승인 대기와 같은 방식).
    on("user-question", syncRoomStatus);

    rooms.set(sessionId, room);
    // 지난번에 앱 종료로 끊긴 토론 기록이 있으면 이 대화를 연 지금 한 번 더 만든다.
    const pendingRecord = session.meta.pendingDiscussionRecord;
    if (pendingRecord && !store.readOnly && !shuttingDown) {
      setImmediate(() => {
        if (!shuttingDown) recordDiscussion(sessionId, pendingRecord).catch((error) => console.warn("[agora] 토론 기록 재시도 실패:", error?.message || error));
      });
    }
    return room;
  }

  function refreshRoomAgents(sessionId) {
    const room = rooms.get(sessionId);
    if (!room || !store) return;
    const meta = store.readMeta(sessionId);
    room.setAgents(buildRoomAgents(meta));
    if (meta) room.setMeta(roomMeta(meta));
    // 지휘 AI가 비활성화되거나 CLI를 찾지 못하게 되면, 일반 모드로 돌아가는 길이 막히지 않도록
    // 모드를 스스로 끈다(원칙: 일반 모드로 돌아가는 것은 어떤 상태에서도 막히면 안 된다).
    const orchestrator = meta?.orchestrator;
    if (orchestrator?.enabled && orchestrator.leadId) {
      const lead = room.findAgent(orchestrator.leadId);
      if (!lead || !lead.available || lead.enabled === false) {
        const notice = `지휘 AI @${orchestrator.leadId}를 쓸 수 없어 오케스트레이터 모드를 껐습니다.`;
        if (room.orchestration) room.endOrchestration(notice);
        else room.appendSystem(notice);
        store.updateMeta(sessionId, { orchestrator: { enabled: false, leadId: null } });
        room.setMeta(roomMeta(store.readMeta(sessionId)));
      }
    }
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
      // 라운드·실행 횟수만(§(5)) — 일시 정지 표시는 화면이 pendingApprovals/userQuestions에서 계산한다(§(9)).
      orchestration: room.orchestrationSnapshot(),
      // 창이 닫혀 있던 사이 온 승인 요청도 창이 다시 붙을 때 이 목록으로 되살아난다.
      pendingApprovals: room.pendingApprovalList().map((approval) => ({ sessionId, ...approval })),
      // 답을 기다리는 질문(창이 다시 붙을 때 되살아난다)과, 끝난 것·중단된 것을 포함한 질문 기록 전체.
      pendingQuestions: room.pendingUserQuestionList(),
      userQuestions: room.userQuestionList(),
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
    // 읽기 전용 저장소에서는 기록관 자동 저장도 Memory Bank·작업 기록에 쓰지 않습니다.
    if (store && store.readOnly) return null;
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

  // forRead: 읽기만 하는 IPC(Memory Bank·규칙 읽기, 프로젝트 둘러보기)는 읽기 전용 저장소·프로젝트에서도
  // 통과시킵니다. 쓰기 IPC는 기본값(forRead=false)으로 그대로 막힙니다.
  function requireProject(projectId, { forRead = false } = {}) {
    const projects = ensureProjectStore();
    if (!projects) throw new Error(projectStoreError || "프로젝트 저장소를 사용할 수 없습니다.");
    // 채팅 저장소가 읽기 전용(더 새 버전이 만든 데이터)이면 프로젝트·메모리·
    // 결정·작업 쓰기 IPC도 함께 막습니다. 화면에는 읽기 전용으로 표시되므로
    // 실제 쓰기가 조용히 성공해 데이터가 어긋나는 일을 막습니다.
    if (!forRead && store && store.readOnly) throw new Error("이 .agora 저장소는 읽기 전용 상태라 변경할 수 없습니다.");
    const project = projects.getProject(projectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    if (!forRead && project.readOnly) throw new Error("이 프로젝트는 더 새로운 버전에서 만들어져 읽기 전용입니다.");
    return project;
  }

  // 보내기·에이전트 실행·첨부 복사처럼 저장소에 기록이 남아야 하는 대화 IPC용입니다.
  // 읽기 전용 저장소는 대화를 저장하지 못하므로(화면에는 보이지만 재시작하면 사라짐) 시작 전에 막습니다.
  function requireWritableSession(sessionId) {
    requireSession(sessionId);
    if (store.readOnly) {
      throw new Error("이 저장소는 더 새로운 버전의 Agora가 만든 것이라 읽기 전용입니다. 대화를 보내거나 에이전트를 실행할 수 없습니다. 최신 버전의 Agora를 사용해 주세요.");
    }
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
      "chat:appearance:get",
      wrap(async () => ({ appearance: typeof options.getAppearance === "function" ? options.getAppearance() : null }))
    );

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
        // 읽기 전용 저장소에서도 프로젝트 둘러보기는 됩니다(저장은 setActiveProjectId가 건너뜁니다).
        const project = requireProject(projectId, { forRead: Boolean(ensureStore() && store.readOnly) });
        let sessionId = getActiveSessionId(project.id);
        // 읽기 전용 저장소는 새 대화를 만들 수 없고, 둘러보는 프로젝트는 고른 대화를 통해서만 메모리에 기억됩니다.
        // 대화가 없는 프로젝트를 그냥 받으면 응답이 옛 프로젝트·빈 대화로 돌아가 사이드바 선택이 말없이 되돌아갑니다.
        if (!sessionId && store.readOnly) {
          throw new Error("이 저장소는 더 새로운 버전의 Agora가 만든 것이라 읽기 전용입니다. 대화가 없는 프로젝트는 새 대화를 만들 수 없어 열 수 없습니다. 최신 버전의 Agora를 사용해 주세요.");
        }
        setActiveProjectId(project.id);
        if (!sessionId) sessionId = createSessionForProject(project.id).id;
        setActiveSessionId(sessionId);
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
        if (typeof patch?.recordAgent === "string") next.recordAgent = patch.recordAgent;
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
        // 폴더를 바꾸면 이 프로젝트 대화의 권한도 함께 바뀐다. 보고 있는 대화의 meta를 같이 돌려줘 헤더가 맞게 한다.
        const activeMeta = payload.activeSessionId ? publicMeta(store.readMeta(payload.activeSessionId)) : null;
        return { ...payload, project, activeMeta };
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
        // 폴더를 바꾸면 이 프로젝트 대화의 권한도 함께 바뀐다. 보고 있는 대화의 meta를 같이 돌려줘 헤더가 맞게 한다.
        const activeMeta = payload.activeSessionId ? publicMeta(store.readMeta(payload.activeSessionId)) : null;
        return { ...payload, project, activeMeta };
      })
    );

    ipcMain.handle(
      "chat:memory:read",
      wrap(async ({ projectId }) => {
        const project = requireProject(projectId || getActiveProjectId(), { forRead: true });
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
        const project = requireProject(projectId || getActiveProjectId(), { forRead: true });
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
        // 파일이 없어졌거나 새 버전으로 바뀐 '숨겨진' 작업도 이 결정을 가리킬 수 있으므로 모두 확인합니다.
        const linkedMessage = "연결된 작업이 있어 결정을 삭제할 수 없습니다. 파일이 없어지거나 새 버전으로 바뀐 작업이 이 결정에 연결되어 있을 수 있습니다.";
        if (workflow.listTasks(project.id, { includeAll: true }).some((task) => task.decisionId === decisionId)) {
          throw new Error(linkedMessage);
        }
        if (!workflow.deleteDecision(decisionId)) throw new Error(linkedMessage);
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

    // 파일 기반 작업 카드의 본문 읽기(읽기 전용). 저장소가 읽기 전용이어도 열어 볼 수 있다.
    ipcMain.handle(
      "chat:tasks:read-file",
      wrap(async ({ projectId, taskPath }) => {
        const projects = ensureProjectStore();
        if (!projects) throw new Error(projectStoreError || "프로젝트 저장소를 사용할 수 없습니다.");
        const project = projects.getProject(projectId || getActiveProjectId());
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        return { content: readTaskFileText(project.workspace, taskPath), taskPath: String(taskPath || "") };
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
        requireWritableSession(sessionId);
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
        requireWritableSession(sessionId);
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
        requireWritableSession(sessionId);
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
              recordDiscussion(sessionId, result.discussionId).catch(() => {});
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
        requireWritableSession(sessionId);
        const room = getRoom(sessionId);
        const result = await room.summarizeDiscussion(discussionId, agentId);
        if (result && result.ok === false) throw new Error(result.error);
        return result || {};
      })
    );

    ipcMain.handle(
      "chat:message:handoff",
      wrap(async ({ sessionId, targetAgentId, messageId, intent }) => {
        requireWritableSession(sessionId);
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

    // 실행 중 질문(ask_user)에 대한 답 / 답하지 않기. 같은 실행으로 돌아가 작업이 이어진다.
    // 검증: 대화·질문·실행 id, 이미 처리됨, 없는 선택지, 글자 수 상한, 답 개수는 방과 중계소가 거절한다.
    ipcMain.handle(
      "chat:question:answer",
      wrap(async ({ sessionId, questionId, runId, answers }) => {
        requireSession(sessionId);
        const result = getRoom(sessionId).answerUserQuestion({ questionId, runId, answers });
        if (!result.ok) throw new Error(result.error);
        return {};
      })
    );

    ipcMain.handle(
      "chat:question:cancel",
      wrap(async ({ sessionId, questionId, runId }) => {
        requireSession(sessionId);
        const result = getRoom(sessionId).cancelUserQuestion({ questionId, runId });
        if (!result.ok) throw new Error(result.error);
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
      "chat:orchestrator:set",
      wrap(async ({ sessionId, enabled, leadId, leadModel, leadEffort, leadReadOnly }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const meta = store.readMeta(sessionId);
        const nextEnabled = Boolean(enabled);
        const nextLeadId = nextEnabled ? (leadId || null) : null;
        if (nextEnabled) {
          const lead = room ? room.findAgent(nextLeadId) : null;
          if (!nextLeadId || !lead || !lead.available || lead.enabled === false) {
            throw new Error("지휘 AI로 쓸 수 있는 에이전트를 골라 주세요.");
          }
        }
        const current = meta.orchestrator || { enabled: false, leadId: null };
        // 모드를 끄거나 지휘 AI를 바꾸면 "모드 꺼짐"과 같은 정리 사유다(설계 §2.1) — 지금 진행 중인
        // 오케스트레이션이 있으면 끝낸다. 켜진 채로 같은 지휘 AI를 다시 보내는 것은 아무 일도 안 한다.
        const endsCurrent = current.enabled && (!nextEnabled || current.leadId !== nextLeadId);
        // 지휘 모델·노력·읽기 전용(2026-10-20 개정)은 지휘 차례에만 쓰이는 선택 설정이다. 생략하면 저장값을 유지하고,
        // 끄거나 지휘 AI를 바꾸면 모델·노력을 비운다(그 공급자의 목록에 없을 수 있다). 바꿔도 진행 중인 오케스트레이션은
        // 끝내지 않는다 — 다음 지휘 차례부터 적용된다.
        const lead = nextEnabled
          ? resolveLeadSettings({ current, nextLeadId, leadModel, leadEffort, leadReadOnly, room })
          : { model: null, effort: null, readOnly: false };
        store.updateMeta(sessionId, {
          orchestrator: {
            enabled: nextEnabled,
            leadId: nextLeadId,
            ...(lead.model ? { leadModel: lead.model } : {}),
            ...(lead.effort ? { leadEffort: lead.effort } : {}),
            ...(lead.readOnly ? { leadReadOnly: true } : {}),
          },
        });
        if (room) {
          room.setMeta(roomMeta(store.readMeta(sessionId)));
          if (endsCurrent && room.orchestration) {
            room.endOrchestration(
              !nextEnabled
                ? "오케스트레이터 모드를 꺼서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다."
                : "지휘 AI를 바꿔서 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다."
            );
          }
        }
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:keep-calling:set",
      wrap(async ({ sessionId, enabled }) => {
        requireSession(sessionId);
        store.updateMeta(sessionId, { keepCalling: Boolean(enabled) });
        const room = getRoom(sessionId);
        if (room) room.setMeta(roomMeta(store.readMeta(sessionId)));
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
        requireWritableSession(sessionId);
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
        requireWritableSession(sessionId);
        // 10개 제한은 importPaths 한 곳에서 걸러 '몇 개 제외' 안내가 드롭에서도 나온다.
        const cleanPaths = (Array.isArray(paths) ? paths : []).filter(
          (entry) => typeof entry === "string" && entry.trim()
        );
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
    // 여러 CLI를 동시에 돌리다 종료해도 하나도 남지 않게, 아래 중지는 taskkill이 끝나기를 기다린다.
    useSynchronousTreeKill();
    if (providerRecheckTimer) {
      clearInterval(providerRecheckTimer);
      providerRecheckTimer = null;
    }
    for (const [sessionId, room] of rooms) {
      // 답을 기다리던 질문은 '중단됨'으로 남기고(다시 켜도 같은 상태), 그다음 실행을 끊는다.
      try {
        room.interruptQuestions();
      } catch {}
      try {
        // 오케스트레이션이 떠 있으면 앱 종료로 조용히 사라지지 않게 한 줄 남긴다(저장되어 다시 열어도
        // 보인다). stopAllSilently가 바로 뒤에서 this.orchestration을 null로 되돌린다.
        if (room.orchestration) {
          const o = room.orchestration;
          room.appendSystem(
            `오케스트레이터 ⟦${o.leadId}⟧ 호출이 ${o.round}라운드/실행 ${o.executions}회에서 앱 종료로 멈췄습니다. 다시 시작하려면 지휘 AI에게 메시지를 보내 주세요.`
          );
        }
        // 토론 중이면 턴 사이라도 'running'으로 남겨, 다시 켠 뒤 끊긴 토론을 닫는다(chat-store closeDanglingDiscussions).
        if ((room.activeRuns > 0 || room.discussionActive) && store && !store.readOnly) {
          store.setSessionStatus(sessionId, "running");
        } else if (store && !store.readOnly) {
          const meta = store.readMeta(sessionId);
          if (meta && meta.status === "running") store.setSessionStatus(sessionId, "idle");
        }
        room.stopAllSilently();
      } catch {}
    }
    // 중계소는 질문 연결이 모두 정리된 뒤 멈춘다. 멈추는 중 오류는 종료를 막지 않는다.
    if (questionBroker) questionBroker.stop().catch((error) => console.warn("[agora] 질문 중계소 종료 실패:", error?.message || error));
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

  // 탐지해 둔 CLI 버전(--version 첫 줄). 아직 탐지 전이면 null이며, 여기서 탐지를 일으키지 않는다.
  // 사용량 조회가 공급자 서버에 CLI와 같은 버전을 밝히는 데 쓴다(AGY).
  function providerVersion(id) {
    return capabilityService?.getRecord?.(id)?.version || null;
  }

  return {
    registerIpcHandlers,
    openWindow,
    getWindow,
    shutdown,
    showSystemNotice,
    notifyProviderAccountChanged,
    providerVersion,
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
