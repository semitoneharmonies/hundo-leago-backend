const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const express = require("express");

const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  createLeaguePlayerReadService,
} = require(
  "../../src/application/services/players/createLeaguePlayerReadService"
);
const {
  createPlayerReadService,
} = require(
  "../../src/application/services/players/createPlayerReadService"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteLeaguePlayerReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeaguePlayerReadRepository"
);
const {
  createSqlitePlayerRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository"
);
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createPlayerRouter,
} = require("../../src/transport/http/createPlayerRouter");
const {
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT, "database", "migrations");
const NOW_MS = Date.parse("2026-07-25T12:00:00.000Z");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const USER_A_ID = uuid(1);
const USER_B_ID = uuid(2);
const LEAGUE_A_ID = uuid(10);
const LEAGUE_B_ID = uuid(20);
const TEAM_A_ID = uuid(11);
const TEAM_B_ID = uuid(21);
const PLAYER_ONE_ID = uuid(100);
const PLAYER_TWO_ID = uuid(101);
const SESSION_A = Buffer.alloc(32, 0x61).toString("base64url");
const SESSION_B = Buffer.alloc(32, 0x62).toString("base64url");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function authenticated(userId) {
  return Object.freeze({
    valid: true,
    user: Object.freeze({ id: userId }),
    session: Object.freeze({ userId }),
  });
}

function insertUser(repositories, id, alias) {
  repositories.users.insert({
    id,
    email_normalized: `${alias}@example.test`,
    email_display: `${alias}@example.test`,
    display_name: alias,
    display_name_normalized: alias,
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
}

function insertLeagueScope(repositories, database, {
  alias,
  leagueId,
  teamId,
  userId,
  baseId,
}) {
  const priorSeasonId = uuid(baseId + 1);
  const currentSeasonId = uuid(baseId + 2);
  const futureSeasonId = uuid(baseId + 3);
  repositories.leagues.insert({
    id: leagueId,
    name: `${alias} League`,
    name_normalized: `${alias.toLowerCase()} league`,
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  for (const [seasonId, label, status, offset] of [
    [priorSeasonId, "2025-26", "completed", -1],
    [currentSeasonId, "2026-27", "active", 0],
    [futureSeasonId, "2027-28", "planned", 1],
  ]) {
    repositories.seasons.insert({
      id: seasonId,
      league_id: leagueId,
      label,
      nhl_season_key: String(20252026 + (offset + 1) * 10001),
      status,
      regular_season_starts_at_ms: NOW_MS + offset * 1_000_000,
      regular_season_ends_at_ms: NOW_MS + (offset + 1) * 1_000_000,
      fantasy_playoffs_start_at_ms:
        NOW_MS + (offset + 1) * 1_000_000 - 100_000,
      fantasy_playoffs_end_at_ms:
        NOW_MS + (offset + 1) * 1_000_000,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
      free_agent_draft_completed_at_ms: null,
    });
  }
  database.prepare(`
    UPDATE leagues
    SET current_season_id=?, updated_at_ms=?, version=version+1
    WHERE id=?
  `).run(currentSeasonId, NOW_MS, leagueId);
  repositories.teams.insert({
    id: teamId,
    league_id: leagueId,
    name: `${alias} Team`,
    name_normalized: `${alias.toLowerCase()} team`,
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: uuid(baseId + 4),
    league_id: leagueId,
    user_id: userId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  return Object.freeze({
    priorSeasonId,
    currentSeasonId,
    futureSeasonId,
  });
}

function insertPlayer(playerRepository, id, name, externalIdValue) {
  const [firstName, ...lastName] = name.split(" ");
  playerRepository.create({
    player: {
      id,
      firstName,
      lastName: lastName.join(" "),
      fullName: name,
      birthDate: "1998-02-03",
      status: "active",
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    },
    externalId: {
      id: uuid(500 + Number(externalIdValue)),
      playerId: id,
      provider: "nhl",
      externalValue: externalIdValue,
      createdAtMs: NOW_MS,
    },
  });
}

function insertLeaguePlayerState(repositories, {
  leagueId,
  teamId,
  seasons,
  ownershipId,
  contractId,
  contractYearBaseId,
  category,
  ownershipKind,
  totalValueCents,
  termYears,
  aavCents,
  yearStatuses,
}) {
  repositories.player_ownerships.insert({
    id: ownershipId,
    league_id: leagueId,
    season_id: seasons.currentSeasonId,
    player_id: PLAYER_ONE_ID,
    team_id: teamId,
    ownership_kind: ownershipKind,
    roster_category: category,
    position_group: "F",
    slot_number: category === "Prospect" ? null : 1,
    acquired_transaction_type: "test",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.contracts.insert({
    id: contractId,
    league_id: leagueId,
    player_id: PLAYER_ONE_ID,
    current_team_id: teamId,
    contract_type: "normal",
    original_total_value_cents: totalValueCents,
    original_term_years: termYears,
    aav_cents: aavCents,
    start_season_id: seasons.priorSeasonId,
    status: "active",
    acquisition_source_type: "test",
    acquisition_source_id: null,
    auction_buyout_lock_expires_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const seasonIds = [
    seasons.priorSeasonId,
    seasons.currentSeasonId,
    seasons.futureSeasonId,
  ];
  yearStatuses.forEach((status, index) => {
    repositories.contract_years.insert({
      id: uuid(contractYearBaseId + index),
      league_id: leagueId,
      contract_id: contractId,
      season_id: seasonIds[index],
      year_number: index + 1,
      aav_cents: aavCents,
      status,
      rollover_at_ms: status === "completed" ? NOW_MS : null,
      created_at_ms: NOW_MS,
    });
  });
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-league-player-read-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league-player.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "league-player-read-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  insertUser(context.repositories, USER_A_ID, "reader-a");
  insertUser(context.repositories, USER_B_ID, "reader-b");
  const seasonsA = insertLeagueScope(
    context.repositories,
    connection.database,
    {
      alias: "Alpha",
      leagueId: LEAGUE_A_ID,
      teamId: TEAM_A_ID,
      userId: USER_A_ID,
      baseId: 1000,
    }
  );
  const seasonsB = insertLeagueScope(
    context.repositories,
    connection.database,
    {
      alias: "Beta",
      leagueId: LEAGUE_B_ID,
      teamId: TEAM_B_ID,
      userId: USER_B_ID,
      baseId: 2000,
    }
  );
  const playerRepository = createSqlitePlayerRepository({
    database: connection.database,
  });
  insertPlayer(playerRepository, PLAYER_ONE_ID, "Alex League", "1");
  insertPlayer(playerRepository, PLAYER_TWO_ID, "Blair Free", "2");
  connection.database.prepare(`
    INSERT INTO player_source_state (
      id, player_id, provider, source_position, normalized_position,
      nhl_team_abbreviation, active, source_version, source_payload_json,
      effective_at_ms, ended_at_ms, created_at_ms
    ) VALUES (?, ?, 'sportsdataio-discovery-lab', 'C', 'F', 'VAN', 1,
      '2025-last-season', NULL, ?, NULL, ?)
  `).run(uuid(600), PLAYER_ONE_ID, NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO player_source_state (
      id, player_id, provider, source_position, normalized_position,
      nhl_team_abbreviation, active, source_version, source_payload_json,
      effective_at_ms, ended_at_ms, created_at_ms
    ) VALUES (?, ?, 'sportsdataio-discovery-lab', 'D', 'D', 'EDM', 1,
      '2025-last-season', NULL, ?, NULL, ?)
  `).run(uuid(604), PLAYER_TWO_ID, NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_sources (
      id, provider, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, 'sportsdataio-discovery-lab', 'active', ?, ?, 1)
  `).run(uuid(601), NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status,
      started_at_ms, completed_at_ms, player_count, error_code,
      metadata_json, version
    ) VALUES (?, ?, '20252026', '2025-last-season', 'succeeded',
      ?, ?, 1, NULL, NULL, 1)
  `).run(uuid(602), uuid(601), NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id,
      games_played, goals, assists, nhl_points,
      fantasy_points_hundredths, source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20252026', ?, 82, 30, 45, 75, 8250, ?, ?)
  `).run(
    uuid(603),
    uuid(601),
    uuid(602),
    PLAYER_ONE_ID,
    NOW_MS,
    NOW_MS
  );
  connection.database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id,
      games_played, goals, assists, nhl_points,
      fantasy_points_hundredths, source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20252026', ?, 40, 10, 20, 30, 4000, ?, ?)
  `).run(
    uuid(605),
    uuid(601),
    uuid(602),
    PLAYER_TWO_ID,
    NOW_MS,
    NOW_MS
  );
  insertLeaguePlayerState(context.repositories, {
    leagueId: LEAGUE_A_ID,
    teamId: TEAM_A_ID,
    seasons: seasonsA,
    ownershipId: uuid(700),
    contractId: uuid(701),
    contractYearBaseId: 710,
    category: "Active",
    ownershipKind: "Rostered",
    totalValueCents: 900,
    termYears: 3,
    aavCents: 300,
    yearStatuses: ["completed", "current", "future"],
  });
  insertLeaguePlayerState(context.repositories, {
    leagueId: LEAGUE_B_ID,
    teamId: TEAM_B_ID,
    seasons: seasonsB,
    ownershipId: uuid(800),
    contractId: uuid(801),
    contractYearBaseId: 810,
    category: "Bench",
    ownershipKind: "Rostered",
    totalValueCents: 800,
    termYears: 2,
    aavCents: 400,
    yearStatuses: ["completed", "current"],
  });

  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({
      database: connection.database,
    }),
    leagueAccessRepository: createSqliteLeagueAccessRepository({
      database: connection.database,
    }),
  });
  const leaguePlayerRepository = createSqliteLeaguePlayerReadRepository({
    database: connection.database,
  });
  const globalService = createPlayerReadService({
    activeUserAuthorization: leagueAuthorization,
    repository: playerRepository,
  });
  const service = createLeaguePlayerReadService({
    leagueAuthorization,
    playerRepository,
    leaguePlayerRepository,
  });
  return Object.freeze({
    database: connection.database,
    globalService,
    leaguePlayerRepository,
    service,
  });
}

async function startApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "local",
    publicFrontendOrigin: FRONTEND_ORIGIN,
    sameSite: "lax",
  });
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "league-player-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(token) {
        if (token === SESSION_A) return authenticated(USER_A_ID);
        if (token === SESSION_B) return authenticated(USER_B_ID);
        return { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf() {
        return { valid: false, code: "SESSION_INVALID" };
      },
    },
  });
  const app = express();
  app.use(createPlayerRouter({
    requestSecurity,
    playerReadService: runtime.globalService,
    leaguePlayerReadService: runtime.service,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    cookieName: sessionCookie.name,
  });
}

function headers(api, sessionToken) {
  return {
    Origin: FRONTEND_ORIGIN,
    ...(sessionToken
      ? { Cookie: `${api.cookieName}=${sessionToken}` }
      : {}),
  };
}

describe("league-scoped player read repository", () => {
  test("returns only the requested league ownership and active-contract summary", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const alpha = runtime.leaguePlayerRepository.findByPlayerId({
      leagueId: LEAGUE_A_ID,
      playerId: PLAYER_ONE_ID,
    });
    const beta = runtime.leaguePlayerRepository.findByPlayerId({
      leagueId: LEAGUE_B_ID,
      playerId: PLAYER_ONE_ID,
    });
    assert.equal(alpha.team_name, "Alpha Team");
    assert.equal(alpha.roster_category, "Active");
    assert.equal(alpha.original_total_value_cents, 900);
    assert.equal(alpha.original_term_years, 3);
    assert.equal(alpha.aav_cents, 300);
    assert.equal(alpha.remaining_years, 2);
    assert.equal(beta.team_name, "Beta Team");
    assert.equal(beta.roster_category, "Bench");
    assert.equal(beta.original_total_value_cents, 800);
    assert.equal(beta.original_term_years, 2);
    assert.equal(beta.aav_cents, 400);
    assert.equal(beta.remaining_years, 1);
    const free = runtime.leaguePlayerRepository.listByPlayerIds({
      leagueId: LEAGUE_A_ID,
      playerIds: [PLAYER_TWO_ID],
    });
    assert.equal(free[0].ownership_id, null);
    assert.equal(free[0].contract_id, null);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });
});

describe("league-scoped player read service", () => {
  test("reuses global identity/statistics while isolating league state and remaining years", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const alpha = runtime.service.read({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      playerId: PLAYER_ONE_ID,
    });
    assert.equal(alpha.fullName, "Alex League");
    assert.equal(alpha.statistics.provider, "sportsdataio-discovery-lab");
    assert.deepEqual(alpha.league, {
      id: LEAGUE_A_ID,
      ownership: {
        kind: "Rostered",
        category: "Active",
        team: { id: TEAM_A_ID, name: "Alpha Team" },
      },
      activeContract: {
        originalTotalValueCents: 900,
        originalTermYears: 3,
        aavCents: 300,
        remainingYears: 2,
      },
    });
    const beta = runtime.service.read({
      authenticated: authenticated(USER_B_ID),
      leagueId: LEAGUE_B_ID,
      playerId: PLAYER_ONE_ID,
    });
    assert.equal(beta.league.ownership.team.id, TEAM_B_ID);
    assert.equal(beta.league.ownership.category, "Bench");
    assert.equal(
      beta.league.activeContract.originalTotalValueCents,
      800
    );
    assert.equal(JSON.stringify(alpha).includes("Beta Team"), false);
    assert.equal(JSON.stringify(beta).includes("Alpha Team"), false);
    assert.throws(
      () => runtime.service.read({
        authenticated: authenticated(USER_A_ID),
        leagueId: LEAGUE_B_ID,
        playerId: PLAYER_ONE_ID,
      }),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("paginates the global catalog and annotates unowned players without writing", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const first = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      limit: 1,
    });
    assert.equal(first.players[0].id, PLAYER_ONE_ID);
    assert.equal(first.players[0].league.ownership.team.id, TEAM_A_ID);
    assert.equal(first.page.hasMore, true);
    const second = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      limit: 1,
      cursor: first.page.nextCursor,
    });
    assert.equal(second.players[0].id, PLAYER_TWO_ID);
    assert.equal(second.players[0].league.ownership, null);
    assert.equal(second.players[0].league.activeContract, null);
    assert.equal(second.page.hasMore, false);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("filters current-season ownership before pagination", (t) => {
    const runtime = createRuntime(t);
    const result = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      teamId: TEAM_A_ID,
      limit: 1,
    });

    assert.deepEqual(
      result.players.map(({ id }) => id),
      [PLAYER_ONE_ID]
    );
    assert.equal(result.players[0].league.ownership.team.id, TEAM_A_ID);
    assert.equal(result.page.hasMore, false);
  });

  test("applies catalog filters before the page limit without writing", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const result = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      position: "D",
      nhlTeam: "EDM",
      ownership: "free",
      minimumGames: 25,
      limit: 1,
      sort: "fantasyPoints",
    });

    assert.deepEqual(
      result.players.map(({ id }) => id),
      [PLAYER_TWO_ID]
    );
    assert.equal(result.players[0].provider.nhlTeamAbbreviation, "EDM");
    assert.equal(result.players[0].statistics.gamesPlayed, 40);
    assert.equal(result.players[0].league.ownership, null);
    assert.equal(result.page.hasMore, false);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("orders cursor pages by fantasy points when requested", (t) => {
    const runtime = createRuntime(t);
    runtime.database.prepare(`
      UPDATE player_stat_totals
      SET games_played = 82,
          goals = 40,
          assists = 50,
          nhl_points = 90,
          fantasy_points_hundredths = 12000
      WHERE refresh_id = ? AND player_id = ?
    `).run(uuid(602), PLAYER_TWO_ID);
    const before = runtime.database.serialize();
    const first = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      limit: 1,
      sort: "fantasyPoints",
    });
    assert.equal(first.players[0].id, PLAYER_TWO_ID);
    assert.equal(first.page.hasMore, true);

    const second = runtime.service.list({
      authenticated: authenticated(USER_A_ID),
      leagueId: LEAGUE_A_ID,
      limit: 1,
      cursor: first.page.nextCursor,
      sort: "fantasyPoints",
    });
    assert.equal(second.players[0].id, PLAYER_ONE_ID);
    assert.equal(second.page.hasMore, false);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("rejects unsupported league-player sort modes", (t) => {
    const runtime = createRuntime(t);
    assert.throws(
      () =>
        runtime.service.list({
          authenticated: authenticated(USER_A_ID),
          leagueId: LEAGUE_A_ID,
          sort: "salary",
        }),
      (error) => error?.code === "PLAYER_READ_INPUT_INVALID"
    );
  });
});

describe("league-scoped player HTTP routes", () => {
  test("requires a session and current membership without cross-league disclosure or writes", async (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const api = await startApi(t, runtime);
    const list = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players?limit=1`,
      { headers: headers(api, SESSION_A) }
    );
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listBody.data[0].league.id, LEAGUE_A_ID);
    assert.equal(listBody.page.hasMore, true);
    assert.equal(listBody.meta.requestId, "league-player-request");

    const sortedList = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players?limit=1&sort=fantasyPoints`,
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(sortedList.status, 200);
    assert.equal((await sortedList.json()).data[0].id, PLAYER_ONE_ID);

    const filteredList = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players?` +
        "limit=1&sort=fantasyPoints&position=D&nhlTeam=EDM&" +
        "ownership=free&minimumGames=25",
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(filteredList.status, 200);
    const filteredBody = await filteredList.json();
    assert.deepEqual(
      filteredBody.data.map(({ id }) => id),
      [PLAYER_TWO_ID]
    );
    assert.equal(filteredBody.page.hasMore, false);

    const invalidSort = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players?sort=salary`,
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(invalidSort.status, 400);
    assert.equal(
      (await invalidSort.json()).error.code,
      "PLAYER_READ_INPUT_INVALID"
    );

    const detail = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players/${PLAYER_ONE_ID}`,
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(detail.status, 200);
    assert.equal(
      (await detail.json()).data.league.activeContract.remainingYears,
      2
    );

    const crossLeague = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_B_ID}/players/${PLAYER_ONE_ID}`,
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(crossLeague.status, 404);
    assert.equal(
      (await crossLeague.json()).error.code,
      "LEAGUE_NOT_FOUND"
    );

    const signedOut = await fetch(
      `${api.baseUrl}/api/v1/leagues/${LEAGUE_A_ID}/players`,
      { headers: headers(api) }
    );
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");

    const invalidLeague = await fetch(
      `${api.baseUrl}/api/v1/leagues/not-a-league/players`,
      { headers: headers(api, SESSION_A) }
    );
    assert.equal(invalidLeague.status, 400);
    assert.equal(
      (await invalidLeague.json()).error.code,
      "LEAGUE_ID_INVALID"
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });
});
