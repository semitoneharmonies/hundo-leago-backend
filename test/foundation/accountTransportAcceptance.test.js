const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createReleaseQaRuntime } = require("../../src/operations/release/createReleaseQaRuntime");
const { fixtureEmail, fixtureId } = require("../../src/operations/release/releaseQaFixtureContract");

const PASSWORD = "Transport Rehearsal Password 2026!";
const ORIGIN = "http://127.0.0.1:5173";
const MIGRATIONS = path.resolve(__dirname, "../../database/migrations");

function headers(session, extra = {}) {
  return {
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...(session ? { Cookie: session.cookie } : {}),
    ...extra,
  };
}

async function request(started, pathname, { session, method = "GET", body, csrf = true, extraHeaders = {} } = {}) {
  const response = await fetch(`${started.baseUrl}${pathname}`, {
    method,
    headers: headers(session, {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(session && csrf ? { "X-CSRF-Token": session.csrfToken } : {}),
      ...extraHeaders,
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
}

async function signIn(started, alias, password = PASSWORD) {
  const result = await request(started, "/api/v1/session", {
    method: "POST", body: { email: fixtureEmail(alias), password },
  });
  assert.equal(result.status, 200, result.body.error?.code);
  return { cookie: result.cookie.split(";", 1)[0], csrfToken: result.body.data.csrfToken };
}

// Real Engine.IO v4 long polling and Socket.IO CONNECT/DISCONNECT packets.
// https://socket.io/docs/v4/engine-io-protocol/
// https://socket.io/docs/v4/socket-io-protocol/
// No fake server socket or additional runtime dependency is used.
async function connectPolling(t, started, session) {
  let url = `${started.baseUrl}/socket.io/?EIO=4&transport=polling`;
  async function exchange(method = "GET", body) {
    const response = await fetch(url, {
      method, headers: headers(session, { "Content-Type": "text/plain;charset=UTF-8" }),
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, text: await response.text() };
  }
  const opened = await exchange();
  assert.equal(opened.status, 200);
  assert.equal(opened.text[0], "0");
  const handshake = JSON.parse(opened.text.slice(1));
  url += `&sid=${encodeURIComponent(handshake.sid)}`;
  t.after(async () => { await exchange("POST", "1").catch(() => {}); });
  assert.equal((await exchange("POST", "40")).status, 200);
  const connected = await exchange();
  assert.equal(connected.status, 200);
  const packet = connected.text.split("\x1e").find((value) => value.startsWith("40"));
  assert.ok(packet, "The actual Socket.IO authentication handshake must succeed.");
  const socketId = JSON.parse(packet.slice(2)).sid;
  return {
    socketId,
    async receive() {
      const result = await exchange();
      assert.equal(result.status, 200);
      return result.text.split("\x1e");
    },
  };
}

function disconnectPending(connection) {
  // Attach the rejection handler immediately while the account command runs.
  return connection.receive().then(
    (packets) => ({ packets }), (error) => ({ error })
  );
}

async function expectDisconnected(pending) {
  const result = await pending;
  if (result.error) throw result.error;
  assert.ok(result.packets.includes("41"), "The client must receive a server-initiated namespace disconnect.");
}

async function expectControlConnection(started, connection) {
  const next = connection.receive();
  started.runtime.app.get("io").to(connection.socketId).emit("acceptance:control", { retained: true });
  assert.deepEqual(await next, ['42["acceptance:control",{"retained":true}]']);
}

test("account acceptance uses real HTTP and connected Socket.IO clients", { timeout: 180_000 }, async (t) => {
  const started = await createReleaseQaRuntime({ migrationsDirectory: MIGRATIONS, password: PASSWORD, port: 0 });
  t.after(() => started.close());
  const database = started.runtime.database;

  await t.test("fresh sign-in returns zero, one or multiple authorized leagues without bootstrap writes", async () => {
    for (const [alias, leagues] of [
      ["verifiedWithoutMembership", []],
      ["leagueAManagerOne", ["leagueA"]],
      ["platformAdmin", ["leagueA", "leagueB"]],
    ]) {
      const session = await signIn(started, alias);
      const before = database.serialize();
      const result = await request(started, "/api/v1/session", { session });
      assert.equal(result.status, 200);
      const expectedIds = leagues.map((league) => fixtureId(`league:${league}`));
      assert.deepEqual(result.body.data.leagues.map(({ id }) => id).sort(), expectedIds.sort());
      assert.equal(result.body.data.defaultLeagueId, expectedIds.length === 1 ? expectedIds[0] : null);
      assert.ok(before.equals(database.serialize()), "Session bootstrap is read-only.");
      if (alias === "leagueAManagerOne") {
        const hidden = await request(started, `/api/v1/leagues/${fixtureId("league:leagueB")}`, { session });
        assert.equal(hidden.status, 404);
      }
    }
  });

  await t.test("a replacement login disconnects both prior tabs while another manager stays connected", async (t) => {
    const original = await signIn(started, "leagueAManagerOne");
    const control = await signIn(started, "leagueBManagerOne");
    const first = await connectPolling(t, started, original);
    const second = await connectPolling(t, started, original);
    const unrelated = await connectPolling(t, started, control);
    const firstPending = disconnectPending(first);
    const secondPending = disconnectPending(second);
    const replacement = await signIn(started, "leagueAManagerOne");
    await Promise.all([expectDisconnected(firstPending), expectDisconnected(secondPending)]);
    assert.equal((await request(started, "/api/v1/session", { session: original })).status, 401);
    assert.equal((await request(started, "/api/v1/session", { session: replacement })).status, 200);
    await expectControlConnection(started, unrelated);
    assert.equal((await request(started, "/api/v1/session", { session: control })).status, 200);
  });

  await t.test("sign-out requires CSRF and then promptly disconnects the connected client", async (t) => {
    const session = await signIn(started, "leagueAManagerTwo");
    const client = await connectPolling(t, started, session);
    const denied = await request(started, "/api/v1/session", { method: "DELETE", body: {}, session, csrf: false });
    assert.equal(denied.status, 403);
    await expectControlConnection(started, client);
    const disconnected = disconnectPending(client);
    assert.equal((await request(started, "/api/v1/session", { method: "DELETE", body: {}, session })).status, 200);
    await expectDisconnected(disconnected);
    assert.equal((await request(started, "/api/v1/session", { session })).status, 401);
  });

  await t.test("password change disconnects existing transport and requires the new password", async (t) => {
    const session = await signIn(started, "leagueAManagerTwo");
    const client = await connectPolling(t, started, session);
    const disconnected = disconnectPending(client);
    const newPassword = "Changed Transport Password 2026!";
    const changed = await request(started, "/api/v1/session/password", {
      method: "POST", session,
      body: { currentPassword: PASSWORD, newPassword, newPasswordConfirmation: newPassword },
    });
    assert.equal(changed.status, 200, changed.body.error?.code);
    await expectDisconnected(disconnected);
    assert.equal((await request(started, "/api/v1/session", { session })).status, 401);
    assert.equal((await request(started, "/api/v1/session", {
      method: "POST", body: { email: fixtureEmail("leagueAManagerTwo"), password: PASSWORD },
    })).status, 401);
    const replacement = await signIn(started, "leagueAManagerTwo", newPassword);
    assert.equal((await request(started, "/api/v1/session", { session: replacement })).status, 200);
  });

  await t.test("captured password recovery consumes its link once and disconnects the old session", async (t) => {
    const session = await signIn(started, "leagueAManagerOne");
    const client = await connectPolling(t, started, session);
    const requested = await request(started, "/api/v1/password-reset-requests", {
      method: "POST", body: { email: fixtureEmail("leagueAManagerOne") },
    });
    assert.equal(requested.status, 202, requested.body.error?.code);
    const email = started.runtime.services.accountEmail;
    assert.equal(typeof email.adapter.listCaptured, "function", "Only the fixture capture adapter is permitted.");
    await email.deliveryService.deliverDue({ limit: 100 });
    const captured = email.adapter.listCaptured().filter((message) =>
      message.actionKind === "password_reset" && message.to === fixtureEmail("leagueAManagerOne")
    );
    assert.equal(captured.length, 1);
    const token = new URLSearchParams(new URL(captured[0].actionUrl).hash.slice(1)).get("token");
    assert.ok(token);
    const disconnected = disconnectPending(client);
    const newPassword = "Recovered Transport Password 2026!";
    const body = { token, newPassword, newPasswordConfirmation: newPassword };
    const reset = await request(started, "/api/v1/password-resets", { method: "POST", body });
    assert.equal(reset.status, 200, reset.body.error?.code);
    await expectDisconnected(disconnected);
    assert.equal((await request(started, "/api/v1/session", { session })).status, 401);
    const replay = await request(started, "/api/v1/password-resets", { method: "POST", body });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error.code, "PASSWORD_RESET_INVALID");
    const recovered = await signIn(started, "leagueAManagerOne", newPassword);
    assert.equal((await request(started, "/api/v1/session", { session: recovered })).status, 200);
  });

  assert.deepEqual(database.pragma("foreign_key_check"), []);
});

test("signed-prospect buyout cancels real HTTP proposals and preserves the other league", { timeout: 90_000 }, async (t) => {
  const started = await createReleaseQaRuntime({ migrationsDirectory: MIGRATIONS, password: PASSWORD, port: 0 });
  t.after(() => started.close());
  const database = started.runtime.database;
  const manager = await signIn(started, "leagueBManagerOne");
  const outsider = await signIn(started, "leagueAManagerOne");
  const leagueId = fixtureId("league:leagueB");
  const teamId = fixtureId("team:leagueB:6");
  const contractId = fixtureId("contract:leagueB:signedProspect");
  const playerId = fixtureId("player:signedProspect");
  const otherLeague = fixtureId("league:leagueA");
  const preserved = database.prepare("SELECT * FROM contracts WHERE league_id = ? ORDER BY id").all(otherLeague);
  const pending = [];
  for (const teamNumber of [2, 3]) {
    const result = await request(started, `/api/v1/leagues/${leagueId}/trades`, {
      method: "POST", session: manager,
      extraHeaders: { "Idempotency-Key": `transport-buyout-${teamNumber}` },
      body: {
        proposingTeamId: teamId,
        receivingTeamId: fixtureId(`team:leagueB:${teamNumber}`),
        proposingAssets: [{ type: "prospect_right", playerId }],
        receivingAssets: [{ type: "contract", contractId: fixtureId(`contract:leagueB:activeForward${teamNumber}`) }],
      },
    });
    assert.equal(result.status, 201, result.body.error?.code);
    pending.push(result.body.data.proposal.id);
  }
  const buyoutPath = `/api/v1/leagues/${leagueId}/teams/${teamId}/contracts/${contractId}/buyout`;
  const body = { confirmed: true, expectedContractVersion: 1, expectedOwnershipVersion: 1 };
  const beforeDenied = database.serialize();
  const denied = await request(started, buyoutPath, { method: "POST", session: outsider, body });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error.code, "LEAGUE_NOT_FOUND");
  assert.equal(denied.body.error.message, "The league was not found.");
  assert.ok(beforeDenied.equals(database.serialize()), "A denied cross-league command must not write.");
  const missing = await request(started, buyoutPath.replace(leagueId, fixtureId("league:missing")), {
    method: "POST", session: outsider, body,
  });
  assert.equal(missing.status, denied.status);
  assert.equal(missing.body.error.code, denied.body.error.code);
  assert.equal(missing.body.error.message, denied.body.error.message);
  assert.equal(database.prepare("SELECT status FROM contracts WHERE id = ?").get(contractId).status, "active");
  const boughtOut = await request(started, buyoutPath, { method: "POST", session: manager, body });
  assert.equal(boughtOut.status, 200, boughtOut.body.error?.code);
  assert.deepEqual(boughtOut.body.data.automaticallyCancelledTradeIds.sort(), pending.sort());
  for (const tradeId of pending) {
    assert.equal(database.prepare("SELECT status FROM trades WHERE id = ?").get(tradeId).status, "cancelled");
    const rejected = await request(started, `/api/v1/leagues/${leagueId}/trades/${tradeId}/accept`, {
      method: "POST", session: manager, body: {},
      extraHeaders: { "Idempotency-Key": `after-buyout-${tradeId}` },
    });
    assert.equal(rejected.status, 409);
  }
  assert.equal(database.prepare("SELECT status FROM contracts WHERE id = ?").get(contractId).status, "eliminated");
  assert.deepEqual(database.prepare("SELECT * FROM contracts WHERE league_id = ? ORDER BY id").all(otherLeague), preserved);
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});
