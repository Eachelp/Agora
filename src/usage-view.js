// 사용량 게이지 표시 규칙을 채팅 화면과 설정 화면이 공유하기 위한 순수 헬퍼입니다.
// DOM을 만들지 않고 값만 계산하므로 Node에서 그대로 단위 테스트할 수 있습니다.
(function attachUsageView(global) {
  const WARN_THRESHOLD = 70;
  const DANGER_THRESHOLD = 90;

  function clampPercent(value) {
    return Math.min(100, Math.max(0, Number(value) || 0));
  }

  // 사용자에게는 "얼마나 썼는지"보다 "얼마나 남았는지"가 바로 읽힙니다.
  function remainingPercent(gauge) {
    return Math.round(100 - clampPercent(gauge?.usedPercent));
  }

  function usageTone(usedPercent) {
    const used = clampPercent(usedPercent);
    if (used >= DANGER_THRESHOLD) return "is-danger";
    if (used >= WARN_THRESHOLD) return "is-warn";
    return "";
  }

  // 모든 공급자의 초기화 시각을 같은 형태로 보여줍니다: "8/29 01:18 (3시간 37분 후 초기화)".
  // 공급자는 모두 ISO 날짜만 보내고, 표시 문자열은 여기서만 만듭니다.
  // ISO가 아닌 값(예: main이 정한 "이미 초기화됨")은 그대로 통과시킵니다.
  function resetLabel(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(value))) {
      return String(value);
    }

    const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
    let relative;
    if (diffMinutes <= 0) {
      relative = "곧 초기화";
    } else {
      const days = Math.floor(diffMinutes / 1440);
      const hours = Math.floor((diffMinutes % 1440) / 60);
      const minutes = diffMinutes % 60;
      const parts = [];
      if (days > 0) parts.push(`${days}일`);
      if (hours > 0) parts.push(`${hours}시간`);
      if (minutes > 0 && days === 0) parts.push(`${minutes}분`);
      relative = `${parts.join(" ") || "1분 미만"} 후 초기화`;
    }

    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())} (${relative})`;
  }

  // 한 공급자에 여러 창(5시간·주간 등)이 있을 때 가장 먼저 바닥나는 창을 고릅니다.
  function tightestGauge(gauges) {
    if (!Array.isArray(gauges) || gauges.length === 0) return null;
    return gauges.reduce((worst, gauge) =>
      clampPercent(gauge?.usedPercent) > clampPercent(worst?.usedPercent) ? gauge : worst
    );
  }

  // 공급자마다 창 이름 표기가 조금씩 달라(5시간 한도 / 5시간 / Five Hour) 좁은
  // 사이드바에서는 짧은 이름으로 통일해 보여 줍니다.
  function shortWindowLabel(label) {
    const value = String(label || "").trim();
    if (/5\s*시간|5\s*h(?![a-z])|five[_\s-]?hour/i.test(value)) return "5시간";
    if (/주간|일주일|7\s*일|week|seven[_\s-]?day/i.test(value)) return "주간";
    return value;
  }

  // 5시간을 먼저, 주간을 다음에 놓아 공급자끼리 같은 순서로 읽히게 합니다.
  function windowRank(label) {
    const short = shortWindowLabel(label);
    if (short === "5시간") return 0;
    if (short === "주간") return 1;
    return 2;
  }

  // 사이드바 스트립용: 공급자 하나를 5시간·주간 두 칸으로 정리합니다.
  // 조회에 실패한 공급자도 자리를 지켜 무엇이 빠졌는지 드러나게 합니다.
  function summarizeWindows(item) {
    if (!item) return null;
    const base = { id: item.id, label: item.label, windows: [] };
    if (item.error) return { ...base, error: item.error };

    const gauges = Array.isArray(item.gauges) ? item.gauges : [];
    if (gauges.length === 0) return { ...base, error: "한도 정보 없음" };

    // 정확히 "5시간", "주간"인 기본 게이지를 우선 선택합니다.
    const exact5h = gauges.find((g) => g.label === "5시간");
    const exactWeek = gauges.find((g) => g.label === "주간");
    const match5h = exact5h || gauges.find((g) => shortWindowLabel(g.label) === "5시간") || null;
    const matchWeek = exactWeek || gauges.find((g) => shortWindowLabel(g.label) === "주간") || null;

    const selected = [match5h, matchWeek].filter(Boolean);
    const fallback = selected.length > 0
      ? selected
      : [...gauges].sort((a, b) => windowRank(a.label) - windowRank(b.label)).slice(0, 2);

    return {
      ...base,
      windows: fallback.map((gauge) => ({
        label: shortWindowLabel(gauge.label),
        remaining: remainingPercent(gauge),
        tone: usageTone(gauge.usedPercent),
        resetText: gauge.resetText || "",
      })),
    };
  }

  const api = {
    WARN_THRESHOLD,
    DANGER_THRESHOLD,
    clampPercent,
    remainingPercent,
    usageTone,
    resetLabel,
    shortWindowLabel,
    tightestGauge,
    summarizeWindows,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.usageView = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
