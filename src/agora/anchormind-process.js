"use strict";
// AnchorMind 서버를 켜고 끈다. anchormind-client.js의 createAnchorMind 안에서만 만든다.
// Agora가 켠 서버만 Agora가 끈다. /health가 200이면 사용자가 켜 둔 것으로 보고, 200이 아닌 다른 답이면(사용자가
// 켠 서버의 DB가 꺼졌거나 다른 프로그램) 켜지도 끄지도 않고 오류로 알린다. 켜는 명령과 끄는 명령이 둘 다 설정에
// 있을 때만 켠다. 끄지 못할 서버를 켜 두면 Agora가 끝난 뒤에도 수백 MB가 남기 때문이다.
// 끄는 때는 유휴 30분(끄기 전에 밀린 정리를 먼저 한다)과 앱 종료(동기, 정리 없음)뿐이다. 방은 앱이 켜져 있는 동안 닫히지 않는다.
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require("node:child_process");
const { killTree, useSynchronousTreeKill } = require("../chat/chat-agent-runner");

const IDLE_MS = 30 * 60 * 1000;
const POLL_MS = 1000;
// 2026-10-23 실측: 처음 켤 때 26초, 그 뒤 7초. 넉넉히 잡고, 넘으면 켜기 트리를 끊는다.
const START_TIMEOUT_MS = 3 * 60 * 1000;
// 끄기는 2~5초쯤 걸린다(추정). 시한에 끊기는 것은 셸뿐이다.
const STOP_TIMEOUT_MS = 15 * 1000;

// 문자열 하나만 넘긴다(인자 배열을 같이 주면 Node가 DEP0190 경고를 낸다). stdio는 물려주지 않는다: 켠 서버가
// 파이프를 쥐면 'close'가 오지 않는다. detached도 쓰지 않는다(콘솔 없는 cmd 밑에서 콘솔 창이 새로 열린다).
function shellOptions(cwd, extra) {
  return { cwd, shell: true, windowsHide: true, stdio: "ignore", ...extra };
}

// healthy()는 /health가 200이면 true, 200이 아닌 답이면 null, 거부·시간 초과면 false다. beforeIdleStop()은 유휴로
// 끄기 직전에만 기다린다. 둘 다 던지거나 reject하지 않는다. onState는 "starting" | "error" | "off"이고 "connected"는
// 클라이언트가 initialize 뒤에 정한다. spawn·spawnSync·now·setTimer·clearTimer는 시험만 바꾼다.
function createAnchorMindProcess({
  healthy,
  beforeIdleStop,
  onState,
  spawn = defaultSpawn,
  spawnSync = defaultSpawnSync,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // ponytail: 소유 표지는 메모리에만 있다. Agora가 비정상 종료하면 서버가 켜진 채 남고, 다음 실행은 그 서버를
  // 사용자가 켠 것으로 보아 끄지 않는다. 문제가 되면 settings.json에 표지를 남기고 시작할 때 맞춘다
  // (account-switching.js restoreCodexProxyMode 선례).
  let owned = null; // { cwd, stop, child }
  let pending = null;
  let stopping = null;
  let idleTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimer(resolve, ms));

  // 기억을 쓸 때마다(클라이언트의 도구 호출, 켜기 확인) 유휴 시계를 다시 잰다. Agora가 켠 서버만 끈다.
  function touch() {
    if (!owned) return;
    clearTimer(idleTimer);
    idleTimer = setTimer(onIdle, IDLE_MS);
    idleTimer?.unref?.();
  }

  async function onIdle() {
    idleTimer = null;
    if (!owned) return;
    await beforeIdleStop();
    // 정리하는 동안 기억을 다시 썼거나(touch가 타이머를 새로 걸었다) 앱 종료가 먼저 껐으면 그만둔다.
    if (idleTimer || !owned) return;
    const { cwd, stop } = owned;
    // owned 지우기까지 이 약속에 넣는다. 끄기를 기다리던 켜기가 깨어날 때 이미 지워져 있어야, 끄기가 새로 켠
    // 서버의 표지까지 지우지 않는다.
    stopping = new Promise((resolve) => {
      const child = spawn(stop, shellOptions(cwd, { timeout: STOP_TIMEOUT_MS }));
      child.once("error", resolve);
      child.once("exit", resolve);
    }).then(() => {
      owned = null;
      stopping = null;
      onState("off");
    });
  }

  async function start({ folder, startCommand, stopCommand }) {
    // 끄는 중에 켜면 DB가 꺼지는 사이에 켜기가 돈다. 끄기가 끝난 뒤에 본다.
    if (stopping) await stopping;
    const up = await healthy();
    if (up) {
      touch();
      return true;
    }
    // 200이 아닌 답이면 손대지 않는다. 켜 봐야 소용없고, 끄기 명령이 남의 서버를 끌 수 있다.
    if (up === null) {
      onState("error");
      return false;
    }
    if (!startCommand || !stopCommand) {
      onState("off");
      return false;
    }
    let child;
    try {
      child = spawn(startCommand, shellOptions(folder));
    } catch {
      onState("error");
      return false;
    }
    owned = { cwd: folder, stop: stopCommand, child };
    // 켜기도 쓰는 것으로 센다. 전에 켠 서버의 유휴 타이머가 켜는 중에 끄지 않는다.
    touch();
    onState("starting");
    let failed = false;
    child.once("error", () => {
      failed = true;
    });
    // 0으로 끝나도 계속 본다(띄우고 바로 끝나는 명령). 신호로 끝나면(code null) 실패다.
    child.once("exit", (code) => {
      failed = code !== 0;
    });
    // 서버는 listen한 뒤에 임베딩 차원을 검사하고 어긋나면 끝난다.
    // 첫 응답 하나만 믿지 않고 두 번 잇달아 응답해야 준비로 본다.
    const deadline = now() + START_TIMEOUT_MS;
    let streak = 0;
    while (now() < deadline) {
      await sleep(POLL_MS);
      streak = (await healthy()) ? streak + 1 : 0;
      if (streak === 2) {
        touch();
        return true;
      }
      if (failed) break;
    }
    killTree(child);
    // 켜기에 실패하면 Agora는 그 서버를 잊으므로, 이어서 사용자가 직접 켠 서버는 끄지 않는다(반쯤 켜진 서버가
    // 남을 수 있는 것은 위 ponytail의 비정상 종료와 같은 한계).
    owned = null;
    onState("error");
    return false;
  }

  // 여러 방이 함께 불러도 켜기는 한 번만 돈다. 절대 reject하지 않는다.
  function ensureStarted(settings) {
    if (pending) return pending;
    pending = start(settings).finally(() => {
      pending = null;
    });
    return pending;
  }

  // will-quit·session-end 전용. 비동기로 띄운 끄기는 앱과 같은 자식 프로세스 묶음이라 앱이 먼저 끝나면
  // 함께 죽는다. 켜기 트리가 살아 있으면 먼저 끊어야 끄기 뒤에 서버가 떠 주인 없이 남지 않는다.
  function stopOnQuitSync() {
    if (!owned) return;
    if (owned.child.exitCode == null) {
      useSynchronousTreeKill();
      killTree(owned.child);
    }
    spawnSync(owned.stop, shellOptions(owned.cwd, { timeout: STOP_TIMEOUT_MS }));
    owned = null;
  }

  return { ensureStarted, touch, stopOnQuitSync };
}

module.exports = { createAnchorMindProcess };
