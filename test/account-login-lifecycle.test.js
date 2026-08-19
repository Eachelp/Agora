"use strict";

// 계정 로그인/전환 흐름의 selection-boundary lifecycle.
//
// 정책(수정된 계약): 계정 변경은 provider-wide 세션 파괴가 아니라 session-selection
// boundary다. 이 파일은 account-switching 모듈이 그 경계를 올바르게 통지하고
// (확정 전환 = accountKey 포함, unknown 전이 = key 없음, 무변경 증명 실패 = 통지
// 없음), Professional managed turn의 계정 namespace resolver가 stable local
// profile key/opaque fingerprint로만 identity를 확정하는지 검증한다.
//
//   - AGY prepareLogin의 accountSwitchSafe 의미론: clear() 시작 전 실패만 live
//     credential 무변경 증명이고, clear가 시도된 이후의 모든 실패(재시작 실패 포함)는
//     partial mutation 가능성이 있으므로 accountSwitchSafe를 갖지 않는다.
//   - startProviderLogin("agy"): 성공/ambiguous 실패 → key 없는 unknown 전이 정확히
//     1회(오염 inflight 정리 전용, parked 세션 파괴 아님), 무변경 증명 실패 → 통지 없음.
//   - startProviderLogin("claude"): launcher가 실제로 열렸을 때만 unknown window
//     시작 + key 없는 통지 정확히 1회. launcher 실패는 통지도 window도 없다.
//   - resolver: live credential이 없거나 unknown window 안이면 { status: "unknown" }
//     (Professional managed 실행 fail-closed 대상). 확정되면 저장 프로필 key 또는
//     opaque secret fingerprint. 토큰 원문/이메일 라벨은 identity로 노출되지 않는다.
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
const { secretFingerprint } = require("../src/provider-profile-store");

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

// ---- startProviderLogin / resolver wiring (실제 createAccountSwitching 경유) ----

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
      notifyProviderAccountChanged: (provider, detail) =>
        notifications.push({ provider, accountKey: detail?.accountKey ?? null }),
      showSystemNotice: () => {},
    }),
    bubbleDoneAutoHideMs: 1,
  });
  return { switching, notifications, home };
}

test("AGY prepareLogin 성공 → key 없는 unknown 전이 정확히 1회(세션 파괴 통지가 아니다)", async (t) => {
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
  assert.deepEqual(notifications, [{ provider: "agy", accountKey: null }],
    "성공한 prepareLogin은 unknown 전이를 정확히 1회 통지한다(오염 inflight 정리 전용)");
});

test("AGY: clear 이전 무변경 증명 실패는 어떤 lifecycle 통지도 만들지 않는다", async (t) => {
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

test("AGY: clear 이후 restart 실패(ambiguous)는 key 없는 unknown 전이 정확히 1회다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  let cleared = false;
  agy.clear = async () => { cleared = true; };
  agy.restart = async () => { throw new Error("AGY 재시작 실패"); };
  agy.store = { save: () => {}, clearActive: () => {} };

  await assert.rejects(() => switching.startProviderLogin("agy"), /재시작 실패/);
  assert.equal(cleared, true, "mutation이 이미 시작된 실패다");
  assert.deepEqual(notifications, [{ provider: "agy", accountKey: null }],
    "partial mutation 가능 실패는 unknown 전이를 정확히 1회 통지한다");
});

test("전환 성공(switchProviderAccount)은 새 계정의 stable profile key를 boundary에 전달한다", async (t) => {
  const { switching, notifications } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  const stored = { token: { refresh_token: "profile-secret" } };
  const saved = agy.store.save({ secret: stored, email: "a@b.c", active: false });
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  agy.write = async () => {};
  agy.restart = async () => {};

  const result = await switching.switchProviderAccount("agy", saved.key);
  assert.equal(result, true);
  assert.deepEqual(notifications, [{ provider: "agy", accountKey: saved.key }],
    "확정된 전환은 accountKey를 포함해 selection boundary를 통지한다");
});

// ---- 계정 namespace resolver ----

test("resolver(AGY): live credential 부재 = unknown(외부 로그인 window의 fail-closed 표식)", async (t) => {
  const { switching } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 자격 증명 없음"); };
  assert.deepEqual(await switching.resolveProviderAccount("agy"), { status: "unknown" });
});

test("resolver(AGY): 새 credential이 존재하는 순간이 재확립이고, 저장 프로필 key를 우선한다", async (t) => {
  const { switching } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  const secret = { token: { refresh_token: "acct-a-refresh" } };
  // 프로필 미저장 상태: 토큰 원문이 아니라 opaque fingerprint로 식별한다.
  agy.read = async () => secret;
  const unsaved = await switching.resolveProviderAccount("agy");
  assert.equal(unsaved.status, "known");
  assert.equal(unsaved.key, secretFingerprint(secret), "opaque 16-hex fingerprint");
  assert.ok(!unsaved.key.includes("acct-a-refresh"), "토큰 원문을 identity로 노출하지 않는다");
  // 같은 secret이 프로필로 저장되면 stable local profile key가 우선한다.
  const saved = agy.store.save({ secret, email: "a@b.c", active: true });
  const resolved = await switching.resolveProviderAccount("agy");
  assert.deepEqual(resolved, { status: "known", key: saved.key });
});

test("resolver(codex): live auth가 없으면 unknown이다", async (t) => {
  const { switching } = makeSwitching(t);
  assert.deepEqual(await switching.resolveProviderAccount("codex"), { status: "unknown" });
});

test("resolver: 계정 개념이 연결되지 않은 provider는 unknown으로 fail-closed한다", async (t) => {
  const { switching } = makeSwitching(t);
  assert.deepEqual(await switching.resolveProviderAccount("unknown-provider"), { status: "unknown" });
});

// Claude live 자격 증명은 macOS에서 Keychain이라 파일 기반 resolver 검증은
// 파일 저장소 플랫폼(리눅스/윈도우)에서만 결정적이다.
const claudeFileStoreOpts = process.platform === "darwin"
  ? { skip: "macOS Claude live store는 Keychain이라 파일 기반 검증 대상이 아니다" }
  : {};

function writeClaudeLive(home, refreshToken, expiresAt) {
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { refreshToken, refreshTokenExpiresAt: expiresAt } }),
    "utf8"
  );
}

test("resolver(claude): live credential이 확정되면 known, 없으면 unknown이다", claudeFileStoreOpts, async (t) => {
  const { switching, home } = makeSwitching(t);
  assert.deepEqual(await switching.resolveProviderAccount("claude"), { status: "unknown" });
  writeClaudeLive(home, "acct-a-refresh", 1_700_000_000_000);
  const resolved = await switching.resolveProviderAccount("claude");
  assert.equal(resolved.status, "known");
  assert.match(resolved.key, /^[a-f0-9]{16}$/, "opaque stable fingerprint/profile key");
  assert.ok(!resolved.key.includes("acct-a-refresh"), "토큰 원문을 identity로 노출하지 않는다");
});

// Claude launcher 경로는 리눅스 셸 shim(가짜 claude/xterm 실행 파일)으로만 결정적으로
// 재현할 수 있다. 다른 플랫폼에서는 스킵하고, wiring 존재는 source-level 테스트가 지킨다.
const claudeLauncherOpts = process.platform === "linux"
  ? {}
  : { skip: "Claude launcher 셸 shim은 리눅스에서만 결정적이다" };

function writeShim(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
}

test("Claude 로그인 launcher 성공 → unknown window 시작 + key 없는 통지 정확히 1회, 재확립은 baseline과 다른 live key만", claudeLauncherOpts, async (t) => {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-shim-"));
  t.after(() => fs.rmSync(shim, { recursive: true, force: true }));
  // 가짜 claude(존재만 하면 됨)와 가짜 xterm(터미널 launcher 성공)을 PATH에 둔다.
  writeShim(shim, "claude", "#!/bin/sh\nexit 1\n");
  writeShim(shim, "xterm", "#!/bin/sh\nexit 0\n");
  const { switching, notifications, home } = makeSwitching(t, { pathOverride: `${shim}:/usr/bin:/bin` });
  // launcher가 열리기 전의 live 계정 A = baseline.
  writeClaudeLive(home, "acct-a-refresh", 1_700_000_000_000);
  const baseline = await switching.resolveProviderAccount("claude");
  assert.equal(baseline.status, "known");

  const result = await switching.startProviderLogin("claude");
  assert.equal(result, true);
  assert.deepEqual(notifications, [{ provider: "claude", accountKey: null }],
    "launcher가 실제로 열렸으면 unknown 전이를 정확히 1회 통지한다(parked 세션 파괴 아님)");

  // unknown window: old credential이 그대로 남아 있어도 A를 다시 선택하지 않는다
  // (로그인 완료 여부를 구별할 수 없다).
  assert.deepEqual(await switching.resolveProviderAccount("claude"), { status: "unknown" });

  // 외부 로그인이 실제로 완료되어 baseline과 다른 credential이 관측되면 재확립된다.
  writeClaudeLive(home, "acct-b-refresh", 1_800_000_000_000);
  const reestablished = await switching.resolveProviderAccount("claude");
  assert.equal(reestablished.status, "known");
  assert.notEqual(reestablished.key, baseline.key, "재확립은 matching(새) namespace만 선택한다");
});

test("Claude 로그인 launcher 실패 → 통지도 unknown window도 없다", claudeLauncherOpts, async (t) => {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-shim-"));
  t.after(() => fs.rmSync(shim, { recursive: true, force: true }));
  // claude는 있지만 터미널 emulator가 하나도 없어 launcher가 열리지 못한다.
  writeShim(shim, "claude", "#!/bin/sh\nexit 1\n");
  const { switching, notifications, home } = makeSwitching(t, { pathOverride: `${shim}:/usr/bin:/bin` });
  writeClaudeLive(home, "acct-a-refresh", 1_700_000_000_000);
  const before = await switching.resolveProviderAccount("claude");

  await assert.rejects(() => switching.startProviderLogin("claude"));
  assert.deepEqual(notifications, [], "launcher 실패는 live credential 환경이 그대로이므로 통지하지 않는다");
  assert.deepEqual(await switching.resolveProviderAccount("claude"), before,
    "launcher 실패는 unknown window를 시작하지 않는다(계정 A 그대로 선택 가능)");
});
