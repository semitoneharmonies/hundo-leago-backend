const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createTeamWorkspaceService,
} = require("../../src/application/services/leagues/createTeamWorkspaceService");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  createSqliteTeamWorkspaceRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository");
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

test("authenticated team workspace projects current-season stats, cap, picks, assets, and persisted line order", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-team-workspace-")
  );
  const databasePath = path.join(root, "team-workspace-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: "hundo",
    temporaryRoot: root,
  });
  const connection = openDatabase({ databasePath, environment: "test" });
  t.after(() => {
    connection.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const leagueId = fixtureId("league:leagueA");
  const teamId = fixtureId("team:leagueA:2");
  const seasonId = fixtureId("season:leagueA:current");
  const decoyPlayerId = connection.database.prepare(`
    SELECT player_id
    FROM player_ownerships
    WHERE league_id = ? AND season_id = ? AND team_id = ?
    ORDER BY player_id
    LIMIT 1
  `).get(leagueId, seasonId, teamId).player_id;
  const decoySourceId = fixtureId("stat-source:prior-season-team-audit");
  const decoyRefreshId = fixtureId("stat-refresh:prior-season-team-audit");
  connection.database.prepare(`
    INSERT INTO stat_sources (
      id, provider, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, 'prior-season-team-audit', 'active', ?, ?, 1)
  `).run(decoySourceId, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
  connection.database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status,
      started_at_ms, completed_at_ms, player_count, error_code,
      metadata_json, version
    ) VALUES (?, ?, '20252026', 'prior-season-decoy', 'succeeded',
      ?, ?, 1, NULL, NULL, 1)
  `).run(
    decoyRefreshId,
    decoySourceId,
    FIXTURE_NOW_MS + 200_000,
    FIXTURE_NOW_MS + 200_001
  );
  connection.database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id,
      games_played, goals, assists, nhl_points,
      fantasy_points_hundredths, source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20252026', ?, 82, 50, 50, 100,
      99999, ?, ?)
  `).run(
    fixtureId("stat-total:prior-season-team-audit"),
    decoySourceId,
    decoyRefreshId,
    decoyPlayerId,
    FIXTURE_NOW_MS + 200_002,
    FIXTURE_NOW_MS + 200_002
  );

  const repository = createSqliteTeamWorkspaceRepository({
    database: connection.database,
  });
  const actorUserId = fixtureId("account:leagueAManagerOne");
  const service = createTeamWorkspaceService({
    leagueAuthorization: {
      requireCommissioner() {
        const error = new Error("not commissioner");
        error.code = "LEAGUE_COMMISSIONER_REQUIRED";
        throw error;
      },
    },
    teamAuthorization: {
      requireTeamVisibility() {
        return { leagueId, teamId, actorUserId };
      },
      requireManager() {
        return { leagueId, teamId, actorUserId };
      },
    },
    repository,
    clock: { nowMs: () => FIXTURE_NOW_MS + 100_000 },
    secureRandom: { id: () => crypto.randomUUID() },
  });

  const workspace = service.read({
    authenticated: {},
    leagueId,
    teamId,
  });
  assert.equal(workspace.code, "TEAM_WORKSPACE_FOUND");
  assert.equal(workspace.canManage, true);
  assert.equal(workspace.cap.activePlayerCents, 4050);
  assert.equal(workspace.cap.retainedSalaryCents, 75);
  assert.equal(workspace.cap.buyoutPenaltyCents, 0);
  assert.equal(workspace.cap.usageCents, 4125);
  assert.equal(workspace.cap.retentionSlotsUsed, 1);
  assert.equal(workspace.cap.retentionSlotLimit, 3);
  assert.equal(workspace.draftPicks.length, 16);
  assert.deepEqual(
    [...new Set(workspace.draftPicks.map((pick) => pick.targetSeason.label))],
    ["2026-27", "2027-28", "2028-29", "2029-30"]
  );
  assert.deepEqual(
    workspace.tradeAssets.draftPicks.slice(0, 4).map(({ label }) => label),
    [
      "2026-27 Round 1 · originally Alpha Ravens",
      "2026-27 Round 2 · originally Alpha Ravens",
      "2026-27 Round 3 · originally Alpha Ravens",
      "2026-27 Round 4 · originally Alpha Ravens",
    ]
  );
  assert.equal(
    workspace.tradeAssets.contracts.length,
    workspace.players.filter(
      (player) =>
        player.contract !== null &&
        ["Active", "Bench", "Injured Reserve"].includes(
          player.rosterCategory
        )
    ).length
  );
  assert.equal(workspace.orderVersion, 0);
  assert.notEqual(
    workspace.players.find(
      ({ playerId }) => playerId === decoyPlayerId
    ).statistics?.fantasyPointsHundredths,
    99_999
  );

  const forwards = workspace.players.filter(
    (player) =>
      player.rosterCategory === "Active" &&
      player.normalizedPosition === "F"
  );
  const defence = workspace.players.filter(
    (player) =>
      player.rosterCategory === "Active" &&
      player.normalizedPosition === "D"
  );
  const saved = service.saveOrder({
    authenticated: {},
    leagueId,
    teamId,
    input: {
      expectedVersion: 0,
      forwardOwnerships: forwards
        .toReversed()
        .map(({ ownershipId: id, ownershipVersion: version }) => ({
          id,
          version,
        })),
      defenceOwnerships: defence.map(
        ({ ownershipId: id, ownershipVersion: version }) => ({
          id,
          version,
        })
      ),
    },
  });
  assert.equal(saved.orderVersion, 1);

  const reread = service.read({ authenticated: {}, leagueId, teamId });
  assert.equal(reread.orderVersion, 1);
  assert.deepEqual(
    reread.players
      .filter(
        (player) =>
          player.rosterCategory === "Active" &&
          player.normalizedPosition === "F"
      )
      .map(({ ownershipId }) => ownershipId),
    forwards.toReversed().map(({ ownershipId }) => ownershipId)
  );
});
