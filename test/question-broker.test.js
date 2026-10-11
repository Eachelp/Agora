const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  createUserQuestionBroker,
  normalizeQuestions,
  normalizeAnswers,
  MAX_BODY_BYTES,
  MAX_QUESTION_CHARS,
  MAX_OPTION_CHARS,
  MAX_ANSWER_CHARS,
  MAX_REFUSALS,
  REFUSE_TEXT,
} = require("../src/chat/user-question-broker");

// 가짜 시계: 타이머를 직접 앞으로 돌린다.
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
    pendingTimers: () => timers.size,
  };
}

function setup(t, options = {}) {
  const clock = fakeClock();
  const events = [];
  const record = (name) => (payload) => events.push({ name, ...payload });
  const broker = createUserQuestionBroker({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onRequested: record("requested"), onSubmitted: record("submitted"), onDelivered: record("delivered"),
    onCancelled: record("cancelled"), onExpired: record("expired"), onRepeatLimit: record("repeat-limit"),
    onCallbackError: (error, name) => events.push({ name: "callback-error", hook: name, message: error.message }),
    ...options,
  });
  t.after(() => broker.stop());
  return { broker, clock, events };
}

// 중계소에 직접 HTTP 요청. 응답을 기다리는 호출은 Promise를 그대로 돌려준다.
function post(url, { token, path = "ask", body, raw, headers = {}, method = "POST" } = {}) {
  const target = new URL(`${url}/${path}`);
  const data = Buffer.from(raw !== undefined ? raw : JSON.stringify(body ?? {}), "utf8");
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        "Content-Length": data.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 본문 없음 */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

const waitFor = async (condition, label = "조건") => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`${label}이(가) 오지 않았습니다.`);
};

const Q1 = { questions: [{ question: "어느 쪽으로 갈까요?", options: ["왼쪽", "오른쪽"] }] };

async function askAndWait(setupResult, run, body = Q1) {
  const { events } = setupResult;
  const before = events.filter((event) => event.name === "requested").length;
  const pending = post(run.url, { token: run.token, body });
  await waitFor(() => events.filter((event) => event.name === "requested").length > before, "onRequested");
  const set = events.filter((event) => event.name === "requested").at(-1);
  return { pending, set };
}

test("질문 묶음 검증: 모델이 고쳐 다시 부를 수 있는 한 문장으로 거부한다", () => {
  const ok = (questions) => normalizeQuestions({ questions }).ok;
  const q = (extra = {}) => ({ question: "질문", ...extra });
  assert.equal(normalizeQuestions(null).ok, false);
  assert.equal(normalizeQuestions([]).ok, false);
  assert.equal(normalizeQuestions({ questions: [q()], extra: 1 }).ok, false);
  assert.equal(ok([]), false, "질문 0개");
  assert.equal(ok([q(), q(), q(), q(), q()]), false, "질문 5개");
  assert.equal(ok([q(), q(), q(), q()]), true, "질문 4개까지");
  assert.equal(ok([q({ question: "" })]), false);
  assert.equal(ok([q({ question: "   " })]), false);
  assert.equal(ok([q({ question: "가".repeat(MAX_QUESTION_CHARS + 1) })]), false);
  assert.equal(ok([q({ question: "가".repeat(MAX_QUESTION_CHARS) })]), true);
  assert.equal(ok([q({ options: ["하나"] })]), false, "선택지 1개");
  assert.equal(ok([q({ options: ["a", "b", "c", "d", "e", "f"] })]), false, "선택지 6개");
  assert.equal(ok([q({ options: ["a", "b", "c", "d", "e"] })]), true);
  assert.equal(ok([q({ options: ["a", ""] })]), false);
  assert.equal(ok([q({ options: ["a", 3] })]), false);
  assert.equal(ok([q({ options: ["a", "나".repeat(MAX_OPTION_CHARS + 1)] })]), false);
  assert.equal(ok([q({ options: ["a", " a "] })]), false, "공백을 걷어내면 같은 선택지");
  assert.equal(ok([q({ options: "a,b" })]), false);
  assert.equal(ok([q({ multiSelect: true })]), false, "선택지 없이 복수 선택");
  assert.equal(ok([q({ options: ["a", "b"], multiSelect: "yes" })]), false);
  assert.equal(ok([q({ options: ["a", "b"], multiSelect: true })]), true);
  assert.equal(ok([q({ unknown: 1 })]), false);
  assert.equal(ok(["문자열"]), false);
  const clean = normalizeQuestions({ questions: [q({ question: "  공백  ", options: [" a ", "b"] }), q()] });
  assert.deepEqual(clean.questions, [
    { question: "공백", options: ["a", "b"], multiSelect: false },
    { question: "질문", options: [], multiSelect: false },
  ]);
  assert.match(normalizeQuestions({ questions: [q({ multiSelect: true })] }).error, /1번째 질문/);
});

test("답 검증: 선택지 밖·개수 위반·중복·형식 위반을 거부하고 질문에 적힌 순서로 정리한다", () => {
  const questions = [
    { question: "단일", options: ["a", "b", "c"], multiSelect: false },
    { question: "복수", options: ["x", "y", "z"], multiSelect: true },
    { question: "직접", options: [], multiSelect: false },
  ];
  const good = [{ selected: ["b"] }, { selected: ["z", "x"] }, { text: "  자유 입력  " }];
  assert.deepEqual(normalizeAnswers(good, questions).answers, [{ selected: ["b"] }, { selected: ["x", "z"] }, { text: "자유 입력" }]);
  const bad = (index, value) => normalizeAnswers(good.map((entry, i) => (i === index ? value : entry)), questions);
  assert.equal(bad(0, { selected: ["없음"] }).ok, false, "선택지 밖");
  assert.equal(bad(0, { selected: ["a", "b"] }).ok, false, "단일에 2개");
  assert.equal(bad(0, { selected: [] }).ok, false, "단일에 0개");
  assert.equal(bad(0, { text: "a" }).ok, false, "선택지 질문에 직접 입력");
  assert.equal(bad(0, "a").ok, false);
  assert.equal(bad(1, { selected: [] }).ok, false, "복수에 0개");
  assert.equal(bad(1, { selected: ["x", "x"] }).ok, false, "중복 선택");
  assert.equal(bad(2, { text: "" }).ok, false);
  assert.equal(bad(2, { text: "가".repeat(MAX_ANSWER_CHARS + 1) }).ok, false);
  assert.equal(bad(2, { selected: ["a"] }).ok, false, "직접 입력 질문에 선택");
  assert.equal(bad(2, { text: 5 }).ok, false);
  assert.equal(normalizeAnswers(good.slice(0, 2), questions).ok, false, "답이 모자람");
  assert.equal(normalizeAnswers("a", questions).ok, false);
});

test("HTTP 거절: 토큰·실행·형식·크기·메서드를 모두 확인한다", async (t) => {
  const ctx = setup(t);
  const runA = await ctx.broker.registerRun({ runId: "run-a" });
  const runB = await ctx.broker.registerRun({ runId: "run-b" });
  assert.match(runA.url, /^http:\/\/127\.0\.0\.1:\d+\/runs\/run-a$/);
  assert.notEqual(runA.token, runB.token);
  assert.equal(runA.token.length, 64);

  assert.equal((await post(runA.url, { body: Q1 })).status, 401, "토큰 없음");
  assert.equal((await post(runA.url, { token: "x".repeat(64), body: Q1 })).status, 401, "틀린 토큰");
  assert.equal((await post(runA.url, { token: runB.token, body: Q1 })).status, 401, "다른 실행의 토큰");
  assert.equal((await post(runA.url.replace("run-a", "nope"), { token: runA.token, body: Q1 })).status, 401, "모르는 실행");
  assert.equal((await post(runA.url, { token: runA.token, body: Q1, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(runA.url, { token: runA.token, raw: "{ 깨진" })).status, 400);
  assert.equal((await post(runA.url, { token: runA.token, body: { questions: [] } })).status, 400);
  const tooMany = await post(runA.url, { token: runA.token, body: { questions: Array.from({ length: 5 }, () => ({ question: "q" })) } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /1~4/);
  const big = await post(runA.url, { token: runA.token, raw: JSON.stringify({ questions: [{ question: "가".repeat(MAX_BODY_BYTES) }] }) });
  assert.equal(big.status, 413);
  assert.equal((await post(runA.url, { token: runA.token, path: "elsewhere", body: Q1 })).status, 404);
  assert.equal((await post(runA.url, { token: runA.token, method: "GET" })).status, 404);
  assert.equal(ctx.events.filter((event) => event.name === "requested").length, 0, "거절된 요청은 질문 카드를 만들지 않는다");
  assert.equal(ctx.broker.listPending().length, 0);
});

test("답 흐름: 요청 -> 제출 -> 전달 확인, 콜백 순서와 응답 본문", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "r1", sessionId: "s1", agentId: "claude" });
  const { pending, set } = await askAndWait(ctx, run);
  assert.equal(set.status, "pending");
  assert.equal(set.runId, "r1");
  assert.equal(set.sessionId, "s1", "등록 때 준 meta가 이벤트에 실린다");
  assert.equal(set.agentId, "claude");
  assert.deepEqual(set.questions, [{ question: "어느 쪽으로 갈까요?", options: ["왼쪽", "오른쪽"], multiSelect: false }]);
  assert.equal(ctx.broker.getPending("r1").setId, set.setId);
  assert.equal(ctx.broker.listPending().length, 1);

  // 응답은 답이 올 때까지 열려 있다.
  const early = await Promise.race([pending.then(() => "answered"), new Promise((r) => setTimeout(() => r("held"), 50))]);
  assert.equal(early, "held");

  const result = ctx.broker.answer({ runId: "r1", setId: set.setId, answers: [{ selected: ["오른쪽"] }] });
  assert.equal(result.ok, true);
  assert.equal(result.set.status, "submitted");
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, "answered");
  assert.equal(reply.body.setId, set.setId);
  assert.deepEqual(reply.body.answers, [{ selected: ["오른쪽"] }]);
  assert.equal(reply.body.questions[0].question, "어느 쪽으로 갈까요?");
  assert.equal(ctx.broker.getPending("r1"), null, "제출 뒤에는 대기 중이 아니다");
  assert.equal(ctx.clock.pendingTimers(), 0, "제출하면 시간 제한 타이머가 풀린다");
  assert.deepEqual(ctx.events.map((event) => event.name), ["requested", "submitted"]);

  const delivered = await post(run.url, { token: run.token, path: "delivered", body: { setId: set.setId } });
  assert.equal(delivered.status, 200);
  assert.equal(ctx.events.at(-1).name, "delivered");
  assert.equal(ctx.events.at(-1).status, "delivered");
  assert.ok(ctx.events.at(-1).deliveredAt);
  assert.equal((await post(run.url, { token: run.token, path: "delivered", body: { setId: set.setId } })).status, 409, "두 번째 확인은 거절");
  assert.equal((await post(run.url, { token: run.token, path: "delivered", body: { setId: "없음" } })).status, 409);

  // 전달 확인이 오기 전에도 같은 실행은 다음 질문을 할 수 있다(확인이 영영 안 와도 막히지 않는다).
  const second = await askAndWait(ctx, run);
  assert.equal(second.set.runId, "r1");
  ctx.broker.answer({ runId: "r1", setId: second.set.setId, answers: [{ selected: ["왼쪽"] }] });
  assert.equal((await second.pending).body.answers[0].selected[0], "왼쪽");
});

test("여러 질문과 복수 선택 한 묶음", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "multi" });
  const { pending, set } = await askAndWait(ctx, run, {
    questions: [
      { question: "과일은?", options: ["사과", "바나나", "포도"], multiSelect: true },
      { question: "크기는?", options: ["작게", "크게"] },
      { question: "이유는?" },
    ],
  });
  assert.equal(set.questions.length, 3);
  assert.equal(set.questions[0].multiSelect, true);
  assert.deepEqual(set.questions[2].options, []);
  // 하나라도 틀리면 묶음 전체를 받지 않고 대기 상태를 유지한다.
  const bad = ctx.broker.answer({ runId: "multi", setId: set.setId, answers: [{ selected: ["포도", "사과"] }, { selected: ["작게", "크게"] }, { text: "글" }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad-answer");
  assert.match(bad.error, /2번째 질문/);
  assert.equal(ctx.broker.getPending("multi").setId, set.setId, "여전히 답을 기다린다");
  const ok = ctx.broker.answer({ runId: "multi", setId: set.setId, answers: [{ selected: ["포도", "사과"] }, { selected: ["크게"] }, { text: "그냥요" }] });
  assert.equal(ok.ok, true);
  const reply = await pending;
  assert.deepEqual(reply.body.answers, [{ selected: ["사과", "포도"] }, { selected: ["크게"] }, { text: "그냥요" }]);
});

test("답 거절: 이미 처리·다른 실행·끝난 실행·없는 질문", async (t) => {
  const ctx = setup(t);
  const runA = await ctx.broker.registerRun({ runId: "A" });
  await ctx.broker.registerRun({ runId: "B" });
  const { pending, set } = await askAndWait(ctx, runA);
  const wrongRun = ctx.broker.answer({ runId: "B", setId: set.setId, answers: [{ selected: ["왼쪽"] }] });
  assert.equal(wrongRun.ok, false);
  assert.equal(wrongRun.code, "unknown-set", "다른 실행의 질문은 보이지 않는다");
  assert.equal(ctx.broker.answer({ runId: "A", setId: "없음", answers: [] }).code, "unknown-set");
  assert.equal(ctx.broker.answer({ runId: "없음", setId: set.setId, answers: [] }).code, "unknown-run");
  assert.equal(ctx.broker.answer({ runId: "A", setId: set.setId, answers: [{ selected: ["가운데"] }] }).code, "bad-answer", "선택지 밖");
  assert.equal(ctx.broker.answer({ runId: "A", setId: set.setId, answers: [{ selected: ["왼쪽"] }] }).ok, true);
  await pending;
  const again = ctx.broker.answer({ runId: "A", setId: set.setId, answers: [{ selected: ["오른쪽"] }] });
  assert.equal(again.ok, false);
  assert.equal(again.code, "not-pending", "이미 답한 질문");
  assert.equal(ctx.broker.cancel({ runId: "A", setId: set.setId }).code, "not-pending");
  ctx.broker.finishRun("A");
  assert.equal(ctx.broker.answer({ runId: "A", setId: set.setId, answers: [{ selected: ["왼쪽"] }] }).code, "unknown-run", "끝난 실행");
});

test("질문이 이미 대기 중이면 두 번째 질문은 409로 거절한다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "busy" });
  const { pending, set } = await askAndWait(ctx, run);
  const second = await post(run.url, { token: run.token, body: Q1 });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /기다리는 질문/);
  assert.equal(ctx.events.filter((event) => event.name === "requested").length, 1);
  ctx.broker.cancel({ runId: "busy", setId: set.setId });
  await pending;
});

test("건너뛰기: 모델에는 '답 없이 이어 가라'가 돌아가고, 다시 묻는 호출은 거절되며 한도에서 한 번 알린다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "skip", agentId: "codex" });
  const { pending, set } = await askAndWait(ctx, run);
  const cancelled = ctx.broker.cancel({ runId: "skip", setId: set.setId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.set.status, "cancelled");
  assert.equal(cancelled.set.reason, "user-skip");
  assert.deepEqual((await pending).body, { status: "skipped", setId: set.setId });
  assert.equal(ctx.events.at(-1).name, "cancelled");
  assert.equal(ctx.events.at(-1).reason, "user-skip");
  assert.equal(ctx.clock.pendingTimers(), 0);

  for (let attempt = 1; attempt <= MAX_REFUSALS + 2; attempt += 1) {
    const reply = await post(run.url, { token: run.token, body: Q1 });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.status, "refused");
    assert.equal(reply.body.reason, "declined");
    assert.equal(reply.body.message, REFUSE_TEXT.declined);
  }
  assert.equal(ctx.events.filter((event) => event.name === "requested").length, 1, "거절된 질문은 카드가 되지 않는다");
  const limits = ctx.events.filter((event) => event.name === "repeat-limit");
  assert.equal(limits.length, 1, "한도 알림은 한 번뿐");
  assert.equal(limits[0].attempts, MAX_REFUSALS);
  assert.equal(limits[0].runId, "skip");
  assert.equal(limits[0].agentId, "codex");
  // 형식이 틀린 호출은 거절 횟수에 세지 않는다.
  assert.equal((await post(run.url, { token: run.token, body: { questions: [] } })).status, 400);
});

test("시간 초과(가짜 시계): 30분 뒤 timeout 응답, 질문은 만료되고 반복 호출은 거절된다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "slow" });
  const { pending, set } = await askAndWait(ctx, run);
  ctx.clock.advance(30 * 60 * 1000 - 1);
  assert.equal(ctx.broker.getPending("slow").setId, set.setId, "30분 직전까지는 기다린다");
  ctx.clock.advance(1);
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, "timeout");
  assert.equal(reply.body.waitedMs, 30 * 60 * 1000);
  const expired = ctx.events.at(-1);
  assert.equal(expired.name, "expired");
  assert.equal(expired.status, "expired");
  assert.equal(ctx.broker.getPending("slow"), null);
  assert.equal(ctx.broker.answer({ runId: "slow", setId: set.setId, answers: [{ selected: ["왼쪽"] }] }).code, "not-pending", "늦은 답은 받지 않는다");
  const again = await post(run.url, { token: run.token, body: Q1 });
  assert.equal(again.body.status, "refused");
});

test("연결 끊김: 호출한 쪽이 끊으면 질문이 취소되고 같은 실행의 다음 질문은 막지 않는다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "drop" });
  const target = new URL(`${run.url}/ask`);
  const data = Buffer.from(JSON.stringify(Q1));
  const req = http.request(target, {
    method: "POST",
    headers: { Authorization: `Bearer ${run.token}`, "Content-Type": "application/json", "Content-Length": data.length },
  });
  req.on("error", () => {});
  req.end(data);
  await waitFor(() => ctx.events.some((event) => event.name === "requested"), "onRequested");
  const set = ctx.events.find((event) => event.name === "requested");
  req.destroy();
  await waitFor(() => ctx.events.some((event) => event.name === "cancelled"), "onCancelled");
  const cancelled = ctx.events.find((event) => event.name === "cancelled");
  assert.equal(cancelled.reason, "connection-lost");
  assert.equal(cancelled.setId, set.setId);
  assert.equal(ctx.broker.getPending("drop"), null);
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal(ctx.broker.answer({ runId: "drop", setId: set.setId, answers: [{ selected: ["왼쪽"] }] }).code, "not-pending");
  // 사용자가 거부한 것이 아니므로 반복 거절 대상이 아니다.
  const next = await askAndWait(ctx, run);
  ctx.broker.answer({ runId: "drop", setId: next.set.setId, answers: [{ selected: ["왼쪽"] }] });
  assert.equal((await next.pending).body.status, "answered");
});

test("질문 횟수 한도(maxSetsPerRun) 뒤의 호출은 거절된다", async (t) => {
  const ctx = setup(t, { maxSetsPerRun: 2 });
  const run = await ctx.broker.registerRun({ runId: "budget" });
  for (let i = 0; i < 2; i += 1) {
    const { pending, set } = await askAndWait(ctx, run);
    ctx.broker.answer({ runId: "budget", setId: set.setId, answers: [{ selected: ["왼쪽"] }] });
    await pending;
  }
  const over = await post(run.url, { token: run.token, body: Q1 });
  assert.equal(over.body.status, "refused");
  assert.equal(over.body.reason, "budget");
  assert.equal(over.body.message, REFUSE_TEXT.budget);
});

test("실행 종료: 대기 중인 질문은 410으로 끝나고 토큰은 더는 통하지 않는다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "gone" });
  const other = await ctx.broker.registerRun({ runId: "other" });
  const { pending, set } = await askAndWait(ctx, run);
  const outcome = ctx.broker.finishRun("gone", "stopped");
  assert.deepEqual(outcome, { ok: true, cancelled: 1 });
  assert.equal((await pending).status, 410);
  const cancelled = ctx.events.at(-1);
  assert.equal(cancelled.name, "cancelled");
  assert.equal(cancelled.reason, "stopped");
  assert.equal(cancelled.setId, set.setId);
  assert.equal(ctx.broker.getPending("gone"), null);
  assert.equal(ctx.clock.pendingTimers(), 0);
  assert.equal((await post(run.url, { token: run.token, body: Q1 })).status, 401, "끝난 실행의 토큰");
  assert.deepEqual(ctx.broker.finishRun("gone"), { ok: false, cancelled: 0 }, "두 번 불러도 안전");
  // 다른 실행은 영향받지 않는다.
  const next = await askAndWait(ctx, other);
  ctx.broker.answer({ runId: "other", setId: next.set.setId, answers: [{ selected: ["왼쪽"] }] });
  assert.equal((await next.pending).body.status, "answered");
  // 같은 ID로 다시 등록해도 새 토큰이다.
  const reborn = await ctx.broker.registerRun({ runId: "gone" });
  assert.notEqual(reborn.token, run.token);
  await assert.rejects(() => ctx.broker.registerRun({ runId: "gone" }), /이미 등록/);
  await assert.rejects(() => ctx.broker.registerRun({}), /runId/);
});

test("stop(): 모든 대기 질문을 끝내고 서버를 닫으며 이후 등록은 거절한다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "quit" });
  const { pending } = await askAndWait(ctx, run);
  await ctx.broker.stop();
  const reply = await pending;
  assert.equal(reply.status, 410);
  assert.equal(ctx.events.at(-1).reason, "broker-stopped");
  await assert.rejects(() => post(run.url, { token: run.token, body: Q1 }), /ECONNREFUSED|ECONNRESET/);
  await assert.rejects(() => ctx.broker.registerRun({ runId: "late" }), /멈췄습니다/);
  await ctx.broker.stop(); // 두 번 불러도 안전
});

test("stop()은 서버를 띄우기 전에도, 시작 도중에도 안전하다", async (t) => {
  const idle = setup(t);
  await idle.broker.stop();
  const racing = setup(t);
  const starting = racing.broker.registerRun({ runId: "x" });
  const stopping = racing.broker.stop();
  await starting.catch(() => {});
  await stopping;
});

test("콜백이 던져도 중계소는 계속 동작하고 오류는 onCallbackError로 알린다", async (t) => {
  const events = [];
  const broker = createUserQuestionBroker({
    onRequested: () => { throw new Error("화면이 죽었다"); },
    onSubmitted: () => { throw new Error("저장 실패"); },
    onCallbackError: (error, name) => events.push(`${name}:${error.message}`),
  });
  t.after(() => broker.stop());
  const run = await broker.registerRun({ runId: "cb" });
  const pending = post(run.url, { token: run.token, body: Q1 });
  await waitFor(() => events.length > 0, "콜백 오류");
  const set = broker.getPending("cb");
  assert.ok(set, "콜백이 던졌어도 질문은 대기 중이다");
  assert.equal(broker.answer({ runId: "cb", setId: set.setId, answers: [{ selected: ["왼쪽"] }] }).ok, true);
  assert.equal((await pending).body.status, "answered");
  assert.deepEqual(events, ["onRequested:화면이 죽었다", "onSubmitted:저장 실패"]);
});

test("서버는 루프백에만 묶이고 URL의 실행 ID는 안전하게 인코딩된다", async (t) => {
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "r 1/é?#" });
  assert.match(run.url, /^http:\/\/127\.0\.0\.1:\d+\/runs\//);
  assert.equal(run.url.includes(" "), false);
  const { pending, set } = await askAndWait(ctx, run);
  assert.equal(set.runId, "r 1/é?#");
  ctx.broker.cancel({ runId: "r 1/é?#", setId: set.setId });
  await pending;
});

// 서버가 시작된 뒤에 난 오류(열 수 있는 파일 수 초과 등)가 처리기 없이 올라가면 메인 프로세스의 처리되지 않은 예외다.
function captureServer(t) {
  const original = http.createServer;
  const created = [];
  http.createServer = (...args) => { const server = original.apply(http, args); created.push(server); return server; };
  t.after(() => { http.createServer = original; });
  return created;
}

test("시작한 뒤 서버에 오류가 나도 앱이 죽지 않고, 한 번만 알리며, 계속 듣고 있으면 질문은 그대로 이어진다", async (t) => {
  const created = captureServer(t);
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "r1" });
  const asking = await askAndWait(ctx, run);
  assert.equal(created.length, 1);
  const server = created[0];
  assert.ok(server.listenerCount("error") >= 1, "오류 처리기가 남아 있다");

  const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });
  assert.doesNotThrow(() => server.emit("error", emfile));
  assert.doesNotThrow(() => server.emit("error", emfile));
  assert.deepEqual(ctx.events.filter((event) => event.name === "callback-error"), [{ name: "callback-error", hook: "server", message: "accept EMFILE" }], "한 번만 알린다");
  assert.equal(ctx.broker.getPending("r1")?.setId, asking.set.setId, "서버가 계속 듣고 있으면 대기 중인 질문은 그대로다");

  assert.equal(ctx.broker.answer({ runId: "r1", setId: asking.set.setId, answers: [{ selected: ["왼쪽"] }] }).ok, true);
  assert.equal((await asking.pending).body.status, "answered");
});

test("서버가 더는 듣고 있지 않으면 기다리던 질문을 닫고, 다음 등록이 새 서버를 띄운다", async (t) => {
  const created = captureServer(t);
  const ctx = setup(t);
  const run = await ctx.broker.registerRun({ runId: "r1" });
  const asking = await askAndWait(ctx, run);
  created[0].close(); // 듣기를 멈춘 서버(질문을 기다리는 연결 하나는 아직 열려 있다)
  assert.doesNotThrow(() => created[0].emit("error", new Error("서버 오류")));
  const cancelled = ctx.events.filter((event) => event.name === "cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].reason, "server-error");
  assert.equal(ctx.broker.getPending("r1"), null);
  assert.equal((await asking.pending).status, 410);

  const next = await ctx.broker.registerRun({ runId: "r2" });
  assert.equal(created.length, 2, "새 서버로 다시 시작한다");
  const again = await askAndWait(ctx, next);
  assert.equal(ctx.broker.cancel({ runId: "r2", setId: again.set.setId }).ok, true);
  assert.equal((await again.pending).body.status, "skipped");
});
