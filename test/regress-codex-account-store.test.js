"use strict";

// F122 AGORA_HOME이 홈 밖이어도 Codex 저장소 삭제가 거부되지 않는다.
// F123 로그아웃은 active 표시가 아니라 라이브 계정의 저장 프로필을 지운다.
// F125 시작·전환 때 라이브 사본이 더 새 프로필 사본(프록시가 갱신)을 덮어쓰지 않는다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodexAccountSwitcher } = require("../src/codex-account-switcher");

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function auth(email, { refresh = "r", lastRefresh } = {}) {
  const claims = { chatgpt_account_id: `ws-${email}`, chatgpt_plan_type: "plus" };
  return {
    auth_mode: "chatgpt",
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
    tokens: {
      account_id: claims.chatgpt_account_id,
      access_token: jwt({ sub: `sub-${email}`, email }),
      refresh_token: refresh,
      id_token: jwt({ sub: `sub-${email}`, email, "https://api.openai.com/auth": claims }),
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function makeSwitcher(t, { outsideHome = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-codex-store-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const agoraHome = outsideHome ? path.join(root, "AgoraData") : path.join(homeDir, ".agora");
  return { switcher: new CodexAccountSwitcher({ homeDir, agoraHome }), homeDir, agoraHome };
}

test("F122: AGORA_HOME이 홈 밖이어도 백업 정리가 던지지 않고 20개로 유지된다", (t) => {
  const { switcher } = makeSwitcher(t, { outsideHome: true });
  writeJson(switcher.targetAuthPath, auth("a@x.com"));
  switcher.ensureDirs();
  for (let i = 0; i < 25; i += 1) {
    fs.mkdirSync(path.join(switcher.backupsRoot, `2026010${String(i).padStart(2, "0")}-000000`), { recursive: true });
  }
  assert.doesNotThrow(() => switcher.createBackup(new Date()));
  assert.equal(fs.readdirSync(switcher.backupsRoot).length, 20);
});

test("F122: AGORA_HOME이 홈 밖이어도 이미 저장된 계정으로 다시 로그인하면 pending 폴더가 정리된다", (t) => {
  const { switcher } = makeSwitcher(t, { outsideHome: true });
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com", { refresh: "old" }));
  const pending = switcher.createLoginProfile();
  writeJson(path.join(pending.homePath, "auth.json"), auth("a@x.com", { refresh: "new" }));

  const profiles = switcher.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(fs.existsSync(pending.homePath), false, "병합된 pending 폴더는 사라진다");
  assert.equal(switcher.listProfiles().length, 1, "다음 목록 조회도 던지지 않는다");
});

test("F122: AGORA_HOME이 홈 밖이어도 로그아웃과 전체 지우기가 끝까지 동작한다", (t) => {
  const { switcher } = makeSwitcher(t, { outsideHome: true });
  writeJson(switcher.targetAuthPath, auth("a@x.com"));
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com"));
  switcher.writeActiveProfileKey("a");

  const result = switcher.logout();
  assert.equal(result.live, true);
  assert.equal(fs.existsSync(switcher.targetAuthPath), false);
  assert.equal(fs.existsSync(switcher.activePath), false);

  writeJson(switcher.profileAuthPath("b"), auth("b@x.com"));
  switcher.wipeAll();
  assert.equal(fs.existsSync(switcher.switchHome), false);
});

test("F122: 홈 밖·저장소 밖 경로는 여전히 지우지 않는다", (t) => {
  const { switcher } = makeSwitcher(t, { outsideHome: true });
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "agora-stranger-"));
  t.after(() => fs.rmSync(stranger, { recursive: true, force: true }));
  assert.throws(() => switcher.removePathIfInsideHome(stranger), /홈 디렉터리 밖/);
  assert.ok(fs.existsSync(stranger));
});

test("F123: 로그아웃은 active 표시가 가리키는 계정이 아니라 라이브 계정의 프로필을 지운다", (t) => {
  const { switcher } = makeSwitcher(t);
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com"));
  writeJson(switcher.profileAuthPath("b"), auth("b@x.com"));
  // 실행 중인 Codex 앱이 A 토큰을 라이브에 되써서, 표시(B)와 라이브(A)가 어긋난 상태.
  writeJson(switcher.targetAuthPath, auth("a@x.com"));
  switcher.writeActiveProfileKey("b");

  const result = switcher.logout();
  assert.equal(result.live, true);
  assert.equal(result.removedProfile, true);
  assert.equal(fs.existsSync(switcher.profileDir("a")), false, "로그아웃한 A의 저장 로그인이 지워진다");
  assert.equal(fs.existsSync(switcher.profileDir("b")), true, "다른 계정 B는 그대로다");
});

test("F123: 라이브 인증이 없으면 active 표시의 프로필을 지운다", (t) => {
  const { switcher } = makeSwitcher(t);
  writeJson(switcher.profileAuthPath("b"), auth("b@x.com"));
  switcher.writeActiveProfileKey("b");
  const result = switcher.logout();
  assert.equal(result.live, false);
  assert.equal(fs.existsSync(switcher.profileDir("b")), false);
});

test("F125: 프록시가 갱신해 더 새로운 프로필 사본을 오래된 라이브 사본이 덮어쓰지 않는다", (t) => {
  const { switcher } = makeSwitcher(t);
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com", { refresh: "R2", lastRefresh: "2026-10-11T10:00:00.000Z" }));
  writeJson(switcher.targetAuthPath, auth("a@x.com", { refresh: "R1", lastRefresh: "2026-10-11T08:00:00.000Z" }));

  switcher.ensureCurrentAccountProfile();
  const stored = JSON.parse(fs.readFileSync(switcher.profileAuthPath("a"), "utf8"));
  assert.equal(stored.tokens.refresh_token, "R2");
});

test("F125: 라이브가 더 새로우면 (Codex CLI가 먼저 갱신) 프로필 사본을 갱신한다", (t) => {
  const { switcher } = makeSwitcher(t);
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com", { refresh: "R1", lastRefresh: "2026-10-11T08:00:00.000Z" }));
  writeJson(switcher.targetAuthPath, auth("a@x.com", { refresh: "R2", lastRefresh: "2026-10-11T10:00:00.000Z" }));

  switcher.ensureCurrentAccountProfile();
  const stored = JSON.parse(fs.readFileSync(switcher.profileAuthPath("a"), "utf8"));
  assert.equal(stored.tokens.refresh_token, "R2");
});

test("F125: 계정 전환 때도 더 새로운 프로필 사본이 유지된다", (t) => {
  const { switcher } = makeSwitcher(t);
  writeJson(switcher.profileAuthPath("a"), auth("a@x.com", { refresh: "R2", lastRefresh: "2026-10-11T10:00:00.000Z" }));
  writeJson(switcher.profileAuthPath("b"), auth("b@x.com"));
  writeJson(switcher.targetAuthPath, auth("a@x.com", { refresh: "R1", lastRefresh: "2026-10-11T08:00:00.000Z" }));

  switcher.switchToProfile("b");
  const stored = JSON.parse(fs.readFileSync(switcher.profileAuthPath("a"), "utf8"));
  assert.equal(stored.tokens.refresh_token, "R2");
});
