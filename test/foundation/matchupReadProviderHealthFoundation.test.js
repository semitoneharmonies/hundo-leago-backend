const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  createSqliteMatchupReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteMatchupReadRepository"
);
const {
  createReleaseQaFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  FIXTURE_NOW_MS,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);

test("matchup health recognizes release-QA and SportsDataIO refresh sources without mutating state", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-matchup-health-provider-")
  );
  const databasePath = path.join(root, "m7-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: "hundo",
    temporaryRoot: root,
  });
  const connection = openDatabase({
    databasePath,
    environment: "test",
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repository = createSqliteMatchupReadRepository({
    database: connection.database,
  });
  const scope = {
    leagueId: fixtureId("league:leagueA"),
    seasonId: fixtureId("season:leagueA:current"),
  };

  const fixtureHealth = repository.readSchedule(scope).health;
  assert.equal(fixtureHealth.latest.status, "succeeded");
  assert.equal(fixtureHealth.latestSuccessful.status, "succeeded");
  assert.equal(
    connection.database.prepare(`
      SELECT source.provider
      FROM stat_refreshes AS refresh
      JOIN stat_sources AS source
        ON source.id = refresh.stat_source_id
      WHERE refresh.id = ?
    `).get(fixtureHealth.latestSuccessful.id).provider,
    "release_qa_fixture"
  );

  const providerSourceId = crypto.randomUUID();
  const failedRefreshId = crypto.randomUUID();
  connection.database.prepare(`
    INSERT INTO stat_sources (
      id, provider, status, created_at_ms, updated_at_ms, version
    ) VALUES (
      ?, 'sportsdataio-discovery-lab', 'active', ?, ?, 1
    )
  `).run(providerSourceId, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version,
      status, started_at_ms, completed_at_ms, player_count,
      error_code, metadata_json, version
    ) VALUES (
      ?, ?, '20262027', NULL, 'failed', ?, ?, NULL,
      'STATISTICS_PROVIDER_FAILED', NULL, 1
    )
  `).run(
    failedRefreshId,
    providerSourceId,
    FIXTURE_NOW_MS + 1,
    FIXTURE_NOW_MS + 2
  );

  const beforeRead = connection.database.serialize();
  const mixedHealth = repository.readSchedule(scope).health;
  assert.equal(mixedHealth.latest.id, failedRefreshId);
  assert.equal(mixedHealth.latest.status, "failed");
  assert.equal(
    mixedHealth.latestSuccessful.id,
    fixtureHealth.latestSuccessful.id
  );
  assert.equal(
    beforeRead.equals(connection.database.serialize()),
    true
  );
});
