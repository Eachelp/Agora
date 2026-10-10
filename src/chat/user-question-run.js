"use strict";

// 실행 하나에 질문 도구(MCP ask_user)를 붙이는 도우미.
// 방(chat-room/chat-ipc)은 실행 직전에 attachUserQuestionTool을 부르고, 붙었으면 결과의
// { server, serverKey, toolName }을 buildAgentInvocation({ userQuestion })에 넘긴 뒤
// 실행이 끝나면(성공·중지·삭제·종료 모두) cleanup()을 부른다.

const path = require("node:path");

const SERVER_KEY = "agora_user_question";
const TOOL_BASE_NAME = "ask_user";
// Claude는 MCP 도구를 mcp__<서버키>__<도구> 이름으로 허용 목록에 넣어야 -p에서 거부되지 않는다.
const TOOL_NAME = `mcp__${SERVER_KEY}__${TOOL_BASE_NAME}`;
const ENV_URL = "AGORA_QUESTION_URL";
const ENV_TOKEN = "AGORA_QUESTION_TOKEN";
// 질문 도구를 붙일 수 있는 실행 종류. 방이 일반 대화·작업 턴에만 이 값을 넘긴다.
// 토론 턴, 상담·요약·쉽게 설명·기록 같은 도우미 턴, 알 수 없는 종류에는 붙이지 않는다.
const ATTACHABLE_PURPOSES = Object.freeze(["chat"]);

// 프롬프트에 덧붙일 안내. Codex는 서버·도구 이름을 짚어 주지 않으면 도구를 쓰지 않고 자체 질문 도구를
// 찾거나 "사용할 수 없다"고 답하는 일이 잦다(실제 CLI 시험). 그래서 이름을 그대로 적는다.
const USER_QUESTION_INSTRUCTION = [
  `작업 중에 사용자의 결정이 꼭 필요하면 ${SERVER_KEY} 서버의 ${TOOL_BASE_NAME} 도구로 물어보세요.`,
  "질문 1~4개를 한 번에 보내고, 선택지(2~5개, 여러 개를 고르게 하려면 multiSelect)를 주거나 선택지를 빼서 직접 입력을 받으세요. 답을 받으면 같은 작업을 이어 가세요.",
  "이 도구는 파일·명령 사용 승인이 아닙니다. 사용자가 답하지 않기로 하면 다시 묻지 말고 가능한 범위에서 이어 가세요. 답을 추측해서 대신하지 마세요.",
].join("\n");

// 패키지 앱의 자식 프로세스는 asar 안의 파일을 읽지 못하므로 풀어 둔 사본을 쓴다(package.json asarUnpack).
function resolveMcpScript(dir = __dirname) {
  const script = path.join(dir, "user-question-mcp.js");
  return script.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

// 붙일 수 있는 실행인지 판단한다(붙이지 못하는 이유도 함께). 가장 안전한 부분집합만 허용한다.
function questionToolSupport({ providerId, needsShell = false, purpose, hasBroker = true } = {}) {
  if (providerId !== "claude" && providerId !== "codex") return { ok: false, reason: "이 통로는 실행 중 질문 연결을 지원하지 않습니다." };
  if (!ATTACHABLE_PURPOSES.includes(purpose)) return { ok: false, reason: "이 종류의 실행에는 질문 도구를 붙이지 않습니다." };
  if (needsShell) return { ok: false, code: "shell", reason: "셸 래퍼(.cmd)로 설치된 CLI에는 질문 설정을 안전하게 전달할 수 없습니다." };
  if (!hasBroker) return { ok: false, reason: "질문 중계소를 사용할 수 없습니다." };
  return { ok: true, reason: "" };
}

// 성공: { attached:true, server:{command,args,env}, serverKey, toolName, cleanup(reason?) }
// 실패·미지원: { attached:false, reason } — 어떤 경우에도 던지지 않는다(실행은 질문 도구 없이 계속된다).
async function attachUserQuestionTool({
  broker, runId, providerId, needsShell = false, purpose, meta = {}, scriptPath = resolveMcpScript(),
} = {}) {
  const support = questionToolSupport({ providerId, needsShell, purpose, hasBroker: Boolean(broker) });
  if (!support.ok) return { attached: false, reason: support.reason };
  try {
    const registered = await broker.registerRun({ ...meta, runId });
    return {
      attached: true,
      server: {
        command: process.execPath,
        args: [scriptPath],
        env: {
          // Electron 실행 파일로 이 스크립트를 일반 node처럼 돌린다. 일반 node에서는 필요 없다.
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          [ENV_URL]: registered.url,
          [ENV_TOKEN]: registered.token,
        },
      },
      serverKey: SERVER_KEY,
      toolName: TOOL_NAME,
      cleanup: (reason = "run-ended") => broker.finishRun(runId, reason),
    };
  } catch (error) {
    return { attached: false, reason: `질문 중계소를 준비하지 못했습니다: ${error?.message || error}` };
  }
}

// 방(ChatRoom)에 꽂는 질문 도구 묶음. 중계소는 앱 전체에서 하나이고 방마다 sessionId만 다르다.
// needsShellOf(agent)는 그 에이전트 CLI가 셸 래퍼(.cmd)로 설치됐는지 알려 준다(방은 실행 정보를 모른다).
function createRoomQuestionTool({ broker, sessionId, needsShellOf = () => false } = {}) {
  const target = (agent, purpose) => ({ providerId: agent?.id, needsShell: Boolean(needsShellOf(agent)), purpose });
  const support = (agent, purpose) => questionToolSupport({ ...target(agent, purpose), hasBroker: Boolean(broker) });
  return {
    broker,
    support,
    canAttach: (agent, purpose) => support(agent, purpose).ok,
    attach: ({ agent, runId, turnId = null, purpose }) => attachUserQuestionTool({
      broker, runId, ...target(agent, purpose), meta: { sessionId, agentId: agent.id, turnId },
    }),
  };
}

// 중계소 콜백 → 방. 질문이 속한 방(sessionId)을 getRoom으로 찾아 넘긴다. 방이 없으면(삭제) 버린다.
function questionBrokerHooks(getRoom) {
  const toRoom = (method) => (payload) => getRoom(payload?.sessionId)?.[method]?.(payload);
  return {
    onRequested: toRoom("noteQuestionSet"),
    onSubmitted: toRoom("noteQuestionSet"),
    onDelivered: toRoom("noteQuestionSet"),
    onCancelled: toRoom("noteQuestionSet"),
    onExpired: toRoom("noteQuestionSet"),
    onRepeatLimit: toRoom("noteQuestionRepeatLimit"),
  };
}

module.exports = {
  SERVER_KEY, TOOL_BASE_NAME, TOOL_NAME, ENV_URL, ENV_TOKEN, ATTACHABLE_PURPOSES, USER_QUESTION_INSTRUCTION,
  resolveMcpScript, questionToolSupport, attachUserQuestionTool, createRoomQuestionTool, questionBrokerHooks,
};
