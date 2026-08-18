"use strict";

// Stage C — memory-only role-scoped logical session registry.
//
// 이 registry는 persistent logical session의 "선택 대상"과 lifecycle 상태만 관리한다.
// authority 판단(workspace/Frozen Task/permission/account/run terminal 의미)은 위
// control plane과 HarnessRuntime lifecycle coordinator가 하고, registry는 결정된
// RETIRE/INVALIDATE를 상태로만 반영한다.
//
// 절대 계약:
//   - registry는 workspace/Frozen Task/permission authority를 갖지 않는다.
//   - invalidated/retired entry는 다시 선택되지 않는다(재사용/부활 금지).
//   - 같은 logical session에 동시 turn을 허용하지 않는다(single-flight).
//   - 종료된 old generation이 아직 inflight이면 같은 key의 새 generation을
//     만들지 않는다(acquire가 종료된 entry를 그대로 돌려줌 → 호출자 fail-closed).
//   - sessionless(ProcessHarnessAdapter) 실행을 억지로 entry로 만들지 않는다(호출자 책임).
//   - entry에는 생성 시점의 structured identity metadata를 저장한다. opaque
//     SessionKey 문자열을 나중에 parse해 identity를 복구하지 않는다.
//
// 범위 밖(넣지 않음): disk 영속, nativeSessionId, health, runtime/auth fingerprint,
// approval token, writer lease, runtime profile, idle GC 시스템, generic query framework.

const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  INVALIDATED: "invalidated",
  RETIRED: "retired",
});

// lifecycle query에 쓰는 bounded identity 필드(SessionKey 구성요소와 동일 집합).
const IDENTITY_FIELDS = Object.freeze([
  "projectId",
  "workspaceId",
  "professionalRunId",
  "role",
  "providerId",
  "modelKey",
  "permissionMode",
]);

function isSelectable(entry) {
  return Boolean(entry) && entry.lifecycle === LIFECYCLE.ACTIVE;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const result = {};
  for (const field of IDENTITY_FIELDS) {
    result[field] = identity[field] == null ? null : String(identity[field]);
  }
  return Object.freeze(result);
}

// filter의 모든 필드가 entry identity와 정확히 일치하는지(equality match만).
function matchesIdentity(entry, filter) {
  if (!filter || typeof filter !== "object") return true;
  const identity = entry.identity;
  if (!identity) return false;
  for (const [field, value] of Object.entries(filter)) {
    if (!IDENTITY_FIELDS.includes(field)) return false;
    if (identity[field] !== (value == null ? null : String(value))) return false;
  }
  return true;
}

class HarnessSessionRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._entries = new Map(); // key -> entry (key당 최신 generation 하나만 보관)
  }

  get(key) {
    return this._entries.get(key) || null;
  }

  size() {
    return this._entries.size;
  }

  entries() {
    return [...this._entries.values()];
  }

  // filter의 identity 필드와 모두 일치하는 entry 목록. 상태 무관(호출자가 lifecycle 확인).
  matching(filter) {
    return this.entries().filter((entry) => matchesIdentity(entry, filter));
  }

  // 선택 가능한 active entry를 돌려준다. 없거나 기존 entry가 종료 상태(invalidated/
  // retired)면 새 active entry를 만든다. 종료된 entry를 대체할 때는 generation을 올려
  // 연속성이 끊겼음을 드러낸다(옛 entry 객체는 종료 상태 그대로 남는다 = 재사용 안 됨).
  //
  // 단, 종료된 old generation이 아직 inflight이면 replacement generation을 만들지
  // 않고 종료된 entry를 그대로 돌려준다. 그래야 old turn과 새 generation이 같은
  // workspace를 동시에 수정하는 race가 생기지 않는다(호출자는 lifecycle busy로
  // fail-closed한다). old turn이 settle(endTurn)한 뒤에만 새 generation이 생긴다.
  acquire(key, { adapterId = null, identity = null } = {}) {
    const existing = this._entries.get(key) || null;
    if (isSelectable(existing)) return existing;
    if (existing && existing.inflight) return existing;
    const now = this._now();
    const entry = {
      key,
      adapterId,
      identity: normalizeIdentity(identity),
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
  // native cache cleanup은 runtime이 adapter hook(forgetSession)으로 지시한다.
  invalidate(key, reason = null) {
    return this._terminate(this._entries.get(key), LIFECYCLE.INVALIDATED, reason);
  }

  retire(key, reason = null) {
    return this._terminate(this._entries.get(key), LIFECYCLE.RETIRED, reason);
  }

  // identity filter와 일치하는 ACTIVE entry를 일괄 종료하고 영향받은 entry 목록을
  // 돌려준다. 이미 종료된 entry는 원래 사유를 보존한다(덮어쓰지 않음).
  retireWhere(filter, reason = null) {
    return this._terminateWhere(filter, LIFECYCLE.RETIRED, reason);
  }

  invalidateWhere(filter, reason = null) {
    return this._terminateWhere(filter, LIFECYCLE.INVALIDATED, reason);
  }

  _terminate(entry, lifecycle, reason) {
    if (!entry) return null;
    entry.lifecycle = lifecycle;
    entry.invalidationReason = reason;
    return entry;
  }

  _terminateWhere(filter, lifecycle, reason) {
    const affected = [];
    for (const entry of this._entries.values()) {
      if (entry.lifecycle !== LIFECYCLE.ACTIVE) continue;
      if (!matchesIdentity(entry, filter)) continue;
      this._terminate(entry, lifecycle, reason);
      affected.push(entry);
    }
    return affected;
  }
}

module.exports = { HarnessSessionRegistry, LIFECYCLE };
