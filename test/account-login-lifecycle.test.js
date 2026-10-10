"use strict";

// 계정 로그인/전환 흐름의 전환 경계 lifecycle.
//
// 정책: provider 계정 변경은 credential mutation 이전에 전환 경계(같은 provider의
// 겹침을 막는 in-memory 가드)를 연다. mutation이 확정되면 성공/실패와 무관하게 닫는다.
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
const { createChatFeature } = require("../src/chat/chat-ipc");

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

// ---- BLOCKER 1: 전환 경계는 credential mutation보다 먼저, 닫는 것은 mutation 이후 ----

// 실제 chat-ipc의 전환 가드를 쓰는 chat feature. order가 있으면 호출 순서를 기록한다.
function realBoundaryFeature(t, order = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-acct-chat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle() {}, on() {} },
      dialog: {},
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: { defs: [], getRecord: () => null, discover: async () => [] },
    harnessAdapter: { runTurn: () => ({ promise: Promise.resolve({ ok: true }), cancel: () => {} }) },
  });
  return {
    notifyProviderAccountChanged: async (provider) => {
      if (order) order.push(`boundary:start:${provider}`);
      const opened = await feature.notifyProviderAccountChanged(provider);
      if (order) order.push(`boundary:opened:${provider}`);
      return {
        ...opened,
        complete: () => {
          if (order) order.push(`boundary:complete:${provider}`);
          return opened.complete();
        },
      };
    },
    // 전환 gate가 열려 있는지: 열려 있으면 새 전환이 시작되고 곧바로 닫힌다.
    isOpen: async (provider) => {
      try {
        const probe = await feature.notifyProviderAccountChanged(provider);
        probe.complete();
        return true;
      } catch {
        return false;
      }
    },
    showSystemNotice: () => {},
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("BLOCKER1. 계정 전환은 boundary를 연 뒤에만 credential을 바꾸고, 끝난 뒤 닫는다", async (t) => {
  const order = [];
  const chatFeature = realBoundaryFeature(t, order);
  const { switching } = makeSwitching(t, { chatFeature });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "profile-secret" } },
    email: "b@b.c",
    active: false,
  });
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.write = async () => { order.push("credential:write"); };
  agy.restart = async () => { order.push("provider:restart"); };

  assert.equal(await switching.switchProviderAccount("agy", saved.key), true);
  assert.deepEqual(
    order,
    [
      "boundary:start:agy",
      "boundary:opened:agy",
      "credential:write",
      "provider:restart",
      "boundary:complete:agy",
    ],
    "boundary -> credential mutation -> provider restart -> 전환 종료 순서"
  );
  assert.equal(await chatFeature.isOpen("agy"), true, "전환이 끝나면 gate가 열린다");
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

test("BLOCKER2-d. chat feature가 없는 구성은 명시적 immediately-safe 성공이다", async (t) => {
  // getChatFeature가 null(= 채팅 기능 없음)이면 무효화할 native session도,
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
  // "채팅 기능 없음"으로 오분류해 통과시키면 fail-open이다.
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

// ---- BLOCKER3: 전환 트랜잭션이 끝날 때까지 같은 provider의 새 전환은 막혀 있어야 한다 ----
//
// credential mutation 이전 async 구간이 실재한다:
//   switchToProfile -> await snapshotCurrent() -> await read() -> await write()
//   prepareLogin    -> await read()            -> clear()
// 그 구간에 같은 provider의 다른 전환·로그인이 끼어들면 마지막 writer가 이긴다.

test("BLOCKER3. mutation 이전 async 구간(snapshotCurrent/read)에서도 같은 provider의 새 전환은 거부된다", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "profile-secret" } }, email: "b@b.c", active: false,
  });

  // snapshotCurrent() 안의 read()에서 전환을 붙잡아 둔다 - write 직전 지점이다.
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

  const switchPromise = switching.switchProviderAccount("agy", saved.key);
  await tick();
  await tick();
  assert.equal(readEntered, true, "mutation 이전 async 구간에 진입했다");
  assert.deepEqual(mutations, [], "아직 credential을 바꾸지 않았다");
  assert.equal(await chatFeature.isOpen("agy"), false, "이 구간에서 같은 provider의 새 전환은 거부된다");
  assert.equal(await chatFeature.isOpen("codex"), true, "다른 provider는 막지 않는다");

  releaseRead();
  assert.equal(await switchPromise, true);
  assert.deepEqual(mutations, ["write", "restart"]);
  assert.equal(await chatFeature.isOpen("agy"), true, "전환 gate가 해제된다");
});

test("BLOCKER3-b. prepareLogin의 clear 이전 구간에서도 gate가 닫혀 있다", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

  const agy = switching.antigravityAccountSwitcher;
  let releaseRead;
  const held = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  const mutations = [];
  agy.read = async () => {
    reads += 1;
    if (reads === 1) throw new Error("meta 수집 생략");
    await held; // prepareLogin 내부 스냅샷 read - clear 직전이다.
    return { token: { refresh_token: "live-a" } };
  };
  agy.clear = async () => { mutations.push("clear"); };
  agy.restart = async () => { mutations.push("restart"); };
  agy.store = { save: () => {}, clearActive: () => mutations.push("clearActive") };

  const loginPromise = switching.startProviderLogin("agy");
  await tick();
  await tick();
  assert.deepEqual(mutations, [], "아직 clear하지 않았다");
  assert.equal(await chatFeature.isOpen("agy"), false, "clear 이전 구간에서 새 전환은 거부된다");

  releaseRead();
  assert.equal(await loginPromise, true);
  assert.deepEqual(mutations, ["clear", "clearActive", "restart"]);
  assert.equal(await chatFeature.isOpen("agy"), true);
});

test("BLOCKER3-c. 같은 provider의 전환이 겹치면 두 번째는 fail-closed이고 두 번째 mutation이 없다", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

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
  assert.equal(await chatFeature.isOpen("agy"), true);
});

test("BLOCKER3-d. mutation이 실패해도 전환 gate는 해제된다(영구히 막힌 provider 금지)", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({
    secret: { token: { refresh_token: "s" } }, email: "a@b.c", active: false,
  });
  agy.read = async () => { throw new Error("none"); };
  agy.write = async () => { throw new Error("credential 쓰기 실패"); };

  await assert.rejects(() => switching.switchProviderAccount("agy", saved.key), /쓰기 실패/);
  assert.equal(await chatFeature.isOpen("agy"), true, "실패해도 gate 해제");

  // native session은 폐기 상태로 남고, admission은 다시 열려 재시도가 가능하다.
  agy.write = async () => {};
  agy.restart = async () => {};
  assert.equal(await switching.switchProviderAccount("agy", saved.key), true, "재시도 가능");
  assert.equal(await chatFeature.isOpen("agy"), true);
});

test("BLOCKER3-e. prepareLogin 실패도 전환 gate를 해제한다", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.clear = async () => { throw new Error("credential 삭제 실패"); };
  agy.store = { save: () => {}, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /삭제 실패/);
  assert.equal(await chatFeature.isOpen("agy"), true);
});

test("BLOCKER3-f. Codex 전환 실패(프록시/데스크톱)도 전환 gate를 해제한다", async (t) => {
  const chatFeature = realBoundaryFeature(t);
  const { switching } = makeSwitching(t, { chatFeature });

  switching.codexAccountSwitcher.switchToProfile = () => { throw new Error("auth 교체 실패"); };
  assert.equal(await switching.switchCodexAccount("k"), false);
  assert.equal(await chatFeature.isOpen("codex"), true, "데스크톱 경로 gate 해제");

  // 해제됐으므로 다음 전환이 정상적으로 시작된다.
  switching.codexAccountSwitcher.switchToProfile = () => ({ profile: { label: "B" } });
  assert.equal(await switching.switchCodexAccount("k"), true);
  assert.equal(await chatFeature.isOpen("codex"), true);
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

// ---- 로그아웃 / 이 PC 전체 지우기 (라이브 인증 삭제) ----
//
// 계정이 하나뿐이면 늘 활성이라 저장 프로필 삭제가 영영 막힌다(반납 시 지울 수
// 없다). 로그아웃은 이 PC의 라이브 인증과 저장 정보를 지우되 다른 기기 세션은
// 건드리지 않는다. 라이브 자격 증명 삭제이므로 계정 경계 뒤에서 한다.

function seedClaudeLive(home) {
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { refreshToken: "r-live", accessToken: "a", expiresAt: Date.now() + 3600000 } }));
  return path.join(dir, ".credentials.json");
}

function seedCodexLive(home) {
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { refresh_token: "r-codex" } }));
  return path.join(dir, "auth.json");
}

test("Claude 로그아웃은 라이브 자격 증명과 저장 프로필을 지우고, 경계 뒤에서 실행된다", async (t) => {
  const runner = fakeLoginRunner();
  const { switching, notifications, completes, home } = makeInAppSwitching(t, { cliLogin: runner });
  const liveFile = seedClaudeLive(home);
  // 저장된 활성 프로필도 하나 만든다.
  const store = switching.claudeAccountSwitcher.store;
  store.save({ secret: { claudeAiOauth: { refreshToken: "r-live", accessToken: "a" } }, email: "me@x.com", active: true });
  assert.equal(store.list().length, 1);
  assert.ok(fs.existsSync(liveFile));

  const result = await switching.logoutProvider("claude");
  assert.equal(result.live, true, "라이브 자격 증명 파일을 지웠다");
  assert.equal(fs.existsSync(liveFile), false);
  assert.equal(store.list().length, 0, "저장된 프로필도 지웠다");
  assert.deepEqual(notifications, ["claude"], "경계를 설치한다(credential mutation)");
  assert.deepEqual(completes, ["claude"], "끝나면 경계를 닫는다");
});

test("Codex 로그아웃은 라이브 auth.json을 지운다", async (t) => {
  const runner = fakeLoginRunner();
  const { switching, notifications, completes, home } = makeInAppSwitching(t, { cliLogin: runner });
  const liveFile = seedCodexLive(home);
  assert.ok(fs.existsSync(liveFile));

  const result = await switching.logoutProvider("codex");
  assert.equal(result.live, true);
  assert.equal(fs.existsSync(liveFile), false);
  assert.deepEqual(notifications, ["codex"]);
  assert.deepEqual(completes, ["codex"]);
});

test("이 PC 전체 지우기는 세 CLI 라이브 인증을 모두 지우고, provider마다 경계를 세운다", async (t) => {
  const runner = fakeLoginRunner();
  const { switching, notifications, completes, home } = makeInAppSwitching(t, { cliLogin: runner });
  const claudeLive = seedClaudeLive(home);
  const codexLive = seedCodexLive(home);
  // agy clear는 실제 OS 자격 저장소를 건드리므로 막아 둔다(삭제 실패는 이제 failures로 보고된다).
  switching.antigravityAccountSwitcher.clear = async () => {};

  const { failures } = await switching.wipeAllAccounts();
  assert.equal(fs.existsSync(claudeLive), false, "Claude 라이브 인증이 지워졌다");
  assert.equal(fs.existsSync(codexLive), false, "Codex 라이브 인증이 지워졌다");
  assert.deepEqual(notifications, ["claude", "codex", "agy"], "provider마다 경계를 세운다");
  assert.deepEqual(completes, ["claude", "codex", "agy"], "provider마다 경계를 닫는다");
  assert.deepEqual(failures, [], "세 provider 모두 정리에 성공한다");
});

test("이 PC 전체 지우기는 한 provider가 실패해도 나머지를 계속 지운다", async (t) => {
  const runner = fakeLoginRunner();
  const { switching, home } = makeInAppSwitching(t, { cliLogin: runner });
  const claudeLive = seedClaudeLive(home);
  const codexLive = seedCodexLive(home);
  // Codex wipeAll이 던지게 만든다.
  switching.codexAccountSwitcher.wipeAll = () => { throw new Error("codex 정리 실패"); };
  switching.antigravityAccountSwitcher.clear = async () => {};

  const { failures } = await switching.wipeAllAccounts();
  assert.equal(fs.existsSync(claudeLive), false, "실패한 provider가 있어도 Claude는 지운다");
  assert.ok(fs.existsSync(codexLive), "던진 provider의 라이브는 그대로다");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /codex.*정리 실패/);
});
