// '답변 대기' 바 렌더링. chat.js가 컨테이너·에이전트 목록·콜백을 넘기고, 이 파일은
// 그 안에 무엇을 그릴지만 안다. DOM을 인자로 받으므로 Node에서 최소 DOM 흉내로
// 단위 테스트할 수 있다(usage-view.js와 같은 로딩 방식).
(function attachAwaitingView(global) {
  // 되질문으로 턴을 끝낸 에이전트를 composer 위에 모아 보여준다. 알약을 누르면
  // 그 에이전트에게 답하도록 @id를 채우고, 보기가 있으면 칩으로 띄운다. 칩을
  // 누르면 "@id <보기>"까지 채워 준다(자동 전송 X — 사용자가 확인). ×는 답하지
  // 않고 그 대기만 지운다 — 방향 제안처럼 답할 필요 없는 질문을 치우는 길이다.
  function renderAwaitingRow({ container, agents, document, makeAgentAvatar, onAnswer, onDismiss }) {
    if (!container) return;
    container.textContent = "";
    const waiting = (agents || []).filter((agent) => agent.awaitingUser);
    container.hidden = waiting.length === 0;
    if (waiting.length === 0) return;
    const label = document.createElement("span");
    label.className = "awaiting-label";
    label.textContent = waiting.length > 1 ? `답변 대기 ${waiting.length}` : "답변 대기";
    container.append(label);
    for (const agent of waiting) {
      const group = document.createElement("div");
      group.className = "awaiting-group";

      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "awaiting-pill";
      pill.style.setProperty("--agent-color", agent.color);
      pill.append(makeAgentAvatar(agent, "agent-avatar"));
      const text = document.createElement("span");
      text.className = "awaiting-pill-text";
      text.textContent = agent.awaitingQuestion
        ? `@${agent.id} · ${agent.awaitingQuestion}`
        : `@${agent.id}`;
      pill.append(text);
      pill.title = agent.awaitingQuestion
        ? `${agent.name}에게 답하기 — ${agent.awaitingQuestion}`
        : `${agent.name}에게 답하기`;
      pill.addEventListener("click", () => onAnswer(agent.id));
      const head = document.createElement("div");
      head.className = "awaiting-head";
      head.append(pill);
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "awaiting-dismiss";
      dismiss.textContent = "×";
      dismiss.title = `@${agent.id} 답변 대기 지우기`;
      dismiss.setAttribute("aria-label", `@${agent.id} 답변 대기 지우기`);
      dismiss.addEventListener("click", () => {
        if (typeof onDismiss === "function") onDismiss(agent.id);
      });
      head.append(dismiss);
      group.append(head);

      const options = Array.isArray(agent.awaitingOptions) ? agent.awaitingOptions : [];
      if (options.length > 0) {
        const optionRow = document.createElement("div");
        optionRow.className = "awaiting-options";
        for (const option of options) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "awaiting-option";
          chip.textContent = option;
          chip.title = `@${agent.id} ${option} (으)로 답하기`;
          chip.addEventListener("click", () => onAnswer(agent.id, option));
          optionRow.append(chip);
        }
        group.append(optionRow);
      }
      container.append(group);
    }
  }

  const api = { renderAwaitingRow };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.awaitingView = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
