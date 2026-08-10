const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-system-notice-"));
}

function makeFeature(root) {
  const sent = [];
  class FakeBrowserWindow {
    constructor() {
      this.webContents = { send: (channel, payload) => sent.push({ channel, payload }) };
      this.isDestroyed = () => false;
      this.show = () => {};
      this.focus = () => {};
      this.isMinimized = () => false;
      this.restore = () => {};
      this.on = () => {};
      this.once = () => {};
      this.setMenuBarVisibility = () => {};
      this.loadFile = () => {};
      this.close = () => {};
    }
  }
  const ipcMain = { handle() {}, on() {}, send() {} };
  const real = createChatFeature({
    electron: { ipcMain, dialog: {}, BrowserWindow: FakeBrowserWindow, shell: {} },
    storeRoot: root,
  });
  real.registerIpcHandlers();
  return { real, sent };
}

test("showSystemNotice emits chat:system-notice broadcast", () => {
  const root = makeRoot();
  const { real, sent } = makeFeature(root);
  real.openWindow();
  real.showSystemNotice("account error occurred");
  const hit = sent.find((entry) => entry.channel === "chat:system-notice");
  assert.ok(hit, "expected chat:system-notice to be broadcast");
  assert.equal(hit.payload.text, "account error occurred");
});

test("showSystemNotice is part of the public API", () => {
  const root = makeRoot();
  const { real } = makeFeature(root);
  assert.equal(typeof real.showSystemNotice, "function");
});
