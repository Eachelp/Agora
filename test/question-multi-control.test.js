const test = require("node:test");
const assert = require("node:assert/strict");
const { parseControlOutput, stripControlOutput } = require("../src/chat/control-output");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");
const { ChatRoom } = require("../src/chat/chat-room");

const lines = (...rows) => rows.join("\n");

test("MULTI: yes는 ASK_USER 보기를 여러 개 고르는 질문으로 읽는다", () => {
  const text = lines("본문", "", "ASK_USER: 무엇을 포함할까요?", "MULTI: yes", "OPTION: A", "OPTION: B", "OPTION: C");
  assert.deepEqual(parseControlOutput(text), {
    action: "ASK_USER",
    question: "무엇을 포함할까요?",
    options: ["A", "B", "C"],
    multi: true,
    ambiguous: false,
  });
  assert.equal(stripControlOutput(text), "본문");
});

test("MULTI는 예/true/y와 대소문자·공백 변형을 받고 그 밖의 값은 단일 선택", () => {
  for (const value of ["yes", "YES", "Yes", "예", "true", "TRUE", "y", "Y", "  yes  "]) {
    const parsed = parseControlOutput(lines("ASK_USER: 골라요", `MULTI:${value}`, "OPTION: A", "OPTION: B"));
    assert.equal(parsed.multi, true, `"${value}"는 다중 선택`);
  }
  for (const value of ["no", "false", "아니오", "maybe", "yess"]) {
    const parsed = parseControlOutput(lines("ASK_USER: 골라요", `MULTI: ${value}`, "OPTION: A", "OPTION: B"));
    assert.equal(parsed.multi, false, `"${value}"는 단일 선택`);
    assert.deepEqual(parsed.options, ["A", "B"]);
  }
  assert.equal(parseControlOutput("ASK_USER: 골라요\nOPTION: A").multi, false);
});

test("MULTI 줄은 OPTION 뒤나 ASK_USER 앞에 와도 같은 꼬리 블록이면 인식하고 화면에서 지운다", () => {
  const after = lines("본문", "ASK_USER: 골라요", "OPTION: A", "OPTION: B", "MULTI: yes");
  assert.equal(parseControlOutput(after).multi, true);
  assert.equal(stripControlOutput(after), "본문");
  const before = lines("본문", "MULTI: yes", "ASK_USER: 골라요", "OPTION: A");
  assert.equal(parseControlOutput(before).multi, true);
  assert.equal(stripControlOutput(before), "본문");
});

test("ASK_USER 없이 MULTI만 있으면 제어가 아니고 산문으로 남는다", () => {
  const text = lines("본문", "MULTI: yes", "OPTION: A", "OPTION: B");
  assert.equal(parseControlOutput(text), null);
});

test("꼬리가 아닌 자리의 MULTI는 제어가 아니다", () => {
  const text = lines("ASK_USER: 골라요", "MULTI: yes", "OPTION: A", "", "이어지는 문장", "OPTION: B");
  // 블록은 마지막 연속 제어 줄(OPTION: B)뿐이라 ASK_USER가 없다.
  assert.equal(parseControlOutput(text), null);
  const trailingProse = lines("ASK_USER: 골라요", "MULTI: yes", "OPTION: A", "끝맺는 말");
  assert.equal(parseControlOutput(trailingProse), null);
});

test("코드펜스·인라인 코드 안의 MULTI는 세지 않는다", () => {
  const fenced = lines("예시입니다.", "```", "ASK_USER: 예시?", "MULTI: yes", "OPTION: A", "```");
  assert.equal(parseControlOutput(fenced), null);
  assert.equal(stripControlOutput(fenced), fenced);
  // 진짜 제어 블록 위쪽 펜스에 든 MULTI는 무시: 블록의 MULTI가 없으면 단일.
  const mixed = lines("```", "MULTI: yes", "```", "ASK_USER: 골라요", "OPTION: A", "OPTION: B");
  assert.equal(parseControlOutput(mixed).multi, false);
  const inline = lines("`MULTI: yes` 같은 줄을 쓰면 됩니다.", "ASK_USER: 골라요", "OPTION: A");
  assert.equal(parseControlOutput(inline).multi, false);
});

test("ASK_USER가 여럿이면 여전히 ambiguous이고 MULTI로 확정되지 않는다", () => {
  const parsed = parseControlOutput(lines("ASK_USER: 하나?", "ASK_USER: 둘?", "MULTI: yes", "OPTION: A"));
  assert.equal(parsed.ambiguous, true);
  assert.equal(parsed.multi, false);
});

test("MULTI 줄이 여럿이면 마지막 값을 따른다", () => {
  assert.equal(parseControlOutput(lines("ASK_USER: 골라요", "MULTI: no", "MULTI: yes", "OPTION: A")).multi, true);
  assert.equal(parseControlOutput(lines("ASK_USER: 골라요", "MULTI: yes", "MULTI: no", "OPTION: A")).multi, false);
});

test("프롬프트는 일반 채팅 턴에만 MULTI 안내를 넣고 계약은 짧게 유지한다", () => {
  const agents = [{ id: "claude", name: "Claude", aliases: ["claude"] }];
  const base = { agent: agents[0], agents, messages: [{ author: "user", authorType: "user", text: "안녕" }] };
  const general = buildAgentPrompt(base);
  assert.match(general, /`MULTI: yes`/);
  assert.match(general, /여러 개 고를 수 있으면 OPTION 줄 바로 앞에/);
  assert.doesNotMatch(buildAgentPrompt({ ...base, discussion: { turn: 1, maxTurns: 3 } }), /MULTI/);
});

function makeAgents() {
  return [{ id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true }];
}
function fakeRunner(replies) {
  return ({ agent }) => {
    const next = (replies[agent.id] || []).shift() || { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}
async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("방: MULTI 질문은 awaitingMulti로 상태·agents 이벤트에 실리고 본문에는 제어 줄이 없다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [
        { ok: true, text: "정리했습니다.\n\nASK_USER: 무엇을 포함할까요?\nMULTI: yes\nOPTION: 개요\nOPTION: 일정\nOPTION: 예산" },
        { ok: true, text: "알겠습니다." },
      ],
    }),
  });
  const events = [];
  room.on("agents", (agents) => events.push(agents.find((agent) => agent.id === "claude")));
  room.sendUserMessage("@claude 문서 만들어줘");
  await settle(room);
  const claude = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(claude.awaitingUser, true);
  assert.equal(claude.awaitingMulti, true);
  assert.deepEqual(claude.awaitingOptions, ["개요", "일정", "예산"]);
  assert.equal(room.state().agents.find((agent) => agent.id === "claude").awaitingMulti, true);
  assert.ok(events.some((agent) => agent.awaitingMulti === true), "agents 이벤트에도 실린다");
  const reply = room.messages.find((message) => message.authorType === "agent");
  assert.equal(reply.text, "정리했습니다.");
  assert.doesNotMatch(reply.text, /MULTI|OPTION|ASK_USER/);

  // 새 턴이 시작되면 대기와 함께 다중 선택도 풀린다.
  room.sendUserMessage("@claude 개요, 일정");
  await settle(room);
  const after = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(after.awaitingUser, false);
  assert.equal(after.awaitingMulti, false);
});

test("방: MULTI가 없거나 보기가 없으면 awaitingMulti는 false", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({ claude: [{ ok: true, text: "확인.\nASK_USER: 진행할까요?\nMULTI: yes" }] }),
  });
  room.sendUserMessage("@claude 확인");
  await settle(room);
  const claude = room.publicAgents().find((agent) => agent.id === "claude");
  assert.equal(claude.awaitingUser, true);
  assert.equal(claude.awaitingMulti, false);
});

test("방: ASK_USER 없이 MULTI만 있으면 대기도 서지 않고 본문도 지우지 않는다", async () => {
  const text = lines("본문", "MULTI: yes", "OPTION: A", "OPTION: B");
  const room = new ChatRoom({ agents: makeAgents(), runAgent: fakeRunner({ claude: [{ ok: true, text }] }) });
  room.sendUserMessage("@claude 확인");
  await settle(room);
  assert.equal(room.publicAgents().find((agent) => agent.id === "claude").awaitingUser, false);
  assert.equal(room.messages.find((message) => message.authorType === "agent").text, text);
});
