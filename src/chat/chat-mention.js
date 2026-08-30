const MENTION_PATTERN = /@([\p{L}\p{N}_-]+)/gu;

function maskNonCallingText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\r\n]*`/g, (match) => " ".repeat(match.length));
}

// "@codex야" 처럼 한국어 조사가 붙어도 별칭을 인식합니다.
// 별칭 뒤에 영문/숫자가 이어지면(@claudette) 다른 이름으로 보고 제외합니다.
function tokenMatchesAlias(token, alias) {
  const lowered = token.toLowerCase();
  if (!lowered.startsWith(alias.toLowerCase())) return false;
  const rest = token.slice(alias.length);
  return rest === "" || !/^[a-z0-9_-]/i.test(rest);
}

function parseMentions(text, agents, groupAliases = []) {
  const source = maskNonCallingText(text);
  const mentioned = [];
  const seen = new Set();

  const add = (agent) => {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      mentioned.push(agent.id);
    }
  };

  for (const match of source.matchAll(MENTION_PATTERN)) {
    const previous = match.index > 0 ? source[match.index - 1] : "";
    // 이메일/식별자 안의 @는 호출이 아닙니다. 독립된 @멘션만 허용합니다.
    if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
    const token = match[1];
    if (groupAliases.some((alias) => tokenMatchesAlias(token, alias))) {
      for (const agent of agents) add(agent);
      continue;
    }
    for (const agent of agents) {
      if ((agent.aliases || []).some((alias) => tokenMatchesAlias(token, alias))) {
        add(agent);
        break;
      }
    }
  }
  return mentioned;
}

// V1.5 역할 멘션(제안서 §6~7). provider 별칭(claude/gpt/codex/gemini/agy/
// antigravity)과 겹치지 않는 완전 단어형만 둔다. tokenMatchesAlias의 prefix
// 매칭이 한글 연장을 통과시키므로("기획"이 "기획자"를 삼킨다) 축약형 한글
// 별칭을 추가하지 않는다.
const ROLE_ALIASES = Object.freeze({
  planner: Object.freeze(["planner", "기획자"]),
  builder: Object.freeze(["builder", "구현자"]),
  reviewer: Object.freeze(["reviewer", "검토자", "검수자"]),
  recorder: Object.freeze(["recorder", "기록자"]),
});

// 역할 멘션 파싱. parseMentions와 같은 마스킹·토큰 규칙을 쓰되 결과는 역할
// id 목록이다. 미지 토큰은 기존과 동일하게 조용히 무시한다 — 이 함수를
// 추가해도 @claude/@gpt/@gemini 해석은 전혀 바뀌지 않는다.
function parseRoleMentions(text) {
  const source = maskNonCallingText(text);
  const mentioned = [];
  const seen = new Set();
  for (const match of source.matchAll(MENTION_PATTERN)) {
    const previous = match.index > 0 ? source[match.index - 1] : "";
    if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
    const token = match[1];
    for (const [roleId, aliases] of Object.entries(ROLE_ALIASES)) {
      if (aliases.some((alias) => tokenMatchesAlias(token, alias))) {
        if (!seen.has(roleId)) {
          seen.add(roleId);
          mentioned.push(roleId);
        }
        break;
      }
    }
  }
  return mentioned;
}

module.exports = {
  parseMentions,
  tokenMatchesAlias,
  maskNonCallingText,
  ROLE_ALIASES,
  parseRoleMentions,
};
