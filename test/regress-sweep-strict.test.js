"use strict";

// 대화 기록을 못 읽거나 깨진 줄이 있으면 첨부 고아 정리는 보낸 첨부를 지우지 않는다(F187 후속).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

function rec(id) {
  return {
    id, name: id, color: "#333", aliases: [id], status: "cli", reason: "",
    commandPath: `C:\\fake\\${id}.exe`, needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: [] }],
    efforts: [], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

function startApp(root, dialogPaths = []) {
  const handlers = new Map();
  const runs = [];
  const records = [rec("claude"), rec("codex")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (c, h) => handlers.set(c, h), on() {} },
      dialog: { async showOpenDialog() { return { canceled: false, filePaths: dialogPaths.slice() }; } },
      BrowserWindow: class {}, shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
    harnessAdapter: {
      runTurn: ({ invocation }) => {
        runs.push({ prompt: invocation.prompt });
        return { promise: Promise.resolve({ ok: true, text: "네." }), cancel: () => {} };
      },
    },
  });
  feature.registerIpcHandlers();
  return { runs, invoke: (c, input = {}) => handlers.get(c)({}, input), quit: () => feature.shutdown() };
}

function mkRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-b5-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}


const attachDir = (root, sessionId) => path.join(root, "sessions", sessionId, "attachments");

async function sendWithAttachment(t) {
  const root = mkRoot(t);
  const keep = path.join(root, "keep.txt");
  fs.writeFileSync(keep, "보낸 첨부");
  const app = startApp(root, [keep]);
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const id = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  await app.invoke("chat:send", { sessionId, text: "@claude 읽어줘", attachmentIds: [id] });
  await new Promise((r) => setTimeout(r, 80));
  app.quit();
  return { root, sessionId, name: `${id}.txt`, transcript: path.join(root, "sessions", sessionId, "transcript.jsonl") };
}

test("F187 후속: 대화 기록을 읽지 못하면 보낸 첨부를 지우지 않는다", async (t) => {
  const { root, sessionId, name, transcript } = await sendWithAttachment(t);
  const bak = `${transcript}.bak`;
  fs.renameSync(transcript, bak);
  fs.mkdirSync(transcript); // 읽기 실패(EISDIR)를 흉내 낸다
  const app = startApp(root);
  t.after(() => app.quit());
  await app.invoke("chat:state");
  fs.rmdirSync(transcript);
  fs.renameSync(bak, transcript);
  assert.deepEqual(fs.readdirSync(attachDir(root, sessionId)), [name]);
});

test("F187 후속: 대화 기록에 깨진 줄이 있으면 보낸 첨부를 지우지 않는다", async (t) => {
  const { root, sessionId, name, transcript } = await sendWithAttachment(t);
  fs.appendFileSync(transcript, '{"kind":"message","mess\n');
  const app = startApp(root);
  t.after(() => app.quit());
  await app.invoke("chat:state");
  assert.deepEqual(fs.readdirSync(attachDir(root, sessionId)), [name]);
});

test("isAttachmentCopyInUse: 보낸 첨부 자신을 가리키는 줄이 찢겨도 같은 내용의 보류 첨부를 취소하면 파일을 지우지 않는다", async (t) => {
  const { root, sessionId, name, transcript } = await sendWithAttachment(t);
  // 보낸 메시지(첨부 참조)가 들어 있는 그 줄 자체를 찢는다(관계없는 다른 줄이 아니라).
  const lines = fs.readFileSync(transcript, "utf8").split("\n");
  const targetIndex = lines.findIndex((line) => line.includes(name));
  assert.ok(targetIndex >= 0, "그 메시지 줄을 transcript에서 찾아야 한다");
  lines[targetIndex] = lines[targetIndex].slice(0, Math.floor(lines[targetIndex].length / 2));
  fs.writeFileSync(transcript, lines.join("\n"));

  // 같은 내용(같은 해시 → 같은 파일명)의 보류 첨부를 추가했다가 취소한다.
  const keep = path.join(root, "keep.txt");
  const app = startApp(root, [keep]);
  t.after(() => app.quit());
  await app.invoke("chat:state"); // 세션을 다시 열면 room.messages는 관대한 읽기로 채워져 그 메시지를 놓친다
  const pendingId = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  await app.invoke("chat:attachments:remove", { sessionId, attachmentId: pendingId });
  assert.ok(
    fs.existsSync(path.join(attachDir(root, sessionId), name)),
    "줄이 찢겨 room.messages가 못 본 '보낸 첨부'를 취소 경로가 지우면 안 된다"
  );
});
