# Ἀγορά — CodePet Fork / Delta Implementation Specification

> **문서 목적**  
> 이 문서는 `nokryong/CodePet`을 기반으로 **Ἀγορά**를 구현하는 코딩 에이전트에게 전달하기 위한 기준 명세다.  
> 핵심 원칙은 **CodePet에서 이미 안정적으로 동작하는 멀티에이전트 기능을 다시 만들지 않고**, 필요한 차이만 최소 변경으로 추가하는 것이다.
>
> **기준 저장소**  
> - Repository: `https://github.com/nokryong/CodePet`
> - Branch: `main`
> - 검토일: 2026-08-08
> - 현재 `package.json` version: `0.3.2`
> - License: MIT
>
> **중요:** README와 실제 구현이 충돌하면 **현재 source code를 구현 사실의 기준(source of truth)** 으로 사용한다.

---

## 0. 구현 에이전트에게 가장 먼저 주는 지시

### 절대 원칙

1. **CodePet 전체 저장소를 먼저 읽고 구조를 이해한 뒤 수정한다.**
2. 기존에 동작하는 기능을 새 프레임워크로 재작성하지 않는다.
3. React/Tauri/새 백엔드 등으로 전면 재작성하지 않는다.
4. 기존 Electron + Node + vanilla renderer 구조를 우선 유지한다.
5. 변경 전 반드시 baseline test를 실행한다.
6. 변경 후 기존 test를 깨뜨리지 않는다.
7. 기존 Claude / Codex / Antigravity 실행 어댑터를 가급적 그대로 유지한다.
8. 기존 세션 데이터를 파괴하거나 자동 삭제하지 않는다.
9. 기존 `@claude`, `@codex`, `@agy`, `@all` 호출 호환성을 유지한다.
10. 사용자 승인 없이 자율적인 무한 agent delegation 구조를 만들지 않는다.
11. Planning 단계에서는 Agent에게 별도의 업무 Role persona를 강제로 부여하지 않는다.
12. CodePet에서 이미 구현된 순차응답/토론/멘션/권한/모델·effort 기능은 **재구현 대상이 아니다.**

### 최초 작업 절차

```text
1. repository checkout
2. npm install
3. npm test
4. 현재 테스트 결과 기록
5. 관련 소스 파일 구조 확인
6. 본 문서의 Phase 1부터 순차 구현
7. 각 Phase마다 테스트 추가/수정
8. npm test
9. 실제 Claude/Codex/AGY smoke test
10. packaging smoke test
```

---

# 1. 제품 정의

## 1.1 이름

**Ἀγορά**

CodePet의 "데스크톱 펫 + 에이전트 채팅방" 중에서 멀티에이전트 채팅 코어를 중심으로 재구성한 **human-led multi-agent workspace**다.

## 1.2 핵심 사용 흐름

```text
Discuss
  ↓
Decide
  ↓
Assign
  ↓
Execute
  ↓
Review
```

사용자는 항상 작업의 책임자다.

AI Agent들이 자동으로 조직을 운영하는 시스템을 만드는 것이 목적이 아니다.

---

# 2. CodePet 소스 감사 결과

## 2.1 현재 핵심 구조

CodePet의 채팅 코어는 이미 상당히 모듈화되어 있다.

```text
src/
├─ chat/
│  ├─ chat-agent-runner.js
│  ├─ chat-agents.js
│  ├─ chat-argv.js
│  ├─ chat-attachments.js
│  ├─ chat-emoticons.js
│  ├─ chat-events.js
│  ├─ chat-ipc.js
│  ├─ chat-mention.js
│  ├─ chat-prompt.js
│  ├─ chat-room.js
│  ├─ chat-store.js
│  └─ chat-window.js
│
├─ providers/
│  ├─ provider-capabilities.js
│  └─ provider-diagnostics.js
│
├─ chat.html
├─ chat.js
├─ chat-markdown.js
├─ chat-preload.js
├─ provider-usage.js
├─ codex-usage-label.js
├─ settings.html
├─ settings.js
└─ ...
```

CodePet README 역시 `chat-window.js` / `chat-ipc.js`를 제외한 채팅 코어 대부분을 Electron 비의존 Node 모듈로 유지한다고 설명한다.

따라서 **멀티에이전트 실행 코어를 새로 만드는 방향은 금지한다.**

---

# 3. CodePet에서 반드시 유지할 기능 — KEEP

다음은 Ἀγορά의 신규 기능이 아니다.

가능한 한 기존 구현을 그대로 사용한다.

| 기능 | 현재 CodePet 구현 | Ἀγορά 처리 |
|---|---|---|
| Claude Code CLI 탐지/실행 | 있음 | KEEP |
| Codex CLI 탐지/실행 | 있음 | KEEP |
| Antigravity `agy` CLI 탐지/실행 | 있음 | KEEP |
| CLI 설치/버전/로그인 진단 | 있음 | KEEP |
| 세션 생성/전환/이름변경/삭제 | 있음 | KEEP |
| 대화 로컬 저장 | 있음 | KEEP |
| 첨부파일 | 있음 | KEEP |
| Agent 참가 ON/OFF | 있음 | KEEP |
| `@claude`, `@codex`, `@agy` | 있음 | KEEP |
| `@all`, `@모두` | 있음 | KEEP |
| Agent 답변 속 `@agent` 실제 호출 | 있음 | KEEP |
| mention chain 제한 | 기본 2 | KEEP |
| 멘션 없는 질문 → 참가 Agent 전체 호출 | 있음 | KEEP |
| 전체 응답 순서 shuffle | 있음 | KEEP |
| Agent의 순차 응답 | 단일 turn queue | KEEP |
| 뒤 Agent가 앞 Agent 답변을 봄 | 있음 | KEEP |
| 앞 답변 반복 방지/보완 유도 | prompt에 있음 | KEEP |
| Discussion | 있음 | KEEP |
| Discussion AGREE/PASS/CONCLUDE | 있음 | KEEP |
| Discussion 실행 예산 | 기본 9 | KEEP |
| 사용자 interject | 있음 | KEEP |
| 대기 turn 개별 cancel | 있음 | KEEP |
| 모델 선택 | provider capability 기반 | KEEP |
| Effort 선택 | provider/model 기반 | KEEP |
| 모델/effort/CLI version 응답 메타 | 있음 | KEEP |
| Chat / Read / Write 권한 | 있음 | KEEP |
| Write 시 auto approve | 있음 | KEEP |
| Permission request / retry | 있음 | KEEP |
| stdout streaming/event normalization | 있음 | KEEP |
| live partial response UI | 있음 | KEEP + IMPROVE |
| rich markdown renderer | 있음 | KEEP |
| Provider usage/quota backend | 있음 | KEEP |
| 계정 저장/전환 기능 | 있음 | KEEP |
| 저장소 atomic write / JSONL transcript | 있음 | KEEP |

---

# 4. 특히 새로 만들지 말아야 하는 것

## 4.1 일반 질문의 랜덤 순차 멀티에이전트 응답

이미 `src/chat/chat-room.js`의 `sendUserMessage()`에 구현되어 있다.

현재 구조:

```text
User message
   ↓
parseMentions()
   ↓
멘션 없음 → enabledAgents()
   ↓
shuffle(respondents)
   ↓
scheduleResponse()
   ↓
room-wide single turn queue
   ↓
Agent A
   ↓
Agent B
   ↓
Agent C
```

`pumpTurnQueue()`가 각 `respond()`를 `await`하므로 **실제 동작은 순차적**이다.

따라서 사용자가 원하는 다음 Planning round는 이미 CodePet 기본 동작이다.

```text
User
↓
Random Agent 1
↓
Random Agent 2
↓
Random Agent 3
↓
User
```

### 뒤 Agent가 앞 답변을 참고하는 기능

`src/chat/chat-prompt.js`에서 broadcast position이 2 이상이면 앞선 참가자의 답변을 확인하고:

- 단순 반복하지 않고
- 보완하거나
- 다른 관점을 추가하거나
- 필요한 경우 반박

하도록 이미 prompt가 구성된다.

**이 기능을 새 Discussion engine으로 다시 구현하지 않는다.**

---

# 5. 기존 Discussion — KEEP

`ChatRoom.startDiscussion()`이 이미 존재한다.

현재 Discussion은 다음 기능을 갖는다.

- 참여 Agent 선택
- 한 Agent씩 순차 실행
- 이전 Agent 발언을 다음 Agent가 확인
- `CONTINUE`
- `AGREE`
- `PASS`
- `CONCLUDE`
- 결론 발생 시 조기 종료
- 참가자 전원의 연속 AGREE/PASS 시 조기 종료
- 총 실행 예산 기본 9
- 사용자 interject 가능

### 주의

일반 broadcast의 Agent 순서는 shuffle되지만, 현재 `startDiscussion()` 내부 참가 순서는 enabled pool의 순환 방식이다.

**v0.1에서는 이 동작을 굳이 바꾸지 않아도 된다.**

향후 필요하면 다음 옵션을 추가할 수 있다.

```text
Discussion order
○ Current cyclic
○ Shuffle at start
○ Shuffle each round
```

그러나 이는 필수 MVP가 아니다.

---

# 6. Ἀγορά에서 제거/교체할 것 — REMOVE / REPLACE

## 6.1 Branding

다음 문자열과 product-level branding을 변경한다.

```text
CodePet → Ἀγορά
```

대상 예:

- `package.json`
  - `name`
  - `description`
  - `build.appId`
  - `build.productName`
  - artifact name
- 창 제목
- 메뉴
- tray tooltip
- settings title
- chat title
- 사용자에게 노출되는 `CodePet` 명칭

### MIT license

원본 MIT License의 저작권/허가 고지는 유지해야 한다.

새 프로젝트에서 원본 CodePet 코드의 substantial portions를 사용하므로 원본 LICENSE 고지를 삭제하지 않는다.

---

# 7. Pet UI 처리 전략

## 목표

최종 Ἀγορά는 Pet이 중심인 앱이 아니다.

하지만 v0.1에서 pet 관련 코드를 무리하게 전부 삭제하면서 provider/account/usage/watch 기능까지 망가뜨리지 않는다.

### 권장 단계

#### Phase 1

- 앱 시작 시 Chat/Workspace가 primary window가 되도록 변경
- Pet window는 숨기거나 optional feature로 격리
- Pet branding/menu dependency 제거
- 기존 provider/account/usage 코드 유지

#### Phase 2

동작 검증 후 정말 불필요한 pet-only 코드만 제거.

예:

```text
renderer.js
bubble.html / bubble.js
sprite / pet animation
pet movement
pet selection
```

### 금지

첫 커밋에서 `main.js`와 watcher/account/usage 코드를 대규모 삭제하지 않는다.

---

# 8. 캐릭터 이모티콘 제거 — REQUIRED

현재 CodePet은 Agent prompt 자체에 캐릭터 이모티콘 사용을 강제한다.

`src/chat/chat-emoticons.js`:

```text
emoticonPromptRules()
extractEmoticons()
[[CODEPET_EMOTE:key]]
```

현재 `chat-prompt.js`가 `emoticonPromptRules()`를 모든 Agent prompt에 추가한다.

현재 `chat-room.js`는 응답에서 `extractEmoticons()`를 호출한다.

현재 `chat.js`는 `contentParts` 중 emoticon을 이미지로 렌더링한다.

## Ἀγορά 변경 요구

### Prompt

다음 기능을 제거한다.

```text
매 답변마다 이모티콘을 하나 사용하라는 prompt
이모티콘 의미 사전
[[CODEPET_EMOTE:key]] 생성 지시
```

### Runtime

새 응답에 대해 `extractEmoticons()`를 호출하지 않는다.

Agent의 원본 text를 일반 text response로 저장한다.

### Renderer

새 메시지에서는 캐릭터 emoticon rendering을 사용하지 않는다.

### Legacy transcript

기존 CodePet transcript에 `contentParts` / emoticon이 존재해도 앱이 crash하지 않아야 한다.

권장:

```text
legacy emoticon part → 무시
legacy text part → 정상 렌더링
```

즉, **이전 대화 호환성을 위해 parser를 즉시 완전히 삭제하기보다 legacy compatibility path로 축소**해도 된다.

---

# 9. Agent 아이콘 변경 — REQUIRED

현재 `src/chat.js`:

```js
const AGENT_VISUALS = {
  claude: { src: "./chat-assets/claude.png", ... },
  codex:  { src: "./chat-assets/gpt.png", ... },
  agy:    { src: "./chat-assets/gemini.png", ... },
};
```

현재 UI에서는 사용자 제공 화면처럼 캐릭터형 avatar가 다음 chip에 표시된다.

```text
[캐릭터] @claude
[캐릭터] @codex
[캐릭터] @agy
```

## 변경 후

```text
[Claude brand icon]       @claude
[Codex/OpenAI brand icon] @codex
[Antigravity brand icon]  @agy
```

Agent 응답 avatar 역시 같은 provider icon을 사용한다.

## 구현 규칙

1. 내부 Agent ID는 바꾸지 않는다.
   - `claude`
   - `codex`
   - `agy`
2. `@claude`, `@codex`, `@agy` mention 호환성을 유지한다.
3. AGY의 표시 이름은 `Antigravity`를 사용할 수 있지만 alias `agy`는 유지한다.
4. 임의의 팬메이드/캐릭터 이미지를 사용하지 않는다.
5. 공식 provider/brand asset 사용을 우선하며 상표/브랜드 가이드라인을 확인한다.
6. light/dark mode 모두에서 식별 가능한 asset을 선택한다.
7. 이미지가 없거나 로딩 실패 시 현재 문자 fallback을 유지한다.

---

# 10. 정보 구조 변경 — 가장 중요한 신규 기능

현재 CodePet은 사실상 다음 구조다.

```text
Session
├─ title
├─ workspace
├─ permissionMode
├─ agents
├─ discussion
├─ transcript
└─ attachments
```

Ἀγορά에서는 이 위에 **Project**를 추가한다.

```text
Ἀγορά
└─ Project
   ├─ Project metadata
   ├─ Workspace
   ├─ Project Context
   ├─ Default Agent Settings
   │
   ├─ Chat / existing Session A
   ├─ Chat / existing Session B
   └─ Chat / existing Session C
```

## 핵심 원칙

**기존 Session engine을 폐기하지 않는다.**

`Session`을 Ἀγορά UI에서는 `Chat`으로 취급하고, 그 위에 Project 부모 개념만 추가한다.

---

# 11. Project Data Model — ADD

최소 필드:

```yaml
Project:
  id:
  name:
  createdAt:
  updatedAt:
  workspace:
  context:
  defaultPermissionMode:
  defaultAgents:
```

`defaultAgents`는 새 Chat 생성 시 복사할 기본값이다.

예:

```yaml
defaultAgents:
  claude:
    enabled: true
    model: default
    effort: high
  codex:
    enabled: true
    model: default
    effort: high
  agy:
    enabled: true
    model: default
    effort: high
```

### 중요한 상속 규칙

```text
Project default
   ↓
Chat override
```

현재 CodePet의 **세션별 model/effort/permission 설정은 계속 유효**해야 한다.

Project default는 새 Chat 생성 편의를 위한 기본값이지, 기존 Chat 설정을 강제로 덮어쓰지 않는다.

---

# 12. Storage 변경 전략

현재:

```text
~/.code-pet/
├─ config.json
├─ sessions/<id>/
│  ├─ meta.json
│  ├─ transcript.jsonl
│  └─ attachments/
└─ trash/
```

## 권장 최소 변경

기존 session 디렉터리의 물리적 위치를 v0.1에서 굳이 이동하지 않는다.

```text
~/.code-pet/
├─ config.json
├─ projects/
│  └─ <projectId>.json
├─ sessions/
│  └─ <sessionId>/
└─ trash/
```

그리고 session meta에:

```yaml
projectId:
```

를 추가한다.

이 방식은 기존 첨부/휴지통/transcript 코드를 최대한 건드리지 않는다.

## 기존 CodePet 세션 migration

`projectId`가 없는 기존 세션을 삭제하거나 이동하지 않는다.

안전한 migration 예:

```text
Imported CodePet Chats
├─ 기존 Session 1
├─ 기존 Session 2
└─ 기존 Session 3
```

또는 첫 실행 시 사용자가 Project를 선택하도록 할 수 있다.

### 절대 금지

- 기존 `~/.code-pet` 자동 삭제
- 기존 transcript rewrite
- migration 실패 시 원본 세션 손상
- schema downgrade

### 데이터 폴더 rebrand

장기적으로 `~/.agora` 사용은 가능하다.

그러나 v0.1에서는 **브랜딩보다 무손실 migration을 우선한다.**

새 경로로 변경한다면:

```text
copy/import
```

방식으로 하고 기존 `.code-pet`을 삭제/이동하지 않는다.

---

# 13. Project Context — ADD

각 프로젝트는 여러 Chat에 공통으로 전달할 Context를 가진다.

예:

```text
이 프로젝트의 목적
중요한 코드/데이터 계약
절대 바꾸면 안 되는 규칙
업무 배경
```

## Prompt 조립

현재 `buildAgentPrompt()`를 확장한다.

개념적으로:

```text
Project Context
+
기존 CodePet Group Chat Rules
+
현재 Chat history
+
Execution 시 Task Context
+
현재 사용자 요청
```

## Planning에서 하지 말 것

Project Context와 **Role persona를 혼동하지 않는다.**

Planning 단계에서는:

```text
Claude = Claude
Codex = Codex
Antigravity = Antigravity
```

이다.

`Architect`, `Builder`, `Reviewer` 같은 역할 규칙을 자동 주입하지 않는다.

---

# 14. Project 안의 Multi-Chat UI — ADD

CodePet은 이미 왼쪽 sidebar에 Session list를 가진다.

이를 완전히 새로 만들지 말고 계층만 추가한다.

예:

```text
PROJECTS
────────────
Language AIG
CAT Engine
16PF QC

CHATS — Language AIG
────────────
+ New Chat
DB 구조
Parser 개선
Distractor 검증
문항 생성 규칙
```

## 필요한 동작

- Project 생성
- Project 이름 변경
- Project 선택
- Project 삭제/보관
- 해당 Project의 Chat 목록만 표시
- 새 Chat 생성 시 현재 Project에 연결
- Chat 이름 변경
- Chat 삭제 → 기존 trash mechanism 활용
- Project 전환 시 active Chat 복원

---

# 15. Planning Workflow — 기존 기능 재사용

Planning은 Ἀγορά의 기본 대화 상태다.

## 사용자 질문

```text
User:
"이 DB 구조 어떻게 생각해?"
```

멘션이 없으면 기존 CodePet 동작을 그대로 사용한다.

```text
shuffle(enabledAgents)
↓
Agent 1
↓
Agent 2
↓
Agent 3
↓
User
```

뒤 Agent는 앞 답변을 보고 판단한다.

## User가 다시 개입

한 round가 끝나면 자동으로 AI가 결정을 내리게 하지 않는다.

사용자가:

- 추가 질문
- 특정 Agent mention
- 다시 전체에게 질문
- Discussion 시작
- Decision 기록
- Execution 전환

중 하나를 선택한다.

---

# 16. Decision — ADD

Planning 결과에서 사용자가 최종적으로 선택한 내용을 명시적으로 저장할 수 있어야 한다.

## 최소 Data Model

```yaml
Decision:
  id:
  projectId:
  chatId:
  title:
  body:
  createdAt:
  sourceMessageIds: []
```

## UI

Agent 또는 User message 아래:

```text
[Decision으로 기록]
```

또는 Chat 상단:

```text
[결정 기록]
```

## 목적

Execution 단계에서 전체 장문의 토론을 무조건 전달하지 않고:

```text
Project Context
+
Decision
+
Task
+
필요한 source messages
```

를 전달할 수 있도록 한다.

---

# 17. Planning / Execution 상태 — ADD, 그러나 Runtime 재작성 금지

이는 새로운 Agent engine이 아니라 **UI/업무 semantic layer**다.

```text
Planning
  ↓
Decision
  ↓
Execution
```

## Planning

권장 기본 권한:

```text
chat
or
workspace-read
```

## Execution

필요한 경우:

```text
workspace-write
```

로 전환한다.

현재 CodePet permission engine을 사용한다.

---

# 18. Agent ≠ Role

반드시 지켜야 할 개념이다.

## Agent

실행 가능한 provider endpoint:

```text
Claude Code
Codex
Antigravity
OpenCode (future)
```

## Model

Agent가 선택해 실행하는 model.

## Effort

해당 model/provider가 지원하는 추론 강도.

## Role

특정 Execution/Task에서 임시로 Agent에게 부여하는 책임.

예:

```text
Implementation → Codex
Review         → Claude
Research       → Antigravity
```

다음 Task에서는:

```text
Implementation → Claude
Review         → Codex
```

로 바뀔 수 있다.

### 금지

```text
Claude = 항상 Architect
Codex = 항상 Builder
AGY = 항상 Reviewer
```

같은 hard coding.

---

# 19. Execution Role Assignment — ADD

Execution 시작 시 Role mapping을 선택할 수 있다.

최소 UI:

```text
Execution Team

Implementation   [ Codex ▼ ]
Review           [ Claude ▼ ]
Research         [ AGY ▼ ]
```

초기 Role preset은 편의 기능일 뿐이며 사용자 정의 가능하도록 확장 가능한 구조로 만든다.

### v0.1 최소 Role

- Implementation
- Review
- Research

`Architect/Builder/Reviewer` 이름을 고정할 필요는 없다.

---

# 20. Task — ADD

Chat과 독립적으로 연결 가능한 작업 단위.

## 최소 필드

```yaml
Task:
  id:
  projectId:
  title:
  description:
  status: todo | working | review | done | blocked
  assignedRole:
  assignedAgent:
  sourceMessageIds: []
  decisionIds: []
  chatIds: []
  runIds: []
  filesChanged: []
  createdAt:
  updatedAt:
```

## 핵심 원칙

Chat ↔ Task를 강제 부모/자식 구조로 만들지 않는다.

한 Chat에서 여러 Task가 나올 수 있고 한 Task가 여러 Chat에서 논의될 수도 있다.

---

# 21. Handoff — ADD

이 기능은 Ἀγορά의 핵심 추가 기능 중 하나다.

Agent reply 아래 action:

```text
[Task로 만들기]
[다른 Agent에게 전달]
[Review 요청]
```

예:

```text
Claude의 설계 답변
        ↓
[Codex에게 전달]
        ↓
Codex 기존 runner 호출
```

## Handoff Context Package

최소:

```text
Project Context
+
Original User Request
+
Selected Source Message(s)
+
Current Decision
+
Current Task
+
Execution Instruction
```

Workspace 파일 전체를 prompt에 복사하지 않는다.

기존 provider CLI가 workspace를 직접 읽게 한다.

---

# 22. Agent-to-Agent Delegation

CodePet에는 이미 Agent 답변 속 `@agent`가 실제 다음 Agent 호출로 이어지는 기능이 있다.

따라서 **Agent가 다른 Agent를 부르는 기본 메커니즘은 신규 기능이 아니다.**

## 그대로 유지

```text
Claude response:
"@codex 이 설계를 구현해 주세요."
        ↓
CodePet mention relay
        ↓
Codex
```

기본 mention chain limit = 2도 유지한다.

## Ἀγορά에서 추가할 것

자유로운 텍스트 mention과 별개로 **명시적이고 추적 가능한 Handoff 객체/액션**을 추가한다.

### Human-led 기본값

v0.1에서 explicit Handoff는 사용자 승인형을 기본으로 한다.

예:

```text
Claude:
"Codex에게 구현을 맡기는 것이 좋습니다."

[Codex에게 전달]
```

### 자동 delegation

무제한 자동 delegation 시스템은 MVP가 아니다.

기존 mention relay 이상의 장기 autonomous loop를 새로 만들지 않는다.

---

# 23. Review Flow — ADD

Implementation 결과를 다른 Agent에게 검토 요청할 수 있다.

예:

```text
Codex implementation
      ↓
[Claude에게 Review]
      ↓
Claude
PASS / REVISE
```

## Reviewer Context

```text
Original Requirement
Decision
Task
Implementation summary
Changed files
Diff / relevant git status
```

## 권장 Review Output Contract

```text
Verdict: PASS | REVISE

Blocking:
- ...

Non-blocking:
- ...

Evidence:
- ...
```

## 기본 권한

Review Agent는 기본적으로:

```text
workspace-read
```

를 사용한다.

테스트 실행이 필요한 경우 provider 권한 정책에 맞춰 명시적으로 허용한다.

Review Agent가 검수와 동시에 임의 수정하지 않는 것을 기본값으로 한다.

---

# 24. Model / Effort 설정 — 기존 기능 중심

CodePet은 이미 provider별 model/effort capability를 제공한다.

현재 source 기준:

## Claude

- provider ID: `claude`
- 모델 목록: CLI help 기반 탐지
- 기본 fallback aliases 포함
- effort: default / low / medium / high / xhigh / max
- streaming: `stream-json`

## Codex

- provider ID: `codex`
- 모델 catalog: `codex-app-server` / model list
- model-specific effort 지원
- effort fallback: default / minimal / low / medium / high / xhigh
- streaming: JSONL

## Antigravity

- provider ID: `agy`
- alias: `agy`, `antigravity`
- model 목록: `agy models`
- effort: default / low / medium / high

### 중요 — README와 source 차이

현재 README는 AGY를 `stream-json` 방식으로 설명하지만,
현재 `src/providers/provider-capabilities.js` source는:

```text
streaming: "text"
```

로 설정되어 있다.

소스 주석 역시 `--output-format stream-json` flag는 있으나 event schema가 smoke-validated되지 않아 안정성이 확인된 text output을 사용한다고 설명한다.

**Ἀγορά 구현 시 현재 source의 안정 동작을 유지한다.**
AGY stream-json 전환은 별도 smoke test를 통과한 경우에만 한다.

---

# 25. Project Default Model / Effort — ADD

기존 CodePet은 Session마다 모델/effort를 저장한다.

Ἀγορά에서는 Project가 새 Chat의 기본값을 가질 수 있다.

```text
Global/provider capability
        ↓
Project default
        ↓
Chat setting
```

v0.1에서는 Task 단위 model override까지 반드시 만들 필요는 없다.

현재 Chat chip에서 model/effort를 빠르게 바꾸는 UX는 유지한다.

---

# 26. Usage / Quota — Backend KEEP, Chat UI ADD

CodePet에는 이미 provider usage 조회가 존재한다.

- Codex usage
- Claude usage
- Antigravity usage

현재 주요 UI는 settings의 한도 화면이다.

## Ἀγορά 요구

Agent chip/popover 또는 상단에서 현재 quota를 빠르게 볼 수 있게 한다.

예:

```text
Claude
Opus · High
5h  38% used
7d  24% used
```

```text
Codex
GPT-... · High
5h  64% used
week 31% used
```

## 규칙

1. 기존 usage collector를 재사용한다.
2. 채팅 화면 때문에 별도 usage API를 새로 만들지 않는다.
3. provider가 제공하지 않는 값은 `—`로 표시한다.
4. 추정 quota를 실제 값처럼 표시하지 않는다.
5. reset time이 있으면 함께 표시한다.
6. refresh 주기는 기존 cache/rate-limit 정책을 존중한다.

---


# 26.1 Codex Local Proxy Policy — DEFAULT OFF / EXPLICIT OPT-IN

현재 CodePet의 Codex local proxy는 설정값이 없으면 기본 ON으로 간주된다.

현재 source의 의미:

```js
function isCodexProxyModeEnabled() {
  return readSettings().codexProxyMode !== false;
}
```

Ἀγορά에서는 이 정책을 반대로 바꾼다.

## Ἀγορά 요구사항

```text
Codex local account proxy
Default: OFF
Enable: explicit user opt-in only
```

개념적으로:

```js
function isCodexProxyModeEnabled() {
  return readSettings().codexProxyMode === true;
}
```

## 최초 실행 / CodePet migration

CodePet에서 Ἀγορά로 처음 진입할 때 local proxy를 자동 활성화하지 않는다.

특히 기존 `~/.codex/config.toml`에 사용자가 설정한:

```toml
openai_base_url = "..."
```

이 있으면 절대 덮어쓰거나 제거하지 않는다.

OpenCodex, 사내 gateway, 기타 OpenAI-compatible routing layer를 그대로 보존해야 한다.

## Settings UI

```text
Settings
└─ Providers
   └─ Codex
      ├─ Routing
      │  ├─ Native / existing Codex configuration
      │  └─ Ἀγορά local account proxy     [ OFF ]
      │
      └─ Detected base URL
         http://127.0.0.1:10100/v1
         External routing detected
```

Proxy가 OFF면 Ἀγορά는 Codex의 현재 사용자 설정을 그대로 존중한다.

따라서 OpenCodex가 사용 중이라면:

```text
Ἀγορά → Codex CLI → OpenCodex → upstream
```

가 그대로 동작할 수 있어야 한다.

## Proxy ON 요청 시

사용자가 명시적으로 ON 했을 때만:

```text
1. 기존 root openai_base_url 검사
2. 사용자 소유 설정이 있으면 자동 덮어쓰기 금지
3. 충돌 가능성 설명
4. 사용자가 직접 정리한 뒤 다시 시도
```

한다.

UI 예:

```text
External Codex routing이 감지되었습니다.

현재:
http://127.0.0.1:10100/v1

Ἀγορά local account proxy를 켜면 현재 routing과 충돌할 수 있습니다.

[취소]
[설명 보기]
```

## 기능 위치

CodePet local proxy의 목적은:

```text
Codex 재시작 없는 계정 전환
429/401 시 계정 rotation
OAuth header 교체
```

이다.

Ἀγορά에서는 이를 core requirement가 아니라 **optional compatibility/account feature**로 취급한다.

## Acceptance Criteria

- 새 Ἀγορά 설치에서는 Codex proxy가 OFF다.
- proxy를 켜지 않아도 Codex Chat이 정상 작동한다.
- 기존 사용자 `openai_base_url`을 보존한다.
- external base URL이 있어도 Ἀγορά 시작 자체가 실패하지 않는다.
- 사용자가 명시적으로 ON 하기 전에는 Ἀγορά proxy marker를 주입하지 않는다.
- proxy OFF에서는 사용자의 external routing을 방해하지 않는다.

---

# 27. Workspace / Permission — KEEP

현재 permission modes:

```text
chat
workspace-read
workspace-write
```

를 그대로 유지한다.

### Claude

도구 정책 / `acceptEdits`

### Codex

sandbox / read-only / workspace-write

### AGY

plan / sandbox / accept-edits

현재 `chat-argv.js` 검증 로직을 우회하지 않는다.

### Auto Approve

기존 위험한 full-auto flag는 기존 확인 UI와 안전장치를 유지한다.

---


# 27.1 Headless Permission Approval Semantics — IMPORTANT

현재 CodePet의 권한 승인 UX를 구현 에이전트가 잘못 해석하지 않도록 다음 동작을 명시한다.

## 현재 CodePet의 실제 의미

Claude / Codex / AGY를 CodePet에서 실행할 때는 GUI 터미널에서 사용자가 CLI의 개별 승인 프롬프트에 직접 응답하는 방식이 아니라 **headless / non-interactive 실행**을 사용한다.

따라서 실행 도중 provider가 추가 권한을 요구했다고 해서:

```text
현재 프로세스 일시정지
↓
특정 명령 1개만 승인
↓
같은 프로세스에서 그대로 계속
```

하는 구조가 아니다.

현재 CodePet의 기본 처리 개념은 다음과 같다.

```text
Agent turn 실행
↓
추가 권한 필요 감지
↓
현재 실행 종료/실패
↓
CodePet 자체 승인 UI 표시
↓
사용자 승인
↓
같은 turn/prompt를 처음부터 다시 실행
↓
재실행 turn 전체에 auto-approve 적용
```

즉 **승인 범위는 개별 command가 아니라 retry되는 현재 turn 전체**다.

현재 UI 문구:

```text
CLI headless 실행에서는 개별 명령만 승인할 수 없어,
승인하면 이 턴 전체를 자동 승인 모드로 다시 실행합니다.
```

는 이 제약을 설명하는 안내다.

## Ἀγορά에서 유지할 것

v0.1에서는 provider별 interactive approval protocol을 새로 만들지 않는다.

현재 CodePet의 turn-level approval retry 동작을 유지한다.

다만 UI에서는 다음을 반드시 명확하게 표시한다.

```text
추가 권한이 필요합니다.

현재 CLI 실행 방식에서는 요청된 명령 하나만 승인하여
기존 프로세스를 이어갈 수 없습니다.

승인하면 현재 작업을 auto-approve 상태로
처음부터 다시 실행합니다.
```

## Write 작업에서의 위험

재실행 전에 이전 turn이 이미 workspace를 수정했을 수 있다.

예:

```text
1. parser.ts 수정
2. schema.ts 수정
3. npm test 실행 시 추가 권한 필요
4. 사용자 승인
5. 같은 작업을 처음부터 재실행
```

따라서 `workspace-write` 상태에서 승인 retry를 수행할 때는 가능한 한:

```text
현재 변경 파일 확인
git status 확인
partial output 보존
```

을 먼저 수행해야 한다.

UI 권장:

```text
Codex가 추가 권한을 요청했습니다.

승인하면 이 작업을 auto-approve 모드로 다시 실행합니다.

현재 감지된 변경:
M src/parser.ts
M src/schema.ts

[변경사항 확인]
[승인하고 다시 실행]
[거부]
```

## 향후 개선 가능성

향후 특정 provider가 다음 중 하나를 안정적으로 제공한다면:

```text
interactive permission protocol
app-server RPC
ACP
provider-specific command approval API
resume-capable execution protocol
```

개별 tool/command 단위 승인을 별도 adapter capability로 구현할 수 있다.

그러나 지원 여부를 가정하거나 공통 기능으로 하드코딩하지 않는다.

개념적으로:

```yaml
ProviderCapabilities:
  commandLevelApproval: true | false
  resumableRun: true | false
```

같은 capability 확장으로 처리한다.

### v0.1 기준

```text
command-level approval = 지원한다고 가정하지 않음
turn-level auto-approve retry = 현재 CodePet 방식 유지
write-safe retry = Ἀγορά에서 개선
```

---

# 28. Runtime Timeout / Error UX — IMPROVE

사용자가 실제 CodePet 사용 중 반복해서 경험한 오류 예:

```text
⚠ timeout waiting for response
```

## 먼저 이해해야 하는 기존 구현

`src/chat/chat-agent-runner.js`의 기본 실행 timeout은 **없다.**

현재:

```text
DEFAULT_TIMEOUT_MS = null
```

이고 명시적인 양수 `timeoutMs`가 들어왔을 때만 process를 kill한다.

따라서 provider가 출력하는:

```text
timeout waiting for response
```

같은 메시지를 CodePet 자체 hard timeout으로 오해하지 않는다.

---

# 29. 기존 Streaming 구현 — KEEP

`chat-events.js`는 provider별 output을 공통 event로 정규화한다.

개념적으로:

```text
delta
status
final
error
```

Renderer `chat.js` 역시 `liveRuns`를 이용해:

```text
run-start
status
delta
run-end
```

를 실시간으로 표시한다.

**이 스트리밍 시스템을 새로 만들지 않는다.**

---

# 30. 실패 시 Partial Output 보존 — REQUIRED IMPROVEMENT

현재 `chat.js`의 `handleRunEvent()`는 failed `run-end`에서 live draft를 즉시 제거한다.

현재 동작:

```text
if run-end && !ok
→ live item remove
→ liveRuns delete
```

이 때문에 사용자 입장에서는:

```text
어디까지 진행됐는지
부분 응답이 있었는지
어떤 상태에서 끊겼는지
```

를 잃기 쉽다.

## Ἀγορά 변경

실패 시 live output을 삭제하지 않는다.

예:

```text
Codex · Interrupted

Last status:
Running tests

Partial output:
...

Error:
timeout waiting for response

[Retry]
[Raw output]
[Stop]
```

---

# 31. Runtime 상태 개선

최소한 UI에서 다음을 구분한다.

```text
RUNNING
QUIET
WAITING_PERMISSION
FAILED
INTERRUPTED
COMPLETED
CANCELLED
```

`QUIET`는 오류가 아니다.

예:

```text
No output for 3m 20s
Process has not been terminated.
```

## Soft timeout

출력이 오래 없다는 UI 경고만 표시한다.

프로세스를 죽이지 않는다.

## Hard timeout

기존처럼 명시적으로 설정된 경우만 사용한다.

기본 OFF를 유지한다.

---

# 32. Raw / Diagnostic Output

실패한 Run에서 최소한 다음 진단 정보에 접근할 수 있어야 한다.

```text
provider
model
effort
runId
start time
last activity
exit code
normalized error
partial delta
stderr tail
stdout/raw tail where safe
```

기존 runner의 output size 제한을 존중한다.

민감 정보/credential을 diagnostics에 새로 기록하지 않는다.

---

# 33. Write-safe Retry

Workspace Write run은 무조건 자동 retry하지 않는다.

잘못된 예:

```text
Codex edits files
↓
provider timeout
↓
blind retry
↓
같은 파일을 다시 수정
```

## Retry 전

가능하면:

```text
git status
changed files
```

를 먼저 확인한다.

UI:

```text
Run interrupted.

Detected changes:
M src/parser.js
M src/schema.js

[Inspect changes]
[Retry with current state]
[Cancel]
```

Git repository가 아닐 경우에도 최소한 Run 이전/이후 known changed files를 수집할 수 있는 확장 지점을 둔다.

---

# 34. OpenCode Provider — FUTURE / v0.2

현재 CodePet source의 provider definition은:

```text
Claude
Codex
Antigravity
```

이다.

OpenCode는 신규 provider adapter가 필요하다.

## 구현 원칙

기존 provider abstraction에 추가한다.

예:

```text
provider-capabilities
provider-diagnostics
chat-argv
chat-events
usage(optional)
```

에 provider-specific branch를 추가한다.

## 금지

OpenCode 지원 때문에 기존 Claude/Codex/AGY adapter를 공통 lowest-common-denominator로 망가뜨리지 않는다.

## 구현 시

설치된 OpenCode CLI의 **현재 실제 help/model/provider interface를 다시 probe**한 뒤 구현한다.

과거 문서나 하드코딩된 model list에 의존하지 않는다.

---


# 34.1 Single Main Window Architecture — REQUIRED

현재 CodePet은 사용자 경험상 Settings window와 Chat window가 분리되어 보인다.

Ἀγορά에서는 이를 **하나의 Main Window로 통합**한다.

## 원칙

```text
Ἀγορά Main Window
│
├─ Workspace / Project / Chat
├─ Conversation
├─ Execution / Work Drawer
└─ Settings View
   ├─ 일반 및 모양
   ├─ Provider / 계정
   ├─ 사용량
   └─ CLI 진단
```

Project, Chat, Settings, Task, Review는 서로 다른 애플리케이션 창이 아니라
**동일한 Main Window 내부의 View / Panel / Drawer**로 표현한다.

### 예외

다음과 같은 OS-native 또는 안전성 중심 UI는 별도 modal/dialog를 사용할 수 있다.

```text
폴더 선택
파일 선택
위험한 권한 승인
파괴적 작업 확인
```

## Settings

Settings를 열 때 새로운 BrowserWindow를 생성하지 않는다.

왼쪽 navigation에서:

```text
⚙ Settings
```

를 선택하면 같은 Main Window의 content area가 Settings view로 전환된다.

```text
Workspace
   ↓
Settings
   ↓
← Workspace
```

기존 Chat/Project 상태는 유지되며 Workspace로 돌아오면 직전 위치를 복원한다.

## Agent 작업 설정 vs Provider 설정

둘을 구분한다.

### Agent chip / Project / Chat 영역

현재 작업에서의 설정:

```text
enabled
model
effort
permission
auto approve
usage quick view
```

### Settings → Provider / 계정

이 PC에서 provider 자체의 연결 상태:

```text
CLI installed
CLI version
login/auth state
account switching
re-detect CLI
provider diagnostics
```

즉:

```text
Agent Chip
→ 이 작업에서 Agent를 어떻게 사용할지

Settings
→ 이 PC에서 Provider가 어떻게 연결되어 있는지
```

## Pet window

Pet UI를 primary window로 유지하지 않는다.

v0.1은 Chat/Workspace 중심의 단일 Main Window를 앱의 기본 진입점으로 한다.

기존 pet-only 기능이 runtime/provider 기능과 결합되어 있다면 즉시 삭제하기보다
숨김/격리 후 단계적으로 제거한다.


# 35. UI 방향

## 기본 스타일

Pet/chat toy 느낌이 아니라 업무 도구.

참고 방향:

```text
Linear
Slack
VS Code
```

그러나 외형만 참고하고 framework를 바꾸지 않는다.

## 메인 IA 권장

```text
┌───────────────┬────────────────────────────┬──────────────────┐
│ PROJECT/CHATS │ CONVERSATION               │ WORK             │
│               │                            │                  │
│ Project A     │ Agent chips                │ Task             │
│  ├ Chat 1     │                            │ Decision         │
│  ├ Chat 2     │ User / Agents conversation │ Review           │
│  └ Chat 3     │                            │                  │
└───────────────┴────────────────────────────┴──────────────────┘
```

### v0.1

오른쪽 Work pane은 항상 고정일 필요는 없다.

기존 CodePet chat width를 보존하기 위해:

```text
collapsible drawer
```

로 구현해도 된다.

---

# 36. Agent Chip 요구사항

현재 chip의 장점은 유지한다.

```text
Provider icon
@agent
enabled
model
effort
auto approve
CLI status
version
```

여기에 Usage를 추가한다.

예:

```text
[Claude icon] @claude
────────────────
Status    Ready
Model     Opus
Effort    High
Usage     38% / 5h
Reset     11:24
```

아이콘만 provider brand icon으로 바꾼다.

---

# 37. Message Actions — ADD

Agent message hover 또는 하단:

```text
[Task]
[Handoff]
[Review]
[Decision]
```

필요하면 secondary menu에:

```text
[Copy]
[Raw run]
[Related task]
```

를 둘 수 있다.

기존 message renderer / markdown renderer는 유지한다.

---

# 38. Context Builder — ADD

Handoff/Execution을 위해 얇은 Context Builder를 추가한다.

### Planning 일반 응답

기존 `buildAgentPrompt()` 동작을 최대한 보존한다.

### Execution/Handoff

추가 context:

```text
Project Context
Decision
Task
Selected Source Messages
```

## 금지

모든 Project의 모든 Chat transcript를 매번 통째로 prompt에 넣지 않는다.

현재 CodePet의 message truncation 정책을 존중한다.

---

# 39. 추천 신규 모듈

기존 `chat-store.js` / `chat-ipc.js`가 지나치게 커지는 것을 막기 위해 신규 기능은 분리하는 것을 권장한다.

예:

```text
src/agora/
├─ project-store.js
├─ task-store.js
├─ decision-store.js
├─ context-builder.js
├─ handoff.js
└─ execution-roles.js
```

단, 불필요한 추상화 계층을 만들 필요는 없다.

### 기존 코드가 계속 담당할 것

```text
chat-room.js
→ turn orchestration

chat-agent-runner.js
→ process execution

chat-events.js
→ provider output normalization

chat-argv.js
→ safe invocation

provider-capabilities.js
→ CLI/model/effort capabilities

chat-store.js
→ existing chat/session persistence
```

---

# 40. IPC 변경 예상

현재 `chat-ipc.js`는 session lifecycle, send, stop, interject, discussion, approval, workspace 등의 IPC를 조립한다.

추가 IPC 예:

```text
agora:projects:list
agora:projects:create
agora:projects:update
agora:projects:delete
agora:projects:select

agora:decisions:create
agora:decisions:list

agora:tasks:create
agora:tasks:update
agora:tasks:list

agora:handoff:prepare
agora:handoff:run

agora:usage:summary
```

`chat-preload.js`에도 필요한 최소 API만 expose한다.

Renderer가 직접 filesystem이나 child_process에 접근하지 않는다.

---

# 41. Existing Session API 변경 전략

현재 IPC:

```text
chat:sessions:create
chat:sessions:select
chat:sessions:rename
chat:sessions:delete
```

를 제거하지 않는다.

새 Project filter/association을 추가하거나 wrapper를 둔다.

예:

```text
createSession({ projectId })
```

내부적으로는 기존 session 생성 기능을 그대로 사용한다.

---

# 42. Usage와 실행 Run의 구분

두 개념을 혼동하지 않는다.

## Provider Quota

```text
Claude 5h quota
Codex weekly quota
AGY quota
```

기존 provider usage backend.

## Agora Run Analytics

```text
이 Project에서 Codex 몇 회 실행했는가
어떤 Task에서 어떤 Agent가 일했는가
```

이것은 별도 기능이다.

### v0.1

Provider quota 표시만 필수.

상세 Run analytics는 후순위.

---

# 43. 기존 Account Switching — KEEP

CodePet은 Codex / Claude / AGY 계정 관리 기능을 이미 가지고 있다.

Ἀγορά에서 제거하지 않는다.

다만 Pet 우클릭 메뉴에만 있던 접근점은:

```text
Settings → Providers / Accounts
```

같은 업무형 UI로 옮긴다.

---

# 44. 기존 Watcher 기능

CodePet은 외부에서 실행되는 Claude/Codex/AGY 작업 로그도 감시한다.

이 기능은 Ἀγορά의 Chat runtime과 직접 같은 것은 아니다.

### v0.1 권장

- 즉시 삭제하지 않는다.
- Ἀγορά main workspace에서는 숨길 수 있다.
- 추후 "External Activity" 기능으로 재사용 가능하다.

Pet 제거를 이유로 watcher implementation까지 초기에 삭제하지 않는다.

---

# 45. Ἀγορά v0.1 Scope

## 반드시 구현

### Rebrand / Cleanup

- [ ] CodePet → Ἀγορά
- [ ] main workspace를 primary UI로
- [ ] Pet UI 비중 제거/숨김
- [ ] 캐릭터 emoticon prompt 제거
- [ ] 캐릭터 emoticon renderer 제거/legacy fallback
- [ ] Agent 캐릭터 avatar → provider brand icon

### Project

- [ ] Project entity
- [ ] Project selector
- [ ] Project → existing Chat/Session association
- [ ] 한 Project 내 여러 Chat
- [ ] Project workspace
- [ ] Project Context
- [ ] Project default agent/model/effort

### Planning

- [ ] 기존 randomized sequential broadcast 유지
- [ ] 기존 @mention 유지
- [ ] 기존 Discussion 유지
- [ ] 기존 interject/cancel 유지
- [ ] Planning에 Role prompt 미적용
- [ ] Decision 기록

### Execution

- [ ] Execution mode/semantic
- [ ] Role mapping
- [ ] Task
- [ ] Handoff
- [ ] Review

### Provider UX

- [ ] 기존 model selector 유지
- [ ] model-specific effort capability 적용
- [ ] AGY의 Gemini / Claude / GPT-OSS 계열별 option compatibility 처리
- [ ] unsupported/embedded effort에서는 `--effort` 미전달
- [ ] existing Usage를 agent UI에 노출
- [ ] 기존 permission 유지
- [ ] Codex local proxy 기본 OFF
- [ ] Codex local proxy explicit opt-in
- [ ] 기존 external `openai_base_url` 보존

### Runtime

- [ ] 실패 시 partial response 보존
- [ ] provider timeout/error를 명확히 표시
- [ ] soft quiet warning
- [ ] diagnostics/raw output 접근
- [ ] write-safe retry

### Quality

- [ ] migration
- [ ] baseline test 유지
- [ ] 신규 test
- [ ] Windows packaging smoke test

---

# 46. v0.2 이후

- [ ] OpenCode provider
- [ ] Worktree isolation
- [ ] Git Diff viewer
- [ ] task별 agent/model override
- [ ] richer Run analytics
- [ ] Project별 agent performance stats
- [ ] Slack/Discord client
- [ ] optional automatic delegation policy
- [ ] discussion order configuration
- [ ] advanced context compaction

---

# 47. 명시적 Non-goals

다음은 v0.1에서 구현하지 않는다.

- AI CEO / 조직도
- Paperclip식 완전 자율 조직 운영
- 장시간 무제한 autonomous delegation
- 복잡한 DAG workflow
- 비용 budget governance
- cloud backend
- cloud sync
- multi-user collaboration
- 모바일 앱
- 자체 LLM hosting
- 새로운 RAG 시스템
- 전면 React rewrite
- Tauri rewrite
- provider runtime 전면 재작성
- complex Kanban
- GitHub PR automation
- 자동 model benchmark / routing optimizer

---

# 48. Test 전략

현재 CodePet은 Node built-in test runner를 사용한다.

기존 테스트 예:

```text
chat-agent-runner.test.js
chat-agents.test.js
chat-argv.test.js
chat-attachments.test.js
chat-emoticons.test.js
chat-events.test.js
chat-markdown.test.js
chat-mention.test.js
chat-prompt.test.js
chat-room.test.js
chat-store.test.js
provider capability / diagnostics / usage tests
settings UI tests
packaging tests
```

## 변경 시

### Emoticon

기존 emoticon test는 삭제만 하지 말고:

- 새 prompt에 emoticon rule이 들어가지 않는지
- legacy transcript가 crash하지 않는지

로 대체한다.

### Project

추가:

```text
project-store.test.js
project-session-migration.test.js
project-context.test.js
```

### Task / Handoff

추가:

```text
task-store.test.js
handoff-context.test.js
execution-role.test.js
review-flow.test.js
```

### Runtime

추가:

```text
failed run preserves partial output
quiet does not kill process
write retry requires state inspection
provider timeout classification
```

---

# 49. Acceptance Criteria

## A. Existing core regression

다음이 모두 계속 동작해야 한다.

```text
@claude 호출
@codex 호출
@agy 호출
멘션 없는 전체 응답
랜덤 순서
순차 응답
앞 답변 참고
Agent→Agent @mention
Discussion
Interject
Cancel
Model 선택
Effort 선택
Workspace permission
Auto approve
Attachment
Streaming
Session restore
Usage
```

## B. Branding / Window Architecture

- 앱의 기본 사용자 경험은 하나의 Ἀγορά Main Window 안에서 이루어진다.
- Settings와 Chat을 별도 top-level application window로 분리하지 않는다.
- Workspace ↔ Settings 전환 후 Project/Chat 상태가 보존된다.
- CodePet 캐릭터 이모티콘이 새 Agent prompt에 포함되지 않는다.
- 새 Agent 답변에 emoticon 사용 강제가 없다.
- Agent chip/message avatar가 provider brand icon이다.
- 제품 main UI가 Ἀγορά로 표시된다.

## C. Project

- Project를 2개 이상 만들 수 있다.
- 각 Project마다 여러 Chat을 만들 수 있다.
- 다른 Project Chat이 섞여 표시되지 않는다.
- Project 전환 후 마지막 active Chat을 복구한다.
- Project Context가 해당 Project Agent prompt에만 포함된다.

## D. Planning

- 일반 질문은 기존 방식으로 enabled Agents가 random sequential response한다.
- Planning에는 Execution Role prompt가 주입되지 않는다.
- User가 언제든 다시 질문하거나 Discussion을 시작할 수 있다.
- Decision을 기록할 수 있다.

## E. Execution

- Task 생성 가능
- Role에 Agent 배정 가능
- Agent/Role mapping 변경 가능
- Handoff 가능
- Review 요청 가능
- Role이 Agent identity에 hard-coded되지 않는다.

## F. Runtime

- failed run의 partial output이 사라지지 않는다.
- provider error text를 볼 수 있다.
- 아무 output이 없는 상태만으로 process를 kill하지 않는다.
- headless permission 승인 시 **개별 command 승인처럼 오해시키지 않는다.**
- 승인 retry가 현재 turn 전체를 auto-approve로 재실행한다는 점을 UI에 명시한다.
- workspace-write turn의 permission retry 전에 가능한 한 기존 변경 상태를 확인할 수 있다.
- write run retry 전에 변경 상태를 확인할 수 있다.

---

# 50. 구현 Phase 권장 순서

## Phase 0 — Baseline

```text
fork
npm install
npm test
현재 기능 smoke test
```

산출물:

```text
BASELINE_AUDIT.md
```

---

## Phase 1 — Rebrand / Visual Cleanup

- CodePet → Ἀγορά
- Chat primary
- Pet optional/hidden
- emoticon prompt 제거
- emoticon renderer legacy-only
- provider brand icons

이 Phase에서는 Project/Task를 만들지 않는다.

먼저 기존 채팅 core가 그대로 동작하는지 확인한다.

---

## Phase 2 — Project Layer

- Project store
- Project selector
- Session projectId
- migration
- Project workspace/context/default agent settings
- sidebar hierarchy

기존 Session core를 재사용한다.

---

## Phase 3 — Planning / Decision

- 현재 randomized broadcast UX 정리
- 기존 Discussion 재사용
- Decision action
- Project Context injection
- Planning/Execution 상태 표시

---

## Phase 4 — Execution Layer

- Role mapping
- Task
- Handoff
- Review

기존 `ChatRoom`/runner 위에 얹는다.

---

## Phase 5 — Usage + Runtime UX

- usage in agent chip
- partial failure preservation
- quiet warning
- diagnostic panel
- write-safe retry

---

## Phase 6 — Packaging / Migration Verification

- Windows portable build
- clean install
- old CodePet data import
- upgrade test
- corrupted transcript tolerance
- missing provider test

---

# 51. 구현 예상 영향 파일

## 반드시 검토

```text
package.json
src/main.js

src/chat.js
src/chat.html
src/chat-preload.js

src/chat/chat-room.js
src/chat/chat-prompt.js
src/chat/chat-store.js
src/chat/chat-ipc.js
src/chat/chat-agent-runner.js
src/chat/chat-events.js
src/chat/chat-argv.js
src/chat/chat-emoticons.js

src/providers/provider-capabilities.js
src/providers/provider-diagnostics.js

src/provider-usage.js
src/codex-usage-label.js

src/settings.js
src/settings.html
```

## Agent icon 관련

현재:

```text
src/chat-assets/claude.png
src/chat-assets/gpt.png
src/chat-assets/gemini.png
```

및 `src/chat.js`의 `AGENT_VISUALS`.

## Emoticon 관련

```text
src/chat/chat-emoticons.js
src/chat-icon/emoticons/
src/chat.js
src/chat/chat-prompt.js
src/chat/chat-room.js
test/chat-emoticons.test.js
```

---

# 52. Source-level Implementation Notes

## `src/chat/chat-room.js`

### KEEP

- `sendUserMessage`
- `shuffle`
- `scheduleResponse`
- `pumpTurnQueue`
- `interject`
- `cancelTurn`
- `startDiscussion`
- mention relay
- approval retry
- generation guard

### CHANGE

- `extractEmoticons` dependency 제거 또는 legacy path로 축소
- Project Context를 prompt builder에 전달할 수 있는 meta/context 확장
- Handoff/Task 실행에 필요한 trace/run metadata 연결

### DO NOT

turn queue를 새 orchestrator framework로 교체하지 않는다.

---

## `src/chat/chat-prompt.js`

### KEEP

- group roster
- history formatting
- permission rules
- broadcast position에 따른 이전 답변 보완 규칙
- discussion signal rules

### REMOVE

```text
emoticonPromptRules()
```

### ADD

```text
projectContext
taskContext(optional)
decisionContext(optional)
```

Planning에서 role prompt는 주입하지 않는다.

---

## `src/chat/chat-store.js`

### KEEP

- atomic JSON write
- append-only transcript
- corrupt line tolerance
- trash
- newer schema read-only behavior

### ADD

- Project association
- migration
- Task/Decision을 별도 store로 분리하거나 안전한 확장

기존 transcript 형식을 불필요하게 바꾸지 않는다.

---

## `src/chat/chat-ipc.js`

현재 이 파일은:

```text
ChatStore
Capability Service
ChatRoom
Runner
IPC
Window
Attachments
```

를 조립한다.

### ADD

Project/task/decision/handoff service wiring.

단, 파일이 더 비대해지면 `src/agora/` service로 분리한다.

---

## `src/chat/chat-agent-runner.js`

### KEEP

- default no hard timeout
- output cap
- process tree kill
- parser
- final output selection

### IMPROVE

- run diagnostics
- partial failure metadata
- stderr tail forwarding
- last activity timestamp

---

## `src/chat/chat-events.js`

### KEEP

현재 normalized event contract.

가능하면 새로운 provider도 이 contract로 맞춘다.

### ADD 가능

필요 시:

```text
diagnostic
heartbeat
```

같은 event를 추가할 수 있으나 기존 consumer를 깨지 않는다.

---

## `src/chat.js`

### KEEP

- session UI logic 기반
- model/effort popover
- agent enable
- auto approve
- liveRuns
- markdown rendering
- turn state
- approval UI

### CHANGE

- Project + Chat sidebar
- brand icons
- emoticon rendering 제거
- work drawer
- message actions
- usage
- failed live run preservation
- run diagnostic UI

---

## `src/providers/provider-capabilities.js`

### KEEP

현재 provider capability abstraction.

특히:

```text
modelOptions
efforts
streaming
permissions
authStatus
```

를 새로 정의하지 않는다.

OpenCode를 추가할 때도 동일 contract를 따른다.

---

# 53. 보안/안전 원칙

1. credential을 Ἀγορά DB에 복제하지 않는다.
2. 기존 CLI credential store를 계속 사용한다.
3. renderer에 commandPath/secret을 보내지 않는다.
4. workspace path selection의 기존 OS dialog 안전성을 유지한다.
5. auto approve는 workspace-write에서만 사용한다.
6. dangerous CLI flags의 기존 경고를 우회하지 않는다.
7. failed/raw log에 OAuth token/API key를 표시하지 않는다.
8. Handoff 시 workspace 파일 전체 내용을 메시지에 복사하지 않는다.
9. provider CLI가 workspace를 로컬에서 직접 읽게 한다.
10. migration 전 backup/rollback 가능성을 보장한다.

---

# 54. Ἀγορά의 최종 개념 모델

```text
Project
│
├─ Context
├─ Workspace
├─ Default Agent Config
│
├─ Chat
│  ├─ Messages
│  ├─ Runs
│  ├─ Discussion
│  └─ Decisions
│
├─ Task
│  ├─ Assigned Role
│  ├─ Assigned Agent
│  ├─ Related Chats
│  ├─ Related Decisions
│  └─ Runs
│
└─ Execution Roles
   ├─ Implementation
   ├─ Review
   └─ Research
```

Agent runtime:

```text
Provider
   ↓
Agent
   ↓
Model
   ↓
Effort
```

업무 assignment:

```text
Task
   ↓
Role
   ↓
Agent
```

**Provider/Agent/Model/Role을 같은 개념으로 합치지 않는다.**

---

# 55. UX 핵심 요약

## Planning

```text
User asks
   ↓
CodePet existing random sequential response
   ↓
User
   ├─ asks again
   ├─ mentions one Agent
   ├─ starts Discussion
   ├─ records Decision
   └─ moves to Execution
```

## Execution

```text
Decision
   ↓
Task
   ↓
Assign Role → Agent
   ↓
Handoff
   ↓
Implementation
   ↓
Review
   ↓
User decides
```

---

# 56. 이 프로젝트에서 특히 하지 말아야 할 오해

### 오해 1

> "멀티에이전트 순차 토론 엔진을 새로 만들자."

**아니다. 이미 있다.**

### 오해 2

> "Claude는 Architect, Codex는 Builder로 고정하자."

**아니다. Agent ≠ Role.**

### 오해 3

> "Planning부터 Role prompt를 넣자."

**아니다. Planning에서는 각 모델이 자기 판단으로 참여한다.**

### 오해 4

> "`timeout waiting for response`가 보이니 CodePet hard timeout을 늘리자."

**아니다. 현재 runner 기본 hard timeout은 null이다. 먼저 provider error/connection/output 상태를 분류한다.**

### 오해 5

> "UI를 현대화하려면 React로 다시 만들자."

**아니다. 기능 검증 전 framework rewrite 금지.**

### 오해 6

> "Project를 만들려면 Session 저장 구조를 전부 갈아엎자."

**아니다. Session을 Chat으로 재사용하고 Project parent만 추가한다.**

### 오해 7

> "Handoff를 만들려면 새로운 Agent protocol이 필요하다."

**아니다. 기존 runner에 구조화된 context package를 전달하면 된다.**

---

# 57. Source Audit Map

구현 에이전트는 작업 전에 최소한 아래 파일을 직접 읽는다.

| Source | 확인 목적 |
|---|---|
| `README.md` | 현재 사용자 기능/실행 방식 |
| `package.json` | Electron/build/product metadata |
| `LICENSE` | MIT 재사용 조건 |
| `src/chat/chat-room.js` | 순차 큐, shuffle, mention relay, discussion, interject |
| `src/chat/chat-prompt.js` | broadcast/discussion prompt, emoticon injection |
| `src/chat/chat-emoticons.js` | 제거 대상 캐릭터 이모티콘 protocol |
| `src/chat/chat-store.js` | Session persistence/migration |
| `src/chat/chat-ipc.js` | Electron main-side chat orchestration/IPC |
| `src/chat/chat-agent-runner.js` | subprocess, timeout, stdout/stderr, cancel |
| `src/chat/chat-events.js` | streaming event normalization |
| `src/chat/chat-argv.js` | provider permission/argv safety |
| `src/providers/provider-capabilities.js` | model/effort/provider capability |
| `src/providers/provider-diagnostics.js` | CLI/auth diagnostics |
| `src/provider-usage.js` | Claude/AGY quota |
| `src/codex-usage-label.js` | Codex usage labels/windows |
| `src/chat.js` | current UI, agent avatar, live run renderer |
| `src/chat.html` | chat layout |
| `src/chat-preload.js` | renderer IPC surface |
| `test/` | regression contract |

---

# 58. 최종 구현 지시 요약

## KEEP

```text
CodePet chat core
CLI adapters
models
effort
usage backend
permissions
sequential randomized response
discussion
mentions
interjection
streaming
session persistence
attachments
diagnostics
```

## REMOVE / REPLACE

```text
CodePet branding
Pet-first UX
character emoticon prompt
character emoticon rendering
anime/character agent avatars
```

## ADD

```text
Ἀγορά branding
provider brand icons
Project
Project Context
Project → multiple Chats
Decision
Planning/Execution semantics
Execution Role assignment
Task
Handoff
Review
Usage in chat UI
better runtime failure/partial-output UX
```

## LATER

```text
OpenCode
worktrees
advanced diff
Slack
autonomous delegation
cloud sync
complex task graph
```

---

# 59. Definition of Done for first usable Ἀγορά build

첫 실사용 build는 다음 시나리오가 끝까지 동작해야 한다.

```text
1. Ἀγορά 실행
2. Project 생성
3. Workspace 선택
4. Claude/Codex/AGY 상태 확인
5. 각 Agent model/effort 선택
6. Chat A 생성
7. 멘션 없이 질문
8. 세 Agent가 기존 CodePet 방식대로 랜덤 순차 응답
9. 사용자 추가 질문
10. 필요 시 Discussion
11. 사용자 Decision 기록
12. Task 생성
13. Implementation 역할에 Codex 배정
14. Codex에 Handoff
15. workspace-write로 작업
16. 변경/결과 확인
17. Claude에게 Review 요청
18. PASS 또는 REVISE
19. REVISE면 다시 Implementation으로 전달
20. 완료
21. 앱 재실행
22. Project / Chat / Decision / Task 복구
```

그리고 동시에 다음 기존 기능이 여전히 정상이어야 한다.

```text
@claude
@codex
@agy
@all
model selection
effort selection
usage
permission
auto approve
attachments
streaming
cancel
interject
discussion
```

이 조건이 충족되면 v0.1을 "usable"로 본다.

---

# 60. 한 문장 구현 원칙

> **Ἀγορά는 CodePet의 멀티에이전트 엔진을 다시 만드는 프로젝트가 아니라, 이미 잘 동작하는 CodePet Chat Core에서 캐릭터/Pet 계층을 걷어내고 Project·Decision·Execution·Handoff·Review라는 인간 중심의 작업 계층을 얹는 프로젝트다.**
