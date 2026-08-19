"use strict";

// Stage C — Session Invalidation / Lifecycle: registry core semantics + Git HEAD fact probe.
//
// 검증 목표(요구 matrix A~E + registry 확장):
//   - ACTIVE → retire/invalidate → non-selectable, 재-acquire는 fresh generation.
//   - 종료된 old generation이 inflight이면 replacement generation을 만들지 않는다.
//   - late old-generation endTurn이 새 generation 상태를 오염시키지 않는다.
//   - structured identity metadata + matching/retireWhere/invalidateWhere.
//   - probeGitHead: non-Git=unsupported(정상) · Git+HEAD=ok(sha) · Git인데 판독 불가=error.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { HarnessSessionRegistry, LIFECYCLE } = require("../src/harness/harness-session-registry");
const { probeGitHead } = require("../src/harness/harness-session-lifecycle");

function reg() {
  let t = 0;
  return new HarnessSessionRegistry({ now: () => (t += 1) });
}

const IDENTITY = Object.freeze({
  projectId: "p1",
  workspaceId: "/ws/a",
  professionalRunId: "pr-1",
  role: "implementation",
  providerId: "claude",
  // 계정 미추적 조립(구형/테스트)은 null — 계정 namespace가 확정된 turn은
  // opaque stable key가 들어간다.
  providerAccountKey: null,
  modelKey: "sonnet",
  permissionMode: "workspace-write",
});

test("A. ACTIVE gen1 retire → non-selectable(tryBeginTurn 실패)", () => {
  const r = reg();
  const e = r.acquire("k", { identity: IDENTITY });
  assert.equal(e.lifecycle, LIFECYCLE.ACTIVE);
  r.retire("k", "MODEL_CHANGED");
  assert.equal(e.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(e.invalidationReason, "MODEL_CHANGED");
  assert.equal(r.tryBeginTurn(e), false);
});

test("B. retired(비-inflight) key 재-acquire → generation 2 fresh entry", () => {
  const r = reg();
  const a = r.acquire("k");
  r.retire("k", "PROFESSIONAL_RUN_ENDED");
  const b = r.acquire("k");
  assert.notEqual(b, a);
  assert.equal(b.generation, 2);
  assert.equal(b.lifecycle, LIFECYCLE.ACTIVE);
});

test("C. invalidated key 재-acquire → generation 2 fresh entry", () => {
  const r = reg();
  r.acquire("k");
  r.invalidate("k", "PROVIDER_ACCOUNT_CHANGED");
  const b = r.acquire("k");
  assert.equal(b.generation, 2);
  assert.equal(b.lifecycle, LIFECYCLE.ACTIVE);
});

test("D. late gen1 endTurn은 gen2의 inflight 상태를 바꾸지 않는다", () => {
  const r = reg();
  const g1 = r.acquire("k");
  assert.equal(r.tryBeginTurn(g1), true);
  r.retire("k", "WORKSPACE_CHANGED");
  r.endTurn(g1); // settle
  const g2 = r.acquire("k");
  assert.equal(g2.generation, 2);
  assert.equal(r.tryBeginTurn(g2), true);
  // gen1의 늦은(중복) endTurn — gen2 객체와 무관해야 한다.
  r.endTurn(g1);
  assert.equal(g2.inflight, true, "late gen1 endTurn이 gen2 inflight를 지우면 안 된다");
  assert.equal(g1.inflight, false);
});

test("E. 종료된 gen1이 inflight이면 acquire가 replacement를 만들지 않는다(settle 후 gen2)", () => {
  const r = reg();
  const g1 = r.acquire("k");
  assert.equal(r.tryBeginTurn(g1), true);
  r.invalidate("k", "PROVIDER_ACCOUNT_CHANGED");
  // inflight 중에는 종료된 entry를 그대로 돌려준다 → 호출자 lifecycle busy fail-closed.
  const blocked = r.acquire("k");
  assert.equal(blocked, g1);
  assert.equal(blocked.lifecycle, LIFECYCLE.INVALIDATED);
  assert.equal(r.size(), 1, "replacement generation이 생기면 안 된다");
  // settle 후에만 fresh generation 허용.
  r.endTurn(g1);
  const g2 = r.acquire("k");
  assert.equal(g2.generation, 2);
  assert.equal(g2.lifecycle, LIFECYCLE.ACTIVE);
});

test("identity metadata는 entry 생성 시 구조화 저장된다(문자열 파싱 없음)", () => {
  const r = reg();
  const e = r.acquire("k", { adapterId: "claude-managed", identity: { ...IDENTITY, extra: "무시" } });
  assert.deepEqual(e.identity, IDENTITY);
  assert.equal(Object.isFrozen(e.identity), true);
  // identity 없는 acquire는 null identity(테스트/legacy 경로)로 안전하다.
  const bare = r.acquire("k2");
  assert.equal(bare.identity, null);
});

test("matching은 identity 필드 equality로만 조회한다", () => {
  const r = reg();
  r.acquire("k1", { identity: IDENTITY });
  r.acquire("k2", { identity: { ...IDENTITY, role: "review" } });
  r.acquire("k3", { identity: { ...IDENTITY, professionalRunId: "pr-2" } });
  assert.equal(r.matching({ professionalRunId: "pr-1" }).length, 2);
  assert.equal(r.matching({ professionalRunId: "pr-1", role: "review" }).length, 1);
  assert.equal(r.matching({ providerId: "codex" }).length, 0);
  // identity가 없는 entry는 filter에 매치되지 않는다.
  r.acquire("k4");
  assert.equal(r.matching({ projectId: "p1" }).length, 3);
});

test("retireWhere/invalidateWhere는 ACTIVE만 종료하고 기존 종료 사유를 보존한다", () => {
  const r = reg();
  const a = r.acquire("k1", { identity: IDENTITY });
  const b = r.acquire("k2", { identity: { ...IDENTITY, role: "review" } });
  const c = r.acquire("k3", { identity: { ...IDENTITY, professionalRunId: "pr-2" } });
  r.invalidate("k2", "WORKSPACE_RESTORED");

  const affected = r.retireWhere({ professionalRunId: "pr-1" }, "GIT_HEAD_CHANGED");
  assert.deepEqual(affected.map((e) => e.key), ["k1"], "이미 종료된 k2는 다시 건드리지 않는다");
  assert.equal(a.lifecycle, LIFECYCLE.RETIRED);
  assert.equal(a.invalidationReason, "GIT_HEAD_CHANGED");
  assert.equal(b.invalidationReason, "WORKSPACE_RESTORED", "기존 사유 보존");
  assert.equal(c.lifecycle, LIFECYCLE.ACTIVE, "다른 run은 영향 없음");

  const invalidated = r.invalidateWhere({ professionalRunId: "pr-2" }, "PROVIDER_ACCOUNT_CHANGED");
  assert.deepEqual(invalidated.map((e) => e.key), ["k3"]);
  assert.equal(c.lifecycle, LIFECYCLE.INVALIDATED);
});

test("retireWhere(null filter)는 모든 ACTIVE entry를 종료한다(RUNTIME_CLOSED)", () => {
  const r = reg();
  r.acquire("k1", { identity: IDENTITY });
  r.acquire("k2");
  const affected = r.retireWhere(null, "RUNTIME_CLOSED");
  assert.equal(affected.length, 2);
  for (const e of r.entries()) {
    assert.equal(e.lifecycle, LIFECYCLE.RETIRED);
    assert.equal(e.invalidationReason, "RUNTIME_CLOSED");
  }
});

// ---- probeGitHead ----

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
}

test("probeGitHead: 비-Git workspace는 unsupported(정상 상태)", (t) => {
  const dir = tmpdir(t, "agora-head-plain-");
  assert.deepEqual(probeGitHead(dir), { status: "unsupported" });
  assert.deepEqual(probeGitHead(null), { status: "unsupported" });
  assert.deepEqual(probeGitHead(""), { status: "unsupported" });
});

test("probeGitHead: Git 저장소는 현재 HEAD sha를 fact로 돌려준다", (t) => {
  const dir = tmpdir(t, "agora-head-git-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "1", "utf8");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "c1"]);
  const expected = git(dir, ["rev-parse", "HEAD"]).trim();
  assert.deepEqual(probeGitHead(dir), { status: "ok", sha: expected });
  // working-tree-only 변경은 HEAD fact를 바꾸지 않는다.
  fs.writeFileSync(path.join(dir, "a.txt"), "2", "utf8");
  assert.deepEqual(probeGitHead(dir), { status: "ok", sha: expected });
});

test("probeGitHead: Git 저장소인데 HEAD를 확인할 수 없으면 error(fail-closed 대상)", (t) => {
  const dir = tmpdir(t, "agora-head-broken-");
  // .git이 존재하지만 유효한 저장소가 아니다 → rev-parse 실패 → error.
  fs.mkdirSync(path.join(dir, ".git"));
  assert.deepEqual(probeGitHead(dir), { status: "error" });
});
