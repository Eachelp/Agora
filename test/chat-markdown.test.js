const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenizeBlocks, tokenizeInline } = require("../src/chat-markdown");

test("문단과 코드 펜스를 분리하고 언어를 보존한다", () => {
  const blocks = tokenizeBlocks("설명입니다.\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n끝.");
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "fence", "paragraph"]);
  assert.equal(blocks[1].lang, "js");
  assert.equal(blocks[1].code, "const a = 1;\nconsole.log(a);");
});

test("닫히지 않은 펜스도 끝까지 코드로 취급한다", () => {
  const blocks = tokenizeBlocks("```python\nprint(1)");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "fence");
  assert.equal(blocks[0].code, "print(1)");
});

test("순서/비순서 목록", () => {
  const blocks = tokenizeBlocks("- 하나\n- 둘\n\n1. 첫째\n2. 둘째");
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].ordered, true);
});

test("인라인 코드/굵게/링크/멘션 토큰", () => {
  const tokens = tokenizeInline("`code` **bold** https://example.com/x @claude 끝");
  assert.deepEqual(tokens.map((token) => token.type), [
    "code", "text", "bold", "text", "link", "text", "mention", "text",
  ]);
  assert.equal(tokens[0].text, "code");
  assert.equal(tokens[2].text, "bold");
  assert.equal(tokens[4].href, "https://example.com/x");
  assert.equal(tokens[6].text, "@claude");
});

test("http 이외 스킴은 링크로 인식하지 않는다", () => {
  const tokens = tokenizeInline("javascript:alert(1) file:///etc/passwd");
  assert.ok(tokens.every((token) => token.type !== "link"));
});

test("HTML 마크업은 일반 텍스트 토큰으로만 나온다 (XSS 안전)", () => {
  const payload = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  const blocks = tokenizeBlocks(payload);
  assert.equal(blocks.length, 1);
  for (const lineTokens of blocks[0].lines) {
    for (const token of lineTokens) {
      assert.equal(token.type, "text");
    }
  }
  // 토큰을 모두 이어 붙이면 원문 그대로다(변조/해석 없음).
  const joined = blocks[0].lines[0].map((token) => token.text).join("");
  assert.equal(joined, payload);
});

test("빈 입력은 빈 블록 배열", () => {
  assert.deepEqual(tokenizeBlocks(""), []);
  assert.deepEqual(tokenizeInline(""), []);
});

test("마크다운 링크 문법을 원문 그대로 두지 않는다", () => {
  const tokens = tokenizeInline("자세히는 [문서](https://example.com/a(b)c) 참고");
  const link = tokens.find((token) => token.type === "link");
  assert.equal(link.text, "문서");
  // 파일 이름에 흔한 괄호쌍은 주소 안에 그대로 남습니다.
  assert.equal(link.href, "https://example.com/a(b)c");
  assert.ok(tokens.every((token) => !String(token.text).includes("](")));
});

test("file 경로는 링크가 아니라 읽을 수 있는 file 토큰이 된다", () => {
  const tokens = tokenizeInline(
    "[보고서](file:///l:/%EB%82%B4%20%EB%AC%B8%EC%84%9C/%EA%B2%80%EC%82%AC(BFI).xlsx) 확인"
  );
  const file = tokens.find((token) => token.type === "file");
  // 이동 가능한 link 토큰으로는 절대 나오지 않습니다.
  assert.ok(tokens.every((token) => token.type !== "link"));
  assert.equal(file.text, "보고서");
  // 퍼센트 인코딩된 한글 경로를 사람이 읽는 형태로 되돌립니다.
  assert.equal(file.path, "l:/내 문서/검사(BFI).xlsx");
});

test("라벨이 없는 file 주소는 파일 이름만 남긴다", () => {
  const [token] = tokenizeInline("file:///C:/work/%EA%B2%B0%EA%B3%BC.xlsx");
  assert.equal(token.type, "file");
  assert.equal(token.text, "결과.xlsx");
  assert.equal(token.path, "C:/work/결과.xlsx");
});

test("디코딩할 수 없는 주소도 원문을 잃지 않는다", () => {
  const [token] = tokenizeInline("file:///c:/%E0%A4%A.txt");
  assert.equal(token.type, "file");
  assert.ok(token.path.includes("%E0%A4%A"));
});
