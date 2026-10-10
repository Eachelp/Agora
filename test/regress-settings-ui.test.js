"use strict";

// 설정 창(src/settings.js)을 실제로 불러와(가짜 DOM + 가짜 settingsApi) 확인한다.
// F131: 로그인 시작 응답이 이미 받은 로그인 주소를 지운다.
// F163: 설정 창을 닫았다 다시 열면 진행 중인 로그인의 패널이 사라진다.
// F132: 저장이 화면 값 전체를 보내 로드 전·갱신 전 값으로 실제 설정을 덮어쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createCliLoginRunner } = require("../src/agora/cli-login");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function makeElement() {
  const listeners = {};
  const el = {
    children: [], dataset: {}, listeners, hidden: false, disabled: false, checked: false,
    value: "", textContent: "", className: "", title: "", type: "", placeholder: "", src: "", alt: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    querySelector: () => null, setAttribute() {}, focus() {}, scrollTo() {},
    dispatch(type, event = {}) { for (const handler of listeners[type] || []) handler({ currentTarget: el, ...event }); },
  };
  return el;
}

function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const THEME = { page: "#f6f8fc", sidebar: "#eef2f8", surface: "#ffffff", ink: "#102342", muted: "#64748b", accent: "#173f78", line: "#dbe3ef" };
const baseState = (over = {}) => ({
  appearance: { fontFamily: "Malgun Gothic", fontSize: 12, uiTheme: { ...THEME }, showAwaiting: true },
  autoStart: true,
  providers: [
    { id: "claude", label: "Claude", accounts: [] },
    { id: "codex", label: "Codex", accounts: [] },
    { id: "agy", label: "AGY", accounts: [] },
  ],
  usage: [],
  logins: {},
  ...over,
});

// api: 테스트가 덮어쓰는 settingsApi 동작.
async function loadSettings(api) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  const document = {
    documentElement: makeElement(),
    querySelector: get,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
  };
  const handlers = {};
  const settingsApi = {
    get: async () => ({ ok: true, data: baseState() }),
    fonts: async () => ({ ok: true, data: ["Arial", "Malgun Gothic"] }),
    save: async () => ({ ok: true, data: baseState() }),
    account: async () => ({ ok: true }),
    usage: async () => ({ ok: true, data: baseState() }),
    wipeAll: async () => ({ ok: true }),
    onAppearance: () => {},
    onNavigate: () => {},
    onMaximizedState: () => {},
    onAccountLogin: (handler) => { handlers.login = handler; },
    minimize() {}, maximize() {}, close() {},
    ...api,
  };
  const context = {
    document,
    window: { settingsApi, confirm: () => true },
    Option: class Option { constructor(label, value) { this.label = label; this.value = value; this.style = {}; } },
    console, setTimeout, clearTimeout,
  };
  context.window.document = document;
  vm.createContext(context);
  vm.runInContext(read("src/usage-view.js"), context, { filename: "src/usage-view.js" });
  context.usageView = context.window.usageView || vm.runInContext("typeof usageView === 'undefined' ? undefined : usageView", context);
  // 최상위 const는 vm 컨텍스트의 전역 스코프에 남으므로, 글로벌 객체에 usageView가 없으면 모듈 export를 대신 쓴다.
  if (!context.usageView) {
    const exported = { module: { exports: {} } };
    vm.runInContext(`(function (module) { ${read("src/usage-view.js")} })(module)`, Object.assign(context, exported));
    context.usageView = exported.module.exports;
  }
  vm.runInContext(read("src/settings.js"), context, { filename: "src/settings.js" });
  await settle();
  return {
    get,
    handlers,
    groupButtons: (label) => findAll(get("#provider-groups"), (node) => node.textContent === label),
    save: () => get("#save").dispatch("click"),
  };
}

test("F131: 로그인 시작 응답이 이벤트로 이미 받은 로그인 주소를 지우지 않는다", async () => {
  let respond;
  const api = {
    account: (input) => (input.action === "login"
      ? new Promise((resolve) => { respond = () => resolve({ ok: true, data: baseState(), login: { running: true } }); })
      : Promise.resolve({ ok: true })),
  };
  const ui = await loadSettings(api);
  const [addClaude] = ui.groupButtons("계정 추가");
  addClaude.dispatch("click");
  // main은 계정 목록을 읽는 동안 로그인 CLI의 이벤트를 먼저 보낸다. 응답이 맨 마지막에 도착한다.
  ui.handlers.login({ provider: "claude", type: "started" });
  ui.handlers.login({ provider: "claude", type: "url", url: "https://claude.example/login" });
  respond();
  await settle();
  const [openBrowser] = ui.groupButtons("브라우저 열기");
  assert.ok(openBrowser, "로그인 패널이 보여야 한다");
  assert.equal(openBrowser.disabled, false, "받은 주소가 있으니 '브라우저 열기'가 켜져 있어야 한다");
});

test("F131: 이벤트 없이 응답만 오면 그대로 진행 중 패널을 만든다", async () => {
  const ui = await loadSettings({ account: async () => ({ ok: true, data: baseState(), login: { running: true } }) });
  ui.groupButtons("계정 추가")[0].dispatch("click");
  await settle();
  assert.equal(ui.groupButtons("브라우저 열기").length, 1);
  assert.equal(ui.groupButtons("취소").length, 1);
});

test("F163: 설정 창을 다시 열면 진행 중인 로그인의 패널(주소·취소·코드 입력)이 되살아난다", async () => {
  const state = baseState({
    logins: { claude: { running: true, urls: ["https://claude.example/login"], prompt: true } },
  });
  const ui = await loadSettings({ get: async () => ({ ok: true, data: state }) });
  const [openBrowser] = ui.groupButtons("브라우저 열기");
  assert.ok(openBrowser, "진행 중인 로그인의 패널이 있어야 한다");
  assert.equal(openBrowser.disabled, false);
  assert.equal(ui.groupButtons("취소").length, 1, "취소 버튼");
  assert.equal(ui.groupButtons("코드 보내기").length, 1, "인증 코드 입력");
  // 로그인 중인 제공자의 '계정 추가'는 눌러도 거부될 뿐이므로 꺼 둔다.
  assert.equal(ui.groupButtons("계정 추가")[0].disabled, true);
});

test("F163: 진행 중인 로그인이 없으면 패널이 없다", async () => {
  const ui = await loadSettings({});
  assert.equal(ui.groupButtons("취소").length, 0);
  assert.equal(ui.groupButtons("계정 추가")[0].disabled, false);
});

test("F163: 로그인 러너가 진행 중인 로그인의 주소와 프롬프트 여부를 알려 준다(main이 설정 창에 싣는 값)", async () => {
  let child;
  const runner = createCliLoginRunner({
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = { write() { return true; }, destroyed: false };
      child.kill = () => {};
      return child;
    },
  });
  assert.equal(runner.snapshot("claude"), null);
  runner.start({ provider: "claude", command: "claude", args: ["auth", "login"] });
  assert.deepEqual(runner.snapshot("claude"), { running: true, urls: [], prompt: false });
  child.stdout.write("Visit https://claude.example/login\nPaste code here > ");
  await settle();
  assert.deepEqual(runner.snapshot("claude"), { running: true, urls: ["https://claude.example/login"], prompt: true });
  child.emit("exit", 0, null);
  await settle();
  assert.equal(runner.snapshot("claude"), null, "끝난 로그인은 알리지 않는다");
});

test("F163: main이 getSettingsData에 진행 중인 로그인을 싣는다", () => {
  assert.match(read("src/main.js"), /logins: getProviderLoginSnapshots\(\)/);
  assert.match(read("src/agora/account-switching.js"), /getProviderLoginSnapshots,/);
});

test("F132: 설정을 불러오기 전에 '변경 사항 적용'을 눌러도 아무것도 저장하지 않는다", async () => {
  const saved = [];
  const ui = await loadSettings({
    get: () => new Promise(() => {}), // 계정·사용량 조회가 아직 끝나지 않았다
    save: async (value) => { saved.push(value); return { ok: true, data: baseState() }; },
  });
  ui.save();
  await settle();
  assert.deepEqual(saved, []);
  assert.match(ui.get("#toast").textContent, /불러오는 중/);
});

test("F132: 사용자가 바꾼 항목만 보낸다(글꼴·자동 실행·답변 대기 표시를 덮어쓰지 않는다)", async () => {
  const saved = [];
  const ui = await loadSettings({
    save: async (value) => { saved.push(value); return { ok: true, data: baseState() }; },
  });
  const size = ui.get("#font-size");
  size.value = "16";
  size.dispatch("input");
  ui.save();
  await settle();
  assert.equal(JSON.stringify(saved), JSON.stringify([{ fontSize: 16 }])); // 가짜 DOM(vm)의 객체라 JSON으로 비교
});

test("F132: 트레이에서 바뀐 값은 사용자가 건드리지 않으면 되돌리지 않는다", async () => {
  const saved = [];
  let current = baseState({ autoStart: false }); // 설정 창이 열릴 때는 꺼져 있었다
  const ui = await loadSettings({
    get: async () => ({ ok: true, data: current }),
    save: async (value) => { saved.push(value); return { ok: true, data: current }; },
  });
  // 설정 창을 연 채 트레이에서 자동 실행을 켰고, 계정 새로고침으로 최신 값을 받았다.
  current = baseState({ autoStart: true });
  ui.get("#refresh-accounts").dispatch("click");
  await settle();
  const theme = ui.get("#ui-accent-color");
  theme.value = "#112233";
  theme.dispatch("input");
  ui.save();
  await settle();
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]), ["uiTheme"]);
  assert.equal(saved[0].uiTheme.accent, "#112233");
});

test("F132: 바뀐 것이 없으면 저장 요청을 보내지 않는다", async () => {
  const saved = [];
  const ui = await loadSettings({ save: async (value) => { saved.push(value); return { ok: true, data: baseState() }; } });
  ui.save();
  await settle();
  assert.deepEqual(saved, []);
  assert.match(ui.get("#toast").textContent, /바뀐 설정이 없/);
});
