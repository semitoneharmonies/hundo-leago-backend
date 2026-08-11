"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES,
  FreeAgentDraftQueuedNominationActivationServiceError,
  createFreeAgentDraftQueuedNominationActivationService,
  isFreeAgentDraftQueuedNominationActivationTerminalFailure,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftQueuedNominationActivationService"
);
const {
  FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftQueuedNominationActivationWriter"
);

const DAY_MS = 86_400_000;
const OPENING_AT_MS = 2_000_000_000_000;
const ACTIVATED_AT_MS = OPENING_AT_MS + 500;
const IDS = Object.freeze({
  league: "00000000-0000-4000-8000-000000000001",
  season: "00000000-0000-4000-8000-000000000002",
  fad: "00000000-0000-4000-8000-000000000003",
  queue: "00000000-0000-4000-8000-000000000004",
  player: "00000000-0000-4000-8000-000000000005",
  rollover: "00000000-0000-4000-8000-000000000006",
  resolutionRollover:
    "00000000-0000-4000-8000-000000000007",
  job: "00000000-0000-4000-8000-000000000008",
  auction: "00000000-0000-4000-8000-000000000009",
  bid: "00000000-0000-4000-8000-000000000010",
  draw: "00000000-0000-4000-8000-000000000011",
  resolutionJob:
    "00000000-0000-4000-8000-000000000012",
  event: "00000000-0000-4000-8000-000000000013",
  extension: "00000000-0000-4000-8000-000000000014",
  recovery: "00000000-0000-4000-8000-000000000015",
});
const OCCURRENCE_KEY =
  `fad:${IDS.fad}:nomination-open:${IDS.queue}:${OPENING_AT_MS}`;

function execution(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    queueId: IDS.queue,
    playerId: IDS.player,
    openingRolloverId: IDS.rollover,
    openingAtMs: OPENING_AT_MS,
    occurrenceKey: OCCURRENCE_KEY,
    scheduledForMs: OPENING_AT_MS,
    jobExecution: {
      runId: IDS.job,
      leaseOwner: "queued-activation-worker",
      leaseToken: "queued-activation-token",
      leaseExpiresAtMs: OPENING_AT_MS + 60_000,
      startedAtMs: OPENING_AT_MS + 100,
      attemptCount: 1,
      expectedVersion: 2,
      ...(overrides.jobExecution || {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) => field !== "jobExecution"
      )
    ),
  };
}

function activation(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    queueId: IDS.queue,
    playerId: IDS.player,
    openingRolloverId: IDS.rollover,
    openingAtMs: OPENING_AT_MS,
    status: "queued",
    queueVersion: 1,
    activationJobRunId: IDS.job,
    activationOccurrenceKey: OCCURRENCE_KEY,
    jobStatus: "running",
    jobRunVersion: 2,
    resolutionRolloverId: null,
    auctionId: null,
    starterBidId: null,
    recoveryId: null,
    recoveryStatus: null,
    recoveryVersion: null,
    ...overrides,
  };
}

function openedResult(overrides = {}) {
  return {
    outcome: "opened",
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    queueId: IDS.queue,
    openingRolloverId: IDS.rollover,
    resolutionRolloverId: IDS.resolutionRollover,
    openingAtMs: OPENING_AT_MS,
    activatedAtMs: ACTIVATED_AT_MS,
    resolvesAtMs: OPENING_AT_MS + DAY_MS,
    queueVersion: 2,
    auctionId: IDS.auction,
    starterBidId: IDS.bid,
    drawId: IDS.draw,
    resolutionJobRunId: IDS.resolutionJob,
    validationCode: null,
    jobRunId: IDS.job,
    jobRunVersion: 3,
    sourceRecoveryId: null,
    evidence: {
      auctionEventId: IDS.event,
      extensionRolloverId: IDS.extension,
    },
    replayed: false,
    ...overrides,
  };
}

function invalidResult(overrides = {}) {
  return openedResult({
    outcome: "invalid",
    resolutionRolloverId: null,
    resolvesAtMs: null,
    auctionId: null,
    starterBidId: null,
    drawId: null,
    resolutionJobRunId: null,
    validationCode: "PLAYER_UNAVAILABLE",
    evidence: {
      auctionEventId: null,
      extensionRolloverId: null,
    },
    ...overrides,
  });
}

function failureResult(overrides = {}) {
  return {
    recorded: true,
    replayed: false,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    queueId: IDS.queue,
    openingRolloverId: IDS.rollover,
    failedAtMs: ACTIVATED_AT_MS,
    errorCode:
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
    recoveryId: IDS.recovery,
    recoveryVersion: 1,
    jobRunId: IDS.job,
    jobRunVersion: 3,
    ...overrides,
  };
}

function fixture({
  state = activation(),
  terminal = openedResult(),
  failure = failureResult(),
  nowMs = ACTIVATED_AT_MS,
} = {}) {
  const calls = {
    find: [],
    execute: [],
    failure: [],
  };
  const repository = {
    findActivation(input) {
      calls.find.push(input);
      return state;
    },
    executeClaimed(input) {
      calls.execute.push(input);
      return terminal;
    },
    recordFailure(input) {
      calls.failure.push(input);
      return failure;
    },
  };
  const service =
    createFreeAgentDraftQueuedNominationActivationService({
      repository,
      clock: { nowMs: () => nowMs },
    });
  return { calls, repository, service };
}

function assertServiceReason(action, code, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftQueuedNominationActivationServiceError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("FAD-13 queued-nomination activation service", () => {
  test("derives fresh queue/job versions and forwards the exact claimed opening fence", () => {
    const current = fixture();
    assert.deepEqual(Object.keys(current.service), [
      "executeClaimedActivation",
      "recordClaimedFailure",
    ]);
    const result = current.service.executeClaimedActivation(
      execution()
    );
    assert.deepEqual(result, openedResult());
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(current.calls.find, [{
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      queueId: IDS.queue,
      rolloverAtMs: OPENING_AT_MS,
    }]);
    assert.deepEqual(current.calls.execute, [{
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      queueId: IDS.queue,
      playerId: IDS.player,
      openingRolloverId: IDS.rollover,
      openingAtMs: OPENING_AT_MS,
      occurrenceKey: OCCURRENCE_KEY,
      expectedQueueVersion: 1,
      activatedAtMs: ACTIVATED_AT_MS,
      jobExecution: {
        runId: IDS.job,
        expectedVersion: 2,
        leaseOwner: "queued-activation-worker",
        leaseToken: "queued-activation-token",
        leaseExpiresAtMs: OPENING_AT_MS + 60_000,
      },
    }]);
  });

  test("treats PLAYER_UNAVAILABLE as a successful semantic invalidation", () => {
    const current = fixture({ terminal: invalidResult() });
    assert.deepEqual(
      current.service.executeClaimedActivation(execution()),
      invalidResult()
    );
    assert.equal(current.calls.failure.length, 0);
  });

  test("replays an exact terminal writer result through the preceding versions", () => {
    const prior = openedResult({
      activatedAtMs: ACTIVATED_AT_MS - 100,
      replayed: true,
    });
    const current = fixture({
      state: activation({
        status: "opened",
        queueVersion: 2,
        jobStatus: "succeeded",
        jobRunVersion: 3,
        resolutionRolloverId: IDS.resolutionRollover,
        auctionId: IDS.auction,
        starterBidId: IDS.bid,
      }),
      terminal: prior,
      nowMs: ACTIVATED_AT_MS + DAY_MS,
    });
    assert.deepEqual(
      current.service.executeClaimedActivation(execution()),
      prior
    );
    assert.equal(
      current.calls.execute[0].expectedQueueVersion,
      1
    );
    assert.equal(
      current.calls.execute[0].jobExecution.expectedVersion,
      2
    );
    assert.equal(
      current.calls.execute[0].activatedAtMs,
      ACTIVATED_AT_MS + DAY_MS
    );
  });

  test("records only the stable safe terminal failure through the claimed lease", () => {
    const current = fixture();
    const result = current.service.recordClaimedFailure(
      execution()
    );
    assert.deepEqual(result, failureResult());
    assert.deepEqual(current.calls.failure, [{
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      queueId: IDS.queue,
      playerId: IDS.player,
      openingRolloverId: IDS.rollover,
      openingAtMs: OPENING_AT_MS,
      occurrenceKey: OCCURRENCE_KEY,
      expectedQueueVersion: 1,
      failedAtMs: ACTIVATED_AT_MS,
      errorCode:
        FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_FAILURE_CODE,
      jobExecution: {
        runId: IDS.job,
        expectedVersion: 2,
        leaseOwner: "queued-activation-worker",
        leaseToken: "queued-activation-token",
        leaseExpiresAtMs: OPENING_AT_MS + 60_000,
      },
    }]);
  });

  test("brands only an exhausted opening window or explicit lifecycle terminal as deterministic", () => {
    const late = fixture({
      nowMs: OPENING_AT_MS + DAY_MS,
    });
    assert.throws(
      () => late.service.executeClaimedActivation(execution({
        jobExecution: {
          leaseExpiresAtMs: OPENING_AT_MS + DAY_MS + 10_000,
        },
      })),
      (error) => {
        assert.equal(
          error.code,
          FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
            .deterministicFailure
        );
        assert.equal(error.reasonCode, "activation_window_closed");
        assert.equal(
          isFreeAgentDraftQueuedNominationActivationTerminalFailure(
            error
          ),
          true
        );
        return true;
      }
    );
    const lifecycleError = Object.assign(new Error("internal"), {
      details: { reasonCode: "ACTIVATION_LIFECYCLE_CHANGED" },
    });
    const current = fixture();
    current.repository.executeClaimed = () => {
      throw lifecycleError;
    };
    assert.throws(
      () => current.service.executeClaimedActivation(execution()),
      (error) => {
        assert.equal(
          isFreeAgentDraftQueuedNominationActivationTerminalFailure(
            error
          ),
          true
        );
        assert.equal(
          error.reasonCode,
          "activation_lifecycle_changed"
        );
        return true;
      }
    );
    const transient = new Error("transient constraint");
    current.repository.executeClaimed = () => {
      throw transient;
    };
    assert.throws(
      () => current.service.executeClaimedActivation(execution()),
      (error) => error === transient
    );
    assert.equal(
      isFreeAgentDraftQueuedNominationActivationTerminalFailure(
        transient
      ),
      false
    );
  });

  test("fails closed on malformed inputs, state, results, clocks, and asynchronous collaborators", () => {
    const current = fixture();
    assertServiceReason(
      () => current.service.executeClaimedActivation({
        ...execution(),
        extra: true,
      }),
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .inputInvalid,
      "execution_fields_invalid"
    );
    const stale = fixture({
      state: activation({ jobRunVersion: 3 }),
    });
    assertServiceReason(
      () => stale.service.executeClaimedActivation(execution()),
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .stateInvalid,
      "activation_not_claimed_or_replayable"
    );
    const malformed = fixture({
      terminal: openedResult({ auctionId: IDS.queue }),
    });
    assertServiceReason(
      () => malformed.service.executeClaimedActivation(execution()),
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .stateInvalid,
      "terminal_result_invalid"
    );
    const asyncRead = fixture();
    asyncRead.repository.findActivation = async () => activation();
    assertServiceReason(
      () => asyncRead.service.executeClaimedActivation(execution()),
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .stateInvalid,
      "repository_must_be_synchronous"
    );
    const badClock = fixture();
    const service =
      createFreeAgentDraftQueuedNominationActivationService({
        repository: badClock.repository,
        clock: { nowMs: () => Number.NaN },
      });
    assertServiceReason(
      () => service.executeClaimedActivation(execution()),
      FREE_AGENT_DRAFT_QUEUED_NOMINATION_ACTIVATION_SERVICE_CODES
        .stateInvalid,
      "clock_timestamp_invalid"
    );
    assert.throws(
      () => createFreeAgentDraftQueuedNominationActivationService(),
      TypeError
    );
    assert.throws(
      () => createFreeAgentDraftQueuedNominationActivationService({
        repository: {},
        clock: { nowMs() { return 1; } },
      }),
      TypeError
    );
  });
});
