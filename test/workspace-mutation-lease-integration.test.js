"use strict";

// Stage D-0 — Workspace Mutation Lease control-plane seam.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md D-0 참여자 3종):
//   1. Professional 실행의 mutation~판정 구간
//   2. Checkpoint restore
//   3. workspace-write 일반 채팅 turn
//   → 같은 canonical workspace를 공유하는 서로 다른 대화(room)가 동시에 변경하지
//     못하고, 충돌은 대기가 아니라 fail-closed다.
//
// 함께 검증:
//   - 같은 room의 재진입(전문 실행 중 restore)이 교착되지 않는다.
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

// ---- 참여자 3: workspace-write 일반 채팅 turn ----

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

// ---- 참여자 1: Professional 실행 블록 ----

test("전문 실행 블록은 다른 대화가 workspace를 쥐고 있으면 시작하지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const holder = new ChatRoom({ sessionId: "s-other", agents: makeAgents(), mutationLease: lease, meta: { workspace: WS } });
  const held = holder.acquireWorkspaceMutation({ purpose: "professional-execution" });
  assert.equal(held.ok, true);

  const room = roomWith({ sessionId: "s-a", lease });
  const systemMessages = [];
  room.appendSystem = (text) => systemMessages.push(text);
  let innerCalls = 0;
  room.runExecutionBlockInner = async () => {
    innerCalls += 1;
    return { ok: true };
  };

  const result = await room.runExecutionBlock({ stages: {}, mode: "step" });
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "WORKSPACE_BUSY");
  assert.equal(innerCalls, 0, "블록 본문이 시작되면 안 된다");
  assert.equal(systemMessages.length, 1, "사용자에게 이유를 알려야 한다");
});

test("전문 실행 블록은 실행 동안 소유권을 쥐고 끝나면 반납한다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  let heldDuringBlock = null;
  let holderDuringBlock = null;
  room.runExecutionBlockInner = async () => {
    heldDuringBlock = lease.isHeld(WS);
    holderDuringBlock = lease.holderOf(WS);
    return { ok: true };
  };

  const result = await room.runExecutionBlock({ stages: {}, mode: "step", resumedRun: { runId: "RUN-007" } });
  assert.equal(result.ok, true);
  assert.equal(heldDuringBlock, true);
  assert.equal(holderDuringBlock.holderId, "s-a");
  assert.equal(holderDuringBlock.runId, "RUN-007", "Run 계보가 소유권 기록에 남는다");
  assert.equal(lease.isHeld(WS), false, "블록이 끝나면 반납");
});

test("전문 실행 블록이 예외로 끝나도 소유권이 남지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.runExecutionBlockInner = async () => {
    throw new Error("builder 폭발");
  };
  await assert.rejects(() => room.runExecutionBlock({ stages: {}, mode: "step" }));
  assert.equal(lease.isHeld(WS), false);
});

test("전문 실행 중 같은 방의 checkpoint restore는 교착되지 않는다(재진입)", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  let nested = null;
  room.runExecutionBlockInner = async () => {
    // 블록 안에서 restore 경로가 다시 소유권을 요청하는 상황.
    nested = room.acquireWorkspaceMutation({ purpose: "checkpoint-restore" });
    if (nested.ok) room.releaseWorkspaceMutation(nested.token);
    return { ok: true };
  };
  await room.runExecutionBlock({ stages: {}, mode: "step" });
  assert.equal(nested.ok, true, "같은 holder의 재진입은 허용된다");
  assert.equal(nested.reentered, true);
  assert.equal(lease.isHeld(WS), false);
});

// ---- 참여자 2: checkpoint restore ----

test("다른 대화가 workspace를 쥐고 있으면 BLOCKED 복원을 하지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const holder = new ChatRoom({ sessionId: "s-other", agents: makeAgents(), mutationLease: lease, meta: { workspace: WS } });
  holder.acquireWorkspaceMutation({ purpose: "professional-execution" });

  let restoreCalls = 0;
  const room = roomWith({
    sessionId: "s-a",
    lease,
    checkpoint: {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-x" }),
      restoreCheckpoint: async () => {
        restoreCalls += 1;
        return { ok: true, mutated: true };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });
  room.specialistBlocked = {
    runId: "RUN-009",
    canRestore: true,
    checkpoint: { supported: true, checkpointId: "cp-x" },
    taskPath: null,
    blockReason: "BLOCKED",
  };

  const result = await room.resolveBlocked("restore");
  assert.equal(result.ok, false);
  assert.match(result.error, /다른 대화가 변경/);
  assert.equal(restoreCalls, 0, "복원이 실행되면 다른 대화의 작업까지 지워진다");
});

test("소유권을 얻을 수 있으면 복원은 정상 수행되고 소유권을 반납한다", async () => {
  const lease = new WorkspaceMutationLease();
  let restoreCalls = 0;
  const room = roomWith({
    sessionId: "s-a",
    lease,
    checkpoint: {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-x" }),
      restoreCheckpoint: async () => {
        restoreCalls += 1;
        // 복원이 도는 동안에는 소유권이 잡혀 있어야 한다.
        assert.equal(lease.holderOf(WS).holderId, "s-a");
        return { ok: true, mutated: true };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });
  room.specialistBlocked = {
    runId: "RUN-010",
    canRestore: true,
    checkpoint: { supported: true, checkpointId: "cp-x" },
    taskPath: null,
    blockReason: "BLOCKED",
  };

  await room.resolveBlocked("restore");
  assert.equal(restoreCalls, 1);
  assert.equal(lease.isHeld(WS), false, "복원 후 반납");
});

test("복원이 실패해도 소유권이 남지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({
    sessionId: "s-a",
    lease,
    checkpoint: {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-x" }),
      restoreCheckpoint: async () => {
        throw new Error("restore 폭발");
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });
  room.specialistBlocked = {
    runId: "RUN-011",
    canRestore: true,
    checkpoint: { supported: true, checkpointId: "cp-x" },
    taskPath: null,
    blockReason: "BLOCKED",
  };

  await room.resolveBlocked("restore").catch(() => {});
  assert.equal(lease.isHeld(WS), false);
});

// ---- 정리 경로 ----

test("세션 정리는 남은 소유권을 해제해 다른 대화를 영구히 막지 않는다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.acquireWorkspaceMutation({ purpose: "professional-execution" });
  assert.equal(lease.isHeld(WS), true);

  assert.equal(room.releaseAllWorkspaceMutations(), 1);
  assert.equal(lease.isHeld(WS), false);

  const other = roomWith({ sessionId: "s-b", lease });
  assert.equal(other.acquireWorkspaceMutation({ purpose: "chat-turn" }).ok, true);
});
