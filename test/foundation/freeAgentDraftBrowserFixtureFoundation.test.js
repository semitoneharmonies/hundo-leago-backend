"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BROWSER_FIXTURE_KIND,
  BROWSER_FIXTURE_SCHEMA_VERSION,
  FreeAgentDraftBrowserFixtureError,
  backfillExistingFreeAgentDraftBrowserFixturePickInventory,
  createFreeAgentDraftBrowserFixture,
  schedulesFor,
} = require(
  "../../src/operations/release/createFreeAgentDraftBrowserFixture"
);
const {
  createReleaseQaRuntime,
} = require(
  "../../src/operations/release/createReleaseQaRuntime"
);
const {
  EXPECTED_LEAGUE_IDS,
  LEGACY_FIXTURE_LEAGUES,
  assertFixtureIdentitiesDistinct,
  assertNoPriorFixture,
  assertStagingScope,
  existingFixtureState,
} = require(
  "../../scripts/create-staging-fad-test-leagues"
);
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
} = require(
  "../../src/operations/release/releaseQaFixtureContract"
);
const {
  createSqlitePlayerCatalogRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqlitePlayerCatalogRepository"
);

const ROOT_DIRECTORY = path.resolve(
  __dirname,
  "..",
  ".."
);
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "hundo";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertRecursivelyFrozen(child);
  }
}

function authenticate(runtime, userId) {
  const session =
    runtime.services.sessionService.issueForUser({
      userId,
    });
  const authenticated =
    runtime.services.sessionService.resolveWithoutActivity(
      session.rawSessionToken
    );
  assert.equal(authenticated.valid, true);
  return authenticated;
}

for (const kind of ["baseline", "lock", "finalize"]) {
  test(`restored matchup ${kind} rejects its old lease and finishes a committed transition once after worker restart`,
    t => verifyRestoredMatchupOccurrence(t, `matchup:${kind}`));
}

for (const kind of ["lock", "finalize", "rollover"]) {
  test(`restored matchup ${kind} rolls back interrupted partial batches and completes once after restart`,
    t => verifyRestoredMatchupOccurrence(t, `matchup:${kind}`, { interrupt: true }));
}

async function verifyRestoredMatchupOccurrence(t, jobType, { interrupt = false } = {}) {
  const crypto = require("node:crypto");
  const { openDatabase,openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
  const { createTargetRepositories,createTargetServices,createTargetRuntime } = require("../../src/bootstrap/createTargetRuntime");
  const { createSecureRandom } = require("../../src/infrastructure/security/createSecureRandom");
  const { createRunMatchupOccurrencesJob } = require("../../src/jobs/definitions/runMatchupOccurrences");
  const { createLiveStatisticsService } = require("../../src/application/services/statistics/createLiveStatisticsService");
  const { classifyMatchupOccurrenceExecutionGuardError } = require("../../src/infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");
  const { loadBackupConfig } = require("../../src/config/loadBackupConfig");
  const { createObjectStorageAdapter } = require("../../src/infrastructure/backups/createObjectStorageAdapter");
  const { createEncryptedOffsiteBackup } = require("../../src/operations/backups/createEncryptedOffsiteBackup");
  const { restoreEncryptedBackupToCleanPath } = require("../../src/operations/backups/restoreEncryptedBackupToCleanPath");
  const { prepareRecoveryCredentials } = require("../../src/operations/backups/prepareRecoveryCredentials");
  const { buildRecoveryReconciliationPlan } = require("../../src/operations/backups/buildRecoveryReconciliationPlan");
  const { RECOVERY_HOLD_KEY,assertRecoveryRuntimeAllowed } = require("../../src/infrastructure/database/recoveryHold");
  const { readRows,snapshots,hash } = require("../../src/operations/backups/recoveryKnownBuyoutEvidence");
  const started = await startRuntime(t), source = started.runtime.database;
  seedRealPlayerCatalog(source);
  const fixture = await createFreeAgentDraftBrowserFixture({ runtime:started.runtime });
  const league = fixture.leagues.gamma;
  assert.equal(league.phase,"completed");
  const season = source.prepare("SELECT * FROM seasons WHERE league_id=? AND id=?").get(league.leagueId,league.seasonId);
  const target = source.prepare("SELECT j.*,b.owning_matchup_week_id week_id,b.schedule_operation_id,b.schedule_version FROM job_runs j JOIN matchup_schedule_job_bindings b ON b.job_run_id=j.id " +
    "JOIN season_matchup_schedule_generations g ON g.league_id=b.league_id AND g.season_id=b.season_id AND g.schedule_operation_id=b.schedule_operation_id AND g.schedule_version=b.schedule_version AND g.status='current' " +
    "JOIN matchup_weeks w ON w.id=b.owning_matchup_week_id AND w.league_id=b.league_id " +
    "WHERE j.league_id=? AND j.season_id=? AND j.job_type=? AND j.status='pending' AND w.status='scheduled' ORDER BY j.scheduled_for_ms LIMIT 1")
    .get(league.leagueId,league.seasonId,jobType);
  assert.ok(target,"The completed real FAD must leave the requested scheduled occurrence.");
  const week=source.prepare("SELECT * FROM matchup_weeks WHERE id=? AND league_id=?").get(target.week_id,league.leagueId);
  const weekMatchups=source.prepare("SELECT * FROM matchups WHERE matchup_week_id=? AND league_id=?").all(week.id,league.leagueId);
  const matchupIds=new Set(weekMatchups.map(row=>row.id));
  const teamIds=new Set(weekMatchups.flatMap(row=>[row.home_team_id,row.away_team_id]));
  assert.equal(weekMatchups.length,7);assert.equal(teamIds.size,14);
  let nowMs = target.scheduled_for_ms+1;
  const clock = { nowMs:()=>nowMs },secureRandom = createSecureRandom();
  const securityFoundations = { config:started.runtime.securityConfig,clock,secureRandom,logger:{ info(){},warn(){},error(){} } };
  const currentSeason = { label:season.label,nhlSeasonKey:season.nhl_season_key };
  const observed = { providerCalls:0,emailCalls:0,publications:0 };
  const forbidden = kind => async () => { observed[kind]++;assert.fail("Recovery occurrence cannot invoke "+kind); };
  function compose(database) {
    // Match normal runtime composition when NHL completed-game statistics is disabled.
    // This existing fixture uses synthetic SportsDataIO data; NHL source isolation remains tested separately.
    const repositories = createTargetRepositories({ database,secureRandom,matchupProcessingLeagueIds:[league.leagueId] });
    const services = createTargetServices({ repositories,securityFoundations,currentSeason,
      leagueInvalidationPublisher:{ publish(){observed.publications++;assert.fail("Recovery occurrence cannot publish.");} },
      nhlFetchImplementation:forbidden("providerCalls"),sportsDataIoFetchImplementation:forbidden("providerCalls"),emailFetchImplementation:forbidden("emailCalls"),
      emailAdapter:{sendEmailVerification:forbidden("emailCalls"),sendAccountActionLink:forbidden("emailCalls"),sendSecurityNotification:forbidden("emailCalls")} });
    return { repositories,services };
  }
  const claimInput = { leagueId:league.leagueId,seasonId:league.seasonId,jobType:target.job_type,occurrenceKey:target.occurrence_key };
  const original = compose(source);
  async function refreshLocalStatistics(atMs) {
    nowMs=atMs;
    const players=source.prepare("SELECT external.external_value AS providerPlayerId FROM player_external_ids external JOIN players player ON player.id=external.player_id " +
      "WHERE external.provider='sportsdataio-discovery-lab' AND player.status='active' GROUP BY external.external_value ORDER BY CAST(external.external_value AS INTEGER), external.external_value")
      .all().filter(row=>/^[1-9][0-9]*$/.test(row.providerPlayerId));
    assert.ok(players.length>=700);
    // This fixture adapter supplies synthetic totals only to the original local database.
    // Restored services still use the normal composition with all external adapters denied.
    const statistics=createLiveStatisticsService({repository:original.repositories.statistics,nhlSeasonKey:season.nhl_season_key,
      providerName:"sportsdataio-live",playerIdentityProvider:"sportsdataio-discovery-lab",minimumPlayerCount:700,nowMs:()=>nowMs,createId:()=>secureRandom.id(),
      provider:{async fetchLiveSnapshot({requiredPlayers,requiredPlayerGames}) {
        assert.deepEqual(requiredPlayerGames,[],"Normal fixture locks must not require historical late-lock coverage.");
        return {provider:"sportsdataio-live",sourceVersion:`recovery-fixture-${season.nhl_season_key}-${nowMs}`,capturedAtMs:nowMs,totalsSourceUpdatedAtMs:nowMs,
          totalsRows:players.map((player,index)=>({playerId:player.providerPlayerId,gamesPlayed:1,goals:index%3,assists:index%4})),playerGameRows:[],
          playerGameCoverage:{schemaVersion:1,throughAtMs:nowMs,players:requiredPlayers.map(player=>({playerId:player.playerId,providerPlayerId:player.providerPlayerId,
            providerTeamId:null,disposition:"no_team",games:[]}))}};
      }}});
    await statistics.refresh();
  }
  async function completePrerequisite(kind) {
    const jobs=source.prepare("SELECT j.* FROM job_runs j JOIN matchup_schedule_job_bindings b ON b.job_run_id=j.id " +
      "WHERE b.owning_matchup_week_id=? AND j.league_id=? AND j.season_id=? AND j.job_type=? AND b.schedule_operation_id=? AND b.schedule_version=?")
      .all(week.id,league.leagueId,league.seasonId,kind,target.schedule_operation_id,target.schedule_version);
    assert.equal(jobs.length,1);const job=jobs[0];assert.equal(job.status,"pending");nowMs=job.scheduled_for_ms+1;
    const claim=original.repositories.matchupJobs.claim({leagueId:league.leagueId,seasonId:league.seasonId,jobType:kind,occurrenceKey:job.occurrence_key,
      nowMs,leaseOwner:"fixture-prerequisite-worker",leaseToken:crypto.randomUUID(),leaseExpiresAtMs:nowMs+60_000});
    assert.equal(claim.acquired,true,`${kind} prerequisite for the current schedule must be claimable`);
    const result=await original.services.league.matchupOccurrenceHandlers[kind](claim.occurrenceExecution,nowMs);
    original.repositories.matchupJobs.succeed({leagueId:league.leagueId,runId:job.id,leaseOwner:claim.occurrenceExecution.leaseOwner,
      leaseToken:claim.occurrenceExecution.leaseToken,expectedVersion:claim.occurrenceExecution.claimedJobVersion,completedAtMs:nowMs,result});
  }
  if(jobType!=="matchup:baseline") {
    await refreshLocalStatistics(week.baseline_at_ms);
    await completePrerequisite("matchup:baseline");
    if(jobType==="matchup:finalize" || jobType==="matchup:rollover") {
      await completePrerequisite("matchup:lock");
      await refreshLocalStatistics(week.ends_at_ms);
      if (jobType === "matchup:rollover") {
        // Rollover retries finalization from the durable Awaiting Data state.
        const finalizeJob = source.prepare("SELECT j.* FROM job_runs j JOIN matchup_schedule_job_bindings b ON b.job_run_id=j.id " +
          "WHERE b.owning_matchup_week_id=? AND j.league_id=? AND j.job_type='matchup:finalize' AND b.schedule_operation_id=?")
          .get(week.id, league.leagueId, target.schedule_operation_id);
        assert(finalizeJob); nowMs = finalizeJob.scheduled_for_ms + 1;
        const claim = original.repositories.matchupJobs.claim({ leagueId: league.leagueId, seasonId: league.seasonId,
          jobType: finalizeJob.job_type, occurrenceKey: finalizeJob.occurrence_key, nowMs,
          leaseOwner: "waiting-finalize-prerequisite", leaseToken: crypto.randomUUID(), leaseExpiresAtMs: nowMs + 60_000 });
        assert.equal(claim.acquired, true);
        original.services.league.matchupWeeks.advance({ leagueId: league.leagueId, seasonId: league.seasonId, weekId: week.id,
          operationId: crypto.randomUUID(), nowMs, occurrenceExecution: claim.occurrenceExecution });
        original.repositories.matchupJobs.fail({ leagueId: league.leagueId, runId: finalizeJob.id,
          leaseOwner: claim.occurrenceExecution.leaseOwner, leaseToken: claim.occurrenceExecution.leaseToken,
          expectedVersion: claim.occurrenceExecution.claimedJobVersion, completedAtMs: nowMs,
          nextAttemptAtMs: target.scheduled_for_ms + 60_000, errorCode: "MATCHUP_FINAL_SOURCE_WAITING" });
        assert.equal(source.prepare("SELECT status FROM matchup_weeks WHERE id=?").get(week.id).status, "awaiting_data");
      }
    }
  }
  nowMs=target.scheduled_for_ms+1;
  const oldClaim = original.repositories.matchupJobs.claim({ ...claimInput,nowMs,leaseOwner:"pre-backup-fixture-worker",
    leaseToken:crypto.randomUUID(),leaseExpiresAtMs:nowMs+60_000 });
  assert.equal(oldClaim.acquired,true);
  const encryptionKey=crypto.randomBytes(32),objects=new Map();
  const objectStorage=createObjectStorageAdapter({client:{
    async putObject({key,body,visibility}){assert.equal(visibility,"private");objects.set(key,Buffer.from(body));return {stored:true};},
    async headObject({key}){const body=objects.get(key);return body?{byteSize:body.length,sha256:hash(body)}:null;},
    async getObject({key}){return {body:Buffer.from(objects.get(key))};}
  }});
  const config=loadBackupConfig({env:{BACKUP_LOCAL_DIR:path.join(started.temporaryRoot,"matchup-backup-work"),BACKUP_OBJECT_ENDPOINT:"https://release-qa.invalid",
    BACKUP_OBJECT_REGION:"local-1",BACKUP_OBJECT_BUCKET:"hundo-release-qa",BACKUP_OBJECT_PREFIX:"m7/matchup-recovery/",BACKUP_OBJECT_ACCESS_KEY_ID:"local-release-qa",
    BACKUP_OBJECT_SECRET_ACCESS_KEY:"fixture-only",BACKUP_ENCRYPTION_KEY_VERSION:"matchup-local-v1",BACKUP_ENCRYPTION_KEY:encryptionKey.toString("base64url"),BACKUP_SCHEDULE_ENABLED:"false"},
    runtimeConfig:{appEnv:"staging",persistentRoot:started.temporaryRoot,environmentId:FIXTURE_ENVIRONMENT_ID,databaseId:FIXTURE_DATABASE_ID}});
  const backup=await createEncryptedOffsiteBackup({databasePath:started.databasePath,config,objectStorage,reason:"pre-cutover-rehearsal",
    requestedByType:"release_qa_automation",requestedById:"matchup-recovery-fixture",backendBuildId:"local-matchup-recovery",retentionClass:"incident-preservation",nowMs:()=>nowMs});
  const sourceBytes=source.serialize();
  const restored=await restoreEncryptedBackupToCleanPath({manifestObjectKey:backup.manifestObjectKey,objectStorage,keyResolver:async()=>encryptionKey,
    expectedEnvironment:config.appEnv,expectedEnvironmentId:config.environmentId,expectedDatabaseId:config.databaseId,
    targetDatabasePath:path.join(started.temporaryRoot,"matchup-restored.sqlite3"),temporaryRoot:started.temporaryRoot});
  nowMs++;
  const prepared=prepareRecoveryCredentials({restoredCandidate:restored,temporaryRoot:started.temporaryRoot,outputDirectory:path.join(started.temporaryRoot,"matchup-prepared"),
    expectedEnvironmentId:config.environmentId,expectedDatabaseId:config.databaseId,recoveryId:crypto.randomUUID(),preparedAtMs:nowMs});
  const readHash=file=>hash(fs.readFileSync(file)),protectedFiles=[restored.targetDatabasePath,prepared.preparedDatabasePath],protectedHashes=protectedFiles.map(readHash);
  const preparedReader=openReadonlyDatabase({databasePath:prepared.preparedDatabasePath});
  try {
    const plan=buildRecoveryReconciliationPlan({database:preparedReader,credentialPreparation:prepared,observedAtMs:nowMs,
      expectedEnvironmentId:config.environmentId,expectedDatabaseId:config.databaseId});
    const heldJob=plan.jobs.find(row=>row.id===target.id);assert.equal(heldJob.leaseExpired,true);assert.equal(heldJob.executionPermitted,false);
    assert.equal(heldJob.disposition,"held-awaiting-occurrence-evidence");assert.equal(plan.activationReady,false);
    assert.equal(preparedReader.prepare("SELECT total_changes() n").get().n,0);
  } finally {preparedReader.close();}
  const replayPath=path.join(started.temporaryRoot,"matchup-replay.sqlite3");fs.copyFileSync(prepared.preparedDatabasePath,replayPath,fs.constants.COPYFILE_EXCL);
  let database=openDatabase({databasePath:replayPath,environment:"test"}).database;
  try {
    let runtime=compose(database);
    const before=readRows(database),beforeSnapshots=snapshots(before),hold=before.application_metadata.find(row=>row.metadata_key===RECOVERY_HOLD_KEY);
    await t.test("the restored pre-recovery execution and completion cannot write",async()=>{
      await assert.rejects(runtime.services.league.matchupOccurrenceHandlers[jobType](oldClaim.occurrenceExecution,nowMs),
        error=>classifyMatchupOccurrenceExecutionGuardError(error)==="MATCHUP_OCCURRENCE_LEASE_LOST");
      assert.throws(()=>runtime.repositories.matchupJobs.succeed({leagueId:league.leagueId,runId:target.id,
        leaseOwner:oldClaim.occurrenceExecution.leaseOwner,leaseToken:oldClaim.occurrenceExecution.leaseToken,
        expectedVersion:oldClaim.occurrenceExecution.claimedJobVersion,completedAtMs:nowMs,result:{status:"baseline_ready"}}),{code:"REPOSITORY_VERSION_CONFLICT"});
      assert.deepEqual(snapshots(readRows(database)),beforeSnapshots);
    });
    nowMs++;
    const currentClaim=runtime.repositories.matchupJobs.claim({...claimInput,nowMs,leaseOwner:"reviewed-fixture-worker",leaseToken:crypto.randomUUID(),leaseExpiresAtMs:nowMs+100});
    assert.equal(currentClaim.acquired,true);
    if (interrupt) {
      const { spawnSync } = require("node:child_process");
      const claimed = readRows(database), claimedSnapshots = snapshots(claimed);
      const claimedBytes = database.serialize();
      const crashAtMs = nowMs;
      const faultPoints = jobType === "matchup:lock" ? [1, 7, 14] : [1, 4, 7];
      for (const mode of ["throw", "exit"]) for (const stopAfter of faultPoints) {
        await t.test(`${mode} after write ${stopAfter} leaves no partial effect and retries once`, async () => {
          const faultPath = path.join(started.temporaryRoot, `matchup-${mode}-${stopAfter}.sqlite3`);
          fs.writeFileSync(faultPath, claimedBytes, { flag: "wx" });
          const child = spawnSync(process.execPath, [path.join(__dirname, "../../scripts/fixtures/matchupInterruptedWorker.js")], {
            input: JSON.stringify({ databasePath: faultPath, mode, stopAfter, nowMs: crashAtMs,
              execution: currentClaim.occurrenceExecution, currentSeason }),
            encoding: "utf8", windowsHide: true, timeout: 60_000,
          });
          assert.ifError(child.error);
          assert.equal(child.status, mode === "exit" ? 86 : 0, child.stderr);
          const marker = JSON.parse(child.stdout.trim());
          assert.deepEqual(marker, { reached: true, mode, stopAfter, inTransaction: true });
          let faultDatabase = openDatabase({ databasePath: faultPath, environment: "test" }).database;
          try {
            assert.deepEqual(snapshots(readRows(faultDatabase)), claimedSnapshots, "Every table must match the pre-effect checkpoint after interruption");
            let faultRuntime = compose(faultDatabase);
            nowMs = crashAtMs + 101;
            const runner = () => createRunMatchupOccurrencesJob({ repository: { ...faultRuntime.repositories.matchupJobs,
              listDue(input) { return faultRuntime.repositories.matchupJobs.listDue({ ...input, limit: 100 }).filter(row => row.id === target.id); } },
              executionGuard: faultRuntime.repositories.matchupOccurrenceRunnerExecutionGuard, handlers: faultRuntime.services.league.matchupOccurrenceHandlers,
              clock, secureRandom, leaseOwner: "partial-crash-restarted-worker", logger: { error() {} } });
            const result = await runner().run();
            assert.equal(result.due, 1); assert.equal(result.acquired, 1); assert.equal(result.succeeded, 1); assert.equal(result.failed, 0); assert.equal(result.skipped, 0);
            const completed = readRows(faultDatabase), completedSnapshots = snapshots(completed);
            const expected = jobType === "matchup:lock" ? { lockedTeams: 14 } : jobType === "matchup:rollover" ? { status: "final" } : { finalizedMatchups: 7 };
            const job = completed.job_runs.find(row => row.id === target.id);
            assert.equal(job.status, "succeeded"); assert.equal(job.attempt_count, currentClaim.occurrence.attempt_count + 1);
            assert.deepEqual(JSON.parse(job.result_json), expected);
            assert.deepEqual(completed.job_runs.filter(row => row.id !== target.id), claimed.job_runs.filter(row => row.id !== target.id));
            const allowed = ["job_runs", "matchup_operations", "matchup_weeks", "matchups", "stat_snapshots",
              ...(jobType === "matchup:lock" ? ["matchup_roster_locks", "matchup_roster_players", "stat_snapshot_players"] : ["matchup_results", "matchup_result_versions"])];
            for (const table of Object.keys(claimedSnapshots)) {
              if (!allowed.includes(table)) assert.deepEqual(completedSnapshots[table], claimedSnapshots[table], table);
              else assert.deepEqual(completed[table].filter(row => row.league_id !== league.leagueId), claimed[table].filter(row => row.league_id !== league.leagueId), `${table}: other leagues`);
            }
            const additions = table => completed[table].filter(row => !claimed[table].some(old => old.id === row.id));
            assert.equal(additions("matchup_operations").length, jobType === "matchup:lock" ? 1 : jobType === "matchup:rollover" ? 7 : 8);
            if (jobType === "matchup:lock") {
              assert.equal(additions("matchup_roster_locks").length, 14);
              assert.deepEqual(new Set(additions("matchup_roster_locks").map(row => row.team_id)), teamIds);
              assert.equal(additions("matchup_roster_players").length, 252);
              assert.equal(additions("stat_snapshot_players").length, 252);
            } else {
              assert.equal(additions("matchup_results").length, 7);
              assert.equal(additions("matchup_result_versions").length, 7);
              assert.equal(completed.matchup_weeks.find(row => row.id === week.id).status, "final");
            }
            const standings = faultRuntime.services.league.matchupStandings.read({ leagueId: league.leagueId, seasonId: league.seasonId });
            assert.equal(standings.finalizedResultCount, jobType === "matchup:lock" ? 0 : 7);
            assert.equal((await runner().run()).due, 0);
            assert.deepEqual(snapshots(readRows(faultDatabase)), completedSnapshots);
            faultDatabase.close();
            faultDatabase = openDatabase({ databasePath: faultPath, environment: "test" }).database;
            faultRuntime = compose(faultDatabase);
            assert.equal((await runner().run()).due, 0);
            assert.deepEqual(snapshots(readRows(faultDatabase)), completedSnapshots);
            assert.deepEqual(faultRuntime.services.league.matchupStandings.read({ leagueId: league.leagueId, seasonId: league.seasonId }), standings);
            assert.throws(() => assertRecoveryRuntimeAllowed(faultDatabase), { code: "DATABASE_RECOVERY_HELD" });
            assert.deepEqual(faultDatabase.pragma("foreign_key_check"), []);
            assert.deepEqual(faultDatabase.pragma("integrity_check"), [{ integrity_check: "ok" }]);
          } finally { if (faultDatabase.open) faultDatabase.close(); }
        });
      }
      if (jobType !== "matchup:lock") await t.test("missing statistics after three results rolls back the results and preserves retry", async () => {
        const waitingPath = path.join(started.temporaryRoot, "matchup-waiting.sqlite3");
        fs.writeFileSync(waitingPath, claimedBytes, { flag: "wx" });
        const waitingDatabase = openDatabase({ databasePath: waitingPath, environment: "test" }).database;
        try {
          const waitingRuntime = compose(waitingDatabase);
          const { createMatchupOccurrenceHandlers } = require("../../src/application/services/matchups/createMatchupOccurrenceHandlers");
          let finalized = 0;
          const handlers = createMatchupOccurrenceHandlers({
            executionGuard: waitingRuntime.repositories.matchupOccurrenceRunnerExecutionGuard,
            statisticsService: { refresh: forbidden("providerCalls") }, lateLockCoordinator: { retryEligibleLateLocks: forbidden("providerCalls") },
            readRepository: waitingRuntime.repositories.matchupRead, weekService: waitingRuntime.services.league.matchupWeeks,
            legalityService: waitingRuntime.services.league.matchupLegality, provider: "sportsdataio-live",
            resultService: { finalize(input) {
              if (finalized === 3) return { finalized: false };
              const result = waitingRuntime.services.league.matchupResults.finalize(input);
              assert.equal(result.finalized, true); finalized++; return result;
            } },
          });
          nowMs = crashAtMs;
          await assert.rejects(handlers[jobType](currentClaim.occurrenceExecution, nowMs), { code: "MATCHUP_FINAL_SOURCE_WAITING" });
          assert.equal(finalized, 3, "The waiting source must be encountered after real result writes");
          const waiting = readRows(waitingDatabase);
          for (const table of Object.keys(claimedSnapshots)) {
            if (!["matchup_weeks", "matchups", "matchup_operations"].includes(table)) assert.deepEqual(waiting[table], claimed[table], `${table}: no partial finalization`);
          }
          if (jobType === "matchup:finalize") assert.equal(waiting.matchup_weeks.find(row => row.id === week.id).status, "awaiting_data");
          assert.equal(waitingRuntime.services.league.matchupStandings.read({ leagueId: league.leagueId, seasonId: league.seasonId }).finalizedResultCount, 0);
          nowMs += 101;
          const runner = createRunMatchupOccurrencesJob({ repository: { ...waitingRuntime.repositories.matchupJobs,
            listDue(input) { return waitingRuntime.repositories.matchupJobs.listDue({ ...input, limit: 100 }).filter(row => row.id === target.id); } },
            executionGuard: waitingRuntime.repositories.matchupOccurrenceRunnerExecutionGuard, handlers: waitingRuntime.services.league.matchupOccurrenceHandlers,
            clock, secureRandom, leaseOwner: "statistics-ready-worker", logger: { error() {} } });
          assert.equal((await runner.run()).succeeded, 1);
          assert.equal(waitingRuntime.services.league.matchupStandings.read({ leagueId: league.leagueId, seasonId: league.seasonId }).finalizedResultCount, 7);
          const completed = snapshots(readRows(waitingDatabase));
          assert.equal((await runner.run()).due, 0); assert.deepEqual(snapshots(readRows(waitingDatabase)), completed);
          assert.throws(() => assertRecoveryRuntimeAllowed(waitingDatabase), { code: "DATABASE_RECOVERY_HELD" });
        } finally { waitingDatabase.close(); }
      });
      assert.deepEqual(observed, { providerCalls: 0, emailCalls: 0, publications: 0 });
      assert.deepEqual(protectedFiles.map(readHash), protectedHashes);
      assert.deepEqual(source.serialize(), sourceBytes);
      return;
    }
    const expectedEffect=jobType==="matchup:baseline"?{status:"baseline_ready"}:jobType==="matchup:lock"?{lockedTeams:14}:{finalizedMatchups:7};
    const effect=await runtime.services.league.matchupOccurrenceHandlers[jobType](currentClaim.occurrenceExecution,nowMs);
    assert.deepEqual(effect,expectedEffect);
    const committed=readRows(database),committedSnapshots=snapshots(committed);
    const allowedTables=["job_runs","matchup_operations","matchup_weeks"];
    if(jobType==="matchup:lock") allowedTables.push("matchups","matchup_roster_locks","matchup_roster_players","stat_snapshots","stat_snapshot_players");
    if(jobType==="matchup:finalize") allowedTables.push("matchups","stat_snapshots","matchup_results","matchup_result_versions");
    for(const table of Object.keys(beforeSnapshots)) if(!allowedTables.includes(table)) assert.deepEqual(committedSnapshots[table],beforeSnapshots[table],table);
    for(const table of allowedTables) {
      assert.deepEqual(committed[table].filter(row=>row.league_id!==league.leagueId),before[table].filter(row=>row.league_id!==league.leagueId),`${table}: other leagues`);
      if(!["job_runs","matchup_weeks","matchups"].includes(table)) {
        const rowsById=new Map(committed[table].map(row=>[row.id,row]));
        for(const row of before[table]) assert.deepEqual(rowsById.get(row.id),row,`${table}: preserve existing rows`);
      }
    }
    assert.deepEqual(committed.matchup_weeks.filter(row=>row.id!==target.week_id),before.matchup_weeks.filter(row=>row.id!==target.week_id));
    assert.deepEqual(committed.matchups.filter(row=>!matchupIds.has(row.id)),before.matchups.filter(row=>!matchupIds.has(row.id)));
    const additions=table=>committed[table].filter(row=>!before[table].some(old=>old.id===row.id));
    const newOperations=additions("matchup_operations");assert.equal(newOperations.length,jobType==="matchup:finalize"?8:1);
    for(const row of newOperations) {assert.equal(row.league_id,league.leagueId);assert.equal(row.matchup_week_id,target.week_id);}
    if(jobType==="matchup:lock") {
      const locks=additions("matchup_roster_locks");assert.equal(locks.length,14);
      assert.deepEqual(new Set(locks.map(row=>row.team_id)),teamIds);
      for(const row of locks) {assert.equal(row.matchup_week_id,week.id);assert.equal(row.legal,1);}
      assert.equal(additions("matchup_roster_players").length,252);assert.equal(additions("stat_snapshots").length,14);assert.equal(additions("stat_snapshot_players").length,252);
      for(const row of committed.matchups.filter(row=>matchupIds.has(row.id))) assert.equal(row.status,"live");
    }
    if(jobType==="matchup:finalize") {
      assert.equal(additions("stat_snapshots").length,7);assert.equal(additions("matchup_results").length,7);assert.equal(additions("matchup_result_versions").length,7);
      for(const row of committed.matchups.filter(row=>matchupIds.has(row.id))) assert.equal(row.status,"final");
      assert.equal(committed.matchup_weeks.find(row=>row.id===week.id).status,"final");
    }
    const standingsInput={leagueId:league.leagueId,seasonId:league.seasonId};
    const committedStandings=runtime.services.league.matchupStandings.read(standingsInput);
    assert.equal(committedStandings.finalizedResultCount,jobType==="matchup:finalize"?7:0);
    assert.equal(database.prepare("SELECT status FROM job_runs WHERE id=?").get(target.id).status,"running");
    database.close();nowMs+=101;database=openDatabase({databasePath:replayPath,environment:"test"}).database;runtime=compose(database);
    const runner=()=>createRunMatchupOccurrencesJob({repository:{...runtime.repositories.matchupJobs,
      listDue(input){return runtime.repositories.matchupJobs.listDue({...input,limit:100}).filter(row=>row.id===target.id);}},
      executionGuard:runtime.repositories.matchupOccurrenceRunnerExecutionGuard,handlers:runtime.services.league.matchupOccurrenceHandlers,clock,secureRandom,
      leaseOwner:"restarted-fixture-worker",logger:{error(){}}});
    await t.test("a restarted real worker completes the prior effect without another transition",async()=>{
      const result=await runner().run();assert.equal(result.status,"succeeded");assert.equal(result.due,1,"The exact current occurrence must remain eligible after its domain effect commits");assert.equal(result.acquired,1);
      assert.equal(result.succeeded,1);assert.equal(result.failed,0);assert.equal(result.skipped,0);
      const after=readRows(database),afterSnapshots=snapshots(after);
      for(const table of Object.keys(committedSnapshots)) if(table!=="job_runs") assert.deepEqual(afterSnapshots[table],committedSnapshots[table],table);
      assert.deepEqual(after.job_runs.filter(row=>row.id!==target.id),before.job_runs.filter(row=>row.id!==target.id));
      const finalJob=after.job_runs.find(row=>row.id===target.id);assert.equal(finalJob.status,"succeeded");assert.equal(finalJob.attempt_count,oldClaim.occurrence.attempt_count+2);
      assert.deepEqual(JSON.parse(finalJob.result_json),jobType==="matchup:finalize"?{finalizedMatchups:0}:expectedEffect);
      assert.deepEqual(runtime.services.league.matchupStandings.read(standingsInput),committedStandings);
      assert.equal((await runner().run()).due,0);assert.deepEqual(snapshots(readRows(database)),afterSnapshots);
      database.close();database=openDatabase({databasePath:replayPath,environment:"test"}).database;runtime=compose(database);
      assert.equal((await runner().run()).due,0);assert.deepEqual(snapshots(readRows(database)),afterSnapshots);
      assert.deepEqual(database.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY),hold);
      assert.throws(()=>assertRecoveryRuntimeAllowed(database),{code:"DATABASE_RECOVERY_HELD"});
      assert.throws(()=>createTargetRuntime({database,migrationsDirectory:MIGRATIONS_DIRECTORY,securityFoundations,currentSeason}),{code:"DATABASE_RECOVERY_HELD"});
      assert.deepEqual(database.pragma("foreign_key_check"),[]);assert.deepEqual(database.pragma("integrity_check"),[{integrity_check:"ok"}]);
    });
    assert.deepEqual(observed,{providerCalls:0,emailCalls:0,publications:0});
    assert.deepEqual(protectedFiles.map(readHash),protectedHashes);assert.deepEqual(source.serialize(),sourceBytes);
  } finally {if(database.open)database.close();}
}

function repeatableSentinelFacts(value) {
  if (Array.isArray(value)) {
    return value.map(repeatableSentinelFacts);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "cardId",
            "entryId",
            "helpRequestId",
            "matchupId",
            "notificationId",
            "weekId",
          ].includes(key)
      )
      .map(([key, child]) => [
        key,
        repeatableSentinelFacts(child),
      ])
  );
}

function assertSentinelIds(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      assertSentinelIds(child);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Id")) {
      assert.equal(
        CANONICAL_UUID_PATTERN.test(child),
        true
      );
    } else {
      assertSentinelIds(child);
    }
  }
}

function repeatableFacts(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    fixtureKind: manifest.fixtureKind,
    fixedNowMs: manifest.fixedNowMs,
    accounts: Object.fromEntries(
      Object.entries(manifest.accounts).map(
        ([alias, account]) => [
          alias,
          {
            alias: account.alias,
            userId: account.userId,
            email: account.email,
          },
        ]
      )
    ),
    leagues: Object.fromEntries(
      Object.entries(manifest.leagues).map(
        ([alias, league]) => [
          alias,
          {
            alias: league.alias,
            name: league.name,
            leagueId: league.leagueId,
            seasonId: league.seasonId,
            phase: league.phase,
            openedAtMs: league.openedAtMs,
            helpOpensAtMs: league.helpOpensAtMs,
            candidateDeadlineAtMs:
              league.candidateDeadlineAtMs,
            firstWeekStartsAtMs:
              league.firstWeekStartsAtMs,
            commissionerAccountAlias:
              league.commissionerAccountAlias,
            teams: league.teams.map((team) => ({
              alias: team.alias,
              name: team.name,
              teamId: team.teamId,
              managerAccountAlias:
                team.managerAccountAlias,
            })),
            sentinelFacts:
              repeatableSentinelFacts(
                league.sentinels
              ),
          },
        ]
      )
    ),
    privacyChecks: manifest.privacyChecks,
  };
}

async function startRuntime(t) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: PASSWORD,
    port: 0,
  });
  t.after(() => started.close());
  return started;
}

test(
  "staging FAD activation refuses production, wrong fixture identity, unsafe scheduling, and duplicates",
  () => {
    const valid = {
      appEnv: "staging",
      environmentId: FIXTURE_ENVIRONMENT_ID,
      databaseId: FIXTURE_DATABASE_ID,
      leagueWriteMode: "open",
      freeAgentDraftRoutesEnabled: true,
      scheduledJobsEnabled: false,
    };
    assert.doesNotThrow(() => assertStagingScope(valid));
    assert.doesNotThrow(() => assertFixtureIdentitiesDistinct());
    assert.equal(EXPECTED_LEAGUE_IDS.length, 3);
    assert.equal(LEGACY_FIXTURE_LEAGUES.length, 4);
    assert.equal(
      new Set([
        ...EXPECTED_LEAGUE_IDS,
        ...LEGACY_FIXTURE_LEAGUES.map(({ id }) => id),
      ]).size,
      7
    );
    for (const overrides of [
      { appEnv: "production" },
      { environmentId: "production" },
      { databaseId: "production" },
      { leagueWriteMode: "closed" },
      { freeAgentDraftRoutesEnabled: false },
      { scheduledJobsEnabled: true },
    ]) {
      assert.throws(
        () => assertStagingScope({ ...valid, ...overrides }),
        (error) => error.code === "STAGING_FAD_TEST_SCOPE_INVALID"
      );
    }
    assert.doesNotThrow(() =>
      assertNoPriorFixture({
        prepare() {
          return { all: () => [] };
        },
      })
    );
    assert.equal(
      existingFixtureState({
        prepare() {
          return { all: () => [] };
        },
      }),
      "absent"
    );
    assert.equal(
      existingFixtureState({
        prepare() {
          return {
            all: () => EXPECTED_LEAGUE_IDS.map((id) => ({ id })),
          };
        },
      }),
      "complete"
    );
    assert.throws(
      () =>
        existingFixtureState({
          prepare() {
            return { all: () => [{ id: EXPECTED_LEAGUE_IDS[0] }] };
          },
        }),
      (error) =>
        error.code === "STAGING_FAD_TEST_EXISTING_STATE_PARTIAL"
    );
    assert.throws(
      () =>
        assertNoPriorFixture({
          prepare() {
            return { all: () => [{ id: EXPECTED_LEAGUE_IDS[0] }] };
          },
        }),
      (error) => error.code === "STAGING_FAD_TEST_ALREADY_EXISTS"
    );
  }
);

test(
  "staging FAD schedule keeps Week 1 on a Vancouver Monday more than one week ahead",
  () => {
    const nowMs = Date.parse("2026-08-12T18:00:00.000Z");
    const schedules = schedulesFor(nowMs);
    assert.equal(
      schedules.alpha.firstWeekStartsAtMs,
      Date.parse("2026-08-24T07:00:00.000Z")
    );
    assert.equal(
      schedules.alpha.firstWeekStartsAtMs >
        nowMs + 8 * 24 * 60 * 60 * 1_000,
      true
    );
    assert.equal(
      schedules.beta.firstWeekStartsAtMs -
        schedules.alpha.firstWeekStartsAtMs,
      0
    );
    assert.equal(
      schedules.gamma.firstWeekStartsAtMs,
      Date.parse("2026-08-03T07:00:00.000Z")
    );
  }
);

test(
  "FAD browser fixture rejects missing or unsupported release-QA runtimes",
  async () => {
    const source = fs.readFileSync(
      path.join(
        ROOT_DIRECTORY,
        "src",
        "operations",
        "release",
        "createFreeAgentDraftBrowserFixture.js"
      ),
      "utf8"
    );
    assert.match(source, /fad-browser-v4:/u);
    assert.match(source, /week_1_completed_fad/u);
    assert.deepEqual(
      [...source.matchAll(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([a-z_]+)/giu
      )].map((match) => `${match[1].toUpperCase()} ${match[2]}`),
      [
        "INSERT INTO job_runs",
        "INSERT INTO matchup_schedule_job_bindings",
        "INSERT INTO job_runs",
        "UPDATE draft_picks",
        "UPDATE entry_draft_pick_clocks",
        "UPDATE entry_drafts",
      ]
    );
    await assert.rejects(
      createFreeAgentDraftBrowserFixture({}),
      (error) =>
        error instanceof
          FreeAgentDraftBrowserFixtureError &&
        error.code ===
          "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID"
    );
    for (const schemaVersion of [53, 58]) {
      await assert.rejects(
        createFreeAgentDraftBrowserFixture({
          runtime: { database: { open: true, pragma: () => schemaVersion } },
        }),
        (error) => error.code === "FREE_AGENT_DRAFT_BROWSER_FIXTURE_RUNTIME_INVALID"
      );
    }
  }
);

test(
  "FAD browser fixture uses real lifecycle and card services with strict privacy isolation",
  async (t) => {
    const started = await startRuntime(t);
    seedRealPlayerCatalog(started.runtime.database);
    const fixtureAccountEmails = [
      "admin@release-qa.example.test",
      "comm.a@release-qa.example.test",
      "comm.b@release-qa.example.test",
      "man.a.leag.a@release-qa.example.test",
      "man.b.leag.a@release-qa.example.test",
      "man.a.leag.b@release-qa.example.test",
    ];
    for (const email of fixtureAccountEmails) {
      const account = started.runtime.database.prepare(`
        SELECT id
        FROM users
        WHERE email_normalized = ?
      `).get(email);
      assert.ok(account);
      started.runtime.services.sessionService.issueForUser({
        userId: account.id,
      });
    }
    const triggerBaseline =
      started.runtime.database.prepare(`
        SELECT name, sql
        FROM sqlite_schema
        WHERE type = 'trigger'
        ORDER BY name ASC
      `).all();
    const manifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: started.runtime,
      });

    assert.equal(
      manifest.schemaVersion,
      BROWSER_FIXTURE_SCHEMA_VERSION
    );
    assert.equal(
      manifest.fixtureKind,
      BROWSER_FIXTURE_KIND
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(manifest)),
      manifest
    );
    assertRecursivelyFrozen(manifest);
    const serialized = JSON.stringify(manifest);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(/password|cookie|session|token/i.test(serialized), false);

    assert.deepEqual(Object.keys(manifest.leagues), [
      "alpha",
      "beta",
      "gamma",
    ]);
    for (const [leagueAlias, league] of
      Object.entries(manifest.leagues)) {
      const expectedTeamCount = {
        alpha: 8,
        beta: 6,
        gamma: 14,
      }[leagueAlias];
      assert.equal(UUID_PATTERN.test(league.leagueId), true);
      assert.equal(UUID_PATTERN.test(league.seasonId), true);
      assert.equal(UUID_PATTERN.test(league.fadId), true);
      assert.equal(
        league.phase,
        leagueAlias === "gamma" ? "completed" : "cards_open"
      );
      assert.equal(
        league.candidateCardsEditable,
        leagueAlias !== "gamma"
      );
      assert.equal(league.teams.length, expectedTeamCount);
      assert.equal(
        new Set(league.teams.map(({ teamId }) => teamId))
          .size,
        expectedTeamCount
      );
      assert.equal(
        league.helpOpensAtMs >=
          league.openedAtMs,
        true
      );
      assert.equal(
        league.candidateDeadlineAtMs >
          league.openedAtMs,
        true
      );
      if (leagueAlias !== "gamma") {
        assert.equal(league.openedAtMs <= manifest.fixedNowMs, true);
        assert.equal(
          manifest.fixedNowMs < league.candidateDeadlineAtMs,
          true
        );
      }
    }

    const alpha = manifest.leagues.alpha;
    const beta = manifest.leagues.beta;
    const gamma = manifest.leagues.gamma;
    const commissionerAccounts = [alpha, beta, gamma]
      .map(({ commissionerAccountAlias }) =>
        manifest.accounts[commissionerAccountAlias]
      );
    assert.equal(
      new Set(
        commissionerAccounts.map(({ userId }) => userId)
      ).size,
      1
    );
    assert.deepEqual(
      commissionerAccounts.map(({ email }) => email),
      Array(3).fill("comm.a@release-qa.example.test")
    );
    assert.equal(
      beta.memberAccountAliases.includes(
        "betaCommissioner"
      ),
      true
    );
    assert.equal(
      alpha.helpOpensAtMs >= alpha.openedAtMs,
      true
    );
    assert.equal(
      beta.helpOpensAtMs >= beta.openedAtMs,
      true
    );
    assert.equal(
      beta.firstWeekStartsAtMs -
        alpha.firstWeekStartsAtMs,
      0
    );
    assert.deepEqual(
      alpha.teams.slice(0, 2).map(
        ({ managerAccountAlias }) =>
          managerAccountAlias
      ),
      [
        "alphaMultiTeamManager",
        "alphaOtherManager",
      ]
    );
    assert.equal(alpha.sentinels.emptyInauguralCards, true);
    assert.equal(alpha.sentinels.carryoverCount, 0);
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.teamAlias,
      "alphaTeam3"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.status,
      "active"
    );
    assert.equal(
      alpha.sentinels.exactCommissionerHelp.requestingAccountAlias,
      "alphaMultiTeamManager"
    );
    assert.equal(
      alpha.sentinels.cardReadyNotification.eventType,
      "fad_cards_opened"
    );
    assert.equal(
      alpha.sentinels.cardReadyNotification.copy,
      "Your Candidate Card is ready."
    );
    assert.equal(
      beta.sentinels.privateCandidates[0].slotKey,
      "D03"
    );
    assert.equal(gamma.competitionPhase, "week_1");
    assert.equal(gamma.firstWeekStartsAtMs <= manifest.fixedNowMs, true);
    assert.equal(
      manifest.fixedNowMs < gamma.firstWeekStartsAtMs + 7 * 24 * 60 * 60 * 1_000,
      true
    );
    assert.equal(gamma.sentinels.publishedHistoryReadOnly, true);
    assert.equal(gamma.sentinels.rosterPlayersPerTeam, 22);
    assert.deepEqual(
      gamma.sentinels.thirtyDollarThreeYearWinner,
      {
        ...gamma.sentinels.thirtyDollarThreeYearWinner,
        totalValueCents: 3_000,
        termYears: 3,
        aavCents: 1_000,
      }
    );
    assert.equal(
      gamma.sentinels.capRangeCents.minimum >= 7_000,
      true
    );
    assert.equal(
      gamma.sentinels.capRangeCents.maximum <= 10_000,
      true
    );
    assert.deepEqual(
      gamma.sentinels.weekOneMatchups,
      {
        ...gamma.sentinels.weekOneMatchups,
        matchupCount: 7,
        scheduledTeamCount: 14,
        activeRosterPlayerCount: 252,
        scoringPlayerCount: 252,
        scoringSignalCount: 14,
      }
    );
    assert.equal(
      gamma.sentinels.weekOneMatchups.maximumPlayerPointsHundredths >
        gamma.sentinels.weekOneMatchups.minimumPlayerPointsHundredths,
      true
    );
    assert.equal(
      manifest.privacyChecks.commissionerDeniedTeamAlias,
      "alphaTeam4"
    );
    assert.equal(
      manifest.privacyChecks.commissionerHelpTeamAlias,
      "alphaTeam3"
    );
    assert.equal(manifest.privacyChecks.privateMarkers.length, 3);
    assert.equal(
      manifest.privacyChecks.privateMarkers.every(
        (name) => typeof name === "string" && !name.includes("Sentinel")
      ),
      true
    );

    const database = started.runtime.database;
    assert.deepEqual(
      database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE (league_id = ? AND season_id = ?)
           OR (league_id = ? AND season_id = ?)
        GROUP BY status
      `).all(
        alpha.leagueId,
        alpha.seasonId,
        beta.leagueId,
        beta.seasonId
      ),
      [{ status: "succeeded", count: 2 }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT trigger_kind, entry_draft_id, setup_exemption_id,
               COUNT(*) AS count
        FROM free_agent_draft_readiness_operations
        WHERE (league_id = ? AND season_id = ?)
           OR (league_id = ? AND season_id = ?)
        GROUP BY trigger_kind, entry_draft_id, setup_exemption_id
        ORDER BY trigger_kind
      `).all(
        alpha.leagueId,
        alpha.seasonId,
        beta.leagueId,
        beta.seasonId
      ).map((row) => ({
        trigger_kind: row.trigger_kind,
        has_entry_draft: row.entry_draft_id !== null,
        has_setup_exemption: row.setup_exemption_id !== null,
        count: row.count,
      })),
      [
        {
          trigger_kind: "entry_draft_completed",
          has_entry_draft: true,
          has_setup_exemption: false,
          count: 1,
        },
        {
          trigger_kind: "no_draft_inaugural",
          has_entry_draft: false,
          has_setup_exemption: false,
          count: 1,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT from_season_id, to_season_id, status,
               target_season_reused
        FROM season_rollovers
        WHERE league_id = ?
      `).all(beta.leagueId),
      [{
        from_season_id: manifest.leagues.beta.priorSeasonId,
        to_season_id: beta.seasonId,
        status: "succeeded",
        target_season_reused: 1,
      }]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM free_agent_drafts
           WHERE id IN (@alphaFad, @betaFad)) AS fads,
          (SELECT COUNT(*) FROM candidate_cards
           WHERE fad_id IN (@alphaFad, @betaFad)) AS cards,
          (SELECT COUNT(*) FROM candidate_card_help_requests
           WHERE fad_id IN (@alphaFad, @betaFad)) AS help_requests,
          (SELECT COUNT(*) FROM notifications
           WHERE related_record_id IN (@alphaFad, @betaFad)
             AND event_type = 'fad_cards_opened') AS card_ready
      `).get({
        alphaFad: alpha.fadId,
        betaFad: beta.fadId,
      }),
      {
        fads: 2,
        cards: 14,
        help_requests: 1,
        card_ready: 14,
      }
    );
    const carryoverCounts = database.prepare(`
      SELECT team_id, COUNT(*) AS count
      FROM candidate_card_entries
      WHERE fad_id IN (?, ?)
        AND entry_kind = 'carryover'
      GROUP BY team_id
      ORDER BY team_id ASC
    `).all(alpha.fadId, beta.fadId);
    assert.equal(carryoverCounts.length, 6);
    assert.deepEqual(
      [...new Set(carryoverCounts.map(({ count }) => count))],
      [6]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT DISTINCT carryover_aav_cents AS aav_cents
        FROM candidate_card_entries
        WHERE fad_id IN (?, ?)
          AND entry_kind = 'carryover'
        ORDER BY carryover_aav_cents ASC
      `).all(alpha.fadId, beta.fadId),
      [
        { aav_cents: 100 },
        { aav_cents: 200 },
        { aav_cents: 400 },
        { aav_cents: 700 },
        { aav_cents: 1_000 },
        { aav_cents: 1_500 },
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT DISTINCT remaining_years
        FROM candidate_card_entries
        WHERE fad_id IN (?, ?)
          AND entry_kind = 'carryover'
        ORDER BY remaining_years ASC
      `).all(alpha.fadId, beta.fadId),
      [{ remaining_years: 1 }, { remaining_years: 2 }]
    );
    for (const league of [alpha, beta]) {
      assert.deepEqual(
        database.prepare(`
          SELECT label, nhl_season_key
          FROM seasons
          WHERE league_id = ? AND status = 'planned'
          ORDER BY nhl_season_key ASC
        `).all(league.leagueId),
        [
          { label: "2027-28", nhl_season_key: "20272028" },
          { label: "2028-29", nhl_season_key: "20282029" },
          { label: "2029-30", nhl_season_key: "20292030" },
        ]
      );
    }
    for (const [league, expectedUnusedPicksPerTeam] of [
      [alpha, 16],
      [beta, 12],
      [gamma, 16],
    ]) {
      const inventory = database.prepare(`
        SELECT original_team_id,
               COUNT(*) AS pick_count,
               SUM(status = 'unused') AS unused_pick_count,
               COUNT(DISTINCT target_season_id) AS season_count,
               COUNT(DISTINCT round_number) AS round_count
        FROM draft_picks
        WHERE league_id = ?
        GROUP BY original_team_id
        ORDER BY original_team_id
      `).all(league.leagueId);
      assert.equal(inventory.length, league.teams.length);
      assert.deepEqual(
        inventory.map((row) => ({
          pick_count: row.pick_count,
          unused_pick_count: row.unused_pick_count,
          season_count: row.season_count,
          round_count: row.round_count,
        })),
        Array.from({ length: league.teams.length }, () => ({
          pick_count: 16,
          unused_pick_count: expectedUnusedPicksPerTeam,
          season_count: 4,
          round_count: 4,
        }))
      );
    }
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_entries AS entry
        INNER JOIN players AS player ON player.id = entry.player_id
        WHERE entry.league_id IN (?, ?, ?)
          AND entry.entry_kind = 'carryover'
          AND lower(player.full_name) LIKE 'fixture player %'
      `).get(alpha.leagueId, beta.leagueId, gamma.leagueId).count,
      0
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM league_memberships
        WHERE league_id = ? AND user_id = ?
      `).get(
        beta.leagueId,
        manifest.accounts.alphaMultiTeamManager.userId
      ).count,
      0
    );

    const alphaManager = authenticate(
      started.runtime,
      manifest.accounts.alphaMultiTeamManager.userId
    );
    for (const teamAlias of [
      "alphaTeam1",
      "alphaTeam3",
    ]) {
      const team = alpha.teams.find(
        ({ alias }) => alias === teamAlias
      );
      const card = started.runtime.services.league
        .candidateCards.privateCard({
          authenticated: alphaManager,
          leagueId: alpha.leagueId,
          fadId: alpha.fadId,
          teamId: team.teamId,
      });
      assert.equal(card.accessReason, "team_manager");
      assert.equal(
        card.slots.every((slot) => slot.occupantKind === "empty"),
        true
      );
    }
    const deniedAlphaTeam = alpha.teams.find(
      ({ alias }) => alias === "alphaTeam2"
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaManager,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: deniedAlphaTeam.teamId,
          }),
      (error) => {
        assert.equal(
          error.code,
          "CANDIDATE_CARD_NOT_FOUND"
        );
        return true;
      }
    );
    const betaTeam = beta.teams[0];
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaManager,
            leagueId: beta.leagueId,
            fadId: beta.fadId,
            teamId: betaTeam.teamId,
          }),
      (error) => {
        assert.equal(error.code, "LEAGUE_NOT_FOUND");
        assert.equal(
          JSON.stringify({
            code: error.code,
            message: error.message,
          }).includes(
            beta.sentinels.privateCandidates[0]
              .playerFullName
          ),
          false
        );
        return true;
      }
    );
    const alphaCommissioner = authenticate(
      started.runtime,
      manifest.accounts.alphaCommissioner.userId
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaCommissioner,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: deniedAlphaTeam.teamId,
          }),
      (error) => error.code === "CANDIDATE_CARD_NOT_FOUND"
    );
    const commissionerDeniedTeam = alpha.teams.find(
      ({ alias }) =>
        alias ===
        manifest.privacyChecks
          .commissionerDeniedTeamAlias
    );
    assert.throws(
      () =>
        started.runtime.services.league
          .candidateCards.privateCard({
            authenticated: alphaCommissioner,
            leagueId: alpha.leagueId,
            fadId: alpha.fadId,
            teamId: commissionerDeniedTeam.teamId,
          }),
      (error) => {
        assert.equal(
          error.code,
          "CANDIDATE_CARD_NOT_FOUND"
        );
        return true;
      }
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM candidate_cards
        WHERE league_id = ? AND fad_id = ?
        GROUP BY status
      `).all(gamma.leagueId, gamma.fadId),
      [{ status: "locked_complete", count: 14 }]
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshots
        WHERE league_id = ? AND fad_id = ?
      `).get(gamma.leagueId, gamma.fadId).count,
      14
    );
    assert.deepEqual(
      database.prepare(`
        SELECT ownership.team_id, COUNT(*) AS player_count,
               SUM(contract.aav_cents) AS cap_cents
        FROM player_ownerships AS ownership
        JOIN contracts AS contract
          ON contract.league_id = ownership.league_id
         AND contract.player_id = ownership.player_id
         AND contract.current_team_id = ownership.team_id
         AND contract.status = 'active'
        WHERE ownership.league_id = ? AND ownership.season_id = ?
          AND ownership.ownership_kind = 'Rostered'
        GROUP BY ownership.team_id
        ORDER BY ownership.team_id
      `).all(gamma.leagueId, gamma.seasonId).map((row) => ({
        player_count: row.player_count,
        cap_valid: row.cap_cents >= 7_000 && row.cap_cents <= 10_000,
      })),
      Array.from({ length: 14 }, () => ({
        player_count: 22,
        cap_valid: true,
      }))
    );
    assert.equal(
      Object.keys(gamma.sentinels.offerOutcomes).includes("winner"),
      true
    );
    assert.equal(
      Object.keys(gamma.sentinels.offerOutcomes).some((code) =>
        code.startsWith("lost_")
      ),
      true
    );
    const immutableAwardEvidence = database.prepare(`
      SELECT event.evidence_json AS decision_json,
             outbox.payload_json AS outbox_json,
             json_extract(
               event.evidence_json,
               '$.sideEffects.fadVersion'
             ) AS decision_fad_version,
             json_extract(outbox.payload_json, '$.version')
               AS outbox_fad_version
      FROM free_agent_draft_player_allocations AS allocation
      JOIN free_agent_draft_allocation_events AS event
        ON event.league_id = allocation.league_id
       AND event.season_id = allocation.season_id
       AND event.fad_id = allocation.fad_id
       AND event.allocation_id = allocation.id
       AND event.allocation_version = allocation.version
       AND event.event_kind = 'decision_recorded'
      JOIN outbox_events AS outbox
        ON outbox.league_id = event.league_id
       AND outbox.id = json_extract(
         event.evidence_json,
         '$.sideEffects.outboxEventId'
       )
      WHERE allocation.league_id = ? AND allocation.fad_id = ?
        AND allocation.status = 'automatic_award'
      ORDER BY allocation.id LIMIT 1
    `).get(gamma.leagueId, gamma.fadId);
    assert.equal(
      immutableAwardEvidence.decision_fad_version,
      immutableAwardEvidence.outbox_fad_version
    );
    const immutableAwardBytes = {
      decision_json: immutableAwardEvidence.decision_json,
      outbox_json: immutableAwardEvidence.outbox_json,
    };
    const completionPublication = database.prepare(`
      SELECT json_extract(payload_json, '$.version') AS version,
             json_extract(payload_json, '$.reasonCode') AS reason_code
      FROM outbox_events
      WHERE league_id = ?
        AND aggregate_type = 'free_agent_draft'
        AND aggregate_id = ?
        AND event_type = 'free_agent_draft.changed'
        AND json_extract(payload_json, '$.reasonCode') = 'completed'
    `).get(gamma.leagueId, gamma.fadId);
    assert.deepEqual(completionPublication, {
      version: database.prepare(`
        SELECT version FROM free_agent_drafts WHERE id = ?
      `).get(gamma.fadId).version,
      reason_code: "completed",
    });
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM matchups
           WHERE league_id = @leagueId
             AND matchup_week_id = @weekId) AS matchups,
          (SELECT COUNT(*) FROM matchup_roster_locks
           WHERE league_id = @leagueId
             AND matchup_week_id = @weekId) AS locks,
          (SELECT COUNT(*) FROM matchup_roster_players
           WHERE league_id = @leagueId) AS roster_players,
          (SELECT COUNT(*) FROM league_activity
           WHERE league_id = @leagueId
             AND event_type = 'matchup_fixture_scoring_play') AS plays
      `).get({
        leagueId: gamma.leagueId,
        weekId: gamma.sentinels.weekOneMatchups.weekId,
      }),
      { matchups: 7, locks: 14, roster_players: 252, plays: 14 }
    );

    const gammaMember = authenticate(
      started.runtime,
      manifest.accounts.gammaManagerOne.userId
    );
    const histories = gamma.teams.map((team) =>
      started.runtime.services.league.freeAgentDraftRead
        .publishedCardHistory({
          authenticated: gammaMember,
          leagueId: gamma.leagueId,
          fadId: gamma.fadId,
          teamId: team.teamId,
        })
    );
    for (const history of histories) {
      assert.deepEqual(
        Object.keys(history).sort(),
        [
          "fadId",
          "leagueId",
          "results",
          "seasonId",
          "team",
          "teamId",
        ]
      );
      assert.equal(
        history.results.some(
          ({ status }) => status === "signed"
        ),
        true
      );
      assert.equal(
        history.results.some(
          ({ status }) => status === "not_won"
        ),
        true
      );
      for (const result of history.results) {
        assert.deepEqual(
          Object.keys(result).sort(),
          [
            "offer",
            "player",
            "status",
            "tieAuctionId",
          ]
        );
      }
    }
    const winningHistory = histories.find(
      ({ teamId }) =>
        teamId ===
        gamma.sentinels.thirtyDollarThreeYearWinner.teamId
    );
    const thirtyDollarResult = winningHistory.results.find(
      ({ player }) =>
        player.playerId ===
        gamma.sentinels.thirtyDollarThreeYearWinner.playerId
    );
    assert.deepEqual(thirtyDollarResult, {
      player: thirtyDollarResult.player,
      status: "signed",
      offer: {
        totalValueCents: 3_000,
        termYears: 3,
        aavCents: 1_000,
      },
      tieAuctionId: null,
    });

    const firstTeamId = gamma.teams[0].teamId;
    const firstCard = database.prepare(`
      SELECT id, version
      FROM candidate_cards
      WHERE league_id = ? AND fad_id = ? AND team_id = ?
    `).get(gamma.leagueId, gamma.fadId, firstTeamId);
    const currentEntries = database.prepare(`
      SELECT id, player_id, entry_kind,
             requested_slot_group, requested_slot_number,
             proposed_aav_cents, proposed_term_years
      FROM candidate_card_entries
      WHERE league_id = ? AND fad_id = ? AND team_id = ?
        AND placement_state = 'placed'
      ORDER BY requested_slot_group, requested_slot_number, id
    `).all(gamma.leagueId, gamma.fadId, firstTeamId);
    const slotCoordinates = [
      ...Array.from(
        { length: 12 },
        (_, index) => ["F", index + 1]
      ),
      ...Array.from(
        { length: 6 },
        (_, index) => ["D", index + 1]
      ),
      ...Array.from(
        { length: 4 },
        (_, index) => ["B", index + 1]
      ),
    ];
    const entryBySlot = new Map(
      currentEntries
        .filter(({ entry_kind: kind }) => kind === "candidate")
        .map((entry) => [
          entry.requested_slot_group +
            String(entry.requested_slot_number).padStart(2, "0"),
          entry,
        ])
    );
    const privateSlots = slotCoordinates.map(
      ([slotGroup, slotNumber]) => {
        const slotKey =
          slotGroup + String(slotNumber).padStart(2, "0");
        const entry = entryBySlot.get(slotKey) ?? null;
        return {
          slotGroup,
          slotKey,
          candidate:
            entry === null
              ? null
              : {
                  playerId: entry.player_id,
                  aavCents: entry.proposed_aav_cents,
                  termYears: entry.proposed_term_years,
                },
        };
      }
    );
    const firstCandidateEntry = currentEntries.find(
      ({ entry_kind: kind }) => kind === "candidate"
    );
    const firstCandidate = {
      entryId: firstCandidateEntry.id,
      player: {
        playerId: firstCandidateEntry.player_id,
      },
    };
    const firstEmpty = privateSlots.find(
      ({ candidate }) => candidate === null
    );
    const unusedPlayer = database.prepare(`
      SELECT player.id
      FROM players AS player
      JOIN player_source_state AS source
        ON source.player_id = player.id
       AND source.ended_at_ms IS NULL
       AND source.active = 1
       AND source.normalized_position = ?
      WHERE player.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM candidate_card_snapshot_entries AS entry
          WHERE entry.league_id = ? AND entry.fad_id = ?
            AND entry.player_id = player.id
        )
      ORDER BY lower(player.full_name), player.id
      LIMIT 1
    `).get(
      firstEmpty.slotGroup === "D" ? "D" : "F",
      gamma.leagueId,
      gamma.fadId
    );
    const mutationRevisionCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM candidate_card_revisions
      WHERE league_id = ? AND fad_id = ?
    `).get(gamma.leagueId, gamma.fadId).count;
    const mutationCommands = [
      ["add", () => started.runtime.services.league.candidateCards.addCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstTeamId,
        slotKey: firstEmpty.slotKey,
        input: {
          playerId: unusedPlayer.id,
          aavCents: 100,
          termYears: 1,
        },
        expectedCardVersion: firstCard.version,
        idempotencyKey: "gamma-completed-add-denied",
      })],
      ["edit", () => started.runtime.services.league.candidateCards.editCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstTeamId,
        entryId: firstCandidate.entryId,
        input: { aavCents: 100, termYears: 2 },
        expectedCardVersion: firstCard.version,
        idempotencyKey: "gamma-completed-edit-denied",
      })],
      ["move", () => started.runtime.services.league.candidateCards.moveEntry({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstTeamId,
        entryId: firstCandidate.entryId,
        input: { slotKey: firstEmpty.slotKey },
        expectedCardVersion: firstCard.version,
        idempotencyKey: "gamma-completed-move-denied",
      })],
      ["remove", () => started.runtime.services.league.candidateCards.removeCandidate({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstTeamId,
        entryId: firstCandidate.entryId,
        expectedCardVersion: firstCard.version,
        idempotencyKey: "gamma-completed-remove-denied",
      })],
      ["save", () => started.runtime.services.league.candidateCards.saveCard({
        authenticated: gammaMember,
        leagueId: gamma.leagueId,
        fadId: gamma.fadId,
        teamId: firstTeamId,
        input: {
          slots: privateSlots.map((slot) => ({
            slotKey: slot.slotKey,
            candidate: slot.candidate,
          })),
        },
        expectedCardVersion: firstCard.version,
        idempotencyKey: "gamma-completed-save-denied",
      })],
    ];
    for (const [name, command] of mutationCommands) {
      assert.throws(command, (error) => {
        const chain = [];
        for (let current = error; current; current = current.cause) {
          chain.push(current.code, current.details?.reasonCode);
        }
        assert.equal(
          chain.includes("FAD_SEASON_CLOSED"),
          true,
          `${name}: ${JSON.stringify(chain)}`
        );
        return true;
      });
    }
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_revisions
        WHERE league_id = ? AND fad_id = ?
      `).get(gamma.leagueId, gamma.fadId).count,
      mutationRevisionCount
    );
    assert.deepEqual(
      database.prepare(`
        SELECT event.evidence_json AS decision_json,
               outbox.payload_json AS outbox_json
        FROM free_agent_draft_player_allocations AS allocation
        JOIN free_agent_draft_allocation_events AS event
          ON event.league_id = allocation.league_id
         AND event.season_id = allocation.season_id
         AND event.fad_id = allocation.fad_id
         AND event.allocation_id = allocation.id
         AND event.allocation_version = allocation.version
         AND event.event_kind = 'decision_recorded'
        JOIN outbox_events AS outbox
          ON outbox.league_id = event.league_id
         AND outbox.id = json_extract(
           event.evidence_json,
           '$.sideEffects.outboxEventId'
         )
        WHERE allocation.league_id = ? AND allocation.fad_id = ?
          AND allocation.status = 'automatic_award'
        ORDER BY allocation.id LIMIT 1
      `).get(gamma.leagueId, gamma.fadId),
      immutableAwardBytes
    );

    const provider = database.prepare(`
      SELECT provider FROM stat_sources
      WHERE status = 'active'
      ORDER BY provider, id LIMIT 1
    `).get().provider;
    const scoreReads = gamma.sentinels.weekOneMatchups
      .scoreReadableMatchups.map(({ matchupId }) =>
        started.runtime.services.league.matchupScoring.readLive({
          leagueId: gamma.leagueId,
          seasonId: gamma.seasonId,
          weekId: gamma.sentinels.weekOneMatchups.weekId,
          matchupId,
          providers: [provider],
          nowMs: manifest.fixedNowMs,
        })
      );
    assert.equal(scoreReads.length, 7);
    assert.equal(
      scoreReads.every(
        ({ status, home, away }) =>
          status === "live" &&
          home.scoreHundredths > 0 &&
          away.scoreHundredths > 0
      ),
      true
    );
    assert.equal(
      new Set(scoreReads.flatMap(({ home, away }) => [
        home.scoreHundredths,
        away.scoreHundredths,
      ])).size > 1,
      true
    );

    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
    const protectedTriggers = database.prepare(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'trigger'
      ORDER BY name ASC
    `).all();
    assert.equal(triggerBaseline.length > 0, true);
    assert.deepEqual(
      protectedTriggers,
      triggerBaseline
    );
  }
);

test(
  "existing staging FAD pick inventory backfills in place without changing team identity or used picks",
  async (t) => {
    const started = await startRuntime(t);
    const database = started.runtime.database;
    seedRealPlayerCatalog(database);
    const manifest = await createFreeAgentDraftBrowserFixture({
      runtime: started.runtime,
    });
    const leagues = Object.values(manifest.leagues);
    const gammaTeam = manifest.leagues.gamma.teams[3];
    database.prepare(`
      UPDATE teams
      SET name = 'Golden Grizzlies',
          name_normalized = 'golden grizzlies',
          version = version + 1
      WHERE league_id = ? AND id = ?
    `).run(manifest.leagues.gamma.leagueId, gammaTeam.teamId);
    const authoritativePick = database.prepare(`
      SELECT id, current_owner_team_id, status, selection_id, version
      FROM draft_picks
      WHERE league_id = ? AND status <> 'unused'
      ORDER BY id
      LIMIT 1
    `).get(manifest.leagues.beta.leagueId);
    assert.ok(authoritativePick);

    const leagueIds = leagues.map(({ leagueId }) => leagueId);
    const placeholders = leagueIds.map(() => "?").join(", ");
    database.prepare(`
      DELETE FROM draft_picks
      WHERE league_id IN (${placeholders}) AND status = 'unused'
    `).run(...leagueIds);
    database.prepare(`
      DELETE FROM entry_drafts
      WHERE league_id IN (${placeholders}) AND status = 'setup'
    `).run(...leagueIds);
    database.prepare(`
      DELETE FROM seasons
      WHERE league_id IN (${placeholders})
        AND nhl_season_key = '20292030'
    `).run(...leagueIds);

    const first =
      backfillExistingFreeAgentDraftBrowserFixturePickInventory({
        runtime: started.runtime,
        fixtureNowMs: manifest.fixedNowMs + 1,
      });
    assert.deepEqual(
      first.leagues.map((league) => ({
        alias: league.alias,
        insertedPickCount: league.insertedPickCount,
        totalPickCount: league.totalPickCount,
        unusedPickCount: league.unusedPickCount,
      })),
      [
        {
          alias: "alpha",
          insertedPickCount: 128,
          totalPickCount: 128,
          unusedPickCount: 128,
        },
        {
          alias: "beta",
          insertedPickCount: 72,
          totalPickCount: 96,
          unusedPickCount: 72,
        },
        {
          alias: "gamma",
          insertedPickCount: 224,
          totalPickCount: 224,
          unusedPickCount: 224,
        },
      ]
    );
    assert.equal(
      database.prepare("SELECT name FROM teams WHERE id = ?")
        .get(gammaTeam.teamId).name,
      "Golden Grizzlies"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT id, current_owner_team_id, status, selection_id, version
        FROM draft_picks WHERE id = ?
      `).get(authoritativePick.id),
      authoritativePick
    );

    const second =
      backfillExistingFreeAgentDraftBrowserFixturePickInventory({
        runtime: started.runtime,
        fixtureNowMs: manifest.fixedNowMs + 2,
      });
    assert.deepEqual(
      second.leagues.map(({ insertedPickCount }) => insertedPickCount),
      [0, 0, 0]
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  }
);

test(
  "FAD browser fixture repeats stable aliases and facts on a fresh disposable runtime",
  async (t) => {
    const first = await startRuntime(t);
    seedRealPlayerCatalog(first.runtime.database);
    const firstManifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: first.runtime,
      });
    const firstFacts = repeatableFacts(firstManifest);
    await first.close();

    const second = await startRuntime(t);
    seedRealPlayerCatalog(second.runtime.database);
    const secondManifest =
      await createFreeAgentDraftBrowserFixture({
        runtime: second.runtime,
      });
    assert.deepEqual(
      repeatableFacts(secondManifest),
      firstFacts
    );
    for (const league of
      Object.values(secondManifest.leagues)) {
      for (const team of league.teams) {
        assert.equal(UUID_PATTERN.test(team.cardId), true);
      }
      assertSentinelIds(league.sentinels);
    }
  }
);
