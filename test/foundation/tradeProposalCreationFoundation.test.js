const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  TRADE_ASSET_CODES,
  TradeAssetPolicyError,
  createTradeAssetCommands,
  validateTradeProposalCreationInput,
} = require("../../src/domain/trades/tradeAssetPolicy");
const {
  TradeLifecyclePolicyError,
} = require("../../src/domain/trades/tradeLifecyclePolicy");
const {
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
} = require("../../src/domain/trades/tradeExecutionPolicy");
const {
  TRADE_REVERSAL_CODES,
  TRADE_REVERSAL_REASON_CODES,
  TradeReversalPolicyError,
  validateTradeRecoveryWriteInput,
  validateTradeReversalPreviewInput,
} = require("../../src/domain/trades/tradeReversalPolicy");
const {
  createTradeProposalService,
} = require("../../src/application/services/trades/createTradeProposalService");
const {
  createTradeReadService,
} = require("../../src/application/services/trades/createTradeReadService");
const {
  createRespondToTradeProposalService,
} = require("../../src/application/services/trades/respondToTradeProposalService");
const {
  createPreviewTradeAcceptanceService,
} = require("../../src/application/services/trades/previewTradeAcceptanceService");
const {
  IDEMPOTENCY_LIFETIME_MS,
  createAcceptTradeProposalService,
} = require("../../src/application/services/trades/acceptTradeProposalService");
const {
  createTradeReversalService,
} = require("../../src/application/services/trades/createTradeReversalService");
const {
  createLeagueAuthorizationService,
} = require("../../src/application/services/authorization/requireLeagueAuthority");
const {
  createPlatformAuthorizationService,
} = require("../../src/application/services/authorization/requirePlatformAdministrator");
const {
  createTeamAuthorizationService,
} = require("../../src/application/services/authorization/requireTeamManagerAuthority");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const {
  createSqlitePlatformRoleRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqlitePlatformRoleRepository");
const {
  createSqliteTeamAuthorityRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository");
const {
  createSqliteTradeProposalRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  createSqliteTradeReversalRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTradeReversalRepository");
const {
  createSqliteTradeExpiryRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTradeExpiryRepository");
const {
  createSqliteUserRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteUserRepository");
const {
  createSqliteRepositoryContext,
} = require("../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createExpireTradeProposalsJob,
} = require("../../src/jobs/definitions/expireTradeProposals");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const NOW_MS = Date.parse("2026-07-21T19:00:00.000Z");
const TRADE_DEADLINE_MS = NOW_MS + 2 * 24 * 60 * 60 * 1000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  manager: uuid(1),
  receivingManager: uuid(50),
  commissioner: uuid(51),
  platformAdministrator: uuid(55),
  league: uuid(2),
  currentSeason: uuid(3),
  futureSeason: uuid(4),
  teamA: uuid(5),
  teamB: uuid(6),
  membership: uuid(7),
  assignment: uuid(8),
  receivingMembership: uuid(52),
  commissionerMembership: uuid(53),
  platformAdministratorMembership: uuid(56),
  receivingAssignment: uuid(54),
  entryDraft: uuid(9),
  contractPlayer: uuid(10),
  prospectPlayer: uuid(11),
  boughtOutPlayer: uuid(12),
  retentionAssetPlayer: uuid(13),
  contract: uuid(20),
  contractYear: uuid(21),
  ownership: uuid(22),
  prospectOwnership: uuid(23),
  eliminatedContract: uuid(24),
  eliminatedContractYear: uuid(25),
  retentionAssetContract: uuid(26),
  retentionAssetContractYear: uuid(27),
  prospectContract: uuid(60),
  prospectContractYear: uuid(61),
  draftPick: uuid(30),
  retention: uuid(31),
  retentionYear: uuid(32),
  buyout: uuid(33),
  buyoutYear: uuid(34),
  assetRetention: uuid(35),
  assetRetentionYear: uuid(36),
  priorTrade: uuid(40),
  futureConsideration: uuid(41),
});

function authenticated(userId = IDS.manager) {
  return Object.freeze({
    valid: true,
    user: Object.freeze({ id: userId }),
    session: Object.freeze({ userId }),
  });
}

function insertPlayer(repositories, id, lastName) {
  repositories.players.insert({
    id,
    first_name: "Player",
    last_name: lastName,
    full_name: `Player ${lastName}`,
    birth_date: null,
    status: "active",
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
}

function insertContract(repositories, {
  id,
  yearId,
  playerId,
  teamId,
  aavCents,
  status,
}) {
  repositories.contracts.insert({
    id,
    league_id: IDS.league,
    player_id: playerId,
    current_team_id: teamId,
    contract_type: "normal",
    original_total_value_cents: aavCents,
    original_term_years: 1,
    aav_cents: aavCents,
    start_season_id: IDS.currentSeason,
    status,
    acquisition_source_type: "migration",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.contract_years.insert({
    id: yearId,
    league_id: IDS.league,
    contract_id: id,
    season_id: IDS.currentSeason,
    year_number: 1,
    aav_cents: aavCents,
    status: status === "active" ? "current" : "eliminated",
    rollover_at_ms: status === "active" ? null : NOW_MS - 10_000,
    created_at_ms: NOW_MS - 20_000,
  });
}

function seed(repositories) {
  for (const [id, email, name] of [
    [IDS.manager, "manager@example.test", "Manager"],
    [IDS.receivingManager, "receiver@example.test", "Receiver"],
    [IDS.commissioner, "commissioner@example.test", "Commissioner"],
    [
      IDS.platformAdministrator,
      "administrator@example.test",
      "Administrator",
    ],
  ]) {
    repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: name,
      display_name_normalized: name.toLowerCase(),
      status: "active",
      created_at_ms: NOW_MS - 20_000,
      updated_at_ms: NOW_MS - 20_000,
      version: 1,
    });
  }
  repositories.leagues.insert({
    id: IDS.league,
    name: "League",
    name_normalized: "league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.seasons.insert({
    id: IDS.currentSeason,
    league_id: IDS.league,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: NOW_MS - 20_000,
    regular_season_ends_at_ms: NOW_MS + 300_000_000,
    fantasy_playoffs_start_at_ms: NOW_MS + 200_000_000,
    fantasy_playoffs_end_at_ms: NOW_MS + 300_000_000,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
    free_agent_draft_completed_at_ms: NOW_MS - 15_000,
  });
  repositories.seasons.insert({
    id: IDS.futureSeason,
    league_id: IDS.league,
    label: "2027-28",
    nhl_season_key: "20272028",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
    free_agent_draft_completed_at_ms: null,
  });
  repositories.league_settings.insert({
    league_id: IDS.league,
    salary_cap_cents: 10_000,
    trade_deadline_at_ms: TRADE_DEADLINE_MS,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  for (const [id, name] of [
    [IDS.teamA, "Alpha"],
    [IDS.teamB, "Bravo"],
  ]) {
    repositories.teams.insert({
      id,
      league_id: IDS.league,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      primary_colour: null,
      secondary_colour: null,
      logo_reference: null,
      created_at_ms: NOW_MS - 20_000,
      updated_at_ms: NOW_MS - 20_000,
      version: 1,
    });
  }
  repositories.league_memberships.insert({
    id: IDS.membership,
    league_id: IDS.league,
    user_id: IDS.manager,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS - 20_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: IDS.receivingMembership,
    league_id: IDS.league,
    user_id: IDS.receivingManager,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS - 20_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: IDS.commissionerMembership,
    league_id: IDS.league,
    user_id: IDS.commissioner,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS - 20_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: IDS.platformAdministratorMembership,
    league_id: IDS.league,
    user_id: IDS.platformAdministrator,
    permission_category: "member",
    status: "active",
    joined_at_ms: NOW_MS - 20_000,
    ended_at_ms: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: IDS.assignment,
    league_id: IDS.league,
    team_id: IDS.teamA,
    user_id: IDS.manager,
    membership_id: IDS.membership,
    assigned_by_user_id: IDS.manager,
    status: "accepted",
    assigned_at_ms: NOW_MS - 20_000,
    accepted_at_ms: NOW_MS - 19_000,
    ended_at_ms: null,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: IDS.receivingAssignment,
    league_id: IDS.league,
    team_id: IDS.teamB,
    user_id: IDS.receivingManager,
    membership_id: IDS.receivingMembership,
    assigned_by_user_id: IDS.commissioner,
    status: "accepted",
    assigned_at_ms: NOW_MS - 20_000,
    accepted_at_ms: NOW_MS - 19_000,
    ended_at_ms: null,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: IDS.league,
    expectedVersion: 1,
    changes: {
      current_season_id: IDS.currentSeason,
      commissioner_membership_id: IDS.commissionerMembership,
      updated_at_ms: NOW_MS - 10_000,
    },
  });
  repositories.entry_drafts.insert({
    id: IDS.entryDraft,
    league_id: IDS.league,
    season_id: IDS.currentSeason,
    status: "completed",
    rounds: 4,
    pick_clock_seconds: 300,
    starts_at_ms: NOW_MS - 18_000,
    completed_at_ms: NOW_MS - 17_000,
    created_by_user_id: IDS.manager,
    created_at_ms: NOW_MS - 19_000,
    updated_at_ms: NOW_MS - 17_000,
    version: 1,
  });

  insertPlayer(repositories, IDS.contractPlayer, "Contract");
  insertPlayer(repositories, IDS.prospectPlayer, "Prospect");
  insertPlayer(repositories, IDS.boughtOutPlayer, "BoughtOut");
  insertPlayer(repositories, IDS.retentionAssetPlayer, "RetainedAsset");
  insertContract(repositories, {
    id: IDS.contract,
    yearId: IDS.contractYear,
    playerId: IDS.contractPlayer,
    teamId: IDS.teamA,
    aavCents: 1_000,
    status: "active",
  });
  repositories.player_ownerships.insert({
    id: IDS.ownership,
    league_id: IDS.league,
    season_id: IDS.currentSeason,
    player_id: IDS.contractPlayer,
    team_id: IDS.teamA,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "migration",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.player_ownerships.insert({
    id: IDS.prospectOwnership,
    league_id: IDS.league,
    season_id: IDS.currentSeason,
    player_id: IDS.prospectPlayer,
    team_id: IDS.teamA,
    ownership_kind: "Prospect Right",
    roster_category: "Prospect",
    position_group: "F",
    slot_number: null,
    acquired_transaction_type: "entry_draft",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  insertContract(repositories, {
    id: IDS.eliminatedContract,
    yearId: IDS.eliminatedContractYear,
    playerId: IDS.boughtOutPlayer,
    teamId: IDS.teamB,
    aavCents: 300,
    status: "eliminated",
  });
  insertContract(repositories, {
    id: IDS.retentionAssetContract,
    yearId: IDS.retentionAssetContractYear,
    playerId: IDS.retentionAssetPlayer,
    teamId: IDS.teamA,
    aavCents: 200,
    status: "active",
  });
  repositories.draft_picks.insert({
    id: IDS.draftPick,
    league_id: IDS.league,
    draft_id: IDS.entryDraft,
    target_season_id: IDS.futureSeason,
    round_number: 4,
    position_number: 1,
    original_team_id: IDS.teamA,
    current_owner_team_id: IDS.teamA,
    status: "unused",
    selection_id: null,
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.retention_obligations.insert({
    id: IDS.retention,
    league_id: IDS.league,
    contract_id: IDS.contract,
    player_id: IDS.contractPlayer,
    originating_team_id: IDS.teamA,
    responsible_team_id: IDS.teamB,
    retained_aav_cents: 100,
    creation_trade_id: null,
    status: "active",
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.retention_years.insert({
    id: IDS.retentionYear,
    league_id: IDS.league,
    retention_obligation_id: IDS.retention,
    season_id: IDS.currentSeason,
    retained_aav_cents: 100,
    status: "current",
    created_at_ms: NOW_MS - 20_000,
  });
  repositories.retention_obligations.insert({
    id: IDS.assetRetention,
    league_id: IDS.league,
    contract_id: IDS.retentionAssetContract,
    player_id: IDS.retentionAssetPlayer,
    originating_team_id: IDS.teamA,
    responsible_team_id: IDS.teamB,
    retained_aav_cents: 100,
    creation_trade_id: null,
    status: "active",
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.retention_years.insert({
    id: IDS.assetRetentionYear,
    league_id: IDS.league,
    retention_obligation_id: IDS.assetRetention,
    season_id: IDS.currentSeason,
    retained_aav_cents: 100,
    status: "current",
    created_at_ms: NOW_MS - 20_000,
  });
  repositories.buyout_obligations.insert({
    id: IDS.buyout,
    league_id: IDS.league,
    contract_id: IDS.eliminatedContract,
    player_id: IDS.boughtOutPlayer,
    originating_team_id: IDS.teamB,
    responsible_team_id: IDS.teamB,
    annual_penalty_basis_cents: 75,
    buyout_transaction_id: "seed-buyout",
    status: "active",
    created_at_ms: NOW_MS - 20_000,
    updated_at_ms: NOW_MS - 20_000,
    version: 1,
  });
  repositories.buyout_years.insert({
    id: IDS.buyoutYear,
    league_id: IDS.league,
    buyout_obligation_id: IDS.buyout,
    season_id: IDS.currentSeason,
    penalty_cents: 75,
    status: "current",
    created_at_ms: NOW_MS - 20_000,
  });
  repositories.trades.insert({
    id: IDS.priorTrade,
    league_id: IDS.league,
    season_id: IDS.currentSeason,
    proposing_team_id: IDS.teamA,
    receiving_team_id: IDS.teamB,
    proposing_user_id: IDS.manager,
    status: "completed",
    created_at_ms: NOW_MS - 30_000,
    expires_at_ms: NOW_MS - 20_000,
    responded_at_ms: NOW_MS - 25_000,
    completed_at_ms: NOW_MS - 25_000,
    commissioner_completion_reference: null,
    updated_at_ms: NOW_MS - 25_000,
    version: 1,
  });
  repositories.future_considerations.insert({
    id: IDS.futureConsideration,
    league_id: IDS.league,
    season_id: IDS.currentSeason,
    originating_trade_id: IDS.priorTrade,
    owing_team_id: IDS.teamA,
    receiving_team_id: IDS.teamB,
    description: "Conditional future pick",
    status: "outstanding",
    created_at_ms: NOW_MS - 25_000,
    resolved_at_ms: null,
    updated_at_ms: NOW_MS - 25_000,
    version: 1,
  });
}

function creationInput(overrides = {}) {
  return {
    proposingTeamId: IDS.teamA,
    receivingTeamId: IDS.teamB,
    proposingAssets: [
      { type: "contract", contractId: IDS.contract },
      {
        type: "requested_retention",
        contractId: IDS.contract,
        retainedAavCents: 400,
      },
      { type: "prospect_right", playerId: IDS.prospectPlayer },
      { type: "draft_pick", draftPickId: IDS.draftPick },
    ],
    receivingAssets: [
      { type: "buyout_obligation", buyoutObligationId: IDS.buyout },
      {
        type: "future_consideration",
        futureConsiderationId: IDS.futureConsideration,
      },
      {
        type: "future_consideration_instruction",
        description: "Conditional 2028 fourth-round pick",
      },
    ],
    ...overrides,
  };
}

function ordinaryCreationInput(overrides = {}) {
  const input = creationInput();
  return {
    ...input,
    receivingAssets: input.receivingAssets.filter(
      ({ type }) => !type.startsWith("future_consideration")
    ),
    ...overrides,
  };
}

function creationRequestHash(input) {
  const normalized = validateTradeProposalCreationInput(input);
  const assets = createTradeAssetCommands({
    input: normalized,
    assetIds: Array.from(
      {
        length:
          normalized.proposingAssets.length +
          normalized.receivingAssets.length,
      },
      (_, index) => uuid(980_000 + index)
    ),
    createdAtMs: NOW_MS,
  });
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: IDS.league,
        seasonId: IDS.currentSeason,
        proposingTeamId: normalized.proposingTeamId,
        receivingTeamId: normalized.receivingTeamId,
        actorUserId: IDS.manager,
        actorMembershipId: IDS.membership,
        actorAuthority: "manager",
        assets: assets.map(({ id, createdAtMs, ...asset }) => asset),
      }),
      "utf8"
    )
    .digest("hex");
}

function convertCreatedBuyoutToHistoricalRetention(
  runtime,
  tradeId,
  idempotencyKey,
  historicalInput
) {
  const obligation = runtime.database.prepare(`
    SELECT retention.*, player.full_name AS player_name,
      contract.aav_cents
    FROM retention_obligations AS retention
    JOIN players AS player ON player.id = retention.player_id
    JOIN contracts AS contract
      ON contract.league_id = retention.league_id
     AND contract.id = retention.contract_id
    WHERE retention.league_id = ? AND retention.id = ?
  `).get(IDS.league, IDS.assetRetention);
  const years = runtime.database.prepare(`
    SELECT * FROM retention_years
    WHERE league_id = ? AND retention_obligation_id = ?
    ORDER BY season_id, id
  `).all(IDS.league, IDS.assetRetention);
  const snapshot = {
    schemaVersion: 1,
    type: "retention_obligation",
    id: obligation.id,
    contractId: obligation.contract_id,
    player: { id: obligation.player_id, name: obligation.player_name },
    originatingTeamId: obligation.originating_team_id,
    responsibleTeamId: obligation.responsible_team_id,
    retainedAavCents: obligation.retained_aav_cents,
    originalContractAavCents: obligation.aav_cents,
    creationTradeId: obligation.creation_trade_id,
    version: obligation.version,
    years,
  };
  runtime.database.prepare(`
    UPDATE trade_assets
    SET asset_type = 'retention_obligation',
      retention_obligation_id = ?, buyout_obligation_id = NULL,
      proposal_snapshot_json = ?
    WHERE league_id = ? AND trade_id = ?
      AND asset_type = 'buyout_obligation'
  `).run(
    IDS.assetRetention,
    JSON.stringify(snapshot),
    IDS.league,
    tradeId
  );
  runtime.database.prepare(`
    UPDATE idempotency_requests
    SET request_hash = ?
    WHERE league_id = ? AND actor_user_id = ?
      AND operation = 'trade.propose' AND client_key = ?
  `).run(
    creationRequestHash(historicalInput),
    IDS.league,
    IDS.manager,
    idempotencyKey
  );
}

function sourceState(database) {
  return JSON.stringify(
    [
      "contracts",
      "contract_years",
      "player_ownerships",
      "draft_picks",
      "retention_obligations",
      "retention_years",
      "buyout_obligations",
      "buyout_years",
      "future_considerations",
    ].map((tableName) => ({
      tableName,
      rows: database.prepare(`SELECT * FROM ${tableName} ORDER BY id`).all(),
    }))
  );
}

function count(database, tableName, where = "") {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} ${where}`)
    .get().count;
}

function createRuntime(
  t,
  { candidateCardSummerSynchronizer } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m5-06-create-"));
  const connection = openDatabase({
    databasePath: path.join(root, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m5-06-test",
    now: () => NOW_MS,
  });
  const context = createSqliteRepositoryContext({ database: connection.database });
  seed(context.repositories);
  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository,
    leagueAccessRepository: createSqliteLeagueAccessRepository({
      database: connection.database,
    }),
    platformAuthorization: createPlatformAuthorizationService({
      userRepository,
      platformRoleRepository: createSqlitePlatformRoleRepository({
        database: connection.database,
      }),
    }),
  });
  const teamAuthorization = createTeamAuthorizationService({
    leagueAuthorization,
    teamAuthorityRepository: createSqliteTeamAuthorityRepository({
      database: connection.database,
    }),
  });
  const summerSynchronizer =
    candidateCardSummerSynchronizer ??
    Object.freeze({
      synchronize() {
        return Object.freeze({
          affectedCardCount: 0,
          changedCardCount: 0,
        });
      },
    });
  const repository = createSqliteTradeProposalRepository({
    database: connection.database,
    candidateCardSummerSynchronizer: summerSynchronizer,
  });
  let nextId = 1_000;
  let nowMs = NOW_MS;
  const clock = Object.freeze({ nowMs: () => nowMs });
  const secureRandom = Object.freeze({ id: () => uuid(nextId++) });
  const lateLockBatches = [];
  let coordinateLateLock = async () => Object.freeze({
    status: "not_applicable",
  });
  const lateLockCoordinator = Object.freeze({
    async coordinateCommittedRoster(batch) {
      lateLockBatches.push(batch);
      return coordinateLateLock(batch);
    },
  });
  const service = createTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository,
    clock,
    secureRandom,
  });
  const readService = createTradeReadService({
    leagueAuthorization,
    repository,
  });
  const lifecycleService = createRespondToTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository,
    clock,
    secureRandom,
  });
  const acceptancePreviewService = createPreviewTradeAcceptanceService({
    leagueAuthorization,
    teamAuthorization,
    repository,
    clock,
  });
  const acceptanceService = createAcceptTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository,
    lateLockCoordinator,
    clock,
    secureRandom,
  });
  const recoveryRepository = createSqliteTradeReversalRepository({
    database: connection.database,
    candidateCardSummerSynchronizer: summerSynchronizer,
  });
  const recoveryService = createTradeReversalService({
    leagueAuthorization,
    repository: recoveryRepository,
    lateLockCoordinator,
    clock,
    secureRandom,
  });
  const expiryRepository = createSqliteTradeExpiryRepository({
    database: connection.database,
  });
  const expiryJob = createExpireTradeProposalsJob({
    repository: expiryRepository,
    clock,
    secureRandom,
    leaseOwner: "m5-07-test",
    logger: Object.freeze({ error() {} }),
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return Object.freeze({
    database: connection.database,
    repositories: context.repositories,
    repository,
    leagueAuthorization,
    clock,
    secureRandom,
    service,
    readService,
    lifecycleService,
    acceptancePreviewService,
    acceptanceService,
    recoveryRepository,
    recoveryService,
    lateLockBatches,
    setCoordinateLateLock(value) {
      coordinateLateLock = value;
    },
    expiryRepository,
    expiryJob,
    setNow(value) {
      nowMs = value;
    },
  });
}

function create(runtime, idempotencyKey, input = ordinaryCreationInput()) {
  return runtime.service.create({
    leagueId: IDS.league,
    input,
    idempotencyKey,
    authenticated: authenticated(),
  });
}

function respond(runtime, {
  userId,
  tradeId,
  action,
  idempotencyKey,
}) {
  return runtime.lifecycleService.respond({
    leagueId: IDS.league,
    input: { tradeId, action },
    idempotencyKey,
    authenticated: authenticated(userId),
  });
}

function preview(runtime, tradeId, userId = IDS.receivingManager) {
  return runtime.acceptancePreviewService.preview({
    leagueId: IDS.league,
    input: { tradeId },
    authenticated: authenticated(userId),
  });
}

function accept(
  runtime,
  tradeId,
  idempotencyKey,
  userId = IDS.receivingManager
) {
  return runtime.acceptanceService.accept({
    leagueId: IDS.league,
    input: { tradeId },
    idempotencyKey,
    authenticated: authenticated(userId),
  });
}

function approve(
  runtime,
  tradeId,
  idempotencyKey,
  userId = IDS.commissioner
) {
  return runtime.acceptanceService.approve({
    leagueId: IDS.league,
    input: { tradeId },
    idempotencyKey,
    authenticated: authenticated(userId),
  });
}

function executeAcceptanceRepository(runtime, tradeId, idempotencyKey) {
  const proposal = runtime.repository.findLifecycleParticipants({
    leagueId: IDS.league,
    tradeId,
  });
  return runtime.repository.executeAcceptance({
    tradeId,
    eventId: uuid(990_001),
    idempotencyRequestId: uuid(990_002),
    leagueId: IDS.league,
    seasonId: IDS.currentSeason,
    proposingTeamId: IDS.teamA,
    receivingTeamId: IDS.teamB,
    expectedVersion: proposal.version,
    actorUserId: IDS.receivingManager,
    actorMembershipId: IDS.receivingMembership,
    actorAuthority: "manager",
    occurredAtMs: NOW_MS,
    effectiveDeadlineAtMs: proposal.effective_deadline_at_ms,
    idempotencyKey,
    idempotencyExpiresAtMs: NOW_MS + IDEMPOTENCY_LIFETIME_MS,
  });
}

function assertAssetReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeAssetPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function assertLifecycleReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeLifecyclePolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function assertExecutionReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeExecutionPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

async function assertAsyncAssetReason(action, reasonCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof TradeAssetPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

async function assertAsyncExecutionReason(action, reasonCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof TradeExecutionPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-06 atomic pending trade-proposal creation", () => {
  test("snapshots every approved asset and writes only proposal evidence atomically", (t) => {
    const runtime = createRuntime(t);
    const beforeSources = sourceState(runtime.database);

    const result = create(runtime, "mixed-proposal-1", creationInput());

    assert.equal(result.code, "TRADE_PROPOSAL_CREATED");
    assert.equal(result.replayed, false);
    assert.equal(result.proposal.status, "Pending");
    assert.equal(result.proposal.creatingActor.authority, "manager");
    assert.equal(result.proposal.effectiveDeadlineAtMs, TRADE_DEADLINE_MS);
    assert.deepEqual(
      result.proposal.assets.map(({ type }) => type),
      [
        "contract",
        "requested_retention",
        "prospect_right",
        "draft_pick",
        "buyout_obligation",
        "future_consideration",
        "future_consideration_instruction",
      ]
    );
    assert.deepEqual(
      result.proposal.assets.map(({ snapshot }) => snapshot.type),
      [
        "contract",
        "requested_retention",
        "prospect_right",
        "draft_pick",
        "buyout_obligation",
        "future_consideration",
        "future_consideration_instruction",
      ]
    );
    const requestedRetention = result.proposal.assets[1].snapshot;
    assert.equal(requestedRetention.retainedAavCents, 400);
    assert.equal(requestedRetention.cumulativeRetainedAavCents, 100);
    assert.equal(requestedRetention.retentionCeilingCents, 500);
    assert.equal(sourceState(runtime.database), beforeSources);
    assert.equal(count(runtime.database, "trades"), 2);
    assert.equal(count(runtime.database, "trade_assets"), 7);
    assert.equal(count(runtime.database, "trade_events"), 1);
    assert.equal(count(runtime.database, "idempotency_requests"), 1);
    assert.equal(count(runtime.database, "league_activity"), 1);
    assert.equal(count(runtime.database, "notifications"), 1);
    assert.equal(count(runtime.database, "outbox_events"), 1);
    const notification = runtime.database
      .prepare("SELECT * FROM notifications WHERE related_record_id = ?")
      .get(result.proposal.id);
    assert.equal(notification.user_id, IDS.receivingManager);
    assert.equal(notification.event_type, "trade_proposal_received");
    assert.equal(notification.related_feature, "trade");
    assert.equal(
      JSON.parse(notification.message_data_json).tradeId,
      result.proposal.id
    );
    const activity = runtime.database
      .prepare("SELECT * FROM league_activity WHERE related_id = ?")
      .get(result.proposal.id);
    assert.equal(activity.event_type, "trade_proposal_created");
    assert.equal(JSON.parse(activity.metadata_json).assets.length, 7);
    assert.equal(
      runtime.database
        .prepare("SELECT event_type FROM outbox_events WHERE aggregate_id = ?")
        .get(result.proposal.id).event_type,
      "trade.changed"
    );
    const persistedTrade = runtime.database
      .prepare("SELECT * FROM trades WHERE id = ?")
      .get(result.proposal.id);
    assert.equal(persistedTrade.proposal_model_version, 2);
    assert.equal(persistedTrade.creating_membership_id, IDS.membership);
    assert.equal(persistedTrade.effective_deadline_at_ms, TRADE_DEADLINE_MS);
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM idempotency_requests WHERE result_id = ?")
        .get(result.proposal.id).status,
      "completed"
    );
    const beforeRead = runtime.database.serialize();
    const detail = runtime.readService.read({
      leagueId: IDS.league,
      tradeId: result.proposal.id,
      authenticated: authenticated(),
    });
    assert.equal(detail.code, "TRADE_PROPOSAL_FOUND");
    assert.equal(detail.proposal.id, result.proposal.id);
    assert.deepEqual(
      detail.proposal.assets.map(({ type }) => type),
      result.proposal.assets.map(({ type }) => type)
    );
    assert.deepEqual(
      detail.proposal.assets.map(({ snapshot }) => snapshot.type),
      result.proposal.assets.map(({ snapshot }) => snapshot.type)
    );
    assert.deepEqual(
      detail.proposal.history.map(({ type }) => type),
      ["proposal_created"]
    );
    assert.equal(beforeRead.equals(runtime.database.serialize()), true);
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("requires the proposing manager and treats a dual-role commissioner as manager", (t) => {
    const runtime = createRuntime(t);
    const beforeElevatedDenials = runtime.database.serialize();
    for (const userId of [IDS.commissioner, IDS.platformAdministrator]) {
      assert.throws(
        () =>
          runtime.service.create({
            leagueId: IDS.league,
            input: ordinaryCreationInput(),
            idempotencyKey: `elevated-create-${userId}`,
            authenticated: authenticated(userId),
          }),
        { code: "TEAM_MANAGER_REQUIRED" }
      );
    }
    assert.throws(
      () =>
        runtime.service.create({
          leagueId: uuid(999),
          input: ordinaryCreationInput(),
          idempotencyKey: "cross-league-create",
          authenticated: authenticated(IDS.manager),
        }),
      (error) =>
        ["LEAGUE_NOT_FOUND", "TEAM_NOT_FOUND"].includes(error?.code)
    );
    assert.equal(
      beforeElevatedDenials.equals(runtime.database.serialize()),
      true
    );

    runtime.database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended', ended_at_ms = ?, version = version + 1
      WHERE id = ?
    `).run(NOW_MS, IDS.assignment);
    runtime.repositories.team_manager_assignments.insert({
      id: uuid(902),
      league_id: IDS.league,
      team_id: IDS.teamA,
      user_id: IDS.commissioner,
      membership_id: IDS.commissionerMembership,
      assigned_by_user_id: IDS.commissioner,
      replaces_assignment_id: IDS.assignment,
      status: "accepted",
      assigned_at_ms: NOW_MS,
      accepted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    const created = runtime.service.create({
      leagueId: IDS.league,
      input: ordinaryCreationInput(),
      idempotencyKey: "dual-role-manager-create",
      authenticated: authenticated(IDS.commissioner),
    });
    assert.equal(created.proposal.creatingActor.authority, "manager");
  });

  test("replays exactly and permits independent simultaneous proposals", (t) => {
    const runtime = createRuntime(t);
    const first = create(runtime, "same-request", creationInput());
    const replay = create(runtime, "same-request", creationInput());
    assert.equal(replay.code, "TRADE_PROPOSAL_REPLAYED");
    assert.equal(replay.proposal.id, first.proposal.id);
    assert.equal(count(runtime.database, "trades"), 2);
    assert.equal(count(runtime.database, "trade_assets"), 7);
    assert.equal(count(runtime.database, "trade_events"), 1);
    assert.equal(count(runtime.database, "league_activity"), 1);
    assert.equal(count(runtime.database, "outbox_events"), 1);

    const simultaneous = create(
      runtime,
      "independent-request",
      creationInput()
    );
    assert.notEqual(simultaneous.proposal.id, first.proposal.id);
    assert.equal(count(runtime.database, "trades"), 3);
    assert.equal(count(runtime.database, "trade_assets"), 14);
    assert.equal(count(runtime.database, "trade_events"), 2);
    assert.equal(count(runtime.database, "league_activity"), 2);
    assert.equal(count(runtime.database, "outbox_events"), 2);
    assert.equal(sourceState(runtime.database).includes("reserved"), false);
  });

  test("rejects new standalone retention without writes while replaying and executing historical evidence", async (t) => {
    const runtime = createRuntime(t);
    const idempotencyKey = "historical-retention-proposal";
    const historicalInput = creationInput({
      proposingAssets: [
        { type: "draft_pick", draftPickId: IDS.draftPick },
      ],
      receivingAssets: [
        {
          type: "retention_obligation",
          retentionObligationId: IDS.assetRetention,
        },
      ],
    });
    const seeded = create(
      runtime,
      idempotencyKey,
      creationInput({
        proposingAssets: [
          { type: "draft_pick", draftPickId: IDS.draftPick },
        ],
        receivingAssets: [
          { type: "buyout_obligation", buyoutObligationId: IDS.buyout },
        ],
      })
    );
    convertCreatedBuyoutToHistoricalRetention(
      runtime,
      seeded.proposal.id,
      idempotencyKey,
      historicalInput
    );

    const beforeReplay = runtime.database.serialize();
    const replay = create(runtime, idempotencyKey, historicalInput);
    assert.equal(replay.code, "TRADE_PROPOSAL_REPLAYED");
    assert.equal(replay.proposal.id, seeded.proposal.id);
    assert.deepEqual(
      replay.proposal.assets.map(({ type }) => type),
      ["draft_pick", "retention_obligation"]
    );
    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);

    const beforeRead = runtime.database.serialize();
    const detail = runtime.readService.read({
      leagueId: IDS.league,
      tradeId: seeded.proposal.id,
      authenticated: authenticated(),
    });
    assert.deepEqual(
      detail.proposal.assets.map(({ type }) => type),
      ["draft_pick", "retention_obligation"]
    );
    assert.equal(beforeRead.equals(runtime.database.serialize()), true);

    const beforeNewDenial = runtime.database.serialize();
    assertAssetReason(
      () => create(runtime, "new-standalone-retention", historicalInput),
      TRADE_ASSET_CODES.typeUnsupported
    );
    assert.equal(beforeNewDenial.equals(runtime.database.serialize()), true);

    const accepted = await accept(
      runtime,
      seeded.proposal.id,
      "historical-retention-accept"
    );
    assert.equal(accepted.code, "TRADE_ACCEPTED");
    assert.equal(
      runtime.database.prepare(
        "SELECT responsible_team_id FROM retention_obligations WHERE id = ?"
      ).get(IDS.assetRetention).responsible_team_id,
      IDS.teamA
    );
    const afterAcceptance = runtime.database.serialize();
    const acceptanceReplay = await accept(
      runtime,
      seeded.proposal.id,
      "historical-retention-accept"
    );
    assert.equal(acceptanceReplay.code, "TRADE_ACCEPTANCE_REPLAYED");
    assert.equal(afterAcceptance.equals(runtime.database.serialize()), true);

    runtime.setNow(TRADE_DEADLINE_MS + 1);
    const reversed = await reverseTrade(
      runtime,
      seeded.proposal.id,
      "historical-retention-reverse"
    );
    assert.equal(reversed.code, "TRADE_REVERSED");
    assert.equal(
      runtime.database.prepare(
        "SELECT responsible_team_id FROM retention_obligations WHERE id = ?"
      ).get(IDS.assetRetention).responsible_team_id,
      IDS.teamB
    );
  });

  test("rejects idempotency conflicts without partial writes", (t) => {
    const runtime = createRuntime(t);
    create(runtime, "conflict-key");
    const countsBefore = [
      count(runtime.database, "trades"),
      count(runtime.database, "trade_assets"),
      count(runtime.database, "trade_events"),
      count(runtime.database, "idempotency_requests"),
    ];
    const changed = creationInput({
      receivingAssets: [
        {
          type: "future_consideration_instruction",
          description: "A different instruction",
        },
      ],
    });
    assertAssetReason(
      () => create(runtime, "conflict-key", changed),
      TRADE_ASSET_CODES.idempotencyConflict
    );
    assert.deepEqual(
      [
        count(runtime.database, "trades"),
        count(runtime.database, "trade_assets"),
        count(runtime.database, "trade_events"),
        count(runtime.database, "idempotency_requests"),
      ],
      countsBefore
    );
  });

  test("rejects stale ownership and retention above the cumulative ceiling", (t) => {
    const stale = createRuntime(t);
    stale.repositories.contracts.updateVersioned({
      key: IDS.contract,
      leagueId: IDS.league,
      expectedVersion: 1,
      changes: {
        current_team_id: IDS.teamB,
        updated_at_ms: NOW_MS,
      },
    });
    assertAssetReason(
      () => create(stale, "stale-contract"),
      TRADE_ASSET_CODES.ineligible
    );
    assert.equal(count(stale.database, "trades"), 1);
    assert.equal(count(stale.database, "idempotency_requests"), 0);

    const overCeiling = createRuntime(t);
    const input = creationInput();
    input.proposingAssets[1].retainedAavCents = 401;
    assertAssetReason(
      () => create(overCeiling, "over-ceiling", input),
      TRADE_ASSET_CODES.retentionInvalid
    );
    assert.equal(count(overCeiling.database, "trades"), 1);
    assert.equal(count(overCeiling.database, "trade_assets"), 0);
    assert.equal(count(overCeiling.database, "idempotency_requests"), 0);
  });

  test("rolls back the trade, assets, history, outbox, and idempotency row after a late failure", (t) => {
    const runtime = createRuntime(t);
    runtime.database.exec(`
      CREATE TRIGGER reject_m5_09_creation_outbox
      BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'trade.changed'
      BEGIN
        SELECT RAISE(ABORT, 'forced late creation-outbox failure');
      END;
    `);
    const beforeSources = sourceState(runtime.database);
    assert.throws(
      () => create(runtime, "late-failure"),
      (error) =>
        error?.code === "REPOSITORY_CONSTRAINT" &&
        error?.cause?.code === "SQLITE_CONSTRAINT_TRIGGER"
    );
    assert.equal(count(runtime.database, "trades"), 1);
    assert.equal(count(runtime.database, "trade_assets"), 0);
    assert.equal(count(runtime.database, "trade_events"), 0);
    assert.equal(count(runtime.database, "league_activity"), 0);
    assert.equal(count(runtime.database, "outbox_events"), 0);
    assert.equal(count(runtime.database, "idempotency_requests"), 0);
    assert.equal(sourceState(runtime.database), beforeSources);
  });
});

describe("M5-07 read-only trade acceptance preview", () => {
  test("revalidates every typed asset and projects a legal result without writes", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "acceptance-preview-legal",
      creationInput()
    );
    const before = runtime.database.serialize();

    const result = preview(runtime, proposal.proposal.id);

    assert.equal(result.code, "TRADE_ACCEPTANCE_PREVIEWED");
    assert.equal(result.proposal.status, "Pending");
    assert.equal(result.proposal.effectiveDeadlineAtMs, TRADE_DEADLINE_MS);
    assert.deepEqual(
      result.assets.map((asset) => asset.type),
      [
        "contract",
        "requested_retention",
        "prospect_right",
        "draft_pick",
        "buyout_obligation",
        "future_consideration",
        "future_consideration_instruction",
      ]
    );
    assert.deepEqual(
      result.assets.map((asset) => asset.currentSnapshot.type),
      result.assets.map((asset) => asset.type)
    );
    assert.equal(result.generallyIllegal, false);
    const proposing = result.teams.find((team) => team.teamId === IDS.teamA);
    const receiving = result.teams.find((team) => team.teamId === IDS.teamB);
    assert.equal(proposing.cap.usageCents, 475);
    assert.equal(proposing.retentionSlots, 1);
    assert.equal(receiving.cap.usageCents, 700);
    assert.equal(receiving.retentionSlots, 2);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("uses current roster evidence and reports general illegality without mutating", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "acceptance-preview-illegal");
    runtime.database
      .prepare(
        `UPDATE league_settings
         SET salary_cap_cents = 450, updated_at_ms = ?, version = version + 1
         WHERE league_id = ?`
      )
      .run(NOW_MS, IDS.league);
    runtime.database
      .prepare(
        `UPDATE player_ownerships
         SET roster_category = 'Bench', slot_number = 1,
           updated_at_ms = ?, version = version + 1
         WHERE id = ?`
      )
      .run(NOW_MS, IDS.ownership);
    const before = runtime.database.serialize();

    const result = preview(runtime, proposal.proposal.id);

    assert.equal(result.assets[0].proposalSnapshot.ownership.rosterCategory, "Active");
    assert.equal(result.assets[0].currentSnapshot.ownership.rosterCategory, "Bench");
    assert.equal(result.generallyIllegal, true);
    assert.ok(
      result.teams.some((team) =>
        team.issues.some((issue) => issue.code === "BENCH_AAV_LIMIT_EXCEEDED")
      )
    );
    assert.ok(
      result.teams.some((team) =>
        team.issues.some((issue) => issue.code === "SALARY_CAP_EXCEEDED")
      )
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("keeps executable preview receiver-only while preserving commissioner read access", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "acceptance-preview-authority");
    assert.throws(
      () => preview(runtime, proposal.proposal.id, IDS.manager),
      (error) => error?.code === "TEAM_MANAGER_REQUIRED"
    );
    assert.throws(
      () =>
        runtime.acceptancePreviewService.preview({
          leagueId: IDS.league,
          input: { tradeId: proposal.proposal.id },
          authenticated: null,
        }),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );
    const beforeCommissionerRead = runtime.database.serialize();
    assert.equal(
      runtime.readService.read({
        leagueId: IDS.league,
        tradeId: proposal.proposal.id,
        authenticated: authenticated(IDS.commissioner),
      }).code,
      "TRADE_PROPOSAL_FOUND"
    );
    assert.equal(
      beforeCommissionerRead.equals(runtime.database.serialize()),
      true
    );
    runtime.database
      .prepare(
        `UPDATE leagues SET status = 'frozen', updated_at_ms = ?,
           version = version + 1 WHERE id = ?`
      )
      .run(NOW_MS, IDS.league);
    assert.throws(
      () => preview(runtime, proposal.proposal.id, IDS.commissioner),
      (error) => error?.code === "TEAM_MANAGER_REQUIRED"
    );
    assertLifecycleReason(
      () => preview(runtime, proposal.proposal.id, IDS.receivingManager),
      "TRADE_LIFECYCLE_ROLE_DENIED"
    );
    runtime.database
      .prepare(
        `UPDATE leagues SET status = 'active', updated_at_ms = ?,
           version = version + 1 WHERE id = ?`
      )
      .run(NOW_MS, IDS.league);
    runtime.setNow(TRADE_DEADLINE_MS);
    assertLifecycleReason(
      () => preview(runtime, proposal.proposal.id, IDS.receivingManager),
      "TRADE_LIFECYCLE_WINDOW_CLOSED"
    );
  });

  test("rejects stale authoritative state for each mutable asset family", (t) => {
    const cases = [
      ["contract", (database) => database.prepare(
        "UPDATE contracts SET current_team_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      ).run(IDS.teamB, NOW_MS, IDS.contract), TRADE_ASSET_CODES.ineligible],
      ["prospect", (database) => database.prepare(
        "UPDATE player_ownerships SET team_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      ).run(IDS.teamB, NOW_MS, IDS.prospectOwnership), TRADE_ASSET_CODES.ineligible],
      ["draft pick", (database) => database.prepare(
        "UPDATE draft_picks SET current_owner_team_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      ).run(IDS.teamB, NOW_MS, IDS.draftPick), TRADE_ASSET_CODES.ineligible],
      ["buyout", (database) => database.prepare(
        "UPDATE buyout_obligations SET responsible_team_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      ).run(IDS.teamA, NOW_MS, IDS.buyout), TRADE_ASSET_CODES.ineligible],
      ["Future Considerations", (database) => database.prepare(
        "UPDATE future_considerations SET status = 'fulfilled', resolved_at_ms = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      ).run(NOW_MS, NOW_MS, IDS.futureConsideration), TRADE_ASSET_CODES.ineligible],
      ["requested retention", (database) => {
        database.prepare(
          "UPDATE retention_obligations SET retained_aav_cents = 101, updated_at_ms = ?, version = version + 1 WHERE id = ?"
        ).run(NOW_MS, IDS.retention);
        database.prepare(
          "UPDATE retention_years SET retained_aav_cents = 101 WHERE id = ?"
        ).run(IDS.retentionYear);
      }, TRADE_ASSET_CODES.retentionInvalid],
    ];
    for (const [label, mutate, reasonCode] of cases) {
      const runtime = createRuntime(t);
      const proposal = create(
        runtime,
        `stale-${label}`,
        creationInput()
      );
      mutate(runtime.database);
      const before = runtime.database.serialize();
      assertAssetReason(
        () => preview(runtime, proposal.proposal.id),
        reasonCode
      );
      assert.equal(before.equals(runtime.database.serialize()), true, label);
    }
  });
});

describe("M5-08 atomic typed-asset trade execution", () => {
  test("synchronizes both trade teams and every moved player once inside acceptance", (t) => {
    const calls = [];
    let runtime;
    runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(runtime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    const proposal = create(runtime, "execution-summer-sync");
    const beforePreview = runtime.database.serialize();

    preview(runtime, proposal.proposal.id);

    assert.equal(beforePreview.equals(runtime.database.serialize()), true);
    assert.deepEqual(calls, []);
    executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "execution-summer-sync-acceptance"
    );
    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.teamA, IDS.teamB],
        affectedPlayerIds: [IDS.contractPlayer, IDS.prospectPlayer],
        sourceOperationId: uuid(990_001),
        sourceKind: "trade_execution",
        nowMs: NOW_MS,
      },
    ]);

    executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "execution-summer-sync-acceptance"
    );
    assert.equal(calls.length, 1);
  });

  test("rolls every acceptance effect back when Candidate synchronization fails", (t) => {
    const runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize({ sourceKind }) {
          if (sourceKind === "trade_execution") {
            throw new Error("injected Candidate synchronization failure");
          }
        },
      },
    });
    const proposal = create(runtime, "execution-summer-sync-rollback");
    const before = runtime.database.serialize();

    assert.throws(
      () => executeAcceptanceRepository(
        runtime,
        proposal.proposal.id,
        "execution-summer-sync-rollback-acceptance"
      ),
      { code: "REPOSITORY_OPERATION_FAILED" }
    );

    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT status, version FROM trades WHERE id = ?"
      ).get(proposal.proposal.id),
      { status: "proposed", version: 1 }
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT team_id FROM player_ownerships WHERE player_id = ?"
      ).get(IDS.contractPlayer).team_id,
      IDS.teamA
    );
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT current_team_id, version FROM contracts WHERE id = ?"
      ).get(IDS.contract),
      { current_team_id: IDS.teamA, version: 1 }
    );
  });

  test("transfers every asset once, preserves terms, and cancels conflicts", async (t) => {
    const runtime = createRuntime(t);
    insertContract(runtime.repositories, {
      id: IDS.prospectContract,
      yearId: IDS.prospectContractYear,
      playerId: IDS.prospectPlayer,
      teamId: IDS.teamA,
      aavCents: 100,
      status: "active",
    });
    runtime.database
      .prepare("UPDATE contracts SET contract_type = 'fantasy_elc' WHERE id = ?")
      .run(IDS.prospectContract);
    const acceptedProposal = create(
      runtime,
      "execution-primary",
      creationInput()
    );
    const conflict = create(
      runtime,
      "execution-conflict",
      creationInput()
    );
    const contractBefore = runtime.database
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(IDS.contract);
    const contractYearsBefore = runtime.database
      .prepare("SELECT * FROM contract_years WHERE contract_id = ? ORDER BY id")
      .all(IDS.contract);
    const buyoutBefore = runtime.database
      .prepare("SELECT * FROM buyout_obligations WHERE id = ?")
      .get(IDS.buyout);
    runtime.database.prepare(`
      INSERT INTO roster_display_order_sets (
        id, league_id, season_id, team_id, updated_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      uuid(970_001),
      IDS.league,
      IDS.currentSeason,
      IDS.teamA,
      IDS.manager,
      NOW_MS,
      NOW_MS
    );
    runtime.database.prepare(`
      INSERT INTO roster_display_order_entries (
        id, league_id, order_set_id, ownership_id,
        position_group, display_order, created_at_ms
      ) VALUES (?, ?, ?, ?, 'F', 1, ?)
    `).run(uuid(970_002), IDS.league, uuid(970_001), IDS.ownership, NOW_MS);

    const competingAwaiting = await accept(
      runtime,
      conflict.proposal.id,
      "accept-conflicting-future-trade"
    );
    assert.equal(
      competingAwaiting.proposal.storageStatus,
      "awaiting_commissioner_approval"
    );
    const sourcesBeforeAcceptance = sourceState(runtime.database);
    const awaiting = await accept(
      runtime,
      acceptedProposal.proposal.id,
      "accept-every-asset"
    );

    assert.equal(awaiting.code, "TRADE_AWAITING_COMMISSIONER_APPROVAL");
    assert.equal(awaiting.proposal.storageStatus, "awaiting_commissioner_approval");
    assert.equal(awaiting.proposal.version, 2);
    assert.deepEqual(awaiting.transfers, []);
    assert.deepEqual(awaiting.lateLock, { status: "not_applicable" });
    assert.equal(sourceState(runtime.database), sourcesBeforeAcceptance);
    assert.equal(runtime.lateLockBatches.length, 0);
    const awaitingRead = runtime.readService.read({
      leagueId: IDS.league,
      tradeId: acceptedProposal.proposal.id,
      authenticated: authenticated(IDS.receivingManager),
    });
    assert.equal(
      awaitingRead.proposal.status,
      "Awaiting Commissioner Approval"
    );
    assert.equal(
      awaitingRead.proposal.storageStatus,
      "awaiting_commissioner_approval"
    );

    const beforeDeniedApproval = runtime.database.serialize();
    await assert.rejects(
      () =>
        approve(
          runtime,
          acceptedProposal.proposal.id,
          "manager-cannot-approve",
          IDS.receivingManager
        ),
      { code: "LEAGUE_COMMISSIONER_REQUIRED" }
    );
    assert.equal(beforeDeniedApproval.equals(runtime.database.serialize()), true);

    const result = await approve(
      runtime,
      acceptedProposal.proposal.id,
      "approve-every-asset"
    );

    assert.equal(result.code, "TRADE_APPROVED");
    assert.equal(result.replayed, false);
    assert.equal(result.proposal.storageStatus, "completed");
    assert.equal(result.proposal.version, 3);
    assert.equal(result.generallyIllegal, false);
    assert.equal(result.transfers.length, 7);
    assert.deepEqual(result.lateLock, { status: "not_applicable" });
    assert.deepEqual(result.automaticallyCancelledTradeIds, [conflict.proposal.id]);
    const ownership = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(IDS.contractPlayer);
    assert.notEqual(ownership.id, IDS.ownership);
    assert.equal(ownership.version, 1);
    assert.equal(ownership.team_id, IDS.teamB);
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.slot_number, 1);
    assert.equal(ownership.acquired_transaction_type, "trade_execution");
    assert.equal(ownership.acquired_transaction_id, acceptedProposal.proposal.id);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM roster_display_order_entries WHERE ownership_id = ?"
      ).get(IDS.ownership).count,
      0
    );
    const prospect = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(IDS.prospectPlayer);
    assert.notEqual(prospect.id, IDS.prospectOwnership);
    assert.equal(prospect.version, 1);
    assert.equal(prospect.team_id, IDS.teamB);
    assert.equal(prospect.ownership_kind, "Prospect Right");
    assert.equal(prospect.roster_category, "Prospect");
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM player_ownerships WHERE id IN (?, ?)"
      ).get(IDS.ownership, IDS.prospectOwnership).count,
      0
    );
    const acceptanceMetadata = JSON.parse(
      runtime.database.prepare(
        "SELECT metadata_json FROM trade_events WHERE trade_id = ? AND event_type = 'proposal_accepted'"
      ).get(acceptedProposal.proposal.id).metadata_json
    );
    const contractMapping = acceptanceMetadata.ownershipTransfers.find(
      ({ sourceOwnershipId }) => sourceOwnershipId === IDS.ownership
    );
    const prospectMapping = acceptanceMetadata.ownershipTransfers.find(
      ({ sourceOwnershipId }) => sourceOwnershipId === IDS.prospectOwnership
    );
    assert.deepEqual(
      Object.keys(contractMapping).sort(),
      [
        "destinationOwnershipId",
        "destinationOwnershipVersion",
        "destinationTeamId",
        "sourceOwnershipId",
        "sourceOwnershipVersion",
        "sourceTeamId",
      ]
    );
    assert.deepEqual(
      {
        sourceOwnershipId: contractMapping.sourceOwnershipId,
        sourceOwnershipVersion: contractMapping.sourceOwnershipVersion,
        destinationOwnershipId: contractMapping.destinationOwnershipId,
        destinationOwnershipVersion: contractMapping.destinationOwnershipVersion,
      },
      {
        sourceOwnershipId: IDS.ownership,
        sourceOwnershipVersion: 1,
        destinationOwnershipId: ownership.id,
        destinationOwnershipVersion: 1,
      }
    );
    assert.equal(prospectMapping.sourceOwnershipId, IDS.prospectOwnership);
    assert.equal(prospectMapping.destinationOwnershipId, prospect.id);
    assert.equal(
      Object.hasOwn(
        result.transfers.find(({ assetType }) => assetType === "contract"),
        "sourceOwnershipId"
      ),
      false
    );
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT event_type FROM ownership_events ORDER BY event_type, ownership_id"
      ).all().map(({ event_type }) => event_type),
      [
        "trade_transfer_in",
        "trade_transfer_in",
        "trade_transfer_out",
        "trade_transfer_out",
      ]
    );
    assert.equal(runtime.lateLockBatches.length, 1);
    assert.equal(runtime.lateLockBatches[0].mutationKind, "trade_acceptance");
    assert.deepEqual(
      runtime.lateLockBatches[0].teams.map(({ teamId }) => teamId),
      [IDS.teamA, IDS.teamB]
    );
    assert.deepEqual(
      runtime.lateLockBatches[0].teams.flatMap(({ ownershipWitnesses }) =>
        ownershipWitnesses.map(({ ownershipId, ownershipVersion, state }) => ({
          ownershipId,
          ownershipVersion,
          state,
        }))
      ),
      [
        [
          {
            ownershipId: IDS.ownership,
            ownershipVersion: 1,
            state: "deleted",
          },
          {
            ownershipId: IDS.prospectOwnership,
            ownershipVersion: 1,
            state: "deleted",
          },
        ],
        [
          {
            ownershipId: ownership.id,
            ownershipVersion: 1,
            state: "present",
          },
          {
            ownershipId: prospect.id,
            ownershipVersion: 1,
            state: "present",
          },
        ].sort((left, right) =>
          left.ownershipId.localeCompare(right.ownershipId)
        ),
      ].flat()
    );
    assert.equal(
      runtime.database.prepare("SELECT current_team_id FROM contracts WHERE id = ?")
        .get(IDS.prospectContract).current_team_id,
      IDS.teamB
    );
    const contractAfter = runtime.database
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(IDS.contract);
    assert.equal(contractAfter.current_team_id, IDS.teamB);
    for (const field of [
      "contract_type",
      "original_total_value_cents",
      "original_term_years",
      "aav_cents",
      "start_season_id",
      "status",
      "auction_buyout_lock_expires_at_ms",
    ]) {
      assert.equal(contractAfter[field], contractBefore[field], field);
    }
    assert.deepEqual(
      runtime.database
        .prepare("SELECT * FROM contract_years WHERE contract_id = ? ORDER BY id")
        .all(IDS.contract),
      contractYearsBefore
    );
    assert.equal(
      runtime.database.prepare("SELECT current_owner_team_id FROM draft_picks WHERE id = ?")
        .get(IDS.draftPick).current_owner_team_id,
      IDS.teamB
    );
    const buyoutAfter = runtime.database
      .prepare("SELECT * FROM buyout_obligations WHERE id = ?")
      .get(IDS.buyout);
    assert.equal(buyoutAfter.responsible_team_id, IDS.teamA);
    assert.equal(
      buyoutAfter.annual_penalty_basis_cents,
      buyoutBefore.annual_penalty_basis_cents
    );
    const createdRetention = runtime.database
      .prepare(
        "SELECT * FROM retention_obligations WHERE creation_trade_id = ?"
      )
      .get(acceptedProposal.proposal.id);
    assert.equal(createdRetention.contract_id, IDS.contract);
    assert.equal(createdRetention.responsible_team_id, IDS.teamA);
    assert.equal(createdRetention.retained_aav_cents, 400);
    assert.equal(
      count(
        runtime.database,
        "retention_years",
        `WHERE retention_obligation_id = '${createdRetention.id}'`
      ),
      1
    );
    const existingFuture = runtime.database
      .prepare("SELECT * FROM future_considerations WHERE id = ?")
      .get(IDS.futureConsideration);
    assert.equal(existingFuture.status, "cancelled");
    assert.equal(existingFuture.resolved_at_ms, NOW_MS);
    const createdFuture = runtime.database
      .prepare(
        "SELECT * FROM future_considerations WHERE originating_trade_id = ? AND id <> ?"
      )
      .get(acceptedProposal.proposal.id, IDS.futureConsideration);
    assert.equal(createdFuture.owing_team_id, IDS.teamB);
    assert.equal(createdFuture.receiving_team_id, IDS.teamA);
    assert.equal(createdFuture.status, "outstanding");
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(conflict.proposal.id).status,
      "cancelled"
    );
    assert.equal(
      count(
        runtime.database,
        "trade_events",
        "WHERE event_type = 'proposal_auto_cancelled'"
      ),
      1
    );
    assert.equal(count(runtime.database, "ownership_events"), 4);
    assert.equal(count(runtime.database, "contract_events"), 2);
    assert.equal(count(runtime.database, "draft_pick_ownership_events"), 1);
    assert.equal(count(runtime.database, "league_activity"), 6);
    assert.equal(count(runtime.database, "outbox_events"), 6);
    const completedActivity = runtime.database
      .prepare(`
        SELECT * FROM league_activity
        WHERE related_id = ? AND event_type = 'trade_completed'
      `)
      .get(acceptedProposal.proposal.id);
    const completedMetadata = JSON.parse(completedActivity.metadata_json);
    assert.equal(completedMetadata.assets.length, 7);
    assert.equal(completedMetadata.generallyIllegal, false);
    assert.equal(
      completedMetadata.assets.find(({ assetType }) => assetType === "contract")
        .executionSnapshot.contract.aavCents,
      contractBefore.aav_cents
    );
    assert.equal(
      count(
        runtime.database,
        "league_activity",
        "WHERE event_type = 'trade_proposal_automatically_cancelled'"
      ),
      1
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);

    const bytesAfter = runtime.database.serialize();
    const acceptanceReplay = await accept(
      runtime,
      acceptedProposal.proposal.id,
      "accept-every-asset"
    );
    assert.equal(acceptanceReplay.code, "TRADE_ACCEPTANCE_REPLAYED");
    assert.equal(acceptanceReplay.replayed, true);
    assert.equal(
      acceptanceReplay.proposal.storageStatus,
      "awaiting_commissioner_approval"
    );
    assert.deepEqual(acceptanceReplay.transfers, []);
    assert.equal(runtime.lateLockBatches.length, 1);
    assert.equal(bytesAfter.equals(runtime.database.serialize()), true);

    const replay = await approve(
      runtime,
      acceptedProposal.proposal.id,
      "approve-every-asset"
    );
    assert.equal(replay.code, "TRADE_APPROVAL_REPLAYED");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.transfers, result.transfers);
    assert.deepEqual(replay.lateLock, { status: "not_applicable" });
    assert.equal(runtime.lateLockBatches.length, 2);
    assert.deepEqual(runtime.lateLockBatches[1], runtime.lateLockBatches[0]);
    assert.equal(bytesAfter.equals(runtime.database.serialize()), true);
    await assertAsyncExecutionReason(
      () =>
        approve(
          runtime,
          acceptedProposal.proposal.id,
          "second-approval-command"
        ),
      TRADE_EXECUTION_CODES.notPending
    );
    assert.equal(bytesAfter.equals(runtime.database.serialize()), true);

    const retrade = runtime.service.create({
      leagueId: IDS.league,
      input: {
        proposingTeamId: IDS.teamB,
        receivingTeamId: IDS.teamA,
        proposingAssets: [
          { type: "draft_pick", draftPickId: IDS.draftPick },
        ],
        receivingAssets: [
          { type: "buyout_obligation", buyoutObligationId: IDS.buyout },
        ],
      },
      idempotencyKey: "retrade-pick-proposal",
      authenticated: authenticated(IDS.receivingManager),
    });
    await accept(runtime, retrade.proposal.id, "retrade-pick-accept", IDS.manager);
    const pick = runtime.database
      .prepare("SELECT * FROM draft_picks WHERE id = ?")
      .get(IDS.draftPick);
    assert.equal(pick.current_owner_team_id, IDS.teamA);
    assert.equal(pick.original_team_id, IDS.teamA);
    assert.equal(count(runtime.database, "draft_pick_ownership_events"), 2);
  });

  test("reconstructs one hidden frozen two-team receipt and replays it without writes", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "execution-repository-receipt");

    const result = executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "repository-receipt-acceptance"
    );

    assert.equal(result.replayed, false);
    assert.equal(Object.keys(result).includes("committedTeams"), false);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(result, "committedTeams"),
      {
        configurable: false,
        enumerable: false,
        value: result.committedTeams,
        writable: false,
      }
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.committedTeams), true);
    assert.equal(Object.isFrozen(result.event.metadata.ownershipTransfers), true);
    assert.equal(
      result.event.metadata.ownershipTransfers.every(Object.isFrozen),
      true
    );
    assert.deepEqual(
      result.committedTeams.map((team) => team.teamId),
      [IDS.teamA, IDS.teamB]
    );
    assert.equal(
      result.committedTeams.every(
        (team) =>
          Object.isFrozen(team) &&
          Object.isFrozen(team.ownershipWitnesses) &&
          team.ownershipWitnesses.every(Object.isFrozen)
      ),
      true
    );
    assert.deepEqual(
      result.committedTeams[0].ownershipWitnesses,
      [
        {
          ownershipId: IDS.ownership,
          ownershipVersion: 1,
          state: "deleted",
        },
        {
          ownershipId: IDS.prospectOwnership,
          ownershipVersion: 1,
          state: "deleted",
        },
      ]
    );
    assert.equal(
      result.committedTeams[1].ownershipWitnesses.every(
        ({ ownershipVersion, state }) =>
          ownershipVersion === 1 && state === "present"
      ),
      true
    );
    assert.equal(
      result.event.metadata.transfers.some((transfer) =>
        Object.hasOwn(transfer, "sourceOwnershipId")
      ),
      false
    );
    const bytesAfter = runtime.database.serialize();

    const replay = executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "repository-receipt-acceptance"
    );

    assert.equal(replay.replayed, true);
    assert.deepEqual(
      replay.event.metadata.ownershipTransfers,
      result.event.metadata.ownershipTransfers
    );
    assert.deepEqual(replay.committedTeams, result.committedTeams);
    assert.equal(bytesAfter.equals(runtime.database.serialize()), true);
  });

  test("rejects a tampered awaiting-approval replay receipt without writes", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "awaiting-replay-tamper",
      creationInput()
    );
    await accept(
      runtime,
      proposal.proposal.id,
      "awaiting-replay-tamper-accept"
    );
    runtime.database.prepare(`
      UPDATE trade_events
      SET metadata_json = json_set(
        metadata_json,
        '$.actorAuthority',
        'commissioner'
      )
      WHERE trade_id = ?
        AND event_type =
          'proposal_accepted_awaiting_commissioner_approval'
    `).run(proposal.proposal.id);
    const beforeReplay = runtime.database.serialize();

    await assert.rejects(
      () =>
        accept(
          runtime,
          proposal.proposal.id,
          "awaiting-replay-tamper-accept"
        ),
      (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );

    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);
    assert.equal(runtime.lateLockBatches.length, 0);
  });

  test("returns both participant receipts with no synthetic witnesses for a non-roster trade", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "execution-cap-only-receipt",
      creationInput({
        proposingAssets: [
          {
            type: "draft_pick",
            draftPickId: IDS.draftPick,
          },
        ],
        receivingAssets: [
          {
            type: "buyout_obligation",
            buyoutObligationId: IDS.buyout,
          },
        ],
      })
    );

    const result = executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "cap-only-receipt-acceptance"
    );

    assert.deepEqual(result.event.metadata.ownershipTransfers, []);
    assert.deepEqual(
      result.committedTeams.map(({ teamId, ownershipWitnesses }) => ({
        teamId,
        ownershipWitnesses,
      })),
      [
        { teamId: IDS.teamA, ownershipWitnesses: [] },
        { teamId: IDS.teamB, ownershipWitnesses: [] },
      ]
    );
    assert.equal(
      result.committedTeams.every(
        (team) => Object.isFrozen(team.ownershipWitnesses)
      ),
      true
    );
    assert.equal(count(runtime.database, "ownership_events"), 0);
  });

  test("rejects a tampered tenure mapping and rolls an initial acceptance back", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "execution-tampered-mapping");
    runtime.database.exec(`
      CREATE TRIGGER tamper_trade_acceptance_ownership_mapping
      AFTER INSERT ON trade_events
      WHEN NEW.trade_id = '${proposal.proposal.id}'
        AND NEW.event_type = 'proposal_accepted'
      BEGIN
        UPDATE trade_events
        SET metadata_json = json_set(
          metadata_json,
          '$.ownershipTransfers[0].destinationOwnershipVersion',
          2
        )
        WHERE id = NEW.id;
      END;
    `);
    const before = runtime.database.serialize();

    assert.throws(
      () =>
        executeAcceptanceRepository(
          runtime,
          proposal.proposal.id,
          "tampered-mapping-acceptance"
        ),
      (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );

    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "proposed"
    );
    assert.equal(
      runtime.database.prepare("SELECT team_id FROM player_ownerships WHERE id = ?")
        .get(IDS.ownership).team_id,
      IDS.teamA
    );
    assert.equal(count(runtime.database, "ownership_events"), 0);
  });

  test("rejects a tampered replay receipt without performing another write", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "execution-tampered-replay");
    executeAcceptanceRepository(
      runtime,
      proposal.proposal.id,
      "tampered-replay-acceptance"
    );
    runtime.database.prepare(`
      UPDATE trade_events
      SET metadata_json = json_set(
        metadata_json,
        '$.ownershipTransfers[0].destinationOwnershipVersion',
        2
      )
      WHERE trade_id = ? AND event_type = 'proposal_accepted'
    `).run(proposal.proposal.id);
    const beforeReplay = runtime.database.serialize();

    assert.throws(
      () =>
        executeAcceptanceRepository(
          runtime,
          proposal.proposal.id,
          "tampered-replay-acceptance"
        ),
      (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );

    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);
    assert.equal(count(runtime.database, "ownership_events"), 4);
  });

  test("enforces receiver-only acceptance, cross-league isolation, dual-role authority, and deadlines", async (t) => {
    const wrongTeam = createRuntime(t);
    const wrongTeamProposal = create(wrongTeam, "execution-wrong-team");
    await assert.rejects(
      () =>
        wrongTeam.acceptanceService.accept({
          leagueId: IDS.league,
          input: { tradeId: wrongTeamProposal.proposal.id },
          idempotencyKey: "public-accept",
          authenticated: null,
        }),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );
    await assert.rejects(
      () =>
        wrongTeam.acceptanceService.accept({
          leagueId: uuid(999),
          input: { tradeId: wrongTeamProposal.proposal.id },
          idempotencyKey: "cross-league-accept",
          authenticated: authenticated(IDS.receivingManager),
        }),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );
    await assert.rejects(
      () =>
        accept(
          wrongTeam,
          wrongTeamProposal.proposal.id,
          "wrong-team-accept",
          IDS.manager
        ),
      (error) => error?.code === "TEAM_MANAGER_REQUIRED"
    );
    wrongTeam.database
      .prepare(
        "UPDATE league_memberships SET status = 'suspended', ended_at_ms = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      )
      .run(NOW_MS, NOW_MS, IDS.receivingMembership);
    await assert.rejects(
      () =>
        accept(
          wrongTeam,
          wrongTeamProposal.proposal.id,
          "inactive-accept",
          IDS.receivingManager
        ),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );

    const frozen = createRuntime(t);
    const frozenProposal = create(frozen, "execution-frozen");
    frozen.database
      .prepare(
        "UPDATE leagues SET status = 'frozen', updated_at_ms = ?, version = version + 1 WHERE id = ?"
      )
      .run(NOW_MS, IDS.league);
    await assertAsyncExecutionReason(
      () =>
        accept(
          frozen,
          frozenProposal.proposal.id,
          "frozen-manager-accept",
          IDS.receivingManager
        ),
      TRADE_EXECUTION_CODES.roleDenied
    );
    const beforeElevatedDenials = frozen.database.serialize();
    await assert.rejects(
      () =>
        accept(
          frozen,
          frozenProposal.proposal.id,
          "frozen-commissioner-accept",
          IDS.commissioner
        ),
      (error) => error?.code === "TEAM_MANAGER_REQUIRED"
    );
    await assert.rejects(
      () =>
        accept(
          frozen,
          frozenProposal.proposal.id,
          "frozen-platform-accept",
          IDS.platformAdministrator
        ),
      (error) => error?.code === "TEAM_MANAGER_REQUIRED"
    );
    assert.equal(
      beforeElevatedDenials.equals(frozen.database.serialize()),
      true
    );

    const dualRole = createRuntime(t);
    dualRole.database.prepare(`
      UPDATE team_manager_assignments
      SET status = 'ended', ended_at_ms = ?, version = version + 1
      WHERE id = ?
    `).run(NOW_MS, IDS.receivingAssignment);
    dualRole.repositories.team_manager_assignments.insert({
      id: uuid(901),
      league_id: IDS.league,
      team_id: IDS.teamB,
      user_id: IDS.commissioner,
      membership_id: IDS.commissionerMembership,
      assigned_by_user_id: IDS.commissioner,
      replaces_assignment_id: IDS.receivingAssignment,
      status: "accepted",
      assigned_at_ms: NOW_MS,
      accepted_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    const dualRoleProposal = create(dualRole, "execution-dual-role");
    const dualRoleResult = await accept(
      dualRole,
      dualRoleProposal.proposal.id,
      "dual-role-manager-accept",
      IDS.commissioner
    );
    assert.equal(dualRoleResult.code, "TRADE_ACCEPTED");
    assert.equal(
      JSON.parse(dualRole.database.prepare(
        `SELECT metadata_json FROM trade_events
         WHERE trade_id = ? AND event_type = 'proposal_accepted'`
      ).get(dualRoleProposal.proposal.id).metadata_json).actorAuthority,
      "manager"
    );

    const deadline = createRuntime(t);
    const deadlineProposal = create(deadline, "execution-deadline");
    deadline.setNow(TRADE_DEADLINE_MS);
    const beforeDeadlineDenial = deadline.database.serialize();
    await assertAsyncExecutionReason(
      () =>
        accept(
          deadline,
          deadlineProposal.proposal.id,
          "deadline-accept"
        ),
      TRADE_EXECUTION_CODES.windowClosed
    );
    assert.equal(beforeDeadlineDenial.equals(deadline.database.serialize()), true);
  });

  test("persists an explicit unplaced transfer and general-illegality evidence", async (t) => {
    const runtime = createRuntime(t);
    for (let slotNumber = 1; slotNumber <= 12; slotNumber += 1) {
      const playerId = uuid(200 + slotNumber);
      const contractId = uuid(300 + slotNumber);
      insertPlayer(runtime.repositories, playerId, `Filler${slotNumber}`);
      insertContract(runtime.repositories, {
        id: contractId,
        yearId: uuid(400 + slotNumber),
        playerId,
        teamId: IDS.teamB,
        aavCents: 100,
        status: "active",
      });
      runtime.repositories.player_ownerships.insert({
        id: uuid(500 + slotNumber),
        league_id: IDS.league,
        season_id: IDS.currentSeason,
        player_id: playerId,
        team_id: IDS.teamB,
        ownership_kind: "Rostered",
        roster_category: "Active",
        position_group: "F",
        slot_number: slotNumber,
        acquired_transaction_type: "migration",
        acquired_transaction_id: null,
        created_at_ms: NOW_MS - 20_000,
        updated_at_ms: NOW_MS - 20_000,
        version: 1,
      });
    }
    const proposal = create(runtime, "execution-unplaced");

    const result = await accept(runtime, proposal.proposal.id, "accept-unplaced");

    assert.equal(result.generallyIllegal, true);
    assert.ok(
      result.teams
        .find((team) => team.teamId === IDS.teamB)
        .issues.some((issue) => issue.code === "NORMAL_ROSTER_SLOT_UNPLACED")
    );
    const ownership = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(IDS.contractPlayer);
    assert.notEqual(ownership.id, IDS.ownership);
    assert.equal(ownership.team_id, IDS.teamB);
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.slot_number, null);
    assert.equal(ownership.acquired_transaction_type, "trade_execution");
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
  });

  test("rolls every transfer, activity, outbox, and idempotency record back after a late failure", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "execution-late-failure");
    runtime.database.exec(`
      CREATE TRIGGER reject_m5_09_completion_outbox
      BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'trade.changed'
        AND NEW.aggregate_id = '${proposal.proposal.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced late acceptance-outbox failure');
      END;
    `);
    const before = runtime.database.serialize();

    await assert.rejects(
      () => accept(runtime, proposal.proposal.id, "late-acceptance"),
      (error) =>
        error?.code === "REPOSITORY_CONSTRAINT" &&
        error?.cause?.code === "SQLITE_CONSTRAINT_TRIGGER"
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "proposed"
    );
  });

  test("contains a post-commit late-lock failure after accepting the trade", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "execution-late-lock-failure");
    runtime.setCoordinateLateLock(async () => {
      throw new Error("forced post-commit coordinator failure");
    });

    const result = await accept(
      runtime,
      proposal.proposal.id,
      "accept-with-late-lock-failure"
    );

    assert.equal(result.code, "TRADE_ACCEPTED");
    assert.equal(runtime.lateLockBatches.length, 1);
    assert.deepEqual(result.lateLock, { status: "awaiting_data" });
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "completed"
    );
  });

  test("rejects conflicting key reuse and stale assets without partial execution", async (t) => {
    const runtime = createRuntime(t);
    const first = create(runtime, "execution-key-first");
    const second = create(runtime, "execution-key-second");
    await accept(runtime, first.proposal.id, "shared-acceptance-key");
    const beforeConflict = runtime.database.serialize();
    await assertAsyncExecutionReason(
      () => accept(runtime, second.proposal.id, "shared-acceptance-key"),
      TRADE_EXECUTION_CODES.idempotencyConflict
    );
    assert.equal(beforeConflict.equals(runtime.database.serialize()), true);

    const stale = createRuntime(t);
    const staleProposal = create(stale, "execution-stale");
    stale.database
      .prepare(
        "UPDATE draft_picks SET current_owner_team_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
      )
      .run(IDS.teamB, NOW_MS, IDS.draftPick);
    const beforeStale = stale.database.serialize();
    await assertAsyncAssetReason(
      () => accept(stale, staleProposal.proposal.id, "stale-acceptance"),
      TRADE_ASSET_CODES.ineligible
    );
    assert.equal(beforeStale.equals(stale.database.serialize()), true);

    const duplicateRetention = createRuntime(t);
    const duplicateInput = creationInput();
    duplicateInput.proposingAssets[1].retainedAavCents = 399;
    const duplicateProposal = create(
      duplicateRetention,
      "execution-duplicate-retention",
      duplicateInput
    );
    duplicateRetention.repositories.retention_obligations.insert({
      id: uuid(900),
      league_id: IDS.league,
      contract_id: IDS.contract,
      player_id: IDS.contractPlayer,
      originating_team_id: IDS.teamB,
      responsible_team_id: IDS.teamA,
      retained_aav_cents: 1,
      creation_trade_id: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    duplicateRetention.repositories.retention_years.insert({
      id: uuid(901),
      league_id: IDS.league,
      retention_obligation_id: uuid(900),
      season_id: IDS.currentSeason,
      retained_aav_cents: 1,
      status: "current",
      created_at_ms: NOW_MS,
    });
    const beforeDuplicate = duplicateRetention.database.serialize();
    await assertAsyncAssetReason(
      () =>
        accept(
          duplicateRetention,
          duplicateProposal.proposal.id,
          "duplicate-retention-accept"
        ),
      TRADE_ASSET_CODES.retentionInvalid
    );
    assert.equal(
      beforeDuplicate.equals(duplicateRetention.database.serialize()),
      true
    );
  });

  test("reruns authoritative validation when a Future Considerations trade is approved", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "future-approval-revalidation",
      creationInput()
    );
    const accepted = await accept(
      runtime,
      proposal.proposal.id,
      "future-approval-manager-accept"
    );
    assert.equal(
      accepted.proposal.storageStatus,
      "awaiting_commissioner_approval"
    );
    runtime.database.prepare(
      `UPDATE draft_picks
       SET current_owner_team_id = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ?`
    ).run(IDS.teamB, NOW_MS + 1, IDS.draftPick);
    const beforeApproval = runtime.database.serialize();

    await assertAsyncAssetReason(
      () =>
        approve(
          runtime,
          proposal.proposal.id,
          "future-approval-stale-state"
        ),
      TRADE_ASSET_CODES.ineligible
    );

    assert.equal(beforeApproval.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.readService.read({
        leagueId: IDS.league,
        tradeId: proposal.proposal.id,
        authenticated: authenticated(IDS.receivingManager),
      }).proposal.storageStatus,
      "awaiting_commissioner_approval"
    );
    assert.equal(runtime.lateLockBatches.length, 0);
  });

  test("allows an inherited platform administrator to approve without manager completion authority", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "platform-approval-proposal",
      creationInput()
    );
    await accept(
      runtime,
      proposal.proposal.id,
      "platform-approval-manager-accept"
    );
    runtime.repositories.platform_roles.insert({
      id: uuid(980_001),
      user_id: IDS.platformAdministrator,
      role: "platform_administrator",
      status: "active",
      granted_by_user_id: null,
      granted_at_ms: NOW_MS - 1,
      ended_at_ms: null,
      version: 1,
    });

    const result = await approve(
      runtime,
      proposal.proposal.id,
      "platform-approval-command",
      IDS.platformAdministrator
    );

    assert.equal(result.code, "TRADE_APPROVED");
    assert.equal(result.proposal.storageStatus, "completed");
    assert.equal(result.event.actorUserId, IDS.platformAdministrator);
    assert.equal(
      runtime.database.prepare(
        "SELECT commissioner_completion_reference FROM trades WHERE id = ?"
      ).get(proposal.proposal.id).commissioner_completion_reference,
      result.event.id
    );
    assert.equal(
      runtime.database.prepare(
        `SELECT actor_authority FROM league_activity
         WHERE related_id = ? AND event_type = 'trade_completed'`
      ).get(proposal.proposal.id).actor_authority,
      "platform_administrator"
    );
  });
});

describe("M5-07 atomic proposal response and cancellation", () => {
  test("keeps reject and cancel available while commissioner approval is pending", async (t) => {
    for (const scenario of [
      {
        action: "reject",
        userId: IDS.receivingManager,
        expectedStatus: "declined",
      },
      {
        action: "cancel",
        userId: IDS.manager,
        expectedStatus: "cancelled",
      },
    ]) {
      const runtime = createRuntime(t);
      const proposal = create(
        runtime,
        `awaiting-${scenario.action}`,
        creationInput()
      );
      const beforeSources = sourceState(runtime.database);
      await accept(
        runtime,
        proposal.proposal.id,
        `awaiting-${scenario.action}-accept`
      );

      const result = respond(runtime, {
        userId: scenario.userId,
        tradeId: proposal.proposal.id,
        action: scenario.action,
        idempotencyKey: `awaiting-${scenario.action}-response`,
      });

      assert.equal(result.proposal.storageStatus, scenario.expectedStatus);
      assert.equal(result.event.metadata.fromStatus,
        "awaiting_commissioner_approval");
      assert.equal(sourceState(runtime.database), beforeSources);
      assert.equal(runtime.lateLockBatches.length, 0);
    }
  });

  test("lets only the receiving manager reject and replays exactly", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "proposal-for-rejection",
      creationInput()
    );
    const beforeSources = sourceState(runtime.database);

    assert.throws(
      () =>
        respond(runtime, {
          userId: IDS.manager,
          tradeId: proposal.proposal.id,
          action: "reject",
          idempotencyKey: "wrong-rejector",
        }),
      { code: "TEAM_MANAGER_REQUIRED" }
    );
    const beforeElevatedDenials = runtime.database.serialize();
    for (const userId of [IDS.commissioner, IDS.platformAdministrator]) {
      assert.throws(
        () =>
          respond(runtime, {
            userId,
            tradeId: proposal.proposal.id,
            action: "reject",
            idempotencyKey: `elevated-reject-${userId}`,
          }),
        { code: "TEAM_MANAGER_REQUIRED" }
      );
    }
    assert.equal(
      beforeElevatedDenials.equals(runtime.database.serialize()),
      true
    );
    const rejected = respond(runtime, {
      userId: IDS.receivingManager,
      tradeId: proposal.proposal.id,
      action: "reject",
      idempotencyKey: "reject-proposal",
    });
    assert.equal(rejected.code, "TRADE_PROPOSAL_REJECTED");
    assert.equal(rejected.proposal.status, "Rejected");
    assert.equal(rejected.proposal.storageStatus, "declined");
    assert.equal(rejected.proposal.version, 2);
    assert.equal(rejected.event.type, "proposal_rejected");
    assert.equal(rejected.event.actorUserId, IDS.receivingManager);
    assert.equal(sourceState(runtime.database), beforeSources);
    assert.equal(count(runtime.database, "trade_assets"), 7);

    const replay = respond(runtime, {
      userId: IDS.receivingManager,
      tradeId: proposal.proposal.id,
      action: "reject",
      idempotencyKey: "reject-proposal",
    });
    assert.equal(replay.code, "TRADE_LIFECYCLE_REPLAYED");
    assert.equal(replay.event.id, rejected.event.id);
    assert.equal(count(runtime.database, "trade_events"), 2);
    assert.equal(count(runtime.database, "idempotency_requests"), 2);
    assert.equal(count(runtime.database, "league_activity"), 2);
    assert.equal(count(runtime.database, "outbox_events"), 2);
    assertLifecycleReason(
      () =>
        respond(runtime, {
          userId: IDS.manager,
          tradeId: proposal.proposal.id,
          action: "cancel",
          idempotencyKey: "terminal-cancel",
        }),
      "TRADE_LIFECYCLE_NOT_PENDING"
    );
  });

  test("lets only the proposing manager cancel without changing assets", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-for-cancel");
    assert.throws(
      () =>
        respond(runtime, {
          userId: IDS.receivingManager,
          tradeId: proposal.proposal.id,
          action: "cancel",
          idempotencyKey: "wrong-canceller",
        }),
      { code: "TEAM_MANAGER_REQUIRED" }
    );
    const beforeSources = sourceState(runtime.database);
    const cancelled = respond(runtime, {
      userId: IDS.manager,
      tradeId: proposal.proposal.id,
      action: "cancel",
      idempotencyKey: "cancel-proposal",
    });
    assert.equal(cancelled.code, "TRADE_PROPOSAL_CANCELLED");
    assert.equal(cancelled.proposal.storageStatus, "cancelled");
    assert.equal(cancelled.event.type, "proposal_cancelled");
    assert.equal(sourceState(runtime.database), beforeSources);
  });

  test("denies commissioner and platform cancellation authority without writes", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-before-freeze");
    runtime.repositories.leagues.updateVersioned({
      key: IDS.league,
      expectedVersion: 2,
      changes: { status: "frozen", updated_at_ms: NOW_MS },
    });
    assertLifecycleReason(
      () =>
        respond(runtime, {
          userId: IDS.manager,
          tradeId: proposal.proposal.id,
          action: "cancel",
          idempotencyKey: "frozen-manager",
        }),
      "TRADE_LIFECYCLE_ROLE_DENIED"
    );
    const beforeElevatedDenials = runtime.database.serialize();
    for (const userId of [IDS.commissioner, IDS.platformAdministrator]) {
      assert.throws(
        () =>
          respond(runtime, {
            userId,
            tradeId: proposal.proposal.id,
            action: "cancel",
            idempotencyKey: `frozen-elevated-cancel-${userId}`,
          }),
        { code: "TEAM_MANAGER_REQUIRED" }
      );
    }
    assert.equal(
      beforeElevatedDenials.equals(runtime.database.serialize()),
      true
    );
  });

  test("closes lifecycle actions at the exact effective deadline", (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-at-deadline");
    runtime.setNow(TRADE_DEADLINE_MS);
    assertLifecycleReason(
      () =>
        respond(runtime, {
          userId: IDS.receivingManager,
          tradeId: proposal.proposal.id,
          action: "reject",
          idempotencyKey: "late-rejection",
        }),
      "TRADE_LIFECYCLE_WINDOW_CLOSED"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "proposed"
    );
    assert.equal(count(runtime.database, "idempotency_requests"), 1);
  });

  test("rejects idempotency conflicts and rolls every late failure back", (t) => {
    const conflict = createRuntime(t);
    const first = create(conflict, "first-conflict-proposal");
    respond(conflict, {
      userId: IDS.manager,
      tradeId: first.proposal.id,
      action: "cancel",
      idempotencyKey: "shared-cancel-key",
    });
    const second = create(conflict, "second-conflict-proposal");
    assertLifecycleReason(
      () =>
        respond(conflict, {
          userId: IDS.manager,
          tradeId: second.proposal.id,
          action: "cancel",
          idempotencyKey: "shared-cancel-key",
        }),
      "TRADE_LIFECYCLE_IDEMPOTENCY_CONFLICT"
    );
    assert.equal(
      conflict.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(second.proposal.id).status,
      "proposed"
    );

    const rollback = createRuntime(t);
    const proposal = create(rollback, "rollback-response-proposal");
    rollback.database.exec(`
      CREATE TRIGGER reject_m5_09_lifecycle_outbox
      BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'trade.changed'
        AND NEW.aggregate_id = '${proposal.proposal.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced lifecycle outbox failure');
      END;
    `);
    const beforeSources = sourceState(rollback.database);
    assert.throws(
      () =>
        respond(rollback, {
          userId: IDS.receivingManager,
          tradeId: proposal.proposal.id,
          action: "reject",
          idempotencyKey: "late-response-failure",
        }),
      { code: "REPOSITORY_CONSTRAINT" }
    );
    const trade = rollback.database
      .prepare("SELECT status, version, responded_at_ms FROM trades WHERE id = ?")
      .get(proposal.proposal.id);
    assert.deepEqual(trade, {
      status: "proposed",
      version: 1,
      responded_at_ms: null,
    });
    assert.equal(count(rollback.database, "idempotency_requests"), 1);
    assert.equal(count(rollback.database, "trade_events"), 1);
    assert.equal(count(rollback.database, "league_activity"), 1);
    assert.equal(count(rollback.database, "outbox_events"), 1);
    assert.equal(sourceState(rollback.database), beforeSources);
  });
});

describe("M5-07 durable proposal expiry", () => {
  test("expires an awaiting-commissioner-approval proposal without transfers", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "awaiting-approval-expiry",
      creationInput()
    );
    const beforeSources = sourceState(runtime.database);
    await accept(
      runtime,
      proposal.proposal.id,
      "awaiting-approval-expiry-accept"
    );
    runtime.setNow(TRADE_DEADLINE_MS);

    const result = await runtime.expiryJob.run();

    assert.equal(result.expired, 1);
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT status, version FROM trades WHERE id = ?"
      ).get(proposal.proposal.id),
      { status: "expired", version: 3 }
    );
    const expiryEvent = runtime.database.prepare(
      `SELECT metadata_json FROM trade_events
       WHERE trade_id = ? AND event_type = 'proposal_expired'`
    ).get(proposal.proposal.id);
    assert.equal(
      JSON.parse(expiryEvent.metadata_json).fromStatus,
      "awaiting_commissioner_approval"
    );
    assert.equal(sourceState(runtime.database), beforeSources);
    assert.equal(runtime.lateLockBatches.length, 0);
  });

  test("never expires early or through an authenticated read", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-for-expiry-read");
    const beforeDeadline = await runtime.expiryJob.run();
    assert.equal(beforeDeadline.status, "succeeded");
    assert.equal(beforeDeadline.due, 0);
    assert.equal(count(runtime.database, "job_runs"), 0);

    runtime.setNow(TRADE_DEADLINE_MS);
    const visible = runtime.repository.listVisible({
      leagueId: IDS.league,
      viewerUserId: IDS.manager,
      viewerMembershipId: IDS.membership,
    });
    assert.equal(
      visible.find(({ id }) => id === proposal.proposal.id).storageStatus,
      "proposed"
    );
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "proposed"
    );
    assert.equal(count(runtime.database, "trade_events"), 1);
  });

  test("expires at the exact persisted deadline once with a durable occurrence", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-for-exact-expiry");
    const beforeSources = sourceState(runtime.database);
    runtime.setNow(TRADE_DEADLINE_MS);

    const result = await runtime.expiryJob.run();

    assert.deepEqual(
      {
        status: result.status,
        due: result.due,
        acquired: result.acquired,
        expired: result.expired,
        failed: result.failed,
      },
      { status: "succeeded", due: 1, acquired: 1, expired: 1, failed: 0 }
    );
    assert.deepEqual(
      runtime.database
        .prepare("SELECT status, version, responded_at_ms FROM trades WHERE id = ?")
        .get(proposal.proposal.id),
      {
        status: "expired",
        version: 2,
        responded_at_ms: TRADE_DEADLINE_MS,
      }
    );
    const event = runtime.database
      .prepare(`
        SELECT actor_user_id, event_type, reason, occurred_at_ms
        FROM trade_events
        WHERE trade_id = ? AND event_type = 'proposal_expired'
      `)
      .get(proposal.proposal.id);
    assert.deepEqual(event, {
      actor_user_id: null,
      event_type: "proposal_expired",
      reason: "effective_deadline_elapsed",
      occurred_at_ms: TRADE_DEADLINE_MS,
    });
    assert.equal(
      runtime.database
        .prepare("SELECT event_type FROM league_activity WHERE related_id = ? ORDER BY occurred_at_ms DESC LIMIT 1")
        .get(proposal.proposal.id).event_type,
      "trade_proposal_expired"
    );
    assert.equal(count(runtime.database, "league_activity"), 2);
    assert.equal(count(runtime.database, "outbox_events"), 2);
    const run = runtime.database
      .prepare("SELECT * FROM job_runs WHERE job_type = 'trades:expire:target'")
      .get();
    assert.equal(run.status, "succeeded");
    assert.equal(run.attempt_count, 1);
    assert.equal(
      run.occurrence_key,
      `trade-expiry:${proposal.proposal.id}:${TRADE_DEADLINE_MS}`
    );
    assert.equal(sourceState(runtime.database), beforeSources);

    const replay = await runtime.expiryJob.run();
    assert.equal(replay.due, 0);
    assert.equal(count(runtime.database, "job_runs"), 1);
    assert.equal(count(runtime.database, "trade_events"), 2);
    assert.equal(count(runtime.database, "league_activity"), 2);
    assert.equal(count(runtime.database, "outbox_events"), 2);
  });

  test("rolls late expiry failure back and retries the same occurrence", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(runtime, "proposal-for-expiry-retry");
    runtime.database.exec(`
      CREATE TRIGGER reject_m5_09_expiry_outbox
      BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'trade.changed'
        AND NEW.aggregate_id = '${proposal.proposal.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced expiry outbox failure');
      END;
    `);
    runtime.setNow(TRADE_DEADLINE_MS);
    const beforeSources = sourceState(runtime.database);

    const failed = await runtime.expiryJob.run();

    assert.equal(failed.status, "failed");
    assert.equal(failed.failed, 1);
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "proposed"
    );
    assert.equal(count(runtime.database, "trade_events"), 1);
    assert.equal(count(runtime.database, "league_activity"), 1);
    assert.equal(count(runtime.database, "outbox_events"), 1);
    let run = runtime.database
      .prepare("SELECT * FROM job_runs WHERE job_type = 'trades:expire:target'")
      .get();
    assert.equal(run.status, "failed");
    assert.equal(run.attempt_count, 1);
    assert.equal(run.last_error_code, "REPOSITORY_CONSTRAINT");
    assert.equal(sourceState(runtime.database), beforeSources);

    runtime.database.exec("DROP TRIGGER reject_m5_09_expiry_outbox");
    const retried = await runtime.expiryJob.run();
    assert.equal(retried.status, "succeeded");
    assert.equal(retried.expired, 1);
    run = runtime.database
      .prepare("SELECT * FROM job_runs WHERE job_type = 'trades:expire:target'")
      .get();
    assert.equal(run.status, "succeeded");
    assert.equal(run.attempt_count, 2);
    assert.equal(
      runtime.database
        .prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "expired"
    );
    assert.equal(count(runtime.database, "trade_events"), 2);
    assert.equal(count(runtime.database, "league_activity"), 2);
    assert.equal(count(runtime.database, "outbox_events"), 2);
  });
});

async function createAcceptedRecoveryTrade(
  runtime,
  key,
  input = ordinaryCreationInput()
) {
  insertContract(runtime.repositories, {
    id: IDS.prospectContract,
    yearId: IDS.prospectContractYear,
    playerId: IDS.prospectPlayer,
    teamId: IDS.teamA,
    aavCents: 100,
    status: "active",
  });
  runtime.database
    .prepare("UPDATE contracts SET contract_type = 'fantasy_elc' WHERE id = ?")
    .run(IDS.prospectContract);
  const proposal = create(runtime, `${key}-proposal`, input);
  const accepted = await accept(runtime, proposal.proposal.id, `${key}-accept`);
  if (accepted.proposal.storageStatus !== "awaiting_commissioner_approval") {
    return Object.freeze({ proposal, accepted });
  }
  const approved = await approve(
    runtime,
    proposal.proposal.id,
    `${key}-approve`
  );
  return Object.freeze({ proposal, accepted, approved });
}

function recoveryPreview(runtime, tradeId, userId = IDS.commissioner) {
  return runtime.recoveryService.preview({
    leagueId: IDS.league,
    input: { tradeId },
    authenticated: authenticated(userId),
  });
}

function reverseTrade(runtime, tradeId, idempotencyKey) {
  return runtime.recoveryService.reverse({
    leagueId: IDS.league,
    input: { tradeId, confirmed: true },
    idempotencyKey,
    authenticated: authenticated(IDS.commissioner),
  });
}

function executeReversalRepository(runtime, tradeId, idempotencyKey) {
  const trade = runtime.recoveryRepository.findRecoveryTarget({
    leagueId: IDS.league,
    tradeId,
  });
  const occurredAtMs = TRADE_DEADLINE_MS + 1;
  return runtime.recoveryRepository.recover({
    tradeId,
    eventId: uuid(995_001),
    correctionId: uuid(995_002),
    activityId: uuid(995_003),
    outboxEventId: uuid(995_004),
    idempotencyRequestId: uuid(995_005),
    leagueId: IDS.league,
    seasonId: IDS.currentSeason,
    expectedVersion: trade.version,
    actorUserId: IDS.commissioner,
    actorMembershipId: IDS.commissionerMembership,
    actorAuthority: "commissioner",
    action: "reverse",
    confirmed: true,
    occurredAtMs,
    idempotencyKey,
    idempotencyExpiresAtMs: occurredAtMs + IDEMPOTENCY_LIFETIME_MS,
  });
}

function markTradeCorrectionRequired(runtime, tradeId, idempotencyKey) {
  return runtime.recoveryService.markCorrectionRequired({
    leagueId: IDS.league,
    input: { tradeId, confirmed: true },
    idempotencyKey,
    authenticated: authenticated(IDS.commissioner),
  });
}

function assertRecoveryReason(action, reasonCode) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TradeReversalPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

async function assertAsyncRecoveryReason(action, reasonCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof TradeReversalPolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M5-10 commissioner trade reversal and recovery routing", () => {
  test("requires exact preview and explicitly confirmed write input", () => {
    assert.deepEqual(
      validateTradeReversalPreviewInput({ tradeId: IDS.priorTrade }),
      { tradeId: IDS.priorTrade }
    );
    assert.deepEqual(
      validateTradeRecoveryWriteInput({
        tradeId: IDS.priorTrade,
        confirmed: true,
      }),
      { tradeId: IDS.priorTrade, confirmed: true }
    );
    assertRecoveryReason(
      () => validateTradeRecoveryWriteInput({
        tradeId: IDS.priorTrade,
        confirmed: false,
      }),
      TRADE_REVERSAL_CODES.confirmationRequired
    );
    assertRecoveryReason(
      () => validateTradeReversalPreviewInput({
        tradeId: IDS.priorTrade,
        extra: true,
      }),
      TRADE_REVERSAL_CODES.inputInvalid
    );
  });

  test("synchronizes both trade teams and every reversed player once inside reversal", async (t) => {
    const calls = [];
    let runtime;
    runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize(command) {
          assert.equal(runtime.database.inTransaction, true);
          calls.push(command);
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-summer-sync"
    );
    calls.length = 0;
    const beforePreview = runtime.database.serialize();

    recoveryPreview(runtime, proposal.proposal.id);

    assert.equal(beforePreview.equals(runtime.database.serialize()), true);
    assert.deepEqual(calls, []);
    executeReversalRepository(
      runtime,
      proposal.proposal.id,
      "reversal-summer-sync-write"
    );
    assert.deepEqual(calls, [
      {
        leagueId: IDS.league,
        affectedTeamIds: [IDS.teamA, IDS.teamB],
        affectedPlayerIds: [IDS.contractPlayer, IDS.prospectPlayer],
        sourceOperationId: uuid(995_001),
        sourceKind: "trade_reversal",
        nowMs: TRADE_DEADLINE_MS + 1,
      },
    ]);

    executeReversalRepository(
      runtime,
      proposal.proposal.id,
      "reversal-summer-sync-write"
    );
    assert.equal(calls.length, 1);
  });

  test("rolls every reversal effect back when Candidate synchronization fails", async (t) => {
    const runtime = createRuntime(t, {
      candidateCardSummerSynchronizer: {
        synchronize({ sourceKind }) {
          if (sourceKind === "trade_reversal") {
            throw new Error("injected Candidate synchronization failure");
          }
          return Object.freeze({
            affectedCardCount: 0,
            changedCardCount: 0,
          });
        },
      },
    });
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-summer-sync-rollback"
    );
    const before = runtime.database.serialize();

    assert.throws(
      () => executeReversalRepository(
        runtime,
        proposal.proposal.id,
        "reversal-summer-sync-rollback-write"
      ),
      { code: "REPOSITORY_OPERATION_FAILED" }
    );

    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.database.prepare(
        "SELECT status FROM trades WHERE id = ?"
      ).get(proposal.proposal.id).status,
      "completed"
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count FROM trade_events
        WHERE trade_id = ? AND event_type = 'trade_reversed'
      `).get(proposal.proposal.id).count,
      0
    );
  });

  test("keeps preview read-only and denies every non-current-commissioner identity", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(runtime, "recovery-auth");
    const before = runtime.database.serialize();

    assert.throws(
      () => recoveryPreview(runtime, proposal.proposal.id, IDS.manager),
      { code: "LEAGUE_COMMISSIONER_REQUIRED" }
    );
    assert.throws(
      () => runtime.recoveryService.preview({
        leagueId: IDS.league,
        input: { tradeId: proposal.proposal.id },
        authenticated: null,
      }),
      { code: "LEAGUE_NOT_FOUND" }
    );
    assert.throws(
      () => runtime.recoveryService.preview({
        leagueId: uuid(999_991),
        input: { tradeId: proposal.proposal.id },
        authenticated: authenticated(IDS.commissioner),
      }),
      { code: "LEAGUE_NOT_FOUND" }
    );
    assert.equal(before.equals(runtime.database.serialize()), true);

    runtime.database.prepare(
      "UPDATE league_memberships SET permission_category = 'member', updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS, IDS.commissionerMembership);
    runtime.database.prepare(
      "UPDATE league_memberships SET permission_category = 'commissioner', updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS, IDS.receivingMembership);
    runtime.database.prepare(
      "UPDATE leagues SET commissioner_membership_id = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(IDS.receivingMembership, NOW_MS, IDS.league);
    assert.throws(
      () => recoveryPreview(runtime, proposal.proposal.id),
      { code: "LEAGUE_COMMISSIONER_REQUIRED" }
    );
    runtime.database.prepare(
      "UPDATE leagues SET commissioner_membership_id = NULL, updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS, IDS.league);
    runtime.database.prepare(
      "UPDATE league_memberships SET permission_category = 'manager', updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS, IDS.receivingMembership);
    runtime.database.prepare(
      "UPDATE league_memberships SET status = 'ended', ended_at_ms = ?, updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS, NOW_MS, IDS.commissionerMembership);
    assert.throws(
      () => recoveryPreview(runtime, proposal.proposal.id),
      { code: "LEAGUE_NOT_FOUND" }
    );
  });

  test("reconstructs one hidden frozen two-team reversal receipt and replays it without writes", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-repository-receipt"
    );

    const result = executeReversalRepository(
      runtime,
      proposal.proposal.id,
      "reversal-repository-receipt-write"
    );

    assert.equal(Object.keys(result).includes("committedTeams"), false);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(result, "committedTeams"),
      {
        configurable: false,
        enumerable: false,
        value: result.committedTeams,
        writable: false,
      }
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.committedTeams), true);
    assert.equal(
      Object.isFrozen(result.event.metadata.ownershipTenureMappings),
      true
    );
    assert.equal(
      result.event.metadata.ownershipTenureMappings.every(Object.isFrozen),
      true
    );
    assert.deepEqual(
      result.committedTeams.map(({ teamId }) => teamId),
      [IDS.teamA, IDS.teamB]
    );
    assert.equal(
      result.committedTeams.every(
        (team) =>
          Object.isFrozen(team) &&
          Object.isFrozen(team.ownershipWitnesses)
      ),
      true
    );
    assert.equal(
      result.committedTeams[0].ownershipWitnesses.every(
        (witness) => witness.state === "present" && Object.isFrozen(witness)
      ),
      true
    );
    assert.equal(
      result.committedTeams[1].ownershipWitnesses.every(
        (witness) => witness.state === "deleted" && Object.isFrozen(witness)
      ),
      true
    );

    const bytesAfter = runtime.database.serialize();
    const replay = executeReversalRepository(
      runtime,
      proposal.proposal.id,
      "reversal-repository-receipt-write"
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      replay.event.metadata.ownershipTenureMappings,
      result.event.metadata.ownershipTenureMappings
    );
    assert.deepEqual(replay.committedTeams, result.committedTeams);
    assert.equal(bytesAfter.equals(runtime.database.serialize()), true);
  });

  test("coordinates both participant teams with empty witnesses for a non-roster reversal", async (t) => {
    const runtime = createRuntime(t);
    const proposal = create(
      runtime,
      "reversal-cap-only-receipt",
      creationInput({
        proposingAssets: [
          {
            type: "draft_pick",
            draftPickId: IDS.draftPick,
          },
        ],
        receivingAssets: [
          {
            type: "buyout_obligation",
            buyoutObligationId: IDS.buyout,
          },
        ],
      })
    );
    await accept(
      runtime,
      proposal.proposal.id,
      "reversal-cap-only-acceptance"
    );
    runtime.setNow(TRADE_DEADLINE_MS + 1);

    const result = await reverseTrade(
      runtime,
      proposal.proposal.id,
      "reversal-cap-only-write"
    );

    assert.deepEqual(result.lateLock, { status: "not_applicable" });
    assert.equal(
      Object.hasOwn(result.event.metadata, "ownershipTenureMappings"),
      false
    );
    assert.equal(runtime.lateLockBatches.length, 2);
    assert.deepEqual(runtime.lateLockBatches[1], {
      mutationKind: "trade_reversal",
      teams: [
        {
          leagueId: IDS.league,
          seasonId: IDS.currentSeason,
          teamId: IDS.teamA,
          ownershipWitnesses: [],
        },
        {
          leagueId: IDS.league,
          seasonId: IDS.currentSeason,
          teamId: IDS.teamB,
          ownershipWitnesses: [],
        },
      ],
    });
  });

  test("rejects a tampered initial reversal receipt and rolls every tenure effect back", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-tampered-initial"
    );
    runtime.database.exec(`
      CREATE TRIGGER tamper_trade_reversal_ownership_mapping
      AFTER INSERT ON trade_events
      WHEN NEW.trade_id = '${proposal.proposal.id}'
        AND NEW.event_type = 'trade_reversed'
      BEGIN
        UPDATE trade_events
        SET metadata_json = json_set(
          metadata_json,
          '$.ownershipTenureMappings[0].destinationOwnershipVersion',
          2
        )
        WHERE id = NEW.id;
      END;
    `);
    runtime.setNow(TRADE_DEADLINE_MS + 1);
    const before = runtime.database.serialize();

    await assert.rejects(
      () => reverseTrade(
        runtime,
        proposal.proposal.id,
        "reversal-tampered-initial-write"
      ),
      (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
    );

    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "completed"
    );
    assert.equal(
      runtime.database.prepare(`
        SELECT COUNT(*) AS count FROM ownership_events
        WHERE source_type = 'trade_reversal' AND source_id = ?
      `).get(proposal.proposal.id).count,
      0
    );
  });

  test("rejects tampered replay mapping or schema-v2 history without writes or resurrection", async (t) => {
    const cases = [
      ["mapping", (database, tradeId) => {
        database.prepare(`
          UPDATE trade_events
          SET metadata_json = json_set(
            metadata_json,
            '$.ownershipTenureMappings[0].destinationOwnershipVersion',
            2
          )
          WHERE trade_id = ? AND event_type = 'trade_reversed'
        `).run(tradeId);
      }],
      ["history", (database, tradeId) => {
        database.prepare(`
          UPDATE ownership_events
          SET after_metadata_json = json_set(
            after_metadata_json,
            '$.schemaVersion',
            1
          )
          WHERE source_type = 'trade_reversal'
            AND source_id = ?
            AND event_type = 'trade_reversal_in'
        `).run(tradeId);
      }],
    ];

    for (const [label, tamper] of cases) {
      const runtime = createRuntime(t);
      const { proposal } = await createAcceptedRecoveryTrade(
        runtime,
        `reversal-tampered-replay-${label}`
      );
      runtime.setNow(TRADE_DEADLINE_MS + 1);
      await reverseTrade(
        runtime,
        proposal.proposal.id,
        `reversal-tampered-replay-${label}-write`
      );
      const reversalOwnershipId = runtime.database.prepare(`
        SELECT id FROM player_ownerships
        WHERE acquired_transaction_type = 'trade_reversal'
          AND acquired_transaction_id = ?
        ORDER BY id LIMIT 1
      `).get(proposal.proposal.id).id;
      tamper(runtime.database, proposal.proposal.id);
      const beforeReplay = runtime.database.serialize();

      await assert.rejects(
        () => reverseTrade(
          runtime,
          proposal.proposal.id,
          `reversal-tampered-replay-${label}-write`
        ),
        (error) => error?.code === "REPOSITORY_SCHEMA_INCOMPATIBLE"
      );

      assert.equal(
        beforeReplay.equals(runtime.database.serialize()),
        true,
        label
      );
      assert.equal(
        runtime.database.prepare(`
          SELECT COUNT(*) AS count FROM player_ownerships
          WHERE id IN (?, ?, ?)
        `).get(
          IDS.ownership,
          IDS.prospectOwnership,
          reversalOwnershipId
        ).count,
        1,
        label
      );
    }
  });

  test("reverses every new-proposal asset form after the deadline and replays without writes", async (t) => {
    const runtime = createRuntime(t);
    const contractBefore = runtime.database
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(IDS.contract);
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "safe-recovery",
      creationInput()
    );
    const acceptanceMetadata = JSON.parse(
      runtime.database.prepare(
        "SELECT metadata_json FROM trade_events WHERE trade_id = ? AND event_type = 'proposal_accepted'"
      ).get(proposal.proposal.id).metadata_json
    );
    const acceptedContractMapping = acceptanceMetadata.ownershipTransfers.find(
      ({ sourceOwnershipId }) => sourceOwnershipId === IDS.ownership
    );
    const acceptedProspectMapping = acceptanceMetadata.ownershipTransfers.find(
      ({ sourceOwnershipId }) => sourceOwnershipId === IDS.prospectOwnership
    );
    runtime.database.prepare(`
      INSERT INTO roster_display_order_sets (
        id, league_id, season_id, team_id, updated_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      uuid(971_001),
      IDS.league,
      IDS.currentSeason,
      IDS.teamB,
      IDS.receivingManager,
      NOW_MS,
      NOW_MS
    );
    runtime.database.prepare(`
      INSERT INTO roster_display_order_entries (
        id, league_id, order_set_id, ownership_id,
        position_group, display_order, created_at_ms
      ) VALUES (?, ?, ?, ?, 'F', 1, ?)
    `).run(
      uuid(971_002),
      IDS.league,
      uuid(971_001),
      acceptedContractMapping.destinationOwnershipId,
      NOW_MS
    );
    const createdAssets = runtime.database.prepare(`
      SELECT id, asset_type, future_consideration_description
      FROM trade_assets WHERE trade_id = ? ORDER BY sequence
    `).all(proposal.proposal.id);

    const beforePreview = runtime.database.serialize();
    const previewed = recoveryPreview(runtime, proposal.proposal.id);
    assert.equal(previewed.code, "TRADE_REVERSAL_PREVIEWED");
    assert.equal(
      previewed.preview.recoverable,
      true,
      JSON.stringify(previewed.preview.mismatches)
    );
    assert.equal(previewed.preview.assets.length, 7);
    assert.equal(beforePreview.equals(runtime.database.serialize()), true);

    const beforeWrongRoute = runtime.database.serialize();
    await assertAsyncRecoveryReason(
      () => markTradeCorrectionRequired(
        runtime,
        proposal.proposal.id,
        "safe-correction-route"
      ),
      TRADE_REVERSAL_CODES.correctionNotRequired
    );
    assert.equal(beforeWrongRoute.equals(runtime.database.serialize()), true);

    runtime.setNow(TRADE_DEADLINE_MS + 1);
    const reversed = await reverseTrade(
      runtime,
      proposal.proposal.id,
      "safe-recovery-reverse"
    );
    assert.equal(reversed.code, "TRADE_REVERSED");
    assert.equal(reversed.trade.storageStatus, "reversed");
    assert.equal(reversed.trade.version, 4);
    assert.deepEqual(reversed.lateLock, { status: "not_applicable" });
    assert.equal(
      Object.hasOwn(reversed.event.metadata, "ownershipTenureMappings"),
      false
    );

    const ownership = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(IDS.contractPlayer);
    assert.notEqual(ownership.id, IDS.ownership);
    assert.notEqual(ownership.id, acceptedContractMapping.destinationOwnershipId);
    assert.equal(ownership.team_id, IDS.teamA);
    assert.equal(ownership.roster_category, "Active");
    assert.equal(ownership.slot_number, 1);
    assert.equal(ownership.acquired_transaction_type, "trade_reversal");
    assert.equal(ownership.acquired_transaction_id, proposal.proposal.id);
    assert.equal(ownership.version, 1);
    const prospect = runtime.database
      .prepare("SELECT * FROM player_ownerships WHERE player_id = ?")
      .get(IDS.prospectPlayer);
    assert.notEqual(prospect.id, IDS.prospectOwnership);
    assert.notEqual(prospect.id, acceptedProspectMapping.destinationOwnershipId);
    assert.equal(prospect.team_id, IDS.teamA);
    assert.equal(prospect.roster_category, "Prospect");
    assert.equal(prospect.version, 1);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM player_ownerships WHERE id IN (?, ?, ?, ?)"
      ).get(
        IDS.ownership,
        IDS.prospectOwnership,
        acceptedContractMapping.destinationOwnershipId,
        acceptedProspectMapping.destinationOwnershipId
      ).count,
      0
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM roster_display_order_entries WHERE ownership_id = ?"
      ).get(acceptedContractMapping.destinationOwnershipId).count,
      0
    );
    const reversalMetadata = JSON.parse(
      runtime.database.prepare(
        "SELECT metadata_json FROM trade_events WHERE trade_id = ? AND event_type = 'trade_reversed'"
      ).get(proposal.proposal.id).metadata_json
    );
    const reversedContractMapping = reversalMetadata.ownershipTenureMappings.find(
      ({ sourceOwnershipId }) =>
        sourceOwnershipId === acceptedContractMapping.destinationOwnershipId
    );
    assert.deepEqual(
      {
        sourceTeamId: reversedContractMapping.sourceTeamId,
        destinationTeamId: reversedContractMapping.destinationTeamId,
        sourceOwnershipId: reversedContractMapping.sourceOwnershipId,
        sourceOwnershipVersion: reversedContractMapping.sourceOwnershipVersion,
        destinationOwnershipId: reversedContractMapping.destinationOwnershipId,
        destinationOwnershipVersion:
          reversedContractMapping.destinationOwnershipVersion,
      },
      {
        sourceTeamId: IDS.teamB,
        destinationTeamId: IDS.teamA,
        sourceOwnershipId: acceptedContractMapping.destinationOwnershipId,
        sourceOwnershipVersion: 1,
        destinationOwnershipId: ownership.id,
        destinationOwnershipVersion: 1,
      }
    );
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT event_type FROM ownership_events ORDER BY event_type, ownership_id"
      ).all().map(({ event_type }) => event_type),
      [
        "trade_reversal_in",
        "trade_reversal_in",
        "trade_reversal_out",
        "trade_reversal_out",
        "trade_transfer_in",
        "trade_transfer_in",
        "trade_transfer_out",
        "trade_transfer_out",
      ]
    );
    const reversalHistory = runtime.database.prepare(`
      SELECT event_type, before_metadata_json, after_metadata_json
      FROM ownership_events
      WHERE source_type = 'trade_reversal' AND source_id = ?
      ORDER BY event_type, ownership_id
    `).all(proposal.proposal.id).map((row) => ({
      eventType: row.event_type,
      before: JSON.parse(row.before_metadata_json),
      after: JSON.parse(row.after_metadata_json),
    }));
    assert.equal(reversalHistory.length, 4);
    assert.equal(
      reversalHistory.every(
        ({ before, after }) =>
          before.schemaVersion === 2 && after.schemaVersion === 2
      ),
      true
    );
    assert.equal(
      reversalHistory.every(({ eventType, before, after }) =>
        eventType === "trade_reversal_out"
          ? before.exists === true && after.exists === false
          : before.exists === false && after.exists === true
      ),
      true
    );
    assert.equal(runtime.lateLockBatches.length, 2);
    assert.equal(runtime.lateLockBatches[1].mutationKind, "trade_reversal");
    assert.deepEqual(
      runtime.lateLockBatches[1].teams.map((team) => ({
        teamId: team.teamId,
        witnesses: team.ownershipWitnesses,
      })),
      [
        {
          teamId: IDS.teamA,
          witnesses: reversalMetadata.ownershipTenureMappings
            .map((mapping) => ({
              ownershipId: mapping.destinationOwnershipId,
              ownershipVersion: mapping.destinationOwnershipVersion,
              state: "present",
            }))
            .sort((left, right) =>
              left.ownershipId.localeCompare(right.ownershipId)
            ),
        },
        {
          teamId: IDS.teamB,
          witnesses: reversalMetadata.ownershipTenureMappings
            .map((mapping) => ({
              ownershipId: mapping.sourceOwnershipId,
              ownershipVersion: mapping.sourceOwnershipVersion,
              state: "deleted",
            }))
            .sort((left, right) =>
              left.ownershipId.localeCompare(right.ownershipId)
            ),
        },
      ]
    );

    const contractAfter = runtime.database
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(IDS.contract);
    assert.equal(contractAfter.current_team_id, IDS.teamA);
    assert.equal(contractAfter.version, 3);
    for (const field of [
      "contract_type",
      "original_total_value_cents",
      "original_term_years",
      "aav_cents",
      "start_season_id",
      "status",
      "acquisition_source_type",
      "acquisition_source_id",
      "auction_buyout_lock_expires_at_ms",
    ]) {
      assert.equal(contractAfter[field], contractBefore[field], field);
    }
    assert.equal(
      runtime.database.prepare("SELECT current_team_id FROM contracts WHERE id = ?")
        .get(IDS.prospectContract).current_team_id,
      IDS.teamA
    );
    assert.equal(
      runtime.database.prepare("SELECT current_owner_team_id FROM draft_picks WHERE id = ?")
        .get(IDS.draftPick).current_owner_team_id,
      IDS.teamA
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM draft_pick_ownership_events WHERE draft_pick_id = ?")
        .get(IDS.draftPick).count,
      2
    );
    assert.equal(
      runtime.database.prepare("SELECT responsible_team_id FROM buyout_obligations WHERE id = ?")
        .get(IDS.buyout).responsible_team_id,
      IDS.teamB
    );
    assert.deepEqual(
      runtime.database.prepare(
        "SELECT receiving_team_id, status, resolved_at_ms FROM future_considerations WHERE id = ?"
      ).get(IDS.futureConsideration),
      {
        receiving_team_id: IDS.teamB,
        status: "outstanding",
        resolved_at_ms: null,
      }
    );
    const createdRetention = createdAssets.find(
      (asset) => asset.asset_type === "requested_retention"
    );
    const createdConsideration = createdAssets.find(
      (asset) => asset.future_consideration_description !== null
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM retention_obligations WHERE id = ?")
        .get(createdRetention.id).count,
      0
    );
    assert.equal(
      runtime.database.prepare("SELECT COUNT(*) AS count FROM future_considerations WHERE id = ?")
        .get(createdConsideration.id).count,
      0
    );
    assert.equal(count(runtime.database, "commissioner_corrections"), 1);
    assert.equal(
      runtime.database.prepare(
        "SELECT event_type FROM league_activity WHERE related_id = ? ORDER BY occurred_at_ms DESC LIMIT 1"
      ).get(proposal.proposal.id).event_type,
      "trade_reversed"
    );
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);

    const beforeReplay = runtime.database.serialize();
    const replay = await reverseTrade(
      runtime,
      proposal.proposal.id,
      "safe-recovery-reverse"
    );
    assert.equal(replay.code, "TRADE_RECOVERY_REPLAYED");
    assert.equal(replay.event.id, reversed.event.id);
    assert.deepEqual(replay.lateLock, { status: "not_applicable" });
    assert.equal(runtime.lateLockBatches.length, 3);
    assert.deepEqual(runtime.lateLockBatches[2], runtime.lateLockBatches[1]);
    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);

    runtime.setNow(NOW_MS);
    const second = create(runtime, "safe-recovery-second-proposal");
    await accept(runtime, second.proposal.id, "safe-recovery-second-accept");
    const beforeConflict = runtime.database.serialize();
    await assertAsyncRecoveryReason(
      () => reverseTrade(
        runtime,
        second.proposal.id,
        "safe-recovery-reverse"
      ),
      TRADE_REVERSAL_CODES.idempotencyConflict
    );
    assert.equal(beforeConflict.equals(runtime.database.serialize()), true);
  });

  test("reports every bounded unsafe post-trade state without writes", async (t) => {
    const cases = [
      [TRADE_REVERSAL_REASON_CODES.assetMoved, (runtime) => {
        runtime.database.prepare(
          "UPDATE player_ownerships SET team_id = ?, updated_at_ms = ?, version = version + 1 WHERE player_id = ?"
        ).run(IDS.teamA, NOW_MS + 1, IDS.contractPlayer);
      }],
      [TRADE_REVERSAL_REASON_CODES.assetChanged, (runtime) => {
        runtime.database.prepare(
          "UPDATE contracts SET original_total_value_cents = 1100, aav_cents = 1100, updated_at_ms = ?, version = version + 1 WHERE id = ?"
        ).run(NOW_MS + 1, IDS.contract);
      }],
      [TRADE_REVERSAL_REASON_CODES.assetConsumed, (runtime) => {
        runtime.database.prepare(
          "UPDATE draft_picks SET status = 'forfeited', updated_at_ms = ?, version = version + 1 WHERE id = ?"
        ).run(NOW_MS + 1, IDS.draftPick);
      }],
      [TRADE_REVERSAL_REASON_CODES.obligationChanged, (runtime) => {
        runtime.database.prepare(
          "UPDATE buyout_obligations SET status = 'completed', updated_at_ms = ?, version = version + 1 WHERE id = ?"
        ).run(NOW_MS + 1, IDS.buyout);
      }],
      [TRADE_REVERSAL_REASON_CODES.createdObligationMissing, (runtime, tradeId) => {
        const createdId = runtime.database.prepare(
          "SELECT id FROM trade_assets WHERE trade_id = ? AND future_consideration_description IS NOT NULL"
        ).get(tradeId).id;
        runtime.database.prepare(
          "DELETE FROM future_considerations WHERE id = ?"
        ).run(createdId);
      }],
      [TRADE_REVERSAL_REASON_CODES.createdObligationChanged, (runtime, tradeId) => {
        const createdId = runtime.database.prepare(
          "SELECT id FROM trade_assets WHERE trade_id = ? AND asset_type = 'requested_retention'"
        ).get(tradeId).id;
        runtime.database.prepare(
          "UPDATE retention_obligations SET retained_aav_cents = retained_aav_cents - 1, updated_at_ms = ?, version = version + 1 WHERE id = ?"
        ).run(NOW_MS + 1, createdId);
      }],
      [TRADE_REVERSAL_REASON_CODES.originalSlotOccupied, (runtime) => {
        const playerId = uuid(990_001);
        insertPlayer(runtime.repositories, playerId, "Occupant");
        runtime.repositories.player_ownerships.insert({
          id: uuid(990_002),
          league_id: IDS.league,
          season_id: IDS.currentSeason,
          player_id: playerId,
          team_id: IDS.teamA,
          ownership_kind: "Rostered",
          roster_category: "Active",
          position_group: "F",
          slot_number: 1,
          acquired_transaction_type: "migration",
          acquired_transaction_id: null,
          created_at_ms: NOW_MS + 1,
          updated_at_ms: NOW_MS + 1,
          version: 1,
        });
      }],
      [TRADE_REVERSAL_REASON_CODES.snapshotInvalid, (runtime, tradeId) => {
        runtime.database.prepare(
          "UPDATE trade_assets SET proposal_snapshot_json = '{}' WHERE trade_id = ? AND sequence = 1"
        ).run(tradeId);
      }],
      [TRADE_REVERSAL_REASON_CODES.assetMissing, (runtime) => {
        runtime.database.pragma("foreign_keys = OFF");
        runtime.database.prepare(
          "DELETE FROM player_ownerships WHERE player_id = ?"
        ).run(IDS.contractPlayer);
        runtime.database.pragma("foreign_keys = ON");
      }],
    ];

    for (const [reasonCode, mutate] of cases) {
      const runtime = createRuntime(t);
      const { proposal } = await createAcceptedRecoveryTrade(
        runtime,
        `unsafe-${reasonCode.toLowerCase()}`,
        reasonCode === TRADE_REVERSAL_REASON_CODES.createdObligationMissing
          ? creationInput()
          : ordinaryCreationInput()
      );
      mutate(runtime, proposal.proposal.id);
      const before = runtime.database.serialize();
      const result = recoveryPreview(runtime, proposal.proposal.id);
      assert.equal(result.preview.recoverable, false, reasonCode);
      assert.ok(
        result.preview.mismatches.some(
          (mismatch) => mismatch.reasonCode === reasonCode
        ),
        reasonCode
      );
      assert.equal(before.equals(runtime.database.serialize()), true, reasonCode);
    }
  });

  test("reports consumed state, rejects direct reversal, and routes correction without moving assets", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(runtime, "unsafe-recovery");
    runtime.database.prepare(
      "UPDATE draft_picks SET status = 'forfeited', updated_at_ms = ?, version = version + 1 WHERE id = ?"
    ).run(NOW_MS + 1, IDS.draftPick);
    const beforePreview = runtime.database.serialize();
    const previewed = recoveryPreview(runtime, proposal.proposal.id);
    assert.equal(previewed.preview.recoverable, false);
    assert.ok(previewed.preview.mismatches.some(
      ({ reasonCode }) => reasonCode === TRADE_REVERSAL_REASON_CODES.assetConsumed
    ));
    assert.equal(beforePreview.equals(runtime.database.serialize()), true);

    const beforeRejectedReverse = runtime.database.serialize();
    await assertAsyncRecoveryReason(
      () => reverseTrade(runtime, proposal.proposal.id, "unsafe-direct-reverse"),
      TRADE_REVERSAL_CODES.safeReversalRequired
    );
    assert.equal(
      beforeRejectedReverse.equals(runtime.database.serialize()),
      true
    );

    const assetsBeforeRouting = sourceState(runtime.database);
    runtime.setNow(NOW_MS + 2);
    const routed = await markTradeCorrectionRequired(
      runtime,
      proposal.proposal.id,
      "unsafe-correction-route"
    );
    assert.equal(routed.code, "TRADE_CORRECTION_REQUIRED");
    assert.equal(routed.trade.storageStatus, "correction_required");
    assert.equal(sourceState(runtime.database), assetsBeforeRouting);
    assert.equal(
      runtime.database.prepare("SELECT reason FROM commissioner_corrections WHERE feature_record_id = ?")
        .get(proposal.proposal.id).reason,
      "direct_trade_reversal_unsafe"
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT event_type FROM league_activity WHERE related_id = ? AND event_type = 'trade_correction_required'"
      ).get(proposal.proposal.id).event_type,
      "trade_correction_required"
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT event_type FROM outbox_events WHERE aggregate_id = ? ORDER BY created_at_ms DESC LIMIT 1"
      ).get(proposal.proposal.id).event_type,
      "trade.changed"
    );
    const beforeReplay = runtime.database.serialize();
    const replay = await markTradeCorrectionRequired(
      runtime,
      proposal.proposal.id,
      "unsafe-correction-route"
    );
    assert.equal(replay.code, "TRADE_RECOVERY_REPLAYED");
    assert.equal(replay.event.id, routed.event.id);
    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);
  });

  test("contains a post-commit late-lock failure after reversing the trade", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-late-lock-failure"
    );
    runtime.setCoordinateLateLock(async () => {
      throw new Error("forced post-commit coordinator failure");
    });
    runtime.setNow(TRADE_DEADLINE_MS + 1);

    const result = await reverseTrade(
      runtime,
      proposal.proposal.id,
      "reverse-with-late-lock-failure"
    );

    assert.equal(result.code, "TRADE_REVERSED");
    assert.deepEqual(result.lateLock, { status: "awaiting_data" });
    assert.equal(runtime.lateLockBatches.length, 2);
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "reversed"
    );
  });

  test("contains an unsafe private reversal receipt after the roster commit", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(
      runtime,
      "reversal-unsafe-private-receipt"
    );
    const unsafeRepository = Object.freeze({
      findRecoveryTarget(options) {
        return runtime.recoveryRepository.findRecoveryTarget(options);
      },
      preview(options) {
        return runtime.recoveryRepository.preview(options);
      },
      recover(options) {
        const committed = runtime.recoveryRepository.recover(options);
        return Object.freeze({
          ...committed,
          committedTeams: committed.committedTeams,
        });
      },
    });
    let coordinatorReached = false;
    const unsafeService = createTradeReversalService({
      leagueAuthorization: runtime.leagueAuthorization,
      repository: unsafeRepository,
      lateLockCoordinator: Object.freeze({
        async coordinateCommittedRoster() {
          coordinatorReached = true;
          throw new Error("an unsafe receipt must not reach the coordinator");
        },
      }),
      clock: runtime.clock,
      secureRandom: runtime.secureRandom,
    });
    runtime.setNow(TRADE_DEADLINE_MS + 1);

    const result = await unsafeService.reverse({
      leagueId: IDS.league,
      input: { tradeId: proposal.proposal.id, confirmed: true },
      idempotencyKey: "reversal-unsafe-private-receipt-write",
      authenticated: authenticated(IDS.commissioner),
    });

    assert.equal(result.code, "TRADE_REVERSED");
    assert.deepEqual(result.lateLock, { status: "awaiting_data" });
    assert.equal(coordinatorReached, false);
    assert.equal(
      Object.hasOwn(result.event.metadata, "ownershipTenureMappings"),
      false
    );
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "reversed"
    );
  });

  test("rolls back every reversal effect after a late transactional failure", async (t) => {
    const runtime = createRuntime(t);
    const { proposal } = await createAcceptedRecoveryTrade(runtime, "rollback-recovery");
    runtime.database.exec(`
      CREATE TRIGGER reject_m5_10_recovery_outbox
      BEFORE INSERT ON outbox_events
      WHEN NEW.event_type = 'trade.changed'
        AND NEW.aggregate_id = '${proposal.proposal.id}'
      BEGIN
        SELECT RAISE(ABORT, 'forced recovery outbox failure');
      END;
    `);
    const before = runtime.database.serialize();
    await assert.rejects(
      () => reverseTrade(runtime, proposal.proposal.id, "rollback-reverse"),
      { code: "REPOSITORY_CONSTRAINT" }
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
    assert.equal(
      runtime.database.prepare("SELECT status FROM trades WHERE id = ?")
        .get(proposal.proposal.id).status,
      "completed"
    );
  });
});
