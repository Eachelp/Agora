const { EventEmitter } = require("node:events");
const path = require("node:path");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions } = require("./chat-mention");
const { buildAgentPrompt } = require("./chat-prompt");
const {
  specialistPermissionMode,
  minPermissionMode,
  SPECIALIST_STAGE_CAPS,
} = require("./chat-argv");
const {
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
  phaseForNode,
} = require("../agora/professional-run");
const { TaskManager, hashText } = require("../agora/task-manager");
const { REQUIRED_SECTIONS, validateTaskContract } = require("../agora/task-contract-validator");
const { describeWorkspaceChanges } = require("../agora/workspace-diff");
// Stage D-B — 자원/행동 심사. 실제 변경 직전에 이 관문을 통과해야 한다(§23).
const {
  adjudicateAction,
  admitAction,
  RESOURCE_KINDS,
  ACTIONS,
} = require("../agora/assurance/resource-governance");
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
const { resolveProtocol, speakerForTurn, isFinalStep } = require("../agora/discussion-protocol");

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
const DISCUSSION_TURN_BUDGET_MIN = 3;
const DISCUSSION_TURN_BUDGET_MAX = 50;

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
    // Stage D-0 Workspace Mutation Lease. 주입되지 않으면 소유권 통제 없이
    // 기존 동작을 유지합니다(legacy 호출/테스트 호환).
    this.mutationLease = options.mutationLease || null;
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
    // 전문 실행 재개(기획 답변·재기획) 시 기획·기획검수 담당자를 현재 프로젝트
    // 설정에서 다시 조회해 스냅샷을 갱신하는 훅이다. null이면 기존처럼 실행 시작
    // 시점에 저장된 stages를 그대로 쓴다.
    this.planStagesRefresher = typeof options.planStagesRefresher === "function"
      ? options.planStagesRefresher
      : null;
    // Stage C — provider-neutral harness lifecycle seam(chat-ipc가 주입).
    // { workspaceRestored(), professionalRunEnded({ professionalRunId, invalid }) }
    // 형태이며, room은 lifecycle facts만 전달하고 세션/adapter 내부는 모른다.
    this.harnessLifecycle = options.harnessLifecycle || null;
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
    this.lostTurnNotified = new Set();
    this.turnStartedAt = new Map();
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
    // V1.5 System Journal appender. 없으면 기록을 생략한다(테스트·레거시 호환).
    this.appendProfessionalEvent = typeof options.appendProfessionalEvent === "function"
      ? options.appendProfessionalEvent
      : null;
    this.journalWriteFailureNotified = false;
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
    // 답변 대기(PLANNING/PLAN_REVIEW + WAITING)도 복원한다. 예전에는 READY만
    // 복원해서, 그 상태로 앱을 껐다 켜면 입력칸은 열리는데 답변은 거부됐다.
    this.specialistResume = this.resumeForWaitingPlan();
    if (this.professionalRun?.node === "READY" && this.professionalRun.taskPath) {
      let contract = null;
      try {
        contract = this.taskManager.resolveTaskContract(
          { contentSource: "file", taskPath: this.professionalRun.taskPath },
          this.meta.workspace
        );
      } catch {}

      if (contract) {
        const contractCheck = validateTaskContract(contract.content);
        const hasValidApproval =
          contractCheck.valid &&
          this.professionalRun.stopReason !== "TASK_CONTRACT_INCOMPLETE" &&
          Boolean(this.professionalRun.approvedTaskHash) &&
          this.professionalRun.approvedTaskHash === hashText(contract.content);

        if (hasValidApproval) {
          this.professionalPlan = {
            stages: this.professionalRun.stages || {},
            mode: "auto",
            implementationAutoRevisions: this.professionalRun.policy?.implementationAutoRevisions || 0,
            taskInfo: {
              relativePath: this.professionalRun.taskPath,
              filename: path.basename(this.professionalRun.taskPath),
              content: contract.content,
              hash: this.professionalRun.approvedTaskHash,
            },
            feedback: contract.content,
          };
        } else {
          // Task 계약이 불완전하거나, 외부 수정/이전 실패로 승인 상태가 무효화된 경우
          // 정상 READY로 복원하지 않고 TASK_CONTRACT_INCOMPLETE 복구 대기 상태로 전환한다.
          const missingSections = contractCheck.valid ? [] : contractCheck.missing;
          const transition = transitionProfessionalRun(this.professionalRun, {
            type: "TASK_CONTRACT_INCOMPLETE",
            missingSections,
          });
          if (transition.ok) {
            this.professionalRun = transition.state;
            try {
              this.persistProfessionalRun?.(this.professionalRun);
            } catch {}
          }
          this.specialistResume = {
            stages: this.professionalRun.stages || {},
            mode: "auto",
            phase: "task_contract_incomplete",
            taskInfo: {
              relativePath: this.professionalRun.taskPath,
              filename: path.basename(this.professionalRun.taskPath),
              content: contract.content || "",
              hash: hashText(contract.content || ""),
            },
            feedback: contract.content || "",
            missingSections,
            taskError: contractCheck.valid
              ? "작업 지시서 내용은 현재 필수 계약을 만족하지만, 승인 상태가 무효화되어 재검수가 필요합니다."
              : `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${contractCheck.missing.join(", ")}`,
            maxAutoRevisions: this.professionalRun.policy?.implementationAutoRevisions || 0,
          };
        }
      } else {
        // resolveTaskContract가 null인 경우 (파일 누락 또는 읽기 불가)
        // READY 상태로 방치하지 않고 fail-closed recovery 상태로 전환한다.
        const allMissing = [...REQUIRED_SECTIONS];
        const transition = transitionProfessionalRun(this.professionalRun, {
          type: "TASK_CONTRACT_INCOMPLETE",
          missingSections: allMissing,
        });
        if (transition.ok) {
          this.professionalRun = transition.state;
          try {
            this.persistProfessionalRun?.(this.professionalRun);
          } catch {}
        }
        this.specialistResume = {
          stages: this.professionalRun.stages || {},
          mode: "auto",
          phase: "task_contract_incomplete",
          taskInfo: {
            relativePath: this.professionalRun.taskPath,
            filename: path.basename(this.professionalRun.taskPath),
            content: "",
            hash: hashText(""),
          },
          feedback: "",
          missingSections: allMissing,
          taskError: "작업 지시서(TASK.md) 파일을 찾을 수 없거나 읽을 수 없습니다.",
          maxAutoRevisions: this.professionalRun.policy?.implementationAutoRevisions || 0,
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
      needsInput: Boolean(professional?.needsInput) || ["needs_decision", "plan_review_fix_required", "task_contract_incomplete"].includes(this.specialistResume?.phase),
      planReady: (Boolean(professional?.planReady) || Boolean(this.professionalPlan)) && this.specialistResume?.phase !== "task_contract_incomplete" && professional?.stopReason !== "TASK_CONTRACT_INCOMPLETE",
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
      missingSections: this.specialistResume?.missingSections || professional?.missingSections || null,
    };
  }

  emitSpecialistState() {
    this.emit("specialist-resume-state", this.specialistState());
  }

  // "실행 중이라 바쁘다"와 "사용자를 기다린다"는 다른 상태다. 둘을 한 판정으로
  // 묶으면 사용자가 다시 시작하고 싶은 바로 그 상태(BLOCKED·답변 대기)에서
  // 새 기획까지 막혀, 걸려 있는 질문에 답하는 것 말고 길이 없어진다.
  isSpecialistBusy() {
    return Boolean(this.specialistActive);
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
    //
    // 다만 recordOnly는 예외입니다. 이것은 응답을 예약하지 않고 메시지만 남기므로
    // 진행 중인 실행에 끼어들지 않고, 구현자·검수자·기록자는 대화를 아예 보지
    // 않으므로(ROLE_CONTEXT_POLICY) 동결된 계약도 오염되지 않습니다. 기획자만
    // 다음 라운드에 읽습니다. 이걸 막으면 실행이 도는 동안 사용자가 방향을
    // 일러 줄 수단이 사라집니다.
    if (!recordOnly && this.isSpecialistLocked()) {
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

  // Stage C — provider-neutral same-turn approval seam. harness adapter가 실행 중 특정 action
  // 승인을 요청할 때(예: Codex on-request) 호출한다. native protocol id(threadId/turnId/
  // requestId/method)는 전혀 노출하지 않고 { summary, detail, scope, signal }만 받는다. 기존
  // approval UI(approval-request/resolveApproval)를 재사용한다. signal이 abort되면(=turn
  // 종료/취소) 카드를 dismiss하고 더 이상 승인 가능 상태로 두지 않는다(late accept 금지).
  requestInteractiveApproval(agent, request = {}, generation = this.generation) {
    if (generation !== this.generation) return Promise.resolve(false);
    const signal = request.signal;
    if (signal && signal.aborted) return Promise.resolve(false);
    this.approvalSeq += 1;
    const approvalId = `a${this.sessionId || "s"}-${this.approvalSeq}`;
    const scope = request.scope === "action" ? "action" : "turn";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        if (this.pendingApprovals.get(approvalId) === finish) this.pendingApprovals.delete(approvalId);
        resolve(Boolean(decision));
      };
      this.pendingApprovals.set(approvalId, finish);
      this.emit("approval-request", {
        approvalId,
        agentId: agent.id,
        summary: request.summary || "도구 실행 권한이 필요합니다.",
        detail: request.detail || "",
        retryScope: scope,
      });
      if (signal) {
        signal.addEventListener("abort", () => {
          if (settled) return;
          this.emit("approval-resolved", { approvalId });
          finish(false);
        }, { once: true });
      }
    });
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
    this.trackTurnWait(item);
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
      const cancelled = this.cancelSpecialist("개입으로 ");
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
      this.notifyLostTurn(item);
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
          this.notifyLostTurn(item);
          this.emitTurnState();
          continue;
        }
        this.currentTurn = item;
        this.turnStartedAt.delete(item.turnId);
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

  // General (non-discussion, non-specialist) turns lost to stop/generation
  // bumps must not disappear silently: tell the user to resend.
  isGeneralTurn(item) {
    return !item.context.discussion && !item.context.specialist;
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
    this.lostTurnNotified.add(turnId);
    this.appendSystem("@" + item.agent.id + " 응답이 " + LOST_TURN_STALL_SECONDS + "초 넘게 시작되지 않고 있습니다. 응답이 유실됐을 수 있으니 기다리지 말고 다시 보내 주세요.");
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
    if (this.activeRuns === 1) this.emit("busy", true);
  }

  trackRunEnd() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0) this.emit("busy", false);
  }

  // Stage D-0 — canonical workspace one-writer.
  //
  // 같은 프로젝트의 workspace는 하나이고 그 아래 대화(room)는 여럿이므로, 다른
  // 대화가 같은 폴더를 바꾸는 동안에는 변경을 시작하지 않는다(fail-closed).
  //
  // 재진입은 같은 대화라는 것만으로 허용되지 않는다. 바깥 작업이 자기 안에서
  // 다시 요청하는 진짜 중첩임을 parentToken으로 증명해야 한다. 그렇지 않으면
  // 같은 대화에 mutation IPC가 두 번 들어오는 것(복원 버튼 중복 호출 등)만으로
  // 동시 변경이 열린다.
  //
  // token이 null이면 통제 대상이 아니라는 뜻이며(주입 없음 또는 workspace 없음),
  // release는 그대로 무시된다.
  acquireWorkspaceMutation({ purpose = null, runId = null, role = null, parentToken = null } = {}) {
    if (!this.mutationLease) return { ok: true, token: null };
    const workspace = this.meta.workspace;
    if (!workspace) return { ok: true, token: null };
    const got = this.mutationLease.acquire({
      resourceKind: "workspace",
      resourceId: workspace,
      holderId: this.sessionId,
      runId,
      role,
      purpose,
      parentToken,
    });
    if (got.ok) {
      // Stage D-B §23 — 소유권을 얻었다고 곧바로 변경해도 되는 것은 아니다.
      // 실제 변경 직전에 자원/행동 심사를 통과해야 한다. 심사는 소유권을 확보한
      // 뒤에 한다 — "lease를 든 상태에서 이 행동이 허용되는가"가 실제 질문이다.
      const adjudication = adjudicateAction(
        {
          resourceKind: RESOURCE_KINDS.WORKSPACE,
          action: ACTIONS.MUTATE,
          resourceId: workspace,
          requestedPermission: "workspace-write",
        },
        {
          permissionCap: "workspace-write",
          leaseHeld: true,
          checkpointProtected: this.professionalRun?.checkpointProtection === "protected",
        }
      );
      const admitted = admitAction(adjudication, { humanApprovalGranted: false });
      if (!admitted.ok) {
        // 사전 승인이 필요한 행동을 승인 없이 실행하지 않는다. 소유권은 돌려준다.
        this.mutationLease.release(got.token);
        return {
          ok: false,
          code: admitted.code,
          error: admitted.error || "이 작업은 사용자 승인이 필요합니다.",
        };
      }

      // Stage D-C — workspace 변경 소유권 획득도 provenance 사슬의 한 마디다(§26).
      // 기록 실패가 실행을 막지는 않는다(관측 실패 ≠ governance 실패).
      try {
        this.assuranceRun?.recordWorkspaceMutation({
          event: got.reentered ? "reentered" : "acquired",
          resourceId: workspace,
          holderId: this.sessionId,
          purpose,
          controlClass: adjudication.controlClass,
        });
      } catch {}
      return { ok: true, token: got.token, reentered: Boolean(got.reentered) };
    }
    // 내부 어휘(lease/holder/resourceId)를 사용자 표면으로 내보내지 않는다(Charter §9).
    const error = got.code !== "BUSY"
      ? "작업 폴더 변경 권한을 확인하지 못해 실행을 시작하지 않았습니다."
      : got.sameHolder
        ? "이 대화에서 이미 작업 폴더를 변경하고 있습니다. 그 작업이 끝난 뒤 다시 시도해 주세요."
        : "같은 작업 폴더를 다른 대화가 변경하고 있습니다. 그 작업이 끝난 뒤 다시 시도해 주세요.";
    return { ok: false, code: got.code, sameHolder: Boolean(got.sameHolder), error };
  }

  releaseWorkspaceMutation(token) {
    if (!token || !this.mutationLease) return false;
    return this.mutationLease.release(token) === true;
  }

  // 방이 닫힐 때 남은 소유권을 정리한다. 실행이 남아 있지 않은 경우에만.
  //
  // 중지(stop/cancel)는 subprocess 종료를 기다려 주지 않는다. 아직 파일을 쓰고
  // 있을 수 있는 writer의 소유권을 정리 편의로 먼저 풀면, 다른 대화가 그 틈에
  // 소유권을 얻어 잠시 동시에 workspace를 바꾸게 된다. 그래서 실행이 남아 있으면
  // 소유권을 그대로 둔다 — memory-only라 앱을 다시 켜면 사라지므로, 잘못 푸는 것보다
  // 남기는 쪽이 안전하다(fail-closed).
  releaseWorkspaceMutationsIfIdle() {
    if (this.activeRuns > 0 || this.specialistActive === true) return 0;
    return this.releaseAllWorkspaceMutations();
  }

  releaseAllWorkspaceMutations() {
    if (!this.mutationLease?.releaseAllFor) return 0;
    return this.mutationLease.releaseAllFor(this.sessionId);
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

  // Stage D-0 — workspace-write 일반 채팅 turn은 mutation 참여자다.
  // 전문 실행은 turn 단위가 아니라 실행 블록 전체(mutation~판정 구간)에서 소유권을
  // 쥐므로 여기서 다시 잡지 않는다(같은 room이라 재진입으로 통과하기도 한다).
  async respond(agent, context = {}, generation = this.generation) {
    const generalWorkspaceWrite =
      !context.specialist &&
      !context.discussionSummary &&
      !context.simplifyMeta &&
      this.meta.permissionMode === "workspace-write";
    if (!generalWorkspaceWrite) return this.runResponseTurn(agent, context, generation);

    const lease = this.acquireWorkspaceMutation({ purpose: "chat-turn" });
    if (!lease.ok) {
      this.appendSystem(lease.error);
      return { ok: false, stopReason: "WORKSPACE_BUSY", error: lease.error };
    }
    try {
      return await this.runResponseTurn(agent, context, generation);
    } finally {
      this.releaseWorkspaceMutation(lease.token);
    }
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
    } else if (context.consult) {
      // V1.5 역할 상담(CONSULT)은 읽기 전용 단일 응답이다(INV-3). 역할 cap과
      // 세션 권한, workspace-read 상한의 최솟값으로 강등된다 — Builder에게
      // 물어봐도 파일을 수정할 수 없고, 세션 권한보다 높은 권한을 얻는
      // 경로도 아니다(chat 권한 세션이면 chat 그대로).
      permissionMode = minPermissionMode(
        this.meta.permissionMode,
        "workspace-read",
        SPECIALIST_STAGE_CAPS[context.consult.stage] || "workspace-read"
      );
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
        consult: context.consult || null,
        broadcast: context.broadcast || null,
        handoff: context.handoff || null,
        // 전문 모드 실행 중에는 @멘션 호출을 끕니다. 구현·검토·기록이
        // 담당자 밖으로 새어 나가는 것을 막기 위해서입니다.
        mentionsEnabled: !context.discussion && !context.specialist && !context.discussionSummary && !context.simplifyMeta && !context.consult && mentionDepth < this.mentionChainLimit,
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
          // Stage C — canonical Frozen Task provenance(RUN-### + taskHash). transport
          // runId(r...)와 구분되는 lifecycle fact로, TaskManager가 만든 값만 전달한다.
          frozenTask: context.specialist?.frozenTask
            ? {
                runId: context.specialist.frozenTask.runId || null,
                taskHash: context.specialist.frozenTask.taskHash || null,
              }
            : null,
          // IPC 경계에서 최종 permissionMode를 다시 계산해 실제 invocation을 제한합니다.
          // 여기서는 기존 승인 재시도 계약을 유지한 요청값만 전달합니다.
          // 일반 채팅의 승인 재시도 계약은 유지한다. 실제 provider argv에서는
          // IPC 경계가 workspace-write가 아닌 autoApprove를 다시 차단한다.
          // 전문 실행만 stage cap을 이미 적용한 최종 권한으로 제한한다.
          autoApprove: context.specialist
            ? permissionMode === "workspace-write" && (agent.autoApprove || approvedRetry)
            : agent.autoApprove || approvedRetry,
          // Stage C — same-turn approval seam(provider-neutral). harness가 지원하면 실행 중
          // action 승인을 이 콜백으로 요청한다. 미지원 provider는 이 콜백을 무시하고 기존
          // approvalRequired -> whole-turn retry 경로를 그대로 쓴다.
          requestApproval: (req) => this.requestInteractiveApproval(agent, req, generation),
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

    // WAITING 전이가 "이 발화가 정지를 만들었다"를 기록할 수 있도록 id를 돌려준다.
    // 이게 없으면 재시작 뒤 Reviewer 지적을 되찾을 방법이 없다.
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
      ...(result.deliveries ? { deliveries: result.deliveries } : {}),
    });
    // 토론 모드는 자체 턴 오케스트레이션이 있으므로 멘션 호출을 만들지 않습니다.
    // 역할 상담(consult)도 단일 응답 계약이라 연쇄를 만들지 않습니다.
    if (!context.discussion && !context.specialist && !context.discussionSummary && !context.simplifyMeta && !context.consult) {
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
      messageId: appended?.id || null,
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

  // V1.5 직접 역할 호출(CONSULT) — 제안서 §7. 멘션은 Target이지 실행 승인이
  // 아니므로(INV-2) 읽기 전용 단일 응답만 만든다. Professional Run·Task·
  // Freeze를 만들지 않고 전문 FSM도 시작하지 않는다 — recordDiscussion처럼
  // 일반 턴으로 실행하고 역할 관점과 읽기 전용 계약만 프롬프트로 덧씌운다.
  // (specialist stage 턴은 harness가 professionalRunId를 요구하므로 run 없는
  // 상담을 stage 턴으로 보내면 fail-closed로 죽는다.)
  async consultRole({ roleId, stage, agent, agentConfig, roleLabel }) {
    if (this.discussionRequested || this.discussionActive) {
      return { ok: false, error: "토론이 진행 중에는 역할을 호출할 수 없습니다." };
    }
    if (this.isSpecialistLocked()) {
      return {
        ok: false,
        error: "전문 실행이 진행 중이거나 결정을 기다리고 있어 역할 상담을 시작할 수 없습니다.",
      };
    }
    const target = agent && agent.id ? this.findAgent(agent.id) : null;
    if (!target || !target.available || target.enabled === false) {
      return { ok: false, error: "이 역할의 담당 에이전트를 사용할 수 없습니다." };
    }
    const label = roleLabel || roleId;
    this.appendSystem(`@${target.id}가 ${label} 역할의 관점에서 답합니다. (읽기 전용 상담)`);
    const outcome = await this.scheduleResponse(target, {
      consult: { role: roleId, stage: stage || null, label },
      agentConfig,
    });
    if (!outcome) return { ok: false, cancelled: true };
    return outcome.ok
      ? { ok: true, messageId: outcome.messageId || null }
      : { ok: false, error: outcome.error || "역할 상담 응답에 실패했습니다." };
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

    // 호출별 turnBudget이 방 기본값보다 우선한다. 방 인스턴스는 세션 수명
    // 동안 캐시되므로 생성자 옵션만으로는 실행 중 길이 변경이 불가능하다.
    // 구조화 토론의 길이는 발언 수가 아니라 Protocol cycle 수가 결정한다.
    const budget = protocol
      ? protocol.totalTurns
      : clampDiscussionTurnBudget(options.turnBudget, this.discussionRunBudget);
    if (protocol) {
      this.appendSystem(
        `구조화 토론 시작 · ${protocol.presetName} Preset · ${pool.map((agent) => `@${agent.id}`).join(", ")} · ${protocol.cycleBudget}사이클(최대 ${budget}턴)`
      );
    } else {
      this.appendSystem(
        `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`
      );
    }

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
        const speaker = protocol ? speakerForTurn(protocol, turn) : null;
        const agent = protocol
          ? agentById.get(speaker.agentId)
          : pool[(turn - 1) % pool.length];
        const outcome = await this.scheduleResponse(agent, {
          discussion: protocol
            ? {
                turn,
                maxTurns: budget,
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
        if (!outcome?.ok) failures += 1;
        const signal = outcome?.discussionSignal || "CONTINUE";
        if (protocol) {
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
          // 구조화 토론에만 존재하는 additive 필드 — 예전 판은 무시한다.
          ...(protocol
            ? {
                protocol: {
                  presetId: protocol.presetId,
                  presetName: protocol.presetName,
                  cycleBudget: protocol.cycleBudget,
                  stepCount: protocol.stepCount,
                  cyclesCompleted: Math.floor(completed / protocol.stepCount),
                },
              }
            : {}),
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
      const cancelled = this.cancelSpecialist("중지를 눌러 ");
      if (cancelled.ok) return;
    }
    const hadWork = this.cancels.size > 0 || this.typingCounts.size > 0
      || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0;
    this.stopAllSilently();
    if (hadWork) this.appendSystem("응답을 중지했습니다.");
  }

  clear() {
    if (this.specialistActive || this.specialistResume) this.cancelSpecialist("세션을 비우며 ");
    this.stopAllSilently();
    this.messages = [];
    this.emit("reset");
  }

  stopAllSilently() {
    this.generation += 1;
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) {
      item.resolve(undefined);
      this.notifyLostTurn(item);
    }
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns.clear();
    this.turnStartedAt.clear();
    this.mentionsMuted = false;
    this.emitTurnState();
    // Stop/interject/reset로 turn을 중지하면 화면에 보이는 모든 승인 카드는 stale하다.
    // resolver를 부르기 전에 provider-neutral approval-resolved를 내보내 renderer가 카드를
    // dismiss하게 한다(same-turn action 승인 · legacy whole-turn 승인 공통). 이후 adapter가
    // 뒤늦게 AbortController를 abort해도 이미 settled라 중복 이벤트는 나오지 않는다.
    for (const [approvalId, resolve] of this.pendingApprovals) {
      this.emit("approval-resolved", { approvalId });
      resolve(false);
    }
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

module.exports = {
  ChatRoom,
  DEFAULT_DISCUSSION_RUN_BUDGET,
  DISCUSSION_TURN_BUDGET_MIN,
  DISCUSSION_TURN_BUDGET_MAX,
  clampDiscussionTurnBudget,
};


installSpecialistMethods(ChatRoom);
installDeterministicProfessionalRecorder(ChatRoom);
