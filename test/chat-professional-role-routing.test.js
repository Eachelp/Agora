"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ChatRoom } = require("../src/chat/chat-room");

function agyAgent() {
  return {
    id: "agy",
    name: "Antigravity",
    aliases: ["agy"],
    available: true,
    enabled: true,
    model: "gemini-default",
    effort: "default",
  };
}

test("professional draft는 사용자 작업 요청만 기록하고 일반 응답을 예약하지 않는다", async () => {
  let providerCalls = 0;
  const agent = agyAgent();
  const room = new ChatRoom({
    sessionId: "s-professional-draft",
    agents: [agent],
    runAgent() {
      providerCalls += 1;
      return { promise: Promise.resolve({ ok: true, text: "should not run" }), cancel() {} };
    },
  });

  const entry = room.sendUserMessage({ text: "이 작업을 전문 모드로 진행해줘", recordOnly: true });
  await room.waitForIdle();

  assert.equal(entry.authorType, "user");
  assert.equal(providerCalls, 0);
  assert.equal(room.turnQueue.length, 0);
  assert.equal(room.deferredTurnQueue.length, 0);
  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);
});

test("같은 AGY 담당자라도 Planner와 Plan Reviewer의 역할별 모델을 그대로 유지한다", async () => {
  const calls = [];
  const agent = agyAgent();
  const room = new ChatRoom({
    sessionId: "s-role-routing",
    agents: [agent],
    runAgent({ agent: invoked, specialistStage }) {
      calls.push({
        stage: specialistStage,
        agentId: invoked.id,
        model: invoked.model,
        effort: invoked.effort,
      });
      const text = specialistStage === "planner"
        ? "작업 계획을 확정합니다.\nSTATUS: PLAN_READY"
        : "계획이 구현 가능하고 요구사항을 충족합니다.\nVERDICT: PASS\n[[CODEPET_REVIEW:PASS]]";
      return { promise: Promise.resolve({ ok: true, text }), cancel() {} };
    },
  });

  room.sendUserMessage({ text: "전문 작업 요청", recordOnly: true });
  const result = await room.startSpecialist({
    action: "plan",
    stages: {
      planner: {
        agent,
        agentConfig: { model: "gemini-3.1-pro", effort: "high" },
      },
      planReview: {
        agent,
        agentConfig: { model: "gemini-3.7-flash", effort: "medium" },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { stage: "planner", agentId: "agy", model: "gemini-3.1-pro", effort: "high" },
    { stage: "plan_review", agentId: "agy", model: "gemini-3.7-flash", effort: "medium" },
  ]);
  const responses = room.messages.filter((message) => message.authorType === "agent");
  assert.deepEqual(responses.map((message) => ({
    stage: message.agentMeta?.specialistStage,
    model: message.agentMeta?.model,
    effort: message.agentMeta?.effort,
  })), [
    { stage: "planner", model: "gemini-3.1-pro", effort: "high" },
    { stage: "plan_review", model: "gemini-3.7-flash", effort: "medium" },
  ]);
});

test("renderer와 IPC는 professional draft와 turn-state 경계를 연결한다", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "chat-preload.js"), "utf8");
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");

  assert.match(renderer, /professionalModeEnabled\s*\n\s*\)\s*\n\s*\)/);
  assert.match(renderer, /window\.chatApi\.onTurnState/);
  assert.match(renderer, /effectivePlanReview = planReview\.agentId \? planReview : review/);
  assert.match(preload, /professionalDraft = false/);
  assert.match(ipc, /recordOnly: Boolean\(professionalDraft\)/);
});
