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
  PlayerNotFoundError,
  PlayerReadInputError,
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

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-22T20:00:00.000Z");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const USER_ID = uuid(1);
const LEAGUE_ID = uuid(2);
const SEASON_ID = uuid(3);
const TEAM_ID = uuid(4);
const MEMBERSHIP_ID = uuid(5);
const PLAYER_ONE_ID = uuid(101);
const PLAYER_TWO_ID = uuid(102);
const PLAYER_THREE_ID = uuid(103);
const PLAYER_RIGHTS_ID = uuid(104);
const PLAYER_AUCTION_ID = uuid(105);
const SESSION_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function authenticated() {
  return Object.freeze({
    valid: true,
    session: Object.freeze({ userId: USER_ID }),
    user: Object.freeze({ id: USER_ID }),
  });
}

function player(id, fullName, status = "active") {
  const [firstName, ...lastNameParts] = fullName.split(" ");
  return {
    id,
    firstName,
    lastName: lastNameParts.join(" "),
    fullName,
    birthDate: "1997-01-02",
    status,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  };
}

function externalId(id, playerId, externalValue) {
  return {
    id,
    playerId,
    provider: "nhl",
    externalValue,
    createdAtMs: NOW_MS,
  };
}

function createRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-player-read-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "players.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "player-read-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  context.repositories.users.insert({
    id: USER_ID,
    email_normalized: "player-reader@example.test",
    email_display: "player-reader@example.test",
    display_name: "Player Reader",
    display_name_normalized: "player reader",
    status: "active",
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.leagues.insert({
    id: LEAGUE_ID,
    name: "Player Read League",
    name_normalized: "player read league",
    status: "active",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.seasons.insert({
    id: SEASON_ID,
    league_id: LEAGUE_ID,
    label: "2026-27",
    nhl_season_key: "20262027",
    status: "active",
    regular_season_starts_at_ms: NOW_MS - 1,
    regular_season_ends_at_ms: NOW_MS + 100_000,
    fantasy_playoffs_start_at_ms: NOW_MS + 50_000,
    fantasy_playoffs_end_at_ms: NOW_MS + 100_000,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
    free_agent_draft_completed_at_ms: NOW_MS - 1,
  });
  context.repositories.teams.insert({
    id: TEAM_ID,
    league_id: LEAGUE_ID,
    name: "Player Read Team",
    name_normalized: "player read team",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.league_memberships.insert({
    id: MEMBERSHIP_ID,
    league_id: LEAGUE_ID,
    user_id: USER_ID,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const repository = createSqlitePlayerRepository({
    database: connection.database,
  });
  repository.create({
    player: player(PLAYER_ONE_ID, "alex McKay"),
    externalId: externalId(uuid(201), PLAYER_ONE_ID, "1001"),
  });
  repository.create({
    player: player(PLAYER_TWO_ID, "Alex Smith"),
    externalId: externalId(uuid(202), PLAYER_TWO_ID, "1002"),
  });
  repository.create({
    player: player(PLAYER_THREE_ID, "Blair Jones", "historical"),
    externalId: externalId(uuid(203), PLAYER_THREE_ID, "1003"),
  });
  repository.create({
    player: player(PLAYER_RIGHTS_ID, "Charlie Rights"),
    externalId: externalId(uuid(204), PLAYER_RIGHTS_ID, "1004"),
  });
  repository.create({
    player: player(PLAYER_AUCTION_ID, "Drew Auction"),
    externalId: externalId(uuid(205), PLAYER_AUCTION_ID, "1005"),
  });
  const insertSource = connection.database.prepare(`
    INSERT INTO player_source_state (
      id, player_id, provider, source_position, normalized_position,
      nhl_team_abbreviation, active, source_version, source_payload_json,
      effective_at_ms, ended_at_ms, created_at_ms
    ) VALUES (?, ?, 'nhl', 'C', 'F', 'VAN', 1, '2026-07-22', NULL, ?, NULL, ?)
  `);
  for (const [sourceId, playerId] of [
    [uuid(301), PLAYER_ONE_ID],
    [uuid(302), PLAYER_TWO_ID],
    [uuid(304), PLAYER_RIGHTS_ID],
    [uuid(305), PLAYER_AUCTION_ID],
  ]) {
    insertSource.run(sourceId, playerId, NOW_MS, NOW_MS);
  }
  connection.database.prepare(`
    INSERT INTO player_external_ids (id, player_id, provider, external_value, created_at_ms)
    VALUES (?, ?, 'sportsdataio-discovery-lab', '1001', ?)
  `).run(uuid(306), PLAYER_ONE_ID, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version)
    VALUES (?, 'sportsdataio-discovery-lab', 'active', ?, ?, 1)
  `).run(uuid(307), NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status, started_at_ms,
      completed_at_ms, player_count, error_code, metadata_json, version
    ) VALUES (?, ?, '20252026', 'last-season-2025', 'succeeded', ?, ?, 1, NULL, NULL, 1)
  `).run(uuid(308), uuid(307), NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played,
      goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20252026', ?, 82, 40, 50, 90, 10000, ?, ?)
  `).run(uuid(309), uuid(307), uuid(308), PLAYER_ONE_ID, NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_sources (id, provider, status, created_at_ms, updated_at_ms, version)
    VALUES (?, 'release_qa_fixture', 'active', ?, ?, 1)
  `).run(uuid(310), NOW_MS, NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status, started_at_ms,
      completed_at_ms, player_count, error_code, metadata_json, version
    ) VALUES (?, ?, '20262027', 'synthetic-release-qa', 'succeeded', ?, ?, 1, NULL, ?, 1)
  `).run(uuid(311), uuid(310), NOW_MS, NOW_MS, JSON.stringify({ sourceKind: "synthetic_release_qa" }));
  connection.database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id, games_played,
      goals, assists, nhl_points, fantasy_points_hundredths, source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20262027', ?, 60, 20, 30, 50, 5500, ?, ?)
  `).run(uuid(312), uuid(310), uuid(311), PLAYER_TWO_ID, NOW_MS, NOW_MS);
  context.repositories.player_ownerships.insert({
    id: uuid(401),
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    player_id: PLAYER_TWO_ID,
    team_id: TEAM_ID,
    ownership_kind: "Rostered",
    roster_category: "Active",
    position_group: "F",
    slot_number: 1,
    acquired_transaction_type: "test",
    acquired_transaction_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.ownership_events.insert({
    id: uuid(402),
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    player_id: PLAYER_RIGHTS_ID,
    team_id: TEAM_ID,
    ownership_id: null,
    event_type: "unsigned_prospect_rights_released",
    actor_user_id: USER_ID,
    source_type: "test",
    source_id: null,
    before_metadata_json: null,
    after_metadata_json: null,
    reason: null,
    occurred_at_ms: NOW_MS,
  });
  context.repositories.auctions.insert({
    id: uuid(403),
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    player_id: PLAYER_AUCTION_ID,
    status: "open",
    opened_at_ms: NOW_MS,
    resolves_at_ms: NOW_MS + 100_000,
    opened_by_user_id: USER_ID,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const authorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({
      database: connection.database,
    }),
    leagueAccessRepository: createSqliteLeagueAccessRepository({
      database: connection.database,
    }),
  });
  const service = createPlayerReadService({
    activeUserAuthorization: authorization,
    repository,
  });
  return Object.freeze({
    database: connection.database,
    repository,
    service,
  });
}

async function startApi(t, service) {
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
      return "player-read-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(token) {
        return token === SESSION_TOKEN
          ? authenticated()
          : { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf() {
        return { valid: false, code: "SESSION_INVALID" };
      },
    },
  });
  const app = express();
  app.use(
    createPlayerRouter({
      requestSecurity,
      playerReadService: service,
    })
  );
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
    cookie: `${sessionCookie.name}=${SESSION_TOKEN}`,
  });
}

function headers(cookie) {
  return {
    Origin: FRONTEND_ORIGIN,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

describe("authenticated player reads", () => {
  test("searches names case-insensitively with stable cursor pagination and no writes", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const firstPage = runtime.service.list({
      authenticated: authenticated(),
      query: " ALEX ",
      limit: 1,
    });
    assert.equal(firstPage.players.length, 1);
    assert.equal(firstPage.players[0].fullName, "alex McKay");
    assert.deepEqual(firstPage.players[0].provider, {
      provider: "nhl",
      sourcePosition: "C",
      normalizedPosition: "F",
      nhlTeamAbbreviation: "VAN",
      active: true,
      sourceVersion: "2026-07-22",
      effectiveAtMs: NOW_MS,
    });
    assert.equal(firstPage.page.hasMore, true);
    assert.equal(firstPage.page.nextCursor, PLAYER_ONE_ID);

    const secondPage = runtime.service.list({
      authenticated: authenticated(),
      query: "alex",
      limit: "1",
      cursor: firstPage.page.nextCursor,
    });
    assert.deepEqual(
      secondPage.players.map(({ fullName }) => fullName),
      ["Alex Smith"]
    );
    assert.equal(secondPage.page.hasMore, false);
    assert.equal(secondPage.page.nextCursor, null);
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("returns stable detail and rejects malformed filters, cursors, and missing players", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const detail = runtime.service.read({
      authenticated: authenticated(),
      playerId: PLAYER_ONE_ID,
    });
    assert.equal(detail.id, PLAYER_ONE_ID);
    assert.equal(detail.externalIds[0].externalValue, "1001");
    assert.deepEqual(detail.statistics, {
      provider: "sportsdataio-discovery-lab",
      nhlSeasonKey: "20252026",
      gamesPlayed: 82,
      goals: 40,
      assists: 50,
      nhlPoints: 90,
      fantasyPointsHundredths: 10000,
      sourceUpdatedAtMs: NOW_MS,
    });
    assert.throws(
      () =>
        runtime.service.list({
          authenticated: authenticated(),
          limit: 101,
        }),
      PlayerReadInputError
    );
    assert.throws(
      () =>
        runtime.service.list({
          authenticated: authenticated(),
          cursor: "not-a-player",
        }),
      PlayerReadInputError
    );
    assert.throws(
      () =>
        runtime.service.read({
          authenticated: authenticated(),
          playerId: uuid(999),
        }),
      PlayerNotFoundError
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("uses explicitly labelled synthetic fixture statistics only when SportsDataIO data is absent", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const detail = runtime.service.read({
      authenticated: authenticated(),
      playerId: PLAYER_TWO_ID,
    });
    assert.deepEqual(detail.statistics, {
      provider: "release_qa_fixture",
      nhlSeasonKey: "20262027",
      gamesPlayed: 60,
      goals: 20,
      assists: 30,
      nhlPoints: 50,
      fantasyPointsHundredths: 5500,
      sourceUpdatedAtMs: NOW_MS,
    });
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("lists only auction-eligible players for an authorized league without writing", (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const result = runtime.service.list({
      authenticated: authenticated(),
      leagueId: LEAGUE_ID,
      auctionEligible: "true",
    });
    assert.deepEqual(
      result.players.map(({ id }) => id),
      [PLAYER_ONE_ID]
    );
    assert.throws(
      () =>
        runtime.service.list({
          authenticated: authenticated(),
          leagueId: uuid(999),
          auctionEligible: "true",
        }),
      (error) => error?.code === "LEAGUE_NOT_FOUND"
    );
    assert.throws(
      () =>
        runtime.service.list({
          authenticated: authenticated(),
          leagueId: LEAGUE_ID,
        }),
      PlayerReadInputError
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("serves collection and detail envelopes only to an authenticated session", async (t) => {
    const runtime = createRuntime(t);
    const before = runtime.database.serialize();
    const api = await startApi(t, runtime.service);
    const list = await fetch(
      `${api.baseUrl}/api/v1/players?query=AlEx&limit=1`,
      { headers: headers(api.cookie) }
    );
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listBody.data[0].id, PLAYER_ONE_ID);
    assert.equal(listBody.page.hasMore, true);
    assert.equal(listBody.page.nextCursor, PLAYER_ONE_ID);
    assert.equal(listBody.meta.requestId, "player-read-request");

    const eligible = await fetch(
      `${api.baseUrl}/api/v1/players?leagueId=${LEAGUE_ID}&auctionEligible=true`,
      { headers: headers(api.cookie) }
    );
    assert.equal(eligible.status, 200);
    assert.deepEqual(
      (await eligible.json()).data.map(({ id }) => id),
      [PLAYER_ONE_ID]
    );

    const detail = await fetch(
      `${api.baseUrl}/api/v1/players/${PLAYER_ONE_ID}`,
      { headers: headers(api.cookie) }
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.fullName, "alex McKay");

    const invalid = await fetch(
      `${api.baseUrl}/api/v1/players?limit=101`,
      { headers: headers(api.cookie) }
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).error.code,
      "PLAYER_READ_INPUT_INVALID"
    );

    const signedOut = await fetch(`${api.baseUrl}/api/v1/players`, {
      headers: headers(),
    });
    assert.equal(signedOut.status, 401);
    assert.equal((await signedOut.json()).error.code, "SESSION_REQUIRED");
    assert.equal(before.equals(runtime.database.serialize()), true);
  });
});
