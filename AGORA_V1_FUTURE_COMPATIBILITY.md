# Ἀγορά v1 — 미래 확장 호환성 기준

이 문서는 Agora v1을 구현하거나 검토할 때 지켜야 할 **구조적 경계**를 기록한다.

v2·v3의 방향은 확정된 참고사항이지만, 이 문서는 해당 기능을 지금 구현하라는 명세가 아니다. v1은 사람이 주도하는 멀티에이전트 작업공간으로 남긴다.

## 1. 이번 v1에서 만들지 않는 것

다음은 미래 후보이며 v1 범위가 아니다.

| 미래 방향 | v1에서 만들지 않는 구성 요소 |
|---|---|
| v2 — Playbook / Autoresearch | Workflow Engine, DAG framework, Playbook parser, Evaluator, 반복 실행 loop, Git checkpoint/restore 자동화, experiment history UI |
| v3 — Knowledge / Recorder | RAG, Vector DB, Obsidian plugin, Recorder Agent, Knowledge Graph, cloud sync backend |

향후 반복 흐름은 `Playbook → Task → Execution → Evaluation → KEEP/REVERT → Experiment Log`가 될 수 있다. 향후 지식 흐름은 `Discussion → User Decision → Recorder → Markdown/Obsidian → local retrieval`가 될 수 있다. 그러나 지금은 이 흐름을 위한 framework·parser·자동화·저장소를 미리 만들지 않는다.

## 2. v1에서 보존할 구조적 경계

1. **Decision**은 나중에 안정적인 ID를 가질 수 있어야 한다.
2. **Task**는 안정적인 ID와 `projectId` 연결을 유지할 수 있어야 한다.
3. **Execution/Run**은 필요해질 때 안정적인 ID를 부여하고 Task·Decision과 연결할 수 있어야 한다.
4. **Review** 결과는 화면 문구만이 아니라 구조적으로 저장할 수 있는 경계를 유지한다.
5. 주요 객체는 필요할 때 아래 관계를 ID로 참조할 수 있어야 한다.

```text
Decision → Task → Execution → Review
```

6. Project Context와 Chat Transcript를 같은 개념으로 합치지 않는다.
7. Agent(실행 주체)와 Role(기획·구현·검토 같은 작업 역할)을 분리한다.
8. UI 버튼·renderer 상태와 Agent 실행 runtime을 과도하게 결합하지 않는다.

위 기준은 지금 별도 workflow framework나 객체 그래프를 만들라는 뜻이 아니다. 실제 기능을 추가할 때 최소한의 데이터와 모듈 경계를 선택하기 위한 기준이다.

## 3. 실행 결과와 출처

v1은 모든 결과를 하나의 큰 text blob으로만 남기지 않는다. 화면 표시용 text와 향후 구조화할 수 있는 실행 정보를 구분할 수 있게 한다.

필요해질 때 보존·연결 가능한 정보의 예:

- run ID, Task ID, Decision ID, Project ID
- Agent, Provider, Model
- 시작·종료 시각과 상태
- 변경된 파일, 생성된 artifact, Review 결과

v1에서 위 필드를 모두 강제 저장하지는 않는다. 다만 향후 아래 질문에 답할 수 있는 출처(provenance)를 잃지 않는 방향을 선택한다.

- 이 결과를 어느 Agent가 만들었는가?
- 어떤 Provider와 Model로 실행했는가?
- 어떤 Task와 Decision에서 시작되었는가?

Artifact는 수정 파일, 생성 문서, benchmark/evaluator 결과, 보고서, 실험 출력, knowledge note 등을 나중에 가리킬 수 있는 개념이다. v1에서 별도 Artifact framework를 만들지 않는다.

## 4. 실행 환경과 사용자 통제

- Codex·Claude·Antigravity의 Skills, Plugins, AGENTS.md/CLAUDE.md, MCP 같은 provider-native 기능을 Agora가 복제하지 않는다.
- Agora는 각 provider의 실행 환경을 감싸되, 별도 plugin/skill ecosystem을 v1에서 만들지 않는다.
- 자동화가 추가되는 미래에도 사용자 scope, permission, stop condition보다 높은 권한을 얻지 않는다.
- v1에서는 이를 위한 별도 policy engine을 만들지 않는다.
- 데이터는 local-first를 기본으로 한다. Obsidian/Markdown이 붙더라도 로컬 파일이 source of truth이며 cloud backend나 cross-device sync를 전제로 설계하지 않는다.

## 5. 구현·검토 체크

새 v1 기능을 설계할 때 아래 질문으로만 점검한다.

1. 이 변경이 v2/v3 기능을 지금 미리 구현하는가? 그렇다면 범위에서 뺀다.
2. UI 변경이 실행·저장 로직을 renderer 이벤트에 고정시키는가? 그렇다면 경계를 분리한다.
3. Task·Decision·Run·Review가 필요해질 때 식별자와 관계를 붙일 여지가 있는가?
4. 실행 결과의 출처와 구조화 가능한 정보가 화면 text에만 묻히는가?
5. provider-native 기능, 사용자 권한, local-first 원칙을 침범하는가?

핵심 원칙은 다음 한 문장으로 고정한다.

> **Design v1 so that v2/v3 can be added later, but do not build v2/v3 inside v1.**
