const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { inspectDatabase } = require("../../infrastructure/database/sqliteBackup");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createTargetRepositories } = require("../../bootstrap/createTargetRuntime");
const { createSecureRandom } = require("../../infrastructure/security/createSecureRandom");
const { createSqliteBuyoutRepository } = require("../../infrastructure/persistence/sqlite/SqliteBuyoutRepository");
const { createSqliteSecurityAuditRepository } = require("../../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const { createMatchupLockService } = require("../../application/services/matchups/createMatchupLockService");
const { createMatchupLegalityService } = require("../../application/services/matchups/createMatchupLegalityService");
const { createLateLockCoordinator } = require("../../application/services/matchups/createLateLockCoordinator");
const { createLiveStatisticsService } = require("../../application/services/statistics/createLiveStatisticsService");
const { PROVIDER_NAME, MINIMUM_CURRENT_SEASON_PLAYER_COUNT } = require("../../infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter");
const { PROVIDER_NAME: PLAYER_IDENTITY_PROVIDER } = require("../../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const { RecoveryKnownBuyoutError, fail, hash, same, assertReader, buildKnownBuyoutEvidence,
  attributeKnownBuyout, readRows, snapshots } = require("./recoveryKnownBuyoutEvidence");
const { knownBuyoutReceipt, verifyRecoveryKnownBuyout } = require("./verifyRecoveryKnownBuyout");

const inside = (root, file) => { const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

function compose({ database, evidence, observed }) {
  const secureRandom = createSecureRandom(), nowMs = () => evidence.command.occurredAtMs;
  const repositories = createTargetRepositories({ database, secureRandom });
  const repository = createSqliteBuyoutRepository({ database,
    tradeProposalCancellationWriter: repositories.tradeProposalCancellationWriter,
    candidateCardSummerSynchronizer: { synchronize(command) {
      const inTransaction = database.inTransaction, result = repositories.candidateCardSummerSynchronizer.synchronize(command);
      observed.summer.push({ inTransaction, command, result }); return result;
    } } });
  const season = evidence.before.seasons.find(row => row.id === evidence.command.seasonId);
  const statisticsService = createLiveStatisticsService({ repository: repositories.statistics, nhlSeasonKey: season.nhl_season_key,
    providerName: PROVIDER_NAME, playerIdentityProvider: PLAYER_IDENTITY_PROVIDER, minimumPlayerCount: MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
    nowMs, createId: () => secureRandom.id(), provider: { async fetchLiveSnapshot() { observed.providerCalls += 1; fail("RECOVERY_BUYOUT_PROVIDER_UNAVAILABLE"); } } });
  const normalLockService = createMatchupLockService({ repository: repositories.matchupLocks, createId: () => secureRandom.id() });
  const legalityService = createMatchupLegalityService({ repository: repositories.matchupLocks, normalLockService, createId: () => secureRandom.id(), nowMs });
  const coordinator = createLateLockCoordinator({ targetRepository: repositories.lateLockCoordinator, legalityService, statisticsService,
    provider: PROVIDER_NAME, clock: { nowMs }, logger: { error() { observed.errors += 1; } } });
  return { repository, coordinator };
}

// Offline reconstruction always creates a new owned copy under the supplied
// temporary root. It never signs in as the historical manager or releases the
// durable hold. Operator authentication remains an explicit later boundary.
async function prepareRecoveryKnownBuyout({ reviewOptions: supplied, decision, temporaryRoot, outputDirectory, beforeReceipt = null } = {}) {
  if (!path.isAbsolute(temporaryRoot || "") || !path.isAbsolute(outputDirectory || "") ||
      (beforeReceipt !== null && typeof beforeReceipt !== "function")) fail("RECOVERY_BUYOUT_INPUT_INVALID");
  let database, ownedDirectory = null, physicalRoot;
  try {
    const reviewOptions = { ...supplied, plan: JSON.parse(JSON.stringify(supplied?.plan)),
      credentialPreparation: JSON.parse(JSON.stringify(supplied?.credentialPreparation)),
      lineage: supplied?.lineage == null ? null : JSON.parse(JSON.stringify(supplied.lineage)),
      backupManifestBytes: Buffer.from(supplied.backupManifestBytes), preservationManifestBytes: Buffer.from(supplied.preservationManifestBytes) };
    const reviewedDecision = JSON.parse(JSON.stringify(decision)), evidence = buildKnownBuyoutEvidence(reviewOptions);
    const attribution = attributeKnownBuyout({ evidence, decision: reviewedDecision });
    const sources = [reviewOptions.preparedDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase];
    const digests = [evidence.review.preparedPlaintextSha256, evidence.review.restoredPlaintextSha256, evidence.review.preservedPlaintextSha256];
    const beforeChanges = sources.map(reader => reader.prepare("SELECT total_changes() n").get().n);
    const assertSources = () => sources.forEach((reader, index) => { assertReader(reader, digests[index]);
      if (reader.prepare("SELECT total_changes() n").get().n !== beforeChanges[index]) fail("RECOVERY_BUYOUT_SOURCE_CHANGED"); });
    physicalRoot = fs.realpathSync(temporaryRoot);
    const output = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()), physicalRoot) || !inside(physicalRoot, output) || exists(output) ||
        !sources.every(reader => inside(physicalRoot, fs.realpathSync(reader.name)))) fail("RECOVERY_BUYOUT_PATH_UNSAFE");
    assertSources(); fs.mkdirSync(output, { mode: 0o700 }); ownedDirectory = output;
    const candidatePath = path.join(output, "known-buyout-reconstructed.sqlite3");
    fs.copyFileSync(sources[0].name, candidatePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(candidatePath, 0o600);
    const open = () => openDatabase({ databasePath: candidatePath, environment: "staging", persistentRoot: physicalRoot, requirePersistentRoot: true }).database;
    database = open();
    if (!same(snapshots(readRows(database)), snapshots(evidence.before))) fail("RECOVERY_BUYOUT_SOURCE_CHANGED");
    const observed = { summer: [], providerCalls: 0, errors: 0 }, { repository, coordinator } = compose({ database, evidence, observed });
    const result = repository.buyOut(evidence.command), command = evidence.command;
    const lateLock = await coordinator.coordinateCommittedRoster({ mutationKind: "buyout", teams: [{ leagueId: command.leagueId,
      seasonId: command.seasonId, teamId: command.teamId, ownershipWitnesses: [{ ownershipId: command.ownershipId,
        ownershipVersion: command.expectedOwnershipVersion, state: "deleted" }] }] });
    const expectedSummer = [{ inTransaction: true, command: { leagueId: command.leagueId, affectedTeamIds: [command.teamId],
      affectedPlayerIds: [command.playerId], sourceOperationId: command.buyoutId, sourceKind: "buyout", nowMs: command.occurredAtMs },
      result: { leagueId: command.leagueId, sourceOperationId: command.buyoutId, sourceKind: "buyout", affectedCardCount: 0, changedCardCount: 0, cards: [] } }];
    if (!same(lateLock, { status: "not_applicable" }) || !same(observed.summer, expectedSummer) || observed.providerCalls !== 0 || observed.errors !== 0 ||
        !same(snapshots(readRows(database)), evidence.tableSnapshots)) fail("RECOVERY_BUYOUT_EXECUTION_INVALID");
    assertSources(); database.close(); database = null;
    database = open();
    const reopened = compose({ database, evidence, observed }).repository.buyOut(evidence.command);
    if (!same(reopened, result) || database.prepare("SELECT total_changes() n").get().n !== 0 ||
        !same(observed.summer, expectedSummer) || !same(snapshots(readRows(database)), evidence.tableSnapshots)) fail("RECOVERY_BUYOUT_REPLAY_INVALID");
    database.transaction(() => {
      database.prepare("INSERT INTO application_metadata(metadata_key,metadata_value,created_at_ms,updated_at_ms) VALUES(@metadata_key,@metadata_value,@created_at_ms,@updated_at_ms)").run(attribution.metadata);
      createSqliteSecurityAuditRepository({ database }).append(attribution.audit);
    }).immediate();
    if (beforeReceipt && beforeReceipt(database)?.then) fail("RECOVERY_BUYOUT_INPUT_INVALID");
    if (!same(snapshots(readRows(database)), snapshots(attribution.expected)) || database.pragma("foreign_key_check").length !== 0 ||
        !same(database.pragma("integrity_check"), [{ integrity_check: "ok" }])) fail("RECOVERY_BUYOUT_POSTCHECK_FAILED");
    database.close(); database = null; assertSources();
    const receipt = knownBuyoutReceipt({ evidence, decision: reviewedDecision, attribution, reconciledPlaintextSha256: hash(fs.readFileSync(candidatePath)) });
    database = openReadonlyDatabase({ databasePath: candidatePath });
    verifyRecoveryKnownBuyout({ reviewOptions, reconciledDatabase: database, reconciliation: receipt });
    database.close(); database = null; assertSources();
    const inspection = inspectDatabase(candidatePath);
    fs.writeFileSync(path.join(output, "known-buyout-reconstruction.json"), canonicalize(receipt) + "\n", { flag: "wx", mode: 0o600 });
    return Object.freeze({ ...receipt, reconciledDatabasePath: candidatePath, inspection });
  } catch (error) {
    try {
      if (database?.open) database.close();
      if (ownedDirectory !== null) {
        if (!inside(physicalRoot, fs.realpathSync(ownedDirectory)) || fs.lstatSync(ownedDirectory).isSymbolicLink()) fail("RECOVERY_BUYOUT_CLEANUP_FAILED");
        fs.rmSync(ownedDirectory, { recursive: true, force: false });
      }
    } catch { fail("RECOVERY_BUYOUT_CLEANUP_FAILED"); }
    if (error instanceof RecoveryKnownBuyoutError) throw error;
    fail("RECOVERY_BUYOUT_PREPARATION_FAILED");
  }
}
module.exports = { prepareRecoveryKnownBuyout };
