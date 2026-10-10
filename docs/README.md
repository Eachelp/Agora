# Agora 문서 안내

> **전문 모드 제거됨 2026-10-11 — 아래 설계·검수 문서는 기록 보존용이며 현재 앱에는 구현되어 있지 않습니다 ("현재 지원 범위" 표 참조).** 사용자 결정("전문모드 그냥 제거하고, 오케스트레이터로 전환")에 따라 전문 모드, 역할·팀 상담, `@팀 실행`은 제거되며, 일반 대화 안의 오케스트레이터 모드가 후속 작업으로 들어온다. [개정 기록](design/AGORA_REVISION_2026-10-11_REMOVE_PROFESSIONAL_MODE.md)

처음 사용하는 팀원은 [설치 가이드](../설치-가이드.md) → [사용 안내](../사용-안내.md) 순서로 읽으면 됩니다. 전체 소개는 [README](../README.md)에 있습니다.

이 문서는 2026-09-06 문서 정리 기준입니다. 아래의 현재 기능 설명과 과거 설계·검수 기록을 구분해서 읽어 주세요. 문서 날짜만으로 앱 실행 검증이나 배포 완료를 의미하지는 않습니다.

## 현재 지원 범위

| 기능 | 현재 동작 |
|---|---|
| 일반 대화 | `@claude`·`@gpt`·`@gemini`, `@모두` 이어 발언·독립 발언 |
| 토론 | 발언 수를 정하는 자유토론, Preset과 사이클에 따른 구조화 토론 |
| 답변 대기·승인 | AI가 되묻는 질문에 답하면 이어 진행, 권한 밖 작업은 "이 턴 승인 후 다시 실행" 카드로 확인 |
| 프로젝트 기록 | 프로젝트별 메모리·결정·작업 기록과 공통 규칙을 대화에 전달, 끝난 토론 자동 기록 |
| 모델 목록 | CLI 버전·로그인 1시간 재확인, 모델 목록 캐시 6시간. Codex·AGY 목록과 Claude 도움말 별칭 갱신 |

전문 모드·역할 상담·`@팀 실행`은 제거되었고, 일반 대화 안의 오케스트레이터 모드는 아직 구현되지 않았습니다. 모델 자동 갱신은 CLI와 계정이 제공하는 목록에 한정되며, 모든 신모델의 실시간 발견을 보장하지 않습니다. 갱신 후 열려 있던 모델 선택창은 다시 열어야 합니다.

## 팀 확인과 검증 기록

[실제 앱·CLI 실행 체크리스트](design/AGORA_V1_5_LOCAL_SMOKE_CHECKLIST.md)에 기대 동작과 결과를 기록합니다. 자동 테스트, 앱 화면 확인, 실제 CLI를 연결한 작업 실행은 서로 다른 검증입니다. 실제로 수행한 항목만 결과로 남깁니다.

## 전체 Markdown 목록

이번 정리 전 Git 추적 Markdown 19개를 점검했고, 이 안내 1개를 추가했습니다. 과거 문서의 테스트 수·커밋·당시 미구현 항목은 그 시점의 기록으로 보존합니다.

| 문서 | 용도와 읽는 기준 |
|---|---|
| [README](../README.md) | 현재 제품 소개와 시작 안내 |
| [설치 가이드](../설치-가이드.md) | Windows 설치·계정 연결·업데이트 |
| [사용 안내](../사용-안내.md) | 현재 사용자 조작 방법 |
| [V1 설계](design/AGORA_V1_DESIGN.md) | (제거됨·역사 기록) 전문 실행의 설계 계약. 상단의 현재 구현 보완과 함께 읽음 |
| [미래 확장 호환성](design/AGORA_V1_FUTURE_COMPATIBILITY.md) | 현재 기능과 미래 V2·V3의 경계 |
| [V1.5 구현 계획](design/AGORA_V1_5_IMPLEMENTATION_PLAN.md) | 최초 계획 및 후속 구현 결정 이력. 상단에 현재 도달 범위 표시 |
| [V1.5 제안](design/AGORA_V1_5_PROPOSAL.md) | 최초 제안 기록. 전체가 현재 기능 명세는 아님 |
| [로컬 실행 체크리스트](design/AGORA_V1_5_LOCAL_SMOKE_CHECKLIST.md) | 현재 UI·실제 CLI 확인 시나리오와 수행 결과 |
| [초기 구현 계획](design/AGORA_IMPLEMENTATION_PLAN.md) | 초기 전환 당시 계획 |
| [Managed Harness 개발일지](design/AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md) | Stage별 개발·검증 이력. 본문의 ‘다음 단계’는 작성 당시 기준 |
| [Stage C 최종 검수](design/AGORA_STAGE_C_FINAL_REVIEW.md) | 2026-08-20 검수 대상 커밋의 판정 |
| [Stage C 결정 기록](design/AGORA_STAGE_C_SESSION_LIFECYCLE_DECISIONS.md) | 검수 대기 시점의 결정과 후속 최종 검수 링크 |
| [개정 기록 2026-10-11](design/AGORA_REVISION_2026-10-11_REMOVE_PROFESSIONAL_MODE.md) | 전문 모드·역할 상담 제거 결정과 아래 Stage C·D 문서의 대체됨 표시 근거 |
| [D-0 결정 기록](design/AGORA_STAGE_D0_WORKSPACE_LEASE_DECISIONS.md) | 워크스페이스 변경 소유권의 결정·검수 이력 |
| [D-A0 결정 기록](design/AGORA_STAGE_DA0_VERIFICATION_BOUNDARY_DECISIONS.md) | 검증 안전 경계의 결정·검수 이력 |
| [Stage D Charter](design/AGORA_STAGE_D_ASSURANCE_CHARTER.md) | 승인된 v0.5 의미 계약. 이번 정리는 계약을 변경하지 않음 |
| [Stage D 결정 기록](design/AGORA_STAGE_D_ASSURANCE_DECISIONS.md) | 2026-08-25 완료 기준과 당시 한계. 승인 UI 후속 구현은 상단 안내 참조 |
| [이 문서](README.md) | 팀 공유 진입점과 전체 문서 분류 |

CodePet 분리 당시의 초기 명세·검수 보고서·기준선 감사와 초기 화면 목업은 지금 앱과 맞지 않아 삭제했습니다. 필요하면 git 기록에서 볼 수 있습니다. 작업 폴더의 `.project-memory`는 옛 전문 모드가 만들던 기록으로, 현재 버전은 새로 만들지 않고 읽지도 않으며 지우지도 않습니다. 로컬 검수 사본인 `.codex-review-*`와 의존성 문서는 이 제품 문서 목록에서 제외합니다.
