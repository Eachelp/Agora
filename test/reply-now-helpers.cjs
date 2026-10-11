"use strict";

// 바로 답하기(reply-now) 시험 공용 도구. 러너는 시험이 약속을 풀 때까지 멈춰 있고,
// 취소하면 프로세스가 끝나는 것처럼 { cancelled: true }로 끝난다.
const { ChatRoom } = require("../src/chat/chat-room");

const tick = () => new Promise((resolve) => setImmediate(resolve));
// 마이크로태스크와 한 번의 타이머 턴을 모두 흘려보낸다.
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

function makeAgent(id, extra = {}) {
  return { id, name: id, aliases: [id], available: true, enabled: true, ...extra };
}

// 러너 호출 하나. finish(text)로 정상 종료, fail(message)로 실패, cancel()은 방이 부른다.
function makeRunner() {
  const calls = [];
  const runAgent = (args) => {
    const gate = Promise.withResolvers();
    const call = {
      agentId: args.agent.id,
      prompt: args.prompt,
      runId: args.runId,
      permissionMode: args.permissionMode,
      cancelled: false,
      done: false,
      index: calls.length,
      finish(text = "완료") { call.done = true; gate.resolve({ ok: true, text }); },
      fail(error = "실패") { call.done = true; gate.resolve({ ok: false, error }); },
    };
    calls.push(call);
    return {
      promise: gate.promise,
      cancel() {
        call.cancelled = true;
        // 취소한 프로세스는 곧 끝난다(끝내는 시점은 시험이 정할 수 있다).
        if (!call.holdCancel) gate.resolve({ ok: false, cancelled: true, error: "중지됨" });
        else call.endCancelled = () => gate.resolve({ ok: false, cancelled: true, error: "중지됨" });
      },
    };
  };
  return { calls, runAgent };
}

// random이 항상 끝 순번을 골라 shuffle이 순서를 그대로 둔다.
const identityRandom = () => 0.999;

function makeRoom({ ids = ["claude", "codex", "agy"], meta, ...options } = {}) {
  const { calls, runAgent } = makeRunner();
  const events = [];
  const systems = [];
  const room = new ChatRoom({
    agents: ids.map((id) => makeAgent(id)),
    meta: { permissionMode: "chat", ...(meta || {}) },
    random: identityRandom,
    runAgent,
    ...options,
  });
  room.on("busy", (value) => events.push(["busy", value]));
  room.on("message", (message) => { if (message?.authorType === "system") systems.push(message.text); });
  return { room, calls, events, systems };
}

const ids = (list) => list.map((entry) => entry.agentId);
const running = (room) => room.turnState().running;
const queued = (room) => room.turnState().queue.map((entry) => `${entry.agentId}${entry.fast ? "*" : ""}`);

module.exports = { tick, settle, makeAgent, makeRunner, makeRoom, identityRandom, ids, running, queued };
