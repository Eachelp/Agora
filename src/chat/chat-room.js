const { EventEmitter } = require("node:events");
const path = require("node:path");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions } = require("./chat-mention");
const { filesModifiedSince } = require("../agora/workspace-scan");
const { buildAgentPrompt } = require("./chat-prompt");
const {
  resolveProtocol,
  speakerForTurn,
  isFinalStep,
  DISCUSSION_HARD_TURN_CEILING,
} = require("../agora/discussion-protocol");
const { RATE_LIMITED_STOP_REASON } = require("./rate-limit-signal");
// 응답 꼬리의 질문 계약(ASK_USER + OPTION).
const { parseControlOutput, stripControlOutput } = require("./control-output");

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

// V1.5: 토론 길이를 사용자가 고를 수 있다(짧게 9 / 보통 15 / 길게 30 / 직접
// 설정). 렌더러가 어떤 값을 보내든 실행 상한은 이 범위를 넘지 못한다.
// 상한은 구조화 토론의 cycle 상한과 같은 hard ceiling을 공유한다.
const DISCUSSION_TURN_BUDGET_MIN = 3;
const DISCUSSION_TURN_BUDGET_MAX = DISCUSSION_HARD_TURN_CEILING;

function clampDiscussionTurnBudget(value, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(DISCUSSION_TURN_BUDGET_MIN, Math.min(DISCUSSION_TURN_BUDGET_MAX, value));
}

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
const LOST_TURN_STALL_SECONDS = 120;
// 실행 중인 일반 턴이 이 시간 넘게 진전(delta·도구·파일)이 없으면 한 번 안내한다.
// 큐 정체 경고는 "시작 못 한 턴"만 보고, 러너 무음 감지는 실행을 죽이지 않으므로,
// 한도로 조용히 멈춘 실행에는 이 안내가 유일한 탈출 신호다.
const PROGRESS_STALL_MINUTES = 10;

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
    // 앱을 다시 켜도 이전 실행의 로그·지표 파일과 runId가 겹치지 않도록, 호출자가
    // 디스크에 이미 있는 번호를 읽어 그 다음부터 매기게 넘겨 준다.
    this.runSeq = Number.isInteger(options.runSeqStart) && options.runSeqStart > 0 ? options.runSeqStart : 0;
    this.turnSeq = 0;
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns = new Map();
    this.lostTurnNotified = new Set();
    this.progressStallNotified = new Set();
    this.turnStartedAt = new Map();
    this.turnActive = false;
    // 지금 실행 중인 턴들. 독립 발언 묶음에서는 여러 개가 동시에 들어간다.
    this.runningTurns = new Set();
    // 팬아웃 중에는 펌프를 미룬다(0이면 평소처럼 즉시 실행).
    this.pumpSuspended = 0;
    this.currentTurn = null;
    // 사용자가 "잠깐"으로 개입하면 다음 사용자 발화 전까지 에이전트발
    // 멘션 호출을 만들지 않습니다. (현재 발언자의 답변 속 @도 포함)
    this.mentionsMuted = false;
    this.discussionInterrupted = false;
    this.idleWaiters = [];
    this.discussionActive = false;
    this.discussionRequested = false;
    this.cancels = new Set();
    this.typingCounts = new Map();
    // agentId → { question } : 되질문으로 턴을 끝내 사용자 답을 기다리는 에이전트.
    this.awaitingUsers = new Map();
    this.activeRuns = 0;
    // activeRuns는 화면 busy 표시용이라 중지하면 즉시 0으로 되돌린다.
    // liveRuns는 "정말로 살아 있는 실행"이며, subprocess가 실제로 끝나야만
    // 줄어든다. 세션 삭제는 이쪽이 0이 될 때까지 기다린다.
    this.liveRuns = 0;
    this.approvalSeq = 0;
    this.pendingApprovals = new Map();
  }



  setAgents(agents) {
    this.agents = agents || [];
    // 목록에서 빠진 에이전트의 대기 상태는 남겨 둘 이유가 없다.
    if (this.awaitingUsers.size > 0) {
      const live = new Set(this.agents.map((agent) => agent.id));
      for (const agentId of [...this.awaitingUsers.keys()]) {
        if (!live.has(agentId)) this.awaitingUsers.delete(agentId);
      }
    }
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
      // 되질문으로 턴을 끝내 사용자 답을 기다리는 상태. 동시 실행 중에도
      // 화면이 "누가 나를 기다리는가"를 배지로 모아 보여줄 수 있게 낸다.
      awaitingUser: this.awaitingUsers.has(agent.id),
      awaitingQuestion: this.awaitingUsers.get(agent.id)?.question || null,
      // 산문에서 뽑은 보기(있으면). 화면이 클릭 가능한 칩으로 띄운다.
      awaitingOptions: this.awaitingUsers.get(agent.id)?.options || [],
    }));
  }

  // 되질문으로 끝난 에이전트를 '답변 대기'로 세운다. 질문·보기가 그대로면
  // 재방출하지 않아 렌더러가 불필요하게 다시 그리지 않는다.
  setAwaitingUser(agentId, question, options = []) {
    const trimmed = (question || "").trim() || null;
    const opts = Array.isArray(options) ? options : [];
    const prev = this.awaitingUsers.get(agentId);
    if (
      prev &&
      prev.question === trimmed &&
      JSON.stringify(prev.options || []) === JSON.stringify(opts)
    ) {
      return;
    }
    this.awaitingUsers.set(agentId, { question: trimmed, options: opts });
    this.emit("agents", this.publicAgents());
  }

  // 사용자가 답했거나(그 에이전트가 새 턴을 시작), 대상이 사라지면 대기를 푼다.
  clearAwaitingUser(agentId) {
    if (!this.awaitingUsers.has(agentId)) return;
    this.awaitingUsers.delete(agentId);
    this.emit("agents", this.publicAgents());
  }

  state() {
    return {
      sessionId: this.sessionId,
      agents: this.publicAgents(),
      messages: this.messages,
      typing: [...this.typingCounts.keys()],
    };
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
      // 독립 발언은 서로의 답을 보지 않는다 = 앞 사람을 기다릴 이유가 없다.
      // 한 그룹으로 묶어 동시에 실행한다(이어 발언은 앞 답을 입력으로 쓰므로 순차).
      const parallelGroupId = independent && order.length > 1 ? `pg-${entry.id}` : null;
      // 전원을 큐에 올린 뒤에 한 번만 펌프를 돌린다(묶음이 쪼개지지 않게).
      this.pumpSuspended += 1;
      try {
        order.forEach((agent, index) => {
          // 아직 시작하지 않은 이 담당자의 턴은 방금 온 메시지를 보지 못하므로
          // 걷어내고 새로 잡는다. 새 턴은 걷어낸 턴이 답하려던 메시지의 첨부까지
          // 함께 받는다.
          const superseded = this.supersedeQueuedTurns(agent.id);
          this.scheduleResponse(agent, {
            attachments: superseded.length > 0
              ? this.attachmentsOfMessages([...superseded, entry.id])
              : attachments,
            turnRootId: entry.id,
            independent,
            ...(parallelGroupId ? { parallelGroupId, parallelTotal: order.length } : {}),
            ...(order.length > 1 && !independent
              ? { broadcast: { position: index + 1, total: order.length } }
              : {}),
          });
        });
      } finally {
        this.pumpSuspended -= 1;
      }
      this.pumpTurnQueue();
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
    const payload = {
      approvalId,
      agentId: agent.id,
      summary: approval?.summary || "도구 실행 권한이 필요합니다.",
      detail: approval?.detail || "",
      retryScope: "turn",
    };
    return new Promise((resolve) => {
      // 이벤트는 창이 열려 있을 때만 닿는다. 요청 내용도 함께 들고 있어야 창이 닫혀 있던
      // 사이에 온 요청을 상태 스냅숏(pendingApprovalList)으로 다시 보여 줄 수 있다.
      this.pendingApprovals.set(approvalId, { resolve, payload });
      this.emit("approval-request", payload);
      this.emit("approval-wait");
    });
  }

  // 아직 답하지 않은 승인 요청. 화면이 (다시) 붙을 때 상태 스냅숏에 실려 나간다.
  pendingApprovalList() {
    return [...this.pendingApprovals.values()].map((entry) => ({ ...entry.payload }));
  }

  resolveApproval(approvalId, decision) {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return false;
    this.pendingApprovals.delete(approvalId);
    entry.resolve(decision === "approve");
    this.emit("approval-wait");
    return true;
  }

  // 방 전체 단일 턴 큐. 일반 응답과 멘션 호출은 대기 중인 같은 에이전트의
  // 턴을 공유해, 한 릴레이에서 같은 발언권이 중복 예약되지 않게 합니다.
  scheduleResponse(agent, context = {}) {
    const generation = this.generation;
    // 담당 에이전트까지 키에 넣는다. 빼면 같은 토론·메시지를 다른 AI에게 한 두 번째
    // 요청이 첫 턴의 promise를 받고 조용히 사라진다.
    const dedupeKey = context.discussionSummary
      ? `summary:${context.discussionSummary.discussionId}:${agent.id}`
      : context.simplifyMeta
        ? `simplify:${context.simplifyMeta.messageId}:${agent.id}`
        : (context.discussion || !context.turnRootId ? null : `${context.turnRootId}:${agent.id}`);
    if (dedupeKey) {
      if (this.pendingTurns.has(dedupeKey)) {
        return this.pendingTurns.get(dedupeKey).promise;
      }
      // 실행 중인 턴 전체를 본다. 병렬 묶음에서는 currentTurn 하나만 보면
      // 같은 사용자 메시지가 같은 대상에게 두 번 배정될 수 있다.
      //
      // 다만 실행 중인 턴은 이미 프롬프트를 만들어 들어갔으므로, 방금 도착한
      // @멘션을 대신 볼 수 없다. 그 promise를 돌려주면 호출이 조용히 사라진다
      // — 동시 실행에서만 열리는 창이고(순차 실행에서는 멘션 대상이 실행 중일
      // 수 없다), 사용자에겐 "불렀는데 아무도 대답하지 않는" 것으로 보인다.
      // 그래서 최초 배정(mentionDepth 0)만 접고, 멘션 호출은 새 턴으로 잡는다.
      if (!context.mentionDepth) {
        for (const running of this.runningTurns) {
          if (running.dedupeKey === dedupeKey) return running.promise;
        }
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
    this.trackTurnWait(item);
    // 토론이 진행 중이면 일반 턴은 끼어들지 못하게 뒤로 미룬다.
    const deferGeneral = this.discussionActive && !context.discussion;
    const queue = deferGeneral
      ? this.deferredTurnQueue
      : this.turnQueue;
    queue.push(item);
    this.emitTurnState();
    // 한 발화가 여러 명에게 팬아웃되는 동안에는 펌프를 미룬다. 첫 턴을 넣자마자
    // 돌리면 나머지가 큐에 들어오기 전에 실행이 시작돼, 같이 돌아야 할 독립
    // 발언 묶음이 한 명씩으로 쪼개진다.
    if (this.pumpSuspended === 0) this.pumpTurnQueue();
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
      // 동시에 도는 턴이 여럿일 수 있다(독립 발언). current는 그중 첫 번째다.
      running: [...this.runningTurns].map((item) => item.agent.id),
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

  // 큐를 떠나는 턴의 장부 정리. 실행되든 버려지든 반드시 거친다 — dedupe 키가
  // 남으면 같은 요청을 다시 보낼 수 없고, 대기 타이머가 남으면 이미 끝난 턴에
  // "유실됐을 수 있다" 안내가 뜬다.
  releaseQueuedTurn(item) {
    if (item.dedupeKey && this.pendingTurns.get(item.dedupeKey) === item) {
      this.pendingTurns.delete(item.dedupeKey);
    }
    this.turnStartedAt.delete(item.turnId);
  }

  // 실행 없이 끝나는 턴. lost면 사용자에게 다시 보내라고 안내한다(중지·취소).
  // 갈아끼우기처럼 질문이 새 턴으로 그대로 전달되는 경우는 안내하지 않는다.
  retireTurn(item, outcome, { lost = false } = {}) {
    this.releaseQueuedTurn(item);
    item.resolve(outcome);
    if (lost) this.notifyLostTurn(item);
  }

  // 발언 큐 UI에서 대기 중인 턴 하나를 콕 집어 취소합니다.
  cancelTurn(turnId) {
    for (const queue of [this.turnQueue, this.deferredTurnQueue]) {
      const index = queue.findIndex((item) => item.turnId === turnId);
      if (index < 0) continue;
      const [item] = queue.splice(index, 1);
      this.retireTurn(item, undefined, { lost: true });
      this.emitTurnState();
      return true;
    }
    return false;
  }

  // 사용자 메시지에 뿌리를 둔 이 담당자의 대기 턴을 걷어내고, 걷어낸 턴들이
  // 답하려던 사용자 메시지 id를 돌려준다.
  //
  // 대기 턴은 예약 시점의 히스토리(promptLimit)를 붙들고 있어, 사용자가 생각을
  // 나눠 보내면 앞 조각만 보고 답하고 조각마다 턴이 하나씩 생겨 같은 담당자가
  // 여러 번 답했다. 새 메시지로 다시 잡으면 전체를 보고 한 번만 답한다. 실행
  // 중인 턴은 이미 프롬프트가 들어갔으므로 건드리지 않고, 유실 안내도 내지
  // 않는다 — 질문은 새 턴이 그대로 전달한다.
  supersedeQueuedTurns(agentId) {
    const roots = [];
    for (const queue of [this.turnQueue, this.deferredTurnQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const item = queue[index];
        if (item.agent.id !== agentId) continue;
        if (!item.context.turnRootId || !this.isFreeChatContext(item.context)) continue;
        queue.splice(index, 1);
        if (!roots.includes(item.context.turnRootId)) roots.push(item.context.turnRootId);
        this.retireTurn(item);
      }
    }
    return roots;
  }

  // 이 사용자 메시지들에 딸린 첨부를 대화 순서대로 모은다. 첨부는 턴 context로
  // 러너에 전달되지만 원천은 메시지 엔트리다 — 턴을 갈아끼워도 여기서 다시 읽으면
  // 된다.
  attachmentsOfMessages(messageIds) {
    const wanted = new Set(messageIds);
    return this.messages
      .filter((message) => wanted.has(message.id) && Array.isArray(message.attachments))
      .flatMap((message) => message.attachments);
  }

  async pumpTurnQueue() {
    if (this.turnActive) return;
    this.turnActive = true;
    try {
      while (this.turnQueue.length > 0) {
        // 같은 독립 발언 그룹은 한 묶음으로 동시에 돌린다. 그 외에는 예전처럼
        // 한 번에 하나씩 — 이어 발언은 앞 사람의 답이 다음 사람의 입력이다.
        const groupId = this.turnQueue[0].context?.parallelGroupId || null;
        if (!groupId) {
          await this.runQueuedTurn(this.turnQueue.shift());
          continue;
        }
        const batch = [];
        while (this.turnQueue.length > 0 && this.turnQueue[0].context?.parallelGroupId === groupId) {
          batch.push(this.turnQueue.shift());
        }
        await this.runParallelTurns(batch);
      }
    } finally {
      this.turnActive = false;
      this.resolveIdleWaiters();
      // finally 직전에 새 턴이 들어온 극히 짧은 경합도 놓치지 않습니다.
      if (this.turnQueue.length > 0) this.pumpTurnQueue();
    }
  }

  // 지금 실행 중인 턴들. 순차 실행에서는 언제나 0개 또는 1개다.
  syncCurrentTurn() {
    this.currentTurn = this.runningTurns.size > 0 ? [...this.runningTurns][0] : null;
  }

  async runQueuedTurn(item) {
    if (item.generation !== this.generation) {
      this.retireTurn(item, undefined, { lost: true });
      this.emitTurnState();
      return;
    }
    this.releaseQueuedTurn(item);
    this.runningTurns.add(item);
    this.syncCurrentTurn();
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
    this.runningTurns.delete(item);
    this.syncCurrentTurn();
    this.emitTurnState();
    item.resolve(outcome);
  }

  // 독립 발언 묶음을 동시에 실행한다.
  //
  // 같은 파일을 두 담당자가 함께 고치면 나중 쓰기가 이깁니다 — 사용자가 각자
  // 따로 만들라고 지시한 경우를 위한 실행 방식이며, 파일 단위 충돌은 막지 않습니다.
  async runParallelTurns(batch) {
    // 담당자별 폴더 계약이 지켜졌는지는 실행이 끝난 뒤에 본다. 시작 시각만
    // 기억해 두면 되므로 실행이 늦어지지 않는다. 쓰기 권한 방에서만 본다.
    const startedAt = this.meta.permissionMode === "workspace-write" ? Date.now() : null;
    const generation = this.generation;
    await Promise.all(batch.map((item) => this.runQueuedTurn(item)));
    // 중지·초기화로 세대가 바뀌었으면 알리지 않는다. 비워진 대화에 뒤늦은
    // 안내만 남는다.
    if (startedAt !== null && generation === this.generation) {
      await this.reportFolderContractBreaches(batch, startedAt);
    }
  }

  // 담당자별 폴더 계약 감시 — 실행 전후 상태를 비교해 "폴더 밖이 바뀌었다"를 알린다.
  //
  // 계약 자체는 프롬프트로 준 지시이고 강제가 아니다(argv 경계는 작업 폴더 전체를
  // 열어 준다). 그래서 여기서 하는 일은 막는 것이 아니라 **보이게 하는 것**이다.
  // 조용히 덮어써진 파일을 사용자가 나중에 발견하는 것이 가장 나쁜 결과다.
  async reportFolderContractBreaches(batch, startedAt) {
    if (!this.meta.workspace) return;
    let outside;
    try {
      const scan = await filesModifiedSince(this.meta.workspace, startedAt);
      // 훑지 못했으면(너무 큰 폴더, 시간 초과) 아무 말도 하지 않는다.
      if (!scan.ok) return;
      const changed = scan.paths;
      if (changed.length === 0) return;
      // 담당자 폴더 안의 변경은 계약대로다. 누가 남의 폴더에 썼는지는 알 수 없고
      // (동시에 돌았으므로 변경을 담당자에게 귀속시킬 수 없다), 그 판단은 사용자가
      // 결과를 보고 하는 편이 정확하다. 여기서는 "폴더 밖"만 센다.
      const folders = batch.map((item) => `${item.agent.id}/`);
      outside = changed.filter((rel) => !folders.some((folder) => rel.startsWith(folder)));
      if (outside.length === 0) return;
    } catch {
      return;
    }
    const shown = outside.slice(0, 8).map((rel) => `\`${rel}\``).join(", ");
    const rest = outside.length > 8 ? ` 외 ${outside.length - 8}개` : "";
    const folders = batch.map((item) => `\`${item.agent.id}/\``).join(", ");
    this.appendSystem(
      `이 묶음이 실행되는 동안 담당자 폴더(${folders}) 밖에서 바뀐 파일(다른 대화나 직접 수정일 수 있음): ${shown}${rest}. `
      + "각자 자기 폴더에서만 작업하도록 안내했지만 강제되지는 않습니다 — "
      + "서로의 결과를 덮어썼을 수 있으니 확인해 주세요."
    );
  }

  waitForIdle() {
    if (!this.turnActive && this.turnQueue.length === 0 && this.deferredTurnQueue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // 토론이 아닌 일반 턴이 중지·세대 교체로 사라지면 조용히 넘기지 않고
  // 다시 보내라고 알린다.
  isGeneralTurn(item) {
    return !item.context.discussion;
  }

  trackTurnWait(item) {
    if (!this.isGeneralTurn(item)) return;
    if (this.lostTurnNotified.has(item.turnId)) return;
    this.turnStartedAt.set(item.turnId, Date.now());
    const stallTimer = setTimeout(() => this.checkTurnStall(item.turnId), LOST_TURN_STALL_SECONDS * 1000);
    if (typeof stallTimer.unref === "function") stallTimer.unref();
  }

  checkTurnStall(turnId) {
    const startedAt = this.turnStartedAt.get(turnId);
    if (startedAt === undefined) return;
    if (Date.now() - startedAt < LOST_TURN_STALL_SECONDS * 1000) return;
    if (this.lostTurnNotified.has(turnId)) return;
    const queued = this.turnQueue.some((item) => item.turnId === turnId)
      || this.deferredTurnQueue.some((item) => item.turnId === turnId);
    if (!queued) return;
    const item = this.turnQueue.find((item) => item.turnId === turnId)
      || this.deferredTurnQueue.find((item) => item.turnId === turnId);
    // 앞 순서가 돌고 있으면 유실이 아니라 정상 대기다. 예전에는 둘을 구분하지
    // 않고 "유실됐을 수 있으니 다시 보내 주세요"라고만 안내해, 멀쩡히 기다리는
    // 턴을 사용자가 다시 보내게 만들었다.
    //
    // 이때 lostTurnNotified를 소비하면 안 된다. 그 집합은 "이 턴의 유실을 이미
    // 알렸다"는 표시이고, notifyLostTurn이 그걸 보고 건너뛴다. 대기 안내로
    // 태워 버리면 나중에 이 턴이 중지로 실제 버려질 때 아무 안내도 남지 않는다.
    if (this.runningTurns.size > 0) {
      const running = [...this.runningTurns].map((entry) => `@${entry.agent.id}`).join(", ");
      this.appendSystem(
        "@" + item.agent.id + " 응답은 아직 차례를 기다리고 있습니다 (" + running + " 실행 중). 그대로 기다리면 이어서 실행됩니다."
      );
      return;
    }
    this.lostTurnNotified.add(turnId);
    this.appendSystem("@" + item.agent.id + " 응답이 " + LOST_TURN_STALL_SECONDS + "초 넘게 시작되지 않고 있습니다. 응답이 유실됐을 수 있으니 기다리지 말고 다시 보내 주세요.");
  }

  isFreeChatContext(context = {}) {
    return !context.discussion && !context.discussionSummary && !context.simplifyMeta;
  }

  // 실행 중인 일반 턴 뒤에서 기다리는 다른 에이전트들(이어 발언은 단일 큐라 함께 막힌다).
  queuedAgentsBehind(agentId) {
    const ids = [];
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      if (!this.isGeneralTurn(item)) continue;
      const id = item.agent && item.agent.id;
      if (id && id !== agentId && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // 러너가 "N분째 응답 없음"을 알리면, 한도로 멈췄을 수 있음을 한 번만 안내하고
  // 뒤에 막힌 턴을 같이 보여 준다. 실행은 죽이지 않는다(긴 빌드·테스트일 수도 있다).
  noteProgressStall(runId, agent, context, event) {
    if (!event || event.kind !== "status" || !this.isFreeChatContext(context)) return;
    const match = /^(\d+)분째 응답 없음$/.exec(String(event.label || ""));
    if (!match || Number(match[1]) < PROGRESS_STALL_MINUTES) return;
    if (this.progressStallNotified.has(runId)) return;
    this.progressStallNotified.add(runId);
    const behind = this.queuedAgentsBehind(agent.id);
    const tail = behind.length > 0 ? ` 뒤에서 기다리는 턴: ${behind.map((id) => `@${id}`).join(", ")}.` : "";
    this.appendSystem(
      `@${agent.id} 응답이 ${match[1]}분째 진전이 없습니다. 사용량 한도로 멈춰 있을 수 있습니다 — 중지(■)한 뒤 다시 보내거나 다른 담당자에게 보내 주세요.${tail}`
    );
  }

  // 한도로 끝난 실행 뒤에 기다리던 턴이 있으면, 그것들이 이제 이어진다는 것을 알린다.
  noteRateLimitedRun(runId, agent, context) {
    if (!this.isFreeChatContext(context)) return;
    const key = `${runId}:limited`;
    if (this.progressStallNotified.has(key)) return;
    this.progressStallNotified.add(key);
    const behind = this.queuedAgentsBehind(agent.id);
    if (behind.length === 0) return;
    this.appendSystem(
      `@${agent.id}가 사용 한도로 멈춰 실행을 끝냈습니다. 기다리던 ${behind.map((id) => `@${id}`).join(", ")} 턴이 이어서 실행됩니다.`
    );
  }

  notifyLostTurn(item) {
    if (!this.isGeneralTurn(item)) return;
    if (this.lostTurnNotified.has(item.turnId)) return;
    this.lostTurnNotified.add(item.turnId);
    this.turnStartedAt.delete(item.turnId);
    this.appendSystem("중지로 @" + item.agent.id + " 응답 대기가 취소됐습니다. 방금 질문은 전달되지 않았을 수 있으니 필요하면 다시 보내 주세요.");
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
    this.liveRuns += 1;
    if (this.activeRuns === 1) this.emit("busy", true);
  }

  trackRunEnd() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    this.liveRuns = Math.max(0, this.liveRuns - 1);
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
    // 이 에이전트가 새 턴을 시작한다 = 직전 되질문에 대한 응답이 진행된다.
    // 대기 배지를 먼저 내려, 답을 받는 동안 옛 질문이 남아 있지 않게 한다.
    this.clearAwaitingUser(agent.id);
    return this.runResponseTurn(agent, context, generation);
  }

  async runResponseTurn(agent, context = {}, generation = this.generation) {
    // 큐에서 기다리는 사이 참가자가 비활성화되거나 CLI가 사라졌다면 실행하지 않습니다.
    const currentAgent = this.findAgent(agent.id);
    if (!currentAgent || !currentAgent.available || currentAgent.enabled === false) return;
    agent = {
      ...currentAgent,
      ...(context.agentConfig || {}),
    };
    const responseAgentMeta = {
      model: agent.model || "default",
      resolvedModel: agent.resolvedModel || (agent.model && agent.model !== "default" ? agent.model : null),
      effort: agent.effort || "default",
      version: agent.version || "",
      ...(context.discussionSummary
        ? { discussionSummary: context.discussionSummary }
        : {}),
    };

    // 토론 결론 종합과 쉽게 설명은 대화 전용이다. 나머지는 방 권한 그대로다.
    const permissionMode = context.discussionSummary || context.simplifyMeta
      ? "chat"
      : this.meta.permissionMode;

    const mentionDepth = context.mentionDepth || 0;

    let prompt;
    try {
      prompt = buildAgentPrompt({
        agent,
        agents: this.enabledAgents(),
        messages: context.discussionSummaryMessages || this.promptMessages(context.promptLimit, context.independent),
        maxMessages: this.maxPromptMessages,
        permissionMode,
        projectContext: this.meta.projectContext,
        memoryContext: this.meta.memoryContext,
        rulesContext: this.meta.rulesContext,
        workflowContext: this.meta.workflowContext,
        discussion: context.discussion || null,
        discussionSummary: context.discussionSummary || null,
        simplifyMeta: context.simplifyMeta || null,
        broadcast: context.broadcast || null,
        // 독립 발언 묶음으로 동시에 도는 턴이면, 각자 자기 폴더에서만 쓰도록
        // 계약을 준다(폴더 이름은 담당자 id — 누가 만들었는지 그대로 남는다).
        parallel: context.parallelGroupId
          ? { folder: agent.id, total: context.parallelTotal || 0 }
          : null,
        handoff: context.handoff || null,
        // 토론·결론 종합·쉽게 설명에서는 @멘션 호출을 끈다. 연쇄 깊이 상한도 여기서 막는다.
        mentionsEnabled: !context.discussion && !context.discussionSummary && !context.simplifyMeta && mentionDepth < this.mentionChainLimit,
      });
    } catch (error) {
      const stopReason = error?.code || "PROMPT_BUILD_FAILED";
      this.appendSystem(`프롬프트를 만들지 못해 응답을 시작하지 않았습니다. (${error?.message || "알 수 없는 오류"})`);
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
        this.noteProgressStall(runId, agent, context, event);
        this.emit("run-event", {
          runId,
          agentId: agent.id,
          model: responseAgentMeta.model,
          effort: responseAgentMeta.effort,
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
          // 자동 승인은 workspace-write에서만 실제 argv에 반영된다(IPC 경계가 다시 막는다).
          autoApprove: agent.autoApprove || approvedRetry,
        });
        this.cancels.add(run.cancel);
        result = await run.promise;
        // 별칭(fable)으로 실행했더라도 CLI가 보고한 실제 모델을 응답 헤더에 남깁니다.
        if (typeof result?.resolvedModel === "string" && result.resolvedModel) {
          responseAgentMeta.resolvedModel = result.resolvedModel;
        }
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
      if (result?.rateLimited) this.noteRateLimitedRun(runId, agent, context);
      if (!result?.approvalRequired || agent.autoApprove || approvedRetry) break;
      // 승인 재시도는 다음 실행에 자동 승인을 실어 보내는 것이고, 자동 승인은
      // workspace-write에서만 유효하다(chat-argv.js). 그 아래 권한에서 승인 카드를
      // 띄우면 사용자가 승인해도 같은 실행이 같은 이유로 실패한다 — 카드를 띄우지
      // 않고, 무엇을 바꿔야 하는지 사유로 알린다.
      if (permissionMode !== "workspace-write") {
        // 방 권한은 쓰기인데 이 응답만 대화 전용으로 돈 경우(결론 종합·쉽게 설명)는
        // 방 설정을 올려도 풀리지 않는다. 무엇을 바꿔야 하는지 구분해 알린다.
        const cappedByTurn = this.meta.permissionMode === "workspace-write";
        result = {
          ...result,
          ok: false,
          error: cappedByTurn
            ? "이 응답은 대화 전용이라 도구 실행 권한을 승인할 수 없습니다."
            : "이 도구 실행에는 파일 변경 권한이 필요합니다. 방 권한을 '워크스페이스 쓰기'로 올린 뒤 다시 시도해 주세요.",
        };
        break;
      }
      const approved = await this.requestApproval(agent, result.approval);
      if (generation !== this.generation) return;
      if (!approved) {
        // 사유만 바꾸고 진단 정보는 남긴다. 실패 문구가 "원본 로그를 확인해
        // 주세요"라고 안내하는데 정작 그 로그 이름과 부분 출력을 여기서
        // 버리면, 거부한 사용자만 아무 단서도 못 보게 된다.
        result = {
          ...result,
          ok: false,
          approvalRequired: false,
          error: "권한 요청을 거부했습니다.",
        };
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
      // 승인 요청으로 끝났는데 자동 승인이 켜져 있으면 이 결과가 그대로 실패로
      // 그려진다. 그때 사유만 적으면 "무슨 권한인지"를 알 수 없으므로 CLI가 준
      // 원문을 함께 남긴다(길면 잘라서).
      const approvalDetail = result?.approvalRequired ? String(result.approval?.detail || "").trim() : "";
      const failureText = result?.error
        ? (approvalDetail ? `${result.error}\n\n${approvalDetail.slice(-1000)}` : result.error)
        : "알 수 없는 오류 (원본 로그를 확인해 주세요)";
      this.appendMessage({
        authorType: "agent",
        author: agent.id,
        text: failureText,
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
    if (context.discussion) {
      const match = rawText.match(/\[\[CODEPET_DISCUSSION:(CONTINUE|AGREE|PASS|CONCLUDE)\]\]\s*$/i);
      discussionSignal = match ? match[1].toUpperCase() : "CONTINUE";
      if (match) rawText = rawText.slice(0, match.index).trim();
    }
    // 일반 채팅 턴은 응답 꼬리의 질문 계약(ASK_USER + OPTION)만 읽는다. 다른 제어
    // 줄(HANDOFF·COMPLETE)은 산문으로 남긴다(strip하지 않는다).
    let controlRequest = null;
    if (this.isFreeChatContext(context)) {
      const parsed = parseControlOutput(rawText);
      if (parsed && parsed.action === "ASK_USER") {
        controlRequest = parsed;
        // 모호한 질문(질문 2개 등)은 원문 제어 줄을 그대로 남겨, 사용자가 무엇을
        // 물었는지 잃지 않게 한다.
        if (!parsed.ambiguous) rawText = stripControlOutput(rawText);
      }
    }

    let text = stripEmoticonTags(rawText);
    if (context.discussion) {
      if (discussionSignal === "AGREE" && !text) {
        text = "동의합니다.";
      }
      if (discussionSignal === "PASS" && !text) {
        if (context.discussion.role) {
          // 구조화 토론의 단계 발언은 조용히 사라지면 안 된다. 빈 PASS를
          // 그냥 건너뛰면 다음 단계가 이 단계가 실행된 사실조차 못 보고,
          // cyclesCompleted는 실행된 것으로 세어진다. "덧붙일 것 없음"도
          // 단계의 결과이므로 기록으로 남긴다.
          text = "(이 단계에서 덧붙일 내용이 없습니다.)";
        } else {
          return { ok: true, discussionSignal };
        }
      }
    }

    // 호출한 쪽(토론 결론 종합 등)이 이 발화를 가리킬 수 있도록 id를 돌려준다.
    const appended = this.appendMessage({
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
      // 구조화 토론의 임시 역할은 참가자 identity가 아니라 그 발화의 역사적
      // metadata다. 나중에 "GPT · 비평가" 배지나 과거 토론 재현에 쓰인다.
      ...(context.discussion?.role
        ? {
            discussionTurnMeta: {
              presetId: context.discussion.presetId || null,
              cycle: context.discussion.cycle,
              step: context.discussion.step,
              roleName: context.discussion.role.name,
            },
          }
        : {}),
      ...(result.deliveries ? { deliveries: result.deliveries } : {}),
    });
    // 토론 모드는 자체 턴 오케스트레이션이 있으므로 멘션 호출을 만들지 않습니다.
    if (!context.discussion && !context.discussionSummary && !context.simplifyMeta) {
      this.scheduleMentionReplies(
        agent,
        text,
        mentionDepth,
        context.attachments || [],
        context.turnRootId
      );
      // 일반 채팅 턴이 계약(ASK_USER + OPTION)으로 물었을 때만 '답변 대기'로
      // 세운다. 산문의 물음표·목록을 읽는 휴리스틱은 쓰지 않는다 — 뜻을 못 읽어
      // 도움 제안 마무리나 방향 메뉴까지 질문으로 오인했고, 계약이 있는 지금은
      // 에이전트가 "사용자 답 없이는 못 간다"고 스스로 표시한 것만 세우는 편이
      // 맞다. 사용자는 선택지 칩이나 입력창 타이핑으로 답하고, ×로 답 없이 지운다.
      if (controlRequest?.action === "ASK_USER" && !controlRequest.ambiguous) {
        this.setAwaitingUser(agent.id, controlRequest.question || "", controlRequest.options || []);
      }
    }
    return {
      ok: true,
      discussionSignal,
      controlRequest,
      messageId: appended?.id || null,
      text,
      runId,
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
    if (this.discussionRequested || this.discussionActive) {
      return { ok: false, error: "토론이 진행 중에는 전달할 수 없습니다." };
    }
    const target = this.findAgent(targetAgentId);
    if (!target || !target.available || target.enabled === false) {
      return { ok: false, error: "전달 대상 에이전트를 사용할 수 없습니다." };
    }
    const source = this.messages.find((message) => message.id === messageId);
    if (!source || source.authorType === "system" || source.authorType === "user") {
      return { ok: false, error: "전달할 메시지를 찾을 수 없습니다." };
    }
    if (intent === "SIMPLIFY_SELF") {
      // 메시지 바로 아래 직접 버튼 [쉽게 설명]: "같은 저자 + 같은 모델" 고정 계약.
      // 원문을 작성한 에이전트만 수행할 수 있고 다른 에이전트로 대체(fallback)하지
      // 않으며, 원문 작성 당시의 model/effort를 그대로 재사용한다.
      if (target.id !== source.author) {
        return { ok: false, error: "쉽게 설명은 원문을 작성한 에이전트만 수행할 수 있습니다." };
      }
      const sourceModel =
        source.agentMeta?.resolvedModel ||
        (source.agentMeta?.model && source.agentMeta.model !== "default"
          ? source.agentMeta.model
          : null);
      if (!sourceModel) {
        return {
          ok: false,
          error: "원문 작성 당시 실제 모델을 확인할 수 없어 같은 모델로 다시 설명할 수 없습니다.",
        };
      }
      const sourceEffort = source.agentMeta?.effort && source.agentMeta.effort !== "default"
        ? source.agentMeta.effort
        : null;
      const simplifyMeta = {
        text: source.text || "",
        fromAgentId: source.author,
        messageId,
        sourceModel,
        sourceEffort,
      };
      const agentConfig = {
        model: sourceModel,
        ...(sourceEffort ? { effort: sourceEffort } : {}),
      };
      this.appendSystem(`@${target.id}에게 ${source.author}의 메시지를 알기 쉽게 풀어달라고 요청합니다.`);
      this.scheduleResponse(target, {
        simplifyMeta,
        agentConfig,
      });
      return { ok: true };
    }
    if (intent === "SIMPLIFY") {
      // Handoff 팝오버의 [다른 AI에게 전달 → 쉽게 설명]: 사용자가 선택한 대상 AI가
      // 자신의 현재/설정된 model을 사용하여 원문을 알기 쉽게 풀어 설명한다.
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
    if (this.discussionRequested || this.discussionActive) {
      return Promise.resolve({ ok: false, error: "토론이 진행 중에는 요약할 수 없습니다." });
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
  // V1.5: options.protocol이 있으면 구조화 토론이다 — Preset이 정한 임시
  // 역할·발언 순서·cycle 수를 따르고, 모델 출력은 그 순서를 바꿀 수 없다.
  async startDiscussion(options = {}) {
    const enabled = this.enabledAgents();
    const agentById = new Map(enabled.map((agent) => [agent.id, agent]));
    let pool = enabled;
    let protocol = null;
    if (options.protocol) {
      const resolved = resolveProtocol(options.protocol);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      protocol = resolved.protocol;
      const missing = protocol.participantIds.filter((id) => !agentById.has(id));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `구조화 토론에 배정된 참가자를 사용할 수 없습니다: ${missing.join(", ")}`,
        };
      }
      pool = [...new Set(protocol.participantIds)].map((id) => agentById.get(id));
    } else if (Array.isArray(options.agentIds) && options.agentIds.length > 0) {
      const wanted = new Set(options.agentIds);
      pool = pool.filter((agent) => wanted.has(agent.id));
    }
    if (pool.length < 2) {
      return { ok: false, error: "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다." };
    }
    if (this.discussionRequested || this.discussionActive) {
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

    // 호출별 turnBudget이 방 기본값보다 우선한다. 방 인스턴스는 세션 수명
    // 동안 캐시되므로 생성자 옵션만으로는 실행 중 길이 변경이 불가능하다.
    // 구조화 토론의 길이는 발언 수가 아니라 Protocol cycle 수가 결정한다.
    const budget = protocol
      ? protocol.totalTurns
      : clampDiscussionTurnBudget(options.turnBudget, this.discussionRunBudget);
    // 시작 안내를 기록하다 실패해도 토론 플래그가 남아 대화가 멈추지 않게 한다.
    try {
      if (protocol) {
        this.appendSystem(
          `구조화 토론 시작 · ${protocol.presetName} Preset · ${pool.map((agent) => `@${agent.id}`).join(", ")} · ${protocol.cycleBudget}사이클(최대 ${budget}턴)`
        );
      } else {
        this.appendSystem(
          `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`
        );
      }
    } catch (error) {
      this.endDiscussionState();
      throw error;
    }

    const generation = this.generation;
    let completed = 0;
    let successfulSteps = 0;
    const agreed = new Set();
    let concluded = false;
    let failures = 0;
    let wasStopped = false;
    let protocolFailedStep = null;
    // 자유 토론에서 사용 한도에 걸린 참가자는 남은 토론 동안 차례에서 뺀다.
    const limitedIds = new Set();
    let poolExhausted = false;
    // 주제 메시지의 첨부는 대화 기록에 [첨부: …]로 보이므로 참가자 턴에도 실어 준다.
    const topicAttachments = this.attachmentsOfMessages([startMessageId]);
    try {
      for (let turn = 1; turn <= budget; turn += 1) {
        if (generation !== this.generation) { wasStopped = true; break; }
        if (this.discussionInterrupted) { concluded = true; wasStopped = true; break; }
        const speaker = protocol ? speakerForTurn(protocol, turn) : null;
        const activePool = pool.filter((candidate) => !limitedIds.has(candidate.id));
        if (!protocol && activePool.length < 2) { poolExhausted = true; break; }
        const agent = protocol
          ? agentById.get(speaker.agentId)
          : activePool[(turn - 1) % activePool.length];
        const outcome = await this.scheduleResponse(agent, {
          ...(topicAttachments.length > 0 ? { attachments: topicAttachments } : {}),
          discussion: protocol
            ? {
                turn,
                maxTurns: budget,
                presetId: protocol.presetId,
                role: speaker.role,
                cycle: speaker.cycle,
                cycleBudget: protocol.cycleBudget,
                step: speaker.step,
                stepCount: protocol.stepCount,
                finalStep: isFinalStep(protocol, turn),
              }
            : { turn, maxTurns: budget },
        });
        completed += 1;
        if (outcome?.ok) successfulSteps += 1;
        else failures += 1;
        const signal = outcome?.discussionSignal || "CONTINUE";
        if (!protocol && outcome?.stopReason === RATE_LIMITED_STOP_REASON && !limitedIds.has(agent.id)) {
          limitedIds.add(agent.id);
          this.appendSystem(`@${agent.id}가 사용 한도에 도달해 이 토론의 남은 차례에서 제외합니다.`);
        }
        if (protocol) {
          // 구조화 토론의 각 단계는 다음 단계의 입력 계약이다. 한 단계가
          // 실패한 채 계속 가면 "비평 없는 비평 반영"처럼 계약이 조용히
          // 무너지고, cyclesCompleted는 정상 실행으로 세어진다. 자유토론은
          // 한 명이 빠져도 나머지가 말할 수 있지만 여기서는 즉시 중단한다.
          if (!outcome?.ok && !wasStopped && generation === this.generation) {
            protocolFailedStep = speaker;
            break;
          }
          // 구조화 토론의 조기 종료는 cycle 마지막 단계(종합/판정)의 CONCLUDE
          // 뿐이다. 중간 단계의 신호는 순서를 바꾸지 못한다(INV-1). 연속
          // AGREE/PASS 규칙도 쓰지 않는다 — 같은 참가자가 여러 slot을 맡으면
          // "전원이 조용한 한 바퀴"라는 의미가 성립하지 않기 때문이다.
          if (signal === "CONCLUDE" && isFinalStep(protocol, turn)) {
            concluded = true;
            break;
          }
          continue;
        }
        if (signal === "CONCLUDE") { concluded = true; break; }
        // 실패한 턴은 합의 여부를 알려 주지 않으므로 건드리지 않는다. 합의는 "참가자별
        // 최신 성공 신호가 AGREE/PASS"인 사람의 집합으로 세어, 한 명이 두 번 동의해도
        // 다른 참가자가 아직 답하지 않았다면 끝나지 않게 한다.
        if (outcome?.ok) {
          if (signal === "AGREE" || signal === "PASS") agreed.add(agent.id);
          else agreed.delete(agent.id);
        }
        // 한도로 빠진 참가자를 뺀 나머지가 둘 이상이고 그 전원이 합의했을 때만 끝낸다.
        const remainingPool = pool.filter((candidate) => !limitedIds.has(candidate.id));
        if (remainingPool.length >= 2 && remainingPool.every((candidate) => agreed.has(candidate.id))) { concluded = true; break; }
      }
    } finally {
      if (generation !== this.generation) wasStopped = true;
      const endMessageId = this.messages[this.messages.length - 1]?.id || startMessageId;
      const incomplete = Boolean(wasStopped || (!concluded && completed >= budget) || failures > 0);
      // "failed"는 구조화 토론의 즉시 중단(단계 실패로 break)과, 자유토론에서
      // 한도에 걸리지 않은 참가자가 한 명만 남아 더 이어갈 수 없을 때 쓴다.
      // 자유토론은 한 명이 실패해도
      // 나머지가 계속 말하고 예산까지 진행하므로, 도중의 일시적 실패로
      // "실패로 마쳤습니다"로 오표기하지 않는다(실제 종료 사유는 예산 도달).
      const structuredFailure = Boolean(protocolFailedStep);
      // 자유토론이라도 실행된 턴이 전부 실패했다면 '예산 도달'이 아니라 실패다.
      const allFailed = !protocol && completed > 0 && failures >= completed && !concluded;
      const reason = wasStopped
        ? "interrupted"
        : (structuredFailure || allFailed || poolExhausted)
          ? "failed"
          : (!concluded && completed >= budget)
            ? "budget"
            : "concluded";
      // 표시 문구도 같은 우선순위(interrupted > failed > budget > concluded).
      const budgetText = failures > 0
        ? `토론 실행 예산(${budget}회)에 도달해 여기서 마쳤습니다. (일부 응답 실패 포함)`
        : `토론 실행 예산(${budget}회)에 도달해 여기서 마쳤습니다.`;
      const conclusionText = wasStopped
        ? (this.discussionInterrupted ? "사용자 개입으로 토론을 여기서 마쳤습니다." : "사용자가 중지해 토론을 여기서 마쳤습니다.")
        : structuredFailure
          ? `${protocolFailedStep.role.name} 단계 응답 실패로 구조화 토론을 중단했습니다.`
          : allFailed
            ? "모든 에이전트 응답이 실패해 토론을 마쳤습니다."
            : poolExhausted
              ? "사용 한도에 걸리지 않은 참가자가 한 명뿐이라 토론을 여기서 마쳤습니다."
            : (!concluded && completed >= budget)
              ? budgetText
            : "참가자들이 합의하거나 결론에 도달해 토론을 마쳤습니다.";

      const conclusionMessage = {
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
          // 구조화 토론에만 존재하는 additive 필드 — 예전 판은 무시한다.
          ...(protocol
            ? {
                protocol: {
                  presetId: protocol.presetId,
                  presetName: protocol.presetName,
                  cycleBudget: protocol.cycleBudget,
                  stepCount: protocol.stepCount,
                  // 실행 시도가 아니라 성공한 step 기준이다. completed로
                  // 세면 마지막 step(종합)이 실패한 cycle도 완료로 기록된다.
                  cyclesCompleted: Math.floor(successfulSteps / protocol.stepCount),
                  // slot 순서 그대로의 역할 배정. 과거 토론을 다시 열 때
                  // "이 답변은 당시 무슨 역할이었나"를 재현할 근거다.
                  roleAssignments: [...protocol.participantIds],
                  ...(protocolFailedStep
                    ? {
                        failedStep: {
                          cycle: protocolFailedStep.cycle,
                          step: protocolFailedStep.step,
                          roleName: protocolFailedStep.role.name,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
      // 결론 기록이 예외를 던져도 플래그·대기 턴 복구는 반드시 거친다.
      try {
        this.appendMessage(conclusionMessage);
      } finally {
        this.endDiscussionState();
      }
    }
    return { ok: true, completed, truncated: !concluded && completed >= budget, concluded };
  }

  // 토론 상태를 풀고, 토론 동안 미뤄 둔 일반 턴을 큐로 돌려보낸다.
  endDiscussionState() {
    this.discussionActive = false;
    this.discussionRequested = false;
    this.discussionInterrupted = false;
    this.turnQueue.push(...this.deferredTurnQueue.splice(0));
    this.emitTurnState();
    this.pumpTurnQueue();
  }

  stopAll() {
    // 승인 카드를 기다리는 턴은 실행도 입력 중 표시도 없어 따로 센다.
    const hadWork = this.cancels.size > 0 || this.typingCounts.size > 0
      || this.runningTurns.size > 0 || this.pendingApprovals.size > 0
      || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0;
    this.stopAllSilently();
    if (hadWork) this.appendSystem("응답을 중지했습니다.");
  }

  clear() {
    this.stopAllSilently();
    this.messages = [];
    this.awaitingUsers.clear();
    this.emit("reset");
  }

  stopAllSilently() {
    this.generation += 1;
    // 실행 중인 프로세스부터 끊는다. 아래 emit 리스너가 예외를 던져도 중지는 이미 걸려 있다.
    for (const cancel of this.cancels) {
      try {
        cancel();
      } catch {}
    }
    this.cancels.clear();
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      this.retireTurn(item, undefined, { lost: true });
    }
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns.clear();
    this.turnStartedAt.clear();
    // 실행 중이던 턴도 방금 취소했다. 여기서 비우지 않으면 바로 아래
    // emitTurnState가 이미 중지된 턴을 "실행 중"으로 계속 알린다.
    this.runningTurns.clear();
    this.syncCurrentTurn();
    this.mentionsMuted = false;
    this.emitTurnState();
    // Stop/interject/reset로 turn을 중지하면 화면에 보이는 모든 승인 카드는 stale하다.
    // resolver를 부르기 전에 provider-neutral approval-resolved를 내보내 renderer가 카드를
    // dismiss하게 한다(same-turn action 승인 · legacy whole-turn 승인 공통). 이후 adapter가
    // 뒤늦게 AbortController를 abort해도 이미 settled라 중복 이벤트는 나오지 않는다.
    for (const [approvalId, entry] of this.pendingApprovals) {
      this.emit("approval-resolved", { approvalId });
      entry.resolve(false);
    }
    const hadApprovals = this.pendingApprovals.size > 0;
    this.pendingApprovals.clear();
    for (const agentId of [...this.typingCounts.keys()]) {
      this.typingCounts.delete(agentId);
      this.emit("typing", { agentId, busy: false });
    }
    if (this.activeRuns > 0) {
      this.activeRuns = 0;
      this.emit("busy", false);
    }
    this.resolveIdleWaiters();
    if (hadApprovals) this.emit("approval-wait");
  }
}

module.exports = {
  ChatRoom,
  DEFAULT_DISCUSSION_RUN_BUDGET,
  DISCUSSION_TURN_BUDGET_MIN,
  DISCUSSION_TURN_BUDGET_MAX,
  clampDiscussionTurnBudget,
};
