const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  validateEntryDraftScheduleDraftId,
  validateEntryDraftScheduleExpectedVersion,
  validateEntryDraftScheduleIdempotencyKey,
  validateEntryDraftScheduleInput,
  validateEntryDraftScheduleLeagueId,
} = require(
  "../../src/domain/drafts/entryDraftSchedulePolicy"
);
const {
  SAFE_MESSAGES,
  createEntryDraftRouter,
} = require(
  "../../src/transport/http/createEntryDraftRouter"
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
const ENTRY_DRAFT_ID =
  "10000000-0000-4000-8000-000000000002";
const USER_ID =
  "10000000-0000-4000-8000-000000000003";
const SESSION_ID =
  "10000000-0000-4000-8000-000000000004";
const OPERATION_ID =
  "10000000-0000-4000-8000-000000000005";
const ROLLOVER_BINDING_ID =
  "10000000-0000-4000-8000-000000000006";
const ROLLOVER_OCCURRENCE_ID =
  "10000000-0000-4000-8000-000000000007";
const JOB_RUN_ID =
  "10000000-0000-4000-8000-000000000008";
const RAW_SESSION_TOKEN = Buffer.alloc(
  32,
  31
).toString("base64url");
const RAW_CSRF_TOKEN =
  "entry-draft-schedule-csrf";
const REQUEST_ID =
  "fad-t105-http-request";
const NETWORK_SOURCE = "198.51.100.0/24";
const IDEMPOTENCY_KEY =
  "fad-entry-draft-schedule-http-key";
const SCHEDULED_STARTS_AT_MS =
  1_840_780_800_000;

const AUTHENTICATED = Object.freeze({
  valid: true,
  user: Object.freeze({ id: USER_ID }),
  session: Object.freeze({
    id: SESSION_ID,
    userId: USER_ID,
  }),
});

const SCHEDULE_INPUT = Object.freeze({
  action: "schedule",
  scheduledStartsAtMs:
    SCHEDULED_STARTS_AT_MS,
  confirmation: "SCHEDULE ENTRY DRAFT",
  reason: null,
});

const RESCHEDULE_INPUT = Object.freeze({
  action: "reschedule",
  scheduledStartsAtMs:
    SCHEDULED_STARTS_AT_MS + 86_400_000,
  confirmation:
    "RESCHEDULE ENTRY DRAFT",
  reason: "Use the confirmed league date.",
});

function resultData({
  action = "schedule",
  entryDraftVersion = 8,
  scheduledStartsAtMs =
    SCHEDULED_STARTS_AT_MS,
} = {}) {
  return {
    operationId: OPERATION_ID,
    entryDraftId: ENTRY_DRAFT_ID,
    entryDraftVersion,
    rolloverBindingId:
      ROLLOVER_BINDING_ID,
    rolloverBindingVersion:
      action === "schedule" ? 1 : 2,
    rolloverOccurrenceId:
      ROLLOVER_OCCURRENCE_ID,
    scheduledStartsAtMs,
    jobRunId: JOB_RUN_ID,
    action,
  };
}

function serviceResult({
  action = "schedule",
  httpStatus =
    action === "schedule" ? 201 : 200,
  replayed = false,
} = {}) {
  const result = resultData({
    action,
    entryDraftVersion:
      action === "schedule" ? 8 : 9,
    scheduledStartsAtMs:
      action === "schedule"
        ? SCHEDULE_INPUT
            .scheduledStartsAtMs
        : RESCHEDULE_INPUT
            .scheduledStartsAtMs,
  });
  Object.defineProperties(result, {
    httpStatus: {
      configurable: false,
      enumerable: false,
      value: httpStatus,
      writable: false,
    },
    replayed: {
      configurable: false,
      enumerable: false,
      value: replayed,
      writable: false,
    },
    resultCode: {
      configurable: false,
      enumerable: false,
      value:
        action === "schedule"
          ? "ENTRY_DRAFT_SCHEDULED"
          : "ENTRY_DRAFT_RESCHEDULED",
      writable: false,
    },
  });
  return Object.freeze(result);
}

function serviceError(
  code,
  {
    details,
  } = {}
) {
  const error = new Error(
    "private repository and database detail"
  );
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function createServiceStub(
  calls,
  {
    implementation,
  } = {}
) {
  return {
    schedule(command) {
      calls.push(command);
      if (implementation) {
        return implementation(command);
      }
      return serviceResult({
        action: command.input.action,
      });
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
            rawCsrfToken !==
            RAW_CSRF_TOKEN
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
  return {
    requestSecurity,
    sessionCookie,
  };
}

async function startApi(
  t,
  entryDraftScheduleService,
  {
    digestCalls = [],
    networkSourceResolver = () =>
      NETWORK_SOURCE,
  } = {}
) {
  const {
    requestSecurity,
    sessionCookie,
  } = createHttpSecurity();
  const app = express();
  app.use(
    createEntryDraftRouter({
      requestSecurity,
      entryDraftScheduleService,
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
      ? {
          "Content-Type":
            contentType,
        }
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

function scheduleUrl(
  api,
  {
    draftId = ENTRY_DRAFT_ID,
    leagueId = LEAGUE_ID,
    suffix = "",
  } = {}
) {
  return new URL(
    `/api/v1/leagues/${leagueId}/entry-drafts/${draftId}/schedule${suffix}`,
    api.baseUrl
  );
}

async function scheduleRequest(
  api,
  {
    body = JSON.stringify(
      SCHEDULE_INPUT
    ),
    draftId = ENTRY_DRAFT_ID,
    headers = browserHeaders(
      api.sessionCookie
    ),
    leagueId = LEAGUE_ID,
    method = "POST",
    suffix = "",
  } = {}
) {
  return fetch(
    scheduleUrl(api, {
      draftId,
      leagueId,
      suffix,
    }),
    {
      method,
      headers,
      ...(method === "GET"
        ? {}
        : { body }),
    }
  );
}

function validateCommand(command) {
  validateEntryDraftScheduleLeagueId(
    command.leagueId
  );
  validateEntryDraftScheduleDraftId(
    command.entryDraftId
  );
  validateEntryDraftScheduleExpectedVersion(
    command.expectedEntryDraftVersion
  );
  validateEntryDraftScheduleIdempotencyKey(
    command.idempotencyKey
  );
  const input =
    validateEntryDraftScheduleInput(
      command.input
    );
  return serviceResult({
    action: input.action,
  });
}

describe(
  "T-105 isolated Entry Draft scheduling HTTP contract",
  () => {
    test(
      "uses non-enumerable service status for exact 201/200 no-store responses and passes the authenticated privacy-safe command",
      async (t) => {
        const calls = [];
        const digestCalls = [];
        const api = await startApi(
          t,
          createServiceStub(calls),
          { digestCalls }
        );

        const cases = [
          {
            input: SCHEDULE_INPUT,
            status: 201,
          },
          {
            input: RESCHEDULE_INPUT,
            status: 200,
          },
        ];
        for (const {
          input,
          status,
        } of cases) {
          const response =
            await scheduleRequest(api, {
              body: JSON.stringify(input),
            });
          const body =
            await response.json();

          assert.equal(
            response.status,
            status
          );
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
            response.headers.get(
              "set-cookie"
            ),
            null
          );
          assert.deepEqual(body, {
            data: resultData({
              action: input.action,
              entryDraftVersion:
                input.action === "schedule"
                  ? 8
                  : 9,
              scheduledStartsAtMs:
                input.scheduledStartsAtMs,
            }),
            meta: {
              requestId: REQUEST_ID,
            },
          });
          assert.equal(
            Object.hasOwn(
              body.data,
              "httpStatus"
            ),
            false
          );
          assert.equal(
            Object.hasOwn(
              body.data,
              "resultCode"
            ),
            false
          );
          assert.equal(
            Object.hasOwn(
              body.data,
              "replayed"
            ),
            false
          );
        }

        const expectedAuditContext = {
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
        };
        assert.deepEqual(calls, [
          {
            leagueId: LEAGUE_ID,
            entryDraftId:
              ENTRY_DRAFT_ID,
            input: SCHEDULE_INPUT,
            expectedEntryDraftVersion: 7,
            idempotencyKey:
              IDEMPOTENCY_KEY,
            authenticated: AUTHENTICATED,
            auditContext:
              expectedAuditContext,
          },
          {
            leagueId: LEAGUE_ID,
            entryDraftId:
              ENTRY_DRAFT_ID,
            input: RESCHEDULE_INPUT,
            expectedEntryDraftVersion: 7,
            idempotencyKey:
              IDEMPOTENCY_KEY,
            authenticated: AUTHENTICATED,
            auditContext:
              expectedAuditContext,
          },
        ]);
        assert.deepEqual(digestCalls, [
          `network\0${NETWORK_SOURCE}`,
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
            await scheduleRequest(api, {
              headers: browserHeaders(
                api.sessionCookie,
                options
              ),
            });
          assert.equal(
            response.status,
            400
          );
          assert.deepEqual(
            await response.json(),
            {
              error: {
                code:
                  "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
                message:
                  SAFE_MESSAGES
                    .ENTRY_DRAFT_SCHEDULE_INPUT_INVALID,
                requestId:
                  REQUEST_ID,
              },
            }
          );
        }
        assert.equal(calls.length, 0);
      }
    );

    test(
      "rejects primitive, malformed, and oversized strict JSON before service access",
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
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
          ],
          [
            "{",
            400,
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
          ],
          [
            JSON.stringify({
              padding: "x".repeat(1_100),
            }),
            413,
            "ENTRY_DRAFT_SCHEDULE_REQUEST_TOO_LARGE",
          ],
        ];

        for (const [
          body,
          status,
          code,
        ] of cases) {
          const response =
            await scheduleRequest(api, {
              body,
            });
          assert.equal(
            response.status,
            status,
            code
          );
          assert.deepEqual(
            await response.json(),
            {
              error: {
                code,
                message:
                  SAFE_MESSAGES[code],
                requestId:
                  REQUEST_ID,
              },
            }
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
            {
              contentType: "text/plain",
            },
            415,
            "CONTENT_TYPE_INVALID",
          ],
          [
            {
              includeContentType:
                false,
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
            await scheduleRequest(api, {
              headers: browserHeaders(
                api.sessionCookie,
                options
              ),
            });
          const body =
            await response.json();
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
      "passes Idempotency-Key unchanged and maps service-owned path, header, and body validation to one safe 400",
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
            draftId:
              "not-an-entry-draft-id",
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
              ...SCHEDULE_INPUT,
              unknown: true,
            }),
          },
          {
            body: JSON.stringify({
              ...SCHEDULE_INPUT,
              confirmation:
                "START ENTRY DRAFT",
            }),
          },
        ];

        for (const options of cases) {
          const response =
            await scheduleRequest(
              api,
              options
            );
          const body =
            await response.json();
          assert.equal(
            response.status,
            400
          );
          assert.deepEqual(body, {
            error: {
              code:
                "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
              message:
                SAFE_MESSAGES
                  .ENTRY_DRAFT_SCHEDULE_INPUT_INVALID,
              requestId: REQUEST_ID,
            },
          });
        }
        assert.equal(
          calls.length,
          cases.length
        );
        assert.equal(
          calls.at(-1).idempotencyKey,
          IDEMPOTENCY_KEY
        );
      }
    );

    test(
      "maps authority, invisible resources, conflicts, stale state, timing, and internal failures without private leakage",
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
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
            400,
            "ENTRY_DRAFT_SCHEDULE_INPUT_INVALID",
          ],
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            403,
            "LEAGUE_COMMISSIONER_REQUIRED",
          ],
          [
            "LEAGUE_NOT_FOUND",
            404,
            "ENTRY_DRAFT_SCHEDULE_NOT_FOUND",
          ],
          [
            "ENTRY_DRAFT_NOT_FOUND",
            404,
            "ENTRY_DRAFT_SCHEDULE_NOT_FOUND",
          ],
          ...[
            "IDEMPOTENCY_KEY_REUSED",
            "IDEMPOTENCY_REQUEST_UNAVAILABLE",
            "ENTRY_DRAFT_SCHEDULE_NOT_ALLOWED",
            "ENTRY_DRAFT_SCHEDULE_RESULT_UNAVAILABLE",
          ].map((code) => [
            code,
            409,
            code,
          ]),
          [
            "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED",
            412,
            "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED",
          ],
          [
            "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE",
            422,
            "ENTRY_DRAFT_SCHEDULE_NOT_FUTURE",
          ],
          [
            "REPOSITORY_OPERATION_FAILED",
            500,
            "ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED",
          ],
        ];

        for (const [
          sourceCode,
          status,
          publicCode,
        ] of cases) {
          const safeDetails =
            sourceCode ===
            "ENTRY_DRAFT_SCHEDULE_PRECONDITION_FAILED"
              ? {
                  currentVersion: 8,
                  refetch: true,
                  privateSql:
                    "do not disclose",
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
            await scheduleRequest(api);
          const body =
            await response.json();

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
                requestId:
                  REQUEST_ID,
                ...(status === 412
                  ? {
                      details: {
                        currentVersion: 8,
                        refetch: true,
                      },
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
      "fails closed before service access when the privacy-safe network context is unavailable",
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
          await scheduleRequest(api);
        assert.equal(response.status, 500);
        assert.deepEqual(
          await response.json(),
          {
            error: {
              code:
                "ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED",
              message:
                SAFE_MESSAGES
                  .ENTRY_DRAFT_SCHEDULE_REQUEST_FAILED,
              requestId: REQUEST_ID,
            },
          }
        );
        assert.equal(calls.length, 0);
      }
    );

    test(
      "exposes only the exact POST schedule method and path",
      async (t) => {
        const calls = [];
        const api = await startApi(
          t,
          createServiceStub(calls)
        );

        for (const options of [
          { method: "GET" },
          { method: "PUT" },
          { suffix: "/extra" },
        ]) {
          const response =
            await scheduleRequest(
              api,
              options
            );
          assert.equal(response.status, 404);
        }
        assert.equal(calls.length, 0);
      }
    );
  }
);
