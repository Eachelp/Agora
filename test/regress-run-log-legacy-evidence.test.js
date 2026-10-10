"use strict";

// 실행 로그 정리는 *.log만 다룬다. 옛 전문 모드가 남긴 *.evidence.json은
// 개수가 한도를 넘어도 보통 실행이 건드리지 않는다(사용자 데이터 보존).
// 실제 CLI 없이 정리 경로를 타려면 정리를 호출하는 createRunLogWriter를 쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRunLogWriter, MAX_RUN_LOG_FILES } = require("../src/chat/chat-ipc");
const { ChatStore } = require("../src/chat/chat-store");

test("한도를 넘는 옛 evidence.json은 실행 뒤에도 그대로 남고 .log만 정리된다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-runlog-evidence-"));
  try {
    const store = new ChatStore({ root }).init();
    const meta = store.createSession({ title: "옛 증거" });
    const logsDir = store.runLogsDir(meta.id);
    fs.mkdirSync(logsDir, { recursive: true });

    const total = MAX_RUN_LOG_FILES + 5;
    for (let i = 0; i < total; i += 1) {
      const past = new Date(Date.now() - (total - i) * 60000);
      for (const name of [`old-${i}.log`, `old-${i}.evidence.json`]) {
        const file = path.join(logsDir, name);
        fs.writeFileSync(file, "{}", "utf8");
        fs.utimesSync(file, past, past);
      }
    }

    const writer = createRunLogWriter(store, meta.id, "r-newest");
    writer.write("최신 로그");
    writer.close();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const names = fs.readdirSync(logsDir);
    assert.equal(names.filter((name) => name.endsWith(".evidence.json")).length, total, "옛 evidence 파일은 모두 남아야 합니다");
    const logs = names.filter((name) => name.endsWith(".log"));
    assert.ok(logs.length <= MAX_RUN_LOG_FILES, `남은 로그 ${logs.length}개`);
    assert.ok(logs.some((name) => name.includes("r-newest")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
