"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTeamRunDirective } = require("../src/chat/chat-mention");

// --- parseTeamRunDirective 단위 규칙 ---

test("parseTeamRunDirective: 멘션 바로 다음 토큰이 '실행'일 때만 발동한다", () => {
  assert.equal(parseTeamRunDirective("@팀 실행 로그인 기능 만들어줘"), true);
  assert.equal(parseTeamRunDirective("@팀 실행: 로그인 기능"), true);
  assert.equal(parseTeamRunDirective("@team run build the login flow"), true);
  assert.equal(parseTeamRunDirective("@팀 실행"), true);
  // 본문 임의 위치의 "실행"은 상담 질문을 실행으로 승격하지 않는다.
  assert.equal(parseTeamRunDirective("@팀 이 실행 계획 어때?"), false);
  assert.equal(parseTeamRunDirective("@팀 어떻게 봐? 실행해도 될까"), false);
  // 팀 멘션 자체가 아니면 아무것도 아니다.
  assert.equal(parseTeamRunDirective("@팀장 실행 준비해줘"), false);
  assert.equal(parseTeamRunDirective("실행 @팀"), false);
  assert.equal(parseTeamRunDirective("@팀"), false);
  // 코드 블록 안의 멘션은 호출이 아니다(기존 마스킹 규칙 공유).
  assert.equal(parseTeamRunDirective("`@팀 실행` 문법 설명"), false);
});

test("parseTeamRunDirective: '실행 <명사>' 복합어 상담은 실행으로 승격하지 않는다", () => {
  // "실행 계획/방안/..."은 명사구다 — CONSULT가 EXECUTE 경계를 넘지 않는다(INV-2).
  assert.equal(parseTeamRunDirective("@팀 실행 계획을 같이 검토해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 방안 제안해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 결과를 정리해줘"), false);
  assert.equal(parseTeamRunDirective("@팀 실행 순서 알려줘"), false);
  // 실제 실행 지시는 그대로 발동한다(다음 토큰이 복합어 머리가 아니다).
  assert.equal(parseTeamRunDirective("@팀 실행 로그인 기능 만들어줘"), true);
  assert.equal(parseTeamRunDirective("@팀 실행 해줘"), true);
});

test("parseTeamRunDirective: 앞선 @팀 뒤에 토큰이 없어도 뒤의 '@팀 실행'을 놓치지 않는다", () => {
  // 첫 @팀에서 조기 종료하지 않고 계속 스캔한다.
  assert.equal(parseTeamRunDirective("@팀\n실행 로그인 기능"), true);
  assert.equal(parseTeamRunDirective("@팀. 그리고 @팀 실행 진행"), true);
});

test("parseTeamRunDirective/parseRoleMentions: NFD(자모 분해) 한글도 인식한다", () => {
  const { parseRoleMentions } = require("../src/chat/chat-mention");
  // macOS 붙여넣기 등에서 오는 NFD 입력이 조용히 드롭되면 안 된다.
  assert.equal(parseTeamRunDirective("@팀 실행 로그인 기능 만들어줘".normalize("NFD")), true);
  assert.deepEqual(parseRoleMentions("@기획자 이거 봐줘".normalize("NFD")), ["planner"]);
  assert.deepEqual(parseRoleMentions("@팀 상담 요청".normalize("NFD")), ["team"]);
});
