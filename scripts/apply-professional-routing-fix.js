"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function write(rel, text) {
  fs.writeFileSync(path.join(root, rel), text, "utf8");
}

function replaceOnce(rel, from, to) {
  const text = read(rel);
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`${rel}: expected source text not found`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`${rel}: expected source text is not unique`);
  }
  write(rel, `${text.slice(0, first)}${to}${text.slice(first + from.length)}`);
}

replaceOnce(
  "src/chat/chat-room.js",
  "    const independent = Boolean(payload.independent);\n    if (!trimmed && attachments.length === 0) return null;",
  "    const independent = Boolean(payload.independent);\n    const recordOnly = Boolean(payload.recordOnly);\n    if (!trimmed && attachments.length === 0) return null;"
);

replaceOnce(
  "src/chat/chat-room.js",
  "    this.mentionsMuted = false;\n    const mentionedIds = parseMentions(trimmed, this.agents, GROUP_ALIASES);",
  "    this.mentionsMuted = false;\n    // 전문 모드의 작업 요청은 실행 지시 원문으로만 기록한다. 여기서 일반\n    // 응답을 예약하면 Planner/Plan Reviewer와 일반 채팅 턴이 섞인다.\n    if (recordOnly) return entry;\n    const mentionedIds = parseMentions(trimmed, this.agents, GROUP_ALIASES);"
);

replaceOnce(
  "src/chat/chat-ipc.js",
  "      wrap(async ({ sessionId, text, attachmentIds, independent }) => {",
  "      wrap(async ({ sessionId, text, attachmentIds, independent, professionalDraft }) => {"
);

replaceOnce(
  "src/chat/chat-ipc.js",
  "        const entry = room.sendUserMessage({ text, attachments, independent });",
  "        const entry = room.sendUserMessage({\n          text,\n          attachments,\n          independent,\n          recordOnly: Boolean(professionalDraft),\n        });"
);

replaceOnce(
  "src/chat-preload.js",
  "  send: (sessionId, text, attachmentIds, independent = false) =>\n    ipcRenderer.invoke(INVOKE.SEND, { sessionId, text, attachmentIds, independent }),",
  "  send: (sessionId, text, attachmentIds, independent = false, professionalDraft = false) =>\n    ipcRenderer.invoke(INVOKE.SEND, {\n      sessionId,\n      text,\n      attachmentIds,\n      independent,\n      professionalDraft,\n    }),"
);

replaceOnce(
  "src/chat.js",
  "const typingAgents = new Set();\nconst liveRuns = new Map();",
  "const typingAgents = new Set();\nlet roomTurnState = { current: null, queue: [], deferred: [] };\nconst liveRuns = new Map();"
);

replaceOnce(
  "src/chat.js",
  "  const planner = roleConfigFromProject(project, \"planning\");\n  const implementation = roleConfigFromProject(project, \"implementation\");\n  const review = roleConfigFromProject(project, \"review\");\n  // 단계별 IPC 요구 조건과 버튼 활성 조건을 맞춥니다.\n  // PLAN은 기획자와 기획 검수(비어 있으면 검토 담당자 재사용)만 필요하고,\n  // 구현은 구현자·검토자, 전체 실행만 세 역할을 모두 필요로 합니다.\n  const planConfigured = Boolean(planner.agentId && review.agentId);\n  const implementationConfigured = Boolean(implementation.agentId && review.agentId);\n  const fullConfigured = Boolean(planner.agentId && implementation.agentId && review.agentId);",
  "  const planner = roleConfigFromProject(project, \"planning\");\n  const planReview = roleConfigFromProject(project, \"plan_review\");\n  const implementation = roleConfigFromProject(project, \"implementation\");\n  const review = roleConfigFromProject(project, \"review\");\n  const effectivePlanReview = planReview.agentId ? planReview : review;\n  // 단계별 IPC 요구 조건과 버튼 활성 조건을 맞춥니다.\n  // PLAN은 기획자와 기획 검수(비어 있으면 검토 담당자 재사용)만 필요하고,\n  // 구현은 구현자·검토자, 전체 실행만 세 역할을 모두 필요로 합니다.\n  const planConfigured = Boolean(planner.agentId && effectivePlanReview.agentId);\n  const implementationConfigured = Boolean(implementation.agentId && review.agentId);\n  const fullConfigured = Boolean(\n    planner.agentId && effectivePlanReview.agentId && implementation.agentId && review.agentId\n  );"
);

replaceOnce(
  "src/chat.js",
  "  const blockedOrBusy = specialistRunning || specialistActive || specialistBlockedAvailable || specialistResumeAvailable;",
  "  const ordinaryTurnBusy = Boolean(\n    roomTurnState.current ||\n      (roomTurnState.queue || []).length > 0 ||\n      (roomTurnState.deferred || []).length > 0\n  );\n  const blockedOrBusy = Boolean(\n    specialistRunning ||\n      specialistActive ||\n      specialistBlockedAvailable ||\n      specialistResumeAvailable ||\n      ordinaryTurnBusy\n  );"
);

replaceOnce(
  "src/chat.js",
  "  professionalPlanButton.title = planConfigured\n    ? \"기획을 만들고 다른 담당자가 기획을 검수합니다\"\n    : `기획·검토 담당자가 필요합니다. ${roleSetupHint}`;\n  professionalFullButton.title = fullConfigured\n    ? \"기획 검수 PASS 후 별도 승인 없이 구현·검수·기록까지 이어서 실행합니다\"\n    : `기획·구현·검토 담당자가 모두 필요합니다. ${roleSetupHint}`;",
  "  professionalPlanButton.title = ordinaryTurnBusy\n    ? \"일반 응답이 끝난 뒤 전문 기획을 시작할 수 있습니다\"\n    : planConfigured\n      ? \"기획을 만들고 다른 담당자가 기획을 검수합니다\"\n      : `기획·검토 담당자가 필요합니다. ${roleSetupHint}`;\n  professionalFullButton.title = ordinaryTurnBusy\n    ? \"일반 응답이 끝난 뒤 전체 전문 실행을 시작할 수 있습니다\"\n    : fullConfigured\n      ? \"기획 검수 PASS 후 별도 승인 없이 구현·검수·기록까지 이어서 실행합니다\"\n      : `기획·구현·검토 담당자가 모두 필요합니다. ${roleSetupHint}`;"
);

replaceOnce(
  "src/chat.js",
  "  professionalImplementationButton.title = specialistPlanReady\n    ? \"기획 검수를 통과한 작업을 구현·검수·기록까지 실행합니다\"",
  "  professionalImplementationButton.title = ordinaryTurnBusy\n    ? \"일반 응답이 끝난 뒤 구현·검수를 시작할 수 있습니다\"\n    : specialistPlanReady\n      ? \"기획 검수를 통과한 작업을 구현·검수·기록까지 실행합니다\""
);

replaceOnce(
  "src/chat.js",
  "  const result = await call(window.chatApi.send(activeSessionId, text, attachmentIds, independent));\n  if (result) {\n    pendingAttachments = [];\n    renderPendingAttachments();",
  "  const result = await call(\n    window.chatApi.send(\n      activeSessionId,\n      text,\n      attachmentIds,\n      independent,\n      professionalModeEnabled\n    )\n  );\n  if (result) {\n    pendingAttachments = [];\n    renderPendingAttachments();\n    if (professionalModeEnabled) {\n      flashNotice(\"작업 요청을 기록했습니다. PLAN 또는 전체 실행을 선택하세요.\", false);\n    }"
);

replaceOnce(
  "src/chat.js",
  "    typingAgents.clear();\n    for (const agentId of full.session.typing || []) typingAgents.add(agentId);\n    pendingAttachments = full.session.pendingAttachments || [];",
  "    typingAgents.clear();\n    for (const agentId of full.session.typing || []) typingAgents.add(agentId);\n    roomTurnState = full.session.turnState || { current: null, queue: [], deferred: [] };\n    pendingAttachments = full.session.pendingAttachments || [];"
);

replaceOnce(
  "src/chat.js",
  "window.chatApi.onTyping(({ sessionId, agentId, busy }) => {\n  if (sessionId !== activeSessionId) return;\n  if (busy) typingAgents.add(agentId);\n  else typingAgents.delete(agentId);\n  renderTyping();\n});\nwindow.chatApi.onReset",
  "window.chatApi.onTyping(({ sessionId, agentId, busy }) => {\n  if (sessionId !== activeSessionId) return;\n  if (busy) typingAgents.add(agentId);\n  else typingAgents.delete(agentId);\n  renderTyping();\n});\nwindow.chatApi.onTurnState(({ sessionId, ...state }) => {\n  if (sessionId !== activeSessionId) return;\n  roomTurnState = {\n    current: state.current || null,\n    queue: Array.isArray(state.queue) ? state.queue : [],\n    deferred: Array.isArray(state.deferred) ? state.deferred : [],\n  };\n  renderHeader();\n});\nwindow.chatApi.onReset"
);

replaceOnce(
  "src/chat.js",
  "  chatMessages = [];\n  typingAgents.clear();\n  renderTyping();",
  "  chatMessages = [];\n  typingAgents.clear();\n  roomTurnState = { current: null, queue: [], deferred: [] };\n  renderTyping();"
);

const testPath = "test/chat-professional-role-routing.test.js";
if (fs.existsSync(path.join(root, testPath))) {
  throw new Error(`${testPath}: already exists`);
}
write(testPath, `"use strict";\n\nconst test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst { ChatRoom } = require("../src/chat/chat-room");\n\nfunction agyAgent() {\n  return {\n    id: "agy",\n    name: "Antigravity",\n    aliases: ["agy"],\n    available: true,\n    enabled: true,\n    model: "gemini-default",\n    effort: "default",\n  };\n}\n\ntest("professional draft는 사용자 작업 요청만 기록하고 일반 응답을 예약하지 않는다", async () => {\n  let providerCalls = 0;\n  const agent = agyAgent();\n  const room = new ChatRoom({\n    sessionId: "s-professional-draft",\n    agents: [agent],\n    runAgent() {\n      providerCalls += 1;\n      return { promise: Promise.resolve({ ok: true, text: "should not run" }), cancel() {} };\n    },\n  });\n\n  const entry = room.sendUserMessage({ text: "이 작업을 전문 모드로 진행해줘", recordOnly: true });\n  await room.waitForIdle();\n\n  assert.equal(entry.authorType, "user");\n  assert.equal(providerCalls, 0);\n  assert.equal(room.turnQueue.length, 0);\n  assert.equal(room.deferredTurnQueue.length, 0);\n  assert.equal(room.messages.filter((message) => message.authorType === "agent").length, 0);\n});\n\ntest("같은 AGY 담당자라도 Planner와 Plan Reviewer의 역할별 모델을 그대로 유지한다", async () => {\n  const calls = [];\n  const agent = agyAgent();\n  const room = new ChatRoom({\n    sessionId: "s-role-routing",\n    agents: [agent],\n    runAgent({ agent: invoked, specialistStage }) {\n      calls.push({\n        stage: specialistStage,\n        agentId: invoked.id,\n        model: invoked.model,\n        effort: invoked.effort,\n      });\n      const text = specialistStage === "planner"\n        ? "작업 계획을 확정합니다.\\nSTATUS: PLAN_READY"\n        : "계획이 구현 가능하고 요구사항을 충족합니다.\\nVERDICT: PASS\\n[[CODEPET_REVIEW:PASS]]";\n      return { promise: Promise.resolve({ ok: true, text }), cancel() {} };\n    },\n  });\n\n  room.sendUserMessage({ text: "전문 작업 요청", recordOnly: true });\n  const result = await room.startSpecialist({\n    action: "plan",\n    stages: {\n      planner: {\n        agent,\n        agentConfig: { model: "gemini-3.1-pro", effort: "high" },\n      },\n      planReview: {\n        agent,\n        agentConfig: { model: "gemini-3.7-flash", effort: "medium" },\n      },\n    },\n  });\n\n  assert.equal(result.ok, true);\n  assert.deepEqual(calls, [\n    { stage: "planner", agentId: "agy", model: "gemini-3.1-pro", effort: "high" },\n    { stage: "plan_review", agentId: "agy", model: "gemini-3.7-flash", effort: "medium" },\n  ]);\n  const responses = room.messages.filter((message) => message.authorType === "agent");\n  assert.deepEqual(responses.map((message) => ({\n    stage: message.agentMeta?.specialistStage,\n    model: message.agentMeta?.model,\n    effort: message.agentMeta?.effort,\n  })), [\n    { stage: "planner", model: "gemini-3.1-pro", effort: "high" },\n    { stage: "plan_review", model: "gemini-3.7-flash", effort: "medium" },\n  ]);\n});\n\ntest("renderer와 IPC는 professional draft와 turn-state 경계를 연결한다", () => {\n  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "chat.js"), "utf8");\n  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "chat-preload.js"), "utf8");\n  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "chat", "chat-ipc.js"), "utf8");\n\n  assert.match(renderer, /professionalModeEnabled\\s*\\n\\s*\\)\\s*\\n\\s*\\)/);\n  assert.match(renderer, /window\\.chatApi\\.onTurnState/);\n  assert.match(renderer, /effectivePlanReview = planReview\\.agentId \\? planReview : review/);\n  assert.match(preload, /professionalDraft = false/);\n  assert.match(ipc, /recordOnly: Boolean\\(professionalDraft\\)/);\n});\n`);

console.log("Applied professional mode routing fix.");
