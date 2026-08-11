const crypto = require("node:crypto");

const {
  canonicalize,
} = require("./sourceInventory");

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_TABLES =
  Object.freeze([
    "application_metadata",
    "player_external_ids",
    "player_source_state",
    "players",
  ]);
const RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_ORDER_COLUMNS =
  Object.freeze({
    application_metadata: "metadata_key",
    player_external_ids: "id",
    player_source_state: "id",
    players: "id",
  });

function fail() {
  throw new TypeError(
    "The reset original-league continuity evidence is invalid."
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, keys) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !keys.includes(key)
    )
  ) {
    fail();
  }
  return value;
}

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(canonicalize(value))
    .digest("hex");
}

function deepFreeze(value) {
  if (
    value &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function assertResetOriginalLeagueContinuityBaseline(
  value
) {
  exactObject(value, [
    "migrationLedgerSha256",
    "protectedTableHashes",
  ]);
  if (
    !DIGEST_PATTERN.test(
      value.migrationLedgerSha256 || ""
    )
  ) {
    fail();
  }
  exactObject(
    value.protectedTableHashes,
    RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_TABLES
  );
  if (
    Object.values(
      value.protectedTableHashes
    ).some(
      (digest) => !DIGEST_PATTERN.test(digest || "")
    )
  ) {
    fail();
  }
  return value;
}

function fullMigrationLedger(database) {
  const rows = database.prepare(
    "SELECT migration_id AS id, " +
      "file_name AS fileName, checksum, " +
      "application_build_id AS applicationBuildId, " +
      "started_at_ms AS startedAtMs, " +
      "applied_at_ms AS appliedAtMs, " +
      "duration_ms AS durationMs " +
      "FROM schema_migrations " +
      "ORDER BY migration_id ASC"
  ).all();
  let priorId = 0;
  for (const row of rows) {
    exactObject(row, [
      "id",
      "fileName",
      "checksum",
      "applicationBuildId",
      "startedAtMs",
      "appliedAtMs",
      "durationMs",
    ]);
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= priorId ||
      typeof row.fileName !== "string" ||
      row.fileName.length < 1 ||
      !DIGEST_PATTERN.test(row.checksum || "") ||
      typeof row.applicationBuildId !== "string" ||
      row.applicationBuildId.trim() !==
        row.applicationBuildId ||
      row.applicationBuildId.length < 1 ||
      !Number.isSafeInteger(row.startedAtMs) ||
      row.startedAtMs < 0 ||
      !Number.isSafeInteger(row.appliedAtMs) ||
      row.appliedAtMs < row.startedAtMs ||
      !Number.isSafeInteger(row.durationMs) ||
      row.durationMs < 0
    ) {
      fail();
    }
    priorId = row.id;
  }
  if (rows.length < 1) {
    fail();
  }
  return rows;
}

function captureResetOriginalLeagueContinuityBaseline({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    fail();
  }
  const ledger = fullMigrationLedger(database);
  const protectedTableHashes = {};
  for (const tableName of
    RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_TABLES) {
    const rows = database.prepare(
      `SELECT * FROM "${tableName}" ` +
        `ORDER BY "${
          RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_ORDER_COLUMNS[
            tableName
          ]
        }" ASC`
    ).all();
    protectedTableHashes[tableName] =
      hash(rows);
  }
  return deepFreeze({
    migrationLedgerSha256: hash(ledger),
    protectedTableHashes,
  });
}

function assertResetOriginalLeagueContinuityBaselineMatches({
  database,
  expected,
} = {}) {
  assertResetOriginalLeagueContinuityBaseline(
    expected
  );
  const actual =
    captureResetOriginalLeagueContinuityBaseline({
      database,
    });
  if (
    canonicalize(actual) !== canonicalize(expected)
  ) {
    fail();
  }
  return actual;
}

module.exports = {
  RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_ORDER_COLUMNS,
  RESET_ORIGINAL_LEAGUE_ARTIFACT_PROTECTED_TABLES,
  assertResetOriginalLeagueContinuityBaseline,
  assertResetOriginalLeagueContinuityBaselineMatches,
  captureResetOriginalLeagueContinuityBaseline,
  fullMigrationLedger,
};
