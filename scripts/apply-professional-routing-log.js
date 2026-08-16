"use strict";

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(process.cwd(), "docs/design/AGORA_MANAGED_HARNESS_EVOLUTION_LOG.md");
let text = fs.readFileSync(file, "utf8");
const heading = "### 2026-08-17 — Professional Mode 작업 요청 라우팅 회귀 수정";
if (text.includes(heading)) {
  console.log("Development log entry already exists.");
  process.exit(0);
}
const marker = "\n---\n\n## 14. 문서 유지 규칙";
const index = text.indexOf(marker);
if (index < 0 || text.indexOf(marker, index + marker.length) >= 0) {
  throw new Error("Could not locate a unique development-log insertion boundary.");
}
const entry = `\n\n${heading}\n\n실사용 화면 검수에서 Professional Mode의 작업 요청 전송 후 Planner 다음에 일반 채팅처럼 다른 모델 응답이 나타나는 회귀를 확인했다.\n\n원인:\n\n- Professional Mode 토글이 UI와 실행 버튼만 바꾸고 작업 요청 전송 자체는 기존 일반 \\`chat:send\\` 경로를 그대로 사용했다.\n- 멘션 없는 일반 사용자 발화는 활성 에이전트 전체의 응답을 예약하므로, 전문 작업 요청을 기록하는 순간 일반 응답 턴이 함께 만들어질 수 있었다.\n- renderer는 일반 \\`turnState\\`를 Professional 실행 버튼의 busy 조건에 포함하지 않아 실행 경계가 화면에서도 불명확했다.\n\n수정:\n\n- Professional Mode에서 보낸 작업 요청은 \\`professionalDraft / recordOnly\\`로 사용자 지시만 기록하고 provider 응답을 예약하지 않는다.\n- 실제 provider 호출은 이후 PLAN 또는 전체 실행을 선택했을 때 Professional FSM에서만 시작한다.\n- renderer가 일반 \\`turnState\\`를 추적하고 일반 응답이 실행/대기 중이면 Professional 실행 버튼을 잠근다.\n- PLAN/전체 실행 준비 조건이 명시적 \\`plan_review\\` 역할 설정을 사용하고, 비어 있을 때만 기존 review 담당자를 fallback으로 사용한다.\n- 같은 \\`@agy\\`를 Planner와 Plan Reviewer에 배정하더라도 각 역할의 model/effort override가 유지되는 회귀 테스트를 추가했다.\n\n검증 기준점:\n\n\\`9f488186ff2fd168def196a877407dfa9a5de92d\\`\n\n\\`\\`\\`text\nnpm test\n  590 / 590 PASS\n\nGitHub Actions\n  ubuntu-latest   PASS\n  macos-latest    PASS\n  windows-latest  PASS\n\\`\\`\\`\n\n이 수정은 Stage C 기능 추가가 아니라 Stage C 착수 전에 실사용에서 발견된 **Professional Mode 입력/실행 경계 회귀를 닫는 baseline correction**이다. 상위 Professional FSM의 Planner → Plan Reviewer → Builder → Reviewer 흐름은 변경하지 않았다.\n`;
text = `${text.slice(0, index)}${entry}${text.slice(index)}`;
fs.writeFileSync(file, text, "utf8");
console.log("Updated managed harness evolution log.");
