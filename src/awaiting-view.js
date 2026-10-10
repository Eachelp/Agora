// '답변 대기' 바 렌더링. chat.js가 컨테이너·에이전트 목록·콜백을 넘기고, 이 파일은
// 그 안에 무엇을 그릴지만 안다. DOM을 인자로 받으므로 Node에서 최소 DOM 흉내로
// 단위 테스트할 수 있다(usage-view.js와 같은 로딩 방식).
(function attachAwaitingView(global) {
  // 여러 개 고르기(MULTI) 질문의 선택 상태. 다른 에이전트 이벤트로 바가 다시 그려져도
  // 고르던 칩이 풀리지 않도록 질문 단위로 모듈에 둔다(대기가 끝난 질문은 그릴 때 버린다).
  const multiSelections = new Map();

  // 되질문으로 턴을 끝낸 에이전트를 composer 위에 모아 보여준다. 알약을 누르면
  // 그 에이전트에게 답하도록 @id를 채우고, 보기가 있으면 칩으로 띄운다. 칩을
  // 누르면 "@id <보기>"까지 채워 준다(자동 전송 X — 사용자가 확인). 여러 개 고르는
  // 질문이면 칩이 켜고 끄는 토글이 되고 '선택 넣기'가 "@id A, B"를 채운다. ×는 답하지
  // 않고 그 대기만 지운다 — 방향 제안처럼 답할 필요 없는 질문을 치우는 길이다.
  function renderAwaitingRow({ container, agents, document, makeAgentAvatar, onAnswer, onDismiss }) {
    if (!container) return;
    container.textContent = "";
    const waiting = (agents || []).filter((agent) => agent.awaitingUser);
    container.hidden = waiting.length === 0;
    const liveKeys = new Set(waiting.map(selectionKey));
    for (const key of [...multiSelections.keys()]) if (!liveKeys.has(key)) multiSelections.delete(key);
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
        ? `${agent.name}에게 답하기 — ${agent.awaitingQuestion} (직접 쓰려면 입력창에 답을 적으세요)`
        : `${agent.name}에게 답하기 (직접 쓰려면 입력창에 답을 적으세요)`;
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
        const multi = Boolean(agent.awaitingMulti);
        const selected = multi ? selectionFor(agent) : null;
        let fill = null;
        const repaints = [];
        const syncFill = () => {
          if (fill) fill.disabled = selected.size === 0;
        };
        for (const option of options) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "awaiting-option";
          chip.textContent = option;
          if (multi) {
            const paint = () => {
              const on = selected.has(option);
              chip.className = on ? "awaiting-option is-checked" : "awaiting-option";
              chip.setAttribute("aria-pressed", on ? "true" : "false");
            };
            paint();
            repaints.push(paint);
            chip.title = `${option} 고르기/빼기`;
            chip.addEventListener("click", () => {
              if (selected.has(option)) selected.delete(option);
              else selected.add(option);
              paint();
              syncFill();
            });
          } else {
            chip.title = `@${agent.id} ${option} (으)로 답하기`;
            chip.addEventListener("click", () => onAnswer(agent.id, option));
          }
          optionRow.append(chip);
        }
        if (multi) {
          fill = document.createElement("button");
          fill.type = "button";
          fill.className = "awaiting-fill";
          fill.textContent = "선택 넣기";
          fill.title = "고른 보기를 입력창에 넣어요. 확인한 뒤 직접 보내세요.";
          fill.addEventListener("click", () => {
            const picked = options.filter((option) => selected.has(option));
            if (picked.length === 0) return;
            selected.clear();
            repaints.forEach((paint) => paint());
            syncFill();
            onAnswer(agent.id, picked.join(", "));
          });
          syncFill();
          optionRow.append(fill);
        }
        group.append(optionRow);
      }
      container.append(group);
    }
  }

  function selectionKey(agent) {
    return JSON.stringify([agent.id, agent.awaitingQuestion || "", agent.awaitingOptions || []]);
  }

  function selectionFor(agent) {
    const key = selectionKey(agent);
    if (!multiSelections.has(key)) multiSelections.set(key, new Set());
    return multiSelections.get(key);
  }

  const api = { renderAwaitingRow };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.awaitingView = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
