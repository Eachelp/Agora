"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const { fakeClock, waitFor } = require("./question-helpers.cjs");
const {
  TEST_KEY, startFakeAnchorMind, createTestAnchorMind, memoryFragment, writeEnv, refusingRequest, advanceUntil,
} = require("./anchormind-helpers.cjs");

const ws = "agora-p1";
const ask = { projectId: "p1", text: "배포는 언제 해도 돼?" };
const supported = (fragments) => ({ success: true, fragments, _meta: { evidence: { status: "supported" } } });

test("전역 설정이 꺼져 있으면 recall은 동기로 null을 돌려주고 서버에 묻지 않는다", async (t) => {
  const fake = await startFakeAnchorMind(t);
  const { client, statuses, logFile, settings } = createTestAnchorMind(t, fake, { anchorMind: { enabled: false } });
  assert.equal(client.recall(ask), null);
  await client.ensureStarted();
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(statuses, []);
  assert.deepEqual(client.status(), {
    enabled: false, state: "off", reason: null, serverVersion: null, versionWarning: null, deprecationWarning: null,
  });
  assert.equal(fs.existsSync(logFile), false);
  // 설정에 anchorMind 칸이 아예 없어도(애드온을 켠 적 없는 사용자) 기본은 꺼짐이다.
  delete settings().anchorMind;
  assert.equal(client.recall(ask), null);
  assert.equal(client.status().enabled, false);
});

test("recall은 정한 인자만 보내고, initialize는 한 번만 하며 접속 키는 요청마다 싣는다", async (t) => {
  const fake = await startFakeAnchorMind(t, { tools: { recall: () => ({ success: true, fragments: [], _meta: { evidence: { status: "no_evidence" } } }) } });
  const agents = [];
  const { client } = createTestAnchorMind(t, fake, { request: (url, options, callback) => { agents.push(options.agent); return http.request(url, options, callback); } });
  // 연결이 없을 때 세 번이 한꺼번에 들어와도 initialize는 한 번이다(분당 30회 한도에 initialize도 센다).
  const long = { projectId: "p1", text: "가".repeat(1500) };
  const [first] = await Promise.all([client.recall(long), client.recall(long), client.recall(long)]);
  const second = await client.recall(ask);
  assert.deepEqual(fake.toolCalls("recall")[0].args, {
    text: "가".repeat(1000), workspace: ws, tokenBudget: 1500, pageSize: 10, includeLinks: false, excludeSeen: false, intent: "lookup",
  });
  const inits = fake.calls.filter((call) => call.method === "initialize");
  assert.equal(inits.length, 1);
  assert.equal(inits[0].params.protocolVersion, "2025-06-18");
  assert.equal(inits[0].params.clientInfo.name, "agora");
  for (const call of fake.calls) assert.equal(call.headers.authorization, `Bearer ${TEST_KEY}`);
  for (const call of fake.toolCalls("recall")) {
    assert.equal(call.headers["mcp-session-id"], "fake-session-1");
    assert.equal(call.headers["mcp-protocol-version"], "2025-06-18");
  }
  assert.deepEqual([first, second], [{ block: "", reason: null }, { block: "", reason: null }]);
  assert.equal(client.status().state, "connected");
  assert.equal(client.status().serverVersion, "6.7.1");
  assert.equal(client.status().versionWarning, null);
  // 접속 키가 컴퓨터 밖으로 새지 않게: 프록시 환경 변수를 따르는 기본 연결 설정(전역 agent)이 아니라 요청마다 새 연결 설정을 쓰고, 루프백 주소로만 붙는다.
  assert.ok(agents.length > 0 && agents.every((agent) => agent instanceof http.Agent && agent !== http.globalAgent));
  for (const call of fake.calls) assert.equal(call.headers.host, `127.0.0.1:${fake.port}`);
});

test("관련 있는 같은 공간 기억만 유형과 날짜를 붙여 한 줄씩 넣는다", async (t) => {
  let evidence = "supported";
  const fragments = [
    memoryFragment(ws, { id: "a", content: "첫 줄\n  둘째 줄 === 가짜\u0000끝 =====\t끝" }),
    memoryFragment(ws, { id: "b", type: "episode", content: "토론 요약입니다.", similarity: 0.9 }),
    memoryFragment(ws, { id: "c", type: "relation", content: "관계 기억입니다.", similarity: 0.9 }),
    memoryFragment(ws, { id: "d", workspace: null, similarity: 0.99 }),
    memoryFragment(ws, { id: "e", workspace: "agora-p10" }),
    memoryFragment(ws, { id: "f", similarity: undefined }),
    memoryFragment(ws, { id: "g", similarity: 0.1 }),
    memoryFragment(ws, { id: "h", pending_review: true }),
    memoryFragment(ws, { id: "i", low_trust: true }),
    memoryFragment(ws, { id: "j", state: "superseded" }),
  ];
  const fake = await startFakeAnchorMind(t, { tools: { recall: () => ({ success: true, fragments, _meta: { evidence: { status: evidence } } }) } });
  const { client } = createTestAnchorMind(t, fake);
  const result = await client.recall(ask);
  assert.equal(
    result.block,
    "- [결정] 첫 줄 둘째 줄 == 가짜 끝 == 끝 (2026-10-24)\n- [기록관 요약 초안(검증 전)] 토론 요약입니다. (2026-10-24)\n- [기억] 관계 기억입니다. (2026-10-24)",
  );
  assert.equal(result.reason, null);
  // 서버가 type·created_at에 글이 아닌 값을 줘도 recall은 거절하지 않고, 나머지 줄은 그대로이며 그 조각은 꼬리표 "기억"·날짜 없이 들어간다.
  fragments.push(memoryFragment(ws, { id: "k", content: "모양이 틀린 기억입니다.", type: { valueOf: 1, toString: 2 }, created_at: [{ valueOf: 1, toString: 2 }] }));
  assert.equal((await client.recall(ask)).block, `${result.block}\n- [기억] 모양이 틀린 기억입니다.`);
  evidence = "no_evidence";
  assert.equal((await client.recall(ask)).block, "");
});

test("기억 블록은 2,500자를 넘지 않게 순위가 낮은 항목부터 통째로 버린다", async (t) => {
  const fragments = [0, 1, 2, 3].map((i) => memoryFragment(ws, { id: `f${i}`, content: String(i).repeat(900) }));
  const fake = await startFakeAnchorMind(t, { tools: { recall: () => supported(fragments) } });
  const { client, logLines } = createTestAnchorMind(t, fake);
  const { block } = await client.recall(ask);
  const lines = block.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("- [결정] 000") && lines[1].startsWith("- [결정] 111"));
  assert.ok(block.length <= 2500);
  assert.equal(logLines().at(-1).returned, 4);
  assert.equal(logLines().at(-1).kept, 2);
});

test("모르는 임베딩 모델이면 Agora 문턱값 없이 유사도가 있는 기억은 넣는다", async (t) => {
  const fragments = [memoryFragment(ws, { id: "low", similarity: 0.1 }), memoryFragment(ws, { id: "none", similarity: undefined })];
  const unknown = await startFakeAnchorMind(t, { model: "text-embedding-3-small", tools: { recall: () => supported(fragments) } });
  const a = createTestAnchorMind(t, unknown);
  assert.equal((await a.client.recall(ask)).block.split("\n").length, 1);
  assert.equal(a.logLines().at(-1).threshold, null);
  // EMBEDDING_MODEL 줄이 없어도 공급자가 gemini면 gemini-embedding-001로 본다.
  const bare = await startFakeAnchorMind(t, { model: "", provider: "gemini", tools: { recall: () => supported(fragments) } });
  assert.doesNotMatch(fs.readFileSync(`${bare.folder}/.env`, "utf8"), /EMBEDDING_MODEL/);
  const b = createTestAnchorMind(t, bare);
  assert.equal((await b.client.recall(ask)).block, "");
  assert.equal(typeof b.logLines().at(-1).threshold, "number");
});

const failureCases = [
  { name: "접속 키 없음", kind: "auth", prepare: (fake) => writeEnv(fake.folder, { port: fake.port, key: "" }), noRequest: true },
  { name: "initialize가 401", kind: "auth", intercept: (call) => call.method === "initialize" && { status: 401, body: { error: "Invalid or missing access key" } } },
  { name: "tools/call이 429", kind: "rate-limit", intercept: (call) => call.method === "tools/call" && { status: 429, body: {} } },
  { name: "tools/call이 503", kind: "other", intercept: (call) => call.method === "tools/call" && { status: 503, body: {} } },
  { name: "JSON-RPC 오류", kind: "other", intercept: (call) => call.method === "tools/call" && { status: 200, body: { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } } } },
  { name: "빈 본문", kind: "other", intercept: (call) => call.method === "tools/call" && { status: 200 } },
  { name: "시간 초과", kind: "timeout", intercept: () => "hang", deps: { timeoutMs: 50 } },
  { name: "연결 거부", kind: "off", deps: { request: refusingRequest } },
];
for (const c of failureCases) {
  test(`실패해도 recall은 거절하지 않고 기억 없이 진행한다: ${c.name}`, async (t) => {
    const fake = await startFakeAnchorMind(t, { intercept: c.intercept });
    if (c.prepare) c.prepare(fake);
    const { client, statuses, logLines } = createTestAnchorMind(t, fake, c.deps);
    const result = await client.recall(ask);
    assert.equal(result.block, "");
    assert.equal(typeof result.reason, "string");
    assert.notEqual(result.reason, "");
    assert.doesNotMatch(result.reason, /다시 시도/);   // 방이 "기억 없이 진행합니다."를 이어 붙인다
    // 꺼진 서버를 만난 recall이 뒤에서 켜 보려 한 흐름이 끝나기를 기다린다(명령이 없으면 그대로 꺼짐).
    if (c.kind === "off") await client.ensureStarted();
    const status = client.status();
    assert.equal(status.state, c.kind === "off" ? "off" : "error");
    if (c.kind !== "off") assert.equal(status.reason, result.reason);
    assert.equal(logLines().at(-1).errorKind, c.kind);
    assert.equal(logLines().at(-1).returned, 0);
    assert.equal(JSON.stringify([statuses, logLines()]).includes(TEST_KEY), false);
    if (c.kind === "auth") assert.match(result.reason, /접속 키/);
    if (c.noRequest) assert.equal(fake.calls.length, 0);
  });
}

test("도구가 isError로 실패해도 recall은 거절하지 않고, 연결 상태는 그대로다", async (t) => {
  const fake = await startFakeAnchorMind(t, { tools: { recall: () => ({ success: false, error: "Internal error" }) } });
  const { client, logLines } = createTestAnchorMind(t, fake);
  const result = await client.recall(ask);
  assert.equal(result.block, "");
  assert.match(result.reason, /처리하지 못했습니다/);
  assert.equal(client.status().state, "connected");
  assert.equal(client.status().reason, null);
  assert.equal(logLines().at(-1).errorKind, "other");
});

test("세션을 잃으면 읽기는 initialize부터 한 번만 다시 하고, 쓰기는 다시 보내지 않는다", async (t) => {
  const lost = { recall: 0, remember: 0 };
  const gone = { status: 404, body: { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Session not found" } } };
  const fake = await startFakeAnchorMind(t, {
    tools: { recall: () => supported([memoryFragment(ws)]), remember: () => ({ success: true, id: "new-1" }) },
    intercept: (call) => {
      if (call.tool === "recall" && lost.recall++ === 0) return gone;
      if (call.tool === "remember" && lost.remember++ === 0) return gone;
      return false;
    },
  });
  const { client } = createTestAnchorMind(t, fake);
  const result = await client.recall(ask);
  assert.notEqual(result.block, "");
  assert.equal(result.reason, null);
  assert.equal(fake.calls.filter((call) => call.method === "initialize").length, 2);
  assert.equal(fake.toolCalls("recall").length, 2);
  await assert.rejects(client.remember("p1", { type: "fact", content: "배포는 별도 승인 뒤에만 한다" }),
    (error) => /연결이 끊겼습니다/.test(error.message) && !/다시 시도/.test(error.message));
  assert.equal(fake.toolCalls("remember").length, 1);
});

test("꺼진 서버를 만나면 켜기 명령을 뒤에서 한 번만 실행하고, 켜는 동안의 차례는 서버에 묻지 않는다", async (t) => {
  const clock = fakeClock(); const spawned = []; let requests = 0;
  const fake = await startFakeAnchorMind(t);
  const { client } = createTestAnchorMind(t, fake, {
    anchorMind: { startCommand: "start-anchormind", stopCommand: "stop-anchormind" },
    request: () => { requests += 1; return refusingRequest(); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    spawn: (command) => { spawned.push(command); return new EventEmitter(); },   // 끝나지 않는 켜기
  });
  const results = await Promise.all([client.recall({ projectId: "p1", text: "배포는 언제 해도 돼?" }),
    client.recall({ projectId: "p1", text: "커밋 규칙이 뭐였지?" })]);
  for (const r of results) assert.match(r.reason, /꺼져 있거나/);
  await waitFor(() => spawned.length > 0);
  assert.deepEqual(spawned, ["start-anchormind"]);
  assert.equal(client.status().state, "starting");
  const before = requests;
  assert.match((await client.recall({ projectId: "p1", text: "세 번째 질문입니다" })).reason, /꺼져 있거나/);
  assert.equal(requests, before);
  assert.deepEqual(spawned, ["start-anchormind"]);
});

test("ensureStarted는 이미 켜진 서버면 켜기 명령 없이 연결만 한다", async (t) => {
  const fake = await startFakeAnchorMind(t);
  const { client } = createTestAnchorMind(t, fake, { onStatus: () => { throw new Error("창이 닫혔습니다"); } });
  await client.ensureStarted();
  assert.equal(client.status().state, "connected");
  assert.equal(client.status().enabled, true);
  assert.deepEqual(fake.calls.map((call) => call.path), ["/health", "/mcp"]);
  assert.equal(fake.calls[1].method, "initialize");
  assert.equal(fake.calls[0].headers.authorization, undefined);   // 건강 확인은 접속 키 없이 보낸다(그 포트를 다른 프로그램이 쓸 수 있다)
  await client.ensureStarted();
  assert.deepEqual(fake.calls.map((call) => call.path), ["/health", "/mcp", "/health"]);
});

test("/health가 200이 아니거나 접속 키를 읽지 못하면 서버를 켜지 않고 오류로 둔다", async (t) => {
  const spawned = [];
  const fake = await startFakeAnchorMind(t, { intercept: (call) => call.path === "/health" && { status: 503, body: { status: "unhealthy" } } });
  const { client } = createTestAnchorMind(t, fake, {
    anchorMind: { startCommand: "start-anchormind", stopCommand: "stop-anchormind" },
    spawn: (command) => { spawned.push(command); const child = new EventEmitter(); process.nextTick(() => child.emit("exit", 1, null)); return child; },
  });
  await client.ensureStarted();
  assert.deepEqual(spawned, []);
  assert.equal(client.status().state, "error");
  assert.match(client.status().reason, /켜지 못했/);
  assert.deepEqual(fake.calls.map((call) => call.path), ["/health"]);
  // 접속 키를 읽지 못하면 켜 봐야 소용없다: 켜지도, 서버에 묻지도 않는다.
  writeEnv(fake.folder, { port: fake.port, key: "" });
  await client.ensureStarted();
  assert.deepEqual(spawned, []);
  assert.match(client.status().reason, /접속 키/);
  assert.equal(fake.calls.length, 1);
});

test("remember는 공간·주제를 늘 넣고 본문 규칙에 맞춰 보낸다", async (t) => {
  const fake = await startFakeAnchorMind(t, {
    tools: { remember: (args) => (args.content.startsWith("거절") ? { success: false, error: "Rejected" } : { success: true, id: "new-1" }) },
  });
  const { client } = createTestAnchorMind(t, fake);
  // 검증에 걸리면 요청도, 서버 확인도 없다.
  await assert.rejects(client.remember("p1", { type: "fact", content: "짧다" }), /10자 이상/);
  await assert.rejects(client.remember("p1", { type: "relation", content: "관계 기억입니다만" }), /유형/);
  await assert.rejects(client.remember("p1", { type: ["fact"], content: "관계 기억입니다만" }), /유형/);
  await assert.rejects(client.remember("../x", { type: "fact", content: "관계 기억입니다만" }), /프로젝트/);
  assert.equal(fake.calls.length, 0);
  // 연결이 없으면 보내기 전에 서버부터 확인한다.
  await client.remember("p1", { type: "decision", content: "  배포는 별도 승인 뒤에만 한다  " });
  assert.deepEqual(fake.calls.map((call) => call.path), ["/health", "/mcp", "/mcp"]);
  assert.deepEqual(fake.toolCalls("remember")[0].args, { content: "배포는 별도 승인 뒤에만 한다", topic: ws, type: "decision", workspace: ws });
  await client.remember("p1", { type: "episode", content: "가".repeat(5000), idempotencyKey: "rec-1" });
  const sent = fake.toolCalls("remember")[1].args;
  assert.equal(sent.content.length, 4000);
  assert.equal(sent.idempotencyKey, "rec-1");
  assert.equal(sent.type, "episode");
  assert.equal(Object.hasOwn(sent, "origin"), false);
  assert.equal(Object.hasOwn(sent, "assertionStatus"), false);
  // 10자 미만이어도 세 어절이면 받는다.
  await client.remember("p1", { type: "fact", content: "짧은 세 낱말" });
  assert.equal(fake.toolCalls("remember").length, 3);
  await assert.rejects(client.remember("p1", { type: "fact", content: "거절당하는 기억입니다" }), /처리하지 못했습니다/);
  assert.equal(client.status().state, "connected");
});

test("목록은 같은 주제만 보여 주고, 지우기·고치기는 그 프로젝트 목록에 나온 id만 받는다", async (t) => {
  const trace = (id, topic, type = "fact") => ({ id, topic, type, content: `기억 ${id} 내용입니다.`, created_at: "2026-10-24T12:00:00.000Z" });
  const fake = await startFakeAnchorMind(t, {
    tools: {
      search_traces: () => ({ success: true, traces: [
        trace("a", ws), trace("b", "agora-p10"), trace("c", "general"), trace("d", ws, "episode"),
        { ...trace("e", ws), type: { valueOf: 1, toString: 2 }, created_at: [{ valueOf: 1, toString: 2 }] },
      ] }),
      forget: () => ({ success: true, deleted: 0, protected: 0 }),
      amend: () => ({ success: true, updated: true }),
    },
  });
  const { client } = createTestAnchorMind(t, fake);
  assert.deepEqual(await client.list("p1"), [
    { id: "a", type: "fact", content: "기억 a 내용입니다.", createdAt: "2026-10-24T12:00:00.000Z" },
    { id: "d", type: "episode", content: "기억 d 내용입니다.", createdAt: "2026-10-24T12:00:00.000Z" },
    // 서버가 type·created_at에 글이 아닌 값을 줘도 목록은 거절하지 않고 그 두 칸만 비워 화면이 멈추지 않게 한다.
    { id: "e", type: "", content: "기억 e 내용입니다.", createdAt: "" },
  ]);
  assert.deepEqual(fake.toolCalls("search_traces")[0].args, { workspace: ws, entity_key: ws, limit: 100 });
  await assert.rejects(client.forget("p1", "b"), /목록에 없는/);
  await assert.rejects(client.forget("p2", "a"), /목록에 없는/);
  assert.equal(fake.toolCalls("forget").length, 0);
  await client.forget("p1", "a");
  assert.deepEqual(fake.toolCalls("forget")[0].args, { id: "a", force: true });
  await client.amend("p1", "a", { type: "preference", content: "고친 내용은 열 자를 넘깁니다" });
  assert.deepEqual(fake.toolCalls("amend")[0].args, { id: "a", content: "고친 내용은 열 자를 넘깁니다", type: "preference" });
  await assert.rejects(client.amend("p1", "zz", { type: "fact", content: "고친 내용은 열 자를 넘깁니다" }), /목록에 없는/);
  assert.equal(fake.toolCalls("amend").length, 1);
});

test("check는 /health와 initialize만 보내고 버전 차이와 001 종료 경고를 알린다", async (t) => {
  const old = await startFakeAnchorMind(t, { version: "6.8.0" });
  const a = createTestAnchorMind(t, old, { now: () => Date.parse("2028-02-13T12:00:00Z") });
  const checked = await a.client.check();
  assert.equal(checked.state, "connected");
  assert.equal(checked.serverVersion, "6.8.0");
  assert.match(checked.versionWarning, /6\.7\.1[\s\S]*6\.8\.0/);
  assert.equal(checked.deprecationWarning, null);
  assert.deepEqual(old.calls.map((call) => [call.path, call.method]), [["/health", null], ["/mcp", "initialize"]]);
  for (let i = 1; i < a.statuses.length; i += 1) assert.notDeepEqual(a.statuses[i], a.statuses[i - 1]);
  // 다시 확인하면 지난 연결을 쓰지 않고 /health와 initialize부터 다시 한다(폴더·포트·키가 바뀌었을 수 있다).
  await a.client.check();
  assert.deepEqual(old.calls.map((call) => [call.path, call.method]), [["/health", null], ["/mcp", "initialize"], ["/health", null], ["/mcp", "initialize"]]);
  // 전역 설정을 끄면 지난 연결에서 알게 된 버전·경고도 보이지 않는다.
  a.settings().anchorMind.enabled = false;
  assert.deepEqual(a.client.status(), { enabled: false, state: "off", reason: null, serverVersion: null, versionWarning: null, deprecationWarning: null });

  const current = await startFakeAnchorMind(t);
  const b = createTestAnchorMind(t, current, { now: () => Date.parse("2028-02-14T12:00:00Z") });
  const warned = await b.client.check();
  assert.equal(warned.versionWarning, null);
  assert.match(warned.deprecationWarning, /2028-05-14/);

  const down = await startFakeAnchorMind(t, { intercept: (call) => call.path === "/health" && { status: 503, body: {} } });
  const c = createTestAnchorMind(t, down);
  const failed = await c.client.check();
  assert.equal(failed.state, "error");
  assert.match(failed.reason, /처리하지 못했습니다/);
  assert.equal(down.calls.filter((call) => call.method === "initialize").length, 0);

  const long = await startFakeAnchorMind(t, { version: "9".repeat(60) });
  const d = createTestAnchorMind(t, long);
  assert.equal((await d.client.check()).serverVersion, "9".repeat(40));

  const refused = await startFakeAnchorMind(t);
  const e = createTestAnchorMind(t, refused, { request: refusingRequest });
  const off = await e.client.check();
  assert.equal(off.state, "off");
  assert.equal(off.reason, null);
});

test("recall 실행 기록은 내용 없이 남고 2MiB를 넘으면 한 번 돌린다", async (t) => {
  let evidence = "supported";
  const fake = await startFakeAnchorMind(t, {
    tools: { recall: () => ({ success: true, fragments: [memoryFragment(ws, { content: "비밀 기억 내용입니다" })], _meta: { evidence: { status: evidence } } }) },
  });
  const { client, logFile, logLines } = createTestAnchorMind(t, fake);
  await client.recall({ projectId: "p1", text: "비밀 질문 내용입니다" });
  const line = logLines()[0];
  assert.deepEqual(Object.keys(line).sort(), ["errorKind", "evidenceStatus", "kept", "latencyMs", "projectId", "returned", "scores", "serverVersion", "threshold", "ts", "v"]);
  assert.equal(line.v, 1);
  assert.equal(line.projectId, "p1");
  assert.equal(line.returned, 1);
  assert.equal(line.kept, 1);
  assert.deepEqual(line.scores, [0.95]);
  assert.equal(line.serverVersion, "6.7.1");
  assert.equal(typeof line.threshold, "number");
  assert.equal(line.evidenceStatus, "supported");
  evidence = "한 줄 끼워 넣은 글";   // 서버가 준 모르는 글은 기록에 남기지 않는다
  await client.recall(ask);
  assert.equal(logLines().at(-1).evidenceStatus, null);
  const text = fs.readFileSync(logFile, "utf8");
  assert.equal(text.includes("비밀"), false);
  assert.equal(text.includes(TEST_KEY), false);
  fs.writeFileSync(logFile, "x".repeat(2 * 1024 * 1024));
  await client.recall(ask);
  assert.equal(fs.existsSync(`${logFile}.1`), true);
  assert.equal(logLines().length, 1);
});

test("유휴로 끄기 직전 정리는 마지막 정리 뒤 하루가 지났을 때만 부르고 설정은 통째로 저장한다", async (t) => {
  const clock = fakeClock(); let down = true; let consolidated = { success: true }; const spawned = [];
  const fake = await startFakeAnchorMind(t, { tools: { memory_consolidate: () => consolidated } });
  const { client, settings } = createTestAnchorMind(t, fake, {
    anchorMind: { startCommand: "start-anchormind", stopCommand: "stop-anchormind", lastConsolidateAt: { valueOf: 1, toString: 2 } },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    request: (url, options, callback) => (down ? refusingRequest() : http.request(url, options, callback)),
    spawn: (command) => { spawned.push(command); down = command === "stop-anchormind";
      const child = new EventEmitter(); process.nextTick(() => child.emit("exit", 0, null)); return child; },
  });
  assert.equal(client.status().enabled, true);   // 손으로 고친 정리 시각(숫자가 아님)은 상태 조회를 죽이지 않고 0(정리한 적 없음)으로 읽혀, 첫 유휴 끄기에서 정리한다
  const stops = () => spawned.filter((c) => c === "stop-anchormind").length;
  const connect = async () => {
    const started = client.ensureStarted();
    await advanceUntil(clock, () => client.status().state === "connected"); await started;
  };
  await connect();
  clock.advance(25 * 60 * 1000); await client.recall(ask);   // 기억을 쓰면 유휴 시계가 다시 시작된다
  clock.advance(25 * 60 * 1000); await new Promise((resolve) => setTimeout(resolve, 50));   // 마지막 사용 25분 뒤: 아직 끄지 않는다
  assert.equal(stops(), 0);
  const cycle = async (beforeIdle) => {
    await connect();
    if (beforeIdle) beforeIdle();
    const before = stops(); clock.advance(30 * 60 * 1000); await waitFor(() => stops() === before + 1);
  };
  await cycle();
  assert.equal(fake.toolCalls("memory_consolidate").length, 1);
  assert.deepEqual(fake.toolCalls("memory_consolidate")[0].args, {});
  assert.deepEqual(settings().anchorMind, { enabled: true, folder: fake.folder, startCommand: "start-anchormind",
    stopCommand: "stop-anchormind", lastConsolidateAt: clock.now() });
  await cycle();   // 하루가 지나지 않았다
  assert.equal(fake.toolCalls("memory_consolidate").length, 1);
  clock.advance(24 * 60 * 60 * 1000);
  const lastAt = settings().anchorMind.lastConsolidateAt;
  consolidated = { success: false, error: "x" };
  await cycle();   // 정리에 실패하면 마지막 정리 시각을 옮기지 않는다(다음 유휴 끄기에서 다시 부른다)
  assert.equal(fake.toolCalls("memory_consolidate").length, 2);
  assert.equal(settings().anchorMind.lastConsolidateAt, lastAt);
  await cycle(() => { settings().anchorMind.enabled = false; });   // 하루가 지났어도 애드온을 끈 뒤에는 정리하지 않는다
  assert.equal(fake.toolCalls("memory_consolidate").length, 2);
});

test("연결을 든 채 서버가 죽었다가 방 열기로 다시 켜지면 상태가 starting에 남지 않고 recall이 서버에 닿는다", async (t) => {
  let dead = false;
  const clock = fakeClock();
  const fake = await startFakeAnchorMind(t, { tools: { recall: (args) => supported([memoryFragment(args.workspace)]) } });
  const { client } = createTestAnchorMind(t, fake, {
    anchorMind: { startCommand: "start-anchormind", stopCommand: "stop-anchormind" },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    request: (url, options, callback) => (dead ? refusingRequest() : http.request(url, options, callback)),
    spawn: () => { dead = false; return Object.assign(new EventEmitter(), { exitCode: null, kill() {} }); },   // 켜기 명령이 서버를 살린다
  });
  assert.equal((await client.recall(ask)).reason, null);   // 연결을 만든다
  dead = true;                                             // 서버가 죽는다: 아직 실패한 호출은 없다
  let done = false;
  const warm = client.ensureStarted().then(() => { done = true; });
  await advanceUntil(clock, () => done);                   // /health가 두 번 잇달아 응답하면 켜기가 끝난다
  await warm;
  assert.equal(client.status().state, "connected");
  const before = fake.toolCalls("recall").length;
  assert.equal((await client.recall(ask)).reason, null);
  assert.equal(fake.toolCalls("recall").length, before + 1);
});

test("폴더를 바꿔 적용하면 바뀐 폴더의 서버를 쓴다", async (t) => {
  const tools = { remember: () => ({ success: true }) };
  const a = await startFakeAnchorMind(t, { tools });
  const b = await startFakeAnchorMind(t, { tools });
  const { client, settings } = createTestAnchorMind(t, a);
  await client.remember("p1", { type: "fact", content: "서버 A에 저장하는 기억입니다" });
  // 이미 맺은 연결은 옛 서버의 것이다. 설정을 바꿔 적용하면 쓸 때마다 읽는 .env가 가리키는 서버로 새로 연결한다.
  settings().anchorMind.folder = b.folder;
  await client.remember("p1", { type: "fact", content: "서버 B에 저장하는 기억입니다" });
  assert.deepEqual([a.toolCalls("remember").length, b.toolCalls("remember").length], [1, 1]);
  // 접속 키를 읽지 못하면 옛 연결을 그대로 쓰지 않고 오류로 둔다.
  fs.rmSync(`${b.folder}/.env`);
  await assert.rejects(client.remember("p1", { type: "fact", content: "서버 B에 다시 저장하는 기억입니다" }), /접속 키/);
  assert.equal(client.status().state, "error");
  assert.equal(b.toolCalls("remember").length, 1);
});
