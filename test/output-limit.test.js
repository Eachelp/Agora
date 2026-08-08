const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatStore } = require("../src/chat/chat-store");
const { createRunLogWriter, MAX_RUN_LOG_FILES } = require("../src/chat/chat-ipc");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const runnerJs = source("src/chat/chat-agent-runner.js");
const chatJs = source("src/chat.js");
const chatCss = source("src/chat.css");
const chatIpcJs = source("src/chat/chat-ipc.js");
const chatStoreJs = source("src/chat/chat-store.js");
const mainJs = source("src/main.js");

test("stdout이 길다는 이유만으로 실행을 죽이는 경로가 없다", () => {
  // 과거에는 stdout 누적량이 상한을 넘으면 즉시 실패로 종료했습니다.
  assert.doesNotMatch(runnerJs, /출력이 너무 길어 실행을 중단했습니다/);
  assert.doesNotMatch(runnerJs, /maxOutputBytes/);
  // hard limit은 명시적으로 요청했을 때만 동작합니다.
  assert.match(runnerJs, /DEFAULT_HARD_OUTPUT_LIMIT_BYTES = null/);
});

test("수집 한도와 hard limit이 서로 다른 설정으로 분리되어 있다", () => {
  assert.match(runnerJs, /captureOutputBytes = DEFAULT_CAPTURE_OUTPUT_BYTES/);
  assert.match(runnerJs, /hardOutputLimitBytes = DEFAULT_HARD_OUTPUT_LIMIT_BYTES/);
  // 수집 한도 초과는 실패가 아니라 tail buffer 절단으로 처리됩니다.
  assert.match(runnerJs, /createTailBuffer\(captureOutputBytes\)/);
});

test("hard limit 중단은 OUTPUT_LIMIT 상태로 구분되고 partial output을 남긴다", () => {
  assert.match(runnerJs, /outputLimited: true/);
  assert.match(runnerJs, /partialText/);
  // 사용자 중지와 혼동되지 않아야 합니다.
  assert.match(runnerJs, /if \(cancelled && !outputLimitHit\)/);
});

test("실행 원본 출력은 진단 파일로 보존된다", () => {
  assert.match(chatStoreJs, /runLogsDir\(id\)/);
  assert.match(chatIpcJs, /createRunLogWriter/);
  assert.match(chatIpcJs, /onRawChunk: rawLog\.write/);
  assert.match(chatIpcJs, /rawLogName/);
});

test("renderer에는 원본 로그의 파일 경로를 보내지 않는다", () => {
  // 기존 보안 경계: renderer는 파일 시스템 경로를 받지 않습니다.
  assert.match(chatIpcJs, /rawLogName: path\.basename\(logPath\)/);
  assert.doesNotMatch(chatJs, /rawLogPath/);
});

test("hard limit은 사용자 설정으로만 켜진다", () => {
  assert.match(mainJs, /agentOutputHardLimitMB/);
  assert.match(chatIpcJs, /getHardOutputLimitBytes/);
  // 설정이 없으면 상한을 전달하지 않습니다.
  assert.match(chatIpcJs, /hardOutputLimitBytes \? \{ hardOutputLimitBytes \} : \{\}/);
});

test("renderer는 표시량만 접고 실행 결과를 계속 기다린다", () => {
  assert.match(chatJs, /LIVE_DISPLAY_LIMIT_CHARS/);
  assert.match(chatJs, /출력이 길어 일부 내용을 접었습니다/);
  // 실패했다고 라이브 초안을 즉시 제거하지 않습니다.
  assert.doesNotMatch(chatJs, /if \(!payload\.ok\) \{\s*live\.item\.remove\(\)/);
});

test("실패한 메시지는 원인 구분과 중간 출력, 진단 정보를 함께 보여준다", () => {
  assert.match(chatJs, /출력 상한 초과로 중단/);
  assert.match(chatJs, /시간 초과로 중단/);
  assert.match(chatJs, /중단 전까지 받은 출력/);
  assert.match(chatJs, /원본 로그 보관됨/);
  assert.match(chatCss, /\.failure-partial-text/);
});

test("실행 로그 폴더는 세션 폴더 아래에 만들어지고 transcript와 분리된다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-runlog-"));
  try {
    const store = new ChatStore({ root }).init();
    const meta = store.createSession({ title: "출력 테스트" });
    const logsDir = store.runLogsDir(meta.id);

    // transcript 파일과 같은 폴더를 공유하지 않아야 대화 기록 형식을 건드리지 않습니다.
    assert.notEqual(logsDir, path.dirname(store.transcriptPath(meta.id)) + path.sep);
    assert.ok(logsDir.startsWith(store.sessionDir(meta.id)));

    // 실제로 쓰기가 가능한 위치여야 합니다.
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, "r1.log");
    fs.writeFileSync(logFile, "원본 stdout 조각", "utf8");
    assert.equal(fs.readFileSync(logFile, "utf8"), "원본 stdout 조각");

    // 기존 transcript는 영향을 받지 않습니다.
    assert.ok(fs.existsSync(store.metaPath(meta.id)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("원본 출력은 실제 진단 파일로 기록되고 경로를 돌려준다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-runlog-write-"));
  try {
    const store = new ChatStore({ root }).init();
    const meta = store.createSession({ title: "로그 기록" });

    const writer = createRunLogWriter(store, meta.id, "r-abc-1");
    writer.write("첫 번째 조각\n");
    writer.write("두 번째 조각");
    const logPath = writer.close();

    assert.ok(logPath, "로그 경로가 반환되어야 합니다.");
    // 스트림이 flush될 시간을 줍니다.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const written = fs.readFileSync(logPath, "utf8");
    assert.match(written, /첫 번째 조각/);
    assert.match(written, /두 번째 조각/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("오래된 실행 로그는 최근 것만 남기고 정리된다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agora-runlog-prune-"));
  try {
    const store = new ChatStore({ root }).init();
    const meta = store.createSession({ title: "로그 정리" });
    const logsDir = store.runLogsDir(meta.id);
    fs.mkdirSync(logsDir, { recursive: true });

    // 한도보다 많은 로그를 만들고, 마지막 writer가 정리를 수행하게 합니다.
    const total = MAX_RUN_LOG_FILES + 5;
    for (let i = 0; i < total; i += 1) {
      const file = path.join(logsDir, `old-${i}.log`);
      fs.writeFileSync(file, "x", "utf8");
      // mtime을 과거로 밀어 정렬이 결정적으로 동작하게 합니다.
      const past = new Date(Date.now() - (total - i) * 60000);
      fs.utimesSync(file, past, past);
    }

    const writer = createRunLogWriter(store, meta.id, "r-newest");
    writer.write("최신 로그");
    writer.close();

    // 정리는 스트림 flush 이후에 수행됩니다.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const remaining = fs.readdirSync(logsDir).filter((name) => name.endsWith(".log"));
    assert.ok(remaining.length <= MAX_RUN_LOG_FILES, `남은 로그 ${remaining.length}개`);
    // 가장 최근 로그는 남아 있어야 합니다.
    assert.ok(remaining.some((name) => name.includes("r-newest")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
