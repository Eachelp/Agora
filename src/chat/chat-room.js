const { EventEmitter } = require("node:events");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions } = require("./chat-mention");
const { buildAgentPrompt } = require("./chat-prompt");
const { TaskManager } = require("../agora/task-manager");
const { describeWorkspaceChanges } = require("../agora/workspace-diff");

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

function hasOpenQuestions(text) {
  const source = String(text || "");
  const match = /^#{1,6}\s*open\s+questions?\s*$/im.exec(source);
  if (!match) return false;
  const rest = source.slice((match.index || 0) + match[0].length);
  const nextHeading = rest.search(/^#{1,6}\s+/m);
  const content = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest)
    .replace(/^\s*STATUS:\s*\w+.*$/gim, "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/gm, "")
    .trim();
  return content.length > 0 && !/^(?:없음|없습니다|none|n\/?a)\.?$/i.test(content);
}

// 코드펜스(``` ... ```) 안의 텍스트는 인용된 예시/설명일 가능성이 높아
// STATUS/VERDICT 같은 제어 마커 탐지에서 제외합니다. 그렇지 않으면 검토자가
// 예전 답변이나 예시 형식을 인용하기만 해도 그 인용문 속 마커가 실제 판정처럼 읽힙니다.
function stripCodeFences(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "");
}

// 응답 본문에서 STATUS/VERDICT 제어 마커를 찾습니다.
// - 코드펜스 내부는 검사하지 않습니다.
// - 서로 다른 값의 매치가 두 번 이상 나오면(인용·부정문·수정 흔적 등) 어느 것이
//   진짜 결론인지 프로그램이 임의로 단정하지 않고 ambiguous=true로 표시합니다.
//   (같은 값이 반복되는 것은 모호하지 않습니다.)
// - 매치가 있으면 마지막 매치를 채택합니다. 결론은 보통 응답의 끝에 옵니다.
function findControlMarker(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const stripped = stripCodeFences(text);
  const matches = [...stripped.matchAll(globalPattern)].map((match) => match[1].toUpperCase());
  if (matches.length === 0) return { value: null, ambiguous: false };
  const distinct = new Set(matches);
  return { value: matches[matches.length - 1], ambiguous: distinct.size > 1 };
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
    // TASK-007 Task Manager — Planner Task 저장/Freeze/Run 정규화를 담당합니다.
    // workspace 복원용 checkpoint와는 별개의 실행 계약 보존 모듈입니다.
    this.taskManager = options.taskManager || new TaskManager();
    // TASK-007: Planner가 TASK.md를 만들면 호출되는 콜백으로, 호출 측(chat-ipc)이
    // workflow.json에 metadata를 등록합니다. chat-room은 workflow 저장소를 직접 모릅니다.
    this.onTaskCreated = typeof options.onTaskCreated === "function" ? options.onTaskCreated : null;
    this.onTaskUpdated = typeof options.onTaskUpdated === "function" ? options.onTaskUpdated : null;
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
    this.specialistBlocked = null;
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
    return {
      active: Boolean(this.specialistActive),
      available: Boolean(this.specialistResume),
      mode: this.specialistResume?.mode || null,
      phase: this.specialistResume?.phase || null,
      needsInput: ["needs_decision", "plan_review_fix_required"].includes(
        this.specialistResume?.phase
      ),
      planReady: Boolean(this.professionalPlan),
      // 승인된 기획안(Frozen Task 원본)을 채팅에서 열어볼 수 있게 경로/제목을 노출합니다.
      planTaskPath:
        this.professionalPlan?.taskInfo?.relativePath ||
        this.specialistResume?.taskInfo?.relativePath ||
        null,
      planTaskId: (() => {
        const filename =
          this.professionalPlan?.taskInfo?.filename ||
          this.specialistResume?.taskInfo?.filename ||
          null;
        return filename ? String(filename).replace(/\.md$/i, "") : null;
      })(),
      blocked: Boolean(this.specialistBlocked),
      blockReason: this.specialistBlocked?.blockReason || null,
      canRestore: Boolean(this.specialistBlocked?.canRestore),
      hasTask: Boolean(
        this.specialistBlocked?.taskPath || this.specialistResume?.taskInfo?.relativePath
      ),
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
    const dedupeKey = context.discussion || !context.turnRootId
      ? null
      : `${context.turnRootId}:${agent.id}`;
    if (dedupeKey && this.pendingTurns.has(dedupeKey)) {
      return this.pendingTurns.get(dedupeKey).promise;
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
    };

    const mentionDepth = context.mentionDepth || 0;

    const prompt = buildAgentPrompt({
      agent,
      agents: this.enabledAgents(),
      messages: this.promptMessages(context.promptLimit, context.independent),
      maxMessages: this.maxPromptMessages,
      permissionMode: this.meta.permissionMode,
      projectContext: this.meta.projectContext,
      memoryContext: this.meta.memoryContext,
      rulesContext: this.meta.rulesContext,
      workflowContext: this.meta.workflowContext,
      discussion: context.discussion || null,
      specialist: context.specialist || null,
      broadcast: context.broadcast || null,
      handoff: context.handoff || null,
      // 전문 모드 실행 중에는 @멘션 호출을 끕니다. 구현·검토·기록이
      // 담당자 밖으로 새어 나가는 것을 막기 위해서입니다.
      mentionsEnabled: !context.discussion && !context.specialist && mentionDepth < this.mentionChainLimit,
    });

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
          autoApprove: agent.autoApprove || approvedRetry,
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
      return { ok: false };
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
      ...(context.turnRootId ? { turnRootId: context.turnRootId } : {}),
      ...(result.deliveries ? { deliveries: result.deliveries } : {}),
    });
    // 토론 모드는 자체 턴 오케스트레이션이 있으므로 멘션 호출을 만들지 않습니다.
    if (!context.discussion && !context.specialist) {
      this.scheduleMentionReplies(
        agent,
        text,
        mentionDepth,
        context.attachments || [],
        context.turnRootId
      );
    }
    return { ok: true, discussionSignal, specialistSignal, plannerStatus, builderStatus, text, runId };
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

  // 기획·검수 블록: Planner → Reviewer(기획 검수)까지 실행합니다.
  // 질문·보완이 있으면 입력 대기 상태로 멈추고, 통과한 기획만 professionalPlan에 남깁니다.
  async runPlanBlock({
    stages,
    feedback = "",
    taskInfo = null,
    mode = "step",
    planAutoRevisions = 0,
    implementationAutoRevisions = 0,
    action = "plan",
  } = {}) {
    const planner = stages?.planner;
    const review = stages?.review;
    if (!planner?.agent || !review?.agent) {
      return { ok: false, error: "기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    const requestedGeneration = this.generation;
    const planRevisionLimit = Number.isInteger(planAutoRevisions)
      ? Math.min(3, Math.max(0, planAutoRevisions))
      : 0;
    let planRevisionCount = 0;
    let nextFeedback = feedback;
    let nextTaskInfo = taskInfo;
    this.specialistActive = true;
    this.emitSpecialistState();
    try {
      while (true) {
        const planRound = planRevisionCount + 1;
        const plannerResult = await this.scheduleResponse(planner.agent, {
          specialist: {
            stage: "planner",
            round: planRound,
            maxRounds: planRevisionLimit + 1,
            feedback: nextFeedback,
          },
          agentConfig: planner.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!plannerResult?.ok) {
          return this.specialistFail(planner, "planner", planRevisionCount, plannerResult);
        }

        if (plannerResult.plannerStatus === "NEEDS_DECISION" || hasOpenQuestions(plannerResult.text)) {
          this.specialistResume = {
            stages,
            mode,
            planAutoRevisions: planRevisionLimit,
            implementationAutoRevisions,
            action,
            feedback: plannerResult.text || nextFeedback,
            taskInfo: nextTaskInfo,
            phase: "needs_decision",
          };
          this.appendSystem("기획자가 답변이 필요한 질문을 남겼습니다. 아래 전용 입력칸에서 답한 뒤 기획·검수를 다시 실행하세요.");
          return { ok: false, stage: "planner", needsUserDecision: true, stopReason: "NEEDS_DECISION", result: plannerResult };
        }

        const previousTaskInfo = nextTaskInfo;
        if (this.meta.workspace) {
          try {
            nextTaskInfo = previousTaskInfo
              ? this.taskManager.updateTaskFromPlanner(
                  previousTaskInfo,
                  plannerResult.text || "",
                  this.meta.workspace
                )
              : this.taskManager.createTaskFromPlanner(
                  plannerResult.text || "",
                  this.meta.workspace
                );
            if (!previousTaskInfo && nextTaskInfo && this.onTaskCreated) {
              this.onTaskCreated({
                title: nextTaskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
                role: "implementation",
              });
            } else if (previousTaskInfo && nextTaskInfo && this.onTaskUpdated) {
              this.onTaskUpdated({
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
              });
            }
          } catch (error) {
            this.appendSystem(`기획 결과를 TASK.md로 저장하지 못했습니다. (${error?.message || "알 수 없는 오류"})`);
            return { ok: false, stage: "planner", needsUserDecision: true, stopReason: "TASK_SAVE_FAILED", error: error?.message || "알 수 없는 오류" };
          }
        }

        const planText = nextTaskInfo?.content || plannerResult.text || "";
        const planReview = await this.scheduleResponse(review.agent, {
          specialist: {
            stage: "plan_review",
            round: planRound,
            maxRounds: planRevisionLimit + 1,
            feedback: planText,
          },
          agentConfig: review.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!planReview?.ok) {
          return this.specialistFail(review, "plan_review", planRevisionCount, planReview);
        }
        const contract = this.parseReviewContract(planReview.text || "", planReview.specialistSignal);
        if (contract.verdict === "PASS") {
          this.professionalPlan = {
            stages,
            mode,
            implementationAutoRevisions,
            taskInfo: nextTaskInfo,
            feedback: planText,
          };
          this.specialistResume = null;
          this.appendSystem("기획 검수가 통과했습니다. 이제 구현·검수를 실행하거나 전체 실행으로 이어갈 수 있습니다.");
          return { ok: true, stage: "plan_review", planReady: true, taskInfo: nextTaskInfo };
        }

        if (hasOpenQuestions(planReview.text)) {
          contract.canAutoRevise = false;
          contract.stopReason = "NEEDS_DECISION";
        }
        if (
          contract.verdict === "FIX_REQUIRED" &&
          contract.canAutoRevise &&
          planRevisionCount < planRevisionLimit
        ) {
          planRevisionCount += 1;
          nextFeedback = planReview.text || planText;
          this.appendSystem(
            `기획 검수 결과 수정 필요 · 자동 보완 ${planRevisionCount}/${planRevisionLimit}회`
          );
          continue;
        }

        this.specialistResume = {
          stages,
          mode,
          planAutoRevisions: planRevisionLimit,
          implementationAutoRevisions,
          action,
          feedback: planReview.text || planText,
          taskInfo: nextTaskInfo,
          phase: "plan_review_fix_required",
        };
        this.appendSystem(
          contract.stopReason === "NEEDS_DECISION"
            ? "기획 검수자가 사용자 결정이 필요한 질문을 남겨 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 답해 주세요."
            : contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "기획 검수 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요."
            : contract.verdict === "UNKNOWN"
            ? "기획 검수에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요."
            : planRevisionCount >= planRevisionLimit && planRevisionLimit > 0
              ? `기획 자동 보완 한도(${planRevisionLimit}회)에 도달했습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요.`
              : "기획 검수에서 보완 또는 사용자 답변이 필요하다고 판단했습니다. 아래 전용 입력칸에서 답한 뒤 기획·검수를 다시 실행하세요."
        );
        return {
          ok: false,
          stage: "plan_review",
          needsUserDecision: true,
          stopReason:
            planRevisionLimit > 0 &&
            planRevisionCount >= planRevisionLimit &&
            contract.canAutoRevise
              ? "LIMIT_EXCEEDED"
              : contract.stopReason || contract.verdict,
          contract,
          result: planReview,
        };
      }
    } finally {
      // 전체 실행은 기획·검수와 구현·검수를 같은 블록으로 이어야 하므로,
      // 기획 검수 통과 직후에는 일반 대화 대기열을 풀지 않습니다.
      if (action === "full" && this.professionalPlan) {
        this.emitSpecialistState();
      } else {
        this.specialistActive = false;
        this.emitSpecialistState();
        this.turnQueue.push(...this.deferredTurnQueue.splice(0));
        this.emitTurnState();
        this.pumpTurnQueue();
      }
    }
  }

  // Open Question·기획 검수 피드백에 대한 사용자 답변을 Planner의 다음 입력으로 보관합니다.
  async answerPlanQuestion(answer) {
    const resume = this.specialistResume;
    if (!resume || !["needs_decision", "plan_review_fix_required"].includes(resume.phase)) {
      return { ok: false, error: "답변을 기다리는 기획 질문이 없습니다." };
    }
    const text = String(answer || "").trim();
    if (!text) return { ok: false, error: "기획자에게 보낼 답변을 입력해 주세요." };
    this.specialistResume = null;
    this.appendMessage({ authorType: "user", author: "user", text: `[기획 답변] ${text}` });
    const feedback = `${resume.feedback || ""}\n\n=== 사용자 답변 ===\n${text}\n=== 사용자 답변 끝 ===`;
    const result = await this.runPlanBlock({ ...resume, feedback, taskInfo: resume.taskInfo || null });
    if (resume.action === "full" && result?.ok) {
      return this.runProfessionalImplementation({
        stages: resume.stages,
        mode: resume.mode,
        implementationAutoRevisions: resume.implementationAutoRevisions,
        recordAfter: true,
      });
    }
    return result;
  }

  // 기존 호출 경로는 유지합니다. action을 명시한 새 화면만 버튼형 전문 실행을 씁니다.
  async startSpecialist(options = {}) {
    if (options.action) return this.startProfessionalAction(options);
    return this.startLegacySpecialist(options);
  }

  // 전문 모드 진입점. 화면의 버튼은 action으로 구분합니다.
  // - plan: 기획 → 기획 검수
  // - implementation: 승인된 기획 → 구현 → 구현 검수
  // - record: 기록관만 수동 실행
  // - full: 기획·검수와 구현·검수를 연속 실행하되 질문/보완/막힘에서 중단
  async startProfessionalAction(options = {}) {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    // 일반 응답이 실행·대기 중이면 전문 실행을 큐 뒤에 넣지 않고 즉시 거부합니다.
    // (전문 실행이 일반 응답 뒤에 몰래 대기하지 않도록 합니다.)
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시작해 주세요." };
    }
    const stages = options.stages || {};
    const action = ["plan", "implementation", "record", "full"].includes(options.action)
      ? options.action
      : "plan";
    const implementation = stages.implementation;
    const review = stages.review;
    if ((action === "plan" || action === "full") && (!stages.planner?.agent || !review?.agent)) {
      return { ok: false, error: "전문 모드의 기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    if ((action === "implementation" || action === "full") && (!implementation?.agent || !review?.agent)) {
      return { ok: false, error: "전문 모드의 구현·검토 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    if (action === "full" && !stages.recorder?.agent) {
      return { ok: false, error: "전체 실행에는 기록 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    const planAutoRevisions = Number.isInteger(options.planAutoRevisions)
      ? Math.min(3, Math.max(0, options.planAutoRevisions))
      : 0;
    const implementationAutoRevisions = Number.isInteger(options.implementationAutoRevisions)
      ? Math.min(3, Math.max(0, options.implementationAutoRevisions))
      : Number.isInteger(options.maxAutoRevisions)
        ? Math.min(3, Math.max(0, options.maxAutoRevisions))
        : 0;
    // 전체 실행은 블록을 이어 붙이고, 구현 자동 보완을 켠 경우에는
    // 구현·검수 버튼에서도 제한된 Builder↔Reviewer 왕복을 허용합니다.
    const mode =
      action === "full" ||
      options.mode === "auto" ||
      implementationAutoRevisions > 0
        ? "auto"
        : "step";

    if (action === "record") {
      if (!stages.recorder?.agent) return { ok: false, error: "기록 담당자를 프로젝트 설정에서 지정해 주세요." };
      this.specialistActive = true;
      this.emitSpecialistState();
      try {
        const recorderResult = await this.runRecorder(stages.recorder);
        return recorderResult?.ok
          ? { ok: true, recorded: true, recording: recorderResult.text || "" }
          : recorderResult;
      } finally {
        this.specialistActive = false;
        this.emitSpecialistState();
      }
    }

    if (action === "plan" || action === "full") {
      this.professionalPlan = null;
      const planResult = await this.runPlanBlock({
        stages,
        mode,
        planAutoRevisions,
        implementationAutoRevisions,
        action,
      });
      if (action !== "full" || !planResult?.ok) return planResult;
      return this.runProfessionalImplementation({
        stages,
        mode,
        implementationAutoRevisions,
        recordAfter: true,
      });
    }

    return this.runProfessionalImplementation({
      stages,
      mode,
      implementationAutoRevisions,
      recordAfter: false,
    });
  }

  async runProfessionalImplementation({
    stages,
    mode,
    implementationAutoRevisions,
    recordAfter,
  }) {
    const implementation = stages.implementation;
    const review = stages.review;
    if (!this.professionalPlan?.taskInfo) {
      return { ok: false, error: "구현·검수는 기획 검수가 통과한 뒤에 실행할 수 있습니다. 먼저 기획·검수를 실행해 주세요." };
    }

    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.specialistResume = null;
    // 이전 실행에서 BLOCKED로 보류된 checkpoint가 남아 있으면 리소스만 정리합니다.
    // (작업물은 사용자 소유이므로 되돌리지 않습니다.)
    if (this.specialistBlocked) {
      if (this.checkpointEngine && this.specialistBlocked.checkpoint) {
        this.checkpointEngine.cleanupCheckpoint(this.specialistBlocked.checkpoint);
      }
      this.specialistBlocked = null;
    }
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }

    this.appendSystem(`구현·검수 시작 · 구현 @${implementation.agent.id} · 검수 @${review.agent.id}`);

    const feedback = this.professionalPlan.feedback || "";
    const taskInfo = this.professionalPlan.taskInfo;
    try {
      return await this.runExecutionBlock({
        stages,
        mode,
        maxAutoRevisions: implementationAutoRevisions,
        feedback,
        taskInfo,
        round: 1,
        requestedGeneration,
        recordAfter,
      });
    } finally {
      this.specialistActive = false;
      // PLAN_READY 등 승인 Gate에서는 resume 상태가 이미 먼저 전송됩니다.
      // 여기서 active=false를 다시 알리지 않으면 renderer가 "실행 중"으로
      // 남아 승인 버튼을 비활성화한 채 멈춥니다.
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 기획 승인 후 이어서 진행합니다. step/auto에서 PLAN_READY로 멈춘 상태만 재개합니다.
  async resumeSpecialist() {
    if (this.discussionRequested || this.discussionActive || this.specialistActive) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    if (!this.specialistResume) {
      return { ok: false, error: "이어서 진행할 기획이 없습니다. 전문 모드를 다시 시작해 주세요." };
    }
    // 일반 응답이 실행·대기 중이면 이어서 진행하지 않고 거부합니다.
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시도해 주세요." };
    }
    const resume = this.specialistResume;
    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }
    this.specialistResume = null;
    this.emitSpecialistState();
    // 단계별(step) 실행은 phase에 따라 다음 한 단계만 진행합니다.
    if (resume.mode === "step") {
      return this.resumeStepPhase(resume, requestedGeneration);
    }
    this.appendSystem("기획이 승인되었습니다. 구현을 이어서 진행합니다.");
    try {
      return await this.runExecutionBlock({
        stages: resume.stages,
        mode: resume.mode,
        maxAutoRevisions: resume.maxAutoRevisions,
        feedback: resume.feedback,
        taskInfo: resume.taskInfo || null,
        round: 1,
        requestedGeneration,
      });
    } finally {
      this.specialistActive = false;
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 기존 step / 제한 자동 / 빠른 실행 호출 호환용 경로입니다.
  async startLegacySpecialist(options = {}) {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시작해 주세요." };
    }
    const stages = options.stages || {};
    const implementation = stages.implementation;
    const review = stages.review;
    const planner = stages.planner;
    if (!implementation?.agent || !review?.agent) {
      return { ok: false, error: "전문 모드의 구현·검토 담당자를 프로젝트 설정에서 지정해 주세요." };
    }

    const mode = options.mode === "auto" ? "auto" : options.mode === "quick" ? "quick" : "step";
    const maxAutoRevisions = Number.isInteger(options.maxAutoRevisions) && options.maxAutoRevisions >= 0
      ? Math.min(options.maxAutoRevisions, 3)
      : mode === "step" ? 0 : 1;
    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.specialistResume = null;
    if (this.specialistBlocked) {
      if (this.checkpointEngine && this.specialistBlocked.checkpoint) {
        this.checkpointEngine.cleanupCheckpoint(this.specialistBlocked.checkpoint);
      }
      this.specialistBlocked = null;
    }
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }

    this.appendSystem(`전문 모드 시작 · 구현 @${implementation.agent.id} · 검토 @${review.agent.id}`);
    let feedback = "";
    let taskInfo = null;
    try {
      if (planner?.agent) {
        const plannerResult = await this.scheduleResponse(planner.agent, {
          specialist: { stage: "planner", round: 1, maxRounds: 1 },
          agentConfig: planner.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!plannerResult?.ok) return this.specialistFail(planner, "planner", 0, plannerResult);
        if (plannerResult.plannerStatus === "NEEDS_DECISION") {
          return {
            ok: false,
            stage: "planner",
            completedIterations: 0,
            needsUserDecision: true,
            stopReason: "NEEDS_DECISION",
            result: plannerResult,
          };
        }
        if (this.meta.workspace) {
          try {
            taskInfo = this.taskManager.createTaskFromPlanner(plannerResult.text || "", this.meta.workspace);
            if (taskInfo && this.onTaskCreated) {
              this.onTaskCreated({
                title: taskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: taskInfo.relativePath,
                taskHash: taskInfo.hash,
                status: "todo",
                role: "implementation",
              });
            }
          } catch (error) {
            this.appendSystem(`기획 결과를 TASK.md로 저장하지 못했습니다. (${error?.message || "알 수 없는 오류"})`);
            return {
              ok: false,
              stage: "planner",
              completedIterations: 0,
              needsUserDecision: true,
              stopReason: "PLAN_READY",
              result: plannerResult,
              taskError: error?.message || "알 수 없는 오류",
            };
          }
        }
        feedback = taskInfo ? taskInfo.content : plannerResult.text || "";
        if (mode !== "quick") {
          this.specialistResume = { stages, mode, maxAutoRevisions, feedback, taskInfo, phase: "plan_ready" };
          this.emitSpecialistState();
          this.appendSystem("기획(PLAN_READY)이 완료되었습니다. 승인하시면 구현을 이어서 진행합니다.");
          return {
            ok: false,
            stage: "planner",
            completedIterations: 0,
            needsUserDecision: true,
            stopReason: "PLAN_READY",
            result: plannerResult,
          };
        }
      }

      return await this.runExecutionBlock({
        stages,
        mode,
        maxAutoRevisions,
        feedback,
        taskInfo,
        round: 1,
        requestedGeneration,
      });
    } finally {
      this.specialistActive = false;
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 승인 대기 중인 전문 실행을 명시적으로 끝냅니다.
  // 이미 만들어진 Builder 변경은 복원하지 않고 보존합니다. 복원이 필요하면 BLOCKED 메뉴를 씁니다.
  cancelSpecialist() {
    if (!this.specialistActive && !this.specialistResume) {
      return { ok: false, error: "취소할 전문 실행이 없습니다." };
    }
    const checkpoint = this.specialistResume?.checkpoint || null;
    this.specialistResume = null;
    this.specialistActive = false;
    this.stopAllSilently();
    if (checkpoint && this.checkpointEngine) {
      this.checkpointEngine.cleanupCheckpoint(checkpoint);
    }
    this.emitSpecialistState();
    this.appendSystem("전문 실행을 취소했습니다. 현재 작업 결과는 그대로 유지됩니다.");
    return { ok: true, cancelled: true };
  }

  // 단계별(step) 실행의 다음 단계를 진행합니다.
  //   plan_ready          → Builder 실행 후 phase: builder_done으로 멈춤
  //   builder_done        → Reviewer 실행
  //   review_fix_required → Builder 보완 (step에서는 사용자 확인 후 수동 진행)
  //   review_pass         → Recorder 실행 후 완료
  async resumeStepPhase(resume, requestedGeneration) {
    const { stages, feedback, taskInfo, maxAutoRevisions } = resume;
    const implementation = stages.implementation;
    const review = stages.review;
    const recorder = stages.recorder;
    const workspace = this.meta.workspace;
    // TASK-007: step 모드에서도 실행 시점에 Task를 동결(Freeze)합니다.
    // 승인 시점에 한 번 FREEZE하고, 같은 Run의 모든 단계(builder·review·보완)가
    // 동일한 불변 Frozen Task를 사용하도록 resume에 runInfo를 보관합니다.
    let runInfo = resume.runInfo || null;
    let checkpoint = resume.checkpoint || null;
    let retainCheckpoint = false;
    const frozenTaskId = taskInfo?.filename ? String(taskInfo.filename).replace(/\.md$/i, "") : null;
    const frozenTaskMeta = () =>
      runInfo
        ? {
            runId: runInfo.runId,
            content: runInfo.content,
            taskId: frozenTaskId,
            taskHash: runInfo.taskHash || null,
          }
        : null;
    const freezeOnce = async () => {
      if (runInfo) return runInfo;
      if (taskInfo) {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
      }
      // TASK-006: Builder 실행 직전 workspace 상태 보존 (지원 시).
      if (!checkpoint && this.checkpointEngine) {
        checkpoint = await this.checkpointEngine.createCheckpoint(workspace);
      }
      return runInfo;
    };
    const cleanupCheckpoint = () => {
      if (checkpoint?.supported === true && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
    };
    const holdForBlocked = (blockedRound, blockedResult, declaration = "BLOCKED") => {
      const canRestore = Boolean(checkpoint && checkpoint.supported === true);
      const stopReason = declaration === "MISSING"
        ? "BUILDER_STATUS_MISSING"
        : declaration === "AMBIGUOUS"
          ? "BUILDER_STATUS_AMBIGUOUS"
          : "BLOCKED";
      const message = declaration === "MISSING"
        ? "구현 결과에 STATUS: DONE 또는 STATUS: BLOCKED가 없어 안전하게 멈췄습니다. 아래에서 다음 처리를 선택해 주세요."
        : declaration === "AMBIGUOUS"
          ? "구현 결과에 서로 다른 STATUS 표기가 있어 최종 상태를 판단할 수 없습니다. 아래에서 다음 처리를 선택해 주세요."
          : "구현이 막혔습니다(BLOCKED). 아래에서 다음 처리를 선택해 주세요.";
      this.specialistBlocked = {
        checkpoint: canRestore ? checkpoint : null,
        canRestore,
        taskPath: taskInfo?.relativePath || null,
        runId: runInfo?.runId || null,
        stage: "implementation",
        blockReason: stopReason,
      };
      retainCheckpoint = canRestore;
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(message);
      return { ok: false, stage: "implementation", completedIterations: blockedRound, needsUserDecision: true, stopReason, blocked: true, canRestore, result: blockedResult };
    };

    try {
      if (resume.phase === "plan_ready") {
        // 승인 시점에 Task를 동결하고 Checkpoint를 생성합니다.
        try {
          await freezeOnce();
        } catch (error) {
          this.appendSystem(`Frozen Task를 만들지 못해 실행을 중단합니다. (${error?.message || "알 수 없는 오류"})`);
          return { ok: false, stage: "planner", completedIterations: 0, needsUserDecision: true, stopReason: "FROZEN_TASK_MISSING", taskError: error?.message || "알 수 없는 오류" };
        }
        // Builder 실행.
        const builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 1, maxRounds: 1, feedback: runInfo ? runInfo.content : feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!builderResult?.ok) return this.specialistFail(implementation, "implementation", 1, builderResult);
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(1, builderResult, builderResult.builderStatus);
        // 구현 완료 → 사용자 확인 대기.
        this.specialistResume = { ...resume, phase: "builder_done", runInfo, checkpoint, builderChanges: (await describeWorkspaceChanges(workspace)).text };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("구현이 완료되었습니다. 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 1, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      if (resume.phase === "builder_done") {
        // Reviewer 실행.
        const reviewResult = await this.scheduleResponse(review.agent, {
          specialist: { stage: "review", round: 1, maxRounds: 1, frozenTask: frozenTaskMeta(), reviewDiff: resume.builderChanges || "" },
          agentConfig: review.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!reviewResult?.ok) return this.specialistFail(review, "review", 1, reviewResult);
        const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
        if (contract.verdict === "PASS") {
          this.specialistResume = { ...resume, phase: "review_pass", runInfo, checkpoint };
          retainCheckpoint = Boolean(checkpoint?.supported);
          this.emitSpecialistState();
          this.appendSystem("검토가 통과되었습니다. 기록하고 완료하려면 승인해 주세요.");
          return { ok: false, stage: "review", completedIterations: 1, needsUserDecision: true, stopReason: "REVIEW_PASS", contract };
        }
        if (contract.verdict === "UNKNOWN") {
          this.specialistActive = false;
          this.appendSystem(
            contract.stopReason === "AMBIGUOUS_VERDICT"
              ? "검토 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래에서 직접 확인해 주세요."
              : "검토에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래에서 직접 확인해 주세요."
          );
          return {
            ok: false,
            stage: "review",
            completedIterations: 1,
            needsUserDecision: true,
            stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
            contract,
            review: reviewResult,
          };
        }
        // FIX_REQUIRED → 사용자 확인 후 수동 보완.
        this.specialistResume = { ...resume, phase: "review_fix_required", reviewContract: contract, reviewText: reviewResult.text || "", runInfo, checkpoint };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("검토에서 수정 필요가 나왔습니다. 수정을 진행하려면 승인해 주세요.");
        return { ok: false, stage: "review", completedIterations: 1, needsUserDecision: true, stopReason: "FIX_REQUIRED", contract, review: reviewResult };
      }

      if (resume.phase === "review_fix_required") {
        // Builder 보완 후 다시 검토.
        const builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 2, maxRounds: 1, feedback: resume.reviewText || feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!builderResult?.ok) return this.specialistFail(implementation, "implementation", 2, builderResult);
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(2, builderResult, builderResult.builderStatus);
        this.specialistResume = { ...resume, phase: "builder_done", runInfo, checkpoint, builderChanges: (await describeWorkspaceChanges(workspace)).text };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("보완이 완료되었습니다. 다시 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 2, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      if (resume.phase === "review_pass") {
        // Recorder 실행 후 완료.
        let recorderResult = null;
        if (recorder?.agent) {
          recorderResult = await this.scheduleResponse(recorder.agent, {
            specialist: { stage: "recorder", round: 1, maxRounds: 1 },
            agentConfig: recorder.agentConfig,
          });
          if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
          if (!recorderResult?.ok) {
            this.specialistActive = false;
            const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
            this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
            return { ok: true, completedIterations: 1, recorded: false, recording: recorderResult?.text || "", recordError };
          }
        }
        this.specialistActive = false;
        this.appendSystem("전문 모드 구현·검토·기록이 완료되었습니다.");
        return { ok: true, completedIterations: 1, recorded: Boolean(recorderResult?.ok), recording: recorderResult?.text || "" };
      }

      this.specialistActive = false;
      return { ok: false, error: "알 수 없는 단계입니다." };
    } finally {
      this.specialistActive = false;
      if (!retainCheckpoint) cleanupCheckpoint();
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // Builder → Reviewer → (auto면 자동 보완) → 기록관(블록 끝) 실행 블록.
  async runExecutionBlock({ stages, mode, maxAutoRevisions, feedback, taskInfo, round, requestedGeneration, recordAfter = true }) {
    const implementation = stages.implementation;
    const review = stages.review;
    const recorder = stages.recorder;
    // 자동 진행 모드여도 사용자가 보완 횟수를 허용한 경우에만 재실행합니다.
    const canAutoRevise =
      (mode === "auto" || mode === "quick") && maxAutoRevisions > 0;
    const maxRounds = canAutoRevise ? maxAutoRevisions + 1 : 1;
    let autoRevisionCount = 0;
    let recorderResult = null;
    // TASK-008: Builder가 만든 실제 변경(Diff)을 수집해 Reviewer에게 전달합니다.
    // 각 Builder 실행 직후 갱신되며, 검토자는 이 Diff를 Frozen Task와 함께 받습니다.
    let builderChanges = "";

    // TASK-007: 실행 계약(Freeze)을 checkpoint보다 먼저 수행합니다.
    // 실행 순서: Task 승인 → Run 생성/Freeze → Checkpoint → Builder
    // - runInfo가 이미 있으면(같은 Run의 자동 보완) 재freeze하지 않고 재사용합니다.
    // - Planner Task(inline 포함)든 수동 Task든 하나의 RUN/task.md로 정규화합니다.
    // - Frozen Task 누락/손상 시 현재 TASK.md로 fallback 하지 않고 중단합니다.
    let runInfo = null;
    const workspace = this.meta.workspace;
    if (taskInfo) {
      try {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
      } catch (error) {
        this.appendSystem(`Frozen Task를 만들지 못해 실행을 중단합니다. (${error?.message || "알 수 없는 오류"})`);
        return {
          ok: false,
          stage: "planner",
          completedIterations: 0,
          needsUserDecision: true,
          stopReason: "FROZEN_TASK_MISSING",
          taskError: error?.message || "알 수 없는 오류",
        };
      }
    }

    // TASK-006: Builder 실행 직전 workspace 상태를 보존합니다.
    // 지원되지 않는 workspace(git 아님/없음)라면 checkpoint를 만들지 않고 진행합니다.
    const checkpoint = this.checkpointEngine
      ? await this.checkpointEngine.createCheckpoint(this.meta.workspace)
      : null;

    // 화면에 "어떤 Task revision 기준으로 일하는 중인지" 칩으로 보여주기 위한 값.
    // TASK-003.md → "TASK-003" 형태의 표시용 id를 만듭니다.
    const frozenTaskId = taskInfo?.filename
      ? String(taskInfo.filename).replace(/\.md$/i, "")
      : null;
    const frozenTaskMeta = () =>
      runInfo
        ? {
            runId: runInfo.runId,
            content: runInfo.content,
            taskId: frozenTaskId,
            taskHash: runInfo.taskHash || null,
          }
        : null;
    const checkpointSupported = Boolean(checkpoint && checkpoint.supported === true);
    const restoreCheckpoint = async () => {
      if (!checkpointSupported || !this.checkpointEngine) return;
      await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, checkpoint);
      this.checkpointEngine.cleanupCheckpoint(checkpoint);
    };
    const cleanupCheckpoint = () => {
      if (checkpointSupported && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
    };

    // BLOCKED(A안): 즉시 되돌리지 않고 Builder 작업물을 그대로 둔 채 멈춥니다.
    // 사용자가 [작업 전으로 복원]/[Task 폐기]를 고르면 그때 복원합니다.
    const holdForBlocked = (blockedRound, blockedResult, declaration = "BLOCKED") => {
      const stopReason = declaration === "MISSING"
        ? "BUILDER_STATUS_MISSING"
        : declaration === "AMBIGUOUS"
          ? "BUILDER_STATUS_AMBIGUOUS"
          : "BLOCKED";
      this.specialistBlocked = {
        checkpoint: checkpointSupported ? checkpoint : null,
        canRestore: checkpointSupported,
        taskPath: taskInfo?.relativePath || null,
        runId: runInfo?.runId || null,
        stage: "implementation",
        blockReason: stopReason,
      };
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(
        declaration === "MISSING"
          ? "구현 결과에 STATUS: DONE 또는 STATUS: BLOCKED가 없어 안전하게 멈췄습니다. 아래에서 다음 처리를 선택해 주세요."
          : declaration === "AMBIGUOUS"
            ? "구현 결과에 서로 다른 STATUS 표기가 있어 최종 상태를 판단할 수 없습니다. 아래에서 다음 처리를 선택해 주세요."
            : checkpointSupported
              ? "구현이 막혔습니다(BLOCKED). 지금까지의 변경은 그대로 두었습니다. 아래에서 다음 처리를 선택해 주세요."
              : "구현이 막혔습니다(BLOCKED). 아래에서 다음 처리를 선택해 주세요. (git workspace가 아니라 자동 복원은 지원되지 않습니다)"
      );
      return {
        ok: false,
        stage: "implementation",
        completedIterations: blockedRound,
        needsUserDecision: true,
        stopReason,
        blocked: true,
        canRestore: checkpointSupported,
        result: blockedResult,
      };
    };

    let builderResult = await this.scheduleResponse(implementation.agent, {
      specialist: {
        stage: "implementation",
        round,
        maxRounds,
        // TASK-007: 최초 Builder의 실행 계약 source는 Frozen Task입니다.
        // (자동 보완에서는 아래에서 Reviewer 피드백도 별도로 전달합니다.)
        feedback: runInfo ? runInfo.content : feedback,
        frozenTask: frozenTaskMeta(),
      },
      agentConfig: implementation.agentConfig,
    });
    // Builder 실행이 끝난 뒤 실제 변경분을 수집합니다. (git 아니면 빈 값)
    builderChanges = (await describeWorkspaceChanges(workspace)).text;
    if (requestedGeneration !== this.generation) {
      cleanupCheckpoint();
      return { ok: false, cancelled: true };
    }
    if (!builderResult?.ok) {
      await restoreCheckpoint();
      return this.specialistFail(implementation, "implementation", round, builderResult);
    }
    if (builderResult.builderStatus !== "DONE") {
      return holdForBlocked(round, builderResult, builderResult.builderStatus);
    }

    // 검토 → (자동 보완) 루프.
    while (true) {
      const reviewResult = await this.scheduleResponse(review.agent, {
        specialist: {
          stage: "review",
          round,
          maxRounds,
          // TASK-007: Reviewer는 동일 Run의 Frozen Task + 실제 Diff + Test 기준으로 검수합니다.
          frozenTask: frozenTaskMeta(),
          // TASK-008: Builder가 실제로 만든 변경(Diff)을 주입합니다.
          reviewDiff: builderChanges,
        },
        agentConfig: review.agentConfig,
      });
      if (requestedGeneration !== this.generation) {
        cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!reviewResult?.ok) {
        await restoreCheckpoint();
        return this.specialistFail(review, "review", round, reviewResult);
      }

      const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
      if (contract.verdict === "PASS") break;
      if (contract.verdict === "UNKNOWN") {
        await restoreCheckpoint();
        this.appendSystem(
          contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "검토 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래에서 직접 확인해 주세요."
            : "검토에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래에서 직접 확인해 주세요."
        );
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
          contract,
          review: reviewResult,
        };
      }

      // FIX_REQUIRED: 자동 보완 가능하면 보완, 아니면 STOP → 사용자.
      if (!contract.canAutoRevise) {
        await restoreCheckpoint();
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: contract.stopReason || "FIX_REQUIRED",
          contract,
          review: reviewResult,
        };
      }
      if (!canAutoRevise || autoRevisionCount >= maxAutoRevisions) {
        await restoreCheckpoint();
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: !canAutoRevise
            ? "FIX_REQUIRED"
            : "LIMIT_EXCEEDED",
          contract,
          review: reviewResult,
        };
      }

      // 자동 보완.
      autoRevisionCount += 1;
      round += 1;
      feedback = reviewResult.text || "검토자가 수정이 필요하다고 판단했습니다.";
      this.appendSystem(`검토 결과 수정 필요 · 자동 보완 ${autoRevisionCount}/${maxAutoRevisions}회`);
      builderResult = await this.scheduleResponse(implementation.agent, {
        specialist: {
          stage: "implementation",
          round,
          maxRounds,
          // TASK-007: 자동 보완도 같은 Run, 같은 Frozen Task를 사용합니다.
          // Frozen Task는 요구사항 기준이고, feedback은 이번에 고칠 Reviewer 지시입니다.
          feedback,
          frozenTask: frozenTaskMeta(),
        },
        agentConfig: implementation.agentConfig,
      });
      // 자동 보완 후에도 diff를 다시 수집해 최신 변경분을 검토에 반영합니다.
      builderChanges = (await describeWorkspaceChanges(workspace)).text;
      if (requestedGeneration !== this.generation) {
        cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!builderResult?.ok) {
        await restoreCheckpoint();
        return this.specialistFail(implementation, "implementation", round, builderResult);
      }
      if (builderResult.builderStatus !== "DONE") {
        return holdForBlocked(round, builderResult, builderResult.builderStatus);
      }
    }

    // 성공(PASS/기록 완료) 시 checkpoint 리소스를 정리합니다.
    if (checkpointSupported && this.checkpointEngine) {
      this.checkpointEngine.cleanupCheckpoint(checkpoint);
    }

    // PASS 후 기록관(선택) 실행 — 실행 블록의 마지막 단계로 블록을 마무리합니다.
    if (recordAfter && recorder?.agent) {
      recorderResult = await this.scheduleResponse(recorder.agent, {
        specialist: { stage: "recorder", round, maxRounds: 1 },
        agentConfig: recorder.agentConfig,
      });
      if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
      if (!recorderResult?.ok) {
        const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
        this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
        return { ok: true, completedIterations: round, recorded: false, recording: recorderResult?.text || "", recordError };
      }
    }

    this.appendSystem("전문 모드 구현·검토가 통과했습니다.");
    return {
      ok: true,
      completedIterations: round,
      recorded: Boolean(recorderResult?.ok),
      recording: recorderResult?.text || "",
    };
  }

  // 검토자 출력 계약을 파싱합니다. 판정(verdict)은 다음 우선순위로 정합니다:
  //   1) 끝줄 단독 앵커 마커([[CODEPET_REVIEW:...]], respond()가 signal로 전달) —
  //      본문 어디에도 등장하지 않는 전용 표기라 위조·오인 가능성이 가장 낮습니다.
  //   2) 앵커가 없을 때만 본문 중 VERDICT: 마커를 보조로 씁니다. 단, 서로 다른 값의
  //      마커가 두 번 이상 나오면(인용·부정문·수정 흔적 등) 어느 것이 진짜 결론인지
  //      단정하지 않고 UNKNOWN + stopReason: AMBIGUOUS_VERDICT로 사용자에게 반환합니다.
  // 구조화 섹션(ISSUES)은 "있으면 사용, 없으면 SCOPE_UNSPECIFIED"로 처리합니다.
  parseReviewContract(text, signal) {
    const { value: bodyVerdict, ambiguous } = findControlMarker(
      text,
      /VERDICT:\s*(PASS|FIX_REQUIRED|REVISE|UNKNOWN)\b/i
    );
    const normalizedBodyVerdict = bodyVerdict === "REVISE" ? "FIX_REQUIRED" : bodyVerdict;
    let verdict;
    if (signal) {
      verdict = signal;
    } else if (ambiguous) {
      verdict = "UNKNOWN";
    } else {
      verdict = normalizedBodyVerdict || "UNKNOWN";
    }

    const issuesIndex = text.indexOf("ISSUES:");
    const issuesText = issuesIndex !== -1 ? text.slice(issuesIndex) : "";
    const issueBlocks = issuesText
      .split(/\n\d+\.\s*\n|\n\d+\.\s+/)
      .filter((block) => block.trim().length > 0);

    const blockingScopes = [];
    let scopeUnspecified = false;
    for (const block of issueBlocks) {
      const hasBlocking = /severity:\s*BLOCKING/i.test(block);
      const scopeMatch = block.match(/scope:\s*(IN|OUT)/i);
      if (hasBlocking) {
        if (!scopeMatch) scopeUnspecified = true;
        else blockingScopes.push(scopeMatch[1].toUpperCase());
      }
    }

    let stopReason = null;
    let canAutoRevise = false;
    if (verdict === "UNKNOWN" && !signal && ambiguous) {
      stopReason = "AMBIGUOUS_VERDICT";
    } else if (verdict === "UNKNOWN") {
      stopReason = "INSUFFICIENT_EVIDENCE";
    } else if (verdict === "FIX_REQUIRED") {
      if (scopeUnspecified || blockingScopes.length === 0) {
        stopReason = "SCOPE_UNSPECIFIED";
      } else if (blockingScopes.some((scope) => scope === "OUT")) {
        stopReason = "SCOPE_OUT";
      } else {
        canAutoRevise = true;
      }
    }
    return {
      verdict,
      stopReason,
      canAutoRevise,
      blockingScopes,
      hasBlocking: blockingScopes.length > 0,
    };
  }

  // 전문 모드 실패 시 어떤 역할/에이전트/모델에서 실패했는지 정보를 담아 반환합니다.
  specialistFail(stageAgent, stage, completedIterations, result = {}) {
    return {
      ok: false,
      stage,
      completedIterations,
      role: stage,
      agentId: stageAgent?.agent?.id || null,
      model: stageAgent?.agentConfig?.model || stageAgent?.agent?.modelId || "기본",
      error: result?.error || `${stage} 단계에서 에이전트 실행에 실패했습니다.`
    };
  }

  // BLOCKED 후속 처리 (A안).
  // BLOCKED 시점에는 되돌리지 않고 보류했으므로, 사용자가 고른 조치를 여기서 수행합니다.
  //   keep    — 현재 변경을 그대로 유지하고 보류 상태만 해제
  //   restore — checkpoint 시점(=Builder 실행 전)으로 되돌림. 사용자 사전 변경은 보존
  //   discard — 되돌린 뒤 Task까지 폐기 대상으로 표시
  async resolveBlocked(action) {
    const pending = this.specialistBlocked;
    if (!pending) {
      return { ok: false, error: "처리할 막힘(BLOCKED) 상태가 없습니다." };
    }
    if (!["keep", "restore", "discard"].includes(action)) {
      return { ok: false, error: "올바르지 않은 처리 동작입니다." };
    }
    if ((action === "restore" || action === "discard") && !pending.canRestore) {
      return { ok: false, error: "git workspace가 아니어서 자동 복원을 할 수 없습니다." };
    }

    let restored = false;
    if (action === "restore" || action === "discard") {
      if (this.checkpointEngine && pending.checkpoint) {
        const result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, pending.checkpoint);
        restored = Boolean(result?.ok);
        if (!restored) {
          return { ok: false, error: "작업 전 상태로 되돌리지 못했습니다. 변경은 그대로 두었습니다." };
        }
      }
    }
    if (this.checkpointEngine && pending.checkpoint) {
      this.checkpointEngine.cleanupCheckpoint(pending.checkpoint);
    }

    this.specialistBlocked = null;
    this.emitSpecialistState();
    this.appendSystem(
      action === "keep"
        ? "막힘 처리: 지금까지의 변경을 그대로 유지합니다."
        : action === "restore"
          ? "막힘 처리: 작업 전 상태로 되돌렸습니다. (실행 전부터 있던 사용자 변경은 보존)"
          : "막힘 처리: 작업 전 상태로 되돌리고 이 작업을 폐기했습니다."
    );
    return { ok: true, action, restored, taskPath: pending.taskPath || null };
  }

  async runRecorder(options = {}) {
    if (!options.agent) return { ok: false, error: "기록관 담당자가 없습니다." };
    return this.scheduleResponse(options.agent, {
      specialist: {
        stage: "recorder",
        round: options.round || 1,
        maxRounds: options.maxRounds || 1,
      },
      agentConfig: options.agentConfig,
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

    const budget = this.discussionRunBudget;
    this.appendSystem(
      `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`
    );

    const generation = this.generation;
    let completed = 0;
    let settled = 0;
    let concluded = false;
    try {
      for (let turn = 1; turn <= budget; turn += 1) {
        if (generation !== this.generation) break;
        if (this.discussionInterrupted) { concluded = true; break; }
        const agent = pool[(turn - 1) % pool.length];
        const outcome = await this.scheduleResponse(agent, {
          discussion: { turn, maxTurns: budget },
        });
        completed += 1;
        const signal = outcome?.discussionSignal || "CONTINUE";
        if (signal === "CONCLUDE") { concluded = true; break; }
        if (signal === "AGREE" || signal === "PASS") settled += 1;
        else settled = 0;
        if (settled >= pool.length) { concluded = true; break; }
      }

      if (generation === this.generation) {
        if (this.discussionInterrupted) {
          this.appendSystem("사용자 개입으로 토론을 여기서 마쳤습니다.");
        } else if (!concluded && completed >= budget) {
          this.appendSystem(`토론 실행 예산(${budget}회)에 도달해 여기서 마쳤습니다.`);
        } else {
          this.appendSystem("참가자들이 합의하거나 결론에 도달해 토론을 마쳤습니다.");
        }
      }
    } finally {
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
