# Ἀγορά (Agora) — V1.5 역할 멘션·구조화 토론·제한 팀 실행 제안

> 상태: **제안 (Proposal) — 미구현**
>
> 작성일: 2026-08-30
>
> 현재 기준: `AGORA_V1_DESIGN.md`와 `main` 구현이 현재 동작의 기준이다.
>
> 문서 목적: V1을 교체하는 확정 명세가 아니라, V1 위에 단계적으로 추가할 V1.5 후보 범위와 안전 경계를 기록한다.

---

## 0. 결론

V1.5의 핵심은 에이전트 수를 늘리는 것이 아니라, **기존 모델과 역할을 어떤 규칙으로 호출할지 명확히 분리하는 것**이다.

1. 일반 대화와 토론에서는 기존 `Claude / GPT / Gemini` 참가자 구조를 유지한다.
2. 구조화 토론에서는 세 모델에 토론 중에만 유효한 임시 역할을 부여한다.
3. Rule 또는 Protocol이 활성화된 동안에는 모델을 랜덤하거나 임의의 순서로 호출하지 않는다.
4. 전문모드에서는 기존 `Planner / Builder / Reviewer / Recorder` Rule을 재사용한다.
5. 전문모드의 멘션은 **누구에게 말하는지**를 지정할 뿐, 전체 실행이나 쓰기 권한을 자동으로 승인하지 않는다.
6. `@모두`는 항상 Planner부터 시작하는 제한된 순차 흐름이다. 역할을 병렬 또는 랜덤 호출하지 않는다.
7. AI는 다음 역할을 요청할 수 있지만, Runtime이 허용된 Handoff인지 검증한 뒤에만 실행한다.
8. 현재 deterministic Recorder와 향후 System Journal을 구분한다.
9. 별도 Orchestrator Agent는 V1.5 필수 구성요소로 만들지 않는다.

V1.5의 권장 구현 순서는 다음과 같다.

```text
토론 budget / 임시 역할
    ↓
멘션의 Target / Intent 분리
    ↓
직접 역할 호출
    ↓
System Journal 기초
    ↓
구조화된 Role Handoff
    ↓
@모두 제한 팀 실행
    ↓
선택적 Archivist
    ↓
Orchestrator는 향후 확장
```

---

## 1. 현재 구현 기준

이 제안은 다음 현재 동작을 전제로 한다.

### 1.1 일반 대화와 멘션

- 일반 채팅에서 사용자 또는 에이전트가 만든 `@에이전트` 멘션은 실제 후속 호출이다.
- 호출은 방의 단일 턴 큐를 통과하므로 한 번에 한 에이전트만 발언한다.
- 에이전트가 만든 멘션 연쇄는 `mentionChainLimit`으로 제한한다.
- 기존 `@claude / @gpt / @gemini` 식별자와 `agent.id = provider.id` 가정은 유지한다.

### 1.2 자유토론

- 현재 토론은 활성 모델을 순서대로 도는 round-robin이다.
- 현재 총 실행 예산은 기본 9발언으로 고정되어 있다.
- 합의·PASS·결론 신호 또는 사용자 중지로 조기 종료할 수 있다.
- V1.5는 이 실행기를 버리지 않고 budget과 Protocol 개념을 확장한다.

### 1.3 전문 실행

현재 Professional Run은 다음 내부 노드를 사용한다.

```text
PLANNING
→ PLAN_REVIEW
→ READY
→ IMPLEMENTING
→ REVIEWING
→ RECORDING
→ COMPLETED
```

사용자에게는 네 역할을 보여주되 Reviewer 내부 계약은 두 가지로 나뉜다.

```text
Planner
Builder
Reviewer
  ├─ Plan Reviewer
  └─ Implementation Reviewer
Recorder
```

현재 권한 경계는 다음과 같다.

| 역할/단계 | 기본 capability |
|---|---|
| Planner | `workspace-read` |
| Plan Reviewer | `workspace-read` |
| Builder | `workspace-write` |
| Implementation Reviewer | `workspace-read` |
| Recorder | `chat` |

이 capability는 역할 이름만으로 부여하지 않는다. V1.5에서도 **현재 단계, 요청 Intent, FSM 상태가 모두 맞아야** 실제 capability가 부여된다.

### 1.4 현재 Recorder

현재 Professional Recorder는 일반적인 LLM 요약자가 아니다.

- `recorder` 전문 단계에서는 모델을 호출하지 않고 로컬 deterministic 결과를 만든다.
- Frozen Task, Run ID, Task hash, 최종 verdict, diff, evidence를 사용한다.
- 새로운 결정이나 다음 작업을 추론하지 않는다.
- 다만 현재는 실행 블록 마지막 `RECORDING` 단계에서 호출된다.

따라서 현재 Recorder는 **deterministic finalizer**에 가깝고, 모든 단계의 사건을 계속 기록하는 System Journal은 아직 아니다.

---

## 2. 목표와 비목표

### 2.1 목표

V1.5의 목표는 다음과 같다.

1. 자유토론 발언 수를 사용자가 선택할 수 있게 한다.
2. 구조화 토론의 길이를 발언 수가 아닌 Protocol cycle로 설정할 수 있게 한다.
3. 토론 중에만 유효한 임시 역할 Preset을 제공한다.
4. 전문모드에서 역할을 직접 멘션해 질문·계획·검토·실행·정리를 요청할 수 있게 한다.
5. 역할 멘션과 실행 권한을 분리한다.
6. AI가 허용된 범위에서 다음 역할 Handoff를 요청할 수 있게 한다.
7. `@모두`를 Planner-first 제한 순차 실행으로 제공한다.
8. 전문 실행 사실을 append-only System Journal에 남길 수 있는 기반을 만든다.
9. 현재 V1 저장 구조와 Frozen Task·checkpoint·검수 경계를 유지한다.

### 2.2 비목표

V1.5에서는 다음을 만들지 않는다.

- 같은 provider의 참가자 인스턴스 여러 개
- 새로운 `participantId` 체계
- provider CLI multiplexing
- 역할마다 별도 상주 프로세스를 두는 구조
- 여러 역할의 병렬 Professional 실행
- 임의의 DAG 또는 범용 Workflow Engine
- AI가 자유롭게 모든 역할을 호출하는 무제한 자율 실행
- 자연어 추측만으로 Builder 쓰기 권한을 부여하는 기능
- LLM이 System Journal의 사실을 생성하거나 수정하는 기능
- 필수 중앙 Orchestrator Agent
- RAG, Vector DB, Knowledge Graph 또는 cloud sync

---

## 3. 공통 불변조건

V1.5의 모든 모드는 다음 불변조건을 지킨다.

### INV-1. Rule이 있으면 랜덤 호출하지 않는다

활성 Rule, Preset, Protocol 또는 Professional FSM이 있으면 그 규칙이 호출 순서를 결정한다.

```text
활성 Rule 있음
→ Rule의 허용 순서

활성 Rule 없음 + 자유토론
→ 기존 round-robin
```

모델의 본문에 다른 에이전트 이름이나 멘션이 들어갔다는 이유만으로 활성 Protocol의 순서를 바꾸지 않는다.

### INV-2. 멘션은 Target이지 실행 승인이 아니다

```text
@Planner
```

는 Planner에게 말한다는 뜻이다. 다음을 자동으로 의미하지 않는다.

- Professional Run 전체 시작
- Builder 실행
- 파일 수정 승인
- 이후 모든 역할 자동 호출

### INV-3. 쓰기 권한은 명시적 실행 경계에서만 부여한다

Builder에게 질문했다고 `workspace-write`를 부여하지 않는다.

```text
@Builder 이 코드 구조를 설명해줘
→ CONSULT
→ workspace-read
→ 단일 응답
```

```text
@Builder 승인된 Task를 구현해줘
→ EXECUTE 요청
→ READY/Frozen Task/checkpoint/권한 검증
→ 조건 충족 시에만 workspace-write
```

### INV-4. 전문 역할은 한 번에 하나만 실행한다

한 Professional Run 안에서는 동시에 두 역할을 실행하지 않는다.

- Planner와 Reviewer를 병렬 실행하지 않는다.
- Builder가 끝나기 전에 Implementation Reviewer를 실행하지 않는다.
- 역할 Handoff 사이에 현재 결과를 저장하고 다음 역할을 시작한다.

### INV-5. 사용자 의도를 Reviewer가 대신 결정하지 않는다

- 기술적 타당성, 누락, 리스크가 애매함 → Reviewer 검토 가능
- 사용자 목적, 범위, 우선순위, 승인 여부가 애매함 → 사용자에게 반환

`Open Questions`, `UNKNOWN`, `BLOCKED`, 범위 밖 수정 필요 상태는 자동 진행하지 않는다.

### INV-6. 모델은 Handoff를 요청하고 Runtime이 결정한다

AI의 Handoff 출력은 실행 명령이 아니라 요청이다.

Runtime은 다음을 검증한다.

- 현재 역할과 요청 대상 사이의 전이가 허용되는가
- 필요한 artifact가 존재하는가
- 사용자 승인 범위 안인가
- Handoff·보완 budget이 남았는가
- 취소되거나 오래된 invocation의 요청이 아닌가

### INV-7. Journal과 Chat Transcript를 합치지 않는다

- Chat Transcript: 사용자와 모델이 주고받은 대화
- System Journal: 실행 상태와 artifact 관계에 관한 구조화된 사실
- Archivist 결과: 사람이 읽기 편하게 만든 선택적 요약

세 가지는 서로 참조할 수 있지만 같은 source of truth로 취급하지 않는다.

---

## 4. 모드 구조

V1.5의 사용자 경험은 크게 세 영역으로 유지한다.

| 영역 | 참가자/역할 | 실행 규칙 |
|---|---|---|
| 일반 대화 | Claude / GPT / Gemini | 사용자 멘션 또는 기존 응답 방식 |
| 자유·구조화 토론 | Claude / GPT / Gemini + 선택적 임시 토론 역할 | round-robin 또는 Preset Protocol |
| 전문모드 | Planner / Builder / Reviewer / Recorder Rule | 직접 호출 또는 제한 Handoff |

대화용 모델과 전문 역할을 참가자 인스턴스로 합치지 않는다.

```text
대화/토론 계층
Claude / GPT / Gemini

전문 실행 계층
Planner / Builder / Reviewer / Recorder
```

역할에 어떤 provider/model을 연결할지는 기존 전문모드 설정을 사용한다.

---

## 5. 자유토론과 구조화 토론

### 5.1 토론 길이 모델

자유토론과 구조화 토론의 길이 단위를 구분한다.

```text
자유토론
→ turnBudget

구조화 토론
→ cycleBudget
```

예를 들어 다음 네 발언은 하나의 cycle이다.

```text
Claude: 발안
→ GPT: 비평
→ Claude: 수정
→ Gemini: 종합
```

### 5.2 자유토론

자유토론은 현재 round-robin을 유지한다.

권장 UI:

```text
토론 길이
○ 짧게
● 보통
○ 길게
○ 직접 설정
○ 직접 중단할 때까지
```

초기 기본값 후보:

| 표시 | turnBudget |
|---|---:|
| 짧게 | 9 |
| 보통 | 15 |
| 길게 | 30 |
| 직접 설정 | 3~50 |

정확한 기본 숫자는 사용성 확인 후 확정한다. 기존 세션과 설정값이 없으면 V1 호환을 위해 9를 사용할 수 있다.

### 5.3 직접 중단할 때까지

UI에서 “직접 중단할 때까지”를 제공하더라도 Runtime에 실제 무한루프를 만들지 않는다.

권장 정책:

- `checkpointEveryTurns`: 기본 30
- `hardTurnCeiling`: 기본 50
- checkpoint에서 토론을 요약하고 사용자에게 계속 여부를 묻는다.
- 계속하면 이전 run을 무한 연장하지 않고 요약을 바탕으로 새 segment를 시작한다.
- 중지·창 닫기·provider 실패 시 현재 segment를 incomplete로 기록한다.

### 5.4 임시 토론 역할

토론 시작 시 세 모델은 그대로 유지하고 임시 역할만 덧씌운다.

```text
Claude
GPT
Gemini
```

역할 Preset 적용:

```text
Claude → 발안자
GPT → 비평가
Gemini → 종합자
```

토론 종료:

```text
Claude
GPT
Gemini
```

임시 역할은 세션 참가자 identity, provider ID, 일반 멘션 체계를 변경하지 않는다.

### 5.5 Preset 예시

#### 기획

```text
Claude: 발안
→ GPT: 비평
→ Claude: 수정
→ Gemini: 종합
```

#### Grill

```text
Claude: 제안
→ GPT: 질문
→ Claude: 답변
→ Gemini: 판정·정리
```

#### Red Team

```text
Claude: 제안
→ GPT: 공격
→ Claude: 방어·수정
→ Gemini: 종합
```

사용자는 모델과 임시 역할의 매핑을 바꿀 수 있다. 다만 Preset이 시작된 뒤에는 해당 cycle의 순서를 모델이 임의로 변경할 수 없다.

### 5.6 토론 중 멘션 처리

- 사용자 직접 멘션은 다음 안전 지점에서 반영한다.
- 모델 출력의 일반적인 `@멘션`은 구조화 토론 순서를 바꾸지 않는다.
- Protocol이 Handoff를 허용하는 경우에만 구조화된 제어 출력으로 다음 역할을 변경할 수 있다.
- 사용자 개입이 Protocol을 변경하면 현재 cycle을 interrupted로 닫고 새 cycle을 시작한다.

---

## 6. 전문모드의 Target과 Intent

### 6.1 분리 원칙

전문모드 메시지는 최소한 다음 정보를 구분한다.

```text
Target : 누구에게 말하는가
Intent : 무엇을 요청하는가
Scope  : 한 번 답변인가, 팀 흐름인가
Policy : 자동 진행과 보완을 어디까지 허용하는가
```

개념 모델:

```text
target
  planner | builder | reviewer | recorder | all

intent
  CONSULT | PLAN | REVIEW | EXECUTE | SUMMARIZE

scope
  SINGLE | TEAM

executionPolicy
  NONE | STOP_AT_READY | EXECUTE_READY | PREAUTHORIZED_BOUNDED
```

이 값은 구현 시 그대로 필드명이 될 필요는 없지만, 의미는 섞지 않는다.

### 6.2 안전한 기본값

명시적인 실행 metadata가 없는 역할 멘션은 기본적으로 다음과 같이 처리한다.

```text
intent = CONSULT
scope = SINGLE
executionPolicy = NONE
capability = workspace-read 또는 chat
```

자연어 분류기는 Intent를 제안할 수는 있지만, 그 추측만으로 쓰기 권한을 부여하지 않는다.

### 6.3 입력 예시

| 사용자 입력 | Target | Intent | 처리 |
|---|---|---|---|
| `@Planner 이 구조 괜찮아?` | Planner | CONSULT | 읽기 전용 단일 답변 |
| `@Planner 계획을 만들어줘` | Planner | PLAN | Planner와 필요 시 Plan Reviewer |
| `@Reviewer 이 계획 검토해줘` | Reviewer | REVIEW | Plan Review 계약 |
| `@Reviewer 이 구현 결과를 봐줘` | Reviewer | REVIEW | Implementation Review 계약 |
| `@Builder 이 코드가 왜 이런지 설명해줘` | Builder | CONSULT | 읽기 전용 단일 답변 |
| `@Builder 승인된 Task를 구현해줘` | Builder | EXECUTE | 실행 전제조건 검증 후 Builder |
| `@Recorder 여기까지 정리해줘` | Recorder/Archivist | SUMMARIZE | Journal 기반 사용자용 요약 |
| `@모두 이 설계를 어떻게 봐?` | 모두 | CONSULT | Planner-first 팀 상담 |
| `@모두 계획해줘` | 모두 | PLAN | Planner-first, READY에서 정지 |
| `@모두 구현해줘` | 모두 | EXECUTE | 선택된 실행 Policy에 따라 진행 |

### 6.4 자연어와 실행 버튼의 관계

`구현해줘`, `고쳐줘` 같은 문구는 실행 의도를 강하게 시사하지만, V1.5에서는 다음 원칙을 권장한다.

1. UI의 `PLAN / 실행 / 전체 실행` 선택이 있으면 그 metadata를 우선한다.
2. 텍스트만 있고 실행 metadata가 없으면 실행 확인 상태로 보낼 수 있다.
3. 자연어 추측만으로 `PREAUTHORIZED_BOUNDED`를 만들지 않는다.
4. 현재 V1의 승인 Gate와 자동 보완 횟수는 그대로 재사용한다.

---

## 7. 직접 역할 호출

### 7.1 Planner

Planner 직접 호출은 다음 두 종류다.

- CONSULT: 계획 관점의 질문에 답하지만 Task나 Run을 만들지 않는다.
- PLAN: Task 초안을 만들고 Plan Review로 보낼 수 있다.

Planner가 기술적 타당성을 확신하지 못하면 Plan Reviewer Handoff를 요청할 수 있다. 사용자의 목적이나 범위가 불명확하면 Reviewer가 아니라 사용자에게 질문한다.

### 7.2 Reviewer

사용자에게는 Reviewer 하나만 노출한다. Runtime은 요청 출처와 artifact를 보고 내부 계약을 선택한다.

```text
Planner 결과 또는 live Task
→ Plan Reviewer

Frozen Task + Builder diff + evidence
→ Implementation Reviewer
```

판정 기준 artifact가 없으면 formal review를 실행하지 않는다. 이 경우 단순 CONSULT로 답하거나 필요한 artifact를 요청한다.

### 7.3 Builder

Builder 직접 호출도 질문과 실행을 구분한다.

- CONSULT: workspace-read로 구조·실현 가능성·원인을 설명한다.
- EXECUTE: 유효한 READY Task, 승인된 hash, Frozen Task, checkpoint 조건을 확인한다.

실행 전제조건이 없으면 Builder가 임의로 계획을 만들고 쓰기 시작하지 않는다.

```text
유효한 실행 계약 없음
→ NEEDS_PLAN
→ Planner 또는 @모두 흐름을 안내
```

### 7.4 Recorder / Archivist

두 책임을 구분한다.

#### System Journal

- Runtime 기능
- 항상 자동
- 사실 이벤트만 기록
- 모델 지정이나 멘션 불필요

#### Archivist

- 선택적 사용자용 역할
- `@Recorder` 또는 향후 확정할 별도 이름으로 호출
- System Journal과 canonical artifact를 읽어 사람이 읽기 좋은 요약을 생성
- 새로운 사실, 승인, verdict를 만들지 않음

사용자 표면 이름은 호환성을 위해 `Recorder`를 유지할 수 있지만, 내부 책임 이름은 `systemJournal`과 `archivist`로 분리한다.

---

## 8. Role-to-Role Handoff

### 8.1 Handoff는 본문 멘션과 구분한다

일반 문장 속 `@Reviewer`를 Professional Handoff로 사용하지 않는다.

사람이 보는 출력 예:

```text
HANDOFF: @reviewer
PURPOSE: plan_review
REASON: 인증 경계와 rollback 조건 검증 필요
```

Runtime 내부에서는 구조화된 객체로 정규화한다.

```json
{
  "targetRole": "reviewer",
  "purpose": "plan_review",
  "reason": "인증 경계와 rollback 조건 검증 필요",
  "artifactRefs": ["TASK-012"],
  "sourceInvocationId": "inv-...",
  "requestedAt": 0
}
```

### 8.2 허용 전이

| 현재 역할/상태 | 허용 다음 대상 | 의미 |
|---|---|---|
| Planner | Plan Reviewer | 기술적 기획 검수 |
| Planner | User | 요구·범위·승인 질문 |
| Plan Reviewer | Planner | 계획 보완 |
| Plan Reviewer | READY | 계획 PASS |
| READY | Builder | 사용자 실행 정책 충족 후 실행 |
| Builder | Implementation Reviewer | 구현 결과 검수 |
| Builder | Planner/User | Task 변경 또는 결정 필요 |
| Implementation Reviewer | Builder | 범위 내 보완 |
| Implementation Reviewer | Complete | PASS |
| Implementation Reviewer | User | 범위 밖·UNKNOWN·BLOCKED |
| Complete | Archivist | 선택적 사용자용 정리 |
| Archivist | User | 요약 반환 |

다음은 허용하지 않는다.

- Reviewer가 자신을 다시 호출
- Recorder가 Builder를 호출
- Builder가 검수 없이 Complete 선언
- Planner가 사용자 실행 승인 없이 Builder 쓰기를 시작
- 활성 Rule 밖의 provider를 임의 호출

### 8.3 Handoff budget

기존 보완 횟수와 별개로 Handoff 자체에도 상한을 둔다.

권장 초기 정책:

- 한 시점에 active invocation 1개
- 동일 역할 연속 호출 금지
- 계획 자동 보완 0~3회
- 구현 자동 보완 0~3회
- 사용자 발화 한 번에서 파생되는 총 Handoff 상한 설정
- 상한 도달 시 `WAITING / HANDOFF_BUDGET_REACHED`

정확한 총 Handoff 기본값은 실제 Protocol 길이에 맞춰 테스트 후 확정한다.

### 8.4 오래된 Handoff 차단

각 호출은 `invocationId`와 현재 `professionalRunId`를 가진다.

다음 Handoff는 폐기한다.

- 사용자가 취소한 호출에서 늦게 도착한 요청
- generation이 변경된 요청
- 이미 소비된 `invocationId`
- 현재 FSM 노드와 맞지 않는 요청
- 재시작 뒤 이미 완료된 역할의 중복 요청

---

## 9. `@모두` 제한 팀 실행

### 9.1 공통 원칙

`@모두`는 역할 전체를 동시에 호출하는 명령이 아니다.

```text
@모두
→ Planner부터 시작
→ 선택된 Intent의 Protocol 적용
→ 허용된 Handoff만 순차 실행
```

### 9.2 팀 상담

```text
@모두 이 설계를 어떻게 봐?
```

권장 기본 Protocol:

```text
Planner: 문제와 선택지 정리
→ Reviewer: 누락·리스크 비평
→ Builder: 구현 가능성과 비용 의견
→ 사용자에게 반환
```

- Professional Run을 만들지 않는다.
- Task를 Freeze하지 않는다.
- Builder에게 쓰기 권한을 주지 않는다.
- Recorder는 자동 호출하지 않는다.
- Archivist가 구현된 뒤 사용자가 정리를 요청한 경우에만 마지막 요약을 추가한다.

이 상담 Protocol의 정확한 참여 역할은 UI Preset으로 조정할 수 있지만 실행 중 랜덤 선택은 허용하지 않는다.

### 9.3 팀 계획

```text
@모두 계획해줘
```

```text
Planner
→ Plan Reviewer
→ READY
→ 사용자에게 반환
```

Builder와 Implementation Reviewer는 호출하지 않는다.

### 9.4 팀 실행

```text
@모두 구현해줘
```

실제 진행 범위는 텍스트만으로 정하지 않고 현재 상태와 실행 Policy를 함께 본다.

#### 유효한 READY Task가 있는 경우

기존 `실행` 의미를 재사용한다.

```text
READY
→ Freeze
→ Checkpoint
→ Builder
→ Implementation Reviewer
→ 범위 내 제한 보완
→ Complete
```

#### READY Task가 없는 경우

```text
Planner
→ Plan Reviewer
→ READY
```

- 사용자가 `전체 실행`을 명시 선택한 경우에만 승인된 제한 범위 안에서 ACT로 계속 진행한다.
- 그 외에는 READY에서 멈추고 사용자 승인을 받는다.
- 자연어의 “구현해줘”만으로 기존 승인 Gate를 조용히 우회하지 않는다.

### 9.5 `@모두`가 Orchestrator와 다른 점

V1.5의 `@모두`는 고정된 시작점과 전이표를 사용하는 Runtime Protocol이다.

```text
V1.5 @모두
→ Planner-first
→ 제한 전이표
→ 고정 budget
→ 기존 FSM과 권한 경계 사용
```

향후 Orchestrator는 여러 가능한 Protocol 중 무엇을 사용할지 상위 수준에서 판단할 수 있다.

```text
향후 Orchestrator
→ 상황 해석
→ Protocol 선택
→ 기존 Role Mention / Handoff API 조작
```

Orchestrator가 없어도 직접 역할 호출과 `@모두`가 계속 동작해야 한다.

---

## 10. System Journal

### 10.1 목적

System Journal은 전문 실행의 사실관계와 provenance를 남긴다.

기록 대상 예:

```text
Planner 시작·종료
Plan Review 요청·판정
사용자 질문·답변 대기
READY 전이
Frozen Task 생성
Checkpoint 생성·실패·사용자 선택
Builder 시작·종료
Evidence 수집
Implementation Review verdict
보완 Handoff
취소·중단·복구
Run 완료
```

### 10.2 저장 경계

Professional Run의 계획 단계에는 아직 Frozen `RUN-xxx`가 존재하지 않는다. `RUN-xxx`는 Builder 직전 Task Freeze 시점에 생성된다.

따라서 Journal을 처음부터 `RUN-xxx` 폴더에만 저장하면 안 된다.

권장 저장 구조:

```text
session/
  transcript.jsonl
  meta.json
  professional-events.jsonl
```

- 계획 단계 이벤트는 `professionalRunId`로 연결한다.
- Freeze 이후 이벤트는 `professionalRunId`와 `frozenRunId(RUN-xxx)`를 함께 가진다.
- Run artifact는 `RUN-xxx/task.md`, `task-hash`, evidence 등 기존 canonical 위치를 유지한다.
- Journal은 artifact 본문을 복사해 별도 진실로 만들지 않고 ID·hash·경로를 참조한다.

정확한 파일명과 ChatStore schema version은 구현 단계에서 확정하되, 세션 단위 선행 기록 원칙은 유지한다.

### 10.3 이벤트 개념 스키마

```json
{
  "schemaVersion": 1,
  "eventId": "pe-...",
  "sessionId": "session-...",
  "professionalRunId": "pr-...",
  "frozenRunId": "RUN-012",
  "invocationId": "inv-...",
  "type": "ROLE_FINISHED",
  "role": "reviewer",
  "purpose": "implementation_review",
  "status": "PASS",
  "artifactRefs": [],
  "createdAt": 0
}
```

권장 이벤트 종류:

```text
INTERACTION_CLASSIFIED
ROLE_STARTED
ROLE_FINISHED
HANDOFF_REQUESTED
HANDOFF_ACCEPTED
HANDOFF_REJECTED
USER_DECISION_REQUIRED
USER_DECISION_RECEIVED
TASK_APPROVED
TASK_FROZEN
CHECKPOINT_CREATED
CHECKPOINT_FAILED
ARTIFACT_RECORDED
REVIEW_VERDICT
RUN_INTERRUPTED
RUN_BLOCKED
RUN_COMPLETED
```

### 10.4 기록 규칙

- append-only로 기록한다.
- 같은 `eventId`를 중복 적용하지 않는다.
- 이벤트 저장 실패를 성공으로 숨기지 않는다.
- UI 상태를 Journal만 보고 즉석에서 추측하지 않는다. FSM이 현재 상태의 기준이다.
- Journal은 FSM 전이와 artifact provenance를 설명하는 감사 기록이다.
- 민감한 전체 prompt, secret, 무제한 stdout을 Journal에 복사하지 않는다.
- 대용량 원문은 기존 run log 또는 artifact를 참조한다.

### 10.5 현재 Recorder 마이그레이션

Recorder 제거를 V1.5의 첫 단계로 삼지 않는다.

#### 단계 A

현재 deterministic `RECORDING` finalizer를 유지한다.

#### 단계 B

System Journal을 추가하고 주요 역할·전이 이벤트를 기록한다.

#### 단계 C

deterministic 결과가 Journal과 canonical artifact를 참조하도록 정리한다.

#### 단계 D

선택적 Archivist를 추가한다.

#### 단계 E

복구·UI·기존 세션 호환 테스트가 끝난 뒤에만 필수 `RECORDING` FSM 노드 제거 여부를 결정한다.

`RECORDING` 노드를 당장 없애지 않으면 의미상 중복은 잠시 남지만, 기존 완료·복구 경로를 한 번에 깨뜨리는 위험을 줄일 수 있다.

---

## 11. UI 제안

### 11.1 토론 설정

```text
토론 방식
● 자유토론
○ 구조화 토론

길이
● 보통
○ 직접 설정
○ 직접 중단할 때까지

구조화 토론 Preset
[ 기획 ▼ ]

반복
[ 3 cycle ▼ ]
```

자유토론에서는 cycle UI를 숨기고, 구조화 토론에서는 turn 숫자 대신 cycle을 중심으로 보여준다.

### 11.2 전문모드 Composer

멘션 옆에 현재 Intent를 명확히 표시한다.

```text
대상: @Planner
요청: 질문
```

또는:

```text
대상: @모두
요청: 계획
```

실행 권한이 필요한 경우 기존 `PLAN / 실행 / 전체 실행` 컨트롤을 재사용한다. 새로운 자연어 분류 UI를 별도로 크게 만들기보다 현재 실행 컨트롤과 연결한다.

### 11.3 상태 표시

전문 팀 흐름 중에는 다음을 표시한다.

```text
현재 역할: Reviewer
목적: 계획 검토
진행: Planner 완료 → Reviewer 실행 중
자동 보완: 0 / 2
다음 가능 상태: Planner 보완 / READY / 사용자 결정
```

“AI가 알아서 처리 중”처럼 범위를 알 수 없는 문구는 사용하지 않는다.

### 11.4 질문과 실행의 시각적 구분

- 질문: 읽기 전용 표시
- 계획: Task 초안 또는 READY까지
- 실행: workspace-write 가능성 표시
- 전체 실행: 사전 승인 범위와 자동 보완 횟수 표시

Builder 멘션이 있어도 질문이면 쓰기 표시를 노출하지 않는다.

---

## 12. 활성 Run 중 새 멘션

현재 Professional Run과 무관한 질문이 실행 context에 섞이지 않게 한다.

### RUNNING

- 새 전문 멘션은 즉시 실행하지 않는다.
- 사용자에게 현재 역할을 중지할지, 완료 후 질문할지 선택하게 한다.
- 같은 workspace에서 Builder가 쓰는 동안 다른 Builder 실행을 시작하지 않는다.

### WAITING / READY

- 독립 CONSULT는 별도 읽기 전용 호출로 허용할 수 있다.
- CONSULT 결과가 현재 Task를 자동 수정하지 않는다.
- 현재 Task를 바꾸려면 명시적으로 REPLAN한다.

### BLOCKED / INTERRUPTED

- 원인 설명 CONSULT는 허용할 수 있다.
- 재개·복구·폐기는 기존 명시적 액션으로만 수행한다.
- 질문 응답을 자동 재개 신호로 사용하지 않는다.

---

## 13. 호환성

### 13.1 기존 멘션

- `@claude / @gpt / @gemini`는 그대로 유지한다.
- 일반 채팅의 에이전트 멘션 연쇄 제한도 유지한다.
- Professional Handoff만 별도 구조화 contract를 사용한다.

### 13.2 기존 토론

- 저장된 설정에 새 budget이 없으면 기존 기본 9발언을 사용한다.
- 기존 discussion transcript와 `discussionMeta`를 읽을 수 있어야 한다.
- 새 필드는 optional로 추가하고 이전 기록을 마이그레이션 없이 읽을 수 있게 한다.

### 13.3 기존 Professional Run

- 기존 `RECORDING` 노드를 즉시 삭제하지 않는다.
- 새 Interaction/Handoff field가 없는 Run은 기존 FSM 의미로 복구한다.
- 더 새로운 schema를 읽을 수 없으면 fail-closed read-only 또는 명시적 오류로 처리한다.
- Frozen Task와 승인 hash는 새 Handoff보다 우선하는 실행 계약이다.

### 13.4 기존 역할 설정

- 현재 네 Role Rule과 모델 선택을 재사용한다.
- Reviewer 내부 계약 분리는 사용자에게 다섯 번째 역할 슬롯을 추가하지 않는다.
- 대화 참가자와 전문 역할을 같은 identity로 합치지 않는다.

---

## 14. 구현 단계와 예상 난도

아래 기간은 현재 구조를 아는 개발자 1명이 관련 테스트와 복구 경계까지 포함해 작업하는 경우의 계획용 추정치다. 병렬 작업과 중복 코드를 고려하므로 단순 합산하지 않는다.

| 단계 | 범위 | 난도 | 예상 |
|---|---|---:|---:|
| 0 | Interaction/Handoff 계약과 정책표 | 중간 | 2~4일 |
| 1 | 자유토론 budget UI·IPC·저장 | 낮음 | 2~4일 |
| 2 | 구조화 토론 Preset·cycle scheduler | 중간 | 4~7일 |
| 3 | 직접 역할 멘션과 CONSULT/PLAN/REVIEW/EXECUTE 분리 | 중상 | 1~2주 |
| 4 | 세션 단위 System Journal 기초 | 중간 | 1~2주 |
| 5 | 구조화된 Role-to-Role Handoff | 높음 | 2~3주 |
| 6 | `@모두` Planner-first 팀 Protocol | 높음 | 1~2주 |
| 7 | 선택적 Archivist | 중간 | 3~5일 |
| 8 | 필수 `RECORDING` 노드 폐기 검토·마이그레이션 | 중상 | 1~2주 |
| 향후 | Orchestrator | 매우 높음 | V1.5 외 |

예상 전체:

- 토론 budget만: 약 1주 이내
- V1.5 Core(토론 + 직접 멘션 + 제한 Handoff + `@모두`): 약 5~8주
- Journal·Archivist·Recorder 마이그레이션까지 포함: 약 7~11주
- Orchestrator 포함: 별도 V2 범위

---

## 15. 권장 구현 순서

### Phase 0 — 계약 고정

- Target, Intent, Scope, executionPolicy 의미 확정
- 허용 Handoff 전이표 확정
- 질문 기본값과 쓰기 승인 경계 확정
- 기존 FSM 이벤트와 새 Interaction의 매핑 작성

### Phase 1 — 토론 개선

- `discussionRunBudget`을 세션별 설정으로 확장
- UI/IPC validation 추가
- structured Protocol과 cycle scheduler 추가
- 사용자 중지와 checkpoint 처리

### Phase 2 — 단일 역할 호출

- 역할 멘션 parser와 resolver 추가
- CONSULT를 기존 Run과 분리
- Builder CONSULT를 `workspace-read`로 강등
- Reviewer contract 자동 선택
- 실행 전제조건이 없을 때 `NEEDS_PLAN` 반환

### Phase 3 — Journal 기초

- `professional-events.jsonl`에 append하는 저장 경계 추가
- FSM 전이·role invocation·user decision 이벤트 기록
- idempotency와 손상 line 처리
- 기존 transcript와 분리 확인

### Phase 4 — AI Handoff

- role output의 구조화 Handoff 파싱
- 전이표·artifact·budget 검증
- stale invocation 차단
- 취소·재시작 복구

### Phase 5 — `@모두`

- CONSULT / PLAN / EXECUTE Protocol 분리
- 모든 Protocol을 Planner-first로 시작
- 기존 `PLAN / 실행 / 전체 실행` 정책과 연결
- 한 역할씩 순차 실행

### Phase 6 — Recorder 분리

- System Journal 기반 deterministic finalizer
- 선택적 Archivist
- `RECORDING` 노드 제거 여부를 별도 결정

### Phase 7 — Orchestrator 검토

V1.5 사용 데이터와 실패 유형을 본 뒤에만 검토한다. Orchestrator는 새 실행 엔진이 아니라 검증된 Mention/Handoff API를 사용하는 상위 선택 계층이어야 한다.

---

## 16. 예상 버그와 방어책

### P1 — 질문이 실행으로 오분류됨

증상:

- `@Builder 이 코드가 왜 이래?`가 파일 수정으로 이어짐
- `@모두 어떻게 생각해?`가 Professional Run 전체를 시작함

방어:

- metadata 없는 멘션은 CONSULT 기본값
- 실행은 기존 명시적 UI 액션과 연결
- backend에서도 capability를 재검증

### P1 — 잘못된 Reviewer 계약 선택

증상:

- 계획을 구현 Reviewer prompt로 검토
- Builder diff 없이 구현 PASS

방어:

- 요청 문구가 아니라 source role과 artifact 종류로 contract 선택
- 필요한 artifact가 없으면 formal review 거부

### P1 — 무한 Handoff

증상:

- Planner와 Reviewer가 계속 서로 호출
- Reviewer가 자기 자신을 재호출

방어:

- 허용 전이표
- 동일 역할 연속 호출 금지
- 계획·구현 보완 횟수와 총 Handoff 상한
- 상한 도달 시 사용자 반환

### P1 — 취소 후 늦은 호출이 다시 실행됨

증상:

- 사용자가 중지했는데 늦게 도착한 Handoff가 Builder를 시작
- 재시작 뒤 같은 역할이 두 번 실행

방어:

- `generation`, `invocationId`, `professionalRunId` 검증
- 이벤트 idempotency
- 완료·취소 invocation 소비 기록

### P1 — 승인되지 않은 Builder 쓰기

증상:

- READY/Frozen Task 없이 Builder 실행
- 자연어 의도 추측만으로 `workspace-write`

방어:

- 기존 Task hash, Freeze, checkpoint, IPC capability 검증 유지
- direct Builder 호출도 같은 실행 전제조건 적용

### P1 — `@모두` 병렬 실행

증상:

- Planner·Builder·Reviewer가 동시에 시작
- Reviewer가 Builder 완료 전 상태를 검토

방어:

- Planner-first 고정
- active role 1개
- 이전 역할 종료 이벤트 저장 후 다음 역할 예약

### P1 — Journal과 canonical artifact 불일치

증상:

- Journal에는 Task가 승인됐지만 실제 hash가 다름
- 계획 단계 이벤트가 존재하지 않았던 `RUN-xxx`에 연결됨

방어:

- 계획 단계는 `professionalRunId` 기준
- Freeze 이후에만 `frozenRunId` 연결
- artifact 본문을 복사하지 않고 ID/hash 참조

### P2 — cycle과 turn 계산 오류

증상:

- 3 cycle을 선택했는데 마지막 종합 발언이 빠짐
- 중간 결론 후 다음 cycle이 한 번 더 시작됨

방어:

- `turnBudget`과 `cycleBudget` 타입 분리
- Protocol step index와 completed cycle을 별도 저장
- 중지·실패·조기 결론 테스트

### P2 — 장기 토론 context·비용 증가

증상:

- “직접 중단할 때까지”가 사실상 무한 호출
- 긴 transcript로 응답 품질 저하

방어:

- checkpoint와 hard ceiling
- segment 요약 후 명시적 계속
- provider 실패와 비용 정보를 사용자에게 표시

### P2 — UI와 backend Intent 불일치

증상:

- UI는 질문인데 backend는 실행
- 앱 복구 후 Intent chip과 실제 FSM 상태가 다름

방어:

- Intent를 IPC payload에 명시
- backend가 최종 authority
- 저장·복구·renderer 표시 contract test

### P2 — Recorder 이름 혼동

증상:

- System Journal이 LLM 판단을 하는 것으로 오해
- Archivist 요약이 canonical verdict로 저장됨

방어:

- 내부 타입 `systemJournal`과 `archivist` 분리
- Archivist 결과에 `derivedSummary: true` 표시
- verdict와 승인 상태를 수정할 수 없게 함

---

## 17. 테스트 계획

### 17.1 토론

- 자유토론 9/15/30/custom budget
- 선택된 참가자 round-robin
- 구조화 Protocol step 순서
- cycle 1/2/3과 중간 조기 종료
- 사용자 중지
- provider 실패
- checkpoint 후 계속/종료
- 기존 discussion 기록 호환

### 17.2 Intent와 권한

- 모든 역할의 CONSULT가 쓰기를 하지 않음
- Builder CONSULT가 `workspace-read`
- 실행 metadata 없는 `@모두` 질문이 Run을 만들지 않음
- READY 없는 direct Builder EXECUTE가 `NEEDS_PLAN`
- renderer와 backend의 Intent 불일치 거부

### 17.3 Reviewer routing

- Planner 산출물 → Plan Reviewer
- Frozen Task + diff + evidence → Implementation Reviewer
- artifact 부족 시 formal review 거부
- 사용자 의도 질문을 Reviewer에게 넘기지 않음

### 17.4 Handoff

- 허용 전이 성공
- 금지 전이 거부
- 같은 역할 재호출 거부
- budget 도달
- 취소 뒤 stale 요청 거부
- 재시작 뒤 중복 실행 방지

### 17.5 `@모두`

- CONSULT는 Planner-first이고 write 없음
- PLAN은 READY에서 정지
- READY 상태 EXECUTE는 Builder부터 기존 실행 경로 사용
- `전체 실행` 사전 승인 시에만 PLAN에서 ACT 자동 진행
- BLOCKED/UNKNOWN/Open Questions에서 사용자에게 반환

### 17.6 Journal

- append-only
- 중복 `eventId` 처리
- partial/corrupt 마지막 line 복구
- plan 단계 이벤트에 `frozenRunId` 없음
- Freeze 이후 두 ID 연결
- transcript와 별도 저장
- 세션 삭제·복구·archive 동작과 함께 이동

### 17.7 기존 회귀

- 일반 채팅 provider 멘션
- 기존 mention chain limit
- 기존 Professional step/auto/quick 호환
- Frozen Task hash
- checkpoint/restore
- Builder one-writer
- Recorder deterministic 결과
- 앱 재시작 복구

---

## 18. 완료 기준

V1.5 Core는 다음을 모두 만족해야 완료로 본다.

1. Rule이 활성화된 토론과 전문 실행에서 랜덤 호출이 없다.
2. 자유토론은 기존 round-robin을 유지하면서 budget을 설정할 수 있다.
3. 구조화 토론은 정확한 Protocol step과 cycle 수를 따른다.
4. 임시 토론 역할이 종료 후 참가자 identity에 남지 않는다.
5. 역할 멘션만으로 쓰기 권한이나 전체 실행이 시작되지 않는다.
6. 질문은 기본적으로 읽기 전용 단일 응답이다.
7. `@모두`의 모든 Protocol은 Planner부터 시작한다.
8. AI Handoff는 허용 전이표와 budget을 통과해야 한다.
9. Planner/Reviewer/Builder가 동시에 실행되지 않는다.
10. 사용자 의도·범위·승인 ambiguity는 사용자에게 반환한다.
11. 기존 Frozen Task·checkpoint·evidence·Reviewer 경계가 유지된다.
12. 재시작과 취소 뒤 중복 역할 실행이 없다.
13. System Journal이 transcript와 분리되어 사건을 기록한다.
14. Archivist 요약은 canonical verdict나 승인 상태를 바꾸지 않는다.
15. Orchestrator 없이 직접 역할 호출과 `@모두`가 완전하게 동작한다.

---

## 19. 확정된 결정

이번 제안에서 다음 방향은 확정 후보로 기록한다.

- 대화/토론 참가자는 기존 Claude / GPT / Gemini를 유지한다.
- 구조화 토론 역할은 임시로 부여하고 종료 시 폐기한다.
- 특정 Rule이 있으면 랜덤 호출하지 않는다.
- 자유토론은 기존 round-robin을 유지한다.
- 전문모드 역할 멘션은 전체 실행과 동일하지 않다.
- Target과 Intent를 분리한다.
- 실행 의도가 없는 멘션은 CONSULT/읽기 전용이 기본이다.
- `@모두`는 Planner-first 제한 순차 실행이다.
- AI Handoff는 허용된 전이 안에서만 가능하다.
- Reviewer는 사용자에게는 하나지만 내부적으로 계획·구현 검토 계약을 구분한다.
- System Journal과 선택적 Archivist를 구분한다.
- Orchestrator는 V1.5 필수 범위에서 제외한다.
- 현재 deterministic `RECORDING` 단계를 즉시 제거하지 않는다.

---

## 20. 구현 전 확정할 세부값

아래 항목은 구현 전에 제품 결정이 필요하다.

1. 자유토론 짧게/보통/길게의 정확한 기본 발언 수
2. “직접 중단할 때까지”의 checkpoint와 hard ceiling
3. 초기 제공 구조화 토론 Preset 목록
4. `@모두 CONSULT`의 기본 참여 역할과 마지막 종합 방식
5. Composer에서 Intent를 버튼·chip·명령 중 어떤 방식으로 선택할지
6. 텍스트의 실행 표현을 감지했지만 UI 실행 metadata가 없을 때 확인 UX
7. 사용자 표면에서 `Recorder` 이름을 유지할지 `Archivist`를 별도 노출할지
8. System Journal 파일명과 ChatStore schema migration
9. 필수 `RECORDING` 노드 제거 시점
10. 총 Handoff 상한의 기본값

이 값들은 구조의 핵심 원칙을 바꾸지 않으며 단계별 구현 중 별도 결정 문서로 확정할 수 있다.

---

## 21. 최종 권고

V1.5는 한 번에 거대한 자율 시스템으로 만들지 않는다.

가장 안전한 범위는 다음과 같다.

```text
V1.5.0
- 토론 turn/cycle budget
- 임시 역할 Preset
- Target/Intent 분리
- 직접 역할 CONSULT/PLAN/REVIEW/EXECUTE

V1.5.1
- 세션 단위 System Journal
- 구조화된 AI Handoff
- @모두 Planner-first 제한 팀 실행

V1.5.2
- 선택적 Archivist
- Recorder finalizer 정리

향후 V2
- Orchestrator
```

이 순서를 따르면 Orchestrator가 없어도 전문모드가 동작하고, 향후 Orchestrator가 실패하더라도 사용자는 직접 역할 멘션과 제한 팀 실행으로 계속 작업할 수 있다.

