"use strict";

// 묶음 B5 — 저장소·읽기 전용 저장소·첨부·결정 삭제. 진입점(createChatFeature + 가짜 ipcMain)으로 확인한다.
//  F187 보내지 않은 보류 첨부의 고아 파일  F188 읽기 전용 저장소에서 전송·실행·첨부
//  F61 읽기 전용에서 기록관 자동 저장  F67 읽기 전용에서 Memory/규칙 읽기
//  F69 숨겨진 작업에 연결된 결정 삭제  F68 10개 넘는 드롭의 안내
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

function startApp(root, dialogPaths = [], respond = () => "네.") {
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
        return { promise: Promise.resolve({ ok: true, text: respond(invocation.prompt) }), cancel: () => {} };
      },
    },
  });
  feature.registerIpcHandlers();
  return { runs, invoke: (c, input = {}) => handlers.get(c)({}, input), quit: () => feature.shutdown() };
}

function mkRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-b5-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

async function waitFor(condition, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("조건 대기 시간 초과");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeReadOnly(root) {
  const configPath = path.join(root, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.schemaVersion = 999;
  fs.writeFileSync(configPath, JSON.stringify(config));
}

const attachDir = (root, sessionId) => path.join(root, "sessions", sessionId, "attachments");

// ---------------- F187 ----------------
test("F187: 보내지 않고 종료한 보류 첨부는 다음 실행에서 정리되어 한도를 되돌려 준다", async (t) => {
  const root = mkRoot(t);
  const files = [];
  for (let i = 0; i < 10; i += 1) {
    const f = path.join(root, `doc${i}.txt`);
    fs.writeFileSync(f, Buffer.alloc(19 * 1024 * 1024, i + 1));
    files.push(f);
  }
  let app = startApp(root, files);
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const first = await app.invoke("chat:attachments:add", { sessionId });
  assert.equal(first.attachments.length, 10);
  app.quit();

  app = startApp(root, [files[0]]);
  t.after(() => app.quit());
  const state = await app.invoke("chat:state");
  assert.equal(state.session.pendingAttachments.length, 0);
  const again = await app.invoke("chat:attachments:add", { sessionId });
  assert.deepEqual(again.errors, [], "같은 파일을 다시 붙일 수 있어야 한다");
  assert.equal(again.attachments.length, 1);
  assert.equal(fs.readdirSync(attachDir(root, sessionId)).length, 1, "고아 파일은 지워져야 한다");
});

test("F187: 이미 보낸 메시지의 첨부는 정리하지 않고 복사 도중 남은 임시 파일만 지운다", async (t) => {
  const root = mkRoot(t);
  const keep = path.join(root, "keep.txt");
  fs.writeFileSync(keep, "보낸 첨부");
  let app = startApp(root, [keep]);
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const id = (await app.invoke("chat:attachments:add", { sessionId })).attachments[0].id;
  await app.invoke("chat:send", { sessionId, text: "@claude 읽어줘", attachmentIds: [id] });
  await new Promise((r) => setTimeout(r, 80));
  app.quit();
  fs.writeFileSync(path.join(attachDir(root, sessionId), "deadbeef.txt.123.tmp"), "복사 도중 종료");
  app = startApp(root);
  t.after(() => app.quit());
  await app.invoke("chat:state");
  assert.deepEqual(fs.readdirSync(attachDir(root, sessionId)), [`${id}.txt`]);
});

// ---------------- F188 / F61 / F67 ----------------
async function readOnlyApp(t, dialogPaths = []) {
  const root = mkRoot(t);
  let app = startApp(root);
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  app.quit();
  makeReadOnly(root);
  app = startApp(root, dialogPaths);
  t.after(() => app.quit());
  assert.equal((await app.invoke("chat:state")).readOnly, true);
  return { root, app, sessionId };
}

test("F188: 읽기 전용 저장소에서는 전송과 토론이 막히고 에이전트가 실행되지 않는다", async (t) => {
  const { app, sessionId } = await readOnlyApp(t);
  const sent = await app.invoke("chat:send", { sessionId, text: "@claude 안녕" });
  assert.equal(sent.ok, false);
  assert.match(sent.error, /읽기 전용/);
  const talk = await app.invoke("chat:discussion:start", { sessionId });
  assert.equal(talk.ok, false);
  assert.match(talk.error, /읽기 전용/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.runs.length, 0);
});

test("F188: 읽기 전용 저장소에는 첨부 파일을 복사하지 않는다", async (t) => {
  const probe = mkRoot(t);
  const txt = path.join(probe, "a.txt");
  fs.writeFileSync(txt, "x");
  const { root, app, sessionId } = await readOnlyApp(t, [txt]);
  for (const [channel, input] of [
    ["chat:attachments:add", { sessionId }],
    ["chat:attachments:add-dropped", { sessionId, paths: [txt] }],
  ]) {
    const result = await app.invoke(channel, input);
    assert.equal(result.ok, false, channel);
    assert.match(result.error, /읽기 전용/);
  }
  const dir = attachDir(root, sessionId);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});

test("F67: 읽기 전용 저장소에서도 Memory Bank와 규칙은 읽을 수 있고 쓰기는 막힌다", async (t) => {
  const { app } = await readOnlyApp(t);
  const memory = await app.invoke("chat:memory:read", {});
  assert.equal(memory.ok, true, memory.error);
  const rules = await app.invoke("chat:memory:rules:read", {});
  assert.equal(rules.ok, true, rules.error);
  const select = await app.invoke("chat:projects:select", { projectId: memory.projectId });
  assert.equal(select.ok, true, select.error);
  const append = await app.invoke("chat:memory:append", { content: "x" });
  assert.equal(append.ok, false);
  assert.match(append.error, /읽기 전용/);
  const save = await app.invoke("chat:memory:rules:save", { content: "x" });
  assert.equal(save.ok, false);
});

test("F61: 읽기 전용 저장소에서는 토론도 시작되지 않아 Memory Bank와 작업 기록이 바뀌지 않는다", async (t) => {
  const { root, app, sessionId } = await readOnlyApp(t);
  const snapshot = () => {
    const out = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/memory|workflow/i.test(full)) out.push(`${full}:${fs.statSync(full).size}`);
      }
    };
    walk(root);
    return out.sort();
  };
  const before = snapshot();
  const talk = await app.invoke("chat:discussion:start", { sessionId });
  assert.equal(talk.ok, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(snapshot(), before);
  assert.equal(app.runs.length, 0);
});

// 위 시험은 F188이 토론을 막는 첫 번째 방어선만 본다. 읽기 전용에서는 기록 턴이 돌 수 없어서 기록관 저장(saveRecorderOutput)의
// 자기 검사에는 이 길로 닿지 않는다. 그래서 기록 턴이 도는 사이 저장소가 읽기 전용이 된 상황을 만들어 그 검사만 따로 본다
// (진짜 ChatStore 인스턴스를 붙잡아 readOnly만 뒤집는다. 제품 코드에는 시험용 장치가 없다).
test("F61: 기록 턴이 도는 사이 저장소가 읽기 전용이 돼도 기록관 저장은 Memory Bank와 작업 기록에 쓰지 않는다", async (t) => {
  const { ChatStore } = require("../src/chat/chat-store");
  const originalInit = ChatStore.prototype.init;
  let live = null;
  ChatStore.prototype.init = function capture(...args) {
    live = this;
    return originalInit.apply(this, args);
  };
  t.after(() => { ChatStore.prototype.init = originalInit; });

  const recorded = JSON.stringify({
    summary: "자동기록본문ZZZ",
    decisions: [{ title: "후보결정", content: "결정내용" }],
    nextActions: [{ title: "후보작업" }],
  });
  const app = startApp(mkRoot(t), [], (prompt) => {
    if (!prompt.includes("토론 기록자")) return "의견 [[CODEPET_DISCUSSION:CONCLUDE]]";
    live.readOnly = true;
    return recorded;
  });
  t.after(() => app.quit());
  const created = await app.invoke("chat:projects:create", { name: "기록 시험" });
  const projectId = created.activeProjectId;
  await app.invoke("chat:projects:update", { projectId, patch: { recordAgent: "claude" } });
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  await app.invoke("chat:send", { sessionId, text: "@claude 기록주제EEE" });
  await waitFor(() => app.runs.length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  const started = await app.invoke("chat:discussion:start", { sessionId, agentIds: ["claude", "codex"], turnBudget: 3 });
  assert.equal(started.ok, true, started.error);

  const failureNote = (message) => /토론 자동 기록을 만들지 못했습니다/.test(message.text || "");
  const wrote = async () => ((await app.invoke("chat:memory:read", { projectId })).content || "").includes("자동기록본문ZZZ");
  await waitFor(async () => (await app.invoke("chat:state")).session.messages.some(failureNote) || wrote());
  assert.equal(live.readOnly, true, "기록 턴 도중 저장소가 읽기 전용이 돼 있어야 한다");
  assert.equal(await wrote(), false, "읽기 전용이 된 저장소의 Memory Bank에 기록관 요약이 쓰이면 안 된다");
  const { workflow } = await app.invoke("chat:state");
  assert.deepEqual([workflow.decisions.length, workflow.tasks.length], [0, 0], "결정·작업 후보도 등록되면 안 된다");
});

// ---------------- F69 ----------------
test("F69: 숨겨진 작업에 연결된 결정을 지우면 성공으로 답하지 않고 이유를 알린다", async (t) => {
  const root = mkRoot(t);
  const app = startApp(root);
  const state = await app.invoke("chat:state");
  const projectId = state.activeProjectId;
  const chatId = state.activeSessionId;
  const decision = (await app.invoke("chat:decisions:create", { projectId, chatId, title: "D", content: "c" })).decision;
  assert.ok(decision, "결정이 만들어져야 한다");
  const task = await app.invoke("chat:tasks:create", { projectId, chatId, title: "T", description: "d", decisionId: decision.id });
  assert.equal(task.ok, true, task.error);
  app.quit();
  // 작업 파일이 사라져 숨겨진 상태로 만든다.
  const wfPath = path.join(root, "workflow.json");
  const data = JSON.parse(fs.readFileSync(wfPath, "utf8"));
  for (const entry of data.tasks) entry.syncState = "missing_file";
  fs.writeFileSync(wfPath, JSON.stringify(data));
  const app2 = startApp(root);
  t.after(() => app2.quit());
  await app2.invoke("chat:state");
  const result = await app2.invoke("chat:decisions:delete", { projectId, decisionId: decision.id });
  assert.equal(result.ok, false);
  assert.match(result.error, /연결된 작업/);
});

// ---------------- F68 ----------------
test("F68: 파일을 10개 넘게 끌어다 놓으면 몇 개가 빠졌는지 알려 준다", async (t) => {
  const root = mkRoot(t);
  const paths = [];
  for (let i = 0; i < 15; i += 1) {
    const f = path.join(root, `f${i}.txt`);
    fs.writeFileSync(f, `내용 ${i}`);
    paths.push(f);
  }
  const app = startApp(root);
  t.after(() => app.quit());
  const sessionId = (await app.invoke("chat:state")).activeSessionId;
  const result = await app.invoke("chat:attachments:add-dropped", { sessionId, paths });
  assert.equal(result.attachments.length, 10);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /5개 제외/);
});
