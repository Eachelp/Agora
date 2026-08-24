"use strict";

// Stage D — end-to-end integration.
//
// 단위 테스트가 아니라 **실제 실패 모드**를 재현한다(Charter §34).
// 여기서 확인하는 것은 조각이 아니라 사슬이다:
//
//   Frozen Task v2 → Frozen Plan → Bound Inputs → Builder admission
//   → Assurance Subject → Verification → Disposition → Resolution
//   → recheck → Final PASS → provenance로 "왜 PASS였는가" 재구성
//
// 그리고 이 사슬이 **코딩 과업에만 종속되지 않는지**를 함께 본다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AssuranceRun, MODES } = require("../src/agora/assurance/assurance-run");
const { WorkspaceMutationLease } = require("../src/agora/workspace-mutation-lease");
const frozenContract = require("../src/agora/assurance/frozen-contract");

function tempRoot(prefix = "agora-e2e-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// 비코딩 과업: 원문을 읽어 보고서를 쓰고, 문서 구조와 행 수를 확인한다.
function translationTask({ inputs, deliverables, plan } = {}) {
  return [
    "## Goal\n번역 품질 보고서를 만든다.\n\n결정: D-12",
    `## Inputs / Source Data\n${inputs ?? "- `source.txt` (frozen)"}`,
    "## Requirements\n원문 대비 누락이 없어야 한다.",
    "## Work Approach\n문단 단위로 대조한다.",
    `## Deliverables\n${deliverables ?? "- `report.md`\n- `summary.csv`"}`,
    "## Acceptance Criteria\n누락 0건.",
    `## Verification Plan\n${plan ?? `\`\`\`json
[
  {"id":"V1","method":"predicate","statement":"보고서가 만들어졌다","check":{"kind":"exists","path":"report.md"}},
  {"id":"V2","method":"predicate","statement":"보고서에 결론 절이 있다","check":{"kind":"text.section","path":"report.md","expected":"결론"}},
  {"id":"V3","method":"predicate","statement":"요약에 2건 이상 있다","check":{"kind":"csv.rows","path":"summary.csv","operator":">=","expected":2}},
  {"id":"V4","method":"review","statement":"번역 논조가 원문과 맞는가"}
]
\`\`\``}`,
    "## Out of Scope\n원문 수정.",
  ].join("\n\n");
}

function setupWorkspace() {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "source.txt"), "원문 내용");
  return root;
}

function buildDeliverables(root) {
  fs.writeFileSync(path.join(root, "report.md"), "# 보고서\n\n## 결론\n누락 없음\n");
  fs.writeFileSync(path.join(root, "summary.csv"), "항목,결과\n용어,일치\n어투,일치\n");
}

async function runToVerification(root, taskContent = translationTask()) {
  const runDir = path.join(root, ".project-memory", "runs", "RUN-001");
  const run = new AssuranceRun({ runId: "RUN-001", runDir, root });
  const frozen = run.freeze(taskContent);
  assert.equal(frozen.ok, true, frozen.error);
  assert.equal(run.admitBuilder().ok, true);
  buildDeliverables(root);
  run.captureSubject({ changedPaths: ["report.md", "summary.csv"], changeObservation: "observed" });
  const verification = await run.verify({ workerPermission: "workspace-write" });
  return { run, verification };
}

// ---- 정상 경로 end-to-end (§40) ----

test("비코딩 과업이 계약→검증→판정→Final PASS까지 끝까지 흐른다", async () => {
  const root = setupWorkspace();
  try {
    const { run, verification } = await runToVerification(root);

    // 자동으로 확정된 것과 사람에게 남은 것이 분리된다.
    const byId = Object.fromEntries(verification.records.map((r) => [r.criterionId, r]));
    assert.equal(byId.V1.criterionOutcome, "PASS");
    assert.equal(byId.V1.actualDisposition, "VERIFIED");
    assert.equal(byId.V2.criterionOutcome, "PASS");
    assert.equal(byId.V3.criterionOutcome, "PASS");
    assert.equal(byId.V4.actualDisposition, "REVIEW_REQUIRED", "판단 항목은 자동 통과하지 않는다");

    // Reviewer 판단 전에는 Final PASS가 되지 않는다.
    assert.equal(run.finalize().finalPass, false);

    run.resolveByReviewer({ criterionId: "V4", outcome: "PASS", rationale: "원문 논조와 일치" });
    const final = run.finalize();
    assert.equal(final.finalPass, true, JSON.stringify(final.blockers));
    assert.equal(final.summary.automatic, 3);
    assert.equal(final.summary.review, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("'왜 PASS였는가'를 provenance만으로 재구성한다 (§29 · 시나리오 19)", async () => {
  const root = setupWorkspace();
  try {
    const { run } = await runToVerification(root);
    run.resolveByReviewer({ criterionId: "V4", outcome: "PASS" });
    run.finalize();
    run.recordRecorder({ ok: true });

    const explained = run.explain();
    assert.equal(explained.reconstructable, true);
    assert.deepEqual(explained.missingFacts, []);
    assert.equal(explained.finalVerdict, "PASS");
    assert.deepEqual(explained.decisionIds, ["D-12"], "토론 결정까지 이어진다 (M1)");
    assert.deepEqual(explained.inputs.map((i) => i.locator), ["source.txt"]);
    assert.deepEqual(explained.automatic.sort(), ["V1", "V2", "V3"]);
    assert.deepEqual(explained.reviewerJudged, [{ criterionId: "V4", outcome: "PASS" }]);
    assert.ok(explained.taskHash && explained.planHash && explained.capabilitySnapshotRef);
    assert.ok(explained.finalSubjectRef, "판정이 어떤 결과물에 붙었는지 알 수 있다");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 실패 모드 재현 ----

test("Builder도 Reviewer도 Frozen Verification Plan을 바꾸지 못한다 (시나리오 1 · INV-1)", async () => {
  const root = setupWorkspace();
  try {
    const { run } = await runToVerification(root);
    // Builder/Reviewer가 검사 항목을 지우려 한 상황을 그대로 재현한다.
    run.plan.criteria = run.plan.criteria.filter((c) => c.criterionId !== "V4");
    run.resolveByReviewer({ criterionId: "V4", outcome: "PASS" });

    const final = run.finalize();
    assert.equal(final.finalPass, false);
    assert.equal(final.blockers[0].reason, "PLAN_TAMPERED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frozen input이 바뀌면 Builder를 시작하지 않는다 (시나리오 2)", () => {
  const root = setupWorkspace();
  try {
    const runDir = path.join(root, ".project-memory", "runs", "RUN-001");
    const run = new AssuranceRun({ runId: "RUN-001", runDir, root });
    assert.equal(run.freeze(translationTask()).ok, true);

    fs.writeFileSync(path.join(root, "source.txt"), "누가 원문을 바꿈");
    const admitted = run.admitBuilder();
    assert.equal(admitted.ok, false);
    assert.equal(admitted.code, "FROZEN_INPUT_CHANGED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live input은 막지 않고 실제 사용만 기록한다 (시나리오 3)", () => {
  const root = setupWorkspace();
  try {
    const run = new AssuranceRun({
      runId: "RUN-001",
      runDir: path.join(root, "RUN-001"),
      root,
    });
    const frozen = run.freeze(translationTask({ inputs: "- https://example.com/rates (live)" }));
    assert.equal(frozen.ok, true, frozen.error);
    assert.equal(run.admitBuilder().ok, true, "live 입력은 admission을 막지 않는다");
    const binding = run.contract.inputBinding.bindings[0];
    assert.equal(binding.mode, "live");
    assert.equal(binding.state, "UNBOUND");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v1 Frozen Task는 제자리 변환되지 않고 legacy로 흐른다 (시나리오 4 · §6)", () => {
  const root = setupWorkspace();
  try {
    const v1 = [
      "## Goal\n목표", "## Requirements\n요구", "## Implementation Approach\n방법",
      "## Acceptance Criteria\n기준", "## Verification\n검증", "## Out of Scope\n제외",
    ].join("\n\n");
    const runDir = path.join(root, "RUN-001");
    const run = new AssuranceRun({ runId: "RUN-001", runDir, root });
    const frozen = run.freeze(v1);
    assert.equal(frozen.ok, true);
    assert.equal(frozen.mode, MODES.LEGACY);
    assert.equal(run.assured, false);
    // 계약 파일을 만들지 않았다 — 과거 계약을 다시 쓰지 않는다.
    assert.equal(fs.existsSync(frozenContract.contractPathFor(runDir)), false);
    // 그리고 아무것도 막지 않는다.
    assert.equal(run.admitBuilder().ok, true);
    assert.equal(run.finalize().finalPass, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("이 PC에 없는 도구는 VERIFIED가 아니라 UNSUPPORTED + 강등이다 (시나리오 6)", async () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[{"id":"V1","method":"process","statement":"통계 도구로 검산","executable":"agora-no-such-tool-xyz","argv":["run"]}]
\`\`\``;
    const { run, verification } = await runToVerification(root, translationTask({ plan }));
    const record = verification.records[0];
    assert.equal(record.criterionOutcome, "UNSUPPORTED");
    assert.equal(record.actualDisposition, "REVIEW_REQUIRED");
    assert.equal(record.plannedDisposition, "VERIFIED", "계획은 자동이었다");
    assert.ok(record.downgradeReason);

    // 강등된 채로는 Final PASS가 되지 않는다.
    assert.equal(run.finalize().finalPass, false);
    // Reviewer가 해소해야 통과하며, 못 했던 사실은 남는다(R-8).
    run.resolveByReviewer({ criterionId: "V1", outcome: "PASS" });
    assert.equal(run.finalize().finalPass, true);
    assert.equal(run.ledger.historyFor("V1")[0].criterionOutcome, "UNSUPPORTED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("자동검사 FAIL이면 Reviewer가 PASS라 해도 Final PASS가 아니다 (시나리오 9)", async () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[{"id":"V1","method":"predicate","statement":"출처 절이 있다","check":{"kind":"text.section","path":"report.md","expected":"출처"}}]
\`\`\``;
    const { run, verification } = await runToVerification(root, translationTask({ plan }));
    assert.equal(verification.records[0].criterionOutcome, "FAIL");
    assert.equal(verification.records[0].actualDisposition, "VERIFIED", "FAIL도 기계가 확정한 것이다 (R-7)");

    const final = run.finalize();
    assert.equal(final.finalPass, false);
    assert.equal(final.blockers[0].reason, "AUTOMATIC_FAIL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("사용자 승인이 남으면 Reviewer가 대신 통과시킬 수 없다 (시나리오 11)", async () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[{"id":"V1","method":"human","statement":"외부 발송 승인"}]
\`\`\``;
    const { run } = await runToVerification(root, translationTask({ plan }));

    run.resolveByReviewer({ criterionId: "V1", outcome: "PASS" });
    const stillBlocked = run.finalize();
    assert.equal(stillBlocked.finalPass, false, "Reviewer 판정으로 사용자 승인을 대신할 수 없다");

    run.resolveByHuman({ criterionId: "V1", outcome: "PASS" });
    assert.equal(run.finalize().finalPass, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("판정 후 결과물이 바뀌면 기존 PASS가 무효화된다 (시나리오 12·13 · INV-5)", async () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[{"id":"V1","method":"predicate","statement":"보고서 존재","check":{"kind":"exists","path":"report.md"}}]
\`\`\``;
    const { run, verification } = await runToVerification(root, translationTask({ plan }));
    assert.equal(verification.records[0].criterionOutcome, "PASS");

    // 외부 에디터가 결과물을 고친 상황(D-0 lease가 막지 못하는 변경).
    fs.writeFileSync(path.join(root, "report.md"), "# 누가 바꿈");
    const final = run.finalize();
    assert.equal(final.finalPass, false);
    assert.equal(final.verdict, "INVALIDATED");

    // 과거 PASS 기록은 지워지지 않는다(R-8).
    const history = run.ledger.historyFor("V1");
    assert.equal(history[0].criterionOutcome, "PASS");
    assert.equal(history[history.length - 1].criterionOutcome, "INVALIDATED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("검증 프로세스가 산출물을 건드리면 Builder 변경과 분리 기록된다 (시나리오 14)", async () => {
  const root = setupWorkspace();
  try {
    buildDeliverables(root);
    const target = path.join(root, "report.md");
    const plan = "```json\n" + JSON.stringify([{
      id: "V1",
      method: "process",
      statement: "검산 스크립트",
      executable: process.execPath,
      argv: ["-e", `require('fs').appendFileSync(${JSON.stringify(target)},'\\n검증기 흔적')`],
    }]) + "\n```";
    const { run } = await runToVerification(root, translationTask({ plan }));
    const record = run.lastVerification.records[0];
    assert.equal(record.evidence.sideEffects.accounted, true);
    assert.ok(record.evidence.sideEffects.changedPaths.includes("report.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planned와 actual의 차이가 Reviewer payload에 그대로 보인다 (시나리오 15 · R-3)", async () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[
  {"id":"V1","method":"predicate","statement":"엑셀 검산","check":{"kind":"xlsx","path":"book.xlsx","expected":1}},
  {"id":"V2","method":"predicate","statement":"보고서 존재","check":{"kind":"exists","path":"report.md"}}
]
\`\`\``;
    const { run } = await runToVerification(root, translationTask({ plan }));
    const payload = run.reviewerPayload();

    assert.equal(payload.downgrades.length, 1);
    assert.equal(payload.downgrades[0].criterionId, "V1");
    assert.equal(payload.downgrades[0].plannedDisposition, "VERIFIED");
    assert.equal(payload.downgrades[0].actualDisposition, "REVIEW_REQUIRED");
    // 자동 확정된 것과 판단이 남은 것이 합쳐지지 않는다(§9 P-2).
    assert.deepEqual(payload.automatic.map((a) => a.criterionId), ["V2"]);
    assert.deepEqual(payload.reviewRequired.map((r) => r.criterionId), ["V1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("D-0 lease 아래에서 검증이 실행되고 BUSY 의미가 유지된다 (시나리오 16·17)", async () => {
  const root = setupWorkspace();
  try {
    const lease = new WorkspaceMutationLease();
    const held = lease.acquire({
      resourceKind: "workspace", resourceId: root, holderId: "room-1", purpose: "professional-block",
    });
    assert.equal(held.ok, true);

    // 검증은 lease 소유권 안에서 돈다.
    const { run, verification } = await runToVerification(root);
    assert.equal(verification.records.length, 4);

    // 같은 workspace에 대한 다른 방의 변경은 여전히 BUSY다(기존 의미 회귀 없음).
    const other = lease.acquire({
      resourceKind: "workspace", resourceId: root, holderId: "room-2", purpose: "chat-turn",
    });
    assert.equal(other.ok, false);
    assert.equal(other.code, "BUSY");

    lease.release(held.token);
    run.resolveByReviewer({ criterionId: "V4", outcome: "PASS" });
    assert.equal(run.finalize().finalPass, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("입력·산출물이 명시적으로 '없음'인 과업도 막히지 않는다 (시나리오 20)", async () => {
  const root = tempRoot();
  try {
    const task = translationTask({
      inputs: "- 없음",
      deliverables: "- 없음",
      plan: `\`\`\`json
[{"id":"V1","method":"review","statement":"조사 결과가 질문에 답하는가"}]
\`\`\``,
    });
    const run = new AssuranceRun({ runId: "RUN-001", runDir: path.join(root, "RUN-001"), root });
    const frozen = run.freeze(task);
    assert.equal(frozen.ok, true, frozen.error);
    assert.equal(run.admitBuilder().ok, true);
    run.captureSubject({ changedPaths: [], changeObservation: "unsupported_non_git" });
    await run.verify({ workerPermission: "workspace-write" });

    assert.equal(run.finalize().finalPass, false, "판단 항목은 여전히 사람에게 간다");
    run.resolveByReviewer({ criterionId: "V1", outcome: "PASS" });
    assert.equal(run.finalize().finalPass, true);
    assert.equal(run.contract.inputs.state, "none");
    assert.equal(run.contract.deliverables.state, "none");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("동결된 계약과 판정 기록이 디스크에 남아 다시 읽힌다", async () => {
  const root = setupWorkspace();
  try {
    const { run } = await runToVerification(root);
    run.resolveByReviewer({ criterionId: "V4", outcome: "PASS" });
    run.finalize();
    assert.equal(run.persist().ok, true);

    const reloaded = AssuranceRun.load(run.runDir, { root });
    assert.ok(reloaded);
    assert.equal(reloaded.mode, MODES.ASSURED);
    assert.equal(reloaded.assuranceSubjectRef, run.assuranceSubjectRef);
    assert.equal(reloaded.plan.criteria.length, 4, "동결된 계획이 그대로 복원된다");
    assert.equal(reloaded.explain().finalVerdict, "PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("승인 화면 요약은 criterion을 생략하지 않고 처분 구성을 보존한다 (§9 P-1·P-2·P-3)", () => {
  const root = setupWorkspace();
  try {
    const plan = `\`\`\`json
[
  {"id":"V1","method":"predicate","statement":"보고서 존재","check":{"kind":"exists","path":"report.md"}},
  {"id":"V2","method":"review","statement":"논조 판단"},
  {"id":"V3","method":"human","statement":"외부 발송 승인"}
]
\`\`\``;
    const run = new AssuranceRun({ runId: "RUN-001", runDir: path.join(root, "RUN-001"), root });
    run.freeze(translationTask({ plan }));
    const summary = run.approvalSummary();

    assert.equal(summary.criteria.length, 3, "모든 criterion이 추적 가능해야 한다 (P-1)");
    assert.deepEqual(summary.composition, { automatic: 1, review: 1, human: 1 }, "처분 구성을 합치지 않는다 (P-2)");
    assert.equal(summary.plannedHumanApprovals.length, 1, "계획된 사용자 승인은 사전 예고한다 (P-3)");
    assert.ok(summary.replanNote.includes("있습니다"), "REPLAN 횟수는 약속하지 않는다");
    assert.ok(summary.inputs.items.length > 0, "Inputs는 압축본에도 보인다");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
