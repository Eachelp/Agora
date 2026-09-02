# Ἀγορά (Agora) — V1.5 구현 계획

> 상태: **구현 계획 (Implementation Plan)**
>
> 작성일: 2026-08-30
>
> 기준 제안: [AGORA_V1_5_PROPOSAL.md](AGORA_V1_5_PROPOSAL.md)
>
> 현재 동작 기준: [AGORA_V1_DESIGN.md](AGORA_V1_DESIGN.md)와 `main` 구현
>
> 구현 브랜치: `claude/agora-v1-5-implementation-1u7rmg`
>
> 문서 목적: 제안서의 범위를 실제 모듈·함수·IPC·스키마·테스트 단위로 매핑하고,
> 단계별 구현 순서와 완료 기준을 고정한다. 제안서의 원칙(INV-1~7)을 바꾸지 않는다.

---

## 0. 요약

V1.5는 제안서의 권장 순서를 따라 아래 6개 Stage로 구현한다. 각 Stage는 독립적으로
검증 가능하고, 전체 테스트(기준선 1250개 중 1249 pass / 1 skip)를 깨지 않은 채
개별 커밋으로 완결한다.

```text
Stage V1.5-0  Interaction/Handoff 계약 모듈 (순수 로직)
Stage V1.5-1  자유토론 turnBudget 설정 (UI → IPC → 실행)
Stage V1.5-2  구조화 토론 Preset + cycle scheduler + 임시 역할
Stage V1.5-3  System Journal 기초 (professional-events.jsonl)
Stage V1.5-4  역할 멘션 파싱 + CONSULT 직접 역할 호출
Stage V1.5-5  구조화된 Role Handoff 런타임 연결 (후속)
Stage V1.5-6  @모두 Planner-first 제한 팀 실행 (후속)
```

Stage 0~4는 이번 구현 세션의 범위다. Stage 5~6은 설계를 이 문서에 고정하되,
전문 FSM의 3중 실행 경로(step / auto / record 재시도)에 대한 침습이 커서
별도 작업으로 넘긴다(§7, §8).

---

## 1. 현재 구조 — 구현에 필요한 사실

코드 전수 분석으로 확인한, 이 계획이 딛고 서는 사실들이다.

### 1.1 토론 엔진

- 토론은 `ChatRoom.startDiscussion()`(src/chat/chat-room.js:1297-1403)의 단일
  bounded loop다. 예산은 `this.discussionRunBudget`이며 생성자 옵션으로 주입
  가능하지만(chat-room.js:114-116) chat-ipc가 방을 만들 때 넘기지 않아
  프로덕션은 항상 `DEFAULT_DISCUSSION_RUN_BUDGET = 9`(chat-room.js:45)다.
- 발언자 선택은 `pool[(turn - 1) % pool.length]`(chat-room.js:1347) 한 줄이다.
  구조화 Protocol은 이 선택식을 교체하면 된다.
- `[[CODEPET_DISCUSSION:CONTINUE|AGREE|PASS|CONCLUDE]]` 태그는
  `runResponseTurn`의 end-anchored 정규식(chat-room.js:1085-1087)으로 파싱되고,
  태그 누락은 CONTINUE로 처리된다. 조기 종료는 CONCLUDE 즉시, 또는 연속
  AGREE/PASS `settled` 카운터가 `pool.length`에 도달할 때다(chat-room.js:1353-1357).
- 종료 시 `discussionMeta`를 실은 시스템 메시지를 finally 블록에서 남긴다
  (chat-room.js:1378-1394). meta는 JSONL transcript에 불투명 JSON으로 저장되므로
  **추가 필드는 마이그레이션 없이 안전**하다.
- IPC `chat:discussion:start`는 `{sessionId, agentIds}`만 받는다
  (chat-ipc.js:1900-1925). 렌더러 팝오버(src/chat.js:3161-3203)에는 길이 설정이
  전혀 없다.
- `discussionInterrupted` 플래그(chat-room.js:137)는 읽히기만 하고 어디서도
  true로 설정되지 않는 dead code다. 중단은 오직 generation bump로만 일어난다.

### 1.2 멘션 체계

- `parseMentions`(src/chat/chat-mention.js:18-47)는 코드펜스를 마스킹한 뒤
  `@([\p{L}\p{N}_-]+)`로 토큰을 뽑고, 미지 토큰(현재의 `@Planner` 등)은 **조용히
  무시**한다. 따라서 역할 멘션을 별도 pass로 추가해도 기존
  `@claude/@gpt/@gemini` 해석은 깨지지 않는다.
- `tokenMatchesAlias`는 대소문자 무시 prefix 매칭에 한글 조사를 허용한다
  (`@claude야` OK). 단 **한글 별칭은 한글 연장도 통과**한다(`기획자`가 별칭
  `기획`에 매칭). 역할 별칭은 완전한 단어(기획자, 구현자…)만 쓴다.
- `GROUP_ALIASES = ["all","everyone","모두","전원","얘들아"]`(chat-agents.js:7)는
  사용자 메시지에서만 확장된다. 에이전트 응답의 멘션 연쇄는 group alias 없이
  파싱되고(chat-room.js:1168) `mentionChainLimit`(기본 2)으로 제한된다.
- 역할→담당자 해석기는 이미 있다: `specialistStageFor(project, room, roleId)`
  (chat-ipc.js:864-895). per-role model/effort 오버라이드까지 처리한다.

### 1.3 전문 실행 FSM

- FSM은 `src/agora/professional-run.js`: 7 nodes × 6 statuses,
  `transitionProfessionalRun(current, event)`가 단일 합법성 게이트다.
- 모든 전이는 `SpecialistMixin.transitionProfessional()`
  (src/chat/chat-specialist.js:181-196) 한 seam을 지나며, 여기서
  `persistProfessionalRun`(→ `store.updateMeta`)이 fail-closed로 저장된다.
  **System Journal 이벤트 발행 지점은 이 seam이다.**
- 단계 권한 cap: `SPECIALIST_STAGE_CAPS`(src/chat/chat-argv.js:8-40) —
  planner/plan_review/review=workspace-read, implementation=workspace-write,
  recorder=chat. `specialistPermissionMode(stage, auth)`는 미지 stage에 null을
  반환하고 runResponseTurn이 `UNKNOWN_SPECIALIST_STAGE`로 중단한다(fail-closed).
- 역할별 context 경계는 `ROLE_CONTEXT_POLICY`
  (src/chat/professional-role-context.js:10-42). **정책이 없는 역할은 전체
  context를 받는다** — 새 stage를 추가하며 정책 등록을 빠뜨리면 보수적 기본과
  반대로 동작하므로 반드시 함께 등록한다.
- 역할 프롬프트(Role Contract)는 `buildAgentPrompt`의 `specialist.stage` 분기
  (src/chat/chat-prompt.js:329-503) 인라인 텍스트다. stage를 늘리면
  `stageLabels`(chat-prompt.js:89-94)와 분기를 함께 늘린다.
- 전문 stage 턴은 IPC에서 `requireFinal = Boolean(specialistStage)`
  (chat-ipc.js:698)로 strict-final 전송 계약을 받는다.
- 실행 경로가 세 벌 있다: auto/full의 `runExecutionBlockInner`, step 모드의
  `resumeStepPhaseInner`, record 재시도 경로. **stage 흐름을 바꾸는 변경은 세
  곳에 모두 적용해야 한다.** (Stage 5를 후속으로 미루는 핵심 이유)

### 1.4 저장소

- 세션 폴더: `~/.agora/sessions/<id>/` — `meta.json`(STORE_SCHEMA_VERSION=3,
  `professionalRun`, `discussion:{maxTurns:9}` 포함), `transcript.jsonl`,
  `attachments/`, `run-logs/`, `checkpoints/`.
- append-only 패턴: `appendEvent`는 한 줄 JSON `{v:1, ts, ...}`를
  `fs.appendFileSync`로 쓰고, 읽기는 torn line을 건너뛰는
  `readJsonlTolerant`(chat-store.js:39-57, export됨)를 쓴다.
- **Journal 파일은 run-logs/ 안에 두면 안 된다** — pruneRunLogs가 mtime 기준으로
  삭제한다. transcript.jsonl 옆(세션 루트)이 안전하다.
- `STORE_SCHEMA_VERSION`을 4로 올리면 구버전 앱이 저장소 전체를 readOnly로
  연다. **새 파일 추가는 하위 호환이므로 3을 유지**하고, 이벤트 라인 자체의
  `schemaVersion:1`로 전방 진화를 감당한다.

### 1.5 테스트 관례

- `node --test`, test/*.test.js 97개 파일, 공유 헬퍼 없음(파일별 로컬 헬퍼 복제
  관례 유지). 기준선 1249 pass / 1 skip.
- ChatRoom은 주입된 `runAgent` fake로 테스트한다. IPC는 fake electron 객체로
  Electron 없이 handler를 직접 호출한다. 스토어는 `mkdtempSync` root 주입.
- **소스 앵커 테스트**가 있다: professional-ipc-policy.test.js(88-137),
  professional-role-context.test.js(70-93), chat-professional-role-routing,
  chat-ipc-run-metrics, agora-ui, 그리고 chat-specialist-contract.test.js의
  `hasOpenQuestions` 소스 추출(1328-1359). 해당 파일을 고치면 같은 커밋에서
  테스트를 갱신한다.
- 한글 문구가 load-bearing이다: `/예산/`, `/두 명 이상/`, `자율 토론 1/9턴` 등.
  기본 9턴 문구를 바꾸면 무관해 보이는 테스트가 깨진다 — 기본값을 바꾸지 않는
  이유이기도 하다.

---

## 2. 구현 전 확정값 (제안서 §20에 대한 결정)

| # | 항목 | 결정 |
|---|---|---|
| 1 | 자유토론 길이 기본값 | 짧게 9 / 보통 15 / 길게 30 / 직접 설정 3~50. 저장값·선택 없으면 **9** (V1 호환, 기존 테스트 유지) |
| 2 | "직접 중단할 때까지" | V1.5.0에서는 **hardTurnCeiling 50**으로 구현(=직접 설정 최대값). 30턴 checkpoint 요약·segment 연장은 Stage 5 이후 별도 결정 문서로 확정 |
| 3 | 초기 구조화 토론 Preset | **기획 / Grill / Red Team** 3종 (제안서 §5.5 그대로, 4 step/cycle) |
| 4 | `@모두 CONSULT` 기본 참여 | Planner → Reviewer → Builder → 사용자 반환 (제안서 §9.2). Stage 6에서 구현 |
| 5 | Composer의 Intent 선택 | 새 chip UI를 만들지 않는다. **텍스트 역할 멘션 = 항상 CONSULT**, 실행 계열 Intent는 기존 `PLAN / 실행 / 전체 실행` 버튼만이 유일한 진입점 |
| 6 | 실행 표현 감지 시 확인 UX | V1.5.0에는 자연어 실행 감지기를 만들지 않는다. 실행 전제조건이 없는 EXECUTE성 요청은 CONSULT 응답 + `NEEDS_PLAN` 안내(기존 버튼 사용 안내)로 답한다 |
| 7 | Recorder 표면 이름 | 사용자 표면은 `Recorder`(기록) 유지. 내부 책임 이름만 `systemJournal` / `archivist`로 분리. Archivist는 V1.5.2 |
| 8 | Journal 파일명·스키마 | `professional-events.jsonl` (세션 루트, transcript 옆). `STORE_SCHEMA_VERSION`은 **3 유지**, 이벤트 라인에 `schemaVersion: 1` |
| 9 | RECORDING 노드 제거 | V1.5에서 하지 않는다 (제안서 단계 E 그대로) |
| 10 | 총 Handoff 상한 기본값 | 사용자 발화 1회당 AI-요청 Handoff **8회** (`interaction-contract.js` 상수, 기존 FSM 자동 보완 루프에는 미적용) |

추가 결정:

- **역할 멘션 별칭**: `planner: [planner, 기획자]`, `builder: [builder, 구현자]`,
  `reviewer: [reviewer, 검토자, 검수자]`, `recorder: [recorder, 기록자]`.
  전부 완전 단어형만 쓴다(§1.2의 prefix 매칭 위험 회피). provider 별칭
  (claude/gpt/codex/gemini/agy/antigravity)과 겹치는 항목은 없다.
- **멘션 우선순위**: group > agent > role. 메시지에 agent/group 멘션이 하나라도
  있으면 역할 멘션 pass는 실행하지 않는다(기존 동작 완전 보존). 역할 멘션은
  agent/group 멘션이 없는 메시지에서만 해석한다.
- **CONSULT 중 전문 실행 상태**: 활성 실행(RUNNING)·토론 중에는 역할 CONSULT를
  시작하지 않는다. WAITING/READY 중 독립 CONSULT 허용(제안서 §12)은 Stage 5에서
  정책표와 함께 다룬다. V1.5.0에서는 활성 run이 없을 때만 CONSULT를 연다.
- **Journal 쓰기 실패 정책**: FSM 저장(fail-closed)과 달리 Journal append 실패는
  실행을 중단시키지 않는다. 대신 **시스템 메시지로 즉시 알린다**(“이벤트 저장
  실패를 성공으로 숨기지 않는다”는 §10.4 충족). FSM snapshot(meta.json)이 현재
  상태의 기준이고 Journal은 감사 기록이라는 위계(§10.4)를 유지한다.
- **팀 상담 트리거는 `@팀`(team)**: 제안서 §9.2의 팀 상담(Planner → Reviewer →
  Builder 순차, run 없음)은 `@모두`가 아니라 새 멘션 `@팀`으로 발동한다.
  `@모두`는 기존 셔플 브로드캐스트 의미를 그대로 유지한다 — 저장된 습관과
  테스트가 그 의미를 고정하고 있고, 같은 단어의 의미를 컨텍스트에 따라
  바꾸면 사용자가 예측할 수 없기 때문이다. `@모두`의 팀 Protocol 전환 여부는
  V1.5 사용 데이터를 본 뒤 별도로 결정한다.
- **CONSULT는 전문 stage 턴이 아니라 일반 턴 + consult 컨텍스트**: harness가
  role이 실린 ExecutionContext에 professionalRunId를 요구해(SessionKey), run
  없는 stage 턴은 모델이 확정된 경우 fail-closed로 죽는다. recordDiscussion과
  같은 선례를 따라 일반 턴으로 실행하고 역할 관점·읽기 전용 계약만 프롬프트로
  덧씌운다. 권한은 `min(세션 권한, workspace-read, 역할 cap)` — 세션 권한보다
  높은 권한을 얻는 경로를 만들지 않는다(V1 미래 호환 문서 §4).
- **구조화 토론 cycle 상한은 hard ceiling 50을 공유**: 자유토론이 이미 50턴을
  허용하므로 구조화 토론에 별도 magic number(초판 5 cycle)를 두지 않는다.
  `maxCycleBudget(stepCount) = floor(50 / stepCount)` — 4-step preset이면 12
  cycle(48턴)이다.
- **구조화 토론의 step 실패는 즉시 중단**: 각 단계는 다음 단계의 입력
  계약이다(발안→비평→수정→종합). 한 단계가 transport 실패한 채 계속 가면
  "비평 없는 비평 반영"처럼 계약이 조용히 무너지므로, 실패 지점에서 토론을
  중단하고 `discussionMeta.protocol.failedStep`과 표시 문구로 이유를 남긴다.
  자유토론은 기존대로 계속한다(한 명이 빠져도 나머지가 말할 수 있다).
- **임시 역할은 발화의 역사적 metadata로 남긴다**: 영구 Agent 속성으로
  저장하지 않되(제안서 §5.4), 각 구조화 토론 메시지에
  `discussionTurnMeta{presetId, cycle, step, roleName}`를,
  `discussionMeta.protocol`에 slot 순서의 `roleAssignments`를 남긴다 — 나중에
  "GPT · 비평가" 배지나 과거 토론 재현의 근거다.
- **현재의 `@팀`은 "V1.5 Team Consult"라는 임시 의미다**: 읽기 전용 3역할
  순차 상담이지 자율 전문팀 실행이 아니다. 향후 자율 팀 실행이 생기면
  `@팀`(실행)과 `@팀상담`(read-only) 분리 또는 UI Intent 분리를 그때 결정하고,
  지금의 `@팀` 의미를 영구 계약으로 확정하지 않는다.

---

## 3. Stage V1.5-0 — Interaction/Handoff 계약 모듈 (재설계판)

**목표**: Target/Intent/Scope/executionPolicy 의미와 역할 Handoff의 구조적
검증을 순수 모듈로 고정한다. 이후 모든 Stage가 이 모듈을 import한다.

> **재설계 기록**: 초판은 제안서 §8.2의 전이표를 그대로 데이터로 옮겼다
> (`planner→plan_review→ready→builder→review→complete→archivist`). 검수에서
> 두 가지가 확인됐다. (1) 표면 어휘(`HANDOFF: @reviewer`)와 내부 어휘
> (`plan_review`/`review`)가 어긋나 정상 요청이 `HANDOFF_NOT_ALLOWED`로
> 거부될 수 있었고, `@recorder`의 내부 대응이 `archivist`로 갈라져 있었다.
> (2) 역할 그래프에 `ready`/`complete` 같은 workflow 상태가 들어간 것 자체가
> role routing과 workflow state가 다시 섞인 신호이며, 사실상 기존 Professional
> FSM을 다른 이름으로 복제하는 방향이었다. 그래서 Stage 5 연결 전에 계약을
> 아래처럼 다시 썼다.

### 계약 원칙

```text
Role(사람)          planner / builder / reviewer / recorder
Execution contract  역할에 적용되는 계약 — reviewer는 출처·artifact에 따라
                    plan_review 또는 review (executionContractFor가 정규화)
Workflow state/행동 READY/COMPLETE 같은 상태와 ASK_USER 같은 행동 —
                    역할 그래프에 넣지 않는다
```

Runtime은 업무 의미 순서("planner 다음엔 반드시 plan_review")를 검증하지
않는다. 검증하는 것은 **어휘(실존 역할), loop(자기/연속 호출), stale, budget,
동시성(active invocation 1개)** 뿐이다. 실행 전제조건(Builder는 READY Task가
있어야 한다 등)은 Stage 5 런타임 연결부가 기존 FSM·Freeze 검증으로 판정한다.
이렇게 해야 직접 역할 호출·`@팀`·향후 Orchestrator가 같은 API를 쓴다.

### 모듈 구성 (`src/agora/interaction-contract.js`)

- `INTERACTION_TARGETS/INTENTS/SCOPES/EXECUTION_POLICIES` +
  `normalizeInteraction(input)` — 미지·누락 값은 안전 기본
  `{intent:"CONSULT", scope:"SINGLE", executionPolicy:"NONE"}`(제안서 §6.2).
- `HANDOFF_TARGETS = ["planner","builder","reviewer","recorder"]` — 사람
  역할만. user 반환은 `ASK_USER` 행동, archivist는 recorder의 실행 계약.
- `CONTROL_ACTIONS = ["HANDOFF","COMPLETE","ASK_USER"]` — 역할 출력의 제어
  행동. COMPLETE의 수용 여부(검수 통과)는 Runtime이 판정한다.
- `executionContractFor(targetRole, {sourceRole, hasFrozenArtifacts})` —
  표면 역할 → specialist stage id 정규화. reviewer 분기는
  `resolveReviewerContract`(§7.2: 문구가 아니라 출처·artifact로 선택).
- `validateHandoff/consumeHandoff/settleHandoff` + `createHandoffLedger` —
  구조적 검증만: 어휘, 자기/연속 호출 금지, budget(기본 8), stale
  (`generation`/`professionalRunId` 불일치), `invocationId` 중복/동시성.
  거부 사유 enum: `HANDOFF_NOT_ALLOWED`(어휘 밖), `HANDOFF_SELF`(자기 호출),
  `HANDOFF_REPEAT`(직전 대상 연속 재호출), `HANDOFF_STALE`, `HANDOFF_DUPLICATE`, `HANDOFF_BUSY`,
  `HANDOFF_BUDGET_REACHED`.
- **Lifecycle 규칙** (Stage 5 소비자가 따라야 하는 계약):
  - `recoverHandoffLedger(state)` — 크래시 복원 시 죽은 active invocation을
    INTERRUPTED로 폐기한다: 소비 기록에는 남겨 재실행(중복)을 막고 active
    슬롯만 비운다. 이 규칙이 없으면 강제 종료 후 모든 Handoff가
    `HANDOFF_BUSY`(ghost BUSY)로 막힌다. 반환된 `interruptedInvocationId`는
    Journal 기록용이다.
  - `recoverHandoffLedgerForRoot(previousState, rootMessageId)` — budget의
    root identity는 사용자 발화다. 원장에 `rootMessageId`를 두고, 새 사용자
    지시가 오면 새 예산의 새 원장(새 epoch)을 만든다. 이게 없으면 "발화
    1회당 8회"가 Professional Run 전체 예산으로 변질된다. 두 fail-closed
    규칙: root 누락은 `HANDOFF_ROOT_REQUIRED`로 거부한다(누락 배선 버그가
    호출마다 budget을 리셋하는 것을 방지), 그리고 이 함수는 **재시작/세션
    복원 전용**이다 — 같은 root 복원에도 crash recovery가 적용되어 active
    invocation을 폐기하므로, 살아 있는 run 중에는 방이 든 in-memory ledger를
    그대로 쓴다.
- `parseControlOutput(text)` — 줄 단위 `HANDOFF: @<role>`(+PURPOSE/REASON),
  `COMPLETE[: 요약]`, `ASK_USER: 질문` 마커 파싱. 일반 문장 속 멘션·코드펜스
  예시·산문 속 COMPLETE는 제어가 아니다. 행동 혼재·HANDOFF 대상 다중은
  ambiguous이고, **서로 다른 ASK_USER 질문·COMPLETE 요약이 여럿인 경우도
  ambiguous다** — 마지막 것만 남기면 사용자가 내려야 할 결정 하나를 조용히
  잃는다(동일 줄 반복은 하나로 본다).

### 테스트

- `test/interaction-contract.test.js` — 정규화 기본값, 역할/상태 분리
  (ready·complete·archivist·plan_review가 대상이 아님), executionContractFor
  정규화, 구조 검증(연속 금지·budget·stale·중복·busy), 제어 출력 파싱.

---

## 4. Stage V1.5-1 — 자유토론 turnBudget

**목표**: 자유토론 발언 수를 사용자가 선택한다. 저장값이 없으면 9 (호환, INV 유지).

### 변경 지점

| 파일 | 변경 |
|---|---|
| `src/chat/chat-room.js` | `startDiscussion(options)`가 `options.turnBudget`(정수 3~50)을 받으면 `this.discussionRunBudget` 대신 사용. clamp는 방어적으로 재수행. `discussionMeta.budget`은 이미 실제 budget을 기록하므로 그대로 |
| `src/chat/chat-ipc.js` | `chat:discussion:start` 입력에 `turnBudget` 추가. IPC 경계에서 정수 검증+clamp(3~50), 비정수는 무시(기본 9 경로) — `planAutoRevisions` clamp 패턴(1973-1986) 준용 |
| `src/chat-preload.js` | `discussionStart(sessionId, agentIds, options = {})` — 3번째 인자로 `{turnBudget}` 전달 (frozen INVOKE map은 채널 불변이므로 수정 불필요) |
| `src/chat.js` | 토론 팝오버(3161-3203)에 길이 선택(짧게 9/보통 15/길게 30/직접 설정 3~50/직접 중단할 때까지=50) 추가. localStorage `agora.chat.discussionTurnBudget` — `PLAN_AUTO_REVISE_KEY` 패턴(150-207) 준용 |

### 지키는 것

- 옵션 없는 `startDiscussion` 호출은 기존과 완전 동일(기본 9, `자율 토론 1/9턴`
  프롬프트 문구 그대로 → 기존 테스트 무변경 통과).
- 레거시 `{rounds:N}` 옵션은 계속 무시한다(테스트가 이 vestigial 키를 넘김).
- `설정된 budget > 9`여도 프롬프트의 `{turn}/{maxTurns}` 표기는 자동 반영
  (chat-prompt.js:283은 이미 동적).

### 테스트

- chat-room: `turnBudget` 옵션이 loop 상한을 바꾸는지, clamp(2→3, 51→50, 비정수
  →기본), 옵션 없으면 9 유지.
- IPC: fake electron harness로 `chat:discussion:start`에 turnBudget 전달·검증.

---

## 5. Stage V1.5-2 — 구조화 토론 Preset + cycle scheduler

**목표**: 세 모델 위에 토론 중에만 유효한 임시 역할을 덧씌우고, 길이를 cycle로
설정한다. 참가자 identity/provider ID/일반 멘션 체계는 바꾸지 않는다(제안서 §5.4).

### 새 파일

- `src/agora/discussion-protocol.js`
  - `DISCUSSION_PRESETS` — 3종:
    ```text
    기획(shaping):  발안 → 비평 → 수정 → 종합
    Grill(grill):   제안 → 질문 → 답변 → 판정·정리
    Red Team(redteam): 제안 → 공격 → 방어·수정 → 종합
    ```
    각 step: `{ slot: 0|1|0|2, roleName, charter }` — slot은 참가자 배열
    인덱스(발안/수정은 같은 참가자). 참가자·역할 매핑은 시작 시 사용자가 정하고
    이후 cycle 순서는 모델이 바꿀 수 없다(INV-1).
  - `resolveProtocol({presetId, participantIds, cycleBudget})` →
    `{steps, cycleBudget, totalTurns}` 검증 포함 (cycle clamp는
    `maxCycleBudget(stepCount) = floor(hard ceiling 50 / stepCount)` —
    4-step preset이면 12, 별도 magic number 없음. 참가자 수 부족 시 오류).
  - `speakerForTurn(protocol, turn)` → `{agentId, role, cycle, step}` — 순수
    함수. round-robin 한 줄을 대체하는 유일한 선택기.

### 변경 지점

| 파일 | 변경 |
|---|---|
| `src/chat/chat-room.js` | `startDiscussion(options)`에 `options.protocol` 추가. protocol이 있으면 budget = `totalTurns`(= steps × cycles), 발언자는 `speakerForTurn`으로 선택, per-turn context `discussion`에 `{presetId, role: {name, charter}, cycle, cycleBudget, step, stepCount, finalStep}` 추가. **조기 종료 재정의**: protocol 토론에서는 `settled >= pool.length` 규칙을 쓰지 않고(§1.1 위험 — 같은 참가자가 여러 slot을 가지면 의미가 깨짐), 마지막 step(종합/판정 slot)의 CONCLUDE만 조기 종료로 인정한다. **step transport 실패는 즉시 중단**한다 — 각 단계는 다음 단계의 입력 계약이다(§2 추가 결정). 빈 PASS는 "(덧붙일 내용 없음)"으로 기록을 남긴다 |
| `src/chat/chat-prompt.js` | discussion 블록에 임시 역할 페르소나 렌더링: 역할명·charter·“이 역할은 이번 토론에서만 유효합니다” 문구. protocol 토론에서는 CONTINUE/AGREE/PASS 태그 안내 대신 “마지막 순서(종합)만 CONCLUDE 가능” 계약을 안내 |
| `src/chat/chat-ipc.js` | `chat:discussion:start`에 `{presetId, cycleBudget, roleAssignments}` 검증 추가. preset id는 `DISCUSSION_PRESETS` 키만 허용. fullState의 `discussionPresets`에 preset별 `maxCycles` 포함 |
| `src/chat.js` | 토론 팝오버: 방식(자유/구조화) 선택 → 구조화 선택 시 preset select + cycle select(preset별 maxCycles로 재구성) + slot별 참가자 select 표시. 자유토론에서는 cycle UI 숨김(제안서 §11.1) |

### 저장 확장 (additive)

```json
{ "protocol": { "presetId": "shaping", "cycleBudget": 3, "cyclesCompleted": 2,
  "stepCount": 4, "roleAssignments": ["claude","codex","agy"],
  "failedStep": { "cycle": 1, "step": 2, "roleName": "비평가" } } }
```

- `cyclesCompleted`는 실행 시도(completed)가 아니라 **성공한 step** 기준이다 —
  마지막 step(종합)이 실패한 cycle을 완료로 세지 않는다.
- `failedStep`은 step 실패 중단 시에만 존재한다.
- 각 구조화 토론 메시지에는 `discussionTurnMeta{presetId, cycle, step,
  roleName}`가 붙는다(발화의 역사적 metadata — §2 추가 결정).

기존 소비자(summarizeDiscussion, 렌더러 결론 종합 버튼)는 미지 필드를 무시하므로
호환된다.

### 지키는 것

- 임시 역할은 프롬프트 오버레이일 뿐이다. `agent.id`, typing 상태, 멘션 파싱,
  transcript 저장은 전혀 바뀌지 않는다(제안서 §5.4, 완료 기준 4).
- 자유토론 경로는 기존 라운드로빈·settled 규칙 그대로.
- 사용자 중지(generation bump)는 protocol 토론에도 동일하게 적용, `reason:
  "interrupted"` 유지.

### 테스트

- discussion-protocol 순수 함수: preset 해석, speakerForTurn 순서 전수(3 cycle),
  clamp, 참가자 부족 오류.
- chat-room: protocol 토론의 발언 순서(fakeRunner 기록), 마지막 step CONCLUDE
  조기 종료, 중간 step CONCLUDE 무시, cycleBudget 소진 종료, discussionMeta의
  protocol 필드, 사용자 중지.
- 프롬프트: 역할 charter 문구 포함 여부.

---

## 6. Stage V1.5-3 — System Journal 기초

**목표**: 전문 실행의 사실을 세션 단위 append-only `professional-events.jsonl`에
남긴다. transcript와 합치지 않는다(INV-7). FSM이 현재 상태의 기준이고 Journal은
감사 기록이다(§10.4).

### 새 파일

- `src/agora/professional-journal.js`
  - `createJournalEvent({type, role, purpose, status, professionalRunId, frozenRunId, invocationId, artifactRefs})` —
    `{schemaVersion:1, eventId:"pe-<hex>", createdAt, ...}` 조립.
    eventId는 `crypto.randomBytes` 기반(newRunId 패턴 준용).
  - `journalEventsForTransition(prevRun, event, nextRun)` — FSM 전이를 제안서
    §10.3 이벤트 종류로 매핑하는 순수 함수:
    ```text
    PLANNER_PLAN_READY → ROLE_FINISHED(planner)
    PLANNER_NEEDS_DECISION → ROLE_FINISHED(planner) + USER_DECISION_REQUIRED
    PLAN_REVIEW_PASS → REVIEW_VERDICT(plan_review, PASS)
    PLAN_REVIEW_FIX/UNKNOWN → REVIEW_VERDICT + (UNKNOWN이면 USER_DECISION_REQUIRED)
    USER_ANSWER_PLAN → USER_DECISION_RECEIVED
    USER_EXECUTE → TASK_APPROVED
    BUILDER_DONE/BLOCKED → ROLE_FINISHED(builder) (+ BLOCKED이면 RUN_BLOCKED)
    REVIEW_PASS/FIX/UNKNOWN → REVIEW_VERDICT(review)
    RECORDER_DONE → ROLE_FINISHED(recorder) + RUN_COMPLETED
    CHECKPOINT_FAILED → CHECKPOINT_FAILED
    INTERRUPT/INVALIDATE → RUN_INTERRUPTED
    REPLAN_RESET → RUN_INTERRUPTED(purpose: replan)
    ```
    frozenRunId는 전이 전/후 상태 중 하나에 있을 때만 싣는다 — 계획 단계
    이벤트에는 양쪽 다 null이라 RUN-xxx가 연결되지 않고(제안서 §10.2, P1
    방어), REPLAN_RESET처럼 전이가 frozenRunId를 지우는 경우에는 prev 값을
    남겨 폐기되는 Run의 provenance를 보존한다. sessionId는 mixin이 직접
    싣는다(appender 배선에 기대지 않는 스키마 완결).
    발행 seam은 `recordJournalEntries`/`recordJournalEvent`로 추출되어
    FSM 전이 밖의 사건(Role Invocation·Handoff)도 같은 경로로 기록한다 —
    첫 소비자로 CONSULT가 ROLE_STARTED/ROLE_FINISHED(purpose: consult)를
    남긴다.

### 변경 지점

| 파일 | 변경 |
|---|---|
| `src/chat/chat-store.js` | `professionalEventsPath(id)`, `appendProfessionalEvent(id, event)` (한 줄 JSON append, **meta/index 부작용 없음**, readOnly·실패 시 `false` 반환 — 조용히 null을 돌려주는 appendEvent와 다르게 실패가 보이는 계약), `readProfessionalEvents(id)` (readJsonlTolerant + eventId 중복 시 첫 항목 유지) |
| `src/chat/chat-ipc.js` | 방 생성 closure에 `appendProfessionalEvent: (event) => store.appendProfessionalEvent(sessionId, event)`를 `persistProfessionalRun` 옆(975-979)에 추가 |
| `src/chat/chat-room.js` | 생성자 옵션 `appendProfessionalEvent` 보관 (기본 no-op) |
| `src/chat/chat-specialist.js` | `transitionProfessional()`(181-196)에서 setProfessionalRun 성공 **후** `journalEventsForTransition` 결과를 append. 실패 시 `appendSystem`으로 1회 알림(연속 실패 도배 방지 플래그) — 실행은 계속 |

### 저장 규칙 (제안서 §10.4 이행)

- append-only, 한 이벤트 = 한 줄.
- 같은 eventId 중복은 읽기에서 제거(첫 항목 승리). append 재시도로 인한 이중
  기록을 읽기 계층이 흡수한다.
- 민감 정보(전체 prompt, secret, stdout)는 싣지 않는다. artifact는
  ID/hash/경로 참조만(`artifactRefs`).
- UI는 Journal로 상태를 추측하지 않는다. 이번 Stage에서는 렌더러 노출 없음
  (뷰어는 Archivist와 함께 V1.5.2).

### 테스트

- chat-store: append/read, torn last line 복구, eventId 중복 제거, readOnly
  스토어에서 false, meta.json/index.json 무변경 확인.
- professional-journal: 전이→이벤트 매핑 전수(계획 단계에 frozenRunId 없음
  포함).
- 통합: `Object.create(ChatRoom.prototype)` 패턴으로 transitionProfessional
  경유 시 journal append 호출 확인, append 실패 시 시스템 알림 1회.

---

## 7. Stage V1.5-4 — 역할 멘션 + CONSULT 직접 호출

**목표**: `@기획자 이 구조 괜찮아?` 같은 역할 멘션이 읽기 전용 단일 응답
(CONSULT)으로 동작한다. 멘션은 Target이지 실행 승인이 아니다(INV-2, INV-3).

### 변경 지점

| 파일 | 변경 |
|---|---|
| `src/chat/chat-mention.js` | `ROLE_ALIASES` 테이블 + `parseRoleMentions(text)` 추가 — 기존 `parseMentions`와 같은 마스킹·토큰화 재사용, **기존 함수 시그니처 불변** |
| `src/chat/chat-ipc.js` | `chat:send` handler: agent/group 멘션이 없고 역할 멘션이 있으면 `specialistStageFor`로 담당자 해석 후 `room.consultRole(...)` 호출. 담당자 미지정·활성 run·토론 중이면 시스템 메시지로 사유 안내(조용한 무시 금지). 실행 전제조건이 없는 상태에서 오는 EXECUTE성 요청도 CONSULT로만 응답 |
| `src/chat/chat-room.js` | `consultRole({roleId, stage, agent, agentConfig, roleLabel, attachments})` — **전문 stage 턴이 아니라 일반 턴 + `context.consult`다**(§2 추가 결정: harness가 role 실린 컨텍스트에 professionalRunId를 요구하므로 stage 턴으로 위장하면 fail-closed로 죽는다). runResponseTurn의 consult 분기가 permission을 `min(세션 권한, workspace-read, 역할 cap)`으로 강등(Builder CONSULT → workspace-read, Recorder CONSULT → chat), STATUS/VERDICT 마커 파싱 없음, 멘션 연쇄 없음, workspace mutation lease 미참여. ROLE_STARTED/ROLE_FINISHED를 Journal에 남긴다 |
| `src/chat/chat-argv.js` | `SPECIALIST_STAGE_CAPS`에 `archivist: "chat"` 추가(§8 Recorder/Archivist 분리) — consult의 강등 계산은 room 계층에서 기존 cap을 조회만 한다 |
| `src/chat/chat-prompt.js` | 최상위 `consult` 블록 추가(specialist 분기와 별개): “질문에 답하는 읽기 전용 단일 응답. 파일을 수정하지 않는다. Task/Run을 만들지 않는다. STATUS 마커 불필요.” + 역할별 관점 한 줄 + NEEDS_PLAN 안내. consult는 일반 턴이라 ROLE_CONTEXT_POLICY가 아니라 일반 채팅 context 규칙을 따른다(transcript로 질문을 읽는다) |
| `src/chat.js` | `mentionTargets()`에 역할 항목 4개 추가(`기획자/구현자/검토자/기록자`, project 역할 설정에서 담당자 없으면 unavailable 표시). 하드코딩 `"모두"` 항목은 유지 |

### 안전 경계 (제안서 §16 P1 방어 이행)

- metadata 없는 역할 멘션은 **항상 CONSULT** — 실행 경로는 기존 버튼뿐.
- CONSULT 턴은 `scheduleMentionReplies` 제외(연쇄 금지)이고, turnRootId를
  갖지 않아 dedupe 대상이 아니다 — 같은 agent가 다른 역할로 연속 호출돼도
  충돌하지 않는다.
- backend가 최종 authority: renderer가 어떤 문자열·플래그를 보내든 강등은
  room+IPC 계층에서 다시 계산된다. 라우팅 판단도 renderer의 professionalDraft
  플래그가 아니라 방의 실제 상태(실행·토론 진행 중 여부)로 한다.
- `NEEDS_PLAN`: READY Task 없이 Builder에게 실행을 요구하는 텍스트에는 CONSULT
  응답 후 “실행은 PLAN → 실행 버튼으로” 안내를 프롬프트 계약에 포함.

### 테스트

- chat-mention: 역할 별칭 파싱, provider/group 멘션과의 배타 규칙, 한글 조사,
  코드펜스 마스킹, 미지 토큰 무시 유지.
- chat-room: consultRole이 read 권한으로 1턴만 스케줄(fakeRunner의
  permissionMode 기록 검증), builder consult가 workspace-read, recorder
  consult가 chat, 마커 파싱 생략, 연쇄 없음.
- IPC: 역할 멘션 라우팅, 담당자 미지정 안내, 활성 run 중 거부 안내.
- 렌더러 소스 앵커(agora-ui 등) 영향 확인.

---

## 8. Stage V1.5-5 — 구조화 Role Handoff 런타임 (후속 작업 설계, 재설계판)

Stage 0 재설계판이 파서(`parseControlOutput`)·구조 검증(`validateHandoff`)·
표면→계약 정규화(`executionContractFor`)·budget·ledger를 제공한다. 남는 일은
런타임 연결이며, **초판 문서의 "전이표 검증" 접근은 폐기한다** — 그대로
구현하면 새 이름의 고정 Professional FSM으로 돌아간다.

### 결과 축과 routing 축은 독립 계약이다 (확정 결정)

STATUS/VERDICT와 제어 출력은 우선순위 관계가 아니라 **서로 다른 축**이다.

```text
STATUS / VERDICT              = 현재 역할이 무엇을 해냈는가 (결과 계약 — 기존 보존)
HANDOFF / COMPLETE / ASK_USER = 그 결과 다음에 어디로 갈 것을 요청하는가 (routing 계약 — 추가)
```

Builder가 `STATUS: DONE` + `HANDOFF: @reviewer`를 함께 내면 둘 다 유효하다.
제어를 "기존 신호가 없을 때만" 쓰게 하면 역할들은 항상 STATUS/VERDICT를
내므로 Handoff가 장식이 되고 기존 FSM이 다시 흐름을 정한다. Runtime 판정
순서: ① 결과 축 판정(STATUS/VERDICT — 기존 파싱 그대로) → ② 제어 축 파싱
→ ③ **조합 합법성 검증** → ④ 합법이면 제어 실행.

조합 판정표(`validateResultControl` — 결과와 routing의 정합성이지 역할 간
고정 순서가 아니다):

| 계약 | 결과 | 허용 routing |
|---|---|---|
| planner | PLAN_READY | HANDOFF reviewer |
| planner | NEEDS_DECISION | ASK_USER |
| plan_review | PASS | HANDOFF builder (실행 전제조건: 사용자 승인/autoContinueReady) |
| plan_review | FIX_REQUIRED | HANDOFF planner |
| plan_review | UNKNOWN | ASK_USER |
| implementation | DONE | HANDOFF reviewer |
| implementation | BLOCKED | ASK_USER, HANDOFF planner(재기획) |
| review | PASS | COMPLETE(완료 전제조건 검증), HANDOFF recorder(Archivist 선택 호출) |
| review | FIX_REQUIRED | HANDOFF builder, HANDOFF planner |
| review | UNKNOWN | ASK_USER |
| archivist | (정리 완료) | COMPLETE |

거부 예: Builder BLOCKED + COMPLETE, Reviewer FIX_REQUIRED + COMPLETE.
결과 자체가 미해결(AMBIGUOUS/MISSING)이면 제어를 실행하지 않는다 — 기존
안전 정지 경로가 우선한다. 제어가 없으면 기존 FSM 기본 흐름이 그대로
진행된다(하위 호환).

원칙: Handoff 요청의 수용 여부는 세 층으로 갈라 판정한다.

```text
구조 검증 (interaction-contract)   어휘·loop·stale·budget·동시성
조합 검증 (validateResultControl)  결과 축과 routing 축의 정합성
실행 전제조건 검증 (런타임)         Builder → READY Task·Frozen hash·checkpoint
                                   Reviewer → 판정할 artifact 존재
                                   COMPLETE → 검수 통과 여부
```

### 최종 범위 (확정 — 검수 #6 반영)

이번 개편(V1.5)은 여기서 종료한다. 완성된 것을 정확히 부르면
**Handoff-aware Professional FSM**이다:

- 기존 Professional FSM을 유지하면서 역할별 Handoff 요청(2축 계약),
  안전한 routing 조합 검증, Handoff Journal/ledger/fail-closed 영속/crash
  recovery, `@팀 실행` 인터페이스를 추가했다. 즉 **Orchestrator에 필요한
  Handoff primitive를 구축한 상태**다.
- **Handoff는 아직 호출 순서의 authority가 아니다.** 다음 역할이 호출되는
  이유는 Handoff consumer가 invoke해서가 아니라 기존 FSM의 기본 다음
  단계이기 때문이며, FSM과 다른 routing(예: Reviewer FIX_REQUIRED →
  `HANDOFF: @planner`)은 수용·기록 후 자동 진행을 멈추고 사용자에게
  돌린다(INV-5). 제어가 없어도 기본 FSM은 계속 간다.
- 진짜 Role-driven routing — `invokeProfessionalRole(targetRole, context)`
  같은 generic Role Invocation primitive를 만들고, HANDOFF 수용 →
  executionContractFor → 전제조건 검증 → invoke → 결과 → control의
  루프가 호출 순서를 결정하게 하는 것 — 은 **Professional V2**로 넘긴다.
  실사용에서 FSM 교체가 실제로 필요한지 본 뒤 결정한다. Orchestrator는
  그 위에서 invokeProfessionalRole을 대신 호출하는 상위 controller다.

사용자 개입은 자동 진행 중에도 가능하고, 새 사용자 지시는 rootMessageId
기준 새 Handoff budget epoch를 연다. Frozen Task·Checkpoint·Permission
cap·Evidence·Journal·ledger·crash recovery·stale 차단의 안전 계층은 전부
유지한다.

순서 (**Archivist 준비가 Handoff consumer보다 먼저다**):

0. **Archivist 실행 계약 완성**: (a) `ROLE_CONTEXT_POLICY`에 archivist 정책
   등록 — **정책 없는 role은 roleSees()가 전체 context를 돌려주므로**,
   등록 전에 `specialist.stage = "archivist"` 턴을 실행하면 보수적 차단이
   아니라 context 제한이 풀린다. 등록이 프롬프트·소비 연결보다 먼저다.
   (b) chat-prompt에 archivist 계약 분기(사람이 읽는 정리, 새 결정·판정
   생성 금지, `derivedSummary` 표시). (c) 그 다음에야
   `executionContractFor("recorder")` 결과를 실제로 소비한다.
1. `buildAgentPrompt` 역할 계약에 제어 출력 형식(HANDOFF/COMPLETE/ASK_USER)
   안내 추가 — end-anchor 규칙(마지막 연속 블록만 유효)도 프롬프트에 명시.
2. `runResponseTurn`에서 `parseControlOutput`으로 제어 행동 추출 → outcome에
   `controlRequest` 필드 추가.
3. 소비자는 `executionContractFor`로 표면 역할을 실행 계약으로 정규화한 뒤,
   구조 검증 → 실행 전제조건 검증 순으로 통과할 때만 다음 역할을 실행한다.
   실행 경로 세 벌(runPlanBlock / runExecutionBlockInner /
   resumeStepPhaseInner) 모두에 적용하거나, 가능하면 단일 소비 지점으로
   합친다.
4. Journal에 `HANDOFF_REQUESTED / ACCEPTED / REJECTED` 기록 —
   `recordJournalEvent` seam이 이미 있다.
5. **Ledger의 authoritative 영속화**: Handoff 원장(`rootMessageId / used /
   consumedInvocationIds / activeInvocationId / lastTargetRole`)은
   `serializeHandoffLedger` 결과를 `professionalRun.handoffState`에 싣고
   기존 `persistProfessionalRun`(fail-closed) 경로로 저장한다.
   **Journal에 의존하지 않는다** — Journal은 실패해도 실행이 계속되는
   비권위 감사 기록이다(§10.4).
6. **복원은 두 규칙을 따른다**: 재시작 시
   `recoverHandoffLedgerForRoot(persistedState, 현재 root 발화 id)`로
   복원한다(재시작/복원 전용 — 살아 있는 run은 in-memory ledger 유지,
   root 누락은 HANDOFF_ROOT_REQUIRED) —
   (a) 죽은 active invocation은 INTERRUPTED로 폐기(소비 기록 유지, active
   슬롯 해제 — ghost BUSY 방지)하고 `interruptedInvocationId`를 Journal에
   남긴다. (b) 새 사용자 지시는 새 budget epoch를 받는다 — 아니면 "발화
   1회당 8회"가 Run 전체 예산으로 변질된다.
7. **identity는 Runtime이 주입한다**: `sourceRole`·`professionalRunId`·
   `generation`·`invocationId`는 모델 출력에서 읽지 않고, 소비 지점이 현재
   invocation의 실제 값으로 채운다. 모델 출력에서 오는 것은 targetRole·
   purpose·reason·question·summary뿐이며 그것도 end-anchor 제어 블록에서만
   읽는다.
8. **Recorder/Archivist 분리 유지**: `executionContractFor("recorder")`는
   `"archivist"`(cap chat)를 돌려준다. 기존 professional `recorder` stage는
   deterministic finalizer가 가로채 LLM을 호출하지 않으므로, @기록자를 그
   stage로 연결하면 "기록 역할을 맡은 AI" 대신 finalizer가 불린다.
   deterministic System Journal/finalizer는 Runtime 기능이지 Handoff 대상이
   아니다.

### 구현 기록 (Stage 5 본체)

위 0~8이 구현되었다. 소비 지점은 SpecialistMixin의 seam 세 개로 모인다:

- `ensureHandoffLedger()` — 최근 사용자 발화를 root로 원장 확보. 같은 root의
  살아 있는 in-memory 원장은 재사용, root가 바뀌면 새 budget epoch, 저장된
  `professionalRun.handoffState`가 같은 root면 `recoverHandoffLedgerForRoot`
  복원(죽은 active invocation은 INTERRUPTED 폐기 + Journal `crash_recovery`).
- `persistHandoffState()` — `professionalRun.handoffState`에 직렬화해
  `persistProfessionalRun`(fail-closed)으로 저장. 실패 시 이전 직렬화본으로
  in-memory 원장을 원복하고 소비를 거부한다(`HANDOFF_STATE_WRITE_FAILED`).
- `consumeControlRequest({contract, result, outcome})` — 단일 소비자.
  `validateResultControl` 조합 검증 → 거부는 `HANDOFF_REJECTED` Journal +
  사용자 안내 후 기존 기본 흐름 유지. ASK_USER/COMPLETE는 원장을 소비하지
  않고 수용만 기록, HANDOFF는 Runtime identity 주입 → `consumeHandoff` →
  영속 성공 후 `HANDOFF_ACCEPTED`.

auto/full 경로의 결정 지점 여섯 곳(planner NEEDS_DECISION·PLAN_READY,
plan_review 판정, builder 첫 라운드, review 판정, 보완 라운드 builder)이 이
소비자를 호출한다. 수용된 제어의 실행 의미:

- Reviewer `PASS + HANDOFF: @recorder` → 완료 확정 후 Archivist(LLM, 기록
  정리) 추가 호출. 완료를 막지 않는 부가 정리이며 실패해도 COMPLETED 유지.
- Builder `BLOCKED + HANDOFF: @planner`, Reviewer `FIX_REQUIRED + HANDOFF:
  @planner` → 자동 보완을 멈추고 재기획을 사용자에게 안내(재기획 시작은
  기존 명시 액션 — INV-5 사용자 개입 지점 유지).
- 나머지 수용 조합(DONE→reviewer, PLAN_READY→reviewer, PASS→builder 등)은
  기존 FSM의 기본 다음 단계와 일치하므로 원장 소비·Journal 기록 후 같은
  흐름으로 진행한다.

**step 모드(`resumeStepPhaseInner`)는 이번 증분에서 제어 소비를 배선하지
않았다** — step은 단계마다 사용자에게 돌아오는 모드라 routing 요청의 실행
가치가 낮고, 소비자 seam은 공유되므로 후속에서 호출 한 줄로 붙일 수 있다.
소비자가 없는 턴에서 parse/strip만 하면 화면에서 지워지고
HANDOFF_REQUESTED만 남는 ghost 요청이 생기므로, **제어 추출 자체를
`controlOutputs: true`(소비자가 붙은 auto/full 결정 지점) 턴으로
한정한다** — step 모드의 제어 줄은 본문 그대로 남고 Journal에도 남지
않는다.

**incoming Handoff lifecycle은 outgoing control과 분리된 축이다**(검수 #6):
수용된 invocation은 "다음 control이 나와서"가 아니라 **대상 역할의 실행이
실제로 끝났을 때** settle된다. `settleIncomingHandoff()`가 (a) 모든 결정
지점 진입 시(consumeControlRequest 첫 줄 — control 유무·종류와 무관),
(b) Archivist 종료 지점(다음 결정 지점이 없는 마지막 고리)에서 active
슬롯을 해제하고 영속한다. 이전 구조(다음 HANDOFF가 있을 때만 settle)는
control 없는 정상 완료·PASS+COMPLETE·Archivist 종료에서 슬롯을 남겨,
재시작 recovery가 정상 완료를 INTERRUPTED로 기록했다. settle의 영속
실패는 흐름을 막지 않는다(소비가 아닌 정리 — 다음 영속 기회에 함께
저장). 회귀 3종: control 없는 PASS / PASS+COMPLETE / HANDOFF @recorder →
Archivist 완료, 모두 `activeInvocationId === null`.

완료 후 Archivist 호출은 계약이 허용하는 canonical 자료를 실제로 받는다:
System Journal(최근 40건)에 **frozenTask·reviewDiff(최종 변경)·evidence·
finalVerdict**를 함께 전달한다 — 사건 이력만으로는 "무엇이 바뀌었는지"를
요약할 수 없다.

회귀 테스트: `test/chat-handoff-consumer.test.js`(수용·거부·rollback·crash
복원·epoch·개입·settle lifecycle), `test/chat-control-output.test.js`
(추출·ghost 차단), `test/interaction-contract.test.js`(조합표 전수).

## 9. Stage V1.5-6 — @모두 Planner-first 팀 실행 (일부 구현 + 후속 설계)

- `@모두`의 기존 의미(셔플 브로드캐스트)는 **일반 채팅에서 유지**한다. 팀
  Protocol은 별도 멘션 `@팀`으로 발동 — 기존 `@모두` 테스트(chat-mention,
  chat-room)를 깨지 않는 경계다.
- **팀 상담(CONSULT) — 구현 완료**: `@팀` 멘션이 Planner→Reviewer→Builder
  순차 consultRole 3턴을 실행한다(`consultTeam`, chat-room.js). Professional
  Run 생성 없음, Freeze 없음, write 없음, Recorder 자동 호출 없음(제안서
  §9.2). 뒤 순서는 앞 상담 답변을 대화 기록으로 읽는다. 중간 실패·사용자
  중지(generation bump)에서 멈춘다.
- **팀 자율 실행(`@팀 실행`) — 구현 완료**: `@팀`(Team Consult)은 그대로
  두고, 멘션 바로 다음 토큰이 정확히 `실행`(영문 `run`)인 메시지만 자율
  실행 트리거로 승격한다(`parseTeamRunDirective`, chat-mention.js) — 본문
  임의 위치의 "실행"으로 상담 질문("이 실행 계획 어때?")이 실행이 되지
  않는다(INV-2 유지). 라우팅(chat-ipc `chat:send`): 다섯 역할 담당자를
  전부 해석(`specialistStagesFor(project, room, "full")` — 담당자 공백은
  시작 전에 fail)한 뒤 `startSpecialist({ action: "plan", mode: "auto",
  planAutoRevisions: 1, implementationAutoRevisions: 1 })`로 시작한다.
  기획 → 기획 검수가 자동 진행되고 **EXECUTE 직전 READY 승인 게이트에서
  멈춘다** — 채팅 문장은 `autoContinueReady`(EXECUTE 사전 승인)를 만들 수
  없다(§9.4). 사용자가 기존 승인 액션으로 승인하면 구현·검수·기록은
  **기존 Professional FSM이 자동 진행**하며, 각 역할의 HANDOFF 요청은
  조합 검증·원장 소비·Journal로 기록되는 overlay다(§8 최종 범위 —
  호출 순서의 authority는 아직 FSM). 워크스페이스 없는 세션은
  실행을 시작하지 않고 이유를 채팅에 남긴다. 회귀:
  `test/chat-team-run.test.js`.
- 역할의 제어 출력(HANDOFF/COMPLETE/ASK_USER)은 Runtime이 구조 검증 +
  조합 검증 + 실행 전제조건 검증으로 수용을 판정한다. 승인 Gate(READY
  정지, `전체 실행` 사전 승인)는 실행 전제조건 검증 층에서 그대로 산다 —
  자연어로 우회 불가(§9.4). Handoff가 실제 호출 순서를 결정하는
  Role-driven routing은 Professional V2(generic
  `invokeProfessionalRole`)의 것이다.
- 그 위의 Orchestrator는 같은 Role Invocation/Handoff API를 사용하는 상위
  controller다. `HANDOFF_TARGETS`에 orchestrator를 추가하지 않는다 —
  Specialist가 아니라 primitive의 사용자이기 때문이다.
- 셔플 경로(chat-room.js sendUserMessage의 브로드캐스트)와의 분기점은
  IPC(chat:send 라우팅)다.

---

## 10. 테스트 전략

1. 각 Stage 커밋 전 `npm test` 전체 green (기준선 1249 pass / 1 skip에서 skip
   수 불변, fail 0).
2. 빠른 루프: `node --test test/<관련파일>...` (3파일 ≈ 0.2s).
3. 새 기능 테스트는 파일별 로컬 헬퍼 관례를 따른다(공유 헬퍼 도입 금지 —
   90+ 파일 영향).
4. 소스 앵커 테스트를 건드리는 파일(chat-ipc/chat-prompt/chat-specialist)을
   수정할 때는 해당 앵커 테스트를 같은 커밋에서 갱신.
5. 기존 한글 문구 assertion(`/예산/`, `자율 토론 1/9턴` 등)은 바꾸지 않는 것을
   기본으로 하고, 불가피하면 테스트와 함께 바꾼다.

## 11. 회귀 금지 목록 (제안서 §13 + V1 §12)

- `[[CODEPET_DISCUSSION:...]]` / `[[CODEPET_REVIEW:...]]` 태그 의미
- `@claude / @gpt / @gemini` 멘션과 mentionChainLimit
- 자유토론 기본 9턴, round-robin, settled 종료 규칙
- `step / auto / quick` 호환 어댑터, Frozen Task hash, checkpoint/restore
- 세션 meta schemaVersion 3, 기존 discussionMeta 필드
- stage 권한 cap (planner/plan_review/review=read, implementation=write,
  recorder=chat)
- Recorder deterministic finalizer와 RECORDING 노드

## 12. 완료 기준 (제안서 §18 중 이번 범위 해당분)

- 자유토론은 round-robin을 유지하면서 budget을 설정할 수 있다. (Stage 1)
- 구조화 토론은 정확한 Protocol step과 cycle 수를 따르고, Rule 활성 중 랜덤
  호출이 없다. (Stage 2)
- 임시 토론 역할이 종료 후 참가자 identity에 남지 않는다. (Stage 2)
- 역할 멘션만으로 쓰기 권한이나 전체 실행이 시작되지 않는다. 질문은 기본
  읽기 전용 단일 응답이다. (Stage 4)
- System Journal이 transcript와 분리되어 사건을 기록한다. (Stage 3)
- 기존 Frozen Task·checkpoint·evidence·Reviewer 경계가 유지된다. (전 Stage)

## 13. 코드 리뷰 결과와 기술 부채 (V1.5 종료 시점)

멀티에이전트 리뷰(10관점 병렬 탐지 → 관점 다양화 적대적 검증, 2라운드)로
확정된 18건을 수정했다(2 HIGH · 2 MEDIUM · 나머지 LOW). 대표: maskCodeFences
개행 붕괴로 인한 표시/저장 본문 유실, ASK_USER 질문 소실(NEEDS_DECISION
게이트 파손), 자동보완 루프의 lastTargetRole 잔존 거짓 거부, Handoff 예산
소진에 따른 Archivist 유실·거부 스팸, handoff REASON 감사 누락, consult 방
잠금 부재, NFD 한글 멘션 누락 등. 각 항목에 회귀 테스트를 추가했다.

### 후속 리팩토링 부채 (bug 아님 — 품질/유지보수)

아래 3건은 실재하는 유지보수 부채지만 전부 load-bearing한 프롬프트 텍스트
또는 auto-revise 루프를 건드리고, 리뷰의 적대적 검증이 (세션 한도로) 이
항목까지 완료되지 못했다. V1.5 종료를 막지 않으며, 별도 리팩토링 패스에서
각각 회귀 테스트와 함께 처리한다.

1. **제어 조합 계약의 이중 진실**(chat-prompt.js `controlGuides` ↔
   interaction-contract.js `RESULT_CONTROL_ROUTES`): 허용 조합이 두 곳에
   따로 하드코딩돼 있어 한쪽만 바꾸면 어긋난다. `RESULT_CONTROL_ROUTES`를
   단일 원천으로 삼아 프롬프트 안내 문구를 파생 생성하는 방향.
2. **recorder/archivist 프롬프트 렌더 중복**(chat-prompt.js): finalVerdict·
   reviewDiff·evidence 렌더 블록이 두 stage 분기에 거의 동일하게 중복.
   공통 헬퍼로 추출(단, 한글 문구가 load-bearing이므로 출력 바이트 동일성
   회귀 확인 필요).
3. **builder 제어 소비·재기획 안내 중복**(chat-specialist.js 최초 라운드 ↔
   보완 라운드): 두 결정 지점의 consumeControlRequest + 재기획 안내 로직이
   통째로 중복. 단일 헬퍼로 합치되 auto-revise 상태 전이 회귀 확인 필요.

### 의도적으로 유지한 것(리뷰가 dead-code로 지목했으나 보존)

`interaction-contract.js`의 `normalizeInteraction` / `executionContractFor` /
`resolveReviewerContract` / `INTERACTION_*` 상수는 미사용처럼 보이지만,
이 모듈이 명시적으로 설계한 **재사용 계약 API 표면**(직접 역할 호출·@팀·
향후 Orchestrator/Professional V2가 같은 API를 쓰기 위한 것)이고 단위
테스트가 있다. 제거하지 않는다. `RESULT_CONTROL_ROUTES.archivist`도 2축
조합표를 완결적으로 문서화하므로 유지한다.
