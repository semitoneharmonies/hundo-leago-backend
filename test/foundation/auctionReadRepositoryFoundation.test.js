"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const Database = require("better-sqlite3");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  AUCTION_READ_REPOSITORY_CODES,
  createSqliteAuctionReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionReadRepository"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  validateAuctionReadProjection,
} = require(
  "../../src/domain/auctions/auctionReadProjectionPolicy"
);

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  managerUser: uuid(3),
  managerMembership: uuid(4),
  commissionerUser: uuid(5),
  commissionerMembership: uuid(6),
  administratorUser: uuid(7),
  administratorMembership: uuid(8),
  administratorRole: uuid(9),
  inactiveUser: uuid(10),
  inactiveMembership: uuid(11),
  teamOne: uuid(12),
  teamTwo: uuid(13),
  teamThree: uuid(14),
  teamFour: uuid(15),
  assignmentOne: uuid(16),
  assignmentTwo: uuid(17),
  assignmentFour: uuid(18),
  playerOne: uuid(20),
  playerTwo: uuid(21),
  playerThree: uuid(22),
  playerFour: uuid(23),
  sourceOne: uuid(24),
  sourceTwo: uuid(25),
  sourceThree: uuid(26),
  sourceFour: uuid(27),
  ordinaryAuction: uuid(30),
  ordinaryBidOne: uuid(31),
  ordinaryBidThree: uuid(32),
  secondActiveAuction: uuid(33),
  secondActiveBid: uuid(34),
  resolvedAuction: uuid(35),
  resolvedBidOne: uuid(36),
  resolvedBidThree: uuid(37),
  ordinaryResolution: uuid(38),
  ordinaryActivity: uuid(39),
  fad: uuid(40),
  rollover: uuid(41),
  allocation: uuid(42),
  restrictedAuction: uuid(43),
  restrictedBidOne: uuid(44),
  restrictedBidThree: uuid(45),
  participantOne: uuid(46),
  participantTwo: uuid(47),
  participantThree: uuid(48),
  restrictedDraw: uuid(49),
  restrictedResolution: uuid(50),
  restrictedActivity: uuid(51),
  failedAuction: uuid(52),
  failedDraw: uuid(53),
  failedRecovery: uuid(54),
  fadTeamOne: uuid(55),
  fadTeamTwo: uuid(56),
  fadTeamThree: uuid(57),
  nonTieAuction: uuid(58),
  nonTieBid: uuid(59),
  nonTieResolution: uuid(62),
  nonTieActivity: uuid(63),
  nonTieDraw: uuid(64),
  secondLeague: uuid(80),
  secondSeason: uuid(81),
  secondMembership: uuid(82),
  secondLeagueTeam: uuid(83),
  secondAssignment: uuid(84),
  secondLeaguePlayer: uuid(85),
  secondLeagueSource: uuid(86),
  secondLeagueAuction: uuid(87),
  lateCorruptAuction: uuid(89),
  earlyCorruptAuction: uuid(90),
  cancelledTieAuctionOne: uuid(91),
  cancelledTieAuctionTwo: uuid(92),
  cancelledTieResolutionOne: uuid(93),
  cancelledTieResolutionTwo: uuid(94),
  ordinaryRejoinBid: uuid(95),
  openFadAuction: uuid(96),
  openFadWithdrawnBid: uuid(97),
  openFadRejoinBid: uuid(98),
  openFadDraw: uuid(99),
  conflictingPlayerSource: uuid(100),
  replacementPlayerSource: uuid(101),
  noWinnerAuction: uuid(102),
  noWinnerResolution: uuid(103),
  fallbackAuction: uuid(104),
  fallbackBid: uuid(105),
  fallbackDraw: uuid(106),
  openFadStartEvent: uuid(107),
  queuedFadAuction: uuid(108),
  queuedFadStarterBid: uuid(109),
  queuedFadJoinerBid: uuid(110),
  queuedFadStartEvent: uuid(111),
  queuedFadQueue: uuid(112),
  queuedFadDraw: uuid(113),
  failedStarterBid: uuid(114),
  failedStartEvent: uuid(115),
  nonTieStartEvent: uuid(116),
  replacementAssignment: uuid(117),
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

function normalizeHashValue(value) {
  return Buffer.isBuffer(value)
    ? { base64: value.toString("base64") }
    : value;
}

function semanticDatabaseHash(database) {
  const state = database
    .prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => [
      name,
      database
        .prepare(
          `SELECT * FROM "${name.replaceAll('"', '""')}"`
        )
        .all()
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                normalizeHashValue(value),
              ])
            )
          )
        )
        .sort(),
    ]);
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");
}

function noWriteSnapshot(database) {
  return Object.freeze({
    byteHash: createHash("sha256")
      .update(database.serialize())
      .digest("hex"),
    semanticHash: semanticDatabaseHash(database),
    totalChanges: database
      .prepare("SELECT total_changes() AS count")
      .get().count,
  });
}

function assertNoWrites(database, before) {
  assert.deepEqual(noWriteSnapshot(database), before);
}

function createReadSchema(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE leagues (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      timezone TEXT NOT NULL,
      commissioner_membership_id TEXT,
      current_season_id TEXT
    );
    CREATE TABLE league_memberships (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      permission_category TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      status TEXT NOT NULL,
      regular_season_starts_at_ms INTEGER,
      regular_season_ends_at_ms INTEGER,
      fantasy_playoffs_start_at_ms INTEGER,
      free_agent_draft_completed_at_ms INTEGER
    );
    CREATE TABLE platform_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      primary_colour TEXT NOT NULL,
      secondary_colour TEXT NOT NULL,
      tertiary_colour TEXT,
      pattern_template TEXT NOT NULL,
      logo_reference TEXT
    );
    CREATE TABLE team_manager_assignments (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      membership_id TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at_ms INTEGER,
      ended_at_ms INTEGER
    );
    CREATE TABLE players (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL
    );
    CREATE TABLE league_player_positions (
      league_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      position_group TEXT NOT NULL,
      effective_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE player_source_state (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      normalized_position TEXT,
      active INTEGER NOT NULL,
      effective_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    );
    CREATE TABLE auctions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      resolves_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE auction_contexts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      fad_id TEXT,
      fad_rollover_id TEXT,
      fad_allocation_id TEXT,
      fad_origin TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE auction_bids (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      total_value_cents INTEGER NOT NULL,
      term_years INTEGER NOT NULL,
      first_submitted_at_ms INTEGER NOT NULL,
      last_edited_at_ms INTEGER NOT NULL,
      edit_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE auction_events (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      bid_id TEXT,
      team_id TEXT,
      actor_user_id TEXT,
      event_type TEXT NOT NULL,
      metadata_json TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE auction_resolutions (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      winning_bid_id TEXT,
      winning_team_id TEXT,
      final_contract_value_cents INTEGER,
      final_aav_cents INTEGER,
      contract_id TEXT,
      ownership_id TEXT,
      outcome_code TEXT,
      status TEXT NOT NULL,
      resolved_at_ms INTEGER NOT NULL
    );
    CREATE TABLE league_activity (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      related_type TEXT,
      related_id TEXT,
      metadata_json TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_deadline_at_ms INTEGER,
      deadline_locked_at_ms INTEGER,
      allocation_completed_at_ms INTEGER
    );
    CREATE TABLE free_agent_draft_rollovers (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      opens_at_ms INTEGER NOT NULL,
      creation_cutoff_at_ms INTEGER NOT NULL,
      rolls_over_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE free_agent_draft_teams (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      team_id TEXT NOT NULL
    );
    CREATE TABLE free_agent_draft_player_allocations (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      status TEXT NOT NULL,
      restricted_minimum_total_cents INTEGER,
      restricted_minimum_term_years INTEGER,
      restricted_minimum_aav_cents INTEGER
    );
    CREATE TABLE free_agent_draft_draws (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      allocation_id TEXT,
      auction_id TEXT NOT NULL,
      algorithm_version INTEGER NOT NULL,
      nonce_bytes BLOB NOT NULL,
      commitment_hex TEXT NOT NULL,
      ordered_tied_bid_ids_json TEXT,
      ordered_tied_team_ids_json TEXT,
      rejection_counter INTEGER,
      selected_index INTEGER,
      selected_bid_id TEXT,
      selected_team_id TEXT,
      selected_digest_hex TEXT,
      revealed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_auction_participants (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      auction_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      manager_edit_limit INTEGER NOT NULL,
      cooldown_duration_ms INTEGER NOT NULL,
      current_cooldown_anchor_at_ms INTEGER,
      improvement_committed_at_ms INTEGER
    );
    CREATE TABLE free_agent_draft_recoveries (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      auction_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE free_agent_draft_nomination_queue (
      id TEXT PRIMARY KEY,
      league_id TEXT NOT NULL,
      season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_auction_id TEXT,
      opened_starter_bid_id TEXT,
      opened_at_ms INTEGER,
      binding_confirmed_at_ms INTEGER NOT NULL
    );
  `);
}

function seedTeam(database, id, name) {
  insert(database, "teams", {
    id,
    league_id: IDS.league,
    name,
    status: "active",
    primary_colour: "#112233",
    secondary_colour: "#ddeeff",
    tertiary_colour: null,
    pattern_template: "even-two",
    logo_reference: null,
  });
}

function seedPlayer(database, id, fullName, position) {
  insert(database, "players", { id, full_name: fullName });
  insert(database, "player_source_state", {
    id: uuid(Number(id.slice(-12)) + 1_000),
    player_id: id,
    provider: "sportsdataio-discovery-lab",
    normalized_position: position,
    active: 1,
    effective_at_ms: NOW_MS - 30 * DAY_MS,
    ended_at_ms: null,
  });
}

function seedAuction(
  database,
  {
    id,
    playerId,
    status = "open",
    openedAtMs = NOW_MS - HOUR_MS,
    resolvesAtMs = NOW_MS + DAY_MS,
    updatedAtMs = openedAtMs,
    version = 1,
    sourceKind = "ordinary_weekly",
    fadId = null,
    fadRolloverId = null,
    fadAllocationId = null,
    fadOrigin = null,
  }
) {
  insert(database, "auctions", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: playerId,
    status,
    opened_at_ms: openedAtMs,
    resolves_at_ms: resolvesAtMs,
    created_at_ms: openedAtMs,
    updated_at_ms: updatedAtMs,
    version,
  });
  insert(database, "auction_contexts", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: id,
    source_kind: sourceKind,
    fad_id: fadId,
    fad_rollover_id: fadRolloverId,
    fad_allocation_id: fadAllocationId,
    fad_origin: fadOrigin,
    created_at_ms: openedAtMs,
  });
}

function seedBid(
  database,
  {
    id,
    auctionId,
    teamId,
    totalValueCents,
    termYears = 1,
    firstSubmittedAtMs = NOW_MS - HOUR_MS,
    lastEditedAtMs = firstSubmittedAtMs,
    editCount = 0,
    status = "active",
    version = 1,
  }
) {
  insert(database, "auction_bids", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: auctionId,
    team_id: teamId,
    total_value_cents: totalValueCents,
    term_years: termYears,
    first_submitted_at_ms: firstSubmittedAtMs,
    last_edited_at_ms: lastEditedAtMs,
    edit_count: editCount,
    status,
    version,
  });
}

function seedStartedEvent(
  database,
  {
    id,
    auctionId,
    bidId,
    teamId,
    occurredAtMs,
  }
) {
  insert(database, "auction_events", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: auctionId,
    bid_id: bidId,
    team_id: teamId,
    actor_user_id: IDS.managerUser,
    event_type: "auction_started",
    metadata_json: "{}",
    occurred_at_ms: occurredAtMs,
  });
}

function createRuntime(t) {
  const database = new Database(":memory:");
  t.after(() => database.close());
  createReadSchema(database);

  for (const [id, status] of [
    [IDS.managerUser, "active"],
    [IDS.commissionerUser, "active"],
    [IDS.administratorUser, "active"],
    [IDS.inactiveUser, "active"],
  ]) {
    insert(database, "users", { id, status });
  }
  insert(database, "leagues", {
    id: IDS.league,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id:
      IDS.commissionerMembership,
    current_season_id: IDS.season,
  });
  insert(database, "seasons", {
    id: IDS.season,
    league_id: IDS.league,
    status: "active",
    regular_season_starts_at_ms: NOW_MS - 20 * DAY_MS,
    regular_season_ends_at_ms: NOW_MS + 200 * DAY_MS,
    fantasy_playoffs_start_at_ms: NOW_MS + 180 * DAY_MS,
    free_agent_draft_completed_at_ms: NOW_MS - 21 * DAY_MS,
  });
  for (const [id, userId, permission, status] of [
    [
      IDS.managerMembership,
      IDS.managerUser,
      "manager",
      "active",
    ],
    [
      IDS.commissionerMembership,
      IDS.commissionerUser,
      "commissioner",
      "active",
    ],
    [
      IDS.administratorMembership,
      IDS.administratorUser,
      "member",
      "active",
    ],
    [
      IDS.inactiveMembership,
      IDS.inactiveUser,
      "member",
      "ended",
    ],
  ]) {
    insert(database, "league_memberships", {
      id,
      league_id: IDS.league,
      user_id: userId,
      permission_category: permission,
      status,
    });
  }
  insert(database, "platform_roles", {
    id: IDS.administratorRole,
    user_id: IDS.administratorUser,
    role: "platform_administrator",
    status: "active",
  });

  seedTeam(database, IDS.teamOne, "Alpha");
  seedTeam(database, IDS.teamTwo, "Bravo");
  seedTeam(database, IDS.teamThree, "Charlie");
  seedTeam(database, IDS.teamFour, "Delta");
  for (const [id, teamId] of [
    [IDS.assignmentOne, IDS.teamOne],
    [IDS.assignmentTwo, IDS.teamTwo],
    [IDS.assignmentFour, IDS.teamFour],
  ]) {
    insert(database, "team_manager_assignments", {
      id,
      league_id: IDS.league,
      team_id: teamId,
      user_id: IDS.managerUser,
      membership_id: IDS.managerMembership,
      status: "accepted",
      accepted_at_ms: NOW_MS - DAY_MS,
      ended_at_ms: null,
    });
  }
  seedPlayer(database, IDS.playerOne, "Alex Example", "F");
  seedPlayer(database, IDS.playerTwo, "Blake Example", "D");
  seedPlayer(database, IDS.playerThree, "Casey Example", "F");
  seedPlayer(database, IDS.playerFour, "Devon Example", "D");

  return {
    database,
    repository: createSqliteAuctionReadRepository({ database }),
  };
}

function listInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    viewerUserId: IDS.managerUser,
    viewerMembershipId: IDS.managerMembership,
    sourceKind: null,
    fadId: null,
    statuses: ["active"],
    q: null,
    limit: 51,
    order: "resolves_asc",
    cursor: null,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function detailInput(auctionId, overrides = {}) {
  return {
    leagueId: IDS.league,
    auctionId,
    viewerUserId: IDS.managerUser,
    viewerMembershipId: IDS.managerMembership,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function seedOrdinaryActiveAuctions(database) {
  seedAuction(database, {
    id: IDS.ordinaryAuction,
    playerId: IDS.playerOne,
    resolvesAtMs: NOW_MS + DAY_MS,
  });
  seedBid(database, {
    id: IDS.ordinaryBidOne,
    auctionId: IDS.ordinaryAuction,
    teamId: IDS.teamOne,
    totalValueCents: 600,
  });
  seedBid(database, {
    id: IDS.ordinaryBidThree,
    auctionId: IDS.ordinaryAuction,
    teamId: IDS.teamThree,
    totalValueCents: 987,
    firstSubmittedAtMs: NOW_MS - 30 * 60 * 1_000,
  });
  seedAuction(database, {
    id: IDS.secondActiveAuction,
    playerId: IDS.playerTwo,
    resolvesAtMs: NOW_MS + 2 * DAY_MS,
  });
  seedBid(database, {
    id: IDS.secondActiveBid,
    auctionId: IDS.secondActiveAuction,
    teamId: IDS.teamThree,
    totalValueCents: 700,
  });
}

function seedSecondLeague(database) {
  insert(database, "leagues", {
    id: IDS.secondLeague,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: IDS.secondSeason,
  });
  insert(database, "seasons", {
    id: IDS.secondSeason,
    league_id: IDS.secondLeague,
    status: "active",
    regular_season_starts_at_ms: NOW_MS - 20 * DAY_MS,
    regular_season_ends_at_ms: NOW_MS + 200 * DAY_MS,
    fantasy_playoffs_start_at_ms: NOW_MS + 180 * DAY_MS,
    free_agent_draft_completed_at_ms: NOW_MS - 21 * DAY_MS,
  });
  insert(database, "league_memberships", {
    id: IDS.secondMembership,
    league_id: IDS.secondLeague,
    user_id: IDS.managerUser,
    permission_category: "manager",
    status: "active",
  });
  insert(database, "teams", {
    id: IDS.secondLeagueTeam,
    league_id: IDS.secondLeague,
    name: "Echo",
    status: "active",
    primary_colour: "#223344",
    secondary_colour: "#ccddee",
    tertiary_colour: null,
    pattern_template: "even-two",
    logo_reference: null,
  });
  insert(database, "team_manager_assignments", {
    id: IDS.secondAssignment,
    league_id: IDS.secondLeague,
    team_id: IDS.secondLeagueTeam,
    user_id: IDS.managerUser,
    membership_id: IDS.secondMembership,
    status: "accepted",
    accepted_at_ms: NOW_MS - DAY_MS,
    ended_at_ms: null,
  });
  insert(database, "players", {
    id: IDS.secondLeaguePlayer,
    full_name: "Elliot Example",
  });
  insert(database, "player_source_state", {
    id: IDS.secondLeagueSource,
    player_id: IDS.secondLeaguePlayer,
    provider: "sportsdataio-discovery-lab",
    normalized_position: "F",
    active: 1,
    effective_at_ms: NOW_MS - 30 * DAY_MS,
    ended_at_ms: null,
  });
  insert(database, "auctions", {
    id: IDS.secondLeagueAuction,
    league_id: IDS.secondLeague,
    season_id: IDS.secondSeason,
    player_id: IDS.secondLeaguePlayer,
    status: "open",
    opened_at_ms: NOW_MS - HOUR_MS,
    resolves_at_ms: NOW_MS + 3 * DAY_MS,
    created_at_ms: NOW_MS - HOUR_MS,
    updated_at_ms: NOW_MS - HOUR_MS,
    version: 1,
  });
  insert(database, "auction_contexts", {
    id: IDS.secondLeagueAuction,
    league_id: IDS.secondLeague,
    season_id: IDS.secondSeason,
    auction_id: IDS.secondLeagueAuction,
    source_kind: "ordinary_weekly",
    fad_id: null,
    fad_rollover_id: null,
    fad_allocation_id: null,
    fad_origin: null,
    created_at_ms: NOW_MS - HOUR_MS,
  });
}

function seedContextlessAuction(
  database,
  { id, playerId, resolvesAtMs }
) {
  insert(database, "auctions", {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    player_id: playerId,
    status: "open",
    opened_at_ms: NOW_MS - HOUR_MS,
    resolves_at_ms: resolvesAtMs,
    created_at_ms: NOW_MS - HOUR_MS,
    updated_at_ms: NOW_MS - HOUR_MS,
    version: 1,
  });
}

function seedFadRoot(database) {
  insert(database, "free_agent_drafts", {
    id: IDS.fad,
    league_id: IDS.league,
    season_id: IDS.season,
    status: "rapid",
    candidate_deadline_at_ms: NOW_MS - HOUR_MS,
    deadline_locked_at_ms: NOW_MS - HOUR_MS,
    allocation_completed_at_ms: NOW_MS - HOUR_MS,
  });
  insert(database, "free_agent_draft_rollovers", {
    id: IDS.rollover,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    sequence: 2,
    opens_at_ms: NOW_MS - HOUR_MS,
    creation_cutoff_at_ms: NOW_MS + 22 * HOUR_MS,
    rolls_over_at_ms: NOW_MS + 23 * HOUR_MS,
    status: "scheduled",
  });
  for (const [id, teamId] of [
    [IDS.fadTeamOne, IDS.teamOne],
    [IDS.fadTeamTwo, IDS.teamTwo],
    [IDS.fadTeamThree, IDS.teamThree],
  ]) {
    insert(database, "free_agent_draft_teams", {
      id,
      league_id: IDS.league,
      fad_id: IDS.fad,
      team_id: teamId,
    });
  }
}

function seedRestrictedAuction(
  database,
  {
    allocationStatus = "restricted_active",
    openedAtMs = NOW_MS - HOUR_MS,
    includeBids = true,
  } = {}
) {
  seedFadRoot(database);
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    status: allocationStatus,
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
  });
  seedAuction(database, {
    id: IDS.restrictedAuction,
    playerId: IDS.playerThree,
    openedAtMs,
    resolvesAtMs: NOW_MS + 23 * HOUR_MS,
    sourceKind: "fad_restricted",
    fadId: IDS.fad,
    fadRolloverId: IDS.rollover,
    fadAllocationId: IDS.allocation,
    fadOrigin: "candidate_tie_restricted",
  });
  for (const [id, teamId, status, activeBidId] of [
    [
      IDS.participantOne,
      IDS.teamOne,
      "active",
      IDS.restrictedBidOne,
    ],
    [IDS.participantTwo, IDS.teamTwo, "active", null],
    [
      IDS.participantThree,
      IDS.teamThree,
      "active",
      IDS.restrictedBidThree,
    ],
  ]) {
    insert(database, "free_agent_draft_auction_participants", {
      id,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: IDS.allocation,
      auction_id: IDS.restrictedAuction,
      team_id: teamId,
      status,
      manager_edit_limit: 1,
      cooldown_duration_ms: 4_500_000,
      current_cooldown_anchor_at_ms:
        !includeBids || activeBidId === null
          ? null
          : NOW_MS - 2 * HOUR_MS,
      improvement_committed_at_ms:
        !includeBids || activeBidId === null
          ? null
          : NOW_MS - 2 * HOUR_MS,
    });
  }
  if (includeBids) {
    seedBid(database, {
      id: IDS.restrictedBidOne,
      auctionId: IDS.restrictedAuction,
      teamId: IDS.teamOne,
      totalValueCents: 800,
      termYears: 2,
      firstSubmittedAtMs: NOW_MS - 2 * HOUR_MS,
      lastEditedAtMs: NOW_MS - 2 * HOUR_MS,
    });
    seedBid(database, {
      id: IDS.restrictedBidThree,
      auctionId: IDS.restrictedAuction,
      teamId: IDS.teamThree,
      totalValueCents: 987,
      firstSubmittedAtMs: NOW_MS - 90 * 60 * 1_000,
      lastEditedAtMs: NOW_MS - 90 * 60 * 1_000,
    });
  }
  const nonceBytes = Buffer.alloc(32, 7);
  const commitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.restrictedAuction,
      nonceBytes,
    });
  insert(database, "free_agent_draft_draws", {
    id: IDS.restrictedDraw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.restrictedAuction,
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
    created_at_ms: openedAtMs,
  });
}

function seedFallbackAuction(database) {
  seedFadRoot(database);
  insert(database, "free_agent_draft_player_allocations", {
    id: IDS.allocation,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    status: "restricted_fallback_open",
    restricted_minimum_total_cents: 600,
    restricted_minimum_term_years: 2,
    restricted_minimum_aav_cents: 300,
  });
  const openedAtMs = NOW_MS - 2 * HOUR_MS;
  seedAuction(database, {
    id: IDS.fallbackAuction,
    playerId: IDS.playerThree,
    openedAtMs,
    resolvesAtMs: NOW_MS + 23 * HOUR_MS,
    sourceKind: "fad_open_rapid",
    fadId: IDS.fad,
    fadRolloverId: IDS.rollover,
    fadAllocationId: IDS.allocation,
    fadOrigin: "restricted_no_improvement_fallback",
  });
  seedBid(database, {
    id: IDS.fallbackBid,
    auctionId: IDS.fallbackAuction,
    teamId: IDS.teamOne,
    totalValueCents: 600,
    termYears: 2,
    firstSubmittedAtMs: openedAtMs,
    lastEditedAtMs: openedAtMs,
  });
  const nonceBytes = Buffer.alloc(32, 23);
  const commitment =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId: IDS.fallbackAuction,
      nonceBytes,
    });
  insert(database, "free_agent_draft_draws", {
    id: IDS.fallbackDraw,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    auction_id: IDS.fallbackAuction,
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
    created_at_ms: openedAtMs,
  });
}

describe("FAD-06 SQLite auction read repository", () => {
  test("prepares every read statement against the complete current migration schema", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-auction-read-schema-")
    );
    const connection = openDatabase({
      databasePath: path.join(temporaryRoot, "league.sqlite3"),
      environment: "test",
    });
    t.after(() => {
      if (connection.database.open) connection.database.close();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });
    applyMigrations({
      database: connection.database,
      migrations: discoverMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
      }),
      applicationBuildId: "fad06-auction-read-foundation",
      now: () => NOW_MS,
    });

    const repository = createSqliteAuctionReadRepository({
      database: connection.database,
    });
    assert.equal(typeof repository.listAuctions, "function");
    assert.equal(typeof repository.readAuction, "function");
  });

  test("returns the exact active DTO without competitor values and includes every managed team", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);

    const result = runtime.repository.listAuctions(listInput());
    assert.equal(result.auctions.length, 2);
    assert.deepEqual(
      result.auctions.map(({ auctionId }) => auctionId),
      [IDS.ordinaryAuction, IDS.secondActiveAuction]
    );
    const auction = result.auctions[0];
    assert.deepEqual(Object.keys(auction).sort(), [
      "administrativeBids",
      "auctionId",
      "bidCount",
      "capabilities",
      "creationCutoffAtMs",
      "drawCommitment",
      "eligibleTeams",
      "fadId",
      "fadOrigin",
      "fadRolloverId",
      "leagueId",
      "minimumContract",
      "openedAtMs",
      "participatingTeamCount",
      "player",
      "resolvedAtMs",
      "resolvesAtMs",
      "result",
      "seasonId",
      "sourceKind",
      "status",
      "targetRolloverAtMs",
      "updatedAtMs",
      "version",
      "viewerTeams",
    ]);
    assert.equal(auction.status, "active");
    assert.equal(auction.sourceKind, "ordinary_weekly");
    assert.equal(auction.bidCount, 2);
    assert.equal(auction.participatingTeamCount, 2);
    assert.equal(auction.result, null);
    assert.equal(auction.resolvedAtMs, null);
    assert.equal(auction.administrativeBids.length, 0);
    assert.deepEqual(
      auction.viewerTeams.map(({ teamId }) => teamId),
      [IDS.teamOne, IDS.teamTwo, IDS.teamFour]
    );
    assert.equal(
      auction.viewerTeams[0].bid.totalValueCents,
      600
    );
    assert.equal(auction.viewerTeams[1].bid, null);
    assert.equal(auction.viewerTeams[1].eligible, true);
    assert.equal(JSON.stringify(auction).includes("987"), false);
    assert.equal(Object.isFrozen(auction.viewerTeams), true);

    assert.equal(result.startTeams.length, 3);
    assert.equal(result.startTeams[0].sourceKind, "ordinary_weekly");
    assert.equal(result.startTeams[0].fadId, null);
    assert.deepEqual(result.startTeams[0].startAuction, {
      allowed: true,
      reasonCode: null,
    });

    const commissioner = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
      })
    );
    assert.equal(commissioner.viewerTeams.length, 0);
    assert.equal(commissioner.administrativeBids.length, 2);
    assert.deepEqual(
      Object.keys(commissioner.administrativeBids[0]).sort(),
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
      "totalValueCents" in commissioner.administrativeBids[0],
      false
    );
    assert.equal(JSON.stringify(commissioner).includes("987"), false);

    const administrator = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction, {
        viewerUserId: IDS.administratorUser,
        viewerMembershipId: IDS.administratorMembership,
      })
    );
    assert.equal(administrator.administrativeBids.length, 2);
    assert.equal(
      administrator.capabilities.adminCancel.allowed,
      true
    );
  });

  test("allows ordinary and direct FAD rejoin while preserving event-bound starter limits and blind history", (t) => {
    const ordinary = createRuntime(t);
    seedOrdinaryActiveAuctions(ordinary.database);
    ordinary.database
      .prepare("UPDATE auction_bids SET status = 'withdrawn' WHERE id = ?")
      .run(IDS.ordinaryBidOne);

    let ordinaryAuction = ordinary.repository.readAuction(
      detailInput(IDS.ordinaryAuction)
    );
    let ordinaryTeam = ordinaryAuction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    assert.equal(ordinaryTeam.bid.status, "withdrawn");
    assert.deepEqual(ordinaryTeam.join, {
      allowed: true,
      reasonCode: null,
    });
    assert.deepEqual(ordinaryTeam.edit, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });

    seedBid(ordinary.database, {
      id: IDS.ordinaryRejoinBid,
      auctionId: IDS.ordinaryAuction,
      teamId: IDS.teamOne,
      totalValueCents: 700,
      firstSubmittedAtMs: NOW_MS,
      lastEditedAtMs: NOW_MS,
    });
    ordinaryAuction = ordinary.repository.readAuction(
      detailInput(IDS.ordinaryAuction)
    );
    ordinaryTeam = ordinaryAuction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    assert.equal(ordinaryTeam.bid.bidId, IDS.ordinaryRejoinBid);
    assert.equal(ordinaryTeam.join.allowed, false);
    const ordinaryAdministration = ordinary.repository.readAuction(
      detailInput(IDS.ordinaryAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
      })
    );
    assert.deepEqual(
      ordinaryAdministration.administrativeBids
        .filter(({ teamId }) => teamId === IDS.teamOne)
        .map(({ bidId, status }) => ({ bidId, status })),
      [
        { bidId: IDS.ordinaryBidOne, status: "withdrawn" },
        { bidId: IDS.ordinaryRejoinBid, status: "active" },
      ]
    );

    const fad = createRuntime(t);
    seedFadRoot(fad.database);
    const fadOpenedAtMs = NOW_MS - 2 * HOUR_MS;
    seedAuction(fad.database, {
      id: IDS.openFadAuction,
      playerId: IDS.playerOne,
      openedAtMs: fadOpenedAtMs,
      resolvesAtMs: NOW_MS + 23 * HOUR_MS,
      sourceKind: "fad_open_rapid",
      fadId: IDS.fad,
      fadRolloverId: IDS.rollover,
      fadOrigin: "manager_nomination",
    });
    seedBid(fad.database, {
      id: IDS.openFadWithdrawnBid,
      auctionId: IDS.openFadAuction,
      teamId: IDS.teamOne,
      totalValueCents: 600,
      firstSubmittedAtMs: fadOpenedAtMs,
      lastEditedAtMs: fadOpenedAtMs,
      status: "withdrawn",
    });
    seedStartedEvent(fad.database, {
      id: IDS.openFadStartEvent,
      auctionId: IDS.openFadAuction,
      bidId: IDS.openFadWithdrawnBid,
      teamId: IDS.teamOne,
      occurredAtMs: fadOpenedAtMs,
    });
    const nonceBytes = Buffer.alloc(32, 13);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.openFadAuction,
        nonceBytes,
      });
    insert(fad.database, "free_agent_draft_draws", {
      id: IDS.openFadDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.openFadAuction,
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
      created_at_ms: fadOpenedAtMs,
    });

    let fadAuction = fad.repository.readAuction(
      detailInput(IDS.openFadAuction)
    );
    let fadTeam = fadAuction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    assert.equal(fadTeam.bid.status, "withdrawn");
    assert.equal(fadTeam.bid.editLimit, 2);
    assert.deepEqual(fadTeam.join, {
      allowed: true,
      reasonCode: null,
    });

    seedBid(fad.database, {
      id: IDS.openFadRejoinBid,
      auctionId: IDS.openFadAuction,
      teamId: IDS.teamOne,
      totalValueCents: 800,
      firstSubmittedAtMs: fadOpenedAtMs,
      lastEditedAtMs: fadOpenedAtMs,
    });
    fadAuction = fad.repository.readAuction(
      detailInput(IDS.openFadAuction)
    );
    fadTeam = fadAuction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    assert.equal(
      validateAuctionReadProjection(fadAuction),
      fadAuction
    );
    assert.equal(fadTeam.bid.bidId, IDS.openFadRejoinBid);
    assert.equal(fadTeam.bid.editLimit, 1);
    assert.equal(fadTeam.join.allowed, false);
    assert.deepEqual(fadTeam.edit, {
      allowed: true,
      reasonCode: null,
    });
    const fadAdministration = fad.repository.readAuction(
      detailInput(IDS.openFadAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
      })
    );
    assert.deepEqual(
      fadAdministration.administrativeBids
        .filter(({ teamId }) => teamId === IDS.teamOne)
        .map(({ bidId, status }) => ({ bidId, status })),
      [
        { bidId: IDS.openFadWithdrawnBid, status: "withdrawn" },
        { bidId: IDS.openFadRejoinBid, status: "active" },
      ]
    );
  });

  test("projects queued FAD starter identity, league-wide join capability, and one-edit nonstarter limits", (t) => {
    const runtime = createRuntime(t);
    seedFadRoot(runtime.database);
    const openedAtMs = NOW_MS - 2 * HOUR_MS;
    const acceptedAtMs = openedAtMs - 30 * 60 * 1_000;
    seedAuction(runtime.database, {
      id: IDS.queuedFadAuction,
      playerId: IDS.playerTwo,
      openedAtMs,
      resolvesAtMs: NOW_MS + 23 * HOUR_MS,
      sourceKind: "fad_open_rapid",
      fadId: IDS.fad,
      fadRolloverId: IDS.rollover,
      fadOrigin: "queued_nomination",
    });
    seedBid(runtime.database, {
      id: IDS.queuedFadStarterBid,
      auctionId: IDS.queuedFadAuction,
      teamId: IDS.teamOne,
      totalValueCents: 600,
      termYears: 3,
      firstSubmittedAtMs: acceptedAtMs,
      lastEditedAtMs: acceptedAtMs,
    });
    seedBid(runtime.database, {
      id: IDS.queuedFadJoinerBid,
      auctionId: IDS.queuedFadAuction,
      teamId: IDS.teamTwo,
      totalValueCents: 500,
      termYears: 3,
      firstSubmittedAtMs: openedAtMs,
      lastEditedAtMs: openedAtMs,
      editCount: 1,
      version: 2,
    });
    seedStartedEvent(runtime.database, {
      id: IDS.queuedFadStartEvent,
      auctionId: IDS.queuedFadAuction,
      bidId: IDS.queuedFadStarterBid,
      teamId: IDS.teamOne,
      occurredAtMs: openedAtMs,
    });
    insert(runtime.database, "free_agent_draft_nomination_queue", {
      id: IDS.queuedFadQueue,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      player_id: IDS.playerTwo,
      team_id: IDS.teamOne,
      status: "opened",
      opened_auction_id: IDS.queuedFadAuction,
      opened_starter_bid_id: IDS.queuedFadStarterBid,
      opened_at_ms: openedAtMs,
      binding_confirmed_at_ms: acceptedAtMs,
    });
    const nonceBytes = Buffer.alloc(32, 29);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.queuedFadAuction,
        nonceBytes,
      });
    insert(runtime.database, "free_agent_draft_draws", {
      id: IDS.queuedFadDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.queuedFadAuction,
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
      created_at_ms: openedAtMs,
    });

    const auction = runtime.repository.readAuction(
      detailInput(IDS.queuedFadAuction)
    );
    assert.equal(validateAuctionReadProjection(auction), auction);
    assert.equal(auction.fadOrigin, "queued_nomination");
    const starter = auction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    const joiner = auction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamTwo
    );
    const available = auction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamFour
    );
    assert.equal(starter.bid.editLimit, 2);
    assert.equal(
      starter.bid.bindingIllegalityConfirmedAtMs,
      acceptedAtMs
    );
    assert.deepEqual(starter.edit, {
      allowed: true,
      reasonCode: null,
    });
    assert.equal(joiner.bid.editLimit, 1);
    assert.deepEqual(joiner.edit, {
      allowed: false,
      reasonCode: "EDIT_LIMIT_REACHED",
    });
    assert.deepEqual(available.join, {
      allowed: true,
      reasonCode: null,
    });

    const commissioner = runtime.repository.readAuction(
      detailInput(IDS.queuedFadAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
      })
    );
    assert.equal(commissioner.viewerTeams.length, 0);
    assert.equal(commissioner.administrativeBids.length, 2);
    assert.equal(
      commissioner.administrativeBids.some(
        (bid) => "totalValueCents" in bid
      ),
      false
    );

    runtime.database.prepare(`
      UPDATE free_agent_draft_nomination_queue
      SET opened_starter_bid_id = ?
      WHERE id = ?
    `).run(
      IDS.queuedFadJoinerBid,
      IDS.queuedFadQueue
    );
    assert.throws(
      () => runtime.repository.readAuction(
        detailInput(IDS.queuedFadAuction)
      ),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        /queued FAD starter backlink/u.test(error.message)
    );
  });

  test("projects an allocation-linked fallback as league-wide with exactly one manager edit", (t) => {
    const runtime = createRuntime(t);
    seedFallbackAuction(runtime.database);

    const fallback = runtime.repository.readAuction(
      detailInput(IDS.fallbackAuction)
    );
    assert.equal(fallback.sourceKind, "fad_open_rapid");
    assert.equal(
      fallback.fadOrigin,
      "restricted_no_improvement_fallback"
    );
    assert.deepEqual(fallback.minimumContract, {
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
    });
    const bidder = fallback.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    assert.equal(bidder.bid.editLimit, 1);
    assert.deepEqual(bidder.edit, {
      allowed: true,
      reasonCode: null,
    });
    const leagueWideTeam = fallback.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamTwo
    );
    assert.equal(leagueWideTeam.eligible, true);
    assert.equal(leagueWideTeam.participantStatus, null);
    assert.deepEqual(leagueWideTeam.join, {
      allowed: true,
      reasonCode: null,
    });
  });

  test("applies exact filters, orders, cursor predicates, and stable terminal result projection", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    seedAuction(runtime.database, {
      id: IDS.resolvedAuction,
      playerId: IDS.playerFour,
      status: "resolved",
      openedAtMs: NOW_MS - 3 * DAY_MS,
      resolvesAtMs: NOW_MS - 2 * DAY_MS,
      updatedAtMs: NOW_MS - DAY_MS,
      version: 2,
    });
    seedBid(runtime.database, {
      id: IDS.resolvedBidOne,
      auctionId: IDS.resolvedAuction,
      teamId: IDS.teamOne,
      totalValueCents: 900,
      termYears: 3,
      status: "won",
      version: 2,
    });
    seedBid(runtime.database, {
      id: IDS.resolvedBidThree,
      auctionId: IDS.resolvedAuction,
      teamId: IDS.teamThree,
      totalValueCents: 800,
      termYears: 2,
      status: "lost",
      version: 2,
    });
    insert(runtime.database, "auction_resolutions", {
      id: IDS.ordinaryResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.resolvedAuction,
      winning_bid_id: IDS.resolvedBidOne,
      winning_team_id: IDS.teamOne,
      final_contract_value_cents: 700,
      final_aav_cents: 233,
      contract_id: uuid(60),
      ownership_id: uuid(61),
      status: "resolved",
      resolved_at_ms: NOW_MS - DAY_MS,
    });
    insert(runtime.database, "league_activity", {
      id: IDS.ordinaryActivity,
      league_id: IDS.league,
      related_type: "auction_resolution",
      related_id: IDS.ordinaryResolution,
      metadata_json: JSON.stringify({
        auctionId: IDS.resolvedAuction,
      }),
      occurred_at_ms: NOW_MS - DAY_MS,
    });

    const terminal = runtime.repository.readAuction(
      detailInput(IDS.resolvedAuction)
    );
    assert.equal(terminal.status, "resolved");
    assert.equal(terminal.resolvedAtMs, NOW_MS - DAY_MS);
    assert.deepEqual(terminal.result, {
      outcomeCode: "resolved",
      winningTeam: {
        teamId: IDS.teamOne,
        name: "Alpha",
        primaryColour: "#112233",
        secondaryColour: "#ddeeff",
        tertiaryColour: null,
        patternTemplate: "even-two",
        logoReference: null,
      },
      submittedTotalValueCents: 900,
      submittedTermYears: 3,
      submittedAavCents: 300,
      finalContractValueCents: 700,
      finalAavCents: 233,
      contractId: uuid(60),
      ownershipId: uuid(61),
      activityId: IDS.ordinaryActivity,
      recoveryId: null,
      drawEvidence: null,
      resolvedAtMs: NOW_MS - DAY_MS,
    });

    seedAuction(runtime.database, {
      id: IDS.noWinnerAuction,
      playerId: IDS.playerFour,
      status: "no_winner",
      openedAtMs: NOW_MS - 2 * DAY_MS,
      resolvesAtMs: NOW_MS - DAY_MS,
      updatedAtMs: NOW_MS,
      version: 2,
    });
    insert(runtime.database, "auction_resolutions", {
      id: IDS.noWinnerResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.noWinnerAuction,
      winning_bid_id: null,
      winning_team_id: null,
      final_contract_value_cents: null,
      final_aav_cents: null,
      contract_id: null,
      ownership_id: null,
      status: "no_winner",
      resolved_at_ms: NOW_MS,
    });
    insert(runtime.database, "player_source_state", {
      id: IDS.conflictingPlayerSource,
      player_id: IDS.playerFour,
      provider: "secondary-provider",
      normalized_position: "F",
      active: 1,
      effective_at_ms: NOW_MS - 10 * DAY_MS,
      ended_at_ms: null,
    });

    for (const auctionId of [
      IDS.resolvedAuction,
      IDS.noWinnerAuction,
    ]) {
      assert.equal(
        runtime.repository.readAuction(
          detailInput(auctionId)
        ).player.positionGroup,
        "D"
      );
    }

    runtime.database
      .prepare(
        "UPDATE player_source_state SET active = 0, ended_at_ms = ? WHERE player_id = ? AND provider = ? AND ended_at_ms IS NULL"
      )
      .run(
        NOW_MS,
        IDS.playerFour,
        "sportsdataio-discovery-lab"
      );
    insert(runtime.database, "player_source_state", {
      id: IDS.replacementPlayerSource,
      player_id: IDS.playerFour,
      provider: "sportsdataio-discovery-lab",
      normalized_position: "F",
      active: 1,
      effective_at_ms: NOW_MS,
      ended_at_ms: null,
    });
    for (const [auctionId, outcomeCode] of [
      [IDS.resolvedAuction, "resolved"],
      [IDS.noWinnerAuction, "no_winner"],
    ]) {
      const stableTerminal = runtime.repository.readAuction(
        detailInput(auctionId)
      );
      assert.deepEqual(stableTerminal.player, {
        playerId: IDS.playerFour,
        fullName: "Devon Example",
        positionGroup: "D",
      });
      assert.equal(
        stableTerminal.result.outcomeCode,
        outcomeCode
      );
    }

    const terminalList = runtime.repository.listAuctions(
      listInput({
        statuses: ["resolved"],
        q: "devon",
        order: "resolved_desc",
      })
    );
    assert.deepEqual(
      terminalList.auctions.map(({ auctionId }) => auctionId),
      [IDS.resolvedAuction]
    );
    const afterFirst = runtime.repository.listAuctions(
      listInput({
        cursor: {
          sortMs: NOW_MS + DAY_MS,
          auctionId: IDS.ordinaryAuction,
        },
      })
    );
    assert.deepEqual(
      afterFirst.auctions.map(({ auctionId }) => auctionId),
      [IDS.secondActiveAuction]
    );
    const noOrdinaryFad = runtime.repository.listAuctions(
      listInput({ sourceKind: "fad_open_rapid" })
    );
    assert.equal(noOrdinaryFad.auctions.length, 0);
  });

  test("keeps future FAD auctions private and keeps scheduled restricted rows private until atomic activation", (t) => {
    const opensAtMs = NOW_MS + HOUR_MS;

    const restricted = createRuntime(t);
    seedRestrictedAuction(restricted.database, {
      allocationStatus: "restricted_scheduled",
      openedAtMs: opensAtMs,
      includeBids: false,
    });
    const restrictedChangesBeforeReads = restricted.database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    for (const nowMs of [opensAtMs - 1, opensAtMs]) {
      assert.deepEqual(
        restricted.repository.listAuctions(
          listInput({
            sourceKind: "fad_restricted",
            fadId: IDS.fad,
            nowMs,
          })
        ).auctions,
        []
      );
      assert.equal(
        restricted.repository.readAuction(
          detailInput(IDS.restrictedAuction, { nowMs })
        ),
        null
      );
      assert.equal(
        restricted.repository.readAuction(
          detailInput(IDS.restrictedAuction, {
            viewerUserId: IDS.commissionerUser,
            viewerMembershipId: IDS.commissionerMembership,
            nowMs,
          })
        ),
        null
      );
    }
    assert.equal(
      restricted.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      restrictedChangesBeforeReads
    );

    restricted.database
      .prepare(`
        UPDATE free_agent_draft_player_allocations
        SET status = 'restricted_active'
        WHERE id = ?
      `)
      .run(IDS.allocation);
    assert.equal(
      restricted.repository.readAuction(
        detailInput(IDS.restrictedAuction, {
          nowMs: opensAtMs - 1,
        })
      ),
      null
    );

    const activeManager = restricted.repository.readAuction(
      detailInput(IDS.restrictedAuction, {
        nowMs: opensAtMs,
      })
    );
    assert.equal(activeManager.sourceKind, "fad_restricted");
    assert.deepEqual(activeManager.capabilities.view, {
      allowed: true,
      reasonCode: null,
    });
    assert.deepEqual(
      activeManager.viewerTeams.find(
        ({ teamId }) => teamId === IDS.teamOne
      ).join,
      { allowed: true, reasonCode: null }
    );
    assert.deepEqual(
      activeManager.viewerTeams.find(
        ({ teamId }) => teamId === IDS.teamFour
      ).join,
      {
        allowed: false,
        reasonCode: "TEAM_NOT_PARTICIPANT",
      }
    );
    const activeCommissioner =
      restricted.repository.readAuction(
        detailInput(IDS.restrictedAuction, {
          viewerUserId: IDS.commissionerUser,
          viewerMembershipId: IDS.commissionerMembership,
          nowMs: opensAtMs,
        })
      );
    assert.deepEqual(activeCommissioner.capabilities.adminCancel, {
      allowed: true,
      reasonCode: null,
    });
    assert.deepEqual(activeCommissioner.capabilities.adminResolve, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });
    assert.deepEqual(activeCommissioner.administrativeBids, []);
    assert.deepEqual(
      restricted.repository.listAuctions(
        listInput({
          sourceKind: "fad_restricted",
          fadId: IDS.fad,
          nowMs: opensAtMs,
        })
      ).auctions.map(({ auctionId }) => auctionId),
      [IDS.restrictedAuction]
    );

    restricted.database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended',
          ended_at_ms = @endedAtMs
      WHERE id IN (@assignmentOne, @assignmentTwo)
    `).run({
      assignmentOne: IDS.assignmentOne,
      assignmentTwo: IDS.assignmentTwo,
      endedAtMs: opensAtMs,
    });
    assert.equal(
      restricted.repository.readAuction(
        detailInput(IDS.restrictedAuction, { nowMs: opensAtMs })
      ),
      null
    );
    assert.deepEqual(
      restricted.repository.listAuctions(
        listInput({
          sourceKind: "fad_restricted",
          fadId: IDS.fad,
          nowMs: opensAtMs,
        })
      ).auctions,
      []
    );
    assert.equal(
      restricted.repository.readAuction(
        detailInput(IDS.restrictedAuction, {
          viewerUserId: IDS.commissionerUser,
          viewerMembershipId: IDS.commissionerMembership,
          nowMs: opensAtMs,
        })
      ).auctionId,
      IDS.restrictedAuction
    );

    const openRapid = createRuntime(t);
    seedFadRoot(openRapid.database);
    seedAuction(openRapid.database, {
      id: IDS.openFadAuction,
      playerId: IDS.playerOne,
      openedAtMs: opensAtMs,
      resolvesAtMs: NOW_MS + 23 * HOUR_MS,
      sourceKind: "fad_open_rapid",
      fadId: IDS.fad,
      fadRolloverId: IDS.rollover,
      fadOrigin: "manager_nomination",
    });
    seedBid(openRapid.database, {
      id: IDS.openFadWithdrawnBid,
      auctionId: IDS.openFadAuction,
      teamId: IDS.teamOne,
      totalValueCents: 600,
      firstSubmittedAtMs: opensAtMs,
      lastEditedAtMs: opensAtMs,
      status: "withdrawn",
    });
    seedStartedEvent(openRapid.database, {
      id: IDS.openFadStartEvent,
      auctionId: IDS.openFadAuction,
      bidId: IDS.openFadWithdrawnBid,
      teamId: IDS.teamOne,
      occurredAtMs: opensAtMs,
    });
    const nonceBytes = Buffer.alloc(32, 17);
    const commitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.openFadAuction,
        nonceBytes,
      });
    insert(openRapid.database, "free_agent_draft_draws", {
      id: IDS.openFadDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.openFadAuction,
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
      created_at_ms: opensAtMs,
    });
    assert.deepEqual(
      openRapid.repository.listAuctions(
        listInput({
          sourceKind: "fad_open_rapid",
          fadId: IDS.fad,
          nowMs: opensAtMs - 1,
        })
      ).auctions,
      []
    );
    assert.equal(
      openRapid.repository.readAuction(
        detailInput(IDS.openFadAuction, {
          nowMs: opensAtMs - 1,
        })
      ),
      null
    );
    const openedRapid = openRapid.repository.readAuction(
      detailInput(IDS.openFadAuction, {
        nowMs: opensAtMs,
      })
    );
    assert.equal(openedRapid.sourceKind, "fad_open_rapid");
    assert.deepEqual(
      openedRapid.viewerTeams.find(
        ({ teamId }) => teamId === IDS.teamOne
      ).join,
      { allowed: true, reasonCode: null }
    );
    const openedRapidCommissioner =
      openRapid.repository.readAuction(
        detailInput(IDS.openFadAuction, {
          viewerUserId: IDS.commissionerUser,
          viewerMembershipId: IDS.commissionerMembership,
          nowMs: opensAtMs,
        })
      );
    assert.deepEqual(
      openedRapidCommissioner.capabilities.adminCancel,
      {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      }
    );
  });

  test("projects restricted eligibility without inferring bids and reveals only auditable terminal FAD evidence", (t) => {
    const runtime = createRuntime(t);
    seedRestrictedAuction(runtime.database);

    const active = runtime.repository.readAuction(
      detailInput(IDS.restrictedAuction)
    );
    assert.equal(active.sourceKind, "fad_restricted");
    assert.equal(active.fadOrigin, "candidate_tie_restricted");
    assert.deepEqual(active.minimumContract, {
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
    });
    const restrictedCommitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.restrictedAuction,
        nonceBytes: Buffer.alloc(32, 7),
      }).commitmentHex;
    assert.equal(active.drawCommitment, restrictedCommitment);
    assert.deepEqual(active.eligibleTeams, []);
    assert.deepEqual(
      active.viewerTeams.map((row) => ({
        teamId: row.teamId,
        eligible: row.eligible,
        participantStatus: row.participantStatus,
        hasBid: row.bid !== null,
      })),
      [
        {
          teamId: IDS.teamOne,
          eligible: true,
          participantStatus: "active",
          hasBid: true,
        },
        {
          teamId: IDS.teamTwo,
          eligible: true,
          participantStatus: "active",
          hasBid: false,
        },
        {
          teamId: IDS.teamFour,
          eligible: false,
          participantStatus: null,
          hasBid: false,
        },
      ]
    );
    assert.equal(
      active.viewerTeams[0].bid.bindingIllegalityConfirmedAtMs,
      NOW_MS - 2 * HOUR_MS
    );
    assert.deepEqual(active.viewerTeams[2].join, {
      allowed: false,
      reasonCode: "TEAM_NOT_PARTICIPANT",
    });
    assert.equal(JSON.stringify(active).includes("987"), false);
    assert.equal(active.result, null);

    runtime.database
      .prepare(
        "UPDATE free_agent_draft_auction_participants SET status = 'removed' WHERE id = ?"
      )
      .run(IDS.participantTwo);
    const afterParticipantRemoval =
      runtime.repository.readAuction(
        detailInput(IDS.restrictedAuction)
      );
    assert.equal(
      validateAuctionReadProjection(afterParticipantRemoval),
      afterParticipantRemoval
    );
    assert.deepEqual(afterParticipantRemoval.eligibleTeams, []);
    const removedTeam =
      afterParticipantRemoval.viewerTeams.find(
        ({ teamId }) => teamId === IDS.teamTwo
      );
    assert.equal(removedTeam.eligible, false);
    assert.equal(removedTeam.participantStatus, "removed");
    assert.deepEqual(removedTeam.join, {
      allowed: false,
      reasonCode: "TEAM_NOT_PARTICIPANT",
    });

    runtime.database
      .prepare(
        "DELETE FROM free_agent_draft_auction_participants WHERE id = ?"
      )
      .run(IDS.participantThree);
    assert.throws(
      () =>
        runtime.repository.readAuction(
          detailInput(IDS.restrictedAuction, {
            viewerUserId: IDS.commissionerUser,
            viewerMembershipId: IDS.commissionerMembership,
          })
        ),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        /no participant identity/u.test(error.message)
    );
    insert(
      runtime.database,
      "free_agent_draft_auction_participants",
      {
        id: IDS.participantThree,
        league_id: IDS.league,
        season_id: IDS.season,
        fad_id: IDS.fad,
        allocation_id: IDS.allocation,
        auction_id: IDS.restrictedAuction,
        team_id: IDS.teamThree,
        status: "active",
        manager_edit_limit: 1,
        cooldown_duration_ms: 4_500_000,
        current_cooldown_anchor_at_ms:
          NOW_MS - 2 * HOUR_MS,
        improvement_committed_at_ms:
          NOW_MS - 2 * HOUR_MS,
      }
    );

    assert.deepEqual(
      runtime.repository.listAuctions(
        listInput({
          sourceKind: "fad_restricted",
          fadId: IDS.fad,
        })
      ).startTeams.map((row) => ({
        teamId: row.teamId,
        sourceKind: row.sourceKind,
        fadId: row.fadId,
        allowed: row.startAuction.allowed,
        reasonCode: row.startAuction.reasonCode,
      })),
      [
        {
          teamId: IDS.teamOne,
          sourceKind: "fad_open_rapid",
          fadId: IDS.fad,
          allowed: true,
          reasonCode: null,
        },
        {
          teamId: IDS.teamTwo,
          sourceKind: "fad_open_rapid",
          fadId: IDS.fad,
          allowed: true,
          reasonCode: null,
        },
        {
          teamId: IDS.teamFour,
          sourceKind: "fad_open_rapid",
          fadId: IDS.fad,
          allowed: false,
          reasonCode: "TEAM_NOT_PARTICIPANT",
        },
      ]
    );

    const tieReveal =
      createFreeAgentDraftAuctionDrawReveal({
        auctionId: IDS.restrictedAuction,
        commitmentHex: restrictedCommitment,
        nonceBytes: Buffer.alloc(32, 7),
        rolloverAtMs: NOW_MS + 23 * HOUR_MS,
        tiedBidIds: [
          IDS.restrictedBidOne,
          IDS.restrictedBidThree,
        ],
      });
    const selectedTeamId =
      tieReveal.selectedBidId === IDS.restrictedBidOne
        ? IDS.teamOne
        : IDS.teamThree;
    runtime.database
      .prepare(`
        UPDATE auctions
        SET status = 'resolved',
            updated_at_ms = @resolvedAtMs,
            version = 2
        WHERE id = @auctionId
      `)
      .run({
        auctionId: IDS.restrictedAuction,
        resolvedAtMs: NOW_MS + 23 * HOUR_MS,
      });
    runtime.database
      .prepare(
        "UPDATE auction_bids SET status = CASE id WHEN @winner THEN 'won' ELSE 'lost' END, version = 2 WHERE auction_id = @auctionId"
      )
      .run({
        winner: tieReveal.selectedBidId,
        auctionId: IDS.restrictedAuction,
      });
    runtime.database
      .prepare(`
        UPDATE free_agent_draft_draws
        SET ordered_tied_bid_ids_json = @bidIds,
            ordered_tied_team_ids_json = @teamIds,
            rejection_counter = @counter,
            selected_index = @selectedIndex,
            selected_bid_id = @selectedBidId,
            selected_team_id = @selectedTeamId,
            selected_digest_hex = @digest,
            revealed_at_ms = @revealedAtMs
        WHERE id = @drawId
      `)
      .run({
        bidIds: JSON.stringify([
          IDS.restrictedBidOne,
          IDS.restrictedBidThree,
        ]),
        teamIds: JSON.stringify([
          IDS.teamOne,
          IDS.teamThree,
        ]),
        counter: tieReveal.counter,
        selectedIndex: tieReveal.selectedIndex,
        selectedBidId: tieReveal.selectedBidId,
        selectedTeamId,
        digest: tieReveal.digestHex,
        revealedAtMs: NOW_MS + 23 * HOUR_MS,
        drawId: IDS.restrictedDraw,
      });
    insert(runtime.database, "auction_resolutions", {
      id: IDS.restrictedResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.restrictedAuction,
      winning_bid_id: tieReveal.selectedBidId,
      winning_team_id: selectedTeamId,
      final_contract_value_cents: 700,
      final_aav_cents: 350,
      contract_id: uuid(70),
      ownership_id: uuid(71),
      status: "resolved",
      resolved_at_ms: NOW_MS + 23 * HOUR_MS,
    });
    insert(runtime.database, "league_activity", {
      id: IDS.restrictedActivity,
      league_id: IDS.league,
      related_type: "auction_resolution",
      related_id: IDS.restrictedResolution,
      metadata_json: JSON.stringify({
        auctionId: IDS.restrictedAuction,
      }),
      occurred_at_ms: NOW_MS + 23 * HOUR_MS,
    });

    const terminal = runtime.repository.readAuction(
      detailInput(IDS.restrictedAuction, {
        nowMs: NOW_MS + DAY_MS,
      })
    );
    assert.equal(terminal.status, "resolved");
    assert.deepEqual(terminal.result.drawEvidence, {
      commitmentHex: restrictedCommitment,
      reveal: {
        ...tieReveal,
        selectedTeamId,
      },
    });

    seedAuction(runtime.database, {
      id: IDS.nonTieAuction,
      playerId: IDS.playerTwo,
      status: "resolved",
      resolvesAtMs: NOW_MS + 23 * HOUR_MS,
      updatedAtMs: NOW_MS + 23 * HOUR_MS,
      version: 2,
      sourceKind: "fad_open_rapid",
      fadId: IDS.fad,
      fadRolloverId: IDS.rollover,
      fadOrigin: "manager_nomination",
    });
    seedBid(runtime.database, {
      id: IDS.nonTieBid,
      auctionId: IDS.nonTieAuction,
      teamId: IDS.teamTwo,
      totalValueCents: 500,
      status: "won",
      version: 2,
    });
    seedStartedEvent(runtime.database, {
      id: IDS.nonTieStartEvent,
      auctionId: IDS.nonTieAuction,
      bidId: IDS.nonTieBid,
      teamId: IDS.teamTwo,
      occurredAtMs: NOW_MS - HOUR_MS,
    });
    const nonTieNonceBytes = Buffer.alloc(32, 11);
    const nonTieCommitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.nonTieAuction,
        nonceBytes: nonTieNonceBytes,
      }).commitmentHex;
    const noSelectionReveal =
      createFreeAgentDraftAuctionNoSelectionReveal({
        auctionId: IDS.nonTieAuction,
        commitmentHex: nonTieCommitment,
        nonceBytes: nonTieNonceBytes,
      });
    insert(runtime.database, "free_agent_draft_draws", {
      id: IDS.nonTieDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.nonTieAuction,
      algorithm_version: 1,
      nonce_bytes: nonTieNonceBytes,
      commitment_hex: nonTieCommitment,
      ordered_tied_bid_ids_json: JSON.stringify([]),
      ordered_tied_team_ids_json: JSON.stringify([]),
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: NOW_MS + 23 * HOUR_MS,
      created_at_ms: NOW_MS - HOUR_MS,
    });
    insert(runtime.database, "auction_resolutions", {
      id: IDS.nonTieResolution,
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.nonTieAuction,
      winning_bid_id: IDS.nonTieBid,
      winning_team_id: IDS.teamTwo,
      final_contract_value_cents: 500,
      final_aav_cents: 500,
      contract_id: uuid(65),
      ownership_id: uuid(66),
      status: "resolved",
      resolved_at_ms: NOW_MS + 23 * HOUR_MS,
    });
    insert(runtime.database, "league_activity", {
      id: IDS.nonTieActivity,
      league_id: IDS.league,
      related_type: "auction_resolution",
      related_id: IDS.nonTieResolution,
      metadata_json: JSON.stringify({
        auctionId: IDS.nonTieAuction,
      }),
      occurred_at_ms: NOW_MS + 23 * HOUR_MS,
    });
    const nonTieTerminal = runtime.repository.readAuction(
      detailInput(IDS.nonTieAuction, {
        nowMs: NOW_MS + DAY_MS,
      })
    );
    assert.deepEqual(nonTieTerminal.result.drawEvidence, {
      commitmentHex: nonTieCommitment,
      reveal: {
        ...noSelectionReveal,
        selectedTeamId: null,
      },
    });

    seedAuction(runtime.database, {
      id: IDS.failedAuction,
      playerId: IDS.playerFour,
      status: "failed",
      resolvesAtMs: NOW_MS + 23 * HOUR_MS,
      updatedAtMs: NOW_MS + 4 * DAY_MS,
      sourceKind: "fad_open_rapid",
      fadId: IDS.fad,
      fadRolloverId: IDS.rollover,
      fadOrigin: "manager_nomination",
    });
    seedBid(runtime.database, {
      id: IDS.failedStarterBid,
      auctionId: IDS.failedAuction,
      teamId: IDS.teamOne,
      totalValueCents: 600,
      firstSubmittedAtMs: NOW_MS - HOUR_MS,
      lastEditedAtMs: NOW_MS - HOUR_MS,
      status: "invalid",
    });
    seedStartedEvent(runtime.database, {
      id: IDS.failedStartEvent,
      auctionId: IDS.failedAuction,
      bidId: IDS.failedStarterBid,
      teamId: IDS.teamOne,
      occurredAtMs: NOW_MS - HOUR_MS,
    });
    const failedNonceBytes = Buffer.alloc(32, 9);
    const failedCommitment =
      createFreeAgentDraftAuctionDrawCommitment({
        auctionId: IDS.failedAuction,
        nonceBytes: failedNonceBytes,
      }).commitmentHex;
    insert(runtime.database, "free_agent_draft_draws", {
      id: IDS.failedDraw,
      league_id: IDS.league,
      season_id: IDS.season,
      fad_id: IDS.fad,
      allocation_id: null,
      auction_id: IDS.failedAuction,
      algorithm_version: 1,
      nonce_bytes: failedNonceBytes,
      commitment_hex: failedCommitment,
      ordered_tied_bid_ids_json: null,
      ordered_tied_team_ids_json: null,
      rejection_counter: null,
      selected_index: null,
      selected_bid_id: null,
      selected_team_id: null,
      selected_digest_hex: null,
      revealed_at_ms: null,
      created_at_ms: NOW_MS - HOUR_MS,
    });
    insert(runtime.database, "free_agent_draft_recoveries", {
      id: IDS.failedRecovery,
      league_id: IDS.league,
      auction_id: IDS.failedAuction,
      kind: "auction_resolution",
      status: "correction_required",
      created_at_ms: NOW_MS + 4 * DAY_MS,
    });
    const failed = runtime.repository.readAuction(
      detailInput(IDS.failedAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
        nowMs: NOW_MS + 5 * DAY_MS,
      })
    );
    assert.equal(failed.sourceKind, "fad_open_rapid");
    assert.equal(failed.fadOrigin, "manager_nomination");
    assert.equal(failed.status, "correction_required");
    assert.equal(failed.drawCommitment, failedCommitment);
    assert.equal(failed.result.outcomeCode, "correction_required");
    assert.equal(failed.result.recoveryId, IDS.failedRecovery);
    assert.deepEqual(failed.result.drawEvidence, {
      commitmentHex: failedCommitment,
      reveal: null,
    });
    assert.deepEqual(failed.capabilities.adminCancel, {
      allowed: true,
      reasonCode: null,
    });
  });

  test("blocks manager join, edit, and auction starts while the league is frozen", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    runtime.database
      .prepare("UPDATE leagues SET status = 'frozen' WHERE id = ?")
      .run(IDS.league);

    const result = runtime.repository.listAuctions(listInput());
    const auction = result.auctions[0];
    const biddingTeam = auction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamOne
    );
    const joiningTeam = auction.viewerTeams.find(
      ({ teamId }) => teamId === IDS.teamTwo
    );
    assert.deepEqual(biddingTeam.edit, {
      allowed: false,
      reasonCode: "LEAGUE_FROZEN",
    });
    assert.deepEqual(joiningTeam.join, {
      allowed: false,
      reasonCode: "LEAGUE_FROZEN",
    });
    assert.equal(
      result.startTeams.every(
        ({ startAuction }) =>
          startAuction.allowed === false &&
          startAuction.reasonCode === "LEAGUE_FROZEN"
      ),
      true
    );
  });

  test("does not advertise manager or administrative auction commands outside active or frozen league operation", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    runtime.database
      .prepare("UPDATE leagues SET status = 'completed' WHERE id = ?")
      .run(IDS.league);

    const manager = runtime.repository.listAuctions(
      listInput()
    );
    for (const viewerTeam of manager.auctions[0].viewerTeams) {
      assert.equal(viewerTeam.join.allowed, false);
      assert.equal(viewerTeam.edit.allowed, false);
      assert.equal(
        viewerTeam.join.reasonCode,
        "PHASE_CLOSED"
      );
      assert.equal(
        viewerTeam.edit.reasonCode,
        "PHASE_CLOSED"
      );
    }
    assert.equal(
      manager.startTeams.every(
        ({ startAuction }) =>
          startAuction.allowed === false &&
          startAuction.reasonCode === "PHASE_CLOSED"
      ),
      true
    );

    const commissioner = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction, {
        viewerUserId: IDS.commissionerUser,
        viewerMembershipId: IDS.commissionerMembership,
      })
    );
    for (const bid of commissioner.administrativeBids) {
      assert.deepEqual(bid.capabilities, {
        adminEditBid: {
          allowed: false,
          reasonCode: "PHASE_CLOSED",
        },
        adminRemoveBid: {
          allowed: false,
          reasonCode: "PHASE_CLOSED",
        },
      });
    }
    assert.deepEqual(commissioner.capabilities.adminCancel, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });
    assert.deepEqual(commissioner.capabilities.adminResolve, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });

    runtime.database
      .prepare("UPDATE leagues SET status = 'setup' WHERE id = ?")
      .run(IDS.league);
    const setupAuction = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction)
    );
    assert.deepEqual(
      setupAuction.viewerTeams.find(
        ({ teamId }) => teamId === IDS.teamOne
      ).edit,
      {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      }
    );
  });

  test("does not expose a completed FAD rollover as the current auction-start window", (t) => {
    const runtime = createRuntime(t);
    seedFadRoot(runtime.database);
    runtime.database
      .prepare(
        "UPDATE free_agent_draft_rollovers SET status = 'completed' WHERE id = ?"
      )
      .run(IDS.rollover);

    const startTeam = runtime.repository
      .listAuctions(listInput())
      .startTeams.find(({ teamId }) => teamId === IDS.teamOne);
    assert.equal(startTeam.sourceKind, "fad_open_rapid");
    assert.equal(startTeam.fadId, IDS.fad);
    assert.equal(startTeam.fadRolloverId, null);
    assert.equal(startTeam.targetRolloverAtMs, null);
    assert.equal(startTeam.creationCutoffAtMs, null);
    assert.deepEqual(startTeam.startAuction, {
      allowed: false,
      reasonCode: "PHASE_CLOSED",
    });
  });

  test("advertises nominations after the Candidate Card deadline while restricted ties still allocate", (t) => {
    const runtime = createRuntime(t);
    seedFadRoot(runtime.database);
    runtime.database.prepare(`
      UPDATE free_agent_drafts
      SET status = 'allocating',
          candidate_deadline_at_ms = @deadlineAtMs,
          deadline_locked_at_ms = @deadlineAtMs,
          allocation_completed_at_ms = NULL
      WHERE id = @fadId
    `).run({
      deadlineAtMs: NOW_MS - 1,
      fadId: IDS.fad,
    });

    const startTeam = runtime.repository
      .listAuctions(listInput())
      .startTeams.find(({ teamId }) => teamId === IDS.teamOne);
    assert.equal(startTeam.sourceKind, "fad_open_rapid");
    assert.deepEqual(startTeam.startAuction, {
      allowed: true,
      reasonCode: null,
    });
  });

  test("scopes collection and detail reads to the authorized league in real SQLite state", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    seedSecondLeague(runtime.database);

    assert.deepEqual(
      runtime.repository
        .listAuctions(listInput())
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.ordinaryAuction, IDS.secondActiveAuction]
    );
    assert.deepEqual(
      runtime.repository
        .listAuctions(
          listInput({
            leagueId: IDS.secondLeague,
            viewerMembershipId: IDS.secondMembership,
          })
        )
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.secondLeagueAuction]
    );
    assert.equal(
      runtime.repository.readAuction(
        detailInput(IDS.secondLeagueAuction)
      ),
      null
    );
    assert.equal(
      runtime.repository.readAuction(
        detailInput(IDS.ordinaryAuction, {
          leagueId: IDS.secondLeague,
          viewerMembershipId: IDS.secondMembership,
        })
      ),
      null
    );
  });

  test("projects only bounded query matches so out-of-page corruption cannot break a safe page", (t) => {
    const paged = createRuntime(t);
    seedOrdinaryActiveAuctions(paged.database);
    seedContextlessAuction(paged.database, {
      id: IDS.lateCorruptAuction,
      playerId: IDS.playerFour,
      resolvesAtMs: NOW_MS + 3 * DAY_MS,
    });
    assert.deepEqual(
      paged.repository
        .listAuctions(listInput({ limit: 1 }))
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.ordinaryAuction]
    );

    const queried = createRuntime(t);
    seedOrdinaryActiveAuctions(queried.database);
    seedContextlessAuction(queried.database, {
      id: IDS.earlyCorruptAuction,
      playerId: IDS.playerFour,
      resolvesAtMs: NOW_MS + HOUR_MS,
    });
    assert.deepEqual(
      queried.repository
        .listAuctions(listInput({ q: "alex" }))
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.ordinaryAuction]
    );
  });

  test("executes one exact normalized search beyond the former scan boundary and preserves query cursors", (t) => {
    const runtime = createRuntime(t);
    const matchingAuctionIds = [];
    for (let index = 0; index < 130; index += 1) {
      const playerId = uuid(10_000 + index);
      const auctionId = uuid(20_000 + index);
      const matches = index >= 128;
      seedPlayer(
        runtime.database,
        playerId,
        matches
          ? index === 128
            ? "  ÉLODIE\t  O’Connor  "
            : "élodie o’connor"
          : `Unmatched Player ${index}`,
        index % 2 === 0 ? "F" : "D"
      );
      seedAuction(runtime.database, {
        id: auctionId,
        playerId,
        resolvesAtMs:
          NOW_MS + DAY_MS + index * 1_000,
      });
      if (matches) matchingAuctionIds.push(auctionId);
    }

    const first = runtime.repository.listAuctions(
      listInput({
        q: "élodie o’connor",
        limit: 1,
      })
    );
    assert.deepEqual(
      first.auctions.map(({ auctionId }) => auctionId),
      [matchingAuctionIds[0]]
    );
    const second = runtime.repository.listAuctions(
      listInput({
        q: "élodie o’connor",
        limit: 1,
        cursor: {
          sortMs: first.auctions[0].resolvesAtMs,
          auctionId: first.auctions[0].auctionId,
        },
      })
    );
    assert.deepEqual(
      second.auctions.map(({ auctionId }) => auctionId),
      [matchingAuctionIds[1]]
    );
    assert.deepEqual(
      runtime.repository.listAuctions(
        listInput({
          q: "missing unicode",
          limit: 1,
        })
      ).auctions,
      []
    );
  });

  test("advances descending terminal cursors deterministically across equal timestamps", (t) => {
    const runtime = createRuntime(t);
    const terminalAtMs = NOW_MS - DAY_MS;
    seedAuction(runtime.database, {
      id: IDS.cancelledTieAuctionOne,
      playerId: IDS.playerOne,
      status: "cancelled",
      resolvesAtMs: NOW_MS - 2 * DAY_MS,
      updatedAtMs: terminalAtMs,
    });
    seedAuction(runtime.database, {
      id: IDS.cancelledTieAuctionTwo,
      playerId: IDS.playerTwo,
      status: "cancelled",
      resolvesAtMs: NOW_MS - 2 * DAY_MS,
      updatedAtMs: terminalAtMs,
    });
    for (const [id, auctionId] of [
      [IDS.cancelledTieResolutionOne, IDS.cancelledTieAuctionOne],
      [IDS.cancelledTieResolutionTwo, IDS.cancelledTieAuctionTwo],
    ]) {
      insert(runtime.database, "auction_resolutions", {
        id,
        league_id: IDS.league,
        season_id: IDS.season,
        auction_id: auctionId,
        winning_bid_id: null,
        winning_team_id: null,
        final_contract_value_cents: null,
        final_aav_cents: null,
        contract_id: null,
        ownership_id: null,
        status: "cancelled",
        resolved_at_ms: terminalAtMs,
      });
    }

    const query = {
      statuses: ["cancelled"],
      limit: 1,
      order: "resolved_desc",
    };
    assert.deepEqual(
      runtime.repository
        .listAuctions(listInput(query))
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.cancelledTieAuctionOne]
    );
    assert.deepEqual(
      runtime.repository
        .listAuctions(
          listInput({
            ...query,
            cursor: {
              sortMs: terminalAtMs,
              auctionId: IDS.cancelledTieAuctionOne,
            },
          })
        )
        .auctions.map(({ auctionId }) => auctionId),
      [IDS.cancelledTieAuctionTwo]
    );
  });

  test("revalidates membership and derives administrative visibility without trusting caller flags", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    assert.throws(
      () =>
        runtime.repository.readAuction(
          detailInput(IDS.ordinaryAuction, {
            viewerUserId: IDS.inactiveUser,
            viewerMembershipId: IDS.inactiveMembership,
          })
        ),
      (error) =>
        error.code ===
          AUCTION_READ_REPOSITORY_CODES.authorizationDenied
    );
    assert.throws(
      () =>
        runtime.repository.listAuctions({
          ...listInput(),
          isCommissioner: true,
        }),
      (error) => error.code === "REPOSITORY_ARGUMENT_INVALID"
    );
  });

  test("rejects active-status ended memberships without falling through to another league", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    seedSecondLeague(runtime.database);
    runtime.database
      .prepare(`
        UPDATE league_memberships
        SET ended_at_ms = @endedAtMs
        WHERE league_id = @leagueId
          AND id = @membershipId
          AND status = 'active'
      `)
      .run({
        endedAtMs: NOW_MS,
        leagueId: IDS.league,
        membershipId: IDS.managerMembership,
      });
    const before = noWriteSnapshot(runtime.database);

    for (const read of [
      () => runtime.repository.listAuctions(listInput()),
      () =>
        runtime.repository.readAuction(
          detailInput(IDS.ordinaryAuction)
        ),
    ]) {
      assert.throws(read, {
        code: AUCTION_READ_REPOSITORY_CODES.authorizationDenied,
      });
    }
    const secondLeague = runtime.repository.listAuctions(
      listInput({
        leagueId: IDS.secondLeague,
        viewerMembershipId: IDS.secondMembership,
      })
    );
    assert.deepEqual(
      secondLeague.auctions.map(({ auctionId }) => auctionId),
      [IDS.secondLeagueAuction]
    );
    const serialized = JSON.stringify(secondLeague);
    for (const forbiddenId of [
      IDS.ordinaryAuction,
      IDS.secondActiveAuction,
      IDS.ordinaryBidOne,
      IDS.ordinaryBidThree,
    ]) {
      assert.equal(serialized.includes(forbiddenId), false);
    }
    assertNoWrites(runtime.database, before);
  });

  test("withholds manager bids and administrative projections from stale assignment and role rows", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    assert.equal(
      runtime.database
        .prepare(`
          UPDATE team_manager_assignments
          SET accepted_at_ms = NULL
          WHERE league_id = @leagueId
            AND user_id = @userId
            AND status = 'accepted'
            AND ended_at_ms IS NULL
        `)
        .run({
          leagueId: IDS.league,
          userId: IDS.managerUser,
        }).changes,
      3
    );
    assert.equal(
      runtime.database
        .prepare(`
          UPDATE platform_roles
          SET ended_at_ms = @endedAtMs
          WHERE id = @roleId
            AND status = 'active'
        `)
        .run({
          endedAtMs: NOW_MS,
          roleId: IDS.administratorRole,
        }).changes,
      1
    );
    const staleBefore = noWriteSnapshot(runtime.database);

    const managerList = runtime.repository.listAuctions(
      listInput()
    );
    const managerAuction = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction)
    );
    const endedRoleAdministrator =
      runtime.repository.readAuction(
        detailInput(IDS.ordinaryAuction, {
          viewerUserId: IDS.administratorUser,
          viewerMembershipId: IDS.administratorMembership,
        })
      );
    assert.deepEqual(managerList.startTeams, []);
    assert.deepEqual(managerAuction.viewerTeams, []);
    assert.deepEqual(managerAuction.administrativeBids, []);
    assert.deepEqual(
      endedRoleAdministrator.viewerTeams,
      []
    );
    assert.deepEqual(
      endedRoleAdministrator.administrativeBids,
      []
    );
    const staleProjection = JSON.stringify({
      managerList,
      managerAuction,
      endedRoleAdministrator,
    });
    for (const privateValue of [
      IDS.ordinaryBidOne,
      IDS.ordinaryBidThree,
      "600",
      "987",
    ]) {
      assert.equal(
        staleProjection.includes(privateValue),
        false
      );
    }
    const currentCommissioner =
      runtime.repository.readAuction(
        detailInput(IDS.ordinaryAuction, {
          viewerUserId: IDS.commissionerUser,
          viewerMembershipId: IDS.commissionerMembership,
        })
      );
    assert.equal(
      currentCommissioner.administrativeBids.length,
      2
    );
    assertNoWrites(runtime.database, staleBefore);

    assert.equal(
      runtime.database
        .prepare(`
          UPDATE team_manager_assignments
          SET status = 'ended',
              ended_at_ms = @endedAtMs
          WHERE id = @assignmentId
        `)
        .run({
          assignmentId: IDS.assignmentOne,
          endedAtMs: NOW_MS,
        }).changes,
      1
    );
    insert(runtime.database, "team_manager_assignments", {
      id: IDS.replacementAssignment,
      league_id: IDS.league,
      team_id: IDS.teamOne,
      user_id: IDS.managerUser,
      membership_id: IDS.managerMembership,
      status: "accepted",
      accepted_at_ms: NOW_MS,
      ended_at_ms: null,
    });
    const replacementBefore = noWriteSnapshot(runtime.database);
    const replacement = runtime.repository.readAuction(
      detailInput(IDS.ordinaryAuction)
    );
    assert.deepEqual(
      replacement.viewerTeams.map(({ teamId }) => teamId),
      [IDS.teamOne]
    );
    assert.equal(
      replacement.viewerTeams[0].bid.totalValueCents,
      600
    );
    assertNoWrites(runtime.database, replacementBefore);
  });

  test("accepts only null or canonical Unicode-bounded player queries at the persistence boundary", (t) => {
    const runtime = createRuntime(t);
    seedOrdinaryActiveAuctions(runtime.database);
    assert.doesNotThrow(() =>
      runtime.repository.listAuctions(
        listInput({ q: "🏒".repeat(200) })
      )
    );
    for (const q of [
      "Alex",
      "alex  example",
      "alex\nexample",
      "alex\texample",
      "🏒".repeat(201),
      "",
    ]) {
      assert.throws(
        () =>
          runtime.repository.listAuctions(listInput({ q })),
        (error) => error.code === "REPOSITORY_ARGUMENT_INVALID"
      );
    }
  });

  test("performs no hidden writes and fails closed on missing or ambiguous auction evidence", (t) => {
    const ordinary = createRuntime(t);
    seedOrdinaryActiveAuctions(ordinary.database);
    const changesBeforeReads = ordinary.database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    assert.equal(
      ordinary.repository.listAuctions(listInput())
        .auctions.length,
      2
    );
    assert.equal(
      ordinary.repository.readAuction(
        detailInput(IDS.ordinaryAuction)
      ).auctionId,
      IDS.ordinaryAuction
    );
    assert.equal(
      ordinary.database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      changesBeforeReads
    );

    insert(ordinary.database, "auction_contexts", {
      id: uuid(72),
      league_id: IDS.league,
      season_id: IDS.season,
      auction_id: IDS.ordinaryAuction,
      source_kind: "ordinary_weekly",
      fad_id: null,
      fad_rollover_id: null,
      fad_allocation_id: null,
      fad_origin: null,
      created_at_ms: NOW_MS - HOUR_MS,
    });
    assert.throws(
      () =>
        ordinary.repository.readAuction(
          detailInput(IDS.ordinaryAuction)
        ),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        /exactly one canonical context/u.test(error.message)
    );

    ordinary.database
      .prepare(
        "DELETE FROM auction_contexts WHERE auction_id = ?"
      )
      .run(IDS.ordinaryAuction);
    assert.throws(
      () =>
        ordinary.repository.readAuction(
          detailInput(IDS.ordinaryAuction)
        ),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        /exactly one canonical context/u.test(error.message)
    );

    const restricted = createRuntime(t);
    seedRestrictedAuction(restricted.database);
    restricted.database
      .prepare(
        "DELETE FROM free_agent_draft_draws WHERE auction_id = ?"
      )
      .run(IDS.restrictedAuction);
    assert.throws(
      () =>
        restricted.repository.readAuction(
          detailInput(IDS.restrictedAuction)
        ),
      (error) =>
        error.code === "REPOSITORY_SCHEMA_INCOMPATIBLE" &&
        /exactly one draw commitment/u.test(error.message)
    );
  });
});
