// 안전한 마크다운-라이트 토크나이저.
// HTML을 만들지 않고 토큰만 반환합니다. 렌더링은 chat.js가 DOM API(textContent)로만 수행하므로
// 에이전트 출력에 어떤 마크업이 있어도 스크립트/HTML로 해석되지 않습니다.
// 지원: 문단, # 제목, 파이프 표, 순서/비순서 목록, ``` 코드 펜스(언어 라벨), `인라인 코드`, **굵게**, http(s) 링크, @멘션.
(function attachChatMarkdown(global) {
  const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)\s*$/;
  const MAX_LIST_NUMBER = 99;
  const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
  const HEADING = /^(#{1,6})\s+(.*)$/;

  // 파이프 표: 앞뒤 | 는 있어도 없어도 되고, 셀은 | 로 나눕니다.
  function splitRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  // 구분선(---, :--, --:, :--:)만으로 이뤄진 줄이어야 표로 인정합니다.
  // 정렬 표기는 인식만 하고 쓰지 않습니다(표시 정렬은 CSS가 담당).
  function isTableSeparator(line) {
    if (!line || !line.includes("-")) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
  }
  // URL 본문: 공백과 따옴표류는 제외하되, 파일 이름에 흔한 괄호쌍은 짝이 맞을 때만 허용합니다.
  // (예: .../기업용 인성검사(BFI)_20260812.xlsx)
  const INLINE_PATTERN =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\((?:https?|file):\/\/(?:[^\s<>"'`\[\]()]|\([^\s()]*\))+\))|((?:https?|file):\/\/(?:[^\s<>"'`\[\]()]|\([^\s()]*\))+)|(@[\p{L}\p{N}_-]+)/gu;

  // 퍼센트 인코딩된 한글 경로(%EB%82%B4…)를 그대로 두면 사람이 읽을 수 없습니다.
  function decodeUrlText(value) {
    const text = String(value || "");
    try {
      return decodeURIComponent(text);
    } catch {
      // 잘린 URL 등 디코딩할 수 없는 입력은 원문을 지킵니다.
    }
    try {
      return decodeURI(text);
    } catch {
      return text;
    }
  }

  function fileNameFromPath(path) {
    const parts = String(path).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || String(path);
  }

  // file://은 링크(이동 가능)로 만들지 않습니다. 별도 토큰으로 넘겨 renderer가
  // 이동하지 않는 칩으로만 그리게 합니다. http(s)만 link 토큰이 됩니다.
  function makeUrlToken(href, label) {
    if (/^file:\/\//i.test(href)) {
      const path = decodeUrlText(href.replace(/^file:\/{2,3}/i, ""));
      return { type: "file", href, path, text: label || fileNameFromPath(path) };
    }
    return { type: "link", href, text: label || href };
  }

  function tokenizeInline(text) {
    const source = String(text || "");
    const tokens = [];
    let lastIndex = 0;
    for (const match of source.matchAll(INLINE_PATTERN)) {
      if (match.index > lastIndex) {
        tokens.push({ type: "text", text: source.slice(lastIndex, match.index) });
      }
      const [full, code, bold, markdownLink, link, mention] = match;
      if (code) tokens.push({ type: "code", text: code.slice(1, -1) });
      else if (bold) tokens.push({ type: "bold", text: bold.slice(2, -2) });
      else if (markdownLink) {
        // [제목](주소) — 에이전트가 습관적으로 쓰는 문법인데 지금까지는 원문 그대로 보였습니다.
        const split = markdownLink.lastIndexOf("](");
        tokens.push(makeUrlToken(
          markdownLink.slice(split + 2, -1),
          markdownLink.slice(1, split)
        ));
      }
      else if (link) tokens.push(makeUrlToken(link, ""));
      else if (mention) tokens.push({ type: "mention", text: mention });
      lastIndex = match.index + full.length;
    }
    if (lastIndex < source.length) {
      tokens.push({ type: "text", text: source.slice(lastIndex) });
    }
    return tokens;
  }

  // 사용자가 쓴 글은 서식을 해석하지 않는다. 멘션만 골라내고 나머지(**, 백틱, 링크 주소, 파일 경로 포함)는
  // 쓴 그대로 text 토큰에 둔다. 코드·링크 안의 @는 멘션이 아니므로 INLINE_PATTERN이 먼저 삼키게 둔다.
  function tokenizeMentions(text) {
    const source = String(text || "");
    const tokens = [];
    let lastIndex = 0;
    for (const match of source.matchAll(INLINE_PATTERN)) {
      if (!match[5]) continue;
      if (match.index > lastIndex) tokens.push({ type: "text", text: source.slice(lastIndex, match.index) });
      tokens.push({ type: "mention", text: match[5] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < source.length) tokens.push({ type: "text", text: source.slice(lastIndex) });
    return tokens;
  }

  function tokenizeBlocks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const blocks = [];
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      blocks.push({ type: "paragraph", lines: paragraph.map(tokenizeInline) });
      paragraph = [];
    };

    while (index < lines.length) {
      const line = lines[index];
      const fenceMatch = line.match(FENCE_OPEN);
      if (fenceMatch) {
        flushParagraph();
        const lang = fenceMatch[1] || "";
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1; // 닫는 펜스(또는 EOF) 건너뛰기
        blocks.push({ type: "fence", lang, code: codeLines.join("\n") });
        continue;
      }

      const headingMatch = line.match(HEADING);
      if (headingMatch) {
        flushParagraph();
        blocks.push({ type: "heading", level: headingMatch[1].length, tokens: tokenizeInline(headingMatch[2]) });
        index += 1;
        continue;
      }

      // 헤더 줄 바로 다음이 구분선이어야 표입니다. 본문에 쓰인 | 를 표로 오인하지 않습니다.
      if (line.includes("|") && !isTableSeparator(line) && isTableSeparator(lines[index + 1])) {
        flushParagraph();
        const header = splitRow(line).map(tokenizeInline);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitRow(lines[index]).map(tokenizeInline));
          index += 1;
        }
        blocks.push({ type: "table", header, rows });
        continue;
      }

      const listMatch = line.match(LIST_ITEM);
      if (listMatch) {
        flushParagraph();
        const ordered = /^\d/.test(listMatch[2]);
        const items = [];
        const rawLines = [];
        const numbers = [];
        while (index < lines.length) {
          const itemMatch = lines[index].match(LIST_ITEM);
          if (!itemMatch || /^\d/.test(itemMatch[2]) !== ordered) break;
          if (ordered) numbers.push(parseInt(itemMatch[2], 10));
          items.push(tokenizeInline(itemMatch[3]));
          rawLines.push(lines[index].trim());
          index += 1;
        }
        // 연도 같은 큰 숫자('2026. 10. 10.')는 목록 번호가 아니라 날짜 줄이므로 문단으로 그대로 보여 줍니다.
        // 그 밖의 순서 목록은 원문 번호(start와 numbers)를 함께 넘겨, 3번부터 시작하거나 건너뛰어도 번호가 유지되게 합니다.
        if (ordered && numbers.some((number) => number > MAX_LIST_NUMBER)) {
          blocks.push({ type: "paragraph", lines: rawLines.map(tokenizeInline) });
        } else {
          blocks.push(ordered ? { type: "list", ordered, items, start: numbers[0], numbers } : { type: "list", ordered, items });
        }
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
    return blocks;
  }

  const api = { tokenizeBlocks, tokenizeInline, tokenizeMentions };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.chatMarkdown = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
