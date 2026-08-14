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
  selectCatalogPlayers,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
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
const REAL_CATALOG_FORWARD_COUNT = 500;
const REAL_CATALOG_DEFENCE_COUNT = 250;
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
const EMPTY_LOCKED_DECISION_EVIDENCE_TABLES = Object.freeze([
  "auction_administration_command_results",
  "free_agent_draft_readiness_corrective_requeues",
  "free_agent_draft_schedule_recovery_matchups",
  "matchup_roster_game_exclusion_sets",
  "matchup_schedule_command_results",
  "matchup_schedule_job_bindings",
  "nhl_game_state_observation_snapshots",
  "nhl_game_state_observations",
]);

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
  assert.equal(first.manifest.schemaVersion, 50);
  assert.equal(first.manifest.manifestChecksum, checksumManifest(first.manifest));
  assert.match(first.manifest.manifestChecksum, /^[0-9a-f]{64}$/);
  assert.equal(first.manifest.global.leagueCount, 2);
  assert.equal(first.manifest.global.playerCount, PLAYER_BLUEPRINTS.length);
  assert.equal(first.manifest.global.overlappingPlayerCount, PLAYER_BLUEPRINTS.length);
  assert.equal(first.manifest.global.overlappingTeamNameCount, 0);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.teams), [6, 10]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.populatedRosterTeams), [6, 10]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.syntheticPlayerTotals), [PLAYER_BLUEPRINTS.length, PLAYER_BLUEPRINTS.length]);
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.matchupPlayers), [216, 360]);
  assert.deepEqual(
    first.manifest.leagues.map(
      ({ counts }) => counts.scheduleGenerations
    ),
    [1, 1]
  );
  assert.deepEqual(first.manifest.leagues.map(({ counts }) => counts.trades), [5, 5]);
  assert.equal(first.manifest.scenarios.twoLeagueIdentityIsolation, true);
  assert.equal(first.manifest.scenarios.distinctLeagueRosters, true);
  assert.equal(
    first.manifest.scenarios.scheduleGenerationEvidence,
    true
  );

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
    for (const tableName of ["matchup_weeks", "matchups"]) {
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ${tableName}
             WHERE status IN ('live', 'correction_required')`
          )
          .get().count,
        0,
        `${tableName} maintenance-blocking status count`
      );
    }
    assert.equal(
      database
        .prepare(
          "SELECT status FROM matchup_weeks WHERE id = ?"
        )
        .get(fixtureId("matchup-week:leagueA:current")).status,
      "scheduled"
    );
    assert.equal(
      database
        .prepare("SELECT status FROM matchups WHERE id = ?")
        .get(fixtureId("matchup:leagueA:current")).status,
      "awaiting_data"
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM matchup_roster_players AS roster_player
          LEFT JOIN player_external_ids AS identity
            ON identity.player_id = roster_player.player_id
           AND identity.provider = 'sportsdataio-discovery-lab'
          WHERE identity.id IS NULL
        `)
        .get().count,
      0,
      "matchup roster SportsDataIO identity coverage"
    );
    for (const tableName of EMPTY_LOCKED_DECISION_EVIDENCE_TABLES) {
      assert.equal(
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
          .get().count,
        0,
        `${tableName} release-QA fixture count`
      );
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teams WHERE league_id=?").get(leagueA).count, 6);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM teams WHERE league_id=?").get(leagueB).count, 10);
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
        fixtureId("team:leagueB:1")
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
    const acceptedEvent = database.prepare(`
      SELECT id, actor_user_id, metadata_json, occurred_at_ms
      FROM trade_events
      WHERE league_id=? AND trade_id=? AND event_type='proposal_accepted'
    `).get(leagueA, completedTradeId);
    assert.equal(
      acceptedEvent.id,
      completedTrade.commissioner_completion_reference
    );
    assert.equal(
      acceptedEvent.actor_user_id,
      fixtureId("account:leagueACommissioner")
    );
    assert.equal(acceptedEvent.occurred_at_ms, completedTrade.completed_at_ms);
    const acceptedMetadata = JSON.parse(acceptedEvent.metadata_json);
    assert.equal(acceptedMetadata.actorAuthority, "commissioner");
    assert.equal(acceptedMetadata.generallyIllegal, false);
    assert.equal(acceptedMetadata.ownershipTransfers.length, 2);
    assert.deepEqual(acceptedMetadata.automaticallyCancelledTradeIds, []);
    assert.equal(
      acceptedMetadata.transfers.some((transfer) =>
        Object.hasOwn(transfer, "sourceOwnershipId") ||
        Object.hasOwn(transfer, "destinationOwnershipId")
      ),
      false
    );
    assert.deepEqual(
      acceptedMetadata.ownershipTransfers.map(
        ({ sourceOwnershipId }) => sourceOwnershipId
      ),
      acceptedMetadata.ownershipTransfers.map(
        ({ sourceOwnershipId }) => sourceOwnershipId
      ).sort()
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM ownership_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer_out'
    `).get(leagueA, completedTradeId).count, 2);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM ownership_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer_in'
    `).get(leagueA, completedTradeId).count, 2);
    const ownershipEvents = database.prepare(`
      SELECT event_type, ownership_id, player_id, team_id,
        actor_user_id, source_type, source_id, before_metadata_json,
        after_metadata_json, reason, occurred_at_ms
      FROM ownership_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type IN ('trade_transfer_out', 'trade_transfer_in')
    `).all(leagueA, completedTradeId);
    for (const transfer of acceptedMetadata.ownershipTransfers) {
      const sourceEvent = ownershipEvents.find(
        (event) => event.event_type === "trade_transfer_out" &&
          event.ownership_id === transfer.sourceOwnershipId
      );
      const destinationEvent = ownershipEvents.find(
        (event) => event.event_type === "trade_transfer_in" &&
          event.ownership_id === transfer.destinationOwnershipId
      );
      assert.equal(Boolean(sourceEvent), true);
      assert.equal(Boolean(destinationEvent), true);
      assert.equal(sourceEvent.player_id, destinationEvent.player_id);
      assert.equal(sourceEvent.team_id, transfer.sourceTeamId);
      assert.equal(destinationEvent.team_id, transfer.destinationTeamId);
      assert.equal(
        sourceEvent.actor_user_id,
        fixtureId("account:leagueACommissioner")
      );
      assert.equal(destinationEvent.actor_user_id, sourceEvent.actor_user_id);
      assert.equal(sourceEvent.source_type, "trade");
      assert.equal(sourceEvent.source_id, completedTradeId);
      assert.equal(destinationEvent.source_id, completedTradeId);
      assert.equal(sourceEvent.reason, null);
      assert.equal(destinationEvent.reason, null);
      assert.equal(sourceEvent.occurred_at_ms, completedTrade.completed_at_ms);
      assert.equal(destinationEvent.occurred_at_ms, sourceEvent.occurred_at_ms);

      const sourceBefore = JSON.parse(sourceEvent.before_metadata_json);
      const sourceAfter = JSON.parse(sourceEvent.after_metadata_json);
      const destinationBefore = JSON.parse(
        destinationEvent.before_metadata_json
      );
      const destinationAfter = JSON.parse(
        destinationEvent.after_metadata_json
      );
      assert.equal(sourceBefore.schemaVersion, 2);
      assert.equal(sourceBefore.exists, true);
      assert.equal(sourceBefore.ownership.id, transfer.sourceOwnershipId);
      assert.equal(sourceBefore.ownership.playerId, sourceEvent.player_id);
      assert.equal(sourceBefore.ownership.teamId, transfer.sourceTeamId);
      assert.equal(
        sourceBefore.ownership.version,
        transfer.sourceOwnershipVersion
      );
      assert.deepEqual(sourceAfter, {
        schemaVersion: 2,
        exists: false,
        destinationOwnershipId: transfer.destinationOwnershipId,
      });
      assert.deepEqual(destinationBefore, {
        schemaVersion: 2,
        exists: false,
        sourceOwnershipId: transfer.sourceOwnershipId,
      });
      assert.deepEqual(destinationAfter, {
        schemaVersion: 2,
        exists: true,
        ownership: {
          ...sourceBefore.ownership,
          id: transfer.destinationOwnershipId,
          teamId: transfer.destinationTeamId,
          slotNumber: null,
          version: 1,
        },
      });
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM player_ownerships
          WHERE league_id=? AND id=?
        `).get(leagueA, transfer.sourceOwnershipId).count,
        0
      );
      assert.deepEqual(database.prepare(`
        SELECT player_id, team_id, acquired_transaction_type,
          acquired_transaction_id, version, trade_blocked
        FROM player_ownerships
        WHERE league_id=? AND id=?
      `).get(leagueA, transfer.destinationOwnershipId), {
        player_id: destinationEvent.player_id,
        team_id: transfer.destinationTeamId,
        acquired_transaction_type: "trade_execution",
        acquired_transaction_id: completedTradeId,
        version: 1,
        trade_blocked: 0,
      });
    }
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM contract_events
      WHERE league_id=? AND source_type='trade' AND source_id=?
        AND event_type='trade_transfer'
    `).get(leagueA, completedTradeId).count, 2);
    const completionActivity = database.prepare(`
      SELECT actor_user_id, actor_authority, team_id, metadata_json,
        occurred_at_ms
      FROM league_activity
      WHERE league_id=? AND related_type='trade' AND related_id=?
        AND event_type='trade_completed'
    `).get(leagueA, completedTradeId);
    assert.equal(
      completionActivity.actor_user_id,
      fixtureId("account:leagueACommissioner")
    );
    assert.equal(completionActivity.actor_authority, "commissioner");
    assert.equal(completionActivity.team_id, null);
    assert.equal(
      completionActivity.occurred_at_ms,
      completedTrade.completed_at_ms
    );
    assert.equal(
      JSON.parse(completionActivity.metadata_json)
        .commissionerCompletionReference,
      acceptedEvent.id
    );
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
      providers: [
        "sportsdataio-discovery-lab",
        "release_qa_fixture",
      ],
      nowMs: FIXTURE_NOW_MS,
    });
    assert.equal(liveScore.status, "awaiting_data");
    assert.equal(liveScore.home.scoreHundredths > 0, true);
    assert.equal(liveScore.away.scoreHundredths > 0, true);
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

test("release-QA fixture uses and verifies retained provider-backed NHL identities", async (t) => {
  const root = temporaryRoot(t);
  const sourceDatabasePath = path.join(root, "provider-catalog.sqlite3");
  const databasePath = path.join(root, "provider-release-qa.sqlite3");
  const catalog = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "..", "..", "players.json"),
      "utf8"
    )
  );
  const selected = [
    ...catalog.filter(
      ({ active, position }) =>
        active === true && position === "F"
    ).slice(0, REAL_CATALOG_FORWARD_COUNT),
    ...catalog.filter(
      ({ active, position }) =>
        active === true && position === "D"
    ).slice(0, REAL_CATALOG_DEFENCE_COUNT),
  ];
  assert.equal(
    selected.length,
    REAL_CATALOG_FORWARD_COUNT + REAL_CATALOG_DEFENCE_COUNT
  );
  const connection = openDatabase({
    databasePath: sourceDatabasePath,
    environment: "test",
  });
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
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1)
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
      ?, ?, 'sportsdataio-discovery-lab', ?, ?, ?, ?,
      '2026REG', NULL, ?, NULL, ?
    )
  `);
  for (const [index, player] of selected.entries()) {
    const playerId = providerUuid(10_000 + index);
    insertPlayer.run(
      playerId,
      player.firstName,
      player.lastName,
      player.fullName,
      player.birthDate,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    insertExternal.run(
      providerUuid(20_000 + index),
      playerId,
      String(player.id),
      FIXTURE_NOW_MS
    );
    insertSource.run(
      providerUuid(30_000 + index),
      playerId,
      player.position,
      player.position,
      player.teamAbbrev ?? null,
      1,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
  }
  connection.database.close();

  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: FIXTURE_PASSWORD,
    providerCatalogSourceDatabasePath: sourceDatabasePath,
    temporaryRoot: root,
  });
  const providerFixture = openDatabase({
    databasePath,
    environment: "test",
  });
  const fadPlayers = selectCatalogPlayers(providerFixture.database);
  const retainedNames = new Set(
    selected.map(({ fullName }) => fullName)
  );
  assert.equal(
    Object.values(fadPlayers).every(({ fullName }) =>
      retainedNames.has(fullName) &&
      !fullName.toLowerCase().startsWith("fixture player ")
    ),
    true
  );
  providerFixture.database.close();

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
      "DELETE FROM outbox_event_audiences WHERE league_id=?"
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

test("release-QA verifier fails closed when accepted tenure history loses its commissioner actor", async (t) => {
  const root = temporaryRoot(t);
  const databasePath = path.join(root, "history-tamper-release-qa.sqlite3");
  await createReleaseQaFixture({
    databasePath,
    environment: "test",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: FIXTURE_PASSWORD,
    temporaryRoot: root,
  });
  const connection = openDatabase({ databasePath, environment: "test" });
  try {
    const result = connection.database.prepare(`
      UPDATE ownership_events
      SET actor_user_id=?
      WHERE id=(
        SELECT id
        FROM ownership_events
        WHERE league_id=? AND source_type='trade' AND source_id=?
          AND event_type='trade_transfer_out'
        ORDER BY id ASC
        LIMIT 1
      )
    `).run(
      fixtureId("account:platformAdmin"),
      fixtureId("league:leagueA"),
      fixtureId("trade-scenario:leagueA:accepted:1")
    );
    assert.equal(result.changes, 1);
  } finally {
    connection.database.close();
  }
  assert.throws(
    () => verifyReleaseQaFixture({ databasePath }),
    (error) => error instanceof ReleaseQaFixtureVerificationError &&
      error.code === "RELEASE_QA_FIXTURE_MISMATCH" &&
      error.message.includes("source history actor_user_id")
  );
});

test("release-QA command requires exact arguments and keeps the password out of output", async () => {
  assert.deepEqual(
    parseArguments(["--database", "C:\\Temp\\x.sqlite3", "--temporary-root", "C:\\Temp"]),
    { databasePath: "C:\\Temp\\x.sqlite3", temporaryRoot: "C:\\Temp" }
  );
  assert.deepEqual(
    parseArguments([
      "--database", "C:\\Temp\\x.sqlite3",
      "--temporary-root", "C:\\Temp",
      "--provider-catalog-database", "C:\\Data\\catalog.sqlite3",
    ]),
    {
      databasePath: "C:\\Temp\\x.sqlite3",
      providerCatalogSourceDatabasePath: "C:\\Data\\catalog.sqlite3",
      temporaryRoot: "C:\\Temp",
    }
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
