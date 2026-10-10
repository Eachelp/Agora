"use strict";

// F127 클라이언트가 끊기면 프록시가 upstream 응답 스트림도 끊는다.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");

const { CodexProxy } = require("../src/codex-proxy");

// 기다리는 일이 끝나지 않을 때 테스트가 멈추지 않고 이유와 함께 실패하게 한다.
function within(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

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

// upstream이 응답 헤더를 끝내 보내지 않는 동안(Codex를 요청 직후 중지) 클라이언트가 끊기는 경우.
// 스트리밍이 시작되기 전이라 streamToClient의 close 리스너는 아직 없다.
const PRE_HEADER_SCENARIOS = [
  { name: "저장 계정 없음(요청을 그대로 통과)", accounts: [], method: "GET" },
  { name: "계정 1개(요청 스트림 중계)", accounts: ["a"], method: "GET" },
  { name: "계정 2개 POST(본문 버퍼링 중계)", accounts: ["a", "b"], method: "POST" },
];

for (const { name, accounts, method } of PRE_HEADER_SCENARIOS) {
  test(`F127: upstream 응답 헤더가 오기 전에 클라이언트가 끊겨도 upstream 요청이 닫힌다 (${name})`, async (t) => {
    let seen;
    const upstreamSawRequest = new Promise((resolve) => { seen = resolve; });
    let closed;
    const upstreamClosed = new Promise((resolve) => { closed = resolve; });
    const upstream = http.createServer((request, response) => {
      response.once("close", closed); // 응답 헤더는 끝내 보내지 않는다.
      seen();
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const proxy = new CodexProxy({
      upstreamBase: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
      port: 0,
      resolveAccounts: async () => accounts.map((key) => ({ key, label: key, authPath: key })),
      readAuth: () => ({ accessToken: "t", accountId: "id" }),
    });
    await proxy.start();
    const proxyPort = proxy.server.address().port;
    t.after(async () => {
      proxy.stop();
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
    });

    const request = http.request({
      host: "127.0.0.1", port: proxyPort, path: "/v1/responses", method, headers: { host: `127.0.0.1:${proxyPort}` },
    });
    request.on("error", () => {});
    request.end(method === "POST" ? "{}" : undefined);
    await within(upstreamSawRequest, 3000, "프록시가 upstream에 요청을 보내지 않았다");

    request.destroy(); // upstream 응답 헤더가 오기 전에 끊는다.
    await within(upstreamClosed, 3000, "클라이언트가 끊겼는데 upstream 요청이 계속 열려 있다");
  });
}

test("F127: close가 이미 지나간 클라이언트 응답이면 streamToClient는 upstream 응답을 바로 끊고 끝난다", async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const closedResponse = new Promise((resolve) => {
    server.once("request", (request, response) => {
      response.once("close", () => resolve(response));
      response.destroy();
    });
  });
  http.get({ host: "127.0.0.1", port: server.address().port }).on("error", () => {});
  const response = await within(closedResponse, 3000, "클라이언트 응답이 닫히지 않았다");

  const upstreamResponse = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
  await within(
    new CodexProxy().streamToClient(upstreamResponse, response),
    3000,
    "끊긴 클라이언트인데 streamToClient가 끝나지 않는다"
  );
  assert.equal(upstreamResponse.destroyed, true, "끊긴 클라이언트의 upstream 응답은 바로 끊는다");
});
