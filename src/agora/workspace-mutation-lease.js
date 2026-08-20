"use strict";

// Stage D-0 — Workspace Mutation Lease (memory-only)
//
// canonical workspace 하나를 동시에 변경하는 주체가 둘 이상이 되지 않게 막는다.
// 이것은 Git lock이 아니라 canonical workspace **identity** lock이다. Git이 없는
// workspace(비코딩 과업 포함)도 동일하게 보호한다.
//
// 참여자(AGORA_STAGE_D_ASSURANCE_CHARTER.md D-0):
//   1. Professional 실행의 mutation~판정 구간 (이후 verification 실행 포함)
//   2. Checkpoint restore
//   3. workspace-write 일반 채팅 turn
//
// 확정된 계약:
//   - 충돌은 fail-closed(BUSY)다. 대기열도 강탈도 없다.
//   - memory-only다. 앱이 죽으면 lease도 사라진다(stale lock 없음).
//   - 같은 holder는 재진입할 수 있다(depth). Professional 실행이 lease를 쥔 채
//     내부에서 checkpoint restore를 호출하는 정상 경로가 교착되면 안 되기 때문이다.
//   - 이 모듈은 authority를 갖지 않는다. 무엇이 canonical workspace인지, 누가
//     writer 자격이 있는지는 control plane이 판단하고, 여기서는 소유권만 관리한다.
//   - resourceKind는 일반화 가능한 모양으로 받되 workspace만 지원한다. 다른 kind는
//     조용히 통과시키지 않고 거부한다(범용 Resource Registry는 D-B 범위다).
//
// 범위 밖(넣지 않음): disk 영속, cross-process governance(단일 main process 보증
// 경계 밖 — main.js requestSingleInstanceLock이 그 경계를 뒷받침한다), 대기열,
// 우선순위, timeout 기반 자동 회수, 외부 자원(DB/Drive/외부 API) lease.

const path = require("node:path");

const SUPPORTED_RESOURCE_KINDS = Object.freeze(["workspace"]);

const LEASE_ERRORS = Object.freeze({
  UNSUPPORTED_RESOURCE_KIND: "UNSUPPORTED_RESOURCE_KIND",
  INVALID_RESOURCE: "INVALID_RESOURCE",
  INVALID_HOLDER: "INVALID_HOLDER",
  BUSY: "BUSY",
});

const LEASE_EVENTS = Object.freeze({
  ACQUIRED: "lease-acquired",
  REENTERED: "lease-reentered",
  DENIED: "lease-denied",
  RELEASED: "lease-released",
});

let leaseSeq = 0;

function newLeaseId(now) {
  leaseSeq += 1;
  return `wsl-${now.toString(36)}-${leaseSeq.toString(36)}`;
}

function cleanString(value, limit = 200) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, limit) : null;
}

// canonical workspace identity key.
// 같은 폴더를 가리키는 서로 다른 표기(후행 구분자, 대소문자, 상대 경로 조각)가
// 서로 다른 자원으로 보이면 one-writer 보증이 그대로 뚫린다.
function normalizeResourceId(resourceKind, resourceId) {
  const raw = cleanString(resourceId, 4096);
  if (!raw) return null;
  if (resourceKind !== "workspace") return raw;
  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch {
    return null;
  }
  // Windows 파일 시스템은 대소문자를 구분하지 않으므로 같은 폴더로 접어야 한다.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function publicHolder(entry) {
  if (!entry) return null;
  return Object.freeze({
    leaseId: entry.leaseId,
    resourceKind: entry.resourceKind,
    resourceId: entry.resourceId,
    holderId: entry.holderId,
    runId: entry.runId,
    role: entry.role,
    purpose: entry.purpose,
    acquiredAt: entry.acquiredAt,
    depth: entry.depth,
  });
}

class WorkspaceMutationLease {
  constructor({ now = () => Date.now(), onEvent = null } = {}) {
    this.now = now;
    // D-C provenance seam. lease 결정은 "결정 시점"에 기록되어야 하며, 나중에
    // 소급 재구성하지 않는다. 저장은 이 모듈의 책임이 아니다(호출자가 주입).
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this._entries = new Map();
    // token → { key, leaseId } — release가 자기 acquire만 되돌리게 한다.
    this._tokens = new Map();
    this._tokenSeq = 0;
  }

  _emit(type, payload) {
    if (!this.onEvent) return;
    try {
      this.onEvent({ type, at: this.now(), ...payload });
    } catch {
      // provenance 기록 실패가 mutation 통제를 무너뜨리면 안 된다.
    }
  }

  _newToken(key, leaseId) {
    this._tokenSeq += 1;
    const token = `${leaseId}#${this._tokenSeq.toString(36)}`;
    this._tokens.set(token, { key, leaseId });
    return token;
  }

  // { ok: true, token, lease } | { ok: false, code, holder?, error }
  acquire({
    resourceKind = "workspace",
    resourceId,
    holderId,
    runId = null,
    role = null,
    purpose = null,
  } = {}) {
    const kind = cleanString(resourceKind, 40);
    if (!kind || !SUPPORTED_RESOURCE_KINDS.includes(kind)) {
      return {
        ok: false,
        code: LEASE_ERRORS.UNSUPPORTED_RESOURCE_KIND,
        error: `지원하지 않는 자원 종류입니다: ${resourceKind}`,
      };
    }
    const key = normalizeResourceId(kind, resourceId);
    if (!key) {
      return {
        ok: false,
        code: LEASE_ERRORS.INVALID_RESOURCE,
        error: "변경 대상 workspace를 확인할 수 없습니다.",
      };
    }
    const holder = cleanString(holderId, 200);
    if (!holder) {
      return {
        ok: false,
        code: LEASE_ERRORS.INVALID_HOLDER,
        error: "변경 주체를 확인할 수 없습니다.",
      };
    }

    const at = this.now();
    const existing = this._entries.get(key);

    if (existing && existing.holderId !== holder) {
      this._emit(LEASE_EVENTS.DENIED, {
        resourceKind: kind,
        resourceId: key,
        holderId: holder,
        runId: cleanString(runId, 200),
        role: cleanString(role, 80),
        purpose: cleanString(purpose, 200),
        heldBy: publicHolder(existing),
      });
      return {
        ok: false,
        code: LEASE_ERRORS.BUSY,
        holder: publicHolder(existing),
        error: "같은 작업 폴더를 다른 실행이 변경하고 있습니다.",
      };
    }

    if (existing) {
      // 같은 holder의 재진입: 정상 경로(예: 전문 실행 중 checkpoint restore)다.
      existing.depth += 1;
      const token = this._newToken(key, existing.leaseId);
      this._emit(LEASE_EVENTS.REENTERED, {
        ...publicHolder(existing),
        purpose: cleanString(purpose, 200),
      });
      return { ok: true, token, lease: publicHolder(existing), reentered: true };
    }

    const entry = {
      leaseId: newLeaseId(at),
      resourceKind: kind,
      resourceId: key,
      holderId: holder,
      runId: cleanString(runId, 200),
      role: cleanString(role, 80),
      purpose: cleanString(purpose, 200),
      acquiredAt: at,
      depth: 1,
    };
    this._entries.set(key, entry);
    const token = this._newToken(key, entry.leaseId);
    this._emit(LEASE_EVENTS.ACQUIRED, publicHolder(entry));
    return { ok: true, token, lease: publicHolder(entry), reentered: false };
  }

  // 같은 token으로 두 번 불러도 안전하다(두 번째부터는 무시).
  release(token) {
    const key = cleanString(token, 200);
    if (!key) return false;
    const ref = this._tokens.get(key);
    if (!ref) return false;
    this._tokens.delete(key);
    const entry = this._entries.get(ref.key);
    // 이미 releaseAllFor 등으로 사라진 lease의 잔여 token은 무시한다.
    if (!entry || entry.leaseId !== ref.leaseId) return false;
    entry.depth -= 1;
    if (entry.depth > 0) return true;
    this._entries.delete(ref.key);
    this._emit(LEASE_EVENTS.RELEASED, publicHolder({ ...entry, depth: 0 }));
    return true;
  }

  // 방(세션)이 닫히거나 실행이 비정상 종료했을 때의 정리 경로.
  // depth와 무관하게 해당 holder의 lease를 모두 해제한다.
  releaseAllFor(holderId) {
    const holder = cleanString(holderId, 200);
    if (!holder) return 0;
    let released = 0;
    for (const [key, entry] of [...this._entries]) {
      if (entry.holderId !== holder) continue;
      this._entries.delete(key);
      released += 1;
      this._emit(LEASE_EVENTS.RELEASED, {
        ...publicHolder({ ...entry, depth: 0 }),
        forced: true,
      });
    }
    if (released > 0) {
      for (const [token, ref] of [...this._tokens]) {
        if (!this._entries.has(ref.key)) this._tokens.delete(token);
      }
    }
    return released;
  }

  holderOf(resourceId, resourceKind = "workspace") {
    const key = normalizeResourceId(cleanString(resourceKind, 40) || "workspace", resourceId);
    if (!key) return null;
    return publicHolder(this._entries.get(key));
  }

  isHeld(resourceId, resourceKind = "workspace") {
    return Boolean(this.holderOf(resourceId, resourceKind));
  }

  // 진단/테스트용 스냅샷. 사용자 표면에 그대로 노출하지 않는다(§9 P-1~P-4).
  list() {
    return [...this._entries.values()].map((entry) => publicHolder(entry));
  }
}

module.exports = {
  WorkspaceMutationLease,
  SUPPORTED_RESOURCE_KINDS,
  LEASE_ERRORS,
  LEASE_EVENTS,
  normalizeResourceId,
};
