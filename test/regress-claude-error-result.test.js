// F70: Claude CLI는 API 오류(로그인 만료·429·사용 한도)를 {subtype:"success", is_error:true}
// 결과로 내보낸다. 이걸 정상 답변으로 읽으면 오류 문구가 Claude의 발언으로 저장된다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ProcessHarnessAdapter } = require("../src/harness/process-harness-adapter");
const { runAgentProcess } = require("../src/chat/chat-agent-runner");
const { parseClaudeLine } = require("../src/chat/chat-events");
const { detectRateLimit } = require("../src/chat/rate-limit-signal");

function resultLine(result, extra = {}) {
  return JSON.stringify({
    type: "result", subtype: "success", is_error: true, api_error_status: null,
    terminal_reason: "api_error", result, ...extra,
  });
}

function fakeRecord(id) {
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "",
    commandPath: process.execPath, needsShell: false, version: "1.0.0",
    models: ["default"], modelOptions: [{ id: "default", label: "default", efforts: ["medium"] }],
    efforts: ["medium"], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

// 진짜 러너(runAgentProcess)와 진짜 파서(chat-ipc가 붙이는 createLineParser)를 쓰고,
// Claude CLI 자리에만 stream-json을 흘려 주는 node 스크립트를 둔다.
async function runClaudeTurn(t, lines, exitCode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-err-")));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }));
  const script = path.join(root, "fake-claude.js");
  fs.writeFileSync(script,
    `process.stdin.resume();process.stdin.on("data",()=>{});process.stdin.on("end",()=>{});\n` +
    `process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\n` +
    `setTimeout(()=>process.exit(${exitCode}),50);\n`);
  const handlers = new Map();
  const records = [fakeRecord("claude")];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((r) => ({ id: r.id })),
      getRecord: (id) => records.find((r) => r.id === id) || null,
      discover: async () => records,
    },
    harnessAdapter: new ProcessHarnessAdapter({
      runProcess: (invocation) => runAgentProcess({ ...invocation, argv: [script], needsShell: false, promptTransport: "stdin" }),
    }),
  });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const invoke = (channel, input = {}) => handlers.get(channel)({}, input);
  const state = await invoke("chat:state");
  const sessionId = state.activeSessionId;
  assert.equal((await invoke("chat:send", { sessionId, text: "@claude 안녕" })).ok, true);
  const claudeMessages = async () => ((await invoke("chat:state")).session?.messages || [])
    .filter((m) => m.authorType === "agent" && m.author === "claude");
  const start = Date.now();
  while ((await claudeMessages()).length === 0) {
    if (Date.now() - start > 5000) throw new Error("Claude 응답 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return claudeMessages();
}

const INIT = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s1" });

test("parseClaudeLine: success + is_error:true는 final이 아니라 error", () => {
  const parsed = parseClaudeLine(resultLine("Failed to authenticate: OAuth session expired and could not be refreshed"));
  assert.equal(parsed.kind, "error");
  assert.match(parsed.message, /OAuth session expired/);
});

for (const exitCode of [0, 1]) {
  test(`chat:send: 로그인 만료 결과(종료 코드 ${exitCode})는 정상 답변이 아니라 오류 말풍선이다`, async (t) => {
    const messages = await runClaudeTurn(t, [INIT,
      resultLine("Failed to authenticate: OAuth session expired and could not be refreshed")], exitCode);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].error, true);
    assert.match(messages[0].text, /OAuth session expired/);
  });
}

test("chat:send: 429 결과는 오류 말풍선이고 사용 한도 안내가 붙는다", async (t) => {
  const messages = await runClaudeTurn(t, [INIT,
    resultLine('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}', { api_error_status: 429 })], 1);
  assert.equal(messages[0].error, true);
  assert.match(messages[0].text, /다른 담당자에게 보내거나/);
});

test("chat:send: Claude의 현재 한도 문구(\"You've hit your limit\")도 한도 오류로 처리된다", async (t) => {
  const messages = await runClaudeTurn(t, [INIT,
    resultLine("You've hit your limit · resets 5pm (Asia/Seoul)")], 1);
  assert.equal(messages[0].error, true);
  assert.match(messages[0].text, /다른 담당자에게 보내거나/);
});

test("detectRateLimit: Claude의 현재 한도 문구를 알아본다", () => {
  for (const s of ["You've hit your limit · resets 5pm (Asia/Seoul)", "You've reached your Fable limit.", "You're out of extra usage"]) {
    assert.ok(detectRateLimit(s), s);
  }
  assert.equal(detectRateLimit("You've reached your context limit"), null);
});

test("chat:send: 정상 답변(is_error 없음)은 그대로 정상 말풍선이다", async (t) => {
  const messages = await runClaudeTurn(t, [INIT,
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "안녕하세요" })], 0);
  assert.equal(messages[0].error, undefined);
  assert.equal(messages[0].text, "안녕하세요");
});
