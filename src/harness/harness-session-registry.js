"use strict";

// Stage C-2 — memory-only role-scoped logical session registry.
//
// 이 registry는 persistent logical session의 "선택 대상"만 관리한다. C-2에는 실제
// persistent adapter가 없으므로 production에서는 어떤 entry도 만들어지지 않는다.
// (테스트용 fake persistent adapter로만 semantics를 검증한다.)
//
// 절대 계약:
//   - registry는 workspace/Frozen Task/permission authority를 갖지 않는다.
//   - invalidated/retired entry는 다시 선택되지 않는다(재사용 금지).
//   - 같은 logical session에 동시 turn을 허용하지 않는다(single-flight).
//   - sessionless(ProcessHarnessAdapter) 실행을 억지로 entry로 만들지 않는다(호출자 책임).
//
// C-2 범위 밖(넣지 않음): disk 영속, nativeSessionId, health, runtime/auth fingerprint,
// approval token, writer lease, runtime profile, idle GC 시스템.

const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  INVALIDATED: "invalidated",
  RETIRED: "retired",
});

function isSelectable(entry) {
  return Boolean(entry) && entry.lifecycle === LIFECYCLE.ACTIVE;
}

class HarnessSessionRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._entries = new Map(); // key -> entry
  }

  get(key) {
    return this._entries.get(key) || null;
  }

  size() {
    return this._entries.size;
  }

  // 선택 가능한 active entry를 돌려준다. 없거나 기존 entry가 종료 상태(invalidated/
  // retired)면 새 active entry를 만든다. 종료된 entry를 대체할 때는 generation을 올려
  // 연속성이 끊겼음을 드러낸다(옛 entry 객체는 종료 상태 그대로 남는다 = 재사용 안 됨).
  acquire(key, { adapterId = null } = {}) {
    const existing = this._entries.get(key) || null;
    if (isSelectable(existing)) return existing;
    const now = this._now();
    const entry = {
      key,
      adapterId,
      generation: existing ? (existing.generation || 0) + 1 : 1,
      lifecycle: LIFECYCLE.ACTIVE,
      invalidationReason: null,
      inflight: false,
      createdAt: now,
      lastUsedAt: now,
    };
    this._entries.set(key, entry);
    return entry;
  }

  // 동시 실행 방지(single-flight): entry가 선택 가능하고 아직 inflight가 아닐 때만 true.
  // entry 객체 기준으로 동작하므로, 중간에 종료/교체된 entry에 late endTurn이 와도
  // 현재 entry의 inflight를 잘못 건드리지 않는다.
  tryBeginTurn(entry) {
    if (!isSelectable(entry) || entry.inflight) return false;
    entry.inflight = true;
    entry.lastUsedAt = this._now();
    return true;
  }

  endTurn(entry) {
    if (!entry) return;
    entry.inflight = false;
    entry.lastUsedAt = this._now();
  }

  // 현재 logical session을 더 이상 선택하지 않게 한다(logical lifecycle 의미만).
  // C-2에는 native close semantics가 없다 — registry entry 상태만 바꾼다.
  invalidate(key, reason = null) {
    const entry = this._entries.get(key);
    if (!entry) return null;
    entry.lifecycle = LIFECYCLE.INVALIDATED;
    entry.invalidationReason = reason;
    return entry;
  }

  retire(key, reason = null) {
    const entry = this._entries.get(key);
    if (!entry) return null;
    entry.lifecycle = LIFECYCLE.RETIRED;
    entry.invalidationReason = reason;
    return entry;
  }
}

module.exports = { HarnessSessionRegistry, LIFECYCLE };
