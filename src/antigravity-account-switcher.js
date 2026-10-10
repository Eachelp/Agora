const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ProviderProfileStore,
  atomicWrite,
  safeProfile,
} = require("./provider-profile-store");

class AntigravityAccountSwitcher {
  constructor({
    home = null,
    store,
    read = async () => null,
    write = async () => {},
    clear = async () => {},
    restart = async () => {},
  } = {}) {
    const liveHome = home || os.homedir();
    this.store = store || new ProviderProfileStore("antigravity", home);
    this.read = read;
    this.write = write;
    this.clear = clear;
    this.restart = restart;
    this.accountFile = path.join(liveHome, ".gemini", "google_accounts.json");
  }

  async snapshotCurrent(meta = {}) {
    const secret = await this.read();
    if (!secret?.token?.refresh_token) {
      throw new Error("AGY 로그인 정보를 찾지 못했습니다.");
    }
    return this.store.save({
      secret,
      email: meta.email || this.currentAccountHint(),
      plan: meta.plan,
      active: true,
    });
  }

  listProfiles() {
    return this.store.list();
  }

  deleteProfile(key) {
    return this.store.delete(key);
  }

  // 이 PC에서 로그아웃한다. OS 자격 저장소의 인증(clear)과 로컬 계정 파일을 지우고,
  // 저장된 현재 프로필도 지운다. 다른 기기 로그인은 건드리지 않는다.
  // 저장소에 인증이 없을 때 clear는 정상 종료한다. 던졌다면 진짜 실패이므로 그대로 알리고,
  // 아직 로그인 상태인데 프로필만 사라지지 않게 거기서 멈춘다.
  async logout() {
    try {
      await this.clear();
    } catch (error) {
      throw new Error(`AGY 로그인 정보를 지우지 못했습니다: ${error?.message || error}`);
    }
    this.forgetAccountFile();
    const removed = this.store.removeActive();
    return { live: true, removedProfile: Boolean(removed) };
  }

  // 반납용: 라이브 인증 + 계정 파일 + 이 PC의 모든 저장 프로필을 지운다.
  // 라이브 삭제가 실패해도 나머지는 계속 지우고, 끝에서 실패를 알린다.
  async wipeAll() {
    let failure = null;
    try {
      await this.clear();
    } catch (error) {
      failure = error;
    }
    this.forgetAccountFile();
    const removed = this.store.clearAll();
    if (failure) {
      throw new Error(`AGY 로그인 정보를 지우지 못했습니다: ${failure?.message || failure}`);
    }
    return { live: true, removedProfiles: removed };
  }

  // ~/.gemini/google_accounts.json(로컬 계정 캐시)을 지운다. 없으면 조용히 넘어간다.
  forgetAccountFile() {
    try {
      require("node:fs").rmSync(this.accountFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  currentAccountHint() {
    try {
      const current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
      return typeof current?.active === "string" && current.active.trim()
        ? current.active.trim()
        : null;
    } catch {
      return null;
    }
  }

  clearAccountHint() {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
    } catch {
      return;
    }
    const old = [...new Set([...(Array.isArray(current.old) ? current.old : []), current.active])]
      .filter(Boolean);
    const { active: _active, ...rest } = current;
    atomicWrite(this.accountFile, { ...rest, old });
  }

  updateAccountHint(email) {
    if (!email) return;
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(this.accountFile, "utf8"));
    } catch {
      // 파일이 없으면 새로 만듭니다.
    }
    const old = [...new Set([...(Array.isArray(current.old) ? current.old : []), current.active])]
      .filter((value) => value && value !== email);
    atomicWrite(this.accountFile, { ...current, active: email, old });
  }

  async switchToProfile(key) {
    const profile = this.store.get(key);
    if (!profile?.secret?.token?.refresh_token) {
      // live credential 변경 전 검증 실패: credential이 그대로임을 호출자에게 알린다
      // (Stage C account lifecycle이 불필요한 invalidation을 만들지 않도록).
      const error = new Error("저장된 AGY 계정을 찾지 못했습니다.");
      error.accountSwitchSafe = true;
      throw error;
    }
    try {
      await this.snapshotCurrent();
    } catch {
      // 현재 로그인이 없더라도 저장된 프로필로 복구할 수 있습니다.
    }
    await this.write(profile.secret);
    this.store.setActive(key);
    this.updateAccountHint(profile.email);
    await this.restart();
    return safeProfile(profile, true);
  }

  async prepareLogin(meta = {}) {
    // 새 로그인 전에 현재 자격 증명이 프로필에 저장돼야 되돌아올 수 있습니다.
    let current = null;
    try {
      current = await this.read();
    } catch {
      // 첫 로그인처럼 live 자격 증명이 없으면 저장 단계만 건너뜁니다.
    }
    try {
      if (current?.token?.refresh_token) {
        this.store.save({ secret: current, email: meta.email, plan: meta.plan, active: true });
      }
    } catch (error) {
      // clear() 시작 전 실패: live credential이 확실히 그대로다(accountSwitchSafe).
      error.accountSwitchSafe = true;
      throw error;
    }
    try {
      await this.clear();
      this.clearAccountHint();
      this.store.clearActive();
      await this.restart();
    } catch (error) {
      // clear()가 시도된 이후의 모든 실패(restart 실패 포함)는 live 계정 상태가
      // 부분 변경됐을 수 있으므로 accountSwitchSafe를 절대 갖지 않는다.
      if (error && typeof error === "object") error.accountSwitchSafe = false;
      throw error;
    }
    return true;
  }
}

module.exports = { AntigravityAccountSwitcher };
