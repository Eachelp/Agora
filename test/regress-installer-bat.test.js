const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// F130: npm install가 0으로 끝나도 electron(optionalDependencies)이 조용히 빠질 수 있다.
// 설치/업데이트 스크립트는 electron.exe를 직접 확인해 실패를 알려야 한다.
// 배치 파일은 CP949라 latin1로 읽고 ASCII 명령 부분만 검사한다(bootstrap-scripts.test.js와 같다).
const projectDir = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(projectDir, name), "latin1");
const setup = read("Agora-설치하기.bat");
const update = read("Agora-업데이트.bat");

const CHECK = /if not exist "node_modules\\electron\\dist\\electron\.exe" goto :electronfail\r\n/;

test("설치 스크립트는 npm install 직후 electron.exe를 확인하고, 없으면 바로가기 전에 실패로 끝낸다", () => {
  const npm = setup.indexOf("call npm install\r\n");
  const check = setup.search(CHECK);
  const okBanner = setup.indexOf("echo [OK]", npm);
  const shortcut = setup.indexOf("CreateShortcut");
  assert.ok(npm >= 0 && check > npm, "npm install 뒤에 electron.exe 확인이 있어야 합니다");
  assert.ok(check < okBanner, "[OK] 구성요소 설치 완료보다 먼저 확인해야 합니다");
  assert.ok(check < shortcut, "바로가기 생성보다 먼저 확인해야 합니다");
  const fail = setup.slice(setup.indexOf("\r\n:electronfail\r\n"));
  assert.match(fail, /pause\r\nexit \/b 1\r\n$/, "0이 아닌 코드로 끝나야 합니다");
  assert.ok(!/CreateShortcut|launch-agora\.vbs/.test(fail), "실패 경로에서 바로가기를 만들거나 앱을 띄우면 안 됩니다");
});

test("업데이트 스크립트도 npm install 뒤 electron.exe를 확인하고 완료 안내 전에 실패로 끝낸다", () => {
  const npm = update.indexOf("call npm install\r\n");
  const check = update.search(CHECK);
  assert.ok(npm >= 0 && check > npm, "npm install 뒤에 electron.exe 확인이 있어야 합니다");
  assert.ok(check < update.indexOf("goto :done", npm), "완료 안내로 가기 전에 확인해야 합니다");
  assert.match(update.slice(update.indexOf("\r\n:electronfail\r\n")), /pause\r\nexit \/b 1\r\n$/);
});
