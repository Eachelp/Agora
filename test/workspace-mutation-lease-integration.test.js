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

test("블록 안의 중첩 작업은 parentToken으로 재진입한다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  const outer = room.acquireWorkspaceMutation({ purpose: "professional-execution" });
  let nested = null;
  nested = room.acquireWorkspaceMutation({ purpose: "checkpoint-restore", parentToken: outer.token });
  assert.equal(nested.ok, true, "증명된 중첩은 허용된다");
  assert.equal(nested.reentered, true);
  room.releaseWorkspaceMutation(nested.token);
  assert.equal(lease.isHeld(WS), true, "안쪽만 놓으면 소유권은 유지된다");
  room.releaseWorkspaceMutation(outer.token);
  assert.equal(lease.isHeld(WS), false);
});

// B3 회귀: 같은 방이라는 이유만으로 재진입을 허용하면, restore IPC가 두 번
// 들어오는 것만으로 복원이 동시에 두 번 돈다. renderer가 버튼을 막더라도
// control plane이 스스로 막아야 한다.
test("같은 방의 restore가 동시에 두 번 들어오면 두 번째는 거부된다", async () => {
  const lease = new WorkspaceMutationLease();
  let inFlight = 0;
  let maxConcurrent = 0;
  let releaseRestore = null;
  const restoreGate = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  const room = roomWith({
    sessionId: "s-a",
    lease,
    checkpoint: {
      createCheckpoint: async () => ({ supported: true, checkpointId: "cp-x" }),
      restoreCheckpoint: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await restoreGate;
        inFlight -= 1;
        return { ok: true, mutated: true };
      },
      cleanupCheckpoint: () => ({ ok: true }),
    },
  });
  const blocked = {
    runId: "RUN-012",
    canRestore: true,
    checkpoint: { supported: true, checkpointId: "cp-x" },
    taskPath: null,
    blockReason: "BLOCKED",
  };
  room.specialistBlocked = blocked;

  const first = room.resolveBlocked("restore");
  await new Promise((resolve) => setImmediate(resolve));
  // 실제 IPC는 직렬화되지 않으므로 두 번째 호출이 그대로 들어올 수 있다.
  room.specialistBlocked = blocked;
  const second = await room.resolveBlocked("restore");

  assert.equal(second.ok, false, "두 번째 복원이 통과하면 안 된다");
  assert.match(second.error, /이미 작업 폴더를 변경/);

  releaseRestore();
  await first;
  assert.equal(maxConcurrent, 1, "복원이 동시에 두 번 실행되면 안 된다");
  assert.equal(lease.isHeld(WS), false);
});

// B1 회귀: step 모드는 runExecutionBlock을 타지 않고 별도 경로에서 freeze·
// checkpoint 생성·Builder 실행을 한다. wrapper가 아니라 실제 진입점
// (resumeSpecialist → step 분기)을 타고 소유권이 걸리는지 확인한다.

function stepModeRoom({ sessionId, lease }) {
  const room = roomWith({ sessionId, lease });
  room.specialistResume = {
    mode: "step",
    phase: "plan_ready",
    stages: {},
    taskInfo: null,
    feedback: "",
    maxAutoRevisions: 0,
  };
  return room;
}

test("step 전문 실행은 다른 대화가 workspace를 쥐고 있으면 시작하지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const holder = new ChatRoom({ sessionId: "s-other", agents: makeAgents(), mutationLease: lease, meta: { workspace: WS } });
  holder.acquireWorkspaceMutation({ purpose: "chat-turn" });

  const room = stepModeRoom({ sessionId: "s-a", lease });
  let innerCalls = 0;
  room.resumeStepPhaseInner = async () => {
    innerCalls += 1;
    return { ok: true };
  };

  const result = await room.resumeSpecialist();
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "WORKSPACE_BUSY");
  assert.equal(innerCalls, 0, "freeze/checkpoint/Builder가 시작되면 안 된다");
});

test("step 전문 실행은 실행 동안 소유권을 쥐고 끝나면 반납한다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = stepModeRoom({ sessionId: "s-a", lease });
  let holderDuringPhase = null;
  room.resumeStepPhaseInner = async () => {
    holderDuringPhase = lease.holderOf(WS);
    return { ok: true };
  };

  await room.resumeSpecialist();
  assert.equal(holderDuringPhase?.holderId, "s-a");
  assert.equal(holderDuringPhase?.purpose, "professional-step");
  assert.equal(lease.isHeld(WS), false, "phase가 끝나면 반납");
});

test("step 실행이 소유권을 쥔 동안 다른 대화의 write는 막힌다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = stepModeRoom({ sessionId: "s-a", lease });
  const other = roomWith({ sessionId: "s-b", lease });
  let otherResult = null;
  room.resumeStepPhaseInner = async () => {
    otherResult = await other.respond(other.findAgent("claude"), {});
    return { ok: true };
  };

  await room.resumeSpecialist();
  assert.equal(otherResult.ok, false);
  assert.equal(otherResult.stopReason, "WORKSPACE_BUSY");
});

test("step 실행이 실패해도 소유권이 남지 않는다", async () => {
  const lease = new WorkspaceMutationLease();
  const room = stepModeRoom({ sessionId: "s-a", lease });
  room.resumeStepPhaseInner = async () => {
    throw new Error("builder 폭발");
  };
  await room.resumeSpecialist().catch(() => {});
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

test("실행이 없는 방의 정리는 소유권을 해제해 다른 대화를 막지 않는다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.acquireWorkspaceMutation({ purpose: "professional-execution" });
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
  room.acquireWorkspaceMutation({ purpose: "professional-execution" });

  room.trackRunStart(); // subprocess가 아직 살아 있는 상태
  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 0, "실행 중에는 풀면 안 된다");
  assert.equal(lease.isHeld(WS), true);

  const other = roomWith({ sessionId: "s-b", lease });
  assert.equal(other.acquireWorkspaceMutation({ purpose: "chat-turn" }).ok, false);

  room.trackRunEnd();
  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 1);
});

test("전문 실행이 남아 있는 방의 정리도 소유권을 풀지 않는다", () => {
  const lease = new WorkspaceMutationLease();
  const room = roomWith({ sessionId: "s-a", lease });
  room.acquireWorkspaceMutation({ purpose: "professional-execution" });
  room.specialistActive = true;
  assert.equal(room.releaseWorkspaceMutationsIfIdle(), 0);
  assert.equal(lease.isHeld(WS), true);
});
