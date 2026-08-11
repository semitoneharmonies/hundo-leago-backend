"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const express = require("express");

const {
  SAFE_MESSAGES,
  createCandidateCardRouter,
} = require(
  "../../src/transport/http/createCandidateCardRouter"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const FAD_ID =
  "22222222-2222-4222-8222-222222222222";
const TEAM_ID =
  "33333333-3333-4333-8333-333333333333";
const ENTRY_ID =
  "44444444-4444-4444-8444-444444444444";
const PLAYER_ID =
  "55555555-5555-4555-8555-555555555555";
const SESSION_ID =
  "66666666-6666-4666-8666-666666666666";
const AUTHENTICATED = Object.freeze({
  valid: true,
  session: Object.freeze({ id: SESSION_ID }),
});
const BOOTSTRAP = Object.freeze({
  valid: true,
  session: Object.freeze({ id: SESSION_ID }),
});
const BASE_PATH =
  `/api/v1/leagues/${LEAGUE_ID}` +
  `/free-agent-drafts/${FAD_ID}` +
  `/candidate-cards/${TEAM_ID}`;

function allowedRateResult() {
  return {
    allowed: true,
    code: "RATE_LIMIT_ALLOWED",
    retryAfterSeconds: 0,
  };
}

function codedError(code, options = {}) {
  return Object.assign(
    new Error("synthetic Candidate Card failure"),
    { code, ...options }
  );
}

function boundary({
  limiterResult = allowedRateResult,
  results = {},
  serviceOverrides = {},
} = {}) {
  const calls = [];
  const rateCalls = [];
  const securityCalls = [];
  let nextError = null;
  const resultQueues = Object.fromEntries(
    Object.entries(results).map(([name, value]) => [
      name,
      Array.isArray(value) ? [...value] : value,
    ])
  );

  const requestSecurity = {
    assignRequestId(request, _response, next) {
      request.requestId = "candidate-http-request";
      next();
    },
    securityHeaders(_request, _response, next) {
      next();
    },
    credentialedCors(_request, _response, next) {
      next();
    },
    requireAllowedOrigin(_request, _response, next) {
      next();
    },
    requireCompatibleFetchMetadata(
      _request,
      _response,
      next
    ) {
      next();
    },
    authenticateBootstrap(request, _response, next) {
      securityCalls.push([
        "authenticateBootstrap",
        request.method,
        request.path,
      ]);
      next();
    },
    authenticateUnsafe(request, response, next) {
      securityCalls.push([
        "authenticateUnsafe",
        request.method,
        request.path,
      ]);
      if (request.get("x-csrf-token") !== "csrf-token") {
        return response.status(403).json({
          error: {
            code: "CSRF_INVALID",
            message:
              "The request verification token is invalid.",
            requestId: request.requestId,
          },
        });
      }
      return next();
    },
    requireJson(request, response, next) {
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
          request.get("content-type") || ""
        )
      ) {
        return response.status(415).json({
          error: {
            code: "CONTENT_TYPE_INVALID",
            message: "This endpoint requires JSON.",
            requestId: request.requestId,
          },
        });
      }
      return next();
    },
    getRequestId(request) {
      return request.requestId;
    },
    getSessionBootstrap() {
      return BOOTSTRAP;
    },
    getAuthenticatedSession() {
      return AUTHENTICATED;
    },
  };

  const defaults = {
    privateCard: { projection: "private-card" },
    eligiblePlayers: {
      data: [{ projection: "eligible-player" }],
      page: {
        nextCursor: null,
        hasMore: false,
      },
    },
    previewRevision: { projection: "preview" },
    addCandidate: {
      httpStatus: 201,
      data: { projection: "added" },
    },
    editCandidate: {
      httpStatus: 200,
      data: { projection: "edited" },
    },
    moveEntry: {
      httpStatus: 200,
      data: { projection: "moved" },
    },
    removeCandidate: {
      httpStatus: 200,
      data: { projection: "removed" },
    },
    requestHelp: {
      httpStatus: 201,
      data: { projection: "help-created" },
    },
  };

  function invoke(name, input) {
    calls.push([name, input]);
    if (nextError) throw nextError;
    const configured = resultQueues[name];
    if (Array.isArray(configured)) {
      if (configured.length === 0) {
        throw new Error("synthetic result queue exhausted");
      }
      return configured.shift();
    }
    if (typeof configured === "function") {
      return configured(input);
    }
    return configured ?? defaults[name];
  }

  const candidateCardService = {
    privateCard(input) {
      return invoke("privateCard", input);
    },
    eligiblePlayers(input) {
      return invoke("eligiblePlayers", input);
    },
    previewRevision(input) {
      return invoke("previewRevision", input);
    },
    addCandidate(input) {
      return invoke("addCandidate", input);
    },
    editCandidate(input) {
      return invoke("editCandidate", input);
    },
    moveEntry(input) {
      return invoke("moveEntry", input);
    },
    removeCandidate(input) {
      return invoke("removeCandidate", input);
    },
    requestHelp(input) {
      return invoke("requestHelp", input);
    },
    ...serviceOverrides,
  };
  const rateLimiter = {
    recordAttempt(input) {
      rateCalls.push(input);
      return limiterResult(input, rateCalls.length);
    },
  };
  const router = createCandidateCardRouter({
    requestSecurity,
    candidateCardService,
    rateLimiter,
  });
  return {
    calls,
    rateCalls,
    router,
    securityCalls,
    setError(error) {
      nextError = error;
    },
  };
}

async function start(t, router) {
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function requestJson(origin, path, options = {}) {
  const response = await fetch(origin + path, options);
  const text = await response.text();
  return {
    body: text === "" ? null : JSON.parse(text),
    cacheControl: response.headers.get(
      "cache-control"
    ),
    retryAfter: response.headers.get(
      "retry-after"
    ),
    status: response.status,
  };
}

function jsonOptions(
  method,
  body,
  headers = {}
) {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-token",
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
  };
}

describe("FAD-09 T-130 and T-133 through T-139 internal HTTP boundary", () => {
  test("registers exactly all eight approved Candidate Card routes", () => {
    const { router } = boundary();
    assert.deepEqual(
      router.stack
        .filter((layer) => layer.route)
        .map((layer) => ({
          method: Object.keys(
            layer.route.methods
          )[0].toUpperCase(),
          path: layer.route.path,
        })),
      [
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/private",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/eligible-players",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/revision-previews",
        },
        {
          method: "PUT",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/slots/:slotKey/candidate",
        },
        {
          method: "PATCH",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId/move",
        },
        {
          method: "DELETE",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/help-requests",
        },
      ]
    );
  });

  test("uses bootstrap auth for reads, unsafe CSRF auth for commands, forwards exact parameters, and returns private envelopes", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const previewAction = {
      type: "remove",
      entryId: ENTRY_ID,
    };
    const addBody = {
      playerId: PLAYER_ID,
      totalValueCents: 600,
      termYears: 2,
    };
    const editBody = {
      totalValueCents: 900,
      termYears: 3,
    };
    const moveBody = { slotKey: "B02" };
    const helpBody = { message: "Please help." };
    const eligibleUrl = new URL(
      origin + BASE_PATH + "/eligible-players"
    );
    eligibleUrl.searchParams.set("slotKey", "F01");
    eligibleUrl.searchParams.set(
      "q",
      "  Mc DAVID  "
    );
    eligibleUrl.searchParams.set("cursor", "opaque");
    eligibleUrl.searchParams.set("limit", "20");

    const requests = [
      () => requestJson(origin, BASE_PATH + "/private"),
      () => requestJson(
        "",
        eligibleUrl.toString()
      ),
      () => requestJson(
        origin,
        BASE_PATH + "/revision-previews",
        jsonOptions(
          "POST",
          { action: previewAction },
          {
            "If-Match": "ignored",
            "Idempotency-Key": "ignored",
          }
        )
      ),
      () => requestJson(
        origin,
        BASE_PATH + "/slots/F04/candidate",
        jsonOptions("PUT", addBody, {
          "If-Match": '"4"',
          "Idempotency-Key": "add-1",
        })
      ),
      () => requestJson(
        origin,
        BASE_PATH + `/entries/${ENTRY_ID}`,
        jsonOptions("PATCH", editBody, {
          "If-Match": '"5"',
          "Idempotency-Key": "edit-1",
        })
      ),
      () => requestJson(
        origin,
        BASE_PATH +
          `/entries/${ENTRY_ID}/move`,
        jsonOptions("POST", moveBody, {
          "If-Match": '"6"',
          "Idempotency-Key": "move-1",
        })
      ),
      () => requestJson(
        origin,
        BASE_PATH + `/entries/${ENTRY_ID}`,
        {
          method: "DELETE",
          headers: {
            "X-CSRF-Token": "csrf-token",
            "If-Match": '"7"',
            "Idempotency-Key": "remove-1",
          },
        }
      ),
      () => requestJson(
        origin,
        BASE_PATH + "/help-requests",
        jsonOptions("POST", helpBody, {
          "Idempotency-Key": "help-1",
        })
      ),
    ];
    const responses = [];
    for (const makeRequest of requests) {
      responses.push(await makeRequest());
    }
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200, 201, 200, 200, 200, 201]
    );
    assert.equal(
      responses.every(
        (response) =>
          response.cacheControl ===
          "private, no-store"
      ),
      true
    );
    for (const response of responses) {
      assert.equal(
        response.body.meta.requestId,
        "candidate-http-request"
      );
    }
    assert.deepEqual(responses[1].body, {
      data: [{ projection: "eligible-player" }],
      page: {
        nextCursor: null,
        hasMore: false,
      },
      meta: { requestId: "candidate-http-request" },
    });
    assert.deepEqual(context.calls, [
      [
        "privateCard",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          authenticated: BOOTSTRAP,
        },
      ],
      [
        "eligiblePlayers",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          query: {
            slotKey: "F01",
            q: "  Mc DAVID  ",
            cursor: "opaque",
            limit: "20",
          },
          authenticated: BOOTSTRAP,
        },
      ],
      [
        "previewRevision",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          action: previewAction,
          authenticated: AUTHENTICATED,
        },
      ],
      [
        "addCandidate",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          slotKey: "F04",
          input: addBody,
          expectedCardVersion: 4,
          idempotencyKey: "add-1",
          authenticated: AUTHENTICATED,
        },
      ],
      [
        "editCandidate",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          entryId: ENTRY_ID,
          input: editBody,
          expectedCardVersion: 5,
          idempotencyKey: "edit-1",
          authenticated: AUTHENTICATED,
        },
      ],
      [
        "moveEntry",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          entryId: ENTRY_ID,
          input: moveBody,
          expectedCardVersion: 6,
          idempotencyKey: "move-1",
          authenticated: AUTHENTICATED,
        },
      ],
      [
        "removeCandidate",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          entryId: ENTRY_ID,
          expectedCardVersion: 7,
          idempotencyKey: "remove-1",
          authenticated: AUTHENTICATED,
        },
      ],
      [
        "requestHelp",
        {
          leagueId: LEAGUE_ID,
          fadId: FAD_ID,
          teamId: TEAM_ID,
          input: helpBody,
          idempotencyKey: "help-1",
          authenticated: AUTHENTICATED,
        },
      ],
    ]);
    assert.deepEqual(
      context.securityCalls.map((call) => call[0]),
      [
        "authenticateBootstrap",
        "authenticateBootstrap",
        "authenticateUnsafe",
        "authenticateUnsafe",
        "authenticateUnsafe",
        "authenticateUnsafe",
        "authenticateUnsafe",
        "authenticateUnsafe",
      ]
    );
    assert.deepEqual(
      context.rateCalls.map(
        ({ action, bucket, canonicalIdentifier }) => ({
          action,
          bucket,
          canonicalIdentifier,
        })
      ),
      [
        ...Array.from({ length: 4 }, () => [
          {
            action: "fad_candidate_write",
            bucket: "session",
            canonicalIdentifier: SESSION_ID,
          },
          {
            action: "fad_candidate_write",
            bucket: "league",
            canonicalIdentifier: LEAGUE_ID,
          },
        ]).flat(),
        {
          action: "fad_help_write",
          bucket: "session",
          canonicalIdentifier: SESSION_ID,
        },
        {
          action: "fad_help_write",
          bucket: "league",
          canonicalIdentifier: LEAGUE_ID,
        },
      ]
    );
    assert.equal(
      context.rateCalls.every(
        (call) => call.failed === false
      ),
      true
    );
  });

  test("preview ignores concurrency headers, remains unthrottled, and unsafe routes require CSRF", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const preview = await requestJson(
      origin,
      BASE_PATH + "/revision-previews",
      jsonOptions(
        "POST",
        {
          action: {
            type: "remove",
            entryId: ENTRY_ID,
          },
        },
        {
          "If-Match": "malformed-but-ignored",
          "Idempotency-Key": "",
        }
      )
    );
    assert.equal(preview.status, 200);
    assert.equal(context.rateCalls.length, 0);
    assert.equal(context.calls.length, 1);

    const denied = await requestJson(
      origin,
      BASE_PATH + "/revision-previews",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: {
            type: "remove",
            entryId: ENTRY_ID,
          },
        }),
      }
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "CSRF_INVALID");
    assert.equal(denied.cacheControl, "private, no-store");
    assert.equal(context.calls.length, 1);
  });

  test("preserves service-returned fresh, existing-active, and exact-replay statuses", async (t) => {
    const created = {
      projection: "immutable-help-result",
      version: 1,
    };
    const context = boundary({
      results: {
        requestHelp: [
          { httpStatus: 201, data: created },
          { httpStatus: 200, data: created },
          { httpStatus: 201, data: created },
        ],
      },
    });
    const origin = await start(t, context.router);
    const responses = [];
    for (const key of [
      "help-create",
      "help-existing",
      "help-create",
    ]) {
      responses.push(
        await requestJson(
          origin,
          BASE_PATH + "/help-requests",
          jsonOptions("POST", {}, {
            "Idempotency-Key": key,
          })
        )
      );
    }
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 200, 201]
    );
    assert.deepEqual(
      responses.map((response) => response.body.data),
      [created, created, created]
    );
  });

  test("rejects a DELETE body and forbids If-Match on help before rate limiting or service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const deletion = await requestJson(
      origin,
      BASE_PATH + `/entries/${ENTRY_ID}`,
      {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": "csrf-token",
          "If-Match": '"1"',
          "Idempotency-Key": "remove-with-body",
        },
        body: "{}",
      }
    );
    const help = await requestJson(
      origin,
      BASE_PATH + "/help-requests",
      jsonOptions("POST", {}, {
        "If-Match": '"1"',
        "Idempotency-Key": "help-with-version",
      })
    );
    for (const response of [deletion, help]) {
      assert.equal(response.status, 400);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
    }
    assert.equal(context.calls.length, 0);
    assert.equal(context.rateCalls.length, 0);
  });

  test("rejects malformed query, headers, JSON, service-delegated body shapes, content type, and oversized JSON", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const addPath =
      BASE_PATH + "/slots/F01/candidate";
    const cases = [
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH + "/private?unknown=1"
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH.replace(LEAGUE_ID, "bad") +
              "/private"
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH + "/revision-previews",
            jsonOptions("POST", {
              action: {
                type: "remove",
                entryId: ENTRY_ID,
              },
              unknown: true,
            })
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH + "/revision-previews",
            jsonOptions("POST", undefined)
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH +
              "/eligible-players?slotKey=F01&slotKey=F02"
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            BASE_PATH + "/eligible-players?q=name"
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            addPath,
            jsonOptions("PUT", {}, {
              "If-Match": "1",
              "Idempotency-Key": "add",
            })
          ),
      },
      {
        expected: 400,
        request: () =>
          requestJson(
            origin,
            addPath,
            jsonOptions("PUT", {}, {
              "If-Match": '"1"',
              "Idempotency-Key": "x".repeat(129),
            })
          ),
      },
      {
        expected: 415,
        request: () =>
          requestJson(origin, addPath, {
            method: "PUT",
            headers: {
              "X-CSRF-Token": "csrf-token",
              "If-Match": '"1"',
              "Idempotency-Key": "add",
            },
            body: "{}",
          }),
      },
      {
        expected: 400,
        request: () =>
          requestJson(origin, addPath, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": "csrf-token",
              "If-Match": '"1"',
              "Idempotency-Key": "add",
            },
            body: "{",
          }),
      },
      {
        expected: 413,
        request: () =>
          requestJson(
            origin,
            addPath,
            jsonOptions(
              "PUT",
              { padding: "x".repeat(17_000) },
              {
                "If-Match": '"1"',
                "Idempotency-Key": "add",
              }
            )
          ),
      },
    ];
    for (const entry of cases) {
      const response = await entry.request();
      assert.equal(response.status, entry.expected);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
    }
    assert.equal(context.calls.length, 0);
    assert.equal(context.rateCalls.length, 0);

    for (const body of [
      undefined,
      { unknown: true },
    ]) {
      const delegated = boundary({
        serviceOverrides: {
          addCandidate(input) {
            delegated.calls.push([
              "addCandidate",
              input,
            ]);
            throw codedError(
              "CANDIDATE_CARD_INPUT_INVALID"
            );
          },
        },
      });
      const delegatedOrigin = await start(
        t,
        delegated.router
      );
      const response = await requestJson(
        delegatedOrigin,
        addPath,
        jsonOptions("PUT", body, {
          "If-Match": '"1"',
          "Idempotency-Key": "delegated-body",
        })
      );
      assert.equal(response.status, 400);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
      assert.equal(delegated.calls.length, 1);
    }
  });

  test("maps every Candidate Card public error class and strips unsafe precondition details", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const path = BASE_PATH + "/slots/F01/candidate";
    const cases = [
      ["CANDIDATE_CARD_INPUT_INVALID", 400, "FREE_AGENT_DRAFT_INPUT_INVALID"],
      ["CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID", 400, "FREE_AGENT_DRAFT_INPUT_INVALID"],
      ["LEAGUE_ID_INVALID", 400, "FREE_AGENT_DRAFT_INPUT_INVALID"],
      ["CANDIDATE_CARD_NOT_FOUND", 404, "CANDIDATE_CARD_NOT_FOUND"],
      ["CANDIDATE_CARD_ENTRY_NOT_FOUND", 404, "CANDIDATE_CARD_ENTRY_NOT_FOUND"],
      ["FREE_AGENT_DRAFT_NOT_FOUND", 404, "FREE_AGENT_DRAFT_NOT_FOUND"],
      ["LEAGUE_NOT_FOUND", 404, "LEAGUE_NOT_FOUND"],
      ["FAD_PHASE_CONFLICT", 409, "FAD_PHASE_CONFLICT"],
      ["FAD_DEADLINE_PASSED", 409, "FAD_DEADLINE_PASSED"],
      ["CANDIDATE_SLOT_OCCUPIED", 409, "CANDIDATE_SLOT_OCCUPIED"],
      ["CANDIDATE_CARRYOVER_LOCKED", 409, "CANDIDATE_CARRYOVER_LOCKED"],
      ["CANDIDATE_PLAYER_DUPLICATE", 409, "CANDIDATE_PLAYER_DUPLICATE"],
      ["FAD_HELP_WINDOW_CLOSED", 409, "FAD_HELP_WINDOW_CLOSED"],
      ["FAD_ALLOCATION_QUARANTINED", 409, "FAD_ALLOCATION_QUARANTINED"],
      ["IDEMPOTENCY_KEY_REUSED", 409, "IDEMPOTENCY_KEY_REUSED"],
      ["IDEMPOTENCY_REQUEST_UNAVAILABLE", 409, "IDEMPOTENCY_REQUEST_UNAVAILABLE"],
      ["CANDIDATE_SLOT_INVALID", 422, "CANDIDATE_SLOT_INVALID"],
      ["CANDIDATE_PLAYER_INELIGIBLE", 422, "CANDIDATE_PLAYER_INELIGIBLE"],
      ["CANDIDATE_CONTRACT_INVALID", 422, "CANDIDATE_CONTRACT_INVALID"],
      ["CANDIDATE_BENCH_AAV_EXCEEDED", 422, "CANDIDATE_BENCH_AAV_EXCEEDED"],
      ["LEAGUE_FROZEN", 423, "LEAGUE_FROZEN"],
      ["SYNTHETIC_UNKNOWN", 500, "FREE_AGENT_DRAFT_REQUEST_FAILED"],
    ];
    for (const [source, status, publicCode] of cases) {
      context.setError(codedError(source));
      const response = await requestJson(
        origin,
        path,
        jsonOptions("PUT", {}, {
          "If-Match": '"1"',
          "Idempotency-Key": `error-${source}`,
        })
      );
      assert.equal(response.status, status, source);
      assert.equal(
        response.body.error.code,
        publicCode,
        source
      );
      assert.equal(
        response.body.error.message,
        SAFE_MESSAGES[publicCode],
        source
      );
    }

    context.setError(
      codedError("REPOSITORY_VERSION_CONFLICT", {
        details: {
          reasonCode:
            "CANDIDATE_CARD_PRECONDITION_FAILED",
          currentVersion: 9,
          refetch: true,
          privateOffer: "must-not-leak",
        },
      })
    );
    const precondition = await requestJson(
      origin,
      path,
      jsonOptions("PUT", {}, {
        "If-Match": '"8"',
        "Idempotency-Key": "stale",
      })
    );
    assert.equal(precondition.status, 412);
    assert.deepEqual(precondition.body.error, {
      code: "CANDIDATE_CARD_PRECONDITION_FAILED",
      message:
        SAFE_MESSAGES.CANDIDATE_CARD_PRECONDITION_FAILED,
      details: {
        currentVersion: 9,
        refetch: true,
      },
      requestId: "candidate-http-request",
    });

    context.setError(
      codedError("REPOSITORY_VERSION_CONFLICT", {
        details: {
          reasonCode: "CANDIDATE_SLOT_OCCUPIED",
        },
      })
    );
    const repositoryConflict = await requestJson(
      origin,
      path,
      jsonOptions("PUT", {}, {
        "If-Match": '"9"',
        "Idempotency-Key": "repository-conflict",
      })
    );
    assert.equal(repositoryConflict.status, 409);
    assert.equal(
      repositoryConflict.body.error.code,
      "CANDIDATE_SLOT_OCCUPIED"
    );
  });

  test("records both rate families and blocks on either session or league result using the maximum Retry-After", async (t) => {
    for (const scenario of [
      {
        blockedRetries: { session: 31 },
        retryAfterSeconds: 31,
      },
      {
        blockedRetries: { league: 47 },
        retryAfterSeconds: 47,
      },
      {
        blockedRetries: {
          session: 19,
          league: 53,
        },
        retryAfterSeconds: 53,
      },
    ]) {
      const context = boundary({
        limiterResult(input) {
          const retryAfterSeconds =
            scenario.blockedRetries[
              input.bucket
            ];
          return retryAfterSeconds !== undefined
            ? {
                allowed: false,
                code: "RATE_LIMITED",
                retryAfterSeconds,
              }
            : allowedRateResult();
        },
      });
      const origin = await start(t, context.router);
      const response = await requestJson(
        origin,
        BASE_PATH + "/slots/F01/candidate",
        jsonOptions("PUT", {}, {
          "If-Match": '"1"',
          "Idempotency-Key":
            `limited-${Object.keys(
              scenario.blockedRetries
            ).join("-")}`,
        })
      );
      assert.equal(response.status, 429);
      assert.equal(response.retryAfter, String(
        scenario.retryAfterSeconds
      ));
      assert.deepEqual(response.body.error, {
        code: "RATE_LIMITED",
        message: SAFE_MESSAGES.RATE_LIMITED,
        requestId: "candidate-http-request",
      });
      assert.deepEqual(
        context.rateCalls.map((call) => [
          call.action,
          call.bucket,
          call.canonicalIdentifier,
        ]),
        [
          [
            "fad_candidate_write",
            "session",
            SESSION_ID,
          ],
          [
            "fad_candidate_write",
            "league",
            LEAGUE_ID,
          ],
        ]
      );
      assert.equal(context.calls.length, 0);
    }
  });
});
