"use strict";

// Stage D-A1 — Assurance Contract.
//
// 검증 목표(AGORA_STAGE_D_ASSURANCE_CHARTER.md):
//   INV-1  Verification Plan은 실행 전에 승인·동결되며 이후 아무도 못 고친다.
//   INV-3  기계가 확정 못 하는 criterion은 VERIFIED로 계획되지 않는다.
//   §3.1   frozen 입력은 기록만 하는 것이 아니라 재대조한다.
//          생략과 "없음"은 다른 의미다.
//   §4     M1 — 토론 결정과 Frozen Task가 연결된다.
//   §6     이미 동결된 v1 계약을 제자리 변환하지 않는다.
//   Agora는 코딩 전용 도구가 아니다 — 비코딩 과업이 같은 경로로 흘러야 한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const taskSchema = require("../src/agora/assurance/task-schema-v2");
const verificationPlan = require("../src/agora/assurance/verification-plan");
const inputBinding = require("../src/agora/assurance/input-binding");
const frozenContract = require("../src/agora/assurance/frozen-contract");

function tempRoot(prefix = "agora-da1-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const PLAN_JSON = `\`\`\`json
[
  {"id":"V1","method":"process","statement":"전체 테스트 통과","executable":"npm","argv":["test"]},
  {"id":"V2","method":"predicate","statement":"보고서 존재","check":{"kind":"exists","path":"report.md"}},
  {"id":"V3","method":"review","statement":"논조가 요구사항에 부합"},
  {"id":"V4","method":"human","statement":"외부 발송 승인"}
]
\`\`\``;

function taskV2(overrides = {}) {
  const s = {
    goal: "번역 품질 보고서를 만든다.",
    inputs: "- `source/ko.txt` (frozen)\n- https://api.example.com/rates (live)",
    requirements: "원문 대비 누락 없음.",
    workApproach: "문단 단위로 대조한다.",
    deliverables: "- `report.md`",
    acceptance: "누락 0건.",
    verification: PLAN_JSON,
    outOfScope: "원문 수정.",
    ...overrides,
  };
  return [
    `## Goal\n${s.goal}`,
    `## Inputs / Source Data\n${s.inputs}`,
    `## Requirements\n${s.requirements}`,
    `## Work Approach\n${s.workApproach}`,
    `## Deliverables\n${s.deliverables}`,
    `## Acceptance Criteria\n${s.acceptance}`,
    `## Verification Plan\n${s.verification}`,
    `## Out of Scope\n${s.outOfScope}`,
  ].join("\n\n");
}

// ---- Task schema v2 ----

test("v2 계약은 비코딩 과업(번역 보고서)에서도 그대로 성립한다", () => {
  const parsed = taskSchema.parseTaskV2(taskV2());
  assert.equal(parsed.valid, true, parsed.missing.join(", "));
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.inputs.state, "declared");
  assert.equal(parsed.deliverables.items[0].locator, "report.md");
});

test("v1 어휘(Implementation Approach / Verification)를 읽되 v2 이름으로 해석한다", () => {
  const content = taskV2()
    .replace("## Work Approach", "## Implementation Approach")
    .replace("## Verification Plan", "## Verification");
  const parsed = taskSchema.parseTaskV2(content);
  assert.equal(parsed.valid, true, parsed.missing.join(", "));
  const aliases = parsed.usedAliases.map((a) => a.alias);
  assert.ok(aliases.includes("implementationapproach"));
  assert.ok(aliases.includes("verification"));
});

test("생략과 '없음'은 다른 의미다", () => {
  const none = taskSchema.parseTaskV2(taskV2({ inputs: "- 없음" }));
  assert.equal(none.valid, true);
  assert.equal(none.inputs.state, "none");
  assert.deepEqual(none.inputs.items, []);

  const omitted = taskSchema.parseTaskV2(
    taskV2().replace(/## Inputs \/ Source Data\n[^#]*/, "")
  );
  assert.equal(omitted.valid, false, "입력 섹션 생략은 계약 불완전이다");
  assert.ok(omitted.missing.some((m) => m.startsWith("Inputs")));
});

test("입력 mode 기본값은 파일=frozen, URL=live다", () => {
  const parsed = taskSchema.parseTaskV2(taskV2({ inputs: "- `data/a.csv`\n- https://example.com/x" }));
  assert.equal(parsed.inputs.items[0].mode, "frozen");
  assert.equal(parsed.inputs.items[1].mode, "live");
});

test("M1 — 토론 결정 id가 Frozen Task에 연결된다", () => {
  const parsed = taskSchema.parseTaskV2(taskV2({ goal: "보고서 작성\n\n결정: D-12, D-15" }));
  assert.deepEqual(parsed.decisionIds.sort(), ["D-12", "D-15"]);
});

test("v1 문서를 v2로 가장하지 않는다", () => {
  const v1 = "## Goal\n목표\n\n## Requirements\n요구\n\n## Implementation Approach\n방법\n\n## Acceptance Criteria\n기준\n\n## Verification\n검증\n\n## Out of Scope\n제외";
  assert.equal(taskSchema.detectSchemaVersion(v1), 1);
  assert.equal(taskSchema.detectSchemaVersion(taskV2()), 2);
});

test("canonicalize는 표기 차이를 흡수하되 내용은 바꾸지 않는다", () => {
  const a = taskSchema.canonicalizeTaskContent("## Goal\r\n목표   \r\n\r\n\r\n\r\n## X\n본문");
  const b = taskSchema.canonicalizeTaskContent("## Goal\n목표\n\n## X\n본문");
  assert.equal(a, b);
  assert.ok(a.includes("목표"));
});

// ---- Verification Plan ----

test("구조화된 계획은 criterion 단위로 읽힌다", () => {
  const plan = verificationPlan.parseVerificationPlan(PLAN_JSON);
  assert.equal(plan.ok, true);
  assert.equal(plan.structured, true);
  assert.equal(plan.criteria.length, 4);
  assert.equal(plan.criteria[0].plannedMethod, "process");
  assert.equal(plan.criteria[0].step.executable, "npm");
});

test("method가 계획 처분을 정한다 — Plan의 자기 선언을 믿지 않는다", () => {
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"review","statement":"판단","plannedDisposition":"VERIFIED"}]
\`\`\``);
  assert.equal(plan.criteria[0].plannedDisposition, "REVIEW_REQUIRED");
});

test("산문 계획은 실패가 아니라 Reviewer 판단으로 강등된다 (R-4)", () => {
  const plan = verificationPlan.parseVerificationPlan("테스트를 돌리고 결과를 확인한다.");
  assert.equal(plan.ok, true);
  assert.equal(plan.structured, false);
  assert.equal(plan.criteria[0].plannedMethod, "review");
  assert.ok(plan.notes.length > 0, "강등 사실이 기록되어야 한다");
});

test("계획 단계에서도 셸 문자열을 실행 선언에 넣을 수 없다", () => {
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"process","statement":"x","executable":"npm test && rm -rf /"}]
\`\`\``);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /셸/);
});

test("criterion id 중복은 거부한다", () => {
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"review","statement":"a"},{"id":"V1","method":"review","statement":"b"}]
\`\`\``);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /중복/);
});

test("planHash는 표기가 아니라 의미에 붙는다", () => {
  const a = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"review","statement":"판단"}]
\`\`\``);
  const b = verificationPlan.parseVerificationPlan(`\`\`\`json
[  {"statement":"판단",   "method":"review",  "id":"V1"}  ]
\`\`\``);
  assert.equal(a.planHash, b.planHash);

  const c = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"review","statement":"다른 판단"}]
\`\`\``);
  assert.notEqual(a.planHash, c.planHash);
});

test("계획 요약은 처분 구성을 합치지 않는다 (§9 P-2)", () => {
  const plan = verificationPlan.parseVerificationPlan(PLAN_JSON);
  const summary = verificationPlan.summarizePlan(plan);
  assert.deepEqual(
    { total: summary.total, automatic: summary.automatic, review: summary.review, human: summary.human },
    { total: 4, automatic: 2, review: 1, human: 1 }
  );
  assert.equal(summary.plannedHumanApprovals.length, 1, "계획된 사용자 승인은 사전 예고 대상이다");
});

// ---- Input binding ----

test("frozen 입력은 지문을 남기고 live 입력은 남기지 않는다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "a.csv"), "x,y\n1,2\n");
    const binding = inputBinding.bindInputs(
      [
        { inputId: "IN-01", locator: "a.csv", kind: "path", mode: "frozen" },
        { inputId: "IN-02", locator: "https://example.com/r", kind: "url", mode: "live" },
      ],
      { root }
    );
    assert.equal(binding.bindings[0].state, "BOUND");
    assert.ok(binding.bindings[0].sha256);
    assert.equal(binding.bindings[1].state, "UNBOUND");
    assert.equal(binding.bindings[1].sha256, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frozen 입력이 바뀌면 재대조가 잡는다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "a.csv");
    fs.writeFileSync(file, "원본");
    const binding = inputBinding.bindInputs(
      [{ inputId: "IN-01", locator: "a.csv", kind: "path", mode: "frozen" }],
      { root }
    );
    assert.equal(inputBinding.recheckFrozenInputs(binding, { root }).ok, true);

    fs.writeFileSync(file, "바뀐 내용");
    const after = inputBinding.recheckFrozenInputs(binding, { root });
    assert.equal(after.ok, false);
    assert.equal(after.changed[0].result, "MISMATCH");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frozen 입력이 사라져도 잡는다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "a.csv");
    fs.writeFileSync(file, "원본");
    const binding = inputBinding.bindInputs(
      [{ inputId: "IN-01", locator: "a.csv", kind: "path", mode: "frozen" }],
      { root }
    );
    fs.rmSync(file);
    const after = inputBinding.recheckFrozenInputs(binding, { root });
    assert.equal(after.ok, false);
    assert.equal(after.changed[0].result, "DISAPPEARED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live 입력은 재대조 대상이 아니고 실제 사용만 기록한다", () => {
  const binding = inputBinding.bindInputs(
    [{ inputId: "IN-01", locator: "https://example.com/r", kind: "url", mode: "live" }],
    {}
  );
  const recheck = inputBinding.recheckFrozenInputs(binding, {});
  assert.equal(recheck.ok, true);
  assert.equal(recheck.results[0].result, "SKIPPED");

  const rec = inputBinding.recordLiveRetrieval(binding, "IN-01", { etag: "W/\"v3\"", version: "3" });
  assert.equal(rec.ok, true);
  assert.equal(binding.bindings[0].retrievals[0].etag, "W/\"v3\"");
});

test("frozen으로 선언된 URL은 조용히 live로 바꾸지 않고 지원 불가로 남긴다", () => {
  const binding = inputBinding.bindInputs(
    [{ inputId: "IN-01", locator: "https://example.com/r", kind: "url", mode: "frozen" }],
    {}
  );
  assert.equal(binding.bindings[0].state, "UNSUPPORTED");
  assert.equal(binding.bindings[0].reason, "frozen-url-unsupported");
});

// ---- Frozen contract ----

test("승인 시점에 계약이 동결되고 hash가 고정된다", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "source"), { recursive: true });
    fs.writeFileSync(path.join(root, "source", "ko.txt"), "원문");
    const built = frozenContract.buildFrozenContract(taskV2(), { root });
    assert.equal(built.ok, true, built.error);
    assert.ok(built.contract.taskHash);
    assert.ok(built.contract.verificationPlan.planHash);
    assert.ok(built.contract.contractHash);
    assert.equal(built.contract.verificationPlan.criteria.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("승인된 입력이 애초에 없으면 계약이 성립하지 않는다", () => {
  const root = tempRoot();
  try {
    const built = frozenContract.buildFrozenContract(taskV2(), { root });
    assert.equal(built.ok, false);
    assert.equal(built.code, "FROZEN_INPUT_MISSING");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("동결된 계약은 재동결되지 않는다 (INV-1)", () => {
  const root = tempRoot();
  try {
    const runDir = path.join(root, "RUN-001");
    const contract = { schemaVersion: 1, taskHash: "a", contractHash: "b" };
    assert.equal(frozenContract.freezeContract(runDir, contract).ok, true);
    const second = frozenContract.freezeContract(runDir, contract);
    assert.equal(second.ok, false);
    assert.equal(second.code, "ALREADY_FROZEN");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("동결 계약이 손상되면 현재 Task로 fallback하지 않는다", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "source"), { recursive: true });
    fs.writeFileSync(path.join(root, "source", "ko.txt"), "원문");
    const runDir = path.join(root, "RUN-001");
    const built = frozenContract.buildFrozenContract(taskV2(), { root });
    frozenContract.freezeContract(runDir, built.contract);

    const file = frozenContract.contractPathFor(runDir);
    const tampered = JSON.parse(fs.readFileSync(file, "utf8"));
    tampered.verificationPlan.criteria.pop();
    tampered.verificationPlan.planHash = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(tampered));

    const read = frozenContract.readFrozenContract(runDir);
    assert.equal(read.ok, false);
    assert.equal(read.code, "CONTRACT_CORRUPTED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("frozen 입력이 달라지면 Builder를 시작하지 않는다 (§3.1)", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "source"), { recursive: true });
    const src = path.join(root, "source", "ko.txt");
    fs.writeFileSync(src, "원문");
    const built = frozenContract.buildFrozenContract(taskV2(), { root });
    assert.equal(frozenContract.admitBuilder(built.contract, { root }).ok, true);

    fs.writeFileSync(src, "누가 바꿈");
    const denied = frozenContract.admitBuilder(built.contract, { root });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "FROZEN_INPUT_CHANGED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Frozen Verification Plan이 실행 중 바뀌면 무결성 검사가 잡는다 (INV-1)", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "source"), { recursive: true });
    fs.writeFileSync(path.join(root, "source", "ko.txt"), "원문");
    const built = frozenContract.buildFrozenContract(taskV2(), { root });
    const plan = { criteria: built.contract.verificationPlan.criteria };
    assert.equal(frozenContract.verifyPlanIntegrity(built.contract, plan).ok, true);

    // Builder/Reviewer가 검사 항목을 지우려 시도한 상황.
    const tampered = { criteria: plan.criteria.slice(0, 2) };
    assert.equal(frozenContract.verifyPlanIntegrity(built.contract, tampered).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 계획을 쓰는 것은 사람이 아니라 Planner다. `["--limit", 100]`처럼 숫자 인자를 쓰는
// 계획이 흔한데, 이걸 거부하면 사용자가 손댈 수 없는 이유로 실행 전체가 막힌다.
// 셸을 거치지 않으므로 숫자·불리언은 문자열 형태가 하나뿐이라 그대로 확정해도 된다.
test("process criterion의 숫자·불리언 인자는 문자열로 확정한다", () => {
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V1","method":"process","statement":"표본 검사","executable":"python","argv":["run.py","--limit",100,"--strict",true]}]
\`\`\``);
  assert.equal(plan.ok, true, plan.error);
  assert.deepEqual(plan.criteria[0].step.argv, ["run.py", "--limit", "100", "--strict", "true"]);
});

// 모양이 정해지지 않는 값은 계속 거부하되, 어느 항목의 몇 번째 인자인지 밝힌다.
// 그렇지 않으면 사용자는 고칠 곳을 찾을 수 없다.
test("모양이 없는 실행 인자는 거부하고 위치를 알려준다", () => {
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V7","method":"process","statement":"검사","executable":"python","argv":["run.py",{"a":1}]}]
\`\`\``);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /V7/);
  assert.match(plan.error, /2번째/);
});

// `python -c`에 여러 줄 스크립트를 넘기는 것은 정상적인 검사 형태다. runner가
// shell:false로 spawn하므로 인자는 셸 해석을 거치지 않고, 줄바꿈을 막으면 계획이
// 읽기 어려운 한 줄짜리로 몰릴 뿐 같은 일을 그대로 할 수 있다. NUL만 거부한다.
test("여러 줄 스크립트를 실행 인자로 넘길 수 있다", () => {
  const script = "import json\np='out/manifest.json'\nm=json.load(open(p,encoding='utf-8'))\nassert m['ok']\n";
  const plan = verificationPlan.parseVerificationPlan(`\`\`\`json
[{"id":"V6","method":"process","statement":"매니페스트 확인","executable":"python","argv":["-c",${JSON.stringify(script)}]}]
\`\`\``);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.criteria[0].step.argv[1], script);
});

// 64MB를 넘는 입력을 frozen으로 선언하면 지문을 못 떠 "확인할 수 없음"이 되고
// 계약 자체가 성립하지 않았다. 실제로는 확인할 수 있는 파일인데 readFileSync가
// 통째로 읽는 방식이라 상한을 낮게 둔 것이었다. 청크로 읽어 해시한다.
test("64MB를 넘는 frozen 입력도 지문을 뜬다", () => {
  const { sha256FileSync, MAX_DIGEST_BYTES, CHUNK_BYTES } = require("../src/agora/assurance/file-digest");
  const root = tempRoot("agora-bigfile-");
  try {
    // 청크 경계를 넘겨 마지막 부분 청크까지 해시에 들어가는지 확인한다.
    const size = CHUNK_BYTES * 2 + 12345;
    const file = path.join(root, "big.json");
    const fd = fs.openSync(file, "w");
    const chunk = Buffer.alloc(CHUNK_BYTES, 7);
    fs.writeSync(fd, chunk);
    fs.writeSync(fd, chunk);
    fs.writeSync(fd, Buffer.alloc(12345, 9));
    fs.closeSync(fd);

    const expected = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(sha256FileSync(file), expected);
    assert.ok(MAX_DIGEST_BYTES > 64 * 1024 * 1024, "상한이 64MB에 묶여 있으면 안 됩니다");

    const bound = inputBinding.bindInputs(
      [{ inputId: "I1", locator: "big.json", kind: "file", mode: "frozen" }],
      { root }
    );
    assert.equal(bound.bindings[0].state, "BOUND");
    assert.equal(bound.bindings[0].sha256, expected);
    assert.deepEqual(bound.unboundFrozen, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("읽을 수 없는 파일은 지문 대신 null을 돌려준다", () => {
  const { sha256FileSync } = require("../src/agora/assurance/file-digest");
  assert.equal(sha256FileSync(path.join(tempRoot("agora-nofile-"), "없는파일.json")), null);
});

// "too-large"만 보고는 파일을 줄여야 하는지, live로 선언해야 하는지 알 수 없다.
// 실제 크기와 상한이 함께 나와야 사용자가 판단할 수 있다.
test("크기 초과 사유는 실제 크기와 상한을 함께 밝힌다", () => {
  const { tooLargeReason } = require("../src/agora/assurance/file-digest");
  const reason = tooLargeReason(110512941);
  assert.match(reason, /105\.4MB/);
  assert.match(reason, /상한 4\.0GB/);
});

// 모드 표시는 `(frozen)`이 정석이지만 실제로는 `(frozen, 39MB)`처럼 메모를 덧붙인다.
// 예전에는 정확히 `(frozen)`만 인식해서 모드도 못 읽고 괄호가 경로에 남아
// "승인된 입력 파일을 찾을 수 없습니다"로 죽었다.
test("모드 표시에 메모가 붙어도 경로와 모드를 바르게 읽는다", () => {
  const parsed = taskSchema.parseTaskV2(
    ["## Goal", "g",
      "## Inputs / Source Data",
      "- `resources/split_manifest.json` (frozen, 39MB)",
      "- `docs/note.md` (live · 자주 바뀜)",
      "- `resources/검사(BFI).xlsx`",
      "## Requirements", "r", "## Work Approach", "w", "## Deliverables", "- 없음",
      "## Acceptance Criteria", "a", "## Verification Plan", "v", "## Out of Scope", "o"].join("\n")
  );
  const items = parsed.inputs.items;
  assert.equal(items[0].locator, "resources/split_manifest.json");
  assert.equal(items[0].mode, "frozen");
  assert.equal(items[0].modeDeclared, true);
  assert.equal(items[1].locator, "docs/note.md");
  assert.equal(items[1].mode, "live");
  // 모드 토큰이 없는 괄호는 파일 이름의 일부다. 건드리면 안 된다.
  assert.equal(items[2].locator, "resources/검사(BFI).xlsx");
});

// Inputs에 산문이 섞이면 그 문장이 통째로 경로가 되어 오류 문구를 읽을 수 없었다.
// 경계를 따옴표로 보이고 길면 줄여, 어느 항목이 경로가 아닌지 드러낸다.
test("경로가 아닌 입력 항목은 오류에서 눈에 띄게 인용된다", () => {
  const root = tempRoot("agora-bad-input-");
  try {
    const prose = "계약 상수(소스 실측): 시드 language_aig_phase4_split_seed_v1, 컷오프 8000/9000/10000, 해시 규칙 sha256";
    const built = frozenContract.buildFrozenContract(
      ["## Goal", "g",
        "## Inputs / Source Data",
        `- ${prose}`,
        "## Requirements", "r", "## Work Approach", "w", "## Deliverables", "- 없음",
        "## Acceptance Criteria", "a", "## Verification Plan", "v", "## Out of Scope", "o"].join("\n"),
      { root }
    );
    assert.equal(built.ok, false);
    assert.equal(built.code, "FROZEN_INPUT_MISSING");
    assert.match(built.error, /^승인된 입력 파일을 찾을 수 없습니다: "/);
    // 길면 줄여서 오류 한 줄이 읽히게 한다.
    assert.match(built.error, /…"$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Planner는 `(frozen)` 말고도 `(mutable)`, `(신규, 사본)`, `(39MB)`처럼 무엇이든 적는다.
// 아는 낱말만 걷어내면 모르는 주석이 경로에 남아 "파일을 찾을 수 없습니다"가 된다.
// 끝에 공백을 두고 붙은 괄호만 걷고, 이름 가운데 괄호는 실제 파일이므로 유지한다.
test("항목 끝의 괄호 주석은 종류와 무관하게 걷어내고 이름 속 괄호는 지킨다", () => {
  const parsed = taskSchema.parseTaskV2(
    ["## Goal", "g",
      "## Inputs / Source Data",
      "- `src/language_aig/models.py` (mutable)",
      "- `resources/split_manifest.json` (frozen, 39MB)",
      "- `resources/검사(BFI).xlsx`",
      "## Requirements", "r", "## Work Approach", "w",
      "## Deliverables",
      "- `out/a.json` (신규, 무변경 사본)",
      "- out/b.json — 설명",
      "- `out/검사(BFI).xlsx`",
      "## Acceptance Criteria", "a", "## Verification Plan", "v", "## Out of Scope", "o"].join("\n")
  );
  const inputs = parsed.inputs.items.map((i) => i.locator);
  assert.deepEqual(inputs, [
    "src/language_aig/models.py",
    "resources/split_manifest.json",
    "resources/검사(BFI).xlsx",
  ]);
  // 모드 표시가 든 괄호는 여전히 모드로 읽힌다.
  assert.equal(parsed.inputs.items[1].mode, "frozen");
  assert.equal(parsed.inputs.items[1].modeDeclared, true);

  const dels = parsed.deliverables.items;
  assert.equal(dels[0].locator, "out/a.json", "닫는 백틱까지 함께 벗겨져야 합니다");
  assert.equal(dels[1].locator, "out/b.json");
  assert.equal(dels[1].description, "설명");
  assert.equal(dels[2].locator, "out/검사(BFI).xlsx");
});
