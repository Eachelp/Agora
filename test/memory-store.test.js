const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/agora/memory-store");

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
