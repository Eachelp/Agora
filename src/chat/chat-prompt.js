const DEFAULT_MAX_MESSAGES = 40;
const MAX_SPECIALIST_PROMPT_CHARS = 24 * 1024;
const MAX_MESSAGE_CHARS = 4 * 1024;
const MAX_REVIEW_DIFF_CHARS = 12 * 1024;
const MAX_REVIEW_EVIDENCE_CHARS = 4 * 1024;

function boundedText(value, limit, label) {
  const text = String(value || "");
  if (text.length <= limit) return { text, truncated: false, omitted: 0 };
  const notice = `\n[${label} 일부 생략: 원본 ${text.length}자, 포함 ${Math.max(0, limit - 80)}자]\n`;
  const budget = Math.max(0, limit - notice.length);
  const head = Math.ceil(budget * 0.25);
  const tail = budget - head;
  return {
    text: `${text.slice(0, head)}${notice}${text.slice(-tail)}`,
    truncated: true,
    omitted: text.length - budget,
  };
}

function promptBudgetError(message) {
  const error = new Error(message);
  error.code = "PROMPT_BUDGET_EXCEEDED";
  return error;
}

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
  discussionSummary = null,
  simplifyMeta = null,
  extraLines = [],
}) {
  const isBuilder = specialist?.stage === "implementation";
  const isCleanReviewer = specialist?.stage === "review";
  const isPlanReviewer = specialist?.stage === "plan_review";
  const isProfessionalRecorder = specialist?.stage === "recorder" && specialist?.professional === true;
  const isSpecialist = Boolean(specialist);
  const isDiscussionSummary = Boolean(discussionSummary);
  const isSimplify = Boolean(simplifyMeta);
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const others = agents.filter((entry) => entry.id !== agent.id);
  const sourceMessages = isPlanReviewer
    ? messages.filter((message) => message?.authorType === "user")
    : messages;
  const recent = isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify
    ? []
    : isDiscussionSummary
      ? sourceMessages
      : sourceMessages.slice(-maxMessages);
  const omitted = isDiscussionSummary || isSimplify ? 0 : sourceMessages.length - recent.length;

  const lines = [];
  if (isBuilder) {
    lines.push("당신은 Agora 전문 실행의 Builder입니다. 이 호출에서 실제 구현을 수행하세요.");
    lines.push("아래 실행 계약과 현재 단계 지침만 따르세요. 다른 에이전트에게 구현을 위임하거나 호출하지 마세요.");
  } else if (isCleanReviewer) {
    lines.push("당신은 Agora 전문 실행의 clean-room 구현 Reviewer입니다.");
    lines.push("대화 transcript, 참가자 목록, Builder의 자기보고는 보지 않습니다. Project Rules, Frozen Task, checkpoint 이후 변경, 구조화된 실행 상태와 evidence만 근거로 판정하세요.");
  } else if (isPlanReviewer) {
    lines.push("당신은 Agora 전문 실행의 Plan Reviewer입니다.");
    lines.push("사용자 요청·확정된 결정·현재 TASK와 이전 구조화 이슈만 근거로 기획을 검수하세요. 다른 에이전트의 자유 대화나 설명은 근거로 사용하지 마세요.");
  } else if (isProfessionalRecorder) {
    lines.push("당신은 Agora 전문 실행의 Recorder입니다.");
    lines.push("대화 transcript나 다른 에이전트의 자유 설명은 보지 않습니다. Frozen Task, 최종 변경 요약, 검수 판정과 실행 근거만 기록하세요.");
  } else if (isDiscussionSummary) {
    lines.push(`당신은 Agora의 토론 결론 종합자 "@${agent.id}"(${agent.name})입니다.`);
    lines.push("앞서 진행된 논의(사용자 질문, 사전 발언, 토론 전체)를 객관적으로 분석해 핵심 결론을 명확하고 구조화된 요약 카드로 정리하세요.");
    lines.push("");
    lines.push("작성 규칙:");
    lines.push("- 새로운 파일 수정이나 도구 명령을 제안하지 말고, 오직 제시된 대화 내용에만 근거해 정리하세요.");
    lines.push("- 다른 참가자를 @멘션으로 호출하지 마세요.");
    lines.push("- 대화에서 쓰인 언어로 답하세요.");
    lines.push("- 아래의 고정 섹션 구조를 정확히 지켜 Markdown으로 작성하세요:");
    lines.push("  ## 논의 주제");
    lines.push("  ## 공통 합의점");
    lines.push("  ## 주요 쟁점과 입장");
    lines.push("  ## 권장 결론");
    lines.push("  ## 사용자 결정 사항 / 다음 행동");
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
  }
  lines.push(permissionRule(permissionMode));
  if (!isBuilder) {
    lines.push("- 채팅에 어울리게 간결히 답하세요.");
    lines.push("- 대화에서 쓰인 언어로 답하세요.");
  }
  const MAX_CONTEXT_CHARS = 16000;
  const rules = String(rulesContext || "").trim();
  if (rules) {
    lines.push("");
    lines.push("=== 프로젝트 현재 규칙 ===");
    lines.push(rules);
    lines.push("=== 프로젝트 현재 규칙 끝 ===");
    lines.push("- 이 규칙은 반드시 지키세요.");
  }
  const context = isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify ? "" : String(projectContext || "").trim();
  if (context) {
    lines.push("");
    lines.push("=== 프로젝트 공통 맥락 ===");
    lines.push(context);
    lines.push("=== 프로젝트 공통 맥락 끝 ===");
  }
  const workflow = isBuilder || isCleanReviewer || isProfessionalRecorder || isSimplify ? "" : String(workflowContext || "").trim();
  if (workflow) {
    lines.push("");
    lines.push("=== 확정된 결정과 진행 중 작업 ===");
    lines.push(workflow);
    lines.push("=== 확정된 결정과 진행 중 작업 끝 ===");
  }
  const memoryFull = isBuilder || isCleanReviewer || isPlanReviewer || isProfessionalRecorder || isSimplify ? "" : String(memoryContext || "").trim();
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
  if (!isBuilder && broadcast && broadcast.position > 1) {
    lines.push(
      `- 사용자 메시지에 참가자 ${broadcast.total}명이 차례로 답하는 중이고, 당신은 ${broadcast.position}번째입니다. 앞선 참가자의 답변을 읽고, 겹치는 내용은 반복하지 말고 보완하거나 다른 관점만 더하세요.`
    );
  }
  if (!isBuilder && discussion) {
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
      if (specialist.stage === "plan_review") {
        lines.push("=== 현재 TASK ===");
        // 현재 TASK는 기획 검수의 계약 본문이다. 부분만 보여 주고 PASS시키지
        // 않도록 자르지 않으며, 전체 prompt 예산을 넘으면 호출 자체를 막는다.
        lines.push(String(specialist.feedback || ""));
        lines.push("=== 현재 TASK 끝 ===");
      } else {
        lines.push("이전 단계에서 전달된 내용:");
        lines.push(boundedText(specialist.feedback, MAX_REVIEW_EVIDENCE_CHARS, "이전 피드백").text);
      }
    }
    if (specialist.stage === "plan_review" && specialist.previousIssues) {
      lines.push("");
      lines.push("=== 이전 구조화 이슈 ===");
      lines.push(boundedText(specialist.previousIssues, MAX_REVIEW_EVIDENCE_CHARS, "이전 이슈").text);
      lines.push("=== 이전 구조화 이슈 끝 ===");
    }
    // TASK-007: Builder/Reviewer는 실행 계약(Task Contract)을 Frozen Task로 받습니다.
    // 이 계약은 실행 시점에 동결된 불변 요구사항이며, 수정·삭제·이동할 수 없습니다.
    if (specialist.frozenTask) {
      lines.push("");
      lines.push("=== 실행 계약 (Frozen Task) ===");
      lines.push(`Run: ${specialist.frozenTask.runId || "(unknown)"}`);
      lines.push("이 계약은 현재 실행의 유일한 요구사항 기준입니다. 아래 내용이 현재 Task의 기준입니다.");
      lines.push(String(specialist.frozenTask.content || ""));
      lines.push("=== 실행 계약 끝 ===");
    }
    if (specialist.stage === "planner") {
      lines.push("- 사용자의 목표와 앞선 논의를 실행 가능한 작업 계약(Task)으로 정리하세요.");
      lines.push("- 확정된 결정은 요구사항·제약으로, 미확정 제안은 참고·Open Question으로 구분하세요.");
      lines.push("- 워크스페이스 작업이면 PLAN_READY 전에 요청과 직접 관련된 파일·호출 경로·테스트를 필요한 범위에서 읽어 현재 상태와 근거를 확인하세요. 작은 작업을 위해 저장소 전체를 훑지는 마세요.");
      lines.push("- 확인하지 못한 사실은 단정하지 말고 `Risks / Open Questions`에 남기세요.");
      lines.push("- 하나의 작업이 하나의 명확한 목표와 완료 조건을 갖도록 큰 작업을 분해하세요.");
      lines.push("- TASK에는 가능하면 `Goal`, `Current State / Evidence`, `Requirements`, `Affected Modules`, `Invariants / Must Preserve`, `Implementation Approach`, `Acceptance Criteria`, `Verification`, `Risks / Open Questions`, `Out of Scope`를 포함하세요.");
      lines.push("- 코드를 수정하거나 구현을 시작하지 마세요. 구현 담당자를 자동으로 부르지 마세요.");
      lines.push("- BLOCKING 지적을 해결하지 못하거나 수용하지 않을 때는 TASK를 고친 것처럼 다시 쓰지 마세요. `STATUS: NEEDS_DECISION`과 그 이유·사용자에게 필요한 질문을 반환하고, 기존 TASK.md를 덮어쓰지 마세요.");
      lines.push("- 응답 안에 `STATUS: PLAN_READY` 또는 `STATUS: NEEDS_DECISION` 하나를 넣으세요.");
    } else if (specialist.stage === "plan_review") {
      lines.push("- 이것은 구현 검수가 아니라 기획 검수입니다. 코드를 수정하거나 구현을 시작하지 마세요.");
      lines.push("- 기획안이 사용자 목표·제약·완료 조건을 충족하는지, Open Question이 남았는지 검토하세요.");
      lines.push("- TASK의 현재 상태·파일·테스트에 관한 주장은 필요할 때 워크스페이스를 읽어 확인하세요. 기획자 설명이나 자기보고만으로 사실을 확정하지 마세요.");
      lines.push("- 기획안이 충분하면 `VERDICT: PASS`를, 보완이 필요하면 `VERDICT: FIX_REQUIRED`를, 판단 근거가 부족하면 `VERDICT: UNKNOWN`을 넣으세요.");
      lines.push("- FIX_REQUIRED라면 `ISSUES:` 아래에 이슈별로 `scope: IN/OUT`, `severity: BLOCKING/NON_BLOCKING`, `problem`, `evidence`, `impact`를 적으세요.");
      lines.push("- 각 이슈에 `repeat: YES|NO`를 표시하세요. 이전 라운드에서 지적한 BLOCKING 이슈가 아직 해소되지 않았다면 반드시 `repeat: YES`로 기록하세요.");
      lines.push("- 기존 대화와 사용자 결정만으로 기획자가 고칠 수 있는 문제만 `scope: IN`으로 표시하세요.");
      lines.push("- 사용자 결정이 필요한 문제는 `## Open Questions`에 질문으로 적으세요. 이 질문은 자동 보완하지 않고 사용자에게 반환됩니다.");
      lines.push("- Open Question이 남아 있으면 PASS로 처리하지 말고 FIX_REQUIRED로 반환하세요.");
    } else if (specialist.stage === "implementation") {
      lines.push("- 현재 결정과 작업 범위 안에서 실제 구현을 진행하세요.");
      lines.push("- 작업을 끝낸 뒤 변경 내용과 검증 결과를 짧게 정리하세요.");
      lines.push("- 구현은 당신의 몫입니다. 다른 에이전트에게 구현·스크립트 작성·실행을 넘기거나 위임하지 마세요.");
      lines.push("- 권한이나 도구가 부족하다고 판단되면, 다른 참가자에게 맡기지 말고 현재 단계의 결과물에 그 사유와 필요한 조치를 적으세요.");
      lines.push("- Task Contract 파일(.project-memory/tasks/ 및 현재 Run의 frozen task.md)은 실행 대상이 아닙니다. 읽기 전용 계약으로 취급하며 수정·삭제·이동하지 마세요.");
      lines.push("- 계약(Task)이 현재 작업공간의 사실이나 안전한 구현 조건과 충돌하면 범위를 조용히 재해석하지 마세요. 계약 변경이 필요하면 직접 수정하지 말고 `STATUS: BLOCKED`와 이유를 반환하세요.");
      lines.push("- 완료하면 `STATUS: DONE`, 막혀서 진행할 수 없으면 `STATUS: BLOCKED`를 응답 안에 넣으세요.");
    } else if (specialist.stage === "review") {
      lines.push("- 대화 transcript와 Builder의 자기보고는 검수 근거로 제공되지 않습니다. 아래 구조화된 사실과 현재 작업공간만 사용하세요.");
      lines.push("- 먼저 회귀·안전성을 검토하고, 두 번째로 계약 충족 여부를 검토하세요.");
      lines.push("- 검수 기준은 현재 TASK.md가 아니라 위 '실행 계약 (Frozen Task)'입니다. 이 계약과 실제 변경(Diff)·테스트 결과를 대조하세요.");
      if (specialist.axes) {
        lines.push("");
        lines.push("=== 실행 상태 축 ===");
        for (const key of ["transport", "declaration", "changes", "execution"]) {
          lines.push(`${key}: ${specialist.axes[key] || "UNAVAILABLE"}`);
        }
        lines.push("=== 실행 상태 축 끝 ===");
      }
      // TASK-008: Builder가 실제로 만든 변경(Diff)을 주입합니다.
      if (Object.prototype.hasOwnProperty.call(specialist, "reviewDiff")) {
        lines.push("");
        lines.push("=== 실제 변경 (Builder Diff) · checkpoint 이후 Git-visible ===");
        lines.push(boundedText(specialist.reviewDiff, MAX_REVIEW_DIFF_CHARS, "Diff").text);
        lines.push("=== 실제 변경 끝 ===");
      }
      if (specialist.evidence) {
        lines.push("");
        lines.push("=== 실행 근거 (Evidence) ===");
        const evidence = boundedText(
          typeof specialist.evidence === "string" ? specialist.evidence : JSON.stringify(specialist.evidence),
          MAX_REVIEW_EVIDENCE_CHARS,
          "Evidence"
        );
        lines.push(evidence.text);
        lines.push("=== 실행 근거 끝 ===");
      }
      lines.push("- 수정이 필요하면 구체적인 파일·문제·수정 방향을 적으세요.");
      lines.push("- 구현자가 작업을 다른 에이전트에게 넘기려 하거나 권한이 없어 실제 변경을 못 했다면, 통과시키지 말고 구현 단계로 되돌리세요.");
      lines.push("- 응답 안에 `VERDICT: PASS` 또는 `VERDICT: FIX_REQUIRED` 또는 `VERDICT: UNKNOWN` 하나를 넣으세요.");
      lines.push("- FIX_REQUIRED라면 `ISSUES:` 아래에 이슈별로 `scope: IN/OUT`, `severity: BLOCKING/NON_BLOCKING`, `location`, `problem`, `evidence`, `impact`를 적으세요.");
    } else if (specialist.stage === "recorder") {
      if (isProfessionalRecorder && specialist.finalVerdict) {
        lines.push(`최종 검수 판정: ${specialist.finalVerdict}`);
      }
      if (isProfessionalRecorder && Object.prototype.hasOwnProperty.call(specialist, "reviewDiff")) {
        lines.push("=== 최종 변경 요약 ===");
        lines.push(boundedText(specialist.reviewDiff, MAX_REVIEW_DIFF_CHARS, "최종 변경").text);
        lines.push("=== 최종 변경 요약 끝 ===");
      }
      if (isProfessionalRecorder && specialist.evidence) {
        lines.push("=== 실행 근거 요약 ===");
        lines.push(boundedText(JSON.stringify(specialist.evidence), MAX_REVIEW_EVIDENCE_CHARS, "Evidence").text);
        lines.push("=== 실행 근거 요약 끝 ===");
      }
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
  if (handoff && !isBuilder) {
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
  if (simplifyMeta && !isBuilder) {
    lines.push("");
    lines.push("=== 풀어볼 원문 메시지 ===");
    lines.push(`작성자: ${simplifyMeta.fromAgentId}`);
    lines.push(simplifyMeta.text);
    lines.push("=== 원문 메시지 끝 ===");
    lines.push("- 위 메시지를 작성 규칙에 맞게 쉬운 말로 다시 작성해 주세요.");
  }
  if (!isBuilder && !isCleanReviewer && !isProfessionalRecorder && !isSimplify) {
    lines.push("");
    lines.push("=== 대화 ===");
    if (omitted > 0) lines.push(`(이전 메시지 ${omitted}개 생략)`);
    for (const message of recent) {
      // Professional payload만 개별 메시지 예산을 적용한다. 일반 채팅·토론은
      // 기존과 동일하게 원문 transcript를 provider에 전달한다.
      const bounded = isSpecialist
        ? boundedText(message.text, MAX_MESSAGE_CHARS, "메시지")
        : { text: String(message.text || "") };
      lines.push(`[${speakerLabel(message, agentsById)}] ${bounded.text}${attachmentSuffix(message)}`);
    }
    lines.push("=== 대화 끝 ===");
  }
  for (const line of extraLines) lines.push(line);
  lines.push("");
  if (isBuilder) {
    lines.push("현재 단계의 구현 결과와 선언을 반환하세요.");
  } else if (isDiscussionSummary) {
    lines.push("위 지침과 고정 섹션 형식에 맞추어 토론 결론 요약을 작성하세요.");
  } else if (isSimplify) {
    lines.push("위 메시지를 비개발자가 이해하기 쉬운 말로 번역해 반환하세요.");
  } else {
    lines.push(`지금 "@${agent.id}"로서 답할 차례입니다.`);
  }
  const prompt = lines.join("\n");
  if (isSpecialist && prompt.length > MAX_SPECIALIST_PROMPT_CHARS) {
    throw promptBudgetError(
      `전문 실행 프롬프트 예산을 초과했습니다 (${prompt.length}/${MAX_SPECIALIST_PROMPT_CHARS}자).`
    );
  }
  return prompt;
}

module.exports = {
  buildAgentPrompt,
  DEFAULT_MAX_MESSAGES,
  MAX_SPECIALIST_PROMPT_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_REVIEW_DIFF_CHARS,
  MAX_REVIEW_EVIDENCE_CHARS,
};
