const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMatchupOccurrenceHandlers,
  deterministicEffectId,
} = require("../../src/application/services/matchups/createMatchupOccurrenceHandlers");
const {
  M6_JOB_TYPES,
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");

const OBSERVED_AT_MS = 125;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function input(jobType, overrides = {}) {
  const scope = {
    bindingId: uuid(5),
    claimedJobVersion: 2,
    jobType,
    leagueId: uuid(2),
    leaseExpiresAtMs: 1_000,
    leaseOwner: "matchup-worker",
    leaseToken: "lease-token",
    runId: uuid(1),
    scheduleOperationId: uuid(6),
    scheduleVersion: 1,
    scheduledForMs: 100,
    seasonId: uuid(3),
    weekId: uuid(4),
    ...overrides,
  };
  return Object.freeze({
    ...scope,
    occurrenceKey:
      overrides.occurrenceKey ||
      buildMatchupOccurrenceKey(scope),
  });
}

function harness({
  weekStatus = "scheduled",
  matchupStatus = "scheduled",
  refreshResult = Object.freeze({ status: "succeeded" }),
  refreshImplementation,
  retryImplementation,
} = {}) {
  const calls = [];
  let currentWeekStatus = weekStatus;
  let currentMatchupStatus = matchupStatus;
  const matchups = [
    { id: uuid(10), home_team_id: uuid(20), away_team_id: uuid(21) },
    { id: uuid(11), home_team_id: uuid(22), away_team_id: uuid(20) },
  ];
  const handlers = createMatchupOccurrenceHandlers({
    statisticsService: {
      async refresh(command) {
        calls.push(["refresh", command]);
        if (refreshImplementation) return refreshImplementation(command);
        return refreshResult;
      },
    },
    lateLockCoordinator: {
      retryEligibleLateLocks(command) {
        calls.push(["retryLateLocks", command]);
        if (retryImplementation) return retryImplementation(command);
        return Object.freeze([]);
      },
    },
    readRepository: {
      readWeek() {
        return {
          week: { status: currentWeekStatus },
          matchups: matchups.map((matchup) => ({
            ...matchup,
            status: currentMatchupStatus,
          })),
        };
      },
      readMatchup() {},
    },
    weekService: {
      advance(command) {
        calls.push(["advance", command]);
        if (currentWeekStatus === "scheduled") currentWeekStatus = "baseline_ready";
        else if (currentWeekStatus === "baseline_ready") {
          currentWeekStatus = "live";
          currentMatchupStatus = "live";
        } else if (currentWeekStatus === "live") {
          currentWeekStatus = "awaiting_data";
          currentMatchupStatus = "awaiting_data";
        }
        return { week: { status: currentWeekStatus } };
      },
    },
    legalityService: {
      lockAtBoundary(command) {
        calls.push(["lock", command]);
        return { lock: { id: command.lockId } };
      },
    },
    resultService: {
      finalize(command) {
        calls.push(["finalize", command]);
        currentMatchupStatus = "final";
        currentWeekStatus = "final";
        return { finalized: true };
      },
    },
  });
  return { calls, handlers };
}

test("deterministic effect IDs are stable UUIDs and distinct by effect", () => {
  const first = deterministicEffectId(uuid(1), "lock:one");
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(first, deterministicEffectId(uuid(1), "lock:one"));
  assert.notEqual(first, deterministicEffectId(uuid(1), "lock:two"));
});

test("baseline and lock handlers transition first and lock each team once", async () => {
  const evidence = harness();
  await evidence.handlers["matchup:baseline"](
    input("matchup:baseline"),
    OBSERVED_AT_MS
  );
  await evidence.handlers["matchup:lock"](
    input("matchup:lock"),
    OBSERVED_AT_MS
  );
  assert.deepEqual(
    evidence.calls.map(([name]) => name),
    ["advance", "advance", "lock", "lock", "lock"]
  );
  const lockCalls = evidence.calls.filter(([name]) => name === "lock");
  assert.deepEqual(
    lockCalls.map(([, command]) => command.teamId),
    [uuid(20), uuid(21), uuid(22)]
  );
  assert.equal(new Set(lockCalls.map(([, command]) => command.lockId)).size, 3);
});

test("statistics, finalize, and rollover handlers invoke real bounded services", async () => {
  const stats = harness();
  await stats.handlers["matchup:statistics_refresh"](
    input("matchup:statistics_refresh"),
    OBSERVED_AT_MS
  );
  assert.deepEqual(
    stats.calls.map(([name]) => name),
    ["refresh", "retryLateLocks"]
  );

  const finalization = harness({ weekStatus: "live", matchupStatus: "live" });
  const result = await finalization.handlers["matchup:finalize"](
    input("matchup:finalize"),
    OBSERVED_AT_MS
  );
  assert.deepEqual(result, { finalizedMatchups: 2 });
  assert.deepEqual(
    finalization.calls.map(([name]) => name),
    ["advance", "finalize", "finalize"]
  );
  assert.deepEqual(
    await finalization.handlers["matchup:rollover"](
      input("matchup:rollover"),
      OBSERVED_AT_MS
    ),
    { status: "final" }
  );
});

test("all M6 handlers forward the exact claimed execution object to every effect", async () => {
  for (const jobType of M6_JOB_TYPES) {
    const evidence = harness();
    const occurrenceExecution = input(jobType);
    await evidence.handlers[jobType](
      occurrenceExecution,
      OBSERVED_AT_MS
    );
    const effectCalls = evidence.calls.filter(([name]) =>
      ["refresh", "retryLateLocks", "advance", "lock", "finalize"].includes(
        name
      )
    );
    assert.ok(effectCalls.length > 0, `${jobType} must invoke a guarded effect`);
    for (const [effectName, command] of effectCalls) {
      assert.equal(
        command.occurrenceExecution,
        occurrenceExecution,
        `${jobType} ${effectName} must preserve execution identity`
      );
    }
  }
});

test("statistics refresh retries eligible late locks afterward without changing identities", async () => {
  const refreshResult = Object.freeze({ status: "succeeded", version: 7 });
  const occurrenceExecution = input("matchup:statistics_refresh");
  const evidence = harness({ refreshResult });

  const result = await evidence.handlers["matchup:statistics_refresh"](
    occurrenceExecution,
    OBSERVED_AT_MS
  );

  assert.equal(result, refreshResult);
  assert.deepEqual(
    evidence.calls.map(([name]) => name),
    ["refresh", "retryLateLocks"]
  );
  assert.equal(evidence.calls[0][1].occurrenceExecution, occurrenceExecution);
  assert.equal(evidence.calls[1][1].occurrenceExecution, occurrenceExecution);
  assert.deepEqual(Object.keys(evidence.calls[1][1]), ["occurrenceExecution"]);
});

test("statistics refresh failure skips the late-lock retry hook", async () => {
  const failure = new Error("refresh failed");
  const evidence = harness({
    refreshImplementation() {
      throw failure;
    },
  });

  await assert.rejects(
    evidence.handlers["matchup:statistics_refresh"](
      input("matchup:statistics_refresh"),
      OBSERVED_AT_MS
    ),
    (error) => error === failure
  );
  assert.deepEqual(
    evidence.calls.map(([name]) => name),
    ["refresh"]
  );
});

test("late-lock retry hook failures cannot alter a successful refresh", async () => {
  for (const retryImplementation of [
    () => {
      throw new Error("synchronous retry failure");
    },
    async () => {
      throw new Error("asynchronous retry failure");
    },
  ]) {
    const refreshResult = Object.freeze({ status: "succeeded" });
    const evidence = harness({ refreshResult, retryImplementation });

    const result = await evidence.handlers["matchup:statistics_refresh"](
      input("matchup:statistics_refresh"),
      OBSERVED_AT_MS
    );

    assert.equal(result, refreshResult);
    assert.deepEqual(
      evidence.calls.map(([name]) => name),
      ["refresh", "retryLateLocks"]
    );
  }
});

test("handlers reject missing, mutable, inexact, mismatched, and malformed execution contexts", async () => {
  const valid = input("matchup:baseline");
  const cases = [
    ["missing", undefined, OBSERVED_AT_MS],
    ["mutable", { ...valid }, OBSERVED_AT_MS],
    ["inexact", Object.freeze({ ...valid, extra: true }), OBSERVED_AT_MS],
    ["wrong job", input("matchup:lock"), OBSERVED_AT_MS],
    [
      "mismatched scope",
      input("matchup:baseline", {
        leagueId: uuid(30),
        occurrenceKey: valid.occurrenceKey,
      }),
      OBSERVED_AT_MS,
    ],
    ["missing observation time", valid, undefined],
  ];
  for (const [description, occurrenceExecution, observedAtMs] of cases) {
    const evidence = harness();
    await assert.rejects(
      evidence.handlers["matchup:baseline"](
        occurrenceExecution,
        observedAtMs
      ),
      { code: "MATCHUP_OCCURRENCE_EXECUTION_INVALID" },
      description
    );
    assert.deepEqual(evidence.calls, [], description);
  }
});

test("finalization reports waiting source as a retryable durable failure", async () => {
  const handlers = createMatchupOccurrenceHandlers({
    statisticsService: { refresh() {} },
    lateLockCoordinator: { retryEligibleLateLocks() {} },
    readRepository: {
      readWeek: () => ({
        week: { status: "awaiting_data" },
        matchups: [
          { id: uuid(10), status: "awaiting_data", home_team_id: uuid(20), away_team_id: uuid(21) },
        ],
      }),
      readMatchup() {},
    },
    weekService: { advance() {} },
    legalityService: { lockAtBoundary() {} },
    resultService: { finalize: () => ({ finalized: false }) },
  });
  await assert.rejects(
    handlers["matchup:rollover"](
      input("matchup:rollover"),
      OBSERVED_AT_MS
    ),
    { code: "MATCHUP_FINAL_SOURCE_WAITING" }
  );
});
