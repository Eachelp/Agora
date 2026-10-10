"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatRoom } = require("../src/chat/chat-room");
const { stripControlOutput } = require("../src/chat/control-output");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
    { id: "codex", name: "GPT", aliases: ["gpt", "codex"], available: true, enabled: true },
  ];
}

// 즉시 응답하는 페이크 러너: replies[에이전트 id] 배열을 순서대로 소비합니다.
function fakeRunner(replies, calls = []) {
  return ({ agent, prompt, attachments, permissionMode }) => {
    calls.push({ agentId: agent.id, prompt, attachments, permissionMode });
    const queue = replies[agent.id] || [];
    const next = queue.length > 0 ? queue.shift() : { ok: true, text: "…" };
    return { promise: Promise.resolve(next), cancel: () => {} };
  };
}

async function settle(room) {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
}

test("stripControlOutput: 꼬리 제어 블록만 표시 텍스트에서 제거한다", () => {
  const text = ["계획 검토가 필요합니다.", "", "HANDOFF: @reviewer", "PURPOSE: plan_review"].join(
    "\n"
  );
  assert.equal(stripControlOutput(text), "계획 검토가 필요합니다.");
  // 본문 중간의 마커는 산문이므로 남는다.
  const mid = ["예시: ", "HANDOFF: @builder", "이렇게 씁니다."].join("\n");
  assert.equal(stripControlOutput(mid), mid);
  // 코드펜스 안의 마커도 남는다.
  const fenced = ["설명", "```", "HANDOFF: @reviewer", "```"].join("\n");
  assert.equal(stripControlOutput(fenced), fenced);
  // 전체가 제어 블록이면 빈 문자열이다.
  assert.equal(stripControlOutput("COMPLETE"), "");
  // 여러 줄 코드펜스가 본문에 있고 그 뒤에 꼬리 제어 블록이 오면, 펜스 앞
  // 본문(닫는 ``` 포함)을 보존하고 제어 줄만 제거한다. maskCodeFences가
  // 펜스 내부 개행을 뭉개면 masked/원문 줄 수가 어긋나 본문을 잘라먹었다.
  const withFence = ["구현했습니다.", "```diff", "+const x = 1;", "```", "STATUS: DONE", "HANDOFF: @reviewer"].join("\n");
  assert.equal(
    stripControlOutput(withFence),
    ["구현했습니다.", "```diff", "+const x = 1;", "```", "STATUS: DONE"].join("\n")
  );
  // 펜스가 꼬리 제어 블록 바로 앞이어도 코드 본문이 통째로 유실되지 않는다.
  const fenceThenControl = ["설명 문단입니다.", "```js", "const a = 1;", "const b = 2;", "```", "HANDOFF: @reviewer"].join("\n");
  assert.equal(
    stripControlOutput(fenceThenControl),
    ["설명 문단입니다.", "```js", "const a = 1;", "const b = 2;", "```"].join("\n")
  );
  // 제어 블록 *뒤에* 코드펜스가 이어지면 끝줄 앵커가 아니다 — 제어를 수용하지도,
  // 펜스를 지우지도 않는다. 펜스를 공백으로 가리던 때는 꼬리 펜스 줄이 전부
  // '빈 줄'로 보여 앞의 제어가 수용되고 펜스 본문이 화면·TASK.md에서 삭제됐다.
  const controlThenFence = ["설명", "HANDOFF: @reviewer", "```js", "const a = 1;", "```"].join("\n");
  assert.equal(stripControlOutput(controlThenFence), controlThenFence);
  const controlThenOpenFence = ["설명", "COMPLETE", "```", "미완성 펜스"].join("\n");
  assert.equal(stripControlOutput(controlThenOpenFence), controlThenOpenFence);
});

test("parseControlOutput: 인라인 백틱 안 내용이 질문·요약·REASON 값에서 증발하지 않는다", () => {
  const { parseControlOutput } = require("../src/chat/control-output");
  // 제어 줄의 *범위*는 masked로 정하되 *값*은 원문에서 읽는다 — masked에서
  // 뽑으면 백틱 내용이 공백이 되고, 값 전체가 백틱이면 질문이 null이 되어
  // ASK_USER 재노출이 아예 발동하지 않았다.
  assert.deepEqual(
    parseControlOutput("본문\nSTATUS: NEEDS_DECISION\n\nASK_USER: `strict` 모드를 켤까요, 아니면 `loose`로 갈까요?"),
    { action: "ASK_USER", question: "`strict` 모드를 켤까요, 아니면 `loose`로 갈까요?", options: [], ambiguous: false }
  );
  assert.equal(parseControlOutput("STATUS: NEEDS_DECISION\n\nASK_USER: `foo`").question, "`foo`");
  assert.equal(parseControlOutput("VERDICT: PASS\n\nCOMPLETE: `auth` 모듈 검수 통과").summary, "`auth` 모듈 검수 통과");
  assert.equal(
    parseControlOutput("STATUS: PLAN_READY\n\nHANDOFF: @reviewer\nREASON: `auth` 모듈 변경 검토 필요").reason,
    "`auth` 모듈 변경 검토 필요"
  );
  // 코드펜스 안의 예시는 여전히 제어가 아니다.
  assert.equal(parseControlOutput("설명\n```\nHANDOFF: @reviewer\n```"), null);
  // 제어 뒤에 펜스가 이어지면 끝줄 앵커가 깨져 제어가 아니다(strip과 같은 범위).
  assert.equal(parseControlOutput("설명\nHANDOFF: @reviewer\n```js\nconst a = 1;\n```"), null);
  // 인라인 백틱으로 감싼 대상은 제어가 아니다 — 가림 문자가 어휘 문자로
  // 읽혀 masked 범위와 원문 파싱이 어긋나면 안 된다.
  assert.equal(parseControlOutput("본문\nHANDOFF: `@reviewer`"), null);
  assert.equal(stripControlOutput("본문\nHANDOFF: `@reviewer`"), "본문\nHANDOFF: `@reviewer`");
});

test("모호한 질문(질문 2개)은 화면에서 strip하지 않아 질문이 사라지지 않는다", async () => {
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner({
      claude: [{ ok: true, text: "본문\n\nASK_USER: 질문1?\nASK_USER: 질문2?" }],
    }),
  });
  room.sendUserMessage("@claude 알려줘");
  await settle(room);
  // strip해 버리면 두 질문이 모두 사라진다.
  const message = room.messages.find((entry) => entry.authorType === "agent");
  assert.match(message.text, /질문1\?/);
  assert.match(message.text, /질문2\?/);
  // 어느 질문에 답해야 할지 모르므로 '답변 대기'로 세우지 않는다.
  assert.equal(room.publicAgents().find((agent) => agent.id === "claude").awaitingUser, false);
});

test("일반 채팅 턴의 제어 마커는 추출되지 않는다", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: fakeRunner(
      { claude: [{ ok: true, text: "답변입니다.\nHANDOFF: @reviewer" }] },
      calls
    ),
  });
  room.sendUserMessage("@claude 알려줘");
  await settle(room);

  // 일반 채팅 턴은 ASK_USER만 읽는다. HANDOFF 줄은 산문으로 그대로 남는다.
  const message = room.messages.find((entry) => entry.authorType === "agent");
  assert.match(message.text, /HANDOFF:/);
});
