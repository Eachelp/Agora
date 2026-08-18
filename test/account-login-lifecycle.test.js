"use strict";

// 리뷰 F2/F3 — 계정 로그인(add-login) 흐름의 lifecycle boundary.
//
// 검증 목표:
//   - AGY prepareLogin의 accountSwitchSafe 의미론: clear() 시작 전 실패만 live
//     credential 무변경 증명이고, clear가 시도된 이후의 모든 실패(재시작 실패 포함)는
//     partial mutation 가능성이 있으므로 accountSwitchSafe를 갖지 않는다.
//   - startProviderLogin("agy"): 성공 → 정확히 1회 lifecycle 통지, 무변경 증명 실패 →
//     통지 없음, ambiguous 실패 → 정확히 1회 통지(중복 통지 금지).
//   - startProviderLogin("claude"): 외부 `claude auth login` launcher가 실제로 열렸을
//     때만 보수적으로 정확히 1회 INVALIDATE. launcher 실패는 credential 환경이
//     그대로이므로 통지하지 않는다.
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

// ---- startProviderLogin wiring (실제 createAccountSwitching 경유) ----

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
      notifyProviderAccountChanged: (provider) => notifications.push(provider),
      showSystemNotice: () => {},
    }),
    bubbleDoneAutoHideMs: 1,
  });
  return { switching, notifications };
}

test("리뷰 F2-I. AGY prepareLogin 성공 → agy lifecycle 정확히 1회", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  // live 자격 증명이 없는 첫 로그인 PC: 메타 수집/스냅샷은 건너뛰고 실제
  // prepareLogin의 clear→restart mutation 경로가 그대로 실행된다.
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  const mutations = [];
  agy.clear = async () => mutations.push("clear");
  agy.restart = async () => mutations.push("restart");
  agy.store = { save: () => {}, clearActive: () => mutations.push("clearActive") };

  const result = await switching.startProviderLogin("agy");
  assert.equal(result, true);
  assert.deepEqual(mutations, ["clear", "clearActive", "restart"], "실제 prepareLogin 경로가 실행됐다");
  assert.deepEqual(notifications, ["agy"], "성공한 prepareLogin은 정확히 1회 통지한다");
});

test("리뷰 F2-J. clear 이전 무변경 증명 실패는 invalidation을 만들지 않는다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  let reads = 0;
  agy.read = async () => {
    reads += 1;
    // 1회차(메타/usage 수집)는 실패해 외부 조회를 건너뛰고, 2회차(prepareLogin 내부
    // 스냅샷)는 자격 증명을 돌려줘 clear 이전의 저장 단계까지 진입시킨다.
    if (reads === 1) throw new Error("meta 수집 생략");
    return { token: { refresh_token: "r1" } };
  };
  let cleared = false;
  agy.clear = async () => { cleared = true; };
  agy.store = { save: () => { throw new Error("프로필 저장 실패"); }, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /프로필 저장 실패/);
  assert.equal(cleared, false, "live credential은 건드리지 않았다");
  assert.deepEqual(notifications, [], "무변경 증명(accountSwitchSafe) 실패는 통지하지 않는다");
});

test("리뷰 F2-K. clear 이후 restart 실패(ambiguous)는 정확히 1회 invalidation한다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  let cleared = false;
  agy.clear = async () => { cleared = true; };
  agy.restart = async () => { throw new Error("AGY 재시작 실패"); };
  agy.store = { save: () => {}, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /재시작 실패/);
  assert.equal(cleared, true, "mutation이 이미 시작된 실패다");
  assert.deepEqual(notifications, ["agy"], "partial mutation 가능 실패는 정확히 1회 통지한다");
});

// Claude launcher 경로는 리눅스 셸 shim(가짜 claude/xterm 실행 파일)으로만 결정적으로
// 재현할 수 있다. 다른 플랫폼에서는 스킵하고, wiring 존재는 source-level 테스트가 지킨다.
const claudeLauncherOpts = process.platform === "linux"
  ? {}
  : { skip: "Claude launcher 셸 shim은 리눅스에서만 결정적이다" };

function writeShim(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

test("리뷰 F3-L. Claude 로그인 launcher 성공 → claude lifecycle 정확히 1회", claudeLauncherOpts, async (t) => {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-shim-"));
  t.after(() => fs.rmSync(shim, { recursive: true, force: true }));
  // 가짜 claude(존재만 하면 됨)와 가짜 xterm(터미널 launcher 성공)을 PATH에 둔다.
  writeShim(shim, "claude", "#!/bin/sh\nexit 1\n");
  writeShim(shim, "xterm", "#!/bin/sh\nexit 0\n");
  const { switching, notifications } = makeSwitching(t, { pathOverride: `${shim}:/usr/bin:/bin` });

  const result = await switching.startProviderLogin("claude");
  assert.equal(result, true);
  assert.deepEqual(notifications, ["claude"], "launcher가 실제로 열렸으면 보수적으로 정확히 1회 INVALIDATE");
});

test("리뷰 F3-M. Claude 로그인 launcher 실패 → lifecycle 통지 없음", claudeLauncherOpts, async (t) => {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-shim-"));
  t.after(() => fs.rmSync(shim, { recursive: true, force: true }));
  // claude는 있지만 터미널 emulator가 하나도 없어 launcher가 열리지 못한다.
  writeShim(shim, "claude", "#!/bin/sh\nexit 1\n");
  const { switching, notifications } = makeSwitching(t, { pathOverride: `${shim}:/usr/bin:/bin` });

  await assert.rejects(() => switching.startProviderLogin("claude"));
  assert.deepEqual(notifications, [], "launcher 실패는 live credential 환경이 그대로이므로 통지하지 않는다");
});
