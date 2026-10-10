"use strict";

// F124: 로그아웃/전체 지우기가 라이브 자격 증명 삭제 실패를 삼키고 성공으로 보고하던 문제.
// 실제 createAccountSwitching의 logoutProvider/wipeAllAccounts(=main.js IPC가 부르는 곳)에서 시작한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAccountSwitching } = require("../src/agora/account-switching");

function makeSwitching(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-wipe-")));
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
  const switching = createAccountSwitching({
    codexDesktop: { stop: async () => {}, launch: async () => ({ skipped: true }) },
    electron: {
      app: { getPath: () => userData },
      shell: { openPath: async () => "", openExternal: async () => {} },
    },
    openChatWindow: () => {},
    refreshTrayMenu: () => {},
    readSettings: () => ({}),
    writeSettings: () => {},
    cliLogin: {},
    notifyAccountLogin: () => {},
    getChatFeature: () => ({
      notifyProviderAccountChanged: async (provider) => ({ providerId: provider, token: `t-${provider}`, complete: () => true }),
      showSystemNotice: () => {},
    }),
  });
  // 이 PC의 실제 OS 자격 저장소를 건드리지 않게 AGY clear를 막아 둔다.
  switching.antigravityAccountSwitcher.clear = async () => {};
  return { switching, home };
}

// 파일이 아니라 비어 있지 않은 폴더로 만들어 rmSync(force)가 던지게 한다(잠금·권한 실패 흉내).
function blockClaudeLive(home) {
  const dir = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "keep"), "x");
  return dir;
}

function seedClaudeProfile(switching) {
  const store = switching.claudeAccountSwitcher.store;
  store.save({ secret: { claudeAiOauth: { refreshToken: "r", accessToken: "a" } }, email: "me@x.com", active: true });
  return store;
}

test("Claude 로그아웃: 라이브 자격 증명을 지우지 못하면 실패를 던지고 저장 프로필도 남긴다", async (t) => {
  const { switching, home } = makeSwitching(t);
  blockClaudeLive(home);
  const store = seedClaudeProfile(switching);
  await assert.rejects(switching.logoutProvider("claude"), /Claude 로그인 파일을 지우지 못했습니다/);
  assert.equal(store.list().length, 1, "아직 로그인 상태이므로 프로필은 그대로다");
});

test("AGY 로그아웃: 자격 저장소 삭제가 실패하면 실패를 던진다", async (t) => {
  const { switching } = makeSwitching(t);
  switching.antigravityAccountSwitcher.clear = async () => { throw new Error("PowerShell 시간 초과"); };
  await assert.rejects(switching.logoutProvider("agy"), /AGY 로그인 정보를 지우지 못했습니다: PowerShell 시간 초과/);
});

test("전체 지우기: Claude·AGY 라이브 삭제 실패를 failures로 알리고 프로필은 계속 지운다", async (t) => {
  const { switching, home } = makeSwitching(t);
  blockClaudeLive(home);
  const claudeStore = seedClaudeProfile(switching);
  const agyStore = switching.antigravityAccountSwitcher.store;
  agyStore.save({ secret: { token: { refresh_token: "r" } }, email: "g@x.com", active: true });
  switching.antigravityAccountSwitcher.clear = async () => { throw new Error("CredDelete 오류"); };

  const { failures, results } = await switching.wipeAllAccounts();
  assert.equal(failures.length, 2, JSON.stringify(failures));
  assert.match(failures.find((f) => f.startsWith("claude:")), /Claude 로그인 파일을 지우지 못했습니다/);
  assert.match(failures.find((f) => f.startsWith("agy:")), /CredDelete 오류/);
  assert.ok(results.codex, "실패한 provider가 있어도 Codex는 지운다");
  assert.equal(claudeStore.list().length, 0, "저장 프로필은 계속 지운다");
  assert.equal(agyStore.list().length, 0);
});

test("전체 지우기: 모두 성공하면 failures가 비어 있다", async (t) => {
  const { switching } = makeSwitching(t);
  const { failures } = await switching.wipeAllAccounts();
  assert.deepEqual(failures, []);
});
