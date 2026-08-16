# Agora — Managed Harness Runtime 개발일지 및 확장 기준

> 상태: 진행 중
> 최초 작성: 2026-08-16
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
3. 일반 대화는 긴 세션에서 최대 40개 메시지를 반복 전송한다.
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

상위 흐름은 가능한 한 유지한다.

```text
Planner
  → Plan Reviewer
  → Builder
  → Reviewer
  → Recorder
```

실제 신뢰성 흐름은 다음이 기준이다.

```text
Frozen Task
  → Checkpoint
  → Builder
  → Actual Diff
  → Evidence
  → Clean Reviewer
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

### 완료 또는 핵심 반영

- Task Contract file path 경계 강화
  - workspace 밖 상대 경로 거부
  - 절대 경로 거부
  - realpath 기반 symlink/junction escape 방어
  - regular file만 허용
  - 5 MiB 초과 사전 차단
- Task Contract text budget 제한
  - 최대 24K chars
- Frozen Task 검증 유지
  - 동일 Run은 동일 Frozen Task 사용
  - hash 손상 시 fallback 금지
- 전문 실행 strict-final 강화
  - 구조화 final 없이 delta-only 종료 시 성공 승격 금지
  - `PROTOCOL_FINAL_MISSING`
- Claude command evidence 회귀 수정
  - `tool_use_id`로 Bash start/result를 다시 결합
  - command 실행은 기존 `command-started` / `command-finished` 계약 유지
- `PROTOCOL_FINAL_MISSING` safe block reason 보존
- strict-final fallback marker의 일반 채팅 오탐 방어

### 아직 남은 안전성 작업

- child process environment sanitization
- dangerous auto-approve 정책 정리
- 승인 후 whole-turn replay 제거
- IPC의 Task resolver를 TaskManager의 hardened resolver와 통합
- unknown provider structured schema에 대한 정책 강화
- runtime/config/auth fingerprint
- external side effect / Git mutation / subagent capability 분리

일부 항목은 Stage C의 stateful runtime이 들어간 뒤 처리하는 편이 더 안전하다.

---

## 6. Stage B — Measurement / waste reduction

### 6.1 Tool event normalization

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
```

원칙:

- Bash/Shell/command 실행은 command evidence로 유지한다.
- Read/Grep/Glob 등 탐색 도구는 generic tool evidence로 기록한다.
- provider-specific 원문 전체 input/output을 장기 저장하지 않는다.
- path/pattern/query 같은 target은 bounded telemetry에만 제한적으로 사용한다.

### 6.2 Claude correlation

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

### 6.3 Run telemetry

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

### 6.4 Exploration loop detection

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
- Evidence/metrics에 기록
- hard kill은 실제 Run 분포를 본 뒤 결정

### 6.5 Professional Evidence bridge

telemetry는 다음 경로로 실제 전문 실행까지 전달된다.

```text
Provider event
  → parser telemetry
  → runner evidence
  → Professional Evidence payload
  → Reviewer prompt
  → RUN/evidence.json
```

전체 `commandSummary`를 최근 20개 command detail과 분리해 보존한다.

따라서 오래된 실패 command가 bounded detail window 밖으로 밀려나도 전체 실행 상태가 사라지지 않는다.

### 6.6 RunMetrics — 진행 중

Evidence와 별도로 성능/낭비 비교를 위한 RunMetrics를 추가하는 중이다.

목표 필드:

```text
run / invocation id
provider
model
professional stage
startedAt / finishedAt / durationMs
promptChars
stdoutBytes
command total / failed / truncated
tool started / finished / failed
tool outputBytes
uniqueTargets
repeatedCalls
maxRepeatCount
exploration status / reason
stopReason / result class
```

장기 metrics에는 raw command output, 파일 내용, tool target 원문을 보존하지 않는다.

### 검증 기준점

- RunMetrics 추가 직전 전체 `npm test`: 549 / 549 PASS
- 이후 RunMetrics core / metrics store / soft warning 변경은 별도 로컬 회귀 검증이 필요하다.

---

## 7. Stage B에서 남은 작업

1. RunMetrics persistence를 실제 `chat-ipc` invocation 결과에 연결
2. `.metrics.json` 장기 보존 확인
3. 실제 Professional Run 데이터를 몇 건 수집
4. soft loop warning의 false positive 확인
5. Deterministic Recorder
6. General Chat Summary Windowing
7. 필요 시 Stage B cleanup
   - `PROTOCOL_FINAL_MISSING` 등록 위치 정리
   - 기존 SpecialistMixin의 dead `executionAxes/evidencePayload` 제거 또는 delegation

Stage B를 닫을 때 hard loop kill을 반드시 넣을 필요는 없다. 관측 데이터 없이 자동 중단 정책을 먼저 만들지 않는다.

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

이 인터페이스는 방향성 계약이며 아직 완성 구현이 아니다.

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
2. role-scoped session registry
3. Codex App Server adapter
4. Claude session resume adapter
5. AGY conversation resume adapter
6. same-turn approval
7. session invalidation / health / shutdown

---

## 9. Stage D — Governance / Verification / quality normalization

Stage D에서는 Agora를 실행의 최종 authoritative control plane으로 만든다.

핵심 후보:

- Agora Verification Runner
- Verified Context Snapshot
- capability contract
- Git mutation capability
- side-effect capability
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

새 하네스가 일부 기능을 지원하지 않아도 fallback ProcessHarnessAdapter로 동작할 수 있어야 한다.

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
6. 기존 ProcessHarnessAdapter fallback이 가능한가?
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
- Stage A 안전성 → Stage B 관측 → Stage C runtime → Stage D verification 순서로 진행한다.

### 2026-08-16 — Stage A 핵심 안전성

반영:

- Task path / realpath / size / prompt budget 강화
- professional strict-final
- `PROTOCOL_FINAL_MISSING`
- Claude Bash evidence correlation
- safe block reason 보존
- strict-final marker 오탐 방어

검증:

- 단계별 targeted tests 수행
- Stage B telemetry bridge 완료 후 전체 `npm test` 549 / 549 PASS

### 2026-08-16 — Stage B telemetry

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

### 2026-08-16 — RunMetrics / soft warning 작업 시작

반영 중:

- provider-independent RunMetrics snapshot
- duration / prompt chars / stdout bytes
- command/tool aggregate
- exploration status
- soft WARNING / LOOP_DETECTED status event
- 별도 metrics persistence module

주의:

- 이 시점의 RunMetrics 이후 변경은 최신 전체 회귀 테스트가 아직 필요하다.
- loop detection은 관측용이며 자동 kill하지 않는다.

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

코드가 무엇을 하는지는 테스트와 소스가 말해준다.

이 문서는 **왜 그렇게 만들었는지, 무엇이 임시인지, 다음 사람이 무엇을 깨뜨리면 안 되는지**를 남기는 데 목적이 있다.
