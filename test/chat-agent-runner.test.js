const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runAgentProcess,
  quoteArgForShell,
  compactArgvPrompt,
  createTailBuffer,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HARD_OUTPUT_LIMIT_BYTES,
  MAX_ARGV_PROMPT_CHARS,
} = require("../src/chat/chat-agent-runner");

const NODE = process.execPath;

function runNode(script, options = {}) {
  return runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script],
    prompt: options.prompt || "",
    cwd: os.tmpdir(),
    timeoutMs: options.timeoutMs || 10000,
    ...options,
  });
}

test("stdin 프롬프트를 받아 stdout을 최종 답변으로 사용한다", async () => {
  const run = runNode(
    "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{process.stdout.write('echo:'+input.trim())})",
    { prompt: "hello" }
  );
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "echo:hello");
});

test("UTF-8 한글 바이트가 청크 경계에서 갈려도 깨지지 않는다", async () => {
  const script = "const b=Buffer.from('한글 응답');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20)";
  const result = await runNode(script).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "한글 응답");
});

test("outputFile이 있으면 stdout보다 우선한다", async () => {
  const outputFile = path.join(os.tmpdir(), `codepet-runner-test-${Date.now()}.txt`);
  const script = `require('fs').writeFileSync(${JSON.stringify(outputFile)}, '파일 답변');process.stdout.write('무시될 stdout')`;
  const run = runNode(script, { outputFile });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "파일 답변");
  assert.equal(fs.existsSync(outputFile), false);
});

test("parseLine이 delta/status/final 이벤트를 발생시키고 final을 답변으로 쓴다", async () => {
  const events = [];
  const script = [
    "console.log(JSON.stringify({kind:'status',label:'생각 중'}))",
    "console.log(JSON.stringify({kind:'delta',text:'부분'}))",
    "console.log(JSON.stringify({kind:'final',text:'파서 최종'}))",
  ].join(";");
  const run = runNode(script, {
    parseLine: (line) => {
      try { return JSON.parse(line); } catch { return null; }
    },
    onEvent: (event) => events.push(event),
  });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "파서 최종");
  assert.deepEqual(events.map((event) => event.kind), ["status", "delta", "final"]);
});

test("여러 구조화 오류가 오면 마지막 종료 원인을 반환한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'error',message:'재연결 중'}))",
    "console.log(JSON.stringify({kind:'error',message:'프록시 연결 거부'}))",
  ].join(";");
  const result = await runNode(script, { parseLine: (line) => JSON.parse(line) }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "프록시 연결 거부");
});

test("기본값에는 출력 길이 상한이 없어 긴 출력만으로 실행을 죽이지 않는다", () => {
  assert.equal(DEFAULT_HARD_OUTPUT_LIMIT_BYTES, null);
});

test("보존 한도를 넘는 긴 출력도 실행을 중단하지 않고 최종 답변을 지킨다", async () => {
  const script = [
    "for (let i = 0; i < 40; i += 1) process.stdout.write('x'.repeat(65536))",
    "process.stdout.write('\\n최종 답변입니다')",
  ].join(";");
  const result = await runNode(script, { captureOutputBytes: 200000, timeoutMs: 20000 }).promise;
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("최종 답변입니다"));
  assert.equal(result.output.captureTruncated, true);
  assert.ok(result.output.stdoutBytes > 200000);
});

test("보존 한도를 넘겨도 parser의 final 이벤트를 정상 답변으로 사용한다", async () => {
  const script = [
    "for (let i = 0; i < 30; i += 1) console.log(JSON.stringify({kind:'noise',text:'x'.repeat(60000)}))",
    "console.log(JSON.stringify({kind:'final',text:'파서 최종'}))",
  ].join(";");
  const result = await runNode(script, {
    captureOutputBytes: 150000,
    timeoutMs: 20000,
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "파서 최종");
  assert.ok(!result.outputLimited);
});

test("명시적 hard limit을 넘기면 OUTPUT_LIMIT 상태로 구분해 중단한다", async () => {
  const result = await runNode("setInterval(()=>process.stdout.write('x'.repeat(65536)),1)", {
    hardOutputLimitBytes: 300000,
    timeoutMs: 20000,
  }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.outputLimited, true);
  assert.ok(!result.timedOut);
  assert.ok(!result.cancelled);
  assert.equal(result.output.outputLimited, true);
  assert.equal(result.output.hardOutputLimitBytes, 300000);
});

test("줄바꿈 없는 대량 출력 뒤에 오는 final 이벤트를 놓치지 않는다", async () => {
  const script = [
    "for (let i = 0; i < 40; i += 1) process.stdout.write('y'.repeat(65536))",
    "process.stdout.write(JSON.stringify({kind:'final',text:'같은 줄 최종'}) + '\\n')",
  ].join(";");
  const result = await runNode(script, {
    timeoutMs: 20000,
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "같은 줄 최종");
  assert.ok(result.output.stdoutBytes > 2 * 1024 * 1024);
});

test("줄바꿈 없는 대량 출력 뒤 개행으로 오는 final도 정상 처리한다", async () => {
  const script = [
    "for (let i = 0; i < 40; i += 1) process.stdout.write('y'.repeat(65536))",
    "console.log(JSON.stringify({kind:'final',text:'개행 최종'}))",
  ].join(";");
  const result = await runNode(script, {
    timeoutMs: 20000,
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "개행 최종");
});

test("짧은 정상 스트리밍은 복구 로직 없이 그대로 동작한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'조'}))",
    "console.log(JSON.stringify({kind:'delta',text:'각'}))",
    "console.log(JSON.stringify({kind:'final',text:'정상 최종'}))",
  ].join(";");
  const events = [];
  const result = await runNode(script, {
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
    onEvent: (event) => events.push(event.kind),
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "정상 최종");
  assert.deepEqual(events, ["delta", "delta", "final"]);
});

test("hard limit으로 끊겨도 화면에 보였던 중간 출력을 partialText로 보존한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'여기까지 진행했습니다'}))",
    "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)",
  ].join(";");
  const result = await runNode(script, {
    hardOutputLimitBytes: 300000,
    timeoutMs: 20000,
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.outputLimited, true);
  assert.equal(result.partialText, "여기까지 진행했습니다");
});

test("hard limit에 걸려도 최종 답변이 이미 도착했으면 성공으로 처리한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'final',text:'이미 끝난 답변'}))",
    "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)",
  ].join(";");
  const result = await runNode(script, {
    hardOutputLimitBytes: 300000,
    timeoutMs: 20000,
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "이미 끝난 답변");
  assert.equal(result.output.outputLimited, true);
});

test("원본 출력은 onRawChunk로 그대로 전달된다", async () => {
  let raw = "";
  const run = runNode("process.stdout.write('원본 로그 조각')", {
    captureOutputBytes: 1000,
    onRawChunk: (chunk) => { raw += chunk; },
  });
  await run.promise;
  assert.ok(raw.includes("원본 로그 조각"));
});

test("tail buffer는 머리와 꼬리를 남기고 중간만 버린다", () => {
  const buffer = createTailBuffer(100);
  buffer.push("HEAD".padEnd(50, "h"));
  buffer.push("m".repeat(500));
  buffer.push("TAIL");
  const text = buffer.toString();
  assert.ok(text.startsWith("HEAD"));
  assert.ok(text.endsWith("TAIL"));
  assert.equal(buffer.truncated, true);
  assert.ok(buffer.totalChars > 500);
  assert.ok(text.length < 400);
});

test("tail buffer 한도 안에서는 원문을 그대로 보존한다", () => {
  const buffer = createTailBuffer(1000);
  buffer.push("짧은 출력");
  assert.equal(buffer.toString(), "짧은 출력");
  assert.equal(buffer.truncated, false);
});

test("cancel은 cancelled 플래그로 끝난다", async () => {
  const run = runNode("setTimeout(()=>{}, 60000)");
  setTimeout(() => run.cancel(), 150);
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});

test("stdout/stderr가 조용하면 실행을 죽이지 않고 상태 이벤트로만 알린다", async () => {
  const events = [];
  const result = await runNode("setTimeout(()=>process.stdout.write('완료'),300)", {
    silenceWarningMs: 100,
    onEvent: (event) => events.push(event),
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  assert.ok(events.some((event) => event.kind === "status" && /분째 응답 없음/.test(event.label)));
});

test("silenceWarningMs를 0으로 주면 무음 경고를 내지 않는다", async () => {
  const events = [];
  const result = await runNode("setTimeout(()=>process.stdout.write('완료'),300)", {
    silenceWarningMs: 0,
    onEvent: (event) => events.push(event),
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(events.filter((event) => event.kind === "status" && /분째 응답 없음/.test(event.label)).length, 0);
});

test("실제 에이전트 실행은 기본 시간제한이 없다", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, null);
  const result = await runAgentProcess({
    commandPath: NODE,
    argv: ["-e", "setTimeout(()=>process.stdout.write('완료'),50)"],
    prompt: "",
    cwd: os.tmpdir(),
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
});

test("명시적으로 제한을 요청한 테스트 실행에서만 타임아웃이 동작한다", async () => {
  const result = await runNode("setTimeout(()=>{}, 60000)", { timeoutMs: 300 }).promise;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("시간 초과"));
});

test("실패 종료 시 stderr 마지막 줄이 오류가 된다", async () => {
  const result = await runNode("console.error('원인: 인증 필요');process.exit(3)").promise;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("인증 필요"));
});

test("셸 인용: 공백/빈 문자열 인자", () => {
  assert.equal(quoteArgForShell(""), '""');
  assert.equal(quoteArgForShell("with space"), '"with space"');
  assert.equal(quoteArgForShell("plain"), "plain");
  assert.equal(quoteArgForShell('has"quote'), '"hasquote"');
});

test("argv 프롬프트는 옵션 뒤 --print 인자로 전달되고 stdin에는 쓰이지 않는다", async () => {
  const script = "process.stdout.write(JSON.stringify({argv:process.argv.slice(1)}));";
  const result = await runNode(script, {
    argv: ["-e", script, "--"],
    prompt: "AGY prompt",
    promptTransport: "argv",
  }).promise;
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text).argv, ["--print", "AGY prompt"]);
});

test("긴 argv 프롬프트는 지침 앞부분과 최신 대화를 남기며 Windows 한도 아래로 줄인다", () => {
  const prompt = `RULES:${"a".repeat(10000)}LATEST:${"z".repeat(30000)}`;
  const compacted = compactArgvPrompt(prompt);
  assert.equal(compacted.length, MAX_ARGV_PROMPT_CHARS);
  assert.ok(compacted.startsWith("RULES:"));
  assert.ok(compacted.endsWith("z".repeat(100)));
  assert.ok(compacted.includes("이전 대화 일부 생략"));
});

test("stderr에 권한 문구가 있어도 본문이 있으면 승인 요청으로 바꾸지 않는다", async () => {
  const result = await runNode(
    "console.error('permission denied while probing');process.stdout.write('정상 답변')"
  ).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "정상 답변");
  assert.ok(!result.approvalRequired);
});

test("본문 없이 권한 오류만 남으면 승인 요청으로 승격한다", async () => {
  const result = await runNode("console.error('permission denied');process.exit(1)").promise;
  assert.equal(result.approvalRequired, true);
});

test("중간 답변(delta)만 있고 권한 오류로 끝나면 성공이 아니라 승인 요청으로 처리한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'작업 중간 결과'}))",
    "console.error('permission denied')",
    "process.exit(1)",
  ].join(";");
  const result = await runNode(script, {
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.approvalRequired, true);
});

test("중간 답변(delta)만 있고 일반 오류로 끝나면 오류로 처리한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'작업 중간 결과'}))",
    "console.error('원인: 네트워크 오류')",
    "process.exit(1)",
  ].join(";");
  const result = await runNode(script, {
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, false);
  assert.ok(!result.approvalRequired);
  assert.ok(result.error.includes("네트워크 오류"));
});

test("정상 종료인데 final 이벤트가 누락되면 일반 대화는 중간 답변을 최종 결과로 승격한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'부분1'}))",
    "console.log(JSON.stringify({kind:'delta',text:'부분2'}))",
  ].join(";");
  const result = await runNode(script, {
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "부분1부분2");
});

test("전문 프롬프트는 final 이벤트가 누락되면 partial을 성공으로 승격하지 않는다", async () => {
  const script = "console.log(JSON.stringify({kind:'delta',text:'부분 구현'}))";
  const result = await runNode(script, {
    prompt: "=== 전문 모드: 구현 ===\n실행 계약",
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.protocolFailed, true);
  assert.equal(result.stopReason, "PROTOCOL_FINAL_MISSING");
  assert.equal(result.partialText, "부분 구현");
});

test("전문 프롬프트라도 명시적 final 이벤트가 있으면 정상 성공한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'delta',text:'부분'}))",
    "console.log(JSON.stringify({kind:'final',text:'완료'}))",
  ].join(";");
  const result = await runNode(script, {
    prompt: "=== 전문 모드: 검토 ===\n계약",
    parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } },
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
});
