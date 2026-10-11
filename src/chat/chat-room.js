const { EventEmitter } = require("node:events");
const path = require("node:path");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions, hasGroupMention } = require("./chat-mention");
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
// 오케스트레이터 안전선(계획 v4 §2-8, 설계 §(5)): 라운드 50 또는 실행 150회.
// 보통 대화의 "AI끼리 계속 부르기" 합계 상한(설계 §(10))도 같이 둔다. 시험이 주입할 수 있게 생성자 옵션으로도 받는다.
const ORCHESTRATION_ROUND_CEILING = 50;
const ORCHESTRATION_EXECUTION_CEILING = 150;
const KEEP_CALLING_CEILING = 50;
const LOST_TURN_STALL_SECONDS = 120;
// 실행 중인 일반 턴이 이 시간 넘게 진전(delta·도구·파일)이 없으면 한 번 안내한다.
// 큐 정체 경고는 "시작 못 한 턴"만 보고, 러너 무음 감지는 실행을 죽이지 않으므로,
// 한도로 조용히 멈춘 실행에는 이 안내가 유일한 탈출 신호다.
const PROGRESS_STALL_MINUTES = 10;

// 실행 중 질문(ask_user) 기록. 끝난(되돌릴 수 없는) 상태와, 방이 기억하는 기록 수 상한.
const QUESTION_TERMINAL = new Set(["answered", "cancelled", "interrupted"]);
const MAX_USER_QUESTIONS = 200;
// 일하는 도중 묻는 질문 도구를 붙일 수 있는 방 권한(파일 작업). 대화 전용(chat)에는 붙이지 않는다.
const FILE_WORK_PERMISSIONS = new Set(["workspace-read", "workspace-write"]);
// 중계소가 쓰는 상태 이름 → 화면·기록이 쓰는 상태 이름.
const QUESTION_STATUS = Object.freeze({
  pending: "pending",
  submitted: "submitting",
  delivered: "answered",
  cancelled: "cancelled",
  expired: "cancelled",
});

// 질문이 처리됐을 때 대화에 남기는 한 줄(시스템 줄이라 AI 프롬프트에는 들어가지 않는다).
// 답은 길어질 수 있어 한 줄에 맞게 줄인다. 대기 중이 아니던 질문(이미 보낸 답의 전달 확인 등)은 다시 쓰지 않는다.
const QUESTION_LINE_ANSWER_CHARS = 160;
function questionOutcomeLine(previous, record) {
  if (!previous || previous.status !== "pending" || record.status === "pending") return null;
  const who = `@${record.agentId}의 질문 ${record.questions.length}개`;
  if (record.status === "submitting" || record.status === "answered") {
    // 여러 줄로 쓴 답도 대화에는 한 줄로 남긴다(줄바꿈·연속 공백은 한 칸으로, 전체 답은 질문 기록에 그대로 있다).
    const clip = (text, max) => {
      const flat = String(text).replace(/\s+/g, " ").trim();
      return flat.length > max ? `${flat.slice(0, max)}…` : flat;
    };
    const parts = (record.answers || []).map((answer) => {
      const picked = [...(answer.selected || []), ...(answer.other ? [`기타 "${clip(answer.other, 60)}"`] : [])];
      return answer.text !== undefined ? `"${clip(answer.text, 60)}"` : picked.join(", ");
    });
    const body = parts.length > 1 ? parts.map((part, index) => `${index + 1}) ${part}`).join(" · ") : parts[0] || "";
    return `${who} → 답: ${clip(body, QUESTION_LINE_ANSWER_CHARS)}`;
  }
  switch (record.reason) {
    case "user-skip": return `${who}를 건너뛰었습니다. 답 없이 이어 가도록 알렸습니다.`;
    case "timeout": return `${who}에 오래 답이 없어 닫았습니다.`;
    case "stopped": return `${who}: 중지로 닫혔습니다.`; // 중지·삭제·잠깐. 무엇을 물었는지 남긴다.
    case "server-error":
    case "connection-lost": return `${who}: 연결이 끊겨 닫혔습니다. 작업은 질문 없이 이어질 수 있습니다.`;
    case "app-quit":
    case "app-restart": return `${who}는 앱이 꺼져 답을 받지 못했습니다. 필요하면 다시 말을 걸어 주세요.`;
    default: return `${who}는 답을 받기 전에 작업이 끝나 닫혔습니다.`;
  }
}

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
    // 오케스트레이터 모드·"AI끼리 계속 부르기"는 permissionMode와 같은 자리(세션 메타)에 산다. 기본값은 꺼짐.
    if (!this.meta.orchestrator) this.meta.orchestrator = { enabled: false, leadId: null };
    if (typeof this.meta.keepCalling !== "boolean") this.meta.keepCalling = false;
    this.discussionRunBudget = Number.isInteger(options.discussionRunBudget)
      ? options.discussionRunBudget
      : DEFAULT_DISCUSSION_RUN_BUDGET;
    this.mentionChainLimit = Number.isInteger(options.mentionChainLimit)
      ? options.mentionChainLimit
      : DEFAULT_MENTION_CHAIN_LIMIT;
    this.roundCeiling = Number.isInteger(options.roundCeiling) ? options.roundCeiling : ORCHESTRATION_ROUND_CEILING;
    this.executionCeiling = Number.isInteger(options.executionCeiling) ? options.executionCeiling : ORCHESTRATION_EXECUTION_CEILING;
    this.keepCallingCeiling = Number.isInteger(options.keepCallingCeiling) ? options.keepCallingCeiling : KEEP_CALLING_CEILING;
    // 방에 한 번에 하나뿐인 오케스트레이션(휘발 상태, 재시작하면 사라진다). null이거나 하나.
    this.orchestration = null;
    this.orchestrationSeq = 0;
    // turnRootId(연쇄를 처음 일으킨 사용자 메시지) → 지금까지 만든 자동 호출 수. keepCalling 합계 상한에 쓴다.
    this.mentionCallCounts = new Map();
    this.keepCallingCeilingNoticed = new Set();
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
    // 시작해서 아직 끝나지 않은 단위(한 번에 같이 시작하는 묶음). 일반 줄은 이게 비어야 시작하고, 유휴 판정도 이걸 본다.
    this.activeUnits = new Set();
    // 펌프 패스의 재진입 방지. 패스 도중 다시 불리면 pumpAgain만 켜고 패스가 끝나기 직전에 한 번 더 돈다.
    this.pumping = false;
    this.pumpAgain = false;
    // 지금 실행 중인 턴들. 일반·빠른 턴과 독립 발언 묶음이 섞여 여러 개가 동시에 들어간다.
    // 중지는 비우지 않는다: 취소한 프로세스가 실제로 끝나야 빠진다(같은 담당자의 프로세스가 겹치지 않게).
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
    // 실행 중 질문(ask_user). questionTool = { broker, canAttach(agent, purpose), attach({...}) }.
    // 없으면 질문 도구 없이 예전처럼 돈다.
    this.questionTool = options.questionTool || null;
    // runId → { handle, agentId, turnId, run } : 질문 도구가 붙은 실행.
    this.questionRuns = new Map();
    this.questionShellNoticed = new Set();
    // 질문 카드가 기다리는 동안 보낸 메시지에 안내를 이미 낸 "질문 id:받는 에이전트 id" 짝.
    this.questionHinted = new Set();
    // questionId → 질문 기록. 다시 켠 뒤에는 답을 기다리던 질문이 '중단됨'으로 돌아온다(답할 수 없다).
    this.userQuestions = new Map();
    this.interruptedOnLoad = [];
    for (const question of options.initialQuestions || []) {
      if (!question?.questionId) continue;
      const open = question.status === "pending" || question.status === "submitting";
      const restored = open ? { ...question, status: "interrupted", reason: "app-restart" } : { ...question };
      this.userQuestions.set(restored.questionId, restored);
      if (open) this.interruptedOnLoad.push({ ...restored });
    }
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
    // meta는 chat:permission:set 같은 요청·응답으로 바뀔 때는 호출자가 받는 값으로 화면이 갱신되지만,
    // refreshRoomAgents의 지휘 AI 자동 꺼짐처럼 요청자 없이 바뀔 때는 이 emit이 유일한 통지 경로다.
    this.emit("meta");
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
      // 보기를 여러 개 고를 수 있는 질문인가(MULTI: yes).
      awaitingMulti: Boolean(this.awaitingUsers.get(agent.id)?.multi),
    }));
  }

  // 되질문으로 끝난 에이전트를 '답변 대기'로 세운다. 질문·보기가 그대로면
  // 재방출하지 않아 렌더러가 불필요하게 다시 그리지 않는다.
  setAwaitingUser(agentId, question, options = [], multi = false) {
    const trimmed = (question || "").trim() || null;
    const opts = Array.isArray(options) ? options : [];
    // 고를 보기가 없으면 '여러 개 고르기'는 뜻이 없다.
    const isMulti = Boolean(multi) && opts.length > 0;
    const prev = this.awaitingUsers.get(agentId);
    if (
      prev &&
      prev.question === trimmed &&
      Boolean(prev.multi) === isMulti &&
      JSON.stringify(prev.options || []) === JSON.stringify(opts)
    ) {
      return;
    }
    this.awaitingUsers.set(agentId, { question: trimmed, options: opts, multi: isMulti });
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
      orchestration: this.orchestrationSnapshot(),
    };
  }

  // 화면이 구독하는 오케스트레이션 스냅숏(라운드·실행 횟수만 — 설계 §(5)). 일시 정지 표시는
  // 렌더러가 기존 pendingApprovals/userQuestions 스냅숏에서 따로 계산한다(§(9)).
  orchestrationSnapshot() {
    if (!this.orchestration) return null;
    // agentIds: 지휘 AI + 지금 이 오케스트레이션으로 돌고 있는 작업자(§(9) "지휘 AI 또는 작업자 턴이
    // pendingApprovals에 걸려 있으면"의 scope). 화면 상시 표시(라운드·실행 횟수만, §(5))에는 안 쓰고
    // 일시 정지 판정을 무관한 곁가지 대화와 가르는 데만 쓴다.
    const workerIds = this.liveTurns()
      .filter((item) => item.context.orchestration?.id === this.orchestration.id
        && item.context.orchestration.role === "worker")
      .map((item) => item.agent.id);
    return {
      active: true,
      round: this.orchestration.round,
      executions: this.orchestration.executions,
      leadId: this.orchestration.leadId,
      agentIds: [...new Set([this.orchestration.leadId, ...workerIds])],
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
    // ONE @ 규칙(설계 §(3)): 이름으로 부른 메시지는 모드와 무관하게 그 AI에게 간다. 모드가 가르는
    // 것은 @ 없는 메시지의 수신자뿐이다. 그룹 별칭(@all 등)은 지휘 AI를 거치지 않고 늘 그대로 모두에게 간다.
    const groupMentioned = hasGroupMention(trimmed, GROUP_ALIASES);
    const specificIds = parseMentions(trimmed, this.agents);
    const orchestrator = this.meta.orchestrator || {};
    const leadId = orchestrator.enabled ? orchestrator.leadId : null;
    const routeToLead = Boolean(leadId) && !groupMentioned
      && (specificIds.length === 0 || (specificIds.length === 1 && specificIds[0] === leadId));
    if (routeToLead && this.orchestration) {
      // 보류: 턴을 만들지 않는다. 메시지는 대화에 그대로 남고 heldMessages에 쌓인다(설계 §(3)·§(8)).
      this.orchestration.heldMessages.push(trimmed);
      const leadWaiting = this.awaitingUsers.has(leadId)
        || this.pendingUserQuestionList().some((question) => question.agentId === leadId);
      this.appendSystem(leadWaiting
        ? `@${leadId}가 질문 카드에 답을 기다리는 중입니다. 이 메시지는 그 카드에 답하거나 건너뛴 뒤, 다음 회신에 함께 전달됩니다.`
        : "결과가 모이면 이 메시지까지 보고 이어 갑니다. 지금 바로 바꾸려면 [잠깐]을 누르세요.");
      return entry;
    }
    const mentionedIds = parseMentions(trimmed, this.agents, GROUP_ALIASES);
    const targets = routeToLead
      ? [this.findAgent(leadId)].filter(Boolean)
      : mentionedIds.length > 0
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
      const fastEligible = this.isFastEligible(trimmed, order, independent);
      // 걷어낼 대기 턴을 먼저 모두 모은다(걷어내기 전에). 줄과 자리는 메시지 단위로 정한다.
      const victimsOf = order.map((agent) => this.collectSupersedable(agent.id));
      const victims = victimsOf.flat();
      // 하나라도 일반 줄 항목이면 메시지 전체가 일반 줄이다(그 항목의 자리를 지키기 위해서).
      const lane = fastEligible && victims.every((item) => item.lane === "fast") ? "fast" : "main";
      // 새 턴들은 결정된 줄에서 걷어낸 가장 앞선 항목의 자리에 붙여서 들어간다(빠른 자격이 없으면 지금처럼 맨 뒤).
      let insertAt = null;
      if (fastEligible) {
        const anchor = this.turnQueue.find((item) => victims.includes(item) && (item.lane === "fast") === (lane === "fast"));
        if (anchor) {
          const anchorIndex = this.turnQueue.indexOf(anchor);
          insertAt = anchorIndex - this.turnQueue.slice(0, anchorIndex).filter((item) => victims.includes(item)).length;
        }
      }
      const newItems = [];
      // 전원을 큐에 올린 뒤에 한 번만 펌프를 돌린다(묶음이 쪼개지지 않게).
      this.pumpSuspended += 1;
      try {
        // 아직 시작하지 않은 이 담당자의 턴은 방금 온 메시지를 보지 못하므로 걷어내고 새로 잡는다.
        // 새 턴은 걷어낸 턴이 답하려던 메시지의 첨부를 함께 받고, 걷어낸 턴의 중복 방지 키도 물려받는다.
        for (const item of victims) this.removeQueued(item);
        order.forEach((agent, index) => {
          const mine = victimsOf[index];
          for (const item of mine) this.retireTurn(item, undefined, { keepKeys: true });
          const roots = [...new Set(mine.map((item) => item.context.turnRootId))];
          const newItem = this.scheduleTurn(agent, {
            attachments: roots.length > 0
              ? this.attachmentsOfMessages([...roots, entry.id])
              : attachments,
            turnRootId: entry.id,
            independent,
            ...(parallelGroupId ? { parallelGroupId, parallelTotal: order.length } : {}),
            ...(order.length > 1 && !independent
              ? { broadcast: { position: index + 1, total: order.length } }
              : {}),
            ...(routeToLead ? { orchestrationStart: { leadId } } : {}),
          }, {
            lane,
            insertAt: insertAt === null ? null : insertAt + index,
            inheritKeys: mine.flatMap((item) => item.dedupeKeys),
          });
          newItems.push(newItem);
        });
      } finally {
        this.pumpSuspended -= 1;
        this.pumpTurnQueue();
      }
      this.announceQuestionWait(newItems);
    }
    return entry;
  }

  // 질문 카드를 기다리는 동안 보낸 메시지는 카드의 답이 아니라 새 차례로 줄을 선다. 그 턴이 실제로 카드를 쥔 실행 뒤에서
  // 기다릴 때만 알린다(바로 시작한 턴은 알리지 않는다). 질문마다, 받는 에이전트마다 한 번이고,
  // 여러 에이전트에게 한꺼번에 보낸 메시지에서 같은 줄이 겹치면 한 번만 낸다.
  // 빠른 턴은 자기 담당자가 카드를 쥔 때만 기다리므로 그 카드(own)만 알리고, 다른 담당자의 카드는 알리지 않는다.
  announceQuestionWait(items) {
    const told = new Set();
    for (const item of items) {
      if (!this.turnQueue.includes(item) && !this.deferredTurnQueue.includes(item)) continue;
      const agent = item.agent;
      const fresh = this.pendingUserQuestionList().filter((question) => !this.questionHinted.has(`${question.questionId}:${agent.id}`));
      const own = fresh.find((question) => question.agentId === agent.id);
      const others = item.lane === "fast" ? [] : fresh.filter((question) => question.agentId !== agent.id);
      for (const question of own ? [own, ...others] : others) this.questionHinted.add(`${question.questionId}:${agent.id}`);
      if (own) this.appendSystem(`@${agent.id}가 질문 카드에 답을 기다리는 중입니다. 이 메시지는 카드에 답하거나 건너뛴 뒤 전달됩니다.`);
      if (others.length > 0) {
        const names = [...new Set(others.map((question) => `@${question.agentId}`))].join(", ");
        const line = `지금 ${names}가 질문 카드의 답을 기다리는 중이라, 이 메시지는 카드에 답하거나 건너뛴 뒤 전달됩니다.`;
        if (!told.has(line)) this.appendSystem(line);
        told.add(line);
      }
    }
  }

  // 바로 답하기(빠른 줄) 자격: 이 사용자 메시지의 턴을 빠른 줄에 세워도 되는가. 설계 §2.2의 조건 2~6이다
  // (1은 사용자 메시지만 이 함수를 부른다는 뜻이다).
  isFastEligible(text, order, independent) {
    // 2·3. 이름으로 부른 에이전트가 있고 그룹 별칭이 없다.
    if (parseMentions(text, this.agents).length === 0 || hasGroupMention(text, GROUP_ALIASES)) return false;
    // 4. 답할 사람이 정확히 한 명이거나 독립 발언이다(이어 발언 둘 이상은 뒷사람이 앞 답을 읽어야 한다).
    if (order.length !== 1 && !independent) return false;
    // 5. 토론 중·토론 시작을 기다리는 중이 아니다.
    if (this.discussionActive || this.discussionRequested) return false;
    // 6. 끼어 있는 일반 턴이 없다: 결론 종합·기록관 턴이 대기·실행 중이거나, 답할 담당자에게 갈아끼울 수 없는 대기 턴이 있으면
    //    이 메시지가 그 앞을 질러 시작하면 안 된다.
    const queued = [...this.turnQueue, ...this.deferredTurnQueue];
    if ([...queued, ...this.liveTurns()].some((item) => item.context.discussionSummary)) return false;
    const agentIds = new Set(order.map((agent) => agent.id));
    // 오케스트레이션 턴은 막는 걸로도 안 친다(걷어낼 수도 없다, 위와 같은 교차점) — 직접 @other는
    // 그 담당자가 작업자로 바쁘더라도 빠른 줄에 서고, 담당자 게이트가 뒤로 미룬다.
    return !queued.some((item) => agentIds.has(item.agent.id) && !item.context.orchestration
      && !(item.context.turnRootId && this.isFreeChatContext(item.context)));
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

  // ---- 실행 중 질문(ask_user) ----
  // 질문 하나 = 도구 호출 하나(질문 1~4개 묶음). 실행 프로세스는 답이 올 때까지 같은 자리에서 기다린다.

  userQuestionList() {
    return [...this.userQuestions.values()].map((question) => ({ ...question }));
  }

  // 지금 사용자의 답을 기다리는 질문. 화면이 (다시) 붙을 때 상태 스냅숏에 실려 나간다.
  pendingUserQuestionList() {
    return this.userQuestionList().filter((question) => question.status === "pending");
  }

  hasPendingQuestion() {
    return this.pendingUserQuestionList().length > 0;
  }

  // 중계소가 알려 준 질문 묶음(set)을 기록에 반영한다. 끝난 질문은 되살리지 않는다.
  noteQuestionSet(set) {
    if (!set?.setId || set.sessionId !== this.sessionId) return;
    const status = QUESTION_STATUS[set.status];
    if (!status) return;
    const previous = this.userQuestions.get(set.setId);
    if (previous && QUESTION_TERMINAL.has(previous.status)) return;
    this.setQuestion({
      questionId: set.setId,
      sessionId: this.sessionId,
      agentId: set.agentId,
      runId: set.runId,
      turnId: set.turnId ?? null,
      questions: set.questions,
      status,
      createdAt: set.createdAt,
      ...(set.answers ? { answers: set.answers } : {}),
      ...(status === "submitting" || status === "answered" ? { answeredAt: previous?.answeredAt || Date.now() } : {}),
      ...(set.reason ? { reason: set.reason } : {}),
    });
  }

  setQuestionStatus(question, status, extra = {}) {
    this.setQuestion({
      ...question,
      status,
      ...extra,
      ...(status === "answered" && !question.answeredAt ? { answeredAt: Date.now() } : {}),
    });
  }

  setQuestion(record) {
    const previous = this.userQuestions.get(record.questionId);
    this.userQuestions.set(record.questionId, record);
    if (this.userQuestions.size > MAX_USER_QUESTIONS) {
      for (const [id, question] of this.userQuestions) {
        if (this.userQuestions.size <= MAX_USER_QUESTIONS) break;
        if (QUESTION_TERMINAL.has(question.status)) this.userQuestions.delete(id);
      }
    }
    // 시간 제한을 먼저 맞춘다. 알림을 받는 쪽이 예외를 던져도 실행이 멈춘 채 남지 않게.
    this.syncQuestionWaiting(record.runId);
    // 대화에 남기는 한 줄은 질문 알림을 막지 않는다(기록이 실패해도 답·건너뛰기는 그대로 간다).
    try {
      const line = questionOutcomeLine(previous, record);
      if (line) this.appendSystem(line);
    } catch (error) {
      console.warn("[agora] 질문 처리 기록 실패:", error?.message || error);
    }
    this.emit("user-question", { ...record });
  }

  // 답을 기다리는 질문이 있는 동안 그 실행의 시간 제한·무음 경고를 멈춘다.
  syncQuestionWaiting(runId) {
    const entry = this.questionRuns.get(runId);
    const run = entry?.run;
    if (typeof run?.setWaitingUser !== "function") return;
    const waiting = [...this.userQuestions.values()].some((question) => question.runId === runId && question.status === "pending");
    if (Boolean(entry.waiting) === waiting) return;
    entry.waiting = waiting;
    try {
      run.setWaitingUser(waiting);
    } catch (error) {
      console.warn("[agora] 질문 대기 시간 제한 조정 실패:", error?.message || error);
    }
  }

  // 사용자가 보낸 답(또는 건너뛰기)을 받을 수 있는 질문인지 확인한다. 아니면 이유를 돌려준다.
  findAnswerableQuestion(questionId, runId) {
    const question = this.userQuestions.get(String(questionId || ""));
    if (!question) return { ok: false, error: "이 대화에 없는 질문입니다." };
    if (runId !== undefined && runId !== question.runId) return { ok: false, error: "이 질문은 다른 작업에 속합니다." };
    if (question.status !== "pending") return { ok: false, error: "이 질문은 이미 처리되었습니다." };
    if (!this.questionTool?.broker || !this.questionRuns.has(question.runId)) {
      return { ok: false, error: "이 질문을 던진 작업은 이미 끝났습니다." };
    }
    return { ok: true, question };
  }

  // 답은 같은 실행으로 돌아간다. 검증(질문 수·선택지·글자 수)은 중계소가 한 번 더 한다.
  answerUserQuestion({ questionId, runId, answers } = {}) {
    const found = this.findAnswerableQuestion(questionId, runId);
    if (!found.ok) return found;
    const result = this.questionTool.broker.answer({ runId: found.question.runId, setId: found.question.questionId, answers });
    return result.ok ? { ok: true } : { ok: false, error: result.error, code: result.code };
  }

  // 사용자가 답하지 않기로 한다. 모델에는 "답 없이 이어 가라"는 결과가 돌아간다.
  cancelUserQuestion({ questionId, runId } = {}) {
    const found = this.findAnswerableQuestion(questionId, runId);
    if (!found.ok) return found;
    const result = this.questionTool.broker.cancel({ runId: found.question.runId, setId: found.question.questionId, reason: "user-skip" });
    return result.ok ? { ok: true } : { ok: false, error: result.error, code: result.code };
  }

  // 사용자가 답하지 않기로 한 질문을 모델이 계속 던지면 실행을 멈춘다(중계소가 알려 준다).
  noteQuestionRepeatLimit(info) {
    const entry = this.questionRuns.get(info?.runId);
    if (!entry) return;
    try {
      entry.run?.cancel();
    } catch {}
    this.appendSystem(
      `@${entry.agentId}가 ${info.reason === "budget" ? "질문 횟수 한도를 넘겨" : "답하지 않기로 한 질문을 계속 던져"} 이번 실행을 멈췄습니다. 필요하면 다시 말을 걸어 주세요.`
    );
  }

  // 질문 도구를 붙인다. 붙이지 못하면 이유를 안내하고 null(끝에서 묻는 방식으로 진행).
  async beginQuestionRun(agent, runId, turnId, purpose) {
    let handle;
    try {
      handle = await this.questionTool.attach({ agent, runId, turnId, purpose });
    } catch (error) {
      handle = { attached: false, reason: "작업 중 질문 기능을 준비하지 못했습니다.", detail: error?.message || String(error) };
    }
    if (!handle?.attached) {
      // 원인 글은 로그에만 남기고, 대화에는 쉬운 말로 알린다.
      console.warn("[agora] 작업 중 질문 기능을 붙이지 못했습니다:", handle?.reason, handle?.detail || "");
      this.appendSystem(`@${agent.id}: 작업 중 질문 기능을 켜지 못했습니다. 이번에는 답변 끝에서 선택지로 묻습니다.`);
      return null;
    }
    this.questionRuns.set(runId, { handle, agentId: agent.id, turnId: turnId ?? null, run: null });
    return handle;
  }

  // 실행이 끝났다(성공·실패·중지·삭제·종료). 기다리던 질문을 정리하고 중계소의 실행 등록을 푼다.
  // pending: 답을 기다리던 질문이 되는 상태, submitting: 답은 보냈지만 도구 결과 전달 확인이 없던 질문이 되는 상태.
  closeQuestionRun(runId, { reason = "run-ended", pending = "cancelled", submitting = "interrupted" } = {}) {
    const entry = this.questionRuns.get(runId);
    this.questionRuns.delete(runId);
    const open = [...this.userQuestions.values()].filter(
      (question) => question.runId === runId && (question.status === "pending" || question.status === "submitting")
    );
    try {
      for (const question of open) {
        this.setQuestionStatus(question, question.status === "pending" ? pending : submitting, { reason });
      }
    } finally {
      try {
        entry?.handle?.cleanup?.(reason);
      } catch (error) {
        console.warn("[agora] 질문 연결 정리 실패:", error?.message || error);
      }
    }
  }

  // 다시 켠 뒤, 답을 기다리다 중단된 질문을 대화에 한 줄로 알린다(저장된 질문 상태가 '중단됨'이 되므로 한 번만 나온다).
  announceInterruptedQuestions() {
    for (const question of this.interruptedOnLoad) {
      const line = questionOutcomeLine({ status: "pending" }, question);
      if (line) this.appendSystem(line);
    }
  }

  // 앱 종료: 답을 기다리던 질문을 '중단됨'으로 남긴다(다시 켜도 같은 상태).
  interruptQuestions() {
    for (const runId of [...this.questionRuns.keys()]) {
      this.closeQuestionRun(runId, { reason: "app-quit", pending: "interrupted" });
    }
  }

  // 방 전체 턴 큐. 일반 응답과 멘션 호출은 대기 중인 같은 에이전트의
  // 턴을 공유해, 한 릴레이에서 같은 발언권이 중복 예약되지 않게 합니다.
  scheduleResponse(agent, context = {}) {
    return this.scheduleTurn(agent, context).promise;
  }

  // scheduleResponse의 본체. 큐에 선 항목(이미 같은 키의 대기·실행 턴이 있으면 그 항목)을 돌려준다.
  // placement: { lane: "fast"|"main", insertAt: 큐 위치(없으면 맨 뒤), inheritKeys: 갈아끼운 항목에게 물려받는 중복 방지 키 }.
  scheduleTurn(agent, context = {}, placement = {}) {
    const generation = this.generation;
    // 담당 에이전트까지 키에 넣는다. 빼면 같은 토론·메시지를 다른 AI에게 한 두 번째
    // 요청이 첫 턴의 promise를 받고 조용히 사라진다.
    // 오케스트레이션 턴(지휘 AI·작업자)은 별도 키 공간을 쓴다(설계 §(4)) — 지휘 AI 답의 메시지 id를
    // turnRootId로 재사용했으므로 보통 자유 대화 키와 같은 모양이면 그 뒤에 같은 메시지로 또 온
    // @멘션 호출과 섞일 수 있고, collectSupersedable/isFastEligible도 이 키로 오케스트레이션 턴을 가려낸다.
    const dedupeKey = context.orchestration
      ? `orch:${context.orchestration.id}:${context.orchestration.round}:${agent.id}`
      : context.discussionSummary
        ? `summary:${context.discussionSummary.discussionId}:${context.discussionSummary.record ? "record" : "summary"}:${agent.id}`
        : context.simplifyMeta
          ? `simplify:${context.simplifyMeta.messageId}:${agent.id}`
          : (context.discussion || !context.turnRootId ? null : `${context.turnRootId}:${agent.id}`);
    if (dedupeKey) {
      if (this.pendingTurns.has(dedupeKey)) {
        return this.pendingTurns.get(dedupeKey);
      }
      // 실행 중인 턴 전체를 본다. 병렬 묶음에서는 currentTurn 하나만 보면
      // 같은 사용자 메시지가 같은 대상에게 두 번 배정될 수 있다.
      //
      // 다만 실행 중인 턴은 이미 프롬프트를 만들어 들어갔으므로, 방금 도착한
      // @멘션을 대신 볼 수 없다. 그 promise를 돌려주면 호출이 조용히 사라진다
      // — 동시 실행에서만 열리는 창이고(순차 실행에서는 멘션 대상이 실행 중일
      // 수 없다), 사용자에겐 "불렀는데 아무도 대답하지 않는" 것으로 보인다.
      // 그래서 최초 배정(mentionDepth 0)만 접고, 멘션 호출은 새 턴으로 잡는다.
      // 중지로 취소 중인 턴(세대가 지난 것)은 새 요청을 대신 받지 않는다.
      if (!context.mentionDepth) {
        for (const running of this.liveTurns()) {
          if (running.dedupeKey === dedupeKey) return running;
        }
      }
    }

    let resolveTurn;
    const promise = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    this.turnSeq += 1;
    // 갈아끼운 항목의 키를 물려받는다: 옛 뿌리로 오는 @멘션 호출이 이 대기 턴에 접힌다(그 턴이 이미 그 멘션을 본다).
    const dedupeKeys = [...new Set([dedupeKey, ...(placement.inheritKeys || [])].filter(Boolean))];
    // 토론이 진행 중이면 일반 턴은 끼어들지 못하게 뒤로 미룬다.
    const deferGeneral = this.discussionActive && !context.discussion;
    const item = {
      turnId: `t${this.turnSeq}`,
      agent,
      context,
      generation,
      dedupeKey,
      dedupeKeys,
      // 빠른 줄은 토론·토론 요청 중에는 만들 수 없다(그 사이에 상태가 바뀌었으면 일반 줄이다).
      lane: placement.lane === "fast" && !deferGeneral && !context.discussion && !this.discussionRequested ? "fast" : "main",
      promise,
      resolve: resolveTurn,
      promptLimit: this.messages.length,
    };
    for (const key of dedupeKeys) this.pendingTurns.set(key, item);
    this.trackTurnWait(item);
    const queue = deferGeneral
      ? this.deferredTurnQueue
      : this.turnQueue;
    if (Number.isInteger(placement.insertAt) && placement.insertAt >= 0 && placement.insertAt <= queue.length) {
      queue.splice(placement.insertAt, 0, item);
    } else {
      queue.push(item);
    }
    this.emitTurnStateSafe();
    // 한 발화가 여러 명에게 팬아웃되는 동안에는 펌프를 미룬다. 첫 턴을 넣자마자
    // 돌리면 나머지가 큐에 들어오기 전에 실행이 시작돼, 같이 돌아야 할 독립
    // 발언 묶음이 한 명씩으로 쪼개진다.
    if (this.pumpSuspended === 0) this.pumpTurnQueue();
    return item;
  }

  // 시작해서 아직 끝나지 않았고 현재 세대인 턴. 중지로 취소했지만 프로세스가 아직 끝나지 않은 턴은 runningTurns에는
  // 남아 있어도(같은 담당자가 겹쳐 시작하지 않게) 화면·개입·중지 판정에서는 이미 없는 턴이다.
  liveTurns() {
    return [...this.runningTurns].filter((item) => item.generation === this.generation);
  }

  // 발언 큐 UI가 구독하는 방 전체 턴 상태 스냅숏.
  turnState() {
    const view = (item) => ({
      turnId: item.turnId,
      agentId: item.agent.id,
      discussion: Boolean(item.context.discussion),
      fast: item.lane === "fast",
      // ×가 이 항목만이 아니라 오케스트레이션 전체를 끝낸다는 것(설계 §(8))을 화면이
      // 다른 툴팁으로 알릴 수 있게 한다. claim 전(orchestrationStart만 있는 턴)은 false다.
      orchestration: Boolean(item.context.orchestration),
    });
    const live = this.liveTurns();
    return {
      current: live.length > 0 ? live[0].agent.id : null,
      // 동시에 도는 턴이 여럿일 수 있다(독립 발언, 바로 답하기). current는 그중 첫 번째다.
      running: live.map((item) => item.agent.id),
      queue: this.turnQueue.map(view),
      deferred: this.deferredTurnQueue.map(view),
    };
  }

  emitTurnState() {
    this.emit("turn-state", this.turnState());
  }

  // 스케줄러가 직접 내는 turn-state. 리스너가 던져도 방은 그대로 간다(경고만 남긴다). 오케스트레이션
  // 스냅숏도 같은 전환 지점마다 함께 낸다(turnState()의 기존 모양은 바꾸지 않는다 — 기존 시험이 그
  // 전체 모양을 deepEqual로 견주므로, 화면은 별도 이벤트 "orchestration"으로 구독한다, §(5)·§(9)).
  emitTurnStateSafe() {
    try {
      this.emitTurnState();
      this.emit("orchestration", this.orchestrationSnapshot());
    } catch (error) {
      console.warn("[agora] turn-state 리스너 실패:", error?.message || error);
    }
  }

  // 중지로 버려질 일반 대기 턴 수(토론 턴은 안내 대상이 아니다).
  queuedGeneralTurnCount() {
    return [...this.turnQueue, ...this.deferredTurnQueue].filter((item) => this.isGeneralTurn(item)).length;
  }

  droppedQuestionsNote(count) {
    return count > 0 ? ` 대기 중이던 메시지 ${count}개는 전달되지 않았으니 필요하면 다시 보내 주세요.` : "";
  }

  // 사용자 개입("잠깐"): 현재 실행과 대기 턴을 모두 중지하고 발언권을
  // 사용자에게 돌려줍니다. 중지 직전에 도착한 응답이나 @멘션도 세대 가드로
  // 버리며, 다음 사용자 발화 전까지 에이전트발 호출을 만들지 않습니다.
  interject() {
    const dropped = this.turnQueue.length + this.deferredTurnQueue.length;
    const interrupted = dropped > 0 || this.liveTurns().length > 0 || this.cancels.size > 0;
    const lost = this.queuedGeneralTurnCount();
    // 대기 턴마다 따로 안내하지 않고, 아래 한 줄에 합친다.
    this.stopAllSilently({ notifyLost: false });
    this.mentionsMuted = true;
    if (interrupted) {
      this.appendSystem("사용자가 개입해 진행 중인 응답과 대기 턴을 중지했습니다. 다음 차례는 사용자입니다." + this.droppedQuestionsNote(lost));
    }
    this.emitTurnStateSafe();
    return { dropped, interrupted };
  }

  // 큐를 떠나는 턴의 장부 정리. 실행되든 버려지든 반드시 거친다 — dedupe 키가
  // 남으면 같은 요청을 다시 보낼 수 없고, 대기 타이머가 남으면 이미 끝난 턴에
  // "유실됐을 수 있다" 안내가 뜬다. keepKeys는 갈아끼우기용이다: 키를 새 항목이 이미 물려받았다.
  releaseQueuedTurn(item, { keepKeys = false } = {}) {
    if (!keepKeys) {
      for (const key of item.dedupeKeys || (item.dedupeKey ? [item.dedupeKey] : [])) {
        if (this.pendingTurns.get(key) === item) this.pendingTurns.delete(key);
      }
    }
    this.turnStartedAt.delete(item.turnId);
  }

  // 실행 없이 끝나는 턴. lost면 사용자에게 다시 보내라고 안내한다(중지·취소).
  // 갈아끼우기처럼 질문이 새 턴으로 그대로 전달되는 경우는 안내하지 않는다.
  retireTurn(item, outcome, { lost = false, keepKeys = false } = {}) {
    this.releaseQueuedTurn(item, { keepKeys });
    item.resolve(outcome);
    if (lost) this.notifyLostTurn(item);
  }

  // 큐(대기·미룸)에서 항목 하나를 뺀다. 빠졌으면 true.
  removeQueued(item) {
    for (const queue of [this.turnQueue, this.deferredTurnQueue]) {
      const index = queue.indexOf(item);
      if (index >= 0) {
        queue.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  // 발언 큐 UI에서 대기 중인 턴 하나를 콕 집어 취소합니다.
  cancelTurn(turnId) {
    const item = [...this.turnQueue, ...this.deferredTurnQueue].find((entry) => entry.turnId === turnId);
    if (!item) return false;
    // 이미 claim된(=오케스트레이션이 생긴) 지휘 AI 회신 턴·작업자 묶음 항목은 그 한 항목만 지우지 않고
    // 오케스트레이션 전체를 끝낸다(설계 §(8)·§(13) 불변식 14). 아직 claim 전(orchestrationStart만 있는
    // 턴)은 끝낼 오케스트레이션이 없으므로 보통 × 그대로다.
    if (item.context.orchestration) {
      this.endOrchestration("오케스트레이션을 여기서 끝냅니다. 지금까지의 결과는 위에 있습니다.");
      return true;
    }
    this.removeQueued(item);
    // 사용자가 일부러 지운 턴이다. "유실됐을 수 있다"는 안내를 붙이지 않는다.
    this.retireTurn(item, undefined, { lost: false });
    this.emitTurnStateSafe();
    // 이 항목이 막고 있던 뒤 항목이 풀릴 수 있다.
    this.pumpTurnQueue();
    return true;
  }

  // 사용자 메시지에 뿌리를 둔 이 담당자의 대기 턴(걷어낼 수 있는 것)을 모은다. 걷어내지는 않는다.
  //
  // 대기 턴은 예약 시점의 히스토리(promptLimit)를 붙들고 있어, 사용자가 생각을
  // 나눠 보내면 앞 조각만 보고 답하고 조각마다 턴이 하나씩 생겨 같은 담당자가
  // 여러 번 답했다. 새 메시지로 다시 잡으면 전체를 보고 한 번만 답한다. 실행
  // 중인 턴은 이미 프롬프트가 들어갔으므로 건드리지 않고, 유실 안내도 내지
  // 않는다 — 질문은 새 턴이 그대로 전달한다.
  collectSupersedable(agentId) {
    return [...this.turnQueue, ...this.deferredTurnQueue].filter(
      (item) => item.agent.id === agentId && item.context.turnRootId && this.isFreeChatContext(item.context)
        // 오케스트레이션 턴(지휘 AI·작업자)은 걷어낼 수 없다 — 직접 @other 메시지가 진행 중인
        // 작업자 할당을 지워버리면 안 된다(설계 §(4) "교차점").
        && !item.context.orchestration
    );
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

  // 시작할 수 있는 단위를 모두 시작하는 재진입 펌프(한 번의 동기 패스). 멱등이라 할 일이 없으면 아무것도 하지 않는다.
  // 시작한 단위들의 약속을 모아 돌려준다. 패스가 도는 중에 다시 불리면 끝나기 직전에 한 번 더 돈다.
  //
  // 규칙: 낡은 세대 항목은 치운다. 빠른 줄은 단위의 담당자가 모두 비어 있으면(runningTurns에 없으면) 시작한다.
  // 일반 줄은 돌고 있는 단위가 하나도 없을 때만 맨 앞 단위를 시작한다(엄격한 FIFO).
  pumpTurnQueue() {
    if (this.pumpSuspended > 0) return Promise.resolve();
    if (this.pumping) {
      this.pumpAgain = true;
      return Promise.resolve();
    }
    this.pumping = true;
    const started = [];
    try {
      do {
        this.pumpAgain = false;
        started.push(...this.pumpPass());
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    return Promise.all(started);
  }

  // 같은 단위(같은 parallelGroupId 또는 workerUnitId의 큐 항목 전부, 없으면 항목 하나)로 같이 시작하는 항목들.
  // workerUnitId는 오케스트레이션 작업자 묶음을 묻는 키다(설계 §(4) — parallelGroupId는 쓰지 않는다,
  // 그 필드가 buildAgentPrompt의 무거운 "자기 폴더에만" 계약과 폴더 밖 변경 감시를 함께 켜기 때문이다).
  unitOfQueued(item) {
    const groupId = item.context?.parallelGroupId || item.context?.workerUnitId;
    if (!groupId) return [item];
    return this.turnQueue.filter((entry) => (entry.context?.parallelGroupId || entry.context?.workerUnitId) === groupId);
  }

  // 오케스트레이션 턴이 아닌 활성 단위가 하나라도 있는가. 메인 줄 게이트와 정체 진단이 같이 쓴다(§2.4(c)).
  hasNonOrchestrationActiveUnit() {
    return [...this.activeUnits].some((unit) => !unit.items[0].context.orchestration);
  }

  agentIsRunning(agentId) {
    for (const running of this.runningTurns) {
      if (running.agent.id === agentId) return true;
    }
    return false;
  }

  pumpPass() {
    // 0. 낡은 세대 항목은 시작하지 않고 치운다(시험이 직접 넣은 항목 등).
    const stale = this.turnQueue.filter((item) => item.generation !== this.generation);
    if (stale.length > 0) {
      for (const item of stale) {
        this.removeQueued(item);
        try {
          this.retireTurn(item, undefined, { lost: true });
        } catch (error) {
          console.warn("[agora] 낡은 턴 정리 중 실패:", error?.message || error);
        }
      }
      this.emitTurnStateSafe();
    }

    // 시작할 단위를 모두 고르고 한꺼번에 "돌고 있음"으로 등록한 뒤에 실행을 띄운다. 같은 패스에서 시작하는 턴이
    // 서로를 동시에 도는 턴으로 보게 하려는 것이다.
    const units = [];
    const seen = new Set();
    for (const item of [...this.turnQueue]) {
      if (item.lane !== "fast" || seen.has(item)) continue;
      const members = this.unitOfQueued(item);
      for (const member of members) seen.add(member);
      if (members.some((member) => this.agentIsRunning(member.agent.id))) continue;
      units.push(this.claimUnit(members));
    }
    // 메인 줄은 "활성 단위가 하나도 없을 때"가 아니라 "오케스트레이션이 아닌 활성 단위가 하나도 없을 때"
    // 시작한다(설계 §2.4(c)) — 오케스트레이션이 라운드를 쉬지 않고 도는 동안에도 @all 같은 메인 줄
    // 메시지가 굶지 않는다. activeUnits가 비었으면 every()가 참을 돌려줘 기존 동작과 같다.
    if (!this.hasNonOrchestrationActiveUnit()) {
      const head = this.turnQueue.find((item) => item.lane !== "fast");
      if (head) {
        const members = this.unitOfQueued(head);
        // 돌고 있는 단위가 없으면 runningTurns도 비어 있지만 방어로 한 번 더 본다.
        if (!members.some((member) => this.agentIsRunning(member.agent.id))) units.push(this.claimUnit(members));
      }
    }
    if (units.length === 0) return [];

    // 같은 단위가 아닌, 지금 돌고 있는 다른 턴의 담당자. 모든 단위를 등록한 뒤에 정해야 같은 패스의 턴끼리도 서로 보인다.
    for (const unit of units) {
      for (const item of unit.items) {
        item.concurrentAgents = [...new Set(
          this.liveTurns().filter((running) => !unit.items.includes(running)).map((running) => running.agent.id)
        )];
      }
    }
    this.syncCurrentTurn();
    this.emitTurnStateSafe();
    return units.map((unit) => this.runUnit(unit));
  }

  // 단위를 큐에서 빼 "돌고 있음"으로 등록한다. 던질 수 있는 일은 하지 않는다.
  claimUnit(members) {
    const unit = { items: members };
    for (const item of members) {
      this.removeQueued(item);
      this.releaseQueuedTurn(item);
      this.runningTurns.add(item);
      // 지휘 AI의 첫 턴(사용자 메시지)만 이 표식을 갖는다. claim 시점에 조건이 맞으면 오케스트레이션을
      // 새로 만든다 — 큐에서 기다리는 동안 모드가 꺼지거나 지휘 AI가 바뀌었으면 보통 턴으로 돈다(설계 §2.3).
      if (item.context.orchestrationStart && !item.context.orchestration) {
        this.maybeStartOrchestration(item);
      }
      // 오케스트레이션이 사는 동안 claim되는 모든 오케스트레이션 턴(지휘 AI+작업자)마다 실행 횟수를 올린다(§(5)).
      // round는 "지휘 AI 턴이 지금까지 몇 번 돌았나"이므로 지휘 AI 턴이 claim될 때만 그 값으로 맞춘다.
      if (item.context.orchestration && this.orchestration && this.orchestration.id === item.context.orchestration.id) {
        this.orchestration.executions += 1;
        if (item.context.orchestration.role === "lead") this.orchestration.round = item.context.orchestration.round;
      }
      // 보류 메시지는 "예약 시점"이 아니라 지휘 AI 턴이 실제로 claim되는 이 순간에 확정한다(설계 §(7) —
      // "지휘 AI 턴이 실제로 claim될 때(예약 때가 아니라)"). 예약된 뒤 claim되기 전까지 더 들어온 보류
      // 메시지도 여기서 함께 싣고, 이 턴이 claim되지 못한 채 버려지면(§(8) endOrchestration의 형제
      // 치우기, ×취소 등) heldMessages가 비어 있지 않은 그대로 남아 "전달되지 않았습니다" 안내가 나간다.
      if (item.context.orchestration?.role === "lead" && this.orchestration
        && this.orchestration.id === item.context.orchestration.id && this.orchestration.heldMessages.length > 0) {
        const heldBlock = [
          "=== 사용자가 그 사이 보낸 메시지 ===",
          ...this.orchestration.heldMessages.map((text) => `"${text}"`),
          "=== 사용자가 그 사이 보낸 메시지 끝 ===",
        ].join("\n");
        item.context.extraLines = [...(item.context.extraLines || []), heldBlock];
        this.orchestration.heldMessages = [];
      }
      // 단위의 실제 크기는 지금 센다: 구성원이 갈아끼워져 줄었으면 "참가자 N명" 계약도 그 크기를 쓴다.
      item.parallelTotal = members.length;
      // 빠른 턴과 독립 발언 턴은 시작 시점에 끝난 답까지 본다. 일반(이어 발언) 턴은 예약 시점의 기록을 그대로 쓴다.
      if (item.lane === "fast" || item.context.independent) {
        item.promptLimit = this.messages.length;
        // 답할 메시지가 기록의 마지막이면 예전 문구("마지막 메시지에 이어")가 그대로 맞으므로 프롬프트를 바꾸지 않는다.
        // 그 뒤에 다른 참가자의 답이 끝나 들어와 있을 때만 그 메시지를 직접 가리킨다.
        const history = this.promptMessages(item.promptLimit, item.context.independent, item.context.turnRootId);
        const rootMessage = item.context.turnRootId
          ? this.messages.find((message) => message.id === item.context.turnRootId)
          : null;
        const target = history.at(-1)?.id === item.context.turnRootId
          ? ""
          : String(rootMessage?.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
        item.replyTarget = target || null;
      }
    }
    this.activeUnits.add(unit);
    return unit;
  }

  // 지휘 AI에게 가는 메시지가 claim되는 순간(스케줄 시점이 아니라) 조건을 다시 확인하고 오케스트레이션을
  // 만든다(설계 §2.3). 조건이 안 맞으면(모드 꺼짐·지휘 AI 바뀜) 조용히 보통 턴으로 둔다 — 시작한 적 없는
  // 오케스트레이션은 정리할 것이 없다. 토론과 겹치는 좁은 창(§2.4(a))만 한 줄 안내한다.
  maybeStartOrchestration(item) {
    const start = item.context.orchestrationStart;
    const cfg = this.meta.orchestrator || {};
    const stillValid = Boolean(cfg.enabled) && cfg.leadId === start.leadId;
    if (stillValid && (this.discussionRequested || this.discussionActive)) {
      this.appendSystem("오케스트레이션이 토론 시작과 겹쳐 이번 요청은 보통 대화로 처리합니다. 토론이 끝난 뒤 다시 말씀해 주세요.");
      return;
    }
    if (!stillValid || this.orchestration) return;
    this.orchestrationSeq += 1;
    this.orchestration = {
      id: `o${this.sessionId || "s"}-${this.orchestrationSeq}`,
      leadId: start.leadId,
      round: 1,
      executions: 0,
      heldMessages: [],
      rootMessageId: item.context.turnRootId,
      ceilingNoticed: false,
    };
    item.context.orchestration = { id: this.orchestration.id, role: "lead", round: 1 };
  }

  // 지금 실행 중인 턴들. 순차 실행에서는 언제나 0개 또는 1개다.
  syncCurrentTurn() {
    this.currentTurn = this.liveTurns()[0] || null;
  }

  // 단위를 실행한다: 항목들을 동시에 돌리고, 쓰기 방의 독립 발언 단위면 폴더 계약을 본 뒤, 단위를 끝낸다.
  //
  // 같은 파일을 두 담당자가 함께 고치면 나중 쓰기가 이깁니다 — 사용자가 각자
  // 따로 만들라고 지시한 경우를 위한 실행 방식이며, 파일 단위 충돌은 막지 않습니다.
  async runUnit(unit) {
    const members = unit.items;
    // 담당자별 폴더 계약이 지켜졌는지는 실행이 끝난 뒤에 본다. 시작 시각만
    // 기억해 두면 되므로 실행이 늦어지지 않는다. 쓰기 권한 방에서만 본다.
    const startedAt = members.length > 1 && members[0].context.parallelGroupId && this.meta.permissionMode === "workspace-write"
      ? Date.now()
      : null;
    const generation = this.generation;
    let outcomes = [];
    try {
      outcomes = await Promise.all(members.map((item) => this.runQueuedTurn(item)));
      // 중지·초기화로 세대가 바뀌었으면 알리지 않는다. 비워진 대화에 뒤늦은
      // 안내만 남는다.
      if (startedAt !== null && generation === this.generation) {
        await this.reportFolderContractBreaches(members, startedAt);
      }
    } catch (error) {
      console.warn("[agora] 턴 단위 실행 중 실패:", error?.message || error);
    } finally {
      // 단위가 끝나야 일반 줄이 시작할 수 있다. 오케스트레이션 다음 단계(작업자 묶음 짓기, 결과 수집)는
      // activeUnits에서 뺀 뒤·유휴 대기자를 깨우기 전에 건다(설계 §(4)의 자리 — this.orchestration이
      // 여기서 null이 돼야 토론이 기다리고 있었으면 깬다, §2.4(b)).
      this.activeUnits.delete(unit);
      try {
        this.handleOrchestrationUnit(unit, outcomes);
      } catch (error) {
        console.warn("[agora] 오케스트레이션 처리 중 실패:", error?.message || error);
        this.endOrchestration("오케스트레이션이 내부 오류로 끝났습니다. 지금까지의 결과는 위에 있습니다.");
      }
      this.resolveIdleWaiters();
      this.pumpAfterTurn();
    }
  }

  // runUnit의 finally 전용 공용 문(설계 §(4)) — 오케스트레이션 턴이 아니면 아무것도 하지 않는다.
  // 끝났거나 바뀐 오케스트레이션의 늦은 결과는 역할과 무관하게 조용히 버린다(§(13) 불변식 15).
  handleOrchestrationUnit(unit, outcomes) {
    const marker = unit.items[0].context.orchestration;
    if (!marker) return;
    if (!this.orchestration || this.orchestration.id !== marker.id) return;
    if (marker.role === "lead") {
      this.handleLeadTurnEnd(unit.items[0], outcomes[0]);
    } else if (marker.role === "worker") {
      this.finishWorkerUnit(unit.items, outcomes);
    }
  }

  // 지휘 AI 턴이 끝났다: @작업자 호출이 있으면 안전선을 거쳐 작업자 묶음을 claim하고,
  // 없으면(또는 자신이 실패·불가용) 오케스트레이션을 끝낸다(설계 §(4)·§(8)).
  handleLeadTurnEnd(item, outcome) {
    const orch = this.orchestration;
    if (outcome === undefined) {
      this.endOrchestration(`@${orch.leadId}를 더 쓸 수 없어 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.`);
      return;
    }
    if (!outcome.ok) {
      this.endOrchestration(`@${orch.leadId} 응답이 실패해 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.`);
      return;
    }
    const text = outcome.text || "";
    // 그룹 별칭 없이(§(4) — isFastEligible이 쓰는 호출 방식과 같다), 자기 자신을 뺀 멘션.
    const mentionedIds = [...new Set(parseMentions(text, this.agents))].filter((id) => id !== orch.leadId);
    const available = new Set(this.enabledAgents().map((agent) => agent.id));
    const workerIds = mentionedIds.filter((id) => available.has(id));
    const unavailableIds = mentionedIds.filter((id) => !available.has(id));
    if (workerIds.length === 0) {
      if (unavailableIds.length > 0) {
        this.endOrchestration(`⟦${unavailableIds.join(", ")}⟧을 부를 수 없어 맡기지 못했습니다.`);
        return;
      }
      // @ 없이 답함(또는 그룹 별칭·자기 자신만) = 이번 답이 오케스트레이션의 최종 답이다.
      if (outcome.controlRequest?.action === "ASK_USER" && !outcome.controlRequest.ambiguous) {
        this.setAwaitingUser(orch.leadId, outcome.controlRequest.question || "", outcome.controlRequest.options || [], outcome.controlRequest.multi);
      }
      this.endOrchestration(null);
      return;
    }
    if (orch.executions + workerIds.length > this.executionCeiling) {
      this.endOrchestration(`실행 횟수 안전선(${this.executionCeiling}회)에 닿아 더 맡기지 않았습니다. 메시지를 보내면 이어 갑니다.`);
      return;
    }
    this.scheduleWorkerUnit(workerIds, item, outcome.messageId);
  }

  // 작업자 묶음은 쪼개지지 않게 한 묶음으로 올린다(설계 §(4) — pumpSuspended로 감싼다).
  scheduleWorkerUnit(workerIds, leadItem, leadMessageId) {
    const orch = this.orchestration;
    const round = leadItem.context.orchestration.round;
    const workerUnitId = `wu-${orch.id}-${round}`;
    const attachments = this.attachmentsOfMessages([leadItem.context.turnRootId]);
    this.pumpSuspended += 1;
    try {
      for (const agentId of workerIds) {
        const agent = this.findAgent(agentId);
        if (!agent) continue;
        this.scheduleTurn(agent, {
          orchestration: { id: orch.id, role: "worker", round },
          workerUnitId,
          turnRootId: leadMessageId,
          independent: true,
          attachments,
        }, { lane: "fast" });
      }
    } finally {
      this.pumpSuspended -= 1;
      this.pumpTurnQueue();
    }
  }

  // 작업자 묶음이 전부 끝났다: 결과 블록을 짜고(§(7)) 안전선을 거쳐 지휘 AI의 다음 회신 턴을 claim한다.
  finishWorkerUnit(members, outcomes) {
    const orch = this.orchestration;
    const round = members[0].context.orchestration.round;
    const lines = [`=== 작업자 결과(라운드 ${round}) ===`];
    members.forEach((item, index) => {
      const outcome = outcomes[index];
      const id = item.agent.id;
      if (outcome === undefined) {
        lines.push(`[@${id}] 사용할 수 없음(비활성화되었거나 설치되지 않음)`);
      } else if (!outcome.ok) {
        lines.push(`[@${id}] 실패(${outcome.stopReason || "실패"})`);
        lines.push(String(outcome.error || "").slice(0, 1000));
      } else if (outcome.controlRequest?.action === "ASK_USER") {
        lines.push(`[@${id}] 질문 있음: ${outcome.controlRequest.question || ""}`);
        if (outcome.controlRequest.options?.length > 0) lines.push(`OPTION: ${outcome.controlRequest.options.join(", ")}`);
      } else {
        const text = String(outcome.text || "");
        lines.push(`[@${id}] 완료`);
        lines.push(text.length > 2000 ? `${text.slice(0, 2000)}…(생략, 전체 ${text.length}자)` : text);
      }
      lines.push("---");
    });
    lines.push("=== 작업자 결과 끝 ===");
    const extraLines = [lines.join("\n")];
    const nextRound = round + 1;
    if (nextRound > this.roundCeiling) {
      this.endOrchestration(`라운드 안전선(${this.roundCeiling})에 닿아 멈췄습니다. 메시지를 보내면 이어 갑니다.`);
      return;
    }
    const leadAgent = this.findAgent(orch.leadId);
    if (!leadAgent || !leadAgent.available || leadAgent.enabled === false) {
      this.endOrchestration(`@${orch.leadId}를 더 쓸 수 없어 오케스트레이션을 끝냅니다. 지금까지의 결과는 위에 있습니다.`);
      return;
    }
    // 보류 메시지는 여기서 싣지 않는다 — claimUnit이 이 턴이 "실제로 claim되는" 순간에 싣고 비운다
    // (§(7)·claimUnit 참고). 예약(여기)과 claim 사이에 또 보류 메시지가 들어올 수 있고, 예약된 뒤
    // claim되지 못한 채 버려지면(안전선이 다시 걸리거나 ×로 지워지는 등) heldMessages가 그대로
    // 남아 있어야 endOrchestration의 "전달되지 않았습니다" 안내가 정확히 나간다(§(13) 불변식 10).
    this.scheduleTurn(leadAgent, {
      orchestration: { id: orch.id, role: "lead", round: nextRound },
      turnRootId: orch.rootMessageId,
      extraLines,
    }, { lane: "fast" });
  }

  // 오케스트레이션을 끝내는 모든 경로(×취소·모드 끔·지휘 AI 못 씀·안전선·정상 끝맺음)가 공유하는 헬퍼
  // (중지·잠깐·삭제·종료는 stopAllSilently가 이미 큐 전체를 치우므로 이 헬퍼를 쓰지 않는다, 설계 §(8)).
  endOrchestration(notice) {
    if (!this.orchestration) return;
    const orch = this.orchestration;
    // 형제를 치운다: 같은 오케스트레이션 id의 아직 claim 안 된 대기 항목(작업자 묶음의 나머지,
    // 지휘 AI의 대기 중인 회신 턴)을 전부 큐에서 뺀다. 개별 유실 안내는 내지 않는다.
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      if (item.context.orchestration?.id === orch.id) {
        this.removeQueued(item);
        this.retireTurn(item, undefined, { lost: false });
      }
    }
    let line = notice || "";
    if (orch.heldMessages.length > 0) {
      const heldNotice = "그 사이 보낸 메시지 " + orch.heldMessages.length + "개는 지휘 AI에게 따로 묶어 전달되지 않았습니다(대화에는 그대로 남아 있습니다).";
      line = line ? `${line} ${heldNotice}` : heldNotice;
    }
    if (line) this.appendSystem(line);
    this.orchestration = null;
    this.resolveIdleWaiters();
    this.pumpAfterTurn();
    this.emitTurnStateSafe();
  }

  // 펌프 호출이 던져도 약속이 이미 풀린 항목·단위의 정리를 막지 않는다.
  pumpAfterTurn() {
    try {
      this.pumpTurnQueue();
    } catch (error) {
      console.warn("[agora] 턴 펌프 실패:", error?.message || error);
    }
  }

  // 이미 등록(claim)된 항목 하나의 실행. 어떤 예외 뒤에도 장부를 되돌리고 약속을 정확히 한 번 푼다.
  async runQueuedTurn(item) {
    let outcome;
    try {
      outcome = await this.respond(
        item.agent,
        {
          ...item.context,
          promptLimit: item.promptLimit,
          turnId: item.turnId,
          ...(item.parallelTotal !== undefined ? { parallelTotal: item.parallelTotal } : {}),
          ...(item.replyTarget ? { replyTarget: item.replyTarget } : {}),
          ...(item.concurrentAgents?.length > 0 ? { concurrentWork: item.concurrentAgents } : {}),
        },
        item.generation
      );
    } catch {
      outcome = undefined;
    } finally {
      this.runningTurns.delete(item);
      this.syncCurrentTurn();
      this.emitTurnStateSafe();
      item.resolve(outcome);
      // 담당자 게이트는 이 항목이 runningTurns에서 빠지는 순간 풀린다. 단위가 아직 안 끝났어도
      // 풀린 담당자의 빠른 항목은 지금 시작해야 한다.
      this.pumpAfterTurn();
    }
    // runUnit의 Promise.all이 이 값을 받아 오케스트레이션 결과 수집에 쓴다(§(4)·§(7)).
    // item.promise(= scheduleResponse 호출자가 받는 약속)와는 별개 경로다.
    return outcome;
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

  // 유휴: 돌고 있는 단위(승인·질문 카드를 기다리는 턴, 폴더 감시 중인 단위, 중지했지만 프로세스가 아직 안 끝난 단위 포함)도
  // 기다리는 턴도 없다.
  isIdle() {
    return !this.orchestration && this.activeUnits.size === 0 && this.turnQueue.length === 0 && this.deferredTurnQueue.length === 0;
  }

  waitForIdle() {
    if (this.isIdle()) {
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
    const blockers = this.stallBlockers(item);
    if (blockers) {
      const running = blockers.map((id) => `@${id}`).join(", ");
      this.appendSystem(
        "@" + item.agent.id + " 응답은 아직 차례를 기다리고 있습니다" + (running ? ` (${running} 실행 중)` : "") + ". 그대로 기다리면 이어서 실행됩니다."
        + (this.pendingUserQuestionList().some((question) => blockers.includes(question.agentId)) ? " 실행 중인 응답이 사용자의 답을 기다리는 질문이 있습니다. 그 질문에 답하면 이어집니다." : "")
      );
      return;
    }
    this.lostTurnNotified.add(turnId);
    this.appendSystem("@" + item.agent.id + " 응답이 " + LOST_TURN_STALL_SECONDS + "초 넘게 시작되지 않고 있습니다. 응답이 유실됐을 수 있으니 기다리지 말고 다시 보내 주세요.");
  }

  // 대기 중인 항목이 지금 시작하지 못하는 까닭이 정말 있는지. 있으면 막고 있는 담당자들(비어 있을 수 있다),
  // 없으면 null(= 시작할 수 있는데 못 시작한 상태). 빠른 항목은 자기 단위의 담당자가 돌 때만 막힌 것이고,
  // 다른 담당자가 돌고 있다는 사실은 그 항목을 막지 않는다.
  stallBlockers(item) {
    const running = [...new Set([...this.runningTurns].map((entry) => entry.agent.id))];
    const deferred = this.deferredTurnQueue.includes(item);
    if (item.lane === "fast" && !deferred) {
      const own = [...new Set(this.unitOfQueued(item).map((member) => member.agent.id))].filter((id) => this.agentIsRunning(id));
      return own.length > 0 ? own : null;
    }
    if (deferred && (this.discussionActive || this.discussionRequested)) return running;
    return this.hasNonOrchestrationActiveUnit() || running.length > 0 ? running : null;
  }

  isFreeChatContext(context = {}) {
    return !context.discussion && !context.discussionSummary && !context.simplifyMeta;
  }

  // 이 실행 때문에 막힌 대기 턴의 담당자들: 일반 줄의 대기 턴은 전부(일반 줄은 도는 턴이 모두 끝나야 시작한다),
  // 빠른 줄은 이 담당자의 대기 턴만(다른 담당자의 빠른 턴은 이 실행과 상관없이 시작한다).
  // 같은 담당자가 이어 보낸 메시지도 이 실행 뒤에서 기다리므로 "다른 에이전트만" 거르지 않는다.
  queuedAgentsBehind(agentId) {
    const ids = [];
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      if (!this.isGeneralTurn(item)) continue;
      const id = item.agent && item.agent.id;
      if (item.lane === "fast" && id !== agentId) continue;
      if (id && !ids.includes(id)) ids.push(id);
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
      `@${agent.id} 응답이 ${match[1]}분째 진전이 없습니다. 사용량 한도로 멈춰 있을 수 있습니다 — 중지한 뒤 다시 보내거나 다른 담당자에게 보내 주세요.${tail}`
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
    this.appendSystem("중지로 @" + item.agent.id + " 응답 대기가 취소됐습니다. 방금 메시지는 전달되지 않았을 수 있으니 필요하면 다시 보내 주세요.");
  }

  resolveIdleWaiters() {
    if (!this.isIdle()) return;
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

  // 화면의 실시간 초안 말풍선을 거둔다. 결과 메시지가 대신 오지 않는 끝(중지·취소·승인 재시도)에서
  // 쓴다. 중지로 세대가 바뀐 뒤에도 가야 하므로 emitEvent의 세대 가드를 거치지 않는다.
  discardLiveRun(runId, agent) {
    this.emit("run-event", { runId, agentId: agent.id, kind: "run-discard" });
  }

  // 실행은 시작한 세대를 기억한다: 중지는 activeRuns를 즉시 0으로 되돌리므로, 취소한 옛 프로세스의 종료가 그 뒤 새로 시작한
  // 실행의 activeRuns를 깎거나 busy:false를 내보내지 않게 세대가 같을 때만 activeRuns를 센다. liveRuns는 세대와 무관하다.
  trackRunStart(generation = this.generation) {
    this.liveRuns += 1;
    if (generation !== this.generation) return generation;
    this.activeRuns += 1;
    if (this.activeRuns === 1) this.emit("busy", true);
    return generation;
  }

  trackRunEnd(generation = this.generation) {
    this.liveRuns = Math.max(0, this.liveRuns - 1);
    if (generation !== this.generation) return;
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0) this.emit("busy", false);
  }

  promptMessages(promptLimit = null, independent = false, turnRootId = null) {
    const messages = this.messages;
    if (!Number.isInteger(promptLimit) || promptLimit < 0) {
      return messages.filter((message) => message.authorType !== "system" && !message.error);
    }
    const cap = Math.min(promptLimit, messages.length);
    const base = messages.slice(0, cap);
    if (independent) {
      // 독립 발언은 같은 뿌리의 형제 답만 뺀다. 그 밖의 시작 전에 끝난 답(앞 질문의 답 포함)은 본다.
      return base.filter((message) => message.authorType !== "system" && !message.error
        && !(turnRootId && message.turnRootId === turnRootId && message.authorType === "agent"));
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
    const orchestrationRole = context.orchestration?.role || null;

    // 이 턴이 실행 중 질문 도구를 붙일 수 있는 종류인가. 자유 대화이면서 파일 작업 권한(읽기·쓰기)이 있는
    // 턴만이다. 토론·결론 종합·쉽게 설명 같은 도우미 턴과 대화 전용(chat) 턴은 아니다 — 대화 전용 답은
    // 짧아 끝에서 묻는 것으로 충분하고, 붙이면 시작이 느려지고 토큰이 늘기만 한다. 작업자는 늘 꺼진다
    // (설계 §(6)) — 작업자가 되물을 유일한 길은 응답 끝 ASK_USER(지휘 AI에게 전달)뿐이다.
    const questionPurpose = orchestrationRole === "worker"
      ? "other"
      : this.isFreeChatContext(context) && FILE_WORK_PERMISSIONS.has(permissionMode) ? "chat" : "other";
    let questionToolPossible = false;
    try {
      questionToolPossible = Boolean(this.questionTool?.canAttach?.(agent, questionPurpose));
      // 셸 래퍼(.cmd) 설치는 조용히 빠지면 카드가 왜 안 뜨는지 알 길이 없다. 이 방에서 에이전트마다 한 번 알린다(기억은 앱을 켜 둔 동안만이라 다시 켜면 다시 한 번).
      if (!questionToolPossible && questionPurpose === "chat" && this.questionTool?.support?.(agent, questionPurpose)?.code === "shell" && !this.questionShellNoticed.has(agent.id)) {
        this.questionShellNoticed.add(agent.id);
        this.appendSystem(`@${agent.id}는 설치 방식 때문에 작업 중 질문 기능을 쓸 수 없습니다. 결정이 필요하면 답변 끝에서 선택지로 묻습니다.`);
      }
    } catch {}
    let prompt;
    let buildPrompt;
    try {
      buildPrompt = (userQuestionTool) => buildAgentPrompt({
        agent,
        agents: this.enabledAgents(),
        messages: context.discussionSummaryMessages || this.promptMessages(context.promptLimit, context.independent, context.turnRootId),
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
        // 단위의 실제 크기가 1이면(구성원이 갈아끼워지거나 취소됐으면) 함께 도는 참가자가 없으므로 계약도 없다.
        parallel: context.parallelGroupId && context.parallelTotal !== 1
          ? { folder: agent.id, total: context.parallelTotal || 0 }
          : null,
        // 같은 단위가 아닌, 지금 돌고 있는 다른 턴(쓰기 방의 동시 작업 계약과 "아직 대화에 없는 답" 안내).
        concurrentWork: context.concurrentWork || [],
        // 시작 시점 기록을 쓰는 턴(빠른 턴, 독립 발언 턴)이 답할 사용자 메시지.
        replyTarget: context.replyTarget || null,
        handoff: context.handoff || null,
        // 토론·결론 종합·쉽게 설명에서는 @멘션 호출을 끈다. 연쇄 깊이 상한도 여기서 막는다.
        // 지휘 AI는 상한 없이 늘 호출할 수 있고(§(13) 불변식 4), 작업자는 늘 못 부른다(불변식 3).
        mentionsEnabled: orchestrationRole === "lead"
          ? true
          : orchestrationRole === "worker"
            ? false
            : !context.discussion && !context.discussionSummary && !context.simplifyMeta && mentionDepth < this.mentionChainLimit,
        userQuestionTool,
        orchestration: context.orchestration ? { role: orchestrationRole, leadId: this.orchestration?.leadId || null } : null,
        // 작업자 결과·보류 메시지 블록(설계 §(7)) — 기본값 []이면 기존 턴은 한 글자도 안 바뀐다.
        extraLines: context.extraLines || [],
      });
      prompt = buildPrompt(questionToolPossible);
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
      this.trackRunStart(generation);
      emitEvent({ kind: "run-start" });
      let run;
      let runPrompt = prompt;
      let questionHandle = null;
      try {
        if (typeof this.prepareAgent === "function") {
          await this.prepareAgent({ agent, runId });
          if (generation !== this.generation) {
            this.discardLiveRun(runId, agent);
            return;
          }
        }
        if (questionToolPossible) {
          questionHandle = await this.beginQuestionRun(agent, runId, context.turnId, questionPurpose);
          if (generation !== this.generation) {
            this.discardLiveRun(runId, agent);
            return;
          }
          // 못 붙였으면 프롬프트도 도구 없는 모양으로(ask_user를 쓰라고 해 놓고 없으면 안 된다).
          if (!questionHandle) runPrompt = buildPrompt(false);
        }
        run = this.runAgent({
          agent,
          prompt: runPrompt,
          runId,
          attachments: context.attachments || [],
          emitEvent,
          permissionMode,
          // 자동 승인은 workspace-write에서만 실제 argv에 반영된다(IPC 경계가 다시 막는다).
          autoApprove: agent.autoApprove || approvedRetry,
          ...(questionHandle ? { userQuestion: questionHandle } : {}),
        });
        const questionRun = this.questionRuns.get(runId);
        if (questionRun) questionRun.run = run;
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
        // 질문 도구가 붙었던 실행이면 남은 질문을 정리하고 중계소 등록을 푼다(중지로 이미 정리됐어도 안전하다).
        this.closeQuestionRun(runId, { submitting: result?.ok ? "answered" : "interrupted" });
        this.setTyping(agent.id, false);
        this.trackRunEnd(generation);
      }
      if (generation !== this.generation || result?.cancelled) {
        this.discardLiveRun(runId, agent);
        return;
      }
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
      // 이 실행의 결과 메시지는 오지 않는다(승인 뒤 다시 실행). 승인을 기다리는 동안 점선
      // 초안 말풍선이 응답 중으로 남지 않게 거둔다.
      this.discardLiveRun(runId, agent);
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
      if (orchestrationRole === "lead") {
        // 작업자 호출은 여기서 걸지 않는다 — runUnit의 finally(§(4))가 건다(타이밍 문제: 이 턴이
        // 아직 runningTurns에 남아 있는 동안 걸면 concurrentWork가 지휘 AI 자신을 "아직 답이 없는
        // 참가자"로 작업자에게 잘못 알린다). setAwaitingUser도 그 자리에서 조건부로 부른다(§(6)).
      } else if (orchestrationRole === "worker") {
        // 작업자는 다른 참가자를 못 부른다(§(13) 불변식 3). 호출을 시도했으면 한 줄만 안내한다.
        const attempted = parseMentions(text, this.agents).filter((id) => id !== agent.id);
        if (attempted.length > 0) {
          this.appendSystem(`@${agent.id}가 다른 참가자를 부르려 했지만 작업자는 다른 참가자를 부를 수 없습니다. 필요하면 지휘 AI가 다음 회신에서 다시 맡길 수 있습니다.`);
        }
      } else {
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
          this.setAwaitingUser(agent.id, controlRequest.question || "", controlRequest.options || [], controlRequest.multi);
        }
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
    const mentionedIds = parseMentions(text, this.agents).filter((id) => id !== agent.id);
    // 켜짐이 아니면 지금처럼 깊이 상한에서 멈춘다. 다른 점은: 걸러진 멘션이 있으면 한 줄 안내한다
    // (지금은 조용히 버림 — 설계 §(10) 결정으로 바뀌는 부분).
    if (!this.meta.keepCalling) {
      if (depth >= this.mentionChainLimit) {
        if (mentionedIds.length > 0) {
          const names = mentionedIds.map((id) => `@${id}`).join(", ");
          this.appendSystem(`${names} 호출이 전달 상한(${this.mentionChainLimit})에 걸려 전달되지 않았습니다. 계속 이어 가려면 입력창 위 'AI끼리 계속 부르기'를 켜세요.`);
        }
        return;
      }
      for (const agentId of mentionedIds) {
        const target = this.findAgent(agentId);
        if (!target || !target.available || target.enabled === false) continue;
        this.scheduleResponse(target, { mentionDepth: depth + 1, attachments, turnRootId });
      }
      return;
    }
    // 켜짐: 깊이 상한을 보지 않는다. 대신 이 메시지(turnRootId)에서 이어진 자동 호출의 합계를
    // 50에서 막는다 — 갈래가 퍼져도 합계로 막는다. 안내는 루트마다 한 번이다.
    for (const agentId of mentionedIds) {
      const target = this.findAgent(agentId);
      if (!target || !target.available || target.enabled === false) continue;
      const count = this.mentionCallCounts.get(turnRootId) || 0;
      if (count >= this.keepCallingCeiling) {
        if (!this.keepCallingCeilingNoticed.has(turnRootId)) {
          this.keepCallingCeilingNoticed.add(turnRootId);
          this.appendSystem(`이 메시지에서 이어진 자동 호출이 ${this.keepCallingCeiling}번에 닿아 멈췄습니다. 메시지를 보내면 이어 갑니다.`);
        }
        break;
      }
      this.mentionCallCounts.set(turnRootId, count + 1);
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

  // 끝난 토론 한 편의 결론 정보(discussionMeta)와 그 구간의 대화 메시지(시스템·오류 제외).
  // 결론 종합과 자동 기록이 같은 구간을 쓰도록 여기 한 곳에서 자른다.
  discussionRecordOf(discussionId) {
    const conclusionMsg = this.messages.find(
      (m) => m.discussionMeta && m.discussionMeta.discussionId === discussionId
    );
    if (!conclusionMsg || !conclusionMsg.discussionMeta) {
      return { ok: false, error: "해당 토론 기록을 찾을 수 없습니다." };
    }
    const meta = conclusionMsg.discussionMeta;
    let startIndex = meta.startMessageId ? this.messages.findIndex((m) => m.id === meta.startMessageId) : 0;
    if (startIndex === -1) startIndex = 0;
    let endIndex = meta.endMessageId ? this.messages.findIndex((m) => m.id === meta.endMessageId) : this.messages.length - 1;
    if (endIndex === -1) endIndex = this.messages.length - 1;
    const messages = this.messages
      .slice(startIndex, endIndex + 1)
      .filter((m) => m.authorType !== "system" && !m.error);
    if (messages.length === 0) return { ok: false, error: "요약할 토론 메시지가 없습니다." };
    return { ok: true, meta, messages };
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

    const found = this.discussionRecordOf(discussionId);
    if (!found.ok) return Promise.resolve(found);
    const { incomplete, participants, reason, failures } = found.meta;
    const discussionMessages = found.messages;

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
    // 오케스트레이션이 있으면 상태를 건드리기 전에 즉시 거절한다(§2.4(a)) — 기다리게 두면
    // discussionRequested가 메인 줄의 줄 계산을 어지럽힌다(설계 §2.4).
    if (this.orchestration) {
      return { ok: false, error: "오케스트레이션이 끝난 뒤에 토론을 시작할 수 있습니다." };
    }
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
    // 풀림과 아래 줄 사이에 새 턴이 끼면 토론 첫 턴과 그 턴이 동시에 돈다. 풀린 뒤 유휴를 다시 확인하고,
    // 같은 동기 구간에서 discussionActive를 켠다. 어느 길로 빠져나가도 요청 표시는 푼다.
    let ready = false;
    try {
      do {
        await this.waitForIdle();
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
      } while (!this.isIdle());
      this.discussionActive = true;
      ready = true;
    } finally {
      if (!ready) this.discussionRequested = false;
    }

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
      // 시작 메시지에 토론 id를 남겨 둔다. 앱이 토론 도중 끝나 결론 메시지가 없을 때, 다시 켠 뒤
      // 이 표식으로 끊긴 토론을 찾아 닫는다(chat-store.js closeDanglingDiscussions).
      const discussionStart = {
        discussionId,
        startMessageId,
        participants: pool.map((agent) => agent.id),
        budget,
      };
      this.appendMessage({
        authorType: "system",
        author: "system",
        text: protocol
          ? `구조화 토론 시작 · ${protocol.presetName} Preset · ${pool.map((agent) => `@${agent.id}`).join(", ")} · ${protocol.cycleBudget}사이클(최대 ${budget}턴)`
          : `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`,
        discussionStart,
      });
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
                topicMessageId: startMessageId,
              }
            : { turn, maxTurns: budget, topicMessageId: startMessageId },
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
    return { ok: true, completed, truncated: !concluded && completed >= budget, concluded, discussionId };
  }

  // 토론 상태를 풀고, 토론 동안 미뤄 둔 일반 턴을 큐로 돌려보낸다.
  endDiscussionState() {
    this.discussionActive = false;
    this.discussionRequested = false;
    this.discussionInterrupted = false;
    this.turnQueue.push(...this.deferredTurnQueue.splice(0));
    this.emitTurnStateSafe();
    this.pumpTurnQueue();
  }

  stopAll() {
    // 승인 카드를 기다리는 턴은 실행도 입력 중 표시도 없어 따로 센다.
    const hadWork = this.cancels.size > 0 || this.typingCounts.size > 0
      || this.liveTurns().length > 0 || this.pendingApprovals.size > 0
      || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0;
    const lost = this.queuedGeneralTurnCount();
    this.stopAllSilently({ notifyLost: false });
    if (hadWork) this.appendSystem("응답을 중지했습니다." + this.droppedQuestionsNote(lost));
  }

  clear() {
    this.stopAllSilently();
    this.messages = [];
    this.awaitingUsers.clear();
    this.userQuestions.clear();
    this.emit("reset");
  }

  // notifyLost=false면 버려진 대기 턴마다 안내하지 않는다(부르는 쪽이 한 줄로 합쳐 알린다).
  stopAllSilently({ notifyLost = true } = {}) {
    this.generation += 1;
    // 실행 중인 프로세스부터 끊는다. 아래 emit 리스너가 예외를 던져도 중지는 이미 걸려 있다.
    for (const cancel of this.cancels) {
      try {
        cancel();
      } catch {}
    }
    this.cancels.clear();
    // 답을 기다리던 질문도 함께 끝낸다. 프로세스는 위에서 이미 끊었다.
    try {
      for (const runId of [...this.questionRuns.keys()]) this.closeQuestionRun(runId, { reason: "stopped" });
    } catch (error) {
      console.warn("[agora] 중지 중 질문 정리 실패:", error?.message || error);
    }
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      this.retireTurn(item, undefined, { lost: notifyLost });
    }
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns.clear();
    this.turnStartedAt.clear();
    // 실행 중이던 턴도 방금 취소했다. runningTurns는 비우지 않는다: 취소한 프로세스가 실제로 끝나야 빠지고,
    // 그때까지 같은 담당자의 새 턴이 겹쳐 시작하지 않는다. 화면(turnState)은 세대가 지난 항목을 이미 없는 턴으로 센다.
    this.syncCurrentTurn();
    this.mentionsMuted = false;
    // interject()처럼 오케스트레이션을 끝낸 스냅숏으로 emit해야 화면이 멈춘 라운드를 안 든다 —
    // 취소한 작업자 프로세스가 실제로 끝나는 건 한참 뒤일 수 있다(Windows taskkill 지연 등).
    this.orchestration = null;
    this.emitTurnStateSafe();
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
    // orchestration=null은 위(emit 전)에서 이미 끝냈다 — resolveIdleWaiters()보다는 여전히 앞(§2.4(b)).
    // 늦게 끝나는 지휘 AI·작업자 프로세스의 결과는 runUnit의 공용 문(§(4))에서 id 불일치로 폐기된다.
    this.mentionCallCounts.clear();
    this.keepCallingCeilingNoticed.clear();
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
