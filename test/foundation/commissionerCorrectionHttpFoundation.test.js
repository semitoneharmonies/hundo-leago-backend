const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const {
  createCommissionerCorrectionRouter,
} = require("../../src/transport/http/createCommissionerCorrectionRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";

function middleware(next = () => {}) {
  return (request, response, complete) => {
    next(request, response);
    complete();
  };
}

function requestSecurity(calls) {
  return {
    assignRequestId: middleware(),
    authenticateBootstrap: middleware(),
    authenticateUnsafe: middleware(() => {
      calls.unsafeAuthentication += 1;
    }),
    credentialedCors: middleware(),
    getAuthenticatedSession() {
      return { valid: true, session: { userId: "commissioner" } };
    },
    getSessionBootstrap() {
      return { valid: true, session: { userId: "commissioner" } };
    },
    getRequestId() {
      return "commissioner-correction-request";
    },
    requireAllowedOrigin: middleware(),
    requireCompatibleFetchMetadata: middleware(),
    requireJson: middleware(),
    securityHeaders: middleware(),
  };
}

function correctionService(calls) {
  const command = (name) => (input) => {
    calls[name] = input;
    return { code: name, preview: name.startsWith("preview") };
  };
  return {
    readWorkspace: command("readWorkspace"),
    previewAdd: command("previewAdd"),
    applyAdd: command("applyAdd"),
    previewRemove: command("previewRemove"),
    applyRemove: command("applyRemove"),
    previewRoster: command("previewRoster"),
    applyRoster: command("applyRoster"),
    previewContract: command("previewContract"),
    applyContract: command("applyContract"),
  };
}

async function start(t, service, calls) {
  const app = express();
  app.use(createCommissionerCorrectionRouter({
    requestSecurity: requestSecurity(calls),
    commissionerCorrectionService: service,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function get(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
}

test("M7-10 reads a commissioner roster workspace through bootstrap authentication", async (t) => {
  const calls = { unsafeAuthentication: 0 };
  const baseUrl = await start(t, correctionService(calls), calls);
  const result = await get(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-workspace`
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.code, "readWorkspace");
  assert.deepEqual(calls.readWorkspace, {
    leagueId: LEAGUE_ID,
    authenticated: { valid: true, session: { userId: "commissioner" } },
  });
  assert.equal(calls.unsafeAuthentication, 0);
});

test("M7-10 routes each commissioner correction command through unsafe authentication", async (t) => {
  const calls = { unsafeAuthentication: 0 };
  const baseUrl = await start(t, correctionService(calls), calls);
  const commands = [
    ["roster-additions/previews", "previewAdd"],
    ["roster-additions", "applyAdd"],
    ["roster-removals/previews", "previewRemove"],
    ["roster-removals", "applyRemove"],
    ["roster-corrections/previews", "previewRoster"],
    ["roster-corrections", "applyRoster"],
    ["contract-corrections/previews", "previewContract"],
    ["contract-corrections", "applyContract"],
  ];
  for (const [path, method] of commands) {
    const result = await post(
      baseUrl,
      `/api/v1/leagues/${LEAGUE_ID}/commissioner/${path}`,
      { expectedVersion: 2 }
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.code, method);
    assert.equal(result.body.meta.requestId, "commissioner-correction-request");
    assert.deepEqual(calls[method], {
      leagueId: LEAGUE_ID,
      input: { expectedVersion: 2 },
      idempotencyKey: undefined,
      authenticated: { valid: true, session: { userId: "commissioner" } },
    });
  }
  assert.equal(calls.unsafeAuthentication, 8);
});

test("FAD-05 awaits every commissioner write result and maps async failures safely", async (t) => {
  const calls = { unsafeAuthentication: 0 };
  const service = correctionService(calls);
  service.applyAdd = async (input) => {
    await Promise.resolve();
    calls.applyAdd = input;
    return {
      code: "COMMISSIONER_ROSTER_ADD_CORRECTION_APPLIED",
      lateLock: { status: "not_applicable" },
    };
  };
  service.applyRemove = async () => {
    await Promise.resolve();
    const error = new Error("private stale-state detail");
    error.reasonCode = "COMMISSIONER_CORRECTION_SOURCE_CHANGED";
    throw error;
  };
  service.applyRoster = async (input) => {
    await Promise.resolve();
    calls.applyRoster = input;
    return {
      code: "COMMISSIONER_ROSTER_CORRECTION_APPLIED",
      lateLock: { status: "still_illegal" },
    };
  };
  service.applyContract = async (input) => {
    await Promise.resolve();
    calls.applyContract = input;
    return {
      code: "COMMISSIONER_CONTRACT_CORRECTION_APPLIED",
      lateLock: { status: "awaiting_data" },
    };
  };
  const baseUrl = await start(t, service, calls);

  const addition = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-additions`,
    { expectedVersion: 2 }
  );
  assert.equal(addition.response.status, 200);
  assert.deepEqual(addition.body.data, {
    code: "COMMISSIONER_ROSTER_ADD_CORRECTION_APPLIED",
    lateLock: { status: "not_applicable" },
  });
  assert.deepEqual(calls.applyAdd, {
    leagueId: LEAGUE_ID,
    input: { expectedVersion: 2 },
    idempotencyKey: undefined,
    authenticated: { valid: true, session: { userId: "commissioner" } },
  });

  const removal = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-removals`,
    { expectedVersion: 2 }
  );
  assert.equal(removal.response.status, 412);
  assert.deepEqual(removal.body.error, {
    code: "COMMISSIONER_CORRECTION_PRECONDITION_FAILED",
    message: "The roster or contract changed; refetch it and try again.",
    requestId: "commissioner-correction-request",
  });
  assert.equal(
    JSON.stringify(removal.body).includes("private stale-state detail"),
    false
  );

  const roster = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-corrections`,
    { expectedVersion: 2 }
  );
  assert.equal(roster.response.status, 200);
  assert.deepEqual(roster.body.data, {
    code: "COMMISSIONER_ROSTER_CORRECTION_APPLIED",
    lateLock: { status: "still_illegal" },
  });
  assert.equal(calls.applyRoster.input.expectedVersion, 2);

  const contract = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/contract-corrections`,
    { expectedVersion: 2 }
  );
  assert.equal(contract.response.status, 200);
  assert.deepEqual(contract.body.data, {
    code: "COMMISSIONER_CONTRACT_CORRECTION_APPLIED",
    lateLock: { status: "awaiting_data" },
  });
  assert.equal(calls.applyContract.input.expectedVersion, 2);
});

test("M7-10 maps stale correction state to a safe precondition response", async (t) => {
  const calls = { unsafeAuthentication: 0 };
  const service = correctionService(calls);
  service.applyRoster = () => {
    const error = new Error("stale");
    error.reasonCode = "COMMISSIONER_CORRECTION_SOURCE_CHANGED";
    throw error;
  };
  const baseUrl = await start(t, service, calls);
  const result = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-corrections`,
    { expectedVersion: 2 }
  );
  assert.equal(result.response.status, 412);
  assert.deepEqual(result.body.error, {
    code: "COMMISSIONER_CORRECTION_PRECONDITION_FAILED",
    message: "The roster or contract changed; refetch it and try again.",
    requestId: "commissioner-correction-request",
  });
  assert.equal(calls.unsafeAuthentication, 1);
});

test("M7-10 maps an occupied roster slot to a safe conflict response", async (t) => {
  const calls = { unsafeAuthentication: 0 };
  const service = correctionService(calls);
  service.previewAdd = () => {
    const error = new Error("database detail must not escape");
    error.code = "REPOSITORY_CONSTRAINT";
    throw error;
  };
  const baseUrl = await start(t, service, calls);
  const result = await post(
    baseUrl,
    `/api/v1/leagues/${LEAGUE_ID}/commissioner/roster-additions/previews`,
    { expectedVersion: 2 }
  );
  assert.equal(result.response.status, 409);
  assert.deepEqual(result.body.error, {
    code: "COMMISSIONER_CORRECTION_CONFLICT",
    message:
      "The commissioner correction conflicts with current league state.",
    requestId: "commissioner-correction-request",
  });
  assert.equal(JSON.stringify(result.body).includes("database detail"), false);
});
