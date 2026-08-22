# Agora — Stage D Assurance & Governance Charter

> 상태: **확정 기준 문서 — v0.4 동결 (2026-08-20 사용자 승인)**
> 작성일: 2026-08-20
> 코드 baseline: Stage C COMPLETE @ `048dca0` (`origin/feat/multi-harness-runtime`)
> 관련 문서: [AGORA_V1_DESIGN.md](AGORA_V1_DESIGN.md) · [AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md](AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md) · [AGORA_STAGE_C_FINAL_REVIEW.md](AGORA_STAGE_C_FINAL_REVIEW.md) · [AGORA_STAGE_C_SESSION_LIFECYCLE_DECISIONS.md](AGORA_STAGE_C_SESSION_LIFECYCLE_DECISIONS.md)

구현 중 방향이 흔들리면 대화 기록이 아니라 **이 문서가 authority다.**
이 문서와 충돌하는 구현이 필요해지면 구현을 조용히 바꾸지 않고, 문서를 먼저 개정(사용자 승인)한 뒤 구현한다.

---

## 0. Agora의 목표

Agora는 여러 구독 CLI(Claude Code, Codex CLI, Antigravity)를 하나의 로컬 작업공간에서 결합해 쓰는 control plane이다.

1. **토론** — 여러 CLI 에이전트를 불러 의견을 묻고 토론시킨다.
2. **전문 실행** — 토론의 결정 또는 사용자의 기획으로 계약(Frozen Task)을 동결하고, 여러 에이전트를 결합해 기획·구현·검수·기록을 수행한다.
3. **장기기억** — 모든 과업이 기록되어 프로젝트의 장기기억이 되고, 새 CLI 세션이 헤매지 않고 이어서 일하게 한다. **(최종 목적지)**

전제 하나를 이 문서 전체에 적용한다.

> **Agora는 코딩 전용 도구가 아니다.**

전문 과업은 코딩일 필요가 없다. 통계 분석, 보고서 작성, 문서 제작, 데이터 가공, 리서치, QA, 파일 변환 같은 비코딩 과업이 **같은 계약·검증·권한·기록 경로**로 흘러야 한다. 이 문서의 모든 스키마·예시는 이 전제를 따르며, Git은 core authority가 아니라 workspace 변화 추적에 유용한 **optional adapter**다. Git이 없는 workspace는 기능이 정직하게 강등될 뿐 차단되지 않는다.

---

## 1. Stage D 정의

> **Stage D — Assurance & Governance**
>
> Agora가 전문 과업의 **검사 계약을 동결하고**, 실제 결과에 대해 **검사 가능한 것은 직접 검사하며**, 자동 판단할 수 없는 것은 반드시 올바른 판단 주체(Reviewer / 사용자)로 라우팅하고, Agent의 행동 권한과 결과의 근거 사슬을 통제하는 단계.

Stage C까지의 Agora가 "AI 실행을 안정적으로 관리하는 시스템"이었다면, Stage D 이후의 Agora는 "AI가 한 일을 독립적으로 확인하고, 행동 권한을 통제하며, 그 전 과정을 설명할 수 있는 시스템"이다.

핵심 분리는 이것이다.

```text
Agent: "일을 했고 요구사항을 충족했다."   (claim)

Agora: "동결된 검사를 실제 결과에 수행했고,
        남은 판단을 올바른 주체에게 전달했다."   (assurance)
```

---

## 2. 불변식 (Invariants)

**Stage D의 핵심 산출물은 verifier 라이브러리가 아니라 아래 불변식이다.**
이 불변식이 살아 있으면 predicate가 처음에 3개뿐이어도 시스템은 정직하다. 이것이 없으면 verifier를 50개 만들어도 "검증처럼 보이는 자동화"가 된다.

### INV-1 — 검사는 실행 전에 승인·동결된다

Verification Plan은 Task 승인 시점에 canonicalize되어 hash와 함께 동결된다.
그 뒤 Builder · Reviewer · auto-revision 루프 · Recorder **누구도 Verification Plan을 고칠 수 없다.**
Reviewer의 `FIX_REQUIRED (Scope: IN)`가 지시할 수 있는 것은 "산출물을 고쳐라"이지 "검사 항목을 바꾸자"가 아니다.
검사 자체를 바꿔야 한다면:

```text
REPLAN → 사용자 승인 → 새 Frozen Task / Verification Plan → 새 Run lineage
```

(lineage는 기존 `carriedFromRunId`의 의미 확장으로 기록한다.)

### INV-2 — 검증기는 Worker보다 강한 권한을 얻지 않는다

Verification이 governance 우회로가 되면 안 된다. 검증 권한은 `min(worker, workspace-read)`로 산정하며, **어떤 경우에도 workspace-write를 넘지 않는다.** 이 원칙의 적용 방식은 검증 backend에 따라 다르다.

```text
artifact-predicate 검증 (Agora 자체 read-only 평가):
  workspace mutation     NO — ENFORCEABLE
  실제 통제 수준         Agora 프로세스 안에서 읽기만 수행, 쓰기 경로 없음

process 검증 (외부 프로세스 실행):
  workspace mutation     OBSERVED-NOT-ENFORCED — OBSERVABLE
  Agora가 프로세스 내부의 fs write / network / credential 접근을
  OS 수준에서 막을 수 없다. 대신:
    · 실행 전후 fingerprint로 workspace 변경을 관측·기록한다 (side-effect accounting)
    · 변경이 관측되면 disposition을 격상할 수 있다 (D-A2)
    · env allowlist로 credential 노출을 최소화한다
    · shell 실행 파일 자체를 차단한다
    · argv가 참조하는 workspace 파일의 hash를 사전 검증한다
  OS-level containment(sandbox)는 D-B(Resource & Action governance)에서
  런타임 능력에 따라 추가한다.
```

모델이 임의로 작성한 검증 코드를 Agora 권한으로 실행하지 않는다. 검증 script는
**동결된 Verification Plan에 명시되어 사용자 승인을 받았거나, 승인된 verifier primitive**여야 한다.

### INV-3 — 자동으로 증명하지 못한 것은 VERIFIED라고 부르지 않는다

Agora가 기계적으로 증명할 수 없는 항목은 반드시 다른 판단 주체로 라우팅한다.

```text
기계적으로 증명된 사실          → VERIFIED
AI Reviewer가 판단할 것         → REVIEW_REQUIRED
사용자의 최종 판단이 필요한 것  → HUMAN_APPROVAL
```

**VERIFIED는 "통과"가 아니라 "기계적으로 확정됨"이다.** 검사가 무엇을 확정했는지(PASS/FAIL)는 outcome 축에 별도로 기록된다(R-7). 지원되지 않는 검사를 VERIFIED로 가장하는 것이 최악이다. 지원 가능한 검사를 과장하지 않는 것이 검사 개수보다 중요하다.

### INV-4 — Assurance ≠ 정답 보증 (경계 선언)

Agora가 보증하는 것은:

> **"승인되고 동결된 검사가 실제 대상에 대해 실제로 수행되었으며, 남은 판단 항목도 누락 없이 올바른 판단 주체에게 전달되었다."**

Verification Plan 자체가 충분하거나 올바르다는 것을 Agora가 자동 보증하는 것은 아니다. 검사 목록의 적절성은 승인 시점의 사용자(그리고 Plan Reviewer)의 몫이다.

### INV-5 — 모든 assurance 판정은 특정 결과 snapshot에 귀속된다

검사를 동결하는 것(INV-1)만으로는 부족하다. **검사받은 결과물 자체가 판정과 묶여야 한다.**
Builder 종료 시 Agora는 **Assurance Subject** — 실제 결과물의 fingerprint 집합 — 를 확정하고 `assuranceSubjectRef`를 만든다.

```text
subject 범위 = 선언된 Deliverables
             + checkpoint 이후 관측된 변경 집합
             (Agora가 관리하는 run artifact 경로는 제외)
```

criterion 결과 · Reviewer 판정 · Human approval은 전부 이 ref에 귀속된다.
재확인은 지속 감시가 아니라 **각 판정을 확정하는 경계 직전**에 수행한다. subject가 바뀌었으면 기존 판정은 자동으로 `INVALIDATED`되고 재검사가 필요하다. D-0 lease가 막지 못하는 변경(외부 에디터, lease 경계 밖 프로세스)도 이 계약이 잡는다.

```text
Frozen Task + Frozen Verification Plan + Bound Inputs
        ↓
     Builder
        ↓
Assurance Subject Snapshot     ← 결과물 fingerprint 고정
        ↓
 Verification
   ├─ outcome:     PASS / FAIL / ERROR / UNSUPPORTED / INVALIDATED
   └─ disposition: VERIFIED / REVIEW_REQUIRED / HUMAN_APPROVAL
        ↓
 Reviewer / Human resolution
        ↓
 fingerprint 재확인
        ↓
 Final disposition
        ↓
 Recorder → Derived Memory     (역방향 금지, R-5)
```

### 파생 규칙

- **R-1 · controlClass는 계산되지, 선언되지 않는다.** Plan이나 모델이 step에 "ENFORCEABLE"이라고 적어도 무효다. Agora가 backend의 실제 enforcement 특성에서 실행 시점에 도출하며, 불확실하면 아래로 강등한다(fail-closed floor).
- **R-2 · NEITHER인 verification step은 VERIFIED를 낼 수 없다.** 강제도 관찰도 못 했다는 것은 Agora가 그 검사를 수행하지 않았다는 뜻이므로, 결과가 아니라 자동 라우팅(REVIEW_REQUIRED / HUMAN_APPROVAL) 대상이다.
- **R-3 · planned와 actual은 분리 기록한다.** 계획된 방법·처분과 실제 방법·처분·강등 사유를 각각 남기고, 그 대조를 Reviewer에게 표시한다. 정직한 강등이 조용한 강등이 되면 안 된다.
- **R-4 · 검사 미정의는 차단이 아니라 정직한 라우팅이다.** 기계 검사가 정의되지 않았거나 capability가 없는 항목·과업은 fail-closed로 막지 않고 outcome=UNSUPPORTED로 명시해 REVIEW_REQUIRED로 보낸다. 여기서 차단을 택하면 비코딩 과업이 실질적으로 막힌다.
- **R-5 · derived memory는 단방향이다.** Frozen Task / 실제 결과 / Evidence / verdict → 증류 → Memory Bank. 역방향 금지 — Memory Bank가 새로운 truth source가 되면 authority hierarchy가 무너진다.
- **R-6 · memory는 verification evidence가 아니다.** derived memory는 orientation context로만 프롬프트에 들어가며, Reviewer의 판정 근거나 검증 결과로 역류하지 않는다.
- **R-7 · outcome과 disposition은 직교하는 두 축이다.** outcome(PASS/FAIL/ERROR/UNSUPPORTED/INVALIDATED)은 검사가 **무엇을 확정했는지**, disposition(VERIFIED/REVIEW_REQUIRED/HUMAN_APPROVAL)은 그 확정을 **누가/어떻게 내리는지**다. 둘을 한 필드에 섞지 않는다. `FAIL + VERIFIED`는 "자동검사로 요구사항 위반이 확정됨"이라는 정확한 의미가 되어 즉시 revision 경로로 보낼 수 있다.
- **R-8 · assurance 판정은 덮어쓰지 않는다.** criterion 실행 결과와 Reviewer/Human resolution은 append-only 기록이다. 재검사·revision·review resolution은 기존 결과를 수정하지 않고 **새 판정 기록을 추가**한다. 예: outcome=UNSUPPORTED가 Reviewer resolution으로 해소되어도 기존 UNSUPPORTED 기록은 provenance에 그대로 남는다 — "자동검사를 실제로 못 했었다"는 사실이 세탁되면 D-C의 "왜 PASS였는가"를 재구성할 수 없다. INV-5의 INVALIDATED도 같다: `PASS → INVALIDATED → 재검사 PASS` 세 기록이 모두 남는다.

---

## 3. Baseline — Stage C

```text
Stage C — Managed Harness Reliability
Status  : COMPLETE / BASELINE @ 048dca0 (origin/feat/multi-harness-runtime)
Review  : AGORA_STAGE_C_FINAL_REVIEW.md (FINAL PASS, 2026-08-20)
```

Stage D가 딛고 서는 기존 기반 (이미 존재, 재발명 금지):

```text
Frozen Task freeze + 같은 Run 내 재사용 + Builder/Reviewer 전후 무결성 검사
Task Contract validator (필수 섹션 구조 검증 — 비코딩 산출물 검증의 원형)
turn-checkpoint / restore (fail-closed)
workspace-diff (checkpoint 이후 변경 + 파일 해시)
evidence 축 (transport / declaration / changes / execution)
role별 permission cap + minPermissionMode 하향 결합
carriedFromRunId (Run lineage 필드)
Session lifecycle / hard account boundary / transaction admission gate
requestSingleInstanceLock (main process 단일 인스턴스)
```

Housekeeping (D-0 착수 전):

1. 로컬 `feat/multi-harness-runtime`를 `048dca0`로 fast-forward한 뒤 D-0 브랜치를 생성한다.
2. evolution log 헤더의 `Session Invalidation / Lifecycle NEXT`를 COMPLETE로 갱신한다.

---

## 4. 로드맵

```text
Stage C — COMPLETE (baseline)
    ↓
D-0  Workspace Mutation Lease
    ├──────────── M-track (M2·M3는 D-A와 병행 가능 · M1은 D-A1에 포함/선행)
    ↓
D-A0 → D-A1 → D-A2 → D-B → D-C
```

### D-0 — Workspace Mutation Lease

지금 존재하는 실제 동시-write 위험부터 닫는다. 이것은 Git lock이 아니라 **canonical workspace identity lock**이다.

```text
lease 참여자 (셋 모두 필수):

1. Professional 실행의 mutation~판정 구간 (verification 실행 포함)
2. Checkpoint restore          ← workspace 전체를 되돌리는 가장 큰 mutation
3. workspace-write 일반 채팅 turn
```

- 충돌 시 fail-closed(BUSY). 대기열·강탈 없음.
- 개념 API는 일반화 가능한 모양으로 내되, 구현은 workspace만 지원한다.

```text
acquireMutationLease({ resourceKind: "workspace", resourceId, runId | sessionId, role })
```

- lease는 memory-only다 (앱 크래시 시 자동 해소, Stage C registry 관행과 일치).
- **보증 경계:** 하나의 Agora main process 안에서 동일 canonical workspace를 공유하는 실행들. 이 경계는 `requestSingleInstanceLock`(main.js)으로 뒷받침된다. cross-process governance는 범위 밖이다.

### M-track — Long-term Project Memory

목표 3기둥 중 최종 목적지(장기기억)를 직접 때리는 소규모 트랙. D-C가 필요로 하는 계보 데이터를 미리 만든다.

```text
M1  토론 결정 ↔ Frozen Task 링크 (decisionIds)
M2  완료 Run → derived Memory Bank 증류
    (현재 append-only + 꼬리 16KB 주입의 유실 구조 해소)
M3  opt-in AGENTS.md / CLAUDE.md export
```

- 구현 순서 주의: **M1은 Frozen Task schema를 건드리므로 D-A1 schema v2에 포함하거나 그 직전에 선행한다.** 병렬 branch에서 동시에 건드리면 migration/validator 충돌이 난다. M2·M3만 D-A와 진짜 병렬이다.

Memory 규칙 (R-5, R-6 적용):

- Memory Bank에는 두 계급이 있다. **human-authored**(사람이 추가, canonical 원천 그 자체)와 **derived**(Run에서 증류). 단방향·역추적 불변식은 derived 계급에 적용된다.
- derived memory item은 어디서 왔는지 역추적 가능해야 한다:

```text
memoryId
sourceRunIds
decisionIds
sourceEvidenceRefs
derivedAt
summary
```

- `AGENTS.md` / `CLAUDE.md`는 canonical memory가 아니라 **Memory Bank + Project Policy에서 생성하는 opt-in materialized view**다. 파일이 삭제되거나 오래돼도 canonical state를 잃지 않으며 재생성하면 된다.

### D-A0 — Verification Safety Boundary

검증을 실행하기 전에, 검증이 안전하도록 만드는 최소 기반. **완성형 D-B가 아니다.**

- **runtime capability discovery** — portable exe 환경에서 Python/R/Office의 존재를 가정하지 않는다. 검증 가능 범위는 실측된 capability가 정한다. capability 스냅샷은 검증 실행당 1회 기록하고 각 step이 참조한다.

```text
VerificationCapabilities (예)

process.node      AVAILABLE
process.python    UNAVAILABLE
artifact.text     AVAILABLE
artifact.json     AVAILABLE
artifact.xlsx     UNAVAILABLE
```

- **verification control class** — 각 step 실행에 ENFORCEABLE / OBSERVABLE / NEITHER를 기록한다. 이것은 엔진 타입 상수가 아니라 **실행 당시 backend의 실제 enforcement 특성**이다(R-1). 판정은 "subprocess 전체 = OBSERVABLE" 같은 통 분류가 아니라 resource/action 차원의 실제 통제 가능성에서 계산하며, D-B가 세분화된 통제 신호를 제공하면 그 신호로 재계산한다. 그 전까지의 baseline: Agora 내부 read-only predicate → ENFORCEABLE, 일반 subprocess → OBSERVABLE.
- **verification privilege containment** — INV-2의 강제 지점. verifier ≤ worker.
- **Verification Runner Contract** — process 검증 step은 shell 문자열이 아니라 구조화 실행으로만 만든다.

```text
executable + argv + cwd + timeout   (shell 문자열 금지 — 기존 execFile/assertSafeArgv 관행과 일치)
승인된 script는 path가 아니라 script hash까지 freeze
  → 실행 시 hash 불일치면 실행하지 않는다
env 전달 범위 명시 (기본: 최소 allowlist)
stdout/stderr 크기 상한
timeout 시 process tree 전체 kill
```
- **verification side-effect accounting** — 프로세스 검증은 임시 파일 등으로 workspace를 오염시킬 수 있다. Reviewer용 diff는 **검증 실행 전에 확정**하거나, 검증 전후 fingerprint로 검증기 부수효과를 Builder 변경과 분리 표기한다.

### D-A1 — Assurance Contract

Frozen Task 안의 `Verification`을 독립된 assurance contract로 승격한다.

**Task schema v2:**

```text
Goal
Inputs / Source Data        ← 신설: 비교·대조 검사의 기준 자원
Requirements
Work Approach               ← Implementation Approach의 일반화
Deliverables                ← 신설
Acceptance Criteria
Verification Plan           ← 구조화된 검사 계약으로 승격
Out of Scope

Affected Modules → Affected Resources (일반화)
```

- **Inputs와 Deliverables는 "없음"도 명시적 선언이다.** 생략과 "없음 선언"을 구분해야 부재가 실수가 아닌 결정이 된다. 명시적 빈 선언을 허용해 소형·비코딩 과업의 fail-closed 과잉을 막는다(R-4).
- **Input binding:** 입력마다 binding mode를 선언한다. `frozen input`은 freeze 시점에 fingerprint를 남기고, URL·API처럼 동적인 `live input`은 실제 retrieval 시점의 version/etag/content hash를 기록한다. 모든 입력을 freeze하라는 뜻이 아니다 — "같은 Task인데 왜 결과가 달라졌는가"에 기록으로 답할 수 있으면 된다.
- **frozen input 재대조:** fingerprint를 남기는 것만으로는 frozen이 아니다. frozen input은 **Builder admission 시 freeze fingerprint와 재대조**하고, 불일치하면 Run을 시작하지 않고 REPLAN/재승인 경로로 보낸다. Final PASS 확정 전에도 재확인하며, Run 도중 변경이 확인되면 해당 assurance는 INVALIDATED된다. 검사 대상은 선언된 input뿐이므로 전체 workspace hashing 비용 문제는 없다. 의미 계약: `frozen` = 동일한 입력이어야 한다 / `live` = 달라도 되지만 실제로 무엇을 사용했는지 기록한다.
- Verification Plan은 criterion 목록으로 구조화된다(스키마는 5절).
- freeze 절차:

```text
Task 승인
  → Verification Plan canonicalize
  → task hash + verification hash
  → FREEZE
  → Builder 시작
```

- 이후 immutable (INV-1). 검사 변경은 REPLAN 경로만.
- **schema migration:** 동결된 과거 task는 **절대 제자리 마이그레이션하지 않는다.** schemaVersion은 freeze 시점에 스탬프되고, 옛 Run은 자기 스키마로 검증된다. transition 기간에는 v1 섹션명 alias를 허용한다.

### D-A2 — Verification Core

**엔진은 둘뿐이다.** 도메인 지식은 Agora core가 아니라 Frozen Task의 검사 계약이 공급한다.

```text
1. Process Verification Engine
   선언된 검증 프로세스를 실행하고 실제 결과를 포착
   (started/finished, exit status, stdout/stderr, duration, provenance)

2. Artifact Predicate Engine
   산출물을 읽고 명시적으로 선언된 술어를 평가

   exists(output.xlsx)
   row_count(result.csv) == row_count(input.csv)
   document_has_section("제한점")
   extract(A1) == 120
   hash(file) == expected
```

- 확장은 **Extractor / Predicate / Comparator 라이브러리**로 한다. `ExcelVerifier`, `ResearchVerifier` 같은 도메인 Verifier 클래스를 core에 추가하지 않는다.
- **SourceVerifier는 만들지 않는다.** 출처의 존재·연결(인용 항목 존재, URL 응답, citation key 참조)은 술어로, 내용적 적절성("주장이 근거에 의해 지지되는가")은 REVIEW_REQUIRED로 처리한다.
- **Disposition Router는 모든 검사 위의 상위 라우터다** (verifier의 형제가 아니다).

```text
                 Frozen Verification Plan
                           │
                ┌──────────┴──────────┐
       Process Verification    Artifact Predicate
                └──────────┬──────────┘
                     Criterion Result
                           │
                   Disposition Router
             ┌─────────────┼─────────────┐
         VERIFIED   REVIEW_REQUIRED   HUMAN_APPROVAL
```

- 실행 시 actual 기록(criterionOutcome / actualMethod / actualDisposition / downgradeReason / controlClass)을 남기고 planned와 대조해 Reviewer에게 표시한다(R-3, R-7).
- 초기 predicate 최소셋: 파일 존재 · 해시 · 텍스트 구조 · JSON · CSV 수준. xlsx/docx/pdf는 runtime capability가 확보될 때만.

**Final disposition 집계 규칙** — criterion별 판정이 Run의 최종 PASS로 승격되는 조건은 묵시가 아니라 계약이다.

```text
1. outcome = FAIL(자동검사)이 하나라도 있으면 PASS 금지 → revision 경로
2. outcome = ERROR / UNSUPPORTED가 미해결이면 PASS 금지
   → 재실행하거나 REVIEW_REQUIRED로 해소한다
   (해소는 기존 기록의 수정이 아니라 새 판정 기록의 추가다 — R-8)
3. disposition = REVIEW_REQUIRED가 남아 있으면 Reviewer resolution 전 PASS 금지
4. disposition = HUMAN_APPROVAL은 사용자 승인 전 PASS 금지
5. 모든 판정이 동일한 assuranceSubjectRef에 귀속되고, 최종 확정 직전
   subject 및 frozen input fingerprint 재확인을 통과할 때만 Final PASS (INV-5)
6. subject가 바뀌면 관련 판정은 INVALIDATED — 어떤 판정도 자동 승격되지 않는다
```

### D-B — Resource & Capability Governance

- capability model을 resource/action 일반형으로 확장하고, D-0의 mutation ownership을 일반화한다.
- **모든 resource/action 조합에 Control Class를 붙인다.** 강제할 수 없는 권한 선언은 governance가 아니라 희망사항이다.

| 행동 | 강제? | 관찰? | 처리 |
|---|---|---|---|
| local workspace write (managed path) | 가능 | 가능 | 자동 가능 |
| local verification read | 가능 | 가능 | 자동 가능 |
| subprocess의 임의 네트워크 전송 | 불완전 | 불완전 | 자동 신뢰 금지 |
| 외부 이메일 발송 | 불가 | 도구별 상이 | **사전 승인** |
| 임의 외부 문서/DB mutation | 연결 방식별 상이 | 불확실 | 자동 진행 금지 |

- **side effect + NEITHER ⇒ 행동 전 HUMAN_APPROVAL.** 사후 자기보고("아무튼 보냈다고 하네요")를 verified evidence로 승격하지 않는다.
- 되돌릴 수 없는 외부 행동에는 사후 검증을 붙이려 하지 않는다 — 사전 승인이 유일한 통제다.

### D-C — Provenance & Audit

앞의 모든 것을 하나의 추적 가능한 provenance graph로 연결한다. M-track이 만든 링크(sourceRunIds, decisionIds)를 정식 그래프로 승격한다.

```text
decision → task → run → inputs → capabilities → mutations
        → verification → review → memory
```

목표: **"왜 PASS였는가?"를 기록만으로 재구성할 수 있다.**

```text
RUN-123
  Frozen Task hash / Verification Plan hash / Inputs fingerprints
  Executor capability / Workspace lease
  Criterion C-01  process verification   VERIFIED
  Criterion C-02  artifact predicate     VERIFIED
  Criterion C-03  semantic adequacy      REVIEW_REQUIRED
  Reviewer PASS
  Human approval (필요 시)
  Final disposition
```

단, provenance event의 emit은 D-C에서 몰아 만들지 않는다. **D-0 / D-A / D-B 각각의 완료 조건에 자기 결정 시점의 기록이 포함된다.** D-C는 그것을 읽는 그래프와 뷰다.

- Run lineage는 `carriedFromRunId`의 의미 확장을 계속 늘리지 않고, D-C에서 `parentRunId + lineageRelation (replan | retry | revision | carry)` typed edge로 승격한다. `carriedFromRunId`는 호환 필드로 유지한다.
- 구현은 **append-only provenance events를 logical graph로 projection**하는 것으로 충분하다. graph DB 도입은 non-goal이다.

---

## 5. 개념 스키마

구현 시 세부 필드명은 feature branch에서 확정하되, **의미 계약은 이 문서를 따른다.**

### Verification Plan criterion (freeze 시점)

```text
criterionId          C-01
statement            "결과표 수치는 분석 산출물과 일치해야 한다"
plannedMethod        process | predicate | review | human
plannedDisposition   VERIFIED | REVIEW_REQUIRED | HUMAN_APPROVAL
step 선언            (method가 process/predicate일 때: backend, arguments, 대상 경로/자원)
```

### Verification 실행 기록 (per criterion)

```text
criterionId
criterionOutcome       PASS | FAIL | ERROR | UNSUPPORTED | INVALIDATED   (R-7)
actualMethod
actualDisposition      VERIFIED | REVIEW_REQUIRED | HUMAN_APPROVAL
downgradeReason        (planned와 다를 때 필수)
controlClass           ENFORCEABLE | OBSERVABLE | NEITHER   ← Agora가 계산 (R-1)
capabilitySnapshotRef  (검증 실행당 1회 기록된 runtime capability 참조)
assuranceSubjectRef    (판정이 귀속되는 결과 snapshot — INV-5)
결과 상세              (exit/stdout digest 또는 predicate 평가값)
provenance             (실행 주체=Agora, 시각)
```

### Assurance Subject (Builder 종료 시)

```text
assuranceSubjectRef
boundRunId
createdAt
fingerprints           (Deliverables + 관측된 변경 집합의 파일별 hash)
excludedPaths          (Agora-managed run artifact 경로)
```

### Input binding 기록

```text
inputId
mode                   frozen | live
frozen  → fingerprint    (freeze 시점 hash)
live    → retrievalMeta  (version / etag / content hash, retrievedAt)
```

### Derived memory item

```text
memoryId
sourceRunIds
decisionIds
sourceEvidenceRefs
derivedAt
summary
```

---

## 6. 단계 완료 기준 (공통 DoD)

Stage C에서 확립된 관행을 그대로 유지한다.

1. 단계별 feature branch로 작업한다.
2. **actual-diff 독립 검수 PASS** (자기보고가 아닌 원격 실제 diff 기준).
3. canonical `npm test` GREEN (사용자 Windows 로컬 실측).
4. 해당 단계의 주요 결정을 decision log에 **결정 시점에** 기록한다 (사후 소급 금지).
5. 이 charter와 충돌이 발견되면: 구현이 아니라 **문서를 먼저 개정(사용자 승인)** 후 진행한다.

---

## 7. 제외 목록 (Non-goals)

```text
NO domain verifier zoo                    (도메인 Verifier 클래스를 core에 추가하지 않는다)
NO SourceVerifier                         (내용 적절성은 REVIEW_REQUIRED다)
NO premature general Resource Registry    (D-B 전까지 workspace만)
NO Git-as-core-authority                  (Git은 optional adapter다)
NO Codex account subsystem expansion      (기능 성장 동결)
NO ambient/pet dependency in core         (best-effort 장식으로 격리)
NO xlsx/docx/pdf promises before runtime capability exists
NO graph database for provenance          (append-only events의 logical projection으로 충분)
NO cross-process workspace governance     (v1 보증 경계 밖)
```

---

## 8. 문서 개정 규칙

- 이 문서의 개정은 사용자 승인을 요구한다.
- 개정 시 개정 사유와 날짜를 문서 하단에 누적 기록한다.
- 불변식(2절)의 삭제·완화는 일반 개정보다 무겁게 다룬다: 해당 불변식이 막고 있던 실패 모드를 명시하고, 그것을 대체하는 통제를 함께 제시해야 한다.

---

## 9. UX 원칙 — Progressive Disclosure

**Stage D의 복잡도는 사용자가 아니라 Agora가 부담한다.** 내부 어휘(controlClass, assuranceSubjectRef, fingerprint, lease, provenance event 등)는 엔진 상태이며 UI에 그대로 노출하지 않는다. 정상 경로의 사용자 감각은 Stage C와 동일해야 한다: 추가 조작 0회, 계획 승인 1회, 완료 화면은 요약 + 원할 때만 [검증 상세].

사용자 재개입은 세 가지뿐이다.

```text
1. 계약 변경 (REPLAN — 변경 이유와 검사 diff를 보여주고 재승인)
2. 되돌릴 수 없는 외부 행동 (HUMAN_APPROVAL)
3. 인간만 판단할 수 있는 criterion
```

- **P-1 · projection은 압축이지 생략이 아니다.** 모든 criterion은 승인 표면에서 추적 가능해야 하며(INV-4), 동일 성격의 criterion은 의미를 잃지 않는 범위에서 그룹화할 수 있다. 그룹화한 경우 펼치면 각 criterion과 1:1 대응을 확인할 수 있어야 한다. Inputs·Deliverables는 압축본에도 반드시 보인다(INV-5·frozen input의 대상).

```text
완료 확인 (예)
- 테스트 실행 및 통과 확인 (8)
- 산출물 구조/파일 검사 (4)
- 내용 품질 Reviewer 검토 (2)
[14개 검사 상세]
```

- **P-2 · 정직한 강등은 요약에서도 보인다.** 처분 구성(자동 / Reviewer / 사용자)을 하나의 "✓"로 합치지 않는다. "✓ 6개 검사 통과"가 아니라 "자동 확인 4 · Reviewer 판단 2 · 사용자 승인 0"이다. 이것은 UX 취향이 아니라 **R-3의 표현 계층 보존**이다 — UI 단순화를 명분으로 `UNSUPPORTED → Reviewer PASS`를 초록 체크 하나로 세탁하는 것을 막는다.
- **P-3 · 계획된 Human 개입은 사전 예고한다.** 계획 승인 화면에서 예정된 사용자 승인 지점(HUMAN_APPROVAL criterion)을 미리 보여준다. REPLAN은 실행 중 발견되는 조건부 사건이므로 횟수를 약속하지 않고 "계약 변경 시 별도 재승인이 발생할 수 있음"으로 표기한다. Planner는 불필요한 human criterion을 만들지 않는다 — 승인 남발은 rubber-stamp를 만들고 안전장치를 무력화한다.

```text
예정된 사용자 승인: 1회
- 외부 이메일 발송 전
※ 계약 변경이 필요한 경우 별도 재승인이 발생할 수 있음
```

- **P-4 · Task schema 작성 비용은 Planner가 부담한다.** 사용자는 자연어로 요청하고 압축 승인 카드만 본다. Inputs / Deliverables / Acceptance Criteria 등 섹션 폼을 사용자에게 채우게 하지 않는다.

---

## 초안 이력

- 2026-08-20 · v0.1 최초 초안.
- 2026-08-20 · v0.2 사용자 검토 반영: INV-5(Assurance Subject) 신설 · outcome/disposition 축 분리(R-7) · Verification Runner Contract 추가 · Final disposition 집계 규칙 추가 · Input binding(frozen/live) 구분 · M1을 D-A1에 포함/선행으로 재배치 · typed lineage edge(D-C) · provenance graph DB 금지.
- 2026-08-20 · v0.3 최종 보강 및 **동결**: frozen input admission/최종 재대조 규칙 추가 · R-8(판정 append-only) 신설. 이 버전으로 사용자 승인.
- 2026-08-20 · v0.4 개정(§8 규칙에 따른 사용자 승인): **§9 UX 원칙 — Progressive Disclosure** 추가. P-1 전 criterion 추적 가능·그룹화 허용, P-2 처분 구성 숨김 금지, P-3 계획된 Human 개입 사전 예고·REPLAN은 조건부, P-4 schema 작성 비용은 Planner 부담. 이후 UX 원칙 추가는 동결하고 D-0 구현으로 이행한다.
- 2026-08-22 · v0.5 개정(§8 불변식 완화 절차 · 사용자 승인): **INV-2 containment/accountability 구분 명시.** 기존 INV-2의 `workspace mutation NO`는 artifact-predicate(ENFORCEABLE)에서만 문자 그대로 강제되며, process 검증은 OS-level sandbox 없이 강제 불가하므로 OBSERVABLE로 정직하게 기록한다. **막고 있던 실패 모드**: 검증 프로세스가 workspace를 임의 수정. **대체 통제**: (1) side-effect accounting — 실행 전후 fingerprint 대조로 변경을 관측·기록, (2) env allowlist — credential 누출 최소화, (3) shell 차단·argv hash binding — 임의 명령 실행 방지, (4) 변경 관측 시 disposition 격상(D-A2), (5) OS-level containment는 D-B로 이연. INV-3("증명 못 하면 VERIFIED라 부르지 않는다")과 같은 방향: 못 막는 것을 막는다고 말하지 않는다.
