const MENTION_PATTERN = /@([\p{L}\p{N}_-]+)/gu;

function maskNonCallingText(text) {
  // NFC로 정규화한 뒤 마스킹한다. 별칭 리터럴("팀"/"실행"/"기획자" 등)은
  // NFC 형태라, 입력이 NFD(결합 자모 분해 — macOS 붙여넣기 등)이면 토큰
  // 비교가 실패해 멘션이 조용히 누락된다. 모든 파서(parseMentions/
  // hasLegacyRoleMention)가 이 함수의 결과를 대상으로 매칭하므로 여기서
  // 한 번 정규화하면 일관되게 인식된다.
  return String(text || "")
    .normalize("NFC")
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

// 옛 역할 호출(@기획자·@검토자·@구현자·@기록자·@팀)을 알아보는 안내용 감지.
// 호출은 지원하지 않으므로 어느 역할인지는 필요 없고 있었는지만 본다.
// "팀"은 @팀장·@팀원 같은 흔한 단어를 삼키지 않게 정확 일치만 인정한다.
// 영어 별칭(@planner·@team 등)은 평범한 핸들일 수 있어 감지하지 않는다.
const LEGACY_ROLE_ALIASES = Object.freeze([
  "기획자", "구현자", "검토자", "검수자", "기록자",
]);
const LEGACY_TEAM_ALIASES = Object.freeze(["팀"]);

function hasLegacyRoleMention(text) {
  const source = maskNonCallingText(text);
  for (const match of source.matchAll(MENTION_PATTERN)) {
    const previous = match.index > 0 ? source[match.index - 1] : "";
    if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
    const token = match[1];
    if (LEGACY_TEAM_ALIASES.some((alias) => alias === token.toLowerCase())) return true;
    if (LEGACY_ROLE_ALIASES.some((alias) => tokenMatchesAlias(token, alias))) return true;
  }
  return false;
}

module.exports = {
  hasLegacyRoleMention,
  parseMentions,
  tokenMatchesAlias,
  maskNonCallingText,
};
