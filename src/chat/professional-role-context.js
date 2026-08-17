"use strict";

// Professional Mode 단계별 역할 context 경계를 정의하는 중앙 정책.
// chat-prompt.js가 이 정책을 import해 각 역할 프롬프트에
// "참고 입력" / "보지 않는 입력" 문구를 자동 생성한다.
//
// sees: 해당 역할이 프롬프트에서 참조하는 context 종류
// excludes: 명시적으로 전달하지 않는 context 종류

const ROLE_CONTEXT_POLICY = {
  planner: {
    // 기획자는 사용자 요청과 대화 흐름을 그대로 보고 기획을 세운다.
    sees: [
      "userRequest",
      "conversationContext",
      "conversationTranscript",
      "workspace",
      "projectRules",
      "taskList",
    ],
    excludes: ["builderDiff", "builderSelfReport", "evidence", "otherAgentOutput"],
  },
  plan_review: {
    // 기획 검수자는 사용자 원 요청과 프로젝트 맥락·작업 목록을 보고
    // 기획이 맞게 세워졌는지 판단한다. 다만 다른 에이전트의 자유 대화
    // 전문(transcript)과 Builder 산출물은 보지 않는다.
    sees: ["plannerTask", "projectRules", "workspace", "conversationContext", "taskList"],
    excludes: ["conversationTranscript", "builderDiff", "evidence", "otherAgentOutput"],
  },
  implementation: {
    sees: ["frozenTask", "projectRules", "workspace"],
    excludes: ["conversationTranscript", "taskList", "otherAgentOutput"],
  },
  review: {
    sees: ["frozenTask", "builderDiff", "evidence", "projectRules"],
    excludes: ["conversationTranscript", "builderSelfReport", "taskList"],
  },
  recorder: {
    sees: ["frozenTask", "finalDiff", "evidence", "finalVerdict"],
    excludes: ["conversationTranscript", "otherAgentFreeChat"],
  },
};

// 역할명에 해당하는 context 경계 정책을 반환한다.
function roleContextFor(role) {
  return ROLE_CONTEXT_POLICY[role] || null;
}

// 프롬프트 조립의 single source: 해당 역할이 특정 context를 볼 수 있는지 판정한다.
// 정책에 명시된 excludes면 차단하고, sees에 있으면 허용한다. 정책이 없는
// 역할(일반 채팅 등)은 기존 동작대로 허용한다.
function roleSees(role, contextKind) {
  const policy = roleContextFor(role);
  if (!policy) return true;
  if (policy.excludes.includes(contextKind)) return false;
  if (policy.sees.includes(contextKind)) return true;
  // 정책에 명시되지 않은 context는 역할 정책이 있는 경우 보수적으로 차단한다.
  return false;
}

// 프롬프트 조립에서 쓰는 context 종류를 역할 정책 어휘로 잇는 매핑.
// 조립 코드가 하드코딩 분기 대신 이 표를 통해 정책을 조회한다.
const PROMPT_CONTEXT_KINDS = Object.freeze({
  // 최근 대화 최소 윈도우(transcript) 포함 여부도 중앙 정책이 결정한다.
  // conversationContext kind 자체는 identity로 매핑해 roleSees 판정을 태운다.
  conversationContext: "conversationContext",
  conversationTranscript: "conversationTranscript",
  projectContext: "conversationContext",
  workflowContext: "taskList",
  // 누적 대화 요약(memory)은 대화 전문에 준하는 입력이므로
  // conversationTranscript 경계를 따른다.
  memoryContext: "conversationTranscript",
});

// 특정 역할이 프롬프트 조립 단계의 context 블록을 포함해야 하는지 판정한다.
function includesPromptContext(role, blockName) {
  const kind = PROMPT_CONTEXT_KINDS[blockName];
  if (!kind) return true;
  return roleSees(role, kind);
}

// chat-prompt.js에서 사용: 역할별 context 경계를 한국어 안내 문구로 변환한다.
function roleContextNotice(role) {
  const policy = roleContextFor(role);
  if (!policy) return "";
  const parts = [];
  if (policy.sees.length > 0) {
    parts.push("참고 입력: " + policy.sees.join(", "));
  }
  if (policy.excludes.length > 0) {
    parts.push("보지 않는 입력: " + policy.excludes.join(", "));
  }
  return parts.join(" | ");
}

module.exports = {
  ROLE_CONTEXT_POLICY,
  roleContextFor,
  roleContextNotice,
  roleSees,
  includesPromptContext,
  PROMPT_CONTEXT_KINDS,
};
