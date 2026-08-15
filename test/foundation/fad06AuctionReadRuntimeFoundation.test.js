"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createSecurityFoundations,
} = require(
  "../../src/bootstrap/createSecurityFoundations"
);
const {
  createTargetRuntime,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  openDatabase,
} = require(
  "../../src/infrastructure/database/connection"
);
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  seedFixture,
} = require(
  "../../src/operations/release/createReleaseQaFixture"
);
const {
  FIXTURE_NOW_MS,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FRONTEND_ORIGIN = "https://staging.hundoleago.com";
const BUILD_ID = "fad06-auction-read-runtime-proof";
const DAY_MS = 86_400_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function securityEnvironment() {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    APP_BUILD_ID: BUILD_ID,
    LOG_LEVEL: "info",
    SESSION_COOKIE_SAME_SITE: "lax",
    PUBLIC_FRONTEND_ORIGIN: FRONTEND_ORIGIN,
    FRONTEND_ORIGINS: FRONTEND_ORIGIN,
    EMAIL_DELIVERY_MODE: "capture",
    RATE_LIMIT_KEY_SECRET:
      "fad06-read-rate-limit-secret-material-0123456789",
    AUDIT_METADATA_SECRET:
      "fad06-read-audit-secret-material-9876543210",
    ACTION_TOKEN_DELIVERY_KEY:
      Buffer.alloc(32, 0x35).toString("base64url"),
  };
}

function deterministicFoundations() {
  let nextId = 910_000;
  let nextByte = 1;
  return createSecurityFoundations({
    env: securityEnvironment(),
    now: () => FIXTURE_NOW_MS,
    randomUUID() {
      nextId += 1;
      return uuid(nextId);
    },
    randomBytes(length) {
      const result = Buffer.alloc(length, nextByte);
      nextByte = nextByte === 255 ? 1 : nextByte + 1;
      return result;
    },
    loggerSink() {},
  });
}

async function createDatabase(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-fad06-auction-read-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "target.sqlite3"),
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: BUILD_ID,
    now: () => FIXTURE_NOW_MS,
  });
  const seeded = connection.database.transaction(() =>
    seedFixture(
      connection.database,
      "unused-fad06-auction-read-password-hash",
      { includeIdentityMetadata: false }
    )
  ).immediate();
  await Promise.all(seeded.acceptancePromises);
  seeded.assertLateLockCoverage();

  const leagueId = fixtureId("league:leagueA");
  const seasonId = fixtureId("season:leagueA:current");
  const auctionId = fixtureId("fad06-read:auction:second");
  const bidId = fixtureId("fad06-read:bid:second");
  const teamId = fixtureId("team:leagueA:3");
  const managerId = fixtureId("account:leagueAManagerTwo");
  connection.database.transaction(() => {
    assert.equal(
      connection.database.prepare(`
        UPDATE auction_bids
        SET team_id = ?
        WHERE auction_id = ? AND status = 'active'
      `).run(
        fixtureId("team:leagueA:2"),
        fixtureId("auction:leagueA")
      ).changes,
      1
    );
    connection.database.prepare(`
      INSERT INTO auctions (
        id, league_id, season_id, player_id, status,
        opened_at_ms, resolves_at_ms, opened_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1)
    `).run(
      auctionId,
      leagueId,
      seasonId,
      fixtureId("player:freeAgentDefence"),
      FIXTURE_NOW_MS - 7_200_000,
      FIXTURE_NOW_MS + 2 * DAY_MS,
      managerId,
      FIXTURE_NOW_MS - 7_200_000,
      FIXTURE_NOW_MS - 7_200_000
    );
    connection.database.prepare(`
      INSERT INTO auction_contexts (
        id, league_id, season_id, auction_id, source_kind,
        fad_id, fad_rollover_id, fad_allocation_id,
        fad_origin, created_at_ms
      ) VALUES (?, ?, ?, ?, 'ordinary_weekly',
        NULL, NULL, NULL, NULL, ?)
    `).run(
      auctionId,
      leagueId,
      seasonId,
      auctionId,
      FIXTURE_NOW_MS - 7_200_000
    );
    connection.database.prepare(`
      INSERT INTO auction_bids (
        id, league_id, season_id, auction_id, team_id,
        submitted_by_user_id, total_value_cents, term_years,
        lowest_offered_aav_cents, lowest_offered_total_value_cents,
        first_submitted_at_ms,
        last_edited_at_ms, edit_count, status,
        idempotency_request_id, version
      ) VALUES (?, ?, ?, ?, ?, ?, 1200, 3, 400, 1200,
        ?, ?, 0, 'active', NULL, 1)
    `).run(
      bidId,
      leagueId,
      seasonId,
      auctionId,
      teamId,
      managerId,
      FIXTURE_NOW_MS - 3_600_000,
      FIXTURE_NOW_MS - 3_600_000
    );
  }).immediate();
  return connection.database;
}

async function startApplication(t, runtime) {
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function requestHeaders(runtime, session) {
  return {
    Accept: "application/json",
    Origin: FRONTEND_ORIGIN,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Cookie:
      `${runtime.transport.sessionCookie.name}=` +
      session.rawSessionToken,
  };
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test(
  "full-migration composed auction GETs preserve privacy and stable cursor paging without writes",
  async (t) => {
    const database = await createDatabase(t);
    const runtime = createTargetRuntime({
      database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      securityFoundations: deterministicFoundations(),
      currentSeason: {
        label: "2026",
        nhlSeasonKey: "20262027",
      },
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    });
    const baseUrl = await startApplication(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const firstAuctionId = fixtureId("auction:leagueA");
    const secondAuctionId = fixtureId(
      "fad06-read:auction:second"
    );
    const managerOne = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueAManagerOne"),
    });
    const managerTwo = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueAManagerTwo"),
    });
    const managerOneHeaders = requestHeaders(runtime, managerOne);
    const managerTwoHeaders = requestHeaders(runtime, managerTwo);
    const changesBeforeGets = database
      .prepare("SELECT total_changes() AS count")
      .get().count;

    const firstPage = await getJson(
      `${baseUrl}/api/v1/leagues/${leagueId}/auctions?limit=1`,
      managerOneHeaders
    );
    assert.deepEqual(Object.keys(firstPage).sort(), [
      "actions",
      "data",
      "meta",
      "page",
    ]);
    assert.deepEqual(
      firstPage.data.map(({ auctionId }) => auctionId),
      [firstAuctionId]
    );
    assert.equal(firstPage.page.hasMore, true);
    assert.equal(typeof firstPage.page.nextCursor, "string");
    assert.equal(
      firstPage.data[0].viewerTeams.find(
        ({ bid }) => bid !== null
      )?.bid.totalValueCents,
      900
    );
    assert.equal(firstPage.data[0].administrativeBids.length, 0);

    const secondPage = await getJson(
      `${baseUrl}/api/v1/leagues/${leagueId}/auctions` +
        `?limit=1&cursor=${encodeURIComponent(
          firstPage.page.nextCursor
        )}`,
      managerOneHeaders
    );
    assert.deepEqual(
      secondPage.data.map(({ auctionId }) => auctionId),
      [secondAuctionId]
    );
    assert.equal(secondPage.page.hasMore, false);
    assert.equal(secondPage.page.nextCursor, null);
    assert.equal(
      secondPage.data[0].viewerTeams.every(
        ({ bid }) => bid === null
      ),
      true
    );
    assert.equal(JSON.stringify(secondPage).includes("1200"), false);

    const privateDetail = await getJson(
      `${baseUrl}/api/v1/leagues/${leagueId}/auctions/${firstAuctionId}`,
      managerTwoHeaders
    );
    assert.deepEqual(Object.keys(privateDetail).sort(), [
      "data",
      "meta",
    ]);
    assert.equal(
      privateDetail.data.viewerTeams.every(
        ({ bid }) => bid === null
      ),
      true
    );
    assert.equal(privateDetail.data.administrativeBids.length, 0);
    assert.equal(JSON.stringify(privateDetail).includes("900"), false);
    assert.equal(
      database.prepare("SELECT total_changes() AS count").get().count,
      changesBeforeGets
    );
  }
);
