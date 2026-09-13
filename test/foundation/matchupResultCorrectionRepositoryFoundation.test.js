const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createMatchupResultCorrectionService,
} = require("../../src/application/services/matchups/createMatchupResultCorrectionService");
const {
  calculateStandings,
} = require("../../src/domain/matchups/matchupStandingsPolicy");
const {
  calculateStandingsResultSetHash,
} = require("../../src/domain/matchups/matchupStandingsFinalizationPolicy");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  REPOSITORY_ERROR_CODES,
} = require("../../src/infrastructure/persistence/sqlite/SqliteRepositoryError");
const {
  MATCHUP_RESULT_CORRECTION_AUDIT_EVENT,
  MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
  MATCHUP_RESULT_CORRECTION_OPERATION,
  MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
  createSqliteMatchupResultCorrectionRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupResultCorrectionRepository");
const {
  STANDINGS_FINALIZATION_OPERATION,
  createSqliteMatchupStandingsFinalizationRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupStandingsFinalizationRepository");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_STARTS_AT_MS = 1_791_183_600_000;
const WEEK_ENDS_AT_MS = WEEK_STARTS_AT_MS + WEEK_MS;
const NHL_REGULAR_STARTS_AT_MS =
  WEEK_STARTS_AT_MS - 2 * 24 * 60 * 60 * 1000;
const FINALIZED_AT_MS = WEEK_ENDS_AT_MS + 1_000;
const CORRECTED_AT_MS = FINALIZED_AT_MS + 1_000;

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  commissionerUser: uuid(1),
  memberUser: uuid(2),
  league: uuid(10),
  season: uuid(12),
  commissionerMembership: uuid(20),
  memberMembership: uuid(21),
  teamA: uuid(30),
  teamB: uuid(31),
  week: uuid(40),
  matchup: uuid(41),
  statSource: uuid(50),
  statRefresh: uuid(51),
  statSnapshot: uuid(52),
  matchupResult: uuid(60),
  resultVersion: uuid(61),
  currentSnapshot: uuid(70),
  finalizationIdempotency: uuid(80),
  finalSnapshot: uuid(81),
  finalRowA: uuid(82),
  finalRowB: uuid(83),
  finalResultLink: uuid(84),
  finalIdentityA: uuid(85),
  finalIdentityB: uuid(86),
  finalOperation: uuid(87),
  finalization: uuid(88),
  finalCommissionerNotification: uuid(89),
  finalMemberNotification: uuid(90),
  finalOutbox: uuid(92),
  scheduleOperation: uuid(93),
});

function insertUser(
  database,
  { id, email, displayName }
) {
  database
    .prepare(`
      INSERT INTO users (
        id,
        email_normalized,
        email_display,
        display_name,
        display_name_normalized,
        status,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @id,
        @email,
        @email,
        @displayName,
        @displayNameNormalized,
        'active',
        1,
        1,
        1
      )
    `)
    .run({
      id,
      email,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
    });
}

function seed(database) {
  insertUser(database, {
    id: IDS.commissionerUser,
    email: "commissioner@example.test",
    displayName: "Commissioner",
  });
  insertUser(database, {
    id: IDS.memberUser,
    email: "member@example.test",
    displayName: "Member",
  });

  database
    .prepare(`
      INSERT INTO leagues (
        id,
        name,
        name_normalized,
        status,
        timezone,
        commissioner_membership_id,
        current_season_id,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        'Correction League',
        'correction league',
        'active',
        'America/Vancouver',
        NULL,
        NULL,
        1,
        1,
        1
      )
    `)
    .run(IDS.league);
  database
    .prepare(`
      INSERT INTO league_settings (
        league_id,
        salary_cap_cents,
        trade_deadline_at_ms,
        maximum_teams,
        active_forward_slots,
        active_defence_slots,
        bench_slots,
        maximum_bench_aav_cents,
        injured_reserve_slots,
        prospect_slots_unlimited,
        scoring_rule_version,
        standings_rule_version,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        10000,
        NULL,
        20,
        12,
        6,
        4,
        400,
        4,
        1,
        1,
        1,
        1,
        1,
        1
      )
    `)
    .run(IDS.league);
  database
    .prepare(`
      INSERT INTO seasons (
        id,
        league_id,
        label,
        nhl_season_key,
        status,
        regular_season_starts_at_ms,
        regular_season_ends_at_ms,
        fantasy_playoffs_start_at_ms,
        fantasy_playoffs_end_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        ?,
        '2026-27',
        '20262027',
        'active',
        ${NHL_REGULAR_STARTS_AT_MS},
        ${WEEK_ENDS_AT_MS},
        ${WEEK_ENDS_AT_MS},
        ${WEEK_ENDS_AT_MS + 2 * WEEK_MS},
        1,
        1,
        1
      )
    `)
    .run(IDS.season, IDS.league);
  database
    .prepare(`
      UPDATE leagues
      SET current_season_id = ?
      WHERE id = ?
    `)
    .run(IDS.season, IDS.league);

  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id,
      league_id,
      user_id,
      permission_category,
      status,
      joined_at_ms,
      ended_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @userId,
      @permissionCategory,
      'active',
      1,
      NULL,
      1,
      1,
      1
    )
  `);
  insertMembership.run({
    id: IDS.commissionerMembership,
    leagueId: IDS.league,
    userId: IDS.commissionerUser,
    permissionCategory: "commissioner",
  });
  insertMembership.run({
    id: IDS.memberMembership,
    leagueId: IDS.league,
    userId: IDS.memberUser,
    permissionCategory: "member",
  });
  database
    .prepare(`
      UPDATE leagues
      SET commissioner_membership_id = ?
      WHERE id = ?
    `)
    .run(IDS.commissionerMembership, IDS.league);

  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version,
      tertiary_colour,
      pattern_template
    ) VALUES (
      @id,
      @leagueId,
      @name,
      @nameNormalized,
      'active',
      @primaryColour,
      @secondaryColour,
      NULL,
      1,
      1,
      1,
      NULL,
      'even-two'
    )
  `);
  insertTeam.run({
    id: IDS.teamA,
    leagueId: IDS.league,
    name: "Alpha",
    nameNormalized: "alpha",
    primaryColour: "#112233",
    secondaryColour: "#abcdef",
  });
  insertTeam.run({
    id: IDS.teamB,
    leagueId: IDS.league,
    name: "Bravo",
    nameNormalized: "bravo",
    primaryColour: "#445566",
    secondaryColour: "#fedcba",
  });

  database
    .prepare(`
      INSERT INTO matchup_weeks (
        id,
        league_id,
        season_id,
        week_key,
        sequence,
        starts_at_ms,
        baseline_at_ms,
        locks_at_ms,
        ends_at_ms,
        rolls_over_at_ms,
        status,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        ?,
        ?,
        'regular-01',
        1,
        ${WEEK_STARTS_AT_MS},
        ${WEEK_STARTS_AT_MS + 60 * 60 * 1000},
        ${WEEK_STARTS_AT_MS + 16 * 60 * 60 * 1000},
        ${WEEK_ENDS_AT_MS},
        ${WEEK_ENDS_AT_MS},
        'final',
        1,
        ${WEEK_ENDS_AT_MS},
        1
      )
    `)
    .run(IDS.week, IDS.league, IDS.season);
  database
    .prepare(`
      INSERT INTO matchups (
        id,
        league_id,
        season_id,
        matchup_week_id,
        home_team_id,
        away_team_id,
        home_team_name,
        away_team_name,
        status,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        'Alpha',
        'Bravo',
        'final',
        1,
        ${WEEK_ENDS_AT_MS},
        1
      )
    `)
    .run(
      IDS.matchup,
      IDS.league,
      IDS.season,
      IDS.week,
      IDS.teamA,
      IDS.teamB
    );
  database
    .prepare(`
      INSERT INTO matchup_operations (
        id,
        league_id,
        season_id,
        matchup_week_id,
        matchup_id,
        actor_user_id,
        operation_type,
        status,
        reason,
        metadata_json,
        started_at_ms,
        completed_at_ms
      ) VALUES (
        ?,
        ?,
        ?,
        NULL,
        NULL,
        ?,
        'schedule_generate',
        'succeeded',
        NULL,
        ?,
        1,
        1
      )
    `)
    .run(
      IDS.scheduleOperation,
      IDS.league,
      IDS.season,
      IDS.commissionerUser,
      JSON.stringify({
        participantCount: 2,
        participantTeamIds: [
          IDS.teamA,
          IDS.teamB,
        ].sort(),
        weekCount: 1,
        matchupCount: 1,
        jobOccurrenceCount: 0,
      })
    );
  database
    .prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id,
        season_id,
        schedule_version,
        schedule_operation_id,
        week_one_matchup_week_id,
        week_one_starts_at_ms,
        status,
        created_at_ms,
        superseded_at_ms,
        version
      ) VALUES (
        ?, ?, 1, ?, ?, ?, 'current', 1, NULL, 1
      )
    `)
    .run(
      IDS.league,
      IDS.season,
      IDS.scheduleOperation,
      IDS.week,
      WEEK_STARTS_AT_MS
    );

  database
    .prepare(`
      INSERT INTO stat_sources (
        id,
        provider,
        status,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (?, 'nhl', 'active', 1, 1, 1)
    `)
    .run(IDS.statSource);
  database
    .prepare(`
      INSERT INTO stat_refreshes (
        id,
        stat_source_id,
        nhl_season_key,
        source_version,
        status,
        started_at_ms,
        completed_at_ms,
        player_count,
        version
      ) VALUES (
        ?,
        ?,
        '20262027',
        'final',
        'succeeded',
        ${WEEK_ENDS_AT_MS - 10_000},
        ${WEEK_ENDS_AT_MS},
        0,
        1
      )
    `)
    .run(IDS.statRefresh, IDS.statSource);
  database
    .prepare(`
      INSERT INTO stat_snapshots (
        id,
        stat_source_id,
        source_refresh_id,
        league_id,
        season_id,
        matchup_week_id,
        intended_use,
        completeness_status,
        freshness_status,
        captured_at_ms,
        committed,
        created_at_ms
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        'matchup_final',
        'complete',
        'fresh',
        ${WEEK_ENDS_AT_MS},
        1,
        ${WEEK_ENDS_AT_MS}
      )
    `)
    .run(
      IDS.statSnapshot,
      IDS.statSource,
      IDS.statRefresh,
      IDS.league,
      IDS.season,
      IDS.week
    );
  database
    .prepare(`
      INSERT INTO matchup_results (
        id,
        league_id,
        season_id,
        matchup_id,
        current_version_id,
        status,
        finalized_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        NULL,
        'pending',
        NULL,
        1,
        1,
        1
      )
    `)
    .run(
      IDS.matchupResult,
      IDS.league,
      IDS.season,
      IDS.matchup
    );
  database
    .prepare(`
      INSERT INTO matchup_result_versions (
        id,
        league_id,
        season_id,
        matchup_result_id,
        version_number,
        home_team_id,
        away_team_id,
        home_score_hundredths,
        away_score_hundredths,
        outcome,
        source_snapshot_id,
        source_type,
        actor_user_id,
        reason,
        supersedes_version_id,
        created_at_ms
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        1,
        ?,
        ?,
        500,
        300,
        'home_win',
        ?,
        'calculated',
        NULL,
        NULL,
        NULL,
        ${WEEK_ENDS_AT_MS}
      )
    `)
    .run(
      IDS.resultVersion,
      IDS.league,
      IDS.season,
      IDS.matchupResult,
      IDS.teamA,
      IDS.teamB,
      IDS.statSnapshot
    );
  database
    .prepare(`
      UPDATE matchup_results
      SET current_version_id = ?,
        status = 'official',
        finalized_at_ms = ${WEEK_ENDS_AT_MS},
        updated_at_ms = ${WEEK_ENDS_AT_MS}
      WHERE id = ?
    `)
    .run(IDS.resultVersion, IDS.matchupResult);
  database
    .prepare(`
      INSERT INTO standings_snapshots (
        id,
        league_id,
        season_id,
        snapshot_version,
        source_result_version,
        status,
        calculated_at_ms,
        created_at_ms
      ) VALUES (
        ?,
        ?,
        ?,
        1,
        1,
        'current',
        ${WEEK_ENDS_AT_MS},
        ${WEEK_ENDS_AT_MS}
      )
    `)
    .run(
      IDS.currentSnapshot,
      IDS.league,
      IDS.season
    );
}

function createRuntime(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-t097-repository-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "correction.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "t097-repository-foundation",
    now: () => 1,
  });
  seed(connection.database);
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    database: connection.database,
    repository:
      createSqliteMatchupResultCorrectionRepository({
        database: connection.database,
      }),
  };
}

function calculatedRows({
  homeScoreHundredths,
  awayScoreHundredths,
}) {
  return calculateStandings({
    participants: [
      {
        team_id: IDS.teamA,
        team_display_name: "Alpha",
      },
      {
        team_id: IDS.teamB,
        team_display_name: "Bravo",
      },
    ],
    results: [
      {
        home_team_id: IDS.teamA,
        away_team_id: IDS.teamB,
        home_score_hundredths: homeScoreHundredths,
        away_score_hundredths: awayScoreHundredths,
      },
    ],
  });
}

function rowWrite(row, id) {
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

function identityWrite(identity, id) {
  return {
    id,
    teamId: identity.team_id,
    teamDisplayName: identity.team_display_name,
    primaryColour: identity.primary_colour,
    secondaryColour: identity.secondary_colour,
    tertiaryColour: identity.tertiary_colour,
    patternTemplate: identity.pattern_template,
    sourceLogoObjectId: identity.source_logo_object_id,
    logoMediaType: identity.logo_media_type,
    logoByteLength: identity.logo_byte_length,
    logoWidth: identity.logo_width,
    logoHeight: identity.logo_height,
    logoContentSha256: identity.logo_content_sha256,
    logoContentBytes: identity.logo_content_bytes,
  };
}

function resultSetHash({
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
        matchupResultId: IDS.matchupResult,
        resultVersionId,
        resultVersion,
      },
    ],
  });
}

function commitRegularFinalization(
  database,
  {
    resultVersionId = IDS.resultVersion,
    resultVersion = 1,
    homeScoreHundredths = 500,
    awayScoreHundredths = 300,
    seasonVersionBefore = 1,
    nowMs = FINALIZED_AT_MS,
  } = {}
) {
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
  const rows = calculatedRows({
    homeScoreHundredths,
    awayScoreHundredths,
  });
  const rowsByTeamId = new Map(
    rows.map((row) => [row.teamId, row])
  );
  const hash = resultSetHash({
    resultVersionId,
    resultVersion,
  });

  return repositoryContext.transaction(() => {
    repository.insertStartedIdempotency({
      id: IDS.finalizationIdempotency,
      leagueId: IDS.league,
      actorUserId: IDS.commissionerUser,
      operation: STANDINGS_FINALIZATION_OPERATION,
      clientKey: "finalize-season",
      requestHash: "f".repeat(64),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 86_400_000,
    });
    repository.supersedeCurrentDerivedSnapshot({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.currentSnapshot,
    });
    repository.insertFinalSnapshot({
      id: IDS.finalSnapshot,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotVersion: 2,
      sourceResultVersion: resultVersion,
      nowMs,
    });
    repository.insertStandingsRows({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      rows: [
        rowWrite(
          rowsByTeamId.get(IDS.teamA),
          IDS.finalRowA
        ),
        rowWrite(
          rowsByTeamId.get(IDS.teamB),
          IDS.finalRowB
        ),
      ],
    });
    repository.insertResultVersionLinks({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      links: [
        {
          id: IDS.finalResultLink,
          matchupWeekId: IDS.week,
          matchupId: IDS.matchup,
          matchupResultId: IDS.matchupResult,
          resultVersionId,
          resultVersionNumber: resultVersion,
        },
      ],
      nowMs,
    });
    repository.insertTeamIdentities({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      identities: context.participants.map(
        (participant) =>
          identityWrite(
            participant,
            participant.team_id === IDS.teamA
              ? IDS.finalIdentityA
              : IDS.finalIdentityB
          )
      ),
      nowMs,
    });
    repository.insertSucceededOperation({
      id: IDS.finalOperation,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      actorUserId: IDS.commissionerUser,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      idempotencyRequestId:
        IDS.finalizationIdempotency,
      metadataJson: JSON.stringify({
        resultSetHash: hash,
        standingsRuleVersion: 1,
      }),
      nowMs,
    });
    repository.insertFinalizationEvidence({
      id: IDS.finalization,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      finalizationVersion: 2,
      standingsRuleVersion: 1,
      resultSetHash: hash,
      expectedMatchupCount: 1,
      expectedWeekCount: 1,
      participantCount: 2,
      seasonVersionBefore,
      actorUserId: IDS.commissionerUser,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      operationId: IDS.finalOperation,
      idempotencyRequestId:
        IDS.finalizationIdempotency,
      nowMs,
    });
    for (const [userId, id] of [
      [
        IDS.commissionerUser,
        IDS.finalCommissionerNotification,
      ],
      [IDS.memberUser, IDS.finalMemberNotification],
    ]) {
      repository.writeFinalizedNotification({
        id,
        leagueId: IDS.league,
        seasonId: IDS.season,
        finalizationId: IDS.finalization,
        snapshotId: IDS.finalSnapshot,
        userId,
        nowMs,
      });
    }
    repository.writeFinalizedOutbox({
      id: IDS.finalOutbox,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      seasonVersion: seasonVersionBefore + 1,
      nowMs,
    });
    repository.advanceSeasonVersion({
      leagueId: IDS.league,
      seasonId: IDS.season,
      expectedVersion: seasonVersionBefore,
      nowMs,
    });
    repository.completeIdempotency({
      id: IDS.finalizationIdempotency,
      leagueId: IDS.league,
      finalizationId: IDS.finalization,
      completedAtMs: nowMs,
    });
  });
}

function auditRecord(offset, nowMs) {
  return {
    id: uuid(offset + 4),
    event_type:
      MATCHUP_RESULT_CORRECTION_AUDIT_EVENT,
    outcome: "success",
    actor_user_id: IDS.commissionerUser,
    target_user_id: null,
    league_id: IDS.league,
    session_id: null,
    request_correlation_id: null,
    reason_code: null,
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: JSON.stringify({
      actorAuthority: "commissioner",
    }),
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  };
}

function baseCommand({
  offset,
  expectedResultVersion = 1,
  expectedSeasonVersion = 1,
  supersedesVersionId = IDS.resultVersion,
  homeScoreHundredths = 300,
  awayScoreHundredths = 500,
  reason =
    MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
  nowMs = CORRECTED_AT_MS,
}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    resultId: IDS.matchupResult,
    expectedResultVersion,
    expectedSeasonVersion,
    actorUserId: IDS.commissionerUser,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    idempotency: {
      id: uuid(offset),
      clientKey: `correction-${offset}`,
      requestHash: String(offset % 10).repeat(64),
      expiresAtMs: nowMs + 86_400_000,
    },
    correction: {
      resultVersionId: uuid(offset + 1),
      matchupOperationId: uuid(offset + 2),
      versionNumber: expectedResultVersion + 1,
      supersedesVersionId,
      sourceSnapshotId: IDS.statSnapshot,
      homeTeamId: IDS.teamA,
      awayTeamId: IDS.teamB,
      homeScoreHundredths,
      awayScoreHundredths,
      outcome:
        homeScoreHundredths === awayScoreHundredths
          ? "tie"
          : homeScoreHundredths >
              awayScoreHundredths
            ? "home_win"
            : "away_win",
      reason,
      createdAtMs: nowMs,
    },
    replacement: null,
    preFinalOutboxId: uuid(offset + 3),
    audit: auditRecord(offset, nowMs),
    nowMs,
  };
}

function withReplacement(
  repository,
  command,
  {
    homeScoreHundredths =
      command.correction.homeScoreHundredths,
    awayScoreHundredths =
      command.correction.awayScoreHundredths,
  } = {}
) {
  const context = repository.readCorrectionContext({
    leagueId: IDS.league,
    seasonId: IDS.season,
    resultId: IDS.matchupResult,
  });
  const active = context.activeFinalization;
  const rows = calculatedRows({
    homeScoreHundredths,
    awayScoreHundredths,
  });
  const rowsByTeamId = new Map(
    rows.map((row) => [row.teamId, row])
  );
  const changed =
    active.rows.some((prior) => {
      const row = rowsByTeamId.get(prior.team_id);
      return (
        prior.rank !== row.rank ||
        prior.wins !== row.wins ||
        prior.losses !== row.losses ||
        prior.ties !== row.ties ||
        prior.standings_points !==
          row.standingsPoints ||
        prior.fantasy_points_for_hundredths !==
          row.fantasyPointsForHundredths ||
        prior.fantasy_points_against_hundredths !==
          row.fantasyPointsAgainstHundredths ||
        prior
          .fantasy_point_differential_hundredths !==
          row.fantasyPointsDifferentialHundredths
      );
    });
  const offset = Number(
    command.idempotency.id.slice(-12)
  );
  const replacementLink = {
    id: uuid(offset + 8),
    matchupWeekId: IDS.week,
    matchupId: IDS.matchup,
    matchupResultId: IDS.matchupResult,
    resultVersionId:
      command.correction.resultVersionId,
    resultVersionNumber:
      command.correction.versionNumber,
  };
  return {
    ...command,
    replacement: {
      snapshotId: uuid(offset + 5),
      snapshotVersion:
        active.finalization.finalization_version + 1,
      sourceResultVersion:
        active.snapshot.source_result_version + 1,
      standingsOperationId: uuid(offset + 11),
      finalizationId: uuid(offset + 12),
      resultSetHash:
        calculateStandingsResultSetHash({
          leagueId: IDS.league,
          seasonId: IDS.season,
          standingsRuleVersion: "1",
          results: [
            {
              matchupId: IDS.matchup,
              matchupResultId: IDS.matchupResult,
              resultVersionId:
                command.correction.resultVersionId,
              resultVersion:
                command.correction.versionNumber,
            },
          ],
        }),
      standingsRuleVersion: 1,
      expectedMatchupCount: 1,
      expectedWeekCount: 1,
      participantCount: 2,
      rows: [
        rowWrite(
          rowsByTeamId.get(IDS.teamA),
          uuid(offset + 6)
        ),
        rowWrite(
          rowsByTeamId.get(IDS.teamB),
          uuid(offset + 7)
        ),
      ],
      links: [replacementLink],
      identities: active.identities.map(
        (identity, index) =>
          identityWrite(
            identity,
            uuid(offset + 9 + index)
          )
      ),
      standingsRowsChanged: changed,
      notifications: changed
        ? context.activeMemberUserIds.map(
            (userId, index) => ({
              id: uuid(offset + 13 + index),
              userId,
            })
          )
        : [],
      outboxId: uuid(offset + 15),
    },
    preFinalOutboxId: null,
  };
}

function totalChanges(database) {
  return database
    .prepare("SELECT total_changes() AS count")
    .get().count;
}

function markCorrectionRequired(database) {
  assert.equal(
    database
      .prepare(`
        UPDATE matchups
        SET status = 'correction_required',
            updated_at_ms = ${CORRECTED_AT_MS - 1},
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
          AND status = 'final'
      `)
      .run(
        IDS.league,
        IDS.season,
        IDS.matchup
      ).changes,
    1
  );
  assert.equal(
    database
      .prepare(`
        UPDATE matchup_weeks
        SET status = 'correction_required',
            updated_at_ms = ${CORRECTED_AT_MS - 1},
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
          AND status = 'final'
      `)
      .run(IDS.league, IDS.season, IDS.week)
      .changes,
    1
  );
}

function rollToNextSeason(database) {
  const nextSeasonId = uuid(14);
  assert.equal(
    database
      .prepare(`
        UPDATE seasons
        SET status = 'completed',
            updated_at_ms = ${CORRECTED_AT_MS - 2},
            version = 3
        WHERE league_id = ?
          AND id = ?
          AND status = 'active'
          AND version = 2
      `)
      .run(IDS.league, IDS.season).changes,
    1
  );
  database
    .prepare(`
      INSERT INTO seasons (
        id,
        league_id,
        label,
        nhl_season_key,
        status,
        regular_season_starts_at_ms,
        regular_season_ends_at_ms,
        fantasy_playoffs_start_at_ms,
        fantasy_playoffs_end_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        ?,
        ?,
        '2027-28',
        '20272028',
        'active',
        ${CORRECTED_AT_MS + WEEK_MS},
        ${CORRECTED_AT_MS + 2 * WEEK_MS},
        ${CORRECTED_AT_MS + 2 * WEEK_MS},
        ${CORRECTED_AT_MS + 3 * WEEK_MS},
        ${CORRECTED_AT_MS - 1},
        ${CORRECTED_AT_MS - 1},
        1
      )
    `)
    .run(nextSeasonId, IDS.league);
  assert.equal(
    database
      .prepare(`
        UPDATE leagues
        SET current_season_id = ?,
            updated_at_ms = ${CORRECTED_AT_MS - 1},
            version = version + 1
        WHERE id = ?
          AND current_season_id = ?
      `)
      .run(
        nextSeasonId,
        IDS.league,
        IDS.season
      ).changes,
    1
  );
  assert.equal(
    database
      .prepare(`
        UPDATE league_settings
        SET standings_rule_version = 2,
            updated_at_ms = ${CORRECTED_AT_MS - 1},
            version = version + 1
        WHERE league_id = ?
          AND standings_rule_version = 1
      `)
      .run(IDS.league).changes,
    1
  );
  return nextSeasonId;
}

describe("T097 SQLite matchup-result correction repository", () => {
  test("atomically commits and immutably replays pre-final corrections without standings writes", (t) => {
    const runtime = createRuntime(t);
    const contextChanges = totalChanges(runtime.database);
    const context =
      runtime.repository.readCorrectionContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.matchupResult,
      });
    assert.equal(
      totalChanges(runtime.database),
      contextChanges
    );
    assert.equal(
      context.canonicalFinalizationHistoryCount,
      0
    );
    assert.equal(context.activeFinalization, null);

    const command = baseCommand({ offset: 200 });
    const committed = runtime.repository.correct(command);
    assert.deepEqual(committed, {
      result_id: IDS.matchupResult,
      result_version_id:
        command.correction.resultVersionId,
      result_version_number: 2,
      result_version: 2,
      league_id: IDS.league,
      season_id: IDS.season,
      matchup_week_id: IDS.week,
      matchup_id: IDS.matchup,
      corrected_at_ms: CORRECTED_AT_MS,
      standings_rows_changed: false,
      replacement_snapshot_id: null,
      replacement_snapshot_version: null,
      replacement_result_set_hash: null,
      evidence: {
        correctionOperationId:
          command.correction.matchupOperationId,
        correctionOperationMetadataJson:
          JSON.stringify({
            resultId: IDS.matchupResult,
            resultVersionId:
              command.correction.resultVersionId,
          }),
        idempotencyRequestId:
          command.idempotency.id,
        idempotencyActorUserId:
          IDS.commissionerUser,
        idempotencyOperation:
          MATCHUP_RESULT_CORRECTION_OPERATION,
        idempotencyClientKey:
          command.idempotency.clientKey,
        idempotencyRequestHash:
          command.idempotency.requestHash,
        idempotencyCompletedAtMs:
          CORRECTED_AT_MS,
        replacementFinalizationId: null,
        replacementStandingsOperationId: null,
      },
    });

    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            current_version_id,
            status,
            version
          FROM matchup_results
          WHERE id = ?
        `)
        .get(IDS.matchupResult),
      {
        current_version_id:
          command.correction.resultVersionId,
        status: "corrected",
        version: 2,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            source_type,
            actor_user_id,
            reason,
            supersedes_version_id
          FROM matchup_result_versions
          WHERE id = ?
        `)
        .get(command.correction.resultVersionId),
      {
        source_type: "correction",
        actor_user_id: IDS.commissionerUser,
        reason:
          MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
        supersedes_version_id: IDS.resultVersion,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            operation_type,
            status,
            reason,
            metadata_json
          FROM matchup_operations
          WHERE id = ?
        `)
        .get(command.correction.matchupOperationId),
      {
        operation_type: "result_correct",
        status: "succeeded",
        reason:
          MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
        metadata_json: JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId:
            command.correction.resultVersionId,
        }),
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            result_type,
            result_id
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(command.idempotency.id),
      {
        status: "completed",
        result_type:
          MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
        result_id:
          command.correction.resultVersionId,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            event_type,
            aggregate_type,
            aggregate_id,
            payload_json
          FROM outbox_events
          WHERE id = ?
        `)
        .get(command.preFinalOutboxId),
      {
        event_type: "matchup.changed",
        aggregate_type: "matchup_result",
        aggregate_id: IDS.matchupResult,
        payload_json: JSON.stringify({
          eventId: command.preFinalOutboxId,
          type: "matchup.changed",
          leagueId: IDS.league,
          resourceId: IDS.matchupResult,
          version: 2,
          reasonCode: "correction_applied",
          occurredAt: CORRECTED_AT_MS,
          related: {
            fadId: null,
            teamId: null,
            cardId: null,
            allocationId: null,
            auctionId: null,
            recoveryId: null,
            nominationQueueId: null,
            scheduleRecoveryOperationId: null,
          },
        }),
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            audience_kind,
            team_id,
            user_id
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
        `)
        .all(command.preFinalOutboxId),
      [
        {
          audience_kind: "league",
          team_id: null,
          user_id: null,
        },
      ]
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM notifications
        `)
        .get().count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM league_activity
        `)
        .get().count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT version
          FROM seasons
          WHERE id = ?
        `)
        .get(IDS.season).version,
      1
    );

    const beforeReplay = totalChanges(runtime.database);
    assert.deepEqual(
      runtime.repository.correct(command),
      committed
    );
    assert.equal(
      totalChanges(runtime.database),
      beforeReplay
    );

    const second = baseCommand({
      offset: 230,
      expectedResultVersion: 2,
      supersedesVersionId:
        command.correction.resultVersionId,
      homeScoreHundredths: 700,
      awayScoreHundredths: 400,
      nowMs: CORRECTED_AT_MS + 1,
    });
    runtime.repository.correct(second);
    assert.deepEqual(
      runtime.repository.findCorrectionResult({
        leagueId: IDS.league,
        resultVersionId:
          command.correction.resultVersionId,
      }),
      committed
    );
  });

  test("replaces final standings, advances both CAS pointers, and notifies only for changed rows", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    const bare = baseCommand({
      offset: 300,
      expectedSeasonVersion: 2,
    });
    const command = withReplacement(
      runtime.repository,
      bare
    );
    assert.equal(
      command.replacement.standingsRowsChanged,
      true
    );
    const result = runtime.repository.correct(command);

    assert.equal(result.result_version_number, 2);
    assert.equal(result.result_version, 2);
    assert.equal(
      result.replacement_snapshot_id,
      command.replacement.snapshotId
    );
    assert.equal(
      result.replacement_snapshot_version,
      3
    );
    assert.equal(result.standings_rows_changed, true);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            superseded_by_snapshot_id,
            superseded_by_operation_id,
            version
          FROM standings_snapshot_finalizations
          WHERE id = ?
        `)
        .get(IDS.finalization),
      {
        status: "superseded",
        superseded_by_snapshot_id:
          command.replacement.snapshotId,
        superseded_by_operation_id:
          command.replacement.standingsOperationId,
        version: 2,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            cause,
            replaces_finalization_id,
            idempotency_request_id,
            finalization_version,
            season_version_before,
            season_version_after
          FROM standings_snapshot_finalizations
          WHERE id = ?
        `)
        .get(command.replacement.finalizationId),
      {
        status: "final",
        cause: "result_correction",
        replaces_finalization_id: IDS.finalization,
        idempotency_request_id:
          command.idempotency.id,
        finalization_version: 3,
        season_version_before: 2,
        season_version_after: 3,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            operation_type,
            status,
            reason,
            idempotency_request_id
          FROM standings_operations
          WHERE id = ?
        `)
        .get(command.replacement.standingsOperationId),
      {
        operation_type: "correction_propagation",
        status: "succeeded",
        reason:
          MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
        idempotency_request_id:
          command.idempotency.id,
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT version
          FROM seasons
          WHERE id = ?
        `)
        .get(IDS.season).version,
      3
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT user_id
          FROM notifications
          WHERE event_type = 'standings_corrected'
          ORDER BY user_id
        `)
        .all()
        .map((row) => row.user_id),
      [IDS.commissionerUser, IDS.memberUser].sort()
    );
    const outbox = runtime.database
      .prepare(`
        SELECT
          event_type,
          aggregate_type,
          aggregate_id,
          payload_json
        FROM outbox_events
        WHERE id = ?
      `)
      .get(command.replacement.outboxId);
    assert.equal(outbox.event_type, "standings.changed");
    assert.equal(outbox.aggregate_type, "season");
    assert.equal(outbox.aggregate_id, IDS.season);
    assert.deepEqual(JSON.parse(outbox.payload_json), {
      eventId: command.replacement.outboxId,
      type: "standings.changed",
      leagueId: IDS.league,
      resourceId: IDS.season,
      version: 3,
      reasonCode: "correction_applied",
      occurredAt: CORRECTED_AT_MS,
      related: {
        fadId: null,
        teamId: null,
        cardId: null,
        allocationId: null,
        auctionId: null,
        recoveryId: null,
        nominationQueueId: null,
        scheduleRecoveryOperationId: null,
      },
    });
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM security_audit_events
          WHERE event_type = ?
            AND actor_user_id = ?
        `)
        .get(
          MATCHUP_RESULT_CORRECTION_AUDIT_EVENT,
          IDS.commissionerUser
        ).count,
      1
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM league_activity
        `)
        .get().count,
      0
    );

    const beforeReplay = totalChanges(runtime.database);
    assert.deepEqual(
      runtime.repository.correct(command),
      result
    );
    assert.equal(
      totalChanges(runtime.database),
      beforeReplay
    );
  });

  test("creates provenance-only replacement standings without notifications when rows are unchanged", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    const bare = baseCommand({
      offset: 400,
      expectedSeasonVersion: 2,
      homeScoreHundredths: 500,
      awayScoreHundredths: 300,
    });
    const command = withReplacement(
      runtime.repository,
      bare
    );
    assert.equal(
      command.replacement.standingsRowsChanged,
      false
    );
    assert.deepEqual(
      command.replacement.notifications,
      []
    );

    const result = runtime.repository.correct(command);
    assert.equal(result.standings_rows_changed, false);
    assert.equal(
      result.replacement_snapshot_id,
      command.replacement.snapshotId
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM notifications
          WHERE event_type = 'standings_corrected'
        `)
        .get().count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE cause = 'result_correction'
        `)
        .get().count,
      1
    );
  });

  test("restores paired correction-required recovery state before inserting post-final provenance and rolls it back on a late seam", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    markCorrectionRequired(runtime.database);
    const command = withReplacement(
      runtime.repository,
      baseCommand({
        offset: 450,
        expectedSeasonVersion: 2,
      })
    );
    runtime.repository.correct(command);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, version
          FROM matchups
          WHERE id = ?
        `)
        .get(IDS.matchup),
      { status: "final", version: 3 }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, version
          FROM matchup_weeks
          WHERE id = ?
        `)
        .get(IDS.week),
      { status: "final", version: 3 }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_result_versions
          WHERE standings_snapshot_id = ?
            AND matchup_result_version_id = ?
        `)
        .get(
          command.replacement.snapshotId,
          command.correction.resultVersionId
        ).count,
      1
    );

    const rollback = createRuntime(t);
    commitRegularFinalization(rollback.database);
    markCorrectionRequired(rollback.database);
    const rollbackCommand = withReplacement(
      rollback.repository,
      baseCommand({
        offset: 470,
        expectedSeasonVersion: 2,
      })
    );
    const failing =
      createSqliteMatchupResultCorrectionRepository({
        database: rollback.database,
        beforeCommit() {
          throw new Error("late recovery seam");
        },
      });
    assert.throws(
      () => failing.correct(rollbackCommand),
      {
        code: REPOSITORY_ERROR_CODES.operationFailed,
      }
    );
    assert.deepEqual(
      rollback.database
        .prepare(`
          SELECT status, version
          FROM matchups
          WHERE id = ?
        `)
        .get(IDS.matchup),
      { status: "correction_required", version: 2 }
    );
    assert.deepEqual(
      rollback.database
        .prepare(`
          SELECT status, version
          FROM matchup_weeks
          WHERE id = ?
        `)
        .get(IDS.week),
      { status: "correction_required", version: 2 }
    );
    assert.equal(
      rollback.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM matchup_result_versions
          WHERE id = ?
        `)
        .get(
          rollbackCommand.correction.resultVersionId
        ).count,
      0
    );

    const mixed = createRuntime(t);
    assert.equal(
      mixed.database
        .prepare(`
          UPDATE matchups
          SET status = 'correction_required',
              version = version + 1
          WHERE id = ?
        `)
        .run(IDS.matchup).changes,
      1
    );
    const mixedCommand = baseCommand({
      offset: 490,
    });
    assert.throws(
      () => mixed.repository.correct(mixedCommand),
      {
        code: REPOSITORY_ERROR_CODES.versionConflict,
      }
    );
    assert.equal(
      mixed.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM matchup_result_versions
          WHERE id = ?
        `)
        .get(
          mixedCommand.correction.resultVersionId
        ).count,
      0
    );
  });

  test("runs paired post-final recovery through the real service, outer repository context, and nested SQLite correction transaction", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    markCorrectionRequired(runtime.database);
    const repositoryContext =
      createSqliteRepositoryContext({
        database: runtime.database,
      });
    let nextId = 700;
    const service =
      createMatchupResultCorrectionService({
        repositoryContext,
        repository: runtime.repository,
        leagueAuthorization: {
          requireCommissioner(
            authenticated,
            leagueId
          ) {
            assert.deepEqual(authenticated, {
              session: { id: null },
            });
            assert.equal(leagueId, IDS.league);
            return {
              actorUserId:
                IDS.commissionerUser,
              membershipId:
                IDS.commissionerMembership,
              authority: "commissioner",
            };
          },
        },
        clock: {
          nowMs() {
            return CORRECTED_AT_MS;
          },
        },
        secureRandom: {
          id() {
            nextId += 1;
            return uuid(nextId);
          },
        },
      });
    const request = {
      leagueId: IDS.league,
      seasonId: IDS.season,
      resultId: IDS.matchupResult,
      input: {
        confirmed: true,
        homeScoreHundredths: 300,
        awayScoreHundredths: 500,
      },
      expectedResultVersion: 1,
      idempotencyKey:
        "vertical-recovery-correction",
      authenticated: {
        session: { id: null },
      },
      auditContext: {},
    };

    const result = service.correct(request);
    assert.equal(
      result.code,
      "MATCHUP_RESULT_CORRECTED"
    );
    assert.equal(result.replayed, false);
    assert.equal(result.result.resultVersion, 2);
    assert.equal(
      result.result.resultVersionNumber,
      2
    );
    assert.equal(
      result.result.standingsReplacement
        .snapshotVersion,
      3
    );
    assert.equal(
      result.result.standingsReplacement
        .standingsRowsChanged,
      true
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            matchups.status AS matchup_status,
            matchup_weeks.status AS week_status,
            matchup_results.status AS result_status,
            matchup_results.version AS result_version,
            seasons.version AS season_version
          FROM matchup_results
          JOIN matchups
            ON matchups.id =
              matchup_results.matchup_id
          JOIN matchup_weeks
            ON matchup_weeks.id =
              matchups.matchup_week_id
          JOIN seasons
            ON seasons.id =
              matchup_results.season_id
          WHERE matchup_results.id = ?
        `)
        .get(IDS.matchupResult),
      {
        matchup_status: "final",
        week_status: "final",
        result_status: "corrected",
        result_version: 2,
        season_version: 3,
      }
    );
    const replay = service.correct(request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay, result);
  });

  test("corrects a completed non-current season from preserved final rules without advancing the new current season", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    const currentSeasonId =
      rollToNextSeason(runtime.database);
    const command = withReplacement(
      runtime.repository,
      baseCommand({
        offset: 520,
        expectedSeasonVersion: 3,
      })
    );
    assert.equal(
      command.replacement.standingsRuleVersion,
      1
    );
    runtime.repository.correct(command);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            leagues.current_season_id,
            historical.status AS historical_status,
            historical.version AS historical_version,
            current.status AS current_status,
            current.version AS current_version,
            league_settings.standings_rule_version,
            replacement.standings_rule_version
              AS replacement_rule
          FROM leagues
          JOIN seasons AS historical
            ON historical.league_id = leagues.id
           AND historical.id = ?
          JOIN seasons AS current
            ON current.league_id = leagues.id
           AND current.id = leagues.current_season_id
          JOIN league_settings
            ON league_settings.league_id = leagues.id
          JOIN standings_snapshot_finalizations
            AS replacement
            ON replacement.league_id = leagues.id
           AND replacement.id = ?
          WHERE leagues.id = ?
        `)
        .get(
          IDS.season,
          command.replacement.finalizationId,
          IDS.league
        ),
      {
        current_season_id: currentSeasonId,
        historical_status: "completed",
        historical_version: 4,
        current_status: "active",
        current_version: 1,
        standings_rule_version: 2,
        replacement_rule: 1,
      }
    );
  });

  test("rechecks authority inside exact replay and scopes idempotency and durable evidence to the league", (t) => {
    const runtime = createRuntime(t);
    const command = baseCommand({ offset: 550 });
    const result = runtime.repository.correct(command);
    const beforeMismatch = totalChanges(
      runtime.database
    );
    assert.throws(
      () =>
        runtime.repository.correct({
          ...command,
          idempotency: {
            ...command.idempotency,
            requestHash: "e".repeat(64),
          },
        }),
      {
        code: REPOSITORY_ERROR_CODES.versionConflict,
      }
    );
    assert.equal(
      totalChanges(runtime.database),
      beforeMismatch
    );

    const otherLeagueId = uuid(999);
    assert.equal(
      runtime.repository.findCorrectionResult({
        leagueId: otherLeagueId,
        resultVersionId:
          command.correction.resultVersionId,
      }),
      null
    );
    assert.equal(
      runtime.repository.readCorrectionContext({
        leagueId: otherLeagueId,
        seasonId: IDS.season,
        resultId: IDS.matchupResult,
      }),
      null
    );
    assert.deepEqual(
      runtime.repository.findCorrectionResult({
        leagueId: IDS.league,
        resultVersionId:
          command.correction.resultVersionId,
      }),
      result
    );
    const crossLeagueCommand = {
      ...baseCommand({ offset: 570 }),
      leagueId: otherLeagueId,
    };
    crossLeagueCommand.audit = {
      ...crossLeagueCommand.audit,
      league_id: otherLeagueId,
    };
    assert.throws(
      () =>
        runtime.repository.correct(
          crossLeagueCommand
        ),
      {
        code: REPOSITORY_ERROR_CODES.recordNotFound,
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(crossLeagueCommand.idempotency.id)
        .count,
      0
    );

    assert.equal(
      runtime.database
        .prepare(`
          UPDATE league_memberships
          SET status = 'suspended',
              updated_at_ms = ${CORRECTED_AT_MS + 1},
              version = version + 1
          WHERE id = ?
            AND status = 'active'
        `)
        .run(IDS.commissionerMembership).changes,
      1
    );
    const beforeRevokedReplay = totalChanges(
      runtime.database
    );
    assert.throws(
      () => runtime.repository.correct(command),
      {
        code: REPOSITORY_ERROR_CODES.versionConflict,
      }
    );
    assert.equal(
      totalChanges(runtime.database),
      beforeRevokedReplay
    );
  });

  test("rejects a malformed whole correction chain and detects a missing post-final replacement from the initial immutable link", (t) => {
    const runtime = createRuntime(t);
    const first = baseCommand({ offset: 800 });
    runtime.repository.correct(first);
    const corruptVersionId = uuid(810);
    runtime.database
      .prepare(`
        INSERT INTO matchup_result_versions (
          id,
          league_id,
          season_id,
          matchup_result_id,
          version_number,
          home_team_id,
          away_team_id,
          home_score_hundredths,
          away_score_hundredths,
          outcome,
          source_snapshot_id,
          source_type,
          actor_user_id,
          reason,
          supersedes_version_id,
          created_at_ms
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          3,
          ?,
          ?,
          600,
          400,
          'home_win',
          ?,
          'correction',
          ?,
          'Malformed operation evidence',
          ?,
          ${CORRECTED_AT_MS + 1}
        )
      `)
      .run(
        corruptVersionId,
        IDS.league,
        IDS.season,
        IDS.matchupResult,
        IDS.teamA,
        IDS.teamB,
        IDS.statSnapshot,
        IDS.commissionerUser,
        first.correction.resultVersionId
      );
    assert.equal(
      runtime.database
        .prepare(`
          UPDATE matchup_results
          SET current_version_id = ?,
              version = 3,
              updated_at_ms =
                ${CORRECTED_AT_MS + 1}
          WHERE id = ?
            AND current_version_id = ?
            AND version = 2
        `)
        .run(
          corruptVersionId,
          IDS.matchupResult,
          first.correction.resultVersionId
        ).changes,
      1
    );
    const attempted = baseCommand({
      offset: 820,
      expectedResultVersion: 3,
      supersedesVersionId: corruptVersionId,
      nowMs: CORRECTED_AT_MS + 2,
    });
    assert.throws(
      () => runtime.repository.correct(attempted),
      {
        code: REPOSITORY_ERROR_CODES.versionConflict,
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(attempted.idempotency.id).count,
      0
    );

    const missingReplacement = createRuntime(t);
    commitRegularFinalization(
      missingReplacement.database
    );
    const corrupt = baseCommand({
      offset: 850,
      expectedSeasonVersion: 2,
    });
    missingReplacement.database
      .prepare(`
        INSERT INTO matchup_result_versions (
          id,
          league_id,
          season_id,
          matchup_result_id,
          version_number,
          home_team_id,
          away_team_id,
          home_score_hundredths,
          away_score_hundredths,
          outcome,
          source_snapshot_id,
          source_type,
          actor_user_id,
          reason,
          supersedes_version_id,
          created_at_ms
        ) VALUES (
          @resultVersionId,
          @leagueId,
          @seasonId,
          @resultId,
          2,
          @homeTeamId,
          @awayTeamId,
          @homeScoreHundredths,
          @awayScoreHundredths,
          @outcome,
          @sourceSnapshotId,
          'correction',
          @actorUserId,
          @reason,
          @supersedesVersionId,
          @nowMs
        )
      `)
      .run({
        ...corrupt.correction,
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.matchupResult,
        actorUserId: IDS.commissionerUser,
        nowMs: CORRECTED_AT_MS,
      });
    missingReplacement.database
      .prepare(`
        INSERT INTO matchup_operations (
          id,
          league_id,
          season_id,
          matchup_week_id,
          matchup_id,
          actor_user_id,
          operation_type,
          status,
          reason,
          metadata_json,
          started_at_ms,
          completed_at_ms
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          'result_correct',
          'succeeded',
          ?,
          ?,
          ${CORRECTED_AT_MS},
          ${CORRECTED_AT_MS}
        )
      `)
      .run(
        corrupt.correction.matchupOperationId,
        IDS.league,
        IDS.season,
        IDS.week,
        IDS.matchup,
        IDS.commissionerUser,
        corrupt.correction.reason,
        JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId:
            corrupt.correction.resultVersionId,
        })
      );
    missingReplacement.database
      .prepare(`
        INSERT INTO idempotency_requests (
          id,
          league_id,
          actor_user_id,
          operation,
          client_key,
          request_hash,
          status,
          result_type,
          result_id,
          created_at_ms,
          completed_at_ms,
          expires_at_ms
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          'completed',
          ?,
          ?,
          ${CORRECTED_AT_MS},
          ${CORRECTED_AT_MS},
          ${CORRECTED_AT_MS + 86_400_000}
        )
      `)
      .run(
        corrupt.idempotency.id,
        IDS.league,
        IDS.commissionerUser,
        MATCHUP_RESULT_CORRECTION_OPERATION,
        corrupt.idempotency.clientKey,
        corrupt.idempotency.requestHash,
        MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
        corrupt.correction.resultVersionId
      );
    missingReplacement.database.exec(
      "DROP TRIGGER " +
        "matchup_results_active_final_pointer_interlock"
    );
    assert.equal(
      missingReplacement.database
        .prepare(`
          UPDATE matchup_results
          SET current_version_id = ?,
              status = 'corrected',
              version = 2,
              updated_at_ms =
                ${CORRECTED_AT_MS}
          WHERE id = ?
            AND current_version_id = ?
        `)
        .run(
          corrupt.correction.resultVersionId,
          IDS.matchupResult,
          IDS.resultVersion
        ).changes,
      1
    );
    assert.throws(
      () =>
        missingReplacement.repository
          .findCorrectionResult({
            leagueId: IDS.league,
            resultVersionId:
              corrupt.correction.resultVersionId,
          }),
      {
        code:
          REPOSITORY_ERROR_CODES.schemaIncompatible,
      }
    );
  });

  test("rolls back every late write and preserves immutable pre-final replay after same-ms finalization", (t) => {
    const runtime = createRuntime(t);
    commitRegularFinalization(runtime.database);
    const command = withReplacement(
      runtime.repository,
      baseCommand({
        offset: 500,
        expectedSeasonVersion: 2,
      })
    );
    const failing =
      createSqliteMatchupResultCorrectionRepository({
        database: runtime.database,
        beforeCommit() {
          throw new Error("late seam");
        },
    });
    assert.throws(() => failing.correct(command), {
      code: REPOSITORY_ERROR_CODES.operationFailed,
    });
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM matchup_result_versions
          WHERE id = ?
        `)
        .get(command.correction.resultVersionId)
        .count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT current_version_id
          FROM matchup_results
          WHERE id = ?
        `)
        .get(IDS.matchupResult).current_version_id,
      IDS.resultVersion
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(command.idempotency.id).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM security_audit_events
          WHERE id = ?
        `)
        .get(command.audit.id).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshot_finalizations
          WHERE id = ?
        `)
        .get(IDS.finalization).status,
      "final"
    );

    const clean = createRuntime(t);
    const preFinal = baseCommand({
      offset: 600,
    });
    const preFinalResult =
      clean.repository.correct(preFinal);
    const descendant = baseCommand({
      offset: 620,
      expectedResultVersion: 2,
      supersedesVersionId:
        preFinal.correction.resultVersionId,
      homeScoreHundredths: 600,
      awayScoreHundredths: 400,
    });
    clean.repository.correct(descendant);
    commitRegularFinalization(clean.database, {
      resultVersionId:
        descendant.correction.resultVersionId,
      resultVersion: 3,
      homeScoreHundredths: 600,
      awayScoreHundredths: 400,
      nowMs: CORRECTED_AT_MS,
    });
    assert.deepEqual(
      clean.repository.findCorrectionResult({
        leagueId: IDS.league,
        resultVersionId:
          preFinal.correction.resultVersionId,
      }),
      preFinalResult
    );
    assert.deepEqual(
      clean.repository.correct(preFinal),
      preFinalResult
    );
  });
});
