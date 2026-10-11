"use strict";

// 바로 답하기 개정은 두 가지 프롬프트 말고는 아무것도 바꾸지 않는다: (1) 다른 모델이 함께 도는 턴에 붙는
// 동시 작업 안내·계약, (2) 답할 메시지 뒤에 다른 답이 끝나 들어와 있는 빠른/독립 발언 턴의 "이번에 답할 메시지" 줄.
// 이 시험은 그 밖의 모든 프롬프트가 main(v1.3.1)과 글자 하나까지 같음을 지킨다.
//
//   A. buildAgentPrompt 조합표: 권한 3 × 맥락 × 질문 도구 × 전달·방송·병렬 계약 × 토론·종합·쉽게 설명 …
//   B. 방(ChatRoom) 시나리오: @모두 연쇄·멘션 호출·이어 발언·멘션 없음·아무도 안 도는 방의 직접 답장·독립 발언·
//      토론·결론 종합·전달·쉽게 설명을 가짜 러너로 돌려 러너가 받은 프롬프트를 순서대로 견준다.
//
// 기준값(test/fixtures/reply-now-main-prompts.json)은 프롬프트의 SHA-256이다. main 소스로 다시 만들려면:
//   git archive main src package.json | tar -x -C <빈 폴더>
//   AGORA_MAIN_SRC_CHAT=<빈 폴더>/src/chat node --test test/reply-now-prompt-matrix.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURE = path.join(__dirname, "fixtures", "reply-now-main-prompts.json");
const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

function loadImpl(dir) {
  return {
    buildAgentPrompt: require(path.join(dir, "chat-prompt.js")).buildAgentPrompt,
    ChatRoom: require(path.join(dir, "chat-room.js")).ChatRoom,
  };
}

const agent = (id) => ({ id, name: id.toUpperCase(), aliases: [id], available: true, enabled: true });
const AGENTS = ["claude", "codex", "agy"].map(agent);

// ---- A. buildAgentPrompt 조합표 ----
function messageSets() {
  const user = (id, text, extra = {}) => ({ id, authorType: "user", author: "user", authorName: "나", text, ...extra });
  const bot = (id, who, text, extra = {}) => ({ id, authorType: "agent", author: who, text, ...extra });
  const long = [];
  for (let i = 0; i < 70; i += 1) long.push(i % 2 ? bot(`l${i}`, i % 3 ? "codex" : "claude", `답 ${i}: ${"내용 ".repeat(8)}`) : user(`l${i}`, `질문 ${i}`));
  return {
    one: [user("m1", "안녕하세요")],
    mixed: [
      user("m1", "계획을 세워 줘", { attachments: [{ name: "a.png" }, { name: "b.txt" }] }),
      bot("m2", "claude", "계획입니다. @codex 검토해 줘", { discussionTurnMeta: { roleName: "발안" } }),
      bot("m3", "codex", "검토했습니다"),
      user("m4", "@agy 한 가지만"),
      bot("m5", "agy", "네"),
      user("m6", "고마워요"),
    ],
    long,
  };
}

const PERMS = ["chat", "workspace-read", "workspace-write"];
const CONTEXTS = [
  {},
  { projectContext: "프로젝트 맥락", memoryContext: "누적 요약 ".repeat(40), rulesContext: "규칙 하나", workflowContext: "결정 하나" },
];

function* matrixA() {
  const sets = messageSets();
  const base = (messages) => ({ agent: AGENTS[0], agents: AGENTS, messages });
  // 자유 대화: 전체 곱은 mixed 기록으로, one·long은 줄인 곱으로.
  for (const [setName, messages] of Object.entries(sets)) {
    const full = setName === "mixed";
    for (const permissionMode of PERMS) for (const [ci, ctx] of CONTEXTS.entries()) for (const userQuestionTool of [false, true]) {
      for (const mentionsEnabled of full ? [true, false] : [true]) for (const broadcast of full ? [null, { position: 1, total: 3 }, { position: 2, total: 3 }] : [null]) {
        for (const parallel of full ? [null, { folder: "claude", total: 3 }] : [null]) for (const handoff of full ? [null, { intent: "REVIEW_OPINION", text: "전달 본문" }, { intent: "CONTINUE", text: "전달 본문" }] : [null]) {
          for (const extraLines of full ? [[], ["- 추가 줄"]] : [[]]) {
            yield [`free/${setName}/${permissionMode}/ctx${ci}/q${userQuestionTool}/m${mentionsEnabled}/b${broadcast ? broadcast.position : 0}/p${parallel ? 1 : 0}/h${handoff ? handoff.intent : "-"}/x${extraLines.length}`,
              { ...base(messages), permissionMode, ...ctx, userQuestionTool, mentionsEnabled, broadcast, parallel, handoff, extraLines }];
          }
        }
      }
    }
  }
  const mixed = sets.mixed;
  for (const permissionMode of PERMS) for (const [ci, ctx] of CONTEXTS.entries()) {
    const discussions = {
      auto: { turn: 2, maxTurns: 9 },
      role: { cycle: 1, cycleBudget: 2, step: 1, stepCount: 3, turn: 1, maxTurns: 6, role: { name: "비평", charter: "허점을 짚는다" }, finalStep: false },
      roleFinal: { cycle: 1, cycleBudget: 2, step: 3, stepCount: 3, turn: 3, maxTurns: 6, role: { name: "수정", charter: "고친다" }, finalStep: true },
      topic: { turn: 1, maxTurns: 9, topicMessageId: "m1" },
    };
    for (const [name, discussion] of Object.entries(discussions)) {
      yield [`discussion/${name}/${permissionMode}/ctx${ci}`, { ...base(mixed.slice(2)), messages: mixed.slice(2), discussion, permissionMode, ...ctx, mentionsEnabled: false }];
      // 토론 턴에는 동시 작업 입력이 있어도 아무것도 붙지 않는다.
      yield [`discussion/${name}/${permissionMode}/ctx${ci}/concurrent-ignored`, { ...base(mixed.slice(2)), discussion, permissionMode, ...ctx, mentionsEnabled: false, concurrentWork: ["codex"] }];
    }
    for (const summary of [{ discussionId: "d1" }, { discussionId: "d1", record: true }, { discussionId: "d1", incomplete: true, failures: 2 }]) {
      const tag = `${summary.record ? "record" : "summary"}${summary.incomplete ? "-inc" : ""}`;
      yield [`${tag}/${permissionMode}/ctx${ci}`, { ...base(mixed), discussionSummary: summary, permissionMode, ...ctx }];
      yield [`${tag}/${permissionMode}/ctx${ci}/concurrent-ignored`, { ...base(mixed), discussionSummary: summary, permissionMode, ...ctx, concurrentWork: ["codex"] }];
    }
    yield [`simplify/${permissionMode}/ctx${ci}`, { ...base(mixed), simplifyMeta: { messageId: "m2", fromAgentId: "claude", text: "복잡한 설명" }, permissionMode, ...ctx }];
    yield [`simplify/${permissionMode}/ctx${ci}/concurrent-ignored`, { ...base(mixed), simplifyMeta: { messageId: "m2", fromAgentId: "claude", text: "복잡한 설명" }, permissionMode, ...ctx, concurrentWork: ["codex"] }];
  }
}

// ---- B. 방 시나리오 ----
const idle = async (room) => {
  await room.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
};

const SCENARIOS = {
  "@모두 연쇄와 멘션 호출": async (room) => {
    room.sendUserMessage("@all 질문입니다");
    await idle(room);
  },
  "이어 발언·멘션 없음·직접 답장·이어 발언 둘": async (room) => {
    room.sendUserMessage("@claude @codex 이어서 얘기해 줘");
    await idle(room);
    room.sendUserMessage("안녕하세요");
    await idle(room);
    room.sendUserMessage("@agy 너는 어때?"); // 아무도 안 도는 방의 직접 답장: 빠른 줄이지만 프롬프트는 같다
    await idle(room);
    room.sendUserMessage("@agy @claude 둘이 이어서");
    await idle(room);
    room.sendUserMessage("@codex 마지막으로 하나만");
    await idle(room);
  },
  "독립 발언 두 번": async (room) => {
    room.sendUserMessage({ text: "@all 각자 의견", independent: true });
    await idle(room);
    room.sendUserMessage({ text: "@claude @codex 위를 각자 검토해", independent: true });
    await idle(room);
  },
  "토론·결론 종합·전달·쉽게 설명": async (room) => {
    room.sendUserMessage("토론 주제입니다");
    await idle(room);
    const result = await room.startDiscussion({ turnBudget: 4 });
    await idle(room);
    const end = room.messages.find((message) => message.discussionMeta);
    await room.summarizeDiscussion(end.discussionMeta.discussionId, "claude");
    await idle(room);
    const source = room.messages.findLast((message) => message.authorType === "agent" && !message.discussionSummary);
    room.handoffMessage("codex", source.id, "REVIEW_OPINION");
    await idle(room);
    room.handoffMessage("agy", source.id, "CONTINUE");
    await idle(room);
    room.handoffMessage(source.author, source.id, "SIMPLIFY_SELF");
    await idle(room);
    room.sendUserMessage("@claude 토론 끝났으니 정리해 줘");
    await idle(room);
    return result;
  },
};

async function runScenario(ChatRoom, permissionMode, scenario) {
  const prompts = [];
  const counts = {};
  const runAgent = ({ agent: who, prompt }) => {
    prompts.push(prompt);
    counts[who.id] = (counts[who.id] || 0) + 1;
    const text = who.id === "claude" && counts.claude === 1 ? "제 의견입니다. @codex 확인해 주세요." : `${who.id} 답 ${counts[who.id]}`;
    return { promise: Promise.resolve({ ok: true, text }), cancel: () => {} };
  };
  const room = new ChatRoom({ agents: AGENTS.map((entry) => ({ ...entry })), meta: { permissionMode }, runAgent, random: () => 0.999 });
  await SCENARIOS[scenario](room);
  return prompts.map(sha);
}

async function collect(impl) {
  const prompts = {};
  for (const [key, input] of matrixA()) {
    assert.equal(prompts[`A/${key}`], undefined, `중복 키 ${key}`);
    prompts[`A/${key}`] = sha(impl.buildAgentPrompt(input));
  }
  for (const permissionMode of PERMS) for (const name of Object.keys(SCENARIOS)) {
    (await runScenario(impl.ChatRoom, permissionMode, name)).forEach((hash, index) => { prompts[`B/${permissionMode}/${name}/#${index}`] = hash; });
  }
  return prompts;
}

if (process.env.AGORA_MAIN_SRC_CHAT) {
  test("기준값 다시 만들기(main 소스)", async () => {
    const prompts = await collect(loadImpl(process.env.AGORA_MAIN_SRC_CHAT));
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ _comment: "main(v1.3.1)의 프롬프트 SHA-256. 만드는 법은 test/reply-now-prompt-matrix.test.js 머리말.", prompts }, null, 1)}\n`);
    assert.ok(Object.keys(prompts).length > 400);
  });
} else {
  test("동시 작업 안내·답할 메시지 줄이 붙는 턴 말고는 모든 프롬프트가 main과 글자 하나까지 같다", async () => {
    const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).prompts;
    assert.ok(Object.keys(expected).length > 400, "기준값이 비어 있지 않다");
    const actual = await collect(loadImpl(path.join(__dirname, "..", "src", "chat")));
    const differ = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
    assert.deepEqual(differ, [], `main과 달라진 프롬프트 ${differ.length}개`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), "시나리오의 호출 수도 같다");
  });
}
