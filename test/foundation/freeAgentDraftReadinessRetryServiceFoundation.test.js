"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  buildFreeAgentDraftReadinessOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS,
  createFreeAgentDraftReadinessRetryService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftReadinessRetryService"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const SEASON_ID =
  "22222222-2222-4222-8222-222222222222";
const READINESS_ID =
  "33333333-3333-4333-8333-333333333333";
const USER_ID =
  "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_ID =
  "55555555-5555-4555-8555-555555555555";
const JOB_ID =
  "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_REQUEST_ID =
  "77777777-7777-4777-8777-777777777777";
const RECEIPT_ID =
  "88888888-8888-4888-8888-888888888888";
const NOW_MS = 1_790_000_000_000;
const EXPECTED_VERSION = 3;
const IDEMPOTENCY_KEY = "fad-readiness-retry-2026";
const AUTHENTICATED = Object.freeze({ session: true });
const BODY = Object.freeze({
  seasonId: SEASON_ID,
  readinessOperationId: READINESS_ID,
  confirmation:
    FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
});

function serviceInput(overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    input: BODY,
    expectedVersion: EXPECTED_VERSION,
    idempotencyKey: IDEMPOTENCY_KEY,
    authenticated: AUTHENTICATED,
    ...overrides,
  };
}

function receiptFor(
  repositoryInput,
  actorAuthority,
  acceptedAtMs = NOW_MS
) {
  const request =
    createFreeAgentDraftReadinessRetryRequest({
      actorUserId:
        repositoryInput.actorUserId,
      body: repositoryInput.body,
      clientKey: repositoryInput.clientKey,
      expectedVersion:
        repositoryInput.expectedVersion,
      leagueId: repositoryInput.leagueId,
    });
  return createFreeAgentDraftReadinessRetryReceipt({
    acceptedAtMs,
    acceptedFromVersion:
      repositoryInput.expectedVersion,
    actorAuthority,
    actorMembershipId:
      repositoryInput.actorMembershipId,
    actorUserId: repositoryInput.actorUserId,
    id:
      repositoryInput.retryReceiptId || RECEIPT_ID,
    idempotencyRequestId:
      repositoryInput.idempotencyRequestId ||
      IDEMPOTENCY_REQUEST_ID,
    jobRunId: JOB_ID,
    leagueId: repositoryInput.leagueId,
    occurrenceKey:
      buildFreeAgentDraftReadinessOccurrenceKey({
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        triggerResourceId: SEASON_ID,
      }),
    readinessOperationId:
      repositoryInput.body.readinessOperationId,
    requestSha256: request.requestSha256,
    resultingReadinessVersion:
      repositoryInput.expectedVersion + 1,
    retryAttemptNumber: 2,
    seasonId:
      repositoryInput.body.seasonId,
  });
}

function resultFor(
  input,
  actorAuthority,
  replayed,
  acceptedAtMs
) {
  const evidence = receiptFor(
    input,
    actorAuthority,
    acceptedAtMs
  );
  return Object.freeze({
    data: evidence.data,
    evidence,
    httpStatus: 202,
    replayed,
  });
}

function harness({
  replay = false,
  authorityName = "commissioner",
  authorizationError = null,
  nowMs = NOW_MS,
  resultOverride,
} = {}) {
  const calls = [];
  const actorAuthority =
    authorityName === "commissioner"
      ? "commissioner"
      : "platform_administrator_as_commissioner";
  const repository = {
    findReadinessRetryReplay(input) {
      calls.push([
        "findReadinessRetryReplay",
        input,
      ]);
      if (!replay) return null;
      return resultOverride === undefined
        ? resultFor(
            input,
            actorAuthority,
            true,
            NOW_MS - 1_000
          )
        : resultOverride;
    },
    requeueReadiness(input) {
      calls.push(["requeueReadiness", input]);
      return resultOverride === undefined
        ? resultFor(
            input,
            actorAuthority,
            false,
            input.acceptedAtMs
          )
        : resultOverride;
    },
  };
  const service =
    createFreeAgentDraftReadinessRetryService({
      leagueAuthorization: {
        requireCommissioner(
          authenticated,
          leagueId
        ) {
          calls.push([
            "requireCommissioner",
            authenticated,
            leagueId,
          ]);
          if (authorizationError) {
            throw authorizationError;
          }
          return Object.freeze({
            actorUserId: USER_ID,
            membershipId: MEMBERSHIP_ID,
            authority: authorityName,
          });
        },
      },
      repository,
      clock: {
        nowMs() {
          calls.push(["nowMs"]);
          return nowMs;
        },
      },
      secureRandom: {
        id() {
          const allocated =
            calls.filter(
              ([name]) => name === "id"
            ).length === 0
              ? IDEMPOTENCY_REQUEST_ID
              : RECEIPT_ID;
          calls.push(["id", allocated]);
          return allocated;
        },
      },
    });
  return { calls, service };
}

describe("FAD-08 readiness-retry application boundary", () => {
  test("authorizes, probes replay, then samples the clock and persists one fresh retry", () => {
    const { calls, service } = harness();

    const result = service.retry(serviceInput());
    assert.equal(result.replayed, false);
    assert.equal(result.httpStatus, 202);
    assert.equal(result.data.status, "accepted");
    assert.equal(
      result.data.retryReceiptId,
      RECEIPT_ID
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "requireCommissioner",
        "findReadinessRetryReplay",
        "nowMs",
        "id",
        "id",
        "requeueReadiness",
      ]
    );
    const write = calls.at(-1)[1];
    assert.deepEqual(write.body, BODY);
    assert.equal(write.actorUserId, USER_ID);
    assert.equal(
      write.actorMembershipId,
      MEMBERSHIP_ID
    );
    assert.equal(write.acceptedAtMs, NOW_MS);
    assert.equal(
      write.idempotencyExpiresAtMs,
      NOW_MS +
        FREE_AGENT_DRAFT_READINESS_RETRY_IDEMPOTENCY_LIFETIME_MS
    );
    assert.equal(
      write.idempotencyRequestId,
      IDEMPOTENCY_REQUEST_ID
    );
    assert.equal(write.retryReceiptId, RECEIPT_ID);
  });

  test("returns immutable replay evidence before clock or identifier allocation", () => {
    const { calls, service } = harness({ replay: true });

    const result = service.retry(serviceInput());
    assert.equal(result.replayed, true);
    assert.equal(result.data.acceptedAtMs, NOW_MS - 1_000);
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "requireCommissioner",
        "findReadinessRetryReplay",
      ]
    );
  });

  test("normalizes inherited platform authority to commissioner evidence", () => {
    const { service } = harness({
      authorityName: "platform_administrator",
    });

    const result = service.retry(serviceInput());
    assert.equal(
      result.evidence.actorAuthority,
      "platform_administrator_as_commissioner"
    );
  });

  test("performs no replay, clock, or identifier work when authority fails", () => {
    const denied = new Error("denied");
    const { calls, service } = harness({
      authorizationError: denied,
    });

    assert.throws(
      () => service.retry(serviceInput()),
      (error) => error === denied
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["requireCommissioner"]
    );
  });

  test("rejects malformed or extra command input before persistence", () => {
    for (const input of [
      {
        ...serviceInput(),
        unknown: true,
      },
      serviceInput({
        input: {
          ...BODY,
          confirmation: "RETRY",
        },
      }),
    ]) {
      const { calls, service } = harness();
      assert.throws(() => service.retry(input));
      assert.equal(
        calls.some(
          ([name]) =>
            name === "findReadinessRetryReplay" ||
            name === "requeueReadiness"
        ),
        false
      );
    }
  });

  test("fails closed on an unsafe clock or mismatched repository result", () => {
    {
      const { service } = harness({
        nowMs: Number.MAX_SAFE_INTEGER,
      });
      assert.throws(
        () => service.retry(serviceInput()),
        /safe UTC timestamp/
      );
    }
    {
      const { service } = harness({
        resultOverride: Object.freeze({
          data: {},
          evidence: {},
          httpStatus: 200,
          replayed: false,
        }),
      });
      assert.throws(
        () => service.retry(serviceInput()),
        {
          code: "FAD_READINESS_RESULT_INVALID",
        }
      );
    }
  });

  test("requires the complete dependency surface", () => {
    const dependencies = {
      leagueAuthorization: {
        requireCommissioner() {},
      },
      repository: {
        findReadinessRetryReplay() {},
        requeueReadiness() {},
      },
      clock: { nowMs() {} },
      secureRandom: { id() {} },
    };
    for (const [dependency, method] of [
      ["leagueAuthorization", "requireCommissioner"],
      ["repository", "findReadinessRetryReplay"],
      ["clock", "nowMs"],
      ["secureRandom", "id"],
    ]) {
      const value = {
        ...dependencies,
        [dependency]: {
          ...dependencies[dependency],
        },
      };
      delete value[dependency][method];
      assert.throws(
        () =>
          createFreeAgentDraftReadinessRetryService(
            value
          ),
        /FAD readiness retry requires/
      );
    }
  });
});
