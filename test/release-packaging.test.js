const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const buildScript = fs.readFileSync(path.join(projectDir, "scripts", "build.js"), "utf8");
const releaseWorkflow = fs.readFileSync(
  path.join(projectDir, ".github", "workflows", "release.yml"),
  "utf8"
);
const ciWorkflow = fs.readFileSync(
  path.join(projectDir, ".github", "workflows", "ci.yml"),
  "utf8"
);

test("release packaging defines one native package for Windows, Linux, and macOS", () => {
  assert.deepEqual(packageJson.build.win.target, ["portable"]);
  assert.deepEqual(packageJson.build.linux.target, ["AppImage"]);
  assert.deepEqual(packageJson.build.mac.target, ["dmg"]);
  assert.equal(packageJson.build.portable.artifactName, "Agora-${version}.exe");
  assert.equal(packageJson.build.linux.artifactName, "Agora-${version}-linux-${arch}.${ext}");
  assert.equal(packageJson.build.mac.artifactName, "Agora-${version}-mac.${ext}");
  assert.equal(packageJson.desktopName, "Agora.desktop");
  assert.equal(packageJson.build.linux.syncDesktopName, true);
});

test("build script selects Linux on Linux and accepts an explicit Linux target", () => {
  assert.match(buildScript, /process\.argv\.includes\("--linux"\).*Platform\.LINUX/);
  assert.match(buildScript, /process\.platform === "linux".*Platform\.LINUX/);
  assert.match(buildScript, /publish:\s*"never"/);
});

test("release workflow builds three native runners and uploads all three packages", () => {
  assert.match(releaseWorkflow, /windows-latest[\s\S]*artifacts\/\*\.exe/);
  assert.match(releaseWorkflow, /ubuntu-latest[\s\S]*artifacts\/\*\.AppImage/);
  assert.match(releaseWorkflow, /macos-latest[\s\S]*artifacts\/\*\.dmg/);
  assert.match(releaseWorkflow, /gh release upload/);
  assert.match(releaseWorkflow, /gh release create[^\n]+--draft/);
  assert.match(releaseWorkflow, /gh release edit[^\n]+--draft=false/);
  assert.doesNotMatch(releaseWorkflow, /actions\/(?:upload|download)-artifact/);
  assert.match(releaseWorkflow, /xvfb-run -a artifacts\/linux-unpacked\/agora/);
});

test("release workflow triggers on both v* and Agora-* tags", () => {
  assert.match(releaseWorkflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(releaseWorkflow, /tags:\s*\n\s*- "v\*"\s*\n\s*- "Agora-\*"/);
});

test("Linux smoke test treats only timeout's exit code 124 as success", () => {
  assert.match(releaseWorkflow, /status" -ne 124/);
  assert.doesNotMatch(releaseWorkflow, /-ne 124.*-ne 0/);
});

test("CI는 main push와 수동 dispatch에서만 자동 실행되고 3-OS matrix를 유지한다", () => {
  // 운영정책: main branch push에서만 자동 실행하고, feature branch push나 pull_request로는
  // 자동 실행하지 않으며, 필요 시 workflow_dispatch로 수동 실행한다(Actions 사용량 절감).
  assert.match(ciWorkflow, /on:/);
  assert.match(ciWorkflow, /push:/);
  // 자동 push 대상은 main branch 뿐이다.
  assert.match(ciWorkflow, /push:\s*\n\s*branches:\s*\n\s*-\s*main\s*\n/);
  // 모든 branch(와일드카드) 자동 push는 사용하지 않는다(feature branch 자동 실행 없음).
  assert.doesNotMatch(ciWorkflow, /branches:\s*\n\s*-\s*["']?\*\*["']?/);
  // 수동 실행(workflow_dispatch)을 지원한다.
  assert.match(ciWorkflow, /workflow_dispatch:/);
  // pull_request 자동 trigger는 사용하지 않는다.
  assert.doesNotMatch(ciWorkflow, /pull_request:/);
  // 수동 실행에서도 Windows / Ubuntu / macOS 3-OS 테스트 + npm ci + npm test를 유지한다.
  assert.match(ciWorkflow, /windows-latest/);
  assert.match(ciWorkflow, /ubuntu-latest/);
  assert.match(ciWorkflow, /macos-latest/);
  assert.match(ciWorkflow, /npm ci/);
  assert.match(ciWorkflow, /npm test/);
});
