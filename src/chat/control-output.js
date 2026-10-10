"use strict";

// 대화 응답 꼬리의 제어 줄(ASK_USER·OPTION 등)을 읽는 순수 로직.
//
// 일반 채팅 턴은 ASK_USER만 받아 '답변 대기'로 바꾼다. HANDOFF·COMPLETE는
// Agora 전문 실행의 역할 간 제어였는데, 그 실행을 지운 뒤에도 인식은 한다 —
// 인식해야 "이 줄은 ASK_USER가 아니니 산문으로 남긴다"를 판단할 수 있다.
// (원래 interaction-contract.js에 있던 것을 대화가 쓰는 부분만 옮겼다.)

// HANDOFF 줄에서 지목할 수 있는 표면 별칭. 전부 완전 단어형만 둔다 — 한글
// 별칭이 더 긴 단어에 삼켜지는 위험(기획 ↔ 기획자)을 피한다.
const HANDOFF_TARGET_ALIASES = Object.freeze({
  planner: Object.freeze(["planner", "기획자"]),
  builder: Object.freeze(["builder", "implementation", "구현자"]),
  reviewer: Object.freeze(["reviewer", "검토자", "검수자"]),
  recorder: Object.freeze(["recorder", "기록자"]),
});
const HANDOFF_TARGETS = Object.freeze(Object.keys(HANDOFF_TARGET_ALIASES));

const HANDOFF_LINE_PATTERN = /^[ \t]*HANDOFF:[ \t]*@?([\p{L}\p{N}_-]+)[ \t]*$/gimu;
// 단독 "COMPLETE" 또는 "COMPLETE: 요약"만 인식한다. 콜론 없는 뒤따름
// ("COMPLETE the task ...")은 산문이지 제어 마커가 아니다.
const COMPLETE_LINE_PATTERN = /^[ \t]*COMPLETE(?::[ \t]*([^\r\n]*?))?[ \t]*$/gim;
const ASK_USER_LINE_PATTERN = /^[ \t]*ASK_USER:[ \t]*([^\r\n]+?)[ \t]*$/gim;
// ASK_USER의 보기. 고르는 질문일 때 질문 아래 줄마다 하나씩 적는다. ASK_USER
// 없이 OPTION만 있으면 제어가 아니다.
const OPTION_LINE_PATTERN = /^[ \t]*OPTION:[ \t]*([^\r\n]+?)[ \t]*$/gim;
const PURPOSE_LINE_PATTERN = /^[ \t]*PURPOSE:[ \t]*([^\r\n]+?)[ \t]*$/im;
const REASON_LINE_PATTERN = /^[ \t]*REASON:[ \t]*([^\r\n]+?)[ \t]*$/im;

// end-anchor 판별용 단일 줄 패턴. 응답 꼬리의 연속된 제어 줄만 골라낸다.
const CONTROL_LINE_PATTERNS = Object.freeze([
  /^[ \t]*HANDOFF:[ \t]*@?[\p{L}\p{N}_-]+[ \t]*$/iu,
  /^[ \t]*COMPLETE(?::[ \t]*[^\r\n]*?)?[ \t]*$/i,
  /^[ \t]*ASK_USER:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*OPTION:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*PURPOSE:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*REASON:[ \t]*[^\r\n]+?[ \t]*$/i,
]);

function isControlLine(line) {
  return CONTROL_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

// 응답 마지막에 붙은 연속 제어 블록의 줄 범위를 masked 텍스트 기준으로 구한다.
// 본문 중간의 마커(예시·설명)는 제어가 아니다. 제어 블록 뒤에 코드펜스가
// 이어져도 마찬가지다 — 펜스는 가려지되 빈 줄이 아니므로 끝줄 앵커를 깬다.
//
// 반환은 [start, end] 포함 범위다(start > end면 제어 블록 없음). 호출자는
// "어느 줄이 제어 줄인가"만 masked로 판정하고, 실제 값은 같은 범위의 원문
// 줄에서 읽는다 — masked에서 값을 뽑으면 인라인 백틱 안 내용이 사라진다.
function trailingControlRange(masked) {
  const lines = String(masked || "").split(/\r?\n/);
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end -= 1;
  let start = end;
  while (start >= 0 && lines[start].trim() !== "" && isControlLine(lines[start])) start -= 1;
  return { start: start + 1, end };
}

// 가림 문자: 공백도, 제어 패턴의 어휘 문자도 아니다. 공백으로 가리면 꼬리
// 코드펜스가 빈 줄로 보여 펜스 앞 제어가 끝줄 제어로 오인되고, 어휘 문자로
// 가리면 백틱 안 "HANDOFF: `@x`"가 제어 줄로 읽힌다.
const MASK_CHAR = "·";

function maskCodeFences(text) {
  return String(text || "")
    // 개행은 보존한다 — masked와 원문의 줄 수가 어긋나면 stripControlOutput이
    // masked 인덱스로 원문을 잘라 본문을 삭제한다.
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => match.replace(/[^\r\n]/g, MASK_CHAR))
    .replace(/`[^`\r\n]*`/g, (match) => MASK_CHAR.repeat(match.length));
}

// 표시용 텍스트에서 꼬리 제어 블록을 제거한다. parseControlOutput이 인식하는
// 블록과 정확히 같은 범위를 지운다.
function stripControlOutput(text) {
  const raw = String(text || "");
  const { start, end } = trailingControlRange(maskCodeFences(raw));
  if (start > end) return raw;
  return raw.split(/\r?\n/).slice(0, start).join("\n").trimEnd();
}

function handoffTargetForToken(token) {
  const lowered = String(token || "").toLowerCase();
  for (const [role, aliases] of Object.entries(HANDOFF_TARGET_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === lowered)) return role;
  }
  return null;
}

// 응답 꼬리의 제어 행동을 파싱한다. 마커가 없으면 null. 서로 다른 행동이 섞이거나
// 값이 갈리면 ambiguous로 표시하고 확정하지 않는다.
function parseControlOutput(text) {
  const raw = String(text || "");
  const { start, end } = trailingControlRange(maskCodeFences(raw));
  if (start > end) return null;
  const source = raw.split(/\r?\n/).slice(start, end + 1).join("\n");

  const handoffTargets = [];
  for (const match of source.matchAll(HANDOFF_LINE_PATTERN)) {
    const role = handoffTargetForToken(match[1]);
    handoffTargets.push(role || match[1].toLowerCase());
  }
  const completes = [...source.matchAll(COMPLETE_LINE_PATTERN)];
  const asks = [...source.matchAll(ASK_USER_LINE_PATTERN)];

  const actions = [];
  if (handoffTargets.length > 0) actions.push("HANDOFF");
  if (completes.length > 0) actions.push("COMPLETE");
  if (asks.length > 0) actions.push("ASK_USER");
  if (actions.length === 0) return null;
  if (actions.length > 1) {
    return { action: null, ambiguous: true };
  }

  if (actions[0] === "COMPLETE") {
    const summaries = [...new Set(completes.map((match) => (match[1] || "").trim()))];
    if (summaries.length > 1) {
      return { action: "COMPLETE", summary: null, ambiguous: true };
    }
    return { action: "COMPLETE", summary: summaries[0] || null, ambiguous: false };
  }
  if (actions[0] === "ASK_USER") {
    // 질문이 여러 개면 하나를 조용히 버리게 된다 — 사용자가 내려야 할 결정을
    // 잃는 것이므로 ambiguous로 반환한다.
    const questions = [...new Set(asks.map((match) => (match[1] || "").trim()))];
    if (questions.length > 1) {
      return { action: "ASK_USER", question: null, options: [], ambiguous: true };
    }
    // 보기는 적힌 순서를 지키고 같은 줄 반복만 접는다.
    const options = [...new Set(
      [...source.matchAll(OPTION_LINE_PATTERN)].map((match) => (match[1] || "").trim()).filter(Boolean)
    )];
    return { action: "ASK_USER", question: questions[0] || null, options, ambiguous: false };
  }

  const distinct = [...new Set(handoffTargets)];
  const last = handoffTargets[handoffTargets.length - 1];
  const known = HANDOFF_TARGETS.includes(last) ? last : null;
  const purposeMatch = source.match(PURPOSE_LINE_PATTERN);
  const reasonMatch = source.match(REASON_LINE_PATTERN);
  return {
    action: "HANDOFF",
    targetRole: distinct.length === 1 ? known : null,
    purpose: purposeMatch ? purposeMatch[1].trim() : null,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
    ambiguous: distinct.length > 1,
  };
}

module.exports = {
  parseControlOutput,
  stripControlOutput,
};
