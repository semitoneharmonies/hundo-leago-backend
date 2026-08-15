"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  hashAuctionAdministrationRequest,
  validateAuctionAdministrationStoredResult,
} = require(
  "../../src/domain/auctions/auctionAdministrationPolicy"
);
const {
  hashCanonicalJsonV1,
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
  createFreeAgentDraftAuctionDrawCommitment,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  createFreeAgentDraftNotificationContract,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);
const {
  createFreeAgentDraftActivityContract,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftActivityContracts"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteAuctionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionRepository"
);
const {
  createSqliteAuctionResolutionRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository"
);
const {
  AUCTION_ADMINISTRATION_REPOSITORY_CODES,
  AuctionAdministrationRepositoryError,
  createSqliteAuctionAdministrationRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionAdministrationRepository"
);
const {
  createSqliteFreeAgentDraftReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository"
);
const {
  createSqliteRestrictedNoImprovementFallbackWriter,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteRestrictedNoImprovementFallbackWriter"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const NOW_MS = Date.parse(
  "2026-07-21T19:00:00.000Z"
);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  managerUser: uuid(1),
  managerMembership: uuid(2),
  commissionerUser: uuid(3),
  commissionerMembership: uuid(4),
  administratorUser: uuid(5),
  administratorMembership: uuid(6),
  administratorRole: uuid(7),
  league: uuid(8),
  season: uuid(9),
  team: uuid(10),
  assignment: uuid(11),
  player: uuid(12),
  playerSource: uuid(13),
  auction: uuid(14),
  bid: uuid(15),
  startEvent: uuid(16),
  startIdempotency: uuid(17),
  fad: uuid(18),
  rollover: uuid(19),
  allocation: uuid(20),
  draw: uuid(21),
  participant: uuid(22),
  secondTeam: uuid(23),
  secondParticipant: uuid(24),
  snapshotEntry: uuid(25),
  secondSnapshotEntry: uuid(26),
  candidateRevision: uuid(27),
  fadReadiness: uuid(28),
  fadWeek: uuid(29),
  card: uuid(30),
  secondCard: uuid(31),
  snapshot: uuid(32),
  secondSnapshot: uuid(33),
  sourceEntry: uuid(34),
  secondSourceEntry: uuid(35),
  firstOfferEvent: uuid(36),
  secondOfferEvent: uuid(37),
  restrictedStateEvent: uuid(38),
  openRapidResolutionJob: uuid(39),
  openRapidRecovery: uuid(40),
  openRapidFailureEvent: uuid(41),
  openRapidFailureLeaseToken: uuid(42),
  nextRollover: uuid(43),
  restrictedResolutionJob: uuid(44),
  restrictedResolutionLeaseToken: uuid(45),
  fallbackAuction: uuid(46),
  fallbackDraw: uuid(47),
  fallbackResolution: uuid(48),
  fallbackSourceEvent: uuid(49),
  fallbackStateEvent: uuid(50),
  fallbackActivity: uuid(51),
  fallbackFadOutbox: uuid(52),
  fallbackAuctionOutbox: uuid(53),
  fallbackExtensionRollover: uuid(54),
  fallbackResolutionJob: uuid(55),
  fallbackFirstOfferEvent: uuid(56),
  fallbackSecondOfferEvent: uuid(57),
  fallbackNotification: uuid(58),
  initialRollover1: uuid(59),
  initialRollover2: uuid(60),
  initialRollover3: uuid(61),
  initialRollover4: uuid(62),
  initialRollover5: uuid(63),
  initialRollover6: uuid(64),
  rolloverProcessingJob: uuid(65),
  rolloverProcessingLeaseToken: uuid(66),
  openRapidRepeatFailureEvent: uuid(67),
});

function insert(database, tableName, values) {
  const fields = Object.keys(values);
  database
    .prepare(`
      INSERT INTO ${tableName} (
        ${fields.join(", ")}
      ) VALUES (
        ${fields.map((field) => `@${field}`).join(", ")}
      )
    `)
    .run(values);
}

function insertScheduledExtensionRollover(
  database,
  {
    id,
    sequence,
    predecessorId,
    reason,
    sourceId,
    opensAtMs,
    createdAtMs,
  }
) {
  insert(database, "free_agent_draft_rollovers", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    sequence,
    window_kind: "extension",
    predecessor_rollover_id: predecessorId,
    extension_reason: reason,
    extension_source_id: sourceId,
    opens_at_ms: opensAtMs,
    creation_cutoff_at_ms:
      opensAtMs + DAY_MS - HOUR_MS,
    rolls_over_at_ms: opensAtMs + DAY_MS,
    status: "scheduled",
    processing_job_run_id: null,
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
}

function withTableTriggersDisabled(
  database,
  tableNames,
  callback
) {
  const placeholders = tableNames
    .map(() => "?")
    .join(", ");
  const triggers = database
    .prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
        AND tbl_name IN (${placeholders})
      ORDER BY name
    `)
    .all(...tableNames);
  try {
    for (const trigger of triggers) {
      database.exec(
        `DROP TRIGGER "${trigger.name}"`
      );
    }
    return callback();
  } finally {
    for (const trigger of triggers) {
      database.exec(trigger.sql);
    }
  }
}

function adminRows(database, tableName) {
  if (tableName === "idempotency_requests") {
    return database
      .prepare(`
        SELECT *
        FROM idempotency_requests
        WHERE operation IN (
          'auction.bid.put',
          'auction.bid.remove',
          'auction.cancel',
          'auction.resolve.request'
        )
          AND id <> ?
        ORDER BY id
      `)
      .all(IDS.startIdempotency);
  }
  return database
    .prepare(
      `SELECT * FROM ${tableName} ORDER BY id`
    )
    .all();
}

function assertRepositoryError(callback, code) {
  assert.throws(
    callback,
    (error) =>
      error instanceof
        AuctionAdministrationRepositoryError &&
      error.code === code
  );
}

function seedUser(
  repositories,
  id,
  displayName
) {
  repositories.users.insert({
    id,
    email_normalized:
      `${displayName.toLowerCase()}@example.test`,
    email_display:
      `${displayName.toLowerCase()}@example.test`,
    display_name: displayName,
    display_name_normalized:
      displayName.toLowerCase(),
    status: "active",
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
}

function seedMembership(
  repositories,
  id,
  userId,
  permissionCategory
) {
  repositories.league_memberships.insert({
    id,
    league_id: IDS.league,
    user_id: userId,
    permission_category: permissionCategory,
    status: "active",
    joined_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
}

function createRuntime(
  t,
  {
    beforeCommit = () => {},
    fallbackBeforeCommit = () => {},
    leagueOutboxWriter,
    notificationWriter,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-fad06-auction-administration-"
    )
  );
  const connection = openDatabase({
    databasePath: path.join(
      temporaryRoot,
      "league.sqlite3"
    ),
    environment: "test",
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
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "fad06-auction-administration-repository",
    now: () => NOW_MS,
  });
  const { repositories } =
    createSqliteRepositoryContext({
      database: connection.database,
    });
  seedUser(
    repositories,
    IDS.managerUser,
    "Manager"
  );
  seedUser(
    repositories,
    IDS.commissionerUser,
    "Commissioner"
  );
  seedUser(
    repositories,
    IDS.administratorUser,
    "Administrator"
  );
  repositories.leagues.insert({
    id: IDS.league,
    name: "FAD 06 League",
    name_normalized: "fad 06 league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: IDS.season,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: Date.parse(
      "2026-07-01T07:00:00.000Z"
    ),
    regular_season_ends_at_ms: Date.parse(
      "2027-04-01T07:00:00.000Z"
    ),
    fantasy_playoffs_start_at_ms: Date.parse(
      "2027-03-01T08:00:00.000Z"
    ),
    fantasy_playoffs_end_at_ms: Date.parse(
      "2027-04-01T07:00:00.000Z"
    ),
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
    free_agent_draft_completed_at_ms:
      Date.parse("2026-07-01T08:00:00.000Z"),
  });
  repositories.teams.insert({
    id: IDS.team,
    league_id: IDS.league,
    name: "Alpha",
    name_normalized: "alpha",
    status: "active",
    primary_colour: "#112233",
    secondary_colour: "#ddeeff",
    logo_reference: null,
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  seedMembership(
    repositories,
    IDS.managerMembership,
    IDS.managerUser,
    "manager"
  );
  seedMembership(
    repositories,
    IDS.commissionerMembership,
    IDS.commissionerUser,
    "commissioner"
  );
  seedMembership(
    repositories,
    IDS.administratorMembership,
    IDS.administratorUser,
    "member"
  );
  repositories.platform_roles.insert({
    id: IDS.administratorRole,
    user_id: IDS.administratorUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id:
        IDS.commissionerMembership,
      current_season_id: IDS.season,
      updated_at_ms: NOW_MS,
    },
  });
  repositories.team_manager_assignments.insert({
    id: IDS.assignment,
    league_id: IDS.league,
    team_id: IDS.team,
    user_id: IDS.managerUser,
    membership_id: IDS.managerMembership,
    assigned_by_user_id: IDS.commissionerUser,
    replaces_assignment_id: null,
    status: "accepted",
    assigned_at_ms: NOW_MS - 1_000,
    accepted_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    version: 1,
  });
  repositories.players.insert({
    id: IDS.player,
    first_name: "Alex",
    last_name: "Example",
    full_name: "Alex Example",
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS - 1_000,
    updated_at_ms: NOW_MS - 1_000,
    version: 1,
  });
  repositories.player_source_state.insert({
    id: IDS.playerSource,
    player_id: IDS.player,
    provider: "test",
    source_position: "C",
    normalized_position: "F",
    nhl_team_abbreviation: "TST",
    active: 1,
    source_version: "one",
    source_payload_json: null,
    effective_at_ms: NOW_MS - 1_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 1_000,
  });
  createSqliteAuctionRepository({
    database: connection.database,
  }).startAuction({
    auctionId: IDS.auction,
    bidId: IDS.bid,
    eventId: IDS.startEvent,
    idempotencyRequestId: IDS.startIdempotency,
    leagueId: IDS.league,
    seasonId: IDS.season,
    teamId: IDS.team,
    playerId: IDS.player,
    actorUserId: IDS.managerUser,
    actorMembershipId: IDS.managerMembership,
    actorAuthority: "manager",
    aavCents: 200,
    termYears: 3,
    idempotencyKey: "open-auction",
    occurredAtMs: NOW_MS,
    idempotencyExpiresAtMs:
      NOW_MS + 24 * 60 * 60 * 1_000,
  });

  let generatedIdCount = 0;
  let nextGeneratedId = 9_000;
  const repository =
    createSqliteAuctionAdministrationRepository({
      database: connection.database,
      createId() {
        generatedIdCount += 1;
        nextGeneratedId += 1;
        return uuid(nextGeneratedId);
      },
      beforeCommit,
      leagueOutboxWriter,
      notificationWriter,
    });
  const fallbackWriter =
    createSqliteRestrictedNoImprovementFallbackWriter({
      database: connection.database,
      createDrawNonce() {
        return Buffer.alloc(32, 0x4f);
      },
      beforeCommit: fallbackBeforeCommit,
    });
  return {
    database: connection.database,
    repository,
    fallbackWriter,
    generatedIdCount() {
      return generatedIdCount;
    },
  };
}

const RESTRICTED_FIXTURE_TRIGGER_NAMES =
  Object.freeze([
    "auction_contexts_immutable_update",
    "free_agent_drafts_valid_insert",
    "candidate_card_snapshots_locked_insert",
    "candidate_card_snapshots_cap_state_insert",
    "candidate_card_snapshot_entries_source_insert",
    "free_agent_draft_rollovers_valid_insert",
    "free_agent_draft_allocations_pending_insert",
    "free_agent_draft_auction_participants_valid_insert",
    "free_agent_draft_draws_valid_insert",
  ]);

function installRestrictedContext(
  runtime,
  {
    fallbackReady = false,
    fallbackNeedsExtension = false,
  } = {}
) {
  assert.equal(
    fallbackNeedsExtension && !fallbackReady,
    false
  );
  const { database } = runtime;
  const triggerDefinitions =
    RESTRICTED_FIXTURE_TRIGGER_NAMES.map((name) => {
      const row = database
        .prepare(`
          SELECT sql
          FROM sqlite_schema
          WHERE type = 'trigger' AND name = ?
        `)
        .get(name);
      assert.equal(typeof row?.sql, "string");
      return row.sql;
    });
  database.pragma("foreign_keys = OFF");
  try {
    for (const name of RESTRICTED_FIXTURE_TRIGGER_NAMES) {
      database.exec(`DROP TRIGGER ${name}`);
    }
    const auction = auctionRow(database);
    if (fallbackReady) {
      const openedAtMs =
        auction.resolves_at_ms - 86_400_000;
      database
        .prepare(`
          UPDATE auctions
          SET opened_at_ms = ?,
              created_at_ms = ?,
              updated_at_ms = ?
          WHERE league_id = ? AND id = ?
        `)
        .run(
          openedAtMs,
          openedAtMs,
          openedAtMs,
          IDS.league,
          IDS.auction
        );
      auction.opened_at_ms = openedAtMs;
      auction.created_at_ms = openedAtMs;
      auction.updated_at_ms = openedAtMs;
    }
    const bid = bidRow(database);
    const existingTeam = database
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(IDS.team);
    insert(database, "teams", {
      ...existingTeam,
      id: IDS.secondTeam,
      name: "Bravo",
      name_normalized: "bravo",
    });
    const candidateDeadlineAtMs =
      fallbackNeedsExtension
        ? auction.resolves_at_ms -
          7 * 86_400_000
        : fallbackReady
        ? auction.opened_at_ms
        : auction.opened_at_ms - 1;
    const fadOpenedAtMs =
      candidateDeadlineAtMs - 7 * 86_400_000;
    insert(database, "free_agent_drafts", {
      id: IDS.fad,
      league_id: IDS.league,
      season_id: IDS.season,
      readiness_operation_id: IDS.fadReadiness,
      readiness_occurrence_key:
        `fad-readiness:${IDS.season}`,
      first_matchup_week_id: IDS.fadWeek,
      current_competition_first_matchup_week_id:
        IDS.fadWeek,
      schedule_recovery_id: null,
      participating_team_count: 2,
      status: "rapid",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason:
        "Synthetic restricted-auction fixture.",
      opening_authority: "system",
      opened_at_ms: fadOpenedAtMs,
      help_opens_at_ms:
        candidateDeadlineAtMs - 2 * 86_400_000,
      candidate_deadline_at_ms:
        candidateDeadlineAtMs,
      first_matchup_starts_at_ms:
        candidateDeadlineAtMs + 7 * 86_400_000,
      deadline_locked_at_ms: candidateDeadlineAtMs,
      allocation_completed_at_ms:
        auction.opened_at_ms,
      completed_at_ms: null,
      created_at_ms: fadOpenedAtMs,
      updated_at_ms: auction.opened_at_ms,
      version: 4,
    });
    for (const snapshot of [
      {
        id: IDS.snapshot,
        cardId: IDS.card,
        teamId: IDS.team,
      },
      {
        id: IDS.secondSnapshot,
        cardId: IDS.secondCard,
        teamId: IDS.secondTeam,
      },
    ]) {
      insert(database, "candidate_card_snapshots", {
        id: snapshot.id,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        card_id: snapshot.cardId,
        team_id: snapshot.teamId,
        locked_card_version: 3,
        locked_status: "locked_incomplete",
        completeness_code: "incomplete",
        filled_mandatory_count: 1,
        missing_mandatory_count: 17,
        filled_bench_count: 0,
        empty_bench_count: 4,
        blocking_validation_count: 0,
        structural_conflict_count: 0,
        cap_limit_cents: 100_000,
        carried_active_player_amount_cents: 0,
        retention_obligation_cents: 0,
        buyout_penalty_cents: 0,
        carried_cap_usage_cents: 0,
        proposed_candidate_aav_cents: 250,
        maximum_possible_cap_cents: 250,
        maximum_cap_space_cents: 99_750,
        effective_deadline_at_ms:
          candidateDeadlineAtMs,
        processed_at_ms: candidateDeadlineAtMs,
        created_at_ms: candidateDeadlineAtMs,
        carried_roster_structural_conflict_count: 0,
        cap_status: "compliant",
        allocation_eligibility: "eligible",
        allocation_exclusion_reason: null,
      });
    }
    for (const offer of [
      {
        id: IDS.snapshotEntry,
        snapshotId: IDS.snapshot,
        cardId: IDS.card,
        sourceEntryId: IDS.sourceEntry,
        teamId: IDS.team,
      },
      {
        id: IDS.secondSnapshotEntry,
        snapshotId: IDS.secondSnapshot,
        cardId: IDS.secondCard,
        sourceEntryId: IDS.secondSourceEntry,
        teamId: IDS.secondTeam,
      },
    ]) {
      insert(
        database,
        "candidate_card_snapshot_entries",
        {
          id: offer.id,
          league_id: IDS.league,
          season_id: IDS.season,
          fad_id: IDS.fad,
          snapshot_id: offer.snapshotId,
          card_id: offer.cardId,
          team_id: offer.teamId,
          row_kind: "slot",
          occupant_kind: "candidate",
          slot_group: "F",
          slot_number: 1,
          source_entry_id: offer.sourceEntryId,
          source_entry_version: 1,
          player_id: IDS.player,
          effective_position_group: "F",
          conflict_code: null,
          carryover_ownership_id: null,
          carryover_contract_id: null,
          source_roster_category: null,
          carryover_original_total_value_cents: null,
          carryover_original_term_years: null,
          carryover_aav_cents: null,
          remaining_years: null,
          proposed_total_value_cents: 500,
          proposed_term_years: 2,
          proposed_aav_cents: 250,
          eligibility_status: "valid",
          validation_code: null,
          last_edited_by_user_id: IDS.managerUser,
          last_edited_by_membership_id:
            IDS.managerMembership,
          last_edited_by_authority: "manager",
          last_edited_at_ms:
            candidateDeadlineAtMs - 1,
          created_at_ms: candidateDeadlineAtMs,
          allocation_eligibility: "eligible",
          allocation_exclusion_reason: null,
        }
      );
    }
    const rolloverRows = fallbackNeedsExtension
      ? [
          IDS.initialRollover1,
          IDS.initialRollover2,
          IDS.initialRollover3,
          IDS.initialRollover4,
          IDS.initialRollover5,
          IDS.initialRollover6,
          IDS.rollover,
        ].map((id, index) => ({
          id,
          sequence: index + 1,
          opensAtMs:
            candidateDeadlineAtMs +
            index * 86_400_000,
          rollsOverAtMs:
            candidateDeadlineAtMs +
            (index + 1) * 86_400_000,
        }))
      : [
          {
            id: IDS.rollover,
            sequence: 1,
            opensAtMs:
              auction.resolves_at_ms - 86_400_000,
            rollsOverAtMs: auction.resolves_at_ms,
          },
          {
            id: IDS.nextRollover,
            sequence: 2,
            opensAtMs: auction.resolves_at_ms,
            rollsOverAtMs:
              auction.resolves_at_ms + 86_400_000,
          },
        ];
    let predecessorRolloverId = null;
    for (const rollover of rolloverRows) {
      insert(database, "free_agent_draft_rollovers", {
        id: rollover.id,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        sequence: rollover.sequence,
        window_kind: "initial",
        predecessor_rollover_id:
          predecessorRolloverId,
        extension_reason: null,
        extension_source_id: null,
        opens_at_ms: rollover.opensAtMs,
        creation_cutoff_at_ms:
          rollover.rollsOverAtMs - 3_600_000,
        rolls_over_at_ms: rollover.rollsOverAtMs,
        status: "scheduled",
        processing_job_run_id: null,
        processing_started_at_ms: null,
        completed_at_ms: null,
        last_error_code: null,
        created_at_ms: fallbackNeedsExtension
          ? fadOpenedAtMs
          : auction.opened_at_ms,
        updated_at_ms: fallbackNeedsExtension
          ? fadOpenedAtMs
          : auction.opened_at_ms,
        version: 1,
      });
      predecessorRolloverId = rollover.id;
    }
    insert(
      database,
      "free_agent_draft_player_allocations",
      {
        id: IDS.allocation,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        player_id: IDS.player,
        status: "restricted_active",
        decision_code: "exact_total_and_term_tie",
        winning_snapshot_entry_id: null,
        winning_team_id: null,
        contract_id: null,
        ownership_id: null,
        restricted_auction_id: IDS.auction,
        fallback_open_auction_id: null,
        restricted_minimum_total_cents: 500,
        restricted_minimum_term_years: 2,
        restricted_minimum_aav_cents: 250,
        accounted_at_ms: null,
        last_error_code: null,
        created_at_ms: auction.opened_at_ms,
        updated_at_ms: auction.opened_at_ms,
        version: 2,
      }
    );
    database
      .prepare(`
        UPDATE auction_contexts
        SET source_kind = 'fad_restricted',
            fad_id = ?,
            fad_rollover_id = ?,
            fad_allocation_id = ?,
            fad_origin = 'candidate_tie_restricted',
            created_at_ms = ?
        WHERE league_id = ? AND auction_id = ?
      `)
      .run(
        IDS.fad,
        IDS.rollover,
        IDS.allocation,
        auction.opened_at_ms,
        IDS.league,
        IDS.auction
      );
    const nonceBytes = Buffer.alloc(32, 0x2a);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.auction,
        nonceBytes,
      });
    insert(database, "free_agent_draft_draws", {
      id: IDS.draw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      auction_id: IDS.auction,
      algorithm_version: 1,
      nonce_bytes: nonceBytes,
      commitment_hex: commitment.commitmentHex,
      ordered_tied_bid_ids_json: null,
      ordered_tied_team_ids_json: null,
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: null,
      created_at_ms: auction.opened_at_ms,
      updated_at_ms: auction.opened_at_ms,
      version: 1,
    });
    for (const participant of [
      {
        id: IDS.participant,
        teamId: IDS.team,
        snapshotEntryId: IDS.snapshotEntry,
        activeBidId: IDS.bid,
        firstImprovementAtMs:
          bid.first_submitted_at_ms,
        cooldownAnchorAtMs: bid.last_edited_at_ms,
        committedAtMs: bid.last_edited_at_ms,
      },
      {
        id: IDS.secondParticipant,
        teamId: IDS.secondTeam,
        snapshotEntryId: IDS.secondSnapshotEntry,
        activeBidId: null,
        firstImprovementAtMs: null,
        cooldownAnchorAtMs: null,
        committedAtMs: null,
      },
    ]) {
      insert(
        database,
        "free_agent_draft_auction_participants",
        {
          id: participant.id,
          league_id: IDS.league,
          season_id: IDS.season,
          fad_id: IDS.fad,
          allocation_id: IDS.allocation,
          auction_id: IDS.auction,
          team_id: participant.teamId,
          status: "active",
          source_snapshot_entry_id:
            participant.snapshotEntryId,
          originating_candidate_revision_id:
            IDS.candidateRevision,
          minimum_total_value_cents: 500,
          minimum_term_years: 2,
          minimum_aav_cents: 250,
          active_improvement_bid_id:
            participant.activeBidId,
          manager_edit_limit: 1,
          cooldown_duration_ms: 4_500_000,
          first_improvement_at_ms:
            participant.firstImprovementAtMs,
          current_cooldown_anchor_at_ms:
            participant.cooldownAnchorAtMs,
          improvement_committed_at_ms:
            participant.committedAtMs,
          originating_actor_user_id:
            IDS.managerUser,
          originating_actor_membership_id:
            IDS.managerMembership,
          originating_actor_authority: "manager",
          removed_by_user_id: null,
          removed_by_membership_id: null,
          removed_authority: null,
          removal_reason: null,
          removed_at_ms: null,
          created_at_ms: auction.opened_at_ms,
          updated_at_ms: auction.opened_at_ms,
          version: 2,
        }
      );
    }
    const allocationEventBase = {
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      allocation_version: 2,
      player_id: IDS.player,
      resulting_allocation_status: "restricted_active",
      contract_id: null,
      ownership_id: null,
      activity_id: null,
      correction_id: null,
      actor_user_id: null,
      actor_membership_id: null,
      actor_authority: "system",
      evidence_json: "{}",
      occurred_at_ms: auction.opened_at_ms,
      created_at_ms: auction.opened_at_ms,
      version: 1,
    };
    for (const offer of [
      {
        eventId: IDS.firstOfferEvent,
        snapshotEntryId: IDS.snapshotEntry,
        teamId: IDS.team,
      },
      {
        eventId: IDS.secondOfferEvent,
        snapshotEntryId: IDS.secondSnapshotEntry,
        teamId: IDS.secondTeam,
      },
    ]) {
      insert(
        database,
        "free_agent_draft_allocation_events",
        {
          ...allocationEventBase,
          id: offer.eventId,
          event_kind: "offer_considered",
          snapshot_entry_id: offer.snapshotEntryId,
          team_id: offer.teamId,
          offer_valid: 1,
          rank_position: 1,
          offer_outcome_code: "restricted_tied",
          decision_code: null,
          auction_id: null,
        }
      );
    }
    insert(
      database,
      "free_agent_draft_allocation_events",
      {
        ...allocationEventBase,
        id: IDS.restrictedStateEvent,
        event_kind: "restricted_state_changed",
        snapshot_entry_id: null,
        team_id: null,
        offer_valid: null,
        rank_position: null,
        offer_outcome_code: null,
        decision_code: "exact_total_and_term_tie",
        auction_id: IDS.auction,
      }
    );
  } finally {
    for (const sql of triggerDefinitions) {
      database.exec(sql);
    }
    database.pragma("foreign_keys = ON");
  }
  return Object.freeze({
    commitmentHex: database
      .prepare(`
        SELECT commitment_hex
        FROM free_agent_draft_draws
        WHERE id = ?
      `)
      .get(IDS.draw).commitment_hex,
  });
}

function installOpenRapidContext(
  runtime,
  {
    failed = true,
  } = {}
) {
  const { database } = runtime;
  const triggerNames = [
    "auction_contexts_immutable_update",
    "free_agent_drafts_valid_insert",
    "free_agent_draft_rollovers_valid_insert",
  ];
  const triggerDefinitions = triggerNames.map(
    (name) => {
      const row = database
        .prepare(`
          SELECT sql
          FROM sqlite_schema
          WHERE type = 'trigger' AND name = ?
        `)
        .get(name);
      assert.equal(typeof row?.sql, "string");
      return row.sql;
    }
  );
  const auction = auctionRow(database);
  const candidateDeadlineAtMs =
    auction.opened_at_ms - 1;
  const fadOpenedAtMs =
    candidateDeadlineAtMs - 7 * 86_400_000;
  database.pragma("foreign_keys = OFF");
  try {
    for (const name of triggerNames) {
      database.exec(`DROP TRIGGER ${name}`);
    }
    insert(database, "free_agent_drafts", {
      id: IDS.fad,
      league_id: IDS.league,
      season_id: IDS.season,
      readiness_operation_id: IDS.fadReadiness,
      readiness_occurrence_key:
        `fad-readiness:${IDS.season}`,
      first_matchup_week_id: IDS.fadWeek,
      current_competition_first_matchup_week_id:
        IDS.fadWeek,
      schedule_recovery_id: null,
      participating_team_count: 1,
      status: "rapid",
      setup_path: "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      prior_season_rollover_id: null,
      no_draft_reason:
        "Synthetic open-rapid auction fixture.",
      opening_authority: "system",
      opened_at_ms: fadOpenedAtMs,
      help_opens_at_ms:
        candidateDeadlineAtMs - 2 * 86_400_000,
      candidate_deadline_at_ms:
        candidateDeadlineAtMs,
      first_matchup_starts_at_ms:
        candidateDeadlineAtMs + 7 * 86_400_000,
      deadline_locked_at_ms: candidateDeadlineAtMs,
      allocation_completed_at_ms:
        auction.opened_at_ms,
      completed_at_ms: null,
      created_at_ms: fadOpenedAtMs,
      updated_at_ms: auction.opened_at_ms,
      version: 4,
    });
    insert(database, "free_agent_draft_rollovers", {
      id: IDS.rollover,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      sequence: 1,
      window_kind: "initial",
      predecessor_rollover_id: null,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms:
        auction.resolves_at_ms - 86_400_000,
      creation_cutoff_at_ms:
        auction.resolves_at_ms - 3_600_000,
      rolls_over_at_ms: auction.resolves_at_ms,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: auction.opened_at_ms,
      updated_at_ms: auction.opened_at_ms,
      version: 1,
    });
    database
      .prepare(`
        UPDATE auction_contexts
        SET source_kind = 'fad_open_rapid',
            fad_id = ?,
            fad_rollover_id = ?,
            fad_allocation_id = NULL,
            fad_origin = 'manager_nomination'
        WHERE league_id = ? AND auction_id = ?
      `)
      .run(
        IDS.fad,
        IDS.rollover,
        IDS.league,
        IDS.auction
      );
    const nonceBytes = Buffer.alloc(32, 0x3b);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.auction,
        nonceBytes,
      });
    insert(database, "free_agent_draft_draws", {
      id: IDS.draw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.auction,
      algorithm_version: 1,
      nonce_bytes: nonceBytes,
      commitment_hex: commitment.commitmentHex,
      ordered_tied_bid_ids_json: null,
      ordered_tied_team_ids_json: null,
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: null,
      created_at_ms: auction.opened_at_ms,
      updated_at_ms: auction.opened_at_ms,
      version: 1,
    });
  } finally {
    for (const sql of triggerDefinitions) {
      database.exec(sql);
    }
    database.pragma("foreign_keys = ON");
  }
  const failedAtMs = auction.resolves_at_ms;
  if (failed) {
    const occurrenceKey =
      `auction:${IDS.auction}:${auction.resolves_at_ms}`;
    insert(database, "job_runs", {
      id: IDS.openRapidResolutionJob,
      league_id: IDS.league,
      season_id: IDS.season,
      job_type: "auction.resolve.target",
      occurrence_key: occurrenceKey,
      scheduled_for_ms: auction.resolves_at_ms,
      status: "leased",
      attempt_count: 1,
      lease_owner: "open-rapid-failure-worker",
      lease_expires_at_ms: failedAtMs + 60_000,
      started_at_ms: failedAtMs,
      completed_at_ms: null,
      result_json: null,
      last_error_code: null,
      created_at_ms: auction.opened_at_ms,
      updated_at_ms: failedAtMs,
      version: 1,
      lease_token: IDS.openRapidFailureLeaseToken,
      next_attempt_at_ms: null,
    });
    database
      .prepare(`
        UPDATE auctions
        SET status = 'failed',
            updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ?
          AND id = ?
          AND status = 'open'
      `)
      .run(failedAtMs, IDS.league, IDS.auction);
    insert(database, "free_agent_draft_recoveries", {
      id: IDS.openRapidRecovery,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.player,
      allocation_id: null,
      rollover_id: IDS.rollover,
      auction_id: IDS.auction,
      job_run_id: IDS.openRapidResolutionJob,
      kind: "auction_resolution",
      status: "correction_required",
      earliest_activation_at_ms: null,
      target_resolution_at_ms: auction.resolves_at_ms,
      last_error_code:
        "AUCTION_RESOLUTION_FAILED",
      commissioner_reason: null,
      created_by_operation_id:
        IDS.openRapidResolutionJob,
      resolved_by_user_id: null,
      resolved_by_membership_id: null,
      resolved_authority: null,
      created_at_ms: failedAtMs,
      updated_at_ms: failedAtMs,
      resolved_at_ms: null,
      version: 1,
      nomination_queue_id: null,
    });
    database
      .prepare(`
        UPDATE job_runs
        SET status = 'failed',
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            lease_token = NULL,
            completed_at_ms = ?,
            result_json = NULL,
            last_error_code =
              'AUCTION_RESOLUTION_FAILED',
            next_attempt_at_ms = NULL,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
          AND status = 'leased'
      `)
      .run(
        failedAtMs,
        failedAtMs,
        IDS.openRapidResolutionJob
      );
    insert(database, "auction_events", {
      id: IDS.openRapidFailureEvent,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.auction,
      bid_id: null,
      team_id: null,
      actor_user_id: null,
      event_type:
        "fad_auction_resolution_failed",
      metadata_json: JSON.stringify({
        errorCode: "AUCTION_RESOLUTION_FAILED",
        jobRunId: IDS.openRapidResolutionJob,
        recoveryId: IDS.openRapidRecovery,
      }),
      occurred_at_ms: failedAtMs,
    });
  }
  return Object.freeze({
    commitmentHex: database
      .prepare(`
        SELECT commitment_hex
        FROM free_agent_draft_draws
        WHERE id = ?
      `)
      .get(IDS.draw).commitment_hex,
    failedAtMs,
  });
}

function installRepeatedOpenRapidFailure(runtime, fixture) {
  const failedAtMs = fixture.failedAtMs + 1_000;
  const retryStartedAtMs = failedAtMs - 1;
  withTableTriggersDisabled(
    runtime.database,
    ["auctions", "free_agent_draft_recoveries"],
    () => {
      const recovery = runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'correction_required',
              commissioner_reason =
                'Retry the failed direct rapid auction.',
              updated_at_ms = ?,
              version = version + 2
          WHERE league_id = ?
            AND id = ?
            AND status = 'correction_required'
            AND created_at_ms = ?
        `)
        .run(
          failedAtMs,
          IDS.league,
          IDS.openRapidRecovery,
          fixture.failedAtMs
        );
      assert.equal(recovery.changes, 1);
      const job = runtime.database
        .prepare(`
          UPDATE job_runs
          SET status = 'failed',
              attempt_count = attempt_count + 1,
              lease_owner = NULL,
              lease_expires_at_ms = NULL,
              lease_token = NULL,
              started_at_ms = ?,
              completed_at_ms = ?,
              result_json = NULL,
              last_error_code =
                'AUCTION_RESOLUTION_FAILED',
              next_attempt_at_ms = NULL,
              updated_at_ms = ?,
              version = version + 3
          WHERE league_id = ?
            AND id = ?
            AND status = 'failed'
        `)
        .run(
          retryStartedAtMs,
          failedAtMs,
          failedAtMs,
          IDS.league,
          IDS.openRapidResolutionJob
        );
      assert.equal(job.changes, 1);
      const auction = runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'failed',
              updated_at_ms = ?,
              version = version + 2
          WHERE league_id = ?
            AND id = ?
            AND status = 'failed'
        `)
        .run(
          failedAtMs,
          IDS.league,
          IDS.auction
        );
      assert.equal(auction.changes, 1);
      insert(runtime.database, "auction_events", {
        id: IDS.openRapidRepeatFailureEvent,
        league_id: IDS.league,
        season_id: IDS.season,
        auction_id: IDS.auction,
        bid_id: null,
        team_id: null,
        actor_user_id: null,
        event_type:
          "fad_auction_resolution_failed",
        metadata_json: JSON.stringify({
          errorCode: "AUCTION_RESOLUTION_FAILED",
          jobRunId: IDS.openRapidResolutionJob,
          recoveryId: IDS.openRapidRecovery,
        }),
        occurred_at_ms: failedAtMs,
      });
    }
  );
  return Object.freeze({
    ...fixture,
    latestFailedAtMs: failedAtMs,
  });
}

function installRestrictedResolutionLease(
  runtime,
  overrides = {}
) {
  const auction = auctionRow(runtime.database);
  const nowMs =
    overrides.nowMs ?? auction.resolves_at_ms;
  const jobRunId =
    overrides.jobRunId ??
    IDS.restrictedResolutionJob;
  const occurrenceKey =
    overrides.occurrenceKey ??
    `auction:${IDS.auction}:${auction.resolves_at_ms}`;
  const leaseOwner =
    overrides.leaseOwner ??
    "restricted-fallback-worker";
  const leaseToken =
    overrides.leaseToken ??
    IDS.restrictedResolutionLeaseToken;
  const expectedJobVersion =
    overrides.expectedJobVersion ?? 1;
  insert(runtime.database, "job_runs", {
    id: jobRunId,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "auction.resolve.target",
    occurrence_key: occurrenceKey,
    scheduled_for_ms: auction.resolves_at_ms,
    status: "running",
    attempt_count: overrides.attemptCount ?? 1,
    lease_owner: leaseOwner,
    lease_expires_at_ms:
      overrides.leaseExpiresAtMs ?? nowMs + 60_000,
    started_at_ms: nowMs,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: auction.opened_at_ms,
    updated_at_ms: nowMs,
    version: expectedJobVersion,
    lease_token: leaseToken,
    next_attempt_at_ms: null,
  });
  runtime.database
    .prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'open'
        AND version = ?
    `)
    .run(
      nowMs,
      IDS.league,
      IDS.auction,
      auction.version
    );
  return Object.freeze({
    nowMs,
    jobRunId,
    occurrenceKey,
    leaseOwner,
    leaseToken,
    expectedJobVersion,
    expectedAuctionVersion: auction.version + 1,
    expectedAllocationVersion: 2,
  });
}

function installRestrictedRolloverProcessingLease(
  runtime
) {
  const auction = auctionRow(runtime.database);
  const nowMs = auction.resolves_at_ms;
  const occurrenceKey =
    `fad:${IDS.fad}:rollover:7:${nowMs}`;
  const leaseOwner = "restricted-rollover-worker";
  insert(runtime.database, "job_runs", {
    id: IDS.rolloverProcessingJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "fad_rollover",
    occurrence_key: occurrenceKey,
    scheduled_for_ms: nowMs,
    status: "running",
    attempt_count: 1,
    lease_owner: leaseOwner,
    lease_expires_at_ms: nowMs + 60_000,
    started_at_ms: nowMs,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: auction.opened_at_ms,
    updated_at_ms: nowMs,
    version: 1,
    lease_token:
      IDS.rolloverProcessingLeaseToken,
    next_attempt_at_ms: null,
  });
  const transition = runtime.database
    .prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'processing',
          processing_job_run_id = ?,
          processing_started_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND season_id = ?
        AND fad_id = ?
        AND id = ?
        AND sequence = 7
        AND status = 'scheduled'
        AND version = 1
    `)
    .run(
      IDS.rolloverProcessingJob,
      nowMs,
      nowMs,
      IDS.league,
      IDS.season,
      IDS.fad,
      IDS.rollover
    );
  assert.equal(transition.changes, 1);
  return Object.freeze({
    nowMs,
    occurrenceKey,
    leaseOwner,
  });
}

function installDelayedRestrictedResolutionRecovery(
  runtime
) {
  const source = auctionRow(runtime.database);
  const recoveryId = uuid(92_001);
  const firstExtensionId = uuid(92_002);
  const predecessorRolloverId = uuid(92_003);
  const failureEventId = uuid(92_004);
  const idempotencyRequestId = uuid(92_005);
  const retryReceiptId = uuid(92_006);
  const activationAtMs =
    source.resolves_at_ms + 2 * DAY_MS;
  const executionAtMs =
    activationAtMs - 30 * 60 * 1_000;
  const leased = installRestrictedResolutionLease(
    runtime,
    {
      nowMs: executionAtMs - 1,
      leaseExpiresAtMs: activationAtMs + 60_000,
      attemptCount: 2,
      expectedJobVersion: 2,
    }
  );
  const recoveryCreatedAtMs =
    source.resolves_at_ms + 1;
  const acceptedAtMs = recoveryCreatedAtMs + 1;
  const requestData = {
    body: {
      action: "retry_auction_resolution",
      reason:
        "Retry the delayed restricted resolution.",
      resourceId: IDS.auction,
    },
    domain:
      "hundo-leago.free-agent-draft-recovery-action-request",
    fadId: IDS.fad,
    leagueId: IDS.league,
    schemaVersion: 1,
  };
  const responseData = {
    acceptedAtMs,
    action: "retry_auction_resolution",
    occurrenceKey: leased.occurrenceKey,
    operationId: leased.jobRunId,
    pollDescriptor: {
      fadId: IDS.fad,
      kind: "fad_recovery",
      leagueId: IDS.league,
    },
    resourceId: IDS.auction,
    status: "pending",
  };
  const requestJson = JSON.stringify(requestData);
  const responseJson = JSON.stringify(responseData);

  withTableTriggersDisabled(
    runtime.database,
    [
      "free_agent_draft_rollovers",
      "free_agent_draft_recoveries",
      "auction_events",
      "idempotency_requests",
      "free_agent_draft_recovery_action_command_results",
    ],
    () => {
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'recovery_required',
              completed_at_ms = ?,
              last_error_code =
                'AUCTION_RESOLUTION_RECOVERY_REQUIRED',
              updated_at_ms = ?,
              version = 3
          WHERE league_id = ? AND id = ?
        `)
        .run(
          recoveryCreatedAtMs,
          recoveryCreatedAtMs,
          IDS.league,
          IDS.rollover
        );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        {
          id: recoveryId,
          league_id: IDS.league,
          season_id: IDS.season,
          fad_id: IDS.fad,
          player_id: IDS.player,
          allocation_id: IDS.allocation,
          rollover_id: IDS.rollover,
          auction_id: IDS.auction,
          job_run_id: leased.jobRunId,
          kind: "auction_resolution",
          status: "running",
          earliest_activation_at_ms: null,
          target_resolution_at_ms:
            source.resolves_at_ms,
          last_error_code:
            "AUCTION_RESOLUTION_FAILED",
          commissioner_reason: null,
          created_by_operation_id: leased.jobRunId,
          resolved_by_user_id: null,
          resolved_by_membership_id: null,
          resolved_authority: null,
          created_at_ms: recoveryCreatedAtMs,
          updated_at_ms: executionAtMs - 1,
          resolved_at_ms: null,
          version: 2,
        }
      );
      insert(runtime.database, "auction_events", {
        id: failureEventId,
        league_id: IDS.league,
        season_id: IDS.season,
        auction_id: IDS.auction,
        bid_id: null,
        team_id: null,
        actor_user_id: null,
        event_type:
          "fad_auction_resolution_failed",
        metadata_json: JSON.stringify({
          errorCode: "AUCTION_RESOLUTION_FAILED",
          jobRunId: leased.jobRunId,
          recoveryId,
        }),
        occurred_at_ms: recoveryCreatedAtMs,
      });
      insert(
        runtime.database,
        "idempotency_requests",
        {
          id: idempotencyRequestId,
          league_id: IDS.league,
          actor_user_id: IDS.commissionerUser,
          operation:
            "free_agent_draft.recovery.action",
          client_key:
            `retry-delayed:${recoveryId}`,
          request_hash:
            hashCanonicalJsonV1(requestData),
          status: "completed",
          result_type:
            "free_agent_draft_recovery_action_command_result",
          result_id: retryReceiptId,
          created_at_ms: acceptedAtMs,
          completed_at_ms: acceptedAtMs,
          expires_at_ms: acceptedAtMs + DAY_MS,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_recovery_action_command_results",
        {
          id: retryReceiptId,
          league_id: IDS.league,
          season_id: IDS.season,
          fad_id: IDS.fad,
          recovery_id: recoveryId,
          idempotency_request_id:
            idempotencyRequestId,
          action: "retry_auction_resolution",
          resource_kind: "auction",
          resource_id: IDS.auction,
          operation_id: leased.jobRunId,
          job_run_id: leased.jobRunId,
          occurrence_key: leased.occurrenceKey,
          actor_user_id: IDS.commissionerUser,
          actor_membership_id:
            IDS.commissionerMembership,
          actor_authority: "commissioner",
          commissioner_reason:
            "Retry the delayed restricted resolution.",
          request_json: requestJson,
          request_sha256:
            hashCanonicalJsonV1(requestData),
          accepted_status: "pending",
          accepted_at_ms: acceptedAtMs,
          response_http_status: 202,
          response_json: responseJson,
          response_sha256:
            hashCanonicalJsonV1(responseData),
          version: 1,
        }
      );
      insertScheduledExtensionRollover(
        runtime.database,
        {
          id: firstExtensionId,
          sequence: 8,
          predecessorId: IDS.rollover,
          reason: "recovery",
          sourceId: recoveryId,
          opensAtMs: source.resolves_at_ms,
          createdAtMs: recoveryCreatedAtMs,
        }
      );
      insertScheduledExtensionRollover(
        runtime.database,
        {
          id: predecessorRolloverId,
          sequence: 9,
          predecessorId: firstExtensionId,
          reason: "restricted_auction",
          sourceId: IDS.allocation,
          opensAtMs:
            source.resolves_at_ms + DAY_MS,
          createdAtMs:
            source.resolves_at_ms + DAY_MS - 1,
        }
      );
    }
  );
  return Object.freeze({
    execution: Object.freeze({
      ...leased,
      nowMs: executionAtMs,
    }),
    recoveryId,
    predecessorRolloverId,
    activationAtMs,
  });
}

function removeRestrictedImprovementForFallback(
  runtime
) {
  const auction = auctionRow(runtime.database);
  const occurredAtMs = auction.opened_at_ms + 1;
  return runtime.repository.administer(
    commandFor(runtime, "remove_bid", {
      occurredAtMs,
      idempotencyKey:
        "admin-remove-bid-for-fallback",
      idempotencyExpiresAtMs:
        occurredAtMs + 86_400_000,
    })
  );
}

function participantRow(database, teamId = IDS.team) {
  return database
    .prepare(`
      SELECT *
      FROM free_agent_draft_auction_participants
      WHERE league_id = ? AND auction_id = ? AND team_id = ?
    `)
    .get(IDS.league, IDS.auction, teamId);
}

function auctionRow(database) {
  return database
    .prepare(
      "SELECT * FROM auctions WHERE id = ?"
    )
    .get(IDS.auction);
}

function bidRow(database) {
  return database
    .prepare(
      "SELECT * FROM auction_bids WHERE id = ?"
    )
    .get(IDS.bid);
}

function fadAllocationProjection(database, status) {
  const result =
    createSqliteFreeAgentDraftReadRepository({
      database,
    }).readAllocationResults({
      leagueId: IDS.league,
      fadId: IDS.fad,
      viewerUserId: IDS.commissionerUser,
      viewerMembershipId:
        IDS.commissionerMembership,
      nowMs: NOW_MS + 1,
      query: {
        cursor: null,
        limit: 50,
        q: "",
        status,
      },
    });
  assert.equal(result.page.hasMore, false);
  assert.equal(result.data.length, 1);
  assert.equal(
    result.data[0].allocationId,
    IDS.allocation
  );
  return result.data[0];
}

function allocationOfferEvents(database, version) {
  return database
    .prepare(`
      SELECT
        snapshot_entry_id,
        team_id,
        offer_valid,
        rank_position,
        offer_outcome_code
      FROM free_agent_draft_allocation_events
      WHERE league_id = ?
        AND allocation_id = ?
        AND allocation_version = ?
        AND event_kind = 'offer_considered'
      ORDER BY snapshot_entry_id
    `)
    .all(IDS.league, IDS.allocation, version);
}

function restrictedCancellationSnapshot(database) {
  return {
    auctions: database
      .prepare(
        "SELECT * FROM auctions WHERE league_id = ? ORDER BY id"
      )
      .all(IDS.league),
    auctionContexts: database
      .prepare(`
        SELECT *
        FROM auction_contexts
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    bids: database
      .prepare(`
        SELECT *
        FROM auction_bids
        WHERE league_id = ? AND auction_id = ?
        ORDER BY id
      `)
      .all(IDS.league, IDS.auction),
    participants: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_auction_participants
        WHERE league_id = ? AND auction_id = ?
        ORDER BY id
      `)
      .all(IDS.league, IDS.auction),
    allocation: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_player_allocations
        WHERE league_id = ? AND id = ?
      `)
      .get(IDS.league, IDS.allocation),
    allocationEvents: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_allocation_events
        WHERE league_id = ? AND allocation_id = ?
        ORDER BY allocation_version, event_kind, id
      `)
      .all(IDS.league, IDS.allocation),
    draw: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_draws
        WHERE league_id = ? AND auction_id = ?
      `)
      .get(IDS.league, IDS.auction),
    draws: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_draws
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    rollovers: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_rollovers
        WHERE league_id = ?
        ORDER BY sequence, id
      `)
      .all(IDS.league),
    resolutions: database
      .prepare(`
        SELECT *
        FROM auction_resolutions
        WHERE league_id = ? AND auction_id = ?
        ORDER BY id
      `)
      .all(IDS.league, IDS.auction),
    recoveries: database
      .prepare(`
        SELECT *
        FROM free_agent_draft_recoveries
        WHERE league_id = ? AND auction_id = ?
        ORDER BY id
      `)
      .all(IDS.league, IDS.auction),
    jobs: database
      .prepare(`
        SELECT *
        FROM job_runs
        WHERE league_id = ?
          AND job_type = 'auction.resolve.target'
        ORDER BY id
      `)
      .all(IDS.league),
    auctionEvents: database
      .prepare(`
        SELECT *
        FROM auction_events
        WHERE league_id = ? AND auction_id = ?
        ORDER BY id
      `)
      .all(IDS.league, IDS.auction),
    activities: database
      .prepare(`
        SELECT *
        FROM league_activity
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    notifications: database
      .prepare(`
        SELECT *
        FROM notifications
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    outboxEvents: database
      .prepare(`
        SELECT *
        FROM outbox_events
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    outboxAudiences: database
      .prepare(`
        SELECT *
        FROM outbox_event_audiences
        WHERE league_id = ?
        ORDER BY outbox_event_id, id
      `)
      .all(IDS.league),
    idempotencyRequests: adminRows(
      database,
      "idempotency_requests"
    ),
    commandResults: adminRows(
      database,
      "auction_administration_command_results"
    ),
    contracts: database
      .prepare(`
        SELECT *
        FROM contracts
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
    ownerships: database
      .prepare(`
        SELECT *
        FROM player_ownerships
        WHERE league_id = ?
        ORDER BY id
      `)
      .all(IDS.league),
  };
}

function bodyFor(action, overrides = {}) {
  if (action === "edit_bid") {
    return {
      teamId: IDS.team,
      aavCents: 300,
      termYears: 3,
      ...overrides,
    };
  }
  return {
    confirmation: {
      remove_bid: "REMOVE AUCTION BID",
      cancel_auction: "CANCEL AUCTION",
      request_resolution: "RESOLVE AUCTION",
    }[action],
    ...overrides,
  };
}

function commandFor(
  runtime,
  action,
  overrides = {}
) {
  const auction = auctionRow(runtime.database);
  const bid = bidRow(runtime.database);
  const bidAction = [
    "edit_bid",
    "remove_bid",
  ].includes(action);
  const occurredAtMs =
    overrides.occurredAtMs ??
    (action === "request_resolution"
      ? auction.resolves_at_ms
      : NOW_MS + 1);
  return {
    leagueId: IDS.league,
    auctionId: IDS.auction,
    bidId: bidAction ? IDS.bid : null,
    action,
    body: bodyFor(action),
    preconditionVersion: bidAction
      ? bid.version
      : auction.version,
    actorUserId: IDS.commissionerUser,
    actorMembershipId:
      IDS.commissionerMembership,
    idempotencyKey: `admin-${action}`,
    occurredAtMs,
    idempotencyExpiresAtMs:
      occurredAtMs + 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

function replayInputFor(command) {
  return {
    leagueId: command.leagueId,
    auctionId: command.auctionId,
    bidId: command.bidId,
    action: command.action,
    body: command.body,
    preconditionVersion:
      command.preconditionVersion,
    actorUserId: command.actorUserId,
    actorMembershipId:
      command.actorMembershipId,
    idempotencyKey:
      command.idempotencyKey,
  };
}

function restrictedFallbackIds(overrides = {}) {
  return {
    fallbackAuctionId: IDS.fallbackAuction,
    fallbackDrawId: IDS.fallbackDraw,
    sourceResolutionId: IDS.fallbackResolution,
    sourceAuctionEventId: IDS.fallbackSourceEvent,
    allocationStateEventId:
      IDS.fallbackStateEvent,
    activityId: IDS.fallbackActivity,
    fadOutboxEventId: IDS.fallbackFadOutbox,
    auctionOutboxEventId:
      IDS.fallbackAuctionOutbox,
    extensionRolloverId: null,
    fallbackActivationJobRunId: null,
    fallbackResolutionJobRunId:
      IDS.fallbackResolutionJob,
    clonedOfferEventIds: [
      IDS.fallbackFirstOfferEvent,
      IDS.fallbackSecondOfferEvent,
    ],
    notificationIds: [
      IDS.fallbackNotification,
    ],
    ...overrides,
  };
}

function restrictedFallbackCommand(
  execution,
  overrides = {}
) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    sourceAuctionId: IDS.auction,
    occurrenceKey: execution.occurrenceKey,
    jobRunId: execution.jobRunId,
    leaseOwner: execution.leaseOwner,
    leaseToken: execution.leaseToken,
    expectedJobVersion:
      execution.expectedJobVersion,
    expectedAuctionVersion:
      execution.expectedAuctionVersion,
    expectedAllocationVersion:
      execution.expectedAllocationVersion,
    nowMs: execution.nowMs,
    ids: restrictedFallbackIds(),
    ...overrides,
  };
}

function openRestrictedFallback(
  runtime,
  command
) {
  return runtime.database
    .transaction(() =>
      runtime.fallbackWriter.openFallback(command)
    )
    .immediate();
}

function freshRestrictedFallbackIds() {
  return restrictedFallbackIds({
    fallbackAuctionId: uuid(90_001),
    fallbackDrawId: uuid(90_002),
    sourceResolutionId: uuid(90_003),
    sourceAuctionEventId: uuid(90_004),
    allocationStateEventId: uuid(90_005),
    activityId: uuid(90_006),
    fadOutboxEventId: uuid(90_007),
    auctionOutboxEventId: uuid(90_008),
    fallbackResolutionJobRunId: uuid(90_009),
    clonedOfferEventIds: [
      uuid(90_010),
      uuid(90_011),
    ],
    notificationIds: [uuid(90_012)],
  });
}

function cloneRestrictedFallbackSource(runtime) {
  const ids = Object.freeze({
    player: uuid(93_001),
    auction: uuid(93_002),
    allocation: uuid(93_003),
    draw: uuid(93_004),
    firstOfferEvent: uuid(93_005),
    secondOfferEvent: uuid(93_006),
    stateEvent: uuid(93_007),
    resolutionJob: uuid(93_008),
    leaseToken: uuid(93_009),
    fallbackAuction: uuid(93_010),
    fallbackDraw: uuid(93_011),
    sourceResolution: uuid(93_012),
    sourceAuctionEvent: uuid(93_013),
    allocationStateEvent: uuid(93_014),
    activity: uuid(93_015),
    fadOutbox: uuid(93_016),
    auctionOutbox: uuid(93_017),
    fallbackResolutionJob: uuid(93_018),
    clonedFirstOffer: uuid(93_019),
    clonedSecondOffer: uuid(93_020),
    notification: uuid(93_021),
  });
  const sourceAuction = auctionRow(runtime.database);
  const sourceAllocation = runtime.database
    .prepare(`
      SELECT *
      FROM free_agent_draft_player_allocations
      WHERE league_id = ? AND id = ?
    `)
    .get(IDS.league, IDS.allocation);
  const sourceContext = runtime.database
    .prepare(`
      SELECT *
      FROM auction_contexts
      WHERE league_id = ? AND auction_id = ?
    `)
    .get(IDS.league, IDS.auction);
  const sourceDraw = runtime.database
    .prepare(`
      SELECT *
      FROM free_agent_draft_draws
      WHERE league_id = ? AND auction_id = ?
    `)
    .get(IDS.league, IDS.auction);
  const sourceEvents = runtime.database
    .prepare(`
      SELECT *
      FROM free_agent_draft_allocation_events
      WHERE league_id = ?
        AND allocation_id = ?
        AND allocation_version = 2
      ORDER BY event_kind, snapshot_entry_id, id
    `)
    .all(IDS.league, IDS.allocation);
  const nonceBytes = Buffer.alloc(32, 0x5a);
  const commitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: ids.auction,
      nonceBytes,
    });

  withTableTriggersDisabled(
    runtime.database,
    [
      "players",
      "auctions",
      "auction_contexts",
      "free_agent_draft_player_allocations",
      "free_agent_draft_draws",
      "free_agent_draft_allocation_events",
    ],
    () => {
      insert(runtime.database, "players", {
        ...runtime.database
          .prepare("SELECT * FROM players WHERE id = ?")
          .get(IDS.player),
        id: ids.player,
        first_name: "Blake",
        last_name: "Example",
        full_name: "Blake Example",
      });
      insert(runtime.database, "auctions", {
        ...sourceAuction,
        id: ids.auction,
        player_id: ids.player,
      });
      insert(
        runtime.database,
        "free_agent_draft_player_allocations",
        {
          ...sourceAllocation,
          id: ids.allocation,
          player_id: ids.player,
          restricted_auction_id: ids.auction,
        }
      );
      insert(runtime.database, "auction_contexts", {
        ...sourceContext,
        id: ids.auction,
        auction_id: ids.auction,
        fad_allocation_id: ids.allocation,
      });
      insert(
        runtime.database,
        "free_agent_draft_draws",
        {
          ...sourceDraw,
          id: ids.draw,
          allocation_id: ids.allocation,
          auction_id: ids.auction,
          nonce_bytes: nonceBytes,
          commitment_hex: commitment.commitmentHex,
        }
      );
      const eventIds = [
        ids.firstOfferEvent,
        ids.secondOfferEvent,
        ids.stateEvent,
      ];
      for (
        let index = 0;
        index < sourceEvents.length;
        index += 1
      ) {
        const event = sourceEvents[index];
        insert(
          runtime.database,
          "free_agent_draft_allocation_events",
          {
            ...event,
            id: eventIds[index],
            allocation_id: ids.allocation,
            player_id: ids.player,
            auction_id:
              event.auction_id === null
                ? null
                : ids.auction,
          }
        );
      }
    }
  );
  return ids;
}

function installClonedRestrictedResolutionLease(
  runtime,
  ids,
  nowMs
) {
  const occurrenceKey =
    `auction:${ids.auction}:${nowMs}`;
  insert(runtime.database, "job_runs", {
    id: ids.resolutionJob,
    league_id: IDS.league,
    season_id: IDS.season,
    job_type: "auction.resolve.target",
    occurrence_key: occurrenceKey,
    scheduled_for_ms: nowMs,
    status: "running",
    attempt_count: 1,
    lease_owner: "second-fallback-worker",
    lease_expires_at_ms: nowMs + 60_000,
    started_at_ms: nowMs,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: nowMs - DAY_MS,
    updated_at_ms: nowMs,
    version: 1,
    lease_token: ids.leaseToken,
    next_attempt_at_ms: null,
  });
  const changed = runtime.database
    .prepare(`
      UPDATE auctions
      SET status = 'resolving',
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND status = 'open'
        AND version = 1
    `)
    .run(nowMs, IDS.league, ids.auction);
  assert.equal(changed.changes, 1);
  return Object.freeze({
    nowMs,
    jobRunId: ids.resolutionJob,
    occurrenceKey,
    leaseOwner: "second-fallback-worker",
    leaseToken: ids.leaseToken,
    expectedJobVersion: 1,
    expectedAuctionVersion: 2,
    expectedAllocationVersion: 2,
  });
}

function clonedRestrictedFallbackCommand(
  ids,
  execution
) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    allocationId: ids.allocation,
    sourceAuctionId: ids.auction,
    occurrenceKey: execution.occurrenceKey,
    jobRunId: execution.jobRunId,
    leaseOwner: execution.leaseOwner,
    leaseToken: execution.leaseToken,
    expectedJobVersion:
      execution.expectedJobVersion,
    expectedAuctionVersion:
      execution.expectedAuctionVersion,
    expectedAllocationVersion:
      execution.expectedAllocationVersion,
    nowMs: execution.nowMs,
    ids: {
      fallbackAuctionId: ids.fallbackAuction,
      fallbackDrawId: ids.fallbackDraw,
      sourceResolutionId: ids.sourceResolution,
      sourceAuctionEventId:
        ids.sourceAuctionEvent,
      allocationStateEventId:
        ids.allocationStateEvent,
      activityId: ids.activity,
      fadOutboxEventId: ids.fadOutbox,
      auctionOutboxEventId: ids.auctionOutbox,
      extensionRolloverId: null,
      fallbackActivationJobRunId: null,
      fallbackResolutionJobRunId:
        ids.fallbackResolutionJob,
      clonedOfferEventIds: [
        ids.clonedFirstOffer,
        ids.clonedSecondOffer,
      ],
      notificationIds: [ids.notification],
    },
  };
}

function storedResult(database) {
  const row = database
    .prepare(`
      SELECT *
      FROM auction_administration_command_results
      ORDER BY created_at_ms DESC, id DESC
      LIMIT 1
    `)
    .get();
  return validateAuctionAdministrationStoredResult({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    auctionId: row.auction_id,
    bidId: row.bid_id,
    idempotencyRequestId:
      row.idempotency_request_id,
    jobRunId: row.job_run_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    actorAuthority: row.actor_authority,
    requestSha256: row.request_sha256,
    preconditionKind: row.precondition_kind,
    expectedResourceVersion:
      row.expected_resource_version,
    resultingResourceVersion:
      row.resulting_resource_version,
    responseHttpStatus: row.response_http_status,
    responseJson: row.response_json,
    responseSha256: row.response_sha256,
    createdAtMs: row.created_at_ms,
    version: row.version,
  });
}

describe(
  "FAD-06 SQLite auction administration repository",
  () => {
    test(
      "edits one ordinary bid and commits the exact immutable response last",
      (t) => {
        const runtime = createRuntime(t);
        const command = commandFor(
          runtime,
          "edit_bid"
        );
        const result =
          runtime.repository.administer(command);

        assert.equal(result.replayed, false);
        assert.equal(result.httpStatus, 200);
        assert.equal(result.actorAuthority, "commissioner");
        assert.equal(
          result.evidence.preconditionKind,
          "bid"
        );
        assert.equal(
          result.evidence.expectedResourceVersion,
          1
        );
        assert.equal(
          result.evidence.resultingResourceVersion,
          2
        );
        assert.equal(result.data.status, "active");
        assert.equal(
          result.data.sourceKind,
          "ordinary_weekly"
        );
        assert.equal(result.data.bidCount, 1);
        assert.equal(
          result.data.administrativeBids.length,
          1
        );
        assert.deepEqual(
          Object.keys(
            result.data.administrativeBids[0]
          ).sort(),
          [
            "bidId",
            "capabilities",
            "participantStatus",
            "status",
            "team",
            "teamId",
            "version",
          ]
        );
        assert.equal(
          "totalValueCents" in
            result.data.administrativeBids[0],
          false
        );

        const bid = bidRow(runtime.database);
        assert.deepEqual(
          {
            total: bid.total_value_cents,
            term: bid.term_years,
            lowest: bid.lowest_offered_aav_cents,
            editCount: bid.edit_count,
            status: bid.status,
            version: bid.version,
          },
          {
            total: 900,
            term: 3,
            lowest: 200,
            editCount: 0,
            status: "active",
            version: 2,
          }
        );
        const event = runtime.database
          .prepare(`
            SELECT *
            FROM auction_events
            WHERE event_type = 'bid_edited'
          `)
          .get();
        assert.equal(
          JSON.parse(event.metadata_json)
            .actorAuthority,
          "commissioner"
        );

        const stored = storedResult(runtime.database);
        assert.equal(
          stored.requestSha256,
          hashAuctionAdministrationRequest({
            leagueId: command.leagueId,
            auctionId: command.auctionId,
            bidId: command.bidId,
            action: command.action,
            preconditionKind: "bid",
            preconditionVersion:
              command.preconditionVersion,
            body: command.body,
          })
        );
        assert.equal(
          stored.responseSha256,
          hashCanonicalJsonV1(result.data)
        );
        const idempotency = adminRows(
          runtime.database,
          "idempotency_requests"
        )[0];
        assert.equal(idempotency.status, "completed");
        assert.equal(
          idempotency.result_type,
          "auction_administration_command_result"
        );
        assert.equal(
          idempotency.result_id,
          stored.id
        );
      }
    );

    test(
      "replays immutable status and body after later correction and cancellation before mutable reads or IDs and retains the transactional race fallback",
      (t) => {
        const runtime = createRuntime(t);
        const command = commandFor(
          runtime,
          "edit_bid"
        );
        const first =
          runtime.repository.administer(command);
        runtime.database
          .prepare(`
            UPDATE auction_bids
            SET total_value_cents = 1200,
                term_years = 3,
                last_edited_at_ms =
                  last_edited_at_ms + 1,
                version = version + 1
            WHERE id = ?
          `)
          .run(IDS.bid);
        const cancellation =
          runtime.repository.administer(
            commandFor(
              runtime,
              "cancel_auction",
              {
                idempotencyKey:
                  "later-cancellation-after-edit",
                occurredAtMs:
                  command.occurredAtMs + 1,
                idempotencyExpiresAtMs:
                  command.idempotencyExpiresAtMs +
                  1,
              }
            )
          );

        assert.equal(first.data.status, "active");
        assert.equal(
          cancellation.data.auction.status,
          "cancelled"
        );
        assert.deepEqual(
          {
            auctionStatus:
              auctionRow(runtime.database)
                .status,
            bidStatus:
              bidRow(runtime.database).status,
          },
          {
            auctionStatus: "cancelled",
            bidStatus: "cancelled",
          }
        );

        runtime.database.exec(`
          DROP TRIGGER auction_contexts_immutable_update;
          PRAGMA ignore_check_constraints = ON;
        `);
        runtime.database
          .prepare(`
            UPDATE auction_contexts
            SET source_kind = 'fad_restricted'
            WHERE auction_id = ?
          `)
          .run(IDS.auction);
        const generatedAfterLaterState =
          runtime.generatedIdCount();

        const replayed =
          runtime.repository.findReplay(
            replayInputFor(command)
          );
        assert.equal(replayed.replayed, true);
        assert.equal(
          replayed.evidence.resultingResourceVersion,
          2
        );
        assert.equal(
          replayed.httpStatus,
          first.httpStatus
        );
        assert.equal(
          replayed.data.status,
          "active"
        );
        assert.equal(
          replayed.data
            .administrativeBids[0].version,
          2
        );
        assert.deepEqual(replayed.data, first.data);
        assert.equal(
          runtime.generatedIdCount(),
          generatedAfterLaterState
        );

        const racedReplay =
          runtime.repository.administer(command);
        assert.equal(
          racedReplay.replayed,
          true
        );
        assert.deepEqual(
          racedReplay.data,
          first.data
        );
        assert.equal(
          runtime.generatedIdCount(),
          generatedAfterLaterState
        );

        const changed = {
          ...command,
          body: {
            ...command.body,
            aavCents: 1_500,
          },
        };
        assertRepositoryError(
          () =>
            runtime.repository.findReplay(
              replayInputFor(changed)
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .idempotencyConflict
        );
        assertRepositoryError(
          () =>
            runtime.repository.findReplay({
              ...replayInputFor(command),
              actorUserId: IDS.managerUser,
              actorMembershipId:
                IDS.managerMembership,
            }),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .authorizationDenied
        );

        runtime.database
          .prepare(`
            UPDATE league_memberships
            SET status = 'suspended',
                ended_at_ms = @endedAtMs,
                updated_at_ms = @endedAtMs,
                version = version + 1
            WHERE id = @membershipId
          `)
          .run({
            endedAtMs:
              command.occurredAtMs + 2,
            membershipId:
              IDS.commissionerMembership,
          });
        assertRepositoryError(
          () =>
            runtime.repository.findReplay(
              replayInputFor(command)
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .authorizationDenied
        );
        assert.equal(
          adminRows(
            runtime.database,
            "auction_administration_command_results"
          ).length,
          2
        );
        assert.equal(
          runtime.generatedIdCount(),
          generatedAfterLaterState
        );
      }
    );

    test(
      "keeps managed-team join and edit capabilities closed in a frozen league response",
      (t) => {
        const runtime = createRuntime(t);
        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET user_id = ?, membership_id = ?,
                assigned_by_user_id = ?, version = version + 1
            WHERE id = ?
          `)
          .run(
            IDS.commissionerUser,
            IDS.commissionerMembership,
            IDS.commissionerUser,
            IDS.assignment
          );
        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen', version = version + 1,
                updated_at_ms = ?
            WHERE id = ?
          `)
          .run(NOW_MS + 1, IDS.league);

        const result = runtime.repository.administer(
          commandFor(runtime, "edit_bid")
        );

        assert.equal(result.data.viewerTeams.length, 1);
        assert.deepEqual(
          result.data.viewerTeams[0].join,
          {
            allowed: false,
            reasonCode: "LEAGUE_FROZEN",
          }
        );
        assert.deepEqual(
          result.data.viewerTeams[0].edit,
          {
            allowed: false,
            reasonCode: "LEAGUE_FROZEN",
          }
        );
        assert.equal(
          result.data.administrativeBids[0]
            .capabilities.adminEditBid.allowed,
          true
        );
        assert.equal(
          result.data.administrativeBids[0]
            .capabilities.adminRemoveBid.allowed,
          true
        );
        assert.equal(
          result.data.capabilities.adminCancel.allowed,
          true
        );
        assert.deepEqual(
          result.data.capabilities.adminResolve,
          {
            allowed: false,
            reasonCode: "PHASE_CLOSED",
          }
        );
      }
    );

    test(
      "removes an ordinary bid under inherited member-platform-administrator authority",
      (t) => {
        const runtime = createRuntime(t);
        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET user_id = ?, membership_id = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            IDS.administratorUser,
            IDS.administratorMembership,
            IDS.assignment
          );
        const command = commandFor(
          runtime,
          "remove_bid",
          {
            actorUserId: IDS.administratorUser,
            actorMembershipId:
              IDS.administratorMembership,
          }
        );
        const result =
          runtime.repository.administer(command);

        assert.equal(result.httpStatus, 200);
        assert.equal(
          result.actorAuthority,
          "platform_administrator_as_commissioner"
        );
        assert.equal(
          result.data.removedBidId,
          IDS.bid
        );
        assert.equal(
          result.data.restrictedParticipantStatus,
          null
        );
        assert.equal(
          result.data.fadAllocationVersion,
          null
        );
        assert.equal(
          result.data.auction.bidCount,
          0
        );
        assert.equal(
          result.data.auction
            .administrativeBids[0].status,
          "withdrawn"
        );
        assert.equal(
          result.data.auction.viewerTeams.length,
          1
        );
        assert.equal(
          result.data.auction.viewerTeams[0]
            .bid.status,
          "withdrawn"
        );
        assert.deepEqual(
          result.data.auction.viewerTeams[0].join,
          {
            allowed: true,
            reasonCode: null,
          }
        );
        assert.deepEqual(
          result.data.auction.viewerTeams[0].edit,
          {
            allowed: false,
            reasonCode: "PHASE_CLOSED",
          }
        );
        assert.deepEqual(
          {
            status: bidRow(runtime.database).status,
            version: bidRow(runtime.database).version,
          },
          {
            status: "withdrawn",
            version: 2,
          }
        );
        const event = runtime.database
          .prepare(`
            SELECT metadata_json
            FROM auction_events
            WHERE event_type =
              'commissioner_bid_removed'
          `)
          .get();
        assert.equal(
          JSON.parse(event.metadata_json)
            .actorAuthority,
          "platform_administrator_as_commissioner"
        );
        assert.equal(
          storedResult(runtime.database)
            .actorAuthority,
          "platform_administrator_as_commissioner"
        );
      }
    );

    test(
      "cancels an ordinary auction with terminal resolution and activity evidence",
      (t) => {
        const runtime = createRuntime(t);
        const command = commandFor(
          runtime,
          "cancel_auction"
        );
        const result =
          runtime.repository.administer(command);

        assert.equal(result.httpStatus, 200);
        assert.equal(
          result.evidence.preconditionKind,
          "auction"
        );
        assert.equal(
          result.evidence.expectedResourceVersion,
          1
        );
        assert.equal(
          result.evidence.resultingResourceVersion,
          2
        );
        assert.equal(
          result.data.auction.status,
          "cancelled"
        );
        assert.equal(
          result.data.auction.result.outcomeCode,
          "cancelled"
        );
        assert.equal(
          result.data.fadAllocation,
          null
        );
        assert.equal(result.data.recoveryId, null);
        assert.deepEqual(
          {
            status:
              auctionRow(runtime.database).status,
            version:
              auctionRow(runtime.database).version,
            bidStatus:
              bidRow(runtime.database).status,
          },
          {
            status: "cancelled",
            version: 2,
            bidStatus: "cancelled",
          }
        );
        const resolution = runtime.database
          .prepare(`
            SELECT *
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(IDS.auction);
        assert.equal(resolution.status, "cancelled");
        assert.equal(
          resolution.outcome_code,
          "recovered"
        );
        assert.equal(
          resolution.trigger_type,
          "commissioner"
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM league_activity
              WHERE event_type =
                'auction_cancelled'
            `)
            .get().count,
          1
        );
        assert.equal(
          result.data.auction.result.activityId,
          runtime.database
            .prepare(`
              SELECT id
              FROM league_activity
              WHERE event_type =
                'auction_cancelled'
            `)
            .get().id
        );
      }
    );

    test(
      "creates one due durable resolution job and replays its original pending descriptor",
      (t) => {
        const runtime = createRuntime(t);
        const command = commandFor(
          runtime,
          "request_resolution"
        );
        const first =
          runtime.repository.administer(command);

        assert.equal(first.httpStatus, 202);
        assert.equal(first.data.status, "pending");
        assert.equal(
          first.data.occurrenceKey,
          `auction:${IDS.auction}:${
            auctionRow(runtime.database)
              .resolves_at_ms
          }`
        );
        assert.equal(
          first.data.operationId,
          first.evidence.jobRunId
        );
        assert.equal(
          first.evidence.expectedResourceVersion,
          1
        );
        assert.equal(
          first.evidence.resultingResourceVersion,
          1
        );
        const job = runtime.database
          .prepare(
            "SELECT * FROM job_runs WHERE id = ?"
          )
          .get(first.data.operationId);
        assert.equal(job.status, "pending");
        assert.equal(
          job.job_type,
          "auction.resolve.target"
        );
        assert.equal(
          job.scheduled_for_ms,
          auctionRow(runtime.database)
            .resolves_at_ms
        );

        runtime.database
          .prepare(`
            UPDATE job_runs
            SET status = 'succeeded',
                started_at_ms = @startedAtMs,
                completed_at_ms = @completedAtMs,
                result_json = '{}',
                last_error_code = NULL,
                updated_at_ms = @completedAtMs,
                next_attempt_at_ms = NULL,
                version = version + 1
            WHERE id = @jobRunId
          `)
          .run({
            jobRunId: job.id,
            startedAtMs: command.occurredAtMs,
            completedAtMs:
              command.occurredAtMs + 1,
          });
        const generatedBeforeReplay =
          runtime.generatedIdCount();
        const replayed =
          runtime.repository.administer(command);
        assert.equal(replayed.replayed, true);
        assert.equal(replayed.data.status, "pending");
        assert.deepEqual(replayed.data, first.data);
        assert.equal(
          runtime.generatedIdCount(),
          generatedBeforeReplay
        );

        const alreadySucceeded =
          runtime.repository.administer({
            ...command,
            idempotencyKey:
              "admin-resolution-after-success",
            occurredAtMs:
              command.occurredAtMs + 2,
            idempotencyExpiresAtMs:
              command.idempotencyExpiresAtMs + 2,
          });
        assert.equal(
          alreadySucceeded.data.status,
          "already_succeeded"
        );
        assert.equal(
          alreadySucceeded.data.operationId,
          first.data.operationId
        );
      }
    );

    test(
      "rejects not-due, stale, and unauthorized requests before any administration write or ID generation",
      (t) => {
        const runtime = createRuntime(t);
        const baselineIdempotency =
          adminRows(
            runtime.database,
            "idempotency_requests"
          ).length;
        const baselineEvents = runtime.database
          .prepare(
            "SELECT COUNT(*) AS count FROM auction_events"
          )
          .get().count;

        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(
                runtime,
                "request_resolution",
                {
                  occurredAtMs: NOW_MS + 1,
                  idempotencyExpiresAtMs:
                    NOW_MS + 86_400_001,
                }
              )
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .notDue
        );
        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "remove_bid", {
                preconditionVersion: 99,
                idempotencyKey: "stale-removal",
              })
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .preconditionFailed
        );
        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "remove_bid", {
                actorUserId: IDS.managerUser,
                actorMembershipId:
                  IDS.managerMembership,
                idempotencyKey:
                  "manager-removal-denied",
              })
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .authorizationDenied
        );
        for (const leagueStatus of [
          "setup",
          "completed",
        ]) {
          runtime.database
            .prepare(
              "UPDATE leagues SET status = ? WHERE id = ?"
            )
            .run(leagueStatus, IDS.league);
          assertRepositoryError(
            () =>
              runtime.repository.administer(
                commandFor(runtime, "edit_bid", {
                  idempotencyKey:
                    `denied-${leagueStatus}`,
                })
              ),
            AUCTION_ADMINISTRATION_REPOSITORY_CODES
              .authorizationDenied
          );
        }
        assert.equal(
          adminRows(
            runtime.database,
            "idempotency_requests"
          ).length,
          baselineIdempotency
        );
        assert.equal(
          adminRows(
            runtime.database,
            "auction_administration_command_results"
          ).length,
          0
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT COUNT(*) AS count FROM auction_events"
            )
            .get().count,
          baselineEvents
        );
        assert.equal(runtime.generatedIdCount(), 0);
      }
    );

    test(
      "transaction authority rejects ended commissioner or platform-admin evidence before writes and before replay",
      (t) => {
        const variants = [
          {
            name: "commissioner",
            actorUserId: IDS.commissionerUser,
            actorMembershipId:
              IDS.commissionerMembership,
            tableName: "league_memberships",
            mutate(database) {
              database.prepare(`
                UPDATE league_memberships
                SET ended_at_ms = @endedAtMs,
                    updated_at_ms = @endedAtMs,
                    version = version + 1
                WHERE id = @membershipId
                  AND status = 'active'
              `).run({
                endedAtMs: NOW_MS,
                membershipId:
                  IDS.commissionerMembership,
              });
            },
          },
          {
            name: "platform-administrator",
            actorUserId: IDS.administratorUser,
            actorMembershipId:
              IDS.administratorMembership,
            tableName: "platform_roles",
            mutate(database) {
              database.prepare(`
                UPDATE platform_roles
                SET ended_at_ms = @endedAtMs,
                    version = version + 1
                WHERE id = @roleId
                  AND status = 'active'
              `).run({
                endedAtMs: NOW_MS,
                roleId: IDS.administratorRole,
              });
            },
          },
        ];

        for (const variant of variants) {
          const deniedRuntime = createRuntime(t);
          deniedRuntime.database.pragma(
            "ignore_check_constraints = ON"
          );
          try {
            withTableTriggersDisabled(
              deniedRuntime.database,
              [variant.tableName],
              () => variant.mutate(
                deniedRuntime.database
              )
            );
          } finally {
            deniedRuntime.database.pragma(
              "ignore_check_constraints = OFF"
            );
          }
          const deniedCommand = commandFor(
            deniedRuntime,
            "edit_bid",
            {
              actorUserId: variant.actorUserId,
              actorMembershipId:
                variant.actorMembershipId,
              idempotencyKey:
                `ended-${variant.name}-denied`,
            }
          );
          const beforeDenied =
            deniedRuntime.database.serialize();

          assertRepositoryError(
            () =>
              deniedRuntime.repository.administer(
                deniedCommand
              ),
            AUCTION_ADMINISTRATION_REPOSITORY_CODES
              .authorizationDenied
          );
          assert.equal(
            beforeDenied.equals(
              deniedRuntime.database.serialize()
            ),
            true
          );
          assert.equal(
            deniedRuntime.generatedIdCount(),
            0
          );

          const replayRuntime = createRuntime(t);
          const replayCommand = commandFor(
            replayRuntime,
            "edit_bid",
            {
              actorUserId: variant.actorUserId,
              actorMembershipId:
                variant.actorMembershipId,
              idempotencyKey:
                `ended-${variant.name}-replay`,
            }
          );
          replayRuntime.repository.administer(
            replayCommand
          );
          replayRuntime.database.pragma(
            "ignore_check_constraints = ON"
          );
          try {
            withTableTriggersDisabled(
              replayRuntime.database,
              [variant.tableName],
              () => variant.mutate(
                replayRuntime.database
              )
            );
          } finally {
            replayRuntime.database.pragma(
              "ignore_check_constraints = OFF"
            );
          }
          const beforeReplay =
            replayRuntime.database.serialize();
          const idsBeforeReplay =
            replayRuntime.generatedIdCount();

          assertRepositoryError(
            () =>
              replayRuntime.repository.findReplay(
                replayInputFor(replayCommand)
              ),
            AUCTION_ADMINISTRATION_REPOSITORY_CODES
              .authorizationDenied
          );
          assert.equal(
            beforeReplay.equals(
              replayRuntime.database.serialize()
            ),
            true
          );
          assert.equal(
            replayRuntime.generatedIdCount(),
            idsBeforeReplay
          );
        }
      }
    );

    test(
      "T-080 edits a restricted improvement above its immutable Candidate floor without consuming the manager edit",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installRestrictedContext(runtime);
        const initialAuction = auctionRow(runtime.database);
        const initialAllocation = runtime.database
          .prepare(`
            SELECT *
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(IDS.allocation);
        const initialParticipant = participantRow(
          runtime.database
        );

        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "edit_bid", {
                idempotencyKey: "restricted-before-open",
                occurredAtMs:
                  initialAuction.opened_at_ms - 1,
              })
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .auctionNotFound
        );
        assert.equal(runtime.generatedIdCount(), 0);

        const command = commandFor(
          runtime,
          "edit_bid"
        );
        const result =
          runtime.repository.administer(command);

        assert.equal(result.replayed, false);
        assert.equal(result.actorAuthority, "commissioner");
        assert.equal(
          result.data.sourceKind,
          "fad_restricted"
        );
        assert.equal(
          result.data.fadId,
          IDS.fad
        );
        assert.equal(
          result.data.fadRolloverId,
          IDS.rollover
        );
        assert.deepEqual(result.data.minimumContract, {
          totalValueCents: 500,
          termYears: 2,
          aavCents: 250,
        });
        assert.equal(
          result.data.drawCommitment,
          fixture.commitmentHex
        );
        assert.equal(result.data.eligibleTeams.length, 2);
        assert.equal(
          result.data.administrativeBids[0]
            .participantStatus,
          "active"
        );

        const bid = bidRow(runtime.database);
        assert.deepEqual(
          {
            totalValueCents: bid.total_value_cents,
            termYears: bid.term_years,
            lowestOfferedAavCents:
              bid.lowest_offered_aav_cents,
            editCount: bid.edit_count,
            version: bid.version,
          },
          {
            totalValueCents: 900,
            termYears: 3,
            lowestOfferedAavCents: 200,
            editCount: 0,
            version: 2,
          }
        );
        const participant = participantRow(
          runtime.database
        );
        assert.deepEqual(
          {
            status: participant.status,
            activeBidId:
              participant.active_improvement_bid_id,
            minimumTotal:
              participant.minimum_total_value_cents,
            minimumTerm: participant.minimum_term_years,
            minimumAav: participant.minimum_aav_cents,
            firstImprovementAtMs:
              participant.first_improvement_at_ms,
            cooldownAnchorAtMs:
              participant.current_cooldown_anchor_at_ms,
            committedAtMs:
              participant.improvement_committed_at_ms,
            version: participant.version,
          },
          {
            status: "active",
            activeBidId: IDS.bid,
            minimumTotal: 500,
            minimumTerm: 2,
            minimumAav: 250,
            firstImprovementAtMs:
              initialParticipant.first_improvement_at_ms,
            cooldownAnchorAtMs: command.occurredAtMs,
            committedAtMs: command.occurredAtMs,
            version: initialParticipant.version + 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT *
              FROM free_agent_draft_player_allocations
              WHERE id = ?
            `)
            .get(IDS.allocation),
          initialAllocation
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM auction_resolutions
              WHERE auction_id = ?
            `)
            .get(IDS.auction).count,
          0
        );
        const replay = runtime.repository.administer(
          command
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, result.data);
        assert.equal(
          storedResult(runtime.database).responseSha256,
          hashCanonicalJsonV1(result.data)
        );

        const rejected = createRuntime(t);
        installRestrictedContext(rejected);
        const rejectedSnapshot = {
          bid: bidRow(rejected.database),
          participant: participantRow(
            rejected.database
          ),
        };
        assertRepositoryError(
          () =>
            rejected.repository.administer(
              commandFor(rejected, "edit_bid", {
                body: bodyFor("edit_bid", {
                  aavCents: 250,
                  termYears: 2,
                }),
                idempotencyKey:
                  "restricted-floor-not-improved",
              })
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .stateConflict
        );
        assert.deepEqual(
          {
            bid: bidRow(rejected.database),
            participant: participantRow(
              rejected.database
            ),
          },
          rejectedSnapshot
        );
        assert.equal(
          adminRows(
            rejected.database,
            "idempotency_requests"
          ).length,
          0
        );
        assert.equal(rejected.generatedIdCount(), 0);
      }
    );

    test(
      "T-081 permanently removes a restricted participant with exact platform-admin authority and rolls back atomically",
      (t) => {
        const rollback = createRuntime(t, {
          beforeCommit() {
            throw new Error("restricted removal rollback");
          },
        });
        installRestrictedContext(rollback);
        assert.throws(
          () =>
            rollback.repository.administer(
              commandFor(rollback, "remove_bid", {
                idempotencyKey:
                  "restricted-remove-rollback",
              })
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.equal(
          bidRow(rollback.database).status,
          "active"
        );
        assert.equal(
          participantRow(rollback.database).status,
          "active"
        );
        assert.equal(
          adminRows(
            rollback.database,
            "auction_administration_command_results"
          ).length,
          0
        );

        const runtime = createRuntime(t);
        installRestrictedContext(runtime);
        const initialAllocation = runtime.database
          .prepare(`
            SELECT *
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(IDS.allocation);
        const initialParticipant = participantRow(
          runtime.database
        );
        const command = commandFor(
          runtime,
          "remove_bid",
          {
            actorUserId: IDS.administratorUser,
            actorMembershipId:
              IDS.administratorMembership,
            idempotencyKey:
              "restricted-platform-admin-remove",
          }
        );
        const result =
          runtime.repository.administer(command);

        assert.equal(
          result.actorAuthority,
          "platform_administrator_as_commissioner"
        );
        assert.equal(
          result.data.removedBidId,
          IDS.bid
        );
        assert.equal(
          result.data.restrictedParticipantStatus,
          "removed"
        );
        assert.equal(
          result.data.fadAllocationVersion,
          initialAllocation.version
        );
        assert.equal(
          result.data.auction.sourceKind,
          "fad_restricted"
        );
        assert.equal(
          result.data.auction.bidCount,
          0
        );
        const bid = bidRow(runtime.database);
        assert.equal(bid.status, "withdrawn");
        assert.equal(bid.edit_count, 0);
        const participant = participantRow(
          runtime.database
        );
        assert.deepEqual(
          {
            status: participant.status,
            activeBidId:
              participant.active_improvement_bid_id,
            minimumTotal:
              participant.minimum_total_value_cents,
            minimumTerm: participant.minimum_term_years,
            minimumAav: participant.minimum_aav_cents,
            firstImprovementAtMs:
              participant.first_improvement_at_ms,
            cooldownAnchorAtMs:
              participant.current_cooldown_anchor_at_ms,
            committedAtMs:
              participant.improvement_committed_at_ms,
            removedByUserId:
              participant.removed_by_user_id,
            removedByMembershipId:
              participant.removed_by_membership_id,
            removedAuthority:
              participant.removed_authority,
            removedAtMs: participant.removed_at_ms,
            version: participant.version,
          },
          {
            status: "removed",
            activeBidId: null,
            minimumTotal: 500,
            minimumTerm: 2,
            minimumAav: 250,
            firstImprovementAtMs:
              initialParticipant.first_improvement_at_ms,
            cooldownAnchorAtMs:
              initialParticipant.current_cooldown_anchor_at_ms,
            committedAtMs:
              initialParticipant.improvement_committed_at_ms,
            removedByUserId: IDS.administratorUser,
            removedByMembershipId:
              IDS.administratorMembership,
            removedAuthority:
              "platform_administrator_as_commissioner",
            removedAtMs: command.occurredAtMs,
            version: initialParticipant.version + 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT *
              FROM free_agent_draft_player_allocations
              WHERE id = ?
            `)
            .get(IDS.allocation),
          initialAllocation
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM auction_resolutions
              WHERE auction_id = ?
            `)
            .get(IDS.auction).count,
          0
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM auctions
              WHERE league_id = ? AND id <> ?
            `)
            .get(IDS.league, IDS.auction).count,
          0
        );
        const replay = runtime.repository.administer(
          command
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, result.data);
      }
    );

    test(
      "T-082 atomically quarantines a cancelled restricted auction and replays its immutable result",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installRestrictedContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const beforeParticipants =
          before.participants;
        const beforeDraw = before.draw;
        const beforeOffers = allocationOfferEvents(
          runtime.database,
          before.allocation.version
        );
        const command = commandFor(
          runtime,
          "cancel_auction",
          {
            idempotencyKey:
              "restricted-auction-cancel",
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(result.httpStatus, 200);
        assert.equal(result.replayed, false);
        assert.equal(
          result.actorAuthority,
          "commissioner"
        );
        assert.equal(
          result.data.auction.status,
          "correction_required"
        );
        assert.equal(
          result.data.auction.sourceKind,
          "fad_restricted"
        );
        assert.equal(
          result.data.auction.version,
          before.auctions[0].version + 1
        );
        assert.equal(
          result.data.auction.drawCommitment,
          fixture.commitmentHex
        );
        assert.equal(
          result.data.auction.result.outcomeCode,
          "correction_required"
        );
        assert.equal(
          result.data.auction.result.recoveryId,
          result.data.recoveryId
        );
        assert.equal(
          result.data.auction.result.drawEvidence
            .commitmentHex,
          fixture.commitmentHex
        );
        assert.equal(
          result.data.auction.result.drawEvidence.reveal,
          null
        );
        assert.equal(
          result.data.fadAllocation.allocationId,
          IDS.allocation
        );
        assert.equal(
          result.data.fadAllocation.status,
          "correction_required"
        );
        assert.equal(
          result.data.fadAllocation.recoveryStatus,
          "correction_required"
        );
        assert.equal(
          result.data.fadAllocation.allocationVersion,
          before.allocation.version + 1
        );

        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.equal(after.auctions.length, 1);
        assert.equal(after.auctions[0].status, "cancelled");
        assert.equal(after.bids.length, 1);
        assert.equal(after.bids[0].status, "cancelled");
        assert.equal(
          after.allocation.status,
          "correction_required"
        );
        assert.equal(
          after.allocation.last_error_code,
          "RESTRICTED_AUCTION_CANCELLED"
        );
        for (const field of [
          "decision_code",
          "winning_snapshot_entry_id",
          "winning_team_id",
          "contract_id",
          "ownership_id",
          "restricted_auction_id",
          "fallback_open_auction_id",
          "restricted_minimum_total_cents",
          "restricted_minimum_term_years",
          "restricted_minimum_aav_cents",
          "accounted_at_ms",
        ]) {
          assert.equal(
            after.allocation[field],
            before.allocation[field],
            field
          );
        }
        assert.deepEqual(after.draw, beforeDraw);
        assert.deepEqual(
          after.participants,
          beforeParticipants
        );
        assert.deepEqual(
          allocationOfferEvents(
            runtime.database,
            after.allocation.version
          ),
          beforeOffers
        );
        const stateEvents = after.allocationEvents.filter(
          (event) =>
            event.allocation_version ===
              after.allocation.version &&
            event.event_kind ===
              "restricted_state_changed"
        );
        assert.equal(stateEvents.length, 1);
        assert.equal(
          stateEvents[0].actor_user_id,
          IDS.commissionerUser
        );
        assert.equal(
          stateEvents[0].actor_membership_id,
          IDS.commissionerMembership
        );
        assert.equal(
          stateEvents[0].actor_authority,
          "commissioner"
        );
        assert.equal(after.recoveries.length, 1);
        assert.deepEqual(
          {
            id: after.recoveries[0].id,
            kind: after.recoveries[0].kind,
            status: after.recoveries[0].status,
            allocationId:
              after.recoveries[0].allocation_id,
            rolloverId:
              after.recoveries[0].rollover_id,
            auctionId:
              after.recoveries[0].auction_id,
            errorCode:
              after.recoveries[0].last_error_code,
            jobRunId:
              after.recoveries[0].job_run_id,
          },
          {
            id: result.data.recoveryId,
            kind: "auction_resolution",
            status: "correction_required",
            allocationId: IDS.allocation,
            rolloverId: IDS.rollover,
            auctionId: IDS.auction,
            errorCode:
              "RESTRICTED_AUCTION_CANCELLED",
            jobRunId: after.jobs[0].id,
          }
        );
        assert.equal(after.jobs.length, 1);
        assert.deepEqual(
          {
            type: after.jobs[0].job_type,
            occurrenceKey:
              after.jobs[0].occurrence_key,
            scheduledForMs:
              after.jobs[0].scheduled_for_ms,
            status: after.jobs[0].status,
            attempts: after.jobs[0].attempt_count,
            leaseOwner: after.jobs[0].lease_owner,
            leaseToken: after.jobs[0].lease_token,
            resultJson: after.jobs[0].result_json,
            errorCode:
              after.jobs[0].last_error_code,
            completedAtMs:
              after.jobs[0].completed_at_ms,
          },
          {
            type: "auction.resolve.target",
            occurrenceKey:
              `auction:${IDS.auction}:` +
              `${before.auctions[0].resolves_at_ms}`,
            scheduledForMs:
              before.auctions[0].resolves_at_ms,
            status: "failed",
            attempts: 1,
            leaseOwner: null,
            leaseToken: null,
            resultJson: null,
            errorCode:
              "RESTRICTED_AUCTION_CANCELLED",
            completedAtMs: command.occurredAtMs,
          }
        );
        assert.equal(after.resolutions.length, 1);
        assert.deepEqual(
          {
            status: after.resolutions[0].status,
            outcomeCode:
              after.resolutions[0].outcome_code,
            winningTeamId:
              after.resolutions[0].winning_team_id,
            winningBidId:
              after.resolutions[0].winning_bid_id,
            contractId:
              after.resolutions[0].contract_id,
            ownershipId:
              after.resolutions[0].ownership_id,
            warningsJson:
              after.resolutions[0].warnings_json,
            actorUserId:
              after.resolutions[0]
                .triggered_by_user_id,
          },
          {
            status: "cancelled",
            outcomeCode: "failed",
            winningTeamId: null,
            winningBidId: null,
            contractId: null,
            ownershipId: null,
            warningsJson: "[]",
            actorUserId: IDS.commissionerUser,
          }
        );
        assert.equal(
          after.auctionEvents.filter(
            (event) =>
              event.event_type ===
              "auction_cancelled"
          ).length,
          1
        );
        assert.equal(after.activities.length, 0);
        assert.equal(
          after.outboxEvents.filter(
            (event) =>
              event.event_type ===
              "activity.created"
          ).length,
          0
        );
        assert.equal(after.notifications.length, 1);
        const notification = after.notifications[0];
        const messageData = JSON.parse(
          notification.message_data_json
        );
        const notificationContract =
          createFreeAgentDraftNotificationContract({
            type: "fad_correction_required",
            recipientUserId: IDS.commissionerUser,
            messageData: {
              leagueId: IDS.league,
              seasonId: IDS.season,
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              auctionId: IDS.auction,
              recoveryId: result.data.recoveryId,
              playerId: IDS.player,
              errorCode:
                "RESTRICTED_AUCTION_CANCELLED",
              destination: {
                kind: "fad_recovery",
                leagueId: IDS.league,
                fadId: IDS.fad,
                recoveryId:
                  result.data.recoveryId,
              },
            },
          });
        assert.deepEqual(messageData, {
          ...notificationContract.messageData,
        });
        assert.deepEqual(
          {
            userId: notification.user_id,
            leagueId: notification.league_id,
            eventType: notification.event_type,
            relatedFeature:
              notification.related_feature,
            relatedRecordId:
              notification.related_record_id,
            deliveryStatus:
              notification.delivery_status,
            createdAtMs:
              notification.created_at_ms,
            readAtMs: notification.read_at_ms,
            deliveredAtMs:
              notification.delivered_at_ms,
            version: notification.version,
            deduplicationKey:
              notification.deduplication_key,
          },
          {
            userId: IDS.commissionerUser,
            leagueId: IDS.league,
            eventType: "fad_correction_required",
            relatedFeature: "free_agent_draft",
            relatedRecordId: IDS.fad,
            deliveryStatus: "pending",
            createdAtMs: command.occurredAtMs,
            readAtMs: null,
            deliveredAtMs: null,
            version: 1,
            deduplicationKey:
              notificationContract.deduplicationKey,
          }
        );
        assert.equal(
          Object.hasOwn(messageData, "teamId"),
          false
        );
        assert.equal(
          Object.hasOwn(messageData, "cardId"),
          false
        );
        assert.equal(after.outboxEvents.length, 1);
        assert.equal(after.outboxAudiences.length, 1);
        const publication = after.outboxEvents[0];
        assert.deepEqual(
          {
            type: publication.event_type,
            aggregateType:
              publication.aggregate_type,
            aggregateId: publication.aggregate_id,
            status: publication.status,
            attemptCount:
              publication.attempt_count,
            availableAtMs:
              publication.available_at_ms,
            publishedAtMs:
              publication.published_at_ms,
            lastErrorCode:
              publication.last_error_code,
            createdAtMs:
              publication.created_at_ms,
            version: publication.version,
          },
          {
            type: "notification.created",
            aggregateType: "notification",
            aggregateId: notification.id,
            status: "pending",
            attemptCount: 0,
            availableAtMs: command.occurredAtMs,
            publishedAtMs: null,
            lastErrorCode: null,
            createdAtMs: command.occurredAtMs,
            version: 1,
          }
        );
        assert.deepEqual(
          JSON.parse(publication.payload_json),
          createSocketEventEnvelope({
            eventId: publication.id,
            type: "notification.created",
            leagueId: IDS.league,
            resourceId: notification.id,
            version: 1,
            reasonCode: "auction_changed",
            occurredAt: command.occurredAtMs,
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              auctionId: IDS.auction,
              recoveryId: result.data.recoveryId,
            }),
          })
        );
        assert.deepEqual(
          {
            eventId:
              after.outboxAudiences[0]
                .outbox_event_id,
            kind: after.outboxAudiences[0]
              .audience_kind,
            teamId:
              after.outboxAudiences[0].team_id,
            userId:
              after.outboxAudiences[0].user_id,
          },
          {
            eventId: publication.id,
            kind: "user",
            teamId: null,
            userId: IDS.commissionerUser,
          }
        );
        assert.equal(after.contracts.length, 0);
        assert.equal(after.ownerships.length, 0);
        assert.equal(after.commandResults.length, 1);
        assert.equal(
          after.commandResults[0].job_run_id,
          null
        );
        assert.equal(
          storedResult(runtime.database).responseSha256,
          hashCanonicalJsonV1(result.data)
        );

        const idsBeforeReplay =
          runtime.generatedIdCount();
        const replay = runtime.repository.administer(
          command
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, result.data);
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeReplay
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          after
        );
      }
    );

    test(
      "T-082 notifies the current commissioner when a different platform administrator cancels a restricted auction",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime);
        const command = commandFor(
          runtime,
          "cancel_auction",
          {
            actorUserId: IDS.administratorUser,
            actorMembershipId:
              IDS.administratorMembership,
            idempotencyKey:
              "restricted-cancel-platform-admin",
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(
          result.actorAuthority,
          "platform_administrator_as_commissioner"
        );
        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.equal(after.notifications.length, 1);
        assert.equal(
          after.notifications[0].user_id,
          IDS.commissionerUser
        );
        assert.notEqual(
          after.notifications[0].user_id,
          command.actorUserId
        );
        assert.equal(after.outboxAudiences.length, 1);
        assert.deepEqual(
          {
            kind: after.outboxAudiences[0]
              .audience_kind,
            teamId:
              after.outboxAudiences[0].team_id,
            userId:
              after.outboxAudiences[0].user_id,
          },
          {
            kind: "user",
            teamId: null,
            userId: IDS.commissionerUser,
          }
        );
        assert.equal(after.activities.length, 0);
        assert.equal(
          after.allocationEvents.find(
            (event) =>
              event.event_kind ===
                "restricted_state_changed" &&
              event.resulting_allocation_status ===
                "correction_required"
          ).actor_user_id,
          IDS.administratorUser
        );
      }
    );

    test(
      "T-082 rejects stale current-commissioner recipients without any cancellation write",
      (t) => {
        const variants = [
          {
            name: "active membership with an end",
            mutate(database) {
              database.prepare(`
                UPDATE league_memberships
                SET ended_at_ms = @endedAtMs,
                    updated_at_ms = @endedAtMs,
                    version = version + 1
                WHERE id = @membershipId
              `).run({
                endedAtMs: NOW_MS,
                membershipId:
                  IDS.commissionerMembership,
              });
            },
          },
          {
            name: "inactive commissioner user",
            mutate(database) {
              database.prepare(`
                UPDATE users
                SET status = 'suspended',
                    updated_at_ms = @updatedAtMs,
                    version = version + 1
                WHERE id = @userId
              `).run({
                updatedAtMs: NOW_MS,
                userId: IDS.commissionerUser,
              });
            },
          },
          {
            name: "commissioner membership without join evidence",
            mutate(database) {
              database.prepare(`
                UPDATE league_memberships
                SET joined_at_ms = NULL,
                    updated_at_ms = @updatedAtMs,
                    version = version + 1
                WHERE id = @membershipId
              `).run({
                updatedAtMs: NOW_MS,
                membershipId:
                  IDS.commissionerMembership,
              });
            },
          },
          {
            name: "commissioner pointer permission mismatch",
            mutate(database) {
              database.prepare(`
                UPDATE league_memberships
                SET permission_category = 'member',
                    updated_at_ms = @updatedAtMs,
                    version = version + 1
                WHERE id = @membershipId
              `).run({
                updatedAtMs: NOW_MS,
                membershipId:
                  IDS.commissionerMembership,
              });
            },
          },
        ];

        for (const variant of variants) {
          const runtime = createRuntime(t);
          installRestrictedContext(runtime);
          runtime.database.pragma(
            "ignore_check_constraints = ON"
          );
          try {
            withTableTriggersDisabled(
              runtime.database,
              ["league_memberships", "users"],
              () => variant.mutate(runtime.database)
            );
          } finally {
            runtime.database.pragma(
              "ignore_check_constraints = OFF"
            );
          }
          const before = restrictedCancellationSnapshot(
            runtime.database
          );

          assert.throws(
            () =>
              runtime.repository.administer(
                commandFor(
                  runtime,
                  "cancel_auction",
                  {
                    actorUserId:
                      IDS.administratorUser,
                    actorMembershipId:
                      IDS.administratorMembership,
                    idempotencyKey:
                      `stale-recipient-${variant.name}`,
                  }
                )
              ),
            (error) =>
              error.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE"
          );
          assert.equal(runtime.generatedIdCount(), 0);
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            before
          );
        }
      }
    );

    test(
      "T-082 rolls the entire restricted cancellation back when either publication writer fails",
      (t) => {
        for (const variant of [
          {
            name: "notification",
            options: {
              notificationWriter: {
                insert() {
                  throw new Error(
                    "notification writer failed"
                  );
                },
              },
            },
          },
          {
            name: "outbox",
            options: {
              leagueOutboxWriter: {
                write() {
                  throw new Error(
                    "outbox writer failed"
                  );
                },
              },
            },
          },
        ]) {
          const runtime = createRuntime(
            t,
            variant.options
          );
          installRestrictedContext(runtime);
          const before = restrictedCancellationSnapshot(
            runtime.database
          );

          assert.throws(
            () =>
              runtime.repository.administer(
                commandFor(
                  runtime,
                  "cancel_auction",
                  {
                    idempotencyKey:
                      `${variant.name}-writer-rollback`,
                  }
                )
              ),
            (error) =>
              error.code ===
              "REPOSITORY_OPERATION_FAILED"
          );
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            before
          );
        }
      }
    );

    test(
      "T-082 replay rejects drift in immutable notification or user-scoped publication evidence without writing",
      (t) => {
        const variants = [
          {
            tableNames: ["notifications"],
            mutate(database) {
              database.prepare(`
                UPDATE notifications
                SET message_data_json = json_set(
                  message_data_json,
                  '$.playerId',
                  @playerId
                )
                WHERE league_id = @leagueId
                  AND event_type =
                    'fad_correction_required'
              `).run({
                leagueId: IDS.league,
                playerId: uuid(99_101),
              });
            },
          },
          {
            tableNames: ["outbox_events"],
            mutate(database) {
              database.prepare(`
                UPDATE outbox_events
                SET payload_json =
                  '{"kind":"invalidation"}'
                WHERE league_id = @leagueId
                  AND event_type =
                    'notification.created'
              `).run({ leagueId: IDS.league });
            },
          },
        ];

        for (const [index, variant] of
          variants.entries()) {
          const runtime = createRuntime(t);
          installRestrictedContext(runtime);
          const command = commandFor(
            runtime,
            "cancel_auction",
            {
              idempotencyKey:
                `restricted-publication-drift-${index}`,
            }
          );
          runtime.repository.administer(command);
          withTableTriggersDisabled(
            runtime.database,
            variant.tableNames,
            () => variant.mutate(runtime.database)
          );
          const beforeReplay =
            restrictedCancellationSnapshot(
              runtime.database
            );
          const idsBeforeReplay =
            runtime.generatedIdCount();

          assert.throws(
            () =>
              runtime.repository.administer(command),
            (error) =>
              error.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE"
          );
          assert.equal(
            runtime.generatedIdCount(),
            idsBeforeReplay
          );
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            beforeReplay
          );
        }
      }
    );

    test(
      "T-082 rolls every restricted cancellation write back after a late failure",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit() {
            throw new Error(
              "restricted cancellation rollback"
            );
          },
        });
        installRestrictedContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "cancel_auction", {
                idempotencyKey:
                  "restricted-cancel-rollback",
              })
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "T-082 keeps a healthy open-rapid auction non-cancellable without creating evidence",
      (t) => {
        const runtime = createRuntime(t);
        installOpenRapidContext(runtime, {
          failed: false,
        });
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "cancel_auction", {
                idempotencyKey:
                  "healthy-open-rapid-cancel",
              })
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .fadIntegrationRequired
        );
        assert.equal(runtime.generatedIdCount(), 0);
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "T-082 recovers an already-failed direct open-rapid auction as an empty no-selection cancellation",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installOpenRapidContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const failureEventBefore =
          before.auctionEvents.find(
            (event) =>
              event.event_type ===
              "fad_auction_resolution_failed"
          );
        const command = commandFor(
          runtime,
          "cancel_auction",
          {
            idempotencyKey:
              "failed-open-rapid-cancel",
            occurredAtMs: fixture.failedAtMs + 1,
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(result.httpStatus, 200);
        assert.equal(result.replayed, false);
        assert.equal(
          result.actorAuthority,
          "commissioner"
        );
        assert.equal(
          result.data.fadAllocation,
          null
        );
        assert.equal(
          result.data.recoveryId,
          IDS.openRapidRecovery
        );
        assert.equal(
          result.data.auction.sourceKind,
          "fad_open_rapid"
        );
        assert.equal(
          result.data.auction.fadOrigin,
          "manager_nomination"
        );
        assert.equal(
          result.data.auction.status,
          "cancelled"
        );
        assert.equal(
          result.data.auction.version,
          before.auctions[0].version + 2
        );
        assert.equal(
          result.data.auction.drawCommitment,
          fixture.commitmentHex
        );
        assert.equal(
          result.data.auction.result.outcomeCode,
          "cancelled"
        );
        assert.equal(
          result.data.auction.result.recoveryId,
          IDS.openRapidRecovery
        );
        assert.match(
          result.data.auction.result.activityId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
        assert.deepEqual(
          {
            commitmentHex:
              result.data.auction.result
                .drawEvidence.commitmentHex,
            selectionUsed:
              result.data.auction.result
                .drawEvidence.reveal.selectionUsed,
            orderedBidIds:
              result.data.auction.result
                .drawEvidence.reveal.orderedBidIds,
            counter:
              result.data.auction.result
                .drawEvidence.reveal.counter,
            digestHex:
              result.data.auction.result
                .drawEvidence.reveal.digestHex,
            selectedIndex:
              result.data.auction.result
                .drawEvidence.reveal.selectedIndex,
            selectedBidId:
              result.data.auction.result
                .drawEvidence.reveal.selectedBidId,
            selectedTeamId:
              result.data.auction.result
                .drawEvidence.reveal.selectedTeamId,
          },
          {
            commitmentHex: fixture.commitmentHex,
            selectionUsed: false,
            orderedBidIds: [],
            counter: null,
            digestHex: null,
            selectedIndex: null,
            selectedBidId: null,
            selectedTeamId: null,
          }
        );

        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.equal(after.auctions.length, 1);
        assert.deepEqual(
          {
            status: after.auctions[0].status,
            version: after.auctions[0].version,
            updatedAtMs:
              after.auctions[0].updated_at_ms,
          },
          {
            status: "cancelled",
            version: before.auctions[0].version + 2,
            updatedAtMs: command.occurredAtMs,
          }
        );
        assert.equal(after.bids.length, 1);
        assert.equal(after.bids[0].status, "cancelled");
        assert.equal(after.allocation, undefined);
        assert.equal(after.resolutions.length, 1);
        for (const field of [
          "winning_team_id",
          "winning_bid_id",
          "highest_bid_cents",
          "second_price_input_cents",
          "final_contract_value_cents",
          "winning_term_years",
          "final_aav_cents",
          "contract_id",
          "ownership_id",
        ]) {
          assert.equal(
            after.resolutions[0][field],
            null,
            field
          );
        }
        assert.deepEqual(
          {
            status: after.resolutions[0].status,
            outcomeCode:
              after.resolutions[0].outcome_code,
            triggerType:
              after.resolutions[0].trigger_type,
            actorUserId:
              after.resolutions[0]
                .triggered_by_user_id,
            warningsJson:
              after.resolutions[0].warnings_json,
            generalIllegal:
              after.resolutions[0].general_illegal,
          },
          {
            status: "cancelled",
            outcomeCode: "recovered",
            triggerType: "commissioner",
            actorUserId: IDS.commissionerUser,
            warningsJson: "[]",
            generalIllegal: 0,
          }
        );
        assert.deepEqual(
          {
            version: after.draw.version,
            tiedBids:
              after.draw.ordered_tied_bid_ids_json,
            tiedTeams:
              after.draw.ordered_tied_team_ids_json,
            counter: after.draw.rejection_counter,
            selectedIndex:
              after.draw.selected_index,
            selectedBidId:
              after.draw.selected_bid_id,
            selectedTeamId:
              after.draw.selected_team_id,
            digestHex:
              after.draw.selected_digest_hex,
            revealedAtMs:
              after.draw.revealed_at_ms,
          },
          {
            version: 2,
            tiedBids: "[]",
            tiedTeams: "[]",
            counter: null,
            selectedIndex: null,
            selectedBidId: null,
            selectedTeamId: null,
            digestHex: null,
            revealedAtMs: command.occurredAtMs,
          }
        );
        assert.equal(after.recoveries.length, 1);
        assert.deepEqual(
          {
            status: after.recoveries[0].status,
            errorCode:
              after.recoveries[0].last_error_code,
            resolvedByUserId:
              after.recoveries[0]
                .resolved_by_user_id,
            resolvedByMembershipId:
              after.recoveries[0]
                .resolved_by_membership_id,
            resolvedAuthority:
              after.recoveries[0]
                .resolved_authority,
            resolvedAtMs:
              after.recoveries[0].resolved_at_ms,
            version: after.recoveries[0].version,
          },
          {
            status: "resolved",
            errorCode: null,
            resolvedByUserId: IDS.commissionerUser,
            resolvedByMembershipId:
              IDS.commissionerMembership,
            resolvedAuthority: "commissioner",
            resolvedAtMs: command.occurredAtMs,
            version: before.recoveries[0].version + 2,
          }
        );
        assert.equal(after.jobs.length, 1);
        assert.deepEqual(
          {
            status: after.jobs[0].status,
            attempts: after.jobs[0].attempt_count,
            leaseOwner: after.jobs[0].lease_owner,
            leaseToken: after.jobs[0].lease_token,
            leaseExpiresAtMs:
              after.jobs[0].lease_expires_at_ms,
            completedAtMs:
              after.jobs[0].completed_at_ms,
            result: JSON.parse(
              after.jobs[0].result_json
            ),
            errorCode:
              after.jobs[0].last_error_code,
            nextAttemptAtMs:
              after.jobs[0].next_attempt_at_ms,
            version: after.jobs[0].version,
          },
          {
            status: "succeeded",
            attempts: before.jobs[0].attempt_count + 1,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            completedAtMs: command.occurredAtMs,
            result: {
              auctionId: IDS.auction,
              outcome: "cancelled",
            },
            errorCode: null,
            nextAttemptAtMs: null,
            version: before.jobs[0].version + 2,
          }
        );
        assert.deepEqual(
          after.auctionEvents.find(
            (event) =>
              event.event_type ===
              "fad_auction_resolution_failed"
          ),
          failureEventBefore
        );
        assert.equal(
          after.auctionEvents.filter(
            (event) =>
              event.event_type ===
              "auction_cancelled"
          ).length,
          1
        );
        assert.equal(after.activities.length, 1);
        const activity = after.activities[0];
        const fadVersion = runtime.database
          .prepare(`
            SELECT version
            FROM free_agent_drafts
            WHERE league_id = ? AND id = ?
          `)
          .get(IDS.league, IDS.fad).version;
        const activityContract =
          createFreeAgentDraftActivityContract({
            eventType: "free_agent_draft_corrected",
            metadata: {
              actorMembershipId:
                IDS.commissionerMembership,
              auctionId: IDS.auction,
              fadId: IDS.fad,
              fadVersion,
              outcomeCode: "cancelled",
              recoveryId: IDS.openRapidRecovery,
              schemaVersion: 1,
            },
          });
        assert.deepEqual(
          {
            id: activity.id,
            eventType: activity.event_type,
            actorUserId: activity.actor_user_id,
            actorAuthority:
              activity.actor_authority,
            teamId: activity.team_id,
            playerId: activity.player_id,
            relatedType: activity.related_type,
            relatedId: activity.related_id,
            displaySummary:
              activity.display_summary,
            reason: activity.reason,
            metadata:
              JSON.parse(activity.metadata_json),
            occurredAtMs:
              activity.occurred_at_ms,
          },
          {
            id: result.data.auction.result.activityId,
            eventType: activityContract.eventType,
            actorUserId: IDS.commissionerUser,
            actorAuthority: "commissioner",
            teamId: null,
            playerId: IDS.player,
            relatedType: "auction",
            relatedId: IDS.auction,
            displaySummary:
              "Alex Example's failed Free Agent Draft auction was cancelled and recovered.",
            reason: null,
            metadata: {
              ...activityContract.metadata,
            },
            occurredAtMs: command.occurredAtMs,
          }
        );
        assert.deepEqual(
          after.notifications,
          before.notifications
        );
        assert.equal(
          after.outboxEvents.length -
            before.outboxEvents.length,
          3
        );
        assert.equal(
          after.outboxAudiences.length -
            before.outboxAudiences.length,
          3
        );
        const related = createEmptySocketRelated({
          fadId: IDS.fad,
          auctionId: IDS.auction,
          recoveryId: IDS.openRapidRecovery,
        });
        const expectedPublications = [
          {
            type: "free_agent_draft.changed",
            aggregateType: "free_agent_draft",
            resourceId: IDS.fad,
            version: fadVersion,
            reasonCode: "correction_applied",
          },
          {
            type: "activity.created",
            aggregateType: "league_activity",
            resourceId: activity.id,
            version: 1,
            reasonCode: "correction_applied",
          },
          {
            type: "auction.changed",
            aggregateType: "auction",
            resourceId: IDS.auction,
            version: result.data.auction.version,
            reasonCode: "auction_changed",
          },
        ];
        const publications =
          after.outboxEvents.slice(
            before.outboxEvents.length
          );
        const audiences =
          after.outboxAudiences.slice(
            before.outboxAudiences.length
          );
        for (
          let index = 0;
          index < expectedPublications.length;
          index += 1
        ) {
          const publication = publications[index];
          const audience = audiences.find(
            (item) =>
              item.outbox_event_id === publication.id
          );
          const expected = expectedPublications[index];
          assert.deepEqual(
            {
              type: publication.event_type,
              aggregateType:
                publication.aggregate_type,
              resourceId:
                publication.aggregate_id,
              status: publication.status,
              attemptCount:
                publication.attempt_count,
              createdAtMs:
                publication.created_at_ms,
              version: publication.version,
              audienceKind:
                audience?.audience_kind,
              audienceTeamId: audience?.team_id,
              audienceUserId: audience?.user_id,
            },
            {
              type: expected.type,
              aggregateType:
                expected.aggregateType,
              resourceId: expected.resourceId,
              status: "pending",
              attemptCount: 0,
              createdAtMs: command.occurredAtMs,
              version: 1,
              audienceKind: "league",
              audienceTeamId: null,
              audienceUserId: null,
            }
          );
          assert.deepEqual(
            JSON.parse(publication.payload_json),
            createSocketEventEnvelope({
              eventId: publication.id,
              type: expected.type,
              leagueId: IDS.league,
              resourceId: expected.resourceId,
              version: expected.version,
              reasonCode: expected.reasonCode,
              occurredAt: command.occurredAtMs,
              related,
            })
          );
        }
        assert.equal(after.contracts.length, 0);
        assert.equal(after.ownerships.length, 0);
        assert.equal(after.commandResults.length, 1);
        assert.equal(
          after.commandResults[0].job_run_id,
          null
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM free_agent_draft_recoveries
              WHERE league_id = ?
                AND player_id = ?
                AND status IN (
                  'pending', 'ready', 'running',
                  'correction_required'
                )
            `)
            .get(IDS.league, IDS.player).count,
          0
        );

        const idsBeforeReplay =
          runtime.generatedIdCount();
        const replay = runtime.repository.administer(
          command
        );
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, result.data);
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeReplay
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          after
        );
      }
    );

    test(
      "T-082 failed open-rapid correction publication failure rolls the whole recovered cancellation back",
      (t) => {
        let writes = 0;
        const runtime = createRuntime(t, {
          leagueOutboxWriter: {
            write() {
              writes += 1;
              throw new Error(
                "failed open-rapid publication failed"
              );
            },
          },
        });
        const fixture = installOpenRapidContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "cancel_auction", {
                idempotencyKey:
                  "failed-open-rapid-outbox-rollback",
                occurredAtMs: fixture.failedAtMs + 1,
              })
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.equal(writes, 1);
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "T-082 failed open-rapid replay rejects immutable correction activity or publication drift without writes",
      (t) => {
        const variants = [
          {
            tableNames: ["league_activity"],
            mutate(database) {
              database.prepare(`
                UPDATE league_activity
                SET metadata_json = json_set(
                  metadata_json,
                  '$.recoveryId',
                  @recoveryId
                )
                WHERE league_id = @leagueId
                  AND event_type =
                    'free_agent_draft_corrected'
              `).run({
                leagueId: IDS.league,
                recoveryId: uuid(99_201),
              });
            },
          },
          {
            tableNames: ["outbox_events"],
            mutate(database) {
              database.prepare(`
                UPDATE outbox_events
                SET payload_json =
                  '{"kind":"invalidation"}'
                WHERE league_id = @leagueId
                  AND event_type =
                    'activity.created'
              `).run({ leagueId: IDS.league });
            },
          },
        ];

        for (const [index, variant] of
          variants.entries()) {
          const runtime = createRuntime(t);
          const fixture =
            installOpenRapidContext(runtime);
          const command = commandFor(
            runtime,
            "cancel_auction",
            {
              idempotencyKey:
                `failed-open-rapid-drift-${index}`,
              occurredAtMs: fixture.failedAtMs + 1,
            }
          );
          runtime.repository.administer(command);
          withTableTriggersDisabled(
            runtime.database,
            variant.tableNames,
            () => variant.mutate(runtime.database)
          );
          const beforeReplay =
            restrictedCancellationSnapshot(
              runtime.database
            );
          const idsBeforeReplay =
            runtime.generatedIdCount();

          assert.throws(
            () =>
              runtime.repository.administer(command),
            (error) =>
              error.code ===
              "REPOSITORY_SCHEMA_INCOMPATIBLE"
          );
          assert.equal(
            runtime.generatedIdCount(),
            idsBeforeReplay
          );
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            beforeReplay
          );
        }
      }
    );

    test(
      "T-082 recovers the latest repeated direct open-rapid failure while preserving every prior failure event",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installRepeatedOpenRapidFailure(
          runtime,
          installOpenRapidContext(runtime)
        );
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const foreignKeysBefore = runtime.database
          .prepare("PRAGMA foreign_key_check")
          .all();
        const failureEventsBefore =
          before.auctionEvents.filter(
            (event) =>
              event.event_type ===
              "fad_auction_resolution_failed"
          );
        assert.equal(failureEventsBefore.length, 2);
        assert.equal(before.recoveries.length, 1);
        assert.equal(
          before.recoveries[0].created_at_ms,
          fixture.failedAtMs
        );
        assert.equal(
          before.recoveries[0].updated_at_ms,
          fixture.latestFailedAtMs
        );
        assert.equal(
          failureEventsBefore.filter(
            (event) =>
              event.occurred_at_ms ===
              fixture.latestFailedAtMs
          ).length,
          1
        );

        const result = runtime.repository.administer(
          commandFor(runtime, "cancel_auction", {
            idempotencyKey:
              "repeated-failed-open-rapid-cancel",
            occurredAtMs:
              fixture.latestFailedAtMs + 1,
          })
        );

        assert.equal(result.httpStatus, 200);
        assert.equal(result.replayed, false);
        assert.equal(
          result.data.recoveryId,
          IDS.openRapidRecovery
        );
        assert.equal(
          result.data.auction.status,
          "cancelled"
        );
        assert.equal(
          result.data.auction.result.outcomeCode,
          "cancelled"
        );
        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.equal(after.recoveries.length, 1);
        assert.equal(
          after.recoveries[0].status,
          "resolved"
        );
        assert.equal(after.jobs[0].status, "succeeded");
        assert.equal(
          after.resolutions[0].outcome_code,
          "recovered"
        );
        assert.equal(after.draw.version, 2);
        assert.deepEqual(
          after.auctionEvents.filter(
            (event) =>
              event.event_type ===
              "fad_auction_resolution_failed"
          ),
          failureEventsBefore
        );
        assert.deepEqual(
          runtime.database
            .prepare("PRAGMA foreign_key_check")
            .all(),
          foreignKeysBefore
        );
      }
    );

    test(
      "T-082 rolls a failed open-rapid recovery cancellation back after a late failure",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit() {
            throw new Error(
              "open-rapid cancellation rollback"
            );
          },
        });
        const fixture = installOpenRapidContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "cancel_auction", {
                idempotencyKey:
                  "failed-open-rapid-rollback",
                occurredAtMs:
                  fixture.failedAtMs + 1,
              })
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "T-083 creates and reuses one durable restricted-auction resolution occurrence without resolving inline",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const command = commandFor(
          runtime,
          "request_resolution",
          {
            idempotencyKey:
              "restricted-resolution-request",
          }
        );

        assertRepositoryError(
          () =>
            runtime.repository.administer({
              ...command,
              preconditionVersion: 99,
              idempotencyKey:
                "restricted-resolution-request-stale",
            }),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .preconditionFailed
        );
        assert.equal(runtime.generatedIdCount(), 0);
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );

        const first =
          runtime.repository.administer(command);

        assert.equal(first.httpStatus, 202);
        assert.equal(first.replayed, false);
        assert.deepEqual(
          Object.keys(first.data).sort(),
          [
            "acceptedAtMs",
            "auctionId",
            "occurrenceKey",
            "operationId",
            "pollDescriptor",
            "status",
          ]
        );
        assert.deepEqual(
          {
            auctionId: first.data.auctionId,
            occurrenceKey: first.data.occurrenceKey,
            status: first.data.status,
            acceptedAtMs: first.data.acceptedAtMs,
            pollDescriptor: first.data.pollDescriptor,
          },
          {
            auctionId: IDS.auction,
            occurrenceKey:
              `auction:${IDS.auction}:` +
              `${before.auctions[0].resolves_at_ms}`,
            status: "pending",
            acceptedAtMs: command.occurredAtMs,
            pollDescriptor: {
              kind: "auction",
              leagueId: IDS.league,
              auctionId: IDS.auction,
            },
          }
        );
        assert.equal(
          first.data.operationId,
          first.evidence.jobRunId
        );
        assert.equal(
          first.evidence.expectedResourceVersion,
          before.auctions[0].version
        );
        assert.equal(
          first.evidence.resultingResourceVersion,
          before.auctions[0].version
        );

        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        for (const field of [
          "auctions",
          "bids",
          "participants",
          "allocation",
          "allocationEvents",
          "draw",
          "resolutions",
          "recoveries",
          "auctionEvents",
          "activities",
          "contracts",
          "ownerships",
        ]) {
          assert.deepEqual(after[field], before[field], field);
        }
        assert.equal(after.jobs.length, 1);
        assert.deepEqual(
          {
            id: after.jobs[0].id,
            type: after.jobs[0].job_type,
            occurrenceKey:
              after.jobs[0].occurrence_key,
            scheduledForMs:
              after.jobs[0].scheduled_for_ms,
            status: after.jobs[0].status,
            attemptCount:
              after.jobs[0].attempt_count,
            nextAttemptAtMs:
              after.jobs[0].next_attempt_at_ms,
          },
          {
            id: first.data.operationId,
            type: "auction.resolve.target",
            occurrenceKey: first.data.occurrenceKey,
            scheduledForMs:
              before.auctions[0].resolves_at_ms,
            status: "pending",
            attemptCount: 0,
            nextAttemptAtMs:
              before.auctions[0].resolves_at_ms,
          }
        );
        assert.equal(after.commandResults.length, 1);
        assert.equal(
          after.commandResults[0].job_run_id,
          first.data.operationId
        );
        assert.equal(
          after.commandResults[0].action,
          "request_resolution"
        );
        assert.equal(
          after.commandResults[0]
            .expected_resource_version,
          before.auctions[0].version
        );
        assert.equal(
          after.commandResults[0]
            .resulting_resource_version,
          before.auctions[0].version
        );

        const generatedBeforeReplay =
          runtime.generatedIdCount();
        const replay =
          runtime.repository.administer(command);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, first.data);
        assert.equal(
          runtime.generatedIdCount(),
          generatedBeforeReplay
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          after
        );

        const reused = runtime.repository.administer({
          ...command,
          idempotencyKey:
            "restricted-resolution-request-reuse",
          occurredAtMs: command.occurredAtMs + 1,
          idempotencyExpiresAtMs:
            command.idempotencyExpiresAtMs + 1,
        });
        assert.equal(reused.replayed, false);
        assert.equal(reused.data.status, "pending");
        assert.equal(
          reused.data.operationId,
          first.data.operationId
        );
        assert.equal(
          restrictedCancellationSnapshot(
            runtime.database
          ).jobs.length,
          1
        );

        const cancellation =
          runtime.repository.administer(
            commandFor(runtime, "cancel_auction", {
              idempotencyKey:
                "restricted-cancel-after-resolution-request",
              occurredAtMs: command.occurredAtMs + 2,
            })
          );
        assert.equal(
          cancellation.data.auction.status,
          "correction_required"
        );
        const cancelledState =
          restrictedCancellationSnapshot(
            runtime.database
          );
        assert.equal(
          cancelledState.jobs[0].status,
          "failed"
        );
        assert.equal(
          cancelledState.recoveries[0].status,
          "correction_required"
        );
        const idsBeforeLateReplay =
          runtime.generatedIdCount();
        const lateReplay =
          runtime.repository.administer(command);
        assert.equal(lateReplay.replayed, true);
        assert.deepEqual(lateReplay.data, first.data);
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeLateReplay
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          cancelledState
        );
        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(
                runtime,
                "request_resolution",
                {
                  idempotencyKey:
                    "restricted-resolution-after-cancellation",
                  occurredAtMs:
                    command.occurredAtMs + 3,
                }
              )
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .stateConflict
        );
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeLateReplay
        );
      }
    );

    test(
      "T-083 queues a healthy due open-rapid auction without revealing its draw or writing a semantic result",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installOpenRapidContext(
          runtime,
          { failed: false }
        );
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        const result = runtime.repository.administer(
          commandFor(runtime, "request_resolution", {
            idempotencyKey:
              "open-rapid-resolution-request",
          })
        );

        assert.equal(result.httpStatus, 202);
        assert.equal(result.data.status, "pending");
        assert.equal(
          result.data.occurrenceKey,
          `auction:${IDS.auction}:` +
            `${before.auctions[0].resolves_at_ms}`
        );
        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.deepEqual(after.auctions, before.auctions);
        assert.deepEqual(after.bids, before.bids);
        assert.deepEqual(after.draw, before.draw);
        assert.equal(
          after.draw.commitment_hex,
          fixture.commitmentHex
        );
        assert.equal(after.draw.revealed_at_ms, null);
        assert.deepEqual(after.resolutions, []);
        assert.deepEqual(after.recoveries, []);
        assert.deepEqual(after.activities, []);
        assert.equal(after.jobs.length, 1);
        assert.equal(
          after.jobs[0].id,
          result.data.operationId
        );
        assert.equal(after.jobs[0].status, "pending");
        assert.equal(after.commandResults.length, 1);
        assert.equal(
          after.commandResults[0].job_run_id,
          result.data.operationId
        );
        const ordinaryResolutionRepository =
          createSqliteAuctionResolutionRepository({
            database: runtime.database,
            candidateCardSummerSynchronizer: {
              synchronize() {
                throw new Error(
                  "A FAD target must not reach the ordinary resolver."
                );
              },
            },
          });
        assert.deepEqual(
          ordinaryResolutionRepository.listDue({
            nowMs: before.auctions[0].resolves_at_ms,
            limit: 10,
          }),
          []
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT status FROM job_runs WHERE id = ?"
            )
            .get(result.data.operationId).status,
          "pending"
        );
      }
    );

    test(
      "T-083 retries the same nonterminal failed FAD job and rolls that reset back atomically",
      (t) => {
        function seedTransientFailure(runtime) {
          const auction = auctionRow(runtime.database);
          insert(runtime.database, "job_runs", {
            id: IDS.openRapidResolutionJob,
            league_id: IDS.league,
            season_id: IDS.season,
            job_type: "auction.resolve.target",
            occurrence_key:
              `auction:${IDS.auction}:` +
              `${auction.resolves_at_ms}`,
            scheduled_for_ms: auction.resolves_at_ms,
            status: "failed",
            attempt_count: 1,
            lease_owner: null,
            lease_expires_at_ms: null,
            started_at_ms: auction.resolves_at_ms,
            completed_at_ms: auction.resolves_at_ms,
            result_json: null,
            last_error_code:
              "AUCTION_RESOLUTION_RETRYABLE",
            created_at_ms: auction.opened_at_ms,
            updated_at_ms: auction.resolves_at_ms,
            version: 2,
            lease_token: null,
            next_attempt_at_ms: null,
          });
          return auction;
        }

        const runtime = createRuntime(t);
        installOpenRapidContext(runtime, {
          failed: false,
        });
        const auction = seedTransientFailure(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const command = commandFor(
          runtime,
          "request_resolution",
          {
            idempotencyKey:
              "open-rapid-transient-resolution-retry",
            occurredAtMs: auction.resolves_at_ms + 1,
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(result.data.status, "pending");
        assert.equal(
          result.data.operationId,
          IDS.openRapidResolutionJob
        );
        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.equal(after.jobs.length, 1);
        assert.deepEqual(
          {
            status: after.jobs[0].status,
            attempts: after.jobs[0].attempt_count,
            startedAtMs:
              after.jobs[0].started_at_ms,
            completedAtMs:
              after.jobs[0].completed_at_ms,
            resultJson: after.jobs[0].result_json,
            errorCode:
              after.jobs[0].last_error_code,
            nextAttemptAtMs:
              after.jobs[0].next_attempt_at_ms,
            updatedAtMs:
              after.jobs[0].updated_at_ms,
            version: after.jobs[0].version,
          },
          {
            status: "pending",
            attempts: before.jobs[0].attempt_count,
            startedAtMs: null,
            completedAtMs: null,
            resultJson: null,
            errorCode: null,
            nextAttemptAtMs: command.occurredAtMs,
            updatedAtMs: command.occurredAtMs,
            version: before.jobs[0].version + 1,
          }
        );
        for (const field of [
          "auctions",
          "bids",
          "participants",
          "allocation",
          "allocationEvents",
          "draw",
          "resolutions",
          "recoveries",
          "auctionEvents",
          "activities",
          "contracts",
          "ownerships",
        ]) {
          assert.deepEqual(after[field], before[field], field);
        }

        const rollbackRuntime = createRuntime(t, {
          beforeCommit() {
            throw new Error(
              "transient FAD resolution retry rollback"
            );
          },
        });
        installOpenRapidContext(rollbackRuntime, {
          failed: false,
        });
        const rollbackAuction =
          seedTransientFailure(rollbackRuntime);
        const beforeRollback =
          restrictedCancellationSnapshot(
            rollbackRuntime.database
          );
        assert.throws(
          () =>
            rollbackRuntime.repository.administer(
              commandFor(
                rollbackRuntime,
                "request_resolution",
                {
                  idempotencyKey:
                    "open-rapid-transient-retry-rollback",
                  occurredAtMs:
                    rollbackAuction.resolves_at_ms + 1,
                }
              )
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            rollbackRuntime.database
          ),
          beforeRollback
        );
      }
    );

    test(
      "T-083 reuses one live FAD resolution job while the auction is resolving",
      (t) => {
        const runtime = createRuntime(t);
        installOpenRapidContext(runtime, {
          failed: false,
        });
        const auction = auctionRow(runtime.database);
        insert(runtime.database, "job_runs", {
          id: IDS.openRapidResolutionJob,
          league_id: IDS.league,
          season_id: IDS.season,
          job_type: "auction.resolve.target",
          occurrence_key:
            `auction:${IDS.auction}:` +
            `${auction.resolves_at_ms}`,
          scheduled_for_ms: auction.resolves_at_ms,
          status: "running",
          attempt_count: 1,
          lease_owner: "fad-resolution-worker",
          lease_expires_at_ms:
            auction.resolves_at_ms + 60_000,
          started_at_ms: auction.resolves_at_ms,
          completed_at_ms: null,
          result_json: null,
          last_error_code: null,
          created_at_ms: auction.opened_at_ms,
          updated_at_ms: auction.resolves_at_ms,
          version: 1,
          lease_token:
            IDS.openRapidFailureLeaseToken,
          next_attempt_at_ms: null,
        });
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'resolving',
                updated_at_ms = @occurredAtMs,
                version = version + 1
            WHERE league_id = @leagueId
              AND id = @auctionId
              AND status = 'open'
          `)
          .run({
            leagueId: IDS.league,
            auctionId: IDS.auction,
            occurredAtMs: auction.resolves_at_ms,
          });
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const command = commandFor(
          runtime,
          "request_resolution",
          {
            idempotencyKey:
              "open-rapid-running-resolution-request",
            occurredAtMs: auction.resolves_at_ms + 1,
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(result.data.status, "pending");
        assert.equal(
          result.data.operationId,
          IDS.openRapidResolutionJob
        );
        const after = restrictedCancellationSnapshot(
          runtime.database
        );
        assert.deepEqual(after.auctions, before.auctions);
        assert.deepEqual(after.jobs, before.jobs);
        assert.deepEqual(after.bids, before.bids);
        assert.deepEqual(after.draw, before.draw);
        assert.deepEqual(after.resolutions, []);
        assert.equal(after.commandResults.length, 1);
        assert.equal(
          after.commandResults[0].job_run_id,
          IDS.openRapidResolutionJob
        );
      }
    );

    test(
      "T-083 keeps a terminal failed open-rapid auction on its exact recovery path without retrying its job",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installOpenRapidContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assertRepositoryError(
          () =>
            runtime.repository.administer(
              commandFor(
                runtime,
                "request_resolution",
                {
                  idempotencyKey:
                    "failed-open-rapid-resolution-request",
                  occurredAtMs:
                    fixture.failedAtMs + 1,
                }
              )
            ),
          AUCTION_ADMINISTRATION_REPOSITORY_CODES
            .fadIntegrationRequired
        );
        assert.equal(runtime.generatedIdCount(), 0);
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "T-083 reuses the genuinely succeeded job after failed open-rapid recovery without new semantic writes",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installOpenRapidContext(runtime);
        const cancellationCommand = commandFor(
          runtime,
          "cancel_auction",
          {
            idempotencyKey:
              "open-rapid-cancel-before-resolution-request",
            occurredAtMs: fixture.failedAtMs + 1,
          }
        );
        runtime.repository.administer(
          cancellationCommand
        );
        const afterCancellation =
          restrictedCancellationSnapshot(
            runtime.database
          );
        assert.equal(
          afterCancellation.jobs[0].status,
          "succeeded"
        );
        const idsBeforeRequest =
          runtime.generatedIdCount();
        const command = commandFor(
          runtime,
          "request_resolution",
          {
            idempotencyKey:
              "open-rapid-resolution-after-recovery",
            occurredAtMs:
              cancellationCommand.occurredAtMs + 1,
          }
        );

        const result =
          runtime.repository.administer(command);

        assert.equal(result.httpStatus, 202);
        assert.equal(result.data.status, "already_succeeded");
        assert.equal(
          result.data.operationId,
          IDS.openRapidResolutionJob
        );
        assert.equal(
          result.data.occurrenceKey,
          `auction:${IDS.auction}:` +
            `${afterCancellation.auctions[0].resolves_at_ms}`
        );
        assert.equal(
          result.evidence.expectedResourceVersion,
          afterCancellation.auctions[0].version
        );
        assert.equal(
          result.evidence.resultingResourceVersion,
          afterCancellation.auctions[0].version
        );
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeRequest + 2
        );
        const afterRequest =
          restrictedCancellationSnapshot(
            runtime.database
          );
        for (const field of [
          "auctions",
          "bids",
          "participants",
          "allocation",
          "allocationEvents",
          "draw",
          "resolutions",
          "recoveries",
          "jobs",
          "auctionEvents",
          "activities",
          "contracts",
          "ownerships",
        ]) {
          assert.deepEqual(
            afterRequest[field],
            afterCancellation[field],
            field
          );
        }
        const idsBeforeReplay =
          runtime.generatedIdCount();
        const replay =
          runtime.repository.administer(command);
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.data, result.data);
        assert.equal(
          runtime.generatedIdCount(),
          idsBeforeReplay
        );
      }
    );

    test(
      "T-083 rolls a restricted durable request back with its job and immutable evidence after a late failure",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit() {
            throw new Error(
              "restricted resolution request rollback"
            );
          },
        });
        installRestrictedContext(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.repository.administer(
              commandFor(
                runtime,
                "request_resolution",
                {
                  idempotencyKey:
                    "restricted-resolution-request-rollback",
                }
              )
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "shared restricted fallback performs zero writes while an eligible improvement remains",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        const execution =
          installRestrictedResolutionLease(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );
        const beforeIds = runtime.generatedIdCount();

        const result = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(execution)
        );

        assert.equal(result.applied, false);
        assert.equal(
          result.reason,
          "eligible_improvement_remains"
        );
        assert.equal(
          runtime.generatedIdCount(),
          beforeIds
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "shared restricted fallback rejects a direct writer call outside its caller-owned transaction with zero writes",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(() =>
          runtime.fallbackWriter.openFallback(
            restrictedFallbackCommand(execution)
          )
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "shared restricted fallback invalidates an active improvement whose team became inactive during contender recomputation",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        const auction = auctionRow(runtime.database);
        const deactivated = runtime.database
          .prepare(`
            UPDATE teams
            SET status = 'inactive',
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
              AND status = 'active'
          `)
          .run(
            auction.resolves_at_ms - 1,
            IDS.league,
            IDS.team
          );
        assert.equal(deactivated.changes, 1);
        const bidBefore = bidRow(runtime.database);
        const participantBefore = participantRow(
          runtime.database
        );
        const execution =
          installRestrictedResolutionLease(runtime);

        const result = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(execution)
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.fallbackAuctionId,
          IDS.fallbackAuction
        );
        const bidAfter = bidRow(runtime.database);
        assert.equal(bidAfter.status, "invalid");
        assert.equal(
          bidAfter.version,
          bidBefore.version + 1
        );
        const {
          status: bidStatusBefore,
          version: bidVersionBefore,
          ...preservedBidBefore
        } = bidBefore;
        const {
          status: bidStatusAfter,
          version: bidVersionAfter,
          ...preservedBidAfter
        } = bidAfter;
        assert.equal(bidStatusBefore, "active");
        assert.equal(bidStatusAfter, "invalid");
        assert.equal(
          bidVersionAfter,
          bidVersionBefore + 1
        );
        assert.deepEqual(
          preservedBidAfter,
          preservedBidBefore
        );
        assert.deepEqual(
          participantRow(runtime.database),
          participantBefore
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT ordered_tied_bid_ids_json AS bidIds,
                     ordered_tied_team_ids_json AS teamIds,
                     rejection_counter AS rejectionCounter,
                     selected_index AS selectedIndex,
                     selected_bid_id AS selectedBidId,
                     selected_team_id AS selectedTeamId,
                     selected_digest_hex AS selectedDigestHex,
                     revealed_at_ms AS revealedAtMs,
                     version
              FROM free_agent_draft_draws
              WHERE league_id = ? AND auction_id = ?
            `)
            .get(IDS.league, IDS.auction),
          {
            bidIds: "[]",
            teamIds: "[]",
            rejectionCounter: null,
            selectedIndex: null,
            selectedBidId: null,
            selectedTeamId: null,
            selectedDigestHex: null,
            revealedAtMs: execution.nowMs,
            version: 2,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT id, status
              FROM auctions
              WHERE league_id = ?
                AND id IN (?, ?)
              ORDER BY id
            `)
            .all(
              IDS.league,
              IDS.auction,
              IDS.fallbackAuction
            ),
          [
            { id: IDS.auction, status: "no_winner" },
            {
              id: IDS.fallbackAuction,
              status: "open",
            },
          ]
        );
      }
    );

    test(
      "shared restricted fallback commits one no-winner and a fresh leaderless 24-hour auction",
      (t) => {
        const runtime = createRuntime(t);
        const fixture = installRestrictedContext(
          runtime,
          { fallbackReady: true }
        );
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        const command =
          restrictedFallbackCommand(execution);
        const sourceHistoryBefore =
          restrictedCancellationSnapshot(
            runtime.database
          );

        const result = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.sourceAuctionId,
          IDS.auction
        );
        assert.equal(
          result.fallbackAuctionId,
          IDS.fallbackAuction
        );

        const source = runtime.database
          .prepare(`
            SELECT status, updated_at_ms AS updatedAtMs,
                   version
            FROM auctions
            WHERE league_id = ? AND id = ?
          `)
          .get(IDS.league, IDS.auction);
        assert.deepEqual(source, {
          status: "no_winner",
          updatedAtMs: execution.nowMs,
          version: 3,
        });
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status,
                     outcome_code AS outcomeCode,
                     scheduled_occurrence_key AS occurrenceKey,
                     winning_team_id AS winningTeamId,
                     winning_bid_id AS winningBidId,
                     contract_id AS contractId,
                     ownership_id AS ownershipId,
                     general_illegal AS generalIllegal,
                     warnings_json AS warningsJson,
                     resolved_at_ms AS resolvedAtMs
              FROM auction_resolutions
              WHERE league_id = ? AND auction_id = ?
            `)
            .get(IDS.league, IDS.auction),
          {
            status: "no_winner",
            outcomeCode: "no_winner",
            occurrenceKey: execution.occurrenceKey,
            winningTeamId: null,
            winningBidId: null,
            contractId: null,
            ownershipId: null,
            generalIllegal: 0,
            warningsJson: "[]",
            resolvedAtMs: execution.nowMs,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT commitment_hex AS commitmentHex,
                     ordered_tied_bid_ids_json AS bidIds,
                     ordered_tied_team_ids_json AS teamIds,
                     rejection_counter AS rejectionCounter,
                     selected_index AS selectedIndex,
                     selected_bid_id AS selectedBidId,
                     selected_team_id AS selectedTeamId,
                     selected_digest_hex AS selectedDigestHex,
                     revealed_at_ms AS revealedAtMs,
                     version
              FROM free_agent_draft_draws
              WHERE league_id = ? AND auction_id = ?
            `)
            .get(IDS.league, IDS.auction),
          {
            commitmentHex: fixture.commitmentHex,
            bidIds: "[]",
            teamIds: "[]",
            rejectionCounter: null,
            selectedIndex: null,
            selectedBidId: null,
            selectedTeamId: null,
            selectedDigestHex: null,
            revealedAtMs: execution.nowMs,
            version: 2,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, decision_code AS decisionCode,
                     restricted_auction_id AS restrictedAuctionId,
                     fallback_open_auction_id AS fallbackAuctionId,
                     restricted_minimum_total_cents AS minimumTotal,
                     restricted_minimum_term_years AS minimumTerm,
                     restricted_minimum_aav_cents AS minimumAav,
                     winning_team_id AS winningTeamId,
                     contract_id AS contractId,
                     ownership_id AS ownershipId,
                     version
              FROM free_agent_draft_player_allocations
              WHERE league_id = ? AND id = ?
            `)
            .get(IDS.league, IDS.allocation),
          {
            status: "restricted_fallback_open",
            decisionCode:
              "restricted_no_improvement_fallback",
            restrictedAuctionId: IDS.auction,
            fallbackAuctionId: IDS.fallbackAuction,
            minimumTotal: 500,
            minimumTerm: 2,
            minimumAav: 250,
            winningTeamId: null,
            contractId: null,
            ownershipId: null,
            version: 3,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT auction.status,
                     auction.opened_at_ms AS openedAtMs,
                     auction.resolves_at_ms AS resolvesAtMs,
                     auction.opened_by_user_id AS openedByUserId,
                     auction.version,
                     context.source_kind AS sourceKind,
                     context.fad_rollover_id AS rolloverId,
                     context.fad_allocation_id AS allocationId,
                     context.fad_origin AS fadOrigin,
                     draw.revealed_at_ms AS revealedAtMs,
                     draw.version AS drawVersion
              FROM auctions AS auction
              JOIN auction_contexts AS context
                ON context.league_id = auction.league_id
               AND context.auction_id = auction.id
              JOIN free_agent_draft_draws AS draw
                ON draw.league_id = auction.league_id
               AND draw.auction_id = auction.id
              WHERE auction.league_id = ? AND auction.id = ?
            `)
            .get(IDS.league, IDS.fallbackAuction),
          {
            status: "open",
            openedAtMs: execution.nowMs,
            resolvesAtMs:
              execution.nowMs + 86_400_000,
            openedByUserId: null,
            version: 1,
            sourceKind: "fad_open_rapid",
            rolloverId: IDS.nextRollover,
            allocationId: IDS.allocation,
            fadOrigin:
              "restricted_no_improvement_fallback",
            revealedAtMs: null,
            drawVersion: 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT job_type AS jobType,
                     occurrence_key AS occurrenceKey,
                     scheduled_for_ms AS scheduledForMs,
                     status, attempt_count AS attemptCount,
                     lease_owner AS leaseOwner,
                     lease_token AS leaseToken,
                     lease_expires_at_ms AS leaseExpiresAtMs,
                     started_at_ms AS startedAtMs,
                     completed_at_ms AS completedAtMs,
                     result_json AS resultJson,
                     last_error_code AS lastErrorCode,
                     next_attempt_at_ms AS nextAttemptAtMs,
                     version
              FROM job_runs
              WHERE league_id = ? AND id = ?
            `)
            .get(
              IDS.league,
              IDS.fallbackResolutionJob
            ),
          {
            jobType: "auction.resolve.target",
            occurrenceKey:
              `auction:${IDS.fallbackAuction}:` +
              `${execution.nowMs + 86_400_000}`,
            scheduledForMs:
              execution.nowMs + 86_400_000,
            status: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtMs: null,
            startedAtMs: null,
            completedAtMs: null,
            resultJson: null,
            lastErrorCode: null,
            nextAttemptAtMs:
              execution.nowMs + 86_400_000,
            version: 1,
          }
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM auction_bids
              WHERE league_id = ? AND auction_id = ?
            `)
            .get(
              IDS.league,
              IDS.fallbackAuction
            ).count,
          0
        );
        const sourceHistoryAfter =
          restrictedCancellationSnapshot(
            runtime.database
          );
        assert.deepEqual(
          sourceHistoryAfter.bids,
          sourceHistoryBefore.bids
        );
        assert.deepEqual(
          sourceHistoryAfter.participants,
          sourceHistoryBefore.participants
        );
        assert.deepEqual(
          allocationOfferEvents(
            runtime.database,
            3
          ),
          allocationOfferEvents(
            runtime.database,
            2
          )
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT event_kind AS eventKind,
                     decision_code AS decisionCode,
                     resulting_allocation_status AS status,
                     auction_id AS auctionId,
                     activity_id AS activityId
              FROM free_agent_draft_allocation_events
              WHERE league_id = ?
                AND allocation_id = ?
                AND allocation_version = 3
                AND event_kind = 'fallback_state_changed'
            `)
            .get(IDS.league, IDS.allocation),
          {
            eventKind: "fallback_state_changed",
            decisionCode:
              "restricted_no_improvement_fallback",
            status: "restricted_fallback_open",
            auctionId: IDS.fallbackAuction,
            activityId: IDS.fallbackActivity,
          }
        );
        const job = runtime.database
          .prepare(`
            SELECT status, lease_owner AS leaseOwner,
                   lease_token AS leaseToken,
                   lease_expires_at_ms AS leaseExpiresAtMs,
                   completed_at_ms AS completedAtMs,
                   result_json AS resultJson,
                   last_error_code AS lastErrorCode,
                   version
            FROM job_runs
            WHERE league_id = ? AND id = ?
          `)
          .get(
            IDS.league,
            IDS.restrictedResolutionJob
          );
        assert.deepEqual(job, {
          status: "succeeded",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtMs: null,
          completedAtMs: execution.nowMs,
          resultJson: JSON.stringify({
            auctionId: IDS.auction,
            outcome: "no_winner",
          }),
          lastErrorCode: null,
          version: 2,
        });
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM contracts
              WHERE league_id = ?
            `)
            .get(IDS.league).count,
          0
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM player_ownerships
              WHERE league_id = ?
            `)
            .get(IDS.league).count,
          0
        );

        const notification = runtime.database
          .prepare(`
            SELECT event_type AS eventType,
                   message_data_json AS messageDataJson,
                   user_id AS userId,
                   deduplication_key AS deduplicationKey
            FROM notifications
            WHERE league_id = ? AND id = ?
          `)
          .get(
            IDS.league,
            IDS.fallbackNotification
          );
        assert.equal(
          notification.eventType,
          "fad_restricted_fallback_opened"
        );
        assert.deepEqual(
          {
            userId: notification.userId,
            deduplicationKey:
              notification.deduplicationKey,
          },
          {
            userId: IDS.managerUser,
            deduplicationKey:
              `fad:${IDS.fad}:fallback-opened:` +
              `${IDS.fallbackAuction}:` +
              `${IDS.team}:${IDS.managerUser}`,
          }
        );
        assert.equal(result.outboxEventIds.length, 5);
        assert.deepEqual(
          result.outboxEventIds.slice(0, 2),
          [
            IDS.fallbackFadOutbox,
            IDS.fallbackAuctionOutbox,
          ]
        );
        const fadVersion = runtime.database
          .prepare(
            "SELECT version FROM free_agent_drafts WHERE id = ?"
          )
          .get(IDS.fad).version;
        const fallbackRelated =
          createEmptySocketRelated({
            fadId: IDS.fad,
            allocationId: IDS.allocation,
            auctionId: IDS.fallbackAuction,
          });
        const expectedPublications = [
          {
            type: "free_agent_draft.changed",
            aggregateType: "free_agent_draft",
            resourceId: IDS.fad,
            version: fadVersion,
            reasonCode: "fallback_opened",
            related: fallbackRelated,
            audienceKind: "league",
            audienceUserId: null,
          },
          {
            type: "auction.changed",
            aggregateType: "auction",
            resourceId: IDS.fallbackAuction,
            version: 1,
            reasonCode: "auction_changed",
            related: fallbackRelated,
            audienceKind: "league",
            audienceUserId: null,
          },
          {
            type: "auction.changed",
            aggregateType: "auction",
            resourceId: IDS.auction,
            version: 3,
            reasonCode: "auction_changed",
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              auctionId: IDS.auction,
            }),
            audienceKind: "league",
            audienceUserId: null,
          },
          {
            type: "activity.created",
            aggregateType: "league_activity",
            resourceId: IDS.fallbackActivity,
            version: 1,
            reasonCode: "fallback_opened",
            related: fallbackRelated,
            audienceKind: "league",
            audienceUserId: null,
          },
          {
            type: "notification.created",
            aggregateType: "notification",
            resourceId: IDS.fallbackNotification,
            version: 1,
            reasonCode: "fallback_opened",
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              teamId: IDS.team,
              allocationId: IDS.allocation,
              auctionId: IDS.fallbackAuction,
            }),
            audienceKind: "user",
            audienceUserId: IDS.managerUser,
          },
        ];
        for (
          let index = 0;
          index < expectedPublications.length;
          index += 1
        ) {
          const eventId = result.outboxEventIds[index];
          const expected = expectedPublications[index];
          const publication = runtime.database.prepare(`
            SELECT event.*,
                   audience.audience_kind AS audienceKind,
                   audience.team_id AS audienceTeamId,
                   audience.user_id AS audienceUserId
            FROM outbox_events AS event
            JOIN outbox_event_audiences AS audience
              ON audience.league_id = event.league_id
             AND audience.outbox_event_id = event.id
            WHERE event.league_id = @leagueId
              AND event.id = @eventId
          `).get({
            leagueId: IDS.league,
            eventId,
          });
          assert.ok(publication);
          assert.equal(publication.event_type, expected.type);
          assert.equal(
            publication.aggregate_type,
            expected.aggregateType
          );
          assert.equal(
            publication.aggregate_id,
            expected.resourceId
          );
          assert.equal(
            publication.audienceKind,
            expected.audienceKind
          );
          assert.equal(publication.audienceTeamId, null);
          assert.equal(
            publication.audienceUserId,
            expected.audienceUserId
          );
          assert.deepEqual(
            JSON.parse(publication.payload_json),
            createSocketEventEnvelope({
              eventId,
              type: expected.type,
              leagueId: IDS.league,
              resourceId: expected.resourceId,
              version: expected.version,
              reasonCode: expected.reasonCode,
              occurredAt: execution.nowMs,
              related: expected.related,
            })
          );
        }
        const safeEvidence = JSON.stringify({
          activity: runtime.database
            .prepare(`
              SELECT metadata_json
              FROM league_activity
              WHERE league_id = ? AND id = ?
            `)
            .get(
              IDS.league,
              IDS.fallbackActivity
            ),
          notification: JSON.parse(
            notification.messageDataJson
          ),
          outbox: runtime.database
            .prepare(`
              SELECT event_type, aggregate_type,
                     aggregate_id, payload_json
              FROM outbox_events
              WHERE league_id = ?
                AND id IN (?, ?, ?, ?, ?)
              ORDER BY id
            `)
            .all(
              IDS.league,
              ...result.outboxEventIds
            ),
        });
        for (const secret of [
          "totalValueCents",
          "termYears",
          "aavCents",
          "nonce",
          "leaseToken",
          "queueId",
        ]) {
          assert.equal(
            safeEvidence.includes(secret),
            false,
            secret
          );
        }
      }
    );

    test(
      "shared restricted fallback creates a sequence-eight extension when the seventh boundary has no successor",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const rolloverExecution =
          installRestrictedRolloverProcessingLease(
            runtime
          );
        const execution =
          installRestrictedResolutionLease(runtime);
        assert.equal(
          execution.nowMs,
          rolloverExecution.nowMs
        );
        const command = restrictedFallbackCommand(
          execution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId:
                IDS.fallbackExtensionRollover,
            }),
          }
        );

        const result = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.fallbackRolloverId,
          IDS.fallbackExtensionRollover
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT id, sequence,
                     window_kind AS windowKind,
                     predecessor_rollover_id AS predecessorId,
                     extension_reason AS extensionReason,
                     extension_source_id AS extensionSourceId,
                     opens_at_ms AS opensAtMs,
                     creation_cutoff_at_ms AS cutoffAtMs,
                     rolls_over_at_ms AS rollsOverAtMs,
                     status,
                     processing_job_run_id AS processingJobRunId,
                     processing_started_at_ms AS processingStartedAtMs,
                     completed_at_ms AS completedAtMs,
                     last_error_code AS lastErrorCode,
                     created_at_ms AS createdAtMs,
                     updated_at_ms AS updatedAtMs,
                     version
              FROM free_agent_draft_rollovers
              WHERE league_id = ? AND id = ?
            `)
            .get(
              IDS.league,
              IDS.fallbackExtensionRollover
            ),
          {
            id: IDS.fallbackExtensionRollover,
            sequence: 8,
            windowKind: "extension",
            predecessorId: IDS.rollover,
            extensionReason: "fallback_auction",
            extensionSourceId: IDS.allocation,
            opensAtMs: execution.nowMs,
            cutoffAtMs:
              execution.nowMs +
              86_400_000 -
              3_600_000,
            rollsOverAtMs:
              execution.nowMs + 86_400_000,
            status: "scheduled",
            processingJobRunId: null,
            processingStartedAtMs: null,
            completedAtMs: null,
            lastErrorCode: null,
            createdAtMs: execution.nowMs,
            updatedAtMs: execution.nowMs,
            version: 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT sequence
              FROM free_agent_draft_rollovers
              WHERE league_id = ? AND fad_id = ?
              ORDER BY sequence
            `)
            .all(IDS.league, IDS.fad)
            .map((row) => row.sequence),
          [1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT context.fad_rollover_id AS rolloverId,
                     auction.status,
                     auction.opened_at_ms AS openedAtMs,
                     auction.resolves_at_ms AS resolvesAtMs,
                     auction.opened_by_user_id AS openedByUserId,
                     job.status AS jobStatus,
                     job.scheduled_for_ms AS jobScheduledForMs,
                     job.next_attempt_at_ms AS jobNextAttemptAtMs
              FROM auction_contexts AS context
              JOIN auctions AS auction
                ON auction.league_id = context.league_id
               AND auction.id = context.auction_id
              JOIN job_runs AS job
                ON job.league_id = auction.league_id
               AND job.id = ?
              WHERE context.league_id = ?
                AND context.auction_id = ?
            `)
            .get(
              IDS.fallbackResolutionJob,
              IDS.league,
              IDS.fallbackAuction
            ),
          {
            rolloverId:
              IDS.fallbackExtensionRollover,
            status: "open",
            openedAtMs: execution.nowMs,
            resolvesAtMs:
              execution.nowMs + 86_400_000,
            openedByUserId: null,
            jobStatus: "pending",
            jobScheduledForMs:
              execution.nowMs + 86_400_000,
            jobNextAttemptAtMs:
              execution.nowMs + 86_400_000,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT rollover.status,
                     rollover.processing_job_run_id AS processingJobRunId,
                     rollover.processing_started_at_ms AS processingStartedAtMs,
                     rollover.version AS rolloverVersion,
                     job.status AS jobStatus,
                     job.lease_owner AS leaseOwner,
                     job.lease_token AS leaseToken,
                     job.lease_expires_at_ms AS leaseExpiresAtMs,
                     job.version AS jobVersion
              FROM free_agent_draft_rollovers AS rollover
              JOIN job_runs AS job
                ON job.league_id = rollover.league_id
               AND job.id = rollover.processing_job_run_id
              WHERE rollover.league_id = ?
                AND rollover.id = ?
            `)
            .get(IDS.league, IDS.rollover),
          {
            status: "processing",
            processingJobRunId:
              IDS.rolloverProcessingJob,
            processingStartedAtMs: execution.nowMs,
            rolloverVersion: 2,
            jobStatus: "running",
            leaseOwner: "restricted-rollover-worker",
            leaseToken:
              IDS.rolloverProcessingLeaseToken,
            leaseExpiresAtMs:
              execution.nowMs + 60_000,
            jobVersion: 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT id, status
              FROM job_runs
              WHERE league_id = ?
                AND id IN (?, ?)
              ORDER BY id
            `)
            .all(
              IDS.league,
              IDS.restrictedResolutionJob,
              IDS.rolloverProcessingJob
            ),
          [
            {
              id: IDS.restrictedResolutionJob,
              status: "succeeded",
            },
            {
              id: IDS.rolloverProcessingJob,
              status: "running",
            },
          ]
        );
      }
    );

    test(
      "shared restricted fallback schedules a future full-window fallback during the predecessor final hour without publishing it early",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const rolloverExecution =
          installRestrictedRolloverProcessingLease(
            runtime
          );
        const predecessorRolloverId = uuid(91_001);
        insertScheduledExtensionRollover(
          runtime.database,
          {
            id: predecessorRolloverId,
            sequence: 8,
            predecessorId: IDS.rollover,
            reason: "restricted_auction",
            sourceId: IDS.allocation,
            opensAtMs: rolloverExecution.nowMs,
            createdAtMs: rolloverExecution.nowMs,
          }
        );
        const activationAtMs =
          rolloverExecution.nowMs + DAY_MS;
        const execution =
          installRestrictedResolutionLease(runtime, {
            nowMs:
              activationAtMs - 30 * 60 * 1_000,
            leaseExpiresAtMs:
              activationAtMs + 60_000,
          });
        const activationJobRunId = uuid(91_002);
        const command = restrictedFallbackCommand(
          execution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId:
                IDS.fallbackExtensionRollover,
              fallbackActivationJobRunId:
                activationJobRunId,
              activityId: null,
              fadOutboxEventId: null,
              auctionOutboxEventId: null,
              notificationIds: [],
            }),
          }
        );
        const publicationBefore = {
          activities: runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM league_activity
              WHERE league_id = ?
            `)
            .get(IDS.league).count,
          notifications: runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM notifications
              WHERE league_id = ?
            `)
            .get(IDS.league).count,
          outbox: runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM outbox_events
              WHERE league_id = ?
            `)
            .get(IDS.league).count,
        };

        const result = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.fallbackRolloverId,
          IDS.fallbackExtensionRollover
        );
        assert.equal(
          result.activationJobRunId,
          activationJobRunId
        );
        assert.equal(
          result.activationAtMs,
          activationAtMs
        );
        assert.equal(result.activityId, null);
        assert.deepEqual(result.notificationIds, []);
        assert.equal(result.outboxEventIds.length, 1);
        const sourcePublication = runtime.database.prepare(`
          SELECT event.*,
                 audience.audience_kind AS audienceKind,
                 audience.team_id AS audienceTeamId,
                 audience.user_id AS audienceUserId
          FROM outbox_events AS event
          JOIN outbox_event_audiences AS audience
            ON audience.league_id = event.league_id
           AND audience.outbox_event_id = event.id
          WHERE event.league_id = @leagueId
            AND event.id = @eventId
        `).get({
          leagueId: IDS.league,
          eventId: result.outboxEventIds[0],
        });
        assert.ok(sourcePublication);
        assert.equal(sourcePublication.event_type, "auction.changed");
        assert.equal(sourcePublication.aggregate_type, "auction");
        assert.equal(sourcePublication.aggregate_id, IDS.auction);
        assert.equal(sourcePublication.audienceKind, "league");
        assert.equal(sourcePublication.audienceTeamId, null);
        assert.equal(sourcePublication.audienceUserId, null);
        assert.deepEqual(
          JSON.parse(sourcePublication.payload_json),
          createSocketEventEnvelope({
            eventId: result.outboxEventIds[0],
            type: "auction.changed",
            leagueId: IDS.league,
            resourceId: IDS.auction,
            version: 3,
            reasonCode: "auction_changed",
            occurredAt: execution.nowMs,
            related: createEmptySocketRelated({
              fadId: IDS.fad,
              allocationId: IDS.allocation,
              auctionId: IDS.auction,
            }),
          })
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT opened_at_ms AS openedAtMs,
                     resolves_at_ms AS resolvesAtMs,
                     status
              FROM auctions
              WHERE league_id = ? AND id = ?
            `)
            .get(IDS.league, IDS.fallbackAuction),
          {
            openedAtMs: activationAtMs,
            resolvesAtMs: activationAtMs + DAY_MS,
            status: "open",
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT job_type AS jobType,
                     occurrence_key AS occurrenceKey,
                     scheduled_for_ms AS scheduledForMs,
                     status, attempt_count AS attemptCount,
                     next_attempt_at_ms AS nextAttemptAtMs
              FROM job_runs
              WHERE league_id = ? AND id = ?
            `)
            .get(IDS.league, activationJobRunId),
          {
            jobType: "fad_fallback_activation",
            occurrenceKey:
              `fad:${IDS.fad}:fallback-activate:` +
              `${IDS.allocation}:${activationAtMs}`,
            scheduledForMs: activationAtMs,
            status: "pending",
            attemptCount: 0,
            nextAttemptAtMs: null,
          }
        );
        assert.deepEqual(
          {
            activities: runtime.database
              .prepare(`
                SELECT COUNT(*) AS count
                FROM league_activity
                WHERE league_id = ?
              `)
              .get(IDS.league).count,
            notifications: runtime.database
              .prepare(`
                SELECT COUNT(*) AS count
                FROM notifications
                WHERE league_id = ?
              `)
              .get(IDS.league).count,
            outbox: runtime.database
              .prepare(`
                SELECT COUNT(*) AS count
                FROM outbox_events
                WHERE league_id = ?
              `)
              .get(IDS.league).count,
          },
          {
            ...publicationBefore,
            outbox: publicationBefore.outbox + 1,
          }
        );
      }
    );

    test(
      "shared restricted fallback immutably replays a future activation with fresh identifiers and a later time",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const rolloverExecution =
          installRestrictedRolloverProcessingLease(
            runtime
          );
        const predecessorRolloverId = uuid(94_001);
        insertScheduledExtensionRollover(
          runtime.database,
          {
            id: predecessorRolloverId,
            sequence: 8,
            predecessorId: IDS.rollover,
            reason: "restricted_auction",
            sourceId: IDS.allocation,
            opensAtMs: rolloverExecution.nowMs,
            createdAtMs: rolloverExecution.nowMs,
          }
        );
        const activationAtMs =
          rolloverExecution.nowMs + DAY_MS;
        const execution =
          installRestrictedResolutionLease(runtime, {
            nowMs:
              activationAtMs - 30 * 60 * 1_000,
            leaseExpiresAtMs:
              activationAtMs + 60_000,
          });
        const command = restrictedFallbackCommand(
          execution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId:
                IDS.fallbackExtensionRollover,
              fallbackActivationJobRunId:
                uuid(94_002),
              activityId: null,
              fadOutboxEventId: null,
              auctionOutboxEventId: null,
              notificationIds: [],
            }),
          }
        );

        const first = openRestrictedFallback(
          runtime,
          command
        );
        const beforeReplay =
          restrictedCancellationSnapshot(
            runtime.database
          );
        const activationJobsBefore = runtime.database
          .prepare(`
            SELECT *
            FROM job_runs
            WHERE league_id = ?
              AND job_type = 'fad_fallback_activation'
            ORDER BY id
          `)
          .all(IDS.league);
        const replayIds = {
          ...freshRestrictedFallbackIds(),
          extensionRolloverId: uuid(94_003),
          fallbackActivationJobRunId:
            uuid(94_004),
          activityId: null,
          fadOutboxEventId: null,
          auctionOutboxEventId: null,
          notificationIds: [],
        };

        const replay = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(execution, {
            nowMs: execution.nowMs + 1,
            ids: replayIds,
          })
        );

        assert.equal(first.replayed, false);
        assert.equal(first.activationAtMs, activationAtMs);
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          first
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          beforeReplay
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT *
              FROM job_runs
              WHERE league_id = ?
                AND job_type = 'fad_fallback_activation'
              ORDER BY id
            `)
            .all(IDS.league),
          activationJobsBefore
        );
      }
    );

    test(
      "shared restricted fallback accepts a multi-boundary retry only from exact recovery receipt evidence and resolves that recovery",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        installRestrictedRolloverProcessingLease(
          runtime
        );
        const delayed =
          installDelayedRestrictedResolutionRecovery(
            runtime
          );
        const activationJobRunId = uuid(92_007);
        const command = restrictedFallbackCommand(
          delayed.execution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId:
                IDS.fallbackExtensionRollover,
              fallbackActivationJobRunId:
                activationJobRunId,
              activityId: null,
              fadOutboxEventId: null,
              auctionOutboxEventId: null,
              notificationIds: [],
            }),
          }
        );

        const result = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.fallbackRolloverId,
          IDS.fallbackExtensionRollover
        );
        assert.equal(
          result.activationJobRunId,
          activationJobRunId
        );
        assert.equal(
          result.activationAtMs,
          delayed.activationAtMs
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT sequence,
                     predecessor_rollover_id AS predecessorId,
                     extension_reason AS extensionReason,
                     extension_source_id AS extensionSourceId,
                     opens_at_ms AS opensAtMs,
                     rolls_over_at_ms AS rollsOverAtMs,
                     status
              FROM free_agent_draft_rollovers
              WHERE league_id = ? AND id = ?
            `)
            .get(
              IDS.league,
              IDS.fallbackExtensionRollover
            ),
          {
            sequence: 10,
            predecessorId:
              delayed.predecessorRolloverId,
            extensionReason: "fallback_auction",
            extensionSourceId: IDS.allocation,
            opensAtMs: delayed.activationAtMs,
            rollsOverAtMs:
              delayed.activationAtMs + DAY_MS,
            status: "scheduled",
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status,
                     last_error_code AS lastErrorCode,
                     resolved_by_user_id AS resolvedByUserId,
                     resolved_by_membership_id AS resolvedByMembershipId,
                     resolved_authority AS resolvedAuthority,
                     resolved_at_ms AS resolvedAtMs,
                     updated_at_ms AS updatedAtMs,
                     version
              FROM free_agent_draft_recoveries
              WHERE league_id = ? AND id = ?
            `)
            .get(
              IDS.league,
              delayed.recoveryId
            ),
          {
            status: "resolved",
            lastErrorCode: null,
            resolvedByUserId: null,
            resolvedByMembershipId: null,
            resolvedAuthority: "system",
            resolvedAtMs: delayed.execution.nowMs,
            updatedAtMs: delayed.execution.nowMs,
            version: 3,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, version
              FROM free_agent_draft_rollovers
              WHERE league_id = ? AND id = ?
            `)
            .get(IDS.league, IDS.rollover),
          {
            status: "recovery_required",
            version: 3,
          }
        );
      }
    );

    test(
      "shared restricted fallback publishes immediately when exact recovery evidence reaches its later rollover boundary",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        installRestrictedRolloverProcessingLease(
          runtime
        );
        const delayed =
          installDelayedRestrictedResolutionRecovery(
            runtime
          );
        const laterRolloverJobRunId = uuid(95_001);
        insert(runtime.database, "job_runs", {
          id: laterRolloverJobRunId,
          league_id: IDS.league,
          season_id: IDS.season,
          job_type: "fad_rollover",
          occurrence_key:
            `fad:${IDS.fad}:rollover:9:` +
            `${delayed.activationAtMs}`,
          scheduled_for_ms: delayed.activationAtMs,
          status: "running",
          attempt_count: 1,
          lease_owner:
            "later-recovery-rollover-worker",
          lease_expires_at_ms:
            delayed.activationAtMs + 60_000,
          started_at_ms: delayed.activationAtMs,
          completed_at_ms: null,
          result_json: null,
          last_error_code: null,
          created_at_ms:
            delayed.activationAtMs - DAY_MS,
          updated_at_ms: delayed.activationAtMs,
          version: 1,
          lease_token: uuid(95_002),
          next_attempt_at_ms: null,
        });
        const rolloverTransition = runtime.database
          .prepare(`
            UPDATE free_agent_draft_rollovers
            SET status = 'processing',
                processing_job_run_id = ?,
                processing_started_at_ms = ?,
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
              AND sequence = 9
              AND status = 'scheduled'
              AND version = 1
          `)
          .run(
            laterRolloverJobRunId,
            delayed.activationAtMs,
            delayed.activationAtMs,
            IDS.league,
            delayed.predecessorRolloverId
          );
        assert.equal(rolloverTransition.changes, 1);
        const boundaryExecution = Object.freeze({
          ...delayed.execution,
          nowMs: delayed.activationAtMs,
        });
        const command = restrictedFallbackCommand(
          boundaryExecution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId:
                IDS.fallbackExtensionRollover,
            }),
          }
        );

        const result = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(result.applied, true);
        assert.equal(result.replayed, false);
        assert.equal(
          result.fallbackOpensAtMs,
          boundaryExecution.nowMs
        );
        assert.equal(result.activationJobRunId, null);
        assert.equal(result.activationAtMs, null);
        assert.equal(
          result.sourceRecoveryId,
          delayed.recoveryId
        );
        assert.equal(
          result.activityId,
          IDS.fallbackActivity
        );
        assert.deepEqual(result.notificationIds, [
          IDS.fallbackNotification,
        ]);
        assert.equal(result.outboxEventIds.length, 5);
        assert.deepEqual(
          result.outboxEventIds.slice(0, 2),
          [
            IDS.fallbackFadOutbox,
            IDS.fallbackAuctionOutbox,
          ]
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM job_runs
              WHERE league_id = ?
                AND job_type = 'fad_fallback_activation'
            `)
            .get(IDS.league).count,
          0
        );
        const stateEvent = runtime.database
          .prepare(`
            SELECT activity_id AS activityId,
                   evidence_json AS evidenceJson
            FROM free_agent_draft_allocation_events
            WHERE league_id = ?
              AND allocation_id = ?
              AND allocation_version = 3
              AND event_kind = 'fallback_state_changed'
          `)
          .get(IDS.league, IDS.allocation);
        assert.equal(
          stateEvent.activityId,
          IDS.fallbackActivity
        );
        assert.deepEqual(
          JSON.parse(stateEvent.evidenceJson),
          {
            schemaVersion: 1,
            occurrenceKey:
              boundaryExecution.occurrenceKey,
            sourceAuctionId: IDS.auction,
            fallbackAuctionId: IDS.fallbackAuction,
            targetRolloverId:
              IDS.fallbackExtensionRollover,
            activationJobRunId: null,
            activationAtMs: null,
            sourceRecoveryId: delayed.recoveryId,
            activityId: IDS.fallbackActivity,
            notificationIds: [
              IDS.fallbackNotification,
            ],
            outboxEventIds: [
              ...result.outboxEventIds,
            ],
          }
        );
      }
    );

    test(
      "shared restricted fallback rejects a pre-existing farther-delayed target when the latest retry receipt is absent",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
          fallbackNeedsExtension: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        installRestrictedRolloverProcessingLease(
          runtime
        );
        const delayed =
          installDelayedRestrictedResolutionRecovery(
            runtime
          );
        withTableTriggersDisabled(
          runtime.database,
          [
            "free_agent_draft_rollovers",
            "free_agent_draft_recovery_action_command_results",
          ],
          () => {
            runtime.database
              .prepare(`
                DELETE FROM free_agent_draft_recovery_action_command_results
                WHERE league_id = ?
                  AND recovery_id = ?
              `)
              .run(
                IDS.league,
                delayed.recoveryId
              );
            insertScheduledExtensionRollover(
              runtime.database,
              {
                id: IDS.fallbackExtensionRollover,
                sequence: 10,
                predecessorId:
                  delayed.predecessorRolloverId,
                reason: "fallback_auction",
                sourceId: IDS.allocation,
                opensAtMs: delayed.activationAtMs,
                createdAtMs:
                  delayed.execution.nowMs,
              }
            );
          }
        );
        const command = restrictedFallbackCommand(
          delayed.execution,
          {
            ids: restrictedFallbackIds({
              extensionRolloverId: null,
              fallbackActivationJobRunId:
                uuid(92_008),
              activityId: null,
              fadOutboxEventId: null,
              auctionOutboxEventId: null,
              notificationIds: [],
            }),
          }
        );
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(() =>
          openRestrictedFallback(runtime, command)
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "shared restricted fallback revalidates every pre-existing farther-delay recovery predicate",
      (t) => {
        const variants = [
          "job-attempt",
          "recovery-status",
          "failure-event",
        ];
        for (const variant of variants) {
          const runtime = createRuntime(t);
          installRestrictedContext(runtime, {
            fallbackReady: true,
            fallbackNeedsExtension: true,
          });
          removeRestrictedImprovementForFallback(
            runtime
          );
          installRestrictedRolloverProcessingLease(
            runtime
          );
          const delayed =
            installDelayedRestrictedResolutionRecovery(
              runtime
            );
          withTableTriggersDisabled(
            runtime.database,
            [
              "job_runs",
              "free_agent_draft_rollovers",
              "free_agent_draft_recoveries",
              "auction_events",
            ],
            () => {
              if (variant === "job-attempt") {
                runtime.database
                  .prepare(`
                    UPDATE job_runs
                    SET attempt_count = 1
                    WHERE league_id = ? AND id = ?
                  `)
                  .run(
                    IDS.league,
                    delayed.execution.jobRunId
                  );
              } else if (
                variant === "recovery-status"
              ) {
                runtime.database
                  .prepare(`
                    UPDATE free_agent_draft_recoveries
                    SET status = 'ready'
                    WHERE league_id = ? AND id = ?
                  `)
                  .run(
                    IDS.league,
                    delayed.recoveryId
                  );
              } else {
                runtime.database
                  .prepare(`
                    UPDATE auction_events
                    SET metadata_json = json_set(
                      metadata_json,
                      '$.errorCode',
                      'DIFFERENT_FAILURE'
                    )
                    WHERE league_id = ?
                      AND auction_id = ?
                      AND event_type =
                        'fad_auction_resolution_failed'
                  `)
                  .run(IDS.league, IDS.auction);
              }
              insertScheduledExtensionRollover(
                runtime.database,
                {
                  id: IDS.fallbackExtensionRollover,
                  sequence: 10,
                  predecessorId:
                    delayed.predecessorRolloverId,
                  reason: "fallback_auction",
                  sourceId: IDS.allocation,
                  opensAtMs:
                    delayed.activationAtMs,
                  createdAtMs:
                    delayed.execution.nowMs,
                }
              );
            }
          );
          const command = restrictedFallbackCommand(
            delayed.execution,
            {
              ids: restrictedFallbackIds({
                extensionRolloverId: null,
                fallbackActivationJobRunId:
                  uuid(92_009),
                activityId: null,
                fadOutboxEventId: null,
                auctionOutboxEventId: null,
                notificationIds: [],
              }),
            }
          );
          const before =
            restrictedCancellationSnapshot(
              runtime.database
            );

          assert.throws(
            () =>
              openRestrictedFallback(
                runtime,
                command
              ),
            undefined,
            variant
          );
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            before,
            variant
          );
        }
      }
    );

    test(
      "shared restricted fallback fences every stale source and job lease identity with zero writes",
      (t) => {
        const variants = [
          ["job", { jobRunId: uuid(80_001) }],
          ["occurrence", {
            occurrenceKey:
              `auction:${IDS.auction}:0`,
          }],
          ["job version", {
            expectedJobVersion: 2,
          }],
          ["owner", { leaseOwner: "stale-worker" }],
          ["token", { leaseToken: uuid(80_002) }],
          ["auction version", {
            expectedAuctionVersion: 1,
          }],
          ["allocation version", {
            expectedAllocationVersion: 1,
          }],
        ];
        for (const [name, override] of variants) {
          const runtime = createRuntime(t);
          installRestrictedContext(runtime, {
            fallbackReady: true,
          });
          removeRestrictedImprovementForFallback(
            runtime
          );
          const execution =
            installRestrictedResolutionLease(runtime);
          const before = restrictedCancellationSnapshot(
            runtime.database
          );
          assert.throws(
            () =>
              openRestrictedFallback(
                runtime,
                restrictedFallbackCommand(
                  execution,
                  override
                )
              ),
            undefined,
            name
          );
          assert.deepEqual(
            restrictedCancellationSnapshot(
              runtime.database
            ),
            before,
            name
          );
        }
      }
    );

    test(
      "shared restricted fallback rejects the exact expired source resolver lease boundary with zero writes",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        const command = restrictedFallbackCommand(
          execution,
          {
            nowMs: execution.nowMs + 60_000,
          }
        );
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(() =>
          openRestrictedFallback(runtime, command)
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "shared restricted fallback discovers its immutable terminal handoff despite fresh semantic IDs and a later replay time",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        const command =
          restrictedFallbackCommand(execution);
        const first = openRestrictedFallback(
          runtime,
          command
        );
        const beforeReplay =
          restrictedCancellationSnapshot(
            runtime.database
          );
        const replayCommand =
          restrictedFallbackCommand(execution, {
            nowMs: execution.nowMs + 1,
            ids: freshRestrictedFallbackIds(),
          });

        const replay = openRestrictedFallback(
          runtime,
          replayCommand
        );

        assert.equal(first.replayed, false);
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          first
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          beforeReplay
        );
      }
    );

    test(
      "shared restricted fallback writes and fresh-ID replays an exact zero-recipient handoff",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        runtime.database
          .prepare(`
            UPDATE users
            SET status = 'deactivated',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ? AND status = 'active'
          `)
          .run(
            auctionRow(runtime.database)
              .resolves_at_ms - 1,
            IDS.managerUser
          );
        const execution =
          installRestrictedResolutionLease(runtime);
        const command = restrictedFallbackCommand(
          execution,
          {
            ids: restrictedFallbackIds({
              notificationIds: [],
            }),
          }
        );

        const first = openRestrictedFallback(
          runtime,
          command
        );
        const beforeReplay =
          restrictedCancellationSnapshot(
            runtime.database
          );
        const replay = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(execution, {
            nowMs: execution.nowMs + 1,
            ids: {
              ...freshRestrictedFallbackIds(),
              notificationIds: [],
            },
          })
        );

        assert.equal(first.applied, true);
        assert.deepEqual(first.notificationIds, []);
        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          first
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          beforeReplay
        );
      }
    );

    test(
      "shared restricted fallback excludes an active-status membership ended before publication and immutably replays without private evidence",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        runtime.database
          .prepare(`
            UPDATE league_memberships
            SET ended_at_ms = @endedAtMs,
                updated_at_ms = @endedAtMs,
                version = version + 1
            WHERE id = @membershipId
              AND status = 'active'
          `)
          .run({
            endedAtMs: execution.nowMs - 1,
            membershipId: IDS.managerMembership,
          });
        const command = restrictedFallbackCommand(
          execution,
          {
            ids: restrictedFallbackIds({
              notificationIds: [],
            }),
          }
        );

        const first = openRestrictedFallback(
          runtime,
          command
        );

        assert.equal(first.applied, true);
        assert.equal(first.replayed, false);
        assert.deepEqual(first.notificationIds, []);
        assert.equal(first.outboxEventIds.length, 4);
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM notifications
              WHERE league_id = @leagueId
                AND user_id = @userId
                AND event_type =
                  'fad_restricted_fallback_opened'
            `)
            .get({
              leagueId: IDS.league,
              userId: IDS.managerUser,
            }).count,
          0
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM outbox_event_audiences AS audience
              JOIN outbox_events AS event
                ON event.league_id = audience.league_id
               AND event.id = audience.outbox_event_id
              WHERE event.league_id = @leagueId
                AND event.created_at_ms = @createdAtMs
                AND audience.audience_kind = 'user'
                AND audience.user_id = @userId
            `)
            .get({
              leagueId: IDS.league,
              createdAtMs: execution.nowMs,
              userId: IDS.managerUser,
            }).count,
          0
        );

        runtime.database
          .prepare(`
            UPDATE league_memberships
            SET ended_at_ms = NULL,
                updated_at_ms = @updatedAtMs,
                version = version + 1
            WHERE id = @membershipId
              AND status = 'active'
          `)
          .run({
            membershipId: IDS.managerMembership,
            updatedAtMs: execution.nowMs + 1,
          });
        const beforeReplay =
          restrictedCancellationSnapshot(
            runtime.database
          );
        const replay = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(execution, {
            nowMs: execution.nowMs + 1,
            ids: freshRestrictedFallbackIds(),
          })
        );

        assert.equal(replay.replayed, true);
        assert.deepEqual(
          {
            ...replay,
            replayed: false,
          },
          first
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          beforeReplay
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM notifications
              WHERE league_id = @leagueId
                AND user_id = @userId
                AND event_type =
                  'fad_restricted_fallback_opened'
            `)
            .get({
              leagueId: IDS.league,
              userId: IDS.managerUser,
            }).count,
          0
        );
      }
    );

    test(
      "shared restricted fallback replay isolates two same-FAD handoffs committed in the same millisecond",
      (t) => {
        const runtime = createRuntime(t);
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const secondIds =
          cloneRestrictedFallbackSource(runtime);
        const firstExecution =
          installRestrictedResolutionLease(runtime);
        const secondExecution =
          installClonedRestrictedResolutionLease(
            runtime,
            secondIds,
            firstExecution.nowMs
          );
        const firstCommand =
          restrictedFallbackCommand(firstExecution);
        const secondCommand =
          clonedRestrictedFallbackCommand(
            secondIds,
            secondExecution
          );

        const first = openRestrictedFallback(
          runtime,
          firstCommand
        );
        const second = openRestrictedFallback(
          runtime,
          secondCommand
        );
        const beforeReplay =
          restrictedCancellationSnapshot(
            runtime.database
          );
        const replay = openRestrictedFallback(
          runtime,
          restrictedFallbackCommand(firstExecution, {
            nowMs: firstExecution.nowMs + 1,
            ids: freshRestrictedFallbackIds(),
          })
        );

        assert.equal(first.replayed, false);
        assert.equal(second.replayed, false);
        assert.equal(replay.replayed, true);
        assert.equal(
          replay.fallbackAuctionId,
          first.fallbackAuctionId
        );
        assert.deepEqual(
          replay.outboxEventIds,
          first.outboxEventIds
        );
        assert.notDeepEqual(
          replay.outboxEventIds,
          second.outboxEventIds
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          beforeReplay
        );
      }
    );

    test(
      "shared restricted fallback replay rejects exact outbox payload or audience drift",
      (t) => {
        const variants = [
          (runtime, first) => {
            runtime.database.prepare(`
              UPDATE outbox_events
              SET payload_json = '{"kind":"invalidation"}'
              WHERE league_id = ? AND id = ?
            `).run(IDS.league, first.outboxEventIds[0]);
          },
          (runtime, first, execution) => {
            insert(
              runtime.database,
              "outbox_event_audiences",
              {
                id: uuid(95_001),
                league_id: IDS.league,
                outbox_event_id: first.outboxEventIds[0],
                audience_kind: "team",
                team_id: IDS.team,
                user_id: null,
                created_at_ms: execution.nowMs,
              }
            );
          },
        ];

        for (const mutate of variants) {
          const runtime = createRuntime(t);
          installRestrictedContext(runtime, {
            fallbackReady: true,
          });
          removeRestrictedImprovementForFallback(runtime);
          const execution =
            installRestrictedResolutionLease(runtime);
          const first = openRestrictedFallback(
            runtime,
            restrictedFallbackCommand(execution)
          );
          mutate(runtime, first, execution);

          assert.throws(() =>
            openRestrictedFallback(
              runtime,
              restrictedFallbackCommand(execution, {
                nowMs: execution.nowMs + 1,
                ids: freshRestrictedFallbackIds(),
              })
            )
          );
        }
      }
    );

    test(
      "shared restricted fallback rolls every late write and job settlement back",
      (t) => {
        const runtime = createRuntime(t, {
          fallbackBeforeCommit() {
            throw new Error(
              "restricted fallback rollback"
            );
          },
        });
        installRestrictedContext(runtime, {
          fallbackReady: true,
        });
        removeRestrictedImprovementForFallback(
          runtime
        );
        const execution =
          installRestrictedResolutionLease(runtime);
        const before = restrictedCancellationSnapshot(
          runtime.database
        );

        assert.throws(() =>
          openRestrictedFallback(
            runtime,
            restrictedFallbackCommand(execution)
          )
        );
        assert.deepEqual(
          restrictedCancellationSnapshot(
            runtime.database
          ),
          before
        );
      }
    );

    test(
      "rolls back the command, event, result, and idempotency pair after a late failure",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit() {
            throw new Error("injected late failure");
          },
        });
        const initialEventCount = runtime.database
          .prepare(
            "SELECT COUNT(*) AS count FROM auction_events"
          )
          .get().count;
        assert.throws(
          () =>
            runtime.repository.administer(
              commandFor(runtime, "remove_bid")
            ),
          (error) =>
            error.code ===
            "REPOSITORY_OPERATION_FAILED"
        );
        assert.deepEqual(
          {
            status: bidRow(runtime.database).status,
            version: bidRow(runtime.database).version,
          },
          {
            status: "active",
            version: 1,
          }
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT COUNT(*) AS count FROM auction_events"
            )
            .get().count,
          initialEventCount
        );
        assert.equal(
          adminRows(
            runtime.database,
            "idempotency_requests"
          ).length,
          0
        );
        assert.equal(
          adminRows(
            runtime.database,
            "auction_administration_command_results"
          ).length,
          0
        );
      }
    );

    test(
      "database guards keep successful result and completed idempotency evidence immutable",
      (t) => {
        const runtime = createRuntime(t);
        runtime.repository.administer(
          commandFor(runtime, "edit_bid")
        );
        const result = adminRows(
          runtime.database,
          "auction_administration_command_results"
        )[0];
        const idempotency = adminRows(
          runtime.database,
          "idempotency_requests"
        )[0];
        assert.throws(
          () =>
            runtime.database
              .prepare(`
                UPDATE auction_administration_command_results
                SET response_http_status = 202
                WHERE id = ?
              `)
              .run(result.id),
          /immutable/i
        );
        assert.throws(
          () =>
            runtime.database
              .prepare(`
                DELETE
                FROM auction_administration_command_results
                WHERE id = ?
              `)
              .run(result.id),
          /immutable|result/i
        );
        assert.throws(
          () =>
            runtime.database
              .prepare(`
                UPDATE idempotency_requests
                SET result_id = ?
                WHERE id = ?
              `)
              .run(uuid(99_999), idempotency.id),
          /immutable/i
        );
      }
    );
  }
);
