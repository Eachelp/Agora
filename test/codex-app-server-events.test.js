"use strict";

// Stage C-3 — permission mapper + event normalizer + approval deny mapping.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapCodexTurnPolicy,
  CodexPolicyError,
  denyResponseFor,
  isApprovalRequest,
  approvalSummaryFrom,
  createCodexTurnCollector,
} = require("../src/harness/codex/codex-app-server-events");

const idRealpath = { realpath: (p) => p };

test("chat 권한은 read-only 샌드박스이고 cwd로 workspace를 노출하지 않는다", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "chat", cwd: "/chat-runtime", workspaceId: "/ws" },
    idRealpath
  );
  assert.deepEqual(policy.sandboxPolicy, { type: "readOnly" });
  assert.equal(policy.cwd, "/chat-runtime");
  assert.equal(policy.approvalPolicy, "never");
});

test("workspace-read는 read-only이고 realpath(cwd)===workspaceId를 요구한다", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-read", cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.deepEqual(policy.sandboxPolicy, { type: "readOnly" });
  assert.equal(policy.cwd, "/ws");
});

test("workspace-write(!auto)는 workspaceWrite + writableRoots=[cwd] + networkAccess=false", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-write", autoApprove: false, cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.equal(policy.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(policy.sandboxPolicy.writableRoots, ["/ws"]);
  assert.equal(policy.sandboxPolicy.networkAccess, false);
  assert.equal(policy.approvalPolicy, "never");
});

test("workspace-write(auto)는 dangerFullAccess (기존 bypass 등가)", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-write", autoApprove: true, cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.deepEqual(policy.sandboxPolicy, { type: "dangerFullAccess" });
});

test("잘못된 permission은 fail-closed(CODEX_PERMISSION_INVALID)", () => {
  assert.throws(
    () => mapCodexTurnPolicy({ permissionMode: "root", cwd: "/x" }, idRealpath),
    (e) => e instanceof CodexPolicyError && e.code === "CODEX_PERMISSION_INVALID"
  );
});

test("workspace cwd realpath 불일치는 fail-closed(CODEX_WORKSPACE_MISMATCH)", () => {
  assert.throws(
    () => mapCodexTurnPolicy(
      { permissionMode: "workspace-write", cwd: "/ws", workspaceId: "/other" },
      { realpath: (p) => p }
    ),
    (e) => e instanceof CodexPolicyError && e.code === "CODEX_WORKSPACE_MISMATCH"
  );
});

test("workspace 모드에 workspaceId가 없으면 fail-closed", () => {
  assert.throws(
    () => mapCodexTurnPolicy({ permissionMode: "workspace-read", cwd: "/ws", workspaceId: null }, idRealpath),
    (e) => e instanceof CodexPolicyError && e.code === "CODEX_WORKSPACE_MISMATCH"
  );
});

test("realpath 실패도 fail-closed", () => {
  assert.throws(
    () => mapCodexTurnPolicy(
      { permissionMode: "workspace-write", cwd: "/ws", workspaceId: "/ws" },
      { realpath: () => { throw new Error("ENOENT"); } }
    ),
    (e) => e instanceof CodexPolicyError && e.code === "CODEX_WORKSPACE_MISMATCH"
  );
});

test("approval deny 매핑은 설치 스키마의 유효한 decision을 사용한다", () => {
  assert.deepEqual(denyResponseFor("item/commandExecution/requestApproval"), { decision: "cancel" });
  assert.deepEqual(denyResponseFor("item/fileChange/requestApproval"), { decision: "cancel" });
  assert.deepEqual(denyResponseFor("execCommandApproval"), { decision: "abort" });
  assert.deepEqual(denyResponseFor("applyPatchApproval"), { decision: "abort" });
  assert.deepEqual(denyResponseFor("item/permissions/requestApproval"), { permissions: {} });
  assert.equal(isApprovalRequest("item/commandExecution/requestApproval"), true);
  assert.equal(isApprovalRequest("account/chatgptAuthTokens/refresh"), false);
});

test("approval summary/detail은 bounded하고 명령/위치/사유를 담는다", () => {
  const { summary, detail } = approvalSummaryFrom("item/commandExecution/requestApproval", {
    command: ["rm", "-rf", "x"], cwd: "/ws", reason: "삭제 필요",
  });
  assert.match(summary, /rm -rf x/);
  assert.match(detail, /사유/);
  assert.ok(summary.length <= 300 && detail.length <= 2000);
});

test("collector는 v2 notification을 canonical 이벤트로 정규화하고 trusted final을 잡는다", () => {
  const events = [];
  const c = createCodexTurnCollector({ onEvent: (e) => events.push(e) });
  c.ingest("item/agentMessage/delta", { delta: "부분" });
  c.ingest("item/started", { item: { type: "commandExecution", id: "c1", command: "ls" } });
  c.ingest("item/completed", { item: { type: "commandExecution", id: "c1", command: "ls", exitCode: 0, aggregatedOutput: "a.txt" } });
  c.ingest("item/completed", { item: { type: "agentMessage", id: "m1", text: "최종 답변" } });

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["delta", "command-started", "command-finished", "final"]);
  assert.equal(c.trustedFinal, "최종 답변");
  assert.equal(c.deltaText, "부분");
  const ev = c.buildEvidence();
  assert.equal(ev.commandSummary.total, 1);
  assert.equal(ev.commands.length, 1);
  assert.equal(ev.commands[0].kind, "command-finished");
  assert.equal(ev.commands[0].exitCode, 0);
});

test("collector error notification은 error 이벤트로 정규화된다", () => {
  const events = [];
  const c = createCodexTurnCollector({ onEvent: (e) => events.push(e) });
  c.ingest("error", { error: { message: "boom" } });
  assert.equal(events[0].kind, "error");
  assert.equal(c.lastError, "boom");
});
