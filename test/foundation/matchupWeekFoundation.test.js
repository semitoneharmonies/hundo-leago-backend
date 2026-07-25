const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_STATUSES,
  MATCHUP_WEEK_CODES,
  WEEK_STATUSES,
  deriveNextWeekTransition,
  isManagerRosterWriteOpen,
  validateWeekBoundaries,
} = require("../../src/domain/matchups/matchupWeekPolicy");
const {
  createMatchupWeekService,
} = require("../../src/application/services/matchups/createMatchupWeekService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupWeekRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupWeekRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const IDS = Object.freeze({
  league: uuid(1),
  otherLeague: uuid(2),
  season: uuid(3),
  week: uuid(4),
  home: uuid(5),
  away: uuid(6),
  matchup: uuid(7),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function seed(database) {
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'active', ?, 1, 1, 1)"
  ).run(IDS.league, "Week League", "week league", "America/Vancouver");
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'active', ?, 1, 1, 1)"
  ).run(IDS.otherLeague, "Other League", "other league", "America/Vancouver");
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.home, IDS.league, "Home", "home");
  insertTeam.run(IDS.away, IDS.league, "Away", "away");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, " +
      "starts_at_ms, baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, " +
      "status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, 1000, 1100, 1200, 2000, 2100, 'scheduled', 1, 1, 1)"
  ).run(IDS.week, IDS.league, IDS.season);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, " +
      "away_team_id, home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Home', 'Away', 'scheduled', 1, 1, 1)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.home, IDS.away);
}

function createRuntime(t, { failBeforeCommit = () => false } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-03-"));
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "week.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m6-03-test",
    now: () => 1,
  });
  seed(connection.database);
  const repository = createSqliteMatchupWeekRepository({
    database: connection.database,
    beforeCommit() {
      if (failBeforeCommit()) throw new Error("late failure");
    },
  });
  let nextId = 500;
  const service = createMatchupWeekService({ repository, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return { database: connection.database, repository, service };
}

describe("M6-03 matchup-week policy", () => {
  test("publishes only the approved week and matchup states", () => {
    assert.deepEqual(WEEK_STATUSES, [
      "scheduled", "baseline_ready", "live", "awaiting_data", "final",
      "correction_required", "cancelled",
    ]);
    assert.deepEqual(MATCHUP_STATUSES, [
      "scheduled", "live", "awaiting_data", "final", "postponed", "cancelled",
      "correction_required",
    ]);
  });

  test("uses inclusive baseline, lock, and end boundaries", () => {
    const boundaries = {
      startsAtMs: 1000,
      baselineAtMs: 1100,
      locksAtMs: 1200,
      endsAtMs: 2000,
      rollsOverAtMs: 2100,
    };
    assert.deepEqual(validateWeekBoundaries(boundaries), boundaries);
    assert.equal(isManagerRosterWriteOpen({ nowMs: 1199, locksAtMs: 1200 }), true);
    assert.equal(isManagerRosterWriteOpen({ nowMs: 1200, locksAtMs: 1200 }), false);
    assert.equal(
      deriveNextWeekTransition({ status: "scheduled", nowMs: 1100, ...boundaries }).toStatus,
      "baseline_ready"
    );
    assert.equal(
      deriveNextWeekTransition({ status: "baseline_ready", nowMs: 1200, ...boundaries }).toStatus,
      "live"
    );
    assert.equal(
      deriveNextWeekTransition({ status: "live", nowMs: 2000, ...boundaries }).toStatus,
      "awaiting_data"
    );
  });

  test("rejects early, malformed, and terminal transitions", () => {
    const input = {
      startsAtMs: 1000,
      baselineAtMs: 1100,
      locksAtMs: 1200,
      endsAtMs: 2000,
      rollsOverAtMs: 2100,
    };
    assert.throws(
      () => deriveNextWeekTransition({ status: "scheduled", nowMs: 1099, ...input }),
      { code: MATCHUP_WEEK_CODES.transitionEarly }
    );
    assert.throws(
      () => deriveNextWeekTransition({ status: "final", nowMs: 3000, ...input }),
      { code: MATCHUP_WEEK_CODES.transitionTerminal }
    );
    assert.throws(
      () => validateWeekBoundaries({ ...input, locksAtMs: 1000 }),
      { code: MATCHUP_WEEK_CODES.inputInvalid }
    );
  });
});

describe("M6-03 atomic matchup-week transitions", () => {
  test("advances one boundary at a time and replays the same operation without writes", (t) => {
    const { database, service } = createRuntime(t);
    const scope = { leagueId: IDS.league, seasonId: IDS.season, weekId: IDS.week };
    assert.equal(service.rosterWriteState({ ...scope, nowMs: 1199 }).open, true);
    assert.equal(service.rosterWriteState({ ...scope, nowMs: 1200 }).open, false);
    assert.throws(() => service.advance({ ...scope, nowMs: 1099 }), {
      code: MATCHUP_WEEK_CODES.transitionEarly,
    });

    const first = service.advance({ ...scope, operationId: uuid(600), nowMs: 1100 });
    assert.equal(first.week.status, "baseline_ready");
    assert.equal(first.replayed, false);
    const replay = service.advance({ ...scope, operationId: uuid(600), nowMs: 1100 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.week.version, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 1);

    assert.equal(
      service.advance({ ...scope, operationId: uuid(601), nowMs: 1200 }).week.status,
      "live"
    );
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "live");
    assert.equal(
      service.advance({ ...scope, operationId: uuid(602), nowMs: 2000 }).week.status,
      "awaiting_data"
    );
    assert.equal(database.prepare("SELECT status FROM matchups").get().status, "awaiting_data");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("makes compare-and-set single-winner and fails cross-league scope closed", (t) => {
    const { database, repository, service } = createRuntime(t);
    const command = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      weekId: IDS.week,
      operationId: uuid(700),
      expectedVersion: 1,
      fromStatus: "scheduled",
      toStatus: "baseline_ready",
      matchupStatus: null,
      effectiveAtMs: 1100,
      nowMs: 1100,
    };
    assert.equal(repository.transitionWeek(command).replayed, false);
    assert.throws(
      () => repository.transitionWeek({ ...command, operationId: uuid(701) }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.throws(
      () => service.rosterWriteState({
        leagueId: IDS.otherLeague,
        seasonId: IDS.season,
        weekId: IDS.week,
        nowMs: 1,
      }),
      { code: "MATCHUP_WEEK_MISSING" }
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 1);
  });

  test("rolls the state, matchup, and operation back after a late failure", (t) => {
    let fail = true;
    const { database, service } = createRuntime(t, { failBeforeCommit: () => fail });
    const scope = { leagueId: IDS.league, seasonId: IDS.season, weekId: IDS.week };
    assert.throws(() => service.advance({ ...scope, operationId: uuid(800), nowMs: 1100 }));
    assert.deepEqual(database.prepare("SELECT status, version FROM matchup_weeks").get(), {
      status: "scheduled",
      version: 1,
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matchup_operations").get().count, 0);
    fail = false;
    assert.equal(
      service.advance({ ...scope, operationId: uuid(800), nowMs: 1100 }).week.status,
      "baseline_ready"
    );
  });
});
