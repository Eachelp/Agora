# Agora Stage C — Final Independent Review

> 판정: **FINAL PASS**
> 독립 검수일: 2026-08-20
> 검수 대상 feature branch: `claude/agora-stage-c-session-lifecycle-2h7hlf`
> 검수 대상 HEAD: `882ac8ae2ad274635d7568e7cb2bbd1502d24da5`
> 핵심 코드 baseline: `27d9de533ccf65670590166489858759b50e5495`
> 관련 결정 기록: [AGORA_STAGE_C_SESSION_LIFECYCLE_DECISIONS.md](AGORA_STAGE_C_SESSION_LIFECYCLE_DECISIONS.md)

이 문서는 Stage C Session Invalidation / Lifecycle의 마지막 actual-remote 독립 검수 결과를 기록한다.

코드와 원격 diff를 직접 확인한 결과, Stage C에서 merge를 막던 account-lifecycle blocker는 모두 닫힌 것으로 판정한다.

## 최종 확인 항목

```text
Account-aware namespace 제거               PASS
hsk1 / 7-field SessionKey                 PASS
providerAccountKey 재도입 없음             PASS
A→B→A old native resume 제거              PASS
Provider-wide ACTIVE invalidation          PASS
Non-ACTIVE inflight settle barrier         PASS
Old inflight actual-settle before mutation PASS
Hard-boundary failure fail-closed          PASS
Account-switch transaction admission gate  PASS
Same-provider concurrent switch fail-closed PASS
Stale transition token protection          PASS
Post-boundary fresh native continuity       PASS
Agora-owned context architecture            PASS (direction)
```

## Account-switch transaction 최종 계약

Managed Professional provider account 전환은 다음 의미를 가진다.

```text
BEGIN TRANSITION
  → provider managed admission CLOSED
  → old managed native sessions INVALIDATE
  → pre-boundary inflight turns cancel
  → actual settle까지 대기
  → credential mutation
  → provider restart/reload 필요 시 수행
  → 전환 성공/실패 확정
END TRANSITION
  → provider managed admission OPEN
```

전환 중 새 managed Professional turn은 `HARNESS_SESSION_LIFECYCLE_BUSY`로 차단된다. old turn settle 이후 credential mutation/restart 전 구간도 포함한다.

전환 소유권은 provider-scoped token으로 관리한다. stale completion은 더 새 전환을 해제할 수 없고, 같은 provider의 두 번째 동시 전환은 credential mutation 전에 fail-closed한다.

## Provider-native memory 원칙

Provider-native session은 authority가 아니라 disposable execution cache다.

```text
Requirements truth = Frozen Task
Execution truth    = actual filesystem / Git
Workflow continuity = Agora Professional FSM / persisted run state
Review truth       = Actual Diff + Evidence + Reviewer verdict
Native session     = cache only
```

계정 전환 자체가 새 native session을 만들지는 않는다. 전환 완료 후 다음 실제 Professional invocation이 fresh native session을 만든다. A→B→A로 돌아와도 old A native session은 revive하지 않는다.

## Claude external login 특수 경로

Claude `auth login`은 외부 터미널에서 진행되며 Agora가 실제 로그인 완료 시점을 신뢰성 있게 관측하지 못한다.

현재 구현은 launcher가 성공적으로 열린 뒤 account-transition gate를 해제한다. 이 예외는 Stage C merge blocker로 보지 않는다.

이유:

- launcher 실행 전에 기존 Claude managed native sessions는 이미 hard boundary로 invalidate된다.
- saved-profile A→B quota switching 경로와 달리, external login은 interactive setup/login 경로다.
- 관측 불가능한 외부 프로세스 전체 수명 동안 gate를 유지하면 provider가 무기한 잠길 수 있다.

운영상 external login이 진행 중일 때 새 Professional 실행을 시작하지 않는 것이 안전하다. 향후 로그인 완료를 신뢰성 있게 관측할 수 있는 명시적 completion signal을 도입한다면 이 특수 경로를 더 강하게 닫을 수 있으나 Stage C 완료 조건은 아니다.

## 남은 비차단 후속 항목

다음은 Stage C merge blocker가 아니다.

- general chat / sessionless one-shot 실행은 managed account boundary 밖이다.
- Codex settle은 adapter turn/client settlement 기준이며 App Server OS child exit까지의 별도 증명은 아니다.
- `killTree`의 pre-existing re-kill no-op은 bounded settle timeout이 무한 대기를 방지한다.
- context rehydration은 현재 구조/recon상 Agora-owned state를 사용하지만 독립 end-to-end 증명은 후속 과제다.

이 항목들을 이유로 Stage C account lifecycle을 다시 확장하지 않는다. Stage D writer governance / Verification Runner / broader governance와 분리한다.

## 테스트 증거의 범위

작업 에이전트 보고 기준 최종 로컬 suite:

```text
tests    1011
pass     1011
fail        0
skipped     0
exit code   0
```

원격 actual source와 회귀 테스트 코드는 독립 검수했다. 다만 이 HEAD에 연결된 GitHub status check는 조회 시점에 없었으므로, 위 1011/1011은 CI 독립 재실행 결과가 아니라 작업 에이전트의 로컬 실행 보고다.

## 최종 판정

```text
Stage C Session Invalidation / Lifecycle   FINAL PASS
Stage C Managed Harness Runtime            MERGE READY
Stage D                                    NOT STARTED
```

`feat/multi-harness-runtime`가 feature branch보다 behind가 없고 fast-forward 가능한 상태라면, 이 검수 이후 해당 통합 브랜치로 fast-forward merge한다.
