const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatFeature } = require("../src/chat/chat-ipc");

// 실제 createChatFeature IPC 핸들러를 쓰고 electron과 CLI 실행기만 가짜로 바꿉니다.
function rec(id) {
  return {
    id, name: id, color: "#333", aliases: [id], status: "cli", reason: "",
    commandPath: `C:\fake\${id}.exe`, needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: [] }],
    efforts: [], allowCustomModel: false, supportsImages: id === "codex",
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
  const gates = [];
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
    harnessRuntime: {
      runTurn: ({ context, invocation }) => {
        runs.push({ provider: context.providerId, prompt: invocation.prompt });
        let release;
        const gate = new Promise((r) => { release = r; });
        gates.push(release);
        return { promise: gate.then(() => ({ ok: true, text: "네." })), cancel: () => {} };
      },
      workspaceChanged() {}, workspaceRestored() {}, professionalRunEnded() {}, close() {},
    },
  });
  feature.registerIpcHandlers();
  return {
    runs, gates,
    invoke: (c, input = {}) => handlers.get(c)({}, input),
    quit: () => feature.shutdown(),
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await tick(10);
  }
}

function mkRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-regress-att-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// F64: 같은 내용을 다시 붙였다가 ×로 지워도 이미 보낸 메시지의 사본은 남아야 합니다.
test("F64: 보류 첨부 제거가 이미 보낸 메시지와 같은 사본을 지우지 않는다", async (t) => {
  const root = mkRoot(t);
  const txt = path.join(root, "notes.txt");
  fs.writeFileSync(txt, "SECRET-CONTENT-123\n");
  const app = startApp(root, [txt]);
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const id = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  await app.invoke("chat:send", { sessionId, text: "@claude @codex 이 메모 읽어줘", attachmentIds: [id] });
  await waitFor(() => app.runs.length >= 1);
  // 첫 턴이 도는 동안 둘째 턴(codex)은 큐에서 기다립니다. 같은 파일을 다시 붙였다가 ×로 지웁니다.
  const again = await app.invoke("chat:attachments:add-dropped", { sessionId, paths: [txt] });
  assert.equal(again.attachments[0].id, id);
  await app.invoke("chat:attachments:remove", { sessionId, attachmentId: id });
  const copy = path.join(root, "sessions", sessionId, "attachments", `${id}.txt`);
  assert.equal(fs.existsSync(copy), true, "보낸 메시지가 쓰는 사본이 남아 있어야 한다");
  app.gates[0]();
  await waitFor(() => app.runs.length >= 2);
  assert.match(app.runs[1].prompt, /SECRET-CONTENT-123/, "대기 중이던 턴도 첨부 내용을 받아야 한다");
  app.gates[1]();
  await tick(50);
});

test("F64: 보낸 적 없는 보류 첨부를 ×로 지우면 사본도 지워진다", async (t) => {
  const root = mkRoot(t);
  const txt = path.join(root, "notes.txt");
  fs.writeFileSync(txt, "아직 안 보냄\n");
  const app = startApp(root, [txt]);
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const id = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  const copy = path.join(root, "sessions", sessionId, "attachments", `${id}.txt`);
  assert.equal(fs.existsSync(copy), true);
  await app.invoke("chat:attachments:remove", { sessionId, attachmentId: id });
  assert.equal(fs.existsSync(copy), false);
});

// F159: 인라인 첨부 인코딩. codex는 '대화만' 모드에서 작은 텍스트를 프롬프트에 그대로 싣는다.
async function promptWithAttachment(t, fileName, bytes) {
  const root = mkRoot(t);
  const file = path.join(root, fileName);
  fs.writeFileSync(file, bytes);
  const app = startApp(root, [file]);
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const id = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  await app.invoke("chat:send", { sessionId, text: "@codex 요약해 줘", attachmentIds: [id] });
  await waitFor(() => app.runs.length >= 1);
  app.gates[0]();
  await tick(50);
  return app.runs[0].prompt;
}

// "이름,매출\n홍길동,100\n" 을 CP949로 인코딩한 바이트
const CP949_CSV = Buffer.from("c0ccb8a72cb8c5c3e20ac8abb1e6b5bf2c3130300a", "hex");

test("F159: CP949 CSV 첨부가 깨지지 않고 전달된다", async (t) => {
  const prompt = await promptWithAttachment(t, "sales.csv", CP949_CSV);
  assert.match(prompt, /이름,매출/);
  assert.match(prompt, /홍길동,100/);
  assert.equal(prompt.includes("\uFFFD"), false);
});

test("F159: UTF-16LE(BOM) 텍스트 첨부에 NUL이 섞이지 않고 전달된다", async (t) => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("파일 목록\r\nreport.txt\r\n", "utf16le")]);
  const prompt = await promptWithAttachment(t, "files.txt", bytes);
  assert.match(prompt, /파일 목록/);
  assert.match(prompt, /report\.txt/);
  assert.equal(prompt.includes("\u0000"), false);
});

test("F159: UTF-16BE(BOM)와 UTF-8(BOM) 텍스트도 바르게 전달된다", async (t) => {
  const be = Buffer.from("가나다 abc", "utf16le").swap16();
  const p1 = await promptWithAttachment(t, "be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.match(p1, /가나다 abc/);
  const p2 = await promptWithAttachment(t, "bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("한글 utf8", "utf8")]));
  assert.match(p2, /한글 utf8/);
  assert.equal(p2.includes("\uFEFF"), false);
});

test("F159: 평범한 UTF-8 첨부는 그대로 전달된다", async (t) => {
  const prompt = await promptWithAttachment(t, "plain.txt", Buffer.from("안녕하세요 hello\n", "utf8"));
  assert.match(prompt, /안녕하세요 hello/);
});
