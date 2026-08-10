const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore, MAX_RULES_CHARS } = require("../src/agora/memory-store");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-memory-store-"));
}

test("Memory Bank는 사람 기록과 기록관 초안을 같은 Markdown에 출처와 상태로 남긴다", () => {
  let clock = 1_700_000_000_000;
  const store = new MemoryStore({ root: makeRoot(), now: () => (clock += 1) }).init();

  const human = store.append("project-a", {
    source: "human",
    title: "사용자 결정",
    content: "기존 토론 제어 태그는 유지한다.",
  });
  const agent = store.append("project-a", {
    source: "agent",
    title: "토론 요약 초안",
    content: "검토가 필요한 요약입니다.",
  });

  assert.equal(human.status, "verified");
  assert.equal(agent.status, "draft");
  const markdown = store.read("project-a");
  assert.match(markdown, /사람이 추가/);
  assert.match(markdown, /검증됨/);
  assert.match(markdown, /기록관 초안/);
  assert.match(markdown, /검토 필요/);
  assert.match(store.readForPrompt("project-a"), /기존 토론 제어 태그/);
});

test("Memory Bank가 없거나 너무 길어도 프롬프트용 읽기는 안전하게 동작한다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  assert.equal(store.read("project-a"), "");
  assert.equal(store.readForPrompt("project-a"), "");
  store.append("project-a", { source: "human", content: "앞".repeat(100) });
  assert.match(store.readForPrompt("project-a", 20), /Memory Bank 앞부분은 생략됨/);
});

test("규칙이 없는 프로젝트는 빈 문자열을 반환한다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  assert.equal(store.readRules("project-a"), "");
  assert.equal(store.readRulesHistory("project-a"), "");
});

test("저장한 규칙이 그대로 다시 읽힌다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  const result = store.saveRules("project-a", "이 프로젝트는 Agora 채팅 코어를 유지한다.");
  assert.equal(result.changed, true);
  assert.equal(store.readRules("project-a"), "이 프로젝트는 Agora 채팅 코어를 유지한다.");
});

test("같은 내용으로 두 번 저장하면 이력이 쌓이지 않는다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  store.saveRules("project-a", "규칙 A");
  const second = store.saveRules("project-a", "규칙 A");
  assert.equal(second.changed, false);
  assert.equal(store.readRulesHistory("project-a"), "");
});

test("규칙을 바꿔 저장하면 이전 내용이 이력에 남는다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  store.saveRules("project-a", "규칙 A");
  const second = store.saveRules("project-a", "규칙 B");
  assert.equal(second.changed, true);
  assert.equal(store.readRules("project-a"), "규칙 B");
  assert.match(store.readRulesHistory("project-a"), /규칙 A/);
});

test("규칙은 MAX_RULES_CHARS를 넘으면 잘려서 저장된다", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  const long = "가".repeat(MAX_RULES_CHARS + 500);
  store.saveRules("project-a", long);
  assert.equal(store.readRules("project-a").length, MAX_RULES_CHARS);
});

test("\uD504\uB85C\uC81D\uD2B8\uB97C \uC9C0\uC6B0\uBA74 \uBA54\uBAA8\uB9AC\uC640 \uADDC\uCE59 \uD30C\uC77C\uB3C4 \uD568\uAED8 \uC815\uB9AC\uB41C\uB2E4", () => {
  const root = makeRoot();
  let clock = 1_700_000_000_000;
  const store = new MemoryStore({ root, now: () => (clock += 1) }).init();

  store.append("project-a", { source: "human", title: "t", content: "a\uAE30\uB85D" });
  store.saveRules("project-a", "a\uADDC\uCE59");
  store.saveRules("project-a", "a\uADDC\uCE59 \uC218\uC815");
  store.append("project-b", { source: "human", title: "t", content: "b\uAE30\uB85D" });
  store.saveRules("project-b", "b\uADDC\uCE59");

  assert.ok(fs.existsSync(store.projectPath("project-a")));
  assert.ok(fs.existsSync(store.rulesPath("project-a")));
  assert.ok(fs.existsSync(store.rulesHistoryPath("project-a")));

  assert.equal(store.deleteProject("project-a"), true);

  assert.equal(fs.existsSync(store.projectPath("project-a")), false);
  assert.equal(fs.existsSync(store.rulesPath("project-a")), false);
  assert.equal(fs.existsSync(store.rulesHistoryPath("project-a")), false);

  // \uB2E4\uB978 \uD504\uB85C\uC81D\uD2B8\uB294 \uADF8\uB300\uB85C \uB0A8\uC544\uC57C \uD569\uB2C8\uB2E4.
  assert.ok(fs.existsSync(store.projectPath("project-b")));
  assert.ok(fs.existsSync(store.rulesPath("project-b")));
  assert.equal(store.readRules("project-b").trim(), "b\uADDC\uCE59");
});

test("\uC5C6\uB294 \uD504\uB85C\uC81D\uD2B8\uB97C \uC9C0\uC6B0\uBA74 false\uB97C \uB3CC\uB824\uC900\uB2E4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  assert.equal(store.deleteProject("project-none"), false);
  assert.equal(store.deleteProject(""), false);
});
