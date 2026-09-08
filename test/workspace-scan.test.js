"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { filesModifiedSince, SKIP_DIRS } = require("../src/agora/workspace-scan");

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agora-scan-"));
}

function write(root, rel, text = "x") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

test("기준 시각 이후에 바뀐 파일만 돌려준다", async () => {
  const root = makeWorkspace();
  write(root, "before.txt");
  write(root, "claude/old.txt");
  // 파일 시스템 수정시각 해상도를 넘기기 위해 잠시 기다린다.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  write(root, "claude/새-시안.md");
  write(root, "src/기존파일.js");
  fs.writeFileSync(path.join(root, "before.txt"), "고쳐졌다", "utf8");

  const scan = await filesModifiedSince(root, since);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.paths, ["before.txt", "claude/새-시안.md", "src/기존파일.js"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("실행 전부터 있던 사용자 변경은 세지 않는다", async () => {
  const root = makeWorkspace();
  // 사용자가 미리 고쳐 둔 파일. git diff 기준이었다면 이것까지 잡혔을 것이다.
  write(root, "사용자가-미리-고친-것.txt");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const scan = await filesModifiedSince(root, Date.now());
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.paths, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("도구가 만드는 폴더는 훑지 않는다", async () => {
  const root = makeWorkspace();
  const since = Date.now() - 60000;
  write(root, "node_modules/pkg/index.js");
  write(root, ".git/objects/ab/cdef");
  write(root, ".agora/checkpoints/c1/manifest.json");
  write(root, "dist/bundle.js");
  write(root, "codex/시안.md");
  const scan = await filesModifiedSince(root, since);
  assert.deepEqual(scan.paths, ["codex/시안.md"]);
  // 목록은 눈으로도 확인할 수 있게 열려 있다.
  assert.ok(SKIP_DIRS.has("node_modules") && SKIP_DIRS.has(".agora"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("파일이 너무 많거나 시간이 오래 걸리면 결과를 버린다", async () => {
  const root = makeWorkspace();
  for (let i = 0; i < 12; i += 1) write(root, `f${i}.txt`);
  const tooMany = await filesModifiedSince(root, Date.now() - 60000, { maxEntries: 5 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.reason, "TOO_MANY_FILES");

  let clock = 0;
  const timedOut = await filesModifiedSince(root, Date.now() - 60000, {
    deadlineMs: 10,
    now: () => (clock += 50),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "TIMED_OUT");
  fs.rmSync(root, { recursive: true, force: true });
});

test("작업 폴더가 없으면 조용히 실패한다", async () => {
  const missing = await filesModifiedSince(path.join(os.tmpdir(), "없는-폴더-12345"), Date.now());
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "NO_WORKSPACE");
  assert.equal((await filesModifiedSince(null, Date.now())).reason, "NO_WORKSPACE");
  const root = makeWorkspace();
  assert.equal((await filesModifiedSince(root, null)).reason, "NO_BASELINE");
  fs.rmSync(root, { recursive: true, force: true });
});

test("symlink는 따라가지 않는다", async () => {
  const root = makeWorkspace();
  const outside = makeWorkspace();
  write(outside, "밖의-파일.txt");
  try {
    fs.symlinkSync(outside, path.join(root, "link"));
  } catch {
    // 심볼릭 링크를 만들 수 없는 환경(Windows 권한)에서는 검사할 것이 없다.
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    return;
  }
  const scan = await filesModifiedSince(root, Date.now() - 60000);
  assert.deepEqual(scan.paths, [], "작업 폴더 밖으로 나가면 안 됩니다");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
