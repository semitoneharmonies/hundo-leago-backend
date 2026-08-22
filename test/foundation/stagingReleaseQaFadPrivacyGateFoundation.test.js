"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  createTargetRuntime,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  createLeagueOutboxPublicationService,
} = require(
  "../../src/application/services/activity/createLeagueOutboxPublicationService"
);
const {
  REQUIRED_HOLD_VALUES,
} = require(
  "../../src/config/loadStagingMaintenanceHoldConfig"
);
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  createSqliteLeagueOutboxRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository"
);
const {
  createReleaseQaRuntime,
} = require("../../src/operations/release/createReleaseQaRuntime");
const {
  createFreeAgentDraftBrowserFixture,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  ERROR_CODES,
  FIXTURE_NAME,
  SIDE_CAR_IDS,
  prepareReleaseQaFadPrivacyGate,
} = require(
  "../../src/operations/release/prepareReleaseQaFadPrivacyGate"
);
const {
  DEFAULT_CONTRACT: STRICT_RESTORE_CONTRACT,
} = require(
  "../../src/operations/release/materializeReleaseQaStrictRestore"
);
const {
  PHASES: STRICT_OUTBOX_PHASES,
  createReleaseQaStrictManagerOutboxService,
} = require(
  "../../src/operations/release/publishReleaseQaStrictManagerOutbox"
);
const {
  COMMAND_ERROR_CODES,
  confirmationFor,
  parseArguments,
  runReleaseQaFadPrivacyGateCommand,
} = require(
  "../../scripts/prepare-release-qa-fad-privacy-gate"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const OPERATION_ID = "HL-20260821-3";
const NOW_MS = Date.parse("2026-08-21T18:00:00.000Z");

function seedRealPlayerCatalog(database) {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIRECTORY, "players.json"), "utf8")
  );
  const selected = [
    ...catalog.filter(
      ({ active, position }) => active === true && position === "F"
    ).slice(0, 500),
    ...catalog.filter(
      ({ active, position }) => active === true && position === "D"
    ).slice(0, 300),
  ];
  let idCounter = 0;
  const repository = createSqlitePlayerCatalogRepository({
    database,
    createId: () =>
      `30000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    now: () => 1_700_000_000_100,
  });
  repository.applyCatalog({
    sourceOperationId: "20000000-0000-4000-8000-000000000001",
    provider: "sportsdataio-discovery-lab",
    capturedAtMs: 1_700_000_000_000,
    rows: selected.map((player) => ({
      providerPlayerId: String(player.id),
      firstName: player.firstName,
      lastName: player.lastName,
      fullName: player.fullName,
      birthDate: player.birthDate,
      status: "active",
      sourcePosition: player.position,
      normalizedPosition: player.position,
      nhlTeamAbbreviation: player.teamAbbrev ?? null,
      active: true,
      sourceVersion: "players-json-2026",
      sourceUpdatedAtMs: 1_700_000_000_000,
    })),
  });
}

async function stagedRuntime(t) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: "http://127.0.0.1:5173",
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: "hundo",
    port: 0,
  });
  t.after(() => started.close());
  seedRealPlayerCatalog(started.runtime.database);
  await createFreeAgentDraftBrowserFixture({ runtime: started.runtime });
  return started.runtime;
}

async function prepare(runtime, overrides = {}) {
  return prepareReleaseQaFadPrivacyGate({
    runtime,
    operationId: OPERATION_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    databaseId: FIXTURE_DATABASE_ID,
    schemaVersion: 54,
    nowMs: NOW_MS,
    assertBinding() {},
    ...overrides,
  });
}

function commandTarget(runtime) {
  return Object.freeze({
    databasePath: runtime.databasePath,
    persistentRoot: path.dirname(runtime.databasePath),
  });
}

function commandArguments(target, overrides = {}) {
  const values = {
    databasePath: target.databasePath,
    persistentRoot: target.persistentRoot,
    releaseId: OPERATION_ID,
    confirmation: confirmationFor({ releaseId: OPERATION_ID }),
    ...overrides,
  };
  return [
    "--database",
    values.databasePath,
    "--environment",
    "staging",
    "--persistent-root",
    values.persistentRoot,
    "--release-id",
    values.releaseId,
    "--confirmation",
    values.confirmation,
  ];
}

function heldEnvironment(target, overrides = {}) {
  return {
    ...REQUIRED_HOLD_VALUES,
    APP_BUILD_ID: "m7-strict-fad-gate-test",
    APP_ENVIRONMENT_ID: FIXTURE_ENVIRONMENT_ID,
    ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(32, 0x61).toString("base64url"),
    AUDIT_METADATA_SECRET:
      "strict-gate-audit-metadata-key-value-2026",
    DATABASE_ID: FIXTURE_DATABASE_ID,
    DATABASE_PATH: target.databasePath,
    FRONTEND_ORIGINS: "https://staging.hundo.test",
    LOG_LEVEL: "error",
    PERSISTENT_DATA_ROOT: target.persistentRoot,
    PORT: "10000",
    PUBLIC_FRONTEND_ORIGIN: "https://staging.hundo.test",
    RATE_LIMIT_KEY_SECRET:
      "strict-gate-rate-limit-key-value-2026",
    SESSION_COOKIE_SAME_SITE: "lax",
    STAGING_MAINTENANCE_HOLD: "true",
    ...overrides,
  };
}

function clockedRuntime(runtime, leagueInvalidationPublisher) {
  const securityFoundations = createSecurityFoundations({
    loadConfig: () => runtime.securityConfig,
    now: () => NOW_MS,
    loggerSink() {},
  });
  return Object.freeze({
    ...createTargetRuntime({
      database: runtime.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      securityFoundations,
      currentSeason: Object.freeze({
        label: "2026",
        nhlSeasonKey: "20262027",
      }),
      leagueWriteMode: "open",
      freeAgentDraftRoutesEnabled: true,
      leagueInvalidationPublisher,
      networkSourceResolver() {
        return "127.0.0.1";
      },
    }),
    database: runtime.database,
  });
}

function strictOutboxBinding(runtime, databasePath) {
  const contract = Object.freeze({
    ...STRICT_RESTORE_CONTRACT,
    sourceDatabasePath: databasePath,
    persistentRoot: path.dirname(databasePath),
  });
  const config = Object.freeze({
    accountEmailDeliveryEnabled: false,
    appEnv: "staging",
    backupScheduleEnabled: false,
    buildId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentSeason: Object.freeze({
      label: "2026",
      nhlSeasonKey: "20262027",
    }),
    databaseId: FIXTURE_DATABASE_ID,
    databasePath,
    debugRoutesEnabled: false,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    frontendBuildId: STRICT_RESTORE_CONTRACT.frontendBuildId,
    freeAgentDraftRoutesEnabled: true,
    leagueWriteMode: "open",
    persistentRoot: path.dirname(databasePath),
    scheduledJobsEnabled: false,
    security: runtime.securityConfig,
    sportsDataIoLiveNhl: Object.freeze({
      mode: "disabled",
      enabled: false,
      verified: false,
    }),
    sportsDataIoNhl: Object.freeze({ enabled: false }),
    sportsDataIoNhlImportFieldsAbsent: true,
    stagingMaintenanceHoldEnabled: false,
  });
  return Object.freeze({ config, contract });
}

function strictOutboxInput(config, phase) {
  return Object.freeze({
    backendBuildId: config.buildId,
    confirmation: STRICT_OUTBOX_PHASES[phase].confirmation,
    phase,
    releaseId: OPERATION_ID,
  });
}

function authenticate(runtime, alias) {
  const userId = fixtureId(`account:${alias}`);
  const issued = runtime.services.sessionService.issueForUser({ userId });
  const authenticated = runtime.services.sessionService
    .resolveWithoutActivity(issued.rawSessionToken);
  assert.equal(authenticated.valid, true);
  return authenticated;
}

function privacyProjection(runtime, authenticated, fadId) {
  const read = runtime.services.league.freeAgentDraftRead;
  const summaries = read.publishedCardSummaries({
    authenticated,
    leagueId: SIDE_CAR_IDS.leagueId,
    fadId,
    query: { cursor: null, limit: 50 },
  });
  const byTeam = new Map(
    summaries.data.map((summary) => [summary.teamId, summary])
  );
  const result = {};
  for (let index = 0; index < SIDE_CAR_IDS.teamIds.length; index += 1) {
    const teamId = SIDE_CAR_IDS.teamIds[index];
    const history = read.publishedCardHistory({
      authenticated,
      leagueId: SIDE_CAR_IDS.leagueId,
      fadId,
      teamId,
    }).results;
    const allocation = read.allocationResults({
      authenticated,
      leagueId: SIDE_CAR_IDS.leagueId,
      fadId,
      query: {
        cursor: null,
        limit: 50,
        q: "",
        status: "tied",
        teamId,
      },
    }).data;
    assert.deepEqual(history, allocation);
    assert.equal(byTeam.get(teamId).outcomeCounts.tied, index < 2 ? 1 : 0);
    if (index >= 2) assert.deepEqual(allocation, []);
    result[teamId] = allocation[0] || null;
  }
  assert.equal(summaries.data.length, 4);
  return Object.freeze(result);
}

function assertPrivate(row, visible) {
  assert.notEqual(row, null);
  assert.equal(row.status, "tied");
  if (visible) {
    assert.notEqual(row.offer, null);
    assert.equal(typeof row.tieAuctionId, "string");
  } else {
    assert.equal(row.offer, null);
    assert.equal(row.tieAuctionId, null);
  }
}

test(
  "strict held FAD privacy gate creates the Team1/Team2 target, replays without writes, and proves queued hosted cache-publication prerequisites",
  async (t) => {
    const runtime = await stagedRuntime(t);
    const gammaLeagueId = require(
      "../../src/operations/release/releaseQaFixtureContract"
    ).fixtureId("fad-browser-v4:league:gamma");
    const gammaBefore = runtime.database.prepare(`
      SELECT * FROM free_agent_drafts WHERE league_id = ?
    `).all(gammaLeagueId);

    const first = await prepare(runtime);
    assert.equal(first.code, "RELEASE_QA_FAD_PRIVACY_GATE_PREPARED");
    assert.equal(first.fixtureName, FIXTURE_NAME);
    assert.equal(first.leagueId, SIDE_CAR_IDS.leagueId);
    assert.equal(first.activeTeamIds.length, 4);
    assert.equal(first.selectedTeamIds.length, 2);
    assert.equal(first.activeTeamCount, 4);
    assert.equal(first.selectedTeamCount, 2);
    assert.equal(first.tiedPlayerCount, 1);
    assert.equal(first.restrictedParticipantCount, 2);
    assert.equal(typeof first.restrictedAuctionId, "string");
    assert.deepEqual(
      first.initialTeamManagers.map(({ managerAlias }) => managerAlias),
      ["managerA", "managerB", "managerA", "managerB"]
    );
    assert.deepEqual(first.requiredHostedTransferSmoke, {
      team1: "managerA-to-managerB-to-managerA",
      team2ManagerRemains: "managerB",
    });
    assert.equal(Object.hasOwn(first, "transferSmoke"), false);
    assert.equal(first.replayed, false);
    assert.equal(first.databaseWriteCount, 744);
    assert.equal(first.insertedRowCounts.teams, 4);
    assert.equal(first.insertedRowCounts.team_manager_assignments, 4);
    assert.equal(first.insertedRowCounts.free_agent_draft_auction_participants, 2);
    assert.equal(first.insertedRowCounts.matchup_weeks, 32);
    assert.equal(first.insertedRowCounts.matchups, 64);
    assert.equal(first.insertedRowCounts.job_runs, 203);
    assert.equal(first.actionableUntilMs - NOW_MS >= 4 * 60 * 60 * 1_000, true);
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT id, name, status
        FROM leagues WHERE id = ?
      `).get(SIDE_CAR_IDS.leagueId),
      {
        id: SIDE_CAR_IDS.leagueId,
        name: FIXTURE_NAME,
        status: "active",
      }
    );
    assert.deepEqual(
      runtime.database.prepare(`
        SELECT * FROM free_agent_drafts WHERE league_id = ?
      `).all(gammaLeagueId),
      gammaBefore
    );

    const totalChangesBeforeReplay = runtime.database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    const replay = await prepare(runtime);
    assert.equal(replay.replayed, true);
    assert.equal(replay.databaseWriteCount, 0);
    assert.deepEqual(replay.insertedRowCounts, first.insertedRowCounts);
    assert.equal(
      runtime.database.prepare("SELECT total_changes() AS count").get().count,
      totalChangesBeforeReplay
    );
    assert.equal(replay.fixtureFingerprint, first.fixtureFingerprint);
    assert.deepEqual(runtime.database.pragma("foreign_key_check"), []);
    assert.equal(
      runtime.database.pragma("integrity_check", { simple: true }),
      "ok"
    );

    const target = commandTarget(runtime);
    const logs = [];
    let writerOptions;
    const commandReplay = await runReleaseQaFadPrivacyGateCommand({
      argv: commandArguments(target),
      env: heldEnvironment(target),
      output: { log(value) { logs.push(value); } },
      now: () => NOW_MS,
      openDatabaseFunction(options) {
        writerOptions = options;
        return { database: runtime.database };
      },
    });
    assert.equal(commandReplay.replayed, true);
    assert.equal(commandReplay.databaseWriteCount, 0);
    assert.deepEqual(writerOptions, {
      databasePath: target.databasePath,
      environment: "staging",
      persistentRoot: target.persistentRoot,
      requirePersistentRoot: true,
    });
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), commandReplay);

    const reopened = openDatabase({
      databasePath: target.databasePath,
      environment: "test",
    });
    t.after(() => {
      if (reopened.database.open) reopened.database.close();
    });
    const emitted = [];
    const live = clockedRuntime(
      {
        database: reopened.database,
        securityConfig: runtime.securityConfig,
      },
      Object.freeze({
        async publish(event) {
          emitted.push(event);
          return Object.freeze({ delivered: true, roomCount: 1 });
        },
      })
    );
    const administrator = authenticate(live, "platformAdmin");
    const commissioner = authenticate(live, "leagueACommissioner");
    const managerA = authenticate(live, "leagueAManagerOne");
    const managerB = authenticate(live, "leagueAManagerTwo");
    const strictBinding = strictOutboxBinding(live, target.databasePath);
    const strictPublisher = createReleaseQaStrictManagerOutboxService({
      database: live.database,
      config: strictBinding.config,
      migrationState: live.migrationState,
      outboxPublicationService: live.services.league.outboxPublication,
      contract: strictBinding.contract,
    });
    const initial = {
      administrator: privacyProjection(live, administrator, first.fadId),
      commissioner: privacyProjection(live, commissioner, first.fadId),
      managerA: privacyProjection(live, managerA, first.fadId),
      managerB: privacyProjection(live, managerB, first.fadId),
    };
    assertPrivate(initial.administrator[SIDE_CAR_IDS.teamIds[0]], false);
    assertPrivate(initial.administrator[SIDE_CAR_IDS.teamIds[1]], false);
    assertPrivate(initial.commissioner[SIDE_CAR_IDS.teamIds[0]], false);
    assertPrivate(initial.commissioner[SIDE_CAR_IDS.teamIds[1]], false);
    assertPrivate(initial.managerA[SIDE_CAR_IDS.teamIds[0]], true);
    assertPrivate(initial.managerA[SIDE_CAR_IDS.teamIds[1]], false);
    assertPrivate(initial.managerB[SIDE_CAR_IDS.teamIds[0]], false);
    assertPrivate(initial.managerB[SIDE_CAR_IDS.teamIds[1]], true);

    const beforeWrongState = live.database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    for (const wrongCaller of [administrator, commissioner, managerA]) {
      await assert.rejects(
        strictPublisher.publish({
          input: strictOutboxInput(
            strictBinding.config,
            "team1-to-manager-b"
          ),
          idempotencyKey:
            STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
          authenticated: wrongCaller,
        }),
        (error) =>
          error.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_DENIED"
      );
    }
    await assert.rejects(
      strictPublisher.publish({
        input: strictOutboxInput(
          strictBinding.config,
          "team1-to-manager-b"
        ),
        idempotencyKey:
          STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
        authenticated: managerB,
      }),
      (error) =>
        error.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_STATE_CHANGED"
    );
    assert.equal(
      live.database.prepare("SELECT total_changes() AS count").get().count,
      beforeWrongState
    );
    assert.equal(emitted.length, 0);

    const teamTwoAssignmentBefore = live.database.prepare(`
      SELECT id, user_id
      FROM team_manager_assignments
      WHERE league_id = ? AND team_id = ? AND status = 'accepted'
    `).get(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[1]);
    const service = live.services.league.teamManagerAssignment;
    const toB = service.propose({
      leagueId: SIDE_CAR_IDS.leagueId,
      teamId: SIDE_CAR_IDS.teamIds[0],
      input: { userId: fixtureId("account:leagueAManagerTwo") },
      idempotencyKey: "HL-20260821-3-team1-to-b-propose",
      authenticated: administrator,
    });
    service.accept({
      assignmentId: toB.assignment.id,
      input: {},
      idempotencyKey: "HL-20260821-3-team1-to-b-accept",
      authenticated: managerB,
    });

    const baseOutboxRepository = createSqliteLeagueOutboxRepository({
      database: live.database,
    });
    const unrelatedCandidate = live.database.prepare(`
      SELECT id, league_id, version
      FROM outbox_events
      WHERE league_id = ? AND aggregate_type <> 'team_manager_assignment'
      ORDER BY created_at_ms, id
      LIMIT 1
    `).get(SIDE_CAR_IDS.leagueId);
    live.database.exec("SAVEPOINT unrelated_publishing_precondition");
    assert.equal(
      baseOutboxRepository.claim({
        eventId: unrelatedCandidate.id,
        leagueId: unrelatedCandidate.league_id,
        expectedVersion: unrelatedCandidate.version,
        nowMs: NOW_MS,
      }).status,
      "publishing"
    );
    const changesWithUnrelatedPublishing = live.database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    await assert.rejects(
      strictPublisher.publish({
        input: strictOutboxInput(
          strictBinding.config,
          "team1-to-manager-b"
        ),
        idempotencyKey:
          STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
        authenticated: managerB,
      }),
      (error) =>
        error.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_STATE_CHANGED"
    );
    assert.equal(emitted.length, 0);
    assert.equal(
      live.database.prepare("SELECT total_changes() AS count").get().count,
      changesWithUnrelatedPublishing
    );
    live.database.exec(
      "ROLLBACK TO unrelated_publishing_precondition; " +
        "RELEASE unrelated_publishing_precondition"
    );

    live.database.exec("SAVEPOINT injected_mark_published_failure");
    const failureEmissions = [];
    const markFailurePublication =
      createLeagueOutboxPublicationService({
        repository: Object.freeze({
          ...baseOutboxRepository,
          markPublished() {
            const error = new Error("injected mark-published failure");
            error.code = "PERSISTENCE_WRITE_FAILED";
            throw error;
          },
        }),
        publisher: Object.freeze({
          async publish(event) {
            failureEmissions.push(event);
          },
        }),
        clock: Object.freeze({ nowMs: () => NOW_MS }),
      });
    const markFailureStrictPublisher =
      createReleaseQaStrictManagerOutboxService({
        database: live.database,
        config: strictBinding.config,
        migrationState: live.migrationState,
        outboxPublicationService: markFailurePublication,
        contract: strictBinding.contract,
      });
    await assert.rejects(
      markFailureStrictPublisher.publish({
        input: strictOutboxInput(
          strictBinding.config,
          "team1-to-manager-b"
        ),
        idempotencyKey:
          STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
        authenticated: managerB,
      }),
      (error) =>
        error.code ===
        "RELEASE_QA_STRICT_MANAGER_OUTBOX_PUBLICATION_FAILED"
    );
    assert.equal(failureEmissions.length, 1);
    assert.deepEqual(
      live.database.prepare(`
        SELECT status, attempt_count, last_error_code, version
        FROM outbox_events
        WHERE league_id = ? AND aggregate_id = ?
      `).get(SIDE_CAR_IDS.leagueId, toB.assignment.id),
      {
        status: "failed",
        attempt_count: 1,
        last_error_code: "PERSISTENCE_WRITE_FAILED",
        version: 3,
      }
    );
    await assert.rejects(
      markFailureStrictPublisher.publish({
        input: strictOutboxInput(
          strictBinding.config,
          "team1-to-manager-b"
        ),
        idempotencyKey:
          STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
        authenticated: managerB,
      }),
      (error) =>
        error.code === "RELEASE_QA_STRICT_MANAGER_OUTBOX_STATE_CHANGED"
    );
    assert.equal(failureEmissions.length, 1);
    // Test-only rollback restores the pending row. The hosted seam has no
    // retry/recovery path after this at-least-once publication window.
    live.database.exec(
      "ROLLBACK TO injected_mark_published_failure; " +
        "RELEASE injected_mark_published_failure"
    );

    const publishedToB = await strictPublisher.publish({
      input: strictOutboxInput(
        strictBinding.config,
        "team1-to-manager-b"
      ),
      idempotencyKey:
        STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
      authenticated: managerB,
    });
    assert.equal(publishedToB.replayed, false);
    assert.equal(publishedToB.databaseWriteCount, 2);
    assert.equal(publishedToB.schedulerRemainedDisabled, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].aggregateId, toB.assignment.id);
    assert.equal(emitted[0].payload.reasonCode, "manager_assignment_changed");
    const replayToB = await strictPublisher.publish({
      input: strictOutboxInput(
        strictBinding.config,
        "team1-to-manager-b"
      ),
      idempotencyKey:
        STRICT_OUTBOX_PHASES["team1-to-manager-b"].idempotencyKey,
      authenticated: managerB,
    });
    assert.equal(replayToB.replayed, true);
    assert.equal(replayToB.databaseWriteCount, 0);
    assert.equal(emitted.length, 1);
    const afterToB = {
      managerA: privacyProjection(live, managerA, first.fadId),
      managerB: privacyProjection(live, managerB, first.fadId),
    };
    assertPrivate(afterToB.managerA[SIDE_CAR_IDS.teamIds[0]], false);
    assertPrivate(afterToB.managerB[SIDE_CAR_IDS.teamIds[0]], true);
    assertPrivate(afterToB.managerB[SIDE_CAR_IDS.teamIds[1]], true);

    const toA = service.propose({
      leagueId: SIDE_CAR_IDS.leagueId,
      teamId: SIDE_CAR_IDS.teamIds[0],
      input: { userId: fixtureId("account:leagueAManagerOne") },
      idempotencyKey: "HL-20260821-3-team1-to-a-propose",
      authenticated: administrator,
    });
    service.accept({
      assignmentId: toA.assignment.id,
      input: {},
      idempotencyKey: "HL-20260821-3-team1-to-a-accept",
      authenticated: managerA,
    });
    const publishedToA = await strictPublisher.publish({
      input: strictOutboxInput(
        strictBinding.config,
        "team1-return-to-manager-a"
      ),
      idempotencyKey:
        STRICT_OUTBOX_PHASES["team1-return-to-manager-a"].idempotencyKey,
      authenticated: managerA,
    });
    assert.equal(publishedToA.replayed, false);
    assert.equal(publishedToA.databaseWriteCount, 2);
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].aggregateId, toA.assignment.id);
    const replayToA = await strictPublisher.publish({
      input: strictOutboxInput(
        strictBinding.config,
        "team1-return-to-manager-a"
      ),
      idempotencyKey:
        STRICT_OUTBOX_PHASES["team1-return-to-manager-a"].idempotencyKey,
      authenticated: managerA,
    });
    assert.equal(replayToA.replayed, true);
    assert.equal(replayToA.databaseWriteCount, 0);
    assert.equal(emitted.length, 2);
    const afterToA = {
      managerA: privacyProjection(live, managerA, first.fadId),
      managerB: privacyProjection(live, managerB, first.fadId),
    };
    assertPrivate(afterToA.managerA[SIDE_CAR_IDS.teamIds[0]], true);
    assertPrivate(afterToA.managerB[SIDE_CAR_IDS.teamIds[0]], false);
    assertPrivate(afterToA.managerB[SIDE_CAR_IDS.teamIds[1]], true);
    assert.deepEqual(
      live.database.prepare(`
        SELECT id, user_id
        FROM team_manager_assignments
        WHERE league_id = ? AND team_id = ? AND status = 'accepted'
      `).get(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[1]),
      teamTwoAssignmentBefore
    );
    const transferPublications = live.database.prepare(`
      SELECT event_type, aggregate_type, payload_json
      FROM outbox_events
      WHERE league_id = ?
        AND event_type = 'team.changed'
        AND aggregate_type = 'team_manager_assignment'
      ORDER BY created_at_ms, id
    `).all(SIDE_CAR_IDS.leagueId);
    assert.equal(transferPublications.length, 2);
    assert.equal(
      transferPublications.every(({ payload_json: payloadJson }) =>
        JSON.parse(payloadJson).reasonCode === "manager_assignment_changed"
      ),
      true
    );
    assert.equal(
      live.database.prepare(`
        SELECT COUNT(*) AS count FROM outbox_events
        WHERE league_id = ? AND status = 'pending'
      `).get(SIDE_CAR_IDS.leagueId).count,
      29
    );
    assert.deepEqual(
      live.database.prepare(`
        SELECT * FROM free_agent_drafts WHERE league_id = ?
      `).all(gammaLeagueId),
      gammaBefore
    );
    reopened.database.close();
  }
);

test("strict FAD command rejects confirmation or hold drift before opening a writer", async () => {
  const target = Object.freeze({
    databasePath: path.resolve("strict-gate.sqlite3"),
    persistentRoot: path.resolve("strict-gate-root"),
  });
  assert.deepEqual(
    parseArguments(commandArguments(target)),
    {
      databasePath: target.databasePath,
      environment: "staging",
      persistentRoot: target.persistentRoot,
      releaseId: OPERATION_ID,
      confirmation: confirmationFor({ releaseId: OPERATION_ID }),
    }
  );
  let readonlyOpened = false;
  await assert.rejects(
    runReleaseQaFadPrivacyGateCommand({
      argv: commandArguments(target),
      env: heldEnvironment(target, { LEAGUE_WRITE_MODE: "open" }),
      openReadonlyDatabaseFunction() {
        readonlyOpened = true;
      },
    }),
    (error) => error.code === COMMAND_ERROR_CODES.environmentUnsafe
  );
  assert.equal(readonlyOpened, false);
  await assert.rejects(
    runReleaseQaFadPrivacyGateCommand({
      argv: commandArguments(target, { confirmation: "wrong" }),
      env: heldEnvironment(target),
      openReadonlyDatabaseFunction() {
        readonlyOpened = true;
      },
    }),
    (error) => error.code === COMMAND_ERROR_CODES.environmentUnsafe
  );
  assert.equal(readonlyOpened, false);
});

test("strict FAD preparation rolls back every sidecar write on an injected failure", async (t) => {
  const runtime = await stagedRuntime(t);
  const before = runtime.database.prepare(`
    SELECT COUNT(*) AS count FROM leagues
  `).get().count;
  await assert.rejects(
    prepare(runtime, { schemaVersion: 53 }),
    (error) => error.code === ERROR_CODES.inputInvalid
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM leagues
    `).get().count,
    before
  );
  await assert.rejects(
    prepare(runtime, {
      failureHook(point) {
        if (point === "after-receipt") throw new Error("injected");
      },
    }),
    (error) => error.code === ERROR_CODES.failed
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM leagues
    `).get().count,
    before
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM leagues WHERE id = ?
    `).get(SIDE_CAR_IDS.leagueId).count,
    0
  );
  assert.equal(
    runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM security_audit_events WHERE league_id = ?
    `).get(SIDE_CAR_IDS.leagueId).count,
    0
  );
});
