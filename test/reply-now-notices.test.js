"use strict";

// 바로 답하기의 안내 문구: 기다리는 빠른 턴은 대기 줄에 보이고, 정체 경고는 정말 막힌 턴에게만
// "차례를 기다리고 있습니다"라고 하며, 시작할 수 있는 턴에는 그 말을 하지 않는다.
// 진입점은 ChatRoom.sendUserMessage / cancelTurn / stopAll, 러너는 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom, ids, queued } = require("./reply-now-helpers.cjs");

const OLD = Date.now() - 999_000;
const lastSystem = (room) => room.messages.filter((message) => message.authorType === "system").at(-1)?.text;

// claude는 끝났고 codex와 agy가 따로 도는 중이다(독립 발언 @모두).
async function threeRunning() {
  const env = makeRoom();
  env.room.sendUserMessage({ text: "@all 질문", independent: true });
  await settle();
  assert.deepEqual(ids(env.calls), ["claude", "codex", "agy"]);
  return env;
}

test("자기 담당자 뒤에서 기다리는 빠른 턴은 대기 줄에 '대기'로 보이고, 정체 경고는 막고 있는 담당자만 적는다", async () => {
  const { room, calls } = await threeRunning();
  room.sendUserMessage("@claude 한 가지만 더");
  await settle();
  assert.deepEqual(queued(room), ["claude*"], "fast 표시가 붙은 대기 항목");
  const waiting = room.turnState().queue[0];
  room.turnStartedAt.set(waiting.turnId, OLD);
  room.checkTurnStall(waiting.turnId);
  const text = lastSystem(room);
  assert.match(text, /@claude 응답은 아직 차례를 기다리고 있습니다 \(@claude 실행 중\)/);
  assert.doesNotMatch(text, /@codex|@agy|유실/, "상관없는 담당자가 돌고 있다는 말은 하지 않는다");
  // 정상 대기 안내는 유실 표시를 태우지 않아, 나중에 중지로 버려지면 그 사실이 안내된다.
  assert.equal(room.lostTurnNotified.has(waiting.turnId), false);
  room.stopAll();
  assert.match(lastSystem(room), /중지/);
  await settle();
  calls.forEach((call) => call.cancelled || call.finish());
});

test("× 로 취소한 빠른 대기 턴은 안내를 남기지 않고, 돌고 있던 턴은 그대로 간다", async () => {
  const { room, calls } = await threeRunning();
  room.sendUserMessage("@codex 이건 이렇게");
  await settle();
  const before = room.messages.length;
  room.cancelTurn(room.turnState().queue[0].turnId);
  assert.deepEqual(queued(room), []);
  assert.equal(room.messages.length, before, "취소 안내는 없다");
  assert.deepEqual(ids(calls), ["claude", "codex", "agy"], "새 실행은 만들어지지 않는다");
  calls.forEach((call) => call.finish());
  await settle();
});

test("시작할 수 있는 턴에는 '차례를 기다리고 있습니다'라고 하지 않고 유실 가능성을 알린다", async () => {
  const { room, calls } = makeRoom();
  room.sendUserMessage("@claude 오래 걸리는 일");
  await settle();
  // 팬아웃이 끝나지 않은 척 펌프를 막아, 다른 담당자(@codex)의 빠른 턴이 시작하지 못하고 큐에 남은 상태를 만든다.
  room.pumpSuspended += 1;
  room.sendUserMessage("@codex 안녕");
  assert.deepEqual(queued(room), ["codex*"]);
  room.pumpSuspended -= 1;
  const stuck = room.turnState().queue[0];
  room.turnStartedAt.set(stuck.turnId, OLD);
  room.checkTurnStall(stuck.turnId);
  const text = lastSystem(room);
  assert.match(text, /@codex 응답이 \d+초 넘게 시작되지 않고 있습니다/);
  assert.doesNotMatch(text, /차례를 기다리고 있습니다/, "claude가 돌고 있어도 codex는 막힌 것이 아니다");
  // 막힌 것이 풀리면 곧바로 시작한다.
  room.pumpTurnQueue();
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"]);
  calls.forEach((call) => call.finish());
  await settle();
});

test("일반 줄의 대기 턴은 돌고 있는 담당자 전부가 막고 있다고 안내한다", async () => {
  const { room, calls } = await threeRunning();
  room.sendUserMessage("@claude @codex 이어서"); // 이어 발언 둘: 일반 줄
  await settle();
  const waiting = room.turnState().queue;
  assert.equal(waiting.length, 2);
  assert.ok(waiting.every((entry) => entry.fast === false));
  room.turnStartedAt.set(waiting[0].turnId, OLD);
  room.checkTurnStall(waiting[0].turnId);
  assert.match(lastSystem(room), /\(@claude, @codex, @agy 실행 중\)|\(@\w+(, @\w+)* 실행 중\)/);
  assert.match(lastSystem(room), /차례를 기다리고 있습니다/);
  room.stopAll();
  await settle();
  calls.forEach((call) => call.cancelled || call.finish());
});

test("중지·잠깐 안내는 기다리던 빠른 턴을 전달되지 않은 메시지로 센다", async () => {
  for (const stop of ["stopAll", "interject"]) {
    const { room, calls } = await threeRunning();
    room.sendUserMessage("@claude 한 가지만 더");
    room.sendUserMessage("@codex 이것도");
    await settle();
    assert.deepEqual(queued(room), ["claude*", "codex*"]);
    room[stop]();
    const text = room.messages.filter((m) => m.authorType === "system").map((m) => m.text).join("\n");
    assert.match(text, /대기 중이던 메시지 2개는 전달되지 않았으니/, `${stop}: 전달되지 않은 메시지 안내`);
    assert.deepEqual(queued(room), []);
    await settle();
    calls.forEach((call) => call.cancelled || call.finish());
    await settle();
    assert.deepEqual(room.turnState().running, []);
  }
});
