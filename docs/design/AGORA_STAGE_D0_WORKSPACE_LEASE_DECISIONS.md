# Agora Stage D-0 — Workspace Mutation Lease Decision Log

> 상태: **1차 검수 FIX_REQUIRED 반영 완료 · 2차 검수 대기**
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
path.resolve      → 후행 구분자 / `.` / `..`
fs.realpathSync   → symlink · junction alias
win32 소문자 접기 → 대소문자
```

**초기 구현은 lexical 정규화(`path.resolve` + 소문자)까지만 했고, 이것은 검수에서 계약 위반으로 지적되었다(B4).** junction 두 개가 같은 실제 폴더를 가리키면 서로 다른 lease key가 되어 동시에 획득된다. 실제 mutation 주체(`turn-checkpoint`, `task-manager`, `workspace-diff`)는 이미 `fs.realpathSync` 기준으로 workspace를 잡으므로, lease만 lexical이면 "Charter가 말하는 canonical workspace identity"가 아니었다.

경로가 아직 없으면 realpath는 실패하며, 그때는 lexical 기준으로 되돌아간다. 존재하지 않는 폴더는 mutation 대상이 될 수 없고, 여기서 거부하면 workspace 생성 직전 실행이 이유 없이 막힌다.

### 2.2 충돌은 fail-closed다 — 대기열도 강탈도 없다

BUSY를 돌려주고 끝낸다. 큐잉을 넣지 않은 이유: 큐는 "언젠가 실행된다"는 약속인데, 그 사이 Frozen Task·workspace·사용자 의도가 이미 달라져 있을 수 있다. 재시도는 사용자의 결정이어야 한다.

### 2.3 재진입은 증명된 중첩에만 허용한다

**초기 구현은 holder(=`sessionId`)가 같으면 무조건 재진입을 허용했고, 이것은 독립 검수에서 결함으로 확인되었다(B3).** 근거로 삼았던 "room 안의 turn은 `pumpTurnQueue`의 `turnActive`로 직렬화된다"는 사실은 **turn 큐를 타는 경로에만** 성립한다. `chat:specialist:blocked`와 `chat:specialist:replan-blocked`는 `room.resolveBlocked()` / `room.replanBlocked()`를 IPC에서 직접 호출하며, 상위 `wrap()`은 try/catch일 뿐 직렬화하지 않는다. 따라서 같은 방에 복원 요청이 두 번 들어오면(중복 클릭·renderer race) 둘 다 재진입으로 통과해 복원이 동시에 두 번 돌 수 있었다.

수정된 계약: 재진입은 **바깥 작업이 자기 안에서 다시 요청하는 진짜 중첩임을 `parentToken`으로 증명**해야 한다.

```text
parentToken 없음 + 같은 holder  → 충돌(BUSY, sameHolder=true)
parentToken이 다른 자원/다른 lease/해제된 token → 충돌
parentToken이 현재 lease의 유효한 token       → 중첩(depth++)
```

renderer가 버튼을 비활성화하더라도 control plane이 스스로 막아야 한다는 원칙을 따른다.

### 2.4 참여자는 셋이다

```text
1. Professional 실행           — 블록 모드(runExecutionBlock)와 step 모드 모두
2. Checkpoint restore          — 사용자 트리거 경로
3. workspace-write 일반 채팅 turn
```

**`runExecutionBlock`만 감싼 초기 구현은 step 모드를 통째로 빠뜨렸다(B1).** `resumeSpecialist`는 `mode === "step"`이면 `resumeStepPhase`로 분기하며, 이 경로는 `runExecutionBlock`을 타지 않고 자체적으로 freeze·checkpoint 생성·Builder 실행을 한다. 일반 `respond()`의 소유권은 `!context.specialist`에만 적용되므로 specialist Builder가 그쪽에서 대신 보호되지도 않았다. 결과적으로 step 모드에서는 one-writer 보증이 존재하지 않았다.

초기 통합 테스트가 이를 잡지 못한 이유는 `runExecutionBlock`을 **직접 호출해 wrapper를 검증**했기 때문이다. 실제 진입점(`resumeSpecialist` → step 분기)을 타지 않았다. 이번 수정의 회귀 테스트는 진입점에서 시작한다.

**소유권 범위가 모드마다 다른 이유**:

- 블록 모드는 Builder→Reviewer→기록이 사용자 개입 없이 이어지므로 **블록 전체**를 쥔다. turn 단위로 잡으면 Builder와 Reviewer 사이 틈으로 다른 대화의 변경이 끼어들어 Reviewer가 보는 변경과 실제 workspace가 어긋난다.
- step 모드는 각 단계 뒤 사용자 결정을 기다리므로 **phase 단위**로 쥔다. 블록 전체를 쥐면 사용자가 자리를 비운 동안 같은 프로젝트의 다른 대화가 무기한 막힌다(Charter §9: 정상 경로에 마찰을 더하지 않는다).

step의 단계 사이에 다른 대화가 workspace를 바꿨는지는 **소유권이 답할 문제가 아니다.** 그것은 "판정이 어떤 결과물에 귀속되는가"의 문제이며 Charter INV-5(Assurance Subject fingerprint)가 D-A에서 잡는다. D-0은 동시 쓰기를 닫고, INV-5는 판정 사이의 변경을 잡는다.

`workspace-read` / `chat` 실행은 참여자가 아니다. 읽기는 서로 막지 않는다.

### 2.5 memory-only이며 보증 경계가 있다

```text
보증 범위: 하나의 Agora main process 안에서
           동일 canonical workspace를 공유하는 실행들
```

이 경계는 `main.js`의 `requestSingleInstanceLock`이 뒷받침한다. 앱이 죽으면 lease도 사라지므로 stale lock이 남지 않는다(Stage C registry와 같은 관행). cross-process governance는 Charter가 명시한 non-goal이다.

**정리(cleanup)는 소유권 해제보다 안전을 우선한다.** 세션 삭제 시 남은 소유권을 정리하되, **실행이 남아 있는 방은 건드리지 않는다**(`releaseWorkspaceMutationsIfIdle`). 초기 구현은 무조건 해제했고 이것은 검수에서 결함으로 확인되었다(B2) — `stopAllSilently()`는 cancel을 *요청*할 뿐 subprocess 종료를 기다리지 않으므로, 아직 파일을 쓰고 있을 수 있는 writer의 소유권을 정리 편의로 풀면 다른 대화가 그 틈에 들어와 잠시 동시에 workspace를 바꾼다.

memory-only라는 성질이 여기서 판단을 정한다: 잘못 남긴 소유권은 앱 재시작으로 사라지지만, 잘못 푼 소유권은 데이터를 잃는다. 그래서 남기는 쪽이 fail-closed다.

### 2.6 API는 일반화 가능한 모양, 구현은 workspace만

```text
acquire({ resourceKind, resourceId, holderId, runId, role, purpose, parentToken })
```

`resourceKind`가 `workspace`가 아니면 **조용히 통과시키지 않고 거부한다.** 범용 Resource Registry를 미리 만들지 않으면서(Charter non-goal), D-B에서 확장할 자리는 남긴다. 거부하지 않고 통과시키면 "통제되는 줄 알았는데 아니었던" 자원이 생긴다.

### 2.7 결정 시점 provenance — seam이 아니라 실제 sink

`acquired / reentered / denied / released`를 결정 시점에 방출하고, **production 조립에서 실제 sink를 연결한다.**

초기 구현은 `onEvent` seam만 내고 조립에서 연결하지 않았다(F1). Charter는 "provenance emit을 D-C에서 몰아 만들지 말고 각 단계의 완료 조건에 자기 결정 시점의 기록이 포함된다"고 요구하므로, 아무도 듣지 않는 emit은 그 요구를 충족하지 않는다.

기록의 수명은 **lease 자체와 같은 process 수명**이다. lease가 memory-only이므로 그보다 오래 남는 기록은 의미가 없다(해제된 적 없는 lease의 영속 기록은 사실이 아니게 된다). 상한을 둔 in-process journal이며, 거부는 사용자가 재시도로 마주치는 유일한 사건이라 운영 로그에도 남긴다. 영속 저장과 graph projection은 D-C 범위다.

**provenance 기록 실패가 mutation 통제를 무너뜨리지 않는다** — emit은 통제 경로 밖에서 삼킨다.

### 2.8 사용자 표면에 내부 어휘를 노출하지 않는다

Charter §9(Progressive Disclosure). BUSY 메시지는 "같은 작업 폴더를 다른 대화가 변경하고 있습니다"이며 lease/holder/resourceId 같은 엔진 어휘를 쓰지 않는다. 테스트가 이를 강제한다.

---

## 3. 버린 대안

| 대안 | 버린 이유 |
|---|---|
| 범용 Resource Registry를 먼저 구현 | 지금 실제로 깨지는 자원은 workspace 하나뿐이다. 레지스트리를 먼저 만들면 버그 수정이 늦어진다(Charter D-B로 이연). |
| Git index/lock 기반 배타 제어 | 비코딩·비Git workspace를 보호하지 못한다. Agora 목적과 어긋난다. |
| 대기열 / 우선순위 / timeout 자동 회수 | fail-closed가 더 정직하다. 자동 회수는 살아 있는 writer의 작업을 빼앗을 수 있다. |
| holder를 runId로 | Run 밖의 참여자(일반 채팅 turn, 사용자 트리거 restore)를 표현하지 못한다. |
| holder 단위 무조건 재진입 | 같은 대화에 mutation IPC가 두 번 들어오는 것만으로 동시 변경이 열린다(B3). 중첩은 증명되어야 한다. |
| 재진입 대신 room-local single-flight gate 추가 | 같은 문제를 lease 밖에 또 하나의 동시성 장치로 푸는 것이다. 소유권 판단은 한 곳에 있어야 한다. |
| disk 영속 lease | 크래시 시 stale lock이 남아 사용자가 손으로 풀어야 한다. memory-only가 이 문제를 원천 제거한다. |

---

## 4. 의도적으로 하지 않은 것

- **PLAN 블록(기획 단계)은 참여자에 넣지 않았다.** Charter D-0이 명시한 참여자는 셋이고, PLAN은 mutation~판정 구간이 아니다. 다만 Planner의 TASK.md 저장은 Agora 자신의 managed write이므로, 향후 관측 결과 경합이 확인되면 Charter 개정(§8) 후 확장한다. 임의 확장하지 않는다.
- **verification 실행 경로**는 아직 존재하지 않는다. D-A0/D-A2에서 이 블록 소유권 안으로 들어온다(2.4의 구간 정의가 이미 그것을 포함한다).
- **영속 provenance 저장소와 graph projection**은 만들지 않았다(D-C 범위). D-0은 process 수명의 결정 기록까지 책임진다(2.7).

---

## 5. 검증

```text
test/workspace-mutation-lease.test.js              20 tests  (코어 의미론)
test/workspace-mutation-lease-integration.test.js  21 tests  (참여자별 진입 경로)
canonical npm test                                 1052 tests / 0 fail / 2 skipped
```

통합 테스트가 실제로 증명하는 것:

- 다른 대화의 write turn은 BUSY로 막히고, 앞 작업이 끝나면 재시도가 통과한다.
- 블록 모드 전문 실행은 경합 시 **본문을 시작조차 하지 않는다**.
- **step 모드는 실제 진입점(`resumeSpecialist` → step 분기)에서 소유권을 잡고**, 경합 시 freeze/checkpoint/Builder가 시작되지 않으며, 실행 중에는 다른 대화의 write가 막힌다.
- 다른 대화가 쥐고 있으면 **BLOCKED 복원이 실행되지 않는다**(원래의 데이터 유실 경로).
- **같은 방에 복원 요청이 두 번 들어와도 복원은 한 번만 실행된다**(동시 실행 카운터로 확인).
- 증명된 중첩(`parentToken`)만 재진입하며, 위조·타 자원·해제된 token은 거부된다.
- **실행이 남아 있는 방의 정리는 소유권을 풀지 않는다**(취소 후 subprocess 잔존 구간 보호).
- 정상·실패·예외 모든 경로에서 소유권이 반납된다.
- 읽기 실행과 다른 workspace는 서로 막지 않는다.
- symlink/junction alias는 같은 workspace로 접힌다.
- lease 미주입·workspace 없음에서는 기존 동작이 그대로다.

---

## 6. 독립 검수 이력

### 1차 검수 — `048dca0` → `81d2776` : **FIX_REQUIRED**

Windows `npm test` 1040/0 fail은 통과했으나, production 진입 경로 기준으로 one-writer 보증을 뚫는 경로가 확인되었다.

| # | 지적 | 수정 |
|---|---|---|
| B1 | step 모드 전문 실행이 lease를 우회 | `resumeStepPhase`를 phase 단위 소유권으로 감쌈 (2.4) |
| B2 | 세션 삭제가 실행 중 writer의 소유권을 조기 강제 해제 | `releaseWorkspaceMutationsIfIdle()` — 실행이 남아 있으면 유지 (2.5) |
| B3 | `holder=sessionId` 재진입이 동시 restore IPC를 허용 | `parentToken` 증명 기반 재진입 (2.3) |
| B4 | lexical 경로 identity가 realpath alias를 접지 못함 | `fs.realpathSync` 추가 (2.1) |
| F1 | production에 provenance sink 미연결 | 조립에서 실제 journal 연결 (2.7) |

검수의 방법론적 지적 하나를 함께 수용했다 — **wrapper를 직접 호출하는 테스트는 진입 경로의 우회를 잡지 못한다.** 이번 회귀 테스트는 모두 실제 진입점에서 시작한다.

### 2차 검수 — `81d2776` → 현재 HEAD : 대기

- 사용자 Windows 로컬 canonical `npm test` GREEN 실측 (Charter §6 DoD 3).
- actual-diff 독립 검수 PASS (Charter §6 DoD 2).
