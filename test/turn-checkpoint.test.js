"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createCheckpoint,
  restoreCheckpoint,
  cleanupCheckpoint,
  CHECKPOINT_FAILURE_CODES,
} = require("../src/agora/turn-checkpoint");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-checkpoint-test-"));
  const real = fs.realpathSync(dir);
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  git(real, ["init", "-q"]);
  git(real, ["config", "user.email", "test@example.com"]);
  git(real, ["config", "user.name", "Test"]);
  return real;
}

test("git이 아닌 폴더에서는 checkpoint를 지원하지 않는다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-checkpoint-nongit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkpoint = await createCheckpoint(dir);
  assert.equal(checkpoint.supported, false);
});

test("workspace가 없으면 checkpoint를 지원하지 않는다", async () => {
  const checkpoint = await createCheckpoint(null);
  assert.equal(checkpoint.supported, false);
});

test("저장소 쓰기 실패는 OS raw code가 아니라 CHECKPOINT_* enum으로 보고한다", async (t) => {
  const repo = makeTempRepo(t);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);

  // storageRoot 자리에 "파일"을 만들어 mkdirSync가 ENOTDIR/EEXIST로 실패하게 한다.
  const blocker = path.join(repo, "blocked-root");
  fs.writeFileSync(blocker, "not a directory", "utf8");

  const checkpoint = await createCheckpoint(repo, { storageRoot: path.join(blocker, "nested") });
  assert.equal(checkpoint.supported, false);
  assert.equal(checkpoint.failed, true);
  assert.ok(
    CHECKPOINT_FAILURE_CODES.includes(checkpoint.reason),
    `reason은 CHECKPOINT_* enum이어야 하는데 실제: ${checkpoint.reason}`
  );
  assert.ok(
    !/^E[A-Z]+$/.test(checkpoint.reason),
    `OS raw error code가 그대로 노출되면 안 된다: ${checkpoint.reason}`
  );
  assert.equal(checkpoint.reason, "CHECKPOINT_STORAGE_FAILED");
});

test("Git 저장소인데 백업 생성에 실패하면 failed:true와 taxonomy reason을 반환한다", async (t) => {
  // 커밋이 없는 리포: git rev-parse HEAD가 실패해 catch 블록에서
  // supported:false + failed:true + reason(taxonomy)를 반환한다.
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-checkpoint-fail-")); }
  catch { throw new Error("tempdir"); }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  const checkpoint = await createCheckpoint(dir);
  assert.equal(checkpoint.supported, false);
  assert.equal(checkpoint.failed, true);
  assert.equal(checkpoint.reason, "CHECKPOINT_GIT_FAILED");
});

test("checkpoint 생성 후 Builder 변경만 되돌리고 사용자 사전 변경은 보존한다", async (t) => {
  const repo = makeTempRepo(t);
  const userFile = path.join(repo, "user.txt");
  const trackedFile = path.join(repo, "src", "app.js");
  fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
  // 사용자 사전 변경: tracked 파일 수정 + untracked 파일 생성
  fs.writeFileSync(trackedFile, "module.exports = 1;\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);
  fs.writeFileSync(trackedFile, "module.exports = 42;\n", "utf8");
  fs.writeFileSync(userFile, "user note\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  // Builder가 tracked 파일을 다시 수정하고, 새 untracked 파일을 만든 상황.
  fs.writeFileSync(trackedFile, "module.exports = 999;\n", "utf8");
  const builderFile = path.join(repo, "builder-output.txt");
  fs.writeFileSync(builderFile, "builder made this\n", "utf8");

  const result = await restoreCheckpoint(repo, checkpoint);
  assert.equal(result.ok, true);

  // Builder 변경은 되돌아가고, 사용자 사전 변경은 보존.
  assert.equal(fs.readFileSync(trackedFile, "utf8").replace(/\r\n/g, "\n"), "module.exports = 42;\n");
  assert.equal(fs.readFileSync(userFile, "utf8").replace(/\r\n/g, "\n"), "user note\n");
  assert.equal(fs.existsSync(builderFile), false);
  cleanupCheckpoint(checkpoint);
});

test("Builder가 새로 만든 파일만 제거하고 checkpoint 시점 untracked 파일은 유지한다", async (t) => {
  const repo = makeTempRepo(t);
  const trackedFile = path.join(repo, "app.js");
  fs.writeFileSync(trackedFile, "module.exports = 1;\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);

  const untrackedUser = path.join(repo, "notes", "keep.md");
  fs.mkdirSync(path.dirname(untrackedUser), { recursive: true });
  fs.writeFileSync(untrackedUser, "keep me\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  // Builder가 새 untracked 파일을 만들고, 기존 untracked 파일을 수정.
  const builderFile = path.join(repo, "new-file.bin");
  fs.writeFileSync(builderFile, "x", "utf8");
  fs.writeFileSync(untrackedUser, "builder overwrote\n", "utf8");

  const result = await restoreCheckpoint(repo, checkpoint);
  assert.equal(result.ok, true);

  assert.equal(fs.existsSync(builderFile), false);
  assert.equal(fs.readFileSync(untrackedUser, "utf8").replace(/\r\n/g, "\n"), "keep me\n");
  cleanupCheckpoint(checkpoint);
});

test("checkpoint schema v3: index(staged) 상태도 함께 복원한다", async (t) => {
  const repo = makeTempRepo(t);
  const stagedFile = path.join(repo, "staged.txt");
  const dirtyFile = path.join(repo, "dirty.txt");
  fs.writeFileSync(stagedFile, "v1\n", "utf8");
  fs.writeFileSync(dirtyFile, "v1\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "baseline"]);

  // 사용자 사전 변경: staged 1건 + 작업 트리만 수정한 1건.
  fs.writeFileSync(stagedFile, "user staged v2\n", "utf8");
  git(repo, ["add", "staged.txt"]);
  fs.writeFileSync(dirtyFile, "user dirty v2\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  // Builder가 두 파일을 모두 덮어쓰고 새 파일을 만든다.
  fs.writeFileSync(stagedFile, "builder wreck\n", "utf8");
  fs.writeFileSync(dirtyFile, "builder wreck\n", "utf8");
  const builderFile = path.join(repo, "builder-junk.txt");
  fs.writeFileSync(builderFile, "junk\n", "utf8");

  const result = await restoreCheckpoint(repo, checkpoint);
  assert.equal(result.ok, true);

  // 작업 트리: staged/dirty 모두 checkpoint 시점 내용으로 복원, Builder
  // 파일은 제거.
  assert.equal(fs.readFileSync(stagedFile, "utf8").replace(/\r\n/g, "\n"), "user staged v2\n");
  assert.equal(fs.readFileSync(dirtyFile, "utf8").replace(/\r\n/g, "\n"), "user dirty v2\n");
  assert.equal(fs.existsSync(builderFile), false);
  // index 상태: staged.txt만 index에 반영되고, dirty.txt는 작업 트리에만
  // 남는다(v2 백업이 놓치던 경계).
  const status = git(repo, ["status", "--porcelain"]);
  assert.match(status, /^M  staged\.txt$/m);
  assert.match(status, /^ M dirty\.txt$/m);
  cleanupCheckpoint(checkpoint);
});

test("복원 전에 staged된 실행 기록도 최신 내용으로 보존한다", async (t) => {
  const repo = makeTempRepo(t);
  fs.writeFileSync(path.join(repo, "app.txt"), "baseline\n", "utf8");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-qm", "baseline"]);
  const evidence = path.join(repo, "evidence.json");
  const resultFile = path.join(repo, "result.json");
  fs.writeFileSync(evidence, '{"round":1}\n', "utf8");
  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  // 이전부터 있던 기록과 백업 이후 생성된 기록 모두 git add된 상황.
  fs.writeFileSync(evidence, '{"round":2}\n', "utf8");
  fs.writeFileSync(resultFile, '{"status":"BLOCKED"}\n', "utf8");
  fs.writeFileSync(path.join(repo, "app.txt"), "builder\n", "utf8");
  git(repo, ["add", "app.txt", "evidence.json", "result.json"]);
  const restored = await restoreCheckpoint(repo, checkpoint, {
    preservePaths: ["evidence.json", "result.json"],
  });

  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(evidence, "utf8"), '{"round":2}\n');
  assert.equal(fs.readFileSync(resultFile, "utf8"), '{"status":"BLOCKED"}\n');
  assert.equal(fs.readFileSync(path.join(repo, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "baseline\n");
  assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "");
  cleanupCheckpoint(checkpoint);
});

test("checkpoint schema v2: 손상된 tracked.patch나 파일 사본은 검증에서 거부되고 복원을 시도하지 않는다", async (t) => {
  const repo = makeTempRepo(t);
  const trackedFile = path.join(repo, "src", "index.js");
  fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
  fs.writeFileSync(trackedFile, "console.log(1);\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  fs.writeFileSync(trackedFile, "console.log(2);\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  const checkpointDir = path.join(repo, ".agora", "checkpoints", checkpoint.checkpointId);
  const patchPath = path.join(checkpointDir, "tracked.patch");
  fs.writeFileSync(patchPath, "tampered content\n", "utf8");

  const res = await restoreCheckpoint(repo, checkpoint);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "tracked-patch-corrupt");

  assert.equal(fs.readFileSync(trackedFile, "utf8"), "console.log(2);\n");
  cleanupCheckpoint(checkpoint);
});

test("checkpoint schema v2: untracked 사본이 변조되면 복원을 거부한다", async (t) => {
  const repo = makeTempRepo(t);
  git(repo, ["commit", "--allow-empty", "-qm", "init"]);
  const userNote = path.join(repo, "notes.txt");
  fs.writeFileSync(userNote, "original note\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);

  const checkpointDir = path.join(repo, ".agora", "checkpoints", checkpoint.checkpointId);
  const copyPath = path.join(checkpointDir, "untracked", "notes.txt");
  fs.writeFileSync(copyPath, "tampered note\n", "utf8");

  const res = await restoreCheckpoint(repo, checkpoint);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "untracked-copy-corrupt");

  assert.equal(fs.readFileSync(userNote, "utf8"), "original note\n");
  cleanupCheckpoint(checkpoint);
});

test("정상 checkpoint는 생성 직후 자체 검증을 거쳐 supported:true를 반환한다", async (t) => {
  const repo = makeTempRepo(t);
  git(repo, ["commit", "--allow-empty", "-qm", "init"]);
  fs.writeFileSync(path.join(repo, "sample.txt"), "hello world\n", "utf8");

  const checkpoint = await createCheckpoint(repo);
  assert.equal(checkpoint.supported, true);
  assert.equal(typeof checkpoint.checkpointId, "string");
  assert.equal(checkpoint.workspace, fs.realpathSync(repo));
  cleanupCheckpoint(checkpoint);
});

test("생성 시 artifact 저장이 실패하면 failed:true와 CHECKPOINT_* taxonomy reason을 반환한다", async (t) => {
  const repo = makeTempRepo(t);
  git(repo, ["commit", "--allow-empty", "-qm", "init"]);
  fs.writeFileSync(path.join(repo, "sample.txt"), "test content\n", "utf8");

  // storageRoot를 파일로 만들어 디렉터리 생성이 실패하도록 유도
  const badRoot = path.join(repo, "bad-storage-root");
  fs.writeFileSync(badRoot, "blocker", "utf8");

  const checkpoint = await createCheckpoint(repo, { storageRoot: badRoot });
  assert.equal(checkpoint.supported, false);
  assert.equal(checkpoint.failed, true);
  assert.equal(checkpoint.reason, "CHECKPOINT_STORAGE_FAILED");
});

// diff는 크기가 예측되지 않는다. 바이너리 삭제가 섞이면 변경 파일 수천 건만으로도
// 수백 MB가 되는데(실측: 29,000여 건 저장소에서 552MB), 예전에는 execFile 버퍼에
// 통째로 받다가 maxBuffer 상한에 걸려 "Git 명령 실행에 실패했습니다"로 죽었다.
// 저장소 상태 문제가 아니라 받는 방식 문제였으므로, 버퍼를 거치지 않고 파일로 흘린다.
test("큰 diff도 버퍼를 거치지 않고 tracked.patch로 흘려보낸다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "agora", "turn-checkpoint.js"), "utf8");
  assert.ok(source.includes("function gitToFile"), "파일로 직접 흘리는 경로가 있어야 합니다");
  assert.ok(
    source.includes('gitToFile(repo, ["diff", "--binary", "HEAD"], path.join(dir, "tracked.patch"))'),
    "diff는 gitToFile로 수집해야 합니다"
  );
  // 예전 경로(버퍼 수집 후 writeFileSync)가 남아 있으면 안 된다.
  assert.ok(!source.includes('git(repo, ["diff", "--binary", "HEAD"])'), "diff를 버퍼에 받으면 안 됩니다");
  // 프로세스 종료와 파일 닫힘을 둘 다 기다려야 patch가 온전하다.
  assert.ok(source.includes("if (exitCode === null || !closed) return;"), "종료와 닫힘을 모두 기다려야 합니다");
});
