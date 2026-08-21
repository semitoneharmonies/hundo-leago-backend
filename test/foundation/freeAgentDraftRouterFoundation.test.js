"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const express = require("express");

const {
  FAD_OPERATIONAL_WRITE_ACTION,
  SAFE_MESSAGES,
  createFreeAgentDraftRouter,
} = require(
  "../../src/transport/http/createFreeAgentDraftRouter"
);
const {
  createAuthenticationRateLimiter,
} = require(
  "../../src/application/services/accounts/createAuthenticationRateLimiter"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const SEASON_ID =
  "22222222-2222-4222-8222-222222222222";
const TEAM_ID =
  "33333333-3333-4333-8333-333333333333";
const FAD_ID =
  "44444444-4444-4444-8444-444444444444";
const OTHER_LEAGUE_ID =
  "99999999-9999-4999-8999-999999999999";
const READINESS_ID =
  "55555555-5555-4555-8555-555555555555";
const SESSION_ID =
  "66666666-6666-4666-8666-666666666666";
const RECOVERY_OPERATION_ID =
  "77777777-7777-4777-8777-777777777777";
const ALLOCATION_ID =
  "88888888-8888-4888-8888-888888888888";
const AUTHENTICATED = Object.freeze({
  valid: true,
  session: Object.freeze({ id: SESSION_ID }),
});
const RETRY_BODY = Object.freeze({
  seasonId: SEASON_ID,
  readinessOperationId: READINESS_ID,
  confirmation:
    "RETRY FREE AGENT DRAFT READINESS",
});
const RECOVERY_ACTION_BODY = Object.freeze({
  action: "retry_deadline",
  resourceId: null,
  reason: "Retry the failed Candidate deadline operation.",
});
const RECOVERY_ACTION_DATA = Object.freeze({
  operationId: RECOVERY_OPERATION_ID,
  occurrenceKey:
    `fad:${FAD_ID}:deadline:1000000`,
  action: "retry_deadline",
  resourceId: null,
  status: "pending",
  acceptedAtMs: 1_100_000,
  pollDescriptor: Object.freeze({
    kind: "fad_recovery",
    leagueId: LEAGUE_ID,
    fadId: FAD_ID,
  }),
});
const CORRECTION_PREVIEW_BODY = Object.freeze({
  mode: "recompute_locked_snapshot",
});
const CORRECTION_BODY = Object.freeze({
  mode: "recompute_locked_snapshot",
  previewFingerprint: "a".repeat(64),
  reason:
    "Reconcile the result to the locked Candidate Card snapshot.",
  confirmation: "APPLY FAD CORRECTION",
});
const CORRECTION_PREVIEW_DATA = Object.freeze({
  allocationId: ALLOCATION_ID,
  allocationVersion: 3,
  previewFingerprint: "a".repeat(64),
  reversible: true,
  currentDecision: Object.freeze({
    rankedOffers: Object.freeze([
      Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }),
    ]),
    winner: Object.freeze({
      totalValueCents: null,
      termYears: null,
      aavCents: null,
    }),
    restricted: Object.freeze({
      minimumTotalValueCents: null,
      minimumTermYears: null,
      minimumAavCents: null,
    }),
  }),
  recomputedDecision: Object.freeze({
    rankedOffers: Object.freeze([
      Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }),
    ]),
    winner: null,
    restricted: null,
  }),
  deltas: Object.freeze([
    Object.freeze({
      afterSummary: Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }),
    }),
  ]),
  projection: "correction-preview",
});
const CORRECTION_DATA = Object.freeze({
  correctionId:
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  allocation: Object.freeze({
    allocationId: ALLOCATION_ID,
    allocationVersion: 4,
    rankedOffers: Object.freeze([
      Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }),
    ]),
    winner: Object.freeze({
      totalValueCents: null,
      termYears: null,
      aavCents: null,
    }),
    restricted: Object.freeze({
      minimumTotalValueCents: null,
      minimumTermYears: null,
      minimumAavCents: null,
    }),
    fallback: Object.freeze({
      minimumTotalValueCents: null,
    }),
  }),
  appliedDeltas: Object.freeze([
    Object.freeze({
      afterSummary: Object.freeze({
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }),
    }),
  ]),
  activityId:
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  completedAtMs: 1_200_000,
});

function allowedRateResult() {
  return {
    allowed: true,
    code: "RATE_LIMIT_ALLOWED",
    retryAfterSeconds: 0,
  };
}

function codedError(code, options = {}) {
  return Object.assign(
    new Error(`synthetic ${code}`),
    { code, ...options }
  );
}

function authenticatedSession(id) {
  return Object.freeze({
    valid: true,
    session: Object.freeze({ id }),
  });
}

function boundary({
  requestSecurityOverrides = {},
  authenticated = AUTHENTICATED,
  limiterResult = allowedRateResult,
  rateLimiter: suppliedRateLimiter,
  retryResult = {
    data: {
      status: "accepted",
      retryReceiptId:
        "66666666-6666-4666-8666-666666666666",
    },
    httpStatus: 202,
  },
  recoveryActionResult = {
    data: RECOVERY_ACTION_DATA,
    httpStatus: 202,
    replayed: false,
  },
  correctionPreviewResult = CORRECTION_PREVIEW_DATA,
  correctionResult = {
    data: CORRECTION_DATA,
    httpStatus: 200,
    replayed: false,
  },
} = {}) {
  const calls = [];
  const rateCalls = [];
  const securityCalls = [];
  let nextError = null;
  const requestSecurity = {
    assignRequestId(request, _response, next) {
      request.requestId = "fad-router-request";
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
    authenticateBootstrap(_request, _response, next) {
      securityCalls.push("authenticateBootstrap");
      next();
    },
    authenticateUnsafe(_request, _response, next) {
      securityCalls.push("authenticateUnsafe");
      next();
    },
    requireJson(_request, _response, next) {
      next();
    },
    getRequestId(request) {
      return request.requestId;
    },
    getSessionBootstrap() {
      return authenticated;
    },
    getAuthenticatedSession() {
      return authenticated;
    },
    ...requestSecurityOverrides,
  };
  function invoke(name, input, result) {
    calls.push([name, input]);
    if (nextError) throw nextError;
    return result;
  }
  const freeAgentDraftReadService = {
    allocationResults(input) {
      return invoke("allocationResults", input, {
        data: [{ projection: "allocation-result" }],
        page: {
          nextCursor: "allocation-next",
          hasMore: true,
        },
      });
    },
    navigation(input) {
      return invoke("navigation", input, {
        projection: "navigation",
      });
    },
    readiness(input) {
      return invoke("readiness", input, {
        projection: "readiness",
      });
    },
    overview(input) {
      return invoke("overview", input, {
        projection: "overview",
      });
    },
    publishedCardHistory(input) {
      return invoke("publishedCardHistory", input, {
        projection: "published-card-history",
      });
    },
    publishedCardSummaries(input) {
      return invoke("publishedCardSummaries", input, {
        data: [{ projection: "published-card-summary" }],
        page: {
          nextCursor: "card-next",
          hasMore: true,
        },
      });
    },
  };
  const freeAgentDraftReadinessRetryService = {
    retry(input) {
      return invoke("retry", input, retryResult);
    },
  };
  const freeAgentDraftRecoveryReadService = {
    recovery(input) {
      return invoke("recovery", input, {
        projection: "recovery",
      });
    },
  };
  const freeAgentDraftRecoveryActionService = {
    accept(input) {
      return invoke(
        "acceptRecoveryAction",
        input,
        recoveryActionResult
      );
    },
  };
  const freeAgentDraftCorrectionPreviewService = {
    preview(input) {
      return invoke(
        "previewAllocationCorrection",
        input,
        correctionPreviewResult
      );
    },
  };
  const freeAgentDraftAllocationCorrectionService = {
    apply(input) {
      return invoke(
        "applyAllocationCorrection",
        input,
        correctionResult
      );
    },
  };
  const rateLimiter = {
    recordAttempt(input) {
      rateCalls.push(input);
      return suppliedRateLimiter
        ? suppliedRateLimiter.recordAttempt(input)
        : limiterResult(input, rateCalls.length);
    },
  };
  const router = createFreeAgentDraftRouter({
    requestSecurity,
    freeAgentDraftReadService,
    freeAgentDraftReadinessRetryService,
    freeAgentDraftRecoveryReadService,
    freeAgentDraftRecoveryActionService,
    freeAgentDraftCorrectionPreviewService,
    freeAgentDraftAllocationCorrectionService,
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

async function getJson(url, options) {
  const response = await fetch(url, options);
  return {
    body: await response.json(),
    cacheControl: response.headers.get(
      "cache-control"
    ),
    retryAfter: response.headers.get(
      "retry-after"
    ),
    status: response.status,
  };
}

function recoveryActionRequest(
  idempotencyKey,
  body = RECOVERY_ACTION_BODY,
  headers = {}
) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": idempotencyKey }),
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function correctionPreviewRequest(
  body = CORRECTION_PREVIEW_BODY,
  headers = {}
) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function correctionRequest(
  options = {},
  headers = {}
) {
  const ifMatch = Object.prototype.hasOwnProperty.call(
    options,
    "ifMatch"
  )
    ? options.ifMatch
    : '"3"';
  const idempotencyKey =
    Object.prototype.hasOwnProperty.call(
      options,
      "idempotencyKey"
    )
      ? options.idempotencyKey
      : "fad-correction-1";
  const body = Object.prototype.hasOwnProperty.call(
    options,
    "body"
  )
    ? options.body
    : CORRECTION_BODY;
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ifMatch === undefined
        ? {}
        : { "If-Match": ifMatch }),
      ...(idempotencyKey === undefined
        ? {}
        : { "Idempotency-Key": idempotencyKey }),
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function createOperationalRateLimiter() {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
  let nowMs = 0;
  let nextId = 0;
  const rows = new Map();

  function key(value) {
    return [
      value.action,
      value.keyVersion,
      value.bucketDigest,
      value.windowStartedAtMs,
    ].join("|");
  }

  function copy(value) {
    return value ? { ...value } : null;
  }

  const repository = {
    findWindow(input) {
      return copy(rows.get(key(input)));
    },
    recordAttempt(input) {
      const rowKey = key(input);
      const current = rows.get(rowKey);
      const currentCount =
        input.blockCounter === "failure_count"
          ? current?.failure_count || 0
          : current?.attempt_count || 0;
      if (
        current &&
        (
          current.blocked_until_ms > input.nowMs ||
          currentCount >= input.limit
        )
      ) {
        return {
          allowed: false,
          recorded: false,
          row: copy(current),
        };
      }
      const attemptCount =
        (current?.attempt_count || 0) + 1;
      const failureCount =
        (current?.failure_count || 0) +
        (input.failed ? 1 : 0);
      const relevantCount =
        input.blockCounter === "failure_count"
          ? failureCount
          : attemptCount;
      const row = {
        id: current?.id || input.id,
        action: input.action,
        key_version: input.keyVersion,
        bucket_digest: input.bucketDigest,
        window_started_at_ms:
          input.windowStartedAtMs,
        window_ends_at_ms: input.windowEndsAtMs,
        attempt_count: attemptCount,
        failure_count: failureCount,
        blocked_until_ms:
          relevantCount >= input.limit
            ? input.windowEndsAtMs
            : current?.blocked_until_ms || null,
        updated_at_ms: input.nowMs,
        version: (current?.version || 0) + 1,
      };
      rows.set(rowKey, row);
      return {
        allowed: true,
        recorded: true,
        row: copy(row),
      };
    },
    clearFailures() {
      throw new Error("not used by this test boundary");
    },
    cleanupExpired() {
      return 0;
    },
  };
  const limiter = createAuthenticationRateLimiter({
    repository,
    privacyDigest: {
      digest(value) {
        return { digest: value, keyVersion: 1 };
      },
    },
    clock: { nowMs: () => nowMs },
    secureRandom: {
      id() {
        nextId += 1;
        return `rate-window-${nextId}`;
      },
    },
  });
  return {
    limiter,
    advanceWindow() {
      nowMs += FIFTEEN_MINUTES_MS;
    },
  };
}

describe("FAD published-read HTTP boundary", () => {
  test("registers literal and published routes before the FAD identifier route", () => {
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
            "/api/v1/leagues/:leagueId/free-agent-drafts/navigation",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/readiness",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/readiness/retries",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery/actions",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/correction-previews",
        },
        {
          method: "POST",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/corrections",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/history",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/results",
        },
        {
          method: "GET",
          path:
            "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId",
        },
      ]
    );
  });

  test("returns exact private no-store envelopes for all three GET projections", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const requests = [
      {
        url:
          `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          "/free-agent-drafts/navigation",
        expectedCall: [
          "navigation",
          {
            leagueId: LEAGUE_ID,
            authenticated: AUTHENTICATED,
          },
        ],
        projection: "navigation",
      },
      {
        url:
          `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          "/free-agent-drafts/navigation" +
          `?rosterSeasonId=${SEASON_ID}` +
          `&rosterTeamId=${TEAM_ID}`,
        expectedCall: [
          "navigation",
          {
            leagueId: LEAGUE_ID,
            authenticated: AUTHENTICATED,
            rosterSeasonId: SEASON_ID,
            rosterTeamId: TEAM_ID,
          },
        ],
        projection: "navigation",
      },
      {
        url:
          `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          "/free-agent-drafts/readiness" +
          `?seasonId=${SEASON_ID}`,
        expectedCall: [
          "readiness",
          {
            leagueId: LEAGUE_ID,
            seasonId: SEASON_ID,
            authenticated: AUTHENTICATED,
          },
        ],
        projection: "readiness",
      },
      {
        url:
          `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}`,
        expectedCall: [
          "overview",
          {
            leagueId: LEAGUE_ID,
            fadId: FAD_ID,
            authenticated: AUTHENTICATED,
          },
        ],
        projection: "overview",
      },
    ];

    for (const request of requests) {
      const response = await getJson(request.url);
      assert.equal(response.status, 200);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.deepEqual(response.body, {
        data: { projection: request.projection },
        meta: { requestId: "fad-router-request" },
      });
      assert.deepEqual(
        context.calls.at(-1),
        request.expectedCall
      );
    }
  });

  test("returns the exact private no-store T-141 recovery envelope and service input", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery`
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body, {
      data: { projection: "recovery" },
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls, [
      [
        "recovery",
        {
          authenticated: AUTHENTICATED,
          fadId: FAD_ID,
          leagueId: LEAGUE_ID,
        },
      ],
    ]);
    assert.deepEqual(context.securityCalls, [
      "authenticateBootstrap",
    ]);
    assert.deepEqual(context.rateCalls, []);
  });

  test("returns the exact private no-store T-142 202 envelope after both operational limit records", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`,
      recoveryActionRequest("recover-deadline-2026")
    );

    assert.equal(response.status, 202);
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body, {
      data: RECOVERY_ACTION_DATA,
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls, [
      [
        "acceptRecoveryAction",
        {
          authenticated: AUTHENTICATED,
          fadId: FAD_ID,
          idempotencyKey: "recover-deadline-2026",
          input: RECOVERY_ACTION_BODY,
          leagueId: LEAGUE_ID,
        },
      ],
    ]);
    assert.deepEqual(context.rateCalls, [
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "session",
        canonicalIdentifier: SESSION_ID,
        failed: false,
      },
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "league",
        canonicalIdentifier: LEAGUE_ID,
        failed: false,
      },
    ]);
    assert.deepEqual(context.securityCalls, [
      "authenticateUnsafe",
    ]);
  });

  test("returns the exact synchronous private no-store T-143 preview without mutation headers or rate limits", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/allocations/` +
        `${ALLOCATION_ID}/correction-previews`,
      correctionPreviewRequest(
        CORRECTION_PREVIEW_BODY,
        {
          "If-Match": '"999"',
          "Idempotency-Key": "ignored-preview-key",
        }
      )
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body, {
      data: CORRECTION_PREVIEW_DATA,
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(
      [
        response.body.data.currentDecision.rankedOffers[0]
          .totalValueCents,
        response.body.data.currentDecision.winner.termYears,
        response.body.data.currentDecision.restricted
          .minimumAavCents,
        response.body.data.deltas[0].afterSummary.aavCents,
      ],
      [null, null, null, null]
    );
    assert.deepEqual(context.calls, [
      [
        "previewAllocationCorrection",
        {
          allocationId: ALLOCATION_ID,
          authenticated: AUTHENTICATED,
          fadId: FAD_ID,
          input: CORRECTION_PREVIEW_BODY,
          leagueId: LEAGUE_ID,
        },
      ],
    ]);
    assert.deepEqual(context.rateCalls, []);
    assert.deepEqual(context.securityCalls, [
      "authenticateUnsafe",
    ]);
  });

  test("awaits T-144, records both operational limits, and exposes result.data only for fresh and replayed results", async (t) => {
    let resolveCorrection;
    const pendingResult = new Promise((resolve) => {
      resolveCorrection = resolve;
    });
    const context = boundary({
      correctionResult: pendingResult,
    });
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/allocations/` +
      `${ALLOCATION_ID}/corrections`;
    let settled = false;
    const responsePromise = getJson(
      url,
      correctionRequest()
    ).then((response) => {
      settled = true;
      return response;
    });
    for (
      let attempt = 0;
      context.calls.length === 0 && attempt < 100;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(settled, false);
    assert.deepEqual(context.calls, [
      [
        "applyAllocationCorrection",
        {
          allocationId: ALLOCATION_ID,
          authenticated: AUTHENTICATED,
          expectedAllocationVersion: 3,
          fadId: FAD_ID,
          idempotencyKey: "fad-correction-1",
          input: CORRECTION_BODY,
          leagueId: LEAGUE_ID,
        },
      ],
    ]);
    resolveCorrection({
      data: CORRECTION_DATA,
      httpStatus: 200,
      replayed: false,
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body, {
      data: CORRECTION_DATA,
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(
      [
        response.body.data.allocation.rankedOffers[0]
          .totalValueCents,
        response.body.data.allocation.winner.termYears,
        response.body.data.allocation.restricted
          .minimumAavCents,
        response.body.data.allocation.fallback
          .minimumTotalValueCents,
        response.body.data.appliedDeltas[0].afterSummary
          .aavCents,
      ],
      [null, null, null, null, null]
    );
    assert.equal("replayed" in response.body, false);
    assert.equal("committedRoster" in response.body, false);
    assert.deepEqual(context.rateCalls, [
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "session",
        canonicalIdentifier: SESSION_ID,
        failed: false,
      },
      {
        action: FAD_OPERATIONAL_WRITE_ACTION,
        bucket: "league",
        canonicalIdentifier: LEAGUE_ID,
        failed: false,
      },
    ]);

    const replay = boundary({
      correctionResult: {
        data: CORRECTION_DATA,
        httpStatus: 200,
        replayed: true,
      },
    });
    const replayOrigin = await start(t, replay.router);
    const replayResponse = await getJson(
      `${replayOrigin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/allocations/` +
        `${ALLOCATION_ID}/corrections`,
      correctionRequest()
    );
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(replayResponse.body, {
      data: CORRECTION_DATA,
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(
      [
        replayResponse.body.data.allocation.winner
          .totalValueCents,
        replayResponse.body.data.appliedDeltas[0]
          .afterSummary.termYears,
      ],
      [null, null]
    );
    assert.equal("replayed" in replayResponse.body, false);
  });

  test("returns T-131, T-132, and T-140 with exact collection and resource envelopes", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const base =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}`;

    const summaries = await getJson(
      `${base}/candidate-cards?cursor=card-cursor&limit=7`
    );
    assert.equal(summaries.status, 200);
    assert.equal(
      summaries.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(summaries.body, {
      data: [{ projection: "published-card-summary" }],
      page: {
        nextCursor: "card-next",
        hasMore: true,
      },
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls.at(-1), [
      "publishedCardSummaries",
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        authenticated: AUTHENTICATED,
        query: { cursor: "card-cursor", limit: 7 },
      },
    ]);

    const history = await getJson(
      `${base}/candidate-cards/${TEAM_ID}/history`
    );
    assert.equal(history.status, 200);
    assert.equal(
      history.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(history.body, {
      data: { projection: "published-card-history" },
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls.at(-1), [
      "publishedCardHistory",
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        teamId: TEAM_ID,
        authenticated: AUTHENTICATED,
      },
    ]);

    const results = await getJson(
      `${base}/results?teamId=${TEAM_ID}` +
        "&q=%20ALEX%09Example%20" +
        "&status=signed&cursor=result-cursor&limit=9"
    );
    assert.equal(results.status, 200);
    assert.equal(
      results.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(results.body, {
      data: [{ projection: "allocation-result" }],
      page: {
        nextCursor: "allocation-next",
        hasMore: true,
      },
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls.at(-1), [
      "allocationResults",
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
        authenticated: AUTHENTICATED,
        query: {
          teamId: TEAM_ID,
          q: "alex example",
          status: "signed",
          cursor: "result-cursor",
          limit: 9,
        },
      },
    ]);
  });

  test("returns the immutable T-128 data under 202 and forwards exact headers", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        "/free-agent-drafts/readiness/retries",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
          "Idempotency-Key": "retry-fad-2026",
        },
        body: JSON.stringify(RETRY_BODY),
      }
    );

    assert.equal(response.status, 202);
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body, {
      data: {
        status: "accepted",
        retryReceiptId:
          "66666666-6666-4666-8666-666666666666",
      },
      meta: { requestId: "fad-router-request" },
    });
    assert.deepEqual(context.calls, [
      [
        "retry",
        {
          leagueId: LEAGUE_ID,
          input: RETRY_BODY,
          expectedVersion: 3,
          idempotencyKey: "retry-fad-2026",
          authenticated: AUTHENTICATED,
        },
      ],
    ]);
  });

  test("rejects unknown, partial, duplicate, and malformed query shapes before service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const base =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      "/free-agent-drafts";
    const urls = [
      `${base}/navigation?rosterSeasonId=${SEASON_ID}`,
      `${base}/navigation?unknown=${SEASON_ID}`,
      `${base}/navigation?rosterSeasonId=${SEASON_ID}` +
        `&rosterSeasonId=${SEASON_ID}` +
        `&rosterTeamId=${TEAM_ID}`,
      `${base}/navigation?rosterSeasonId=bad&rosterTeamId=${TEAM_ID}`,
      `${base}/readiness`,
      `${base}/readiness?seasonId=${SEASON_ID}&unknown=1`,
      `${base}/readiness?seasonId=${SEASON_ID}&seasonId=${SEASON_ID}`,
      `${base}/${FAD_ID}?unknown=1`,
      `${base}/${FAD_ID}/recovery?unknown=1`,
      `${base}/${FAD_ID}/candidate-cards?unknown=1`,
      `${base}/${FAD_ID}/candidate-cards?limit=0`,
      `${base}/${FAD_ID}/candidate-cards?limit=101`,
      `${base}/${FAD_ID}/candidate-cards?cursor=bad%2Bcursor`,
      `${base}/${FAD_ID}/candidate-cards?cursor=one&cursor=two`,
      `${base}/${FAD_ID}/candidate-cards/${TEAM_ID}/history?unknown=1`,
      `${base}/${FAD_ID}/results`,
      `${base}/${FAD_ID}/results?teamId=`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&teamId=${TEAM_ID}`,
      `${base}/${FAD_ID}/results?unknown=1`,
      `${base}/${FAD_ID}/results?teamId=bad`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&status=unknown`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&status=signed&status=tied`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&limit=0`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&limit=101`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&cursor=bad%2Bcursor`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&q=%00`,
      `${base}/${FAD_ID}/results?teamId=${TEAM_ID}&q=${"x".repeat(201)}`,
    ];

    for (const url of urls) {
      const response = await getJson(url);
      assert.equal(response.status, 400, url);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    assert.deepEqual(context.calls, []);
  });

  test("rejects missing or malformed retry preconditions and query before service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      "/free-agent-drafts/readiness/retries";
    for (const request of [
      {
        url,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "retry-fad-2026",
        },
      },
      {
        url,
        headers: {
          "Content-Type": "application/json",
          "If-Match": "3",
          "Idempotency-Key": "retry-fad-2026",
        },
      },
      {
        url: `${url}?unknown=1`,
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
          "Idempotency-Key": "retry-fad-2026",
        },
      },
      {
        url,
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
        },
      },
      {
        url,
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
          "Idempotency-Key": "",
        },
      },
      {
        url,
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
          "Idempotency-Key": "x".repeat(129),
        },
      },
    ]) {
      const response = await getJson(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(RETRY_BODY),
      });
      assert.equal(response.status, 400);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    assert.deepEqual(context.calls, []);
  });

  test("rejects T-142 query, idempotency, and forbidden If-Match headers before limiting or service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/recovery/actions`;
    for (const request of [
      {
        url: `${url}?unknown=1`,
        options: recoveryActionRequest("recover-query"),
      },
      {
        url,
        options: recoveryActionRequest(undefined),
      },
      {
        url,
        options: recoveryActionRequest(""),
      },
      {
        url,
        options: recoveryActionRequest("x".repeat(129)),
      },
      {
        url,
        options: recoveryActionRequest(
          "recover-with-if-match",
          RECOVERY_ACTION_BODY,
          { "If-Match": '"3"' }
        ),
      },
    ]) {
      const response = await getJson(
        request.url,
        request.options
      );
      assert.equal(response.status, 400);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    assert.deepEqual(context.rateCalls, []);
    assert.deepEqual(context.calls, []);
  });

  test("rejects T-143/T-144 query and T-144 mutation-header errors before limiting or service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const base =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/allocations/` +
      ALLOCATION_ID;
    const cases = [
      {
        url: `${base}/correction-previews?unknown=1`,
        options: correctionPreviewRequest(),
      },
      {
        url: `${base}/corrections?unknown=1`,
        options: correctionRequest(),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({ ifMatch: undefined }),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({ ifMatch: "3" }),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({ ifMatch: '"0"' }),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({
          idempotencyKey: undefined,
        }),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({ idempotencyKey: "" }),
      },
      {
        url: `${base}/corrections`,
        options: correctionRequest({
          idempotencyKey: "x".repeat(129),
        }),
      },
    ];
    for (const current of cases) {
      const response = await getJson(
        current.url,
        current.options
      );
      assert.equal(response.status, 400, current.url);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_INPUT_INVALID"
      );
    }
    assert.deepEqual(context.rateCalls, []);
    assert.deepEqual(context.calls, []);
  });

  test("owns the bounded T-128 JSON parser and rejects malformed or oversized bodies before service access", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      "/free-agent-drafts/readiness/retries";
    const headers = {
      "Content-Type": "application/json",
      "If-Match": '"3"',
      "Idempotency-Key": "retry-fad-2026",
    };

    const malformed = await getJson(url, {
      method: "POST",
      headers,
      body: '{"seasonId":',
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      malformed.body.error.code,
      "FREE_AGENT_DRAFT_INPUT_INVALID"
    );
    assert.equal(
      malformed.cacheControl,
      "private, no-store"
    );

    const oversized = await getJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...RETRY_BODY,
        padding: "x".repeat(17 * 1_024),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      oversized.body.error.code,
      "FREE_AGENT_DRAFT_REQUEST_TOO_LARGE"
    );
    assert.equal(
      oversized.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(context.calls, []);
  });

  test("owns the bounded strict T-142 JSON parser and rejects malformed or oversized bodies before limiting", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/recovery/actions`;
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "recover-json-boundary",
    };

    const malformed = await getJson(url, {
      method: "POST",
      headers,
      body: '{"action":',
    });
    assert.equal(malformed.status, 400);
    assert.equal(
      malformed.body.error.code,
      "FREE_AGENT_DRAFT_INPUT_INVALID"
    );
    assert.equal(
      malformed.cacheControl,
      "private, no-store"
    );

    const primitive = await getJson(url, {
      method: "POST",
      headers,
      body: "null",
    });
    assert.equal(primitive.status, 400);
    assert.equal(
      primitive.body.error.code,
      "FREE_AGENT_DRAFT_INPUT_INVALID"
    );

    const oversized = await getJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...RECOVERY_ACTION_BODY,
        padding: "x".repeat(17 * 1_024),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      oversized.body.error.code,
      "FREE_AGENT_DRAFT_REQUEST_TOO_LARGE"
    );
    assert.equal(
      oversized.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(context.rateCalls, []);
    assert.deepEqual(context.calls, []);
  });

  test("owns bounded strict JSON parsing for both correction endpoints before preview, limiting, or apply", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const base =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/allocations/` +
      ALLOCATION_ID;
    for (const suffix of [
      "correction-previews",
      "corrections",
    ]) {
      const headers = {
        "Content-Type": "application/json",
        ...(suffix === "corrections"
          ? {
              "If-Match": '"3"',
              "Idempotency-Key":
                "correction-json-boundary",
            }
          : {}),
      };
      for (const body of ['{"mode":', "null"]) {
        const response = await getJson(
          `${base}/${suffix}`,
          { method: "POST", headers, body }
        );
        assert.equal(response.status, 400, suffix);
        assert.equal(
          response.body.error.code,
          "FREE_AGENT_DRAFT_INPUT_INVALID"
        );
      }
      const oversized = await getJson(
        `${base}/${suffix}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            mode: "recompute_locked_snapshot",
            padding: "x".repeat(17 * 1_024),
          }),
        }
      );
      assert.equal(oversized.status, 413, suffix);
      assert.equal(
        oversized.body.error.code,
        "FREE_AGENT_DRAFT_REQUEST_TOO_LARGE"
      );
      assert.equal(
        oversized.cacheControl,
        "private, no-store"
      );
    }
    assert.deepEqual(context.rateCalls, []);
    assert.deepEqual(context.calls, []);
  });

  test("maps stable authorization, visibility, retry, precondition, and internal errors", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const url =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      "/free-agent-drafts/navigation";
    for (const expectation of [
      {
        sourceCode: "LEAGUE_COMMISSIONER_REQUIRED",
        status: 403,
        publicCode: "LEAGUE_COMMISSIONER_REQUIRED",
      },
      {
        sourceCode: "FAD_READ_AUTHORIZATION_DENIED",
        status: 404,
        publicCode: "LEAGUE_NOT_FOUND",
      },
      {
        sourceCode: "REPOSITORY_RECORD_NOT_FOUND",
        status: 404,
        publicCode: "FREE_AGENT_DRAFT_NOT_FOUND",
      },
      {
        sourceCode: "CANDIDATE_CARD_NOT_FOUND",
        status: 404,
        publicCode: "CANDIDATE_CARD_NOT_FOUND",
      },
      {
        sourceCode: "FAD_READINESS_NOT_READY",
        status: 409,
        publicCode: "FAD_READINESS_NOT_READY",
      },
      {
        sourceCode: "FAD_CARDS_NOT_PUBLISHED",
        status: 409,
        publicCode: "FAD_CARDS_NOT_PUBLISHED",
      },
      {
        sourceCode: "IDEMPOTENCY_KEY_REUSED",
        status: 409,
        publicCode: "IDEMPOTENCY_KEY_REUSED",
      },
      {
        sourceCode: "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        status: 409,
        publicCode: "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      },
      {
        sourceCode:
          "FAD_READINESS_PRECONDITION_FAILED",
        status: 412,
        publicCode:
          "FAD_READINESS_PRECONDITION_FAILED",
        sourceDetails: {
          currentVersion: 7,
          refetch: true,
          privateRecord: "must-not-leak",
        },
        publicDetails: {
          currentVersion: 7,
          refetch: true,
        },
      },
      {
        sourceCode: "UNEXPECTED",
        status: 500,
        publicCode:
          "FREE_AGENT_DRAFT_REQUEST_FAILED",
      },
    ]) {
      const error = new Error(expectation.sourceCode);
      error.code = expectation.sourceCode;
      error.details = expectation.sourceDetails;
      context.setError(error);
      const response = await getJson(url);
      assert.equal(response.status, expectation.status);
      assert.equal(
        response.body.error.code,
        expectation.publicCode
      );
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.deepEqual(
        response.body.error.details,
        expectation.publicDetails
      );
    }
  });

  test("maps T-141/T-142 authorization, validation, availability, and internal failures without leaking service details", async (t) => {
    const actionCases = [
      {
        body: {
          ...RECOVERY_ACTION_BODY,
          unknown: true,
        },
        error: codedError(
          "FAD_RECOVERY_INPUT_INVALID",
          { reasonCode: "body_fields_invalid" }
        ),
        status: 400,
        publicCode:
          "FREE_AGENT_DRAFT_INPUT_INVALID",
      },
      {
        body: {
          ...RECOVERY_ACTION_BODY,
          action: "recover_schedule",
        },
        error: codedError(
          "FAD_RECOVERY_INPUT_INVALID",
          { reasonCode: "action_invalid" }
        ),
        status: 422,
        publicCode: "FAD_RECOVERY_ACTION_INVALID",
      },
      {
        body: RECOVERY_ACTION_BODY,
        error: codedError("RECOVERY_NOT_AVAILABLE"),
        status: 422,
        publicCode: "FAD_RECOVERY_ACTION_INVALID",
      },
      {
        body: RECOVERY_ACTION_BODY,
        error: codedError("NOT_AUTHORIZED"),
        status: 403,
        publicCode: "LEAGUE_COMMISSIONER_REQUIRED",
      },
      {
        body: RECOVERY_ACTION_BODY,
        error: codedError(
          "FREE_AGENT_DRAFT_NOT_FOUND"
        ),
        status: 404,
        publicCode: "FREE_AGENT_DRAFT_NOT_FOUND",
      },
      {
        body: RECOVERY_ACTION_BODY,
        error: codedError(
          "FAD_RECOVERY_RESULT_INVALID"
        ),
        status: 500,
        publicCode:
          "FREE_AGENT_DRAFT_REQUEST_FAILED",
      },
    ];
    for (const [index, expectation] of
      actionCases.entries()) {
      const context = boundary();
      context.setError(expectation.error);
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}/recovery/actions`,
        recoveryActionRequest(
          `recovery-error-${index}`,
          expectation.body
        )
      );
      assert.equal(response.status, expectation.status);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.deepEqual(response.body.error, {
        code: expectation.publicCode,
        message: SAFE_MESSAGES[expectation.publicCode],
        requestId: "fad-router-request",
      });
      assert.equal(context.calls.length, 1);
      assert.deepEqual(
        context.calls[0][1].input,
        expectation.body
      );
      assert.equal(context.rateCalls.length, 2);
    }

    const readContext = boundary();
    readContext.setError(
      codedError(
        "FAD_RECOVERY_READ_AUTHORIZATION_DENIED"
      )
    );
    const readOrigin = await start(
      t,
      readContext.router
    );
    const readResponse = await getJson(
      `${readOrigin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery`
    );
    assert.equal(readResponse.status, 404);
    assert.deepEqual(readResponse.body.error, {
      code: "LEAGUE_NOT_FOUND",
      message: SAFE_MESSAGES.LEAGUE_NOT_FOUND,
      requestId: "fad-router-request",
    });
    assert.deepEqual(readContext.rateCalls, []);
  });

  test("maps T-143/T-144 input, authority, scope, applicability, replay, version, and internal failures safely", async (t) => {
    const context = boundary();
    const origin = await start(t, context.router);
    const base =
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/allocations/` +
      ALLOCATION_ID;
    const cases = [
      {
        endpoint: "correction-previews",
        options: correctionPreviewRequest(),
        error: codedError(
          "FAD_ALLOCATION_CORRECTION_INPUT_INVALID"
        ),
        status: 400,
        publicCode: "FREE_AGENT_DRAFT_INPUT_INVALID",
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError(
          "FAD_CORRECTION_AUTHORIZATION_DENIED"
        ),
        status: 403,
        publicCode: "LEAGUE_COMMISSIONER_REQUIRED",
      },
      {
        endpoint: "correction-previews",
        options: correctionPreviewRequest(),
        error: codedError("REPOSITORY_RECORD_NOT_FOUND"),
        status: 404,
        publicCode: "FREE_AGENT_DRAFT_NOT_FOUND",
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError(
          "FAD_CORRECTION_NOT_APPLICABLE"
        ),
        status: 409,
        publicCode: "FAD_CORRECTION_NOT_APPLICABLE",
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError("IDEMPOTENCY_KEY_REUSED"),
        status: 409,
        publicCode: "IDEMPOTENCY_KEY_REUSED",
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError("REPOSITORY_VERSION_CONFLICT", {
          details: {
            currentVersion: 7,
            refetch: true,
            privateEvidence: "must-not-leak",
          },
        }),
        status: 412,
        publicCode: "PRECONDITION_FAILED",
        publicDetails: {
          currentVersion: 7,
          refetch: true,
        },
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError("REPOSITORY_VERSION_CONFLICT", {
          details: {
            currentVersion: "private",
            refetch: true,
          },
        }),
        status: 412,
        publicCode: "PRECONDITION_FAILED",
      },
      {
        endpoint: "corrections",
        options: correctionRequest(),
        error: codedError("FAD_CORRECTION_RESULT_INVALID", {
          details: { sql: "must-not-leak" },
        }),
        status: 500,
        publicCode: "FREE_AGENT_DRAFT_REQUEST_FAILED",
      },
    ];
    for (const expectation of cases) {
      context.setError(expectation.error);
      const response = await getJson(
        `${base}/${expectation.endpoint}`,
        expectation.options
      );
      assert.equal(response.status, expectation.status);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.equal(
        response.body.error.code,
        expectation.publicCode
      );
      assert.deepEqual(
        response.body.error.details,
        expectation.publicDetails
      );
      assert.equal(
        JSON.stringify(response.body).includes("must-not-leak"),
        false
      );
    }
  });

  test("returns T-144 429 after both operational buckets when either bucket rejects without applying", async (t) => {
    const context = boundary({
      limiterResult(input) {
        return {
          allowed: input.bucket !== "league",
          code:
            input.bucket === "league"
              ? "RATE_LIMITED"
              : "RATE_LIMIT_ALLOWED",
          retryAfterSeconds:
            input.bucket === "league" ? 47 : 0,
        };
      },
    });
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/allocations/` +
        `${ALLOCATION_ID}/corrections`,
      correctionRequest()
    );

    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, "47");
    assert.equal(
      response.cacheControl,
      "private, no-store"
    );
    assert.deepEqual(response.body.error, {
      code: "RATE_LIMITED",
      message: SAFE_MESSAGES.RATE_LIMITED,
      requestId: "fad-router-request",
    });
    assert.deepEqual(
      context.rateCalls.map(({ bucket }) => bucket),
      ["session", "league"]
    );
    assert.deepEqual(context.calls, []);
  });

  test("records both operational rate families and returns 429 on either rejection without calling the action service", async (t) => {
    for (const scenario of [
      {
        blocked: { session: 31 },
        retryAfterSeconds: 31,
      },
      {
        blocked: { league: 47 },
        retryAfterSeconds: 47,
      },
      {
        blocked: { session: 19, league: 53 },
        retryAfterSeconds: 53,
      },
    ]) {
      const context = boundary({
        limiterResult(input) {
          const retryAfterSeconds =
            scenario.blocked[input.bucket];
          return retryAfterSeconds === undefined
            ? allowedRateResult()
            : {
                allowed: false,
                code: "RATE_LIMITED",
                retryAfterSeconds,
              };
        },
      });
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}/recovery/actions`,
        recoveryActionRequest(
          `blocked-${Object.keys(
            scenario.blocked
          ).join("-")}`
        )
      );
      assert.equal(response.status, 429);
      assert.equal(
        response.retryAfter,
        String(scenario.retryAfterSeconds)
      );
      assert.deepEqual(response.body.error, {
        code: "RATE_LIMITED",
        message: SAFE_MESSAGES.RATE_LIMITED,
        requestId: "fad-router-request",
      });
      assert.deepEqual(
        context.rateCalls.map((call) => [
          call.action,
          call.bucket,
          call.canonicalIdentifier,
          call.failed,
        ]),
        [
          [
            "fad_operational_write",
            "session",
            SESSION_ID,
            false,
          ],
          [
            "fad_operational_write",
            "league",
            LEAGUE_ID,
            false,
          ],
        ]
      );
      assert.deepEqual(context.calls, []);
    }
  });

  test("enforces the approved 30-per-session boundary, session isolation, and 15-minute reset", async (t) => {
    const operational =
      createOperationalRateLimiter();
    const first = boundary({
      rateLimiter: operational.limiter,
    });
    const firstOrigin = await start(t, first.router);
    const firstUrl =
      `${firstOrigin}/api/v1/leagues/${LEAGUE_ID}` +
      `/free-agent-drafts/${FAD_ID}/recovery/actions`;
    for (let index = 1; index <= 30; index += 1) {
      const response = await getJson(
        firstUrl,
        recoveryActionRequest(`session-a-${index}`)
      );
      assert.equal(response.status, 202);
    }
    const blocked = await getJson(
      firstUrl,
      recoveryActionRequest("session-a-blocked")
    );
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "900");
    assert.equal(first.calls.length, 30);

    const secondSession =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const second = boundary({
      authenticated:
        authenticatedSession(secondSession),
      rateLimiter: operational.limiter,
    });
    const secondOrigin = await start(t, second.router);
    const isolated = await getJson(
      `${secondOrigin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`,
      recoveryActionRequest("session-b-allowed")
    );
    assert.equal(isolated.status, 202);
    assert.equal(second.calls.length, 1);

    operational.advanceWindow();
    const reset = await getJson(
      firstUrl,
      recoveryActionRequest("session-a-reset")
    );
    assert.equal(reset.status, 202);
    assert.equal(first.calls.length, 31);
  });

  test("enforces the approved 120-per-league boundary while isolating leagues and resetting after 15 minutes", async (t) => {
    const operational =
      createOperationalRateLimiter();
    const sessionIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    ];
    for (const [sessionIndex, sessionId] of
      sessionIds.entries()) {
      const context = boundary({
        authenticated: authenticatedSession(sessionId),
        rateLimiter: operational.limiter,
      });
      const origin = await start(t, context.router);
      const url =
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`;
      for (let index = 1; index <= 30; index += 1) {
        const response = await getJson(
          url,
          recoveryActionRequest(
            `league-${sessionIndex}-${index}`
          )
        );
        assert.equal(response.status, 202);
      }
      assert.equal(context.calls.length, 30);
    }

    const fifth = boundary({
      authenticated: authenticatedSession(
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5"
      ),
      rateLimiter: operational.limiter,
    });
    const fifthOrigin = await start(t, fifth.router);
    const blocked = await getJson(
      `${fifthOrigin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`,
      recoveryActionRequest("league-blocked")
    );
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "900");
    assert.deepEqual(fifth.calls, []);

    const isolated = await getJson(
      `${fifthOrigin}/api/v1/leagues/${OTHER_LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`,
      recoveryActionRequest("other-league-allowed")
    );
    assert.equal(isolated.status, 202);
    assert.equal(fifth.calls.length, 1);

    operational.advanceWindow();
    const reset = await getJson(
      `${fifthOrigin}/api/v1/leagues/${LEAGUE_ID}` +
        `/free-agent-drafts/${FAD_ID}/recovery/actions`,
      recoveryActionRequest("league-reset")
    );
    assert.equal(reset.status, 202);
    assert.equal(fifth.calls.length, 2);
  });

  test("applies the private no-store policy before request-ID and authentication failures", async (t) => {
    for (const failure of [
      {
        status: 500,
        path:
          "/free-agent-drafts/navigation",
        overrides: {
          assignRequestId(
            _request,
            response
          ) {
            return response.status(500).json({
              error: {
                code: "REQUEST_ID_UNAVAILABLE",
              },
            });
          },
        },
      },
      {
        status: 401,
        path:
          `/free-agent-drafts/${FAD_ID}/recovery`,
        overrides: {
          authenticateBootstrap(
            _request,
            response
          ) {
            return response.status(401).json({
              error: { code: "SESSION_REQUIRED" },
            });
          },
        },
      },
      {
        status: 401,
        path:
          `/free-agent-drafts/${FAD_ID}/recovery/actions`,
        options: recoveryActionRequest(
          "recovery-authentication"
        ),
        overrides: {
          authenticateUnsafe(
            _request,
            response
          ) {
            return response.status(401).json({
              error: { code: "SESSION_REQUIRED" },
            });
          },
        },
      },
      {
        status: 415,
        path:
          `/free-agent-drafts/${FAD_ID}/recovery/actions`,
        options: {
          method: "POST",
          headers: {
            "Idempotency-Key":
              "recovery-content-type",
            "Content-Type": "text/plain",
          },
          body: JSON.stringify(
            RECOVERY_ACTION_BODY
          ),
        },
        overrides: {
          requireJson(
            _request,
            response
          ) {
            return response.status(415).json({
              error: {
                code: "CONTENT_TYPE_INVALID",
              },
            });
          },
        },
      },
      {
        status: 401,
        path:
          `/free-agent-drafts/${FAD_ID}/allocations/` +
          `${ALLOCATION_ID}/correction-previews`,
        options: correctionPreviewRequest(),
        overrides: {
          authenticateUnsafe(
            _request,
            response
          ) {
            return response.status(401).json({
              error: { code: "SESSION_REQUIRED" },
            });
          },
        },
      },
      {
        status: 415,
        path:
          `/free-agent-drafts/${FAD_ID}/allocations/` +
          `${ALLOCATION_ID}/corrections`,
        options: {
          ...correctionRequest(),
          headers: {
            "If-Match": '"3"',
            "Idempotency-Key": "correction-content-type",
            "Content-Type": "text/plain",
          },
        },
        overrides: {
          requireJson(
            _request,
            response
          ) {
            return response.status(415).json({
              error: {
                code: "CONTENT_TYPE_INVALID",
              },
            });
          },
        },
      },
    ]) {
      const context = boundary({
        requestSecurityOverrides:
          failure.overrides,
      });
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          failure.path,
        failure.options
      );
      assert.equal(response.status, failure.status);
      assert.equal(
        response.cacheControl,
        "private, no-store"
      );
      assert.deepEqual(context.calls, []);
      assert.deepEqual(context.rateCalls, []);
    }
  });

  test("fails closed when the readiness-retry service violates the fixed 202 result contract", async (t) => {
    const context = boundary({
      retryResult: {
        data: { status: "accepted" },
        httpStatus: 200,
      },
    });
    const origin = await start(t, context.router);
    const response = await getJson(
      `${origin}/api/v1/leagues/${LEAGUE_ID}` +
        "/free-agent-drafts/readiness/retries",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": '"3"',
          "Idempotency-Key": "retry-fad-2026",
        },
        body: JSON.stringify(RETRY_BODY),
      }
    );
    assert.equal(response.status, 500);
    assert.equal(
      response.body.error.code,
      "FREE_AGENT_DRAFT_REQUEST_FAILED"
    );
  });

  test("fails closed when the recovery-action service violates its exact 202 result contract", async (t) => {
    for (const recoveryActionResult of [
      {
        data: RECOVERY_ACTION_DATA,
        httpStatus: 200,
        replayed: false,
      },
      {
        data: RECOVERY_ACTION_DATA,
        httpStatus: 202,
      },
    ]) {
      const context = boundary({
        recoveryActionResult,
      });
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}/recovery/actions`,
        recoveryActionRequest(
          `invalid-recovery-result-${recoveryActionResult.httpStatus}`
        )
      );
      assert.equal(response.status, 500);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_REQUEST_FAILED"
      );
      assert.equal(context.calls.length, 1);
      assert.equal(context.rateCalls.length, 2);
    }
  });

  test("fails closed on asynchronous T-143 output or any non-exact T-144 service envelope", async (t) => {
    {
      const context = boundary({
        correctionPreviewResult: Promise.resolve(
          CORRECTION_PREVIEW_DATA
        ),
      });
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}/allocations/` +
          `${ALLOCATION_ID}/correction-previews`,
        correctionPreviewRequest()
      );
      assert.equal(response.status, 500);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_REQUEST_FAILED"
      );
    }

    for (const correctionResult of [
      {
        data: CORRECTION_DATA,
        httpStatus: 200,
        replayed: false,
        committedRoster: { teams: [] },
      },
      {
        data: CORRECTION_DATA,
        httpStatus: 201,
        replayed: false,
      },
      {
        data: CORRECTION_DATA,
        httpStatus: 200,
      },
    ]) {
      const context = boundary({ correctionResult });
      const origin = await start(t, context.router);
      const response = await getJson(
        `${origin}/api/v1/leagues/${LEAGUE_ID}` +
          `/free-agent-drafts/${FAD_ID}/allocations/` +
          `${ALLOCATION_ID}/corrections`,
        correctionRequest()
      );
      assert.equal(response.status, 500);
      assert.equal(
        response.body.error.code,
        "FREE_AGENT_DRAFT_REQUEST_FAILED"
      );
      assert.equal(
        JSON.stringify(response.body).includes(
          "committedRoster"
        ),
        false
      );
    }
  });

  test("requires the complete request, read, and retry dependency surfaces", () => {
    const requestSecurity = Object.fromEntries(
      [
        "assignRequestId",
        "authenticateBootstrap",
        "authenticateUnsafe",
        "credentialedCors",
        "getAuthenticatedSession",
        "getRequestId",
        "getSessionBootstrap",
        "requireAllowedOrigin",
        "requireCompatibleFetchMetadata",
        "requireJson",
        "securityHeaders",
      ].map((method) => [method, () => {}])
    );
    const dependencies = {
      requestSecurity,
      freeAgentDraftReadService: {
        allocationResults() {},
        navigation() {},
        overview() {},
        publishedCardHistory() {},
        publishedCardSummaries() {},
        readiness() {},
      },
      freeAgentDraftReadinessRetryService: {
        retry() {},
      },
      freeAgentDraftRecoveryReadService: {
        recovery() {},
      },
      freeAgentDraftRecoveryActionService: {
        accept() {},
      },
      freeAgentDraftCorrectionPreviewService: {
        preview() {},
      },
      freeAgentDraftAllocationCorrectionService: {
        apply() {},
      },
      rateLimiter: {
        recordAttempt() {},
      },
    };
    for (const [dependency, method] of [
      ["requestSecurity", "requireJson"],
      ["freeAgentDraftReadService", "overview"],
      [
        "freeAgentDraftReadinessRetryService",
        "retry",
      ],
      [
        "freeAgentDraftRecoveryReadService",
        "recovery",
      ],
      [
        "freeAgentDraftRecoveryActionService",
        "accept",
      ],
      [
        "freeAgentDraftCorrectionPreviewService",
        "preview",
      ],
      [
        "freeAgentDraftAllocationCorrectionService",
        "apply",
      ],
      ["rateLimiter", "recordAttempt"],
    ]) {
      const value = {
        ...dependencies,
        [dependency]: {
          ...dependencies[dependency],
        },
      };
      delete value[dependency][method];
      assert.throws(
        () => createFreeAgentDraftRouter(value),
        /FAD routes require/
      );
    }
  });
});
