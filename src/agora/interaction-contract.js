"use strict";

// V1.5 Interaction/Handoff 계약 (AGORA_V1_5_PROPOSAL.md §6, §8 — 재설계판).
// 이 모듈은 순수 로직이다 — 저장, IPC, ChatRoom 상태를 만지지 않는다.
//
// 재설계 배경: 초판은 제안서 §8.2의 전이표를 그대로 데이터로 옮기면서
// ready/complete 같은 workflow 상태와 plan_review/review 같은 실행 계약을
// "역할" 그래프에 섞었다. 그 결과 표면 어휘(@reviewer)와 내부 어휘
// (plan_review/review)가 어긋나 정상 요청이 거부될 수 있었고, 사실상 기존
// Professional FSM을 다른 이름으로 복제하는 방향이었다.
//
// 새 계약은 세 가지를 분리한다.
//   Role(사람)            = planner / builder / reviewer / recorder
//   Execution contract    = 그 역할에 적용되는 계약 (reviewer → plan_review
//                           또는 review는 Runtime이 artifact로 선택)
//   Workflow state/행동   = READY/COMPLETE 같은 상태와 ASK_USER 같은 행동 —
//                           역할 그래프에 넣지 않는다
//
// Runtime은 업무 의미 순서("planner 다음엔 반드시 plan_review")를 검증하지
// 않는다. 검증하는 것은: 어휘(실존 역할인가), loop(자기/연속 호출), stale
// (취소·세대 교체 뒤 늦은 요청), budget, 동시성(active invocation 1개)뿐이다.
// 실행 전제조건(Builder는 READY Task가 있어야 한다 등)은 Stage 5 런타임
// 연결부가 기존 FSM·Freeze 검증으로 판정한다 — 여기 그래프로 만들지 않는다.
// 이렇게 해야 직접 역할 호출·@팀·향후 Orchestrator가 같은 API를 쓸 수 있다.

const crypto = require("node:crypto");

const INTERACTION_TARGETS = Object.freeze(["planner", "builder", "reviewer", "recorder", "all"]);

const INTERACTION_INTENTS = Object.freeze(["CONSULT", "PLAN", "REVIEW", "EXECUTE", "SUMMARIZE"]);

const INTERACTION_SCOPES = Object.freeze(["SINGLE", "TEAM"]);

const EXECUTION_POLICIES = Object.freeze([
  "NONE",
  "STOP_AT_READY",
  "EXECUTE_READY",
  "PREAUTHORIZED_BOUNDED",
]);

// 멘션은 Target이지 실행 승인이 아니다(INV-2). 명시 metadata가 없으면
// 항상 읽기 전용 단일 응답으로 정규화한다(제안서 §6.2). 자연어 추측만으로
// executionPolicy를 올리는 경로는 이 모듈에 존재하지 않는다.
function normalizeInteraction(input = {}) {
  const target = INTERACTION_TARGETS.includes(input.target) ? input.target : null;
  const rawIntent = String(input.intent || "").toUpperCase();
  const intent = INTERACTION_INTENTS.includes(rawIntent) ? rawIntent : "CONSULT";
  const rawScope = String(input.scope || "").toUpperCase();
  const scope = INTERACTION_SCOPES.includes(rawScope) ? rawScope : "SINGLE";
  const rawPolicy = String(input.executionPolicy || "").toUpperCase();
  const executionPolicy = EXECUTION_POLICIES.includes(rawPolicy) ? rawPolicy : "NONE";
  return { target, intent, scope, executionPolicy };
}

// Handoff 대상은 사람 역할뿐이다. ready/complete는 상태, user 반환은
// ASK_USER 행동, archivist는 recorder의 실행 계약이지 별도 역할이 아니다.
const HANDOFF_TARGETS = Object.freeze(["planner", "builder", "reviewer", "recorder"]);

// 역할 출력의 제어 행동. HANDOFF는 다른 역할 지목, COMPLETE는 종결 선언
// (Runtime이 검수 통과 여부로 수용을 판정), ASK_USER는 사용자 반환이다.
const CONTROL_ACTIONS = Object.freeze(["HANDOFF", "COMPLETE", "ASK_USER"]);

// 역할 출력에서 HANDOFF 대상을 지목할 때 쓰는 표면 별칭.
// 전부 완전 단어형만 둔다 — prefix 매칭류에 한글 별칭이 더 긴 단어에
// 삼켜지는 위험(기획 ↔ 기획자)을 피한다.
const HANDOFF_TARGET_ALIASES = Object.freeze({
  planner: Object.freeze(["planner", "기획자"]),
  builder: Object.freeze(["builder", "implementation", "구현자"]),
  reviewer: Object.freeze(["reviewer", "검토자", "검수자"]),
  recorder: Object.freeze(["recorder", "기록자"]),
});

function isHandoffTarget(role) {
  return HANDOFF_TARGETS.includes(String(role || ""));
}

// Reviewer 계약 선택은 요청 문구가 아니라 출처 역할과 artifact 종류로 한다
// (제안서 §7.2, §16 P1 "잘못된 Reviewer 계약 선택" 방어).
function resolveReviewerContract({ sourceRole, hasFrozenArtifacts } = {}) {
  if (hasFrozenArtifacts) return "review";
  if (sourceRole === "builder") return "review";
  return "plan_review";
}

// 표면 역할(@reviewer 등) → 실행 계약(specialist stage id) 정규화.
// 표면 어휘와 내부 어휘의 불일치("reviewer"는 파싱되는데 검증 어휘에 없는
// 문제)를 여기 한 곳에서 흡수한다. Stage 5 런타임 연결부는 파싱 결과를
// 이 함수로 정규화한 뒤에만 실행 계약을 고른다.
function executionContractFor(targetRole, { sourceRole, hasFrozenArtifacts } = {}) {
  switch (String(targetRole || "")) {
    case "planner":
      return "planner";
    case "builder":
      return "implementation";
    case "reviewer":
      return resolveReviewerContract({ sourceRole, hasFrozenArtifacts });
    case "recorder":
      // Handoff/CONSULT로 부르는 @기록자는 항상 사람이 읽기 좋은 정리를
      // 만드는 LLM 계약(archivist)이다. 기존 professional "recorder" stage는
      // deterministic finalizer가 가로채 LLM을 호출하지 않으므로, 그 stage id를
      // 여기서 돌려주면 "기록 역할을 맡은 AI" 대신 finalizer가 호출된다.
      // deterministic System Journal/finalizer는 Runtime 기능이지 Handoff
      // 대상의 실행 계약이 아니다 — 계약 어휘에서부터 갈라 둔다.
      return "archivist";
    default:
      return null;
  }
}

// 실행 계약 → 표면 역할 역매핑. Handoff의 sourceRole은 Runtime이 현재
// invocation의 실행 계약에서 주입한다 — 모델 출력에서 받지 않는다.
const SURFACE_ROLE_FOR_CONTRACT = Object.freeze({
  planner: "planner",
  plan_review: "reviewer",
  implementation: "builder",
  review: "reviewer",
  archivist: "recorder",
});

function surfaceRoleForContract(contract) {
  return SURFACE_ROLE_FOR_CONTRACT[String(contract || "")] || null;
}

// 결과 축(STATUS/VERDICT)과 routing 축(HANDOFF/COMPLETE/ASK_USER)의 조합
// 판정표. 두 축은 우선순위 관계가 아니라 독립 계약이다 — Builder가
// `STATUS: DONE` + `HANDOFF: @reviewer`를 함께 내면 둘 다 유효하다.
// 이 표는 역할 간 고정 순서가 아니라 "이 결과가 이 routing을 정당화하는가"
// (예: FIX_REQUIRED인데 COMPLETE 선언 금지)라는 정합성 계약이다.
// 키는 실행 계약(executionContractFor 결과), 값은 결과별 허용 routing.
const RESULT_CONTROL_ROUTES = Object.freeze({
  planner: Object.freeze({
    PLAN_READY: Object.freeze({ HANDOFF: Object.freeze(["reviewer"]) }),
    NEEDS_DECISION: Object.freeze({ ASK_USER: true }),
  }),
  plan_review: Object.freeze({
    // PASS + HANDOFF builder의 실제 실행은 사용자 승인/autoContinueReady
    // 라는 실행 전제조건 검증(런타임 층)을 따로 통과해야 한다.
    PASS: Object.freeze({ HANDOFF: Object.freeze(["builder"]) }),
    FIX_REQUIRED: Object.freeze({ HANDOFF: Object.freeze(["planner"]) }),
    UNKNOWN: Object.freeze({ ASK_USER: true }),
  }),
  implementation: Object.freeze({
    DONE: Object.freeze({ HANDOFF: Object.freeze(["reviewer"]) }),
    BLOCKED: Object.freeze({ ASK_USER: true, HANDOFF: Object.freeze(["planner"]) }),
  }),
  review: Object.freeze({
    PASS: Object.freeze({ COMPLETE: true, HANDOFF: Object.freeze(["recorder"]) }),
    FIX_REQUIRED: Object.freeze({ HANDOFF: Object.freeze(["builder", "planner"]) }),
    UNKNOWN: Object.freeze({ ASK_USER: true }),
  }),
  archivist: Object.freeze({
    DONE: Object.freeze({ COMPLETE: true }),
  }),
});

// 조합 검증 — 세 층 판정(구조 → 조합 → 실행 전제조건)의 가운데 층이다.
// control이 없으면 기존 FSM 기본 흐름이 그대로 진행되므로 ok다(하위 호환).
// 결과 자체가 미해결(AMBIGUOUS/MISSING 등 표에 없는 값)이면 제어를 실행하지
// 않는다 — 기존 안전 정지 경로가 우선한다.
function validateResultControl({ contract, result, control } = {}) {
  if (!control) return { ok: true, reason: null };
  if (control.ambiguous) return { ok: false, reason: "CONTROL_AMBIGUOUS" };
  const routes = RESULT_CONTROL_ROUTES[String(contract || "")];
  if (!routes) return { ok: false, reason: "CONTROL_UNKNOWN_CONTRACT" };
  const allowed = routes[String(result || "")];
  if (!allowed) return { ok: false, reason: "RESULT_UNRESOLVED" };
  if (control.action === "ASK_USER") {
    return allowed.ASK_USER === true
      ? { ok: true, reason: null }
      : { ok: false, reason: "CONTROL_NOT_ALLOWED" };
  }
  if (control.action === "COMPLETE") {
    return allowed.COMPLETE === true
      ? { ok: true, reason: null }
      : { ok: false, reason: "CONTROL_NOT_ALLOWED" };
  }
  if (control.action === "HANDOFF") {
    const targets = Array.isArray(allowed.HANDOFF) ? allowed.HANDOFF : [];
    return control.targetRole && targets.includes(control.targetRole)
      ? { ok: true, reason: null }
      : { ok: false, reason: "CONTROL_NOT_ALLOWED" };
  }
  return { ok: false, reason: "CONTROL_NOT_ALLOWED" };
}

const DEFAULT_HANDOFF_BUDGET = 8;

// 사용자 발화 1회에서 파생되는 AI Handoff의 소비 원장(제안서 §8.3, §8.4).
// - 총 상한(budget)
// - 한 시점 active invocation 1개
// - 같은 invocationId 재소비 금지 (취소 뒤 늦게 도착한 요청, 재시작 중복 방어)
// - 동일 역할 연속 호출 금지
//
// 이 객체는 in-memory 실행 상태다. 영속화의 authority는 Journal이 아니라
// (Journal은 실패해도 실행이 계속되는 비권위 감사 기록이다) fail-closed로
// 저장되는 professionalRun 쪽 상태여야 한다 — Stage 5는 serializeHandoffLedger
// 결과를 professionalRun.handoffState에 싣고, 재시작 시 그 값을 이 함수로
// 복원한다. sourceRole·professionalRunId·generation·invocationId는 모델
// 출력에서 받지 않고 Runtime이 현재 invocation에서 주입한다.
function createHandoffLedger(options = {}) {
  const budget = Number.isInteger(options.budget) && options.budget > 0
    ? options.budget
    : DEFAULT_HANDOFF_BUDGET;
  return {
    // budget의 root identity — 이 원장이 어느 사용자 발화에서 파생됐는가.
    // "사용자 발화 1회당 8회"가 실제로 성립하려면 새 사용자 지시가 새
    // 원장(새 epoch)을 받아야 한다. handoffLedgerForRoot가 그 판정을 한다.
    rootMessageId: options.rootMessageId || null,
    budget,
    // 복원 없이 새로 만들면 0. used를 복원하지 않으면 재시작이 곧 예산
    // 리셋이 되어 상한이 의미를 잃는다.
    used: Number.isInteger(options.used) && options.used >= 0 ? options.used : 0,
    // 소비 집합은 배열(직렬화본)과 Set(살아 있는 원장) 양쪽을 받는다.
    // 배열만 방어하면 살아 있는 원장을 실수로 넘겼을 때 소비·dedup 기록이
    // 통째로 리셋되어(fail-open) 예산·중복 방어가 뚫린다.
    consumedInvocationIds: new Set(
      options.consumedInvocationIds instanceof Set
        ? options.consumedInvocationIds
        : Array.isArray(options.consumedInvocationIds)
          ? options.consumedInvocationIds
          : [],
    ),
    lastTargetRole: options.lastTargetRole || null,
    activeInvocationId: options.activeInvocationId || null,
  };
}

// 영속 저장용 직렬화. createHandoffLedger(serializeHandoffLedger(ledger))가
// 동일한 판정을 내리는 원장을 복원한다(roundtrip 계약).
function serializeHandoffLedger(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  return {
    rootMessageId: ledger.rootMessageId || null,
    budget: ledger.budget,
    used: ledger.used,
    consumedInvocationIds: [...(ledger.consumedInvocationIds || [])],
    lastTargetRole: ledger.lastTargetRole || null,
    activeInvocationId: ledger.activeInvocationId || null,
  };
}

// 앱 크래시·강제 종료 후의 복원. 죽은 프로세스가 잡고 있던
// activeInvocationId를 그대로 복원하면 이후 모든 Handoff가 HANDOFF_BUSY로
// 막힌다(ghost BUSY). 그 invocation을 INTERRUPTED로 폐기한다: 소비 기록에는
// 남겨 재실행(중복)을 막고, active 슬롯만 비워 새 요청이 흐르게 한다.
// 호출자는 interruptedInvocationId로 Journal에 중단 사실을 남길 수 있다.
function recoverHandoffLedger(state) {
  const ledger = createHandoffLedger(state || {});
  const interruptedInvocationId = ledger.activeInvocationId || null;
  if (interruptedInvocationId) {
    ledger.consumedInvocationIds.add(interruptedInvocationId);
    ledger.activeInvocationId = null;
  }
  return { ledger, interruptedInvocationId };
}

// 사용자 발화별 budget epoch 판정 — **재시작/세션 복원 전용 API**다.
// 저장된 원장이 같은 root(사용자 발화)의 것이면 이어 쓰고, 새 사용자 지시면
// 새 예산의 새 원장을 만든다 — 이렇게 해야 "발화 1회당 8회"가 Professional
// Run 전체 예산으로 변질되지 않는다.
//
// 두 가지 fail-closed 규칙:
// 1. rootMessageId가 없으면 거부한다(HANDOFF_ROOT_REQUIRED). 배선 버그로
//    root 전달이 누락되면 호출마다 새 epoch가 만들어져 budget이 조용히
//    리셋되기 때문이다 — 실행하지 않는 쪽이 안전하다.
// 2. 같은 root의 복원에는 crash recovery 규칙(recoverHandoffLedger)이 항상
//    적용되어 active invocation이 INTERRUPTED로 폐기된다. 살아 있는 run
//    도중에 "현재 ledger 가져오기" 용도로 이 함수를 다시 부르면 실행 중인
//    invocation의 동시성 lock이 풀린다 — 평상시에는 방이 들고 있는
//    in-memory ledger 객체를 그대로 쓰고, 이 함수는 앱 재시작·세션 복원
//    시점에만 호출한다(이름이 recover-인 이유).
function recoverHandoffLedgerForRoot(previousState, rootMessageId, options = {}) {
  const root = rootMessageId || null;
  if (!root) {
    return {
      ok: false,
      reason: "HANDOFF_ROOT_REQUIRED",
      ledger: null,
      interruptedInvocationId: null,
    };
  }
  if (previousState && previousState.rootMessageId === root) {
    return { ok: true, ...recoverHandoffLedger(previousState) };
  }
  return {
    ok: true,
    ledger: createHandoffLedger({ ...options, rootMessageId: root }),
    interruptedInvocationId: null,
  };
}

function newInvocationId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `inv-${ts}-${rand}`;
}

// Handoff 요청의 구조적 검증. 통과해도 실행하지 않는다 — 모델은 요청하고
// Runtime이 결정한다(INV-6). 업무 의미 순서는 여기서 판정하지 않는다:
// "Builder를 실행해도 되는가"는 READY Task·Frozen hash·checkpoint 같은
// 실행 전제조건 검증(런타임)의 몫이다.
function validateHandoff(request = {}, state = {}) {
  const fromRole = String(request.sourceRole || "");
  const toRole = String(request.targetRole || "");
  const ledger = state.ledger || null;

  if (!isHandoffTarget(fromRole) || !isHandoffTarget(toRole)) {
    return { ok: false, reason: "HANDOFF_NOT_ALLOWED" };
  }
  if (fromRole === toRole) {
    return { ok: false, reason: "HANDOFF_SELF" };
  }

  // 취소·세대 교체 뒤 늦게 도착한 요청과 다른 run의 요청을 폐기한다(§8.4).
  if (
    state.professionalRunId != null &&
    request.professionalRunId != null &&
    String(request.professionalRunId) !== String(state.professionalRunId)
  ) {
    return { ok: false, reason: "HANDOFF_STALE" };
  }
  if (
    state.generation != null &&
    request.generation != null &&
    request.generation !== state.generation
  ) {
    return { ok: false, reason: "HANDOFF_STALE" };
  }

  if (ledger) {
    if (request.invocationId && ledger.consumedInvocationIds.has(request.invocationId)) {
      return { ok: false, reason: "HANDOFF_DUPLICATE" };
    }
    if (ledger.activeInvocationId && ledger.activeInvocationId !== request.invocationId) {
      return { ok: false, reason: "HANDOFF_BUSY" };
    }
    if (ledger.lastTargetRole && ledger.lastTargetRole === toRole) {
      // 직전에 넘긴 역할로 곧바로 다시 넘기는 것(연속 동일 대상)은 진짜
      // self-handoff(fromRole===toRole)와 원인이 다르다 — 감사 로그·안내가
      // 원인을 구분할 수 있도록 별도 코드를 쓴다.
      return { ok: false, reason: "HANDOFF_REPEAT" };
    }
    if (ledger.used >= ledger.budget) {
      return { ok: false, reason: "HANDOFF_BUDGET_REACHED" };
    }
  }

  return { ok: true };
}

// 검증을 통과한 요청을 원장에 소비 기록한다. 실패한 검증 결과를 되돌려주며
// 원장은 건드리지 않는다(fail-closed).
function consumeHandoff(request = {}, state = {}) {
  const verdict = validateHandoff(request, state);
  if (!verdict.ok) return verdict;
  const ledger = state.ledger;
  if (ledger) {
    ledger.used += 1;
    const invocationId = request.invocationId || newInvocationId();
    ledger.consumedInvocationIds.add(invocationId);
    ledger.activeInvocationId = invocationId;
    ledger.lastTargetRole = String(request.targetRole);
    return { ok: true, invocationId };
  }
  return { ok: true, invocationId: request.invocationId || newInvocationId() };
}

// active invocation이 끝났음을 기록한다. id가 다르면 무시한다(늦은 완료 보고).
function settleHandoff(ledger, invocationId) {
  if (!ledger) return false;
  if (!invocationId || ledger.activeInvocationId !== invocationId) return false;
  ledger.activeInvocationId = null;
  return true;
}

const HANDOFF_LINE_PATTERN = /^[ \t]*HANDOFF:[ \t]*@?([\p{L}\p{N}_-]+)[ \t]*$/gimu;
// 단독 "COMPLETE" 또는 "COMPLETE: 요약"만 인식한다. 콜론 없는 뒤따름
// ("COMPLETE the task ...")은 산문이지 제어 마커가 아니다.
const COMPLETE_LINE_PATTERN = /^[ \t]*COMPLETE(?::[ \t]*([^\r\n]*?))?[ \t]*$/gim;
const ASK_USER_LINE_PATTERN = /^[ \t]*ASK_USER:[ \t]*([^\r\n]+?)[ \t]*$/gim;
const PURPOSE_LINE_PATTERN = /^[ \t]*PURPOSE:[ \t]*([^\r\n]+?)[ \t]*$/im;
const REASON_LINE_PATTERN = /^[ \t]*REASON:[ \t]*([^\r\n]+?)[ \t]*$/im;

// end-anchor 판별용 단일 줄 패턴. 아래 trailingControlBlock이 응답 꼬리의
// 연속된 제어 줄만 골라내는 데 쓴다.
const CONTROL_LINE_PATTERNS = Object.freeze([
  /^[ \t]*HANDOFF:[ \t]*@?[\p{L}\p{N}_-]+[ \t]*$/iu,
  /^[ \t]*COMPLETE(?::[ \t]*[^\r\n]*?)?[ \t]*$/i,
  /^[ \t]*ASK_USER:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*PURPOSE:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*REASON:[ \t]*[^\r\n]+?[ \t]*$/i,
]);

function isControlLine(line) {
  return CONTROL_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

// 응답 마지막에 붙은 연속 제어 블록의 줄 범위를 masked 텍스트 기준으로
// 구한다(end-anchor — [[CODEPET_REVIEW:...]]의 끝줄 앵커 규율과 같은 원칙).
// 본문 중간의 "출력 예시는 다음과 같습니다: HANDOFF: @builder" 뒤에 산문이
// 이어지면 그 마커는 설명이지 실행 요청이 아니다. 이 제어가 Builder 자동
// 호출로 이어지는 순간 파싱 오인은 곧 실행 권한 문제가 되기 때문이다.
//
// 반환은 [start, end] 포함 범위다(start > end면 제어 블록 없음). 호출자는
// "어느 줄이 제어 줄인가"만 masked로 판정하고, 실제 값(질문·요약·REASON)은
// 같은 범위의 **원문** 줄에서 읽는다 — masked에서 값을 뽑으면 인라인 백틱
// 안 내용이 공백으로 증발해 `ASK_USER: \`foo\``의 질문이 null이 된다.
// maskCodeFences가 개행을 보존하므로 두 텍스트의 줄 인덱스는 일치한다.
function trailingControlRange(masked) {
  const lines = String(masked || "").split(/\r?\n/);
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end -= 1;
  let start = end;
  while (start >= 0 && lines[start].trim() !== "" && isControlLine(lines[start])) start -= 1;
  return { start: start + 1, end };
}

function maskCodeFences(text) {
  return String(text || "")
    // 개행은 보존한다 — masked 텍스트와 원문의 줄 수가 어긋나면
    // stripControlOutput이 masked 인덱스로 원문을 잘라 본문을 삭제한다.
    // (여러 줄 펜스를 공백으로 통째 치환하면 줄 구조가 붕괴한다.)
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/`[^`\r\n]*`/g, (match) => " ".repeat(match.length));
}

// 표시용 텍스트에서 꼬리 제어 블록을 제거한다 — [[CODEPET_*]] 앵커를 화면
// 텍스트에서 벗겨내는 것과 같은 규율이다. parseControlOutput이 인식하는
// 블록과 정확히 같은 범위를 지운다(마스킹은 줄 구조를 보존하므로 masked
// 기준으로 계산한 줄 번호를 원문에 그대로 쓸 수 있다).
function stripControlOutput(text) {
  const raw = String(text || "");
  const { start, end } = trailingControlRange(maskCodeFences(raw));
  if (start > end) return raw;
  return raw.split(/\r?\n/).slice(0, start).join("\n").trimEnd();
}

function handoffTargetForToken(token) {
  const lowered = String(token || "").toLowerCase();
  for (const [role, aliases] of Object.entries(HANDOFF_TARGET_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === lowered)) return role;
  }
  return null;
}

// 역할 출력에서 구조화 제어 행동을 파싱한다(제안서 §8.1의 확장).
// - 일반 문장 속 @reviewer는 제어가 아니다. 줄 전체가 마커 형태이고, 그 줄이
//   응답 마지막의 연속 제어 블록에 속할 때만 인식한다(end-anchor). 본문
//   중간의 마커는 산문·예시로 취급한다. 코드펜스 안의 예시는 무시한다.
// - 마커가 없으면 null. 서로 다른 행동이 섞이거나 HANDOFF 대상이 갈리면
//   ambiguous로 표시하고 확정하지 않는다(findControlMarker의 ambiguity 규율).
function parseControlOutput(text) {
  // 코드펜스 예시를 지운 masked 텍스트로 꼬리 제어 블록의 줄 범위를 정하고,
  // 값은 같은 범위의 원문 줄에서 읽는다(인라인 백틱 내용 보존).
  const raw = String(text || "");
  const { start, end } = trailingControlRange(maskCodeFences(raw));
  if (start > end) return null;
  const source = raw.split(/\r?\n/).slice(start, end + 1).join("\n");

  const handoffTargets = [];
  for (const match of source.matchAll(HANDOFF_LINE_PATTERN)) {
    const role = handoffTargetForToken(match[1]);
    handoffTargets.push(role || match[1].toLowerCase());
  }
  const completes = [...source.matchAll(COMPLETE_LINE_PATTERN)];
  const asks = [...source.matchAll(ASK_USER_LINE_PATTERN)];

  const actions = [];
  if (handoffTargets.length > 0) actions.push("HANDOFF");
  if (completes.length > 0) actions.push("COMPLETE");
  if (asks.length > 0) actions.push("ASK_USER");
  if (actions.length === 0) return null;
  if (actions.length > 1) {
    return { action: null, ambiguous: true };
  }

  if (actions[0] === "COMPLETE") {
    // HANDOFF의 distinct-대상 규칙과 같은 규율: 서로 다른 값이 여러 번
    // 나오면 어느 쪽이 진짜인지 단정하지 않는다. 동일 줄 반복은 하나로 본다.
    const summaries = [...new Set(completes.map((match) => (match[1] || "").trim()))];
    if (summaries.length > 1) {
      return { action: "COMPLETE", summary: null, ambiguous: true };
    }
    return { action: "COMPLETE", summary: summaries[0] || null, ambiguous: false };
  }
  if (actions[0] === "ASK_USER") {
    // 질문이 여러 개면 마지막 것만 남기고 나머지를 조용히 버리게 된다 —
    // 사용자가 내려야 할 결정 하나를 잃는 것이므로 ambiguous로 반환해
    // 모델이 한 줄로 다시 묻게 한다.
    const questions = [...new Set(asks.map((match) => (match[1] || "").trim()))];
    if (questions.length > 1) {
      return { action: "ASK_USER", question: null, ambiguous: true };
    }
    return { action: "ASK_USER", question: questions[0] || null, ambiguous: false };
  }

  const distinct = [...new Set(handoffTargets)];
  const last = handoffTargets[handoffTargets.length - 1];
  const known = isHandoffTarget(last) ? last : null;
  const purposeMatch = source.match(PURPOSE_LINE_PATTERN);
  const reasonMatch = source.match(REASON_LINE_PATTERN);
  return {
    action: "HANDOFF",
    targetRole: distinct.length === 1 ? known : null,
    purpose: purposeMatch ? purposeMatch[1].trim() : null,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
    ambiguous: distinct.length > 1,
  };
}

module.exports = {
  INTERACTION_TARGETS,
  INTERACTION_INTENTS,
  INTERACTION_SCOPES,
  EXECUTION_POLICIES,
  normalizeInteraction,
  HANDOFF_TARGETS,
  CONTROL_ACTIONS,
  HANDOFF_TARGET_ALIASES,
  isHandoffTarget,
  resolveReviewerContract,
  executionContractFor,
  surfaceRoleForContract,
  RESULT_CONTROL_ROUTES,
  validateResultControl,
  DEFAULT_HANDOFF_BUDGET,
  createHandoffLedger,
  serializeHandoffLedger,
  recoverHandoffLedger,
  recoverHandoffLedgerForRoot,
  newInvocationId,
  validateHandoff,
  consumeHandoff,
  settleHandoff,
  parseControlOutput,
  stripControlOutput,
};
