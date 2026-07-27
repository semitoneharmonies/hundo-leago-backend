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

test("authenticated team workspace projects cap, picks, assets, and persisted line order", async (t) => {
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

  const repository = createSqliteTeamWorkspaceRepository({
    database: connection.database,
  });
  const leagueId = fixtureId("league:leagueA");
  const teamId = fixtureId("team:leagueA:2");
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
