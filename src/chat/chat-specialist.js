const path = require("node:path");
const { specialistPermissionMode } = require("./chat-argv");
const {
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
  phaseForNode,
} = require("../agora/professional-run");
const { TaskManager, hashText } = require("../agora/task-manager");
const { validateTaskContract } = require("../agora/task-contract-validator");
const { describeWorkspaceChanges } = require("../agora/workspace-diff");
// repairBuilderStatus가 직전 응답 본문을 상한 내에서 담아 보낼 때 사용.
const { boundedText } = require("./chat-prompt");
const {
  executionAxes: professionalExecutionAxes,
  buildProfessionalEvidencePayload,
} = require("./chat-professional-evidence");
// Stage D — Assurance & Governance. v1 계약은 legacy 모드로 그대로 흐른다.
const { AssuranceRun, MODES } = require("../agora/assurance/assurance-run");
const { readLineage: readRunLineage } = require("../agora/assurance/run-lineage");
// V1.5 System Journal — FSM 전이를 감사 이벤트로 매핑한다.
const {
  journalEventsForTransition,
  createJournalEvent,
} = require("../agora/professional-journal");
// V1.5 Stage 5 — Role-to-Role Handoff의 조합 검증·원장·identity 주입.
const {
  validateResultControl,
  consumeHandoff,
  settleHandoff,
  recoverHandoffLedgerForRoot,
  serializeHandoffLedger,
  createHandoffLedger,
  newInvocationId,
  surfaceRoleForContract,
  DEFAULT_HANDOFF_BUDGET,
} = require("../agora/interaction-contract");

// checkpoint 실패 taxonomy를 사용자가 이해할 수 있는 한국어 설명으로 바꿉니다.
// 원인 코드 자체(CHECKPOINT_*)는 evidence/Reviewer 판단에 그대로 쓰이므로
// 여기서는 표시용 설명만 제공합니다.
const CHECKPOINT_FAILURE_DESCRIPTIONS = Object.freeze({
  CHECKPOINT_GIT_FAILED: "Git 명령 실행에 실패했습니다. 저장소 상태를 확인해 주세요",
  CHECKPOINT_STORAGE_FAILED: "백업 파일을 저장하지 못했습니다. 디스크 공간과 폴더 권한을 확인해 주세요",
  CHECKPOINT_MANIFEST_FAILED: "백업 목록 파일을 기록하지 못했습니다. 디스크 공간과 권한을 확인해 주세요",
  CHECKPOINT_COPY_FAILED: "추적되지 않은 파일을 백업 폴더로 복사하지 못했습니다",
  CHECKPOINT_UNTRACKED_NOT_REGULAR: "일반 파일이 아닌 항목(심볼릭 링크 등)이 있어 백업할 수 없습니다",
  CHECKPOINT_UNKNOWN: "알 수 없는 이유로 백업에 실패했습니다",
});

function describeCheckpointFailure(reason) {
  return CHECKPOINT_FAILURE_DESCRIPTIONS[reason] || CHECKPOINT_FAILURE_DESCRIPTIONS.CHECKPOINT_UNKNOWN;
}

const SAFE_BLOCK_REASONS = new Set([
  "BLOCKED",
  "BUILDER_STATUS_MISSING",
  "BUILDER_STATUS_AMBIGUOUS",
  "FROZEN_TASK_CORRUPTED",
  "DIFF_UNAVAILABLE",
  "DIFF_COLLECTION_FAILED",
  "EVIDENCE_WRITE_FAILED",
  "PROMPT_BUDGET_EXCEEDED",
  "PROTOCOL_FINAL_MISSING",
  "RECOVERY_JOURNAL_WRITE_FAILED",
  "TRANSPORT_FAILED",
  "TIMED_OUT",
  "OUTPUT_LIMITED",
  "EXECUTION_BLOCKED",
  "EXECUTION_INTERRUPTED",
  "EXECUTION_INTERRUPTED_CHECKPOINTING",
  "USER_INTERRUPTED",
  "FIX_REQUIRED",
  "LIMIT_EXCEEDED",
  "INSUFFICIENT_EVIDENCE",
  "AMBIGUOUS_VERDICT",
  "PROFESSIONAL_RUN_WRITE_FAILED",
  "WORKFLOW_WRITE_FAILED",
  "RUN_STATE_WRITE_FAILED",
  "RECORDER_FAILED",
  "CHECKPOINT_CLEANUP_FAILED",
]);

// Task 파일 첨부 정보를 만듭니다. taskPath가 없으면 null을 돌려줍니다.
function taskFileInfo(taskPath) {
  return taskPath
    ? { relativePath: taskPath, filename: path.basename(taskPath) }
    : null;
}

function safeBlockReason(value) {
  const reason = String(value || "");
  return SAFE_BLOCK_REASONS.has(reason) ? reason : "EXECUTION_BLOCKED";
}

// 작업용 채팅에서는 캐릭터 이모티콘 이미지를 더 이상 렌더링하지 않습니다.
// 다만 예전 습관이나 실수로 에이전트가 [[CODEPET_EMOTE:...]] 표기를 남기면
// 화면에 제어 태그가 그대로 노출되지 않도록 텍스트에서만 조용히 제거합니다.
const EMOTICON_TAG_PATTERN = /\[\[CODEPET_EMOTE:[^\]\r\n]+\]\]/g;

// Archivist(사람용 정리)에 넘기는 System Journal 최근 사건 수. 프롬프트
// 예산을 넘지 않으면서 "무엇을 하기로→무엇이 바뀌었고→어떻게 확인했는지"의
// 최근 흐름을 담기에 충분한 창이다.
const ARCHIVIST_JOURNAL_WINDOW = 40;

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
  // "없음"이라고 답하면서 왜 없는지 덧붙이는 것이 자연스러운 글쓰기다. 예전에는
  // 문장 전체가 정확히 "없음"일 때만 비었다고 봤기 때문에, 검수자가
  // "없음. 위 항목은 기획자가 보완할 수 있습니다"라고 쓰면 그 설명을 사용자 질문으로
  // 오해해 자동 보완을 끄고 사용자 답변을 기다렸다. 지적이 전부 scope: IN이어도
  // 마찬가지였다. 앞머리가 부정이면 뒤에 무엇이 붙든 질문 없음으로 본다.
  //
  // 이 판정은 검증 통과 여부가 아니라 "자동 보완이냐 사용자냐"의 갈림길이다.
  // 과하게 막으면 사용자가 매번 손으로 풀어야 하고, 덜 막아도 다음 라운드에서
  // 검수자가 같은 지적을 다시 낼 수 있으므로(repeat 추적) 회복 가능하다.
  // 경계는 \b가 아니라 유니코드 lookahead로 본다. \b는 \w(=ASCII)만 알기 때문에
  // "없음." 뒤에서 경계를 찾지 못해 한글 부정 표현이 전부 통과하지 못했다.
  //
  // 부정 표현 앞에 괄호나 강조 표시가 붙는 것도 자연스러운 글쓰기다. 실제로
  // "(없음 — 사용자 결정이 필요한 사항은 없습니다)"라고 쓴 검수를 여는 괄호 하나
  // 때문에 질문으로 읽어, 결정할 것이 없다고 명시한 라운드에서 사용자를 세웠다.
  // 판정 전에 앞머리 장식을 걷어낸다(비었는지 판단은 원문 content로 한다).
  const opening = content.replace(/^[\s([{<"'*_`「『“‘]+/u, "");
  if (/^(?:없음|없습니다|없다|해당\s*없음|특이사항\s*없음|none|n\/?a)(?![\p{L}\p{N}])/iu.test(opening)) {
    return false;
  }
  return content.length > 0;
}

// Plan Reviewer의 다음 라운드에는 자유 서술이 아니라 추적 가능한 ISSUES
// 블록만 다시 준다. repeat: YES/NO 관찰의 기준도 이 텍스트다.
function structuredIssuesFromReview(text) {
  const source = String(text || "");
  const marker = /^ISSUES:\s*/im.exec(source);
  if (!marker) return "";
  const tail = source.slice((marker.index || 0) + marker[0].length);
  const end = tail.search(/^(?:#{1,6}\s+open\s+questions?|VERDICT:|STATUS:|\[\[CODEPET_)/im);
  return (end >= 0 ? tail.slice(0, end) : tail).trim();
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



function runGeneratedPaths(workspace, runInfo) {
  if (!workspace || !runInfo?.runDir) return [];
  const relativeRun = path.relative(workspace, runInfo.runDir);
  if (!relativeRun || relativeRun.startsWith("..")) return [];
  return ["task.md", "task-hash", "evidence.json", "invalid.json", "result.json", "block.json"]
    .map((name) => path.join(relativeRun, name));
}

class SpecialistMixin {
  setProfessionalRun(run) {
    if (this.persistProfessionalRun) {
      try {
        if (this.persistProfessionalRun(run) === false) return false;
      } catch {
        return false;
      }
    }
    this.professionalRun = run;
    this.emitSpecialistState();
    return true;
  }

  transitionProfessional(event) {
    if (!this.professionalRun) return { ok: true, state: null };
    const prevRun = this.professionalRun;
    const prevStatus = prevRun.status || null;
    const transition = transitionProfessionalRun(this.professionalRun, event);
    if (!transition.ok) return transition;
    if (!this.setProfessionalRun(transition.state)) {
      return { ok: false, reason: "전문 실행 상태를 저장하지 못했습니다." };
    }
    this.journalProfessionalTransition(prevRun, event, transition.state);
    this.notifyProfessionalRunBoundary(event, prevStatus, transition.state);
    return transition;
  }

  // V1.5 System Journal — 이벤트 저장의 공용 seam. FSM 전이뿐 아니라 Role
  // Invocation·Handoff 같은 FSM 밖의 사건도 이 한 곳을 지나 기록된다(§10).
  // FSM 저장과 달리 Journal 실패는 실행을 멈추지 않는다: snapshot(meta.json)이
  // 현재 상태의 기준이고 Journal은 감사 기록이다. 다만 실패를 성공으로 숨기지
  // 않도록 세션당 한 번 시스템 메시지로 알린다(§10.4).
  recordJournalEntries(entries) {
    if (typeof this.appendProfessionalEvent !== "function") return;
    for (const entry of entries || []) {
      if (!entry) continue;
      let saved = false;
      try {
        saved = this.appendProfessionalEvent(entry) !== false;
      } catch {
        saved = false;
      }
      if (!saved && !this.journalWriteFailureNotified) {
        this.journalWriteFailureNotified = true;
        this.appendSystem(
          "전문 실행 기록(System Journal)을 저장하지 못했습니다. 실행은 계속되지만 이 세션의 감사 기록이 불완전할 수 있습니다."
        );
      }
    }
  }

  // FSM 밖의 단건 사건(예: CONSULT의 ROLE_STARTED/ROLE_FINISHED, 향후
  // HANDOFF_REQUESTED)을 기록한다. §10.3 어휘 밖의 type은 조용히 버려진다.
  recordJournalEvent(fields) {
    if (typeof this.appendProfessionalEvent !== "function") return;
    let entry = null;
    try {
      entry = createJournalEvent({ sessionId: this.sessionId || null, ...fields });
    } catch {
      entry = null;
    }
    if (entry) this.recordJournalEntries([entry]);
  }

  // === V1.5 Stage 5 — Role-to-Role Handoff 소비 seam ===
  //
  // 결과 축(STATUS/VERDICT)과 routing 축(HANDOFF/COMPLETE/ASK_USER)은
  // 우선순위 관계가 아니라 독립 계약이다. 모든 결정 지점(기획/기획검수/
  // 구현/검토)이 consumeControlRequest 한 곳을 지나 조합 검증 → 구조 검증
  // → 원장 소비 → fail-closed 영속 → Journal 순으로 처리한다. 수용돼도
  // 실행 전제조건 검증(호출부의 기존 FSM·Freeze·승인 게이트)은 그대로다.

  // 현재 root 사용자 발화 기준의 Handoff 원장을 확보한다. 같은 root의
  // 살아 있는 원장은 그대로 재사용하고(재복원 금지 — active invocation
  // 폐기 방지), root가 바뀌면(새 사용자 지시) 새 budget epoch를 연다.
  // 저장된 handoffState가 같은 root면 crash recovery 규칙과 함께 복원한다.
  // 현재 budget epoch의 root = 가장 최근 사용자 발화 id.
  currentHandoffRootId() {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].authorType === "user") return this.messages[i].id || null;
    }
    return null;
  }

  // 현재 실행 정책이 요구하는 budget. auto/full의 정상 흐름은 라운드마다
  // builder↔reviewer handoff를 2회 소비하므로(기획 hop 포함), 기본 8만으로는
  // 다회차 보완에서 예산이 소진돼 마지막 reviewer→recorder(Archivist)
  // 요청까지 거부된다. 이 budget은 FSM 자체를 막지 못하고 overlay 기록만
  // 좌우하므로, 정상 라운드 수를 담도록 스케일한다.
  scaledHandoffBudget() {
    const policy = this.professionalRun?.policy || {};
    const revisions =
      (Number.isInteger(policy.planAutoRevisions) ? policy.planAutoRevisions : 0) +
      (Number.isInteger(policy.implementationAutoRevisions) ? policy.implementationAutoRevisions : 0);
    return DEFAULT_HANDOFF_BUDGET + 2 * revisions;
  }

  // handoff 연쇄가 끊긴 지점(control 없음·거부·재기획)에서 연속-동일-대상
  // 가드의 기준(lastTargetRole)을 비우고 영속한다. in-memory만 비우면 재시작
  // 복원이 stale 값을 되살려 정당한 다음 handoff가 HANDOFF_REPEAT로 거짓 거부된다.
  breakHandoffChain() {
    const ledger = this.handoffLedger;
    if (!ledger || !ledger.lastTargetRole) return false;
    ledger.lastTargetRole = null;
    this.persistHandoffState(null);
    return true;
  }

  // 같은 root(사용자 발화)에서 전문 실행을 다시 시작할 때 in-memory 원장을
  // 새 run으로 이월한다. 안 하면 새 run의 handoffState(권위)는 null인데
  // in-memory used는 누적돼 authority와 어긋나고, 재시작 복원도 그 사이를
  // 잃는다. 재기획은 handoff 연쇄를 끊으므로 active 슬롯과 lastTargetRole은 비운다.
  carryHandoffStateForFreshRun() {
    const ledger = this.handoffLedger;
    if (!ledger || ledger.rootMessageId !== this.currentHandoffRootId()) return null;
    ledger.activeInvocationId = null;
    ledger.lastTargetRole = null;
    return serializeHandoffLedger(ledger);
  }

  // NEEDS_DECISION 제어 응답에서 기획자 질문 본문을 추출한다. FSM 전이
  // (PLANNER_NEEDS_DECISION)에 pendingQuestion으로 실어 영속하고, 재시작
  // 뒤 resumeForWaitingPlan이 이 값을 되찾는 데도 쓴다.
  plannerQuestionFrom(controlResult) {
    return controlResult?.accepted && controlResult?.control?.action === "ASK_USER"
      ? controlResult.control.question
      : null;
  }

  // NEEDS_DECISION 재개 시 기획자가 자기 질문을 볼 수 있게 feedback에 남긴다.
  // 질문은 제어 줄(ASK_USER)에만 있었고 그 줄은 텍스트에서 strip되므로, 여기서
  // 붙이지 않으면 재개된 기획자는 "무엇을 물었는지" 모른 채 답만 받는다.
  withPlannerQuestion(feedback, controlResult) {
    const question = this.plannerQuestionFrom(controlResult);
    if (!question) return feedback;
    return `${feedback || ""}\n\n=== 기획자 질문 ===\n${question}\n=== 기획자 질문 끝 ===`;
  }

  ensureHandoffLedger() {
    const root = this.currentHandoffRootId();
    if (!root) return null;
    const scaledBudget = this.scaledHandoffBudget();
    if (this.handoffLedger && this.handoffLedger.rootMessageId === root) {
      // 같은 root를 재사용할 때도 정책이 커졌으면(기획 후 구현 버튼에서
      // 자동보완을 올린 경우) budget을 따라 올린다 — 기획 시점 정책으로
      // 고정되면 구현 단계의 정상 hop이 예산을 넘어 Archivist 요청이 거부된다.
      if (this.handoffLedger.budget < scaledBudget) this.handoffLedger.budget = scaledBudget;
      return this.handoffLedger;
    }
    const persisted = this.professionalRun?.handoffState || null;
    const restored = recoverHandoffLedgerForRoot(persisted, root, { budget: scaledBudget });
    if (!restored.ok) return null;
    if (restored.interruptedInvocationId) {
      this.recordJournalEvent?.({
        type: "HANDOFF_REJECTED",
        status: "INTERRUPTED",
        purpose: "crash_recovery",
        invocationId: restored.interruptedInvocationId,
        professionalRunId: this.professionalRun?.professionalRunId || null,
      });
    }
    this.handoffLedger = restored.ledger;
    return this.handoffLedger;
  }

  // Handoff 원장의 fail-closed 영속화. Journal이 아니라 이 경로
  // (professionalRun.handoffState → persistProfessionalRun)가 budget·소비
  // 기록의 authority다. persist 실패 시 in-memory 원장을 소비 전 상태로
  // 되돌리고 false를 돌려준다.
  persistHandoffState(previousSerialized) {
    if (!this.professionalRun) return true;
    const next = {
      ...this.professionalRun,
      handoffState: serializeHandoffLedger(this.handoffLedger),
      updatedAt: Date.now(),
    };
    if (this.setProfessionalRun(next)) return true;
    if (previousSerialized) {
      this.handoffLedger = createHandoffLedger(previousSerialized);
    }
    return false;
  }

  // incoming Handoff lifecycle 정리. 수용된 invocation은 "다음 control이
  // 나와서"가 아니라 대상 역할의 실행이 실제로 끝났을 때 settle된다 —
  // outgoing control과는 독립 축이다. 결정 지점 도달(=직전 역할의 결과
  // 확정)과 Archivist 종료 지점에서 호출한다. settle은 budget 소비가 아닌
  // 슬롯 해제라 영속 실패가 흐름을 막지 않으며, in-memory 원장을 되돌리지
  // 않고 다음 영속 기회에 함께 저장되게 둔다(persistHandoffState(null)).
  // (재시작으로 죽은 슬롯은 ensureHandoffLedger의 recovery가 처리한다.)
  settleIncomingHandoff() {
    const ledger = this.handoffLedger;
    if (!ledger?.activeInvocationId) return false;
    if (!settleHandoff(ledger, ledger.activeInvocationId)) return false;
    this.persistHandoffState(null);
    return true;
  }

  // 결과 축 × routing 축 소비. control이 없으면 requested:false — 기본
  // FSM 흐름이 그대로 진행된다(하위 호환). 거부는 조용히 넘기지 않는다.
  consumeControlRequest({ contract, result, outcome }) {
    // 결정 지점 도달 = 이 역할의 결과가 확정됐다는 뜻. 이 역할을 향해
    // 수용됐던 invocation을 control 유무·종류와 무관하게 먼저 settle한다.
    // (control이 없거나 COMPLETE/ASK_USER로 끝나는 정상 완료가 슬롯을
    // 남기면, 재시작 recovery가 정상 완료를 INTERRUPTED로 기록하게 된다.)
    this.settleIncomingHandoff();
    const control = outcome?.controlRequest || null;
    if (!control) {
      // control 없이 끝난 결정 지점은 handoff 연쇄를 끊는다(자동 보완 루프에서
      // 검토자가 handoff 줄을 생략한 경우 등) — 비우고 영속한다.
      this.breakHandoffChain();
      return { requested: false, accepted: false, control: null };
    }
    const professionalRunId = this.professionalRun?.professionalRunId || null;
    const frozenRunId = this.professionalRun?.frozenRunId || null;
    // 원장/구조 거부(예산·연속·중복·동시성)는 FSM이 흐름의 authority인
    // V1.5에서 사용자가 조치할 수 없는 overlay 내부 사정이다 — Journal에만
    // 남기고 사용자 메시지는 억제한다. 결과와 어긋난 조합(CONTROL_NOT_ALLOWED
    // 등)은 모델이 스스로 모순된 것이므로 안내를 남긴다.
    const SILENT_REJECT_REASONS = new Set([
      "HANDOFF_BUDGET_REACHED",
      "HANDOFF_SELF",
      "HANDOFF_REPEAT",
      "HANDOFF_DUPLICATE",
      "HANDOFF_BUSY",
      "HANDOFF_STALE",
    ]);
    const reject = (reason) => {
      this.recordJournalEvent?.({
        type: "HANDOFF_REJECTED",
        role: control.targetRole || null,
        purpose: control.action || null,
        reason: control.reason || null,
        status: reason,
        professionalRunId,
        frozenRunId,
      });
      // 거부된 요청도 연쇄를 끊는다 — 이 역할은 인계하지 못했다.
      this.breakHandoffChain();
      // 원장 거부라도 수용 여부가 실제 행동을 바꾸는 대상(재기획 @planner,
      // Archivist @recorder)이면 사용자에게 알린다 — 무음이면 "검토자가
      // 재기획을 요청했는데 보완이 계속됨/정리가 조용히 생략됨"이 보이지 않는다.
      const behaviorAffecting = ["planner", "recorder"].includes(control.targetRole);
      if (!SILENT_REJECT_REASONS.has(reason) || behaviorAffecting) {
        this.appendSystem(
          `역할의 ${control.action || "제어"} 요청을 수용하지 않았습니다(${reason}). 기본 흐름으로 계속합니다.`
        );
      }
      return { requested: true, accepted: false, reason, control };
    };
    const combo = validateResultControl({ contract, result, control });
    if (!combo.ok) return reject(combo.reason);
    if (control.action !== "HANDOFF") {
      // ASK_USER/COMPLETE는 다음 역할 호출이 아니므로 원장을 소비하지
      // 않는다. 실제 완료/사용자 반환은 호출부의 기존 경로가 수행한다.
      // 프롬프트가 질문·요약을 본문이 아니라 제어 줄에 담게 하므로(그리고
      // 그 줄은 화면에서 strip된다), 여기서 사용자에게 다시 노출하지 않으면
      // NEEDS_DECISION 질문이 조용히 사라진다.
      if (control.action === "ASK_USER" && control.question) {
        this.appendSystem(`역할이 사용자 결정을 요청했습니다: ${control.question}`);
      } else if (control.action === "COMPLETE" && control.summary) {
        this.appendSystem(`역할이 완료를 선언했습니다: ${control.summary}`);
      }
      return { requested: true, accepted: true, reason: null, control };
    }
    const ledger = this.ensureHandoffLedger();
    if (!ledger) return reject("HANDOFF_ROOT_REQUIRED");
    const previousSerialized = serializeHandoffLedger(ledger);
    // identity는 Runtime이 주입한다 — 모델 출력에서 받는 것은 targetRole·
    // purpose·reason뿐이다.
    const request = {
      sourceRole: surfaceRoleForContract(contract),
      targetRole: control.targetRole,
      invocationId: newInvocationId(),
      professionalRunId,
      generation: this.generation,
    };
    const structural = consumeHandoff(request, {
      ledger,
      professionalRunId,
      generation: this.generation,
    });
    if (!structural.ok) return reject(structural.reason);
    if (!this.persistHandoffState(previousSerialized)) {
      return reject("HANDOFF_STATE_WRITE_FAILED");
    }
    this.recordJournalEvent?.({
      type: "HANDOFF_ACCEPTED",
      role: control.targetRole,
      purpose: control.purpose || null,
      // 프롬프트가 가르치는 것은 REASON이다 — 그 근거를 감사 이력에 남긴다.
      reason: control.reason || null,
      invocationId: structural.invocationId,
      professionalRunId,
      frozenRunId,
    });
    return { requested: true, accepted: true, reason: null, control, invocationId: structural.invocationId };
  }

  // FSM 전이 이벤트 발행. transitionProfessional 단일 seam에서만 호출된다.
  journalProfessionalTransition(prevRun, event, nextRun) {
    if (typeof this.appendProfessionalEvent !== "function") return;
    let entries = [];
    try {
      entries = journalEventsForTransition(prevRun, event, nextRun, {
        sessionId: this.sessionId || null,
      });
    } catch {
      entries = [];
    }
    this.recordJournalEntries(entries);
  }

  // Stage C — canonical terminal transition에서만 harness lifecycle에 run 종료를
  // 알린다(중복 UI handler 산개 금지: FSM 전이 단일 seam). COMPLETED/INTERRUPTED는
  // 정상 종료(RETIRE), INVALID는 실행 신뢰 붕괴(INVALIDATE), REPLAN_RESET은 기존
  // 실행 lineage 폐기(RETIRE)다. WAITING/BLOCKED는 사용자 결정 대기이므로 lifecycle
  // boundary가 아니다.
  notifyProfessionalRunBoundary(event, prevStatus, next) {
    if (!this.harnessLifecycle?.professionalRunEnded || !next?.professionalRunId) return;
    const eventType = String(event?.type || "").toUpperCase();
    const terminal =
      eventType === "REPLAN_RESET" ||
      (["COMPLETED", "INTERRUPTED", "INVALID"].includes(next.status) && next.status !== prevStatus);
    if (!terminal) return;
    this.harnessLifecycle.professionalRunEnded({
      professionalRunId: next.professionalRunId,
      invalid: next.status === "INVALID",
    });
  }

  // Stage C — checkpoint restore 결과를 harness lifecycle에 반영한다(restore 소비
  // 지점이 호출; turn-checkpoint 모듈은 lifecycle을 모른다). 성공한 restore는 HEAD가
  // 같아도 filesystem rewind이므로 반드시 INVALIDATE(WORKSPACE_RESTORED) 대상이고,
  // mutation이 시작됐을 수 있는 ambiguous 실패도 보수적으로 동일하게 처리한다.
  // mutation 전에 명확히 끝난 실패(mutated === false)만 기존 세션을 유지한다.
  notifyWorkspaceRestoreOutcome(result) {
    if (!this.harnessLifecycle?.workspaceRestored) return;
    if (result?.ok === true || result?.mutated !== false) {
      this.harnessLifecycle.workspaceRestored();
    }
  }

  professionalTransitionFailure(stage, transition) {
    const error = transition?.reason || "전문 실행 상태를 저장하지 못했습니다.";
    this.appendSystem(`전문 실행 상태를 저장하지 못해 다음 단계를 시작하지 않았습니다. (${error})`);
    return {
      ok: false,
      stage,
      needsUserDecision: true,
      stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
      error,
    };
  }

  // Workflow 인덱스의 canonical Task 상태를 갱신합니다.
  //
  // taskPath가 없으면 갱신할 대상이 없으므로 true를 반환하지만, Run에 연결된
  // 실행 상태(activeRunId/lastRunId)를 기록하려는 호출에서 taskPath가 비어
  // 있다면 그것은 실행 context가 유실되었다는 신호다. 이 경우 조용히 성공으로
  // 넘기면 workflow 인덱스가 갱신되지 않은 사실이 감춰지므로 fail-closed로
  // 막는다(예: checkpoint 재시도 재개에서 taskInfo가 유실된 경우).
  updateProfessionalTaskState(patch) {
    if (!this.onProfessionalTaskState) return true;
    if (!patch?.taskPath) {
      const carriesRunState = Boolean(patch && (patch.activeRunId || patch.lastRunId));
      if (carriesRunState) return false;
      return true;
    }
    const taskHash =
      patch.taskHash ||
      this.professionalRun?.approvedTaskHash ||
      this.professionalPlan?.taskInfo?.hash ||
      null;
    try {
      return this.onProfessionalTaskState({ ...patch, taskHash }) !== false;
    } catch {
      return false;
    }
  }

  // action별 stages는 그 실행에 필요한 역할만 담는다(plan은 기획·기획검수,
  // implementation은 구현·검토·기록). 그래서 어느 하나만 보면 역할이 빈다:
  // PLAN -> 실행 순서로 간 뒤 구현이 BLOCKED되면 specialistStages에 기획자가 없어
  // 재기획이 "기획·검수 담당자를 지정해 주세요"로 거부됐다(프로젝트 설정과 무관하게).
  // 셋을 겹쳐서 어느 단계에서 남긴 역할이든 살아 있게 한다. 나중 것이 우선한다.
  // 실행 시작 시점에 저장된 stages 스냅샷에서 기획·기획검수 담당자만 현재 프로젝트
  // 설정으로 다시 조회해 바꾼다. 재개(기획 답변·WAITING 복원·재기획) 경로에서 쓴다.
  // refresher가 없거나 조회 실패(false)면 스냅샷을 그대로 둔다 — 설정 저장소를 모르는
  // 테스트/임베더가 깨지지 않도록 하는 낙진 방어다. 구현·검토·기록 담당자는 실행이
  // 이미 승인된 계약을 이어가는 단계라 바꾸지 않고, 기획만 재조회한다.
  refreshPlanStages(stages) {
    const current = stages && typeof stages === "object" ? { ...stages } : {};
    if (typeof this.planStagesRefresher !== "function") return current;
    let refreshed = null;
    try {
      refreshed = this.planStagesRefresher();
    } catch {
      return current;
    }
    if (!refreshed || typeof refreshed !== "object") return current;
    if (refreshed.planner?.agent) current.planner = refreshed.planner;
    if (refreshed.planReview?.agent || refreshed.review?.agent) {
      current.planReview = refreshed.planReview || refreshed.review;
    }
    return current;
  }

  stagesForSpecialist() {
    const merged = {
      ...(this.specialistResume?.stages || {}),
      ...(this.professionalRun?.stages || {}),
      ...(this.specialistStages || {}),
    };
    return Object.keys(merged).length > 0 ? merged : null;
  }

  async withProfessionalAuthorization(authorization = "workspace-write", fn) {
    const prev = this.activeRunAuthorization;
    this.activeRunAuthorization = authorization || "workspace-write";
    try {
      return await fn();
    } finally {
      this.activeRunAuthorization = prev;
      // 모든 전문 실행 진입점이 이 래퍼를 지난다. 진입점마다 따로 붙이면
      // resumeSpecialist·replanBlocked처럼 빠지는 경로가 생기므로 여기 한 곳에 둔다.
      // 중첩 호출(예: builder status 교정)에서는 specialistActive가 켜져 있어 no-op다.
      this.settleStrandedProfessionalRun();
    }
  }

  rehydrateRecovery(recovery) {
    if (!recovery || typeof recovery !== "object") return null;
    const checkpoint = recovery.checkpointId
      ? {
          supported: true,
          checkpointId: recovery.checkpointId,
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: recovery.runId || null,
        }
      : null;
    let canRestore = false;
    if (checkpoint && this.checkpointEngine) {
      try {
        const inspected = typeof this.checkpointEngine.inspectCheckpoint === "function"
          ? this.checkpointEngine.inspectCheckpoint(checkpoint)
          : null;
        canRestore = inspected ? inspected.ok === true : Boolean(checkpoint.supported);
      } catch {
        canRestore = false;
      }
    }
    const reason = safeBlockReason(recovery.blockReason || (
      recovery.status === "checkpointing"
        ? "EXECUTION_INTERRUPTED_CHECKPOINTING"
        : "EXECUTION_INTERRUPTED"
    ));
    return {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: recovery.taskPath || null,
      runId: recovery.runId || null,
      stage: recovery.stage || "implementation",
      blockReason: reason,
      recoveryStatus: recovery.status || "interrupted",
    };
  }

  recoveryFromProfessionalRun(run = this.professionalRun) {
    if (!run || typeof run !== "object") return null;
    const status = String(run.status || "").toUpperCase();
    const isActNode = ["IMPLEMENTING", "REVIEWING", "RECORDING"].includes(String(run.node || "").toUpperCase());
    const needsRecovery = Boolean(run.checkpointId) || ["BLOCKED", "INVALID"].includes(status) || (status === "INTERRUPTED" && isActNode);
    if (!needsRecovery) return null;
    const node = String(run.node || "IMPLEMENTING").toLowerCase();
    const stage = node === "planning" ? "planner"
      : node === "plan_review" ? "plan_review"
      : node === "reviewing" ? "review"
      : node === "recording" ? "recorder"
      : "implementation";
    return {
      schemaVersion: 1,
      status: status === "COMPLETED" ? "completed" : status === "INVALID" ? "invalid" : status === "BLOCKED" ? "blocked" : "interrupted",
      checkpointId: run.checkpointId || null,
      runId: run.frozenRunId || null,
      taskPath: run.taskPath || null,
      stage,
      blockReason: run.blockReason || run.stopReason || null,
      updatedAt: run.updatedAt || Date.now(),
    };
  }

  checkpointForProfessionalRun(run = this.professionalRun) {
    if (!run?.checkpointId) return null;
    return {
      supported: true,
      checkpointId: run.checkpointId,
      storageRoot: this.checkpointRoot,
      sessionId: this.sessionId,
      runId: run.frozenRunId || null,
    };
  }

  persistRecoveryState(recovery) {
    // 전문 실행(v3)은 별도 pendingRecovery가 아니라 한 개의
    // professionalRun journal에 checkpoint 참조를 함께 보관한다. legacy
    // step/auto/quick만 기존 recovery field를 계속 사용한다.
    if (this.professionalRun) {
      const next = { ...this.professionalRun };
      if (recovery === null) {
        next.checkpointId = null;
      } else {
        if (recovery.checkpointId) next.checkpointId = recovery.checkpointId;
        if (recovery.runId) next.frozenRunId = recovery.runId;
        if (recovery.taskPath) next.taskPath = recovery.taskPath;
      }
      if (!this.setProfessionalRun(next)) return false;
      // v2에서 옮겨 온 오래된 저널은 한 번만 비운다. null 기록은 호환
      // 정리이며 새 v3 recovery 데이터를 쓰는 경로는 아니다.
      if (!this.persistRecovery) return true;
      try {
        return this.persistRecovery(null) !== false;
      } catch {
        return false;
      }
    }
    if (!this.persistRecovery) return true;
    try {
      return this.persistRecovery(recovery) !== false;
    } catch {
      return false;
    }
  }

  recoveryFor(checkpoint, {
    status = "running",
    runId = null,
    taskPath = null,
    stage = "implementation",
    blockReason = null,
  } = {}) {
    return {
      schemaVersion: 1,
      status,
      checkpointId: checkpoint?.checkpointId || null,
      runId: runId || null,
      taskPath: taskPath || null,
      stage,
      ...(blockReason ? { blockReason: safeBlockReason(blockReason) } : {}),
      updatedAt: Date.now(),
    };
  }

  clearRecoveryState() {
    this.persistRecoveryState(null);
  }

  markCheckpointRecovery(checkpoint, options = {}) {
    const persisted = this.persistRecoveryState(this.recoveryFor(checkpoint, options));
    return persisted;
  }

  validateFrozenTask(runInfo) {
    // Legacy/manual specialist calls may not have a Planner-backed Run. They
    // retain the pre-existing behavior; every actual Run is checked below.
    if (!runInfo) return { ok: true, frozen: null };
    if (!runInfo.runDir || !this.taskManager?.readFrozenTask) {
      return { ok: false, error: "Frozen Task 경로가 없습니다." };
    }
    if (typeof runInfo.taskHash !== "string" || !runInfo.taskHash.trim()) {
      return { ok: false, error: "최초 Run의 Frozen Task 해시가 없습니다." };
    }
    if (this.taskManager.isRunInvalid?.(runInfo)) {
      return { ok: false, error: "이 Run은 이미 무효화되었습니다." };
    }
    try {
      const frozen = this.taskManager.readFrozenTask(runInfo.runDir, runInfo.taskHash);
      runInfo.content = frozen.content;
      runInfo.taskHash = frozen.taskHash;
      return { ok: true, frozen };
    } catch (error) {
      return { ok: false, error: error?.message || "Frozen Task를 검증하지 못했습니다." };
    }
  }

  persistBlockedRun({ runInfo, taskInfo, stage, round, stopReason, result = null, changes = null } = {}) {
    if (!runInfo?.runDir || !this.taskManager) return true;
    const snapshot = changes || result?.changes || null;
    const rawText = String(snapshot?.text || "");
    const included = rawText.slice(0, 12000);
    const diffStatus = snapshot?.diff?.status || snapshot?.status || "CHANGED";
    const blockSaved = this.taskManager.writeRunBlock?.(runInfo, {
      stage,
      reason: stopReason,
      builderStatus: result?.builderStatus || result?.declaration || "BLOCKED",
      changes: {
        status: diffStatus,
        originalChars: rawText.length,
        includedChars: included.length,
        truncated: included.length < rawText.length,
        text: included,
      },
      axes: result?.axes || {},
    }) !== false;
    const resultSaved = this.taskManager.writeRunResult?.(runInfo, {
      status: "BLOCKED",
      stopReason,
      round,
    }) !== false;
    const workflowSaved = this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      taskHash: runInfo?.taskHash || taskInfo?.hash || null,
      status: "blocked",
      // 사용자가 keep/restore/replan을 아직 고르지 않았으므로 이 Run은
      // workflow 상에서도 계속 활성 상태다. 선택이 끝난 뒤 lastRunId로
      // 옮긴다.
      activeRunId: runInfo.runId,
      lastRunId: null,
    });
    if (!blockSaved || !resultSaved || !workflowSaved) {
      this.appendSystem("실행 중단 상태를 일부 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.");
    }
    return blockSaved && resultSaved && workflowSaved;
  }

  holdForFrozenTaskCorruption({ runInfo, taskInfo, checkpoint, stage = "implementation", round = 1, error = "" } = {}) {
    const reason = "FROZEN_TASK_CORRUPTED";
    this.transitionProfessional({ type: "INVALIDATE", stopReason: reason });
    if (runInfo && this.taskManager?.markRunInvalid) {
      this.taskManager.markRunInvalid(runInfo, reason);
    }
    this.persistBlockedRun({ runInfo, taskInfo, checkpoint, stage, round, stopReason: reason });
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "invalid",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: reason,
    }));
    this.specialistBlocked = {
      checkpoint: checkpoint?.supported === true ? checkpoint : null,
      canRestore: Boolean(checkpoint?.supported === true),
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: reason,
      recoveryStatus: "invalid",
    };
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(`Frozen Task가 손상되어 실행을 중단했습니다. 변경은 그대로 남아 있습니다. (${error || "해시 불일치"})`);
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason: reason,
      blocked: true,
      canRestore: Boolean(checkpoint?.supported === true),
    };
  }

  holdForDegradedReview({ runInfo, taskInfo, checkpoint, stage = "review", round = 1, changes = null, review = null } = {}) {
    const reason = "DIFF_UNAVAILABLE";
    this.transitionProfessional({ type: "HOLD_BLOCKED", stopReason: reason, blockReason: reason });
    const canRestore = Boolean(checkpoint?.supported === true);
    this.persistBlockedRun({
      runInfo,
      taskInfo,
      checkpoint,
      stage,
      round,
      stopReason: reason,
      changes,
    });
    this.specialistBlocked = {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: reason,
    };
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "blocked",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: reason,
    }));
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(
      canRestore
        ? "Git diff를 사용할 수 없어 현재 파일을 기준으로 검수했습니다. PASS 결과를 자동 완료로 처리하지 않고 사용자 확인을 기다립니다."
        : "Git diff를 사용할 수 없어 현재 파일을 기준으로 검수했습니다. PASS 결과를 자동 완료로 처리하지 않고 사용자 확인을 기다립니다. (자동 복원은 지원되지 않습니다)"
    );
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason: reason,
      blocked: true,
      canRestore,
      changes,
      review,
    };
  }

  // PLANNING / PLAN_REVIEW 가 WAITING인 상태의 specialistResume를 재구성한다.
  //
  // 예전에는 READY 노드만 복원해서, 답변 대기 상태로 앱을 껐다 켜면 입력칸은
  // 열리는데(needsInput은 professionalRun만 본다) _answerPlanQuestion이
  // specialistResume.phase를 요구해 답변이 거부됐다. 화면과 백엔드가 어긋나
  // 사용자는 그동안 쌓인 검수 맥락을 잃었다.
  //
  // 생성자(앱 재시작)와 TASK_CHANGED_AFTER_REVIEW 전이 양쪽에서 쓴다.
  // 한쪽만 채우면 "재시작해야만 입력이 작동하는" 상태가 새로 생긴다.
  resumeForWaitingPlan() {
    const run = this.professionalRun;
    if (!run || run.status !== "WAITING") return null;
    if (run.node !== "PLANNING" && run.node !== "PLAN_REVIEW") return null;

    const policy = run.policy || {};
    // action이 빠지면 원래 "전체 실행"이던 작업이 답변 후 PLAN에서 멈춘다
    // (_answerPlanQuestion이 resume.action === "full"을 본다). ProfessionalRun에
    // 새 필드를 넣을 필요는 없다 — policy.autoContinueReady가 이미 그 값이다.
    const action = policy.autoContinueReady ? "full" : "plan";
    const implementationAutoRevisions = policy.implementationAutoRevisions || 0;
    const mode = action === "full" || implementationAutoRevisions > 0 ? "auto" : "step";

    let taskContent = "";
    if (run.taskPath) {
      try {
        taskContent = this.taskManager?.resolveTaskContract?.(
          { contentSource: "file", taskPath: run.taskPath },
          this.meta.workspace
        )?.content || "";
      } catch {}
    }

    const isPlanning = run.node === "PLANNING";
    const changedAfterReview = run.stopReason === "TASK_CHANGED_AFTER_REVIEW";
    let feedback = this.waitingPlanFeedback({ run, isPlanning, changedAfterReview, taskContent });
    // 재시작 복원: NEEDS_DECISION의 질문 본문은 제어 줄이 strip되어
    // messages로 남지 않으므로 run.pendingQuestion으로 되찾는다. 이 필드가
    // 없던 옛 세션(null)은 기존 fallback 그대로 둔다.
    if (isPlanning && run.pendingQuestion) {
      feedback = this.withPlannerQuestion(feedback, {
        accepted: true,
        control: { action: "ASK_USER", question: run.pendingQuestion },
      });
    }
    return {
      stages: this.refreshPlanStages(run.stages || this.specialistStages || {}),
      mode,
      action,
      planAutoRevisions: policy.planAutoRevisions || 0,
      implementationAutoRevisions,
      taskInfo: taskFileInfo(run.taskPath),
      feedback,
      // TASK_CHANGED_AFTER_REVIEW에는 해소할 구조화 이슈가 없다. 이전 라운드
      // 이슈를 끌어오면 이미 통과한 지적을 다시 먹인다.
      ...(isPlanning || changedAfterReview
        ? {}
        : { previousIssues: structuredIssuesFromReview(feedback) }),
      phase: isPlanning ? "needs_decision" : "plan_review_fix_required",
    };
  }

  // WAITING을 만든 발화를 되찾는다. Task 내용은 primary가 아니라 최종 fallback이다 —
  // 다음 Planner에게 전달되어야 하는 핵심은 "Reviewer가 무엇을 지적했는가"다.
  waitingPlanFeedback({ run, isPlanning, changedAfterReview, taskContent }) {
    // 1. 승인 후 Task가 바뀐 경우에는 WAITING을 만든 에이전트 발화가 없다.
    //    아래 fallback을 적용하면 직전에 PASS를 낸 Reviewer 발화를 끌어와
    //    이미 해소된 지적을 다시 먹인다.
    if (changedAfterReview) {
      return `승인 후 작업 지시서가 변경되어 재검수가 필요합니다.\n\n${taskContent}`.trim();
    }
    // 2. 새 실행은 WAITING 전이 시 발화 id를 남긴다.
    if (run.feedbackMessageId) {
      const found = this.messages.find((message) => message.id === run.feedbackMessageId);
      if (found?.text) return found.text;
    }
    // 3. 구형 상태 호환: 이 필드가 없던 시절의 WAITING도 살려야 한다.
    //    전문 응답 메시지에는 agentMeta.specialistStage가 이미 저장돼 있다.
    const wantedStage = isPlanning ? "planner" : "plan_review";
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.error || !message?.text) continue;
      if (message.agentMeta?.specialistStage === wantedStage) return message.text;
    }
    // 4. 최종 fallback.
    return taskContent;
  }

  holdForRecovery({
    runInfo,
    taskInfo,
    checkpoint,
    stage = "implementation",
    round = 1,
    stopReason = "EXECUTION_BLOCKED",
    result = null,
    changes = null,
    message = "전문 실행을 안전하게 중단했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
  } = {}) {
    const canRestore = Boolean(checkpoint?.supported === true);
    this.transitionProfessional({
      type: "HOLD_BLOCKED",
      stopReason,
      blockReason: safeBlockReason(stopReason),
    });
    this.persistBlockedRun({ runInfo, taskInfo, checkpoint, stage, round, stopReason, result, changes });
    this.specialistBlocked = {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: safeBlockReason(stopReason),
    };
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "blocked",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: stopReason,
    }));
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(message);
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason,
      blocked: true,
      canRestore,
      ...(result ? { result } : {}),
    };
  }

  executionAxes(options = {}) {
    return professionalExecutionAxes(options);
  }

  evidencePayload(options = {}) {
    const payload = buildProfessionalEvidencePayload({
      ...options,
      // options에 명시가 없으면 현재 실행의 checkpoint 보호 상태를 end-to-end로 넘긴다.
      checkpointProtection:
        options.checkpointProtection !== undefined
          ? options.checkpointProtection
          : this.professionalRun?.checkpointProtection || null,
      // 백업 실패 원인과 사용자 승인 사실도 함께 전달해 Reviewer가 신뢰도
      // 제한 사유를 구체적으로 알 수 있게 한다.
      checkpointFailReason:
        options.checkpointFailReason !== undefined
          ? options.checkpointFailReason
          : this.professionalRun?.checkpointFailReason || null,
      userApprovedUnprotectedExecution:
        options.userApprovedUnprotectedExecution !== undefined
          ? options.userApprovedUnprotectedExecution
          : Boolean(this.professionalRun?.userApprovedUnprotectedExecution),
    });
    const runInfo = options.runInfo || null;
    if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };
    const ok = this.taskManager.writeRunEvidence(runInfo, payload);
    return ok ? { ok: true, payload } : { ok: false, payload };
  }

  // ---- Stage D — Assurance & Governance 배선 ----
  //
  // 다섯 지점만 실행 흐름에 붙는다: 동결 → admission → subject → 검증 → final.
  // v1 계약은 legacy 모드로 흘러 기존 동작이 그대로 유지된다(Charter §6).

  // 1. 검사 계약 동결 + Builder admission.
  // 되돌릴 수 없는 상태를 소비하기 전에 수행한다(D-0에서 배운 순서 원칙).
  beginAssurance({ runInfo, stage = "implementation", round = 1, lineage = null } = {}) {
    if (!runInfo?.runDir) {
      this.assuranceRun = null;
      return { ok: true };
    }
    const assurance = new AssuranceRun({
      runId: runInfo.runId,
      runDir: runInfo.runDir,
      root: this.meta.workspace,
    });
    let frozen;
    try {
      frozen = assurance.freeze(runInfo.content || "", { lineage });
    } catch (error) {
      // 예외 자체는 v1/v2를 구분해 주지 않는다. 문서가 v2를 표방했는지 먼저 보고
      // 판단해야 v2가 예외 하나로 legacy로 승격되는 것을 막을 수 있다(B3).
      frozen = {
        ok: false,
        mode: assurance.assured ? MODES.ASSURED : null,
        code: "ASSURANCE_INTERNAL_ERROR",
        error: error?.message || "확인 계약을 준비하지 못했습니다.",
      };
    }

    if (frozen.ok) {
      this.assuranceRun = assurance;
      // 승인·조회 경로가 이 Run을 찾을 수 있게 남긴다(step은 단계 사이에 끊긴다).
      this.lastRunInfo = runInfo;
      if (!assurance.assured) return { ok: true, assurance };

      // frozen input이 승인 시점과 다르면 Run을 시작하지 않는다(§3.1).
      let admitted;
      try {
        admitted = assurance.admitBuilder();
      } catch (error) {
        admitted = { ok: false, code: "ASSURANCE_INTERNAL_ERROR", error: error?.message || null };
      }
      if (!admitted.ok) {
        return {
          ok: false,
          failure: this.holdAssuranceFailure({
            stage,
            round,
            stopReason: admitted.code || "FROZEN_INPUT_CHANGED",
            message: `${admitted.error || "승인된 입력을 확인하지 못했습니다."} 기획을 다시 승인하거나 입력을 원래대로 되돌려 주세요.`,
          }),
        };
      }
      // canonical state를 남기지 못했으면 진행하지 않는다(B3).
      // 계약·원장·판정이 디스크에 없으면 D-C가 "왜 PASS였는가"를 재구성할 수
      // 없고, 그 상태로 통과시키는 것은 Stage D의 목적 자체를 무너뜨린다.
      const persisted = assurance.persist();
      if (!persisted.ok) {
        return {
          ok: false,
          failure: this.holdAssuranceFailure({
            stage,
            round,
            stopReason: "ASSURANCE_STATE_WRITE_FAILED",
            message: `확인 기록을 저장하지 못해 실행을 시작하지 않았습니다. (${persisted.error || "저장 실패"})`,
          }),
        };
      }
      return { ok: true, assurance };
    }

    // **v2를 표방한 계약의 실패는 legacy 승격 사유가 아니다(B2·B3).**
    // v1 문서에서만 기존 경로로 흘린다.
    if (frozen.mode !== MODES.ASSURED) {
      this.assuranceRun = null;
      this.appendSystem(`확인 계약을 준비하지 못해 기존 방식으로 진행합니다. (${frozen.error || "알 수 없는 오류"})`);
      return { ok: true };
    }
    return {
      ok: false,
      failure: this.holdAssuranceFailure({
        stage,
        round,
        stopReason: frozen.code || "ASSURANCE_CONTRACT_INVALID",
        message: frozen.error || "확인 계약을 만들지 못해 실행을 시작하지 않았습니다.",
      }),
    };
  }

  // 현재 Run이 어떤 Run에서 이어졌는지. 옛 기록은 carriedFromRunId만 갖고 있으므로
  // run-lineage가 그것을 carry로 읽어 준다(저장된 값을 고치지 않는다 · §27).
  professionalLineage() {
    const run = this.professionalRun;
    if (!run) return null;
    const read = readRunLineage(run);
    return read.parentRunId ? { parentRunId: read.parentRunId, lineageRelation: read.lineageRelation } : null;
  }

  // step 모드는 단계 사이에 사용자를 기다리므로 메모리 상태가 끊길 수 있다.
  // 동결된 계약과 판정 원장은 RUN 폴더에 남아 있으므로 거기서 복원한다.
  ensureAssuranceRun(runInfo) {
    if (this.assuranceRun) return this.assuranceRun;
    if (!runInfo?.runDir) return null;
    try {
      const loaded = AssuranceRun.load(runInfo.runDir, { root: this.meta.workspace });
      if (loaded) this.assuranceRun = loaded;
      return loaded;
    } catch {
      return null;
    }
  }

  holdAssuranceFailure({ stage, round, stopReason, message }) {
    this.assuranceRun = null;
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(message);
    return {
      ok: false,
      stage,
      completedIterations: Math.max(0, (round || 1) - 1),
      needsUserDecision: true,
      stopReason,
    };
  }

  // 2. Builder 종료 → 결과물 snapshot 확정 → 동결된 검사 실행 (INV-5 · D-A2).
  //
  // Builder가 다시 실행될 때마다 호출된다. 새 결과물에는 새 subject와 새 검증이
  // 붙고, 이전 기록은 지워지지 않는다(R-8).
  async runAssuranceVerification({ changeSnapshot, permission, runInfo = null } = {}) {
    const assurance = this.ensureAssuranceRun(runInfo);
    if (!assurance?.assured) return null;
    try {
      // Charter §3.1 — live 입력은 "달라도 되지만 실제로 무엇을 썼는지는 남긴다".
      // Builder가 끝난 시점이 그 관측의 자리다. 관측 못 하는 입력은 못 했다고 남긴다.
      assurance.captureLiveInputUse();

      const diff = changeSnapshot?.diff || null;
      assurance.captureSubject({
        changedPaths: [
          ...(diff?.untrackedFiles || []).map((f) => f.path),
          ...(diff?.changedPaths || []),
        ],
        // Git이 없으면 변경 관측이 안 된다는 사실을 정직하게 남긴다.
        changeObservation: diff?.supported === true ? "observed" : "unsupported_non_git",
      });
      // 검증 권한은 Builder가 실제로 쓴 권한에서 유도한다(INV-2).
      // runner가 min(worker, workspace-read)로 다시 한 번 낮춘다.
      const workerPermission =
        permission ||
        specialistPermissionMode("implementation", this.activeRunAuthorization || "workspace-write") ||
        "workspace-read";
      const verification = await assurance.verify({ workerPermission });
      // 검증 결과를 남기지 못했으면 그 결과는 없는 것과 같다(B3).
      const persisted = assurance.persist();
      if (!persisted.ok) {
        return {
          ok: false,
          code: "ASSURANCE_STATE_WRITE_FAILED",
          error: `확인 결과를 저장하지 못했습니다. (${persisted.error || "저장 실패"})`,
          records: verification?.records || [],
        };
      }
      return verification;
    } catch (error) {
      this.appendSystem(`확인을 끝까지 수행하지 못했습니다. (${error?.message || "알 수 없는 오류"})`);
      return { ok: false, error: error?.message || null, records: [] };
    }
  }

  // 3. Final PASS 집계. 남은 판단이 있으면 통과시키지 않는다(§18).
  //
  // 실패해도 null을 돌려주지 않는다. null은 caller에게 "assured가 아니다"로
  // 읽혀 그대로 통과되므로, 오류는 finalPass:false로 명시해야 한다(B3).
  finalizeAssurance(runInfo = null) {
    const assurance = this.ensureAssuranceRun(runInfo);
    if (!assurance?.assured) return null;
    try {
      const result = assurance.finalize();
      // Final 판정을 남기지 못했으면 통과시키지 않는다(B3).
      // 기록되지 않은 PASS는 사후에 설명할 수 없는 PASS다.
      const persisted = assurance.persist();
      if (!persisted.ok) {
        return {
          verdict: "BLOCKED",
          finalPass: false,
          blockers: [{ reason: "ASSURANCE_STATE_WRITE_FAILED", detail: persisted.error || null }],
          summary: result?.summary || null,
        };
      }
      return result;
    } catch (error) {
      return {
        verdict: "BLOCKED",
        finalPass: false,
        blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: error?.message || null }],
        summary: null,
      };
    }
  }

  // Recorder 결과를 provenance에 남긴다. 기록 실패는 governance 실패가 아니므로
  // 실행을 무너뜨리지 않는다(관측 실패 ≠ 통제 실패).
  recordAssuranceRecorder({ runInfo = null, ok = false } = {}) {
    try {
      const assurance = this.ensureAssuranceRun(runInfo);
      if (!assurance?.assured) return;
      assurance.recordRecorder({ ok });
      assurance.persist();
    } catch {}
  }

  // ---- B5 — 사용자 승인 진입점 ----
  //
  // Reviewer는 HUMAN_APPROVAL criterion을 대신 해소할 수 없다(§20). 그러면
  // 사용자가 직접 풀 수 있어야 하며, 그 경로가 없으면 Run이 영원히 막힌다.

  // 지금 사용자 승인을 기다리는 항목. UI가 이것을 그대로 보여 준다(§9 P-2).
  pendingHumanApprovals(runInfo = null) {
    const assurance = this.ensureAssuranceRun(runInfo || this.currentRunInfo());
    if (!assurance?.assured) return [];
    const pending = [];
    for (const criterion of assurance.plan?.criteria || []) {
      const effective = assurance.ledger.effectiveFor(criterion.criterionId, {
        assuranceSubjectRef: assurance.assuranceSubjectRef,
      });
      if (!effective) continue;
      if (effective.actualDisposition !== "HUMAN_APPROVAL" || effective.resolved) continue;
      pending.push({
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        // 왜 사람이 필요한지도 함께 준다(§23).
        reasons: effective.downgradeReason ? [effective.downgradeReason] : [],
      });
    }
    return pending;
  }

  // 사용자가 승인/거부한다. Reviewer도 Builder도 이 경로를 대신 호출할 수 없다.
  resolveHumanApproval({ criterionId, approved, note = null } = {}) {
    const runInfo = this.currentRunInfo();
    const assurance = this.ensureAssuranceRun(runInfo);
    if (!assurance?.assured) {
      return { ok: false, error: "이 실행에는 승인할 확인 항목이 없습니다." };
    }
    const pending = this.pendingHumanApprovals();
    if (!pending.some((p) => p.criterionId === criterionId)) {
      return { ok: false, error: "지금 승인할 수 있는 항목이 아닙니다." };
    }
    const appended = assurance.resolveByHuman({
      criterionId,
      outcome: approved ? "PASS" : "FAIL",
      note,
    });
    if (!appended.ok) return appended;
    // 승인 기록을 남기지 못했으면 승인하지 않은 것이다(B3).
    const persisted = assurance.persist();
    if (!persisted.ok) {
      return { ok: false, code: "ASSURANCE_STATE_WRITE_FAILED", error: `승인을 저장하지 못했습니다. (${persisted.error || "저장 실패"})` };
    }
    // 승인 직후 결과물을 재확인해 승인이 어떤 결과물에 붙었는지 확정한다(INV-5).
    const final = this.finalizeAssurance(runInfo);

    // **승인이 assurance만 풀고 Run을 BLOCKED에 남겨두면 안 된다(B5).**
    // Final PASS가 되면 정상 경로의 다음 단계(기록)로 이어질 수 있게 한다.
    let resumable = false;
    if (final?.finalPass && this.specialistResume?.phase === "awaiting_human_approval") {
      this.specialistResume = {
        ...this.specialistResume,
        phase: "review_pass",
        // 승인으로 재개된 실행임을 표시한다. block/auto는 FSM 전이를
        // runExecutionBlockInner가 하는데, 승인 대기로 그 함수를 빠져나왔으므로
        // 기록 단계에서 남은 전이를 대신 이어야 Run이 완료된다.
        resumedFromApproval: true,
      };
      resumable = true;
    }
    this.emitSpecialistState();
    return {
      ok: true,
      criterionId,
      approved: Boolean(approved),
      final,
      // UI가 곧바로 이어서 진행할 수 있는지 알려 준다.
      resumable,
      pending: this.pendingHumanApprovals(runInfo),
    };
  }

  currentRunInfo() {
    return this.specialistResume?.runInfo || this.lastRunInfo || null;
  }

  // 외부에서 온 live input retrieval metadata를 기록한다(Charter §3.1).
  // Agora가 URL을 대신 가져오지는 않지만, 무엇을 썼는지 보고받으면 남긴다.
  recordLiveInputRetrieval({ inputId, version = null, etag = null, contentHash = null, note = null } = {}) {
    const runInfo = this.currentRunInfo();
    const assurance = this.ensureAssuranceRun(runInfo);
    if (!assurance?.assured) return { ok: false, error: "이 실행에는 입력 계약이 없습니다." };
    const recorded = assurance.recordLiveRetrieval(inputId, { version, etag, contentHash, note });
    if (!recorded.ok) return recorded;
    const persisted = assurance.persist();
    if (!persisted.ok) {
      return { ok: false, code: "ASSURANCE_STATE_WRITE_FAILED", error: persisted.error || "저장 실패" };
    }
    return { ok: true, inputId, entry: recorded.entry };
  }

  // 감사 조회: 이 Run이 실제로 어떤 입력을 썼는가.
  assuranceInputUsage() {
    const assurance = this.ensureAssuranceRun(this.currentRunInfo());
    if (!assurance?.assured) return null;
    const explained = assurance.explain();
    return {
      declared: explained.inputs,
      retrievals: explained.inputRetrievals,
      // 선언은 됐는데 실제 사용 기록이 없는 live 입력. 감사에서는 이것이
      // "모른다"는 정직한 답이다 — 기록을 지어내 채우지 않는다.
      withoutRetrieval: assurance.liveInputsWithoutRetrieval(),
    };
  }

  // Reviewer에게 넘길 구조화 payload(§19).
  assuranceReviewPayload(runInfo = null) {
    try {
      return this.ensureAssuranceRun(runInfo)?.reviewerPayload() || null;
    } catch {
      return null;
    }
  }

  // Reviewer가 PASS를 선언했을 때, 그 판단을 REVIEW_REQUIRED criterion의
  // resolution으로 기록한 뒤 Final을 집계한다.
  //
  // 중요: Reviewer는 **자동 검증 결과를 바꾸지 못한다.** REVIEW_REQUIRED로
  // 라우팅된 항목만 판정할 수 있고, HUMAN_APPROVAL은 사용자만 해소할 수 있다.
  applyReviewerAssuranceVerdict(contract, runInfo = null) {
    const assurance = this.ensureAssuranceRun(runInfo);
    if (!assurance?.assured) return null;
    try {
      for (const record of assurance.lastVerification?.records || []) {
        if (record.actualDisposition !== "REVIEW_REQUIRED") continue;
        assurance.resolveByReviewer({
          criterionId: record.criterionId,
          outcome: contract?.verdict === "PASS" ? "PASS" : "FAIL",
          rationale: contract?.summary || null,
        });
      }
      return this.finalizeAssurance(runInfo);
    } catch (error) {
      // 반영에 실패했으면 판정이 원장에 남지 않았다는 뜻이다.
      // null을 돌려 통과시키면 검수 결과 없이 Run이 완료된다(B3).
      return {
        verdict: "BLOCKED",
        finalPass: false,
        blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: error?.message || null }],
        summary: null,
      };
    }
  }

  // Final 집계가 막았을 때 안전하게 멈춘다. 변경은 그대로 두고 무엇이
  // 남았는지 사용자 언어로 알린다(§9 — 내부 어휘를 노출하지 않는다).
  // 남은 것이 **사용자 승인뿐**이면 그것은 실패가 아니라 계획된 대기다.
  // 승인 화면에서 이미 예고한 지점이므로(§9 P-3) Run을 BLOCKED로 만들지 않고,
  // 승인 후 정상 경로의 다음 단계(기록)로 이어질 수 있는 대기 상태로 둔다.
  pauseForHumanApproval({ runInfo, taskInfo, checkpoint, stages, mode, pending, changes = null, builderEvidence = null }) {
    // REVIEWING/WAITING은 기존 FSM이 이미 아는 정상 대기 상태다.
    // 전이가 성립하지 않는 실행(step legacy 등)에서는 FSM을 건드리지 않고
    // resume 상태만으로 대기한다 — 없는 상태를 지어내지 않는다.
    this.transitionProfessional({ type: "REVIEW_UNKNOWN", stopReason: "HUMAN_APPROVAL_REQUIRED" });
    this.specialistResume = {
      ...(this.specialistResume || {}),
      stages: stages || this.stagesForSpecialist(),
      // 승인 후 이어지는 것은 "기록" 한 단계뿐이므로 step phase 기계를 쓴다.
      mode: "step",
      phase: "awaiting_human_approval",
      runInfo,
      taskInfo: taskInfo || null,
      checkpoint,
      maxAutoRevisions: 0,
      // 기록 단계가 필요로 하는 것들. block/auto에서 넘어온 경우 resume에 없다.
      builderChanges: this.specialistResume?.builderChanges ?? changes?.text ?? "",
      builderDiff: this.specialistResume?.builderDiff ?? changes?.diff ?? null,
      builderEvidence: this.specialistResume?.builderEvidence ?? builderEvidence ?? null,
    };
    this.specialistActive = false;
    this.emitSpecialistState();
    const lines = pending.map((p) => `- ${p.statement}`);
    this.appendSystem(
      `승인이 필요한 항목이 남았습니다. 확인 후 승인해 주시면 기록하고 완료합니다.\n${lines.join("\n")}`
    );
    return {
      ok: false,
      stage: "review",
      completedIterations: 1,
      needsUserDecision: true,
      stopReason: "HUMAN_APPROVAL_REQUIRED",
      pendingApprovals: pending,
    };
  }

  holdForAssuranceBlocked({ runInfo, taskInfo, checkpoint, round, changes, final, stages = null, mode = null }) {
    const {
      describeBlockers,
      BLOCK_REASONS,
    } = require("../agora/assurance/final-disposition");

    // 사용자 승인만 남았다면 막지 않고 기다린다(B5).
    const blockers = final?.blockers || [];
    const onlyHumanApproval =
      blockers.length > 0 &&
      blockers.every((b) => b.reason === BLOCK_REASONS.UNRESOLVED_HUMAN_APPROVAL);
    if (onlyHumanApproval) {
      const pending = this.pendingHumanApprovals(runInfo);
      if (pending.length > 0) {
        return this.pauseForHumanApproval({
          runInfo, taskInfo, checkpoint, stages, mode, pending, changes,
        });
      }
    }
    const lines = describeBlockers(final).map((b) => `- ${b.label}: ${b.count}건`);
    const message = final.verdict === "INVALIDATED"
      ? `확인을 마친 뒤 결과물이나 입력 자료가 바뀌어 완료로 처리할 수 없습니다.\n${lines.join("\n")}\n\n변경을 되돌리거나 다시 확인해 주세요.`
      : `아직 남은 확인이 있어 완료로 처리하지 않았습니다.\n${lines.join("\n")}`;
    return this.holdForRecovery({
      runInfo,
      taskInfo,
      checkpoint,
      stage: "review",
      round,
      stopReason: final.verdict === "INVALIDATED" ? "ASSURANCE_INVALIDATED" : "ASSURANCE_BLOCKED",
      changes,
      message,
    });
  }

  prepareReviewEvidence({ runInfo, builderResult, diff, round, provider }) {
    const evidence = this.evidencePayload({ runInfo, builderResult, diff, round, provider });
    if (evidence.ok) return evidence;
    this.appendSystem("실행 근거를 저장하지 못해 검수를 시작하지 않았습니다. 변경은 그대로 남아 있습니다.");
    return { ok: false, stopReason: "EVIDENCE_WRITE_FAILED", payload: evidence.payload };
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
    previousIssues = "",
  } = {}) {
    const planner = stages?.planner;
    // planReview는 선택 설정이며, 이전 세션과 기존 프로젝트는 review 담당자를
    // 기획 검수에도 계속 사용한다.
    const planReviewAgent = stages?.planReview || stages?.review;
    if (!planner?.agent || !planReviewAgent?.agent) {
      return { ok: false, error: "기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    const requestedGeneration = this.generation;
    const planRevisionLimit = Number.isInteger(planAutoRevisions)
      ? Math.min(3, Math.max(0, planAutoRevisions))
      : 0;
    let planRevisionCount = 0;
    // 검수자의 출력 계약 실패는 사용자 결정이 아니라 형식 실패다. 한 번만 다시
    // 청하고, 그래도 안 되면 사용자에게 올린다. 자동 보완 예산과는 별개로 센다.
    let planReviewRepairUsed = false;
    let contractRepairCount = 0;
    const MAX_CONTRACT_REPAIRS = 2;
    let nextFeedback = feedback;
    let nextTaskInfo = taskInfo;
    let previousPlanIssues = String(previousIssues || "").trim();
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
            controlOutputs: true,
          },
          agentConfig: planner.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!plannerResult?.ok) {
          this.transitionProfessional({
            type: "INTERRUPT",
            stopReason: plannerResult?.stopReason || "PLANNER_FAILED",
          });
          return this.specialistFail(planner, "planner", planRevisionCount, plannerResult);
        }

        if (plannerResult.plannerStatus === "NEEDS_DECISION" || hasOpenQuestions(plannerResult.text)) {
          // V1.5 — routing 축 소비. NEEDS_DECISION + ASK_USER는 합법 조합이고,
          // 어긋난 요청(예: HANDOFF)은 기록·안내 후 기본 흐름으로 계속한다.
          const decisionControl = this.consumeControlRequest({
            contract: "planner",
            result: "NEEDS_DECISION",
            outcome: plannerResult,
          });
          const transition = this.transitionProfessional({
            type: "PLANNER_NEEDS_DECISION",
            stopReason: "NEEDS_DECISION",
            feedbackMessageId: plannerResult?.messageId || null,
            pendingQuestion: this.plannerQuestionFrom(decisionControl),
          });
          if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
          this.specialistResume = {
            stages,
            mode,
            planAutoRevisions: planRevisionLimit,
            implementationAutoRevisions,
            action,
            feedback: this.withPlannerQuestion(plannerResult.text || nextFeedback, decisionControl),
            taskInfo: nextTaskInfo,
            phase: "needs_decision",
          };
          this.appendSystem("기획자가 답변이 필요한 질문을 남겼습니다. 아래 전용 입력칸에서 답한 뒤 기획·검수를 다시 실행하세요.");
          return { ok: false, stage: "planner", needsUserDecision: true, stopReason: "NEEDS_DECISION", result: plannerResult };
        }

        const contractCheck = validateTaskContract(plannerResult.text || "");
        if (!contractCheck.valid) {
          if (contractRepairCount < MAX_CONTRACT_REPAIRS) {
            contractRepairCount += 1;
            this.appendSystem(
              "기획서 필수 섹션 누락(" + contractCheck.missing.join(", ") + ")으로 자동 보완 요청 (" + contractRepairCount + "/" + MAX_CONTRACT_REPAIRS + "회)"
            );
            nextFeedback =
              "[기획서 검증 실패] 작업 지시서(Task Contract)에 다음 필수 섹션 또는 내용이 누락되었습니다: " + contractCheck.missing.join(", ") + ".\n" +
              "반드시 다음 6개 필수 섹션을 포함하여 다시 작성해 주세요:\n- ## Goal\n- ## Requirements\n- ## Implementation Approach\n- ## Acceptance Criteria\n- ## Verification\n- ## Out of Scope\n\n각 섹션 아래에는 코드 블록 외의 실제 설명 본문이 반드시 있어야 합니다.\n\n이전 작성 내용:\n" + (plannerResult.text || "");
            continue;
          }
          const transition = this.transitionProfessional({
            type: "PLANNER_NEEDS_DECISION",
            stopReason: "NEEDS_DECISION",
            feedbackMessageId: plannerResult?.messageId || null,
          });
          if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
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
          this.appendSystem(
            "기획서에 필수 섹션(" + contractCheck.missing.join(", ") + ")이 반복 누락되어 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요."
          );
          return {
            ok: false,
            stage: "planner",
            needsUserDecision: true,
            stopReason: "NEEDS_DECISION",
            result: plannerResult,
          };
        }
        contractRepairCount = 0;
        // V1.5 — PLAN_READY + HANDOFF: @reviewer 조합 소비(원장·Journal).
        // 계약 검증을 통과한 뒤에만 소비한다 — 보완 루프로 되돌아가는 라운드의
        // 요청까지 소비하면 원장이 실제 hop보다 부풀기 때문이다.
        this.consumeControlRequest({
          contract: "planner",
          result: "PLAN_READY",
          outcome: plannerResult,
        });

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
              const registered = this.onTaskCreated({
                title: nextTaskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
                role: "implementation",
              });
              if (registered === false) throw new Error("TASK_INDEX_FAILED");
            } else if (previousTaskInfo && nextTaskInfo && this.onTaskUpdated) {
              const updated = this.onTaskUpdated({
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
              });
              if (updated === false) throw new Error("TASK_INDEX_FAILED");
            }
          } catch (error) {
            const stopReason = error?.message === "TASK_INDEX_FAILED" ? "TASK_INDEX_FAILED" : "TASK_SAVE_FAILED";
            this.appendSystem(
              stopReason === "TASK_INDEX_FAILED"
                ? "TASK.md는 저장했지만 작업 목록 등록에 실패해 기획을 멈췄습니다. 파일은 보존되며 다음 프로젝트 열기에서 다시 확인합니다."
                : `기획 결과를 TASK.md로 저장하지 못했습니다. (${error?.message || "알 수 없는 오류"})`
            );
            return { ok: false, stage: "planner", needsUserDecision: true, stopReason, error: error?.message || "알 수 없는 오류" };
          }
        }

        const reviewTransition = this.transitionProfessional({
          type: "PLANNER_PLAN_READY",
          taskPath: nextTaskInfo?.relativePath || null,
          taskId: nextTaskInfo?.filename
            ? String(nextTaskInfo.filename).replace(/\.md$/i, "")
            : null,
        });
        if (!reviewTransition.ok) {
          return this.professionalTransitionFailure("plan_review", reviewTransition);
        }

        const planText = nextTaskInfo?.content || plannerResult.text || "";
        let planReview = await this.scheduleResponse(planReviewAgent.agent, {
          specialist: {
            stage: "plan_review",
            round: planRound,
            maxRounds: planRevisionLimit + 1,
            feedback: planText,
            previousIssues: previousPlanIssues,
            controlOutputs: true,
          },
          agentConfig: planReviewAgent.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!planReview?.ok) {
          this.transitionProfessional({
            type: "INTERRUPT",
            stopReason: planReview?.stopReason || "PLAN_REVIEW_FAILED",
          });
          return this.specialistFail(planReviewAgent, "plan_review", planRevisionCount, planReview);
        }
        let contract = this.parseReviewContract(planReview.text || "", planReview.specialistSignal);

        // 출력 계약 실패(표기 누락·모순)와 UNKNOWN은 성격이 다르지만, 둘 다
        // 사용자가 대신 답해 줄 수 있는 문제가 아니다. 같은 검수자에게 한 번 더 청한다.
        const repairKind = this.reviewRepairKind(contract);
        if (repairKind && !planReviewRepairUsed) {
          planReviewRepairUsed = true;
          this.appendSystem(
            repairKind === "unknown"
              ? "기획 검수가 판정을 내리지 못해 같은 근거로 한 번 더 검수를 요청합니다. (자동 보완 횟수와 무관)"
              : "기획 검수 응답의 표기가 계약에 맞지 않아 형식만 고쳐 다시 요청합니다. (자동 보완 횟수와 무관)"
          );
          const repaired = await this.scheduleResponse(planReviewAgent.agent, {
            specialist: {
              stage: "plan_review",
              round: planRound,
              maxRounds: planRevisionLimit + 1,
              feedback: planText,
              previousIssues: previousPlanIssues,
              repairKind,
              // 첫 호출과 동일하게 제어를 추출·strip·소비해야 한다. 빠뜨리면
              // repaired 응답의 꼬리 HANDOFF 줄이 화면에 raw로 노출되고
              // (strip은 controlOutputs 턴에서만 동작), 정당한 HANDOFF가
              // Journal에 남지 않는다.
              controlOutputs: true,
            },
            agentConfig: planReviewAgent.agentConfig,
          });
          if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
          // 재요청이 실패하면 원래 응답으로 계속 간다(사용자에게 올라간다).
          if (repaired?.ok) {
            planReview = repaired;
            contract = this.parseReviewContract(repaired.text || "", repaired.specialistSignal);
          }
        }
        previousPlanIssues = structuredIssuesFromReview(planReview.text || "");
        // V1.5 — 기획 검수의 routing 축 소비. PASS + HANDOFF: @builder가
        // 수용돼도 실제 Builder 실행은 기존 승인 게이트(READY 정지 /
        // autoContinueReady)를 그대로 지난다 — 실행 전제조건 층은 별개다.
        this.consumeControlRequest({
          contract: "plan_review",
          result: contract.verdict,
          outcome: planReview,
        });
        if (contract.verdict === "PASS") {
          const transition = this.transitionProfessional({
            type: "PLAN_REVIEW_PASS",
            approvedTaskHash: nextTaskInfo?.hash || null,
            taskPath: nextTaskInfo?.relativePath || null,
          });
          if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
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
          const transition = this.transitionProfessional({
            type: "PLAN_REVIEW_FIX",
            canAutoRevise: true,
          });
          if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
          planRevisionCount += 1;
          nextFeedback = planReview.text || planText;
          this.appendSystem(
            `기획 검수 결과 수정 필요 · 자동 보완 ${planRevisionCount}/${planRevisionLimit}회`
          );
          continue;
        }

        const transition = this.transitionProfessional({
          type: contract.verdict === "UNKNOWN" ? "PLAN_REVIEW_UNKNOWN" : "PLAN_REVIEW_FIX",
          canAutoRevise: false,
          stopReason: contract.stopReason || contract.verdict,
          feedbackMessageId: planReview?.messageId || null,
        });
        if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
        this.specialistResume = {
          stages,
          mode,
          planAutoRevisions: planRevisionLimit,
          implementationAutoRevisions,
          action,
            feedback: planReview.text || planText,
            taskInfo: nextTaskInfo,
            previousIssues: previousPlanIssues,
            phase: "plan_review_fix_required",
        };
        this.appendSystem(
          contract.stopReason === "NEEDS_DECISION"
            // 사용자 질문은 자동 보완보다 우선한다(질문의 답이 요구사항을 바꾸므로
            // 답 없이 기획을 고치면 추측이 된다). 다만 화면에는 "자동 보완 N회"가
            // 켜져 있으니, 그 예산을 쓰지 않았다는 사실을 밝히지 않으면 설정이
            // 동작하지 않는 것처럼 보인다.
            ? "기획 검수자가 사용자 결정이 필요한 질문을 남겨 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 답해 주세요."
              + (planRevisionLimit > 0
                ? ` 사용자 답변이 필요한 질문은 자동 보완으로 해결할 수 없어 기획 자동 보완(${planRevisionCount}/${planRevisionLimit}회)은 쓰지 않았습니다. 답변 뒤 남은 지적은 자동 보완으로 이어집니다.`
                : "")
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
    return this.withProfessionalAuthorization("workspace-write", async () => {
      return await this._answerPlanQuestion(answer);
    });
  }

  async _answerPlanQuestion(answer) {
    const resume = this.specialistResume;
    // READY(plan_ready) 상태 및 task_contract_incomplete 상태에서도 기획 수정을 허용한다.
    if (!resume || !["needs_decision", "plan_review_fix_required", "plan_ready", "task_contract_incomplete"].includes(resume.phase)) {
      return { ok: false, error: "답변을 기다리는 기획 질문이 없거나 기획 수정 가능한 상태가 아닙니다." };
    }
    const isReadyEdit = resume.phase === "plan_ready";
    const isContractFix = resume.phase === "task_contract_incomplete";
    const text = String(answer || "").trim();
    if (!text && !isContractFix) return { ok: false, error: isReadyEdit ? "기획 수정 내용을 입력해 주세요." : "기획자에게 보낼 답변을 입력해 주세요." };
    const fixText = text || "계약에 누락된 필수 섹션과 설명 본문을 모두 포함하여 작업 지시서를 보완해 주세요.";
    const transition = this.transitionProfessional({ type: "USER_ANSWER_PLAN" });
    if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
    this.specialistResume = null;
    const tag = isContractFix ? "[기획 보완]" : isReadyEdit ? "[기획 수정]" : "[기획 답변]";
    this.appendMessage({ authorType: "user", author: "user", text: `${tag} ${fixText}` });
    let editPrefix = "\n\n=== 기획 보완 요청 ===\n";
    if (isContractFix && resume.missingSections && resume.missingSections.length > 0) {
      editPrefix += `[기획서 계약 누락] 필수 섹션 또는 내용 누락: ${resume.missingSections.join(", ")}\n반드시 다음 6개 필수 섹션(Goal, Requirements, Implementation Approach, Acceptance Criteria, Verification, Out of Scope)과 본문 설명을 모두 포함하여 다시 작성해 주세요.\n`;
    } else if (isReadyEdit) {
      editPrefix = "\n\n=== 기획 수정 요청 ===\n";
    } else if (!isContractFix) {
      editPrefix = "\n\n=== 사용자 답변 ===\n";
    }
    const editSuffix = isContractFix
      ? "\n=== 기획 보완 요청 끝 ==="
      : isReadyEdit
        ? "\n=== 기획 수정 요청 끝 ==="
        : "\n=== 사용자 답변 끝 ===";
    const feedback = `${resume.feedback || ""}${editPrefix}${fixText}${editSuffix}`;
    // 재개 시점의 프로젝트 설정을 다시 반영한다. 실행 시작 때 저장한 stages 스냅샷에는
    // 사용자가 대기 중에 바꾼 기획·기획검수 담당자가 아니라 과거 담당자가 남아 있다.
    const result = await this.runPlanBlock({
      ...resume,
      stages: this.refreshPlanStages(resume.stages),
      feedback,
      taskInfo: resume.taskInfo || null,
    });
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
  // RUNNING은 "턴이 실제로 떠 있다"는 뜻이어야 한다. 실행이 끝났는데 상태가
  // RUNNING으로 남으면 사용자가 갇힌다: 정책 표는 RUNNING에서 취소만 허용하는데
  // cancelSpecialist는 specialistActive/specialistResume가 이미 꺼져 있어
  // "취소할 전문 실행이 없습니다"로 거부한다. 버튼도 전부 비활성이다.
  //
  // 이런 경로는 TASK 저장 실패처럼 전이 없이 return하는 지점마다 생긴다. 그 지점을
  // 하나씩 고치는 대신, 블록이 끝나는 자리에서 불변식을 세운다. 앱을 다시 열면
  // 어차피 RUNNING이 INTERRUPTED로 바뀌므로(생성자), 실행 중에도 같게 만드는 것이다.
  settleStrandedProfessionalRun() {
    if (!this.professionalRun) return false;
    if (this.professionalRun.status !== "RUNNING") return false;
    if (this.specialistActive) return false;
    const transition = this.transitionProfessional({
      type: "INTERRUPT",
      stopReason: "EXECUTION_INTERRUPTED",
    });
    if (!transition.ok) return false;
    this.emitSpecialistState();
    return true;
  }

  async startSpecialist(options = {}) {
    if (options.stages) this.specialistStages = options.stages;
    // 전문 실행은 세션 권한을 영구히 바꾸지 않고, 이 실행 동안만 유효한
    // run-scoped 권한(workspace-write)을 켜 둔다. 단계별 상한은 그 아래에서
    // 다시 좁혀진다(planner/plan_review=read, recorder=chat 등).
    return this.withProfessionalAuthorization("workspace-write", async () => {
      if (options.action) return await this.startProfessionalAction(options);
      return await this.startLegacySpecialist(options);
    });
  }

  // 전문 모드 진입점. 화면의 버튼은 action으로 구분합니다.
  // - plan: 기획 → 기획 검수
  // - implementation: 승인된 기획 → 구현 → 구현 검수
  // - record: 기록관만 수동 실행
  // - full: 기획·검수와 구현·검수를 연속 실행하되 질문/보완/막힘에서 중단
  async startProfessionalAction(options = {}) {
    // 기획(plan/full)은 "처음부터 다시"이므로 사용자 대기 상태에서도 시작할 수 있어야
    // 한다. 실제로 turn이 떠 있을 때만 막는다. 나머지 action(구현/기록)은 이어가기
    // 이므로 기존 잠금 의미를 그대로 쓴다.
    const restartsPlan = options.action === "plan" || options.action === "full";
    const startBlocked = restartsPlan ? this.isSpecialistBusy() : this.isSpecialistLocked();
    if (this.discussionRequested || this.discussionActive || startBlocked) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    // 역할·팀 상담이 진행 중이면 전문 실행을 시작하지 않는다 — 상담 step
    // 사이의 await 창에서 전문 실행이 끼어들어 순차 계약이 깨지는 것을 막는다.
    if (typeof this.isConsultActive === "function" && this.isConsultActive()) {
      return { ok: false, error: "역할·팀 상담이 진행 중에는 전문 실행을 시작할 수 없습니다." };
    }
    // 일반 응답이 실행·대기 중이면 전문 실행을 큐 뒤에 넣지 않고 즉시 거부합니다.
    // (전문 실행이 일반 응답 뒤에 몰래 대기하지 않도록 합니다.)
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시작해 주세요." };
    }
    const stages = options.stages || {};
    if (options.stages) this.specialistStages = options.stages;
    const action = ["plan", "implementation", "record", "full"].includes(options.action)
      ? options.action
      : "plan";
    const implementation = stages.implementation;
    const review = stages.review;
    const planReviewAgent = stages.planReview || review;
    if ((action === "plan" || action === "full") && (!stages.planner?.agent || !planReviewAgent?.agent)) {
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
      const retryingRecorder = this.professionalRun?.node === "RECORDING" && this.professionalRun?.status === "WAITING";
      const retryRunInfo = retryingRecorder && this.professionalRun?.frozenRunId && this.taskManager?.runInfoForId
        ? this.taskManager.runInfoForId(this.professionalRun.frozenRunId, this.meta.workspace)
        : null;
      const retryCheckpoint = retryingRecorder ? this.checkpointForProfessionalRun() : null;
      if (retryingRecorder && !retryRunInfo) {
        return this.holdForFrozenTaskCorruption({
          taskInfo: taskFileInfo(this.professionalRun?.taskPath),
          checkpoint: retryCheckpoint,
          stage: "recorder",
          round: this.professionalRun?.implementationRound || 1,
          error: "기록을 다시 만들기 위한 Frozen Task Run을 찾을 수 없습니다.",
        });
      }
      if (retryingRecorder && retryRunInfo) {
        const frozenCheck = this.validateFrozenTask(retryRunInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo: retryRunInfo,
            taskInfo: taskFileInfo(this.professionalRun?.taskPath),
            checkpoint: retryCheckpoint,
            stage: "recorder",
            round: this.professionalRun?.implementationRound || 1,
            error: frozenCheck.error,
          });
        }
      }
      let retryChanges = "";
      if (retryingRecorder && retryRunInfo) {
        try {
          retryChanges = (await describeWorkspaceChanges(this.meta.workspace, {
            checkpoint: retryCheckpoint,
            excludePaths: runGeneratedPaths(this.meta.workspace, retryRunInfo),
          })).text || "";
        } catch {}
      }
      const retryEvidence = retryingRecorder && retryRunInfo
        ? this.taskManager?.readRunEvidence?.(retryRunInfo) || null
        : null;
      if (retryingRecorder) {
        const transition = this.transitionProfessional({ type: "USER_RETRY_RECORDER" });
        if (!transition.ok) return this.professionalTransitionFailure("recorder", transition);
      }
      this.specialistActive = true;
      this.emitSpecialistState();
      try {
        const recorderResult = await this.runRecorder({
          ...stages.recorder,
          professional: retryingRecorder,
          frozenTask: retryRunInfo ? {
            runId: retryRunInfo.runId,
            content: retryRunInfo.content,
            taskHash: retryRunInfo.taskHash,
          } : null,
          finalVerdict: retryingRecorder ? "PASS" : null,
          reviewDiff: retryChanges,
          evidence: retryEvidence,
          round: this.professionalRun?.implementationRound || 1,
        });
        if (!recorderResult?.ok) {
          if (retryingRecorder) this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RECORDER_FAILED" });
          return recorderResult;
        }
        if (retryingRecorder) {
          const runInfo = retryRunInfo;
          const round = this.professionalRun?.implementationRound || 1;
          const taskInfo = taskFileInfo(this.professionalRun?.taskPath);
          if (runInfo && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
            status: "COMMITTING",
            finalVerdict: "PASS",
            recorded: true,
            round,
          })) {
            this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RUN_STATE_WRITE_FAILED" });
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "RUN_STATE_WRITE_FAILED",
              message: "기록은 만들었지만 완료 전 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          if (!this.updateProfessionalTaskState({
            taskPath: taskInfo?.relativePath || null,
            taskHash: runInfo?.taskHash || null,
            status: "done",
            activeRunId: null,
            lastRunId: runInfo?.runId || null,
          })) {
            this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "WORKFLOW_WRITE_FAILED" });
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "WORKFLOW_WRITE_FAILED",
              message: "기록은 만들었지만 작업 완료 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          const transition = this.transitionProfessional({ type: "RECORDER_DONE" });
          // 기록 재시도로 완료에 도달한 경로에도 마지막 고리(검토자→recorder)를 settle한다.
          this.settleIncomingHandoff();
          if (!transition.ok) return this.professionalTransitionFailure("recorder", transition);
          if (runInfo && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
            status: "COMPLETED",
            finalVerdict: "PASS",
            recorded: true,
            round,
          })) {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "RUN_STATE_WRITE_FAILED",
              message: "최종 완료 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          if (retryCheckpoint && this.checkpointEngine?.cleanupCheckpoint?.(retryCheckpoint)?.ok === false) {
            this.persistRecoveryState(this.recoveryFor(retryCheckpoint, {
              status: "completed",
              runId: runInfo?.runId || null,
              taskPath: this.professionalRun?.taskPath || null,
              stage: "recorder",
              blockReason: "CHECKPOINT_CLEANUP_FAILED",
            }));
          } else {
            this.clearRecoveryState();
          }
        }
        return { ok: true, recorded: true, recording: recorderResult.text || "" };
      } finally {
        this.specialistActive = false;
        this.emitSpecialistState();
      }
    }

    if (action === "plan" || action === "full") {
      // 사용자 대기 상태에서 새로 시작하는 경우, 옛 실행을 원자적으로 종료하고
      // 들고 있던 checkpoint를 정리한 뒤에 새 run을 만든다. 정리에 실패하면
      // 새 run을 만들지 않고 그 자리에서 멈춘다(되돌릴 수단을 잃은 채 진행 금지).
      let carriedTaskPath = null;
      if (this.specialistResume || this.specialistBlocked) {
        const discarded = await this.discardRunForFreshPlan();
        if (!discarded.ok) return discarded;
        carriedTaskPath = discarded.carriedTaskPath;
        const cleaned = discarded.discardedCheckpoint
          ? "이전 전문 실행과 작업 전 백업을 정리하고 기획을 처음부터 다시 시작합니다."
          : "이전 전문 실행을 정리하고 기획을 처음부터 다시 시작합니다.";
        // 정리에 실패한 항목은 감추지 않는다. 다만 그것 때문에 시작을 막지도 않는다.
        this.appendSystem(
          discarded.warnings?.length
            ? `${cleaned} (${discarded.warnings.join(", ")} — 새 기획에는 영향이 없습니다)`
            : cleaned
        );
      }
      const run = createProfessionalRun({
        stages,
        // 이어받은 경로가 있으면 그 지시서를 갱신하고, 없으면(=끝난 실행이나 새 세션에서
        // 시작하는 진짜 신규 작업) 새 지시서를 만든다.
        taskPath: carriedTaskPath,
        // 같은 root의 handoff 원장을 새 run의 authority로 이월한다(재기획은 연쇄를 끊는다).
        handoffState: this.carryHandoffStateForFreshRun(),
        policy: {
          autoContinueReady: action === "full",
          pauseBeforeReview: false,
          pauseBeforeRecord: false,
          planAutoRevisions,
          implementationAutoRevisions,
        },
      });
      if (!this.setProfessionalRun(run)) {
        return this.professionalTransitionFailure("planner", {
          reason: "전문 실행 시작 상태를 저장하지 못했습니다.",
        });
      }
      this.professionalPlan = null;
      const planResult = await this.runPlanBlock({
        stages,
        mode,
        planAutoRevisions,
        implementationAutoRevisions,
        action,
        // 이어받은 지시서가 있으면 새로 만들지 않고 그 파일을 갱신한다.
        // filename까지 넘겨야 PLANNER_PLAN_READY가 taskId를 채워 화면 배지가 뜬다.
        taskInfo: carriedTaskPath
          ? { relativePath: carriedTaskPath, filename: carriedTaskPath.split(/[\/]/).pop() }
          : null,
      });
      if (action !== "full" || !planResult?.ok) return planResult;
      return this.runProfessionalImplementation({
        stages,
        mode,
        implementationAutoRevisions,
        recordAfter: true,
      });
    }

    if (this.professionalRun) {
      if (this.professionalRun.node !== "READY") {
        return { ok: false, error: "구현을 시작할 수 있는 READY 상태가 아닙니다." };
      }
      const updatedRun = {
        ...this.professionalRun,
        stages: { ...(this.professionalRun.stages || {}), ...stages },
        policy: {
          ...(this.professionalRun.policy || {}),
          implementationAutoRevisions,
        },
        updatedAt: Date.now(),
      };
      if (!this.setProfessionalRun(updatedRun)) {
        return this.professionalTransitionFailure("implementation", {
          reason: "구현 실행 정책을 저장하지 못했습니다.",
        });
      }
    }
    return this.runProfessionalImplementation({
      stages,
      mode,
      implementationAutoRevisions,
      recordAfter: true,
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
    if (this.professionalRun?.approvedTaskHash) {
      const liveTask = this.taskManager.resolveTaskContract(
        { contentSource: "file", taskPath: this.professionalPlan.taskInfo.relativePath },
        this.meta.workspace
      );
      if (!liveTask?.content || hashText(liveTask.content) !== this.professionalRun.approvedTaskHash) {
        const transition = this.transitionProfessional({ type: "TASK_CHANGED_AFTER_REVIEW" });
        if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
        // 이 전이는 예전에 specialistResume를 만들지 않아, 안내는 뜨는데 입력이
        // 먹지 않았다(재시작해야만 동작). 복원 helper를 여기서도 써서 같은
        // WAITING 상태를 즉시 구성한다.
        this.specialistResume = this.resumeForWaitingPlan();
        this.emitSpecialistState();
        this.appendSystem("기획 검수 후 TASK.md가 바뀌어 구현을 시작하지 않았습니다. 기획 검수를 다시 통과시켜 주세요.");
        return {
          ok: false,
          stage: "plan_review",
          needsUserDecision: true,
          stopReason: "TASK_CHANGED_AFTER_REVIEW",
        };
      }
    }

    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.specialistResume = null;
    // 이전 Run이 BLOCKED이면 사용자 선택(keep/restore/replan) 전에는 checkpoint를
    // 정리하거나 새 구현을 시작하지 않는다. UI를 우회한 호출도 같은 보호를 받는다.
    if (this.specialistBlocked) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, error: "앞선 전문 실행이 막힌 상태입니다. 먼저 변경 유지·복원·재기획 중 하나를 선택해 주세요." };
    }
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }

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
  async resumeSpecialist(checkpointAction) {
    return this.withProfessionalAuthorization("workspace-write", () => this._resumeSpecialist(checkpointAction));
  }

  async _resumeSpecialist(checkpointAction) {
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
    // Stage D-0 — workspace 소유권은 실행 상태를 소비하기 전에 확보한다.
    //
    // 소비한 뒤에 admission이 실패하면 "다른 작업이 끝난 뒤 다시 시도하세요"를
    // 돌려주면서 정작 재개할 resume 상태는 이미 없어진 상태가 된다. 순서를 뒤집으면
    // 되돌릴 것이 없다 — 실패해도 아무것도 시작하지 않은 그대로다.
    const lease = this.acquireWorkspaceMutation({
      purpose: "professional-resume",
      runId: resume?.runInfo?.runId || null,
      role: "implementation",
    });
    if (!lease.ok) {
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(lease.error);
      return {
        ok: false,
        stage: "implementation",
        completedIterations: 0,
        needsUserDecision: true,
        stopReason: "WORKSPACE_BUSY",
      };
    }

    this.specialistResume = null;
    this.emitSpecialistState();
    try {
      // 단계별(step) 실행은 phase에 따라 다음 한 단계만 진행합니다.
      if (resume.mode === "step") {
        return await this.resumeStepPhase(resume, requestedGeneration, lease.token);
      }
      // checkpoint 실패 후 사용자 선택 처리: 재시도 / 무보호 진행 / 취소.
      if (resume.phase === "checkpoint_failed") {
        return await this.resumeCheckpointFailure(resume, requestedGeneration, checkpointAction, lease.token);
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
          parentToken: lease.token,
        });
      } finally {
        this.specialistActive = false;
        this.emitSpecialistState();
        this.turnQueue.push(...this.deferredTurnQueue.splice(0));
        this.emitTurnState();
        this.pumpTurnQueue();
      }
    } finally {
      this.releaseWorkspaceMutation(lease.token);
    }
  }

  // checkpoint 생성 실패 후 사용자 선택(재시도/무보호 진행/취소)을 처리한다.
  // 취소(cancel)는 별도 IPC(chat:specialist:cancel)로 요청된다. 이 메서드는
  // 재시도 및 무보호 진행 두 선택지만 처리한다.
  async resumeCheckpointFailure(resume, requestedGeneration, checkpointAction, parentToken = null) {
    const allowUnprotected = String(checkpointAction || "").toLowerCase() === "proceed_unprotected";
    const transition = this.transitionProfessional({
      type: allowUnprotected ? "PROCEED_UNPROTECTED" : "CHECKPOINT_RETRY",
    });
    if (!transition.ok) return this.professionalTransitionFailure("implementation", transition);
    if (allowUnprotected) {
      this.appendSystem("사용자가 백업 없이 실행을 승인했습니다. 사전 작업 상태 스냅샷이 없는 채로 Builder를 시작합니다.");
    } else {
      this.appendSystem("작업 전 상태 백업(checkpoint)을 다시 시도합니다.");
    }
    this.emitSpecialistState();
    const stages = resume.phases || resume.stages;
    return await this.runExecutionBlock({
      stages,
      mode: resume.mode,
      maxAutoRevisions: Number.isInteger(resume.maxAutoRevisions) ? resume.maxAutoRevisions : 0,
      feedback: resume.feedback || "",
      taskInfo: resume.taskInfo || null,
      round: 1,
      requestedGeneration,
      allowUnprotected,
      checkpointFailReason: resume.checkpointFailReason || null,
      resumedRun: resume.runInfo || null,
      parentToken,
    });
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
      this.clearRecoveryState();
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
        if (plannerResult.plannerStatus === "NEEDS_DECISION" || hasOpenQuestions(plannerResult.text)) {
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
              const registered = this.onTaskCreated({
                title: taskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: taskInfo.relativePath,
                taskHash: taskInfo.hash,
                status: "todo",
                role: "implementation",
              });
              if (registered === false) throw new Error("TASK_INDEX_FAILED");
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
  // BLOCKED 보류를 끝내고 그 백업을 정리한다. 정리 실패는 알리되 막지 않는다 —
  // 이건 탈출 경로이고, 지우지 못한 폴더 때문에 취소가 거부되면 사용자가 갇힌다.
  discardBlockedHold(heldBlocked, checkpoint) {
    if (!heldBlocked) return false;
    this.specialistBlocked = null;
    if (!checkpoint || !this.checkpointEngine) return false;
    try {
      return this.checkpointEngine.cleanupCheckpoint(checkpoint)?.ok !== false;
    } catch {
      return false;
    }
  }

  // 취소 메시지가 출처를 말하지 않아, 사용자가 누른 것인지 Agora가 스스로 한 것인지
  // 구분할 수 없었다. 그 때문에 "저절로 취소됐다"는 신고를 한참 추적하고도 원인을
  // 확정하지 못했다. 부르는 쪽이 짧은 출처 문구를 넘겨 메시지가 스스로 밝히게 한다.
  cancelSpecialist(origin = "") {
    // 정책 표는 살아 있는 run에서 취소를 허용한다. 그런데 여기서 active/resume만
    // 보면, 실행이 끝난 뒤 상태만 남은 경우(예: INTERRUPTED로 정리된 run)에
    // "취소할 전문 실행이 없습니다"로 거부해 정책과 실제 동작이 어긋난다.
    // 사용자에게는 "된다고 해놓고 안 되는 버튼"으로 보인다.
    const hasLiveRun = Boolean(
      this.professionalRun &&
      !(this.professionalRun.node === "COMPLETED" && this.professionalRun.status === "COMPLETED")
    );
    if (!this.specialistActive && !this.specialistResume && !hasLiveRun) {
      return { ok: false, error: "취소할 전문 실행이 없습니다." };
    }
    // 실행이 이미 COMPLETED이고 지금 도는 것이 완료 후 Archivist(부가 정리)뿐이면
    // 완료된 run을 INTERRUPTED로 뒤집지 않는다. 정리 턴만 멈추고 완료 상태와
    // 복구 정보(checkpoint 정리 재시도용 등)는 그대로 둔다 — 취소는 "정리를
    // 그만두기"이지 "완료 취소"가 아니다.
    if (this.professionalRun?.node === "COMPLETED" && this.professionalRun?.status === "COMPLETED") {
      this.specialistResume = null;
      this.specialistActive = false;
      this.stopAllSilently();
      this.emitSpecialistState();
      this.appendSystem(`${origin || "사용자가 "}기록 정리(Archivist)를 중지했습니다. 실행 완료 상태는 그대로 유지됩니다.`);
      return { ok: true, cancelled: true };
    }
    const professionalAct = Boolean(
      this.professionalRun &&
      this.professionalRun.status === "RUNNING" &&
      ["IMPLEMENTING", "REVIEWING", "RECORDING"].includes(this.professionalRun.node)
    );
    const runInfo = professionalAct && this.professionalRun?.frozenRunId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(this.professionalRun.frozenRunId, this.meta.workspace)
      : null;
    const taskInfo = professionalAct ? taskFileInfo(this.professionalRun?.taskPath) : null;
    // BLOCKED/INVALID는 status가 RUNNING이 아니라 professionalAct에 걸리지 않는다.
    // 그런데 그 상태의 checkpoint는 specialistBlocked가 들고 있으므로 여기서 함께
    // 집어야 한다. 안 그러면 "취소했습니다"라고 해놓고 BLOCKED 선택지가 계속 떠 있고
    // 백업은 아무도 도달할 수 없는 고아로 디스크에 남는다.
    const heldBlocked = this.specialistBlocked;
    const checkpoint = professionalAct
      ? this.checkpointForProfessionalRun()
      : this.specialistResume?.checkpoint || heldBlocked?.checkpoint || null;
    this.specialistResume = null;
    this.specialistActive = false;
    this.stopAllSilently();
    // ACT 시작 뒤의 중지는 조용한 정리가 아니다. Builder가 남긴 부분 변경과
    // checkpoint를 보존해 사용자가 keep/restore/replan을 선택하게 한다.
    if (professionalAct) {
      const held = this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: this.professionalRun?.node === "REVIEWING"
          ? "review"
          : this.professionalRun?.node === "RECORDING"
            ? "recorder"
            : "implementation",
        round: this.professionalRun?.implementationRound || 1,
        stopReason: "USER_INTERRUPTED",
        message: `${origin || "사용자가 "}전문 실행을 중지했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.`,
      });
      return { ...held, ok: true, cancelled: true };
    }
    if (this.professionalRun) {
      const transition = this.transitionProfessional({ type: "INTERRUPT", stopReason: "USER_INTERRUPTED" });
      if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
      // BLOCKED에서 취소했다면 그 보류 상태와 백업까지 함께 끝낸다. 남겨 두면
      // 취소했다고 알려 놓고 선택지가 계속 뜨고, 백업은 도달 불가한 채 남는다.
      // 정리 실패가 취소를 막지는 않는다(탈출 경로다). 사용자 변경은 그대로 둔다.
      const discardedBackup = this.discardBlockedHold(heldBlocked, checkpoint);
      this.clearRecoveryState();
      this.emitSpecialistState();
      this.appendSystem(
        heldBlocked
          ? `${origin}전문 실행을 취소했습니다. 구현자가 만든 변경은 그대로 남습니다.${
              discardedBackup ? " 작업 전 백업은 정리했습니다." : ""
            }`
          : `${origin}전문 실행을 취소했습니다.`
      );
      return { ok: true, cancelled: true };
    }
    if (checkpoint && this.checkpointEngine) {
      this.checkpointEngine.cleanupCheckpoint(checkpoint);
    }
    this.clearRecoveryState();
    this.emitSpecialistState();
    this.appendSystem(`${origin}전문 실행을 취소했습니다. 현재 작업 결과는 그대로 유지됩니다.`);
    return { ok: true, cancelled: true };
  }

  // 단계별(step) 실행의 다음 단계를 진행합니다.
  //   plan_ready          → Builder 실행 후 phase: builder_done으로 멈춤
  //   builder_done        → Reviewer 실행
  //   review_fix_required → Builder 보완 (step에서는 사용자 확인 후 수동 진행)
  //   review_pass         → Recorder 실행 후 완료
  // Stage D-0 — step 모드 전문 실행도 mutation 참여자다.
  //
  // step은 runExecutionBlock을 타지 않고 이 경로로 직접 freeze·checkpoint 생성·
  // Builder 실행을 한다. 여기에 소유권이 없으면 one-writer 보증이 step 모드에서만
  // 통째로 뚫린다.
  //
  // 소유권 범위는 "이번 phase 실행"이다. step은 각 단계 뒤 사용자 결정을 기다리므로
  // 블록 전체를 쥐면 그 대기 동안 같은 프로젝트의 다른 대화가 무기한 막힌다.
  // 단계 사이에 다른 대화가 workspace를 바꿨는지는 소유권이 아니라 결과물
  // fingerprint(Charter INV-5, D-A)가 잡을 문제다.
  async resumeStepPhase(resume, requestedGeneration, parentToken = null) {
    const lease = this.acquireWorkspaceMutation({
      purpose: "professional-step",
      runId: resume?.runInfo?.runId || null,
      role: "implementation",
      parentToken,
    });
    if (!lease.ok) {
      // 정상 경로에서는 호출자가 이미 소유권을 확보했으므로 여기까지 오지 않는다.
      // 그래도 admission 실패는 "아무것도 시작하지 않은 상태"여야 하므로, 호출자가
      // 소비한 resume 상태를 되돌려 재시도가 가능하게 한다.
      this.specialistResume = this.specialistResume || resume;
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(lease.error);
      return {
        ok: false,
        stage: "implementation",
        completedIterations: 0,
        needsUserDecision: true,
        stopReason: "WORKSPACE_BUSY",
      };
    }
    try {
      return await this.resumeStepPhaseInner(resume, requestedGeneration);
    } finally {
      this.releaseWorkspaceMutation(lease.token);
    }
  }

  async resumeStepPhaseInner(resume, requestedGeneration) {
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
      if (runInfo) {
        const check = this.validateFrozenTask(runInfo);
        if (!check.ok) {
          const error = new Error(check.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
        return runInfo;
      }
      if (taskInfo) {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
        const check = this.validateFrozenTask(runInfo);
        if (!check.ok) {
          const error = new Error(check.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
      }
      // Stage D — 실행 계약과 함께 검사 계약도 동결한다(INV-1).
      // checkpoint·Builder 같은 되돌릴 수 없는 상태를 소비하기 **전에** 수행한다.
      // block 경로와 동일한 순서이며, step만 예외를 두지 않는다(B1).
      const assuranceGate = this.beginAssurance({
        runInfo,
        stage: "implementation",
        round: 1,
        lineage: this.professionalLineage(),
      });
      if (!assuranceGate.ok) {
        const error = new Error("확인 계약을 준비하지 못했습니다.");
        error.code = "ASSURANCE_BLOCKED";
        error.failure = assuranceGate.failure;
        throw error;
      }

      // Checkpoint 생성 전 저널을 먼저 남겨, 생성 중 종료도 자동 재개하지 않고
      // 사용자 선택 상태로 복원할 수 있게 합니다.
      const recoveryContext = {
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
      };
      if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(null, {
        ...recoveryContext,
        status: "checkpointing",
      }))) {
        throw new Error("복구 저널을 저장하지 못했습니다.");
      }
      // TASK-006: Builder 실행 직전 workspace 상태 보존 (지원 시).
      if (!checkpoint && this.checkpointEngine) {
        checkpoint = await this.checkpointEngine.createCheckpoint(workspace, {
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: runInfo?.runId || null,
        });
      }
      // Git 저장소인데 백업 생성에 실패하면(non-Git과 구분되는 failed) 복원
      // 수단 없이 진행하지 않고 중단한다.
      if (checkpoint?.failed === true) {
        this.clearRecoveryState();
        const error = new Error("작업 전 상태 백업(checkpoint)을 만들지 못했습니다.");
        error.code = "CHECKPOINT_FAILED";
        throw error;
      }
      if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(checkpoint, {
        ...recoveryContext,
        status: "running",
      }))) {
        throw new Error("복구 저널을 저장하지 못했습니다.");
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
      this.persistRecoveryState(this.recoveryFor(checkpoint, {
        status: "blocked",
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
        blockReason: stopReason,
      }));
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
          if (error?.code === "FROZEN_TASK_CORRUPTED") {
            return this.holdForFrozenTaskCorruption({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "implementation",
              round: 0,
              error: error.message,
            });
          }
          if (error?.code === "CHECKPOINT_FAILED") {
            this.appendSystem("작업 전 상태 백업(checkpoint)을 만들지 못해 전문 실행을 시작하지 않았습니다. 워크스페이스의 Git 상태를 확인해 주세요.");
            return { ok: false, stage: "implementation", completedIterations: 0, needsUserDecision: true, stopReason: "CHECKPOINT_FAILED" };
          }
          if (error?.code === "ASSURANCE_BLOCKED") {
            // beginAssurance가 이미 사용자에게 사유를 알리고 상태를 정리했다.
            return error.failure;
          }
          if (error?.code === "TASK_CONTRACT_INCOMPLETE") {
            const missing = error?.missing || error?.contractCheck?.missing || [];
            const missingStr = missing.length > 0 ? missing.join(", ") : "필수 섹션 누락 또는 내용 없음";
            const transition = this.transitionProfessional({
              type: "TASK_CONTRACT_INCOMPLETE",
              missingSections: missing,
            });
            if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
            this.specialistResume = {
              stages,
              mode: resume.mode,
              phase: "task_contract_incomplete",
              taskInfo: taskInfo || null,
              feedback: feedback || (taskInfo?.content || ""),
              missingSections: missing,
              taskError: error?.message || `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${missingStr}`,
              maxAutoRevisions,
            };
            this.emitSpecialistState();
            this.appendSystem(
              `동결된 Task의 계약이 불완전해 실행을 중단합니다.\n누락되거나 내용이 없는 필수 섹션: ${missingStr}\n\n필수 6개 섹션(Goal, Requirements, Implementation Approach, Acceptance Criteria, Verification, Out of Scope)과 본문 설명이 필요합니다.\n기획을 보완하려면 수정 사항을 입력해 주세요.`
            );
            return {
              ok: false,
              stage: "planner",
              completedIterations: 0,
              needsUserDecision: true,
              stopReason: "TASK_CONTRACT_INCOMPLETE",
              taskError: error?.message || `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${missingStr}`,
              missingSections: missing,
            };
          }
          this.appendSystem(`Frozen Task를 만들지 못해 실행을 중단합니다. (${error?.message || "알 수 없는 오류"})`);
          return { ok: false, stage: "planner", completedIterations: 0, needsUserDecision: true, stopReason: "FROZEN_TASK_MISSING", taskError: error?.message || "알 수 없는 오류" };
        }
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            error: frozenCheck.error,
          });
        }
        // Builder 실행.
        let builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 1, maxRounds: 1, feedback: runInfo ? "" : feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterBuilder = this.validateFrozenTask(runInfo);
        if (!frozenAfterBuilder.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            error: frozenAfterBuilder.error,
          });
        }
        if (!builderResult?.ok && builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            stopReason: builderResult.stopReason,
            result: builderResult,
            message: "구현 프롬프트가 허용된 크기를 넘어 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        if (!builderResult?.ok) return this.specialistFail(implementation, "implementation", 1, builderResult);
        // 선언 누락·모순은 사용자 결정이 아니라 출력 계약 실패다. 읽기 전용으로 한 번 다시 청한다.
        builderResult = await this.repairBuilderStatus(implementation, builderResult, requestedGeneration, frozenTaskMeta());
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(1, builderResult, builderResult.builderStatus);
        // 구현 완료 → 사용자 확인 대기.
        const changeSnapshot = await describeWorkspaceChanges(workspace, {
          checkpoint,
          excludePaths: runGeneratedPaths(workspace, runInfo),
        });
        if (changeSnapshot.diff.status === "FAILED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            stopReason: "DIFF_COLLECTION_FAILED",
            result: { changes: changeSnapshot.diff },
            message: "변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        // Stage D — 결과물 snapshot 확정 + 동결된 검사 실행(INV-5 · D-A2).
        // 사용자를 기다리기 **전에** 수행한다. 대기 중 결과물이 바뀌면 판정 직전
        // 재확인이 그것을 잡아낸다. 보완 실행에서도 같은 지점이 다시 돈다(B4).
        const stepVerification = await this.runAssuranceVerification({
          changeSnapshot,
          permission: implementation.permission,
          runInfo,
        });
        if (stepVerification && stepVerification.ok === false) {
          return this.holdForAssuranceBlocked({
            runInfo,
            taskInfo,
            checkpoint,
            round: 1,
            changes: changeSnapshot,
            final: {
              verdict: "BLOCKED",
              blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: stepVerification.error || null }],
            },
          });
        }

        this.specialistResume = {
          ...resume,
          phase: "builder_done",
          runInfo,
          checkpoint,
          builderChanges: changeSnapshot.text,
          builderDiff: changeSnapshot.diff,
          builderEvidence: builderResult.evidence || null,
          builderTransport: builderResult.transport || "COMPLETED",
          builderStatus: builderResult.builderStatus || "MISSING",
          builderRunId: builderResult.runId || null,
        };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("구현이 완료되었습니다. 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 1, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      if (resume.phase === "builder_done") {
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            error: frozenCheck.error,
          });
        }
        const stepBuilderResult = {
          ok: true,
          runId: resume.builderRunId || null,
          evidence: resume.builderEvidence || null,
          transport: resume.builderTransport || "COMPLETED",
          builderStatus: resume.builderStatus || "MISSING",
        };
        const stepEvidence = this.prepareReviewEvidence({
          runInfo,
          builderResult: stepBuilderResult,
          diff: resume.builderDiff || { status: "NO_CHANGES" },
          round: 1,
          provider: implementation.agent.id,
        });
        if (!stepEvidence.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            stopReason: "EVIDENCE_WRITE_FAILED",
            result: { evidence: stepEvidence.payload },
            message: "실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        // Reviewer 실행.
        const reviewResult = await this.scheduleResponse(review.agent, {
          specialist: {
            stage: "review",
            round: 1,
            maxRounds: 1,
            frozenTask: frozenTaskMeta(),
            reviewDiff: resume.builderChanges || "",
            changes: resume.builderDiff?.status || "UNSUPPORTED",
            axes: this.executionAxes({ builderResult: stepBuilderResult, diff: resume.builderDiff }),
            evidence: stepEvidence.payload,
            // Stage D §19 — step에서도 Reviewer는 Agora가 확인한 것과 확인하지
            // 못한 것을 함께 받는다. block 경로와 같은 payload다.
            assurance: this.assuranceReviewPayload(runInfo),
          },
          agentConfig: review.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterReview = this.validateFrozenTask(runInfo);
        if (!frozenAfterReview.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            error: frozenAfterReview.error,
          });
        }
        if (!reviewResult?.ok) {
          if (reviewResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "review",
              round: 1,
              stopReason: reviewResult.stopReason,
              result: reviewResult,
              message: "검수 프롬프트가 허용된 크기를 넘어 검수를 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
            });
          }
          return this.specialistFail(review, "review", 1, reviewResult);
        }
        const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
        if (contract.verdict === "PASS") {
          // Stage D §18 — step에서도 Reviewer의 PASS만으로 Run이 통과하지 않는다.
          // 자동검사 FAIL·미해결 항목·결과물 변경이 남으면 여기서 막힌다(B1).
          const stepFinal = this.applyReviewerAssuranceVerdict(contract, runInfo);
          if (stepFinal && !stepFinal.finalPass) {
            retainCheckpoint = Boolean(checkpoint?.supported);
            return this.holdForAssuranceBlocked({
              runInfo,
              taskInfo,
              checkpoint,
              round: 1,
              changes: resume.builderDiff,
              final: stepFinal,
              // 승인만 남았다면 기록 단계로 이어질 수 있어야 한다(B5).
              stages,
              mode: resume.mode,
            });
          }
          if (this.strictReviewDiff && resume.builderDiff?.status === "UNSUPPORTED") {
            const degraded = this.holdForDegradedReview({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "review",
              round: 1,
              changes: resume.builderDiff,
              review: reviewResult,
            });
            retainCheckpoint = Boolean(checkpoint?.supported);
            return { ...degraded, contract };
          }
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
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 2,
            error: frozenCheck.error,
          });
        }
        // Builder 보완 후 다시 검토.
        let builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 2, maxRounds: 1, feedback: resume.reviewText || feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterRevision = this.validateFrozenTask(runInfo);
        if (!frozenAfterRevision.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 2,
            error: frozenAfterRevision.error,
          });
        }
        if (!builderResult?.ok) {
          if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "implementation",
              round: 2,
              stopReason: builderResult.stopReason,
              result: builderResult,
              message: "구현 프롬프트가 허용된 크기를 넘어 보완을 시작하지 못했습니다. 기존 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
            });
          }
          return this.specialistFail(implementation, "implementation", 2, builderResult);
        }
        // 선언 누락·모순은 사용자 결정이 아니라 출력 계약 실패다. 읽기 전용으로 한 번 다시 청한다.
        builderResult = await this.repairBuilderStatus(implementation, builderResult, requestedGeneration, frozenTaskMeta());
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(2, builderResult, builderResult.builderStatus);
        const changeSnapshot = await describeWorkspaceChanges(workspace, {
          checkpoint,
          excludePaths: runGeneratedPaths(workspace, runInfo),
        });
        if (changeSnapshot.diff.status === "FAILED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 2,
            stopReason: "DIFF_COLLECTION_FAILED",
            result: { changes: changeSnapshot.diff },
            message: "보완 후 변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        // Stage D — 결과물 snapshot 확정 + 동결된 검사 실행(INV-5 · D-A2).
        // 사용자를 기다리기 **전에** 수행한다. 대기 중 결과물이 바뀌면 판정 직전
        // 재확인이 그것을 잡아낸다. 보완 실행에서도 같은 지점이 다시 돈다(B4).
        const stepVerification = await this.runAssuranceVerification({
          changeSnapshot,
          permission: implementation.permission,
          runInfo,
        });
        if (stepVerification && stepVerification.ok === false) {
          return this.holdForAssuranceBlocked({
            runInfo,
            taskInfo,
            checkpoint,
            round: 1,
            changes: changeSnapshot,
            final: {
              verdict: "BLOCKED",
              blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: stepVerification.error || null }],
            },
          });
        }

        this.specialistResume = {
          ...resume,
          phase: "builder_done",
          runInfo,
          checkpoint,
          builderChanges: changeSnapshot.text,
          builderDiff: changeSnapshot.diff,
          builderEvidence: builderResult.evidence || null,
          builderTransport: builderResult.transport || "COMPLETED",
          builderStatus: builderResult.builderStatus || "MISSING",
          builderRunId: builderResult.runId || null,
        };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("보완이 완료되었습니다. 다시 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 2, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      // 승인 대기 중에는 그냥 진행할 수 없다. Reviewer도 Builder도 이 관문을
      // 우회하지 못하며, 사용자가 승인해야 phase가 review_pass로 바뀐다(§20).
      if (resume.phase === "awaiting_human_approval") {
        const pending = this.pendingHumanApprovals(runInfo);
        this.specialistResume = resume;
        this.specialistActive = false;
        this.emitSpecialistState();
        this.appendSystem("아직 승인하지 않은 항목이 있어 기록을 시작하지 않았습니다.");
        return {
          ok: false,
          stage: "review",
          completedIterations: 1,
          needsUserDecision: true,
          stopReason: "HUMAN_APPROVAL_REQUIRED",
          pendingApprovals: pending,
        };
      }

      if (resume.phase === "review_pass") {
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "recorder",
            round: 1,
            error: frozenCheck.error,
          });
        }
        // Stage D §16 — 기록·완료 직전에 마지막으로 재확인한다. 승인 이후에도
        // 결과물이 바뀔 수 있고, 그러면 그 승인은 이 결과물에 대한 것이 아니다.
        const finalBeforeRecord = this.finalizeAssurance(runInfo);
        if (finalBeforeRecord && !finalBeforeRecord.finalPass) {
          return this.holdForAssuranceBlocked({
            runInfo,
            taskInfo,
            checkpoint,
            round: 1,
            changes: resume.builderDiff,
            final: finalBeforeRecord,
            stages,
            mode: resume.mode,
          });
        }

        // 승인으로 재개된 실행은 professional FSM의 남은 전이를 이어받는다.
        // 이것이 없으면 승인 후 Run이 REVIEWING에 영원히 남는다(B5).
        if (resume.resumedFromApproval && this.professionalRun) {
          this.transitionProfessional({ type: "REVIEW_PASS" });
          if (this.professionalRun?.status === "WAITING") {
            this.transitionProfessional({ type: "USER_CONTINUE_RECORD" });
          }
        }

        // Recorder 실행 후 완료.
        let recorderResult = null;
        if (recorder?.agent) {
          recorderResult = await this.scheduleResponse(recorder.agent, {
            specialist: {
              stage: "recorder",
              professional: true,
              round: 1,
              maxRounds: 1,
              frozenTask: frozenTaskMeta(),
              reviewDiff: resume.builderChanges || "",
              finalVerdict: "PASS",
              evidence: resume.builderEvidence || null,
            },
            agentConfig: recorder.agentConfig,
          });
          if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
          if (!recorderResult?.ok) {
            this.specialistActive = false;
            const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
            this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
            return { ok: true, completedIterations: 1, recorded: false, recording: recorderResult?.text || "", recordError };
          }
        } else {
          // 기록은 이 실행의 산출물 중 하나다. 담당자가 없다고 조용히 건너뛰면
          // 사용자는 "통과했습니다"만 보고 기록이 빠진 것을 모른다.
          this.appendSystem("기록 담당자가 지정되지 않아 이번 실행의 기록을 남기지 못했습니다. 프로젝트 설정에서 지정한 뒤 \"기록 다시 생성\"으로 남길 수 있습니다.");
        }
        // Stage D-C — step에서도 Recorder 결과가 provenance 사슬을 닫는다(§26).
        this.recordAssuranceRecorder({ runInfo, ok: Boolean(recorderResult?.ok) });
        if (resume.resumedFromApproval && this.professionalRun) {
          this.transitionProfessional({ type: "RECORDER_DONE" });
        }
        this.specialistActive = false;
        this.appendSystem("전문 모드 구현·검토·기록이 완료되었습니다.");
        return { ok: true, completedIterations: 1, recorded: Boolean(recorderResult?.ok), recording: recorderResult?.text || "" };
      }

      this.specialistActive = false;
      return { ok: false, error: "알 수 없는 단계입니다." };
    } finally {
      this.specialistActive = false;
      if (!retainCheckpoint && !this.specialistBlocked) {
        cleanupCheckpoint();
        this.clearRecoveryState();
      }
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // Stage D-0 — 전문 실행의 mutation~판정 구간은 workspace 소유권을 블록 전체에서
  // 쥔다. turn 단위로 잡으면 Builder와 Reviewer 사이의 틈으로 다른 대화의 변경이
  // 끼어들 수 있고, 그러면 Reviewer가 보는 변경과 실제 workspace가 어긋난다.
  // 블록 안의 checkpoint restore는 같은 holder의 재진입이라 별도로 잡지 않는다.
  async runExecutionBlock(args = {}) {
    const lease = this.acquireWorkspaceMutation({
      purpose: "professional-execution",
      runId: args.resumedRun?.runId || null,
      role: "implementation",
      // 호출자가 이미 소유권을 쥐고 있으면(예: resume admission) 그 안의 중첩이다.
      parentToken: args.parentToken || null,
    });
    if (!lease.ok) {
      this.appendSystem(lease.error);
      return { ok: false, error: lease.error, stopReason: "WORKSPACE_BUSY" };
    }
    try {
      return await this.runExecutionBlockInner(args);
    } finally {
      this.releaseWorkspaceMutation(lease.token);
    }
  }

  // Builder → Reviewer → (auto면 자동 보완) → 기록관(블록 끝) 실행 블록.
  async runExecutionBlockInner({ stages, mode, maxAutoRevisions, feedback, taskInfo, round, requestedGeneration, recordAfter = true, allowUnprotected = false, checkpointFailReason = null, resumedRun = null }) {
    const implementation = stages.implementation;
    const review = stages.review;
    const recorder = stages.recorder;
    // 자동 진행 모드여도 사용자가 보완 횟수를 허용한 경우에만 재실행합니다.
    const canAutoRevise =
      (mode === "auto" || mode === "quick") && maxAutoRevisions > 0;
    const maxRounds = canAutoRevise ? maxAutoRevisions + 1 : 1;
    let autoRevisionCount = 0;
    // V1.5 — 검토 PASS + HANDOFF: @recorder(Archivist 정리 요청) 기억.
    // 실행 완료 후 사람이 읽기 좋은 정리를 추가 호출한다.
    let archivistRequested = false;
    let recorderResult = null;
    // TASK-008: Builder가 만든 실제 변경(Diff)을 수집해 Reviewer에게 전달합니다.
    // 각 Builder 실행 직후 갱신되며, 검토자는 이 Diff를 Frozen Task와 함께 받습니다.
    let builderChanges = "";
    let changeSnapshot = null;
    let reviewEvidence = null;

    // TASK-007: 실행 계약(Freeze)을 checkpoint보다 먼저 수행합니다.
    // 실행 순서: Task 승인 → Run 생성/Freeze → Checkpoint → Builder
    // - runInfo가 이미 있으면(같은 Run의 자동 보완) 재freeze하지 않고 재사용합니다.
    // - Planner Task(inline 포함)든 수동 Task든 하나의 RUN/task.md로 정규화합니다.
    // - Frozen Task 누락/손상 시 현재 TASK.md로 fallback 하지 않고 중단합니다.
    let runInfo = resumedRun || null;
    const workspace = this.meta.workspace;
    if (taskInfo && !resumedRun) {
      try {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          const error = new Error(frozenCheck.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
      } catch (error) {
        if (error?.code === "FROZEN_TASK_CORRUPTED") {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            stage: "implementation",
            round,
            error: error.message,
          });
        }
        if (error?.code === "TASK_CONTRACT_INCOMPLETE") {
          const missing = error?.missing || error?.contractCheck?.missing || [];
          const missingStr = missing.length > 0 ? missing.join(", ") : "필수 섹션 누락 또는 내용 없음";
          const transition = this.transitionProfessional({
            type: "TASK_CONTRACT_INCOMPLETE",
            missingSections: missing,
          });
          if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
          this.specialistResume = {
            stages,
            mode,
            phase: "task_contract_incomplete",
            taskInfo: taskInfo || null,
            feedback: feedback || (taskInfo?.content || ""),
            missingSections: missing,
            taskError: error?.message || `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${missingStr}`,
            maxAutoRevisions,
          };
          this.emitSpecialistState();
          this.appendSystem(
            `동결된 Task의 계약이 불완전해 실행을 중단합니다.\n누락되거나 내용이 없는 필수 섹션: ${missingStr}\n\n필수 6개 섹션(Goal, Requirements, Implementation Approach, Acceptance Criteria, Verification, Out of Scope)과 본문 설명이 필요합니다.\n기획을 보완하려면 수정 사항을 입력해 주세요.`
          );
          return {
            ok: false,
            stage: "planner",
            completedIterations: 0,
            needsUserDecision: true,
            stopReason: "TASK_CONTRACT_INCOMPLETE",
            taskError: error?.message || `실행 계약(Task)에 필수 섹션이 빠졌습니다: ${missingStr}`,
            missingSections: missing,
          };
        }
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

    // Stage D — 실행 계약과 함께 **검사 계약도** 동결한다(INV-1).
    // 되돌릴 수 없는 상태(checkpoint·Builder)를 소비하기 전에 수행한다.
    // v1 Task는 legacy 모드로 통과하며 아무것도 막지 않는다(Charter §6).
    const assuranceGate = this.beginAssurance({
      runInfo,
      stage: "implementation",
      round,
      lineage: this.professionalLineage(),
    });
    if (!assuranceGate.ok) return assuranceGate.failure;

    // TASK-006: Builder 실행 직전 workspace 상태를 보존합니다.
    // 지원되지 않는 workspace(git 아님/없음)라면 checkpoint를 만들지 않고 진행합니다.
    if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(null, {
      status: "checkpointing",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage: "implementation",
    }))) {
      this.appendSystem("복구 저널을 저장하지 못해 전문 실행을 시작할 수 없습니다.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "RECOVERY_JOURNAL_WRITE_FAILED",
      };
    }
    // 무보호 실행(사용자 승인)이면 checkpoint 생성을 건너뛰고 그대로 진행한다.
    const checkpoint = allowUnprotected
      ? null
      : this.checkpointEngine
        ? await this.checkpointEngine.createCheckpoint(this.meta.workspace, {
            storageRoot: this.checkpointRoot,
            sessionId: this.sessionId,
            runId: runInfo?.runId || null,
          })
        : null;
    // Git 저장소인데 백업 생성에 실패한 경우(failed)에는 non-Git처럼 그냥
    // 진행하지 않는다. 복원 수단 없이 Builder가 파일을 바꾸는 것을 막고,
    // 변경 없이 안전하게 멈춰 사용자에게 알린다.
    if (checkpoint?.failed === true) {
      // checkpoint 생성 실패 시 사용자에게 3가지 선택지를 제시하고 대기한다.
      // 1) 재시도(retry) 2) 무보호 진행(proceed_unprotected) 3) 취소(cancel)
      const checkpointReason = checkpoint.reason || "CHECKPOINT_GIT_FAILED";
      const failedTransition = this.transitionProfessional({
        type: "CHECKPOINT_FAILED",
        checkpointFailReason: checkpointReason,
      });
      if (!failedTransition.ok) return this.professionalTransitionFailure("implementation", failedTransition);
      // recovery 저널은 checkpointing 상태로 남긴다(사용자 선택 후 재시도/정리).
      this.specialistResume = {
        phases: stages,
        mode,
        phase: "checkpoint_failed",
        runInfo,
        checkpoint,
        checkpointFailReason: checkpointReason,
        round,
        requestedGeneration,
        // 재개 시 원래 실행 context를 그대로 복원해야 canonical Task 상태가
        // 갱신된다. taskInfo가 빠지면 재시도 실행이 workflow 인덱스를 전혀
        // 갱신하지 않은 채 성공한 것처럼 끝난다.
        taskInfo: taskInfo || null,
        feedback: feedback || "",
        maxAutoRevisions,
      };
      this.emitSpecialistState();
      this.appendSystem(
        `작업 전 상태 백업(checkpoint)을 만들지 못했습니다. (${checkpointReason}: ${describeCheckpointFailure(checkpointReason)})
아래에서 다음 처리를 선택해 주세요.
1) 재시도 — 백업을 다시 만든 뒤 Builder를 시작합니다
2) 무보호 진행 — 백업 없이 실행합니다(사전 스냅샷이 없어 회귀 검증 신뢰도가 제한됩니다)
3) 취소 — 전문 실행을 중단합니다`
      );
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "CHECKPOINT_FAILED",
      };
    }
    if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "running",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage: "implementation",
    }))) {
      if (checkpoint?.supported && this.checkpointEngine) this.checkpointEngine.cleanupCheckpoint(checkpoint);
      this.appendSystem("복구 저널을 저장하지 못해 전문 실행을 시작할 수 없습니다.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "RECOVERY_JOURNAL_WRITE_FAILED",
      };
    }
    const executeTransition = this.transitionProfessional({
      type: "USER_EXECUTE",
      frozenRunId: runInfo?.runId || null,
      checkpointId: checkpoint?.checkpointId || null,
      // 무보호/비정상 실행의 실패 원인을 구분해 넘긴다. FSM은 이 값을
      // evidence까지 이어가므로 여기서 빠지면 실패 원인이 null로 덮인다.
      checkpointFailReason: checkpointFailReason || null,
      // checkpoint가 없는(비-Git 등) 비보호 실행 사유를 record 한다.
      // supported=true면 protected, supported=false(비-Git)면 unavailable_non_git.
      // allowUnprotected(사용자 명시 승인)면 unavailable_user_approved를 우선한다.
      checkpointProtection: allowUnprotected
        ? "unavailable_user_approved"
        : checkpoint?.supported === true
          ? "protected"
          : "unavailable_non_git",
    });
    if (!executeTransition.ok) {
      if (checkpoint?.supported && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
      this.clearRecoveryState();
      return this.professionalTransitionFailure("implementation", executeTransition);
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      taskHash: runInfo?.taskHash || null,
      status: "in_progress",
      activeRunId: runInfo?.runId || null,
      lastRunId: null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        message: "작업 목록 상태를 저장하지 못해 구현을 시작하지 않았습니다. 복구 정보는 그대로 유지합니다.",
      });
    }

    this.appendSystem(`구현·검수 시작 · 구현 @${implementation.agent.id} · 검수 @${review.agent.id}`);

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
      const result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, checkpoint, {
        preservePaths: runGeneratedPaths(workspace, runInfo),
      });
      this.notifyWorkspaceRestoreOutcome(result);
      if (result?.ok) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
        this.clearRecoveryState();
        return result;
      }
      this.appendSystem("작업 전 상태로 되돌리지 못했습니다. 변경과 복구 저널을 그대로 유지합니다.");
      return result || { ok: false, reason: "restore-failed" };
    };
    const cleanupCheckpoint = () => {
      if (checkpointSupported && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
    };
    // 새 PLAN → ACT 경로는 ACT 중 생긴 실패를 자동 복원으로 숨기지 않는다.
    // legacy step/auto/quick은 기존 동작을 유지하고, professionalRun이 있는
    // 실행만 변경·checkpoint를 남긴 BLOCKED 상태로 전환한다.
    const holdProfessionalFailure = ({ stage, stopReason, result = null, changes = null, message }) => {
      if (!this.professionalRun) return null;
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage,
        round,
        stopReason,
        result,
        changes: changes || changeSnapshot,
        message,
      });
    };
    const validateForStage = (stage, currentRound) => {
      const frozenCheck = this.validateFrozenTask(runInfo);
      if (frozenCheck.ok) return null;
      return this.holdForFrozenTaskCorruption({
        runInfo,
        taskInfo,
        checkpoint,
        stage,
        round: currentRound,
        error: frozenCheck.error,
      });
    };

    // BLOCKED(A안): 즉시 되돌리지 않고 Builder 작업물을 그대로 둔 채 멈춥니다.
    // 사용자가 [작업 전으로 복원]/[Task 폐기]를 고르면 그때 복원합니다.
    const holdForBlocked = (blockedRound, blockedResult, declaration = "BLOCKED") => {
      const stopReason = declaration === "MISSING"
        ? "BUILDER_STATUS_MISSING"
        : declaration === "AMBIGUOUS"
          ? "BUILDER_STATUS_AMBIGUOUS"
          : "BLOCKED";
      this.transitionProfessional({
        type: "BUILDER_BLOCKED",
        blockReason: stopReason,
      });
      this.persistBlockedRun({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round: blockedRound,
        stopReason,
        result: blockedResult,
        changes: changeSnapshot,
      });
      this.specialistBlocked = {
        checkpoint: checkpointSupported ? checkpoint : null,
        canRestore: checkpointSupported,
        taskPath: taskInfo?.relativePath || null,
        runId: runInfo?.runId || null,
        stage: "implementation",
        blockReason: stopReason,
      };
      this.persistRecoveryState(this.recoveryFor(checkpoint, {
        status: "blocked",
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
        blockReason: stopReason,
      }));
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

    const frozenBeforeBuilder = validateForStage("implementation", round);
    if (frozenBeforeBuilder) return frozenBeforeBuilder;
    let builderResult = await this.scheduleResponse(implementation.agent, {
      specialist: {
        stage: "implementation",
        round,
        maxRounds,
        controlOutputs: true,
        // TASK-007: 최초 Builder의 실행 계약 source는 Frozen Task입니다.
        // (자동 보완에서는 아래에서 Reviewer 피드백도 별도로 전달합니다.)
        feedback: runInfo ? "" : feedback,
        frozenTask: frozenTaskMeta(),
      },
      agentConfig: implementation.agentConfig,
    });
    const frozenAfterBuilder = validateForStage("implementation", round);
    if (frozenAfterBuilder) return frozenAfterBuilder;
    // Builder 실행이 끝난 뒤 실제 변경분을 수집합니다. (git 아니면 빈 값)
    changeSnapshot = await describeWorkspaceChanges(workspace, {
      checkpoint,
      excludePaths: runGeneratedPaths(workspace, runInfo),
    });
    builderChanges = changeSnapshot.text;
    if (changeSnapshot.diff.status === "FAILED") {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "DIFF_COLLECTION_FAILED",
        result: { changes: changeSnapshot.diff },
        message: "변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
      });
    }
    if (requestedGeneration !== this.generation) {
      if (!this.professionalRun) cleanupCheckpoint();
      return { ok: false, cancelled: true };
    }
    if (!builderResult?.ok) {
      if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          stopReason: builderResult.stopReason,
          result: builderResult,
          message: "구현 프롬프트가 허용된 크기를 넘어 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
      const held = holdProfessionalFailure({
        stage: "implementation",
        stopReason: builderResult.stopReason || "TRANSPORT_FAILED",
        result: builderResult,
        message: "구현 에이전트가 끝나기 전에 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
      });
      if (held) return held;
      await restoreCheckpoint();
      return this.specialistFail(implementation, "implementation", round, builderResult);
    }
    builderResult = await this.repairBuilderStatus(implementation, builderResult, requestedGeneration, frozenTaskMeta());
    // V1.5 — 구현자의 routing 축 소비. DONE + HANDOFF: @reviewer는 기본
    // 흐름과 같고, BLOCKED + HANDOFF: @planner(재기획 요청)는 수용하되
    // 작업물 keep/restore 선택은 기존대로 사용자 몫이다(INV-5 — BLOCKED
    // 자동 진행 금지).
    const builderControl = this.consumeControlRequest({
      contract: "implementation",
      result: builderResult.builderStatus,
      outcome: builderResult,
    });
    if (builderResult.builderStatus !== "DONE") {
      if (
        builderControl.accepted &&
        builderControl.control?.action === "HANDOFF" &&
        builderControl.control.targetRole === "planner"
      ) {
        this.appendSystem(
          "구현자가 재기획(HANDOFF: @planner)을 요청했습니다. 아래에서 작업물을 유지하거나 복원하며 재기획으로 이어 주세요."
        );
      }
      return holdForBlocked(round, builderResult, builderResult.builderStatus);
    }
    const builderTransition = this.transitionProfessional({ type: "BUILDER_DONE" });
    if (!builderTransition.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round,
        stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
        result: builderTransition,
        message: "구현은 끝났지만 실행 상태를 저장하지 못해 검수를 시작하지 않았습니다. 변경은 그대로 남아 있습니다.",
      });
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      taskHash: runInfo?.taskHash || null,
      status: "review",
      activeRunId: runInfo?.runId || null,
      lastRunId: null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        changes: changeSnapshot,
        message: "작업 목록 상태를 저장하지 못해 검수를 시작하지 않았습니다. 변경과 복구 정보는 그대로 유지합니다.",
      });
    }
    // Stage D — Builder가 만든 실제 결과물에 대해 동결된 검사를 수행한다.
    // 여기서 나온 판정은 모두 이 시점의 결과물 snapshot에 귀속된다(INV-5).
    const firstVerification = await this.runAssuranceVerification({
      changeSnapshot,
      permission: implementation.permission,
      runInfo,
    });
    if (firstVerification && firstVerification.ok === false) {
      return this.holdForAssuranceBlocked({
        runInfo,
        taskInfo,
        checkpoint,
        round,
        changes: changeSnapshot,
        final: {
          verdict: "BLOCKED",
          blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: firstVerification.error || null }],
        },
      });
    }

    reviewEvidence = this.prepareReviewEvidence({
      runInfo,
      builderResult,
      diff: changeSnapshot.diff,
      round,
      provider: implementation.agent.id,
    });
    if (!reviewEvidence.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "EVIDENCE_WRITE_FAILED",
        result: { evidence: reviewEvidence.payload },
        message: "실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
      });
    }

    // 검토 → (자동 보완) 루프.
    while (true) {
      const frozenBeforeReview = validateForStage("review", round);
      if (frozenBeforeReview) return frozenBeforeReview;
      const reviewResult = await this.scheduleResponse(review.agent, {
        specialist: {
          stage: "review",
          round,
          maxRounds,
          controlOutputs: true,
          // TASK-007: Reviewer는 동일 Run의 Frozen Task + 실제 Diff + Test 기준으로 검수합니다.
          frozenTask: frozenTaskMeta(),
          // TASK-008: Builder가 실제로 만든 변경(Diff)을 주입합니다.
          reviewDiff: builderChanges,
          changes: changeSnapshot.diff?.status || "UNSUPPORTED",
          axes: {
            ...this.executionAxes({ builderResult, diff: changeSnapshot.diff }),
          },
          evidence: reviewEvidence.payload,
          // Stage D §19 — Builder의 주장만 보여주지 않는다. 무엇이 자동으로
          // 확정됐고 무엇이 Reviewer 판단으로 남았는지, 무엇이 강등됐는지 함께 준다.
          assurance: this.assuranceReviewPayload(),
        },
        agentConfig: review.agentConfig,
      });
      if (requestedGeneration !== this.generation) {
        if (!this.professionalRun) cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!reviewResult?.ok) {
        if (reviewResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: reviewResult.stopReason,
            result: reviewResult,
            message: "검수 프롬프트가 허용된 크기를 넘어 검수를 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: reviewResult.stopReason || "TRANSPORT_FAILED",
          result: reviewResult,
          message: "검수 에이전트가 끝나기 전에 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return this.specialistFail(review, "review", round, reviewResult);
      }
      const frozenAfterReview = validateForStage("review", round);
      if (frozenAfterReview) return frozenAfterReview;

      const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
      // V1.5 — 검토자의 routing 축 소비. PASS + COMPLETE는 완료 전제조건
      // (assurance 최종 판정 등 아래 기존 경로)을 그대로 지나고,
      // PASS + HANDOFF: @recorder는 완료 후 Archivist 정리 요청으로 남는다.
      const reviewControl = this.consumeControlRequest({
        contract: "review",
        result: contract.verdict,
        outcome: reviewResult,
      });
      if (
        reviewControl.accepted &&
        reviewControl.control?.action === "HANDOFF" &&
        reviewControl.control.targetRole === "recorder"
      ) {
        archivistRequested = true;
      }
      if (
        reviewControl.accepted &&
        reviewControl.control?.action === "HANDOFF" &&
        reviewControl.control.targetRole === "planner" &&
        contract.verdict === "FIX_REQUIRED"
      ) {
        // 검토자가 계획 문제로 재기획을 요청했다 — 같은 계약으로 Builder
        // 보완을 반복하는 것은 요청과 어긋나므로 자동 보완을 멈추고
        // 사용자에게 돌린다(재기획 시작은 기존 명시 액션·INV-5).
        contract.canAutoRevise = false;
        this.appendSystem(
          "검토자가 재기획(HANDOFF: @planner)을 요청해 자동 보완을 멈춥니다. '다시 기획'으로 이어 주세요."
        );
      }
      if (contract.verdict === "PASS") {
        // Stage D §18 — Reviewer의 PASS만으로 Run이 통과하지 않는다.
        // 자동검사 FAIL·미해결 항목·결과물 변경이 남아 있으면 여기서 막힌다.
        const assuranceFinal = this.applyReviewerAssuranceVerdict(contract);
        if (assuranceFinal && !assuranceFinal.finalPass) {
          return this.holdForAssuranceBlocked({
            runInfo,
            taskInfo,
            checkpoint,
            round,
            changes: changeSnapshot,
            final: assuranceFinal,
            // block/auto도 승인만 남았다면 기록 단계로 이어질 수 있어야 한다(B5).
            stages,
            mode,
          });
        }
        if (this.strictReviewDiff && changeSnapshot.diff.status === "UNSUPPORTED") {
          return this.holdForDegradedReview({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            changes: changeSnapshot.diff,
            review: reviewResult,
          });
        }
        const transition = this.transitionProfessional({ type: "REVIEW_PASS" });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
            message: "검수는 통과했지만 실행 상태를 저장하지 못해 기록 단계로 진행하지 않았습니다. 변경은 그대로 남아 있습니다.",
          });
        }
        break;
      }
      if (contract.verdict === "UNKNOWN") {
        const transition = this.transitionProfessional({
          type: "REVIEW_UNKNOWN",
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
          result: reviewResult,
          message: contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "검수 응답의 최종 판정을 확정할 수 없어 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다."
            : "검수 근거가 부족해 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
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
        const transition = this.transitionProfessional({
          type: "REVIEW_FIX",
          canAutoRevise: false,
          stopReason: contract.stopReason || "FIX_REQUIRED",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: contract.stopReason || "FIX_REQUIRED",
          result: reviewResult,
          message: "검수에서 수정이 필요하다고 판단해 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
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
        const transition = this.transitionProfessional({
          type: "REVIEW_FIX",
          canAutoRevise: false,
          stopReason: !canAutoRevise ? "FIX_REQUIRED" : "LIMIT_EXCEEDED",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: !canAutoRevise ? "FIX_REQUIRED" : "LIMIT_EXCEEDED",
          result: reviewResult,
          message: "자동 보완 한도 또는 정책 때문에 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
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
      const revisionTransition = this.transitionProfessional({
        type: "REVIEW_FIX",
        canAutoRevise: true,
      });
      if (!revisionTransition.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
          result: revisionTransition,
        });
      }
      autoRevisionCount += 1;
      round += 1;
      feedback = reviewResult.text || "검토자가 수정이 필요하다고 판단했습니다.";
      this.appendSystem(`검토 결과 수정 필요 · 자동 보완 ${autoRevisionCount}/${maxAutoRevisions}회`);
      const frozenBeforeRevision = validateForStage("implementation", round + 1);
      if (frozenBeforeRevision) return frozenBeforeRevision;
      builderResult = await this.scheduleResponse(implementation.agent, {
        specialist: {
          stage: "implementation",
          round,
          maxRounds,
          controlOutputs: true,
          // TASK-007: 자동 보완도 같은 Run, 같은 Frozen Task를 사용합니다.
          // Frozen Task는 요구사항 기준이고, feedback은 이번에 고칠 Reviewer 지시입니다.
          feedback,
          frozenTask: frozenTaskMeta(),
        },
        agentConfig: implementation.agentConfig,
      });
      const frozenAfterRevision = this.validateFrozenTask(runInfo);
      if (!frozenAfterRevision.ok) {
        return this.holdForFrozenTaskCorruption({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          error: frozenAfterRevision.error,
        });
      }
      // 자동 보완 후에도 diff를 다시 수집해 최신 변경분을 검토에 반영합니다.
      changeSnapshot = await describeWorkspaceChanges(workspace, {
        checkpoint,
        excludePaths: runGeneratedPaths(workspace, runInfo),
      });
      builderChanges = changeSnapshot.text;
      if (changeSnapshot.diff.status === "FAILED") {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "DIFF_COLLECTION_FAILED",
          result: { changes: changeSnapshot.diff },
          message: "보완 후 변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
      if (requestedGeneration !== this.generation) {
        if (!this.professionalRun) cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!builderResult?.ok) {
        if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round,
            stopReason: builderResult.stopReason,
            result: builderResult,
            message: "구현 프롬프트가 허용된 크기를 넘어 보완을 시작하지 못했습니다. 기존 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        const held = holdProfessionalFailure({
          stage: "implementation",
          stopReason: builderResult.stopReason || "TRANSPORT_FAILED",
          result: builderResult,
          message: "자동 보완 중 구현 에이전트가 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return this.specialistFail(implementation, "implementation", round, builderResult);
      }
      builderResult = await this.repairBuilderStatus(implementation, builderResult, requestedGeneration, frozenTaskMeta());
      // V1.5 — 보완 라운드의 구현자 routing 축 소비(첫 라운드와 동일 규칙).
      const revisedBuilderControl = this.consumeControlRequest({
        contract: "implementation",
        result: builderResult.builderStatus,
        outcome: builderResult,
      });
      if (builderResult.builderStatus !== "DONE") {
        if (
          revisedBuilderControl.accepted &&
          revisedBuilderControl.control?.action === "HANDOFF" &&
          revisedBuilderControl.control.targetRole === "planner"
        ) {
          this.appendSystem(
            "구현자가 재기획(HANDOFF: @planner)을 요청했습니다. 아래에서 작업물을 유지하거나 복원하며 재기획으로 이어 주세요."
          );
        }
        return holdForBlocked(round, builderResult, builderResult.builderStatus);
      }
      const revisedBuilderTransition = this.transitionProfessional({ type: "BUILDER_DONE" });
      if (!revisedBuilderTransition.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
          result: revisedBuilderTransition,
        });
      }
      // Stage D — 보완된 결과물은 **새 결과물**이다. 새 subject를 확정하고
      // 동결된 검사를 다시 수행한다. 이전 판정은 지우지 않고 그 위에 쌓인다(R-8).
      // 이것이 없으면 Reviewer는 B를 보는데 판정 원장은 A에 머문다(B4).
      const revisionVerification = await this.runAssuranceVerification({
        changeSnapshot,
        permission: implementation.permission,
        runInfo,
      });
      if (revisionVerification && revisionVerification.ok === false) {
        return this.holdForAssuranceBlocked({
          runInfo,
          taskInfo,
          checkpoint,
          round,
          changes: changeSnapshot,
          final: {
            verdict: "BLOCKED",
            blockers: [{ reason: "ASSURANCE_INTERNAL_ERROR", detail: revisionVerification.error || null }],
          },
        });
      }

      reviewEvidence = this.prepareReviewEvidence({
        runInfo,
        builderResult,
        diff: changeSnapshot.diff,
        round,
        provider: implementation.agent.id,
      });
      if (!reviewEvidence.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "EVIDENCE_WRITE_FAILED",
          result: { evidence: reviewEvidence.payload },
          message: "보완 후 실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
    }

    // PASS 후 기록관(선택) 실행 — 실행 블록의 마지막 단계로 블록을 마무리합니다.
    // checkpoint/복구 저널은 기록까지 성공한 뒤에만 정리한다. 기록이 실패하면
    // 저널을 남겨 두어 사용자가 기록을 재시도하거나 변경을 복원할 수 있게 한다.
    if (recordAfter && recorder?.agent) {
      const frozenBeforeRecorder = validateForStage("recorder", round);
      if (frozenBeforeRecorder) return frozenBeforeRecorder;
      recorderResult = await this.scheduleResponse(recorder.agent, {
        specialist: {
          stage: "recorder",
          professional: true,
          round,
          maxRounds: 1,
          frozenTask: frozenTaskMeta(),
          reviewDiff: builderChanges,
          finalVerdict: "PASS",
          evidence: reviewEvidence?.payload || null,
        },
        agentConfig: recorder.agentConfig,
      });
      if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
      if (!recorderResult?.ok) {
        const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
        this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RECORDER_FAILED" });
        if (runInfo?.runDir && this.taskManager?.writeRunResult) {
          this.taskManager.writeRunResult(runInfo, {
            status: "BLOCKED",
            stopReason: "RECORDER_FAILED",
            finalVerdict: "PASS",
            recorded: false,
            round,
          });
        }
        this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
        return { ok: true, completedIterations: round, recorded: false, recording: recorderResult?.text || "", recordError };
      }
    } else if (recordAfter) {
      // 기록은 이 실행의 산출물 중 하나다. 담당자를 못 찾았다고 조용히 건너뛰면
      // 사용자는 "통과했습니다"만 보고 기록이 빠진 것을 모른다.
      this.appendSystem("기록 담당자가 지정되지 않아 이번 실행의 기록을 남기지 못했습니다. 프로젝트 설정에서 지정한 뒤 \"기록 다시 생성\"으로 남길 수 있습니다.");
    }

    if (runInfo?.runDir && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
      status: "COMMITTING",
      finalVerdict: "PASS",
      recorded: Boolean(recorderResult?.ok),
      round,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "RUN_STATE_WRITE_FAILED",
        changes: changeSnapshot,
        message: "완료 기록을 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      taskHash: runInfo?.taskHash || null,
      status: "done",
      activeRunId: null,
      lastRunId: runInfo?.runId || null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        changes: changeSnapshot,
        message: "작업 완료 상태를 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }

    // Stage D-C — Recorder 결과까지 provenance에 남긴다. 이 기록이 있어야
    // "왜 PASS였는가"의 마지막 고리가 이어진다(§26).
    this.recordAssuranceRecorder({ runInfo, ok: Boolean(recorderResult?.ok) });

    const completedTransition = this.transitionProfessional({ type: "RECORDER_DONE" });
    if (!completedTransition.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
        result: completedTransition,
        message: "작업은 끝났지만 완료 상태를 저장하지 못해 복구 정보를 유지합니다.",
      });
    }
    if (runInfo?.runDir && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
      status: "COMPLETED",
      finalVerdict: "PASS",
      recorded: Boolean(recorderResult?.ok),
      round,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "RUN_STATE_WRITE_FAILED",
        changes: changeSnapshot,
        message: "최종 완료 상태를 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }

    // 성공(구현·검수 + 기록 완료) 후에만 checkpoint 리소스를 정리합니다.
    let checkpointCleanupFailed = false;
    if (checkpointSupported && this.checkpointEngine) {
      const cleanup = this.checkpointEngine.cleanupCheckpoint(checkpoint);
      if (cleanup?.ok === false) {
        this.persistRecoveryState(this.recoveryFor(checkpoint, {
          status: "completed",
          runId: runInfo?.runId || null,
          taskPath: taskInfo?.relativePath || null,
          stage: "recorder",
          blockReason: "CHECKPOINT_CLEANUP_FAILED",
        }));
        this.appendSystem("실행은 완료됐지만 checkpoint 정리를 다음 시작 때 다시 시도합니다.");
        checkpointCleanupFailed = true;
      }
    }
    if (checkpointCleanupFailed) {
      // 실행은 COMPLETED이고 checkpoint 정리만 다음 시작으로 미뤘다. 완료된
      // 실행이므로 검토자가 요청한 Archivist 정리와 마지막 settle을 여기서도
      // 반드시 수행한다 — 부가 마무리(정리 실패)가 요청된 산출물을 삼키면 안 된다.
      await this.finalizeCompletedExecution({
        recorder, archivistRequested, requestedGeneration,
        builderChanges, reviewEvidence, frozenTaskMeta,
      });
      return {
        ok: true,
        completedIterations: round,
        recorded: Boolean(recorderResult?.ok),
        recording: recorderResult?.text || "",
        cleanupError: "CHECKPOINT_CLEANUP_FAILED",
      };
    }
    this.clearRecoveryState();

    this.appendSystem("전문 모드 구현·검토가 통과했습니다.");
    await this.finalizeCompletedExecution({
      recorder, archivistRequested, requestedGeneration,
      builderChanges, reviewEvidence, frozenTaskMeta,
    });
    return {
      ok: true,
      completedIterations: round,
      recorded: Boolean(recorderResult?.ok),
      recording: recorderResult?.text || "",
    };
  }

  // 성공적으로 COMPLETED에 도달한 실행의 공통 마무리: 검토자가 요청한
  // Archivist(사람용 정리)와 마지막 handoff settle. 선형 happy path뿐 아니라
  // checkpoint 정리 실패 같은 부가 단계 실패 경로에서도 호출해, 무관한
  // 마무리 실패가 요청된 Archivist를 삼키거나 handoff slot을 남기지 않게 한다.
  async finalizeCompletedExecution({ recorder, archivistRequested, requestedGeneration, builderChanges, reviewEvidence, frozenTaskMeta }) {
    // V1.5 — 검토자가 요청한 Archivist 정리(PASS + HANDOFF: @recorder).
    // 완료를 막지 않는 부가 정리다: 실행은 이미 COMPLETED이고, 정리 실패는
    // 실패로만 알린다. deterministic recorder와 별개의 LLM 계약(archivist)이다.
    if (archivistRequested && recorder?.agent && requestedGeneration === this.generation) {
      this.appendSystem("검토자의 요청으로 기록 정리(Archivist)를 시작합니다.");
      const journalEntries = typeof this.readProfessionalEvents === "function"
        ? (this.readProfessionalEvents() || []).slice(-ARCHIVIST_JOURNAL_WINDOW)
        : [];
      this.recordJournalEvent?.({
        type: "ROLE_STARTED",
        role: "recorder",
        purpose: "archivist",
        professionalRunId: this.professionalRun?.professionalRunId || null,
        frozenRunId: this.professionalRun?.frozenRunId || null,
      });
      const archivistResult = await this.scheduleResponse(recorder.agent, {
        specialist: {
          stage: "archivist",
          journal: journalEntries,
          finalVerdict: "PASS",
          // Archivist 계약이 허용하는 canonical 자료를 실제로 전달한다
          // (frozenTask/finalDiff/evidence — 정책과 입력이 어긋나면 Journal
          // 사건 이력만으로 "무엇이 바뀌었는지"를 요약할 수 없다).
          frozenTask: frozenTaskMeta(),
          reviewDiff: builderChanges,
          evidence: reviewEvidence?.payload || null,
        },
        agentConfig: recorder.agentConfig,
      });
      this.recordJournalEvent?.({
        type: "ROLE_FINISHED",
        role: "recorder",
        purpose: "archivist",
        status: !archivistResult ? "INTERRUPTED" : archivistResult.ok ? "DONE" : "FAILED",
        professionalRunId: this.professionalRun?.professionalRunId || null,
        frozenRunId: this.professionalRun?.frozenRunId || null,
      });
      if (archivistResult && !archivistResult.ok && requestedGeneration === this.generation) {
        this.appendSystem("기록 정리(Archivist)가 실패했습니다. 실행 완료 상태에는 영향이 없습니다.");
      }
    }
    // 검토자의 HANDOFF: @recorder로 수용된 invocation은 다음 결정 지점이
    // 없는 마지막 고리다. Archivist 실행(또는 실행하지 않기로 한 판정)이
    // 끝난 여기서 settle하지 않으면, 정상 완료가 재시작 recovery에서
    // INTERRUPTED로 기록된다.
    this.settleIncomingHandoff();
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
      error: result?.error || `${stage} 단계에서 에이전트 실행에 실패했습니다.`,
      ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result?.evidence ? { evidence: result.evidence } : {}),
      ...(result?.transport ? { transport: result.transport } : {}),
    };
  }

  // BLOCKED 후속 처리 (A안).
  // BLOCKED 시점에는 되돌리지 않고 보류했으므로, 사용자가 고른 조치를 여기서 수행합니다.
  //   keep    — 현재 변경을 그대로 유지하고 보류 상태만 해제
  //   restore — checkpoint 시점(=Builder 실행 전)으로 되돌림. 사용자 사전 변경은 보존
  //   discard — 되돌린 뒤 Task까지 폐기 대상으로 표시

  specialistBlockDetails() {
    const pending = this.specialistBlocked;
    if (!pending) return null;
    const runInfo = pending.runId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
      : null;
    const block = runInfo && this.taskManager?.readRunBlock
      ? this.taskManager.readRunBlock(runInfo)
      : null;
    return {
      runId: pending.runId || null,
      taskPath: pending.taskPath || null,
      stage: pending.stage || "implementation",
      blockReason: pending.blockReason || "BLOCKED",
      canRestore: Boolean(pending.canRestore),
      block,
    };
  }

  // 계약 자체를 버리고 PLAN부터 완전히 새로 시작하기 전에, 기존 실행을 원자적으로
  // 종료한다. 이 정리 없이 새 ProfessionalRun을 덮어쓰면 옛 대기 상태가 메모리에
  // 남고 기존 harness run이 고아가 된다(REPLAN_RESET이 lineage 폐기 = RETIRE다).
  //
  // 순서는 replanBlocked와 같다. checkpoint를 먼저 지우고 전이가 실패하면
  // "기존 run은 살아 있는데 되돌릴 수단만 사라진" 더 나쁜 부분 실패가 된다.
  // 구현자가 파일은 고쳤는데 완료 선언만 빠뜨렸거나 둘 다 쓴 경우, 이것은 사용자
  // 결정 사항이 아니라 출력 계약 실패다. 같은 구현자에게 선언만 다시 청한다.
  //
  // **구현 프롬프트로 다시 부르면 안 된다.** "실제 구현을 수행하세요"가 살아 있으면
  // 형식 교정이 2차 구현 라운드가 되어 이미 고친 파일을 또 건드린다. 전용 지침으로
  // 대체하고(chat-prompt의 repairKind), 이번 호출의 authority만 workspace-read로
  // 낮춘다 — 역할은 그대로 Builder지만 stage cap과 min을 취해 읽기 전용이 된다.
  //
  // 한 builder 응답당 한 번만 시도한다(호출자가 결과 하나에 대해 한 번 부른다).
  // 라운드·자동 보완 예산·checkpoint 어느 것도 소비하지 않는다.
  async repairBuilderStatus(builderStage, builderResult, requestedGeneration, frozenTask) {
    const declaration = builderResult?.builderStatus;
    if (declaration !== "MISSING" && declaration !== "AMBIGUOUS") return builderResult;
    if (!builderStage?.agent) return builderResult;

    this.appendSystem(
      declaration === "MISSING"
        ? "구현 결과에 완료 선언(STATUS)이 없어 선언만 다시 요청합니다. 구현을 다시 하지 않으며 자동 보완 횟수와 무관합니다."
        : "구현 결과에 서로 다른 완료 선언이 있어 하나로 확정해 달라고 다시 요청합니다. 자동 보완 횟수와 무관합니다."
    );
    const repaired = await this.withProfessionalAuthorization("workspace-read", () =>
      this.scheduleResponse(builderStage.agent, {
        specialist: {
          stage: "implementation",
          repairKind: "builder_status",
          frozenTask: frozenTask || null,
          // 직전 응답 본문. 선언 확정은 "실제로 한 작업"의 근거 위에서
          // 이뤄져야 하므로 근거를 함께 전달한다. 상한은 프롬프트 예산
          // 안전선(16KB)이고, 초과분은 head/tail을 남긴다.
          repairContext: {
            priorResponse: boundedText(builderResult?.text, 16 * 1024, "직전 응답").text,
          },
        },
        agentConfig: builderStage.agentConfig,
      })
    );
    if (requestedGeneration !== this.generation) return builderResult;
    if (!repaired?.ok) return builderResult;
    if (repaired.builderStatus !== "DONE" && repaired.builderStatus !== "BLOCKED") return builderResult;

    // 실행 결과·변경·evidence는 첫 호출의 것을 그대로 두고 선언만 확정한다.
    return { ...builderResult, builderStatus: repaired.builderStatus, statusRepaired: true };
  }

  // 검수 응답을 다시 청해야 하는지, 청한다면 무엇을 요구할지 판정한다.
  //
  //   format   출력 계약 실패. 표기가 누락·모순돼 최종 판정을 확정할 수 없다.
  //            판단 자체는 유효하므로 형식만 고쳐 달라고 한다.
  //   unknown  검수자가 "판정할 근거가 부족하다"고 답한 경우. 이것은 형식 실패가
  //            아니라 유효한 판단일 수 있으므로 둘 중 하나를 강제하지 않는다.
  //
  // 둘 다 사용자가 대신 답해 줄 수 있는 문제가 아니다. 사용자 개입은 요구사항·범위가
  // 바뀌어야 풀리는 문제에만 쓴다.
  reviewRepairKind(contract) {
    if (!contract) return null;
    if (contract.stopReason === "AMBIGUOUS_VERDICT" || contract.stopReason === "SCOPE_UNSPECIFIED") {
      return "format";
    }
    if (contract.verdict === "UNKNOWN") return "unknown";
    return null;
  }

  async discardRunForFreshPlan() {
    // 막힌 작업을 다시 기획하는 것은 대개 "새 작업"이 아니라 "같은 작업의 계약을
    // 다시 쓰는 것"이다. 그래서 쓰던 작업 지시서 경로를 들고 나가 새 run이 이어받게
    // 한다. 이걸 놓치면 같은 작업의 지시서가 TASK-003·004·005로 갈라져, 기획자가
    // 어느 파일이 최신인지 매번 헷갈린다(실제로 그랬다).
    const carriedTaskPath = this.professionalRun?.taskPath
      || this.specialistResume?.taskInfo?.relativePath
      || this.specialistBlocked?.taskPath
      || null;
    const pending = this.specialistBlocked;
    const heldCheckpoint = pending?.checkpoint || this.specialistResume?.checkpoint || null;
    const runId = pending?.runId || this.specialistResume?.runInfo?.runId || null;
    const taskPath = pending?.taskPath || this.specialistResume?.taskInfo?.relativePath || null;

    // 1. 기존 run 결과와 workflow 상태를 남긴다 — **최선 노력이다.**
    //
    // 이건 장부 기록이지 상태 정합성이 아니다. 실패해도 새 기획을 막지 않는다.
    // 막으면 "정리를 못 해서 새로 시작할 수 없는" 역설이 된다. 실제로 workspace의
    // .project-memory가 지워진 상태에서 이 기록이 실패해 사용자가 갇혔다 —
    // 지시서가 사라진 그 상황이야말로 처음부터 다시 시작해야 하는 때다.
    const warnings = [];
    const runInfo = runId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(runId, this.meta.workspace)
      : null;
    if (runInfo && this.taskManager?.writeRunResult) {
      if (!this.taskManager.writeRunResult(runInfo, {
        status: "BLOCKED",
        stopReason: pending?.blockReason || "REPLAN_DISCARDED",
      })) {
        warnings.push("이전 Run 결과를 기록하지 못했습니다");
      }
    }
    if (taskPath && !this.updateProfessionalTaskState({
      taskPath,
      status: "blocked",
      activeRunId: null,
      lastRunId: runId,
    })) {
      warnings.push("이전 작업의 Workflow 상태를 갱신하지 못했습니다");
    }

    // 2. lineage 폐기(RETIRE). **여기만 차단 사유다.**
    // 이 전이가 실패하면 옛 run이 살아 있는 채로 새 run을 만들게 되고,
    // harness에는 종료가 통지되지 않아 실행이 고아가 된다.
    if (this.professionalRun) {
      const transition = this.transitionProfessional({ type: "REPLAN_RESET", carriedFromRunId: runId });
      if (!transition.ok) {
        return { ok: false, error: transition.reason || "기존 실행을 종료하지 못해 새 기획을 시작하지 않았습니다." };
      }
    }

    // 3. checkpoint 정리도 최선 노력이다. 사용자가 이미 "버린다"고 선택했고
    // 옛 run은 위에서 종료됐다. 지우지 못한 폴더는 디스크 문제일 뿐이며,
    // 그것 때문에 새 시작을 막으면 다시 같은 역설이 된다.
    if (heldCheckpoint && this.checkpointEngine) {
      const cleanup = this.checkpointEngine.cleanupCheckpoint(heldCheckpoint);
      if (cleanup?.ok === false) {
        warnings.push("이전 작업 전 백업을 지우지 못해 디스크에 남았습니다");
      }
    }

    // 4. 옛 대기 상태를 남김없이 지운다.
    this.specialistResume = null;
    this.specialistBlocked = null;
    this.professionalPlan = null;
    this.clearRecoveryState();
    this.emitSpecialistState();
    return { ok: true, discardedCheckpoint: Boolean(heldCheckpoint), warnings, carriedTaskPath };
  }

  async replanBlocked(workspaceAction = "keep") {
    return this.withProfessionalAuthorization("workspace-write", async () => {
      const pending = this.specialistBlocked;
      if (!pending) {
        return { ok: false, error: "처리할 막힘(BLOCKED) 상태가 없습니다." };
      }
      if (!["keep", "restore"].includes(workspaceAction)) {
        return { ok: false, error: "올바르지 않은 재기획 동작입니다. (keep 또는 restore 선택)" };
      }
      // 담당자 확인을 먼저 한다. 복원/정리/저널 해제 같은 되돌릴 수 없는 처리
      // 이전에 검증해야, 설정이 비어 있을 때 사용자가 checkpoint와 BLOCKED
      // 상태를 잃고 막다른 길에 놓이지 않는다. 재기획은 현재 프로젝트 설정의
      // 기획·기획검수 담당자로 실행한다(과거 실행의 스냅샷을 쓰지 않는다).
      const stages = this.refreshPlanStages(this.stagesForSpecialist());
      if (!stages || !stages.planner?.agent || !(stages.review?.agent || stages.planReview?.agent)) {
        return { ok: false, error: "기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
      }
      const runInfo = pending.runId && this.taskManager?.runInfoForId
        ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
        : null;
      const block = runInfo && this.taskManager?.readRunBlock
        ? this.taskManager.readRunBlock(runInfo)
        : null;

      if (workspaceAction === "restore") {
        if (this.checkpointEngine && pending.checkpoint) {
          // Stage D-0: restore는 workspace 전체를 되돌리는 가장 큰 mutation이므로
          // 다른 대화가 변경 중이면 시작하지 않는다(그 대화의 작업까지 지워진다).
          const lease = this.acquireWorkspaceMutation({
            purpose: "checkpoint-restore",
            runId: pending.runId || null,
            role: "replan",
          });
          if (!lease.ok) return { ok: false, error: lease.error };
          const preservePaths = runInfo ? runGeneratedPaths(this.meta.workspace, runInfo) : [];
          let result;
          try {
            result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, pending.checkpoint, {
              preservePaths,
            });
          } finally {
            this.releaseWorkspaceMutation(lease.token);
          }
          this.notifyWorkspaceRestoreOutcome(result);
          if (!result?.ok) {
            return { ok: false, error: "작업 전 상태로 되돌리지 못했습니다. 변경과 복구 상태를 그대로 유지합니다." };
          }
        }
      }

      if (runInfo && this.taskManager?.writeRunResult) {
        if (!this.taskManager.writeRunResult(runInfo, {
          status: "BLOCKED",
          stopReason: pending.blockReason || "BLOCKED",
        })) {
          return { ok: false, error: "막힌 Run 결과를 저장하지 못해 재기획을 시작하지 않았습니다." };
        }
      }
      if (!this.updateProfessionalTaskState({
        taskPath: pending.taskPath || null,
        status: "blocked",
        activeRunId: null,
        lastRunId: pending.runId || null,
      })) {
        return { ok: false, error: "막힌 작업의 Workflow 상태를 저장하지 못해 재기획을 시작하지 않았습니다." };
      }

      if (this.professionalRun) {
        const trans = this.transitionProfessional({
          type: "REPLAN_RESET",
          carriedFromRunId: pending.runId || null,
        });
        if (!trans.ok) return this.professionalTransitionFailure("planner", trans);
      }

      if (this.checkpointEngine && pending.checkpoint) {
        const cleanup = this.checkpointEngine.cleanupCheckpoint(pending.checkpoint);
        if (cleanup?.ok === false) {
          this.transitionProfessional({
            type: "HOLD_BLOCKED",
            stopReason: "CHECKPOINT_CLEANUP_FAILED",
            blockReason: "CHECKPOINT_CLEANUP_FAILED",
          });
          return { ok: false, error: "checkpoint 정리를 완료하지 못해 재기획을 시작하지 않았습니다. 복구 상태를 유지합니다." };
        }
      }

      this.specialistBlocked = null;
      this.clearRecoveryState();

      let feedback = `이전 구현(${pending.runId || "RUN"})이 막혔습니다.\n사유: ${pending.blockReason || "BLOCKED"}`;
      if (block?.changes?.text) {
        feedback += `\n\n=== 이전 작업 부분 변경 ===\n${block.changes.text}\n=== 이전 작업 부분 변경 끝 ===`;
      }

      const taskInfo = taskFileInfo(pending.taskPath);

      this.appendSystem(
        workspaceAction === "restore"
          ? "작업 전 상태로 복원한 뒤, 막힌 사유를 기획자에게 전달하고 재기획을 시작합니다."
          : "현재 변경을 유지한 채, 막힌 사유와 부분 변경을 기획자에게 전달하고 재기획을 시작합니다."
      );

      return this.runPlanBlock({
        stages: {
          ...stages,
          planReview: stages.planReview || stages.review,
        },
        feedback,
        taskInfo,
        action: "plan",
        planAutoRevisions: this.professionalRun?.policy?.planAutoRevisions || 0,
        implementationAutoRevisions: this.professionalRun?.policy?.implementationAutoRevisions || 0,
      });
    });
  }

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

    const pendingRunInfo = pending.runId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
      : null;
    const preservePaths = pendingRunInfo
      ? runGeneratedPaths(this.meta.workspace, pendingRunInfo)
      : [];
    let restored = false;
    if (action === "restore" || action === "discard") {
      if (this.checkpointEngine && pending.checkpoint) {
        // Stage D-0: 같은 workspace를 다른 대화가 변경 중이면 되돌리지 않는다.
        const lease = this.acquireWorkspaceMutation({
          purpose: "checkpoint-restore",
          runId: pending.runId || null,
          role: "recovery",
        });
        if (!lease.ok) return { ok: false, error: lease.error };
        let result;
        try {
          result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, pending.checkpoint, {
            preservePaths,
          });
        } finally {
          this.releaseWorkspaceMutation(lease.token);
        }
        this.notifyWorkspaceRestoreOutcome(result);
        restored = Boolean(result?.ok);
        if (!restored) {
          return { ok: false, error: "작업 전 상태로 되돌리지 못했습니다. 변경은 그대로 두었습니다." };
        }
      }
    }
    if (pending.blockReason === "FROZEN_TASK_CORRUPTED" && pendingRunInfo && this.taskManager?.markRunInvalid) {
      // restore가 checkpoint 이후의 invalid marker를 제거할 수 있으므로,
      // 저널을 해제하기 직전에 단조 invalid 상태를 다시 기록합니다.
      if (!this.taskManager.markRunInvalid(pendingRunInfo, pending.blockReason)) {
        return { ok: false, error: "손상된 Run의 무효 상태를 다시 기록하지 못했습니다. 복구 저널을 유지합니다." };
      }
    }
    if (!this.updateProfessionalTaskState({
      taskPath: pending.taskPath || null,
      status: "blocked",
      activeRunId: null,
      lastRunId: pending.runId || null,
    })) {
      return { ok: false, error: "막힌 작업의 Workflow 상태를 저장하지 못해 복구 상태를 해제하지 않았습니다." };
    }
    if (this.checkpointEngine && pending.checkpoint) {
      const cleanup = this.checkpointEngine.cleanupCheckpoint(pending.checkpoint);
      if (cleanup?.ok === false) {
        return { ok: false, error: "checkpoint 정리를 완료하지 못해 복구 상태를 유지합니다." };
      }
    }

    const resolvedTransition = this.transitionProfessional({
      type: "INTERRUPT",
      stopReason: "BLOCK_RESOLVED",
    });
    if (!resolvedTransition.ok) return this.professionalTransitionFailure("implementation", resolvedTransition);

    this.specialistBlocked = null;
    this.clearRecoveryState();
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
        professional: Boolean(options.professional),
        round: options.round || 1,
        maxRounds: options.maxRounds || 1,
        frozenTask: options.frozenTask || null,
        reviewDiff: options.reviewDiff,
        finalVerdict: options.finalVerdict || null,
        evidence: options.evidence || null,
      },
      agentConfig: options.agentConfig,
    });
  }
}

function installSpecialistMethods(ChatRoom) {
  for (const name of Object.getOwnPropertyNames(SpecialistMixin.prototype)) {
    if (name !== 'constructor') {
      ChatRoom.prototype[name] = SpecialistMixin.prototype[name];
    }
  }
}

module.exports = {
  installSpecialistMethods,
  SAFE_BLOCK_REASONS,
  safeBlockReason,
  hasOpenQuestions,
  structuredIssuesFromReview,
  stripCodeFences,
  findControlMarker,
  runGeneratedPaths,
};
