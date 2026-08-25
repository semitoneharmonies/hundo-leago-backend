const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  LATE_LOCK_COORDINATOR_STATUSES,
  LATE_LOCK_MAINTENANCE_EXCLUSIONS,
  LATE_LOCK_MUTATION_WRITER_REGISTRY,
  createLateLockCoordinator,
} = require("../../src/application/services/matchups/createLateLockCoordinator");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  leagueA: uuid(1),
  seasonA: uuid(2),
  weekA: uuid(3),
  teamA: uuid(4),
  ownershipA: uuid(5),
  ownershipA2: uuid(6),
  lockA: uuid(7),
  leagueB: uuid(11),
  seasonB: uuid(12),
  weekB: uuid(13),
  teamB: uuid(14),
  ownershipB: uuid(15),
  lockB: uuid(16),
  teamC: uuid(24),
  ownershipC: uuid(25),
  lockC: uuid(26),
});

function witness(ownershipId, state = "present", ownershipVersion = 4) {
  return { ownershipId, ownershipVersion, state };
}

function teamA(ownershipWitnesses = [witness(IDS.ownershipA)]) {
  return {
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    teamId: IDS.teamA,
    ownershipWitnesses,
  };
}

function teamB(ownershipWitnesses = [witness(IDS.ownershipB)]) {
  return {
    leagueId: IDS.leagueB,
    seasonId: IDS.seasonB,
    teamId: IDS.teamB,
    ownershipWitnesses,
  };
}

function teamC(ownershipWitnesses = [witness(IDS.ownershipC)]) {
  return {
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    teamId: IDS.teamC,
    ownershipWitnesses,
  };
}

function batch(teams = [teamA()], mutationKind = "roster_move") {
  return { mutationKind, teams };
}

function targetForTeam(team) {
  const values =
    team.teamId === IDS.teamA
      ? { weekId: IDS.weekA, lockId: IDS.lockA }
      : team.teamId === IDS.teamB
        ? { weekId: IDS.weekB, lockId: IDS.lockB }
        : { weekId: IDS.weekA, lockId: IDS.lockC };
  return Object.freeze({
    leagueId: team.leagueId,
    seasonId: team.seasonId,
    weekId: values.weekId,
    teamId: team.teamId,
    lockId: values.lockId,
  });
}

function scheduledTarget(teamId, lockId) {
  return Object.freeze({
    leagueId: IDS.leagueA,
    seasonId: IDS.seasonA,
    weekId: IDS.weekA,
    teamId,
    lockId,
  });
}

function codedError(code, options = {}) {
  return Object.assign(new Error(code), { code, ...options });
}

function occurrenceExecution(overrides = {}) {
  return Object.freeze({
    bindingId: uuid(101),
    claimedJobVersion: 2,
    jobType: "matchup:statistics_refresh",
    leagueId: IDS.leagueA,
    leaseExpiresAtMs: 9_000,
    leaseOwner: "matchup-worker",
    leaseToken: "lease-token",
    occurrenceKey: "matchup:statistics_refresh:test",
    runId: uuid(102),
    scheduleOperationId: uuid(103),
    scheduleVersion: 1,
    scheduledForMs: 500,
    seasonId: IDS.seasonA,
    weekId: IDS.weekA,
    ...overrides,
  });
}

function runtime({
  targets,
  lockLate,
  refresh,
  nowMs,
  loggerError,
} = {}) {
  const calls = {
    errors: [],
    locks: [],
    order: [],
    refreshes: [],
    targetReads: [],
  };
  let currentNowMs = 1_000;
  const coordinator = createLateLockCoordinator({
    targetRepository: {
      listEligibleLateLocks(input) {
        calls.targetReads.push(input);
        calls.order.push(
          input.mode === "committed_team"
            ? `read:${input.team.teamId}`
            : "read:scheduled"
        );
        if (targets) return targets(input, calls);
        return input.mode === "committed_team"
          ? [targetForTeam(input.team)]
          : [scheduledTarget(IDS.teamA, IDS.lockA)];
      },
    },
    legalityService: {
      async lockLate(input) {
        calls.locks.push(input);
        calls.order.push(`lock:${input.teamId}`);
        if (lockLate) return lockLate(input, calls);
        return { lock: { id: input.lockId } };
      },
    },
    statisticsService: {
      async refresh(input) {
        calls.refreshes.push(input);
        calls.order.push("refresh");
        if (refresh) return refresh(input, calls);
        return { status: "succeeded" };
      },
    },
    provider: "sportsdataio",
    clock: {
      nowMs() {
        if (nowMs) return nowMs(calls);
        const value = currentNowMs;
        currentNowMs += 1;
        return value;
      },
    },
    logger: {
      error(message, details) {
        calls.errors.push({ message, details });
        if (loggerError) return loggerError(message, details, calls);
      },
    },
  });
  return { calls, coordinator };
}

describe("FAD-05 closed-batch late-lock coordinator", () => {
  test("exports the exact safe states, canonical writer registry, and maintenance exclusions", () => {
    assert.deepEqual(LATE_LOCK_COORDINATOR_STATUSES, [
      "completed",
      "awaiting_data",
      "still_illegal",
      "not_applicable",
    ]);
    assert.deepEqual(LATE_LOCK_MUTATION_WRITER_REGISTRY, [
      "roster_move",
      "injured_reserve_move",
      "buyout",
      "release",
      "auction_resolution",
      "fad_auction_resolution",
      "candidate_allocation",
      "fad_allocation_correction",
      "candidate_carryover",
      "trade_acceptance",
      "trade_reversal",
      "commissioner_addition",
      "commissioner_removal",
      "commissioner_correction",
      "contract_rollover",
      "contract_correction",
      "prospect_signing",
      "prospect_release",
      "prospect_activation",
      "league_position_correction",
    ]);
    assert.deepEqual(LATE_LOCK_MAINTENANCE_EXCLUSIONS, [
      "release_qa_fixture_reset",
      "staging_provider_catalog_import",
    ]);
    assert.equal(Object.isFrozen(LATE_LOCK_MUTATION_WRITER_REGISTRY), true);
    assert.equal(Object.isFrozen(LATE_LOCK_MAINTENANCE_EXCLUSIONS), true);
  });

  test("constructor configuration errors remain synchronous", () => {
    assert.throws(() => createLateLockCoordinator(), TypeError);
    assert.throws(
      () =>
        createLateLockCoordinator({
          targetRepository: { listEligibleLateLocks() {} },
          legalityService: { lockLate() {} },
          statisticsService: { refresh() {} },
          provider: "sportsdataio",
          clock: { nowMs() {} },
          logger: {},
        }),
      TypeError
    );
  });

  test("accepts stable-ID-ordered rows and deep-freezes present and deleted witnesses", async () => {
    const submittedA = teamA([
      witness(IDS.ownershipA, "present", 7),
      witness(IDS.ownershipA2, "deleted", 8),
    ]);
    const submittedB = teamB();
    const input = batch([submittedA, submittedB]);
    const { calls, coordinator } = runtime({ targets: () => [] });

    assert.deepEqual(await coordinator.coordinateCommittedRoster(input), {
      status: "not_applicable",
    });
    assert.deepEqual(
      calls.targetReads.map((read) => read.team.teamId),
      [IDS.teamA, IDS.teamB]
    );
    assert.deepEqual(
      calls.targetReads[0].team.ownershipWitnesses.map(
        ({ ownershipId, state, ownershipVersion }) => ({
          ownershipId,
          ownershipVersion,
          state,
        })
      ),
      [
        witness(IDS.ownershipA, "present", 7),
        witness(IDS.ownershipA2, "deleted", 8),
      ]
    );
    for (const { mode, team, nowMs } of calls.targetReads) {
      assert.equal(mode, "committed_team");
      assert.equal(Number.isSafeInteger(nowMs), true);
      assert.equal(Object.isFrozen(team), true);
      assert.equal(Object.isFrozen(team.ownershipWitnesses), true);
      assert.equal(
        team.ownershipWitnesses.every((item) => Object.isFrozen(item)),
        true
      );
    }
    assert.equal(input.teams[0], submittedA);
    assert.deepEqual(
      submittedA.ownershipWitnesses.map(({ ownershipId }) => ownershipId),
      [IDS.ownershipA, IDS.ownershipA2]
    );
  });

  test("accepts an explicitly affected team with an empty ownership roster", async () => {
    const { calls, coordinator } = runtime();

    assert.deepEqual(
      await coordinator.coordinateCommittedRoster(batch([teamA([])])),
      { status: "completed", lockId: IDS.lockA }
    );
    assert.equal(calls.targetReads.length, 1);
    assert.deepEqual(calls.targetReads[0].team.ownershipWitnesses, []);
    assert.equal(
      Object.isFrozen(calls.targetReads[0].team.ownershipWitnesses),
      true
    );
  });

  test("accepts every canonical writer kind through the same batch contract", async () => {
    for (const mutationKind of LATE_LOCK_MUTATION_WRITER_REGISTRY) {
      const { calls, coordinator } = runtime();
      assert.deepEqual(
        await coordinator.coordinateCommittedRoster(
          batch([teamA()], mutationKind)
        ),
        { status: "completed", lockId: IDS.lockA },
        mutationKind
      );
      assert.equal(calls.targetReads.length, 1, mutationKind);
      assert.equal(calls.locks.length, 1, mutationKind);
      assert.deepEqual(calls.refreshes, [], mutationKind);
    }
  });

  test("invalid, duplicate, and cross-team receipts never reject after commit", async () => {
    const invalidCases = [
      null,
      {},
      { mutationKind: "roster_move", teams: [], extra: true },
      batch([]),
      batch([
        { ...teamA(), extra: true },
      ]),
      batch([
        teamA([
          { ...witness(IDS.ownershipA), extra: true },
        ]),
      ]),
      batch([teamA([witness(IDS.ownershipA, "unknown")])]),
      batch([teamA([witness("invalid")])]),
      batch([teamA([witness(IDS.ownershipA, "present", 0)])]),
      batch([teamA(), teamA([witness(IDS.ownershipA2)])]),
      batch([teamB(), teamA()]),
      batch([
        teamA([
          witness(IDS.ownershipA2, "deleted", 8),
          witness(IDS.ownershipA, "present", 7),
        ]),
      ]),
      batch([
        teamA(),
        teamB([witness(IDS.ownershipA, "deleted")]),
      ]),
      batch([teamA()], " bad "),
      batch([teamA()], "unregistered_roster_writer"),
    ];
    const { calls, coordinator } = runtime();
    for (const input of invalidCases) {
      assert.deepEqual(
        await coordinator.coordinateCommittedRoster(input),
        { status: "awaiting_data" }
      );
    }
    assert.equal(calls.targetReads.length, 0);
    assert.equal(calls.locks.length, 0);
    assert.equal(calls.refreshes.length, 0);
  });

  test("clock, repository, provider, logger, and unexpected runtime failures never reject", async () => {
    const cases = [
      runtime({
        nowMs: () => {
          throw new Error("clock secret");
        },
      }),
      runtime({
        nowMs: () => -1,
      }),
      runtime({
        targets: () => {
          throw new Error("repository secret");
        },
      }),
      runtime({
        lockLate: async () => {
          throw new Error("runtime secret");
        },
      }),
      runtime({
        lockLate: async () => {
          throw codedError("MATCHUP_LEGALITY_GAME_STATE_UNAVAILABLE");
        },
      }),
      runtime({
        lockLate: async () => ({ lock: { id: uuid(999) } }),
      }),
      runtime({
        targets: () => {
          throw new Error("repository secret");
        },
        loggerError: () => {
          throw new Error("logger secret");
        },
      }),
    ];
    for (const evidence of cases) {
      assert.deepEqual(
        await evidence.coordinator.coordinateCommittedRoster(batch()),
        { status: "awaiting_data" }
      );
    }

    const refreshFailure = runtime({
      lockLate: async () => {
        throw codedError("MATCHUP_LEGALITY_STATISTICS_MISSING");
      },
      refresh: async () => {
        throw new Error("provider secret");
      },
      loggerError: () => {
        throw new Error("logger secret");
      },
    });
    assert.deepEqual(
      await refreshFailure.coordinator.coordinateCommittedRoster(batch()),
      { status: "awaiting_data" }
    );
    assert.deepEqual(refreshFailure.calls.refreshes, [{}]);
  });

  test("a generic outer repository code cannot mask a nested stale-data reason", async () => {
    let attempt = 0;
    const { calls, coordinator } = runtime({
      lockLate: async (input) => {
        attempt += 1;
        if (attempt === 1) {
          throw codedError("REPOSITORY_VERSION_CONFLICT", {
            cause: codedError("MATCHUP_LOCK_SOURCE_STALE"),
          });
        }
        return { lock: { id: input.lockId } };
      },
    });

    assert.deepEqual(
      await coordinator.coordinateCommittedRoster(batch()),
      { status: "completed", lockId: IDS.lockA }
    );
    assert.deepEqual(calls.refreshes, [{}]);
    assert.equal(calls.locks.length, 2);
  });

  test("aggregates multi-team status priority and safe lock ambiguity exactly", async () => {
    const cases = [
      {
        name: "awaiting outranks completed and removes the lock ID",
        statusByTeam: {
          [IDS.teamA]: "completed",
          [IDS.teamB]: "awaiting_data",
        },
        expected: { status: "awaiting_data" },
      },
      {
        name: "still illegal outranks one completed lock",
        statusByTeam: {
          [IDS.teamA]: "completed",
          [IDS.teamB]: "still_illegal",
        },
        expected: { status: "still_illegal", lockId: IDS.lockA },
      },
      {
        name: "completed outranks not applicable",
        statusByTeam: {
          [IDS.teamA]: "completed",
          [IDS.teamB]: "not_applicable",
        },
        expected: { status: "completed", lockId: IDS.lockA },
      },
      {
        name: "multiple completed locks omit an ambiguous lock ID",
        statusByTeam: {
          [IDS.teamA]: "completed",
          [IDS.teamB]: "completed",
        },
        expected: { status: "completed" },
      },
    ];

    for (const scenario of cases) {
      const evidence = runtime({
        targets: (input) => {
          if (
            scenario.statusByTeam[input.team.teamId] === "not_applicable"
          ) {
            return [];
          }
          return [targetForTeam(input.team)];
        },
        lockLate: async (input) => {
          const status = scenario.statusByTeam[input.teamId];
          if (status === "awaiting_data") {
            throw codedError("UNEXPECTED_PROVIDER_RUNTIME");
          }
          if (status === "still_illegal") {
            throw codedError("MATCHUP_LEGALITY_STILL_ILLEGAL");
          }
          return { lock: { id: input.lockId } };
        },
      });
      assert.deepEqual(
        await evidence.coordinator.coordinateCommittedRoster(
          batch([teamA(), teamB()])
        ),
        scenario.expected,
        scenario.name
      );
      assert.equal(evidence.calls.refreshes.length, 0, scenario.name);
    }

    const none = runtime({ targets: () => [] });
    assert.deepEqual(
      await none.coordinator.coordinateCommittedRoster(
        batch([teamA(), teamB()])
      ),
      { status: "not_applicable" }
    );
  });

  test("evaluates every team before one batch refresh and retries only refreshable teams once", async () => {
    const attempts = new Map();
    const { calls, coordinator } = runtime({
      lockLate: async (input) => {
        const count = (attempts.get(input.teamId) || 0) + 1;
        attempts.set(input.teamId, count);
        if (
          count === 1 &&
          [IDS.teamA, IDS.teamC].includes(input.teamId)
        ) {
          throw codedError(
            input.teamId === IDS.teamA
              ? "MATCHUP_LEGALITY_STATISTICS_MISSING"
              : "MATCHUP_LOCK_SOURCE_STALE"
          );
        }
        if (input.teamId === IDS.teamB) {
          throw codedError("MATCHUP_LEGALITY_STILL_ILLEGAL");
        }
        return { lock: { id: input.lockId } };
      },
    });

    assert.deepEqual(
      await coordinator.coordinateCommittedRoster(
        batch([teamA(), teamC(), teamB()])
      ),
      { status: "still_illegal" }
    );
    assert.deepEqual(calls.refreshes, [{}]);
    assert.deepEqual(calls.order, [
      `read:${IDS.teamA}`,
      `lock:${IDS.teamA}`,
      `read:${IDS.teamC}`,
      `lock:${IDS.teamC}`,
      `read:${IDS.teamB}`,
      `lock:${IDS.teamB}`,
      "refresh",
      `read:${IDS.teamA}`,
      `lock:${IDS.teamA}`,
      `read:${IDS.teamC}`,
      `lock:${IDS.teamC}`,
    ]);
    assert.equal(attempts.get(IDS.teamA), 2);
    assert.equal(attempts.get(IDS.teamB), 1);
    assert.equal(attempts.get(IDS.teamC), 2);
  });

  test("still-illegal and not-applicable batches never refresh", async () => {
    const stillIllegal = runtime({
      lockLate: async () => {
        throw codedError("MATCHUP_LEGALITY_STILL_ILLEGAL");
      },
    });
    assert.deepEqual(
      await stillIllegal.coordinator.coordinateCommittedRoster(batch()),
      { status: "still_illegal" }
    );
    assert.deepEqual(stillIllegal.calls.refreshes, []);

    const notApplicable = runtime({ targets: () => [] });
    assert.deepEqual(
      await notApplicable.coordinator.coordinateCommittedRoster(batch()),
      { status: "not_applicable" }
    );
    assert.deepEqual(notApplicable.calls.refreshes, []);
  });

  test("scheduled retry uses the exact occurrence scope, preserves identity, and never refreshes", async () => {
    const occurrence = occurrenceExecution();
    const second = scheduledTarget(IDS.teamC, IDS.lockC);
    const { calls, coordinator } = runtime({
      targets: (input) => {
        assert.deepEqual(input, {
          mode: "scheduled_occurrence",
          leagueId: IDS.leagueA,
          seasonId: IDS.seasonA,
          weekId: IDS.weekA,
          nowMs: 1_000,
        });
        return [second, scheduledTarget(IDS.teamA, IDS.lockA)];
      },
      lockLate: async (input) => {
        if (input.teamId === IDS.teamC) {
          throw codedError("MATCHUP_LEGALITY_STILL_ILLEGAL");
        }
        return { lock: { id: input.lockId } };
      },
    });

    assert.deepEqual(
      await coordinator.retryEligibleLateLocks({
        occurrenceExecution: occurrence,
      }),
      {
        attempted: 2,
        completed: 1,
        awaitingData: 0,
        stillIllegal: 1,
        notApplicable: 0,
      }
    );
    assert.deepEqual(calls.refreshes, []);
    assert.equal(calls.locks.length, 2);
    assert.equal(
      calls.locks.every(
        (command) => command.occurrenceExecution === occurrence
      ),
      true
    );
  });

  test("scheduled attempts are independent and malformed, cross-scope, clock, repository, and logger failures never reject", async () => {
    const occurrence = occurrenceExecution();
    const independent = runtime({
      targets: () => [
        scheduledTarget(IDS.teamA, IDS.lockA),
        scheduledTarget(IDS.teamC, IDS.lockC),
      ],
      lockLate: async (input) => {
        if (input.teamId === IDS.teamA) {
          throw new Error("provider runtime");
        }
        return { lock: { id: input.lockId } };
      },
    });
    assert.deepEqual(
      await independent.coordinator.retryEligibleLateLocks({
        occurrenceExecution: occurrence,
        nowMs: 2_000,
      }),
      {
        attempted: 2,
        completed: 1,
        awaitingData: 1,
        stillIllegal: 0,
        notApplicable: 0,
      }
    );
    assert.equal(independent.calls.locks.length, 2);

    const invalidCases = [
      {},
      { occurrenceExecution: { ...occurrence } },
      {
        occurrenceExecution: occurrenceExecution({
          jobType: "matchup:lock",
        }),
      },
      { occurrenceExecution: occurrence, nowMs: -1 },
      { occurrenceExecution: occurrence, extra: true },
    ];
    const invalid = runtime();
    for (const input of invalidCases) {
      assert.deepEqual(
        await invalid.coordinator.retryEligibleLateLocks(input),
        {
          attempted: 0,
          completed: 0,
          awaitingData: 0,
          stillIllegal: 0,
          notApplicable: 0,
        }
      );
    }

    for (const evidence of [
      runtime({
        targets: () => {
          throw new Error("repository runtime");
        },
      }),
      runtime({
        targets: () => [
          Object.freeze({
            ...scheduledTarget(IDS.teamA, IDS.lockA),
            weekId: IDS.weekB,
          }),
        ],
      }),
      runtime({
        nowMs: () => {
          throw new Error("clock runtime");
        },
        loggerError: () => {
          throw new Error("logger runtime");
        },
      }),
    ]) {
      assert.deepEqual(
        await evidence.coordinator.retryEligibleLateLocks({
          occurrenceExecution: occurrence,
        }),
        {
          attempted: 0,
          completed: 0,
          awaitingData: 0,
          stillIllegal: 0,
          notApplicable: 0,
        }
      );
      assert.deepEqual(evidence.calls.refreshes, []);
    }
  });
});
