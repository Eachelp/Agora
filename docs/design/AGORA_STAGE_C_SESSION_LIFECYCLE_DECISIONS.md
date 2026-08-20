# Agora Stage C — Session Lifecycle Decision Log

> 상태: **FINAL REVIEW PENDING**
> 최초 기록: 2026-08-19
> 기준 브랜치: `claude/agora-stage-c-session-lifecycle-2h7hlf`
> 현재 검수 baseline: `42f27ef` (이전 baseline `d06495ae4777f4e8c2a78ab7e63ad282bd5991f8`)
> 상위 개발일지: [AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md](AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md)

이 문서는 Stage C의 Session Invalidation / Lifecycle 작업에서 확정된 **아키텍처 결정, 버린 대안, 현재 안전 계약, 남은 검수 blocker**를 기록한다.

코드 세부 변경은 Git history와 테스트가 source of truth다. 이 문서는 왜 그렇게 설계했는지와 다음 사람이 무엇을 다시 뒤집으면 안 되는지를 남긴다.

---

## 1. 가장 중요한 아키텍처 원칙

Agora가 Professional workflow의 전체 맥락과 권한을 소유한다.

```text
Requirements truth
  = Frozen Task

Execution truth
  = actual filesystem / Git

Workflow state
  = Agora Professional FSM / persisted run state

Review truth
  = Actual Diff + Evidence + Reviewer verdict

Provider-native session memory
  = disposable execution cache

Model self-report
  = lowest trust
```

Claude `session_id`, AGY `conversation_id`, Codex thread는 편의를 위한 cache다. 이 native memory가 없어져도 Professional Run의 correctness가 깨지면 안 된다.

Agora는 여러 CLI/provider를 오케스트레이션하므로 특정 provider transcript를 전체 작업 기억의 authority로 사용하지 않는다.

---

## 2. 실제 계정 전환 사용 목적

다중 계정의 주된 사용 목적은 다음과 같다.

```text
Account A 한도 소진
  → Account B로 전환
  → 같은 Professional Run 계속
```

목표는 계정별 대화 기억을 보존하는 것이 아니다.

따라서 다음 semantics는 필요하지 않다.

```text
A native session
  → B native session
  → A로 복귀
  → old A native session resume
```

최종 제품 계약은 다음이다.

```text
A native session
  → account boundary
  → A native continuity 폐기

Account B 선택
  → 이 시점에는 새 native session을 자동 생성하지 않음

다음 Professional invocation
  → B 환경에서 fresh native session 생성

다시 A로 전환
  → B native continuity 폐기
  → 다음 invocation에서 A fresh native session 생성
```

즉 **계정 변경이 새 세션을 만드는 것이 아니라, 기존 native continuity를 끊고 다음 실행을 fresh로 강제한다.**

---

## 3. 버린 설계: account-aware parked session namespace

중간 구현에서는 다음 방향을 검토/구현했다.

```text
providerAccountKey
hsk2 SessionKey
Account A/B 별도 namespace
parked session
A → B → A old A native resume
```

대표 중간 commit:

```text
43337a8
refactor(agora): account change as session-selection boundary, not provider-wide destruction
```

이 방향은 기능적으로 가능하지만 Agora의 실제 사용 목적에 비해 복잡도가 높고, 다음 문제를 추가한다.

- account identity를 얼마나 강하게 식별할지
- credential fingerprint / profile matching 안전성
- stale async account-resolution race
- account별 lineage / parked session 관리
- provider마다 다른 switch-back resume semantics

결론:

> **계정별 native-session 보존보다 provider-wide hard session boundary가 Agora에 더 적합하다.**

따라서 `providerAccountKey`, account resolver, parked A/B sessions, A→B→A old-session resume는 최종 계약에서 제거했다.

---

## 4. SessionKey 최종 계약

현재 SessionKey는 다시 `hsk1` 7개 identity field를 사용한다.

```text
projectId
workspaceId
professionalRunId
role
providerId
modelKey
permissionMode
```

다음은 SessionKey identity가 아니다.

```text
effort
autoApprove
taskHash
provider account identity
```

계정 변경은 SessionKey에 account namespace를 추가해서 분리하지 않는다.

대신 lifecycle event로 기존 provider managed sessions를 폐기한다.

---

## 5. Provider account change = hard native session boundary

계정 변경 시 최종 의미는 다음과 같다.

```text
provider account boundary
  → 해당 provider의 ACTIVE managed sessions INVALIDATE
  → native binding forget
  → resident runtime reset이 필요한 provider는 deliberate reset
  → old native session resume 금지
```

Provider별 의미:

### Claude

- 기존 `session_id` binding 폐기
- 다음 Professional invocation은 `--resume <old-id>` 없이 시작
- 같은 계정으로 되돌아와도 old pre-switch session resume 금지

### AGY

- 기존 `conversation_id` binding 폐기
- 다음 invocation은 `--conversation <old-id>` 없이 fresh conversation
- switch-back 시 old conversation 복원 금지

### Codex

- managed logical session invalidate
- resident App Server deliberate reset
- 다음 invocation은 fresh server/thread
- cross-account / switch-back native thread restoration 금지

---

## 6. Inflight settle barrier

계정 전환 경계에서 이미 실행 중이던 old provider work는 단순 lifecycle flag만 바꾸고 끝내면 안 된다.

현재 확정한 규칙:

```text
old provider turn inflight
  → boundary
  → best-effort cancel
  → settle barrier
  → old turn 실제 settle 전까지 새 managed turn BUSY
```

중요:

- barrier 대상은 ACTIVE만이 아니다.
- 다른 lifecycle event 때문에 이미 `RETIRED` / `INVALIDATED` 상태여도 실제로 `inflight`라면 old credential era의 실행으로 본다.
- 기존 RETIRED/INVALIDATED reason은 덮어쓰지 않아도 된다.
- barrier 동안 `HARNESS_SESSION_LIFECYCLE_BUSY`.
- blocked attempt는 adapter execution / Evidence / RunMetrics를 만들지 않는다.

`d06495a`에서 non-ACTIVE inflight도 barrier에 포함하도록 보정했다.

---

## 7. Agora-owned context / fresh-session rehydration 원칙

Fresh native session의 단점은 provider transcript memory를 잃는 것이다.

Agora는 이를 provider transcript persistence로 보완하지 않는다.

의도한 구조:

```text
Agora authoritative state
  → role-specific current prompt/context
  → disposable provider-native session
  → CLI execution
```

Professional continuity에 필요한 핵심 정보는 Agora가 관리해야 한다.

예:

- Professional FSM / stage
- Frozen Task
- Project Rules / role policy에 따라 허용된 context
- canonical workspace
- Git HEAD / freshness facts
- Actual Diff
- Evidence
- Reviewer feedback / verdict
- recovery/checkpoint state

Claude managed adapter는 resume turn이어도 authoritative prompt 전체를 매 turn 다시 전달하는 방향을 이미 따른다.

현재 recon에서는 Professional FSM이 native session ID / transcript를 workflow state 복구의 authority로 읽는 경로는 확인되지 않았다.

다만 다음 문장은 아직 독립적인 end-to-end rehydration 테스트로 증명된 것은 아니다.

> "native session을 버려도 모든 role이 필요한 맥락을 항상 완전하게 재구성한다."

따라서 이것은 account lifecycle의 merge blocker와 분리된 후속 검수 항목으로 유지한다.

---

## 8. 주요 forward commits

### `b9ef355`

Session lifecycle boundary 관련 초기 보정.

보존 가치가 있는 핵심:

- legacy workspace IPC lifecycle notification
- AGY `prepareLogin` accountSwitchSafe semantics
- Claude external auth-login lifecycle boundary
- Frozen Task / Git freshness known↔unknown 상태 보정

### `43337a8`

계정별 parked-session / account namespace 방향으로 전환했던 중간 설계.

최종 정책에서는 핵심 account-aware namespace 설계를 채택하지 않음.

### `e64f956`

```text
refactor(agora): make account switches hard session boundaries
```

핵심:

- `providerAccountKey` 제거
- SessionKey `hsk1` 복원
- account resolver / fingerprint Harness identity 제거
- provider-wide ACTIVE INVALIDATE
- A→B→A old native resume 제거

### `d06495a`

```text
fix(agora): install hard session boundary before credential mutation, barrier all inflight
```

핵심:

- credential mutation 이전 boundary 호출 방향
- 이미 RETIRED/INVALIDATED지만 inflight인 entry도 settle barrier 포함
- account namespace 관련 stale wording 정리

에이전트 보고 기준 full suite는 `979/979 pass`였으나, merge 판정은 self-report가 아니라 actual remote diff 검수를 우선한다.

---

### `42f27ef`

```text
fix(agora): wait for old provider work to settle before credential mutation, fail closed
```

§9-3에 기록된 BLOCKER A / BLOCKER B를 닫은 커밋이다. 상세는 §9-1을 본다.

---

## 9-1. `42f27ef`에서 닫은 blocker

### BLOCKER A 해소 — settle-before-mutation 강제

`HarnessRuntime`에 명시적 awaitable seam을 추가했다.

```text
installProviderAccountBoundary({ providerId })
  → providerAccountChanged() 동기 실행
      (INVALIDATE + native forget + best-effort cancel
       + settle barrier + resident runtime reset)
  → _awaitProviderSettled(providerId)
      (pre-boundary inflight turn이 물리적으로 settle될 때까지 대기)
  → resolve
```

settle 신호는 turn 단위로 추적한다(`_activeTurnSettles`). `runTurn`이 turn promise를
감싼 뒤 그 promise가 settle될 때만 신호가 resolve되므로, `cancel()` 반환 시점이 아니라
**실제 종료 시점**을 기다린다. 실패로 끝난 turn도 "끝났다"는 사실은 같으므로 동일하게
settle로 인정한다.

credential을 바꾸는 모든 경로가 이 seam을 await한 뒤에만 mutation으로 넘어간다.

```text
Claude/AGY switchToProfile
AGY prepareLogin (clear + restart)
Claude 외부 login script 실행
Codex proxy 경로 switchToProfile
Codex desktop 경로 switchToProfile
Codex proxy 한도 auto-rotation의 활성 프로필 영속화
```

대기에는 상한이 있다(`ACCOUNT_SETTLE_TIMEOUT_MS`, 생성자에서 주입 가능). 상한을
넘기면 "old 실행 종료를 증명하지 못했다"로 보고 **reject**하며, 호출자는 credential을
바꾸지 않는다. 이것은 조율용 sleep이나 polling 간격이 아니라 증명 실패 판정선이다.
SIGTERM을 무시하는 CLI나 이미 `killed`로 표시돼 재-kill이 no-op이 되는 child 때문에
UI handler가 영원히 매달리는 것을 막는다.

### BLOCKER B 해소 — hard boundary fail-closed

lifecycle seam이 더 이상 예외를 삼키지 않는다.

```text
boundary 설치/대기 성공        → credential mutation 허용
boundary 설치/대기 실패        → 예외 전파 → credential mutation 금지
chat feature 자체가 없음        → 명시적 immediately-safe 성공
chat feature는 있는데 seam 없음 → wiring 결함 → fail-closed
```

마지막 항목이 중요하다. seam이 없는 feature를 "managed runtime 없음"으로 오분류해
통과시키면 그것이 곧 fail-open이므로, 명시적으로 실패시킨다.

boundary 실패 오류에는 `accountSwitchSafe = true`가 붙는다. boundary 실패 시점에는
credential을 아직 건드리지 않았다는 fact다.

Codex 한도 auto-rotation은 활성 프로필 영속화가 실패하면 더 이상 "전환 완료"라고
보고하지 않는다(프록시 중계 중 사실만 알리고 저장 실패를 함께 표시한다).

### 이 커밋에서 의도적으로 넓히지 않은 것

- settle barrier는 여전히 settle 시점에 풀리며 mutation 구간 전체를 잠그지 않는다.
- one-shot / general chat turn은 여전히 managed session boundary 밖이다.

둘 다 확대하면 §12-9가 금지한 Stage D writer governance가 된다. 대신 §9-2에
후속 검수 항목으로 남긴다.

### 테스트

```text
997 pass / 0 fail / 0 skipped / exit 0
```

---

## 9-2. Session Lifecycle과 분리해 남기는 후속 검수 항목

merge blocker가 아니라, Stage C 범위 밖으로 의도적으로 남긴 것들이다.

1. **mutation 구간 admission** — boundary가 settle되면 barrier가 풀리므로, credential
   mutation이 진행되는 동안 새 managed turn이 시작될 수 있다. 그 turn은 old credential로
   시작해 mutation 이후까지 살아 있을 수 있다. 비용은 한 turn의 계정 귀속/연속성이며
   §10의 disposable cache 모델에서 correctness blocker가 아니다. 닫으려면 Stage D
   writer governance가 필요하다.
2. **one-shot 실행 범위** — general chat과 default/unresolved model 실행은 registry를
   거치지 않으므로 boundary가 cancel/대기/차단하지 않는다. 현재 계약(§5)은 managed
   native session 경계이지 프로세스 수명 잠금이 아니다.
3. **물리적 종료의 깊이** — settle 신호는 adapter turn promise의 종료다. Claude/AGY는
   child `close`(실제 프로세스 종료), Codex는 client close 기반이다. App Server child의
   실제 exit까지 기다리지는 않는다.
4. **동시 전환 상호배제** — 같은 provider에 대한 동시 계정 전환은 상호배제되지 않는다.
   Stage D 항목이다.
5. **`killTree` 재-kill no-op** — `child.killed`가 이미 true면 `killTree`가 조기 반환한다
   (`src/chat/chat-agent-runner.js`). 이 커밋 이전부터 있던 동작이며, 위 settle 상한이
   이로 인한 무한 대기를 막는다.
6. **context rehydration end-to-end 증명** — §7의 결론은 recon 기준이며 독립적인
   end-to-end 테스트로 증명된 것은 아니다. 이 작업에서 재설계하지 않는다.

---

## 9-3. 원래 기록된 blocker 원문 (이력)

> 아래는 `d06495a` 검수 시점의 기록이며 현재 코드 상태가 아니다. 두 blocker는
> `42f27ef`에서 닫혔다(§9-1). 무엇이 왜 문제였는지 남기기 위해 보존한다.

`d06495a` actual remote review 기준, 전체 방향은 맞지만 아직 merge HOLD다.

### BLOCKER A — boundary 설치 후 old inflight가 실제 settle되기 전에 credential mutation 가능

현재 의미는 대략 다음과 같다.

```text
notifyAccountLifecycle()
  → invalidate
  → cancel
  → settle barrier 설치

즉시
  → switchToProfile / clear / credential write
```

settle barrier는 **새 Professional managed turn**을 막지만 account mutation 자체가 old turn settle을 기다리는 것은 아니다.

`cancel()` / process kill은 실제 child close보다 먼저 반환할 수 있다.

따라서 잠깐 다음 상태가 가능하다.

```text
old Account A CLI 아직 물리적으로 alive
+
live credential은 이미 Account B
```

최종 hard-boundary 의미를 만족하려면:

```text
boundary 설치
→ old pre-boundary inflight cancel
→ 실제 settle 완료 대기
→ 그 다음 credential mutation
```

이어야 한다.

### BLOCKER B — hard boundary seam 실패가 fail-open

현재 lifecycle notification seam이 예외를 log만 하고 삼키는 경로가 있다.

hard safety boundary로 정의된 이상:

```text
boundary 설치 성공
  → credential mutation 허용

boundary 설치 실패
  → credential mutation 금지
```

여야 한다.

managed runtime이 실제로 없는 경우는 명시적인 immediately-safe 결과로 표현할 수 있지만, 예외/실패를 성공처럼 처리하면 안 된다.

---

## 10. 현재 non-blocking 정책 선택

현재 구현은 target profile 검증이 나중에 실패해도 boundary가 이미 설치되어 native session이 폐기될 수 있는 보수적 동작을 한다.

예:

```text
잘못된/만료된 계정 선택
→ credential은 실제로 안 바뀜
→ 기존 native session은 이미 invalidated
→ 다음 turn fresh
```

이것은 native memory를 disposable cache로 보는 현재 원칙에서는 correctness blocker가 아니다.

비용은 continuity/token 효율 손실이다.

현재 Stage C에서는 이 보수적 false-positive invalidation을 허용하고, 안전 경계를 위해 scope를 넓히지 않는 쪽을 우선한다.

---

## 11. 현재 merge 판정

`42f27ef` 기준 자체 검증 결과다. merge 판정은 self-report가 아니라 actual remote
diff 검수를 우선한다.

```text
Account-aware namespace 제거              PASS
hsk1 / 7-field SessionKey                PASS
A→B→A old native resume 제거             PASS
Provider-wide ACTIVE invalidation         PASS
Non-ACTIVE inflight settle barrier        PASS
Agora-owned context architecture          PASS (direction)
Wait-for-actual-settle before mutation    구현 완료 (42f27ef) — 검수 대기
Hard-boundary failure fail-closed         구현 완료 (42f27ef) — 검수 대기

MERGE                                    FINAL REVIEW PENDING
```

Stage D를 이 작업에 섞지 않는다.

두 blocker의 구현이 actual remote diff review에서 확인되면 Session Lifecycle 자체의 FINAL PASS와 `feat/multi-harness-runtime` fast-forward merge 여부를 판단한다. §9-2의 후속 항목은 이 판정과 분리한다.

---

## 12. Stage C 이후에도 깨뜨리면 안 되는 결정

1. Provider-native session은 authority가 아니다.
2. 계정별 native session 복원을 다시 도입하지 않는다. 명확한 새 제품 요구가 생긴 경우만 재검토한다.
3. 계정 변경은 hard native session boundary다.
4. 계정 변경 자체가 새 native session을 생성하지 않는다.
5. 다음 Professional invocation이 fresh native session을 만든다.
6. A→B→A switch-back이 old A native session을 revive하면 안 된다.
7. Professional continuity는 Agora-owned state에서 재구성되어야 한다.
8. Frozen Task / actual Git / Evidence가 provider transcript보다 상위 authority다.
9. Stage C account settle barrier를 Stage D global writer-governance로 확대하지 않는다.
10. lifecycle safety failure를 silent fail-open으로 약화하지 않는다.
