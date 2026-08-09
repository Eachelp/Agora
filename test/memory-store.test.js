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

test("\uaddc\uce59\uc774 \uc5c6\ub294 \ud504\ub85c\uc81d\ud2b8\ub294 \ube48 \ubb38\uc790\uc5f4\uc744 \ubc18\ud658\ud55c\ub2e4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  assert.equal(store.readRules("project-a"), "");
  assert.equal(store.readRulesHistory("project-a"), "");
});

test("\uc800\uc7a5\ud55c \uaddc\uce59\uc774 \uadf8\ub300\ub85c \ub2e4\uc2dc \uc77d\ud78c\ub2e4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  const result = store.saveRules("project-a", "\uc774 \ud504\ub85c\uc81d\ud2b8\ub294 Agora \ucc44\ud305 \ucf54\uc5b4\ub97c \uc720\uc9c0\ud55c\ub2e4.");
  assert.equal(result.changed, true);
  assert.equal(store.readRules("project-a"), "\uc774 \ud504\ub85c\uc81d\ud2b8\ub294 Agora \ucc44\ud305 \ucf54\uc5b4\ub97c \uc720\uc9c0\ud55c\ub2e4.");
});

test("\uac19\uc740 \ub0b4\uc6a9\uc73c\ub85c \ub450 \ubc88 \uc800\uc7a5\ud558\uba74 \uc774\ub825\uc774 \uc313\uc774\uc9c0 \uc54a\ub294\ub2e4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  store.saveRules("project-a", "\uaddc\uce59 A");
  const second = store.saveRules("project-a", "\uaddc\uce59 A");
  assert.equal(second.changed, false);
  assert.equal(store.readRulesHistory("project-a"), "");
});

test("\uaddc\uce59\uc744 \ubc14\uafd4 \uc800\uc7a5\ud558\uba74 \uc774\uc804 \ub0b4\uc6a9\uc774 \uc774\ub825\uc5d0 \ub0a8\ub294\ub2e4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  store.saveRules("project-a", "\uaddc\uce59 A");
  const second = store.saveRules("project-a", "\uaddc\uce59 B");
  assert.equal(second.changed, true);
  assert.equal(store.readRules("project-a"), "\uaddc\uce59 B");
  assert.match(store.readRulesHistory("project-a"), /\uaddc\uce59 A/);
});

test("\uaddc\uce59\uc740 MAX_RULES_CHARS\ub97c \ub118\uc73c\uba74 \uc798\ub824\uc11c \uc800\uc7a5\ub41c\ub2e4", () => {
  const store = new MemoryStore({ root: makeRoot() }).init();
  const long = "\uac00".repeat(MAX_RULES_CHARS + 500);
  store.saveRules("project-a", long);
  assert.equal(store.readRules("project-a").length, MAX_RULES_CHARS);
});
