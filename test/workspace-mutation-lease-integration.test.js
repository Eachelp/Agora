"use strict";

// Stage D-0 — Workspace Mutation Lease control-plane seam.
//
// 검증 목표: workspace-write 일반 채팅 turn은 같은 canonical workspace를 공유하는
// 서로 다른 대화(room)와 동시에 변경하지 못하고, 충돌은 대기가 아니라 fail-closed다.
// (전문 실행과 checkpoint 복원 참여자는 D48에서 그 기능과 함께 지웠다.)
//
// 함께 검증:
//   - 같은 room의 재진입은 parentToken으로 증명한 중첩만 허용된다.
//   - 소유권은 실행이 끝나면 반드시 반납된다(실패·예외 경로 포함).
//   - workspace가 없거나 lease가 주입되지 않은 실행의 기존 동작은 그대로다.
//   - 서로 다른 workspace를 쓰는 대화는 서로 막지 않는다.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { ChatRoom } = require("../src/chat/chat-room");
const { WorkspaceMutationLease } = require("../src/agora/workspace-mutation-lease");

const WS = path.resolve("/ws/shared");

function makeAgents() {
  return [{ id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true }];
}

// 실행이 시작된 사실을 알리고, 테스트가 원할 때까지 턴을 붙잡아 두는 runAgent.
function gatedRunAgent() {
  const started = [];
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release: () => release({ ok: true, text: "done" }),
    runAgent: (args) => {
      started.push(args);
      return { promise: gate, cancel: () => {} };
    },
  };
}

function roomWith({ sessionId, lease, workspace = WS, permissionMode = "workspace-write", runAgent, checkpoint }) {
  return new ChatRoom({
    sessionId,
    agents: makeAgents(),
    mutationLease: lease,
    meta: { workspace, permissionMode },
    runAgent: runAgent || ((args) => ({ promise: Promise.resolve({ ok: true, text: "done" }), cancel: () => {} })),
    ...(checkpoint ? { checkpoint } : {}),
  });
}

// ---- workspace-write 일반 채팅 turn ----

test("같은 workspace를 쓰는 다른 대화의 write turn은 fail-closed로 막힌다", async () => {
  const lease = new WorkspaceMutationLease();
  const gate = gatedRunAgent();
  const roomA = roomWith({ sessionId: "s-a", lease, runAgent: gate.runAgent });
  const roomB = roomWith({ sessionId: "s-b", lease });

  const turnA = roomA.respond(roomA.findAgent("claude"), {});
  // A의 턴이 실제로 시작되어 소유권을 쥔 상태를 만든다.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.started.length, 1, "A의 turn이 시작되어야 한다");

  const resultB = await roomB.respond(roomB.findAgent("claude"), {});
  assert.equal(resultB.ok, false);
  assert.equal(resultB.stopReason, "WORKSPACE_BUSY");
  // 사용자에게는 내부 어휘 없이 이유가 보여야 한다(Charter §9).
  assert.match(resultB.error, /다른 대화가 변경/);
  assert.ok(!/lease|holder|resourceId/i.test(resultB.error), "내부 어휘 노출 금지");

  gate.release();
  await turnA;

  // A가 끝나면 B는 정상적으로 실행된다(대기열이 아니라 재시도 계약).
  const retryB = await roomB.respond(roomB.findAgent("claude"), {});
  assert.equal(retryB.ok, true);
});

test("turn이 끝나면 소유권을 반납한다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  await room.respond(room.findAgent("claude"), {});
  assert.equal(lease.isHeld(WS), false);
});

test("turn이 예외로 끝나도 소유권이 남지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({
    sessionId: "s-a",
    lease,
    runAgent: () => {
      throw new Error("harness 폭발");
    },
  });
  await room.respond(room.findAgent("claude"), {}).catch(() => {});
  assert.equal(lease.isHeld(WS), false, "실패 경로에서도 반납되어야 한다");
});

test("chat/workspace-read 권한의 일반 turn은 mutation 참여자가 아니다", async () => {
  const lease = new WorkspaceMutationLease();
  const gate = gatedRunAgent();
  const reader = roomWith({ sessionId: "s-a", lease, permissionMode: "workspace-read", runAgent: gate.runAgent });
  const writer = roomWith({ sessionId: "s-b", lease });

  const readTurn = reader.respond(reader.findAgent("claude"), {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.started.length, 1);

  // 읽기 실행은 소유권을 잡지 않으므로 다른 대화의 write를 막지 않는다.
  assert.equal(lease.isHeld(WS), false);
  const write = await writer.respond(writer.findAgent("claude"), {});
  assert.equal(write.ok, true);

  gate.release();
  await readTurn;
});

test("서로 다른 workspace를 쓰는 대화는 서로 막지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const gate = gatedRunAgent();
  const roomA = roomWith({ sessionId: "s-a", lease, runAgent: gate.runAgent });
  const roomB = roomWith({ sessionId: "s-b", lease, workspace: path.resolve("/ws/other") });

  const turnA = roomA.respond(roomA.findAgent("claude"), {});
  await new Promise((resolve) => setImmediate(resolve));
  const resultB = await roomB.respond(roomB.findAgent("claude"), {});
  assert.equal(resultB.ok, true);

  gate.release();
  await turnA;
});

test("lease가 주입되지 않았거나 workspace가 없으면 기존 동작을 유지한다", async () => {
  const noLease = roomWith({ sessionId: "s-a", lease: null });
  assert.equal((await noLease.respond(noLease.findAgent("claude"), {})).ok, true);

  const lease = new WorkspaceMutationLease();
  const noWorkspace = roomWith({ sessionId: "s-b", lease, workspace: null });
  assert.equal((await noWorkspace.respond(noWorkspace.findAgent("claude"), {})).ok, true);
  assert.equal(lease.list().length, 0);
});

test("블록 안의 중첩 작업은 parentToken으로 재진입한다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  const outer = room.acquireWorkspaceMutation({ purpose: "chat-turn-group" });
  let nested = null;
  nested = room.acquireWorkspaceMutation({ purpose: "checkpoint-restore", parentToken: outer.token });
  assert.equal(nested.ok, true, "증명된 중첩은 허용된다");
  assert.equal(nested.reentered, true);
  room.releaseWorkspaceMutation(nested.token);
  assert.equal(lease.isHeld(WS), true, "안쪽만 놓으면 소유권은 유지된다");
  room.releaseWorkspaceMutation(outer.token);
  assert.equal(lease.isHeld(WS), false);
});

// ---- 정리 경로 ----

test("실행이 없는 방의 정리는 소유권을 해제해 다른 대화를 막지 않는다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.acquireWorkspaceMutation({ purpose: "chat-turn-group" });
  assert.equal(lease.isHeld(WS), true);

  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 1);
  assert.equal(lease.isHeld(WS), false);

  const other = roomWith({ sessionId: "s-b", lease });
  assert.equal(other.acquireWorkspaceMutation({ purpose: "chat-turn" }).ok, true);
});

// B2 회귀: 중지는 subprocess 종료를 기다려 주지 않는다. 아직 쓰고 있을 수 있는
// writer의 소유권을 정리 편의로 풀면 다른 대화가 그 틈에 들어온다.
test("실행이 남아 있는 방의 정리는 소유권을 풀지 않는다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.acquireWorkspaceMutation({ purpose: "chat-turn-group" });

  room.trackRunStart(); // subprocess가 아직 살아 있는 상태
  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 0, "실행 중에는 풀면 안 된다");
  assert.equal(lease.isHeld(WS), true);

  const other = roomWith({ sessionId: "s-b", lease });
  assert.equal(other.acquireWorkspaceMutation({ purpose: "chat-turn" }).ok, false);

  room.trackRunEnd();
  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 1);
});
