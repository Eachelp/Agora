"use strict";

// AnchorMind 애드온 시험 공용 도구. 클라이언트 시험과 IPC 끝-대-끝 시험이 이 파일 하나를 같이 쓴다.
// 실제 AnchorMind(127.0.0.1:57332)와 실제 .env는 절대 쓰지 않는다: 실제 서버는 Gemini 임베딩을 불러 사용자 돈이 든다.
// 가짜 서버는 포트 0에, AnchorMind 폴더(.env)는 임시 폴더에 둔다. node --test가 test/ 아래 파일을 모두 실행하므로
// 불러오기만 해서는 아무 일도 하지 않는다.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAnchorMind } = require("../src/agora/anchormind-client");

const TEST_KEY = "agora-test-access-key";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// model을 ""로 주면 EMBEDDING_MODEL 줄을 뺀다(AnchorMind는 공급자 기본 모델을 쓴다). provider를 주면 EMBEDDING_PROVIDER 줄을 넣는다.
function writeEnv(folder, { port, key = TEST_KEY, model = "gemini-embedding-001", provider = "" }) {
  const lines = [`PORT=${port}`, `MEMENTO_ACCESS_KEY=${key}`];
  if (model) lines.push(`EMBEDDING_MODEL=${model}`);
  if (provider) lines.push(`EMBEDDING_PROVIDER=${provider}`);
  fs.writeFileSync(path.join(folder, ".env"), `${lines.join("\n")}\n`, "utf8");
}

// 가짜 AnchorMind(6.7.1의 /health·/mcp 응답 모양). tools: { 도구 이름: (args) => 도구 결과 }.
// intercept(call)이 { status, body?, headers? }를 돌려주면 그대로 답하고 "hang"이면 답하지 않는다(시간 초과 시험).
async function startFakeAnchorMind(t, { version = "6.7.1", model, provider, tools = {}, intercept } = {}) {
  const calls = [];
  let sessions = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const reply = (status, body, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      let message = null;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const call = {
        path: req.url, method: message?.method ?? null, tool: message?.params?.name ?? null,
        args: message?.params?.arguments ?? null, params: message?.params ?? null, headers: req.headers,
      };
      calls.push(call);
      const override = intercept?.(call);
      if (override === "hang") return;
      if (override) return reply(override.status, override.body, override.headers);
      if (req.url === "/health") return reply(200, { status: "healthy" });
      const rpcError = (status, text) => reply(status, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32000, message: text } });
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return rpcError(401, "Invalid or missing access key");
      if (call.method === "initialize") {
        sessions += 1;
        return reply(200, {
          jsonrpc: "2.0", id: message.id,
          result: { protocolVersion: message.params?.protocolVersion, capabilities: {}, serverInfo: { name: "anchormind-server", version } },
        }, { "MCP-Session-Id": `fake-session-${sessions}` });
      }
      if (!req.headers["mcp-session-id"]) return rpcError(400, "Session required");
      const result = tools[call.tool]?.(call.args ?? {}) ?? { success: false, error: `unknown tool ${call.tool}` };
      const isError = result.success === false || result.error != null;
      return reply(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const folder = tempDir(t, "agora-anchormind-");
  writeEnv(folder, { port: server.address().port, model, provider });
  return { folder, port: server.address().port, calls, toolCalls: (name) => calls.filter((call) => call.tool === name) };
}

// 시험용 클라이언트. 설정은 메모리에만 두고(실제 settings.json 아님) 실행 기록은 임시 폴더에 쓴다. 켜기·끄기 명령이
// 실제로 돌면 안 되므로 기본 spawn·spawnSync는 던진다(켜고 끄기를 보는 시험만 가짜를 넘긴다).
function createTestAnchorMind(t, fake, { anchorMind = {}, ...deps } = {}) {
  let saved = { anchorMind: { enabled: true, folder: fake.folder, startCommand: "", stopCommand: "", lastConsolidateAt: 0, ...anchorMind } };
  const statuses = [];
  const storeRoot = tempDir(t, "agora-store-");
  const forbidden = () => { throw new Error("시험에서 AnchorMind 켜기·끄기 명령을 실행하면 안 됩니다."); };
  const client = createAnchorMind({
    getSettings: () => saved,
    saveSettings: (patch) => { saved = { ...saved, ...patch }; },   // settings-file.js처럼 한 단계 얕은 병합
    storeRoot,
    onStatus: (status) => statuses.push(status),
    spawn: forbidden,
    spawnSync: forbidden,
    ...deps,
  });
  const logFile = path.join(storeRoot, "anchormind", "recall-log.jsonl");
  const logLines = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { client, statuses, logFile, logLines, settings: () => saved };
}

// recall 응답 조각 하나. 기본값은 Agora 거르기를 통과한다(같은 공간, 높은 유사도).
function memoryFragment(workspace, overrides = {}) {
  return {
    id: "frag-1", content: "회의록은 결정 사항과 담당자를 맨 위에 적는다.", topic: workspace, type: "decision",
    importance: 0.8, created_at: "2026-10-24T12:00:00.000Z", age_days: 0, access_count: 0, confidence: 0.5,
    linked: [], similarity: 0.95, workspace, ...overrides,
  };
}

// 꺼진 서버(연결 거부)를 바로 흉내 내는 http.request 대역. 닫힌 포트는 Windows에서 거부까지 1~2초 걸리고 다른 시험이 다시 쓸 수 있다.
function refusingRequest() {
  const request = new EventEmitter();
  request.end = () => process.nextTick(() => request.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
  return request;
}

// 가짜 시계를 조금씩 돌리며 실제 HTTP(가짜 서버)가 끝나기를 기다린다. 켜기 대기·유휴 타이머는 가짜 시계로 돈다.
async function advanceUntil(clock, condition, stepMs = 1000, limit = 50) {
  for (let i = 0; i < limit && !condition(); i += 1) {
    clock.advance(stepMs);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error("가짜 시계를 돌려도 조건이 채워지지 않았습니다.");
}

module.exports = { TEST_KEY, startFakeAnchorMind, createTestAnchorMind, memoryFragment, writeEnv, refusingRequest, advanceUntil };
