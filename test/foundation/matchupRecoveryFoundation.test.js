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
const {
  createMatchupResultCorrectionService,
} = require("../../src/application/services/matchups/createMatchupResultCorrectionService");
const {
  calculateStandingsResultSetHash,
} = require("../../src/domain/matchups/matchupStandingsFinalizationPolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteMatchupRecoveryRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupRecoveryRepository");
const {
  createSqliteMatchupStandingsRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsRepository");
const {
  STANDINGS_FINALIZATION_OPERATION,
  createSqliteMatchupStandingsFinalizationRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsFinalizationRepository");
const {
  createSqliteMatchupResultCorrectionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupResultCorrectionRepository");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_STARTS_AT_MS = 100;
const WEEK_ENDS_AT_MS = WEEK_STARTS_AT_MS + WEEK_MS;
const FINALIZED_AT_MS = WEEK_ENDS_AT_MS + 100;
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
    "INSERT INTO league_settings (league_id, salary_cap_cents, trade_deadline_at_ms, maximum_teams, " +
      "active_forward_slots, active_defence_slots, bench_slots, maximum_bench_aav_cents, " +
      "injured_reserve_slots, prospect_slots_unlimited, scoring_rule_version, standings_rule_version, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, 10000, NULL, 20, 12, 6, 4, 400, 4, 1, 1, 1, 1, 1, 1)"
  ).run(IDS.league);
  database.prepare(
    "INSERT INTO league_memberships (id, league_id, user_id, permission_category, status, joined_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, ?, 'commissioner', 'active', 1, 1, 1, 1)"
  ).run(IDS.membership, IDS.league, IDS.commissioner);
  database.prepare("UPDATE leagues SET commissioner_membership_id = ?, updated_at_ms = 2, version = 2 WHERE id = ?")
    .run(IDS.membership, IDS.league);
  database.prepare(
    "INSERT INTO seasons (id, league_id, label, nhl_season_key, status, regular_season_starts_at_ms, " +
      "regular_season_ends_at_ms, fantasy_playoffs_start_at_ms, fantasy_playoffs_end_at_ms, " +
      "created_at_ms, updated_at_ms, version) VALUES (?, ?, '2026-27', '20262027', 'active', ?, ?, ?, ?, 1, 1, 1)"
  ).run(
    IDS.season,
    IDS.league,
    WEEK_STARTS_AT_MS,
    WEEK_ENDS_AT_MS,
    WEEK_ENDS_AT_MS,
    WEEK_ENDS_AT_MS + WEEK_MS
  );
  database.prepare(
    "UPDATE leagues SET current_season_id = ? WHERE id = ?"
  ).run(IDS.season, IDS.league);
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, league_id, name, name_normalized, status, primary_colour, secondary_colour, " +
      "pattern_template, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, 'active', ?, ?, 'even-two', 1, 1, 1)"
  );
  insertTeam.run(IDS.teamA, IDS.league, "Alpha", "alpha", "#112233", "#abcdef");
  insertTeam.run(IDS.teamB, IDS.league, "Bravo", "bravo", "#445566", "#fedcba");
  database.prepare(
      "INSERT INTO matchup_weeks (id, league_id, season_id, week_key, sequence, starts_at_ms, baseline_at_ms, " +
      "locks_at_ms, ends_at_ms, rolls_over_at_ms, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, ?, 110, 120, ?, ?, 'final', 1, 1, 1)"
  ).run(
    IDS.week,
    IDS.league,
    IDS.season,
    WEEK_STARTS_AT_MS,
    WEEK_ENDS_AT_MS,
    WEEK_ENDS_AT_MS
  );
  database.prepare(
    "INSERT INTO matchups (id, league_id, season_id, matchup_week_id, home_team_id, away_team_id, " +
      "home_team_name, away_team_name, status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Alpha', 'Bravo', 'final', 1, 1, 1)"
  ).run(IDS.matchup, IDS.league, IDS.season, IDS.week, IDS.teamA, IDS.teamB);
  database.prepare(
    "INSERT INTO matchup_operations (id, league_id, season_id, matchup_week_id, matchup_id, actor_user_id, " +
      "operation_type, status, reason, metadata_json, started_at_ms, completed_at_ms) " +
      "VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate', 'succeeded', NULL, ?, 1, 1)"
  ).run(
    uuid(100),
    IDS.league,
    IDS.season,
    IDS.commissioner,
    JSON.stringify({
      participantCount: 2,
      participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
      weekCount: 1,
      matchupCount: 1,
      jobOccurrenceCount: 0,
    })
  );
  database.prepare(
    "INSERT INTO season_matchup_schedule_generations (league_id, season_id, schedule_version, " +
      "schedule_operation_id, week_one_matchup_week_id, week_one_starts_at_ms, status, " +
      "created_at_ms, superseded_at_ms, version) VALUES (?, ?, 1, ?, ?, ?, 'current', 1, NULL, 1)"
  ).run(
    IDS.league,
    IDS.season,
    uuid(100),
    IDS.week,
    WEEK_STARTS_AT_MS
  );
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
  return { database: connection.database, repository, service };
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

function insertSnapshot(database, {
  id,
  snapshotVersion,
  sourceResultVersion = 1,
  status = "final",
  nowMs = 300,
}) {
  database.prepare(
    "INSERT INTO standings_snapshots (id, league_id, season_id, snapshot_version, source_result_version, " +
      "status, calculated_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    IDS.league,
    IDS.season,
    snapshotVersion,
    sourceResultVersion,
    status,
    nowMs,
    nowMs
  );
}

function finalizationResultSetHash({
  resultVersionId,
  resultVersion,
}) {
  return calculateStandingsResultSetHash({
    leagueId: IDS.league,
    seasonId: IDS.season,
    standingsRuleVersion: "1",
    results: [
      {
        matchupId: IDS.matchup,
        matchupResultId: IDS.result,
        resultVersionId,
        resultVersion,
      },
    ],
  });
}

function finalizationRow(row, id) {
  return {
    id,
    teamId: row.teamId,
    rank: row.rank,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    standingsPoints: row.standingsPoints,
    fantasyPointsForHundredths:
      row.fantasyPointsForHundredths,
    fantasyPointsAgainstHundredths:
      row.fantasyPointsAgainstHundredths,
    fantasyPointsDifferentialHundredths:
      row.fantasyPointsDifferentialHundredths,
  };
}

function finalizationIdentity(participant, id) {
  return {
    id,
    teamId: participant.team_id,
    teamDisplayName: participant.team_display_name,
    primaryColour: participant.primary_colour,
    secondaryColour: participant.secondary_colour,
    tertiaryColour: participant.tertiary_colour,
    patternTemplate: participant.pattern_template,
    sourceLogoObjectId: participant.source_logo_object_id,
    logoMediaType: participant.logo_media_type,
    logoByteLength: participant.logo_byte_length,
    logoWidth: participant.logo_width,
    logoHeight: participant.logo_height,
    logoContentSha256:
      participant.logo_content_sha256,
    logoContentBytes: participant.logo_content_bytes,
  };
}

function seedT145FinalizationHistory(database, {
  snapshotId = uuid(600),
  finalizationId = uuid(601),
  operationId = uuid(602),
  idempotencyRequestId = uuid(603),
  insertSnapshotRecord = true,
  complete = true,
} = {}) {
  const repositoryContext =
    createSqliteRepositoryContext({ database });
  const repository =
    createSqliteMatchupStandingsFinalizationRepository({
      database,
    });
  const context = repository.readFinalizationContext({
    leagueId: IDS.league,
    seasonId: IDS.season,
  });
  const projection = createMatchupStandingsService({
    repository: createSqliteMatchupStandingsRepository({
      database,
    }),
  }).read({
    leagueId: IDS.league,
    seasonId: IDS.season,
  });
  const result = context.results[0];
  const resultSetHash = finalizationResultSetHash({
    resultVersionId: result.result_version_id,
    resultVersion: result.version_number,
  });
  const offset = Number(finalizationId.slice(-12));

  repositoryContext.transaction(() => {
    repository.insertStartedIdempotency({
      id: idempotencyRequestId,
      leagueId: IDS.league,
      actorUserId: IDS.commissioner,
      operation: STANDINGS_FINALIZATION_OPERATION,
      clientKey: `canonical-finalization-${finalizationId}`,
      requestHash: "a".repeat(64),
      createdAtMs: FINALIZED_AT_MS,
      expiresAtMs: FINALIZED_AT_MS + 86_400_000,
    });
    const currentSnapshot = database.prepare(
      "SELECT id FROM standings_snapshots WHERE league_id = ? AND season_id = ? AND status = 'current'"
    ).get(IDS.league, IDS.season);
    if (currentSnapshot) {
      repository.supersedeCurrentDerivedSnapshot({
        leagueId: IDS.league,
        seasonId: IDS.season,
        snapshotId: currentSnapshot.id,
      });
    }
    if (insertSnapshotRecord) {
      repository.insertFinalSnapshot({
        id: snapshotId,
        leagueId: IDS.league,
        seasonId: IDS.season,
        snapshotVersion: 1,
        sourceResultVersion:
          result.version_number,
        nowMs: FINALIZED_AT_MS,
      });
      repository.insertStandingsRows({
        leagueId: IDS.league,
        seasonId: IDS.season,
        snapshotId,
        rows: projection.rows.map((row, index) =>
          finalizationRow(row, uuid(offset + 20 + index))
        ),
      });
    } else {
      database.prepare(
        "UPDATE standings_snapshots SET status = 'final', calculated_at_ms = ? " +
          "WHERE league_id = ? AND season_id = ? AND id = ?"
      ).run(
        FINALIZED_AT_MS,
        IDS.league,
        IDS.season,
        snapshotId
      );
    }
    repository.insertResultVersionLinks({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId,
      links: [
        {
          id: uuid(offset + 22),
          matchupWeekId: IDS.week,
          matchupId: IDS.matchup,
          matchupResultId: IDS.result,
          resultVersionId: result.result_version_id,
          resultVersionNumber:
            result.version_number,
        },
      ],
      nowMs: FINALIZED_AT_MS,
    });
    repository.insertTeamIdentities({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId,
      identities: context.participants.map(
        (participant, index) =>
          finalizationIdentity(
            participant,
            uuid(offset + 23 + index)
          )
      ),
      nowMs: FINALIZED_AT_MS,
    });
    repository.insertSucceededOperation({
      id: operationId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId,
      actorUserId: IDS.commissioner,
      actorMembershipId: IDS.membership,
      actorAuthority: "commissioner",
      idempotencyRequestId,
      metadataJson: JSON.stringify({
        resultSetHash,
        standingsRuleVersion: 1,
      }),
      nowMs: FINALIZED_AT_MS,
    });
    repository.insertFinalizationEvidence({
      id: finalizationId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId,
      finalizationVersion: 1,
      standingsRuleVersion: 1,
      resultSetHash,
      expectedMatchupCount: 1,
      expectedWeekCount: 1,
      participantCount: 2,
      seasonVersionBefore: 1,
      actorUserId: IDS.commissioner,
      actorMembershipId: IDS.membership,
      actorAuthority: "commissioner",
      operationId,
      idempotencyRequestId,
      nowMs: FINALIZED_AT_MS,
    });
    if (complete) {
      for (const [index, userId] of
        context.activeMemberUserIds.entries()) {
        repository.writeFinalizedNotification({
          id: uuid(offset + 25 + index),
          leagueId: IDS.league,
          seasonId: IDS.season,
          finalizationId,
          snapshotId,
          userId,
          nowMs: FINALIZED_AT_MS,
        });
      }
      repository.writeFinalizedOutbox({
        id: uuid(offset + 30),
        leagueId: IDS.league,
        seasonId: IDS.season,
        snapshotId,
        seasonVersion: 2,
        nowMs: FINALIZED_AT_MS,
      });
      repository.advanceSeasonVersion({
        leagueId: IDS.league,
        seasonId: IDS.season,
        expectedVersion: 1,
        nowMs: FINALIZED_AT_MS,
      });
      repository.completeIdempotency({
        id: idempotencyRequestId,
        leagueId: IDS.league,
        finalizationId,
        completedAtMs: FINALIZED_AT_MS,
      });
    }
  });
  return Object.freeze({
    snapshotId,
    finalizationId,
    operationId,
    idempotencyRequestId,
  });
}

function seedT097ReplacementHistory(database) {
  const initial = seedT145FinalizationHistory(database);
  const repositoryContext =
    createSqliteRepositoryContext({ database });
  const repository =
    createSqliteMatchupResultCorrectionRepository({
      database,
    });
  let nextId = 700;
  const service = createMatchupResultCorrectionService({
    repositoryContext,
    repository,
    leagueAuthorization: {
      requireCommissioner() {
        return {
          actorUserId: IDS.commissioner,
          membershipId: IDS.membership,
          authority: "commissioner",
        };
      },
    },
    clock: {
      nowMs() {
        return FINALIZED_AT_MS + 1;
      },
    },
    secureRandom: {
      id() {
        nextId += 1;
        return uuid(nextId);
      },
    },
  });
  service.correct({
    leagueId: IDS.league,
    seasonId: IDS.season,
    resultId: IDS.result,
    input: {
      confirmed: true,
      homeScoreHundredths: 50,
      awayScoreHundredths: 200,
      reason: "Recovery correction",
    },
    expectedResultVersion: 1,
    idempotencyKey: "canonical-recovery-correction",
    authenticated: { session: { id: null } },
    auditContext: {},
  });
  const replacementRow = database.prepare(
    "SELECT id, standings_snapshot_id FROM standings_snapshot_finalizations " +
      "WHERE league_id = ? AND season_id = ? AND cause = 'result_correction'"
  ).get(IDS.league, IDS.season);
  const replacement = Object.freeze({
    snapshotId: replacementRow.standings_snapshot_id,
    finalizationId: replacementRow.id,
  });
  return Object.freeze({ initial, replacement });
}

function captureStandingsEvidence(database) {
  return Object.freeze({
    snapshots: database.prepare(
      "SELECT * FROM standings_snapshots ORDER BY snapshot_version, id"
    ).all(),
    rows: database.prepare(
      "SELECT * FROM standings_rows ORDER BY standings_snapshot_id, rank, team_id, id"
    ).all(),
    finalizations: database.prepare(
      "SELECT * FROM standings_snapshot_finalizations ORDER BY finalization_version, id"
    ).all(),
    resultLinks: database.prepare(
      "SELECT * FROM standings_snapshot_result_versions ORDER BY standings_snapshot_id, id"
    ).all(),
    teamIdentities: database.prepare(
      "SELECT * FROM standings_snapshot_team_identities ORDER BY standings_snapshot_id, team_id, id"
    ).all(),
    operations: database.prepare(
      "SELECT * FROM standings_operations ORDER BY started_at_ms, id"
    ).all(),
    idempotency: database.prepare(
      "SELECT * FROM idempotency_requests ORDER BY created_at_ms, id"
    ).all(),
    season: database.prepare(
      "SELECT version, updated_at_ms FROM seasons WHERE league_id = ? AND id = ?"
    ).get(IDS.league, IDS.season),
    activity: database.prepare(
      "SELECT * FROM league_activity ORDER BY occurred_at_ms, id"
    ).all(),
  });
}

function repositoryRows(projection, firstId = 700) {
  return Object.freeze(projection.rows.map((row, index) => Object.freeze({
    rowId: uuid(firstId + index),
    teamId: row.teamId,
    rank: row.rank,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    standingsPoints: row.standingsPoints,
    fantasyPointsForHundredths: row.fantasyPointsForHundredths,
    fantasyPointsAgainstHundredths: row.fantasyPointsAgainstHundredths,
    fantasyPointsDifferentialHundredths:
      row.fantasyPointsDifferentialHundredths,
  })));
}

function createDerivedRebuild(service, {
  operationId = uuid(800),
  reason = "Create replay evidence",
  nowMs = 300,
} = {}) {
  const preview = service.previewStandings({
    leagueId: IDS.league,
    seasonId: IDS.season,
    actorUserId: IDS.commissioner,
  });
  const command = {
    leagueId: IDS.league,
    seasonId: IDS.season,
    actorUserId: IDS.commissioner,
    operationId,
    confirmed: true,
    reason,
    expectedVersion: preview.expectedVersion,
    expectedCurrentSnapshotId: preview.currentSnapshotId,
    nowMs,
  };
  return Object.freeze({
    command: Object.freeze(command),
    result: service.rebuildStandings(command),
  });
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
    const operation = database.prepare(
      "SELECT * FROM matchup_operations WHERE league_id = ? AND id = ?"
    ).get(IDS.league, command.operationId);
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
    assert.equal(rebuilt.context.rows.length, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_rows").get().count, 2);
    const firstOperation = database.prepare(
      "SELECT metadata_json FROM standings_operations WHERE league_id = ? AND id = ?"
    ).get(IDS.league, firstCommand.operationId);
    const firstMetadata = JSON.parse(firstOperation.metadata_json);
    assert.deepEqual(firstMetadata.command, {
      operationId: firstCommand.operationId,
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
      expectedVersion: firstCommand.expectedVersion,
      expectedCurrentSnapshotId: null,
      reason: firstCommand.reason,
    });
    assert.equal(
      firstMetadata.result.snapshotId,
      rebuilt.context.currentSnapshot.id
    );
    assert.equal(firstMetadata.result.snapshotVersion, 1);
    assert.equal(firstMetadata.result.sourceResultVersion, 1);
    assert.equal(firstMetadata.result.rowCount, 2);
    assert.deepEqual(
      firstMetadata.result.teamIds,
      [IDS.teamA, IDS.teamB].sort()
    );
    assert.match(firstMetadata.result.rowsSha256, /^[0-9a-f]{64}$/);
    for (const changedCommand of [
      { ...firstCommand, reason: "Changed replay reason" },
      { ...firstCommand, expectedVersion: firstCommand.expectedVersion + 1 },
      {
        ...firstCommand,
        expectedCurrentSnapshotId: rebuilt.context.currentSnapshot.id,
      },
    ]) {
      assert.throws(
        () => service.rebuildStandings(changedCommand),
        { code: "REPOSITORY_VERSION_CONFLICT" }
      );
    }

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
    const olderReplay = service.rebuildStandings(firstCommand);
    assert.equal(olderReplay.replayed, true);
    assert.equal(
      olderReplay.context.currentSnapshot.id,
      rebuilt.context.currentSnapshot.id
    );
    assert.equal(olderReplay.context.currentSnapshot.snapshot_version, 1);
    assert.deepEqual(olderReplay.context.rows, rebuilt.context.rows);
    assert.equal(service.rebuildStandings(secondCommand).replayed, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM standings_snapshots").get().count, 2);
    assert.equal(database.prepare("SELECT actor_user_id FROM standings_operations WHERE id = ?").get(uuid(411)).actor_user_id, IDS.commissioner);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM standings_snapshot_finalizations"
      ).get().count,
      0
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM standings_snapshot_result_versions"
      ).get().count,
      0
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM standings_snapshot_team_identities"
      ).get().count,
      0
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM league_activity").get().count, 0);
  });

  test("rejects active T145 history in preview and rechecks it inside the immediate rebuild transaction", (t) => {
    const { database, repository, service } = createRuntime(t);
    const previewBeforeFinalization = service.previewStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
    });
    seedT145FinalizationHistory(database);
    const evidenceBefore = captureStandingsEvidence(database);

    assert.throws(
      () => service.previewStandings({
        leagueId: IDS.league,
        seasonId: IDS.season,
        actorUserId: IDS.commissioner,
      }),
      { code: MATCHUP_RECOVERY_SERVICE_CODES.stateInvalid }
    );
    assert.throws(
      () => service.rebuildStandings({
        leagueId: IDS.league,
        seasonId: IDS.season,
        actorUserId: IDS.commissioner,
        operationId: uuid(620),
        confirmed: true,
        reason: "Must not rebuild finalized standings",
        expectedVersion: previewBeforeFinalization.expectedVersion,
        expectedCurrentSnapshotId:
          previewBeforeFinalization.currentSnapshotId,
        nowMs: 500,
      }),
      { code: MATCHUP_RECOVERY_SERVICE_CODES.stateInvalid }
    );
    assert.equal(
      repository.readStandingsContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      }).standingsFinalizationCount,
      1
    );
    assert.throws(
      () => repository.rebuildStandings({
        leagueId: IDS.league,
        seasonId: IDS.season,
        actorUserId: IDS.commissioner,
        operationId: uuid(621),
        expectedVersion: previewBeforeFinalization.expectedVersion,
        expectedCurrentSnapshotId:
          previewBeforeFinalization.currentSnapshotId,
        snapshotId: uuid(622),
        sourceResultVersion:
          previewBeforeFinalization.projection.sourceResultVersion,
        rows: repositoryRows(previewBeforeFinalization.projection, 630),
        reason: "Transaction-time finalization race",
        nowMs: 501,
      }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(captureStandingsEvidence(database), evidenceBefore);
  });

  test("rejects an active T097 replacement chain without changing either canonical generation", (t) => {
    const { database, repository, service } = createRuntime(t);
    const history = seedT097ReplacementHistory(database);
    const evidenceBefore = captureStandingsEvidence(database);
    const projection = createMatchupStandingsService({
      repository: createSqliteMatchupStandingsRepository({ database }),
    }).read({ leagueId: IDS.league, seasonId: IDS.season });

    assert.deepEqual(
      database.prepare(
        "SELECT id, status, cause, replaces_finalization_id FROM standings_snapshot_finalizations " +
          "ORDER BY finalization_version"
      ).all(),
      [
        {
          id: history.initial.finalizationId,
          status: "superseded",
          cause: "regular_season_completion",
          replaces_finalization_id: null,
        },
        {
          id: history.replacement.finalizationId,
          status: "final",
          cause: "result_correction",
          replaces_finalization_id: history.initial.finalizationId,
        },
      ]
    );
    assert.throws(
      () => service.previewStandings({
        leagueId: IDS.league,
        seasonId: IDS.season,
        actorUserId: IDS.commissioner,
      }),
      { code: MATCHUP_RECOVERY_SERVICE_CODES.stateInvalid }
    );
    assert.equal(
      repository.readStandingsContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      }).standingsFinalizationCount,
      2
    );
    assert.throws(
      () => repository.rebuildStandings({
        leagueId: IDS.league,
        seasonId: IDS.season,
        actorUserId: IDS.commissioner,
        operationId: uuid(640),
        expectedVersion: 1,
        expectedCurrentSnapshotId: null,
        snapshotId: uuid(641),
        sourceResultVersion: projection.sourceResultVersion,
        rows: repositoryRows(projection, 650),
        reason: "Must not replace corrected canonical standings",
        nowMs: 500,
      }),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(captureStandingsEvidence(database), evidenceBefore);
  });

  test("preserves a legacy final row as noncanonical history while creating only a new derived current snapshot", (t) => {
    const { database, service } = createRuntime(t);
    const legacySnapshotId = uuid(660);
    insertSnapshot(database, {
      id: legacySnapshotId,
      snapshotVersion: 1,
      status: "final",
      nowMs: 250,
    });
    const preview = service.previewStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
    });

    assert.equal(preview.currentSnapshotId, null);
    assert.equal(preview.nextSnapshotVersion, 2);
    const rebuilt = service.rebuildStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
      operationId: uuid(661),
      confirmed: true,
      reason: "Preserve legacy derived history",
      expectedVersion: preview.expectedVersion,
      expectedCurrentSnapshotId: null,
      nowMs: 300,
    });

    assert.equal(rebuilt.context.currentSnapshot.snapshot_version, 2);
    assert.equal(rebuilt.context.currentSnapshot.status, "current");
    assert.deepEqual(
      database.prepare(
        "SELECT id, status FROM standings_snapshots ORDER BY snapshot_version"
      ).all(),
      [
        { id: legacySnapshotId, status: "final" },
        { id: rebuilt.context.currentSnapshot.id, status: "current" },
      ]
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM standings_snapshot_finalizations"
      ).get().count,
      0
    );
  });

  test("fails a rebuild replay closed when canonical evidence is attached to its operation snapshot", (t) => {
    const { database, service } = createRuntime(t);
    const firstPreview = service.previewStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
    });
    const firstCommand = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
      operationId: uuid(670),
      confirmed: true,
      reason: "Create derived operation snapshot",
      expectedVersion: firstPreview.expectedVersion,
      expectedCurrentSnapshotId: null,
      nowMs: 300,
    };
    const first = service.rebuildStandings(firstCommand);
    const secondPreview = service.previewStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
    });
    service.rebuildStandings({
      leagueId: IDS.league,
      seasonId: IDS.season,
      actorUserId: IDS.commissioner,
      operationId: uuid(671),
      confirmed: true,
      reason: "Supersede the first derived snapshot",
      expectedVersion: secondPreview.expectedVersion,
      expectedCurrentSnapshotId: secondPreview.currentSnapshotId,
      nowMs: 301,
    });
    seedT145FinalizationHistory(database, {
      snapshotId: first.context.currentSnapshot.id,
      finalizationId: uuid(672),
      operationId: uuid(673),
      idempotencyRequestId: uuid(674),
      insertSnapshotRecord: false,
      complete: false,
    });
    const evidenceBefore = captureStandingsEvidence(database);

    assert.throws(
      () => service.rebuildStandings(firstCommand),
      { code: "REPOSITORY_VERSION_CONFLICT" }
    );
    assert.deepEqual(captureStandingsEvidence(database), evidenceBefore);
  });

  test("fails replay closed when operation-linked row evidence is altered or incomplete", (t) => {
    const cases = [
      [
        "altered row",
        (database, result) => {
          database.prepare(
            "UPDATE standings_rows SET rank = rank + 1 WHERE league_id = ? " +
              "AND standings_snapshot_id = ? AND id = ?"
          ).run(
            IDS.league,
            result.context.currentSnapshot.id,
            result.context.rows[0].id
          );
        },
      ],
      [
        "missing row",
        (database, result) => {
          database.prepare(
            "DELETE FROM standings_rows WHERE league_id = ? " +
              "AND standings_snapshot_id = ? AND id = ?"
          ).run(
            IDS.league,
            result.context.currentSnapshot.id,
            result.context.rows[0].id
          );
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const { database, service } = createRuntime(t);
      const { command, result } = createDerivedRebuild(service);
      mutate(database, result);
      const evidenceBefore = captureStandingsEvidence(database);

      assert.throws(
        () => service.rebuildStandings(command),
        { code: "REPOSITORY_VERSION_CONFLICT" },
        label
      );
      assert.deepEqual(
        captureStandingsEvidence(database),
        evidenceBefore,
        label
      );
    }
  });

  test("fails replay closed when the operation-linked snapshot or its status changes", (t) => {
    const cases = [
      [
        "altered snapshot",
        (database, result) => {
          database.prepare(
            "UPDATE standings_snapshots SET source_result_version = source_result_version + 1 " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, result.context.currentSnapshot.id);
        },
      ],
      [
        "final snapshot status",
        (database, result) => {
          database.prepare(
            "UPDATE standings_snapshots SET status = 'final' " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, result.context.currentSnapshot.id);
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const { database, service } = createRuntime(t);
      const { command, result } = createDerivedRebuild(service);
      mutate(database, result);
      const evidenceBefore = captureStandingsEvidence(database);

      assert.throws(
        () => service.rebuildStandings(command),
        { code: "REPOSITORY_VERSION_CONFLICT" },
        label
      );
      assert.deepEqual(
        captureStandingsEvidence(database),
        evidenceBefore,
        label
      );
    }
  });

  test("fails replay closed for malformed or mutated succeeded-operation evidence", (t) => {
    const cases = [
      [
        "malformed metadata",
        (database, command) => {
          database.prepare(
            "UPDATE standings_operations SET metadata_json = '{}' " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, command.operationId);
        },
      ],
      [
        "changed reason",
        (database, command) => {
          database.prepare(
            "UPDATE standings_operations SET reason = 'Tampered operation reason' " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, command.operationId);
        },
      ],
      [
        "failed operation status",
        (database, command) => {
          database.prepare(
            "UPDATE standings_operations SET status = 'failed' " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, command.operationId);
        },
      ],
      [
        "changed operation timestamp",
        (database, command) => {
          database.prepare(
            "UPDATE standings_operations SET completed_at_ms = completed_at_ms + 1 " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, command.operationId);
        },
      ],
      [
        "missing snapshot linkage",
        (database, command) => {
          database.prepare(
            "UPDATE standings_operations SET standings_snapshot_id = NULL " +
              "WHERE league_id = ? AND id = ?"
          ).run(IDS.league, command.operationId);
        },
      ],
    ];

    for (const [label, mutate] of cases) {
      const { database, service } = createRuntime(t);
      const { command } = createDerivedRebuild(service);
      mutate(database, command);
      const evidenceBefore = captureStandingsEvidence(database);

      assert.throws(
        () => service.rebuildStandings(command),
        { code: "REPOSITORY_VERSION_CONFLICT" },
        label
      );
      assert.deepEqual(
        captureStandingsEvidence(database),
        evidenceBefore,
        label
      );
    }
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
