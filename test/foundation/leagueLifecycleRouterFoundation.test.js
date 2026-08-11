const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { describe, test } = require("node:test");

const {
  validateLeagueStartIdempotencyKey,
  validateLeagueStartInput,
} = require(
  "../../src/domain/leagues/leagueStartPolicy"
);
const {
  INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
  INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  validateLeagueLifecycleTransitionExpectedVersion,
  validateLeagueLifecycleTransitionIdempotencyKey,
  validateLeagueLifecycleTransitionInput,
} = require(
  "../../src/domain/leagues/leagueLifecycleTransitionPolicy"
);
const {
  createLeagueLifecycleRouter,
  SAFE_MESSAGES,
} = require(
  "../../src/transport/http/createLeagueLifecycleRouter"
);
const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const PUBLIC_FRONTEND_ORIGIN =
  "https://hundo.example";
const LEAGUE_ID =
  "10000000-0000-4000-8000-000000000001";
const USER_ID =
  "10000000-0000-4000-8000-000000000002";
const SESSION_ID =
  "10000000-0000-4000-8000-000000000003";
const SEASON_ID =
  "10000000-0000-4000-8000-000000000004";
const ENTRY_DRAFT_ID =
  "10000000-0000-4000-8000-000000000014";
const ROLLOVER_OCCURRENCE_ID =
  "10000000-0000-4000-8000-000000000015";
const RAW_SESSION_TOKEN = Buffer.alloc(
  32,
  17
).toString("base64url");
const RAW_CSRF_TOKEN = "league-start-csrf";
const REQUEST_ID = "fad-t036-http-request";
const NETWORK_SOURCE = "198.51.100.0/24";
const IDEMPOTENCY_KEY = "fad-start-http-key";
const TRADE_DEADLINE_AT_MS =
  1_900_000_000_000;
const TARGET_SEASON_ID =
  "10000000-0000-4000-8000-000000000005";
const ROLLOVER_ID =
  "10000000-0000-4000-8000-000000000006";
const LATE_LOCK_ID =
  "10000000-0000-4000-8000-000000000016";
const EXEMPTION_ID =
  "10000000-0000-4000-8000-000000000007";
const MIGRATION_REPORT_ID =
  "10000000-0000-4000-8000-000000000008";

const ROLLOVER_INPUT = Object.freeze({
  transitionType:
    RETRY_SCHEDULED_ENTRY_DRAFT_ROLLOVER,
  entryDraftId: ENTRY_DRAFT_ID,
  rolloverOccurrenceId:
    ROLLOVER_OCCURRENCE_ID,
});

const EXEMPTION_INPUT = Object.freeze({
  transitionType:
    INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
  seasonId: SEASON_ID,
  reason:
    "The Entry Draft feature is not available for this transition.",
  confirmation:
    INITIAL_SEASON2_NO_DRAFT_CONFIRMATION,
});

const AUTHENTICATED = Object.freeze({
  valid: true,
  user: Object.freeze({ id: USER_ID }),
  session: Object.freeze({ id: SESSION_ID }),
});

const STARTED_RESULT = Object.freeze({
  code: "LEAGUE_STARTED",
  league: Object.freeze({
    id: LEAGUE_ID,
    name: "Hundo Test League",
    status: "active",
    timezone: "America/Vancouver",
    version: 8,
    currentSeason: Object.freeze({
      id: SEASON_ID,
      label: "Season 2",
      nhlSeasonKey: "20262027",
      status: "active",
      version: 2,
    }),
  }),
  activatedTeamCount: 4,
  startedAtMs: 1_800_000_000_000,
});

const TRADE_DEADLINE_RESULT = Object.freeze({
  code: "LEAGUE_TRADE_DEADLINE_RECORDED",
  league: Object.freeze({
    id: LEAGUE_ID,
    status: "setup",
    timezone: "America/Vancouver",
    version: 8,
  }),
  settings: Object.freeze({
    tradeDeadlineAtMs:
      TRADE_DEADLINE_AT_MS,
    version: 2,
  }),
  recordedAtMs: 1_800_000_000_000,
});

const ROLLOVER_RESULT = Object.freeze({
  rolloverId: ROLLOVER_ID,
  leagueId: LEAGUE_ID,
  fromSeasonId: SEASON_ID,
  toSeasonId: TARGET_SEASON_ID,
  fromSeasonStatus: "completed",
  toSeasonStatus: "active",
  targetNhlSeasonKey: "20272028",
  nhlRegularSeasonStartsAtMs:
    1_822_694_400_000,
  nhlRegularSeasonEndsAtMs:
    1_839_567_600_000,
  fantasyPlayoffsStartAtMs:
    1_837_148_400_000,
  fantasyPlayoffsEndAtMs:
    1_839_567_600_000,
  sourceFadId:
    "10000000-0000-4000-8000-000000000009",
  sourceFinalizationRootId:
    "10000000-0000-4000-8000-000000000010",
  sourceFinalizationId:
    "10000000-0000-4000-8000-000000000011",
  sourceStandingsSnapshotId:
    "10000000-0000-4000-8000-000000000012",
  sourceStandingsOperationId:
    "10000000-0000-4000-8000-000000000013",
  sourceReadinessSchemaVersion: 1,
  sourceReadinessSha256: "a".repeat(64),
  targetSeasonCreated: true,
  leagueVersion: 9,
  fromSeasonVersion: 8,
  toSeasonVersion: 1,
  completedAtMs: 1_839_567_600_000,
  authorizedByUserId: USER_ID,
  authorizedAuthority: "commissioner",
  summary: Object.freeze({
    contractsAdvanced: 8,
    contractsExpired: 4,
    ownershipsCarried: 8,
    ownershipsReleased: 4,
    retentionYearsAdvanced: 2,
    retentionObligationsCompleted: 1,
    buyoutYearsAdvanced: 1,
    buyoutObligationsCompleted: 1,
    tradesCancelled: 0,
  }),
  lateLock: Object.freeze({
    status: "completed",
    lockId: LATE_LOCK_ID,
  }),
  version: 1,
});

const EXEMPTION_RESULT = Object.freeze({
  exemptionId: EXEMPTION_ID,
  leagueId: LEAGUE_ID,
  seasonId: SEASON_ID,
  exemptionKind:
    "initial_season2_transition",
  reason: EXEMPTION_INPUT.reason,
  authorizedByUserId: USER_ID,
  authorizedAuthority:
    "platform_administrator_as_commissioner",
  authorizedAtMs: 1_800_000_000_000,
  consumed: false,
  migrationReportId: MIGRATION_REPORT_ID,
  version: 1,
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
    start(command) {
      calls.push(command);
      if (implementation) {
        return implementation(command);
      }
      return STARTED_RESULT;
    },
  };
}

function createTradeDeadlineServiceStub(
  calls,
  { implementation } = {}
) {
  return {
    record(command) {
      calls.push(command);
      if (implementation) {
        return implementation(command);
      }
      return TRADE_DEADLINE_RESULT;
    },
  };
}

function createLifecycleTransitionServiceStub(
  calls,
  { implementation } = {}
) {
  return {
    transition(command) {
      calls.push(command);
      if (implementation) {
        return implementation(command);
      }
      return command.input.transitionType ===
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE
        ? EXEMPTION_RESULT
        : ROLLOVER_RESULT;
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
  leagueStartService,
  {
    digestCalls = [],
    leagueLifecycleTransitionService = {
      transition() {
        throw new Error(
          "The lifecycle-transition route is outside this test."
        );
      },
    },
    leagueTradeDeadlineService = {
      record() {
        throw new Error(
          "The trade-deadline route is outside this test."
        );
      },
    },
    networkSourceResolver = () =>
      NETWORK_SOURCE,
  } = {}
) {
  const { requestSecurity, sessionCookie } =
    createHttpSecurity();
  const app = express();
  app.use(
    createLeagueLifecycleRouter({
      requestSecurity,
      leagueLifecycleTransitionService,
      leagueTradeDeadlineService,
      leagueStartService,
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
    fetchMode = "cors",
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
    "Sec-Fetch-Mode": fetchMode,
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

function startUrl(api) {
  return new URL(
    `/api/v1/leagues/${LEAGUE_ID}/start`,
    api.baseUrl
  );
}

function tradeDeadlineUrl(api) {
  return new URL(
    `/api/v1/leagues/${LEAGUE_ID}/setup/trade-deadline`,
    api.baseUrl
  );
}

function lifecycleTransitionUrl(api) {
  return new URL(
    `/api/v1/leagues/${LEAGUE_ID}/lifecycle-transitions`,
    api.baseUrl
  );
}

async function postStart(
  api,
  {
    body = "{}",
    headers = browserHeaders(
      api.sessionCookie
    ),
  } = {}
) {
  return fetch(startUrl(api), {
    method: "POST",
    headers,
    body,
  });
}

async function putTradeDeadline(
  api,
  {
    body = JSON.stringify({
      tradeDeadlineAtMs:
        TRADE_DEADLINE_AT_MS,
    }),
    headers = browserHeaders(
      api.sessionCookie
    ),
  } = {}
) {
  return fetch(tradeDeadlineUrl(api), {
    method: "PUT",
    headers,
    body,
  });
}

async function postLifecycleTransition(
  api,
  options = {}
) {
  const input =
    options.input ?? ROLLOVER_INPUT;
  const body =
    options.body ?? JSON.stringify(input);
  const headers =
    options.headers ??
    browserHeaders(api.sessionCookie, {
      includeIfMatch:
        input.transitionType !==
        INITIAL_SEASON2_NO_DRAFT_TRANSITION_TYPE,
    });
  return fetch(lifecycleTransitionUrl(api), {
    method: "POST",
    headers,
    body,
  });
}

async function rawPostStart(
  api,
  {
    body = "{}",
    headers = browserHeaders(
      api.sessionCookie
    ),
  } = {}
) {
  const url = startUrl(api);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const rawBody = Buffer.concat(
            chunks
          ).toString("utf8");
          resolve({
            status: response.statusCode,
            headers: {
              get(name) {
                const value =
                  response.headers[
                    name.toLowerCase()
                  ];
                return Array.isArray(value)
                  ? value.join(", ")
                  : value ?? null;
              },
            },
            async json() {
              return JSON.parse(rawBody);
            },
          });
        });
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe(
  "T-036 isolated league-lifecycle HTTP contract",
  () => {
    test(
      "returns the exact safe success envelope and passes authenticated preconditions and audit context",
      async (t) => {
        const calls = [];
        const digestCalls = [];
        const replayedResult = {
          ...STARTED_RESULT,
        };
        Object.defineProperty(
          replayedResult,
          "replayed",
          {
            enumerable: false,
            value: true,
          }
        );
        const api = await startApi(
          t,
          createServiceStub(calls, {
            implementation() {
              return replayedResult;
            },
          }),
          { digestCalls }
        );

        const response = await postStart(api);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("cache-control"),
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
          data: STARTED_RESULT,
          meta: {
            requestId: REQUEST_ID,
          },
        });
        assert.equal(
          JSON.stringify(body).includes(
            "replayed"
          ),
          false
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
          leagueId: LEAGUE_ID,
          input: {},
          expectedLeagueVersion: 7,
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
        });
        assert.deepEqual(digestCalls, [
          `network\0${NETWORK_SOURCE}`,
        ]);
      }
    );

    test(
      "rejects missing or malformed If-Match before service access and rejects missing or malformed idempotency keys in the service policy",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls, {
            implementation(command) {
              validateLeagueStartInput(
                command.input
              );
              validateLeagueStartIdempotencyKey(
                command.idempotencyKey
              );
              return STARTED_RESULT;
            },
          })
        );
        const invalidIfMatches = [
          { includeIfMatch: false },
          { ifMatch: "7" },
          { ifMatch: '"0"' },
          { ifMatch: '"01"' },
          { ifMatch: '"-1"' },
          {
            ifMatch:
              '"9007199254740992"',
          },
        ];

        for (const options of invalidIfMatches) {
          const response = await postStart(
            api,
            {
              headers: browserHeaders(
                api.sessionCookie,
                options
              ),
            }
          );
          const body = await response.json();
          assert.equal(response.status, 400);
          assert.equal(
            body.error.code,
            "LEAGUE_START_INPUT_INVALID"
          );
        }
        assert.equal(calls.length, 0);

        const missingKey = await postStart(
          api,
          {
            headers: browserHeaders(
              api.sessionCookie,
              {
                includeIdempotencyKey:
                  false,
              }
            ),
          }
        );
        const tooLongKey = await postStart(
          api,
          {
            headers: browserHeaders(
              api.sessionCookie,
              {
                idempotencyKey:
                  "k".repeat(129),
              }
            ),
          }
        );
        assert.equal(missingKey.status, 400);
        assert.equal(tooLongKey.status, 400);
        assert.equal(calls.length, 2);
      }
    );

    test(
      "rejects nonempty, primitive, malformed, and oversized JSON without admitting parser failures to the service",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls, {
            implementation(command) {
              validateLeagueStartInput(
                command.input
              );
              return STARTED_RESULT;
            },
          })
        );

        const nonempty = await postStart(
          api,
          {
            body: JSON.stringify({
              force: true,
            }),
          }
        );
        assert.equal(nonempty.status, 400);
        assert.equal(
          (await nonempty.json()).error.code,
          "LEAGUE_START_INPUT_INVALID"
        );
        assert.equal(calls.length, 1);

        const primitive = await postStart(
          api,
          { body: "true" }
        );
        assert.equal(primitive.status, 400);
        assert.equal(
          (await primitive.json()).error.code,
          "LEAGUE_START_INPUT_INVALID"
        );
        assert.equal(calls.length, 1);

        const malformed = await postStart(
          api,
          { body: "{" }
        );
        assert.equal(malformed.status, 400);
        assert.equal(
          (await malformed.json()).error.code,
          "LEAGUE_START_INPUT_INVALID"
        );
        assert.equal(calls.length, 1);

        const oversized = await postStart(
          api,
          {
            body: JSON.stringify({
              padding: "x".repeat(1_100),
            }),
          }
        );
        assert.equal(oversized.status, 413);
        assert.equal(
          (await oversized.json()).error.code,
          "LEAGUE_START_TOO_LARGE"
        );
        assert.equal(calls.length, 1);
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
            {
              includeCookie: false,
            },
            401,
            "SESSION_REQUIRED",
          ],
          [
            {
              csrfToken: "wrong-csrf",
            },
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
            {
              includeOrigin: false,
            },
            403,
            "ORIGIN_NOT_ALLOWED",
          ],
          [
            {
              fetchSite: "none",
            },
            403,
            "FETCH_METADATA_INVALID",
          ],
          [
            {
              fetchMode: "navigate",
            },
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
            {
              contentType: "text/plain",
            },
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
          expectedStatus,
          expectedCode,
        ] of cases) {
          const send =
            options.fetchMode ===
            "navigate"
              ? rawPostStart
              : postStart;
          const response = await send(api, {
            headers: browserHeaders(
              api.sessionCookie,
              options
            ),
          });
          const body = await response.json();
          assert.equal(
            response.status,
            expectedStatus,
            `${expectedCode} ${JSON.stringify(
              options
            )}`
          );
          assert.equal(
            body.error.code,
            expectedCode
          );
          assert.equal(
            body.error.requestId,
            REQUEST_ID
          );
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
      "maps authority, missing, conflict, stale, readiness, and internal failures to safe public errors",
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
            "LEAGUE_NOT_FOUND",
          ],
          ...[
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
            "LEAGUE_START_INVITATION_STATE_INVALID",
            "LEAGUE_START_NOT_ALLOWED",
            "LEAGUE_START_RESULT_UNAVAILABLE",
            "LEAGUE_START_SEASON_INVALID",
            "LEAGUE_START_TEAM_STATE_INVALID",
          ].map((code) => [
            code,
            409,
            code,
          ]),
          [
            "LEAGUE_START_PRECONDITION_FAILED",
            412,
            "LEAGUE_START_PRECONDITION_FAILED",
          ],
          ...[
            "LEAGUE_START_INVITATIONS_PENDING",
            "LEAGUE_START_MINIMUM_TEAMS_REQUIRED",
            "LEAGUE_START_SETTINGS_INVALID",
            "LEAGUE_START_TEAM_MANAGER_REQUIRED",
          ].map((code) => [
            code,
            422,
            code,
          ]),
          [
            "REPOSITORY_OPERATION_FAILED",
            500,
            "LEAGUE_START_REQUEST_FAILED",
          ],
        ];

        for (const [
          sourceCode,
          expectedStatus,
          publicCode,
        ] of cases) {
          const safeDetails =
            sourceCode ===
            "LEAGUE_START_PRECONDITION_FAILED"
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
            await postStart(api);
          const body = await response.json();

          assert.equal(
            response.status,
            expectedStatus,
            sourceCode
          );
          assert.deepEqual(
            body,
            {
              error: {
                code: publicCode,
                message:
                  SAFE_MESSAGES[publicCode],
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
  }
);

describe(
  "T-035 isolated setup trade-deadline HTTP contract",
  () => {
    test("returns the exact safe success envelope and passes authenticated command and audit context", async (t) => {
      const calls = [];
      const digestCalls = [];
      const api = await startApi(
        t,
        createServiceStub([]),
        {
          digestCalls,
          leagueTradeDeadlineService:
            createTradeDeadlineServiceStub(
              calls
            ),
        }
      );

      const response =
        await putTradeDeadline(api);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "no-store"
      );
      assert.deepEqual(body, {
        data: TRADE_DEADLINE_RESULT,
        meta: { requestId: REQUEST_ID },
      });
      assert.equal(
        JSON.stringify(body).includes(
          "replayed"
        ),
        false
      );
      assert.deepEqual(calls, [
        {
          leagueId: LEAGUE_ID,
          input: {
            tradeDeadlineAtMs:
              TRADE_DEADLINE_AT_MS,
          },
          expectedLeagueVersion: 7,
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
    });

    test("rejects malformed version, browser security, malformed JSON, and oversized JSON before service access", async (t) => {
      const calls = [];
      const api = await startApi(
        t,
        createServiceStub([]),
        {
          leagueTradeDeadlineService:
            createTradeDeadlineServiceStub(
              calls
            ),
        }
      );

      const cases = [
        {
          headers: browserHeaders(
            api.sessionCookie,
            { includeIfMatch: false }
          ),
          expectedStatus: 400,
          expectedCode:
            "LEAGUE_TRADE_DEADLINE_INPUT_INVALID",
        },
        {
          headers: browserHeaders(
            api.sessionCookie,
            { ifMatch: "7" }
          ),
          expectedStatus: 400,
          expectedCode:
            "LEAGUE_TRADE_DEADLINE_INPUT_INVALID",
        },
        {
          headers: browserHeaders(
            api.sessionCookie,
            { csrfToken: "wrong" }
          ),
          expectedStatus: 403,
          expectedCode: "CSRF_INVALID",
        },
        {
          body: "{",
          expectedStatus: 400,
          expectedCode:
            "LEAGUE_TRADE_DEADLINE_INPUT_INVALID",
        },
        {
          body: JSON.stringify({
            tradeDeadlineAtMs:
              TRADE_DEADLINE_AT_MS,
            padding: "x".repeat(2_000),
          }),
          expectedStatus: 413,
          expectedCode:
            "LEAGUE_TRADE_DEADLINE_TOO_LARGE",
        },
      ];
      for (const item of cases) {
        const response =
          await putTradeDeadline(
            api,
            item
          );
        const body = await response.json();
        assert.equal(
          response.status,
          item.expectedStatus,
          item.expectedCode
        );
        assert.equal(
          body.error.code,
          item.expectedCode,
          item.expectedCode
        );
      }
      assert.equal(calls.length, 0);
    });

    test("maps authority, visibility, conflict, stale, temporal, and internal failures without private leakage", async (t) => {
      let nextError = null;
      const calls = [];
      const api = await startApi(
        t,
        createServiceStub([]),
        {
          leagueTradeDeadlineService:
            createTradeDeadlineServiceStub(
              calls,
              {
                implementation() {
                  throw nextError;
                },
              }
            ),
        }
      );
      const cases = [
        [
          "LEAGUE_COMMISSIONER_REQUIRED",
          403,
        ],
        ["LEAGUE_NOT_FOUND", 404],
        ["IDEMPOTENCY_KEY_REUSED", 409],
        [
          "IDEMPOTENCY_REQUEST_UNAVAILABLE",
          409,
        ],
        [
          "LEAGUE_TRADE_DEADLINE_NOT_ALLOWED",
          409,
        ],
        [
          "LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE",
          409,
        ],
        [
          "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED",
          412,
        ],
        [
          "LEAGUE_TRADE_DEADLINE_NOT_FUTURE",
          422,
        ],
        [
          "LEAGUE_TRADE_DEADLINE_SETTINGS_INVALID",
          409,
        ],
        [
          "REPOSITORY_OPERATION_FAILED",
          500,
          "LEAGUE_TRADE_DEADLINE_REQUEST_FAILED",
        ],
      ];
      for (const [
        sourceCode,
        status,
        mappedCode = sourceCode,
      ] of cases) {
        const safeDetails =
          sourceCode ===
          "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED"
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
          await putTradeDeadline(api);
        const body = await response.json();
        assert.equal(
          response.status,
          status,
          sourceCode
        );
        assert.equal(
          body.error.code,
          mappedCode,
          sourceCode
        );
        assert.equal(
          body.error.message,
          SAFE_MESSAGES[mappedCode],
          sourceCode
        );
        assert.deepEqual(
          body.error.details,
          safeDetails,
          sourceCode
        );
        assert.equal(
          JSON.stringify(body).includes(
            "private"
          ),
          false,
          sourceCode
        );
      }
      assert.equal(
        calls.length,
        cases.length
      );
    });
  }
);

describe(
  "T-037 isolated lifecycle-transition HTTP contract",
  () => {
    test(
      "awaits and returns the exact 202 retry resource with late-lock outcome for fresh acceptance and replay",
      async (t) => {
        const calls = [];
        const digestCalls = [];
        let invocation = 0;
        const replayedResult = {
          ...ROLLOVER_RESULT,
        };
        Object.defineProperty(
          replayedResult,
          "replayed",
          {
            enumerable: false,
            value: true,
          }
        );
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            digestCalls,
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls,
                {
                  async implementation() {
                    invocation += 1;
                    return invocation === 1
                      ? ROLLOVER_RESULT
                      : replayedResult;
                  },
                }
              ),
          }
        );

        for (let index = 0; index < 2; index += 1) {
          const response =
            await postLifecycleTransition(api);
          const body = await response.json();

          assert.equal(response.status, 202);
          assert.equal(
            response.headers.get(
              "cache-control"
            ),
            "no-store"
          );
          assert.deepEqual(body, {
            data: ROLLOVER_RESULT,
            meta: {
              requestId: REQUEST_ID,
            },
          });
          assert.equal(
            JSON.stringify(body).includes(
              "replayed"
            ),
            false
          );
        }

        const expectedCommand = {
          leagueId: LEAGUE_ID,
          input: ROLLOVER_INPUT,
          expectedDraftVersion: 7,
          idempotencyKey: IDEMPOTENCY_KEY,
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
        };
        assert.deepEqual(calls, [
          expectedCommand,
          expectedCommand,
        ]);
        assert.deepEqual(digestCalls, [
          `network\0${NETWORK_SOURCE}`,
          `network\0${NETWORK_SOURCE}`,
        ]);
      }
    );

    test(
      "forbids If-Match for the initial Season 2 exemption and otherwise passes an explicit absent precondition",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls
              ),
          }
        );

        const response =
          await postLifecycleTransition(api, {
            input: EXEMPTION_INPUT,
          });
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.deepEqual(body, {
          data: EXEMPTION_RESULT,
          meta: {
            requestId: REQUEST_ID,
          },
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(
          {
            leagueId: calls[0].leagueId,
            input: calls[0].input,
            expectedDraftVersion:
              calls[0].expectedDraftVersion,
            idempotencyKey:
              calls[0].idempotencyKey,
            authenticated:
              calls[0].authenticated,
          },
          {
            leagueId: LEAGUE_ID,
            input: EXEMPTION_INPUT,
            expectedDraftVersion: null,
            idempotencyKey:
              IDEMPOTENCY_KEY,
            authenticated: AUTHENTICATED,
          }
        );
      }
    );

    test(
      "enforces discriminator-specific If-Match rules before service access and delegates Idempotency-Key validation to the service policy",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls,
                {
                  implementation(command) {
                    const input =
                      validateLeagueLifecycleTransitionInput(
                        command.input
                      );
                    validateLeagueLifecycleTransitionExpectedVersion(
                      command.expectedDraftVersion,
                      input.transitionType
                    );
                    validateLeagueLifecycleTransitionIdempotencyKey(
                      command.idempotencyKey
                    );
                    return ROLLOVER_RESULT;
                  },
                }
              ),
          }
        );

        for (const headerOptions of [
          { includeIfMatch: false },
          { ifMatch: "7" },
          { ifMatch: '"0"' },
          { ifMatch: '"01"' },
          { ifMatch: '"-1"' },
          {
            ifMatch:
              '"9007199254740992"',
          },
        ]) {
          const response =
            await postLifecycleTransition(
              api,
              {
                headers: browserHeaders(
                  api.sessionCookie,
                  headerOptions
                ),
              }
            );
          assert.equal(
            response.status,
            400
          );
          assert.equal(
            (await response.json()).error.code,
            "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
          );
        }

        const forbiddenIfMatch =
          await postLifecycleTransition(api, {
            input: EXEMPTION_INPUT,
            headers: browserHeaders(
              api.sessionCookie
            ),
          });
        assert.equal(
          forbiddenIfMatch.status,
          400
        );
        assert.equal(
          (await forbiddenIfMatch.json())
            .error.code,
          "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
        );
        assert.equal(calls.length, 0);

        for (const headerOptions of [
          {
            includeIdempotencyKey: false,
          },
          {
            idempotencyKey:
              "k".repeat(129),
          },
        ]) {
          const response =
            await postLifecycleTransition(
              api,
              {
                headers: browserHeaders(
                  api.sessionCookie,
                  headerOptions
                ),
              }
            );
          assert.equal(
            response.status,
            400
          );
          assert.equal(
            (await response.json()).error.code,
            "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
          );
        }
        assert.equal(calls.length, 2);
      }
    );

    test(
      "rejects unknown or extraneous fields through the exact service policy and rejects malformed, primitive, and oversized JSON before service access",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls,
                {
                  implementation(command) {
                    validateLeagueLifecycleTransitionInput(
                      command.input
                    );
                    return ROLLOVER_RESULT;
                  },
                }
              ),
          }
        );

        const serviceValidatedCases = [
          {
            ...ROLLOVER_INPUT,
            force: true,
          },
          {
            ...EXEMPTION_INPUT,
            force: true,
          },
          {},
        ];
        for (const input of serviceValidatedCases) {
          const response =
            await postLifecycleTransition(
              api,
              { input }
            );
          assert.equal(
            response.status,
            400
          );
          assert.equal(
            (await response.json()).error.code,
            "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID"
          );
        }
        assert.equal(calls.length, 3);

        for (const item of [
          {
            body: "true",
            status: 400,
            code:
              "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
          },
          {
            body: "{",
            status: 400,
            code:
              "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
          },
          {
            body: JSON.stringify({
              ...ROLLOVER_INPUT,
              padding: "x".repeat(2_000),
            }),
            status: 413,
            code:
              "LEAGUE_LIFECYCLE_TRANSITION_TOO_LARGE",
          },
        ]) {
          const response =
            await postLifecycleTransition(
              api,
              { body: item.body }
            );
          const body = await response.json();
          assert.equal(
            response.status,
            item.status,
            item.code
          );
          assert.equal(
            body.error.code,
            item.code,
            item.code
          );
          assert.equal(
            body.error.message,
            SAFE_MESSAGES[item.code],
            item.code
          );
        }
        assert.equal(calls.length, 3);
      }
    );

    test(
      "maps lifecycle authority, visibility, conflict, stale, unavailable-result, and internal service failures without private leakage",
      async (t) => {
        const calls = [];
        let nextError = null;
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls,
                {
                  async implementation() {
                    throw nextError;
                  },
                }
              ),
          }
        );
        const cases = [
          {
            sourceCode:
              "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
            status: 400,
          },
          {
            sourceCode: "LEAGUE_ID_INVALID",
            status: 400,
            publicCode:
              "LEAGUE_LIFECYCLE_TRANSITION_INPUT_INVALID",
          },
          {
            sourceCode:
              "LEAGUE_COMMISSIONER_REQUIRED",
            status: 403,
          },
          {
            sourceCode:
              "PLATFORM_ADMINISTRATOR_REQUIRED",
            status: 403,
            input: EXEMPTION_INPUT,
          },
          {
            sourceCode: "LEAGUE_NOT_FOUND",
            status: 404,
          },
          ...[
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
            "SEASON_ROLLOVER_NOT_READY",
            "SEASON_ROLLOVER_RESULT_UNAVAILABLE",
          ].map((sourceCode) => ({
            sourceCode,
            status: 409,
          })),
          ...[
            "INITIAL_SEASON2_NO_DRAFT_NOT_ELIGIBLE",
            "INITIAL_SEASON2_NO_DRAFT_RESULT_UNAVAILABLE",
          ].map((sourceCode) => ({
            sourceCode,
            status: 409,
            input: EXEMPTION_INPUT,
          })),
          {
            sourceCode:
              "SEASON_ROLLOVER_PRECONDITION_FAILED",
            status: 412,
          },
          {
            sourceCode:
              "REPOSITORY_OPERATION_FAILED",
            status: 500,
            publicCode:
              "LEAGUE_LIFECYCLE_TRANSITION_REQUEST_FAILED",
          },
        ];

        for (const item of cases) {
          const safeDetails =
            item.sourceCode ===
            "SEASON_ROLLOVER_PRECONDITION_FAILED"
              ? {
                  currentVersion: 8,
                  refetch: true,
                }
              : undefined;
          nextError = serviceError(
            item.sourceCode,
            {
              details:
                safeDetails || {
                  privateSql:
                    "do not disclose",
                },
            }
          );
          const response =
            await postLifecycleTransition(
              api,
              {
                input:
                  item.input ??
                  ROLLOVER_INPUT,
              }
            );
          const body = await response.json();
          const publicCode =
            item.publicCode ??
            item.sourceCode;

          assert.equal(
            response.status,
            item.status,
            item.sourceCode
          );
          assert.deepEqual(
            body,
            {
              error: {
                code: publicCode,
                message:
                  SAFE_MESSAGES[publicCode],
                requestId: REQUEST_ID,
                ...(safeDetails
                  ? {
                      details:
                        safeDetails,
                    }
                  : {}),
              },
            },
            item.sourceCode
          );
          assert.equal(
            JSON.stringify(body).includes(
              "private"
            ),
            false,
            item.sourceCode
          );
          assert.equal(
            response.headers.get(
              "cache-control"
            ),
            "no-store",
            item.sourceCode
          );
        }
        assert.equal(
          calls.length,
          cases.length
        );
      }
    );

    test(
      "does not expose a GET writer or call the lifecycle-transition service for reads",
      async (t) => {
        const calls = [];
        const digestCalls = [];
        const api = await startApi(
          t,
          createServiceStub([]),
          {
            digestCalls,
            leagueLifecycleTransitionService:
              createLifecycleTransitionServiceStub(
                calls
              ),
          }
        );

        const response = await fetch(
          lifecycleTransitionUrl(api),
          {
            headers: {
              Origin:
                PUBLIC_FRONTEND_ORIGIN,
              "Sec-Fetch-Site":
                "cross-site",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
            },
          }
        );
        assert.equal(response.status, 404);
        assert.equal(calls.length, 0);
        assert.equal(digestCalls.length, 0);
      }
    );
  }
);
