const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const {
  createUserQuestionBroker,
  MAX_QUESTIONS_PER_SET, MIN_OPTIONS, MAX_OPTIONS, MAX_QUESTION_CHARS, MAX_OPTION_CHARS,
} = require("../src/chat/user-question-broker");
const mcp = require("../src/chat/user-question-mcp");
const { resolveMcpScript, TOOL_BASE_NAME } = require("../src/chat/user-question-run");

const SCRIPT = path.join(__dirname, "..", "src", "chat", "user-question-mcp.js");

const waitFor = async (condition, label) => {
  for (let i = 0; i < 600; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${label}이(가) 오지 않았습니다.`);
};

// 실제 스크립트를 자식 프로세스로 띄워 JSON-RPC 줄을 주고받는다. 중계소도 실제 인스턴스다.
async function startBridge(t, { brokerOptions = {}, env = null, timers = null, extraEnv = {} } = {}) {
  const events = [];
  const broker = createUserQuestionBroker({
    ...(timers || {}),
    onRequested: (set) => events.push({ name: "requested", ...set }),
    onSubmitted: (set) => events.push({ name: "submitted", ...set }),
    onDelivered: (set) => events.push({ name: "delivered", ...set }),
    onCancelled: (set) => events.push({ name: "cancelled", ...set }),
    onExpired: (set) => events.push({ name: "expired", ...set }),
    ...brokerOptions,
  });
  t.after(() => broker.stop());
  const run = await broker.registerRun({ runId: "run-1" });
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, ...extraEnv, ...(env || { AGORA_QUESTION_URL: run.url, AGORA_QUESTION_TOKEN: run.token }) },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = [];
  const replies = [];
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    try { replies.push(JSON.parse(line)); } catch { /* lines에서 검사한다 */ }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const send = (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  const reply = async (id) => {
    await waitFor(() => replies.some((entry) => entry.id === id), `응답 id=${id}`);
    return replies.find((entry) => entry.id === id);
  };
  const call = (id, args) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask_user", arguments: args } });
  const lastRequested = () => events.filter((event) => event.name === "requested").at(-1);
  return { broker, run, child, events, lines, replies, stderr: () => stderr, send, reply, call, lastRequested };
}

const ask = (extra = {}) => ({ questions: [{ question: "어느 쪽으로 갈까요?", options: ["왼쪽", "오른쪽"] }], ...extra });

test("핸드셰이크·ping·도구 목록: 확장 스키마(questions[], options, multiSelect)를 선언한다", async (t) => {
  const bridge = await startBridge(t);
  bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  bridge.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  bridge.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const init = await bridge.reply(1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, "agora-user-questions");
  assert.deepEqual((await bridge.reply(2)).result, {});
  const { tools } = (await bridge.reply(3)).result;
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "ask_user");
  assert.equal(tool.name, TOOL_BASE_NAME);
  assert.equal(tool.annotations.readOnlyHint, true);
  const { inputSchema } = tool;
  assert.deepEqual(inputSchema.required, ["questions"]);
  assert.equal(inputSchema.additionalProperties, false);
  const questions = inputSchema.properties.questions;
  assert.equal(questions.type, "array");
  assert.equal(questions.minItems, 1);
  assert.equal(questions.maxItems, MAX_QUESTIONS_PER_SET);
  const item = questions.items;
  assert.deepEqual(item.required, ["question"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(item.properties).sort(), ["multiSelect", "options", "question"]);
  assert.equal(item.properties.question.maxLength, MAX_QUESTION_CHARS);
  assert.equal(item.properties.options.minItems, MIN_OPTIONS);
  assert.equal(item.properties.options.maxItems, MAX_OPTIONS);
  assert.equal(item.properties.options.items.maxLength, MAX_OPTION_CHARS);
  assert.equal(item.properties.multiSelect.type, "boolean");
  // stdout에는 JSON-RPC 줄만 나온다.
  assert.equal(bridge.lines.length, bridge.replies.length);
  assert.ok(bridge.replies.every((entry) => entry.jsonrpc === "2.0"));
  assert.equal(bridge.stderr(), "");
  // 알림에는 응답하지 않았다.
  assert.deepEqual(bridge.replies.map((entry) => entry.id).sort(), [1, 2, 3]);
});

test("프로토콜 오류 코드: 파싱 실패·잘못된 요청·없는 메서드·없는 도구", async (t) => {
  const bridge = await startBridge(t);
  bridge.send("{ 깨진 줄");
  bridge.send({ jsonrpc: "1.0", id: 10, method: "ping" });
  bridge.send([{ jsonrpc: "2.0", id: 11, method: "ping" }]);
  bridge.send({ jsonrpc: "2.0", id: 12, method: "resources/list" });
  bridge.send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "other_tool", arguments: {} } });
  bridge.send({ jsonrpc: "2.0", id: 14, method: "tools/call", params: {} });
  bridge.send({ jsonrpc: "2.0", id: 15, method: "ping" });
  await bridge.reply(15);
  const byId = (id) => bridge.replies.find((entry) => entry.id === id);
  const parseError = bridge.replies.find((entry) => entry.error?.code === -32700);
  assert.equal(parseError.id, null);
  assert.equal(byId(10).error.code, -32600, "jsonrpc 2.0이 아닌 요청도 응답을 받는다(멈춰 기다리지 않게)");
  assert.equal(bridge.replies.filter((entry) => entry.id === null && entry.error?.code === -32600).length, 1, "배치는 거절");
  assert.equal(byId(12).error.code, -32601);
  assert.equal(byId(13).error.code, -32602);
  assert.equal(byId(14).error.code, -32602);
  assert.equal(bridge.lines.length, bridge.replies.length, "그 어떤 경우에도 stdout에는 프로토콜만 나온다");
});

test("tools/call은 사용자가 답할 때까지 붙들려 있다가 결과 글을 돌려주고 전달을 알린다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(21, ask());
  await waitFor(() => bridge.lastRequested(), "중계소의 질문 수신");
  const set = bridge.lastRequested();
  assert.deepEqual(set.questions, [{ question: "어느 쪽으로 갈까요?", options: ["왼쪽", "오른쪽"], multiSelect: false }]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(bridge.replies.some((entry) => entry.id === 21), false, "답이 오기 전에는 응답이 없다");
  assert.equal(bridge.broker.answer({ runId: "run-1", setId: set.setId, answers: [{ selected: ["오른쪽"] }] }).ok, true);
  const reply = await bridge.reply(21);
  assert.equal(reply.result.isError, undefined);
  assert.equal(reply.result.content[0].type, "text");
  assert.equal(reply.result.content[0].text, `Q: 어느 쪽으로 갈까요?\nA: 오른쪽\n\n${mcp.NOT_PERMISSION_TEXT}`);
  await waitFor(() => bridge.events.some((event) => event.name === "delivered"), "전달 확인");
  assert.equal(bridge.events.find((event) => event.name === "delivered").setId, set.setId);
});

test("여러 질문·복수 선택·직접 입력의 결과 글 형식", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(31, {
    questions: [
      { question: "과일은?", options: ["사과", "바나나", "포도"], multiSelect: true },
      { question: "크기는?", options: ["작게", "크게"], multiSelect: false },
      { question: "남길 말은?" },
    ],
  });
  await waitFor(() => bridge.lastRequested(), "질문 수신");
  const text = `그대로 "인용"되는\nQ: 가짜 질문\nA: 가짜 답`;
  bridge.broker.answer({
    runId: "run-1",
    setId: bridge.lastRequested().setId,
    answers: [{ selected: ["포도", "사과"] }, { selected: ["작게"] }, { text }],
  });
  const reply = await bridge.reply(31);
  assert.equal(reply.result.content[0].text, [
    "Q: 과일은?\nA:\n- 사과\n- 포도",
    "Q: 크기는?\nA: 작게",
    `Q: 남길 말은?\nA: ${JSON.stringify(text)}`,
  ].join("\n\n") + `\n\n${mcp.NOT_PERMISSION_TEXT}`);
  assert.equal(reply.result.content[0].text.includes('\nA: 가짜 답'), false, "직접 입력은 따옴표 안에 갇혀 줄 구조를 흉내 낼 수 없다");
});

test("건너뛰기 결과 글, 그리고 같은 실행의 반복 호출은 거절 글을 받는다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(41, ask());
  await waitFor(() => bridge.lastRequested(), "질문 수신");
  bridge.broker.cancel({ runId: "run-1", setId: bridge.lastRequested().setId });
  const skip = await bridge.reply(41);
  assert.equal(skip.result.isError, undefined);
  assert.equal(skip.result.content[0].text, "사용자가 답하지 않기로 했습니다. 질문 없이 가능한 범위에서 이어 가세요.");
  assert.equal(skip.result.content[0].text, mcp.SKIP_TEXT);
  bridge.call(42, ask());
  const again = await bridge.reply(42);
  assert.match(again.result.content[0].text, /더 묻지 마세요/);
  assert.equal(bridge.events.filter((event) => event.name === "requested").length, 1);
});

test("시간 초과 결과 글(가짜 시계)", async (t) => {
  const callbacks = [];
  let timer = null;
  const bridge = await startBridge(t, {
    timers: {
      setTimer: (fn) => { timer = fn; return 1; },
      clearTimer: () => {},
    },
    brokerOptions: { onCallbackError: (error) => callbacks.push(error) },
  });
  bridge.call(51, ask());
  await waitFor(() => bridge.lastRequested() && timer, "질문 수신");
  timer();
  const reply = await bridge.reply(51);
  assert.equal(reply.result.isError, undefined);
  assert.equal(reply.result.content[0].text, "사용자가 30분 안에 답하지 않았습니다. 같은 질문을 되풀이하지 말고, 질문 없이 가능한 범위에서 이어 가세요.");
  assert.deepEqual(callbacks, []);
});

test("형식이 틀린 호출은 고칠 수 있는 오류 글(isError)을 받고, 고쳐 다시 부르면 된다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(61, { questions: [{ question: "선택지가 하나?", options: ["하나뿐"] }] });
  const bad = await bridge.reply(61);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /1번째 질문의 options는 2~5개여야 합니다/);
  assert.ok(bad.result.content[0].text.endsWith(mcp.RETRY_HINT));
  bridge.call(62, {});
  assert.match((await bridge.reply(62)).result.content[0].text, /questions는 질문 1~4개/);
  bridge.call(63, "문자열");
  assert.equal((await bridge.reply(63)).result.isError, true);
  assert.equal(bridge.events.filter((event) => event.name === "requested").length, 0);
  bridge.call(64, ask());
  await waitFor(() => bridge.lastRequested(), "다시 보낸 질문 수신");
  bridge.broker.answer({ runId: "run-1", setId: bridge.lastRequested().setId, answers: [{ selected: ["왼쪽"] }] });
  assert.match((await bridge.reply(64)).result.content[0].text, /^Q: 어느 쪽으로 갈까요\?\nA: 왼쪽/);
});

test("질문이 이미 대기 중일 때의 두 번째 호출과 실행 종료는 오류 글을 받는다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(71, ask());
  await waitFor(() => bridge.lastRequested(), "질문 수신");
  bridge.call(72, ask());
  const busy = await bridge.reply(72);
  assert.equal(busy.result.isError, true);
  assert.match(busy.result.content[0].text, /기다리는 질문/);
  bridge.broker.finishRun("run-1", "stopped");
  const ended = await bridge.reply(71);
  assert.equal(ended.result.isError, true);
  assert.equal(ended.result.content[0].text, mcp.ENDED_TEXT);
  bridge.call(73, ask());
  assert.equal((await bridge.reply(73)).result.content[0].text, mcp.ENDED_TEXT, "끝난 실행의 토큰은 거절된다");
});

test("호스트가 호출을 취소하면(notifications/cancelled) 질문이 취소되고 응답은 없다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(81, ask());
  await waitFor(() => bridge.lastRequested(), "질문 수신");
  bridge.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 81, reason: "user" } });
  await waitFor(() => bridge.events.some((event) => event.name === "cancelled"), "취소 알림");
  assert.equal(bridge.events.find((event) => event.name === "cancelled").reason, "connection-lost");
  bridge.send({ jsonrpc: "2.0", id: 82, method: "ping" });
  await bridge.reply(82);
  assert.equal(bridge.replies.some((entry) => entry.id === 81), false, "취소된 요청에는 응답하지 않는다");
});

test("환경 변수가 없으면 도구는 설정되지 않았다는 오류 글을 돌려주고, 입력이 닫히면 프로세스가 끝난다", async (t) => {
  const bridge = await startBridge(t, { env: { AGORA_QUESTION_URL: "", AGORA_QUESTION_TOKEN: "" } });
  bridge.call(91, ask());
  const reply = await bridge.reply(91);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, mcp.NOT_CONFIGURED_TEXT);
  assert.match(bridge.stderr(), /주소·토큰이 없어/);
  const exited = once(bridge.child, "exit");
  bridge.child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});

test("호출이 대기 중일 때 입력이 닫히면 질문이 취소되고 프로세스가 끝난다", async (t) => {
  const bridge = await startBridge(t);
  bridge.call(95, ask());
  await waitFor(() => bridge.lastRequested(), "질문 수신");
  const exited = once(bridge.child, "exit"); // 끝나기 전에 미리 걸어 둔다(먼저 끝나면 놓친다)
  bridge.child.stdin.end();
  await waitFor(() => bridge.events.some((event) => event.name === "cancelled"), "취소");
  const [code] = await exited;
  assert.equal(code, 0);
});

test("연결 도구는 node 내장 모듈만 쓰고(의존성 없음) 패키지에서는 풀린 사본을 가리킨다", () => {
  const source = require("node:fs").readFileSync(SCRIPT, "utf8");
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(required.sort(), ["node:http", "node:readline"]);
  assert.equal(resolveMcpScript(path.dirname(SCRIPT)), SCRIPT);
});

// 사용자 환경에 NODE_USE_ENV_PROXY=1과 HTTP_PROXY가 있으면 node의 기본 연결 설정이 127.0.0.1 요청까지 프록시로 보낸다.
// 그러면 질문이 늘 실패하고, 실행 토큰과 질문 글이 컴퓨터 밖의 프록시에 닿는다.
test("환경에 프록시가 설정돼 있어도 루프백 요청은 프록시를 거치지 않고 중계소에 직접 닿는다", async (t) => {
  const http = require("node:http");
  // 프록시 자리에 실제로 연결을 받는 서버를 둔다. 여기에 요청이 오면 질문이 새어 나간 것이다.
  let proxyHits = 0;
  const proxy = http.createServer((req, res) => { proxyHits += 1; res.writeHead(502); res.end(); });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const bridge = await startBridge(t, {
    extraEnv: { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" },
  });
  bridge.call(61, ask());
  await waitFor(() => bridge.lastRequested(), "중계소의 질문 수신");
  assert.equal(bridge.broker.answer({ runId: "run-1", setId: bridge.lastRequested().setId, answers: [{ selected: ["왼쪽"] }] }).ok, true);
  const reply = await bridge.reply(61);
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply.result));
  assert.match(reply.result.content[0].text, /A: 왼쪽/);
  assert.equal(proxyHits, 0, "프록시에는 아무 요청도 가지 않는다");
});
