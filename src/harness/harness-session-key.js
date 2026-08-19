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
//   + providerAccountKey + modelKey + permissionMode
//
// 확정된 계약(개발일지 Stage C-2):
//   - role 포함: Planner/Plan Reviewer/Builder/Reviewer/Recorder 세션 분리.
//   - professionalRunId 포함: 같은 run의 Builder revision은 재사용, 새 run은 자동 격리.
//   - permissionMode 포함: security scope. 다르면 다른 세션(fail-closed).
//   - modelKey는 resolved concrete model. 'default'/미해결이면 세션 미생성.
//   - providerAccountKey 포함: provider 계정 identity(opaque stable local profile
//     key/fingerprint). 계정 전환은 provider-wide 세션 파괴가 아니라 selection
//     boundary다 — 다른 계정의 세션은 key namespace가 달라 선택되지 않을 뿐
//     보존(parked)되고, 같은 계정으로 돌아오면 같은 key로 다시 선택된다. 계정을
//     추적하지 않는 조립(구형/테스트)은 null을 허용한다(빈 segment). 계정이
//     unknown인 경우의 fail-closed는 runtime gate가 담당하며, 이 모듈은 절대
//     unknown을 namespace로 인코딩하지 않는다(null = 미추적 ≠ unknown).
//   - effort / frozenRunId / taskHash는 identity가 아니다(provenance).
//
// 이 모듈은 어떤 authority도 갖지 않는다: workspace/permission/model/account를
// 스스로 계산하지 않고, control plane이 넘긴 값을 식별자로 조합만 한다.

const SESSION_KEY_VERSION = "hsk2";

// key identity를 구성하는 필드와 순서(고정). 순서가 바뀌면 key가 달라지므로 고정한다.
const SESSION_KEY_FIELDS = Object.freeze([
  "projectId",
  "workspaceId",
  "professionalRunId",
  "role",
  "providerId",
  "providerAccountKey",
  "modelKey",
  "permissionMode",
]);

// 값이 없어도 key를 만들 수 있는 필드(미추적 = 빈 segment). 나머지는 전부 필수다.
const OPTIONAL_KEY_FIELDS = Object.freeze(["providerAccountKey"]);

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
    if (OPTIONAL_KEY_FIELDS.includes(field)) continue;
    if (value == null || value === "") return false;
  }
  return true;
}

// 확정된 context에서 canonical SessionKey 문자열을 만든다. 대상이 아니면 null.
// encodeURIComponent로 각 구성요소를 감싸 구분자('|') 충돌을 막는다.
function deriveSessionKey(context) {
  if (!isEligibleContext(context)) return null;
  const parts = SESSION_KEY_FIELDS.map((field) => {
    const value = context[field];
    return value == null ? "" : encodeURIComponent(String(value));
  });
  return `${SESSION_KEY_VERSION}:${parts.join("|")}`;
}

module.exports = {
  SESSION_KEY_VERSION,
  SESSION_KEY_FIELDS,
  isResolvedModel,
  isEligibleContext,
  deriveSessionKey,
};
