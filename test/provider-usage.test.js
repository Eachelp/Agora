const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
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

test("Claude 한도는 5시간과 전체 주간 두 개만 쓰고 범위를 보정한다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    // 모델별 7일 창은 화면에 넣지 않습니다.
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
    seven_day_opus: { utilization: 88, resets_at: "d" },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "주간"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100]);
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
