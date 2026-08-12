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
  handoff = null,
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
    // budget이 0이면 slice(-0)이 문자열 전체를 돌려주므로, 잘라내야 할 상황에
    // 오히려 전부 들어갑니다. 0일 때는 요약을 아예 넣지 않습니다.
    const memory = memoryFull.length <= budget
      ? memoryFull
      : budget > 0
        ? `(누적 요약 앞부분은 생략됨)\n${memoryFull.slice(-budget)}`
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
  if (discussion) {
    lines.push(
      `- 지금은 자율 토론 ${discussion.turn}/${discussion.maxTurns}턴입니다. 앞선 답변을 검토해 새 근거가 있을 때만 짧게 기여하세요.`
    );
    lines.push("- 응답 마지막 줄에 반드시 다음 중 하나만 붙이세요: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:AGREE]], [[CODEPET_DISCUSSION:PASS]], [[CODEPET_DISCUSSION:CONCLUDE]].");
    lines.push("- 새 기여는 CONTINUE, 새 내용 없이 동의하면 AGREE, 할 말이 없으면 PASS, 충분한 최종 결론을 제시하면 CONCLUDE를 선택하세요.");
  }
  if (specialist) {
    const stageLabels = {
      planner: "기획",
      plan_review: "기획 검수",
      implementation: "구현",
      review: "검토",
      recorder: "기록",
    };
    lines.push("");
    lines.push(`=== 전문 모드: ${stageLabels[specialist.stage] || specialist.stage} ===`);
    lines.push(`현재 단계: ${stageLabels[specialist.stage] || specialist.stage} · 반복 ${specialist.round || 1}/${specialist.maxRounds || 3}`);
    if (specialist.feedback) {
      lines.push("이전 단계에서 전달된 내용:");
      lines.push(specialist.feedback);
    }
    // TASK-007: Builder/Reviewer는 실행 계약(Task Contract)을 Frozen Task로 받습니다.
    // 이 계약은 실행 시점에 동결된 불변 요구사항이며, 수정·삭제·이동할 수 없습니다.
    if (specialist.frozenTask) {
      lines.push("");
      lines.push("=== 실행 계약 (Frozen Task) ===");
      lines.push(`Run: ${specialist.frozenTask.runId || "(unknown)"}`);
      lines.push("이 계약은 현재 실행의 유일한 요구사항 기준입니다. 아래 내용이 현재 Task의 기준입니다.");
      lines.push(specialist.frozenTask.content);
      lines.push("=== 실행 계약 끝 ===");
    }
    if (specialist.stage === "planner") {
      lines.push("- 사용자의 목표와 앞선 논의를 실행 가능한 작업 계약(Task)으로 정리하세요.");
      lines.push("- 확정된 결정은 요구사항·제약으로, 미확정 제안은 참고·Open Question으로 구분하세요.");
      lines.push("- 하나의 작업이 하나의 명확한 목표와 완료 조건을 갖도록 큰 작업을 분해하세요.");
      lines.push("- 코드를 수정하거나 구현을 시작하지 마세요. 구현 담당자를 자동으로 부르지 마세요.");
      lines.push("- 응답 안에 `STATUS: PLAN_READY` 또는 `STATUS: NEEDS_DECISION` 하나를 넣으세요.");
    } else if (specialist.stage === "plan_review") {
      lines.push("- 이것은 구현 검수가 아니라 기획 검수입니다. 코드를 수정하거나 구현을 시작하지 마세요.");
      lines.push("- 기획안이 사용자 목표·제약·완료 조건을 충족하는지, Open Question이 남았는지 검토하세요.");
      lines.push("- 기획안이 충분하면 `VERDICT: PASS`를, 보완이 필요하면 `VERDICT: FIX_REQUIRED`를, 판단 근거가 부족하면 `VERDICT: UNKNOWN`을 넣으세요.");
      lines.push("- FIX_REQUIRED라면 `ISSUES:` 아래에 빠진 결정·모호한 조건·위험을 구체적으로 적으세요.");
      lines.push("- Open Question이 남아 있으면 PASS로 처리하지 말고 FIX_REQUIRED로 반환하세요.");
    } else if (specialist.stage === "implementation") {
      lines.push("- 현재 결정과 작업 범위 안에서 실제 구현을 진행하세요.");
      lines.push("- 작업을 끝낸 뒤 변경 내용과 검증 결과를 짧게 정리하세요.");
      lines.push("- 구현은 당신의 몫입니다. 다른 에이전트에게 구현·스크립트 작성·실행을 넘기거나 위임하지 마세요.");
      lines.push("- 권한이나 도구가 부족하다고 판단되면, 다른 참가자에게 맡기지 말고 현재 단계의 결과물에 그 사유와 필요한 조치를 적으세요.");
      lines.push("- Task Contract 파일(.project-memory/tasks/ 및 현재 Run의 frozen task.md)은 실행 대상이 아닙니다. 읽기 전용 계약으로 취급하며 수정·삭제·이동하지 마세요.");
      lines.push("- 계약(Task) 변경이 필요하면 직접 수정하지 말고 `STATUS: BLOCKED`로 반환하세요.");
      lines.push("- 완료하면 `STATUS: DONE`, 막혀서 진행할 수 없으면 `STATUS: BLOCKED`를 응답 안에 넣으세요.");
    } else if (specialist.stage === "review") {
      lines.push("- 구현 결과를 요구사항·현재 작업공간·대화 맥락과 대조하세요.");
      lines.push("- 검수 기준은 현재 TASK.md가 아니라 위 '실행 계약 (Frozen Task)'입니다. 이 계약과 실제 변경(Diff)·테스트 결과를 대조하세요.");
      // TASK-008: Builder가 실제로 만든 변경(Diff)을 주입합니다.
      if (specialist.reviewDiff) {
        lines.push("");
        lines.push("=== 실제 변경 (Builder Diff) ===");
        lines.push(specialist.reviewDiff);
        lines.push("=== 실제 변경 끝 ===");
      }
      lines.push("- 수정이 필요하면 구체적인 파일·문제·수정 방향을 적으세요.");
      lines.push("- 구현자가 작업을 다른 에이전트에게 넘기려 하거나 권한이 없어 실제 변경을 못 했다면, 통과시키지 말고 구현 단계로 되돌리세요.");
      lines.push("- 응답 안에 `VERDICT: PASS` 또는 `VERDICT: FIX_REQUIRED` 또는 `VERDICT: UNKNOWN` 하나를 넣으세요.");
      lines.push("- FIX_REQUIRED라면 `ISSUES:` 아래에 이슈별로 `scope: IN/OUT`, `severity: BLOCKING/NON_BLOCKING`, `location`, `problem`, `evidence`, `impact`를 적으세요.");
    } else if (specialist.stage === "recorder") {
      lines.push("- 아래 JSON 형식으로만 답하세요. 코드 블록을 써도 되고 안 써도 됩니다.");
      lines.push("- summary에는 이번 작업에서 확인된 사실, 결정, 완료 내용, 남은 작업을 Markdown으로 적으세요.");
      lines.push("- decisions에는 대화에서 실제로 합의된 내용만 넣으세요.");
      lines.push("- nextActions에는 대화에서 명시적으로 언급된 다음 할 일만 넣으세요.");
      lines.push("- 대화에 없는 계획을 지어내지 마세요. 추측이나 확인되지 않은 내용을 사실처럼 기록하지 마세요.");
      lines.push("- 프로젝트 규칙 변경이 필요하면 nextActions에 제안만 적고, 직접 규칙을 바꾸지 마세요.");
      lines.push('{"summary": "...", "decisions": [{"title": "...", "content": "..."}], "nextActions": [{"title": "...", "description": "..."}]}');
    }
    lines.push("=== 전문 모드 끝 ===");
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
