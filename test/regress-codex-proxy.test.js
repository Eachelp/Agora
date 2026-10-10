const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const { CodexProxy } = require("../src/codex-proxy");

// F146: 루프백 프록시가 호출자(Origin/Host)와 경로 이탈(..)을 확인하지 않고
// 저장된 OAuth 토큰을 붙여 아무 요청이나 chatgpt.com으로 중계하던 문제.
// 실제 프록시 서버를 임시 포트에 띄우고 원시 요청으로 검증한다. (fetch는 Host/경로를 고쳐 보내 부적합)

async function startFixture() {
  const hits = [];
  const upstream = http.createServer((request, response) => {
    hits.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  // 업스트림 WebSocket 연결 시도도 "도달"로 센다.
  upstream.on("upgrade", (request, socket) => {
    hits.push({ url: request.url, upgrade: true });
    socket.on("error", () => {});
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = new CodexProxy({
    upstreamBase: `http://127.0.0.1:${upstream.address().port}/backend-api/codex`,
    port: 0,
    resolveAccounts: async () => [{ key: "a", label: "A", authPath: "victim-token" }],
    readAuth: (authPath) => ({ accessToken: authPath, accountId: "id-a" }),
  });
  await proxy.start();
  const proxyPort = proxy.server.address().port;
  return {
    hits,
    proxyPort,
    async close() {
      proxy.stop();
      upstream.closeAllConnections?.();
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

function rawGet(proxyPort, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: proxyPort, path: requestPath, method: "GET", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function rawUpgrade(proxyPort, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const client = net.connect(proxyPort, "127.0.0.1", () => {
      const lines = [`GET ${requestPath} HTTP/1.1`, "Connection: Upgrade", "Upgrade: websocket"];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    client.on("data", (chunk) => (data += chunk));
    client.on("error", reject);
    client.on("close", () => resolve(data.split("\r\n")[0]));
  });
}

test("F146: Origin 헤더가 있는 요청(브라우저)은 토큰을 붙이지 않고 403으로 거절한다", async () => {
  const fx = await startFixture();
  try {
    const hostHeader = `127.0.0.1:${fx.proxyPort}`;
    const result = await rawGet(fx.proxyPort, "/v1/responses", { host: hostHeader, origin: "https://evil.example" });
    assert.equal(result.status, 403);
    assert.deepEqual(fx.hits, []);
    const ws = await rawUpgrade(fx.proxyPort, "/v1/responses", { Host: hostHeader, Origin: "https://evil.example" });
    assert.match(ws, /403/);
    assert.deepEqual(fx.hits, []);
  } finally {
    await fx.close();
  }
});

test("F146: Host가 바인딩한 127.0.0.1:포트가 아니면(DNS rebinding) 거절한다", async () => {
  const fx = await startFixture();
  try {
    for (const host of ["attacker.example", `attacker.example:${fx.proxyPort}`, "127.0.0.1"]) {
      const result = await rawGet(fx.proxyPort, "/v1/responses", { host });
      assert.equal(result.status, 403, host);
    }
    const ws = await rawUpgrade(fx.proxyPort, "/v1/responses", { Host: "attacker.example" });
    assert.match(ws, /403/);
    assert.deepEqual(fx.hits, []);
  } finally {
    await fx.close();
  }
});

test("F146: ..(인코딩된 점 포함)로 /backend-api/codex 밖에 닿는 경로는 거절한다", async () => {
  const fx = await startFixture();
  try {
    const host = `127.0.0.1:${fx.proxyPort}`;
    const escapes = [
      "/v1/../../backend-api/conversations",
      "/v1/%2e%2e/%2e%2e/backend-api/conversations",
      "/v1/%2E%2e/../backend-api/conversations",
      "/v1/..\\..\\backend-api/conversations",
      "/../../backend-api/conversations",
    ];
    for (const escapePath of escapes) {
      const result = await rawGet(fx.proxyPort, escapePath, { host });
      assert.equal(result.status, 403, escapePath);
      const ws = await rawUpgrade(fx.proxyPort, escapePath, { Host: host });
      assert.match(ws, /403/, escapePath);
    }
    assert.deepEqual(fx.hits, []);
  } finally {
    await fx.close();
  }
});

test("F146: 정상 Codex 요청(Origin 없음, 올바른 Host, /v1/responses)은 그대로 중계되어 토큰이 붙는다", async () => {
  const fx = await startFixture();
  try {
    const result = await rawGet(fx.proxyPort, "/v1/responses?x=1", { host: `127.0.0.1:${fx.proxyPort}` });
    assert.equal(result.status, 200);
    assert.deepEqual(fx.hits, [{ url: "/backend-api/codex/responses?x=1", authorization: "Bearer victim-token" }]);
  } finally {
    await fx.close();
  }
});
