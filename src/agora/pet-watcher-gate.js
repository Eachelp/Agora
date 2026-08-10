// 펫이 꺼져 있으면 대화 감시 watcher가 디스크를 폴링하지 않도록 하는 생명주기 관리자.
// main.js가 electron을 직접 import해 테스트할 수 없어, 순수 로직을 이 모듈로 분리합니다.
"use strict";

class PetWatcherGate {
  constructor({ start, stop }) {
    this.startFns = Array.isArray(start) ? start : [start];
    this.stopFns = Array.isArray(stop) ? stop : [stop];
    this.running = false;
  }


  setPetEnabled(enabled) {
    const next = enabled === true;
    if (next) this.start();
    else this.stop();
    return next;
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const fn of this.startFns) fn();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const fn of this.stopFns) fn();
  }
}

module.exports = { PetWatcherGate };
