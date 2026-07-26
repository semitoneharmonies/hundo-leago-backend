const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../../infrastructure/database/connection");
const {
  createSqliteTradeProposalRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  ACCOUNT_ALIASES,
  BETA_PLAYER_TEAM_NUMBERS,
  FIXTURE_BUILD_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  FIXTURE_VERSION,
  INVALID_CAP_BUYOUT_PENALTY_CENTS,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  TEAM_NAMES_BY_LEAGUE,
  checksumManifest,
  fixtureId,
} = require("./releaseQaFixtureContract");

class ReleaseQaFixtureVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseQaFixtureVerificationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ReleaseQaFixtureVerificationError(code, message, details);
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${description}.`,
      { actual, expected }
    );
  }
}

function count(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters).count;
}

function resolveFixturePlayerIds(database) {
  const synthetic = Object.fromEntries(
    PLAYER_BLUEPRINTS.map(({ alias }) => [alias, fixtureId(`player:${alias}`)])
  );
  const syntheticCount = database
    .prepare(
      `SELECT COUNT(*) AS count FROM players WHERE id IN (${PLAYER_BLUEPRINTS.map(
        () => "?"
      ).join(", ")})`
    )
    .get(...Object.values(synthetic)).count;
  if (syntheticCount === PLAYER_BLUEPRINTS.length) {
    return Object.freeze(synthetic);
  }
  assertEqual(syntheticCount, 0, "partial synthetic player identity set");

  const providerPlayers = database
    .prepare(`
      SELECT player.id, source.normalized_position
      FROM players AS player
      INNER JOIN player_external_ids AS external
        ON external.player_id = player.id
       AND external.provider = 'sportsdataio-discovery-lab'
      INNER JOIN player_source_state AS source
        ON source.player_id = player.id
       AND source.provider = 'sportsdataio-discovery-lab'
       AND source.ended_at_ms IS NULL
       AND source.active = 1
       AND source.normalized_position IN ('F', 'D')
      WHERE player.status = 'active'
      GROUP BY player.id
      ORDER BY lower(player.full_name) ASC, player.id ASC
    `)
    .all();
  const byPosition = new Map([
    ["F", providerPlayers.filter(({ normalized_position }) => normalized_position === "F")],
    ["D", providerPlayers.filter(({ normalized_position }) => normalized_position === "D")],
  ]);
  const offsets = new Map([
    ["F", 0],
    ["D", 0],
  ]);
  const resolved = {};
  for (const blueprint of PLAYER_BLUEPRINTS) {
    const offset = offsets.get(blueprint.position);
    const selected = byPosition.get(blueprint.position)[offset];
    assertEqual(
      Boolean(selected),
      true,
      `provider-backed ${blueprint.position} player identity`
    );
    resolved[blueprint.alias] = selected.id;
    offsets.set(blueprint.position, offset + 1);
  }
  return Object.freeze(resolved);
}

function verifyTradeScenarios(database, alias, leagueId, playerIds) {
  const scenarioId = (scenarioAlias) =>
    fixtureId(`trade-scenario:${alias}:${scenarioAlias}:1`);
  const completedTradeId = scenarioId("accepted");
  const rejectedTradeId = scenarioId("rejected");
  const invalidCapTradeId = scenarioId("invalid-cap");
  const completed = database.prepare(`
    SELECT status, responded_at_ms, completed_at_ms,
      commissioner_completion_reference
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, completedTradeId);
  assertEqual(completed?.status, "completed", `${alias} accepted storage status`);
  assertEqual(
    Number.isSafeInteger(completed?.responded_at_ms),
    true,
    `${alias} accepted response timestamp`
  );
  assertEqual(
    Number.isSafeInteger(completed?.completed_at_ms),
    true,
    `${alias} accepted completion timestamp`
  );
  assertEqual(
    typeof completed?.commissioner_completion_reference,
    "string",
    `${alias} commissioner completion reference`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM trade_events
      WHERE league_id=? AND trade_id=? AND event_type='proposal_accepted'
    `, leagueId, completedTradeId),
    1,
    `${alias} accepted lifecycle evidence`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM ownership_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer'
    `, leagueId, completedTradeId),
    2,
    `${alias} accepted ownership history`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM contract_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer'
    `, leagueId, completedTradeId),
    2,
    `${alias} accepted contract history`
  );
  for (const [playerAlias, destinationTeamNumber] of [
    ["activeForward7", 2],
    ["activeForward8", 1],
  ]) {
    const executedAsset = database.prepare(`
      SELECT contracts.current_team_id AS contractTeamId,
        player_ownerships.team_id AS ownershipTeamId,
        player_ownerships.acquired_transaction_type AS acquisitionType,
        player_ownerships.acquired_transaction_id AS acquisitionId
      FROM contracts
      JOIN player_ownerships
        ON player_ownerships.league_id=contracts.league_id
       AND player_ownerships.player_id=contracts.player_id
      WHERE contracts.league_id=? AND contracts.player_id=?
    `).get(leagueId, playerIds[playerAlias]);
    const destinationTeamId = fixtureId(`team:${alias}:${destinationTeamNumber}`);
    assertEqual(
      executedAsset?.contractTeamId,
      destinationTeamId,
      `${alias} ${playerAlias} executed contract destination`
    );
    assertEqual(
      executedAsset?.ownershipTeamId,
      destinationTeamId,
      `${alias} ${playerAlias} executed ownership destination`
    );
    assertEqual(
      executedAsset?.acquisitionType,
      "trade_execution",
      `${alias} ${playerAlias} executed acquisition type`
    );
    assertEqual(
      executedAsset?.acquisitionId,
      completedTradeId,
      `${alias} ${playerAlias} executed transaction identity`
    );
  }

  const rejected = database.prepare(`
    SELECT status, responded_at_ms, completed_at_ms
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, rejectedTradeId);
  assertEqual(rejected?.status, "declined", `${alias} rejected storage status`);
  assertEqual(
    Number.isSafeInteger(rejected?.responded_at_ms),
    true,
    `${alias} rejected response timestamp`
  );
  assertEqual(rejected?.completed_at_ms, null, `${alias} rejected completion absence`);
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM trade_events
      WHERE league_id=? AND trade_id=? AND event_type='proposal_rejected'
    `, leagueId, rejectedTradeId),
    1,
    `${alias} rejected lifecycle evidence`
  );

  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT trades.id
        FROM trades
        JOIN trade_assets
          ON trade_assets.league_id=trades.league_id
         AND trade_assets.trade_id=trades.id
        WHERE trades.league_id=?
        GROUP BY trades.id
        HAVING COUNT(*) >= 2 AND COUNT(DISTINCT trade_assets.direction)=2
      )
    `, leagueId),
    5,
    `${alias} two-sided trade scenario count`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM buyout_years
      WHERE league_id=? AND buyout_obligation_id=? AND season_id=?
        AND status='current' AND penalty_cents=?
    `, leagueId, fixtureId(`buyout:${alias}`),
    fixtureId(`season:${alias}:current`),
    INVALID_CAP_BUYOUT_PENALTY_CENTS),
    1,
    `${alias} invalid-cap obligation amount`
  );

  const invalidCapTrade = database.prepare(`
    SELECT id, season_id, proposing_team_id, receiving_team_id,
      effective_deadline_at_ms, version
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, invalidCapTradeId);
  assertEqual(invalidCapTrade?.id, invalidCapTradeId, `${alias} invalid-cap trade`);
  const invalidCapPreview = createSqliteTradeProposalRepository({
    database,
  }).previewAcceptance({
    tradeId: invalidCapTrade.id,
    leagueId,
    seasonId: invalidCapTrade.season_id,
    proposingTeamId: invalidCapTrade.proposing_team_id,
    receivingTeamId: invalidCapTrade.receiving_team_id,
    expectedVersion: invalidCapTrade.version,
    actorUserId: fixtureId(`account:${alias === "leagueA"
      ? "leagueACommissioner"
      : "leagueBCommissioner"}`),
    actorMembershipId: fixtureId(`membership:${alias}:${alias === "leagueA"
      ? "leagueACommissioner"
      : "leagueBCommissioner"}`),
    actorAuthority: "commissioner",
    occurredAtMs: FIXTURE_NOW_MS + 60_000,
    effectiveDeadlineAtMs: invalidCapTrade.effective_deadline_at_ms,
  });
  const receivingTeam = invalidCapPreview.teams.find(
    ({ teamId }) => teamId === invalidCapTrade.receiving_team_id
  );
  assertEqual(
    invalidCapPreview.generallyIllegal,
    true,
    `${alias} invalid-cap real preflight result`
  );
  assertEqual(
    receivingTeam?.issues.some(({ code }) => code === "SALARY_CAP_EXCEEDED"),
    true,
    `${alias} invalid-cap salary issue`
  );
  assertEqual(
    receivingTeam?.cap.usageCents > receivingTeam?.cap.salaryCapCents,
    true,
    `${alias} invalid-cap projected usage`
  );
}

function verifyAccounts(database) {
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM users"), 9, "account count");
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM user_credentials"), 9, "credential count");
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM platform_roles WHERE status='active'"), 1, "active platform role count");

  const expectedStatuses = {
    platformAdmin: "active",
    leagueACommissioner: "active",
    leagueBCommissioner: "active",
    leagueAManagerOne: "active",
    leagueAManagerTwo: "active",
    leagueBManagerOne: "active",
    verifiedWithoutMembership: "active",
    pendingVerification: "pending_verification",
    deactivated: "deactivated",
  };
  for (const alias of ACCOUNT_ALIASES) {
    const row = database.prepare("SELECT status FROM users WHERE id=?").get(
      fixtureId(`account:${alias}`)
    );
    assertEqual(row?.status, expectedStatuses[alias], `${alias} status`);
  }
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM league_memberships WHERE user_id=?",
      fixtureId("account:verifiedWithoutMembership")
    ),
    0,
    "verified account membership isolation"
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM league_memberships
       WHERE user_id=? AND permission_category='member' AND status='active'`,
      fixtureId("account:platformAdmin")
    ),
    2,
    "platform administrator explicit membership coverage"
  );
  return Object.freeze({
    aliases: ACCOUNT_ALIASES,
    statusCounts: Object.freeze({
      active: 7,
      pendingVerification: 1,
      deactivated: 1,
    }),
  });
}

function verifyLeague(database, alias, playerIds) {
  const leagueId = fixtureId(`league:${alias}`);
  const expectedMembershipCount = alias === "leagueA" ? 4 : 3;
  const row = database.prepare(`
    SELECT l.status, l.timezone,
      s.salary_cap_cents AS salaryCapCents,
      s.maximum_bench_aav_cents AS maximumBenchAavCents,
      s.maximum_teams AS maximumTeams
    FROM leagues l
    JOIN league_settings s ON s.league_id=l.id
    WHERE l.id=?
  `).get(leagueId);
  assertEqual(row?.status, "active", `${alias} status`);
  assertEqual(row?.timezone, "America/Vancouver", `${alias} timezone`);
  assertEqual(row?.salaryCapCents, 10_000, `${alias} salary cap`);
  assertEqual(row?.maximumBenchAavCents, 400, `${alias} bench AAV limit`);
  assertEqual(row?.maximumTeams, 6, `${alias} maximum teams`);

  const teamNames = database.prepare(
    "SELECT name FROM teams WHERE league_id=? ORDER BY name"
  ).all(leagueId).map(({ name }) => name);
  assertEqual(teamNames.length, 6, `${alias} team count`);
  assertEqual(
    JSON.stringify(teamNames),
    JSON.stringify([...TEAM_NAMES_BY_LEAGUE[alias]].sort()),
    `${alias} team names`
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM teams
       WHERE league_id=?
         AND (
           primary_colour <> lower(primary_colour)
           OR secondary_colour <> lower(secondary_colour)
         )`,
      leagueId
    ),
    0,
    `${alias} canonical lowercase team-colour count`
  );
  assertEqual(
    count(database, "SELECT COUNT(*) AS count FROM league_memberships WHERE league_id=?", leagueId),
    expectedMembershipCount,
    `${alias} membership count`
  );
  const commissionerAlias =
    alias === "leagueA" ? "leagueACommissioner" : "leagueBCommissioner";
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM team_manager_assignments
       WHERE league_id=? AND user_id=? AND status='accepted'
         AND ended_at_ms IS NULL`,
      leagueId,
      fixtureId(`account:${commissionerAlias}`)
    ),
    0,
    `${alias} commissioner has no implicit team assignment`
  );
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM seasons WHERE league_id=?", leagueId), 4, `${alias} season count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM draft_picks WHERE league_id=? AND status='unused'", leagueId), 96, `${alias} four-season draft-pick count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM league_player_positions WHERE league_id=?", leagueId), 26, `${alias} player-position count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM player_ownerships WHERE league_id=?", leagueId), 23, `${alias} ownership count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM contracts WHERE league_id=?", leagueId), 23, `${alias} contract count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM contracts WHERE league_id=? AND status='active'", leagueId), 22, `${alias} active contract count`);
  assertEqual(count(database, "SELECT COUNT(DISTINCT original_term_years) AS count FROM contracts WHERE league_id=? AND status='active'", leagueId), 3, `${alias} contract term coverage`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM retention_obligations WHERE league_id=? AND status='active'", leagueId), 1, `${alias} retention count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM buyout_obligations WHERE league_id=? AND status='active'", leagueId), 1, `${alias} buyout count`);

  const categories = Object.fromEntries(database.prepare(`
    SELECT roster_category AS category, COUNT(*) AS count
    FROM player_ownerships WHERE league_id=? GROUP BY roster_category
  `).all(leagueId).map(({ category, count: categoryCount }) => [category, categoryCount]));
  assertEqual(categories.Active, 18, `${alias} active roster count`);
  assertEqual(categories.Bench, 2, `${alias} bench count`);
  assertEqual(categories["Injured Reserve"], 1, `${alias} injured-reserve count`);
  assertEqual(categories.Prospect, 2, `${alias} prospect count`);
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM player_ownerships o
      JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id
      WHERE o.league_id=? AND o.roster_category='Bench'
        AND c.status='active' AND c.aav_cents <= 400
    `, leagueId),
    2,
    `${alias} bench contract limit coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count FROM player_ownerships o
      WHERE o.league_id=? AND o.player_id=? AND o.roster_category='Prospect'
        AND NOT EXISTS (
          SELECT 1 FROM contracts c
          WHERE c.league_id=o.league_id AND c.player_id=o.player_id
        )
    `, leagueId, playerIds.unsignedProspect),
    1,
    `${alias} unsigned prospect coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count FROM player_ownerships o
      JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id
      WHERE o.league_id=? AND o.player_id=? AND o.roster_category='Prospect'
        AND c.contract_type='fantasy_elc' AND c.status='active'
        AND c.original_total_value_cents=300
        AND c.original_term_years=3
        AND c.aav_cents=100
        AND (
          SELECT COUNT(*) FROM contract_years cy
          WHERE cy.league_id=c.league_id AND cy.contract_id=c.id
            AND cy.aav_cents=100
            AND cy.year_number BETWEEN 1 AND 3
        )=3
    `, leagueId, playerIds.signedProspect),
    1,
    `${alias} signed prospect coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(DISTINCT team_id) AS count
      FROM player_ownerships
      WHERE league_id=?
    `, leagueId),
    6,
    `${alias} populated-roster team coverage`
  );
  for (const playerAlias of ["freeAgentForward", "freeAgentDefence"]) {
    assertEqual(
      count(database, "SELECT COUNT(*) AS count FROM player_ownerships WHERE league_id=? AND player_id=?", leagueId, playerIds[playerAlias]),
      0,
      `${alias} ${playerAlias} remains free`
    );
  }

  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auctions WHERE league_id=? AND status='open'", leagueId), 1, `${alias} open auction count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auction_bids WHERE league_id=? AND status='active'", leagueId), 1, `${alias} own-bid scenario count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='proposed'", leagueId), 3, `${alias} pending trade count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='completed'", leagueId), 1, `${alias} completed trade count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='accepted'", leagueId), 0, `${alias} legacy accepted storage count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='declined'", leagueId), 1, `${alias} declined trade count`);
  verifyTradeScenarios(database, alias, leagueId, playerIds);
  assertEqual(count(database, `
    SELECT COUNT(*) AS count
    FROM trade_assets
    WHERE league_id=? AND contract_id=?
  `, leagueId, fixtureId(`contract:${alias}:activeForward2`)), 2, `${alias} simultaneous shared-asset coverage`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_weeks WHERE league_id=?", leagueId), 22, `${alias} matchup-week count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='live'", leagueId), 3, `${alias} live matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='final'", leagueId), 3, `${alias} final matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='scheduled'", leagueId), 60, `${alias} scheduled matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_results WHERE league_id=? AND status='official'", leagueId), 1, `${alias} official result count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM player_stat_totals WHERE refresh_id=?", fixtureId(`stat-refresh:${alias}`)), PLAYER_BLUEPRINTS.length, `${alias} synthetic player-stat total count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM stat_snapshots WHERE league_id=?", leagueId), 12, `${alias} matchup snapshot count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_roster_locks WHERE league_id=?", leagueId), 12, `${alias} matchup lock count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_roster_players WHERE league_id=?", leagueId), 36, `${alias} locked-player row count`);
  const syntheticRefresh = database.prepare(`
    SELECT stat_sources.provider, stat_refreshes.metadata_json
    FROM stat_refreshes
    JOIN stat_sources ON stat_sources.id=stat_refreshes.stat_source_id
    WHERE stat_refreshes.id=?
  `).get(fixtureId(`stat-refresh:${alias}`));
  assertEqual(syntheticRefresh?.provider, "release_qa_fixture", `${alias} synthetic statistics provider`);
  let metadata;
  try {
    metadata = JSON.parse(syntheticRefresh?.metadata_json || "");
  } catch {
    fail("RELEASE_QA_FIXTURE_MISMATCH", `Release-QA fixture mismatch: ${alias} synthetic statistics metadata.`);
  }
  assertEqual(metadata?.sourceKind, "synthetic_release_qa", `${alias} synthetic statistics label`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM standings_rows WHERE league_id=?", leagueId), 6, `${alias} standings row count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM league_activity WHERE league_id=?", leagueId), 8, `${alias} activity count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM notifications WHERE league_id=?", leagueId), 1, `${alias} notification count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM outbox_events WHERE league_id=? AND event_type='release_qa.email_captured' AND status='published'", leagueId), 1, `${alias} captured-email envelope count`);

  const activeContractAavCents = database.prepare(
    "SELECT SUM(aav_cents) AS total FROM contracts WHERE league_id=? AND status='active'"
  ).get(leagueId).total;
  return Object.freeze({
    alias,
    activeContractAavCents,
    maximumBenchAavCents: 400,
    salaryCapCents: 10_000,
    counts: Object.freeze({
      activity: 8,
      activeContracts: 22,
      activeRoster: 18,
      auctions: 1,
      bench: 2,
      buyouts: 1,
      draftPicks: 96,
      injuredReserve: 1,
      memberships: expectedMembershipCount,
      notifications: 1,
      ownerships: 23,
      prospects: 2,
      retentions: 1,
      standingsRows: 6,
      statSnapshots: 12,
      syntheticPlayerTotals: PLAYER_BLUEPRINTS.length,
      matchupLocks: 12,
      matchupPlayers: 36,
      teams: 6,
      populatedRosterTeams: 6,
      trades: 5,
    }),
  });
}

function verifyReleaseQaFixture({ databasePath } = {}) {
  if (!path.isAbsolute(databasePath || "")) {
    fail(
      "RELEASE_QA_DATABASE_PATH_REQUIRED",
      "An absolute release-QA database path is required."
    );
  }
  const database = openReadonlyDatabase({ databasePath });
  try {
    assertEqual(database.pragma("integrity_check", { simple: true }), "ok", "SQLite integrity");
    assertEqual(database.pragma("foreign_key_check").length, 0, "foreign-key violation count");
    assertEqual(database.pragma("user_version", { simple: true }), 19, "schema version");

    const metadata = Object.fromEntries(database.prepare(`
      SELECT metadata_key, metadata_value FROM application_metadata
      WHERE metadata_key IN ('database_created_at', 'database_id', 'environment_id')
    `).all().map(({ metadata_key: key, metadata_value: value }) => [key, value]));
    assertEqual(metadata.database_created_at, FIXTURE_CREATED_AT, "database created-at identity");
    assertEqual(metadata.database_id, FIXTURE_DATABASE_ID, "database identity");
    assertEqual(metadata.environment_id, FIXTURE_ENVIRONMENT_ID, "environment identity");

    assertEqual(count(database, "SELECT COUNT(*) AS count FROM leagues"), 2, "league count");
    const playerIds = resolveFixturePlayerIds(database);
    assertEqual(
      count(database, "SELECT COUNT(*) AS count FROM players") >=
        PLAYER_BLUEPRINTS.length,
      true,
      "minimum global player count"
    );
    const accounts = verifyAccounts(database);
    const leagues = LEAGUE_ALIASES.map((alias) =>
      verifyLeague(database, alias, playerIds)
    );
    const overlappingPlayers = count(database, `
      SELECT COUNT(*) AS count FROM (
        SELECT player_id FROM league_player_positions
        GROUP BY player_id HAVING COUNT(DISTINCT league_id)=2
      )
    `);
    assertEqual(overlappingPlayers, PLAYER_BLUEPRINTS.length, "overlapping global player identity count");
    const overlappingTeamNames = count(database, `
      SELECT COUNT(*) AS count FROM (
        SELECT name_normalized FROM teams
        GROUP BY name_normalized HAVING COUNT(DISTINCT league_id)=2
      )
    `);
    assertEqual(overlappingTeamNames, 0, "overlapping team-name count");
    assertEqual(
      count(database, `
        SELECT COUNT(*) AS count
        FROM player_ownerships a
        JOIN player_ownerships b ON b.player_id=a.player_id
        WHERE a.league_id=? AND b.league_id=? AND a.id=b.id
      `, fixtureId("league:leagueA"), fixtureId("league:leagueB")),
      0,
      "league-scoped ownership identity separation"
    );
    for (
      const [playerAlias, betaTeamNumber]
      of Object.entries(BETA_PLAYER_TEAM_NUMBERS)
    ) {
      const alphaTeamNumber =
        PLAYER_BLUEPRINTS.findIndex(
          (blueprint) => blueprint.alias === playerAlias
        ) % TEAM_NAMES_BY_LEAGUE.leagueA.length + 1;
      assertEqual(
        database.prepare(`
          SELECT team_id AS teamId
          FROM player_ownerships
          WHERE league_id=? AND player_id=?
        `).get(
          fixtureId("league:leagueA"),
          playerIds[playerAlias]
        )?.teamId,
        fixtureId(`team:leagueA:${alphaTeamNumber}`),
        `leagueA ${playerAlias} deliberate roster assignment`
      );
      assertEqual(
        database.prepare(`
          SELECT team_id AS teamId
          FROM player_ownerships
          WHERE league_id=? AND player_id=?
        `).get(
          fixtureId("league:leagueB"),
          playerIds[playerAlias]
        )?.teamId,
        fixtureId(`team:leagueB:${betaTeamNumber}`),
        `leagueB ${playerAlias} deliberate roster assignment`
      );
      assertEqual(
        alphaTeamNumber === betaTeamNumber,
        false,
        `${playerAlias} must differ across Alpha and Beta rosters`
      );
    }

    const manifestWithoutChecksum = Object.freeze({
      manifestVersion: FIXTURE_VERSION,
      fixtureBuildId: FIXTURE_BUILD_ID,
      fixtureCreatedAt: FIXTURE_CREATED_AT,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      schemaVersion: 19,
      accounts,
      leagues: Object.freeze(leagues),
      global: Object.freeze({
        leagueCount: 2,
        overlappingPlayerCount: overlappingPlayers,
        overlappingTeamNameCount: overlappingTeamNames,
        playerCount: PLAYER_BLUEPRINTS.length,
      }),
      scenarios: Object.freeze({
        capturedEmailEnvelope: true,
        finalizedPriorResult: true,
        matchupPlayerStatistics: true,
        openAuctionWithOwnBid: true,
        distinctLeagueRosters: true,
        distinctLeagueTeamNames: true,
        simultaneousTradesForOneAsset: true,
        twoLeagueIdentityIsolation: true,
      }),
      integrity: Object.freeze({
        foreignKeyViolationCount: 0,
        sqliteIntegrity: "ok",
      }),
    });
    return Object.freeze({
      ...manifestWithoutChecksum,
      manifestChecksum: checksumManifest(manifestWithoutChecksum),
    });
  } finally {
    database.close();
  }
}

module.exports = {
  ReleaseQaFixtureVerificationError,
  verifyReleaseQaFixture,
};
