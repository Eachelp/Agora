# Agora Stage D — Assurance & Governance Decision Log (D-A1 · D-A2 · D-B · D-C)

> 상태: **구현 완료 · 독립 검수 대기**
> 최초 기록: 2026-08-24
> 기준 브랜치: `feat/stage-d-assurance-governance`
> 상위 기준 문서: [AGORA_STAGE_D_ASSURANCE_CHARTER.md](AGORA_STAGE_D_ASSURANCE_CHARTER.md) (v0.5)
> 직전 baseline: D-A0 COMPLETE `35b2fee`
> 선행 결정 기록: [D-0](AGORA_STAGE_D0_WORKSPACE_LEASE_DECISIONS.md) · [D-A0](AGORA_STAGE_DA0_VERIFICATION_BOUNDARY_DECISIONS.md)

이 문서는 Stage D 잔여 전체(D-A1 → D-A2 → D-B → D-C)에서 확정된 **아키텍처 결정,
버린 대안, 보증 경계, 의도적으로 하지 않은 것**을 기록한다(Charter §6 DoD 4).

코드 세부는 Git history와 테스트가 source of truth다. 여기에는 왜 그렇게 했는지와
다음 사람이 무엇을 뒤집으면 안 되는지를 남긴다.

---

## 1. 전체 구조

```text
Decision(D-xx)
   ↓  M1
Frozen Task v2 + Frozen Verification Plan + Bound Inputs     ← D-A1
   ↓  admission (frozen input 재대조)
Builder                                                       ← 기존 Stage C
   ↓
Assurance Subject Snapshot                                    ← D-A2 / INV-5
   ↓
Process Engine  ·  Artifact Predicate Engine                  ← D-A2
   ↓  (capability snapshot 1회 고정)
Disposition Router                                            ← D-A2 / R-2·R-3·R-7
   ↓
Reviewer / Human Resolution  (append-only)                    ← D-A2 / R-8
   ↓
Subject + Frozen Input recheck                                ← D-A2 / §16
   ↓
Final Disposition (9 규칙)                                     ← D-A2 / §18
   ↓
Recorder → Append-only Provenance → "왜 PASS였는가"            ← D-C
```

자원·행동 심사(D-B)는 이 흐름 옆에 붙는 별도 계층이 아니라 **controlClass의 단일
권위**로서 위 사슬 안에 들어간다(§22).

---

## 2. D-A1 — Assurance Contract

### 2.1 schema v2는 어휘를 중립화한다

```text
Implementation Approach  →  Work Approach
Affected Modules         →  Affected Resources
Verification             →  Verification Plan
(신규) Inputs / Source Data · Deliverables
```

이름 변경은 취향이 아니다. "Implementation"과 "Modules"는 **과업이 코드라고
전제한다.** 번역·조사·보고서 과업이 같은 계약 경로로 흐르려면 어휘가 중립이어야
한다. 이 전제가 스키마에 남으면 evidence·Reviewer 프롬프트·감사 기록까지 상속되어
Agora가 사실상 코딩 도구로 굳는다.

### 2.2 migration 전략 — 읽기 어댑터이지 변환이 아니다 (§6)

```text
옛 Frozen Task   →  schemaVersion 1 그대로. 파일을 다시 쓰지 않는다.
새 Frozen Task   →  schemaVersion 2
전이기 alias     →  v1 헤딩을 v2 의미로 **읽어만** 준다
```

이미 동결된 계약을 다시 쓰는 것은 "그때 승인받은 것"을 파괴하는 일이다. 그래서
`SECTION_ALIASES`는 읽기 전용이고, 어떤 경로도 과거 task.md를 덮어쓰지 않는다.
v1 Task는 `mode: "legacy"`로 흘러 **아무것도 막지 않는다.**

기존 `task-contract-validator`도 두 어휘를 모두 받도록 확장했다. 이것이 없으면
v2 계약이 freeze 단계에서 거부되어 Stage D가 실전에서 아예 켜지지 않는다.

### 2.3 생략과 "없음"은 다른 의미다 (§3.1)

```text
declared   실제 항목이 있음
none       "없음"이라고 명시함
missing    섹션이 없거나 비어 있음 → 계약 불완전
unparsed   본문은 있는데 항목을 못 읽음 → 계약 불완전
```

둘을 같게 처리하면 Planner가 **입력 검토를 건너뛴 것**을 "입력이 없는 과업"으로
위장할 수 있다. `unparsed`를 따로 둔 것도 같은 이유다 — 파싱 실패를 조용히 "없음"
으로 만들지 않는다.

### 2.4 frozen / live input 의미 계약

```text
frozen   "동일한 입력이어야 한다."
         freeze 시 fingerprint → Builder admission 직전 재대조
         → Final PASS 직전 재대조. 불일치면 실행하지 않는다.

live     "달라도 되지만 실제로 무엇을 썼는지는 남긴다."
         freeze hash 강제하지 않음. retrieval마다 metadata 기록.
```

**fingerprint를 기록만 하는 것은 frozen이 아니다.** 재대조가 있어야 frozen이다.

기본값은 파일=frozen, URL=live로 두었다. 파일은 "같은 내용이어야 한다"가 자연스러운
기대이기 때문이다. `frozen`으로 선언된 URL은 Agora가 내용을 고정할 수단이 없으므로
조용히 live로 바꾸지 않고 `UNSUPPORTED`로 남긴다.

### 2.5 Verification Plan canonicalization과 hash

criterion 배열을 정규형(키 순서 정렬, 공백 무관)으로 만든 뒤 hash한다. 표기가 달라도
같은 계획이면 같은 hash이고, 의미가 달라지면 hash가 달라진다.

`contractHash = hash(taskHash + planHash + inputs + deliverables)`가 계약 전체의
지문이다. 이 값이 달라지면 "다른 계약"이다.

### 2.6 산문 계획은 실패가 아니라 강등이다 (R-4)

```json
[{"id":"V1","method":"process","statement":"...","executable":"npm","argv":["test"]}]
```

JSON 블록이 없으면 **실패시키지 않는다.** 산문 계획 전체를 하나의 review criterion
으로 강등하고 그 사실을 기록한다. 여기서 fail-closed를 택하면 비코딩 과업이
실질적으로 막힌다.

### 2.7 method가 계획 처분을 정한다

Plan이 `"method":"review","plannedDisposition":"VERIFIED"`라고 적어도 무효다.
처분은 method에서 도출한다. 모델의 자기 선언을 계약으로 받아들이면 INV-3이 무너진다.

### 2.8 M1 — 토론 결정 링크는 D-A1 안에서 함께 했다 (§4)

`decisionIds`는 Task schema를 건드리므로 별도 M-track으로 분리하지 않고 v2에 포함했다.
`결정: D-12, D-15` 같은 자연스러운 표기를 어디에 적어도 읽는다.

---

## 3. D-A2 — Verification Core

### 3.1 Assurance Subject 범위 (INV-5)

```text
subject = 선언된 Deliverables
        + checkpoint 이후 관측된 변경 집합
        - Agora가 관리하는 run/checkpoint/provenance artifact
```

**Agora 자신의 기록물을 빼지 않으면** evidence를 쓰는 행위가 subject를 바꿔 자기
자신을 INVALIDATED시킨다. 제외 목록은 `.project-memory/runs`, `.project-memory/checkpoints`,
`.agora`다.

Git은 optional adapter다. non-Git workspace에서도 Deliverables 지문은 그대로 뜨고,
변경 관측만 안 된다는 사실을 `changeObservation`에 정직하게 남긴다.

### 3.2 엔진은 둘뿐이다

도메인 Verifier(ExcelVerifier · ResearchVerifier · CodeVerifier …)를 core에 만들지
않는다. 확장은 Extractor + Predicate + Comparator 조합이며 도메인 지식은 Frozen
Task가 공급한다.

SourceVerifier도 만들지 않았다(§10). URL/citation의 **존재**는 predicate로 확인하고,
"이 출처가 주장을 뒷받침하는가"는 REVIEW_REQUIRED다.

### 3.3 초기 predicate 어휘

```text
exists · absent · hash
text.contains · text.matches · text.section · text.lines
json.path
csv.rows · csv.column
```

`text.section`과 `csv.*`를 1급으로 넣은 것은 의도적이다 — 문서·데이터 산출물 검사가
"부가 기능"이 아니라 기본이어야 Agora가 코딩 도구로 좁아지지 않는다.

xlsx/docx/pdf는 runtime capability가 없으므로 억지 지원하지 않고 `UNSUPPORTED`로
강등한다. CSV 파서는 따옴표·이스케이프를 다루는 최소 구현을 직접 넣었다(새 의존성 없음).

### 3.4 actual result는 append-only다 (R-8)

```text
나쁜 예   UNSUPPORTED → Reviewer PASS 로 덮어쓰기
옳은 예   execution(UNSUPPORTED) 유지 + resolution(PASS) 추가
```

`AssuranceLedger`에는 기록을 지우거나 고치는 메서드가 없다. `effectiveFor`는
"최신을 고르는" 조회이며 기록을 소비하지 않는다. `PASS → INVALIDATED → 재검사 PASS`
세 기록이 모두 남는다.

resolution 기록에는 `actualDisposition`이 없으므로, `effectiveFor`가 마지막
execution의 라우팅 정보를 함께 실어 보낸다. 이것이 없으면 §9 P-2의 처분 구성이
"✓" 하나로 뭉개진다.

### 3.5 Disposition Router 규칙

```text
review / human 계획      → 그대로 통과 (검사 대상이 아니다)
INVALIDATED              → 자동 확정 불가 → 강등
controlClass = NEITHER   → VERIFIED 금지 (R-2)
PASS / FAIL 아닌 outcome → VERIFIED 금지 (INV-3)
그 외                    → VERIFIED (PASS든 FAIL이든)
```

`FAIL + VERIFIED`는 모순이 아니라 "자동검사로 요구사항 위반이 확정됨"이라는 정확한
의미다(R-7). VERIFIED는 "통과"가 아니라 "기계적으로 확정됨"이다.

### 3.6 Final PASS 집계 (§18)

9가지 조건을 `final-disposition.js`에 명시적으로 구현했다. 특히:

- 계획된 criterion에 **판정 기록이 아예 없으면** 통과로 세지 않는다.
- 다른 subject에 귀속된 판정은 이 결과물에 대한 판정이 아니다(`SUBJECT_MISMATCH`).
- 동결된 계획이 실행 중 바뀌면 그 위의 모든 판정이 무의미하므로 `PLAN_TAMPERED`.
- 결과물/입력 변경은 `BLOCKED`가 아니라 `INVALIDATED`로 구분해, UI가 "검사가 남았다"와
  "재검사가 필요하다"를 다르게 안내할 수 있게 했다.

---

## 4. D-B — Resource & Capability Governance

### 4.1 controlClass의 단일 권위

`resource-governance.computeResourceControlClass()`가 유일한 계산 지점이다.
verification-core는 여기에 위임한다. **같은 질문에 두 개의 답이 생기면 그중 하나는
반드시 틀린다.**

```text
Agora 내부 artifact read           → ENFORCEABLE  (쓰기 경로 자체가 없다)
managed workspace mutation + lease → ENFORCEABLE  (D-0 lease가 실제로 막는다)
lease 없는 workspace mutation      → NEITHER      (막는 것이 없다)
generic subprocess                 → OBSERVABLE   (D-A0 baseline · Charter v0.5)
외부 side effect                   → NEITHER      (관측 신호 있으면 OBSERVABLE)
모르는 조합                        → NEITHER      (fail-closed floor)
```

### 4.2 sandbox를 목표로 삼지 않았다 (§24)

`containment: "os-sandbox"` 신호가 실제로 들어올 때만 controlClass를 올린다. 지금은
어떤 backend도 그 신호를 주지 않으므로 **자리만 남겼다.** "we-promise" 같은 임의
문자열로는 올라가지 않는다.

D-A0의 `process = OBSERVABLE` baseline은 그대로 보존했다. 실제 containment가 없는데
ENFORCEABLE이라고 부르는 것이 Charter v0.5가 금지한 바로 그것이다.

### 4.3 되돌릴 수 없는 외부 행동 (§23)

```text
side effect + controlClass = NEITHER   →  행동 전 HUMAN_APPROVAL
IRREVERSIBLE                           →  행동 전 HUMAN_APPROVAL
```

`admitAction`이 승인 없는 실행을 막는 관문이다. 사후 자기보고를 verified evidence로
승격하지 않는다. 계획된 human criterion은 승인 화면에서 "왜 사람이 필요한가"와 함께
사전 예고된다(§9 P-3).

### 4.4 범용 Resource Registry를 먼저 만들지 않았다 (§21)

resource/action은 실제로 필요한 4종(workspace · artifact · process · external)과
4행동(read · mutate · execute · external-effect)만 두었다. premature abstraction은
D-0에서 이미 거부한 방향이다.

---

## 5. D-C — Provenance & Audit

### 5.1 event emission을 새로 발명하지 않았다 (§25)

각 단계가 실행 시점에 남긴 사실을 그대로 받아 append한다. **과거 사실을 소급해서
만들어내지 않는다.** 기록되지 않은 것은 `missingFacts`로 남고, 그 자체가 답이다
(`reconstructable: false`).

### 5.2 Graph DB를 도입하지 않았다 (§28)

```text
append-only events  →  projectGraph()  →  nodes/edges  →  query
```

저장 형태는 그대로 두고 조회 형태만 제공한다. 새 저장 엔진은 Agora를 무겁게 만들 뿐이다.

### 5.3 typed lineage (§27)

```text
parentRunId + lineageRelation(replan | retry | revision | carry)
```

`carriedFromRunId`에 의미를 계속 덧붙이면 "이 Run이 왜 생겼는가"를 구분할 수 없다.
replan(계약이 바뀜)과 retry(같은 계약 재시도)는 감사에서 전혀 다른 의미다.

옛 기록은 파괴하지 않는다. `readLineage`가 `carriedFromRunId`를 `carry`로 **읽어
주되**(`inferred: true`) 저장된 값을 고치지 않는다. 왜 이어졌는지를 지어내지 않는다.

### 5.4 감사 재구성 (§29)

`explainRun()`이 §29의 11개 질문에 저장된 사실만으로 답한다. UI는 과하게 만들지
않았다 — D-C의 핵심은 화면이 아니라 재구성 가능성이다.

---

## 6. 배선 — 이번 작업의 진짜 산출물

모듈을 만든 것이 아니라 **연결한 것**이 이번 범위의 핵심이다(§40).
`AssuranceRun`이 다섯 지점만 노출하고 `chat-specialist`가 그것을 호출한다.

```text
freezeTask 직후          beginAssurance()          계약 동결 + Builder admission
Builder 종료 직후        runAssuranceVerification() subject 확정 + 검증 실행
Reviewer 프롬프트        assuranceReviewPayload()   §19 구조화 전달
Reviewer PASS 시점       applyReviewerAssuranceVerdict() + Final 집계
Recorder 종료            recordRecorder()           provenance 사슬 완결
```

### 6.1 admission은 되돌릴 수 없는 상태를 소비하기 전에 (D-0에서 배운 원칙)

`beginAssurance`는 checkpoint 생성과 Builder 실행보다 **먼저** 호출된다. 실패 후
rollback을 짜는 것보다 순서를 뒤집는 것이 안전하다.

### 6.2 Reviewer PASS만으로 Run이 완료되지 않는다

이것이 Stage D가 실제로 작동한다는 증거다. Reviewer가 PASS를 선언해도 자동검사
FAIL·미해결 항목·결과물 변경이 남아 있으면 `holdForAssuranceBlocked`에서 멈춘다.

### 6.3 Stage D 자체의 오류가 기존 실행을 무너뜨리지 않는다

계약 준비 중 예외가 나면 legacy로 진행하되 **조용히 넘어가지 않고** 사실을 남긴다.
다만 계약 자체가 불완전한 경우(v2를 표방했는데 파싱 실패)는 legacy로 내려가지 않고
정지시킨다 — 그것은 "구형 과업"이 아니라 계약 문제다.

---

## 7. 배선 중 발견해 고친 결함

### Reviewer가 사용자 승인을 대신할 수 있었다 (Charter §20 위반)

`AssuranceLedger.effectiveFor`가 REVIEWER_RESOLUTION을 무조건 해소로 인정해,
`HUMAN_APPROVAL`로 라우팅된 criterion을 Reviewer 판정만으로 통과시킬 수 있었다.
승인 관문 전체가 무력화되는 결함이다.

**수정**: `appendReviewerResolution`이 HUMAN_APPROVAL criterion에 대한 판정을
거부하고(조용히 무시하지 않고 거부 사실을 반환), `effectiveFor`에도 같은 규칙의
방어선을 두었다(외부에서 로드된 기록 대비).

### v2 계약이 freeze 단계에서 거부되었다

`task-contract-validator`가 v1 헤딩만 인정해, v2 계약이 `TASK_CONTRACT_INCOMPLETE`로
막혔다. Stage D가 실전에서 절대 켜지지 않는 상태였다.

**수정**: 필수 섹션에 v2 alias를 허용하고, Verification Plan 섹션은 ```json 펜스를
본문으로 인정하도록 했다. **임의의 코드 펜스는 여전히 빈 본문**이다 — 기존 테스트가
이 구분을 잡아냈고, 그 의미(코드만 있는 섹션은 비어 있다)를 보존했다.

---

## 8. 버린 대안

| 대안 | 버린 이유 |
|---|---|
| Verification Plan을 자유 텍스트로 유지 | "검사했다"는 주장만 남고 무엇을 검사했는지 기계가 확인할 수 없다. Stage D 전체가 무의미해진다. |
| JSON 없는 계획을 실패 처리 | 비코딩 과업이 실질적으로 막힌다. R-4대로 review로 강등하는 것이 정직하다. |
| v1 Frozen Task 자동 마이그레이션 | 이미 승인받은 계약을 파괴한다. 읽기 어댑터로 충분하다. |
| 도메인 Verifier 클래스 추가 | Charter가 명시적으로 금지. 과업 종류마다 클래스가 늘어나 Agora가 모든 전문 영역을 알아야 하는 제품이 된다. |
| xlsx/docx/pdf 파서 동봉 | 배포 무게. UNSUPPORTED 강등 경로가 이미 정직하게 동작한다. |
| 판정 덮어쓰기(최신 값만 보관) | R-8 위반. "자동검사를 못 했었다"가 세탁되면 §29를 재구성할 수 없다. |
| graph DB 도입 | §28 금지. append-only + projection으로 충분하며 Agora가 무거워진다. |
| `carriedFromRunId` 의미 확장 | 왜 이어졌는지를 구분할 수 없다. typed relation으로 승격하되 옛 필드는 호환 유지. |
| verification-core에서 controlClass 자체 계산 | 같은 질문에 두 답이 생긴다. D-B가 단일 권위여야 한다. |
| 범용 Resource Registry 선행 구축 | premature abstraction. 실제 필요한 자원부터 일반화한다(§21). |
| D-B에서 sandbox 구현 | §24 — sandbox를 목표 자체로 삼지 않는다. 실제 강제 가능할 때만 controlClass를 올린다. |
| Stage D 실패 시 조용히 legacy 강등 | 정직하지 않다. 계약 문제와 구형 과업을 구분해야 한다. |

---

## 9. 의도적으로 하지 않은 것

- **M2 Derived Memory Bank · M3 AGENTS.md/CLAUDE.md export.** 이번 범위는 Stage D만이다(§33).
- **HUMAN_APPROVAL의 승인 화면 렌더링.** 조회·해소 경로는 IPC와 preload까지
  노출되어 있다(1차 검수 B5 수정). 그 위의 화면 구성만 렌더링 계층의 몫이며,
  Charter §9의 원자료는 모두 제공한다.
- **live input의 자동 retrieval.** Agora가 입력을 대신 가져오지 않는다. retrieval
  metadata를 받아 기록할 뿐이다.
- **OS-level containment.** D-A0에서 D-B로 이연했고, D-B에서도 §24에 따라 신호가
  실제로 생길 때까지 자리만 남겼다.
- **Role 구조 재설계.** §33 — Stage D 구현 때문에 역할을 다시 설계하지 않았다.

---

## 10. 알려진 한계

- **process 검증은 여전히 OBSERVABLE이다.** 검증 프로세스가 workspace를 바꾸는 것을
  막지 못하고 관측·기록할 뿐이다(Charter v0.5). 이것은 결함이 아니라 선언된 경계다.
- **Assurance Subject는 선언·관측된 경로만 본다.** 선언되지 않고 Git에도 안 잡히는
  변경(non-Git workspace의 임의 파일)은 subject 밖이다. `changeObservation`으로
  그 사실을 남긴다.
- **predicate 어휘가 좁다.** 실사용에서 필요가 확인되면 Extractor/Predicate를
  추가하면 되고, 그때까지는 UNSUPPORTED → Reviewer 경로가 정직하게 동작한다.
- **Reviewer resolution은 criterion 단위 세분화가 아직 거칠다.** 현재는 Reviewer의
  PASS/FIX 판정을 REVIEW_REQUIRED criterion 전체에 적용한다. criterion별 개별 판정을
  Reviewer가 선언하게 하려면 review 계약(VERDICT 문법) 확장이 필요하며, 이는 기존
  Reviewer 프로토콜을 건드리므로 별도 범위로 남긴다.

---

## 11. 검증

```text
test/assurance-contract-da1.test.js       25 tests
test/assurance-verification-da2.test.js   33 tests
test/assurance-governance-dbc.test.js     23 tests
test/assurance-end-to-end.test.js         18 tests
test/assurance-repair-regression.test.js  17 tests  (1차 검수 B2·B4·B6~B9)
test/assurance-step-mode.test.js           8 tests  (1차 검수 B1·B5, production 진입점)
test/assurance-repair2-regression.test.js 11 tests  (2차 검수 B3·B5·B7)
canonical npm test                        1229 / 0 fail / 2 skipped
```

end-to-end 테스트가 실제로 증명하는 것(Charter §34):

- 비코딩 과업(번역 보고서)이 계약→검증→판정→Final PASS까지 끝까지 흐른다.
- Builder도 Reviewer도 Frozen Verification Plan을 바꾸지 못한다.
- frozen input이 바뀌면 Builder를 시작하지 않는다.
- v1 Frozen Task가 제자리 변환되지 않고 legacy로 흐른다.
- 이 PC에 없는 도구는 VERIFIED가 아니라 UNSUPPORTED + 강등이다.
- 자동검사 FAIL이면 Reviewer가 PASS라 해도 Final PASS가 아니다.
- **사용자 승인이 남으면 Reviewer가 대신 통과시킬 수 없다.**
- 판정 후 결과물이 바뀌면 기존 PASS가 무효화되고, 과거 기록은 보존된다.
- 검증 프로세스가 산출물을 건드리면 Builder 변경과 분리 기록된다.
- planned와 actual의 차이가 Reviewer payload에 그대로 보인다.
- D-0 lease 아래에서 검증이 실행되고 BUSY 의미에 회귀가 없다.
- 입력·산출물이 명시적으로 "없음"인 과업도 막히지 않는다.
- controlClass가 D-B 한 곳에서만 계산된다.
- "왜 PASS였는가"를 provenance만으로 재구성한다.

---

## 12. 1차 독립 검수 수정 (2026-08-24)

1차 검수는 "Stage D가 실제 professional execution에서 끝까지 작동하는가"만 봤고,
9건이 BLOCKING으로 돌아왔다. 모듈은 대체로 통과했고 **통합 배선**이 문제였다.

세 덩어리로 묶인다: (1) 모든 실행 경로를 Stage D에 붙이기, (2) 사람·입력·행동
경계 완성, (3) 실제 실행 사실을 D-C에 끝까지 연결.

### B1 — step mode가 Stage D를 통째로 우회

`resumeStepPhaseInner()`가 `runExecutionBlock()`을 타지 않으므로 계약 동결·
subject·검증·Final이 전부 빠졌다. `review_pass`는 Final 없이 Recorder로 갔다.

**이것은 D-0에서 이미 본 실패 모드의 재발이다** — step 전용 우회 경로.

**수정**: `freezeOnce()` 안에서 checkpoint보다 **먼저** `beginAssurance()`를
호출한다(block 경로와 동일한 admission 순서). Builder 종료 지점 두 곳(최초·보완)
에서 subject 확정 + 검증을 수행하고, `review_pass`에서 Final을 집계한다.
step은 단계 사이에 메모리가 끊기므로 `ensureAssuranceRun()`이 RUN 폴더에서
복원한다.

### B2 — v2 intent가 조용히 legacy로 강등

"Inputs와 Deliverables가 둘 다 있으면 v2"라는 판정 때문에, v2 어휘를 쓰면서 그
두 섹션만 빠뜨린 문서가 v1으로 읽혀 Stage D를 우회했다.

**수정**: `classifyTaskSchema()`가 `LEGACY_V1 / V2_COMPLETE / V2_INCOMPLETE`를
구분한다. v2 marker 헤딩이 **정식 이름으로** 나타나면 v2 intent이며, 필수 섹션
누락은 legacy가 아니라 `TASK_CONTRACT_INCOMPLETE`다. alias로 매칭된 것(v1 문서)은
marker로 세지 않는다.

### B3 — Stage D 내부 오류가 v2에서도 fail-open

`beginAssurance`의 catch가 예외를 legacy 승격으로 처리했고, `runAssuranceVerification`
결과를 caller가 검사하지 않았으며, `applyReviewerAssuranceVerdict`가 오류 시 `null`을
반환해 caller의 `if (final && !final.finalPass)`를 그대로 통과했다.

**수정**: v2 intent가 확인된 뒤의 어떤 실패도 legacy 승격 사유가 아니다. 검증·
최종 집계 오류는 `null`이 아니라 `finalPass: false`로 명시한다. caller는 검증
실패를 검사해 `holdForAssuranceBlocked`로 보낸다.

### B4 — auto revision 후 재검증 없음

Reviewer FIX_REQUIRED → Builder 재실행 후 diff·evidence는 갱신됐지만 검증은
그대로였다. Reviewer는 결과물 B를 보는데 판정 원장은 A에 머물렀다.

**수정**: Builder가 다시 실행되는 지점마다 `runAssuranceVerification()`을 다시
호출한다. `captureSubject()`는 subject가 교체되면 이전 subject에 귀속된 판정을
자동으로 무효화한다(기존 기록은 지우지 않는다 — R-8). 결과적으로
`FAIL → INVALIDATED → PASS` 세 기록이 남는다.

### B5 — HUMAN_APPROVAL을 사용자가 풀 방법이 없음

원장 방어(Reviewer 대리 해소 차단)는 PASS였으나, 사용자가 승인할 production
경로가 없어 Run이 영원히 막혔다.

**수정**: `pendingHumanApprovals()` / `resolveHumanApproval()`을 room에 추가하고
`chat:specialist:pending-approvals` · `chat:specialist:resolve-approval` IPC와
preload 브리지로 노출했다. 승인 직후 결과물을 재확인해 승인이 어떤 결과물에
귀속되는지 확정한다(INV-5). 자동 확정된 항목은 이 경로로 건드릴 수 없다.

### B6 — D-B 관문이 실제 행동 앞에 없음

`admitAction()`은 잘 만들어졌지만 실제 실행을 gate하지 않았다.

**수정**: Agora가 오늘 실제로 가진 두 action surface에 붙였다.

```text
workspace mutate   lease 획득 직후 심사 → 승인 필요하면 소유권을 돌려주고 거부
process execute    runner admission보다 앞서 심사 → 승인 없으면 UNSUPPORTED로 강등
```

심사는 **소유권 확보 뒤**에 한다 — "lease를 든 상태에서 이 행동이 허용되는가"가
실제 질문이기 때문이다. 범용 interceptor는 만들지 않았다(§21).

### B7 — frozen/live 계약이 실제로 강제되지 않음

frozen인데 지문을 뜰 수 없는 입력(URL·디렉터리·너무 큼·읽기 불가)이 계약을
통과했고, 재대조에서 `SKIPPED`로 처리되어 `ok: true`를 유지했다.

**수정**: `buildFrozenContract()`가 `FROZEN_INPUT_UNVERIFIABLE`로 막는다. 재대조는
`SKIPPED`와 `UNVERIFIABLE`을 구분하고 후자를 변경으로 센다 — **"볼 필요가 없다"와
"봐야 하는데 못 봤다"는 다른 사실이다.**

### B8 — subject recheck가 '확인 불가'를 성공으로 처리

판정 당시 읽혔던 산출물이 Final 직전에 읽히지 않아도 `continue`로 넘어가
`recheck ok`가 됐다.

**수정**: `UNSUPPORTED / OUTSIDE / DIRECTORY`를 `unverifiable: true`로 변경 목록에
넣는다. INV-5의 재확인에서 "같다고 확인하지 못함"은 "같음"이 아니다.

### B9 — D-C에 실제 사실이 연결되지 않음

typed lineage는 API 수준에 머물렀고, invalidation은 원장에만 남아 D-C가
`PASS → INVALIDATED → 재검사 PASS`를 재구성하지 못했다.

**수정**:
- `REPLAN_RESET`이 `parentRunId` + `lineageRelation: "replan"`을 남기고,
  `beginAssurance`가 그것을 `freeze()`에 전달한다(`carriedFromRunId`는 호환 유지).
- `ProvenanceLog`에 `invalidation` event type을 추가하고, 무효화는 원장과
  provenance **양쪽**에 기록한다(`invalidateAgainst()`).
- `explainRun()`은 execution outcome에서 유추하지 않고 전용 event를 읽는다.
- graph projection에 `invalidates` 간선이 생긴다.

---

## 13. 2차 독립 검수 수정 (2026-08-24)

2차 검수에서 6건은 닫혔고 3건이 "절반만 닫혔다"로 남았다. 세 건 모두 새 요구사항이
아니라 1차 B3/B5/B7의 나머지 절반이다.

### B3(2차) — `persist()` 실패가 아직 fail-open

예외와 검증/최종 오류는 1차에서 닫혔으나, `persist()` 결과를 caller가 검사하지
않아 디스크 오류·권한 실패 상태로 v2 Run이 PASS까지 갈 수 있었다.

**이것은 D-C와 정면으로 충돌한다.** D-C의 목표는 "왜 PASS였는가를 기록만으로
재구성"인데, 기록이 없는 PASS는 사후에 설명할 수 없는 PASS다.

**수정**: canonical state(계약·원장·판정)의 저장 실패를 fail-closed로 만들었다.

```text
freeze/admission 후 persist 실패  → ASSURANCE_STATE_WRITE_FAILED · 실행 시작 안 함
verification 후 persist 실패      → 검수로 넘어가지 않음
finalize 후 persist 실패          → finalPass:false
human approval 후 persist 실패    → 승인하지 않은 것으로 처리
```

Recorder의 부가 기록(`recordAssuranceRecorder`)은 그대로 best-effort다 —
관측 실패이지 통제 실패가 아니다.

### B5(2차) — 승인이 assurance만 풀고 workflow는 BLOCKED에 남음

`holdForAssuranceBlocked`가 `holdForRecovery`로 들어가 Run을 BLOCKED로 만들었고,
`resolveHumanApproval`은 그 상태를 풀지 않았다. 승인해도 Recorder·COMPLETED에
도달하지 못했다.

**핵심 판단**: 남은 것이 **사용자 승인뿐이면 그것은 실패가 아니라 계획된 대기**다.
승인 화면에서 이미 예고한 지점이므로(§9 P-3) BLOCKED로 만들면 안 된다.

**수정**:

```text
blockers가 전부 UNRESOLVED_HUMAN_APPROVAL
  → pauseForHumanApproval()  (BLOCKED 아님, phase=awaiting_human_approval)
  → 승인 전 resume은 거부 (§20)
  → 승인 + Final PASS → phase=review_pass, resumable
  → 기록 직전 재확인 → Recorder → COMPLETED
```

block/auto는 FSM을 `runExecutionBlockInner`가 구동하는데 승인 대기로 그 함수를
빠져나왔으므로, 재개 시 남은 전이(REVIEW_PASS → RECORDING → RECORDER_DONE)를
`resumedFromApproval` 표시로 이어받는다. step legacy 경로는 원래 FSM을 구동하지
않으므로 건드리지 않았다 — 없는 상태를 지어내지 않는다.

기록 직전에도 Final을 다시 집계한다. 승인 이후 결과물이 바뀌면 그 승인은 이
결과물에 대한 것이 아니기 때문이다(INV-5).

### B7(2차) — live retrieval provenance seam 없음

frozen 쪽은 1차에서 닫혔으나, live 계약의 의미("달라도 되지만 실제로 무엇을
썼는지는 남긴다")를 강제하는 production seam이 없었다.

**수정**: 두 경로를 만들었다.

```text
1) Agora가 관측 가능한 것 (작업 폴더 안의 live 파일)
   → Builder 종료 시 captureLiveInputUse()가 사용 시점 지문을 남긴다

2) 외부에서 온 metadata (etag/version/contentHash)
   → recordLiveInputRetrieval() + IPC/preload로 받아 append
```

**Agora가 URL을 대신 가져오지는 않는다**(non-goal 유지). 관측할 수 없는 입력은
`observed: false`와 사유를 남긴다 — 관측한 척하지 않는 것이 INV-3과 같은 방향이다.

`inputRetrieval`을 provenance 1급 event로 만들어 "무엇을 쓰기로 했는가(binding)"와
"실제로 무엇을 썼는가(retrieval)"를 섞지 않았다.

---

## 14. 남은 확인

- 사용자 Windows 로컬에서 canonical `npm test` GREEN 실측 (Charter §6 DoD 3).
- 3차 actual-diff 독립 검수 PASS (Charter §6 DoD 2).
