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
// OPTION과 같은 꼬리 규칙을 따르는 보조 줄. "MULTI: yes"면 보기를 여러 개 고를 수
// 있는 질문이다. ASK_USER 없이 MULTI만 있으면 제어가 아니다.
const MULTI_LINE_PATTERN = /^[ \t]*MULTI:[ \t]*([^\r\n]+?)[ \t]*$/gim;
const MULTI_TRUE_VALUES = new Set(["yes", "y", "true", "예"]);
const PURPOSE_LINE_PATTERN = /^[ \t]*PURPOSE:[ \t]*([^\r\n]+?)[ \t]*$/im;
const REASON_LINE_PATTERN = /^[ \t]*REASON:[ \t]*([^\r\n]+?)[ \t]*$/im;

// 오케스트레이터 지휘 AI 전용 제어 줄. 일반 대화 턴의 parseControlOutput은 이 줄을 모른다 — 지휘 AI 턴만
// parseOrchestrationControl로 따로 읽는다. STAGE: @a @b 한 줄이 한 단계(같은 줄은 동시, 줄 사이는 차례),
// DONE은 오케스트레이션을 끝낸다.
const STAGE_LINE_PATTERN = /^[ \t]*STAGE:[ \t]*([^\r\n]+?)[ \t]*$/i;
const DONE_LINE_PATTERN = /^[ \t]*DONE(?::[ \t]*[^\r\n]*?)?[ \t]*$/i;

// end-anchor 판별용 단일 줄 패턴. 응답 꼬리의 연속된 제어 줄만 골라낸다.
const CONTROL_LINE_PATTERNS = Object.freeze([
  /^[ \t]*HANDOFF:[ \t]*@?[\p{L}\p{N}_-]+[ \t]*$/iu,
  /^[ \t]*COMPLETE(?::[ \t]*[^\r\n]*?)?[ \t]*$/i,
  /^[ \t]*ASK_USER:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*OPTION:[ \t]*[^\r\n]+?[ \t]*$/i,
  /^[ \t]*MULTI:[ \t]*[^\r\n]+?[ \t]*$/i,
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

// 지휘 AI 답 끝의 STAGE·DONE 줄을 읽고, 그 줄만 뺀 본문을 돌려준다. 끝 제어 블록은 기존 제어 줄(ASK_USER 등)과
// STAGE·DONE이 섞여 이어진 줄들이다(사이의 빈 줄은 허용). 코드펜스 안의 예시는 제어가 아니다.
// 반환: { stages: ["@a @b", ...](STAGE: 뒤의 원문), done, text }. STAGE·DONE이 없으면 text는 입력 그대로다.
function parseOrchestrationControl(text) {
  const raw = String(text || "");
  const rawLines = raw.split(/\r?\n/);
  const maskedLines = maskCodeFences(raw).split(/\r?\n/);
  let end = maskedLines.length - 1;
  while (end >= 0 && maskedLines[end].trim() === "") end -= 1;
  let start = end + 1;
  for (let index = end; index >= 0; index -= 1) {
    const line = maskedLines[index];
    if (line.trim() === "") continue;
    if (STAGE_LINE_PATTERN.test(line) || DONE_LINE_PATTERN.test(line) || isControlLine(line)) start = index;
    else break;
  }
  const stages = [];
  let done = false;
  const kept = rawLines.slice(0, start);
  for (let index = start; index <= end; index += 1) {
    const masked = maskedLines[index];
    if (STAGE_LINE_PATTERN.test(masked)) {
      stages.push(rawLines[index].replace(/^[ \t]*STAGE:[ \t]*/i, "").trim());
    } else if (DONE_LINE_PATTERN.test(masked)) {
      done = true;
    } else {
      kept.push(rawLines[index]);
    }
  }
  if (stages.length === 0 && !done) return { stages: [], done: false, text: raw };
  return { stages, done, text: kept.join("\n").trimEnd() };
}

// 기억을 쓰는 차례의 답 끝 줄 `REMEMBER: <유형> | <내용>`. 유형은 화면의 기억하기와 같은 다섯 이름이고 값은 입구가 받는 유형이다.
const REMEMBER_TYPES = Object.freeze({ 사실: "fact", 결정: "decision", 절차: "procedure", 에러: "error", 선호: "preference" });
const REMEMBER_LINE_PATTERN = new RegExp(`^[ \\t]*REMEMBER:[ \\t]*(${Object.keys(REMEMBER_TYPES).join("|")})[ \\t]*\\|[ \\t]*(\\S(?:[^\\r\\n]*\\S)?)[ \\t]*$`, "i");
// 프롬프트가 안내한 최대 줄 수. 더 쓰면 모두 지우고 앞의 것만 저장한다.
const REMEMBER_MAX = 2;

// 끝 블록에 들 수 있는 줄인가(빈 줄은 부르는 쪽이 따로 본다). control: 지휘 차례의 STAGE·DONE과 기존 제어 줄, remember: REMEMBER 줄.
function isTailLine(body, { control, remember }) {
  return (control && (STAGE_LINE_PATTERN.test(body) || DONE_LINE_PATTERN.test(body) || isControlLine(body)))
    || (remember && REMEMBER_LINE_PATTERN.test(body));
}

// 기억을 쓰는 차례의 답 끝에서 REMEMBER 줄을 떼어 낸다. 끝 블록은 그 차례의 초안 필터가 숨기는 줄과 빈 줄이 이어진
// 끝부분이라 초안과 최종 말풍선이 같게 보인다. 지휘 차례(control)는 STAGE·DONE·ASK_USER 줄의 앞에 쓰든 뒤에 쓰든 읽고,
// 그 줄은 그대로 남겨 뒤에서 따로 읽게 한다. 코드펜스·인라인 백틱 안의 줄과 형식이 틀린 줄은 남는다. 같은 내용은 한 번만,
// 앞의 REMEMBER_MAX개만 저장한다. 반환: { items: [{ type, content }], text }. 읽은 줄이 없으면 text는 입력 그대로다.
function parseRememberLines(text, { control }) {
  const raw = String(text || "");
  const rawLines = raw.split(/\r?\n/);
  const maskedLines = maskCodeFences(raw).split(/\r?\n/);
  let start = maskedLines.length;
  for (let index = maskedLines.length - 1; index >= 0; index -= 1) {
    if (maskedLines[index].trim() === "") continue;
    if (!isTailLine(maskedLines[index], { control, remember: true })) break;
    start = index;
  }
  const items = [];
  const kept = rawLines.slice(0, start);
  for (let index = start; index < rawLines.length; index += 1) {
    // 끝 블록의 줄은 위에서 가린 줄로 골랐다. 값은 원문 줄에서 읽는다(가린 줄에서 읽으면 인라인 백틱 안 내용이 사라진다).
    const match = REMEMBER_LINE_PATTERN.exec(rawLines[index]);
    if (!match) kept.push(rawLines[index]);
    else if (!items.some((item) => item.content === match[2])) items.push({ type: REMEMBER_TYPES[match[1]], content: match[2] });
  }
  if (items.length === 0) return { items, text: raw };
  return { items: items.slice(0, REMEMBER_MAX), text: kept.join("\n") };
}

// 지휘 AI 답이 흘러나오는 동안 화면의 초안에서 끝의 제어 줄(STAGE·DONE·ASK_USER …)을 숨기는 필터. 최종 말풍선은 같은
// 줄을 이미 지우므로(parseOrchestrationControl) 초안도 같게 보이게 한다. 제어 줄처럼 보이는 줄(과 그 사이 빈 줄)과, 아직
// 끝나지 않았지만 제어 줄이 될 수 있는 줄의 앞머리는 잠시 붙들고, 뒤에 일반 줄이 이어지면 그대로 내보낸다. 끝날 때
// 붙들려 있는 것은 버린다. 이미 앞머리를 내보낸 줄의 나머지는 판정 없이 잇는다.
// 기억을 쓰는 차례의 끝 REMEMBER 줄도 같은 방법으로 숨긴다. kinds가 숨길 줄을 고른다(control: 지휘 차례의 제어 줄, remember: REMEMBER 줄).
const CONTROL_KEYWORDS = Object.freeze(["STAGE", "DONE", "ASK_USER", "OPTION", "MULTI", "PURPOSE", "REASON", "HANDOFF", "COMPLETE"]);

function isHideableLine(line, kinds) {
  const body = line.replace(/\r?\n$/, "");
  return body.trim() === "" || isTailLine(body, kinds);
}

// 끝나지 않은 줄의 앞머리가 아직 제어 줄이 될 수 있는가: "STAGE:"·"ASK_USER:" 같은 머리표의 앞부분이거나 이미 그 머리표로 시작할 때.
// DONE·COMPLETE는 머리표 없이 낱말 하나만 있는 줄도 제어다. CRLF의 \r만 도착한 순간에도 줄이 끝난 것이 아니므로 \r은 뗀다.
function mayBecomeControlLine(partial, { control, remember }) {
  const head = partial.replace(/^[ \t]+/, "").replace(/\r$/, "").toUpperCase();
  if (!head) return true;
  return [...(control ? CONTROL_KEYWORDS : []), ...(remember ? ["REMEMBER"] : [])].some((word) => {
    const label = `${word}:`;
    return label.startsWith(head) || head.startsWith(label) || ((word === "DONE" || word === "COMPLETE") && head.trimEnd() === word);
  });
}

function createLeadStreamFilter(kinds = { control: true, remember: false }) {
  let held = ""; // 붙들어 둔 줄들(제어 줄처럼 보이는 줄과 빈 줄)
  let partial = ""; // 아직 끝나지 않은 줄
  let midLine = false; // 이 줄의 앞머리를 이미 내보냈는가
  return {
    push(text) {
      partial += String(text || "");
      let out = "";
      for (let newline = partial.indexOf("\n"); newline >= 0; newline = partial.indexOf("\n")) {
        const line = partial.slice(0, newline + 1);
        partial = partial.slice(newline + 1);
        if (midLine || !isHideableLine(line, kinds)) {
          out += held + line;
          held = "";
        } else {
          held += line;
        }
        midLine = false;
      }
      if (partial && (midLine || !mayBecomeControlLine(partial, kinds))) {
        out += held + partial;
        held = "";
        partial = "";
        midLine = true;
      }
      return out;
    },
    end() {
      const out = midLine || (partial && !isHideableLine(partial, kinds)) ? held + partial : "";
      held = "";
      partial = "";
      midLine = false;
      return out;
    },
  };
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
      return { action: "ASK_USER", question: null, options: [], multi: false, ambiguous: true };
    }
    // 보기는 적힌 순서를 지키고 같은 줄 반복만 접는다.
    const options = [...new Set(
      [...source.matchAll(OPTION_LINE_PATTERN)].map((match) => (match[1] || "").trim()).filter(Boolean)
    )];
    // MULTI 줄이 여럿이면 마지막 값을 따른다. yes/y/true/예 외의 값은 단일 선택.
    const multiValues = [...source.matchAll(MULTI_LINE_PATTERN)].map((match) => (match[1] || "").trim().toLowerCase());
    const multi = MULTI_TRUE_VALUES.has(multiValues[multiValues.length - 1]);
    return { action: "ASK_USER", question: questions[0] || null, options, multi, ambiguous: false };
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
  createLeadStreamFilter,
  parseControlOutput,
  parseOrchestrationControl,
  parseRememberLines,
  stripControlOutput,
};
