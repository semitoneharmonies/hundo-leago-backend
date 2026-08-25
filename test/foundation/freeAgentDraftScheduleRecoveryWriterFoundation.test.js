const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  buildFreeAgentDraftReadinessOccurrenceKey,
  createFreeAgentDraftClock,
  FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftReadinessAttemptEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  planExplicitMatchupSchedule,
} = require(
  "../../src/domain/matchups/matchupSchedulePolicy"
);
const {
  buildMatchupOccurrenceKey,
  parseQualifiedMatchupOccurrenceKey,
} = require(
  "../../src/domain/matchups/matchupJobPolicy"
);
const {
  createFreeAgentDraftScheduleRecoveryService,
} = require(
  "../../src/application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService"
);
const {
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require(
  "../../src/infrastructure/database/migrate"
);
const {
  REPOSITORY_ERROR_CODES,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRepositoryError"
);
const {
  createSqliteFreeAgentDraftScheduleRecoveryWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftScheduleRecoveryWriter"
);
const {
  createSqliteFreeAgentDraftRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository"
);
const {
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);
const {
  createSqliteCandidateCardOpeningWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardOpeningWriter"
);
const {
  createSqliteMatchupJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupJobRepository"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR = Object.freeze({
  nhlSeasonKey: "20262027",
  nhlRegularSeasonStartsAtMs: Date.parse(
    "2026-10-01T07:00:00.000Z"
  ),
  nhlRegularSeasonEndsAtMs: Date.parse(
    "2027-02-15T08:00:00.000Z"
  ),
  fantasyPlayoffsStartAtMs: Date.parse(
    "2027-01-18T08:00:00.000Z"
  ),
  fantasyPlayoffsEndAtMs: Date.parse(
    "2027-02-15T08:00:00.000Z"
  ),
  timeZone: "America/Vancouver",
  firstWeekStartsAtMs: Date.parse(
    "2026-12-21T08:00:00.000Z"
  ),
});
const SLOT_SPECS = Object.freeze([
  Object.freeze({
    slot: "statistics_refresh_start",
    jobType: "matchup:statistics_refresh",
    timeField: "startsAtMs",
  }),
  Object.freeze({
    slot: "baseline",
    jobType: "matchup:baseline",
    timeField: "baselineAtMs",
  }),
  Object.freeze({
    slot: "lock",
    jobType: "matchup:lock",
    timeField: "locksAtMs",
  }),
  Object.freeze({
    slot: "statistics_refresh_end",
    jobType: "matchup:statistics_refresh",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "finalize",
    jobType: "matchup:finalize",
    timeField: "endsAtMs",
  }),
  Object.freeze({
    slot: "rollover",
    jobType: "matchup:rollover",
    timeField: "rollsOverAtMs",
  }),
]);

function uuid(value, prefix = "10000000") {
  return (
    `${prefix}-0000-4000-8000-` +
    String(value).padStart(12, "0")
  );
}

function generatedUuid(value) {
  return uuid(value, "90000000");
}

function makeSecureRandom(start = 1) {
  let next = start;
  return Object.freeze({
    id() {
      const result = generatedUuid(next);
      next += 1;
      return result;
    },
  });
}

function explicitCalendar() {
  const {
    firstWeekStartsAtMs: unused,
    ...calendar
  } = CALENDAR;
  return calendar;
}

function makeContext({
  recoveryKind = "completion",
  recoveryAtMs = CALENDAR.firstWeekStartsAtMs + 1,
  teamCount = 4,
} = {}) {
  const leagueId = uuid(1);
  const seasonId = uuid(2);
  const fadId = uuid(3);
  const scheduleOperationId = uuid(4);
  const teamIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(100 + index)
  );
  const schedule = planExplicitMatchupSchedule({
    teamIds,
    ...explicitCalendar(),
    firstWeekStartsAtMs: CALENDAR.firstWeekStartsAtMs,
    nowMs: CALENDAR.firstWeekStartsAtMs - 1,
  });
  const jobs = [];
  const weeks = schedule.weeks.map(
    (plannedWeek, weekIndex) => {
      const weekId = uuid(1_000 + weekIndex);
      const week = {
        id: weekId,
        leagueId,
        seasonId,
        weekKey: plannedWeek.weekKey,
        sequence: plannedWeek.sequence,
        startsAtMs: plannedWeek.startsAtMs,
        baselineAtMs: plannedWeek.baselineAtMs,
        locksAtMs: plannedWeek.locksAtMs,
        endsAtMs: plannedWeek.endsAtMs,
        rollsOverAtMs: plannedWeek.rollsOverAtMs,
        status: "scheduled",
        version: 1,
        matchups: plannedWeek.pairs
          .map((pair, pairIndex) => ({
            id: uuid(
              2_000 + weekIndex * 10 + pairIndex
            ),
            leagueId,
            seasonId,
            weekId,
            homeTeamId: pair.homeTeamId,
            awayTeamId: pair.awayTeamId,
            status: "scheduled",
            version: 1,
          }))
          .reverse(),
        bye:
          plannedWeek.byeTeamId === null
            ? null
            : {
                id: uuid(3_000 + weekIndex),
                leagueId,
                seasonId,
                weekId,
                teamId: plannedWeek.byeTeamId,
              },
      };
      SLOT_SPECS.forEach(
        ({ jobType, timeField }, slotIndex) => {
          const scheduledForMs = week[timeField];
          const id = uuid(
            4_000 + weekIndex * 10 + slotIndex
          );
          jobs.push({
            id,
            leagueId,
            seasonId,
            weekId,
            jobType,
            occurrenceKey: buildMatchupOccurrenceKey({
              jobType,
              leagueId,
              seasonId,
              weekId,
              scheduleOperationId,
              scheduleVersion: 1,
              scheduledForMs,
            }),
            scheduledForMs,
            status: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            startedAtMs: null,
            completedAtMs: null,
            resultJson: null,
            lastErrorCode: null,
            createdAtMs:
              CALENDAR.nhlRegularSeasonStartsAtMs,
            updatedAtMs:
              CALENDAR.nhlRegularSeasonStartsAtMs,
            version: 1,
            nextAttemptAtMs: scheduledForMs,
            bindingId: uuid(
              5_000 + weekIndex * 10 + slotIndex
            ),
            bindingJobType: jobType,
            bindingScheduleOperationId:
              scheduleOperationId,
            bindingScheduleVersion: 1,
            bindingOwningMatchupWeekId: weekId,
            bindingOwningMatchupId: null,
            bindingCreatedAtMs:
              CALENDAR.nhlRegularSeasonStartsAtMs,
            bindingVersion: 1,
          });
        }
      );
      return week;
    }
  );
  return {
    leagueId,
    seasonId,
    fadId,
    recovery: {
      kind: recoveryKind,
      atMs: recoveryAtMs,
      frozenFadFirstMatchupStartsAtMs:
        recoveryKind === "completion"
          ? CALENDAR.firstWeekStartsAtMs
          : null,
    },
    calendar: explicitCalendar(),
    currentGeneration: {
      leagueId,
      seasonId,
      scheduleVersion: 1,
      scheduleOperationId,
      weekOneMatchupWeekId: weeks[0].id,
      weekOneStartsAtMs: weeks[0].startsAtMs,
      status: "current",
      supersededAtMs: null,
      version: 1,
    },
    weeks,
    jobs: jobs.reverse(),
    teamIds,
  };
}

function planRecovery(context) {
  const {
    teamIds: unused,
    ...serviceContext
  } = context;
  return createFreeAgentDraftScheduleRecoveryService({
    secureRandom: makeSecureRandom(),
  }).planRecovery(serviceContext);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-recovery-writer-")
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "fad-recovery-writer-foundation",
    now: () => 1_000,
  });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  return connection.database;
}

function seedSchedule(database, context) {
  database.prepare(`
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
      ?, 'Recovery League', 'recovery league',
      'active', 'America/Vancouver', NULL, NULL,
      1, 1, 1
    )
  `).run(context.leagueId);
  database.prepare(`
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
      version,
      free_agent_draft_completed_at_ms
    ) VALUES (
      ?, ?, '2026-27', ?, 'active', ?, ?, ?, ?,
      1, 1, 1, NULL
    )
  `).run(
    context.seasonId,
    context.leagueId,
    context.calendar.nhlSeasonKey,
    context.calendar.nhlRegularSeasonStartsAtMs,
    context.calendar.nhlRegularSeasonEndsAtMs,
    context.calendar.fantasyPlayoffsStartAtMs,
    context.calendar.fantasyPlayoffsEndAtMs
  );
  const insertTeam = database.prepare(`
    INSERT INTO teams (
      id,
      league_id,
      name,
      name_normalized,
      status,
      primary_colour,
      secondary_colour,
      tertiary_colour,
      pattern_template,
      logo_reference,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @name,
      @nameNormalized,
      'active',
      '#102030',
      '#f0a020',
      NULL,
      'even-two',
      NULL,
      1,
      1,
      1
    )
  `);
  context.teamIds.forEach((id, index) => {
    insertTeam.run({
      id,
      leagueId: context.leagueId,
      name: `Recovery Team ${index + 1}`,
      nameNormalized: `recovery team ${index + 1}`,
    });
  });
  database.prepare(`
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
      ?, ?, ?, NULL, NULL, NULL,
      'schedule_generate', 'succeeded', NULL, NULL, ?, ?
    )
  `).run(
    context.currentGeneration.scheduleOperationId,
    context.leagueId,
    context.seasonId,
    CALENDAR.nhlRegularSeasonStartsAtMs,
    CALENDAR.nhlRegularSeasonStartsAtMs
  );
  const insertWeek = database.prepare(`
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
      @id, @leagueId, @seasonId, @weekKey, @sequence,
      @startsAtMs, @baselineAtMs, @locksAtMs,
      @endsAtMs, @rollsOverAtMs, 'scheduled',
      @createdAtMs, @createdAtMs, 1
    )
  `);
  const insertMatchup = database.prepare(`
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
      @id, @leagueId, @seasonId, @weekId,
      @homeTeamId, @awayTeamId, @homeTeamName,
      @awayTeamName, 'scheduled', @createdAtMs,
      @createdAtMs, 1
    )
  `);
  const insertBye = database.prepare(`
    INSERT INTO matchup_byes (
      id,
      league_id,
      season_id,
      matchup_week_id,
      team_id,
      team_display_name,
      created_at_ms
    ) VALUES (
      @id, @leagueId, @seasonId, @weekId,
      @teamId, @teamDisplayName, @createdAtMs
    )
  `);
  const teamNames = new Map(
    context.teamIds.map((id, index) => [
      id,
      `Recovery Team ${index + 1}`,
    ])
  );
  for (const week of context.weeks) {
    insertWeek.run({
      ...week,
      createdAtMs:
        CALENDAR.nhlRegularSeasonStartsAtMs,
    });
    for (const matchup of week.matchups) {
      insertMatchup.run({
        ...matchup,
        homeTeamName: teamNames.get(matchup.homeTeamId),
        awayTeamName: teamNames.get(matchup.awayTeamId),
        createdAtMs:
          CALENDAR.nhlRegularSeasonStartsAtMs,
      });
    }
    if (week.bye !== null) {
      insertBye.run({
        ...week.bye,
        teamDisplayName: teamNames.get(week.bye.teamId),
        createdAtMs:
          CALENDAR.nhlRegularSeasonStartsAtMs,
      });
    }
  }
  database.prepare(`
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
      ?, ?, 1, ?, ?, ?, 'current', ?, NULL, 1
    )
  `).run(
    context.leagueId,
    context.seasonId,
    context.currentGeneration.scheduleOperationId,
    context.currentGeneration.weekOneMatchupWeekId,
    context.currentGeneration.weekOneStartsAtMs,
    CALENDAR.nhlRegularSeasonStartsAtMs
  );
  const insertJob = database.prepare(`
    INSERT INTO job_runs (
      id,
      league_id,
      season_id,
      job_type,
      occurrence_key,
      scheduled_for_ms,
      status,
      attempt_count,
      lease_owner,
      lease_expires_at_ms,
      started_at_ms,
      completed_at_ms,
      result_json,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version,
      lease_token,
      next_attempt_at_ms
    ) VALUES (
      @id, @leagueId, @seasonId, @jobType,
      @occurrenceKey, @scheduledForMs, 'pending', 0,
      NULL, NULL, NULL, NULL, NULL, NULL,
      @createdAtMs, @updatedAtMs, 1, NULL,
      @nextAttemptAtMs
    )
  `);
  const insertBinding = database.prepare(`
    INSERT INTO matchup_schedule_job_bindings (
      id,
      league_id,
      season_id,
      job_run_id,
      job_type,
      schedule_operation_id,
      schedule_version,
      owning_matchup_week_id,
      owning_matchup_id,
      created_at_ms,
      version
    ) VALUES (
      @bindingId, @leagueId, @seasonId, @id,
      @jobType, @bindingScheduleOperationId,
      @bindingScheduleVersion,
      @bindingOwningMatchupWeekId, NULL,
      @bindingCreatedAtMs, 1
    )
  `);
  for (const job of context.jobs) {
    insertJob.run(job);
    insertBinding.run(job);
  }
}

function seedActualOpeningAuthorities(database, context) {
  database.prepare(`
    INSERT INTO league_settings (
      league_id, salary_cap_cents, trade_deadline_at_ms,
      maximum_teams, active_forward_slots,
      active_defence_slots, bench_slots,
      maximum_bench_aav_cents, injured_reserve_slots,
      prospect_slots_unlimited, scoring_rule_version,
      standings_rule_version, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      ?, 10000, NULL, 20, 12, 6, 4, 400,
      4, 1, 1, 1, 1, 1, 1
    )
  `).run(context.leagueId);
  const insertUser = database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (
      @id, @email, @email, @displayName,
      @displayNameNormalized, 'active', 1, 1, 1
    )
  `);
  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category,
      status, joined_at_ms, ended_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (
      @id, @leagueId, @userId, @permissionCategory,
      'active', 1, NULL, 1, 1, 1
    )
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id,
      status, assigned_at_ms, accepted_at_ms,
      ended_at_ms, version
    ) VALUES (
      @id, @leagueId, @teamId, @userId, @membershipId,
      @commissionerUserId, NULL, 'accepted', 1, 1,
      NULL, 1
    )
  `);
  const identities = context.teamIds.map(
    (teamId, index) => ({
      teamId,
      userId: uuid(70_000 + index, "30000000"),
      membershipId: uuid(
        71_000 + index,
        "30000000"
      ),
      assignmentId: uuid(
        72_000 + index,
        "30000000"
      ),
    })
  );
  const commissionerUserId = identities[0].userId;
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index];
    const email = `recovery-manager-${index + 1}@example.test`;
    const displayName = `Recovery Manager ${index + 1}`;
    insertUser.run({
      id: identity.userId,
      email,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
    });
    insertMembership.run({
      id: identity.membershipId,
      leagueId: context.leagueId,
      userId: identity.userId,
      permissionCategory:
        index === 0 ? "commissioner" : "manager",
    });
    insertAssignment.run({
      id: identity.assignmentId,
      leagueId: context.leagueId,
      teamId: identity.teamId,
      userId: identity.userId,
      membershipId: identity.membershipId,
      commissionerUserId,
    });
  }
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = 2,
        version = version + 1
    WHERE id = ?
  `).run(
    identities[0].membershipId,
    context.seasonId,
    context.leagueId
  );
  return identities;
}

function actualOpeningEvidence(context) {
  return {
    fadId: context.fadId,
    participants: context.teamIds.map(
      (teamId, index) => ({
        teamId,
        participantId: uuid(
          73_000 + index,
          "30000000"
        ),
        cardId: uuid(
          74_000 + index,
          "30000000"
        ),
        notificationId: uuid(
          75_000 + index,
          "30000000"
        ),
      })
    ),
    reminderJobRunId: uuid(76_000, "30000000"),
    deadlineJobRunId: uuid(76_001, "30000000"),
    rolloverIds: Array.from(
      { length: 7 },
      (_, index) =>
        uuid(77_000 + index, "30000000")
    ),
    rolloverJobRunIds: Array.from(
      { length: 7 },
      (_, index) =>
        uuid(78_000 + index, "30000000")
    ),
    activityId: uuid(79_000, "30000000"),
    outboxEventId: uuid(79_001, "30000000"),
    outboxAudienceId: uuid(79_002, "30000000"),
  };
}

function seedReadiness(database, context) {
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_draft_readiness_blockers_insert"
  );
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id,
      league_id,
      season_id,
      readiness_occurrence_key,
      trigger_kind,
      entry_draft_id,
      setup_exemption_id,
      job_run_id,
      status,
      attempt_count,
      lease_owner,
      lease_token,
      lease_expires_at_ms,
      blockers_json,
      matchup_schedule_version_before,
      matchup_schedule_version_after,
      schedule_recovery_id,
      created_fad_id,
      reminder_job_run_id,
      deadline_job_run_id,
      cards_opened_activity_id,
      cards_opened_outbox_event_id,
      started_at_ms,
      next_retry_at_ms,
      terminal_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      ?, ?, ?, 'test-readiness', 'no_draft_inaugural',
      NULL, NULL, NULL, 'running', 1,
      NULL, NULL, NULL, '[]', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL,
      ?, NULL, NULL, ?, ?, 1
    )
  `).run(
    uuid(6),
    context.leagueId,
    context.seasonId,
    context.recovery.atMs - 1,
    context.recovery.atMs - 2,
    context.recovery.atMs - 1
  );
}

function insertFad(database, context, plan, status) {
  const firstWeekId =
    status === "cards_open"
      ? plan.recovery.newFirstMatchupWeekId
      : plan.recovery.oldFirstMatchupWeekId;
  const firstWeekStartsAtMs =
    status === "cards_open"
      ? plan.recovery.newWeekOneStartsAtMs
      : plan.recovery.oldWeekOneStartsAtMs;
  const candidateDeadlineAtMs =
    firstWeekStartsAtMs -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  const openedAtMs =
    status === "cards_open"
      ? context.recovery.atMs
      : candidateDeadlineAtMs - 3 * DAY_MS;
  const helpOpensAtMs = Math.max(
    openedAtMs,
    candidateDeadlineAtMs - 2 * DAY_MS
  );
  database.prepare(`
    INSERT INTO free_agent_drafts (
      id,
      league_id,
      season_id,
      readiness_operation_id,
      readiness_occurrence_key,
      first_matchup_week_id,
      current_competition_first_matchup_week_id,
      schedule_recovery_id,
      participating_team_count,
      status,
      setup_path,
      entry_draft_id,
      setup_exemption_id,
      prior_season_rollover_id,
      no_draft_reason,
      opening_authority,
      opened_at_ms,
      help_opens_at_ms,
      candidate_deadline_at_ms,
      first_matchup_starts_at_ms,
      deadline_locked_at_ms,
      allocation_completed_at_ms,
      completed_at_ms,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @fadId, @leagueId, @seasonId, @readinessId,
      'test-readiness', @firstWeekId, @firstWeekId,
      NULL, @participantCount, @status,
      'no_draft_inaugural', NULL, NULL, NULL,
      'test fixture', 'system', @openedAtMs,
      @helpOpensAtMs, @candidateDeadlineAtMs,
      @firstWeekStartsAtMs, @deadlineLockedAtMs,
      @allocationCompletedAtMs, NULL, @openedAtMs,
      @updatedAtMs, 1
    )
  `).run({
    fadId: context.fadId,
    leagueId: context.leagueId,
    seasonId: context.seasonId,
    readinessId: uuid(6),
    firstWeekId,
    participantCount: context.teamIds.length,
    status,
    openedAtMs,
    helpOpensAtMs,
    candidateDeadlineAtMs,
    firstWeekStartsAtMs,
    deadlineLockedAtMs:
      status === "rapid"
        ? candidateDeadlineAtMs
        : null,
    allocationCompletedAtMs:
      status === "rapid"
        ? candidateDeadlineAtMs + 1
        : null,
    updatedAtMs:
      status === "rapid"
        ? candidateDeadlineAtMs + 1
        : openedAtMs,
  });
}

function fixture(t, options = {}) {
  const {
    preserveFadUpdateTriggers = false,
    ...contextOptions
  } = options;
  const database = createRuntime(t);
  const context = makeContext(contextOptions);
  const plan = planRecovery(context);
  assert.equal(plan.action, "stage_recovery");
  seedSchedule(database, context);
  seedReadiness(database, context);
  // Most writer cases isolate schedule CAS, evidence, and rollback seams;
  // constructing the full allocation/auction completion graph here would
  // duplicate the locked-decision migration and lifecycle repository suites.
  // The dedicated lifecycle composition cases in this suite keep the real
  // 0030 triggers and prove the writer's required ordering.
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_valid_insert"
  );
  if (!preserveFadUpdateTriggers) {
    for (const { name } of database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = 'free_agent_drafts'
        AND sql LIKE '%UPDATE%'
    `).all()) {
      database.exec(`DROP TRIGGER "${name}"`);
    }
  }
  if (context.recovery.kind === "completion") {
    insertFad(database, context, plan, "rapid");
  }
  return { database, context, plan };
}

function completeFad(database, plan) {
  const result = database.prepare(`
    UPDATE free_agent_drafts
    SET
      current_competition_first_matchup_week_id =
        @newFirstMatchupWeekId,
      schedule_recovery_id = @recoveryId,
      status = 'completed',
      completed_at_ms = @completedAtMs,
      updated_at_ms = @completedAtMs,
      version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND id = @fadId
      AND status = 'rapid'
      AND current_competition_first_matchup_week_id =
        @oldFirstMatchupWeekId
      AND version = 1
  `).run({
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    fadId: plan.scope.fadId,
    recoveryId: plan.recovery.id,
    oldFirstMatchupWeekId:
      plan.recovery.oldFirstMatchupWeekId,
    newFirstMatchupWeekId:
      plan.recovery.newFirstMatchupWeekId,
    completedAtMs: plan.recovery.completedAtMs,
  });
  assert.equal(result.changes, 1);
}

function seedLeasedFadCompletionJob(database, plan) {
  const completedAtMs = plan.recovery.completedAtMs;
  const candidateDeadlineAtMs =
    plan.recovery.oldWeekOneStartsAtMs -
    FREE_AGENT_DRAFT_INITIAL_WINDOW_MS;
  const insertTerminalJob = database.prepare(`
    INSERT INTO job_runs (
      id,
      league_id,
      season_id,
      job_type,
      occurrence_key,
      scheduled_for_ms,
      status,
      attempt_count,
      lease_owner,
      lease_expires_at_ms,
      started_at_ms,
      completed_at_ms,
      result_json,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version,
      lease_token,
      next_attempt_at_ms
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @jobType,
      @occurrenceKey,
      @scheduledForMs,
      'succeeded',
      1,
      NULL,
      NULL,
      @scheduledForMs,
      @scheduledForMs,
      NULL,
      NULL,
      @scheduledForMs,
      @scheduledForMs,
      2,
      NULL,
      NULL
    )
  `);
  insertTerminalJob.run({
    id: uuid(70_001, "40000000"),
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    jobType: "fad_deadline",
    occurrenceKey:
      `fad:${plan.scope.fadId}:deadline:` +
      candidateDeadlineAtMs,
    scheduledForMs: candidateDeadlineAtMs,
  });

  // The FAD update barriers remain live. These already-terminal prerequisite
  // rows are fixture state, so only the rollover insert-path trigger is
  // bypassed; its update and immutability triggers remain installed.
  database.exec(
    "DROP TRIGGER IF EXISTS free_agent_draft_rollovers_valid_insert"
  );
  const insertRollover = database.prepare(`
    INSERT INTO free_agent_draft_rollovers (
      id,
      league_id,
      season_id,
      fad_id,
      sequence,
      window_kind,
      predecessor_rollover_id,
      extension_reason,
      extension_source_id,
      opens_at_ms,
      creation_cutoff_at_ms,
      rolls_over_at_ms,
      status,
      processing_job_run_id,
      processing_started_at_ms,
      completed_at_ms,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      @fadId,
      @sequence,
      'initial',
      @predecessorRolloverId,
      NULL,
      NULL,
      @opensAtMs,
      @creationCutoffAtMs,
      @rollsOverAtMs,
      'completed',
      @processingJobRunId,
      @rollsOverAtMs,
      @rollsOverAtMs,
      NULL,
      @opensAtMs,
      @rollsOverAtMs,
      3
    )
  `);
  let predecessorRolloverId = null;
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rolloverId = uuid(
      70_100 + sequence,
      "40000000"
    );
    const rolloverJobId = uuid(
      70_010 + sequence,
      "40000000"
    );
    const opensAtMs =
      candidateDeadlineAtMs + (sequence - 1) * DAY_MS;
    const rollsOverAtMs = opensAtMs + DAY_MS;
    insertTerminalJob.run({
      id: rolloverJobId,
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      jobType: "fad_rollover",
      occurrenceKey:
        `fad:${plan.scope.fadId}:rollover:` +
        `${sequence}:${rollsOverAtMs}`,
      scheduledForMs: rollsOverAtMs,
    });
    insertRollover.run({
      id: rolloverId,
      leagueId: plan.scope.leagueId,
      seasonId: plan.scope.seasonId,
      fadId: plan.scope.fadId,
      sequence,
      predecessorRolloverId,
      opensAtMs,
      creationCutoffAtMs:
        rollsOverAtMs - 60 * 60 * 1000,
      rollsOverAtMs,
      processingJobRunId: rolloverJobId,
    });
    predecessorRolloverId = rolloverId;
  }

  const job = Object.freeze({
    id: uuid(70_000, "40000000"),
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    occurrenceKey: `fad:${plan.scope.fadId}:complete`,
    scheduledForMs: completedAtMs - 1,
    leaseOwner: "fad-completion-worker",
    leaseToken: "fad-completion-token",
    leaseExpiresAtMs: completedAtMs + 60_000,
  });
  database.prepare(`
    INSERT INTO job_runs (
      id,
      league_id,
      season_id,
      job_type,
      occurrence_key,
      scheduled_for_ms,
      status,
      attempt_count,
      lease_owner,
      lease_expires_at_ms,
      started_at_ms,
      completed_at_ms,
      result_json,
      last_error_code,
      created_at_ms,
      updated_at_ms,
      version,
      lease_token,
      next_attempt_at_ms
    ) VALUES (
      @id,
      @leagueId,
      @seasonId,
      'fad_completion',
      @occurrenceKey,
      @scheduledForMs,
      'leased',
      1,
      @leaseOwner,
      @leaseExpiresAtMs,
      @scheduledForMs,
      NULL,
      NULL,
      NULL,
      @scheduledForMs,
      @scheduledForMs,
      1,
      @leaseToken,
      NULL
    )
  `).run(job);
  return job;
}

function advanceScheduleGeneration(database, plan, atMs) {
  const operationId = uuid(71_000, "40000000");
  const superseded = database.prepare(`
    UPDATE season_matchup_schedule_generations
    SET
      status = 'superseded',
      superseded_at_ms = @atMs,
      version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND schedule_operation_id =
        @scheduleOperationId
      AND schedule_version = @scheduleVersion
      AND status = 'current'
      AND superseded_at_ms IS NULL
      AND version = 1
  `).run({
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    scheduleOperationId:
      plan.generation.replacement.scheduleOperationId,
    scheduleVersion:
      plan.generation.replacement.scheduleVersion,
    atMs,
  });
  assert.equal(superseded.changes, 1);
  database.prepare(`
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
      @operationId,
      @leagueId,
      @seasonId,
      NULL,
      NULL,
      NULL,
      'schedule_generate',
      'succeeded',
      'Later valid schedule generation',
      NULL,
      @atMs,
      @atMs
    )
  `).run({
    operationId,
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    atMs,
  });
  database.prepare(`
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
      @leagueId,
      @seasonId,
      @scheduleVersion,
      @operationId,
      @weekOneMatchupWeekId,
      @weekOneStartsAtMs,
      'current',
      @atMs,
      NULL,
      1
    )
  `).run({
    leagueId: plan.scope.leagueId,
    seasonId: plan.scope.seasonId,
    scheduleVersion:
      plan.generation.replacement.scheduleVersion + 1,
    operationId,
    weekOneMatchupWeekId:
      plan.recovery.newFirstMatchupWeekId,
    weekOneStartsAtMs:
      plan.recovery.newWeekOneStartsAtMs,
    atMs,
  });
  return operationId;
}

function snapshot(database, context) {
  return {
    weeks: database.prepare(`
      SELECT id, sequence, week_key, version
      FROM matchup_weeks
      WHERE league_id = ? AND season_id = ?
      ORDER BY sequence
    `).all(context.leagueId, context.seasonId),
    generation: database.prepare(`
      SELECT schedule_version, status, version
      FROM season_matchup_schedule_generations
      WHERE league_id = ? AND season_id = ?
      ORDER BY schedule_version
    `).all(context.leagueId, context.seasonId),
    jobStatuses: database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM job_runs
      WHERE league_id = ? AND season_id = ?
      GROUP BY status
      ORDER BY status
    `).all(context.leagueId, context.seasonId),
    recoveryCount: database.prepare(`
      SELECT COUNT(*) AS count
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = ?
    `).get(context.leagueId).count,
    recoveryChildCount: database.prepare(`
      SELECT
        (SELECT COUNT(*)
         FROM free_agent_draft_schedule_recovery_weeks
         WHERE league_id = @leagueId) +
        (SELECT COUNT(*)
         FROM free_agent_draft_schedule_recovery_matchups
         WHERE league_id = @leagueId) +
        (SELECT COUNT(*)
         FROM free_agent_draft_schedule_recovery_jobs
         WHERE league_id = @leagueId) AS count
    `).get({ leagueId: context.leagueId }).count,
  };
}

function assertRepositoryError(callback, code, reasonCode) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error.details?.reasonCode, reasonCode);
    }
    return true;
  });
}

describe(
  "FAD schedule-recovery SQLite writer",
  () => {
    test("requires an outer transaction and never owns one", (t) => {
      const { database, plan } = fixture(t);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });

      assertRepositoryError(
        () => writer.applyAndSeal({ plan }),
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "OUTER_TRANSACTION_REQUIRED"
      );
      assert.equal(database.inTransaction, false);
    });

    test("composes pre-open stage and seal through the real 0030 FAD and readiness triggers", (t) => {
      const database = createRuntime(t);
      const context = makeContext({
        recoveryKind: "pre_open",
        recoveryAtMs:
          CALENDAR.firstWeekStartsAtMs -
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
        teamCount: 4,
      });
      const plan = planRecovery(context);
      assert.equal(plan.action, "stage_recovery");
      seedSchedule(database, context);
      const managerIdentities =
        seedActualOpeningAuthorities(database, context);
      const requiredTriggerCount = database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'trigger'
          AND name IN (
            'free_agent_drafts_valid_insert',
            'free_agent_drafts_forward_update',
            'free_agent_draft_readiness_operations_forward_update'
          )
      `).get().count;
      assert.equal(requiredTriggerCount, 3);

      const recoveryWriter =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const repository =
        createSqliteFreeAgentDraftRepository({
          database,
          scheduleRecoveryWriter: recoveryWriter,
          candidateCardWriter:
            createSqliteCandidateCardOpeningWriter({
              database,
            }),
        });
      const readinessOperationId = uuid(
        80_000,
        "30000000"
      );
      const readinessJobRunId = uuid(
        80_001,
        "30000000"
      );
      const readinessAttemptId = uuid(
        80_002,
        "30000000"
      );
      const openedAtMs = context.recovery.atMs;
      const scheduledForMs = openedAtMs - 1;
      const leaseOwner = "fad-readiness-recovery-proof";
      const leaseToken =
        "fad-readiness-recovery-proof-token";
      const leaseExpiresAtMs = openedAtMs + DAY_MS;
      const occurrenceKey =
        buildFreeAgentDraftReadinessOccurrenceKey({
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          triggerResourceId: context.seasonId,
        });
      const readiness =
        repository.ensureReadinessOperation({
          operationId: readinessOperationId,
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          triggerKind: "no_draft_inaugural",
          triggerResourceId: context.seasonId,
          entryDraftId: null,
          setupExemptionId: null,
          jobRunId: readinessJobRunId,
          createdAtMs: scheduledForMs,
        }).readiness;
      assert.equal(readiness.version, 1);
      const claimed =
        createSqliteFreeAgentDraftJobRepository({
          database,
        }).claim({
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          fadId: null,
          runId: readinessJobRunId,
          jobType: "fad_readiness",
          occurrenceKey,
          scheduledForMs,
          expectedVersion: 1,
          leaseOwner,
          leaseToken,
          nowMs: openedAtMs,
          leaseExpiresAtMs,
        });
      assert.equal(claimed.acquired, true);
      const readinessExecution =
        claimed.occurrence.binding.readinessExecution;
      assert.equal(
        readinessExecution.operationId,
        readinessOperationId
      );
      assert.equal(readinessExecution.status, "running");
      assert.equal(
        claimed.occurrence.version,
        readinessExecution.version
      );
      assert.equal(
        claimed.occurrence.attemptCount,
        readinessExecution.attemptCount
      );

      const evidence = actualOpeningEvidence(context);
      const targetSchedule = plan.generation.replacement;
      const clock = createFreeAgentDraftClock({
        cardsOpenedAtMs: openedAtMs,
        firstMatchupStartsAtMs:
          targetSchedule.weekOneStartsAtMs,
      });
      const observedSeasonVersion = database.prepare(`
        SELECT version
        FROM seasons
        WHERE league_id = ? AND id = ?
      `).get(
        context.leagueId,
        context.seasonId
      ).version;
      const teamProjections = managerIdentities
        .map((identity, index) => ({
          carryoverCount: 0,
          managerAssignmentId: identity.assignmentId,
          managerReady: true,
          openBenchSlots: 4,
          openDefenceSlots: 6,
          openForwardSlots: 12,
          structuralConflictCount: 0,
          team: {
            logoReference: null,
            name: `Recovery Team ${index + 1}`,
            patternTemplate: "even-two",
            primaryColour: "#102030",
            secondaryColour: "#f0a020",
            teamId: identity.teamId,
            tertiaryColour: null,
          },
          teamId: identity.teamId,
        }))
        .sort((left, right) =>
          left.teamId < right.teamId
            ? -1
            : left.teamId > right.teamId
              ? 1
              : 0
        );
      const canonicalAttempt =
        createFreeAgentDraftReadinessAttemptEvidence({
          id: readinessAttemptId,
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          readinessOperationId,
          jobRunId: readinessJobRunId,
          attemptNumber:
            readinessExecution.attemptCount,
          observedReadinessVersion:
            readinessExecution.version,
          outcome: "succeeded",
          observedAtMs: openedAtMs,
          recordedAtMs: openedAtMs,
          projection: {
            blockers: [],
            candidateDeadlineAtMs:
              clock.candidateDeadlineAtMs,
            firstMatchupWeekAfter: {
              sequence: 1,
              startsAtMs:
                targetSchedule.weekOneStartsAtMs,
              version: targetSchedule.scheduleVersion,
              weekId:
                targetSchedule.weekOneMatchupWeekId,
            },
            firstMatchupWeekBefore: {
              sequence: 1,
              startsAtMs:
                context.currentGeneration
                  .weekOneStartsAtMs,
              version:
                context.currentGeneration.scheduleVersion,
              weekId:
                context.currentGeneration
                  .weekOneMatchupWeekId,
            },
            helpOpensAtMs: clock.helpOpensAtMs,
            initialRollovers:
              clock.initialRollovers.map(
                ({
                  creationCutoffAtMs,
                  opensAtMs,
                  rollsOverAtMs,
                  sequence,
                }) => ({
                  creationCutoffAtMs,
                  opensAtMs,
                  rollsOverAtMs,
                  sequence,
                })
              ),
            observedSeasonVersion,
            participatingTeamCount:
              context.teamIds.length,
            priorSeasonRollover: null,
            reminderAtMs: clock.reminderAtMs,
            teamProjections,
            warnings: [
              {
                code: "FAD_WEEK_ONE_MOVED",
                message:
                  "Week 1 must move to preserve the complete FAD period.",
                resourceId:
                  context.currentGeneration
                    .weekOneMatchupWeekId,
              },
            ],
          },
        });
      const attempt = Object.freeze({
        id: canonicalAttempt.id,
        leagueId: canonicalAttempt.leagueId,
        seasonId: canonicalAttempt.seasonId,
        readinessOperationId:
          canonicalAttempt.readinessOperationId,
        jobRunId: canonicalAttempt.jobRunId,
        attemptNumber: canonicalAttempt.attemptNumber,
        observedReadinessVersion:
          canonicalAttempt.observedReadinessVersion,
        outcome: canonicalAttempt.outcome,
        observedAtMs: canonicalAttempt.observedAtMs,
        recordedAtMs: canonicalAttempt.recordedAtMs,
        projection: canonicalAttempt.projection,
      });
      const currentInspection =
        inspectFreeAgentDraftOpeningReadiness({
          context:
            createSqliteFreeAgentDraftReadRepository({
              database,
            }).readOpeningPreflightContext({
              leagueId: context.leagueId,
              seasonId: context.seasonId,
            }),
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          occurrenceKey,
          observedAtMs: openedAtMs,
        });
      const currentFinalized =
        finalizeFreeAgentDraftOpeningReadiness({
          inspection: currentInspection,
          openedAtMs,
          targetSchedule: {
            operationId:
              targetSchedule.scheduleOperationId,
            version: targetSchedule.scheduleVersion,
            weekOneMatchupWeekId:
              targetSchedule.weekOneMatchupWeekId,
            weekOneStartsAtMs:
              targetSchedule.weekOneStartsAtMs,
          },
        });
      assert.deepEqual(
        currentFinalized.attemptProjection,
        attempt.projection
      );
      assert.notEqual(currentFinalized.opening, null);

      const opened = repository.commitOpening({
        leagueId: context.leagueId,
        seasonId: context.seasonId,
        occurrenceKey,
        readinessOperationId,
        expectedReadinessVersion:
          readinessExecution.version,
        openedAtMs,
        setupPath: "no_draft_inaugural",
        entryDraftId: null,
        setupExemptionId: null,
        priorSeasonRolloverId: null,
        noDraftReason: "Inaugural league season.",
        schedule: {
          operationId:
            context.currentGeneration
              .scheduleOperationId,
          version:
            context.currentGeneration.scheduleVersion,
          weekOneMatchupWeekId:
            context.currentGeneration
              .weekOneMatchupWeekId,
          weekOneStartsAtMs:
            context.currentGeneration.weekOneStartsAtMs,
        },
        scheduleRecoveryPlan: plan,
        carryoverProjection:
          currentFinalized.opening
            .carryoverProjection,
        evidence,
        jobExecution: {
          runId: readinessJobRunId,
          leaseOwner,
          leaseToken,
          leaseExpiresAtMs,
          expectedVersion: claimed.occurrence.version,
        },
        attempt,
      });

      assert.equal(opened.replayed, false);
      assert.equal(opened.draft.status, "cards_open");
      assert.equal(
        opened.draft.firstMatchupWeekId,
        plan.recovery.newFirstMatchupWeekId
      );
      assert.equal(
        opened.readiness.scheduleRecoveryId,
        plan.recovery.id
      );
      assert.equal(
        opened.readiness.matchupScheduleVersionBefore,
        plan.recovery.oldScheduleVersion
      );
      assert.equal(
        opened.readiness.matchupScheduleVersionAfter,
        plan.recovery.newScheduleVersion
      );
      assert.equal(opened.cards.length, context.teamIds.length);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_schedule_recoveries
          WHERE id = ? AND recovery_kind = 'pre_open'
        `).get(plan.recovery.id).count,
        1
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.deepEqual(database.pragma("integrity_check"), [
        { integrity_check: "ok" },
      ]);
    });

    test("atomically completes one-week recovery with stable retained IDs, cancelled and replaced jobs, and exact evidence", (t) => {
      const { database, context, plan } = fixture(t);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const transaction = database.transaction(() => {
        const result = writer.applyAndSeal({ plan });
        assert.equal(database.inTransaction, true);
        completeFad(database, plan);
        return result;
      });

      const result = transaction.immediate();
      assert.equal(result.sealed, true);
      assert.equal(result.replayed, false);
      assert.equal(
        result.evidenceSha256,
        plan.recovery.evidenceSha256
      );
      assert.deepEqual(
        database.prepare(`
          SELECT id, sequence, week_key, version
          FROM matchup_weeks
          WHERE league_id = ? AND season_id = ?
          ORDER BY sequence
        `).all(context.leagueId, context.seasonId),
        plan.mappedWeeks.map((week) => ({
          id: week.id,
          sequence: week.sequence,
          week_key: week.weekKey,
          version: week.version,
        }))
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_schedule_recovery_jobs
          WHERE schedule_recovery_id = ?
            AND disposition = 'cancelled'
        `).get(plan.recovery.id).count,
        6
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_schedule_recovery_jobs
          WHERE schedule_recovery_id = ?
            AND disposition = 'replaced'
        `).get(plan.recovery.id).count,
        plan.mappedWeeks.length * 6
      );

      const sameTimeReplacement = database.prepare(`
        SELECT
          old_job.scheduled_for_ms AS old_time,
          replacement_job.scheduled_for_ms AS new_time,
          effect.replaced_occurrence_key AS old_key,
          effect.replacement_occurrence_key AS new_key
        FROM free_agent_draft_schedule_recovery_jobs AS effect
        JOIN job_runs AS old_job
          ON old_job.id = effect.replaced_job_run_id
        JOIN job_runs AS replacement_job
          ON replacement_job.id = effect.replacement_job_run_id
        WHERE effect.schedule_recovery_id = ?
          AND effect.disposition = 'replaced'
        ORDER BY effect.replaced_job_run_id
        LIMIT 1
      `).get(plan.recovery.id);
      assert.equal(
        sameTimeReplacement.old_time,
        sameTimeReplacement.new_time
      );
      assert.notEqual(
        sameTimeReplacement.old_key,
        sameTimeReplacement.new_key
      );
      const parsed = parseQualifiedMatchupOccurrenceKey({
        jobType: plan.replacementJobs[0].jobType,
        leagueId: context.leagueId,
        seasonId: context.seasonId,
        occurrenceKey:
          plan.replacementJobs[0].occurrenceKey,
        scheduledForMs:
          plan.replacementJobs[0].scheduledForMs,
      });
      assert.equal(
        parsed.scheduleOperationId,
        plan.operation.id
      );
      assert.equal(parsed.scheduleVersion, 2);
      const beforeReplay = snapshot(database, context);
      const replay = database.transaction(() =>
        writer.applyAndSeal({ plan })
      ).immediate();
      assert.equal(replay.replayed, true);
      assert.deepEqual(snapshot(database, context), beforeReplay);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.deepEqual(database.pragma("integrity_check"), [
        { integrity_check: "ok" },
      ]);
    });

    test("stages a multi-Monday odd-team pre-open recovery before FAD creation and seals it afterward", (t) => {
      const { database, context, plan } = fixture(t, {
        recoveryKind: "pre_open",
        recoveryAtMs: CALENDAR.firstWeekStartsAtMs,
        teamCount: 5,
      });
      assert.equal(plan.recovery.removedWeekCount, 2);
      assert.equal(plan.removals.byes.length, 2);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const transaction = database.transaction(() => {
        const staged = writer.stage({ plan });
        assert.equal(staged.sealed, false);
        insertFad(database, context, plan, "cards_open");
        return writer.seal({ plan });
      });

      const sealed = transaction.immediate();
      assert.equal(sealed.sealed, true);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM matchup_byes
          WHERE league_id = ? AND season_id = ?
        `).get(context.leagueId, context.seasonId).count,
        plan.mappedWeeks.length
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    });

    test("fails the outer commit when completion leaves the FAD pointing at deleted Week 1 and rolls everything back", (t) => {
      const { database, context, plan } = fixture(t);
      const before = snapshot(database, context);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const transaction = database.transaction(() =>
        writer.applyAndSeal({ plan })
      );

      assert.throws(
        () => transaction.immediate(),
        /FOREIGN KEY constraint failed/
      );
      assert.deepEqual(snapshot(database, context), before);
      assert.equal(database.inTransaction, false);
    });

    test("rejects stale generation plans and leased or attempted old jobs without partial recovery", (t) => {
      {
        const { database, context, plan } = fixture(t);
        const before = snapshot(database, context);
        const stale = jsonClone(plan);
        stale.generation.expectedCurrent.version = 2;
        stale.generation.superseded.version = 3;
        const writer =
          createSqliteFreeAgentDraftScheduleRecoveryWriter({
            database,
          });
        const transaction = database.transaction(() =>
          writer.applyAndSeal({ plan: stale })
        );
        assertRepositoryError(
          () => transaction.immediate(),
          REPOSITORY_ERROR_CODES.versionConflict,
          "RECOVERY_GENERATION_CHANGED"
        );
        assert.deepEqual(snapshot(database, context), before);
      }

      {
        const { database, context, plan } = fixture(t);
        const oldJob = plan.oldJobCas[0];
        database.prepare(`
          UPDATE job_runs
          SET
            status = 'leased',
            attempt_count = 1,
            lease_owner = 'race-worker',
            lease_token = 'race-token',
            lease_expires_at_ms = ?,
            started_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
          WHERE id = ?
        `).run(
          plan.recovery.completedAtMs + 10_000,
          plan.recovery.completedAtMs,
          plan.recovery.completedAtMs,
          oldJob.jobRunId
        );
        const before = snapshot(database, context);
        const writer =
          createSqliteFreeAgentDraftScheduleRecoveryWriter({
            database,
          });
        const transaction = database.transaction(() =>
          writer.applyAndSeal({ plan })
        );
        assertRepositoryError(
          () => transaction.immediate(),
          REPOSITORY_ERROR_CODES.versionConflict,
          "RECOVERY_JOB_CAS_FAILED"
        );
        assert.deepEqual(snapshot(database, context), before);
      }

      {
        const { database, context, plan } = fixture(t);
        const oldJob = plan.oldJobCas[1];
        database.prepare(`
          UPDATE job_runs
          SET
            attempt_count = 1,
            updated_at_ms = ?,
            version = version + 1
          WHERE id = ?
        `).run(
          plan.recovery.completedAtMs,
          oldJob.jobRunId
        );
        const before = snapshot(database, context);
        const writer =
          createSqliteFreeAgentDraftScheduleRecoveryWriter({
            database,
          });
        const transaction = database.transaction(() =>
          writer.applyAndSeal({ plan })
        );
        assertRepositoryError(
          () => transaction.immediate(),
          REPOSITORY_ERROR_CODES.versionConflict,
          "RECOVERY_JOB_CAS_FAILED"
        );
        assert.deepEqual(snapshot(database, context), before);
      }
    });

    test("composes real completion triggers with claim-race convergence and sealed replay after live progression", (t) => {
      const { database, context, plan } = fixture(t, {
        preserveFadUpdateTriggers: true,
      });
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name IN (
              'free_agent_drafts_forward_update',
              'free_agent_drafts_final_completion_barrier',
              'free_agent_drafts_resolution_job_completion_barrier',
              'free_agent_drafts_sync_season_completion'
            )
        `).get().count,
        4
      );
      seedLeasedFadCompletionJob(database, plan);
      const due = context.jobs.find(
        (job) =>
          job.weekId === context.weeks[0].id &&
          job.scheduledForMs <=
          plan.recovery.completedAtMs
      );
      assert.ok(due);
      assert.deepEqual(
        database.prepare(`
          SELECT
            job.status,
            job.attempt_count,
            job.lease_owner,
            job.lease_token,
            binding.schedule_operation_id,
            binding.schedule_version,
            generation.status AS generation_status
          FROM job_runs AS job
          JOIN matchup_schedule_job_bindings AS binding
            ON binding.league_id = job.league_id
           AND binding.job_run_id = job.id
          JOIN season_matchup_schedule_generations AS generation
            ON generation.league_id = binding.league_id
           AND generation.season_id = binding.season_id
           AND generation.schedule_operation_id =
              binding.schedule_operation_id
           AND generation.schedule_version =
              binding.schedule_version
          WHERE job.league_id = ? AND job.id = ?
        `).get(context.leagueId, due.id),
        {
          status: "pending",
          attempt_count: 0,
          lease_owner: null,
          lease_token: null,
          schedule_operation_id:
            context.currentGeneration.scheduleOperationId,
          schedule_version: 1,
          generation_status: "current",
        }
      );
      const jobs = createSqliteMatchupJobRepository({
        database,
      });
      const claim = (job, nowMs, token) =>
        jobs.claim({
          leagueId: context.leagueId,
          seasonId: context.seasonId,
          jobType: job.jobType,
          occurrenceKey: job.occurrenceKey,
          nowMs,
          leaseOwner: "race-worker",
          leaseToken: token,
          leaseExpiresAtMs: nowMs + 10_000,
        });

      const claimBeforeCompletion = claim(
        due,
        plan.recovery.completedAtMs,
        "before-completion"
      );
      assert.equal(claimBeforeCompletion.acquired, false);
      assert.equal(
        claimBeforeCompletion.occurrence.status,
        "pending"
      );
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const completed = database.transaction(() => {
        assert.equal(database.inTransaction, true);
        const recovery = writer.applyAndSeal({ plan });
        completeFad(database, plan);
        assert.deepEqual(
          database.prepare(`
            SELECT
              fad.status,
              fad.completed_at_ms,
              fad.current_competition_first_matchup_week_id,
              season.free_agent_draft_completed_at_ms
            FROM free_agent_drafts AS fad
            JOIN seasons AS season
              ON season.league_id = fad.league_id
             AND season.id = fad.season_id
            WHERE fad.league_id = ? AND fad.id = ?
          `).get(context.leagueId, context.fadId),
          {
            status: "completed",
            completed_at_ms: plan.recovery.completedAtMs,
            current_competition_first_matchup_week_id:
              plan.recovery.newFirstMatchupWeekId,
            free_agent_draft_completed_at_ms:
              plan.recovery.completedAtMs,
          }
        );
        return recovery;
      }).immediate();
      assert.equal(completed.replayed, false);

      const staleClaimAfterCompletion = claim(
        due,
        plan.recovery.completedAtMs,
        "after-completion"
      );
      assert.equal(staleClaimAfterCompletion.acquired, false);
      assert.equal(
        staleClaimAfterCompletion.occurrence.status,
        "skipped"
      );
      assert.equal(
        database.prepare(
          "SELECT status FROM job_runs WHERE id = ?"
        ).get(due.id).status,
        "skipped"
      );

      const replacement = [...plan.replacementJobs].sort(
        (left, right) =>
          left.scheduledForMs - right.scheduledForMs ||
          left.id.localeCompare(right.id)
      )[0];
      assert.deepEqual(
        database.prepare(`
          SELECT
            job.status,
            job.attempt_count,
            job.lease_owner,
            job.lease_token,
            binding.schedule_operation_id,
            binding.schedule_version,
            generation.status AS generation_status
          FROM job_runs AS job
          JOIN matchup_schedule_job_bindings AS binding
            ON binding.league_id = job.league_id
           AND binding.job_run_id = job.id
          JOIN season_matchup_schedule_generations AS generation
            ON generation.league_id = binding.league_id
           AND generation.season_id = binding.season_id
           AND generation.schedule_operation_id =
              binding.schedule_operation_id
           AND generation.schedule_version =
              binding.schedule_version
          WHERE job.league_id = ? AND job.id = ?
        `).get(context.leagueId, replacement.id),
        {
          status: "pending",
          attempt_count: 0,
          lease_owner: null,
          lease_token: null,
          schedule_operation_id: plan.operation.id,
          schedule_version: 2,
          generation_status: "current",
        }
      );
      const acquired = claim(
        replacement,
        replacement.scheduledForMs,
        "replacement-execution"
      );
      assert.equal(acquired.acquired, true);
      const succeeded = jobs.succeed({
        leagueId: context.leagueId,
        runId: replacement.id,
        leaseOwner: "race-worker",
        leaseToken: "replacement-execution",
        expectedVersion: acquired.occurrence.version,
        completedAtMs: replacement.scheduledForMs + 1,
        result: { recoveredGenerationExecuted: true },
      });
      assert.equal(succeeded.status, "succeeded");

      const afterExecution = snapshot(database, context);
      const replayAfterExecution = database.transaction(() =>
        writer.applyAndSeal({ plan })
      ).immediate();
      assert.equal(replayAfterExecution.replayed, true);
      assert.equal(
        replayAfterExecution.evidenceSha256,
        plan.recovery.evidenceSha256
      );
      assert.deepEqual(
        snapshot(database, context),
        afterExecution
      );

      database.transaction(() =>
        advanceScheduleGeneration(
          database,
          plan,
          replacement.scheduledForMs + 2
        )
      ).immediate();
      const afterLaterGeneration = snapshot(
        database,
        context
      );
      const replayAfterLaterGeneration =
        database.transaction(() =>
          writer.applyAndSeal({ plan })
        ).immediate();
      assert.equal(
        replayAfterLaterGeneration.replayed,
        true
      );
      assert.equal(
        replayAfterLaterGeneration.evidenceSha256,
        plan.recovery.evidenceSha256
      );
      assert.deepEqual(
        snapshot(database, context),
        afterLaterGeneration
      );

      const changedChildIdentity = jsonClone(plan);
      changedChildIdentity.recoveryChildren.jobs[0].id =
        uuid(79_999, "40000000");
      assertRepositoryError(
        () =>
          database.transaction(() =>
            writer.applyAndSeal({
              plan: changedChildIdentity,
            })
          ).immediate(),
        REPOSITORY_ERROR_CODES.versionConflict,
        "RECOVERY_SEAL_REPLAY_MISMATCH"
      );

      const changedEvidence = jsonClone(plan);
      changedEvidence.recovery.evidenceSha256 =
        "0".repeat(64);
      changedEvidence.evidence.evidenceSha256 =
        "0".repeat(64);
      assertRepositoryError(
        () =>
          database.transaction(() =>
            writer.applyAndSeal({
              plan: changedEvidence,
            })
          ).immediate(),
        REPOSITORY_ERROR_CODES.versionConflict,
        "RECOVERY_SEAL_REPLAY_MISMATCH"
      );
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.deepEqual(database.pragma("integrity_check"), [
        { integrity_check: "ok" },
      ]);
    });

    test("rejects a forged digest from actual staged children and rolls the outer transaction back", (t) => {
      const { database, context, plan } = fixture(t, {
        recoveryKind: "pre_open",
        recoveryAtMs:
          CALENDAR.firstWeekStartsAtMs -
          FREE_AGENT_DRAFT_INITIAL_WINDOW_MS,
      });
      const forged = jsonClone(plan);
      forged.recovery.evidenceSha256 = "0".repeat(64);
      forged.evidence.evidenceSha256 = "0".repeat(64);
      const before = snapshot(database, context);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const transaction = database.transaction(() => {
        writer.stage({ plan: forged });
        insertFad(database, context, forged, "cards_open");
        writer.seal({ plan: forged });
      });

      assertRepositoryError(
        () => transaction.immediate(),
        REPOSITORY_ERROR_CODES.versionConflict,
        "RECOVERY_EVIDENCE_DIGEST_MISMATCH"
      );
      assert.deepEqual(snapshot(database, context), before);
    });

    test("rejects self-consistent forged child identities and starts even when the real evidence policy recomputes their digest", (t) => {
      const { database, context, plan } = fixture(t, {
        recoveryKind: "pre_open",
        recoveryAtMs: CALENDAR.firstWeekStartsAtMs,
        teamCount: 4,
      });
      assert.equal(plan.removals.weeks.length, 2);
      const forged = jsonClone(plan);
      const originalSecondWeekId =
        forged.recoveryChildren.weeks[1]
          .removedMatchupWeekId;
      const forgedSecondWeekId = uuid(
        990_001,
        "20000000"
      );
      forged.recoveryChildren.weeks[1]
        .removedMatchupWeekId = forgedSecondWeekId;
      forged.recoveryChildren.weeks[1]
        .removedStartsAtMs += 1;
      let forgedMatchupIndex = 0;
      for (const child of
        forged.recoveryChildren.matchups) {
        if (
          child.removedMatchupWeekId ===
          originalSecondWeekId
        ) {
          child.removedMatchupWeekId =
            forgedSecondWeekId;
          child.removedMatchupId = uuid(
            990_100 + forgedMatchupIndex,
            "20000000"
          );
          forgedMatchupIndex += 1;
        }
      }
      assert.ok(forgedMatchupIndex > 0);
      const evidenceInput = {
        ...forged.evidence.input,
        removedWeeks:
          forged.recoveryChildren.weeks.map(
            (child) => ({
              matchupWeekId:
                child.removedMatchupWeekId,
              sequence: child.removedSequence,
              startsAtMs: child.removedStartsAtMs,
            })
          ),
        removedMatchups:
          forged.recoveryChildren.matchups.map(
            (child) => ({
              matchupId: child.removedMatchupId,
              matchupWeekId:
                child.removedMatchupWeekId,
            })
          ),
      };
      const sealed =
        createFreeAgentDraftScheduleRecoveryEvidence(
          evidenceInput
        );
      forged.evidence.input = evidenceInput;
      forged.evidence.preimage = jsonClone(
        sealed.preimage
      );
      forged.evidence.evidenceSha256 =
        sealed.evidenceSha256;
      forged.recovery.evidenceSha256 =
        sealed.evidenceSha256;
      const before = snapshot(database, context);
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
        });
      const transaction = database.transaction(() =>
        writer.stage({ plan: forged })
      );

      assertRepositoryError(
        () => transaction.immediate(),
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "RECOVERY_REMOVED_WEEK_EVIDENCE_MISMATCH"
      );
      assert.deepEqual(snapshot(database, context), before);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM free_agent_draft_schedule_recovery_weeks
          WHERE league_id = ?
        `).get(context.leagueId).count,
        0
      );
    });

    test("rolls back every writer seam and seals immutable child evidence only on success", (t) => {
      const { database, context, plan } = fixture(t);
      const before = snapshot(database, context);
      let failAt = null;
      const writer =
        createSqliteFreeAgentDraftScheduleRecoveryWriter({
          database,
          afterStep(step) {
            if (step === failAt) {
              throw new Error(`injected-${step}`);
            }
          },
        });
      const seams = [
        "after_season_cas",
        "after_removed_evidence_staged",
        "after_old_jobs_skipped",
        "after_schedule_replaced",
        "after_old_generation_superseded",
        "after_new_generation",
        "after_replacement_jobs",
        "after_job_evidence_staged",
        "before_recovery_seal",
        "after_recovery_seal",
      ];
      for (const seam of seams) {
        failAt = seam;
        const transaction = database.transaction(() =>
          writer.applyAndSeal({ plan })
        );
        assertRepositoryError(
          () => transaction.immediate(),
          REPOSITORY_ERROR_CODES.operationFailed
        );
        assert.deepEqual(snapshot(database, context), before);
      }

      failAt = null;
      database.transaction(() => {
        writer.applyAndSeal({ plan });
        completeFad(database, plan);
      }).immediate();
      const childId =
        plan.recoveryChildren.weeks[0].id;
      assert.throws(
        () =>
          database.prepare(`
            UPDATE free_agent_draft_schedule_recovery_weeks
            SET removed_sequence = removed_sequence
            WHERE id = ?
          `).run(childId),
        /immutable/
      );
      assert.throws(
        () =>
          database.prepare(`
            DELETE FROM free_agent_draft_schedule_recovery_weeks
            WHERE id = ?
          `).run(childId),
        /immutable/
      );
    });
  }
);
