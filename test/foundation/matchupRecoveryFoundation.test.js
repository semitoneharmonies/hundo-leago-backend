const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  MATCHUP_RECOVERY_CODES,
  validateRecoveryCommand,
} = require("../../src/domain/matchups/matchupRecoveryPolicy");
const {
  MATCHUP_RECOVERY_SERVICE_CODES,
  createMatchupRecoveryService,
} = require("../../src/application/services/matchups/createMatchupRecoveryService");
const {
  createMatchupStandingsService,
} = require("../../src/application/services/matchups/createMatchupStandingsService");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteMatchupRecoveryRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupRecoveryRepository");
const {
  createSqliteMatchupStandingsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const IDS = Object.freeze({
  commissioner: uuid(1), outsider: uuid(2), membership: uuid(3), league: uuid(4),
  season: uuid(5), week: uuid(6), teamA: uuid(7), teamB: uuid(8), matchup: uuid(9),
  source: uuid(10), refresh: uuid(11), snapshot: uuid(12), result: uuid(13),
  resultV1: uuid(14), resultV2: uuid(15),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function insertUser(database, id, name) {
  database.prepare(
    "INSERT INTO users (id, email_normalized, email_display, display_name, display_name_normalized, " +
      "status, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(id, `${name}@example.test`, `${name}@example.test`, name, name);
}

function seed(database) {
  insertUser(database, IDS.commissioner, "commissioner");
  insertUser(database, IDS.outsider, "outsider");
  database.prepare(
    "INSERT INTO leagues (id, name, name_normalized, status, timezone, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, 'Recovery League', 'recovery league', 'active', 'America/Vancouver', 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO league_memberships (id, league_id, user_id, permission_category, status, joined_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'commissioner', 'active', 1, 1, 1, 1)"
  ).run(IDS.membership, IDS.league, IDS.commissioner);
  database.prepare("UPDATE leagues SET commissioner_membership_id = ?, updated_at_ms = 2, version = 2 WHERE id = ?")
    .run(IDS.membership, IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, '2026-27', '20262027', 'active', 1, 1, 1)"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  );
  insertTeam.run(IDS.teamA, IDS.league, "Alpha", "alpha");
  insertTeam.run(IDS.teamB, IDS.league, "Bravo", "bravo");
  database.prepare(
    "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, 100, 110, 120, 200, 200, 'final', 1, 1, 1)"
  ).run(IDS.week, IDS.league, IDS.season);
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Alpha', 'Bravo', 'final', 1, 1, 1)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.teamA, IDS.teamB);
  database.prepare(
    "INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version) VALUES (?, 'nhl', 'active', 1, 1, 1)"
  ).run(IDS.source);
  database.prepare(
    "INSERT INTO stat_refreshes (id, stat_source_id, nhl_season_key, source_version, status, started_at_ms, " +
      "completed_at_ms, player_count, version) VALUES (?, ?, '20262027', 'v1', 'succeeded', 199, 200, 0, 1)"
  ).run(IDS.refresh, IDS.source);
  database.prepare(
    "INSERT INTO stat_snapshots (id, stat_source_id, source_refresh_id, league_id, season_id, matchup_week_id, " +
      "intended_use, completeness_status, freshness_status, captured_at_ms, committed, created_at_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'matchup_final', 'complete', 'fresh', 200, 1, 200)"
  ).run(IDS.snapshot, IDS.source, IDS.refresh, IDS.league, IDS.season, IDS.week);
  database.prepare(
    "INSERT INTO matchup_results (id, league_id, season_id, matchup_id, current_version_id, status, " +
      "finalized_at_ms, created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, 200, 200, 1)"
  ).run(IDS.result, IDS.league, IDS.season, IDS.matchup);
  database.prepare(
    "INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, version_number, " +
      "home_team_id, away_team_id, home_score_hundredths, away_score_hundredths, outcome, source_snapshot_id, " +
      "source_type, actor_user_id, reason, supersedes_version_id, created_at_ms) " +
      "VALUES (?, ?, ?, ?, 1, ?, ?, 300, 100, 'home_win', ?, 'calculated', NULL, NULL, NULL, 200)"
  ).run(IDS.resultV1, IDS.league, IDS.season, IDS.result, IDS.teamA, IDS.teamB, IDS.snapshot);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'official', finalized_at_ms = 200 WHERE id = ?"
  ).run(IDS.resultV1, IDS.result);
}

function createRuntime(t, { beforeCommit } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m6-10-"));
  const connection = openDatabase({ databasePath: path.join(root, "recovery.sqlite3"), environment: "test" });
  migrateDatabase({ database: connection.database, migrationsDirectory: MIGRATIONS_DIRECTORY, applicationBuildId: "m6-10-test", now: () => 1 });
  seed(connection.database);
  const standingsService = createMatchupStandingsService({
    repository: createSqliteMatchupStandingsRepository({ database: connection.database }),
  });
  const repository = createSqliteMatchupRecoveryRepository({ database: connection.database, beforeCommit });
  let nextId = 500;
  const service = createMatchupRecoveryService({ repository, standingsService, createId: () => uuid(nextId++) });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database: connection.database, service };
}

function matchupInput(operationId = uuid(400)) {
  return {
    leagueId: IDS.league, seasonId: IDS.season, weekId: IDS.week, matchupId: IDS.matchup,
    actorUserId: IDS.commissioner, operationId, nowMs: 300,
  };
}

function appendCorrection(database) {
  database.prepare(
    "INSERT INTO matchup_result_versions (id, league_id, season_id, matchup_result_id, version_number, " +
      "home_team_id, away_team_id, home_score_hundredths, away_score_hundredths, outcome, source_snapshot_id, " +
      "source_type, actor_user_id, reason, supersedes_version_id, created_at_ms) " +
      "VALUES (?, ?, ?, ?, 2, ?, ?, 50, 200, 'away_win', ?, 'correction', ?, 'Recovery correction', ?, 301)"
  ).run(IDS.resultV2, IDS.league, IDS.season, IDS.result, IDS.teamA, IDS.teamB, IDS.snapshot, IDS.commissioner, IDS.resultV1);
  database.prepare(
    "UPDATE matchup_results SET current_version_id = ?, status = 'corrected', updated_at_ms = 301, version = 2 WHERE id = ?"
  ).run(IDS.resultV2, IDS.result);
}

describe("M6-10 explicit recovery policy", () => {
  test("requires exact confirmation, bounded reason, and expected version", () => {
    assert.deepEqual(validateRecoveryCommand({ confirmed: true, reason: "Recover", expectedVersion: 1 }), {
      reason: "Recover", expectedVersion: 1,
    });
    assert.throws(() => validateRecoveryCommand({ confirmed: false, reason: "Recover", expectedVersion: 1 }), {
      code: MATCHUP_RECOVERY_CODES.confirmationRequired,
    });
  });
});

describe("M6-10 commissioner matchup and standings recovery", () => {
  test("keeps previews read-only and routes only an explicitly confirmed matchup", (t) => {
    const { database, service } = createRuntime(t);
    const changes = database.prepare("SELECT total_changes() AS count").get().count;
    const preview = service.previewMatchup(matchupInput());
    assert.equal(preview.matchupStatus, "final");
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, changes);
    assert.throws(() => service.previewMatchup({ ...matchupInput(), actorUserId: IDS.outsider }), {
      code: MATCHUP_RECOVERY_SERVICE_CODES.commissionerRequired,
    });
    const command = {
      ...matchupInput(), confirmed: true, reason: "Provider correction needs review",
      expectedVersion: preview.expectedVersion, expectedWeekVersion: preview.expectedWeekVersion,
    };
    const routed = service.routeMatchup(command);
    assert.equal(routed.replayed, false);
    assert.equal(routed.matchup.status, "correction_required");
    assert.equal(routed.matchup.week_status, "correction_required");
    assert.equal(service.routeMatchup(command).replayed, true);
    const operation = database.prepare("SELECT * FROM matchup_operations").get();
    assert.equal(operation.actor_user_id, IDS.commissioner);
    assert.equal(operation.reason, command.reason);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("rebuilds current standings, preserves superseded snapshots, and replays exactly", (t) => {
    const { database, service } = createRuntime(t);
    const first = service.previewStandings({ leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner });
    assert.equal(first.currentSnapshotId, null);
    assert.equal(first.projection.rows[0].teamDisplayName, "Alpha");
    const firstCommand = {
      leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner,
      operationId: uuid(410), confirmed: true, reason: "Initial authoritative rebuild",
      expectedVersion: first.expectedVersion, expectedCurrentSnapshotId: null, nowMs: 300,
    };
    const rebuilt = service.rebuildStandings(firstCommand);
    assert.equal(rebuilt.context.currentSnapshot.snapshot_version, 1);
    assert.equal(rebuilt.context.currentSnapshot.source_result_version, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_rows").get().count, 2);

    appendCorrection(database);
    const second = service.previewStandings({ leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner });
    assert.equal(second.projection.rows[0].teamDisplayName, "Bravo");
    const secondCommand = {
      leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner,
      operationId: uuid(411), confirmed: true, reason: "Propagate corrected result",
      expectedVersion: second.expectedVersion, expectedCurrentSnapshotId: second.currentSnapshotId, nowMs: 302,
    };
    const replacement = service.rebuildStandings(secondCommand);
    assert.equal(replacement.context.currentSnapshot.snapshot_version, 2);
    assert.equal(replacement.context.currentSnapshot.source_result_version, 2);
    assert.deepEqual(database.prepare("SELECT status FROM standings_snapshots ORDER BY snapshot_version").all(), [
      { status: "superseded" }, { status: "current" },
    ]);
    assert.equal(service.rebuildStandings(secondCommand).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_snapshots").get().count, 2);
    assert.equal(database.prepare("SELECT actor_user_id FROM standings_operations WHERE id = ?").get(uuid(411)).actor_user_id, IDS.commissioner);
  });

  test("allows a previously authorized platform administrator to perform recovery without impersonation", (t) => {
    const { database, service } = createRuntime(t);
    const changes = database.prepare("SELECT total_changes() AS count").get().count;
    const authority = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.outsider,
      authorizedAsPlatformAdministrator: true,
    };
    const preview = service.previewStandings(authority);

    assert.equal(preview.projection.rows.length, 2);
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, changes);
    const rebuilt = service.rebuildStandings({
      ...authority,
      operationId: uuid(430),
      confirmed: true,
      reason: "Platform administrator standings recovery",
      expectedVersion: preview.expectedVersion,
      expectedCurrentSnapshotId: preview.currentSnapshotId,
      nowMs: 300,
    });
    assert.equal(rebuilt.replayed, false);
    assert.equal(
      database
        .prepare("SELECT actor_user_id FROM standings_operations WHERE id = ?")
        .get(uuid(430)).actor_user_id,
      IDS.outsider
    );

    const matchupPreview = service.previewMatchup({
      ...authority,
      weekId: IDS.week,
      matchupId: IDS.matchup,
      operationId: uuid(431),
      nowMs: 301,
    });
    const routed = service.routeMatchup({
      ...authority,
      weekId: IDS.week,
      matchupId: IDS.matchup,
      operationId: uuid(431),
      confirmed: true,
      reason: "Platform administrator matchup recovery",
      expectedVersion: matchupPreview.expectedVersion,
      expectedWeekVersion: matchupPreview.expectedWeekVersion,
      nowMs: 301,
    });
    assert.equal(routed.replayed, false);
    assert.equal(
      database
        .prepare("SELECT actor_user_id FROM matchup_operations WHERE id = ?")
        .get(uuid(431)).actor_user_id,
      IDS.outsider
    );
  });

  test("rolls a late standings rebuild failure back without superseding current", (t) => {
    let fail = false;
    const { database, service } = createRuntime(t, {
      beforeCommit(operation) { if (operation === "standings" && fail) throw new Error("late standings failure"); },
    });
    const preview = service.previewStandings({ leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner });
    const command = {
      leagueId: IDS.league, seasonId: IDS.season, actorUserId: IDS.commissioner,
      operationId: uuid(420), confirmed: true, reason: "Rebuild", expectedVersion: 1,
      expectedCurrentSnapshotId: null, nowMs: 300,
    };
    fail = true;
    assert.throws(() => service.rebuildStandings(command));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_snapshots").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_rows").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_operations").get().count, 0);
    fail = false;
    assert.equal(service.rebuildStandings({ ...command, expectedVersion: preview.expectedVersion }).replayed, false);
  });
});
