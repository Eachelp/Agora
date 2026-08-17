"use strict";

// Professional Mode 단계별 역할 context 경계를 정의하는 중앙 정책.
// chat-prompt.js가 이 정책을 import해 각 역할 프롬프트에
// "참고 입력" / "보지 않는 입력" 문구를 자동 생성한다.
//
// sees: 해당 역할이 프롬프트에서 참조하는 context 종류
// excludes: 명시적으로 전달하지 않는 context 종류

const ROLE_CONTEXT_POLICY = {
  planner: {
    sees: ["userRequest", "conversationContext", "workspace", "projectRules", "taskList"],
    excludes: ["builderDiff", "builderSelfReport", "evidence", "otherAgentOutput"],
  },
  plan_review: {
    sees: ["plannerTask", "projectRules", "workspace"],
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
};
