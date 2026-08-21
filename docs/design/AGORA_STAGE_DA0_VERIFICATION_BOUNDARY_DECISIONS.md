# Agora Stage D-A0 — Verification Safety Boundary Decision Log

> 상태: **구현 완료 · 독립 검수 대기**
> 최초 기록: 2026-08-22
> 기준 브랜치: `feat/stage-da0-verification-boundary`
> 상위 기준 문서: [AGORA_STAGE_D_ASSURANCE_CHARTER.md](AGORA_STAGE_D_ASSURANCE_CHARTER.md) (v0.4, D-A0 절)
> 직전 baseline: D-0 COMPLETE `ba9faa6`

이 문서는 D-A0에서 확정된 **아키텍처 결정, 버린 대안, 보증 경계, 의도적으로 하지 않은 것**을 결정 시점에 기록한다(Charter §6 DoD 4).

코드 세부는 Git history와 테스트가 source of truth다. 여기에는 왜 그렇게 했는지와 다음 사람이 무엇을 뒤집으면 안 되는지를 남긴다.

---

## 1. D-A0은 엔진이 아니라 경계다

D-A0에는 아직 검증할 대상이 없다. Verification Plan은 D-A1에서, Process/Artifact 엔진은 D-A2에서 온다. 이 단계가 만드는 것은 **나중에 들어올 엔진이 지켜야 할 안전 계약**이다.

```text
D-A0  검증을 안전하게 실행할 수 있는 조건과 능력의 한계   ← 지금
D-A1  무엇을 검사할지 동결
D-A2  실제 검사 + disposition 라우팅
```

따라서 이 단계의 산출물은 **아직 아무도 호출하지 않는다.** 배선은 D-A2의 몫이며, 이는 누락이 아니라 의도다(4절).

---

## 2. 확정된 계약

### 2.1 능력은 두 축이며, 그중 하나만 Agora가 들고 다닌다

```text
artifact.*   Agora 자신이 산출물을 열어 술어를 평가할 수 있는가
             → 외부 런타임이 아니라 Agora가 무엇을 동봉했는지가 정한다

process.*    선언된 실행 파일을 돌릴 수 있는가
             → 이 PC에 그 실행 파일이 있는지만 확인한다
```

**`process` 축에는 언어 목록이 없다.** Agora는 Python도 R도 특별 취급하지 않는다. Verification Plan이 `executable`을 선언하면 그것의 존재를 확인할 뿐이다. 도메인 지식은 Agora가 아니라 Task가 공급한다는 Charter 원칙(D-A2 "도메인 Verifier 클래스를 core에 추가하지 않는다")이 여기서도 그대로 적용된다.

설계 논의 중 한 번 "Python/R 탐지"로 프레이밍했다가 교정했다. 그 프레이밍은 Agora를 다시 코딩 도구 쪽으로 좁힌다.

### 2.2 초기 범위는 Node 기본까지다 (A안)

```text
AVAILABLE     artifact.exists · artifact.hash · artifact.text
              artifact.json · artifact.csv · process.exec

UNAVAILABLE   artifact.xlsx · artifact.docx · artifact.pdf
```

xlsx/docx/pdf를 지원하려면 파서를 동봉해야 한다. 두 가지 이유로 하지 않는다.

- **Charter non-goal**: `NO xlsx/docx/pdf promises before runtime capability exists`. 능력이 실제로 생긴 뒤에만 올린다.
- **제품 제약**: Agora는 portable exe로 배포되고 runtime dependency가 사실상 `katex` 하나다. 무거워지는 쪽이 예외다.

**이 선택으로 검사가 불가능해지지는 않는다.** xlsx 수치 대조 같은 criterion은 세 경로가 있다.

```text
1. Agora가 직접 열어 비교        → 파서 동봉 시 (지금은 없음)
2. Plan이 선언한 프로세스가 비교  → 그 PC에 런타임이 있으면 (지금 가능)
3. Reviewer가 열어보고 판단       → 위 둘이 안 되면 (지금 가능)
```

즉 A안에서 잃는 것은 능력이 아니라 **결정성**이다. 기계가 확정하던 것이 모델 판단으로 내려가고, 그 사실이 기록에 남는다(R-3). 실사용에서 "이건 기계가 봐야겠다"가 확인되면 그때 형식별로 1번에 추가하면 된다.

### 2.3 능력 확인은 프로그램을 실행하지 않는다

`resolveExecutable`은 PATH/절대경로에서 **존재만** 확인한다. `--version` 같은 것을 실행해 능력을 재지 않는다.

이유는 편의가 아니라 INV-2다. 능력을 알아보려고 프로그램을 실행하면 **그 자체가 부수효과**이고, 검증기가 admission을 통과하기도 전에 무언가를 실행하는 셈이 된다. 테스트가 이를 강제한다(확인 후 마커 파일이 생기지 않아야 한다).

### 2.4 능력 판정은 실행 1회를 스냅샷으로 고정한다

검증 실행당 스냅샷 하나를 만들고 각 step이 그것을 참조한다. step마다 다시 재면 같은 실행 안에서 능력 판정이 달라질 수 있고, 그러면 "왜 강등됐는가"를 나중에 재구성할 수 없다. 확인된 실행 파일도 스냅샷에 누적 기록한다.

### 2.5 controlClass는 계산된다 (R-1)

선언값을 받지 않는다. Plan이나 모델이 "이 step은 ENFORCEABLE"이라고 적어도 무효다.

```text
artifact-predicate + contained  → ENFORCEABLE   (Agora 자신의 read-only 평가)
process + contained             → OBSERVABLE    (시작·종료·출력은 관측, 내부 행동은 강제 못 함)
알 수 없는 backend / 미봉쇄     → NEITHER       (fail-closed floor)
```

**subprocess를 OBSERVABLE로 정직하게 기록하는 것**이 이 단계의 핵심이다. sandbox를 넣어 ENFORCEABLE로 올리는 길도 있지만, 그것은 무게이며 지금 필요하지 않다. D-B가 자원/행동 차원의 통제 신호를 제공하면 그 신호로 다시 계산할 자리를 남겨 두었다.

### 2.6 검증 권한은 worker 이하이면서 절대 write를 넘지 않는다 (INV-2)

```text
verificationPermissionFor(worker) = min(worker, "workspace-read")

workspace-write → workspace-read   (worker가 쓸 수 있어도 검증은 못 쓴다)
workspace-read  → workspace-read
chat            → chat             (worker가 더 낮으면 그 이하를 따른다)
알 수 없음      → null → 실행 거부
```

검증이 governance 우회로가 되면 안 된다는 불변식의 강제 지점이다. 계산할 수 없으면 실행하지 않는다.

### 2.7 Verification Runner Contract

Charter가 명시한 항목을 그대로 구현했다.

```text
shell 금지            spawn(..., { shell: false }) 고정. executable에 셸 제어
                      문자가 있으면 admission에서 거부한다. 문자열 해석 경로가
                      생기는 순간 argv 검증이 무의미해진다.

구조화 실행           executable + argv + cwd + timeout. argv는 배열이며 개행/NUL이
                      섞이면 거부한다.

작업 폴더 봉쇄        cwd와 scriptPath는 realpath 기준으로 root 안이어야 한다.

script hash 동결      승인된 script는 경로가 아니라 **내용**으로 고정된다.
                      실행 시 hash가 다르면 실행하지 않는다. 동결 해시가 아예
                      없으면 그것도 거부한다(승인받지 않은 검사이므로).

env 최소 allowlist    process.env를 통째로 넘기지 않는다. 기본 집합만 전달하고,
                      추가가 필요하면 spec이 이름을 선언해야 한다.

출력 상한             256KB. 넘으면 잘라내고 truncated로 표시한다.

timeout               기본 120s, 상한 600s. 초과 시 process tree kill.
                      기존 chat-agent-runner의 killTree를 재사용한다.
```

**runner는 판정하지 않는다.** exit code가 3이어도 실행 자체는 `ok: true`다 — 무엇이 일어났는지를 사실로 남길 뿐이고, PASS/FAIL 판정과 disposition은 D-A2의 몫이다. 이 분리가 R-7(outcome ≠ disposition)의 전제다.

### 2.8 검증기의 부수효과는 Builder 변경과 분리해 기록한다

프로세스 검증은 임시 파일·빌드 산출물로 workspace를 오염시킬 수 있다. 섞이면 Reviewer가 보는 diff가 오염된다.

호출자가 대조 범위를 선언하면 실행 전후 지문을 떠서 변경된 경로를 남긴다. **범위가 선언되지 않으면 `accounted: false`로 정직하게 표시한다** — 부수효과가 없었다고 말하지 않는다.

---

## 3. 버린 대안

| 대안 | 버린 이유 |
|---|---|
| xlsx/docx/pdf 파서 동봉 | 배포 무게 증가. Charter non-goal이며, 강등 경로가 이미 정직하게 동작한다. 실사용에서 필요가 확인되면 그때 추가한다. |
| 능력 확인을 위해 `--version` 실행 | 확인 자체가 부수효과가 된다. admission 전에 무언가를 실행하는 것은 INV-2 위반이다. |
| `process.python` 같은 고정 언어 목록 | 도메인 지식이 core로 들어온다. 과업 종류마다 목록이 늘어나며, Agora가 모든 전문 영역을 알아야 하는 제품이 된다. |
| shell 문자열 실행 | argv 검증이 통째로 무의미해진다. 편의를 위해 경계를 여는 것이라 받아들일 수 없다. |
| `process.env` 통째 전달 | 자격증명·토큰이 검증기로 그대로 흘러간다. |
| sandbox 도입해 process를 ENFORCEABLE로 승격 | 무게. 지금은 OBSERVABLE로 정직하게 기록하는 것이 더 정확하고, D-B에서 재계산할 자리를 남겼다. |
| killTree 자체 구현 | `chat-agent-runner`에 이미 있고 export되어 있다. Windows `taskkill /T /F` 로직을 두 벌 유지할 이유가 없다. (`src/agora → src/chat` 의존은 `project-store`·`workflow-store`가 이미 쓰는 기존 패턴이다.) |
| controlClass를 엔진 타입 상수로 고정 | R-1 위반. extractor가 외부 프로세스를 부르는 순간 ENFORCEABLE이 거짓이 된다. |

---

## 4. 의도적으로 하지 않은 것

- **호출 지점 배선.** 이 모듈들은 현재 production 코드에서 호출되지 않는다. 검증을 시작할 주체(엔진)와 대상(Plan)이 아직 없기 때문이며, 배선은 D-A2다. D-0의 lease가 이미 "mutation~판정 구간"을 블록 전체로 잡아 두었으므로 검증 실행은 그 소유권 안으로 들어온다.
- **Artifact Predicate 엔진 자체.** 능력 축(`artifact.*`)만 정의했고 실제 추출기·술어 라이브러리는 D-A2다.
- **criterion 평가와 disposition 결정.** runner는 사실만 남기고 판정하지 않는다(2.7).
- **Verification Plan 스키마.** D-A1이며, 그때 "강등 시 Reviewer로 갈지 사용자로 갈지"를 criterion이 선언할 수 있게 할지도 함께 결정한다(현재 Charter 기본값은 Reviewer).

---

## 5. 검증

```text
test/verification-capabilities.test.js   11 tests
test/verification-runner.test.js         21 tests
canonical npm test                       1087 tests / 0 fail / 2 skipped
```

테스트가 실제로 증명하는 것(일부는 실제 프로세스를 띄워 확인한다):

- 동봉하지 않은 형식을 AVAILABLE로 가장하지 않으며, 알 수 없는 능력도 AVAILABLE로 추정하지 않는다.
- **능력 확인이 프로그램을 실행하지 않는다**(확인 후 마커 파일이 생기지 않음).
- 같은 실행 안에서 같은 실행 파일의 판정이 흔들리지 않는다.
- 검증 권한이 어떤 worker 권한에서도 write를 넘지 않고, 계산 불가면 실행하지 않는다.
- 셸 제어 문자·개행 인자·작업 폴더 밖 cwd를 admission에서 거부한다.
- **승인 이후 스크립트 내용이 바뀌면 실행을 거부한다**(경로가 아니라 내용으로 고정).
- **allowlist 밖 환경변수가 검증기로 새지 않는다**(가짜 토큰을 심어 확인).
- 출력 상한 초과 시 잘라내고 truncated로 표시한다.
- **멈춘 검증이 timeout으로 종료되고 성공으로 승격되지 않는다.**
- 검증기가 산출물을 건드리면 그 변경이 분리 기록되고, 범위 미선언 시 `accounted: false`로 표시된다.
- 지문 대조가 생성·삭제·수정을 모두 잡고 작업 폴더 밖은 보지 않는다.

---

## 6. 남은 확인

- 사용자 Windows 로컬에서 canonical `npm test` GREEN 실측 (Charter §6 DoD 3).
- actual-diff 독립 검수 PASS (Charter §6 DoD 2).
