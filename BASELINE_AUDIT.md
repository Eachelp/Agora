# Ἀγορά 기준선 감사

작성일: 2026-08-08  
범위: Phase 0 — 기준 조사와 문서화

## 1. 결론

Agora는 CodePet의 멀티에이전트 채팅 코어를 재사용해, 사람 중심의 프로젝트 작업공간으로 확장할 수 있는 상태다. 다만 현재 복사본은 아직 CodePet과 같은 이름과 저장 위치를 사용하므로 앱을 실행하면 기존 CodePet의 데이터와 Codex 설정을 건드릴 위험이 있다.

따라서 다음 구현의 첫 단계는 화면 변경이 아니라 **앱 정체성·데이터 폴더·프록시 설정의 분리**여야 한다.

이번 Phase 0에서는 제품 코드를 수정하지 않았다. Agora 앱과 실제 에이전트도 실행하지 않았다.

## 2. 출처와 현재 Git 상태

### 출처

- 원본 저장소: `https://github.com/nokryong/CodePet`
- 원본 기준 커밋: `aaf8d60`
- Agora는 원본 저장소를 fork하지 않고 파일을 복사해 만든 독립 폴더다.
- 복사 과정에서 `.git`, `node_modules`, 빌드 산출물, CodePet 작업 기록은 제외했다.
- CodePet의 MIT `LICENSE`와 기존 소스·자산은 보존했다.

Agora 복사본에는 아래 CodePet 작업이 이미 포함되어 있다.

| 커밋 | 내용 |
|---|---|
| `3e4de35` | 캐릭터 이모티콘 프롬프트 주입 비활성화 |
| `261133b` | 중간 답변 때문에 승인·오류로 오인하던 실행 판정 수정 |
| `d24ffcc` | GitHub 릴리스 워크플로 추가와 태그·Linux 검사 조건 수정 |

### Phase 0 커밋

- 브랜치: `main`
- 기준 커밋: `c2ff8fa chore: import CodePet-derived Agora baseline`
- 원격 저장소: 없음
- 첫 커밋에는 현재 소스, 테스트, 기존 자산, Agora 스펙, HTML 목업, 스크린샷 4장이 포함되어 있다.
- `node_modules`와 `worklog`는 커밋되지 않았다.

## 3. 기준 환경과 테스트

| 항목 | 확인값 |
|---|---|
| Node.js | `v24.18.0` |
| npm | `11.16.0` |
| Claude CLI | `2.1.224` |
| Codex CLI | `0.147.0` |
| AGY CLI | `1.1.11` |
| 테스트 명령 | `node --test` |
| 결과 | 280 pass / 0 fail / 0 skipped |

테스트는 외부 패키지를 직접 불러오지 않으므로 이번 조사 단계에서는 Electron 의존성을 설치하지 않았다. 테스트는 임시 `CODE_PET_HOME`을 사용해 기존 사용자 데이터를 분리한 상태로 실행했다.

## 4. 현재 구조

```text
Electron main process
├─ src/main.js
│  ├─ Pet / bubble / tray 창
│  ├─ Settings 창
│  ├─ Codex proxy와 provider watcher
│  └─ chat feature 조립
│
├─ src/chat/chat-ipc.js
│  ├─ ChatStore 연결
│  ├─ ChatRoom 생성
│  ├─ 세션·첨부·권한 IPC
│  └─ 채팅 창 연결
│
├─ src/chat/chat-room.js
│  ├─ 멘션 없는 브로드캐스트
│  ├─ 순차·무작위 응답 큐
│  ├─ @mention 연쇄 호출
│  ├─ Discussion 제어 태그
│  ├─ interject / cancel
│  └─ 승인 재시도
│
├─ src/chat/chat-agent-runner.js
│  ├─ provider CLI 실행
│  ├─ stdout / stderr 수집
│  ├─ 구조화 이벤트 처리
│  └─ 최종 답변·오류 판정
│
└─ src/chat/chat-store.js
   ├─ JSON index / meta
   ├─ append-only transcript
   ├─ 첨부파일
   ├─ 휴지통
   └─ 손상된 마지막 줄 허용
```

현재 별도의 오케스트레이터 프레임워크는 없다. `ChatRoom`이 이미 응답 순서, 멘션 전달, 토론, 중지와 재시도를 담당하는 기존 오케스트레이션 계층이다. Agora는 이를 새 프레임워크로 교체할 필요가 없다.

## 5. 반드시 재사용할 기능

| 기능 | 현재 위치 | Phase 0 판단 |
|---|---|---|
| `@claude`, `@codex`, `@agy`, `@all` | `chat-room.js`, `chat-mention.js` | 유지 |
| 멘션 없는 전체 응답과 순차 큐 | `chat-room.js` | 유지 |
| Discussion | `chat-room.js`, `chat-prompt.js` | 제어 태그까지 유지 |
| 스트리밍 이벤트 | `chat-events.js`, `chat-agent-runner.js` | 유지 |
| 모델·effort·권한 | `chat-argv.js`, `provider-capabilities.js` | 유지 후 호환성 보완 |
| 워크스페이스 읽기·쓰기와 승인 | `chat-ipc.js`, runner | 유지 |
| 세션·첨부·손상 transcript 복구 | `chat-store.js` | 기존 형식 우선 유지 |
| 사용량·계정·진단 | provider 관련 모듈 | UI에 재사용 |

## 6. 요구사항과 실제 코드의 상태

| 항목 | 현재 상태 | 다음 작업 |
|---|---|---|
| 이모티콘 프롬프트 | `chat-prompt.js`에서 `emoticonPromptRules`를 더 이상 주입하지 않음 | 상태 유지 |
| 이모티콘 렌더링·자산 | `chat-emoticons.js`, `contentParts`, 이미지 자산이 남아 있음 | 기존 대화 호환을 위해 보존 |
| Discussion 태그 | `[[CODEPET_DISCUSSION:...]]` 파싱과 프롬프트 지시가 남아 있음 | 절대 변경하지 않음 |
| `@mention` | 기존 호출·연쇄 제한 동작 | 유지 |
| 워크스페이스 권한 | 기존 permission mode·승인 흐름 동작 | 유지 |
| 부분 답변 오류 판정 | 최종 답변이 없을 때 권한 오류·일반 오류를 성공으로 만들지 않음 | 화면의 부분 답변 보존은 추가 필요 |
| 실패한 부분 답변 표시 | 실패해도 live draft를 지우지 않고, 실패 메시지에 중단 전 출력을 함께 표시 | 완료 |
| 출력 길이 처리 | 수집 한도·hard limit·표시 한도를 분리했고, 출력이 길다는 이유로 실행을 죽이지 않음 | 완료 |
| Codex 프록시 기본값 | `codexProxyMode !== false`라 기본 ON | Agora는 기본 OFF로 분리 |
| 외부 `openai_base_url` | 사용자 설정이 있으면 프록시 주입이 실패할 수 있음 | 기본 실행에서 접근하지 않음 |
| AGY effort | AGY 전체에 `--effort`를 붙임 | 모델별 capability 판정 추가 |
| 제품 이름 | `code-pet`, `CodePet` | 패키지·앱 ID·UI를 Agora로 변경 |
| 창 구조 | Pet·bubble·chat·settings가 분리되어 있음 | 데이터 분리 후 단일 Main Window로 단계적 전환 |
| 저장 위치 | ChatStore 기본값이 `~/.code-pet` | `~/.agora`로 분리하고 가져오기는 복사만 허용 |

## 7. 발견한 결합 지점

### 7.1 기존 CodePet과 공유되는 저장·설정

현재 Agora를 실행하지 않은 이유다.

1. `ChatStore` 기본 저장소: `~/.code-pet`
2. Electron `userData` 아래의 설정 파일: `settings.json`과 로그 등
3. Codex CLI 설정: `~/.codex/config.toml`

현재 `main.js`는 시작할 때 Codex 프록시 상태를 복원하고, 종료할 때 프록시 표시를 정리한다. 따라서 앱 이름만 바꾸지 않고 실행하면 Agora와 CodePet이 같은 사용자 환경을 공유할 수 있다.

검증 전후로 아래 파일들의 SHA-256과 수정 시각을 확인했다. `config.toml`과 `config.json`은 그대로였다. `index.json`은 확인 중에도 실행 중인 기존 CodePet Electron 프로세스가 계속 갱신하고 있어 기준 hash가 변했다. Agora 테스트는 임시 `CODE_PET_HOME`을 사용했고 Agora 앱을 실행하지 않았으므로, 이 파일은 덮어쓰거나 복원하지 않았다.

- `~/.codex/config.toml`
- `~/.code-pet/config.json`
- `~/.code-pet/index.json`

### 7.2 패키지 이름과 테스트의 결합

현재 `package.json`과 `test/packaging.test.js`, `test/release-packaging.test.js`가 다음 값을 직접 검사한다.

- npm 이름: `code-pet`
- 제품 이름: `CodePet`
- 앱 ID: `app.codepet.desktop`
- 배포 파일 이름: `CodePet-*`
- Linux 실행 파일 이름: `code-pet`

따라서 향후 이름 변경은 설정 파일 하나만 바꾸는 작업이 아니다. 패키지 설정, 실행 파일, GitHub 릴리스, 관련 테스트를 같은 변경 단위로 수정해야 한다.

### 7.3 이모티콘 manifest 결합

`chat-emoticons.js`가 manifest를 모듈 로딩 시점에 읽는다. 이미지를 먼저 삭제하면 채팅방 모듈 로딩 자체가 실패할 수 있다. 새 응답에서 사용하지 않더라도 legacy transcript 렌더링을 유지하는 동안에는 manifest와 이미지 자산을 삭제하지 않는다.

### 7.4 AGY 모델·effort 결합

`provider-capabilities.js`에는 AGY의 모델 목록과 `low|medium|high` effort 목록이 provider 단위로 정의되어 있다. `chat-argv.js`의 AGY 경로는 선택된 모델이 실제로 effort를 지원하는지 확인하지 않고 `--effort`를 붙인다.

스크린샷의 오류는 다음 조합으로 설명된다.

```text
provider: AGY
model: claude-opus-4-6-thinking
argv: --effort medium
result: --effort is not supported for this model
```

알 수 없는 모델이나 effort 호환성이 확인되지 않은 모델에는 옵션을 생략하는 것이 안전한 기본값이다.

## 8. 앞으로의 안전 원칙

- CodePet의 소스·데이터·설정을 이동하거나 삭제하지 않는다.
- Agora는 처음 실행할 때부터 별도 앱 ID, Electron `userData`, 채팅 저장소를 사용한다.
- 기존 CodePet 대화 가져오기는 사용자가 명시적으로 실행할 때만 한다.
- 가져오기는 복사 방식이며 원본 transcript와 첨부파일을 수정·이동·삭제하지 않는다.
- Codex 프록시는 기본 OFF이고, 사용자가 명시적으로 켠 경우에만 외부 설정을 변경한다.
- 기존 `openai_base_url`은 자동으로 덮어쓰지 않는다.
- renderer가 credential, command path, API key를 받지 않도록 기존 경계를 유지한다.
- 새 오케스트레이터 프레임워크나 새 provider 실행 계층을 만들지 않는다.

## 9. Phase 0 종료 상태

- 제품 코드 수정: 없음
- CodePet 소스 폴더 수정: 없음
- Agora 작업이 사용자 설정을 수정한 증거: 없음
- 기존 CodePet이 실행 중이어서 `~/.code-pet/index.json`은 감사 중에도 자체 갱신됨
- GitHub 업로드: 없음
- 기준 커밋: `c2ff8fa`
- 후속 구현 계획: `AGORA_IMPLEMENTATION_PLAN.md`
