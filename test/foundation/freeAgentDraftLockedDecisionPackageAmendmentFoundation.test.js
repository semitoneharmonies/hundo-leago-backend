const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteCandidateCardRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteCandidateCardRepository"
);
const {
  createSqliteFreeAgentDraftJobRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const LOCKED_MIGRATION_ID = 30;
const NEW_HISTORICAL_TABLES = Object.freeze([
  "auction_administration_command_results",
  "free_agent_draft_schedule_recovery_matchups",
  "matchup_roster_game_exclusion_sets",
  "matchup_schedule_command_results",
  "matchup_schedule_job_bindings",
  "nhl_game_state_observation_snapshots",
  "nhl_game_state_observations",
  "player_game_stat_observations",
  "stat_refresh_player_game_coverage_entries",
  "stat_refresh_player_game_sets",
]);

function createRuntime({ currentHead = false } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad-0030-amendment-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  try {
    const discoveredMigrations = discoverMigrations({
      migrationsDirectory: CANONICAL_MIGRATIONS,
    });
    const migrations = currentHead
      ? discoveredMigrations
      : discoveredMigrations.filter(
          ({ id }) => id <= LOCKED_MIGRATION_ID
        );

    if (!currentHead) {
      assert.deepEqual(
        migrations.map(({ id }) => id),
        Array.from(
          { length: LOCKED_MIGRATION_ID },
          (_, index) => index + 1
        )
      );
    }

    const migrationState = applyMigrations({
      database: connection.database,
      migrations,
      applicationBuildId: currentHead
        ? "fad-current-head-amendment-foundation"
        : "fad-0030-amendment-foundation",
      now: () => 1_000,
    });

    return {
      ...connection,
      migrationState,
      temporaryRoot,
    };
  } catch (error) {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function schemaSql(database, type, name) {
  return database
    .prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = ?
        AND name = ?
    `)
    .get(type, name)?.sql;
}

function tableColumns(database, tableName) {
  return database
    .prepare(`PRAGMA table_info("${tableName}")`)
    .all();
}

function tableForeignKeys(database, tableName) {
  return database
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all();
}

function tableTriggers(database, tableName) {
  return database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name
    `)
    .all(tableName);
}

function compactSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasImmutableTrigger(triggers, tableName, operation) {
  const expression = new RegExp(
    `\\bBEFORE\\s+${operation}\\s+ON\\s+` +
      `["'\`]?${escapeRegExp(tableName)}["'\`]?\\b`,
    "i"
  );
  return triggers.some(({ sql }) => {
    return expression.test(sql) && /\bRAISE\s*\(/i.test(sql);
  });
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  return database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns.map((column) => `@${column}`).join(", ")}
      )
    `)
    .run(values);
}

function dropTrigger(database, triggerName) {
  database.exec(
    `DROP TRIGGER "${triggerName.replaceAll('"', '""')}"`
  );
}

function dropInsertTriggers(database, tableName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (/\b(?:BEFORE|AFTER)\s+INSERT\b/i.test(trigger.sql)) {
      dropTrigger(database, trigger.name);
    }
  }
}

function dropUpdateTriggers(database, tableName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (/\b(?:BEFORE|AFTER)\s+UPDATE\b/i.test(trigger.sql)) {
      dropTrigger(database, trigger.name);
    }
  }
}

function isolateTableTrigger(database, tableName, triggerName) {
  for (const trigger of tableTriggers(database, tableName)) {
    if (trigger.name !== triggerName) {
      dropTrigger(database, trigger.name);
    }
  }
  assert.ok(
    schemaSql(database, "trigger", triggerName),
    `missing isolated trigger ${triggerName}`
  );
}

function createDisposableRuntime(t, options) {
  const disposable = createRuntime(options);
  t.after(() => {
    if (disposable.database.open) disposable.database.close();
    fs.rmSync(disposable.temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  disposable.database.pragma("foreign_keys = OFF");
  return disposable;
}

const FIXTURE_CLOCK = Object.freeze({
  openedAtMs: 827_190_000,
  helpOpensAtMs: 827_200_000,
  candidateDeadlineAtMs: 1_000_000_000,
  firstMatchupStartsAtMs: 1_604_800_000,
});

function seedRawFad(database, base, status = "cards_open") {
  const ids = {
    league: uuid(base + 1),
    season: uuid(base + 2),
    fad: uuid(base + 3),
    readiness: uuid(base + 4),
    week: uuid(base + 5),
    teamOne: uuid(base + 6),
    teamTwo: uuid(base + 7),
    cardOne: uuid(base + 8),
    cardTwo: uuid(base + 9),
    player: uuid(base + 10),
    allocation: uuid(base + 11),
    currentRollover: uuid(base + 12),
    targetRollover: uuid(base + 13),
    auction: uuid(base + 14),
    snapshotOne: uuid(base + 15),
    snapshotTwo: uuid(base + 16),
    entryOne: uuid(base + 17),
    entryTwo: uuid(base + 18),
    participantOne: uuid(base + 19),
    participantTwo: uuid(base + 20),
    draw: uuid(base + 21),
    revisionOne: uuid(base + 22),
    revisionTwo: uuid(base + 23),
    userOne: uuid(base + 24),
    userTwo: uuid(base + 25),
    membershipOne: uuid(base + 26),
    membershipTwo: uuid(base + 27),
    job: uuid(base + 28),
    resolution: uuid(base + 29),
    recovery: uuid(base + 30),
  };
  const deadlineLockedAtMs =
    status === "cards_open"
      ? null
      : FIXTURE_CLOCK.candidateDeadlineAtMs + 10;
  const allocationCompletedAtMs = ["rapid", "completed"].includes(
    status
  )
    ? FIXTURE_CLOCK.candidateDeadlineAtMs + 20
    : null;
  const completedAtMs =
    status === "completed"
      ? FIXTURE_CLOCK.candidateDeadlineAtMs + 30
      : null;
  const updatedAtMs =
    completedAtMs ??
    allocationCompletedAtMs ??
    deadlineLockedAtMs ??
    FIXTURE_CLOCK.openedAtMs;

  dropInsertTriggers(database, "free_agent_drafts");
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id: ids.readiness,
    readiness_occurrence_key: `fad:${ids.season}:readiness`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id: ids.week,
    schedule_recovery_id: null,
    participating_team_count: 1,
    status,
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason: "Isolated migration acceptance fixture.",
    opening_authority: "system",
    opened_at_ms: FIXTURE_CLOCK.openedAtMs,
    help_opens_at_ms: FIXTURE_CLOCK.helpOpensAtMs,
    candidate_deadline_at_ms:
      FIXTURE_CLOCK.candidateDeadlineAtMs,
    first_matchup_starts_at_ms:
      FIXTURE_CLOCK.firstMatchupStartsAtMs,
    deadline_locked_at_ms: deadlineLockedAtMs,
    allocation_completed_at_ms: allocationCompletedAtMs,
    completed_at_ms: completedAtMs,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: updatedAtMs,
    version: 1,
  });
  return ids;
}

function transitionFad(database, ids, targetStatus, atMs) {
  const fields = {
    status: targetStatus,
    updated_at_ms: atMs,
    version: database
      .prepare("SELECT version FROM free_agent_drafts WHERE id = ?")
      .get(ids.fad).version + 1,
  };
  if (targetStatus === "deadline_locked") {
    fields.deadline_locked_at_ms = atMs;
  } else if (targetStatus === "rapid") {
    fields.allocation_completed_at_ms = atMs;
  } else if (targetStatus === "completed") {
    fields.completed_at_ms = atMs;
  }
  const columns = Object.keys(fields);
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET ${columns.map((column) => `${column} = @${column}`).join(", ")}
      WHERE id = @fadId
    `)
    .run({ ...fields, fadId: ids.fad });
}

function seedRawAllocation(
  database,
  ids,
  {
    status = "pending",
    decisionCode = null,
    updatedAtMs = FIXTURE_CLOCK.candidateDeadlineAtMs + 20,
    version = status === "pending" ? 1 : 2,
    auctionId = null,
  } = {}
) {
  dropInsertTriggers(database, "free_agent_draft_player_allocations");
  const automatic = status === "automatic_award";
  const restricted = [
    "restricted_scheduled",
    "restricted_active",
  ].includes(status);
  insert(database, "free_agent_draft_player_allocations", {
    id: ids.allocation,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    status,
    decision_code: decisionCode,
    winning_snapshot_entry_id: automatic ? ids.entryOne : null,
    winning_team_id: automatic ? ids.teamOne : null,
    contract_id: automatic ? uuid(900_001) : null,
    ownership_id: automatic ? uuid(900_002) : null,
    restricted_auction_id: restricted ? auctionId : null,
    fallback_open_auction_id: null,
    restricted_minimum_total_cents: restricted ? 600 : null,
    restricted_minimum_term_years: restricted ? 2 : null,
    restricted_minimum_aav_cents: restricted ? 300 : null,
    accounted_at_ms:
      automatic || ["no_valid_offer", "invalid"].includes(status)
        ? updatedAtMs
        : null,
    last_error_code: null,
    created_at_ms: FIXTURE_CLOCK.candidateDeadlineAtMs,
    updated_at_ms: updatedAtMs,
    version,
  });
}

function seedRawRollover(
  database,
  ids,
  {
    id = ids.currentRollover,
    sequence = 1,
    predecessorRolloverId = null,
    opensAtMs = FIXTURE_CLOCK.candidateDeadlineAtMs,
    status = "scheduled",
    processingJobRunId = null,
  } = {}
) {
  dropInsertTriggers(database, "free_agent_draft_rollovers");
  const rollsOverAtMs = opensAtMs + 86_400_000;
  const terminal = status === "completed";
  const processingStartedAtMs = terminal
    ? rollsOverAtMs + 1
    : null;
  const completedAtMs = terminal ? rollsOverAtMs + 2 : null;
  insert(database, "free_agent_draft_rollovers", {
    id,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    sequence,
    window_kind: sequence <= 7 ? "initial" : "extension",
    predecessor_rollover_id: predecessorRolloverId,
    extension_reason: sequence <= 7 ? null : "restricted_auction",
    extension_source_id: sequence <= 7 ? null : ids.allocation,
    opens_at_ms: opensAtMs,
    creation_cutoff_at_ms: rollsOverAtMs - 3_600_000,
    rolls_over_at_ms: rollsOverAtMs,
    status,
    processing_job_run_id: terminal
      ? processingJobRunId ?? uuid(910_000 + sequence)
      : null,
    processing_started_at_ms: processingStartedAtMs,
    completed_at_ms: completedAtMs,
    last_error_code: null,
    created_at_ms: opensAtMs,
    updated_at_ms: completedAtMs ?? opensAtMs,
    version: terminal ? 3 : 1,
  });
  return {
    id,
    sequence,
    opensAtMs,
    creationCutoffAtMs: rollsOverAtMs - 3_600_000,
    rollsOverAtMs,
    completedAtMs,
  };
}

function seedRawJob(
  database,
  ids,
  {
    id,
    jobType,
    occurrenceKey,
    scheduledForMs,
    status = "pending",
    leaseExpiresAtMs = null,
    completedAtMs = null,
  }
) {
  dropInsertTriggers(database, "job_runs");
  const active = ["leased", "running"].includes(status);
  const terminal = ["succeeded", "failed", "skipped"].includes(
    status
  );
  const attemptCount = status === "pending" ? 0 : 1;
  const startedAtMs =
    status === "running" || terminal ? scheduledForMs : null;
  const terminalAtMs = terminal
    ? completedAtMs ?? scheduledForMs + 1
    : null;
  const resultJson = status === "succeeded" ? "{}" : null;
  const lastErrorCode = status === "failed" ? "FIXTURE_FAILURE" : null;

  insert(database, "job_runs", {
    id,
    league_id: ids.league,
    season_id: ids.season,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
    status,
    attempt_count: attemptCount,
    lease_owner: active ? "fad-0030-acceptance" : null,
    lease_expires_at_ms: active ? leaseExpiresAtMs : null,
    started_at_ms: startedAtMs,
    completed_at_ms: terminalAtMs,
    result_json: resultJson,
    last_error_code: lastErrorCode,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms:
      terminalAtMs ??
      (active ? scheduledForMs : FIXTURE_CLOCK.openedAtMs),
    version: status === "pending" ? 1 : 2,
    lease_token: active ? `lease:${id}` : null,
    next_attempt_at_ms:
      status === "failed" ? terminalAtMs + 1 : null,
  });
  return id;
}

function seedRawCurrentFadScope(database, ids) {
  dropInsertTriggers(database, "leagues");
  insert(database, "leagues", {
    id: ids.league,
    name: `FAD claim ${ids.league}`,
    name_normalized: `fad claim ${ids.league}`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: ids.season,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });

  dropInsertTriggers(database, "seasons");
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms:
      FIXTURE_CLOCK.firstMatchupStartsAtMs,
    regular_season_ends_at_ms:
      FIXTURE_CLOCK.firstMatchupStartsAtMs + 30 * 86_400_000,
    fantasy_playoffs_start_at_ms:
      FIXTURE_CLOCK.firstMatchupStartsAtMs + 14 * 86_400_000,
    fantasy_playoffs_end_at_ms:
      FIXTURE_CLOCK.firstMatchupStartsAtMs + 30 * 86_400_000,
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });

  dropInsertTriggers(
    database,
    "free_agent_draft_readiness_operations"
  );
  insert(database, "free_agent_draft_readiness_operations", {
    id: ids.readiness,
    league_id: ids.league,
    season_id: ids.season,
    readiness_occurrence_key: `fad:${ids.season}:readiness`,
    trigger_kind: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    job_run_id: null,
    status: "succeeded",
    attempt_count: 1,
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    blockers_json: "[]",
    matchup_schedule_version_before: null,
    matchup_schedule_version_after: null,
    schedule_recovery_id: null,
    created_fad_id: ids.fad,
    reminder_job_run_id: ids.cardOne,
    deadline_job_run_id: ids.cardTwo,
    cards_opened_activity_id: ids.snapshotOne,
    cards_opened_outbox_event_id: ids.snapshotTwo,
    started_at_ms: FIXTURE_CLOCK.openedAtMs,
    next_retry_at_ms: null,
    terminal_at_ms: FIXTURE_CLOCK.openedAtMs,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: FIXTURE_CLOCK.openedAtMs,
    version: 1,
  });
}

function seedRawRolloverJob(
  database,
  ids,
  rollover,
  overrides = {}
) {
  dropInsertTriggers(database, "job_runs");
  const values = {
    id: ids.job,
    league_id: ids.league,
    season_id: ids.season,
    job_type: "fad_rollover",
    occurrence_key:
      `fad:${ids.fad}:rollover:${rollover.sequence}:` +
      `${rollover.rollsOverAtMs}`,
    scheduled_for_ms: rollover.rollsOverAtMs,
    status: "running",
    attempt_count: 1,
    lease_owner: "fad-rollover-worker",
    lease_expires_at_ms: rollover.rollsOverAtMs + 60_000,
    started_at_ms: rollover.rollsOverAtMs,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: rollover.rollsOverAtMs,
    version: 2,
    lease_token: `lease:${ids.job}`,
    next_attempt_at_ms: null,
    ...overrides,
  };
  insert(database, "job_runs", values);
  return values;
}

function startRawRolloverProcessing(
  database,
  ids,
  rollover,
  atMs = rollover.rollsOverAtMs
) {
  return database.prepare(`
    UPDATE free_agent_draft_rollovers
    SET status = 'processing',
        processing_job_run_id = @jobRunId,
        processing_started_at_ms = @atMs,
        updated_at_ms = @atMs,
        version = version + 1
    WHERE league_id = @leagueId
      AND season_id = @seasonId
      AND fad_id = @fadId
      AND id = @rolloverId
      AND status = 'scheduled'
      AND version = 1
  `).run({
    leagueId: ids.league,
    seasonId: ids.season,
    fadId: ids.fad,
    rolloverId: rollover.id,
    jobRunId: ids.job,
    atMs,
  });
}

function seedSevenRawRollovers(
  database,
  ids,
  base,
  { status = "scheduled", withJobs = false } = {}
) {
  const rollovers = [];
  let predecessorRolloverId = null;
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const id =
      sequence === 1
        ? ids.currentRollover
        : sequence === 2
          ? ids.targetRollover
          : uuid(base + 100 + sequence);
    const processingJobRunId = uuid(base + 200 + sequence);
    const rollover = seedRawRollover(database, ids, {
      id,
      sequence,
      predecessorRolloverId,
      opensAtMs:
        FIXTURE_CLOCK.candidateDeadlineAtMs +
        (sequence - 1) * 86_400_000,
      status,
      processingJobRunId,
    });
    rollovers.push({ ...rollover, processingJobRunId });
    predecessorRolloverId = id;

    if (withJobs) {
      seedRawJob(database, ids, {
        id: processingJobRunId,
        jobType: "fad_rollover",
        occurrenceKey:
          `fad:${ids.fad}:rollover:${sequence}:` +
          `${rollover.rollsOverAtMs}`,
        scheduledForMs: rollover.rollsOverAtMs,
        status: status === "completed" ? "succeeded" : "pending",
        completedAtMs: rollover.completedAtMs,
      });
    }
  }
  return rollovers;
}

function seedRawAuction(
  database,
  ids,
  {
    auctionId = ids.auction,
    status = "open",
    openedAtMs,
    resolvesAtMs,
  }
) {
  dropInsertTriggers(database, "auctions");
  insert(database, "auctions", {
    id: auctionId,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    status,
    opened_at_ms: openedAtMs,
    resolves_at_ms: resolvesAtMs,
    opened_by_user_id: null,
    created_at_ms: openedAtMs,
    updated_at_ms:
      status === "open" ? openedAtMs : resolvesAtMs,
    version: status === "open" ? 1 : 2,
  });
}

function seedRawAuctionContext(
  database,
  ids,
  {
    auctionId = ids.auction,
    rolloverId = ids.currentRollover,
    allocationId = null,
    sourceKind = "fad_open_rapid",
    fadOrigin = "manager_nomination",
    createdAtMs,
  } = {}
) {
  dropInsertTriggers(database, "auction_contexts");
  insert(database, "auction_contexts", {
    id: auctionId,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: auctionId,
    source_kind: sourceKind,
    fad_id: ids.fad,
    fad_rollover_id: rolloverId,
    fad_allocation_id: allocationId,
    fad_origin: fadOrigin,
    created_at_ms: createdAtMs,
  });
}

function seedRawResolution(
  database,
  ids,
  {
    auctionId = ids.auction,
    resolvesAtMs,
    resolvedAtMs = resolvesAtMs,
    outcomeCode = "no_winner",
    status = "no_winner",
  }
) {
  dropInsertTriggers(database, "auction_resolutions");
  insert(database, "auction_resolutions", {
    id: ids.resolution,
    league_id: ids.league,
    season_id: ids.season,
    auction_id: auctionId,
    scheduled_occurrence_key: `auction:${auctionId}:${resolvesAtMs}`,
    outcome_code: outcomeCode,
    winning_team_id: null,
    winning_bid_id: null,
    highest_bid_cents: null,
    second_price_input_cents: null,
    final_contract_value_cents: null,
    winning_term_years: null,
    final_aav_cents: null,
    general_illegal: 0,
    warnings_json: "[]",
    contract_id: null,
    ownership_id: null,
    trigger_type: "automatic",
    triggered_by_user_id: null,
    idempotency_key: `fixture:${ids.resolution}`,
    status,
    resolved_at_ms: resolvedAtMs,
  });
}

function transitionPendingAllocationToRestricted(
  database,
  ids,
  {
    status,
    auctionId,
    atMs,
    minimumTotalValueCents = 600,
    minimumTermYears = 2,
  }
) {
  const minimumAavCents = Math.floor(
    (minimumTotalValueCents + Math.floor(minimumTermYears / 2)) /
      minimumTermYears
  );
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = @status,
          decision_code = 'exact_total_and_term_tie',
          restricted_auction_id = @auctionId,
          restricted_minimum_total_cents = @minimumTotalValueCents,
          restricted_minimum_term_years = @minimumTermYears,
          restricted_minimum_aav_cents = @minimumAavCents,
          updated_at_ms = @atMs,
          version = version + 1
      WHERE id = @allocationId
    `)
    .run({
      status,
      auctionId,
      minimumTotalValueCents,
      minimumTermYears,
      minimumAavCents,
      atMs,
      allocationId: ids.allocation,
    });
}

function seedRawTieSnapshots(
  database,
  ids,
  {
    secondTotalValueCents = 600,
    secondTermYears = 2,
  } = {}
) {
  dropInsertTriggers(database, "candidate_card_snapshot_entries");
  const offers = [
    {
      id: ids.entryOne,
      snapshotId: ids.snapshotOne,
      cardId: ids.cardOne,
      teamId: ids.teamOne,
      sourceEntryId: uuid(920_001),
      userId: ids.userOne,
      membershipId: ids.membershipOne,
      totalValueCents: 600,
      termYears: 2,
    },
    {
      id: ids.entryTwo,
      snapshotId: ids.snapshotTwo,
      cardId: ids.cardTwo,
      teamId: ids.teamTwo,
      sourceEntryId: uuid(920_002),
      userId: ids.userTwo,
      membershipId: ids.membershipTwo,
      totalValueCents: secondTotalValueCents,
      termYears: secondTermYears,
    },
  ];

  for (const offer of offers) {
    const aavCents = Math.floor(
      (offer.totalValueCents + Math.floor(offer.termYears / 2)) /
        offer.termYears
    );
    insert(database, "candidate_card_snapshot_entries", {
      id: offer.id,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      snapshot_id: offer.snapshotId,
      card_id: offer.cardId,
      team_id: offer.teamId,
      row_kind: "slot",
      occupant_kind: "candidate",
      slot_group: "F",
      slot_number: 1,
      source_entry_id: offer.sourceEntryId,
      source_entry_version: 1,
      player_id: ids.player,
      effective_position_group: "F",
      conflict_code: null,
      carryover_ownership_id: null,
      carryover_contract_id: null,
      source_roster_category: null,
      carryover_original_total_value_cents: null,
      carryover_original_term_years: null,
      carryover_aav_cents: null,
      remaining_years: null,
      proposed_total_value_cents: offer.totalValueCents,
      proposed_term_years: offer.termYears,
      proposed_aav_cents: aavCents,
      eligibility_status: "valid",
      validation_code: null,
      last_edited_by_user_id: offer.userId,
      last_edited_by_membership_id: offer.membershipId,
      last_edited_by_authority: "manager",
      last_edited_at_ms: FIXTURE_CLOCK.candidateDeadlineAtMs - 1,
      created_at_ms: FIXTURE_CLOCK.candidateDeadlineAtMs,
      allocation_eligibility: "eligible",
      allocation_exclusion_reason: null,
    });
    offer.aavCents = aavCents;
  }
  return offers;
}

function seedRawRestrictedAllocationEvents(
  database,
  ids,
  { status, auctionId, occurredAtMs }
) {
  dropInsertTriggers(database, "free_agent_draft_allocation_events");
  const baseEvent = {
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    allocation_version: 2,
    player_id: ids.player,
    decision_code: null,
    resulting_allocation_status: status,
    contract_id: null,
    ownership_id: null,
    auction_id: null,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: occurredAtMs,
    created_at_ms: occurredAtMs,
    version: 1,
  };
  for (const [index, offer] of [
    { snapshotEntryId: ids.entryOne, teamId: ids.teamOne },
    { snapshotEntryId: ids.entryTwo, teamId: ids.teamTwo },
  ].entries()) {
    insert(database, "free_agent_draft_allocation_events", {
      ...baseEvent,
      id: uuid(930_001 + index),
      event_kind: "offer_considered",
      snapshot_entry_id: offer.snapshotEntryId,
      team_id: offer.teamId,
      offer_valid: 1,
      rank_position: 1,
      offer_outcome_code: "restricted_tied",
    });
  }
  insert(database, "free_agent_draft_allocation_events", {
    ...baseEvent,
    id: uuid(930_003),
    event_kind: "restricted_state_changed",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: "exact_total_and_term_tie",
    auction_id: auctionId,
  });
}

function seedRawRestrictedResources(
  database,
  ids,
  {
    auctionId = ids.auction,
    rolloverId,
    openedAtMs,
  }
) {
  seedRawAuctionContext(database, ids, {
    auctionId,
    rolloverId,
    allocationId: ids.allocation,
    sourceKind: "fad_restricted",
    fadOrigin: "candidate_tie_restricted",
    createdAtMs: openedAtMs,
  });

  dropInsertTriggers(database, "free_agent_draft_draws");
  insert(database, "free_agent_draft_draws", {
    id: ids.draw,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    allocation_id: ids.allocation,
    auction_id: auctionId,
    algorithm_version: 1,
    nonce_bytes: Buffer.alloc(32, 0x30),
    commitment_hex: "a".repeat(64),
    ordered_tied_bid_ids_json: null,
    ordered_tied_team_ids_json: null,
    rejection_counter: null,
    selected_index: null,
    selected_bid_id: null,
    selected_team_id: null,
    selected_digest_hex: null,
    revealed_at_ms: null,
    created_at_ms: openedAtMs,
    updated_at_ms: openedAtMs,
    version: 1,
  });

  dropInsertTriggers(
    database,
    "free_agent_draft_auction_participants"
  );
  for (const participant of [
    {
      id: ids.participantOne,
      teamId: ids.teamOne,
      snapshotEntryId: ids.entryOne,
      revisionId: ids.revisionOne,
      userId: ids.userOne,
      membershipId: ids.membershipOne,
    },
    {
      id: ids.participantTwo,
      teamId: ids.teamTwo,
      snapshotEntryId: ids.entryTwo,
      revisionId: ids.revisionTwo,
      userId: ids.userTwo,
      membershipId: ids.membershipTwo,
    },
  ]) {
    insert(database, "free_agent_draft_auction_participants", {
      id: participant.id,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      allocation_id: ids.allocation,
      auction_id: auctionId,
      team_id: participant.teamId,
      status: "active",
      source_snapshot_entry_id: participant.snapshotEntryId,
      originating_candidate_revision_id: participant.revisionId,
      minimum_total_value_cents: 600,
      minimum_term_years: 2,
      minimum_aav_cents: 300,
      active_improvement_bid_id: null,
      manager_edit_limit: 1,
      cooldown_duration_ms: 4_500_000,
      first_improvement_at_ms: null,
      current_cooldown_anchor_at_ms: null,
      improvement_committed_at_ms: null,
      originating_actor_user_id: participant.userId,
      originating_actor_membership_id: participant.membershipId,
      originating_actor_authority: "manager",
      removed_by_user_id: null,
      removed_by_membership_id: null,
      removed_authority: null,
      removal_reason: null,
      removed_at_ms: null,
      created_at_ms: openedAtMs,
      updated_at_ms: openedAtMs,
      version: 1,
    });
  }
}

function seedRawResolvedAuctionRecovery(
  database,
  ids,
  { rolloverId, auctionId = ids.auction, resolvedAtMs }
) {
  dropInsertTriggers(database, "free_agent_draft_recoveries");
  insert(database, "free_agent_draft_recoveries", {
    id: ids.recovery,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    player_id: ids.player,
    allocation_id: ids.allocation,
    rollover_id: rolloverId,
    auction_id: auctionId,
    job_run_id: ids.job,
    kind: "auction_resolution",
    status: "resolved",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "CORRECTION_REQUIRED",
    commissioner_reason: "Resolved blind auction correction fixture.",
    created_by_operation_id: null,
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: "system",
    created_at_ms: resolvedAtMs - 1,
    updated_at_ms: resolvedAtMs,
    resolved_at_ms: resolvedAtMs,
    version: 2,
  });
}

function seedRawCandidateCarryover(database, ids, base) {
  const ownershipId = uuid(base + 31);
  const contractId = uuid(base + 32);
  const entryId = uuid(base + 33);

  dropInsertTriggers(database, "candidate_cards");
  dropInsertTriggers(database, "player_ownerships");
  dropInsertTriggers(database, "candidate_card_entries");

  insert(database, "candidate_cards", {
    id: ids.cardOne,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    team_id: ids.teamOne,
    status: "open",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    maximum_possible_cap_cents: 300,
    locked_at_ms: null,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: FIXTURE_CLOCK.openedAtMs,
    version: 1,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  });
  insert(database, "player_ownerships", {
    id: ownershipId,
    league_id: ids.league,
    season_id: ids.season,
    player_id: ids.player,
    team_id: ids.teamOne,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "fixture",
    acquired_transaction_id: null,
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: FIXTURE_CLOCK.openedAtMs,
    version: 1,
    trade_blocked: 0,
  });
  insert(database, "candidate_card_entries", {
    id: entryId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: ids.cardOne,
    team_id: ids.teamOne,
    entry_kind: "carryover",
    player_id: ids.player,
    effective_position_group: "F",
    requested_slot_group: "F",
    requested_slot_number: 1,
    placement_state: "placed",
    conflict_code: null,
    carryover_ownership_id: ownershipId,
    carryover_contract_id: contractId,
    source_roster_category: "Active",
    carryover_original_total_value_cents: 600,
    carryover_original_term_years: 2,
    carryover_aav_cents: 300,
    remaining_years: 2,
    proposed_total_value_cents: null,
    proposed_term_years: null,
    proposed_aav_cents: null,
    eligibility_status: null,
    validation_code: null,
    last_acknowledgement_revision_id: null,
    created_by_user_id: null,
    created_by_membership_id: null,
    created_by_authority: "system",
    last_edited_by_user_id: null,
    last_edited_by_membership_id: null,
    last_edited_by_authority: "system",
    created_at_ms: FIXTURE_CLOCK.openedAtMs,
    updated_at_ms: FIXTURE_CLOCK.openedAtMs,
    version: 1,
  });

  return { entryId, ownershipId };
}

const LATE_LOCK_TRIGGER_CLOCK = Object.freeze({
  weekStartsAtMs: 1_000_000,
  baselineAtMs: 1_100_000,
  lateSnapshotAtMs: 1_500_000,
  weekEndsAtMs: 2_000_000,
});

function prepareLateLockTriggerDatabase(
  database,
  { triggerName, tableName }
) {
  isolateTableTrigger(database, tableName, triggerName);
  for (const prerequisiteTable of [
    "leagues",
    "seasons",
    "teams",
    "matchup_weeks",
    "matchups",
    "players",
    "stat_sources",
    "stat_refreshes",
    "stat_refresh_player_game_coverage_entries",
    "player_game_stat_observations",
    "stat_refresh_player_game_sets",
    "stat_snapshots",
    "matchup_roster_locks",
    "matchup_roster_players",
    "nhl_game_state_observations",
    "nhl_game_state_observation_snapshots",
  ]) {
    if (prerequisiteTable !== tableName) {
      dropInsertTriggers(database, prerequisiteTable);
    }
  }
}

function seedLateLockTriggerFixture(
  database,
  base,
  {
    selectedPlayerCount = 1,
    coverageEntries,
    baselineObservations,
    gameObservations,
    statisticsProvider = `compatible-provider-${base}`,
    statisticsSourceVersion = "statistics-version",
    gameStateProvider = statisticsProvider,
    gameStateSourceVersion = "game-state-version",
    gameStateObservedAtMs =
      LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs - 300_000,
    insertGameState = true,
  } = {}
) {
  const ids = Object.freeze({
    league: uuid(base + 1),
    season: uuid(base + 2),
    week: uuid(base + 3),
    team: uuid(base + 4),
    awayTeam: uuid(base + 5),
    matchup: uuid(base + 6),
    source: uuid(base + 7),
    refresh: uuid(base + 8),
    playerGameSet: uuid(base + 9),
    baselineSnapshot: uuid(base + 10),
    lock: uuid(base + 11),
    gameStateSnapshot: uuid(base + 12),
    exclusionSet: uuid(base + 13),
  });
  const players = Array.from(
    { length: selectedPlayerCount },
    (_, index) => Object.freeze({
      playerId: uuid(base + 100 + index),
      lockPlayerId: uuid(base + 200 + index),
    })
  );
  const normalizedCoverage = (
    coverageEntries ?? [{
      playerIndex: 0,
      disposition: "expected_game",
      providerTeamId: "provider-team",
      nhlGameId: "game-1",
      nhlGameScheduledStartsAtMs: 1_250_000,
    }]
  ).map((entry, index) => Object.freeze({
    coverageEntryId: uuid(base + 300 + index),
    statSourceId: entry.statSourceId ?? ids.source,
    refreshId: entry.refreshId ?? ids.refresh,
    observationSetId:
      entry.observationSetId ?? ids.playerGameSet,
    nhlSeasonKey: entry.nhlSeasonKey ?? "20992000",
    playerIndex: entry.playerIndex,
    playerId:
      entry.playerId ?? players[entry.playerIndex].playerId,
    providerPlayerId:
      entry.providerPlayerId ??
      `provider-player-${entry.playerIndex}`,
    providerTeamId:
      entry.disposition === "no_team"
        ? null
        : entry.providerTeamId ?? "provider-team",
    disposition: entry.disposition,
    nhlGameId:
      entry.disposition === "expected_game"
        ? entry.nhlGameId
        : null,
    nhlGameScheduledStartsAtMs:
      entry.disposition === "expected_game"
        ? entry.nhlGameScheduledStartsAtMs
        : null,
  }));
  const normalizedBaselines = (
    baselineObservations ?? normalizedCoverage
      .filter(({ disposition }) => disposition === "expected_game")
      .map((entry) => ({
        playerIndex: entry.playerIndex,
        nhlGameId: entry.nhlGameId,
        nhlGameScheduledStartsAtMs:
          entry.nhlGameScheduledStartsAtMs,
      }))
  ).map((entry, index) => Object.freeze({
    observationId: uuid(base + 400 + index),
    observationSetId:
      entry.observationSetId ?? ids.playerGameSet,
    refreshId: entry.refreshId ?? ids.refresh,
    playerIndex: entry.playerIndex,
    playerId: players[entry.playerIndex].playerId,
    nhlGameId: entry.nhlGameId,
    nhlGameScheduledStartsAtMs:
      entry.nhlGameScheduledStartsAtMs,
  }));
  const derivedGames = new Map();
  for (const entry of normalizedCoverage) {
    if (
      entry.disposition === "expected_game" &&
      entry.nhlGameScheduledStartsAtMs >=
        LATE_LOCK_TRIGGER_CLOCK.weekStartsAtMs &&
      entry.nhlGameScheduledStartsAtMs <
        LATE_LOCK_TRIGGER_CLOCK.weekEndsAtMs
    ) {
      derivedGames.set(entry.nhlGameId, {
        nhlGameId: entry.nhlGameId,
        nhlGameScheduledStartsAtMs:
          entry.nhlGameScheduledStartsAtMs,
        observedGameState: "scheduled",
      });
    }
  }
  const normalizedGames = (gameObservations ?? [...derivedGames.values()])
    .map((game, index) => Object.freeze({
      observationId: uuid(base + 500 + index),
      nhlGameId: game.nhlGameId,
      nhlGameScheduledStartsAtMs:
        game.nhlGameScheduledStartsAtMs,
      observedGameState: game.observedGameState,
    }));

  insert(database, "leagues", {
    id: ids.league,
    name: `Late Lock ${base}`,
    name_normalized: `late lock ${base}`,
    status: "active",
    timezone: "America/Vancouver",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `Season ${base}`,
    nhl_season_key: "20992000",
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  for (const [id, name] of [
    [ids.team, `Home ${base}`],
    [ids.awayTeam, `Away ${base}`],
  ]) {
    insert(database, "teams", {
      id,
      league_id: ids.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  }
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: `regular-${base}`,
    sequence: 1,
    starts_at_ms: LATE_LOCK_TRIGGER_CLOCK.weekStartsAtMs,
    baseline_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    locks_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    ends_at_ms: LATE_LOCK_TRIGGER_CLOCK.weekEndsAtMs,
    rolls_over_at_ms: LATE_LOCK_TRIGGER_CLOCK.weekEndsAtMs,
    status: "live",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "matchups", {
    id: ids.matchup,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    home_team_id: ids.team,
    away_team_id: ids.awayTeam,
    home_team_name: `Home ${base}`,
    away_team_name: `Away ${base}`,
    status: "live",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  players.forEach((player, index) => {
    insert(database, "players", {
      id: player.playerId,
      first_name: "Late",
      last_name: `Player ${index}`,
      full_name: `Late Player ${index}`,
      birth_date: null,
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 1,
      version: 1,
    });
  });
  insert(database, "stat_sources", {
    id: ids.source,
    provider: statisticsProvider,
    status: "active",
    created_at_ms: 1,
    updated_at_ms: 1,
    version: 1,
  });
  insert(database, "stat_refreshes", {
    id: ids.refresh,
    stat_source_id: ids.source,
    nhl_season_key: "20992000",
    source_version: statisticsSourceVersion,
    status: "succeeded",
    started_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs - 1,
    completed_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    player_count: selectedPlayerCount,
    error_code: null,
    metadata_json: null,
    version: 1,
  });

  for (const entry of normalizedCoverage) {
    insert(database, "stat_refresh_player_game_coverage_entries", {
      id: entry.coverageEntryId,
      stat_source_id: entry.statSourceId,
      refresh_id: entry.refreshId,
      observation_set_id: entry.observationSetId,
      nhl_season_key: entry.nhlSeasonKey,
      player_id: entry.playerId,
      provider_player_id: entry.providerPlayerId,
      provider_team_id: entry.providerTeamId,
      disposition: entry.disposition,
      nhl_game_id: entry.nhlGameId,
      nhl_game_scheduled_starts_at_ms:
        entry.nhlGameScheduledStartsAtMs,
      created_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
      version: 1,
    });
  }
  for (const observation of normalizedBaselines) {
    insert(database, "player_game_stat_observations", {
      id: observation.observationId,
      stat_source_id: ids.source,
      refresh_id: observation.refreshId,
      observation_set_id: observation.observationSetId,
      nhl_season_key: "20992000",
      player_id: observation.playerId,
      nhl_game_id: observation.nhlGameId,
      nhl_game_scheduled_starts_at_ms:
        observation.nhlGameScheduledStartsAtMs,
      observed_game_state: "scheduled",
      goals: 0,
      assists: 0,
      nhl_points: 0,
      fantasy_points_hundredths: 0,
      source_updated_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
      created_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
      version: 1,
    });
  }

  const coveredPlayerCount = new Set(
    normalizedCoverage.map(({ playerId }) => playerId)
  ).size;
  insert(database, "stat_refresh_player_game_sets", {
    id: ids.playerGameSet,
    stat_source_id: ids.source,
    refresh_id: ids.refresh,
    nhl_season_key: "20992000",
    provider: statisticsProvider,
    source_version: statisticsSourceVersion,
    captured_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    required_player_count: coveredPlayerCount,
    coverage_entry_count: normalizedCoverage.length,
    expected_player_game_count: normalizedCoverage.filter(
      ({ disposition }) => disposition === "expected_game"
    ).length,
    coverage_schema_version: 1,
    coverage_sha256: "a".repeat(64),
    observation_count: normalizedBaselines.length,
    evidence_schema_version: 1,
    evidence_sha256: "b".repeat(64),
    created_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    version: 1,
  });
  insert(database, "stat_snapshots", {
    id: ids.baselineSnapshot,
    stat_source_id: ids.source,
    source_refresh_id: ids.refresh,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    intended_use: "matchup_baseline",
    completeness_status: "complete",
    freshness_status: "fresh",
    captured_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
    committed: 1,
    created_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
  });
  insert(database, "matchup_roster_locks", {
    id: ids.lock,
    league_id: ids.league,
    season_id: ids.season,
    matchup_week_id: ids.week,
    team_id: ids.team,
    lock_type: "late",
    legal: 1,
    legality_reason_code: null,
    locked_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    baseline_snapshot_id: ids.baselineSnapshot,
    source_freshness_status: "fresh",
    created_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    version: 1,
  });
  players.forEach((player, index) => {
    insert(database, "matchup_roster_players", {
      id: player.lockPlayerId,
      league_id: ids.league,
      season_id: ids.season,
      matchup_roster_lock_id: ids.lock,
      player_id: player.playerId,
      position_group: "F",
      slot_number: index + 1,
      baseline_games_played: 0,
      baseline_goals: 0,
      baseline_assists: 0,
      baseline_fantasy_points_hundredths: 0,
      created_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    });
  });

  const fixture = Object.freeze({
    base,
    ids,
    players,
    coverage: normalizedCoverage,
    baselines: normalizedBaselines,
    games: normalizedGames,
    statisticsProvider,
    statisticsSourceVersion,
    gameStateProvider,
    gameStateSourceVersion,
    gameStateObservedAtMs,
  });
  if (insertGameState) {
    insertLateLockGameState(database, fixture);
  }
  return fixture;
}

function insertLateLockGameState(database, fixture) {
  for (const game of fixture.games) {
    insert(database, "nhl_game_state_observations", {
      id: game.observationId,
      league_id: fixture.ids.league,
      season_id: fixture.ids.season,
      observation_snapshot_id: fixture.ids.gameStateSnapshot,
      nhl_game_id: game.nhlGameId,
      nhl_game_scheduled_starts_at_ms:
        game.nhlGameScheduledStartsAtMs,
      observed_game_state: game.observedGameState,
      observed_at_ms: fixture.gameStateObservedAtMs,
      created_at_ms: fixture.gameStateObservedAtMs,
      version: 1,
    });
  }
  insert(database, "nhl_game_state_observation_snapshots", {
    id: fixture.ids.gameStateSnapshot,
    league_id: fixture.ids.league,
    season_id: fixture.ids.season,
    matchup_week_id: fixture.ids.week,
    team_id: fixture.ids.team,
    provider: fixture.gameStateProvider,
    source_version: fixture.gameStateSourceVersion,
    observed_at_ms: fixture.gameStateObservedAtMs,
    freshness_status: "fresh",
    observation_count: fixture.games.length,
    evidence_schema_version: 1,
    observation_sha256: "c".repeat(64),
    created_at_ms: fixture.gameStateObservedAtMs,
    version: 1,
  });
}

function stageLateLockExclusion(
  database,
  fixture,
  {
    playerIndex = 0,
    gameIndex = 0,
    exclusionIndex = 0,
    observedGameState,
  } = {}
) {
  const player = fixture.players[playerIndex];
  const game = fixture.games[gameIndex];
  const baseline = fixture.baselines.find((observation) => {
    return observation.playerIndex === playerIndex &&
      observation.nhlGameId === game.nhlGameId &&
      observation.nhlGameScheduledStartsAtMs ===
        game.nhlGameScheduledStartsAtMs;
  });
  assert.ok(baseline, "fixture must include exact baseline observation");
  const exclusionId = uuid(fixture.base + 700 + exclusionIndex);
  insert(database, "matchup_roster_game_exclusions", {
    id: exclusionId,
    league_id: fixture.ids.league,
    season_id: fixture.ids.season,
    exclusion_set_id: fixture.ids.exclusionSet,
    matchup_week_id: fixture.ids.week,
    matchup_id: fixture.ids.matchup,
    team_id: fixture.ids.team,
    matchup_roster_lock_id: fixture.ids.lock,
    matchup_roster_player_id: player.lockPlayerId,
    player_id: player.playerId,
    observation_snapshot_id: fixture.ids.gameStateSnapshot,
    observation_id: game.observationId,
    baseline_player_game_stat_observation_id:
      baseline.observationId,
    nhl_game_id: game.nhlGameId,
    nhl_game_scheduled_starts_at_ms:
      game.nhlGameScheduledStartsAtMs,
    observed_game_state:
      observedGameState ?? game.observedGameState,
    late_snapshot_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    created_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    version: 1,
  });
  return exclusionId;
}

function insertLateLockExclusionRoot(
  database,
  fixture,
  exclusionCount
) {
  return insert(database, "matchup_roster_game_exclusion_sets", {
    id: fixture.ids.exclusionSet,
    league_id: fixture.ids.league,
    season_id: fixture.ids.season,
    matchup_week_id: fixture.ids.week,
    matchup_id: fixture.ids.matchup,
    team_id: fixture.ids.team,
    matchup_roster_lock_id: fixture.ids.lock,
    matchup_roster_lock_version: 1,
    baseline_snapshot_id: fixture.ids.baselineSnapshot,
    observation_snapshot_id: fixture.ids.gameStateSnapshot,
    late_snapshot_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    exclusion_count: exclusionCount,
    evidence_schema_version: 1,
    evidence_sha256: "d".repeat(64),
    sealed_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    created_at_ms: LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs,
    version: 1,
  });
}

describe(
  "locked Free Agent Draft decision-package amendment",
  { concurrency: false },
  () => {
    let runtime;

    before(() => {
      runtime = createRuntime();
    });

    after(() => {
      if (runtime?.database.open) runtime.database.close();
      if (runtime?.temporaryRoot) {
        fs.rmSync(runtime.temporaryRoot, {
          recursive: true,
          force: true,
        });
      }
    });

    test("applies exactly canonical migrations 0001 through 0030", () => {
      assert.equal(runtime.migrationState.status, "exact");
      assert.equal(runtime.migrationState.applied.length, 30);
      assert.equal(
        runtime.database.pragma("user_version", { simple: true }),
        30
      );
      assert.deepEqual(
        runtime.database.prepare("PRAGMA foreign_key_check").all(),
        []
      );
      assert.deepEqual(
        runtime.database.prepare("PRAGMA integrity_check").all(),
        [{ integrity_check: "ok" }]
      );
    });

    test("binds initial and extension rollover processing to the exact production running claim", (t) => {
      const { database } = createDisposableRuntime(t, {
        currentHead: true,
      });
      const fixtures = [
        { base: 15_000, sequence: 1 },
        { base: 16_000, sequence: 8 },
      ].map(({ base, sequence }) => {
        const ids = seedRawFad(database, base, "rapid");
        seedRawCurrentFadScope(database, ids);
        let rollover;
        if (sequence === 1) {
          rollover = seedRawRollover(database, ids);
        } else {
          const predecessor = seedRawRollover(database, ids, {
            sequence: 7,
            predecessorRolloverId: uuid(base + 600),
            opensAtMs:
              FIXTURE_CLOCK.candidateDeadlineAtMs +
              6 * 86_400_000,
          });
          rollover = seedRawRollover(database, ids, {
            id: ids.targetRollover,
            sequence,
            predecessorRolloverId: predecessor.id,
            opensAtMs: predecessor.rollsOverAtMs,
          });
        }
        const job = seedRawRolloverJob(
          database,
          ids,
          rollover,
          {
            status: "pending",
            attempt_count: 0,
            lease_owner: null,
            lease_expires_at_ms: null,
            started_at_ms: null,
            updated_at_ms: FIXTURE_CLOCK.openedAtMs,
            version: 1,
            lease_token: null,
          }
        );
        return { base, ids, rollover, job };
      });

      isolateTableTrigger(
        database,
        "free_agent_draft_rollovers",
        "free_agent_draft_rollovers_forward_update"
      );
      const repository =
        createSqliteFreeAgentDraftJobRepository({ database });

      for (const fixture of fixtures) {
        const claimed = repository.claim({
          leagueId: fixture.ids.league,
          seasonId: fixture.ids.season,
          fadId: fixture.ids.fad,
          runId: fixture.ids.job,
          jobType: "fad_rollover",
          occurrenceKey: fixture.job.occurrence_key,
          scheduledForMs: fixture.rollover.rollsOverAtMs,
          expectedVersion: 1,
          leaseOwner: "fad-rollover-worker",
          leaseToken: uuid(fixture.base + 700),
          nowMs: fixture.rollover.rollsOverAtMs,
          leaseExpiresAtMs:
            fixture.rollover.rollsOverAtMs + 60_000,
        });
        assert.equal(claimed.acquired, true);
        assert.equal(claimed.occurrence.status, "running");
        assert.equal(claimed.occurrence.attemptCount, 1);
        assert.equal(
          startRawRolloverProcessing(
            database,
            fixture.ids,
            fixture.rollover
          ).changes,
          1
        );
        assert.deepEqual(
          database.prepare(`
            SELECT
              status,
              processing_job_run_id,
              processing_started_at_ms,
              version
            FROM free_agent_draft_rollovers
            WHERE id = ?
          `).get(fixture.rollover.id),
          {
            status: "processing",
            processing_job_run_id: fixture.ids.job,
            processing_started_at_ms:
              fixture.rollover.rollsOverAtMs,
            version: 2,
          }
        );
      }
    });

    test("rejects every malformed rollover processing job binding and lifecycle residue", (t) => {
      const { database } = createDisposableRuntime(t);
      const cases = [
        {
          label: "wrong job type",
          overrides: () => ({ job_type: "fad_completion" }),
        },
        {
          label: "wrong occurrence key",
          overrides: ({ job }) => ({
            occurrence_key: `${job.occurrence_key}:forged`,
          }),
        },
        {
          label: "wrong FAD identity in occurrence key",
          overrides: ({ base, rollover }) => ({
            occurrence_key:
              `fad:${uuid(base + 900)}:rollover:` +
              `${rollover.sequence}:${rollover.rollsOverAtMs}`,
          }),
        },
        {
          label: "wrong league scope",
          overrides: ({ base }) => ({
            league_id: uuid(base + 901),
          }),
        },
        {
          label: "wrong season scope",
          overrides: ({ base }) => ({
            season_id: uuid(base + 902),
          }),
        },
        {
          label: "wrong scheduled instant",
          overrides: ({ rollover }) => ({
            scheduled_for_ms: rollover.rollsOverAtMs + 1,
          }),
        },
        {
          label: "leased status",
          overrides: () => ({ status: "leased" }),
        },
        {
          label: "pending status",
          overrides: () => ({ status: "pending" }),
        },
        {
          label: "missing lease owner",
          overrides: () => ({ lease_owner: null }),
        },
        {
          label: "empty lease owner",
          overrides: () => ({ lease_owner: "" }),
        },
        {
          label: "blank lease owner",
          overrides: () => ({ lease_owner: "   " }),
        },
        {
          label: "missing lease token",
          overrides: () => ({ lease_token: null }),
        },
        {
          label: "empty lease token",
          overrides: () => ({ lease_token: "" }),
        },
        {
          label: "blank lease token",
          overrides: () => ({ lease_token: "   " }),
        },
        {
          label: "zero attempts",
          overrides: () => ({ attempt_count: 0 }),
        },
        {
          label: "lease expires after rollover but before delayed processing",
          processingDelayMs: 2,
          overrides: ({ rollover }) => ({
            lease_expires_at_ms: rollover.rollsOverAtMs + 1,
          }),
        },
        {
          label: "lease expires exactly at delayed processing",
          processingDelayMs: 2,
          overrides: ({ rollover }) => ({
            lease_expires_at_ms: rollover.rollsOverAtMs + 2,
          }),
        },
        {
          label: "future started time",
          overrides: ({ rollover }) => ({
            started_at_ms: rollover.rollsOverAtMs + 1,
          }),
        },
        {
          label: "future job update time",
          overrides: ({ rollover }) => ({
            updated_at_ms: rollover.rollsOverAtMs + 1,
          }),
        },
        {
          label: "missing started time",
          overrides: () => ({ started_at_ms: null }),
        },
        {
          label: "completion residue",
          overrides: ({ rollover }) => ({
            completed_at_ms: rollover.rollsOverAtMs,
          }),
        },
        {
          label: "result residue",
          overrides: () => ({ result_json: "{}" }),
        },
        {
          label: "error residue",
          overrides: () => ({
            last_error_code: "STALE_ROLLOVER_STATE",
          }),
        },
        {
          label: "retry residue",
          overrides: ({ rollover }) => ({
            next_attempt_at_ms: rollover.rollsOverAtMs + 1,
          }),
        },
      ];
      const fixtures = cases.map((testCase, index) => {
        const base = 60_000 + index * 1_000;
        const ids = seedRawFad(database, base, "rapid");
        const rollover = seedRawRollover(database, ids);
        const canonical = {
          occurrence_key:
            `fad:${ids.fad}:rollover:${rollover.sequence}:` +
            `${rollover.rollsOverAtMs}`,
        };
        const overrides = testCase.overrides({
          base,
          ids,
          rollover,
          job: canonical,
        });
        seedRawRolloverJob(
          database,
          ids,
          rollover,
          overrides
        );
        return {
          ...testCase,
          ids,
          rollover,
          processingAtMs:
            rollover.rollsOverAtMs +
            (testCase.processingDelayMs ?? 0),
        };
      });

      isolateTableTrigger(
        database,
        "free_agent_draft_rollovers",
        "free_agent_draft_rollovers_forward_update"
      );
      for (const fixture of fixtures) {
        assert.throws(
          () =>
            startRawRolloverProcessing(
              database,
              fixture.ids,
              fixture.rollover,
              fixture.processingAtMs
            ),
          /durable terminal evidence/i,
          fixture.label
        );
        assert.deepEqual(
          database.prepare(`
            SELECT
              status,
              processing_job_run_id,
              processing_started_at_ms,
              version
            FROM free_agent_draft_rollovers
            WHERE id = ?
          `).get(fixture.rollover.id),
          {
            status: "scheduled",
            processing_job_run_id: null,
            processing_started_at_ms: null,
            version: 1,
          },
          fixture.label
        );
      }
    });

    test("installs the complete locked FAD lifecycle trigger inventory", () => {
      const expectedTriggers = [
        "candidate_card_entries_open_update",
        "candidate_card_revisions_authority_insert",
        "free_agent_draft_allocations_forward_update",
        "free_agent_drafts_allocation_completion_barrier",
        "free_agent_drafts_allocation_start_barrier",
        "free_agent_drafts_auction_completion_barrier",
        "free_agent_drafts_automatic_award_resources_barrier",
        "free_agent_drafts_deadline_allocation_barrier",
        "free_agent_drafts_deadline_completeness_update",
        "free_agent_drafts_final_completion_barrier",
        "free_agent_drafts_forward_update",
        "free_agent_drafts_resolution_job_completion_barrier",
        "free_agent_drafts_valid_insert",
      ];
      const actualTriggers = runtime.database
        .prepare(`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND name IN (${expectedTriggers.map(() => "?").join(", ")})
          ORDER BY name
        `)
        .all(...expectedTriggers)
        .map(({ name }) => name);

      assert.deepEqual(actualTriggers, [...expectedTriggers].sort());
      assert.ok(
        schemaSql(
          runtime.database,
          "index",
          "candidate_card_revisions_league_actor_time"
        )
      );

      const candidateSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "candidate_card_entries_open_update"
        )
      );
      assert.match(candidateSql, /'Injured Reserve'/i);
      assert.match(
        candidateSql,
        /NEW\.requested_slot_group\s*=\s*NEW\.effective_position_group/i
      );

      const allocationSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_draft_allocations_forward_update"
        )
      );
      for (const token of [
        "restricted_active",
        "restricted_scheduled",
        "creation_cutoff_at_ms",
      ]) {
        assert.ok(allocationSql.includes(token), `missing ${token}`);
      }

      const deadlineSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_drafts_deadline_allocation_barrier"
        )
      );
      assert.match(
        deadlineSql,
        /lease_expires_at_ms\s*>\s*NEW\.deadline_locked_at_ms/i
      );
      assert.doesNotMatch(
        deadlineSql,
        /lease_expires_at_ms\s*>=\s*NEW\.deadline_locked_at_ms/i
      );

      const readinessSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_draft_readiness_operations_forward_update"
        )
      );
      assert.match(
        readinessSql,
        /league_activity\.event_type\s*=\s*'free_agent_draft_started'/i
      );
      assert.match(
        readinessSql,
        /outbox_events\.event_type\s*=\s*'fad_cards_opened'/i
      );
      assert.match(
        readinessSql,
        /notifications\.event_type\s*=\s*'fad_cards_opened'/i
      );

      const cardColumns = tableColumns(
        runtime.database,
        "candidate_cards"
      ).map(({ name }) => name);
      const snapshotColumns = tableColumns(
        runtime.database,
        "candidate_card_snapshots"
      ).map(({ name }) => name);
      assert.ok(
        cardColumns.includes(
          "carried_roster_structural_conflict_count"
        )
      );
      assert.ok(
        snapshotColumns.includes(
          "carried_roster_structural_conflict_count"
        )
      );
      assert.match(
        compactSql(
          schemaSql(
            runtime.database,
            "table",
            "free_agent_draft_player_allocations"
          )
        ),
        /'candidate_card_structural_conflict'/i
      );
      assert.match(
        compactSql(
          schemaSql(
            runtime.database,
            "table",
            "free_agent_draft_allocation_events"
          )
        ),
        /'excluded_structural_conflict'/i
      );
    });

    test("replaces the legacy one-root finalization rule with exact schedule-generation lineage provenance", () => {
      const triggerNames = [
        "standings_snapshot_finalizations_schedule_lineage_insert_0030",
        "standings_snapshot_finalizations_initial_schedule_root_insert_0030",
        "standings_snapshot_finalizations_replacement_schedule_root_insert_0030",
      ];
      assert.equal(
        schemaSql(
          runtime.database,
          "trigger",
          "standings_snapshot_finalizations_schedule_root_insert_0028"
        ),
        undefined
      );
      for (const triggerName of triggerNames) {
        assert.ok(
          schemaSql(runtime.database, "trigger", triggerName),
          `missing ${triggerName}`
        );
      }

      const lineageSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "standings_snapshot_finalizations_schedule_lineage_insert_0030"
        )
      );
      for (const token of [
        "season_matchup_schedule_generations",
        "matchup_operations",
        "schedule_version",
        "status = 'current'",
        "status = 'superseded'",
        "week_one_matchup_week_id",
        "week_one_starts_at_ms",
      ]) {
        assert.ok(lineageSql.includes(token), `missing ${token}`);
      }

      const initialSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "standings_snapshot_finalizations_initial_schedule_root_insert_0030"
        )
      );
      for (const token of [
        "schedule_version = 1",
        "participantTeamIds",
        "matchup_schedule_command_results",
        "free_agent_draft_schedule_recoveries",
      ]) {
        assert.ok(initialSql.includes(token), `missing ${token}`);
      }
      assert.match(
        initialSql,
        /COUNT\(DISTINCT key\).*IN \(4, 5\).*COUNT\(DISTINCT key\).*COUNT\(\*\)/i
      );
      assert.match(initialSql, /WHERE COALESCE\(\(/i);

      const replacementSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "standings_snapshot_finalizations_replacement_schedule_root_insert_0030"
        )
      );
      for (const token of [
        "shift_week_one",
        "matchup_schedule_command_results",
        "fad_pre_open_schedule_recovery",
        "fad_completion_schedule_recovery",
        "free_agent_draft_schedule_recoveries",
        "operation.actor_user_id IS NULL",
      ]) {
        assert.ok(replacementSql.includes(token), `missing ${token}`);
      }
      assert.equal(
        (
          replacementSql.match(/COUNT\(DISTINCT key\)/gi) || []
        ).length,
        2
      );
      assert.equal(
        (replacementSql.match(/COALESCE\(\(/gi) || []).length,
        2
      );
    });

    test(
      "enforces carried-roster structural exclusion before independent cap state",
      (t) => {
        const { database } = createDisposableRuntime(t);
        const leagueId = uuid(60_001);
        const seasonId = uuid(60_002);
        const fadId = uuid(60_003);

        insert(database, "league_settings", {
          league_id: leagueId,
          salary_cap_cents: 1_000,
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
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });

        isolateTableTrigger(
          database,
          "candidate_cards",
          "candidate_cards_cap_state_insert"
        );

        let identity = 60_100;
        const cardValues = ({
          structuralConflictCount,
          carriedConflictCount,
          maximumPossibleCapCents,
          capStatus,
          allocationEligibility,
          allocationExclusionReason,
        }) => {
          identity += 1;
          const conflicted =
            structuralConflictCount > 0;
          return {
            id: uuid(identity),
            league_id: leagueId,
            season_id: seasonId,
            fad_id: fadId,
            team_id: uuid(identity + 1_000),
            status: "open",
            completeness_code: conflicted
              ? "conflicted"
              : "incomplete",
            filled_mandatory_count: 1,
            missing_mandatory_count: 17,
            filled_bench_count: 0,
            empty_bench_count: 4,
            blocking_validation_count: 0,
            structural_conflict_count:
              structuralConflictCount,
            carried_roster_structural_conflict_count:
              carriedConflictCount,
            maximum_possible_cap_cents:
              maximumPossibleCapCents,
            locked_at_ms: null,
            created_at_ms: 1,
            updated_at_ms: 1,
            version: 1,
            cap_status: capStatus,
            allocation_eligibility:
              allocationEligibility,
            allocation_exclusion_reason:
              allocationExclusionReason,
          };
        };

        const carriedConflictOnly = cardValues({
          structuralConflictCount: 1,
          carriedConflictCount: 1,
          maximumPossibleCapCents: 900,
          capStatus: "compliant",
          allocationEligibility:
            "excluded_structural_conflict",
          allocationExclusionReason:
            "candidate_card_structural_conflict",
        });
        const overCapOnly = cardValues({
          structuralConflictCount: 0,
          carriedConflictCount: 0,
          maximumPossibleCapCents: 1_100,
          capStatus: "over_cap",
          allocationEligibility: "excluded_over_cap",
          allocationExclusionReason:
            "candidate_card_over_cap",
        });
        const carriedConflictAndOverCap = cardValues({
          structuralConflictCount: 1,
          carriedConflictCount: 1,
          maximumPossibleCapCents: 1_100,
          capStatus: "over_cap",
          allocationEligibility:
            "excluded_structural_conflict",
          allocationExclusionReason:
            "candidate_card_structural_conflict",
        });
        const candidateConflictOnly = cardValues({
          structuralConflictCount: 1,
          carriedConflictCount: 0,
          maximumPossibleCapCents: 900,
          capStatus: "compliant",
          allocationEligibility: "eligible",
          allocationExclusionReason: null,
        });
        const incompleteCompliant = cardValues({
          structuralConflictCount: 0,
          carriedConflictCount: 0,
          maximumPossibleCapCents: 900,
          capStatus: "compliant",
          allocationEligibility: "eligible",
          allocationExclusionReason: null,
        });

        for (const card of [
          carriedConflictOnly,
          overCapOnly,
          carriedConflictAndOverCap,
          candidateConflictOnly,
          incompleteCompliant,
        ]) {
          assert.doesNotThrow(() => {
            insert(database, "candidate_cards", card);
          });
        }

        assert.equal(
          database
            .prepare(`
              SELECT cap_status, allocation_eligibility,
                     allocation_exclusion_reason
              FROM candidate_cards
              WHERE id = ?
            `)
            .get(carriedConflictAndOverCap.id)
            .allocation_eligibility,
          "excluded_structural_conflict"
        );

        const mismatches = [
          cardValues({
            structuralConflictCount: 1,
            carriedConflictCount: 1,
            maximumPossibleCapCents: 1_100,
            capStatus: "over_cap",
            allocationEligibility: "excluded_over_cap",
            allocationExclusionReason:
              "candidate_card_over_cap",
          }),
          cardValues({
            structuralConflictCount: 1,
            carriedConflictCount: 0,
            maximumPossibleCapCents: 900,
            capStatus: "compliant",
            allocationEligibility:
              "excluded_structural_conflict",
            allocationExclusionReason:
              "candidate_card_structural_conflict",
          }),
          cardValues({
            structuralConflictCount: 0,
            carriedConflictCount: 0,
            maximumPossibleCapCents: 1_100,
            capStatus: "compliant",
            allocationEligibility: "eligible",
            allocationExclusionReason: null,
          }),
          cardValues({
            structuralConflictCount: 0,
            carriedConflictCount: 1,
            maximumPossibleCapCents: 900,
            capStatus: "compliant",
            allocationEligibility:
              "excluded_structural_conflict",
            allocationExclusionReason:
              "candidate_card_structural_conflict",
          }),
        ];
        for (const mismatch of mismatches) {
          assert.throws(() => {
            insert(database, "candidate_cards", mismatch);
          });
        }

        isolateTableTrigger(
          database,
          "candidate_card_snapshots",
          "candidate_card_snapshots_cap_state_insert"
        );
        const snapshotValues = (
          card,
          {
            id,
            carriedConflictCount =
              card.carried_roster_structural_conflict_count,
            allocationEligibility =
              card.allocation_eligibility,
            allocationExclusionReason =
              card.allocation_exclusion_reason,
          }
        ) => ({
          id,
          league_id: leagueId,
          season_id: seasonId,
          fad_id: fadId,
          card_id: card.id,
          team_id: card.team_id,
          locked_card_version: 1,
          locked_status:
            card.structural_conflict_count > 0
              ? "locked_conflicted"
              : "locked_incomplete",
          completeness_code:
            card.completeness_code,
          filled_mandatory_count: 1,
          missing_mandatory_count: 17,
          filled_bench_count: 0,
          empty_bench_count: 4,
          blocking_validation_count: 0,
          structural_conflict_count:
            card.structural_conflict_count,
          carried_roster_structural_conflict_count:
            carriedConflictCount,
          cap_limit_cents: 1_000,
          carried_active_player_amount_cents: 0,
          retention_obligation_cents: 0,
          buyout_penalty_cents: 0,
          carried_cap_usage_cents: 0,
          proposed_candidate_aav_cents:
            card.maximum_possible_cap_cents,
          maximum_possible_cap_cents:
            card.maximum_possible_cap_cents,
          maximum_cap_space_cents:
            1_000 -
            card.maximum_possible_cap_cents,
          effective_deadline_at_ms: 10,
          processed_at_ms: 10,
          created_at_ms: 10,
          cap_status: card.cap_status,
          allocation_eligibility:
            allocationEligibility,
          allocation_exclusion_reason:
            allocationExclusionReason,
        });

        assert.throws(() => {
          insert(
            database,
            "candidate_card_snapshots",
            snapshotValues(
              carriedConflictAndOverCap,
              {
                id: uuid(60_500),
                carriedConflictCount: 0,
              }
            )
          );
        });
        const candidateConflictSnapshot =
          snapshotValues(candidateConflictOnly, {
            id: uuid(60_501),
          });
        const carriedConflictSnapshot =
          snapshotValues(
            carriedConflictAndOverCap,
            { id: uuid(60_502) }
          );
        assert.doesNotThrow(() => {
          insert(
            database,
            "candidate_card_snapshots",
            candidateConflictSnapshot
          );
          insert(
            database,
            "candidate_card_snapshots",
            carriedConflictSnapshot
          );
        });

        isolateTableTrigger(
          database,
          "candidate_card_snapshot_entries",
          "candidate_card_snapshot_entries_cap_state_insert"
        );
        const candidateEntry = (
          snapshot,
          card,
          id,
          allocationEligibility,
          allocationExclusionReason
        ) => ({
          id,
          league_id: leagueId,
          season_id: seasonId,
          fad_id: fadId,
          snapshot_id: snapshot.id,
          card_id: card.id,
          team_id: card.team_id,
          row_kind: "slot",
          occupant_kind: "candidate",
          slot_group: "D",
          slot_number: 1,
          source_entry_id: uuid(identity + 3_000),
          source_entry_version: 1,
          player_id: uuid(identity + 4_000),
          effective_position_group: "D",
          conflict_code: null,
          carryover_ownership_id: null,
          carryover_contract_id: null,
          source_roster_category: null,
          carryover_original_total_value_cents: null,
          carryover_original_term_years: null,
          carryover_aav_cents: null,
          remaining_years: null,
          proposed_total_value_cents: 600,
          proposed_term_years: 2,
          proposed_aav_cents: 300,
          eligibility_status: "valid",
          validation_code: null,
          last_edited_by_user_id: uuid(identity + 5_000),
          last_edited_by_membership_id:
            uuid(identity + 6_000),
          last_edited_by_authority: "manager",
          last_edited_at_ms: 9,
          created_at_ms: 10,
          allocation_eligibility:
            allocationEligibility,
          allocation_exclusion_reason:
            allocationExclusionReason,
        });

        assert.doesNotThrow(() => {
          insert(
            database,
            "candidate_card_snapshot_entries",
            candidateEntry(
              candidateConflictSnapshot,
              candidateConflictOnly,
              uuid(60_600),
              "eligible",
              null
            )
          );
          insert(
            database,
            "candidate_card_snapshot_entries",
            candidateEntry(
              carriedConflictSnapshot,
              carriedConflictAndOverCap,
              uuid(60_601),
              "excluded_structural_conflict",
              "candidate_card_structural_conflict"
            )
          );
        });
        assert.throws(() => {
          insert(
            database,
            "candidate_card_snapshot_entries",
            candidateEntry(
              candidateConflictSnapshot,
              candidateConflictOnly,
              uuid(60_602),
              "excluded_structural_conflict",
              "candidate_card_structural_conflict"
            )
          );
        });

        const updateGuard = compactSql(
          schemaSql(
            runtime.database,
            "trigger",
            "candidate_cards_cap_state_update"
          )
        );
        assert.ok(
          updateGuard.includes(
            "carried_roster_structural_conflict_count"
          )
        );
        assert.ok(
          updateGuard.includes(
            "structural_conflict_count"
          )
        );
      }
    );

    test(
      "maps distinct nonzero total and carried-roster conflict counts from published Candidate history",
      (t) => {
        const { database } = createDisposableRuntime(t, {
          currentHead: true,
        });
        const base = 60_700;
        const ids = seedRawFad(
          database,
          base,
          "deadline_locked"
        );
        const snapshotId = uuid(base + 31);
        const viewerUserId = uuid(base + 32);
        const viewerMembershipId =
          uuid(base + 33);
        const processedAtMs =
          FIXTURE_CLOCK.candidateDeadlineAtMs +
          10;

        insert(database, "users", {
          id: viewerUserId,
          email_normalized:
            "published-candidate-viewer@example.test",
          email_display:
            "published-candidate-viewer@example.test",
          display_name:
            "Published Candidate Viewer",
          display_name_normalized:
            "published candidate viewer",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        insert(database, "league_memberships", {
          id: viewerMembershipId,
          league_id: ids.league,
          user_id: viewerUserId,
          permission_category: "manager",
          status: "active",
          joined_at_ms: 1,
          ended_at_ms: null,
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        dropInsertTriggers(
          database,
          "candidate_cards"
        );
        insert(database, "candidate_cards", {
          id: ids.cardOne,
          league_id: ids.league,
          season_id: ids.season,
          fad_id: ids.fad,
          team_id: ids.teamOne,
          status: "locked_conflicted",
          completeness_code: "conflicted",
          filled_mandatory_count: 0,
          missing_mandatory_count: 18,
          filled_bench_count: 0,
          empty_bench_count: 4,
          blocking_validation_count: 1,
          structural_conflict_count: 2,
          carried_roster_structural_conflict_count:
            1,
          maximum_possible_cap_cents: 0,
          locked_at_ms:
            FIXTURE_CLOCK.candidateDeadlineAtMs,
          created_at_ms: FIXTURE_CLOCK.openedAtMs,
          updated_at_ms: processedAtMs,
          version: 2,
          cap_status: "compliant",
          allocation_eligibility:
            "excluded_structural_conflict",
          allocation_exclusion_reason:
            "candidate_card_structural_conflict",
        });
        dropInsertTriggers(
          database,
          "candidate_card_snapshots"
        );
        insert(
          database,
          "candidate_card_snapshots",
          {
            id: snapshotId,
            league_id: ids.league,
            season_id: ids.season,
            fad_id: ids.fad,
            card_id: ids.cardOne,
            team_id: ids.teamOne,
            locked_card_version: 2,
            locked_status: "locked_conflicted",
            completeness_code: "conflicted",
            filled_mandatory_count: 0,
            missing_mandatory_count: 18,
            filled_bench_count: 0,
            empty_bench_count: 4,
            blocking_validation_count: 1,
            structural_conflict_count: 2,
            carried_roster_structural_conflict_count:
              1,
            cap_limit_cents: 1_000,
            carried_active_player_amount_cents:
              0,
            retention_obligation_cents: 0,
            buyout_penalty_cents: 0,
            carried_cap_usage_cents: 0,
            proposed_candidate_aav_cents: 0,
            maximum_possible_cap_cents: 0,
            maximum_cap_space_cents: 1_000,
            effective_deadline_at_ms:
              FIXTURE_CLOCK.candidateDeadlineAtMs,
            processed_at_ms: processedAtMs,
            created_at_ms: processedAtMs,
            cap_status: "compliant",
            allocation_eligibility:
              "excluded_structural_conflict",
            allocation_exclusion_reason:
              "candidate_card_structural_conflict",
          }
        );
        dropInsertTriggers(
          database,
          "candidate_card_snapshot_entries"
        );
        const slots = [
          ...Array.from(
            { length: 12 },
            (_, index) => ["F", index + 1]
          ),
          ...Array.from(
            { length: 6 },
            (_, index) => ["D", index + 1]
          ),
          ...Array.from(
            { length: 4 },
            (_, index) => ["B", index + 1]
          ),
        ];
        slots.forEach(
          ([slotGroup, slotNumber], index) => {
            insert(
              database,
              "candidate_card_snapshot_entries",
              {
                id: uuid(base + 100 + index),
                league_id: ids.league,
                season_id: ids.season,
                fad_id: ids.fad,
                snapshot_id: snapshotId,
                card_id: ids.cardOne,
                team_id: ids.teamOne,
                row_kind: "slot",
                occupant_kind: "empty",
                slot_group: slotGroup,
                slot_number: slotNumber,
                created_at_ms: processedAtMs,
                allocation_eligibility: null,
                allocation_exclusion_reason:
                  null,
              }
            );
          }
        );
        insert(
          database,
          "candidate_card_snapshot_entries",
          {
            id: uuid(base + 200),
            league_id: ids.league,
            season_id: ids.season,
            fad_id: ids.fad,
            snapshot_id: snapshotId,
            card_id: ids.cardOne,
            team_id: ids.teamOne,
            row_kind: "conflict",
            occupant_kind: "candidate",
            slot_group: "F",
            slot_number: 1,
            source_entry_id: uuid(base + 300),
            source_entry_version: 2,
            player_id: uuid(base + 301),
            effective_position_group: "F",
            conflict_code:
              "CANDIDATE_SLOT_CLAIMED_BY_CARRYOVER",
            proposed_total_value_cents: 600,
            proposed_term_years: 2,
            proposed_aav_cents: 300,
            eligibility_status: "invalid",
            validation_code:
              "CANDIDATE_SLOT_CLAIMED_BY_CARRYOVER",
            last_edited_by_authority: "system",
            last_edited_at_ms: processedAtMs,
            created_at_ms: processedAtMs,
            allocation_eligibility:
              "excluded_structural_conflict",
            allocation_exclusion_reason:
              "candidate_card_structural_conflict",
          }
        );
        insert(
          database,
          "candidate_card_snapshot_entries",
          {
            id: uuid(base + 201),
            league_id: ids.league,
            season_id: ids.season,
            fad_id: ids.fad,
            snapshot_id: snapshotId,
            card_id: ids.cardOne,
            team_id: ids.teamOne,
            row_kind: "conflict",
            occupant_kind: "carryover",
            slot_group: "F",
            slot_number: 2,
            source_entry_id: uuid(base + 302),
            source_entry_version: 1,
            player_id: uuid(base + 303),
            effective_position_group: "F",
            conflict_code:
              "CARRYOVER_SLOT_OVERFLOW",
            carryover_ownership_id:
              uuid(base + 304),
            carryover_contract_id:
              uuid(base + 305),
            source_roster_category: "Active",
            carryover_original_total_value_cents:
              300,
            carryover_original_term_years: 3,
            carryover_aav_cents: 100,
            remaining_years: 1,
            last_edited_by_authority: "system",
            last_edited_at_ms: processedAtMs,
            created_at_ms: processedAtMs,
            allocation_eligibility: null,
            allocation_exclusion_reason:
              null,
          }
        );

        const repository =
          createSqliteCandidateCardRepository({
            database,
            writeMutationSideEffects() {},
            writeHelpGrantSideEffects() {},
          });
        const published = repository.readPublished({
          scope: {
            leagueId: ids.league,
            seasonId: ids.season,
            fadId: ids.fad,
            cardId: ids.cardOne,
            teamId: ids.teamOne,
          },
          viewer: {
            userId: viewerUserId,
            membershipId: viewerMembershipId,
          },
        });

        assert.ok(published);
        assert.deepEqual(published.completeness, {
          code: "conflicted",
          filledMandatoryCount: 0,
          missingMandatoryCount: 18,
          filledBenchCount: 0,
          emptyBenchCount: 4,
          blockingValidationCount: 1,
          structuralConflictCount: 2,
          carriedRosterStructuralConflictCount: 1,
        });
      }
    );

    test(
      "snapshots an invalid Candidate conflict with the complete blocking-validation count",
      (t) => {
        const { database } = createDisposableRuntime(t);
        const base = 61_000;
        const ids = seedRawFad(database, base);
        const entryId = uuid(base + 31);
        const snapshotId = uuid(base + 32);

        insert(database, "league_settings", {
          league_id: ids.league,
          salary_cap_cents: 1_000,
          trade_deadline_at_ms: null,
          maximum_teams: 10,
          active_forward_slots: 12,
          active_defence_slots: 6,
          bench_slots: 4,
          maximum_bench_aav_cents: 400,
          injured_reserve_slots: 4,
          prospect_slots_unlimited: 1,
          scoring_rule_version: 1,
          standings_rule_version: 1,
          created_at_ms: 1,
          updated_at_ms: 1,
          version: 1,
        });
        dropInsertTriggers(database, "candidate_cards");
        dropInsertTriggers(
          database,
          "candidate_card_entries"
        );
        insert(database, "candidate_cards", {
          id: ids.cardOne,
          league_id: ids.league,
          season_id: ids.season,
          fad_id: ids.fad,
          team_id: ids.teamOne,
          status: "locked_conflicted",
          completeness_code: "conflicted",
          filled_mandatory_count: 0,
          missing_mandatory_count: 18,
          filled_bench_count: 0,
          empty_bench_count: 4,
          blocking_validation_count: 1,
          structural_conflict_count: 1,
          carried_roster_structural_conflict_count: 0,
          maximum_possible_cap_cents: 0,
          locked_at_ms:
            FIXTURE_CLOCK.candidateDeadlineAtMs,
          created_at_ms: FIXTURE_CLOCK.openedAtMs,
          updated_at_ms:
            FIXTURE_CLOCK.candidateDeadlineAtMs,
          version: 2,
          cap_status: "compliant",
          allocation_eligibility: "eligible",
          allocation_exclusion_reason: null,
        });
        insert(database, "candidate_card_entries", {
          id: entryId,
          league_id: ids.league,
          season_id: ids.season,
          fad_id: ids.fad,
          card_id: ids.cardOne,
          team_id: ids.teamOne,
          entry_kind: "candidate",
          player_id: ids.player,
          effective_position_group: "F",
          requested_slot_group: "F",
          requested_slot_number: 1,
          placement_state: "conflict",
          conflict_code: "CANDIDATE_POSITION_CHANGED",
          carryover_ownership_id: null,
          carryover_contract_id: null,
          source_roster_category: null,
          carryover_original_total_value_cents: null,
          carryover_original_term_years: null,
          carryover_aav_cents: null,
          remaining_years: null,
          proposed_total_value_cents: 600,
          proposed_term_years: 2,
          proposed_aav_cents: 300,
          eligibility_status: "invalid",
          validation_code: "CANDIDATE_POSITION_CHANGED",
          last_acknowledgement_revision_id: null,
          created_by_user_id: ids.userOne,
          created_by_membership_id: ids.membershipOne,
          created_by_authority: "manager",
          last_edited_by_user_id: ids.userOne,
          last_edited_by_membership_id: ids.membershipOne,
          last_edited_by_authority: "manager",
          created_at_ms: FIXTURE_CLOCK.openedAtMs,
          updated_at_ms:
            FIXTURE_CLOCK.candidateDeadlineAtMs,
          version: 2,
        });
        isolateTableTrigger(
          database,
          "candidate_card_snapshots",
          "candidate_card_snapshots_locked_insert"
        );

        assert.doesNotThrow(() => {
          insert(database, "candidate_card_snapshots", {
            id: snapshotId,
            league_id: ids.league,
            season_id: ids.season,
            fad_id: ids.fad,
            card_id: ids.cardOne,
            team_id: ids.teamOne,
            locked_card_version: 2,
            locked_status: "locked_conflicted",
            completeness_code: "conflicted",
            filled_mandatory_count: 0,
            missing_mandatory_count: 18,
            filled_bench_count: 0,
            empty_bench_count: 4,
            blocking_validation_count: 1,
            structural_conflict_count: 1,
            carried_roster_structural_conflict_count: 0,
            cap_limit_cents: 1_000,
            carried_active_player_amount_cents: 0,
            retention_obligation_cents: 0,
            buyout_penalty_cents: 0,
            carried_cap_usage_cents: 0,
            proposed_candidate_aav_cents: 0,
            maximum_possible_cap_cents: 0,
            maximum_cap_space_cents: 1_000,
            effective_deadline_at_ms:
              FIXTURE_CLOCK.candidateDeadlineAtMs,
            processed_at_ms:
              FIXTURE_CLOCK.candidateDeadlineAtMs + 1,
            created_at_ms:
              FIXTURE_CLOCK.candidateDeadlineAtMs + 1,
            cap_status: "compliant",
            allocation_eligibility: "eligible",
            allocation_exclusion_reason: null,
          });
        });
      }
    );

    test("keeps an Active carryover valid through IR and back to Active", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 10_000;
      const ids = seedRawFad(database, base);
      const carryover = seedRawCandidateCarryover(
        database,
        ids,
        base
      );

      const moveCarryover = (rosterCategory, atMs) => {
        database.transaction(() => {
          database
            .prepare(`
              UPDATE player_ownerships
              SET roster_category = ?,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `)
            .run(rosterCategory, atMs, carryover.ownershipId);
          database
            .prepare(`
              UPDATE candidate_card_entries
              SET source_roster_category = ?,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `)
            .run(rosterCategory, atMs, carryover.entryId);
        })();
      };

      assert.doesNotThrow(() => {
        moveCarryover(
          "Injured Reserve",
          FIXTURE_CLOCK.openedAtMs + 10
        );
      });
      assert.deepEqual(
        database
          .prepare(`
            SELECT source_roster_category, requested_slot_group,
                   effective_position_group, version
            FROM candidate_card_entries
            WHERE id = ?
          `)
          .get(carryover.entryId),
        {
          source_roster_category: "Injured Reserve",
          requested_slot_group: "F",
          effective_position_group: "F",
          version: 2,
        }
      );

      assert.doesNotThrow(() => {
        moveCarryover("Active", FIXTURE_CLOCK.openedAtMs + 20);
      });
      assert.deepEqual(
        database
          .prepare(`
            SELECT source_roster_category, requested_slot_group,
                   effective_position_group, version
            FROM candidate_card_entries
            WHERE id = ?
          `)
          .get(carryover.entryId),
        {
          source_roster_category: "Active",
          requested_slot_group: "F",
          effective_position_group: "F",
          version: 3,
        }
      );
    });

    test("persists conflict-only, over-cap-only, both-illegalities, and conflict-free Candidate Card allocation states with structural precedence", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 10_500;
      const ids = seedRawFad(database, base);
      seedRawCandidateCarryover(database, ids, base);
      insert(database, "league_settings", {
        league_id: ids.league,
        salary_cap_cents: 1_000,
        trade_deadline_at_ms: null,
        maximum_teams: 10,
        active_forward_slots: 12,
        active_defence_slots: 6,
        bench_slots: 4,
        maximum_bench_aav_cents: 400,
        injured_reserve_slots: 4,
        prospect_slots_unlimited: 1,
        scoring_rule_version: 1,
        standings_rule_version: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
        version: 1,
      });
      isolateTableTrigger(
        database,
        "candidate_cards",
        "candidate_cards_cap_state_update"
      );

      const updateState = ({
        completenessCode,
        structuralConflictCount,
        carriedRosterStructuralConflictCount,
        maximumPossibleCapCents,
        capStatus,
        allocationEligibility,
        allocationExclusionReason,
      }) =>
        database
          .prepare(`
            UPDATE candidate_cards
            SET completeness_code = ?,
                structural_conflict_count = ?,
                carried_roster_structural_conflict_count = ?,
                maximum_possible_cap_cents = ?,
                cap_status = ?,
                allocation_eligibility = ?,
                allocation_exclusion_reason = ?,
                updated_at_ms = updated_at_ms + 1,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            completenessCode,
            structuralConflictCount,
            carriedRosterStructuralConflictCount,
            maximumPossibleCapCents,
            capStatus,
            allocationEligibility,
            allocationExclusionReason,
            ids.cardOne
          );
      const readState = () =>
        database
          .prepare(`
            SELECT structural_conflict_count AS structuralConflictCount,
                   carried_roster_structural_conflict_count AS carriedRosterStructuralConflictCount,
                   completeness_code AS completenessCode,
                   maximum_possible_cap_cents AS maximumPossibleCapCents,
                   cap_status AS capStatus,
                   allocation_eligibility AS allocationEligibility,
                   allocation_exclusion_reason AS allocationExclusionReason
            FROM candidate_cards
            WHERE id = ?
          `)
          .get(ids.cardOne);
      const fixtures = [
        {
          name: "conflict-only",
          completenessCode: "conflicted",
          structuralConflictCount: 1,
          carriedRosterStructuralConflictCount: 1,
          maximumPossibleCapCents: 900,
          capStatus: "compliant",
          allocationEligibility:
            "excluded_structural_conflict",
          allocationExclusionReason:
            "candidate_card_structural_conflict",
        },
        {
          name: "both-illegalities",
          completenessCode: "conflicted",
          structuralConflictCount: 1,
          carriedRosterStructuralConflictCount: 1,
          maximumPossibleCapCents: 1_100,
          capStatus: "over_cap",
          allocationEligibility:
            "excluded_structural_conflict",
          allocationExclusionReason:
            "candidate_card_structural_conflict",
        },
        {
          name: "over-cap-only",
          completenessCode: "incomplete",
          structuralConflictCount: 0,
          carriedRosterStructuralConflictCount: 0,
          maximumPossibleCapCents: 1_100,
          capStatus: "over_cap",
          allocationEligibility:
            "excluded_over_cap",
          allocationExclusionReason:
            "candidate_card_over_cap",
        },
        {
          name: "conflict-free-incomplete",
          completenessCode: "incomplete",
          structuralConflictCount: 0,
          carriedRosterStructuralConflictCount: 0,
          maximumPossibleCapCents: 900,
          capStatus: "compliant",
          allocationEligibility: "eligible",
          allocationExclusionReason: null,
        },
      ];

      for (const fixture of fixtures) {
        assert.doesNotThrow(
          () => updateState(fixture),
          fixture.name
        );
        assert.deepEqual(
          readState(),
          {
            completenessCode:
              fixture.completenessCode,
            structuralConflictCount:
              fixture.structuralConflictCount,
            carriedRosterStructuralConflictCount:
              fixture.carriedRosterStructuralConflictCount,
            maximumPossibleCapCents:
              fixture.maximumPossibleCapCents,
            capStatus: fixture.capStatus,
            allocationEligibility:
              fixture.allocationEligibility,
            allocationExclusionReason:
              fixture.allocationExclusionReason,
          },
          fixture.name
        );
      }

      const beforeInvalid = readState();
      assert.throws(
        () =>
          updateState({
            completenessCode: "conflicted",
            structuralConflictCount: 1,
            carriedRosterStructuralConflictCount: 1,
            maximumPossibleCapCents: 1_100,
            capStatus: "over_cap",
            allocationEligibility:
              "excluded_over_cap",
            allocationExclusionReason:
              "candidate_card_over_cap",
          }),
        /Candidate Card cap eligibility is whole-card state/i
      );
      assert.deepEqual(readState(), beforeInvalid);
    });

    test(
      "retains warning diagnostics but rejects Candidate illegality acknowledgement control",
      (t) => {
        const { database } = createDisposableRuntime(t);
        const base = 10_800;
        const ids = seedRawFad(database, base);
        const carryover = seedRawCandidateCarryover(
          database,
          ids,
          base
        );
        dropInsertTriggers(
          database,
          "candidate_card_revisions"
        );

        const revision = {
          id: ids.revisionOne,
          league_id: ids.league,
          season_id: ids.season,
          fad_id: ids.fad,
          card_id: ids.cardOne,
          team_id: ids.teamOne,
          resulting_card_version: 1,
          action: "candidate_added",
          affected_entry_id: carryover.entryId,
          player_id: ids.player,
          actor_user_id: ids.userOne,
          actor_membership_id: ids.membershipOne,
          actor_authority: "manager",
          before_evidence_json: "{}",
          after_evidence_json: "{}",
          potential_illegality_acknowledged: 0,
          warning_codes_json:
            '["ROSTER_WARNING"]',
          occurred_at_ms:
            FIXTURE_CLOCK.openedAtMs + 1,
          created_at_ms:
            FIXTURE_CLOCK.openedAtMs + 1,
          version: 1,
        };
        assert.doesNotThrow(() => {
          insert(
            database,
            "candidate_card_revisions",
            revision
          );
        });
        assert.throws(
          () => {
            insert(
              database,
              "candidate_card_revisions",
              {
                ...revision,
                id: ids.revisionTwo,
                potential_illegality_acknowledged: 1,
              }
            );
          },
          /potential_illegality_acknowledged/i
        );
      }
    );

    test("rejects system attribution for a manager Candidate action", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 11_000;
      const ids = seedRawFad(database, base);
      const carryover = seedRawCandidateCarryover(
        database,
        ids,
        base
      );
      isolateTableTrigger(
        database,
        "candidate_card_revisions",
        "candidate_card_revisions_authority_insert"
      );

      assert.throws(
        () => {
          insert(database, "candidate_card_revisions", {
            id: ids.revisionOne,
            league_id: ids.league,
            season_id: ids.season,
            fad_id: ids.fad,
            card_id: ids.cardOne,
            team_id: ids.teamOne,
            resulting_card_version: 1,
            action: "candidate_added",
            affected_entry_id: carryover.entryId,
            player_id: ids.player,
            actor_user_id: null,
            actor_membership_id: null,
            actor_authority: "system",
            before_evidence_json: "{}",
            after_evidence_json: "{}",
            potential_illegality_acknowledged: 0,
            warning_codes_json: "[]",
            occurred_at_ms: FIXTURE_CLOCK.openedAtMs + 1,
            created_at_ms: FIXTURE_CLOCK.openedAtMs + 1,
            version: 1,
          });
        },
        /system cannot perform a manager Candidate action/i
      );
    });

    test("rejects incomplete work at every restored FAD root barrier", (t) => {
      const exercise = ({
        base,
        sourceStatus,
        triggerName,
        targetStatus,
        atMs,
        expected,
        arrange = () => {},
      }) => {
        const { database } = createDisposableRuntime(t);
        const ids = seedRawFad(database, base, sourceStatus);
        isolateTableTrigger(
          database,
          "free_agent_drafts",
          triggerName
        );
        arrange(database, ids, base);
        assert.throws(
          () => transitionFad(database, ids, targetStatus, atMs),
          expected,
          triggerName
        );
      };

      exercise({
        base: 20_000,
        sourceStatus: "cards_open",
        triggerName: "free_agent_drafts_deadline_completeness_update",
        targetStatus: "deadline_locked",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 10,
        expected: /committed frozen participants/i,
      });
      exercise({
        base: 21_000,
        sourceStatus: "cards_open",
        triggerName: "free_agent_drafts_deadline_allocation_barrier",
        targetStatus: "deadline_locked",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 10,
        expected: /exactly seven rapid rollovers/i,
      });
      exercise({
        base: 22_000,
        sourceStatus: "deadline_locked",
        triggerName: "free_agent_drafts_allocation_start_barrier",
        targetStatus: "allocating",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 20,
        expected: /must enter rapid directly/i,
      });
      exercise({
        base: 23_000,
        sourceStatus: "allocating",
        triggerName: "free_agent_drafts_allocation_completion_barrier",
        targetStatus: "rapid",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 30,
        expected: /current evidence for every allocation and offer/i,
        arrange(database, ids) {
          seedRawAllocation(database, ids);
        },
      });
      exercise({
        base: 24_000,
        sourceStatus: "allocating",
        triggerName: "free_agent_drafts_automatic_award_resources_barrier",
        targetStatus: "rapid",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 30,
        expected: /durable automatic-award resources/i,
        arrange(database, ids) {
          seedRawAllocation(database, ids, {
            status: "automatic_award",
            decisionCode: "sole_valid_offer",
          });
        },
      });
      exercise({
        base: 25_000,
        sourceStatus: "rapid",
        triggerName: "free_agent_drafts_auction_completion_barrier",
        targetStatus: "completed",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 86_400_020,
        expected: /every FAD auction to be terminal and accounted/i,
        arrange(database, ids) {
          const rollover = seedRawRollover(database, ids);
          seedRawAuction(database, ids, {
            openedAtMs: rollover.opensAtMs,
            resolvesAtMs: rollover.rollsOverAtMs,
          });
          seedRawAuctionContext(database, ids, {
            createdAtMs: rollover.opensAtMs,
          });
        },
      });
      exercise({
        base: 26_000,
        sourceStatus: "rapid",
        triggerName: "free_agent_drafts_final_completion_barrier",
        targetStatus: "completed",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 40,
        expected: /seven initial and every contiguous extension rollover/i,
      });
      exercise({
        base: 27_000,
        sourceStatus: "rapid",
        triggerName: "free_agent_drafts_resolution_job_completion_barrier",
        targetStatus: "completed",
        atMs: FIXTURE_CLOCK.candidateDeadlineAtMs + 86_400_020,
        expected: /each semantic auction job to succeed/i,
        arrange(database, ids) {
          const rollover = seedRawRollover(database, ids);
          seedRawAuction(database, ids, {
            status: "no_winner",
            openedAtMs: rollover.opensAtMs,
            resolvesAtMs: rollover.rollsOverAtMs,
          });
          seedRawAuctionContext(database, ids, {
            createdAtMs: rollover.opensAtMs,
          });
          seedRawResolution(database, ids, {
            resolvesAtMs: rollover.rollsOverAtMs,
          });
        },
      });
    });

    test("treats exact deadline lease expiry as inactive", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 28_000;
      const ids = seedRawFad(database, base);
      isolateTableTrigger(
        database,
        "free_agent_drafts",
        "free_agent_drafts_deadline_allocation_barrier"
      );
      const rollovers = seedSevenRawRollovers(database, ids, base, {
        withJobs: true,
      });
      seedRawJob(database, ids, {
        id: uuid(base + 300),
        jobType: "fad_deadline_reminder",
        occurrenceKey:
          `fad:${ids.fad}:reminder:` +
          `${FIXTURE_CLOCK.candidateDeadlineAtMs - 259_200_000}`,
        scheduledForMs:
          FIXTURE_CLOCK.candidateDeadlineAtMs - 259_200_000,
      });
      seedRawJob(database, ids, {
        id: ids.job,
        jobType: "fad_deadline",
        occurrenceKey:
          `fad:${ids.fad}:deadline:` +
          `${FIXTURE_CLOCK.candidateDeadlineAtMs}`,
        scheduledForMs: FIXTURE_CLOCK.candidateDeadlineAtMs,
        status: "running",
        leaseExpiresAtMs:
          FIXTURE_CLOCK.candidateDeadlineAtMs + 10,
      });

      assert.equal(rollovers.length, 7);
      assert.throws(
        () =>
          transitionFad(
            database,
            ids,
            "deadline_locked",
            FIXTURE_CLOCK.candidateDeadlineAtMs + 10
          ),
        /exact deadline occurrence/i
      );

      dropUpdateTriggers(database, "job_runs");
      database
        .prepare(`
          UPDATE job_runs
          SET lease_expires_at_ms = lease_expires_at_ms + 1
          WHERE id = ?
        `)
        .run(ids.job);

      assert.doesNotThrow(() => {
        transitionFad(
          database,
          ids,
          "deadline_locked",
          FIXTURE_CLOCK.candidateDeadlineAtMs + 10
        );
      });
    });

    test("requires allocations for the exact Candidate snapshot player set", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 28_500;
      const ids = seedRawFad(database, base);
      const mismatchedIds = {
        ...ids,
        allocation: uuid(base + 400),
        player: uuid(base + 401),
      };

      isolateTableTrigger(
        database,
        "free_agent_drafts",
        "free_agent_drafts_deadline_allocation_barrier"
      );
      seedRawTieSnapshots(database, ids);
      seedRawAllocation(database, mismatchedIds);
      seedSevenRawRollovers(database, ids, base, {
        withJobs: true,
      });
      seedRawJob(database, ids, {
        id: uuid(base + 300),
        jobType: "fad_deadline_reminder",
        occurrenceKey:
          `fad:${ids.fad}:reminder:` +
          `${FIXTURE_CLOCK.candidateDeadlineAtMs - 259_200_000}`,
        scheduledForMs:
          FIXTURE_CLOCK.candidateDeadlineAtMs - 259_200_000,
      });
      seedRawJob(database, ids, {
        id: ids.job,
        jobType: "fad_deadline",
        occurrenceKey:
          `fad:${ids.fad}:deadline:` +
          `${FIXTURE_CLOCK.candidateDeadlineAtMs}`,
        scheduledForMs: FIXTURE_CLOCK.candidateDeadlineAtMs,
        status: "running",
        leaseExpiresAtMs:
          FIXTURE_CLOCK.candidateDeadlineAtMs + 11,
      });
      seedRawJob(database, ids, {
        id: uuid(base + 301),
        jobType: "fad_allocation",
        occurrenceKey:
          `fad:${ids.fad}:allocate:${mismatchedIds.player}`,
        scheduledForMs: FIXTURE_CLOCK.candidateDeadlineAtMs,
      });

      assert.throws(
        () =>
          transitionFad(
            database,
            ids,
            "deadline_locked",
            FIXTURE_CLOCK.candidateDeadlineAtMs + 10
          ),
        /exact Candidate snapshot player set/i
      );
    });

    test("activates a direct restricted tie only before the cutoff", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 30_000;
      const ids = seedRawFad(database, base, "allocating");
      seedRawAllocation(database, ids);
      isolateTableTrigger(
        database,
        "free_agent_draft_player_allocations",
        "free_agent_draft_allocations_forward_update"
      );
      const rollover = seedRawRollover(database, ids);
      const openedAtMs = rollover.creationCutoffAtMs - 1;
      seedRawAuction(database, ids, {
        openedAtMs,
        resolvesAtMs: rollover.rollsOverAtMs,
      });

      assert.doesNotThrow(() => {
        transitionPendingAllocationToRestricted(database, ids, {
          status: "restricted_active",
          auctionId: ids.auction,
          atMs: openedAtMs,
        });
      });
      assert.deepEqual(
        database
          .prepare(`
            SELECT status, decision_code, restricted_auction_id,
                   restricted_minimum_total_cents,
                   restricted_minimum_term_years,
                   restricted_minimum_aav_cents, version
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(ids.allocation),
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: ids.auction,
          restricted_minimum_total_cents: 600,
          restricted_minimum_term_years: 2,
          restricted_minimum_aav_cents: 300,
          version: 2,
        }
      );
    });

    test("allows only scheduled restricted creation at or after cutoff", (t) => {
      {
        const { database } = createDisposableRuntime(t);
        const base = 31_000;
        const ids = seedRawFad(database, base, "allocating");
        seedRawAllocation(database, ids);
        isolateTableTrigger(
          database,
          "free_agent_draft_player_allocations",
          "free_agent_draft_allocations_forward_update"
        );
        const rollover = seedRawRollover(database, ids);
        seedRawAuction(database, ids, {
          openedAtMs: rollover.creationCutoffAtMs,
          resolvesAtMs: rollover.rollsOverAtMs,
        });

        assert.throws(
          () => {
            transitionPendingAllocationToRestricted(database, ids, {
              status: "restricted_active",
              auctionId: ids.auction,
              atMs: rollover.creationCutoffAtMs,
            });
          },
          /automatic, restricted, fallback, or quarantine state/i
        );
      }

      {
        const { database } = createDisposableRuntime(t);
        const base = 32_000;
        const ids = seedRawFad(database, base, "allocating");
        seedRawAllocation(database, ids);
        isolateTableTrigger(
          database,
          "free_agent_draft_player_allocations",
          "free_agent_draft_allocations_forward_update"
        );
        const current = seedRawRollover(database, ids);
        const target = seedRawRollover(database, ids, {
          id: ids.targetRollover,
          sequence: 2,
          predecessorRolloverId: current.id,
          opensAtMs: current.rollsOverAtMs,
        });
        seedRawAuction(database, ids, {
          openedAtMs: target.opensAtMs,
          resolvesAtMs: target.rollsOverAtMs,
        });

        assert.doesNotThrow(() => {
          transitionPendingAllocationToRestricted(database, ids, {
            status: "restricted_scheduled",
            auctionId: ids.auction,
            atMs: current.creationCutoffAtMs,
          });
        });
        assert.equal(
          database
            .prepare(`
              SELECT status
              FROM free_agent_draft_player_allocations
              WHERE id = ?
            `)
            .get(ids.allocation).status,
          "restricted_scheduled"
        );
      }
    });

    test("enforces total-first AAV-second ranking while immediate ties need no activation job", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 33_000;
      const ids = seedRawFad(database, base, "allocating");
      isolateTableTrigger(
        database,
        "free_agent_drafts",
        "free_agent_drafts_allocation_completion_barrier"
      );
      const rollover = seedRawRollover(database, ids);
      const openedAtMs = rollover.creationCutoffAtMs - 1;
      seedRawAuction(database, ids, {
        openedAtMs,
        resolvesAtMs: rollover.rollsOverAtMs,
      });
      seedRawAllocation(database, ids, {
        status: "restricted_active",
        decisionCode: "exact_total_and_term_tie",
        updatedAtMs: openedAtMs,
        auctionId: ids.auction,
      });
      seedRawTieSnapshots(database, ids, {
        secondTermYears: 3,
      });
      seedRawRestrictedAllocationEvents(database, ids, {
        status: "restricted_active",
        auctionId: ids.auction,
        occurredAtMs: openedAtMs,
      });
      seedRawRestrictedResources(database, ids, {
        rolloverId: rollover.id,
        openedAtMs,
      });

      assert.throws(
        () =>
          transitionFad(database, ids, "rapid", openedAtMs + 1),
        /deterministic total-first and AAV-second evidence/i
      );

      dropUpdateTriggers(database, "candidate_card_snapshot_entries");
      database
        .prepare(`
          UPDATE candidate_card_snapshot_entries
          SET proposed_term_years = 2,
              proposed_aav_cents = 300
          WHERE id = ?
        `)
        .run(ids.entryTwo);

      assert.doesNotThrow(() => {
        transitionFad(database, ids, "rapid", openedAtMs + 1);
      });
      assert.equal(
        database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM job_runs
            WHERE league_id = ?
              AND job_type = 'fad_restricted_activation'
          `)
          .get(ids.league).count,
        0
      );
    });

    test("requires the exact pending activation job for a scheduled restricted tie", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 34_000;
      const ids = seedRawFad(database, base, "allocating");
      isolateTableTrigger(
        database,
        "free_agent_drafts",
        "free_agent_drafts_allocation_completion_barrier"
      );
      const current = seedRawRollover(database, ids);
      const target = seedRawRollover(database, ids, {
        id: ids.targetRollover,
        sequence: 2,
        predecessorRolloverId: current.id,
        opensAtMs: current.rollsOverAtMs,
      });
      const decisionAtMs = current.creationCutoffAtMs;
      seedRawAuction(database, ids, {
        openedAtMs: target.opensAtMs,
        resolvesAtMs: target.rollsOverAtMs,
      });
      seedRawAllocation(database, ids, {
        status: "restricted_scheduled",
        decisionCode: "exact_total_and_term_tie",
        updatedAtMs: decisionAtMs,
        auctionId: ids.auction,
      });
      seedRawTieSnapshots(database, ids);
      seedRawRestrictedAllocationEvents(database, ids, {
        status: "restricted_scheduled",
        auctionId: ids.auction,
        occurredAtMs: decisionAtMs,
      });
      seedRawRestrictedResources(database, ids, {
        rolloverId: target.id,
        openedAtMs: target.opensAtMs,
      });

      assert.throws(
        () =>
          transitionFad(database, ids, "rapid", decisionAtMs + 1),
        /complete immediate or scheduled restricted resources/i
      );

      seedRawJob(database, ids, {
        id: ids.job,
        jobType: "fad_restricted_activation",
        occurrenceKey:
          `fad:${ids.fad}:restricted-activate:${ids.allocation}:` +
          `${target.opensAtMs}`,
        scheduledForMs: target.opensAtMs,
      });
      assert.doesNotThrow(() => {
        transitionFad(database, ids, "rapid", decisionAtMs + 1);
      });
    });

    test("requires a succeeded semantic job but exempts cancellation recovery outcomes", (t) => {
      {
        const { database } = createDisposableRuntime(t);
        const base = 35_000;
        const ids = seedRawFad(database, base, "rapid");
        isolateTableTrigger(
          database,
          "free_agent_drafts",
          "free_agent_drafts_resolution_job_completion_barrier"
        );
        const rollover = seedRawRollover(database, ids);
        seedRawAuction(database, ids, {
          status: "no_winner",
          openedAtMs: rollover.opensAtMs,
          resolvesAtMs: rollover.rollsOverAtMs,
        });
        seedRawAuctionContext(database, ids, {
          createdAtMs: rollover.opensAtMs,
        });
        seedRawResolution(database, ids, {
          resolvesAtMs: rollover.rollsOverAtMs,
        });

        assert.throws(
          () =>
            transitionFad(
              database,
              ids,
              "completed",
              rollover.rollsOverAtMs + 2
            ),
          /each semantic auction job to succeed/i
        );
        seedRawJob(database, ids, {
          id: ids.job,
          jobType: "auction.resolve.target",
          occurrenceKey: `auction:${ids.auction}:${rollover.rollsOverAtMs}`,
          scheduledForMs: rollover.rollsOverAtMs,
          status: "succeeded",
          completedAtMs: rollover.rollsOverAtMs + 1,
        });
        assert.throws(
          () =>
            transitionFad(
              database,
              ids,
              "completed",
              rollover.rollsOverAtMs + 2
            ),
          /each semantic auction job to succeed/i
        );
        dropUpdateTriggers(database, "job_runs");
        database
          .prepare(`
            UPDATE job_runs
            SET result_json = ?
            WHERE id = ?
          `)
          .run(
            JSON.stringify({
              auctionId: ids.auction,
              outcome: "no_winner",
            }),
            ids.job
          );
        assert.doesNotThrow(() => {
          transitionFad(
            database,
            ids,
            "completed",
            rollover.rollsOverAtMs + 2
          );
        });
      }

      {
        const { database } = createDisposableRuntime(t);
        const base = 36_000;
        const ids = seedRawFad(database, base, "rapid");
        isolateTableTrigger(
          database,
          "free_agent_drafts",
          "free_agent_drafts_resolution_job_completion_barrier"
        );
        const rollover = seedRawRollover(database, ids);
        seedRawAuction(database, ids, {
          status: "cancelled",
          openedAtMs: rollover.opensAtMs,
          resolvesAtMs: rollover.rollsOverAtMs,
        });
        seedRawAuctionContext(database, ids, {
          createdAtMs: rollover.opensAtMs,
        });
        seedRawResolution(database, ids, {
          resolvesAtMs: rollover.rollsOverAtMs,
          outcomeCode: "recovered",
          status: "cancelled",
        });

        assert.doesNotThrow(() => {
          transitionFad(
            database,
            ids,
            "completed",
            rollover.rollsOverAtMs + 1
          );
        });
        assert.equal(
          database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM job_runs
              WHERE league_id = ?
                AND job_type = 'auction.resolve.target'
            `)
            .get(ids.league).count,
          0
        );
      }
    });

    test("keeps a failed restricted correction blind only with resolved recovery", (t) => {
      const { database } = createDisposableRuntime(t);
      const base = 37_000;
      const ids = seedRawFad(database, base, "rapid");
      isolateTableTrigger(
        database,
        "free_agent_drafts",
        "free_agent_drafts_auction_completion_barrier"
      );
      const rollover = seedRawRollover(database, ids, {
        status: "completed",
        processingJobRunId: uuid(base + 40),
      });
      seedRawAuction(database, ids, {
        status: "cancelled",
        openedAtMs: rollover.opensAtMs,
        resolvesAtMs: rollover.rollsOverAtMs,
      });
      seedRawRestrictedResources(database, ids, {
        rolloverId: rollover.id,
        openedAtMs: rollover.opensAtMs,
      });
      seedRawResolution(database, ids, {
        resolvesAtMs: rollover.rollsOverAtMs,
        outcomeCode: "failed",
        status: "cancelled",
      });
      const completedAtMs = rollover.completedAtMs + 2;

      assert.throws(
        () =>
          transitionFad(
            database,
            ids,
            "completed",
            completedAtMs
          ),
        /auditable draw or resolved blind correction/i
      );

      seedRawResolvedAuctionRecovery(database, ids, {
        rolloverId: rollover.id,
        resolvedAtMs: rollover.completedAtMs + 1,
      });
      assert.doesNotThrow(() => {
        transitionFad(
          database,
          ids,
          "completed",
          completedAtMs
        );
      });
      assert.deepEqual(
        database
          .prepare(`
            SELECT revealed_at_ms, version
            FROM free_agent_draft_draws
            WHERE auction_id = ?
          `)
          .get(ids.auction),
        { revealed_at_ms: null, version: 1 }
      );
    });

    test("installs every frozen historical evidence table", () => {
      const placeholders = NEW_HISTORICAL_TABLES.map(() => "?").join(
        ", "
      );
      const actual = runtime.database
        .prepare(`
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name IN (${placeholders})
          ORDER BY name
        `)
        .all(...NEW_HISTORICAL_TABLES)
        .map(({ name }) => name);

      assert.deepEqual(actual, [...NEW_HISTORICAL_TABLES].sort());
    });

    test("protects every new historical table from update and delete", () => {
      const missing = [];

      for (const tableName of NEW_HISTORICAL_TABLES) {
        const triggers = tableTriggers(runtime.database, tableName);
        for (const operation of ["UPDATE", "DELETE"]) {
          if (
            !hasImmutableTrigger(triggers, tableName, operation)
          ) {
            missing.push(`${tableName}:${operation.toLowerCase()}`);
          }
        }
      }

      assert.deepEqual(missing, []);
    });

    test("seals complete immutable player-game statistics for one successful refresh", () => {
      const ids = {
        source: "00000000-0000-4000-8000-000000000901",
        refresh: "00000000-0000-4000-8000-000000000902",
        player: "00000000-0000-4000-8000-000000000903",
        observation: "00000000-0000-4000-8000-000000000904",
        set: "00000000-0000-4000-8000-000000000905",
        coverage: "00000000-0000-4000-8000-000000000909",
        missingRefresh: "00000000-0000-4000-8000-000000000906",
        missingSet: "00000000-0000-4000-8000-000000000907",
        invalidObservation:
          "00000000-0000-4000-8000-000000000908",
      };

      runtime.database
        .prepare(`
          INSERT INTO stat_sources (
            id,
            provider,
            status,
            created_at_ms,
            updated_at_ms,
            version
          ) VALUES (?, 'test-player-game-feed', 'active', 100, 100, 1)
        `)
        .run(ids.source);
      runtime.database
        .prepare(`
          INSERT INTO players (
            id,
            first_name,
            last_name,
            full_name,
            birth_date,
            status,
            created_at_ms,
            updated_at_ms,
            version
          ) VALUES (
            ?,
            'Zero',
            'Evidence',
            'Zero Evidence',
            NULL,
            'active',
            100,
            100,
            1
          )
        `)
        .run(ids.player);

      const insertSucceededRefresh = runtime.database.prepare(`
        INSERT INTO stat_refreshes (
          id,
          stat_source_id,
          nhl_season_key,
          source_version,
          status,
          started_at_ms,
          completed_at_ms,
          player_count,
          error_code,
          metadata_json,
          version
        ) VALUES (
          ?,
          ?,
          '2026',
          ?,
          'succeeded',
          150,
          200,
          1,
          NULL,
          NULL,
          1
        )
      `);
      insertSucceededRefresh.run(
        ids.refresh,
        ids.source,
        "source-version-1"
      );
      insertSucceededRefresh.run(
        ids.missingRefresh,
        ids.source,
        "source-version-2"
      );

      const insertObservation = runtime.database.prepare(`
        INSERT INTO player_game_stat_observations (
          id,
          stat_source_id,
          refresh_id,
          observation_set_id,
          nhl_season_key,
          player_id,
          nhl_game_id,
          nhl_game_scheduled_starts_at_ms,
          observed_game_state,
          goals,
          assists,
          nhl_points,
          fantasy_points_hundredths,
          source_updated_at_ms,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          '2026',
          ?,
          'game-1',
          175,
          'scheduled',
          0,
          0,
          0,
          ?,
          190,
          200,
          1
        )
      `);
      const insertCoverage = runtime.database.prepare(`
        INSERT INTO stat_refresh_player_game_coverage_entries (
          id,
          stat_source_id,
          refresh_id,
          observation_set_id,
          nhl_season_key,
          player_id,
          provider_player_id,
          provider_team_id,
          disposition,
          nhl_game_id,
          nhl_game_scheduled_starts_at_ms,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          ?,
          '2026',
          ?,
          'provider-player-1',
          'provider-team-1',
          'expected_game',
          'game-1',
          175,
          200,
          1
        )
      `);
      const insertSet = runtime.database.prepare(`
        INSERT INTO stat_refresh_player_game_sets (
          id,
          stat_source_id,
          refresh_id,
          nhl_season_key,
          provider,
          source_version,
          captured_at_ms,
          required_player_count,
          coverage_entry_count,
          expected_player_game_count,
          coverage_schema_version,
          coverage_sha256,
          observation_count,
          evidence_schema_version,
          evidence_sha256,
          created_at_ms,
          version
        ) VALUES (
          ?,
          ?,
          ?,
          '2026',
          'test-player-game-feed',
          ?,
          200,
          1,
          1,
          1,
          1,
          ?,
          ?,
          1,
          ?,
          200,
          1
        )
      `);

      runtime.database.transaction(() => {
        insertCoverage.run(
          ids.coverage,
          ids.source,
          ids.refresh,
          ids.set,
          ids.player
        );
        insertObservation.run(
          ids.observation,
          ids.source,
          ids.refresh,
          ids.set,
          ids.player,
          0
        );
        insertSet.run(
          ids.set,
          ids.source,
          ids.refresh,
          "source-version-1",
          "c".repeat(64),
          1,
          "a".repeat(64)
        );
      })();

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              goals,
              assists,
              nhl_points,
              fantasy_points_hundredths
            FROM player_game_stat_observations
            WHERE id = ?
          `)
          .get(ids.observation),
        {
          goals: 0,
          assists: 0,
          nhl_points: 0,
          fantasy_points_hundredths: 0,
        }
      );
      assert.throws(
        () =>
          insertSet.run(
            ids.missingSet,
            ids.source,
            ids.missingRefresh,
            "source-version-2",
            "d".repeat(64),
            1,
            "b".repeat(64)
          ),
        /must seal one exact successful refresh/
      );
      assert.throws(
        () =>
          insertObservation.run(
            ids.invalidObservation,
            ids.source,
            ids.missingRefresh,
            ids.missingSet,
            ids.player,
            1
          ),
        /CHECK constraint failed/
      );
    });

    test("stores one immutable content-addressed auction administration replay", () => {
      const tableName =
        "auction_administration_command_results";
      const sql = compactSql(
        schemaSql(runtime.database, "table", tableName)
      );
      const columns = new Map(
        tableColumns(runtime.database, tableName).map((column) => [
          column.name,
          column,
        ])
      );
      const requiredColumns = [
        "id",
        "league_id",
        "season_id",
        "auction_id",
        "bid_id",
        "job_run_id",
        "idempotency_request_id",
        "action",
        "actor_user_id",
        "actor_membership_id",
        "actor_authority",
        "request_sha256",
        "precondition_kind",
        "expected_resource_version",
        "resulting_resource_version",
        "response_http_status",
        "response_json",
        "response_sha256",
        "created_at_ms",
        "version",
      ];
      const problems = requiredColumns
        .filter((columnName) => !columns.has(columnName))
        .map((columnName) => `missing ${columnName}`);

      for (const action of [
        "edit_bid",
        "remove_bid",
        "cancel_auction",
        "request_resolution",
      ]) {
        if (!sql.includes(`'${action}'`)) {
          problems.push(`missing ${action} action`);
        }
      }
      if (
        !/UNIQUE\s*\(\s*league_id\s*,\s*idempotency_request_id\s*\)/i.test(
          sql
        )
      ) {
        problems.push("idempotency request does not own one result");
      }
      if (!/response_http_status\s+IN\s*\(\s*200\s*,\s*202\s*\)/i.test(sql)) {
        problems.push("original HTTP status is not frozen");
      }
      if (
        !/action\s+IN\s*\(\s*'edit_bid'\s*,\s*'remove_bid'\s*\).{0,120}precondition_kind\s*=\s*'bid'/i.test(
          sql
        ) ||
        !/action\s+IN\s*\(\s*'cancel_auction'\s*,\s*'request_resolution'\s*\).{0,120}precondition_kind\s*=\s*'auction'/i.test(
          sql
        )
      ) {
        problems.push(
          "action does not physically bind bid-versus-auction precondition kind"
        );
      }
      if (
        !/action\s+IN\s*\(\s*'edit_bid'\s*,\s*'remove_bid'\s*\).{0,180}resulting_resource_version\s*=\s*expected_resource_version\s*\+\s*1/i.test(
          sql
        ) ||
        !/action\s*=\s*'cancel_auction'.{0,180}resulting_resource_version\s*>\s*expected_resource_version/i.test(
          sql
        ) ||
        !/action\s*=\s*'request_resolution'.{0,180}resulting_resource_version\s*=\s*expected_resource_version/i.test(
          sql
        )
      ) {
        problems.push(
          "expected and resulting resource versions are not action-bound"
        );
      }
      if (
        !/action\s*=\s*'request_resolution'.{0,240}job_run_id\s+IS\s+NOT\s+NULL/i.test(
          sql
        ) ||
        !/action\s+IN\s*\(\s*'edit_bid'\s*,\s*'remove_bid'\s*\).{0,180}job_run_id\s+IS\s+NULL/i.test(
          sql
        ) ||
        !/action\s*=\s*'cancel_auction'.{0,180}job_run_id\s+IS\s+NULL/i.test(
          sql
        )
      ) {
        problems.push(
          "resolution job identity is not scoped to request_resolution"
        );
      }
      for (const columnName of [
        "request_sha256",
        "response_sha256",
      ]) {
        if (
          !new RegExp(
            `${columnName}.{0,160}length\\s*\\(\\s*${columnName}\\s*\\)\\s*=\\s*64`,
            "i"
          ).test(sql)
        ) {
          problems.push(`${columnName} is not a SHA-256 digest`);
        }
      }

      const insertGuardSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "auction_administration_command_results_valid_insert"
        )
      );
      for (const operation of [
        "auction.bid.put",
        "auction.bid.remove",
        "auction.cancel",
        "auction.resolve.request",
      ]) {
        if (!insertGuardSql.includes(`'${operation}'`)) {
          problems.push(`insert guard missing ${operation}`);
        }
      }
      for (const token of [
        "idempotency_requests",
        "request_hash",
        "actor_user_id",
        "status = 'started'",
        "result_type IS NULL",
        "result_id IS NULL",
        "auction.resolve.target",
        "'pending'",
        "'leased'",
        "'running'",
        "'succeeded'",
        "'already_succeeded'",
        "'resolved'",
        "'no_winner'",
        "'cancelled'",
      ]) {
        if (!insertGuardSql.includes(token)) {
          problems.push(`insert guard missing ${token}`);
        }
      }

      const completionGuardSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "idempotency_requests_auction_administration_complete"
        )
      );
      for (const token of [
        "auction_administration_command_results",
        "auction_administration_command_result",
        "NEW.result_id",
        "NEW.request_hash",
        "NEW.actor_user_id",
      ]) {
        if (!completionGuardSql.includes(token)) {
          problems.push(`completion guard missing ${token}`);
        }
      }

      assert.deepEqual(problems, []);
    });

    test("records replaced and cancelled recovery jobs without inventing replacements", () => {
      const tableName =
        "free_agent_draft_schedule_recovery_jobs";
      const sql = compactSql(
        schemaSql(runtime.database, "table", tableName)
      );
      const columns = new Map(
        tableColumns(runtime.database, tableName).map((column) => [
          column.name,
          column,
        ])
      );
      const problems = [];

      if (!columns.has("disposition")) {
        problems.push("missing disposition column");
      }
      if (!sql.includes("'replaced'")) {
        problems.push("missing replaced disposition");
      }
      if (!sql.includes("'cancelled'")) {
        problems.push("missing cancelled disposition");
      }

      for (const columnName of [
        "replacement_job_run_id",
        "replacement_occurrence_key",
        "replacement_job_version",
      ]) {
        const column = columns.get(columnName);
        if (!column) {
          problems.push(`missing ${columnName}`);
        } else if (column.notnull !== 0) {
          problems.push(`${columnName} must be nullable`);
        }
      }

      assert.deepEqual(problems, []);
    });

    test("defers the FAD current-Week-1 foreign key until recovery commit", () => {
      const sql = compactSql(
        schemaSql(runtime.database, "table", "free_agent_drafts")
      );

      assert.match(
        sql,
        /FOREIGN KEY\s*\(\s*league_id\s*,\s*current_competition_first_matchup_week_id\s*\)\s*REFERENCES\s+matchup_weeks\s*\(\s*league_id\s*,\s*id\s*\)\s*ON DELETE NO ACTION\s+DEFERRABLE INITIALLY DEFERRED/i
      );
    });

    test("keeps historical FAD allocations independent of live ownership rows", () => {
      const ownershipForeignKeys = tableForeignKeys(
        runtime.database,
        "free_agent_draft_player_allocations"
      )
        .filter(({ table }) => table === "player_ownerships")
        .map(({ from, to }) => `${from}->${to}`)
        .sort();

      assert.deepEqual(ownershipForeignKeys, []);
    });

    test("binds FAD completion to one stable occurrence key", () => {
      const sql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_drafts_forward_update"
        )
      );
      const exactOccurrence =
        "job_runs.occurrence_key = " +
        "'fad:' || NEW.id || ':complete'";
      const timestampedOccurrence =
        "job_runs.occurrence_key = " +
        "'fad:' || NEW.id || ':complete:' || NEW.completed_at_ms";

      assert.ok(
        sql.includes(exactOccurrence),
        `missing exact occurrence predicate: ${exactOccurrence}`
      );
      assert.ok(
        !sql.includes(timestampedOccurrence),
        "completion occurrence key must not include completed_at_ms"
      );
    });

    test("leaves league-local Monday recovery arithmetic to domain policy", () => {
      const recoveryTriggers = runtime.database
        .prepare(`
          SELECT name, sql
          FROM sqlite_schema
          WHERE type = 'trigger'
            AND (
              name LIKE 'free_agent_draft_schedule_recovery%'
              OR sql LIKE '%free_agent_draft_schedule_recover%'
            )
          ORDER BY name
        `)
        .all();
      const elapsedWeekArithmetic = recoveryTriggers
        .filter(({ sql }) => /\b604800000\b/.test(sql))
        .map(({ name }) => name);

      assert.deepEqual(elapsedWeekArithmetic, []);
    });

    test("seals exact required-player coverage with the observation identity set", () => {
      const rootColumns = new Map(
        tableColumns(
          runtime.database,
          "stat_refresh_player_game_sets"
        ).map((column) => [column.name, column])
      );
      const coverageColumns = new Map(
        tableColumns(
          runtime.database,
          "stat_refresh_player_game_coverage_entries"
        ).map((column) => [column.name, column])
      );
      const rootSql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "stat_refresh_player_game_sets_valid_insert"
        )
      );
      const coverageTableSql = compactSql(
        schemaSql(
          runtime.database,
          "table",
          "stat_refresh_player_game_coverage_entries"
        )
      );
      const coverageTriggers = tableTriggers(
        runtime.database,
        "stat_refresh_player_game_coverage_entries"
      );
      const problems = [];

      for (const columnName of [
        "required_player_count",
        "coverage_entry_count",
        "expected_player_game_count",
        "coverage_schema_version",
        "coverage_sha256",
      ]) {
        if (rootColumns.get(columnName)?.notnull !== 1) {
          problems.push(`missing required root column ${columnName}`);
        }
      }
      for (const columnName of [
        "player_id",
        "provider_player_id",
        "disposition",
      ]) {
        if (coverageColumns.get(columnName)?.notnull !== 1) {
          problems.push(`missing required coverage column ${columnName}`);
        }
      }
      for (const token of [
        "'expected_game'",
        "'no_due_game'",
        "'no_team'",
        "provider_team_id IS NOT NULL",
        "provider_team_id IS NULL",
        "nhl_game_id IS NOT NULL",
        "nhl_game_id IS NULL",
      ]) {
        if (!coverageTableSql.includes(token)) {
          problems.push(`missing coverage shape rule ${token}`);
        }
      }
      for (const token of [
        "NEW.coverage_entry_count",
        "NEW.required_player_count",
        "NEW.expected_player_game_count",
        "NEW.observation_count = NEW.expected_player_game_count",
        "left_coverage.provider_player_id <> right_coverage.provider_player_id",
        "coverage.player_id = observation.player_id",
        "coverage.nhl_game_id = observation.nhl_game_id",
        "coverage.nhl_game_scheduled_starts_at_ms = observation.nhl_game_scheduled_starts_at_ms",
      ]) {
        if (!rootSql.includes(token)) {
          problems.push(`missing coverage seal rule ${token}`);
        }
      }
      if (
        !hasImmutableTrigger(
          coverageTriggers,
          "stat_refresh_player_game_coverage_entries",
          "UPDATE"
        ) ||
        !hasImmutableTrigger(
          coverageTriggers,
          "stat_refresh_player_game_coverage_entries",
          "DELETE"
        )
      ) {
        problems.push("sealed coverage entries remain mutable");
      }

      assert.deepEqual(problems, []);
    });

    test("indexes the exact player-game coverage requirement query", () => {
      const expectedIndexes = [
        "seasons_player_game_coverage_nhl",
        "matchup_weeks_player_game_coverage_live",
        "player_ownerships_player_game_coverage_active",
        "matchup_roster_players_player_game_coverage_season",
        "matchup_roster_game_exclusions_player_game_coverage_season",
      ];
      const presentIndexes = new Set(
        runtime.database
          .prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'index'
              AND name IN (${expectedIndexes.map(() => "?").join(", ")})
          `)
          .all(...expectedIndexes)
          .map(({ name }) => name)
      );
      const queryPlan = runtime.database
        .prepare(`
          EXPLAIN QUERY PLAN
          WITH relevant_seasons AS MATERIALIZED (
            SELECT league_id, id AS season_id
            FROM seasons
            WHERE nhl_season_key = ?
          ),
          live_seasons AS MATERIALIZED (
            SELECT DISTINCT rs.league_id, rs.season_id
            FROM relevant_seasons AS rs
            JOIN matchup_weeks AS mw
              ON mw.league_id = rs.league_id
             AND mw.season_id = rs.season_id
            WHERE mw.status IN ('live', 'awaiting_data')
          ),
          required_player_ids(player_id) AS (
            SELECT po.player_id
            FROM live_seasons AS ls
            JOIN player_ownerships AS po
              ON po.league_id = ls.league_id
             AND po.season_id = ls.season_id
            WHERE po.ownership_kind = 'Rostered'
              AND po.roster_category = 'Active'
            UNION
            SELECT mrp.player_id
            FROM relevant_seasons AS rs
            CROSS JOIN matchup_roster_players AS mrp
              INDEXED BY matchup_roster_players_player_game_coverage_season
            JOIN matchup_roster_locks AS mrl
              ON mrl.league_id = mrp.league_id
             AND mrl.season_id = mrp.season_id
             AND mrl.id = mrp.matchup_roster_lock_id
            WHERE mrp.league_id = rs.league_id
              AND mrp.season_id = rs.season_id
            UNION
            SELECT ex.player_id
            FROM relevant_seasons AS rs
            CROSS JOIN matchup_roster_game_exclusions AS ex
              INDEXED BY matchup_roster_game_exclusions_player_game_coverage_season
            JOIN matchup_roster_game_exclusion_sets AS root
              ON root.league_id = ex.league_id
             AND root.season_id = ex.season_id
             AND root.id = ex.exclusion_set_id
            WHERE ex.league_id = rs.league_id
              AND ex.season_id = rs.season_id
          )
          SELECT required.player_id, identity.external_value
          FROM required_player_ids AS required
          LEFT JOIN player_external_ids AS identity
            ON identity.player_id = required.player_id
           AND identity.provider = ?
          ORDER BY required.player_id COLLATE BINARY,
                   identity.external_value COLLATE BINARY
        `)
        .all("20262027", "sportsdataio-discovery-lab")
        .map(({ detail }) => detail);
      const planText = queryPlan.join("\n");

      assert.deepEqual(
        expectedIndexes.filter((indexName) => !presentIndexes.has(indexName)),
        []
      );
      for (const indexName of expectedIndexes) {
        assert.match(planText, new RegExp(`\\b${indexName}\\b`));
      }
      for (const tableAlias of ["mw", "po", "mrp", "ex"]) {
        assert.doesNotMatch(planText, new RegExp(`SCAN ${tableAlias}\\b`));
      }
    });

    test("binds each late-lock exclusion child to exact covered baseline evidence", () => {
      const triggerName =
        "matchup_roster_game_exclusions_stage_before_set";
      const sql = compactSql(
        schemaSql(runtime.database, "trigger", triggerName)
      );
      const problems = [];

      for (const expression of [
        /JOIN stat_refresh_player_game_coverage_entries/i,
        /stat_refresh_player_game_coverage_entries\.stat_source_id\s*=\s*player_game_stat_observations\.stat_source_id/i,
        /stat_refresh_player_game_coverage_entries\.refresh_id\s*=\s*player_game_stat_observations\.refresh_id/i,
        /stat_refresh_player_game_coverage_entries\.observation_set_id\s*=\s*player_game_stat_observations\.observation_set_id/i,
        /stat_refresh_player_game_coverage_entries\.nhl_season_key\s*=\s*player_game_stat_observations\.nhl_season_key/i,
        /stat_refresh_player_game_coverage_entries\.player_id\s*=\s*player_game_stat_observations\.player_id/i,
        /stat_refresh_player_game_coverage_entries\.nhl_game_id\s*=\s*player_game_stat_observations\.nhl_game_id/i,
        /stat_refresh_player_game_coverage_entries\s*\.nhl_game_scheduled_starts_at_ms\s*=\s*player_game_stat_observations\s*\.nhl_game_scheduled_starts_at_ms/i,
        /stat_refresh_player_game_coverage_entries\.disposition\s*=\s*'expected_game'/i,
      ]) {
        if (!expression.test(sql)) {
          problems.push(`missing child binding ${expression}`);
        }
      }

      assert.deepEqual(problems, []);
    });

    test("seals the exact selected-player late-lock game and exclusion sets", () => {
      const triggerName =
        "matchup_roster_game_exclusion_sets_valid_insert";
      const sql = compactSql(
        schemaSql(runtime.database, "trigger", triggerName)
      );
      const problems = [];

      for (const expression of [
        /matchups\.status\s*=\s*'live'/i,
        /NEW\.late_snapshot_at_ms\s*-\s*nhl_game_state_observation_snapshots\.observed_at_ms\s+BETWEEN\s+0\s+AND\s+300000/i,
        /nhl_game_state_observation_snapshots\.provider\s*=\s*stat_refresh_player_game_sets\.provider/i,
        /selected_coverage\.player_id\s*=\s*selected_player\.player_id/i,
        /selected_coverage\.disposition\s*=\s*'expected_game'/i,
        /selected_coverage\.nhl_game_scheduled_starts_at_ms\s*>=\s*selected_week\.starts_at_ms/i,
        /selected_coverage\.nhl_game_scheduled_starts_at_ms\s*<\s*selected_week\.ends_at_ms/i,
        /AS required_game/i,
        /AS observed_game/i,
        /AS required_exclusion/i,
        /AS sealed_exclusion/i,
        /observed_game\.observed_game_state\s+IN\s*\(\s*'in_progress'\s*,\s*'intermission'\s*,\s*'final'\s*\)/i,
        /baseline_observation\.id\s*=\s*sealed_exclusion\s*\.baseline_player_game_stat_observation_id/i,
        /COUNT\(\*\).*matchup_roster_game_exclusions.*=\s*NEW\.exclusion_count/i,
      ]) {
        if (!expression.test(sql)) {
          problems.push(`missing root rule ${expression}`);
        }
      }
      if (
        /nhl_game_state_observation_snapshots\.source_version\s*=\s*stat_refresh_player_game_sets\.source_version/i.test(
          sql
        )
      ) {
        problems.push(
          "compatible providers incorrectly require equal source versions"
        );
      }
      if (
        /matchup_roster_locks\.created_at_ms\s*=\s*NEW\.late_snapshot_at_ms/i.test(
          sql
        )
      ) {
        problems.push(
          "lock created_at_ms is coupled to late_snapshot_at_ms"
        );
      }

      assert.deepEqual(problems, []);
    });

    test("rejects exclusion children without an exact expected-game coverage twin", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusions_stage_before_set",
        tableName: "matchup_roster_game_exclusions",
      });
      const childError =
        /late-lock exclusion child must match fresh state and sealed baseline statistics/i;
      const expectedGame = Object.freeze({
        playerIndex: 0,
        nhlGameId: "game-1",
        nhlGameScheduledStartsAtMs: 1_250_000,
      });
      const finalGame = Object.freeze({
        nhlGameId: "game-1",
        nhlGameScheduledStartsAtMs: 1_250_000,
        observedGameState: "final",
      });

      const valid = seedLateLockTriggerFixture(database, 710_000, {
        gameObservations: [finalGame],
      });
      assert.doesNotThrow(() => {
        stageLateLockExclusion(database, valid);
      });

      const mismatches = [
        {
          label: "missing coverage",
          coverageEntries: [],
        },
        {
          label: "wrong statistics source",
          coverageEntries: (base) => [{
            ...expectedGame,
            disposition: "expected_game",
            statSourceId: uuid(base + 900),
          }],
        },
        {
          label: "wrong refresh",
          coverageEntries: (base) => [{
            ...expectedGame,
            disposition: "expected_game",
            refreshId: uuid(base + 901),
          }],
        },
        {
          label: "wrong observation set",
          coverageEntries: (base) => [{
            ...expectedGame,
            disposition: "expected_game",
            observationSetId: uuid(base + 902),
          }],
        },
        {
          label: "wrong NHL season",
          coverageEntries: [{
            ...expectedGame,
            disposition: "expected_game",
            nhlSeasonKey: "other-season",
          }],
        },
        {
          label: "wrong player",
          coverageEntries: (base) => [{
            ...expectedGame,
            disposition: "expected_game",
            playerId: uuid(base + 903),
          }],
        },
        {
          label: "wrong game",
          coverageEntries: [{
            ...expectedGame,
            disposition: "expected_game",
            nhlGameId: "other-game",
          }],
        },
        {
          label: "wrong scheduled start",
          coverageEntries: [{
            ...expectedGame,
            disposition: "expected_game",
            nhlGameScheduledStartsAtMs: 1_250_001,
          }],
        },
        {
          label: "non-expected disposition",
          coverageEntries: [{
            playerIndex: 0,
            disposition: "no_due_game",
            providerTeamId: "provider-team",
          }],
        },
      ];

      mismatches.forEach((mismatch, index) => {
        const base = 711_000 + index * 1_000;
        const coverageEntries =
          typeof mismatch.coverageEntries === "function"
            ? mismatch.coverageEntries(base)
            : mismatch.coverageEntries;
        const fixture = seedLateLockTriggerFixture(database, base, {
          coverageEntries,
          baselineObservations: [expectedGame],
          gameObservations: [finalGame],
        });
        assert.throws(
          () => stageLateLockExclusion(database, fixture),
          childError,
          mismatch.label
        );
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM matchup_roster_game_exclusions
            WHERE exclusion_set_id = ?
          `).get(fixture.ids.exclusionSet).count,
          0,
          `${mismatch.label} must not leave a child row`
        );
      });
    });

    test("enforces late-lock provider compatibility and the inclusive five-minute boundary", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusion_sets_valid_insert",
        tableName: "matchup_roster_game_exclusion_sets",
      });
      dropInsertTriggers(database, "matchup_roster_game_exclusions");
      const rootError =
        /late-lock exclusion root must seal one exact live roster and observation set/i;

      const boundary = seedLateLockTriggerFixture(
        database,
        730_000
      );
      assert.notEqual(
        boundary.statisticsSourceVersion,
        boundary.gameStateSourceVersion
      );
      assert.equal(
        LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs -
          boundary.gameStateObservedAtMs,
        300_000
      );
      assert.doesNotThrow(() => {
        insertLateLockExclusionRoot(database, boundary, 0);
      });

      const future = seedLateLockTriggerFixture(database, 731_000, {
        gameStateObservedAtMs:
          LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs + 1,
      });
      assert.throws(
        () => insertLateLockExclusionRoot(database, future, 0),
        rootError
      );

      const stale = seedLateLockTriggerFixture(database, 732_000, {
        gameStateObservedAtMs:
          LATE_LOCK_TRIGGER_CLOCK.lateSnapshotAtMs - 300_001,
      });
      assert.throws(
        () => insertLateLockExclusionRoot(database, stale, 0),
        rootError
      );

      const incompatible = seedLateLockTriggerFixture(
        database,
        733_000,
        { gameStateProvider: "incompatible-provider" }
      );
      assert.throws(
        () => insertLateLockExclusionRoot(database, incompatible, 0),
        rootError
      );
    });

    test("requires affirmative selected-player coverage and the exact distinct in-week game set", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusion_sets_valid_insert",
        tableName: "matchup_roster_game_exclusion_sets",
      });
      dropInsertTriggers(database, "matchup_roster_game_exclusions");
      const rootError =
        /late-lock exclusion root must seal one exact live roster and observation set/i;
      const expectedGame = Object.freeze({
        playerIndex: 0,
        disposition: "expected_game",
        providerTeamId: "provider-team",
        nhlGameId: "game-1",
        nhlGameScheduledStartsAtMs: 1_250_000,
      });

      const uncovered = seedLateLockTriggerFixture(database, 740_000, {
        selectedPlayerCount: 2,
        coverageEntries: [expectedGame],
      });
      assert.throws(
        () => insertLateLockExclusionRoot(database, uncovered, 0),
        rootError
      );

      const missingGame = seedLateLockTriggerFixture(
        database,
        741_000,
        { gameObservations: [] }
      );
      assert.throws(
        () => insertLateLockExclusionRoot(database, missingGame, 0),
        rootError
      );

      const startBoundaryMissing = seedLateLockTriggerFixture(
        database,
        742_000,
        {
          coverageEntries: [{
            ...expectedGame,
            nhlGameScheduledStartsAtMs:
              LATE_LOCK_TRIGGER_CLOCK.weekStartsAtMs,
          }],
          gameObservations: [],
        }
      );
      assert.throws(
        () => insertLateLockExclusionRoot(
          database,
          startBoundaryMissing,
          0
        ),
        rootError
      );

      const extraGame = seedLateLockTriggerFixture(database, 743_000, {
        gameObservations: [
          {
            nhlGameId: "game-1",
            nhlGameScheduledStartsAtMs: 1_250_000,
            observedGameState: "scheduled",
          },
          {
            nhlGameId: "unrequested-game",
            nhlGameScheduledStartsAtMs: 1_300_000,
            observedGameState: "scheduled",
          },
        ],
      });
      assert.throws(
        () => insertLateLockExclusionRoot(database, extraGame, 0),
        rootError
      );

      const endExclusive = seedLateLockTriggerFixture(
        database,
        744_000,
        {
          coverageEntries: [{
            ...expectedGame,
            nhlGameScheduledStartsAtMs:
              LATE_LOCK_TRIGGER_CLOCK.weekEndsAtMs,
          }],
          gameObservations: [],
        }
      );
      assert.doesNotThrow(() => {
        insertLateLockExclusionRoot(database, endExclusive, 0);
      });

      const sharedGame = seedLateLockTriggerFixture(
        database,
        745_000,
        {
          selectedPlayerCount: 2,
          coverageEntries: [
            expectedGame,
            { ...expectedGame, playerIndex: 1 },
          ],
          gameObservations: [{
            nhlGameId: "game-1",
            nhlGameScheduledStartsAtMs: 1_250_000,
            observedGameState: "in_progress",
          }],
        }
      );
      stageLateLockExclusion(database, sharedGame, {
        playerIndex: 0,
        exclusionIndex: 0,
      });
      stageLateLockExclusion(database, sharedGame, {
        playerIndex: 1,
        exclusionIndex: 1,
      });
      assert.doesNotThrow(() => {
        insertLateLockExclusionRoot(database, sharedGame, 2);
      });
      assert.equal(sharedGame.games.length, 1);
    });

    test("seals no exclusions for terminal coverage or scheduled games and every underway exclusion", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusion_sets_valid_insert",
        tableName: "matchup_roster_game_exclusion_sets",
      });
      dropInsertTriggers(database, "matchup_roster_game_exclusions");
      const rootError =
        /late-lock exclusion root must seal one exact live roster and observation set/i;

      for (const [index, disposition] of [
        "no_due_game",
        "no_team",
      ].entries()) {
        const fixture = seedLateLockTriggerFixture(
          database,
          750_000 + index * 1_000,
          {
            coverageEntries: [{
              playerIndex: 0,
              disposition,
              providerTeamId:
                disposition === "no_team" ? null : "provider-team",
            }],
            gameObservations: [],
          }
        );
        assert.equal(fixture.games.length, 0);
        assert.doesNotThrow(() => {
          insertLateLockExclusionRoot(database, fixture, 0);
        });
      }

      const scheduled = seedLateLockTriggerFixture(
        database,
        752_000
      );
      assert.equal(scheduled.games[0].observedGameState, "scheduled");
      assert.doesNotThrow(() => {
        insertLateLockExclusionRoot(database, scheduled, 0);
      });

      for (const [index, observedGameState] of [
        "in_progress",
        "intermission",
        "final",
      ].entries()) {
        const fixture = seedLateLockTriggerFixture(
          database,
          753_000 + index * 1_000,
          {
            gameObservations: [{
              nhlGameId: "game-1",
              nhlGameScheduledStartsAtMs: 1_250_000,
              observedGameState,
            }],
          }
        );
        stageLateLockExclusion(database, fixture);
        assert.doesNotThrow(() => {
          insertLateLockExclusionRoot(database, fixture, 1);
        });
      }

      const missingUnderway = seedLateLockTriggerFixture(
        database,
        756_000,
        {
          gameObservations: [{
            nhlGameId: "game-1",
            nhlGameScheduledStartsAtMs: 1_250_000,
            observedGameState: "in_progress",
          }],
        }
      );
      assert.throws(
        () => insertLateLockExclusionRoot(
          database,
          missingUnderway,
          0
        ),
        rootError
      );

      const scheduledWithExtra = seedLateLockTriggerFixture(
        database,
        757_000
      );
      stageLateLockExclusion(database, scheduledWithExtra, {
        observedGameState: "final",
      });
      assert.throws(
        () => insertLateLockExclusionRoot(
          database,
          scheduledWithExtra,
          1
        ),
        rootError
      );
    });

    test("rolls back a failed late-lock evidence seal without partial rows", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusion_sets_valid_insert",
        tableName: "matchup_roster_game_exclusion_sets",
      });
      dropInsertTriggers(database, "matchup_roster_game_exclusions");
      const fixture = seedLateLockTriggerFixture(database, 760_000, {
        gameStateProvider: "incompatible-provider",
        gameObservations: [{
          nhlGameId: "game-1",
          nhlGameScheduledStartsAtMs: 1_250_000,
          observedGameState: "final",
        }],
        insertGameState: false,
      });

      assert.throws(
        () => database.transaction(() => {
          insertLateLockGameState(database, fixture);
          stageLateLockExclusion(database, fixture);
          insertLateLockExclusionRoot(database, fixture, 1);
        })(),
        /late-lock exclusion root must seal one exact live roster and observation set/i
      );

      for (const [tableName, id] of [
        [
          "nhl_game_state_observations",
          fixture.games[0].observationId,
        ],
        [
          "nhl_game_state_observation_snapshots",
          fixture.ids.gameStateSnapshot,
        ],
        [
          "matchup_roster_game_exclusions",
          uuid(fixture.base + 700),
        ],
        [
          "matchup_roster_game_exclusion_sets",
          fixture.ids.exclusionSet,
        ],
      ]) {
        assert.equal(
          database.prepare(`
            SELECT COUNT(*) AS count
            FROM ${tableName}
            WHERE id = ?
          `).get(id).count,
          0,
          `${tableName} must roll back`
        );
      }
    });

    test("leaves ordinary normal-lock persistence independent of late-lock evidence", (t) => {
      const { database } = createDisposableRuntime(t);
      prepareLateLockTriggerDatabase(database, {
        triggerName:
          "matchup_roster_game_exclusion_sets_valid_insert",
        tableName: "matchup_roster_game_exclusion_sets",
      });
      const fixture = seedLateLockTriggerFixture(database, 770_000);
      const normalLockId = uuid(770_900);

      assert.doesNotThrow(() => {
        insert(database, "matchup_roster_locks", {
          id: normalLockId,
          league_id: fixture.ids.league,
          season_id: fixture.ids.season,
          matchup_week_id: fixture.ids.week,
          team_id: fixture.ids.awayTeam,
          lock_type: "normal",
          legal: 1,
          legality_reason_code: null,
          locked_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
          baseline_snapshot_id: fixture.ids.baselineSnapshot,
          source_freshness_status: "fresh",
          created_at_ms: LATE_LOCK_TRIGGER_CLOCK.baselineAtMs,
          version: 1,
        });
      });
      assert.deepEqual(
        database.prepare(`
          SELECT lock_type, legal, baseline_snapshot_id
          FROM matchup_roster_locks
          WHERE id = ?
        `).get(normalLockId),
        {
          lock_type: "normal",
          legal: 1,
          baseline_snapshot_id: fixture.ids.baselineSnapshot,
        }
      );
    });

    test("preserves ordinary FAD manager edit limits and count-preserving administration", () => {
      const sql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "fad_auction_bids_forward_update"
        )
      );
      const problems = [];

      for (const token of [
        "fad_open_rapid",
        "fad_restricted",
        "team_manager_assignments",
        "idempotency_requests",
        "platform_roles",
      ]) {
        if (!sql.includes(token)) problems.push(`missing ${token}`);
      }
      if (
        !/NEW\.edit_count\s*=\s*OLD\.edit_count\s*\+\s*1/i.test(
          sql
        )
      ) {
        problems.push("manager edit does not consume one edit");
      }
      if (
        !/OLD\.first_submitted_at_ms\s*=\s*auctions\.opened_at_ms/i.test(
          sql
        ) ||
        !/THEN\s+2\s+ELSE\s+1\s+END/i.test(sql)
      ) {
        problems.push("open-rapid starter does not retain two edits");
      }
      if (!sql.includes("manager_edit_limit")) {
        problems.push(
          "joining and restricted managers do not retain one edit"
        );
      }
      if (!/\b4500000\b/.test(sql)) {
        problems.push("manager cooldown is not 75 minutes");
      }
      if (
        !/NEW\.edit_count\s*=\s*OLD\.edit_count(?!\s*\+)/i.test(
          sql
        )
      ) {
        problems.push("administrative edit consumes a manager edit");
      }

      assert.deepEqual(problems, []);
    });

    test("allows valid and warning Candidate offers into restricted tie auctions", () => {
      const sql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_draft_auction_participants_valid_insert"
        )
      );
      const problems = [];

      if (
        !/candidate_card_snapshot_entries\.eligibility_status\s+IN\s*\(\s*'valid'\s*,\s*'warning'\s*\)/i.test(
          sql
        )
      ) {
        problems.push(
          "restricted participants do not accept valid and warning offers"
        );
      }
      if (
        /candidate_card_snapshot_entries\.eligibility_status\s*=\s*'valid'/i.test(
          sql
        )
      ) {
        problems.push(
          "restricted participants still exclude warning offers"
        );
      }

      assert.deepEqual(problems, []);
    });

    test("keeps every edited fallback bid at or above its current Candidate floor", () => {
      const sql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "fad_auction_bids_forward_update"
        )
      );
      const problems = [];

      for (const token of [
        "fad_open_rapid",
        "restricted_no_improvement_fallback",
        "free_agent_draft_player_allocations",
        "restricted_minimum_total_cents",
        "restricted_minimum_aav_cents",
        "fallback bid cannot rank below its Candidate minimum",
      ]) {
        if (!sql.includes(token)) problems.push(`missing ${token}`);
      }
      if (
        !/NEW\.total_value_cents\s*\/\s*NEW\.term_years/i.test(sql) ||
        !/NEW\.total_value_cents\s*%\s*NEW\.term_years/i.test(sql)
      ) {
        problems.push(
          "fallback edit floor does not derive AAV from the edited contract"
        );
      }
      if (
        !/\)\s*>=\s*free_agent_draft_player_allocations\s*\.restricted_minimum_aav_cents/i.test(
          sql
        )
      ) {
        problems.push(
          "equal-total fallback edit does not meet the Candidate AAV floor"
        );
      }

      assert.deepEqual(problems, []);
    });

    test("requires attributable commissioner removal of a restricted participant", () => {
      const sql = compactSql(
        schemaSql(
          runtime.database,
          "trigger",
          "free_agent_draft_auction_participants_forward_update"
        )
      );
      const problems = [];

      for (const token of [
        "auction_events",
        "commissioner_bid_removed",
        "platform_roles",
        "auctions",
        "free_agent_draft_player_allocations",
        "restricted_active",
      ]) {
        if (!sql.includes(token)) problems.push(`missing ${token}`);
      }
      if (!/auctions\.status\s*=\s*'open'/i.test(sql)) {
        problems.push("participant removal does not require open auction");
      }
      if (
        !/auction_events\.occurred_at_ms\s*=\s*NEW\.removed_at_ms/i.test(
          sql
        )
      ) {
        problems.push("participant removal is not bound to event time");
      }
      if (
        !/auction_events\.actor_user_id\s*=\s*NEW\.removed_by_user_id/i.test(
          sql
        )
      ) {
        problems.push("participant removal is not bound to event actor");
      }

      assert.deepEqual(problems, []);
    });

    test("keeps restricted correction cancellation blind while sealing terminal outcomes", () => {
      const relevantTables = [
        "auctions",
        "auction_resolutions",
        "free_agent_draft_draws",
        "free_agent_draft_player_allocations",
        "free_agent_draft_recoveries",
      ];
      const sql = compactSql(
        relevantTables
          .flatMap((tableName) =>
            tableTriggers(runtime.database, tableName).map(
              ({ sql: triggerSql }) => triggerSql
            )
          )
          .join("\n")
      );
      const problems = [];

      for (const token of [
        "fad_open_rapid",
        "fad_restricted",
        "auction_resolutions",
        "outcome_code",
        "free_agent_draft_draws",
        "free_agent_draft_player_allocations",
        "correction_required",
        "recovered",
      ]) {
        if (!sql.includes(token)) problems.push(`missing ${token}`);
      }
      if (
        !/free_agent_draft_draws\.revealed_at_ms\s+IS\s+NULL/i.test(
          sql
        )
      ) {
        problems.push(
          "restricted correction cancellation cannot preserve blind draw"
        );
      }
      if (
        !/outcome_code\s*=\s*'failed'/i.test(sql) ||
        !/status\s*=\s*'correction_required'/i.test(sql)
      ) {
        problems.push(
          "restricted cancellation is not bound to correction-required failure"
        );
      }

      assert.deepEqual(problems, []);
    });

    test("makes FAD terminal resolution and event evidence immutable and coherent", () => {
      const problems = [];

      for (const tableName of [
        "auction_resolutions",
        "auction_events",
      ]) {
        const triggers = tableTriggers(runtime.database, tableName);
        for (const operation of ["UPDATE", "DELETE"]) {
          if (!hasImmutableTrigger(triggers, tableName, operation)) {
            problems.push(
              `${tableName}:${operation.toLowerCase()} is mutable`
            );
          }
        }
        const guardSql = compactSql(
          triggers.map(({ sql }) => sql).join("\n")
        );
        for (const token of [
          "auction_contexts",
          "fad_open_rapid",
          "fad_restricted",
        ]) {
          if (!guardSql.includes(token)) {
            problems.push(`${tableName} guard missing ${token}`);
          }
        }
      }

      const coherenceSql = compactSql(
        [
          "auctions",
          "auction_resolutions",
          "auction_events",
          "free_agent_draft_player_allocations",
          "free_agent_draft_recoveries",
        ]
          .flatMap((tableName) =>
            tableTriggers(runtime.database, tableName).map(
              ({ sql }) => sql
            )
          )
          .join("\n")
      );
      for (const token of [
        "outcome_code",
        "free_agent_draft_draws",
        "free_agent_draft_player_allocations",
        "free_agent_draft_recoveries",
      ]) {
        if (!coherenceSql.includes(token)) {
          problems.push(`terminal coherence guard missing ${token}`);
        }
      }

      assert.deepEqual(problems, []);
    });
  }
);
