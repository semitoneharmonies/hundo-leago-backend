const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");
const { createTargetHttpServer } = require("../../src/bootstrap/createTargetHttpServer");

function deadline(promise, message, milliseconds = 1500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fixture(t, { handler, schedulerClose } = {}) {
  const clients = new Set();
  const observations = { mutations: 0, ready: false, schedulerClosed: false, runtimeClosed: false };
  const requests = [];
  const app = (request, response) => {
    requests.push(request);
    request.on("error", () => {});
    if (handler) handler(request, response, observations);
    else {
      request.resume();
      request.on("end", () => { observations.mutations += 1; response.end("accepted"); });
    }
  };
  app.set = () => {};
  const securityConfig = { isAllowedFrontendOrigin: () => true };
  const runtime = {
    app, securityConfig, socketRooms: { middleware(socket, next) { next(); } },
    health: { markReady() { observations.ready = true; }, markStopping() { observations.ready = false; } },
    scheduler: { async close() { observations.schedulerClosed = true; if (schedulerClose) await schedulerClose(); } },
    close() { observations.runtimeClosed = true; },
  };
  const server = createTargetHttpServer({ runtime, incompleteRequestGraceMs: 80 });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { for (const client of clients) client.destroy(); await server.close(); });
  async function connect(text) {
    const client = net.connect({ host: "127.0.0.1", port: address.port });
    clients.add(client); client.on("error", () => {});
    client.closedByServer = new Promise(resolve => client.once("close", resolve));
    await once(client, "connect"); if (text) client.write(text); return client;
  }
  return { server, observations, requests, connect, port: address.port };
}

test("shutdown expires idle connections, incomplete headers and unfinished bodies without running a mutation", async t => {
  let received;
  const seen = new Promise(resolve => { received = resolve; });
  const f = await fixture(t, { handler(request) { request.resume(); request.on("end", () => { f.observations.mutations += 1; }); received(); } });
  const idle = await f.connect();
  const headers = await f.connect("POST /headers HTTP/1.1\r\nHost: localhost\r\n");
  const body = await f.connect("POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
  await seen;
  const closing = f.server.close();
  assert.equal(f.server.close(), closing);
  assert.equal(f.observations.ready, false);
  await deadline(closing, "Incomplete clients prevented shutdown");
  await deadline(Promise.all([idle.closedByServer, headers.closedByServer, body.closedByServer]), "Incomplete clients stayed connected");
  assert.equal(f.observations.mutations, 0);
  assert.equal(f.observations.schedulerClosed, true);
  assert.equal(f.observations.runtimeClosed, true);
});

test("a request that finishes its body during grace may finish its mutation after the incomplete-client deadline", async t => {
  let received, bodyRead, release;
  const seen = new Promise(resolve => { received = resolve; });
  const complete = new Promise(resolve => { bodyRead = resolve; });
  const work = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { handler(request, response, observations) {
    request.resume(); received();
    request.on("end", async () => { bodyRead(); await work; observations.mutations += 1; response.end("accepted"); });
  } });
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request({ host: "127.0.0.1", port: f.port, method: "POST", path: "/complete", headers: { "Content-Length": "2", Connection: "close" } }, response => {
      let body = ""; response.on("data", bytes => { body += bytes; }); response.on("end", () => resolve({ status: response.statusCode, body }));
    }); request.on("error", reject);
  }); result.catch(() => {});
  try {
    request.write("{"); await seen;
    let closed = false;
    const closing = f.server.close().then(() => { closed = true; });
    request.end("}"); await complete;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(closed, false);
    assert.equal(f.observations.runtimeClosed, false);
    release();
    assert.deepEqual(await deadline(result, "Completed mutation lost its response"), { status: 200, body: "accepted" });
    await deadline(closing, "Completed mutation prevented shutdown");
    assert.equal(f.observations.mutations, 1);
    assert.equal(f.observations.runtimeClosed, true);
  } finally { release(); request.destroy(); }
});

test("incomplete clients expire while a scheduled operation drains, and another server remains available", async t => {
  let release, received;
  const work = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { received = resolve; });
  const f = await fixture(t, { schedulerClose: () => work, handler(request) { request.resume(); received(); } });
  const other = await fixture(t);
  const client = await f.connect("POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{"); await seen;
  try {
    let closed = false;
    const closing = f.server.close().then(() => { closed = true; });
    await deadline(client.closedByServer, "Slow scheduling drain left an incomplete client open");
    assert.equal(closed, false);
    assert.equal(f.observations.runtimeClosed, false);
    assert.equal(other.observations.ready, true);
    const response = await fetch(`http://127.0.0.1:${other.port}/unrelated`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200); assert.equal(await response.text(), "accepted");
    release(); await deadline(closing, "Scheduled operation did not finish draining");
    assert.equal(f.observations.runtimeClosed, true);
    assert.equal(f.observations.mutations, 0);
  } finally { release(); }
});

test("a pipelined unfinished request cannot discard the preceding accepted mutation response", async t => {
  let release, received;
  const work = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { received = resolve; });
  let count = 0;
  const f = await fixture(t, { handler(request, response, observations) {
    count += 1; request.resume();
    if (count === 2) received();
    request.on("end", async () => { await work; observations.mutations += 1; response.end("accepted"); });
  } });
  const client = await f.connect(); let bytes = "";
  client.on("data", chunk => { bytes += chunk.toString(); });
  client.write("POST /accepted HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}POST /unfinished HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{");
  await seen;
  try {
    const closing = f.server.close();
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(client.destroyed, false);
    assert.equal(f.observations.runtimeClosed, false);
    release();
    await deadline(closing, "Pipelined client prevented shutdown");
    await deadline(client.closedByServer, "Pipelined client stayed open");
    assert(bytes.startsWith("HTTP/1.1 200"));
    assert(bytes.includes("accepted"));
    assert.equal(f.observations.mutations, 1);
  } finally { release(); }
});
