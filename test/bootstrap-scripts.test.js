const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Windows 부트스트랩 스크립트(Agora-설치하기.bat / Agora-업데이트.bat)의 안전 계약.
// 파일은 CP949 인코딩이라 한글은 그대로 비교할 수 없으므로, 인코딩과 무관하게
// 바이트가 보존되는 ASCII 명령 부분만 검사한다(latin1로 읽으면 ASCII는 1:1이다).
const projectDir = path.resolve(__dirname, "..");
const setupScript = fs.readFileSync(path.join(projectDir, "Agora-설치하기.bat"), "latin1");
const updateScript = fs.readFileSync(path.join(projectDir, "Agora-업데이트.bat"), "latin1");

// cmd는 CRLF를 요구한다. LF-only 배치 파일은 줄이 쪼개져 엉뚱한 토큰을 실행한다
// (실제로 초기 변환에서 겪은 결함이라 회귀 테스트로 고정한다).
test("부트스트랩 스크립트는 CRLF 줄바꿈과 CP949 선언(chcp 949)을 사용한다", () => {
  for (const [name, content] of [["설치하기", setupScript], ["업데이트", updateScript]]) {
    assert.match(content, /chcp 949/, `${name}: chcp 949 필요`);
    assert.ok(!/[^\r]\n/.test(content), `${name}: LF-only 줄바꿈이 있으면 안 됩니다`);
  }
});

test("설치 스크립트는 환경 점검, 선택 설치, 의존성 설치, 바로가기를 수행한다", () => {
  // 환경 점검 대상: git / node / npm / codex / claude / agy
  for (const tool of ["git", "node", "codex", "claude", "agy"]) {
    assert.match(setupScript, new RegExp(`where ${tool} >nul 2>nul`));
  }
  // 자동 설치는 winget 공식 id를 쓰고, 라이선스 동의 플래그를 명시한다.
  assert.match(setupScript, /winget install --id OpenJS\.NodeJS\.LTS/);
  assert.match(setupScript, /winget install --id Git\.Git/);
  assert.match(setupScript, /--accept-source-agreements --accept-package-agreements/);
  // CLI는 공식 npm 패키지로만 설치를 제안한다.
  assert.match(setupScript, /npm install -g @openai\/codex/);
  assert.match(setupScript, /npm install -g @anthropic-ai\/claude-code/);
  // 설치를 강제하지 않는다: 모든 자동 설치는 choice 프롬프트 뒤에서만 실행된다.
  assert.match(setupScript, /choice \/c YN/);
  // 의존성 설치와 바탕화면 바로가기.
  assert.match(setupScript, /call npm install/);
  assert.match(setupScript, /launch-agora\.vbs/);
  assert.match(setupScript, /icon\.ico/);
});

test("업데이트 스크립트는 fail-closed 안전 계약을 지킨다", () => {
  // ZIP 다운로드 폴더(비 git 저장소) 감지.
  assert.match(updateScript, /git rev-parse --is-inside-work-tree/);
  // main 이외 브랜치(개발 체크아웃)는 건드리지 않는다.
  assert.match(updateScript, /git rev-parse --abbrev-ref HEAD/);
  // 로컬 변경이 있으면 덮어쓰지 않고 중단한다.
  assert.match(updateScript, /git status --porcelain/);
  // fast-forward만 허용한다. merge를 만드는 일반 pull은 금지.
  assert.match(updateScript, /git pull --ff-only origin main/);
  assert.ok(!/git pull(?! --ff-only)/.test(updateScript), "ff-only가 아닌 git pull이 있으면 안 됩니다");
  // 최신 여부는 fetch 후 rev-list로 판단한다.
  assert.match(updateScript, /git fetch origin main/);
  assert.match(updateScript, /git rev-list --count HEAD\.\.origin\/main/);
  // 패키지 재설치는 lockfile이 실제로 바뀐 경우에만 수행한다.
  assert.match(updateScript, /git hash-object package-lock\.json/);
  assert.match(updateScript, /call npm install/);
});
