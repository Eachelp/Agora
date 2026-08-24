"use strict";

// Stage D-B — Resource & Capability Governance
//
// D-0의 workspace lease와 D-A의 verification capability를 일반 resource/action
// 모델로 확장한다. **범용 Resource Registry를 먼저 만들지 않는다** — 실제로
// 필요한 자원·행동부터 일반화한다(premature abstraction 금지).
//
//   resource   무엇에 대한 행동인가        (workspace / artifact / external)
//   action     무엇을 하는가              (read / mutate / execute / external-effect)
//   effective  실제로 부여된 권한          (요청 ≠ 부여)
//   controlClass  실행 당시 실제 통제 특성  (선언이 아니라 계산 — R-1)
//   sideEffect    되돌릴 수 있는가
//   approval      행동 전에 사람이 필요한가
//
// 핵심 규칙(§23):
//
//   side effect + controlClass = NEITHER  →  행동 전 HUMAN_APPROVAL
//
// 사후 자기보고를 verified evidence로 승격하지 않는다. 강제할 수 없는 권한
// 선언은 governance가 아니라 희망사항이다.
//
// **sandbox를 목표로 삼지 않는다(§24).** 플랫폼이 실제로 강제할 수 있을 때만
// controlClass를 올린다. 못 하면 OBSERVABLE 또는 NEITHER + HUMAN_APPROVAL로
// 정직하게 처리한다. D-A0의 process = OBSERVABLE baseline을 보존한다.

const { CONTROL_CLASS } = require("../verification-runner");

const RESOURCE_KINDS = Object.freeze({
  WORKSPACE: "workspace",       // 관리되는 로컬 작업 폴더 (D-0 lease 대상)
  ARTIFACT: "artifact",         // Agora 자신이 읽는 산출물
  PROCESS: "process",           // 외부 프로세스 실행
  EXTERNAL: "external",         // Agora 밖의 세계 (메일·배포·외부 DB 등)
});

const ACTIONS = Object.freeze({
  READ: "read",
  MUTATE: "mutate",
  EXECUTE: "execute",
  EXTERNAL_EFFECT: "external-effect",
});

const APPROVAL = Object.freeze({
  NONE: "NONE",
  HUMAN_APPROVAL: "HUMAN_APPROVAL",
});

// 되돌릴 수 있는가. 되돌릴 수 없는 행동은 통제 수준이 같아도 무게가 다르다.
const REVERSIBILITY = Object.freeze({
  REVERSIBLE: "REVERSIBLE",       // checkpoint/lease로 되돌릴 수 있다
  IRREVERSIBLE: "IRREVERSIBLE",   // 한번 나가면 회수할 수 없다
  UNKNOWN: "UNKNOWN",
});

// 실제 enforcement 특성에서 controlClass를 계산한다. 선언 문자열을 신뢰하지 않는다.
//
//   Agora 내부 artifact read              → ENFORCEABLE (쓰기 경로 자체가 없다)
//   managed workspace mutation + lease    → ENFORCEABLE (lease가 실제로 막는다)
//   generic subprocess 내부 fs/network    → OBSERVABLE  (관측만 가능 — D-A0 baseline)
//   강제도 관찰도 못 하는 외부 side effect → NEITHER
function computeResourceControlClass({
  resourceKind,
  action,
  leaseHeld = false,
  containment = null,
  observable = false,
} = {}) {
  // 플랫폼이 실제 containment를 제공하면 그때만 올린다(§24).
  // 지금은 어떤 backend도 이 신호를 주지 않는다 — 자리만 남긴다.
  if (containment === "os-sandbox") return CONTROL_CLASS.ENFORCEABLE;

  if (resourceKind === RESOURCE_KINDS.ARTIFACT && action === ACTIONS.READ) {
    // Agora 자신의 read-only 평가. 쓰기 경로가 없다.
    return CONTROL_CLASS.ENFORCEABLE;
  }
  if (resourceKind === RESOURCE_KINDS.WORKSPACE && action === ACTIONS.MUTATE) {
    // D-0 lease가 실제로 동시 변경을 막는다. lease가 없으면 그 보증이 없다.
    return leaseHeld ? CONTROL_CLASS.ENFORCEABLE : CONTROL_CLASS.NEITHER;
  }
  if (resourceKind === RESOURCE_KINDS.WORKSPACE && action === ACTIONS.READ) {
    return CONTROL_CLASS.ENFORCEABLE;
  }
  if (resourceKind === RESOURCE_KINDS.PROCESS && action === ACTIONS.EXECUTE) {
    // Charter v0.5 — 시작·종료·출력은 관측하지만 내부 행동은 강제하지 못한다.
    return CONTROL_CLASS.OBSERVABLE;
  }
  if (resourceKind === RESOURCE_KINDS.EXTERNAL) {
    // 되돌릴 수도 막을 수도 없다. 관측 신호가 있으면 OBSERVABLE, 없으면 NEITHER.
    return observable ? CONTROL_CLASS.OBSERVABLE : CONTROL_CLASS.NEITHER;
  }
  // 모르는 조합을 위로 올리지 않는다(fail-closed floor).
  return CONTROL_CLASS.NEITHER;
}

const PERMISSION_RANK = Object.freeze({ chat: 0, "workspace-read": 1, "workspace-write": 2 });

// 요청한 권한과 실제 부여 권한은 다르다. 역할 상한을 넘겨주지 않는다.
function effectivePermission(requested, cap) {
  const r = PERMISSION_RANK[requested];
  const c = PERMISSION_RANK[cap];
  if (r == null || c == null) return null;
  return r <= c ? requested : cap;
}

// 되돌릴 수 없는 외부 행동인가.
function classifyReversibility({ resourceKind, action, checkpointProtected = false }) {
  if (resourceKind === RESOURCE_KINDS.EXTERNAL && action === ACTIONS.EXTERNAL_EFFECT) {
    return REVERSIBILITY.IRREVERSIBLE;
  }
  if (resourceKind === RESOURCE_KINDS.WORKSPACE && action === ACTIONS.MUTATE) {
    return checkpointProtected ? REVERSIBILITY.REVERSIBLE : REVERSIBILITY.UNKNOWN;
  }
  if (action === ACTIONS.READ) return REVERSIBILITY.REVERSIBLE;
  return REVERSIBILITY.UNKNOWN;
}

// 하나의 자원 행동을 심사한다.
//
// 이 함수는 "허용/거부"만 내지 않는다. 무엇이 실제로 부여됐고, 왜 사람이
// 필요한지를 함께 돌려준다 — 그래야 UI가 §9 P-3의 사전 예고를 만들 수 있다.
function adjudicateAction(request = {}, context = {}) {
  const resourceKind = request.resourceKind || null;
  const action = request.action || null;

  if (!Object.values(RESOURCE_KINDS).includes(resourceKind)) {
    return { ok: false, code: "UNKNOWN_RESOURCE", error: `알 수 없는 자원 종류입니다: ${resourceKind}` };
  }
  if (!Object.values(ACTIONS).includes(action)) {
    return { ok: false, code: "UNKNOWN_ACTION", error: `알 수 없는 행동입니다: ${action}` };
  }

  const permission = effectivePermission(
    request.requestedPermission || "workspace-read",
    context.permissionCap || "workspace-read"
  );
  if (!permission) {
    return { ok: false, code: "PERMISSION_UNCOMPUTABLE", error: "행동 권한을 계산할 수 없습니다." };
  }

  // 쓰기 권한이 없는데 변경/외부효과를 요청하면 거부한다.
  const needsWrite = action === ACTIONS.MUTATE || action === ACTIONS.EXTERNAL_EFFECT;
  if (needsWrite && PERMISSION_RANK[permission] < PERMISSION_RANK["workspace-write"]) {
    return {
      ok: false,
      code: "PERMISSION_DENIED",
      error: "이 작업에는 변경 권한이 없습니다.",
      effectivePermission: permission,
    };
  }

  const controlClass = computeResourceControlClass({
    resourceKind,
    action,
    leaseHeld: Boolean(context.leaseHeld),
    containment: context.containment || null,
    observable: Boolean(request.observable),
  });

  const hasSideEffect = action === ACTIONS.MUTATE || action === ACTIONS.EXTERNAL_EFFECT;
  const reversibility = classifyReversibility({
    resourceKind,
    action,
    checkpointProtected: Boolean(context.checkpointProtected),
  });

  // §23 핵심 규칙 — side effect + NEITHER면 행동 전 사람 승인.
  // 사후 자기보고는 evidence가 아니다.
  let approval = APPROVAL.NONE;
  const approvalReasons = [];
  if (hasSideEffect && controlClass === CONTROL_CLASS.NEITHER) {
    approval = APPROVAL.HUMAN_APPROVAL;
    approvalReasons.push("Agora가 이 행동을 막거나 관측할 수 없습니다.");
  }
  if (reversibility === REVERSIBILITY.IRREVERSIBLE) {
    approval = APPROVAL.HUMAN_APPROVAL;
    approvalReasons.push("되돌릴 수 없는 외부 행동입니다.");
  }

  return {
    ok: true,
    resourceKind,
    action,
    resourceId: request.resourceId || null,
    requestedPermission: request.requestedPermission || null,
    effectivePermission: permission,
    controlClass,
    hasSideEffect,
    reversibility,
    approvalRequirement: approval,
    approvalReasons,
    // 사전 승인이 필요한 행동은 승인 없이 자동 실행되지 않는다.
    autoExecutable: approval === APPROVAL.NONE,
  };
}

// 승인 없이 실행하려는 시도를 막는 관문. adjudicate 결과를 그대로 받는다.
function admitAction(adjudication, { humanApprovalGranted = false } = {}) {
  if (!adjudication?.ok) return { ok: false, code: adjudication?.code || "NOT_ADJUDICATED", error: adjudication?.error || null };
  if (adjudication.approvalRequirement === APPROVAL.HUMAN_APPROVAL && !humanApprovalGranted) {
    return {
      ok: false,
      code: "HUMAN_APPROVAL_REQUIRED",
      error: adjudication.approvalReasons.join(" ") || "사용자 승인이 필요한 행동입니다.",
      adjudication,
    };
  }
  return { ok: true, adjudication };
}

// 계획 승인 화면의 사전 예고 원자료(§9 P-3).
// 계획된 행동 중 사람이 필요한 것만 추려 준다.
function plannedApprovals(requests = [], context = {}) {
  const out = [];
  for (const request of requests) {
    const adjudication = adjudicateAction(request, context);
    if (adjudication.ok && adjudication.approvalRequirement === APPROVAL.HUMAN_APPROVAL) {
      out.push({
        resourceKind: adjudication.resourceKind,
        action: adjudication.action,
        resourceId: adjudication.resourceId,
        reasons: adjudication.approvalReasons,
      });
    }
  }
  return out;
}

module.exports = {
  RESOURCE_KINDS,
  ACTIONS,
  APPROVAL,
  REVERSIBILITY,
  computeResourceControlClass,
  effectivePermission,
  classifyReversibility,
  adjudicateAction,
  admitAction,
  plannedApprovals,
};
