const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");

const MEMORY_SCHEMA_VERSION = 1;
const MAX_ENTRY_CHARS = 24000;
const MAX_PROMPT_CHARS = 16000;
const MAX_RULES_CHARS = 4000;

let rulesWriteSeq = 0;

// 규칙 파일은 통째로 교체되는 유일한 파일이라, 도중에 앱/PC가 꺼지면
// writeFileSync가 비운 상태에서 끝나 내용을 통째로 잃을 수 있습니다.
// 같은 디렉터리의 임시 파일에 먼저 쓴 뒤 rename해 이 문제를 막습니다.
function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  rulesWriteSeq += 1;
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${rulesWriteSeq}.tmp`);
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function validProjectId(value) {
  const id = String(value || "").trim();
  return /^[a-z0-9_-]{1,120}$/i.test(id) ? id : null;
}

function cleanText(value, limit = MAX_ENTRY_CHARS) {
  return String(value || "").trim().slice(0, limit);
}

function sourceLabel(source) {
  return source === "human" ? "사람이 추가" : "기록관 초안";
}

function statusLabel(status) {
  return status === "verified" ? "검증됨" : "검토 필요";
}

function newEntryId(now) {
  return `memory-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class MemoryStore {
  constructor(options = {}) {
    this.root = options.root || defaultAgoraHome(options.env);
    this.now = options.now || (() => Date.now());
    this.initialized = false;
  }

  memoryRoot() {
    return path.join(this.root, "memory");
  }

  projectPath(projectId) {
    const id = validProjectId(projectId);
    return id ? path.join(this.memoryRoot(), `${id}.md`) : null;
  }

  rulesPath(projectId) {
    const id = validProjectId(projectId);
    return id ? path.join(this.memoryRoot(), `${id}.rules.md`) : null;
  }

  rulesHistoryPath(projectId) {
    const id = validProjectId(projectId);
    return id ? path.join(this.memoryRoot(), `${id}.rules-history.md`) : null;
  }

  init() {
    if (!this.initialized) {
      fs.mkdirSync(this.memoryRoot(), { recursive: true });
      this.initialized = true;
    }
    return this;
  }

  read(projectId) {
    const filePath = this.projectPath(projectId);
    if (!filePath) return "";
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }

  readForPrompt(projectId, maxChars = MAX_PROMPT_CHARS) {
    const content = this.read(projectId).trim();
    if (!content) return "";
    if (content.length <= maxChars) return content;
    return `(Memory Bank 앞부분은 생략됨)\n${content.slice(-maxChars)}`;
  }

  append(projectId, input = {}) {
    const filePath = this.projectPath(projectId);
    const content = cleanText(input.content);
    if (!filePath || !content) return null;
    this.init();
    const now = this.now();
    const source = input.source === "human" ? "human" : "agent";
    const status = source === "human" ? "verified" : input.status === "verified" ? "verified" : "draft";
    const title = cleanText(input.title, 120) || (source === "human" ? "사람이 추가한 기록" : "기록관 요약 초안");
    const id = cleanText(input.id, 160) || newEntryId(now);
    const exists = this.read(projectId).trim();
    const header = exists
      ? ""
      : `<!-- Agora Memory Bank v${MEMORY_SCHEMA_VERSION} -->\n# 프로젝트 Memory Bank\n\n`;
    const entry = `${header}## ${title}\n<!-- agora-memory-entry: ${id} | ${sourceLabel(source)} | ${statusLabel(status)} | ${new Date(now).toISOString()} -->\n\n${content}\n\n`;
    fs.appendFileSync(filePath, entry, "utf8");
    return { id, projectId, source, status, title, content, createdAt: now, path: filePath };
  }

  readRules(projectId) {
    const filePath = this.rulesPath(projectId);
    if (!filePath) return "";
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }

  readRulesHistory(projectId) {
    const filePath = this.rulesHistoryPath(projectId);
    if (!filePath) return "";
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  }

  saveRules(projectId, content) {
    const filePath = this.rulesPath(projectId);
    if (!filePath) return { changed: false, rules: "" };
    const next = cleanText(content, MAX_RULES_CHARS);
    const current = this.readRules(projectId).trim();
    if (current === next) return { changed: false, rules: current };
    this.init();
    if (current) {
      const historyPath = this.rulesHistoryPath(projectId);
      const entry = `## 이전 규칙\n<!-- agora-rules-history: ${new Date(this.now()).toISOString()} -->\n\n${current}\n\n`;
      fs.appendFileSync(historyPath, entry, "utf8");
    }
    // 임시 파일에 쓴 뒤 rename: 저장 도중 앱/PC가 꺼져도 규칙이
    // 비워지거나 잘리지 않고 이전 상태 그대로 남습니다.
    writeTextAtomic(filePath, next);
    return { changed: true, rules: next };
  }
}

module.exports = {
  MemoryStore,
  MEMORY_SCHEMA_VERSION,
  MAX_ENTRY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_RULES_CHARS,
  validProjectId,
};
