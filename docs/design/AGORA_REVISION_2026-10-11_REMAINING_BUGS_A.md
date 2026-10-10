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
| F128 | 수정 | AGY 전환·계정 추가는 자격 증명을 바꾼 뒤에 IDE를 재시작한다. 재시작이 실패하면 변경은 적용됐는데 실패로만 보고되고 목록이 갱신되지 않았다. | 스위처가 재시작 실패에 `restartFailedAfterChange`를 달아 던지고, `switchProviderAccount`는 이를 부분 성공으로 처리(성공 반환·사유 안내·목록 갱신)한다. 계정 추가는 오류를 유지하되 "로그인 정보는 지웠지만 AGY를 다시 실행하지 못했어요" 문구와 함께 목록을 갱신한다. |
| F129 | 수정 | Codex Desktop을 먼저 끈 뒤 전환이 실패해도 앱을 다시 띄우지 않았다. | 실패 경로에서 `launch()`를 시도하고 결과(재실행 요청 / 직접 열기)를 안내에 붙인다. |
| F165 | 수정 | 사용량 조회가 Claude refresh 토큰을 교환했다. 일회용 토큰이라 교환 뒤 저장이 실패하면 새 토큰이 사라져 CLI 로그인이 조용히 풀렸다. | 사용량 조회를 읽기 전용으로 만들었다(`refreshClaudeOAuth` 삭제). 만료·401은 "토큰 만료 (Claude를 한 번 쓰면 갱신)"으로 표시한다. 갱신은 CLI가 한다(Atelier의 최종 결정과 같다). |

### macOS 테스트 3건

`test/account-login-lifecycle.test.js`의 Claude 로그아웃·전체 지우기 테스트 3건은 macOS에서 Claude live 자격 증명이 Keychain에 있어 파일 삭제를 확인할 수 없었고 실제 Keychain도 건드렸다. `createAccountSwitching`이 `claudeLiveStore`를 주입받을 수 있게 하고(기본값은 기존 플랫폼 저장소), 테스트는 파일 저장소를 주입한다. 단언은 바꾸지 않았다. Windows/Linux는 기존과 같은 파일 저장소를 쓰므로 동작이 같다.

### 한계

- F128: 계정 추가 실패 응답에도 최신 목록(`data`)을 실어 설정 창이 옛 계정을 보이지 않게 한다(main.js `settings:account`, settings.js 실패 분기).
- F125: 프록시가 갱신한 토큰을 라이브 `auth.json`에 되쓰지는 않는다. 라이브를 프록시가 대신 쓰면 실행 중인 Codex 앱과 경합하기 때문이다. 대신 프로필 사본이 라이브보다 새로울 때 그 사본을 보존한다.
- F165: 오래 쉬고 돌아오면 Claude를 한 번 쓰기 전까지 사용량이 '토큰 만료'로 보일 수 있다.

### 회귀 테스트

`test/regress-codex-account-store.test.js`(F122·F123·F125), `test/regress-account-switching-partial.test.js`(F128·F129·저장소 주입), `test/regress-claude-usage-readonly.test.js`(F165), `test/regress-codex-proxy-abort.test.js`(F127). 모두 수정 전 코드에서 실패하고 수정 후 통과한다.
