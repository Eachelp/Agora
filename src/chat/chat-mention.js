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
  // 팀 상담(제안서 §9.2): 기획자 → 검토자 → 구현자 순차 읽기 전용 상담.
  // @모두의 기존 브로드캐스트 의미를 바꾸지 않기 위해 별도 멘션으로 둔다.
  team: Object.freeze(["team", "팀"]),
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
      // "팀"은 조사 허용 prefix 매칭을 쓰면 @팀장·@팀원 같은 흔한 단어에
      // 오발동해 세 역할 상담을 시작해 버린다. 팀 별칭만 정확 일치를 요구한다
      // (직함 역할 별칭은 @기획자야처럼 조사가 붙는 일이 잦아 prefix 유지).
      const matched = roleId === "team"
        ? aliases.some((alias) => alias.toLowerCase() === token.toLowerCase())
        : aliases.some((alias) => tokenMatchesAlias(token, alias));
      if (matched) {
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

// V1.5 §9 — "@팀 실행"만 팀 자율 실행 트리거다. 그 밖의 @팀 메시지는 전부
// 읽기 전용 팀 상담(CONSULT)으로 남는다(INV-2). 판정은 멘션 바로 다음
// 토큰이 정확히 "실행"(또는 영문 별칭 "run")인지로만 한다 — 본문 임의
// 위치의 "실행"으로 오발동하면 상담 질문("이 실행 계획 어때?")이 실제
// 실행으로 승격되기 때문이다.
function parseTeamRunDirective(text) {
  const source = maskNonCallingText(text);
  for (const match of source.matchAll(MENTION_PATTERN)) {
    const previous = match.index > 0 ? source[match.index - 1] : "";
    if (previous && /[\p{L}\p{N}_@-]/u.test(previous)) continue;
    const token = match[1];
    const isTeam = ROLE_ALIASES.team.some(
      (alias) => alias.toLowerCase() === token.toLowerCase()
    );
    if (!isTeam) continue;
    const rest = source.slice(match.index + match[0].length);
    const next = rest.match(/^\s+(\S+)/u);
    // 이 @팀에 이어지는 토큰이 없으면(문장 끝 등) 실행이 아니다. 하지만
    // 뒤에 또 다른 @팀 실행이 있을 수 있으므로 조기 종료하지 않고 계속 본다.
    if (!next) continue;
    // 전각 구두점·생략부호·물결까지 꼬리에서 떼어낸다.
    const word = next[1].replace(/[:,.!?…~。！？，、]+$/u, "");
    if (word !== "실행" && word.toLowerCase() !== "run") continue;
    // "실행 계획/방안/..."은 실행 명령이 아니라 명사구(실행 계획을 검토해줘)
    // 상담이다 — CONSULT가 자연어만으로 EXECUTE 경계를 넘지 않게 한다(INV-2).
    // 실행 토큰 다음 토큰이 그 복합어 머리로 시작하면 실행으로 보지 않는다.
    const afterRun = rest.replace(/^\s+\S+/u, "").match(/^\s+(\S+)/u);
    if (afterRun) {
      const NOUN_HEADS = [
        "계획", "방안", "방법", "결과", "전략", "여부", "순서", "내역",
        "기록", "과정", "현황", "상태", "방향", "우선순위", "일정", "범위", "단계",
      ];
      if (NOUN_HEADS.some((head) => afterRun[1].startsWith(head))) continue;
    }
    return true;
  }
  return false;
}

module.exports = {
  parseMentions,
  tokenMatchesAlias,
  maskNonCallingText,
  ROLE_ALIASES,
  parseRoleMentions,
  parseTeamRunDirective,
};
