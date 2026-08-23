"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadStagingMaintenanceHoldConfig,
} = require("../../config/loadStagingMaintenanceHoldConfig");
const {
  openReadonlyDatabase,
} = require("../../infrastructure/database/connection");
const {
  inspectDatabase,
} = require("../../infrastructure/database/sqliteBackup");
const {
  canonicalize,
} = require("../../infrastructure/migration/sourceInventory");
const {
  migrationChecksumSetId,
} = require("../backups/createEncryptedOffsiteBackup");
const {
  readManifest,
  restoreEncryptedBackupToCleanPath,
} = require("../backups/restoreEncryptedBackupToCleanPath");
const {
  FIXTURE_NAME,
  EVENT_TYPE: STRICT_FIXTURE_EVENT_TYPE,
  SIDE_CAR_IDS,
  TEAM_NAMES,
  receiptEventId: strictFixtureReceiptId,
} = require("./prepareReleaseQaFadPrivacyGate");
const {
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixtureId,
} = require("./releaseQaFixtureContract");

const CONTRACT_VERSION = 1;
const PLAN_CODE = "RELEASE_QA_STRICT_RESTORE_PLANNED";
const EXECUTE_CODE = "RELEASE_QA_STRICT_RESTORE_MATERIALIZED";
const RECEIPT_KIND = "release-qa-strict-restore-activation-handoff";
const ABORT_PLAN_CODE = "RELEASE_QA_STRICT_RESTORE_ABORT_PLANNED";
const ABORT_EXECUTE_CODE =
  "RELEASE_QA_STRICT_RESTORE_ABORT_MATERIALIZED";
const ABORT_RECEIPT_KIND =
  "release-qa-strict-restore-abort-activation-handoff";
const NORMAL_RESTORE_MODE = "completed-strict-smoke";
const ABORT_RESTORE_MODE = "aborted-strict-smoke-rollback";
const WORK_AREA_KIND = "release-qa-strict-restore-private-work-area";
const WORK_AREA_VERSION = 1;
const MAX_DATABASE_SIZE_BYTES = 1_099_511_627_776n;
const EXPECTED_SCHEMA_VERSION = 54;
const EXPECTED_ROTATION_RECEIPT_ID =
  "9152f844-d8cd-42f7-b0d5-b12f530ad618";
const EXPECTED_ROTATION_ID = "HL-20260821-2";
const EXPECTED_ROTATION_EVENT_TYPE = "release_qa.credentials_rotated";
const EXPECTED_ROTATION_REASON =
  "operator_shared_password_recovery_r9_s0";

const DEFAULT_CONTRACT = Object.freeze({
  releaseId: "HL-20260822-1",
  serviceId: "srv-d9eo2turnols73ekb830",
  environment: "staging",
  environmentId: FIXTURE_ENVIRONMENT_ID,
  databaseId: FIXTURE_DATABASE_ID,
  persistentRoot: "/opt/render/project/data/hundo-staging",
  sourceDatabasePath:
    "/opt/render/project/data/hundo-staging/sqlite/" +
    "hundo-leago-schema54-strict-restore-HL-20260821-3.sqlite3",
  targetDatabasePath:
    "/opt/render/project/data/hundo-staging/sqlite/" +
    "hundo-leago-schema54-strict-restore-HL-20260822-1.sqlite3",
  backupId: "2044fcae-24e8-4392-a1ac-4064d9cd2807",
  manifestObjectKey:
    "staging/backups/" +
    "hundo-leago_staging_20260822T224011048Z_" +
    "2044fcae-24e8-4392-a1ac-4064d9cd2807.manifest.json",
  storageObjectKey:
    "staging/backups/" +
    "hundo-leago_staging_20260822T224011048Z_" +
    "2044fcae-24e8-4392-a1ac-4064d9cd2807.sqlite3.gz.enc",
  backupCreatedAt: "2026-08-22T22:40:11.048Z",
  backupReason: "incident-preservation",
  backupBackendBuildId: "23971a4d66ee6383c6ad54339e769dbc9a76561e",
  encryptedArtifactSha256:
    "cee039557278c41f59fa9d6a5b09cf4f69f1b9f3589cb3774420ef34be255162",
  manifestChecksum:
    "08e3d3bde81843a683017d9952b30e02dd02978181a8644323cfbd590eca2ac8",
  plaintextSha256:
    "cf3ca07d0500888edf60f2742541ace6f5b7db0e1f2fd9b57f00db56aacacabc",
  migrationChecksumSetId:
    "6032a48eb5126eff1bfa371937c3a086cb629bdbebaddfcb912cb4bb4799ff89",
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  frontendBuildId: "4dfe12d1366314e3d9df722c50771324647743c9",
});

const RESTORE_MODES = Object.freeze({
  normal: Object.freeze({
    key: NORMAL_RESTORE_MODE,
    operation: "release-qa-strict-restore-materialization",
    planCode: PLAN_CODE,
    executeCode: EXECUTE_CODE,
    planIdPrefix: "release-qa-strict-restore-v1-",
    confirmationPrefix: "MATERIALIZE-RELEASE-QA-STRICT-RESTORE",
    receiptKind: RECEIPT_KIND,
    abort: false,
  }),
  abort: Object.freeze({
    key: ABORT_RESTORE_MODE,
    operation: "release-qa-strict-restore-abort-materialization",
    planCode: ABORT_PLAN_CODE,
    executeCode: ABORT_EXECUTE_CODE,
    planIdPrefix: "release-qa-strict-restore-abort-v1-",
    confirmationPrefix:
      "ABORT-RELEASE-QA-STRICT-SMOKE-AND-MATERIALIZE-ROLLBACK",
    receiptKind: ABORT_RECEIPT_KIND,
    abort: true,
  }),
});

const ERROR_CODES = Object.freeze({
  inputInvalid: "RELEASE_QA_STRICT_RESTORE_INPUT_INVALID",
  environmentUnsafe: "RELEASE_QA_STRICT_RESTORE_ENVIRONMENT_UNSAFE",
  pathUnsafe: "RELEASE_QA_STRICT_RESTORE_PATH_UNSAFE",
  sourceChanged: "RELEASE_QA_STRICT_RESTORE_SOURCE_CHANGED",
  sourceInvalid: "RELEASE_QA_STRICT_RESTORE_SOURCE_INVALID",
  manifestMismatch: "RELEASE_QA_STRICT_RESTORE_MANIFEST_MISMATCH",
  candidateInvalid: "RELEASE_QA_STRICT_RESTORE_CANDIDATE_INVALID",
  planMismatch: "RELEASE_QA_STRICT_RESTORE_PLAN_MISMATCH",
  targetConflict: "RELEASE_QA_STRICT_RESTORE_TARGET_CONFLICT",
  temporaryConflict:
    "RELEASE_QA_STRICT_RESTORE_TEMPORARY_WORK_CONFLICT",
  publicationFailed: "RELEASE_QA_STRICT_RESTORE_PUBLICATION_FAILED",
  cleanupFailed: "RELEASE_QA_STRICT_RESTORE_CLEANUP_FAILED",
  failed: "RELEASE_QA_STRICT_RESTORE_FAILED",
});

class ReleaseQaStrictRestoreError extends Error {
  constructor(code, options = {}) {
    super(
      "The staging release-QA strict restore operation failed safely.",
      options
    );
    this.name = "ReleaseQaStrictRestoreError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new ReleaseQaStrictRestoreError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function requireRestoreMode(mode) {
  if (mode !== RESTORE_MODES.normal && mode !== RESTORE_MODES.abort) {
    fail(ERROR_CODES.inputInvalid);
  }
  return mode;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath, fsModule = fs) {
  return sha256(fsModule.readFileSync(filePath));
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isStrictChild(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exactText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.startsWith("--")
  );
}

function validateContract(contract) {
  if (
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract) ||
    !/^HL-\d{8}-[1-9]\d*$/u.test(contract.releaseId || "") ||
    !/^srv-[a-z0-9]+$/u.test(contract.serviceId || "") ||
    contract.environment !== "staging" ||
    contract.environmentId !== FIXTURE_ENVIRONMENT_ID ||
    contract.databaseId !== FIXTURE_DATABASE_ID ||
    contract.schemaVersion !== EXPECTED_SCHEMA_VERSION ||
    !path.isAbsolute(contract.persistentRoot || "") ||
    !path.isAbsolute(contract.sourceDatabasePath || "") ||
    !path.isAbsolute(contract.targetDatabasePath || "") ||
    !isStrictChild(contract.persistentRoot, contract.sourceDatabasePath) ||
    !isStrictChild(contract.persistentRoot, contract.targetDatabasePath) ||
    samePath(contract.sourceDatabasePath, contract.targetDatabasePath) ||
    !/^[a-f0-9-]{36}$/u.test(contract.backupId || "") ||
    !/^[a-f0-9]{64}$/u.test(contract.encryptedArtifactSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(contract.manifestChecksum || "") ||
    !/^[a-f0-9]{64}$/u.test(contract.plaintextSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(contract.migrationChecksumSetId || "") ||
    !/^[a-f0-9]{40}$/u.test(contract.frontendBuildId || "")
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  return contract;
}

function parseArguments(argv, { execute = false } = {}) {
  const names = new Map([
    ["--database", "sourceDatabasePath"],
    ["--target", "targetDatabasePath"],
    ["--environment", "environment"],
    ["--persistent-root", "persistentRoot"],
    ["--service-id", "serviceId"],
    ["--release-id", "releaseId"],
    ["--manifest-object-key", "manifestObjectKey"],
    ...(execute
      ? [
          ["--plan-id", "planId"],
          ["--confirmation", "confirmation"],
        ]
      : []),
  ]);
  if (!Array.isArray(argv) || argv.length !== names.size * 2) {
    fail(ERROR_CODES.inputInvalid);
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    const value = argv[index + 1];
    if (!field || Object.hasOwn(options, field) || !exactText(value)) {
      fail(ERROR_CODES.inputInvalid);
    }
    options[field] = value;
  }
  return Object.freeze(options);
}

function assertOptions(
  options,
  contract,
  { execute = false, mode = RESTORE_MODES.normal } = {}
) {
  requireRestoreMode(mode);
  for (const field of [
    "sourceDatabasePath",
    "targetDatabasePath",
    "environment",
    "persistentRoot",
    "serviceId",
    "releaseId",
    "manifestObjectKey",
  ]) {
    if (options[field] !== contract[field]) {
      fail(ERROR_CODES.inputInvalid);
    }
  }
  if (
    execute &&
    (!(new RegExp(`^${mode.planIdPrefix}[a-f0-9]{64}$`, "u")).test(
      options.planId || ""
    ) ||
      !exactText(options.confirmation))
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
}

function assertEnvironment(options, env, contract) {
  let hold;
  try {
    hold = loadStagingMaintenanceHoldConfig({ env });
  } catch (error) {
    fail(ERROR_CODES.environmentUnsafe, error);
  }
  const forbiddenImportFields = [
    "SPORTSDATAIO_NHL_API_KEY",
    "SPORTSDATAIO_NHL_API_ORIGIN",
    "SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR",
  ];
  if (
    hold.enabled !== true ||
    env.APP_ENV !== contract.environment ||
    env.NODE_ENV !== "production" ||
    env.APP_ENVIRONMENT_ID !== contract.environmentId ||
    env.DATABASE_ID !== contract.databaseId ||
    env.DATABASE_PATH !== contract.sourceDatabasePath ||
    env.PERSISTENT_DATA_ROOT !== contract.persistentRoot ||
    env.FRONTEND_BUILD_ID !== contract.frontendBuildId ||
    !/^[a-f0-9]{40}$/u.test(env.APP_BUILD_ID || "") ||
    forbiddenImportFields.some(
      (field) => env[field] !== undefined && env[field] !== null
    ) ||
    options.sourceDatabasePath !== env.DATABASE_PATH ||
    options.targetDatabasePath === env.DATABASE_PATH
  ) {
    fail(ERROR_CODES.environmentUnsafe);
  }
  return Object.freeze({ backendBuildId: env.APP_BUILD_ID });
}

function receiptPathFor(targetDatabasePath) {
  return `${targetDatabasePath}.activation-receipt.json`;
}

function temporaryWorkDirectoryFor(targetDatabasePath) {
  return path.join(
    path.dirname(targetDatabasePath),
    `.${path.basename(targetDatabasePath)}.strict-restore-work-v1`
  );
}

function workAreaPaths(contract) {
  const directory = temporaryWorkDirectoryFor(
    contract.targetDatabasePath
  );
  return Object.freeze({
    directory,
    markerPath: path.join(directory, "owner.json"),
    sourceCopyPath: path.join(directory, "held-source.sqlite3"),
    candidatePath: path.join(directory, "restored-candidate.sqlite3"),
    candidateInspectionPath: path.join(
      directory,
      "candidate-inspection.sqlite3"
    ),
    receiptBuildingPath: path.join(directory, "activation-receipt.json"),
  });
}

function pathEntryExists(entryPath, fsModule = fs) {
  try {
    fsModule.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertNoSidecars(databasePath, fsModule = fs) {
  if (
    pathEntryExists(`${databasePath}-wal`, fsModule) ||
    pathEntryExists(`${databasePath}-shm`, fsModule)
  ) {
    fail(ERROR_CODES.pathUnsafe);
  }
}

function assertPhysicalLayout(
  { contract, allowPublished, allowWorkArea = false },
  fsModule = fs
) {
  try {
    const rootStat = fsModule.lstatSync(
      contract.persistentRoot,
      { bigint: true }
    );
    const sourceStat = fsModule.lstatSync(
      contract.sourceDatabasePath,
      { bigint: true }
    );
    const targetParent = path.dirname(contract.targetDatabasePath);
    const parentStat = fsModule.lstatSync(targetParent, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      sourceStat.size <= 0n ||
      sourceStat.size > MAX_DATABASE_SIZE_BYTES
    ) {
      fail(ERROR_CODES.pathUnsafe);
    }
    const physicalRoot = fsModule.realpathSync.native(contract.persistentRoot);
    const physicalSource = fsModule.realpathSync.native(
      contract.sourceDatabasePath
    );
    const physicalParent = fsModule.realpathSync.native(targetParent);
    if (
      !samePath(physicalRoot, contract.persistentRoot) ||
      !samePath(physicalSource, contract.sourceDatabasePath) ||
      !samePath(physicalParent, targetParent) ||
      !isStrictChild(physicalRoot, physicalSource) ||
      !isStrictChild(physicalRoot, physicalParent) ||
      sourceStat.dev !== parentStat.dev ||
      rootStat.dev !== parentStat.dev
    ) {
      fail(ERROR_CODES.pathUnsafe);
    }
    assertNoSidecars(physicalSource, fsModule);
    assertNoSidecars(contract.targetDatabasePath, fsModule);

    const targetExists = pathEntryExists(
      contract.targetDatabasePath,
      fsModule
    );
    const receiptPath = receiptPathFor(contract.targetDatabasePath);
    const receiptExists = pathEntryExists(receiptPath, fsModule);
    const workDirectory = temporaryWorkDirectoryFor(
      contract.targetDatabasePath
    );
    if (!allowWorkArea && pathEntryExists(workDirectory, fsModule)) {
      fail(ERROR_CODES.temporaryConflict);
    }
    if (!allowPublished && (targetExists || receiptExists)) {
      fail(ERROR_CODES.targetConflict);
    }
    for (const existingPath of [
      ...(targetExists ? [contract.targetDatabasePath] : []),
      ...(receiptExists ? [receiptPath] : []),
    ]) {
      const stat = fsModule.lstatSync(existingPath, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.dev !== parentStat.dev ||
        !samePath(fsModule.realpathSync.native(existingPath), existingPath)
      ) {
        fail(ERROR_CODES.targetConflict);
      }
    }
    if (targetExists && !receiptExists) {
      fail(ERROR_CODES.targetConflict);
    }
    return Object.freeze({
      persistentRoot: physicalRoot,
      sourceDatabasePath: physicalSource,
      targetDatabasePath: contract.targetDatabasePath,
      targetParent: physicalParent,
      targetParentDevice: String(parentStat.dev),
      targetExists,
      receiptExists,
      receiptPath,
      workDirectory,
      sourceDevice: String(sourceStat.dev),
      sourceInode: String(sourceStat.ino),
      sourceSizeBytes: String(sourceStat.size),
      sourceMtimeNs: String(sourceStat.mtimeNs),
    });
  } catch (error) {
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.pathUnsafe, error);
  }
}

function removeOwnedPath(filePath, fsModule = fs) {
  try {
    fsModule.rmSync(filePath, { force: true });
    fsModule.rmSync(`${filePath}-wal`, { force: true });
    fsModule.rmSync(`${filePath}-shm`, { force: true });
  } catch (error) {
    fail(ERROR_CODES.cleanupFailed, error);
  }
}

function workAreaMarkerBytes(contract) {
  return Buffer.from(`${canonicalize({
    formatVersion: WORK_AREA_VERSION,
    kind: WORK_AREA_KIND,
    releaseId: contract.releaseId,
    serviceId: contract.serviceId,
    backupId: contract.backupId,
    sourceDatabasePath: contract.sourceDatabasePath,
    targetDatabasePath: contract.targetDatabasePath,
  })}\n`, "utf8");
}

function cleanupWorkArea(work, fsModule = fs) {
  const cleanupErrors = [];
  const ownedFiles = [
    work.receiptBuildingPath,
    work.candidateInspectionPath,
    work.candidatePath,
    work.sourceCopyPath,
  ];
  for (const ownedPath of ownedFiles) {
    for (const suffix of ["-wal", "-shm", ""]) {
      try {
        fsModule.rmSync(`${ownedPath}${suffix}`, { force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  let unexpectedEntries = [];
  try {
    unexpectedEntries = fsModule.readdirSync(work.directory).filter(
      (name) => name !== path.basename(work.markerPath)
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (unexpectedEntries.length === 0 && cleanupErrors.length === 0) {
    try {
      fsModule.rmSync(work.markerPath, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  } else if (unexpectedEntries.length > 0) {
    cleanupErrors.push(
      new Error("Unexpected private restore work-area entries remain.")
    );
  }
  try {
    fsModule.rmdirSync(work.directory);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    fsyncDirectory(path.dirname(work.directory), fsModule);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    fail(
      ERROR_CODES.cleanupFailed,
      new AggregateError(cleanupErrors)
    );
  }
}

function prepareWorkArea({ contract, layout }, fsModule = fs) {
  const work = workAreaPaths(contract);
  let directoryOwned = false;
  let descriptor;
  try {
    if (
      !samePath(work.directory, layout.workDirectory) ||
      pathEntryExists(work.directory, fsModule)
    ) {
      fail(ERROR_CODES.temporaryConflict);
    }
    fsModule.mkdirSync(work.directory, { mode: 0o700 });
    directoryOwned = true;
    const stat = fsModule.lstatSync(work.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      String(stat.dev) !== layout.targetParentDevice ||
      !samePath(
        fsModule.realpathSync.native(work.directory),
        work.directory
      )
    ) {
      fail(ERROR_CODES.pathUnsafe);
    }
    descriptor = fsModule.openSync(work.markerPath, "wx", 0o600);
    fsModule.writeFileSync(descriptor, workAreaMarkerBytes(contract));
    fsModule.fsyncSync(descriptor);
    fsModule.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(work.directory, fsModule);
    fsyncDirectory(layout.targetParent, fsModule);
    return work;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // Cleanup below retains the stronger failure if it also fails.
      }
    }
    if (directoryOwned) {
      try {
        cleanupWorkArea(work, fsModule);
      } catch (cleanupError) {
        fail(
          ERROR_CODES.cleanupFailed,
          new AggregateError([error, cleanupError])
        );
      }
    }
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.pathUnsafe, error);
  }
}

function completedStrictSmokeEvidence(database, contract) {
  const receiptId = strictFixtureReceiptId(
    contract.databaseId,
    contract.releaseId
  );
  const receipt = database.prepare(`
    SELECT id, event_type, outcome, league_id,
           request_correlation_id, reason_code, occurred_at_ms
    FROM security_audit_events
    WHERE id = ?
  `).get(receiptId);
  const league = database.prepare(`
    SELECT id, name, status
    FROM leagues
    WHERE id = ?
  `).get(SIDE_CAR_IDS.leagueId);
  const assignmentCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM team_manager_assignments
    WHERE league_id = ?
  `).get(SIDE_CAR_IDS.leagueId).count;
  if (!receipt && !league && assignmentCount === 0) return null;
  if (
    !receipt ||
    receipt.event_type !== STRICT_FIXTURE_EVENT_TYPE ||
    receipt.outcome !== "success" ||
    receipt.league_id !== SIDE_CAR_IDS.leagueId ||
    receipt.request_correlation_id !== contract.releaseId ||
    !/^strict_fad_privacy_gate_v1_[a-f0-9]{16}$/u.test(
      receipt.reason_code || ""
    ) ||
    !Number.isSafeInteger(receipt.occurred_at_ms) ||
    receipt.occurred_at_ms < 0 ||
    league?.name !== FIXTURE_NAME ||
    league.status !== "active" ||
    assignmentCount !== 6
  ) {
    fail(ERROR_CODES.sourceInvalid);
  }

  const managerA = fixtureId("account:leagueAManagerOne");
  const managerB = fixtureId("account:leagueAManagerTwo");
  const commissioner = fixtureId("account:leagueACommissioner");
  const administrator = fixtureId("account:platformAdmin");
  const assignmentsFor = (teamId) => database.prepare(`
    SELECT assignment.id, assignment.user_id,
           assignment.assigned_by_user_id,
           assignment.replaces_assignment_id, assignment.status,
           assignment.assigned_at_ms, assignment.accepted_at_ms,
           assignment.ended_at_ms, assignment.version,
           membership.user_id AS membership_user_id,
           membership.permission_category,
           membership.status AS membership_status
    FROM team_manager_assignments AS assignment
    JOIN league_memberships AS membership
      ON membership.league_id = assignment.league_id
     AND membership.id = assignment.membership_id
    WHERE assignment.league_id = ? AND assignment.team_id = ?
    ORDER BY assignment.assigned_at_ms, assignment.id
  `).all(SIDE_CAR_IDS.leagueId, teamId);
  const teamOne = assignmentsFor(SIDE_CAR_IDS.teamIds[0]);
  const teamTwo = assignmentsFor(SIDE_CAR_IDS.teamIds[1]);
  const initialA = teamOne.find(
    (row) => row.replaces_assignment_id === null
  );
  const transferB = teamOne.find(
    (row) => row.replaces_assignment_id === initialA?.id
  );
  const returnedA = teamOne.find(
    (row) => row.replaces_assignment_id === transferB?.id
  );
  const membershipIsExact = (row) =>
    row?.membership_user_id === row.user_id &&
    row.permission_category === "manager" &&
    row.membership_status === "active";
  if (
    teamOne.length !== 3 ||
    teamTwo.length !== 1 ||
    !initialA ||
    initialA.user_id !== managerA ||
    initialA.status !== "ended" ||
    initialA.assigned_by_user_id !== commissioner ||
    initialA.accepted_at_ms === null ||
    initialA.ended_at_ms !== transferB?.accepted_at_ms ||
    initialA.version !== 2 ||
    !transferB ||
    transferB.user_id !== managerB ||
    transferB.assigned_by_user_id !== administrator ||
    transferB.status !== "ended" ||
    transferB.accepted_at_ms < receipt.occurred_at_ms ||
    transferB.ended_at_ms !== returnedA?.accepted_at_ms ||
    transferB.version !== 3 ||
    !returnedA ||
    returnedA.user_id !== managerA ||
    returnedA.assigned_by_user_id !== administrator ||
    returnedA.status !== "accepted" ||
    returnedA.accepted_at_ms < transferB.accepted_at_ms ||
    returnedA.ended_at_ms !== null ||
    returnedA.version !== 2 ||
    teamTwo[0].user_id !== managerB ||
    teamTwo[0].assigned_by_user_id !== commissioner ||
    teamTwo[0].replaces_assignment_id !== null ||
    teamTwo[0].status !== "accepted" ||
    teamTwo[0].ended_at_ms !== null ||
    teamTwo[0].version !== 1 ||
    ![initialA, transferB, returnedA, teamTwo[0]].every(
      membershipIsExact
    )
  ) {
    fail(ERROR_CODES.sourceInvalid);
  }

  const activities = database.prepare(`
    SELECT event_type, actor_user_id, related_id, metadata_json,
           occurred_at_ms
    FROM league_activity
    WHERE league_id = ? AND team_id = ?
      AND event_type IN (
        'team_manager_assignment_proposed',
        'team_manager_assignment_accepted'
      )
    ORDER BY occurred_at_ms, id
  `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[0]);
  let activityValid = activities.length === 4;
  const expectedActivity = new Map([
    [`team_manager_assignment_proposed:${transferB.id}`, {
      actor: administrator,
      status: "pending",
      replaces: initialA.id,
    }],
    [`team_manager_assignment_accepted:${transferB.id}`, {
      actor: managerB,
      status: "accepted",
      replaces: initialA.id,
    }],
    [`team_manager_assignment_proposed:${returnedA.id}`, {
      actor: administrator,
      status: "pending",
      replaces: transferB.id,
    }],
    [`team_manager_assignment_accepted:${returnedA.id}`, {
      actor: managerA,
      status: "accepted",
      replaces: transferB.id,
    }],
  ]);
  for (const activity of activities) {
    let metadata;
    try {
      metadata = JSON.parse(activity.metadata_json);
    } catch {
      activityValid = false;
      break;
    }
    const expected = expectedActivity.get(
      `${activity.event_type}:${activity.related_id}`
    );
    if (
      !expected ||
      activity.actor_user_id !== expected.actor ||
      activity.occurred_at_ms < receipt.occurred_at_ms ||
      metadata.assignmentId !== activity.related_id ||
      metadata.teamId !== SIDE_CAR_IDS.teamIds[0] ||
      metadata.status !== expected.status ||
      metadata.replacesAssignmentId !== expected.replaces
    ) {
      activityValid = false;
      break;
    }
    expectedActivity.delete(
      `${activity.event_type}:${activity.related_id}`
    );
  }
  if (!activityValid || expectedActivity.size !== 0) {
    fail(ERROR_CODES.sourceInvalid);
  }

  const publications = database.prepare(`
    SELECT id, aggregate_id, status, attempt_count, published_at_ms,
           last_error_code, version, payload_json, created_at_ms
    FROM outbox_events
    WHERE league_id = ?
      AND event_type = 'team.changed'
      AND aggregate_type = 'team_manager_assignment'
    ORDER BY created_at_ms, id
  `).all(SIDE_CAR_IDS.leagueId);
  const expectedPublicationIds = new Set([transferB.id, returnedA.id]);
  for (const publication of publications) {
    let payload;
    try {
      payload = JSON.parse(publication.payload_json);
    } catch {
      fail(ERROR_CODES.sourceInvalid);
    }
    const audiences = database.prepare(`
      SELECT id, league_id, outbox_event_id, audience_kind,
             team_id, user_id, created_at_ms
      FROM outbox_event_audiences
      WHERE league_id = ? AND outbox_event_id = ?
    `).all(SIDE_CAR_IDS.leagueId, publication.id);
    if (
      !expectedPublicationIds.delete(publication.aggregate_id) ||
      publication.status !== "published" ||
      publication.attempt_count !== 1 ||
      publication.published_at_ms === null ||
      publication.published_at_ms < publication.created_at_ms ||
      publication.last_error_code !== null ||
      publication.version !== 3 ||
      payload?.eventId !== publication.id ||
      payload?.type !== "team.changed" ||
      payload.leagueId !== SIDE_CAR_IDS.leagueId ||
      payload.resourceId !== publication.aggregate_id ||
      payload.version !== 2 ||
      payload.reasonCode !== "manager_assignment_changed" ||
      payload.occurredAt !== publication.created_at_ms ||
      payload.related?.teamId !== SIDE_CAR_IDS.teamIds[0] ||
      audiences.length !== 1 ||
      audiences[0].id !== publication.id ||
      audiences[0].league_id !== SIDE_CAR_IDS.leagueId ||
      audiences[0].outbox_event_id !== publication.id ||
      audiences[0].audience_kind !== "league" ||
      audiences[0].team_id !== null ||
      audiences[0].user_id !== null ||
      audiences[0].created_at_ms !== publication.created_at_ms
    ) {
      fail(ERROR_CODES.sourceInvalid);
    }
  }

  const noDrift = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM auctions WHERE league_id = ?) AS auctions,
      (SELECT COUNT(*) FROM auction_bids WHERE league_id = ?) AS bids,
      (SELECT COUNT(*) FROM auction_resolutions
        WHERE league_id = ?) AS resolutions,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id = ?) AS allocations,
      (SELECT COUNT(*) FROM free_agent_draft_allocation_events
        WHERE league_id = ?) AS allocation_events,
      (SELECT COUNT(*) FROM free_agent_draft_auction_participants
        WHERE league_id = ?) AS participants,
      (SELECT COUNT(*) FROM auctions
        WHERE league_id = ? AND updated_at_ms > ?) AS changed_auctions,
      (SELECT COUNT(*) FROM free_agent_draft_player_allocations
        WHERE league_id = ? AND updated_at_ms > ?) AS changed_allocations,
      (SELECT COUNT(*) FROM free_agent_draft_allocation_events
        WHERE league_id = ? AND occurred_at_ms > ?) AS changed_events
  `).get(
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    SIDE_CAR_IDS.leagueId,
    receipt.occurred_at_ms,
    SIDE_CAR_IDS.leagueId,
    receipt.occurred_at_ms,
    SIDE_CAR_IDS.leagueId,
    receipt.occurred_at_ms
  );
  if (
    publications.length !== 2 ||
    expectedPublicationIds.size !== 0 ||
    noDrift.auctions !== 1 ||
    noDrift.bids !== 0 ||
    noDrift.resolutions !== 0 ||
    noDrift.allocations !== 1 ||
    noDrift.allocation_events !== 3 ||
    noDrift.participants !== 2 ||
    noDrift.changed_auctions !== 0 ||
    noDrift.changed_allocations !== 0 ||
    noDrift.changed_events !== 0
  ) {
    fail(ERROR_CODES.sourceInvalid);
  }

  return Object.freeze({
    completed: true,
    fixtureReceiptId: receiptId,
    fixtureLeagueId: SIDE_CAR_IDS.leagueId,
    teamOneId: SIDE_CAR_IDS.teamIds[0],
    teamOneAssignmentChain: Object.freeze([
      initialA.id,
      transferB.id,
      returnedA.id,
    ]),
    teamOneFinalManagerUserId: managerA,
    teamTwoId: SIDE_CAR_IDS.teamIds[1],
    teamTwoUnchangedAssignmentId: teamTwo[0].id,
    teamTwoManagerUserId: managerB,
    acceptedManagerTransferPublicationCount: 2,
    auctionBidCount: 0,
    auctionResolutionCount: 0,
    allocationCount: 1,
    allocationEventCount: 3,
  });
}

function abortFixtureRootEvidence(database, contract) {
  const fixtureReceiptId = strictFixtureReceiptId(
    contract.databaseId,
    contract.releaseId
  );
  const receipt = database.prepare(`
    SELECT id, event_type, outcome, actor_user_id, target_user_id,
           league_id, session_id, request_correlation_id, reason_code,
           network_key_version, network_metadata_digest,
           client_metadata_json, unknown_account_digest, occurred_at_ms
    FROM security_audit_events
    WHERE id = ?
  `).get(fixtureReceiptId);
  const league = database.prepare(`
    SELECT id, name, status, current_season_id
    FROM leagues
    WHERE id = ?
  `).get(SIDE_CAR_IDS.leagueId);
  if (
    !receipt ||
    receipt.event_type !== STRICT_FIXTURE_EVENT_TYPE ||
    receipt.outcome !== "success" ||
    receipt.actor_user_id !== null ||
    receipt.target_user_id !== null ||
    receipt.league_id !== SIDE_CAR_IDS.leagueId ||
    receipt.session_id !== null ||
    receipt.request_correlation_id !== contract.releaseId ||
    !/^strict_fad_privacy_gate_v1_[a-f0-9]{16}$/u.test(
      receipt.reason_code || ""
    ) ||
    receipt.network_key_version !== null ||
    receipt.network_metadata_digest !== null ||
    receipt.client_metadata_json !== null ||
    receipt.unknown_account_digest !== null ||
    !Number.isSafeInteger(receipt.occurred_at_ms) ||
    receipt.occurred_at_ms < 0 ||
    !league ||
    league.id !== SIDE_CAR_IDS.leagueId ||
    league.name !== FIXTURE_NAME ||
    league.status !== "active" ||
    league.current_season_id !== SIDE_CAR_IDS.seasonId
  ) {
    fail(ERROR_CODES.sourceInvalid);
  }
  return Object.freeze({
    fixtureReceiptId,
    fixtureLeagueId: SIDE_CAR_IDS.leagueId,
    fixturePreparedAtMs: receipt.occurred_at_ms,
  });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function classifyAbortSource(database, fixture, contract) {
  try {
    const managerA = fixtureId("account:leagueAManagerOne");
    const managerB = fixtureId("account:leagueAManagerTwo");
    const commissioner = fixtureId("account:leagueACommissioner");
    const administrator = fixtureId("account:platformAdmin");
    const assignments = database.prepare(`
      SELECT assignment.id, assignment.team_id, assignment.user_id,
             assignment.assigned_by_user_id,
             assignment.replaces_assignment_id, assignment.status,
             assignment.assigned_at_ms, assignment.accepted_at_ms,
             assignment.ended_at_ms, assignment.version,
             membership.user_id AS membership_user_id,
             membership.permission_category,
             membership.status AS membership_status
      FROM team_manager_assignments AS assignment
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
      WHERE assignment.league_id = ?
      ORDER BY assignment.team_id, assignment.assigned_at_ms, assignment.id
    `).all(SIDE_CAR_IDS.leagueId);
    const teamOne = assignments.filter(
      ({ team_id: teamId }) => teamId === SIDE_CAR_IDS.teamIds[0]
    );
    const supportUsers = [managerB, managerA, managerB];
    const supportExact = SIDE_CAR_IDS.teamIds.slice(1).every(
      (teamId, index) => {
        const rows = assignments.filter(({ team_id: id }) => id === teamId);
        const row = rows[0];
        return (
          rows.length === 1 &&
          row.user_id === supportUsers[index] &&
          row.membership_user_id === row.user_id &&
          row.permission_category === "manager" &&
          row.membership_status === "active" &&
          row.assigned_by_user_id === commissioner &&
          row.replaces_assignment_id === null &&
          row.status === "accepted" &&
          row.accepted_at_ms !== null &&
          row.ended_at_ms === null &&
          row.version === 1
        );
      }
    );
    const initialA = teamOne.find(
      ({ replaces_assignment_id: replaced }) => replaced === null
    );
    const transferB = teamOne.find(
      ({ user_id: userId, replaces_assignment_id: replaced }) =>
        userId === managerB && replaced === initialA?.id
    );
    const returnedA = teamOne.find(
      ({ user_id: userId, replaces_assignment_id: replaced }) =>
        userId === managerA && replaced === transferB?.id
    );
    const membershipExact = (row) =>
      row?.membership_user_id === row.user_id &&
      row.permission_category === "manager" &&
      row.membership_status === "active";
    const initialIdentityExact =
      initialA?.user_id === managerA &&
      initialA.assigned_by_user_id === commissioner &&
      initialA.replaces_assignment_id === null &&
      initialA.accepted_at_ms !== null &&
      membershipExact(initialA);
    const transferIdentityExact =
      transferB?.assigned_by_user_id === administrator &&
      transferB.replaces_assignment_id === initialA?.id &&
      transferB.assigned_at_ms >= fixture.fixturePreparedAtMs &&
      membershipExact(transferB);
    const returnIdentityExact =
      returnedA?.assigned_by_user_id === administrator &&
      returnedA.replaces_assignment_id === transferB?.id &&
      returnedA.assigned_at_ms >= transferB?.accepted_at_ms &&
      membershipExact(returnedA);

    const activities = database.prepare(`
      SELECT event_type, actor_user_id, related_id, metadata_json
      FROM league_activity
      WHERE league_id = ? AND team_id = ?
        AND event_type IN (
          'team_manager_assignment_proposed',
          'team_manager_assignment_accepted'
        )
      ORDER BY occurred_at_ms, id
    `).all(SIDE_CAR_IDS.leagueId, SIDE_CAR_IDS.teamIds[0]);
    const activityExact = (assignment, replaced, accepted) => {
      const rows = activities.filter(
        ({ related_id: relatedId }) => relatedId === assignment?.id
      );
      if (rows.length !== (accepted ? 2 : 1)) return false;
      const proposed = rows.find(
        ({ event_type: eventType }) =>
          eventType === "team_manager_assignment_proposed"
      );
      const acceptedActivity = rows.find(
        ({ event_type: eventType }) =>
          eventType === "team_manager_assignment_accepted"
      );
      const proposedMetadata = parseJsonObject(proposed?.metadata_json);
      const acceptedMetadata = parseJsonObject(
        acceptedActivity?.metadata_json
      );
      return (
        proposed?.actor_user_id === administrator &&
        proposedMetadata?.assignmentId === assignment.id &&
        proposedMetadata.teamId === SIDE_CAR_IDS.teamIds[0] &&
        proposedMetadata.status === "pending" &&
        proposedMetadata.replacesAssignmentId === replaced.id &&
        (!accepted ||
          (acceptedActivity?.actor_user_id === assignment.user_id &&
            acceptedMetadata?.assignmentId === assignment.id &&
            acceptedMetadata.teamId === SIDE_CAR_IDS.teamIds[0] &&
            acceptedMetadata.status === "accepted" &&
            acceptedMetadata.replacesAssignmentId === replaced.id))
      );
    };
    const transferCommandEvidenceExact = (
      assignment,
      accepted,
      direction
    ) => {
      const operationPropose =
        "league.team_manager_assignment.propose.v1";
      const operationAccept =
        "league.team_manager_assignment.accept.v1";
      const prefix = direction === "to_b"
        ? `${contract.releaseId}-team1-to-b`
        : `${contract.releaseId}-team1-to-a`;
      const idempotency = database.prepare(`
        SELECT actor_user_id, operation, client_key, request_hash,
               status, result_type, result_id
        FROM idempotency_requests
        WHERE league_id = ? AND result_id = ?
          AND operation IN (?, ?)
        ORDER BY operation
      `).all(
        SIDE_CAR_IDS.leagueId,
        assignment?.id,
        operationPropose,
        operationAccept
      );
      const proposed = idempotency.find(
        ({ operation }) => operation === operationPropose
      );
      const acceptedRequest = idempotency.find(
        ({ operation }) => operation === operationAccept
      );
      const commandHash = (operation, values) => sha256(
        Buffer.from(JSON.stringify({ operation, ...values }), "utf8")
      );
      const exactRequest = (row, {
        actorUserId,
        operation,
        clientKey,
        requestHash,
      }) =>
        row?.actor_user_id === actorUserId &&
        row.operation === operation &&
        row.client_key === clientKey &&
        row.request_hash === requestHash &&
        row.status === "completed" &&
        row.result_type === "team_manager_assignment" &&
        row.result_id === assignment.id;
      if (
        idempotency.length !== (accepted ? 2 : 1) ||
        !exactRequest(proposed, {
          actorUserId: administrator,
          operation: operationPropose,
          clientKey: `${prefix}-propose`,
          requestHash: commandHash(operationPropose, {
            leagueId: SIDE_CAR_IDS.leagueId,
            teamId: SIDE_CAR_IDS.teamIds[0],
            userId: assignment.user_id,
          }),
        }) ||
        (accepted &&
          !exactRequest(acceptedRequest, {
            actorUserId: assignment.user_id,
            operation: operationAccept,
            clientKey: `${prefix}-accept`,
            requestHash: commandHash(operationAccept, {
              assignmentId: assignment.id,
            }),
          }))
      ) {
        return false;
      }

      const notifications = database.prepare(`
        SELECT user_id, league_id, event_type, message_data_json,
               related_feature, related_record_id, delivery_status,
               created_at_ms, delivered_at_ms
        FROM notifications
        WHERE related_feature = 'team_manager_assignment'
          AND related_record_id = ?
      `).all(assignment.id);
      const notification = notifications[0];
      const message = parseJsonObject(notification?.message_data_json);
      return (
        notifications.length === 1 &&
        notification.user_id === assignment.user_id &&
        notification.league_id === SIDE_CAR_IDS.leagueId &&
        notification.event_type === "team_manager_assignment_proposed" &&
        notification.related_feature === "team_manager_assignment" &&
        notification.related_record_id === assignment.id &&
        notification.delivery_status === "delivered" &&
        notification.created_at_ms === assignment.assigned_at_ms &&
        notification.delivered_at_ms === assignment.assigned_at_ms &&
        message &&
        Object.keys(message).sort().join("\0") === [
          "assignmentId",
          "leagueId",
          "leagueName",
          "teamId",
          "teamName",
        ].sort().join("\0") &&
        message.assignmentId === assignment.id &&
        message.leagueId === SIDE_CAR_IDS.leagueId &&
        message.leagueName === FIXTURE_NAME &&
        message.teamId === SIDE_CAR_IDS.teamIds[0] &&
        message.teamName === TEAM_NAMES[0]
      );
    };

    const publications = database.prepare(`
      SELECT id, aggregate_id, status, attempt_count, published_at_ms,
             last_error_code, version, payload_json, created_at_ms,
             available_at_ms
      FROM outbox_events
      WHERE league_id = ?
        AND event_type = 'team.changed'
        AND aggregate_type = 'team_manager_assignment'
      ORDER BY created_at_ms, id
    `).all(SIDE_CAR_IDS.leagueId);
    const publicationState = (assignment) => {
      const row = publications.find(
        ({ aggregate_id: aggregateId }) => aggregateId === assignment?.id
      );
      const payload = parseJsonObject(row?.payload_json);
      const audiences = row
        ? database.prepare(`
            SELECT id, league_id, outbox_event_id, audience_kind,
                   team_id, user_id, created_at_ms
            FROM outbox_event_audiences
            WHERE outbox_event_id = ?
          `).all(
            row.id
          )
        : [];
      if (
        !row ||
        payload?.eventId !== row.id ||
        payload.type !== "team.changed" ||
        payload.leagueId !== SIDE_CAR_IDS.leagueId ||
        payload.resourceId !== assignment.id ||
        payload.version !== 2 ||
        payload.reasonCode !== "manager_assignment_changed" ||
        payload.occurredAt !== row.created_at_ms ||
        payload.related?.teamId !== SIDE_CAR_IDS.teamIds[0] ||
        audiences.length !== 1 ||
        audiences[0].id !== row.id ||
        audiences[0].league_id !== SIDE_CAR_IDS.leagueId ||
        audiences[0].outbox_event_id !== row.id ||
        audiences[0].audience_kind !== "league" ||
        audiences[0].team_id !== null ||
        audiences[0].user_id !== null ||
        audiences[0].created_at_ms !== row.created_at_ms
      ) {
        return "unclassified";
      }
      if (
        row.status === "pending" &&
        row.attempt_count === 0 &&
        row.available_at_ms === row.created_at_ms &&
        row.published_at_ms === null &&
        row.last_error_code === null &&
        row.version === 1
      ) {
        return "pending";
      }
      if (
        row.status === "publishing" &&
        row.attempt_count === 1 &&
        row.available_at_ms === row.created_at_ms &&
        row.published_at_ms === null &&
        row.last_error_code === null &&
        row.version === 2
      ) {
        return "publishing";
      }
      if (
        row.status === "failed" &&
        row.attempt_count === 1 &&
        row.available_at_ms > row.created_at_ms &&
        row.published_at_ms === null &&
        /^[A-Z][A-Z0-9_]{0,99}$/u.test(row.last_error_code || "") &&
        row.version === 3
      ) {
        return "failed";
      }
      if (
        row.status === "published" &&
        row.attempt_count === 1 &&
        row.available_at_ms === row.created_at_ms &&
        row.published_at_ms >= row.created_at_ms &&
        row.last_error_code === null &&
        row.version === 3
      ) {
        return "published";
      }
      return "unclassified";
    };

    let classification = "unclassified";
    let phaseOnePublicationState = "none";
    let returnPublicationState = "none";
    if (
      supportExact &&
      assignments.length === 4 &&
      teamOne.length === 1 &&
      initialIdentityExact &&
      initialA.status === "accepted" &&
      initialA.ended_at_ms === null &&
      initialA.version === 1 &&
      activities.length === 0 &&
      publications.length === 0
    ) {
      classification = "prepared_only";
    } else if (
      supportExact &&
      assignments.length === 5 &&
      teamOne.length === 2 &&
      initialIdentityExact &&
      initialA.status === "accepted" &&
      initialA.ended_at_ms === null &&
      initialA.version === 1 &&
      transferIdentityExact &&
      transferB.status === "pending" &&
      transferB.accepted_at_ms === null &&
      transferB.ended_at_ms === null &&
      transferB.version === 1 &&
      activityExact(transferB, initialA, false) &&
      transferCommandEvidenceExact(transferB, false, "to_b") &&
      activities.length === 1 &&
      publications.length === 0
    ) {
      classification = "to_b_pending";
    } else if (
      supportExact &&
      assignments.length === 5 &&
      teamOne.length === 2 &&
      initialIdentityExact &&
      initialA.status === "ended" &&
      initialA.ended_at_ms === transferB?.accepted_at_ms &&
      initialA.version === 2 &&
      transferIdentityExact &&
      transferB.status === "accepted" &&
      transferB.accepted_at_ms !== null &&
      transferB.ended_at_ms === null &&
      transferB.version === 2 &&
      activityExact(transferB, initialA, true) &&
      transferCommandEvidenceExact(transferB, true, "to_b") &&
      activities.length === 2 &&
      publications.length === 1
    ) {
      phaseOnePublicationState = publicationState(transferB);
      if (phaseOnePublicationState !== "unclassified") {
        classification = "to_b_accepted";
      }
    } else if (
      supportExact &&
      assignments.length === 6 &&
      teamOne.length === 3 &&
      initialIdentityExact &&
      initialA.status === "ended" &&
      initialA.ended_at_ms === transferB?.accepted_at_ms &&
      initialA.version === 2 &&
      transferIdentityExact &&
      transferB.status === "accepted" &&
      transferB.accepted_at_ms !== null &&
      transferB.ended_at_ms === null &&
      transferB.version === 2 &&
      returnIdentityExact &&
      returnedA.status === "pending" &&
      returnedA.accepted_at_ms === null &&
      returnedA.ended_at_ms === null &&
      returnedA.version === 1 &&
      activityExact(transferB, initialA, true) &&
      activityExact(returnedA, transferB, false) &&
      transferCommandEvidenceExact(transferB, true, "to_b") &&
      transferCommandEvidenceExact(returnedA, false, "return_to_a") &&
      activities.length === 3 &&
      publications.length === 1
    ) {
      phaseOnePublicationState = publicationState(transferB);
      if (phaseOnePublicationState === "published") {
        classification = "return_to_a_pending";
      }
    } else if (
      supportExact &&
      assignments.length === 6 &&
      teamOne.length === 3 &&
      initialIdentityExact &&
      initialA.status === "ended" &&
      initialA.ended_at_ms === transferB?.accepted_at_ms &&
      initialA.version === 2 &&
      transferIdentityExact &&
      transferB.status === "ended" &&
      transferB.ended_at_ms === returnedA?.accepted_at_ms &&
      transferB.version === 3 &&
      returnIdentityExact &&
      returnedA.status === "accepted" &&
      returnedA.accepted_at_ms !== null &&
      returnedA.ended_at_ms === null &&
      returnedA.version === 2 &&
      activityExact(transferB, initialA, true) &&
      activityExact(returnedA, transferB, true) &&
      transferCommandEvidenceExact(transferB, true, "to_b") &&
      transferCommandEvidenceExact(returnedA, true, "return_to_a") &&
      activities.length === 4 &&
      publications.length === 2
    ) {
      phaseOnePublicationState = publicationState(transferB);
      returnPublicationState = publicationState(returnedA);
      if (
        phaseOnePublicationState === "published" &&
        returnPublicationState !== "unclassified"
      ) {
        classification = "return_to_a_accepted";
      }
    }
    return Object.freeze({
      classification,
      phaseOnePublicationState,
      returnPublicationState,
      sourceSemanticChainCompleted:
        classification === "return_to_a_accepted",
    });
  } catch {
    return Object.freeze({
      classification: "unclassified",
      phaseOnePublicationState: "unclassified",
      returnPublicationState: "unclassified",
      sourceSemanticChainCompleted: false,
    });
  }
}

function abortStrictSmokeEvidence(database, contract) {
  const fixture = abortFixtureRootEvidence(database, contract);
  const classified = classifyAbortSource(database, fixture, contract);
  if (classified.classification === "unclassified") {
    fail(ERROR_CODES.sourceInvalid);
  }
  return Object.freeze({
    ...fixture,
    ...classified,
    smokeCompleted: false,
    hostedSmokeCompleted: false,
    releaseBlocked: true,
    rollbackOnly: true,
  });
}

function inspectCopy(
  {
    sourcePath,
    temporaryPath,
    contract,
    kind,
    mode = RESTORE_MODES.normal,
  },
  fsModule
) {
  requireRestoreMode(mode);
  let copied = false;
  try {
    fsModule.copyFileSync(
      sourcePath,
      temporaryPath,
      fsModule.constants.COPYFILE_EXCL
    );
    copied = true;
    fsModule.chmodSync(temporaryPath, 0o600);
    if (hashFile(temporaryPath, fsModule) !== hashFile(sourcePath, fsModule)) {
      fail(ERROR_CODES.sourceChanged);
    }
    const inspection = inspectDatabase(temporaryPath);
    const database = openReadonlyDatabase({ databasePath: temporaryPath });
    try {
      database.pragma("query_only = ON");
      const dataModelVersion = database.prepare(`
        SELECT metadata_value AS value
        FROM application_metadata
        WHERE metadata_key = 'data_model_version'
      `).get()?.value;
      const rotationReceipt = database.prepare(`
        SELECT event_type, outcome, request_correlation_id, reason_code
        FROM security_audit_events
        WHERE id = ?
      `).get(EXPECTED_ROTATION_RECEIPT_ID);
      const activeSessionCount = database.prepare(`
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE status = 'active'
      `).get().count;
      let strictSmokeEvidence;
      try {
        strictSmokeEvidence =
          mode.abort && kind !== "candidate"
            ? abortStrictSmokeEvidence(database, contract)
            : completedStrictSmokeEvidence(database, contract);
      } catch (error) {
        fail(
          kind === "candidate"
            ? ERROR_CODES.candidateInvalid
            : ERROR_CODES.sourceInvalid,
          error
        );
      }
      const checksumSetId = migrationChecksumSetId(
        inspection.migrations
      );
      if (
        inspection.integrity !== "ok" ||
        inspection.foreignKeyViolationCount !== 0 ||
        inspection.userVersion !== contract.schemaVersion ||
        inspection.migrations.length !== contract.schemaVersion ||
        dataModelVersion !== String(contract.schemaVersion) ||
        inspection.databaseIdentity.environmentId !==
          contract.environmentId ||
        inspection.databaseIdentity.databaseId !== contract.databaseId ||
        checksumSetId !== contract.migrationChecksumSetId ||
        !rotationReceipt ||
        rotationReceipt.event_type !== EXPECTED_ROTATION_EVENT_TYPE ||
        rotationReceipt.outcome !== "success" ||
        rotationReceipt.request_correlation_id !== EXPECTED_ROTATION_ID ||
        rotationReceipt.reason_code !== EXPECTED_ROTATION_REASON ||
        (kind === "candidate" && activeSessionCount !== 0) ||
        (kind === "candidate" && strictSmokeEvidence !== null) ||
        (kind === "source-for-execute" &&
          strictSmokeEvidence?.completed !== true)
      ) {
        fail(
          kind === "candidate"
            ? ERROR_CODES.candidateInvalid
            : ERROR_CODES.sourceInvalid
        );
      }
      return Object.freeze({
        inspection,
        inspectionSha256: sha256(Buffer.from(canonicalize(inspection))),
        checksumSetId,
        strictSmokeEvidence,
      });
    } finally {
      if (database?.open) database.close();
    }
  } catch (error) {
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(
      kind === "candidate"
        ? ERROR_CODES.candidateInvalid
        : ERROR_CODES.sourceInvalid,
      error
    );
  } finally {
    if (copied) removeOwnedPath(temporaryPath, fsModule);
  }
}

function sourceEvidence({
  layout,
  contract,
  work,
  fsModule,
  execute,
  mode,
}) {
  const sourceSha256 = hashFile(layout.sourceDatabasePath, fsModule);
  const kind = mode.abort
    ? "source-for-abort"
    : execute
      ? "source-for-execute"
      : "source-for-plan";
  const details = inspectCopy(
    {
      sourcePath: layout.sourceDatabasePath,
      temporaryPath: work.sourceCopyPath,
      contract,
      kind,
      mode,
    },
    fsModule
  );
  return Object.freeze({
    sourceSha256,
    sourceSizeBytes: layout.sourceSizeBytes,
    sourceMtimeNs: layout.sourceMtimeNs,
    sourceDevice: layout.sourceDevice,
    sourceInode: layout.sourceInode,
    inspectionSha256: details.inspectionSha256,
    strictSmokeEvidence: details.strictSmokeEvidence,
  });
}

function assertSourceUnchanged({ layout, evidence, contract }, fsModule) {
  const current = assertPhysicalLayout(
    { contract, allowPublished: true, allowWorkArea: true },
    fsModule
  );
  if (
    current.sourceDevice !== evidence.sourceDevice ||
    current.sourceInode !== evidence.sourceInode ||
    current.sourceSizeBytes !== evidence.sourceSizeBytes ||
    current.sourceMtimeNs !== evidence.sourceMtimeNs ||
    hashFile(current.sourceDatabasePath, fsModule) !== evidence.sourceSha256 ||
    !samePath(current.sourceDatabasePath, layout.sourceDatabasePath)
  ) {
    fail(ERROR_CODES.sourceChanged);
  }
}

async function readExpectedManifest({ objectStorage, contract }) {
  let object;
  let remote;
  let manifest;
  try {
    [object, remote] = await Promise.all([
      objectStorage.getPrivateObject({
        objectKey: contract.manifestObjectKey,
      }),
      objectStorage.headPrivateObject({
        objectKey: contract.manifestObjectKey,
      }),
    ]);
    if (
      !Buffer.isBuffer(object?.body) ||
      remote?.byteSize !== object.body.length ||
      remote?.sha256 !== sha256(object.body)
    ) {
      fail(ERROR_CODES.manifestMismatch);
    }
    manifest = readManifest(object.body);
  } catch (error) {
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.manifestMismatch, error);
  }
  const exactFields = {
    backupId: contract.backupId,
    manifestObjectKey: contract.manifestObjectKey,
    storageObjectKey: contract.storageObjectKey,
    environment: contract.environment,
    environmentId: contract.environmentId,
    databaseId: contract.databaseId,
    createdAt: contract.backupCreatedAt,
    reason: contract.backupReason,
    backendBuildId: contract.backupBackendBuildId,
    schemaVersion: contract.schemaVersion,
    migrationChecksumSetId: contract.migrationChecksumSetId,
    encryptedArtifactSha256: contract.encryptedArtifactSha256,
    manifestChecksum: contract.manifestChecksum,
    plainBackupSha256: contract.plaintextSha256,
  };
  if (
    Object.entries(exactFields).some(
      ([field, expected]) => manifest[field] !== expected
    ) ||
    manifest.verificationResults?.integrity !== "ok" ||
    manifest.verificationResults?.foreignKeyViolationCount !== 0 ||
    manifest.verificationResults?.remoteByteSizeMatched !== true ||
    manifest.verificationResults?.remoteSha256Matched !== true
  ) {
    fail(ERROR_CODES.manifestMismatch);
  }
  return Object.freeze({ manifest, manifestObjectSha256: remote.sha256 });
}

async function restoreCandidate({
  contract,
  mode,
  objectStorage,
  keyResolver,
  restoreFunction,
  work,
  fsModule,
}) {
  const temporaryPath = work.candidatePath;
  let restored;
  try {
    restored = await restoreFunction({
      manifestObjectKey: contract.manifestObjectKey,
      objectStorage,
      keyResolver,
      expectedEnvironment: contract.environment,
      expectedEnvironmentId: contract.environmentId,
      expectedDatabaseId: contract.databaseId,
      targetDatabasePath: temporaryPath,
      temporaryRoot: work.directory,
    });
    const candidateStat = fsModule.lstatSync(
      temporaryPath,
      { bigint: true }
    );
    if (
      restored.targetDatabasePath !== temporaryPath ||
      !candidateStat.isFile() ||
      candidateStat.isSymbolicLink() ||
      candidateStat.size <= 0n ||
      candidateStat.size > MAX_DATABASE_SIZE_BYTES ||
      !samePath(fsModule.realpathSync.native(temporaryPath), temporaryPath)
    ) {
      fail(ERROR_CODES.candidateInvalid);
    }
    if (
      restored.backupId !== contract.backupId ||
      restored.plaintextSha256 !== contract.plaintextSha256 ||
      hashFile(temporaryPath, fsModule) !== contract.plaintextSha256
    ) {
      fail(ERROR_CODES.candidateInvalid);
    }
    const verified = inspectCopy(
      {
        sourcePath: temporaryPath,
        temporaryPath: work.candidateInspectionPath,
        contract,
        kind: "candidate",
        mode,
      },
      fsModule
    );
    if (
      canonicalize(restored.inspection) !==
        canonicalize(verified.inspection)
    ) {
      fail(ERROR_CODES.candidateInvalid);
    }
    return Object.freeze({
      temporaryPath,
      inspectionSha256: verified.inspectionSha256,
    });
  } catch (error) {
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.candidateInvalid, error);
  }
}

function planPayload({
  contract,
  runtime,
  source,
  candidate,
  manifest,
  mode,
}) {
  requireRestoreMode(mode);
  const payload = {
    contractVersion: CONTRACT_VERSION,
    operation: mode.operation,
    releaseId: contract.releaseId,
    serviceId: contract.serviceId,
    environment: contract.environment,
    environmentId: contract.environmentId,
    databaseId: contract.databaseId,
    backendBuildId: runtime.backendBuildId,
    frontendBuildId: contract.frontendBuildId,
    schemaVersion: contract.schemaVersion,
    migrationChecksumSetId: contract.migrationChecksumSetId,
    sourceDatabasePath: contract.sourceDatabasePath,
    targetDatabasePath: contract.targetDatabasePath,
    receiptPath: receiptPathFor(contract.targetDatabasePath),
    sourceSha256: source.sourceSha256,
    sourceSizeBytes: source.sourceSizeBytes,
    sourceMtimeNs: source.sourceMtimeNs,
    sourceDevice: source.sourceDevice,
    sourceInode: source.sourceInode,
    sourceInspectionSha256: source.inspectionSha256,
    backupId: contract.backupId,
    manifestObjectKey: contract.manifestObjectKey,
    manifestObjectSha256: manifest.manifestObjectSha256,
    manifestChecksum: contract.manifestChecksum,
    storageObjectKey: contract.storageObjectKey,
    encryptedArtifactSha256: contract.encryptedArtifactSha256,
    plaintextSha256: contract.plaintextSha256,
    candidateInspectionSha256: candidate.inspectionSha256,
  };
  if (mode.abort) {
    Object.assign(payload, {
      restoreMode: mode.key,
      smokeCompleted: false,
      hostedSmokeCompleted: false,
      releaseBlocked: true,
      rollbackOnly: true,
      sourceAbortEvidence: source.strictSmokeEvidence,
    });
  } else {
    payload.sourceStrictSmokeEvidence = source.strictSmokeEvidence;
  }
  return Object.freeze(payload);
}

function planIdFor(payload, mode = RESTORE_MODES.normal) {
  requireRestoreMode(mode);
  return `${mode.planIdPrefix}${sha256(
    Buffer.from(canonicalize(payload))
  )}`;
}

function confirmationFor({
  planId,
  contract = DEFAULT_CONTRACT,
  mode = RESTORE_MODES.normal,
} = {}) {
  requireRestoreMode(mode);
  if (
    !(new RegExp(`^${mode.planIdPrefix}[a-f0-9]{64}$`, "u")).test(
      planId || ""
    )
  ) {
    fail(ERROR_CODES.inputInvalid);
  }
  return [
    mode.confirmationPrefix,
    planId,
    contract.serviceId,
    contract.releaseId,
    contract.environment,
    contract.environmentId,
    contract.databaseId,
    contract.backupId,
  ].join(":");
}

function receiptBytes({
  payload,
  planId,
  contract,
  mode = RESTORE_MODES.normal,
}) {
  requireRestoreMode(mode);
  const receipt = {
    formatVersion: CONTRACT_VERSION,
    kind: mode.receiptKind,
    planId,
    releaseId: contract.releaseId,
    serviceId: contract.serviceId,
    environment: contract.environment,
    environmentId: contract.environmentId,
    databaseId: contract.databaseId,
    backendBuildId: payload.backendBuildId,
    frontendBuildId: payload.frontendBuildId,
    schemaVersion: payload.schemaVersion,
    migrationChecksumSetId: payload.migrationChecksumSetId,
    sourceDatabasePath: contract.sourceDatabasePath,
    targetDatabasePath: contract.targetDatabasePath,
    backupId: contract.backupId,
    manifestObjectKey: contract.manifestObjectKey,
    manifestChecksum: contract.manifestChecksum,
    encryptedArtifactSha256: contract.encryptedArtifactSha256,
    plaintextSha256: contract.plaintextSha256,
    sourceSha256: payload.sourceSha256,
    sourceInspectionSha256: payload.sourceInspectionSha256,
    candidateInspectionSha256: payload.candidateInspectionSha256,
    planPayloadSha256: sha256(
      Buffer.from(canonicalize(payload), "utf8")
    ),
    planPayload: payload,
    confirmationSha256: sha256(
      Buffer.from(confirmationFor({ planId, contract, mode }), "utf8")
    ),
    oldSourcePreserved: true,
    targetInactive: true,
  };
  if (mode.abort) {
    Object.assign(receipt, {
      restoreMode: mode.key,
      smokeCompleted: false,
      hostedSmokeCompleted: false,
      sourceSemanticChainCompleted:
        payload.sourceAbortEvidence.sourceSemanticChainCompleted,
      releaseBlocked: true,
      rollbackOnly: true,
    });
  }
  return Buffer.from(`${canonicalize(receipt)}\n`, "utf8");
}

function resultBase({
  code,
  payload,
  planId,
  contract,
  receiptSha256,
  mode = RESTORE_MODES.normal,
}) {
  requireRestoreMode(mode);
  const sharedVerification = {
    sourceIntegrity: "ok",
    sourceForeignKeyViolationCount: 0,
    targetIntegrity: "ok",
    targetForeignKeyViolationCount: 0,
    targetActiveSessionCount: 0,
    targetRotationReceiptId: EXPECTED_ROTATION_RECEIPT_ID,
    targetStrictFixtureReceiptCount: 0,
    targetStrictFixtureLeagueCount: 0,
    sourceSidecarsAbsent: true,
    targetSidecarsAbsent: true,
  };
  const verification = mode.abort
    ? Object.freeze({
        ...sharedVerification,
        sourceFixtureReceiptId:
          payload.sourceAbortEvidence.fixtureReceiptId,
        sourceFixtureLeagueId:
          payload.sourceAbortEvidence.fixtureLeagueId,
        sourceStateClassification:
          payload.sourceAbortEvidence.classification,
        sourceSemanticChainCompleted:
          payload.sourceAbortEvidence.sourceSemanticChainCompleted,
        sourceHostedSmokeCompleted: false,
        sourcePublishedManagerTransferCount:
          Number(
            payload.sourceAbortEvidence.phaseOnePublicationState ===
              "published"
          ) +
          Number(
            payload.sourceAbortEvidence.returnPublicationState ===
              "published"
          ),
        releaseBlocked: true,
        rollbackOnly: true,
      })
    : Object.freeze({
        ...sharedVerification,
        sourceStrictSmokeCompleted:
          payload.sourceStrictSmokeEvidence?.completed === true,
        sourceAcceptedManagerTransferPublicationCount:
          payload.sourceStrictSmokeEvidence
            ?.acceptedManagerTransferPublicationCount ?? 0,
      });
  const result = {
    code,
    contractVersion: CONTRACT_VERSION,
    releaseId: contract.releaseId,
    planId,
    serviceId: contract.serviceId,
    environment: contract.environment,
    environmentId: contract.environmentId,
    databaseId: contract.databaseId,
    schemaVersion: contract.schemaVersion,
    migrationChecksumSetId: contract.migrationChecksumSetId,
    backupId: contract.backupId,
    manifestObjectKey: contract.manifestObjectKey,
    manifestChecksum: contract.manifestChecksum,
    encryptedArtifactSha256: contract.encryptedArtifactSha256,
    plaintextSha256: contract.plaintextSha256,
    sourceSha256: payload.sourceSha256,
    sourceInspectionSha256: payload.sourceInspectionSha256,
    candidateInspectionSha256: payload.candidateInspectionSha256,
    receiptSha256,
    verification,
    activationHandoff: Object.freeze({
      variable: "DATABASE_PATH",
      oldValue: contract.sourceDatabasePath,
      newValue: contract.targetDatabasePath,
      receiptPath: receiptPathFor(contract.targetDatabasePath),
      oldSourcePreserved: true,
      targetInactive: true,
      externalActivationRequired: true,
      renderEnvironmentChanged: false,
      requiredExecutionContext: "attached-render-service-shell",
      operatorAssertedServiceId: contract.serviceId,
      renderServiceIdentityIndependentlyVerified: false,
    }),
  };
  if (mode.abort) {
    Object.assign(result, {
      restoreMode: mode.key,
      smokeCompleted: false,
      hostedSmokeCompleted: false,
      sourceSemanticChainCompleted:
        payload.sourceAbortEvidence.sourceSemanticChainCompleted,
      sourceStateClassification:
        payload.sourceAbortEvidence.classification,
      sourcePhaseOnePublicationState:
        payload.sourceAbortEvidence.phaseOnePublicationState,
      sourceReturnPublicationState:
        payload.sourceAbortEvidence.returnPublicationState,
      releaseBlocked: true,
      rollbackOnly: true,
      activationHandoff: Object.freeze({
        ...result.activationHandoff,
        releaseBlocked: true,
        rollbackOnly: true,
      }),
    });
  }
  return Object.freeze(result);
}

async function buildPlan({
  options,
  env,
  contract,
  objectStorage,
  keyResolver,
  execute,
  fsModule,
  restoreFunction,
  mode,
}) {
  requireRestoreMode(mode);
  validateContract(contract);
  assertOptions(options, contract, { execute, mode });
  const runtime = assertEnvironment(options, env, contract);
  const layout = assertPhysicalLayout(
    { contract, allowPublished: execute },
    fsModule
  );
  const work = prepareWorkArea({ contract, layout }, fsModule);
  try {
    const source = sourceEvidence({
      layout,
      contract,
      work,
      fsModule,
      execute,
      mode,
    });
    const manifest = await readExpectedManifest({ objectStorage, contract });
    const candidate = await restoreCandidate({
      contract,
      mode,
      objectStorage,
      keyResolver,
      restoreFunction,
      work,
      fsModule,
    });
    const payload = planPayload({
      contract,
      runtime,
      source,
      candidate,
      manifest,
      mode,
    });
    const planId = planIdFor(payload, mode);
    const receipt = receiptBytes({ payload, planId, contract, mode });
    assertSourceUnchanged({ layout, evidence: source, contract }, fsModule);
    return Object.freeze({
      candidate,
      contract,
      layout,
      payload,
      planId,
      receipt,
      receiptSha256: sha256(receipt),
      source,
      work,
      mode,
    });
  } catch (error) {
    try {
      cleanupWorkArea(work, fsModule);
    } catch (cleanupError) {
      fail(
        ERROR_CODES.cleanupFailed,
        new AggregateError([error, cleanupError])
      );
    }
    throw error;
  }
}

async function planForMode({
  options,
  env,
  objectStorage,
  keyResolver,
  contract = DEFAULT_CONTRACT,
  fsModule = fs,
  restoreFunction = restoreEncryptedBackupToCleanPath,
  mode,
} = {}) {
  requireRestoreMode(mode);
  const plan = await buildPlan({
    options,
    env,
    contract,
    objectStorage,
    keyResolver,
    execute: false,
    fsModule,
    restoreFunction,
    mode,
  });
  try {
    return Object.freeze({
      ...resultBase({
        code: mode.planCode,
        payload: plan.payload,
        planId: plan.planId,
        contract,
        receiptSha256: plan.receiptSha256,
        mode,
      }),
      confirmation: confirmationFor({
        planId: plan.planId,
        contract,
        mode,
      }),
      targetState: "absent",
      authoritativeDatabaseMutationCount: 0,
      durableFilesystemMutationCount: 0,
      temporaryFilesystemWork: Object.freeze({
        performed: true,
        plaintextDatabaseMaterialized: true,
        deterministicPrivateWorkDirectory: plan.work.directory,
        retained: false,
        processLocalCleanup: "verified",
        abruptTerminationRecovery:
          "fail-closed-at-deterministic-work-directory",
      }),
    });
  } finally {
    cleanupWorkArea(plan.work, fsModule);
  }
}

async function planReleaseQaStrictRestore(input = {}) {
  return planForMode({ ...input, mode: RESTORE_MODES.normal });
}

async function planAbortReleaseQaStrictRestore(input = {}) {
  return planForMode({ ...input, mode: RESTORE_MODES.abort });
}

function verifyExistingReceipt({ layout, receipt, receiptSha256 }, fsModule) {
  if (!layout.receiptExists) return false;
  let actual;
  try {
    actual = fsModule.readFileSync(layout.receiptPath);
  } catch (error) {
    fail(ERROR_CODES.targetConflict, error);
  }
  if (sha256(actual) !== receiptSha256 || !actual.equals(receipt)) {
    fail(ERROR_CODES.targetConflict);
  }
  return true;
}

function hasExactKeys(value, expectedKeys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") ===
      [...expectedKeys].sort().join("\0")
  );
}

function isBoundedSourceSize(value) {
  if (!/^[1-9]\d*$/u.test(value || "")) return false;
  try {
    return BigInt(value) <= MAX_DATABASE_SIZE_BYTES;
  } catch {
    return false;
  }
}

function assertReplaySmokeEvidence(evidence, contract) {
  const keys = [
    "completed",
    "fixtureReceiptId",
    "fixtureLeagueId",
    "teamOneId",
    "teamOneAssignmentChain",
    "teamOneFinalManagerUserId",
    "teamTwoId",
    "teamTwoUnchangedAssignmentId",
    "teamTwoManagerUserId",
    "acceptedManagerTransferPublicationCount",
    "auctionBidCount",
    "auctionResolutionCount",
    "allocationCount",
    "allocationEventCount",
  ];
  if (
    !hasExactKeys(evidence, keys) ||
    evidence.completed !== true ||
    evidence.fixtureReceiptId !== strictFixtureReceiptId(
      contract.databaseId,
      contract.releaseId
    ) ||
    evidence.fixtureLeagueId !== SIDE_CAR_IDS.leagueId ||
    evidence.teamOneId !== SIDE_CAR_IDS.teamIds[0] ||
    evidence.teamOneFinalManagerUserId !==
      fixtureId("account:leagueAManagerOne") ||
    evidence.teamTwoId !== SIDE_CAR_IDS.teamIds[1] ||
    evidence.teamTwoManagerUserId !==
      fixtureId("account:leagueAManagerTwo") ||
    evidence.acceptedManagerTransferPublicationCount !== 2 ||
    evidence.auctionBidCount !== 0 ||
    evidence.auctionResolutionCount !== 0 ||
    evidence.allocationCount !== 1 ||
    evidence.allocationEventCount !== 3 ||
    !Array.isArray(evidence.teamOneAssignmentChain) ||
    evidence.teamOneAssignmentChain.length !== 3 ||
    ![
      ...evidence.teamOneAssignmentChain,
      evidence.teamTwoUnchangedAssignmentId,
    ].every((value) => /^[a-f0-9-]{36}$/u.test(value || ""))
  ) {
    fail(ERROR_CODES.targetConflict);
  }
}

function assertReplayAbortEvidence(evidence, contract) {
  const keys = [
    "fixtureReceiptId",
    "fixtureLeagueId",
    "fixturePreparedAtMs",
    "classification",
    "phaseOnePublicationState",
    "returnPublicationState",
    "sourceSemanticChainCompleted",
    "smokeCompleted",
    "hostedSmokeCompleted",
    "releaseBlocked",
    "rollbackOnly",
  ];
  const expectedState = {
    prepared_only: Object.freeze({
      phaseOne: ["none"],
      returned: ["none"],
      semanticCompleted: false,
    }),
    to_b_pending: Object.freeze({
      phaseOne: ["none"],
      returned: ["none"],
      semanticCompleted: false,
    }),
    to_b_accepted: Object.freeze({
      phaseOne: ["pending", "publishing", "failed", "published"],
      returned: ["none"],
      semanticCompleted: false,
    }),
    return_to_a_pending: Object.freeze({
      phaseOne: ["published"],
      returned: ["none"],
      semanticCompleted: false,
    }),
    return_to_a_accepted: Object.freeze({
      phaseOne: ["published"],
      returned: ["pending", "publishing", "failed", "published"],
      semanticCompleted: true,
    }),
  }[evidence?.classification];
  if (
    !hasExactKeys(evidence, keys) ||
    !expectedState ||
    evidence.fixtureReceiptId !== strictFixtureReceiptId(
      contract.databaseId,
      contract.releaseId
    ) ||
    evidence.fixtureLeagueId !== SIDE_CAR_IDS.leagueId ||
    !Number.isSafeInteger(evidence.fixturePreparedAtMs) ||
    evidence.fixturePreparedAtMs < 0 ||
    !expectedState.phaseOne.includes(
      evidence.phaseOnePublicationState
    ) ||
    !expectedState.returned.includes(evidence.returnPublicationState) ||
    evidence.sourceSemanticChainCompleted !==
      expectedState.semanticCompleted ||
    evidence.smokeCompleted !== false ||
    evidence.hostedSmokeCompleted !== false ||
    evidence.releaseBlocked !== true ||
    evidence.rollbackOnly !== true
  ) {
    fail(ERROR_CODES.targetConflict);
  }
}

function readReplayReceipt(layout, fsModule) {
  let bytes;
  let receipt;
  try {
    bytes = fsModule.readFileSync(layout.receiptPath);
    receipt = JSON.parse(bytes.toString("utf8"));
    if (bytes.toString("utf8") !== `${canonicalize(receipt)}\n`) {
      fail(ERROR_CODES.targetConflict);
    }
  } catch (error) {
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.targetConflict, error);
  }
  return Object.freeze({ bytes, receipt });
}

function verifyReplay(
  { options, runtime, layout, contract, mode },
  fsModule
) {
  requireRestoreMode(mode);
  const { bytes, receipt } = readReplayReceipt(layout, fsModule);
  const payloadKeys = [
    "contractVersion",
    "operation",
    "releaseId",
    "serviceId",
    "environment",
    "environmentId",
    "databaseId",
    "backendBuildId",
    "frontendBuildId",
    "schemaVersion",
    "migrationChecksumSetId",
    "sourceDatabasePath",
    "targetDatabasePath",
    "receiptPath",
    "sourceSha256",
    "sourceSizeBytes",
    "sourceMtimeNs",
    "sourceDevice",
    "sourceInode",
    "sourceInspectionSha256",
    "backupId",
    "manifestObjectKey",
    "manifestObjectSha256",
    "manifestChecksum",
    "storageObjectKey",
    "encryptedArtifactSha256",
    "plaintextSha256",
    "candidateInspectionSha256",
    ...(mode.abort
      ? [
          "restoreMode",
          "smokeCompleted",
          "hostedSmokeCompleted",
          "releaseBlocked",
          "rollbackOnly",
          "sourceAbortEvidence",
        ]
      : ["sourceStrictSmokeEvidence"]),
  ];
  const payload = receipt?.planPayload;
  if (
    !hasExactKeys(payload, payloadKeys) ||
    payload.contractVersion !== CONTRACT_VERSION ||
    payload.operation !== mode.operation ||
    payload.releaseId !== contract.releaseId ||
    payload.serviceId !== contract.serviceId ||
    payload.environment !== contract.environment ||
    payload.environmentId !== contract.environmentId ||
    payload.databaseId !== contract.databaseId ||
    payload.backendBuildId !== runtime.backendBuildId ||
    payload.frontendBuildId !== contract.frontendBuildId ||
    payload.schemaVersion !== contract.schemaVersion ||
    payload.migrationChecksumSetId !== contract.migrationChecksumSetId ||
    payload.sourceDatabasePath !== contract.sourceDatabasePath ||
    payload.targetDatabasePath !== contract.targetDatabasePath ||
    payload.receiptPath !== layout.receiptPath ||
    payload.backupId !== contract.backupId ||
    payload.manifestObjectKey !== contract.manifestObjectKey ||
    payload.manifestChecksum !== contract.manifestChecksum ||
    payload.storageObjectKey !== contract.storageObjectKey ||
    payload.encryptedArtifactSha256 !==
      contract.encryptedArtifactSha256 ||
    payload.plaintextSha256 !== contract.plaintextSha256 ||
    (mode.abort &&
      (payload.restoreMode !== mode.key ||
        payload.smokeCompleted !== false ||
        payload.hostedSmokeCompleted !== false ||
        payload.releaseBlocked !== true ||
        payload.rollbackOnly !== true)) ||
    !/^[a-f0-9]{64}$/u.test(payload.sourceSha256 || "") ||
    !isBoundedSourceSize(payload.sourceSizeBytes) ||
    !/^\d+$/u.test(payload.sourceMtimeNs || "") ||
    !/^\d+$/u.test(payload.sourceDevice || "") ||
    !/^\d+$/u.test(payload.sourceInode || "") ||
    !/^[a-f0-9]{64}$/u.test(payload.manifestObjectSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(payload.sourceInspectionSha256 || "") ||
    !/^[a-f0-9]{64}$/u.test(payload.candidateInspectionSha256 || "") ||
    planIdFor(payload, mode) !== options.planId ||
    options.confirmation !== confirmationFor({
      planId: options.planId,
      contract,
      mode,
    })
  ) {
    fail(ERROR_CODES.targetConflict);
  }
  if (mode.abort) {
    assertReplayAbortEvidence(payload.sourceAbortEvidence, contract);
  } else {
    assertReplaySmokeEvidence(payload.sourceStrictSmokeEvidence, contract);
  }
  const expectedReceipt = receiptBytes({
    payload,
    planId: options.planId,
    contract,
    mode,
  });
  if (!bytes.equals(expectedReceipt)) {
    fail(ERROR_CODES.targetConflict);
  }
  if (
    layout.sourceSizeBytes !== payload.sourceSizeBytes ||
    layout.sourceMtimeNs !== payload.sourceMtimeNs ||
    layout.sourceDevice !== payload.sourceDevice ||
    layout.sourceInode !== payload.sourceInode ||
    hashFile(layout.sourceDatabasePath, fsModule) !== payload.sourceSha256 ||
    hashFile(layout.targetDatabasePath, fsModule) !==
      contract.plaintextSha256
  ) {
    fail(ERROR_CODES.targetConflict);
  }
  return Object.freeze({
    payload: Object.freeze(payload),
    receiptSha256: sha256(bytes),
  });
}

function fsyncDirectory(directoryPath, fsModule = fs) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = fsModule.openSync(directoryPath, "r");
    fsModule.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsModule.closeSync(descriptor);
  }
}

function publishReceipt({ plan, fsModule }) {
  if (plan.layout.receiptExists) return false;
  const temporaryReceipt = plan.work.receiptBuildingPath;
  let descriptor;
  let temporaryOwned = false;
  let receiptLinked = false;
  try {
    descriptor = fsModule.openSync(temporaryReceipt, "wx", 0o600);
    temporaryOwned = true;
    fsModule.writeFileSync(descriptor, plan.receipt);
    fsModule.fsyncSync(descriptor);
    fsModule.closeSync(descriptor);
    descriptor = undefined;
    fsModule.linkSync(temporaryReceipt, plan.layout.receiptPath);
    receiptLinked = true;
    fsyncDirectory(plan.layout.targetParent, fsModule);
    fsModule.unlinkSync(temporaryReceipt);
    temporaryOwned = false;
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsModule.closeSync(descriptor);
      } catch {
        // Preserve publication failure; cleanup follows.
      }
    }
    const cleanupErrors = [];
    if (receiptLinked) {
      try {
        fsModule.rmSync(plan.layout.receiptPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (temporaryOwned) {
      try {
        fsModule.rmSync(temporaryReceipt, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      fail(
        ERROR_CODES.cleanupFailed,
        new AggregateError([error, ...cleanupErrors])
      );
    }
    fail(ERROR_CODES.publicationFailed, error);
  }
}

function publishTarget({ plan, fsModule }) {
  if (plan.layout.targetExists) return false;
  let targetLinked = false;
  try {
    fsModule.linkSync(
      plan.candidate.temporaryPath,
      plan.layout.targetDatabasePath
    );
    targetLinked = true;
    fsyncDirectory(plan.layout.targetParent, fsModule);
    return true;
  } catch (error) {
    if (targetLinked) {
      try {
        fsModule.rmSync(plan.layout.targetDatabasePath, { force: true });
      } catch (cleanupError) {
        fail(
          ERROR_CODES.cleanupFailed,
          new AggregateError([error, cleanupError])
        );
      }
    }
    fail(ERROR_CODES.publicationFailed, error);
  }
}

async function executeForMode({
  options,
  env,
  objectStorage,
  keyResolver,
  contract = DEFAULT_CONTRACT,
  fsModule = fs,
  restoreFunction = restoreEncryptedBackupToCleanPath,
  failureHook,
  mode,
} = {}) {
  requireRestoreMode(mode);
  if (failureHook !== undefined && typeof failureHook !== "function") {
    fail(ERROR_CODES.inputInvalid);
  }
  validateContract(contract);
  assertOptions(options, contract, { execute: true, mode });
  const runtime = assertEnvironment(options, env, contract);
  const initialLayout = assertPhysicalLayout(
    { contract, allowPublished: true },
    fsModule
  );
  if (initialLayout.targetExists && initialLayout.receiptExists) {
    const replay = verifyReplay(
      { options, runtime, layout: initialLayout, contract, mode },
      fsModule
    );
    return Object.freeze({
      ...resultBase({
        code: mode.executeCode,
        payload: replay.payload,
        planId: options.planId,
        contract,
        receiptSha256: replay.receiptSha256,
        mode,
      }),
      replayed: true,
      authoritativeDatabaseMutationCount: 0,
      durableFilesystemMutationCount: 0,
      temporaryFilesystemWork: Object.freeze({
        performed: false,
        plaintextDatabaseMaterialized: false,
        deterministicPrivateWorkDirectory:
          initialLayout.workDirectory,
        retained: false,
        processLocalCleanup: "not-needed",
        abruptTerminationRecovery:
          "fail-closed-at-deterministic-work-directory",
      }),
      sourcePreserved: true,
      targetVerified: true,
    });
  }
  const plan = await buildPlan({
    options,
    env,
    contract,
    objectStorage,
    keyResolver,
    execute: true,
    fsModule,
    restoreFunction,
    mode,
  });
  let receiptCreated = false;
  let targetCreated = false;
  let workCleaned = false;
  try {
    if (
      options.planId !== plan.planId ||
      options.confirmation !==
        confirmationFor({ planId: plan.planId, contract, mode })
    ) {
      fail(ERROR_CODES.planMismatch);
    }
    const receiptExists = verifyExistingReceipt(plan, fsModule);
    if (
      plan.layout.targetExists &&
      hashFile(plan.layout.targetDatabasePath, fsModule) !==
        contract.plaintextSha256
    ) {
      fail(ERROR_CODES.targetConflict);
    }
    if (plan.layout.targetExists && !receiptExists) {
      fail(ERROR_CODES.targetConflict);
    }
    if (failureHook) failureHook("before-publication");
    receiptCreated = publishReceipt({ plan, fsModule });
    if (failureHook) failureHook("after-receipt");
    targetCreated = publishTarget({ plan, fsModule });
    if (failureHook) failureHook("after-target");
    if (
      hashFile(plan.layout.targetDatabasePath, fsModule) !==
        contract.plaintextSha256 ||
      hashFile(plan.layout.receiptPath, fsModule) !== plan.receiptSha256
    ) {
      fail(ERROR_CODES.publicationFailed);
    }
    assertNoSidecars(plan.layout.targetDatabasePath, fsModule);
    assertSourceUnchanged(
      { layout: plan.layout, evidence: plan.source, contract },
      fsModule
    );
    cleanupWorkArea(plan.work, fsModule);
    workCleaned = true;
    return Object.freeze({
      ...resultBase({
        code: mode.executeCode,
        payload: plan.payload,
        planId: plan.planId,
        contract,
        receiptSha256: plan.receiptSha256,
        mode,
      }),
      replayed: false,
      authoritativeDatabaseMutationCount: 0,
      durableFilesystemMutationCount:
        Number(receiptCreated) + Number(targetCreated),
      temporaryFilesystemWork: Object.freeze({
        performed: true,
        plaintextDatabaseMaterialized: true,
        deterministicPrivateWorkDirectory: plan.work.directory,
        retained: false,
        processLocalCleanup: "verified",
        abruptTerminationRecovery:
          "fail-closed-at-deterministic-work-directory",
      }),
      sourcePreserved: true,
      targetVerified: true,
    });
  } catch (error) {
    const cleanupErrors = [];
    for (const [created, ownedPath] of [
      [targetCreated, plan.layout.targetDatabasePath],
      [receiptCreated, plan.layout.receiptPath],
    ]) {
      if (!created) continue;
      try {
        fsModule.rmSync(ownedPath, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!workCleaned) {
      try {
        cleanupWorkArea(plan.work, fsModule);
        workCleaned = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      fail(
        ERROR_CODES.cleanupFailed,
        new AggregateError([error, ...cleanupErrors])
      );
    }
    if (error instanceof ReleaseQaStrictRestoreError) throw error;
    fail(ERROR_CODES.failed, error);
  }
}

async function executeReleaseQaStrictRestore(input = {}) {
  return executeForMode({ ...input, mode: RESTORE_MODES.normal });
}

async function executeAbortReleaseQaStrictRestore(input = {}) {
  return executeForMode({ ...input, mode: RESTORE_MODES.abort });
}

function abortConfirmationFor({ planId, contract = DEFAULT_CONTRACT } = {}) {
  return confirmationFor({
    planId,
    contract,
    mode: RESTORE_MODES.abort,
  });
}

module.exports = {
  ABORT_EXECUTE_CODE,
  ABORT_PLAN_CODE,
  ABORT_RECEIPT_KIND,
  ABORT_RESTORE_MODE,
  CONTRACT_VERSION,
  DEFAULT_CONTRACT,
  ERROR_CODES,
  EXECUTE_CODE,
  EXPECTED_ROTATION_RECEIPT_ID,
  PLAN_CODE,
  RECEIPT_KIND,
  ReleaseQaStrictRestoreError,
  abortConfirmationFor,
  confirmationFor,
  executeAbortReleaseQaStrictRestore,
  executeReleaseQaStrictRestore,
  parseArguments,
  planIdFor,
  planAbortReleaseQaStrictRestore,
  planReleaseQaStrictRestore,
  receiptPathFor,
  temporaryWorkDirectoryFor,
  verifyAbortStrictSmokeEvidence: abortStrictSmokeEvidence,
  verifyCompletedStrictSmokeEvidence: completedStrictSmokeEvidence,
};
