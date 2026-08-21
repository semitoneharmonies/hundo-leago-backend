#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadStagingMaintenanceHoldConfig,
} = require("../src/config/loadStagingMaintenanceHoldConfig");
const {
  openDatabase,
  openReadonlyDatabase,
} = require("../src/infrastructure/database/connection");
const {
  readDatabaseIdentity,
} = require("../src/infrastructure/database/databaseIdentity");
const {
  discoverMigrations,
  inspectMigrationState,
} = require("../src/infrastructure/database/migrate");
const {
  previewAuthorityReconciliation,
} = require("./preview-m7-26-authority-reconciliation");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "database",
  "migrations"
);
const RELEASE_ID_PATTERN = /^HL-\d{8}-[1-9]\d*$/u;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SUPPORTED_SCHEMA_VERSIONS = new Set([52, 53, 54]);
const AUDIT_EVENT_TYPE = "operations.m7_26_authority_reconciled";
const RESULT_CODE = "M7_26_STAGING_AUTHORITY_RECONCILED";
const CONTRACT_VERSION = 1;

const ERROR_CODES = Object.freeze({
  argumentInvalid: "AUTHORITY_RECONCILIATION_ARGUMENT_INVALID",
  environmentUnsafe: "AUTHORITY_RECONCILIATION_ENVIRONMENT_UNSAFE",
  targetUnsafe: "AUTHORITY_RECONCILIATION_TARGET_UNSAFE",
  identityMismatch: "AUTHORITY_RECONCILIATION_IDENTITY_MISMATCH",
  schemaUnsupported: "AUTHORITY_RECONCILIATION_SCHEMA_UNSUPPORTED",
  pointerInvalid: "AUTHORITY_RECONCILIATION_COMMISSIONER_POINTER_INVALID",
  administratorCommissioner:
    "AUTHORITY_RECONCILIATION_ADMINISTRATOR_COMMISSIONER_UNSAFE",
  administratorMembershipDuplicate:
    "AUTHORITY_RECONCILIATION_ADMINISTRATOR_MEMBERSHIP_DUPLICATE",
  administratorHistoryAmbiguous:
    "AUTHORITY_RECONCILIATION_ADMINISTRATOR_HISTORY_AMBIGUOUS",
  pendingTransfersAmbiguous:
    "AUTHORITY_RECONCILIATION_PENDING_TRANSFERS_AMBIGUOUS",
  deletedLeagueCommissionersDuplicate:
    "AUTHORITY_RECONCILIATION_DELETED_LEAGUE_COMMISSIONERS_DUPLICATE",
  deterministicIdConflict:
    "AUTHORITY_RECONCILIATION_DETERMINISTIC_ID_CONFLICT",
  auditConflict: "AUTHORITY_RECONCILIATION_AUDIT_CONFLICT",
  postcheckFailed: "AUTHORITY_RECONCILIATION_POSTCHECK_FAILED",
  writeCountMismatch: "AUTHORITY_RECONCILIATION_WRITE_COUNT_MISMATCH",
  commandFailed: "AUTHORITY_RECONCILIATION_COMMAND_FAILED",
});

class AuthorityReconciliationError extends Error {
  constructor(code, details = {}, options = {}) {
    super("The staging authority reconciliation failed safely.", options);
    this.name = "AuthorityReconciliationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, details, cause) {
  throw new AuthorityReconciliationError(
    code,
    details,
    cause === undefined ? {} : { cause }
  );
}

function exactString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.startsWith("--")
  );
}

function parseArguments(argv) {
  const optionsByName = new Map([
    ["--database", "databasePath"],
    ["--environment", "environment"],
    ["--persistent-root", "persistentRoot"],
    ["--release-id", "releaseId"],
    ["--confirmation", "confirmation"],
  ]);
  if (!Array.isArray(argv) || argv.length !== optionsByName.size * 2) {
    fail(ERROR_CODES.argumentInvalid);
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = optionsByName.get(argv[index]);
    const value = argv[index + 1];
    if (!field || Object.hasOwn(options, field) || !exactString(value)) {
      fail(ERROR_CODES.argumentInvalid);
    }
    options[field] = value;
  }
  if (
    options.environment !== "staging" ||
    !RELEASE_ID_PATTERN.test(options.releaseId) ||
    !path.isAbsolute(options.databasePath) ||
    !path.isAbsolute(options.persistentRoot) ||
    path.normalize(options.databasePath) !== options.databasePath ||
    path.normalize(options.persistentRoot) !== options.persistentRoot
  ) {
    fail(ERROR_CODES.argumentInvalid);
  }
  return Object.freeze({ ...options });
}

function confirmationFor({
  releaseId,
  environmentId,
  databaseId,
} = {}) {
  if (
    !RELEASE_ID_PATTERN.test(releaseId || "") ||
    !IDENTITY_PATTERN.test(environmentId || "") ||
    !IDENTITY_PATTERN.test(databaseId || "")
  ) {
    fail(ERROR_CODES.argumentInvalid);
  }
  return `M7-26:${releaseId}:staging:${environmentId}:${databaseId}`;
}

function assertSafeEnvironment(options, env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    fail(ERROR_CODES.environmentUnsafe);
  }
  let hold;
  try {
    hold = loadStagingMaintenanceHoldConfig({ env });
  } catch (error) {
    fail(ERROR_CODES.environmentUnsafe, {}, error);
  }
  const environmentId = env.APP_ENVIRONMENT_ID;
  const databaseId = env.DATABASE_ID;
  if (
    hold.enabled !== true ||
    env.APP_ENV !== "staging" ||
    env.DATABASE_PATH !== options.databasePath ||
    env.PERSISTENT_DATA_ROOT !== options.persistentRoot ||
    !IDENTITY_PATTERN.test(environmentId || "") ||
    !IDENTITY_PATTERN.test(databaseId || "") ||
    options.confirmation !== confirmationFor({
      releaseId: options.releaseId,
      environmentId,
      databaseId,
    })
  ) {
    fail(ERROR_CODES.environmentUnsafe);
  }
  return Object.freeze({ databaseId, environmentId });
}

function samePhysicalPath(left, right) {
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

function assertExactPhysicalTarget(
  { databasePath, persistentRoot },
  fsModule = fs
) {
  try {
    const rootStat = fsModule.lstatSync(persistentRoot);
    const databaseStat = fsModule.lstatSync(databasePath);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !databaseStat.isFile() ||
      databaseStat.isSymbolicLink()
    ) {
      fail(ERROR_CODES.targetUnsafe);
    }
    const physicalRoot = fsModule.realpathSync.native(persistentRoot);
    const physicalDatabase = fsModule.realpathSync.native(databasePath);
    if (
      !samePhysicalPath(physicalRoot, persistentRoot) ||
      !samePhysicalPath(physicalDatabase, databasePath) ||
      !isStrictChild(physicalRoot, physicalDatabase)
    ) {
      fail(ERROR_CODES.targetUnsafe);
    }
    return Object.freeze({
      databasePath: physicalDatabase,
      persistentRoot: physicalRoot,
    });
  } catch (error) {
    if (error instanceof AuthorityReconciliationError) throw error;
    fail(ERROR_CODES.targetUnsafe, {}, error);
  }
}

function assertDatabaseBinding(database, expected) {
  let identity;
  let migrationState;
  try {
    identity = readDatabaseIdentity(database);
    migrationState = inspectMigrationState(
      database,
      discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY })
    );
  } catch (error) {
    fail(ERROR_CODES.identityMismatch, {}, error);
  }
  if (
    identity.environmentId !== expected.environmentId ||
    identity.databaseId !== expected.databaseId
  ) {
    fail(ERROR_CODES.identityMismatch);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(migrationState.userVersion)) {
    fail(ERROR_CODES.schemaUnsupported, {
      schemaVersion: migrationState.userVersion,
    });
  }
  const dataModelVersion = database.prepare(`
    SELECT metadata_value AS value
    FROM application_metadata
    WHERE metadata_key = 'data_model_version'
  `).get()?.value;
  if (dataModelVersion !== String(migrationState.userVersion)) {
    fail(ERROR_CODES.schemaUnsupported, {
      schemaVersion: migrationState.userVersion,
    });
  }
  return Object.freeze({
    identity,
    schemaVersion: migrationState.userVersion,
  });
}

function deterministicUuid(value) {
  const bytes = crypto.createHash("sha256").update(value, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function stableOperationId({ databaseId, releaseId, kind, suffix = "" }) {
  return deterministicUuid(
    ["hundo-leago", "m7-26", databaseId, releaseId, kind, suffix].join("\0")
  );
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function listLeagueAuthority(database) {
  return freezeRows(database.prepare(`
    SELECT
      leagues.id AS leagueId,
      leagues.commissioner_membership_id AS commissionerMembershipId,
      pointer.league_id AS pointerLeagueId,
      pointer.user_id AS pointerUserId,
      pointer.permission_category AS pointerPermissionCategory,
      pointer.status AS pointerStatus,
      EXISTS (
        SELECT 1
        FROM platform_roles
        WHERE platform_roles.user_id = pointer.user_id
          AND platform_roles.role = 'platform_administrator'
          AND platform_roles.status = 'active'
          AND platform_roles.ended_at_ms IS NULL
      ) AS pointerIsAdministrator
    FROM leagues
    LEFT JOIN league_memberships pointer
      ON pointer.id = leagues.commissioner_membership_id
    WHERE leagues.status <> 'deleted'
    ORDER BY leagues.id
  `).all());
}

function listActiveCommissioners(database) {
  return freezeRows(database.prepare(`
    SELECT
      league_memberships.league_id AS leagueId,
      league_memberships.id AS membershipId,
      league_memberships.user_id AS userId,
      league_memberships.version AS version,
      league_memberships.created_at_ms AS createdAtMs,
      league_memberships.updated_at_ms AS updatedAtMs,
      EXISTS (
        SELECT 1
        FROM platform_roles
        WHERE platform_roles.user_id = league_memberships.user_id
          AND platform_roles.role = 'platform_administrator'
          AND platform_roles.status = 'active'
          AND platform_roles.ended_at_ms IS NULL
      ) AS isAdministrator
    FROM league_memberships
    JOIN leagues ON leagues.id = league_memberships.league_id
    WHERE leagues.status <> 'deleted'
      AND league_memberships.permission_category = 'commissioner'
      AND league_memberships.status = 'active'
    ORDER BY league_memberships.league_id,
      league_memberships.created_at_ms,
      league_memberships.id
  `).all());
}

function listAdministratorCoverage(database) {
  const pairs = database.prepare(`
    SELECT
      leagues.id AS leagueId,
      platform_roles.user_id AS userId
    FROM platform_roles
    CROSS JOIN leagues
    WHERE platform_roles.role = 'platform_administrator'
      AND platform_roles.status = 'active'
      AND platform_roles.ended_at_ms IS NULL
      AND leagues.status <> 'deleted'
    ORDER BY leagues.id, platform_roles.user_id
  `).all();
  const memberships = database.prepare(`
    SELECT
      league_id AS leagueId,
      id AS membershipId,
      user_id AS userId,
      permission_category AS permissionCategory,
      status,
      joined_at_ms AS joinedAtMs,
      ended_at_ms AS endedAtMs,
      created_at_ms AS createdAtMs,
      updated_at_ms AS updatedAtMs,
      version
    FROM league_memberships
    ORDER BY league_id, user_id, created_at_ms, id
  `).all();
  const byPair = new Map();
  for (const membership of memberships) {
    const key = `${membership.leagueId}\0${membership.userId}`;
    const existing = byPair.get(key) || [];
    existing.push(Object.freeze({ ...membership }));
    byPair.set(key, existing);
  }
  return Object.freeze(pairs.map((pair) => Object.freeze({
    ...pair,
    memberships: Object.freeze([
      ...(byPair.get(`${pair.leagueId}\0${pair.userId}`) || []),
    ]),
  })));
}

function listCurrentTeamAssignments(database, { leagueId, userId, membershipId }) {
  return freezeRows(database.prepare(`
    SELECT id AS assignmentId, team_id AS teamId
    FROM team_manager_assignments
    WHERE league_id = @leagueId
      AND user_id = @userId
      AND membership_id = @membershipId
      AND status = 'accepted'
      AND ended_at_ms IS NULL
    ORDER BY team_id, id
  `).all({ leagueId, userId, membershipId }));
}

function countByLeague(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.leagueId, (counts.get(row.leagueId) || 0) + 1);
  }
  return counts;
}

function safeFindingDetails(rows, fields) {
  return Object.freeze({
    findings: Object.freeze(rows.map((row) => Object.freeze(
      Object.fromEntries(fields.map((field) => [field, row[field]]))
    ))),
  });
}

function collectPlan(database, { databaseId, releaseId }) {
  const deletedLeagueCommissionerDuplicates = freezeRows(database.prepare(`
    SELECT
      leagues.id AS leagueId,
      COUNT(league_memberships.id) AS activeCommissionerCount
    FROM leagues
    JOIN league_memberships
      ON league_memberships.league_id = leagues.id
     AND league_memberships.permission_category = 'commissioner'
     AND league_memberships.status = 'active'
    WHERE leagues.status = 'deleted'
    GROUP BY leagues.id
    HAVING COUNT(league_memberships.id) > 1
    ORDER BY leagues.id
  `).all());
  if (deletedLeagueCommissionerDuplicates.length > 0) {
    fail(
      ERROR_CODES.deletedLeagueCommissionersDuplicate,
      safeFindingDetails(deletedLeagueCommissionerDuplicates, [
        "leagueId",
        "activeCommissionerCount",
      ])
    );
  }

  const preview = previewAuthorityReconciliation(database, {
    enforceQueryOnly: false,
  });
  if (preview.findings.duplicatePendingCommissionerTransfers.length > 0) {
    fail(
      ERROR_CODES.pendingTransfersAmbiguous,
      safeFindingDetails(
        preview.findings.duplicatePendingCommissionerTransfers,
        ["leagueId", "pendingTransferCount"]
      )
    );
  }

  const leagues = listLeagueAuthority(database);
  const commissioners = listActiveCommissioners(database);
  const commissionerCounts = countByLeague(commissioners);
  const commissionersByLeague = new Map();
  for (const commissioner of commissioners) {
    const rows = commissionersByLeague.get(commissioner.leagueId) || [];
    rows.push(commissioner);
    commissionersByLeague.set(commissioner.leagueId, rows);
  }

  for (const league of leagues) {
    const canonical =
      league.commissionerMembershipId !== null &&
      league.pointerLeagueId === league.leagueId &&
      league.pointerPermissionCategory === "commissioner" &&
      league.pointerStatus === "active" &&
      (commissionerCounts.get(league.leagueId) || 0) >= 1 &&
      (commissionersByLeague.get(league.leagueId) || []).some(
        ({ membershipId }) => membershipId === league.commissionerMembershipId
      );
    if (!canonical) {
      fail(ERROR_CODES.pointerInvalid, {
        findings: Object.freeze([Object.freeze({
          leagueId: league.leagueId,
          commissionerMembershipId: league.commissionerMembershipId,
        })]),
      });
    }
    if (league.pointerIsAdministrator === 1) {
      fail(ERROR_CODES.administratorCommissioner, {
        findings: Object.freeze([Object.freeze({
          leagueId: league.leagueId,
          membershipId: league.commissionerMembershipId,
          userId: league.pointerUserId,
        })]),
      });
    }
  }
  const administratorCommissioners = commissioners.filter(
    ({ isAdministrator }) => isAdministrator === 1
  );
  if (administratorCommissioners.length > 0) {
    fail(
      ERROR_CODES.administratorCommissioner,
      safeFindingDetails(administratorCommissioners, [
        "leagueId",
        "membershipId",
        "userId",
      ])
    );
  }

  const commissionerDemotions = [];
  for (const league of leagues) {
    for (const commissioner of commissionersByLeague.get(league.leagueId) || []) {
      if (commissioner.membershipId === league.commissionerMembershipId) {
        continue;
      }
      const assignments = listCurrentTeamAssignments(database, commissioner);
      commissionerDemotions.push(Object.freeze({
        leagueId: commissioner.leagueId,
        membershipId: commissioner.membershipId,
        userId: commissioner.userId,
        permissionCategory: assignments.length > 0 ? "manager" : "member",
        activeTeamAssignmentIds: Object.freeze(
          assignments.map(({ assignmentId }) => assignmentId)
        ),
        version: commissioner.version,
        minimumUpdatedAtMs: Math.max(
          commissioner.createdAtMs,
          commissioner.updatedAtMs
        ),
      }));
    }
  }

  const administratorCoverage = listAdministratorCoverage(database);
  const administratorProvisions = [];
  const administratorNormalizations = [];
  for (const coverage of administratorCoverage) {
    const active = coverage.memberships.filter(
      ({ status }) => status === "active"
    );
    if (active.length > 1) {
      fail(ERROR_CODES.administratorMembershipDuplicate, {
        findings: Object.freeze([Object.freeze({
          leagueId: coverage.leagueId,
          userId: coverage.userId,
          membershipIds: Object.freeze(active.map(({ membershipId }) => membershipId)),
        })]),
      });
    }
    if (active.length === 0) {
      if (coverage.memberships.length > 1) {
        fail(ERROR_CODES.administratorHistoryAmbiguous, {
          findings: Object.freeze([Object.freeze({
            leagueId: coverage.leagueId,
            userId: coverage.userId,
            membershipIds: Object.freeze(
              coverage.memberships.map(({ membershipId }) => membershipId)
            ),
          })]),
        });
      }
      const membershipId = stableOperationId({
        databaseId,
        releaseId,
        kind: "administrator-membership",
        suffix: `${coverage.leagueId}\0${coverage.userId}`,
      });
      const collision = database.prepare(`
        SELECT id FROM league_memberships WHERE id = ?
      `).get(membershipId);
      if (collision) {
        fail(ERROR_CODES.deterministicIdConflict, {
          membershipId,
        });
      }
      administratorProvisions.push(Object.freeze({
        leagueId: coverage.leagueId,
        membershipId,
        userId: coverage.userId,
      }));
      continue;
    }
    const membership = active[0];
    if (
      membership.permissionCategory !== "member" ||
      membership.joinedAtMs === null ||
      membership.endedAtMs !== null
    ) {
      const assignments = listCurrentTeamAssignments(database, membership);
      administratorNormalizations.push(Object.freeze({
        leagueId: membership.leagueId,
        membershipId: membership.membershipId,
        userId: membership.userId,
        previousPermissionCategory: membership.permissionCategory,
        permissionCategory: "member",
        joinedAtMs: membership.joinedAtMs,
        protectedTeamAssignmentIds: Object.freeze(
          assignments.map(({ assignmentId }) => assignmentId)
        ),
        version: membership.version,
        createdAtMs: membership.createdAtMs,
        minimumUpdatedAtMs: Math.max(
          membership.createdAtMs,
          membership.updatedAtMs
        ),
      }));
    }
  }

  return Object.freeze({
    preview,
    leagues,
    commissioners,
    administratorCoverage,
    commissionerDemotions: Object.freeze(commissionerDemotions),
    administratorProvisions: Object.freeze(administratorProvisions),
    administratorNormalizations: Object.freeze(administratorNormalizations),
  });
}

function previewCounts(preview) {
  return Object.freeze({
    missingAdministratorMembershipCount:
      preview.findings.missingAdministratorMemberships.length,
    nonCanonicalAdministratorMembershipCount:
      preview.findings.nonCanonicalAdministratorMemberships.length,
    protectedAdministratorTeamAssignmentCount:
      preview.findings.protectedAdministratorTeamAssignments.length,
    invalidCommissionerCardinalityCount:
      preview.findings.invalidCommissionerCardinality.length,
    invalidCommissionerPointerCount:
      preview.findings.invalidCommissionerPointers.length,
    duplicatePendingCommissionerTransferLeagueCount:
      preview.findings.duplicatePendingCommissionerTransfers.length,
  });
}

function commissionerSnapshot(leagues, commissioners) {
  return Object.freeze(leagues.map((league) => Object.freeze({
    leagueId: league.leagueId,
    commissionerMembershipId: league.commissionerMembershipId,
    activeCommissionerMembershipIds: Object.freeze(
      commissioners
        .filter(({ leagueId }) => leagueId === league.leagueId)
        .map(({ membershipId }) => membershipId)
        .sort()
    ),
  })));
}

function administratorSnapshot(coverage) {
  return Object.freeze(coverage.map((entry) => Object.freeze({
    leagueId: entry.leagueId,
    userId: entry.userId,
    activeMembershipIds: Object.freeze(
      entry.memberships
        .filter(({ status }) => status === "active")
        .map(({ membershipId }) => membershipId)
        .sort()
    ),
  })));
}

function identityDigest(identity) {
  return crypto.createHash("sha256")
    .update(`${identity.environmentId}\0${identity.databaseId}`, "utf8")
    .digest("hex");
}

function publicDemotions(plan) {
  return Object.freeze(plan.map((row) => Object.freeze({
    leagueId: row.leagueId,
    membershipId: row.membershipId,
    userId: row.userId,
    permissionCategory: row.permissionCategory,
    activeTeamAssignmentIds: row.activeTeamAssignmentIds,
  })));
}

function publicProvisions(plan) {
  return Object.freeze(plan.map((row) => Object.freeze({
    leagueId: row.leagueId,
    membershipId: row.membershipId,
    userId: row.userId,
  })));
}

function publicNormalizations(plan) {
  return Object.freeze(plan.map((row) => Object.freeze({
    leagueId: row.leagueId,
    membershipId: row.membershipId,
    userId: row.userId,
    previousPermissionCategory: row.previousPermissionCategory,
    permissionCategory: row.permissionCategory,
    protectedTeamAssignmentIds: row.protectedTeamAssignmentIds,
  })));
}

function resultWithRuntime(result, { replayed, changesThisRun }) {
  const copy = { ...result };
  Object.defineProperties(copy, {
    replayed: {
      enumerable: false,
      value: replayed,
    },
    changesThisRun: {
      enumerable: false,
      value: changesThisRun,
    },
  });
  return Object.freeze(copy);
}

function readAuditReplay(database, { auditEventId, binding }) {
  const row = database.prepare(`
    SELECT event_type, outcome, actor_user_id, league_id,
      request_correlation_id, reason_code, client_metadata_json
    FROM security_audit_events
    WHERE id = ?
  `).get(auditEventId);
  if (!row) return null;
  let metadata;
  try {
    metadata = JSON.parse(row.client_metadata_json);
  } catch (error) {
    fail(ERROR_CODES.auditConflict, { auditEventId }, error);
  }
  const result = metadata?.result;
  if (
    row.event_type !== AUDIT_EVENT_TYPE ||
    row.outcome !== "success" ||
    row.actor_user_id !== null ||
    row.league_id !== null ||
    row.request_correlation_id !== binding.releaseId ||
    row.reason_code !== RESULT_CODE ||
    metadata?.contractVersion !== CONTRACT_VERSION ||
    metadata?.releaseId !== binding.releaseId ||
    metadata?.environment !== "staging" ||
    metadata?.environmentId !== binding.environmentId ||
    metadata?.databaseId !== binding.databaseId ||
    !result ||
    result.code !== RESULT_CODE ||
    result.releaseId !== binding.releaseId ||
    result.environment !== "staging" ||
    result.auditEventId !== auditEventId ||
    result.databaseIdentitySha256 !== identityDigest(binding) ||
    !Number.isSafeInteger(result.totalChangeCount) ||
    result.totalChangeCount < 1
  ) {
    fail(ERROR_CODES.auditConflict, { auditEventId });
  }
  return Object.freeze({ ...result });
}

function assertCleanPostcheck(database) {
  const preview = previewAuthorityReconciliation(database, {
    enforceQueryOnly: false,
  });
  if (
    preview.mutationRequired !== false ||
    preview.findings.invalidCommissionerCardinality.length !== 0 ||
    preview.findings.invalidCommissionerPointers.length !== 0
  ) {
    fail(ERROR_CODES.postcheckFailed, {
      counts: previewCounts(preview),
    });
  }
  return preview;
}

function reconcileAuthorityDatabase({
  database,
  databaseId,
  environmentId,
  releaseId,
  schemaVersion,
  nowMs = Date.now(),
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    !IDENTITY_PATTERN.test(databaseId || "") ||
    !IDENTITY_PATTERN.test(environmentId || "") ||
    !RELEASE_ID_PATTERN.test(releaseId || "") ||
    !SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    fail(ERROR_CODES.argumentInvalid);
  }
  const binding = Object.freeze({ databaseId, environmentId, releaseId });
  const auditEventId = stableOperationId({
    databaseId,
    releaseId,
    kind: "audit",
  });
  const transaction = database.transaction(() => {
    const transactionStartChanges = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count;
    const replay = readAuditReplay(database, { auditEventId, binding });
    if (replay) {
      assertCleanPostcheck(database);
      const replayChanges = database.prepare(
        "SELECT total_changes() AS count"
      ).get().count - transactionStartChanges;
      if (replayChanges !== 0) {
        fail(ERROR_CODES.writeCountMismatch, {
          expectedChangeCount: 0,
          actualChangeCount: replayChanges,
        });
      }
      return resultWithRuntime(replay, {
        replayed: true,
        changesThisRun: 0,
      });
    }

    const plan = collectPlan(database, { databaseId, releaseId });
    const commissionerBefore = commissionerSnapshot(
      plan.leagues,
      plan.commissioners
    );
    const administratorBefore = administratorSnapshot(
      plan.administratorCoverage
    );

    const updateCommissioner = database.prepare(`
      UPDATE league_memberships
      SET permission_category = @permissionCategory,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND league_id = @leagueId
        AND user_id = @userId
        AND permission_category = 'commissioner'
        AND status = 'active'
        AND version = @version
    `);
    for (const row of plan.commissionerDemotions) {
      const changed = updateCommissioner.run({
        ...row,
        updatedAtMs: Math.max(nowMs, row.minimumUpdatedAtMs),
      });
      if (changed.changes !== 1) fail(ERROR_CODES.postcheckFailed);
    }

    const insertAdministratorMembership = database.prepare(`
      INSERT INTO league_memberships (
        id, league_id, user_id, permission_category, status,
        joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
      ) VALUES (
        @membershipId, @leagueId, @userId, 'member', 'active',
        @nowMs, NULL, @nowMs, @nowMs, 1
      )
    `);
    for (const row of plan.administratorProvisions) {
      const changed = insertAdministratorMembership.run({ ...row, nowMs });
      if (changed.changes !== 1) fail(ERROR_CODES.postcheckFailed);
    }

    const normalizeAdministratorMembership = database.prepare(`
      UPDATE league_memberships
      SET permission_category = 'member',
          joined_at_ms = COALESCE(joined_at_ms, @joinedAtMs),
          ended_at_ms = NULL,
          updated_at_ms = @updatedAtMs,
          version = version + 1
      WHERE id = @membershipId
        AND league_id = @leagueId
        AND user_id = @userId
        AND status = 'active'
        AND version = @version
    `);
    for (const row of plan.administratorNormalizations) {
      const changed = normalizeAdministratorMembership.run({
        ...row,
        joinedAtMs: row.joinedAtMs ?? row.createdAtMs,
        updatedAtMs: Math.max(nowMs, row.minimumUpdatedAtMs),
      });
      if (changed.changes !== 1) fail(ERROR_CODES.postcheckFailed);
    }

    const postPreview = assertCleanPostcheck(database);
    const afterLeagues = listLeagueAuthority(database);
    const afterCommissioners = listActiveCommissioners(database);
    const afterAdministrators = listAdministratorCoverage(database);
    const authorityMutationCount =
      plan.commissionerDemotions.length +
      plan.administratorProvisions.length +
      plan.administratorNormalizations.length;
    const result = Object.freeze({
      code: RESULT_CODE,
      status: "completed",
      releaseId,
      environment: "staging",
      databaseIdentitySha256: identityDigest(binding),
      schemaVersion,
      auditEventId,
      totalChangeCount: authorityMutationCount + 1,
      authorityMutationCount,
      before: Object.freeze({
        counts: previewCounts(plan.preview),
        commissioners: commissionerBefore,
        administrators: administratorBefore,
      }),
      changes: Object.freeze({
        commissionerDemotions: publicDemotions(plan.commissionerDemotions),
        administratorMembershipsProvisioned:
          publicProvisions(plan.administratorProvisions),
        administratorMembershipsNormalized:
          publicNormalizations(plan.administratorNormalizations),
        administratorTeamAssignmentsPreserved: Object.freeze(
          plan.preview.findings.protectedAdministratorTeamAssignments.map(
            ({ leagueId, teamId, assignmentId, userId }) => Object.freeze({
              leagueId,
              teamId,
              assignmentId,
              userId,
            })
          )
        ),
      }),
      after: Object.freeze({
        counts: previewCounts(postPreview),
        commissioners: commissionerSnapshot(
          afterLeagues,
          afterCommissioners
        ),
        administrators: administratorSnapshot(afterAdministrators),
      }),
    });
    const metadata = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      releaseId,
      environment: "staging",
      environmentId,
      databaseId,
      result,
    });
    const auditInsert = database.prepare(`
      INSERT INTO security_audit_events (
        id, event_type, outcome, actor_user_id, target_user_id,
        league_id, session_id, request_correlation_id, reason_code,
        network_key_version, network_metadata_digest,
        client_metadata_json, unknown_account_digest, occurred_at_ms
      ) VALUES (
        @id, @eventType, 'success', NULL, NULL,
        NULL, NULL, @releaseId, @reasonCode,
        NULL, NULL, @metadata, NULL, @nowMs
      )
    `).run({
      id: auditEventId,
      eventType: AUDIT_EVENT_TYPE,
      releaseId,
      reasonCode: RESULT_CODE,
      metadata,
      nowMs,
    });
    if (auditInsert.changes !== 1) fail(ERROR_CODES.auditConflict);
    assertCleanPostcheck(database);

    const actualChanges = database.prepare(
      "SELECT total_changes() AS count"
    ).get().count - transactionStartChanges;
    if (actualChanges !== result.totalChangeCount) {
      fail(ERROR_CODES.writeCountMismatch, {
        expectedChangeCount: result.totalChangeCount,
        actualChangeCount: actualChanges,
      });
    }
    return resultWithRuntime(result, {
      replayed: false,
      changesThisRun: actualChanges,
    });
  });
  return transaction.immediate();
}

function runAuthorityReconciliationCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
  nowMs = Date.now(),
} = {}) {
  const options = parseArguments(argv);
  const expectedIdentity = assertSafeEnvironment(options, env);
  const target = assertExactPhysicalTarget(options);

  const readonly = openReadonlyDatabase({
    databasePath: target.databasePath,
  });
  let readonlyBinding;
  try {
    readonly.pragma("query_only = ON");
    readonlyBinding = assertDatabaseBinding(readonly, expectedIdentity);
  } finally {
    readonly.close();
  }

  const connection = openDatabase({
    databasePath: target.databasePath,
    environment: "staging",
    persistentRoot: target.persistentRoot,
    requirePersistentRoot: true,
  });
  let result;
  try {
    const writableBinding = assertDatabaseBinding(
      connection.database,
      expectedIdentity
    );
    if (
      writableBinding.schemaVersion !== readonlyBinding.schemaVersion ||
      writableBinding.identity.createdAt !==
        readonlyBinding.identity.createdAt
    ) {
      fail(ERROR_CODES.identityMismatch);
    }
    result = reconcileAuthorityDatabase({
      database: connection.database,
      databaseId: expectedIdentity.databaseId,
      environmentId: expectedIdentity.environmentId,
      releaseId: options.releaseId,
      schemaVersion: writableBinding.schemaVersion,
      nowMs,
    });
  } finally {
    connection.database.close();
  }
  output.log(JSON.stringify(result));
  return result;
}

function safeErrorDetails(error) {
  if (!(error instanceof AuthorityReconciliationError)) return undefined;
  const details = error.details;
  return Object.keys(details).length > 0 ? details : undefined;
}

function main() {
  try {
    runAuthorityReconciliationCommand();
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: error?.code || ERROR_CODES.commandFailed,
        message: "The staging authority reconciliation failed safely.",
        ...(safeErrorDetails(error) === undefined
          ? {}
          : { details: safeErrorDetails(error) }),
      },
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  AUDIT_EVENT_TYPE,
  AuthorityReconciliationError,
  CONTRACT_VERSION,
  ERROR_CODES,
  RESULT_CODE,
  assertDatabaseBinding,
  assertExactPhysicalTarget,
  assertSafeEnvironment,
  collectPlan,
  confirmationFor,
  deterministicUuid,
  parseArguments,
  reconcileAuthorityDatabase,
  runAuthorityReconciliationCommand,
  stableOperationId,
};
