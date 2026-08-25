const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const CANONICAL_MIGRATIONS = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIRST_MATCHUP_STARTS_AT_MS = 2_000_000_000;
const CANDIDATE_DEADLINE_AT_MS =
  FIRST_MATCHUP_STARTS_AT_MS - 7 * DAY_MS;
const HELP_OPENS_AT_MS =
  CANDIDATE_DEADLINE_AT_MS - 48 * HOUR_MS;
const OPENED_AT_MS = HELP_OPENS_AT_MS - 1_000;
const SNAPSHOT_AT_MS = CANDIDATE_DEADLINE_AT_MS + 10;
const RESTRICTED_OPENED_AT_MS = CANDIDATE_DEADLINE_AT_MS + 20;
const DRAW_ALGORITHM_VERSION = "hundo-fad-draw-v1";
const NEW_TABLES = Object.freeze([
  "auction_contexts",
  "free_agent_draft_auction_participants",
  "free_agent_draft_draws",
]);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function numericId(id) {
  return Number(id.slice(-12));
}

function insert(database, tableName, values) {
  const columns = Object.keys(values);
  try {
    database
      .prepare(`
        INSERT INTO ${tableName} (
          ${columns.join(", ")}
        ) VALUES (
          ${columns.map((column) => `@${column}`).join(", ")}
        )
      `)
      .run(values);
  } catch (error) {
    const diagnostic = new Error(
      `Insert into ${tableName} failed: ` +
        `${error?.message ?? error?.code ?? "unknown error"}`,
      { cause: error }
    );
    diagnostic.code = error?.code;
    throw diagnostic;
  }
}

function assertConstraint(callback, pattern) {
  assert.throws(callback, (error) => {
    return (
      error?.code?.startsWith("SQLITE_CONSTRAINT") &&
      (!pattern || pattern.test(error.message))
    );
  });
}

let savepointSequence = 0;

function inRolledBackSavepoint(database, callback) {
  savepointSequence += 1;
  const savepoint = `fad_0026_${savepointSequence}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    callback();
  } finally {
    database.exec(`ROLLBACK TO ${savepoint}`);
    database.exec(`RELEASE ${savepoint}`);
  }
}

function createRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  const migrationsDirectory = path.join(
    temporaryRoot,
    "migrations"
  );
  fs.mkdirSync(migrationsDirectory);
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });

  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    ...connection,
    migrationsDirectory,
  };
}

function copyMigrationsThrough(runtime, maximumId) {
  for (const migration of discoverMigrations({
    migrationsDirectory: CANONICAL_MIGRATIONS,
  })) {
    if (migration.id > maximumId) continue;
    fs.copyFileSync(
      migration.filePath,
      path.join(runtime.migrationsDirectory, migration.fileName)
    );
  }
}

function migrate(runtime, buildId) {
  return applyMigrations({
    database: runtime.database,
    migrations: discoverMigrations({
      migrationsDirectory: runtime.migrationsDirectory,
    }),
    applicationBuildId: buildId,
    now: () => 1_000,
  });
}

function readTables(database, tableNames) {
  return Object.fromEntries(
    tableNames.map((tableName) => [
      tableName,
      database
        .prepare(`SELECT * FROM ${tableName} ORDER BY rowid`)
        .all(),
    ])
  );
}

function frame(bytes) {
  const source = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(source.length);
  return Buffer.concat([length, source]);
}

function drawCommitment(auctionId, nonce) {
  return crypto
    .createHash("sha256")
    .update(
      Buffer.concat([
        frame(Buffer.from(DRAW_ALGORITHM_VERSION, "utf8")),
        frame(Buffer.from(auctionId.toLowerCase(), "utf8")),
        frame(nonce),
      ])
    )
    .digest("hex");
}

function encodeBidIds(bidIds) {
  const count = Buffer.alloc(2);
  count.writeUInt16BE(bidIds.length);
  return Buffer.concat([
    count,
    ...bidIds.map((id) =>
      frame(Buffer.from(id.toLowerCase(), "utf8"))
    ),
  ]);
}

function drawSelection(auctionId, nonce, rolloverAtMs, bidIds) {
  const orderedBidIds = [...bidIds].sort();
  const rollover = Buffer.alloc(8);
  rollover.writeBigUInt64BE(BigInt(rolloverAtMs));
  const domain = frame(
    Buffer.from(DRAW_ALGORITHM_VERSION, "utf8")
  );
  const framedNonce = frame(nonce);
  const framedAuction = frame(
    Buffer.from(auctionId.toLowerCase(), "utf8")
  );
  const encodedBidIds = encodeBidIds(orderedBidIds);
  const modulus = BigInt(orderedBidIds.length);
  const maximum = 1n << 256n;
  const threshold = (maximum / modulus) * modulus;

  for (let counter = 0; counter <= 0xffffffff; counter += 1) {
    const encodedCounter = Buffer.alloc(4);
    encodedCounter.writeUInt32BE(counter);
    const digest = crypto
      .createHash("sha256")
      .update(
        Buffer.concat([
          domain,
          framedNonce,
          framedAuction,
          rollover,
          encodedBidIds,
          encodedCounter,
        ])
      )
      .digest();
    const value = BigInt(`0x${digest.toString("hex")}`);
    if (value < threshold) {
      return {
        counter,
        digestHex: digest.toString("hex"),
        orderedBidIds,
        selectedIndex: Number(value % modulus),
      };
    }
  }

  throw new Error("draw rejection sampling exhausted");
}

function seedLeague(database, {
  base,
  secondTeam = false,
  thirdTeam = false,
  leagueName = `League ${base}`,
} = {}) {
  const ids = {
    commissionerUser: uuid(base + 1),
    managerUser: uuid(base + 2),
    platformRole: uuid(base + 3),
    league: uuid(base + 4),
    commissionerMembership: uuid(base + 5),
    managerMembership: uuid(base + 6),
    sourceSeason: uuid(base + 7),
    targetSeason: uuid(base + 8),
    team: uuid(base + 9),
    managerAssignment: uuid(base + 10),
    week: uuid(base + 11),
    entryDraft: uuid(base + 12),
    seasonRollover: uuid(base + 13),
  };
  if (secondTeam) {
    ids.secondTeam = uuid(base + 14);
    ids.secondManagerAssignment = uuid(base + 15);
  }
  if (thirdTeam) {
    ids.thirdTeam = uuid(base + 16);
    ids.thirdManagerAssignment = uuid(base + 17);
  }

  for (const [kind, id] of [
    ["commissioner", ids.commissionerUser],
    ["manager", ids.managerUser],
  ]) {
    insert(database, "users", {
      id,
      email_normalized: `${kind}-${base}@example.test`,
      email_display: `${kind}-${base}@example.test`,
      display_name: `${kind} ${base}`,
      display_name_normalized: `${kind} ${base}`,
      status: "active",
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
    });
  }
  insert(database, "platform_roles", {
    id: ids.platformRole,
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
    name: leagueName,
    name_normalized: leagueName.toLowerCase(),
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
  for (const [id, userId, permission] of [
    [
      ids.commissionerMembership,
      ids.commissionerUser,
      "commissioner",
    ],
    [ids.managerMembership, ids.managerUser, "manager"],
  ]) {
    insert(database, "league_memberships", {
      id,
      league_id: ids.league,
      user_id: userId,
      permission_category: permission,
      status: "active",
      joined_at_ms: 10,
      ended_at_ms: null,
      created_at_ms: 10,
      updated_at_ms: 10,
      version: 1,
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
    id: ids.sourceSeason,
    league_id: ids.league,
    label: "2025-26",
    nhl_season_key: "20252026",
    status: "completed",
    regular_season_starts_at_ms: 100,
    regular_season_ends_at_ms: 200,
    fantasy_playoffs_start_at_ms: 170,
    fantasy_playoffs_end_at_ms: 200,
    created_at_ms: 10,
    updated_at_ms: 20,
    version: 2,
  });
  insert(database, "seasons", {
    id: ids.targetSeason,
    league_id: ids.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    regular_season_ends_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    fantasy_playoffs_start_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 8_000,
    fantasy_playoffs_end_at_ms:
      FIRST_MATCHUP_STARTS_AT_MS + 10_000,
    created_at_ms: 20,
    updated_at_ms: 30,
    version: 2,
  });
  database
    .prepare(`
      UPDATE leagues
      SET status = 'active',
          commissioner_membership_id = ?,
          current_season_id = ?,
          updated_at_ms = 30,
          version = 2
      WHERE id = ?
    `)
    .run(
      ids.commissionerMembership,
      ids.targetSeason,
      ids.league
    );

  for (const [teamId, teamName, assignmentId] of [
    [ids.team, `Team ${base}`, ids.managerAssignment],
    ...(secondTeam
      ? [[
          ids.secondTeam,
          `Second Team ${base}`,
          ids.secondManagerAssignment,
        ]]
      : []),
    ...(thirdTeam
      ? [[
          ids.thirdTeam,
          `Third Team ${base}`,
          ids.thirdManagerAssignment,
        ]]
      : []),
  ]) {
    insert(database, "teams", {
      id: teamId,
      league_id: ids.league,
      name: teamName,
      name_normalized: teamName.toLowerCase(),
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: 20,
      updated_at_ms: 20,
      version: 1,
    });
    insert(database, "team_manager_assignments", {
      id: assignmentId,
      league_id: ids.league,
      team_id: teamId,
      user_id: ids.managerUser,
      membership_id: ids.managerMembership,
      assigned_by_user_id: ids.commissionerUser,
      status: "accepted",
      assigned_at_ms: 20,
      accepted_at_ms: 20,
      ended_at_ms: null,
      version: 1,
    });
  }

  insert(database, "matchup_weeks", {
    id: ids.week,
    league_id: ids.league,
    season_id: ids.targetSeason,
    week_key: "W01",
    sequence: 1,
    starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    baseline_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 100,
    locks_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 200,
    ends_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_000,
    rolls_over_at_ms: FIRST_MATCHUP_STARTS_AT_MS + 1_100,
    status: "scheduled",
    created_at_ms: 20,
    updated_at_ms: 20,
    version: 1,
  });
  insert(database, "entry_drafts", {
    id: ids.entryDraft,
    league_id: ids.league,
    season_id: ids.targetSeason,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: OPENED_AT_MS - 2_000,
    completed_at_ms: OPENED_AT_MS - 1_000,
    created_by_user_id: ids.commissionerUser,
    created_at_ms: OPENED_AT_MS - 2_000,
    updated_at_ms: OPENED_AT_MS - 1_000,
    version: 2,
  });
  insert(database, "season_rollovers", {
    id: ids.seasonRollover,
    league_id: ids.league,
    from_season_id: ids.sourceSeason,
    to_season_id: ids.targetSeason,
    status: "succeeded",
    authorized_by_user_id: ids.commissionerUser,
    authorized_by_membership_id: ids.commissionerMembership,
    authorized_authority: "commissioner",
    league_version_before: 1,
    league_version_after: 2,
    from_season_version_before: 1,
    from_season_version_after: 2,
    to_season_version_before: 1,
    to_season_version_after: 2,
    target_season_created: 0,
    completed_at_ms: OPENED_AT_MS - 1_000,
    contracts_advanced: 0,
    contracts_expired: 0,
    ownerships_carried: 0,
    ownerships_released: 0,
    retention_years_advanced: 0,
    retention_obligations_completed: 0,
    buyout_years_advanced: 0,
    buyout_obligations_completed: 0,
    trades_cancelled: 0,
    created_at_ms: OPENED_AT_MS - 1_000,
    version: 1,
  });

  return ids;
}

function seedPlayer(database, playerId) {
  insert(database, "players", {
    id: playerId,
    first_name: `Player ${playerId.slice(-3)}`,
    last_name: "Forward",
    full_name: `Player ${playerId.slice(-3)} Forward`,
    birth_date: null,
    status: "active",
    created_at_ms: 10,
    updated_at_ms: 10,
    version: 1,
  });
}

function fadRecord(ids, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 100),
    league_id: ids.league,
    season_id: ids.targetSeason,
    first_matchup_week_id: ids.week,
    participating_team_count: ids.secondTeam ? 2 : 1,
    status: "cards_open",
    setup_path: "completed_entry_draft",
    entry_draft_id: ids.entryDraft,
    setup_exemption_id: null,
    prior_season_rollover_id: ids.seasonRollover,
    no_draft_reason: null,
    opened_by_user_id: ids.commissionerUser,
    opened_by_membership_id: ids.commissionerMembership,
    opened_authority: "commissioner",
    opened_at_ms: OPENED_AT_MS,
    help_opens_at_ms: HELP_OPENS_AT_MS,
    candidate_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    first_matchup_starts_at_ms: FIRST_MATCHUP_STARTS_AT_MS,
    deadline_locked_at_ms: null,
    allocation_completed_at_ms: null,
    completed_at_ms: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function fadTeamRecord(ids, fadId, teamId, offset) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    team_id: teamId,
    team_status_at_setup: "active",
    created_at_ms: OPENED_AT_MS,
  };
}

function cardRecord(ids, fadId, teamId, offset) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
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
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  };
}

function revisionRecord(
  ids,
  fadId,
  card,
  teamId,
  offset,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    card_id: card.id,
    team_id: teamId,
    resulting_card_version: 1,
    action: "card_opened",
    affected_entry_id: null,
    player_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    before_evidence_json: "{}",
    after_evidence_json: '{"slots":[]}',
    potential_illegality_acknowledged: 0,
    warning_codes_json: "[]",
    occurred_at_ms: OPENED_AT_MS,
    created_at_ms: OPENED_AT_MS,
    ...overrides,
  };
}

function candidateEntryRecord(
  ids,
  fixture,
  card,
  teamId,
  playerId,
  offset
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    card_id: card.id,
    team_id: teamId,
    entry_kind: "candidate",
    player_id: playerId,
    effective_position_group: "F",
    requested_slot_group: "F",
    requested_slot_number: 1,
    placement_state: "placed",
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
    last_acknowledgement_revision_id: null,
    created_by_user_id: ids.managerUser,
    created_by_membership_id: ids.managerMembership,
    created_by_authority: "manager",
    last_edited_by_user_id: ids.managerUser,
    last_edited_by_membership_id: ids.managerMembership,
    last_edited_by_authority: "manager",
    created_at_ms: OPENED_AT_MS + 10,
    updated_at_ms: OPENED_AT_MS + 10,
    version: 1,
  };
}

function snapshotRecord(
  ids,
  fixture,
  card,
  teamId,
  offset
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    card_id: card.id,
    team_id: teamId,
    locked_card_version: 3,
    locked_status: "locked_incomplete",
    completeness_code: "incomplete",
    filled_mandatory_count: 1,
    missing_mandatory_count: 17,
    filled_bench_count: 0,
    empty_bench_count: 4,
    blocking_validation_count: 0,
    structural_conflict_count: 0,
    cap_limit_cents: 10_000,
    carried_active_player_amount_cents: 0,
    retention_obligation_cents: 0,
    buyout_penalty_cents: 0,
    carried_cap_usage_cents: 0,
    proposed_candidate_aav_cents: 300,
    maximum_possible_cap_cents: 300,
    maximum_cap_space_cents: 9_700,
    effective_deadline_at_ms: CANDIDATE_DEADLINE_AT_MS,
    processed_at_ms: SNAPSHOT_AT_MS,
    created_at_ms: SNAPSHOT_AT_MS,
  };
}

function snapshotEntryRecord(
  ids,
  fixture,
  teamFixture,
  slotGroup,
  slotNumber,
  offset
) {
  const isCandidate = slotGroup === "F" && slotNumber === 1;
  const entry = teamFixture.entry;
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    snapshot_id: teamFixture.snapshot.id,
    card_id: teamFixture.card.id,
    team_id: teamFixture.teamId,
    row_kind: "slot",
    occupant_kind: isCandidate ? "candidate" : "empty",
    slot_group: slotGroup,
    slot_number: slotNumber,
    source_entry_id: isCandidate ? entry.id : null,
    source_entry_version: isCandidate ? entry.version : null,
    player_id: isCandidate ? entry.player_id : null,
    effective_position_group: isCandidate
      ? entry.effective_position_group
      : null,
    conflict_code: null,
    carryover_ownership_id: null,
    carryover_contract_id: null,
    source_roster_category: null,
    carryover_original_total_value_cents: null,
    carryover_original_term_years: null,
    carryover_aav_cents: null,
    remaining_years: null,
    proposed_total_value_cents: isCandidate
      ? entry.proposed_total_value_cents
      : null,
    proposed_term_years: isCandidate
      ? entry.proposed_term_years
      : null,
    proposed_aav_cents: isCandidate
      ? entry.proposed_aav_cents
      : null,
    eligibility_status: isCandidate
      ? entry.eligibility_status
      : null,
    validation_code: null,
    last_edited_by_user_id: isCandidate
      ? entry.last_edited_by_user_id
      : null,
    last_edited_by_membership_id: isCandidate
      ? entry.last_edited_by_membership_id
      : null,
    last_edited_by_authority: isCandidate
      ? entry.last_edited_by_authority
      : null,
    last_edited_at_ms: isCandidate ? entry.updated_at_ms : null,
    created_at_ms: SNAPSHOT_AT_MS,
  };
}

function seedLockedCandidateCard(
  database,
  ids,
  fixture,
  {
    teamId,
    cardOffset,
    entryOffset,
    revisionOffset,
    snapshotOffset,
    snapshotEntryOffset,
  }
) {
  const card = cardRecord(
    ids,
    fixture.fad.id,
    teamId,
    cardOffset
  );
  insert(database, "candidate_cards", card);
  insert(
    database,
    "candidate_card_revisions",
    revisionRecord(
      ids,
      fixture.fad.id,
      card,
      teamId,
      revisionOffset
    )
  );

  const entry = candidateEntryRecord(
    ids,
    fixture,
    card,
    teamId,
    fixture.playerId,
    entryOffset
  );
  insert(database, "candidate_card_entries", entry);
  database
    .prepare(`
      UPDATE candidate_cards
      SET filled_mandatory_count = 1,
          missing_mandatory_count = 17,
          maximum_possible_cap_cents = 300,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
    `)
    .run(OPENED_AT_MS + 20, card.id);
  const candidateRevision = revisionRecord(
    ids,
    fixture.fad.id,
    card,
    teamId,
    revisionOffset + 1,
    {
      resulting_card_version: 2,
      action: "candidate_added",
      affected_entry_id: entry.id,
      player_id: fixture.playerId,
      actor_user_id: ids.managerUser,
      actor_membership_id: ids.managerMembership,
      actor_authority: "manager",
      before_evidence_json: '{"entry":null}',
      after_evidence_json: '{"slot":"F01"}',
      occurred_at_ms: OPENED_AT_MS + 20,
      created_at_ms: OPENED_AT_MS + 20,
    }
  );
  insert(
    database,
    "candidate_card_revisions",
    candidateRevision
  );
  database
    .prepare(`
      UPDATE candidate_cards
      SET status = 'locked_incomplete',
          locked_at_ms = ?,
          updated_at_ms = ?,
          version = 3
      WHERE id = ?
    `)
    .run(
      CANDIDATE_DEADLINE_AT_MS,
      CANDIDATE_DEADLINE_AT_MS,
      card.id
    );
  insert(
    database,
    "candidate_card_revisions",
    revisionRecord(
      ids,
      fixture.fad.id,
      card,
      teamId,
      revisionOffset + 2,
      {
        resulting_card_version: 3,
        action: "deadline_locked",
        before_evidence_json: '{"status":"open"}',
        after_evidence_json:
          '{"status":"locked_incomplete"}',
        occurred_at_ms: CANDIDATE_DEADLINE_AT_MS,
        created_at_ms: CANDIDATE_DEADLINE_AT_MS,
      }
    )
  );
  const snapshot = snapshotRecord(
    ids,
    fixture,
    card,
    teamId,
    snapshotOffset
  );
  insert(database, "candidate_card_snapshots", snapshot);
  const teamFixture = {
    teamId,
    card: { ...card, status: "locked_incomplete", version: 3 },
    entry,
    candidateRevision,
    snapshot,
    candidateSnapshotEntry: null,
  };
  let sequence = 0;
  for (const [slotGroup, maximum] of [
    ["F", 12],
    ["D", 6],
    ["B", 4],
  ]) {
    for (
      let slotNumber = 1;
      slotNumber <= maximum;
      slotNumber += 1
    ) {
      sequence += 1;
      const snapshotEntry = snapshotEntryRecord(
        ids,
        fixture,
        teamFixture,
        slotGroup,
        slotNumber,
        snapshotEntryOffset + sequence
      );
      insert(
        database,
        "candidate_card_snapshot_entries",
        snapshotEntry
      );
      if (
        snapshotEntry.occupant_kind === "candidate"
      ) {
        teamFixture.candidateSnapshotEntry = snapshotEntry;
      }
    }
  }
  return teamFixture;
}

function rolloverRecord(ids, fadId, sequence) {
  const rollsOverAtMs =
    CANDIDATE_DEADLINE_AT_MS + sequence * DAY_MS;
  return {
    id: uuid(numericId(ids.league) + 400 + sequence),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fadId,
    sequence,
    opens_at_ms: rollsOverAtMs - DAY_MS,
    creation_cutoff_at_ms: rollsOverAtMs - HOUR_MS,
    rolls_over_at_ms: rollsOverAtMs,
    status: "scheduled",
    processing_started_at_ms: null,
    completed_at_ms: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  };
}

function jobRunRecord(
  ids,
  id,
  jobType,
  occurrenceKey,
  scheduledForMs
) {
  return {
    id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    job_type: jobType,
    occurrence_key: occurrenceKey,
    scheduled_for_ms: scheduledForMs,
    status: "pending",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at_ms: null,
    started_at_ms: null,
    completed_at_ms: null,
    result_json: null,
    last_error_code: null,
    created_at_ms: OPENED_AT_MS,
    updated_at_ms: OPENED_AT_MS,
    version: 1,
  };
}

function leaseJob(database, job, leasedAtMs) {
  database
    .prepare(`
      UPDATE job_runs
      SET status = 'leased',
          attempt_count = attempt_count + 1,
          lease_owner = 'fad-0026-test',
          lease_expires_at_ms = ?,
          started_at_ms = NULL,
          completed_at_ms = NULL,
          result_json = NULL,
          last_error_code = NULL,
          updated_at_ms = ?,
          version = version + 1,
          lease_token = ?,
          next_attempt_at_ms = NULL
      WHERE id = ?
    `)
    .run(
      leasedAtMs + HOUR_MS,
      leasedAtMs,
      `lease-${job.id}`,
      job.id
    );
}

function seedDurableFadJobs(database, ids, fixture) {
  const base = numericId(ids.league);
  const jobs = {
    reminder: jobRunRecord(
      ids,
      uuid(base + 600),
      "fad_deadline_reminder",
      `fad:${fixture.fad.id}:reminder:` +
        `${CANDIDATE_DEADLINE_AT_MS - 72 * HOUR_MS}`,
      CANDIDATE_DEADLINE_AT_MS - 72 * HOUR_MS
    ),
    deadline: jobRunRecord(
      ids,
      uuid(base + 601),
      "fad_deadline",
      `fad:${fixture.fad.id}:deadline:` +
        `${CANDIDATE_DEADLINE_AT_MS}`,
      CANDIDATE_DEADLINE_AT_MS
    ),
    allocation: jobRunRecord(
      ids,
      uuid(base + 602),
      "fad_allocation",
      `fad:${fixture.fad.id}:allocate:` +
        `${fixture.playerId}`,
      CANDIDATE_DEADLINE_AT_MS
    ),
    completion: jobRunRecord(
      ids,
      uuid(base + 603),
      "fad_completion",
      `fad:${fixture.fad.id}:complete:` +
        `${FIRST_MATCHUP_STARTS_AT_MS}`,
      FIRST_MATCHUP_STARTS_AT_MS
    ),
  };
  for (const rollover of fixture.rollovers) {
    jobs[`rollover-${rollover.sequence}`] = jobRunRecord(
      ids,
      uuid(base + 610 + rollover.sequence),
      "fad_rollover",
      `fad:${fixture.fad.id}:rollover:` +
        `${rollover.sequence}:${rollover.rolls_over_at_ms}`,
      rollover.rolls_over_at_ms
    );
  }
  for (const job of Object.values(jobs)) {
    insert(database, "job_runs", job);
  }
  return jobs;
}

function seedExactTieFad(database, ids, playerId) {
  ids.secondTeam ??= uuid(numericId(ids.league) + 14);
  const fixture = {
    fad: fadRecord(ids, {
      participating_team_count: ids.thirdTeam ? 3 : 2,
    }),
    playerId,
  };
  seedPlayer(database, playerId);
  insert(database, "free_agent_drafts", fixture.fad);
  insert(
    database,
    "free_agent_draft_teams",
    fadTeamRecord(ids, fixture.fad.id, ids.team, 101)
  );
  insert(
    database,
    "free_agent_draft_teams",
    fadTeamRecord(
      ids,
      fixture.fad.id,
      ids.secondTeam,
      102
    )
  );

  fixture.firstTeam = seedLockedCandidateCard(
    database,
    ids,
    fixture,
    {
      teamId: ids.team,
      cardOffset: 110,
      entryOffset: 120,
      revisionOffset: 130,
      snapshotOffset: 140,
      snapshotEntryOffset: 200,
    }
  );
  fixture.secondTeam = seedLockedCandidateCard(
    database,
    ids,
    fixture,
    {
      teamId: ids.secondTeam,
      cardOffset: 310,
      entryOffset: 320,
      revisionOffset: 330,
      snapshotOffset: 340,
      snapshotEntryOffset: 350,
    }
  );
  if (ids.thirdTeam) {
    insert(
      database,
      "free_agent_draft_teams",
      fadTeamRecord(
        ids,
        fixture.fad.id,
        ids.thirdTeam,
        103
      )
    );
    fixture.thirdTeam = seedLockedCandidateCard(
      database,
      ids,
      fixture,
      {
        teamId: ids.thirdTeam,
        cardOffset: 510,
        entryOffset: 520,
        revisionOffset: 530,
        snapshotOffset: 540,
        snapshotEntryOffset: 550,
      }
    );
  }
  fixture.rollovers = [];
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const rollover = rolloverRecord(
      ids,
      fixture.fad.id,
      sequence
    );
    insert(database, "free_agent_draft_rollovers", rollover);
    fixture.rollovers.push(rollover);
  }
  fixture.allocation = {
    id: uuid(numericId(ids.league) + 360),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    player_id: playerId,
    status: "pending",
    decision_code: null,
    winning_snapshot_entry_id: null,
    winning_team_id: null,
    contract_id: null,
    ownership_id: null,
    restricted_auction_id: null,
    resolved_at_ms: null,
    last_error_code: null,
    created_at_ms: SNAPSHOT_AT_MS,
    updated_at_ms: SNAPSHOT_AT_MS,
    version: 1,
  };
  insert(
    database,
    "free_agent_draft_player_allocations",
    fixture.allocation
  );
  fixture.jobs = seedDurableFadJobs(
    database,
    ids,
    fixture
  );
  leaseJob(database, fixture.jobs.deadline, SNAPSHOT_AT_MS);
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'deadline_locked',
          deadline_locked_at_ms = ?,
          updated_at_ms = ?,
          version = 2
      WHERE id = ?
    `)
    .run(SNAPSHOT_AT_MS, SNAPSHOT_AT_MS, fixture.fad.id);
  leaseJob(
    database,
    fixture.jobs.allocation,
    RESTRICTED_OPENED_AT_MS
  );
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'allocating',
          updated_at_ms = ?,
          version = 3
      WHERE id = ?
    `)
    .run(
      RESTRICTED_OPENED_AT_MS,
      fixture.fad.id
    );
  return fixture;
}

function auctionRecord(ids, fixture, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 700),
    league_id: ids.league,
    season_id: ids.targetSeason,
    player_id: fixture.playerId,
    status: "open",
    opened_at_ms: RESTRICTED_OPENED_AT_MS,
    resolves_at_ms: fixture.rollovers[0].rolls_over_at_ms,
    opened_by_user_id: null,
    created_at_ms: RESTRICTED_OPENED_AT_MS,
    updated_at_ms: RESTRICTED_OPENED_AT_MS,
    version: 1,
    ...overrides,
  };
}

function bidRecord(
  ids,
  fixture,
  auction,
  teamFixture,
  offset,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: auction.id,
    team_id: teamFixture.teamId,
    submitted_by_user_id: ids.managerUser,
    total_value_cents:
      teamFixture.entry.proposed_total_value_cents,
    term_years: teamFixture.entry.proposed_term_years,
    lowest_offered_aav_cents:
      teamFixture.entry.proposed_aav_cents,
    first_submitted_at_ms: auction.opened_at_ms,
    last_edited_at_ms: auction.opened_at_ms,
    edit_count: 0,
    status: "active",
    idempotency_request_id: null,
    version: 1,
    ...overrides,
  };
}

function seedEventRecord(
  ids,
  auction,
  bid,
  offset,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: auction.id,
    bid_id: bid.id,
    team_id: bid.team_id,
    actor_user_id: null,
    event_type: "fad_restricted_seed_created",
    metadata_json: "{}",
    occurred_at_ms: auction.opened_at_ms,
    ...overrides,
  };
}

function bidEditedEventRecord(
  ids,
  auction,
  bid,
  offset,
  occurredAtMs
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: auction.id,
    bid_id: bid.id,
    team_id: bid.team_id,
    actor_user_id: ids.managerUser,
    event_type: "bid_edited",
    metadata_json: "{}",
    occurred_at_ms: occurredAtMs,
  };
}

function allocationEventRecord(
  ids,
  fixture,
  allocation,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + 850),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    allocation_id: allocation.id,
    allocation_version: allocation.version,
    player_id: allocation.player_id,
    event_kind: "decision_recorded",
    snapshot_entry_id: null,
    team_id: null,
    offer_valid: null,
    rank_position: null,
    offer_outcome_code: null,
    decision_code: allocation.decision_code,
    resulting_allocation_status: allocation.status,
    contract_id: allocation.contract_id,
    ownership_id: allocation.ownership_id,
    auction_id: allocation.restricted_auction_id,
    activity_id: null,
    correction_id: null,
    actor_user_id: null,
    actor_membership_id: null,
    actor_authority: "system",
    evidence_json: "{}",
    occurred_at_ms: allocation.updated_at_ms,
    created_at_ms: allocation.updated_at_ms,
    ...overrides,
  };
}

function insertRestrictedAllocationEvents(
  database,
  ids,
  fixture,
  allocation,
  idOffset = 0,
  decisionEventKind = "restricted_state_changed"
) {
  const teamFixtures = [
    fixture.firstTeam,
    fixture.secondTeam,
    ...(fixture.thirdTeam ? [fixture.thirdTeam] : []),
  ];
  for (const [index, teamFixture] of teamFixtures.entries()) {
    insert(
      database,
      "free_agent_draft_allocation_events",
      allocationEventRecord(ids, fixture, allocation, {
        id: uuid(
          numericId(ids.league) + 851 + idOffset + index
        ),
        event_kind: "offer_considered",
        snapshot_entry_id:
          teamFixture.candidateSnapshotEntry.id,
        team_id: teamFixture.teamId,
        offer_valid: 1,
        rank_position: 1,
        offer_outcome_code: "restricted_tied",
        decision_code: null,
        auction_id: null,
      })
    );
  }
  insert(
    database,
    "free_agent_draft_allocation_events",
    allocationEventRecord(ids, fixture, allocation, {
      id: uuid(
        numericId(ids.league) +
          851 +
          teamFixtures.length +
          idOffset
      ),
      event_kind: decisionEventKind,
    })
  );
}

function contextRecord(
  ids,
  fixture,
  auction,
  overrides = {}
) {
  return {
    id: auction.id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: auction.id,
    source_kind: "fad_restricted",
    fad_id: fixture.fad.id,
    fad_rollover_id: fixture.rollovers[0].id,
    fad_allocation_id: fixture.allocation.id,
    created_at_ms: auction.opened_at_ms,
    ...overrides,
  };
}

function participantRecord(
  ids,
  fixture,
  auction,
  teamFixture,
  bid,
  seedEvent,
  offset,
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + offset),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    allocation_id: fixture.allocation.id,
    auction_id: auction.id,
    team_id: teamFixture.teamId,
    status: "active",
    source_snapshot_entry_id:
      teamFixture.candidateSnapshotEntry.id,
    originating_candidate_revision_id:
      teamFixture.candidateRevision.id,
    seeded_bid_id: bid.id,
    seed_event_id: seedEvent.id,
    original_total_value_cents:
      teamFixture.entry.proposed_total_value_cents,
    original_term_years:
      teamFixture.entry.proposed_term_years,
    original_aav_cents:
      teamFixture.entry.proposed_aav_cents,
    cooldown_anchor_at_ms: CANDIDATE_DEADLINE_AT_MS,
    manager_edit_limit: 1,
    minimum_final_total_cents:
      teamFixture.entry.proposed_total_value_cents,
    originating_actor_user_id: ids.managerUser,
    originating_actor_membership_id:
      ids.managerMembership,
    originating_actor_authority: "manager",
    removed_by_user_id: null,
    removed_by_membership_id: null,
    removed_authority: null,
    removal_reason: null,
    removed_at_ms: null,
    created_at_ms: auction.opened_at_ms,
    updated_at_ms: auction.opened_at_ms,
    version: 1,
    ...overrides,
  };
}

function drawRecord(
  ids,
  fixture,
  auction,
  nonce = Buffer.alloc(32, 0x26),
  overrides = {}
) {
  return {
    id: uuid(numericId(ids.league) + 740),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    allocation_id: fixture.allocation.id,
    auction_id: auction.id,
    algorithm_version: 1,
    nonce_bytes: nonce,
    commitment_hex: drawCommitment(auction.id, nonce),
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
    ...overrides,
  };
}

function updateAllocation(
  database,
  allocation,
  changes
) {
  const next = {
    ...allocation,
    ...changes,
    updated_at_ms:
      changes.updated_at_ms ?? RESTRICTED_OPENED_AT_MS,
    version: allocation.version + 1,
  };
  database
    .prepare(`
      UPDATE free_agent_draft_player_allocations
      SET status = @status,
          decision_code = @decision_code,
          winning_snapshot_entry_id =
            @winning_snapshot_entry_id,
          winning_team_id = @winning_team_id,
          contract_id = @contract_id,
          ownership_id = @ownership_id,
          restricted_auction_id = @restricted_auction_id,
          resolved_at_ms = @resolved_at_ms,
          last_error_code = @last_error_code,
          updated_at_ms = @updated_at_ms,
          version = @version
      WHERE id = @id
    `)
    .run(next);
  return next;
}

function seedRestrictedAuction(
  database,
  ids,
  fixture,
  {
    auction = auctionRecord(ids, fixture),
    context = null,
    auctionAlreadyInserted = false,
    contextAlreadyInserted = false,
    drawOverrides = {},
  } = {}
) {
  context ??= contextRecord(ids, fixture, auction);
  const firstBid = bidRecord(
    ids,
    fixture,
    auction,
    fixture.firstTeam,
    710
  );
  const secondBid = bidRecord(
    ids,
    fixture,
    auction,
    fixture.secondTeam,
    711
  );
  const firstSeedEvent = seedEventRecord(
    ids,
    auction,
    firstBid,
    720
  );
  const secondSeedEvent = seedEventRecord(
    ids,
    auction,
    secondBid,
    721
  );
  const firstParticipant = participantRecord(
    ids,
    fixture,
    auction,
    fixture.firstTeam,
    firstBid,
    firstSeedEvent,
    730
  );
  const secondParticipant = participantRecord(
    ids,
    fixture,
    auction,
    fixture.secondTeam,
    secondBid,
    secondSeedEvent,
    731
  );
  const bids = [firstBid, secondBid];
  const seedEvents = [firstSeedEvent, secondSeedEvent];
  const participants = [
    firstParticipant,
    secondParticipant,
  ];
  if (fixture.thirdTeam) {
    const thirdBid = bidRecord(
      ids,
      fixture,
      auction,
      fixture.thirdTeam,
      712
    );
    const thirdSeedEvent = seedEventRecord(
      ids,
      auction,
      thirdBid,
      722
    );
    const thirdParticipant = participantRecord(
      ids,
      fixture,
      auction,
      fixture.thirdTeam,
      thirdBid,
      thirdSeedEvent,
      732
    );
    bids.push(thirdBid);
    seedEvents.push(thirdSeedEvent);
    participants.push(thirdParticipant);
  }
  const draw = drawRecord(
    ids,
    fixture,
    auction,
    Buffer.alloc(32, 0x26),
    drawOverrides
  );

  database.transaction(() => {
    if (!auctionAlreadyInserted) {
      insert(database, "auctions", auction);
    }
    if (!contextAlreadyInserted) {
      insert(database, "auction_contexts", context);
    }
    for (const participant of participants) {
      insert(
        database,
        "free_agent_draft_auction_participants",
        participant
      );
    }
    for (const bid of bids) {
      insert(database, "auction_bids", bid);
    }
    for (const seedEvent of seedEvents) {
      insert(database, "auction_events", seedEvent);
    }
    insert(database, "free_agent_draft_draws", draw);
    fixture.allocation = updateAllocation(
      database,
      fixture.allocation,
      {
        status: "restricted_active",
        decision_code: "exact_total_and_term_tie",
        restricted_auction_id: auction.id,
        resolved_at_ms: auction.opened_at_ms,
        last_error_code: null,
        updated_at_ms: auction.opened_at_ms,
      }
    );
    insertRestrictedAllocationEvents(
      database,
      ids,
      fixture,
      fixture.allocation
    );
  })();

  return {
    auction,
    context,
    bids,
    seedEvents,
    participants,
    draw,
  };
}

function settleJobRun(
  database,
  job,
  status,
  completedAtMs,
  lastErrorCode = null
) {
  assert.ok(status === "succeeded" || status === "failed");
  try {
    database
      .prepare(`
        UPDATE job_runs
        SET status = ?,
            started_at_ms =
              COALESCE(started_at_ms, updated_at_ms),
            completed_at_ms = ?,
            result_json = ?,
            last_error_code = ?,
            lease_owner = NULL,
            lease_expires_at_ms = NULL,
            lease_token = NULL,
            next_attempt_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `)
      .run(
        status,
        completedAtMs,
        status === "succeeded" ? "{}" : null,
        status === "failed" ? lastErrorCode : null,
        status === "failed" ? completedAtMs : null,
        completedAtMs,
        job.id
      );
  } catch (error) {
    const diagnostic = new Error(
      `Settle ${job.job_type} job ${job.id} as ${status} failed: ` +
        `${error?.message ?? error?.code ?? "unknown error"}`,
      { cause: error }
    );
    diagnostic.code = error?.code;
    throw diagnostic;
  }
}

function finishRapid(
  database,
  fixture,
  completedAtMs = RESTRICTED_OPENED_AT_MS + 10
) {
  database
    .prepare(`
      UPDATE free_agent_drafts
      SET status = 'rapid',
          allocation_completed_at_ms = ?,
          updated_at_ms = ?,
          version = 4
      WHERE id = ?
    `)
    .run(completedAtMs, completedAtMs, fixture.fad.id);
  settleJobRun(
    database,
    fixture.jobs.deadline,
    "succeeded",
    completedAtMs
  );
  settleJobRun(
    database,
    fixture.jobs.allocation,
    "succeeded",
    completedAtMs
  );
}

function completeFadRollover(database, rollover, job) {
  const processingAtMs = rollover.rolls_over_at_ms + 1;
  const completedAtMs = rollover.rolls_over_at_ms + 2;
  const stored = database
    .prepare(`
      SELECT status
      FROM free_agent_draft_rollovers
      WHERE id = ?
    `)
    .get(rollover.id);
  if (stored.status === "scheduled") {
    leaseJob(database, job, processingAtMs);
    database
      .prepare(`
        UPDATE free_agent_draft_rollovers
        SET status = 'processing',
            processing_started_at_ms = ?,
            updated_at_ms = ?,
            version = version + 1
        WHERE id = ?
      `)
      .run(processingAtMs, processingAtMs, rollover.id);
  } else {
    assert.equal(stored.status, "processing");
  }
  database
    .prepare(`
      UPDATE free_agent_draft_rollovers
      SET status = 'completed',
          completed_at_ms = ?,
          last_error_code = NULL,
          updated_at_ms = ?,
          version = version + 1
      WHERE id = ?
    `)
    .run(completedAtMs, completedAtMs, rollover.id);
  settleJobRun(database, job, "succeeded", completedAtMs);
}

function recoveryRecord(ids, fixture, overrides = {}) {
  return {
    id: uuid(numericId(ids.league) + 800),
    league_id: ids.league,
    season_id: ids.targetSeason,
    fad_id: fixture.fad.id,
    player_id: fixture.allocation.player_id,
    allocation_id: fixture.allocation.id,
    rollover_id: null,
    auction_id: null,
    job_run_id: fixture.jobs.allocation.id,
    supersedes_recovery_id: null,
    causal_started_at_ms: null,
    kind: "allocation_retry",
    status: "pending",
    earliest_activation_at_ms: null,
    target_resolution_at_ms: null,
    last_error_code: "ALLOCATION_FAILED",
    commissioner_reason: null,
    created_by_operation_id: "fad-0026-recovery",
    resolved_by_user_id: null,
    resolved_by_membership_id: null,
    resolved_authority: null,
    created_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    updated_at_ms: CANDIDATE_DEADLINE_AT_MS + 20,
    resolved_at_ms: null,
    version: 1,
    ...overrides,
  };
}

function seedOrdinaryAuction(
  database,
  ids,
  {
    id = uuid(numericId(ids.league) + 900),
    playerId = uuid(numericId(ids.league) + 901),
    openedAtMs = 1_000,
    resolvesAtMs = 2_000,
  } = {}
) {
  seedPlayer(database, playerId);
  const auction = {
    id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    player_id: playerId,
    status: "open",
    opened_at_ms: openedAtMs,
    resolves_at_ms: resolvesAtMs,
    opened_by_user_id: ids.managerUser,
    created_at_ms: openedAtMs,
    updated_at_ms: openedAtMs,
    version: 1,
  };
  insert(database, "auctions", auction);
  return auction;
}

function insertCompletedBidIdempotency(
  database,
  ids,
  requestId,
  bidId,
  occurredAtMs,
  clientKey
) {
  insert(database, "idempotency_requests", {
    id: requestId,
    league_id: ids.league,
    actor_user_id: ids.managerUser,
    operation: "auction.bid.put",
    client_key: clientKey,
    request_hash: "a".repeat(64),
    status: "completed",
    result_type: "auction_bid",
    result_id: bidId,
    created_at_ms: occurredAtMs,
    completed_at_ms: occurredAtMs,
    expires_at_ms: occurredAtMs + DAY_MS,
  });
}

function auctionResolutionJobRecord(
  ids,
  auction,
  offset = 950
) {
  return jobRunRecord(
    ids,
    uuid(numericId(ids.league) + offset),
    "auction.resolve.target",
    `auction:${auction.id}:${auction.resolves_at_ms}`,
    auction.resolves_at_ms
  );
}

function seedWinnerResourcesAndResolution(
  database,
  ids,
  fixture,
  restricted,
  winnerBid,
  resolvedAtMs
) {
  const base = numericId(ids.league);
  const winnerTeamFixture =
    winnerBid.team_id === fixture.firstTeam.teamId
      ? fixture.firstTeam
      : fixture.secondTeam;
  const secondPriceInputCents = database
    .prepare(`
      SELECT MAX(
        (total_value_cents / term_years)
        + CASE
            WHEN
              (total_value_cents % term_years) * 2 >= term_years
            THEN 1
            ELSE 0
          END
      ) AS value
      FROM auction_bids
      WHERE league_id = ?
        AND auction_id = ?
        AND status = 'lost'
    `)
    .get(ids.league, restricted.auction.id).value;
  const resolution = {
    id: uuid(base + 960),
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: restricted.auction.id,
    scheduled_occurrence_key:
      `auction:${restricted.auction.id}:` +
      `${restricted.auction.resolves_at_ms}`,
    outcome_code: "winner",
    winning_team_id: winnerBid.team_id,
    winning_bid_id: winnerBid.id,
    highest_bid_cents: winnerBid.total_value_cents,
    second_price_input_cents: secondPriceInputCents,
    final_contract_value_cents: 600,
    winning_term_years: 2,
    final_aav_cents: 300,
    general_illegal: 0,
    warnings_json: "[]",
    contract_id: uuid(base + 961),
    ownership_id: uuid(base + 962),
    trigger_type: "automatic",
    triggered_by_user_id: null,
    idempotency_key: `fad-0026-resolution-${base}`,
    status: "resolved",
    resolved_at_ms: resolvedAtMs,
  };
  const futureSeasonId = uuid(base + 963);
  insert(database, "seasons", {
    id: futureSeasonId,
    league_id: ids.league,
    label: "2027-28",
    nhl_season_key: "20272028",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: resolvedAtMs,
    updated_at_ms: resolvedAtMs,
    version: 1,
  });
  insert(database, "contracts", {
    id: resolution.contract_id,
    league_id: ids.league,
    player_id: fixture.playerId,
    current_team_id: winnerBid.team_id,
    contract_type: "normal",
    original_total_value_cents: 600,
    original_term_years: 2,
    aav_cents: 300,
    start_season_id: ids.targetSeason,
    status: "active",
    acquisition_source_type: "auction_resolution",
    acquisition_source_id: resolution.id,
    auction_buyout_lock_expires_at_ms:
      resolvedAtMs + 14 * DAY_MS,
    created_at_ms: resolvedAtMs,
    updated_at_ms: resolvedAtMs,
    version: 1,
  });
  insert(database, "contract_years", {
    id: uuid(base + 964),
    league_id: ids.league,
    contract_id: resolution.contract_id,
    season_id: ids.targetSeason,
    year_number: 1,
    aav_cents: 300,
    status: "current",
    rollover_at_ms: null,
    created_at_ms: resolvedAtMs,
  });
  insert(database, "contract_years", {
    id: uuid(base + 965),
    league_id: ids.league,
    contract_id: resolution.contract_id,
    season_id: futureSeasonId,
    year_number: 2,
    aav_cents: 300,
    status: "future",
    rollover_at_ms: null,
    created_at_ms: resolvedAtMs,
  });
  insert(database, "player_ownerships", {
    id: resolution.ownership_id,
    league_id: ids.league,
    season_id: ids.targetSeason,
    player_id: fixture.playerId,
    team_id: winnerBid.team_id,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number:
      winnerTeamFixture.candidateSnapshotEntry.slot_number,
    acquired_transaction_type: "auction_resolution",
    acquired_transaction_id: resolution.id,
    created_at_ms: resolvedAtMs,
    updated_at_ms: resolvedAtMs,
    version: 1,
  });
  insert(database, "contract_events", {
    id: uuid(base + 966),
    league_id: ids.league,
    contract_id: resolution.contract_id,
    player_id: fixture.playerId,
    team_id: winnerBid.team_id,
    actor_user_id: null,
    event_type: "auction_contract_created",
    source_type: "auction_resolution",
    source_id: resolution.id,
    metadata_json: "{}",
    reason: null,
    occurred_at_ms: resolvedAtMs,
  });
  insert(database, "ownership_events", {
    id: uuid(base + 967),
    league_id: ids.league,
    season_id: ids.targetSeason,
    player_id: fixture.playerId,
    team_id: winnerBid.team_id,
    ownership_id: resolution.ownership_id,
    event_type: "auction_player_acquired",
    actor_user_id: null,
    source_type: "auction_resolution",
    source_id: resolution.id,
    before_metadata_json: "{}",
    after_metadata_json: "{}",
    reason: null,
    occurred_at_ms: resolvedAtMs,
  });
  insert(database, "auction_resolutions", resolution);
  insert(database, "auction_events", {
    id: uuid(base + 968),
    league_id: ids.league,
    season_id: ids.targetSeason,
    auction_id: restricted.auction.id,
    bid_id: winnerBid.id,
    team_id: winnerBid.team_id,
    actor_user_id: null,
    event_type: "auction_resolved",
    metadata_json: "{}",
    occurred_at_ms: resolvedAtMs,
  });
  return { resolution, winnerTeamFixture };
}

function revealDraw(
  database,
  draw,
  {
    orderedBidIds,
    orderedTeamIds,
    counter,
    selectedIndex,
    selectedBidId,
    selectedTeamId,
    digestHex,
    revealedAtMs,
  },
  overrides = {}
) {
  const next = {
    ...draw,
    ordered_tied_bid_ids_json: JSON.stringify(orderedBidIds),
    ordered_tied_team_ids_json: JSON.stringify(
      orderedTeamIds
    ),
    rejection_counter: counter,
    selected_index: selectedIndex,
    selected_bid_id: selectedBidId,
    selected_team_id: selectedTeamId,
    selected_digest_hex: digestHex,
    revealed_at_ms: revealedAtMs,
    updated_at_ms: revealedAtMs,
    version: draw.version + 1,
    ...overrides,
  };
  database
    .prepare(`
      UPDATE free_agent_draft_draws
      SET algorithm_version = @algorithm_version,
          nonce_bytes = @nonce_bytes,
          commitment_hex = @commitment_hex,
          ordered_tied_bid_ids_json =
            @ordered_tied_bid_ids_json,
          ordered_tied_team_ids_json =
            @ordered_tied_team_ids_json,
          rejection_counter = @rejection_counter,
          selected_index = @selected_index,
          selected_bid_id = @selected_bid_id,
          selected_team_id = @selected_team_id,
          selected_digest_hex = @selected_digest_hex,
          revealed_at_ms = @revealed_at_ms,
          created_at_ms = @created_at_ms,
          updated_at_ms = @updated_at_ms,
          version = @version
      WHERE id = @id
    `)
    .run(next);
  return next;
}

function terminalizeRestrictedWinnerBids(
  database,
  bids,
  winnerBidId,
  invalidBidIds = []
) {
  const winnerBid = bids.find(({ id }) => id === winnerBidId);
  assert.ok(winnerBid, "restricted winner bid must exist");
  const invalidBidIdSet = new Set(invalidBidIds);
  const updateStatus = database.prepare(`
    UPDATE auction_bids
    SET status = ?,
        version = version + 1
    WHERE id = ?
  `);
  updateStatus.run("won", winnerBid.id);
  for (const bid of bids) {
    if (bid.id === winnerBid.id) continue;
    updateStatus.run(
      invalidBidIdSet.has(bid.id) ? "invalid" : "lost",
      bid.id
    );
  }
}

describe(
  "FAD-01.4 auction context, participant, seed, and draw storage",
  () => {
    test("installs fresh and upgrades populated schema 25 with exact ordinary-auction backfill", (t) => {
      const fresh = createRuntime(t, "hundo-fad-0026-fresh-");
      copyMigrationsThrough(fresh, 26);
      const freshResult = migrate(fresh, "fad-0026-fresh");

      assert.equal(freshResult.status, "exact");
      assert.equal(freshResult.applied.length, 26);
      assert.equal(
        fresh.database.pragma("user_version", { simple: true }),
        26
      );
      assert.equal(
        fresh.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "26"
      );
      assert.deepEqual(
        fresh.database
          .prepare(`
            SELECT migration_id, file_name
            FROM schema_migrations
            ORDER BY migration_id DESC
            LIMIT 1
          `)
          .get(),
        {
          migration_id: 26,
          file_name:
            "0026_add_fad_auction_contexts_participants_and_draws.sql",
        }
      );
      for (const tableName of NEW_TABLES) {
        assert.equal(
          fresh.database
            .pragma("table_list")
            .find(({ name }) => name === tableName)?.strict,
          1
        );
        assert.equal(
          fresh.database
            .prepare(
              `SELECT COUNT(*) AS count FROM ${tableName}`
            )
            .get().count,
          0
        );
      }

      const upgrade = createRuntime(
        t,
        "hundo-fad-0026-upgrade-"
      );
      copyMigrationsThrough(upgrade, 25);
      migrate(upgrade, "fad-0026-before");
      const firstLeague = seedLeague(upgrade.database, {
        base: 1_000,
        leagueName: "First ordinary league",
      });
      const secondLeague = seedLeague(upgrade.database, {
        base: 2_000,
        leagueName: "Second ordinary league",
      });
      const firstAuction = seedOrdinaryAuction(
        upgrade.database,
        firstLeague
      );
      const secondAuction = seedOrdinaryAuction(
        upgrade.database,
        secondLeague
      );
      const preservedTables = [
        "auctions",
        "candidate_card_revisions",
        "free_agent_draft_player_allocations",
        "free_agent_drafts",
        "free_agent_draft_rollovers",
        "seasons",
      ];
      const before = readTables(
        upgrade.database,
        preservedTables
      );

      copyMigrationsThrough(upgrade, 26);
      const upgradeResult = migrate(
        upgrade,
        "fad-0026-upgrade"
      );

      assert.equal(upgradeResult.status, "exact");
      assert.equal(
        upgrade.database.pragma("user_version", {
          simple: true,
        }),
        26
      );
      assert.deepEqual(
        readTables(upgrade.database, preservedTables),
        before
      );
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT
              id,
              league_id,
              season_id,
              auction_id,
              source_kind,
              fad_id,
              fad_rollover_id,
              fad_allocation_id,
              created_at_ms
            FROM auction_contexts
            ORDER BY league_id, auction_id
          `)
          .all(),
        [
          [firstLeague, firstAuction],
          [secondLeague, secondAuction],
        ]
          .map(([ids, auction]) => ({
            id: auction.id,
            league_id: ids.league,
            season_id: ids.targetSeason,
            auction_id: auction.id,
            source_kind: "ordinary_weekly",
            fad_id: null,
            fad_rollover_id: null,
            fad_allocation_id: null,
            created_at_ms: auction.created_at_ms,
          }))
          .sort((left, right) =>
            left.league_id.localeCompare(right.league_id)
          )
      );
      assert.equal(
        upgrade.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_auction_participants
          `)
          .get().count,
        0
      );
      assert.equal(
        upgrade.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_draws
          `)
          .get().count,
        0
      );
      upgrade.database
        .prepare(`
          UPDATE auctions
          SET updated_at_ms = updated_at_ms + 1,
              version = version + 1
          WHERE id = ?
        `)
        .run(firstAuction.id);
      assert.deepEqual(
        upgrade.database
          .prepare(`
            SELECT status, updated_at_ms, version
            FROM auctions
            WHERE id = ?
          `)
          .get(firstAuction.id),
        {
          status: "open",
          updated_at_ms: firstAuction.updated_at_ms + 1,
          version: 2,
        }
      );
      assert.equal(
        upgrade.database.pragma("integrity_check", {
          simple: true,
        }),
        "ok"
      );
      assert.deepEqual(
        upgrade.database.pragma("foreign_key_check"),
        []
      );
    });

    test("refuses to guess provenance for a schema-25 auction already linked to FAD state", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-provenance-guard-"
      );
      copyMigrationsThrough(runtime, 25);
      migrate(runtime, "fad-0026-provenance-before");
      const ids = seedLeague(runtime.database, {
        base: 3_000,
        secondTeam: true,
        leagueName: "Guarded FAD league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(30_000)
      );
      const auction = auctionRecord(ids, fixture);
      insert(runtime.database, "auctions", auction);
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_active",
          decision_code: "exact_total_and_term_tie",
          restricted_auction_id: auction.id,
          resolved_at_ms: auction.opened_at_ms,
          updated_at_ms: auction.opened_at_ms,
        }
      );
      insertRestrictedAllocationEvents(
        runtime.database,
        ids,
        fixture,
        fixture.allocation
      );
      const before = readTables(runtime.database, [
        "auctions",
        "free_agent_draft_allocation_events",
        "free_agent_draft_player_allocations",
      ]);

      copyMigrationsThrough(runtime, 26);
      assert.throws(
        () => {
          migrate(runtime, "fad-0026-provenance-guard");
        },
        /migration failed and was rolled back/i
      );

      assert.equal(
        runtime.database.pragma("user_version", {
          simple: true,
        }),
        25
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT metadata_value
            FROM application_metadata
            WHERE metadata_key = 'data_model_version'
          `)
          .get().metadata_value,
        "25"
      );
      assert.equal(
        runtime.database
          .pragma("table_list")
          .some(({ name }) => name === "auction_contexts"),
        false
      );
      assert.deepEqual(
        readTables(runtime.database, Object.keys(before)),
        before
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

    test("enforces the exact context matrix, timing, immutability, and same-league scope", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-contexts-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-contexts");
      const ids = seedLeague(runtime.database, {
        base: 4_000,
        secondTeam: true,
        leagueName: "Context matrix league",
      });
      const otherIds = seedLeague(runtime.database, {
        base: 5_000,
        leagueName: "Context isolation league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(40_000)
      );
      const mismatchedCreationAuction = auctionRecord(
        ids,
        fixture,
        {
          id: uuid(40_750),
          created_at_ms: RESTRICTED_OPENED_AT_MS + 1,
          updated_at_ms: RESTRICTED_OPENED_AT_MS + 1,
        }
      );
      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "auctions",
          mismatchedCreationAuction
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_contexts",
              contextRecord(
                ids,
                fixture,
                mismatchedCreationAuction,
                {
                  created_at_ms:
                    mismatchedCreationAuction.created_at_ms,
                }
              )
            );
          },
          /creation chronology|created.*opened|creation and opening timestamps/i
        );
      });
      const backdatedActivationAuction = auctionRecord(
        ids,
        fixture,
        {
          id: uuid(40_751),
          opened_at_ms: RESTRICTED_OPENED_AT_MS - 1,
          created_at_ms: RESTRICTED_OPENED_AT_MS - 1,
          updated_at_ms: RESTRICTED_OPENED_AT_MS - 1,
        }
      );
      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "auctions",
          backdatedActivationAuction
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_contexts",
              contextRecord(
                ids,
                fixture,
                backdatedActivationAuction
              )
            );
          },
          /activation chronology|causal job chronology|exact allocation and activation window/i
        );
      });
      const restrictedAuction = auctionRecord(ids, fixture);
      const restrictedContext = contextRecord(
        ids,
        fixture,
        restrictedAuction
      );
      insert(runtime.database, "auctions", restrictedAuction);

      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...restrictedContext,
            fad_rollover_id: null,
          });
        },
        /restricted context requires its exact allocation and activation window/i
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...restrictedContext,
            fad_rollover_id: fixture.rollovers[1].id,
          });
        },
        /restricted context requires its exact allocation and activation window/i
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...restrictedContext,
            source_kind: "ordinary_weekly",
          });
        },
        /CHECK constraint|auction_contexts/i
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...restrictedContext,
            league_id: otherIds.league,
            season_id: otherIds.targetSeason,
          });
        },
        /same-season auction creation|FOREIGN KEY/i
      );

      insert(
        runtime.database,
        "auction_contexts",
        restrictedContext
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture,
        {
          auction: restrictedAuction,
          context: restrictedContext,
          auctionAlreadyInserted: true,
          contextAlreadyInserted: true,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT source_kind
            FROM auction_contexts
            WHERE auction_id = ?
          `)
          .get(restrictedAuction.id).source_kind,
        "fad_restricted"
      );
      assert.equal(fixture.allocation.status, "restricted_active");
      assert.equal(
        fixture.allocation.restricted_auction_id,
        restrictedAuction.id
      );
      assert.equal(restricted.participants.length, 2);
      assert.equal(restricted.bids.length, 2);

      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...restrictedContext,
          });
        },
        /UNIQUE constraint|restricted context requires its exact allocation and activation window/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE auction_contexts
              SET source_kind = 'ordinary_weekly',
                  fad_id = NULL,
                  fad_rollover_id = NULL,
                  fad_allocation_id = NULL
              WHERE id = ?
            `)
            .run(restrictedContext.id);
        },
        /auction context is immutable/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM auction_contexts WHERE id = ?
            `)
            .run(restrictedContext.id);
        },
        /auction context is immutable/i
      );

      finishRapid(runtime.database, fixture);
      const openRapidAuction = seedOrdinaryAuction(
        runtime.database,
        ids,
        {
          id: uuid(40_910),
          playerId: uuid(40_911),
          openedAtMs: RESTRICTED_OPENED_AT_MS + 100,
          resolvesAtMs:
            fixture.rollovers[0].rolls_over_at_ms,
        }
      );
      const openRapidContext = {
        id: openRapidAuction.id,
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: openRapidAuction.id,
        source_kind: "fad_open_rapid",
        fad_id: fixture.fad.id,
        fad_rollover_id: fixture.rollovers[0].id,
        fad_allocation_id: null,
        created_at_ms: openRapidAuction.created_at_ms,
      };
      insert(
        runtime.database,
        "auction_contexts",
        openRapidContext
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              source_kind,
              fad_id,
              fad_rollover_id,
              fad_allocation_id
            FROM auction_contexts
            WHERE auction_id = ?
          `)
          .get(openRapidAuction.id),
        {
          source_kind: "fad_open_rapid",
          fad_id: fixture.fad.id,
          fad_rollover_id: fixture.rollovers[0].id,
          fad_allocation_id: null,
        }
      );

      const cutoffAuction = seedOrdinaryAuction(
        runtime.database,
        ids,
        {
          id: uuid(40_920),
          playerId: uuid(40_921),
          openedAtMs:
            fixture.rollovers[0].creation_cutoff_at_ms,
          resolvesAtMs:
            fixture.rollovers[0].rolls_over_at_ms,
        }
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...openRapidContext,
            id: cutoffAuction.id,
            auction_id: cutoffAuction.id,
            created_at_ms: cutoffAuction.created_at_ms,
          });
        },
        /exact active FAD rollover window/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "auction_bids",
            bidRecord(
              ids,
              fixture,
              cutoffAuction,
              fixture.firstTeam,
              923
            )
          );
        },
        /auction bid requires auction context/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE auctions
              SET updated_at_ms = updated_at_ms + 1,
                  version = version + 1
              WHERE id = ?
            `)
            .run(cutoffAuction.id);
        },
        /auction mutation requires auction context/i
      );

      const wrongBoundaryAuction = seedOrdinaryAuction(
        runtime.database,
        ids,
        {
          id: uuid(40_930),
          playerId: uuid(40_931),
          openedAtMs: RESTRICTED_OPENED_AT_MS + 200,
          resolvesAtMs:
            fixture.rollovers[0].rolls_over_at_ms + 1,
        }
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...openRapidContext,
            id: wrongBoundaryAuction.id,
            auction_id: wrongBoundaryAuction.id,
            created_at_ms:
              wrongBoundaryAuction.created_at_ms,
          });
        },
        /exact active FAD rollover window/i
      );

      const failureAtMs = openRapidAuction.resolves_at_ms;
      const recoveryAtMs = failureAtMs + 10;
      const openRapidResolutionJob =
        auctionResolutionJobRecord(
          ids,
          openRapidAuction,
          940
        );
      insert(
        runtime.database,
        "job_runs",
        openRapidResolutionJob
      );
      leaseJob(
        runtime.database,
        openRapidResolutionJob,
        failureAtMs
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'failed',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(failureAtMs, openRapidAuction.id);
      const openRapidRecovery = recoveryRecord(
        ids,
        fixture,
        {
          id: uuid(40_941),
          player_id: openRapidAuction.player_id,
          allocation_id: null,
          rollover_id: fixture.rollovers[0].id,
          auction_id: openRapidAuction.id,
          job_run_id: openRapidResolutionJob.id,
          kind: "auction_resolution",
          status: "correction_required",
          last_error_code: "AUCTION_FAILED",
          created_by_operation_id:
            "fad-0026-open-rapid-failure",
          created_at_ms: failureAtMs,
          updated_at_ms: failureAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        openRapidRecovery
      );
      const openRapidFailureEvent = {
        id: uuid(40_940),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: openRapidAuction.id,
        bid_id: null,
        team_id: null,
        actor_user_id: null,
        event_type: "fad_auction_resolution_failed",
        metadata_json: JSON.stringify({
          recoveryId: openRapidRecovery.id,
          jobRunId: openRapidResolutionJob.id,
          errorCode: "AUCTION_FAILED",
        }),
        occurred_at_ms: failureAtMs,
      };
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_events",
              openRapidFailureEvent
            );
          },
          /FAD operational failure requires its exact system failure event/i
        );
      });
      settleJobRun(
        runtime.database,
        openRapidResolutionJob,
        "failed",
        failureAtMs,
        "AUCTION_FAILED"
      );
      insert(
        runtime.database,
        "auction_events",
        openRapidFailureEvent
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(openRapidAuction.id).count,
        0
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE auctions
              SET status = 'cancelled',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(recoveryAtMs, openRapidAuction.id);
        },
        /running recovery|recovery lease|active lease/i
      );
      leaseJob(
        runtime.database,
        openRapidResolutionJob,
        recoveryAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(recoveryAtMs, openRapidRecovery.id);
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'cancelled',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(recoveryAtMs, openRapidAuction.id);
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE free_agent_draft_recoveries
                SET status = 'resolved',
                    resolved_authority = 'system',
                    resolved_at_ms = ?,
                    updated_at_ms = ?,
                    version = 3
                WHERE id = ?
              `)
              .run(
                recoveryAtMs,
                recoveryAtMs,
                openRapidRecovery.id
              );
          },
          /exact immutable result|exact terminal evidence chain/i
        );
      });
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(openRapidRecovery.id).status,
        "running"
      );
      const recoveredResolution = {
        id: uuid(40_942),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: openRapidAuction.id,
        scheduled_occurrence_key:
          `auction:${openRapidAuction.id}:` +
          `${openRapidAuction.resolves_at_ms}`,
        outcome_code: "recovered",
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
        trigger_type: "commissioner",
        triggered_by_user_id: ids.commissionerUser,
        idempotency_key:
          "fad-0026-open-rapid-recovered",
        status: "cancelled",
        resolved_at_ms: recoveryAtMs,
      };
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_resolutions",
              {
                ...recoveredResolution,
                outcome_code: "season_closed",
              }
            );
          },
          /failed open rapid.*recovered|recovery.*outcome|exact recovered cancellation|recovered cancellation requires exact failure recovery/i
        );
      });
      insert(
        runtime.database,
        "auction_resolutions",
        recoveredResolution
      );
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE free_agent_draft_recoveries
                SET status = 'resolved',
                    resolved_authority = 'system',
                    resolved_at_ms = ?,
                    updated_at_ms = ?,
                    version = 3
                WHERE id = ?
              `)
              .run(
                recoveryAtMs + 1,
                recoveryAtMs + 1,
                openRapidRecovery.id
              );
          },
          /exact immutable result|exact terminal evidence chain/i
        );
      });
      insert(runtime.database, "auction_events", {
        id: uuid(40_943),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: openRapidAuction.id,
        bid_id: null,
        team_id: null,
        actor_user_id: ids.commissionerUser,
        event_type: "auction_cancelled",
        metadata_json: "{}",
        occurred_at_ms: recoveryAtMs,
      });
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          recoveryAtMs,
          recoveryAtMs,
          openRapidRecovery.id
        );
      settleJobRun(
        runtime.database,
        openRapidResolutionJob,
        "succeeded",
        recoveryAtMs
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, outcome_code, resolved_at_ms
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(openRapidAuction.id),
        {
          status: "cancelled",
          outcome_code: "recovered",
          resolved_at_ms: recoveryAtMs,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(openRapidRecovery.id).status,
        "resolved"
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

    test("activates deferred restricted recovery after FAD completion without reusing a rapid rollover", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-deferred-context-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-deferred-context");
      const ids = seedLeague(runtime.database, {
        base: 9_000,
        secondTeam: true,
        leagueName: "Deferred restricted context league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(90_000)
      );
      const deferredAtMs =
        fixture.rollovers[6].creation_cutoff_at_ms;
      leaseJob(
        runtime.database,
        fixture.jobs.allocation,
        deferredAtMs
      );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "deferred_restricted_recovery",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: deferredAtMs,
          last_error_code: "FAIR_WINDOW_UNAVAILABLE",
          updated_at_ms: deferredAtMs,
        }
      );
      insertRestrictedAllocationEvents(
        runtime.database,
        ids,
        fixture,
        fixture.allocation,
        20,
        "decision_recorded"
      );

      const activationAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + DAY_MS;
      const resolutionAtMs = activationAtMs + DAY_MS;
      const activationJob = jobRunRecord(
        ids,
        uuid(9_980),
        "fad_restricted_activation",
        `fad:${fixture.fad.id}:restricted-activate:` +
          `${fixture.allocation.id}:${activationAtMs}`,
        activationAtMs
      );
      insert(runtime.database, "job_runs", activationJob);
      const deferredRecovery = recoveryRecord(
        ids,
        fixture,
        {
          id: uuid(9_981),
          job_run_id: activationJob.id,
          kind: "deferred_restricted",
          earliest_activation_at_ms: activationAtMs,
          target_resolution_at_ms: resolutionAtMs,
          last_error_code: "FAIR_WINDOW_UNAVAILABLE",
          created_by_operation_id:
            "fad-0026-deferred-activation",
          created_at_ms: deferredAtMs,
          updated_at_ms: deferredAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        deferredRecovery
      );
      finishRapid(
        runtime.database,
        fixture,
        deferredAtMs + 1
      );
      for (const rollover of fixture.rollovers) {
        completeFadRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const fadCompletedAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        FIRST_MATCHUP_STARTS_AT_MS + 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          fadCompletedAtMs,
          fadCompletedAtMs,
          fixture.fad.id
        );
      settleJobRun(
        runtime.database,
        fixture.jobs.completion,
        "succeeded",
        fadCompletedAtMs
      );

      leaseJob(
        runtime.database,
        activationJob,
        activationAtMs
      );
      inRolledBackSavepoint(runtime.database, () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            activationAtMs + 1,
            deferredRecovery.id
          );
        const staleRecoveryAuction = auctionRecord(
          ids,
          fixture,
          {
            id: uuid(9_990),
            opened_at_ms: activationAtMs,
            resolves_at_ms: resolutionAtMs,
            created_at_ms: activationAtMs,
            updated_at_ms: activationAtMs,
          }
        );
        insert(
          runtime.database,
          "auctions",
          staleRecoveryAuction
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_contexts",
              contextRecord(
                ids,
                fixture,
                staleRecoveryAuction,
                { fad_rollover_id: null }
              )
            );
          },
          /activation chronology|exact allocation and activation window/i
        );
      });
      inRolledBackSavepoint(runtime.database, () => {
        runtime.database
          .prepare(`
            UPDATE job_runs
            SET updated_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(activationAtMs + 1, activationJob.id);
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'running',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(activationAtMs, deferredRecovery.id);
        const staleJobAuction = auctionRecord(
          ids,
          fixture,
          {
            id: uuid(9_991),
            opened_at_ms: activationAtMs,
            resolves_at_ms: resolutionAtMs,
            created_at_ms: activationAtMs,
            updated_at_ms: activationAtMs,
          }
        );
        insert(runtime.database, "auctions", staleJobAuction);
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_contexts",
              contextRecord(
                ids,
                fixture,
                staleJobAuction,
                { fad_rollover_id: null }
              )
            );
          },
          /activation chronology|exact allocation and activation window/i
        );
      });
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(activationAtMs, deferredRecovery.id);
      const auction = auctionRecord(ids, fixture, {
        opened_at_ms: activationAtMs,
        resolves_at_ms: resolutionAtMs,
        created_at_ms: activationAtMs,
        updated_at_ms: activationAtMs,
      });
      const context = contextRecord(
        ids,
        fixture,
        auction,
        { fad_rollover_id: null }
      );
      insert(runtime.database, "auctions", auction);
      assertConstraint(
        () => {
          insert(runtime.database, "auction_contexts", {
            ...context,
            fad_rollover_id: fixture.rollovers[6].id,
          });
        },
        /restricted context requires its exact allocation and activation window/i
      );
      insert(runtime.database, "auction_contexts", context);
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture,
        {
          auction,
          context,
          auctionAlreadyInserted: true,
          contextAlreadyInserted: true,
        }
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          activationAtMs + 1,
          activationAtMs + 1,
          deferredRecovery.id
        );

      assert.equal(
        restricted.context.fad_rollover_id,
        null
      );
      assert.equal(
        fixture.allocation.status,
        "restricted_active"
      );
      assert.equal(
        fixture.allocation.restricted_auction_id,
        auction.id
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT source_kind, fad_rollover_id
            FROM auction_contexts
            WHERE id = ?
          `)
          .get(context.id),
        {
          source_kind: "fad_restricted",
          fad_rollover_id: null,
        }
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

    test("requires canonical abnormal terminal evidence and preserves correction recovery through completion", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-correction-terminal-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-correction-terminal");
      const ids = seedLeague(runtime.database, {
        base: 10_000,
        secondTeam: true,
        leagueName: "Restricted correction league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(100_000)
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      finishRapid(runtime.database, fixture);
      const resolvedAtMs =
        restricted.auction.resolves_at_ms;
      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      const recovery = recoveryRecord(ids, fixture, {
        rollover_id: fixture.rollovers[0].id,
        auction_id: restricted.auction.id,
        job_run_id: resolutionJob.id,
        kind: "auction_resolution",
        status: "correction_required",
        last_error_code: "RESTRICTED_AUCTION_CANCELLED",
        created_by_operation_id:
          "fad-0026-restricted-cancelled",
        created_at_ms: resolvedAtMs,
        updated_at_ms: resolvedAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      assertConstraint(
        () => {
          updateAllocation(
            runtime.database,
            fixture.allocation,
            {
              status: "correction_required",
              decision_code: "exact_total_and_term_tie",
              resolved_at_ms: resolvedAtMs,
              last_error_code:
                "RESTRICTED_AUCTION_CANCELLED",
              updated_at_ms: resolvedAtMs,
            }
          );
        },
        /restricted correction requires exact cancelled or failed evidence|cancelled or failed terminal evidence/i
      );

      leaseJob(
        runtime.database,
        resolutionJob,
        resolvedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'cancelled',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(resolvedAtMs, restricted.auction.id);
      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        {
          orderedBidIds: [],
          orderedTeamIds: [],
          counter: null,
          selectedIndex: null,
          selectedBidId: null,
          selectedTeamId: null,
          digestHex: null,
          revealedAtMs: resolvedAtMs,
        }
      );
      const resolution = {
        id: uuid(10_960),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: restricted.auction.id,
        scheduled_occurrence_key:
          `auction:${restricted.auction.id}:` +
          `${restricted.auction.resolves_at_ms}`,
        outcome_code: "failed",
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
        trigger_type: "commissioner",
        triggered_by_user_id: ids.commissionerUser,
        idempotency_key:
          "fad-0026-restricted-cancelled-resolution",
        status: "cancelled",
        resolved_at_ms: resolvedAtMs,
      };
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_resolutions",
              resolution
            );
          },
          /cancelled.*participant bid|participant bid.*cancelled|complete exact bid status set/i
        );
      });
      for (const bid of restricted.bids) {
        runtime.database
          .prepare(`
            UPDATE auction_bids
            SET status = 'cancelled',
                version = version + 1
            WHERE id = ?
          `)
          .run(bid.id);
      }
      assertConstraint(
        () => {
          insert(runtime.database, "auction_resolutions", {
            ...resolution,
            outcome_code: "recovered",
          });
        },
        /restricted result requires matching terminal draw and result evidence/i
      );
      insert(runtime.database, "auction_resolutions", resolution);
      insert(runtime.database, "auction_events", {
        id: uuid(10_968),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: restricted.auction.id,
        bid_id: null,
        team_id: null,
        actor_user_id: ids.commissionerUser,
        event_type: "auction_cancelled",
        metadata_json: "{}",
        occurred_at_ms: resolvedAtMs,
      });
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: resolvedAtMs,
          last_error_code:
            "RESTRICTED_AUCTION_CANCELLED",
          updated_at_ms: resolvedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(10_880),
            event_kind: "restricted_state_changed",
          }
        )
      );
      const firstRollover = fixture.rollovers[0];
      const firstRolloverJob =
        fixture.jobs["rollover-1"];
      const processingAtMs =
        firstRollover.rolls_over_at_ms + 1;
      const completedAtMs =
        firstRollover.rolls_over_at_ms + 2;
      leaseJob(
        runtime.database,
        firstRolloverJob,
        processingAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          processingAtMs,
          processingAtMs,
          firstRollover.id
        );
      const rolloverRecovery = recoveryRecord(ids, fixture, {
        id: uuid(10_801),
        player_id: null,
        allocation_id: null,
        rollover_id: firstRollover.id,
        auction_id: null,
        job_run_id: firstRolloverJob.id,
        kind: "rollover_finalize",
        status: "pending",
        last_error_code: "RESTRICTED_AUCTION_CANCELLED",
        created_by_operation_id:
          "fad-0026-rollover-cancelled-auction",
        created_at_ms: processingAtMs,
        updated_at_ms: processingAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        rolloverRecovery
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              completedAtMs,
              completedAtMs,
              firstRollover.id
            );
        },
        /unresolved recovery cannot complete normally|FAD rollover requires each resolved auction job to succeed/i
      );
      assert.doesNotThrow(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'recovery_required',
                  completed_at_ms = ?,
                  last_error_code =
                    'RESTRICTED_AUCTION_CANCELLED',
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              completedAtMs,
              completedAtMs,
              firstRollover.id
            );
        },
        "canonical abnormal auction should permit a recovery-required rollover"
      );
      settleJobRun(
        runtime.database,
        firstRolloverJob,
        "failed",
        completedAtMs,
        "RESTRICTED_AUCTION_CANCELLED"
      );
      for (const rollover of fixture.rollovers.slice(1)) {
        completeFadRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const fadCompletedAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        FIRST_MATCHUP_STARTS_AT_MS + 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          fadCompletedAtMs,
          fadCompletedAtMs,
          fixture.fad.id
        );
      settleJobRun(
        runtime.database,
        fixture.jobs.completion,
        "succeeded",
        fadCompletedAtMs
      );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              status,
              decision_code,
              last_error_code
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(fixture.allocation.id),
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          last_error_code:
            "RESTRICTED_AUCTION_CANCELLED",
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, outcome_code
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id),
        {
          status: "cancelled",
          outcome_code: "failed",
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, completed_at_ms
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id),
        {
          status: "completed",
          completed_at_ms: fadCompletedAtMs,
        }
      );
      const correctionAtMs = fadCompletedAtMs + HOUR_MS;
      const resolveCancellationRecovery = () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_recoveries
            SET status = 'resolved',
                resolved_by_user_id = ?,
                resolved_by_membership_id = ?,
                resolved_authority = 'commissioner',
                commissioner_reason = ?,
                resolved_at_ms = ?,
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            ids.commissionerUser,
            ids.commissionerMembership,
            "The indexed allocation correction resolves this recovery.",
            correctionAtMs,
            correctionAtMs,
            recovery.id
          );
      };
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          resolveCancellationRecovery,
          /causal state is terminal|exact correction evidence/i
        );
      });
      const correctionId = uuid(10_969);
      assert.doesNotThrow(
        () => {
          insert(runtime.database, "commissioner_corrections", {
            id: correctionId,
            league_id: ids.league,
            season_id: ids.targetSeason,
            feature: "free_agent_draft_allocation",
            feature_record_id: fixture.allocation.id,
            actor_user_id: ids.commissionerUser,
            reason:
              "Resolve the cancelled restricted auction without an award.",
            before_snapshot_json: "{}",
            after_snapshot_json: "{}",
            corrected_at_ms: correctionAtMs,
          });
        },
        "the indexed commissioner correction should be accepted"
      );
      assert.doesNotThrow(
        () => {
          fixture.allocation = updateAllocation(
            runtime.database,
            fixture.allocation,
            {
              status: "restricted_resolved",
              decision_code: "corrected",
              winning_snapshot_entry_id: null,
              winning_team_id: null,
              contract_id: null,
              ownership_id: null,
              restricted_auction_id: restricted.auction.id,
              resolved_at_ms: correctionAtMs,
              last_error_code: null,
              updated_at_ms: correctionAtMs,
            }
          );
        },
        "the indexed restricted allocation correction should be accepted"
      );
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          resolveCancellationRecovery,
          /exact correction evidence/i
        );
      });
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(10_970),
            event_kind: "correction_applied",
            correction_id: correctionId,
            actor_user_id: ids.commissionerUser,
            actor_membership_id:
              ids.commissionerMembership,
            actor_authority: "commissioner",
            occurred_at_ms: correctionAtMs,
            created_at_ms: correctionAtMs,
          }
        )
      );
      resolveCancellationRecovery();
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        correctionAtMs
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              status,
              decision_code,
              last_error_code,
              resolved_at_ms
            FROM free_agent_draft_player_allocations
            WHERE id = ?
          `)
          .get(fixture.allocation.id),
        {
          status: "restricted_resolved",
          decision_code: "corrected",
          last_error_code: null,
          resolved_at_ms: correctionAtMs,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              status,
              resolved_authority,
              resolved_at_ms
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(recovery.id),
        {
          status: "resolved",
          resolved_authority: "commissioner",
          resolved_at_ms: correctionAtMs,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, outcome_code, resolved_at_ms
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id),
        {
          status: "cancelled",
          outcome_code: "failed",
          resolved_at_ms: resolvedAtMs,
        }
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

    test("accounts a restricted operational failure without fabricating a result and later retries exactly", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-restricted-failure-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-restricted-failure");
      const ids = seedLeague(runtime.database, {
        base: 12_000,
        secondTeam: true,
        leagueName: "Restricted operational failure league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(120_000)
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      finishRapid(runtime.database, fixture);
      const failureAtMs =
        restricted.auction.resolves_at_ms;
      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        failureAtMs
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'failed',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(failureAtMs, restricted.auction.id);
      const recovery = recoveryRecord(ids, fixture, {
        rollover_id: fixture.rollovers[0].id,
        auction_id: restricted.auction.id,
        job_run_id: resolutionJob.id,
        kind: "auction_resolution",
        status: "correction_required",
        last_error_code: "AUCTION_FAILED",
        created_by_operation_id:
          "fad-0026-restricted-operational-failure",
        created_at_ms: failureAtMs,
        updated_at_ms: failureAtMs,
      });
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recovery
      );
      const failureEvent = {
        id: uuid(12_940),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: restricted.auction.id,
        bid_id: null,
        team_id: null,
        actor_user_id: null,
        event_type: "fad_auction_resolution_failed",
        metadata_json: JSON.stringify({
          recoveryId: recovery.id,
          jobRunId: resolutionJob.id,
          errorCode: "AUCTION_FAILED",
        }),
        occurred_at_ms: failureAtMs,
      };
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_events",
              failureEvent
            );
          },
          /FAD operational failure requires its exact system failure event/i
        );
      });
      settleJobRun(
        runtime.database,
        resolutionJob,
        "failed",
        failureAtMs,
        "AUCTION_FAILED"
      );
      insert(
        runtime.database,
        "auction_events",
        failureEvent
      );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "correction_required",
          decision_code: "exact_total_and_term_tie",
          resolved_at_ms: failureAtMs,
          last_error_code: "AUCTION_FAILED",
          updated_at_ms: failureAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(12_880),
            event_kind: "restricted_state_changed",
          }
        )
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id).count,
        0
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              revealed_at_ms,
              ordered_tied_bid_ids_json,
              version
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(restricted.draw.id),
        {
          revealed_at_ms: null,
          ordered_tied_bid_ids_json: null,
          version: 1,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status
            FROM auction_bids
            WHERE auction_id = ?
            ORDER BY id
          `)
          .all(restricted.auction.id),
        [{ status: "active" }, { status: "active" }]
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE auction_bids
              SET status = 'lost',
                  version = version + 1
              WHERE id = ?
            `)
            .run(restricted.bids[0].id);
        },
        /revealed draw|terminal restricted bid|terminal draw reveal/i
      );

      const firstRollover = fixture.rollovers[0];
      const firstRolloverJob =
        fixture.jobs["rollover-1"];
      const processingAtMs =
        firstRollover.rolls_over_at_ms + 1;
      const completedAtMs =
        firstRollover.rolls_over_at_ms + 2;
      leaseJob(
        runtime.database,
        firstRolloverJob,
        processingAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          processingAtMs,
          processingAtMs,
          firstRollover.id
        );
      insert(
        runtime.database,
        "free_agent_draft_recoveries",
        recoveryRecord(ids, fixture, {
          id: uuid(12_801),
          player_id: null,
          allocation_id: null,
          rollover_id: firstRollover.id,
          auction_id: null,
          job_run_id: firstRolloverJob.id,
          kind: "rollover_finalize",
          status: "pending",
          last_error_code: "AUCTION_FAILED",
          created_by_operation_id:
            "fad-0026-restricted-failure-rollover",
          created_at_ms: processingAtMs,
          updated_at_ms: processingAtMs,
        })
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_rollovers
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              completedAtMs,
              completedAtMs,
              firstRollover.id
            );
        },
        /unresolved recovery cannot complete normally/i
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'recovery_required',
              completed_at_ms = ?,
              last_error_code = 'AUCTION_FAILED',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          completedAtMs,
          completedAtMs,
          firstRollover.id
        );
      settleJobRun(
        runtime.database,
        firstRolloverJob,
        "failed",
        completedAtMs,
        "AUCTION_FAILED"
      );
      for (const rollover of fixture.rollovers.slice(1)) {
        completeFadRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      const fadCompletedAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        FIRST_MATCHUP_STARTS_AT_MS + 1
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          fadCompletedAtMs,
          fadCompletedAtMs,
          fixture.fad.id
        );
      settleJobRun(
        runtime.database,
        fixture.jobs.completion,
        "succeeded",
        fadCompletedAtMs
      );

      const retryAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + HOUR_MS;
      leaseJob(
        runtime.database,
        resolutionJob,
        retryAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'running',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(retryAtMs, recovery.id);
      const selection = drawSelection(
        restricted.auction.id,
        restricted.draw.nonce_bytes,
        restricted.auction.resolves_at_ms,
        restricted.bids.map(({ id }) => id)
      );
      const bidById = new Map(
        restricted.bids.map((bid) => [bid.id, bid])
      );
      const orderedTeamIds = selection.orderedBidIds.map(
        (bidId) => bidById.get(bidId).team_id
      );
      const selectedBidId =
        selection.orderedBidIds[selection.selectedIndex];
      const selectedTeamId =
        orderedTeamIds[selection.selectedIndex];
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'resolved',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(retryAtMs, restricted.auction.id);
      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        {
          orderedBidIds: selection.orderedBidIds,
          orderedTeamIds,
          counter: selection.counter,
          selectedIndex: selection.selectedIndex,
          selectedBidId,
          selectedTeamId,
          digestHex: selection.digestHex,
          revealedAtMs: retryAtMs,
        }
      );
      terminalizeRestrictedWinnerBids(
        runtime.database,
        restricted.bids,
        selectedBidId
      );
      const winnerBid = bidById.get(selectedBidId);
      const { resolution, winnerTeamFixture } =
        seedWinnerResourcesAndResolution(
          runtime.database,
          ids,
          fixture,
          restricted,
          winnerBid,
          retryAtMs
        );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_result",
          winning_snapshot_entry_id:
            winnerTeamFixture.candidateSnapshotEntry.id,
          winning_team_id: winnerBid.team_id,
          contract_id: resolution.contract_id,
          ownership_id: resolution.ownership_id,
          restricted_auction_id: restricted.auction.id,
          resolved_at_ms: retryAtMs,
          last_error_code: null,
          updated_at_ms: retryAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(12_881),
            event_kind: "restricted_state_changed",
          }
        )
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_recoveries
          SET status = 'resolved',
              resolved_authority = 'system',
              resolved_at_ms = ?,
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(retryAtMs, retryAtMs, recovery.id);
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        retryAtMs
      );

      assert.equal(
        fixture.allocation.status,
        "restricted_resolved"
      );
      assert.equal(
        fixture.allocation.winning_team_id,
        selectedTeamId
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id).count,
        1
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT status
            FROM free_agent_draft_recoveries
            WHERE id = ?
          `)
          .get(recovery.id).status,
        "resolved"
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

    test("requires exact immutable restricted participants, seeds, revisions, and permanent removal", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-participants-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-participants");
      const ids = seedLeague(runtime.database, {
        base: 6_000,
        secondTeam: true,
        leagueName: "Restricted participant league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(60_000)
      );
      const auction = auctionRecord(ids, fixture);
      const context = contextRecord(ids, fixture, auction);
      const firstBid = bidRecord(
        ids,
        fixture,
        auction,
        fixture.firstTeam,
        710
      );
      const secondBid = bidRecord(
        ids,
        fixture,
        auction,
        fixture.secondTeam,
        711
      );
      const firstSeedEvent = seedEventRecord(
        ids,
        auction,
        firstBid,
        720
      );
      const secondSeedEvent = seedEventRecord(
        ids,
        auction,
        secondBid,
        721
      );
      const wrongSeedEvent = seedEventRecord(
        ids,
        auction,
        firstBid,
        722,
        { event_type: "bid_submitted" }
      );
      const firstParticipant = participantRecord(
        ids,
        fixture,
        auction,
        fixture.firstTeam,
        firstBid,
        firstSeedEvent,
        730
      );
      const secondParticipant = participantRecord(
        ids,
        fixture,
        auction,
        fixture.secondTeam,
        secondBid,
        secondSeedEvent,
        731
      );
      const draw = drawRecord(ids, fixture, auction);

      insert(runtime.database, "auctions", auction);
      insert(runtime.database, "auction_contexts", context);

      for (const [changes, pattern] of [
        [
          {
            source_snapshot_entry_id:
              fixture.secondTeam.candidateSnapshotEntry.id,
          },
          /eligible Candidate offer|source snapshot/i,
        ],
        [
          {
            originating_candidate_revision_id: uuid(
              numericId(ids.league) + 130
            ),
          },
          /originating Candidate revision|latest Candidate actor revision/i,
        ],
        [
          { original_total_value_cents: 700 },
          /eligible Candidate offer|CHECK constraint/i,
        ],
        [
          { cooldown_anchor_at_ms: CANDIDATE_DEADLINE_AT_MS + 1 },
          /staged restricted auction|Candidate deadline cooldown/i,
        ],
        [
          {
            originating_actor_user_id:
              ids.commissionerUser,
            originating_actor_membership_id:
              ids.commissionerMembership,
            originating_actor_authority: "commissioner",
          },
          /originating Candidate revision|latest Candidate actor revision/i,
        ],
      ]) {
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "free_agent_draft_auction_participants",
              {
                ...firstParticipant,
                ...changes,
              }
            );
          },
          pattern
        );
      }

      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "free_agent_draft_auction_participants",
          {
            ...firstParticipant,
            seeded_bid_id: secondBid.id,
          }
        );
        assertConstraint(
          () => {
            insert(runtime.database, "auction_bids", firstBid);
          },
          /exact system seed/i
        );
      });
      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "free_agent_draft_auction_participants",
          {
            ...firstParticipant,
            seed_event_id: wrongSeedEvent.id,
          }
        );
        insert(runtime.database, "auction_bids", firstBid);
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_events",
              wrongSeedEvent
            );
          },
          /seed event type is reserved/i
        );
      });

      runtime.database.transaction(() => {
        insert(
          runtime.database,
          "free_agent_draft_auction_participants",
          firstParticipant
        );
        insert(runtime.database, "auction_bids", firstBid);
        insert(
          runtime.database,
          "auction_events",
          firstSeedEvent
        );
        assertConstraint(
          () => {
            updateAllocation(
              runtime.database,
              fixture.allocation,
              {
                status: "restricted_active",
                decision_code: "exact_total_and_term_tie",
                restricted_auction_id: auction.id,
                resolved_at_ms: auction.opened_at_ms,
                updated_at_ms: auction.opened_at_ms,
              }
            );
          },
          /at least two active participants|allowlist|missing.*participant|restricted activation/i
        );
        insert(
          runtime.database,
          "free_agent_draft_auction_participants",
          secondParticipant
        );
        insert(runtime.database, "auction_bids", secondBid);
        insert(
          runtime.database,
          "auction_events",
          secondSeedEvent
        );
        insert(runtime.database, "free_agent_draft_draws", draw);
        fixture.allocation = updateAllocation(
          runtime.database,
          fixture.allocation,
          {
            status: "restricted_active",
            decision_code: "exact_total_and_term_tie",
            restricted_auction_id: auction.id,
            resolved_at_ms: auction.opened_at_ms,
            updated_at_ms: auction.opened_at_ms,
          }
        );
        insertRestrictedAllocationEvents(
          runtime.database,
          ids,
          fixture,
          fixture.allocation
        );
      })();

      const storedParticipants = runtime.database
        .prepare(`
          SELECT *
          FROM free_agent_draft_auction_participants
          WHERE auction_id = ?
          ORDER BY team_id
        `)
        .all(auction.id);
      assert.equal(storedParticipants.length, 2);
      assert.deepEqual(
        new Set(
          storedParticipants.map(({ team_id }) => team_id)
        ),
        new Set([ids.team, ids.secondTeam])
      );
      for (const participant of storedParticipants) {
        const seededBid = runtime.database
          .prepare(
            "SELECT * FROM auction_bids WHERE id = ?"
          )
          .get(participant.seeded_bid_id);
        const seedEvent = runtime.database
          .prepare(
            "SELECT * FROM auction_events WHERE id = ?"
          )
          .get(participant.seed_event_id);
        assert.equal(participant.status, "active");
        assert.equal(participant.manager_edit_limit, 1);
        assert.equal(
          participant.minimum_final_total_cents,
          participant.original_total_value_cents
        );
        assert.equal(
          participant.cooldown_anchor_at_ms,
          CANDIDATE_DEADLINE_AT_MS
        );
        assert.equal(
          seededBid.first_submitted_at_ms,
          auction.opened_at_ms
        );
        assert.equal(
          seededBid.last_edited_at_ms,
          auction.opened_at_ms
        );
        assert.equal(seededBid.edit_count, 0);
        assert.equal(
          seedEvent.event_type,
          "fad_restricted_seed_created"
        );
        assert.equal(seedEvent.actor_user_id, null);
      }

      const earlyEditAtMs =
        CANDIDATE_DEADLINE_AT_MS + 75 * 60 * 1_000 - 1;
      const firstEditAtMs =
        CANDIDATE_DEADLINE_AT_MS + 75 * 60 * 1_000;
      const secondEditAtMs =
        CANDIDATE_DEADLINE_AT_MS + 150 * 60 * 1_000;
      for (const [
        requestId,
        occurredAtMs,
        clientKey,
      ] of [
        [uuid(60_750), earlyEditAtMs, "early-edit"],
        [uuid(60_751), firstEditAtMs, "first-edit"],
        [uuid(60_752), secondEditAtMs, "second-edit"],
      ]) {
        insertCompletedBidIdempotency(
          runtime.database,
          ids,
          requestId,
          firstBid.id,
          occurredAtMs,
          clientKey
        );
      }
      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "auction_events",
          bidEditedEventRecord(
            ids,
            auction,
            firstBid,
            760,
            earlyEditAtMs
          )
        );
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE auction_bids
                SET total_value_cents = 600,
                    term_years = 3,
                    lowest_offered_aav_cents = 200,
                    last_edited_at_ms = ?,
                    edit_count = 1,
                    idempotency_request_id = ?,
                    version = 2
                WHERE id = ?
              `)
              .run(
                earlyEditAtMs,
                uuid(60_750),
                firstBid.id
              );
          },
          /cooldown|floor or manager edit limit/i
        );
      });
      insert(
        runtime.database,
        "auction_events",
        bidEditedEventRecord(
          ids,
          auction,
          firstBid,
          761,
          firstEditAtMs
        )
      );
      assert.doesNotThrow(() => {
        runtime.database
          .prepare(`
            UPDATE auction_bids
            SET total_value_cents = 600,
                term_years = 3,
                lowest_offered_aav_cents = 200,
                last_edited_at_ms = ?,
                edit_count = 1,
                idempotency_request_id = ?,
                version = 2
            WHERE id = ?
          `)
          .run(
            firstEditAtMs,
            uuid(60_751),
            firstBid.id
          );
      });
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              total_value_cents,
              term_years,
              lowest_offered_aav_cents,
              last_edited_at_ms,
              edit_count,
              idempotency_request_id,
              version
            FROM auction_bids
            WHERE id = ?
          `)
          .get(firstBid.id),
        {
          total_value_cents: 600,
          term_years: 3,
          lowest_offered_aav_cents: 200,
          last_edited_at_ms: firstEditAtMs,
          edit_count: 1,
          idempotency_request_id: uuid(60_751),
          version: 2,
        }
      );
      inRolledBackSavepoint(runtime.database, () => {
        insert(
          runtime.database,
          "auction_events",
          bidEditedEventRecord(
            ids,
            auction,
            firstBid,
            762,
            secondEditAtMs
          )
        );
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE auction_bids
                SET total_value_cents = 900,
                    term_years = 3,
                    lowest_offered_aav_cents = 200,
                    last_edited_at_ms = ?,
                    edit_count = 2,
                    idempotency_request_id = ?,
                    version = 3
                WHERE id = ?
              `)
              .run(
                secondEditAtMs,
                uuid(60_752),
                firstBid.id
              );
          },
          /manager edit limit/i
        );
      });
      const nonparticipantTeamId = uuid(60_770);
      insert(runtime.database, "teams", {
        id: nonparticipantTeamId,
        league_id: ids.league,
        name: "Nonparticipant Team",
        name_normalized: "nonparticipant team",
        status: "active",
        primary_colour: null,
        secondary_colour: null,
        logo_reference: null,
        created_at_ms: 20,
        updated_at_ms: 20,
        version: 1,
      });
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_auction_participants",
            {
              ...firstParticipant,
              id: uuid(60_769),
              team_id: nonparticipantTeamId,
              seeded_bid_id: uuid(60_768),
              seed_event_id: uuid(60_767),
            }
          );
        },
        /eligible Candidate offer|restricted participant/i
      );
      assertConstraint(
        () => {
          insert(runtime.database, "auction_bids", {
            ...secondBid,
            id: uuid(60_771),
            team_id: nonparticipantTeamId,
          });
        },
        /exact system seed|restricted participant/i
      );

      const removedAtMs =
        CANDIDATE_DEADLINE_AT_MS + 75 * 60 * 1_000 + 500;
      const removalEvent = {
        id: uuid(60_760),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: auction.id,
        bid_id: firstBid.id,
        team_id: firstBid.team_id,
        actor_user_id: ids.commissionerUser,
        event_type: "commissioner_bid_removed",
        metadata_json: "{}",
        occurred_at_ms: removedAtMs,
      };
      runtime.database.transaction(() => {
        insert(runtime.database, "auction_events", removalEvent);
        runtime.database
          .prepare(`
            UPDATE auction_bids
            SET status = 'withdrawn',
                last_edited_at_ms = ?,
                version = version + 1
            WHERE id = ?
          `)
          .run(removedAtMs, firstBid.id);
      })();

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_auction_participants
              SET status = 'removed',
                  removed_by_user_id = ?,
                  removed_by_membership_id = ?,
                  removed_authority = 'commissioner',
                  removal_reason = NULL,
                  removed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 1
              WHERE id = ?
            `)
            .run(
              ids.commissionerUser,
              ids.commissionerMembership,
              removedAtMs,
              removedAtMs,
              firstParticipant.id
            );
        },
        /version|optimistic|approved removal/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_auction_participants
              SET status = 'removed',
                  removed_by_user_id = ?,
                  removed_by_membership_id = ?,
                  removed_authority = 'commissioner',
                  removal_reason = NULL,
                  removed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(
              ids.commissionerUser,
              ids.commissionerMembership,
              removedAtMs,
              removedAtMs,
              firstParticipant.id
            );
        },
        /version|optimistic|approved removal/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_auction_participants
              SET status = 'removed',
                  removed_by_user_id = ?,
                  removed_by_membership_id = ?,
                  removed_authority = 'commissioner',
                  removal_reason = NULL,
                  removed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(
              ids.commissionerUser,
              ids.commissionerMembership,
              removedAtMs,
              removedAtMs + 1,
              firstParticipant.id
            );
        },
        /CHECK constraint|approved removal|versioned removal/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_auction_participants
              SET status = 'removed',
                  removed_by_user_id = ?,
                  removed_by_membership_id = ?,
                  removed_authority = 'commissioner',
                  removal_reason = ' ',
                  removed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 2
              WHERE id = ?
            `)
            .run(
              ids.commissionerUser,
              ids.commissionerMembership,
              removedAtMs,
              removedAtMs,
              firstParticipant.id
            );
        },
        /CHECK constraint/i
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_auction_participants
          SET status = 'removed',
              removed_by_user_id = ?,
              removed_by_membership_id = ?,
              removed_authority = 'commissioner',
              removal_reason = NULL,
              removed_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          ids.commissionerUser,
          ids.commissionerMembership,
          removedAtMs,
          removedAtMs,
          firstParticipant.id
        );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              status,
              removal_reason,
              removed_at_ms,
              updated_at_ms,
              version
            FROM free_agent_draft_auction_participants
            WHERE id = ?
          `)
          .get(firstParticipant.id),
        {
          status: "removed",
          removal_reason: null,
          removed_at_ms: removedAtMs,
          updated_at_ms: removedAtMs,
          version: 2,
        }
      );

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_auction_participants
              SET status = 'active',
                  removed_by_user_id = NULL,
                  removed_by_membership_id = NULL,
                  removed_authority = NULL,
                  removal_reason = NULL,
                  removed_at_ms = NULL,
                  updated_at_ms = ?,
                  version = 3
              WHERE id = ?
            `)
            .run(removedAtMs + 1, firstParticipant.id);
        },
        /permanent|immutable|approved removal|versioned removal/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_auction_participants
              WHERE id = ?
            `)
            .run(firstParticipant.id);
        },
        /participant.*cannot be deleted|permanent/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "free_agent_draft_auction_participants",
            {
              ...firstParticipant,
              id: uuid(60_732),
              seeded_bid_id: uuid(60_733),
              seed_event_id: uuid(60_734),
              created_at_ms: removedAtMs + 1,
              updated_at_ms: removedAtMs + 1,
            }
          );
        },
        /UNIQUE constraint|exact seeded bid|FOREIGN KEY|staged restricted auction/i
      );
      assertConstraint(
        () => {
          insert(
            runtime.database,
            "auction_bids",
            {
              ...firstBid,
              id: uuid(60_735),
              first_submitted_at_ms: removedAtMs + 1,
              last_edited_at_ms: removedAtMs + 1,
            }
          );
        },
        /exact system seed|restricted participant|ineligible|removed/i
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

    test("rejects fabricated invalid bids and permits no-winner only after genuine ordinary ineligibility", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-no-winner-integrity-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-no-winner-integrity");
      const ids = seedLeague(runtime.database, {
        base: 9_000,
        secondTeam: true,
        leagueName: "No-winner integrity league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(90_000)
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      finishRapid(runtime.database, fixture);
      const resolvedAtMs =
        restricted.auction.resolves_at_ms;
      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        resolvedAtMs
      );
      const resolution = {
        id: uuid(9_960),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: restricted.auction.id,
        scheduled_occurrence_key:
          `auction:${restricted.auction.id}:` +
          `${restricted.auction.resolves_at_ms}`,
        outcome_code: "no_winner",
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
        idempotency_key:
          "fad-0026-restricted-no-winner-resolution",
        status: "no_winner",
        resolved_at_ms: resolvedAtMs,
      };
      const emptyReveal = {
        orderedBidIds: [],
        orderedTeamIds: [],
        counter: null,
        selectedIndex: null,
        selectedBidId: null,
        selectedTeamId: null,
        digestHex: null,
        revealedAtMs: resolvedAtMs,
      };
      inRolledBackSavepoint(runtime.database, () => {
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'no_winner',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(resolvedAtMs, restricted.auction.id);
        assertConstraint(
          () => {
            revealDraw(
              runtime.database,
              restricted.draw,
              emptyReveal
            );
          },
          /restricted no-winner draw requires zero eligible bids/i
        );
      });
      inRolledBackSavepoint(runtime.database, () => {
        runtime.database
          .prepare(`
            UPDATE teams
            SET status = 'inactive',
                updated_at_ms = ?,
                version = version + 1
            WHERE id IN (?, ?)
          `)
          .run(
            resolvedAtMs,
            fixture.firstTeam.teamId,
            fixture.secondTeam.teamId
          );
        runtime.database
          .prepare(`
            UPDATE auctions
            SET status = 'no_winner',
                updated_at_ms = ?,
                version = 2
            WHERE id = ?
          `)
          .run(resolvedAtMs, restricted.auction.id);
        revealDraw(
          runtime.database,
          restricted.draw,
          emptyReveal
        );
        runtime.database
          .prepare(`
            UPDATE teams
            SET status = 'active',
                updated_at_ms = ?,
                version = version + 1
            WHERE id IN (?, ?)
          `)
          .run(
            resolvedAtMs,
            fixture.firstTeam.teamId,
            fixture.secondTeam.teamId
          );
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE auction_bids
                SET status = 'invalid',
                    version = version + 1
                WHERE id = ?
              `)
              .run(restricted.bids[0].id);
          },
          /restricted bid cannot be invalid while ordinarily eligible/i
        );
        assertConstraint(
          () => {
            insert(
              runtime.database,
              "auction_resolutions",
              resolution
            );
          },
          /no-winner.*participant bid|participant bid.*invalid|complete exact bid status set|ordinarily eligible/i
        );
      });

      runtime.database
        .prepare(`
          UPDATE teams
          SET status = 'inactive',
              updated_at_ms = ?,
              version = version + 1
          WHERE id IN (?, ?)
        `)
        .run(
          resolvedAtMs,
          fixture.firstTeam.teamId,
          fixture.secondTeam.teamId
        );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM free_agent_draft_auction_participants AS participant
            JOIN teams
              ON teams.league_id = participant.league_id
             AND teams.id = participant.team_id
            WHERE participant.auction_id = ?
              AND participant.status = 'active'
              AND teams.status = 'active'
          `)
          .get(restricted.auction.id).count,
        0
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'no_winner',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(resolvedAtMs, restricted.auction.id);
      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        emptyReveal
      );
      for (const bid of restricted.bids) {
        runtime.database
          .prepare(`
            UPDATE auction_bids
            SET status = 'invalid',
                version = version + 1
            WHERE id = ?
          `)
          .run(bid.id);
      }
      insert(
        runtime.database,
        "auction_resolutions",
        resolution
      );
      insert(runtime.database, "auction_events", {
        id: uuid(9_968),
        league_id: ids.league,
        season_id: ids.targetSeason,
        auction_id: restricted.auction.id,
        bid_id: null,
        team_id: null,
        actor_user_id: null,
        event_type: "auction_resolved",
        metadata_json: "{}",
        occurred_at_ms: resolvedAtMs,
      });
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_no_winner",
          winning_snapshot_entry_id: null,
          winning_team_id: null,
          contract_id: null,
          ownership_id: null,
          restricted_auction_id: restricted.auction.id,
          resolved_at_ms: resolvedAtMs,
          last_error_code: null,
          updated_at_ms: resolvedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(9_880),
            event_kind: "restricted_state_changed",
          }
        )
      );
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        resolvedAtMs
      );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT outcome_code, status, winning_bid_id
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id),
        {
          outcome_code: "no_winner",
          status: "no_winner",
          winning_bid_id: null,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status
            FROM auction_bids
            WHERE auction_id = ?
            ORDER BY id
          `)
          .all(restricted.auction.id),
        [{ status: "invalid" }, { status: "invalid" }]
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

    test("excludes a genuinely ineligible high bid from restricted draw, ranking, and pricing", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-mixed-eligibility-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-mixed-eligibility");
      const ids = seedLeague(runtime.database, {
        base: 13_000,
        secondTeam: true,
        thirdTeam: true,
        leagueName: "Mixed eligibility league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(130_000)
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      assert.equal(restricted.participants.length, 3);
      assert.equal(restricted.bids.length, 3);
      finishRapid(runtime.database, fixture);

      const ineligibleBid = restricted.bids[2];
      const editAtMs =
        CANDIDATE_DEADLINE_AT_MS + 75 * 60 * 1_000;
      const editRequestId = uuid(130_750);
      insertCompletedBidIdempotency(
        runtime.database,
        ids,
        editRequestId,
        ineligibleBid.id,
        editAtMs,
        "mixed-eligibility-high-bid"
      );
      insert(
        runtime.database,
        "auction_events",
        bidEditedEventRecord(
          ids,
          restricted.auction,
          ineligibleBid,
          760,
          editAtMs
        )
      );
      runtime.database
        .prepare(`
          UPDATE auction_bids
          SET total_value_cents = 900,
              term_years = 2,
              lowest_offered_aav_cents = 300,
              last_edited_at_ms = ?,
              edit_count = 1,
              idempotency_request_id = ?,
              version = 2
          WHERE id = ?
        `)
        .run(editAtMs, editRequestId, ineligibleBid.id);

      const resolvedAtMs =
        restricted.auction.resolves_at_ms;
      runtime.database
        .prepare(`
          UPDATE teams
          SET status = 'inactive',
              updated_at_ms = ?,
              version = version + 1
          WHERE id = ?
        `)
        .run(resolvedAtMs, fixture.thirdTeam.teamId);
      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        resolvedAtMs
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'resolved',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(resolvedAtMs, restricted.auction.id);

      const eligibleBids = restricted.bids.slice(0, 2);
      const bidById = new Map(
        restricted.bids.map((bid) => [bid.id, bid])
      );
      const selection = drawSelection(
        restricted.auction.id,
        restricted.draw.nonce_bytes,
        restricted.auction.resolves_at_ms,
        eligibleBids.map(({ id }) => id)
      );
      const orderedTeamIds = selection.orderedBidIds.map(
        (bidId) => bidById.get(bidId).team_id
      );
      const selectedBidId =
        selection.orderedBidIds[selection.selectedIndex];
      const selectedTeamId =
        orderedTeamIds[selection.selectedIndex];
      const allBidSelection = drawSelection(
        restricted.auction.id,
        restricted.draw.nonce_bytes,
        restricted.auction.resolves_at_ms,
        restricted.bids.map(({ id }) => id)
      );
      assertConstraint(
        () => {
          revealDraw(runtime.database, restricted.draw, {
            orderedBidIds: allBidSelection.orderedBidIds,
            orderedTeamIds:
              allBidSelection.orderedBidIds.map(
                (bidId) => bidById.get(bidId).team_id
              ),
            counter: allBidSelection.counter,
            selectedIndex: allBidSelection.selectedIndex,
            selectedBidId:
              allBidSelection.orderedBidIds[
                allBidSelection.selectedIndex
              ],
            selectedTeamId: bidById.get(
              allBidSelection.orderedBidIds[
                allBidSelection.selectedIndex
              ]
            ).team_id,
            digestHex: allBidSelection.digestHex,
            revealedAtMs: resolvedAtMs,
          });
        },
        /exact remaining top tie|ordinarily eligible|eligible top tie|align eligible active bid and team IDs/i
      );
      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        {
          orderedBidIds: selection.orderedBidIds,
          orderedTeamIds,
          counter: selection.counter,
          selectedIndex: selection.selectedIndex,
          selectedBidId,
          selectedTeamId,
          digestHex: selection.digestHex,
          revealedAtMs: resolvedAtMs,
        }
      );
      terminalizeRestrictedWinnerBids(
        runtime.database,
        restricted.bids,
        selectedBidId,
        [ineligibleBid.id]
      );

      const winnerBid = bidById.get(selectedBidId);
      const { resolution, winnerTeamFixture } =
        seedWinnerResourcesAndResolution(
          runtime.database,
          ids,
          fixture,
          restricted,
          winnerBid,
          resolvedAtMs
        );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_result",
          winning_snapshot_entry_id:
            winnerTeamFixture.candidateSnapshotEntry.id,
          winning_team_id: winnerBid.team_id,
          contract_id: resolution.contract_id,
          ownership_id: resolution.ownership_id,
          restricted_auction_id: restricted.auction.id,
          resolved_at_ms: resolvedAtMs,
          last_error_code: null,
          updated_at_ms: resolvedAtMs,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(130_880),
            event_kind: "restricted_state_changed",
          }
        )
      );
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        resolvedAtMs
      );

      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              highest_bid_cents,
              second_price_input_cents,
              final_contract_value_cents,
              winning_term_years,
              final_aav_cents
            FROM auction_resolutions
            WHERE auction_id = ?
          `)
          .get(restricted.auction.id),
        {
          highest_bid_cents: 600,
          second_price_input_cents: 300,
          final_contract_value_cents: 600,
          winning_term_years: 2,
          final_aav_cents: 300,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, COUNT(*) AS count
            FROM auction_bids
            WHERE auction_id = ?
            GROUP BY status
            ORDER BY status
          `)
          .all(restricted.auction.id),
        [
          { status: "invalid", count: 1 },
          { status: "lost", count: 1 },
          { status: "won", count: 1 },
        ]
      );
      assert.equal(
        restricted.draw.ordered_tied_bid_ids_json.includes(
          ineligibleBid.id
        ),
        false
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              total_value_cents,
              lowest_offered_aav_cents,
              (total_value_cents / term_years)
                + CASE
                    WHEN
                      (total_value_cents % term_years) * 2
                        >= term_years
                    THEN 1
                    ELSE 0
                  END AS current_aav_cents,
              status
            FROM auction_bids
            WHERE id = ?
          `)
          .get(ineligibleBid.id),
        {
          total_value_cents: 900,
          lowest_offered_aav_cents: 300,
          current_aav_cents: 450,
          status: "invalid",
        }
      );
      assert.equal(
        fixture.allocation.winning_team_id,
        selectedTeamId
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

    test("persists one immutable draw commitment and one canonical selected reveal", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-draw-selected-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-draw-selected");
      const ids = seedLeague(runtime.database, {
        base: 7_000,
        secondTeam: true,
        leagueName: "Selected draw league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(70_000)
      );
      for (const [drawOverrides, pattern] of [
        [
          { nonce_bytes: Buffer.alloc(31, 0x26) },
          /CHECK constraint/i,
        ],
        [
          {
            commitment_hex:
              "A".repeat(64),
          },
          /CHECK constraint/i,
        ],
        [
          { algorithm_version: 2 },
          /CHECK constraint/i,
        ],
        [
          {
            ordered_tied_bid_ids_json: "[]",
            ordered_tied_team_ids_json: "[]",
            revealed_at_ms: RESTRICTED_OPENED_AT_MS,
          },
          /begin private at version one|CHECK constraint/i,
        ],
      ]) {
        assertConstraint(
          () => {
            seedRestrictedAuction(
              runtime.database,
              ids,
              fixture,
              { drawOverrides }
            );
          },
          pattern
        );
      }
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      finishRapid(runtime.database, fixture);
      const firstRollover = fixture.rollovers[0];
      const firstRolloverJob =
        fixture.jobs["rollover-1"];
      const rolloverProcessingAtMs =
        firstRollover.rolls_over_at_ms + 1;
      const rolloverCompletedAtMs =
        firstRollover.rolls_over_at_ms + 2;
      leaseJob(
        runtime.database,
        firstRolloverJob,
        rolloverProcessingAtMs
      );
      runtime.database
        .prepare(`
          UPDATE free_agent_draft_rollovers
          SET status = 'processing',
              processing_started_at_ms = ?,
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          rolloverProcessingAtMs,
          rolloverProcessingAtMs,
          firstRollover.id
        );
      const finalizeFirstRollover = () => {
        runtime.database
          .prepare(`
            UPDATE free_agent_draft_rollovers
            SET status = 'completed',
                completed_at_ms = ?,
                updated_at_ms = ?,
                version = 3
            WHERE id = ?
          `)
          .run(
            rolloverCompletedAtMs,
            rolloverCompletedAtMs,
            firstRollover.id
          );
      };
      assertConstraint(
        finalizeFirstRollover,
        /unaccounted auction/i
      );
      const fadCompletedAtMs =
        FIRST_MATCHUP_STARTS_AT_MS + 10;
      leaseJob(
        runtime.database,
        fixture.jobs.completion,
        FIRST_MATCHUP_STARTS_AT_MS + 1
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_drafts
              SET status = 'completed',
                  completed_at_ms = ?,
                  updated_at_ms = ?,
                  version = 5
              WHERE id = ?
            `)
            .run(
              fadCompletedAtMs,
              fadCompletedAtMs,
              fixture.fad.id
            );
        },
        /FAD completion|rollover|accounted/i
      );

      const storedPrivateDraw = runtime.database
        .prepare(`
          SELECT * FROM free_agent_draft_draws
          WHERE id = ?
        `)
        .get(restricted.draw.id);
      assert.equal(storedPrivateDraw.algorithm_version, 1);
      assert.equal(storedPrivateDraw.nonce_bytes.length, 32);
      assert.equal(
        storedPrivateDraw.commitment_hex,
        drawCommitment(
          restricted.auction.id,
          storedPrivateDraw.nonce_bytes
        )
      );
      assert.equal(storedPrivateDraw.revealed_at_ms, null);
      assert.equal(storedPrivateDraw.version, 1);

      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              UPDATE free_agent_draft_draws
              SET nonce_bytes = ?,
                  updated_at_ms = updated_at_ms + 1,
                  version = version + 1
              WHERE id = ?
            `)
            .run(Buffer.alloc(32, 0x99), restricted.draw.id);
        },
        /only permits one versioned reveal/i
      );
      assertConstraint(
        () => {
          insert(runtime.database, "free_agent_draft_draws", {
            ...restricted.draw,
            id: uuid(70_741),
            nonce_bytes: Buffer.alloc(32, 0x27),
            commitment_hex: drawCommitment(
              restricted.auction.id,
              Buffer.alloc(32, 0x27)
            ),
          });
        },
        /UNIQUE constraint|restricted draw requires its staged restricted auction/i
      );
      assertConstraint(
        () => {
          runtime.database
            .prepare(`
              DELETE FROM free_agent_draft_draws WHERE id = ?
            `)
            .run(restricted.draw.id);
        },
        /restricted draw evidence is permanent/i
      );

      const selection = drawSelection(
        restricted.auction.id,
        restricted.draw.nonce_bytes,
        restricted.auction.resolves_at_ms,
        restricted.bids.map(({ id }) => id)
      );
      const bidById = new Map(
        restricted.bids.map((bid) => [bid.id, bid])
      );
      const orderedTeamIds = selection.orderedBidIds.map(
        (bidId) => bidById.get(bidId).team_id
      );
      const selectedBidId =
        selection.orderedBidIds[selection.selectedIndex];
      const selectedTeamId =
        orderedTeamIds[selection.selectedIndex];
      const revealEvidence = {
        orderedBidIds: selection.orderedBidIds,
        orderedTeamIds,
        counter: selection.counter,
        selectedIndex: selection.selectedIndex,
        selectedBidId,
        selectedTeamId,
        digestHex: selection.digestHex,
        revealedAtMs: restricted.auction.resolves_at_ms,
      };

      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            revealEvidence
          );
        },
        /terminal auction|auction lifetime/i
      );
      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        restricted.auction.resolves_at_ms
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'resolving',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          restricted.auction.resolves_at_ms,
          restricted.auction.id
        );
      assertConstraint(
        finalizeFirstRollover,
        /unaccounted auction/i
      );
      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            revealEvidence
          );
        },
        /terminal auction|auction lifetime/i
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'resolved',
              updated_at_ms = ?,
              version = 3
          WHERE id = ?
        `)
        .run(
          restricted.auction.resolves_at_ms,
          restricted.auction.id
        );
      assertConstraint(
        finalizeFirstRollover,
        /unaccounted auction/i
      );

      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            revealEvidence,
            { version: 1 }
          );
        },
        /one versioned reveal/i
      );
      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            revealEvidence,
            {
              updated_at_ms:
                revealEvidence.revealedAtMs + 1,
            }
          );
        },
        /CHECK constraint|one versioned reveal/i
      );
      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            {
              ...revealEvidence,
              orderedBidIds: [
                ...selection.orderedBidIds,
              ].reverse(),
              orderedTeamIds: [...orderedTeamIds].reverse(),
            }
          );
        },
        /strictly lexicographically ordered/i
      );
      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            {
              ...revealEvidence,
              selectedTeamId:
                selectedTeamId === ids.team
                  ? ids.secondTeam
                  : ids.team,
            }
          );
        },
        /selection must match its persisted index|align active bid/i
      );
      assertConstraint(
        () => {
          revealDraw(runtime.database, restricted.draw, {
            orderedBidIds: [],
            orderedTeamIds: [],
            counter: null,
            selectedIndex: null,
            selectedBidId: null,
            selectedTeamId: null,
            digestHex: null,
            revealedAtMs:
              restricted.auction.resolves_at_ms,
          });
        },
        /cannot omit a remaining exact tie/i
      );

      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        revealEvidence
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              ordered_tied_bid_ids_json,
              ordered_tied_team_ids_json,
              rejection_counter,
              selected_index,
              selected_bid_id,
              selected_team_id,
              selected_digest_hex,
              revealed_at_ms,
              updated_at_ms,
              version
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(restricted.draw.id),
        {
          ordered_tied_bid_ids_json: JSON.stringify(
            selection.orderedBidIds
          ),
          ordered_tied_team_ids_json:
            JSON.stringify(orderedTeamIds),
          rejection_counter: selection.counter,
          selected_index: selection.selectedIndex,
          selected_bid_id: selectedBidId,
          selected_team_id: selectedTeamId,
          selected_digest_hex: selection.digestHex,
          revealed_at_ms: restricted.auction.resolves_at_ms,
          updated_at_ms: restricted.auction.resolves_at_ms,
          version: 2,
        }
      );
      assertConstraint(
        () => {
          revealDraw(
            runtime.database,
            restricted.draw,
            {
              ...revealEvidence,
              revealedAtMs:
                restricted.auction.resolves_at_ms + 1,
            }
          );
        },
        /one versioned reveal/i
      );

      terminalizeRestrictedWinnerBids(
        runtime.database,
        restricted.bids,
        selectedBidId
      );
      const winnerBid = bidById.get(selectedBidId);
      inRolledBackSavepoint(runtime.database, () => {
        settleJobRun(
          runtime.database,
          resolutionJob,
          "succeeded",
          restricted.auction.resolves_at_ms
        );
        assertConstraint(
          () => {
            seedWinnerResourcesAndResolution(
              runtime.database,
              ids,
              fixture,
              restricted,
              winnerBid,
              restricted.auction.resolves_at_ms
            );
          },
          /FAD auction result requires its exact active resolution job lease/i
        );
      });
      const { resolution, winnerTeamFixture } =
        seedWinnerResourcesAndResolution(
          runtime.database,
          ids,
          fixture,
          restricted,
          winnerBid,
          restricted.auction.resolves_at_ms
        );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_result",
          winning_snapshot_entry_id:
            winnerTeamFixture.candidateSnapshotEntry.id,
          winning_team_id: winnerBid.team_id,
          contract_id: resolution.contract_id,
          ownership_id: resolution.ownership_id,
          restricted_auction_id: restricted.auction.id,
          resolved_at_ms: restricted.auction.resolves_at_ms,
          updated_at_ms: restricted.auction.resolves_at_ms,
        }
      );
      insert(
        runtime.database,
        "free_agent_draft_allocation_events",
        allocationEventRecord(
          ids,
          fixture,
          fixture.allocation,
          {
            id: uuid(70_880),
            event_kind: "restricted_state_changed",
          }
        )
      );
      assert.equal(
        fixture.allocation.winning_team_id,
        restricted.draw.selected_team_id
      );
      assert.equal(
        resolution.winning_bid_id,
        restricted.draw.selected_bid_id
      );
      assertConstraint(
        finalizeFirstRollover,
        /FAD rollover requires each resolved auction job to succeed/i
      );
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        restricted.auction.resolves_at_ms
      );
      for (const rollover of fixture.rollovers) {
        completeFadRollover(
          runtime.database,
          rollover,
          fixture.jobs[`rollover-${rollover.sequence}`]
        );
      }
      inRolledBackSavepoint(runtime.database, () => {
        leaseJob(
          runtime.database,
          resolutionJob,
          fadCompletedAtMs - 1
        );
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE free_agent_drafts
                SET status = 'completed',
                    completed_at_ms = ?,
                    updated_at_ms = ?,
                    version = 5
                WHERE id = ?
              `)
              .run(
                fadCompletedAtMs,
                fadCompletedAtMs,
                fixture.fad.id
              );
          },
          /FAD completion requires each resolved auction job to succeed/i
        );
      });
      runtime.database
        .prepare(`
          UPDATE free_agent_drafts
          SET status = 'completed',
              completed_at_ms = ?,
              updated_at_ms = ?,
              version = 5
          WHERE id = ?
        `)
        .run(
          fadCompletedAtMs,
          fadCompletedAtMs,
          fixture.fad.id
        );
      settleJobRun(
        runtime.database,
        fixture.jobs.completion,
        "succeeded",
        fadCompletedAtMs
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT status, completed_at_ms
            FROM free_agent_drafts
            WHERE id = ?
          `)
          .get(fixture.fad.id),
        {
          status: "completed",
          completed_at_ms: fadCompletedAtMs,
        }
      );
      assert.equal(
        runtime.database
          .prepare(`
            SELECT free_agent_draft_completed_at_ms
            FROM seasons
            WHERE id = ?
          `)
          .get(ids.targetSeason)
          .free_agent_draft_completed_at_ms,
        fadCompletedAtMs
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

    test("reveals the canonical empty draw sentinel when random selection is unused", (t) => {
      const runtime = createRuntime(
        t,
        "hundo-fad-0026-draw-unused-"
      );
      copyMigrationsThrough(runtime, 26);
      migrate(runtime, "fad-0026-draw-unused");
      const ids = seedLeague(runtime.database, {
        base: 8_000,
        secondTeam: true,
        leagueName: "Unused draw league",
      });
      const fixture = seedExactTieFad(
        runtime.database,
        ids,
        uuid(80_000)
      );
      const restricted = seedRestrictedAuction(
        runtime.database,
        ids,
        fixture
      );
      finishRapid(runtime.database, fixture);
      const editAtMs =
        CANDIDATE_DEADLINE_AT_MS + 75 * 60 * 1_000;
      const editRequestId = uuid(80_750);
      insertCompletedBidIdempotency(
        runtime.database,
        ids,
        editRequestId,
        restricted.bids[0].id,
        editAtMs,
        "unique-winner-edit"
      );
      insert(
        runtime.database,
        "auction_events",
        bidEditedEventRecord(
          ids,
          restricted.auction,
          restricted.bids[0],
          760,
          editAtMs
        )
      );
      runtime.database
        .prepare(`
          UPDATE auction_bids
          SET total_value_cents = 600,
              term_years = 3,
              lowest_offered_aav_cents = 200,
              last_edited_at_ms = ?,
              edit_count = 1,
              idempotency_request_id = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          editAtMs,
          editRequestId,
          restricted.bids[0].id
        );

      const resolutionJob = auctionResolutionJobRecord(
        ids,
        restricted.auction
      );
      insert(runtime.database, "job_runs", resolutionJob);
      leaseJob(
        runtime.database,
        resolutionJob,
        restricted.auction.resolves_at_ms
      );
      runtime.database
        .prepare(`
          UPDATE auctions
          SET status = 'resolved',
              updated_at_ms = ?,
              version = 2
          WHERE id = ?
        `)
        .run(
          restricted.auction.resolves_at_ms,
          restricted.auction.id
        );

      const orderedBids = [...restricted.bids]
        .sort((left, right) => left.id.localeCompare(right.id));
      assertConstraint(
        () => {
          revealDraw(runtime.database, restricted.draw, {
            orderedBidIds: orderedBids.map(({ id }) => id),
            orderedTeamIds: orderedBids.map(
              ({ team_id }) => team_id
            ),
            counter: 0,
            selectedIndex: 0,
            selectedBidId: orderedBids[0].id,
            selectedTeamId: orderedBids[0].team_id,
            digestHex: "b".repeat(64),
            revealedAtMs:
              restricted.auction.resolves_at_ms,
          });
        },
        /exact remaining top tie/i
      );
      restricted.draw = revealDraw(
        runtime.database,
        restricted.draw,
        {
          orderedBidIds: [],
          orderedTeamIds: [],
          counter: null,
          selectedIndex: null,
          selectedBidId: null,
          selectedTeamId: null,
          digestHex: null,
          revealedAtMs:
            restricted.auction.resolves_at_ms,
        }
      );
      assert.deepEqual(
        runtime.database
          .prepare(`
            SELECT
              ordered_tied_bid_ids_json,
              ordered_tied_team_ids_json,
              rejection_counter,
              selected_index,
              selected_bid_id,
              selected_team_id,
              selected_digest_hex,
              revealed_at_ms,
              version
            FROM free_agent_draft_draws
            WHERE id = ?
          `)
          .get(restricted.draw.id),
        {
          ordered_tied_bid_ids_json: "[]",
          ordered_tied_team_ids_json: "[]",
          rejection_counter: null,
          selected_index: null,
          selected_bid_id: null,
          selected_team_id: null,
          selected_digest_hex: null,
          revealed_at_ms:
            restricted.auction.resolves_at_ms,
          version: 2,
        }
      );

      const winnerBid = restricted.bids[1];
      const lowerRankedBid = restricted.bids[0];
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE auction_bids
                SET status = 'won',
                    version = version + 1
                WHERE id = ?
              `)
              .run(lowerRankedBid.id);
          },
          /persisted selection|unique live top/i
        );
      });
      inRolledBackSavepoint(runtime.database, () => {
        assertConstraint(
          () => {
            runtime.database
              .prepare(`
                UPDATE auction_bids
                SET status = 'lost',
                    version = version + 1
                WHERE id = ?
              `)
              .run(winnerBid.id);
          },
          /losing bids require the already-persisted winner|restricted terminal bid status must match the auction outcome|restricted losing bid must be ordinarily eligible/i
        );
      });
      terminalizeRestrictedWinnerBids(
        runtime.database,
        restricted.bids,
        winnerBid.id
      );
      const { resolution, winnerTeamFixture } =
        seedWinnerResourcesAndResolution(
          runtime.database,
          ids,
          fixture,
          restricted,
          winnerBid,
          restricted.auction.resolves_at_ms
        );
      fixture.allocation = updateAllocation(
        runtime.database,
        fixture.allocation,
        {
          status: "restricted_resolved",
          decision_code: "restricted_auction_result",
          winning_snapshot_entry_id:
            winnerTeamFixture.candidateSnapshotEntry.id,
          winning_team_id: winnerBid.team_id,
          contract_id: resolution.contract_id,
          ownership_id: resolution.ownership_id,
          restricted_auction_id: restricted.auction.id,
          resolved_at_ms: restricted.auction.resolves_at_ms,
          updated_at_ms: restricted.auction.resolves_at_ms,
        }
      );
      settleJobRun(
        runtime.database,
        resolutionJob,
        "succeeded",
        restricted.auction.resolves_at_ms
      );
      assert.equal(
        fixture.allocation.winning_team_id,
        winnerBid.team_id
      );
      assert.equal(
        resolution.winning_bid_id,
        winnerBid.id
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
  }
);
