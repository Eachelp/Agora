# Ἀγορά (Agora)

Ἀγορά는 Claude Code, Codex CLI, Antigravity(`agy`)를 하나의 로컬 작업공간에서 사용하는 Windows 데스크톱 도구입니다.

일반 대화부터 에이전트 토론, 프로젝트별 작업공간, Planner·Builder·Reviewer가 이어지는 전문 실행까지 한 화면에서 다룹니다. 대화와 프로젝트 데이터는 기본적으로 이 PC에 저장되며, 각 에이전트의 로그인 정보는 해당 CLI가 관리합니다.

## 주요 기능

- **일반 대화** — `@mention`으로 특정 에이전트를 부르거나, `@all`에 이어 발언·독립 발언을 선택합니다.
- **토론** — 여러 에이전트가 앞선 발언을 읽고 정해진 라운드 안에서 토론합니다.
- **전문 실행 (PLAN ⇄ ACT)** — 일반 대화나 토론���서 정리된 작업을 기획(PLAN) → 구현·검수·기록(ACT) 흐름으로 실행합니다.
  - `PLAN`: Planner와 Plan Reviewer가 작업 지시서(TASK.md)를 완성하고 사용자 승인을 기다립니다.
  - `실행`: 승인된 작업 계약(Frozen Task)을 기준으로 Builder가 구현하고 독립 Reviewer가 검수하며 Recorder가 기록합니다.
  - `전체 실행`: 사용자의 사전 승인을 받아 기획 검수 통과 시 자동으로 구현과 검수까지 이어갑니다.
  - `재기획 / 복원`: 구현이 막히면(BLOCKED) 부분 변경을 유지하거나 작업 전으로 복원한 뒤 기획자에게 전달해 재기획합니다.
  - `권한 격리`: 전문 실행 중에는 필요한 권한이 실행 단위(run-scoped)로만 적용되며, 일반 대화의 세션 권한은 영구 변경되지 않습니다.
- **프로젝트와 워크스페이스** — 프로젝트마다 폴더, 규칙, 대화를 연결하고 에이전트의 읽기·쓰기 권한을 따로 정합니다.
- **작업 계약과 기록** — Planner의 작업 명세를 Markdown으로 보존하고, 실행 시점의 기준을 고정해 Builder와 Reviewer가 같은 요구사항을 봅니다.
- **Handoff** — 한 에이전트의 메시지를 다른 에이전트에게 검토 요청 또는 이어서 작업할 내용으로 전달합니다.
- **첨부와 Markdown** — 이미지·파일 첨부, 코드 블록, 표, LaTeX 수식을 지원합니다.

## Windows에서 사용하기

비공개 저장소의 **Releases**에서 `Agora-<버전>.exe`를 내려받아 실행합니다. 현재 실행 파일은 설치 프로그램이 아닌 portable 실행 파일입니다.

처음 실행한 PC에서는 다음 CLI를 각각 설치하고 로그인해야 합니다.

- Claude Code (`claude`)
- Codex CLI (`codex`)
- Antigravity CLI (`agy`)

Antigravity IDE와 `agy` CLI는 별개입니다. IDE만 설치되어 있으면 Agora의 Antigravity 에이전트를 실행할 수 없습니다.

## 개발 실행

Node.js와 npm이 설치된 환경에서 PowerShell로 실행합니다.

```powershell
npm install
npm start
```

테스트:

```powershell
npm test
```

Windows portable 실행 파일 빌드:

```powershell
npm run dist -- --win
```

생성 위치:

```text
artifacts/Agora-<버전>.exe
```

Linux AppImage와 macOS DMG 빌드 스크립트도 있지만, v1의 실제 배포 검증 기준은 Windows portable 실행 파일입니다.

## 워크스페이스와 권한

워크스페이스 권한은 세 단계로 나뉩니다.

- **대화만** — 파일과 도구를 사용하지 않습니다.
- **워크스페이스 읽기** — 선택한 폴더를 읽고 검색할 수 있습니다.
- **워크스페이스 쓰기** — 파일 수정과 명령 실행이 가능하며, 명시적으로 선택해야 합니다.

도구 자동 승인은 워크스페이스 쓰기 모드에서만 켤 수 있습니다. 신뢰하는 폴더에서만 사용하세요.

전문 실행은 기본적으로 사용자의 승인 경계에서 멈춥니다. 자동 보완도 사용자가 미리 허용한 횟수와 Task 범위 안에서만 동작합니다.

전문 단계별 실제 권한 cap은 다음과 같습니다. 일반 채팅과 토론은 이 표의 영향을 받지 않고 세션 권한과 기존 transcript/provider 호출 경계를 그대로 사용합니다.

| 단계 | 실제 권한 |
|---|---|
| Planner / 기획 검수 | 워크스페이스 읽기 |
| Builder | 워크스페이스 쓰기 |
| 구현 Reviewer | 워크스페이스 읽기 |
| Recorder | 대화만 |

전문 실행 중 앱이 종료되면 자동 재개하지 않습니다. 재시작 후에는 복구 저널을 확인하고 변경 유지·작업 전 복원·폐기 중에서 선택합니다. Git이 아닌 워크스페이스는 현재 파일을 읽어 검수할 수 있지만 변경 diff가 없어 PASS를 자동 완료하지 않고 사용자 확인을 기다립니다.

## 로컬 데이터와 개인정보

Agora의 앱 데이터 기본 위치는 다음과 같습니다.

```text
%USERPROFILE%\.agora\
```

환경 변수 `AGORA_HOME`으로 저장 위치를 바꿀 수 있습니다.

```text
.agora/
├─ config.json                         앱 설정과 CLI 탐지 캐시
└─ sessions/<id>/
   ├─ meta.json                         세션·프로젝트·권한·에이전트 설정
   ├─ transcript.jsonl                  대화 기록
   ├─ attachments/                     첨부 파일 사본
   ├─ run-logs/                        최근 실행 원본 로그와 bounded evidence
   └─ checkpoints/                     전문 실행 복구 checkpoint
```

- 대화와 첨부 파일은 로컬에 저장됩니다.
- 자격 증명은 저장하지 않습니다. Agora는 CLI 로그인 토큰을 직접 관리하지 않습니다.
- 실제 프롬프트와 작업 결과는 사용자가 선택한 Claude·Codex·AGY CLI로 전달됩니다.
- 프로젝트 워크스페이스 파일은 사용자가 선택한 권한과 에이전트의 실행 결과에 따라 읽거나 수정될 수 있습니다.

## 문서

- [Agora V1 설계](docs/design/AGORA_V1_DESIGN.md)
- [구현 계획](docs/design/AGORA_IMPLEMENTATION_PLAN.md)
- [미래 호환성 원칙](docs/design/AGORA_V1_FUTURE_COMPATIBILITY.md)

과거 조사·검수 자료는 [docs/archive](docs/archive/)에 보관합니다.

## 라이선스와 원본 고지

이 저장소는 MIT License를 따릅니다. Agora는 CodePet을 기반으로 한 수정 프로젝트이므로 원본 저작권 고지를 보존합니다. 자세한 내용은 [LICENSE](LICENSE)를 확인하세요.
