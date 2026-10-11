"use strict";

// 묶음 B6 — 실행 인자와 러너.
//  F73  assertSafeArgv가 폴더 경로의 'bypass'·'dangerously'를 금지 플래그로 오인
//  F155 AGY argv 프롬프트 한도를 이스케이프 전 글자 수로 재서 spawn ENAMETOOLONG
//  F74  256K자를 넘는 중첩 이벤트 줄(이미지 Read 결과 등)의 소실
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { buildAgentInvocation, assertSafeArgv } = require("../src/chat/chat-argv");
const { createLineParser } = require("../src/chat/chat-events");
const { runAgentProcess, compactArgvPrompt, MAX_ARGV_PROMPT_CHARS } = require("../src/chat/chat-agent-runner");

const NODE = process.execPath;
const permissions = {
  chat: { supported: true, enforcement: "tool-policy" },
  "workspace-read": { supported: true, enforcement: "tool-policy" },
  "workspace-write": { supported: true, enforcement: "tool-policy" },
};

// ---- F73 -------------------------------------------------------------------

test("F73: 'bypass'·'dangerously'가 든 폴더 경로도 읽기·쓰기 실행 인자를 만든다(세 공급자)", () => {
  const workspace = "D:\\work\\cors-bypass\\DangerouslyFun";
  for (const id of ["claude", "codex", "agy"]) {
    for (const permissionMode of ["workspace-read", "workspace-write"]) {
      const built = buildAgentInvocation({
        provider: { id, name: id, status: "cli", permissions },
        permissionMode,
        workspace,
        chatCwd: "C:\\chat",
        outputFile: "C:\\Users\\bypassuser\\AppData\\Local\\Temp\\out.txt",
      });
      assert.equal(built.ok, true, `${id}/${permissionMode}`);
      assert.ok(built.argv.includes(workspace), `${id}/${permissionMode}: 경로가 그대로 실린다`);
    }
  }
});

test("F73: 금지 플래그는 여전히 막고, 자동 승인 플래그는 허용 목록에서만 통과한다", () => {
  assert.throws(() => assertSafeArgv(["--add-dir", "D:\\x", "--dangerously-skip-permissions"]), /금지된/);
  assert.throws(() => assertSafeArgv(["--dangerously-bypass-approvals-and-sandbox=1"], { autoApprove: true }), /금지된/);
  assert.throws(() => assertSafeArgv(["-bypass"]), /금지된/);
  assert.deepEqual(assertSafeArgv(["--dangerously-skip-permissions"], { autoApprove: true }), ["--dangerously-skip-permissions"]);
  assert.deepEqual(assertSafeArgv(["--cd", "D:\\work\\paywall-bypass"]), ["--cd", "D:\\work\\paywall-bypass"]);
});

test("F73: 이름이 평범한 플래그라도 값이 권한 우회면 막고(인자 둘·--플래그=값), 경로 값은 그대로 통과한다", () => {
  for (const argv of [
    ["--permission-mode", "bypassPermissions"],
    ["--permission-mode=bypassPermissions"],
    ["--permission-mode", "BypassPermissions"],
    ["--mode", "dangerouslySkipPermissions"],
    ["--mode=dangerously-skip-permissions"],
  ]) {
    assert.throws(() => assertSafeArgv(argv), /금지된/, argv.join(" "));
    // 자동 승인 허용 목록은 플래그 이름 두 개뿐이라 값 자리의 우회 낱말은 자동 승인에서도 막힌다.
    assert.throws(() => assertSafeArgv(argv, { autoApprove: true }), /금지된/, `자동 승인: ${argv.join(" ")}`);
  }
  for (const argv of [
    ["--permission-mode", "acceptEdits"],
    ["--add-dir=D:\\work\\cors-bypass"],
    ["--cd", "D:\\work\\bypassPermissions"],
    ["--cd=D:\\work\\dangerously-fun"],
    ["-c", "model_reasoning_effort=high"],
  ]) {
    assert.deepEqual(assertSafeArgv(argv), argv, argv.join(" "));
  }
});

// ---- F155 ------------------------------------------------------------------

// libuv(Windows)가 인자를 감쌀 때의 길이: 따옴표는 \" 로, 따옴표·끝 앞의 역슬래시는 두 배로.
function quotedLength(text) {
  let length = 2;
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") { backslashes += 1; length += 1; continue; }
    if (ch === '"') length += backslashes + 2;
    else length += 1;
    backslashes = 0;
  }
  return length + backslashes;
}

function escapedJsonPrompt() {
  // 이스케이프된 JSON 로그: 따옴표와 역슬래시가 글자 수의 절반을 차지한다.
  const log = `"payload":"{\\"id\\":1,\\"name\\":\\"x\\"}",`.repeat(2000);
  return `RULES:지침 "@agy"\n=== 대화 ===\n[User] ${log}\n=== 대화 끝 ===\n질문`;
}

test("F155: 따옴표·역슬래시가 많아도 인용한 뒤 길이가 한도 안이고 지침과 최신 대화는 남는다", () => {
  const compacted = compactArgvPrompt(escapedJsonPrompt());
  assert.ok(quotedLength(compacted) <= MAX_ARGV_PROMPT_CHARS + 2, `인용 후 ${quotedLength(compacted)}자`);
  assert.ok(compacted.startsWith("RULES:"));
  assert.ok(compacted.endsWith("질문"));
});

test("F155: 이스케이프 없는 글은 예전 한도(24576자) 그대로 자른다", () => {
  const compacted = compactArgvPrompt(`RULES:${"a".repeat(10000)}LATEST:${"z".repeat(30000)}`);
  assert.equal(compacted.length, MAX_ARGV_PROMPT_CHARS);
});

test("F155: 실제 spawn에서 따옴표 범벅 프롬프트가 ENAMETOOLONG 없이 실행된다", { skip: process.platform !== "win32" }, async () => {
  const script = "process.stdout.write(JSON.stringify({n: process.argv.slice(1).join('').length}))";
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script, "--"],
    prompt: escapedJsonPrompt(),
    promptTransport: "argv",
    cwd: os.tmpdir(),
    timeoutMs: 20000,
  });
  const result = await run.promise;
  assert.equal(result.ok, true, result.error);
  assert.ok(JSON.parse(result.text).n > 1000);
});

// ---- F74 -------------------------------------------------------------------

function runClaudeLines(scriptBody) {
  const events = [];
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", scriptBody],
    prompt: "",
    cwd: os.tmpdir(),
    timeoutMs: 20000,
    parseLine: createLineParser("claude"),
    onEvent: (event) => events.push(event),
  });
  return run.promise.then((result) => ({ result, events }));
}

test("F74: 256K자를 넘는 중첩 tool_result 줄도 tool-finished로 읽힌다", async () => {
  const script = [
    "const started = {type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Read',input:{file_path:'a.png'}}]}};",
    "const big = {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'x'.repeat(600000)}]}};",
    "process.stdout.write(JSON.stringify(started)+'\\n'+JSON.stringify(big)+'\\n');",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'끝'})+'\\n');",
  ].join("");
  const { result, events } = await runClaudeLines(script);
  assert.equal(result.ok, true);
  assert.equal(events.filter((event) => event.kind === "tool-started").length, 1);
  assert.equal(events.filter((event) => event.kind === "tool-finished").length, 1, "tool-finished가 사라지면 안 된다");
});

test("F74: 대량 텍스트 뒤 같은 줄에 붙은 중첩 result 이벤트도 final로 읽힌다", async () => {
  const script = [
    "for (let i = 0; i < 6; i += 1) process.stdout.write('y'.repeat(65536));",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'같은 줄 최종',usage:{input_tokens:1,detail:{a:1}}})+'\\n');",
  ].join("");
  const { result } = await runClaudeLines(script);
  assert.equal(result.ok, true);
  assert.equal(result.text, "같은 줄 최종");
});
