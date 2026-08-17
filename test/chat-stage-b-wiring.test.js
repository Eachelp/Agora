"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildAgentInvocation } = require("../src/chat/chat-argv");

test("실제 invocation builder도 미등록 process harness를 fail-closed 한다", () => {
  const result = buildAgentInvocation({
    provider: {
      id: "future-harness",
      name: "Future Harness",
      status: "cli",
      permissions: {
        chat: { supported: true, enforcement: "unknown" },
      },
    },
    permissionMode: "chat",
    chatCwd: process.cwd(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "UNSUPPORTED_PROCESS_PROVIDER");
});

test("chat IPC task open/read 경계는 shared realpath boundary를 사용한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");
  assert.match(source, /require\("\.\.\/agora\/task-file-boundary"\)/);
  assert.match(source, /resolveTaskFileBoundary\(workspace, taskPath/);
  assert.match(source, /maxBytes:\s*MAX_TASK_READ_BYTES/);
  assert.doesNotMatch(source, /const prefix = workspaceRoot\.endsWith/);
});
