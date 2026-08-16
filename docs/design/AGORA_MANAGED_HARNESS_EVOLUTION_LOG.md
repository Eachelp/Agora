# Agora — Managed Harness Runtime 개발일지 및 확장 기준

> 상태: **Stage A/B 마감 완료 · Stage C 착수 전**
> 최초 작성: 2026-08-16
> 최근 갱신: 2026-08-17
> 대상 브랜치: `feat/multi-harness-runtime`
> 관련 문서:
> - [AGORA_V1_DESIGN.md](AGORA_V1_DESIGN.md)
> - [AGORA_IMPLEMENTATION_PLAN.md](AGORA_IMPLEMENTATION_PLAN.md)
> - [AGORA_V1_FUTURE_COMPATIBILITY.md](AGORA_V1_FUTURE_COMPATIBILITY.md)

이 문서는 Agora의 전문 실행 신뢰성 강화와 Managed Harness Runtime 전환 과정을 기록하는 **개발일지 + 아키텍처 이행 문서**다.

기존 설계 문서가 "Agora가 어떤 제품이어야 하는가"를 정의한다면, 이 문서는 다음 질문에 답한다.

- 왜 현재 `runAgent → CLI spawn` 구조를 바꾸는가?
- 어떤 안전성·계측 문제를 먼저 해결했는가?
- Stage A~D는 무엇을 의미하며 어디까지 진행됐는가?
- Claude Code, Codex, AGY 외에 다른 Agent Harness를 추가할 때 무엇을 지켜야 하는가?
- 현재 단계에서 임시로 들어간 구현과 장기적으로 유지할 계약은 무엇인가?

---

## 1. 가장 중요한 원칙 — Stage는 런타임 구조가 아니다

Stage A/B/C/D는 **마이그레이션 순서**다. 제품 실행 시점의 영구 개념으로 만들지 않는다.

```text
Stage A — Safety / fail-closed
Stage B — Measurement / waste reduction
Stage C — Managed Harness Runtime
Stage D — Governance / Verification / quality normalization
```

따라서 다음은 금지한다.

- 런타임 곳곳에 `if (stageB)` 같은 분기 추가
- 특정 Stage에서 만든 임시 우회 로직을 public API로 굳히기
- 새 하네스를 추가할 때 Professional FSM 자체를 수정하도록 만드는 구조
- provider 이름(`claude`, `codex`, `agy`)을 control-plane 정책에 직접 퍼뜨리기

Stage가 모두 끝난 뒤에도 남아야 하는 것은 **계약, 인터페이스, 증거 형식, 권한 경계**이지 Stage 이름이 아니다.

---

## 2. 현재 문제 정의

기존 구조는 대략 다음과 같다.

```text
Agora
  → ChatRoom / Professional FSM
  → runAgent
  → provider별 CLI process 생성
  → Claude Code / Codex / AGY harness
```

이 구조는 단순하고 안정적이지만 전문 실행에서는 다음 문제가 관찰됐다.

1. Planner → Plan Reviewer → Builder → Reviewer → Recorder마다 새 CLI process가 생성된다.
2. 각 harness의 cold-start / initialization overhead가 누적된다.
3. 긴 일반 대화에서 과거 대화 전체를 반복 전송하면 context 비용이 계속 증가한다.
4. 일부 agent 실행에서 같은 대형 파일을 여러 번 Read/Grep하여 token·latency가 크게 증가한다.
5. provider별 이벤트 스키마와 tool 표현이 달라 실제 실행 근거를 동일하게 비교하기 어렵다.
6. 승인 흐름이 same-turn resume가 아니라 provider turn 전체 재실행으로 이어질 수 있다.
7. provider가 "테스트했다"고 말한 것과 실제 실행 증거를 분리할 필요가 있다.

목표는 harness의 기능을 Agora가 복제하는 것이 아니다.

> **Agora는 authoritative supervisor/control plane이 되고, 각 Agent Harness는 bounded tactical executor가 된다.**

---

## 3. 장기 권한 계층

최종적으로 다음 우선순위를 유지한다.

```text
Requirements truth
  = Frozen Task

Execution truth
  = actual filesystem / Git state

Verified execution
  = Agora Verification Runner + Evidence

Harness session memory
  = cache only

Model self-report
  = lowest trust
```

하네스가 세션을 기억하더라도 그 세션의 기억이 Task, Git 상태, Evidence보다 높은 권한을 가지면 안 된다.

---

## 4. 유지해야 할 핵심 Professional Workflow

상위 흐름은 유지한다.

```text
Planner
  → Plan Reviewer
  → Builder
  → Reviewer
  → Recorder
```

여기서 `Recorder`는 역할 이름이며 반드시 LLM 호출이라는 뜻은 아니다. Stage B 이후 persisted Professional Run의 기본 Recorder는 **deterministic program step**으로 동작한다.

실제 신뢰성 흐름은 다음이 기준이다.

```text
Frozen Task
  → Checkpoint
  → Builder
  → Actual Diff
  → Evidence
  → Clean Reviewer
  → Deterministic Record
  → Recovery / Completion
```

Managed Runtime 전환의 목적은 이 흐름을 없애는 것이 아니라, 아래의 실행 transport를 교체하는 것이다.

```text
현재
Professional FSM → runAgent → spawn CLI

목표
Professional FSM → HarnessAdapter → Managed Harness Runtime
```

---

## 5. Stage A — Safety / fail-closed

### 5.1 현재 독립적으로 해결 가능한 항목 — 완료

- Task Contract file path 경계 강화
  - workspace 밖 상대 경로 거부
  - 절대 경로 거부
  - realpath 기반 symlink/junction escape 방어
  - regular file만 허용
  - 5 MiB 초과 사전 차단
- Task Contract text budget 제한
  - 최대 24K chars
- IPC의 Task open/read 경계를 공용 hardened resolver로 통합
  - lexical 경계만 보던 별도 경로 제거
  - TaskManager와 동일하게 realpath / symlink escape / regular-file / size 경계를 사용
- Frozen Task 검증 유지
  - 동일 Run은 동일 Frozen Task 사용
  - hash 손상 시 fallback 금지
- 전문 실행 strict-final 강화
  - 구조화 final 없이 delta-only 종료 시 성공 승격 금지
  - `PROTOCOL_FINAL_MISSING`
- 실제 앱 실행 경로에서 전문 실행 여부를 `requireFinal: Boolean(specialistStage)`로 명시 전달
  - prompt marker 추론은 compatibility fallback으로만 남김
- strict-final fallback marker의 일반 채팅 오탐 방어
- Claude command evidence 회귀 수정
  - `tool_use_id`로 Bash start/result를 다시 결합
  - command 실행은 기존 `command-started` / `command-finished` 계약 유지
- 미등록 process harness fail-closed
  - 빈 argv나 암묵 fallback으로 실행하지 않음
  - 현재 Process runner가 명시적으로 지원하는 harness만 실행
- `PROTOCOL_FINAL_MISSING`을 canonical `SAFE_BLOCK_REASONS`에 직접 등록
- Professional Evidence ownership 정리
  - `chat-specialist.js`가 `chat-professional-evidence.js`에 정식 delegation
  - `chat-room.js`의 전역 Set mutation 제거
  - `chat-room.js`의 prototype evidence override 제거

### 5.2 Stage C에 의도적으로 넘긴 안전성 항목

다음은 위험을 알고 있지만 **현재 process-per-turn 구조에서 임시 우회로 완료 처리하지 않는다.** Managed Harness Runtime과 함께 해결한다.

- 승인 후 provider turn 전체 replay 제거
  - 목표: 같은 harness turn에 approval을 전달하고 그대로 resume
- provider/runtime별 child process environment 최소화
  - 인증·proxy·certificate·provider 설정을 깨뜨리지 않는 Runtime Profile과 함께 설계
- persistent role-scoped harness session
- session invalidation / health / shutdown

즉 Stage A에서 위험 식별과 현재 fail-closed 경계는 마련했지만, final remediation이 stateful transport에 의존하는 항목은 Stage C의 책임이다.

### 5.3 Stage D로 넘긴 governance 항목

- runtime/config/auth fingerprint
- Git mutation capability 분리
- external side-effect capability 분리
- subagent/nested-agent policy
- independent Verification Runner
- one-writer workspace lease의 최종 governance

이 항목들은 단순 transport 안전성보다 control-plane 권한과 검증 정책에 가깝다.

---

## 6. Stage B — Measurement / waste reduction

Stage B의 기능 구현은 **마감 완료** 상태다. 이후 threshold 조정과 실측 비교는 운영 관측의 연속 작업이지 Stage B를 닫지 못하게 하는 blocker가 아니다.

### 6.1 Tool event normalization — 완료

provider별 tool 이벤트를 공통 형태로 정규화한다.

현재 핵심 이벤트:

```text
delta
status
final
error
approval-required
command-started
command-finished
tool-started
tool-finished
run-metrics
```

원칙:

- Bash/Shell/command 실행은 command evidence로 유지한다.
- Read/Grep/Glob 등 탐색 도구는 generic tool evidence로 기록한다.
- provider-specific 원문 전체 input/output을 장기 저장하지 않는다.
- path/pattern/query 같은 target은 bounded telemetry에만 제한적으로 사용한다.

### 6.2 Claude correlation — 완료

Claude의 `tool_result`는 결과만으로 원래 도구 이름을 알 수 없는 경우가 있다.

따라서 실제 line parser는 `tool_use_id`를 기억한다.

```text
Bash(tool_use_id=x)
  → command-started

tool_result(x)
  → command-finished

Read(tool_use_id=y)
  → tool-started

tool_result(y)
  → tool-finished
```

이 경계 덕분에 기존 command evidence와 새 exploration telemetry를 동시에 유지한다.

### 6.3 Run telemetry — 완료

한 provider invocation 동안 다음을 집계한다.

- 전체 command count / failed / truncated
- tool started / finished / failed / truncated
- tool output bytes
- unique targets
- repeated calls
- max repeat count
- repeated target summary
- tool별 호출 횟수

raw event는 bounded window만 남기되 aggregate는 invocation 전체를 유지한다.

### 6.4 Exploration loop detection / soft warning — 완료

현재 자동 종료가 아니라 **관측용 heuristic**이다.

기본 기준:

```text
같은 target 4회 수준
  → WARNING

같은 target 8회 수준
  → LOOP_DETECTED
```

추가로 repeated calls, tool output volume, failure-rate가 결합되면 warning/loop로 승격할 수 있다.

canonical reason 예:

```text
repeated-target
repeated-calls
output-volume
failure-loop
failure-rate
```

현재 정책:

- WARNING → 실행 계속
- LOOP_DETECTED → 실행 계속
- 상태가 상승할 때 soft warning event 발생
- Evidence/metrics에 기록
- hard kill은 실제 Run 분포를 본 뒤 별도 정책 결정

현재 탐지는 Read/Grep/Glob 등 tool 탐색 반복을 주 대상으로 한다. command 반복 자체는 아직 loop 판정에 넣지 않는다.

이유:

- 동일한 `npm test`, build, formatter 실행이 수정 과정에서 정상적으로 반복될 수 있다.
- command 반복을 나중에 감지한다면 단순 횟수보다 `동일 command fingerprint + 변경 없음 + 반복 횟수` 같은 조건을 결합하는 편이 안전하다.

### 6.5 Professional Evidence bridge — 완료

telemetry는 다음 경로로 실제 전문 실행까지 전달된다.

```text
Provider event
  → parser telemetry
  → runner evidence
  → Professional Evidence payload
  → Reviewer prompt
  → RUN/evidence.json
```

전체 `commandSummary`를 bounded command detail과 분리해 보존한다.

따라서 오래된 실패 command가 detail window 밖으로 밀려나도 전체 실행 상태가 사라지지 않는다.

`execution`과 `exploration`은 서로 다른 축으로 유지한다.

```text
execution: OBSERVED
exploration.status: LOOP_DETECTED
```

탐색 낭비가 감지됐다고 실제 command 실행 사실을 지우지 않는다.

### 6.6 RunMetrics — core + persistence 완료

Evidence와 별도로 성능/낭비 비교를 위한 RunMetrics를 provider-independent schema로 유지한다.

현재 핵심 필드:

```text
invocationId
provider
model
effort
professional stage
startedAt / finishedAt / durationMs
promptChars
stdoutBytes
captureTruncated
approvalRequired
ok / stopReason
command total / failed / truncated
tool started / finished / failed / truncated
tool outputBytes
uniqueTargets
repeatedCalls
maxRepeatCount
exploration status / reason
```

장기 metrics에는 raw command output, 파일 내용, tool target 원문을 보존하지 않는다.

현재 연결:

```text
runAgentProcess
  → result.runMetrics
  → canonical run-metrics event
  → ChatRoom provenance
       runId / agentId / model / effort / specialistStage
  → chat-ipc execution boundary
  → persistRunMetrics()
  → <runId>.metrics.json
```

저장 정책:

- 세션별 `.metrics.json` 최대 100개 보존
- raw `.log` / `.evidence.json`의 20개 보존 정책과 분리
- metrics 저장 실패는 에이전트 실행 자체를 실패시키지 않는다.
- provider/model/effort/stage provenance를 저장 시 명시한다.

`stopReason` 기준:

```text
성공 → COMPLETED
실패 → 실제 stopReason 우선, 없으면 안정된 실패 분류
```

### 6.7 Deterministic Recorder — Professional 실행 경로 연결 완료

Professional Run의 Recorder는 이미 존재하는 구조화 사실을 다시 LLM에게 요약시키지 않고 deterministic하게 기록할 수 있다.

입력 권한:

- Frozen Task
- 최종 PASS verdict
- 실제 변경 파일 / Diff metadata
- Evidence command/tool aggregate
- exploration 상태

원칙:

- transcript를 읽지 않는다.
- raw diff와 tool target 원문을 기록에 복제하지 않는다.
- 확인되지 않은 decision / next action을 추론하지 않는다.

따라서 기본값은 다음과 같다.

```text
decisions: []
nextActions: []
```

현재 policy:

- persisted Professional Run → deterministic Recorder
- explicit deterministic policy → deterministic Recorder
- 토론 종합 / 수동 Recorder → 기존 provider-backed 경로 유지
- policy가 없는 isolated/legacy ChatRoom → 기존 provider 경로 유지

이렇게 해서 `ChatRoom`의 범용 계약을 깨지 않으면서 실제 Professional 실행의 일반 경로에서 Recorder용 추가 LLM 호출을 제거한다.

상위 workflow 이름은 그대로 유지한다.

```text
Planner → Plan Reviewer → Builder → Reviewer → Recorder
```

다만 마지막 Recorder가 일반 Professional Run에서는 프로그램 기반 단계다.

새로운 결정이나 다음 작업 후보를 LLM으로 생성할 필요가 생기면 Recorder 권한을 넓히지 않고 별도 선택적 `Memory Curator`로 분리한다.

### 6.8 General Chat Summary Windowing — 완료

긴 일반 대화에서 과거 원문 전체를 계속 재전송하는 대신 deterministic context window를 구성한다.

```text
Pinned Context
  = 첫 사용자 목표

Compressed Past
  = 오래된 대화의 bounded 압축 기록

Recent Messages
  = 최근 원문 대화

Current Turn
  = 현재 사용자 요청
```

현재 원칙:

- 짧은 일반 대화는 기존 전체 transcript 동작을 유지한다.
- 메시지 수가 많거나 오래된 본문 크기가 커지면 windowing을 적용한다.
- 최근 메시지는 원문으로 유지한다.
- 첫 사용자 목표를 별도 pinned context로 보존한다.
- 압축은 별도 LLM 호출을 추가하지 않는 deterministic 방식이다.
- Professional Builder/Reviewer 등 clean-room 전문 프롬프트에는 이 일반대화 window marker를 넣지 않는다.

즉 일반 채팅 context 비용을 줄이되 Professional 실행의 권한/clean-context 계약은 바꾸지 않는다.

### 6.9 Stage B cleanup — 완료

Professional Evidence의 최종 ownership은 다음과 같다.

```text
chat-professional-evidence.js
  = provider-neutral evidence shaping

chat-specialist.js
  = Specialist FSM에서 위 모듈로 정식 delegation

chat-room.js
  = 별도 evidence prototype override 없음
```

또한 `PROTOCOL_FINAL_MISSING`은 specialist의 canonical safe reason Set에 직접 포함한다. import side-effect로 Set을 변조하지 않는다.

---

## 7. Stage A/B 마감 기준점

### 기능/회귀 검증

cleanup까지 포함한 코드 기준점:

```text
87ab2c8e5b2ea40d51c973b6d7e160566a74eeb7
```

전체 테스트:

```text
587 tests
587 pass
0 fail
0 skipped
```

GitHub Actions:

```text
ubuntu-latest   PASS
macos-latest    PASS
windows-latest  PASS
```

검증된 주요 경계:

- strict-final explicit caller contract
- unknown process harness fail-closed
- IPC Task shared realpath boundary
- Claude command/tool correlation
- Professional Evidence bridge
- RunMetrics creation / event / persistence / retention
- soft exploration warning
- deterministic Professional Recorder policy
- General Chat Summary Windowing
- Professional FSM / Frozen Task / checkpoint / recovery / workflow lifecycle
- cleanup 이후 canonical safe reason / evidence delegation

### Stage B 이후 계속 관찰할 항목

다음은 Stage B 미완료가 아니라 **운영 데이터가 쌓인 뒤 조정할 observability tuning**이다.

1. 실제 Professional Run의 `.metrics.json` 분포 수집
2. WARNING / LOOP_DETECTED false-positive와 threshold 적합성 확인
3. 필요 시 command-loop heuristic 설계
   - 단순 반복 횟수로 차단하지 않는다.
4. hard loop kill 필요성은 실측 근거가 생긴 뒤 별도 결정

---

## 8. Stage C — Managed Harness Runtime

### 목표

물리 process 실행과 논리 session을 분리한다.

```text
                    Agora Control Plane
                           │
                 Canonical Harness Protocol
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   Claude Adapter     Codex Adapter      AGY Adapter
         │                 │                 │
 Claude Code session   App Server        Conversation
```

### 계획된 HarnessAdapter 계약

```text
HarnessAdapter
  inspectCapabilities()
  startSession()
  resumeSession()
  invalidateSession()
  runTurn()
  approve()
  cancel()
  health()
  shutdown()
```

이 인터페이스는 방향성 계약이며 아직 완성 구현이 아니다. Stage C에서 실제 adapter abstraction을 먼저 도입하고 현재 process runner를 compatibility adapter로 감싼 뒤 provider-native persistent runtime을 점진적으로 연결한다.

### 중요한 invariant

```text
Physical process may be shared.
Logical context may not be shared across roles.
Workspace writes may not be concurrent.
Authority may not be shared with harness.
Evidence may not be self-reported only.
```

역할별 session 예:

```text
Planner session
Plan Reviewer session
Builder session
Reviewer session
```

같은 provider/model을 쓰더라도 서로의 role context를 공유하지 않는다.

### 예정 순서

1. `HarnessAdapter` abstraction
2. role-scoped Harness Session Registry
3. Codex App Server adapter
4. Claude session/resume adapter
5. AGY conversation-resume adapter
6. same-turn approval
7. provider-scoped Runtime Profile / child env
8. session invalidation / health / shutdown

Stage C의 첫 구현은 새 provider 기능을 추가하는 것이 아니라 **현재 `runAgent → spawn CLI` 호출을 adapter 계약 뒤로 숨기는 것**이다. 이때 Professional FSM은 가능한 한 수정하지 않는다.

---

## 9. Stage D — Governance / Verification / quality normalization

Stage D에서는 Agora를 실행의 최종 authoritative control plane으로 만든다.

핵심 후보:

- Agora Verification Runner
- Verified Context Snapshot
- capability contract
- Git mutation capability
- external side-effect capability
- subagent policy
- runtime/config/auth fingerprint
- one-writer workspace lease
- provider/harness routing
- normalized error taxonomy

최종 목표는 다음과 같다.

```text
Builder says "tests passed"
        ↓
Provider event evidence
        ↓
Agora Verification Runner
        ↓
actual exitCode / digest / verified evidence
```

Model의 자기보고만으로 PASS를 확정하지 않는다.

---

## 10. 새 Agent Harness 추가 시 호환성 규칙

새 하네스를 붙일 때 가장 중요한 목표는 **Professional FSM을 수정하지 않는 것**이다.

### 새 하네스가 해야 하는 일

1. 자신의 capability를 보고한다.
2. 입력 prompt/turn을 자신의 protocol로 변환한다.
3. output/event를 Agora canonical event로 정규화한다.
4. 필요하면 자신의 session identifier를 adapter 내부에서 관리한다.
5. approval/cancel/health를 지원하는 범위만 명시한다.

### Agora core가 기대해야 하는 것

하네스마다 모든 기능이 동일하다고 가정하지 않는다.

예를 들어 capability는 다음처럼 선택적이어야 한다.

```text
supportsPersistentSession
supportsSameTurnApproval
supportsToolEvents
supportsCommandEvents
supportsModelCatalog
supportsConversationResume
supportsStructuredFinal
supportsCancellation
```

새 하네스가 일부 기능을 지원하지 않아도 compatibility Process Harness Adapter를 통해 현재 one-shot 실행 의미를 유지할 수 있어야 한다.

### 금지되는 추가 방식

```text
if provider === "new-provider"
  Professional FSM의 분기 추가
```

대신:

```text
HarnessAdapter
  + Capability profile
  + Event normalization
```

만 추가하는 방향을 우선한다.

---

## 11. 기능 변경 시 호환성 규칙

향후 기능을 바꿀 때 아래 질문으로 검토한다.

1. 이 기능은 control plane 정책인가, harness transport 기능인가?
2. provider 이름을 몰라도 구현 가능한가?
3. Role과 Agent를 다시 결합시키고 있지 않은가?
4. harness session memory를 authoritative state처럼 쓰고 있지 않은가?
5. Evidence schema를 깨뜨리지 않고 확장 가능한가?
6. 기존 Process Harness fallback이 가능한가?
7. 새 기능이 workspace writer를 동시에 둘 이상 만들 수 있는가?
8. 테스트 없이 heuristic을 hard policy로 승격하고 있지 않은가?

가능하면 새 기능은 다음 중 하나에만 속하게 한다.

```text
Control Plane
Adapter / Transport
Evidence / Verification
Metrics / Observability
UI
```

한 기능이 다섯 계층을 동시에 직접 건드린다면 경계가 잘못됐을 가능성이 높다.

---

## 12. Stage가 모두 끝난 뒤의 목표 모습

Stage A~D가 끝났을 때 코드 안에는 "Stage A/B/C/D"가 거의 남지 않는 것이 정상이다.

대신 다음 구조가 남아야 한다.

```text
Agora Control Plane
  ├─ Professional FSM
  ├─ Frozen Task
  ├─ Checkpoint / Recovery
  ├─ Workspace Diff
  ├─ Verification Runner
  ├─ Evidence Store
  ├─ Run Metrics
  ├─ Approval Policy
  ├─ Harness Session Registry
  ├─ Capability / Runtime Fingerprint
  └─ Workspace Writer Lock

Harness Runtime
  ├─ ProcessHarnessAdapter
  ├─ CodexAppServerAdapter
  ├─ ClaudeAdapter
  ├─ AgyAdapter
  └─ future adapters...
```

즉 Stage는 사라지고 **안정된 역할과 계약**만 남는다.

---

## 13. 개발일지

### 2026-08-16 — Managed Harness 전환 준비 시작

문제:

- 전문 실행의 반복 CLI cold-start
- 긴 일반 대화의 반복 context 비용
- 대형 파일 반복 Read/Grep
- provider별 실행 증거 형식 차이
- final/evidence protocol drift

결정:

- 큰 재작성 대신 기존 Professional FSM을 보존한다.
- `runAgent → spawn CLI` 하단을 점진적으로 Managed Harness Runtime으로 교체한다.
- Adapter의 대상은 Model API가 아니라 Agent Harness다.
- Stage A 안전성 → Stage B 관측/최적화 → Stage C runtime → Stage D verification 순서로 진행한다.

### 2026-08-16 — Stage A 핵심 안전성

반영:

- Task path / realpath / size / prompt budget 강화
- professional strict-final
- `PROTOCOL_FINAL_MISSING`
- Claude Bash evidence correlation
- safe block reason 보존
- strict-final marker 오탐 방어
- 실제 전문 호출 경계에서 `requireFinal` 명시 전달

검증:

- 단계별 targeted tests 수행
- Stage B telemetry bridge 완료 후 전체 `npm test` 549 / 549 PASS

### 2026-08-16 — Stage B telemetry / Professional Evidence

반영:

- generic tool-started / tool-finished
- Claude tool_use_id correlation
- command whole-run aggregate
- tool summary
- repeated target detection
- canonical exploration reason
- Professional Evidence bridge
- Evidence persistence

결과:

```text
Loop detection
  → Reviewer
  → RUN/evidence.json
```

까지 연결됐다.

### 2026-08-16 — RunMetrics / soft warning

반영:

- provider-independent RunMetrics snapshot
- duration / prompt chars / stdout bytes
- command/tool aggregate
- exploration status
- soft WARNING / LOOP_DETECTED status event
- canonical `run-metrics` event
- ChatRoom에서 run/model/effort/stage provenance 보존
- `chat-ipc` 공통 완료 경계에서 persistence
- 세션별 `<runId>.metrics.json`
- 최대 100개 보존
- 성공 stopReason을 `COMPLETED`로 통일

검증 과정:

- 사용자 targeted suite 123 / 123 PASS
- 새 `run-metrics` 이벤트 때문에 옛 runner event expectation 2건이 CI에서 실패해 회귀를 발견
- 실제 기능 문제가 아니라 stale expectation임을 확인하고 canonical event contract에 맞게 테스트 수정
- 이후 3 OS CI 정상화

### 2026-08-16 — Deterministic Recorder / Summary Windowing

반영:

- 구조화 Frozen Task / PASS / Diff / Evidence 기반 deterministic recorder core
- explicit recorder policy boundary
- persisted Professional Run의 Recorder를 deterministic 경로에 연결
- 토론 종합 / 수동 Recorder는 provider-backed 경로 유지
- 일반대화 deterministic Summary Windowing
  - 첫 사용자 목표 pinned
  - 오래된 기록 bounded 압축
  - 최근 메시지 원문 유지
  - 짧은 대화는 기존 동작 유지
  - Professional clean-room prompt에는 적용하지 않음

결정:

- Recorder는 새 결정을 만드는 주체가 아니다.
- 확인되지 않은 `decisions` / `nextActions`는 만들지 않는다.
- 필요 시 향후 별도 `Memory Curator`를 선택적으로 둔다.

### 2026-08-17 — Stage A/B 마감

반영:

- 미등록 Process Harness fail-closed
- IPC Task open/read를 shared hardened realpath boundary로 통합
- `PROTOCOL_FINAL_MISSING`을 canonical specialist safe reason에 직접 등록
- `chat-room.js`의 global Set mutation 제거
- `chat-room.js`의 Professional Evidence prototype override 제거
- `chat-specialist.js`의 evidence methods를 provider-neutral evidence module로 정식 delegation
- cleanup ownership을 회귀 테스트로 고정

최종 코드 검증 기준점:

```text
87ab2c8e5b2ea40d51c973b6d7e160566a74eeb7
```

결과:

```text
npm test
  587 / 587 PASS

GitHub Actions
  ubuntu-latest   PASS
  macos-latest    PASS
  windows-latest  PASS
```

Stage A에서 stateful runtime이 필요한 항목은 임시 구현하지 않고 Stage C로 명시적으로 이관했다.

Stage B는 기능 구현 기준으로 마감한다. 이후 `.metrics.json` 실측 분포와 loop threshold 보정은 지속적인 observability tuning으로 다룬다.

다음 구현 시작점:

```text
Stage C
  → HarnessAdapter abstraction
  → role-scoped Harness Session Registry
  → provider-native managed runtimes
```

---

## 14. 문서 유지 규칙

이 문서는 각 큰 migration milestone마다 갱신한다.

다음 상황에서는 반드시 한 줄이라도 개발일지를 남긴다.

- 새로운 Agent Harness 추가
- HarnessAdapter contract 변경
- Evidence schema 변경
- Professional FSM의 authority 변경
- approval policy 변경
- runtime/session persistence 방식 변경
- hard safety policy 추가
- 기존 heuristic을 hard gate로 승격
- 대규모 성능 최적화 결과 측정
- RunMetrics / Recorder / Summary Windowing처럼 migration 완료 상태가 바뀌는 변경

코드가 무엇을 하는지는 테스트와 소스가 말해준다.

이 문서는 **왜 그렇게 만들었는지, 무엇이 임시인지, 다음 사람이 무엇을 깨뜨리면 안 되는지**를 남기는 데 목적이 있다.
