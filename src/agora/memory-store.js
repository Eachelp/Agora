const fs = require("node:fs");
const path = require("node:path");
const { defaultAgoraHome } = require("../app-paths");

const MEMORY_SCHEMA_VERSION = 1;
const MAX_ENTRY_CHARS = 24000;
const MAX_PROMPT_CHARS = 16000;

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
}

module.exports = {
  MemoryStore,
  MEMORY_SCHEMA_VERSION,
  MAX_ENTRY_CHARS,
  MAX_PROMPT_CHARS,
  validProjectId,
};
