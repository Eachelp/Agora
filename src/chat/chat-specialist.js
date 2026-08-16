const path = require("node:path");
const { specialistPermissionMode } = require("./chat-argv");
const {
  createProfessionalRun,
  transitionProfessionalRun,
  publicProfessionalState,
  phaseForNode,
} = require("../agora/professional-run");
const { TaskManager, hashText } = require("../agora/task-manager");
const { describeWorkspaceChanges } = require("../agora/workspace-diff");
const {
  executionAxes: professionalExecutionAxes,
  buildProfessionalEvidencePayload,
} = require("./chat-professional-evidence");

const SAFE_BLOCK_REASONS = new Set([
  "BLOCKED",
  "BUILDER_STATUS_MISSING",
  "BUILDER_STATUS_AMBIGUOUS",
  "FROZEN_TASK_CORRUPTED",
  "DIFF_UNAVAILABLE",
  "DIFF_COLLECTION_FAILED",
  "EVIDENCE_WRITE_FAILED",
  "PROMPT_BUDGET_EXCEEDED",
  "PROTOCOL_FINAL_MISSING",
  "RECOVERY_JOURNAL_WRITE_FAILED",
  "TRANSPORT_FAILED",
  "TIMED_OUT",
  "OUTPUT_LIMITED",
  "EXECUTION_BLOCKED",
  "EXECUTION_INTERRUPTED",
  "EXECUTION_INTERRUPTED_CHECKPOINTING",
  "USER_INTERRUPTED",
  "FIX_REQUIRED",
  "LIMIT_EXCEEDED",
  "INSUFFICIENT_EVIDENCE",
  "AMBIGUOUS_VERDICT",
  "PROFESSIONAL_RUN_WRITE_FAILED",
  "WORKFLOW_WRITE_FAILED",
  "RUN_STATE_WRITE_FAILED",
  "RECORDER_FAILED",
  "CHECKPOINT_CLEANUP_FAILED",
]);

// Task 파일 첨부 정보를 만듭니다. taskPath가 없으면 null을 돌려줍니다.
function taskFileInfo(taskPath) {
  return taskPath
    ? { relativePath: taskPath, filename: path.basename(taskPath) }
    : null;
}

function safeBlockReason(value) {
  const reason = String(value || "");
  return SAFE_BLOCK_REASONS.has(reason) ? reason : "EXECUTION_BLOCKED";
}

// 작업용 채팅에서는 캐릭터 이모티콘 이미지를 더 이상 렌더링하지 않습니다.
// 다만 예전 습관이나 실수로 에이전트가 [[CODEPET_EMOTE:...]] 표기를 남기면
// 화면에 제어 태그가 그대로 노출되지 않도록 텍스트에서만 조용히 제거합니다.
const EMOTICON_TAG_PATTERN = /\[\[CODEPET_EMOTE:[^\]\r\n]+\]\]/g;

function stripEmoticonTags(value) {
  return String(value || "")
    .replace(EMOTICON_TAG_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasOpenQuestions(text) {
  const source = String(text || "");
  const match = /^#{1,6}\s*open\s+questions?\s*$/im.exec(source);
  if (!match) return false;
  const rest = source.slice((match.index || 0) + match[0].length);
  const nextHeading = rest.search(/^#{1,6}\s+/m);
  const content = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest)
    .replace(/^\s*STATUS:\s*\w+.*$/gim, "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/gm, "")
    .trim();
  return content.length > 0 && !/^(?:없음|없습니다|none|n\/?a)\.?$/i.test(content);
}

// Plan Reviewer의 다음 라운드에는 자유 서술이 아니라 추적 가능한 ISSUES
// 블록만 다시 준다. repeat: YES/NO 관찰의 기준도 이 텍스트다.
function structuredIssuesFromReview(text) {
  const source = String(text || "");
  const marker = /^ISSUES:\s*/im.exec(source);
  if (!marker) return "";
  const tail = source.slice((marker.index || 0) + marker[0].length);
  const end = tail.search(/^(?:#{1,6}\s+open\s+questions?|VERDICT:|STATUS:|\[\[CODEPET_)/im);
  return (end >= 0 ? tail.slice(0, end) : tail).trim();
}

// 코드펜스(``` ... ```) 안의 텍스트는 인용된 예시/설명일 가능성이 높아
// STATUS/VERDICT 같은 제어 마커 탐지에서 제외합니다. 그렇지 않으면 검토자가
// 예전 답변이나 예시 형식을 인용하기만 해도 그 인용문 속 마커가 실제 판정처럼 읽힙니다.
function stripCodeFences(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "");
}

// 응답 본문에서 STATUS/VERDICT 제어 마커를 찾습니다.
// - 코드펜스 내부는 검사하지 않습니다.
// - 서로 다른 값의 매치가 두 번 이상 나오면(인용·부정문·수정 흔적 등) 어느 것이
//   진짜 결론인지 프로그램이 임의로 단정하지 않고 ambiguous=true로 표시합니다.
//   (같은 값이 반복되는 것은 모호하지 않습니다.)
// - 매치가 있으면 마지막 매치를 채택합니다. 결론은 보통 응답의 끝에 옵니다.
function findControlMarker(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const stripped = stripCodeFences(text);
  const matches = [...stripped.matchAll(globalPattern)].map((match) => match[1].toUpperCase());
  if (matches.length === 0) return { value: null, ambiguous: false };
  const distinct = new Set(matches);
  return { value: matches[matches.length - 1], ambiguous: distinct.size > 1 };
}



function runGeneratedPaths(workspace, runInfo) {
  if (!workspace || !runInfo?.runDir) return [];
  const relativeRun = path.relative(workspace, runInfo.runDir);
  if (!relativeRun || relativeRun.startsWith("..")) return [];
  return ["task.md", "task-hash", "evidence.json", "invalid.json", "result.json", "block.json"]
    .map((name) => path.join(relativeRun, name));
}

class SpecialistMixin {
  setProfessionalRun(run) {
    if (this.persistProfessionalRun) {
      try {
        if (this.persistProfessionalRun(run) === false) return false;
      } catch {
        return false;
      }
    }
    this.professionalRun = run;
    this.emitSpecialistState();
    return true;
  }

  transitionProfessional(event) {
    if (!this.professionalRun) return { ok: true, state: null };
    const transition = transitionProfessionalRun(this.professionalRun, event);
    if (!transition.ok) return transition;
    if (!this.setProfessionalRun(transition.state)) {
      return { ok: false, reason: "전문 실행 상태를 저장하지 못했습니다." };
    }
    return transition;
  }

  professionalTransitionFailure(stage, transition) {
    const error = transition?.reason || "전문 실행 상태를 저장하지 못했습니다.";
    this.appendSystem(`전문 실행 상태를 저장하지 못해 다음 단계를 시작하지 않았습니다. (${error})`);
    return {
      ok: false,
      stage,
      needsUserDecision: true,
      stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
      error,
    };
  }

  updateProfessionalTaskState(patch) {
    if (!this.onProfessionalTaskState || !patch?.taskPath) return true;
    try {
      return this.onProfessionalTaskState(patch) !== false;
    } catch {
      return false;
    }
  }

  stagesForSpecialist() {
    return this.specialistStages || this.professionalRun?.stages || this.specialistResume?.stages || null;
  }

  async withProfessionalAuthorization(authorization = "workspace-write", fn) {
    const prev = this.activeRunAuthorization;
    this.activeRunAuthorization = authorization || "workspace-write";
    try {
      return await fn();
    } finally {
      this.activeRunAuthorization = prev;
    }
  }

  rehydrateRecovery(recovery) {
    if (!recovery || typeof recovery !== "object") return null;
    const checkpoint = recovery.checkpointId
      ? {
          supported: true,
          checkpointId: recovery.checkpointId,
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: recovery.runId || null,
        }
      : null;
    let canRestore = false;
    if (checkpoint && this.checkpointEngine) {
      try {
        const inspected = typeof this.checkpointEngine.inspectCheckpoint === "function"
          ? this.checkpointEngine.inspectCheckpoint(checkpoint)
          : null;
        canRestore = inspected ? inspected.ok === true : Boolean(checkpoint.supported);
      } catch {
        canRestore = false;
      }
    }
    const reason = safeBlockReason(recovery.blockReason || (
      recovery.status === "checkpointing"
        ? "EXECUTION_INTERRUPTED_CHECKPOINTING"
        : "EXECUTION_INTERRUPTED"
    ));
    return {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: recovery.taskPath || null,
      runId: recovery.runId || null,
      stage: recovery.stage || "implementation",
      blockReason: reason,
      recoveryStatus: recovery.status || "interrupted",
    };
  }

  recoveryFromProfessionalRun(run = this.professionalRun) {
    if (!run || typeof run !== "object") return null;
    const status = String(run.status || "").toUpperCase();
    const isActNode = ["IMPLEMENTING", "REVIEWING", "RECORDING"].includes(String(run.node || "").toUpperCase());
    const needsRecovery = Boolean(run.checkpointId) || ["BLOCKED", "INVALID"].includes(status) || (status === "INTERRUPTED" && isActNode);
    if (!needsRecovery) return null;
    const node = String(run.node || "IMPLEMENTING").toLowerCase();
    const stage = node === "planning" ? "planner"
      : node === "plan_review" ? "plan_review"
      : node === "reviewing" ? "review"
      : node === "recording" ? "recorder"
      : "implementation";
    return {
      schemaVersion: 1,
      status: status === "COMPLETED" ? "completed" : status === "INVALID" ? "invalid" : status === "BLOCKED" ? "blocked" : "interrupted",
      checkpointId: run.checkpointId || null,
      runId: run.frozenRunId || null,
      taskPath: run.taskPath || null,
      stage,
      blockReason: run.blockReason || run.stopReason || null,
      updatedAt: run.updatedAt || Date.now(),
    };
  }

  checkpointForProfessionalRun(run = this.professionalRun) {
    if (!run?.checkpointId) return null;
    return {
      supported: true,
      checkpointId: run.checkpointId,
      storageRoot: this.checkpointRoot,
      sessionId: this.sessionId,
      runId: run.frozenRunId || null,
    };
  }

  persistRecoveryState(recovery) {
    // 전문 실행(v3)은 별도 pendingRecovery가 아니라 한 개의
    // professionalRun journal에 checkpoint 참조를 함께 보관한다. legacy
    // step/auto/quick만 기존 recovery field를 계속 사용한다.
    if (this.professionalRun) {
      const next = { ...this.professionalRun };
      if (recovery === null) {
        next.checkpointId = null;
      } else {
        if (recovery.checkpointId) next.checkpointId = recovery.checkpointId;
        if (recovery.runId) next.frozenRunId = recovery.runId;
        if (recovery.taskPath) next.taskPath = recovery.taskPath;
      }
      if (!this.setProfessionalRun(next)) return false;
      // v2에서 옮겨 온 오래된 저널은 한 번만 비운다. null 기록은 호환
      // 정리이며 새 v3 recovery 데이터를 쓰는 경로는 아니다.
      if (!this.persistRecovery) return true;
      try {
        return this.persistRecovery(null) !== false;
      } catch {
        return false;
      }
    }
    if (!this.persistRecovery) return true;
    try {
      return this.persistRecovery(recovery) !== false;
    } catch {
      return false;
    }
  }

  recoveryFor(checkpoint, {
    status = "running",
    runId = null,
    taskPath = null,
    stage = "implementation",
    blockReason = null,
  } = {}) {
    return {
      schemaVersion: 1,
      status,
      checkpointId: checkpoint?.checkpointId || null,
      runId: runId || null,
      taskPath: taskPath || null,
      stage,
      ...(blockReason ? { blockReason: safeBlockReason(blockReason) } : {}),
      updatedAt: Date.now(),
    };
  }

  clearRecoveryState() {
    this.persistRecoveryState(null);
  }

  markCheckpointRecovery(checkpoint, options = {}) {
    const persisted = this.persistRecoveryState(this.recoveryFor(checkpoint, options));
    return persisted;
  }

  validateFrozenTask(runInfo) {
    // Legacy/manual specialist calls may not have a Planner-backed Run. They
    // retain the pre-existing behavior; every actual Run is checked below.
    if (!runInfo) return { ok: true, frozen: null };
    if (!runInfo.runDir || !this.taskManager?.readFrozenTask) {
      return { ok: false, error: "Frozen Task 경로가 없습니다." };
    }
    if (typeof runInfo.taskHash !== "string" || !runInfo.taskHash.trim()) {
      return { ok: false, error: "최초 Run의 Frozen Task 해시가 없습니다." };
    }
    if (this.taskManager.isRunInvalid?.(runInfo)) {
      return { ok: false, error: "이 Run은 이미 무효화되었습니다." };
    }
    try {
      const frozen = this.taskManager.readFrozenTask(runInfo.runDir, runInfo.taskHash);
      runInfo.content = frozen.content;
      runInfo.taskHash = frozen.taskHash;
      return { ok: true, frozen };
    } catch (error) {
      return { ok: false, error: error?.message || "Frozen Task를 검증하지 못했습니다." };
    }
  }

  persistBlockedRun({ runInfo, taskInfo, stage, round, stopReason, result = null, changes = null } = {}) {
    if (!runInfo?.runDir || !this.taskManager) return true;
    const snapshot = changes || result?.changes || null;
    const rawText = String(snapshot?.text || "");
    const included = rawText.slice(0, 12000);
    const diffStatus = snapshot?.diff?.status || snapshot?.status || "CHANGED";
    const blockSaved = this.taskManager.writeRunBlock?.(runInfo, {
      stage,
      reason: stopReason,
      builderStatus: result?.builderStatus || result?.declaration || "BLOCKED",
      changes: {
        status: diffStatus,
        originalChars: rawText.length,
        includedChars: included.length,
        truncated: included.length < rawText.length,
        text: included,
      },
      axes: result?.axes || {},
    }) !== false;
    const resultSaved = this.taskManager.writeRunResult?.(runInfo, {
      status: "BLOCKED",
      stopReason,
      round,
    }) !== false;
    const workflowSaved = this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      status: "blocked",
      // 사용자가 keep/restore/replan을 아직 고르지 않았으므로 이 Run은
      // workflow 상에서도 계속 활성 상태다. 선택이 끝난 뒤 lastRunId로
      // 옮긴다.
      activeRunId: runInfo.runId,
      lastRunId: null,
    });
    if (!blockSaved || !resultSaved || !workflowSaved) {
      this.appendSystem("실행 중단 상태를 일부 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.");
    }
    return blockSaved && resultSaved && workflowSaved;
  }

  holdForFrozenTaskCorruption({ runInfo, taskInfo, checkpoint, stage = "implementation", round = 1, error = "" } = {}) {
    const reason = "FROZEN_TASK_CORRUPTED";
    this.transitionProfessional({ type: "INVALIDATE", stopReason: reason });
    if (runInfo && this.taskManager?.markRunInvalid) {
      this.taskManager.markRunInvalid(runInfo, reason);
    }
    this.persistBlockedRun({ runInfo, taskInfo, checkpoint, stage, round, stopReason: reason });
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "invalid",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: reason,
    }));
    this.specialistBlocked = {
      checkpoint: checkpoint?.supported === true ? checkpoint : null,
      canRestore: Boolean(checkpoint?.supported === true),
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: reason,
      recoveryStatus: "invalid",
    };
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(`Frozen Task가 손상되어 실행을 중단했습니다. 변경은 그대로 남아 있습니다. (${error || "해시 불일치"})`);
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason: reason,
      blocked: true,
      canRestore: Boolean(checkpoint?.supported === true),
    };
  }

  holdForDegradedReview({ runInfo, taskInfo, checkpoint, stage = "review", round = 1, changes = null, review = null } = {}) {
    const reason = "DIFF_UNAVAILABLE";
    this.transitionProfessional({ type: "HOLD_BLOCKED", stopReason: reason, blockReason: reason });
    const canRestore = Boolean(checkpoint?.supported === true);
    this.persistBlockedRun({
      runInfo,
      taskInfo,
      checkpoint,
      stage,
      round,
      stopReason: reason,
      changes,
    });
    this.specialistBlocked = {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: reason,
    };
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "blocked",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: reason,
    }));
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(
      canRestore
        ? "Git diff를 사용할 수 없어 현재 파일을 기준으로 검수했습니다. PASS 결과를 자동 완료로 처리하지 않고 사용자 확인을 기다립니다."
        : "Git diff를 사용할 수 없어 현재 파일을 기준으로 검수했습니다. PASS 결과를 자동 완료로 처리하지 않고 사용자 확인을 기다립니다. (자동 복원은 지원되지 않습니다)"
    );
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason: reason,
      blocked: true,
      canRestore,
      changes,
      review,
    };
  }

  holdForRecovery({
    runInfo,
    taskInfo,
    checkpoint,
    stage = "implementation",
    round = 1,
    stopReason = "EXECUTION_BLOCKED",
    result = null,
    changes = null,
    message = "전문 실행을 안전하게 중단했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
  } = {}) {
    const canRestore = Boolean(checkpoint?.supported === true);
    this.transitionProfessional({
      type: "HOLD_BLOCKED",
      stopReason,
      blockReason: safeBlockReason(stopReason),
    });
    this.persistBlockedRun({ runInfo, taskInfo, checkpoint, stage, round, stopReason, result, changes });
    this.specialistBlocked = {
      checkpoint: canRestore ? checkpoint : null,
      canRestore,
      taskPath: taskInfo?.relativePath || null,
      runId: runInfo?.runId || null,
      stage,
      blockReason: safeBlockReason(stopReason),
    };
    this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "blocked",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage,
      blockReason: stopReason,
    }));
    this.specialistActive = false;
    this.emitSpecialistState();
    this.appendSystem(message);
    return {
      ok: false,
      stage,
      completedIterations: round,
      needsUserDecision: true,
      stopReason,
      blocked: true,
      canRestore,
      ...(result ? { result } : {}),
    };
  }

  executionAxes(options = {}) {
    return professionalExecutionAxes(options);
  }

  evidencePayload(options = {}) {
    const payload = buildProfessionalEvidencePayload(options);
    const runInfo = options.runInfo || null;
    if (!runInfo || !this.taskManager?.writeRunEvidence) return { ok: true, payload };
    const ok = this.taskManager.writeRunEvidence(runInfo, payload);
    return ok ? { ok: true, payload } : { ok: false, payload };
  }

  prepareReviewEvidence({ runInfo, builderResult, diff, round, provider }) {
    const evidence = this.evidencePayload({ runInfo, builderResult, diff, round, provider });
    if (evidence.ok) return evidence;
    this.appendSystem("실행 근거를 저장하지 못해 검수를 시작하지 않았습니다. 변경은 그대로 남아 있습니다.");
    return { ok: false, stopReason: "EVIDENCE_WRITE_FAILED", payload: evidence.payload };
  }


  // 기획·검수 블록: Planner → Reviewer(기획 검수)까지 실행합니다.
  // 질문·보완이 있으면 입력 대기 상태로 멈추고, 통과한 기획만 professionalPlan에 남깁니다.
  async runPlanBlock({
    stages,
    feedback = "",
    taskInfo = null,
    mode = "step",
    planAutoRevisions = 0,
    implementationAutoRevisions = 0,
    action = "plan",
    previousIssues = "",
  } = {}) {
    const planner = stages?.planner;
    // planReview는 선택 설정이며, 이전 세션과 기존 프로젝트는 review 담당자를
    // 기획 검수에도 계속 사용한다.
    const planReviewAgent = stages?.planReview || stages?.review;
    if (!planner?.agent || !planReviewAgent?.agent) {
      return { ok: false, error: "기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    const requestedGeneration = this.generation;
    const planRevisionLimit = Number.isInteger(planAutoRevisions)
      ? Math.min(3, Math.max(0, planAutoRevisions))
      : 0;
    let planRevisionCount = 0;
    let nextFeedback = feedback;
    let nextTaskInfo = taskInfo;
    let previousPlanIssues = String(previousIssues || "").trim();
    this.specialistActive = true;
    this.emitSpecialistState();
    try {
      while (true) {
        const planRound = planRevisionCount + 1;
        const plannerResult = await this.scheduleResponse(planner.agent, {
          specialist: {
            stage: "planner",
            round: planRound,
            maxRounds: planRevisionLimit + 1,
            feedback: nextFeedback,
          },
          agentConfig: planner.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!plannerResult?.ok) {
          this.transitionProfessional({
            type: "INTERRUPT",
            stopReason: plannerResult?.stopReason || "PLANNER_FAILED",
          });
          return this.specialistFail(planner, "planner", planRevisionCount, plannerResult);
        }

        if (plannerResult.plannerStatus === "NEEDS_DECISION" || hasOpenQuestions(plannerResult.text)) {
          const transition = this.transitionProfessional({
            type: "PLANNER_NEEDS_DECISION",
            stopReason: "NEEDS_DECISION",
          });
          if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
          this.specialistResume = {
            stages,
            mode,
            planAutoRevisions: planRevisionLimit,
            implementationAutoRevisions,
            action,
            feedback: plannerResult.text || nextFeedback,
            taskInfo: nextTaskInfo,
            phase: "needs_decision",
          };
          this.appendSystem("기획자가 답변이 필요한 질문을 남겼습니다. 아래 전용 입력칸에서 답한 뒤 기획·검수를 다시 실행하세요.");
          return { ok: false, stage: "planner", needsUserDecision: true, stopReason: "NEEDS_DECISION", result: plannerResult };
        }

        const previousTaskInfo = nextTaskInfo;
        if (this.meta.workspace) {
          try {
            nextTaskInfo = previousTaskInfo
              ? this.taskManager.updateTaskFromPlanner(
                  previousTaskInfo,
                  plannerResult.text || "",
                  this.meta.workspace
                )
              : this.taskManager.createTaskFromPlanner(
                  plannerResult.text || "",
                  this.meta.workspace
                );
            if (!previousTaskInfo && nextTaskInfo && this.onTaskCreated) {
              const registered = this.onTaskCreated({
                title: nextTaskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
                role: "implementation",
              });
              if (registered === false) throw new Error("TASK_INDEX_FAILED");
            } else if (previousTaskInfo && nextTaskInfo && this.onTaskUpdated) {
              const updated = this.onTaskUpdated({
                taskPath: nextTaskInfo.relativePath,
                taskHash: nextTaskInfo.hash,
                status: "todo",
              });
              if (updated === false) throw new Error("TASK_INDEX_FAILED");
            }
          } catch (error) {
            const stopReason = error?.message === "TASK_INDEX_FAILED" ? "TASK_INDEX_FAILED" : "TASK_SAVE_FAILED";
            this.appendSystem(
              stopReason === "TASK_INDEX_FAILED"
                ? "TASK.md는 저장했지만 작업 목록 등록에 실패해 기획을 멈췄습니다. 파일은 보존되며 다음 프로젝트 열기에서 다시 확인합니다."
                : `기획 결과를 TASK.md로 저장하지 못했습니다. (${error?.message || "알 수 없는 오류"})`
            );
            return { ok: false, stage: "planner", needsUserDecision: true, stopReason, error: error?.message || "알 수 없는 오류" };
          }
        }

        const reviewTransition = this.transitionProfessional({
          type: "PLANNER_PLAN_READY",
          taskPath: nextTaskInfo?.relativePath || null,
          taskId: nextTaskInfo?.filename
            ? String(nextTaskInfo.filename).replace(/\.md$/i, "")
            : null,
        });
        if (!reviewTransition.ok) {
          return this.professionalTransitionFailure("plan_review", reviewTransition);
        }

        const planText = nextTaskInfo?.content || plannerResult.text || "";
        const planReview = await this.scheduleResponse(planReviewAgent.agent, {
          specialist: {
            stage: "plan_review",
            round: planRound,
            maxRounds: planRevisionLimit + 1,
            feedback: planText,
            previousIssues: previousPlanIssues,
          },
          agentConfig: planReviewAgent.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!planReview?.ok) {
          this.transitionProfessional({
            type: "INTERRUPT",
            stopReason: planReview?.stopReason || "PLAN_REVIEW_FAILED",
          });
          return this.specialistFail(planReviewAgent, "plan_review", planRevisionCount, planReview);
        }
        const contract = this.parseReviewContract(planReview.text || "", planReview.specialistSignal);
        previousPlanIssues = structuredIssuesFromReview(planReview.text || "");
        if (contract.verdict === "PASS") {
          const transition = this.transitionProfessional({
            type: "PLAN_REVIEW_PASS",
            approvedTaskHash: nextTaskInfo?.hash || null,
            taskPath: nextTaskInfo?.relativePath || null,
          });
          if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
          this.professionalPlan = {
            stages,
            mode,
            implementationAutoRevisions,
            taskInfo: nextTaskInfo,
            feedback: planText,
          };
          this.specialistResume = null;
          this.appendSystem("기획 검수가 통과했습니다. 이제 구현·검수를 실행하거나 전체 실행으로 이어갈 수 있습니다.");
          return { ok: true, stage: "plan_review", planReady: true, taskInfo: nextTaskInfo };
        }

        if (hasOpenQuestions(planReview.text)) {
          contract.canAutoRevise = false;
          contract.stopReason = "NEEDS_DECISION";
        }
        if (
          contract.verdict === "FIX_REQUIRED" &&
          contract.canAutoRevise &&
          planRevisionCount < planRevisionLimit
        ) {
          const transition = this.transitionProfessional({
            type: "PLAN_REVIEW_FIX",
            canAutoRevise: true,
          });
          if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
          planRevisionCount += 1;
          nextFeedback = planReview.text || planText;
          this.appendSystem(
            `기획 검수 결과 수정 필요 · 자동 보완 ${planRevisionCount}/${planRevisionLimit}회`
          );
          continue;
        }

        const transition = this.transitionProfessional({
          type: contract.verdict === "UNKNOWN" ? "PLAN_REVIEW_UNKNOWN" : "PLAN_REVIEW_FIX",
          canAutoRevise: false,
          stopReason: contract.stopReason || contract.verdict,
        });
        if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
        this.specialistResume = {
          stages,
          mode,
          planAutoRevisions: planRevisionLimit,
          implementationAutoRevisions,
          action,
            feedback: planReview.text || planText,
            taskInfo: nextTaskInfo,
            previousIssues: previousPlanIssues,
            phase: "plan_review_fix_required",
        };
        this.appendSystem(
          contract.stopReason === "NEEDS_DECISION"
            ? "기획 검수자가 사용자 결정이 필요한 질문을 남겨 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 답해 주세요."
            : contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "기획 검수 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요."
            : contract.verdict === "UNKNOWN"
            ? "기획 검수에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요."
            : planRevisionCount >= planRevisionLimit && planRevisionLimit > 0
              ? `기획 자동 보완 한도(${planRevisionLimit}회)에 도달했습니다. 아래 전용 입력칸에서 보완 내용을 알려 주세요.`
              : "기획 검수에서 보완 또는 사용자 답변이 필요하다고 판단했습니다. 아래 전용 입력칸에서 답한 뒤 기획·검수를 다시 실행하세요."
        );
        return {
          ok: false,
          stage: "plan_review",
          needsUserDecision: true,
          stopReason:
            planRevisionLimit > 0 &&
            planRevisionCount >= planRevisionLimit &&
            contract.canAutoRevise
              ? "LIMIT_EXCEEDED"
              : contract.stopReason || contract.verdict,
          contract,
          result: planReview,
        };
      }
    } finally {
      // 전체 실행은 기획·검수와 구현·검수를 같은 블록으로 이어야 하므로,
      // 기획 검수 통과 직후에는 일반 대화 대기열을 풀지 않습니다.
      if (action === "full" && this.professionalPlan) {
        this.emitSpecialistState();
      } else {
        this.specialistActive = false;
        this.emitSpecialistState();
        this.turnQueue.push(...this.deferredTurnQueue.splice(0));
        this.emitTurnState();
        this.pumpTurnQueue();
      }
    }
  }

  // Open Question·기획 검수 피드백에 대한 사용자 답변을 Planner의 다음 입력으로 보관합니다.
  async answerPlanQuestion(answer) {
    return this.withProfessionalAuthorization("workspace-write", () => this._answerPlanQuestion(answer));
  }

  async _answerPlanQuestion(answer) {
    const resume = this.specialistResume;
    if (!resume || !["needs_decision", "plan_review_fix_required"].includes(resume.phase)) {
      return { ok: false, error: "답변을 기다리는 기획 질문이 없습니다." };
    }
    const text = String(answer || "").trim();
    if (!text) return { ok: false, error: "기획자에게 보낼 답변을 입력해 주세요." };
    const transition = this.transitionProfessional({ type: "USER_ANSWER_PLAN" });
    if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
    this.specialistResume = null;
    this.appendMessage({ authorType: "user", author: "user", text: `[기획 답변] ${text}` });
    const feedback = `${resume.feedback || ""}\n\n=== 사용자 답변 ===\n${text}\n=== 사용자 답변 끝 ===`;
    const result = await this.runPlanBlock({ ...resume, feedback, taskInfo: resume.taskInfo || null });
    if (resume.action === "full" && result?.ok) {
      return this.runProfessionalImplementation({
        stages: resume.stages,
        mode: resume.mode,
        implementationAutoRevisions: resume.implementationAutoRevisions,
        recordAfter: true,
      });
    }
    return result;
  }

  // 기존 호출 경로는 유지합니다. action을 명시한 새 화면만 버튼형 전문 실행을 씁니다.
  async startSpecialist(options = {}) {
    if (options.stages) this.specialistStages = options.stages;
    // 전문 실행은 세션 권한을 영구히 바꾸지 않고, 이 실행 동안만 유효한
    // run-scoped 권한(workspace-write)을 켜 둔다. 단계별 상한은 그 아래에서
    // 다시 좁혀진다(planner/plan_review=read, recorder=chat 등).
    return this.withProfessionalAuthorization("workspace-write", async () => {
      if (options.action) return this.startProfessionalAction(options);
      return this.startLegacySpecialist(options);
    });
  }

  // 전문 모드 진입점. 화면의 버튼은 action으로 구분합니다.
  // - plan: 기획 → 기획 검수
  // - implementation: 승인된 기획 → 구현 → 구현 검수
  // - record: 기록관만 수동 실행
  // - full: 기획·검수와 구현·검수를 연속 실행하되 질문/보완/막힘에서 중단
  async startProfessionalAction(options = {}) {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    // 일반 응답이 실행·대기 중이면 전문 실행을 큐 뒤에 넣지 않고 즉시 거부합니다.
    // (전문 실행이 일반 응답 뒤에 몰래 대기하지 않도록 합니다.)
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시작해 주세요." };
    }
    const stages = options.stages || {};
    if (options.stages) this.specialistStages = options.stages;
    const action = ["plan", "implementation", "record", "full"].includes(options.action)
      ? options.action
      : "plan";
    const implementation = stages.implementation;
    const review = stages.review;
    const planReviewAgent = stages.planReview || review;
    if ((action === "plan" || action === "full") && (!stages.planner?.agent || !planReviewAgent?.agent)) {
      return { ok: false, error: "전문 모드의 기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    if ((action === "implementation" || action === "full") && (!implementation?.agent || !review?.agent)) {
      return { ok: false, error: "전문 모드의 구현·검토 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    if (action === "full" && !stages.recorder?.agent) {
      return { ok: false, error: "전체 실행에는 기록 담당자를 프로젝트 설정에서 지정해 주세요." };
    }
    const planAutoRevisions = Number.isInteger(options.planAutoRevisions)
      ? Math.min(3, Math.max(0, options.planAutoRevisions))
      : 0;
    const implementationAutoRevisions = Number.isInteger(options.implementationAutoRevisions)
      ? Math.min(3, Math.max(0, options.implementationAutoRevisions))
      : Number.isInteger(options.maxAutoRevisions)
        ? Math.min(3, Math.max(0, options.maxAutoRevisions))
        : 0;
    // 전체 실행은 블록을 이어 붙이고, 구현 자동 보완을 켠 경우에는
    // 구현·검수 버튼에서도 제한된 Builder↔Reviewer 왕복을 허용합니다.
    const mode =
      action === "full" ||
      options.mode === "auto" ||
      implementationAutoRevisions > 0
        ? "auto"
        : "step";

    if (action === "record") {
      if (!stages.recorder?.agent) return { ok: false, error: "기록 담당자를 프로젝트 설정에서 지정해 주세요." };
      const retryingRecorder = this.professionalRun?.node === "RECORDING" && this.professionalRun?.status === "WAITING";
      const retryRunInfo = retryingRecorder && this.professionalRun?.frozenRunId && this.taskManager?.runInfoForId
        ? this.taskManager.runInfoForId(this.professionalRun.frozenRunId, this.meta.workspace)
        : null;
      const retryCheckpoint = retryingRecorder ? this.checkpointForProfessionalRun() : null;
      if (retryingRecorder && !retryRunInfo) {
        return this.holdForFrozenTaskCorruption({
          taskInfo: taskFileInfo(this.professionalRun?.taskPath),
          checkpoint: retryCheckpoint,
          stage: "recorder",
          round: this.professionalRun?.implementationRound || 1,
          error: "기록을 다시 만들기 위한 Frozen Task Run을 찾을 수 없습니다.",
        });
      }
      if (retryingRecorder && retryRunInfo) {
        const frozenCheck = this.validateFrozenTask(retryRunInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo: retryRunInfo,
            taskInfo: taskFileInfo(this.professionalRun?.taskPath),
            checkpoint: retryCheckpoint,
            stage: "recorder",
            round: this.professionalRun?.implementationRound || 1,
            error: frozenCheck.error,
          });
        }
      }
      let retryChanges = "";
      if (retryingRecorder && retryRunInfo) {
        try {
          retryChanges = (await describeWorkspaceChanges(this.meta.workspace, {
            checkpoint: retryCheckpoint,
            excludePaths: runGeneratedPaths(this.meta.workspace, retryRunInfo),
          })).text || "";
        } catch {}
      }
      const retryEvidence = retryingRecorder && retryRunInfo
        ? this.taskManager?.readRunEvidence?.(retryRunInfo) || null
        : null;
      if (retryingRecorder) {
        const transition = this.transitionProfessional({ type: "USER_RETRY_RECORDER" });
        if (!transition.ok) return this.professionalTransitionFailure("recorder", transition);
      }
      this.specialistActive = true;
      this.emitSpecialistState();
      try {
        const recorderResult = await this.runRecorder({
          ...stages.recorder,
          professional: retryingRecorder,
          frozenTask: retryRunInfo ? {
            runId: retryRunInfo.runId,
            content: retryRunInfo.content,
            taskHash: retryRunInfo.taskHash,
          } : null,
          finalVerdict: retryingRecorder ? "PASS" : null,
          reviewDiff: retryChanges,
          evidence: retryEvidence,
          round: this.professionalRun?.implementationRound || 1,
        });
        if (!recorderResult?.ok) {
          if (retryingRecorder) this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RECORDER_FAILED" });
          return recorderResult;
        }
        if (retryingRecorder) {
          const runInfo = retryRunInfo;
          const round = this.professionalRun?.implementationRound || 1;
          const taskInfo = taskFileInfo(this.professionalRun?.taskPath);
          if (runInfo && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
            status: "COMMITTING",
            finalVerdict: "PASS",
            recorded: true,
            round,
          })) {
            this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RUN_STATE_WRITE_FAILED" });
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "RUN_STATE_WRITE_FAILED",
              message: "기록은 만들었지만 완료 전 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          if (!this.updateProfessionalTaskState({
            taskPath: taskInfo?.relativePath || null,
            status: "done",
            activeRunId: null,
            lastRunId: runInfo?.runId || null,
          })) {
            this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "WORKFLOW_WRITE_FAILED" });
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "WORKFLOW_WRITE_FAILED",
              message: "기록은 만들었지만 작업 완료 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          const transition = this.transitionProfessional({ type: "RECORDER_DONE" });
          if (!transition.ok) return this.professionalTransitionFailure("recorder", transition);
          if (runInfo && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
            status: "COMPLETED",
            finalVerdict: "PASS",
            recorded: true,
            round,
          })) {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint: retryCheckpoint,
              stage: "recorder",
              round,
              stopReason: "RUN_STATE_WRITE_FAILED",
              message: "최종 완료 상태를 저장하지 못했습니다. 변경과 복구 정보는 그대로 유지합니다.",
            });
          }
          if (retryCheckpoint && this.checkpointEngine?.cleanupCheckpoint?.(retryCheckpoint)?.ok === false) {
            this.persistRecoveryState(this.recoveryFor(retryCheckpoint, {
              status: "completed",
              runId: runInfo?.runId || null,
              taskPath: this.professionalRun?.taskPath || null,
              stage: "recorder",
              blockReason: "CHECKPOINT_CLEANUP_FAILED",
            }));
          } else {
            this.clearRecoveryState();
          }
        }
        return { ok: true, recorded: true, recording: recorderResult.text || "" };
      } finally {
        this.specialistActive = false;
        this.emitSpecialistState();
      }
    }

    if (action === "plan" || action === "full") {
      const run = createProfessionalRun({
        stages,
        policy: {
          autoContinueReady: action === "full",
          pauseBeforeReview: false,
          pauseBeforeRecord: false,
          planAutoRevisions,
          implementationAutoRevisions,
        },
      });
      if (!this.setProfessionalRun(run)) {
        return this.professionalTransitionFailure("planner", {
          reason: "전문 실행 시작 상태를 저장하지 못했습니다.",
        });
      }
      this.professionalPlan = null;
      const planResult = await this.runPlanBlock({
        stages,
        mode,
        planAutoRevisions,
        implementationAutoRevisions,
        action,
      });
      if (action !== "full" || !planResult?.ok) return planResult;
      return this.runProfessionalImplementation({
        stages,
        mode,
        implementationAutoRevisions,
        recordAfter: true,
      });
    }

    if (this.professionalRun) {
      if (this.professionalRun.node !== "READY") {
        return { ok: false, error: "구현을 시작할 수 있는 READY 상태가 아닙니다." };
      }
      const updatedRun = {
        ...this.professionalRun,
        stages: { ...(this.professionalRun.stages || {}), ...stages },
        policy: {
          ...(this.professionalRun.policy || {}),
          implementationAutoRevisions,
        },
        updatedAt: Date.now(),
      };
      if (!this.setProfessionalRun(updatedRun)) {
        return this.professionalTransitionFailure("implementation", {
          reason: "구현 실행 정책을 저장하지 못했습니다.",
        });
      }
    }
    return this.runProfessionalImplementation({
      stages,
      mode,
      implementationAutoRevisions,
      recordAfter: true,
    });
  }

  async runProfessionalImplementation({
    stages,
    mode,
    implementationAutoRevisions,
    recordAfter,
  }) {
    const implementation = stages.implementation;
    const review = stages.review;
    if (!this.professionalPlan?.taskInfo) {
      return { ok: false, error: "구현·검수는 기획 검수가 통과한 뒤에 실행할 수 있습니다. 먼저 기획·검수를 실행해 주세요." };
    }
    if (this.professionalRun?.approvedTaskHash) {
      const liveTask = this.taskManager.resolveTaskContract(
        { contentSource: "file", taskPath: this.professionalPlan.taskInfo.relativePath },
        this.meta.workspace
      );
      if (!liveTask?.content || hashText(liveTask.content) !== this.professionalRun.approvedTaskHash) {
        const transition = this.transitionProfessional({ type: "TASK_CHANGED_AFTER_REVIEW" });
        if (!transition.ok) return this.professionalTransitionFailure("plan_review", transition);
        this.appendSystem("기획 검수 후 TASK.md가 바뀌어 구현을 시작하지 않았습니다. 기획 검수를 다시 통과시켜 주세요.");
        return {
          ok: false,
          stage: "plan_review",
          needsUserDecision: true,
          stopReason: "TASK_CHANGED_AFTER_REVIEW",
        };
      }
    }

    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.specialistResume = null;
    // 이전 Run이 BLOCKED이면 사용자 선택(keep/restore/replan) 전에는 checkpoint를
    // 정리하거나 새 구현을 시작하지 않는다. UI를 우회한 호출도 같은 보호를 받는다.
    if (this.specialistBlocked) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, error: "앞선 전문 실행이 막힌 상태입니다. 먼저 변경 유지·복원·재기획 중 하나를 선택해 주세요." };
    }
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }

    this.appendSystem(`구현·검수 시작 · 구현 @${implementation.agent.id} · 검수 @${review.agent.id}`);

    const feedback = this.professionalPlan.feedback || "";
    const taskInfo = this.professionalPlan.taskInfo;
    try {
      return await this.runExecutionBlock({
        stages,
        mode,
        maxAutoRevisions: implementationAutoRevisions,
        feedback,
        taskInfo,
        round: 1,
        requestedGeneration,
        recordAfter,
      });
    } finally {
      this.specialistActive = false;
      // PLAN_READY 등 승인 Gate에서는 resume 상태가 이미 먼저 전송됩니다.
      // 여기서 active=false를 다시 알리지 않으면 renderer가 "실행 중"으로
      // 남아 승인 버튼을 비활성화한 채 멈춥니다.
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 기획 승인 후 이어서 진행합니다. step/auto에서 PLAN_READY로 멈춘 상태만 재개합니다.
  async resumeSpecialist() {
    return this.withProfessionalAuthorization("workspace-write", () => this._resumeSpecialist());
  }

  async _resumeSpecialist() {
    if (this.discussionRequested || this.discussionActive || this.specialistActive) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    if (!this.specialistResume) {
      return { ok: false, error: "이어서 진행할 기획이 없습니다. 전문 모드를 다시 시작해 주세요." };
    }
    // 일반 응답이 실행·대기 중이면 이어서 진행하지 않고 거부합니다.
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시도해 주세요." };
    }
    const resume = this.specialistResume;
    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }
    this.specialistResume = null;
    this.emitSpecialistState();
    // 단계별(step) 실행은 phase에 따라 다음 한 단계만 진행합니다.
    if (resume.mode === "step") {
      return this.resumeStepPhase(resume, requestedGeneration);
    }
    this.appendSystem("기획이 승인되었습니다. 구현을 이어서 진행합니다.");
    try {
      return await this.runExecutionBlock({
        stages: resume.stages,
        mode: resume.mode,
        maxAutoRevisions: resume.maxAutoRevisions,
        feedback: resume.feedback,
        taskInfo: resume.taskInfo || null,
        round: 1,
        requestedGeneration,
      });
    } finally {
      this.specialistActive = false;
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 기존 step / 제한 자동 / 빠른 실행 호출 호환용 경로입니다.
  async startLegacySpecialist(options = {}) {
    if (this.discussionRequested || this.discussionActive || this.isSpecialistLocked()) {
      return { ok: false, error: "이미 다른 전문 작업이나 토론이 진행 중입니다." };
    }
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) {
      return { ok: false, error: "응답이 진행 중입니다. 응답이 끝난 뒤 다시 시작해 주세요." };
    }
    const stages = options.stages || {};
    const implementation = stages.implementation;
    const review = stages.review;
    const planner = stages.planner;
    if (!implementation?.agent || !review?.agent) {
      return { ok: false, error: "전문 모드의 구현·검토 담당자를 프로젝트 설정에서 지정해 주세요." };
    }

    const mode = options.mode === "auto" ? "auto" : options.mode === "quick" ? "quick" : "step";
    const maxAutoRevisions = Number.isInteger(options.maxAutoRevisions) && options.maxAutoRevisions >= 0
      ? Math.min(options.maxAutoRevisions, 3)
      : mode === "step" ? 0 : 1;
    const requestedGeneration = this.generation;
    this.specialistActive = true;
    this.specialistResume = null;
    if (this.specialistBlocked) {
      if (this.checkpointEngine && this.specialistBlocked.checkpoint) {
        this.checkpointEngine.cleanupCheckpoint(this.specialistBlocked.checkpoint);
      }
      this.specialistBlocked = null;
      this.clearRecoveryState();
    }
    this.emitSpecialistState();
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.specialistActive = false;
      this.emitSpecialistState();
      return { ok: false, cancelled: true };
    }

    this.appendSystem(`전문 모드 시작 · 구현 @${implementation.agent.id} · 검토 @${review.agent.id}`);
    let feedback = "";
    let taskInfo = null;
    try {
      if (planner?.agent) {
        const plannerResult = await this.scheduleResponse(planner.agent, {
          specialist: { stage: "planner", round: 1, maxRounds: 1 },
          agentConfig: planner.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        if (!plannerResult?.ok) return this.specialistFail(planner, "planner", 0, plannerResult);
        if (plannerResult.plannerStatus === "NEEDS_DECISION" || hasOpenQuestions(plannerResult.text)) {
          return {
            ok: false,
            stage: "planner",
            completedIterations: 0,
            needsUserDecision: true,
            stopReason: "NEEDS_DECISION",
            result: plannerResult,
          };
        }
        if (this.meta.workspace) {
          try {
            taskInfo = this.taskManager.createTaskFromPlanner(plannerResult.text || "", this.meta.workspace);
            if (taskInfo && this.onTaskCreated) {
              const registered = this.onTaskCreated({
                title: taskInfo.filename,
                description: "",
                contentSource: "file",
                taskPath: taskInfo.relativePath,
                taskHash: taskInfo.hash,
                status: "todo",
                role: "implementation",
              });
              if (registered === false) throw new Error("TASK_INDEX_FAILED");
            }
          } catch (error) {
            this.appendSystem(`기획 결과를 TASK.md로 저장하지 못했습니다. (${error?.message || "알 수 없는 오류"})`);
            return {
              ok: false,
              stage: "planner",
              completedIterations: 0,
              needsUserDecision: true,
              stopReason: "PLAN_READY",
              result: plannerResult,
              taskError: error?.message || "알 수 없는 오류",
            };
          }
        }
        feedback = taskInfo ? taskInfo.content : plannerResult.text || "";
        if (mode !== "quick") {
          this.specialistResume = { stages, mode, maxAutoRevisions, feedback, taskInfo, phase: "plan_ready" };
          this.emitSpecialistState();
          this.appendSystem("기획(PLAN_READY)이 완료되었습니다. 승인하시면 구현을 이어서 진행합니다.");
          return {
            ok: false,
            stage: "planner",
            completedIterations: 0,
            needsUserDecision: true,
            stopReason: "PLAN_READY",
            result: plannerResult,
          };
        }
      }

      return await this.runExecutionBlock({
        stages,
        mode,
        maxAutoRevisions,
        feedback,
        taskInfo,
        round: 1,
        requestedGeneration,
      });
    } finally {
      this.specialistActive = false;
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // 승인 대기 중인 전문 실행을 명시적으로 끝냅니다.
  // 이미 만들어진 Builder 변경은 복원하지 않고 보존합니다. 복원이 필요하면 BLOCKED 메뉴를 씁니다.
  cancelSpecialist() {
    if (!this.specialistActive && !this.specialistResume) {
      return { ok: false, error: "취소할 전문 실행이 없습니다." };
    }
    const professionalAct = Boolean(
      this.professionalRun &&
      this.professionalRun.status === "RUNNING" &&
      ["IMPLEMENTING", "REVIEWING", "RECORDING"].includes(this.professionalRun.node)
    );
    const runInfo = professionalAct && this.professionalRun?.frozenRunId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(this.professionalRun.frozenRunId, this.meta.workspace)
      : null;
    const taskInfo = professionalAct ? taskFileInfo(this.professionalRun?.taskPath) : null;
    const checkpoint = professionalAct
      ? this.checkpointForProfessionalRun()
      : this.specialistResume?.checkpoint || null;
    this.specialistResume = null;
    this.specialistActive = false;
    this.stopAllSilently();
    // ACT 시작 뒤의 중지는 조용한 정리가 아니다. Builder가 남긴 부분 변경과
    // checkpoint를 보존해 사용자가 keep/restore/replan을 선택하게 한다.
    if (professionalAct) {
      const held = this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: this.professionalRun?.node === "REVIEWING"
          ? "review"
          : this.professionalRun?.node === "RECORDING"
            ? "recorder"
            : "implementation",
        round: this.professionalRun?.implementationRound || 1,
        stopReason: "USER_INTERRUPTED",
        message: "사용자가 전문 실행을 중지했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
      });
      return { ...held, ok: true, cancelled: true };
    }
    if (this.professionalRun) {
      const transition = this.transitionProfessional({ type: "INTERRUPT", stopReason: "USER_INTERRUPTED" });
      if (!transition.ok) return this.professionalTransitionFailure("planner", transition);
      this.clearRecoveryState();
      this.emitSpecialistState();
      this.appendSystem("전문 실행을 취소했습니다.");
      return { ok: true, cancelled: true };
    }
    if (checkpoint && this.checkpointEngine) {
      this.checkpointEngine.cleanupCheckpoint(checkpoint);
    }
    this.clearRecoveryState();
    this.emitSpecialistState();
    this.appendSystem("전문 실행을 취소했습니다. 현재 작업 결과는 그대로 유지됩니다.");
    return { ok: true, cancelled: true };
  }

  // 단계별(step) 실행의 다음 단계를 진행합니다.
  //   plan_ready          → Builder 실행 후 phase: builder_done으로 멈춤
  //   builder_done        → Reviewer 실행
  //   review_fix_required → Builder 보완 (step에서는 사용자 확인 후 수동 진행)
  //   review_pass         → Recorder 실행 후 완료
  async resumeStepPhase(resume, requestedGeneration) {
    const { stages, feedback, taskInfo, maxAutoRevisions } = resume;
    const implementation = stages.implementation;
    const review = stages.review;
    const recorder = stages.recorder;
    const workspace = this.meta.workspace;
    // TASK-007: step 모드에서도 실행 시점에 Task를 동결(Freeze)합니다.
    // 승인 시점에 한 번 FREEZE하고, 같은 Run의 모든 단계(builder·review·보완)가
    // 동일한 불변 Frozen Task를 사용하도록 resume에 runInfo를 보관합니다.
    let runInfo = resume.runInfo || null;
    let checkpoint = resume.checkpoint || null;
    let retainCheckpoint = false;
    const frozenTaskId = taskInfo?.filename ? String(taskInfo.filename).replace(/\.md$/i, "") : null;
    const frozenTaskMeta = () =>
      runInfo
        ? {
            runId: runInfo.runId,
            content: runInfo.content,
            taskId: frozenTaskId,
            taskHash: runInfo.taskHash || null,
          }
        : null;
    const freezeOnce = async () => {
      if (runInfo) {
        const check = this.validateFrozenTask(runInfo);
        if (!check.ok) {
          const error = new Error(check.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
        return runInfo;
      }
      if (taskInfo) {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
        const check = this.validateFrozenTask(runInfo);
        if (!check.ok) {
          const error = new Error(check.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
      }
      // Checkpoint 생성 전 저널을 먼저 남겨, 생성 중 종료도 자동 재개하지 않고
      // 사용자 선택 상태로 복원할 수 있게 합니다.
      const recoveryContext = {
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
      };
      if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(null, {
        ...recoveryContext,
        status: "checkpointing",
      }))) {
        throw new Error("복구 저널을 저장하지 못했습니다.");
      }
      // TASK-006: Builder 실행 직전 workspace 상태 보존 (지원 시).
      if (!checkpoint && this.checkpointEngine) {
        checkpoint = await this.checkpointEngine.createCheckpoint(workspace, {
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: runInfo?.runId || null,
        });
      }
      // Git 저장소인데 백업 생성에 실패하면(non-Git과 구분되는 failed) 복원
      // 수단 없이 진행하지 않고 중단한다.
      if (checkpoint?.failed === true) {
        this.clearRecoveryState();
        const error = new Error("작업 전 상태 백업(checkpoint)을 만들지 못했습니다.");
        error.code = "CHECKPOINT_FAILED";
        throw error;
      }
      if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(checkpoint, {
        ...recoveryContext,
        status: "running",
      }))) {
        throw new Error("복구 저널을 저장하지 못했습니다.");
      }
      return runInfo;
    };
    const cleanupCheckpoint = () => {
      if (checkpoint?.supported === true && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
    };
    const holdForBlocked = (blockedRound, blockedResult, declaration = "BLOCKED") => {
      const canRestore = Boolean(checkpoint && checkpoint.supported === true);
      const stopReason = declaration === "MISSING"
        ? "BUILDER_STATUS_MISSING"
        : declaration === "AMBIGUOUS"
          ? "BUILDER_STATUS_AMBIGUOUS"
          : "BLOCKED";
      const message = declaration === "MISSING"
        ? "구현 결과에 STATUS: DONE 또는 STATUS: BLOCKED가 없어 안전하게 멈췄습니다. 아래에서 다음 처리를 선택해 주세요."
        : declaration === "AMBIGUOUS"
          ? "구현 결과에 서로 다른 STATUS 표기가 있어 최종 상태를 판단할 수 없습니다. 아래에서 다음 처리를 선택해 주세요."
          : "구현이 막혔습니다(BLOCKED). 아래에서 다음 처리를 선택해 주세요.";
      this.specialistBlocked = {
        checkpoint: canRestore ? checkpoint : null,
        canRestore,
        taskPath: taskInfo?.relativePath || null,
        runId: runInfo?.runId || null,
        stage: "implementation",
        blockReason: stopReason,
      };
      this.persistRecoveryState(this.recoveryFor(checkpoint, {
        status: "blocked",
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
        blockReason: stopReason,
      }));
      retainCheckpoint = canRestore;
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(message);
      return { ok: false, stage: "implementation", completedIterations: blockedRound, needsUserDecision: true, stopReason, blocked: true, canRestore, result: blockedResult };
    };

    try {
      if (resume.phase === "plan_ready") {
        // 승인 시점에 Task를 동결하고 Checkpoint를 생성합니다.
        try {
          await freezeOnce();
        } catch (error) {
          if (error?.code === "FROZEN_TASK_CORRUPTED") {
            return this.holdForFrozenTaskCorruption({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "implementation",
              round: 0,
              error: error.message,
            });
          }
          if (error?.code === "CHECKPOINT_FAILED") {
            this.appendSystem("작업 전 상태 백업(checkpoint)을 만들지 못해 전문 실행을 시작하지 않았습니다. 워크스페이스의 Git 상태를 확인해 주세요.");
            return { ok: false, stage: "implementation", completedIterations: 0, needsUserDecision: true, stopReason: "CHECKPOINT_FAILED" };
          }
          this.appendSystem(`Frozen Task를 만들지 못해 실행을 중단합니다. (${error?.message || "알 수 없는 오류"})`);
          return { ok: false, stage: "planner", completedIterations: 0, needsUserDecision: true, stopReason: "FROZEN_TASK_MISSING", taskError: error?.message || "알 수 없는 오류" };
        }
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            error: frozenCheck.error,
          });
        }
        // Builder 실행.
        const builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 1, maxRounds: 1, feedback: runInfo ? "" : feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterBuilder = this.validateFrozenTask(runInfo);
        if (!frozenAfterBuilder.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            error: frozenAfterBuilder.error,
          });
        }
        if (!builderResult?.ok && builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 1,
            stopReason: builderResult.stopReason,
            result: builderResult,
            message: "구현 프롬프트가 허용된 크기를 넘어 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        if (!builderResult?.ok) return this.specialistFail(implementation, "implementation", 1, builderResult);
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(1, builderResult, builderResult.builderStatus);
        // 구현 완료 → 사용자 확인 대기.
        const changeSnapshot = await describeWorkspaceChanges(workspace, {
          checkpoint,
          excludePaths: runGeneratedPaths(workspace, runInfo),
        });
        if (changeSnapshot.diff.status === "FAILED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            stopReason: "DIFF_COLLECTION_FAILED",
            result: { changes: changeSnapshot.diff },
            message: "변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        this.specialistResume = {
          ...resume,
          phase: "builder_done",
          runInfo,
          checkpoint,
          builderChanges: changeSnapshot.text,
          builderDiff: changeSnapshot.diff,
          builderEvidence: builderResult.evidence || null,
          builderTransport: builderResult.transport || "COMPLETED",
          builderStatus: builderResult.builderStatus || "MISSING",
          builderRunId: builderResult.runId || null,
        };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("구현이 완료되었습니다. 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 1, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      if (resume.phase === "builder_done") {
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            error: frozenCheck.error,
          });
        }
        const stepBuilderResult = {
          ok: true,
          runId: resume.builderRunId || null,
          evidence: resume.builderEvidence || null,
          transport: resume.builderTransport || "COMPLETED",
          builderStatus: resume.builderStatus || "MISSING",
        };
        const stepEvidence = this.prepareReviewEvidence({
          runInfo,
          builderResult: stepBuilderResult,
          diff: resume.builderDiff || { status: "NO_CHANGES" },
          round: 1,
          provider: implementation.agent.id,
        });
        if (!stepEvidence.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            stopReason: "EVIDENCE_WRITE_FAILED",
            result: { evidence: stepEvidence.payload },
            message: "실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        // Reviewer 실행.
        const reviewResult = await this.scheduleResponse(review.agent, {
          specialist: {
            stage: "review",
            round: 1,
            maxRounds: 1,
            frozenTask: frozenTaskMeta(),
            reviewDiff: resume.builderChanges || "",
            changes: resume.builderDiff?.status || "UNSUPPORTED",
            axes: this.executionAxes({ builderResult: stepBuilderResult, diff: resume.builderDiff }),
            evidence: stepEvidence.payload,
          },
          agentConfig: review.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterReview = this.validateFrozenTask(runInfo);
        if (!frozenAfterReview.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 1,
            error: frozenAfterReview.error,
          });
        }
        if (!reviewResult?.ok) {
          if (reviewResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "review",
              round: 1,
              stopReason: reviewResult.stopReason,
              result: reviewResult,
              message: "검수 프롬프트가 허용된 크기를 넘어 검수를 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
            });
          }
          return this.specialistFail(review, "review", 1, reviewResult);
        }
        const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
        if (contract.verdict === "PASS") {
          if (this.strictReviewDiff && resume.builderDiff?.status === "UNSUPPORTED") {
            const degraded = this.holdForDegradedReview({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "review",
              round: 1,
              changes: resume.builderDiff,
              review: reviewResult,
            });
            retainCheckpoint = Boolean(checkpoint?.supported);
            return { ...degraded, contract };
          }
          this.specialistResume = { ...resume, phase: "review_pass", runInfo, checkpoint };
          retainCheckpoint = Boolean(checkpoint?.supported);
          this.emitSpecialistState();
          this.appendSystem("검토가 통과되었습니다. 기록하고 완료하려면 승인해 주세요.");
          return { ok: false, stage: "review", completedIterations: 1, needsUserDecision: true, stopReason: "REVIEW_PASS", contract };
        }
        if (contract.verdict === "UNKNOWN") {
          this.specialistActive = false;
          this.appendSystem(
            contract.stopReason === "AMBIGUOUS_VERDICT"
              ? "검토 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래에서 직접 확인해 주세요."
              : "검토에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래에서 직접 확인해 주세요."
          );
          return {
            ok: false,
            stage: "review",
            completedIterations: 1,
            needsUserDecision: true,
            stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
            contract,
            review: reviewResult,
          };
        }
        // FIX_REQUIRED → 사용자 확인 후 수동 보완.
        this.specialistResume = { ...resume, phase: "review_fix_required", reviewContract: contract, reviewText: reviewResult.text || "", runInfo, checkpoint };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("검토에서 수정 필요가 나왔습니다. 수정을 진행하려면 승인해 주세요.");
        return { ok: false, stage: "review", completedIterations: 1, needsUserDecision: true, stopReason: "FIX_REQUIRED", contract, review: reviewResult };
      }

      if (resume.phase === "review_fix_required") {
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 2,
            error: frozenCheck.error,
          });
        }
        // Builder 보완 후 다시 검토.
        const builderResult = await this.scheduleResponse(implementation.agent, {
          specialist: { stage: "implementation", round: 2, maxRounds: 1, feedback: resume.reviewText || feedback, frozenTask: frozenTaskMeta() },
          agentConfig: implementation.agentConfig,
        });
        if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
        const frozenAfterRevision = this.validateFrozenTask(runInfo);
        if (!frozenAfterRevision.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round: 2,
            error: frozenAfterRevision.error,
          });
        }
        if (!builderResult?.ok) {
          if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
            return this.holdForRecovery({
              runInfo,
              taskInfo,
              checkpoint,
              stage: "implementation",
              round: 2,
              stopReason: builderResult.stopReason,
              result: builderResult,
              message: "구현 프롬프트가 허용된 크기를 넘어 보완을 시작하지 못했습니다. 기존 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
            });
          }
          return this.specialistFail(implementation, "implementation", 2, builderResult);
        }
        if (builderResult.builderStatus !== "DONE") return holdForBlocked(2, builderResult, builderResult.builderStatus);
        const changeSnapshot = await describeWorkspaceChanges(workspace, {
          checkpoint,
          excludePaths: runGeneratedPaths(workspace, runInfo),
        });
        if (changeSnapshot.diff.status === "FAILED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round: 2,
            stopReason: "DIFF_COLLECTION_FAILED",
            result: { changes: changeSnapshot.diff },
            message: "보완 후 변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        this.specialistResume = {
          ...resume,
          phase: "builder_done",
          runInfo,
          checkpoint,
          builderChanges: changeSnapshot.text,
          builderDiff: changeSnapshot.diff,
          builderEvidence: builderResult.evidence || null,
          builderTransport: builderResult.transport || "COMPLETED",
          builderStatus: builderResult.builderStatus || "MISSING",
          builderRunId: builderResult.runId || null,
        };
        retainCheckpoint = Boolean(checkpoint?.supported);
        this.emitSpecialistState();
        this.appendSystem("보완이 완료되었습니다. 다시 검토를 시작하려면 승인해 주세요.");
        return { ok: false, stage: "implementation", completedIterations: 2, needsUserDecision: true, stopReason: "BUILDER_DONE" };
      }

      if (resume.phase === "review_pass") {
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "recorder",
            round: 1,
            error: frozenCheck.error,
          });
        }
        // Recorder 실행 후 완료.
        let recorderResult = null;
        if (recorder?.agent) {
          recorderResult = await this.scheduleResponse(recorder.agent, {
            specialist: {
              stage: "recorder",
              professional: true,
              round: 1,
              maxRounds: 1,
              frozenTask: frozenTaskMeta(),
              reviewDiff: resume.builderChanges || "",
              finalVerdict: "PASS",
              evidence: resume.builderEvidence || null,
            },
            agentConfig: recorder.agentConfig,
          });
          if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
          if (!recorderResult?.ok) {
            this.specialistActive = false;
            const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
            this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
            return { ok: true, completedIterations: 1, recorded: false, recording: recorderResult?.text || "", recordError };
          }
        }
        this.specialistActive = false;
        this.appendSystem("전문 모드 구현·검토·기록이 완료되었습니다.");
        return { ok: true, completedIterations: 1, recorded: Boolean(recorderResult?.ok), recording: recorderResult?.text || "" };
      }

      this.specialistActive = false;
      return { ok: false, error: "알 수 없는 단계입니다." };
    } finally {
      this.specialistActive = false;
      if (!retainCheckpoint && !this.specialistBlocked) {
        cleanupCheckpoint();
        this.clearRecoveryState();
      }
      this.emitSpecialistState();
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
  }

  // Builder → Reviewer → (auto면 자동 보완) → 기록관(블록 끝) 실행 블록.
  async runExecutionBlock({ stages, mode, maxAutoRevisions, feedback, taskInfo, round, requestedGeneration, recordAfter = true }) {
    const implementation = stages.implementation;
    const review = stages.review;
    const recorder = stages.recorder;
    // 자동 진행 모드여도 사용자가 보완 횟수를 허용한 경우에만 재실행합니다.
    const canAutoRevise =
      (mode === "auto" || mode === "quick") && maxAutoRevisions > 0;
    const maxRounds = canAutoRevise ? maxAutoRevisions + 1 : 1;
    let autoRevisionCount = 0;
    let recorderResult = null;
    // TASK-008: Builder가 만든 실제 변경(Diff)을 수집해 Reviewer에게 전달합니다.
    // 각 Builder 실행 직후 갱신되며, 검토자는 이 Diff를 Frozen Task와 함께 받습니다.
    let builderChanges = "";
    let changeSnapshot = null;
    let reviewEvidence = null;

    // TASK-007: 실행 계약(Freeze)을 checkpoint보다 먼저 수행합니다.
    // 실행 순서: Task 승인 → Run 생성/Freeze → Checkpoint → Builder
    // - runInfo가 이미 있으면(같은 Run의 자동 보완) 재freeze하지 않고 재사용합니다.
    // - Planner Task(inline 포함)든 수동 Task든 하나의 RUN/task.md로 정규화합니다.
    // - Frozen Task 누락/손상 시 현재 TASK.md로 fallback 하지 않고 중단합니다.
    let runInfo = null;
    const workspace = this.meta.workspace;
    if (taskInfo) {
      try {
        runInfo = this.taskManager.freezeTask(
          { contentSource: "file", taskPath: taskInfo.relativePath || null, description: "" },
          workspace
        );
        const frozenCheck = this.validateFrozenTask(runInfo);
        if (!frozenCheck.ok) {
          const error = new Error(frozenCheck.error);
          error.code = "FROZEN_TASK_CORRUPTED";
          throw error;
        }
      } catch (error) {
        if (error?.code === "FROZEN_TASK_CORRUPTED") {
          return this.holdForFrozenTaskCorruption({
            runInfo,
            taskInfo,
            stage: "implementation",
            round,
            error: error.message,
          });
        }
        this.appendSystem(`Frozen Task를 만들지 못해 실행을 중단합니다. (${error?.message || "알 수 없는 오류"})`);
        return {
          ok: false,
          stage: "planner",
          completedIterations: 0,
          needsUserDecision: true,
          stopReason: "FROZEN_TASK_MISSING",
          taskError: error?.message || "알 수 없는 오류",
        };
      }
    }

    // TASK-006: Builder 실행 직전 workspace 상태를 보존합니다.
    // 지원되지 않는 workspace(git 아님/없음)라면 checkpoint를 만들지 않고 진행합니다.
    if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(null, {
      status: "checkpointing",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage: "implementation",
    }))) {
      this.appendSystem("복구 저널을 저장하지 못해 전문 실행을 시작할 수 없습니다.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "RECOVERY_JOURNAL_WRITE_FAILED",
      };
    }
    const checkpoint = this.checkpointEngine
      ? await this.checkpointEngine.createCheckpoint(this.meta.workspace, {
          storageRoot: this.checkpointRoot,
          sessionId: this.sessionId,
          runId: runInfo?.runId || null,
        })
      : null;
    // Git 저장소인데 백업 생성에 실패한 경우(failed)에는 non-Git처럼 그냥
    // 진행하지 않는다. 복원 수단 없이 Builder가 파일을 바꾸는 것을 막고,
    // 변경 없이 안전하게 멈춰 사용자에게 알린다.
    if (checkpoint?.failed === true) {
      this.clearRecoveryState();
      this.appendSystem("작업 전 상태 백업(checkpoint)을 만들지 못해 전문 실행을 시작하지 않았습니다. 워크스페이스의 Git 상태를 확인해 주세요.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "CHECKPOINT_FAILED",
      };
    }
    if (this.persistRecovery && !this.persistRecoveryState(this.recoveryFor(checkpoint, {
      status: "running",
      runId: runInfo?.runId || null,
      taskPath: taskInfo?.relativePath || null,
      stage: "implementation",
    }))) {
      if (checkpoint?.supported && this.checkpointEngine) this.checkpointEngine.cleanupCheckpoint(checkpoint);
      this.appendSystem("복구 저널을 저장하지 못해 전문 실행을 시작할 수 없습니다.");
      return {
        ok: false,
        stage: "implementation",
        needsUserDecision: true,
        stopReason: "RECOVERY_JOURNAL_WRITE_FAILED",
      };
    }
    const executeTransition = this.transitionProfessional({
      type: "USER_EXECUTE",
      frozenRunId: runInfo?.runId || null,
      checkpointId: checkpoint?.checkpointId || null,
    });
    if (!executeTransition.ok) {
      if (checkpoint?.supported && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
      this.clearRecoveryState();
      return this.professionalTransitionFailure("implementation", executeTransition);
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      status: "in_progress",
      activeRunId: runInfo?.runId || null,
      lastRunId: null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        message: "작업 목록 상태를 저장하지 못해 구현을 시작하지 않았습니다. 복구 정보는 그대로 유지합니다.",
      });
    }

    // 화면에 "어떤 Task revision 기준으로 일하는 중인지" 칩으로 보여주기 위한 값.
    // TASK-003.md → "TASK-003" 형태의 표시용 id를 만듭니다.
    const frozenTaskId = taskInfo?.filename
      ? String(taskInfo.filename).replace(/\.md$/i, "")
      : null;
    const frozenTaskMeta = () =>
      runInfo
        ? {
            runId: runInfo.runId,
            content: runInfo.content,
            taskId: frozenTaskId,
            taskHash: runInfo.taskHash || null,
          }
        : null;
    const checkpointSupported = Boolean(checkpoint && checkpoint.supported === true);
    const restoreCheckpoint = async () => {
      if (!checkpointSupported || !this.checkpointEngine) return;
      const result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, checkpoint, {
        preservePaths: runGeneratedPaths(workspace, runInfo),
      });
      if (result?.ok) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
        this.clearRecoveryState();
        return result;
      }
      this.appendSystem("작업 전 상태로 되돌리지 못했습니다. 변경과 복구 저널을 그대로 유지합니다.");
      return result || { ok: false, reason: "restore-failed" };
    };
    const cleanupCheckpoint = () => {
      if (checkpointSupported && this.checkpointEngine) {
        this.checkpointEngine.cleanupCheckpoint(checkpoint);
      }
    };
    // 새 PLAN → ACT 경로는 ACT 중 생긴 실패를 자동 복원으로 숨기지 않는다.
    // legacy step/auto/quick은 기존 동작을 유지하고, professionalRun이 있는
    // 실행만 변경·checkpoint를 남긴 BLOCKED 상태로 전환한다.
    const holdProfessionalFailure = ({ stage, stopReason, result = null, changes = null, message }) => {
      if (!this.professionalRun) return null;
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage,
        round,
        stopReason,
        result,
        changes: changes || changeSnapshot,
        message,
      });
    };
    const validateForStage = (stage, currentRound) => {
      const frozenCheck = this.validateFrozenTask(runInfo);
      if (frozenCheck.ok) return null;
      return this.holdForFrozenTaskCorruption({
        runInfo,
        taskInfo,
        checkpoint,
        stage,
        round: currentRound,
        error: frozenCheck.error,
      });
    };

    // BLOCKED(A안): 즉시 되돌리지 않고 Builder 작업물을 그대로 둔 채 멈춥니다.
    // 사용자가 [작업 전으로 복원]/[Task 폐기]를 고르면 그때 복원합니다.
    const holdForBlocked = (blockedRound, blockedResult, declaration = "BLOCKED") => {
      const stopReason = declaration === "MISSING"
        ? "BUILDER_STATUS_MISSING"
        : declaration === "AMBIGUOUS"
          ? "BUILDER_STATUS_AMBIGUOUS"
          : "BLOCKED";
      this.transitionProfessional({
        type: "BUILDER_BLOCKED",
        blockReason: stopReason,
      });
      this.persistBlockedRun({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round: blockedRound,
        stopReason,
        result: blockedResult,
        changes: changeSnapshot,
      });
      this.specialistBlocked = {
        checkpoint: checkpointSupported ? checkpoint : null,
        canRestore: checkpointSupported,
        taskPath: taskInfo?.relativePath || null,
        runId: runInfo?.runId || null,
        stage: "implementation",
        blockReason: stopReason,
      };
      this.persistRecoveryState(this.recoveryFor(checkpoint, {
        status: "blocked",
        runId: runInfo?.runId || null,
        taskPath: taskInfo?.relativePath || null,
        stage: "implementation",
        blockReason: stopReason,
      }));
      this.specialistActive = false;
      this.emitSpecialistState();
      this.appendSystem(
        declaration === "MISSING"
          ? "구현 결과에 STATUS: DONE 또는 STATUS: BLOCKED가 없어 안전하게 멈췄습니다. 아래에서 다음 처리를 선택해 주세요."
          : declaration === "AMBIGUOUS"
            ? "구현 결과에 서로 다른 STATUS 표기가 있어 최종 상태를 판단할 수 없습니다. 아래에서 다음 처리를 선택해 주세요."
            : checkpointSupported
              ? "구현이 막혔습니다(BLOCKED). 지금까지의 변경은 그대로 두었습니다. 아래에서 다음 처리를 선택해 주세요."
              : "구현이 막혔습니다(BLOCKED). 아래에서 다음 처리를 선택해 주세요. (git workspace가 아니라 자동 복원은 지원되지 않습니다)"
      );
      return {
        ok: false,
        stage: "implementation",
        completedIterations: blockedRound,
        needsUserDecision: true,
        stopReason,
        blocked: true,
        canRestore: checkpointSupported,
        result: blockedResult,
      };
    };

    const frozenBeforeBuilder = validateForStage("implementation", round);
    if (frozenBeforeBuilder) return frozenBeforeBuilder;
    let builderResult = await this.scheduleResponse(implementation.agent, {
      specialist: {
        stage: "implementation",
        round,
        maxRounds,
        // TASK-007: 최초 Builder의 실행 계약 source는 Frozen Task입니다.
        // (자동 보완에서는 아래에서 Reviewer 피드백도 별도로 전달합니다.)
        feedback: runInfo ? "" : feedback,
        frozenTask: frozenTaskMeta(),
      },
      agentConfig: implementation.agentConfig,
    });
    const frozenAfterBuilder = validateForStage("implementation", round);
    if (frozenAfterBuilder) return frozenAfterBuilder;
    // Builder 실행이 끝난 뒤 실제 변경분을 수집합니다. (git 아니면 빈 값)
    changeSnapshot = await describeWorkspaceChanges(workspace, {
      checkpoint,
      excludePaths: runGeneratedPaths(workspace, runInfo),
    });
    builderChanges = changeSnapshot.text;
    if (changeSnapshot.diff.status === "FAILED") {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "DIFF_COLLECTION_FAILED",
        result: { changes: changeSnapshot.diff },
        message: "변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
      });
    }
    if (requestedGeneration !== this.generation) {
      if (!this.professionalRun) cleanupCheckpoint();
      return { ok: false, cancelled: true };
    }
    if (!builderResult?.ok) {
      if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          stopReason: builderResult.stopReason,
          result: builderResult,
          message: "구현 프롬프트가 허용된 크기를 넘어 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
      const held = holdProfessionalFailure({
        stage: "implementation",
        stopReason: builderResult.stopReason || "TRANSPORT_FAILED",
        result: builderResult,
        message: "구현 에이전트가 끝나기 전에 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
      });
      if (held) return held;
      await restoreCheckpoint();
      return this.specialistFail(implementation, "implementation", round, builderResult);
    }
    if (builderResult.builderStatus !== "DONE") {
      return holdForBlocked(round, builderResult, builderResult.builderStatus);
    }
    const builderTransition = this.transitionProfessional({ type: "BUILDER_DONE" });
    if (!builderTransition.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "implementation",
        round,
        stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
        result: builderTransition,
        message: "구현은 끝났지만 실행 상태를 저장하지 못해 검수를 시작하지 않았습니다. 변경은 그대로 남아 있습니다.",
      });
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      status: "review",
      activeRunId: runInfo?.runId || null,
      lastRunId: null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        changes: changeSnapshot,
        message: "작업 목록 상태를 저장하지 못해 검수를 시작하지 않았습니다. 변경과 복구 정보는 그대로 유지합니다.",
      });
    }
    reviewEvidence = this.prepareReviewEvidence({
      runInfo,
      builderResult,
      diff: changeSnapshot.diff,
      round,
      provider: implementation.agent.id,
    });
    if (!reviewEvidence.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "review",
        round,
        stopReason: "EVIDENCE_WRITE_FAILED",
        result: { evidence: reviewEvidence.payload },
        message: "실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
      });
    }

    // 검토 → (자동 보완) 루프.
    while (true) {
      const frozenBeforeReview = validateForStage("review", round);
      if (frozenBeforeReview) return frozenBeforeReview;
      const reviewResult = await this.scheduleResponse(review.agent, {
        specialist: {
          stage: "review",
          round,
          maxRounds,
          // TASK-007: Reviewer는 동일 Run의 Frozen Task + 실제 Diff + Test 기준으로 검수합니다.
          frozenTask: frozenTaskMeta(),
          // TASK-008: Builder가 실제로 만든 변경(Diff)을 주입합니다.
          reviewDiff: builderChanges,
          changes: changeSnapshot.diff?.status || "UNSUPPORTED",
          axes: {
            ...this.executionAxes({ builderResult, diff: changeSnapshot.diff }),
          },
          evidence: reviewEvidence.payload,
        },
        agentConfig: review.agentConfig,
      });
      if (requestedGeneration !== this.generation) {
        if (!this.professionalRun) cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!reviewResult?.ok) {
        if (reviewResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: reviewResult.stopReason,
            result: reviewResult,
            message: "검수 프롬프트가 허용된 크기를 넘어 검수를 시작하지 못했습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: reviewResult.stopReason || "TRANSPORT_FAILED",
          result: reviewResult,
          message: "검수 에이전트가 끝나기 전에 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return this.specialistFail(review, "review", round, reviewResult);
      }
      const frozenAfterReview = validateForStage("review", round);
      if (frozenAfterReview) return frozenAfterReview;

      const contract = this.parseReviewContract(reviewResult.text || "", reviewResult.specialistSignal);
      if (contract.verdict === "PASS") {
        if (this.strictReviewDiff && changeSnapshot.diff.status === "UNSUPPORTED") {
          return this.holdForDegradedReview({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            changes: changeSnapshot.diff,
            review: reviewResult,
          });
        }
        const transition = this.transitionProfessional({ type: "REVIEW_PASS" });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
            message: "검수는 통과했지만 실행 상태를 저장하지 못해 기록 단계로 진행하지 않았습니다. 변경은 그대로 남아 있습니다.",
          });
        }
        break;
      }
      if (contract.verdict === "UNKNOWN") {
        const transition = this.transitionProfessional({
          type: "REVIEW_UNKNOWN",
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
          result: reviewResult,
          message: contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "검수 응답의 최종 판정을 확정할 수 없어 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다."
            : "검수 근거가 부족해 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
        await restoreCheckpoint();
        this.appendSystem(
          contract.stopReason === "AMBIGUOUS_VERDICT"
            ? "검토 응답에서 서로 다른 VERDICT 표기가 여러 번 발견되어 어느 것이 최종 판정인지 판단할 수 없습니다. 아래에서 직접 확인해 주세요."
            : "검토에서 판단 근거가 부족해 자동 진행을 멈췄습니다. 아래에서 직접 확인해 주세요."
        );
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: contract.stopReason || "INSUFFICIENT_EVIDENCE",
          contract,
          review: reviewResult,
        };
      }

      // FIX_REQUIRED: 자동 보완 가능하면 보완, 아니면 STOP → 사용자.
      if (!contract.canAutoRevise) {
        const transition = this.transitionProfessional({
          type: "REVIEW_FIX",
          canAutoRevise: false,
          stopReason: contract.stopReason || "FIX_REQUIRED",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: contract.stopReason || "FIX_REQUIRED",
          result: reviewResult,
          message: "검수에서 수정이 필요하다고 판단해 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: contract.stopReason || "FIX_REQUIRED",
          contract,
          review: reviewResult,
        };
      }
      if (!canAutoRevise || autoRevisionCount >= maxAutoRevisions) {
        const transition = this.transitionProfessional({
          type: "REVIEW_FIX",
          canAutoRevise: false,
          stopReason: !canAutoRevise ? "FIX_REQUIRED" : "LIMIT_EXCEEDED",
        });
        if (!transition.ok) {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "review",
            round,
            stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
            result: transition,
          });
        }
        const held = holdProfessionalFailure({
          stage: "review",
          stopReason: !canAutoRevise ? "FIX_REQUIRED" : "LIMIT_EXCEEDED",
          result: reviewResult,
          message: "자동 보완 한도 또는 정책 때문에 자동 진행을 멈췄습니다. 현재 변경과 복구 정보는 그대로 유지합니다.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return {
          ok: false,
          stage: "review",
          completedIterations: round,
          needsUserDecision: true,
          stopReason: !canAutoRevise
            ? "FIX_REQUIRED"
            : "LIMIT_EXCEEDED",
          contract,
          review: reviewResult,
        };
      }

      // 자동 보완.
      const revisionTransition = this.transitionProfessional({
        type: "REVIEW_FIX",
        canAutoRevise: true,
      });
      if (!revisionTransition.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
          result: revisionTransition,
        });
      }
      autoRevisionCount += 1;
      round += 1;
      feedback = reviewResult.text || "검토자가 수정이 필요하다고 판단했습니다.";
      this.appendSystem(`검토 결과 수정 필요 · 자동 보완 ${autoRevisionCount}/${maxAutoRevisions}회`);
      const frozenBeforeRevision = validateForStage("implementation", round + 1);
      if (frozenBeforeRevision) return frozenBeforeRevision;
      builderResult = await this.scheduleResponse(implementation.agent, {
        specialist: {
          stage: "implementation",
          round,
          maxRounds,
          // TASK-007: 자동 보완도 같은 Run, 같은 Frozen Task를 사용합니다.
          // Frozen Task는 요구사항 기준이고, feedback은 이번에 고칠 Reviewer 지시입니다.
          feedback,
          frozenTask: frozenTaskMeta(),
        },
        agentConfig: implementation.agentConfig,
      });
      const frozenAfterRevision = this.validateFrozenTask(runInfo);
      if (!frozenAfterRevision.ok) {
        return this.holdForFrozenTaskCorruption({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          error: frozenAfterRevision.error,
        });
      }
      // 자동 보완 후에도 diff를 다시 수집해 최신 변경분을 검토에 반영합니다.
      changeSnapshot = await describeWorkspaceChanges(workspace, {
        checkpoint,
        excludePaths: runGeneratedPaths(workspace, runInfo),
      });
      builderChanges = changeSnapshot.text;
      if (changeSnapshot.diff.status === "FAILED") {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "DIFF_COLLECTION_FAILED",
          result: { changes: changeSnapshot.diff },
          message: "보완 후 변경(Diff)을 수집하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
      if (requestedGeneration !== this.generation) {
        if (!this.professionalRun) cleanupCheckpoint();
        return { ok: false, cancelled: true };
      }
      if (!builderResult?.ok) {
        if (builderResult.stopReason === "PROMPT_BUDGET_EXCEEDED") {
          return this.holdForRecovery({
            runInfo,
            taskInfo,
            checkpoint,
            stage: "implementation",
            round,
            stopReason: builderResult.stopReason,
            result: builderResult,
            message: "구현 프롬프트가 허용된 크기를 넘어 보완을 시작하지 못했습니다. 기존 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
          });
        }
        const held = holdProfessionalFailure({
          stage: "implementation",
          stopReason: builderResult.stopReason || "TRANSPORT_FAILED",
          result: builderResult,
          message: "자동 보완 중 구현 에이전트가 실패했습니다. 현재 변경과 복구 정보는 그대로 유지합니다. 아래에서 다음 처리를 선택해 주세요.",
        });
        if (held) return held;
        await restoreCheckpoint();
        return this.specialistFail(implementation, "implementation", round, builderResult);
      }
      if (builderResult.builderStatus !== "DONE") {
        return holdForBlocked(round, builderResult, builderResult.builderStatus);
      }
      const revisedBuilderTransition = this.transitionProfessional({ type: "BUILDER_DONE" });
      if (!revisedBuilderTransition.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "implementation",
          round,
          stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
          result: revisedBuilderTransition,
        });
      }
      reviewEvidence = this.prepareReviewEvidence({
        runInfo,
        builderResult,
        diff: changeSnapshot.diff,
        round,
        provider: implementation.agent.id,
      });
      if (!reviewEvidence.ok) {
        return this.holdForRecovery({
          runInfo,
          taskInfo,
          checkpoint,
          stage: "review",
          round,
          stopReason: "EVIDENCE_WRITE_FAILED",
          result: { evidence: reviewEvidence.payload },
          message: "보완 후 실행 근거를 저장하지 못해 검수를 시작할 수 없습니다. 변경은 그대로 남아 있습니다. 아래에서 다음 처리를 선택해 주세요.",
        });
      }
    }

    // PASS 후 기록관(선택) 실행 — 실행 블록의 마지막 단계로 블록을 마무리합니다.
    // checkpoint/복구 저널은 기록까지 성공한 뒤에만 정리한다. 기록이 실패하면
    // 저널을 남겨 두어 사용자가 기록을 재시도하거나 변경을 복원할 수 있게 한다.
    if (recordAfter && recorder?.agent) {
      const frozenBeforeRecorder = validateForStage("recorder", round);
      if (frozenBeforeRecorder) return frozenBeforeRecorder;
      recorderResult = await this.scheduleResponse(recorder.agent, {
        specialist: {
          stage: "recorder",
          professional: true,
          round,
          maxRounds: 1,
          frozenTask: frozenTaskMeta(),
          reviewDiff: builderChanges,
          finalVerdict: "PASS",
          evidence: reviewEvidence?.payload || null,
        },
        agentConfig: recorder.agentConfig,
      });
      if (requestedGeneration !== this.generation) return { ok: false, cancelled: true };
      if (!recorderResult?.ok) {
        const recordError = recorderResult?.error || "기록관 실행이 실패했습니다.";
        this.transitionProfessional({ type: "RECORDER_FAILED", stopReason: "RECORDER_FAILED" });
        if (runInfo?.runDir && this.taskManager?.writeRunResult) {
          this.taskManager.writeRunResult(runInfo, {
            status: "BLOCKED",
            stopReason: "RECORDER_FAILED",
            finalVerdict: "PASS",
            recorded: false,
            round,
          });
        }
        this.appendSystem(`전문 모드 구현·검토는 통과했지만 기록관이 결과를 정리하지 못했습니다. (${recordError})`);
        return { ok: true, completedIterations: round, recorded: false, recording: recorderResult?.text || "", recordError };
      }
    }

    if (runInfo?.runDir && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
      status: "COMMITTING",
      finalVerdict: "PASS",
      recorded: Boolean(recorderResult?.ok),
      round,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "RUN_STATE_WRITE_FAILED",
        changes: changeSnapshot,
        message: "완료 기록을 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }
    if (!this.updateProfessionalTaskState({
      taskPath: taskInfo?.relativePath || null,
      status: "done",
      activeRunId: null,
      lastRunId: runInfo?.runId || null,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "WORKFLOW_WRITE_FAILED",
        changes: changeSnapshot,
        message: "작업 완료 상태를 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }

    const completedTransition = this.transitionProfessional({ type: "RECORDER_DONE" });
    if (!completedTransition.ok) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "PROFESSIONAL_RUN_WRITE_FAILED",
        result: completedTransition,
        message: "작업은 끝났지만 완료 상태를 저장하지 못해 복구 정보를 유지합니다.",
      });
    }
    if (runInfo?.runDir && this.taskManager?.writeRunResult && !this.taskManager.writeRunResult(runInfo, {
      status: "COMPLETED",
      finalVerdict: "PASS",
      recorded: Boolean(recorderResult?.ok),
      round,
    })) {
      return this.holdForRecovery({
        runInfo,
        taskInfo,
        checkpoint,
        stage: "recorder",
        round,
        stopReason: "RUN_STATE_WRITE_FAILED",
        changes: changeSnapshot,
        message: "최종 완료 상태를 저장하지 못해 checkpoint를 유지합니다. 변경은 그대로 남아 있습니다.",
      });
    }

    // 성공(구현·검수 + 기록 완료) 후에만 checkpoint 리소스를 정리합니다.
    if (checkpointSupported && this.checkpointEngine) {
      const cleanup = this.checkpointEngine.cleanupCheckpoint(checkpoint);
      if (cleanup?.ok === false) {
        this.persistRecoveryState(this.recoveryFor(checkpoint, {
          status: "completed",
          runId: runInfo?.runId || null,
          taskPath: taskInfo?.relativePath || null,
          stage: "recorder",
          blockReason: "CHECKPOINT_CLEANUP_FAILED",
        }));
        this.appendSystem("실행은 완료됐지만 checkpoint 정리를 다음 시작 때 다시 시도합니다.");
        return {
          ok: true,
          completedIterations: round,
          recorded: Boolean(recorderResult?.ok),
          recording: recorderResult?.text || "",
          cleanupError: "CHECKPOINT_CLEANUP_FAILED",
        };
      }
    }
    this.clearRecoveryState();

    this.appendSystem("전문 모드 구현·검토가 통과했습니다.");
    return {
      ok: true,
      completedIterations: round,
      recorded: Boolean(recorderResult?.ok),
      recording: recorderResult?.text || "",
    };
  }

  // 검토자 출력 계약을 파싱합니다. 판정(verdict)은 다음 우선순위로 정합니다:
  //   1) 끝줄 단독 앵커 마커([[CODEPET_REVIEW:...]], respond()가 signal로 전달) —
  //      본문 어디에도 등장하지 않는 전용 표기라 위조·오인 가능성이 가장 낮습니다.
  //   2) 앵커가 없을 때만 본문 중 VERDICT: 마커를 보조로 씁니다. 단, 서로 다른 값의
  //      마커가 두 번 이상 나오면(인용·부정문·수정 흔적 등) 어느 것이 진짜 결론인지
  //      단정하지 않고 UNKNOWN + stopReason: AMBIGUOUS_VERDICT로 사용자에게 반환합니다.
  // 구조화 섹션(ISSUES)은 "있으면 사용, 없으면 SCOPE_UNSPECIFIED"로 처리합니다.
  parseReviewContract(text, signal) {
    const { value: bodyVerdict, ambiguous } = findControlMarker(
      text,
      /VERDICT:\s*(PASS|FIX_REQUIRED|REVISE|UNKNOWN)\b/i
    );
    const normalizedBodyVerdict = bodyVerdict === "REVISE" ? "FIX_REQUIRED" : bodyVerdict;
    let verdict;
    if (signal) {
      verdict = signal;
    } else if (ambiguous) {
      verdict = "UNKNOWN";
    } else {
      verdict = normalizedBodyVerdict || "UNKNOWN";
    }

    const issuesIndex = text.indexOf("ISSUES:");
    const issuesText = issuesIndex !== -1 ? text.slice(issuesIndex) : "";
    const issueBlocks = issuesText
      .split(/\n\d+\.\s*\n|\n\d+\.\s+/)
      .filter((block) => block.trim().length > 0);

    const blockingScopes = [];
    let scopeUnspecified = false;
    for (const block of issueBlocks) {
      const hasBlocking = /severity:\s*BLOCKING/i.test(block);
      const scopeMatch = block.match(/scope:\s*(IN|OUT)/i);
      if (hasBlocking) {
        if (!scopeMatch) scopeUnspecified = true;
        else blockingScopes.push(scopeMatch[1].toUpperCase());
      }
    }

    let stopReason = null;
    let canAutoRevise = false;
    if (verdict === "UNKNOWN" && !signal && ambiguous) {
      stopReason = "AMBIGUOUS_VERDICT";
    } else if (verdict === "UNKNOWN") {
      stopReason = "INSUFFICIENT_EVIDENCE";
    } else if (verdict === "FIX_REQUIRED") {
      if (scopeUnspecified || blockingScopes.length === 0) {
        stopReason = "SCOPE_UNSPECIFIED";
      } else if (blockingScopes.some((scope) => scope === "OUT")) {
        stopReason = "SCOPE_OUT";
      } else {
        canAutoRevise = true;
      }
    }
    return {
      verdict,
      stopReason,
      canAutoRevise,
      blockingScopes,
      hasBlocking: blockingScopes.length > 0,
    };
  }

  // 전문 모드 실패 시 어떤 역할/에이전트/모델에서 실패했는지 정보를 담아 반환합니다.
  specialistFail(stageAgent, stage, completedIterations, result = {}) {
    return {
      ok: false,
      stage,
      completedIterations,
      role: stage,
      agentId: stageAgent?.agent?.id || null,
      model: stageAgent?.agentConfig?.model || stageAgent?.agent?.modelId || "기본",
      error: result?.error || `${stage} 단계에서 에이전트 실행에 실패했습니다.`,
      ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
      ...(result?.evidence ? { evidence: result.evidence } : {}),
      ...(result?.transport ? { transport: result.transport } : {}),
    };
  }

  // BLOCKED 후속 처리 (A안).
  // BLOCKED 시점에는 되돌리지 않고 보류했으므로, 사용자가 고른 조치를 여기서 수행합니다.
  //   keep    — 현재 변경을 그대로 유지하고 보류 상태만 해제
  //   restore — checkpoint 시점(=Builder 실행 전)으로 되돌림. 사용자 사전 변경은 보존
  //   discard — 되돌린 뒤 Task까지 폐기 대상으로 표시

  specialistBlockDetails() {
    const pending = this.specialistBlocked;
    if (!pending) return null;
    const runInfo = pending.runId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
      : null;
    const block = runInfo && this.taskManager?.readRunBlock
      ? this.taskManager.readRunBlock(runInfo)
      : null;
    return {
      runId: pending.runId || null,
      taskPath: pending.taskPath || null,
      stage: pending.stage || "implementation",
      blockReason: pending.blockReason || "BLOCKED",
      canRestore: Boolean(pending.canRestore),
      block,
    };
  }

  async replanBlocked(workspaceAction = "keep") {
    return this.withProfessionalAuthorization("workspace-write", async () => {
      const pending = this.specialistBlocked;
      if (!pending) {
        return { ok: false, error: "처리할 막힘(BLOCKED) 상태가 없습니다." };
      }
      if (!["keep", "restore"].includes(workspaceAction)) {
        return { ok: false, error: "올바르지 않은 재기획 동작입니다. (keep 또는 restore 선택)" };
      }
      // 담당자 확인을 먼저 한다. 복원/정리/저널 해제 같은 되돌릴 수 없는 처리
      // 이전에 검증해야, 설정이 비어 있을 때 사용자가 checkpoint와 BLOCKED
      // 상태를 잃고 막다른 길에 놓이지 않는다.
      const stages = this.stagesForSpecialist();
      if (!stages || !stages.planner?.agent || !stages.review?.agent) {
        return { ok: false, error: "기획·검수 담당자를 프로젝트 설정에서 지정해 주세요." };
      }
      const runInfo = pending.runId && this.taskManager?.runInfoForId
        ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
        : null;
      const block = runInfo && this.taskManager?.readRunBlock
        ? this.taskManager.readRunBlock(runInfo)
        : null;

      if (workspaceAction === "restore") {
        if (this.checkpointEngine && pending.checkpoint) {
          const preservePaths = runInfo ? runGeneratedPaths(this.meta.workspace, runInfo) : [];
          const result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, pending.checkpoint, {
            preservePaths,
          });
          if (!result?.ok) {
            return { ok: false, error: "작업 전 상태로 되돌리지 못했습니다. 변경과 복구 상태를 그대로 유지합니다." };
          }
        }
      }

      if (runInfo && this.taskManager?.writeRunResult) {
        if (!this.taskManager.writeRunResult(runInfo, {
          status: "BLOCKED",
          stopReason: pending.blockReason || "BLOCKED",
        })) {
          return { ok: false, error: "막힌 Run 결과를 저장하지 못해 재기획을 시작하지 않았습니다." };
        }
      }
      if (!this.updateProfessionalTaskState({
        taskPath: pending.taskPath || null,
        status: "blocked",
        activeRunId: null,
        lastRunId: pending.runId || null,
      })) {
        return { ok: false, error: "막힌 작업의 Workflow 상태를 저장하지 못해 재기획을 시작하지 않았습니다." };
      }

      if (this.professionalRun) {
        const trans = this.transitionProfessional({
          type: "REPLAN_RESET",
          carriedFromRunId: pending.runId || null,
        });
        if (!trans.ok) return this.professionalTransitionFailure("planner", trans);
      }

      if (this.checkpointEngine && pending.checkpoint) {
        const cleanup = this.checkpointEngine.cleanupCheckpoint(pending.checkpoint);
        if (cleanup?.ok === false) {
          this.transitionProfessional({
            type: "HOLD_BLOCKED",
            stopReason: "CHECKPOINT_CLEANUP_FAILED",
            blockReason: "CHECKPOINT_CLEANUP_FAILED",
          });
          return { ok: false, error: "checkpoint 정리를 완료하지 못해 재기획을 시작하지 않았습니다. 복구 상태를 유지합니다." };
        }
      }

      this.specialistBlocked = null;
      this.clearRecoveryState();

      let feedback = `이전 구현(${pending.runId || "RUN"})이 막혔습니다.\n사유: ${pending.blockReason || "BLOCKED"}`;
      if (block?.changes?.text) {
        feedback += `\n\n=== 이전 작업 부분 변경 ===\n${block.changes.text}\n=== 이전 작업 부분 변경 끝 ===`;
      }

      const taskInfo = taskFileInfo(pending.taskPath);

      this.appendSystem(
        workspaceAction === "restore"
          ? "작업 전 상태로 복원한 뒤, 막힌 사유를 기획자에게 전달하고 재기획을 시작합니다."
          : "현재 변경을 유지한 채, 막힌 사유와 부분 변경을 기획자에게 전달하고 재기획을 시작합니다."
      );

      return this.runPlanBlock({
        stages,
        feedback,
        taskInfo,
        action: "plan",
        planAutoRevisions: this.professionalRun?.policy?.planAutoRevisions || 0,
        implementationAutoRevisions: this.professionalRun?.policy?.implementationAutoRevisions || 0,
      });
    });
  }

  async resolveBlocked(action) {
    const pending = this.specialistBlocked;
    if (!pending) {
      return { ok: false, error: "처리할 막힘(BLOCKED) 상태가 없습니다." };
    }
    if (!["keep", "restore", "discard"].includes(action)) {
      return { ok: false, error: "올바르지 않은 처리 동작입니다." };
    }
    if ((action === "restore" || action === "discard") && !pending.canRestore) {
      return { ok: false, error: "git workspace가 아니어서 자동 복원을 할 수 없습니다." };
    }

    const pendingRunInfo = pending.runId && this.taskManager?.runInfoForId
      ? this.taskManager.runInfoForId(pending.runId, this.meta.workspace)
      : null;
    const preservePaths = pendingRunInfo
      ? runGeneratedPaths(this.meta.workspace, pendingRunInfo)
      : [];
    let restored = false;
    if (action === "restore" || action === "discard") {
      if (this.checkpointEngine && pending.checkpoint) {
        const result = await this.checkpointEngine.restoreCheckpoint(this.meta.workspace, pending.checkpoint, {
          preservePaths,
        });
        restored = Boolean(result?.ok);
        if (!restored) {
          return { ok: false, error: "작업 전 상태로 되돌리지 못했습니다. 변경은 그대로 두었습니다." };
        }
      }
    }
    if (pending.blockReason === "FROZEN_TASK_CORRUPTED" && pendingRunInfo && this.taskManager?.markRunInvalid) {
      // restore가 checkpoint 이후의 invalid marker를 제거할 수 있으므로,
      // 저널을 해제하기 직전에 단조 invalid 상태를 다시 기록합니다.
      if (!this.taskManager.markRunInvalid(pendingRunInfo, pending.blockReason)) {
        return { ok: false, error: "손상된 Run의 무효 상태를 다시 기록하지 못했습니다. 복구 저널을 유지합니다." };
      }
    }
    if (!this.updateProfessionalTaskState({
      taskPath: pending.taskPath || null,
      status: "blocked",
      activeRunId: null,
      lastRunId: pending.runId || null,
    })) {
      return { ok: false, error: "막힌 작업의 Workflow 상태를 저장하지 못해 복구 상태를 해제하지 않았습니다." };
    }
    if (this.checkpointEngine && pending.checkpoint) {
      const cleanup = this.checkpointEngine.cleanupCheckpoint(pending.checkpoint);
      if (cleanup?.ok === false) {
        return { ok: false, error: "checkpoint 정리를 완료하지 못해 복구 상태를 유지합니다." };
      }
    }

    const resolvedTransition = this.transitionProfessional({
      type: "INTERRUPT",
      stopReason: "BLOCK_RESOLVED",
    });
    if (!resolvedTransition.ok) return this.professionalTransitionFailure("implementation", resolvedTransition);

    this.specialistBlocked = null;
    this.clearRecoveryState();
    this.emitSpecialistState();
    this.appendSystem(
      action === "keep"
        ? "막힘 처리: 지금까지의 변경을 그대로 유지합니다."
        : action === "restore"
          ? "막힘 처리: 작업 전 상태로 되돌렸습니다. (실행 전부터 있던 사용자 변경은 보존)"
          : "막힘 처리: 작업 전 상태로 되돌리고 이 작업을 폐기했습니다."
    );
    return { ok: true, action, restored, taskPath: pending.taskPath || null };
  }

  async runRecorder(options = {}) {
    if (!options.agent) return { ok: false, error: "기록관 담당자가 없습니다." };
    return this.scheduleResponse(options.agent, {
      specialist: {
        stage: "recorder",
        professional: Boolean(options.professional),
        round: options.round || 1,
        maxRounds: options.maxRounds || 1,
        frozenTask: options.frozenTask || null,
        reviewDiff: options.reviewDiff,
        finalVerdict: options.finalVerdict || null,
        evidence: options.evidence || null,
      },
      agentConfig: options.agentConfig,
    });
  }
}

function installSpecialistMethods(ChatRoom) {
  for (const name of Object.getOwnPropertyNames(SpecialistMixin.prototype)) {
    if (name !== 'constructor') {
      ChatRoom.prototype[name] = SpecialistMixin.prototype[name];
    }
  }
}

module.exports = {
  installSpecialistMethods,
  SAFE_BLOCK_REASONS,
  safeBlockReason,
  hasOpenQuestions,
  structuredIssuesFromReview,
  stripCodeFences,
  findControlMarker,
  runGeneratedPaths,
};
