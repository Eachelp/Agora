"use strict";

// 3.5단계 S4: 작업 폴더 변경 소유권(lease)을 없앤 뒤의 동작을 진입점(createChatFeature + 가짜 ipcMain)에서 확인한다.
//  - 같은 폴더에 연결된 두 대화가 쓰기 권한 턴을 동시에 돌려도 "다른 대화가 변경하고 있습니다" 같은 안내 없이 둘 다 실행된다.
//  - 다른 대화의 턴이 돌고 있어도 쓰기 방의 토론이 끊기지 않는다.
//  - 독립 발언 묶음은 담당자 폴더 밖에서 바뀐 파일을 여전히 알리며, 문구는 다른 대화·직접 수정 가능성을 말한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatFeature } = require("../src/chat/chat-ipc");

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await tick();
  }
}

function fakeRecord(id) {
  const supported = (enforcement) => ({ supported: true, enforcement });
  return {
    id, name: id, color: "#333333", aliases: [id], status: "cli", reason: "", commandPath: null, needsShell: false,
    version: "1.0.0", models: ["default"],
    modelOptions: [{ id: "default", label: "default", efforts: [] }],
    efforts: [], allowCustomModel: false, supportsImages: false,
    permissions: {
      chat: supported("tool-policy"),
      "workspace-read": supported("tool-policy"),
      "workspace-write": supported("sandbox"),
    },
    guiInstalled: false, authStatus: "authenticated", authReason: "", installUrl: null, loginCommand: null,
  };
}

// runAgent는 호출마다 prompt를 보고 결과를 정한다. 값이 Promise면 그 Promise가 풀릴 때 끝난다.
function makeApp(t, runAgent) {
  const handlers = new Map();
  const records = [fakeRecord("claude"), fakeRecord("codex")];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-nolease-root-")));
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-nolease-ws-")));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const runs = [];
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class { isDestroyed() { return false; } on() {} once() {} },
      shell: {},
    },
    storeRoot: root,
    capabilities: {
      defs: records.map((record) => ({ id: record.id })),
      getRecord: (id) => records.find((record) => record.id === id) || null,
      discover: async () => records,
    },
    runAgent: ({ agent, prompt }) => {
      runs.push({ agentId: agent.id, prompt });
      return { promise: Promise.resolve(runAgent({ agent, prompt })), cancel: () => {} };
    },
  });
  feature.registerIpcHandlers();
  const invoke = async (channel, input = {}) => handlers.get(channel)({}, input);
  return { invoke, runs, workspace };
}

// 같은 폴더에 연결된 쓰기 권한 대화를 두 개 만든다.
async function twoWriteSessions(env) {
  const created = await env.invoke("chat:projects:create", { name: "공유 폴더", workspace: env.workspace });
  assert.equal(created.ok, true, created.error);
  const first = created.session.meta.id;
  const more = await env.invoke("chat:sessions:create", { projectId: created.session.meta.projectId });
  assert.equal(more.ok, true, more.error);
  const second = more.session.meta.id;
  assert.notEqual(first, second);
  for (const sessionId of [first, second]) {
    assert.equal((await env.invoke("chat:permission:set", { sessionId, mode: "workspace-write" })).ok, true);
  }
  return { first, second };
}

const messagesOf = async (env, sessionId) => (await env.invoke("chat:sessions:select", { sessionId })).session.messages;
const systemTexts = (messages) => messages.filter((m) => m.authorType === "system").map((m) => m.text || "");

test("같은 폴더의 두 대화가 쓰기 턴을 동시에 돌려도 막히지 않고 둘 다 실행된다", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeApp(t, () => gate.then(() => ({ ok: true, text: "끝냈습니다" })));
  const { first, second } = await twoWriteSessions(env);

  assert.equal((await env.invoke("chat:send", { sessionId: first, text: "@claude 파일을 만들어 줘" })).ok, true);
  assert.equal((await env.invoke("chat:send", { sessionId: second, text: "@codex 다른 파일을 만들어 줘" })).ok, true);
  // 예전에는 두 번째 대화가 곧바로 "같은 작업 폴더를 다른 대화가 변경하고 있습니다"로 튕겼다.
  await waitFor(() => env.runs.length >= 2);
  assert.deepEqual(env.runs.map((run) => run.agentId).sort(), ["claude", "codex"], "두 턴이 같은 시간에 돌고 있어야 한다");

  release();
  await waitFor(async () => (await messagesOf(env, first)).some((m) => m.text === "끝냈습니다"));
  await waitFor(async () => (await messagesOf(env, second)).some((m) => m.text === "끝냈습니다"));
  for (const sessionId of [first, second]) {
    const joined = systemTexts(await messagesOf(env, sessionId)).join(" / ");
    assert.ok(!/작업 폴더/.test(joined), `폴더 때문에 막혔다는 안내가 있으면 안 된다: ${joined}`);
  }
});

test("다른 대화의 턴이 돌고 있어도 쓰기 방의 토론은 끊기지 않고 끝난다", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeApp(t, ({ prompt }) => (prompt.includes("OTHER-TASK")
    ? gate.then(() => ({ ok: true, text: "다른 대화 끝" }))
    : { ok: true, text: "의견 [[CODEPET_DISCUSSION:CONCLUDE]]" }));
  const { first, second } = await twoWriteSessions(env);

  await env.invoke("chat:send", { sessionId: second, text: "@claude OTHER-TASK 오래 걸리는 쓰기" });
  await waitFor(() => env.runs.some((run) => run.prompt.includes("OTHER-TASK")));

  await env.invoke("chat:send", { sessionId: first, text: "토론 주제 TOPIC-A" });
  await waitFor(() => env.runs.filter((run) => run.prompt.includes("TOPIC-A")).length >= 2);
  await tick(50);
  const before = env.runs.length;
  await env.invoke("chat:discussion:start", { sessionId: first, turnBudget: 3 });
  await waitFor(async () => (await messagesOf(env, first)).some((m) => /토론을 마쳤습니다/.test(m.text || "")));

  assert.ok(env.runs.length > before, "토론 발언이 실제로 실행돼야 한다");
  const joined = systemTexts(await messagesOf(env, first)).join(" / ");
  assert.ok(!/작업 폴더/.test(joined), `다른 대화 때문에 토론이 끊겼다: ${joined}`);
  release();
  await waitFor(async () => (await messagesOf(env, second)).some((m) => m.text === "다른 대화 끝"));
});

test("독립 발언 묶음이 도는 동안 담당자 폴더 밖에서 바뀐 파일은 다른 대화·직접 수정일 수 있다는 문구로 알린다", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeApp(t, ({ agent }) => gate.then(() => {
    // claude는 계약대로 자기 폴더에, codex는 폴더 밖 파일에 쓴다.
    const rel = agent.id === "claude" ? path.join("claude", "시안.md") : "README.md";
    fs.mkdirSync(path.dirname(path.join(env.workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(env.workspace, rel), `${agent.id} 작업`, "utf8");
    return { ok: true, text: `${agent.id} 답` };
  }));
  const created = await env.invoke("chat:projects:create", { name: "독립", workspace: env.workspace });
  const sessionId = created.session.meta.id;
  await env.invoke("chat:permission:set", { sessionId, mode: "workspace-write" });

  await env.invoke("chat:send", { sessionId, text: "@claude @codex 각자 시안 만들어줘", independent: true });
  await waitFor(() => env.runs.length >= 2);
  // 묶음이 실행되는 동안 다른 대화(또는 사용자)가 폴더 밖 파일을 바꾼다.
  await tick(30);
  fs.writeFileSync(path.join(env.workspace, "다른-대화.txt"), "누군가 바꿈", "utf8");
  release();
  await waitFor(async () => systemTexts(await messagesOf(env, sessionId)).some((text) => /담당자 폴더/.test(text)));

  const [notice] = systemTexts(await messagesOf(env, sessionId)).filter((text) => /담당자 폴더/.test(text));
  assert.match(notice, /이 묶음이 실행되는 동안 담당자 폴더/);
  assert.match(notice, /다른 대화나 직접 수정일 수 있음/);
  assert.match(notice, /다른-대화\.txt/);
  assert.match(notice, /README\.md/);
  assert.ok(!notice.includes("시안.md"), "계약을 지킨 변경까지 지목하면 안 된다");
});
