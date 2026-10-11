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

test("카드가 여러 장이면 첫 장만 보내기·건너뛰기 줄이 붙고, 뒤 카드의 줄은 제자리에 있어 그 카드의 머리글을 가리지 않는다", () => {
  const css = read("src", "chat.css");
  // 뒤 카드의 줄까지 붙이면 그 카드가 아래에서 막 들어올 때 줄이 카드 머리글 위로 떠 글자가 겹친다(실제 창에서 확인).
  // 앞 카드를 처리하면 다음 카드가 첫 장이 되어 줄이 붙는다.
  assert.match(rule(css, ".question-card ~ .question-card .question-actions"), /position:\s*static/);
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
  const notices = () => room.messages.filter((m) => m.authorType === "system" && /설치 방식/.test(m.text));
  room.sendUserMessage("@codex 안녕");
  await room.waitForIdle();
  room.sendUserMessage("@codex 또 안녕");
  await room.waitForIdle();
  assert.equal(notices().length, 1, "에이전트마다 한 번");
  assert.match(notices()[0].text, /@codex/);
  assert.doesNotMatch(notices()[0].text, /.cmd|셸|래퍼|도구|MCP|argv/, "개발자 용어 없이 쉬운 말로");
  assert.match(notices()[0].text, /답변 끝에서 선택지로 묻습니다/);
  assert.ok(log.calls.every((c) => !("userQuestion" in c)));
  assert.ok(room.messages.some((m) => m.authorType === "agent" && m.author === "codex"), "응답은 정상");
});

test("셸 래퍼 안내의 '한 번'은 대화마다(앱을 켠 동안)다: 다른 대화(새 방)에서는 같은 안내가 다시 한 번 나온다", async (t) => {
  // 문서가 '대화마다 한 번, 앱을 다시 켜면 다시 한 번'이라고 말한다. 기억을 방 밖(모듈 전역 등)에 두면 이 말이 거짓이 된다.
  const notices = (room) => room.messages.filter((m) => m.authorType === "system" && /설치 방식/.test(m.text));
  const first = shellRoom(t).room;
  const second = shellRoom(t).room;
  first.sendUserMessage("@codex 안녕");
  await first.waitForIdle();
  second.sendUserMessage("@codex 안녕");
  await second.waitForIdle();
  assert.equal(notices(first).length, 1);
  assert.equal(notices(second).length, 1);
});

test("셸 래퍼 안내는 해당 없는 경우(카드가 붙는 Claude, 원래 지원 밖인 AGY)에는 나오지 않는다", async (t) => {
  const { room } = shellRoom(t);
  room.sendUserMessage("@claude 안녕");
  room.sendUserMessage("@agy 안녕");
  await room.waitForIdle();
  assert.equal(room.messages.filter((m) => /설치 방식/.test(m.text || "")).length, 0);
});

test("사용자 문서가 .cmd 한계와 매 턴 붙는 비용(Codex 시작 지연·토큰)을 숨기지 않는다", () => {
  const guide = read("사용-안내.md");
  assert.match(guide, /\.cmd/);
  assert.match(guide, /Codex는[^\n]*5초[^\n]*3배/);
  assert.match(read("README.md"), /\.cmd/);
  const record = read("docs", "design", "AGORA_REVISION_2026-10-11_QUESTION_UI.md");
  assert.doesNotMatch(record, /필요한 실행에만 붙인다/, "실제로는 파일 작업 권한의 일반 대화 턴마다 붙는다");
  assert.match(record, /매번[^\n]*붙/);
  // 안내는 영원히 한 번이 아니라 대화마다·앱을 켠 동안 한 번이다(위 시험이 코드로 확인한다).
  assert.match(guide, /대화마다 AI마다 한 번 나오고, Agora를 다시 켜면 다시 한 번/);
  assert.match(record, /대화\(방\)마다·에이전트마다 한 번, 앱을 다시 켜면 다시 한 번/);
});

test("대화 전용 방에서는 셸 래퍼(.cmd) 안내가 나오지 않는다(붙일 일이 없었으므로)", async (t) => {
  const { room, log } = shellRoom(t, { permissionMode: "chat" });
  room.sendUserMessage("@codex 안녕");
  await room.waitForIdle();
  assert.equal(room.messages.filter((m) => m.authorType === "system").length, 0);
  assert.ok(log.calls.every((c) => !("userQuestion" in c)));
});

// 문서가 코드와 어긋나지 않게: 붙는 조건, 시간 제한, 창 닫기, 토큰 위치.
test("문서가 붙는 조건(파일 작업 권한만)·30분 대기·35분 CLI 제한·창 닫기·토큰 위치를 코드대로 말한다", () => {
  const guide = read("사용-안내.md");
  assert.match(guide, /대화 전용 모드에서는 답변 끝에서 선택지로 묻습니다/);
  assert.match(guide, /카드에 답하는 시간은 \*\*30분까지\*\*/);
  assert.doesNotMatch(guide, /시간 제한은 없지만/, "'시간 제한 없음'과 '30분'이 서로 어긋나면 안 된다");
  assert.match(guide, /같은 AI에게 입력창으로 보낸 메시지는 카드의 답이 되지 않습니다/);
  assert.match(guide, /질문 대기/);
  assert.match(guide, /답변 대기 중/);
  assert.match(read("README.md"), /대화 전용 모드[^\n]*답변 끝에서 선택지로 묻습니다/);
  assert.match(read("docs", "README.md"), /대화 전용·AGY·토론에는 없음/);

  const record = read("docs", "design", "AGORA_REVISION_2026-10-11_QUESTION_UI.md");
  assert.match(record, /MCP_TOOL_TIMEOUT=2100000/);
  assert.match(record, /tool_timeout_sec=2100/);
  assert.doesNotMatch(record, /MCP_TOOL_TIMEOUT=1800000|tool_timeout_sec=1800/);
  assert.match(record, /창 닫기는 질문을 풀지 않는다/);
  assert.doesNotMatch(record, /앱 종료·창 닫기·실행 종료/);
  assert.match(record, /CLI 명령줄에는 들어간다/);
  assert.doesNotMatch(record, /환경 변수로만 전달/);
});

test("개발자 용어(MCP·중계소·셸 래퍼·argv)가 사용자 문서(사용-안내·README)에 나오지 않는다", () => {
  const section = read("사용-안내.md").split("### AI가 일하다 묻는 질문 카드")[1].split("### AI가 응답을 끝내며")[0];
  assert.doesNotMatch(section, /MCP|중계소|셸 래퍼|argv|broker/);
});
