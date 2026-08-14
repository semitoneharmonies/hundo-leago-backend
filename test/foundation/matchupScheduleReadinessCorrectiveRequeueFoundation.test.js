const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createFreeAgentDraftReadinessMissingScheduleBlocker,
  createFreeAgentDraftReadinessRetryRequest,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require(
  "../../src/domain/leagues/socketInvalidation"
);
const {
  createMatchupScheduleService,
} = require(
  "../../src/application/services/matchups/createMatchupScheduleService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteMatchupScheduleRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupScheduleRepository"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);

const NOW_MS = Date.parse("2026-07-22T08:00:00.000Z");
const NHL_OPENING_MS = Date.parse("2026-10-06T07:00:00.000Z");
const FIRST_WEEK_MS = Date.parse("2026-10-12T07:00:00.000Z");
const SECOND_WEEK_MS = Date.parse("2026-10-19T07:00:00.000Z");
const PLAYOFFS_MS = Date.parse("2027-03-15T07:00:00.000Z");
const SEASON_END_MS = Date.parse("2027-04-12T07:00:00.000Z");
const READINESS_CREATED_AT_MS = NOW_MS - 10_000;
const READINESS_STARTED_AT_MS = NOW_MS - 9_000;
const READINESS_OBSERVED_AT_MS = NOW_MS - 8_500;
const READINESS_BLOCKED_AT_MS = NOW_MS - 8_000;
const READINESS_NEXT_RETRY_AT_MS = NOW_MS + 60_000;
const COMMISSIONER_RETRY_AT_MS = NOW_MS - 4_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  commissioner: uuid(3),
  commissionerMembership: uuid(4),
  readiness: uuid(5),
  readinessJob: uuid(6),
  readinessAttempt: uuid(7),
  retryIdempotency: uuid(8),
  retryReceipt: uuid(9),
  nonInauguralResource: uuid(10),
  teams: Object.freeze([uuid(20), uuid(21), uuid(22), uuid(23)]),
});

const READINESS_OCCURRENCE_KEY =
  `fad-readiness:${IDS.league}:${IDS.season}:${IDS.season}`;
const MISSING_SCHEDULE_BLOCKER =
  createFreeAgentDraftReadinessMissingScheduleBlocker({
    seasonId: IDS.season,
  });
const OTHER_BLOCKER = Object.freeze({
  code: "TEAM_MANAGER_MISSING",
  field: null,
  message: "Every participating team requires one accepted manager.",
  resourceId: IDS.teams[0],
  resourceType: "team",
});

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function insertOpeningPublication(
  database,
  {
    id,
    eventType,
    aggregateType,
    aggregateId,
    version,
    reasonCode,
    related,
    audienceKind,
    teamId = null,
    userId = null,
    payloadJson = null,
  }
) {
  insert(database, "outbox_events", {
    id,
    league_id: IDS.league,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    payload_json:
      payloadJson ||
      JSON.stringify(
        createSocketEventEnvelope({
          eventId: id,
          type: eventType,
          leagueId: IDS.league,
          resourceId: aggregateId,
          version,
          reasonCode,
          occurredAt: READINESS_BLOCKED_AT_MS,
          related,
        })
      ),
    status: "pending",
    attempt_count: 0,
    available_at_ms: READINESS_BLOCKED_AT_MS,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: READINESS_BLOCKED_AT_MS,
    updated_at_ms: READINESS_BLOCKED_AT_MS,
    version: 1,
  });
  insert(database, "outbox_event_audiences", {
    id,
    league_id: IDS.league,
    outbox_event_id: id,
    audience_kind: audienceKind,
    team_id: teamId,
    user_id: userId,
    created_at_ms: READINESS_BLOCKED_AT_MS,
  });
}

function trackedIdFactory(start = 1_000) {
  let next = start;
  const generated = [];
  return Object.freeze({
    generated,
    id() {
      const id = uuid(next);
      next += 1;
      generated.push(id);
      return id;
    },
  });
}

function insertUser(repositories, id, displayName) {
  const normalized = displayName.toLowerCase();
  repositories.users.insert({
    id,
    email_normalized: `${normalized}@example.test`,
    email_display: `${normalized}@example.test`,
    display_name: displayName,
    display_name_normalized: normalized,
    status: "active",
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
  });
}

function seedLeague(repositories) {
  insertUser(
    repositories,
    IDS.commissioner,
    "Corrective Commissioner"
  );
  repositories.leagues.insert({
    id: IDS.league,
    name: "Corrective Schedule League",
    name_normalized: "corrective schedule league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: IDS.league,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
  });
  repositories.seasons.insert({
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  repositories.league_memberships.insert({
    id: IDS.commissionerMembership,
    league_id: IDS.league,
    user_id: IDS.commissioner,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: READINESS_CREATED_AT_MS,
    ended_at_ms: null,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        IDS.commissionerMembership,
      current_season_id: IDS.season,
      updated_at_ms: READINESS_CREATED_AT_MS + 1,
    },
  });
  for (const [index, teamId] of IDS.teams.entries()) {
    const name = `Corrective Team ${index + 1}`;
    repositories.teams.insert({
      id: teamId,
      league_id: IDS.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: "#112233",
      secondary_colour: "#ddeeff",
      logo_reference: null,
      created_at_ms: READINESS_CREATED_AT_MS,
      updated_at_ms: READINESS_CREATED_AT_MS,
      version: 1,
    });
  }
}

function blockerList(value) {
  return Array.isArray(value) ? value : [value];
}

function canonicalReadinessBlockers(blockers) {
  return serializeCanonicalJsonV1(
    blockerList(blockers)
  );
}

function publicBlocker(blocker) {
  return Object.freeze({
    code: blocker.code,
    message: blocker.message,
    resourceId: blocker.resourceId,
  });
}

function blockedAttemptProjection(blockers) {
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: null,
    firstMatchupWeekAfter: null,
    candidateDeadlineAtMs: null,
    reminderAtMs: null,
    helpOpensAtMs: null,
    initialRollovers: [],
    priorSeasonRollover: null,
    participatingTeamCount: 0,
    teamProjections: [],
    blockers: blockerList(blockers).map(publicBlocker),
    warnings: [],
  };
}

function succeededAttemptProjection() {
  return {
    observedSeasonVersion: 1,
    firstMatchupWeekBefore: null,
    firstMatchupWeekAfter: null,
    candidateDeadlineAtMs: null,
    reminderAtMs: null,
    helpOpensAtMs: null,
    initialRollovers: [],
    priorSeasonRollover: null,
    participatingTeamCount: 0,
    teamProjections: [],
    blockers: [],
    warnings: [],
  };
}

function readinessRow(overrides = {}) {
  return {
    id: IDS.readiness,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_occurrence_key: READINESS_OCCURRENCE_KEY,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: IDS.readinessJob,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: null,
    reminder_job_run_id: null,
    deadline_job_run_id: null,
    cards_opened_activity_id: null,
    cards_opened_outbox_event_id: null,
    started_at_ms: null,
    next_retry_at_ms: null,
    terminal_at_ms: null,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function readinessJobRow(overrides = {}) {
  return {
    id: IDS.readinessJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "fad_readiness",
    occurrence_key: READINESS_OCCURRENCE_KEY,
    scheduled_for_ms: READINESS_CREATED_AT_MS,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    next_attempt_at_ms: null,
    created_at_ms: READINESS_CREATED_AT_MS,
    updated_at_ms: READINESS_CREATED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function seedPendingReadiness(database, options = {}) {
  insert(
    database,
    "job_runs",
    readinessJobRow(options.jobOverrides)
  );
  insert(
    database,
    "free_agent_draft_readiness_operations",
    readinessRow(options.readinessOverrides)
  );
}

function startReadiness(database) {
  assert.equal(
    database
      .prepare(`
        UPDATE job_runs
        SET status = 'running',
            attempt_count = 1,
            lease_owner = 'corrective-readiness-worker',
            lease_token = 'corrective-readiness-lease',
            lease_expires_at_ms = @leaseExpiresAtMs,
            started_at_ms = @startedAtMs,
            next_attempt_at_ms = NULL,
            updated_at_ms = @startedAtMs,
            version = 2
        WHERE league_id = @leagueId AND id = @jobRunId
      `)
      .run({
        jobRunId: IDS.readinessJob,
        leagueId: IDS.league,
        leaseExpiresAtMs: NOW_MS + 60_000,
        startedAtMs: READINESS_STARTED_AT_MS,
      }).changes,
    1
  );
  assert.equal(
    database
      .prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'running',
            attempt_count = 1,
            lease_owner = 'corrective-readiness-worker',
            lease_token = 'corrective-readiness-lease',
            lease_expires_at_ms = @leaseExpiresAtMs,
            started_at_ms = @startedAtMs,
            updated_at_ms = @startedAtMs,
            version = 2
        WHERE league_id = @leagueId
          AND id = @readinessOperationId
      `)
      .run({
        leagueId: IDS.league,
        leaseExpiresAtMs: NOW_MS + 60_000,
        readinessOperationId: IDS.readiness,
        startedAtMs: READINESS_STARTED_AT_MS,
      }).changes,
    1
  );
}

function blockReadiness(
  database,
  blockers = MISSING_SCHEDULE_BLOCKER
) {
  const projection = blockedAttemptProjection(blockers);
  insert(database, "free_agent_draft_readiness_attempts", {
    id: IDS.readinessAttempt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    job_run_id: IDS.readinessJob,
    attempt_number: 1,
    observed_readiness_version: 2,
    outcome: "blocked",
    observed_at_ms: READINESS_OBSERVED_AT_MS,
    recorded_at_ms: READINESS_BLOCKED_AT_MS,
    projection_json: serializeCanonicalJsonV1(projection),
    projection_sha256: hashCanonicalJsonV1(projection),
    version: 1,
  });
  assert.equal(
    database
      .prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'blocked',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            blockers_json = @blockersJson,
            next_retry_at_ms = @nextRetryAtMs,
            terminal_at_ms = @blockedAtMs,
            updated_at_ms = @blockedAtMs,
            version = 3
        WHERE league_id = @leagueId
          AND id = @readinessOperationId
      `)
      .run({
        blockedAtMs: READINESS_BLOCKED_AT_MS,
        blockersJson: canonicalReadinessBlockers(blockers),
        leagueId: IDS.league,
        nextRetryAtMs: READINESS_NEXT_RETRY_AT_MS,
        readinessOperationId: IDS.readiness,
      }).changes,
    1
  );
  assert.equal(
    database
      .prepare(`
        UPDATE job_runs
        SET status = 'failed',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            completed_at_ms = @blockedAtMs,
            last_error_code = 'FAD_READINESS_BLOCKED',
            next_attempt_at_ms = @nextRetryAtMs,
            updated_at_ms = @blockedAtMs,
            version = 3
        WHERE league_id = @leagueId AND id = @jobRunId
      `)
      .run({
        blockedAtMs: READINESS_BLOCKED_AT_MS,
        jobRunId: IDS.readinessJob,
        leagueId: IDS.league,
        nextRetryAtMs: READINESS_NEXT_RETRY_AT_MS,
      }).changes,
    1
  );
}

function seedBlockedReadiness(
  database,
  blockers = MISSING_SCHEDULE_BLOCKER
) {
  seedPendingReadiness(database);
  startReadiness(database);
  blockReadiness(database, blockers);
}

function requeueThroughT128(database) {
  const retry = createFreeAgentDraftReadinessRetryRequest({
    actorUserId: IDS.commissioner,
    leagueId: IDS.league,
    expectedVersion: 3,
    clientKey: "corrective-foundation-t128",
    body: {
      confirmation: "RETRY FREE AGENT DRAFT READINESS",
      readinessOperationId: IDS.readiness,
      seasonId: IDS.season,
    },
  });
  insert(database, "idempotency_requests", {
    id: IDS.retryIdempotency,
    league_id: IDS.league,
    actor_user_id: IDS.commissioner,
    operation: "free_agent_draft.readiness.retry.v1",
    client_key: "corrective-foundation-t128",
    request_hash: retry.requestSha256,
    status: "started",
    result_type: null,
    result_id: null,
    created_at_ms: COMMISSIONER_RETRY_AT_MS,
    completed_at_ms: null,
    expires_at_ms: NOW_MS + 86_400_000,
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(
      database
        .prepare(`
          UPDATE job_runs
          SET status = 'pending',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at_ms = NULL,
              started_at_ms = NULL,
              completed_at_ms = NULL,
              result_json = NULL,
              last_error_code = NULL,
              next_attempt_at_ms = @acceptedAtMs,
              updated_at_ms = @acceptedAtMs,
              version = 4
          WHERE league_id = @leagueId AND id = @jobRunId
        `)
        .run({
          acceptedAtMs: COMMISSIONER_RETRY_AT_MS,
          jobRunId: IDS.readinessJob,
          leagueId: IDS.league,
        }).changes,
      1
    );
    const response = {
      acceptedAtMs: COMMISSIONER_RETRY_AT_MS,
      acceptedFromVersion: 3,
      jobRunId: IDS.readinessJob,
      leagueId: IDS.league,
      occurrenceKey: READINESS_OCCURRENCE_KEY,
      readinessOperationId: IDS.readiness,
      resultingReadinessVersion: 4,
      retryAttemptNumber: 2,
      retryReceiptId: IDS.retryReceipt,
      seasonId: IDS.season,
      status: "accepted",
    };
    insert(database, "free_agent_draft_readiness_retry_receipts", {
      id: IDS.retryReceipt,
      league_id: IDS.league,
      season_id: IDS.season,
      readiness_operation_id: IDS.readiness,
      idempotency_request_id: IDS.retryIdempotency,
      actor_user_id: IDS.commissioner,
      actor_membership_id: IDS.commissionerMembership,
      actor_authority: "commissioner",
      request_sha256: retry.requestSha256,
      accepted_from_version: 3,
      resulting_readiness_version: 4,
      retry_attempt_number: 2,
      job_run_id: IDS.readinessJob,
      occurrence_key: READINESS_OCCURRENCE_KEY,
      accepted_at_ms: COMMISSIONER_RETRY_AT_MS,
      response_http_status: 202,
      response_json: serializeCanonicalJsonV1(response),
      response_sha256: hashCanonicalJsonV1(response),
      version: 1,
    });
    assert.equal(
      database
        .prepare(`
          UPDATE free_agent_draft_readiness_operations
          SET next_retry_at_ms = @acceptedAtMs,
              updated_at_ms = @acceptedAtMs,
              version = 4
          WHERE league_id = @leagueId
            AND id = @readinessOperationId
        `)
        .run({
          acceptedAtMs: COMMISSIONER_RETRY_AT_MS,
          leagueId: IDS.league,
          readinessOperationId: IDS.readiness,
        }).changes,
      1
    );
    assert.equal(
      database
        .prepare(`
          UPDATE idempotency_requests
          SET status = 'completed',
              result_type =
                'free_agent_draft_readiness_retry_receipt',
              result_id = @retryReceiptId,
              completed_at_ms = @acceptedAtMs
          WHERE league_id = @leagueId
            AND id = @idempotencyRequestId
        `)
        .run({
          acceptedAtMs: COMMISSIONER_RETRY_AT_MS,
          idempotencyRequestId: IDS.retryIdempotency,
          leagueId: IDS.league,
          retryReceiptId: IDS.retryReceipt,
        }).changes,
      1
    );
    database.exec("COMMIT");
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function seedPostT128Readiness(database) {
  seedBlockedReadiness(database);
  requeueThroughT128(database);
}

function seedNonInauguralReadiness(database) {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    const occurrenceKey =
      `fad-readiness:${IDS.league}:${IDS.season}:` +
      IDS.nonInauguralResource;
    seedPendingReadiness(database, {
      jobOverrides: { occurrence_key: occurrenceKey },
      readinessOverrides: {
        readiness_occurrence_key: occurrenceKey,
        trigger_kind: "entry_draft_completed",
        entry_draft_id: IDS.nonInauguralResource,
      },
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function seedSucceededReadiness(
  database,
  { rootEvidence = "canonical" } = {}
) {
  seedPendingReadiness(database);
  startReadiness(database);
  const projection = succeededAttemptProjection();
  insert(database, "free_agent_draft_readiness_attempts", {
    id: IDS.readinessAttempt,
    league_id: IDS.league,
    season_id: IDS.season,
    readiness_operation_id: IDS.readiness,
    job_run_id: IDS.readinessJob,
    attempt_number: 1,
    observed_readiness_version: 2,
    outcome: "succeeded",
    observed_at_ms: READINESS_OBSERVED_AT_MS,
    recorded_at_ms: READINESS_BLOCKED_AT_MS,
    projection_json: serializeCanonicalJsonV1(projection),
    projection_sha256: hashCanonicalJsonV1(projection),
    version: 1,
  });
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(
      "DROP TRIGGER free_agent_draft_readiness_operations_forward_update"
    );
    database.exec(
      "DROP TRIGGER free_agent_drafts_valid_insert"
    );
    const activityId = uuid(71);
    const fadId = uuid(72);
    const deadlineJobRunId = uuid(73);
    const outboxEventId = uuid(74);
    const reminderJobRunId = uuid(75);
    const firstWeekId = uuid(76);
    const activityOutboxEventId = uuid(77);
    const fadTeamIds = IDS.teams.map((_, index) =>
      uuid(80 + index)
    );
    const cardIds = IDS.teams.map((_, index) =>
      uuid(90 + index)
    );
    const notificationIds = IDS.teams.map((_, index) =>
      uuid(100 + index)
    );
    const assignmentIds = IDS.teams.map((_, index) =>
      uuid(110 + index)
    );
    const cardOutboxEventIds = IDS.teams.map((_, index) =>
      uuid(120 + index)
    );
    const notificationOutboxEventIds = IDS.teams.map(
      (_, index) => uuid(130 + index)
    );
    const candidateDeadlineAtMs =
      FIRST_WEEK_MS - 604_800_000;
    insert(database, "job_runs", {
      ...readinessJobRow({
        id: reminderJobRunId,
        job_type: "fad_deadline_reminder",
        occurrence_key:
          `fad:${fadId}:reminder:` +
          (candidateDeadlineAtMs - 259_200_000),
        scheduled_for_ms:
          candidateDeadlineAtMs - 259_200_000,
        next_attempt_at_ms:
          candidateDeadlineAtMs - 259_200_000,
      }),
    });
    insert(database, "job_runs", {
      ...readinessJobRow({
        id: deadlineJobRunId,
        job_type: "fad_deadline",
        occurrence_key:
          `fad:${fadId}:deadline:${candidateDeadlineAtMs}`,
        scheduled_for_ms: candidateDeadlineAtMs,
        next_attempt_at_ms: candidateDeadlineAtMs,
      }),
    });
    insert(database, "league_activity", {
      id: activityId,
      league_id: IDS.league,
      season_id: IDS.season,
      event_type: "free_agent_draft_started",
      actor_user_id: null,
      actor_authority: "system",
      team_id: null,
      player_id: null,
      related_type: "free_agent_draft",
      related_id: fadId,
      display_summary: "Free Agent Draft started.",
      reason: null,
      metadata_json: "{}",
      occurred_at_ms: READINESS_BLOCKED_AT_MS,
    });
    insert(database, "free_agent_drafts", {
      id: fadId,
      league_id: IDS.league,
      season_id: IDS.season,
      readiness_operation_id: IDS.readiness,
      readiness_occurrence_key: READINESS_OCCURRENCE_KEY,
      first_matchup_week_id: firstWeekId,
      current_competition_first_matchup_week_id: firstWeekId,
      schedule_recovery_id: null,
      participating_team_count: IDS.teams.length,
      status: "cards_open",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason: "Inaugural league season.",
      opening_authority: "system",
      opened_at_ms: READINESS_BLOCKED_AT_MS,
      help_opens_at_ms:
        candidateDeadlineAtMs - 172_800_000,
      candidate_deadline_at_ms: candidateDeadlineAtMs,
      first_matchup_starts_at_ms: FIRST_WEEK_MS,
      deadline_locked_at_ms: null,
      allocation_completed_at_ms: null,
      completed_at_ms: null,
      created_at_ms: READINESS_BLOCKED_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 1,
    });
    for (const [index, teamId] of IDS.teams.entries()) {
      insert(database, "team_manager_assignments", {
        id: assignmentIds[index],
        league_id: IDS.league,
        team_id: teamId,
        user_id: IDS.commissioner,
        membership_id: IDS.commissionerMembership,
        assigned_by_user_id: IDS.commissioner,
        replaces_assignment_id: null,
        status: "accepted",
        assigned_at_ms: READINESS_BLOCKED_AT_MS,
        accepted_at_ms: READINESS_BLOCKED_AT_MS,
        ended_at_ms: null,
        version: 1,
      });
      insert(database, "free_agent_draft_teams", {
        id: fadTeamIds[index],
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: fadId,
        team_id: teamId,
        team_status_at_setup: "active",
        created_at_ms: READINESS_BLOCKED_AT_MS,
      });
      insert(database, "candidate_cards", {
        id: cardIds[index],
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: fadId,
        team_id: teamId,
        status: "open",
        completeness_code: "incomplete",
        filled_mandatory_count: 0,
        missing_mandatory_count: 18,
        filled_bench_count: 0,
        empty_bench_count: 4,
        blocking_validation_count: 0,
        structural_conflict_count: 0,
        maximum_possible_cap_cents: 0,
        locked_at_ms: null,
        created_at_ms: READINESS_BLOCKED_AT_MS,
        updated_at_ms: READINESS_BLOCKED_AT_MS,
        version: 1,
      });
      insert(database, "notifications", {
        id: notificationIds[index],
        user_id: IDS.commissioner,
        league_id: IDS.league,
        event_type: "fad_cards_opened",
        message_data_json: JSON.stringify({
          leagueId: IDS.league,
          seasonId: IDS.season,
          fadId,
          teamId,
          cardId: cardIds[index],
          candidateDeadlineAtMs,
          destination: {
            kind: "private_card",
            leagueId: IDS.league,
            fadId,
            teamId,
            cardId: cardIds[index],
          },
        }),
        related_feature: "free_agent_draft",
        related_record_id: fadId,
        delivery_status: "pending",
        created_at_ms: READINESS_BLOCKED_AT_MS,
        read_at_ms: null,
        delivered_at_ms: null,
        version: 1,
        deduplication_key:
          `fad:${fadId}:cards-opened:${teamId}:` +
          IDS.commissioner,
      });
    }

    const rootRelated = createEmptySocketRelated({ fadId });
    let rootEventType = "free_agent_draft.changed";
    let rootPayloadJson = null;
    let rootAudienceKind = "league";
    let rootAudienceTeamId = null;
    if (rootEvidence === "legacy") {
      rootEventType = "fad_cards_opened";
      rootPayloadJson = "{}";
    } else if (rootEvidence === "malformed") {
      rootPayloadJson = JSON.stringify({
        ...createSocketEventEnvelope({
          eventId: outboxEventId,
          type: rootEventType,
          leagueId: IDS.league,
          resourceId: fadId,
          version: 1,
          reasonCode: "cards_opened",
          occurredAt: READINESS_BLOCKED_AT_MS,
          related: rootRelated,
        }),
        related: {
          ...rootRelated,
          teamId: IDS.teams[0],
        },
      });
    } else if (rootEvidence === "wrong_audience") {
      rootAudienceKind = "team";
      rootAudienceTeamId = IDS.teams[0];
    }
    insertOpeningPublication(database, {
      id: outboxEventId,
      eventType: rootEventType,
      aggregateType: "free_agent_draft",
      aggregateId: fadId,
      version: 1,
      reasonCode: "cards_opened",
      related: rootRelated,
      audienceKind: rootAudienceKind,
      teamId: rootAudienceTeamId,
      payloadJson: rootPayloadJson,
    });
    insertOpeningPublication(database, {
      id: activityOutboxEventId,
      eventType: "activity.created",
      aggregateType: "league_activity",
      aggregateId: activityId,
      version: 1,
      reasonCode: "cards_opened",
      related: rootRelated,
      audienceKind: "league",
    });
    for (const [index, teamId] of IDS.teams.entries()) {
      const related = createEmptySocketRelated({
        fadId,
        teamId,
        cardId: cardIds[index],
      });
      insertOpeningPublication(database, {
        id: cardOutboxEventIds[index],
        eventType: "candidate_card.changed",
        aggregateType: "candidate_card",
        aggregateId: cardIds[index],
        version: 1,
        reasonCode: "card_changed",
        related,
        audienceKind: "team",
        teamId,
      });
      insertOpeningPublication(database, {
        id: notificationOutboxEventIds[index],
        eventType: "notification.created",
        aggregateType: "notification",
        aggregateId: notificationIds[index],
        version: 1,
        reasonCode: "cards_opened",
        related,
        audienceKind: "user",
        userId: IDS.commissioner,
      });
    }
    database
      .prepare(`
        UPDATE job_runs
        SET status = 'succeeded',
            attempt_count = 1,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            started_at_ms = @startedAtMs,
            completed_at_ms = @completedAtMs,
            result_json = '{}',
            next_attempt_at_ms = NULL,
            updated_at_ms = @completedAtMs,
            version = 3
        WHERE league_id = @leagueId AND id = @jobRunId
      `)
      .run({
        completedAtMs: READINESS_BLOCKED_AT_MS,
        jobRunId: IDS.readinessJob,
        leagueId: IDS.league,
        startedAtMs: READINESS_STARTED_AT_MS,
      });
    database
      .prepare(`
        UPDATE free_agent_draft_readiness_operations
        SET status = 'succeeded',
            attempt_count = 1,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at_ms = NULL,
            started_at_ms = @startedAtMs,
            matchup_schedule_version_before = 1,
            matchup_schedule_version_after = 1,
            created_fad_id = @createdFadId,
            reminder_job_run_id = @reminderJobRunId,
            deadline_job_run_id = @deadlineJobRunId,
            cards_opened_activity_id = @activityId,
            cards_opened_outbox_event_id = @outboxEventId,
            terminal_at_ms = @completedAtMs,
            updated_at_ms = @completedAtMs,
            version = 3
        WHERE league_id = @leagueId
          AND id = @readinessOperationId
      `)
      .run({
        activityId,
        completedAtMs: READINESS_BLOCKED_AT_MS,
        createdFadId: fadId,
        deadlineJobRunId,
        leagueId: IDS.league,
        outboxEventId,
        readinessOperationId: IDS.readiness,
        reminderJobRunId,
        startedAtMs: READINESS_STARTED_AT_MS,
      });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function seedPendingFailedSplit(database) {
  seedPendingReadiness(database, {
    jobOverrides: {
      status: "failed",
      attempt_count: 1,
      started_at_ms: READINESS_STARTED_AT_MS,
      completed_at_ms: READINESS_BLOCKED_AT_MS,
      last_error_code: "FAD_READINESS_BLOCKED",
      next_attempt_at_ms: READINESS_NEXT_RETRY_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 3,
    },
  });
}

function seedBlockedWithoutAttempt(database) {
  const blockersJson = canonicalReadinessBlockers(
    MISSING_SCHEDULE_BLOCKER
  );
  seedPendingReadiness(database, {
    jobOverrides: {
      status: "failed",
      attempt_count: 1,
      started_at_ms: READINESS_STARTED_AT_MS,
      completed_at_ms: READINESS_BLOCKED_AT_MS,
      last_error_code: "FAD_READINESS_BLOCKED",
      next_attempt_at_ms: READINESS_NEXT_RETRY_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 3,
    },
    readinessOverrides: {
      status: "blocked",
      attempt_count: 1,
      blockers_json: blockersJson,
      started_at_ms: READINESS_STARTED_AT_MS,
      next_retry_at_ms: READINESS_NEXT_RETRY_AT_MS,
      terminal_at_ms: READINESS_BLOCKED_AT_MS,
      updated_at_ms: READINESS_BLOCKED_AT_MS,
      version: 3,
    },
  });
}

function seedOccurrenceSplit(database) {
  seedBlockedReadiness(database);
  assert.equal(
    database
      .prepare(`
        UPDATE job_runs
        SET occurrence_key = occurrence_key || ':split'
        WHERE league_id = ? AND id = ?
      `)
      .run(IDS.league, IDS.readinessJob).changes,
    1
  );
}

function authenticated() {
  return Object.freeze({
    actorUserId: IDS.commissioner,
    authority: "commissioner",
    authorized: true,
    leagueId: IDS.league,
    membershipId: IDS.commissionerMembership,
  });
}

function scheduleCommand({
  firstWeekStartsAtMs = FIRST_WEEK_MS,
  idempotencyKey = "corrective-t095-foundation",
} = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    input: {
      confirmed: true,
      nhlRegularSeasonStartsAtMs: NHL_OPENING_MS,
      nhlRegularSeasonEndsAtMs: SEASON_END_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
      fantasyPlayoffsEndAtMs: SEASON_END_MS,
      firstWeekStartsAtMs,
    },
    expectedSeasonVersion: 1,
    idempotencyKey,
    authenticated: authenticated(),
  };
}

function shiftCommand({ weekId }) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    weekId,
    input: {
      action: "shift_week_one",
      confirmation: "CHANGE WEEK 1 START",
      firstWeekStartsAtMs: FIRST_WEEK_MS,
    },
    expectedWeekVersion: 1,
    idempotencyKey: "corrective-t096-foundation",
    authenticated: authenticated(),
  };
}

function createRuntime(
  t,
  {
    beforeCommit,
    seedReadiness,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-t095-corrective-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "t095-corrective-foundation",
    now: () => NOW_MS,
  });
  assert.equal(
    connection.database
      .prepare(
        "SELECT MAX(migration_id) AS migrationId FROM schema_migrations"
      )
      .get().migrationId,
    50
  );
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  seedLeague(context.repositories);
  if (seedReadiness) {
    seedReadiness(connection.database);
  }
  const repository = createSqliteMatchupScheduleRepository({
    database: connection.database,
    beforeCommit,
  });
  const secureRandom = trackedIdFactory();
  const service = createMatchupScheduleService({
    repositoryContext: context,
    leagueAuthorization: Object.freeze({
      requireCommissioner(authenticatedValue, leagueId) {
        if (
          authenticatedValue?.authorized !== true ||
          authenticatedValue?.leagueId !== leagueId
        ) {
          const error = new Error(
            "Current league commissioner authority is required."
          );
          error.code = "LEAGUE_COMMISSIONER_REQUIRED";
          throw error;
        }
        return Object.freeze({
          actorUserId: authenticatedValue.actorUserId,
          authority: authenticatedValue.authority,
          leagueId,
          membershipId: authenticatedValue.membershipId,
        });
      },
    }),
    repository,
    clock: Object.freeze({
      nowMs() {
        return NOW_MS;
      },
    }),
    secureRandom,
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
  return Object.freeze({
    context,
    database: connection.database,
    repository,
    secureRandom,
    service,
  });
}

function readReadinessState(database) {
  return {
    operation: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readiness),
    job: database
      .prepare(`
        SELECT *
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.readinessJob),
    attempts: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
          AND readiness_operation_id = ?
        ORDER BY attempt_number
      `)
      .all(IDS.league, IDS.readiness),
    retryReceipts: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_retry_receipts
        WHERE league_id = ?
          AND readiness_operation_id = ?
        ORDER BY accepted_at_ms, id
      `)
      .all(IDS.league, IDS.readiness),
    corrections: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_readiness_corrective_requeues
        WHERE league_id = ?
        ORDER BY requeued_at_ms, id
      `)
      .all(IDS.league),
  };
}

function assertNoReadinessTriggerCreated(database) {
  assert.equal(
    database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND season_id = ?
      `)
      .get(IDS.league, IDS.season).count,
    0
  );
  assert.equal(
    database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM job_runs
        WHERE league_id = ?
          AND season_id = ?
          AND job_type = 'fad_readiness'
      `)
      .get(IDS.league, IDS.season).count,
    0
  );
}

function assertPublicScheduleResult(result, runtime) {
  assert.deepEqual(result, {
    operationId: runtime.secureRandom.generated[0],
    seasonId: IDS.season,
    seasonVersion: 2,
    nhlRegularSeasonStartsAtMs: NHL_OPENING_MS,
    nhlRegularSeasonEndsAtMs: SEASON_END_MS,
    fantasyPlayoffsStartAtMs: PLAYOFFS_MS,
    fantasyPlayoffsEndAtMs: SEASON_END_MS,
    calendarPersisted: true,
    firstWeekId: runtime.secureRandom.generated[3],
    firstWeekStartsAtMs: FIRST_WEEK_MS,
    participantCount: IDS.teams.length,
    weekCount: 22,
    matchupCount: 44,
    byeCount: 0,
    lastWeekEndsAtMs: PLAYOFFS_MS,
  });
  assert.equal(
    Object.hasOwn(result, "correctiveRequeueId"),
    false
  );
}

describe("T-095 FAD readiness corrective requeue composition", () => {
  test("atomically evidences and requeues the exact blocked inaugural pair without changing the public 201", (t) => {
    const observedSeams = [];
    const runtime = createRuntime(t, {
      seedReadiness: seedBlockedReadiness,
      beforeCommit(seam) {
        observedSeams.push(seam);
      },
    });
    const before = readReadinessState(runtime.database);
    const beforeAttempt = before.attempts[0];
    const result = runtime.service.generate(scheduleCommand());

    assertPublicScheduleResult(result, runtime);
    assert.deepEqual(observedSeams, [
      "after_season_cas",
      "after_schedule_children",
      "after_jobs_and_bindings",
      "after_command_result",
      "after_corrective_evidence",
      "after_job_reset",
      "after_readiness_advance",
      "after_idempotency_completion",
    ]);
    const after = readReadinessState(runtime.database);
    assert.deepEqual(after.attempts, [beforeAttempt]);
    assert.deepEqual(after.retryReceipts, []);
    assert.equal(after.corrections.length, 1);
    const commandResult = runtime.database
      .prepare(`
        SELECT id, matchup_operation_id,
               new_schedule_operation_id,
               new_schedule_version,
               response_http_status, response_code
        FROM matchup_schedule_command_results
        WHERE league_id = ? AND season_id = ?
      `)
      .get(IDS.league, IDS.season);
    const generation = runtime.database
      .prepare(`
        SELECT schedule_operation_id, schedule_version,
               status, created_at_ms, version
        FROM season_matchup_schedule_generations
        WHERE league_id = ? AND season_id = ?
      `)
      .get(IDS.league, IDS.season);
    assert.deepEqual(commandResult, {
      id: runtime.secureRandom.generated[2],
      matchup_operation_id: result.operationId,
      new_schedule_operation_id: result.operationId,
      new_schedule_version: 1,
      response_http_status: 201,
      response_code: "MATCHUP_SCHEDULE_GENERATED",
    });
    assert.deepEqual(generation, {
      schedule_operation_id: result.operationId,
      schedule_version: 1,
      status: "current",
      created_at_ms: NOW_MS,
      version: 1,
    });
    assert.deepEqual(after.corrections[0], {
      id: runtime.secureRandom.generated.at(-1),
      league_id: IDS.league,
      season_id: IDS.season,
      readiness_operation_id: IDS.readiness,
      readiness_attempt_id: IDS.readinessAttempt,
      job_run_id: IDS.readinessJob,
      occurrence_key: READINESS_OCCURRENCE_KEY,
      correction_kind: "matchup_schedule_created",
      matchup_schedule_command_result_id: commandResult.id,
      schedule_operation_id: result.operationId,
      schedule_version: 1,
      attempt_count: 1,
      readiness_version_before: 3,
      readiness_version_after: 4,
      job_version_before: 3,
      job_version_after: 4,
      blockers_json: canonicalReadinessBlockers(
        MISSING_SCHEDULE_BLOCKER
      ),
      blocked_at_ms: READINESS_BLOCKED_AT_MS,
      previous_next_retry_at_ms:
        READINESS_NEXT_RETRY_AT_MS,
      requeued_at_ms: NOW_MS,
      version: 1,
    });
    assert.deepEqual(
      {
        status: after.job.status,
        attemptCount: after.job.attempt_count,
        leaseOwner: after.job.lease_owner,
        leaseToken: after.job.lease_token,
        leaseExpiresAtMs: after.job.lease_expires_at_ms,
        startedAtMs: after.job.started_at_ms,
        completedAtMs: after.job.completed_at_ms,
        resultJson: after.job.result_json,
        lastErrorCode: after.job.last_error_code,
        nextAttemptAtMs: after.job.next_attempt_at_ms,
        createdAtMs: after.job.created_at_ms,
        updatedAtMs: after.job.updated_at_ms,
        version: after.job.version,
      },
      {
        status: "pending",
        attemptCount: 1,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        startedAtMs: null,
        completedAtMs: null,
        resultJson: null,
        lastErrorCode: null,
        nextAttemptAtMs: NOW_MS,
        createdAtMs: READINESS_CREATED_AT_MS,
        updatedAtMs: NOW_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      {
        status: after.operation.status,
        attemptCount: after.operation.attempt_count,
        blockersJson: after.operation.blockers_json,
        startedAtMs: after.operation.started_at_ms,
        nextRetryAtMs: after.operation.next_retry_at_ms,
        terminalAtMs: after.operation.terminal_at_ms,
        version: after.operation.version,
      },
      {
        status: "blocked",
        attemptCount: 1,
        blockersJson: before.operation.blockers_json,
        startedAtMs: READINESS_STARTED_AT_MS,
        nextRetryAtMs: NOW_MS,
        terminalAtMs: READINESS_BLOCKED_AT_MS,
        version: 4,
      }
    );
    assert.deepEqual(
      runtime.database
        .prepare(`
          SELECT status, result_type, result_id, completed_at_ms
          FROM idempotency_requests
          WHERE league_id = ?
            AND operation = 'matchup.schedule.generate.v1'
        `)
        .get(IDS.league),
      {
        status: "completed",
        result_type: "matchup_schedule_command",
        result_id: commandResult.id,
        completed_at_ms: NOW_MS,
      }
    );
    assert.equal(
      runtime.secureRandom.generated.at(-1),
      after.corrections[0].id
    );
  });

  test("exact replay is byte-identical and consumes no identifier or second correction", (t) => {
    const runtime = createRuntime(t, {
      seedReadiness: seedBlockedReadiness,
    });
    const command = scheduleCommand();
    const first = runtime.service.generate(command);
    const identifierCount = runtime.secureRandom.generated.length;
    const beforeReplay = runtime.database.serialize();

    const replay = runtime.service.generate(command);

    assert.deepEqual(replay, first);
    assert.equal(
      runtime.secureRandom.generated.length,
      identifierCount
    );
    assert.equal(
      beforeReplay.equals(runtime.database.serialize()),
      true
    );
    assert.equal(
      readReadinessState(runtime.database).corrections.length,
      1
    );
  });

  test("requeues when the exact missing-schedule blocker appears with other blockers", (t) => {
    const blockers = [
      MISSING_SCHEDULE_BLOCKER,
      OTHER_BLOCKER,
    ];
    const runtime = createRuntime(t, {
      seedReadiness(database) {
        seedBlockedReadiness(database, blockers);
      },
    });

    const result = runtime.service.generate(
      scheduleCommand({
        idempotencyKey:
          "corrective-with-additional-blocker",
      })
    );
    const after = readReadinessState(runtime.database);

    assertPublicScheduleResult(result, runtime);
    assert.equal(after.corrections.length, 1);
    assert.equal(
      after.corrections[0].blockers_json,
      canonicalReadinessBlockers(blockers)
    );
    assert.equal(after.operation.status, "blocked");
    assert.equal(after.job.status, "pending");
  });

  test("accepts canonical schema-48 succeeded evidence and fails closed on legacy or malformed roots", async (t) => {
    await t.test("canonical four-publication opening", (nested) => {
      const runtime = createRuntime(nested, {
        seedReadiness: seedSucceededReadiness,
      });
      const before = readReadinessState(runtime.database);

      const result = runtime.service.generate(
        scheduleCommand({
          idempotencyKey: "canonical-succeeded-readiness",
        })
      );

      assert.equal(result.seasonVersion, 2);
      const after = readReadinessState(runtime.database);
      assert.deepEqual(after.operation, before.operation);
      assert.deepEqual(after.job, before.job);
      assert.deepEqual(after.attempts, before.attempts);
      assert.deepEqual(after.corrections, []);
    });

    for (const [name, rootEvidence] of [
      ["retired fad_cards_opened event", "legacy"],
      ["non-empty root team relation", "malformed"],
      ["team audience on the root", "wrong_audience"],
    ]) {
      await t.test(name, (nested) => {
        const runtime = createRuntime(nested, {
          seedReadiness(database) {
            seedSucceededReadiness(database, {
              rootEvidence,
            });
          },
        });
        const before = runtime.database.serialize();

        assert.throws(
          () =>
            runtime.service.generate(
              scheduleCommand({
                idempotencyKey:
                  `invalid-succeeded-${rootEvidence}`,
              })
            ),
          (error) =>
            error?.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE" ||
            error?.cause?.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE"
        );
        assert.equal(
          before.equals(runtime.database.serialize()),
          true
        );
      });
    }
  });

  test("safe absent and non-eligible readiness classifications do not change the pair or write corrective evidence", async (t) => {
    const scenarios = [
      ["no readiness occurrence", null],
      ["non-inaugural occurrence", seedNonInauguralReadiness],
      ["pending pair", seedPendingReadiness],
      [
        "running pair",
        (database) => {
          seedPendingReadiness(database);
          startReadiness(database);
        },
      ],
      ["blocked plus pending after T-128", seedPostT128Readiness],
      [
        "blocked and failed without the missing-schedule blocker",
        (database) => seedBlockedReadiness(database, OTHER_BLOCKER),
      ],
      ...[
        ["field", { field: "schedule" }],
        [
          "message",
          {
            message:
              "The first matchup schedule is unavailable.",
          },
        ],
        ["resource type", { resourceType: "league" }],
        [
          "resource identifier",
          { resourceId: IDS.teams[0] },
        ],
      ].map(([label, override]) => [
        `blocked and failed with a near-match ${label}`,
        (database) =>
          seedBlockedReadiness(database, {
            ...MISSING_SCHEDULE_BLOCKER,
            ...override,
          }),
      ]),
    ];

    for (const [name, seedReadiness] of scenarios) {
      await t.test(name, (nested) => {
        const runtime = createRuntime(nested, { seedReadiness });
        const before = readReadinessState(runtime.database);

        const result = runtime.service.generate(
          scheduleCommand({ idempotencyKey: `safe-${name}` })
        );

        assert.equal(result.seasonVersion, 2);
        assert.equal(result.firstWeekStartsAtMs, FIRST_WEEK_MS);
        const after = readReadinessState(runtime.database);
        assert.deepEqual(after.operation, before.operation);
        assert.deepEqual(after.job, before.job);
        assert.deepEqual(after.attempts, before.attempts);
        assert.deepEqual(after.retryReceipts, before.retryReceipts);
        assert.deepEqual(after.corrections, []);
        if (seedReadiness === null) {
          assertNoReadinessTriggerCreated(runtime.database);
        }
      });
    }
  });

  test("malformed or split genuine-inaugural variants roll the complete schedule back", async (t) => {
    const scenarios = [
      ["pending operation with failed job", seedPendingFailedSplit],
      ["blocked pair without latest attempt", seedBlockedWithoutAttempt],
      ["blocked pair with split occurrence", seedOccurrenceSplit],
    ];

    for (const [name, seedReadiness] of scenarios) {
      await t.test(name, (nested) => {
        const runtime = createRuntime(nested, { seedReadiness });
        const before = runtime.database.serialize();

        assert.throws(
          () =>
            runtime.service.generate(
              scheduleCommand({ idempotencyKey: `malformed-${name}` })
            ),
          (error) =>
            error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" ||
            error?.cause?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
        );
        assert.equal(
          before.equals(runtime.database.serialize()),
          true,
          name
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM matchup_schedule_command_results
              WHERE league_id = ? AND season_id = ?
            `)
            .get(IDS.league, IDS.season).count,
          0
        );
      });
    }
  });

  test("every corrective and command-result seam rolls back schedule, evidence, job, readiness, and idempotency together", async (t) => {
    for (const seam of [
      "after_command_result",
      "after_corrective_evidence",
      "after_job_reset",
      "after_readiness_advance",
      "after_idempotency_completion",
    ]) {
      await t.test(seam, (nested) => {
        const runtime = createRuntime(nested, {
          seedReadiness: seedBlockedReadiness,
          beforeCommit(currentSeam) {
            if (currentSeam === seam) {
              throw new Error(`injected ${seam}`);
            }
          },
        });
        const before = runtime.database.serialize();

        assert.throws(
          () =>
            runtime.service.generate(
              scheduleCommand({ idempotencyKey: `rollback-${seam}` })
            ),
          (error) => error?.cause?.message === `injected ${seam}`,
          seam
        );
        assert.equal(
          before.equals(runtime.database.serialize()),
          true,
          seam
        );
        assert.equal(
          readReadinessState(runtime.database).corrections.length,
          0
        );
      });
    }
  });

  test("T-096 Week 1 editing neither creates nor requeues FAD readiness", (t) => {
    const runtime = createRuntime(t);
    const generated = runtime.service.generate(
      scheduleCommand({
        firstWeekStartsAtMs: SECOND_WEEK_MS,
        idempotencyKey: "corrective-t096-generate",
      })
    );
    assertNoReadinessTriggerCreated(runtime.database);
    assert.equal(
      readReadinessState(runtime.database).corrections.length,
      0
    );

    const shifted = runtime.service.shiftWeekOne(
      shiftCommand({ weekId: generated.firstWeekId })
    );

    assert.equal(shifted.firstWeekStartsAtMs, FIRST_WEEK_MS);
    assert.equal(shifted.weekVersion, 2);
    assertNoReadinessTriggerCreated(runtime.database);
    assert.equal(
      readReadinessState(runtime.database).corrections.length,
      0
    );
  });
});
