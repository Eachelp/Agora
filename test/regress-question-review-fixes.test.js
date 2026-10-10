"use strict";

// 질문 카드 독립 검증에서 나온 지적의 회귀 시험.
// (1) 작은 창에서도 보내기·건너뛰기가 보인다 (2) 셸 래퍼(.cmd)로 카드가 빠지면 이유를 알린다 (3) 문서가 비용·한계를 말한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ChatRoom } = require("../src/chat/chat-room");
const { createUserQuestionBroker } = require("../src/chat/user-question-broker");
const { createRoomQuestionTool } = require("../src/chat/user-question-run");
const { scriptedRunner } = require("./question-helpers.cjs");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

function rule(css, selector) {
  const from = css.indexOf(`
${selector} {`);
  assert.ok(from >= 0, `${selector} 규칙이 없다`);
  return css.slice(from, css.indexOf("}", from));
}

test("질문 카드가 스크롤돼도 보내기·건너뛰기 줄은 카드 아래에 붙어 늘 보인다", () => {
  const css = read("src", "chat.css");
  const actions = rule(css, ".question-actions");
  assert.match(actions, /position:\s*sticky/);
  assert.match(actions, /bottom:\s*0/);
  assert.match(actions, /background:\s*var\(--accent-soft\)/, "뒤 내용이 비치지 않게 카드와 같은 불투명 면");
  // 카드 영역이 대화 영역을 짓누르지 않도록 화면 높이의 절반 아래로 제한한다.
  const row = rule(css, ".question-row");
  const vh = Number(/min\((\d+)vh/.exec(row)?.[1]);
  assert.ok(vh > 0 && vh < 50, `카드 영역 높이 상한이 ${vh}vh`);
});

function shellRoom(t, meta = { permissionMode: "workspace-read" }) {
  const broker = createUserQuestionBroker({ onCallbackError: () => {} });
  t.after(() => broker.stop());
  const log = {};
  const room = new ChatRoom({
    sessionId: "s1",
    agents: [
      { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
      { id: "codex", name: "Codex", aliases: ["codex"], available: true, enabled: true },
      { id: "agy", name: "Antigravity", aliases: ["agy"], available: true, enabled: true },
    ],
    runAgent: scriptedRunner(async () => "네", log),
    meta,
    questionTool: createRoomQuestionTool({ broker, sessionId: "s1", needsShellOf: (a) => a.id === "codex" }),
  });
  return { room, log };
}

test("셸 래퍼(.cmd)로 설치된 Codex는 카드를 못 쓴다고 대화에 한 번만 알리고, 응답은 도구 없이 이어진다", async (t) => {
  const { room, log } = shellRoom(t);
  const notices = () => room.messages.filter((m) => m.authorType === "system" && /셸 래퍼/.test(m.text));
  room.sendUserMessage("@codex 안녕");
  await room.waitForIdle();
  room.sendUserMessage("@codex 또 안녕");
  await room.waitForIdle();
  assert.equal(notices().length, 1, "에이전트마다 한 번");
  assert.match(notices()[0].text, /@codex/);
  assert.match(notices()[0].text, /응답 끝에서 묻는/);
  assert.ok(log.calls.every((c) => !("userQuestion" in c)));
  assert.ok(room.messages.some((m) => m.authorType === "agent" && m.author === "codex"), "응답은 정상");
});

test("셸 래퍼 안내는 해당 없는 경우(카드가 붙는 Claude, 원래 지원 밖인 AGY)에는 나오지 않는다", async (t) => {
  const { room } = shellRoom(t);
  room.sendUserMessage("@claude 안녕");
  room.sendUserMessage("@agy 안녕");
  await room.waitForIdle();
  assert.equal(room.messages.filter((m) => /셸 래퍼/.test(m.text || "")).length, 0);
});

test("사용자 문서가 .cmd 한계와 매 턴 붙는 비용(Codex 시작 지연·토큰)을 숨기지 않는다", () => {
  const guide = read("사용-안내.md");
  assert.match(guide, /\.cmd/);
  assert.match(guide, /Codex는[^\n]*5초[^\n]*3배/);
  assert.match(read("README.md"), /\.cmd/);
  const record = read("docs", "design", "AGORA_REVISION_2026-10-11_QUESTION_UI.md");
  assert.doesNotMatch(record, /필요한 실행에만 붙인다/, "실제로는 일반 대화 턴마다 붙는다");
  assert.match(record, /매번[^\n]*붙/);
});

test("대화 전용 방에서는 셸 래퍼(.cmd) 안내가 나오지 않는다(붙일 일이 없었으므로)", async (t) => {
  const { room, log } = shellRoom(t, { permissionMode: "chat" });
  room.sendUserMessage("@codex 안녕");
  await room.waitForIdle();
  assert.equal(room.messages.filter((m) => m.authorType === "system").length, 0);
  assert.ok(log.calls.every((c) => !("userQuestion" in c)));
});
