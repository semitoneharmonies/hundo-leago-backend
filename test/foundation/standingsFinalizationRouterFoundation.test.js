const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  validateStandingsFinalizationExpectedVersion,
  validateStandingsFinalizationIdempotencyKey,
  validateStandingsFinalizationInput,
  validateStandingsFinalizationLeagueId,
  validateStandingsFinalizationSeasonId,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  createStandingsFinalizationRouter,
  SAFE_MESSAGES,
} = require(
  "../../src/transport/http/createStandingsFinalizationRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require(
  "../../src/transport/http/sessionCookie"
);

const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";
const LEAGUE_ID =
  "10000000-0000-4000-8000-000000000001";
const SEASON_ID =
  "10000000-0000-4000-8000-000000000002";
const USER_ID =
  "10000000-0000-4000-8000-000000000003";
const SESSION_ID =
  "10000000-0000-4000-8000-000000000004";
const OPERATION_ID =
  "10000000-0000-4000-8000-000000000005";
const SNAPSHOT_ID =
  "10000000-0000-4000-8000-000000000006";
const RAW_SESSION_TOKEN = Buffer.alloc(
  32,
  23
).toString("base64url");
const RAW_CSRF_TOKEN =
  "standings-finalization-csrf";
const REQUEST_ID =
  "fad-t145-http-request";
const NETWORK_SOURCE = "198.51.100.0/24";
const IDEMPOTENCY_KEY =
  "fad-standings-finalization-http-key";
const RESULT_SET_HASH = "a".repeat(64);

const AUTHENTICATED = Object.freeze({
  valid: true,
  user: Object.freeze({ id: USER_ID }),
  session: Object.freeze({ id: SESSION_ID }),
});

const INPUT = Object.freeze({
  resultSetHash: RESULT_SET_HASH,
  confirmation:
    "FINALIZE REGULAR SEASON STANDINGS",
});

const FINALIZED_RESULT = Object.freeze({
  code: "STANDINGS_FINALIZED",
  finalization: Object.freeze({
    operationId: OPERATION_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotVersion: 3,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    seasonVersion: 8,
    standingsRuleVersion:
      "standings-v1",
    resultSetHash: RESULT_SET_HASH,
    expectedMatchupCount: 44,
    includedResultCount: 44,
    participantCount: 12,
    finalizedAtMs: 1_900_000_000_000,
  }),
});

function serviceError(code, {
  details,
} = {}) {
  const error = new Error(
    "private repository and database detail"
  );
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function createServiceStub(calls, {
  implementation,
} = {}) {
  return {
    finalize(command) {
      calls.push(command);
      if (implementation) {
        return implementation(command);
      }
      return FINALIZED_RESULT;
    },
  };
}

function createHttpSecurity() {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin:
      PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const requestSecurity =
    createTargetRequestSecurity({
      isAllowedOrigin(origin) {
        return (
          origin === PUBLIC_FRONTEND_ORIGIN
        );
      },
      requestIdFactory() {
        return REQUEST_ID;
      },
      sessionCookie,
      sessionService: {
        bootstrap() {
          return {
            valid: false,
            code: "SESSION_INVALID",
          };
        },
        resolveWithCsrf({
          rawSessionToken,
          rawCsrfToken,
        }) {
          if (
            rawSessionToken !==
            RAW_SESSION_TOKEN
          ) {
            return {
              valid: false,
              code: "SESSION_INVALID",
            };
          }
          if (
            rawCsrfToken !== RAW_CSRF_TOKEN
          ) {
            return {
              valid: false,
              code: "CSRF_INVALID",
            };
          }
          return AUTHENTICATED;
        },
      },
    });
  return { requestSecurity, sessionCookie };
}

async function startApi(
  t,
  standingsFinalizationService,
  {
    digestCalls = [],
    networkSourceResolver = () =>
      NETWORK_SOURCE,
  } = {}
) {
  const { requestSecurity, sessionCookie } =
    createHttpSecurity();
  const app = express();
  app.use(
    createStandingsFinalizationRouter({
      requestSecurity,
      standingsFinalizationService,
      auditPrivacyDigest: {
        digest(value) {
          digestCalls.push(value);
          return {
            digest: "d".repeat(64),
            keyVersion: 7,
          };
        },
      },
      networkSourceResolver,
    })
  );
  const server = app.listen(
    0,
    "127.0.0.1"
  );
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
  return {
    baseUrl: `http://127.0.0.1:${
      server.address().port
    }`,
    sessionCookie,
  };
}

function browserHeaders(
  sessionCookie,
  {
    contentType = "application/json",
    csrfToken = RAW_CSRF_TOKEN,
    fetchDestination = "empty",
    fetchSite = "cross-site",
    idempotencyKey = IDEMPOTENCY_KEY,
    ifMatch = '"7"',
    includeContentType = true,
    includeCookie = true,
    includeIdempotencyKey = true,
    includeIfMatch = true,
    includeOrigin = true,
    origin = PUBLIC_FRONTEND_ORIGIN,
  } = {}
) {
  return {
    ...(includeOrigin
      ? { Origin: origin }
      : {}),
    ...(includeContentType
      ? { "Content-Type": contentType }
      : {}),
    "Sec-Fetch-Site": fetchSite,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": fetchDestination,
    "X-CSRF-Token": csrfToken,
    ...(includeIfMatch
      ? { "If-Match": ifMatch }
      : {}),
    ...(includeIdempotencyKey
      ? {
          "Idempotency-Key":
            idempotencyKey,
        }
      : {}),
    ...(includeCookie
      ? {
          Cookie: `${sessionCookie.name}=${RAW_SESSION_TOKEN}`,
        }
      : {}),
  };
}

function finalizationUrl(
  api,
  {
    leagueId = LEAGUE_ID,
    seasonId = SEASON_ID,
  } = {}
) {
  return new URL(
    `/api/v1/leagues/${leagueId}/seasons/${seasonId}/standings/finalizations`,
    api.baseUrl
  );
}

async function postFinalization(
  api,
  {
    body = JSON.stringify(INPUT),
    headers = browserHeaders(
      api.sessionCookie
    ),
    leagueId = LEAGUE_ID,
    method = "POST",
    seasonId = SEASON_ID,
  } = {}
) {
  return fetch(
    finalizationUrl(api, {
      leagueId,
      seasonId,
    }),
    {
      method,
      headers,
      ...(method === "POST"
        ? { body }
        : {}),
    }
  );
}

function validateCommand(command) {
  validateStandingsFinalizationLeagueId(
    command.leagueId
  );
  validateStandingsFinalizationSeasonId(
    command.seasonId
  );
  validateStandingsFinalizationExpectedVersion(
    command.expectedSeasonVersion
  );
  validateStandingsFinalizationIdempotencyKey(
    command.idempotencyKey
  );
  validateStandingsFinalizationInput(
    command.input
  );
  return FINALIZED_RESULT;
}

describe(
  "T-145 isolated standings-finalization HTTP contract",
  () => {
    test(
      "returns exact 201 no-store envelope and passes authenticated preconditions and privacy-safe audit context",
      async (t) => {
        const calls = [];
        const digestCalls = [];
        const api = await startApi(
          t,
          createServiceStub(calls),
          { digestCalls }
        );

        const response =
          await postFinalization(api);
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.equal(
          response.headers.get(
            "cache-control"
          ),
          "no-store"
        );
        assert.equal(
          response.headers.get(
            "access-control-allow-origin"
          ),
          PUBLIC_FRONTEND_ORIGIN
        );
        assert.equal(
          response.headers.get(
            "access-control-allow-credentials"
          ),
          "true"
        );
        assert.equal(
          response.headers.get("set-cookie"),
          null
        );
        assert.deepEqual(body, {
          data: FINALIZED_RESULT,
          meta: {
            requestId: REQUEST_ID,
          },
        });
        assert.deepEqual(calls, [
          {
            leagueId: LEAGUE_ID,
            seasonId: SEASON_ID,
            input: INPUT,
            expectedSeasonVersion: 7,
            idempotencyKey:
              IDEMPOTENCY_KEY,
            authenticated: AUTHENTICATED,
            auditContext: {
              clientMetadataJson:
                JSON.stringify({
                  networkSourceCategory:
                    "unknown",
                  origin:
                    PUBLIC_FRONTEND_ORIGIN,
                }),
              networkKeyVersion: 7,
              networkMetadataDigest:
                "d".repeat(64),
              requestCorrelationId:
                REQUEST_ID,
            },
          },
        ]);
        assert.deepEqual(digestCalls, [
          `network\0${NETWORK_SOURCE}`,
        ]);
      }
    );

    test(
      "rejects missing or malformed quoted positive If-Match before service access",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls)
        );
        const invalidIfMatches = [
          { includeIfMatch: false },
          { ifMatch: "7" },
          { ifMatch: '"0"' },
          { ifMatch: '"01"' },
          { ifMatch: '"-1"' },
          { ifMatch: 'W/"7"' },
          {
            ifMatch:
              '"9007199254740992"',
          },
        ];

        for (const options of invalidIfMatches) {
          const response =
            await postFinalization(api, {
              headers: browserHeaders(
                api.sessionCookie,
                options
              ),
            });
          const body = await response.json();
          assert.equal(
            response.status,
            400
          );
          assert.deepEqual(body, {
            error: {
              code:
                "STANDINGS_FINALIZATION_INPUT_INVALID",
              message:
                SAFE_MESSAGES
                  .STANDINGS_FINALIZATION_INPUT_INVALID,
              requestId: REQUEST_ID,
            },
          });
        }
        assert.equal(calls.length, 0);
      }
    );

    test(
      "maps malformed IDs, idempotency key, and exact body policy failures to the input error",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls, {
            implementation:
              validateCommand,
          })
        );
        const cases = [
          {
            leagueId: "not-a-league-id",
          },
          {
            seasonId: "not-a-season-id",
          },
          {
            headers: browserHeaders(
              api.sessionCookie,
              {
                includeIdempotencyKey:
                  false,
              }
            ),
          },
          {
            headers: browserHeaders(
              api.sessionCookie,
              {
                idempotencyKey:
                  "k".repeat(129),
              }
            ),
          },
          {
            body: JSON.stringify({
              ...INPUT,
              unknown: true,
            }),
          },
          {
            body: JSON.stringify({
              ...INPUT,
              resultSetHash:
                RESULT_SET_HASH.toUpperCase(),
            }),
          },
          {
            body: JSON.stringify({
              ...INPUT,
              confirmation:
                "FINALIZE STANDINGS",
            }),
          },
        ];

        for (const options of cases) {
          const response =
            await postFinalization(
              api,
              options
            );
          const body = await response.json();
          assert.equal(
            response.status,
            400
          );
          assert.equal(
            body.error.code,
            "STANDINGS_FINALIZATION_INPUT_INVALID"
          );
          assert.equal(
            body.error.message,
            SAFE_MESSAGES
              .STANDINGS_FINALIZATION_INPUT_INVALID
          );
          assert.equal(
            body.error.requestId,
            REQUEST_ID
          );
        }
        assert.equal(
          calls.length,
          cases.length
        );
      }
    );

    test(
      "rejects primitive, malformed, and oversized JSON before service access",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls)
        );
        const cases = [
          [
            "true",
            400,
            "STANDINGS_FINALIZATION_INPUT_INVALID",
          ],
          [
            "{",
            400,
            "STANDINGS_FINALIZATION_INPUT_INVALID",
          ],
          [
            JSON.stringify({
              padding: "x".repeat(1_100),
            }),
            413,
            "STANDINGS_FINALIZATION_REQUEST_TOO_LARGE",
          ],
        ];

        for (const [
          body,
          status,
          code,
        ] of cases) {
          const response =
            await postFinalization(api, {
              body,
            });
          const responseBody =
            await response.json();
          assert.equal(
            response.status,
            status,
            code
          );
          assert.deepEqual(responseBody, {
            error: {
              code,
              message:
                SAFE_MESSAGES[code],
              requestId: REQUEST_ID,
            },
          });
          assert.equal(
            response.headers.get(
              "cache-control"
            ),
            "no-store"
          );
        }
        assert.equal(calls.length, 0);
      }
    );

    test(
      "enforces session, CSRF, Origin, fetch metadata, and JSON content type before service access",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls)
        );
        const cases = [
          [
            { includeCookie: false },
            401,
            "SESSION_REQUIRED",
          ],
          [
            { csrfToken: "wrong-csrf" },
            403,
            "CSRF_INVALID",
          ],
          [
            {
              origin:
                "https://evil.example",
            },
            403,
            "ORIGIN_NOT_ALLOWED",
          ],
          [
            { includeOrigin: false },
            403,
            "ORIGIN_NOT_ALLOWED",
          ],
          [
            { fetchSite: "none" },
            403,
            "FETCH_METADATA_INVALID",
          ],
          [
            {
              fetchDestination:
                "document",
            },
            403,
            "FETCH_METADATA_INVALID",
          ],
          [
            { contentType: "text/plain" },
            415,
            "CONTENT_TYPE_INVALID",
          ],
          [
            {
              includeContentType: false,
            },
            415,
            "CONTENT_TYPE_INVALID",
          ],
        ];

        for (const [
          options,
          status,
          code,
        ] of cases) {
          const response =
            await postFinalization(api, {
              headers: browserHeaders(
                api.sessionCookie,
                options
              ),
            });
          const body = await response.json();
          assert.equal(
            response.status,
            status,
            code
          );
          assert.equal(
            body.error.code,
            code,
            code
          );
          assert.equal(
            body.error.requestId,
            REQUEST_ID,
            code
          );
          assert.equal(
            response.headers.get(
              "cache-control"
            ),
            "no-store",
            code
          );
        }
        assert.equal(calls.length, 0);
      }
    );

    test(
      "maps authority, privacy-safe missing resources, conflicts, stale state, and internal failures without private leakage",
      async (t) => {
        const calls = [];
        let nextError = null;
        const api = await startApi(
          t,
          createServiceStub(calls, {
            implementation() {
              throw nextError;
            },
          })
        );
        const cases = [
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            403,
            "LEAGUE_COMMISSIONER_REQUIRED",
          ],
          [
            "LEAGUE_NOT_FOUND",
            404,
            "STANDINGS_FINALIZATION_NOT_FOUND",
          ],
          [
            "SEASON_NOT_FOUND",
            404,
            "STANDINGS_FINALIZATION_NOT_FOUND",
          ],
          ...[
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
            "STANDINGS_ALREADY_FINALIZED",
            "STANDINGS_FINALIZATION_LEGACY_CONFLICT",
            "STANDINGS_FINALIZATION_NOT_READY",
            "STANDINGS_RESULT_SET_CHANGED",
          ].map((code) => [
            code,
            409,
            code,
          ]),
          [
            "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
            412,
            "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
          ],
          [
            "REPOSITORY_OPERATION_FAILED",
            500,
            "STANDINGS_FINALIZATION_REQUEST_FAILED",
          ],
        ];

        for (const [
          sourceCode,
          status,
          publicCode,
        ] of cases) {
          const safeDetails =
            sourceCode ===
            "STANDINGS_FINALIZATION_PRECONDITION_FAILED"
              ? {
                  currentVersion: 8,
                  refetch: true,
                }
              : undefined;
          nextError = serviceError(
            sourceCode,
            {
              details:
                safeDetails || {
                  privateSql:
                    "do not disclose",
                },
            }
          );
          const response =
            await postFinalization(api);
          const body = await response.json();

          assert.equal(
            response.status,
            status,
            sourceCode
          );
          assert.deepEqual(
            body,
            {
              error: {
                code: publicCode,
                message:
                  SAFE_MESSAGES[
                    publicCode
                  ],
                requestId: REQUEST_ID,
                ...(safeDetails
                  ? {
                      details:
                        safeDetails,
                    }
                  : {}),
              },
            },
            sourceCode
          );
          assert.equal(
            JSON.stringify(body).includes(
              "private"
            ),
            false,
            sourceCode
          );
          assert.equal(
            response.headers.get(
              "cache-control"
            ),
            "no-store",
            sourceCode
          );
        }
        assert.equal(
          calls.length,
          cases.length
        );
      }
    );

    test(
      "fails closed when privacy-safe network context is unavailable and exposes only the stable internal error",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls),
          {
            networkSourceResolver() {
              return " invalid ";
            },
          }
        );

        const response =
          await postFinalization(api);
        const body = await response.json();

        assert.equal(response.status, 500);
        assert.deepEqual(body, {
          error: {
            code:
              "STANDINGS_FINALIZATION_REQUEST_FAILED",
            message:
              SAFE_MESSAGES
                .STANDINGS_FINALIZATION_REQUEST_FAILED,
            requestId: REQUEST_ID,
          },
        });
        assert.equal(calls.length, 0);
      }
    );

    test(
      "exposes only the exact POST route",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls)
        );

        const response =
          await postFinalization(api, {
            method: "GET",
          });

        assert.equal(response.status, 404);
        assert.equal(calls.length, 0);
      }
    );
  }
);
