const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildAgentInvocation } = require("../src/chat/chat-argv");
const {
  SERVER_KEY, TOOL_NAME, ENV_URL, ENV_TOKEN, ATTACHABLE_PURPOSES,
  resolveMcpScript, questionToolSupport, attachUserQuestionTool,
} = require("../src/chat/user-question-run");
const { createUserQuestionBroker, DEFAULT_WAIT_MS } = require("../src/chat/user-question-broker");

const ROOT = path.join(__dirname, "..");
const CHAT_CWD = "C:\\Users\\u\\.agora\\runtime\\chat";
const WORKSPACE = "D:\\work\\my project";

function provider(id, overrides = {}) {
  const all = { supported: true, enforcement: "sandbox" };
  return {
    id, name: id, status: "cli",
    permissions: { chat: all, "workspace-read": all, "workspace-write": all },
    ...overrides,
  };
}

// 경로에 공백·따옴표·역슬래시·한글·개행·DEL이 모두 들어 있는 까다로운 서버 설정
const NASTY = 'C:\\Program Files\\내 "도구"\\a b\\node\u007f.exe';
const SERVER = {
  command: NASTY,
  args: [`D:\\프로젝트 폴더\\it's "q"\\user-question-mcp.js`, "줄\n바꿈"],
  env: { ELECTRON_RUN_AS_NODE: "1", [ENV_URL]: "http://127.0.0.1:5555/runs/r 1", [ENV_TOKEN]: "abc123" },
};
const QUESTION = { server: SERVER, serverKey: SERVER_KEY, toolName: TOOL_NAME };

function build(id, input = {}, providerOverrides = {}) {
  return buildAgentInvocation({
    provider: provider(id, providerOverrides),
    chatCwd: CHAT_CWD,
    workspace: WORKSPACE,
    ...input,
  });
}

test("상수: 서버 키와 Claude 도구 이름이 고정되어 있다", () => {
  assert.equal(SERVER_KEY, "agora_user_question");
  assert.equal(TOOL_NAME, "mcp__agora_user_question__ask_user");
  assert.deepEqual([...ATTACHABLE_PURPOSES], ["chat"]);
});

for (const mode of ["chat", "workspace-read", "workspace-write"]) {
  test(`Claude(${mode}): MCP 설정·허용 도구·엄격 모드가 붙고 나머지 인자는 그대로다`, () => {
    const base = build("claude", { permissionMode: mode, model: "haiku", effort: "low" });
    const withQuestion = build("claude", { permissionMode: mode, model: "haiku", effort: "low", userQuestion: QUESTION });
    assert.equal(base.questionToolAttached, false);
    assert.equal(withQuestion.questionToolAttached, true);
    // 붙이지 않은 실행의 argv는 한 글자도 바뀌지 않고, 붙인 실행은 그 뒤에 인자만 더한다.
    assert.deepEqual(withQuestion.argv.slice(0, base.argv.length), base.argv);
    const added = withQuestion.argv.slice(base.argv.length);
    assert.equal(added.length, 4);
    assert.equal(added[0], "--mcp-config");
    assert.equal(added[2], "--allowedTools");
    assert.equal(added[3], "mcp__agora_user_question__ask_user");
    assert.equal(withQuestion.argv.filter((arg) => arg === "--strict-mcp-config").length, 1, "엄격 모드는 한 번만, 사용자 MCP 설정을 읽지 않는다");
    const config = JSON.parse(added[1]);
    assert.deepEqual(Object.keys(config.mcpServers), ["agora_user_question"]);
    assert.deepEqual(config.mcpServers.agora_user_question, {
      command: NASTY, args: SERVER.args, env: SERVER.env, alwaysLoad: true,
    });
    assert.equal(withQuestion.stdinPrompt, true);
  });
}

test("Codex: 서버 설정 6줄(-c)과 35분 도구 제한이 붙고, 노력은 호출자가 준 값 그대로다", () => {
  const base = build("codex", { permissionMode: "chat", model: "gpt-6-luna", effort: "low" });
  const withQuestion = build("codex", { permissionMode: "chat", model: "gpt-6-luna", effort: "low", userQuestion: QUESTION });
  assert.equal(withQuestion.questionToolAttached, true);
  assert.deepEqual(withQuestion.argv.slice(0, base.argv.length), base.argv);
  assert.ok(base.argv.includes("model_reasoning_effort=low"), "노력은 명시한 값이다");
  const added = withQuestion.argv.slice(base.argv.length);
  assert.equal(added.length, 12);
  const values = {};
  for (let i = 0; i < added.length; i += 2) {
    assert.equal(added[i], "-c");
    const match = /^mcp_servers\.agora_user_question\.([a-z_]+)=(.*)$/s.exec(added[i + 1]);
    assert.ok(match, added[i + 1]);
    values[match[1]] = match[2];
  }
  assert.deepEqual(Object.keys(values), ["command", "args", "env", "enabled", "startup_timeout_sec", "tool_timeout_sec"]);
  assert.equal(values.enabled, "true");
  assert.equal(values.startup_timeout_sec, "30");
  // 기본 60초 제한이면 1분만 고민해도 질문이 취소된다. 중계소의 30분 대기보다 길어야 중계소의 시간 초과 결과가 먼저 닿는다.
  assert.equal(values.tool_timeout_sec, "2100");
  assert.ok(Number(values.tool_timeout_sec) * 1000 > DEFAULT_WAIT_MS);
  // 이스케이프: TOML 기본 문자열 문법에 맞고 원래 값으로 되돌아온다.
  const TOML_BASIC = /^"(?:[^"\\\u0000-\u001f\u007f]|\\["\\bfnrt]|\\u[0-9A-Fa-f]{4})*"$/;
  assert.match(values.command, TOML_BASIC);
  assert.equal(JSON.parse(values.command.replace(/\\u007F/g, "\\u007f")), NASTY);
  assert.match(values.args, /^\[("(?:[^"\\\u0000-\u001f\u007f]|\\.)*"(, )?)+\]$/);
  assert.deepEqual(JSON.parse(values.args), SERVER.args);
  assert.match(values.env, /^\{ .* \}$/s);
  const pairs = [...values.env.matchAll(/"((?:[^"\\]|\\.)*)" = ("(?:[^"\\]|\\.)*")/g)];
  assert.equal(pairs.length, Object.keys(SERVER.env).length);
  const env = {};
  for (const [, key, value] of pairs) {
    assert.match(`"${key}"`, TOML_BASIC);
    assert.match(value, TOML_BASIC);
    env[JSON.parse(`"${key}"`)] = JSON.parse(value);
  }
  assert.deepEqual(env, SERVER.env);
  // 어떤 인자에도 날것의 DEL·개행은 없다.
  for (const arg of withQuestion.argv) assert.doesNotMatch(arg, /[\u007f\n]/);
});

test("Codex: 환경 변수가 비어 있으면 env 줄을 만들지 않는다", () => {
  const result = build("codex", { permissionMode: "chat", userQuestion: { ...QUESTION, server: { command: "node", args: ["a.js"] } } });
  assert.equal(result.questionToolAttached, true);
  assert.equal(result.argv.some((arg) => arg.startsWith("mcp_servers.agora_user_question.env=")), false);
  assert.ok(result.argv.includes("mcp_servers.agora_user_question.command=\"node\""));
});

test("붙이지 않는 경우: 셸 래퍼(.cmd)·AGY·알 수 없는 통로·질문 정보 없음·잘못된 정보", () => {
  const plain = (id, overrides) => build(id, { permissionMode: "chat" }, overrides);
  for (const id of ["claude", "codex"]) {
    const shell = build(id, { permissionMode: "chat", userQuestion: QUESTION }, { needsShell: true });
    assert.equal(shell.questionToolAttached, false, `${id}: 셸 래퍼에는 붙이지 않는다`);
    assert.deepEqual(shell.argv, plain(id, { needsShell: true }).argv);
    assert.equal(build(id, { permissionMode: "chat", userQuestion: null }).questionToolAttached, false);
    for (const bad of [
      {},
      { server: { command: "", args: [] }, serverKey: SERVER_KEY, toolName: TOOL_NAME },
      { server: { command: "node", args: "a.js" }, serverKey: SERVER_KEY, toolName: TOOL_NAME },
      { server: { command: "node", args: [], env: [] }, serverKey: SERVER_KEY, toolName: TOOL_NAME },
      { server: SERVER, serverKey: "bad key.with=dots", toolName: TOOL_NAME },
      { server: SERVER, serverKey: SERVER_KEY, toolName: "ask_user" },
      { server: SERVER, serverKey: SERVER_KEY, toolName: "mcp__x__y --dangerously-skip-permissions" },
    ]) {
      const result = build(id, { permissionMode: "chat", userQuestion: bad });
      assert.equal(result.questionToolAttached, false, JSON.stringify(bad));
      assert.deepEqual(result.argv, plain(id).argv, "잘못된 정보는 argv를 바꾸지 않는다");
    }
  }
  const agy = build("agy", { permissionMode: "chat", userQuestion: QUESTION });
  assert.equal(agy.questionToolAttached, false);
  assert.deepEqual(agy.argv, plain("agy").argv);
  assert.equal(agy.argv.some((arg) => /mcp|agora_user_question/i.test(arg)), false);
});

test("질문 서버 경로에 bypass·dangerously 같은 낱말이 있어도 안전 검사가 오탐하지 않는다", () => {
  const server = { command: "C:\\bypass\\dangerously\\node.exe", args: ["D:\\x\\mcp.js"], env: {} };
  for (const id of ["claude", "codex"]) {
    const result = build(id, { permissionMode: "chat", userQuestion: { ...QUESTION, server } });
    assert.equal(result.ok, true);
    assert.equal(result.questionToolAttached, true);
  }
  // 질문 도구와 무관하게, 자동 승인 없이 만들어진 위험 플래그는 여전히 막힌다.
  assert.throws(() => require("../src/chat/chat-argv").assertSafeArgv(["--dangerously-skip-permissions"]), /금지된/);
});

test("권한은 질문 도구가 올리지 않는다: 자동 승인·샌드박스 인자는 질문 도구 유무와 같다", () => {
  const strip = (argv, count) => argv.slice(0, argv.length - count);
  const claudeBase = build("claude", { permissionMode: "workspace-read" });
  const claudeQ = build("claude", { permissionMode: "workspace-read", userQuestion: QUESTION });
  assert.deepEqual(strip(claudeQ.argv, 4), claudeBase.argv);
  assert.equal(claudeQ.argv.some((arg) => /dangerously|acceptEdits/.test(arg)), false);
  const codexBase = build("codex", { permissionMode: "workspace-read" });
  const codexQ = build("codex", { permissionMode: "workspace-read", userQuestion: QUESTION });
  assert.deepEqual(strip(codexQ.argv, 12), codexBase.argv);
  assert.ok(codexQ.argv.includes("read-only"));
  assert.equal(codexQ.enforcement, codexBase.enforcement);
  assert.equal(codexQ.cwd, codexBase.cwd);
});

test("프롬프트 안내는 서버 키와 도구 이름을 그대로 적고, 코딩 전제 없이 권한 승인이 아님을 밝힌다", () => {
  const { USER_QUESTION_INSTRUCTION } = require("../src/chat/user-question-run");
  assert.ok(USER_QUESTION_INSTRUCTION.includes("agora_user_question"));
  assert.ok(USER_QUESTION_INSTRUCTION.includes("ask_user"));
  assert.match(USER_QUESTION_INSTRUCTION, /승인이 아닙니다/);
  assert.doesNotMatch(USER_QUESTION_INSTRUCTION, /git|테스트|커밋|코드/i);
  assert.equal(USER_QUESTION_INSTRUCTION.split("\n").length, 3);
});

test("붙일 수 있는 실행 판단: 일반 대화 턴의 Claude·Codex만, 가장 안전한 부분집합", () => {
  const ok = (input) => questionToolSupport({ hasBroker: true, ...input }).ok;
  assert.equal(ok({ providerId: "claude", purpose: "chat" }), true);
  assert.equal(ok({ providerId: "codex", purpose: "chat" }), true);
  assert.equal(ok({ providerId: "agy", purpose: "chat" }), false);
  assert.equal(ok({ providerId: "claude", purpose: "chat", needsShell: true }), false);
  assert.equal(ok({ providerId: "claude", purpose: "chat", hasBroker: false }), false);
  for (const purpose of ["discussion", "consult", "summary", "explain", "record", "", undefined, null]) {
    assert.equal(ok({ providerId: "claude", purpose }), false, `purpose=${purpose}`);
    assert.equal(ok({ providerId: "codex", purpose }), false, `purpose=${purpose}`);
  }
  assert.match(questionToolSupport({ providerId: "claude", purpose: "chat", needsShell: true }).reason, /셸 래퍼/);
});

test("attachUserQuestionTool: 등록·서버 설정·정리, 붙지 못해도 던지지 않는다", async (t) => {
  const broker = createUserQuestionBroker();
  t.after(() => broker.stop());
  const attached = await attachUserQuestionTool({ broker, runId: "run-42", providerId: "claude", purpose: "chat", meta: { agentId: "claude", sessionId: "s1" } });
  assert.equal(attached.attached, true);
  assert.equal(attached.serverKey, "agora_user_question");
  assert.equal(attached.toolName, "mcp__agora_user_question__ask_user");
  assert.equal(attached.server.command, process.execPath);
  assert.deepEqual(attached.server.args, [resolveMcpScript()]);
  assert.equal(fs.existsSync(attached.server.args[0]), true, "실제 MCP 스크립트 경로");
  assert.match(attached.server.env[ENV_URL], /^http:\/\/127\.0\.0\.1:\d+\/runs\/run-42$/);
  assert.equal(attached.server.env[ENV_TOKEN].length, 64);
  // Electron이 아니면 ELECTRON_RUN_AS_NODE는 넣지 않는다(일반 node로 그대로 실행).
  assert.equal(Object.hasOwn(attached.server.env, "ELECTRON_RUN_AS_NODE"), Boolean(process.versions.electron));
  // 그대로 argv로 이어진다.
  const invocation = build("claude", { permissionMode: "chat", userQuestion: attached });
  assert.equal(invocation.questionToolAttached, true);
  // cleanup 뒤에는 토큰이 통하지 않는다.
  assert.deepEqual(attached.cleanup(), { ok: true, cancelled: 0 });
  assert.equal(broker.getPending("run-42"), null);
  const again = await attachUserQuestionTool({ broker, runId: "run-42", providerId: "codex", purpose: "chat" });
  assert.equal(again.attached, true, "정리된 실행 ID는 다시 등록할 수 있다");
  const duplicate = await attachUserQuestionTool({ broker, runId: "run-42", providerId: "codex", purpose: "chat" });
  assert.equal(duplicate.attached, false);
  assert.match(duplicate.reason, /이미 등록/);

  const refusals = [
    { providerId: "agy", purpose: "chat" },
    { providerId: "claude", purpose: "discussion" },
    { providerId: "claude", purpose: "chat", needsShell: true },
  ];
  for (const input of refusals) {
    const result = await attachUserQuestionTool({ broker, runId: "other", ...input });
    assert.equal(result.attached, false);
    assert.ok(result.reason);
  }
  assert.equal((await attachUserQuestionTool({ runId: "x", providerId: "claude", purpose: "chat" })).attached, false, "중계소 없음");
  const failing = { registerRun: async () => { throw new Error("포트를 열 수 없습니다"); } };
  const failed = await attachUserQuestionTool({ broker: failing, runId: "x", providerId: "claude", purpose: "chat" });
  assert.equal(failed.attached, false);
  assert.match(failed.reason, /포트를 열 수 없습니다/);
});

test("패키지: 연결 도구 파일은 asarUnpack으로 풀리고 런타임에 풀린 경로를 쓴다", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.build.asarUnpack.includes("src/chat/user-question-mcp.js"));
  assert.ok(pkg.build.files.includes("src/**/*"), "src 전체가 패키지에 들어가야 풀 수 있다");
  assert.equal(fs.existsSync(path.join(ROOT, "src", "chat", "user-question-mcp.js")), true);
  const sep = path.sep;
  const packed = [sep + "apps", "Agora", "resources", "app.asar", "src", "chat"].join(sep);
  assert.equal(
    resolveMcpScript(packed),
    [sep + "apps", "Agora", "resources", "app.asar.unpacked", "src", "chat", "user-question-mcp.js"].join(sep)
  );
  const dev = resolveMcpScript();
  assert.equal(dev.endsWith(path.join("src", "chat", "user-question-mcp.js")), true);
  assert.equal(dev.includes("app.asar"), false);
  // 풀린 사본 하나만으로 실행돼야 하므로 다른 로컬 파일을 require하지 않는다.
  const source = fs.readFileSync(path.join(ROOT, "src", "chat", "user-question-mcp.js"), "utf8");
  assert.doesNotMatch(source, /require\("\.{1,2}\//);
});
