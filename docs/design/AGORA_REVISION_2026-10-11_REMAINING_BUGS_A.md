# Agora — 개정 기록 2026-10-11: 남은 버그 수정 A

> 상태: 작업 기록 (브랜치 `fix/remaining-bugs-a`). 전수 감사에서 확인된 버그 중, 질문 UI 개편과 겹치지 않는 파일에 있는 것을 고친다. 줄 번호가 아니라 함수 이름으로 현재 코드를 확인했다.

## 묶음 B1 — 계정·로그인·프록시

| ID | 상태 | 원인 | 수정 |
|---|---|---|---|
| F86 | 이미 고쳐짐 | `.cmd`로 띄운 로그인을 취소·시간 초과할 때 `child.kill()`이라 `cmd.exe`만 죽었다. | 현재 `cli-login.js`는 공용 `killTree`(`taskkill /T`)를 쓴다(커밋 8e70465). 추가 수정 없음. |
| F122 | 수정 | 삭제 가드(`removePathIfInsideHome`)가 홈 디렉터리 안만 허용해, `AGORA_HOME`이 홈 밖이면 백업 정리·로그인 병합·로그아웃이 모두 거부됐다. | 홈 안 **또는** 자기 저장소(`codex-switch`) 안이면 허용한다. 그 밖 경로는 여전히 거부한다. |
| F123 | 수정 | `logout()`이 active 표시만 보고 프로필을 지웠다. 설정 목록의 '현재'는 라이브 신원 기준이라 둘이 어긋나면 다른 계정의 저장 로그인이 사라졌다. | 라이브 신원이 맞는 프로필을 먼저 보고, 라이브가 없을 때만 active 표시를 쓴다. |
| F125 | 수정 | 프록시는 저장 프로필 사본만 토큰을 갱신한다. 시작·전환 때 `saveCurrentAccount`가 더 오래된 라이브 사본으로 그 프로필을 덮어써 새 토큰을 잃었다. | 프로필 사본의 `last_refresh`가 더 새로우면 덮어쓰지 않는다(라이브가 더 새로우면 예전처럼 갱신). 라이브 파일은 건드리지 않는다. 전환할 때는 어차피 프로필이 라이브가 된다. |
| F127 | 수정 | 프록시가 클라이언트 끊김을 듣지 않아 upstream 응답 스트림이 살아 있었다. | 응답 `close` 때 끝나지 않은 upstream 응답을 `destroy`한다. |
| F128 | 수정 | AGY 전환·계정 추가는 자격 증명을 바꾼 뒤에 IDE를 재시작한다. 재시작이 실패하면 변경은 적용됐는데 실패로만 보고되고 목록이 갱신되지 않았다. | 스위처가 재시작 실패에 `restartFailedAfterChange`를 달아 던지고, `switchProviderAccount`는 이를 부분 성공으로 처리(성공 반환·사유 안내·목록 갱신)한다. 계정 추가는 오류를 유지하되 "로그인 정보는 지웠지만 AGY를 다시 실행하지 못했습니다" 문구와 함께 목록을 갱신한다. |
| F129 | 수정 | Codex Desktop을 먼저 끈 뒤 전환이 실패해도 앱을 다시 띄우지 않았다. | 실패 경로에서 `launch()`를 시도하고 결과(이전 계정 그대로 다시 실행함 / 직접 열기)를 안내에 붙인다. |
| F165 | 수정 | 사용량 조회가 Claude refresh 토큰을 교환했다. 일회용 토큰이라 교환 뒤 저장이 실패하면 새 토큰이 사라져 CLI 로그인이 조용히 풀렸다. | 사용량 조회를 읽기 전용으로 만들었다(`refreshClaudeOAuth` 삭제). 만료·401은 "토큰 만료 (Claude를 한 번 쓰면 갱신)"으로 표시한다. 갱신은 CLI가 한다(Atelier의 최종 결정과 같다). |

### macOS 테스트 3건

`test/account-login-lifecycle.test.js`의 Claude 로그아웃·전체 지우기 테스트 3건은 macOS에서 Claude live 자격 증명이 Keychain에 있어 파일 삭제를 확인할 수 없었고 실제 Keychain도 건드렸다. `createAccountSwitching`이 `claudeLiveStore`를 주입받을 수 있게 하고(기본값은 기존 플랫폼 저장소), 테스트는 파일 저장소를 주입한다. 단언은 바꾸지 않았다. Windows/Linux는 기존과 같은 파일 저장소를 쓰므로 동작이 같다.

### 한계

- F128: 계정 추가 실패 응답에도 최신 목록(`data`)을 실어 설정 창이 옛 계정을 보이지 않게 한다(main.js `settings:account`, settings.js 실패 분기).
- F125: 프록시가 갱신한 토큰을 라이브 `auth.json`에 되쓰지는 않는다. 라이브를 프록시가 대신 쓰면 실행 중인 Codex 앱과 경합하기 때문이다. 대신 프로필 사본이 라이브보다 새로울 때 그 사본을 보존한다.
- F165: 오래 쉬고 돌아오면 Claude를 한 번 쓰기 전까지 사용량이 '토큰 만료'로 보일 수 있다.

### 회귀 테스트

`test/regress-codex-account-store.test.js`(F122·F123·F125), `test/regress-account-switching-partial.test.js`(F128·F129·저장소 주입), `test/regress-claude-usage-readonly.test.js`(F165), `test/regress-codex-proxy-abort.test.js`(F127). 모두 수정 전 코드에서 실패하고 수정 후 통과한다.

## 묶음 B2 — 설정·시작·플랫폼·제공자 기능 탐지

| ID | 상태 | 원인 | 수정 |
|---|---|---|---|
| F131 | 수정 | 로그인 시작 응답은 main이 계정 목록을 읽은 뒤에야 도착한다. 그 사이 이벤트로 받은 로그인 주소를 응답 처리기가 `urls: []`로 덮어써 '브라우저 열기'가 꺼진 채 남았다. | 이미 진행 중으로 아는 로그인은 응답이 건드리지 않는다. 이벤트 없이 응답만 오면 예전처럼 패널을 만든다. |
| F163 | 수정 | 로그인 패널 상태가 설정 창 렌더러 메모리에만 있어, 창을 닫았다 열면 진행 중인 로그인을 취소·완료할 수단이 사라졌다. | 로그인 러너에 `snapshot()`을 더하고 `getSettingsData`가 진행 중인 로그인(`logins`)을 싣는다. 설정 창은 열릴 때·새로고침 때 이를 읽어 패널을 되살린다. |
| F132 | 수정 | '변경 사항 적용'이 화면 값 전체를 보내, 아직 불러오지 못한 기본값이나 트레이에서 바뀌기 전 값이 실제 설정을 덮어썼다. | 불러오기 전에는 저장하지 않는다. 화면을 서버 값으로 채운 시점의 값(`loadedSettings`)과 비교해 바뀐 항목만 보낸다. 바뀐 것이 없으면 요청을 보내지 않고 안내한다. |
| F144 | 수정 | `settings.json`을 바로 덮어써 쓰는 도중 종료되면 파일이 잘렸고, 읽기는 파싱 실패를 `{}`로 삼켜 프록시 모드를 포함한 모든 설정이 초기화됐다. | 새 `src/settings-file.js`: 임시 파일에 쓴 뒤 이름을 바꾼다. 직전 정상 파일을 `.bak`로 남기고, 본문이 깨져 있으면 사본에서 읽는다. 실패는 경고로 남긴다. |
| F133 | 수정 | Windows 종료·재시작·로그오프에서는 `before-quit`이 오지 않아 Codex 프록시 주소가 `config.toml`에 남았다. | 새 `src/session-end.js`: 모든 창의 `session-end`에도 같은 정리(`teardownCodexProxyOnQuit`)를 건다. 다음 실행 때 남은 주소를 지우는 기존 정리(`restoreCodexProxyMode`의 첫 단계)는 그대로다. |
| F134 | 수정 | 글꼴 조회가 오류·시간 초과로 `[]`를 돌려줘도 그 결과를 세션 내내 캐시했고, 이후 저장이 저장된 글꼴을 지웠다. | 실패·빈 목록은 캐시하지 않아 다음 호출에서 다시 조회한다(성공은 계속 캐시). `settings:save`는 목록이 비어 있으면 글꼴 값을 건드리지 않는다. |
| F168 | 수정 | AGY 표(`AGY_MODEL_OPTIONS`)에 Claude 5.5 표시명을 넣고 캐시 버전(6)을 올리지 않아, 옛 캐시가 최대 6시간 원시 id를 보였다. | 캐시 버전을 `규칙 번호:표 내용 지문`(예: `6:1a2b3c4d5e`)으로 바꿨다. 표를 고치기만 해도 옛 캐시가 자동 무효화된다. 규칙(코드)을 바꿀 때만 번호를 올린다. |
| F160 | 수정 | Finder·Dock으로 띄운 macOS 앱의 PATH(`/usr/bin:/bin:...`)에는 node가 없어, npm 설치 CLI(`#!/usr/bin/env node`)의 `--version` 확인이 실패했다. | `withCommonCliPaths`가 `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` 등을 PATH 뒤에 덧붙인다(macOS·Linux만, 플랫폼·홈은 주입). 탐지용 자식 프로세스(버전·로그인·모델 조회)와, 앱 시작 때 `process.env.PATH`에 적용해 실행(spawn)도 같은 PATH를 물려받는다. |

### 한계

- F133: `session-end`는 창이 하나라도 있어야 온다. 트레이 상주 앱은 채팅 창을 숨길 뿐 없애지 않으므로 보통 충족되지만, 창이 모두 없는 상태에서의 시스템 종료는 여전히 다음 실행 때의 정리에 기댄다.
- F144: 이미 잘려 버린 파일은 `.bak`가 없으면 복구할 수 없다(업데이트 직후 첫 저장부터 사본이 생긴다).
- F134: 글꼴 목록이 비어 있는 동안에는 '시스템 기본'으로 되돌리는 것(값을 비움)만 저장되고, 새 글꼴 선택은 목록이 있어야 가능하다.
- F160: macOS 실제 환경에서는 실행 검증을 하지 못했다. 플랫폼·환경을 주입해 Windows에서 같은 경로를 확인했다.

### 회귀 테스트

`test/regress-settings-ui.test.js`(F131·F163·F132: 실제 `settings.js`를 가짜 DOM과 가짜 `settingsApi`로 실행), `test/regress-settings-persistence.test.js`(F144·F134·F133), `test/regress-provider-capabilities-cache-env.test.js`(F168·F160). 모두 수정 전 코드에서 실패하고 수정 후 통과한다. `test/provider-capabilities.test.js`의 AGY 캐시 버전 단언은 고정 숫자 대신 내보낸 상수를 본다.

## 묶음 B3 — 저장소·첨부·마크다운·작업 기록 저장소

| ID | 상태 | 원인 | 수정 |
|---|---|---|---|
| F17 | 수정(토크나이저) | 목록 줄의 번호를 버리고 `<ol>`이 항상 1부터 매겼다. `2026. 10. 10.` 같은 날짜 줄은 연도가 사라지고, 하위 불릿으로 끊긴 단계 목록은 모두 `1.`로 보였다. | 순서 목록의 번호가 1, 2, 3…으로 이어질 때만 목록으로 만들고, 아니면 원문 번호 그대로 문단으로 돌려준다. 렌더러(`chat.js`)는 건드리지 않는다. |
| F80 | 수정 | 첫 두 글자가 `MZ`이기만 하면 실행 파일로 거부해 `MZ세대 …` 보고서·`MZ,40%` CSV가 막혔다. | `MZ`로 시작하면서 앞쪽 8000바이트 안에 NUL 바이트가 있을 때만 실행 파일로 본다(DOS/PE 헤더에는 항상 있고 텍스트에는 없다). ELF·Mach-O와 위험 확장자 거부는 그대로다. |
| F143 | 수정 | 마지막 줄이 개행 없이 끊긴 뒤 새 기록이 그 조각 뒤에 이어 붙어 둘 다 못 읽는 줄이 됐다. System Journal(`appendProfessionalEvent`)은 전문 모드 제거로 이미 없다. | `appendEvent`가 파일이 개행으로 끝나지 않으면 새 줄부터 쓴다(`appendJsonlLine`). 읽기(`readJsonlTolerant`)는 조각에 붙어 버린 옛 파일에서 뒤쪽 온전한 기록을 건진다. |
| F94 | 수정 | 저장 실패 롤백이 `{decisions, tasks}` 얕은 복사로 되돌려 `schemaVersion`이 사라졌고, 항목을 제자리에서 바꾼 경로는 되돌아가지 않았다. | `structuredClone(this.data)` 전체를 보관했다가 되돌린다. |

### 한계

- F17: 1부터 이어지지 않는 번호 목록은 목록 모양(들여쓰기·점) 대신 문단으로 보인다. `chat.js`에서 `<ol start>`·`li.value`를 쓰면 목록 모양까지 살릴 수 있으나 병렬 단계가 소유한 파일이라 손대지 않았다.
- F80: NUL이 없는 MZ 파일(사실상 없음)은 통과하지만 확장자 거부는 그대로 적용된다. 기존 테스트의 위장 실행 파일 고정값에 NUL 바이트를 넣었다(실제 실행 파일 모양에 맞춤).
- F143: 조각 복구는 `{"v":1,"ts":` 로 시작하는 기록 하나만 건진다(수정 전 한 번 이어 붙은 경우).

### 회귀 테스트

`test/regress-markdown-ordered-list.test.js`(F17), `test/regress-attachment-mz-text.test.js`(F80), `test/regress-jsonl-torn-line.test.js`(F143, 실제 `ChatStore.appendEvent`), `test/regress-workflow-rollback.test.js`(F94). 수정 전 코드에서 실패하고 수정 후 통과한다.
