const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildCapOutlook } = require("../../src/domain/contracts/capOutlookPolicy");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { createSqliteTeamWorkspaceRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository");
const { createReleaseQaFixture } = require("../../src/operations/release/createReleaseQaFixture");
const { FIXTURE_NOW_MS, fixtureId } = require("../../src/operations/release/releaseQaFixtureContract");

const id = (name) => fixtureId(`cap-outlook:${name}`);
function material() {
  const seasons = [0, 1, 2].map((index) => ({ id: id(`season-${index}`), nhl_season_key: `${2026 + index}${2027 + index}`, label: `${2026 + index}-${27 + index}` }));
  const player = (name, category, position, term) => ({
    ownership_id: id(`ownership-${name}`), player_id: id(`player-${name}`), full_name: name,
    contract_id: term ? id(`contract-${name}`) : null,
    roster_category: category, position_group: position, remaining_contract_years: term,
  });
  const players = [player("Forward", "Active", "F", 3), player("Defender", "Active", "D", 1), player("Bench", "Bench", "F", 2), player("IR", "Injured Reserve", "D", 3), player("ELC", "Prospect", "F", 3), player("Unsigned", "Prospect", "D", 0)];
  const contractYears = players.flatMap((player, index) => seasons.slice(0, player.remaining_contract_years).map((season, offset) => ({ contract_id: player.contract_id, season_id: season.id, aav_cents: [1000, 500, 400, 300, 100][index], status: offset === 0 ? "current" : "future" })));
  const obligation = (name, responsibleTeam, amounts, contractName = name) => amounts.map((amount, offset) => ({
    obligation_id: id(name), contract_id: id(`contract-${contractName}`), player_id: id(`player-${contractName}`),
    player_name: name, responsible_team_id: responsibleTeam, season_id: seasons[offset].id,
    status: offset === 0 ? "current" : "future", amount_cents: amount,
  }));
  return {
    scope: { league_id: id("league"), team_id: id("team"), season_id: seasons[0].id, season_label: seasons[0].label, nhl_season_key: seasons[0].nhl_season_key },
    cap: { capLimitCents: 10000, capUsageCents: 1413, complete: true, issues: [] }, seasons, players, contractYears,
    retentionYears: [...obligation("Incoming", id("other-team"), [250, 250], "Forward"), ...obligation("Outgoing", id("team"), [100, 100, 100])],
    buyoutYears: obligation("Saved buyout", id("team"), [63, 63]),
  };
}

test("cap outlook uses saved season schedules, net salaries and historical cents without charging exempt categories", () => {
  const input = material();
  const before = JSON.stringify(input);
  const result = buildCapOutlook(input);
  assert.deepEqual(result.seasons.map((season) => season.usageCents), [1413, 913, 1100]);
  assert.deepEqual(result.seasons.map((season) => season.spaceCents), [8587, 9087, 8900]);
  assert.deepEqual(result.rows.find((row) => row.name === "Forward").amountsCents, [750, 750, 1000]);
  assert.deepEqual(result.rows.find((row) => row.name === "Defender").amountsCents, [500, null, null]);
  assert.deepEqual(result.rows.find((row) => row.name === "Saved buyout").amountsCents, [63, 63, null]);
  assert.deepEqual(result.rows.find((row) => row.name === "Unsigned").amountsCents, [null, null, null]);
  assert.deepEqual(result.seasons.map((season) => season.benchCents), [400, 400, 0]);
  assert.ok(result.seasons.every((season) => season.injuredReserveCents === 300 && season.prospectCents === 100 && season.complete));
  assert.equal(result.rows.filter((row) => row.category === "Retained salary").length, 1);
  assert.equal(JSON.stringify(input), before);
});

test("active/bench reassignment changes all affected seasons without changing contract schedules", () => {
  const input = material();
  input.players[0].roster_category = "Bench";
  input.cap.capUsageCents -= 750;
  const result = buildCapOutlook(input);
  assert.deepEqual(result.seasons.map((season) => season.usageCents), [663, 163, 100]);
  assert.deepEqual(result.seasons.map((season) => season.benchCents), [1150, 1150, 1000]);
  input.players[2].roster_category = "Active";
  input.cap.capUsageCents += 400;
  assert.deepEqual(buildCapOutlook(input).seasons.map((season) => season.usageCents), [1063, 563, 100]);
});

test("incomplete cap evidence is flagged and negative cap space remains visible", () => {
  const input = material();
  input.cap.capLimitCents = 1000;
  assert.equal(buildCapOutlook(input).seasons[0].spaceCents, -413);
  input.cap.complete = false;
  assert.ok(buildCapOutlook(input).seasons.every((season) => !season.complete));
  input.cap.complete = true;
  input.contractYears.shift();
  assert.ok(buildCapOutlook(input).seasons.every((season) => !season.complete));
});

test("SQLite outlook reads exact league/team schedules, future buyouts and retentions with zero writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-cap-outlook-"));
  const databasePath = path.join(root, "cap-outlook-release-qa.sqlite3");
  await createReleaseQaFixture({ databasePath, environment: "test", migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), password: "hundo", temporaryRoot: root });
  const { database } = openDatabase({ databasePath, environment: "test" });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const leagueId = fixtureId("league:leagueA");
  const futureSeason = database.prepare("SELECT id FROM seasons WHERE league_id = ? AND nhl_season_key = '20272028'").get(leagueId);
  database.prepare(`INSERT INTO retention_years (id, league_id, retention_obligation_id, season_id, retained_aav_cents, status, created_at_ms) VALUES (?, ?, ?, ?, 75, 'future', ?)`)
    .run(id("future-retention"), leagueId, fixtureId("retention:leagueA"), futureSeason.id, FIXTURE_NOW_MS);
  database.prepare(`INSERT INTO buyout_years (id, league_id, buyout_obligation_id, season_id, penalty_cents, status, created_at_ms) VALUES (?, ?, ?, ?, 63, 'future', ?)`)
    .run(id("future-buyout"), leagueId, fixtureId("buyout:leagueA"), futureSeason.id, FIXTURE_NOW_MS);
  database.exec("PRAGMA query_only = ON");
  const before = database.prepare("SELECT total_changes() AS total").get().total;
  const repository = createSqliteTeamWorkspaceRepository({ database });
  const teamTwo = repository.read({ leagueId, teamId: fixtureId("team:leagueA:2") });
  assert.equal(teamTwo.capOutlook.seasons[1].retainedSalaryCents, 75);
  const teamSix = repository.read({ leagueId, teamId: fixtureId("team:leagueA:6") });
  assert.equal(teamSix.capOutlook.seasons[1].buyoutPenaltyCents, 63);
  assert.equal(teamSix.capOutlook.seasons[2].buyoutPenaltyCents, 0);
  for (const league of ["leagueA", "leagueB"]) {
    const leagueId = fixtureId(`league:${league}`);
    const teams = database.prepare("SELECT id FROM teams WHERE league_id = ?").all(leagueId);
    for (const team of teams) {
      const record = repository.read({ leagueId, teamId: team.id });
      assert.equal(record.capOutlook.seasons[0].usageCents, record.cap.capUsageCents);
      assert.ok(record.capOutlook.seasons[0].complete);
      assert.deepEqual(record.capOutlook.seasons.map((season) => season.key), ["20262027", "20272028", "20282029"]);
      if (league === "leagueB") assert.equal(record.capOutlook.seasons[1].buyoutPenaltyCents, 0);
    }
  }
  assert.equal(database.prepare("SELECT total_changes() AS total").get().total, before);
});
