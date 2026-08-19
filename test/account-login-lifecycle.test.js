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

function makeSwitching(t, { pathOverride } = {}) {
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
  const switching = createAccountSwitching({
    electron: {
      app: { getPath: () => userData },
      shell: { openPath: async () => "" },
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
    },
    isPetEnabled: () => false,
    openChatWindow: () => {},
    showPetWindowFromTray: () => {},
    showBubble: () => {},
    restoreActiveActivityBubble: () => {},
    playReaction: () => {},
    refreshTrayMenu: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    getBubbleWindow: () => null,
    getPetWindow: () => null,
    getBubbleHideTimer: () => null,
    setBubbleHideTimer: () => {},
    getChatFeature: () => ({
      notifyProviderAccountChanged: (provider) =>
        notifications.push({ provider }),
      showSystemNotice: () => {},
    }),
    bubbleDoneAutoHideMs: 1,
  });
  return { switching, notifications, home };
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
