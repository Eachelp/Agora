"use strict";

// F127 클라이언트가 끊기면 프록시가 upstream 응답 스트림도 끊는다.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { CodexProxy } = require("../src/codex-proxy");

test("F127: 스트리밍 중 클라이언트가 끊기면 upstream 연결도 닫힌다", async (t) => {
  let upstreamClosed = false;
  let chunksSent = 0;
  let timer = null;
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.on("close", () => { upstreamClosed = true; clearInterval(timer); });
    timer = setInterval(() => { chunksSent += 1; response.write("data: x\n\n"); }, 10);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    port: 0,
    resolveAccounts: async () => [{ key: "a", label: "A", authPath: "token" }],
    readAuth: () => ({ accessToken: "t", accountId: "id" }),
  });
  await proxy.start();
  const proxyPort = proxy.server.address().port;
  t.after(async () => {
    clearInterval(timer);
    proxy.stop();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  await new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "/v1/responses", method: "GET", headers: { host: `127.0.0.1:${proxyPort}` } },
      (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      }
    );
    request.on("error", () => {});
    request.end();
    setTimeout(() => reject(new Error("첫 청크를 받지 못했습니다.")), 3000).unref();
  });

  const deadline = Date.now() + 3000;
  while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstreamClosed, true, "클라이언트가 끊겼는데 upstream이 계속 열려 있다");
  const sentAtClose = chunksSent;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(chunksSent, sentAtClose, "끊긴 뒤에는 upstream이 더 보내지 않는다");
});
