"use strict";

// 실행 중 질문 중계소(broker).
//
// Electron 메인 프로세스 안에서 루프백(127.0.0.1) HTTP 서버 하나를 띄우고, 실행(run)마다
// 따로 등록한 토큰으로만 질문을 받는다. 모델이 CLI의 MCP 도구(ask_user)로 질문하면 이 서버가
// 연결을 열어 둔 채 사용자의 답을 기다리고, 답이 오면 같은 연결로 돌려보내 같은 프로세스가
// 이어서 일한다. 화면·방(room)과는 콜백으로만 이어지는 순수 모듈이다.
//
// HTTP (모두 POST, JSON만, 본문 64KB 이하, `Authorization: Bearer <실행 토큰>`)
//   /runs/<runId>/ask        { questions: [...] }  -> 답이 올 때까지 응답을 잡아 둔다
//   /runs/<runId>/delivered  { setId }             -> 답을 도구 결과로 넘겼다는 확인
// ask 응답(200): { status: "answered"|"skipped"|"timeout"|"refused"|"ended", ... }
// 형식이 틀리면 400 { error }, 인증 실패 401, 끝난 실행 410, 이미 대기 중인 질문 409.

const http = require("node:http");
const crypto = require("node:crypto");

const MAX_QUESTIONS_PER_SET = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_QUESTION_CHARS = 2000;
const MAX_OPTION_CHARS = 200;
const MAX_ANSWER_CHARS = 8000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SETS_PER_RUN = 20;
const MAX_REFUSALS = 3;
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

const REFUSE_TEXT = Object.freeze({
  declined: "사용자가 질문에 답하지 않기로 했으므로 더 묻지 마세요. 질문 없이 가능한 범위에서 이어 가세요.",
  budget: `이 작업에서 할 수 있는 질문 횟수(${MAX_SETS_PER_RUN}회)를 모두 썼습니다. 더 묻지 말고 지금까지 확인한 내용으로 이어 가세요.`,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 질문 묶음 검증. 성공하면 정리된 questions를, 실패하면 모델이 고쳐 다시 부를 수 있는 한 문장을 돌려준다.
function normalizeQuestions(input) {
  if (!isPlainObject(input)) return { ok: false, error: "요청 본문이 JSON 객체여야 합니다." };
  const extra = Object.keys(input).find((key) => key !== "questions");
  if (extra) return { ok: false, error: `지원하지 않는 필드입니다: ${extra}. questions만 보내세요.` };
  const list = input.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUESTIONS_PER_SET) {
    return { ok: false, error: `questions는 질문 1~${MAX_QUESTIONS_PER_SET}개의 배열이어야 합니다.` };
  }
  const questions = [];
  for (let index = 0; index < list.length; index += 1) {
    const where = `${index + 1}번째 질문`;
    const item = list[index];
    if (!isPlainObject(item)) return { ok: false, error: `${where}은 객체여야 합니다.` };
    const unknown = Object.keys(item).find((key) => !["question", "options", "multiSelect"].includes(key));
    if (unknown) return { ok: false, error: `${where}에 지원하지 않는 필드가 있습니다: ${unknown}.` };
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!question || question.length > MAX_QUESTION_CHARS) {
      return { ok: false, error: `${where}의 question은 1~${MAX_QUESTION_CHARS}자 문자열이어야 합니다.` };
    }
    let options = [];
    if (item.options !== undefined) {
      if (!Array.isArray(item.options) || item.options.length < MIN_OPTIONS || item.options.length > MAX_OPTIONS) {
        return { ok: false, error: `${where}의 options는 ${MIN_OPTIONS}~${MAX_OPTIONS}개여야 합니다. 직접 입력을 받으려면 options를 빼세요.` };
      }
      options = item.options.map((option) => (typeof option === "string" ? option.trim() : ""));
      if (options.some((option) => !option || option.length > MAX_OPTION_CHARS)) {
        return { ok: false, error: `${where}의 선택지는 1~${MAX_OPTION_CHARS}자 문자열이어야 합니다.` };
      }
      if (new Set(options).size !== options.length) {
        return { ok: false, error: `${where}의 선택지가 서로 겹칩니다.` };
      }
    }
    if (item.multiSelect !== undefined && typeof item.multiSelect !== "boolean") {
      return { ok: false, error: `${where}의 multiSelect는 true 또는 false여야 합니다.` };
    }
    if (item.multiSelect === true && options.length === 0) {
      return { ok: false, error: `${where}은 선택지(options)가 있어야 여러 개 고르기(multiSelect)를 쓸 수 있습니다.` };
    }
    questions.push({ question, options, multiSelect: item.multiSelect === true });
  }
  return { ok: true, questions };
}

// 사용자의 답 검증. answers[i]는 questions[i]에 대응한다.
//   선택지가 있는 질문: { selected: ["선택지 문구", ...], other?: "기타 직접 입력" }
//     (복수 선택이 아니면 보기와 기타를 합쳐 정확히 1개, 복수 선택이면 합쳐 1개 이상)
//   선택지가 없는 질문: { text: "직접 입력" }
function normalizeAnswers(input, questions) {
  if (!Array.isArray(input) || input.length !== questions.length) {
    return { ok: false, error: `답은 질문 수(${questions.length}개)와 같은 길이의 배열이어야 합니다.` };
  }
  const answers = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const item = input[index];
    const where = `${index + 1}번째 질문`;
    if (!isPlainObject(item)) return { ok: false, error: `${where}의 답이 객체가 아닙니다.` };
    if (question.options.length > 0) {
      if (item.text !== undefined || !Array.isArray(item.selected)) {
        return { ok: false, error: `${where}은 선택지에서 골라야 합니다.` };
      }
      // '기타' 직접 입력(other): 단일 선택이면 고른 보기 대신(selected 비움), 복수 선택이면 보기에 더해 보낸다.
      // text는 선택지 없는 질문 전용이라 위에서 그대로 거절한다.
      const other = item.other === undefined ? "" : typeof item.other === "string" ? item.other.trim() : null;
      if (other === null || other.length > MAX_ANSWER_CHARS) {
        return { ok: false, error: `${where}의 기타 입력은 1~${MAX_ANSWER_CHARS}자의 글이어야 합니다.` };
      }
      const selected = item.selected;
      if (selected.some((entry) => typeof entry !== "string" || !question.options.includes(entry))) {
        return { ok: false, error: `${where}에 없는 선택지입니다.` };
      }
      if (new Set(selected).size !== selected.length) return { ok: false, error: `${where}에서 같은 선택지를 두 번 골랐습니다.` };
      const count = selected.length + (other ? 1 : 0);
      if (count < 1 || (!question.multiSelect && count > 1)) {
        return { ok: false, error: question.multiSelect ? `${where}은 하나 이상 골라야 합니다.` : `${where}은 하나만 고를 수 있습니다.` };
      }
      // 화면에서 누른 순서가 아니라 질문에 적힌 순서로 정리한다.
      answers.push({ selected: question.options.filter((option) => selected.includes(option)), ...(other ? { other } : {}) });
      continue;
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (item.selected !== undefined || !text || text.length > MAX_ANSWER_CHARS) {
      return { ok: false, error: `${where}은 1~${MAX_ANSWER_CHARS}자의 직접 입력이어야 합니다.` };
    }
    answers.push({ text });
  }
  return { ok: true, answers };
}

function secureEqual(left, right) {
  // 길이가 달라도 같은 시간이 들도록 해시끼리 비교한다.
  const hash = (value) => crypto.createHash("sha256").update(String(value || "")).digest();
  return crypto.timingSafeEqual(hash(left), hash(right));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 더 쌓지 않는다. 이유를 돌려줄 수 있도록 끝까지 읽은 뒤 413으로 답한다(연결은 응답 뒤 닫힌다).
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) { reject(Object.assign(new Error("요청 본문이 너무 큽니다."), { status: 413 })); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("JSON 형식이 올바르지 않습니다."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// 콜백 이름(모두 선택): onRequested, onSubmitted, onDelivered, onCancelled, onExpired, onRepeatLimit.
// 질문 묶음 객체(set): { runId, setId, status, questions:[{question,options,multiSelect}], createdAt, ...run.meta,
//   answers?, reason?, deliveredAt? }. 콜백이 던진 예외는 이 모듈 안에서 삼키고 onCallbackError로 알린다.
function createUserQuestionBroker({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  waitMs = DEFAULT_WAIT_MS,
  maxSetsPerRun = MAX_SETS_PER_RUN,
  maxRefusals = MAX_REFUSALS,
  onRequested, onSubmitted, onDelivered, onCancelled, onExpired, onRepeatLimit,
  onCallbackError = (error, name) => console.error(`[user-question-broker] ${name} 콜백 오류:`, error),
} = {}) {
  const hooks = { onRequested, onSubmitted, onDelivered, onCancelled, onExpired, onRepeatLimit };
  const runs = new Map();
  const sockets = new Set();
  let server = null;
  let startPromise = null;
  let stopped = false;

  const emit = (name, payload) => {
    try { hooks[name]?.(payload); } catch (error) {
      try { onCallbackError(error, name); } catch { /* 보고 수단까지 실패해도 방으로 번지지 않는다 */ }
    }
  };

  const publicSet = (run, entry) => ({
    ...run.meta,
    runId: run.runId,
    setId: entry.setId,
    status: entry.status,
    questions: entry.questions.map((question) => ({ ...question, options: [...question.options] })),
    createdAt: entry.createdAt,
    ...(entry.answers ? { answers: entry.answers } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.deliveredAt ? { deliveredAt: entry.deliveredAt } : {}),
  });

  // 실행이 거절 응답을 받은 횟수를 세고, 한도에 닿는 순간 한 번만 알린다.
  const noteRefusal = (run, reason) => {
    run.refusals += 1;
    if (run.refusals === maxRefusals) emit("onRepeatLimit", { ...run.meta, runId: run.runId, attempts: run.refusals, reason });
  };

  function closePending(run, entry, status, reply, reason) {
    clearTimer(entry.timer);
    entry.status = status;
    if (reason) entry.reason = reason;
    run.pendingId = null;
    if (reply) send(entry.res, 200, reply);
  }

  async function handle(req, res) {
    const address = req.socket.remoteAddress;
    if (address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return send(res, 403, { error: "loopback only" });
    const match = /^\/runs\/([^/]+)\/(ask|delivered)$/.exec(String(req.url || "").split("?")[0]);
    if (req.method !== "POST" || !match) return send(res, 404, { error: "not found" });
    let runId;
    try { runId = decodeURIComponent(match[1]); } catch { return send(res, 404, { error: "not found" }); }
    const run = runs.get(runId);
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""))?.[1];
    // 모르는 실행에도 같은 비교를 거쳐 응답 시간으로 실행 ID를 가늠하지 못하게 한다.
    const tokenOk = secureEqual(bearer, run ? run.token : "-");
    if (!run || !tokenOk) return send(res, 401, { error: "unauthorized" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
      return send(res, 415, { error: "Content-Type은 application/json이어야 합니다." });
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { return send(res, error.status || 400, { error: error.message }); }
    if (!runs.has(runId) || runs.get(runId) !== run) return send(res, 410, { error: "이 작업은 이미 끝났습니다." });

    if (match[2] === "delivered") {
      const entry = run.sets.get(String(body?.setId || ""));
      if (!entry || entry.status !== "submitted") return send(res, 409, { error: "답을 전달 중인 질문이 아닙니다." });
      entry.status = "delivered";
      entry.deliveredAt = now();
      emit("onDelivered", publicSet(run, entry));
      return send(res, 200, { ok: true });
    }

    const normalized = normalizeQuestions(body);
    if (!normalized.ok) return send(res, 400, { error: normalized.error });
    if (run.pendingId) return send(res, 409, { error: "이미 사용자의 답을 기다리는 질문이 있습니다. 질문은 한 번에 하나의 호출로 묶어(최대 4개) 보내세요." });
    // 사용자가 답하지 않기로 했거나(건너뜀·시간 초과) 질문 횟수를 다 쓴 실행에는 더 묻게 하지 않는다.
    if (run.declined || run.sets.size >= maxSetsPerRun) {
      const reason = run.declined ? "declined" : "budget";
      noteRefusal(run, reason);
      return send(res, 200, { status: "refused", reason, message: REFUSE_TEXT[reason] });
    }

    const entry = {
      setId: crypto.randomUUID(),
      questions: normalized.questions,
      createdAt: now(),
      status: "pending",
      res,
      timer: null,
    };
    run.sets.set(entry.setId, entry);
    run.pendingId = entry.setId;
    // 호출한 쪽(MCP 서버·CLI)이 답을 받기 전에 끊었다. 사용자 답은 전달된 적이 없다.
    res.on("close", () => {
      if (res.writableEnded || entry.status !== "pending") return;
      closePending(run, entry, "cancelled", null, "connection-lost");
      emit("onCancelled", publicSet(run, entry));
    });
    entry.timer = setTimer(() => {
      if (entry.status !== "pending") return;
      run.declined = true;
      closePending(run, entry, "expired", { status: "timeout", waitedMs: waitMs }, "timeout");
      emit("onExpired", publicSet(run, entry));
    }, waitMs);
    entry.timer?.unref?.();
    emit("onRequested", publicSet(run, entry));
  }

  function start() {
    if (stopped) return Promise.reject(new Error("질문 중계소가 이미 멈췄습니다."));
    if (startPromise) return startPromise;
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => send(res, 500, { error: `내부 오류: ${error?.message || error}` }));
    });
    // 이 서버가 앱(또는 테스트 프로세스)의 종료를 붙들지 않게 한다. 실행 중인 질문 연결은 그 소켓이 따로 붙든다.
    server.unref();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    startPromise = new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const { port } = server.address();
        if (stopped) server.close();
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
    });
    // 시작에 실패한 서버를 붙들고 있지 않는다. 다음 호출이 다시 시도한다.
    startPromise.catch(() => { startPromise = null; server = null; });
    return startPromise;
  }

  // 실행 하나를 등록하고 그 실행만의 URL·토큰을 돌려준다.
  async function registerRun({ runId, ...meta } = {}) {
    const id = String(runId || "");
    if (!id) throw new Error("runId가 필요합니다.");
    const { url } = await start();
    if (stopped) throw new Error("질문 중계소가 이미 멈췄습니다.");
    if (runs.has(id)) throw new Error(`이미 등록된 실행입니다: ${id}`);
    const token = crypto.randomBytes(32).toString("hex");
    runs.set(id, { runId: id, token, meta, sets: new Map(), pendingId: null, declined: false, refusals: 0 });
    return { runId: id, url: `${url}/runs/${encodeURIComponent(id)}`, token };
  }

  function findSet(runId, setId) {
    const run = runs.get(String(runId || ""));
    if (!run) return { error: "이 작업은 이미 끝났거나 이 방에 속하지 않습니다.", code: "unknown-run" };
    const entry = run.sets.get(String(setId || ""));
    if (!entry) return { error: "이 작업에 없는 질문입니다.", code: "unknown-set" };
    return { run, entry };
  }

  function answer({ runId, setId, answers } = {}) {
    const found = findSet(runId, setId);
    if (found.error) return { ok: false, error: found.error, code: found.code };
    const { run, entry } = found;
    if (entry.status !== "pending") return { ok: false, error: "이 질문은 이미 처리되었습니다.", code: "not-pending" };
    const normalized = normalizeAnswers(answers, entry.questions);
    if (!normalized.ok) return { ok: false, error: normalized.error, code: "bad-answer" };
    clearTimer(entry.timer);
    entry.status = "submitted";
    entry.answers = normalized.answers;
    run.pendingId = null;
    send(entry.res, 200, { status: "answered", setId: entry.setId, questions: entry.questions, answers: entry.answers });
    emit("onSubmitted", publicSet(run, entry));
    return { ok: true, set: publicSet(run, entry) };
  }

  // 사용자가 답하지 않기로 했다(건너뛰기). 모델에는 '답 없이 이어 가라'는 결과가 돌아간다.
  function cancel({ runId, setId, reason = "user-skip" } = {}) {
    const found = findSet(runId, setId);
    if (found.error) return { ok: false, error: found.error, code: found.code };
    const { run, entry } = found;
    if (entry.status !== "pending") return { ok: false, error: "이 질문은 이미 처리되었습니다.", code: "not-pending" };
    run.declined = true;
    closePending(run, entry, "cancelled", { status: "skipped", setId: entry.setId }, reason);
    emit("onCancelled", publicSet(run, entry));
    return { ok: true, set: publicSet(run, entry) };
  }

  // 실행이 끝났다(성공·중지·삭제·종료). 기다리던 질문은 취소하고 토큰은 더는 통하지 않는다.
  function finishRun(runId, reason = "run-ended") {
    const run = runs.get(String(runId || ""));
    if (!run) return { ok: false, cancelled: 0 };
    runs.delete(run.runId);
    let cancelled = 0;
    for (const entry of run.sets.values()) {
      clearTimer(entry.timer);
      if (entry.status !== "pending") continue;
      entry.status = "cancelled";
      entry.reason = reason;
      send(entry.res, 410, { error: "이 작업은 끝났습니다." });
      cancelled += 1;
      emit("onCancelled", publicSet(run, entry));
    }
    run.pendingId = null;
    return { ok: true, cancelled };
  }

  function getPending(runId) {
    const run = runs.get(String(runId || ""));
    const entry = run?.pendingId ? run.sets.get(run.pendingId) : null;
    return entry ? publicSet(run, entry) : null;
  }

  function listPending() {
    return [...runs.values()].map((run) => getPending(run.runId)).filter(Boolean);
  }

  async function stop() {
    stopped = true;
    for (const runId of [...runs.keys()]) finishRun(runId, "broker-stopped");
    const current = server;
    if (!current) return;
    const closed = new Promise((resolve) => (current.listening ? current.close(() => resolve()) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  }

  return { start, registerRun, answer, cancel, finishRun, getPending, listPending, stop };
}

module.exports = {
  MAX_QUESTIONS_PER_SET,
  MIN_OPTIONS,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  MAX_OPTION_CHARS,
  MAX_ANSWER_CHARS,
  MAX_BODY_BYTES,
  MAX_SETS_PER_RUN,
  MAX_REFUSALS,
  DEFAULT_WAIT_MS,
  REFUSE_TEXT,
  normalizeQuestions,
  normalizeAnswers,
  createUserQuestionBroker,
};
