const { EventEmitter } = require("node:events");
const path = require("node:path");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions } = require("./chat-mention");
const { buildAgentPrompt } = require("./chat-prompt");
const { specialistPermissionMode } = require("./chat-argv");
const {
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
  phaseForNode,
} = require("../agora/professional-run");
const { TaskManager, hashText } = require("../agora/task-manager");
const { describeWorkspaceChanges } = require("../agora/workspace-diff");
const {
  installSpecialistMethods,
  safeBlockReason,
  hasOpenQuestions,
  structuredIssuesFromReview,
  stripCodeFences,
  findControlMarker,
  runGeneratedPaths,
} = require("./chat-specialist");
const {
  installDeterministicProfessionalRecorder,
} = require("./chat-professional-recorder");

// 채팅방 오케스트레이션.
// - 멘션이 없으면 세션 참가자 전체, 있으면 멘션된 참가자만 응답합니다.
// - 모든 에이전트 발화는 방 전체의 단일 턴 큐를 통과합니다. 한 번에
//   한 명만 말하고, 뒤 순서는 앞 답변이 끝난 뒤 대화 기록을 읽습니다.
// - 에이전트 답변 속 @멘션은 실제 호출입니다: 호출된 에이전트가 이어서
//   응답합니다. 무한 연쇄는 사용자 발화 기준 연쇄 깊이 상한
//   (mentionChainLimit, 기본 2)으로 차단합니다. @ 없이 이름만 쓰면 언급입니다.
// - 에이전트 간 토론은 startDiscussion()으로만, 라운드(1~3)와
//   총 실행 예산 두 가지 상한 아래에서만 진행됩니다.
const DEFAULT_DISCUSSION_RUN_BUDGET = 9;

// 작업용 채팅에서는 캐릭터 이모티콘 이미지를 더 이상 렌더링하지 않습니다.
// 다만 예전 습관이나 실수로 에이전트가 [[CODEPET_EMOTE:...]] 표기를 남기면
// 화면에 제어 태그가 그대로 노출되지 않도록 텍스트에서만 조용히 제거합니다.
const EMOTICON_TAG_PATTERN = /\[\[CODEPET_EMOTE:[^\]\r\n]+\]\]/g;

function stripEmoticonTags(value) {
  return String(value || "")
    .replace(EMOTICON_TAG_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DEFAULT_MENTION_CHAIN_LIMIT = 2;

let messageSeq = 0;
function nextMessageId() {
  messageSeq += 1;
  return `m${Date.now()}-${messageSeq}`;
}


class ChatRoom extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || null;
    this.agents = options.agents || [];
    this.maxPromptMessages = options.maxPromptMessages;
    // runAgent({agent, prompt, runId, attachments, emitEvent}) => { promise, cancel }
    this.runAgent = options.runAgent;
    this.prepareAgent = options.prepareAgent;
    // TASK-006 Turn Checkpoint 엔진. 제공되지 않으면 사용하지 않습니다.
    // { createCheckpoint, restoreCheckpoint, cleanupCheckpoint } 형태입니다.
    this.checkpointEngine = options.checkpoint || null;
    this.checkpointRoot = options.checkpointRoot || null;
    this.strictReviewDiff = Boolean(options.strictReviewDiff);
    this.persistRecovery = typeof options.persistRecovery === "function"
      ? options.persistRecovery
      : null;
    // TASK-007 Task Manager — Planner Task 저장/Freeze/Run 정규화를 담당합니다.
    // workspace 복원용 checkpoint와는 별개의 실행 계약 보존 모듈입니다.
    this.taskManager = options.taskManager || new TaskManager();
    // TASK-007: Planner가 TASK.md를 만들면 호출되는 콜백으로, 호출 측(chat-ipc)이
    // workflow.json에 metadata를 등록합니다. chat-room은 workflow 저장소를 직접 모릅니다.
    this.onTaskCreated = typeof options.onTaskCreated === "function" ? options.onTaskCreated : null;
    this.onTaskUpdated = typeof options.onTaskUpdated === "function" ? options.onTaskUpdated : null;
    this.onProfessionalTaskState = typeof options.onProfessionalTaskState === "function"
      ? options.onProfessionalTaskState
      : null;
    this.meta = {
      permissionMode: "chat",
      ...(options.meta || {}),
    };
    this.discussionRunBudget = Number.isInteger(options.discussionRunBudget)
      ? options.discussionRunBudget
      : DEFAULT_DISCUSSION_RUN_BUDGET;
    this.mentionChainLimit = Number.isInteger(options.mentionChainLimit)
      ? options.mentionChainLimit
      : DEFAULT_MENTION_CHAIN_LIMIT;
    // 브로드캐스트 응답 순서 셔플에 쓰는 난수원. 테스트에서 고정 순서를
    // 만들 수 있도록 주입 가능합니다.
    this.random = typeof options.random === "function" ? options.random : Math.random;
    this.messages = Array.isArray(options.initialMessages) ? [...options.initialMessages] : [];
    this.generation = 0;
    this.runSeq = 0;
    this.turnSeq = 0;
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns = new Map();
    this.turnActive = false;
    this.currentTurn = null;
    // 사용자가 "잠깐"으로 개입하면 다음 사용자 발화 전까지 에이전트발
    // 멘션 호출을 만들지 않습니다. (현재 발언자의 답변 속 @도 포함)
    this.mentionsMuted = false;
    this.discussionInterrupted = false;
    this.idleWaiters = [];
    this.discussionActive = false;
    this.discussionRequested = false;
    this.specialistActive = false;
    // 전문 실행 중 "기획 승인 후 이어서 진행"할 상태(step/auto에서 PLAN_READY로 멈출 때 저장).
    this.specialistResume = null;
    // 기획 검수를 통과하고 사용자가 승인한 live Task입니다. 구현·검수 블록은
    // 이 Task를 시작 시점에 Frozen Run Contract로 동결해 사용합니다.
    this.professionalPlan = null;
    // BLOCKED로 멈췄을 때 사용자의 후속 선택(복원/유지/폐기)을 기다리는 상태.
    // A안: BLOCKED 시점에 즉시 되돌리지 않고, 사용자가 결정할 때까지 작업물을 보존합니다.
    this.activeRunAuthorization = null;
    this.specialistStages = null;
    this.persistProfessionalRun = typeof options.persistProfessionalRun === "function"
      ? options.persistProfessionalRun
      : null;
    const initialProfessionalRun = options.initialProfessionalRun || options.meta?.professionalRun || null;
    this.professionalRun = initialProfessionalRun ? createProfessionalRun(initialProfessionalRun) : null;
    if (this.professionalRun?.status === "RUNNING") {
      this.professionalRun = {
        ...this.professionalRun,
        status: "INTERRUPTED",
        stopReason: "EXECUTION_INTERRUPTED",
        updatedAt: Date.now(),
      };
      try {
        this.persistProfessionalRun?.(this.professionalRun);
      } catch {}
    }
    this.specialistStages = this.professionalRun?.stages || null;
    if (this.professionalRun?.node === "READY" && this.professionalRun.taskPath) {
      const contract = this.taskManager.resolveTaskContract(
        { contentSource: "file", taskPath: this.professionalRun.taskPath },
        this.meta.workspace
      );
      if (contract?.content?.trim()) {
        this.professionalPlan = {
          stages: this.professionalRun.stages || {},
          mode: "auto",
          implementationAutoRevisions: this.professionalRun.policy?.implementationAutoRevisions || 0,
          taskInfo: {
            relativePath: this.professionalRun.taskPath,
            filename: path.basename(this.professionalRun.taskPath),
            content: contract.content,
            hash: this.professionalRun.approvedTaskHash || hashText(contract.content),
          },
          feedback: contract.content,
        };
      }
    }
    // v3의 실행 상태는 professionalRun이 기준이다. v2의 pendingRecovery는
    // 기존 세션을 여는 호환 입력으로만 사용한다.
    let initialRecovery = this.recoveryFromProfessionalRun(this.professionalRun) || (!this.professionalRun ? options.initialRecovery : null);
    if (initialRecovery?.status === "completed" && initialRecovery.checkpointId && this.checkpointEngine) {
      try {
        const cleanup = this.checkpointEngine.cleanupCheckpoint({
          supported: true,
          checkpointId: initialRecovery.checkpointId,
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: initialRecovery.runId || null,
        });
        if (cleanup?.ok !== false) {
          this.persistRecoveryState(null);
          initialRecovery = null;
        }
      } catch {}
    }
    this.specialistBlocked = this.rehydrateRecovery(initialRecovery);
    this.cancels = new Set();
    this.typingCounts = new Map();
    this.activeRuns = 0;
    this.approvalSeq = 0;
    this.pendingApprovals = new Map();
  }



  setAgents(agents) {
    this.agents = agents || [];
    this.emit("agents", this.publicAgents());
  }

  setMeta(patch) {
    this.meta = { ...this.meta, ...patch };
  }

  enabledAgents() {
    return this.agents.filter((agent) => agent.available && agent.enabled !== false);
  }

  // renderer로 나가는 뷰: 실행 경로/셸 정보는 포함하지 않습니다.
  publicAgents() {
    return this.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      color: agent.color,
      aliases: agent.aliases,
      available: Boolean(agent.available),
      enabled: agent.enabled !== false,
      reason: agent.reason || "",
      model: agent.model || "default",
      effort: agent.effort || "default",
      version: agent.version || "",
      autoApprove: Boolean(agent.autoApprove),
    }));
  }

  state() {
    return {
      sessionId: this.sessionId,
      agents: this.publicAgents(),
      messages: this.messages,
      typing: [...this.typingCounts.keys()],
    };
  }

  // 전문 실행 상태는 renderer 재연결·대화 전환에도 대화별로 복원할 수 있어야 합니다.
  // 실행 중(active), 사람 승인 대기(available), BLOCKED는 서로 다른 상태입니다.
  specialistState() {
    const professional = this.professionalRun
      ? publicProfessionalState(this.professionalRun, {
          canRestore: Boolean(this.specialistBlocked?.canRestore),
        })
      : null;
    const legacyTaskPath =
      this.professionalPlan?.taskInfo?.relativePath ||
      this.specialistResume?.taskInfo?.relativePath ||
      null;
    const taskPath = professional?.taskPath || legacyTaskPath;
    const taskId =
      professional?.taskId ||
      this.professionalPlan?.taskInfo?.filename?.replace(/\.md$/i, "") ||
      this.specialistResume?.taskInfo?.filename?.replace(/\.md$/i, "") ||
      null;
    return {
      active: Boolean(this.specialistActive),
      available: Boolean(this.specialistResume),
      mode: this.specialistResume?.mode || null,
      phase: professional?.phase || this.specialistResume?.phase || null,
      node: professional?.node || null,
      status: professional?.status || null,
      needsInput: Boolean(professional?.needsInput) || ["needs_decision", "plan_review_fix_required"].includes(this.specialistResume?.phase),
      planReady: Boolean(professional?.planReady) || Boolean(this.professionalPlan),
      // 승인된 기획안(Frozen Task 원본)을 채팅에서 열어볼 수 있게 경로/제목을 노출합니다.
      planTaskPath: taskPath,
      planTaskId: taskId,
      blocked: Boolean(professional?.blocked) || Boolean(this.specialistBlocked),
      blockReason: professional?.blockReason ||
        (this.specialistBlocked ? safeBlockReason(this.specialistBlocked.blockReason) : null),
      canRestore: professional?.canRestore || Boolean(this.specialistBlocked?.canRestore),
      hasTask: professional?.hasTask || Boolean(
        this.specialistBlocked?.taskPath || this.specialistResume?.taskInfo?.relativePath
      ),
      frozenRunId: professional?.frozenRunId || null,
      planRound: professional?.planRound || 1,
      implementationRound: professional?.implementationRound || 0,
      stopReason: professional?.stopReason || null,
      checkpointProtection: professional?.checkpointProtection || null,
      checkpointFailReason: professional?.checkpointFailReason || null,
    };
  }

  emitSpecialistState() {
    this.emit("specialist-resume-state", this.specialistState());
  }

  isSpecialistLocked() {
    return Boolean(this.specialistActive || this.specialistResume || this.specialistBlocked);
  }

  appendMessage(message) {
    const entry = { id: nextMessageId(), ts: Date.now(), ...message };
    this.messages.push(entry);
    this.emit("message", entry);
    return entry;
  }

  appendSystem(text) {
    return this.appendMessage({ authorType: "system", author: "system", text });
  }

  findAgent(agentId) {
    return this.agents.find((agent) => agent.id === agentId) || null;
  }

  sendUserMessage(input) {
    const payload = typeof input === "string" ? { text: input } : input || {};
    const trimmed = String(payload.text || "").trim();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const independent = Boolean(payload.independent);
    const recordOnly = Boolean(payload.recordOnly);
    if (!trimmed && attachments.length === 0) return null;
    // renderer 잠금이 늦게 반영되거나 우회되어도 전문 실행 맥락에는 일반 대화가 끼지 않습니다.
    if (this.isSpecialistLocked()) {
      throw new Error("전문 실행이 진행 중이거나 승인 대기 중입니다. 먼저 작업을 완료하거나 취소해 주세요.");
    }

    const entry = this.appendMessage({
      authorType: "user",
      author: "user",
      text: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    entry.turnRootId = entry.id;

    this.mentionsMuted = false;
    // 전문 모드의 작업 요청은 실행 지시 원문으로만 기록한다. 여기서 일반
    // 응답을 예약하면 Planner/Plan Reviewer와 일반 채팅 턴이 섞인다.
    if (recordOnly) return entry;
    const mentionedIds = parseMentions(trimmed, this.agents, GROUP_ALIASES);
    const targets = mentionedIds.length > 0
      ? mentionedIds.map((agentId) => this.findAgent(agentId)).filter(Boolean)
      : this.enabledAgents();
    const respondents = [];
    for (const agent of targets) {
      if (!agent.available) {
        this.appendSystem(
          agent.reason || `@${agent.id} (${agent.name})는 이 컴퓨터에서 CLI를 찾지 못했습니다.`
        );
        continue;
      }
      if (agent.enabled === false) {
        this.appendSystem(`@${agent.id} (${agent.name})는 이 세션에서 비활성화되어 있습니다.`);
        continue;
      }
      respondents.push(agent);
    }

    if (respondents.length > 0) {
      const order = respondents.length > 1 ? this.shuffle(respondents) : respondents;
      order.forEach((agent, index) => {
        this.scheduleResponse(agent, {
          attachments,
          turnRootId: entry.id,
          independent,
          ...(order.length > 1 && !independent
            ? { broadcast: { position: index + 1, total: order.length } }
            : {}),
        });
      });
    }
    return entry;
  }

  shuffle(list) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  requestApproval(agent, approval) {
    this.approvalSeq += 1;
    const approvalId = `a${this.sessionId || "s"}-${this.approvalSeq}`;
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
      this.emit("approval-request", {
        approvalId,
        agentId: agent.id,
        summary: approval?.summary || "도구 실행 권한이 필요합니다.",
        detail: approval?.detail || "",
        retryScope: "turn",
      });
    });
  }

  resolveApproval(approvalId, decision) {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) return false;
    this.pendingApprovals.delete(approvalId);
    resolve(decision === "approve");
    return true;
  }

  // 방 전체 단일 턴 큐. 일반 응답과 멘션 호출은 대기 중인 같은 에이전트의
  // 턴을 공유해, 한 릴레이에서 같은 발언권이 중복 예약되지 않게 합니다.
  scheduleResponse(agent, context = {}) {
    const generation = this.generation;
    const dedupeKey = context.discussionSummary
      ? `summary:${context.discussionSummary.discussionId}`
      : context.simplifyMeta
        ? `simplify:${context.simplifyMeta.messageId}`
        : (context.discussion || !context.turnRootId ? null : `${context.turnRootId}:${agent.id}`);
    if (dedupeKey) {
      if (this.pendingTurns.has(dedupeKey)) {
        return this.pendingTurns.get(dedupeKey).promise;
      }
      if (this.currentTurn && this.currentTurn.dedupeKey === dedupeKey) {
        return this.currentTurn.promise;
      }
    }

    let resolveTurn;
    const promise = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    this.turnSeq += 1;
    const item = {
      turnId: `t${this.turnSeq}`,
      agent,
      context,
      generation,
      dedupeKey,
      promise,
      resolve: resolveTurn,
      promptLimit: this.messages.length,
    };
    if (dedupeKey) this.pendingTurns.set(dedupeKey, item);
    // While a discussion or specialist run is active, defer ordinary
    // (non-discussion, non-specialist) turns so they cannot interject.
    const deferGeneral = (this.discussionActive || this.specialistActive)
      && !context.discussion
      && !context.specialist;
    const queue = deferGeneral
      ? this.deferredTurnQueue
      : this.turnQueue;
    queue.push(item);
    this.emitTurnState();
    this.pumpTurnQueue();
    return promise;
  }

  // 발언 큐 UI가 구독하는 방 전체 턴 상태 스냅숏.
  turnState() {
    const view = (item) => ({
      turnId: item.turnId,
      agentId: item.agent.id,
      discussion: Boolean(item.context.discussion),
    });
    return {
      current: this.currentTurn ? this.currentTurn.agent.id : null,
      queue: this.turnQueue.map(view),
      deferred: this.deferredTurnQueue.map(view),
    };
  }

  emitTurnState() {
    this.emit("turn-state", this.turnState());
  }

  // 사용자 개입("잠깐"): 현재 실행과 대기 턴을 모두 중지하고 발언권을
  // 사용자에게 돌려줍니다. 중지 직전에 도착한 응답이나 @멘션도 세대 가드로
  // 버리며, 다음 사용자 발화 전까지 에이전트발 호출을 만들지 않습니다.
  interject() {
    if (this.specialistActive || this.specialistResume) {
      const cancelled = this.cancelSpecialist();
      this.mentionsMuted = true;
      return { dropped: 0, interrupted: Boolean(cancelled.ok) };
    }
    const dropped = this.turnQueue.length + this.deferredTurnQueue.length;
    const interrupted = dropped > 0 || this.currentTurn !== null || this.cancels.size > 0;
    this.stopAllSilently();
    this.mentionsMuted = true;
    if (interrupted) {
      this.appendSystem("사용자가 개입해 진행 중인 응답과 대기 턴을 중지했습니다. 다음 차례는 사용자입니다.");
    }
    this.emitTurnState();
    return { dropped, interrupted };
  }

  // 발언 큐 UI에서 대기 중인 턴 하나를 콕 집어 취소합니다.
  cancelTurn(turnId) {
    for (const queue of [this.turnQueue, this.deferredTurnQueue]) {
      const index = queue.findIndex((item) => item.turnId === turnId);
      if (index < 0) continue;
      const [item] = queue.splice(index, 1);
      if (item.dedupeKey && this.pendingTurns.get(item.dedupeKey) === item) {
        this.pendingTurns.delete(item.dedupeKey);
      }
      item.resolve(undefined);
      this.emitTurnState();
      return true;
    }
    return false;
  }

  async pumpTurnQueue() {
    if (this.turnActive) return;
    this.turnActive = true;
    try {
      while (this.turnQueue.length > 0) {
        const item = this.turnQueue.shift();
        if (item.dedupeKey && this.pendingTurns.get(item.dedupeKey) === item) {
          this.pendingTurns.delete(item.dedupeKey);
        }
        if (item.generation !== this.generation) {
          item.resolve(undefined);
          this.emitTurnState();
          continue;
        }
        this.currentTurn = item;
        this.emitTurnState();
        let outcome;
        try {
          outcome = await this.respond(
            item.agent,
            { ...item.context, promptLimit: item.promptLimit },
            item.generation
          );
        } catch {
          outcome = undefined;
        }
        this.currentTurn = null;
        this.emitTurnState();
        item.resolve(outcome);
      }
    } finally {
      this.turnActive = false;
      this.resolveIdleWaiters();
      // finally 직전에 새 턴이 들어온 극히 짧은 경합도 놓치지 않습니다.
      if (this.turnQueue.length > 0) this.pumpTurnQueue();
    }
  }

  waitForIdle() {
    if (!this.turnActive && this.turnQueue.length === 0 && this.deferredTurnQueue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  resolveIdleWaiters() {
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  setTyping(agentId, busy) {
    const count = this.typingCounts.get(agentId) || 0;
    const nextCount = busy ? count + 1 : Math.max(0, count - 1);
    if (nextCount === 0) this.typingCounts.delete(agentId);
    else this.typingCounts.set(agentId, nextCount);
    this.emit("typing", { agentId, busy: nextCount > 0 });
  }

  trackRunStart() {
    this.activeRuns += 1;
    if (this.activeRuns === 1) this.emit("busy", true);
  }

  trackRunEnd() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0) this.emit("busy", false);
  }

  promptMessages(promptLimit = null, independent = false) {
    const messages = this.messages;
    if (!Number.isInteger(promptLimit) || promptLimit < 0) {
      return messages.filter((message) => message.authorType !== "system" && !message.error);
    }
    const cap = Math.min(promptLimit, messages.length);
    const base = messages.slice(0, cap);
    if (independent) {
      return base.filter((message) => message.authorType !== "system" && !message.error);
    }
    const roots = new Set(base.map((message) => message.turnRootId).filter(Boolean));
    const extra = messages.slice(cap).filter(
      (message) => message.turnRootId && roots.has(message.turnRootId)
    );
    return [...base, ...extra].filter((message) => message.authorType !== "system" && !message.error);
  }

  async respond(agent, context = {}, generation = this.generation) {
    // 큐에서 기다리는 사이 참가자가 비활성화되거나 CLI가 사라졌다면 실행하지 않습니다.
    const currentAgent = this.findAgent(agent.id);
    if (!currentAgent || !currentAgent.available || currentAgent.enabled === false) return;
    agent = {
      ...currentAgent,
      ...(context.agentConfig || {}),
    };
    const responseAgentMeta = {
      model: agent.model || "default",
      effort: agent.effort || "default",
      version: agent.version || "",
      ...(context.specialist?.stage ? { specialistStage: context.specialist.stage } : {}),
      ...(context.specialist?.frozenTask?.runId
        ? { runId: context.specialist.frozenTask.runId }
        : {}),
      ...(context.specialist?.frozenTask?.taskId
        ? { taskId: context.specialist.frozenTask.taskId }
        : {}),
      ...(context.specialist?.frozenTask?.taskHash
        ? { taskHash: context.specialist.frozenTask.taskHash }
        : {}),
      ...(context.discussionSummary
        ? { discussionSummary: context.discussionSummary }
        : {}),
    };

    const specialistStage = context.specialist?.stage || null;
    let permissionMode;
    if (context.discussionSummary || context.simplifyMeta) {
      permissionMode = "chat";
    } else if (specialistStage) {
      const auth = this.activeRunAuthorization || "workspace-write";
      permissionMode = specialistPermissionMode(specialistStage, auth);
    } else {
      permissionMode = this.meta.permissionMode;
    }
    if (!permissionMode) {
      this.appendSystem("전문 실행 단계의 권한을 계산할 수 없어 실행을 중단했습니다.");
      return { ok: false, stopReason: "UNKNOWN_SPECIALIST_STAGE" };
    }
    const builderStage = specialistStage === "implementation";

    const mentionDepth = context.mentionDepth || 0;

    let prompt;
    try {
      prompt = buildAgentPrompt({
        agent,
        agents: this.enabledAgents(),
        messages: builderStage
          ? []
          : context.discussionSummaryMessages || this.promptMessages(context.promptLimit, context.independent),
        maxMessages: this.maxPromptMessages,
        permissionMode,
        projectContext: this.meta.projectContext,
        memoryContext: this.meta.memoryContext,
        rulesContext: this.meta.rulesContext,
        workflowContext: this.meta.workflowContext,
        discussion: context.discussion || null,
        discussionSummary: context.discussionSummary || null,
        simplifyMeta: context.simplifyMeta || null,
        specialist: context.specialist || null,
        broadcast: context.broadcast || null,
        handoff: context.handoff || null,
        // 전문 모드 실행 중에는 @멘션 호출을 끕니다. 구현·검토·기록이
        // 담당자 밖으로 새어 나가는 것을 막기 위해서입니다.
        mentionsEnabled: !context.discussion && !context.specialist && !context.discussionSummary && !context.simplifyMeta && mentionDepth < this.mentionChainLimit,
      });
    } catch (error) {
      const stopReason = error?.code || "PROMPT_BUILD_FAILED";
      this.appendSystem(`프롬프트 예산을 초과해 전문 실행을 중단했습니다. (${error?.message || "프롬프트를 만들지 못했습니다."})`);
      return { ok: false, stopReason, error: error?.message || stopReason };
    }

    let result;
    let runId;
    let approvedRetry = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.runSeq += 1;
      runId = `r${this.sessionId || "s"}-${this.runSeq}`;
      const emitEvent = (event) => {
        if (generation !== this.generation || !event) return;
        this.emit("run-event", {
          runId,
          agentId: agent.id,
          model: responseAgentMeta.model,
          effort: responseAgentMeta.effort,
          ...(responseAgentMeta.specialistStage
            ? { specialistStage: responseAgentMeta.specialistStage }
            : {}),
          ...event,
        });
      };
      this.setTyping(agent.id, true);
      this.trackRunStart();
      emitEvent({ kind: "run-start" });
      let run;
      try {
        if (typeof this.prepareAgent === "function") {
          await this.prepareAgent({ agent, runId });
          if (generation !== this.generation) return;
        }
        run = this.runAgent({
          agent,
          prompt,
          runId,
          attachments: context.attachments || [],
          emitEvent,
          permissionMode,
          specialistStage,
          // IPC 경계에서 최종 permissionMode를 다시 계산해 실제 invocation을 제한합니다.
          // 여기서는 기존 승인 재시도 계약을 유지한 요청값만 전달합니다.
          // 일반 채팅의 승인 재시도 계약은 유지한다. 실제 provider argv에서는
          // IPC 경계가 workspace-write가 아닌 autoApprove를 다시 차단한다.
          // 전문 실행만 stage cap을 이미 적용한 최종 권한으로 제한한다.
          autoApprove: context.specialist
            ? permissionMode === "workspace-write" && (agent.autoApprove || approvedRetry)
            : agent.autoApprove || approvedRetry,
        });
        this.cancels.add(run.cancel);
        result = await run.promise;
      } catch (error) {
        const detail = error?.message || (error == null ? "" : String(error));
        result = { ok: false, error: detail || "에이전트 실행 중 내부 오류가 발생했습니다." };
      } finally {
        if (run) this.cancels.delete(run.cancel);
        this.setTyping(agent.id, false);
        this.trackRunEnd();
      }
      if (generation !== this.generation || result?.cancelled) return;
      emitEvent({ kind: "run-end", ok: Boolean(result?.ok) });
      if (!result?.approvalRequired || agent.autoApprove || approvedRetry) break;
      const approved = await this.requestApproval(agent, result.approval);
      if (generation !== this.generation) return;
      if (!approved) {
        result = { ok: false, error: "권한 요청을 거부했습니다." };
        break;
      }
      approvedRetry = true;
    }

    // 세대가 바뀌었으면(중지/초기화) 결과를 버립니다. 늦게 도착한 응답이
    // 새 대화에 끼어드는 것을 막는 stale-run 가드입니다.
    if (generation !== this.generation || result?.cancelled) return;

    if (!result?.ok) {
      // 실패한 실행에서도 화면에 보였던 중간 출력과 진단 정보를 잃지 않습니다.
      // 출력 상한 때문에 끊긴 경우는 timeout/프로바이더 실패와 구분해 표시합니다.
      const failureKind = result?.outputLimited
        ? "output-limit"
        : result?.timedOut
          ? "timeout"
          : "error";
      this.appendMessage({
        authorType: "agent",
        author: agent.id,
        text: result?.error || "알 수 없는 오류",
        error: true,
        failureKind,
        ...(result?.partialText ? { partialText: result.partialText } : {}),
        ...(context.turnRootId ? { turnRootId: context.turnRootId } : {}),
        ...(result?.output ? { runOutput: result.output } : {}),
        runId,
        agentMeta: responseAgentMeta,
      });
      return {
        ok: false,
        stopReason: result?.stopReason || (result?.outputLimited ? "OUTPUT_LIMITED" : result?.timedOut ? "TIMED_OUT" : "TRANSPORT_FAILED"),
        error: result?.error || "에이전트 실행에 실패했습니다.",
        evidence: result?.evidence || null,
        transport: result?.cancelled ? "CANCELLED" : result?.timedOut ? "TIMED_OUT" : result?.outputLimited ? "OUTPUT_LIMITED" : "FAILED",
      };
    }

    let rawText = String(result.text || "").trim();
    let discussionSignal = null;
    let specialistSignal = null;
    let plannerStatus = null;
    let builderStatus = null;
    if (context.discussion) {
      const match = rawText.match(/\[\[CODEPET_DISCUSSION:(CONTINUE|AGREE|PASS|CONCLUDE)\]\]\s*$/i);
      discussionSignal = match ? match[1].toUpperCase() : "CONTINUE";
      if (match) rawText = rawText.slice(0, match.index).trim();
    }
    if (context.specialist?.stage === "review" || context.specialist?.stage === "plan_review") {
      // 끝줄에 단독으로 붙는 앵커 마커만 신뢰합니다. 본문 중간의 VERDICT: 언급(인용,
      // 예시, 부정문)은 이 마커를 덮어쓰지 않습니다 — parseReviewContract가 별도로
      // 다루며, 앵커가 없을 때만 본문 마커를 (모호성 검사와 함께) 보조로 씁니다.
      const match = rawText.match(/\[\[CODEPET_REVIEW:(PASS|REVISE|FIX_REQUIRED|UNKNOWN)\]\]\s*$/i);
      if (match) {
        specialistSignal = match[1].toUpperCase();
        // 예전 Provider 출력·테스트 호환을 위해 REVISE는 FIX_REQUIRED로 정규화한다.
        if (specialistSignal === "REVISE") specialistSignal = "FIX_REQUIRED";
        rawText = rawText.slice(0, match.index).trim();
      }
    }
    if (context.specialist?.stage === "planner") {
      const { value, ambiguous } = findControlMarker(rawText, /STATUS:\s*(PLAN_READY|NEEDS_DECISION)\b/i);
      // 서로 다른 STATUS 마커가 여러 번 나오면 어느 쪽이 진짜 결론인지 단정하지
      // 않고 안전한 쪽(NEEDS_DECISION, 사용자 개입)으로 돌려보냅니다.
      plannerStatus = ambiguous ? "NEEDS_DECISION" : value || "NEEDS_DECISION";
    }
    if (context.specialist?.stage === "implementation") {
      const { value, ambiguous } = findControlMarker(rawText, /STATUS:\s*(DONE|BLOCKED)\b/i);
      // DONE을 선언하지 않은 실행을 성공으로 단정하지 않습니다. 모호하거나
      // 누락된 선언은 실제 BLOCKED와 구분해 사용자 개입으로 돌립니다.
      builderStatus = ambiguous ? "AMBIGUOUS" : value || "MISSING";
    }

    let text = stripEmoticonTags(rawText);
    if (context.discussion) {
      if (discussionSignal === "AGREE" && !text) {
        text = "동의합니다.";
      }
      if (discussionSignal === "PASS" && !text) return { ok: true, discussionSignal };
    }

    this.appendMessage({
      authorType: "agent",
      author: agent.id,
      text,
      runId,
      // 실제 실행 시 적용된 역할별 모델을 저장합니다. 일반 채팅의 기본 모델과
      // 달라도 최종·오류 헤더가 실행값을 그대로 표시할 수 있습니다.
      agentMeta: responseAgentMeta,
      ...(context.discussionSummary ? { discussionSummary: context.discussionSummary } : {}),
      ...(context.simplifyMeta ? { simplifyMeta: context.simplifyMeta } : {}),
      ...(context.turnRootId ? { turnRootId: context.turnRootId } : {}),
      ...(result.deliveries ? { deliveries: result.deliveries } : {}),
    });
    // 토론 모드는 자체 턴 오케스트레이션이 있으므로 멘션 호출을 만들지 않습니다.
    if (!context.discussion && !context.specialist && !context.discussionSummary && !context.simplifyMeta) {
      this.scheduleMentionReplies(
        agent,
        text,
        mentionDepth,
        context.attachments || [],
        context.turnRootId
      );
    }
    return {
      ok: true,
      discussionSignal,
      specialistSignal,
      plannerStatus,
      builderStatus,
      text,
      runId,
      evidence: result.evidence || null,
      evidencePersisted: result.evidencePersisted !== false,
      transport: "COMPLETED",
    };
  }

  // 에이전트가 @이름으로 부르면 그 에이전트가 실제로 이어서 응답합니다.
  // 자기 자신은 제외하고, 그룹 별칭 호출은 허용하지 않으며(폭주 방지),
  // 연쇄 깊이 상한으로 무한 호출을 막습니다.
  scheduleMentionReplies(agent, text, depth, attachments = [], turnRootId = null) {
    if (this.mentionsMuted) return;
    if (depth >= this.mentionChainLimit) return;
    const mentionedIds = parseMentions(text, this.agents).filter((id) => id !== agent.id);
    for (const agentId of mentionedIds) {
      const target = this.findAgent(agentId);
      if (!target || !target.available || target.enabled === false) continue;
      this.scheduleResponse(target, { mentionDepth: depth + 1, attachments, turnRootId });
    }
  }

  // 다른 AI가 보낸 특정 메시지를 선택한 에이전트에게 전달해 이어서 답하게 합니다.
  // intent: "REVIEW_OPINION"(검토 요청) 또는 "CONTINUE"(이어서 작업).
  handoffMessage(targetAgentId, messageId, intent = "CONTINUE") {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "토론이나 전문 실행이 진행 중에는 전달할 수 없습니다." };
    }
    const target = this.findAgent(targetAgentId);
    if (!target || !target.available || target.enabled === false) {
      return { ok: false, error: "전달 대상 에이전트를 사용할 수 없습니다." };
    }
    const source = this.messages.find((message) => message.id === messageId);
    if (!source || source.authorType === "system" || source.authorType === "user") {
      return { ok: false, error: "전달할 메시지를 찾을 수 없습니다." };
    }
    if (intent === "SIMPLIFY") {
      const simplifyMeta = {
        text: source.text || "",
        fromAgentId: source.author,
        messageId,
      };
      this.appendSystem(`@${target.id}에게 ${source.author}의 메시지를 알기 쉽게 풀어달라고 요청합니다.`);
      this.scheduleResponse(target, { simplifyMeta });
      return { ok: true };
    }
    const handoff = {
      intent: intent === "REVIEW_OPINION" ? "REVIEW_OPINION" : "CONTINUE",
      text: source.text || "",
      fromAgentId: source.author,
      messageId,
    };
    this.appendSystem(`@${target.id}에게 ${source.author}의 메시지를 전달합니다.`);
    this.scheduleResponse(target, { handoff });
    return { ok: true };
  }

  // 토론 결론 종합: 최근 사용자 질문부터 토론 종료까지의 발언을 대상 에이전트가 요약합니다.
  summarizeDiscussion(discussionId, agentId) {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return Promise.resolve({ ok: false, error: "토론이나 전문 실행이 진행 중에는 요약할 수 없습니다." });
    }
    const agent = this.findAgent(agentId);
    if (!agent || !agent.available || agent.enabled === false) {
      return Promise.resolve({ ok: false, error: "요약할 에이전트를 사용할 수 없습니다." });
    }

    const conclusionMsg = this.messages.find(
      (m) => m.discussionMeta && m.discussionMeta.discussionId === discussionId
    );
    if (!conclusionMsg || !conclusionMsg.discussionMeta) {
      return Promise.resolve({ ok: false, error: "해당 토론 기록을 찾을 수 없습니다." });
    }

    const { startMessageId, endMessageId, incomplete, participants, reason, failures } = conclusionMsg.discussionMeta;
    let startIndex = startMessageId ? this.messages.findIndex((m) => m.id === startMessageId) : 0;
    if (startIndex === -1) startIndex = 0;
    let endIndex = endMessageId ? this.messages.findIndex((m) => m.id === endMessageId) : this.messages.length - 1;
    if (endIndex === -1) endIndex = this.messages.length - 1;

    const rawSlice = this.messages.slice(startIndex, endIndex + 1);
    const discussionMessages = rawSlice.filter(
      (m) => m.authorType !== "system" && !m.error
    );
    if (discussionMessages.length === 0) {
      return Promise.resolve({ ok: false, error: "요약할 토론 메시지가 없습니다." });
    }

    return this.scheduleResponse(agent, {
      discussionSummary: {
        discussionId,
        incomplete,
        participants,
        reason,
        failures: failures || 0,
      },
      discussionSummaryMessages: discussionMessages,
    });
  }


  // 자율 토론: 차례대로 말하되 합의/패스/결론 신호에 따라 일찍 끝냅니다.
  async startDiscussion(options = {}) {
    let pool = this.enabledAgents();
    if (Array.isArray(options.agentIds) && options.agentIds.length > 0) {
      const wanted = new Set(options.agentIds);
      pool = pool.filter((agent) => wanted.has(agent.id));
    }
    if (pool.length < 2) {
      return { ok: false, error: "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다." };
    }
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "이미 토론이 진행 중입니다." };
    }

    const requestedGeneration = this.generation;
    this.discussionRequested = true;
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.discussionRequested = false;
      return { ok: false, cancelled: true };
    }
    this.discussionActive = true;

    // 이번 토론을 촉발한 직전 사용자 질문을 시작 메시지로 특정합니다.
    let startMessageId = null;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].authorType === "user") {
        startMessageId = this.messages[i].id;
        break;
      }
    }
    if (!startMessageId && this.messages.length > 0) {
      startMessageId = this.messages[0].id;
    }
    const discussionId = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const budget = this.discussionRunBudget;
    this.appendSystem(
      `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`
    );

    const generation = this.generation;
    let completed = 0;
    let settled = 0;
    let concluded = false;
    let failures = 0;
    let wasStopped = false;
    try {
      for (let turn = 1; turn <= budget; turn += 1) {
        if (generation !== this.generation) { wasStopped = true; break; }
        if (this.discussionInterrupted) { concluded = true; wasStopped = true; break; }
        const agent = pool[(turn - 1) % pool.length];
        const outcome = await this.scheduleResponse(agent, {
          discussion: { turn, maxTurns: budget },
        });
        completed += 1;
        if (!outcome?.ok) failures += 1;
        const signal = outcome?.discussionSignal || "CONTINUE";
        if (signal === "CONCLUDE") { concluded = true; break; }
        if (signal === "AGREE" || signal === "PASS") settled += 1;
        else settled = 0;
        if (settled >= pool.length) { concluded = true; break; }
      }
    } finally {
      if (generation !== this.generation) wasStopped = true;
      const endMessageId = this.messages[this.messages.length - 1]?.id || startMessageId;
      const incomplete = Boolean(wasStopped || (!concluded && completed >= budget) || failures > 0);
      const reason = wasStopped
        ? "interrupted"
        : failures > 0 && !concluded
          ? "failed"
          : (!concluded && completed >= budget)
            ? "budget"
            : "concluded";
      const conclusionText = wasStopped
        ? (this.discussionInterrupted ? "사용자 개입으로 토론을 여기서 마쳤습니다." : "사용자가 중지해 토론을 여기서 마쳤습니다.")
        : (!concluded && completed >= budget)
          ? `토론 실행 예산(${budget}회)에 도달해 여기서 마쳤습니다.`
          : failures > 0 && !concluded
            ? "일부 에이전트 응답 실패로 토론을 마쳤습니다."
            : "참가자들이 합의하거나 결론에 도달해 토론을 마쳤습니다.";

      this.appendMessage({
        authorType: "system",
        author: "system",
        text: conclusionText,
        discussionMeta: {
          discussionId,
          startMessageId,
          endMessageId,
          concluded,
          completed,
          budget,
          incomplete,
          reason,
          failures,
          participants: pool.map((agent) => agent.id),
        },
      });
      this.discussionActive = false;
      this.discussionRequested = false;
      this.discussionInterrupted = false;
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
    return { ok: true, completed, truncated: !concluded && completed >= budget, concluded };
  }

  stopAll() {
    if (this.specialistActive || this.specialistResume) {
      const cancelled = this.cancelSpecialist();
      if (cancelled.ok) return;
    }
    const hadWork = this.cancels.size > 0 || this.typingCounts.size > 0
      || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0;
    this.stopAllSilently();
    if (hadWork) this.appendSystem("응답을 중지했습니다.");
  }

  clear() {
    if (this.specialistActive || this.specialistResume) this.cancelSpecialist();
    this.stopAllSilently();
    this.messages = [];
    this.emit("reset");
  }

  stopAllSilently() {
    this.generation += 1;
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) item.resolve(undefined);
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns.clear();
    this.mentionsMuted = false;
    this.emitTurnState();
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    for (const cancel of this.cancels) {
      try {
        cancel();
      } catch {}
    }
    this.cancels.clear();
    for (const agentId of [...this.typingCounts.keys()]) {
      this.typingCounts.delete(agentId);
      this.emit("typing", { agentId, busy: false });
    }
    if (this.activeRuns > 0) {
      this.activeRuns = 0;
      this.emit("busy", false);
    }
    this.resolveIdleWaiters();
  }
}

module.exports = { ChatRoom, DEFAULT_DISCUSSION_RUN_BUDGET };


installSpecialistMethods(ChatRoom);
installDeterministicProfessionalRecorder(ChatRoom);
