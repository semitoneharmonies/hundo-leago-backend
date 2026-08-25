const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildAcceleratedSeasonTimeline,
} = require("../../src/domain/matchups/acceleratedSeasonPolicy");
const {
  ACCELERATED_SEASON_SERVICE_CODES,
  createAcceleratedSeasonSimulationService,
} = require("../../src/application/services/matchups/createAcceleratedSeasonSimulationService");
const {
  planMatchupSchedule,
} = require("../../src/domain/matchups/matchupSchedulePolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteAcceleratedSeasonRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteAcceleratedSeasonRepository");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT, "database", "migrations");
const IDS = Object.freeze({
  league: uuid(1), otherLeague: uuid(2), season: uuid(3), teamA: uuid(4), teamB: uuid(5),
});
const OPENING_MS = Date.parse("2026-10-06T07:00:00.000Z");
const PLAYOFFS_MS = Date.parse("2027-03-15T07:00:00.000Z");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createPlan() {
  return planMatchupSchedule({
    teamIds: [IDS.teamA, IDS.teamB],
    nhlRegularSeasonStartsAtMs: OPENING_MS,
    fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
    timeZone: "America/Vancouver",
  });
}

function seed(database) {
  const insertLeague = database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1, 1)"
  );
  insertLeague.run(IDS.league, "Simulation League", "simulation league");
  insertLeague.run(IDS.otherLeague, "Other Simulation", "other simulation");
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, regular_season_starts_at_ms, " +
      "fantasy_playoffs_start_at_ms, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', ?, ?, 1, 1, 1)"
  ).run(IDS.season, IDS.league, OPENING_MS, PLAYOFFS_MS);
  const insertWeek = database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, 1, 1)"
  );
  createPlan().weeks.forEach((week, index) => insertWeek.run(
    uuid(100 + index), IDS.league, IDS.season, week.weekKey, week.sequence,
    week.startsAtMs, week.baselineAtMs, week.locksAtMs, week.endsAtMs, week.rollsOverAtMs
  ));
}

function createRuntime(t, handlerFactory) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-11-"));
  const connection = openDatabase({
    databasePath: path.join(root, "simulation.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-11-test",
    now: () => 1,
  });
  seed(connection.database);
  const handlers = handlerFactory();
  const service = createAcceleratedSeasonSimulationService({
    repository: createSqliteAcceleratedSeasonRepository({ database: connection.database }),
    handlers,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

describe("M6-11 accelerated season timeline", () => {
  test("emits exactly four ordered events for every persisted Pacific week", () => {
    const weeks = createPlan().weeks.map((week, index) => ({
      id: uuid(100 + index),
      sequence: week.sequence,
      starts_at_ms: week.startsAtMs,
      baseline_at_ms: week.baselineAtMs,
      locks_at_ms: week.locksAtMs,
      ends_at_ms: week.endsAtMs,
      rolls_over_at_ms: week.rollsOverAtMs,
    }));
    const timeline = buildAcceleratedSeasonTimeline(weeks);
    assert.equal(timeline.length, weeks.length * 4);
    for (let index = 0; index < timeline.length; index += 4) {
      assert.deepEqual(timeline.slice(index, index + 4).map(({ eventType }) => eventType), [
        "baseline", "lock", "end", "rollover",
      ]);
      assert.equal(timeline[index + 3].simulatedAtMs, timeline[index + 2].simulatedAtMs);
    }
    const weekDurations = weeks.map((week) => week.ends_at_ms - week.starts_at_ms);
    assert.equal(weekDurations.some((duration) => duration === 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000), true);
    assert.equal(weekDurations.some((duration) => duration === 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000), true);
  });
});

describe("M6-11 complete accelerated regular season", () => {
  test("completes every event sequentially without timers or database writes", async (t) => {
    const completed = [];
    const handlerFactory = () => Object.fromEntries(
      ["baseline", "lock", "end", "rollover"].map((type) => [type, async (event) => {
        assert.equal(event.eventType, type);
        completed.push(event);
      }])
    );
    const { database, service } = createRuntime(t, handlerFactory);
    const changesBefore = database.prepare("SELECT total_changes() AS count").get().count;
    const result = await service.run({ leagueId: IDS.league, seasonId: IDS.season });
    const changesAfter = database.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(result.weekCount, createPlan().weeks.length);
    assert.equal(result.totalEventCount, result.weekCount * 4);
    assert.equal(result.completedEventCount, result.totalEventCount);
    assert.deepEqual(completed.map(({ eventIndex }) => eventIndex), Array.from({ length: result.totalEventCount }, (_, index) => index));
    assert.equal(changesAfter, changesBefore);
  });

  test("reports one failed checkpoint and resumes the remaining events once", async (t) => {
    const successful = [];
    let shouldFail = true;
    const handlerFactory = () => Object.fromEntries(
      ["baseline", "lock", "end", "rollover"].map((type) => [type, async (event) => {
        if (event.eventIndex === 10 && shouldFail) throw new Error("fixture failure");
        successful.push(event.eventIndex);
      }])
    );
    const { service } = createRuntime(t, handlerFactory);
    let checkpoint;
    await assert.rejects(
      () => service.run({ leagueId: IDS.league, seasonId: IDS.season }),
      (error) => {
        checkpoint = error.checkpoint;
        assert.equal(error.code, ACCELERATED_SEASON_SERVICE_CODES.handlerFailed);
        assert.equal(checkpoint.failedEventIndex, 10);
        assert.equal(checkpoint.completedEventCount, 10);
        return true;
      }
    );
    shouldFail = false;
    const resumed = await service.run({
      leagueId: IDS.league,
      seasonId: IDS.season,
      fromEventIndex: checkpoint.resumeFromEventIndex,
    });
    assert.equal(resumed.completedEventCount, resumed.totalEventCount - 10);
    assert.deepEqual(successful, Array.from({ length: resumed.totalEventCount }, (_, index) => index));
  });

  test("fails cross-scope reads closed and is absent from production composition", async (t) => {
    const handlerFactory = () => Object.fromEntries(
      ["baseline", "lock", "end", "rollover"].map((type) => [type, async () => {}])
    );
    const { service } = createRuntime(t, handlerFactory);
    await assert.rejects(
      () => service.run({ leagueId: IDS.otherLeague, seasonId: IDS.season }),
      { code: ACCELERATED_SEASON_SERVICE_CODES.seasonMissing }
    );
    const productionSources = [
      path.join(ROOT, "server.js"),
      path.join(ROOT, "src", "bootstrap", "createTargetRuntime.js"),
      path.join(ROOT, "src", "bootstrap", "createTargetHttpServer.js"),
    ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(productionSources, /AcceleratedSeason|acceleratedSeason/);
  });
});
