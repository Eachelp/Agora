"use strict";

// 계정 전환 경계 seam.
//
// 검증 목표:
//   - chat-ipc: workspace choose/clear가 프로젝트 폴더를 바꾸고,
//     chatFeature.notifyProviderAccountChanged가 provider별 전환 가드(겹침 거부 + complete)를 연다.
//   - account switcher들의 사전 검증 실패는 accountSwitchSafe로 표시된다
//     (credential 무변경 실패 → 불필요한 invalidation 금지의 근거 fact).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatFeature } = require("../src/chat/chat-ipc");
const { ClaudeAccountSwitcher } = require("../src/claude-account-switcher");
const { AntigravityAccountSwitcher } = require("../src/antigravity-account-switcher");
const { CodexAccountSwitcher } = require("../src/codex-account-switcher");

// ---- chat-ipc: workspace / provider account seam ----

function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "",
    commandPath: null, needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "",
    installUrl: null, loginCommand: null,
  };
}

function fakeCapabilities() {
  const records = [fakeRecord("claude")];
  return {
    defs: records.map((record) => ({ id: record.id })),
    getRecord: (id) => records.find((record) => record.id === id) || null,
    discover: async () => records,
  };
}

function makeFeature(root, dialogResult) {
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return dialogResult; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(),
    harnessAdapter: { runTurn: () => ({ promise: Promise.resolve({ ok: true }), cancel: () => {} }) },
  });
  feature.registerIpcHandlers();
  return {
    feature,
    invoke: async (channel, input = {}) => handlers.get(channel)({}, input),
  };
}

test("chat-ipc: project workspace choose/clear는 프로젝트 폴더를 바꾸고 해제한다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-ipc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-ws-")));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { invoke } = makeFeature(root, { canceled: false, filePaths: [ws] });
  const created = await invoke("chat:projects:create", { name: "P" });
  assert.equal(created.ok, true);
  const projectId = created.activeProjectId;

  const chosen = await invoke("chat:projects:workspace:choose", { projectId });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.project.workspace, ws);

  const cleared = await invoke("chat:projects:workspace:clear", { projectId });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.project.workspace, null);
});

// legacy 세션 경로(chat:workspace:choose/clear)도 같은 ProjectStore.workspace를 바꾼다.
test("legacy chat:workspace:choose/clear도 프로젝트 폴더를 바꾸고 해제한다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-legacy-ws-ipc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-legacy-ws-dir-")));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { invoke } = makeFeature(root, { canceled: false, filePaths: [ws] });
  const created = await invoke("chat:projects:create", { name: "P" });
  assert.equal(created.ok, true);
  const session = await invoke("chat:sessions:create", {});
  assert.equal(session.ok, true);
  const sessionId = session.session.meta.id;

  const chosen = await invoke("chat:workspace:choose", { sessionId });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.meta.workspace, ws);

  const cleared = await invoke("chat:workspace:clear", { sessionId });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.meta.workspace, null);
});

test("취소된 legacy choose는 폴더를 바꾸지 않는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-legacy-ws-cancel-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { invoke } = makeFeature(root, { canceled: true, filePaths: [] });
  const created = await invoke("chat:projects:create", { name: "P" });
  assert.equal(created.ok, true);
  const session = await invoke("chat:sessions:create", {});
  const sessionId = session.session.meta.id;

  const chosen = await invoke("chat:workspace:choose", { sessionId });
  assert.equal(chosen.ok, true);
  assert.equal(chosen.canceled, true);
});

test("chatFeature.notifyProviderAccountChanged는 complete()로 닫는 전환 handle을 돌려준다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-acct-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { feature } = makeFeature(root, { canceled: true, filePaths: [] });
  assert.equal(typeof feature.notifyProviderAccountChanged, "function");

  const result = await feature.notifyProviderAccountChanged("codex");
  assert.equal(result.providerId, "codex");
  assert.equal(typeof result.complete, "function");
  assert.equal(result.complete(), true);
  assert.equal(result.complete(), false, "이미 닫힌 전환을 다시 닫아도 무해하다");

  // providerId 없는 호출은 조용히 무시되지 않는다(fail-closed): 호출자 버그다.
  await assert.rejects(
    () => feature.notifyProviderAccountChanged(null),
    /providerId가 필요/
  );
});

test("같은 provider의 전환이 열려 있으면 두 번째는 거부되고, 다른 provider와 complete 뒤에는 열린다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-overlap-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { feature } = makeFeature(root, { canceled: true, filePaths: [] });

  const first = await feature.notifyProviderAccountChanged("claude");
  await assert.rejects(
    () => feature.notifyProviderAccountChanged("claude"),
    (error) => {
      assert.match(error.message, /계정 전환이 이미 진행 중/);
      assert.equal(error.accountSwitchSafe, true, "겹침 거부는 credential 무변경이 확실하다");
      return true;
    }
  );

  const other = await feature.notifyProviderAccountChanged("codex");
  assert.equal(other.complete(), true, "다른 provider는 서로 막지 않는다");

  assert.equal(first.complete(), true);
  const again = await feature.notifyProviderAccountChanged("claude");
  assert.equal(again.complete(), true, "complete 뒤에는 다시 열 수 있다");
});

test("오래된 handle의 complete는 더 새 전환을 닫지 못한다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-lifecycle-stale-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { feature } = makeFeature(root, { canceled: true, filePaths: [] });

  const old = await feature.notifyProviderAccountChanged("agy");
  assert.equal(old.complete(), true);
  const fresh = await feature.notifyProviderAccountChanged("agy");
  assert.equal(old.complete(), false, "늦게 온 stale complete는 무시된다");
  await assert.rejects(() => feature.notifyProviderAccountChanged("agy"), /이미 진행 중/);
  assert.equal(fresh.complete(), true);
});

test("account-switching source: 모든 credential mutation 경로가 awaitable boundary 뒤에 있다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "agora", "account-switching.js"), "utf8");
  assert.match(source, /async function installAccountBoundary\(provider\)/);
  assert.match(source, /async function installAccountBoundaryOrFail\(provider\)/);
  assert.match(source, /await chatFeature\.notifyProviderAccountChanged\(provider\)/);

  // boundary는 반드시 await된다 — fire-and-forget 호출이 남아 있으면 안 된다.
  // (선언부 `async function installAccountBoundaryOrFail(provider)`는 제외한다.)
  const calls = source.match(/(?<!function )installAccountBoundaryOrFail\(/g) || [];
  assert.ok(calls.length >= 6, `모든 mutation 경로가 boundary를 거쳐야 한다(현재 ${calls.length})`);
  const awaited = source.match(/await installAccountBoundaryOrFail\(/g) || [];
  assert.equal(awaited.length, calls.length, "boundary 호출은 예외 없이 await되어야 한다");

  // 열린 전환 트랜잭션은 반드시 finally에서 닫힌다(영구히 막힌 provider 금지).
  assert.match(source, /function completeAccountBoundary\(boundary, provider\)/);
  const completes = source.match(/(?<!function )completeAccountBoundary\(/g) || [];
  assert.ok(
    completes.length >= calls.length,
    `boundary를 여는 모든 경로가 전환을 닫아야 한다(현재 ${completes.length} < ${calls.length})`
  );
  // 주석이 끼어들 수 있으므로 finally 블록 안에 있는지만 확인한다.
  const finallyBlocks = source.match(/finally \{[\s\S]{0,300}?completeAccountBoundary\(/g) || [];
  assert.equal(
    finallyBlocks.length, calls.length,
    "전환 종료는 예외 경로에서도 실행되도록 finally에 있어야 한다"
  );

  // 삼키는 seam으로 되돌아가지 않았는지.
  assert.doesNotMatch(source, /function notifyAccountLifecycle/, "fail-open seam은 제거되었다");
});

// ---- account switcher 사전 검증 실패 fact ----

test("Claude/AGY/Codex switcher의 사전 검증 실패는 accountSwitchSafe=true를 표시한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agora-switch-safe-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const claude = new ClaudeAccountSwitcher({ home });
  await assert.rejects(
    () => claude.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "Claude 검증 실패는 credential 무변경 fact");
      return true;
    }
  );

  const agy = new AntigravityAccountSwitcher({
    home,
    read: async () => null,
    write: async () => {},
    clear: async () => {},
    restart: async () => {},
  });
  await assert.rejects(
    () => agy.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "AGY 검증 실패는 credential 무변경 fact");
      return true;
    }
  );

  const codex = new CodexAccountSwitcher({ homeDir: home });
  assert.throws(
    () => codex.switchToProfile("missing-profile"),
    (error) => {
      assert.equal(error.accountSwitchSafe, true, "Codex 검증 실패는 credential 무변경 fact");
      return true;
    }
  );
});
