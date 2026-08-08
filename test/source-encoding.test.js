const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

// 과거 PowerShell 파이프로 소스를 편집하다 한글 UTF-8 바이트가
// 잘못된 코드페이지로 왕복 변환되어 U+FFFD(치환 문자)로 깨진 적이 있습니다.
// 이 테스트는 추적 중인 모든 .js 소스가 손상 없이 유지되는지 지킵니다.
test("추적 중인 모든 .js 소스는 U+FFFD 치환 문자가 없다", () => {
  const output = execFileSync("git", ["ls-files", "--", "*.js"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const files = output.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.ok(files.length > 50, "추적 파일 목록이 예상보다 너무 적습니다");

  const damaged = [];
  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    if (!fs.existsSync(fullPath)) continue; // 워킹트리에서 이미 삭제되었고 아직 스테이징만 안 된 파일
    const text = fs.readFileSync(fullPath, "utf8");
    if (text.includes("\uFFFD")) damaged.push(file);
  }
  assert.deepEqual(damaged, [], `다음 파일에 깨진 문자(U+FFFD)가 있습니다: ${damaged.join(", ")}`);
});
