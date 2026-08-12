const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  after,
  before,
  describe,
  test,
} = require("node:test");

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
  normalizeCandidateEligiblePlayerQuery,
} = require(
  "../../src/domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FIRST_MATCHUP_STARTS_AT_MS =
  2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 604_800_000;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 172_800_000;
const OPENED_AT_MS =
  HELP_OPENS_AT_MS - 10_000;
const COMMAND_AT_MS =
  OPENED_AT_MS + 1_000;
const HELP_AT_MS = HELP_OPENS_AT_MS + 1;
const IDEMPOTENCY_EXPIRY_MS =
  FIRST_MATCHUP_STARTS_AT_MS + 10_000;

let templateRoot;
let templatePath;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  return database
    .prepare(`
      INSERT INTO ${tableName} (
        ${columns.join(", ")}
      ) VALUES (
        ${columns
          .map((column) => `@${column}`)
          .join(", ")}
      )
    `)
    .run(values);
}

function databaseBytes(database) {
  return database.serialize().toString("hex");
}

function count(
  database,
  tableName,
  where = "",
  ...parameters
) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${tableName} ${where}`
    )
    .get(...parameters).count;
}

function dropTableTriggers(
  database,
  tableName
) {
  for (const { name } of database
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name = ?
      ORDER BY name
    `)
    .all(tableName)) {
    database.exec(
      `DROP TRIGGER "${name.replaceAll('"', '""')}"`
    );
  }
}

before(() => {
  templateRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-candidate-card-repository-template-"
    )
  );
  templatePath = path.join(
    templateRoot,
    "template.sqlite3"
  );
  const connection = openDatabase({
    databasePath: templatePath,
    environment: "test",
  });
  applyMigrations({
    database: connection.database,
    migrations: discoverMigrations({
      migrationsDirectory:
        MIGRATIONS_DIRECTORY,
    }),
    applicationBuildId:
      "candidate-card-repository-foundation",
    now: () => 1_000,
  });
  connection.database.close();
});

after(() => {
  if (templateRoot) {
    fs.rmSync(templateRoot, {
      recursive: true,
      force: true,
    });
  }
});

function seedUser(
  database,
  id,
  label
) {
  insert(database, "users", {
    id,
    email_normalized:
      `${label.toLowerCase()}@example.test`,
    email_display:
      `${label}@example.test`,
    display_name: label,
    display_name_normalized:
      label.toLowerCase(),
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedMembership(
  database,
  {
    id,
    leagueId,
    userId,
    permissionCategory,
  }
) {
  insert(database, "league_memberships", {
    id,
    league_id: leagueId,
    user_id: userId,
    permission_category:
      permissionCategory,
    status: "active",
    joined_at_ms: 10,
    ended_at_ms: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function cardRecord(
  ids,
  teamId,
  cardId
) {
  return {
    id: cardId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
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
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    cap_status: "compliant",
    allocation_eligibility: "eligible",
    allocation_exclusion_reason: null,
  };
}

function seedOpeningRevision(
  database,
  ids,
  {
    teamId,
    cardId,
    revisionId,
  }
) {
  insert(database, "candidate_card_revisions", {
    id: revisionId,
    league_id: ids.league,
    season_id: ids.season,
    fad_id: ids.fad,
    card_id: cardId,
    team_id: teamId,
    resulting_card_version: 1,
    action: "card_opened",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    before_evidence_json: "{}",
    after_evidence_json:
      '{"card":{"version":1}}',
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    version: 1,
  });
}

function seedOpenLeague(database, base = 1_000) {
  const ids = {
    commissionerUser: uuid(base + 1),
    managerOneUser: uuid(base + 2),
    managerTwoUser: uuid(base + 3),
    memberUser: uuid(base + 4),
    administratorRole: uuid(base + 5),
    league: uuid(base + 10),
    commissionerMembership:
      uuid(base + 11),
    managerOneMembership:
      uuid(base + 12),
    managerTwoMembership:
      uuid(base + 13),
    memberMembership: uuid(base + 14),
    season: uuid(base + 20),
    teamOne: uuid(base + 21),
    teamTwo: uuid(base + 22),
    managerOneAssignment:
      uuid(base + 23),
    managerTwoAssignment:
      uuid(base + 24),
    week: uuid(base + 30),
    readiness: uuid(base + 31),
    fad: uuid(base + 32),
    participantOne: uuid(base + 33),
    participantTwo: uuid(base + 34),
    cardOne: uuid(base + 35),
    cardTwo: uuid(base + 36),
    openingRevisionOne:
      uuid(base + 37),
    openingRevisionTwo:
      uuid(base + 38),
  };

  seedUser(
    database,
    ids.commissionerUser,
    `Commissioner ${base}`
  );
  seedUser(
    database,
    ids.managerOneUser,
    `Manager One ${base}`
  );
  seedUser(
    database,
    ids.managerTwoUser,
    `Manager Two ${base}`
  );
  seedUser(
    database,
    ids.memberUser,
    `Member ${base}`
  );
  insert(database, "platform_roles", {
    id: ids.administratorRole,
    user_id: ids.commissionerUser,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: null,
    granted_at_ms: 10,
    ended_at_ms: null,
    version: 1,
  });
  insert(database, "leagues", {
    id: ids.league,
    name: `League ${base}`,
    name_normalized: `league ${base}`,
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  for (const membership of [
    {
      id: ids.commissionerMembership,
      userId: ids.commissionerUser,
      permissionCategory:
        "commissioner",
    },
    {
      id: ids.managerOneMembership,
      userId: ids.managerOneUser,
      permissionCategory: "manager",
    },
    {
      id: ids.managerTwoMembership,
      userId: ids.managerTwoUser,
      permissionCategory: "manager",
    },
    {
      id: ids.memberMembership,
      userId: ids.memberUser,
      permissionCategory: "member",
    },
  ]) {
    seedMembership(database, {
      ...membership,
      leagueId: ids.league,
    });
  }
  insert(database, "league_settings", {
    league_id: ids.league,
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
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(database, "seasons", {
    id: ids.season,
    league_id: ids.league,
    label: `Season ${base}`,
    nhl_season_key: `${base}2027`,
    status: "active",
    regular_season_starts_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS +
      10_000,
    fantasy_playoffs_start_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS +
      8_000,
    fantasy_playoffs_end_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS +
      10_000,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  database
    .prepare(`
      UPDATE leagues
      SET status = 'active',
          commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 20,
          version = 2
      WHERE id = ?
    `)
    .run(
      ids.commissionerMembership,
      ids.season,
      ids.league
    );
  for (const [teamId, number] of [
    [ids.teamOne, 1],
    [ids.teamTwo, 2],
  ]) {
    insert(database, "teams", {
      id: teamId,
      league_id: ids.league,
      name: `Team ${number} ${base}`,
      name_normalized:
        `team ${number} ${base}`,
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 20,
      updated_at_ms: 20,
      version: 1,
    });
  }
  for (const assignment of [
    {
      id: ids.managerOneAssignment,
      teamId: ids.teamOne,
      userId: ids.managerOneUser,
      membershipId:
        ids.managerOneMembership,
    },
    {
      id: ids.managerTwoAssignment,
      teamId: ids.teamTwo,
      userId: ids.managerTwoUser,
      membershipId:
        ids.managerTwoMembership,
    },
  ]) {
    insert(
      database,
      "team_manager_assignments",
      {
        id: assignment.id,
        league_id: ids.league,
        team_id: assignment.teamId,
        user_id: assignment.userId,
        membership_id:
          assignment.membershipId,
        assigned_by_user_id:
          ids.commissionerUser,
        status: "accepted",
        assigned_at_ms: 20,
        accepted_at_ms: 20,
        ended_at_ms: null,
        version: 1,
      }
    );
  }
  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.season,
    week_key: "W01",
    sequence: 1,
    starts_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS,
    baseline_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 100,
    locks_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 200,
    ends_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 1_000,
    rolls_over_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 1_100,
    status: "scheduled",
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  insert(
    database,
    "free_agent_draft_readiness_operations",
    {
      id: ids.readiness,
      league_id: ids.league,
      season_id: ids.season,
      readiness_occurrence_key:
        `fad:${ids.season}:readiness`,
      trigger_kind:
        "no_draft_inaugural",
      entry_draft_id: null,
      setup_exemption_id: null,
      status: "pending",
      attempt_count: 0,
      blockers_json: "[]",
      created_at_ms: OPENED_AT_MS,
      updated_at_ms: OPENED_AT_MS,
      version: 1,
    }
  );
  insert(database, "free_agent_drafts", {
    id: ids.fad,
    league_id: ids.league,
    season_id: ids.season,
    readiness_operation_id:
      ids.readiness,
    readiness_occurrence_key:
      `fad:${ids.season}:readiness`,
    first_matchup_week_id: ids.week,
    current_competition_first_matchup_week_id:
      ids.week,
    schedule_recovery_id: null,
    participating_team_count: 2,
    status: "cards_open",
    setup_path: "no_draft_inaugural",
    entry_draft_id: null,
    setup_exemption_id: null,
    prior_season_rollover_id: null,
    no_draft_reason:
      "Foundation fixture with no Entry Draft.",
    opening_authority: "system",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms:
      CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  });
  for (const participant of [
    {
      id: ids.participantOne,
      teamId: ids.teamOne,
      cardId: ids.cardOne,
      revisionId:
        ids.openingRevisionOne,
    },
    {
      id: ids.participantTwo,
      teamId: ids.teamTwo,
      cardId: ids.cardTwo,
      revisionId:
        ids.openingRevisionTwo,
    },
  ]) {
    insert(
      database,
      "free_agent_draft_teams",
      {
        id: participant.id,
        league_id: ids.league,
        season_id: ids.season,
        fad_id: ids.fad,
        team_id: participant.teamId,
        team_status_at_setup: "active",
        created_at_ms: OPENED_AT_MS,
      }
    );
    insert(
      database,
      "candidate_cards",
      cardRecord(
        ids,
        participant.teamId,
        participant.cardId
      )
    );
    seedOpeningRevision(database, ids, {
      teamId: participant.teamId,
      cardId: participant.cardId,
      revisionId:
        participant.revisionId,
    });
  }
  return ids;
}

function createRuntime(
  t,
  {
    beforeCommit,
  } = {}
) {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "hundo-candidate-card-repository-"
    )
  );
  const databasePath = path.join(
    root,
    "league.sqlite3"
  );
  fs.copyFileSync(templatePath, databasePath);
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  connection.database.exec(
    "DROP TRIGGER free_agent_drafts_valid_insert"
  );
  let ids;
  try {
    ids = seedOpenLeague(
      connection.database
    );
  } catch (error) {
    throw new Error(
      `Candidate Card fixture seed failed: ${error.message}`,
      { cause: error }
    );
  }
  const mutationSideEffects = [];
  const helpSideEffects = [];
  const repository =
    createSqliteCandidateCardRepository({
      database: connection.database,
      writeMutationSideEffects(record) {
        mutationSideEffects.push(record);
      },
      writeHelpGrantSideEffects(record) {
        helpSideEffects.push(record);
      },
      beforeCommit,
    });
  t.after(() => {
    if (connection.database.open) {
      connection.database.close();
    }
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  });
  return {
    ...connection,
    ids,
    repository,
    mutationSideEffects,
    helpSideEffects,
  };
}

function scope(
  runtime,
  {
    teamId = runtime.ids.teamOne,
    cardId = runtime.ids.cardOne,
    leagueId = runtime.ids.league,
    seasonId = runtime.ids.season,
    fadId = runtime.ids.fad,
  } = {}
) {
  return {
    leagueId,
    seasonId,
    fadId,
    cardId,
    teamId,
  };
}

function managerOne(runtime) {
  return {
    userId: runtime.ids.managerOneUser,
    membershipId:
      runtime.ids.managerOneMembership,
    authority: "manager",
  };
}

function managerTwo(runtime) {
  return {
    userId: runtime.ids.managerTwoUser,
    membershipId:
      runtime.ids.managerTwoMembership,
    authority: "manager",
  };
}

function commissioner(runtime) {
  return {
    userId:
      runtime.ids.commissionerUser,
    membershipId:
      runtime.ids
        .commissionerMembership,
    authority: "commissioner",
  };
}

function memberViewer(runtime) {
  return {
    userId: runtime.ids.memberUser,
    membershipId:
      runtime.ids.memberMembership,
  };
}

function privateViewer(actor) {
  return {
    userId: actor.userId,
    membershipId: actor.membershipId,
  };
}

function readPrivateCurrent(
  runtime,
  {
    leagueId = runtime.ids.league,
    fadId = runtime.ids.fad,
    teamId = runtime.ids.teamOne,
    viewer = privateViewer(
      managerOne(runtime)
    ),
    nowMs = COMMAND_AT_MS,
  } = {}
) {
  return runtime.repository.readPrivateCurrent({
    leagueId,
    fadId,
    teamId,
    viewer,
    nowMs,
  });
}

function previewRevision(
  runtime,
  {
    action,
    leagueId = runtime.ids.league,
    fadId = runtime.ids.fad,
    teamId = runtime.ids.teamOne,
    viewer = privateViewer(
      managerOne(runtime)
    ),
    nowMs = COMMAND_AT_MS,
  } = {}
) {
  return runtime.repository
    .previewRevisionCurrent({
      leagueId,
      fadId,
      teamId,
      viewer,
      nowMs,
      action,
    });
}

function assertPreviewOnlyCapabilities(card) {
  assert.equal(
    card.visibilityMode,
    "private_read_only"
  );
  for (const capability of [
    ...Object.values(card.capabilities),
    ...card.slots.flatMap((slot) =>
      Object.values(slot.capabilities)
    ),
  ]) {
    assert.deepEqual(capability, {
      allowed: false,
      reasonCode: "PREVIEW_ONLY",
    });
  }
}

function eligiblePlayerQuery(
  runtime,
  {
    leagueId = runtime.ids.league,
    fadId = runtime.ids.fad,
    teamId = runtime.ids.teamOne,
    slotKey = "F01",
    q,
    cursor,
    limit,
  } = {}
) {
  const query = { slotKey };
  if (q !== undefined) query.q = q;
  if (cursor !== undefined) {
    query.cursor = cursor;
  }
  if (limit !== undefined) {
    query.limit = limit;
  }
  return normalizeCandidateEligiblePlayerQuery(
    query,
    { leagueId, fadId, teamId }
  );
}

function readEligiblePlayers(
  runtime,
  {
    viewer = privateViewer(
      managerOne(runtime)
    ),
    nowMs = COMMAND_AT_MS,
    ...queryOptions
  } = {}
) {
  return runtime.repository
    .readEligiblePlayersCurrent({
      query: eligiblePlayerQuery(
        runtime,
        queryOptions
      ),
      viewer,
      nowMs,
    });
}

function seedSelectablePlayer(
  runtime,
  {
    playerId,
    positionGroup = "F",
    fullName =
      `Eligible ${playerId.slice(-4)}`,
    leagueId = runtime.ids.league,
    positionId = uuid(
      Number(playerId.slice(-12)) +
        100_000
    ),
  }
) {
  insert(runtime.database, "players", {
    id: playerId,
    first_name: "Eligible",
    last_name: playerId.slice(-4),
    full_name: fullName,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(
    runtime.database,
    "league_player_positions",
    {
      id: positionId,
      league_id: leagueId,
      player_id: playerId,
      position_group: positionGroup,
      reason: "Foundation fixture",
      corrected_by_user_id:
        runtime.ids.commissionerUser,
      effective_at_ms: 10,
      ended_at_ms: null,
      version: 1,
    }
  );
}

function seedActiveContract(
  runtime,
  {
    playerId,
    contractId,
  }
) {
  insert(runtime.database, "contracts", {
    id: contractId,
    league_id: runtime.ids.league,
    player_id: playerId,
    current_team_id:
      runtime.ids.teamTwo,
    contract_type: "normal",
    original_total_value_cents: 300,
    original_term_years: 3,
    aav_cents: 100,
    start_season_id: runtime.ids.season,
    status: "active",
    acquisition_source_type:
      "foundation_fixture",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms:
      null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function seedReleasedProspectHistory(
  database,
  ids,
  {
    playerId,
    eventId,
    eventType =
      "unsigned_prospect_rights_released",
    occurredAtMs = COMMAND_AT_MS - 1,
  }
) {
  insert(database, "ownership_events", {
    id: eventId,
    league_id: ids.league,
    season_id: ids.season,
    player_id: playerId,
    team_id: ids.teamOne,
    ownership_id: null,
    event_type: eventType,
    actor_user_id:
      ids.managerOneUser,
    source_type:
      "candidate_card_foundation",
    source_id: null,
    before_metadata_json: null,
    after_metadata_json: null,
    reason: null,
    occurred_at_ms: occurredAtMs,
  });
}

function seedPendingFadAllocation(
  database,
  ids,
  {
    allocationId,
    playerId,
  }
) {
  insert(
    database,
    "free_agent_draft_player_allocations",
    {
      id: allocationId,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      player_id: playerId,
      status: "pending",
      decision_code: null,
      winning_snapshot_entry_id: null,
      winning_team_id: null,
      contract_id: null,
      ownership_id: null,
      restricted_auction_id: null,
      fallback_open_auction_id: null,
      restricted_minimum_total_cents:
        null,
      restricted_minimum_term_years:
        null,
      restricted_minimum_aav_cents:
        null,
      accounted_at_ms: null,
      last_error_code: null,
      created_at_ms: COMMAND_AT_MS - 1,
      updated_at_ms: COMMAND_AT_MS - 1,
      version: 1,
    }
  );
}

function seedFadRecovery(
  database,
  ids,
  {
    recoveryId,
    playerId,
    status = "pending",
  }
) {
  insert(
    database,
    "free_agent_draft_recoveries",
    {
      id: recoveryId,
      league_id: ids.league,
      season_id: ids.season,
      fad_id: ids.fad,
      player_id: playerId,
      allocation_id: null,
      rollover_id: null,
      auction_id: null,
      job_run_id: null,
      kind: "allocation_retry",
      status,
      earliest_activation_at_ms: null,
      target_resolution_at_ms: null,
      last_error_code: null,
      commissioner_reason: null,
      created_by_operation_id: null,
      resolved_by_user_id:
        status === "resolved"
          ? ids.commissionerUser
          : null,
      resolved_by_membership_id:
        status === "resolved"
          ? ids.commissionerMembership
          : null,
      resolved_authority:
        status === "resolved"
          ? "commissioner"
          : null,
      created_at_ms: COMMAND_AT_MS - 1,
      updated_at_ms: COMMAND_AT_MS - 1,
      resolved_at_ms:
        status === "resolved"
          ? COMMAND_AT_MS - 1
          : null,
      version: 1,
    }
  );
}

function seedSourcePositionPlayer(
  runtime,
  {
    playerId,
    fullName,
    positions,
  }
) {
  insert(runtime.database, "players", {
    id: playerId,
    first_name: "Source",
    last_name: playerId.slice(-4),
    full_name: fullName,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  positions.forEach(
    (positionGroup, index) => {
      insert(
        runtime.database,
        "player_source_state",
        {
          id: uuid(
            Number(playerId.slice(-12)) *
              10 +
              200_000 +
              index
          ),
          player_id: playerId,
          provider: `provider-${index + 1}`,
          source_position: positionGroup,
          normalized_position: positionGroup,
          nhl_team_abbreviation: null,
          active: 1,
          source_version: "foundation",
          source_payload_json: null,
          effective_at_ms: 10,
          ended_at_ms: null,
          created_at_ms: 10,
        }
      );
    }
  );
}

function seedOpenAuction(
  runtime,
  {
    auctionId,
    playerId,
    sourceKind,
    rolloverId = null,
  }
) {
  insert(runtime.database, "auctions", {
    id: auctionId,
    league_id: runtime.ids.league,
    season_id: runtime.ids.season,
    player_id: playerId,
    status: "open",
    opened_at_ms: COMMAND_AT_MS - 1,
    resolves_at_ms:
      COMMAND_AT_MS + 86_400_000,
    created_at_ms: COMMAND_AT_MS - 1,
    updated_at_ms: COMMAND_AT_MS - 1,
    version: 1,
  });
  insert(runtime.database, "auction_contexts", {
    id: auctionId,
    league_id: runtime.ids.league,
    season_id: runtime.ids.season,
    auction_id: auctionId,
    source_kind: sourceKind,
    fad_id:
      sourceKind === "ordinary_weekly"
        ? null
        : runtime.ids.fad,
    fad_rollover_id: rolloverId,
    fad_allocation_id: null,
    fad_origin:
      sourceKind === "ordinary_weekly"
        ? null
        : "manager_nomination",
    created_at_ms: COMMAND_AT_MS - 1,
  });
}

function seedInitialFadRollover(
  runtime,
  rolloverId
) {
  const rollsOverAtMs =
    COMMAND_AT_MS + 86_400_000;
  insert(
    runtime.database,
    "free_agent_draft_rollovers",
    {
      id: rolloverId,
      league_id: runtime.ids.league,
      season_id: runtime.ids.season,
      fad_id: runtime.ids.fad,
      sequence: 1,
      window_kind: "initial",
      predecessor_rollover_id: null,
      extension_reason: null,
      extension_source_id: null,
      opens_at_ms:
        rollsOverAtMs - 86_400_000,
      creation_cutoff_at_ms:
        rollsOverAtMs - 3_600_000,
      rolls_over_at_ms: rollsOverAtMs,
      status: "scheduled",
      processing_job_run_id: null,
      processing_started_at_ms: null,
      completed_at_ms: null,
      last_error_code: null,
      created_at_ms: COMMAND_AT_MS,
      updated_at_ms: COMMAND_AT_MS,
      version: 1,
    }
  );
}

function seedApprovedRightsReleaseReentry(
  runtime,
  {
    playerId,
    releaseEventId,
    draftId,
    snapshotId,
    eligiblePlayerId,
    confirmedAtMs,
  }
) {
  for (const tableName of [
    "entry_drafts",
    "draft_eligibility_snapshots",
    "draft_eligible_players",
  ]) {
    dropTableTriggers(
      runtime.database,
      tableName
    );
  }
  insert(runtime.database, "entry_drafts", {
    id: draftId,
    league_id: runtime.ids.league,
    season_id: runtime.ids.season,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: confirmedAtMs - 2,
    completed_at_ms: confirmedAtMs - 1,
    created_by_user_id:
      runtime.ids.commissionerUser,
    created_at_ms: confirmedAtMs - 3,
    updated_at_ms: confirmedAtMs - 1,
    version: 1,
  });
  insert(
    runtime.database,
    "draft_eligibility_snapshots",
    {
      id: snapshotId,
      league_id: runtime.ids.league,
      draft_id: draftId,
      nhl_entry_draft_key: "2026",
      source_version: "foundation",
      snapshot_version: 1,
      status: "confirmed",
      confirmed_by_user_id:
        runtime.ids.commissionerUser,
      confirmed_at_ms: confirmedAtMs,
      created_at_ms: confirmedAtMs - 2,
    }
  );
  insert(
    runtime.database,
    "draft_eligible_players",
    {
      id: eligiblePlayerId,
      league_id: runtime.ids.league,
      eligibility_snapshot_id: snapshotId,
      player_id: playerId,
      position_group: "F",
      eligibility_reason:
        "rights_release_reentry",
      nhl_draft_year: null,
      nhl_round: null,
      nhl_overall_selection: null,
      rights_release_event_id:
        releaseEventId,
      created_at_ms: confirmedAtMs,
    }
  );
}

function idempotency(
  requestId,
  clientKey
) {
  return {
    requestId,
    clientKey,
    expiresAtMs:
      IDEMPOTENCY_EXPIRY_MS,
  };
}

function addCommand(
  runtime,
  {
    entryId = uuid(5_001),
    playerId = uuid(5_002),
    slotKey = "F01",
    totalValueCents = 600,
    termYears = 2,
    expectedCardVersion = 1,
    actor = managerOne(runtime),
    requestId = uuid(5_003),
    clientKey = "candidate-add",
    revisionId = uuid(5_004),
    nowMs = COMMAND_AT_MS,
  } = {}
) {
  return {
    scope: scope(runtime),
    actor,
    expectedCardVersion,
    nowMs,
    idempotency: idempotency(
      requestId,
      clientKey
    ),
    revisionId,
    action: {
      type: "add",
      entryId,
      playerId,
      slotKey,
      totalValueCents,
      termYears,
    },
  };
}

function currentAddCommand(
  runtime,
  overrides = {}
) {
  const command = addCommand(
    runtime,
    overrides
  );
  return {
    leagueId:
      overrides.leagueId ??
      runtime.ids.league,
    fadId:
      overrides.fadId ?? runtime.ids.fad,
    teamId:
      overrides.teamId ??
      runtime.ids.teamOne,
    viewer:
      overrides.viewer ??
      privateViewer(command.actor),
    expectedCardVersion:
      command.expectedCardVersion,
    nowMs: command.nowMs,
    idempotency: command.idempotency,
    revisionId: command.revisionId,
    action: command.action,
  };
}

function currentHelpCommand(
  runtime,
  overrides = {}
) {
  return {
    leagueId:
      overrides.leagueId ??
      runtime.ids.league,
    fadId:
      overrides.fadId ?? runtime.ids.fad,
    teamId:
      overrides.teamId ??
      runtime.ids.teamOne,
    viewer:
      overrides.viewer ??
      privateViewer(managerOne(runtime)),
    nowMs:
      overrides.nowMs ?? HELP_AT_MS,
    idempotency: idempotency(
      overrides.requestId ?? uuid(5_200),
      overrides.clientKey ??
        "current-candidate-help"
    ),
    helpRequestId:
      overrides.helpRequestId ??
      uuid(5_201),
    message:
      Object.prototype.hasOwnProperty.call(
        overrides,
        "message"
      )
        ? overrides.message
        : "Please review my Candidate Card.",
  };
}

function assertCurrentPrivatePathsHidden(
  runtime,
  {
    viewer,
    label,
    nowMs = HELP_AT_MS + 10,
  }
) {
  const beforeBytes = databaseBytes(
    runtime.database
  );
  const beforeChanges = runtime.database
    .prepare(
      "SELECT total_changes() AS value"
    )
    .get().value;
  const beforeMutationSideEffects =
    runtime.mutationSideEffects.length;
  const beforeHelpSideEffects =
    runtime.helpSideEffects.length;

  assert.equal(
    readPrivateCurrent(runtime, {
      viewer,
      nowMs,
    }),
    null,
    `${label}: private read must hide the card`
  );
  assert.equal(
    runtime.repository.mutateCurrent({
      ...currentAddCommand(runtime, {
        viewer,
        nowMs,
        requestId: uuid(5_240),
        revisionId: uuid(5_241),
        clientKey:
          "stale-authority-mutation",
      }),
      action: {
        type: "edit",
        entryId: uuid(5_242),
        totalValueCents: 900,
        termYears: 3,
      },
    }),
    null,
    `${label}: private mutation must use the same hidden-scope denial`
  );
  assert.equal(
    runtime.repository.requestHelpCurrent(
      currentHelpCommand(runtime, {
        viewer,
        nowMs,
        requestId: uuid(5_244),
        helpRequestId: uuid(5_245),
        clientKey: "stale-authority-help",
      })
    ),
    null,
    `${label}: help must use the same hidden-scope denial`
  );
  assert.equal(
    runtime.database
      .prepare(
        "SELECT total_changes() AS value"
      )
      .get().value,
    beforeChanges,
    `${label}: denied paths must not write`
  );
  assert.equal(
    databaseBytes(runtime.database),
    beforeBytes,
    `${label}: denied paths must preserve database bytes`
  );
  assert.equal(
    runtime.mutationSideEffects.length,
    beforeMutationSideEffects,
    `${label}: denied paths must not publish mutation effects`
  );
  assert.equal(
    runtime.helpSideEffects.length,
    beforeHelpSideEffects,
    `${label}: denied paths must not publish help effects`
  );
}

function summerCommand(
  runtime,
  {
    affectedPlayerIds = [],
    sourceOperationId = uuid(9_001),
    sourceKind = "player_state",
    nowMs = COMMAND_AT_MS + 100,
    revisionId = uuid(9_002),
  } = {}
) {
  return {
    scope: scope(runtime),
    affectedPlayerIds,
    sourceOperationId,
    sourceKind,
    nowMs,
    revisionId,
  };
}

function synchronizeSummer(runtime, command) {
  return runtime.database
    .transaction(() =>
      runtime.repository
        .synchronizeSummerStateCurrent(command)
    )
    .immediate();
}

function assertRepositoryError(
  callback,
  reasonCode
) {
  assert.throws(callback, (error) => {
    return (
      error?.details?.reasonCode ===
      reasonCode
    );
  });
}

function seedContractedCarryover(
  runtime,
  {
    playerId = uuid(7_001),
    ownershipId = uuid(7_002),
    contractId = uuid(7_003),
    entryId = uuid(7_004),
  } = {}
) {
  insert(runtime.database, "players", {
    id: playerId,
    first_name: "Carried",
    last_name: playerId.slice(-4),
    full_name:
      `Carried ${playerId.slice(-4)}`,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  insert(runtime.database, "player_ownerships", {
    id: ownershipId,
    league_id: runtime.ids.league,
    season_id: runtime.ids.season,
    player_id: playerId,
    team_id: runtime.ids.teamOne,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type:
      "season_rollover",
    acquired_transaction_id: null,
    created_at_ms: OPENED_AT_MS - 100,
    updated_at_ms: OPENED_AT_MS - 100,
    version: 1,
  });
  insert(runtime.database, "contracts", {
    id: contractId,
    league_id: runtime.ids.league,
    player_id: playerId,
    current_team_id:
      runtime.ids.teamOne,
    contract_type: "normal",
    original_total_value_cents: 300,
    original_term_years: 3,
    aav_cents: 100,
    start_season_id: runtime.ids.season,
    status: "active",
    acquisition_source_type:
      "season_rollover",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms:
      null,
    created_at_ms: OPENED_AT_MS - 100,
    updated_at_ms: OPENED_AT_MS - 100,
    version: 1,
  });
  insert(runtime.database, "contract_years", {
    id: uuid(7_005),
    league_id: runtime.ids.league,
    contract_id: contractId,
    season_id: runtime.ids.season,
    year_number: 3,
    aav_cents: 100,
    status: "current",
    rollover_at_ms: OPENED_AT_MS - 100,
    created_at_ms: OPENED_AT_MS - 100,
  });
  return {
    entryId,
    entryKind: "carryover",
    playerId,
    ownershipId,
    contractId,
    effectivePositionGroup: "F",
    slotKey: "F01",
    placementState: "placed",
    conflictCode: null,
    sourceRosterCategory: "Active",
    contractType: "normal",
    originalTotalValueCents: 300,
    originalTermYears: 3,
    aavCents: 100,
    remainingYears: 1,
  };
}

function publishEmptyCard(runtime) {
  const processedAtMs =
    CANDIDATE_DEADLINE_AT_MS + 10;
  runtime.database
    .prepare(`
      UPDATE candidate_cards
      SET status = 'locked_incomplete',
          locked_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
        AND version = 1
    `)
    .run(
      CANDIDATE_DEADLINE_AT_MS,
      processedAtMs,
      runtime.ids.league,
      runtime.ids.cardOne
    );
  insert(
    runtime.database,
    "candidate_card_revisions",
    {
      id: uuid(9_001),
      league_id: runtime.ids.league,
      season_id: runtime.ids.season,
      fad_id: runtime.ids.fad,
      card_id: runtime.ids.cardOne,
      team_id: runtime.ids.teamOne,
      resulting_card_version: 2,
      action: "deadline_locked",
      affected_entry_id: null,
      player_id: null,
      actor_user_id: null,
      actor_membership_id: null,
      actor_authority: "system",
      before_evidence_json:
        '{"status":"open"}',
      after_evidence_json:
        '{"status":"locked_incomplete"}',
      potential_illegality_acknowledged:
        0,
      warning_codes_json: "[]",
      occurred_at_ms: processedAtMs,
      created_at_ms: processedAtMs,
      version: 1,
    }
  );
  const snapshotId = uuid(9_002);
  insert(
    runtime.database,
    "candidate_card_snapshots",
    {
      id: snapshotId,
      league_id: runtime.ids.league,
      season_id: runtime.ids.season,
      fad_id: runtime.ids.fad,
      card_id: runtime.ids.cardOne,
      team_id: runtime.ids.teamOne,
      locked_card_version: 2,
      locked_status:
        "locked_incomplete",
      completeness_code: "incomplete",
      filled_mandatory_count: 0,
      missing_mandatory_count: 18,
      filled_bench_count: 0,
      empty_bench_count: 4,
      blocking_validation_count: 0,
      structural_conflict_count: 0,
      cap_limit_cents: 10_000,
      carried_active_player_amount_cents:
        0,
      retention_obligation_cents: 0,
      buyout_penalty_cents: 0,
      carried_cap_usage_cents: 0,
      proposed_candidate_aav_cents: 0,
      maximum_possible_cap_cents: 0,
      maximum_cap_space_cents: 10_000,
      effective_deadline_at_ms:
        CANDIDATE_DEADLINE_AT_MS,
      processed_at_ms: processedAtMs,
      created_at_ms: processedAtMs,
      cap_status: "compliant",
      allocation_eligibility: "eligible",
      allocation_exclusion_reason: null,
    }
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
    ([group, number], index) => {
      insert(
        runtime.database,
        "candidate_card_snapshot_entries",
        {
          id: uuid(9_100 + index),
          league_id:
            runtime.ids.league,
          season_id:
            runtime.ids.season,
          fad_id: runtime.ids.fad,
          snapshot_id: snapshotId,
          card_id:
            runtime.ids.cardOne,
          team_id:
            runtime.ids.teamOne,
          row_kind: "slot",
          occupant_kind: "empty",
          slot_group: group,
          slot_number: number,
          created_at_ms: processedAtMs,
          allocation_eligibility:
            null,
          allocation_exclusion_reason:
            null,
        }
      );
    }
  );
  runtime.database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_forward_update"
  );
  runtime.database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_deadline_completeness_update"
  );
  runtime.database.exec(
    "DROP TRIGGER IF EXISTS free_agent_drafts_deadline_allocation_barrier"
  );
  runtime.database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked',
          deadline_locked_at_ms = ?,
          updated_at_ms = ?,
          version = version + 1
      WHERE league_id = ?
        AND id = ?
    `)
    .run(
      CANDIDATE_DEADLINE_AT_MS,
      processedAtMs,
      runtime.ids.league,
      runtime.ids.fad
    );
  return snapshotId;
}

describe(
  "SQLite Candidate Card private read boundary",
  () => {
    test(
      "returns only an exact manager-scoped card, denies commissioner and competing-team reads before help, and performs byte-stable reads",
      (t) => {
        const runtime = createRuntime(t);
        const before = databaseBytes(
          runtime.database
        );
        const own =
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs: COMMAND_AT_MS,
          });
        assert.equal(
          own.visibilityMode,
          "private_editable"
        );
        assert.equal(
          own.accessReason,
          "team_manager"
        );
        assert.deepEqual(
          own.authorizationEvidence,
          {
            kind: "manager_assignment",
            id:
              runtime.ids
                .managerOneAssignment,
          }
        );
        assert.equal(own.entries.length, 0);

        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime, {
              teamId:
                runtime.ids.teamTwo,
              cardId:
                runtime.ids.cardTwo,
            }),
            actor: managerOne(runtime),
            nowMs: COMMAND_AT_MS,
          }),
          null
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: commissioner(runtime),
            nowMs: HELP_AT_MS,
          }),
          null
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: {
              ...managerOne(runtime),
              authority: "commissioner",
            },
            nowMs: HELP_AT_MS,
          }),
          null
        );
        assert.equal(
          runtime.repository.readPublished({
            scope: scope(runtime),
            viewer:
              memberViewer(runtime),
          }),
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );

    test(
      "resolves hidden scope and returns the exact 22-slot private DTO without a read side effect",
      (t) => {
        const runtime = createRuntime(t);
        const displacedPlayerId = uuid(4_001);
        seedSelectablePlayer(runtime, {
          playerId: displacedPlayerId,
        });
        const added = runtime.repository.mutate(
          addCommand(runtime, {
            playerId: displacedPlayerId,
            entryId: uuid(4_002),
            requestId: uuid(4_003),
            revisionId: uuid(4_004),
            clientKey: "private-dto-conflict",
          })
        );
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(4_005),
            ownershipId: uuid(4_006),
            contractId: uuid(4_007),
            entryId: uuid(4_008),
          });
        runtime.repository.synchronizeCarryovers({
          scope: scope(runtime),
          expectedCardVersion:
            added.card.cardVersion,
          nowMs: COMMAND_AT_MS + 1,
          revisionId: uuid(4_009),
          carryovers: [carryover],
          candidateConflicts: [
            {
              entryId: uuid(4_002),
              conflictCode:
                "CANDIDATE_SLOT_OCCUPIED_BY_CARRYOVER",
            },
          ],
          candidateReplacements: [],
        });
        const defencePlayerId = uuid(4_010);
        seedSelectablePlayer(runtime, {
          playerId: defencePlayerId,
          positionGroup: "D",
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            expectedCardVersion: 3,
            nowMs: COMMAND_AT_MS + 2,
            playerId: defencePlayerId,
            slotKey: "D01",
            entryId: uuid(4_011),
            requestId: uuid(4_012),
            revisionId: uuid(4_013),
            clientKey: "private-dto-defence",
          })
        );

        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const card = readPrivateCurrent(runtime);

        assert.deepEqual(
          Object.keys(card).sort(),
          [
            "accessReason",
            "allocationEligibility",
            "allocationExclusionReason",
            "authorizationEvidence",
            "capProjection",
            "capStatus",
            "capabilities",
            "cardId",
            "cardVersion",
            "commissionerInterventions",
            "completeness",
            "conflicts",
            "fadId",
            "helpContext",
            "leagueId",
            "lifecycleStatus",
            "phase",
            "seasonId",
            "slots",
            "teamId",
            "visibilityMode",
          ].sort()
        );
        assert.equal(card.phase, "cards_open");
        assert.equal(
          card.visibilityMode,
          "private_editable"
        );
        assert.equal(card.slots.length, 22);
        assert.deepEqual(
          card.slots.map(({ slotKey }) => slotKey),
          [
            ...Array.from(
              { length: 12 },
              (_, index) =>
                `F${String(index + 1).padStart(2, "0")}`
            ),
            ...Array.from(
              { length: 6 },
              (_, index) =>
                `D${String(index + 1).padStart(2, "0")}`
            ),
            ...Array.from(
              { length: 4 },
              (_, index) =>
                `B${String(index + 1).padStart(2, "0")}`
            ),
          ]
        );
        const carryoverSlot = card.slots[0];
        assert.equal(
          carryoverSlot.occupantKind,
          "carryover"
        );
        assert.deepEqual(carryoverSlot.player, {
          playerId: carryover.playerId,
          fullName:
            `Carried ${carryover.playerId.slice(-4)}`,
          positionGroup: "F",
        });
        assert.equal(carryoverSlot.locked, true);
        assert.deepEqual(
          carryoverSlot.lastEditedBy,
          {
            userId: null,
            displayName: null,
            authority: "system",
          }
        );
        const candidateSlot = card.slots.find(
          ({ slotKey }) => slotKey === "D01"
        );
        assert.equal(
          candidateSlot.occupantKind,
          "candidate"
        );
        assert.equal(
          candidateSlot.player.playerId,
          defencePlayerId
        );
        assert.deepEqual(
          candidateSlot.lastEditedBy,
          {
            userId:
              runtime.ids.managerOneUser,
            displayName: "Manager One 1000",
            authority: "manager",
          }
        );
        const emptySlot = card.slots.find(
          ({ slotKey }) => slotKey === "B01"
        );
        assert.equal(emptySlot.occupantKind, "empty");
        assert.deepEqual(emptySlot.validation, {
          status: "valid",
          codes: [],
        });
        assert.equal(
          emptySlot.capabilities.addCandidate.allowed,
          true
        );
        assert.deepEqual(card.conflicts, [
          {
            entryId: uuid(4_002),
            entryVersion: 2,
            player: {
              playerId: displacedPlayerId,
              fullName:
                `Eligible ${displacedPlayerId.slice(-4)}`,
              positionGroup: "F",
            },
            intendedSlotKey: "F01",
            conflictCode:
              "CANDIDATE_SLOT_OCCUPIED_BY_CARRYOVER",
            validation: {
              status: "invalid",
              codes: [
                "CANDIDATE_SLOT_OCCUPIED_BY_CARRYOVER",
              ],
            },
            lastEditedBy: {
              userId: null,
              displayName: null,
              authority: "system",
            },
          },
        ]);
        assert.equal(
          Object.hasOwn(card, "entries"),
          false
        );
        assert.equal(
          Object.hasOwn(
            candidateSlot,
            "ownershipId"
          ),
          false
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
      }
    );

    test(
      "derives manager-first and exact-help authority without cross-team or cross-league leakage",
      (t) => {
        const runtime = createRuntime(t);
        const secondLeague = seedOpenLeague(
          runtime.database,
          9_000
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              managerTwo(runtime)
            ),
          }),
          null
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: memberViewer(runtime),
          }),
          null
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            leagueId: secondLeague.league,
            fadId: secondLeague.fad,
            teamId: secondLeague.teamOne,
          }),
          null
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS,
          }),
          null
        );

        const help =
          runtime.repository.requestHelp({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs: HELP_AT_MS,
            idempotency: idempotency(
              uuid(4_020),
              "private-route-help"
            ),
            helpRequestId: uuid(4_021),
            message: "Private help evidence.",
          });
        const helped = readPrivateCurrent(runtime, {
          viewer: privateViewer(
            commissioner(runtime)
          ),
          nowMs: HELP_AT_MS + 1,
        });
        assert.equal(
          helped.accessReason,
          "help_grant_commissioner"
        );
        assert.deepEqual(helped.helpContext, {
          helpRequestId: help.helpRequestId,
          status: "active",
          message: "Private help evidence.",
          requestedByUserId:
            runtime.ids.managerOneUser,
          requestedByDisplayName:
            "Manager One 1000",
          requestedAtMs: HELP_AT_MS,
          expiresAtMs:
            CANDIDATE_DEADLINE_AT_MS,
        });
        assert.equal(
          readPrivateCurrent(runtime, {
            teamId: runtime.ids.teamTwo,
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS + 1,
          }),
          null
        );

        insert(runtime.database, "platform_roles", {
          id: uuid(4_023),
          user_id: runtime.ids.memberUser,
          role: "platform_administrator",
          status: "active",
          granted_by_user_id:
            runtime.ids.commissionerUser,
          granted_at_ms: HELP_AT_MS + 1,
          ended_at_ms: null,
          version: 1,
        });
        const helpedAdministrator =
          readPrivateCurrent(runtime, {
            viewer: memberViewer(runtime),
            nowMs: HELP_AT_MS + 1,
          });
        assert.equal(
          helpedAdministrator.accessReason,
          "help_grant_platform_administrator"
        );
        assert.deepEqual(
          helpedAdministrator
            .authorizationEvidence,
          {
            kind: "help_request",
            id: uuid(4_021),
          }
        );

        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            HELP_AT_MS + 2,
            runtime.ids.managerOneAssignment
          );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              managerOne(runtime)
            ),
            nowMs: HELP_AT_MS + 2,
          }),
          null
        );
        insert(
          runtime.database,
          "team_manager_assignments",
          {
            id: uuid(4_022),
            league_id: runtime.ids.league,
            team_id: runtime.ids.teamOne,
            user_id:
              runtime.ids.commissionerUser,
            membership_id:
              runtime.ids
                .commissionerMembership,
            assigned_by_user_id:
              runtime.ids.commissionerUser,
            status: "accepted",
            assigned_at_ms: HELP_AT_MS + 2,
            accepted_at_ms: HELP_AT_MS + 2,
            ended_at_ms: null,
            version: 1,
          }
        );
        const dualRole = readPrivateCurrent(
          runtime,
          {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS + 2,
          }
        );
        assert.equal(
          dualRole.accessReason,
          "team_manager"
        );
        assert.deepEqual(
          dualRole.authorizationEvidence,
          {
            kind: "manager_assignment",
            id: uuid(4_022),
          }
        );
      }
    );

    test(
      "rejects stale manager membership, user, and acceptance evidence across private read, mutation, and help paths without writes",
      (t) => {
        const cases = [
          {
            label:
              "active membership with an end timestamp",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE league_memberships
                  SET ended_at_ms = ?,
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS,
                  HELP_AT_MS,
                  runtime.ids
                    .managerOneMembership
                );
            },
          },
          {
            label:
              "active membership without a join timestamp",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE league_memberships
                  SET joined_at_ms = NULL,
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS,
                  runtime.ids
                    .managerOneMembership
                );
            },
          },
          {
            label: "inactive manager user",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE users
                  SET status = 'deactivated',
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS,
                  runtime.ids.managerOneUser
                );
            },
          },
          {
            label:
              "accepted assignment without acceptance evidence",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE team_manager_assignments
                  SET accepted_at_ms = NULL,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  runtime.ids
                    .managerOneAssignment
                );
            },
          },
          {
            label:
              "accepted assignment with an end timestamp",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE team_manager_assignments
                  SET ended_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS,
                  runtime.ids
                    .managerOneAssignment
                );
            },
          },
        ];

        for (const item of cases) {
          const runtime = createRuntime(t);
          item.breakAuthority(runtime);
          assertCurrentPrivatePathsHidden(
            runtime,
            {
              viewer: privateViewer(
                managerOne(runtime)
              ),
              label: item.label,
            }
          );
        }
      }
    );

    test(
      "rejects stale commissioner and platform-administrator evidence without exposing a helped card or writing",
      (t) => {
        const commissionerCases = [
          {
            label:
              "active commissioner membership with an end timestamp",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE league_memberships
                  SET ended_at_ms = ?,
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS + 2,
                  HELP_AT_MS + 2,
                  runtime.ids
                    .commissionerMembership
                );
            },
          },
          {
            label: "inactive commissioner user",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE users
                  SET status = 'deactivated',
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS + 2,
                  runtime.ids
                    .commissionerUser
                );
            },
          },
          {
            label:
              "commissioner pointer with a noncommissioner membership",
            breakAuthority(runtime) {
              runtime.database
                .prepare(`
                  UPDATE league_memberships
                  SET permission_category = 'member',
                      updated_at_ms = ?,
                      version = version + 1
                  WHERE id = ?
                `)
                .run(
                  HELP_AT_MS + 2,
                  runtime.ids
                    .commissionerMembership
                );
            },
          },
        ];

        for (const item of commissionerCases) {
          const runtime = createRuntime(t);
          runtime.repository.requestHelpCurrent(
            currentHelpCommand(runtime, {
              requestId: uuid(4_110),
              helpRequestId: uuid(4_111),
              clientKey:
                "stale-commissioner-help",
            })
          );
          runtime.database
            .prepare(`
              UPDATE platform_roles
              SET status = 'ended',
                  ended_at_ms = ?,
                  version = version + 1
              WHERE user_id = ?
            `)
            .run(
              HELP_AT_MS + 1,
              runtime.ids.commissionerUser
            );
          item.breakAuthority(runtime);
          assertCurrentPrivatePathsHidden(
            runtime,
            {
              viewer: privateViewer(
                commissioner(runtime)
              ),
              label: item.label,
              nowMs: HELP_AT_MS + 3,
            }
          );
        }

        const administrator = createRuntime(t);
        administrator.repository
          .requestHelpCurrent(
            currentHelpCommand(administrator, {
              requestId: uuid(4_120),
              helpRequestId: uuid(4_121),
              clientKey:
                "ended-administrator-help",
            })
          );
        insert(
          administrator.database,
          "platform_roles",
          {
            id: uuid(4_122),
            user_id:
              administrator.ids.memberUser,
            role: "platform_administrator",
            status: "active",
            granted_by_user_id:
              administrator.ids
                .commissionerUser,
            granted_at_ms: HELP_AT_MS + 1,
            ended_at_ms: HELP_AT_MS + 2,
            version: 1,
          }
        );
        assertCurrentPrivatePathsHidden(
          administrator,
          {
            viewer: memberViewer(
              administrator
            ),
            label:
              "active platform role with an end timestamp",
            nowMs: HELP_AT_MS + 3,
          }
        );
      }
    );

    test(
      "removes former commissioner help authority after pointer replacement while the current replacement can read and edit",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(4_134);
        const entryId = uuid(4_137);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        runtime.repository.mutateCurrent(
          currentAddCommand(runtime, {
            requestId: uuid(4_135),
            revisionId: uuid(4_136),
            entryId,
            playerId,
            clientKey:
              "replacement-commissioner-candidate",
          })
        );
        const help = runtime.repository
          .requestHelpCurrent(
            currentHelpCommand(runtime, {
              requestId: uuid(4_130),
              helpRequestId: uuid(4_131),
              clientKey:
                "commissioner-replacement-help",
            })
          );
        const replacementUserId = uuid(4_132);
        const replacementMembershipId =
          uuid(4_133);
        seedUser(
          runtime.database,
          replacementUserId,
          "Replacement Commissioner"
        );
        seedMembership(runtime.database, {
          id: replacementMembershipId,
          leagueId: runtime.ids.league,
          userId: replacementUserId,
          permissionCategory:
            "commissioner",
        });
        runtime.database
          .prepare(`
            UPDATE platform_roles
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE user_id = ?
          `)
          .run(
            HELP_AT_MS + 1,
            runtime.ids.commissionerUser
          );
        runtime.database
          .prepare(`
            UPDATE leagues
            SET commissioner_membership_id = ?,
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            replacementMembershipId,
            HELP_AT_MS + 2,
            runtime.ids.league
          );

        assertCurrentPrivatePathsHidden(
          runtime,
          {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            label: "former commissioner",
            nowMs: HELP_AT_MS + 3,
          }
        );

        const replacementViewer = {
          userId: replacementUserId,
          membershipId:
            replacementMembershipId,
        };
        const current = readPrivateCurrent(
          runtime,
          {
            viewer: replacementViewer,
            nowMs: HELP_AT_MS + 3,
          }
        );
        assert.equal(
          current.accessReason,
          "help_grant_commissioner"
        );
        assert.deepEqual(
          current.authorizationEvidence,
          {
            kind: "help_request",
            id: help.data.helpRequestId,
          }
        );

        const changed =
          runtime.repository.mutateCurrent({
            ...currentAddCommand(runtime, {
              viewer: replacementViewer,
              nowMs: HELP_AT_MS + 4,
              expectedCardVersion: 2,
              requestId: uuid(4_138),
              revisionId: uuid(4_139),
              clientKey:
                "replacement-commissioner-edit",
            }),
            action: {
              type: "edit",
              entryId,
              totalValueCents: 900,
              termYears: 3,
            },
          });
        assert.equal(
          changed.card.cardVersion,
          3
        );
        assert.equal(
          changed.card.accessReason,
          "help_grant_commissioner"
        );
        assert.deepEqual(
          changed.card.authorizationEvidence,
          {
            kind: "help_request",
            id: help.data.helpRequestId,
          }
        );
      }
    );

    test(
      "keeps manager reads private and read-only at deadline or freeze, expires help by clock, and phase-conflicts after publication",
      (t) => {
        const runtime = createRuntime(t);
        runtime.repository.requestHelp({
          scope: scope(runtime),
          actor: managerOne(runtime),
          nowMs: HELP_AT_MS,
          idempotency: idempotency(
            uuid(4_030),
            "deadline-private-help"
          ),
          helpRequestId: uuid(4_031),
          message: null,
        });
        const before = databaseBytes(
          runtime.database
        );
        const atDeadline = readPrivateCurrent(
          runtime,
          {
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
          }
        );
        assert.equal(
          atDeadline.phase,
          "deadline_processing"
        );
        assert.equal(
          atDeadline.visibilityMode,
          "private_read_only"
        );
        assert.equal(
          atDeadline.helpContext.status,
          "expired"
        );
        assert.deepEqual(
          atDeadline.capabilities.editCard,
          {
            allowed: false,
            reasonCode: "DEADLINE_PASSED",
          }
        );
        assert.equal(
          atDeadline.slots.every((slot) =>
            Object.values(slot.capabilities).every(
              (capability) =>
                capability.allowed === false &&
                capability.reasonCode ===
                  "DEADLINE_PASSED"
            )
          ),
          true
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
          }),
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
        runtime.database
          .prepare(`
            UPDATE candidate_card_help_requests
            SET status = 'expired',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS,
            uuid(4_031)
          );
        const beforeExpiredRead = databaseBytes(
          runtime.database
        );
        assert.equal(
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
          }),
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeExpiredRead
        );

        publishEmptyCard(runtime);
        assertRepositoryError(
          () =>
            readPrivateCurrent(runtime, {
              nowMs:
                CANDIDATE_DEADLINE_AT_MS +
                20,
            }),
          "FAD_PHASE_CONFLICT"
        );

        const frozen = createRuntime(t);
        frozen.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            COMMAND_AT_MS,
            frozen.ids.league
          );
        const frozenCard =
          readPrivateCurrent(frozen);
        assert.equal(
          frozenCard.visibilityMode,
          "private_read_only"
        );
        assert.deepEqual(
          frozenCard.capabilities.editCard,
          {
            allowed: false,
            reasonCode: "LEAGUE_FROZEN",
          }
        );
      }
    );

    test(
      "reveals only the immutable 22-slot snapshot to active league members after publication and never leaks private help content",
      (t) => {
        const runtime = createRuntime(t);
        const snapshotId =
          publishEmptyCard(runtime);
        const before = databaseBytes(
          runtime.database
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs:
              CANDIDATE_DEADLINE_AT_MS +
              10,
          }),
          null
        );
        const published =
          runtime.repository.readPublished({
            scope: scope(runtime),
            viewer:
              memberViewer(runtime),
          });
        assert.equal(
          published.snapshotId,
          snapshotId
        );
        assert.equal(
          published.visibilityMode,
          "published_history"
        );
        assert.equal(
          published.entries.length,
          22
        );
        assert.equal(
          published.entries.every(
            ({ occupantKind }) =>
              occupantKind === "empty"
          ),
          true
        );
        assert.equal(
          published.helpContext,
          null
        );
        assert.equal(
          published.authorizationEvidence,
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );

    test(
      "fails closed on a published snapshot that no longer contains the exact 22-slot shape without changing persisted bytes",
      (t) => {
        const runtime = createRuntime(t);
        publishEmptyCard(runtime);
        runtime.database.exec(
          "DROP TRIGGER candidate_card_snapshot_entries_immutable_delete"
        );
        runtime.database
          .prepare(`
            DELETE FROM candidate_card_snapshot_entries
            WHERE league_id = ?
              AND card_id = ?
              AND row_kind = 'slot'
              AND slot_group = 'B'
              AND slot_number = 4
          `)
          .run(
            runtime.ids.league,
            runtime.ids.cardOne
          );
        const before = databaseBytes(
          runtime.database
        );
        assertRepositoryError(
          () =>
            runtime.repository.readPublished({
              scope: scope(runtime),
              viewer:
                memberViewer(runtime),
            }),
          "CANDIDATE_CARD_SNAPSHOT_INCOMPLETE"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );
  }
);

describe(
  "SQLite Candidate eligible-player search",
  () => {
    test(
      "returns the exact catalogue-only projection, ignores prior-season statistics, and preserves search paging without writes",
      (t) => {
        const runtime = createRuntime(t);
        const alphaOne = uuid(4_100);
        const alphaTwo = uuid(4_101);
        const literal = uuid(4_102);
        const accented = uuid(4_103);
        const defence = uuid(4_104);
        seedSelectablePlayer(runtime, {
          playerId: alphaOne,
          fullName: "ALPHA   Player",
        });
        seedSelectablePlayer(runtime, {
          playerId: alphaTwo,
          fullName: "alpha player",
        });
        seedSelectablePlayer(runtime, {
          playerId: literal,
          fullName: "Beta %_\\ Player",
        });
        seedSelectablePlayer(runtime, {
          playerId: accented,
          fullName: "ÉLISE Åström",
        });
        seedSelectablePlayer(runtime, {
          playerId: defence,
          fullName: "Delta Defender",
          positionGroup: "D",
        });
        insert(runtime.database, "stat_sources", {
          id: uuid(4_190),
          provider: "prior-season-candidate-audit",
          status: "active",
          created_at_ms: 20,
          updated_at_ms: 20,
          version: 1,
        });
        insert(runtime.database, "stat_refreshes", {
          id: uuid(4_191),
          stat_source_id: uuid(4_190),
          nhl_season_key: "20252026",
          source_version: "prior-season-decoy",
          status: "succeeded",
          started_at_ms: 20,
          completed_at_ms: 21,
          player_count: 1,
          error_code: null,
          metadata_json: null,
          version: 1,
        });
        insert(runtime.database, "player_stat_totals", {
          id: uuid(4_192),
          stat_source_id: uuid(4_190),
          refresh_id: uuid(4_191),
          nhl_season_key: "20252026",
          player_id: alphaOne,
          games_played: 82,
          goals: 50,
          assists: 50,
          nhl_points: 100,
          fantasy_points_hundredths: 99_999,
          source_updated_at_ms: 21,
          created_at_ms: 21,
        });

        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const first = readEligiblePlayers(
          runtime,
          { limit: 1 }
        );
        assert.deepEqual(first.data, [
          {
            player: {
              playerId: alphaOne,
              fullName: "ALPHA   Player",
              positionGroup: "F",
            },
            effectivePositionGroup: "F",
            activeState: "active",
            benchEligible: true,
            eligibilityCode: "eligible",
            contractLimits: {
              allowedTermsYears: [1, 2, 3],
              minimumTotalValueCentsByTerm: {
                1: 100,
                2: 200,
                3: 300,
              },
              maximumBenchAavCents: null,
            },
          },
        ]);
        assert.equal(first.page.hasMore, true);
        assert.equal(
          typeof first.page.nextCursor,
          "string"
        );
        const second = readEligiblePlayers(
          runtime,
          {
            cursor: first.page.nextCursor,
            limit: 1,
          }
        );
        assert.equal(
          second.data[0].player.playerId,
          alphaTwo
        );
        assert.deepEqual(
          readEligiblePlayers(runtime, {
            q: "  ÉLISE  ",
          }).data.map(
            ({ player }) => player.playerId
          ),
          [accented]
        );
        assert.deepEqual(
          readEligiblePlayers(runtime, {
            q: "%_\\",
          }).data.map(
            ({ player }) => player.playerId
          ),
          [literal]
        );
        const bench = readEligiblePlayers(
          runtime,
          {
            slotKey: "B01",
            q: "defender",
          }
        );
        assert.equal(
          bench.data[0].player.playerId,
          defence
        );
        assert.equal(
          bench.data[0].contractLimits
            .maximumBenchAavCents,
          400
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
      }
    );

    test(
      "omits every same-league ineligible signal while preserving other-card nomination privacy",
      (t) => {
        const runtime = createRuntime(t);
        const eligible = uuid(4_200);
        const defence = uuid(4_201);
        const inactive = uuid(4_202);
        const owned = uuid(4_203);
        const contracted = uuid(4_204);
        const released = uuid(4_205);
        const allocated = uuid(4_206);
        const sameCard = uuid(4_207);
        const otherCard = uuid(4_208);
        const recovering = uuid(4_209);
        const terminalRecovery = uuid(4_210);
        const crossLeague = uuid(4_211);
        const ambiguous = uuid(4_212);
        const agreeingSources = uuid(4_213);
        const fadAuction = uuid(4_214);
        const ordinaryAuction = uuid(4_215);
        for (const playerId of [
          eligible,
          inactive,
          owned,
          contracted,
          released,
          allocated,
          sameCard,
          otherCard,
          recovering,
          terminalRecovery,
          crossLeague,
          fadAuction,
          ordinaryAuction,
        ]) {
          seedSelectablePlayer(runtime, {
            playerId,
          });
        }
        seedSelectablePlayer(runtime, {
          playerId: defence,
          positionGroup: "D",
        });
        seedSourcePositionPlayer(runtime, {
          playerId: ambiguous,
          fullName: "Ambiguous Player",
          positions: ["F", "D"],
        });
        seedSourcePositionPlayer(runtime, {
          playerId: agreeingSources,
          fullName: "Agreeing Sources",
          positions: ["F", "F"],
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId: sameCard,
            slotKey: "F12",
            requestId: uuid(4_224),
            revisionId: uuid(4_225),
            clientKey: "same-card-search",
          })
        );
        runtime.repository.mutate({
          ...addCommand(runtime, {
            entryId: uuid(4_228),
            playerId: otherCard,
            requestId: uuid(4_226),
            revisionId: uuid(4_227),
            clientKey: "other-card-search",
          }),
          scope: scope(runtime, {
            teamId: runtime.ids.teamTwo,
            cardId: runtime.ids.cardTwo,
          }),
          actor: managerTwo(runtime),
        });
        runtime.database
          .prepare(`
            UPDATE players
            SET status = 'historical',
                version = version + 1
            WHERE id = ?
          `)
          .run(inactive);
        insert(
          runtime.database,
          "player_ownerships",
          {
            id: uuid(4_220),
            league_id: runtime.ids.league,
            season_id: runtime.ids.season,
            player_id: owned,
            team_id: runtime.ids.teamTwo,
            ownership_kind: "Rostered",
            roster_category: "Active",
            position_group: "F",
            slot_number: 1,
            acquired_transaction_type:
              "foundation_fixture",
            acquired_transaction_id: null,
            created_at_ms: 10,
            updated_at_ms: 10,
            version: 1,
          }
        );
        seedActiveContract(runtime, {
          playerId: contracted,
          contractId: uuid(4_221),
        });
        seedReleasedProspectHistory(
          runtime.database,
          runtime.ids,
          {
            playerId: released,
            eventId: uuid(4_222),
          }
        );
        runtime.database.exec(
          "DROP TRIGGER free_agent_draft_allocations_pending_insert"
        );
        seedPendingFadAllocation(
          runtime.database,
          runtime.ids,
          {
            allocationId: uuid(4_223),
            playerId: allocated,
          }
        );
        dropTableTriggers(
          runtime.database,
          "free_agent_draft_recoveries"
        );
        seedFadRecovery(
          runtime.database,
          runtime.ids,
          {
            recoveryId: uuid(4_229),
            playerId: recovering,
          }
        );
        seedFadRecovery(
          runtime.database,
          runtime.ids,
          {
            recoveryId: uuid(4_230),
            playerId: terminalRecovery,
            status: "resolved",
          }
        );
        for (const tableName of [
          "free_agent_draft_rollovers",
          "auctions",
          "auction_contexts",
        ]) {
          dropTableTriggers(
            runtime.database,
            tableName
          );
        }
        const rolloverId = uuid(4_233);
        seedInitialFadRollover(
          runtime,
          rolloverId
        );
        seedOpenAuction(runtime, {
          auctionId: uuid(4_234),
          playerId: fadAuction,
          sourceKind: "fad_open_rapid",
          rolloverId,
        });
        seedOpenAuction(runtime, {
          auctionId: uuid(4_235),
          playerId: ordinaryAuction,
          sourceKind: "ordinary_weekly",
        });
        const otherLeagueIds = seedOpenLeague(
          runtime.database,
          30_000
        );
        seedReleasedProspectHistory(
          runtime.database,
          otherLeagueIds,
          {
            playerId: crossLeague,
            eventId: uuid(4_231),
          }
        );
        seedPendingFadAllocation(
          runtime.database,
          otherLeagueIds,
          {
            allocationId: uuid(4_232),
            playerId: crossLeague,
          }
        );
        const result = readEligiblePlayers(
          runtime,
          { slotKey: "F01" }
        );
        assert.deepEqual(
          new Set(
            result.data.map(
              ({ player }) => player.playerId
            )
          ),
          new Set([
            eligible,
            otherCard,
            terminalRecovery,
            crossLeague,
            agreeingSources,
            ordinaryAuction,
          ])
        );
        assert.equal(
          result.data.some(
            ({ player }) =>
              player.playerId === defence
          ),
          false
        );
        for (const item of result.data) {
          assert.deepEqual(
            Object.keys(item).sort(),
            [
              "activeState",
              "benchEligible",
              "contractLimits",
              "effectivePositionGroup",
              "eligibilityCode",
              "player",
            ].sort()
          );
        }
      }
    );

    test(
      "requires exact private edit authority, stays readable during freeze, and closes at occupancy, deadline, or publication",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(4_300);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        assert.equal(
          readEligiblePlayers(runtime, {
            viewer: privateViewer(
              managerTwo(runtime)
            ),
          }),
          null
        );
        assert.equal(
          readEligiblePlayers(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS,
          }),
          null
        );
        runtime.repository.requestHelp({
          scope: scope(runtime),
          actor: managerOne(runtime),
          nowMs: HELP_AT_MS,
          idempotency: idempotency(
            uuid(4_301),
            "eligible-help"
          ),
          helpRequestId: uuid(4_302),
          message: null,
        });
        assert.equal(
          readEligiblePlayers(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS + 1,
          }).data.length,
          1
        );
        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                version = version + 1
            WHERE id = ?
          `)
          .run(runtime.ids.league);
        const beforeFrozenRead = databaseBytes(
          runtime.database
        );
        assert.equal(
          readEligiblePlayers(runtime).data.length,
          1
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeFrozenRead
        );
        assertRepositoryError(
          () =>
            readEligiblePlayers(runtime, {
              nowMs:
                CANDIDATE_DEADLINE_AT_MS,
            }),
          "FAD_DEADLINE_PASSED"
        );

        const occupied = createRuntime(t);
        const occupiedPlayer = uuid(4_310);
        const replacement = uuid(4_311);
        seedSelectablePlayer(occupied, {
          playerId: occupiedPlayer,
        });
        seedSelectablePlayer(occupied, {
          playerId: replacement,
        });
        occupied.repository.mutate(
          addCommand(occupied, {
            playerId: occupiedPlayer,
            requestId: uuid(4_312),
            revisionId: uuid(4_313),
            clientKey: "occupied-search",
          })
        );
        assertRepositoryError(
          () => readEligiblePlayers(occupied),
          "CANDIDATE_SLOT_OCCUPIED"
        );

        const published = createRuntime(t);
        seedSelectablePlayer(published, {
          playerId: uuid(4_320),
        });
        publishEmptyCard(published);
        assertRepositoryError(
          () =>
            readEligiblePlayers(published, {
              nowMs:
                CANDIDATE_DEADLINE_AT_MS +
                20,
            }),
          "FAD_PHASE_CONFLICT"
        );
      }
    );

    test(
      "excludes both carryover and unplaced conflict entries already present on the exact card",
      (t) => {
        const runtime = createRuntime(t);
        const conflictedPlayer = uuid(4_330);
        const availablePlayer = uuid(4_331);
        seedSelectablePlayer(runtime, {
          playerId: conflictedPlayer,
        });
        seedSelectablePlayer(runtime, {
          playerId: availablePlayer,
        });
        const added = runtime.repository.mutate(
          addCommand(runtime, {
            entryId: uuid(4_332),
            playerId: conflictedPlayer,
            requestId: uuid(4_333),
            revisionId: uuid(4_334),
            clientKey:
              "eligible-conflict-source",
          })
        );
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(4_335),
            ownershipId: uuid(4_336),
            contractId: uuid(4_337),
            entryId: uuid(4_338),
          });
        runtime.repository.synchronizeCarryovers({
          scope: scope(runtime),
          expectedCardVersion:
            added.card.cardVersion,
          nowMs: COMMAND_AT_MS + 1,
          revisionId: uuid(4_339),
          carryovers: [carryover],
          candidateConflicts: [
            {
              entryId: uuid(4_332),
              conflictCode:
                "CANDIDATE_SLOT_OCCUPIED_BY_CARRYOVER",
            },
          ],
          candidateReplacements: [],
        });
        const before = databaseBytes(
          runtime.database
        );
        const result = readEligiblePlayers(
          runtime,
          { slotKey: "F02" }
        );
        assert.deepEqual(
          result.data.map(
            ({ player }) => player.playerId
          ),
          [availablePlayer]
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );

    test(
      "admits a released right after its later confirmed re-entry approval and blocks a newer unapproved release in search and save",
      (t) => {
        const allowed = createRuntime(t);
        const allowedPlayer = uuid(4_350);
        const allowedRelease = uuid(4_351);
        seedSelectablePlayer(allowed, {
          playerId: allowedPlayer,
        });
        seedReleasedProspectHistory(
          allowed.database,
          allowed.ids,
          {
            playerId: allowedPlayer,
            eventId: allowedRelease,
            occurredAtMs: COMMAND_AT_MS - 10,
          }
        );
        seedApprovedRightsReleaseReentry(
          allowed,
          {
            playerId: allowedPlayer,
            releaseEventId: allowedRelease,
            draftId: uuid(4_352),
            snapshotId: uuid(4_353),
            eligiblePlayerId: uuid(4_354),
            confirmedAtMs:
              COMMAND_AT_MS - 5,
          }
        );
        assert.deepEqual(
          readEligiblePlayers(allowed).data.map(
            ({ player }) => player.playerId
          ),
          [allowedPlayer]
        );
        assert.equal(
          allowed.repository.mutate(
            addCommand(allowed, {
              playerId: allowedPlayer,
              requestId: uuid(4_355),
              revisionId: uuid(4_356),
              clientKey:
                "approved-rights-reentry",
            })
          ).card.entries[0].playerId,
          allowedPlayer
        );

        const blocked = createRuntime(t);
        const blockedPlayer = uuid(4_360);
        const approvedRelease = uuid(4_361);
        seedSelectablePlayer(blocked, {
          playerId: blockedPlayer,
        });
        seedReleasedProspectHistory(
          blocked.database,
          blocked.ids,
          {
            playerId: blockedPlayer,
            eventId: approvedRelease,
            occurredAtMs: COMMAND_AT_MS - 10,
          }
        );
        seedApprovedRightsReleaseReentry(
          blocked,
          {
            playerId: blockedPlayer,
            releaseEventId: approvedRelease,
            draftId: uuid(4_362),
            snapshotId: uuid(4_363),
            eligiblePlayerId: uuid(4_364),
            confirmedAtMs:
              COMMAND_AT_MS - 5,
          }
        );
        seedReleasedProspectHistory(
          blocked.database,
          blocked.ids,
          {
            playerId: blockedPlayer,
            eventId: uuid(4_365),
            occurredAtMs: COMMAND_AT_MS - 1,
          }
        );
        assert.deepEqual(
          readEligiblePlayers(blocked).data,
          []
        );
        assertRepositoryError(
          () =>
            blocked.repository.mutate(
              addCommand(blocked, {
                playerId: blockedPlayer,
                requestId: uuid(4_366),
                revisionId: uuid(4_367),
                clientKey:
                  "newer-unapproved-release",
              })
            ),
          "CANDIDATE_PLAYER_INELIGIBLE"
        );
      }
    );
  }
);

describe(
  "SQLite Candidate Card revision preview",
  () => {
    test(
      "projects an exact add with a deterministic private identity and no write or side effect",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(4_500);
        seedSelectablePlayer(runtime, {
          playerId,
          fullName: "Preview Player",
        });
        const action = {
          type: "add",
          slotKey: "F01",
          playerId,
          totalValueCents: 600,
          termYears: 2,
        };
        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const result = previewRevision(
          runtime,
          { action }
        );
        assert.deepEqual(
          Object.keys(result).sort(),
          [
            "action",
            "baseCardVersion",
            "projectedCard",
            "projectedSlot",
            "warnings",
          ].sort()
        );
        assert.equal(result.baseCardVersion, 1);
        assert.deepEqual(result.action, action);
        assert.equal(
          result.projectedCard.cardVersion,
          2
        );
        assert.equal(
          result.projectedSlot,
          result.projectedCard.slots[0]
        );
        assert.equal(
          result.projectedSlot.occupantKind,
          "candidate"
        );
        assert.match(
          result.projectedSlot.entryId,
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
        );
        assert.notEqual(
          result.projectedSlot.entryId,
          playerId
        );
        assert.equal(
          result.projectedSlot.entryVersion,
          1
        );
        assert.deepEqual(
          result.projectedSlot.player,
          {
            playerId,
            fullName: "Preview Player",
            positionGroup: "F",
          }
        );
        assert.equal(
          result.projectedSlot.aavCents,
          300
        );
        assert.deepEqual(
          result.projectedSlot.lastEditedBy,
          {
            userId:
              runtime.ids.managerOneUser,
            displayName:
              "Manager One 1000",
            authority: "manager",
          }
        );
        assert.deepEqual(result.warnings, []);
        assertPreviewOnlyCapabilities(
          result.projectedCard
        );
        assert.deepEqual(
          previewRevision(runtime, { action }),
          result
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
        assert.equal(
          count(
            runtime.database,
            "candidate_card_revisions",
            "WHERE card_id = ?",
            runtime.ids.cardOne
          ),
          1
        );
        assert.equal(
          count(
            runtime.database,
            "idempotency_requests"
          ),
          0
        );
        assert.equal(
          runtime.mutationSideEffects.length,
          0
        );
        assert.equal(
          runtime.helpSideEffects.length,
          0
        );
      }
    );

    test(
      "projects edit, destination move, and remove from one unchanged base card",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(4_510);
        const entryId = uuid(4_511);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId,
            entryId,
            requestId: uuid(4_512),
            revisionId: uuid(4_513),
            clientKey: "preview-action-base",
          })
        );
        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const edit = previewRevision(runtime, {
          action: {
            type: "edit",
            entryId,
            totalValueCents: 1_200,
            termYears: 3,
          },
          nowMs: COMMAND_AT_MS + 1,
        });
        assert.equal(edit.baseCardVersion, 2);
        assert.equal(
          edit.projectedCard.cardVersion,
          3
        );
        assert.equal(
          edit.projectedSlot.slotKey,
          "F01"
        );
        assert.equal(
          edit.projectedSlot.entryVersion,
          2
        );
        assert.equal(
          edit.projectedSlot.totalValueCents,
          1_200
        );

        const move = previewRevision(runtime, {
          action: {
            type: "move",
            entryId,
            slotKey: "B01",
          },
          nowMs: COMMAND_AT_MS + 1,
        });
        assert.equal(
          move.projectedSlot.slotKey,
          "B01"
        );
        assert.equal(
          move.projectedSlot.entryId,
          entryId
        );
        assert.equal(
          move.projectedCard.slots[0]
            .occupantKind,
          "empty"
        );
        assert.deepEqual(move.action, {
          type: "move",
          entryId,
          slotKey: "B01",
        });

        const remove = previewRevision(runtime, {
          action: {
            type: "remove",
            entryId,
          },
          nowMs: COMMAND_AT_MS + 1,
        });
        assert.equal(remove.projectedSlot, null);
        assert.equal(
          remove.projectedCard.slots.every(
            ({ entryId: projectedEntryId }) =>
              projectedEntryId !== entryId
          ),
          true
        );
        for (const preview of [edit, move, remove]) {
          assertPreviewOnlyCapabilities(
            preview.projectedCard
          );
        }
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
      }
    );

    test(
      "projects retained-AAV carryover movement in both cap directions without changing ownership",
      (t) => {
        const runtime = createRuntime(t);
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(4_520),
            ownershipId: uuid(4_521),
            contractId: uuid(4_522),
            entryId: uuid(4_523),
          });
        insert(
          runtime.database,
          "retention_obligations",
          {
            id: uuid(4_524),
            league_id: runtime.ids.league,
            contract_id:
              carryover.contractId,
            player_id: carryover.playerId,
            originating_team_id:
              runtime.ids.teamTwo,
            responsible_team_id:
              runtime.ids.teamTwo,
            retained_aav_cents: 25,
            creation_trade_id: null,
            status: "active",
            created_at_ms: 10,
            updated_at_ms: 10,
            version: 1,
          }
        );
        insert(runtime.database, "retention_years", {
          id: uuid(4_525),
          league_id: runtime.ids.league,
          retention_obligation_id: uuid(4_524),
          season_id: runtime.ids.season,
          retained_aav_cents: 25,
          status: "current",
          created_at_ms: 10,
        });
        const synchronized =
          runtime.repository
            .synchronizeCarryovers({
              scope: scope(runtime),
              expectedCardVersion: 1,
              nowMs: COMMAND_AT_MS,
              revisionId: uuid(4_526),
              carryovers: [carryover],
              candidateConflicts: [],
              candidateReplacements: [],
            });
        assert.equal(
          synchronized.card.capProjection
            .carriedActivePlayerAmountCents,
          75
        );
        let beforeBytes = databaseBytes(
          runtime.database
        );
        let beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const toBench = previewRevision(runtime, {
          action: {
            type: "move",
            entryId: carryover.entryId,
            slotKey: "B01",
          },
          nowMs: COMMAND_AT_MS + 1,
        });
        assert.equal(
          toBench.projectedCard.capProjection
            .carriedActivePlayerAmountCents,
          0
        );
        assert.equal(
          toBench.projectedSlot
            .authoritativeRosterCategory,
          "Bench"
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT roster_category, version
              FROM player_ownerships
              WHERE id = ?
            `)
            .get(carryover.ownershipId),
          {
            roster_category: "Active",
            version: 1,
          }
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );

        runtime.repository.mutate({
          scope: scope(runtime),
          actor: managerOne(runtime),
          expectedCardVersion: 2,
          nowMs: COMMAND_AT_MS + 1,
          idempotency: idempotency(
            uuid(4_527),
            "preview-carryover-bench"
          ),
          revisionId: uuid(4_528),
          action: {
            type: "move",
            entryId: carryover.entryId,
            slotKey: "B01",
          },
        });
        beforeBytes = databaseBytes(
          runtime.database
        );
        beforeChanges = runtime.database
          .prepare(
            "SELECT total_changes() AS value"
          )
          .get().value;
        const toActive = previewRevision(runtime, {
          action: {
            type: "move",
            entryId: carryover.entryId,
            slotKey: "F02",
          },
          nowMs: COMMAND_AT_MS + 2,
        });
        assert.equal(
          toActive.baseCardVersion,
          3
        );
        assert.equal(
          toActive.projectedCard.capProjection
            .carriedActivePlayerAmountCents,
          75
        );
        assert.equal(
          toActive.projectedSlot
            .authoritativeRosterCategory,
          "Active"
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT roster_category, version
              FROM player_ownerships
              WHERE id = ?
            `)
            .get(carryover.ownershipId),
          {
            roster_category: "Bench",
            version: 2,
          }
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
      }
    );

    test(
      "keeps authority private, allows freeze reads, and orders phase and deadline before entry errors",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(4_530);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const action = {
          type: "add",
          slotKey: "F01",
          playerId,
          totalValueCents: 300,
          termYears: 1,
        };
        let before = databaseBytes(
          runtime.database
        );
        assert.equal(
          previewRevision(runtime, {
            action,
            viewer: privateViewer(
              managerTwo(runtime)
            ),
          }),
          null
        );
        assert.equal(
          previewRevision(runtime, {
            action,
            viewer: privateViewer(
              commissioner(runtime)
            ),
          }),
          null
        );
        assertRepositoryError(
          () =>
            previewRevision(runtime, {
              action: {
                type: "remove",
                entryId: uuid(4_531),
              },
            }),
          "CANDIDATE_CARD_ENTRY_NOT_FOUND"
        );
        assertRepositoryError(
          () =>
            previewRevision(runtime, {
              action: {
                type: "remove",
                entryId: uuid(4_531),
              },
              nowMs:
                CANDIDATE_DEADLINE_AT_MS,
            }),
          "FAD_DEADLINE_PASSED"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );

        runtime.repository.requestHelp({
          scope: scope(runtime),
          actor: managerOne(runtime),
          nowMs: HELP_AT_MS,
          idempotency: idempotency(
            uuid(4_532),
            "preview-help"
          ),
          helpRequestId: uuid(4_533),
          message: null,
        });
        const helped = previewRevision(runtime, {
          action,
          viewer: privateViewer(
            commissioner(runtime)
          ),
          nowMs: HELP_AT_MS + 1,
        });
        assert.equal(
          helped.projectedCard.accessReason,
          "help_grant_commissioner"
        );

        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                version = version + 1
            WHERE id = ?
          `)
          .run(runtime.ids.league);
        before = databaseBytes(runtime.database);
        const frozen = previewRevision(
          runtime,
          { action }
        );
        assertPreviewOnlyCapabilities(
          frozen.projectedCard
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );

        const published = createRuntime(t);
        publishEmptyCard(published);
        const remove = {
          type: "remove",
          entryId: uuid(4_534),
        };
        assertRepositoryError(
          () =>
            previewRevision(published, {
              action: remove,
              nowMs:
                CANDIDATE_DEADLINE_AT_MS +
                20,
            }),
          "FAD_PHASE_CONFLICT"
        );
        assert.equal(
          previewRevision(published, {
            action: remove,
            viewer: privateViewer(
              managerTwo(published)
            ),
            nowMs:
              CANDIDATE_DEADLINE_AT_MS +
              20,
          }),
          null
        );
      }
    );

    test(
      "returns the closed canonically ordered structural and over-cap diagnostics without blocking preview",
      (t) => {
        const runtime = createRuntime(t);
        runtime.database
          .prepare(`
            UPDATE league_settings
            SET salary_cap_cents = 50,
                version = version + 1
            WHERE league_id = ?
          `)
          .run(runtime.ids.league);
        const carryover = {
          ...seedContractedCarryover(runtime, {
            playerId: uuid(4_540),
            ownershipId: uuid(4_541),
            contractId: uuid(4_542),
            entryId: uuid(4_543),
          }),
          placementState: "conflict",
          conflictCode:
            "CARRYOVER_SLOT_UNAVAILABLE",
        };
        runtime.repository.synchronizeCarryovers({
          scope: scope(runtime),
          expectedCardVersion: 1,
          nowMs: COMMAND_AT_MS,
          revisionId: uuid(4_544),
          carryovers: [carryover],
          candidateConflicts: [],
          candidateReplacements: [],
        });
        const playerId = uuid(4_545);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const before = databaseBytes(
          runtime.database
        );
        const result = previewRevision(runtime, {
          action: {
            type: "add",
            slotKey: "F02",
            playerId,
            totalValueCents: 100,
            termYears: 1,
          },
          nowMs: COMMAND_AT_MS + 1,
        });
        assert.equal(
          result.projectedCard
            .allocationEligibility,
          "excluded_structural_conflict"
        );
        assert.equal(
          result.projectedCard.capStatus,
          "over_cap"
        );
        assert.deepEqual(result.warnings, [
          {
            code: "CANDIDATE_CARD_OVER_CAP",
            message:
              "The projected Candidate Card exceeds the salary cap.",
            resourceId: runtime.ids.cardOne,
          },
          {
            code:
              "CANDIDATE_CARD_STRUCTURAL_CONFLICT",
            message:
              "The projected Candidate Card has an unresolved carried-roster structural conflict.",
            resourceId: runtime.ids.cardOne,
          },
        ]);
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );
  }
);

describe(
  "SQLite Candidate Card manager mutations",
  () => {
    test(
      "commits add and edit as one-version revisions and replays the original immutable result after later state changes without writes",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_002);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const add = addCommand(runtime, {
          playerId,
        });
        const first =
          runtime.repository.mutate(add);
        assert.equal(
          first.card.cardVersion,
          2
        );
        assert.equal(
          first.changedEntryId,
          add.action.entryId
        );
        assert.equal(
          first.card.entries[0].aavCents,
          300
        );
        assert.equal(
          count(
            runtime.database,
            "candidate_card_entries",
            "WHERE card_id = ?",
            runtime.ids.cardOne
          ),
          1
        );
        assert.equal(
          count(
            runtime.database,
            "candidate_card_revisions",
            "WHERE card_id = ?",
            runtime.ids.cardOne
          ),
          2
        );

        const edit =
          runtime.repository.mutate({
            scope: scope(runtime),
            actor: managerOne(runtime),
            expectedCardVersion: 2,
            nowMs: COMMAND_AT_MS + 1,
            idempotency: idempotency(
              uuid(5_010),
              "candidate-edit"
            ),
            revisionId: uuid(5_011),
            action: {
              type: "edit",
              entryId:
                add.action.entryId,
              totalValueCents: 900,
              termYears: 3,
            },
          });
        assert.equal(
          edit.card.cardVersion,
          3
        );
        assert.equal(
          edit.card.entries[0]
            .totalValueCents,
          900
        );

        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS,
            runtime.ids.league
          );
        const beforeReplay =
          databaseBytes(runtime.database);
        const replay =
          runtime.repository.mutate({
            ...add,
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
            idempotency: idempotency(
              uuid(5_012),
              "candidate-add"
            ),
            revisionId: uuid(5_013),
            action: {
              ...add.action,
              entryId: uuid(5_014),
            },
          });
        assert.deepEqual(replay, first);
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
        assert.equal(
          runtime.mutationSideEffects.length,
          2
        );

        const beforeReuse =
          databaseBytes(runtime.database);
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              addCommand(runtime, {
                playerId,
                totalValueCents: 700,
                clientKey:
                  "candidate-add",
                requestId: uuid(5_020),
                revisionId: uuid(5_021),
              })
            ),
          "IDEMPOTENCY_KEY_REUSED"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReuse
        );
      }
    );

    test(
      "re-establishes current exact-card authority before returning an immutable replay",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_030);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const command = addCommand(runtime, {
          playerId,
          entryId: uuid(5_031),
          requestId: uuid(5_032),
          revisionId: uuid(5_033),
          clientKey:
            "authority-before-replay",
        });
        runtime.repository.mutate(command);
        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            COMMAND_AT_MS + 1,
            runtime.ids
              .managerOneAssignment
          );
        const beforeReplay =
          databaseBytes(runtime.database);

        assertRepositoryError(
          () =>
            runtime.repository.mutate({
              ...command,
              nowMs: COMMAND_AT_MS + 2,
            }),
          "CANDIDATE_CARD_NOT_FOUND"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
      }
    );

    test(
      "blocks fresh manager writes during a league freeze while an active help-grant commissioner may edit",
      (t) => {
        const runtime = createRuntime(t);
        runtime.repository.requestHelp({
          scope: scope(runtime),
          actor: managerOne(runtime),
          nowMs: HELP_AT_MS,
          idempotency: idempotency(
            uuid(5_040),
            "freeze-help"
          ),
          helpRequestId: uuid(5_041),
          message: null,
        });
        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            HELP_AT_MS + 1,
            runtime.ids.league
          );
        const playerId = uuid(5_042);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const managerCommand =
          addCommand(runtime, {
            playerId,
            nowMs: HELP_AT_MS + 2,
            requestId: uuid(5_043),
            revisionId: uuid(5_044),
            clientKey:
              "frozen-manager-add",
          });
        const beforeManagerWrite =
          databaseBytes(runtime.database);
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              managerCommand
            ),
          "LEAGUE_FROZEN"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeManagerWrite
        );

        const commissionerView =
          readPrivateCurrent(runtime, {
            viewer: privateViewer(
              commissioner(runtime)
            ),
            nowMs: HELP_AT_MS + 2,
          });
        assert.deepEqual(
          commissionerView.capabilities
            .editCard,
          {
            allowed: true,
            reasonCode: null,
          }
        );
        const commissionerResult =
          runtime.repository.mutateCurrent(
            currentAddCommand(runtime, {
              playerId,
              actor: commissioner(runtime),
              viewer: privateViewer(
                commissioner(runtime)
              ),
              nowMs: HELP_AT_MS + 3,
              requestId: uuid(5_045),
              revisionId: uuid(5_046),
              clientKey:
                "frozen-commissioner-add",
            })
          );
        assert.equal(
          commissionerResult.card
            .cardVersion,
          2
        );
        assert.equal(
          commissionerResult.card
            .accessReason,
          "help_grant_commissioner"
        );
        assert.deepEqual(
          commissionerResult.card
            .commissionerInterventions,
          [
            {
              revisionId: uuid(5_046),
              entryId: uuid(5_001),
              action: "candidate_added",
              actorUserId:
                runtime.ids
                  .commissionerUser,
              actorDisplayName:
                "Commissioner 1000",
              authority: "commissioner",
              occurredAtMs:
                HELP_AT_MS + 3,
            },
          ]
        );
      }
    );

    test(
      "resolves route scope and manager-first authority inside the mutation transaction without accepting hidden authority fields",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_050);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const command = currentAddCommand(
          runtime,
          {
            playerId,
            entryId: uuid(5_051),
            requestId: uuid(5_052),
            revisionId: uuid(5_053),
            clientKey:
              "route-safe-add",
          }
        );
        const added =
          runtime.repository.mutateCurrent(
            command
          );
        assert.equal(
          added.card.cardVersion,
          2
        );
        assert.equal(
          added.changedEntryId,
          uuid(5_051)
        );
        assert.equal(
          Object.hasOwn(
            added.card,
            "entries"
          ),
          false
        );
        assert.equal(
          added.card.slots.length,
          22
        );
        const filledSlot =
          added.card.slots.find(
            ({ slotKey }) =>
              slotKey === "F01"
          );
        assert.equal(
          filledSlot.entryId,
          uuid(5_051)
        );
        assert.equal(
          filledSlot.player.playerId,
          playerId
        );

        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS,
            runtime.ids.league
          );
        const beforeReplay =
          databaseBytes(runtime.database);
        const replay =
          runtime.repository.mutateCurrent({
            ...command,
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
            idempotency: idempotency(
              uuid(5_059),
              "route-safe-add"
            ),
            revisionId: uuid(5_060),
            action: {
              ...command.action,
              entryId: uuid(5_061),
            },
          });
        assert.deepEqual(replay, added);
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'active',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS + 1,
            runtime.ids.league
          );

        const beforeIsolationChecks =
          databaseBytes(runtime.database);
        assert.equal(
          runtime.repository.mutateCurrent({
            ...command,
            teamId: runtime.ids.teamTwo,
            idempotency: idempotency(
              uuid(5_054),
              "wrong-team-add"
            ),
            revisionId: uuid(5_055),
          }),
          null
        );
        assertRepositoryError(
          () =>
            runtime.repository.mutateCurrent({
              ...command,
              scope: scope(runtime),
            }),
          "INPUT_FIELDS_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeIsolationChecks
        );

        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            COMMAND_AT_MS + 1,
            runtime.ids
              .managerOneAssignment
          );
        const beforeDeniedReplay =
          databaseBytes(runtime.database);
        assert.equal(
          runtime.repository.mutateCurrent({
            ...command,
            nowMs: COMMAND_AT_MS + 2,
            idempotency: idempotency(
              uuid(5_056),
              "route-safe-add"
            ),
            revisionId: uuid(5_057),
            action: {
              ...command.action,
              entryId: uuid(5_058),
            },
          }),
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeDeniedReplay
        );
      }
    );

    test(
      "enforces route mutation version and idempotency bounds and returns canonical stale details without writes",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_070);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const command = currentAddCommand(
          runtime,
          {
            playerId,
            entryId: uuid(5_071),
            requestId: uuid(5_072),
            revisionId: uuid(5_073),
            clientKey:
              "route-boundary-validation",
          }
        );
        const before = databaseBytes(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.repository.mutateCurrent({
              ...command,
              expectedCardVersion:
                Number.MAX_SAFE_INTEGER,
            }),
          (error) =>
            error?.name ===
              "CandidateCardPolicyError" &&
            error?.reasonCode ===
              "expected_card_version_invalid"
        );
        assert.throws(
          () =>
            runtime.repository.mutateCurrent({
              ...command,
              idempotency: {
                ...command.idempotency,
                clientKey:
                  "\u{1f3d2}".repeat(129),
              },
            }),
          (error) =>
            error?.name ===
              "CandidateCardPolicyError" &&
            error?.reasonCode ===
              "idempotency_key_invalid"
        );
        assert.throws(
          () =>
            runtime.repository.mutateCurrent({
              ...command,
              expectedCardVersion: 2,
              idempotency: idempotency(
                uuid(5_074),
                "stale-route-mutation"
              ),
              revisionId: uuid(5_075),
            }),
          (error) => {
            assert.deepEqual(
              error?.details,
              {
                reasonCode:
                  "CANDIDATE_CARD_PRECONDITION_FAILED",
                currentVersion: 1,
                refetch: true,
              }
            );
            return true;
          }
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );

    test(
      "fails closed when immutable replay evidence no longer matches its revision action and affected entry",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_080);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const command = currentAddCommand(
          runtime,
          {
            playerId,
            entryId: uuid(5_081),
            requestId: uuid(5_082),
            revisionId: uuid(5_083),
            clientKey:
              "corrupt-route-replay",
          }
        );
        const added =
          runtime.repository.mutateCurrent(
            command
          );
        runtime.database.exec(
          "DROP TRIGGER candidate_card_revisions_immutable_update"
        );
        runtime.database
          .prepare(`
            UPDATE candidate_card_revisions
            SET after_evidence_json = ?
            WHERE id = ?
          `)
          .run(
            JSON.stringify({
              result: {
                ...added,
                changedEntryId: null,
              },
            }),
            command.revisionId
          );
        const beforeReplay =
          databaseBytes(runtime.database);

        assertRepositoryError(
          () =>
            runtime.repository.mutateCurrent(
              command
            ),
          "REVISION_RESULT_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
      }
    );

    test(
      "executes the complete route-safe add, edit, move, and remove sequence with authoritative private results",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_090);
        const entryId = uuid(5_091);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const route = {
          leagueId: runtime.ids.league,
          fadId: runtime.ids.fad,
          teamId: runtime.ids.teamOne,
          viewer: privateViewer(
            managerOne(runtime)
          ),
        };
        const added =
          runtime.repository.mutateCurrent({
            ...route,
            expectedCardVersion: 1,
            nowMs: COMMAND_AT_MS,
            idempotency: idempotency(
              uuid(5_092),
              "complete-route-add"
            ),
            revisionId: uuid(5_093),
            action: {
              type: "add",
              entryId,
              playerId,
              slotKey: "F01",
              totalValueCents: 600,
              termYears: 2,
            },
          });
        assert.equal(
          added.card.cardVersion,
          2
        );
        assert.equal(
          added.card.slots.find(
            ({ slotKey }) =>
              slotKey === "F01"
          ).entryId,
          entryId
        );

        const edited =
          runtime.repository.mutateCurrent({
            ...route,
            expectedCardVersion: 2,
            nowMs: COMMAND_AT_MS + 1,
            idempotency: idempotency(
              uuid(5_094),
              "complete-route-edit"
            ),
            revisionId: uuid(5_095),
            action: {
              type: "edit",
              entryId,
              totalValueCents: 900,
              termYears: 3,
            },
          });
        const editedSlot =
          edited.card.slots.find(
            ({ slotKey }) =>
              slotKey === "F01"
          );
        assert.equal(
          edited.card.cardVersion,
          3
        );
        assert.equal(
          edited.changedEntryId,
          entryId
        );
        assert.equal(
          editedSlot.entryVersion,
          2
        );
        assert.equal(
          editedSlot.totalValueCents,
          900
        );
        assert.equal(
          editedSlot.termYears,
          3
        );
        assert.equal(
          editedSlot.aavCents,
          300
        );

        const moved =
          runtime.repository.mutateCurrent({
            ...route,
            expectedCardVersion: 3,
            nowMs: COMMAND_AT_MS + 2,
            idempotency: idempotency(
              uuid(5_096),
              "complete-route-move"
            ),
            revisionId: uuid(5_097),
            action: {
              type: "move",
              entryId,
              slotKey: "F02",
            },
          });
        assert.equal(
          moved.card.cardVersion,
          4
        );
        assert.equal(
          moved.changedEntryId,
          entryId
        );
        assert.equal(
          moved.card.slots.find(
            ({ slotKey }) =>
              slotKey === "F01"
          ).entryId,
          null
        );
        assert.equal(
          moved.card.slots.find(
            ({ slotKey }) =>
              slotKey === "F02"
          ).entryVersion,
          3
        );

        const removed =
          runtime.repository.mutateCurrent({
            ...route,
            expectedCardVersion: 4,
            nowMs: COMMAND_AT_MS + 3,
            idempotency: idempotency(
              uuid(5_098),
              "complete-route-remove"
            ),
            revisionId: uuid(5_099),
            action: {
              type: "remove",
              entryId,
            },
          });
        assert.equal(
          removed.card.cardVersion,
          5
        );
        assert.equal(
          removed.changedEntryId,
          null
        );
        assert.equal(
          removed.card.slots.every(
            ({ entryId: occupantId }) =>
              occupantId === null
          ),
          true
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT action
              FROM candidate_card_revisions
              WHERE card_id = ?
                AND resulting_card_version > 1
              ORDER BY resulting_card_version
            `)
            .all(runtime.ids.cardOne)
            .map(({ action }) => action),
          [
            "candidate_added",
            "candidate_edited",
            "candidate_moved",
            "candidate_removed",
          ]
        );
      }
    );

    test(
      "revalidates authoritative player state and position on edit while exact replay remains immutable",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_120);
        seedSelectablePlayer(runtime, {
          playerId,
          positionGroup: "F",
        });
        const add = addCommand(runtime, {
          playerId,
          slotKey: "B01",
          entryId: uuid(5_121),
          requestId: uuid(5_122),
          revisionId: uuid(5_123),
          clientKey:
            "authoritative-add",
        });
        const added =
          runtime.repository.mutate(add);
        assert.equal(
          added.card.entries[0]
            .effectivePositionGroup,
          "F"
        );
        assert.equal(
          added.card.entries[0]
            .eligibilityStatus,
          "valid"
        );
        assert.equal(
          added.card.entries[0]
            .validationCode,
          null
        );

        runtime.database
          .prepare(`
            UPDATE players
            SET status = 'historical',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(COMMAND_AT_MS + 1, playerId);
        const inactiveBytes =
          databaseBytes(runtime.database);
        assertRepositoryError(
          () =>
            runtime.repository.mutate({
              scope: scope(runtime),
              actor: managerOne(runtime),
              expectedCardVersion: 2,
              nowMs: COMMAND_AT_MS + 2,
              idempotency: idempotency(
                uuid(5_124),
                "inactive-edit"
              ),
              revisionId: uuid(5_125),
              action: {
                type: "edit",
                entryId:
                  add.action.entryId,
                totalValueCents: 900,
                termYears: 3,
              },
            }),
          "CANDIDATE_PLAYER_INELIGIBLE"
        );
        assert.equal(
          databaseBytes(runtime.database),
          inactiveBytes
        );

        const replay =
          runtime.repository.mutate(add);
        assert.deepEqual(replay, added);
        assert.equal(
          databaseBytes(runtime.database),
          inactiveBytes
        );

        runtime.database
          .prepare(`
            UPDATE players
            SET status = 'active',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(COMMAND_AT_MS + 3, playerId);
        runtime.database
          .prepare(`
            UPDATE league_player_positions
            SET ended_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND player_id = ?
              AND ended_at_ms IS NULL
          `)
          .run(
            COMMAND_AT_MS + 3,
            runtime.ids.league,
            playerId
          );
        insert(
          runtime.database,
          "league_player_positions",
          {
            id: uuid(5_126),
            league_id:
              runtime.ids.league,
            player_id: playerId,
            position_group: "D",
            reason:
              "Authoritative edit revalidation fixture",
            corrected_by_user_id:
              runtime.ids
                .commissionerUser,
            effective_at_ms:
              COMMAND_AT_MS + 3,
            ended_at_ms: null,
            version: 1,
          }
        );

        const edited =
          runtime.repository.mutate({
            scope: scope(runtime),
            actor: managerOne(runtime),
            expectedCardVersion: 2,
            nowMs: COMMAND_AT_MS + 4,
            idempotency: idempotency(
              uuid(5_127),
              "revalidated-edit"
            ),
            revisionId: uuid(5_128),
            action: {
              type: "edit",
              entryId:
                add.action.entryId,
              totalValueCents: 900,
              termYears: 3,
            },
          });
        assert.equal(
          edited.card.entries[0]
            .effectivePositionGroup,
          "D"
        );
        assert.equal(
          edited.card.entries[0]
            .eligibilityStatus,
          "valid"
        );
        assert.equal(
          edited.card.entries[0]
            .validationCode,
          null
        );
      }
    );

    test(
      "rejects stale, cross-team, deadline, and cross-scope writes with complete rollback",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(5_100);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const cases = [
          {
            command: addCommand(runtime, {
              playerId,
              expectedCardVersion: 2,
              requestId: uuid(5_101),
              revisionId: uuid(5_102),
              clientKey: "stale",
            }),
            reason:
              "CANDIDATE_CARD_PRECONDITION_FAILED",
          },
          {
            command: addCommand(runtime, {
              playerId,
              actor: managerTwo(runtime),
              requestId: uuid(5_103),
              revisionId: uuid(5_104),
              clientKey: "cross-team",
            }),
            reason:
              "CANDIDATE_CARD_NOT_FOUND",
          },
          {
            command: addCommand(runtime, {
              playerId,
              nowMs:
                CANDIDATE_DEADLINE_AT_MS,
              requestId: uuid(5_105),
              revisionId: uuid(5_106),
              clientKey: "deadline",
            }),
            reason: "FAD_DEADLINE_PASSED",
          },
          {
            command: {
              ...addCommand(runtime, {
                playerId,
                requestId: uuid(5_107),
                revisionId: uuid(5_108),
                clientKey:
                  "cross-scope",
              }),
              scope: scope(runtime, {
                leagueId: uuid(999_999),
              }),
            },
            reason:
              "CANDIDATE_CARD_NOT_FOUND",
          },
          {
            command: addCommand(runtime, {
              playerId,
              actor: {
                ...managerOne(runtime),
                authority:
                  "commissioner",
              },
              requestId: uuid(5_109),
              revisionId: uuid(5_110),
              clientKey:
                "spoofed-authority",
            }),
            reason:
              "CANDIDATE_CARD_NOT_FOUND",
          },
        ];
        for (const {
          command,
          reason,
        } of cases) {
          const before = databaseBytes(
            runtime.database
          );
          assertRepositoryError(
            () =>
              runtime.repository.mutate(
                command
              ),
            reason
          );
          assert.equal(
            databaseBytes(
              runtime.database
            ),
            before,
            reason
          );
        }
        assert.equal(
          count(
            runtime.database,
            "idempotency_requests",
            "WHERE league_id = ?",
            runtime.ids.league
          ),
          0
        );
      }
    );

    test(
      "rejects caller-authored eligibility state and a player with an active league contract without partial writes",
      (t) => {
        const runtime = createRuntime(t);
        const invalidPlayer = uuid(5_220);
        seedSelectablePlayer(runtime, {
          playerId: invalidPlayer,
        });
        const invalidCommand =
          addCommand(runtime, {
            playerId: invalidPlayer,
            requestId: uuid(5_221),
            revisionId: uuid(5_222),
            clientKey:
              "invalid-candidate",
          });
        invalidCommand.action = {
          ...invalidCommand.action,
          eligibilityStatus: "invalid",
          validationCode:
            "PLAYER_NOT_ELIGIBLE",
        };
        let before = databaseBytes(
          runtime.database
        );
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              invalidCommand
            ),
          "INPUT_FIELDS_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );

        const positionSpoof =
          addCommand(runtime, {
            playerId: invalidPlayer,
            requestId: uuid(5_223),
            revisionId: uuid(5_224),
            clientKey:
              "spoofed-position",
          });
        positionSpoof.action = {
          ...positionSpoof.action,
          effectivePositionGroup: "D",
        };
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              positionSpoof
            ),
          "INPUT_FIELDS_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );

        const editSpoof = {
          ...addCommand(runtime, {
            playerId: invalidPlayer,
            requestId: uuid(5_225),
            revisionId: uuid(5_226),
            clientKey:
              "spoofed-edit-validation",
          }),
          action: {
            type: "edit",
            entryId: uuid(5_227),
            totalValueCents: 600,
            termYears: 2,
            validationCode:
              "PLAYER_DECLARED_VALID",
          },
        };
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              editSpoof
            ),
          "INPUT_FIELDS_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );

        const contractedPlayer =
          uuid(5_230);
        seedSelectablePlayer(runtime, {
          playerId: contractedPlayer,
        });
        seedActiveContract(runtime, {
          playerId: contractedPlayer,
          contractId: uuid(5_231),
        });
        before = databaseBytes(
          runtime.database
        );
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              addCommand(runtime, {
                playerId:
                  contractedPlayer,
                requestId: uuid(5_232),
                revisionId: uuid(5_233),
                clientKey:
                  "active-contract",
              })
            ),
          "CANDIDATE_PLAYER_INELIGIBLE"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );

    test(
      "saves an advisory whole-card cap warning without an acknowledgement control and enforces the Bench AAV boundary without partial writes",
      (t) => {
        const runtime = createRuntime(t);
        runtime.database
          .prepare(`
            UPDATE league_settings
            SET salary_cap_cents = 200,
                version = version + 1
            WHERE league_id = ?
          `)
          .run(runtime.ids.league);
        const playerId = uuid(5_200);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const command = addCommand(runtime, {
            playerId,
            totalValueCents: 300,
            termYears: 1,
            requestId: uuid(5_201),
            revisionId: uuid(5_202),
            clientKey:
              "over-cap-advisory",
          });
        const before = databaseBytes(
          runtime.database
        );
        assertRepositoryError(
          () =>
            runtime.repository.mutate(
              {
                ...command,
                potentialIllegalityAcknowledged:
                  true,
              }
            ),
          "INPUT_FIELDS_INVALID"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
        const accepted =
          runtime.repository.mutate(command);
        assert.equal(
          accepted.card.capStatus,
          "over_cap"
        );
        assert.equal(
          accepted.card
            .allocationEligibility,
          "excluded_over_cap"
        );
        assert.equal(
          accepted.card.entries[0]
            .lastAcknowledgementRevisionId,
          null
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                potential_illegality_acknowledged,
                warning_codes_json
              FROM candidate_card_revisions
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              uuid(5_202)
            ),
          {
            potential_illegality_acknowledged:
              0,
            warning_codes_json:
              '["CANDIDATE_CARD_OVER_CAP"]',
          }
        );

        const bench = createRuntime(t);
        const benchPlayer = uuid(5_210);
        seedSelectablePlayer(bench, {
          playerId: benchPlayer,
        });
        const benchBefore = databaseBytes(
          bench.database
        );
        assert.throws(
          () =>
            bench.repository.mutate(
              addCommand(bench, {
                playerId: benchPlayer,
                slotKey: "B01",
                totalValueCents: 401,
                termYears: 1,
                requestId: uuid(5_211),
                revisionId: uuid(5_212),
                clientKey:
                  "bench-over-limit",
              })
            ),
          (error) =>
            error?.code ===
            "CANDIDATE_BENCH_AAV_EXCEEDED"
        );
        assert.equal(
          databaseBytes(bench.database),
          benchBefore
        );
      }
    );

    test(
      "enforces same-league prospect-right and FAD quarantine evidence without cross-league leakage",
      (t) => {
        const crossScope = createRuntime(t);
        const crossScopePlayer =
          uuid(5_400);
        seedSelectablePlayer(crossScope, {
          playerId: crossScopePlayer,
        });
        const otherLeagueIds =
          seedOpenLeague(
            crossScope.database,
            20_000
          );
        crossScope.database.exec(
          "DROP TRIGGER free_agent_draft_allocations_pending_insert"
        );
        seedReleasedProspectHistory(
          crossScope.database,
          otherLeagueIds,
          {
            playerId: crossScopePlayer,
            eventId: uuid(5_401),
          }
        );
        seedPendingFadAllocation(
          crossScope.database,
          otherLeagueIds,
          {
            allocationId: uuid(5_402),
            playerId: crossScopePlayer,
          }
        );
        const crossScopeResult =
          crossScope.repository.mutate(
            addCommand(crossScope, {
              playerId: crossScopePlayer,
              requestId: uuid(5_403),
              revisionId: uuid(5_404),
              clientKey:
                "cross-league-evidence",
            })
          );
        assert.equal(
          crossScopeResult.card.entries[0]
            .eligibilityStatus,
          "valid"
        );

        const released = createRuntime(t);
        const releasedPlayer =
          uuid(5_410);
        seedSelectablePlayer(released, {
          playerId: releasedPlayer,
        });
        seedReleasedProspectHistory(
          released.database,
          released.ids,
          {
            playerId: releasedPlayer,
            eventId: uuid(5_411),
            eventType:
              "fantasy_elc_declined",
          }
        );
        let before = databaseBytes(
          released.database
        );
        assertRepositoryError(
          () =>
            released.repository.mutate(
              addCommand(released, {
                playerId: releasedPlayer,
                requestId: uuid(5_412),
                revisionId: uuid(5_413),
                clientKey:
                  "released-rights",
              })
            ),
          "CANDIDATE_PLAYER_INELIGIBLE"
        );
        assert.equal(
          databaseBytes(released.database),
          before
        );

        const currentRight =
          createRuntime(t);
        const currentRightPlayer =
          uuid(5_420);
        seedSelectablePlayer(currentRight, {
          playerId: currentRightPlayer,
        });
        insert(
          currentRight.database,
          "player_ownerships",
          {
            id: uuid(5_421),
            league_id:
              currentRight.ids.league,
            season_id:
              currentRight.ids.season,
            player_id: currentRightPlayer,
            team_id:
              currentRight.ids.teamTwo,
            ownership_kind:
              "Prospect Right",
            roster_category: "Prospect",
            position_group: "F",
            slot_number: null,
            acquired_transaction_type:
              "entry_draft",
            acquired_transaction_id: null,
            created_at_ms:
              COMMAND_AT_MS - 1,
            updated_at_ms:
              COMMAND_AT_MS - 1,
            version: 1,
          }
        );
        before = databaseBytes(
          currentRight.database
        );
        assertRepositoryError(
          () =>
            currentRight.repository.mutate(
              addCommand(currentRight, {
                playerId:
                  currentRightPlayer,
                requestId: uuid(5_422),
                revisionId: uuid(5_423),
                clientKey:
                  "current-prospect-right",
              })
            ),
          "CANDIDATE_PLAYER_INELIGIBLE"
        );
        assert.equal(
          databaseBytes(
            currentRight.database
          ),
          before
        );

        const quarantined =
          createRuntime(t);
        const quarantinedPlayer =
          uuid(5_430);
        seedSelectablePlayer(quarantined, {
          playerId: quarantinedPlayer,
        });
        quarantined.database.exec(
          "DROP TRIGGER free_agent_draft_allocations_pending_insert"
        );
        seedPendingFadAllocation(
          quarantined.database,
          quarantined.ids,
          {
            allocationId: uuid(5_431),
            playerId: quarantinedPlayer,
          }
        );
        before = databaseBytes(
          quarantined.database
        );
        assertRepositoryError(
          () =>
            quarantined.repository.mutate(
              addCommand(quarantined, {
                playerId:
                  quarantinedPlayer,
                requestId: uuid(5_432),
                revisionId: uuid(5_433),
                clientKey:
                  "fad-quarantine",
              })
            ),
          "FAD_ALLOCATION_QUARANTINED"
        );
        assert.equal(
          databaseBytes(
            quarantined.database
          ),
          before
        );
      }
    );
  }
);

describe(
  "SQLite Candidate Card help grant",
  () => {
    test(
      "grants exact-card commissioner access atomically, preserves the first message for a new key, and attributes commissioner edits",
      (t) => {
        const runtime = createRuntime(t);
        const help =
          runtime.repository.requestHelp({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs: HELP_AT_MS,
            idempotency: idempotency(
              uuid(6_001),
              "help-first"
            ),
            helpRequestId: uuid(6_002),
            message:
              "Please help me finish this card.",
          });
        assert.equal(help.status, "active");
        assert.equal(
          runtime.helpSideEffects.length,
          1
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime, {
              teamId:
                runtime.ids.teamTwo,
              cardId:
                runtime.ids.cardTwo,
            }),
            actor: commissioner(runtime),
            nowMs: HELP_AT_MS + 1,
          }),
          null
        );

        const privateCard =
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: commissioner(runtime),
            nowMs: HELP_AT_MS + 1,
          });
        assert.equal(
          privateCard.accessReason,
          "help_grant_commissioner"
        );
        assert.equal(
          privateCard.helpContext.message,
          "Please help me finish this card."
        );

        const repeated =
          runtime.repository.requestHelp({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs: HELP_AT_MS + 2,
            idempotency: idempotency(
              uuid(6_003),
              "help-second"
            ),
            helpRequestId: uuid(6_004),
            message:
              "This replacement must not win.",
          });
        assert.deepEqual(repeated, help);
        assert.equal(
          runtime.helpSideEffects.length,
          1
        );

        const playerId = uuid(6_010);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const commissionerEdit =
          runtime.repository.mutate(
            addCommand(runtime, {
              playerId,
              actor: commissioner(runtime),
              nowMs: HELP_AT_MS + 3,
              requestId: uuid(6_011),
              revisionId: uuid(6_012),
              clientKey:
                "commissioner-help-edit",
            })
          );
        assert.equal(
          commissionerEdit.card.cardVersion,
          2
        );
        const managerView =
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: managerOne(runtime),
            nowMs: HELP_AT_MS + 4,
          });
        assert.deepEqual(
          managerView
            .commissionerInterventions,
          [
            {
              revisionId: uuid(6_012),
              entryId: uuid(5_001),
              action: "candidate_added",
              actorUserId:
                runtime.ids
                  .commissionerUser,
              actorDisplayName:
                "Commissioner 1000",
              authority: "commissioner",
              occurredAtMs:
                HELP_AT_MS + 3,
            },
          ]
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: commissioner(runtime),
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
          }),
          null
        );
      }
    );

    test(
      "requires a dual-role manager to use manager authority unless exact-card help backs commissioner authority",
      (t) => {
        const runtime = createRuntime(t);
        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            HELP_AT_MS,
            runtime.ids
              .managerOneAssignment
          );
        insert(
          runtime.database,
          "team_manager_assignments",
          {
            id: uuid(6_105),
            league_id:
              runtime.ids.league,
            team_id:
              runtime.ids.teamOne,
            user_id:
              runtime.ids
                .commissionerUser,
            membership_id:
              runtime.ids
                .commissionerMembership,
            assigned_by_user_id:
              runtime.ids
                .commissionerUser,
            status: "accepted",
            assigned_at_ms: HELP_AT_MS,
            accepted_at_ms: HELP_AT_MS,
            ended_at_ms: null,
            version: 1,
          }
        );
        const dualRoleManager = {
          ...commissioner(runtime),
          authority: "manager",
        };
        const dualRoleCommissioner =
          commissioner(runtime);
        const managerView =
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: dualRoleManager,
            nowMs: HELP_AT_MS,
          });
        assert.equal(
          managerView.accessReason,
          "team_manager"
        );
        assert.equal(
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: dualRoleCommissioner,
            nowMs: HELP_AT_MS,
          }),
          null
        );

        const help =
          runtime.repository.requestHelp({
            scope: scope(runtime),
            actor: dualRoleManager,
            nowMs: HELP_AT_MS + 1,
            idempotency: idempotency(
              uuid(6_100),
              "dual-role-help"
            ),
            helpRequestId: uuid(6_101),
            message:
              "Use commissioner authority for this exact card.",
          });
        assert.equal(help.status, "active");
        const helpedView =
          runtime.repository.readPrivate({
            scope: scope(runtime),
            actor: dualRoleCommissioner,
            nowMs: HELP_AT_MS + 2,
          });
        assert.equal(
          helpedView.accessReason,
          "help_grant_commissioner"
        );
        assert.deepEqual(
          helpedView.authorizationEvidence,
          {
            kind: "help_request",
            id: uuid(6_101),
          }
        );

        const playerId = uuid(6_102);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        const edited =
          runtime.repository.mutate(
            addCommand(runtime, {
              playerId,
              actor: dualRoleCommissioner,
              nowMs: HELP_AT_MS + 3,
              requestId: uuid(6_103),
              revisionId: uuid(6_104),
              clientKey:
                "dual-role-help-edit",
            })
          );
        assert.equal(
          edited.card.cardVersion,
          2
        );
      }
    );
  }
);

describe(
  "SQLite route-safe Candidate Card help command",
  () => {
    test(
      "creates one immutable 201 result and exactly replays it after the deadline and freeze",
      (t) => {
        const runtime = createRuntime(t);
        const command = currentHelpCommand(
          runtime
        );
        const created =
          runtime.repository.requestHelpCurrent(
            command
          );
        assert.equal(created.httpStatus, 201);
        assert.deepEqual(created.data, {
          helpRequestId: uuid(5_201),
          leagueId: runtime.ids.league,
          seasonId: runtime.ids.season,
          fadId: runtime.ids.fad,
          cardId: runtime.ids.cardOne,
          teamId: runtime.ids.teamOne,
          status: "active",
          message:
            "Please review my Candidate Card.",
          requestedByUserId:
            runtime.ids.managerOneUser,
          requestedByDisplayName:
            "Manager One 1000",
          requestedAtMs: HELP_AT_MS,
          expiresAtMs:
            CANDIDATE_DEADLINE_AT_MS,
          version: 1,
        });
        assert.equal(
          count(
            runtime.database,
            "candidate_card_help_command_results"
          ),
          1
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT result_type
              FROM idempotency_requests
              WHERE id = ?
            `)
            .get(uuid(5_200)).result_type,
          "candidate_card_help_command_result"
        );
        assert.equal(
          runtime.helpSideEffects.length,
          1
        );
        assert.deepEqual(
          Object.keys(
            runtime.helpSideEffects[0]
          ).sort(),
          [
            "actor",
            "expiresAtMs",
            "helpRequestId",
            "kind",
            "managerAssignmentId",
            "requestedAtMs",
            "scope",
          ]
        );

        runtime.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            CANDIDATE_DEADLINE_AT_MS,
            runtime.ids.league
          );
        const replayCommand =
          currentHelpCommand(runtime, {
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
            requestId: uuid(5_202),
            helpRequestId: uuid(5_203),
          });
        const beforeReplay = databaseBytes(
          runtime.database
        );
        assert.deepEqual(
          runtime.repository.requestHelpCurrent(
            replayCommand
          ),
          created
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
        assert.equal(
          runtime.helpSideEffects.length,
          1
        );

        assertRepositoryError(
          () =>
            runtime.repository.requestHelpCurrent({
              ...replayCommand,
              message: "Changed intent.",
            }),
          "IDEMPOTENCY_KEY_REUSED"
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
      }
    );

    test(
      "returns the original private response with 200 for a new active intent and replays it without duplicate effects",
      (t) => {
        const runtime = createRuntime(t);
        const created =
          runtime.repository.requestHelpCurrent(
            currentHelpCommand(runtime)
          );
        runtime.database
          .prepare(`
            UPDATE users
            SET display_name = 'Renamed Manager',
                display_name_normalized =
                  'renamed manager',
                updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            HELP_AT_MS + 1,
            runtime.ids.managerOneUser
          );
        const secondCommand =
          currentHelpCommand(runtime, {
            nowMs: HELP_AT_MS + 2,
            requestId: uuid(5_204),
            clientKey:
              "current-candidate-help-second",
            helpRequestId: uuid(5_205),
            message:
              "This replacement must not win.",
          });
        const existing =
          runtime.repository.requestHelpCurrent(
            secondCommand
          );
        assert.equal(existing.httpStatus, 200);
        assert.deepEqual(existing.data, created.data);
        assert.equal(
          runtime.helpSideEffects.length,
          1
        );
        const receipts = runtime.database
          .prepare(`
            SELECT response_http_status,
                   response_json,
                   response_sha256
            FROM candidate_card_help_command_results
            WHERE league_id = ?
            ORDER BY created_at_ms, id
          `)
          .all(runtime.ids.league);
        assert.equal(receipts.length, 2);
        assert.deepEqual(
          receipts.map(
            ({ response_http_status }) =>
              response_http_status
          ),
          [201, 200]
        );
        assert.equal(
          receipts[0].response_json,
          receipts[1].response_json
        );
        assert.equal(
          receipts[0].response_sha256,
          receipts[1].response_sha256
        );

        const beforeReplay = databaseBytes(
          runtime.database
        );
        assert.deepEqual(
          runtime.repository.requestHelpCurrent({
            ...secondCommand,
            nowMs:
              CANDIDATE_DEADLINE_AT_MS,
            idempotency: idempotency(
              uuid(5_206),
              "current-candidate-help-second"
            ),
            helpRequestId: uuid(5_207),
          }),
          existing
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
      }
    );

    test(
      "establishes exact current manager authority before replay and hides every other route scope",
      (t) => {
        const runtime = createRuntime(t);
        const command = currentHelpCommand(
          runtime
        );
        runtime.repository.requestHelpCurrent(
          command
        );
        assert.equal(
          runtime.repository.requestHelpCurrent(
            currentHelpCommand(runtime, {
              teamId: runtime.ids.teamTwo,
              clientKey: "wrong-team-help",
            })
          ),
          null
        );
        assert.equal(
          runtime.repository.requestHelpCurrent(
            currentHelpCommand(runtime, {
              leagueId: uuid(99_001),
              clientKey: "wrong-league-help",
            })
          ),
          null
        );
        runtime.database
          .prepare(`
            UPDATE team_manager_assignments
            SET status = 'ended',
                ended_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(
            HELP_AT_MS + 1,
            runtime.ids
              .managerOneAssignment
          );
        const beforeDenied = databaseBytes(
          runtime.database
        );
        assert.equal(
          runtime.repository.requestHelpCurrent({
            ...command,
            nowMs: HELP_AT_MS + 2,
            idempotency: idempotency(
              uuid(5_208),
              "current-candidate-help"
            ),
            helpRequestId: uuid(5_209),
          }),
          null
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeDenied
        );
      }
    );

    test(
      "enforces adaptive-window, freeze, and Unicode boundaries without starting a receipt",
      (t) => {
        for (const [overrides, reasonCode] of [
          [
            {
              nowMs: HELP_OPENS_AT_MS - 1,
              clientKey: "help-before-window",
            },
            "FAD_HELP_WINDOW_CLOSED",
          ],
          [
            {
              nowMs:
                CANDIDATE_DEADLINE_AT_MS,
              clientKey: "help-at-deadline",
            },
            "FAD_HELP_WINDOW_CLOSED",
          ],
        ]) {
          const runtime = createRuntime(t);
          const before = databaseBytes(
            runtime.database
          );
          assertRepositoryError(
            () =>
              runtime.repository
                .requestHelpCurrent(
                  currentHelpCommand(
                    runtime,
                    overrides
                  )
                ),
            reasonCode
          );
          assert.equal(
            databaseBytes(runtime.database),
            before
          );
        }

        const frozen = createRuntime(t);
        frozen.database
          .prepare(`
            UPDATE leagues
            SET status = 'frozen',
                version = version + 1
            WHERE id = ?
          `)
          .run(frozen.ids.league);
        const frozenBefore = databaseBytes(
          frozen.database
        );
        assertRepositoryError(
          () =>
            frozen.repository.requestHelpCurrent(
              currentHelpCommand(frozen, {
                clientKey: "help-frozen",
              })
            ),
          "LEAGUE_FROZEN"
        );
        assert.equal(
          databaseBytes(frozen.database),
          frozenBefore
        );

        const normalized = createRuntime(t);
        const whitespace =
          normalized.repository
            .requestHelpCurrent(
              currentHelpCommand(normalized, {
                message: "   ",
              })
            );
        assert.equal(
          whitespace.data.message,
          null
        );

        const maximum = createRuntime(t);
        const message =
          "\u{1f3d2}".repeat(500);
        assert.equal(
          maximum.repository.requestHelpCurrent(
            currentHelpCommand(maximum, {
              message,
            })
          ).data.message,
          message
        );
        const tooLong = createRuntime(t);
        const beforeTooLong = databaseBytes(
          tooLong.database
        );
        assert.throws(
          () =>
            tooLong.repository.requestHelpCurrent(
              currentHelpCommand(tooLong, {
                message:
                  `${message}\u{1f3d2}`,
              })
            ),
          (error) =>
            error?.name ===
              "CandidateCardPolicyError" &&
            error?.code ===
              "CANDIDATE_CARD_INPUT_INVALID"
        );
        assert.equal(
          databaseBytes(tooLong.database),
          beforeTooLong
        );
      }
    );

    test(
      "rolls every help, receipt, and idempotency write back at the final transaction seam",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit({ kind }) {
            if (
              kind ===
              "candidate_card_help_request"
            ) {
              throw new Error(
                "injected help commit failure"
              );
            }
          },
        });
        const before = databaseBytes(
          runtime.database
        );
        assert.throws(
          () =>
            runtime.repository.requestHelpCurrent(
              currentHelpCommand(runtime)
            ),
          (error) =>
            error?.cause?.message ===
              "injected help commit failure" ||
            error?.message ===
              "injected help commit failure"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
      }
    );
  }
);

describe(
  "SQLite Candidate Card carryover synchronization",
  () => {
    test(
      "synchronizes the complete authoritative carryover set, permits only an atomic compatible move, and preserves immutable identity and contract",
      (t) => {
        const runtime = createRuntime(t);
        const carryover =
          seedContractedCarryover(runtime);
        const syncCommand = {
          scope: scope(runtime),
          expectedCardVersion: 1,
          nowMs: COMMAND_AT_MS,
          revisionId: uuid(7_010),
          carryovers: [carryover],
          candidateConflicts: [],
          candidateReplacements: [],
        };
        const synchronized =
          runtime.repository
            .synchronizeCarryovers(
              syncCommand
            );
        assert.equal(
          synchronized.card.cardVersion,
          2
        );
        assert.equal(
          synchronized.card.entries[0]
            .entryKind,
          "carryover"
        );
        assert.equal(
          synchronized.card.entries[0]
            .contractId,
          carryover.contractId
        );
        assert.equal(
          synchronized.card.capProjection
            .maximumPossibleCapCents,
          100
        );

        const moved =
          runtime.repository.mutateCurrent({
            leagueId:
              runtime.ids.league,
            fadId: runtime.ids.fad,
            teamId:
              runtime.ids.teamOne,
            viewer: privateViewer(
              managerOne(runtime)
            ),
            expectedCardVersion: 2,
            nowMs: COMMAND_AT_MS + 1,
            idempotency: idempotency(
              uuid(7_011),
              "move-carryover"
            ),
            revisionId: uuid(7_012),
            action: {
              type: "move",
              entryId:
                carryover.entryId,
              slotKey: "B01",
            },
          });
        const movedSlot =
          moved.card.slots.find(
            ({ slotKey }) =>
              slotKey === "B01"
          );
        assert.equal(
          movedSlot.entryId,
          carryover.entryId
        );
        assert.equal(
          movedSlot.occupantKind,
          "carryover"
        );
        assert.equal(
          movedSlot
            .authoritativeRosterCategory,
          "Bench"
        );
        assert.equal(
          movedSlot.locked,
          true
        );
        assert.equal(
          moved.card.capProjection
            .maximumPossibleCapCents,
          0
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                roster_category,
                slot_number
              FROM player_ownerships
              WHERE id = ?
            `)
            .get(carryover.ownershipId),
          {
            roster_category: "Bench",
            slot_number: 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                carryover_ownership_id,
                carryover_contract_id,
                source_roster_category
              FROM candidate_card_entries
              WHERE id = ?
            `)
            .get(carryover.entryId),
          {
            carryover_ownership_id:
              carryover.ownershipId,
            carryover_contract_id:
              carryover.contractId,
            source_roster_category:
              "Bench",
          }
        );

        const beforeLockedActions =
          databaseBytes(runtime.database);
        for (const [
          action,
          reason,
        ] of [
          [
            {
              type: "remove",
              entryId:
                carryover.entryId,
            },
            "CANDIDATE_CARRYOVER_LOCKED",
          ],
          [
            {
              type: "edit",
              entryId:
                carryover.entryId,
              totalValueCents: 900,
              termYears: 3,
            },
            "CANDIDATE_CARRYOVER_LOCKED",
          ],
        ]) {
          assertRepositoryError(
            () =>
              runtime.repository.mutate({
                scope: scope(runtime),
                actor:
                  managerOne(runtime),
                expectedCardVersion: 3,
                nowMs:
                  COMMAND_AT_MS + 2,
                idempotency: idempotency(
                  uuid(
                    action.type ===
                      "remove"
                      ? 7_020
                      : 7_021
                  ),
                  `carryover-${action.type}`
                ),
                revisionId: uuid(
                  action.type === "remove"
                    ? 7_022
                    : 7_023
                ),
                action,
              }),
            reason
          );
        }
        assert.equal(
          databaseBytes(runtime.database),
          beforeLockedActions
        );

        const beforeReplay =
          databaseBytes(runtime.database);
        const replay =
          runtime.repository
            .synchronizeCarryovers(
              syncCommand
            );
        assert.deepEqual(
          replay,
          synchronized
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeReplay
        );
      }
    );

    test(
      "persists a Candidate displaced by an authoritative carryover as an individual structural conflict",
      (t) => {
        const runtime = createRuntime(t);
        const candidateEntryId = uuid(7_050);
        const candidatePlayerId = uuid(7_051);
        const conflictCode =
          "CANDIDATE_SLOT_CLAIMED_BY_CARRYOVER";
        seedSelectablePlayer(runtime, {
          playerId: candidatePlayerId,
        });
        const added = runtime.repository.mutate(
          addCommand(runtime, {
            entryId: candidateEntryId,
            playerId: candidatePlayerId,
            requestId: uuid(7_052),
            revisionId: uuid(7_053),
            clientKey:
              "candidate-before-carryover-conflict",
          })
        );
        assert.equal(added.card.cardVersion, 2);

        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(7_054),
            ownershipId: uuid(7_055),
            contractId: uuid(7_056),
            entryId: uuid(7_057),
          });
        const synchronized =
          runtime.repository.synchronizeCarryovers({
            scope: scope(runtime),
            expectedCardVersion: 2,
            nowMs: COMMAND_AT_MS + 1,
            revisionId: uuid(7_058),
            carryovers: [carryover],
            candidateConflicts: [
              {
                entryId: candidateEntryId,
                conflictCode,
              },
            ],
            candidateReplacements: [],
          });

        assert.equal(
          synchronized.card.cardVersion,
          3
        );
        assert.deepEqual(
          synchronized.card.completeness,
          {
            code: "conflicted",
            filledMandatoryCount: 1,
            missingMandatoryCount: 17,
            filledBenchCount: 0,
            emptyBenchCount: 4,
            blockingValidationCount: 1,
            structuralConflictCount: 1,
            carriedRosterStructuralConflictCount:
              0,
          }
        );
        assert.equal(
          synchronized.card.allocationEligibility,
          "eligible"
        );
        assert.equal(
          synchronized.card.allocationExclusionReason,
          null
        );
        assert.deepEqual(
          synchronized.card.entries.find(
            ({ entryId }) =>
              entryId === candidateEntryId
          ),
          {
            ...added.card.entries.find(
              ({ entryId }) =>
                entryId === candidateEntryId
            ),
            entryVersion: 2,
            placementState: "conflict",
            conflictCode,
            eligibilityStatus: "invalid",
            validationCode: conflictCode,
            lastEditedByUserId: null,
            lastEditedByMembershipId: null,
            lastEditedByAuthority: "system",
            lastAcknowledgementRevisionId: null,
            updatedAtMs: COMMAND_AT_MS + 1,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                placement_state,
                conflict_code,
                eligibility_status,
                validation_code,
                version
              FROM candidate_card_entries
              WHERE league_id = ?
                AND card_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne,
              candidateEntryId
            ),
          {
            placement_state: "conflict",
            conflict_code: conflictCode,
            eligibility_status: "invalid",
            validation_code: conflictCode,
            version: 2,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                structural_conflict_count,
                carried_roster_structural_conflict_count
              FROM candidate_cards
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne
            ),
          {
            structural_conflict_count: 1,
            carried_roster_structural_conflict_count:
              0,
          }
        );
      }
    );

    test(
      "synchronizes an authoritative Active to Injured Reserve to Active carryover round trip without changing identity or contract",
      (t) => {
        const runtime = createRuntime(t);
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(7_100),
            ownershipId: uuid(7_101),
            contractId: uuid(7_102),
            entryId: uuid(7_103),
          });
        const initialCommand = {
          scope: scope(runtime),
          expectedCardVersion: 1,
          nowMs: COMMAND_AT_MS,
          revisionId: uuid(7_104),
          carryovers: [carryover],
          candidateConflicts: [],
          candidateReplacements: [],
        };
        const initial =
          runtime.repository
            .synchronizeCarryovers(
              initialCommand
            );
        assert.equal(
          initial.card.cardVersion,
          2
        );
        assert.equal(
          initial.card.entries[0]
            .entryVersion,
          1
        );

        const contractBefore =
          runtime.database
            .prepare(`
              SELECT *
              FROM contracts
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              carryover.contractId
            );
        assert.equal(
          runtime.database
            .prepare(`
              UPDATE player_ownerships
              SET roster_category =
                    'Injured Reserve',
                  slot_number = 4,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE league_id = ?
                AND id = ?
                AND version = 1
            `)
            .run(
              COMMAND_AT_MS + 1,
              runtime.ids.league,
              carryover.ownershipId
            ).changes,
          1
        );

        const injuredReserveCarryover = {
          ...carryover,
          sourceRosterCategory:
            "Injured Reserve",
        };
        const injuredReserveCommand = {
          scope: scope(runtime),
          expectedCardVersion: 2,
          nowMs: COMMAND_AT_MS + 2,
          revisionId: uuid(7_105),
          carryovers: [
            injuredReserveCarryover,
          ],
          candidateConflicts: [],
          candidateReplacements: [],
        };
        const injuredReserve =
          runtime.repository
            .synchronizeCarryovers(
              injuredReserveCommand
            );
        assert.deepEqual(
          injuredReserve.card.entries[0],
          {
            ...initial.card.entries[0],
            entryVersion: 2,
            sourceRosterCategory:
              "Injured Reserve",
            lastEditedByUserId: null,
            lastEditedByMembershipId:
              null,
            lastEditedByAuthority:
              "system",
            updatedAtMs:
              COMMAND_AT_MS + 2,
          }
        );
        assert.equal(
          injuredReserve.card.cardVersion,
          3
        );
        assert.equal(
          injuredReserve.card.entries[0]
            .slotKey,
          "F01"
        );
        assert.equal(
          injuredReserve.card.capProjection
            .maximumPossibleCapCents,
          0
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                roster_category,
                slot_number,
                version
              FROM player_ownerships
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              carryover.ownershipId
            ),
          {
            roster_category:
              "Injured Reserve",
            slot_number: 4,
            version: 2,
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT *
              FROM contracts
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              carryover.contractId
            ),
          contractBefore
        );

        const beforeIrReplay =
          databaseBytes(runtime.database);
        assert.deepEqual(
          runtime.repository
            .synchronizeCarryovers(
              injuredReserveCommand
            ),
          injuredReserve
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeIrReplay
        );

        assert.equal(
          runtime.database
            .prepare(`
              UPDATE player_ownerships
              SET roster_category = 'Active',
                  slot_number = 2,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE league_id = ?
                AND id = ?
                AND version = 2
            `)
            .run(
              COMMAND_AT_MS + 3,
              runtime.ids.league,
              carryover.ownershipId
            ).changes,
          1
        );
        const returnedActiveCommand = {
          scope: scope(runtime),
          expectedCardVersion: 3,
          nowMs: COMMAND_AT_MS + 4,
          revisionId: uuid(7_106),
          carryovers: [
            {
              ...carryover,
              slotKey: "F02",
            },
          ],
          candidateConflicts: [],
          candidateReplacements: [],
        };
        const returnedActive =
          runtime.repository
            .synchronizeCarryovers(
              returnedActiveCommand
            );
        assert.equal(
          returnedActive.card.cardVersion,
          4
        );
        assert.equal(
          returnedActive.card.entries[0]
            .entryVersion,
          3
        );
        assert.equal(
          returnedActive.card.entries[0]
            .sourceRosterCategory,
          "Active"
        );
        assert.equal(
          returnedActive.card.entries[0]
            .slotKey,
          "F02"
        );
        assert.equal(
          returnedActive.card.entries[0]
            .ownershipId,
          carryover.ownershipId
        );
        assert.equal(
          returnedActive.card.entries[0]
            .contractId,
          carryover.contractId
        );
        assert.equal(
          returnedActive.card.capProjection
            .maximumPossibleCapCents,
          100
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT *
              FROM contracts
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              carryover.contractId
            ),
          contractBefore
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                action,
                resulting_card_version
              FROM candidate_card_revisions
              WHERE league_id = ?
                AND card_id = ?
                AND action =
                  'carryover_synchronized'
              ORDER BY resulting_card_version
            `)
            .all(
              runtime.ids.league,
              runtime.ids.cardOne
            ),
          [
            {
              action:
                "carryover_synchronized",
              resulting_card_version: 2,
            },
            {
              action:
                "carryover_synchronized",
              resulting_card_version: 3,
            },
            {
              action:
                "carryover_synchronized",
              resulting_card_version: 4,
            },
          ]
        );

        const beforeActiveReplay =
          databaseBytes(runtime.database);
        assert.deepEqual(
          runtime.repository
            .synchronizeCarryovers(
              returnedActiveCommand
            ),
          returnedActive
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeActiveReplay
        );
      }
    );

    test(
      "rolls an Injured Reserve carryover synchronization back at the final transaction seam",
      (t) => {
        let rejectSynchronization = false;
        const runtime = createRuntime(t, {
          beforeCommit({ kind }) {
            if (
              rejectSynchronization &&
              kind ===
                "candidate_card_carryover_synchronization"
            ) {
              throw new Error(
                "injected IR synchronization failure"
              );
            }
          },
        });
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(7_200),
            ownershipId: uuid(7_201),
            contractId: uuid(7_202),
            entryId: uuid(7_203),
          });
        runtime.repository
          .synchronizeCarryovers({
            scope: scope(runtime),
            expectedCardVersion: 1,
            nowMs: COMMAND_AT_MS,
            revisionId: uuid(7_204),
            carryovers: [carryover],
            candidateConflicts: [],
            candidateReplacements: [],
          });
        assert.equal(
          runtime.database
            .prepare(`
              UPDATE player_ownerships
              SET roster_category =
                    'Injured Reserve',
                  slot_number = 3,
                  updated_at_ms = ?,
                  version = version + 1
              WHERE league_id = ?
                AND id = ?
                AND version = 1
            `)
            .run(
              COMMAND_AT_MS + 1,
              runtime.ids.league,
              carryover.ownershipId
            ).changes,
          1
        );
        const command = {
          scope: scope(runtime),
          expectedCardVersion: 2,
          nowMs: COMMAND_AT_MS + 2,
          revisionId: uuid(7_205),
          carryovers: [
            {
              ...carryover,
              sourceRosterCategory:
                "Injured Reserve",
            },
          ],
          candidateConflicts: [],
          candidateReplacements: [],
        };
        const before =
          databaseBytes(runtime.database);
        rejectSynchronization = true;
        assert.throws(
          () =>
            runtime.repository
              .synchronizeCarryovers(
                command
              ),
          (error) =>
            error?.cause?.message ===
              "injected IR synchronization failure" ||
            error?.message ===
              "injected IR synchronization failure"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT COUNT(*) AS count
              FROM candidate_card_revisions
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              command.revisionId
            ).count,
          0
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                source_roster_category,
                version
              FROM candidate_card_entries
              WHERE league_id = ?
                AND card_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne,
              carryover.entryId
            ),
          {
            source_roster_category:
              "Active",
            version: 1,
          }
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT version
              FROM candidate_cards
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne
            ).version,
          2
        );
      }
    );
  }
);

test(
  "Candidate Card mutations roll every database write back when the final transaction seam fails",
  (t) => {
    const runtime = createRuntime(t, {
      beforeCommit() {
        throw new Error(
          "injected beforeCommit failure"
        );
      },
    });
    const playerId = uuid(8_001);
    seedSelectablePlayer(runtime, {
      playerId,
    });
    const before = databaseBytes(
      runtime.database
    );
    assert.throws(
      () =>
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId,
            requestId: uuid(8_002),
            revisionId: uuid(8_003),
            clientKey:
              "rollback-before-commit",
          })
        ),
      (error) =>
        error?.cause?.message ===
          "injected beforeCommit failure" ||
        error?.message ===
          "injected beforeCommit failure"
    );
    assert.equal(
      databaseBytes(runtime.database),
      before
    );
  }
);

test(
  "Candidate Cards have no early-submit transition and deadline locking fails closed into the league-wide deadline repository",
  (t) => {
    const runtime = createRuntime(t);
    const before = databaseBytes(
      runtime.database
    );
    assertRepositoryError(
      () =>
        runtime.repository
          .submitBeforeDeadline(),
      "CANDIDATE_CARD_EARLY_SUBMISSION_UNSUPPORTED"
    );
    assertRepositoryError(
      () =>
        runtime.repository.lockAtDeadline(),
      "FAD_DEADLINE_REPOSITORY_REQUIRED"
    );
    assert.equal(
      databaseBytes(runtime.database),
      before
    );
  }
);

describe(
  "SQLite Candidate Card current summer-state synchronization",
  () => {
    test(
      "requires its caller transaction and returns an exact byte-for-byte no-op while the persisted summer phase remains open",
      (t) => {
        const runtime = createRuntime(t);
        const command = summerCommand(runtime, {
          nowMs:
            CANDIDATE_DEADLINE_AT_MS + 1,
        });
        assertRepositoryError(
          () =>
            runtime.repository
              .synchronizeSummerStateCurrent(
                command
              ),
          "SUMMER_SYNCHRONIZATION_TRANSACTION_REQUIRED"
        );
        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges =
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value;

        assert.deepEqual(
          synchronizeSummer(runtime, command),
          {
            changed: false,
            action: null,
            cardVersion: 1,
            revisionId: null,
          }
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
        assert.equal(
          runtime.mutationSideEffects.length,
          0
        );
      }
    );

    test(
      "revalidates an affected Candidate through inactive, incompatible-position, and recovered states",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(9_100);
        const entryId = uuid(9_101);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId,
            entryId,
            requestId: uuid(9_102),
            revisionId: uuid(9_103),
            clientKey:
              "summer-revalidation-candidate",
          })
        );
        runtime.mutationSideEffects.length = 0;

        const synchronizeWithSourceChange = (
          sql,
          parameters,
          overrides
        ) =>
          runtime.database
            .transaction(() => {
              runtime.database
                .prepare(sql)
                .run(...parameters);
              return runtime.repository
                .synchronizeSummerStateCurrent(
                  summerCommand(runtime, {
                    affectedPlayerIds: [
                      playerId,
                    ],
                    ...overrides,
                  })
                );
            })
            .immediate();
        const readEntry = () =>
          runtime.database
            .prepare(`
              SELECT
                effective_position_group,
                placement_state,
                conflict_code,
                eligibility_status,
                validation_code,
                version
              FROM candidate_card_entries
              WHERE league_id = ?
                AND card_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne,
              entryId
            );

        assert.deepEqual(
          synchronizeWithSourceChange(
            `
              UPDATE players
              SET status = 'historical',
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `,
            [COMMAND_AT_MS + 101, playerId],
            {
              sourceOperationId:
                uuid(9_104),
              revisionId: uuid(9_105),
              nowMs: COMMAND_AT_MS + 101,
            }
          ),
          {
            changed: true,
            action:
              "eligibility_revalidated",
            cardVersion: 3,
            revisionId: uuid(9_105),
          }
        );
        assert.deepEqual(readEntry(), {
          effective_position_group: "F",
          placement_state: "placed",
          conflict_code: null,
          eligibility_status: "invalid",
          validation_code:
            "CANDIDATE_PLAYER_INELIGIBLE",
          version: 2,
        });

        assert.deepEqual(
          synchronizeWithSourceChange(
            `
              UPDATE players
              SET status = 'active',
                  updated_at_ms = ?,
                  version = version + 1
              WHERE id = ?
            `,
            [COMMAND_AT_MS + 102, playerId],
            {
              sourceOperationId:
                uuid(9_106),
              revisionId: uuid(9_107),
              nowMs: COMMAND_AT_MS + 102,
            }
          ),
          {
            changed: true,
            action:
              "eligibility_revalidated",
            cardVersion: 4,
            revisionId: uuid(9_107),
          }
        );
        assert.deepEqual(
          synchronizeWithSourceChange(
            `
              UPDATE league_player_positions
              SET position_group = 'D',
                  version = version + 1
              WHERE league_id = ?
                AND player_id = ?
                AND ended_at_ms IS NULL
            `,
            [runtime.ids.league, playerId],
            {
              sourceOperationId:
                uuid(9_108),
              revisionId: uuid(9_109),
              nowMs: COMMAND_AT_MS + 103,
            }
          ),
          {
            changed: true,
            action:
              "eligibility_revalidated",
            cardVersion: 5,
            revisionId: uuid(9_109),
          }
        );
        assert.deepEqual(readEntry(), {
          effective_position_group: "F",
          placement_state: "conflict",
          conflict_code:
            "CANDIDATE_SLOT_INCOMPATIBLE",
          eligibility_status: "invalid",
          validation_code:
            "CANDIDATE_SLOT_INCOMPATIBLE",
          version: 4,
        });

        assert.deepEqual(
          synchronizeWithSourceChange(
            `
              UPDATE league_player_positions
              SET position_group = 'F',
                  version = version + 1
              WHERE league_id = ?
                AND player_id = ?
                AND ended_at_ms IS NULL
            `,
            [runtime.ids.league, playerId],
            {
              sourceOperationId:
                uuid(9_110),
              revisionId: uuid(9_111),
              nowMs: COMMAND_AT_MS + 104,
            }
          ),
          {
            changed: true,
            action:
              "eligibility_revalidated",
            cardVersion: 6,
            revisionId: uuid(9_111),
          }
        );
        assert.deepEqual(readEntry(), {
          effective_position_group: "F",
          placement_state: "placed",
          conflict_code: null,
          eligibility_status: "valid",
          validation_code: null,
          version: 5,
        });
        assert.deepEqual(
          runtime.mutationSideEffects.map(
            ({ kind, action, cardVersion }) => ({
              kind,
              action,
              cardVersion,
            })
          ),
          [3, 4, 5, 6].map((cardVersion) => ({
            kind:
              "candidate_card_eligibility_revalidated",
            action:
              "eligibility_revalidated",
            cardVersion,
          }))
        );
      }
    );

    test(
      "combines carryover and Candidate eligibility changes into one card version and one revision",
      (t) => {
        const runtime = createRuntime(t);
        const candidatePlayerId = uuid(9_200);
        const candidateEntryId = uuid(9_201);
        seedSelectablePlayer(runtime, {
          playerId: candidatePlayerId,
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId: candidatePlayerId,
            entryId: candidateEntryId,
            requestId: uuid(9_202),
            revisionId: uuid(9_203),
            clientKey: "summer-combined-change",
          })
        );
        runtime.mutationSideEffects.length = 0;
        const revisionId = uuid(9_204);
        const result = runtime.database
          .transaction(() => {
            runtime.database
              .prepare(`
                UPDATE players
                SET status = 'historical',
                    updated_at_ms = ?,
                    version = version + 1
                WHERE id = ?
              `)
              .run(
                COMMAND_AT_MS + 201,
                candidatePlayerId
              );
            seedContractedCarryover(runtime, {
              playerId: uuid(9_205),
              ownershipId: uuid(9_206),
              contractId: uuid(9_207),
              entryId: uuid(9_208),
            });
            return runtime.repository
              .synchronizeSummerStateCurrent(
                summerCommand(runtime, {
                  affectedPlayerIds: [
                    candidatePlayerId,
                    uuid(9_205),
                  ],
                  sourceOperationId:
                    uuid(9_209),
                  sourceKind:
                    "roster_movement",
                  nowMs: COMMAND_AT_MS + 201,
                  revisionId,
                })
              );
          })
          .immediate();

        assert.deepEqual(result, {
          changed: true,
          action:
            "summer_state_synchronized",
          cardVersion: 3,
          revisionId,
        });
        assert.equal(
          count(
            runtime.database,
            "candidate_card_revisions",
            "WHERE card_id = ? AND action = ?",
            runtime.ids.cardOne,
            "summer_state_synchronized"
          ),
          1
        );
        assert.deepEqual(
          runtime.mutationSideEffects.map(
            ({ kind, action, cardVersion }) => ({
              kind,
              action,
              cardVersion,
            })
          ),
          [
            {
              kind:
                "candidate_card_summer_state_synchronized",
              action:
                "summer_state_synchronized",
              cardVersion: 3,
            },
          ]
        );
      }
    );

    test(
      "rolls the source mutation and every summer-state write back when the final transaction seam fails",
      (t) => {
        const runtime = createRuntime(t, {
          beforeCommit({ kind }) {
            if (
              kind ===
              "candidate_card_summer_state_synchronization"
            ) {
              throw new Error(
                "injected summer commit failure"
              );
            }
          },
        });
        const playerId = uuid(9_300);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        runtime.repository.mutate(
          addCommand(runtime, {
            playerId,
            entryId: uuid(9_301),
            requestId: uuid(9_302),
            revisionId: uuid(9_303),
            clientKey: "summer-rollback",
          })
        );
        const before = databaseBytes(
          runtime.database
        );

        assert.throws(
          () =>
            runtime.database
              .transaction(() => {
                runtime.database
                  .prepare(`
                    UPDATE players
                    SET status = 'historical',
                        updated_at_ms = ?,
                        version = version + 1
                    WHERE id = ?
                  `)
                  .run(
                    COMMAND_AT_MS + 301,
                    playerId
                  );
                return runtime.repository
                  .synchronizeSummerStateCurrent(
                    summerCommand(runtime, {
                      affectedPlayerIds: [
                        playerId,
                      ],
                      sourceOperationId:
                        uuid(9_304),
                      revisionId: uuid(9_305),
                      nowMs:
                        COMMAND_AT_MS + 301,
                    })
                  );
              })
              .immediate(),
          (error) =>
            error?.cause?.message ===
              "injected summer commit failure" ||
            error?.message ===
              "injected summer commit failure"
        );
        assert.equal(
          databaseBytes(runtime.database),
          before
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT status, version
              FROM players
              WHERE id = ?
            `)
            .get(playerId),
          { status: "active", version: 1 }
        );
        assert.equal(
          runtime.database
            .prepare(`
              SELECT version
              FROM candidate_cards
              WHERE id = ?
            `)
            .get(runtime.ids.cardOne).version,
          2
        );
      }
    );

    test(
      "synchronizes one standalone carryover with the exact private system side effect and immediately repeats without writes",
      (t) => {
        const runtime = createRuntime(t);
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(9_400),
            ownershipId: uuid(9_401),
            contractId: uuid(9_402),
            entryId: uuid(9_403),
          });
        const command = summerCommand(runtime, {
          affectedPlayerIds: [
            carryover.playerId,
          ],
          sourceOperationId: uuid(9_404),
          sourceKind: "season_rollover",
          nowMs: COMMAND_AT_MS + 401,
          revisionId: uuid(9_405),
        });

        assert.deepEqual(
          synchronizeSummer(runtime, command),
          {
            changed: true,
            action: "carryover_synchronized",
            cardVersion: 2,
            revisionId: uuid(9_405),
          }
        );
        assert.deepEqual(
          runtime.mutationSideEffects,
          [
            {
              kind:
                "candidate_card_carryovers_synchronized",
              scope: scope(runtime),
              actor: {
                userId: null,
                membershipId: null,
                authority: "system",
              },
              action:
                "carryover_synchronized",
              revisionId: uuid(9_405),
              cardVersion: 2,
              changedAtMs:
                COMMAND_AT_MS + 401,
            },
          ]
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                entry_kind,
                player_id,
                carryover_ownership_id,
                carryover_contract_id,
                placement_state,
                conflict_code
              FROM candidate_card_entries
              WHERE league_id = ?
                AND card_id = ?
                AND player_id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne,
              carryover.playerId
            ),
          {
            entry_kind: "carryover",
            player_id: carryover.playerId,
            carryover_ownership_id:
              carryover.ownershipId,
            carryover_contract_id:
              carryover.contractId,
            placement_state: "placed",
            conflict_code: null,
          }
        );

        const beforeBytes = databaseBytes(
          runtime.database
        );
        const beforeChanges =
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value;
        assert.deepEqual(
          synchronizeSummer(runtime, command),
          {
            changed: false,
            action: null,
            cardVersion: 2,
            revisionId: null,
          }
        );
        assert.equal(
          databaseBytes(runtime.database),
          beforeBytes
        );
        assert.equal(
          runtime.database
            .prepare(
              "SELECT total_changes() AS value"
            )
            .get().value,
          beforeChanges
        );
        assert.equal(
          runtime.mutationSideEffects.length,
          1
        );
      }
    );

    test(
      "persists an authoritative Bench carryover above the Candidate bench AAV maximum as a structural conflict",
      (t) => {
        const runtime = createRuntime(t);
        const carryover =
          seedContractedCarryover(runtime, {
            playerId: uuid(9_500),
            ownershipId: uuid(9_501),
            contractId: uuid(9_502),
            entryId: uuid(9_503),
          });
        runtime.database
          .prepare(`
            UPDATE player_ownerships
            SET roster_category = 'Bench',
                slot_number = 1,
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            COMMAND_AT_MS + 501,
            runtime.ids.league,
            carryover.ownershipId
          );
        runtime.database
          .prepare(`
            UPDATE contracts
            SET original_total_value_cents = 401,
                original_term_years = 1,
                aav_cents = 401,
                updated_at_ms = ?,
                version = version + 1
            WHERE league_id = ?
              AND id = ?
          `)
          .run(
            COMMAND_AT_MS + 501,
            runtime.ids.league,
            carryover.contractId
          );
        runtime.database
          .prepare(`
            UPDATE contract_years
            SET year_number = 1,
                aav_cents = 401
            WHERE league_id = ?
              AND contract_id = ?
              AND season_id = ?
          `)
          .run(
            runtime.ids.league,
            carryover.contractId,
            runtime.ids.season
          );

        assert.deepEqual(
          synchronizeSummer(
            runtime,
            summerCommand(runtime, {
              affectedPlayerIds: [
                carryover.playerId,
              ],
              sourceOperationId:
                uuid(9_504),
              sourceKind:
                "roster_movement",
              nowMs: COMMAND_AT_MS + 501,
              revisionId: uuid(9_505),
            })
          ),
          {
            changed: true,
            action: "carryover_synchronized",
            cardVersion: 2,
            revisionId: uuid(9_505),
          }
        );
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                source_roster_category,
                carryover_aav_cents,
                requested_slot_group,
                requested_slot_number,
                placement_state,
                conflict_code
              FROM candidate_card_entries
              WHERE league_id = ?
                AND card_id = ?
                AND player_id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne,
              carryover.playerId
            ),
          {
            source_roster_category: "Bench",
            carryover_aav_cents: 401,
            requested_slot_group: "B",
            requested_slot_number: 1,
            placement_state: "conflict",
            conflict_code:
              "CARRYOVER_SLOT_CONFLICT",
          }
        );
      }
    );

    test(
      "synchronizes a summary-only cap obligation with an empty affected-player set",
      (t) => {
        const runtime = createRuntime(t);
        const playerId = uuid(9_600);
        const contractId = uuid(9_601);
        const retentionId = uuid(9_602);
        seedSelectablePlayer(runtime, {
          playerId,
        });
        seedActiveContract(runtime, {
          playerId,
          contractId,
        });
        const revisionId = uuid(9_603);

        const result = runtime.database
          .transaction(() => {
            insert(
              runtime.database,
              "retention_obligations",
              {
                id: retentionId,
                league_id:
                  runtime.ids.league,
                contract_id: contractId,
                player_id: playerId,
                originating_team_id:
                  runtime.ids.teamOne,
                responsible_team_id:
                  runtime.ids.teamOne,
                retained_aav_cents: 25,
                creation_trade_id: null,
                status: "active",
                created_at_ms:
                  COMMAND_AT_MS + 601,
                updated_at_ms:
                  COMMAND_AT_MS + 601,
                version: 1,
              }
            );
            insert(
              runtime.database,
              "retention_years",
              {
                id: uuid(9_604),
                league_id:
                  runtime.ids.league,
                retention_obligation_id:
                  retentionId,
                season_id:
                  runtime.ids.season,
                retained_aav_cents: 25,
                status: "current",
                created_at_ms:
                  COMMAND_AT_MS + 601,
              }
            );
            return runtime.repository
              .synchronizeSummerStateCurrent(
                summerCommand(runtime, {
                  affectedPlayerIds: [],
                  sourceOperationId:
                    uuid(9_605),
                  sourceKind:
                    "cap_obligation",
                  nowMs: COMMAND_AT_MS + 601,
                  revisionId,
                })
              );
          })
          .immediate();

        assert.deepEqual(result, {
          changed: true,
          action:
            "summer_state_synchronized",
          cardVersion: 2,
          revisionId,
        });
        assert.deepEqual(
          runtime.database
            .prepare(`
              SELECT
                maximum_possible_cap_cents,
                cap_status,
                version
              FROM candidate_cards
              WHERE league_id = ?
                AND id = ?
            `)
            .get(
              runtime.ids.league,
              runtime.ids.cardOne
            ),
          {
            maximum_possible_cap_cents: 25,
            cap_status: "compliant",
            version: 2,
          }
        );
        assert.deepEqual(
          runtime.mutationSideEffects,
          [
            {
              kind:
                "candidate_card_summer_state_synchronized",
              scope: scope(runtime),
              actor: {
                userId: null,
                membershipId: null,
                authority: "system",
              },
              action:
                "summer_state_synchronized",
              revisionId,
              cardVersion: 2,
              changedAtMs:
                COMMAND_AT_MS + 601,
            },
          ]
        );
      }
    );
  }
);
