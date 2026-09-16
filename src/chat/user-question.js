// 에이전트가 일반 채팅 턴을 "사용자에게 되질문"으로 끝냈는지, 그 질문의 보기가
// 무엇인지를 산문에서 뽑는 휴리스틱. 동시 실행 중에는 이런 질문이 다른 에이전트
// 출력에 묻혀, 사용자가 자기 답을 기다리는 에이전트를 놓치기 쉽다. 여기서 뽑은
// 질문과 보기는 '답변 대기' 배지와 선택 칩에 쓴다.
//
// 이 모듈은 fallback이다. 에이전트가 공통 질문 계약(interaction-contract의
// ASK_USER + OPTION)으로 명시적으로 물었으면 chat-room은 그것을 쓰고 여기를
// 보지 않는다. 산문 추출을 더 정교하게 만드는 데 투자하기보다 계약을 지키게
// 하는 편이 낫다 — 그때는 검증된 보기라 즉시 전송도 안전하다.
const { parseMentions } = require("./chat-mention");

// - 다른 에이전트를 @멘션해 넘긴 턴(핸드오프)은 사용자 질문이 아니다.
// - 마지막 비어있지 않은 줄이 물음표로 끝날 때만 질문으로 본다(중간의 수사적
//   물음에 반응하지 않도록 "끝맺음"을 신호로 쓴다).
function trailingUserQuestion(text, agents = [], selfId = null) {
  const body = String(text || "").trim();
  if (!body) return null;
  const mentioned = parseMentions(body, agents).filter((id) => id !== selfId);
  if (mentioned.length > 0) return null;
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  if (!/[?？]\s*$/.test(lastLine)) return null;
  // 마지막 줄에서 물음표로 끝나는 마지막 문장만 질문 본문으로 뽑는다.
  const sentences = lastLine.split(/(?<=[?？!。！.])\s+/).filter(Boolean);
  const question = (sentences[sentences.length - 1] || lastLine).trim();
  return question || null;
}

// 되질문 메시지에서 "보기"를 보수적으로 뽑는다. 에이전트마다 자유 산문이라
// 확실한 모양만 잡고, 애매하면 빈 배열을 돌려 칩 없이 프리필로만 답하게 한다.
// 클릭 시 자동 전송이 아니라 입력창에 채우므로, 조금 부정확해도 사용자가
// 확인·수정할 수 있다.
// - 목록이 보인다고 곧 보기가 아니다. "진행할까요?" 뒤의 불릿은 계획·상태
//   나열이기 쉽다. 그래서 되질문이 "고르는 질문"일 때만 뽑는다.
// - 라벨은 절대 자르지 않는다. 자르면 입력창에 잘린 뜻이 들어간다. 길이는
//   "보기인가(짧은 명사구)"를 가르는 게이트로만 쓰고, 화면 말줄임은 CSS가 맡는다.
const ANSWER_OPTION_MAX_LABEL = 60;
const ANSWER_OPTION_MAX_COUNT = 5;
// 불릿/번호/문자/원문자로 시작하는 목록 줄. 마커 뒤 본문을 그룹으로 잡는다.
// `-`·`*`는 뒤에 공백이 와야 마커다 — `**굵은 소제목**`의 첫 `*`를 불릿으로 읽으면
// 소제목이 통째로 보기가 된다.
const LIST_ITEM_PATTERN =
  /^\s*(?:[-*]\s+|[•◦·▪‣]|\d+[.)]|\(?[a-zA-Z][.)]|[①-⑳]|[❶-❿]|\d+\s*(?:번|순위)[.):]?)\s*(\S.*)?$/;

// 끝에 붙은 괄호 설명 "제목 (설명)"만 떼어 낸다. 문장 중간의 괄호("호건(HDS) 등 …")는
// 설명이 아니므로 그대로 둔다 — 거기서 자르면 문장이 짧은 조각이 되어 길이
// 게이트를 통과하고, 잘린 조각이 칩으로 뜬다.
function stripTrailingParenthetical(text) {
  let label = text;
  for (;;) {
    const next = label.replace(/\s*[(（][^()（）]*[)）]$/, "").trim();
    if (next === label) return label;
    label = next;
  }
}

function tidyOptionLabel(raw) {
  let label = String(raw || "").trim();
  if (!label) return "";
  // 강조/따옴표/코드 기호는 벗겨 낸다. `_`는 낱말을 감싼 강조만 — 파일명 속
  // `_`(LIFT_검사지_문항명세.md)는 라벨의 일부다.
  label = stripTrailingParenthetical(
    label.replace(/[*`"'“”‘’]/g, "").replace(/(^|\s)_+|_+(?=\s|$)/g, "$1").trim()
  );
  // 물음표로 끝나는 항목은 보기가 아니라 질문이다(에이전트가 "던질 질문"을 나열한 경우).
  if (/[?？]$/.test(label)) return "";
  // 제목—설명 구조면 제목만. 구분자(— – : ·)가 나오면 그 앞까지를 라벨로 본다.
  // 콜론은 뒤에 공백이 있을 때만 구분자다 — `D:\경로`·`https://`의 콜론에서 자르면
  // "폴더가 D" 같은 조각이 남는다.
  const cut = label.search(/\s[—–]\s|\s[-]\s|:\s|：|·\s/);
  if (cut > 0) label = stripTrailingParenthetical(label.slice(0, cut).trim());
  // 이보다 길면 "보기"가 아니라 문장이다. 잘라서 뜻을 훼손하지 않고 아예 뺀다.
  // (화면 말줄임은 CSS가 맡고, 입력창에는 늘 원문 전체가 들어간다.)
  if (label.length > ANSWER_OPTION_MAX_LABEL) return "";
  return label;
}

function dedupeOptions(labels) {
  const seen = new Set();
  const out = [];
  for (const label of labels) {
    const value = tidyOptionLabel(label);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= ANSWER_OPTION_MAX_COUNT) break;
  }
  return out;
}

// "고르는 질문"인지 가르는 단서. 목록이 있어도 "진행할까요?"처럼 고르라는
// 질문이 아니면 그 목록은 보기가 아니라 계획·상태 나열일 가능성이 크다.
const CHOICE_CUE_PATTERN =
  /(어느|어떤|무엇|뭐|어디|누구|중에서|중\s|골라|고르|선택|택일|which|what|choose|pick|\bor\b)/i;

function extractAnswerOptions(text, question = "") {
  const body = String(text || "");
  if (!body.trim()) return [];
  // 고르는 질문이 아니면 보기를 뽑지 않는다(칩 없이 프리필만 제공).
  if (!CHOICE_CUE_PATTERN.test(String(question || ""))) return [];
  // 1순위: 불릿/번호 목록 줄이 2개 이상 연속으로 있으면 그 본문을 보기로 쓴다.
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    const match = LIST_ITEM_PATTERN.exec(line);
    // 구분선(---, * * *)은 마커만 이어진 줄이라 목록 항목이 아니다.
    if (match && match[1] && /[\p{L}\p{N}]/u.test(match[1])) items.push(match[1]);
  }
  if (items.length >= 2) {
    const labels = dedupeOptions(items);
    if (labels.length >= 2) return labels;
  }
  // 2순위: 괄호 안 슬래시 목록 "(A / B / C)" 하나. 2~4개, 각 항목이 짧을 때만.
  for (const group of body.matchAll(/[(（]([^()（）\n]{2,}?)[)）]/g)) {
    const parts = group[1].split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.length <= 4 && parts.every((part) => part.length <= ANSWER_OPTION_MAX_LABEL)) {
      const labels = dedupeOptions(parts);
      if (labels.length >= 2) return labels;
    }
  }
  return [];
}

module.exports = { trailingUserQuestion, extractAnswerOptions };
