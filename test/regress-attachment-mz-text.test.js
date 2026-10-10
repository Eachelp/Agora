"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agora-b3-"));
// F80 'MZ'로 시작하는 텍스트 첨부 오탐.
const { importAttachment } = require("../src/chat/chat-attachments");

function attach(name, content) {
  const source = tmp();
  const file = path.join(source, name);
  fs.writeFileSync(file, content);
  return importAttachment({ sourcePath: file, attachmentsDir: tmp() });
}

test("F80 MZ로 시작하는 마크다운·CSV 첨부는 거부되지 않는다", () => {
  assert.equal(attach("report.md", "MZ세대 소비 트렌드 보고서\n내용").ok, true);
  assert.equal(attach("data.csv", "MZ,40%\nX,60%").ok, true);
});

test("F80 진짜 PE 실행 파일은 확장자를 바꿔도 계속 거부한다", () => {
  const pe = Buffer.alloc(256);
  pe.write("MZ", 0);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80, "latin1");
  const result = attach("notes.txt", pe);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("실행 파일"));
});

