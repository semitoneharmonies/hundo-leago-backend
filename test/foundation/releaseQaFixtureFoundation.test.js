const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ReleaseQaFixtureError,
  assertSafeFixturePath,
  createReleaseQaFixture,
  seedFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  ReleaseQaFixtureVerificationError,
  verifyReleaseQaFixture,
} = require("../../src/operations/release/verifyReleaseQaFixture");
const {
  ACCOUNT_ALIASES,
  FIXTURE_ID_NAMESPACE,
  PLAYER_BLUEPRINTS,
  checksumManifest,
  fixtureEmail,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");
const {
  openDatabase,
  openReadonlyDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createMatchupScoringService,
} = require("../../src/application/services/matchups/createMatchupScoringService");
const {
  createSqliteMatchupScoringRepository,
} = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");
const {
  FIXTURE_NOW_MS,
} = require("../../src/operations/release/releaseQaFixtureContract");
const {
  createScryptPasswordHasher,
} = require("../../src/infrastructure/security/createScryptPasswordHasher");
const {
  assertReleaseQaPassword,
} = require("../../src/operations/release/releaseQaPasswordPolicy");
const {
  ReleaseQaFixtureArgumentError,
  parseArguments,
  runReleaseQaFixtureCommand,
} = require("../../scripts/create-release-qa-fixture");

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, "..", "..", "database", "migrations");
const FIXTURE_PASSWORD = "hundo";
const EXPECTED_IDENTITIES = Object.freeze({
  platformAdmin: Object.freeze({ displayName: "Admin", email: "admin@release-qa.example.test" }),
  leagueACommissioner: Object.freeze({ displayName: "Comm A", email: "comm.a@release-qa.example.test" }),
  leagueBCommissioner: Object.freeze({ displayName: "Comm B", email: "comm.b@release-qa.example.test" }),
  leagueAManagerOne: Object.freeze({ displayName: "Man A Leag A", email: "man.a.leag.a@release-qa.example.test" }),
  leagueAManagerTwo: Object.freeze({ displayName: "Man B Leag A", email: "man.b.leag.a@release-qa.example.test" }),
  leagueBManagerOne: Object.freeze({ displayName: "Man A Leag B", email: "man.a.leag.b@release-qa.example.test" }),
  verifiedWithoutMembership: Object.freeze({ displayName: "No League", email: "no.league@release-qa.example.test" }),
  pendingVerification: Object.freeze({ displayName: "Pending", email: "pending@release-qa.example.test" }),
  deactivated: Object.freeze({ displayName: "Deactivated", email: "deactivated@release-qa.example.test" }),
});

test("release-QA fixture keeps the deployed v1 identity namespace stable", () => {
  assert.equal(FIXTURE_ID_NAMESPACE, "m7-release-qa-fixture-v1");
  assert.equal(
    fixtureId("league:leagueA"),
    "a55151f1-7af1-4773-a907-8e4b27d4d04d"
  );
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-m7-release-qa-test-"));
  t.after(() => {
    const physicalTemp = fs.realpathSync(os.tmpdir());
    const resolved = path.resolve(root);
    assert.equal(resolved.startsWith(`${physicalTemp}${path.sep}`), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function providerUuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

test("release-QA fixture path gate refuses non-test, outside-root, existing, and ambiguous targets", (t) => {
  const root = temporaryRoot(t);
  const safePath = path.join(root, "m7-release-qa.sqlite3");
  assert.throws(
    () => assertSafeFixturePath({ databasePath: safePath, environment: "staging", temporaryRoot: root }),
    (error) => error instanceof ReleaseQaFixtureError &&
      error.code === "RELEASE_QA_TEST_ENVIRONMENT_REQUIRED"
  );
  assert.throws(
    () => assertSafeFixturePath({ databasePath: path.join(os.tmpdir(), "outside-release-qa.sqlite3"), environment: "test", temporaryRoot: root }),
    (error) => error instanceof ReleaseQaFixtureError &&
      error.code === "RELEASE_QA_PATH_OUTSIDE_TEMP_ROOT"
  );
  assert.throws(
    () => assertSafeFixturePath({ databasePath: path.join(root, "fixture.sqlite3"), environment: "test", temporaryRoot: root }),
    (error) => error instanceof ReleaseQaFixtureError &&
      error.code === "RELEASE_QA_DATABASE_NAME_INVALID"
  );
  fs.writeFileSync(safePath, "occupied", { flag: "wx" });
  assert.throws(
    () => assertSafeFixturePath({ databasePath: safePath, environment: "test", temporaryRoot: root }),
    (error) => error instanceof ReleaseQaFixtureError &&
      error.code === "RELEASE_QA_DATABASE_ALREADY_EXISTS"
  );
});

test("release-QA fixture creates two isolated leagues and a repeatable safe semantic manifest", async (t) => {
  const root = temporaryRoot(t);
  const firstPath = path.join(root, "first-release-qa.sqlite3");
  const secondPath = path.join(root, "second-release-qa.sqlite3");
  const options = {
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: FIXTURE_PASSWORD,
    temporaryRoot: root,
  };
  const first = await createReleaseQaFixture({ ...options, databasePath: firstPath });
  const second = await createReleaseQaFixture({ ...options, databasePath: secondPath });

  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.manifest, verifyReleaseQaFixture({ databasePath: firstPath }));
  assert.equal(first.manifest.manifestChecksum, checksumManifest(first.manifest));
  assert.match(first.manifest.manifestChecksum, /^[0-9a-f]{64}$/);
  assert.equal(first.manifest.global.leagueCount, 2);
  assert.equal(first.manifest.global.playerCount, 26);
  assert.equal(first.manifest.global.overlappingPlayerCount, 26);
  assert.equal(first.manifest.global.overlappingTeamNameCount, 0);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.teams), [6, 6]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.populatedRosterTeams), [6, 6]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.syntheticPlayerTotals), [26, 26]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.matchupPlayers), [36, 36]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.trades), [5, 5]);
  assert.equal(first.manifest.scenarios.twoLeagueIdentityIsolation, true);
  assert.equal(first.manifest.scenarios.distinctLeagueRosters, true);

  const serializedManifest = JSON.stringify(first.manifest);
  assert.equal(serializedManifest.includes("@release-qa.example.test"), false);
  assert.equal(serializedManifest.toLowerCase().includes("password"), false);
  assert.equal(serializedManifest.includes(FIXTURE_PASSWORD), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(serializedManifest), false);

  const database = openReadonlyDatabase({ databasePath: firstPath });
  try {
    const leagueA = fixtureId("league:leagueA");
    const leagueB = fixtureId("league:leagueB");
    assert.notEqual(leagueA, leagueB);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teams WHERE league_id=?").get(leagueA).count, 6);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teams WHERE league_id=?").get(leagueB).count, 6);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM teams a JOIN teams b
      ON b.name_normalized=a.name_normalized
      WHERE a.league_id=? AND b.league_id=?
    `).get(leagueA, leagueB).count, 0);
    assert.equal(
      database.prepare(`
        SELECT team_id AS teamId
        FROM player_ownerships
        WHERE league_id=? AND player_id=?
      `).get(
        leagueA,
        fixtureId("player:benchForward")
      ).teamId,
      fixtureId("team:leagueA:1")
    );
    assert.equal(
      database.prepare(`
        SELECT team_id AS teamId
        FROM player_ownerships
        WHERE league_id=? AND player_id=?
      `).get(
        leagueB,
        fixtureId("player:benchForward")
      ).teamId,
      fixtureId("team:leagueB:2")
    );
    const completedTradeId = fixtureId("trade-scenario:leagueA:accepted:1");
    const completedTrade = database.prepare(`
      SELECT status, completed_at_ms, commissioner_completion_reference
      FROM trades
      WHERE league_id=? AND id=?
    `).get(leagueA, completedTradeId);
    assert.equal(completedTrade.status, "completed");
    assert.equal(Number.isSafeInteger(completedTrade.completed_at_ms), true);
    assert.equal(
      typeof completedTrade.commissioner_completion_reference,
      "string"
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_events
      WHERE league_id=? AND trade_id=? AND event_type='proposal_accepted'
    `).get(leagueA, completedTradeId).count, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM ownership_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer'
    `).get(leagueA, completedTradeId).count, 2);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM contract_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer'
    `).get(leagueA, completedTradeId).count, 2);
    assert.deepEqual(database.prepare(`
      SELECT status, completed_at_ms
      FROM trades
      WHERE league_id=? AND id=?
    `).get(
      leagueA,
      fixtureId("trade-scenario:leagueA:rejected:1")
    ), {
      status: "declined",
      completed_at_ms: null,
    });
    assert.equal(database.prepare(`
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
    `).get(leagueA).count, 5);
    assert.equal(database.prepare(`
      SELECT status
      FROM trades
      WHERE league_id=? AND id=?
    `).get(
      leagueA,
      fixtureId("trade-scenario:leagueA:invalid-cap:1")
    ).status, "proposed");
    const scoring = createMatchupScoringService({
      repository: createSqliteMatchupScoringRepository({ database }),
    });
    const liveScore = scoring.readLive({
      leagueId: leagueA,
      seasonId: fixtureId("season:leagueA:current"),
      weekId: fixtureId("matchup-week:leagueA:current"),
      matchupId: fixtureId("matchup:leagueA:current"),
      providers: ["sportsdataio-discovery-lab", "release_qa_fixture"],
      nowMs: FIXTURE_NOW_MS,
    });
    assert.equal(liveScore.source.provider, "release_qa_fixture");
    assert.equal(liveScore.home.players.length > 0, true);
    assert.equal(liveScore.away.players.length > 0, true);
    assert.equal(liveScore.home.players.every(({ dataStatus }) => dataStatus === "available"), true);
    assert.equal(liveScore.away.players.every(({ dataStatus }) => dataStatus === "available"), true);
    for (const alias of ACCOUNT_ALIASES) {
      const user = database.prepare(`
        SELECT display_name, email_normalized
        FROM users
        WHERE id=?
      `).get(fixtureId(`account:${alias}`));
      assert.deepEqual(user, {
        display_name: EXPECTED_IDENTITIES[alias].displayName,
        email_normalized: EXPECTED_IDENTITIES[alias].email,
      });
      assert.equal(fixtureEmail(alias), EXPECTED_IDENTITIES[alias].email);
    }
    const credentials = database.prepare(`
      SELECT password_hash
      FROM user_credentials
      ORDER BY user_id
    `).all();
    assert.equal(credentials.length, ACCOUNT_ALIASES.length);
    assert.equal(
      new Set(credentials.map(({ password_hash: passwordHash }) => passwordHash)).size,
      1
    );
    const passwordHasher = createScryptPasswordHasher({
      secureRandom: { bytes: (length) => Buffer.alloc(length, 0) },
      validatePassword: assertReleaseQaPassword,
    });
    assert.deepEqual(
      await passwordHasher.verify(FIXTURE_PASSWORD, credentials[0].password_hash),
      { verified: true, needsRehash: false }
    );
  } finally {
    database.close();
  }
});

test("release-QA fixture uses and verifies retained provider-backed NHL identities", (t) => {
  const root = temporaryRoot(t);
  const databasePath = path.join(root, "provider-release-qa.sqlite3");
  const connection = openDatabase({ databasePath, environment: "test" });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "provider-release-qa-test",
    now: () => FIXTURE_NOW_MS,
  });
  const insertPlayer = connection.database.prepare(`
    INSERT INTO players (
      id, first_name, last_name, full_name, birth_date, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, '1998-01-01', 'active', ?, ?, 1)
  `);
  const insertExternal = connection.database.prepare(`
    INSERT INTO player_external_ids (
      id, player_id, provider, external_value, created_at_ms
    ) VALUES (?, ?, 'sportsdataio-discovery-lab', ?, ?)
  `);
  const insertSource = connection.database.prepare(`
    INSERT INTO player_source_state (
      id, player_id, provider, source_position, normalized_position,
      nhl_team_abbreviation, active, source_version, source_payload_json,
      effective_at_ms, ended_at_ms, created_at_ms
    ) VALUES (
      ?, ?, 'sportsdataio-discovery-lab', ?, ?, 'VAN', 1,
      '2026REG', NULL, ?, NULL, ?
    )
  `);
  for (let index = 0; index < 60; index += 1) {
    const position = index < 40 ? "F" : "D";
    const playerId = providerUuid(10_000 + index);
    const firstName = "NHL";
    const lastName = `${position === "F" ? "Forward" : "Defence"} ${String(
      index + 1
    ).padStart(2, "0")}`;
    insertPlayer.run(
      playerId,
      firstName,
      lastName,
      `${firstName} ${lastName}`,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    insertExternal.run(
      providerUuid(20_000 + index),
      playerId,
      `provider-${index + 1}`,
      FIXTURE_NOW_MS
    );
    insertSource.run(
      providerUuid(30_000 + index),
      playerId,
      position === "F" ? "C" : "D",
      position,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
  }
  connection.database.transaction(() => {
    seedFixture(connection.database, "provider-fixture-password-hash");
  }).immediate();
  connection.database.close();

  const manifest = verifyReleaseQaFixture({ databasePath });
  assert.equal(manifest.global.playerCount, PLAYER_BLUEPRINTS.length);
  const database = openReadonlyDatabase({ databasePath });
  try {
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM player_external_ids WHERE provider='release_qa'"
        )
        .get().count,
      0
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(DISTINCT players.id) AS count
          FROM players
          JOIN league_player_positions
            ON league_player_positions.player_id=players.id
          WHERE players.full_name LIKE 'Fixture Player %'
        `)
        .get().count,
      0
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(DISTINCT player_id) AS count FROM league_player_positions"
        )
        .get().count,
      PLAYER_BLUEPRINTS.length
    );
  } finally {
    database.close();
  }
});

test("release-QA verifier fails closed when a required scenario is missing", async (t) => {
  const root = temporaryRoot(t);
  const databasePath = path.join(root, "tamper-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: FIXTURE_PASSWORD,
    temporaryRoot: root,
  });
  const connection = openDatabase({ databasePath, environment: "test" });
  try {
    connection.database.prepare(
      "DELETE FROM outbox_events WHERE league_id=?"
    ).run(fixtureId("league:leagueA"));
  } finally {
    connection.database.close();
  }
  assert.throws(
    () => verifyReleaseQaFixture({ databasePath }),
    (error) => error instanceof ReleaseQaFixtureVerificationError &&
      error.code === "RELEASE_QA_FIXTURE_MISMATCH"
  );
});

test("release-QA command requires exact arguments and keeps the password out of output", async () => {
  assert.deepEqual(
    parseArguments(["--database", "C:\\Temp\\x.sqlite3", "--temporary-root", "C:\\Temp"]),
    { databasePath: "C:\\Temp\\x.sqlite3", temporaryRoot: "C:\\Temp" }
  );
  assert.throws(
    () => parseArguments(["--database", "x"]),
    ReleaseQaFixtureArgumentError
  );
  const messages = [];
  await assert.rejects(
    runReleaseQaFixtureCommand({
      argv: ["--database", "x", "--temporary-root", "y"],
      env: {},
      createFixture: async () => assert.fail("fixture must not run"),
      output: { log: (value) => messages.push(value) },
    }),
    ReleaseQaFixtureArgumentError
  );
  const manifest = { fixtureBuildId: "safe", manifestChecksum: "a".repeat(64) };
  await runReleaseQaFixtureCommand({
    argv: ["--database", "x", "--temporary-root", "y"],
    env: { M7_RELEASE_QA_PASSWORD: FIXTURE_PASSWORD },
    createFixture: async (options) => {
      assert.equal(options.password, FIXTURE_PASSWORD);
      return { databasePath: "x", manifest };
    },
    output: { log: (value) => messages.push(value) },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0], JSON.stringify(manifest));
  assert.equal(messages[0].includes(FIXTURE_PASSWORD), false);
});
