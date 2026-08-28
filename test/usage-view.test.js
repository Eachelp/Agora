const test = require("node:test");
const assert = require("node:assert/strict");

const usageView = require("../src/usage-view.js");

test("clampPercent는 0~100 밖의 값을 잘라 낸다", () => {
  assert.equal(usageView.clampPercent(-30), 0);
  assert.equal(usageView.clampPercent(0), 0);
  assert.equal(usageView.clampPercent(42.5), 42.5);
  assert.equal(usageView.clampPercent(100), 100);
  assert.equal(usageView.clampPercent(180), 100);
  assert.equal(usageView.clampPercent(null), 0);
  assert.equal(usageView.clampPercent("이상한 값"), 0);
});

test("remainingPercent는 남은 비율을 정수로 돌려준다", () => {
  assert.equal(usageView.remainingPercent({ usedPercent: 0 }), 100);
  assert.equal(usageView.remainingPercent({ usedPercent: 62.4 }), 38);
  assert.equal(usageView.remainingPercent({ usedPercent: 100 }), 0);
  assert.equal(usageView.remainingPercent({ usedPercent: 130 }), 0);
});

test("usageTone은 70%·90% 경계에서만 단계가 바뀐다", () => {
  assert.equal(usageView.usageTone(0), "");
  assert.equal(usageView.usageTone(69.9), "");
  assert.equal(usageView.usageTone(70), "is-warn");
  assert.equal(usageView.usageTone(89.9), "is-warn");
  assert.equal(usageView.usageTone(90), "is-danger");
  assert.equal(usageView.usageTone(100), "is-danger");
});

test("resetLabel은 ISO 시각만 날짜로 바꾸고 나머지는 그대로 보여 준다", () => {
  assert.equal(usageView.resetLabel(""), "—");
  assert.equal(usageView.resetLabel(null), "—");
  assert.equal(usageView.resetLabel("5시간 뒤"), "5시간 뒤");
  assert.equal(usageView.resetLabel("2026-13-45T99:99:99Z"), "2026-13-45T99:99:99Z");
  // 모든 공급자가 같은 형태를 씁니다: "M/D HH:mm (…초기화)" — Codex가 보내는
  // 기성 문자열(main.js formatResetInfo)과 동일한 모양이어야 합니다.
  assert.match(usageView.resetLabel("2026-08-14T10:00:00Z"), /^\d{1,2}\/\d{1,2} \d{2}:\d{2} \(.*초기화\)$/);
  const future = new Date(Date.now() + 90 * 60000).toISOString();
  assert.match(usageView.resetLabel(future), /\(1시간 30분 후 초기화\)$/);
});

test("tightestGauge는 가장 먼저 바닥나는 창을 고른다", () => {
  assert.equal(usageView.tightestGauge([]), null);
  assert.equal(usageView.tightestGauge(null), null);
  const gauges = [
    { label: "5시간", usedPercent: 12 },
    { label: "7일", usedPercent: 88 },
    { label: "7일 · Opus", usedPercent: 40 },
  ];
  assert.equal(usageView.tightestGauge(gauges).label, "7일");
});

test("shortWindowLabel은 공급자별 표기를 짧은 이름으로 통일한다", () => {
  assert.equal(usageView.shortWindowLabel("5시간 한도"), "5시간");
  assert.equal(usageView.shortWindowLabel("5시간"), "5시간");
  assert.equal(usageView.shortWindowLabel("Five Hour Limit"), "5시간");
  assert.equal(usageView.shortWindowLabel("주간 한도"), "주간");
  assert.equal(usageView.shortWindowLabel("일주일"), "주간");
  assert.equal(usageView.shortWindowLabel("Weekly Limit"), "주간");
  // 알아보지 못하는 이름은 그대로 둡니다.
  assert.equal(usageView.shortWindowLabel("월간 한도"), "월간 한도");
});

test("summarizeWindows는 5시간과 주간 두 칸을 순서대로 돌려준다", () => {
  const agy = usageView.summarizeWindows({
    id: "agy",
    label: "AGY",
    // 공급자가 주간을 먼저 주더라도 화면에서는 5시간이 앞에 옵니다.
    gauges: [
      { label: "주간", usedPercent: 28, resetText: "2026-08-16T19:30:00Z" },
      { label: "5시간", usedPercent: 0, resetText: "2026-08-14T21:26:00Z" },
    ],
  });
  assert.deepEqual(agy.windows.map((window) => window.label), ["5시간", "주간"]);
  assert.deepEqual(agy.windows.map((window) => window.remaining), [100, 72]);

  // Codex의 "5시간 한도 / 주간 한도" 표기도 같은 두 칸으로 읽힙니다.
  const codex = usageView.summarizeWindows({
    id: "codex",
    label: "Codex",
    gauges: [
      { label: "5시간 한도", usedPercent: 18 },
      { label: "주간 한도", usedPercent: 92 },
    ],
  });
  assert.deepEqual(codex.windows.map((window) => window.label), ["5시간", "주간"]);
  assert.deepEqual(codex.windows.map((window) => window.tone), ["", "is-danger"]);

  // 조회에 실패했거나 한도 정보가 없어도 자리는 지킵니다.
  assert.deepEqual(usageView.summarizeWindows({ id: "claude", label: "Claude", error: "조회 불가" }), {
    id: "claude",
    label: "Claude",
    windows: [],
    error: "조회 불가",
  });
  assert.deepEqual(usageView.summarizeWindows({ id: "agy", label: "AGY", gauges: [] }), {
    id: "agy",
    label: "AGY",
    windows: [],
    error: "한도 정보 없음",
  });
  assert.equal(usageView.summarizeWindows(null), null);
});
