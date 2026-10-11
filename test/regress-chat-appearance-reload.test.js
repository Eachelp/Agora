"use strict";

// 창을 새로고침(Ctrl+R)하면 main은 화면 설정을 다시 밀어 주지 않아 제목줄·보내기 버튼 색이 기본 파랑으로 돌아갔다.
// 렌더러가 시작할 때 저장된 설정을 직접 가져오는지 본다: IPC(진입점) → preload 연결 → 렌더러 적용 순서.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createChatFeature } = require("../src/chat/chat-ipc");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("chat:appearance:get은 main이 주입한 저장된 화면 설정을 돌려준다", async (t) => {
  const handlers = new Map();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-appearance-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const saved = { fontFamily: "", fontSize: 14, uiTheme: { accent: "#aa3366" }, showAwaiting: true };
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: {}, BrowserWindow: class {}, shell: {},
    },
    storeRoot: root,
    getAppearance: () => saved,
  });
  feature.registerIpcHandlers();
  const result = await handlers.get("chat:appearance:get")({}, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.appearance, saved);
  feature.shutdown?.();

  // 주입이 없으면 오류가 아니라 '설정 없음'이다.
  const bare = new Map();
  const other = createChatFeature({
    electron: { ipcMain: { handle: (channel, handler) => bare.set(channel, handler), on() {} }, dialog: {}, BrowserWindow: class {}, shell: {} },
    storeRoot: root,
  });
  other.registerIpcHandlers();
  assert.deepEqual(await bare.get("chat:appearance:get")({}, {}), { ok: true, appearance: null });
  other.shutdown?.();
});

test("preload와 main이 같은 채널로 연결된다", () => {
  assert.match(read("src/chat-preload.js"), /APPEARANCE_GET: "chat:appearance:get"/);
  assert.match(read("src/chat-preload.js"), /appearanceGet: \(\) => ipcRenderer\.invoke\(INVOKE\.APPEARANCE_GET\)/);
  assert.match(read("src/main.js"), /getAppearance: getAppearancePayload/);
});

function loadRenderer() {
  const source = read("src/chat.js");
  const from = source.indexOf("let appearancePushed = false;");
  const to = source.indexOf("// --- 사용량", from);
  assert.ok(from >= 0 && to > from);
  const applied = [];
  let push = null;
  let resolvePull = null;
  const context = {
    applied,
    window: {
      chatApi: {
        onAppearance: (handler) => { push = handler; },
        appearanceGet: () => new Promise((resolve) => { resolvePull = resolve; }),
      },
    },
    call: (promise) => promise,
    applyAppearance: (appearance) => applied.push(appearance),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(from, to), context);
  return { applied, push: (value) => push(value), pull: (value) => resolvePull(value) };
}

test("시작할 때 저장된 화면 설정을 가져와 적용한다", async () => {
  const view = loadRenderer();
  view.pull({ ok: true, appearance: { uiTheme: { accent: "#aa3366" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(view.applied, [{ uiTheme: { accent: "#aa3366" } }]);
});

test("가져오는 사이 더 새 설정이 밀려왔으면 옛 값으로 덮지 않는다", async () => {
  const view = loadRenderer();
  view.push({ uiTheme: { accent: "#00ff00" } });
  view.pull({ ok: true, appearance: { uiTheme: { accent: "#aa3366" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(view.applied, [{ uiTheme: { accent: "#00ff00" } }]);
});
