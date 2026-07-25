const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../../infrastructure/database/connection");
const {
  ACCOUNT_ALIASES,
  FIXTURE_BUILD_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_VERSION,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  TEAM_NAMES,
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

function verifyLeague(database, alias) {
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
    JSON.stringify([...TEAM_NAMES].sort()),
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
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM seasons WHERE league_id=?", leagueId), 3, `${alias} season count`);
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
    `, leagueId, fixtureId("player:unsignedProspect")),
    1,
    `${alias} unsigned prospect coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count FROM player_ownerships o
      JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id
      WHERE o.league_id=? AND o.player_id=? AND o.roster_category='Prospect'
        AND c.contract_type='fantasy_elc' AND c.status='active'
    `, leagueId, fixtureId("player:signedProspect")),
    1,
    `${alias} signed prospect coverage`
  );
  for (const playerAlias of ["freeAgentForward", "freeAgentDefence"]) {
    assertEqual(
      count(database, "SELECT COUNT(*) AS count FROM player_ownerships WHERE league_id=? AND player_id=?", leagueId, fixtureId(`player:${playerAlias}`)),
      0,
      `${alias} ${playerAlias} remains free`
    );
  }

  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auctions WHERE league_id=? AND status='open'", leagueId), 1, `${alias} open auction count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auction_bids WHERE league_id=? AND status='active'", leagueId), 1, `${alias} own-bid scenario count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='proposed'", leagueId), 2, `${alias} simultaneous trade count`);
  assertEqual(count(database, `
    SELECT COUNT(DISTINCT contract_id) AS count
    FROM trade_assets WHERE league_id=? AND asset_type='contract'
  `, leagueId), 1, `${alias} simultaneous shared-asset coverage`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_weeks WHERE league_id=?", leagueId), 2, `${alias} matchup-week count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='live'", leagueId), 3, `${alias} live matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='final'", leagueId), 3, `${alias} final matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_results WHERE league_id=? AND status='official'", leagueId), 1, `${alias} official result count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM standings_rows WHERE league_id=?", leagueId), 6, `${alias} standings row count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM league_activity WHERE league_id=?", leagueId), 1, `${alias} activity count`);
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
      activity: 1,
      activeContracts: 22,
      activeRoster: 18,
      auctions: 1,
      bench: 2,
      buyouts: 1,
      injuredReserve: 1,
      memberships: expectedMembershipCount,
      notifications: 1,
      ownerships: 23,
      prospects: 2,
      retentions: 1,
      standingsRows: 6,
      teams: 6,
      trades: 2,
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
    assertEqual(database.pragma("user_version", { simple: true }), 18, "schema version");

    const metadata = Object.fromEntries(database.prepare(`
      SELECT metadata_key, metadata_value FROM application_metadata
      WHERE metadata_key IN ('database_created_at', 'database_id', 'environment_id')
    `).all().map(({ metadata_key: key, metadata_value: value }) => [key, value]));
    assertEqual(metadata.database_created_at, FIXTURE_CREATED_AT, "database created-at identity");
    assertEqual(metadata.database_id, FIXTURE_DATABASE_ID, "database identity");
    assertEqual(metadata.environment_id, FIXTURE_ENVIRONMENT_ID, "environment identity");

    assertEqual(count(database, "SELECT COUNT(*) AS count FROM leagues"), 2, "league count");
    assertEqual(count(database, "SELECT COUNT(*) AS count FROM players"), PLAYER_BLUEPRINTS.length, "global player count");
    const accounts = verifyAccounts(database);
    const leagues = LEAGUE_ALIASES.map((alias) => verifyLeague(database, alias));
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
    assertEqual(overlappingTeamNames, TEAM_NAMES.length, "overlapping team-name count");
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

    const manifestWithoutChecksum = Object.freeze({
      manifestVersion: FIXTURE_VERSION,
      fixtureBuildId: FIXTURE_BUILD_ID,
      fixtureCreatedAt: FIXTURE_CREATED_AT,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      schemaVersion: 18,
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
        openAuctionWithOwnBid: true,
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
