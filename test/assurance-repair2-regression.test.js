"use strict";

// Stage D — 2차 독립 검수 잔여 blocker 회귀 테스트 중, 전문 실행(ChatRoom)을 거치지
// 않고 모듈 단독으로 도는 것만 남겼다. 나머지(B3·B5·B7의 resumeSpecialist 경유 시험)는
// 전문 모드와 함께 지웠다. assurance 모듈 삭제 때 이 파일도 함께 지운다.
const test = require("node:test");
const assert = require("node:assert/strict");

test("B3: 저장 실패는 사용자에게 설명되는 사유로 남는다", () => {
  const { describeBlockers } = require("../src/agora/assurance/final-disposition");
  const described = describeBlockers({
    blockers: [{ reason: "ASSURANCE_STATE_WRITE_FAILED" }],
  });
  assert.equal(described.length, 1);
  assert.ok(described[0].label.includes("저장"));
});
