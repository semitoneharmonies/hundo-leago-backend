const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMatchupOccurrenceHandlers,
  deterministicEffectId,
} = require("../../src/application/services/matchups/createMatchupOccurrenceHandlers");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function input(jobType) {
  return Object.freeze({
    jobType,
    runId: uuid(1),
    leagueId: uuid(2),
    seasonId: uuid(3),
    weekId: uuid(4),
    scheduledForMs: 100,
    observedAtMs: 125,
  });
}

function harness({ weekStatus = "scheduled", matchupStatus = "scheduled" } = {}) {
  const calls = [];
  let currentWeekStatus = weekStatus;
  let currentMatchupStatus = matchupStatus;
  const matchups = [
    { id: uuid(10), home_team_id: uuid(20), away_team_id: uuid(21) },
    { id: uuid(11), home_team_id: uuid(22), away_team_id: uuid(20) },
  ];
  const handlers = createMatchupOccurrenceHandlers({
    statisticsService: {
      async refresh() {
        calls.push(["refresh"]);
        return { status: "succeeded" };
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
  await evidence.handlers["matchup:baseline"](input("matchup:baseline"));
  await evidence.handlers["matchup:lock"](input("matchup:lock"));
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
    input("matchup:statistics_refresh")
  );
  assert.deepEqual(stats.calls, [["refresh"]]);

  const finalization = harness({ weekStatus: "live", matchupStatus: "live" });
  const result = await finalization.handlers["matchup:finalize"](
    input("matchup:finalize")
  );
  assert.deepEqual(result, { finalizedMatchups: 2 });
  assert.deepEqual(
    finalization.calls.map(([name]) => name),
    ["advance", "finalize", "finalize"]
  );
  assert.deepEqual(
    await finalization.handlers["matchup:rollover"](input("matchup:rollover")),
    { status: "final" }
  );
});

test("finalization reports waiting source as a retryable durable failure", async () => {
  const handlers = createMatchupOccurrenceHandlers({
    statisticsService: { refresh() {} },
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
    handlers["matchup:rollover"](input("matchup:rollover")),
    { code: "MATCHUP_FINAL_SOURCE_WAITING" }
  );
});
