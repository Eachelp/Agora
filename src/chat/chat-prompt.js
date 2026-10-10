const { buildConversationWindow } = require("./chat-summary-window");

const DEFAULT_MAX_MESSAGES = 40;

// 기록 산출물의 출력 계약. 토론 기록(discussionSummary.record)이 이 JSON을 내야
// parseRecorderOutput이 읽어 프로젝트 기록에 저장할 수 있다.
const RECORDER_OUTPUT_LINES = [
  "- 아래 JSON 형식으로만 답하세요. 코드 블록을 써도 되고 안 써도 됩니다.",
  "- summary에는 이번 작업에서 확인된 사실, 결정, 완료 내용, 남은 작업을 Markdown으로 적으세요.",
  "- decisions에는 대화에서 실제로 합의된 내용만 넣으세요.",
  "- nextActions에는 대화에서 명시적으로 언급된 다음 할 일만 넣으세요.",
  "- 대화에 없는 계획을 지어내지 마세요. 추측이나 확인되지 않은 내용을 사실처럼 기록하지 마세요.",
  "- 프로젝트 규칙 변경이 필요하면 nextActions에 제안만 적고, 직접 규칙을 바꾸지 마세요.",
  '{"summary": "...", "decisions": [{"title": "...", "content": "..."}], "nextActions": [{"title": "...", "description": "..."}]}',
];

function speakerLabel(message, agentsById) {
  if (message.authorType === "user") return message.authorName || "User";
  const agent = agentsById.get(message.author);
  return `@${agent ? agent.id : message.author}`;
}

function attachmentSuffix(message) {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return "";
  const names = message.attachments.map((attachment) => attachment.name).join(", ");
  return ` [첨부: ${names}]`;
}

function permissionRule(permissionMode) {
  if (permissionMode === "workspace-read") {
    return "- 워크스페이스 파일을 읽고 검색할 수 있지만, 수정하거나 명령을 실행하지 마세요.";
  }
  if (permissionMode === "workspace-write") {
    return "- 워크스페이스 파일을 읽고 수정할 수 있습니다. 요청 범위를 벗어난 변경은 하지 마세요.";
  }
  return "- 도구 실행이나 파일 수정 없이 대화로만 답하세요.";
}

// 대화 참가자 한 명에게 보낼 프롬프트. 일반 채팅, 토론 발언, 토론 결론 종합,
// 쉽게 설명, 다른 참가자 메시지 전달(handoff)이 모두 이 한 함수를 거친다.
function buildAgentPrompt({
  agent,
  agents,
  messages,
  maxMessages = DEFAULT_MAX_MESSAGES,
  permissionMode = "chat",
  projectContext = "",
  memoryContext = "",
  rulesContext = "",
  workflowContext = "",
  discussion = null,
  handoff = null,
  broadcast = null,
  parallel = null,
  mentionsEnabled = !discussion,
  discussionSummary = null,
  simplifyMeta = null,
  extraLines = [],
}) {
  const isDiscussionSummary = Boolean(discussionSummary);
  const isSimplify = Boolean(simplifyMeta);
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const others = agents.filter((entry) => entry.id !== agent.id);
  // 긴 대화는 오래된 부분을 요약해 남긴다. slice(-maxMessages) 밖을 요약도 없이
  // 버리는 것보다 "요약해서 남김"이 낫다. 토론 발언·결론 종합·쉽게 설명은 자기
  // 범위의 메시지만 받으므로 압축하지 않는다.
  const useGeneralSummaryWindow = !isDiscussionSummary && !isSimplify && !discussion;
  const conversationWindow = useGeneralSummaryWindow
    ? buildConversationWindow(messages, { maxMessages })
    : null;
  const recent = isSimplify
    ? []
    : isDiscussionSummary
      ? messages
      : conversationWindow?.compacted
        ? conversationWindow.recent
        : messages.slice(-maxMessages);
  const omitted = isDiscussionSummary || isSimplify
    ? 0
    : conversationWindow?.compacted
      ? conversationWindow.omitted
      : messages.length - recent.length;
  const pinned = conversationWindow?.compacted ? conversationWindow.pinned : [];
  const compressedHistory = conversationWindow?.compacted ? conversationWindow.summary : [];

  const lines = [];
  if (isDiscussionSummary) {
    lines.push(
      discussionSummary?.record
        ? `당신은 Agora의 토론 기록자 "@${agent.id}"(${agent.name})입니다.`
        : `당신은 Agora의 토론 결론 종합자 "@${agent.id}"(${agent.name})입니다.`
    );
    lines.push("앞서 진행된 논의(사용자 질문, 사전 발언, 토론 전체)를 객관적으로 분석해 핵심 결론을 명확하고 구조화된 요약 카드로 정리하세요.");
    lines.push("");
    lines.push("작성 규칙:");
    lines.push("- 새로운 파일 수정이나 도구 명령을 제안하지 말고, 오직 제시된 대화 내용에만 근거해 정리하세요.");
    lines.push("- 다른 참가자를 @멘션으로 호출하지 마세요.");
    lines.push("- 대화에서 쓰인 언어로 답하세요.");
    if (discussionSummary?.record) {
      // 토론 기록은 대화를 근거로 하는 일반 턴이다. 출력만 프로젝트 기억에 저장할
      // 수 있는 JSON 계약을 따른다.
      lines.push(...RECORDER_OUTPUT_LINES);
    } else {
      lines.push("- 아래의 고정 섹션 구조를 정확히 지켜 Markdown으로 작성하세요:");
      lines.push("  ## 논의 주제");
      lines.push("  ## 공통 합의점");
      lines.push("  ## 주요 쟁점과 입장");
      lines.push("  ## 권장 결론");
      lines.push("  ## 사용자 결정 사항 / 다음 행동");
    }
    if (discussionSummary?.incomplete || (discussionSummary?.failures && discussionSummary.failures > 0)) {
      lines.push("");
      lines.push("⚠ 주의: 이번 토론은 정해진 실행 예산 도달, 사용자 중단 또는 일부 참가자 오류로 인해 '미완성' 상태로 종료되었습니다. 요약 상단에 토론이 미완성으로 끝났음을 알리고, 합의가 불완전하거나 오류로 누락된 지점을 분명히 밝히세요.");
    }
  } else if (isSimplify) {
    lines.push(`당신은 복잡한 기술적 내용을 비개발자도 이해하기 쉽게 풀어주는 통역가("@${agent.id}")입니다.`);
    lines.push("");
    lines.push("작성 규칙:");
    lines.push("- 전문 개발 용어나 내부 아키텍처, 단순 로그 설명을 걷어내세요.");
    lines.push("- 비개발자 시점에서 명확하고 깔끔한 업무 언어로 핵심(원인, 결과, 결정할 사항)만 재작성하세요.");
    lines.push("- 과도한 비유나 어린아이 대하듯 하는 어투는 피하고, 보고서처럼 담백하게 정리하세요.");
    lines.push("- 다른 참가자를 @멘션으로 호출하지 마세요.");
    lines.push("- 인사말이나 서론 없이, 결과만 바로 출력하세요.");
  } else {
    lines.push(
      `당신은 여러 AI 코딩 에이전트가 사용자와 함께 있는 그룹 채팅의 참가자 "@${agent.id}"(${agent.name})입니다.`
    );
    const roster = ["사용자(User)", ...agents.map((entry) => `@${entry.id}(${entry.name})`)];
    lines.push(`참가자: ${roster.join(", ")}`);
    lines.push("");
    lines.push("규칙:");
    lines.push("- 아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요.");
    lines.push(
      `- 출력 전체가 채팅 메시지 하나로 그대로 전송됩니다. "[@${agent.id}]" 같은 접두어나 서명을 붙이지 마세요.`
    );
    if (others.length > 0 && mentionsEnabled) {
      lines.push(
        `- 다른 참가자를 호출하려면 @이름(${others.map((entry) => `@${entry.id}`).join(", ")})을 쓰세요. 그러면 그 참가자가 이어서 답합니다. 호출 없이 언급만 할 때는 @ 없이 이름만 쓰세요. 호출은 꼭 필요할 때만 하세요.`
      );
      lines.push("- 한 번에 한 명만 발언합니다. 답을 마치면 사용자에게 결정을 넘기거나, 추가 의견이 꼭 필요할 때만 다른 참가자를 @로 호출해 다음 턴을 넘기세요.");
    } else if (others.length > 0) {
      lines.push("- 이번 턴에는 다른 참가자를 추가 호출할 수 없습니다. 다른 참가자를 언급하려면 @ 없이 이름만 쓰세요.");
    }
    // 질문 계약(ASK_USER + OPTION). 일반 채팅 턴에서만 안내한다 — chat-room이
    // 같은 조건(isFreeChatContext)에서만 이 계약을 읽는다.
    if (!discussion) {
      lines.push(
        "- 맡은 작업을 이어가려면 사용자의 결정이 꼭 필요할 때만, 응답 **맨 끝**에 `ASK_USER: <질문 한 줄>`을 붙이세요. 고르는 질문이면 그 아래 `OPTION: <보기>` 줄을 2~5개 이어 붙이세요(짧은 명사구). 제어 줄은 응답 마지막의 연속된 줄이어야 합니다(뒤에 다른 문장 금지)."
      );
      lines.push(
        "- 제어 줄은 화면에 보이지 않고 '답변 대기' 표시와 선택 버튼으로 바뀝니다. 질문은 본문에도 자연스럽게 적으세요. 선택지를 제안하며 마무리하는 경우나 \"더 도울 일이 있을까요?\" 같은 마무리 인사에는 붙이지 마세요 — 그런 답은 사용자가 읽고 알아서 이어갑니다."
      );
    }
  }
  lines.push(permissionRule(permissionMode));
  lines.push("- 채팅에 어울리게 간결히 답하세요.");
  lines.push("- 대화에서 쓰인 언어로 답하세요.");
  const MAX_CONTEXT_CHARS = 16000;
  const rules = isSimplify ? "" : String(rulesContext || "").trim();
  if (rules) {
    lines.push("");
    lines.push("=== 프로젝트 현재 규칙 ===");
    lines.push(rules);
    lines.push("=== 프로젝트 현재 규칙 끝 ===");
    lines.push("- 이 규칙은 반드시 지키세요.");
  }
  const context = isSimplify ? "" : String(projectContext || "").trim();
  if (context) {
    lines.push("");
    lines.push("=== 프로젝트 공통 맥락 ===");
    lines.push(context);
    lines.push("=== 프로젝트 공통 맥락 끝 ===");
  }
  const workflow = isSimplify ? "" : String(workflowContext || "").trim();
  if (workflow) {
    lines.push("");
    lines.push("=== 확정된 결정과 진행 중 작업 ===");
    lines.push(workflow);
    lines.push("=== 확정된 결정과 진행 중 작업 끝 ===");
  }
  const memoryFull = isSimplify ? "" : String(memoryContext || "").trim();
  if (memoryFull) {
    const usedSoFar = rules.length + context.length + workflow.length;
    const budget = Math.max(0, MAX_CONTEXT_CHARS - usedSoFar);
    // budget이 0이면 slice(-0)이 문자열 전체를 돌려주므로, 잘라내야 할 상황에
    // 오히려 전부 들어갑니다. 0일 때는 요약을 아예 넣지 않습니다.
    const memory = memoryFull.length <= budget
      ? memoryFull
      : budget > 0
        ? `(누적 요약 앞부분은 생략됨)
${memoryFull.slice(-budget)}`
        : "";
    if (memory) {
      lines.push("");
      lines.push("=== 프로젝트 누적 요약 ===");
      lines.push(memory);
      lines.push("=== 프로젝트 누적 요약 끝 ===");
      lines.push("- 누적 요약에는 검증되지 않은 기록관 초안이 섞여 있습니다. 확정된 사실·결정·규칙으로 취급하지 말고, 원문 대화와 구분해 사용하세요.");
    }
  }
  // 캐릭터 이모티콘 지시는 작업용 사용에 불필요해 프롬프트에서 제외합니다.
  // 예전 대화에 남은 [[CODEPET_EMOTE:...]] 태그는 chat-room.js에서 화면 노출 전에 제거합니다.
  if (broadcast && broadcast.position > 1) {
    lines.push(
      `- 사용자 메시지에 참가자 ${broadcast.total}명이 차례로 답하는 중이고, 당신은 ${broadcast.position}번째입니다. 앞선 참가자의 답변을 읽고, 겹치는 내용은 반복하지 말고 보완하거나 다른 관점만 더하세요.`
    );
  }
  // 독립 발언은 여럿이 같은 폴더에서 **동시에** 실행된다. 파일 단위 충돌은
  // 프로그램이 막지 않으므로(같은 파일을 둘이 고치면 나중 쓰기가 이긴다),
  // 쓰기 권한일 때는 각자 자기 폴더에서만 작업하도록 계약을 준다.
  // 읽기는 겹쳐도 안전하므로 제한하지 않는다.
  if (parallel && permissionMode === "workspace-write") {
    lines.push(
      `- 지금 참가자 ${parallel.total}명이 같은 작업 폴더에서 동시에 실행되고 있습니다. 서로의 결과를 덮어쓰지 않도록 다음을 지키세요.`
    );
    lines.push(
      `  · 새로 만들거나 고치는 파일은 작업 폴더 아래 \`${parallel.folder}/\` 하위에만 두세요. 그 밖의 기존 파일은 고치지 마세요(읽기는 자유입니다).`
    );
    lines.push(
      "  · git·패키지 설치·빌드처럼 작업 폴더 전체에 영향을 주는 명령은 실행하지 마세요. 다른 참가자의 작업과 섞입니다."
    );
  }
  if (discussion) {
    if (discussion.role) {
      // 구조화 토론: 참가자 정체성은 그대로 두고 이번 토론에서만 유효한
      // 임시 역할을 덧씌운다. 순서는 Preset이 정하며 모델이 바꿀 수 없다.
      lines.push(
        `- 지금은 구조화 토론입니다. 사이클 ${discussion.cycle}/${discussion.cycleBudget}, 단계 ${discussion.step}/${discussion.stepCount} (전체 ${discussion.turn}/${discussion.maxTurns}턴).`
      );
      lines.push(
        `- 이번 발언의 임시 역할: ${discussion.role.name} — ${discussion.role.charter}`
      );
      lines.push(
        "- 이 역할은 이번 토론에서만 유효합니다. 발언 순서는 Preset이 정하므로 다른 참가자를 호출하거나 순서 변경을 요청하지 마세요."
      );
      if (discussion.finalStep) {
        lines.push(
          "- 응답 마지막 줄에 반드시 다음 중 하나만 붙이세요: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:CONCLUDE]]. 다음 사이클이 필요하면 CONTINUE, 충분한 결론에 도달했으면 CONCLUDE를 선택하세요."
        );
      } else {
        lines.push(
          "- 응답 마지막 줄에 반드시 [[CODEPET_DISCUSSION:CONTINUE]]를 붙이세요. 토론 종료 판단은 사이클 마지막 순서만 할 수 있습니다."
        );
      }
    } else {
      lines.push(
        `- 지금은 자율 토론 ${discussion.turn}/${discussion.maxTurns}턴입니다. 앞선 답변을 검토해 새 근거가 있을 때만 짧게 기여하세요.`
      );
      lines.push("- 응답 마지막 줄에 반드시 다음 중 하나만 붙이세요: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:AGREE]], [[CODEPET_DISCUSSION:PASS]], [[CODEPET_DISCUSSION:CONCLUDE]].");
      lines.push("- 새 기여는 CONTINUE, 새 내용 없이 동의하면 AGREE, 할 말이 없으면 PASS, 충분한 최종 결론을 제시하면 CONCLUDE를 선택하세요.");
    }
  }
  if (handoff) {
    lines.push("");
    lines.push("=== 이전 메시지 전달 (Handoff) ===");
    lines.push(`전달 의도: ${handoff.intent === "REVIEW_OPINION" ? "검토 요청" : "이어서 작업"}`);
    lines.push("선택한 에이전트가 보낸 메시지:");
    lines.push(handoff.text);
    lines.push("=== 이전 메시지 전달 끝 ===");
    if (handoff.intent === "REVIEW_OPINION") {
      lines.push("- 전달받은 메시지를 검토하고 타당한 점·문제점·놓친 점을 짚으세요.");
      lines.push("- 새로운 구현을 시작하지 마세요. 검토 의견만 제시하세요.");
    } else {
      lines.push("- 전달받은 메시지를 출발점으로 후속 작업을 이어가세요.");
    }
  }
  if (simplifyMeta) {
    lines.push("");
    lines.push("=== 풀어볼 원문 메시지 ===");
    lines.push(`작성자: ${simplifyMeta.fromAgentId}`);
    lines.push(simplifyMeta.text);
    lines.push("=== 원문 메시지 끝 ===");
    lines.push("- 위 메시지를 작성 규칙에 맞게 쉬운 말로 다시 작성해 주세요.");
  }
  if (!isSimplify) {
    lines.push("");
    lines.push("=== 대화 ===");
    if (omitted > 0) lines.push(`(이전 메시지 ${omitted}개 생략)`);
    if (conversationWindow?.compacted) {
      if (pinned.length > 0) {
        lines.push("=== 대화 고정 배경 ===");
        for (const message of pinned) {
          lines.push(`[${speakerLabel(message, agentsById)}] ${String(message.text || "")}${attachmentSuffix(message)}`);
        }
        lines.push("=== 대화 고정 배경 끝 ===");
      }
      if (compressedHistory.length > 0) {
        lines.push("=== 이전 대화 압축 기록 ===");
        for (const message of compressedHistory) {
          lines.push(`- ${speakerLabel(message, agentsById)}: ${String(message.text || "")}${attachmentSuffix(message)}`);
        }
        lines.push("=== 이전 대화 압축 기록 끝 ===");
      }
      lines.push("=== 최근 대화 ===");
    }
    for (const message of recent) {
      lines.push(`[${speakerLabel(message, agentsById)}] ${String(message.text || "")}${attachmentSuffix(message)}`);
    }
    if (conversationWindow?.compacted) lines.push("=== 최근 대화 끝 ===");
    lines.push("=== 대화 끝 ===");
  }
  for (const line of extraLines) lines.push(line);
  lines.push("");
  if (isDiscussionSummary) {
    lines.push("위 지침과 고정 섹션 형식에 맞추어 토론 결론 요약을 작성하세요.");
  } else if (isSimplify) {
    lines.push("위 메시지를 비개발자가 이해하기 쉬운 말로 번역해 반환하세요.");
  } else {
    lines.push(`지금 "@${agent.id}"로서 답할 차례입니다.`);
  }
  return lines.join("\n");
}

module.exports = {
  buildAgentPrompt,
  DEFAULT_MAX_MESSAGES,
};
