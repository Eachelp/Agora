"use strict";

// 질문 시험 공용 도구. MCP 서버가 하는 일(중계소에 HTTP로 묻고, 답을 받으면 전달 확인)을 그대로 흉내 낸다.
const http = require("node:http");

async function waitFor(condition, timeoutMs = 3000, label = "조건") {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} 대기 시간 초과`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// 가짜 시계: 중계소의 30분 대기 같은 타이머를 직접 앞으로 돌린다.
function fakeClock() {
  let time = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: time + ms }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

function httpPost(base, token, pathName, body, track) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body ?? {}), "utf8");
    const req = http.request(`${base}/${pathName}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": data.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 본문 없음 */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (track) track.add(req);
    req.end(data);
  });
}

// 질문 도구가 붙은 실행의 CLI 자리. script({ args, ask, run })이 돌려준 글이 실행 결과가 된다.
// ask(questions)는 MCP 서버처럼 /ask를 호출하고, 답이 오면 /delivered까지 알린다. cancel()은 프로세스를 죽이는 것처럼
// 진행 중인 호출을 끊고 { cancelled: true }로 끝난다.
function scriptedRunner(script, log = {}) {
  log.calls = log.calls || [];
  log.runs = log.runs || [];
  return (args) => {
    log.calls.push(args);
    const requests = new Set();
    let finish;
    const run = { cancelled: false, waiting: [] };
    run.cancel = () => {
      run.cancelled = true;
      for (const req of requests) req.destroy();
      finish({ ok: false, cancelled: true, error: "중지됨" });
    };
    run.setWaitingUser = (value) => run.waiting.push(Boolean(value));
    run.promise = new Promise((resolve) => { finish = resolve; });
    log.runs.push(run);
    const uq = args.userQuestion;
    const env = uq?.server?.env || {};
    const base = env.AGORA_QUESTION_URL;
    const token = env.AGORA_QUESTION_TOKEN;
    const ask = async (questions) => {
      const reply = await httpPost(base, token, "ask", { questions }, requests);
      if (reply.status === 200 && reply.body?.status === "answered") {
        await httpPost(base, token, "delivered", { setId: reply.body.setId }, requests);
      }
      return reply;
    };
    Promise.resolve()
      .then(() => script({ args, ask, run, base, token }))
      .then(
        (text) => finish({ ok: true, text: String(text ?? "완료") }),
        (error) => finish({ ok: false, error: error?.message || String(error) })
      );
    return run;
  };
}

module.exports = { waitFor, fakeClock, httpPost, scriptedRunner };
