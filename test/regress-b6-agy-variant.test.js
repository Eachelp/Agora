"use strict";

// F161 — 프로젝트 역할(기록 담당)에 접히기 전 AGY 변형 id가 저장돼 있으면, 방의 다른 모델 기준 노력이 함께 실려
// '--model gemini-3.8-flash-high --effort medium'처럼 서로 다른 단계가 나갔다. 변형 id가 담은 노력을 따라야 한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const permissions = {
  chat: { supported: true, enforcement: "sandbox" },
  "workspace-read": { supported: true, enforcement: "sandbox" },
  "workspace-write": { supported: true, enforcement: "sandbox" },
};
const flash = (version) => ({
  id: `gemini-${version}-flash`,
  label: `Gemini ${version} Flash`,
  efforts: ["low", "medium", "high"],
  effortModels: Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, `gemini-${version}-flash-${effort}`])),
});
function rec(id, extra = {}) {
  return {
    id, name: id, color: "#333", aliases: [id], status: "cli", reason: "", commandPath: `C:\fake\${id}.exe`,
    needsShell: false, version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: [] }], efforts: [], allowCustomModel: false,
    supportsImages: false, permissions, guiInstalled: false, authStatus: "authenticated", authReason: "",
    installUrl: null, loginCommand: null, ...extra,
  };
}

test("F161: 변형 id로 저장된 기록 담당은 변형이 정한 노력으로 실행되고, 방의 다른 노력과 섞이지 않는다", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-b6-agy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = [
    rec("claude"),
    rec("agy", {
      models: ["gemini-3.7-flash", "gemini-3.8-flash"],
      modelOptions: [flash("3.7"), flash("3.8")],
      efforts: ["low", "medium", "high"],
    }),
  ];
  const argvs = [];
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class {}, shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    harnessAdapter: {
      runTurn: ({ invocation }) => {
        const isRecord = invocation.prompt.includes("토론 기록자");
        if (isRecord) argvs.push(invocation.argv);
        return { promise: Promise.resolve({ ok: true, text: isRecord ? "기록" : "의견 [[CODEPET_DISCUSSION:CONCLUDE]]" }), cancel: () => {} };
      },
    },
  });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  const invoke = (channel, input = {}) => handlers.get(channel)({}, input);

  const created = await invoke("chat:projects:create", { name: "변형" });
  const file = path.join(root, "projects", `${created.activeProjectId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    ...JSON.parse(fs.readFileSync(file, "utf8")),
    defaultRoles: { recorder: { agentId: "agy", model: "gemini-3.8-flash-high" } },
  }), "utf8");
  const sessionId = (await invoke("chat:state")).activeSessionId;
  await invoke("chat:send", { sessionId, text: "@claude 주제" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "agy"], turnBudget: 3 });
  const start = Date.now();
  while (argvs.length === 0 && Date.now() - start < 4000) await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(argvs.length, 1, "기록 호출이 있어야 한다");
  const argv = argvs[0];
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high", "모델 변형의 노력(high)과 같은 단계가 나가야 한다");
});
