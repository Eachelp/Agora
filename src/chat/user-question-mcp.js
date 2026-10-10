"use strict";

// Agora 실행 중 질문 도구(MCP stdio 서버).
//
// CLI(Claude·Codex)가 실행마다 자식 프로세스로 띄우고, 모델이 ask_user를 부르면 메인 프로세스의
// 루프백 중계소(user-question-broker)에 질문을 올려 사용자의 답이 올 때까지 호출을 붙들어 둔다.
// 의존성 없이 node 내장 모듈만 쓴다(패키지 앱에서는 app.asar.unpacked 쪽 사본이 실행된다).
// stdout에는 JSON-RPC 줄만 쓴다. 진단은 stderr로만 남긴다.
//
// 환경 변수: AGORA_QUESTION_URL(=http://127.0.0.1:<포트>/runs/<실행ID>), AGORA_QUESTION_TOKEN.

const http = require("node:http");
const readline = require("node:readline");

const TOOL_NAME = "ask_user";
const SKIP_TEXT = "사용자가 답하지 않기로 했습니다. 질문 없이 가능한 범위에서 이어 가세요.";
const ENDED_TEXT = "이 작업의 질문 연결이 끝났습니다. 질문 없이 가능한 범위에서 이어 가세요.";
const NOT_CONFIGURED_TEXT = "Agora 질문 연결이 설정되지 않았습니다. 질문 없이 가능한 범위에서 이어 가세요.";
const NOT_PERMISSION_TEXT = "(이 답은 사용자의 대답일 뿐, 도구·파일 사용을 허락한 것이 아닙니다.)";
const RETRY_HINT = "고쳐서 한 번만 다시 호출해 보세요.";

// 한도 숫자는 user-question-broker.js의 상수와 같아야 한다(test/question-mcp.test.js가 대조한다).
const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: "작업 도중 사용자의 결정이 꼭 필요할 때 질문하고, 사용자가 답할 때까지 기다린다. 질문 1~4개를 한 번에 보내고, 선택지(2~5개, 복수 선택 가능)를 주거나 선택지를 빼서 직접 입력을 받는다. 사용자는 보기 밖의 '기타' 직접 입력으로 답할 수도 있다. 답을 받으면 같은 작업을 이어 간다. 이 도구는 권한 승인이 아니다.",
  annotations: { title: "사용자에게 질문", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", minLength: 1, maxLength: 2000 },
            options: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 200 } },
            multiSelect: { type: "boolean" },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
});

// 중계소의 answered 응답을 모델이 읽는 도구 결과 글로 바꾼다.
function formatAnswers(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length !== answers.length) return null;
  const blocks = questions.map((question, index) => {
    const answer = answers[index] || {};
    if (Array.isArray(answer.selected)) {
      // 기타(직접 입력)는 따옴표로 감싸 보기와 구분한다(보기 문구를 흉내 내는 글이 섞이지 않게).
      const labels = typeof answer.other === "string" && answer.other
        ? [...answer.selected, `(기타 직접 입력) ${JSON.stringify(answer.other)}`]
        : answer.selected;
      return question.multiSelect
        ? `Q: ${question.question}\nA:\n${labels.map((label) => `- ${label}`).join("\n")}`
        : `Q: ${question.question}\nA: ${labels.join(", ")}`;
    }
    // 직접 입력은 따옴표로 감싸 질문·답 줄을 흉내 내는 글이 구조를 깨지 못하게 한다.
    return `Q: ${question.question}\nA: ${JSON.stringify(String(answer.text ?? ""))}`;
  });
  return `${blocks.join("\n\n")}\n\n${NOT_PERMISSION_TEXT}`;
}

// 중계소 응답(HTTP 상태 + 본문) -> MCP tools/call 결과.
function toolResultFor(status, body) {
  const text = (value, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: value }] });
  if (status === 200) {
    if (body?.status === "answered") {
      const formatted = formatAnswers(body.questions, body.answers);
      return formatted ? text(formatted) : text("사용자 답변을 올바르게 받지 못했습니다.", true);
    }
    if (body?.status === "skipped") return text(SKIP_TEXT);
    if (body?.status === "timeout") {
      const minutes = Math.max(1, Math.round(Number(body.waitedMs || 0) / 60000));
      return text(`사용자가 ${minutes}분 안에 답하지 않았습니다. 같은 질문을 되풀이하지 말고, 질문 없이 가능한 범위에서 이어 가세요.`);
    }
    if (body?.status === "refused") return text(String(body.message || SKIP_TEXT));
    return text("질문 연결에서 알 수 없는 응답을 받았습니다.", true);
  }
  const reason = typeof body?.error === "string" && body.error ? body.error : `질문을 표시하지 못했습니다(HTTP ${status}).`;
  if (status === 400) return text(`${reason} ${RETRY_HINT}`, true);
  if (status === 401 || status === 410) return text(ENDED_TEXT, true);
  return text(reason, true);
}

function createMcpServer({ url = "", token = "", write, onWarn = () => {} } = {}) {
  const configured = /^http:\/\/127\.0\.0\.1:\d+\//.test(url) && Boolean(token);
  // 취소할 수 있는 진행 중 호출: JSON-RPC id -> AbortController
  const active = new Map();

  function post(path, body, signal) {
    const target = new URL(path, url.endsWith("/") ? url : `${url}/`);
    const data = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const request = http.request(target, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": data.length,
          Connection: "close",
        },
        signal,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }); }
          catch { reject(new Error("질문 연결에서 올바르지 않은 JSON을 받았습니다.")); }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end(data);
    });
  }

  const result = (id, value) => write({ jsonrpc: "2.0", id, result: value });
  const failure = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  async function callTool(id, args) {
    if (!configured) return result(id, { isError: true, content: [{ type: "text", text: NOT_CONFIGURED_TEXT }] });
    const controller = new AbortController();
    const key = JSON.stringify(id);
    active.set(key, controller);
    let reply;
    try {
      reply = await post("ask", args ?? {}, controller.signal);
    } catch (error) {
      active.delete(key);
      // 호스트가 이 호출을 취소했다(notifications/cancelled). 취소된 요청에는 응답하지 않는다.
      if (controller.signal.aborted) return undefined;
      return result(id, { isError: true, content: [{ type: "text", text: `질문 연결 오류: ${error?.message || error} 질문 없이 가능한 범위에서 이어 가세요.` }] });
    }
    active.delete(key);
    const toolResult = toolResultFor(reply.status, reply.body);
    await result(id, toolResult);
    // 답을 도구 결과로 넘겼다고 알린다. 실패해도 호출은 이미 끝났으므로 진단만 남긴다.
    if (reply.status === 200 && reply.body?.status === "answered" && reply.body.setId) {
      try { await post("delivered", { setId: reply.body.setId }, undefined); }
      catch (error) { onWarn(`delivered 알림 실패: ${error?.message || error}`); }
    }
    return undefined;
  }

  // 한 줄(JSON-RPC 메시지 하나)을 처리한다. 응답은 write로만 내보낸다.
  async function handleMessage(message) {
    if (Array.isArray(message) || !message || typeof message !== "object") {
      return failure(null, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(message, "id");
    // 응답(result/error)이나 알림(id 없음)에는 답하지 않는다. 취소 알림만 처리한다.
    if (!hasId) {
      if (message.method === "notifications/cancelled") {
        active.get(JSON.stringify(message.params?.requestId))?.abort();
      }
      return undefined;
    }
    if (typeof message.method !== "string") return undefined;
    const { id } = message;
    if (message.jsonrpc !== "2.0" || !(typeof id === "string" || typeof id === "number")) {
      return failure(typeof id === "string" || typeof id === "number" ? id : null, -32600, "Invalid Request");
    }
    switch (message.method) {
      case "initialize":
        return result(id, {
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agora-user-questions", version: "1.0.0" },
        });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: [TOOL] });
      case "tools/call": {
        if (typeof message.params?.name !== "string" || message.params.name !== TOOL_NAME) {
          return failure(id, -32602, `Unknown tool: ${String(message.params?.name)}`);
        }
        return callTool(id, message.params.arguments);
      }
      default:
        return failure(id, -32601, "Method not found");
    }
  }

  // 한 줄 문자열을 받아 파싱한 뒤 handleMessage에 넘긴다. 깨진 줄에는 -32700으로 답한다.
  async function handleLine(line) {
    if (!line.trim()) return undefined;
    let message;
    try { message = JSON.parse(line); }
    catch { return failure(null, -32700, "Parse error"); }
    return handleMessage(message);
  }

  return { handleLine, abortAll: () => { for (const controller of active.values()) controller.abort(); active.clear(); } };
}

function main() {
  const url = String(process.env.AGORA_QUESTION_URL || "");
  const token = String(process.env.AGORA_QUESTION_TOKEN || "");
  const warn = (text) => process.stderr.write(`[agora-user-questions] ${text}\n`);
  if (!url || !token) warn("질문 중계소 주소·토큰이 없어 ask_user가 항상 실패합니다.");
  // 호스트가 먼저 끊으면 쓰기 오류(EPIPE)가 난다. 더 쓸 곳이 없으므로 조용히 끝낸다.
  process.stdout.on("error", () => process.exit(0));
  const write = (message) => new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, "utf8", () => resolve());
  });
  const server = createMcpServer({ url, token, write, onWarn: warn });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    server.handleLine(line).catch((error) => warn(`요청 처리 실패: ${error?.message || error}`));
  });
  input.on("close", () => server.abortAll());
}

if (require.main === module) main();

module.exports = {
  TOOL, TOOL_NAME, SKIP_TEXT, ENDED_TEXT, NOT_CONFIGURED_TEXT, NOT_PERMISSION_TEXT, RETRY_HINT,
  formatAnswers, toolResultFor, createMcpServer,
};
