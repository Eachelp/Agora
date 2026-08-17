"use strict";

// Stage C-2 — Professional role-scoped logical session identity.
//
// deriveSessionKey는 순수 함수다. control plane이 이미 확정한 ExecutionContext에서
// canonical SessionKey 문자열을 만든다. 아래 7개 identity 구성요소가 모두 확정된
// 경우에만 key를 만들고, 하나라도 없거나 model이 미해결('default')이면 null을
// 반환한다(= persistent logical session 대상 아님 → sessionless one-shot 경로).
//
// SessionKey =
//   projectId + workspaceId + professionalRunId + role + providerId
//   + modelKey + permissionMode
//
// 확정된 계약(개발일지 Stage C-2):
//   - role 포함: Planner/Plan Reviewer/Builder/Reviewer/Recorder 세션 분리.
//   - professionalRunId 포함: 같은 run의 Builder revision은 재사용, 새 run은 자동 격리.
//   - permissionMode 포함: security scope. 다르면 다른 세션(fail-closed).
//   - modelKey는 resolved concrete model. 'default'/미해결이면 세션 미생성.
//   - effort / frozenRunId / taskHash는 identity가 아니다(provenance).
//
// 이 모듈은 어떤 authority도 갖지 않는다: workspace/permission/model을 스스로
// 계산하지 않고, control plane이 넘긴 값을 식별자로 조합만 한다.

const SESSION_KEY_VERSION = "hsk1";

// key identity를 구성하는 필드와 순서(고정). 순서가 바뀌면 key가 달라지므로 고정한다.
const SESSION_KEY_FIELDS = Object.freeze([
  "projectId",
  "workspaceId",
  "professionalRunId",
  "role",
  "providerId",
  "modelKey",
  "permissionMode",
]);

// model이 확정되지 않은 상태를 나타내는 값들. 이 경우 persistent session을 만들지 않는다.
function isResolvedModel(modelKey) {
  if (typeof modelKey !== "string") return false;
  const trimmed = modelKey.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === "default") return false;
  return true;
}

// 모든 identity 구성요소가 확정되어 persistent session 대상이 되는지 판정한다.
function isEligibleContext(context) {
  if (!context || typeof context !== "object") return false;
  for (const field of SESSION_KEY_FIELDS) {
    if (field === "modelKey") {
      if (!isResolvedModel(context.modelKey)) return false;
      continue;
    }
    const value = context[field];
    if (value == null || value === "") return false;
  }
  return true;
}

// 확정된 context에서 canonical SessionKey 문자열을 만든다. 대상이 아니면 null.
// encodeURIComponent로 각 구성요소를 감싸 구분자('|') 충돌을 막는다.
function deriveSessionKey(context) {
  if (!isEligibleContext(context)) return null;
  const parts = SESSION_KEY_FIELDS.map((field) => encodeURIComponent(String(context[field])));
  return `${SESSION_KEY_VERSION}:${parts.join("|")}`;
}

module.exports = {
  SESSION_KEY_VERSION,
  SESSION_KEY_FIELDS,
  isResolvedModel,
  isEligibleContext,
  deriveSessionKey,
};
