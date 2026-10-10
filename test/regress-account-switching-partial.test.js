"use strict";

// F128 AGY 전환·로그인이 자격 증명을 바꾼 뒤 IDE 재시작에 실패해도 부분 성공을 숨기지 않고 목록을 갱신한다.
// F129 Codex Desktop을 먼저 끈 뒤 전환이 실패하면 앱을 다시 띄운다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAccountSwitching } = require("../src/agora/account-switching");

function makeSwitching(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-partial-")));
  const userData = path.join(home, "userData");
  fs.mkdirSync(userData, { recursive: true });
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const state = { notices: [], trayRefreshes: 0, stopped: 0, launched: 0, launchFails: false };
  const switching = createAccountSwitching({
    codexDesktop: {
      stop: async () => { state.stopped += 1; },
      launch: async () => {
        state.launched += 1;
        if (state.launchFails) throw new Error("실행 불가");
        return { skipped: false };
      },
    },
    electron: { app: { getPath: () => userData }, shell: { openPath: async () => "" } },
    openChatWindow: () => {},
    refreshTrayMenu: () => { state.trayRefreshes += 1; },
    readSettings: () => ({}),
    writeSettings: () => {},
    getChatFeature: () => ({
      notifyProviderAccountChanged: async (provider) => ({ providerId: provider, token: "t", complete: () => true }),
      showSystemNotice: (text) => state.notices.push(text),
    }),
  });
  return { switching, state };
}

function seedAgyProfile(switching) {
  const agy = switching.antigravityAccountSwitcher;
  const saved = agy.store.save({ secret: { token: { refresh_token: "p" } }, email: "b@x.com", active: false });
  agy.read = async () => { throw new Error("live 없음"); };
  agy.write = async () => {};
  return { agy, saved };
}

test("F128: AGY 전환이 자격 증명을 바꾼 뒤 재시작만 실패하면 성공으로 보고하고 목록을 갱신하며 사유를 알린다", async (t) => {
  const { switching, state } = makeSwitching(t);
  const { agy, saved } = seedAgyProfile(switching);
  agy.restart = async () => { throw new Error("AGY 실행 파일을 찾지 못했습니다."); };

  assert.equal(await switching.switchProviderAccount("agy", saved.key), true);
  assert.equal(state.trayRefreshes, 1, "트레이/목록을 새로 고친다");
  assert.equal(agy.store.get(saved.key) != null, true);
  assert.ok(state.notices.some((text) => /전환했지만[\s\S]*다시 실행하지 못했어요[\s\S]*실행 파일을 찾지 못했습니다/.test(text)));
});

test("F128: 전환 검증 실패(자격 증명 무변경)는 여전히 실패로 던진다", async (t) => {
  const { switching, state } = makeSwitching(t);
  await assert.rejects(() => switching.switchProviderAccount("agy", "없는-키"), /저장된 AGY 계정을 찾지 못했습니다/);
  assert.equal(state.trayRefreshes, 0);
});

test("F128: AGY 계정 추가가 로그인을 지운 뒤 재시작에 실패하면 지웠다는 사실을 알리고 목록을 갱신한다", async (t) => {
  const { switching, state } = makeSwitching(t);
  const agy = switching.antigravityAccountSwitcher;
  agy.read = async () => { throw new Error("live 없음"); };
  agy.clear = async () => {};
  agy.restart = async () => { throw new Error("AGY 실행 파일을 찾지 못했습니다."); };

  await assert.rejects(
    () => switching.startProviderLogin("agy"),
    /로그인 정보는 지웠지만[\s\S]*직접 열어[\s\S]*실행 파일을 찾지 못했습니다/
  );
  assert.equal(state.trayRefreshes, 1);
});

test("F129: Codex 전환이 실패하면 먼저 끈 Codex Desktop을 다시 띄우고 안내한다", async (t) => {
  const { switching, state } = makeSwitching(t);
  switching.codexAccountSwitcher.switchToProfile = () => { throw new Error("저장된 Codex 계정을 찾지 못했습니다."); };

  assert.equal(await switching.switchCodexAccount("낡은-키"), false);
  assert.equal(state.stopped, 1);
  assert.equal(state.launched, 1, "꺼 둔 앱을 다시 띄운다");
  assert.ok(state.notices.some((text) => /전환에 실패했습니다[\s\S]*다시 실행을 요청했습니다/.test(text)));
});

test("F129: 다시 띄우기도 실패하면 직접 열라고 알린다", async (t) => {
  const { switching, state } = makeSwitching(t);
  state.launchFails = true;
  switching.codexAccountSwitcher.switchToProfile = () => { throw new Error("백업 실패"); };

  assert.equal(await switching.switchCodexAccount("k"), false);
  assert.ok(state.notices.some((text) => /백업 실패[\s\S]*직접 열어 주세요[\s\S]*실행 불가/.test(text)));
});

test("Claude live 저장소를 주입하면 Keychain 같은 비파일 저장소도 같은 경로로 로그아웃된다(macOS 시뮬레이션)", async (t) => {
  const calls = [];
  const fakeKeychain = {
    kind: "keychain",
    read: () => ({ claudeAiOauth: { refreshToken: "r", accessToken: "a" } }),
    write: () => calls.push("write"),
    clear: () => { calls.push("clear"); return true; },
  };
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-kc-")));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const switching = createAccountSwitching({
    claudeLiveStore: fakeKeychain,
    electron: { app: { getPath: () => home }, shell: { openPath: async () => "" } },
    openChatWindow: () => {},
    refreshTrayMenu: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    getChatFeature: () => ({
      notifyProviderAccountChanged: async (provider) => ({ providerId: provider, token: "t", complete: () => true }),
      showSystemNotice: () => {},
    }),
  });
  assert.equal(switching.claudeLiveStore, fakeKeychain);
  const result = await switching.logoutProvider("claude");
  assert.equal(result.live, true);
  assert.deepEqual(calls, ["clear"]);
});
