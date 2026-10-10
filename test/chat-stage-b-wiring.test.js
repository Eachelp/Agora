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
