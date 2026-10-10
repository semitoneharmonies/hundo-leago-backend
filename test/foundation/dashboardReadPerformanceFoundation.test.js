const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDatabase } = require("../../src/infrastructure/database/connection");
const { createSqliteMatchupReadRepository } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupReadRepository");
const { createPerformanceFixture } = require("../helpers/createPerformanceFixture");
const { fixtureId } = require("../../src/operations/release/releaseQaFixtureContract");

test("targeted current-week reads preserve schedule selection, boundaries, isolation and stored data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-dashboard-reads-"));
  const databasePath = path.join(root, "dashboard-release-qa.sqlite3");
  await createPerformanceFixture({
    databasePath, environment: "test", password: "hundo", temporaryRoot: root,
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
  });
  const { database } = openDatabase({ databasePath, environment: "test" });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = createSqliteMatchupReadRepository({ database });
  const scope = {
    leagueId: fixtureId("league:leagueA"),
    seasonId: fixtureId("season:leagueA:current"),
  };

  function verifySelection() {
    const before = database.serialize();
    const schedule = repository.readSchedule(scope);
    const times = [0, ...schedule.weeks.flatMap((week) => [
      week.starts_at_ms - 1, week.starts_at_ms,
      week.rolls_over_at_ms - 1, week.rolls_over_at_ms,
    ])];
    for (const nowMs of times) {
      // The previous endpoint selected from the full schedule in sequence order.
      const expected = schedule.weeks.find((week) =>
        week.starts_at_ms <= nowMs && nowMs < week.rolls_over_at_ms && week.status !== "cancelled"
      ) || schedule.weeks.find((week) => !["final", "cancelled"].includes(week.status)) || null;
      const current = repository.readCurrentWeek({ ...scope, nowMs });
      assert.deepEqual(current.week, expected, `current week at ${nowMs}`);
      assert.deepEqual(current.health, schedule.health);
      assert.deepEqual(current.season, schedule.season);
      assert.deepEqual(current.matchups, schedule.matchups.filter((row) => row.matchup_week_id === expected?.id));
      assert.deepEqual(current.byes, schedule.byes.filter((row) => row.matchup_week_id === expected?.id));
      if (expected) {
        const detail = repository.readWeek({ ...scope, weekId: expected.id });
        assert.deepEqual(detail, { week: expected, matchups: current.matchups, byes: current.byes });
      }
    }
    assert.equal(database.serialize().equals(before), true, "all reads leave stored data unchanged");
  }

  verifySelection();
  database.prepare("UPDATE matchup_weeks SET status = 'cancelled' WHERE id = ?")
    .run(fixtureId("matchup-week:leagueA:current"));
  verifySelection();
  database.prepare("UPDATE matchup_weeks SET status = 'final' WHERE league_id = ? AND season_id = ?")
    .run(scope.leagueId, scope.seasonId);
  verifySelection();
  const weeks = repository.readSchedule(scope).weeks;
  assert.equal(repository.readCurrentWeek({ ...scope, nowMs: Math.max(...weeks.map((week) => week.rolls_over_at_ms)) }).week, null);
  assert.equal(repository.readCurrentWeek({ ...scope, seasonId: fixtureId("season:leagueB:current"), nowMs: 0 }), null);
  database.prepare("UPDATE matchup_weeks SET status = 'cancelled' WHERE league_id = ? AND season_id = ?")
    .run(scope.leagueId, scope.seasonId);
  assert.equal(repository.readCurrentWeek({ ...scope, nowMs: weeks[0].starts_at_ms }).week, null);
});
