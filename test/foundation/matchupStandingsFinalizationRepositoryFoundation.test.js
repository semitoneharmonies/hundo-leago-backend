const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

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
const NOW_MS = WEEK_ENDS_AT_MS + 1_000;
const IDS = Object.freeze({
  commissionerUser: uuid(1),
  memberUser: uuid(2),
  inactiveUser: uuid(3),
  league: uuid(10),
  otherLeague: uuid(11),
  season: uuid(12),
  otherSeason: uuid(13),
  commissionerMembership: uuid(20),
  memberMembership: uuid(21),
  inactiveMembership: uuid(22),
  teamA: uuid(30),
  teamB: uuid(31),
  week: uuid(40),
  matchup: uuid(41),
  otherWeek: uuid(42),
  crossSeasonBye: uuid(43),
  statSource: uuid(50),
  statRefresh: uuid(51),
  statSnapshot: uuid(52),
  matchupResult: uuid(60),
  resultVersion: uuid(61),
  corruptCorrectionVersion: uuid(62),
  currentSnapshot: uuid(70),
  idempotency: uuid(80),
  finalSnapshot: uuid(81),
  rowA: uuid(82),
  rowB: uuid(83),
  resultLink: uuid(84),
  identityA: uuid(85),
  identityB: uuid(86),
  operation: uuid(87),
  finalization: uuid(88),
  commissionerNotification: uuid(89),
  memberNotification: uuid(90),
  replayNotification: uuid(91),
  outbox: uuid(92),
  scheduleOperation: uuid(93),
  omittedWeek: uuid(94),
  ambiguousScheduleOperation: uuid(95),
  correctionOperation: uuid(96),
  shiftedScheduleOperation: uuid(97),
  shiftCommandResult: uuid(98),
  shiftIdempotency: uuid(99),
  recoveredWeek: uuid(100),
  recoveryScheduleOperation: uuid(101),
  scheduleRecovery: uuid(102),
  fad: uuid(103),
  readinessOperation: uuid(104),
});

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function insertUser(
  database,
  { id, email, displayName, status = "active" }
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
        @status,
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
      status,
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
  insertUser(database, {
    id: IDS.inactiveUser,
    email: "inactive@example.test",
    displayName: "Inactive",
    status: "deactivated",
  });

  const insertLeague = database.prepare(`
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
      @id,
      @name,
      @nameNormalized,
      'active',
      'America/Vancouver',
      NULL,
      NULL,
      1,
      1,
      1
    )
  `);
  insertLeague.run({
    id: IDS.league,
    name: "Final Standings League",
    nameNormalized: "final standings league",
  });
  insertLeague.run({
    id: IDS.otherLeague,
    name: "Other League",
    nameNormalized: "other league",
  });
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
  insertMembership.run({
    id: IDS.inactiveMembership,
    leagueId: IDS.league,
    userId: IDS.inactiveUser,
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
      ) VALUES (
        ?,
        'nhl',
        'active',
        1,
        1,
        1
      )
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

function seedT096ReplacementGeneration(database) {
  const shiftedStartsAtMs = WEEK_STARTS_AT_MS - WEEK_MS;
  const shiftedEndsAtMs = WEEK_ENDS_AT_MS - WEEK_MS;
  const metadataJson = JSON.stringify({
    action: "shift_week_one",
    oldScheduleOperationId: IDS.scheduleOperation,
    oldScheduleVersion: 1,
    newScheduleVersion: 2,
    previousFirstWeekStartsAtMs: WEEK_STARTS_AT_MS,
    firstWeekStartsAtMs: shiftedStartsAtMs,
    shiftedWeekCount: 1,
    replacedJobOccurrenceCount: 0,
    participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
    responseSha256: "c".repeat(64),
  });
  const transaction = database.transaction(() => {
    database.prepare(`
      UPDATE matchup_weeks
      SET starts_at_ms = ?,
          baseline_at_ms = ?,
          locks_at_ms = ?,
          ends_at_ms = ?,
          rolls_over_at_ms = ?,
          updated_at_ms = 2,
          version = 2
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(
      shiftedStartsAtMs,
      shiftedStartsAtMs + 60 * 60 * 1000,
      shiftedStartsAtMs + 16 * 60 * 60 * 1000,
      shiftedEndsAtMs,
      shiftedEndsAtMs,
      IDS.league,
      IDS.season,
      IDS.week
    );
    database.prepare(`
      UPDATE seasons
      SET regular_season_starts_at_ms = ?,
          regular_season_ends_at_ms = ?,
          fantasy_playoffs_start_at_ms = ?,
          fantasy_playoffs_end_at_ms = ?,
          updated_at_ms = 2,
          version = 2
      WHERE league_id = ? AND id = ?
    `).run(
      shiftedStartsAtMs - 2 * 24 * 60 * 60 * 1000,
      shiftedEndsAtMs,
      shiftedEndsAtMs,
      shiftedEndsAtMs + 2 * WEEK_MS,
      IDS.league,
      IDS.season
    );
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded',
          superseded_at_ms = 2,
          version = 2
      WHERE league_id = ?
        AND season_id = ?
        AND schedule_operation_id = ?
    `).run(IDS.league, IDS.season, IDS.scheduleOperation);
    database.prepare(`
      INSERT INTO matchup_operations (
        id, league_id, season_id, matchup_week_id, matchup_id,
        actor_user_id, operation_type, status, reason, metadata_json,
        started_at_ms, completed_at_ms
      ) VALUES (
        ?, ?, ?, NULL, NULL, ?, 'schedule_generate', 'succeeded',
        NULL, ?, 2, 2
      )
    `).run(
      IDS.shiftedScheduleOperation,
      IDS.league,
      IDS.season,
      IDS.commissionerUser,
      metadataJson
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version, schedule_operation_id,
        week_one_matchup_week_id, week_one_starts_at_ms, status,
        created_at_ms, superseded_at_ms, version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', 2, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.shiftedScheduleOperation,
      IDS.week,
      shiftedStartsAtMs
    );
    database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id, created_at_ms,
        completed_at_ms, expires_at_ms
      ) VALUES (
        ?, ?, ?, 'matchup.schedule.shift_week_one.v1',
        'shift-before-finalization', ?, 'started', NULL, NULL,
        2, NULL, 1000
      )
    `).run(
      IDS.shiftIdempotency,
      IDS.league,
      IDS.commissionerUser,
      "d".repeat(64)
    );
    database.prepare(`
      INSERT INTO matchup_schedule_command_results (
        id, league_id, season_id, action, idempotency_request_id,
        idempotency_operation, request_sha256, matchup_operation_id,
        actor_user_id, actor_membership_id, actor_authority,
        old_schedule_operation_id, old_schedule_version,
        new_schedule_operation_id, new_schedule_version,
        season_version_before, season_version_after,
        week_one_matchup_week_id, week_version_before,
        week_version_after, previous_first_week_starts_at_ms,
        first_week_starts_at_ms, last_week_ends_at_ms,
        nhl_regular_season_starts_at_ms,
        nhl_regular_season_ends_at_ms, fantasy_playoffs_start_at_ms,
        fantasy_playoffs_end_at_ms, calendar_persisted,
        participant_count, week_count, matchup_count, bye_count,
        shifted_week_count, replaced_job_occurrence_count,
        response_http_status, response_code, result_schema_version,
        created_at_ms, version
      ) VALUES (
        ?, ?, ?, 'shift_week_one', ?,
        'matchup.schedule.shift_week_one.v1', ?, ?, ?, ?,
        'commissioner', ?, 1, ?, 2, 1, 2, ?, 1, 2, ?, ?, ?,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        1, 0, 200, NULL, 1, 2, 1
      )
    `).run(
      IDS.shiftCommandResult,
      IDS.league,
      IDS.season,
      IDS.shiftIdempotency,
      "d".repeat(64),
      IDS.shiftedScheduleOperation,
      IDS.commissionerUser,
      IDS.commissionerMembership,
      IDS.scheduleOperation,
      IDS.shiftedScheduleOperation,
      IDS.week,
      WEEK_STARTS_AT_MS,
      shiftedStartsAtMs,
      shiftedEndsAtMs
    );
  });
  transaction.immediate();
  return { shiftedEndsAtMs, shiftedStartsAtMs };
}

function seedFadRecoveryReplacementGeneration(
  database,
  { recoveryKind = "completion" } = {}
) {
  assert.ok(
    ["completion", "pre_open"].includes(recoveryKind)
  );
  const shifted = seedT096ReplacementGeneration(database);
  const completedAtMs = 3;
  const candidateDeadlineAtMs =
    (recoveryKind === "pre_open"
      ? WEEK_STARTS_AT_MS
      : shifted.shiftedStartsAtMs) - WEEK_MS;
  const metadataJson = JSON.stringify({
    fadId: IDS.fad,
    recoveryId: IDS.scheduleRecovery,
    recoveryKind,
    oldScheduleOperationId: IDS.shiftedScheduleOperation,
    oldScheduleVersion: 2,
    newScheduleVersion: 3,
  });

  // This fixture isolates finalization's immutable provenance checks. The
  // recovery writer's full evidence graph and transition ordering are covered
  // in its dedicated foundation suite.
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_valid_insert"
  );
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_draft_schedule_recoveries_valid_insert"
  );

  const transaction = database.transaction(() => {
    database.prepare(`
      INSERT INTO free_agent_draft_readiness_operations (
        id, league_id, season_id, readiness_occurrence_key,
        trigger_kind, entry_draft_id, setup_exemption_id, job_run_id,
        status, attempt_count, lease_owner, lease_token,
        lease_expires_at_ms, blockers_json,
        matchup_schedule_version_before,
        matchup_schedule_version_after, schedule_recovery_id,
        created_fad_id, reminder_job_run_id, deadline_job_run_id,
        cards_opened_activity_id, cards_opened_outbox_event_id,
        started_at_ms, next_retry_at_ms, terminal_at_ms,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        ?, ?, ?, 'finalization-recovery', 'no_draft_inaugural',
        NULL, NULL, NULL, 'pending', 0, NULL, NULL, NULL, '[]',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 1, 1, 1
      )
    `).run(
      IDS.readinessOperation,
      IDS.league,
      IDS.season
    );
    database.prepare(`
      INSERT INTO matchup_weeks (
        id, league_id, season_id, week_key, sequence,
        starts_at_ms, baseline_at_ms, locks_at_ms, ends_at_ms,
        rolls_over_at_ms, status, created_at_ms, updated_at_ms, version
      ) VALUES (
        ?, ?, ?, 'recovered-regular-01', 2, ?, ?, ?, ?, ?,
        'final', ?, ?, 1
      )
    `).run(
      IDS.recoveredWeek,
      IDS.league,
      IDS.season,
      WEEK_STARTS_AT_MS,
      WEEK_STARTS_AT_MS + 60 * 60 * 1000,
      WEEK_STARTS_AT_MS + 16 * 60 * 60 * 1000,
      WEEK_ENDS_AT_MS,
      WEEK_ENDS_AT_MS,
      completedAtMs,
      WEEK_ENDS_AT_MS
    );
    database.prepare(`
      UPDATE matchups
      SET matchup_week_id = ?, updated_at_ms = ?, version = 2
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(
      IDS.recoveredWeek,
      WEEK_ENDS_AT_MS,
      IDS.league,
      IDS.season,
      IDS.matchup
    );
    database.prepare(`
      UPDATE stat_snapshots
      SET matchup_week_id = ?
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(
      IDS.recoveredWeek,
      IDS.league,
      IDS.season,
      IDS.statSnapshot
    );
    database.prepare(`
      DELETE FROM matchup_weeks
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(IDS.league, IDS.season, IDS.week);
    database.prepare(`
      UPDATE matchup_weeks
      SET week_key = 'regular-01', sequence = 1
      WHERE league_id = ? AND season_id = ? AND id = ?
    `).run(IDS.league, IDS.season, IDS.recoveredWeek);
    database.prepare(`
      UPDATE seasons
      SET regular_season_starts_at_ms = ?,
          regular_season_ends_at_ms = ?,
          fantasy_playoffs_start_at_ms = ?,
          fantasy_playoffs_end_at_ms = ?,
          updated_at_ms = ?,
          version = 3
      WHERE league_id = ? AND id = ?
    `).run(
      NHL_REGULAR_STARTS_AT_MS,
      WEEK_ENDS_AT_MS,
      WEEK_ENDS_AT_MS,
      WEEK_ENDS_AT_MS + 2 * WEEK_MS,
      completedAtMs,
      IDS.league,
      IDS.season
    );
    database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded',
          superseded_at_ms = ?,
          version = 2
      WHERE league_id = ?
        AND season_id = ?
        AND schedule_operation_id = ?
    `).run(
      completedAtMs,
      IDS.league,
      IDS.season,
      IDS.shiftedScheduleOperation
    );
    database.prepare(`
      INSERT INTO matchup_operations (
        id, league_id, season_id, matchup_week_id, matchup_id,
        actor_user_id, operation_type, status, reason, metadata_json,
        started_at_ms, completed_at_ms
      ) VALUES (
        ?, ?, ?, NULL, NULL, NULL, 'schedule_generate', 'succeeded',
        ?, ?, ?, ?
      )
    `).run(
      IDS.recoveryScheduleOperation,
      IDS.league,
      IDS.season,
      `fad_${recoveryKind}_schedule_recovery`,
      metadataJson,
      completedAtMs,
      completedAtMs
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version, schedule_operation_id,
        week_one_matchup_week_id, week_one_starts_at_ms, status,
        created_at_ms, superseded_at_ms, version
      ) VALUES (?, ?, 3, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.recoveryScheduleOperation,
      IDS.recoveredWeek,
      WEEK_STARTS_AT_MS,
      completedAtMs
    );
    if (recoveryKind === "pre_open") {
      database.prepare(`
        INSERT INTO free_agent_drafts (
          id, league_id, season_id, readiness_operation_id,
          readiness_occurrence_key, first_matchup_week_id,
          current_competition_first_matchup_week_id,
          schedule_recovery_id, participating_team_count, status,
          setup_path, entry_draft_id, setup_exemption_id,
          prior_season_rollover_id, no_draft_reason, opening_authority,
          opened_at_ms, help_opens_at_ms, candidate_deadline_at_ms,
          first_matchup_starts_at_ms, deadline_locked_at_ms,
          allocation_completed_at_ms, completed_at_ms, created_at_ms,
          updated_at_ms, version
        ) VALUES (
          ?, ?, ?, ?, 'finalization-recovery', ?, ?, NULL, 2,
          'cards_open', 'no_draft_inaugural', NULL, NULL, NULL,
          'test fixture', 'system', 1, ?, ?, ?, NULL, NULL, NULL,
          1, 1, 1
        )
      `).run(
        IDS.fad,
        IDS.league,
        IDS.season,
        IDS.readinessOperation,
        IDS.recoveredWeek,
        IDS.recoveredWeek,
        candidateDeadlineAtMs - 2 * 24 * 60 * 60 * 1000,
        candidateDeadlineAtMs,
        WEEK_STARTS_AT_MS
      );
    } else {
      database.prepare(`
        INSERT INTO free_agent_drafts (
          id, league_id, season_id, readiness_operation_id,
          readiness_occurrence_key, first_matchup_week_id,
          current_competition_first_matchup_week_id,
          schedule_recovery_id, participating_team_count, status,
          setup_path, entry_draft_id, setup_exemption_id,
          prior_season_rollover_id, no_draft_reason, opening_authority,
          opened_at_ms, help_opens_at_ms, candidate_deadline_at_ms,
          first_matchup_starts_at_ms, deadline_locked_at_ms,
          allocation_completed_at_ms, completed_at_ms, created_at_ms,
          updated_at_ms, version
        ) VALUES (
          ?, ?, ?, ?, 'finalization-recovery', ?, ?, ?, 2, 'rapid',
          'no_draft_inaugural', NULL, NULL, NULL, 'test fixture',
          'system', 1, ?, ?, ?, ?, ?, NULL, 1, ?, 1
        )
      `).run(
        IDS.fad,
        IDS.league,
        IDS.season,
        IDS.readinessOperation,
        IDS.week,
        IDS.recoveredWeek,
        IDS.scheduleRecovery,
        candidateDeadlineAtMs - 2 * 24 * 60 * 60 * 1000,
        candidateDeadlineAtMs,
        shifted.shiftedStartsAtMs,
        candidateDeadlineAtMs,
        candidateDeadlineAtMs + 1,
        candidateDeadlineAtMs + 1
      );
    }
    database.prepare(`
      INSERT INTO free_agent_draft_schedule_recoveries (
        id, league_id, season_id, fad_id, recovery_kind,
        matchup_operation_id, old_schedule_operation_id,
        new_schedule_operation_id, old_first_matchup_week_id,
        new_first_matchup_week_id, old_schedule_version,
        new_schedule_version, old_week_one_starts_at_ms,
        new_week_one_starts_at_ms, removed_week_count,
        removed_matchup_count, replaced_job_count, cancelled_job_count,
        completed_at_ms, evidence_schema_version, evidence_sha256,
        created_at_ms, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 3, ?, ?,
        1, 1, 0, 0, ?, 1, ?, ?, 1
      )
    `).run(
      IDS.scheduleRecovery,
      IDS.league,
      IDS.season,
      IDS.fad,
      recoveryKind,
      IDS.recoveryScheduleOperation,
      IDS.shiftedScheduleOperation,
      IDS.recoveryScheduleOperation,
      IDS.week,
      IDS.recoveredWeek,
      shifted.shiftedStartsAtMs,
      WEEK_STARTS_AT_MS,
      completedAtMs,
      "e".repeat(64),
      completedAtMs
    );
  });
  transaction.immediate();
  return { ...shifted, completedAtMs, recoveryKind };
}

function createRuntime(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-t145-repository-")
  );
  const connection = openDatabase({
    databasePath: path.join(root, "standings.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "t145-repository-foundation",
    now: () => 1,
  });
  seed(connection.database);
  const repositoryContext = createSqliteRepositoryContext({
    database: connection.database,
  });
  const repository =
    createSqliteMatchupStandingsFinalizationRepository({
      database: connection.database,
    });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    database: connection.database,
    repository,
    repositoryContext,
  };
}

function resultSetHash() {
  return calculateStandingsResultSetHash({
    leagueId: IDS.league,
    seasonId: IDS.season,
    standingsRuleVersion: "1",
    results: [
      {
        matchupId: IDS.matchup,
        matchupResultId: IDS.matchupResult,
        resultVersionId: IDS.resultVersion,
        resultVersion: 1,
      },
    ],
  });
}

function calculatedRows() {
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
        home_score_hundredths: 500,
        away_score_hundredths: 300,
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

function identityWrite(participant, id) {
  return {
    id,
    teamId: participant.team_id,
    teamDisplayName: participant.team_display_name,
    primaryColour: participant.primary_colour,
    secondaryColour: participant.secondary_colour,
    tertiaryColour: participant.tertiary_colour,
    patternTemplate: participant.pattern_template,
    sourceLogoObjectId:
      participant.source_logo_object_id,
    logoMediaType: participant.logo_media_type,
    logoByteLength: participant.logo_byte_length,
    logoWidth: participant.logo_width,
    logoHeight: participant.logo_height,
    logoContentSha256:
      participant.logo_content_sha256,
    logoContentBytes: participant.logo_content_bytes,
  };
}

function commitFinalization(
  runtime,
  { expectedSeasonVersion = 1 } = {}
) {
  const {
    repository,
    repositoryContext,
  } = runtime;
  const context = repository.readFinalizationContext({
    leagueId: IDS.league,
    seasonId: IDS.season,
  });
  const rows = calculatedRows();
  const rowsByTeamId = new Map(
    rows.map((row) => [row.teamId, row])
  );

  return repositoryContext.transaction(() => {
    repository.insertStartedIdempotency({
      id: IDS.idempotency,
      leagueId: IDS.league,
      actorUserId: IDS.commissionerUser,
      operation: STANDINGS_FINALIZATION_OPERATION,
      clientKey: "finalize-season",
      requestHash: "a".repeat(64),
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + 86_400_000,
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
      sourceResultVersion: 1,
      nowMs: NOW_MS,
    });
    repository.insertStandingsRows({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      rows: [
        rowWrite(rowsByTeamId.get(IDS.teamA), IDS.rowA),
        rowWrite(rowsByTeamId.get(IDS.teamB), IDS.rowB),
      ],
    });
    repository.insertResultVersionLinks({
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      links: [
        {
          id: IDS.resultLink,
          matchupWeekId:
            context.results[0].matchup_week_id,
          matchupId: IDS.matchup,
          matchupResultId: IDS.matchupResult,
          resultVersionId: IDS.resultVersion,
          resultVersionNumber: 1,
        },
      ],
      nowMs: NOW_MS,
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
              ? IDS.identityA
              : IDS.identityB
          )
      ),
      nowMs: NOW_MS,
    });
    repository.insertSucceededOperation({
      id: IDS.operation,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      actorUserId: IDS.commissionerUser,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      idempotencyRequestId: IDS.idempotency,
      metadataJson: JSON.stringify({
        resultSetHash: resultSetHash(),
        standingsRuleVersion: 1,
      }),
      nowMs: NOW_MS,
    });
    repository.insertFinalizationEvidence({
      id: IDS.finalization,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      finalizationVersion: 2,
      standingsRuleVersion: 1,
      resultSetHash: resultSetHash(),
      expectedMatchupCount: 1,
      expectedWeekCount: 1,
      participantCount: 2,
      seasonVersionBefore: expectedSeasonVersion,
      actorUserId: IDS.commissionerUser,
      actorMembershipId: IDS.commissionerMembership,
      actorAuthority: "commissioner",
      operationId: IDS.operation,
      idempotencyRequestId: IDS.idempotency,
      nowMs: NOW_MS,
    });

    const notificationIds = new Map([
      [
        IDS.commissionerUser,
        IDS.commissionerNotification,
      ],
      [IDS.memberUser, IDS.memberNotification],
    ]);
    for (const userId of context.activeMemberUserIds) {
      repository.writeFinalizedNotification({
        id: notificationIds.get(userId),
        leagueId: IDS.league,
        seasonId: IDS.season,
        finalizationId: IDS.finalization,
        snapshotId: IDS.finalSnapshot,
        userId,
        nowMs: NOW_MS,
      });
    }
    repository.writeFinalizedOutbox({
      id: IDS.outbox,
      leagueId: IDS.league,
      seasonId: IDS.season,
      snapshotId: IDS.finalSnapshot,
      seasonVersion: expectedSeasonVersion + 1,
      nowMs: NOW_MS,
    });

    assert.throws(
      () =>
        repository.completeIdempotency({
          id: IDS.idempotency,
          leagueId: IDS.league,
          finalizationId: IDS.finalization,
          completedAtMs: NOW_MS,
        }),
      { code: REPOSITORY_ERROR_CODES.constraint }
    );
    repository.advanceSeasonVersion({
      leagueId: IDS.league,
      seasonId: IDS.season,
      expectedVersion: expectedSeasonVersion,
      nowMs: NOW_MS,
    });
    repository.completeIdempotency({
      id: IDS.idempotency,
      leagueId: IDS.league,
      finalizationId: IDS.finalization,
      completedAtMs: NOW_MS,
    });
    return repository.findFinalizationResult({
      leagueId: IDS.league,
      finalizationId: IDS.finalization,
    });
  });
}

describe("T145 SQLite standings-finalization repository", () => {
  test("reads complete same-league finalization source and conflict evidence without writes", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    const after = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    assert.equal(after, before);
    assert.deepEqual(context.aggregate, {
      league_id: IDS.league,
      league_status: "active",
      league_timezone: "America/Vancouver",
      current_season_id: IDS.season,
      season_id: IDS.season,
      season_status: "active",
      season_version: 1,
      regular_season_starts_at_ms:
        NHL_REGULAR_STARTS_AT_MS,
      fantasy_playoffs_start_at_ms: WEEK_ENDS_AT_MS,
      scoring_rule_version: 1,
      standings_rule_version: 1,
    });
    assert.deepEqual(context.scheduleOperations, [
      {
        operation_league_id: IDS.league,
        operation_season_id: IDS.season,
        schedule_operation_id: IDS.scheduleOperation,
        operation_matchup_week_id: null,
        operation_matchup_id: null,
        actor_user_id: IDS.commissionerUser,
        operation_status: "succeeded",
        reason: null,
        metadata_json: JSON.stringify({
          participantCount: 2,
          participantTeamIds: [
            IDS.teamA,
            IDS.teamB,
          ].sort(),
          weekCount: 1,
          matchupCount: 1,
          jobOccurrenceCount: 0,
        }),
        started_at_ms: 1,
        completed_at_ms: 1,
      },
    ]);
    assert.deepEqual(context.scheduleGenerations, [
      {
        generation_league_id: IDS.league,
        generation_season_id: IDS.season,
        schedule_version: 1,
        schedule_operation_id: IDS.scheduleOperation,
        week_one_matchup_week_id: IDS.week,
        week_one_starts_at_ms: WEEK_STARTS_AT_MS,
        generation_status: "current",
        generation_created_at_ms: 1,
        generation_superseded_at_ms: null,
        generation_version: 1,
      },
    ]);
    assert.deepEqual(context.scheduleCommandResults, []);
    assert.deepEqual(context.scheduleRecoveries, []);
    assert.deepEqual(context.correctionOperations, []);
    assert.deepEqual(
      context.weeks.map(({ sequence, status }) => [
        sequence,
        status,
      ]),
      [[1, "final"]]
    );
    assert.deepEqual(
      context.results.map(
        ({
          matchup_id: matchupId,
          matchup_result_id: resultId,
          result_version_id: versionId,
          result_status: status,
        }) => [matchupId, resultId, versionId, status]
      ),
      [
        [
          IDS.matchup,
          IDS.matchupResult,
          IDS.resultVersion,
          "official",
        ],
      ]
    );
    assert.deepEqual(context.byes, []);
    assert.deepEqual(
      context.participants.map(
        ({
          team_id: teamId,
          team_display_name: name,
        }) => [teamId, name]
      ),
      [
        [IDS.teamA, "Alpha"],
        [IDS.teamB, "Bravo"],
      ]
    );
    assert.deepEqual(context.activeMemberUserIds, [
      IDS.commissionerUser,
      IDS.memberUser,
    ]);
    assert.deepEqual(
      context.snapshots.map(
        ({
          snapshot_id: snapshotId,
          snapshot_status: status,
          finalization_id: finalizationId,
        }) => [snapshotId, status, finalizationId]
      ),
      [[IDS.currentSnapshot, "current", null]]
    );
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.results));
    assert.ok(Object.isFrozen(context.results[0]));
    assert.ok(Object.isFrozen(context.scheduleOperations));
    assert.ok(Object.isFrozen(context.scheduleOperations[0]));
    assert.ok(Object.isFrozen(context.scheduleGenerations));
    assert.ok(Object.isFrozen(context.scheduleGenerations[0]));
    assert.ok(Object.isFrozen(context.scheduleCommandResults));
    assert.ok(Object.isFrozen(context.scheduleRecoveries));
    assert.ok(Object.isFrozen(context.correctionOperations));
    assert.equal(
      runtime.repository.readFinalizationContext({
        leagueId: IDS.otherLeague,
        seasonId: IDS.season,
      }),
      null
    );

    runtime.database
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
          ?, ?, ?, 2, 1, 'final',
          ${WEEK_ENDS_AT_MS},
          ${WEEK_ENDS_AT_MS}
        )
      `)
      .run(uuid(71), IDS.league, IDS.season);
    const withLegacy =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    assert.deepEqual(
      withLegacy.snapshots.map(
        ({
          snapshot_status: status,
          finalization_id: finalizationId,
        }) => [status, finalizationId]
      ),
      [
        ["current", null],
        ["final", null],
      ]
    );
  });

  test("exposes ambiguous malformed schedule roots without mutating evidence", (t) => {
    const runtime = createRuntime(t);
    runtime.database
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
          ?, ?, ?, NULL, NULL, ?,
          'schedule_generate',
          'succeeded',
          NULL,
          '{',
          2,
          2
        )
      `)
      .run(
        IDS.ambiguousScheduleOperation,
        IDS.league,
        IDS.season,
        IDS.commissionerUser
      );
    const before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });

    assert.equal(
      runtime.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
    assert.equal(context.scheduleOperations.length, 2);
    assert.equal(
      context.scheduleOperations[1].schedule_operation_id,
      IDS.ambiguousScheduleOperation
    );
    assert.equal(
      context.scheduleOperations[1].metadata_json,
      "{"
    );
  });

  test("fails closed and rolls back finalization when a succeeded schedule root is not bound to a generation", (t) => {
    const runtime = createRuntime(t);
    runtime.database
      .prepare(`
        INSERT INTO matchup_operations (
          id, league_id, season_id, matchup_week_id, matchup_id,
          actor_user_id, operation_type, status, reason, metadata_json,
          started_at_ms, completed_at_ms
        ) VALUES (
          ?, ?, ?, NULL, NULL, ?, 'schedule_generate', 'succeeded',
          NULL, ?, 2, 2
        )
      `)
      .run(
        IDS.ambiguousScheduleOperation,
        IDS.league,
        IDS.season,
        IDS.commissionerUser,
        JSON.stringify({
          participantCount: 2,
          participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
          weekCount: 1,
          matchupCount: 1,
        })
      );

    assert.throws(
      () => commitFinalization(runtime),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /schedule-generation lineage is inconsistent/
        );
        return true;
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE league_id = ? AND season_id = ?
          ORDER BY snapshot_version
        `)
        .all(IDS.league, IDS.season),
      [{ status: "current" }]
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT version
          FROM seasons
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.season).version,
      1
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed and rolls back finalization when no schedule generation is current", (t) => {
    const runtime = createRuntime(t);
    runtime.database.prepare(`
      UPDATE season_matchup_schedule_generations
      SET status = 'superseded', superseded_at_ms = 2, version = 2
      WHERE league_id = ? AND season_id = ?
    `).run(IDS.league, IDS.season);

    assert.throws(
      () => commitFinalization(runtime),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /requires one current schedule generation/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed and rolls back finalization when multiple schedule generations are current", (t) => {
    const runtime = createRuntime(t);
    runtime.database.exec(`
      DROP INDEX season_matchup_schedule_generations_one_current;
      DROP TRIGGER season_matchup_schedule_generations_valid_insert;
    `);
    runtime.database
      .prepare(`
        INSERT INTO matchup_operations (
          id, league_id, season_id, matchup_week_id, matchup_id,
          actor_user_id, operation_type, status, reason, metadata_json,
          started_at_ms, completed_at_ms
        ) VALUES (
          ?, ?, ?, NULL, NULL, ?, 'schedule_generate', 'succeeded',
          NULL, ?, 2, 2
        )
      `)
      .run(
        IDS.ambiguousScheduleOperation,
        IDS.league,
        IDS.season,
        IDS.commissionerUser,
        JSON.stringify({
          participantCount: 2,
          participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
          weekCount: 1,
          matchupCount: 1,
        })
      );
    runtime.database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version, schedule_operation_id,
        week_one_matchup_week_id, week_one_starts_at_ms, status,
        created_at_ms, superseded_at_ms, version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', 2, NULL, 1)
    `).run(
      IDS.league,
      IDS.season,
      IDS.ambiguousScheduleOperation,
      IDS.week,
      WEEK_STARTS_AT_MS
    );

    assert.throws(
      () => commitFinalization(runtime),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /(?:requires one current schedule generation|replacement schedule provenance is inconsistent)/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed and rolls back finalization when the current replacement root mismatches its predecessor", (t) => {
    const runtime = createRuntime(t);
    seedT096ReplacementGeneration(runtime.database);
    const operation = runtime.database
      .prepare(`
        SELECT metadata_json
        FROM matchup_operations
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .get(
        IDS.league,
        IDS.season,
        IDS.shiftedScheduleOperation
      );
    const mismatchedMetadata = JSON.parse(
      operation.metadata_json
    );
    mismatchedMetadata.oldScheduleOperationId =
      IDS.ambiguousScheduleOperation;
    runtime.database.exec(
      "DROP TRIGGER matchup_operations_schedule_generate_immutable_update"
    );
    runtime.database
      .prepare(`
        UPDATE matchup_operations
        SET metadata_json = ?
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .run(
        JSON.stringify(mismatchedMetadata),
        IDS.league,
        IDS.season,
        IDS.shiftedScheduleOperation
      );

    assert.throws(
      () =>
        commitFinalization(runtime, {
          expectedSeasonVersion: 2,
        }),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /replacement schedule provenance is inconsistent/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT version
          FROM seasons
          WHERE league_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.season).version,
      2
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed on duplicate-key replacement metadata even when total key count is exact", (t) => {
    const runtime = createRuntime(t);
    seedT096ReplacementGeneration(runtime.database);
    const metadata = JSON.parse(
      runtime.database
        .prepare(`
          SELECT metadata_json
          FROM matchup_operations
          WHERE league_id = ? AND season_id = ? AND id = ?
        `)
        .get(
          IDS.league,
          IDS.season,
          IDS.shiftedScheduleOperation
        ).metadata_json
    );
    delete metadata.oldScheduleOperationId;
    const remainingMetadata = JSON.stringify(metadata);
    const malformedMetadata =
      `{"action":"shift_week_one",` +
      remainingMetadata.slice(1);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            json_valid(?) AS is_valid,
            (SELECT COUNT(*) FROM json_each(?)) AS key_count,
            (
              SELECT COUNT(DISTINCT key)
              FROM json_each(?)
            ) AS distinct_key_count,
            json_type(?, '$.oldScheduleOperationId') AS missing_type
        `)
        .get(
          malformedMetadata,
          malformedMetadata,
          malformedMetadata,
          malformedMetadata
        ),
      {
        is_valid: 1,
        key_count: 10,
        distinct_key_count: 9,
        missing_type: null,
      }
    );
    runtime.database.exec(
      "DROP TRIGGER matchup_operations_schedule_generate_immutable_update"
    );
    runtime.database
      .prepare(`
        UPDATE matchup_operations
        SET metadata_json = ?
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .run(
        malformedMetadata,
        IDS.league,
        IDS.season,
        IDS.shiftedScheduleOperation
      );

    assert.throws(
      () =>
        commitFinalization(runtime, {
          expectedSeasonVersion: 2,
        }),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /replacement schedule provenance is inconsistent/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed on duplicate-key initial metadata when every mandatory key is present", (t) => {
    const runtime = createRuntime(t);
    const canonicalMetadata = JSON.stringify({
      participantCount: 2,
      participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
      weekCount: 1,
      matchupCount: 1,
    });
    const malformedMetadata =
      `{"participantCount":2,` +
      canonicalMetadata.slice(1);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            json_valid(?) AS is_valid,
            (SELECT COUNT(*) FROM json_each(?)) AS key_count,
            (
              SELECT COUNT(DISTINCT key)
              FROM json_each(?)
            ) AS distinct_key_count
        `)
        .get(
          malformedMetadata,
          malformedMetadata,
          malformedMetadata
        ),
      {
        is_valid: 1,
        key_count: 5,
        distinct_key_count: 4,
      }
    );
    runtime.database.exec(
      "DROP TRIGGER matchup_operations_schedule_generate_immutable_update"
    );
    runtime.database
      .prepare(`
        UPDATE matchup_operations
        SET metadata_json = ?
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .run(
        malformedMetadata,
        IDS.league,
        IDS.season,
        IDS.scheduleOperation
      );

    assert.throws(
      () => commitFinalization(runtime),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /initial schedule provenance is inconsistent/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed on replacement metadata with a missing required key", (t) => {
    const runtime = createRuntime(t);
    seedT096ReplacementGeneration(runtime.database);
    const metadata = JSON.parse(
      runtime.database
        .prepare(`
          SELECT metadata_json
          FROM matchup_operations
          WHERE league_id = ? AND season_id = ? AND id = ?
        `)
        .get(
          IDS.league,
          IDS.season,
          IDS.shiftedScheduleOperation
        ).metadata_json
    );
    delete metadata.oldScheduleOperationId;
    const malformedMetadata = JSON.stringify(metadata);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            json_valid(?) AS is_valid,
            (SELECT COUNT(*) FROM json_each(?)) AS key_count,
            (
              SELECT COUNT(DISTINCT key)
              FROM json_each(?)
            ) AS distinct_key_count,
            json_type(?, '$.oldScheduleOperationId') AS missing_type
        `)
        .get(
          malformedMetadata,
          malformedMetadata,
          malformedMetadata,
          malformedMetadata
        ),
      {
        is_valid: 1,
        key_count: 9,
        distinct_key_count: 9,
        missing_type: null,
      }
    );
    runtime.database.exec(
      "DROP TRIGGER matchup_operations_schedule_generate_immutable_update"
    );
    runtime.database
      .prepare(`
        UPDATE matchup_operations
        SET metadata_json = ?
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .run(
        malformedMetadata,
        IDS.league,
        IDS.season,
        IDS.shiftedScheduleOperation
      );

    assert.throws(
      () =>
        commitFinalization(runtime, {
          expectedSeasonVersion: 2,
        }),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /replacement schedule provenance is inconsistent/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("fails closed when a complete replacement metadata branch evaluates to SQL null", (t) => {
    const runtime = createRuntime(t);
    seedT096ReplacementGeneration(runtime.database);
    const metadata = JSON.parse(
      runtime.database
        .prepare(`
          SELECT metadata_json
          FROM matchup_operations
          WHERE league_id = ? AND season_id = ? AND id = ?
        `)
        .get(
          IDS.league,
          IDS.season,
          IDS.shiftedScheduleOperation
        ).metadata_json
    );
    metadata.action = null;
    const malformedMetadata = JSON.stringify(metadata);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            json_valid(?) AS is_valid,
            (SELECT COUNT(*) FROM json_each(?)) AS key_count,
            (
              SELECT COUNT(DISTINCT key)
              FROM json_each(?)
            ) AS distinct_key_count,
            json_type(?, '$.action') AS action_type
        `)
        .get(
          malformedMetadata,
          malformedMetadata,
          malformedMetadata,
          malformedMetadata
        ),
      {
        is_valid: 1,
        key_count: 10,
        distinct_key_count: 10,
        action_type: "null",
      }
    );
    runtime.database.exec(
      "DROP TRIGGER matchup_operations_schedule_generate_immutable_update"
    );
    runtime.database
      .prepare(`
        UPDATE matchup_operations
        SET metadata_json = ?
        WHERE league_id = ? AND season_id = ? AND id = ?
      `)
      .run(
        malformedMetadata,
        IDS.league,
        IDS.season,
        IDS.shiftedScheduleOperation
      );

    assert.throws(
      () =>
        commitFinalization(runtime, {
          expectedSeasonVersion: 2,
        }),
      (error) => {
        assert.equal(
          error.code,
          REPOSITORY_ERROR_CODES.constraint
        );
        assert.match(
          error.cause.message,
          /replacement schedule provenance is inconsistent/
        );
        return true;
      }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_finalizations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("binds finalization to the exact T-096 current generation while retaining its superseded root", (t) => {
    const runtime = createRuntime(t);
    const shifted = seedT096ReplacementGeneration(
      runtime.database
    );
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });

    assert.deepEqual(
      context.scheduleGenerations.map((generation) => [
        generation.schedule_version,
        generation.schedule_operation_id,
        generation.generation_status,
        generation.week_one_starts_at_ms,
      ]),
      [
        [
          1,
          IDS.scheduleOperation,
          "superseded",
          WEEK_STARTS_AT_MS,
        ],
        [
          2,
          IDS.shiftedScheduleOperation,
          "current",
          shifted.shiftedStartsAtMs,
        ],
      ]
    );
    assert.equal(context.scheduleCommandResults.length, 1);
    assert.equal(
      context.scheduleCommandResults[0]
        .command_new_schedule_operation_id,
      IDS.shiftedScheduleOperation
    );
    assert.deepEqual(context.scheduleRecoveries, []);

    const finalized = commitFinalization(runtime, {
      expectedSeasonVersion: 2,
    });
    assert.equal(finalized.operation_id, IDS.operation);
    assert.equal(finalized.season_version, 3);
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM season_matchup_schedule_generations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      2
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("binds finalization to the exact FAD-recovery current generation while retaining both superseded roots", (t) => {
    const runtime = createRuntime(t);
    const recovery = seedFadRecoveryReplacementGeneration(
      runtime.database
    );
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });

    assert.deepEqual(
      context.scheduleGenerations.map((generation) => [
        generation.schedule_version,
        generation.schedule_operation_id,
        generation.generation_status,
        generation.week_one_matchup_week_id,
        generation.week_one_starts_at_ms,
      ]),
      [
        [
          1,
          IDS.scheduleOperation,
          "superseded",
          IDS.week,
          WEEK_STARTS_AT_MS,
        ],
        [
          2,
          IDS.shiftedScheduleOperation,
          "superseded",
          IDS.week,
          recovery.shiftedStartsAtMs,
        ],
        [
          3,
          IDS.recoveryScheduleOperation,
          "current",
          IDS.recoveredWeek,
          WEEK_STARTS_AT_MS,
        ],
      ]
    );
    assert.equal(context.scheduleCommandResults.length, 1);
    assert.deepEqual(context.scheduleRecoveries, [
      {
        recovery_id: IDS.scheduleRecovery,
        recovery_league_id: IDS.league,
        recovery_season_id: IDS.season,
        recovery_fad_id: IDS.fad,
        recovery_kind: "completion",
        recovery_matchup_operation_id:
          IDS.recoveryScheduleOperation,
        recovery_old_schedule_operation_id:
          IDS.shiftedScheduleOperation,
        recovery_new_schedule_operation_id:
          IDS.recoveryScheduleOperation,
        recovery_old_first_matchup_week_id: IDS.week,
        recovery_new_first_matchup_week_id:
          IDS.recoveredWeek,
        recovery_old_schedule_version: 2,
        recovery_new_schedule_version: 3,
        recovery_old_week_one_starts_at_ms:
          recovery.shiftedStartsAtMs,
        recovery_new_week_one_starts_at_ms:
          WEEK_STARTS_AT_MS,
        recovery_completed_at_ms: recovery.completedAtMs,
        recovery_evidence_schema_version: 1,
        recovery_evidence_sha256: "e".repeat(64),
        recovery_created_at_ms: recovery.completedAtMs,
        recovery_version: 1,
      },
    ]);

    const finalized = commitFinalization(runtime, {
      expectedSeasonVersion: 3,
    });
    assert.equal(finalized.operation_id, IDS.operation);
    assert.equal(finalized.season_version, 4);
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM season_matchup_schedule_generations
          WHERE league_id = ? AND season_id = ?
        `)
        .get(IDS.league, IDS.season).count,
      3
    );
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(
      runtime.database.pragma("foreign_key_check"),
      []
    );
  });

  test("binds finalization to an exact pre-open FAD-recovery current generation", (t) => {
    const runtime = createRuntime(t);
    const recovery = seedFadRecoveryReplacementGeneration(
      runtime.database,
      { recoveryKind: "pre_open" }
    );
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });

    assert.equal(context.scheduleGenerations.length, 3);
    assert.deepEqual(
      context.scheduleGenerations.map((generation) =>
        generation.generation_status
      ),
      ["superseded", "superseded", "current"]
    );
    assert.deepEqual(context.scheduleRecoveries, [
      {
        recovery_id: IDS.scheduleRecovery,
        recovery_league_id: IDS.league,
        recovery_season_id: IDS.season,
        recovery_fad_id: IDS.fad,
        recovery_kind: "pre_open",
        recovery_matchup_operation_id:
          IDS.recoveryScheduleOperation,
        recovery_old_schedule_operation_id:
          IDS.shiftedScheduleOperation,
        recovery_new_schedule_operation_id:
          IDS.recoveryScheduleOperation,
        recovery_old_first_matchup_week_id: IDS.week,
        recovery_new_first_matchup_week_id:
          IDS.recoveredWeek,
        recovery_old_schedule_version: 2,
        recovery_new_schedule_version: 3,
        recovery_old_week_one_starts_at_ms:
          recovery.shiftedStartsAtMs,
        recovery_new_week_one_starts_at_ms:
          WEEK_STARTS_AT_MS,
        recovery_completed_at_ms: recovery.completedAtMs,
        recovery_evidence_schema_version: 1,
        recovery_evidence_sha256: "e".repeat(64),
        recovery_created_at_ms: recovery.completedAtMs,
        recovery_version: 1,
      },
    ]);
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT
            status,
            first_matchup_week_id,
            current_competition_first_matchup_week_id,
            schedule_recovery_id
          FROM free_agent_drafts
          WHERE league_id = ? AND season_id = ? AND id = ?
        `)
        .get(IDS.league, IDS.season, IDS.fad),
      {
        status: "cards_open",
        first_matchup_week_id: IDS.recoveredWeek,
        current_competition_first_matchup_week_id:
          IDS.recoveredWeek,
        schedule_recovery_id: null,
      }
    );
    assert.deepEqual(
      context.scheduleOperations.at(-1),
      {
        operation_league_id: IDS.league,
        operation_season_id: IDS.season,
        schedule_operation_id:
          IDS.recoveryScheduleOperation,
        operation_matchup_week_id: null,
        operation_matchup_id: null,
        actor_user_id: null,
        operation_status: "succeeded",
        reason: "fad_pre_open_schedule_recovery",
        metadata_json: JSON.stringify({
          fadId: IDS.fad,
          recoveryId: IDS.scheduleRecovery,
          recoveryKind: "pre_open",
          oldScheduleOperationId:
            IDS.shiftedScheduleOperation,
          oldScheduleVersion: 2,
          newScheduleVersion: 3,
        }),
        started_at_ms: recovery.completedAtMs,
        completed_at_ms: recovery.completedAtMs,
      }
    );

    const finalized = commitFinalization(runtime, {
      expectedSeasonVersion: 3,
    });
    assert.equal(finalized.operation_id, IDS.operation);
    assert.equal(finalized.season_version, 4);
    assert.equal(
      runtime.database.pragma("integrity_check", {
        simple: true,
      }),
      "ok"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("exposes truncated and omitted-week calendar evidence without writes", (t) => {
    const runtime = createRuntime(t);
    runtime.database
      .prepare(`
        UPDATE seasons
        SET fantasy_playoffs_start_at_ms = ?,
            fantasy_playoffs_end_at_ms = ?,
            updated_at_ms = updated_at_ms + 1,
            version = version + 1
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        WEEK_ENDS_AT_MS + WEEK_MS,
        WEEK_ENDS_AT_MS + 3 * WEEK_MS,
        IDS.league,
        IDS.season
      );
    let before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const truncated =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    assert.equal(
      runtime.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
    assert.notEqual(
      truncated.weeks.at(-1).rolls_over_at_ms,
      truncated.aggregate.fantasy_playoffs_start_at_ms
    );

    runtime.database
      .prepare(`
        UPDATE seasons
        SET regular_season_starts_at_ms = ?
        WHERE league_id = ?
          AND id = ?
      `)
      .run(
        WEEK_STARTS_AT_MS -
          WEEK_MS -
          2 * 24 * 60 * 60 * 1000,
        IDS.league,
        IDS.season
      );
    runtime.database
      .prepare(`
        UPDATE matchup_weeks
        SET sequence = 2,
            week_key = 'regular-02',
            version = version + 1
        WHERE league_id = ?
          AND season_id = ?
          AND id = ?
      `)
      .run(IDS.league, IDS.season, IDS.week);
    runtime.database
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
          ?, ?, ?,
          'regular-01',
          1,
          ?,
          ?,
          ?,
          ?,
          ?,
          'final',
          1,
          ?,
          2
        )
      `)
      .run(
        IDS.omittedWeek,
        IDS.league,
        IDS.season,
        WEEK_STARTS_AT_MS - WEEK_MS,
        WEEK_STARTS_AT_MS -
          WEEK_MS +
          60 * 60 * 1000,
        WEEK_STARTS_AT_MS -
          WEEK_MS +
          16 * 60 * 60 * 1000,
        WEEK_STARTS_AT_MS,
        WEEK_STARTS_AT_MS,
        WEEK_STARTS_AT_MS
      );
    before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const omitted =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    assert.equal(
      runtime.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
    assert.deepEqual(
      omitted.weeks.map(({ sequence }) => sequence),
      [1, 2]
    );
    assert.equal(omitted.results.length, 1);
    assert.equal(omitted.byes.length, 0);
    assert.equal(
      JSON.parse(
        omitted.scheduleOperations[0].metadata_json
      ).weekCount,
      1
    );
  });

  test("exposes exact bye-to-week scope evidence for complete per-week coverage validation", (t) => {
    const runtime = createRuntime(t);
    runtime.database
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
          'planned',
          500,
          600,
          700,
          800,
          1,
          1,
          1
        )
      `)
      .run(IDS.otherSeason, IDS.league);
    runtime.database
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
          'other-01',
          1,
          500,
          510,
          520,
          590,
          600,
          'scheduled',
          1,
          1,
          1
        )
      `)
      .run(IDS.otherWeek, IDS.league, IDS.otherSeason);
    runtime.database
      .prepare(`
        INSERT INTO matchup_byes (
          id,
          league_id,
          season_id,
          matchup_week_id,
          team_id,
          team_display_name,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'Alpha', 1)
      `)
      .run(
        IDS.crossSeasonBye,
        IDS.league,
        IDS.season,
        IDS.otherWeek,
        IDS.teamA
      );

    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    assert.deepEqual(context.byes, [
      {
        bye_id: IDS.crossSeasonBye,
        matchup_week_id: IDS.otherWeek,
        team_id: IDS.teamA,
        joined_week_id: IDS.otherWeek,
        joined_week_season_id: IDS.otherSeason,
        joined_week_sequence: 1,
        joined_week_status: "scheduled",
      },
    ]);
  });

  test("uses the current team name for final identity while preserving old schedule names", (t) => {
    const runtime = createRuntime(t);
    runtime.database
      .prepare(`
        UPDATE teams
        SET name = 'Alpha Renamed',
          name_normalized = 'alpha renamed',
          updated_at_ms = ${NOW_MS},
          version = version + 1
        WHERE league_id = ?
          AND id = ?
      `)
      .run(IDS.league, IDS.teamA);

    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    assert.equal(
      context.results[0].home_team_id,
      IDS.teamA
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT home_team_name
          FROM matchups
          WHERE id = ?
        `)
        .get(IDS.matchup).home_team_name,
      "Alpha"
    );
    assert.equal(
      context.participants.find(
        ({ team_id: teamId }) => teamId === IDS.teamA
      ).team_display_name,
      "Alpha Renamed"
    );
  });

  test("exposes an exact invalid correction chain even when count and latest version agree", (t) => {
    const runtime = createRuntime(t);
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
          2,
          ?,
          ?,
          400,
          300,
          'home_win',
          ?,
          'correction',
          ?,
          'Corrupt self-reference',
          ?,
          ${NOW_MS}
        )
      `)
      .run(
        IDS.corruptCorrectionVersion,
        IDS.league,
        IDS.season,
        IDS.matchupResult,
        IDS.teamA,
        IDS.teamB,
        IDS.statSnapshot,
        IDS.commissionerUser,
        IDS.corruptCorrectionVersion
      );
    runtime.database
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
          ?, ?, ?, ?, ?, ?,
          'result_correct',
          'succeeded',
          'Corrupt self-reference',
          ?,
          ${NOW_MS},
          ${NOW_MS}
        )
      `)
      .run(
        IDS.correctionOperation,
        IDS.league,
        IDS.season,
        IDS.week,
        IDS.matchup,
        IDS.commissionerUser,
        JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId:
            IDS.corruptCorrectionVersion,
        })
      );
    runtime.database
      .prepare(`
        UPDATE matchup_results
        SET current_version_id = ?,
          status = 'corrected',
          updated_at_ms = ${NOW_MS},
          version = version + 1
        WHERE id = ?
      `)
      .run(
        IDS.corruptCorrectionVersion,
        IDS.matchupResult
      );

    const before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const context =
      runtime.repository.readFinalizationContext({
        leagueId: IDS.league,
        seasonId: IDS.season,
      });
    const [result] = context.results;
    assert.equal(
      runtime.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
    assert.equal(result.result_version_count, 2);
    assert.equal(result.latest_version_number, 2);
    assert.equal(
      result.previous_result_version_id,
      IDS.resultVersion
    );
    assert.equal(
      result.supersedes_version_id,
      IDS.corruptCorrectionVersion
    );
    assert.equal(
      result.superseded_version_record_id,
      IDS.corruptCorrectionVersion
    );
    assert.equal(
      result.superseded_version_matchup_result_id,
      IDS.matchupResult
    );
    assert.equal(result.superseded_version_number, 2);
    assert.equal(result.supersedes_previous_version, 0);
    assert.equal(result.invalid_version_chain_count, 1);
    assert.deepEqual(context.correctionOperations, [
      {
        correction_operation_id: IDS.correctionOperation,
        matchup_week_id: IDS.week,
        matchup_id: IDS.matchup,
        actor_user_id: IDS.commissionerUser,
        operation_status: "succeeded",
        reason: "Corrupt self-reference",
        metadata_json: JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId:
            IDS.corruptCorrectionVersion,
        }),
        started_at_ms: NOW_MS,
        completed_at_ms: NOW_MS,
        metadata_result_id: IDS.matchupResult,
        metadata_result_version_id:
          IDS.corruptCorrectionVersion,
        matched_result_version_id:
          IDS.corruptCorrectionVersion,
        matched_matchup_result_id: IDS.matchupResult,
        matched_version_number: 2,
        matched_source_type: "correction",
        matched_actor_user_id: IDS.commissionerUser,
        matched_reason: "Corrupt self-reference",
        matched_created_at_ms: NOW_MS,
        matched_supersedes_version_id:
          IDS.corruptCorrectionVersion,
        current_matchup_result_id: IDS.matchupResult,
        current_result_version_id:
          IDS.corruptCorrectionVersion,
        current_result_status: "corrected",
        result_matchup_id: IDS.matchup,
      },
    ]);
    assert.ok(Object.isFrozen(context.correctionOperations));
    assert.ok(Object.isFrozen(context.correctionOperations[0]));
  });

  test("persists the complete qualifying chain, deduplicated member notifications, and scoped metadata-only outbox", (t) => {
    const runtime = createRuntime(t);
    const durable = commitFinalization(runtime);

    assert.deepEqual(durable, {
      operation_id: IDS.operation,
      snapshot_id: IDS.finalSnapshot,
      snapshot_version: 2,
      league_id: IDS.league,
      season_id: IDS.season,
      season_version: 2,
      standings_rule_version: 1,
      result_set_hash: resultSetHash(),
      expected_matchup_count: 1,
      included_result_count: 1,
      participant_count: 2,
      finalized_at_ms: NOW_MS,
    });
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "superseded"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.finalSnapshot).status,
      "final"
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, result_type, result_id
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(IDS.idempotency),
      {
        status: "completed",
        result_type: "standings_finalization",
        result_id: IDS.finalization,
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
      2
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_rows
          WHERE standings_snapshot_id = ?
        `)
        .get(IDS.finalSnapshot).count,
      2
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_result_versions
          WHERE standings_snapshot_id = ?
        `)
        .get(IDS.finalSnapshot).count,
      1
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshot_team_identities
          WHERE standings_snapshot_id = ?
        `)
        .get(IDS.finalSnapshot).count,
      2
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT user_id
          FROM notifications
          WHERE event_type = 'standings_finalized'
          ORDER BY user_id
        `)
        .all()
        .map(({ user_id: userId }) => userId),
      [IDS.commissionerUser, IDS.memberUser]
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
    const outbox = runtime.database
      .prepare(`
        SELECT *
        FROM outbox_events
        WHERE id = ?
      `)
      .get(IDS.outbox);
    assert.deepEqual(JSON.parse(outbox.payload_json), {
      eventId: IDS.outbox,
      type: "standings.changed",
      leagueId: IDS.league,
      resourceId: IDS.season,
      version: 2,
      reasonCode: "standings_changed",
      occurredAt: NOW_MS,
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
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT audience_kind, team_id, user_id
          FROM outbox_event_audiences
          WHERE outbox_event_id = ?
        `)
        .all(IDS.outbox),
      [
        {
          audience_kind: "league",
          team_id: null,
          user_id: null,
        },
      ]
    );

    const replay =
      runtime.repository.writeFinalizedNotification({
        id: IDS.replayNotification,
        leagueId: IDS.league,
        seasonId: IDS.season,
        finalizationId: IDS.finalization,
        snapshotId: IDS.finalSnapshot,
        userId: IDS.memberUser,
        nowMs: NOW_MS,
      });
    assert.equal(replay.replayed, true);
    assert.equal(
      replay.notification.id,
      IDS.memberNotification
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM notifications
          WHERE event_type = 'standings_finalized'
        `)
        .get().count,
      2
    );
    assert.deepEqual(
      runtime.repository.findIdempotency({
        leagueId: IDS.league,
        actorUserId: IDS.commissionerUser,
        operation: STANDINGS_FINALIZATION_OPERATION,
        clientKey: "finalize-season",
      }),
      {
        id: IDS.idempotency,
        league_id: IDS.league,
        actor_user_id: IDS.commissionerUser,
        operation: STANDINGS_FINALIZATION_OPERATION,
        client_key: "finalize-season",
        request_hash: "a".repeat(64),
        status: "completed",
        result_type: "standings_finalization",
        result_id: IDS.finalization,
        created_at_ms: NOW_MS,
        completed_at_ms: NOW_MS,
        expires_at_ms: NOW_MS + 86_400_000,
      }
    );
  });

  test("leaves ordinary current history and idempotency unchanged when an outer transaction rolls back", (t) => {
    const runtime = createRuntime(t);

    assert.throws(
      () =>
        runtime.repositoryContext.transaction(() => {
          runtime.repository.insertStartedIdempotency({
            id: IDS.idempotency,
            leagueId: IDS.league,
            actorUserId: IDS.commissionerUser,
            operation: STANDINGS_FINALIZATION_OPERATION,
            clientKey: "rollback",
            requestHash: "b".repeat(64),
            createdAtMs: NOW_MS,
            expiresAtMs: NOW_MS + 1000,
          });
          runtime.repository
            .supersedeCurrentDerivedSnapshot({
              leagueId: IDS.league,
              seasonId: IDS.season,
              snapshotId: IDS.currentSnapshot,
            });
          runtime.repository.insertFinalSnapshot({
            id: IDS.finalSnapshot,
            leagueId: IDS.league,
            seasonId: IDS.season,
            snapshotVersion: 2,
            sourceResultVersion: 1,
            nowMs: NOW_MS,
          });
          throw new Error("late seam failure");
        }),
      (error) =>
        error?.cause?.message === "late seam failure"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.finalSnapshot).count,
      0
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM idempotency_requests
          WHERE id = ?
        `)
        .get(IDS.idempotency).count,
      0
    );

    assert.throws(
      () =>
        runtime.repository
          .supersedeCurrentDerivedSnapshot({
            leagueId: IDS.otherLeague,
            seasonId: IDS.season,
            snapshotId: IDS.currentSnapshot,
          }),
      { code: REPOSITORY_ERROR_CODES.versionConflict }
    );
    assert.equal(
      runtime.database
        .prepare(`
          SELECT status
          FROM standings_snapshots
          WHERE id = ?
        `)
        .get(IDS.currentSnapshot).status,
      "current"
    );
  });

  test("rejects malformed or over-broad write objects before mutation", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    assert.throws(
      () =>
        runtime.repository.insertFinalSnapshot({
          id: IDS.finalSnapshot,
          leagueId: IDS.league,
          seasonId: IDS.season,
          snapshotVersion: 2,
          sourceResultVersion: 1,
          nowMs: NOW_MS,
          status: "final",
        }),
      { code: REPOSITORY_ERROR_CODES.argumentInvalid }
    );
    assert.throws(
      () =>
        runtime.repository.insertStartedIdempotency({
          id: IDS.idempotency,
          leagueId: IDS.league,
          actorUserId: IDS.commissionerUser,
          operation: STANDINGS_FINALIZATION_OPERATION,
          clientKey: "invalid",
          requestHash: "A".repeat(64),
          createdAtMs: NOW_MS,
          expiresAtMs: NOW_MS + 1000,
        }),
      { code: REPOSITORY_ERROR_CODES.argumentInvalid }
    );
    assert.equal(
      runtime.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      before
    );
  });
});
