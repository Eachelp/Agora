"use strict";

// Windows에서 시스템 종료·재시작·로그오프로 앱이 끝날 때는 app의 'before-quit'이 발생하지 않는다
// (Electron 문서). 그 경로에서는 BrowserWindow의 'session-end'만 온다. 트레이 상주 앱은 PC를 끄면서
// 끝나는 일이 대부분이라, 여기서도 종료 정리(Codex 프록시 주소를 config.toml에서 지우기)를 한다.
// 창은 나중에 만들어지므로 'browser-window-created'로 모든 창에 건다. 정리는 여러 번 불려도 안전해야 한다.
function registerSessionEndTeardown(app, teardown) {
  app.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => {
      try {
        teardown();
      } catch {
        // 시스템이 끝나는 중이라 실패해도 할 수 있는 일이 없다. 다음 실행 때 남은 주소를 정리한다.
      }
    });
  });
}

module.exports = { registerSessionEndTeardown };
