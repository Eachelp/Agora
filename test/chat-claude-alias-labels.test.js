const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");
const { ChatStore } = require("../src/chat/chat-store");
const {
  claudeAliasFallbackLabel,
  claudeAliasOverrideLabel,
} = require("../src/providers/provider-capabilities");

const EFFORTS = ["default", "low", "medium", "high"];
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

function labelsFrom(labelFor) {
  return Object.fromEntries(
    CLAUDE_ALIASES.map((alias) => [alias, labelFor(alias)]).filter(([, label]) => Boolean(label))
  );
}

// 탐지 결과를 흉내 낸 Claude 기록(firstParty 로그인). 모델은 별칭으로 고르고, 별칭
// 표시 힌트는 실제 탐지(discoverOne)와 같은 함수로 CLI 버전·환경변수에서 만든다.
function claudeRecord(version, { env = {} } = {}) {
  return {
    id: "claude",
    name: "Claude",
    color: "#d97757",
    aliases: ["claude"],
    status: "cli",
    reason: "",
    commandPath: null,
    needsShell: false,
    version,
    models: ["default", ...CLAUDE_ALIASES],
    modelOptions: [
      { id: "default", label: "Claude 기본값 (CLI 설정 따름)", efforts: EFFORTS },
      { id: "fable", label: "Fable", efforts: EFFORTS },
      { id: "opus", label: "Opus", efforts: EFFORTS },
      { id: "sonnet", label: "Sonnet", efforts: EFFORTS },
      { id: "haiku", label: "Haiku", efforts: EFFORTS },
    ],
    claudeAliasLabels: labelsFrom((alias) =>
      claudeAliasFallbackLabel(alias, { version, apiProvider: "firstParty", env })),
    claudeAliasOverrideLabels: labelsFrom((alias) => claudeAliasOverrideLabel(alias, env)),
    efforts: EFFORTS,
    allowCustomModel: false,
    supportsImages: true,
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    guiInstalled: false,
    authStatus: "authenticated",
    authReason: "",
    authApiProvider: "firstParty",
    installUrl: null,
    loginCommand: null,
  };
}

function fakeCapabilities(record) {
  const records = [record];
  return {
    defs: records.map((entry) => ({ id: entry.id })),
    getRecord: (id) => records.find((entry) => entry.id === id) || null,
    discover: async () => records,
  };
}

// Claude CLI가 별칭을 실제 모델로 풀어 보고하는 것을 흉내 낸다.
function runnerResolvingTo(resolvedModel) {
  return () => ({
    promise: Promise.resolve({ ok: true, text: "네.", resolvedModel }),
    cancel: () => {},
  });
}

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-claude-alias-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// 앱 한 번 실행에 해당한다. 같은 root로 다시 만들면 "껐다 켠" 상태가 된다.
function startApp(root, { version, env, resolvesTo }) {
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        on() {},
      },
      dialog: {
        async showOpenDialog() {
          return { canceled: true, filePaths: [] };
        },
      },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: fakeCapabilities(claudeRecord(version, { env })),
    runAgent: runnerResolvingTo(resolvesTo),
  });
  feature.registerIpcHandlers();
  return {
    invoke: (channel, input = {}) => handlers.get(channel)({}, input),
    quit: () => feature.shutdown(),
  };
}

function labelOf(providers, alias) {
  const claude = providers.find((provider) => provider.id === "claude");
  return claude.modelOptions.find((option) => option.id === alias).label;
}

async function labelsNow(app, channel = "chat:state") {
  const { providers } = await app.invoke(channel);
  return Object.fromEntries(CLAUDE_ALIASES.map((alias) => [alias, labelOf(providers, alias)]));
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function claudeReplies(state) {
  return (state.session?.messages || [])
    .filter((message) => message.authorType === "agent" && message.author === "claude")
    .length;
}

// alias로 한 번 돌리고 Claude 응답이 저장될 때까지 기다린다. 응답이 저장되는 그
// message 이벤트에서 확인한 모델도 함께 기록된다.
async function runOnce(app, alias) {
  const state = await app.invoke("chat:state");
  const sessionId = state.activeSessionId;
  const before = claudeReplies(state);
  const configured = await app.invoke("chat:agent:configure", {
    sessionId,
    agentId: "claude",
    patch: { model: alias },
  });
  assert.equal(configured.ok, true);
  const sent = await app.invoke("chat:send", { sessionId, text: "@claude 안녕" });
  assert.equal(sent.ok, true);
  await waitFor(async () => claudeReplies(await app.invoke("chat:state")) > before);
}

// 드롭다운에 "Opus 5"라고 나오다가 opus를 한 번 돌리면 "Opus 5.5"로 바뀌는데, 앱을
// 껐다 켜면 다시 "Opus 5"로 돌아갔다. 확인한 값은 config에 남아 있었지만, 시작할 때
// 첫 화면 상태를 만드는 경로만 그 값을 씌우지 않고 CLI 버전 추측값을 그대로 보냈다.
// 그때처럼 앱의 추측표가 CLI보다 뒤처진 상황을, 표가 아직 모르는 새 모델로 재현한다.
test("실행에서 확인한 Claude 버전 표시는 앱을 다시 켠 첫 화면에도 남는다", async (t) => {
  const root = makeRoot(t);
  const app = { version: "2.1.400 (Claude Code)", resolvesTo: "claude-opus-6" };

  const first = startApp(root, app);
  // 아직 opus를 돌려 본 적이 없으면 CLI 버전으로 추측한 표시가 나온다.
  assert.equal((await labelsNow(first)).opus, "Opus 5.5");
  await runOnce(first, "opus");
  assert.equal((await labelsNow(first, "chat:providers:refresh")).opus, "Opus 6");
  first.quit();

  const second = startApp(root, app);
  const restarted = await second.invoke("chat:state");
  assert.deepEqual(
    Object.fromEntries(CLAUDE_ALIASES.map((alias) => [alias, labelOf(restarted.providers, alias)])),
    // 돌려 보지 않은 별칭은 여전히 추측값(또는 계열명)이다.
    { fable: "Fable 5.1", opus: "Opus 6", sonnet: "Sonnet 5.5", haiku: "Haiku" }
  );
  // 첫 화면 상태와 그 뒤의 재탐지 응답은 같은 목록이어야 한다. 둘을 따로 조립하면
  // 한쪽에만 빠지는 값이 다시 생긴다.
  const refreshed = await second.invoke("chat:providers:refresh");
  assert.deepEqual(restarted.providers, refreshed.providers);
  assert.deepEqual(restarted.diagnostics, refreshed.diagnostics);
  second.quit();
});

// Claude CLI는 자주 저절로 올라간다. 2.1.279에서 opus를 돌려 "claude-opus-5"를 확인해
// 두었는데 CLI가 2.1.285가 되면, 변경 기록상 opus는 2.1.280부터 Opus 5.5를 가리킨다.
// 확인한 값만 믿으면 다시 돌려 보기 전까지 "Opus 5"가 남는다.
test("CLI가 올라가 별칭이 옮겨 가면 예전 CLI에서 확인한 값 대신 새 기본 모델을 보인다", async (t) => {
  const root = makeRoot(t);

  const before = startApp(root, { version: "2.1.279 (Claude Code)", resolvesTo: "claude-opus-5" });
  await runOnce(before, "opus");
  assert.equal((await labelsNow(before, "chat:providers:refresh")).opus, "Opus 5");
  before.quit();

  // 이 계정에서는 새 CLI에서도 opus가 Opus 5로 돈다고 하자(계정·조직 사정).
  const upgraded = { version: "2.1.285 (Claude Code)", resolvesTo: "claude-opus-5" };
  const after = startApp(root, upgraded);
  assert.equal((await labelsNow(after)).opus, "Opus 5.5");
  // 새 CLI에서 확인하면 모델 id가 그대로여도 다시 확인값으로 인정한다.
  await runOnce(after, "opus");
  assert.equal((await labelsNow(after, "chat:providers:refresh")).opus, "Opus 5");
  after.quit();

  const again = startApp(root, upgraded);
  assert.equal((await labelsNow(again)).opus, "Opus 5");
  again.quit();
});

// 이 수정 전에는 확인한 값을 CLI 버전 없이 { model, observedAt }으로만 저장했다. 그런
// 기록은 언제 확인했는지 모르므로 추측이 있는 별칭은 추측을, 없는 별칭은 기록을 따른다.
test("CLI 버전 없이 저장된 예전 확인값도 읽고, 추측이 없는 별칭에는 그대로 쓴다", async (t) => {
  const root = makeRoot(t);
  new ChatStore({ root }).init().patchConfig({
    claudeResolvedModels: {
      fable: { model: "claude-fable-5-1", observedAt: 1 },
      opus: { model: "claude-opus-5", observedAt: 1 },
      sonnet: { model: "claude-sonnet-5-5", observedAt: 1 },
      haiku: { model: "claude-haiku-4-5-20251001", observedAt: 1 },
    },
    claudeResolvedModelsHydrated: 1,
  });

  const app = startApp(root, { version: "2.1.285 (Claude Code)", resolvesTo: "claude-opus-5-5" });
  assert.deepEqual(await labelsNow(app), {
    fable: "Fable 5.1",
    opus: "Opus 5.5",
    sonnet: "Sonnet 5.5",
    haiku: "Haiku 4.5",
  });
  app.quit();
});

// ANTHROPIC_DEFAULT_OPUS_MODEL처럼 환경변수로 별칭을 고정하면 CLI는 그 모델로 돈다.
// 고정하기 전에 확인해 둔 값이 남아 있어도, 표시는 지금 실제로 돌 모델을 따라야 한다.
test("환경변수로 고정한 별칭은 예전에 확인한 값으로 가려지지 않는다", async (t) => {
  const root = makeRoot(t);
  const first = startApp(root, { version: "2.1.400 (Claude Code)", resolvesTo: "claude-opus-6" });
  await runOnce(first, "opus");
  assert.equal((await labelsNow(first, "chat:providers:refresh")).opus, "Opus 6");
  first.quit();

  const second = startApp(root, {
    version: "2.1.400 (Claude Code)",
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" },
    resolvesTo: "claude-opus-4-8",
  });
  assert.equal((await labelsNow(second)).opus, "Opus 4.8");
  assert.equal((await labelsNow(second, "chat:providers:refresh")).opus, "Opus 4.8");
  second.quit();
});
