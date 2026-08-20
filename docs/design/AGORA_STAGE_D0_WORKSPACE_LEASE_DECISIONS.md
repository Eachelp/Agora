# Agora Stage D-0 — Workspace Mutation Lease Decision Log

> 상태: **구현 완료 · 독립 검수 대기**
> 최초 기록: 2026-08-20
> 기준 브랜치: `feat/stage-d0-workspace-lease`
> 상위 기준 문서: [AGORA_STAGE_D_ASSURANCE_CHARTER.md](AGORA_STAGE_D_ASSURANCE_CHARTER.md) (v0.4, D-0 절)
> 직전 baseline: Stage C COMPLETE `048dca0`

이 문서는 D-0에서 확정된 **아키텍처 결정, 버린 대안, 보증 경계, 의도적으로 하지 않은 것**을 결정 시점에 기록한다(Charter §6 DoD 4).

코드 세부는 Git history와 테스트가 source of truth다. 여기에는 왜 그렇게 했는지와 다음 사람이 무엇을 뒤집으면 안 되는지를 남긴다.

---

## 1. 무엇을 고쳤나 — 실재하던 데이터 유실 경로

D-0은 새 기능이 아니라 **이미 존재하던 버그를 닫는 작업**이다.

```text
project 1개  =  canonical workspace 1개
                     ↓
            그 아래 세션(room)은 N개
                     ↓
   동시성 가드는 room 단위 activeRuns 뿐이었다
```

즉 같은 프로젝트의 두 대화에서 전문 실행을 동시에 시작하는 것을 막는 장치가 없었다. 그리고 이것은 단순한 동시 쓰기 충돌보다 나쁘다 — `turn-checkpoint`의 restore는 workspace root 전체를 되돌리므로, A 대화가 중단되어 복원이 돌면 **그 사이 B 대화가 만든 변경까지 함께 사라진다.** 사용자에게는 "이유 없이 작업이 날아갔다"로 보인다.

---

## 2. 확정된 계약

### 2.1 Git lock이 아니라 canonical workspace identity lock

Git이 없는 workspace(비코딩 과업 포함)도 동일하게 보호한다. Charter의 `NO Git-as-core-authority`와 일치한다.

경로 표기가 달라도 같은 폴더면 같은 자원으로 접는다. 접지 않으면 one-writer 보증이 표기 차이만으로 뚫린다.

```text
path.resolve 정규화
+ win32 대소문자 접기
→ 후행 구분자 / 상대 경로 조각 / 대소문자 우회 불가
```

### 2.2 충돌은 fail-closed다 — 대기열도 강탈도 없다

BUSY를 돌려주고 끝낸다. 큐잉을 넣지 않은 이유: 큐는 "언젠가 실행된다"는 약속인데, 그 사이 Frozen Task·workspace·사용자 의도가 이미 달라져 있을 수 있다. 재시도는 사용자의 결정이어야 한다.

### 2.3 재진입은 holder 단위로 허용한다

holder는 `sessionId`(room)다. 전문 실행이 소유권을 쥔 채 내부에서 checkpoint restore를 호출하는 것은 **정상 경로**이며, 여기서 교착되면 안 된다.

room 안의 turn은 `pumpTurnQueue`의 `turnActive`로 이미 직렬화되어 있으므로, holder=session 재진입이 같은 방 안의 동시 writer를 허용하는 결과로 이어지지 않는다. (이 사실이 깨지면 재진입 범위를 좁혀야 한다.)

### 2.4 참여자는 셋이다

```text
1. Professional 실행의 mutation~판정 구간   (블록 전체)
2. Checkpoint restore                      (사용자 트리거 경로)
3. workspace-write 일반 채팅 turn           (turn 단위)
```

**전문 실행을 turn 단위가 아니라 블록 전체로 잡은 이유**: turn 단위면 Builder와 Reviewer 사이의 틈으로 다른 대화의 변경이 끼어들 수 있고, 그러면 Reviewer가 보는 변경과 실제 workspace가 어긋난다. 이 구간은 D-A에서 verification 실행까지 자연스럽게 확장된다.

`workspace-read` / `chat` 실행은 참여자가 아니다. 읽기는 서로 막지 않는다.

### 2.5 memory-only이며 보증 경계가 있다

```text
보증 범위: 하나의 Agora main process 안에서
           동일 canonical workspace를 공유하는 실행들
```

이 경계는 `main.js`의 `requestSingleInstanceLock`이 뒷받침한다. 앱이 죽으면 lease도 사라지므로 stale lock이 남지 않는다(Stage C registry와 같은 관행). cross-process governance는 Charter가 명시한 non-goal이다.

### 2.6 API는 일반화 가능한 모양, 구현은 workspace만

```text
acquire({ resourceKind, resourceId, holderId, runId, role, purpose })
```

`resourceKind`가 `workspace`가 아니면 **조용히 통과시키지 않고 거부한다.** 범용 Resource Registry를 미리 만들지 않으면서(Charter non-goal), D-B에서 확장할 자리는 남긴다. 거부하지 않고 통과시키면 "통제되는 줄 알았는데 아니었던" 자원이 생긴다.

### 2.7 결정 시점 provenance

`acquired / reentered / denied / released`를 결정 시점에 방출한다(D-C가 나중에 읽는 seam). 저장은 이 모듈의 책임이 아니라 주입된 `onEvent`의 몫이다. **provenance 기록 실패가 mutation 통제를 무너뜨리지 않는다** — emit은 통제 경로 밖에서 삼킨다.

### 2.8 사용자 표면에 내부 어휘를 노출하지 않는다

Charter §9(Progressive Disclosure). BUSY 메시지는 "같은 작업 폴더를 다른 대화가 변경하고 있습니다"이며 lease/holder/resourceId 같은 엔진 어휘를 쓰지 않는다. 테스트가 이를 강제한다.

---

## 3. 버린 대안

| 대안 | 버린 이유 |
|---|---|
| 범용 Resource Registry를 먼저 구현 | 지금 실제로 깨지는 자원은 workspace 하나뿐이다. 레지스트리를 먼저 만들면 버그 수정이 늦어진다(Charter D-B로 이연). |
| Git index/lock 기반 배타 제어 | 비코딩·비Git workspace를 보호하지 못한다. Agora 목적과 어긋난다. |
| 대기열 / 우선순위 / timeout 자동 회수 | fail-closed가 더 정직하다. 자동 회수는 살아 있는 writer의 작업을 빼앗을 수 있다. |
| holder를 runId로 | Run 밖의 참여자(일반 채팅 turn, 사용자 트리거 restore)를 표현하지 못하고, 전문 실행 중 restore 재진입이 교착된다. |
| disk 영속 lease | 크래시 시 stale lock이 남아 사용자가 손으로 풀어야 한다. memory-only가 이 문제를 원천 제거한다. |

---

## 4. 의도적으로 하지 않은 것

- **PLAN 블록(기획 단계)은 참여자에 넣지 않았다.** Charter D-0이 명시한 참여자는 셋이고, PLAN은 mutation~판정 구간이 아니다. 다만 Planner의 TASK.md 저장은 Agora 자신의 managed write이므로, 향후 관측 결과 경합이 확인되면 Charter 개정(§8) 후 확장한다. 임의 확장하지 않는다.
- **verification 실행 경로**는 아직 존재하지 않는다. D-A0/D-A2에서 이 블록 소유권 안으로 들어온다(2.4의 구간 정의가 이미 그것을 포함한다).
- **provenance 저장소**는 만들지 않았다. seam만 냈다(D-C 범위).

---

## 5. 검증

```text
test/workspace-mutation-lease.test.js              15 tests  (코어 의미론)
test/workspace-mutation-lease-integration.test.js  14 tests  (참여자 3종 seam)
canonical npm test                                 1040 tests / 0 fail / 2 skipped
```

통합 테스트가 실제로 증명하는 것:

- 다른 대화의 write turn은 BUSY로 막히고, 앞 작업이 끝나면 재시도가 통과한다.
- 전문 실행 블록은 경합 시 **본문을 시작조차 하지 않는다**.
- 다른 대화가 쥐고 있으면 **BLOCKED 복원이 실행되지 않는다**(원래의 데이터 유실 경로).
- 같은 방의 restore 재진입은 교착되지 않는다.
- 정상·실패·예외 모든 경로에서 소유권이 반납된다.
- 읽기 실행과 다른 workspace는 서로 막지 않는다.
- lease 미주입·workspace 없음에서는 기존 동작이 그대로다.

---

## 6. 남은 확인

- 사용자 Windows 로컬에서 canonical `npm test` GREEN 실측 (Charter §6 DoD 3).
- actual-diff 독립 검수 PASS (Charter §6 DoD 2).
