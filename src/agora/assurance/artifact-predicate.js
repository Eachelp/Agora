"use strict";

// Stage D-A2 — Artifact Predicate Engine
//
// Agora 자신이 산출물을 열어 술어를 평가한다. 외부 프로세스를 부르지 않으므로
// 쓰기 경로가 존재하지 않고, 따라서 controlClass는 ENFORCEABLE이다(D-A0 §2.5).
//
// **도메인 Verifier를 만들지 않는다.** ExcelVerifier · ResearchVerifier 같은
// class zoo 대신 Extractor + Predicate primitive의 조합으로 확장한다. 도메인
// 지식은 Frozen Task가 공급한다.
//
//   Extractor   산출물에서 값을 꺼낸다     (exists / hash / text / json / csv)
//   Predicate   꺼낸 값을 기대와 비교한다  (== != > >= < <= contains matches)
//
// 능력은 D-A0 capability snapshot이 정한다. 동봉하지 않은 형식(xlsx/docx/pdf)은
// 억지로 지원하지 않고 UNSUPPORTED로 정직하게 강등한다(INV-3). 강등은 실패가
// 아니라 판단 주체의 변경이다.
//
// SourceVerifier를 만들지 않는다(Charter §10): URL/citation의 **존재**는 여기서
// 술어로 확인하고, "이 출처가 주장을 뒷받침하는가"는 REVIEW_REQUIRED다.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { capabilityState, AVAILABLE } = require("../verification-capabilities");

const OUTCOMES = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  ERROR: "ERROR",
  UNSUPPORTED: "UNSUPPORTED",
});

// 술어 종류 → 필요한 capability. 없는 능력을 조용히 대체하지 않는다.
const KIND_CAPABILITY = Object.freeze({
  exists: "artifact.exists",
  absent: "artifact.exists",
  hash: "artifact.hash",
  text: "artifact.text",
  "text.contains": "artifact.text",
  "text.matches": "artifact.text",
  "text.section": "artifact.text",
  "text.lines": "artifact.text",
  json: "artifact.json",
  "json.path": "artifact.json",
  csv: "artifact.csv",
  "csv.rows": "artifact.csv",
  "csv.column": "artifact.csv",
  xlsx: "artifact.xlsx",
  docx: "artifact.docx",
  pdf: "artifact.pdf",
});

const MAX_READ_BYTES = 16 * 1024 * 1024;

function realOrResolved(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInside(root, target) {
  const a = realOrResolved(root);
  const b = realOrResolved(target);
  const na = process.platform === "win32" ? a.toLowerCase() : a;
  const nb = process.platform === "win32" ? b.toLowerCase() : b;
  return nb === na || nb.startsWith(na.endsWith(path.sep) ? na : `${na}${path.sep}`);
}

function readTextFile(abs) {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error("일반 파일이 아닙니다.");
  if (stat.size > MAX_READ_BYTES) throw new Error("파일이 너무 큽니다.");
  return fs.readFileSync(abs, "utf8");
}

// --- Extractors: 산출물에서 값을 꺼낸다 (읽기만 한다) ---

function extractExists(abs) {
  try {
    return { ok: true, value: fs.statSync(abs).isFile() };
  } catch {
    return { ok: true, value: false };
  }
}

function extractHash(abs) {
  try {
    return { ok: true, value: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") };
  } catch (error) {
    return { ok: false, error: error?.message || "해시를 계산할 수 없습니다." };
  }
}

function extractText(abs) {
  try {
    return { ok: true, value: readTextFile(abs) };
  } catch (error) {
    return { ok: false, error: error?.message || "파일을 읽을 수 없습니다." };
  }
}

function extractJsonPath(abs, pointer) {
  let text;
  try {
    text = readTextFile(abs);
  } catch (error) {
    return { ok: false, error: error?.message || "파일을 읽을 수 없습니다." };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON을 읽을 수 없습니다: ${error?.message || "parse error"}` };
  }
  if (!pointer) return { ok: true, value: parsed };
  // 점 표기 + 배열 인덱스. JSONPath 전체를 구현하지 않는다(무게).
  const segments = String(pointer)
    .replace(/^\$\.?/, "")
    .split(/[.[\]]+/)
    .filter(Boolean);
  let cursor = parsed;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") {
      return { ok: true, value: undefined, missingAt: segment };
    }
    cursor = cursor[segment];
  }
  return { ok: true, value: cursor };
}

// 따옴표와 이스케이프를 다루는 최소 CSV 파서. 새 의존성을 들이지 않는다.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 완전히 빈 마지막 줄은 행으로 세지 않는다.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

function extractCsv(abs, args = {}) {
  let text;
  try {
    text = readTextFile(abs);
  } catch (error) {
    return { ok: false, error: error?.message || "파일을 읽을 수 없습니다." };
  }
  const rows = parseCsv(text);
  const hasHeader = args.header !== false;
  const header = hasHeader && rows.length > 0 ? rows[0] : null;
  const body = hasHeader ? rows.slice(1) : rows;
  return { ok: true, value: { rows: body, header, rowCount: body.length } };
}

// --- Predicates: 꺼낸 값을 기대와 비교한다 ---

function compare(actual, operator, expected) {
  switch (operator) {
    case "==":
      // 숫자로 비교 가능하면 숫자로. "10" == 10을 불일치로 만들지 않는다.
      if (typeof actual === "number" || typeof expected === "number") {
        const a = Number(actual);
        const b = Number(expected);
        if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
      }
      return String(actual) === String(expected);
    case "!=":
      return !compare(actual, "==", expected);
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const a = Number(actual);
      const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (operator === ">") return a > b;
      if (operator === ">=") return a >= b;
      if (operator === "<") return a < b;
      return a <= b;
    }
    case "contains":
      return String(actual).includes(String(expected));
    case "not-contains":
      return !String(actual).includes(String(expected));
    case "matches":
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function result(outcome, detail = {}) {
  return { outcome, ...detail };
}

// 하나의 predicate criterion을 평가한다.
//
// 반환은 outcome만 만든다. disposition은 Router의 몫이다(R-7 — 두 축은 직교).
function evaluatePredicate(step, context = {}) {
  const root = context.root ? realOrResolved(context.root) : null;
  const capabilities = context.capabilities || null;
  const kind = String(step?.kind || "").trim();

  if (!root) {
    return result(OUTCOMES.ERROR, { error: "검증 기준 폴더가 없습니다.", backend: "artifact-predicate" });
  }
  if (!kind) {
    return result(OUTCOMES.ERROR, { error: "확인할 술어 종류가 없습니다.", backend: "artifact-predicate" });
  }

  const capability = KIND_CAPABILITY[kind];
  if (!capability) {
    // 모르는 술어를 통과시키지 않고, 실패로도 만들지 않는다. 사람에게 보낸다.
    return result(OUTCOMES.UNSUPPORTED, {
      backend: "artifact-predicate",
      downgradeReason: `지원하지 않는 확인 방식입니다: ${kind}`,
    });
  }
  if (capabilities && capabilityState(capabilities, capability) !== AVAILABLE) {
    // 능력이 없으면 PASS로 가장하지 않는다(INV-3). 이것이 A안의 핵심이다.
    return result(OUTCOMES.UNSUPPORTED, {
      backend: "artifact-predicate",
      capability,
      downgradeReason: `이 PC에서 ${capability} 확인을 지원하지 않습니다.`,
    });
  }

  const target = String(step.target || "");
  const abs = path.resolve(root, target);
  if (!isInside(root, abs)) {
    return result(OUTCOMES.ERROR, {
      backend: "artifact-predicate",
      error: "확인 대상이 작업 폴더 밖입니다.",
    });
  }

  const operator = step.operator || "==";
  const expected = step.expected;
  const args = step.args || {};

  try {
    switch (kind) {
      case "exists": {
        const got = extractExists(abs);
        return result(got.value ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actual: got.value,
          expected: true,
        });
      }
      case "absent": {
        const got = extractExists(abs);
        return result(got.value ? OUTCOMES.FAIL : OUTCOMES.PASS, {
          backend: "artifact-predicate",
          actual: got.value,
          expected: false,
        });
      }
      case "hash": {
        const got = extractHash(abs);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        return result(compare(got.value, operator, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actual: got.value,
          expected,
          operator,
        });
      }
      case "text":
      case "text.contains":
      case "text.matches": {
        const got = extractText(abs);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        const op = kind === "text.contains" ? "contains" : kind === "text.matches" ? "matches" : operator;
        return result(compare(got.value, op, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actualLength: got.value.length,
          expected,
          operator: op,
        });
      }
      case "text.section": {
        // 문서 산출물의 필수 섹션 확인. 코딩이 아닌 과업의 대표 검사다.
        const got = extractText(abs);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        const wanted = String(expected || args.heading || "").trim();
        if (!wanted) {
          return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: "확인할 섹션 이름이 없습니다." });
        }
        const normalized = (v) => v.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "");
        const found = got.value
          .split("\n")
          .some((line) => /^#{1,6}\s+/.test(line.trim()) && normalized(line.replace(/^#+\s*/, "")) === normalized(wanted));
        return result(found ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          expected: wanted,
          actual: found,
        });
      }
      case "text.lines": {
        const got = extractText(abs);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        const count = got.value.split("\n").filter((l) => l.trim()).length;
        return result(compare(count, operator, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actual: count,
          expected,
          operator,
        });
      }
      case "json":
      case "json.path": {
        const pointer = args.path || args.pointer || step.pointer || null;
        const got = extractJsonPath(abs, pointer);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        if (got.value === undefined) {
          return result(OUTCOMES.FAIL, {
            backend: "artifact-predicate",
            error: `JSON 경로를 찾을 수 없습니다: ${pointer}`,
            actual: null,
            expected,
          });
        }
        return result(compare(got.value, operator, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actual: got.value,
          expected,
          operator,
          pointer,
        });
      }
      case "csv":
      case "csv.rows": {
        const got = extractCsv(abs, args);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        return result(compare(got.value.rowCount, operator, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          actual: got.value.rowCount,
          expected,
          operator,
        });
      }
      case "csv.column": {
        const got = extractCsv(abs, args);
        if (!got.ok) return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: got.error });
        const columnName = args.column != null ? String(args.column) : null;
        if (!columnName) {
          return result(OUTCOMES.ERROR, { backend: "artifact-predicate", error: "확인할 열 이름이 없습니다." });
        }
        const header = got.value.header || [];
        const index = header.findIndex((h) => String(h).trim() === columnName);
        if (index === -1) {
          return result(OUTCOMES.FAIL, {
            backend: "artifact-predicate",
            error: `열을 찾을 수 없습니다: ${columnName}`,
            actual: null,
            expected,
          });
        }
        const rowIndex = Number.isInteger(args.row) ? args.row : null;
        if (rowIndex == null) {
          // 행을 지정하지 않으면 모든 행이 조건을 만족해야 한다.
          const allMatch = got.value.rows.every((row) => compare(row[index], operator, expected));
          return result(allMatch ? OUTCOMES.PASS : OUTCOMES.FAIL, {
            backend: "artifact-predicate",
            column: columnName,
            rowCount: got.value.rowCount,
            expected,
            operator,
            scope: "all-rows",
          });
        }
        const row = got.value.rows[rowIndex];
        if (!row) {
          return result(OUTCOMES.FAIL, {
            backend: "artifact-predicate",
            error: `행이 없습니다: ${rowIndex}`,
            actual: null,
            expected,
          });
        }
        return result(compare(row[index], operator, expected) ? OUTCOMES.PASS : OUTCOMES.FAIL, {
          backend: "artifact-predicate",
          column: columnName,
          row: rowIndex,
          actual: row[index],
          expected,
          operator,
        });
      }
      default:
        return result(OUTCOMES.UNSUPPORTED, {
          backend: "artifact-predicate",
          downgradeReason: `아직 구현되지 않은 확인 방식입니다: ${kind}`,
        });
    }
  } catch (error) {
    return result(OUTCOMES.ERROR, {
      backend: "artifact-predicate",
      error: error?.message || "확인 중 오류가 발생했습니다.",
    });
  }
}

module.exports = {
  OUTCOMES,
  KIND_CAPABILITY,
  evaluatePredicate,
  parseCsv,
  compare,
};
