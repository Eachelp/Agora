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
} = require("../src/agora/turn-checkpoint");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-checkpoint-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
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
