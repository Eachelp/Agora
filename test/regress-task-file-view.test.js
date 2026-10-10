"use strict";

// 파일 기반 작업 카드(contentSource "file")의 본문 읽기(chat:tasks:read-file)와 카드 표시.
// 진입점(createChatFeature + fake ipcMain)과 실제 chat.js(가짜 DOM)로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createChatFeature } = require("../src/chat/chat-ipc");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function makeFeature(root) {
  const handlers = new Map();
  const feature = createChatFeature({
    electron: {
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
      dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
      BrowserWindow: class BrowserWindow {},
      shell: {},
    },
    storeRoot: root,
    capabilities: { defs: [], getRecord: () => null, discover: async () => [] },
    runAgent: () => ({ promise: Promise.resolve({ ok: true, text: "" }), cancel() {} }),
  });
  feature.registerIpcHandlers();
  return { invoke: async (channel, input = {}) => handlers.get(channel)({}, input) };
}

async function createProject(feature, name, workspace) {
  const created = await feature.invoke("chat:projects:create", { name, workspace });
  assert.equal(created.ok, true, created.error);
  const projectId = created.session.meta.projectId || created.activeProjectId;
  assert.ok(projectId, "프로젝트 id를 찾을 수 없습니다");
  return projectId;
}

async function setup() {
  const workspace = tmp("agora-taskfile-ws-");
  const feature = makeFeature(tmp("agora-taskfile-root-"));
  const projectId = await createProject(feature, "파일 작업", workspace);
  const tasksDir = path.join(workspace, ".project-memory", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const readFile = (taskPath, pid = projectId) => feature.invoke("chat:tasks:read-file", { projectId: pid, taskPath });
  return { feature, workspace, projectId, tasksDir, readFile };
}

test("정상: 프로젝트 폴더의 TASK 파일 본문을 읽는다(저장된 역슬래시 경로·./ 접두 모두)", async () => {
  const { tasksDir, readFile } = await setup();
  fs.writeFileSync(path.join(tasksDir, "TASK-001.md"), "# 작업\n본문입니다", "utf8");
  for (const taskPath of [
    ".project-memory\\tasks\\TASK-001.md",
    ".project-memory/tasks/TASK-001.md",
    "./.project-memory/tasks/TASK-001.md",
  ]) {
    const result = await readFile(taskPath);
    assert.equal(result.ok, true, `${taskPath}: ${result.error}`);
    assert.equal(result.content, "# 작업\n본문입니다");
  }
});

test("경로 이탈·절대 경로·다른 폴더·하위 폴더·md가 아닌 파일은 거절한다", async () => {
  const { workspace, tasksDir, readFile } = await setup();
  fs.writeFileSync(path.join(workspace, "secret.md"), "비밀", "utf8");
  fs.writeFileSync(path.join(tasksDir, "TASK-1.txt"), "텍스트", "utf8");
  fs.writeFileSync(path.join(tasksDir, "TASK-1.md"), "정상", "utf8");
  fs.mkdirSync(path.join(tasksDir, "sub"));
  fs.writeFileSync(path.join(tasksDir, "sub", "a.md"), "하위", "utf8");
  fs.mkdirSync(path.join(workspace, "docs"));
  fs.writeFileSync(path.join(workspace, "docs", "a.md"), "문서", "utf8");
  for (const taskPath of [
    "../secret.md",
    ".project-memory/tasks/../../secret.md",
    ".project-memory\\tasks\\..\\..\\secret.md",
    path.join(workspace, "secret.md"),
    path.join(tasksDir, "TASK-1.md"),
    "C:\\Windows\\win.ini",
    "docs/a.md",
    ".project-memory/tasks/sub/a.md",
    ".project-memory/tasks/TASK-1.txt",
    ".project-memory/tasks/.md",
    ".project-memory/tasks/",
    ".project-memory/tasks/TASK 1.md",
    "",
    null,
  ]) {
    const result = await readFile(taskPath);
    assert.equal(result.ok, false, `거절되어야 합니다: ${taskPath}`);
    assert.ok(result.error);
    assert.equal(result.content, undefined);
  }
});

test("256KB를 넘는 파일, 없는 파일, 폴더인 .md는 거절하고 정확히 256KB는 읽는다", async () => {
  const { tasksDir, readFile } = await setup();
  fs.writeFileSync(path.join(tasksDir, "big.md"), "a".repeat(256 * 1024 + 1), "utf8");
  fs.writeFileSync(path.join(tasksDir, "edge.md"), "b".repeat(256 * 1024), "utf8");
  fs.mkdirSync(path.join(tasksDir, "dir.md"));
  assert.equal((await readFile(".project-memory/tasks/big.md")).ok, false);
  assert.equal((await readFile(".project-memory/tasks/none.md")).ok, false);
  assert.equal((await readFile(".project-memory/tasks/dir.md")).ok, false);
  const edge = await readFile(".project-memory/tasks/edge.md");
  assert.equal(edge.ok, true, edge.error);
  assert.equal(edge.content.length, 256 * 1024);
});

test("심볼릭 링크·정션으로 TASK 폴더 밖을 가리키면 거절한다", async (t) => {
  const { tasksDir, readFile } = await setup();
  const outside = tmp("agora-taskfile-out-");
  fs.writeFileSync(path.join(outside, "secret.md"), "밖의 비밀", "utf8");
  let fileLink = false;
  try {
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(tasksDir, "link.md"), "file");
    fileLink = true;
  } catch {}
  if (fileLink) {
    const result = await readFile(".project-memory/tasks/link.md");
    assert.equal(result.ok, false, "밖을 가리키는 파일 링크는 거절");
  }
  // tasks 폴더 자체를 밖으로 연결한 경우(정션은 Windows에서도 권한 없이 만들 수 있다).
  const ws2 = tmp("agora-taskfile-ws2-");
  fs.mkdirSync(path.join(ws2, ".project-memory"));
  let dirLink = false;
  try {
    fs.symlinkSync(outside, path.join(ws2, ".project-memory", "tasks"), "junction");
    dirLink = true;
  } catch {}
  if (dirLink) {
    const feature = makeFeature(tmp("agora-taskfile-root2-"));
    const pid = await createProject(feature, "링크", ws2);
    const result = await feature.invoke("chat:tasks:read-file", { projectId: pid, taskPath: ".project-memory/tasks/secret.md" });
    assert.equal(result.ok, false, "밖을 가리키는 tasks 폴더는 거절");
  }
  if (!fileLink && !dirLink) t.skip("이 환경에서는 링크를 만들 수 없습니다");
});

test("폴더가 없는 프로젝트나 모르는 프로젝트는 거절한다", async () => {
  const { feature, tasksDir, readFile } = await setup();
  fs.writeFileSync(path.join(tasksDir, "TASK-9.md"), "본문", "utf8");
  const otherId = await createProject(feature, "다른 프로젝트", null);
  assert.equal((await readFile(".project-memory/tasks/TASK-9.md", otherId)).ok, false);
  assert.equal((await readFile(".project-memory/tasks/TASK-9.md", "p-none")).ok, false);
});

// --- 렌더러: 카드에 파일 라벨과 읽기 전용 내용 보기 토글이 보인다 ---
const html = read("src/chat.html");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

function makeElement(id = "") {
  const listeners = {};
  const el = {
    id, hidden: false, disabled: false, value: "", textContent: "", title: "", className: "",
    children: [], options: [], dataset: {}, listeners,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    remove() {}, setAttribute() {}, getAttribute: () => null, focus() {}, blur() {}, select() {},
    setSelectionRange() {}, scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    selectionStart: 0, scrollHeight: 0, scrollTop: 0, clientHeight: 0, offsetWidth: 0,
  };
  return el;
}

function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function loadRenderer(state, readResult) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    documentElement: makeElement("root"),
    body: makeElement("body"),
    addEventListener() {},
    activeElement: null,
    hasFocus: () => true,
  };
  const calls = [];
  const chatApi = new Proxy({}, {
    get(_target, name) {
      if (name === "state") return () => Promise.resolve(state);
      if (typeof name === "string" && name.startsWith("on")) return () => () => {};
      return (...args) => {
        calls.push({ name, args });
        return Promise.resolve(name === "tasksReadFile" ? readResult : { ok: true });
      };
    },
  });
  const storage = new Map();
  const context = {
    document,
    window: { chatApi, innerWidth: 1280, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    CSS: { escape: (value) => String(value) },
    console,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: () => 0,
    clearTimeout() {},
    ResizeObserver: undefined,
  };
  context.window.document = document;
  vm.createContext(context);
  for (const file of ["src/chat-markdown.js", "src/usage-view.js", "src/awaiting-view.js"]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  Object.assign(context, {
    chatMarkdown: context.window.chatMarkdown,
    usageView: context.window.usageView,
    awaitingView: context.window.awaitingView,
  });
  vm.runInContext(read("src/chat.js"), context, { filename: "src/chat.js" });
  return { elements, calls };
}

const stateWithTasks = () => ({
  providers: [], diagnostics: [], discussionPresets: [],
  workflow: {
    decisions: [],
    roles: [{ id: "implementation", label: "구현" }],
    statuses: ["todo", "done"],
    tasks: [
      { id: "t1", projectId: "p1", title: "파일 작업", description: "", contentSource: "file", taskPath: ".project-memory\\tasks\\TASK-002.md", status: "todo", role: "implementation", agentId: null },
      { id: "t2", projectId: "p1", title: "직접 작업", description: "", contentSource: "inline", taskPath: null, status: "todo", role: "implementation", agentId: null },
    ],
  },
  projects: [{ id: "p1", name: "프로젝트", workspace: "D:/work", context: "", defaultPermissionMode: "workspace-write", defaultAgents: {} }],
  activeProjectId: "p1",
  sessions: [{ id: "s1", title: "대화", projectId: "p1" }],
  sessionsByProject: { p1: [{ id: "s1", title: "대화", projectId: "p1" }] },
  activeSessionId: "s1",
  session: {
    meta: { id: "s1", title: "대화", permissionMode: "workspace-write", workspace: "D:/work" },
    agents: [{ id: "claude", name: "Claude", aliases: ["claude"], color: "#c96", available: true, enabled: true }],
    typing: [], turnState: { current: null, running: [], queue: [], deferred: [] }, pendingAttachments: [], messages: [],
  },
});

test("파일 기반 카드는 라벨과 내용 보기 토글을 보이고, 내용은 textContent로만 넣는다", async () => {
  const body = "<img src=x onerror=alert(1)>\n# 본문";
  const { elements, calls } = loadRenderer(stateWithTasks(), { ok: true, content: body });
  await settle();
  await settle();
  elements.get("btn-workflow").listeners.click.at(-1)();
  const popover = elements.get("popover");

  const labels = findAll(popover, (n) => /^TASK 파일: /.test(n.textContent));
  assert.equal(labels.length, 1, "파일 기반 카드 하나에만 라벨이 있어야 합니다");
  assert.equal(labels[0].textContent, "TASK 파일: TASK-002.md (프로젝트 폴더)");
  const cards = findAll(popover, (n) => n.className === "workflow-card");
  assert.equal(cards.length, 2);
  assert.equal(findAll(cards[0], (n) => n.textContent === "본문은 TASK 파일에 있습니다.").length, 1);
  assert.equal(findAll(cards[1], (n) => n.textContent === "설명 없음").length, 1);
  assert.equal(findAll(cards[1], (n) => n.className === "workflow-card-file").length, 0);
  assert.ok(findAll(cards[0], (n) => n.textContent === "담당자 미지정").length >= 1, "담당자 select 빈 옵션 문구");
  assert.equal(findAll(popover, (n) => n.textContent === "프로젝트 기본").length, 0);

  const [toggle] = findAll(cards[0], (n) => n.textContent === "내용 보기");
  const [pre] = findAll(cards[0], (n) => n.className === "workflow-card-file-body");
  assert.equal(pre.hidden, true);
  await toggle.listeners.click.at(-1)();
  const call = calls.find((c) => c.name === "tasksReadFile");
  assert.deepEqual(call.args, ["p1", ".project-memory\\tasks\\TASK-002.md"]);
  assert.equal(pre.hidden, false);
  assert.equal(pre.textContent, body);
  assert.equal(pre.innerHTML, undefined, "innerHTML을 쓰지 않는다");
  assert.equal(toggle.textContent, "내용 닫기");
  await toggle.listeners.click.at(-1)();
  assert.equal(pre.hidden, true);
  assert.equal(toggle.textContent, "내용 보기");
});

test("읽기에 실패하면 내용을 펼치지 않는다", async () => {
  const { elements } = loadRenderer(stateWithTasks(), { ok: false, error: "TASK 파일을 찾을 수 없습니다." });
  await settle();
  await settle();
  elements.get("btn-workflow").listeners.click.at(-1)();
  const popover = elements.get("popover");
  const [toggle] = findAll(popover, (n) => n.textContent === "내용 보기");
  const [pre] = findAll(popover, (n) => n.className === "workflow-card-file-body");
  await toggle.listeners.click.at(-1)();
  assert.equal(pre.hidden, true);
  assert.equal(pre.textContent, "");
});
