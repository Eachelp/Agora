"use strict";
// F139 휴지통 정리 실패가 저장소 시작을 막던 문제, F140 답변 중 삭제가 좀비 세션을 남기던 문제.
// Electron의 Windows fs 동작(읽기 전용 파일 EPERM, 열린 핸들 폴더의 ENOTEMPTY)은 시스템 Node에서
// 재현되지 않으므로 fs를 같은 모양으로 흉내 내고, 실제 IPC 핸들러(createChatFeature)로 부른다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatStore } = require("../src/chat/chat-store");

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
    defs: records.map((r) => ({ id: r.id })),
    getRecord: (id) => records.find((r) => r.id === id) || null,
    discover: async () => records,
  };
}

function makeFeature(root, harnessRuntime) {
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (c, h) => handlers.set(c, h), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(),
    ...(harnessRuntime ? { harnessRuntime } : {}),
  });
  feature.registerIpcHandlers();
  return { invoke: (c, i = {}) => handlers.get(c)({}, i) };
}

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-delete-")));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function hasReadOnlyFile(dir) {
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    try {
      const stat = fs.statSync(path.join(dir, rel));
      if (stat.isFile() && (stat.mode & 0o200) === 0) return true;
    } catch {}
  }
  return false;
}

// Electron(Windows)의 rmSync: 읽기 전용 속성 파일이 있으면 EPERM.
function patchReadOnlyRm() {
  const original = fs.rmSync;
  fs.rmSync = function patched(target, opts) {
    if (opts?.recursive && fs.existsSync(target) && fs.statSync(target).isDirectory() && hasReadOnlyFile(target)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rm '${target}'`), { code: "EPERM" });
    }
    return original.call(fs, target, opts);
  };
  return () => { fs.rmSync = original; };
}

test("F139: 휴지통의 읽기 전용 파일 때문에 정리가 실패해도 채팅 저장소는 정상 시작한다", async () => {
  const root = tempRoot();
  const restore = (() => {
    // 30일 지난 휴지통 항목을 만들고 안에 읽기 전용 파일을 둔다.
    const store = new ChatStore({ root }).init();
    const session = store.createSession({});
    store.deleteSession(session.id);
    const dir = path.join(root, "trash", session.id);
    fs.writeFileSync(path.join(dir, "trash.json"), JSON.stringify({ deletedAt: 1 }));
    fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
    const ro = path.join(dir, "checkpoints", "copy.txt");
    fs.writeFileSync(ro, "x");
    fs.chmodSync(ro, 0o444);
    return { id: session.id, dir };
  })();
  const unpatch = patchReadOnlyRm();
  try {
    const feature = makeFeature(root);
    const state = await feature.invoke("chat:state");
    assert.equal(state.ok, true);
    assert.equal(state.error, null, "저장소 초기화 오류 배너가 뜨면 안 된다");
    const sent = await feature.invoke("chat:sessions:create", {});
    assert.equal(sent.ok, true, "새 대화도 만들어져야 한다");
    // 속성을 풀고 다시 시도하므로 오래된 항목은 실제로 지워진다.
    assert.equal(fs.existsSync(restore.dir), false);
  } finally {
    unpatch();
    cleanup(root);
  }
});

test("F139: 어떤 이유로든 항목 하나를 못 지워도 저장소는 시작하고 항목은 남는다", async () => {
  const root = tempRoot();
  const store = new ChatStore({ root }).init();
  const session = store.createSession({});
  store.deleteSession(session.id);
  const dir = path.join(root, "trash", session.id);
  fs.writeFileSync(path.join(dir, "trash.json"), JSON.stringify({ deletedAt: 1 }));
  const original = fs.rmSync;
  const originalError = console.error;
  console.error = () => {};
  fs.rmSync = function patched(target, opts) {
    if (String(target).includes(session.id)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return original.call(fs, target, opts);
  };
  try {
    const feature = makeFeature(root);
    const state = await feature.invoke("chat:state");
    assert.equal(state.ok, true);
    assert.equal(state.error, null);
    assert.equal(fs.existsSync(path.join(dir, "meta.json")), true);
  } finally {
    fs.rmSync = original;
    console.error = originalError;
    cleanup(root);
  }
});

// 답변을 스트리밍하다 cancel이 오면 300ms 뒤 끝나는 가짜 harness. 끝나기 전에는 로그 파일이 열려 있다.
function makeStreamingHarness() {
  const runs = [];
  return {
    runs,
    runtime: {
      runTurn({ invocation }) {
        let resolve;
        const st = { settled: false };
        const promise = new Promise((r) => (resolve = r)).then((v) => { st.settled = true; return v; });
        runs.push(st);
        invocation.onRawChunk?.('{"type":"system","subtype":"init"}\n');
        const timer = setInterval(() => invocation.onRawChunk?.('{"delta":"..."}\n'), 30);
        return {
          promise,
          cancel: () => {
            clearInterval(timer);
            setTimeout(() => resolve({ ok: false, error: "cancelled", stopReason: "CANCELLED" }), 300);
          },
        };
      },
      workspaceChanged() {}, workspaceRestored() {}, providerAccountChanged() {},
      beginProviderAccountBoundary: async (p) => ({ providerId: p.providerId, token: "t", invalidated: 0 }),
      completeProviderAccountBoundary: () => true,
      professionalRunEnded() {},
      close() {},
    },
  };
}

// 실행이 끝나기 전(로그 핸들이 열린 동안)에는 Windows처럼 폴더 이동이 EPERM,
// 삭제는 일부만 지우고 ENOTEMPTY가 난다. isLocked()가 false가 되면 정상 동작한다.
function patchWindowsLock(sessionDirName, isLocked) {
  const { renameSync, rmSync } = fs;
  // 잠긴 것은 sessions/<id>뿐이다. 휴지통 사본에는 열린 핸들이 없다.
  const locked = (p) => path.basename(p) === sessionDirName && path.basename(path.dirname(p)) === "sessions" && isLocked();
  fs.renameSync = function patched(from, to) {
    if (locked(from)) {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return renameSync.call(fs, from, to);
  };
  fs.rmSync = function patched(target, opts) {
    if (locked(target) && fs.existsSync(target)) {
      for (const name of fs.readdirSync(target)) {
        if (name !== "run-logs") rmSync.call(fs, path.join(target, name), { recursive: true, force: true });
      }
      throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
    }
    return rmSync.call(fs, target, opts);
  };
  return () => { fs.renameSync = renameSync; fs.rmSync = rmSync; };
}

async function waitFor(cond, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("F140: 답변 중인 대화를 삭제하면 실행이 끝나길 기다린 뒤 온전히 휴지통으로 옮긴다", async () => {
  const root = tempRoot();
  const harness = makeStreamingHarness();
  const feature = makeFeature(root, harness.runtime);
  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sdir = path.join(root, "sessions", sessionId);
  const tdir = path.join(root, "trash", sessionId);
  const sent = await feature.invoke("chat:send", { sessionId, text: "@claude 긴 답변을 써줘" });
  assert.equal(sent.ok, true);
  await waitFor(() => harness.runs.length >= 1);
  await waitFor(() => fs.existsSync(path.join(sdir, "run-logs")) && fs.readdirSync(path.join(sdir, "run-logs")).some((n) => n.endsWith(".log")));
  const unpatch = patchWindowsLock(sessionId, () => !harness.runs[0].settled);
  try {
    const deleted = await feature.invoke("chat:sessions:delete", { sessionId });
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(fs.existsSync(sdir), false);
    assert.equal(fs.existsSync(path.join(tdir, "meta.json")), true);
    const info = JSON.parse(fs.readFileSync(path.join(tdir, "trash.json"), "utf8"));
    assert.ok(info.deletedAt > 0, "휴지통 시각이 기록돼야 30일 보관이 지켜진다");
    assert.equal((deleted.sessions || []).some((e) => e.id === sessionId), false);
  } finally {
    unpatch();
    cleanup(root);
  }
});

test("F140: 삭제가 끝내 실패하면 세션은 그대로 남고 오류가 보고된다(좀비 없음)", async () => {
  const root = tempRoot();
  const feature = makeFeature(root);
  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sdir = path.join(root, "sessions", sessionId);
  fs.mkdirSync(path.join(sdir, "run-logs"), { recursive: true });
  fs.writeFileSync(path.join(sdir, "run-logs", "r.log"), "log");
  fs.mkdirSync(path.join(sdir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(sdir, "attachments", "a.txt"), "att");
  const unpatch = patchWindowsLock(sessionId, () => true);
  try {
    const deleted = await feature.invoke("chat:sessions:delete", { sessionId });
    assert.equal(deleted.ok, false);
    assert.match(deleted.error, /ENOTEMPTY/);
    assert.equal(fs.existsSync(path.join(sdir, "meta.json")), true, "meta.json이 남아 있어야 한다");
    assert.equal(fs.existsSync(path.join(sdir, "attachments", "a.txt")), true, "지워진 첨부가 되살아나야 한다");
    assert.equal(fs.existsSync(path.join(sdir, "trash.json")), false);
    assert.equal(fs.existsSync(path.join(root, "trash", sessionId)), false, "반쪽 휴지통 사본이 남으면 안 된다");
    const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    assert.equal(index.sessions.some((e) => e.id === sessionId), true);
    const selected = await feature.invoke("chat:sessions:select", { sessionId });
    assert.equal(selected.ok, true);
    assert.ok(selected.session, "열면 내용이 있어야 한다");
  } finally {
    unpatch();
    cleanup(root);
  }
});

// R3: 실패한 첫 rmSync 뒤 속성을 풀 때 폴더에 0o666을 주면 POSIX에서 x(탐색) 비트가 사라져 다시 실패한다.
// Windows에는 이 권한 모델이 없어 재현되지 않는다. 그래서 win32(와 root)에서는 건너뛰며,
// 이 머신(Windows)에서는 실행해 보지 못했다 — POSIX 빌드에서 처음 검증된다.
test("R3: 쓰기 불가 하위 폴더가 든 오래된 휴지통 항목도 정리되고 저장소는 정상 시작한다",
  { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) },
  () => {
    const root = tempRoot();
    try {
      const store = new ChatStore({ root }).init();
      const session = store.createSession({});
      store.deleteSession(session.id);
      const dir = path.join(root, "trash", session.id);
      fs.writeFileSync(path.join(dir, "trash.json"), JSON.stringify({ deletedAt: 1 }));
      const sub = path.join(dir, "checkpoints");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, "copy.txt"), "x");
      fs.chmodSync(sub, 0o555); // 안의 파일을 지울 수 없어 첫 rmSync가 EACCES로 실패한다
      new ChatStore({ root }).init();
      assert.equal(fs.existsSync(dir), false, "속성을 푼 뒤 다시 시도해 실제로 지워져야 한다");
    } finally {
      try { for (const p of fs.readdirSync(root, { recursive: true })) { try { fs.chmodSync(path.join(root, p), 0o777); } catch {} } } catch {}
      cleanup(root);
    }
  });

// R3 (Windows에서도 도는 판): 속성을 풀 때 폴더에는 x 비트를 지키는 모드를, 파일에는 0o666을 준다.
test("R3: 첫 정리가 실패해 속성을 풀 때 폴더에 0o666을 주지 않는다", () => {
  const root = tempRoot();
  const calls = [];
  const chmod = fs.chmodSync;
  let unpatch = () => {};
  try {
    const store = new ChatStore({ root }).init();
    const session = store.createSession({});
    store.deleteSession(session.id);
    const dir = path.join(root, "trash", session.id);
    fs.writeFileSync(path.join(dir, "trash.json"), JSON.stringify({ deletedAt: 1 }));
    fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
    const ro = path.join(dir, "checkpoints", "copy.txt");
    fs.writeFileSync(ro, "x");
    fs.chmodSync(ro, 0o444);
    unpatch = patchReadOnlyRm();
    fs.chmodSync = function patched(target, mode) {
      calls.push([path.relative(dir, String(target)), mode]);
      return chmod.call(fs, target, mode);
    };
    new ChatStore({ root }).init();
    assert.equal(fs.existsSync(dir), false);
    const sub = calls.find(([rel]) => rel === "checkpoints");
    const file = calls.find(([rel]) => rel === path.join("checkpoints", "copy.txt"));
    assert.ok(sub && (sub[1] & 0o100) !== 0, "폴더는 탐색(x) 비트를 유지해야 한다");
    assert.equal(file && file[1], 0o666);
  } finally {
    fs.chmodSync = chmod;
    unpatch();
    cleanup(root);
  }
});

// R2: 실행이 끝나(liveRuns 0) 뒤에도 원본 로그 스트림은 잠시 더 열려 있다. Windows에서는 그동안 폴더를
// 옮기거나 지울 수 없으므로 삭제는 로그가 실제로 닫힐 때까지 기다려야 한다. 닫힘을 150ms 늦춰 그 틈을 만든다.
test("R2: 실행이 끝난 직후에도 원본 로그가 닫힐 때까지 기다린 뒤 삭제한다", async () => {
  const root = tempRoot();
  const harness = makeStreamingHarness();
  const feature = makeFeature(root, harness.runtime);
  const state = await feature.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const sdir = path.join(root, "sessions", sessionId);
  const streams = [];
  const createWriteStream = fs.createWriteStream;
  fs.createWriteStream = function patched(...args) {
    const stream = createWriteStream.apply(fs, args);
    const destroy = stream._destroy.bind(stream);
    stream._destroy = (error, cb) => setTimeout(() => destroy(error, cb), 150);
    streams.push(stream);
    return stream;
  };
  let unpatch = () => {};
  try {
    const sent = await feature.invoke("chat:send", { sessionId, text: "@claude 긴 답변을 써줘" });
    assert.equal(sent.ok, true);
    await waitFor(() => harness.runs.length >= 1 && streams.length >= 1);
    unpatch = patchWindowsLock(sessionId, () => streams.some((s) => !s.closed));
    const deleted = await feature.invoke("chat:sessions:delete", { sessionId });
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(fs.existsSync(sdir), false);
    assert.equal(fs.existsSync(path.join(root, "trash", sessionId, "meta.json")), true);
  } finally {
    fs.createWriteStream = createWriteStream;
    unpatch();
    cleanup(root);
  }
});
