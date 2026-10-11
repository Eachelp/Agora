"use strict";

// "AI끼리 계속 부르기"(keepCalling): 보통 멘션 연쇄(오케스트레이션이 건드리지 않는 경로)의 상한을 푼다.
// 시나리오 번호는 docs/design/AGORA_REVISION_2026-10-11_ORCHESTRATOR.md §(14)의 O20~O23을 따른다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { settle, makeRoom, ids } = require("./reply-now-helpers.cjs");

test("O20 keepCalling 꺼짐(기본): 연쇄 깊이 상한(2)에서 멈추고, 걸러진 호출에 안내 한 줄이 붙는다", async () => {
  const { room, calls, systems } = makeRoom({ ids: ["claude", "codex"] });
  room.sendUserMessage("@claude 시작해");
  await settle();
  calls[0].finish("@codex 어때?"); // depth 0 -> codex(depth1)로 호출(지금과 같다)
  await settle();
  calls[1].finish("@claude 다시?"); // depth 1 -> claude(depth2)까지는 지금처럼 호출된다
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude"]);
  calls[2].finish("@codex 한 번 더?"); // depth 2 >= 상한(2) -> 여기서 멈춘다(지금과 같다)
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude"], "네 번째 호출은 만들어지지 않는다");
  assert.ok(systems.some((text) => /@codex 호출이 전달 상한\(2\)에 걸려 전달되지 않았습니다/.test(text)), "지금은 조용히 버려지던 것이 안내로 바뀐다");
  assert.ok(systems.some((text) => /AI끼리 계속 부르기/.test(text)));
});

test("O21 keepCalling 켬: ping-pong이 합계 상한(주입한 3)에서 멈추고 한 줄만 안내한다", async () => {
  const { room, calls, systems } = makeRoom({ ids: ["claude", "codex"], keepCallingCeiling: 3, meta: { keepCalling: true } });
  room.sendUserMessage("@claude 시작해");
  await settle();
  // claude -> codex -> claude -> codex -> (4번째에서 상한 3 도달 후 멈춤)
  calls[0].finish("@codex 1");
  await settle();
  calls[1].finish("@claude 2");
  await settle();
  calls[2].finish("@codex 3");
  await settle();
  calls[3].finish("@claude 4");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "claude", "codex"], "상한에 닿은 뒤로는 더 호출이 생기지 않는다");
  const notices = systems.filter((text) => /50번에 닿아 멈췄습니다|3번에 닿아 멈췄습니다/.test(text));
  assert.equal(notices.length, 1, "안내는 루트마다 한 번");
});

test("O22 keepCalling 켬: 갈래가 퍼져도(claude가 동시에 둘을 부름) 합계로 막는다", async () => {
  const { room, calls, systems } = makeRoom({ ids: ["claude", "codex", "agy"], keepCallingCeiling: 2, meta: { keepCalling: true } });
  room.sendUserMessage("@claude 시작해");
  await settle();
  // 멘션 호출은 보통 멘션 연쇄라 일반 줄(메인 줄)에 서고, 한 번에 하나씩 돈다(오케스트레이션의
  // 작업자 묶음과 다르다). 둘 다 호출은 생기지만(카운트 0→1, 1→2로 둘 다 상한 2 미만에서 통과) 시작은 순서대로다.
  calls[0].finish("@codex @agy 둘 다 해줘");
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex"], "codex가 먼저 선다(메인 줄은 한 번에 하나)");
  calls[1].finish("@claude 더?"); // depth1, 합계(2)가 이미 상한(2)에 닿아 막힌다 + 안내
  await settle();
  assert.deepEqual(ids(calls), ["claude", "codex", "agy"], "codex가 끝나면 이미 서 있던 agy가 이어서 선다(새 호출이 아니다)");
  calls[2].finish("@claude 또?"); // depth1, 이미 상한이라 또 막힌다(안내는 루트마다 한 번만)
  await settle();
  assert.equal(calls.length, 3, "합계 상한에 닿아 추가 호출이 없다");
  const notices = systems.filter((text) => /자동 호출이 2번에 닿아 멈췄습니다/.test(text));
  assert.equal(notices.length, 1, "안내는 루트마다 한 번");
});

test("O23 오케스트레이터 켜짐이면서 keepCalling도 켜짐: 지휘 AI→작업자 호출에는 keepCalling 카운터·안내가 끼어들지 않는다", async () => {
  const { room, calls, systems } = makeRoom({
    ids: ["claude", "codex", "agy"],
    keepCallingCeiling: 1,
    meta: { keepCalling: true, orchestrator: { enabled: true, leadId: "claude" } },
  });
  room.sendUserMessage("claude에게 맡겨줘");
  await settle();
  calls[0].finish("@codex @agy 각자 해줘");
  await settle();
  assert.deepEqual(ids(calls).slice(1).sort(), ["agy", "codex"], "오케스트레이션 경로는 scheduleMentionReplies를 타지 않아 상한(1)의 영향이 없다");
  assert.ok(!systems.some((text) => /합니다|멈췄습니다/.test(text) && /자동 호출/.test(text)), "keepCalling 안내가 끼어들지 않는다");
});

test("체크는 오케스트레이터 모드와 무관하게 늘 켤 수 있다(화면 쪽 disabled 금지는 UI 책임, 방은 늘 반영한다)", async () => {
  const { room } = makeRoom({ meta: { orchestrator: { enabled: true, leadId: "claude" } } });
  room.setMeta({ keepCalling: true });
  assert.equal(room.meta.keepCalling, true);
});
