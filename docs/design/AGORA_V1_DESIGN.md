# Ἀγορά (Agora) — V1 Multi-Agent & Professional Execution Design

> 상태: **확정안 (v1 기준)**
> 기준: `main`의 PLAN ⇄ ACT 전문 실행 및 신뢰성 FSM 구현
> 작성일: 2026-08-10
> 이 문서는 Agora의 **Multi-Agent 대화, Handoff, Professional Execution 모드 설계의 단일 기준**이다. (메인 윈도우 UI, 런타임/프로바이더 연동 등 제품 전반 명세는 별도 Baseline 문서와 함께 작동한다.)

---

## 0. 요약

Agora는 여러 AI 모델을 하나의 로컬 작업 공간 안에서 **대화·토론·기획·구현·검토·기록**까지 연결해 쓰는 데스크톱 도구이다. v1의 핵심 철학은 **"자동화를 금지하는 것이 아니라, 사용자가 미리 승인하지 않은 자동화를 금지한다"** 이다. 즉 AI가 혼자 프로젝트를 운영하지 않되, 사용자가 실행 전에 명시적으로 승인한 범위 안에서는 제한된 자동 진행을 허용한다.

v1에서 확정된 사용자 흐름은 네 가지 실행 방식으로 나뉜다.

- 일반 대화 (이어 발언 / 독립 발언)
- 토론 (Discussion) — 기존 유지
- 메시지 전달 (Handoff) — 검토 요청 / 이어서 작업
- 전문 실행 (Professional Mode) — Planner / Builder / Reviewer / Recorder

본 문서는 Role Contract(a.i.)와 Execution Control(프로그램)이라는 두 계층을 분리해 설계한다.

### 현재 구현 기준

전문 실행의 현재 구현은 이 문서의 계약을 다음처럼 fail-closed로 강제한다.

- 일반 채팅·토론은 기존 세션 권한, transcript 전달, provider invocation 경계를 그대로 사용한다. 전문 단계의 cap은 `context.specialist.stage`가 있을 때만 적용한다.
- Planner/기획 검수는 `workspace-read`, Builder만 `workspace-write`, 구현 Reviewer는 `workspace-read`, Recorder는 `chat`으로 제한한다. 실제 CLI 인자와 IPC 경계에서 같은 cap을 다시 적용한다.
- Builder의 `STATUS` 누락·모호성은 성공으로 승격하지 않고 사용자 결정으로 보낸다. Frozen Task, checkpoint 이후 변경, 실행 evidence가 없거나 손상되면 자동 PASS를 금지한다.
- Reviewer는 대화 transcript와 Builder 자기보고 없이 Frozen Task·변경·구조화된 실행 상태·bounded evidence를 먼저 보고 `회귀·안전성` 다음 `계약 충족` 순서로 판정한다.
- checkpoint와 복구 저널은 세션 저장소 아래에 두고, 재시작 시 자동 재개하지 않고 keep/restore/discard를 제공한다.
- UI는 `PLAN / 실행 / 전체 실행`으로 단순화한다. `실행`은 PLAN 검수 PASS 뒤 구현·검수·기록을 수행하고, `전체 실행`은 그 PASS를 ACT까지 진행해도 된다는 사전 승인으로 취급한다.

---

## 1. 핵심 철학

> **AI가 사용자의 사전 승인 범위를 넘어 다음 행동을 결정하지 않는다.**

이 한 문장이 v1 전체의 기준이다. 이로부터 다음이 파생된다.

1. 기본 실행은 **단계별(step-by-step)** 이며, 각 Role 종료 후 사용자에게 반환한다.
2. 사용자가 실행 전에 명시적으로 승인한 경우에만 **제한된 자동 체인(bounded auto-chain)** 을 허용한다.
3. 자동 진행은 승인된 범위(보완 횟수, Task 범위) 안에서만 동작한다.
4. 판정 불가, 범위 누락, 범위 밖 변경 필요, 안전 보장 불가 등의 경우에는 자동 진행하지 않고 사용자에게 반환한다.
5. AI가 스스로 다음 Role을 호출하거나 범위를 확대하는 행위는 프로그램 계층에서 차단한다.

---

## 2. 실행 방식 (Professional Mode)

전문 실행의 사용자 표면은 다음 세 동작으로 고정한다.

- **PLAN**: Planner → Plan Reviewer를 실행하고 PASS면 READY에서 멈춘다.
- **실행**: READY의 승인된 Task만 동결해 Builder → Implementation Reviewer → Recorder까지 실행한다.
- **전체 실행**: PLAN을 시작하고, Plan Reviewer PASS를 ACT까지 진행해도 된다는 사용자의 사전 승인으로 해석한다.

`step / auto / quick`은 기존 호출과 저장된 세션을 위한 호환 어댑터로 유지한다. 새 UI는 이 세 모드를 직접 노출하지 않으며, UNKNOWN·NEEDS_DECISION·BLOCKED·저장 오류에서는 어떤 경로도 자동 진행하지 않는다.

### 2.0 세 방식 개요

| 방식 | 기획(PLAN_READY) 후 | 구현~검토 | 컨트롤 | 손이 가는 정도 |
|---|---|---|---|---|
| 단계별 (step) | **승인에서 멈춤** | 내가 매번 눌러서 진행 | 최강 | 최대 |
| 제한 자동 (auto) | **승인에서 멈춤** | 승인 후 자동으로 (N회) | 중간 | 중간 |
| 빠른 실행 (quick) | **승인 없이 진행** | 한 번에 자동으로 | 낮음 | 최소 |

누가 다음 단계를 시작할 권한을 갖느냐가 핵심 차이다. 단계별과 제한 자동은 둘 다 "기획은 사람이 꼭 봐야 한다"는 원칙을 지키고, 기획 통과 **이후**에 구현·검토·보완을 내가 한 번씩 눌러 진행하느냐(단계별) vs 한 번 위임하고 자동으로 맡기느냐(제한 자동)가 다르다. 빠른 실행은 기획 확인 단계 자체를 건너뛰는, 가벼운 과제용 원샷 실행이다.

### 2.0.1 실행 상태 보호

- 전문 실행은 `실행 중 / 승인 대기 / BLOCKED`를 대화별 상태로 공개한다. 창을 다시 열거나 다른 대화로 이동해도 현재 대화의 상태만 복원한다.
- 이 세 상태에서는 일반 채팅과 Handoff를 renderer와 backend 양쪽에서 차단한다. 따라서 일반 응답이 Reviewer·Recorder 맥락에 섞이지 않는다.
- 승인 대기 단계에서는 **전문 실행 취소**를 제공한다. 이미 만들어진 Builder 변경은 유지하고, 해당 실행의 checkpoint만 정리한다.
- 빠른 실행과 제한 자동 실행은 모두 `FIX_REQUIRED + Scope: IN + 남은 횟수`일 때만 자동 보완한다. 자동 보완 Builder는 같은 Frozen Task와 Reviewer 피드백을 함께 받는다.

### 2.1 단계별 실행 (Step-by-step)

- Planner → **PLAN_READY → STOP → 사용자 승인 Gate**
- 승인 후 Builder → **STOP** → 사용자
- Builder → **STOP** → 사용자
- Reviewer → **STOP** → 사용자
- (필요 시) Builder 재실행은 사용자가 직접 결정

사람이 매 단계마다 통제권을 가진다. 기획이 끝나도 승인 전에는 구현을 시작하지 않는다. 판단이 애매하거나 중요한 결정이 필요할 때 쓴다.

> 구현: `startSpecialist({ mode: "step" })`. 기획이 PLAN_READY면 `needsUserDecision: true, stopReason: "PLAN_READY"`로 멈추고, `specialistResume`에 이어서 진행할 상태를 저장한다. 사용자가 승인하면 `resumeSpecialist()`로 구현을 재개한다.

### 2.2 제한 자동 실행 (Bounded auto-run)

- 사용자가 실행 전에 **자동 보완 최대 횟수 N**(0~3회)을 승인한다.
- Planner → **PLAN_READY → STOP → 사용자 승인 Gate**
- 승인 후 Builder → Reviewer → **FIX_REQUIRED + 범위 내 + 횟수 남음**이면 Builder 보완 재실행.
- **PASS** 즉시 종료.
- 그 외 모든 경우 STOP → 사용자.

기획은 단계별과 마찬가지로 승인에서 멈춘다. 승인을 받은 순간부터는 정해진 범위 안에서만 자동으로 이어진다.

> 구현: `startSpecialist({ mode: "auto", maxAutoRevisions: N })`. 기획이 PLAN_READY면 step과 동일하게 승인에서 멈추고, `resumeSpecialist()`로 재개한다.

### 2.3 빠른 실행 (Quick run)

- Planner → **PLAN_READY면 승인 없이 바로 진행**
- Builder → Reviewer → (FIX_REQUIRED + 범위 내면 자동 보완, 승인된 N회) → **PASS** 종료

귀찮거나 가벼운 과제에 쓴다. 기획 확인 단계를 건너뛰고 기획 → 구현 → 검토를 한 번에 진행한다. 컨트롤은 낮아지지만 손이 가장 덜 간다.

> 구현: `startSpecialist({ mode: "quick" })`. 기획이 PLAN_READY면 승인 대기 없이 바로 실행 블록으로 넘어간다.

> **기록관(Recorder)**: 세 방식 모두 실행 블록(구현→검토→보완)이 PASS로 끝나면, 그 **블록의 마지막 단계로 기록관을 자동 호출**해 블록을 마무리한다. 자동 수정 루프에 끼어드는 것이 아니라 블록 종착역 역할이다. 사용자가 필요할 때만 별도로 호출할 수도 있다.

> UI 용어: 반드시 **"자동 보완 최대 N회"** 라고 표기한다. "최대 N회 반복"은 최초 구현 포함 여부가 애매하므로 쓰지 않는다.
> 의미 및 모델링: *최초 구현 1회 + 자동 보완 ≤ N회*. 백엔드 모델링 시 `maxAutoRevisions = N` (N=0~3)으로 관리한다. 최초 Builder 실행은 보완 횟수로 카운트하지 않으며, `FIX_REQUIRED` 후 자동 보완 시 `autoRevisionCount`를 1씩 증가시킨다. `N=3` 선택 시 결과적으로 Builder 실행은 최초 1회 + 자동 보완 최대 3회 = 최대 4회가 된다.
> IPC/코드 매핑: 기존 `chat-ipc.js:1361`의 `startSpecialist` 옵션 `maxIterations: 3`은 새 모델링의 `maxAutoRevisions: N`으로 명시 매핑하여, 최초 Builder 실행(1회)과 자동 보완(N회) 카운트의 의미를 백엔드에서 명확히 분리하여 구현한다.

---

## 3. Role Contract (AI 행동 규칙)

Role Contract는 **AI에게 주는 규칙**이다. 각 Role은 다음 8개 항목을 가진다.

```text
Purpose      : 이 Role이 존재하는 이유
Inputs       : 이 Role이 보아야 하는 것
Responsibilities : 해야 하는 일
Scope        : 하지 말아야 할 경계
Stop / Block : 중단 조건
Forbidden    : 금지 행위
Output contract : 출력 형식
Terminal status : 종료 상태
```

### 3.0 공통 Rule (모든 Role 공통)

```text
당신은 현재 지정된 Role의 범위 안에서만 작업한다.
다른 Role의 업무를 임의로 수행하지 않는다.
현재 과업의 범위를 자의적으로 확대하지 않는다.
다음 Role 또는 후속 실행을 스스로 호출하지 않는다.
자신의 종료 조건에 도달하면 명시된 상태를 반환하고 멈춘다.
필요한 판단이 현재 Role의 권한을 넘어가면 사용자에게 반환한다.
당신의 Role이 끝나면 다음 단계를 실행하지 말고 사용자에게 통제권을 반환한다.
```

이로 인해 성립하는 Role별 경계:

```text
Planner    : 구현하지 않는다.
Builder    : 재기획하지 않는다.
Reviewer   : 직접 고치지 않는다.
Recorder   : 새로운 결정을 만들지 않는다.
```

### 3.1 Planner — 기획자

- **Purpose**: 사용자의 목표와 앞선 논의를 **실행 가능한 Task Contract로 변환**한다.
- **Inputs**: 사용자 요청, 관련 대화/토론, 확정된 Decision, Project Rules, 프로젝트 구조, 기존 Task.
- **핵심**: 토론 내용을 전부 결정사항으로 취급하지 않는다.
  - 사용자가 명시적으로 결정 → Constraint / Requirement
  - AI가 제안했지만 미확정 → 참고사항 / Open Question
- **Responsibilities**: 목표 확인, 확정/제안 구분, 범위 설정, 큰 작업 분해(하나의 Task가 하나의 명확한 목표를 갖고 독립 구현·검증 가능하도록 분해), 완료 조건 작성, 유지 동작 명시, 하지 말 일 명시, 위험/미확정 표시, `TASK.md` 작성.
- **Forbidden**: 코드 수정, 테스트 실행으로 구현, 범위 확대, 미확정 제안 확정, Builder/Reviewer 자동 호출.
- **Output contract**:
  - Machine-readable 제어 마커: `STATUS: PLAN_READY` 또는 `STATUS: NEEDS_DECISION`
  - Human-readable Markdown 본문 (`TASK.md` 원본 파이프라인 연계):
    ```text
    STATUS: PLAN_READY

    # TASK-xxx — [Task Title]

    ## Goal
    ...

    ## Requirements
    ...

    ## Constraints
    ...

    ## Acceptance Criteria
    ...

    ## Out of Scope
    ...

    ## Open Questions / Risks
    ...
    ```
- **Terminal**: `PLAN_READY` / `NEEDS_DECISION`

### 3.2 Builder — 구현자

- **Purpose**: 승인된 Task를 **최소한의 변경으로 정확하게 실행**한다.
- **Inputs**: Project Rules, Frozen Task Revision, Workspace.
- **Responsibilities**: Task·완료조건 읽기, 필요한 파일만 조사, 범위 내 구현, 관련 테스트 실행, 변경 보고, 완료조건 충족 보고.
- **Forbidden**: Task 재설계, 무관 리팩터링, "하는 김에" 추가, Reviewer 역할, 발견 문제 숨기기, 다음 Role 자동 호출.
- **Output contract**:
  - `STATUS: DONE` 반환 시:
    ```text
    STATUS: DONE

    Changed:
    - ...

    Tests:
    - ... (PASS / FAIL)

    Acceptance:
    - AC1 PASS
    - AC2 PASS
    ```
  - `STATUS: BLOCKED` 반환 시:
    ```text
    STATUS: BLOCKED

    Reason: ...
    Evidence: ...
    Work completed: ...
    Partial changes: ...
    Decision needed: ...
    ```
- **Terminal**: `DONE` / `BLOCKED`

### 3.3 Reviewer — 검토자

- **Purpose**: Builder의 설명을 신뢰하지 않고 **Task Contract와 실제 결과를 독립적으로 대조**한다.
- **Inputs**: Frozen Task Revision, Diff, Builder Test Result. 필요 시 관련 원본 코드·호출부·테스트(확장).
- **원칙**: **Diff-first, not Diff-only.** 시킨 일을 제대로 했는가(Requirement correctness) + 관련 다른 것을 망가뜨리지 않았는가(Regression correctness).
- **근거 강제**: 문제를 주장하면 파일:라인 / 문제 / 근거 / 영향.
- **Scope 구분**: Blocking(만족 못함·실제 회귀) / Non-blocking(개선 제안).
- **Forbidden**: 직접 수정, 범위 밖 제안을 Blocking으로 승격, 전체 감사로 확장, 근거 없는 위험 남발, Builder 설명만으로 PASS, FIX_REQUIRED 후 Builder 자동 호출.
- **Terminal**: `PASS` / `FIX_REQUIRED` / `UNKNOWN`

### 3.4 Recorder — 기록자

- **Purpose**: 확정된 프로젝트 상태만 압축해 **기록 초안(DRAFT)** 으로 만든다. 단순 채팅 요약이 아니다.
- **Inputs**: 확정된 Decisions, TASK.md, Run 결과, Review 결과, 사용자 승인 상태.
- **Responsibilities**: 프로젝트 목적, 유효 결정, 완료 Task, 중요 변화, 알려진 문제, 미해결 질문, 폐기/대체 결정.
- **Forbidden**: 미확정 제안을 확정으로 기록, 기존 결정 조용히 덮어쓰기, 새로운 기술적 판단 생성, 구현, Task 생성, 자동 저장/확정.
- **Output contract**:
  - Machine-readable 제어 마커: `STATUS: DRAFT_READY`
  - Human-readable Markdown 초안 본문:
    ```text
    STATUS: DRAFT_READY

    # Project Memory Update Draft

    ## Summary
    ...

    ## Confirmed Decisions
    ...

    ## Completed Tasks
    ...

    ## Known Issues / Open Questions
    ...
    ```
- **Terminal**: `DRAFT_READY` → 사용자가 [반영] / [수정] / [폐기] 선택.

> Recorder는 v1에서 **실행 블록이 PASS로 끝나면 그 블록의 마지막 단계로 자동 호출**되어 블록을 마무리한다. 자동 수정 루프에 끼어들지 않는 **블록 종착역** 역할이며, 사용자가 필요할 때만 별도로 호출(recordDiscussion)할 수도 있다. (기존 `proposed → 사용자 승인` 저장 구조를 그대로 유지)

---

## 4. Execution Control (프로그램 강제 규칙)

Role Contract는 프롬프트이고, Execution Control은 **프로그램(chat-room.js 등)이 강제하는 규칙**이다. AI가 프롬프트를 어기더라도 프로그램이 마지막 안전장치가 되어야 한다.

### 4.1 Terminal Status 표준

Reviewer의 판정 상태는 **세 개만** 유지한다. `UNKNOWN`을 별도 status로 늘리지 않는다.

```text
PASS
FIX_REQUIRED
UNKNOWN
```

프로그램의 실행 중단 사유는 별도 `stopReason` 필드로 두어 상태 종류를 늘리지 않는다.

```text
verdict: FIX_REQUIRED
stopReason: SCOPE_UNSPECIFIED   // Blocking issue 중 범위를 명시하지 않음
stopReason: SCOPE_OUT           // Blocking issue가 Task 범위 밖
stopReason: INSUFFICIENT_EVIDENCE // UNKNOWN
stopReason: LIMIT_EXCEEDED      // 자동 보완 한도 초과
stopReason: BLOCKED             // Builder가 작업 불능
```

### 4.2 Professional Mode Invariants

```text
1. Role 종료 상태는 프로그램이 명시적으로 파싱한다.
2. Role 결과 자체는 다음 Role을 자동 예약할 권한이 없다.
3. 어떤 Terminal Status에서도 기본 동작은 STOP → 사용자 반환이다.
4. 다음 실행은 사용자 명시 실행, 또는 사용자가 미리 승인한 Preset에 의해서만 시작된다.
```

### 4.3 Reviewer 출력 계약 (파싱)

Reviewer는 free-form 텍스트 위에 다음 구조를 반환한다. 프로그램은 **마커만 엄격히 읽고**, 구조화 섹션은 "있으면 사용, 없으면 SCOPE_UNSPECIFIED"로 처리한다. 한쪽이 깨져도 다른 쪽이 동작하도록 둘을 겹치지 않게 한다.

```text
VERDICT: FIX_REQUIRED

ISSUES:

1.
scope: IN
severity: BLOCKING
location: src/chat/chat-room.js:141 (예시: 검수 대상 코드 위치)
problem: ...
evidence: ...
impact: ...

2.
scope: OUT
severity: NON_BLOCKING
location: ...
problem: ...
```

### 4.4 자동 보완 Gate (모든 조건 통과 시에만 Builder 재실행)

```text
사용자가 제한 자동 실행 선택?        → YES
Reviewer == FIX_REQUIRED?          → YES
Blocking issue 존재?               → YES
모든 Blocking issue가 SCOPE:IN?    → YES
scope 누락 / UNKNOWN 없음?         → YES
Builder가 BLOCKED 아님?            → YES
자동 보완 횟수 남음?                → YES
                                  → Builder 보완

하나라도 아니면 → STOP → 사용자
```

### 4.5 Reviewer Result → 동작 매핑

```text
PASS
→ STOP → 사용자

FIX_REQUIRED + 모든 Blocking이 IN + 승인 + 횟수 남음
→ Builder 자동 보완

FIX_REQUIRED + Blocking 중 OUT 존재
→ STOP → 사용자 (사유: SCOPE_OUT)

FIX_REQUIRED + scope 누락
→ STOP → 사용자 (사유: SCOPE_UNSPECIFIED)

UNKNOWN
→ STOP → 사용자 (사유: INSUFFICIENT_EVIDENCE)

Builder BLOCKED
→ STOP → 사용자 (사유: BLOCKED)

자동 보완 한도 초과
→ STOP → 사용자 (사유: LIMIT_EXCEEDED)
```

### 4.6 BLOCKED 후속 사용자 경로

Builder가 `BLOCKED` 상태로 STOP했을 때, 프로그램은 사용자에게 다음 6가지 후속 액션 경로를 제공한다:

1. **[Planner에게 전달 (Handoff)]**: 기존 Frozen Task + BLOCKED Reason + Evidence + Partial Diff를 묶어 Planner에게 전달하고 재기획/분해 요청.
2. **[Task 직접 수정]**: 사용자가 `TASK.md` 파일의 요구사항이나 제약사항을 직접 편집.
3. **[부분 변경 보기]**: 현재까지 Builder가 수정한 partial diff 및 작업 내용 확인.
4. **[작업 전으로 복원]**: Turn Checkpoint를 이용해 Builder 실행 직전의 상태로 롤백.
5. **[현재 변경 유지]**: 현재 작업 상태를 그대로 두고 사용자가 직접 이어서 작업.
6. **[Task 폐기]**: 해당 Task 작업을 취소하고 초기화.

---

## 5. Terminal Status 요약

| Role | Terminal Status |
|---|---|
| Planner | `PLAN_READY` / `NEEDS_DECISION` |
| Builder | `DONE` / `BLOCKED` |
| Reviewer | `PASS` / `FIX_REQUIRED` / `UNKNOWN` |
| Recorder | `DRAFT_READY` |

> 기존 `REVISE`는 호환 alias로 유지한다. 내부 parser에서 `REVISE → FIX_REQUIRED`로 정규화한다. 새 코드는 `FIX_REQUIRED`만 사용하고, 예전 Provider 출력·테스트 호환을 위해 `REVISE`도 당분간 받는다.

---

## 6. 일반 대화 (이어 발언 / 독립 발언)

### 6.1 이어 발언 (Sequential) — 기존 유지

`@all` 요청 시 앞선 AI 답변을 다음 AI가 순차적으로 읽고 보완한다. 기존 동작 그대로 보존한다.

### 6.2 독립 발언 (Independent) — 구현 완료

`@all` 요청 시 **같은 턴의 다른 AI 답변(형제 메시지)을 서로 전달하지 않고**, 동일한 전(前) 턴 맥락 스냅샷만 보고 각각 독립 응답한다.

- **구현 지점**: [chat-room.js](../../src/chat/chat-room.js) `independent` 플래그와 `promptMessages(promptLimit, independent)`, [chat-prompt.js](../../src/chat/chat-prompt.js) broadcast 분기.
- **UI**: [chat.html](../../src/chat.html#L118) `@all 응답 방식` 토글 (이어 발언 / 독립 발언).
- **상태**: 구현 완료. 일반 채팅·토론의 순차 transcript 전달은 그대로 유지한다.

---

## 7. 메시지 전달 (Handoff)

Handoff는 Role이 아니지만 **전달 의도**가 필요하다. 대화 전체를 복사해 주입하는 대신 **메시지 ID 참조** 방식으로 전달하고, 40개 최근 맥락 창 밖으로 밀려난 경우에만 해당 메시지를 프롬프트 상단에 **핀 고정**한다.

### 7.1 v1 Handoff Intent (2개부터 시작)

```text
REVIEW_OPINION
→ 이 메시지를 다른 AI에게 보여주고 타당한 점/문제점/놓친 점을 검토하게 한다.

CONTINUE
→ 이 메시지를 출발점으로 선택한 AI에게 후속 작업을 맡긴다.
```

나중에 사용 패턴이 확인되면(RESPOND_TO_FEEDBACK, DISCUSS, TASK 생성 등) 별도 Intent로 추가한다. v1에서 전부 만들지 않는다.

### 7.2 UI 라벨

```text
[검토 요청]   → REVIEW_OPINION
[이어서 작업]  → CONTINUE
```

---

## 8. 데이터 & Task 저장소

### 8.1 TASK.md가 원본(SoT)

Task 관리는 workflow.json 중심에서 프로젝트 내 **`.project-memory/tasks/TASK-001.md` (Markdown)** 원본 체계로 전환한다.

### 8.2 Run 스냅샷 / Revision Freeze

Builder 실행 순간의 TASK-001.md를 `RUN-xxx/task.md`로 **동결 복사**한다. Reviewer는 항상 구현 당시의 요구사항을 기준으로 검수한다.

### 8.3 Turn Checkpoint (복원 요구사항)

Builder turn 실행 직전의 workspace 상태를 보존한다.

Retry 또는 Restore 시:
- Builder 실행 직전 상태로 복원한다.
- 실행 전부터 존재하던 사용자 변경(직접 수정한 파일 등)은 보존한다.
- workspace 전체를 HEAD로 되돌리는 destructive reset은 사용하지 않는다.
- v1 구현 방식은 현재 Git/workspace 구조에 맞는 가장 단순하고 안전한 방법을 선택한다.

**v1 구현 (`src/agora/turn-checkpoint.js`)**

- workspace가 **git 저장소일 때만** 동작한다. git이 아니거나 경로가 없으면 안전하게 건너뛴다(`supported: false`).
- checkpoint 생성: Builder 실행 직전에 세션 저장소 `.agora/sessions/<sessionId>/checkpoints/<checkpointId>/`에 manifest, `git stash create` baseline SHA, `tracked.patch`, untracked 파일 목록·내용을 원자적으로 보존한다. checkpoint ID는 내부 생성 opaque ID이며 절대 경로를 저널에 저장하지 않는다.
- 복원: tracked 파일을 `git checkout -- .`로 HEAD에 되돌린 뒤 checkpoint 시점 diff를 재적용해 **사용자 사전 변경은 보존**한다. Builder가 새로 만든 untracked 파일만 제거하고, 실행 전부터 있던 untracked 파일은 checkpoint 내용으로 되살린다. Run의 `task.md`, `task-hash`, `evidence.json`, `invalid.json`은 복원 시 보존한다.
- 전체 reset(작업 영역 전체를 HEAD로 되돌리기)은 사용하지 않는다.
- restore와 cleanup은 동일한 안전 경로 해석기를 사용하며 manifest/session/run/workspace 일치와 `..` 탈출을 검증한다. 세션 meta v3의 `professionalRun`이 실행 상태의 기준이며, 기존 `pendingRecovery`는 checkpoint 호환·복구 저널로만 유지한다. 앱 재시작 후 Provider를 자동 호출하지 않는다.
- git 저장소 판별은 `.git` 항목 존재 여부로 동기 확인하여, 일반(비-git) workspace에서는 git 프로세스를 실행하지 않는다. non-Git 검수는 현재 파일을 읽을 수 있지만 PASS를 자동 완료하지 않고 `DIFF_UNAVAILABLE` 사용자 확인으로 보낸다.

---

## 9. Capability 분리 (현재 permission cap)

Agora 에이전트는 실행 가능 능력이 서로 다르다(CLI 워크스페이스 vs 채팅 응답). 모델 유형(CLI/Chat)으로 고정하지 않고 **Capability**로 분리한다.

```text
Role ≠ Model ≠ Provider ≠ Transport ≠ Capability
```

Capability 예:

```text
workspaceRead      : true/false
workspaceWrite     : true/false
executeCommand     : true/false
runTests           : true/false
selfExploreWorkspace : true/false
```

현재는 다음 stage cap을 사용한다. 일반 채팅·토론에는 적용하지 않는다.

```text
planner         → workspace-read
plan_review     → workspace-read
implementation  → workspace-write
review          → workspace-read
recorder        → chat
```

세분 capability(예: 테스트 실행 가능 여부)는 향후 provider smoke 검증과 함께 확장한다.

---

## 10. Recorder — 블록 종료 시 자동 호출

- **실행 블록(구현→검토→보완)이 PASS로 끝나면, 그 블록의 마지막 단계로 기록관을 자동 호출**해 블록을 마무리한다. 자동 수정 루프에 끼어들지 않고, 블록의 종착역 역할을 한다.
- 사용자가 필요할 때만 별도로 호출(`recordDiscussion`)할 수도 있다.
- 기존 `proposed → 사용자 승인` 저장 구조와 [recorder-output.js](../../src/agora/recorder-output.js)를 유지한다.

---

## 11. v1 구현 TASK 목록

구현은 아래 순서로 진행한다. 각 TASK는 독립적으로 검증 가능해야 한다.

```text
TASK-000  P1 미해결 이슈 재확인 (범위 고정)
TASK-001  독립 발언 — 구현 완료 (커밋 6853c45)
TASK-002  전문 모드 자동 재시도 제어 (REVISE → FIX_REQUIRED 정규화, 기본 STOP) — 구현 완료
TASK-003  Reviewer 출력 계약 파싱 (VERDICT/ISSUES, scope, stopReason) — 구현 완료
TASK-004  전문 실행 3모드 (단계별 / 제한 자동 / 빠른 실행) + PLAN_READY 승인 Gate + resume — 구현 완료
          - Step-by-step / Bounded 선택
          - 자동 보완 N=0~3 (최초 1회 + 보완 N회, maxAutoRevisions 모델링)
          - Scope Gate (IN/OUT, UNKNOWN/누락 방지)
TASK-005  Planner 실행 경로 연결 (PLAN_READY / NEEDS_DECISION 및 Output Contract 파싱) — 구현 완료
TASK-006  Turn Checkpoint (pre-turn workspace 복원 요구사항 준수) — 구현 완료
TASK-007  TASK.md SoT + Run Freeze + BLOCKED 처리 및 후속 경로 — 구현 완료
TASK-008  Reviewer Contract 상세화 (diff-first, 근거 강제, scope 구분) — 구현 완료
TASK-009  Handoff (검토 요청 / 이어서 작업) — 구현 완료
TASK-010  Usage / Role UI (역할·모델·능력 표시) — 구현 완료
TASK-011  v1 패키징·릴리스 검증 — Windows portable build 검증 완료, 실제 회사 PC 최초 실행은 수동 확인 필요
```

---

## 12. 보존 및 변경 제한 (회귀 방지)

다음은 **절대 건드리지 않는다.**

- `[[CODEPET_DISCUSSION:...]]` 제어 태그
- `@mention` 기반 에이전트 호출
- 워크스페이스 권한 모드 (chat / workspace-read / workspace-write)
- 기존 대화 호환용 이모티콘 렌더링·이미지 (이미 제거된 애니메이션 대신 기본 이모티콘 사용)
- KaTeX 수식 렌더링

---

## 13. 테스트 기준

- 전체 `npm test` 통과 (현재 main의 테스트 수 기준)
- 독립 발언 테스트 추가
- 전문 모드 시그널 파싱 테스트 (PASS/FIX_REQUIRED/UNKNOWN, scope, stopReason)
- 순차 모드·토론 회귀 테스트 통과
- Professional Mode 변경 후 일반 채팅·토론의 권한, transcript, provider invocation 회귀 테스트 통과
- 데이터 손실 방지: 읽기 전용 강제, 저장 실패 롤백 유지

---

## 14. v1 범위 밖 (보류)

- 브로드캐스트 응답 순서 무작위화
- Builder의 그룹채팅 프레이밍·transcript·간결 지시 제거는 현재 구현에 반영됨. 일반 채팅 프롬프트는 변경하지 않는다.
- 총괄 PM 에이전트, 작업 목록 전체 UI 개편, 자동 연속 실행
- 세분 Capability 시스템 (v1에서는 기본 permission 모드 사용)
- Handoff 전체 Intent 집합 (v1은 검토 요청/이어서 작업만)
- Obsidian/Knowledge 통합 (v3)
- Playbook/autoresearch (v2)
