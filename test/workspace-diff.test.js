const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  collectBuilderDiff,
  formatBuilderDiff,
  describeWorkspaceChanges,
} = require("../src/agora/workspace-diff");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-diff-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("git 저장소에서 tracked diff를 수집한다", async (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello2\n", "utf8");

  const result = await collectBuilderDiff(dir);
  assert.equal(result.supported, true);
  assert.equal(result.hasChanges, true);
  assert.match(result.trackedDiff, /a\.txt/);
});

test("git 저장소에서 untracked 파일 목록을 수집한다", async (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n", "utf8");

  const result = await collectBuilderDiff(dir);
  assert.equal(result.supported, true);
  assert.equal(result.hasChanges, true);
  assert.ok(result.untracked.includes("new.txt"));
});

test("변경이 없으면 hasChanges가 false다", async (t) => {
  const dir = makeTempRepo(t);
  const result = await collectBuilderDiff(dir);
  assert.equal(result.hasChanges, false);
  assert.deepEqual(result.changedPaths, []);
});

test("tracked 변경 경로를 changedPaths로 수집한다", async (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello2\n", "utf8");
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n", "utf8");

  const result = await collectBuilderDiff(dir);
  assert.equal(result.supported, true);
  // tracked 수정만 changedPaths에 들어간다. untracked는 untracked 목록이
  // 담당하고(captureSubject가 양쪽을 함께 읽는다), 중복은 dedupe한다.
  assert.deepEqual(result.changedPaths, ["a.txt"]);
  assert.ok(result.untracked.includes("new.txt"));
});

test("삭제된 tracked 파일도 changedPaths에 포함된다", async (t) => {
  const dir = makeTempRepo(t);
  fs.rmSync(path.join(dir, "a.txt"));

  const result = await collectBuilderDiff(dir);
  assert.equal(result.supported, true);
  assert.deepEqual(result.changedPaths, ["a.txt"]);
});

test("R100 이름 변경은 이전 경로와 새 경로를 모두 수집한다", async (t) => {
  const dir = makeTempRepo(t);
  git(dir, ["config", "diff.renames", "true"]);
  git(dir, ["mv", "a.txt", "이름 변경.txt"]);
  assert.match(git(dir, ["diff", "--name-status", "-z", "HEAD"]), /^R100\0/);

  const result = await collectBuilderDiff(dir);
  assert.equal(result.status, "CHANGED");
  assert.deepEqual(result.changedPaths, ["a.txt", "이름 변경.txt"]);
});

test("C100 복사는 원본 경로와 복사 경로를 중복 없이 수집한다", async (t) => {
  const dir = makeTempRepo(t);
  git(dir, ["config", "diff.renames", "copies"]);
  fs.copyFileSync(path.join(dir, "a.txt"), path.join(dir, "copy.txt"));
  fs.writeFileSync(path.join(dir, "a.txt"), "changed source\n", "utf8");
  git(dir, ["add", "a.txt", "copy.txt"]);
  assert.match(git(dir, ["diff", "--name-status", "-z", "HEAD"]), /C100\0/);

  const result = await collectBuilderDiff(dir);
  assert.equal(result.status, "CHANGED");
  assert.deepEqual(result.changedPaths.sort(), ["a.txt", "copy.txt"]);
});

test("git이 아닌 폴더는 supported=false, 빈 결과를 반환한다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-nongit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await collectBuilderDiff(dir);
  assert.equal(result.supported, false);
  assert.equal(result.hasChanges, false);
});

test("workspace가 없으면 빈 결과를 반환한다", async () => {
  const result = await collectBuilderDiff(null);
  assert.equal(result.supported, false);
  assert.equal(result.hasChanges, false);
});

test("formatBuilderDiff는 변경 요약을 포함한다", async (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello3\n", "utf8");
  const diff = await collectBuilderDiff(dir);
  const text = formatBuilderDiff(diff);
  assert.match(text, /변경 요약/);
  assert.match(text, /실제 변경 \(Diff\) 시작/);
});

test("describeWorkspaceChanges는 요약 텍스트를 반환한다", async (t) => {
  const dir = makeTempRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello4\n", "utf8");
  const { text } = await describeWorkspaceChanges(dir);
  assert.match(text, /변경 요약/);
});
