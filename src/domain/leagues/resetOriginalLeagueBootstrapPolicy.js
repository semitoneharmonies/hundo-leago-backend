const {
  sha256Hex,
} = require("../shared/sha256");

const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION =
  "BOOTSTRAP_RESET_ORIGINAL_LEAGUE";
const RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION =
  "COMMIT_RESET_ORIGINAL_LEAGUE_MIGRATION_REPORT";
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION =
  "admin.league.bootstrap_reset_original.v1";
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT =
  "system_bootstrap.reset_original_league_created";
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON =
  "closed_write_reset_handoff";
const RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;
const RESET_ORIGINAL_LEAGUE_SEASON_LABEL = "2026";
const RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY =
  "20262027";
const RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON =
  '{"leagueStatus":"setup","seasonStatus":"planned"}';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid() {
  throw new TypeError(
    "reset original-league bootstrap request binding is invalid"
  );
}

function bounded(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(
      value
    )
  ) {
    invalid();
  }
  return value;
}

function resetOriginalLeagueBootstrapRequestHash(
  value
) {
  const keys = [
    "bootstrapUserId",
    "databaseResourceId",
    "leagueNameNormalized",
    "sourceBundleId",
    "stagingDescriptorSha256",
    "verificationHash",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !keys.includes(key)
    ) ||
    !UUID_PATTERN.test(value.bootstrapUserId || "") ||
    !DIGEST_PATTERN.test(
      value.stagingDescriptorSha256 || ""
    ) ||
    !DIGEST_PATTERN.test(
      value.verificationHash || ""
    )
  ) {
    invalid();
  }
  const databaseResourceId = bounded(
    value.databaseResourceId,
    128
  );
  const sourceBundleId = bounded(
    value.sourceBundleId,
    128
  );
  const leagueNameNormalized = bounded(
    value.leagueNameNormalized,
    120
  );
  if (
    leagueNameNormalized !==
    leagueNameNormalized.toLowerCase()
  ) {
    invalid();
  }
  const payload = {
    operation:
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
    verificationHash: value.verificationHash,
    stagingDescriptorSha256:
      value.stagingDescriptorSha256,
    databaseResourceId,
    sourceBundleId,
    bootstrapUserId: value.bootstrapUserId,
    leagueNameNormalized,
    seasonLabel:
      RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
    nhlSeasonKey:
      RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  };
  const canonicalPayload = `{${Object.keys(payload)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${JSON.stringify(
          payload[key]
        )}`
    )
    .join(",")}}`;
  return sha256Hex(canonicalPayload);
}

module.exports = {
  RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
  RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_REPORT_COMMIT_CONFIRMATION,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
  resetOriginalLeagueBootstrapRequestHash,
};
