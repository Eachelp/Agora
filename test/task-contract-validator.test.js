"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateTaskContract,
  REQUIRED_SECTIONS,
  RECOMMENDED_SECTIONS,
} = require("../src/agora/task-contract-validator");

const NL = String.fromCharCode(10);

function fullContract(extra = "") {
  return [
    "## Goal",
    "로그인 화면을 구현한다.",
    "## Requirements",
    "- 로그인 폼 제공",
    "## Implementation Approach",
    "플랫폼 기존 패턴을 따른다.",
    "## Acceptance Criteria",
    "- 로그인 성공 시 대시보드로 이동",
    "## Verification",
    "- node --test 실행",
    "## Out of Scope",
    "- 소셜 로그인",
    extra,
  ].join(NL);
}

test("필수 6개 섹션이 모두 있으면 valid", () => {
  const result = validateTaskContract(fullContract());
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.sections.length, REQUIRED_SECTIONS.length);
});

test("필수 섹션 누락 시 invalid + missing 목록", () => {
  const result = validateTaskContract("## Goal" + NL + "목표만 있음");
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Requirements"));
  assert.ok(result.missing.includes("Implementation Approach"));
  assert.ok(result.missing.includes("Acceptance Criteria"));
  assert.ok(result.missing.includes("Verification"));
  assert.ok(result.missing.includes("Out of Scope"));
});

test("h2/h3 헤딩만 인식하고 h1은 무시", () => {
  const contract = [
    "# 제목 (h1은 무시)",
    "## Goal",
    "목표",
    "### Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근",
    "## Acceptance Criteria",
    "완료",
    "## Verification",
    "검증",
    "## Out of Scope",
    "범위밖",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, true);
});

test("헤딩 아래 내용이 코드 펜스뿐이면 empty로 취급", () => {
  const contract = [
    "## Goal",
    String.fromCharCode(96, 96, 96),
    "const x = 1;",
    String.fromCharCode(96, 96, 96),
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근",
    "## Acceptance Criteria",
    "완료",
    "## Verification",
    "검증",
    "## Out of Scope",
    "범위밖",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Goal"));
});

test("코드 펜스 뒤 실제 내용이 있으면 valid", () => {
  const contract = [
    "## Goal",
    "코드 예시:",
    String.fromCharCode(96, 96, 96),
    "const x = 1;",
    String.fromCharCode(96, 96, 96),
    "그다음 실제 설명",
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근",
    "## Acceptance Criteria",
    "완료",
    "## Verification",
    "검증",
    "## Out of Scope",
    "범위밖",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, true);
});

test("권장 섹션 누락은 warnings에만 남는다", () => {
  const result = validateTaskContract(fullContract());
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, RECOMMENDED_SECTIONS);
});

test("헤딩이 전혀 없으면 전부 missing", () => {
  const result = validateTaskContract("아무 내용이나 써 있음");
  assert.equal(result.valid, false);
  assert.equal(result.missing.length, REQUIRED_SECTIONS.length);
});

test("빈 입력은 invalid", () => {
  const result = validateTaskContract("");
  assert.equal(result.valid, false);
});

test("같은 레이블의 축약 헤딩도 매칭된다", () => {
  const contract = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근",
    "## Acceptance Criteria",
    "완료",
    "## Verification",
    "검증",
    "## Out of Scope",
    "범위밖",
    "## Current State",
    "현재 상태",
    "## Invariants",
    "불변 조건",
    "## Risks",
    "위험",
    "## Dependencies",
    "의존성",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, true);
  assert.ok(!result.warnings.includes("Current State / Evidence"));
  assert.ok(!result.warnings.includes("Invariants / Must Preserve"));
  assert.ok(!result.warnings.includes("Risks / Open Questions"));
  assert.ok(!result.warnings.includes("Dependencies"));
});

test("필수 섹션은 축약 헤딩으로 통과하지 못한다", () => {
  const contract = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
    "## Implementation",
    "접근",
    "## Acceptance",
    "완료",
    "## Verification",
    "검증",
    "## Out",
    "범위밖",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Implementation Approach"));
  assert.ok(result.missing.includes("Acceptance Criteria"));
  assert.ok(result.missing.includes("Out of Scope"));
});

test("control marker만 있는 섹션 body는 empty로 취급된다", () => {
  const contract = [
    "## Goal",
    "목표",
    "## Requirements",
    "요구사항",
    "## Implementation Approach",
    "접근",
    "## Acceptance Criteria",
    "완료",
    "## Verification",
    "검증",
    "## Out of Scope",
    "STATUS: PLAN_READY",
  ].join(NL);
  const result = validateTaskContract(contract);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("Out of Scope"));
});
