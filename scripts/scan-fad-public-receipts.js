#!/usr/bin/env node

"use strict";

const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../src/infrastructure/database/connection");
const {
  validateAuctionAdministrationStoredResult,
} = require(
  "../src/domain/auctions/auctionAdministrationPolicy"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  projectFreeAgentDraftAllocationResultForPublic,
  projectFreeAgentDraftCorrectionApplyResultForPublic,
  validateFreeAgentDraftCorrectionApplyResult,
  validateFreeAgentDraftCorrectionPublicApplyResult,
  validateFreeAgentDraftPublicAllocationResultProjection,
} = require(
  "../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);
const {
  assertDatabaseBinding,
  assertExactPhysicalTarget,
} = require("./reconcile-m7-26-staging-authority");

const IDENTITY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODES = Object.freeze({
  argumentInvalid: "FAD_PUBLIC_RECEIPT_SCAN_ARGUMENT_INVALID",
  environmentUnsafe:
    "FAD_PUBLIC_RECEIPT_SCAN_ENVIRONMENT_UNSAFE",
  targetUnsafe: "FAD_PUBLIC_RECEIPT_SCAN_TARGET_UNSAFE",
  identityMismatch:
    "FAD_PUBLIC_RECEIPT_SCAN_IDENTITY_MISMATCH",
  scanFailed: "FAD_PUBLIC_RECEIPT_SCAN_FAILED",
});
const REASON_CODES = Object.freeze({
  t082LegacyFullMoneySafe:
    "T082_LEGACY_FULL_MONEY_SAFELY_REPROJECTABLE",
  t082NoFadAllocation: "T082_NO_FAD_ALLOCATION",
  t082PublicProjectionUnsafe:
    "T082_PUBLIC_PROJECTION_UNSAFE",
  t082StoredReceiptInvalid:
    "T082_STORED_RECEIPT_INVALID",
  t144LegacyFullMoneySafe:
    "T144_LEGACY_FULL_MONEY_SAFELY_REPROJECTABLE",
  t144PublicProjectionUnsafe:
    "T144_PUBLIC_PROJECTION_UNSAFE",
  t144StoredReceiptInvalid:
    "T144_STORED_RECEIPT_INVALID",
});

class FreeAgentDraftPublicReceiptScanError extends Error {
  constructor(code, options = {}) {
    super(
      "The FAD public-receipt privacy scan failed safely.",
      options
    );
    this.name = "FreeAgentDraftPublicReceiptScanError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new FreeAgentDraftPublicReceiptScanError(
    code,
    cause === undefined ? {} : { cause }
  );
}

function parseArguments(argv) {
  const names = new Map([
    ["--database", "databasePath"],
    ["--environment", "environment"],
    ["--persistent-root", "persistentRoot"],
  ]);
  if (!Array.isArray(argv) || argv.length !== names.size * 2) {
    fail(ERROR_CODES.argumentInvalid);
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    const value = argv[index + 1];
    if (
      !field ||
      Object.hasOwn(options, field) ||
      typeof value !== "string" ||
      value.length < 1 ||
      value !== value.trim() ||
      value.startsWith("--")
    ) {
      fail(ERROR_CODES.argumentInvalid);
    }
    options[field] = value;
  }
  if (
    options.environment !== "staging" ||
    !path.isAbsolute(options.databasePath) ||
    !path.isAbsolute(options.persistentRoot) ||
    path.normalize(options.databasePath) !== options.databasePath ||
    path.normalize(options.persistentRoot) !== options.persistentRoot
  ) {
    fail(ERROR_CODES.argumentInvalid);
  }
  return Object.freeze({ ...options });
}

function assertSafeStagingEnvironment(options, env) {
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    env.APP_ENV !== "staging" ||
    env.DATABASE_PATH !== options.databasePath ||
    env.PERSISTENT_DATA_ROOT !== options.persistentRoot ||
    !IDENTITY_PATTERN.test(env.APP_ENVIRONMENT_ID || "") ||
    !IDENTITY_PATTERN.test(env.DATABASE_ID || "")
  ) {
    fail(ERROR_CODES.environmentUnsafe);
  }
  return Object.freeze({
    databaseId: env.DATABASE_ID,
    environmentId: env.APP_ENVIRONMENT_ID,
  });
}

function sanitizedIds(row, fields) {
  const result = {};
  for (const [outputField, rowField] of fields) {
    if (UUID_PATTERN.test(row?.[rowField] || "")) {
      result[outputField] = row[rowField];
    }
  }
  return result;
}

function t082Identity(row, data) {
  return Object.freeze({
    ...sanitizedIds(row, [
      ["commandResultId", "id"],
      ["leagueId", "league_id"],
      ["seasonId", "season_id"],
      ["auctionId", "auction_id"],
    ]),
    ...sanitizedIds(
      {
        allocation_id: data?.fadAllocation?.allocationId,
        fad_id: data?.auction?.fadId,
      },
      [
        ["fadId", "fad_id"],
        ["allocationId", "allocation_id"],
      ]
    ),
  });
}

function t144Identity(row) {
  return Object.freeze(
    sanitizedIds(row, [
      ["commandResultId", "id"],
      ["leagueId", "league_id"],
      ["seasonId", "season_id"],
      ["fadId", "fad_id"],
      ["allocationId", "allocation_id"],
      ["correctionId", "commissioner_correction_id"],
      ["activityId", "activity_id"],
    ])
  );
}

function finding(identity, reasonCode) {
  return Object.freeze({ ...identity, reasonCode });
}

function validateT082StoredReceipt(row) {
  const stored = validateAuctionAdministrationStoredResult({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    auctionId: row.auction_id,
    bidId: row.bid_id,
    idempotencyRequestId: row.idempotency_request_id,
    jobRunId: row.job_run_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorMembershipId: row.actor_membership_id,
    actorAuthority: row.actor_authority,
    requestSha256: row.request_sha256,
    preconditionKind: row.precondition_kind,
    expectedResourceVersion: row.expected_resource_version,
    resultingResourceVersion: row.resulting_resource_version,
    responseHttpStatus: row.response_http_status,
    responseJson: row.response_json,
    responseSha256: row.response_sha256,
    createdAtMs: row.created_at_ms,
    version: row.version,
  });
  if (
    stored.action !== "cancel_auction" ||
    stored.data.auction.seasonId !== stored.seasonId
  ) {
    throw new TypeError("T-082 stored identity is inconsistent");
  }
  const allocation = stored.data.fadAllocation;
  if (
    allocation !== null &&
    (
      stored.data.auction.sourceKind !== "fad_restricted" ||
      !UUID_PATTERN.test(stored.data.auction.fadId || "") ||
      allocation.player.playerId !==
        stored.data.auction.player.playerId ||
      allocation.status !== "correction_required" ||
      allocation.recoveryStatus !== "correction_required" ||
      stored.data.auction.status !== "correction_required" ||
      stored.data.recoveryId === null ||
      stored.data.auction.result?.recoveryId !==
        stored.data.recoveryId
    )
  ) {
    throw new TypeError("T-082 FAD allocation identity is inconsistent");
  }
  return stored;
}

function validateT144StoredReceipt(row) {
  if (
    ![
      row.id,
      row.league_id,
      row.season_id,
      row.fad_id,
      row.allocation_id,
      row.player_id,
      row.idempotency_request_id,
      row.commissioner_correction_id,
      row.activity_id,
      row.actor_user_id,
      row.actor_membership_id,
    ].every((value) => UUID_PATTERN.test(value || "")) ||
    ![
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(row.actor_authority) ||
    row.response_http_status !== 200 ||
    row.version !== 1 ||
    !Number.isSafeInteger(row.accepted_from_allocation_version) ||
    row.accepted_from_allocation_version < 1 ||
    row.resulting_allocation_version !==
      row.accepted_from_allocation_version + 1
  ) {
    throw new TypeError("T-144 stored identity is invalid");
  }
  const parsed = validateFreeAgentDraftCorrectionApplyResult(
    JSON.parse(row.response_json)
  );
  if (
    serializeCanonicalJsonV1(parsed) !== row.response_json ||
    hashCanonicalJsonV1(parsed) !== row.response_sha256 ||
    parsed.correctionId !== row.commissioner_correction_id ||
    parsed.activityId !== row.activity_id ||
    parsed.allocation.allocationId !== row.allocation_id ||
    parsed.allocation.player.playerId !== row.player_id ||
    parsed.allocation.allocationVersion !==
      row.resulting_allocation_version ||
    parsed.allocation.decisionCode !== "corrected" ||
    parsed.completedAtMs !== row.completed_at_ms
  ) {
    throw new TypeError("T-144 response identity is inconsistent");
  }
  return parsed;
}

function emptyFamilyCounts({ includeNull = false } = {}) {
  return {
    totalReceipts: 0,
    redactedReceipts: 0,
    legacyFullMoneySafelyReprojectableReceipts: 0,
    ...(includeNull ? { nullOrNoFadAllocationReceipts: 0 } : {}),
    malformedUnsafeReceipts: 0,
  };
}

function emptyFamilyFindings({ includeNull = false } = {}) {
  return {
    legacyFullMoneySafelyReprojectable: [],
    ...(includeNull ? { nullOrNoFadAllocation: [] } : {}),
    malformedUnsafe: [],
  };
}

function scanT082Rows(rows) {
  const counts = emptyFamilyCounts({ includeNull: true });
  const findings = emptyFamilyFindings({ includeNull: true });
  for (const row of rows) {
    counts.totalReceipts += 1;
    let stored;
    try {
      stored = validateT082StoredReceipt(row);
    } catch {
      counts.malformedUnsafeReceipts += 1;
      findings.malformedUnsafe.push(
        finding(
          t082Identity(row),
          REASON_CODES.t082StoredReceiptInvalid
        )
      );
      continue;
    }
    const identity = t082Identity(row, stored.data);
    if (stored.data.fadAllocation === null) {
      counts.nullOrNoFadAllocationReceipts += 1;
      findings.nullOrNoFadAllocation.push(
        finding(identity, REASON_CODES.t082NoFadAllocation)
      );
      continue;
    }
    try {
      validateFreeAgentDraftPublicAllocationResultProjection(
        stored.data.fadAllocation
      );
      counts.redactedReceipts += 1;
      continue;
    } catch {
      // A legacy receipt is safe only if the exact current public projector
      // and strict validator accept it. Merely failing the public validator is
      // not evidence that the receipt contains only legacy full money.
    }
    try {
      validateFreeAgentDraftPublicAllocationResultProjection(
        projectFreeAgentDraftAllocationResultForPublic(
          stored.data.fadAllocation
        )
      );
      counts.legacyFullMoneySafelyReprojectableReceipts += 1;
      findings.legacyFullMoneySafelyReprojectable.push(
        finding(
          identity,
          REASON_CODES.t082LegacyFullMoneySafe
        )
      );
    } catch {
      counts.malformedUnsafeReceipts += 1;
      findings.malformedUnsafe.push(
        finding(
          identity,
          REASON_CODES.t082PublicProjectionUnsafe
        )
      );
    }
  }
  return { counts, findings };
}

function scanT144Rows(rows) {
  const counts = emptyFamilyCounts();
  const findings = emptyFamilyFindings();
  for (const row of rows) {
    counts.totalReceipts += 1;
    const identity = t144Identity(row);
    let stored;
    try {
      stored = validateT144StoredReceipt(row);
    } catch {
      counts.malformedUnsafeReceipts += 1;
      findings.malformedUnsafe.push(
        finding(
          identity,
          REASON_CODES.t144StoredReceiptInvalid
        )
      );
      continue;
    }
    try {
      validateFreeAgentDraftCorrectionPublicApplyResult(stored);
      counts.redactedReceipts += 1;
      continue;
    } catch {
      // The projector and strict validator below are the actual legacy replay
      // safety proof. The immutable stored response remains untouched.
    }
    try {
      validateFreeAgentDraftCorrectionPublicApplyResult(
        projectFreeAgentDraftCorrectionApplyResultForPublic(stored)
      );
      counts.legacyFullMoneySafelyReprojectableReceipts += 1;
      findings.legacyFullMoneySafelyReprojectable.push(
        finding(
          identity,
          REASON_CODES.t144LegacyFullMoneySafe
        )
      );
    } catch {
      counts.malformedUnsafeReceipts += 1;
      findings.malformedUnsafe.push(
        finding(
          identity,
          REASON_CODES.t144PublicProjectionUnsafe
        )
      );
    }
  }
  return { counts, findings };
}

function scanFreeAgentDraftPublicReceipts(
  database,
  { enforceQueryOnly = true } = {}
) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "FAD public-receipt scanning requires an opened SQLite database"
    );
  }
  if (typeof enforceQueryOnly !== "boolean") {
    throw new TypeError(
      "FAD public-receipt scanning requires an exact query-only option"
    );
  }
  if (enforceQueryOnly) database.pragma("query_only = ON");
  const beforeChanges = database.prepare(
    "SELECT total_changes() AS count"
  ).get().count;
  const t082Rows = database.prepare(`
    SELECT
      id, league_id, season_id, auction_id, bid_id,
      idempotency_request_id, job_run_id, action,
      actor_user_id, actor_membership_id, actor_authority,
      request_sha256, precondition_kind,
      expected_resource_version, resulting_resource_version,
      response_http_status, response_json, response_sha256,
      created_at_ms, version
    FROM auction_administration_command_results
    WHERE action = 'cancel_auction'
    ORDER BY league_id, id
  `).all();
  const t144Rows = database.prepare(`
    SELECT
      id, league_id, season_id, fad_id, allocation_id,
      player_id, idempotency_request_id,
      commissioner_correction_id, activity_id,
      actor_user_id, actor_membership_id, actor_authority,
      accepted_from_allocation_version,
      resulting_allocation_version, response_http_status,
      response_json, response_sha256, completed_at_ms, version
    FROM free_agent_draft_allocation_correction_command_results
    ORDER BY league_id, id
  `).all();
  const t082 = scanT082Rows(t082Rows);
  const t144 = scanT144Rows(t144Rows);
  const afterChanges = database.prepare(
    "SELECT total_changes() AS count"
  ).get().count;
  if (afterChanges !== beforeChanges) {
    fail(ERROR_CODES.scanFailed);
  }
  const malformedUnsafeReceipts =
    t082.counts.malformedUnsafeReceipts +
    t144.counts.malformedUnsafeReceipts;
  return Object.freeze({
    code:
      malformedUnsafeReceipts === 0
        ? "FAD_PUBLIC_RECEIPT_PRIVACY_SCAN_COMPLETE"
        : "FAD_PUBLIC_RECEIPT_PRIVACY_SCAN_UNSAFE",
    readOnly: true,
    safeForPublicReplay: malformedUnsafeReceipts === 0,
    totalChanges: Object.freeze({
      before: beforeChanges,
      after: afterChanges,
      delta: afterChanges - beforeChanges,
    }),
    counts: Object.freeze({
      totalReceipts:
        t082.counts.totalReceipts +
        t144.counts.totalReceipts,
      malformedUnsafeReceipts,
      t082: Object.freeze(t082.counts),
      t144: Object.freeze(t144.counts),
    }),
    findings: Object.freeze({
      t082: Object.freeze({
        legacyFullMoneySafelyReprojectable: Object.freeze(
          t082.findings.legacyFullMoneySafelyReprojectable
        ),
        nullOrNoFadAllocation: Object.freeze(
          t082.findings.nullOrNoFadAllocation
        ),
        malformedUnsafe: Object.freeze(
          t082.findings.malformedUnsafe
        ),
      }),
      t144: Object.freeze({
        legacyFullMoneySafelyReprojectable: Object.freeze(
          t144.findings.legacyFullMoneySafelyReprojectable
        ),
        malformedUnsafe: Object.freeze(
          t144.findings.malformedUnsafe
        ),
      }),
    }),
  });
}

function runScanCommand({
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
} = {}) {
  const options = parseArguments(argv);
  const expectedIdentity = assertSafeStagingEnvironment(
    options,
    env
  );
  let target;
  try {
    target = assertExactPhysicalTarget(options);
  } catch (error) {
    fail(ERROR_CODES.targetUnsafe, error);
  }
  const database = openReadonlyDatabase({
    databasePath: target.databasePath,
  });
  try {
    database.pragma("query_only = ON");
    let binding;
    try {
      binding = assertDatabaseBinding(database, expectedIdentity);
    } catch (error) {
      fail(ERROR_CODES.identityMismatch, error);
    }
    const result = scanFreeAgentDraftPublicReceipts(database, {
      enforceQueryOnly: false,
    });
    const outputResult = Object.freeze({
      ...result,
      databaseIdentity: Object.freeze({
        environmentId: binding.identity.environmentId,
        databaseId: binding.identity.databaseId,
        schemaVersion: binding.schemaVersion,
      }),
    });
    output.log(JSON.stringify(outputResult, null, 2));
    return outputResult;
  } finally {
    database.close();
  }
}

function scanExitCode(result) {
  return result?.safeForPublicReplay === true ? 0 : 1;
}

function main() {
  try {
    const result = runScanCommand();
    process.exitCode = scanExitCode(result);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: error?.code || ERROR_CODES.scanFailed,
          message:
            "The FAD public-receipt privacy scan failed safely.",
        },
      })
    );
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ERROR_CODES,
  REASON_CODES,
  FreeAgentDraftPublicReceiptScanError,
  assertSafeStagingEnvironment,
  main,
  parseArguments,
  runScanCommand,
  scanExitCode,
  scanFreeAgentDraftPublicReceipts,
  validateT082StoredReceipt,
  validateT144StoredReceipt,
};
