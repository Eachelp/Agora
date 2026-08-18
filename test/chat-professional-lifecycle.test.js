"use strict";

// Stage C — Session Invalidation / Lifecycle: 상위 control-plane seam.
//
// 검증 목표:
//   - ChatRoom(SpecialistMixin)이 canonical terminal transition에서만
//     harnessLifecycle.professionalRunEnded를 부른다(COMPLETED/INTERRUPTED/INVALID/
//     REPLAN_RESET; WAITING/BLOCKED류 비-terminal은 호출 없음).
//   - checkpoint restore 결과 소비: 성공/ambiguous 실패 → workspaceRestored,
//     mutation-전 실패(mutated:false) → 세션 유지(호출 없음).
//   - ChatRoom.respond가 canonical Frozen Task provenance(RUN-###+taskHash)를
//     runAgent에 전달한다(transport runId와 별개).
//   - chat-ipc: workspace choose/clear가 HarnessRuntime.workspaceChanged를 부르고,
//     chatFeature.notifyProviderAccountChanged가 providerAccountChanged로 위임된다.
//   - turn-checkpoint.restoreCheckpoint가 mutation 여부 fact(mutated)를 보고한다.
//   - account switcher들의 사전 검증 실패는 accountSwitchSafe로 표시된다
//     (credential 무변경 실패 → 불필요한 invalidation 금지의 근거 fact).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");
const turnCheckpoint = require("../src/agora/turn-checkpoint");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");
const { AntigravityAccountSwitcher } = require("../src/antigravity-account-switcher");
const { CodexAccountSwitcher } = require("../src/codex-account-switcher");

function makeAgents() {
  return [
    { id: "claude", name: "Claude", aliases: ["claude"], available: true, enabled: true },
  ];
}

function lifecycleSpy() {
  const events = [];
  return {
    events,
    hook: {
      workspaceRestored: () => events.push({ kind: "workspaceRestored" }),
      professionalRunEnded: (payload) => events.push({ kind: "professionalRunEnded", ...payload }),
    },
  };
}

function roomWith(run, spy, extra = {}) {
  return new ChatRoom({
    agents: makeAgents(),
    initialProfessionalRun: run,
    harnessLifecycle: spy.hook,
    ...extra,
  });
}

// ---- Professional Run terminal boundary ----

test("RECORDER_DONE(완료)은 run 종료를 정확히 한 번 알린다(invalid=false)", () => {
  const spy = lifecycleSpy();
  const room = roomWith({ professionalRunId: "pr-t1", node: "RECORDING", status: "WAITING", policy: {} }, spy);
  const t = room.transitionProfessional({ type: "USER_RETRY_RECORDER" });
  assert.equal(t.ok, true);
  assert.deepEqual(spy.events, [], "RUNNING 재개는 boundary가 아니다");
  const done = room.transitionProfessional({ type: "RECORDER_DONE" });
  assert.equal(done.ok, true);
  assert.deepEqual(spy.events, [
    { kind: "professionalRunEnded", professionalRunId: "pr-t1", invalid: false },
  ]);
});

test("INTERRUPT는 run 종료를 알리고, 반복 INTERRUPT는 재통지하지 않는다", () => {
  const spy = lifecycleSpy();
  const room = roomWith({ professionalRunId: "pr-t2", node: "IMPLEMENTING", status: "WAITING", policy: {} }, spy);
  room.transitionProfessional({ type: "INTERRUPT", stopReason: "USER_INTERRUPTED" });
  room.transitionProfessional({ type: "INTERRUPT", stopReason: "BLOCK_RESOLVED" });
  assert.equal(spy.events.filter((e) => e.kind === "professionalRunEnded").length, 1);
  assert.equal(spy.events[0].invalid, false);
});

test("INVALIDATE(FROZEN_TASK_CORRUPTED)는 invalid=true로 알린다", () => {
  const spy = lifecycleSpy();
  const room = roomWith({ professionalRunId: "pr-t3", node: "IMPLEMENTING", status: "WAITING", policy: {} }, spy);
  room.transitionProfessional({ type: "INVALIDATE", stopReason: "FROZEN_TASK_CORRUPTED" });
  assert.deepEqual(spy.events, [
    { kind: "professionalRunEnded", professionalRunId: "pr-t3", invalid: true },
  ]);
});

test("REPLAN_RESET은 기존 실행 lineage 폐기로서 run 종료를 알린다", () => {
  const spy = lifecycleSpy();
  const room = roomWith({ professionalRunId: "pr-t4", node: "IMPLEMENTING", status: "BLOCKED", policy: {} }, spy);
  room.transitionProfessional({ type: "REPLAN_RESET", carriedFromRunId: "RUN-001" });
  assert.deepEqual(spy.events, [
    { kind: "professionalRunEnded", professionalRunId: "pr-t4", invalid: false },
  ]);
});

test("비-terminal 전이(PLAN_READY/WAITING류)는 lifecycle을 부르지 않는다", () => {
  const spy = lifecycleSpy();
  const room = roomWith({ professionalRunId: "pr-t5", node: "PLANNING", status: "WAITING", policy: {} }, spy);
  room.transitionProfessional({ type: "USER_ANSWER_PLAN" });
  room.transitionProfessional({ type: "PLANNER_PLAN_READY", taskPath: "t.md" });
  room.transitionProfessional({ type: "PLAN_REVIEW_UNKNOWN" });
  assert.deepEqual(spy.events, []);
});

test("앱 재시작 rehydration(RUNNING→INTERRUPTED 정리)은 lifecycle 통지를 만들지 않는다(registry는 memory-only)", () => {
  const spy = lifecycleSpy();
  const persisted = [];
  const room = roomWith(
    { professionalRunId: "pr-t6", node: "IMPLEMENTING", status: "RUNNING", policy: {} },
    spy,
    { persistProfessionalRun: (run) => { persisted.push(run); return true; } }
  );
  assert.equal(room.professionalRun.status, "INTERRUPTED");
  assert.deepEqual(spy.events, []);
});

// ---- checkpoint restore 소비 seam ----

test("notifyWorkspaceRestoreOutcome: 성공/ambiguous 실패는 INVALIDATE, mutation-전 실패는 세션 유지", () => {
  const spy = lifecycleSpy();
  const room = roomWith(null, spy);
  room.notifyWorkspaceRestoreOutcome({ ok: true });
  assert.equal(spy.events.length, 1, "성공한 restore는 반드시 통지");
  room.notifyWorkspaceRestoreOutcome({ ok: false, mutated: false });
  assert.equal(spy.events.length, 1, "mutation 전 실패는 통지하지 않는다(세션 유지)");
  room.notifyWorkspaceRestoreOutcome({ ok: false, mutated: true });
  assert.equal(spy.events.length, 2, "partial/ambiguous 실패는 conservative 통지");
  room.notifyWorkspaceRestoreOutcome({ ok: false });
  assert.equal(spy.events.length, 3, "mutated fact가 없는 실패도 보수적으로 통지");
  // hook 미주입이면 안전한 no-op이다.
  const bare = new ChatRoom({ agents: makeAgents() });
  bare.notifyWorkspaceRestoreOutcome({ ok: true });
});

// ---- respond → runAgent canonical Frozen provenance ----

test("respond는 frozenTask(RUN-### + taskHash)를 runAgent에 전달한다(transport runId와 별개)", async () => {
  const calls = [];
  const room = new ChatRoom({
    agents: makeAgents(),
    runAgent: (args) => {
      calls.push(args);
      return { promise: Promise.resolve({ ok: true, text: "done" }), cancel: () => {} };
    },
  });
  await room.respond(room.findAgent("claude"), {
    specialist: {
      stage: "implementation",
      frozenTask: { runId: "RUN-003", taskHash: "hash-abc", taskId: "TASK-001", content: "..." },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].frozenTask, { runId: "RUN-003", taskHash: "hash-abc" });
  assert.match(String(calls[0].runId), /^r/, "transport runId는 여전히 별도 필드");

  // 비전문/frozen 없음 → frozenTask는 null.
  await room.respond(room.findAgent("claude"), {});
  assert.equal(calls[1].frozenTask, null);
});

// ---- chat-ipc: workspace change / provider account seam ----

function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "",
    commandPath: null, needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "",
    installUrl: null, loginCommand: null,
  };
}

function fakeCapabilities() {
  const records = [fakeRecord("claude")];
  return {
    defs: records.map((record) => ({ id: record.id })),
    getRecord: (id) => records.find((record) => record.id === id) || null,
    discover: async () => records,
  };
}

function runtimeSpy() {
  const events = [];
  return {
    events,
    runtime: {
      runTurn: () => ({ promise: Promise.resolve({ ok: true }), cancel: () => {} }),
      workspaceChanged: (p) => events.push({ kind: "workspaceChanged", ...p }),
      workspaceRestored: (p) => events.push({ kind: "workspaceRestored", ...p }),
      providerAccountChanged: (p) => events.push({ kind: "providerAccountChanged", ...p }),
      professionalRunEnded: (p) => events.push({ kind: "professionalRunEnded", ...p }),
      close: () => events.push({ kind: "close" }),
    },
  };
}

function makeFeature(root, dialogResult) {
  const handlers = new Map();
  const spy = runtimeSpy();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return dialogResult; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(),
    harnessRuntime: spy.runtime,
  });
  feature.registerIpcHandlers();
  return {
    feature,
    spy,
    invoke: async (channel, input = {}) => handlers.get(channel)({}, input),
  };
}

test("chat-ipc: project workspace choose/clear는 WORKSPACE_CHANGED lifecycle을 부른다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-ipc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-ws-")));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { spy, invoke } = makeFeature(root, { canceled: false, filePaths: [ws] });
  const created = await invoke("chat:projects:create", { name: "P" });
  assert.equal(created.ok, true);
  const projectId = created.activeProjectId;

  const chosen = await invoke("chat:projects:workspace:choose", { projectId });
  assert.equal(chosen.ok, true);
  assert.deepEqual(spy.events, [{ kind: "workspaceChanged", projectId }]);

  const cleared = await invoke("chat:projects:workspace:clear", { projectId });
  assert.equal(cleared.ok, true);
  assert.deepEqual(spy.events.at(-1), { kind: "workspaceChanged", projectId });
  assert.equal(spy.events.length, 2);
});

test("chatFeature.notifyProviderAccountChanged는 provider account lifecycle로 위임한다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-acct-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { feature, spy } = makeFeature(root, { canceled: true, filePaths: [] });
  assert.equal(typeof feature.notifyProviderAccountChanged, "function");
  feature.notifyProviderAccountChanged("codex");
  assert.deepEqual(spy.events, [{ kind: "providerAccountChanged", providerId: "codex" }]);
  feature.notifyProviderAccountChanged(null);
  assert.equal(spy.events.length, 1, "provider 없는 호출은 무시");
});

test("chat-ipc source: 전문 turn provenance는 canonical frozenTask + gitHead fact이며 transport runId가 아니다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  assert.match(source, /require\("\.\.\/harness\/harness-session-lifecycle"\)/);
  assert.match(source, /frozenRunId: specialistStage \? \(frozenTask\?\.runId \|\| null\) : null/);
  assert.match(source, /taskHash: specialistStage \? \(frozenTask\?\.taskHash \|\| null\) : null/);
  assert.match(source, /probeGitHead\(canonicalWorkspace\)/);
  assert.doesNotMatch(source, /frozenRunId: specialistStage \? \(runId \|\| null\) : null/);
});

test("account-switching source: 전환 성공/ambiguous 실패 경로가 lifecycle seam을 부른다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "agora", "account-switching.js"), "utf8");
  assert.match(source, /function notifyAccountLifecycle\(provider\)/);
  assert.match(source, /notifyProviderAccountChanged/);
  // Codex 두 경로 + 프록시 auto-switch + Claude/AGY 공용 경로.
  const successCalls = source.match(/notifyAccountLifecycle\("codex"\)/g) || [];
  assert.ok(successCalls.length >= 3, "codex proxy/desktop/auto-switch 경로");
  assert.match(source, /notifyAccountLifecycle\(provider\)/);
  assert.match(source, /isCredentialUnchangedFailure/);
});

// ---- turn-checkpoint restore mutated fact ----

function gitInit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, windowsHide: true });
}

test("restoreCheckpoint: mutation 전에 끝난 실패는 mutated:false, 성공은 ok:true", async (t) => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-restore-fact-")));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  gitInit(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "v1", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["commit", "-qm", "c1"], { cwd: repo, windowsHide: true });

  const storageRoot = path.join(repo, ".agora", "checkpoints");
  const checkpoint = await turnCheckpoint.createCheckpoint(repo, { storageRoot, sessionId: "s1", runId: "RUN-001" });
  assert.equal(checkpoint.supported, true);

  // (1) invalid checkpoint descriptor: resolve 단계 실패 → 무변경 fact.
  const invalid = await turnCheckpoint.restoreCheckpoint(repo, { supported: true, checkpointId: "cp-none", storageRoot });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.mutated, false);

  // (2) workspace mismatch: mutation 전 명확 종료 → 무변경 fact.
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-restore-other-")));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  gitInit(other);
  const mismatch = await turnCheckpoint.restoreCheckpoint(other, checkpoint);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.mutated, false);

  // (3) 실제 변경 후 성공 restore.
  fs.writeFileSync(path.join(repo, "a.txt"), "changed-by-builder", "utf8");
  const restored = await turnCheckpoint.restoreCheckpoint(repo, checkpoint);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "v1");
});

// ---- account switcher 사전 검증 실패 fact ----

test("Claude/AGY/Codex switcher의 사전 검증 실패는 accountSwitchSafe=true를 표시한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agora-switch-safe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claude = new ClaudeAccountSwitcher({ home });
  await assert.rejects(
    () => claude.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "Claude 검증 실패는 credential 무변경 fact");
      return true;
    }
  );

  const agy = new AntigravityAccountSwitcher({
    home,
    read: async () => null,
    write: async () => {},
    clear: async () => {},
    restart: async () => {},
  });
  await assert.rejects(
    () => agy.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "AGY 검증 실패는 credential 무변경 fact");
      return true;
    }
  );

  const codex = new CodexAccountSwitcher({ homeDir: home });
  assert.throws(
    () => codex.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "Codex 검증 실패는 credential 무변경 fact");
      return true;
    }
  );
});
