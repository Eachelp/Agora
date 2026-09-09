"use strict";

// 계정 로그인/전환 흐름의 hard native session boundary lifecycle.
//
// 정책: provider 계정 변경은 hard native session boundary다. 모든 세션이
// 무효화되며, 재개 가능한 세션은 없다. hard boundary는 credential mutation
// 이전에 설치된다: 경계가 먼저 inflight turn의 settle barrier를 세운 뒤에
// credential이 교체된다.
//
//   - AGY prepareLogin의 accountSwitchSafe 의미론: clear() 시작 전 실패만 live
//     credential 무변경 증명이고, clear가 시도된 이후의 모든 실패(재시작 실패 포함)는
//     partial mutation 가능성이 있으므로 accountSwitchSafe를 갖지 않는다.
//   - startProviderLogin("agy"): pre-mutation boundary 정확히 1회(성공/실패 무관).
//   - switchProviderAccount: pre-mutation boundary 정확히 1회.
//
// wiring 테스트는 실제 createAccountSwitching + 실제 prepareLogin 구현을 통과하며,
// live 파일시스템 접근은 임시 HOME 리다이렉트로 격리한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AntigravityAccountSwitcher } = require("../src/antigravity-account-switcher");
const { createAccountSwitching } = require("../src/agora/account-switching");
const { HarnessRuntime } = require("../src/harness/harness-runtime");
const { HarnessAdapter } = require("../src/harness/harness-adapter");

// ---- AGY prepareLogin의 accountSwitchSafe 의미론 (switcher 단위) ----

function makePrepSwitcher(t, over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agora-agy-prep-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const switcher = new AntigravityAccountSwitcher({
    home,
    store: {
      save: () => calls.push("save"),
      clearActive: () => calls.push("clearActive"),
      ...(over.store || {}),
    },
    read: over.read || (async () => ({ token: { refresh_token: "r1" } })),
    clear: over.clear || (async () => { calls.push("clear"); }),
    restart: over.restart || (async () => { calls.push("restart"); }),
  });
  return { switcher, calls };
}

test("prepareLogin 성공: 스냅샷 → clear → hint/active 정리 → restart 순서로 완료된다", async (t) => {
  const { switcher, calls } = makePrepSwitcher(t);
  assert.equal(await switcher.prepareLogin({ email: "a@b.c" }), true);
  assert.deepEqual(calls, ["save", "clear", "clearActive", "restart"]);
});

test("prepareLogin: clear 시작 전 실패(프로필 저장)는 accountSwitchSafe=true다", async (t) => {
  const { switcher, calls } = makePrepSwitcher(t, {
    store: { save: () => { throw new Error("프로필 저장 실패"); } },
  });
  await assert.rejects(
    () => switcher.prepareLogin({}),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "live credential 무변경 증명");
      return true;
    }
  );
  assert.ok(!calls.includes("clear"), "live mutation은 시작되지 않았다");
});

test("prepareLogin: clear 자체 실패는 partial mutation 가능성이 있으므로 accountSwitchSafe가 아니다", async (t) => {
  const { switcher } = makePrepSwitcher(t, {
    clear: async () => { throw new Error("credential 삭제 실패"); },
  });
  await assert.rejects(
    () => switcher.prepareLogin({}),
    (error) => {
      assert.notEqual(error.accountSwitchSafe, true, "clear가 시도된 이후에는 무변경을 증명할 수 없다");
      return true;
    }
  );
});

test("prepareLogin: clear 이후 restart 실패도 ambiguous/mutated이며 accountSwitchSafe가 아니다", async (t) => {
  const { switcher, calls } = makePrepSwitcher(t, {
    restart: async () => { throw new Error("AGY 재시작 실패"); },
  });
  await assert.rejects(
    () => switcher.prepareLogin({}),
    (error) => {
      assert.notEqual(error.accountSwitchSafe, true);
      return true;
    }
  );
  assert.ok(calls.includes("clear"), "live mutation이 이미 일어난 실패다");
});

// ---- startProviderLogin / switchProviderAccount wiring (실제 createAccountSwitching 경유) ----

function makeSwitching(t, { pathOverride, chatFeature } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-acct-home-")));
  const userData = path.join(home, "userData");
  fs.mkdirSync(userData, { recursive: true });
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  // 스위처 생성이 실제 계정 저장소 경로를 캡처하기 전에 HOME을 임시 폴더로 돌린다.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (pathOverride != null) process.env.PATH = pathOverride;
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.PATH = prev.PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const notifications = [];
  const desktopCalls = { stopped: 0, launched: 0 };
  const switching = createAccountSwitching({
    // 실제 Codex Desktop을 끄고 켜지 않는다. 이 seam이 없으면 npm test가
    // 사용자의 Codex 앱을 종료·재실행한다(테스트 부작용).
    codexDesktop: {
      stop: async () => { desktopCalls.stopped += 1; },
      launch: async () => { desktopCalls.launched += 1; return { skipped: true }; },
    },
    electron: {
      app: { getPath: () => userData },
      shell: { openPath: async () => "" },
    },
    openChatWindow: () => {},
    refreshTrayMenu: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    getChatFeature: () => chatFeature || ({
      // 전환 handle 계약을 지키는 최소 double: begin에 해당하는 통지 + complete().
      notifyProviderAccountChanged: async (provider) => {
        notifications.push({ provider });
        return { providerId: provider, token: `t-${provider}`, complete: () => true };
      },
      showSystemNotice: () => {},
    }),
  });
  return { switching, notifications, home, desktopCalls };
}

test("AGY prepareLogin 성공 → pre-mutation boundary 정확히 1회", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  const mutations = [];
  agy.clear = async () => mutations.push("clear");
  agy.restart = async () => mutations.push("restart");
  agy.store = { save: () => {}, clearActive: () => mutations.push("clearActive") };

  const result = await switching.startProviderLogin("agy");
  assert.equal(result, true);
  assert.deepEqual(mutations, ["clear", "clearActive", "restart"], "실제 prepareLogin 경로가 실행됐다");
  assert.deepEqual(notifications, [{ provider: "agy" }],
    "pre-mutation boundary는 정확히 1회 통지한다");
});

test("AGY: clear 이전 실패에도 pre-mutation boundary는 이미 설치되어 있다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  let reads = 0;
  agy.read = async () => {
    reads += 1;
    if (reads === 1) throw new Error("meta 수집 생략");
    return { token: { refresh_token: "r1" } };
  };
  let cleared = false;
  agy.clear = async () => { cleared = true; };
  agy.store = { save: () => { throw new Error("프로필 저장 실패"); }, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /프로필 저장 실패/);
  assert.equal(cleared, false, "live credential은 건드리지 않았다");
  assert.deepEqual(notifications, [{ provider: "agy" }],
    "pre-mutation boundary는 prepareLogin 호출 이전에 설치된다(보수적)");
});

test("AGY: clear 이후 restart 실패에도 pre-mutation boundary 정확히 1회", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  let cleared = false;
  agy.clear = async () => { cleared = true; };
  agy.restart = async () => { throw new Error("AGY 재시작 실패"); };
  agy.store = { save: () => {}, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /재시작 실패/);
  assert.equal(cleared, true, "mutation이 이미 시작된 실패다");
  assert.deepEqual(notifications, [{ provider: "agy" }],
    "pre-mutation boundary는 정확히 1회(경계는 mutation 이전에 설치)");
});

test("전환 성공(switchProviderAccount)은 pre-mutation boundary를 만든다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  const stored = { token: { refresh_token: "profile-secret" } };
  const saved = agy.store.save({ secret: stored, email: "a@b.c", active: false });
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.write = async () => {};
  agy.restart = async () => {};

  const result = await switching.switchProviderAccount("agy", saved.key);
  assert.equal(result, true);
  assert.deepEqual(notifications, [{ provider: "agy" }],
    "pre-mutation boundary는 credential mutation 이전에 정확히 1회");
});

// ---- BLOCKER 1: old inflight provider work가 실제로 settle된 뒤에만 credential mutation ----
//
// cancel()은 실제 child close보다 먼저 반환할 수 있다. barrier가 새 managed turn을
// 막는 것만으로는 "old Account A CLI가 아직 물리적으로 살아 있는데 live credential은
// 이미 Account B"인 창이 닫히지 않는다. 아래 테스트는 실제 호출 순서를 검증한다.

class PendingLifecycleAdapter extends HarnessAdapter {
  constructor(id = "fake-pending") {
    super({ id, supportsPersistentSession: true });
    this.pending = false;
    this.cancels = 0;
    this._resolvers = [];
  }
  runTurn({ session }) {
    if (this.pending) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this._resolvers.push(resolve);
      return { promise, cancel: () => { this.cancels += 1; } };
    }
    return { promise: Promise.resolve({ ok: true, session }), cancel: () => { this.cancels += 1; } };
  }
}

const sessionlessProcessAdapter = () => ({
  id: "process",
  supportsPersistentSession: false,
  runTurn: () => ({ promise: Promise.resolve({ ok: true, tag: "process" }), cancel: () => {} }),
});

const managedCtx = (over = {}) => ({
  projectId: "p1",
  workspaceId: "/ws/a",
  professionalRunId: "pr-1",
  role: "implementation",
  providerId: "agy",
  modelKey: "gemini-x",
  permissionMode: "workspace-write",
  ...over,
});
const MANAGED_INV = { commandPath: "agy", argv: [], prompt: "" };
const tick = () => new Promise((r) => setImmediate(r));

// 실제 chat-ipc seam과 같은 계약을 갖는 test double: begin을 await하고,
// mutation 확정 뒤 complete()로 전환 트랜잭션을 닫는 handle을 돌려준다.
function boundaryFeature(runtime, order = null) {
  return {
    notifyProviderAccountChanged: async (provider) => {
      if (order) order.push(`boundary:start:${provider}`);
      const opened = await runtime.beginProviderAccountBoundary({ providerId: provider });
      if (order) order.push(`boundary:settled:${provider}`);
      return {
        ...opened,
        complete: () => {
          if (order) order.push(`boundary:complete:${provider}`);
          return runtime.completeProviderAccountBoundary({
            providerId: provider,
            token: opened.token,
          });
        },
      };
    },
    showSystemNotice: () => {},
  };
}

test("BLOCKER1. 계정 전환은 old inflight turn이 실제 settle된 뒤에만 credential을 바꾼다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);

  const order = [];
  const { switching } = makeSwitching(t, {
    chatFeature: boundaryFeature(runtime, order),
  });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "profile-secret" } },
    email: "b@b.c",
    active: false,
  });
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.write = async () => { order.push("credential:write"); };
  agy.restart = async () => { order.push("provider:restart"); };

  // old Account A managed turn이 실행 중이고, 의도적으로 pending 상태로 남는다.
  adapter.pending = true;
  const oldTurn = runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV });
  const oldEntry = runtime.registry.entries()[0];
  assert.equal(oldEntry.inflight, true);

  const switchPromise = switching.switchProviderAccount("agy", saved.key);

  // cancel은 요청됐지만 native turn은 아직 살아 있다 → credential은 그대로여야 한다.
  await tick();
  await tick();
  assert.equal(adapter.cancels, 1, "boundary가 old turn을 cancel한다");
  assert.equal(oldEntry.inflight, true, "native turn은 아직 물리적으로 살아 있다");
  assert.deepEqual(order, ["boundary:start:agy"], "settle 전에는 credential을 건드리지 않는다");

  // old turn이 실제로 settle된다.
  for (const resolve of adapter._resolvers.splice(0)) resolve({ ok: false, cancelled: true });
  await oldTurn.promise;
  assert.equal(await switchPromise, true);

  assert.deepEqual(
    order,
    [
      "boundary:start:agy",
      "boundary:settled:agy",
      "credential:write",
      "provider:restart",
      "boundary:complete:agy",
    ],
    "boundary → 실제 settle → credential mutation → provider restart → 전환 종료 순서"
  );

  // 다음 Professional invocation은 fresh native continuity로 시작한다.
  adapter.pending = false;
  const fresh = await runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV }).promise;
  assert.equal(fresh.ok, true);
  assert.equal(fresh.session.generation, 2, "계정 전환 후 fresh native session");
});

test("BLOCKER1-b. settle 전에는 새 managed turn도 계속 BUSY로 막힌다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);
  const { switching } = makeSwitching(t, {
    chatFeature: boundaryFeature(runtime),
  });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "b@b.c", active: false,
  });
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => {};
  agy.restart = async () => {};

  adapter.pending = true;
  const oldTurn = runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV });
  const switchPromise = switching.switchProviderAccount("agy", saved.key);
  await tick();

  adapter.pending = false;
  const blocked = await runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV }).promise;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");

  for (const resolve of adapter._resolvers.splice(0)) resolve({ ok: false, cancelled: true });
  await oldTurn.promise;
  assert.equal(await switchPromise, true);
});

// ---- BLOCKER 2: hard boundary 실패는 fail-closed(credential 무변경 + 실패 보고) ----

function failingBoundaryFeature(message = "boundary 설치 실패") {
  return {
    notifyProviderAccountChanged: async () => { throw new Error(message); },
    showSystemNotice: () => {},
  };
}

test("BLOCKER2. boundary 설치 실패는 credential을 건드리지 않고 실패로 보고한다", async (t) => {
  const { switching } = makeSwitching(t, { chatFeature: failingBoundaryFeature() });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "profile-secret" } }, email: "a@b.c", active: false,
  });
  const touched = [];
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.write = async () => { touched.push("write"); };
  agy.clear = async () => { touched.push("clear"); };
  agy.restart = async () => { touched.push("restart"); };

  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    /boundary 설치 실패/,
    "boundary 실패는 log 후 성공으로 둔갑하면 안 된다"
  );
  assert.deepEqual(touched, [], "switchToProfile / write / clear가 호출되지 않는다");

  await assert.rejects(() => switching.startProviderLogin("agy"), /boundary 설치 실패/);
  assert.deepEqual(touched, [], "prepareLogin의 clear/restart도 호출되지 않는다");
});

test("BLOCKER2-b. boundary 실패 오류는 credential 무변경(accountSwitchSafe) fact를 갖는다", async (t) => {
  const { switching } = makeSwitching(t, { chatFeature: failingBoundaryFeature() });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  agy.read = async () => { throw new Error("none"); };
  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "boundary 실패 시점에는 credential 무변경이 증명된다");
      return true;
    }
  );
});

test("BLOCKER2-c. Codex 전환도 boundary 실패 시 auth를 바꾸지 않고 false를 돌려준다", async (t) => {
  const { switching } = makeSwitching(t, { chatFeature: failingBoundaryFeature() });
  let switched = 0;
  switching.codexAccountSwitcher.switchToProfile = () => { switched += 1; };

  const result = await switching.switchCodexAccount("some-profile");
  assert.equal(result, false, "boundary 실패는 전환 성공으로 보고되지 않는다");
  assert.equal(switched, 0, "auth.json 교체가 시도되지 않는다");
});

test("BLOCKER2-d. managed harness가 없는 구성은 명시적 immediately-safe 성공이다", async (t) => {
  // getChatFeature가 null(= managed runtime 없음)이면 무효화할 native session도,
  // 기다릴 inflight turn도 없다. 예외를 삼킨 결과가 아니라 명시적 안전 상태다.
  const { switching } = makeSwitching(t, { chatFeature: null });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  const touched = [];
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { touched.push("write"); };
  agy.restart = async () => { touched.push("restart"); };

  assert.equal(await switching.switchProviderAccount("agy", saved.key), true);
  assert.deepEqual(touched, ["write", "restart"]);
});

test("BLOCKER2-e. chat feature는 있는데 boundary seam이 없으면 wiring 결함으로 fail-closed한다", async (t) => {
  // "managed runtime 없음"으로 오분류해 통과시키면 fail-open이다.
  const { switching } = makeSwitching(t, { chatFeature: { showSystemNotice: () => {} } });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  const touched = [];
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { touched.push("write"); };
  agy.restart = async () => { touched.push("restart"); };

  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    /계정 세션 경계 seam이 없습니다/
  );
  assert.deepEqual(touched, [], "credential을 건드리지 않는다");
});

test("BLOCKER2-f. settle 상한 초과는 credential을 바꾸지 않고 실패로 보고한다", async (t) => {
  // old 실행이 끝났음을 증명하지 못하면 전환을 강행하지 않는다(fail-closed).
  const runtime = new HarnessRuntime({
    processAdapter: sessionlessProcessAdapter(),
    accountSettleTimeoutMs: 20,
  });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);

  const { switching } = makeSwitching(t, {
    chatFeature: boundaryFeature(runtime),
  });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  const touched = [];
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { touched.push("write"); };
  agy.clear = async () => { touched.push("clear"); };
  agy.restart = async () => { touched.push("restart"); };

  // cancel을 무시하고 계속 살아 있는 old turn.
  adapter.pending = true;
  const oldTurn = runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV });

  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    /계정 세션 경계를 확정하지 못했습니다/
  );
  assert.deepEqual(touched, [], "증명 실패 시 credential을 건드리지 않는다");

  for (const resolve of adapter._resolvers.splice(0)) resolve({ ok: false, cancelled: true });
  await oldTurn.promise;
});

// ---- BLOCKER3: 전환 트랜잭션이 끝날 때까지 managed admission이 닫혀 있어야 한다 ----
//
// old turn이 settle된 뒤에도 credential mutation 이전 async 구간이 실재한다:
//   switchToProfile → await snapshotCurrent() → await read() → await write()
//   prepareLogin    → await read()           → clear()
// 그 구간에 새 managed turn이 old credential로 시작하면 mutation을 살아서 넘어간다.

test("BLOCKER3. mutation 이전 async 구간(snapshotCurrent/read)에서도 새 managed turn은 BUSY다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "profile-secret" } }, email: "b@b.c", active: false,
  });

  // snapshotCurrent() 안의 read()에서 전환을 붙잡아 둔다 — write 직전 지점이다.
  let releaseRead;
  const held = new Promise((resolve) => { releaseRead = resolve; });
  let readEntered = false;
  const mutations = [];
  agy.read = async () => {
    readEntered = true;
    await held;
    return { token: { refresh_token: "live-a" } };
  };
  agy.write = async () => { mutations.push("write"); };
  agy.restart = async () => { mutations.push("restart"); };

  // 1~3. Account A managed turn inflight → 전환 시작 → cancel + settle 대기.
  adapter.pending = true;
  const oldTurn = runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV });
  const switchPromise = switching.switchProviderAccount("agy", saved.key);
  await tick();
  assert.equal(adapter.cancels, 1);

  // 4. old A turn을 settle시킨다.
  for (const resolve of adapter._resolvers.splice(0)) resolve({ ok: false, cancelled: true });
  await oldTurn.promise;

  // 5. AGY는 이제 credential write 이전 async 구간(read)에 붙잡혀 있다.
  await tick();
  await tick();
  assert.equal(readEntered, true, "mutation 이전 async 구간에 진입했다");
  assert.deepEqual(mutations, [], "아직 credential을 바꾸지 않았다");

  // 6. 이 구간에서 새 managed Professional turn 시도 → BUSY.
  adapter.pending = false;
  const adapterCallsBefore = adapter.cancels;
  const blocked = await runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV }).promise;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");
  assert.equal(blocked.evidence, undefined, "Evidence를 만들지 않는다");
  assert.equal(blocked.runMetrics, undefined, "RunMetrics를 만들지 않는다");
  assert.deepEqual(mutations, [], "차단된 turn이 credential mutation을 유발하지 않는다");
  assert.equal(adapter.cancels, adapterCallsBefore, "adapter 실행이 없다");

  // 7~9. 붙잡아 둔 구간을 풀면 mutation + restart가 끝나고 전환이 종료된다.
  releaseRead();
  assert.equal(await switchPromise, true);
  assert.deepEqual(mutations, ["write", "restart"]);
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false, "전환 gate가 해제된다");

  // 10. 다음 managed Professional turn은 fresh native session으로 성공한다.
  const fresh = await runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV }).promise;
  assert.equal(fresh.ok, true);
  assert.equal(fresh.session.generation, 2, "fresh native session");
});

test("BLOCKER3-b. prepareLogin의 clear 이전 구간에서도 admission이 닫혀 있다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  const agy = switching.antigravityAccountSwitcher;
  let releaseRead;
  const held = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  const mutations = [];
  agy.read = async () => {
    reads += 1;
    if (reads === 1) throw new Error("meta 수집 생략");
    await held; // prepareLogin 내부 스냅샷 read — clear 직전이다.
    return { token: { refresh_token: "live-a" } };
  };
  agy.clear = async () => { mutations.push("clear"); };
  agy.restart = async () => { mutations.push("restart"); };
  agy.store = { save: () => {}, clearActive: () => mutations.push("clearActive") };

  const loginPromise = switching.startProviderLogin("agy");
  await tick();
  await tick();
  assert.deepEqual(mutations, [], "아직 clear하지 않았다");

  const blocked = await runtime.runTurn({ context: managedCtx(), invocation: MANAGED_INV }).promise;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stopReason, "HARNESS_SESSION_LIFECYCLE_BUSY");

  releaseRead();
  assert.equal(await loginPromise, true);
  assert.deepEqual(mutations, ["clear", "clearActive", "restart"]);
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false);
});

test("BLOCKER3-c. 같은 provider의 전환이 겹치면 두 번째는 fail-closed이고 두 번째 mutation이 없다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  const adapter = new PendingLifecycleAdapter();
  runtime.register("agy", adapter);
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "b@b.c", active: false,
  });
  let releaseRead;
  const held = new Promise((resolve) => { releaseRead = resolve; });
  const mutations = [];
  agy.read = async () => { await held; return { token: { refresh_token: "live-a" } }; };
  agy.write = async () => { mutations.push("write"); };
  agy.restart = async () => { mutations.push("restart"); };

  const first = switching.switchProviderAccount("agy", saved.key);
  await tick();
  await tick();

  // 첫 전환이 mutation 이전 구간에 있는 동안 두 번째 전환 시도.
  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    (error) => {
      assert.match(error.message, /계정 전환이 이미 진행 중/);
      assert.equal(error.accountSwitchSafe, true);
      return true;
    }
  );

  releaseRead();
  assert.equal(await first, true);
  assert.deepEqual(mutations, ["write", "restart"], "credential mutation은 정확히 한 번");
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false);
});

test("BLOCKER3-d. mutation이 실패해도 전환 gate는 해제된다(영구히 막힌 provider 금지)", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  runtime.register("agy", new PendingLifecycleAdapter());
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { throw new Error("credential 쓰기 실패"); };

  await assert.rejects(() => switching.switchProviderAccount("agy", saved.key), /쓰기 실패/);
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false, "실패해도 gate 해제");

  // native session은 폐기 상태로 남고, admission은 다시 열려 재시도가 가능하다.
  agy.write = async () => {};
  agy.restart = async () => {};
  assert.equal(await switching.switchProviderAccount("agy", saved.key), true, "재시도 가능");
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false);
});

test("BLOCKER3-e. prepareLogin 실패도 전환 gate를 해제한다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  runtime.register("agy", new PendingLifecycleAdapter());
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.clear = async () => { throw new Error("credential 삭제 실패"); };
  agy.store = { save: () => {}, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /삭제 실패/);
  assert.equal(runtime.isProviderAccountTransitionActive("agy"), false);
});

test("BLOCKER3-f. Codex 전환 실패(프록시/데스크톱)도 전환 gate를 해제한다", async (t) => {
  const runtime = new HarnessRuntime({ processAdapter: sessionlessProcessAdapter() });
  runtime.register("codex", new PendingLifecycleAdapter());
  const { switching } = makeSwitching(t, { chatFeature: boundaryFeature(runtime) });

  switching.codexAccountSwitcher.switchToProfile = () => { throw new Error("auth 교체 실패"); };
  assert.equal(await switching.switchCodexAccount("k"), false);
  assert.equal(runtime.isProviderAccountTransitionActive("codex"), false, "데스크톱 경로 gate 해제");

  // 해제됐으므로 다음 전환이 정상적으로 시작된다.
  switching.codexAccountSwitcher.switchToProfile = () => ({ profile: { label: "B" } });
  assert.equal(await switching.switchCodexAccount("k"), true);
  assert.equal(runtime.isProviderAccountTransitionActive("codex"), false);
});

test("BLOCKER3-g. complete()를 지키지 않는 seam은 fail-closed다(닫을 수 없는 전환 금지)", async (t) => {
  // 전환을 열어 놓고 닫을 방법이 없으면 provider admission이 영원히 잠긴다.
  // 그런 handle로는 credential을 바꾸지 않는다.
  const { switching } = makeSwitching(t, {
    chatFeature: {
      notifyProviderAccountChanged: async () => ({ providerId: "agy", token: "t" }), // complete 없음
      showSystemNotice: () => {},
    },
  });
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  const touched = [];
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { touched.push("write"); };

  await assert.rejects(
    () => switching.switchProviderAccount("agy", saved.key),
    /complete\(\)가 없습니다/
  );
  assert.deepEqual(touched, [], "credential을 건드리지 않는다");
});


// npm test가 사용자의 Codex Desktop을 실제로 종료·재실행하던 부작용을 막는다.
// switchCodexAccount 안에 stop/launch가 직접 박혀 있으면 switchToProfile만 모킹해도
// 진짜 앱이 꺼졌다 켜진다. seam을 통해서만 부르는지 소스로 고정한다.
test("계정 전환 테스트는 실제 Codex Desktop을 건드리지 않는다", async (t) => {
  const { switching, desktopCalls } = makeSwitching(t);
  switching.codexAccountSwitcher.switchToProfile = () => ({ profile: { label: "T" } });

  await switching.switchCodexAccount("some-profile");
  // seam을 통해 호출됐다면 카운트가 오른다(= 실제 앱은 안 건드렸다).
  assert.ok(desktopCalls.stopped >= 1, "종료는 주입된 seam으로 가야 합니다");
  assert.ok(desktopCalls.launched >= 1, "재실행도 주입된 seam으로 가야 합니다");

  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "agora", "account-switching.js"), "utf8"
  );
  const body = source.slice(source.indexOf("async function switchCodexAccount"));
  const fn = body.slice(0, body.indexOf("\n  function "));
  assert.ok(!fn.includes("stopCodexDesktopApp()"), "운영 함수를 직접 부르면 모킹이 무의미해집니다");
  assert.ok(!fn.includes("launchCodexDesktopApp()"), "운영 함수를 직접 부르면 모킹이 무의미해집니다");
});

// ---- 앱 안 CLI 로그인 (cli-login 러너 주입) ----
//
// 예전에는 [계정 추가]가 로그인 명령을 담은 스크립트를 터미널 창으로 열었고, 그
// 창에서 무슨 일이 일어나는지 앱은 알 수 없어 계정 경계도 실행 직후 닫아야 했다.
// 이제 로그인 프로세스는 앱이 직접 돌리므로 끝나는 순간까지 지켜본다.

function fakeLoginRunner({ failStart = null } = {}) {
  const sessions = new Map();
  const runner = {
    starts: [],
    inputs: [],
    cancels: [],
    start(options) {
      if (failStart) throw new Error(failStart);
      if (sessions.has(options.provider)) throw new Error("이미 로그인이 진행 중입니다.");
      if (!options.command) throw new Error("로그인 명령을 찾지 못했습니다.");
      runner.starts.push(options);
      sessions.set(options.provider, { ...options, urls: [] });
      options.onEvent?.({ provider: options.provider, type: "started" });
      return { provider: options.provider };
    },
    input(provider, text) {
      if (!sessions.has(provider)) throw new Error("진행 중인 로그인이 없습니다.");
      runner.inputs.push([provider, text]);
      return true;
    },
    cancel(provider) {
      runner.cancels.push(provider);
      return sessions.has(provider);
    },
    isRunning: (provider) => sessions.has(provider),
    knowsUrl: (provider, url) => Boolean(sessions.get(provider)?.urls.includes(url)),
    // 테스트가 CLI의 출력과 종료를 흉내 낸다.
    emitUrl(provider, url) {
      const session = sessions.get(provider);
      session.urls.push(url);
      session.onEvent?.({ provider, type: "url", url });
    },
    async finish(provider, result) {
      const session = sessions.get(provider);
      sessions.delete(provider);
      const summary = { tail: [], ...result };
      await session.onExit?.({ provider, ...summary });
      session.onEvent?.({ provider, type: "exit", ...summary });
    },
  };
  return runner;
}

function makeInAppSwitching(t, { cliLogin, commands = ["claude", "codex"] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-inapp-login-")));
  const userData = path.join(home, "userData");
  const bin = path.join(home, "bin");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // 로그인 명령은 PATH에서 CLI를 찾는다. 실제 CLI 대신 아무것도 하지 않는 실행 파일을 둔다.
  for (const name of commands) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // 가짜 CLI가 먼저 잡히되, resolveCommand가 쓰는 which 자체는 찾을 수 있어야 한다.
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(path.delimiter);
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.PATH = prev.PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const notifications = [];
  const completes = [];
  const notices = [];
  const loginEvents = [];
  const opened = [];
  const switching = createAccountSwitching({
    codexDesktop: { stop: async () => {}, launch: async () => ({ skipped: true }) },
    electron: {
      app: { getPath: () => userData },
      shell: { openPath: async () => "", openExternal: async (url) => { opened.push(url); } },
    },
    openChatWindow: () => {},
    refreshTrayMenu: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    cliLogin,
    notifyAccountLogin: (event) => loginEvents.push(event),
    getChatFeature: () => ({
      notifyProviderAccountChanged: async (provider) => {
        notifications.push(provider);
        return { providerId: provider, token: `t-${provider}`, complete: () => { completes.push(provider); return true; } };
      },
      showSystemNotice: (text) => notices.push(text),
    }),
  });
  return { switching, notifications, completes, notices, loginEvents, opened, home, bin };
}

test("Claude 로그인은 터미널 없이 앱 안에서 돌고, 계정 경계는 로그인이 끝난 뒤에 닫힌다", async (t) => {
  if (process.platform === "win32") return t.skip("가짜 CLI를 sh 스크립트로 두는 테스트");
  const runner = fakeLoginRunner();
  const { switching, notifications, completes, notices, loginEvents, opened, bin } = makeInAppSwitching(t, { cliLogin: runner });

  assert.equal(await switching.startProviderLogin("claude"), true, "프로세스를 띄웠으면 바로 true다");
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].command, path.join(bin, "claude"));
  assert.deepEqual(runner.starts[0].args, ["auth", "login"]);
  assert.ok(String(runner.starts[0].env.PATH).includes(bin), "로그인 명령은 같은 PATH에서 CLI를 찾는다");
  assert.deepEqual(notifications, ["claude"], "credential이 바뀌기 전에 경계를 설치한다");
  assert.deepEqual(completes, [], "로그인이 도는 동안에는 경계를 닫지 않는다");
  assert.equal(switching.isProviderLoginRunning("claude"), true);
  assert.equal(loginEvents[0].type, "started");

  // 브라우저 주소는 이 로그인이 출력한 것만 연다.
  runner.emitUrl("claude", "https://claude.com/cai/oauth/authorize?code=true");
  await assert.rejects(() => switching.openProviderLoginUrl("claude", "https://evil.example/"), /이 로그인이 연 주소가 아닙니다/);
  await switching.openProviderLoginUrl("claude", "https://claude.com/cai/oauth/authorize?code=true");
  assert.deepEqual(opened, ["https://claude.com/cai/oauth/authorize?code=true"]);

  // 붙여 넣은 인증 코드는 CLI로 간다.
  assert.equal(switching.submitProviderLoginInput("claude", "abc#123"), true);
  assert.deepEqual(runner.inputs, [["claude", "abc#123"]]);

  await runner.finish("claude", { ok: true, code: 0, tail: ["Login successful"] });
  assert.deepEqual(completes, ["claude"], "로그인이 끝난 뒤에야 경계를 닫는다");
  assert.equal(switching.isProviderLoginRunning("claude"), false);
  assert.ok(notices.some((text) => /Claude 로그인이 끝났습니다/.test(text)));
  assert.equal(loginEvents.at(-1).type, "exit");
  assert.equal(loginEvents.at(-1).ok, true);
  assert.throws(() => switching.submitProviderLoginInput("claude", "late"), /진행 중인 로그인이 없습니다/);
});

test("Claude 로그인이 실패로 끝나면 경계를 닫고 사유를 알리되, 취소는 조용히 끝난다", async (t) => {
  if (process.platform === "win32") return t.skip("가짜 CLI를 sh 스크립트로 두는 테스트");
  const runner = fakeLoginRunner();
  const { switching, completes, notices } = makeInAppSwitching(t, { cliLogin: runner });
  await switching.startProviderLogin("claude");
  await runner.finish("claude", { ok: false, code: 1, tail: ["Failed to authenticate"] });
  assert.deepEqual(completes, ["claude"]);
  assert.ok(notices.some((text) => /끝나지 않았습니다[\s\S]*Failed to authenticate/.test(text)));

  await switching.startProviderLogin("claude");
  assert.equal(switching.cancelProviderLogin("claude"), true);
  await runner.finish("claude", { ok: false, code: null, cancelled: true });
  assert.deepEqual(completes, ["claude", "claude"]);
  assert.equal(notices.filter((text) => /끝나지 않았습니다/.test(text)).length, 1, "취소는 실패 안내를 내지 않는다");
});

test("Claude 로그인을 시작하지 못하면 경계를 닫고 던진다 — 같은 제공자의 동시 로그인은 거부", async (t) => {
  if (process.platform === "win32") return t.skip("가짜 CLI를 sh 스크립트로 두는 테스트");
  const failing = fakeLoginRunner({ failStart: "EPERM" });
  const broken = makeInAppSwitching(t, { cliLogin: failing });
  await assert.rejects(() => broken.switching.startProviderLogin("claude"), /EPERM/);
  assert.deepEqual(broken.completes, ["claude"], "시작 실패도 열어 둔 경계를 닫는다");

  const runner = fakeLoginRunner();
  const { switching, notifications } = makeInAppSwitching(t, { cliLogin: runner });
  await switching.startProviderLogin("claude");
  await assert.rejects(() => switching.startProviderLogin("claude"), /이미 Claude 로그인이 진행 중/);
  assert.deepEqual(notifications, ["claude"], "거부된 두 번째 시도는 경계를 다시 설치하지 않는다");
});

test("Codex 로그인은 pending profile의 CODEX_HOME에서 앱 안으로 돌고, 끝나면 전환을 안내한다", async (t) => {
  if (process.platform === "win32") return t.skip("가짜 CLI를 sh 스크립트로 두는 테스트");
  const runner = fakeLoginRunner();
  const { switching, notifications, notices, home, bin } = makeInAppSwitching(t, { cliLogin: runner });

  assert.equal(await switching.startCodexLogin(), true);
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].command, path.join(bin, "codex"));
  assert.deepEqual(runner.starts[0].args, ["login"]);
  const codexHome = runner.starts[0].env.CODEX_HOME;
  assert.ok(codexHome.startsWith(home), "pending profile은 이 PC의 Agora 계정 폴더 안에 있다");
  assert.ok(path.basename(codexHome).startsWith("__login_"), "auth.json이 생기기 전에는 목록에 없는 pending 폴더다");
  assert.ok(fs.existsSync(codexHome));
  assert.deepEqual(notifications, [], "Codex 로그인은 live credential을 건드리지 않으므로 경계가 필요 없다");
  assert.equal(await switching.startCodexLogin(), false, "진행 중이면 다시 시작하지 않는다");

  await runner.finish("codex", { ok: true, code: 0 });
  assert.ok(notices.some((text) => /Codex 로그인이 끝났습니다/.test(text)));
  assert.equal(switching.isProviderLoginRunning("codex"), false);
});
