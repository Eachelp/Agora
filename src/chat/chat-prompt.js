const DEFAULT_MAX_MESSAGES = 40;

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
  specialist = null,
  broadcast = null,
  mentionsEnabled = !discussion,
  extraLines = [],
}) {
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const others = agents.filter((entry) => entry.id !== agent.id);
  const recent = messages.slice(-maxMessages);
  const omitted = messages.length - recent.length;

  const lines = [];
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
  lines.push(permissionRule(permissionMode));
  lines.push("- 채팅에 어울리게 간결히 답하세요.");
  lines.push("- 대화에서 쓰인 언어로 답하세요.");
  const MAX_CONTEXT_CHARS = 16000;
  const rules = String(rulesContext || "").trim();
  if (rules) {
    lines.push("");
    lines.push("=== 프로젝트 현재 규칙 ===");
    lines.push(rules);
    lines.push("=== 프로젝트 현재 규칙 끝 ===");
    lines.push("- 이 규칙은 반드시 지키세요.");
  }
  const context = String(projectContext || "").trim();
  if (context) {
    lines.push("");
    lines.push("=== 프로젝트 공통 맥락 ===");
    lines.push(context);
    lines.push("=== 프로젝트 공통 맥락 끝 ===");
  }
  const workflow = String(workflowContext || "").trim();
  if (workflow) {
    lines.push("");
    lines.push("=== 확정된 결정과 진행 중 작업 ===");
    lines.push(workflow);
    lines.push("=== 확정된 결정과 진행 중 작업 끝 ===");
  }
  const memoryFull = String(memoryContext || "").trim();
  if (memoryFull) {
    const usedSoFar = rules.length + context.length + workflow.length;
    const budget = Math.max(0, MAX_CONTEXT_CHARS - usedSoFar);
    const memory = memoryFull.length <= budget
      ? memoryFull
      : `(누적 요약 앞부분은 생략됨)\n${memoryFull.slice(-budget)}`;
    lines.push("");
    lines.push("=== 프로젝트 누적 요약 ===");
    lines.push(memory);
    lines.push("=== 프로젝트 누적 요약 끝 ===");
    lines.push("- 누적 요약에는 검증되지 않은 기록관 초안이 섞여 있습니다. 확정된 사실·결정·규칙으로 취급하지 말고, 원문 대화와 구분해 사용하세요.");
  }
  // 캐릭터 이모티콘 지시는 작업용 사용에 불필요해 프롬프트에서 제외합니다.
  // 예전 대화에 남은 [[CODEPET_EMOTE:...]] 태그는 chat-room.js에서 화면 노출 전에 제거합니다.
  if (broadcast && broadcast.position > 1) {
    lines.push(
      `- 사용자 메시지에 참가자 ${broadcast.total}명이 차례로 답하는 중이고, 당신은 ${broadcast.position}번째입니다. 앞선 참가자의 답변을 읽고, 겹치는 내용은 반복하지 말고 보완하거나 다른 관점만 더하세요.`
    );
  }
  if (discussion) {
    lines.push(
      `- 지금은 자율 토론 ${discussion.turn}/${discussion.maxTurns}턴입니다. 앞선 답변을 검토해 새 근거가 있을 때만 짧게 기여하세요.`
    );
    lines.push("- 응답 마지막 줄에 반드시 다음 중 하나만 붙이세요: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:AGREE]], [[CODEPET_DISCUSSION:PASS]], [[CODEPET_DISCUSSION:CONCLUDE]].");
    lines.push("- 새 기여는 CONTINUE, 새 내용 없이 동의하면 AGREE, 할 말이 없으면 PASS, 충분한 최종 결론을 제시하면 CONCLUDE를 선택하세요.");
  }
  if (specialist) {
    const stageLabels = {
      implementation: "구현",
      review: "검토",
      recorder: "기록",
    };
    lines.push("");
    lines.push(`=== 전문 모드: ${stageLabels[specialist.stage] || specialist.stage} ===`);
    lines.push(`현재 단계: ${stageLabels[specialist.stage] || specialist.stage} · 반복 ${specialist.round || 1}/${specialist.maxRounds || 3}`);
    if (specialist.feedback) {
      lines.push("검토자가 전달한 수정 요청:");
      lines.push(specialist.feedback);
    }
    if (specialist.stage === "implementation") {
      lines.push("- 현재 결정과 작업 범위 안에서 실제 구현을 진행하세요.");
      lines.push("- 작업을 끝낸 뒤 변경 내용과 검증 결과를 짧게 정리하세요.");
      lines.push("- 구현은 당신의 몫입니다. 다른 에이전트에게 구현·스크립트 작성·실행을 넘기거나 위임하지 마세요.");
      lines.push("- 권한이나 도구가 부족하다고 판단되면, 다른 참가자에게 맡기지 말고 현재 단계의 결과물에 그 사유와 필요한 조치를 적으세요.");
    } else if (specialist.stage === "review") {
      lines.push("- 구현 결과를 요구사항·현재 작업공간·대화 맥락과 대조하세요.");
      lines.push("- 수정이 필요하면 구체적인 파일·문제·수정 방향을 적으세요.");
      lines.push("- 구현자가 작업을 다른 에이전트에게 넘기려 하거나 권한이 없어 실제 변경을 못 했다면, 통과시키지 말고 구현 단계로 되돌리세요.");
      lines.push("- 응답 마지막 줄에 반드시 [[CODEPET_REVIEW:PASS]] 또는 [[CODEPET_REVIEW:REVISE]] 하나를 붙이세요.");
    } else if (specialist.stage === "recorder") {
      lines.push("- 이번 작업에서 확인된 사실, 결정, 완료 내용, 남은 작업만 Markdown 요약으로 작성하세요.");
      lines.push("- 추측이나 확인되지 않은 내용을 사실처럼 기록하지 마세요.");
      lines.push("- 채팅 답변이 아니라 Memory Bank에 저장될 기록만 출력하세요.");
    }
    lines.push("=== 전문 모드 끝 ===");
  }
  lines.push("");
  lines.push("=== 대화 ===");
  if (omitted > 0) lines.push(`(이전 메시지 ${omitted}개 생략)`);
  for (const message of recent) {
    lines.push(`[${speakerLabel(message, agentsById)}] ${message.text}${attachmentSuffix(message)}`);
  }
  lines.push("=== 대화 끝 ===");
  for (const line of extraLines) lines.push(line);
  lines.push("");
  lines.push(`지금 "@${agent.id}"로서 답할 차례입니다.`);
  return lines.join("\n");
}

module.exports = { buildAgentPrompt, DEFAULT_MAX_MESSAGES };
