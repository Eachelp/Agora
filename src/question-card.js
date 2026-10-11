// 실행 중 질문(ask_user) 카드. 에이전트가 일하다 사용자 결정이 필요해 던진 질문을 입력창 위에
// 카드로 띄우고, 답(보내기)이나 건너뛰기를 chat.js가 넘긴 콜백으로 돌려준다. DOM을 인자로 받으므로
// Node에서 최소 DOM 흉내로 시험할 수 있다(awaiting-view.js와 같은 로딩 방식).
//
// 카드는 방(sessionId)마다 따로 본다: 지금 보는 방의 'pending' 질문만 그리고, 처리된(보냄·건너뜀·
// 중단·끝남) 질문은 어떤 경로로든 카드에서 사라진다. 처리된 질문의 한 줄 기록은 방이 대화에 남긴다.
(function attachQuestionCard(global) {
  const MAX_TEXT = 8000; // user-question-broker.js의 MAX_ANSWER_CHARS와 같다.

  // focusComposer: 카드가 사라진 뒤 키보드 초점을 입력창으로 돌려주는 함수(없으면 아무것도 하지 않는다).
  function createQuestionCards({ container, document, makeAgentAvatar, agentById, getSessionId, answer, skip, onChange, focusComposer }) {
    const records = new Map(); // questionId → 질문 기록(지금 보는 방 것만)
    const views = new Map(); // questionId → 그려 둔 카드 { el }
    // 쓰던 답. 방을 옮겼다 돌아와도, 다른 이벤트로 다시 그려져도 고르던 것이 풀리지 않게 질문 단위로 둔다.
    const drafts = new Map(); // questionId → { sessionId, picks: Set[], other: string[], busy, error }
    let lastPending = "";

    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const isPending = (record) => record.status === "pending";
    const pendingList = () =>
      [...records.values()]
        .filter((record) => isPending(record) && record.sessionId === getSessionId())
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    function draftFor(record) {
      if (!drafts.has(record.questionId)) {
        drafts.set(record.questionId, {
          sessionId: record.sessionId,
          picks: record.questions.map(() => new Set()),
          other: record.questions.map(() => ""),
          busy: false,
          error: "",
        });
      }
      return drafts.get(record.questionId);
    }

    // 아직 답하지 않은 질문의 번호(1부터). 보기가 있으면 하나 이상 골랐거나 기타를 써야 하고, 직접 입력 질문이면 글이 있어야 한다.
    function unanswered(record, draft) {
      const missing = [];
      record.questions.forEach((question, index) => {
        const typed = draft.other[index].trim().length > 0;
        const answered = question.options.length > 0 ? draft.picks[index].size + (typed ? 1 : 0) >= 1 : typed;
        if (!answered) missing.push(index + 1);
      });
      return missing;
    }
    const isComplete = (record, draft) => unanswered(record, draft).length === 0;

    // 단일 선택은 기타를 쓰면 고른 보기를 대신하므로 selected를 비운다. 복수 선택은 보기에 기타를 더한다.
    function buildAnswers(record, draft) {
      return record.questions.map((question, index) => {
        const typed = draft.other[index].trim();
        if (question.options.length === 0) return { text: typed };
        const selected = typed && !question.multiSelect ? [] : question.options.filter((option) => draft.picks[index].has(option));
        return { selected, ...(typed ? { other: typed } : {}) };
      });
    }

    function buildCard(record) {
      const draft = draftFor(record);
      const agent = agentById ? agentById(record.agentId) : null;
      const name = agent?.name || record.agentId || "에이전트";
      const el = make("section", "question-card");
      el.dataset.questionId = record.questionId;
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", `${name}의 질문`);
      if (agent?.color) el.style.setProperty("--agent-color", agent.color);

      const head = make("div", "question-head");
      if (agent && makeAgentAvatar) head.append(makeAgentAvatar(agent, "agent-avatar"));
      head.append(make("span", "question-who", name));
      head.append(make("span", "question-hint", "답을 보내면 하던 일을 이어서 합니다"));
      el.append(head);

      record.questions.forEach((question, index) => {
        const item = make("fieldset", "question-item");
        item.append(make("legend", "question-text", record.questions.length > 1 ? `${index + 1}. ${question.question}` : question.question));
        const choices = []; // { option, input }
        const groupName = `question-${record.questionId}-${index}`;
        for (const option of question.options) {
          const label = make("label", "question-option");
          const input = make("input");
          input.type = question.multiSelect ? "checkbox" : "radio";
          input.name = groupName;
          input.value = option;
          input.checked = draft.picks[index].has(option);
          input.addEventListener("change", () => {
            if (question.multiSelect) {
              if (input.checked) draft.picks[index].add(option);
              else draft.picks[index].delete(option);
            } else {
              draft.picks[index] = new Set(input.checked ? [option] : []);
              // 단일 선택은 보기를 고르면 쓰던 기타를 비운다(둘 중 하나만 답이다).
              draft.other[index] = "";
              other.value = "";
            }
            sync();
          });
          choices.push({ option, input });
          label.append(input, make("span", "question-option-text", option));
          item.append(label);
        }
        const other = make("input", "question-other");
        other.type = "text";
        other.maxLength = MAX_TEXT;
        other.placeholder = question.options.length > 0 ? "기타 — 직접 입력" : "직접 입력";
        other.setAttribute("aria-label", `${question.options.length > 0 ? "기타 직접 입력" : "직접 입력"} (${index + 1}번 질문)`);
        other.value = draft.other[index];
        other.addEventListener("input", () => {
          draft.other[index] = other.value;
          if (question.options.length > 0 && !question.multiSelect && other.value.trim()) {
            // 단일 선택에서 기타를 쓰기 시작하면 고른 보기를 푼다.
            draft.picks[index] = new Set();
            for (const choice of choices) choice.input.checked = false;
          }
          sync();
        });
        other.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing && isComplete(record, draft) && !draft.busy) {
            event.preventDefault?.();
            submit();
          }
        });
        item.append(other);
        el.append(item);
      });

      const actions = make("div", "question-actions");
      const error = make("span", "question-error");
      error.setAttribute("role", "alert");
      // 보내기가 잠겨 있는 이유(아직 답하지 않은 질문)를 버튼 옆에 적는다.
      const missingHint = make("span", "question-missing");
      missingHint.id = `question-missing-${record.questionId}`;
      const skipButton = make("button", "question-skip", "건너뛰기");
      skipButton.type = "button";
      skipButton.title = "답하지 않고 넘어갑니다. 에이전트가 알아서 판단해 이어 갑니다.";
      const sendButton = make("button", "question-send", "보내기");
      sendButton.type = "button";
      sendButton.setAttribute("aria-describedby", missingHint.id);
      actions.append(error, missingHint, skipButton, sendButton);
      el.append(actions);

      function sync() {
        error.textContent = draft.error;
        error.hidden = !draft.error;
        sendButton.textContent = draft.busy ? "보내는 중…" : "보내기";
        const missing = unanswered(record, draft);
        missingHint.textContent = draft.busy || missing.length === 0
          ? ""
          : record.questions.length > 1 ? `아직 답하지 않은 질문: ${missing.join(", ")}번` : "답을 고르거나 직접 적으면 보낼 수 있어요";
        missingHint.hidden = missingHint.textContent === "";
        sendButton.title = missingHint.textContent;
        sendButton.disabled = draft.busy || missing.length > 0;
        skipButton.disabled = draft.busy;
        el.setAttribute("aria-busy", draft.busy ? "true" : "false");
      }

      // 같은 카드에서 보내기·건너뛰기는 한 번에 하나만. 응답이 오기 전 연타(더블클릭)는 첫 번만 나간다.
      async function send(action, optimisticStatus) {
        if (draft.busy) return;
        draft.busy = true;
        draft.error = "";
        sync();
        let failure = "";
        try {
          const result = await action();
          if (result && result.ok === false) failure = result.error || "보내지 못했습니다.";
        } catch (caught) {
          failure = caught?.message || "보내지 못했습니다.";
        }
        draft.busy = false;
        if (failure) {
          draft.error = failure;
          sync();
          return;
        }
        // 성공: 곧 같은 질문의 처리됨 알림이 오지만 기다리지 않고 카드를 거둔다.
        const current = records.get(record.questionId);
        if (current && isPending(current)) records.set(record.questionId, { ...current, status: optimisticStatus });
        drafts.delete(record.questionId);
        const active = document.activeElement;
        const hadFocus = !active || active === document.body || (typeof el.contains === "function" && el.contains(active));
        render();
        // 눌렀던 버튼이 사라지면 초점이 문서 맨 위로 떨어진다. 키보드로 쓰던 사람이 자리를 잃지 않게 입력창으로 옮긴다.
        if (hadFocus && typeof focusComposer === "function") {
          try { focusComposer(); } catch { /* 초점을 못 옮겨도 답은 이미 갔다 */ }
        }
      }
      function submit() {
        if (!isComplete(record, draft)) return Promise.resolve();
        return send(() => answer(record, buildAnswers(record, draft)), "submitting");
      }
      sendButton.addEventListener("click", submit);
      skipButton.addEventListener("click", () => send(() => skip(record), "cancelled"));
      sync();
      return { el };
    }

    function notifyIfChanged() {
      const key = pendingList().map((record) => record.questionId).join("\n");
      if (key === lastPending) return;
      lastPending = key;
      if (typeof onChange === "function") onChange();
    }

    function render() {
      const pending = pendingList();
      const live = new Set(pending.map((record) => record.questionId));
      for (const [id, view] of [...views]) {
        if (live.has(id)) continue;
        view.el.remove();
        views.delete(id);
      }
      pending.forEach((record, index) => {
        if (!views.has(record.questionId)) views.set(record.questionId, buildCard(record));
        const { el } = views.get(record.questionId);
        // 이미 제자리면 건드리지 않는다(입력 중인 칸이 초점을 잃거나 화면이 출렁이지 않게).
        if (container.children[index] !== el) container.insertBefore(el, container.children[index] || null);
      });
      container.hidden = pending.length === 0;
      notifyIfChanged();
    }

    // 상태 스냅숏(방을 열거나 창이 다시 붙을 때): 지금 방의 질문 기록 전체로 바꾼다.
    function replaceAll(list) {
      records.clear();
      for (const record of list || []) {
        if (record?.questionId && record.sessionId === getSessionId()) records.set(record.questionId, record);
      }
      // 이 방에서 이미 처리된 질문의 쓰던 답은 버린다(다른 방의 것은 그 방으로 돌아올 때를 위해 둔다).
      for (const [id, draft] of [...drafts]) {
        if (draft.sessionId === getSessionId() && !(records.get(id) && isPending(records.get(id)))) drafts.delete(id);
      }
      render();
    }

    // 질문 상태가 바뀔 때마다 오는 알림. 다른 방 것은 그 방 스냅숏이 되살리므로 무시한다.
    function apply(record) {
      if (!record?.questionId || record.sessionId !== getSessionId()) return;
      const existing = records.get(record.questionId);
      // 이미 처리된 질문을 늦게 도착한 '대기' 알림이 되살리지 못한다.
      if (existing && !isPending(existing) && isPending(record)) return;
      records.set(record.questionId, record);
      if (!isPending(record)) drafts.delete(record.questionId);
      render();
    }

    return {
      replaceAll, apply, render,
      hasPending: () => pendingList().length > 0,
      // 이 에이전트의 질문이 지금 방에서 사용자의 답을 기다리는가(입력 중 표시를 '답변 대기'로 바꾸는 데 쓴다).
      isWaiting: (agentId) => pendingList().some((record) => record.agentId === agentId),
    };
  }

  const api = { createQuestionCards };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.questionCard = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
