// F118: Claude 계정 전환 직후 갱신이 옛 email로 새 계정 자격 증명을 저장해 다른 프로필을 덮어쓰던 문제.
// main.js loadClaudeProvider와 같은 호출(auth status의 email -> snapshotCurrent)을 실제 모듈로 재현한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");
const { ProviderProfileStore, atomicWrite } = require("../src/provider-profile-store");

const secret = (rt, exp) => ({
  claudeAiOauth: { accessToken: `at-${rt}`, refreshToken: rt, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: exp },
});
const SA = secret("rt-A", 1_790_000_000_000);
const SB = secret("rt-B", 1_791_000_000_000);

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f118-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const credPath = path.join(home, ".claude", ".credentials.json");
  const cfgPath = path.join(home, ".claude.json");
  const cliWritesConfig = (email) =>
    fs.writeFileSync(cfgPath, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  // claude auth status --json은 ~/.claude.json의 email을 그대로 돌려준다.
  const authStatusEmail = () => JSON.parse(fs.readFileSync(cfgPath, "utf8")).oauthAccount.emailAddress;
  const switcher = new ClaudeAccountSwitcher({ home });
  const loadClaudeProvider = () => {
    switcher.snapshotCurrent({ email: authStatusEmail() });
    switcher.snapshotCurrent({ email: authStatusEmail() });
  };
  const stored = () =>
    Object.fromEntries(switcher.store.records().map((r) => [r.email, r.secret.claudeAiOauth.refreshToken]));
  return { credPath, cliWritesConfig, authStatusEmail, switcher, loadClaudeProvider, stored };
}

test("전환 직후 설정 갱신이 옛 계정 프로필을 새 계정 자격 증명으로 덮어쓰지 않는다", async (t) => {
  const { credPath, cliWritesConfig, authStatusEmail, switcher, loadClaudeProvider, stored } = setup(t);
  atomicWrite(credPath, SA);
  cliWritesConfig("a@x.com");
  loadClaudeProvider();
  atomicWrite(credPath, SB);
  cliWritesConfig("b@x.com");
  switcher.snapshotCurrent({ email: authStatusEmail() });
  const keyA = switcher.store.records().find((r) => r.email === "a@x.com").key;
  const keyB = switcher.store.records().find((r) => r.email === "b@x.com").key;

  await switcher.switchToProfile(keyA); // settings:account 전환
  cliWritesConfig("b@x.com"); // CLI는 아직 옛 email(B)을 돌려준다
  loadClaudeProvider(); // 곧바로 이어지는 getSettingsData
  assert.deepEqual(stored(), { "a@x.com": "rt-A", "b@x.com": "rt-B" });

  await switcher.switchToProfile(keyB); // 연속 전환: email 출처는 여전히 B로 남음
  cliWritesConfig("b@x.com");
  await switcher.switchToProfile(keyA);
  loadClaudeProvider();
  assert.deepEqual(stored(), { "a@x.com": "rt-A", "b@x.com": "rt-B" });
  assert.equal(switcher.current().claudeAiOauth.refreshToken, "rt-A");
});

test("저장소는 다른 email로 이미 저장된 자격 증명을 다른 프로필에 쓰지 않는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f118-store-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new ProviderProfileStore("claude", home);
  store.save({ secret: SA, email: "a@x.com", active: true });
  store.save({ secret: SB, email: "b@x.com" });
  const saved = store.save({ secret: SB, email: "a@x.com", active: true });
  assert.equal(saved.email, "b@x.com");
  const rows = Object.fromEntries(store.records().map((r) => [r.email, r.secret.claudeAiOauth.refreshToken]));
  assert.deepEqual(rows, { "a@x.com": "rt-A", "b@x.com": "rt-B" });
});

test("같은 email의 재로그인과 토큰 회전은 여전히 한 프로필로 병합된다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "f118-relogin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new ProviderProfileStore("claude", home);
  store.save({ secret: SA, email: "a@x.com", active: true });
  store.save({ secret: secret("rt-A2", 1_795_000_000_000), email: "a@x.com", active: true });
  assert.equal(store.records().length, 1);
  assert.equal(store.records()[0].secret.claudeAiOauth.refreshToken, "rt-A2");
});
