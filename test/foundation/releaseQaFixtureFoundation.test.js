const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ReleaseQaFixtureError,
  assertSafeFixturePath,
  createReleaseQaFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  ReleaseQaFixtureVerificationError,
  verifyReleaseQaFixture,
} = require("../../src/operations/release/verifyReleaseQaFixture");
const {
  ACCOUNT_ALIASES,
  checksumManifest,
  fixtureEmail,
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");
const {
  openDatabase,
  openReadonlyDatabase,
} = require("../../src/infrastructure/database/connection");
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
  assert.equal(first.manifest.global.overlappingTeamNameCount, 6);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.teams), [6, 6]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.trades), [2, 2]);
  assert.equal(first.manifest.scenarios.twoLeagueIdentityIsolation, true);

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
      WHERE a.league_id=? AND b.league_id=? AND a.id=b.id
    `).get(leagueA, leagueB).count, 0);
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
