# Agora — Managed Harness Runtime 개발일지 및 확장 기준

> 상태: **Stage A/B 완료 · Professional 안정화 Stage 1~5 COMPLETE · Stage C Managed Harness Runtime COMPLETE (Session Invalidation / Lifecycle 포함 · FINAL PASS — AGORA_STAGE_C_FINAL_REVIEW.md) · Stage D Assurance & Governance COMPLETE (D-0 · D-A0 · D-A1 · D-A2 · D-B · D-C — AGORA_STAGE_D_ASSURANCE_DECISIONS.md) · 다음: M-track (M2 derived Memory Bank · M3 AGENTS.md/CLAUDE.md export)**
> 최초 작성: 2026-08-16
> 최종 안정화 기준일: 2026-08-18
> 대상 브랜치: `feat/multi-harness-runtime`
> 최종 검증 코드 baseline: `fba6011d46b621348d074b36df76da0c5cdd8aec`
> 관련 문서:
> - [AGORA_V1_DESIGN.md](AGORA_V1_DESIGN.md)
> - [AGORA_IMPLEMENTATION_PLAN.md](AGORA_IMPLEMENTATION_PLAN.md)
> - [AGORA_V1_FUTURE_COMPATIBILITY.md](AGORA_V1_FUTURE_COMPATIBILITY.md)

이 문서는 Agora의 전문 실행 신뢰성 강화와 Managed Harness Runtime 전환 과정을 기록하는 **개발일지 + 현재 상태 + 다음 단계 handoff 문서**다.

현재 기준에서 가장 중요한 결론은 하나다.

> **Stage A/B와 Professional 안정화 Stage 1~5는 끝났다. Stage C는 대부분의 provider-native continuity와 Codex same-turn approval까지 완료되었고, 마지막 핵심 integration은 Session Invalidation / Lifecycle이다.**

---

## 1. Agora의 장기 방향

Agora는 단순히 여러 CLI를 한 화면에서 부르는 런처가 아니라, 여러 Agent Harness를 통제하는 **authoritative supervisor / control plane**으로 간다.

각 Claude Code, Codex, AGY 같은 하네스는 강력한 실행 능력을 가지지만 최종 권한은 갖지 않는다.

장기 권한 계층은 다음과 같다.

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

하네스가 세션을 기억하거나 스스로 "테스트를 통과했다"고 말하더라도, Frozen Task / 실제 Git 상태 / Agora Evidence보다 높은 권한을 가지면 안 된다.

---

## 2. Stage는 마이그레이션 순서이지 런타임 구조가 아니다

Stage A/B/C/D는 구현 순서를 설명하는 이름이다.

```text
Stage A — Safety / fail-closed
Stage B — Measurement / waste reduction
Stage C — Managed Harness Runtime
Stage D — Governance / Verification / quality normalization
```

최종 제품 코드에 `if (stageB)` 같은 분기를 남기는 것이 목적이 아니다.

Stage가 사라진 뒤에도 남아야 하는 것은 다음이다.

- 명시적 계약
- 역할별 context boundary
- 권한 경계
- Evidence schema
- HarnessAdapter interface
- session lifecycle
- verification / governance policy

금지 원칙:

- 새 provider를 붙일 때 Professional FSM에 provider 이름 분기를 퍼뜨리지 않는다.
- 특정 Stage에서 사용한 임시 우회 로직을 public contract로 굳히지 않는다.
- Harness session memory를 authoritative state로 승격하지 않는다.
- 모델 자기보고만으로 실제 실행 성공을 확정하지 않는다.

---

## 3. 유지해야 하는 Professional Workflow

제품 상위 workflow는 유지한다.

```text
Planner
  → Plan Reviewer
  → Builder
  → Reviewer
  → Recorder
```

실제 신뢰성 흐름은 다음이 기준이다.

```text
User Request
  → Planner
  → Plan Reviewer
  → Frozen Task
  → Checkpoint
  → Builder
  → Actual Diff
  → Evidence
  → Reviewer
  → Deterministic Recorder
  → Recovery / Completion
```

현재 transport:

```text
Professional FSM
  → runAgent()
  → fresh CLI process
  → Claude / Codex / AGY
```

Stage C 목표:

```text
Professional FSM
  → HarnessAdapter
  → Managed Harness Runtime
  → persistent role-scoped harness sessions
```

Stage C는 Professional FSM을 다시 설계하는 프로젝트가 아니다.

> **상위 workflow와 authority는 그대로 두고 실행 transport를 교체한다.**

---

# Part I. 지금까지 완료한 일

## 4. Stage A — Safety / fail-closed 완료

### Task / 파일 경계

- Task Contract path는 workspace 내부만 허용한다.
- 절대 경로를 거부한다.
- realpath 기준으로 symlink / junction escape를 막는다.
- regular file만 허용한다.
- Task read/open 경계를 공용 hardened resolver로 통합했다.
- Task file 최대 크기 경계를 둔다.
- Task Contract prompt text budget을 둔다.

### Frozen Task

- 동일 Run은 동일 Frozen Task를 사용한다.
- Frozen Task hash 손상 시 fallback하지 않는다.
- Requirements truth는 live transcript가 아니라 Frozen Task다.

### strict-final

- Professional 실행은 구조화 final 없이 delta만 남기고 끝난 경우 성공으로 승격하지 않는다.
- canonical stop reason으로 `PROTOCOL_FINAL_MISSING`을 사용한다.
- 일반 채팅에서 Professional marker가 오탐되지 않도록 경계를 분리했다.

### provider / process fail-closed

- 미등록 process harness는 실행하지 않는다.
- 빈 argv / 암묵 fallback으로 unknown provider를 실행하지 않는다.
- 현재 Process runner가 명시적으로 지원하는 harness만 실행한다.

### Evidence ownership

Professional Evidence shaping의 ownership을 정리했다.

```text
chat-professional-evidence.js
  = provider-neutral evidence shaping

chat-specialist.js
  = Specialist FSM delegation

chat-room.js
  = 별도 prototype evidence override 없음
```

---

## 5. Stage B — Measurement / waste reduction 완료

### Canonical tool events

provider별 실행 이벤트를 공통 형태로 정규화했다.

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

### Claude tool correlation

Claude의 `tool_use_id`를 이용해 tool start/result를 다시 연결한다.

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

### Run telemetry

한 invocation에 대해 다음 aggregate를 기록한다.

- command count / failed / truncated
- tool started / finished / failed / truncated
- tool output bytes
- unique targets
- repeated calls
- max repeat count
- repeated target summary
- tool별 호출 횟수

### Exploration loop detection

현재 hard kill이 아니라 observability heuristic이다.

```text
같은 target 약 4회
  → WARNING

같은 target 약 8회
  → LOOP_DETECTED
```

repeated calls / output volume / failure rate도 보조 신호로 사용한다.

현재는 실행을 강제로 끊지 않고 Evidence와 metrics에 기록한다.

### Evidence bridge

```text
Provider event
  → parser telemetry
  → runner evidence
  → Professional Evidence
  → Reviewer prompt
  → RUN/evidence.json
```

`execution`과 `exploration`은 서로 다른 축으로 유지한다.

```text
execution: OBSERVED
exploration.status: LOOP_DETECTED
```

### RunMetrics

provider-independent metrics schema를 추가했다.

핵심 필드:

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
command aggregate
tool aggregate
uniqueTargets
repeatedCalls
maxRepeatCount
exploration status / reason
```

세션별 `.metrics.json`을 별도 retention으로 관리한다.

### Deterministic Recorder

일반 Professional Run의 Recorder는 구조화된 사실을 다시 LLM에게 요약시키지 않고 deterministic program step으로 처리한다.

입력:

- Frozen Task
- final PASS verdict
- 실제 Diff metadata
- Evidence aggregate
- exploration 상태

기본적으로 확인되지 않은 decision / next action을 만들어내지 않는다.

```text
decisions: []
nextActions: []
```

새 판단이 필요하면 Recorder 권한을 넓히기보다 별도 선택적 Memory Curator를 두는 방향을 유지한다.

### General Chat Summary Windowing

긴 일반 대화는 deterministic context window를 사용한다.

```text
Pinned Context
  = 첫 사용자 목표

Compressed Past
  = 오래된 bounded 압축 기록

Recent Messages
  = 최근 원문

Current Turn
  = 현재 사용자 요청
```

Professional clean-room prompt에는 일반 채팅용 summary window를 섞지 않는다.

---

## 6. Professional 안정화 Stage 1~5 — COMPLETE

Stage A/B를 마감한 뒤 Stage C에 들어가기 전에 Professional workflow 자체의 계약, 권한, 복구, 입력 라우팅을 fail-closed로 정리했다.

### Stage 1 — Project workspace authority 완전 통일

최종 계약:

```text
ProjectStore.workspace
  = runtime authority

session.workspace
  = migration / UI / compatibility cache only
```

반영:

- `roomMeta`
- `makeRunAgent`
- `resolveTaskFilePath`
- Task open/read
- task reconciliation
- `chat:specialist:start`
- `chat:permission:set`
- Professional Freeze
- Checkpoint
- Actual Diff / execution 경로

모두 project workspace를 authority로 사용한다.

Migration conflict에서:

```text
project.workspace = null
session.workspace = stale path
```

이어도 runtime은 session cache로 임의 fallback하지 않는다.

Case A 회귀 테스트:

```text
project.workspace = null
session.workspace = stale A

→ Professional 실행 거부
→ workspace permission elevation 거부
→ Task read/open 거부
→ provider call 0
```

Case B 회귀 테스트:

```text
project.workspace = repoB
session.workspace = stale repoA

→ Task read = repoB
→ Frozen Task = repoB
→ Checkpoint = repoB
→ canonical provider invocation path = repoB
→ repoA는 runtime authority가 아님
```

이 테스트는 실제 로컬 CLI 설치 여부에 의존하지 않도록 deterministic fake capability service를 사용한다.

---

### Stage 2 — Task Contract hard gate

필수 heading은 정확히 다음 6개다.

```text
Goal
Requirements
Implementation Approach
Acceptance Criteria
Verification
Out of Scope
```

필수 heading은 exact name만 인정한다.

section body는 실제 의미 있는 내용이 있어야 한다.

다음만 있는 body는 empty로 취급한다.

```text
fenced code block only
STATUS: ...
VERDICT: ...
[[CODEPET_...]]
```

반대로 일반 설명 문장 안에 `STATUS` / `VERDICT`라는 단어가 들어갔다는 이유만으로 제거하지 않는다.

Freeze 직전에도 계약을 다시 검증하며 invalid Task는 `TASK_CONTRACT_INCOMPLETE`로 표면화한다.

---

### Stage 3 — Checkpoint / Recovery / Evidence

Checkpoint 실패 reason을 typed taxonomy로 고정했다.

```text
CHECKPOINT_GIT_FAILED
CHECKPOINT_UNTRACKED_NOT_REGULAR
CHECKPOINT_COPY_FAILED
CHECKPOINT_STORAGE_FAILED
CHECKPOINT_MANIFEST_FAILED
CHECKPOINT_UNKNOWN
```

OS raw error code가 최종 reason으로 그대로 새어나가지 않는다.

Checkpoint creation:

- tracked.patch 저장 후 hash/bytes 검증
- untracked list 저장 후 hash/bytes 검증
- manifest 작성
- `inspectCheckpoint()` 자체 검증
- 검증 성공한 경우에만 `supported:true`

non-Git workspace의 기존 정상 의미는 유지한다.

```text
{ supported: false }
```

이것은 checkpoint failure가 아니다.

### Retry provenance

Checkpoint 실패 후 재시도/무보호 재개에서도 기존 실행 context를 보존한다.

- 동일 Frozen Run ID
- 동일 Frozen Task
- taskInfo
- feedback
- maxAutoRevisions
- checkpointFailReason

무보호 실행은 명시적 사용자 승인만 허용하고:

```text
checkpointProtection = unavailable_user_approved
userApprovedUnprotectedExecution = true
```

를 영속적으로 남긴다.

Reviewer / Evidence도 사전 workspace snapshot이 없었다는 사실을 알 수 있다.

---

### Stage 4 — Professional input routing / role context

Professional mode에서 일반 chat turn과 전문 실행 turn이 섞이지 않게 했다.

Professional ON + active run 없음:

```text
professionalDraft / recordOnly
```

로 사용자 요청만 기록한다.

활성 상태:

```text
PLANNING:WAITING
  → planAnswer / cancel

PLAN_REVIEW:WAITING
  → planAnswer / cancel

READY:WAITING
  → startImpl / startFull / planEdit / cancel

IMPLEMENTING / REVIEWING / RECORDING
  → 일반 입력 거부

BLOCKED
  → blocked resolution only
```

`COMPLETED/COMPLETED`만 inactive로 취급한다.

다음처럼 일관되지 않은 state는 fail-closed로 active 취급한다.

```text
COMPLETED / WAITING
READY / COMPLETED
UNKNOWN / UNKNOWN
```

### ROLE_CONTEXT_POLICY

역할별 context 포함 여부를 실제 prompt assembly authority로 승격했다.

Planner:

- user request
- conversation context
- confirmed decisions
- relevant task list
- project context / rules / memory
- workspace read

Plan Reviewer:

- user request
- current TASK
- confirmed workflow context
- project rules
- workspace read
- free transcript/memory는 제외

Builder:

- Frozen Task
- Project Rules
- Workspace
- 필요한 dependency
- free transcript / backlog 제외

Reviewer:

- Frozen Task
- Actual Diff
- Evidence
- 필요한 source
- Project Rules
- Builder narrative / free transcript 제외

Recorder:

- Frozen Task
- final Diff
- final Verdict
- Evidence
- transcript / free chatter / Project Rules 제외

`rulesContext → projectRules`도 중앙 policy를 통과한다.

---

### Stage 5 — 두 종류의 "쉽게 설명" 계약 분리

두 기능을 동일한 intent로 취급하지 않는다.

#### Direct `[💡 쉽게 설명]`

의미:

> "네가 방금 한 말을 네가 쉽게 다시 설명해줘"

계약:

```text
intent = SIMPLIFY_SELF
same author
same actual resolved model
source effort when concrete
no alternate model UI
no fallback
no tools
no new judgment
no review
```

원문 작성 당시 실제 concrete model ID를 `resolvedModel` metadata로 보존한다.

다음 경우는 fail-closed한다.

```text
agentMeta 없음
model = default 뿐이고 resolvedModel 없음
원문 작성 agent 사용 불가
```

현재 agent default가 바뀌었다고 새 기본 모델로 drift하지 않는다.

#### Handoff `[다른 AI에게 전달 → 쉽게 설명]`

의미:

> "얘가 한 말을 네가 쉽게 설명해줘"

계약:

```text
intent = SIMPLIFY
사용자가 target AI 선택
target AI의 현재 설정 모델 사용
source text/fromAgentId/messageId 전달
source author 강제 없음
source model 강제 없음
```

Direct와 Handoff의 의미를 backend intent 수준에서 분리했다.

IPC policy에서도 `SIMPLIFY`와 `SIMPLIFY_SELF`를 모두 `simplify` action으로 분류한다.

---

## 7. Professional stabilization 과정에서 추가로 닫은 결함

Stage 1~5를 구현한 뒤 반복 외부 검수에서 다음 residual을 추가로 닫았다.

### workflow-store provenance

동일 `taskPath`의 기존 revision이 하나뿐이어도 disk canonical과 다르면 stale revision을 `superseded`로 내린다.

`missing_file`은 external edit provenance로 기록하지 않는다.

같은 stale revision을 반복해서 열었다고 provenance event를 중복 생성하지 않는다.

### FSM 재진입

`USER_EXECUTE` 무보호 재진입은 다음 정확한 상태에서만 허용한다.

```text
node = IMPLEMENTING
status = RUNNING
checkpointProtection = unavailable_user_approved
userApprovedUnprotectedExecution = true
```

일반 IMPLEMENTING/RUNNING duplicate execute는 거부한다.

### retry context

Checkpoint retry에서:

- taskInfo
- feedback
- maxAutoRevisions

를 잃지 않는다.

### Project Rules context

Recorder와 Direct Simplify에 Project Rules가 들어가지 않게 했다.

### Checkpoint protection truth

artifact metadata를 읽지 못하면 빈 metadata로 fallback하지 않는다.

manifest를 썼다는 이유만으로 protected라고 선언하지 않고 자체 검증 후에만 성공으로 본다.

### cross-platform path

macOS `/var` ↔ `/private/var` 차이를 테스트에서 `fs.realpathSync()`로 canonicalize했다.

production realpath safety를 테스트 편의를 위해 약화하지 않았다.

---

# Part II. 최종 검증 기준점

## 8. Stage 1~5 최종 baseline

최종 코드 baseline:

```text
58e5d8c7f31f8f214fb15997eabd60ac710191cc
```

커밋:

```text
fix(agora): SIMPLIFY_SELF 핸드오프 폴리시 분류 및 Case B CI 독립 검증
```

로컬 전체 테스트:

```text
664 tests
663 pass
0 fail
1 skip
```

skip 1건은 Windows symlink 생성 권한(`EPERM`)에 따른 플랫폼 의존 테스트다.

GitHub Actions run #117 실측:

```text
windows-latest
  npm ci    PASS
  npm test  PASS

ubuntu-latest
  npm ci    PASS
  npm test  PASS

macos-latest
  npm ci    PASS
  npm test  PASS
```

따라서 최종 판정은 다음과 같다.

```text
Stage A                     COMPLETE
Stage B                     COMPLETE
Professional Stabilization
  Stage 1                   COMPLETE
  Stage 2                   COMPLETE
  Stage 3                   COMPLETE
  Stage 4                   COMPLETE
  Stage 5                   COMPLETE
3-OS CI                     GREEN
Stage C                     READY
```

이 baseline 이후에는 Stage 1~5를 다시 열기 위한 "잔여 cleanup 찾기"를 목적으로 범위를 넓히지 않는다.

명확한 실제 regression이 발견되면 해당 계약만 수정한다.

---

## 9. 지금 절대 깨뜨리면 안 되는 invariant

Stage C 구현자는 다음을 transport 최적화보다 우선해야 한다.

### Authority

```text
ProjectStore.workspace > session.workspace
Frozen Task > harness memory
actual filesystem/Git > model narrative
Agora Evidence > self-report
```

### Role isolation

```text
Physical process may be shared.
Logical context may not be shared across roles.
```

Planner session / Reviewer session / Builder session을 같은 provider process에서 물리적으로 multiplex하더라도 논리 context는 섞이면 안 된다.

### Workspace writer

```text
Workspace writes may not be concurrent.
```

persistent runtime을 추가한다고 동시에 여러 writer가 생기면 안 된다.

### Recovery

Checkpoint / Frozen Task / run provenance는 harness session보다 상위다.

세션이 죽으면 세션을 버리고 authoritative state에서 복구한다.

### Evidence

persistent session이 "전에 테스트했다"고 기억해도 새 Run의 Evidence로 간주하지 않는다.

### Compatibility

새 adapter가 아직 native persistence를 지원하지 않아도 기존 one-shot process semantics로 안전하게 fallback할 수 있어야 한다.

---

# Part III. 이제 남은 일

## 10. Stage C — Managed Harness Runtime

Stage C의 목적은 **process-per-turn transport 비용과 replay를 줄이되 현재 control-plane 계약을 건드리지 않는 것**이다.

### 목표 구조

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

### HarnessAdapter 방향성 계약

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

이 interface는 Stage C에서 실제 abstraction으로 확정한다.

---

## 11. Stage C 구현 순서

### C1. HarnessAdapter abstraction

가장 먼저 할 일이다.

현재:

```text
Professional FSM → runAgent → spawn CLI
```

를:

```text
Professional FSM → HarnessAdapter → ProcessHarnessAdapter → 기존 runner
```

로 감싼다.

**첫 단계에서 동작 의미를 바꾸지 않는다.**

목표는 provider-native persistence를 바로 넣는 것이 아니라 기존 안전한 one-shot 실행을 adapter 계약 뒤로 숨기는 것이다.

### C2. Role-scoped Harness Session Registry

논리 session key는 최소한 역할을 분리해야 한다.

예:

```text
project / workspace
provider
agent/model config
role
```

Planner와 Builder가 같은 Claude process를 공유할 수는 있어도 logical session은 같으면 안 된다.

Registry가 다뤄야 할 것:

- session id
- role
- provider
- workspace identity
- lifecycle state
- last health
- invalidation reason
- runtime generation

Harness session state는 authoritative하지 않다.

### C3. Codex App Server adapter

Codex의 persistent / app-server 계열 인터페이스를 Managed Runtime에 연결한다.

목표:

- process cold-start 감소
- role-scoped logical session
- canonical event normalization 유지
- current Evidence / Metrics 경로 재사용

### C4. Claude session/resume adapter

Claude의 session/resume 기능을 adapter 안에서 관리한다.

주의:

- Agora가 role별 context authority를 유지한다.
- Claude session memory를 Requirements truth로 사용하지 않는다.
- session mismatch / stale session은 invalidate 후 authoritative input으로 재시작한다.

### C5. AGY conversation/resume adapter

AGY가 지원하는 conversation/session primitive를 같은 canonical contract 뒤에 연결한다.

provider 특수 로직은 adapter 내부에 둔다.

Professional FSM에 `if (provider === "agy")` 같은 분기를 추가하지 않는다.

### C6. Same-turn approval

현재 approval-required 후 provider turn 전체 replay가 발생할 수 있다.

Stage C에서는 가능한 provider에 대해:

```text
runTurn
  → approval-required
  → Agora policy/user approval
  → adapter.approve()
  → same turn resume
```

로 바꾼다.

지원하지 않는 provider는 capability로 명시하고 compatibility replay 의미를 유지한다.

### C7. Runtime Profile / child environment

persistent child process를 만들면서 environment를 최소화한다.

단, 단순 allowlist로 인증/proxy/certificate/provider 설정을 깨뜨리면 안 된다.

Runtime Profile은 provider별 필요 환경을 capability와 함께 명시하는 방식으로 설계한다.

### C8. Session invalidation / health / shutdown

필수 lifecycle:

```text
healthy
stale
invalidated
restarting
closed
```

무효화 조건 후보:

- workspace 변경
- project 이동
- model/config 변경
- auth/runtime fingerprint 변경
- provider crash
- protocol desync
- role policy 변경

Agora 종료 시 child process를 명시적으로 정리한다.

---

## 12. Stage C에서 아직 하지 않을 것

Stage C를 시작한다고 아래까지 한 번에 가져오지 않는다.

- Professional FSM 재설계
- Frozen Task authority 변경
- Reviewer authority 변경
- model self-report를 Verification으로 승격
- provider별 quality score normalization
- Git mutation governance 완성
- external side-effect governance 완성
- subagent/nested-agent governance 완성
- hard exploration loop kill

이들은 Stage C transport와 분리하거나 Stage D로 넘긴다.

---

## 13. Stage C 완료 기준

Stage C를 완료하려면 단순히 persistent process가 떠 있는 것으로 부족하다.

최소 완료 조건:

1. Professional FSM이 provider-native session 구현을 직접 알지 않는다.
2. ProcessHarnessAdapter가 기존 one-shot semantics를 보존한다.
3. 최소 하나 이상의 provider-native persistent adapter가 실제로 동작한다.
4. role-scoped logical context isolation이 테스트된다.
5. workspace change / project change / config change 시 session invalidation이 검증된다.
6. same-turn approval 지원 provider에서 replay 없이 resume된다.
7. unsupported capability는 명시적으로 fallback/fail-closed한다.
8. canonical events / Evidence / RunMetrics가 기존 schema를 깨지 않고 유지된다.
9. cancellation / health / shutdown이 deterministic하게 동작한다.
10. 기존 Professional Stage 1~5 regression suite가 계속 green이다.
11. Windows / Ubuntu / macOS CI가 green이다.

---

## 14. Stage D — 이후 governance / verification

Stage C 뒤의 주요 후보:

- Agora Verification Runner
- Verified Context Snapshot
- capability contract 강화
- Git mutation capability
- external side-effect capability
- subagent / nested-agent policy
- runtime / config / auth fingerprint
- one-writer workspace lease의 최종 governance
- provider/harness routing
- normalized error taxonomy
- quality normalization

최종적으로 원하는 검증 흐름:

```text
Builder says "tests passed"
        ↓
Provider event evidence
        ↓
Agora Verification Runner
        ↓
actual exitCode / digest / verified evidence
```

모델의 자기보고만으로 PASS를 확정하지 않는다.

---

# Part IV. 역사적 기준점

## 15. 주요 migration / stabilization baseline

### 2026-08-16 — Managed Harness 전환 준비

결정:

- 기존 Professional FSM을 보존한다.
- 큰 재작성 대신 transport를 단계적으로 교체한다.
- Adapter 대상은 Model API가 아니라 Agent Harness다.

### 2026-08-17 — Stage A/B 마감

기준점:

```text
87ab2c8e5b2ea40d51c973b6d7e160566a74eeb7
```

검증:

```text
587 tests
587 pass
0 fail

ubuntu   PASS
macos    PASS
windows  PASS
```

### 2026-08-17 — Professional 작업 요청 라우팅 baseline correction

실사용에서 Professional 작업 요청을 일반 `chat:send`로 보내면서 Planner와 일반 broadcast가 섞이는 회귀를 발견했다.

수정:

- Professional 작업 요청은 recordOnly draft로 기록
- provider 호출은 PLAN / 실행 시작 이후 Professional FSM만 수행
- 일반 turn busy와 Professional 실행 버튼 경계 정리

기준점:

```text
9f488186ff2fd168def196a877407dfa9a5de92d
```

검증:

```text
590 / 590 PASS
3-OS CI GREEN
```

### 2026-08-17 — Professional 안정화 반복 검수

주요 수정 흐름:

- Task Contract 6개 필수 section hard gate
- workflow provenance correction
- checkpoint typed taxonomy
- retry provenance
- unprotected execution provenance
- IPC policy runtime authority
- ROLE_CONTEXT_POLICY prompt authority
- USER_EXECUTE 재진입 guard
- project workspace authority 통일
- marker-only section rejection
- direct / Handoff simplify semantics 분리
- active Professional recordOnly 차단
- Project Rules context boundary
- checkpoint self-validation
- cross-platform realpath test
- resolvedModel same-model direct simplify
- deterministic CI-independent Case A/B regression tests

마지막 residual까지 닫은 코드 baseline:

```text
58e5d8c7f31f8f214fb15997eabd60ac710191cc
```

이 기준점에서 Stage 1~5는 종료한다.

---

### 2026-08-17 — Stage C-1: HarnessAdapter process compatibility boundary

Stage C의 첫 단계(C-1)로 provider CLI 실행 transport를 HarnessAdapter 경계 뒤로 옮겼다.
목표는 새 runtime 기능 추가가 아니라 순수 transport abstraction 도입이며, 성공 기준은
observable behavior change = 0 이었다.

도입한 abstraction:

- `src/harness/harness-adapter.js` — HarnessAdapter 기반 클래스. C-1에 필요한 최소 contract는
  `runTurn(request) → { promise, cancel }` 하나이며, 기본 구현은 fail-closed로 오류를 던진다.
  startSession/resumeSession/invalidateSession/approve/health/shutdown 등 §10 장기 interface는
  아직 도입하지 않는다(세션 semantics 조기 도입 금지).
- `src/harness/process-harness-adapter.js` — ProcessHarnessAdapter. 기존 process-per-invocation
  실행(chat-agent-runner의 runAgentProcess)을 그대로 위임하는 compatibility 구현. runProcess는
  테스트 주입이 가능하지만 기본값은 실제 runAgentProcess다.

기존 process runner와의 compatibility 방식:

- CLI spawn source of truth는 여전히 chat-agent-runner 한 곳뿐이다(production logic 복제 없음).
- chat-ipc.js의 makeRunAgent는 확정된 실행 요청 객체를 그대로 `harnessAdapter.runTurn()`에
  전달하고 반환된 `{ promise, cancel }` handle을 변형 없이 사용한다.
- 어댑터는 요청의 권한/모델/effort/argv/promptTransport/fail-closed semantics를 재해석하거나
  바꾸지 않는다.

변경하지 않은 authority/invariant:

- ProjectStore.workspace > session.workspace: workspace authority는 makeRunAgent가 그대로 유지.
- permission 계산, canonicalWorkspace fail-closed, invocation 빌드는 control plane에 그대로 남음.
- Frozen Task / checkpoint / recovery / Evidence / RunMetrics 전달 경로 불변.
- Professional FSM 상태 전이 semantics 불변. 어댑터는 provider 이름을 policy로 알지 않는다.
- 새 fallback / 새 duplicate execution path 없음. fail-closed → fail-open 전환 없음.

테스트 결과:

- 신규 `test/harness-adapter.test.js` 6건 통과(기본 어댑터 fail-closed, 위임 identity,
  cancel 통과, 실제 프로세스 one-shot 실행 보존).
- 전체 로컬 테스트(node --test): 670 tests / 670 pass / 0 fail
  (기존 664 + 신규 6; Linux 실행 환경이라 Windows symlink EPERM skip 1건은 발생하지 않음).

최종 commit SHA:

```text
8bc4c34126c1f84f64286250bc723ff903cb2673
```

아직 구현하지 않은 Stage C 후속(이번 범위 밖):

- C-2 Role-scoped Harness Session Registry
- C-3 Codex App Server adapter
- C-4 Claude session/resume adapter
- C-5 AGY conversation/resume adapter
- C-6 same-turn approval
- C-7 runtime profile / child environment
- C-8 session invalidation / health / shutdown

---

### 2026-08-17 — Stage C-2: role-scoped harness session runtime

Role-scoped Harness Session Registry 기반을 추가했다. 실제 실행은 여전히 ProcessHarnessAdapter
one-shot이며(persistent provider 미연결), 성공 기준은 observable production execution behavior = 0.

도입한 구조:

- `src/harness/harness-session-key.js` — 순수 deriveSessionKey(context). SessionKey =
  projectId + workspaceId + professionalRunId + role + providerId + modelKey + permissionMode.
  model이 default/미해결이거나 identity 필드가 하나라도 없으면 null(→ sessionless).
  effort/frozenRunId/taskHash는 identity가 아니다.
- `src/harness/harness-session-registry.js` — memory-only registry. entry =
  {key, adapterId, generation, lifecycle(active|invalidated|retired), invalidationReason,
  inflight, createdAt, lastUsedAt}. invalidated/retired 재사용 금지(재획득 시 generation++),
  single-flight(tryBeginTurn/endTurn). disk 영속·health·nativeSessionId·fingerprint·writer
  lease·idle GC는 넣지 않았다.
- `src/harness/harness-runtime.js` — HarnessRuntime. { context, invocation }을 받아 provider별
  persistent-capable adapter를 선택(register)한다. persistent adapter가 없거나 key가 null이면
  sessionless ProcessHarnessAdapter 경로(registry 미사용). persistent 경로는 acquire +
  single-flight로 보호하고, 동시 turn은 SESSION_BUSY로 fail-closed한다.

adapter 계약 확장:

- HarnessAdapter: runTurn({context, invocation}) canonical + capability hook
  supportsPersistentSession(기본 false). ProcessHarnessAdapter는 false이고 invocation만
  runAgentProcess에 위임한다(flat 최소 호환 bridge 유지). CLI spawn source of truth는 여전히
  chat-agent-runner 한 곳.

chat-ipc 배선:

- makeRunAgent가 기존 authority(permission/workspace/invocation/prompt/Evidence 순서)를 그대로
  계산한 뒤 그 결과만 ExecutionContext로 모아 harnessRuntime.runTurn에 전달한다. workspaceId =
  realpath(project.workspace)로 identity만 계산(ProjectStore에 재저장하지 않음). professionalRunId
  = room.professionalRun.professionalRunId, role = specialistStage. seam은 backward-compatible:
  options.harnessRuntime 또는 options.harnessAdapter 주입 모두 허용.

유지한 authority/invariant:

- Requirements=Frozen Task, Execution=filesystem/Git, workspace=ProjectStore.workspace,
  permission=control plane, role context=ROLE_CONTEXT_POLICY. registry/adapter는 이 중 어떤
  authority도 갖지 않는다.
- Professional FSM(professional-run.js)은 registry/runtime을 모르며 변경하지 않았다.
- provider 이름 분기를 FSM/orchestration에 추가하지 않았다(등록은 HarnessRuntime 아래).
- Builder/Reviewer는 role이 SessionKey에 포함되어 persistent memory를 공유할 수 없다.
- general chat은 role=null → sessionless one-shot 유지. 새 fallback/fail-open 없음.

C-2에서 하지 않은 것(C-3+): provider-native 연결, resume/close/health, same-turn approval,
runtime/auth fingerprint, native session-not-found/crash recovery, Project Rules hash
invalidation, cross-restart resume, one-writer lease governance, general chat persistence.

테스트 결과:

- 신규: harness-session-key(10) · harness-session-registry(7) · harness-runtime(13) ·
  harness-adapter 계약 확장(7). 전체 로컬 테스트 701 tests / 701 pass / 0 fail.

최종 commit SHA:

```text
c85c1b94a505a10e01c51d6a0d1fa88ef76b93b9
```

---

### 2026-08-17 — Stage C-3: Codex Managed Runtime / App Server adapter

처음으로 provider-native persistent runtime(Codex App Server)을 Managed Harness Runtime에
연결했다. native persistence를 적용하는 provider는 Codex 하나뿐이며, general chat / Claude /
AGY / default-model Codex는 기존 ProcessHarnessAdapter one-shot을 그대로 유지한다.

Source of truth: 사용자 머신에 설치된 codex-cli 0.147.0의 `codex app-server` generated JSON
schema(app-server v2). recon 자료로 wire protocol을 확정한 뒤 구현했다(기억/문서 추측 아님).

확정한 protocol(설치 스키마 기준):

- envelope에 `jsonrpc` 필드 없음. request `{id,method,params}` / notification `{method,params}`
  / response `{id,result}` / error `{id,error}`. newline-delimited JSON.
- handshake: `initialize`(request) → result → `initialized`(notification) → READY.
  capabilities.experimentalApi는 켜지 않는다(stable surface만).
- `thread/start`(ephemeral:true) → `thread.id`. `turn/start`{threadId, input[], sandboxPolicy,
  approvalPolicy, cwd, model, effort} → `turn.id`. `turn/interrupt`{threadId, turnId}.
- 모든 turn notification(item/*, turn/*, error)이 threadId+turnId를 실어 정확한 turn 라우팅 가능.
- 최종 답변 = item/completed의 agentMessage.text(trusted final). TurnStatus:
  completed|interrupted|failed|inProgress.
- approval은 server→client request(item/commandExecution|fileChange|permissions/requestApproval,
  legacy execCommandApproval/applyPatchApproval). deny decision: command/fileChange=`cancel`,
  legacy=`abort`, permissions=`{}`.
- permission: turn/start.sandboxPolicy readOnly|workspaceWrite{writableRoots}|dangerFullAccess
  + approvalPolicy `never`. codexArgv/`codex exec --help` sandbox enum과 대조해 equivalent-or-
  more-restrictive임을 확인.

도입한 파일:

- `src/harness/codex/codex-app-server-client.js` — 하나의 long-lived `app-server --stdio` child.
  handshake, request-id correlation(out-of-order 처리), chunk 경계 독립, notification/
  server-request 라우팅, protocol desync fail-closed, unknown notification forward-compat,
  자동 restart 없음, close().
- `src/harness/codex/codex-app-server-events.js` — v2 notification→canonical event 정규화
  (chat-events builder 재사용), turn permission 매핑(pure, fail-closed), approval deny 매핑.
- `src/harness/codex/codex-managed-adapter.js` — logicalHandle(session.key#generation)→thread
  매핑. thread/start 1회, turn/start마다 현재 prompt 전체 재전송, threadId 라우팅(role leakage
  금지), canonical result(evidence/runMetrics 재사용), cancel=turn/interrupt, approval deny+
  approvalRequired(compat replay, replay-required thread 재사용 금지), session loss fail-closed.
- `src/harness/create-default-harness-runtime.js` — codex→CodexManagedAdapter 등록 조립.

기존 파일 변경(최소):

- chat-ipc: harnessRuntime을 createDefaultHarnessRuntime로 구성, effectiveAutoApprove 1회 계산
  후 context.autoApprove(turn-level; SessionKey 아님)와 native image metadata 전달, shutdown에서
  runtime.close(). authority 계산 순서는 그대로.
- harness-runtime: close() 추가(orphan child 정리). chat-events: commandStarted/commandFinished
  export(canonical event shape single-source 재사용).

유지한 authority/invariant:

- Requirements=Frozen Task, Execution=filesystem/Git, workspace=ProjectStore.workspace,
  permission=control plane, role context=ROLE_CONTEXT_POLICY, Evidence/RunMetrics schema 불변.
- SessionKey 계약 불변(autoApprove는 key 아님, turn마다 명시 전달).
- native thread memory는 cache: 매 turn 현재 authoritative prompt 전체를 다시 보낸다.
- provider-specific 코드는 src/harness/codex + composition에만. FSM/chat-ipc/specialist에
  provider 분기 없음. adapter는 argv를 reverse-parse하지 않는다.
- session loss/crash/desync → fail-closed(Process fallback 없음, 자동 restart 없음).

C-3에서 하지 않은 것(이후 Stage): same-turn approval(C-6), native resume/thread-list/
cross-restart, capability 기반 Case-A process fallback, runtime/auth fingerprint invalidation,
health monitoring/restart/backoff, one-writer lease governance, Verification Runner.

테스트 결과:

- 신규: codex-app-server-client(13) · codex-app-server-events(12) · codex-managed-adapter(21,
  role leakage / strict-final / command evidence / cancel race / approval deny+replay / session
  loss / permission / image / runtime selection 포함). fake app-server transport만 사용(네트워크/
  codex 계정 불필요).
- 전체 로컬 테스트: 751 tests / 751 pass / 0 fail.

검증 한계(sandbox): 이 세션은 클라우드 샌드박스라 설치된 codex를 직접 실행하지 못해, 실제
app-server에 대한 live smoke test는 수행하지 못했다. 프로토콜은 설치 schema로 확정했고 테스트는
fake transport로 검증했다. 실사용 전 로컬 live smoke(1 Codex professional turn) 권장.

최종 commit SHA:

```text
ae61eb33dfa529c175e02a06108ee7f617056599
```

---

### 2026-08-17 — Stage C-3 보정: Codex managed turn continuity 강화

독립 검수에서 발견된 3개 blocker를 C3 아키텍처 재설계 없이 수정했다(범위 확장/불필요 refactor 없음).

- BLOCKER 1 (turn event routing이 threadId만 검증): notification/server-request를 threadId뿐 아니라
  turnId까지 현재 active turn과 일치할 때만 수용한다. 이전 turn의 지연 delta/evidence/turn-completed/
  approval이 다음 turn에 유입되지 않는다(stale은 drop). authoritative turnId source(turn/start RPC
  응답, turn/started)가 서로 다른 id를 주장하면 protocol mismatch로 fail-closed한다. turnId 확보 전의
  정상 race(turn/started가 RPC 응답보다 먼저)는 지원한다.
- BLOCKER 2 (ambiguous mutating RPC 후에도 native continuity 신뢰): turn/start의 ambiguous
  timeout(CODEX_APP_SERVER_PROTOCOL_ERROR)과 turn/interrupt 실패/미전송을 구분해, 해당 logicalHandle을
  invalidated로 표시한다. 다음 turn은 손상된 native thread를 조용히 재사용하지 않고 fail-closed한다
  (Process fallback / 자동 restart / hidden fresh-thread 없음). 명시적 rpc error(서버가 turn을 시작
  하지 않고 거부)와 정상 interrupt 성공은 continuity를 유지한다. C7 health framework는 도입하지 않고
  이 patch에 필요한 최소 상태(_invalidatedHandles)만 추가했다. 특히 timeout/output-limit처럼 native completion 확인 없이
  로컬에서 강제 finalize하는 경우에는 interrupt 결과(성공/지연/실패/pending)와 무관하게 handle을
  즉시(synchronous) invalidate해, 다음 turn이 아직 살아있을 수 있는 native thread에 turn/start를
  먼저 보내는 race를 원천 차단한다(정상 사용자 cancel은 matching turn/completed(interrupted)로
  finalize하므로 thread 재사용 가능).
- BLOCKER 3 (model catalog probe handshake 미완성): probeCodexModelCatalog가 initialize 응답 후
  initialized notification을 먼저 보낸 뒤 model/list를 요청하도록 최소 수정했다(C3 client와 동일한
  handshake). 기존 timeout/cleanup/malformed fail-safe 성격은 유지. 테스트용 spawnFn 주입점만 추가.

유지: thread/start least-privilege baseline(read-only, approvalPolicy never) + turn/start override,
approval defensive deny + whole-turn replay, ProcessHarnessAdapter compatibility path, Professional FSM.
same-turn approval/resume(C-6)와 Claude/AGY resource는 이번 범위 밖이다.

테스트: 신규 codex-managed-continuity(9) · codex-model-probe(7). 전체 767 tests / 767 pass / 0 fail.

---

## 16. 새 Agent Harness 추가 시 규칙

새 하네스는 자신의 capability를 명시한다.

예:

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

새 하네스가 해야 하는 일:

1. capability 보고
2. canonical HarnessAdapter input을 자신의 protocol로 변환
3. output/event를 Agora canonical event로 정규화
4. session identifier를 adapter 내부에서 관리
5. approval/cancel/health 지원 범위를 명시

금지:

```text
if provider === "new-provider"
  Professional FSM 분기 추가
```

우선:

```text
HarnessAdapter
+ Capability Profile
+ Event Normalization
```

으로 해결한다.

---

## 17. 기능 변경 시 체크리스트

향후 변경 전 확인한다.

1. 이 기능은 control plane 정책인가, harness transport 기능인가?
2. provider 이름을 몰라도 구현 가능한가?
3. Role과 Agent를 다시 결합시키고 있지 않은가?
4. harness session memory를 authoritative state처럼 쓰고 있지 않은가?
5. Evidence schema를 깨뜨리지 않고 확장 가능한가?
6. Process Harness compatibility fallback이 가능한가?
7. workspace writer를 동시에 둘 이상 만들고 있지 않은가?
8. 실측 근거 없이 heuristic을 hard policy로 승격하고 있지 않은가?

가능하면 새 기능은 다음 중 하나에 명확히 속하게 한다.

```text
Control Plane
Adapter / Transport
Evidence / Verification
Metrics / Observability
UI
```

한 기능이 다섯 계층을 동시에 직접 건드린다면 경계가 잘못됐을 가능성이 높다.

---

## 18. 최종 목표 구조

Stage A~D가 끝난 뒤에는 Stage 이름보다 안정된 역할과 계약만 남아야 한다.

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

---

## 19. 문서 유지 규칙

이 문서는 큰 migration milestone마다 갱신한다.

반드시 기록할 변화:

- 새로운 Agent Harness 추가
- HarnessAdapter contract 변경
- Evidence schema 변경
- Professional FSM authority 변경
- approval policy 변경
- runtime/session persistence 변경
- hard safety policy 추가
- heuristic을 hard gate로 승격
- 대규모 성능 최적화 실측
- RunMetrics / Recorder / Summary Windowing처럼 migration 완료 상태 변경

코드가 무엇을 하는지는 테스트와 소스가 말해준다.

이 문서는 다음을 남기는 데 목적이 있다.

> **왜 그렇게 만들었는지, 현재 무엇이 authoritative한지, 무엇이 완료됐는지, 다음 사람이 무엇을 깨뜨리면 안 되는지, 그리고 다음 단계가 무엇인지.**

---

# Part V. 2026-08-18 Stage C 최신 진행

## 20. Claude role-scoped exact native session resume — COMPLETE

Claude managed adapter는 Agora turn마다 fresh CLI process를 사용하되 provider-native session continuity를 명시적으로 관리한다.

계약:

```text
first turn
  → native session_id capture

next turn
  → --resume <exact session_id>
```

`--continue`는 사용하지 않는다.

Resume turn에서도 현재 authoritative prompt 전체를 매번 다시 전달한다. 따라서 Claude native memory는 실행 비용과 continuity를 줄이는 cache일 뿐 Requirements truth가 아니다.

주요 기준 commit:

```text
c822a3f
feat(agora): resume role-scoped claude sessions
```

---

## 21. AGY role-scoped exact native conversation resume — COMPLETE

AGY도 Agora turn마다 fresh CLI process를 사용한다.

계약:

```text
first turn
  → conversation_id capture

next turn
  → --conversation <exact conversation_id>
```

`--continue` / `-c`는 사용하지 않는다.

주요 기준 commit:

```text
4f4b4ce
feat(agora): resume role-scoped agy conversations
```

### AGY invalid conversation fallback 방어

실제 AGY 특성상 invalid `--conversation A`를 줬을 때 provider가 실패하지 않고 warning 후 fresh conversation B를 만들고 prompt/tool 실행까지 이어간 뒤 exit code 0으로 끝날 수 있다.

따라서 Agora는 다음을 계약으로 고정했다.

```text
requested native id = A
observed native id  = B
A != B

→ streaming 중 best-effort cancel
→ final verdict = AGY_CONVERSATION_ID_MISMATCH
→ B adopt 금지
→ logical handle poison
→ 다음 동일 handle 실행 금지
```

주요 기준 commit:

```text
83eab16
fix(agora): abort agy resume turn on native conversation-id mismatch
```

Provider의 조용한 fresh fallback을 continuity success로 승격하지 않는 것이 핵심이다.

---

## 22. Codex same-turn approval — COMPLETE

Codex resident App Server에서 정상 command/file approval은 whole-turn replay를 하지 않고 **같은 native turn**에서 계속한다.

계약:

```text
Codex turn U
  → command/file approval server request
  → Agora 사용자 승인/거절
  → client.respond(requestId, accept/decline)
  → SAME thread
  → SAME turn U 계속
```

정상 approval 때문에 다음을 하지 않는다.

- interrupt
- 새 turn/start
- whole-turn replay
- danger-mode retry

command/file normal approve는 one action only이며 `acceptForSession`을 사용하지 않는다.

permissions granular request는 boolean approve UI로 전체 grant하지 않고 fail-closed한다.

주요 기준 commits:

```text
52b8804
feat(agora): continue codex turns after approval

d8cc2d8
fix(agora): dismiss pending approvals when stopping turns
```

`d8cc2d8`까지 Codex Same-turn Approval은 별도 actual-diff review에서 FINAL PASS를 받았다.

---

## 23. AGY 1.1.14 parser compatibility — PASS

AGY CLI 업데이트 점검 중 기존 Agora parser와 실제 structured output 사이의 불일치를 확인했다.

표현은 다음으로 제한한다.

> **AGY 1.1.14 실출력에서 관찰**

AGY changelog에 stream-json schema change가 명시된 것은 아니므로 "1.1.14에서 schema가 바뀌었다"고 단정하지 않는다.

실제 관찰된 형태:

```text
init:
  top-level conversation_id

step_update:
  step_update.conversation_id

result:
  result.conversation_id

agent streaming:
  step_type = agent_response
  text_delta = live text

tool start:
  state = ACTIVE

tool completion:
  state = DONE

shell command:
  tool_info.parameters.CommandLine

tool id:
  id / step_id가 없을 수 있음
  step_index 사용 가능
```

반영된 parser 계약:

- `agent_response.text_delta` → `delta`
- toolUseId fallback: `step.id || step.step_id || String(step.step_index)`
- command: `step.command || tool_info.parameters.CommandLine || tool name`
- `ACTIVE` → start
- `DONE / COMPLETED / SUCCESS` → completion
- toolStarted input에 `tool_info.parameters` 포함
- native conversation ID extraction은 `init / step_update / result` 세 위치만 명시적으로 읽음
- arbitrary recursive native-id search 금지

### Evidence truth 보정

독립 검수에서 `DONE`인데 실제 exit code가 없는 경우 parser가 `exitCode: 0`을 합성해 `OBSERVED`로 기록하는 문제를 발견했다.

최종 계약:

```text
exitCode:
  step.exit_code
  ?? step.exitCode
  ?? null
```

따라서:

```text
DONE + explicit exit code 없음
  → exitCode = null
  → executionStatus = PARTIAL

DONE + explicit exit_code: 0
  → exitCode = 0
  → executionStatus = OBSERVED
```

Provider lifecycle state `DONE`과 실제 process exit code 0 관측을 구분한다.

### result fail-closed 순서

`result.status`가 존재하고 `SUCCESS`가 아니면 `response`가 있어도 final로 승격하지 않는다.

```text
status = ERROR
response = "..."

→ error
→ final 아님
```

### fixture contract test

`test/agy-stream-json-contract.test.js`는 실제 AGY 1.1.14 샘플을 재구성한 fixture contract test다.

검증 항목:

- DONE + no exit code → PARTIAL
- DONE + explicit exit_code:0 → OBSERVED
- ERROR + response → error
- text_delta 3조각 순서 보존
- init / step_update / result conversation_id capture

이 테스트는 live CLI smoke test는 아니다. 향후 optional `npm run smoke:agy` 같은 별도 live smoke는 가능하지만 canonical `npm test` blocker는 아니다.

### 실제 원격 검수

`d8cc2d8` 이후 parser 작업의 원격 누적 diff는 2 commits ahead / 0 behind였고 변경 파일은 다음 두 개뿐이었다.

```text
src/chat/chat-events.js
test/agy-stream-json-contract.test.js
```

최종 검증 코드 baseline:

```text
fba6011d46b621348d074b36df76da0c5cdd8aec
```

최종 commit message:

```text
20260818_10:10
```

원격 actual source/diff 독립 검수 결과:

```text
PASS
FIX REQUIRED: 없음
SHOULD FIX: 없음
```

---

## 24. Windows 전체 회귀 테스트 — GREEN

`fba6011d46b621348d074b36df76da0c5cdd8aec` 코드 baseline에 대해 사용자 Windows 실제 로컬 `D:\Projects\Agora`에서 canonical `npm test`를 실행했다.

사용자 로컬 실측:

```text
tests      889
suites     0
pass       887
fail       0
cancelled  0
skipped    2
todo       0
duration_ms 33620.4682
```

따라서 현재 기준:

```text
AGY parser actual-diff review  PASS
Windows full npm test          GREEN
fail                           0
```

이 테스트 결과는 사용자 Windows 로컬 실행 결과이며, 외부 에이전트 자기보고와 구분한다.

---

## 25. 현재 Stage C 상태와 다음 작업

현재 Stage C에서 완료된 주요 축:

```text
HarnessAdapter                         COMPLETE
Role-scoped HarnessSessionRegistry     COMPLETE
Codex resident App Server runtime      COMPLETE
Claude exact native session resume     COMPLETE
AGY exact native conversation resume   COMPLETE
AGY mismatch poison/fail-closed        COMPLETE
Codex same-turn approval               COMPLETE
Codex pending approval cancellation    COMPLETE
AGY 1.1.14 parser compatibility        PASS
```

현재 SessionKey 계약은 변경하지 않는다.

```text
SessionKey =
  projectId
  + workspaceId
  + professionalRunId
  + role
  + providerId
  + modelKey
  + permissionMode
```

다음은 SessionKey가 아니다.

```text
effort
autoApprove
taskHash
```

Registry는 memory-only이며:

```text
ACTIVE
INVALIDATED
RETIRED
```

lifecycle과 generation을 갖는다. retired/invalidated key가 다시 acquire되면 generation이 증가한다.

### NEXT — Session Invalidation / Lifecycle

Stage C의 마지막 본 작업이다.

핵심 목표:

> **Native session memory는 cache only다. authority/environment 변화 뒤 과거 native session이 다시 살아나면 안 된다.**

특히 다음 switch-back을 막는다.

```text
model A
  → model B
  → model A

old A native session 재사용 금지
```

주요 lifecycle trigger:

- model change → sibling sessions RETIRE
- permission change → sibling sessions RETIRE
- Frozen Task taskHash change → same Professional Run 전체 old role sessions RETIRE
- Git HEAD change → run-wide old sessions RETIRE
- ordinary working-tree edit only → 자동 retire 금지
- successful checkpoint restore → explicit INVALIDATE
- project workspace change → project sessions RETIRE
- successful provider account change → provider-wide INVALIDATE
- Codex account change → logical sessions INVALIDATE + resident App Server deliberate reset
- Professional Run end → run entries RETIRE
- effort change → lifecycle trigger 아님
- autoApprove change → lifecycle trigger 아님

Lifecycle replacement 중 old entry가 inflight이면 새 generation을 병렬로 시작하지 않고 fail-closed해야 한다. Stage D의 global one-writer governance 전체를 이번 작업에 끌어오지는 않는다.

Stage C Session Lifecycle이 구현되고 별도 actual-diff review를 PASS하면 Stage C — Managed Harness Runtime 종료를 판단한다.

그 다음은 Stage D:

```text
Verification Runner
workspace one-writer governance
run-scoped execution capabilities
verified evidence provenance
governance / audit
```

Stage D를 Stage C lifecycle 구현에 섞지 않는다.
