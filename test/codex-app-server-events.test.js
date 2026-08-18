"use strict";

// Stage C-3 — permission mapper + event normalizer + approval deny mapping.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapCodexTurnPolicy,
  CodexPolicyError,
  denyResponseFor,
  isApprovalRequest,
  classifyApprovalRequest,
  approvalDecisionResponse,
  approvalSummaryFrom,
  buildApprovalView,
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
  assert.deepEqual(denyResponseFor("item/permissions/requestApproval"), { permissions: {}, scope: "turn" });
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

// ---- Stage C: same-turn approval policy + response mapping ----

test("workspace-write + interactiveApproval은 on-request + approvalsReviewer=user + workspaceWrite sandbox", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-write", autoApprove: false, interactiveApproval: true, cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.equal(policy.approvalPolicy, "on-request");
  assert.equal(policy.approvalsReviewer, "user");
  assert.equal(policy.sandboxPolicy.type, "workspaceWrite");
});

test("workspace-write + interactiveApproval이라도 autoApprove면 danger/full-access(never) 유지", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-write", autoApprove: true, interactiveApproval: true, cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.deepEqual(policy.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.approvalsReviewer, undefined);
});

test("workspace-write에 승인 콜백이 없으면 fail-safe: never + workspaceWrite(자동 승인 아님)", () => {
  const policy = mapCodexTurnPolicy(
    { permissionMode: "workspace-write", autoApprove: false, interactiveApproval: false, cwd: "/ws", workspaceId: "/ws" },
    idRealpath
  );
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandboxPolicy.type, "workspaceWrite");
  assert.equal(policy.approvalsReviewer, undefined);
});

test("read-only 단계는 interactiveApproval이 있어도 never + readOnly(승인 escalation 없음)", () => {
  for (const mode of ["chat", "workspace-read"]) {
    const policy = mapCodexTurnPolicy(
      { permissionMode: mode, interactiveApproval: true, cwd: "/ws", workspaceId: "/ws" },
      idRealpath
    );
    assert.equal(policy.approvalPolicy, "never", mode);
    assert.equal(policy.sandboxPolicy.type, "readOnly", mode);
    assert.equal(policy.approvalsReviewer, undefined, mode);
  }
});

test("classifyApprovalRequest는 command/file/permissions/legacy/other를 구분한다", () => {
  assert.equal(classifyApprovalRequest("item/commandExecution/requestApproval"), "command");
  assert.equal(classifyApprovalRequest("item/fileChange/requestApproval"), "file");
  assert.equal(classifyApprovalRequest("item/permissions/requestApproval"), "permissions");
  assert.equal(classifyApprovalRequest("execCommandApproval"), "legacy");
  assert.equal(classifyApprovalRequest("applyPatchApproval"), "legacy");
  assert.equal(classifyApprovalRequest("item/tool/requestUserInput"), "other");
  assert.equal(classifyApprovalRequest("mcpServer/elicitation/request"), "other");
});

test("approvalDecisionResponse: approve=accept, deny=decline, cancel=cancel (ONE action)", () => {
  assert.deepEqual(approvalDecisionResponse("item/commandExecution/requestApproval", "accept"), { decision: "accept" });
  assert.deepEqual(approvalDecisionResponse("item/commandExecution/requestApproval", "decline"), { decision: "decline" });
  assert.deepEqual(approvalDecisionResponse("item/fileChange/requestApproval", "accept"), { decision: "accept" });
  assert.deepEqual(approvalDecisionResponse("item/fileChange/requestApproval", "cancel"), { decision: "cancel" });
  // 알 수 없는 decision은 안전하게 decline으로.
  assert.deepEqual(approvalDecisionResponse("item/commandExecution/requestApproval", "acceptForSession"), { decision: "decline" });
  // command/file이 아니면 null(이 매핑 대상 아님).
  assert.equal(approvalDecisionResponse("item/permissions/requestApproval", "accept"), null);
});

test("buildApprovalView: command는 params에서, file은 item context(변경 경로)에서 bounded view를 만든다", () => {
  const cmd = buildApprovalView("item/commandExecution/requestApproval", { command: ["rm", "-rf", "x"], cwd: "/ws", reason: "정리" }, null);
  assert.equal(cmd.usable, true);
  assert.match(cmd.summary, /rm -rf x/);
  assert.match(cmd.detail, /사유/);

  const file = buildApprovalView("item/fileChange/requestApproval", { reason: "수정" }, { kind: "file", paths: ["a.js", "src/b.js"] });
  assert.equal(file.usable, true);
  assert.match(file.summary, /2개 파일/);
  assert.match(file.detail, /a\.js/);
  assert.match(file.detail, /src\/b\.js/);

  // 변경 경로 context가 없으면 file은 usable=false (blind approve 방지 -> safe decline 대상).
  const blind = buildApprovalView("item/fileChange/requestApproval", { reason: "수정" }, null);
  assert.equal(blind.usable, false);
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
