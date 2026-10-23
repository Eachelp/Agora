"use strict";

// AnchorMind 기억 애드온의 연결 쪽 전부: .env 읽기, /mcp 호출과 실패 분류, 연결 상태, 기억 거르기와
// 프롬프트 항목 만들기, recall 실행 기록. 바깥에는 createAnchorMind 하나만 내놓는다. main.js가 하나 만들고
// chat-ipc는 options.anchorMind로만 받는다. 넘기지 않으면(기존 시험 전부) 애드온은 완전히 꺼진다.
//
// AnchorMind는 따로 설치해 연결해서 쓰는 외부 서비스다(6.7.1에서 시험). 공개 접점(/health와 /mcp 도구)에만
// 기대고, 응답은 모양이 바뀌어도 깨지지 않게 읽으며, 모르는 응답이면 기억 없이 진행한다.
// 접속 키(MEMENTO_ACCESS_KEY)는 AnchorMind 폴더의 .env에서 필요할 때 읽고 파일·상태·기록·오류 글에 남기지 않는다.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const util = require("node:util");
const { validProjectId } = require("./memory-store");
const { createAnchorMindProcess } = require("./anchormind-process");

// 바꿀 일 없는 값은 설정이 아니라 상수다. 방이 기다리는 3초만 chat-room.js의 다른 상한 옆에 둔다.
const QUERY_CHARS = 1000;                        // recall 질의(사용자 메시지) 상한
const TOKEN_BUDGET = 1500;                       // AnchorMind가 고르는 기억 본문의 토큰 합계
const PAGE_SIZE = 10;
const BLOCK_CHARS = 2500;                        // 항목 합계 상한. AGY는 프롬프트를 명령줄로 받아 24,576자에서 자른다
const CONSOLIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;            // Gemini가 걸리면 AnchorMind가 임베딩을 8초까지 붙든다
const HEALTH_TIMEOUT_MS = 2 * 1000;              // 켜지는 동안 되풀이해 묻는 생존 확인
const CONSOLIDATE_TIMEOUT_MS = 10 * 60 * 1000;   // memory_consolidate는 끝날 때까지 답하지 않는다(서버 쪽 상한 없음)
const TESTED_VERSION = "6.7.1";
const GEMINI_001 = "gemini-embedding-001";
const GEMINI_001_WARN_FROM = Date.parse("2028-02-14");   // 종료(2028-05-14) 석 달 전
// 관련 기억으로 볼 코사인 유사도 하한. 점수 범위가 모델마다 달라 모델별로 둔다. 모르는 모델이면 Agora 문턱값이 없다.
// 실제 연결 1(2026-10-24, 3,072차원)에서 잰 값: 관련 최저 0.719와 엇갈린 기억·무관 질문 최고 0.638의 가운데(ops\rc1-result.json summary.threshold). 모델이 바뀌면 다시 잰다.
const THRESHOLDS = { [GEMINI_001]: 0.679 };
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PORT = 57332;                      // .env에 PORT가 없을 때의 AnchorMind 기본값
const PROTOCOL_VERSION = "2025-06-18";
const LIST_LIMIT = 100;                          // search_traces 최대
const EVIDENCE_STATUSES = ["no_evidence", "conflicting", "partial", "supported"];   // recall 응답의 근거 상태. 서버가 준 글이라 이 넷만 기록에 남긴다
const VERSION_CHARS = 40;                        // 서버가 알린 버전 글자 상한(상태·경고·기록에 그대로 들어간다)
// AnchorMind는 10자 미만이면서 3어절 미만인 본문을 거부하고 4,000자를 넘는 입력은 받지 않는다. 저장할 때는 300자
// (요약 episode는 1,000자)에서 잘라 "..."을 붙인다(amend도 같다, WriteGate.lengthStep). 사람이 쓰는 칸은 화면이 300자로 막는다.
const MIN_CONTENT_CHARS = 10;
const MIN_CONTENT_WORDS = 3;
const MAX_INPUT_CHARS = 4000;
// Agora가 저장하는 유형: 사람이 고르는 다섯 가지와 기록관 요약(episode). 값은 프롬프트 항목의 꼬리표이고, 요약은 검토 전 초안임을 드러낸다.
const TYPE_LABELS = {
  fact: "사실", decision: "결정", procedure: "절차", error: "에러", preference: "선호", episode: "기록관 요약 초안(검증 전)",
};
// 400은 세션 없이 보낸 요청(Session required)이다. 프로토콜 버전 같은 다른 400은 이 클라이언트가 만들지 않는다.
const HTTP_FAILURES = { 400: "session", 401: "auth", 403: "auth", 404: "session", 429: "rate-limit" };
// 실패 종류(실행 기록의 errorKind) → 사람이 읽는 이유(상태·방 안내·오류 글). Gemini의 429·503은 AnchorMind가
// 삼켜 빈 검색 결과로만 오므로 따로 없다. start는 켜기 모듈이 알리는 오류의 이유다. 방 안내가 "기억 없이 진행합니다."를
// 붙이므로 session·rate-limit 문장에는 "다시 시도"를 넣지 않는다.
const REASONS = {
  off: "AnchorMind가 꺼져 있거나 아직 켜지는 중입니다.",
  start: "AnchorMind를 켜지 못했거나 서버가 정상 상태가 아닙니다. 설정의 켜기 명령과 AnchorMind 폴더를 확인해 주세요.",
  timeout: "AnchorMind가 제때 답하지 않았습니다.",
  auth: "AnchorMind 접속 키를 읽지 못했거나 키가 맞지 않습니다. 설정의 AnchorMind 폴더와 그 폴더의 .env를 확인해 주세요.",
  session: "AnchorMind 연결이 끊겼습니다.",
  "rate-limit": "AnchorMind 요청 한도를 넘었습니다.",
  other: "AnchorMind가 요청을 처리하지 못했습니다.",
};
const DEPRECATION_WARNING = "AnchorMind가 쓰는 Google 임베딩 모델 gemini-embedding-001은 2028-05-14에 종료됩니다. 그 전에 다른 모델로 옮겨야 합니다.";

const failure = (kind) => Object.assign(new Error(REASONS[kind]), { kind });
const reasonOf = (error) => REASONS[error?.kind] || REASONS.other;
// 실패한 호출이 남기는 상태. 거부된 연결은 오류가 아니라 꺼짐이다.
const failedStatus = (error) => (error?.kind === "off" ? { state: "off", reason: null } : { state: "error", reason: reasonOf(error) });
const pad = (n) => String(n).padStart(2, "0");

// 공간·주제 이름은 프로젝트마다 "agora-<프로젝트 id>" 하나다.
function workspaceFor(projectId) {
  const id = validProjectId(projectId);
  if (!id) throw new Error("프로젝트를 찾을 수 없습니다.");
  return `agora-${id}`;
}

function memoryContent(type, content) {
  if (typeof type !== "string" || !Object.hasOwn(TYPE_LABELS, type)) throw new Error("기억 유형이 올바르지 않습니다.");
  const text = String(content ?? "").trim();
  if (text.length < MIN_CONTENT_CHARS && text.split(/\s+/).length < MIN_CONTENT_WORDS) {
    throw new Error(`기억할 내용이 너무 짧습니다. ${MIN_CONTENT_CHARS}자 이상이거나 ${MIN_CONTENT_WORDS}어절 이상이어야 합니다.`);
  }
  return text.slice(0, MAX_INPUT_CHARS);
}

// 넣을 기억만 고른다(거르기는 여기 한곳). 의미 검색으로 찾은 것(similarity가 있는 것)만 믿는다: 키워드로만 찾은
// 조각은 관련 여부를 점수로 가를 수 없다. 서버에 threshold 인자는 보내지 않는다(similarity 없는 조각을 남긴다).
// 전역 기억(공간 없음)은 다른 프로젝트 것일 수 있고, 검토 대기·대체된 기억은 믿을 수 없어 뺀다.
function relevant(fragments, workspace, evidenceStatus, threshold) {
  // 6.7.1에서는 결과가 비었을 때만 no_evidence다. 모양이 바뀌어도 "근거 없음"이면 넣지 않는다.
  if (evidenceStatus === "no_evidence") return [];
  return fragments.filter((f) => typeof f?.content === "string" && typeof f.similarity === "number"
    && (threshold === null || f.similarity >= threshold) && f.workspace === workspace
    && f.pending_review !== true && f.low_trust !== true && f.state !== "superseded");
}

// 프롬프트에 넣을 항목 줄("- [결정] 내용 (2026-10-24)"). 머리말·꼬리말은 chat-prompt.js가 붙인다. 공백과 제어 문자를
// 한 칸으로 줄여 한 줄로 만들고 "===" 구획 표지를 흉내 내지 못하게 무력화한다. 합계가 2,500자를 넘으면 순위가 낮은 항목부터 통째로 버린다.
function renderBlock(fragments) {
  const lines = [];
  let used = 0;
  for (const f of fragments) {
    const date = new Date(String(f.created_at));
    const day = Number.isNaN(date.getTime()) ? "" : ` (${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())})`;
    const label = Object.hasOwn(TYPE_LABELS, f.type) ? TYPE_LABELS[f.type] : "기억";
    const line = `- [${label}] ${f.content.replace(/[\s\p{Cc}]+/gu, " ").trim().replace(/={3,}/g, "==")}${day}`;
    used += line.length + (lines.length > 0 ? 1 : 0);
    if (used > BLOCK_CHARS) break;
    lines.push(line);
  }
  return lines.join("\n");
}

// 문턱값 보정용 실행 기록. 질의·기억 내용은 넣지 않는다. 2MiB를 넘으면 .1로 한 번 돌린다(합계 약 4MiB).
function appendRecallLog(storeRoot, record) {
  try {
    const file = path.join(storeRoot, "anchormind", "recall-log.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // 기록을 못 남겨도 대화는 이어 간다.
  }
}

function createAnchorMind({
  getSettings, saveSettings, storeRoot, onStatus = () => {},
  // 시험 주입. 시계·타이머·프로세스는 anchormind-process.js로 그대로 넘긴다.
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, spawn, spawnSync,
  request = http.request, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let current = { state: "off", reason: null, serverVersion: null, versionWarning: null, deprecationWarning: null };
  let conn = null;          // initialize를 마친 연결. 요청이 실패하면 비워 다음 호출이 .env부터 다시 읽게 한다
  let connecting = null;    // initialize를 하나로 묶는다(분당 30회 한도에 initialize도 센다)
  let starting = null;
  let threshold = null;     // 연결한 서버의 임베딩 모델(.env)에 맞는 문턱값
  let rpcId = 0;
  const listed = new Map(); // 공간 이름 → 마지막 목록에 나온 기억 id
  const proc = createAnchorMindProcess({
    healthy, beforeIdleStop: consolidateIfDue,
    onState: (state) => {
      if (state === "off") conn = null;   // 서버가 꺼졌다(유휴로 껐거나 켤 수 없다). 다시 켜면 initialize부터 한다
      setStatus({ state, reason: state === "error" ? REASONS.start : null });
    },
    now, setTimer, clearTimer, spawn, spawnSync,
  });

  // settings.json의 anchorMind. 사람이 고칠 수 있는 파일이라 읽을 때마다 모양을 맞춘다.
  function settings() {
    const saved = getSettings()?.anchorMind;
    const value = saved && typeof saved === "object" ? saved : {};
    const text = (field) => (typeof value[field] === "string" ? value[field].trim() : "");
    return {
      enabled: value.enabled === true,
      folder: text("folder"),
      startCommand: text("startCommand"),
      stopCommand: text("stopCommand"),
      lastConsolidateAt: Number(value.lastConsolidateAt) || 0,
    };
  }

  // 캐시만 돌려준다(네트워크 없음). enabled는 매번 설정에서 읽고, 전역 설정을 끄면 바로 "off"로 보이며 지난 연결의 버전·경고도 비운다.
  function status() {
    const { enabled } = settings();
    return enabled ? { enabled, ...current } : { enabled, state: "off", reason: null, serverVersion: null, versionWarning: null, deprecationWarning: null };
  }

  // 바뀐 때만 알린다. 그러지 않으면 recall마다 같은 상태가 창으로 간다.
  function setStatus(patch) {
    const next = { ...current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    try {
      onStatus(status());
    } catch {
      // 화면 통지 실패가 상태 갱신이나 켜기 모듈의 흐름을 끊으면 안 된다.
    }
  }

  // 접속 키·포트·임베딩 모델은 필요할 때 .env에서 읽는다. 서버 주소 칸은 없고 늘 루프백이다.
  function readEnv() {
    const { folder } = settings();
    let env = null;
    if (path.isAbsolute(folder)) {
      try {
        env = util.parseEnv(fs.readFileSync(path.join(folder, ".env"), "utf8").replace(/^\uFEFF/, ""));
      } catch {}
    }
    if (!env?.MEMENTO_ACCESS_KEY) throw failure("auth");
    const port = Number(env.PORT);
    return {
      url: `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT}`,
      key: env.MEMENTO_ACCESS_KEY,
      // AnchorMind도 EMBEDDING_MODEL을 비우면 공급자의 기본 모델을 쓴다(gemini는 gemini-embedding-001).
      model: env.EMBEDDING_MODEL || (String(env.EMBEDDING_PROVIDER || "").toLowerCase() === "gemini" ? GEMINI_001 : ""),
    };
  }

  // HTTP 요청 하나. 기본 연결 설정(agent)은 NODE_USE_ENV_PROXY·HTTP_PROXY 환경에서 루프백 요청과 접속 키까지
  // 프록시로 보내서 새 연결 설정을 쓴다(user-question-mcp.js와 같은 이유). 시간 상한은 본문을 다 받을 때까지다.
  function send(url, { method = "POST", headers = {}, body, ms = timeoutMs } = {}) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const signal = AbortSignal.timeout(ms);
    return new Promise((resolve, reject) => {
      const fail = (error) => reject(failure(signal.aborted ? "timeout" : error?.code === "ECONNREFUSED" ? "off" : "other"));
      const req = request(url, {
        method,
        signal,
        agent: new http.Agent(),
        headers: data ? { ...headers, "Content-Type": "application/json", "Content-Length": data.length } : headers,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8"),
        }));
        response.on("error", fail);
      });
      req.on("error", fail);
      req.end(data || undefined);
    });
  }

  // /mcp에 JSON-RPC 하나. 응답은 늘 JSON 한 덩이다(SSE 아님). 접속 키는 매번 보낸다: Redis 없는 AnchorMind는
  // 다시 켜지면 세션을 잊지만, 키가 맞으면 모르는 세션 id도 같은 id로 되살린다.
  async function rpc(target, method, params, ms) {
    const reply = await send(`${target.url}/mcp`, {
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${target.key}`,
        ...(target.sessionId ? { "MCP-Session-Id": target.sessionId, "MCP-Protocol-Version": target.protocolVersion } : {}),
      },
      body: { jsonrpc: "2.0", id: ++rpcId, method, params },
      ms,
    });
    if (reply.status !== 200) throw failure(HTTP_FAILURES[reply.status] || "other");
    let message = null;
    try { message = JSON.parse(reply.text); } catch {}
    // JSON-RPC 오류(없는 도구 -32601, 권한 -32001, 인자 -32602)는 result 없이 error로 온다.
    if (!message?.result || typeof message.result !== "object") throw failure("other");
    return { headers: reply.headers, result: message.result };
  }

  // 서버와 주고받은 결과를 연결 상태에 반영한다. 실패하면 연결을 비워 다음 호출이 .env부터 다시 읽고 initialize한다.
  async function track(run) {
    try {
      const value = await run();
      setStatus({ state: "connected", reason: null });
      return value;
    } catch (error) {
      conn = null;
      // 켜지는 동안 연결이 거부되는 것은 당연하다. "켜는 중" 표시를 덮지 않는다.
      if (current.state !== "starting" || error.kind !== "off") setStatus(failedStatus(error));
      throw error;
    }
  }

  // initialize. 서버 버전은 이 응답에만 있다(/health에는 없다). 버전이 달라도 막지 않고 경고만 한다.
  function connect() {
    return track(async () => {
      const env = readEnv();
      setStatus({ deprecationWarning: env.model === GEMINI_001 && now() >= GEMINI_001_WARN_FROM ? DEPRECATION_WARNING : null });
      const { headers, result } = await rpc(env, "initialize", {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agora", version: "1.0.0" },
      });
      const sessionId = headers["mcp-session-id"];
      const reported = result.serverInfo?.version;
      if (typeof sessionId !== "string" || !sessionId || typeof reported !== "string") throw failure("other");
      const version = reported.slice(0, VERSION_CHARS);
      threshold = Object.hasOwn(THRESHOLDS, env.model) ? THRESHOLDS[env.model] : null;
      setStatus({
        state: "connected", reason: null, serverVersion: version,
        versionWarning: version === TESTED_VERSION ? null
          : `시험한 AnchorMind는 ${TESTED_VERSION}인데 연결한 서버는 ${version}입니다. 막지는 않지만 기억이 제대로 붙는지 확인해 주세요.`,
      });
      return {
        url: env.url, key: env.key, sessionId,
        // 협상한 버전을 그대로 돌려보낸다(MCP 규약).
        protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION,
      };
    });
  }

  async function connected() {
    if (conn) return conn;
    if (!connecting) connecting = connect().finally(() => { connecting = null; });
    conn = await connecting;
    return conn;
  }

  // 기억 도구 하나. 결과는 늘 content[0].text 안의 JSON이고, 도구 실패도 HTTP 200 + isError로 온다.
  async function callTool(name, args, { retry = false } = {}) {
    proc.touch();
    let result;
    try {
      const target = await connected();
      result = (await track(() => rpc(target, "tools/call", { name, arguments: args }))).result;
    } catch (error) {
      // 세션을 되살리지 못했다(서버가 다른 접속 키로 다시 켜짐 등). 읽기만 initialize부터 한 번 다시 한다.
      if (retry && error.kind === "session") return callTool(name, args);
      throw error;
    }
    let value = null;
    try { value = JSON.parse(result.content[0].text); } catch {}
    if (result.isError === true || !value || typeof value !== "object") throw failure("other");
    return value;
  }

  // 쓰기·목록은 연결이 없으면 서버부터 확인한다(유휴로 끈 서버는 여기서 켠다). 검증은 이 앞에서 끝난다.
  async function callWhenStarted(name, args, options) {
    if (!conn) await ensureStarted();
    return callTool(name, args, options);
  }

  // 방을 열 때(chat-ipc), 꺼진 서버를 만난 recall, 연결이 없는 쓰기·목록이 부른다. 꺼져 있으면 켜기 모듈이 켜기 명령을
  // 실행하고, 서버가 준비되면 연결해 버전을 확인한다. 던지지 않고, 겹쳐 부르면 하나로 묶는다.
  function ensureStarted() {
    if (!settings().enabled) return Promise.resolve();
    if (starting) return starting;
    starting = (async () => {
      readEnv();   // 접속 키를 못 읽으면 켜 봐야 소용없다(AnchorMind도 키 없이는 켜지지 않는다)
      // false면 켜기 모듈이 이미 off·error를 알렸다. 그 상태를 덮지 않는다.
      if (await proc.ensureStarted(settings())) await connected();
    })().catch((error) => {
      setStatus(failedStatus(error));
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  // GET /health(인증 없음)가 200인가. DB가 죽으면 503이다. initialize는 DB 없이도 되므로 따로 본다.
  async function health() {
    const reply = await send(`${readEnv().url}/health`, { method: "GET", ms: HEALTH_TIMEOUT_MS });
    return reply.status === 200;
  }

  // 켜기 모듈의 생존 확인. 200이면 true, 응답은 했지만 200이 아니면 null(사용자가 켠 서버의 DB가 꺼졌거나 다른 프로그램이
  // 그 포트를 쓴다. 손대지 않는다), 거부·시간 초과·키 없음이면 false.
  function healthy() {
    return health().then((ok) => (ok ? true : null), () => false);
  }

  // 설정 창 "확인". 폴더가 바뀌었을 수 있어 .env부터 다시 읽고 /health와 initialize만 보낸다(임베딩 0). 켜지는 않는다.
  async function check() {
    conn = null;
    await track(async () => {
      if (!(await health())) throw failure("other");
      await connected();
    }).catch(() => {});   // 실패는 track이 상태에 남겼다
    return status();
  }

  // 유휴로 끄기 직전에만 부른다. AnchorMind 자체 정리는 서버가 8시간 내리 켜져 있어야 돌아, 짧게 켜고 끄면 돌지 않는다.
  // 마지막 정리 시각은 Agora 설정에 적고(0은 정리한 적 없음), 애드온을 끈 뒤에는 정리하지 않는다. 던지지 않는다.
  async function consolidateIfDue() {
    const { enabled, lastConsolidateAt } = settings();
    if (!enabled || (lastConsolidateAt && now() - lastConsolidateAt < CONSOLIDATE_INTERVAL_MS)) return;
    try {
      const target = await connected();
      const { result } = await track(() => rpc(target, "tools/call", { name: "memory_consolidate", arguments: {} }, CONSOLIDATE_TIMEOUT_MS));
      if (result.isError === true) return;
      // 설정 저장은 한 단계 얕은 병합이라 anchorMind 객체를 통째로 쓴다(settings-file.js).
      saveSettings({ anchorMind: { ...getSettings()?.anchorMind, lastConsolidateAt: now() } });
    } catch {
      // 정리에 실패해도 끄기는 막지 않는다. 다음 유휴 끄기에서 다시 부른다.
    }
  }

  // 사용자 메시지 하나에 recall 한 번. 전역 설정이 꺼져 있으면 동기로 null이다: 방은 Promise를 받았을
  // 때만 기다리므로 꺼진 상태의 차례 순서가 그대로다(S9). 이 함수를 async로 바꾸지 않는다.
  function recall({ projectId, text } = {}) {
    return settings().enabled ? recallAndLog(projectId, text) : null;
  }

  // 절대 reject하지 않는다. 어떤 실패든 빈 블록과 이유로 끝나고 대화는 기억 없이 이어 간다.
  async function recallAndLog(projectId, text) {
    const started = now();
    let fragments = [];
    let evidenceStatus = null;
    let errorKind = null;
    let workspace = "";
    try {
      // 켜는 동안의 차례는 서버를 기다리지 않고 기억 없이 간다.
      if (current.state === "starting") throw failure("off");
      workspace = workspaceFor(projectId);
      const result = await callTool("recall", {
        text: String(text ?? "").slice(0, QUERY_CHARS),
        workspace,
        tokenBudget: TOKEN_BUDGET,
        pageSize: PAGE_SIZE,
        includeLinks: false,   // 기본(true)은 같은 주제로 이어진 무관한 기억까지 붙인다
        excludeSeen: false,    // 같은 기억이 다음 메시지에도 필요할 수 있다
        intent: "lookup",      // 기본(auto)은 "언제"·"지금" 같은 낱말에 근거 묶음을 더 싣는다
      }, { retry: true });
      if (Array.isArray(result.fragments)) fragments = result.fragments;
      if (EVIDENCE_STATUSES.includes(result._meta?.evidence?.status)) evidenceStatus = result._meta.evidence.status;
    } catch (error) {
      errorKind = error.kind || "other";
      // 꺼져 있으면 켜기를 뒤에서 시도한다. 유휴로 끈 뒤 이미 열린 방에서 다시 쓸 때 필요하다(chat:send는 방 열기를
      // 거치지 않는다). 켜는 중이면 진행 중인 켜기와 하나가 된다.
      if (errorKind === "off") void ensureStarted();
    }
    const block = renderBlock(relevant(fragments, workspace, evidenceStatus, threshold));
    appendRecallLog(storeRoot, {
      v: 1, ts: now(), projectId, latencyMs: now() - started, returned: fragments.length,
      kept: block ? block.split("\n").length : 0, threshold,
      scores: fragments.map((f) => (typeof f?.similarity === "number" ? f.similarity : null)),
      evidenceStatus, errorKind, serverVersion: current.serverVersion,
    });
    return { block, reason: errorKind ? REASONS[errorKind] : null };
  }

  // 기억하기와 기록관 요약·확정한 결정. 모든 저장에 공간을 넣는다: 빠뜨리면 모든 프로젝트에 보이는 전역 기억이 된다.
  // 실패해도 다시 보내지 않는다. 자동 저장이 다시 저장되는 것은 호출자가 준 idempotencyKey로 막는다.
  // episode는 기록관 요약만 쓴다. 화면에서 온 요청에 episode가 섞이지 않게 막는 것은 IPC(chat-ipc) 몫이다.
  async function remember(projectId, { type, content, idempotencyKey } = {}) {
    const topic = workspaceFor(projectId);
    await callWhenStarted("remember", { content: memoryContent(type, content), topic, type, workspace: topic, idempotencyKey });
  }

  // 프로젝트 기록의 기억 목록. search_traces는 임베딩을 쓰지 않는다. entity_key는 주제 부분 일치라
  // 같은 주제만 한 번 더 남긴다(전역 기억도 여기서 빠진다). 지우기·고치기는 여기 나온 id만 받는다.
  async function list(projectId) {
    const topic = workspaceFor(projectId);
    const result = await callWhenStarted("search_traces", { workspace: topic, entity_key: topic, limit: LIST_LIMIT }, { retry: true });
    // ponytail: 최신 100개만 보인다. 더 필요하면 time_range로 나눠 읽는다.
    const items = (Array.isArray(result.traces) ? result.traces : [])
      .filter((trace) => typeof trace?.id === "string" && trace.topic === topic && typeof trace.content === "string")
      .map(({ id, type, content, created_at: createdAt }) => ({ id, type, content, createdAt }));
    listed.set(topic, new Set(items.map((item) => item.id)));
    return items;
  }

  // AnchorMind는 id로 지우거나 고칠 때 공간을 확인하지 않는다(마스터 키). 이 프로젝트 목록에 나온 id만 받는다.
  function listedId(projectId, id) {
    if (!listed.get(workspaceFor(projectId))?.has(id)) throw new Error("목록에 없는 기억입니다. 목록을 다시 불러와 주세요.");
    return id;
  }

  // force: 기본 중요도의 결정·에러·선호는 영구 계층이라 force 없이는 지워지지 않고 success:true, deleted:0으로 온다.
  async function forget(projectId, id) {
    await callWhenStarted("forget", { id: listedId(projectId, id), force: true });
  }

  // 내용을 보내면 유형만 바꿔도 AnchorMind가 다음 5분 틱에 다시 임베딩한다(Gemini 1건). amend의 type에는 episode가
  // 없어(6.7.1) 요약은 고치지 않는다. 화면에서 온 요청은 IPC가 그 유형을 막는다.
  async function amend(projectId, id, { type, content } = {}) {
    await callWhenStarted("amend", { id: listedId(projectId, id), content: memoryContent(type, content), type });
  }

  return { status, check, ensureStarted, recall, remember, list, forget, amend, stopOnQuitSync: proc.stopOnQuitSync };
}

module.exports = { createAnchorMind };
