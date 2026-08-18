"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Stage C — Session Invalidation / Lifecycle의 bounded taxonomy와
// provider-neutral Git HEAD fact probe.
//
// 확정 계약:
//   - lifecycle reason은 아래 bounded 집합만 사용한다. provider stopReason /
//     process stopReason과 섞지 않는다.
//   - RETIRED = 정상 authority/lifecycle boundary로 사용 수명이 끝남.
//   - INVALIDATED = provider-native continuity 또는 execution environment 자체를
//     더 이상 신뢰할 수 없음.
//   - Git HEAD는 control plane이 authoritative workspace(ProjectStore.workspace)에서
//     계산해 fact로 전달한다. provider adapter는 HEAD를 계산하지 않는다.

// 정상 boundary(RETIRED) 사유.
const RETIRE_REASONS = Object.freeze({
  FROZEN_TASK_CHANGED: "FROZEN_TASK_CHANGED",
  GIT_HEAD_CHANGED: "GIT_HEAD_CHANGED",
  MODEL_CHANGED: "MODEL_CHANGED",
  PERMISSION_CHANGED: "PERMISSION_CHANGED",
  WORKSPACE_CHANGED: "WORKSPACE_CHANGED",
  PROFESSIONAL_RUN_ENDED: "PROFESSIONAL_RUN_ENDED",
  RUNTIME_CLOSED: "RUNTIME_CLOSED",
});

// 신뢰 경계 붕괴(INVALIDATED) 사유.
const INVALIDATE_REASONS = Object.freeze({
  PROVIDER_ACCOUNT_CHANGED: "PROVIDER_ACCOUNT_CHANGED",
  WORKSPACE_RESTORED: "WORKSPACE_RESTORED",
  PROFESSIONAL_RUN_ENDED: "PROFESSIONAL_RUN_ENDED",
});

// execution-level typed failure(stopReason). lifecycle reason과 별개 축이다.
const LIFECYCLE_STOP_REASONS = Object.freeze({
  BUSY: "HARNESS_SESSION_LIFECYCLE_BUSY",
  INVALID: "HARNESS_SESSION_LIFECYCLE_INVALID",
});

// Git HEAD fact. control plane이 Professional managed turn 직전에 계산한다.
//   { status: "ok", sha }        — Git 저장소, HEAD 확인됨
//   { status: "unsupported" }    — Git 저장소가 아님(정상 상태)
//   { status: "error" }          — Git 저장소인데 HEAD를 확인할 수 없음(fail-closed 대상)
const GIT_HEAD_SHA_PATTERN = /^[0-9a-f]{4,64}$/i;

function probeGitHead(workspaceRoot) {
  const root = String(workspaceRoot || "").trim();
  if (!root) return { status: "unsupported" };
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return { status: "unsupported" };
  } catch {
    return { status: "unsupported" };
  }
  try {
    // 배열 인자 + shell 미사용(unsafe interpolation 금지). turn-checkpoint의 git
    // helper와 같은 호출 규약이되, control-plane 동기 경로라 spawnSync를 쓴다.
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    if (result.error || result.status !== 0) return { status: "error" };
    const sha = String(result.stdout || "").trim();
    if (!GIT_HEAD_SHA_PATTERN.test(sha)) return { status: "error" };
    return { status: "ok", sha };
  } catch {
    return { status: "error" };
  }
}

module.exports = {
  RETIRE_REASONS,
  INVALIDATE_REASONS,
  LIFECYCLE_STOP_REASONS,
  probeGitHead,
};
