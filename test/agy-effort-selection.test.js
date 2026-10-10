const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

// agy 1.2.16이 보고하는 Claude 5.5는 노력마다 변형 id를 따로 가진다. 화면은 한 줄로
// 접어 보여 주고, 실행할 때 고른 노력에 맞는 변형 id로 되돌린다.
function foldedModel(id, label) {
  return {
    id,
    label,
    efforts: ["low", "medium", "high"],
    effortModels: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` },
  };
}

function agyRecord() {
  const modelOptions = [
    { id: "default", label: "AGY 기본값", efforts: [] },
    foldedModel("claude-opus-5-5", "Claude Opus 5.5"),
    foldedModel("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (중간)", efforts: [] },
  ];
  return {
    id: "agy",
    name: "Gemini",
    color: "#4285f4",
    aliases: ["gemini", "agy", "antigravity"],
    status: "cli",
    reason: "",
    commandPath: "C:\\agy\\agy.exe",
    needsShell: false,
    version: "1.2.16",
    models: modelOptions.map((option) => option.id),
    modelOptions,
    efforts: ["default", "low", "medium", "high"],
    allowCustomModel: false,
    supportsImages: "unsupported",
    permissions: {
      chat: { supported: true, enforcement: "sandbox" },
      "workspace-read": { supported: true, enforcement: "sandbox" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false,
    authStatus: "authenticated",
    authReason: "",
    installUrl: null,
    loginCommand: null,
  };
}

function startApp(root) {
  const handlers = new Map();
  const runs = [];
  const records = [agyRecord()];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    // 실제 CLI 대신 실행 계약(argv)만 받아 둔다.
    harnessAdapter: {
      runTurn: ({ invocation }) => {
        runs.push(invocation.argv);
        return { promise: Promise.resolve({ ok: true, text: "네." }), cancel: () => {} };
      },
    },
  });
  feature.registerIpcHandlers();
  return {
    runs,
    invoke: (channel, input = {}) => handlers.get(channel)({}, input),
    quit: () => feature.shutdown(),
  };
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const agyReplies = (state) => (state.session?.messages || [])
  .filter((message) => message.authorType === "agent" && message.author === "agy").length;

// 모델·노력을 고르고 한 번 돌려, 화면이 읽는 참가자 설정과 CLI에 넘긴 인자를 돌려준다.
async function runWith(app, patch) {
  const before = await app.invoke("chat:state");
  const sessionId = before.activeSessionId;
  const configured = await app.invoke("chat:agent:configure", { sessionId, agentId: "agy", patch });
  assert.equal(configured.ok, true);
  const shown = (await app.invoke("chat:state")).session.agents.find((agent) => agent.id === "agy");
  const sent = await app.invoke("chat:send", { sessionId, text: "@agy 안녕" });
  assert.equal(sent.ok, true);
  await waitFor(async () => agyReplies(await app.invoke("chat:state")) > agyReplies(before));
  const argv = app.runs.at(-1);
  return { shown, argv, option: (flag) => argv[argv.indexOf(flag) + 1] };
}

test("AGY Claude 5.5의 노력은 대화방 설정에서 바꾸면 실행 인자에 그대로 반영된다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-agy-effort-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = startApp(root);
  t.after(() => app.quit());

  for (const base of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    for (const effort of ["high", "low", "medium"]) {
      const run = await runWith(app, { model: base, effort });
      // 드롭다운이 읽는 값과 실제로 도는 모델이 같은 노력이어야 한다.
      assert.equal(run.shown.model, base);
      assert.equal(run.shown.effort, effort, `${base} 화면 노력`);
      assert.equal(run.option("--model"), `${base}-${effort}`);
      assert.equal(run.argv.includes("--effort"), false, "변형 id가 단계를 정하므로 --effort는 따로 넘기지 않는다");
    }
  }
});

test("AGY 고정 모델(GPT-OSS)은 노력을 골라도 고정으로 남는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-agy-fixed-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = startApp(root);
  t.after(() => app.quit());

  const run = await runWith(app, { model: "gpt-oss-120b-medium", effort: "high" });
  assert.equal(run.shown.effort, "default");
  assert.equal(run.option("--model"), "gpt-oss-120b-medium");
  assert.equal(run.argv.includes("--effort"), false);
});
