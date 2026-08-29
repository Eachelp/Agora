// 사용량 창 라벨은 모든 공급자가 같은 짧은 표기("5시간", "주간")를 씁니다.
// "한도" 같은 접미사는 화면 제목("남은 사용량")이 이미 말하고 있어 중복입니다.
function rateWindowLabel(rateWindow) {
  const windowMinutes = Number(
    typeof rateWindow === "object" ? rateWindow?.window_minutes : rateWindow
  );
  let label;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) label = "한도";
  else if (Math.abs(windowMinutes - 300) < 0.01) label = "5시간";
  else if (Math.abs(windowMinutes - 10080) < 0.01) label = "주간";
  else if (windowMinutes >= 28 * 1440 && windowMinutes <= 31 * 1440) label = "월간";
  else if (windowMinutes % 1440 === 0) label = `${windowMinutes / 1440}일`;
  else if (windowMinutes % 60 === 0) label = `${windowMinutes / 60}시간`;
  else label = `${Math.round(windowMinutes)}분`;
  return rateWindow?.scope ? `${rateWindow.scope} · ${label}` : label;
}

module.exports = { rateWindowLabel };
