const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  agyUserAgent,
  classifyWindow,
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  tierLabel,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("창 이름은 표기가 달라도 5시간대와 주간대로만 분류한다", () => {
  for (const text of ["5시간", "5h", "5 Hours", "five_hour", "FIVE_HOURS"]) {
    assert.equal(classifyWindow(text), "5시간", text);
  }
  for (const text of ["주간", "일주일", "7일", "seven_day", "Weekly"]) {
    assert.equal(classifyWindow(text), "주간", text);
  }
  // 5가 다른 수의 일부이거나 다른 구간이면 잘못 분류하지 않습니다.
  for (const text of ["15시간", "24h", "월간", "1개월", ""]) {
    assert.equal(classifyWindow(text), null, text);
  }
});

test("AGY 한도는 gemini 계열 기본 5시간·주간과 함께 Claude/GPT-OSS 할당량을 간결한 라벨로 정규화한다", () => {
  const gauges = normalizeAgyQuota({
    groups: [
      {
        displayName: "Gemini 3 Pro",
        buckets: [
          { displayName: "5시간", remainingFraction: 0.62, resetTime: "soon" },
          { displayName: "일주일", remainingFraction: 0.3 },
          { displayName: "누락" },
        ],
      },
      // 같은 구간이 여러 gemini 그룹에 있으면 가장 많이 쓴 쪽을 대표로 씁니다.
      {
        displayName: "Gemini 3 Flash",
        buckets: [{ displayName: "5시간", remainingFraction: 0.9 }],
      },
      // 풀텍스트(예: "Claude and GPT models · Weekly Limit Remaining")를 간결하게 축약합니다.
      { displayName: "Claude and GPT models", buckets: [{ displayName: "Weekly Limit Remaining", remainingFraction: 0.1 }] },
      { displayName: "Claude and GPT models", buckets: [{ displayName: "Five Hour Limit Remaining", remainingFraction: 0.05 }] },
      { displayName: "GPT-OSS 120B models", buckets: [{ displayName: "5시간", remainingFraction: 0.2 }] },
    ],
  });
  assert.deepEqual(gauges, [
    { label: "5시간", usedPercent: 38, resetText: "soon" },
    { label: "주간", usedPercent: 70, resetText: "" },
    { label: "Claude / GPT · 주간", usedPercent: 90, resetText: "" },
    { label: "Claude / GPT · 5시간", usedPercent: 95, resetText: "" },
    { label: "GPT-OSS 120B · 5시간", usedPercent: 80, resetText: "" },
  ]);
});

test("AGY 구간은 표시 문구보다 window·bucketId 필드로 먼저 가린다", () => {
  // 2026-10 무료 계정 실제 응답 형태: Gemini는 주간 버킷 하나뿐입니다.
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-10-08T22:54:03Z",
            remainingFraction: 0.9599408,
          }],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [{ bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1 }],
        },
      ],
    }),
    [
      { label: "주간", usedPercent: 4, resetText: "2026-10-08T22:54:03Z" },
      { label: "Claude / GPT · 주간", usedPercent: 0, resetText: "" },
    ]
  );

  // 구독 계정의 5시간 버킷 문구가 바뀌어도 window 필드나 bucketId로 분류합니다.
  const gauges = normalizeAgyQuota({
    groups: [{
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-5h", displayName: "Short-term Limit Remaining", window: "five_hour", remainingFraction: 0.5 },
        { bucketId: "gemini-5h-alt", displayName: "Refreshing Limit", remainingFraction: 0.7 },
        { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.8 },
      ],
    }],
  });
  assert.deepEqual(gauges.map((gauge) => [gauge.label, gauge.usedPercent]), [["5시간", 50], ["주간", 20]]);
  assert.equal(classifyWindow("5-Hour Limit Remaining"), "5시간");
});

test("AGY 응답에 Gemini 그룹이 없으면 Claude/GPT 한도를 대표 칸에 올리지 않는다", () => {
  // daily 호스트가 실제로 돌려준 형태(2026-10-16): Claude/GPT 그룹 하나뿐입니다.
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [{
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.8585932 },
          { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1 },
        ],
      }],
    }),
    [
      { label: "Claude / GPT · 주간", usedPercent: 14, resetText: "" },
      { label: "Claude / GPT · 5시간", usedPercent: 0, resetText: "" },
    ]
  );
});

test("AGY 한도는 agy CLI와 같은 daily 호스트에서 설치된 CLI 버전을 밝혀 받는다", async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), userAgent: options?.headers?.["user-agent"] });
    if (String(url).includes("loadCodeAssist")) return jsonResponse({ cloudaicompanionProject: "projects/test" });
    if (String(url).includes("userinfo")) return jsonResponse({});
    return jsonResponse({ groups: [] });
  };
  await fetchAntigravityUsage({
    credential: { token: { access_token: "a", refresh_token: "host-test" } },
    force: true,
    cliVersion: "1.5.2",
  });
  const quota = calls.find((call) => call.url.includes("retrieveUserQuotaSummary"));
  assert.equal(quota.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
  // 예전에 고정한 1.0.11로 보내면 daily 호스트가 Gemini·Argon 그룹을 빼고 돌려줬습니다.
  assert.match(quota.userAgent, /^antigravity\/cli\/1\.5\.2 /);
});

test("AGY user-agent는 버전 문자열에서 숫자만 뽑고, 모르면 확인된 버전을 쓴다", () => {
  assert.equal(agyUserAgent("1.4.0", "win32", "x64"), "antigravity/cli/1.4.0 windows/amd64");
  assert.equal(agyUserAgent("agy 1.6.3 (build abc)", "darwin", "arm64"), "antigravity/cli/1.6.3 darwin/arm64");
  assert.equal(agyUserAgent(null, "linux", "x64"), "antigravity/cli/1.4.0 linux/amd64");
  assert.equal(agyUserAgent("unknown", "win32", "x64"), "antigravity/cli/1.4.0 windows/amd64");
});

test("AGY의 모델 전용 그룹(Argon)은 Gemini 대표 칸을 차지하지 않고 따로 표시된다", () => {
  // 2026-10-16 agy 1.4.0 `/usage`와 같은 daily 응답입니다.
  const gauges = normalizeAgyQuota({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 1, resetTime: "w" },
          { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1, resetTime: "h" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.858593225479126 },
          { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1 },
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [{
          bucketId: "gemini-argon-wtu-weekly",
          displayName: "Gemini 4 Argon Weekly Limit",
          window: "weekly",
          remainingFraction: 0.641541600227356,
          resetTime: "a",
        }],
      },
    ],
  });
  assert.deepEqual(gauges, [
    { label: "5시간", usedPercent: 0, resetText: "h" },
    { label: "주간", usedPercent: 0, resetText: "w" },
    { label: "Gemini 4 Argon · 주간", usedPercent: 36, resetText: "a", scope: "Argon", window: "주간" },
    { label: "Claude / GPT · 주간", usedPercent: 14, resetText: "" },
    { label: "Claude / GPT · 5시간", usedPercent: 0, resetText: "" },
  ]);
});

test("AGY 그룹 이름이 바뀌어 gemini를 못 찾으면 전체를 그대로 쓴다", () => {
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [
        {
          displayName: "모델",
          buckets: [
            { displayName: "주간", remainingFraction: 0.25, resetTime: "soon" },
            { displayName: "누락" },
          ],
        },
      ],
    }),
    [{ label: "주간", usedPercent: 75, resetText: "soon" }]
  );
});

test("구간을 하나도 분류하지 못하면 원래 목록을 잃지 않는다", () => {
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [{ displayName: "Gemini", buckets: [{ displayName: "특수 구간", remainingFraction: 0.4 }] }],
    }),
    [{ label: "Gemini · 특수 구간", usedPercent: 60, resetText: "" }]
  );
});

test("Claude 한도는 5시간과 전체 주간을 쓰고 범위를 보정하며, 예전 모델별 필드는 읽지 않는다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    // 모델 전용 한도는 limits 배열에서만 읽습니다. 예전 필드까지 읽으면 같은 한도를 두 번 셉니다.
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
    seven_day_opus: { utilization: 88, resets_at: "d" },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "주간"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100]);
});

test("Claude의 모델 전용 한도(Fable 주간)는 limits 배열에서 따로 읽는다", () => {
  // 2026-10-16 실제 응답의 limits 배열 형태입니다.
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 5, resets_at: "s" },
    seven_day: { utilization: 31, resets_at: "w" },
    limits: [
      { kind: "session", group: "session", percent: 5, resets_at: "s", scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 31, resets_at: "w", scope: null, is_active: true },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 6,
        resets_at: "f",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: false,
      },
      // 모델이 아닌 범위(surface)만 있는 한도는 아직 다루지 않습니다.
      { kind: "weekly_scoped", group: "weekly", percent: 50, scope: { model: null, surface: { display_name: "Cowork" } } },
    ],
  });
  assert.deepEqual(gauges, [
    { label: "5시간", usedPercent: 5, resetText: "s" },
    { label: "주간", usedPercent: 31, resetText: "w" },
    { label: "Fable · 주간", usedPercent: 6, resetText: "f", scope: "Fable", window: "주간" },
  ]);
});

test("AGY 응답에서 계정, 플랜, 한도만 정규화한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return jsonResponse({
        cloudaicompanionProject: "projects/test",
        currentTier: { displayName: "Google AI Pro" },
      });
    }
    if (String(url).includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    return jsonResponse({
      groups: [{ displayName: "Gemini 3 Pro", buckets: [{ displayName: "5시간", remainingFraction: 0.8 }] }],
    });
  };

  const result = await fetchAntigravityUsage({
    credential: { token: { access_token: "access", refresh_token: "refresh" } },
    force: true,
  });
  assert.equal(result.email, "agy@example.com");
  assert.equal(result.plan, "Google AI Pro");
  assert.equal(result.gauges[0].usedPercent, 20);
  assert.equal(tierLabel({ currentTier: { name: "free-tier" } }), "free-tier");
});

test("Claude 사용량 cache는 계정 자격 증명별로 분리한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-usage-"));
  const credentialPath = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ five_hour: { utilization: calls * 10, resets_at: "soon" } });
  };

  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "account-a" } })
  );
  await fetchClaudeUsage({ home });
  await fetchClaudeUsage({ home });
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "b", refreshToken: "account-b" } })
  );
  await fetchClaudeUsage({ home });
  assert.equal(calls, 2);
});
