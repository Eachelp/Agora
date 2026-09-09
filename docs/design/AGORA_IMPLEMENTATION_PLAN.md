# Ἀγορά 구현 계획

> 문서 안내(2026-09-06): 초기 계획 원문을 보존한 역사 문서다. 현재 사용법·지원 범위는 [문서 안내](../README.md)를 따른다. 본문의 credential 복사 금지 등 초기 방침은 현재 저장 동작의 설명이 아니다. 현행 계정 전환의 인증정보 사본 보관은 [README](../../README.md)에 명시되어 있다.

> 역사 문서: 이 계획은 초기 Agora 구현 순서를 기록한다. 현재 전문 실행의 단일 기준과 Release 1·2 보장은 [AGORA_V1_DESIGN.md](AGORA_V1_DESIGN.md)를 따른다.
> 본문에 등장하는 CodePet 관련 격리·가져오기 항목은 분리 당시의 기록이며, CodePet 런타임 레거시(펫·말풍선·워처 계층)는 v1.1.0에서 완전히 제거되었다. 배포 모델은 repository-distributed로 확정되었다(README 참조).

이 문서는 [BASELINE_AUDIT.md](../archive/BASELINE_AUDIT.md)의 조사 결과를 실제 구현 순서로 정리한다. Phase 0에서는 이 문서만 작성하고 제품 코드는 수정하지 않는다.

> 미래 방향과 v1의 경계는 [AGORA_V1_FUTURE_COMPATIBILITY.md](AGORA_V1_FUTURE_COMPATIBILITY.md)를 따른다. v2/v3의 기능을 선구현하지 않는다.

## 1. 구현 원칙

1. 기존 CodePet을 실행하거나 수정하지 않고 Agora만 독립적으로 발전시킨다.
2. 현재 `ChatRoom`을 멀티에이전트 오케스트레이션 코어로 재사용한다.
3. 기존 `@mention`, Discussion, 워크스페이스 권한, 스트리밍, 세션 호환성을 깨지 않는다.
4. Planning은 사람이 결정하는 단계로 유지하며, 자율적인 무한 위임이나 AI 조직도를 만들지 않는다.
5. credential을 Agora 저장소에 복사하지 않는다.
6. 모든 문서와 소스 인코딩은 UTF-8이다.

## 2. Phase 1 — 앱·데이터·설정 분리

Agora를 처음 실행하기 전에 CodePet과 물리적으로 격리한다.

### 앱 식별자

기술 식별자는 다음으로 고정한다.

| 항목 | 값 |
|---|---|
| npm package name | `agora` |
| desktop name | `Agora.desktop` |
| Electron app ID | `app.agora.desktop` |
| 표시용 제품명 | `Agora` 또는 UI의 `Ἀγορά` 표기 |
| Windows artifact | `Agora-${version}.exe` |

패키지 이름을 바꾸면서 `packaging.test.js`, `release-packaging.test.js`, CI·release 설정도 함께 갱신한다. 기존 CodePet 이름을 테스트에 남겨 호환성을 확인하는 테스트는 Agora 이름에 맞게 바꾸되, 기능 검증 자체는 유지한다.

### 저장소와 Electron 설정

- ChatStore의 기본 저장소를 `~/.agora`로 바꾼다.
- 테스트와 개발용으로 `AGORA_HOME` 환경 변수 또는 명시적 store root를 지원한다.
- Electron `userData`를 Agora 전용 이름으로 설정하고, 기존 `code-pet` userData를 읽지 않는다.
- 첫 실행은 빈 Agora 저장소로 시작한다.
- 기존 `~/.code-pet`을 자동으로 스캔하거나 변경하지 않는다.

### Codex 프록시

- 기본값은 명시적인 `true`일 때만 켜지도록 바꾼다.
- 기본 실행·종료에서 `~/.codex/config.toml`을 정리하거나 덮어쓰지 않는다.
- 사용자가 프록시를 켤 때만 기존 `openai_base_url` 충돌을 검사하고, 사용자 소유 설정은 보존한다.
- opencodex가 사용하는 외부 `openai_base_url`을 자동 삭제하지 않는다.

### Phase 1 검증

- Agora 저장소가 `.agora`에 만들어지고 `.code-pet`에는 새 파일이 생기지 않는다.
- Electron 설정 파일이 CodePet과 다른 폴더에 만들어진다.
- 프록시 기본 OFF 상태에서 Codex 설정 파일의 hash가 변하지 않는다.
- package/release 테스트가 새 이름으로 통과한다.

## 3. Phase 2 — 기존 대화 가져오기

기존 CodePet 데이터를 보존하면서 선택적으로 복사한다.

- 설정 화면 또는 첫 실행 안내에 `CodePet 대화 가져오기`를 둔다.
- 사용자가 선택한 경우에만 `~/.code-pet/sessions`를 읽는다.
- Agora 안에 `Imported CodePet Chats` 프로젝트를 만들고 session·transcript·첨부파일을 복사한다.
- 원본 파일을 rewrite, move, delete하지 않는다.
- 복사 도중 실패하면 이미 복사된 Agora 파일만 정리할 수 있고 원본은 건드리지 않는다.
- 손상된 transcript는 기존 tolerant reader 규칙을 적용하고, 가져오지 못한 항목을 결과에 표시한다.

### Phase 2 검증

- 가져오기 전후 CodePet 파일 hash가 같다.
- 여러 세션과 첨부파일이 Agora에서 열리고, 원본 대화가 섞이지 않는다.
- 가져오기를 취소해도 Agora와 CodePet 모두 정상이다.
- 이미 가져온 세션을 다시 가져올 때 중복 처리 정책을 명시적으로 적용한다. 기본값은 같은 원본 ID를 다시 복사하지 않는 것이다.

## 4. Phase 3 — Agora 화면과 단일 Main Window

데이터 분리가 끝난 뒤 화면을 바꾼다.

- Chat을 기본 진입 화면으로 만든다.
- Workspace, Project, Chat, Settings를 하나의 Main Window 안의 view/panel로 구성한다.
- 기존 설정 BrowserWindow는 단계적으로 같은 Main Window의 Settings view로 옮긴다.
- Pet과 bubble은 기본 작업 화면에서 숨기고, 기존 런타임 결합 때문에 필요한 코드는 먼저 격리한다.
- 폴더 선택, 파일 선택, 위험한 권한 승인만 OS dialog/modal로 남긴다.
- provider별 캐릭터 이미지는 provider brand icon으로 교체한다.

### 이 단계에서 보존할 것

- 채팅의 model/effort 선택
- enable/disable agent
- auto approve와 permission mode
- streaming, cancel, interject
- 기존 세션 사이드바 기능

## 5. Phase 4 — Project와 Chat 계층

기존 session API를 없애지 않고 Project 연결만 추가한다.

- Project를 생성·선택·이름 변경·삭제할 수 있게 한다.
- 한 Project에 여러 Chat을 연결한다.
- session meta에 `projectId`를 추가한다.
- Project 전환 시 다른 Project의 Chat이 보이지 않는다.
- 앱 재실행 시 마지막 Project와 마지막 Chat을 복구한다.
- Project 기본 agent/model/effort/permission은 새 Chat 생성 시에만 복사한다.
- 기존 Chat의 session별 설정을 강제로 덮어쓰지 않는다.
- Project Context는 해당 Project의 prompt에만 추가한다.
- 모든 transcript를 매번 통째로 prompt에 넣지 않고 기존 truncation을 따른다.

### 권장 코드 경계

- `src/agora/project-store.js`: Project 저장
- `src/agora/context-builder.js`: Planning/Execution context 조립
- 기존 `chat-store.js`: 기존 session/transcript 저장
- 기존 `chat-ipc.js`: 최소 IPC 연결
- 기존 `chat-room.js`: 응답 순서와 토론 유지

새 모듈은 실제 호출자가 생길 때만 추가하며, 한 기능을 위한 추상화·factory·새 framework는 만들지 않는다.

## 6. Phase 5 — Planning과 Decision

기존 채팅을 Planning 모드의 기반으로 사용한다.

- 일반 질문은 현재의 random sequential broadcast를 유지한다.
- `@mention`으로 특정 에이전트를 부르는 흐름을 유지한다.
- Discussion은 `[[CODEPET_DISCUSSION:CONTINUE|AGREE|PASS|CONCLUDE]]` 제어 태그를 그대로 사용한다.
- Planning prompt에 Execution Role persona를 강제로 넣지 않는다.
- 사용자가 Decision을 기록할 수 있게 한다.
- Decision에는 결정 내용, 시각, 관련 Chat/메시지 참조를 남긴다.
- 에이전트가 자동으로 결정을 확정하지 않는다.

## 7. Phase 6 — Execution, Task, Handoff, Review

사용자가 결정한 뒤 실행 계층을 추가한다.

### Task

- 최소 정보: 제목, 설명, 상태, Project, 담당 Role, 연결 Decision, 생성·수정 시각
- 상태는 `todo`, `in_progress`, `review`, `done`, `blocked`로 제한한다.
- Task 자체가 provider나 agent에 hard-code되지 않는다.

### Role과 Agent

- Role은 `planning`, `implementation`, `review`처럼 작업 종류를 뜻한다.
- Agent는 Claude/Codex/AGY 같은 실행 주체다.
- Role → Agent 연결은 사용자가 정한다.
- Project 기본 연결과 Task별 변경을 구분한다.

### Handoff

Handoff는 다음만 묶어 전달한다.

- Project Context
- 관련 Decision
- Task 설명과 현재 상태
- 사용자가 선택한 메시지
- workspace 경로와 permission mode

workspace 전체 파일이나 credential을 채팅 메시지에 복사하지 않는다.

### Review

- Implementation 결과를 Review 요청으로 넘긴다.
- Reviewer는 결과·변경 상태·관련 Decision을 받는다.
- 결과는 `PASS` 또는 `REVISE`로 기록한다.
- `REVISE`는 기존 Task로 되돌리고, 새 자율 위임 루프를 시작하지 않는다.

## 8. Phase 7 — Runtime 오류와 provider 호환성

> 출력 한도 분리와 부분 출력 보존은 이미 구현했습니다. 이 절은 구현된 계약을 기록합니다.

### 실패한 부분 답변

현재 runner가 최종 답변 없이 오류로 끝나는 것을 성공으로 처리하지 않는 규칙은 유지한다. 여기에 다음 동작을 구현했다.

- 실시간 delta와 최종 답변을 구분한다.
- 정상 최종 답변이 있으면 그것을 저장한다.
- 권한 오류나 일반 오류로 종료되면 실패 상태를 저장한다.
- 실패 직전까지 화면에 보인 delta는 `중단된 답변`으로 남긴다.
- 오류 메시지와 부분 답변을 구분해 표시한다.
- 정상 종료인데 final 이벤트만 누락된 경우에는 기존 호환성대로 delta를 최종 답변으로 승격한다.

실행 결과와 UI 사이의 전달에는 선택적 `partialText`/진단 정보만 추가하고, 기존 성공 결과 형태와 기존 consumer를 깨뜨리지 않는다.

### 출력 한도 (구현 완료)

세 가지 한도를 서로 다른 목적으로 분리한다. 절대 하나로 합치지 않는다.

| 한도 | 위치 | 초과 시 동작 |
|---|---|---|
| provider/model 출력 | provider CLI 자체 | Agora가 관여하지 않음 |
| subprocess 수집(capture) | `chat-agent-runner.js` | 앞/뒤만 남기는 tail buffer로 잘라내고 **실행은 계속** |
| renderer 표시 | `chat.js` | 화면에서만 접고 안내 문구 표시, **실행은 계속** |

규칙:

- stdout이 길다는 사실만으로 provider 프로세스를 종료하지 않는다.
- 수집 한도를 넘겨도 최종 답변(`final` 이벤트 또는 outputFile)은 정상 처리한다.
- 표시 한도를 넘기면 "출력이 길어 일부 내용을 접었습니다."를 보여주고 완료 이벤트를 계속 기다린다.
- 원본 출력은 세션 폴더의 `run-logs/`에 파일로 보존한다. renderer에는 파일 이름만 노출하고 경로는 보내지 않는다.
- hard limit은 기본값이 없다(상한 없음). `settings.json`의 `agentOutputHardLimitMB`에 양수를 넣을 때만 동작한다.
- hard limit으로 중단하면 `OUTPUT_LIMIT` 상태(`outputLimited`)로 기록해 timeout·provider 실패와 구분하고, 부분 출력과 진단 정보를 함께 남긴다.
- hard limit에 걸렸더라도 최종 답변이 이미 도착했다면 성공으로 처리한다.

### AGY effort

- `agy models` 결과와 provider capability를 모델 단위로 연결한다.
- 모델별 지원되는 effort만 UI에 표시한다.
- 선택된 모델의 지원 여부를 확인할 수 없으면 `--effort`를 전달하지 않는다.
- `claude-opus-4-6-thinking`에는 현재 확인된 오류대로 `--effort`를 전달하지 않는다.
- Gemini·Claude·GPT-OSS 계열 각각에 대해 지원·미지원·알 수 없음 테스트를 둔다.

### 진단과 재시도

- provider 오류, timeout, permission 오류를 서로 다른 상태로 표시한다.
- workspace-write 재시도 전 변경 상태를 가능한 한 확인한다.
- 자동 승인 재시도가 현재 turn 전체를 다시 실행한다는 점을 표시한다.
- raw output에는 token·API key·OAuth credential을 표시하지 않는다.

## 9. Phase 8 — Usage, 패키징, 최종 검증

- Agent chip에서 기존 Usage 요약을 보여준다.
- Windows portable build를 만든다.
- 깨끗한 폴더에서 실행한다.
- CodePet 데이터 없이도 첫 실행이 가능하다.
- 선택적 가져오기가 무손실인지 확인한다.
- 누락 provider와 손상 transcript를 확인한다.
- 실제 GitHub release는 개인 저장소를 만든 뒤 별도로 확인한다.

## 10. 테스트 계획

### 현재 기준선

- Phase 0: `node --test` 280 pass / 0 fail
- Agora 앱 실행과 provider smoke test는 데이터 분리 이후에만 수행한다.

### 기존 기능 회귀

- `@claude`, `@codex`, `@agy`, `@all`
- 멘션 없는 응답, random sequential response, 앞 답변 참고
- Agent-to-Agent mention
- Discussion, interject, cancel
- model, effort, permission, auto approve
- workspace read/write, attachment, streaming
- session restore, usage, diagnostics

### 신규 기능

- Agora와 CodePet의 저장 폴더 분리
- 프록시 기본 OFF와 사용자 `openai_base_url` 보존
- Project·Chat 연결과 마지막 위치 복구
- CodePet 대화 복사 가져오기와 원본 불변
- Decision 저장
- Task·Role·Handoff·Review 흐름
- 실패한 부분 답변 보존
- AGY 모델별 effort 전달 조건
- Agora package/release 이름과 Windows packaging

## 11. 이번 Phase 0의 완료 조건

- `BASELINE_AUDIT.md`와 이 문서가 UTF-8로 저장됨
- 제품 코드 변경 없음
- Agora 작업이 사용자 설정을 수정하지 않음. 단, 실행 중인 기존 CodePet이 `~/.code-pet/index.json`을 자체 갱신할 수 있으므로 해당 파일의 불변성은 이 실행에서 종료 조건으로 사용할 수 없음
- 기준 커밋 `c2ff8fa`가 존재함
- 기준 테스트가 280 pass / 0 fail임
- 원격 Git 저장소가 없음
- 후속 문서 커밋이 별도로 생성됨
- 다음 구현자는 Phase 1의 저장소 분리 없이는 Agora를 실행하지 않음

## 12. 명시적 보류

- 새 오케스트레이터 framework
- AI CEO·조직도·무한 자율 delegation
- 복잡한 DAG·Kanban
- Cloud sync와 multi-user collaboration
- OpenCode provider
- Worktree isolation과 Git Diff viewer
- Slack/Discord client
- 새 RAG 시스템
- React/Tauri 전면 재작성
