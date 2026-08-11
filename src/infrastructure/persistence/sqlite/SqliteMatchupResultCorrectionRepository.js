const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  calculateStandingsResultSetHash,
} = require("../../../domain/matchups/matchupStandingsFinalizationPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  createSqliteMatchupStandingsFinalizationRepository,
} = require("./SqliteMatchupStandingsFinalizationRepository");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");
const {
  AUDIT_COLUMNS,
  createSqliteSecurityAuditRepository,
} = require("./SqliteSecurityAuditRepository");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MATCHUP_RESULT_CORRECTION_OPERATION =
  "matchup.result.correct.v1";
const MATCHUP_RESULT_CORRECTION_RESULT_TYPE =
  "matchup_result_correction";
const MATCHUP_RESULT_CORRECTION_AUDIT_EVENT =
  "matchup.result_corrected";
const MATCHUP_RESULT_CORRECTION_FALLBACK_REASON =
  "Official matchup result correction";
const ACTOR_AUTHORITIES = new Set([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const RESULT_OUTCOMES = new Set([
  "home_win",
  "away_win",
  "tie",
]);
const CORRECTABLE_MATCHUP_STATUSES = new Set([
  "final",
  "correction_required",
]);
const VERSION_COLUMNS = Object.freeze([
  "result_version_id",
  "version_number",
  "home_team_id",
  "away_team_id",
  "home_score_hundredths",
  "away_score_hundredths",
  "outcome",
  "source_snapshot_id",
  "source_type",
  "actor_user_id",
  "reason",
  "supersedes_version_id",
  "created_at_ms",
]);
const FINALIZATION_COLUMNS = Object.freeze([
  "finalization_id",
  "standings_snapshot_id",
  "finalization_version",
  "status",
  "cause",
  "standings_rule_version",
  "result_set_hash",
  "expected_matchup_count",
  "expected_week_count",
  "participant_count",
  "season_version_before",
  "season_version_after",
  "authorized_by_user_id",
  "authorized_by_membership_id",
  "authorized_authority",
  "standings_operation_id",
  "idempotency_request_id",
  "replaces_finalization_id",
  "superseded_by_snapshot_id",
  "superseded_by_user_id",
  "superseded_by_membership_id",
  "superseded_by_authority",
  "superseded_by_operation_id",
  "superseded_at_ms",
  "finalized_at_ms",
  "version",
]);
const STANDINGS_ROW_INPUT_KEYS = Object.freeze([
  "id",
  "teamId",
  "rank",
  "wins",
  "losses",
  "ties",
  "standingsPoints",
  "fantasyPointsForHundredths",
  "fantasyPointsAgainstHundredths",
  "fantasyPointsDifferentialHundredths",
]);
const RESULT_LINK_INPUT_KEYS = Object.freeze([
  "id",
  "matchupWeekId",
  "matchupId",
  "matchupResultId",
  "resultVersionId",
  "resultVersionNumber",
]);
const TEAM_IDENTITY_INPUT_KEYS = Object.freeze([
  "id",
  "teamId",
  "teamDisplayName",
  "primaryColour",
  "secondaryColour",
  "tertiaryColour",
  "patternTemplate",
  "sourceLogoObjectId",
  "logoMediaType",
  "logoByteLength",
  "logoWidth",
  "logoHeight",
  "logoContentSha256",
  "logoContentBytes",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function conflict(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
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

function exactObject(value, keys, message) {
  if (!isPlainObject(value)) invalid(message);
  const actual = Reflect.ownKeys(value);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== expected.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== expected[index])
  ) {
    invalid(message);
  }
  return value;
}

function stableId(value, description = "stable identifier") {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function optionalStableId(
  value,
  description = "stable identifier"
) {
  return value === null
    ? null
    : stableId(value, description);
}

function safeTimestamp(value, description = "timestamp") {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`A safe ${description} is required.`);
  }
  return value;
}

function positiveInteger(value, description = "integer") {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(`A positive safe ${description} is required.`);
  }
  return value;
}

function nonnegativeInteger(
  value,
  description = "integer"
) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`A nonnegative safe ${description} is required.`);
  }
  return value;
}

function canonicalDigest(value, description = "digest") {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} is required.`);
  }
  return value;
}

function canonicalText(
  value,
  maximum,
  description,
  { minimum = 1 } = {}
) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    invalid(`Bounded canonical ${description} is required.`);
  }
  return value;
}

function actorAuthority(value) {
  if (!ACTOR_AUTHORITIES.has(value)) {
    invalid("A supported correction authority is required.");
  }
  return value;
}

function outcome(value, homeScore, awayScore) {
  if (
    !RESULT_OUTCOMES.has(value) ||
    (value === "home_win" && homeScore <= awayScore) ||
    (value === "away_win" && awayScore <= homeScore) ||
    (value === "tie" && homeScore !== awayScore)
  ) {
    invalid("A score-consistent matchup outcome is required.");
  }
  return value;
}

function freezeRow(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const [key, value] of Object.entries(copy)) {
    if (Buffer.isBuffer(value)) {
      copy[key] = Buffer.from(value);
    }
  }
  return Object.freeze(copy);
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function uniqueRow(
  statement,
  parameters,
  description
) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} is not unique.`);
  }
  return freezeRow(rows[0] || null);
}

function normalizeIdempotency(value, nowMs) {
  exactObject(
    value,
    [
      "id",
      "clientKey",
      "requestHash",
      "expiresAtMs",
    ],
    "An exact correction idempotency record is required."
  );
  const expiresAtMs = safeTimestamp(
    value.expiresAtMs,
    "idempotency expiry"
  );
  if (expiresAtMs <= nowMs) {
    invalid("Correction idempotency expiry must be in the future.");
  }
  return Object.freeze({
    id: stableId(
      value.id,
      "idempotency-request identifier"
    ),
    clientKey: canonicalText(
      value.clientKey,
      128,
      "idempotency key"
    ),
    requestHash: canonicalDigest(
      value.requestHash,
      "request hash"
    ),
    expiresAtMs,
  });
}

function normalizeCorrection(value) {
  exactObject(
    value,
    [
      "resultVersionId",
      "matchupOperationId",
      "versionNumber",
      "supersedesVersionId",
      "sourceSnapshotId",
      "homeTeamId",
      "awayTeamId",
      "homeScoreHundredths",
      "awayScoreHundredths",
      "outcome",
      "reason",
      "createdAtMs",
    ],
    "An exact matchup-result correction is required."
  );
  const homeScoreHundredths = nonnegativeInteger(
    value.homeScoreHundredths,
    "home score"
  );
  const awayScoreHundredths = nonnegativeInteger(
    value.awayScoreHundredths,
    "away score"
  );
  const homeTeamId = stableId(
    value.homeTeamId,
    "home-team identifier"
  );
  const awayTeamId = stableId(
    value.awayTeamId,
    "away-team identifier"
  );
  if (homeTeamId === awayTeamId) {
    invalid("Different matchup teams are required.");
  }
  return Object.freeze({
    resultVersionId: stableId(
      value.resultVersionId,
      "result-version identifier"
    ),
    matchupOperationId: stableId(
      value.matchupOperationId,
      "matchup-operation identifier"
    ),
    versionNumber: positiveInteger(
      value.versionNumber,
      "result-version number"
    ),
    supersedesVersionId: stableId(
      value.supersedesVersionId,
      "superseded result-version identifier"
    ),
    sourceSnapshotId: stableId(
      value.sourceSnapshotId,
      "source-snapshot identifier"
    ),
    homeTeamId,
    awayTeamId,
    homeScoreHundredths,
    awayScoreHundredths,
    outcome: outcome(
      value.outcome,
      homeScoreHundredths,
      awayScoreHundredths
    ),
    reason: canonicalText(
      value.reason,
      500,
      "recorded correction reason"
    ),
    createdAtMs: safeTimestamp(
      value.createdAtMs,
      "correction creation timestamp"
    ),
  });
}

function normalizeStandingsRow(value) {
  exactObject(
    value,
    STANDINGS_ROW_INPUT_KEYS,
    "An exact replacement standings row is required."
  );
  const wins = nonnegativeInteger(value.wins, "win count");
  const losses = nonnegativeInteger(
    value.losses,
    "loss count"
  );
  const ties = nonnegativeInteger(value.ties, "tie count");
  const standingsPoints = nonnegativeInteger(
    value.standingsPoints,
    "standings points"
  );
  const pointsFor = nonnegativeInteger(
    value.fantasyPointsForHundredths,
    "fantasy points for"
  );
  const pointsAgainst = nonnegativeInteger(
    value.fantasyPointsAgainstHundredths,
    "fantasy points against"
  );
  const differential =
    value.fantasyPointsDifferentialHundredths;
  if (
    !Number.isSafeInteger(differential) ||
    standingsPoints !== wins * 2 + ties ||
    differential !== pointsFor - pointsAgainst
  ) {
    invalid("A consistent replacement standings row is required.");
  }
  return Object.freeze({
    id: stableId(value.id, "standings-row identifier"),
    teamId: stableId(value.teamId, "team identifier"),
    rank: positiveInteger(value.rank, "standings rank"),
    wins,
    losses,
    ties,
    standingsPoints,
    fantasyPointsForHundredths: pointsFor,
    fantasyPointsAgainstHundredths: pointsAgainst,
    fantasyPointsDifferentialHundredths: differential,
  });
}

function normalizeResultLink(value) {
  exactObject(
    value,
    RESULT_LINK_INPUT_KEYS,
    "An exact replacement result-version link is required."
  );
  return Object.freeze({
    id: stableId(
      value.id,
      "result-version-link identifier"
    ),
    matchupWeekId: stableId(
      value.matchupWeekId,
      "matchup-week identifier"
    ),
    matchupId: stableId(
      value.matchupId,
      "matchup identifier"
    ),
    matchupResultId: stableId(
      value.matchupResultId,
      "matchup-result identifier"
    ),
    resultVersionId: stableId(
      value.resultVersionId,
      "matchup-result-version identifier"
    ),
    resultVersionNumber: positiveInteger(
      value.resultVersionNumber,
      "result-version number"
    ),
  });
}

function normalizeTeamIdentity(value) {
  exactObject(
    value,
    TEAM_IDENTITY_INPUT_KEYS,
    "An exact replacement team identity is required."
  );
  return Object.freeze({
    ...value,
    id: stableId(
      value.id,
      "team-identity identifier"
    ),
    teamId: stableId(value.teamId, "team identifier"),
    sourceLogoObjectId: optionalStableId(
      value.sourceLogoObjectId,
      "team-logo object identifier"
    ),
    logoContentBytes: Buffer.isBuffer(
      value.logoContentBytes
    )
      ? Buffer.from(value.logoContentBytes)
      : value.logoContentBytes,
  });
}

function normalizeUniqueArray(
  value,
  normalizer,
  identity,
  description,
  { allowEmpty = false } = {}
) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length < 1)
  ) {
    invalid(`A valid ${description} set is required.`);
  }
  const normalized = value.map(normalizer);
  const identities = normalized.map(identity);
  if (new Set(identities).size !== identities.length) {
    invalid(`${description} values must be unique.`);
  }
  return Object.freeze(normalized);
}

function normalizeReplacement(value) {
  if (value === null) return null;
  exactObject(
    value,
    [
      "snapshotId",
      "snapshotVersion",
      "sourceResultVersion",
      "standingsOperationId",
      "finalizationId",
      "resultSetHash",
      "standingsRuleVersion",
      "expectedMatchupCount",
      "expectedWeekCount",
      "participantCount",
      "rows",
      "links",
      "identities",
      "standingsRowsChanged",
      "notifications",
      "outboxId",
    ],
    "An exact replacement final-standings plan is required."
  );
  if (typeof value.standingsRowsChanged !== "boolean") {
    invalid("A replacement standings-change decision is required.");
  }
  const notifications = normalizeUniqueArray(
    value.notifications,
    (notification) => {
      exactObject(
        notification,
        ["id", "userId"],
        "An exact correction notification is required."
      );
      return Object.freeze({
        id: stableId(
          notification.id,
          "notification identifier"
        ),
        userId: stableId(
          notification.userId,
          "notification user identifier"
        ),
      });
    },
    (notification) =>
      `${notification.id}:${notification.userId}`,
    "correction notification",
    { allowEmpty: true }
  );
  return Object.freeze({
    snapshotId: stableId(
      value.snapshotId,
      "replacement snapshot identifier"
    ),
    snapshotVersion: positiveInteger(
      value.snapshotVersion,
      "replacement snapshot version"
    ),
    sourceResultVersion: nonnegativeInteger(
      value.sourceResultVersion,
      "replacement source-result version"
    ),
    standingsOperationId: stableId(
      value.standingsOperationId,
      "standings-operation identifier"
    ),
    finalizationId: stableId(
      value.finalizationId,
      "replacement finalization identifier"
    ),
    resultSetHash: canonicalDigest(
      value.resultSetHash,
      "replacement result-set hash"
    ),
    standingsRuleVersion: positiveInteger(
      value.standingsRuleVersion,
      "standings-rule version"
    ),
    expectedMatchupCount: positiveInteger(
      value.expectedMatchupCount,
      "expected matchup count"
    ),
    expectedWeekCount: positiveInteger(
      value.expectedWeekCount,
      "expected week count"
    ),
    participantCount: positiveInteger(
      value.participantCount,
      "participant count"
    ),
    rows: normalizeUniqueArray(
      value.rows,
      normalizeStandingsRow,
      (row) => `${row.id}:${row.teamId}`,
      "replacement standings row"
    ),
    links: normalizeUniqueArray(
      value.links,
      normalizeResultLink,
      (link) =>
        `${link.id}:${link.matchupId}:` +
        `${link.matchupResultId}:${link.resultVersionId}`,
      "replacement result-version link"
    ),
    identities: normalizeUniqueArray(
      value.identities,
      normalizeTeamIdentity,
      (identity) =>
        `${identity.id}:${identity.teamId}`,
      "replacement team identity"
    ),
    standingsRowsChanged: value.standingsRowsChanged,
    notifications,
    outboxId: stableId(
      value.outboxId,
      "outbox-event identifier"
    ),
  });
}

function normalizeAudit(value, {
  actorUserId,
  actorAuthority: authority,
  leagueId,
  nowMs,
}) {
  exactObject(
    value,
    AUDIT_COLUMNS,
    "An exact Security Audit record is required."
  );
  if (
    value.event_type !==
      MATCHUP_RESULT_CORRECTION_AUDIT_EVENT ||
    value.outcome !== "success" ||
    value.actor_user_id !== actorUserId ||
    value.target_user_id !== null ||
    value.league_id !== leagueId ||
    value.reason_code !== null ||
    value.unknown_account_digest !== null ||
    value.occurred_at_ms !== nowMs
  ) {
    invalid("The correction Security Audit record is inconsistent.");
  }
  if (value.client_metadata_json === null) {
    invalid("Correction audit authority metadata is required.");
  }
  let metadata;
  try {
    metadata = JSON.parse(value.client_metadata_json);
  } catch {
    invalid("Correction audit metadata must be valid JSON.");
  }
  if (
    !isPlainObject(metadata) ||
    metadata.actorAuthority !== authority
  ) {
    invalid("Correction audit authority metadata is inconsistent.");
  }
  return Object.freeze({ ...value });
}

function normalizeCommand(value) {
  exactObject(
    value,
    [
      "leagueId",
      "seasonId",
      "resultId",
      "expectedResultVersion",
      "expectedSeasonVersion",
      "actorUserId",
      "actorMembershipId",
      "actorAuthority",
      "idempotency",
      "correction",
      "replacement",
      "preFinalOutboxId",
      "audit",
      "nowMs",
    ],
    "An exact atomic matchup-result correction command is required."
  );
  const nowMs = safeTimestamp(
    value.nowMs,
    "correction timestamp"
  );
  const normalized = {
    leagueId: stableId(
      value.leagueId,
      "league identifier"
    ),
    seasonId: stableId(
      value.seasonId,
      "season identifier"
    ),
    resultId: stableId(
      value.resultId,
      "matchup-result identifier"
    ),
    expectedResultVersion: positiveInteger(
      value.expectedResultVersion,
      "expected matchup-result version"
    ),
    expectedSeasonVersion: positiveInteger(
      value.expectedSeasonVersion,
      "expected season version"
    ),
    actorUserId: stableId(
      value.actorUserId,
      "actor-user identifier"
    ),
    actorMembershipId: stableId(
      value.actorMembershipId,
      "actor-membership identifier"
    ),
    actorAuthority: actorAuthority(
      value.actorAuthority
    ),
    idempotency: normalizeIdempotency(
      value.idempotency,
      nowMs
    ),
    correction: normalizeCorrection(value.correction),
    replacement: normalizeReplacement(value.replacement),
    preFinalOutboxId: optionalStableId(
      value.preFinalOutboxId,
      "pre-final outbox-event identifier"
    ),
    nowMs,
  };
  if (
    (normalized.replacement === null) !==
    (normalized.preFinalOutboxId !== null)
  ) {
    invalid(
      "Exactly one pre-final or replacement outbox plan is required."
    );
  }
  normalized.audit = normalizeAudit(value.audit, {
    actorUserId: normalized.actorUserId,
    actorAuthority: normalized.actorAuthority,
    leagueId: normalized.leagueId,
    nowMs,
  });
  if (normalized.correction.createdAtMs !== nowMs) {
    invalid(
      "The correction and transaction timestamps must match."
    );
  }
  return Object.freeze(normalized);
}

function operationMetadata(resultId, resultVersionId) {
  return JSON.stringify({ resultId, resultVersionId });
}

function parseExactOperationMetadata(
  value,
  resultId,
  resultVersionId
) {
  if (typeof value !== "string") return false;
  let metadata;
  try {
    metadata = JSON.parse(value);
  } catch {
    return false;
  }
  return (
    isPlainObject(metadata) &&
    Object.keys(metadata).length === 2 &&
    Object.keys(metadata).every((key) =>
      ["resultId", "resultVersionId"].includes(key)
    ) &&
    metadata.resultId === resultId &&
    metadata.resultVersionId === resultVersionId
  );
}

function rowsDiffer(priorRows, nextRows) {
  const columns = [
    "rank",
    "wins",
    "losses",
    "ties",
    "standings_points",
    "fantasy_points_for_hundredths",
    "fantasy_points_against_hundredths",
    "fantasy_point_differential_hundredths",
  ];
  const normalizedNext = nextRows
    .map((row) => ({
      team_id: row.teamId,
      rank: row.rank,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      standings_points: row.standingsPoints,
      fantasy_points_for_hundredths:
        row.fantasyPointsForHundredths,
      fantasy_points_against_hundredths:
        row.fantasyPointsAgainstHundredths,
      fantasy_point_differential_hundredths:
        row.fantasyPointsDifferentialHundredths,
    }))
    .sort((left, right) =>
      left.team_id.localeCompare(right.team_id)
    );
  const normalizedPrior = priorRows
    .map((row) => ({ ...row }))
    .sort((left, right) =>
      left.team_id.localeCompare(right.team_id)
    );
  if (normalizedNext.length !== normalizedPrior.length) {
    return true;
  }
  return normalizedNext.some((row, index) => {
    const prior = normalizedPrior[index];
    return (
      row.team_id !== prior.team_id ||
      columns.some(
        (column) => row[column] !== prior[column]
      )
    );
  });
}

function sameBuffer(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    Buffer.isBuffer(left) &&
    Buffer.isBuffer(right) &&
    left.equals(right)
  );
}

function identitiesMatch(prior, replacements) {
  const byTeam = new Map(
    replacements.map((identity) => [
      identity.teamId,
      identity,
    ])
  );
  if (byTeam.size !== prior.length) return false;
  return prior.every((identity) => {
    const replacement = byTeam.get(identity.team_id);
    return (
      replacement &&
      replacement.teamDisplayName ===
        identity.team_display_name &&
      replacement.primaryColour ===
        identity.primary_colour &&
      replacement.secondaryColour ===
        identity.secondary_colour &&
      replacement.tertiaryColour ===
        identity.tertiary_colour &&
      replacement.patternTemplate ===
        identity.pattern_template &&
      replacement.sourceLogoObjectId ===
        identity.source_logo_object_id &&
      replacement.logoMediaType ===
        identity.logo_media_type &&
      replacement.logoByteLength ===
        identity.logo_byte_length &&
      replacement.logoWidth === identity.logo_width &&
      replacement.logoHeight === identity.logo_height &&
      replacement.logoContentSha256 ===
        identity.logo_content_sha256 &&
      sameBuffer(
        replacement.logoContentBytes,
        identity.logo_content_bytes
      )
    );
  });
}

function finalizationProjection(row) {
  if (!row) return null;
  return freezeRow(
    Object.fromEntries(
      FINALIZATION_COLUMNS.map((column) => [
        column,
        row[column],
      ])
    )
  );
}

function versionProjection(row) {
  return freezeRow(
    Object.fromEntries(
      VERSION_COLUMNS.map((column) => [
        column,
        row[column],
      ])
    )
  );
}

function createSqliteMatchupResultCorrectionRepository({
  database,
  leagueOutboxWriter,
  notificationWriter,
  auditRepository,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    invalid(
      "Matchup-result correction requires an opened SQLite database."
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    invalid(
      "Matchup-result correction beforeCommit must be a function."
    );
  }

  let outboxWriter;
  let notifications;
  let securityAudit;
  let finalStandingsRepository;
  let aggregateStatement;
  let resultContextStatement;
  let versionsStatement;
  let correctionOperationsStatement;
  let finalizationsStatement;
  let snapshotStatement;
  let rowsStatement;
  let linksStatement;
  let identitiesStatement;
  let activeMembersStatement;
  let authorityStatement;
  let idempotencyByScopeStatement;
  let idempotencyByIdStatement;
  let idempotencyByResultStatement;
  let resultVersionEvidenceStatement;
  let operationByResultVersionStatement;
  let standingsOperationByIdStatement;
  let insertIdempotencyStatement;
  let insertResultVersionStatement;
  let insertMatchupOperationStatement;
  let insertStandingsOperationStatement;
  let supersedeFinalizationStatement;
  let updateResultStatement;
  let restoreMatchupStatusStatement;
  let restoreWeekStatusStatement;
  let insertFinalizationStatement;
  let updateSeasonStatement;
  let completeIdempotencyStatement;
  let seasonStatement;

  try {
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    if (auditRepository === undefined) {
      securityAudit =
        createSqliteSecurityAuditRepository({
          database,
        });
    } else {
      if (
        !auditRepository ||
        typeof auditRepository.append !== "function"
      ) {
        invalid(
          "A synchronous Security Audit repository is required."
        );
      }
      securityAudit = auditRepository;
    }
    finalStandingsRepository =
      createSqliteMatchupStandingsFinalizationRepository({
        database,
        leagueOutboxWriter: outboxWriter,
        notificationWriter: notifications,
      });

    aggregateStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.status AS league_status,
        leagues.current_season_id AS current_season_id,
        leagues.commissioner_membership_id
          AS commissioner_membership_id,
        seasons.id AS season_id,
        seasons.status AS season_status,
        seasons.version AS season_version,
        league_settings.standings_rule_version
          AS standings_rule_version
      FROM leagues
      JOIN seasons
        ON seasons.league_id = leagues.id
      JOIN league_settings
        ON league_settings.league_id = leagues.id
      WHERE leagues.id = @leagueId
        AND seasons.id = @seasonId
      LIMIT 2
    `);
    resultContextStatement = database.prepare(`
      SELECT
        matchup_results.id AS result_id,
        matchup_results.current_version_id
          AS current_version_id,
        matchup_results.status AS result_status,
        matchup_results.version AS result_version,
        matchup_results.finalized_at_ms AS finalized_at_ms,
        matchups.id AS matchup_id,
        matchups.matchup_week_id AS matchup_week_id,
        matchups.home_team_id AS home_team_id,
        matchups.away_team_id AS away_team_id,
        matchups.status AS matchup_status,
        matchups.version AS matchup_version,
        matchup_weeks.status AS week_status,
        matchup_weeks.version AS week_version
      FROM matchup_results
      JOIN matchups
        ON matchups.league_id =
          matchup_results.league_id
       AND matchups.season_id =
          matchup_results.season_id
       AND matchups.id = matchup_results.matchup_id
      JOIN matchup_weeks
        ON matchup_weeks.league_id = matchups.league_id
       AND matchup_weeks.season_id = matchups.season_id
       AND matchup_weeks.id = matchups.matchup_week_id
      WHERE matchup_results.league_id = @leagueId
        AND matchup_results.season_id = @seasonId
        AND matchup_results.id = @resultId
      LIMIT 2
    `);
    versionsStatement = database.prepare(`
      SELECT
        matchup_result_versions.id AS result_version_id,
        matchup_result_versions.version_number
          AS version_number,
        matchup_result_versions.home_team_id
          AS home_team_id,
        matchup_result_versions.away_team_id
          AS away_team_id,
        matchup_result_versions.home_score_hundredths
          AS home_score_hundredths,
        matchup_result_versions.away_score_hundredths
          AS away_score_hundredths,
        matchup_result_versions.outcome AS outcome,
        matchup_result_versions.source_snapshot_id
          AS source_snapshot_id,
        matchup_result_versions.source_type
          AS source_type,
        matchup_result_versions.actor_user_id
          AS actor_user_id,
        matchup_result_versions.reason AS reason,
        matchup_result_versions.supersedes_version_id
          AS supersedes_version_id,
        matchup_result_versions.created_at_ms
          AS created_at_ms
      FROM matchup_result_versions
      WHERE matchup_result_versions.league_id = @leagueId
        AND matchup_result_versions.season_id = @seasonId
        AND matchup_result_versions.matchup_result_id =
          @resultId
      ORDER BY
        matchup_result_versions.version_number ASC,
        matchup_result_versions.id ASC
    `);
    correctionOperationsStatement = database.prepare(`
      SELECT
        matchup_operations.id AS operation_id,
        matchup_operations.league_id AS league_id,
        matchup_operations.season_id AS season_id,
        matchup_operations.matchup_week_id
          AS matchup_week_id,
        matchup_operations.matchup_id AS matchup_id,
        matchup_operations.actor_user_id AS actor_user_id,
        matchup_operations.operation_type
          AS operation_type,
        matchup_operations.status AS operation_status,
        matchup_operations.reason AS reason,
        matchup_operations.metadata_json AS metadata_json,
        matchup_operations.started_at_ms AS started_at_ms,
        matchup_operations.completed_at_ms
          AS completed_at_ms
      FROM matchup_operations
      WHERE matchup_operations.league_id = @leagueId
        AND matchup_operations.season_id = @seasonId
        AND matchup_operations.matchup_week_id = @weekId
        AND matchup_operations.matchup_id = @matchupId
        AND matchup_operations.operation_type =
          'result_correct'
      ORDER BY
        matchup_operations.completed_at_ms ASC,
        matchup_operations.id ASC
    `);
    finalizationsStatement = database.prepare(`
      SELECT
        id AS finalization_id,
        standings_snapshot_id AS standings_snapshot_id,
        finalization_version AS finalization_version,
        status AS status,
        cause AS cause,
        standings_rule_version AS standings_rule_version,
        result_set_hash AS result_set_hash,
        expected_matchup_count AS expected_matchup_count,
        expected_week_count AS expected_week_count,
        participant_count AS participant_count,
        season_version_before AS season_version_before,
        season_version_after AS season_version_after,
        authorized_by_user_id AS authorized_by_user_id,
        authorized_by_membership_id
          AS authorized_by_membership_id,
        authorized_authority AS authorized_authority,
        standings_operation_id AS standings_operation_id,
        idempotency_request_id AS idempotency_request_id,
        replaces_finalization_id AS replaces_finalization_id,
        superseded_by_snapshot_id
          AS superseded_by_snapshot_id,
        superseded_by_user_id AS superseded_by_user_id,
        superseded_by_membership_id
          AS superseded_by_membership_id,
        superseded_by_authority
          AS superseded_by_authority,
        superseded_by_operation_id
          AS superseded_by_operation_id,
        superseded_at_ms AS superseded_at_ms,
        finalized_at_ms AS finalized_at_ms,
        version AS version
      FROM standings_snapshot_finalizations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND evidence_schema_version = 1
      ORDER BY finalization_version ASC, id ASC
    `);
    snapshotStatement = database.prepare(`
      SELECT
        id AS snapshot_id,
        snapshot_version AS snapshot_version,
        source_result_version AS source_result_version,
        status AS snapshot_status,
        calculated_at_ms AS calculated_at_ms,
        created_at_ms AS created_at_ms
      FROM standings_snapshots
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @snapshotId
      LIMIT 2
    `);
    rowsStatement = database.prepare(`
      SELECT *
      FROM standings_rows
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND standings_snapshot_id = @snapshotId
      ORDER BY team_id ASC
    `);
    linksStatement = database.prepare(`
      SELECT
        standings_snapshot_result_versions.id AS id,
        standings_snapshot_result_versions.matchup_week_id
          AS matchup_week_id,
        standings_snapshot_result_versions.matchup_id
          AS matchup_id,
        standings_snapshot_result_versions.matchup_result_id
          AS matchup_result_id,
        standings_snapshot_result_versions
          .matchup_result_version_id
          AS matchup_result_version_id,
        standings_snapshot_result_versions
          .result_version_number
          AS result_version_number,
        matchup_result_versions.home_team_id
          AS home_team_id,
        matchup_result_versions.away_team_id
          AS away_team_id,
        matchup_result_versions.home_score_hundredths
          AS home_score_hundredths,
        matchup_result_versions.away_score_hundredths
          AS away_score_hundredths,
        matchup_result_versions.outcome AS outcome,
        matchup_result_versions.source_snapshot_id
          AS source_snapshot_id,
        matchup_result_versions.source_type
          AS source_type,
        matchup_result_versions.actor_user_id
          AS actor_user_id,
        matchup_result_versions.reason AS reason,
        matchup_result_versions.supersedes_version_id
          AS supersedes_version_id,
        matchup_result_versions.created_at_ms
          AS result_created_at_ms
      FROM standings_snapshot_result_versions
      JOIN matchup_result_versions
        ON matchup_result_versions.league_id =
          standings_snapshot_result_versions.league_id
       AND matchup_result_versions.season_id =
          standings_snapshot_result_versions.season_id
       AND matchup_result_versions.matchup_result_id =
          standings_snapshot_result_versions.matchup_result_id
       AND matchup_result_versions.id =
          standings_snapshot_result_versions
            .matchup_result_version_id
       AND matchup_result_versions.version_number =
          standings_snapshot_result_versions
            .result_version_number
      WHERE standings_snapshot_result_versions.league_id =
          @leagueId
        AND standings_snapshot_result_versions.season_id =
          @seasonId
        AND standings_snapshot_result_versions
          .standings_snapshot_id = @snapshotId
      ORDER BY
        standings_snapshot_result_versions.matchup_id ASC,
        standings_snapshot_result_versions.matchup_result_id ASC
    `);
    identitiesStatement = database.prepare(`
      SELECT *
      FROM standings_snapshot_team_identities
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND standings_snapshot_id = @snapshotId
      ORDER BY team_id ASC
    `);
    activeMembersStatement = database.prepare(`
      SELECT DISTINCT
        league_memberships.user_id AS user_id
      FROM league_memberships
      JOIN users
        ON users.id = league_memberships.user_id
       AND users.status = 'active'
      WHERE league_memberships.league_id = @leagueId
        AND league_memberships.status = 'active'
      ORDER BY league_memberships.user_id ASC
    `);
    authorityStatement = database.prepare(`
      SELECT
        league_memberships.id AS membership_id,
        league_memberships.user_id AS user_id,
        league_memberships.status AS membership_status,
        leagues.commissioner_membership_id
          AS commissioner_membership_id,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id =
              league_memberships.user_id
            AND platform_roles.role =
              'platform_administrator'
            AND platform_roles.status = 'active'
        ) THEN 1 ELSE 0 END AS active_platform_administrator
      FROM league_memberships
      JOIN leagues
        ON leagues.id = league_memberships.league_id
      WHERE league_memberships.league_id = @leagueId
        AND league_memberships.id = @membershipId
        AND league_memberships.user_id = @actorUserId
      LIMIT 2
    `);
    idempotencyByScopeStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation =
          '${MATCHUP_RESULT_CORRECTION_OPERATION}'
        AND client_key = @clientKey
      LIMIT 2
    `);
    idempotencyByIdStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND id = @id
      LIMIT 2
    `);
    idempotencyByResultStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND operation =
          '${MATCHUP_RESULT_CORRECTION_OPERATION}'
        AND status = 'completed'
        AND result_type =
          '${MATCHUP_RESULT_CORRECTION_RESULT_TYPE}'
        AND result_id = @resultVersionId
      ORDER BY id ASC
      LIMIT 2
    `);
    resultVersionEvidenceStatement = database.prepare(`
      SELECT
        matchup_result_versions.id AS result_version_id,
        matchup_result_versions.league_id AS league_id,
        matchup_result_versions.season_id AS season_id,
        matchup_result_versions.matchup_result_id
          AS result_id,
        matchup_result_versions.version_number
          AS result_version_number,
        matchup_result_versions.source_type AS source_type,
        matchup_result_versions.actor_user_id
          AS actor_user_id,
        matchup_result_versions.reason AS reason,
        matchup_result_versions.supersedes_version_id
          AS supersedes_version_id,
        matchup_result_versions.created_at_ms
          AS corrected_at_ms
      FROM matchup_result_versions
      WHERE matchup_result_versions.league_id = @leagueId
        AND matchup_result_versions.id = @resultVersionId
      LIMIT 2
    `);
    operationByResultVersionStatement = database.prepare(`
      SELECT *
      FROM matchup_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND operation_type = 'result_correct'
        AND status = 'succeeded'
        AND json_valid(metadata_json) = 1
        AND json_extract(
          metadata_json,
          '$.resultVersionId'
        ) = @resultVersionId
      ORDER BY id ASC
      LIMIT 3
    `);
    standingsOperationByIdStatement =
      database.prepare(`
        SELECT *
        FROM standings_operations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND id = @operationId
        LIMIT 2
      `);
    insertIdempotencyStatement = database.prepare(`
      INSERT INTO idempotency_requests (
        id,
        league_id,
        actor_user_id,
        operation,
        client_key,
        request_hash,
        status,
        result_type,
        result_id,
        created_at_ms,
        completed_at_ms,
        expires_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @actorUserId,
        '${MATCHUP_RESULT_CORRECTION_OPERATION}',
        @clientKey,
        @requestHash,
        'started',
        NULL,
        NULL,
        @nowMs,
        NULL,
        @expiresAtMs
      )
    `);
    insertResultVersionStatement = database.prepare(`
      INSERT INTO matchup_result_versions (
        id,
        league_id,
        season_id,
        matchup_result_id,
        version_number,
        home_team_id,
        away_team_id,
        home_score_hundredths,
        away_score_hundredths,
        outcome,
        source_snapshot_id,
        source_type,
        actor_user_id,
        reason,
        supersedes_version_id,
        created_at_ms
      ) VALUES (
        @resultVersionId,
        @leagueId,
        @seasonId,
        @resultId,
        @versionNumber,
        @homeTeamId,
        @awayTeamId,
        @homeScoreHundredths,
        @awayScoreHundredths,
        @outcome,
        @sourceSnapshotId,
        'correction',
        @actorUserId,
        @reason,
        @supersedesVersionId,
        @nowMs
      )
    `);
    insertMatchupOperationStatement = database.prepare(`
      INSERT INTO matchup_operations (
        id,
        league_id,
        season_id,
        matchup_week_id,
        matchup_id,
        actor_user_id,
        operation_type,
        status,
        reason,
        metadata_json,
        started_at_ms,
        completed_at_ms
      ) VALUES (
        @matchupOperationId,
        @leagueId,
        @seasonId,
        @weekId,
        @matchupId,
        @actorUserId,
        'result_correct',
        'succeeded',
        @reason,
        @metadataJson,
        @nowMs,
        @nowMs
      )
    `);
    insertStandingsOperationStatement = database.prepare(`
      INSERT INTO standings_operations (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        actor_user_id,
        actor_membership_id,
        actor_authority,
        operation_type,
        status,
        reason,
        metadata_json,
        idempotency_request_id,
        started_at_ms,
        completed_at_ms
      ) VALUES (
        @standingsOperationId,
        @leagueId,
        @seasonId,
        @snapshotId,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        'correction_propagation',
        'succeeded',
        @reason,
        @metadataJson,
        @idempotencyRequestId,
        @nowMs,
        @nowMs
      )
    `);
    supersedeFinalizationStatement = database.prepare(`
      UPDATE standings_snapshot_finalizations
      SET status = 'superseded',
        superseded_by_snapshot_id = @snapshotId,
        superseded_by_user_id = @actorUserId,
        superseded_by_membership_id =
          @actorMembershipId,
        superseded_by_authority = @actorAuthority,
        superseded_by_operation_id =
          @standingsOperationId,
        superseded_at_ms = @nowMs,
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @priorFinalizationId
        AND status = 'final'
        AND version = @priorFinalizationVersion
    `);
    updateResultStatement = database.prepare(`
      UPDATE matchup_results
      SET current_version_id = @resultVersionId,
        status = 'corrected',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @resultId
        AND current_version_id = @supersedesVersionId
        AND version = @expectedResultVersion
        AND status IN ('official', 'corrected')
    `);
    restoreMatchupStatusStatement = database.prepare(`
      UPDATE matchups
      SET status = 'final',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @matchupId
        AND status = 'correction_required'
        AND version = @expectedVersion
    `);
    restoreWeekStatusStatement = database.prepare(`
      UPDATE matchup_weeks
      SET status = 'final',
        updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @weekId
        AND status = 'correction_required'
        AND version = @expectedVersion
    `);
    insertFinalizationStatement = database.prepare(`
      INSERT INTO standings_snapshot_finalizations (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        finalization_version,
        evidence_schema_version,
        status,
        cause,
        standings_rule_version,
        result_set_hash,
        result_set_hash_version,
        expected_matchup_count,
        finalized_matchup_count,
        expected_week_count,
        weeks_counted,
        participant_count,
        standings_row_count,
        completeness_status,
        season_version_before,
        season_version_after,
        authorized_by_user_id,
        authorized_by_membership_id,
        authorized_authority,
        standings_operation_id,
        idempotency_request_id,
        replaces_finalization_id,
        superseded_by_snapshot_id,
        superseded_by_user_id,
        superseded_by_membership_id,
        superseded_by_authority,
        superseded_by_operation_id,
        superseded_at_ms,
        finalized_at_ms,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @finalizationId,
        @leagueId,
        @seasonId,
        @snapshotId,
        @snapshotVersion,
        1,
        'final',
        'result_correction',
        @standingsRuleVersion,
        @resultSetHash,
        1,
        @expectedMatchupCount,
        @expectedMatchupCount,
        @expectedWeekCount,
        @expectedWeekCount,
        @participantCount,
        @participantCount,
        'complete',
        @expectedSeasonVersion,
        @seasonVersionAfter,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        @standingsOperationId,
        @idempotencyRequestId,
        @priorFinalizationId,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @nowMs,
        @nowMs,
        @nowMs,
        1
      )
    `);
    updateSeasonStatement = database.prepare(`
      UPDATE seasons
      SET updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND version = @expectedSeasonVersion
        AND status IN ('active', 'completed')
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
        result_type =
          '${MATCHUP_RESULT_CORRECTION_RESULT_TYPE}',
        result_id = @resultVersionId,
        completed_at_ms = @nowMs
      WHERE league_id = @leagueId
        AND id = @idempotencyRequestId
        AND actor_user_id = @actorUserId
        AND operation =
          '${MATCHUP_RESULT_CORRECTION_OPERATION}'
        AND status = 'started'
        AND result_type IS NULL
        AND result_id IS NULL
        AND completed_at_ms IS NULL
    `);
    seasonStatement = database.prepare(`
      SELECT *
      FROM seasons
      WHERE league_id = @leagueId
        AND id = @seasonId
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareMatchupResultCorrectionRepository",
    });
  }

  function readActiveFinalization(
    scope,
    finalization
  ) {
    if (!finalization) return null;
    const snapshot = uniqueRow(
      snapshotStatement,
      {
        ...scope,
        snapshotId:
          finalization.standings_snapshot_id,
      },
      "The canonical standings snapshot"
    );
    if (!snapshot) {
      incompatible(
        "The canonical standings snapshot is missing."
      );
    }
    return Object.freeze({
      finalization,
      snapshot,
      rows: freezeRows(
        rowsStatement.all({
          ...scope,
          snapshotId: snapshot.snapshot_id,
        })
      ),
      links: freezeRows(
        linksStatement.all({
          ...scope,
          snapshotId: snapshot.snapshot_id,
        })
      ),
      identities: freezeRows(
        identitiesStatement.all({
          ...scope,
          snapshotId: snapshot.snapshot_id,
        })
      ),
    });
  }

  function readContextInternal(input) {
    const scope = {
      leagueId: stableId(
        input.leagueId,
        "league identifier"
      ),
      seasonId: stableId(
        input.seasonId,
        "season identifier"
      ),
      resultId: stableId(
        input.resultId,
        "matchup-result identifier"
      ),
    };
    const aggregate = uniqueRow(
      aggregateStatement,
      scope,
      "The correction league-season aggregate"
    );
    const joined = uniqueRow(
      resultContextStatement,
      scope,
      "The correction matchup result"
    );
    if (!aggregate || !joined) return null;

    const matchup = freezeRow({
      matchup_id: joined.matchup_id,
      matchup_week_id: joined.matchup_week_id,
      home_team_id: joined.home_team_id,
      away_team_id: joined.away_team_id,
      matchup_status: joined.matchup_status,
      matchup_version: joined.matchup_version,
      week_status: joined.week_status,
      week_version: joined.week_version,
    });
    const result = freezeRow({
      result_id: joined.result_id,
      current_version_id: joined.current_version_id,
      result_status: joined.result_status,
      result_version: joined.result_version,
      finalized_at_ms: joined.finalized_at_ms,
    });
    const versions = freezeRows(
      versionsStatement.all(scope).map(
        versionProjection
      )
    );
    const correctionOperations = freezeRows(
      correctionOperationsStatement.all({
        ...scope,
        weekId: matchup.matchup_week_id,
        matchupId: matchup.matchup_id,
      })
    );
    const finalizations = freezeRows(
      finalizationsStatement
        .all(scope)
        .map(finalizationProjection)
    );
    const active = finalizations.filter(
      (finalization) =>
        finalization.status === "final"
    );
    if (active.length > 1) {
      incompatible(
        "The canonical standings finalization is ambiguous."
      );
    }
    const activeFinalization =
      readActiveFinalization(scope, active[0] || null);
    const activeMemberUserIds = Object.freeze(
      activeMembersStatement
        .all({ leagueId: scope.leagueId })
        .map((row) =>
          stableId(
            row.user_id,
            "active league-member user identifier"
          )
        )
    );

    return Object.freeze({
      aggregate,
      matchup,
      result,
      versions,
      correctionOperations,
      finalizations,
      canonicalFinalizationHistoryCount:
        finalizations.length,
      activeFinalization,
      activeMemberUserIds,
    });
  }

  function publicContext(context) {
    if (!context) return null;
    return Object.freeze({
      aggregate: freezeRow({
        league_id: context.aggregate.league_id,
        league_status:
          context.aggregate.league_status,
        current_season_id:
          context.aggregate.current_season_id,
        season_id: context.aggregate.season_id,
        season_status:
          context.aggregate.season_status,
        season_version:
          context.aggregate.season_version,
        standings_rule_version:
          context.aggregate.standings_rule_version,
      }),
      matchup: context.matchup,
      result: context.result,
      versions: context.versions,
      finalizations: context.finalizations,
      canonicalFinalizationHistoryCount:
        context.canonicalFinalizationHistoryCount,
      activeFinalization:
        context.activeFinalization,
      activeMemberUserIds:
        context.activeMemberUserIds,
    });
  }

  function inspectCurrentAuthority(command) {
    const authority = uniqueRow(
      authorityStatement,
      {
        leagueId: command.leagueId,
        membershipId: command.actorMembershipId,
        actorUserId: command.actorUserId,
      },
      "The correction actor authority"
    );
    if (
      !authority ||
      authority.membership_status !== "active" ||
      (command.actorAuthority === "commissioner" &&
        authority.commissioner_membership_id !==
          command.actorMembershipId) ||
      (command.actorAuthority ===
        "platform_administrator_as_commissioner" &&
        authority.active_platform_administrator !== 1)
    ) {
      conflict(
        "Current league correction authority is required."
      );
    }
    return authority;
  }

  function inspectAuthority(context, command) {
    inspectCurrentAuthority(command);
    if (
      !["active", "frozen"].includes(
        context.aggregate.league_status
      )
    ) {
      conflict(
        "The league is unavailable for result correction."
      );
    }
  }

  function inspectVersionChain(context, nowMs) {
    const {
      correctionOperations,
      matchup,
      result,
      versions,
    } = context;
    if (
      !CORRECTABLE_MATCHUP_STATUSES.has(
        matchup.matchup_status
      ) ||
      matchup.matchup_status !==
        matchup.week_status ||
      !Number.isSafeInteger(matchup.matchup_version) ||
      matchup.matchup_version < 1 ||
      !Number.isSafeInteger(matchup.week_version) ||
      matchup.week_version < 1 ||
      !["official", "corrected"].includes(
        result.result_status
      ) ||
      !Number.isSafeInteger(result.finalized_at_ms) ||
      result.finalized_at_ms < 0 ||
      result.finalized_at_ms > nowMs ||
      versions.length < 1 ||
      result.result_version !== versions.length ||
      result.result_version !==
        versions.at(-1).version_number ||
      result.current_version_id !==
        versions.at(-1).result_version_id
    ) {
      conflict(
        "The official matchup-result version chain changed."
      );
    }

    const usedOperationIds = new Set();
    for (const [index, version] of versions.entries()) {
      const versionNumber = index + 1;
      if (
        version.version_number !== versionNumber ||
        version.home_team_id !==
          matchup.home_team_id ||
        version.away_team_id !==
          matchup.away_team_id ||
        !RESULT_OUTCOMES.has(version.outcome) ||
        !Number.isSafeInteger(
          version.home_score_hundredths
        ) ||
        version.home_score_hundredths < 0 ||
        !Number.isSafeInteger(
          version.away_score_hundredths
        ) ||
        version.away_score_hundredths < 0 ||
        !UUID_PATTERN.test(
          version.source_snapshot_id || ""
        ) ||
        !Number.isSafeInteger(version.created_at_ms) ||
        version.created_at_ms < 0 ||
        version.created_at_ms > nowMs
      ) {
        conflict(
          "The official matchup-result version chain is invalid."
        );
      }
      const expectedOutcome =
        version.home_score_hundredths ===
        version.away_score_hundredths
          ? "tie"
          : version.home_score_hundredths >
              version.away_score_hundredths
            ? "home_win"
            : "away_win";
      if (version.outcome !== expectedOutcome) {
        conflict(
          "The official matchup-result version outcome is invalid."
        );
      }

      if (versionNumber === 1) {
        if (
          version.source_type !== "calculated" ||
          version.actor_user_id !== null ||
          version.reason !== null ||
          version.supersedes_version_id !== null
        ) {
          conflict(
            "The original matchup-result version is invalid."
          );
        }
        continue;
      }

      const previous = versions[index - 1];
      if (
        version.source_type !== "correction" ||
        !UUID_PATTERN.test(
          version.actor_user_id || ""
        ) ||
        typeof version.reason !== "string" ||
        version.reason.length < 1 ||
        version.reason.length > 500 ||
        version.reason !== version.reason.trim() ||
        FORBIDDEN_TEXT_PATTERN.test(version.reason) ||
        version.supersedes_version_id !==
          previous.result_version_id ||
        version.created_at_ms < previous.created_at_ms
      ) {
        conflict(
          "The corrected matchup-result version chain is invalid."
        );
      }

      const matches = correctionOperations.filter(
        (operation) =>
          operation.league_id ===
            context.aggregate.league_id &&
          operation.season_id ===
            context.aggregate.season_id &&
          operation.matchup_week_id ===
            matchup.matchup_week_id &&
          operation.matchup_id ===
            matchup.matchup_id &&
          operation.actor_user_id ===
            version.actor_user_id &&
          operation.operation_type ===
            "result_correct" &&
          operation.operation_status ===
            "succeeded" &&
          operation.reason === version.reason &&
          operation.started_at_ms ===
            version.created_at_ms &&
          operation.completed_at_ms ===
            version.created_at_ms &&
          parseExactOperationMetadata(
            operation.metadata_json,
            result.result_id,
            version.result_version_id
          )
      );
      if (
        matches.length !== 1 ||
        usedOperationIds.has(matches[0]?.operation_id)
      ) {
        conflict(
          "The result-correction operation history is invalid."
        );
      }
      usedOperationIds.add(matches[0].operation_id);
    }

    if (
      usedOperationIds.size !==
        correctionOperations.length
    ) {
      conflict(
        "The result-correction operation history is ambiguous."
      );
    }
    return versions.at(-1);
  }

  function inspectCanonicalHistory(context) {
    const {
      activeFinalization,
      canonicalFinalizationHistoryCount,
      finalizations,
    } = context;
    if (canonicalFinalizationHistoryCount === 0) {
      if (activeFinalization !== null) {
        incompatible(
          "Canonical finalization classification is inconsistent."
        );
      }
      return null;
    }
    if (activeFinalization === null) {
      conflict(
        "Canonical finalization history has no active final."
      );
    }
    const active = activeFinalization.finalization;
    const first = finalizations[0];
    if (
      first.cause !== "regular_season_completion" ||
      active.finalization_id !==
        finalizations.at(-1).finalization_id
    ) {
      conflict(
        "The canonical finalization chain is invalid."
      );
    }
    for (const [index, finalization] of
      finalizations.entries()) {
      const isLast = index === finalizations.length - 1;
      if (
        (isLast
          ? finalization.status !== "final"
          : finalization.status !== "superseded") ||
        (index > 0 &&
          (finalization.cause !==
            "result_correction" ||
            finalization.replaces_finalization_id !==
              finalizations[index - 1]
                .finalization_id ||
            finalization.finalization_version !==
              finalizations[index - 1]
                .finalization_version +
                1)) ||
        (index === 0 &&
          finalization.replaces_finalization_id !== null)
      ) {
        conflict(
          "The canonical finalization chain is invalid."
        );
      }
      if (!isLast) {
        const replacement = finalizations[index + 1];
        if (
          finalization.superseded_by_snapshot_id !==
            replacement.standings_snapshot_id ||
          finalization.superseded_by_operation_id !==
            replacement.standings_operation_id ||
          finalization.superseded_by_user_id !==
            replacement.authorized_by_user_id ||
          finalization
            .superseded_by_membership_id !==
            replacement.authorized_by_membership_id ||
          finalization.superseded_by_authority !==
            replacement.authorized_authority
        ) {
          conflict(
            "The canonical finalization supersession chain is invalid."
          );
        }
      }
    }
    const { snapshot, rows, links, identities } =
      activeFinalization;
    if (
      snapshot.snapshot_status !== "final" ||
      snapshot.snapshot_id !==
        active.standings_snapshot_id ||
      snapshot.snapshot_version !==
        active.finalization_version ||
      snapshot.calculated_at_ms !==
        active.finalized_at_ms ||
      rows.length !== active.participant_count ||
      identities.length !==
        active.participant_count ||
      links.length !==
        active.expected_matchup_count ||
      active.expected_matchup_count < 1 ||
      active.expected_week_count < 1 ||
      active.participant_count < 2
    ) {
      conflict(
        "The active canonical finalization is incomplete."
      );
    }
    const rowTeams = rows.map((row) => row.team_id);
    const identityTeams = identities.map(
      (identity) => identity.team_id
    );
    if (
      new Set(rowTeams).size !== rowTeams.length ||
      new Set(identityTeams).size !==
        identityTeams.length ||
      [...rowTeams]
        .sort()
        .some(
          (teamId, index) =>
            teamId !== [...identityTeams].sort()[index]
        )
    ) {
      conflict(
        "Canonical standings row and identity coverage is invalid."
      );
    }
    const linkedSourceVersion = links.reduce(
      (total, link) =>
        total + link.result_version_number,
      0
    );
    if (
      !Number.isSafeInteger(linkedSourceVersion) ||
      linkedSourceVersion !==
        snapshot.source_result_version
    ) {
      conflict(
        "Canonical result-version provenance is invalid."
      );
    }
    const hash = calculateStandingsResultSetHash({
      leagueId: context.aggregate.league_id,
      seasonId: context.aggregate.season_id,
      standingsRuleVersion: String(
        active.standings_rule_version
      ),
      results: links.map((link) => ({
        matchupId: link.matchup_id,
        matchupResultId: link.matchup_result_id,
        resultVersionId:
          link.matchup_result_version_id,
        resultVersion:
          link.result_version_number,
      })),
    });
    if (hash !== active.result_set_hash) {
      conflict(
        "Canonical result-set provenance is invalid."
      );
    }
    const targetLinks = links.filter(
      (link) =>
        link.matchup_result_id ===
        context.result.result_id
    );
    if (
      targetLinks.length !== 1 ||
      targetLinks[0].matchup_result_version_id !==
        context.result.current_version_id
    ) {
      conflict(
        "The active finalization does not link the official result."
      );
    }
    return activeFinalization;
  }

  function inspectReplacement(
    context,
    command,
    activeFinalization
  ) {
    const replacement = command.replacement;
    if (!activeFinalization || !replacement) {
      invalid(
        "A complete canonical replacement plan is required."
      );
    }
    const prior =
      activeFinalization.finalization;
    const priorSnapshot =
      activeFinalization.snapshot;
    if (
      replacement.snapshotVersion !==
        prior.finalization_version + 1 ||
      replacement.sourceResultVersion !==
        priorSnapshot.source_result_version + 1 ||
      replacement.standingsRuleVersion !==
        prior.standings_rule_version ||
      replacement.expectedMatchupCount !==
        prior.expected_matchup_count ||
      replacement.expectedWeekCount !==
        prior.expected_week_count ||
      replacement.participantCount !==
        prior.participant_count ||
      replacement.rows.length !==
        prior.participant_count ||
      replacement.links.length !==
        prior.expected_matchup_count ||
      replacement.identities.length !==
        prior.participant_count
    ) {
      invalid(
        "Replacement finalization counts or rule provenance changed."
      );
    }

    for (const [rows, key, description] of [
      [replacement.rows, "teamId", "standings teams"],
      [replacement.links, "matchupId", "matchups"],
      [
        replacement.links,
        "matchupResultId",
        "matchup results",
      ],
      [
        replacement.links,
        "resultVersionId",
        "result versions",
      ],
      [
        replacement.identities,
        "teamId",
        "team identities",
      ],
      [
        replacement.notifications,
        "userId",
        "notification recipients",
      ],
    ]) {
      const values = rows.map((row) => row[key]);
      if (new Set(values).size !== values.length) {
        invalid(
          `Replacement ${description} must be unique.`
        );
      }
    }

    const priorByResultId = new Map(
      activeFinalization.links.map((link) => [
        link.matchup_result_id,
        link,
      ])
    );
    let changedLinkCount = 0;
    for (const link of replacement.links) {
      const priorLink = priorByResultId.get(
        link.matchupResultId
      );
      if (
        !priorLink ||
        link.matchupWeekId !==
          priorLink.matchup_week_id ||
        link.matchupId !== priorLink.matchup_id
      ) {
        invalid(
          "Replacement result-version link identity drifted."
        );
      }
      if (
        link.resultVersionId !==
          priorLink.matchup_result_version_id
      ) {
        changedLinkCount += 1;
        if (
          link.matchupResultId !==
            command.resultId ||
          link.resultVersionId !==
            command.correction.resultVersionId ||
          link.resultVersionNumber !==
            priorLink.result_version_number + 1 ||
          priorLink.matchup_result_version_id !==
            command.correction
              .supersedesVersionId
        ) {
          invalid(
            "Replacement result-version link is not the direct correction."
          );
        }
      } else if (
        link.resultVersionNumber !==
        priorLink.result_version_number
      ) {
        invalid(
          "An unchanged replacement result link drifted."
        );
      }
    }
    if (
      changedLinkCount !== 1 ||
      priorByResultId.size !==
        replacement.links.length
    ) {
      invalid(
        "Replacement standings must change exactly one result link."
      );
    }

    const calculatedHash =
      calculateStandingsResultSetHash({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        standingsRuleVersion: String(
          replacement.standingsRuleVersion
        ),
        results: replacement.links.map((link) => ({
          matchupId: link.matchupId,
          matchupResultId:
            link.matchupResultId,
          resultVersionId:
            link.resultVersionId,
          resultVersion:
            link.resultVersionNumber,
        })),
      });
    if (calculatedHash !== replacement.resultSetHash) {
      invalid(
        "Replacement result-set hash is inconsistent."
      );
    }

    const priorTeamIds =
      activeFinalization.rows
        .map((row) => row.team_id)
        .sort();
    const replacementTeamIds =
      replacement.rows
        .map((row) => row.teamId)
        .sort();
    if (
      priorTeamIds.some(
        (teamId, index) =>
          teamId !== replacementTeamIds[index]
      ) ||
      !identitiesMatch(
        activeFinalization.identities,
        replacement.identities
      )
    ) {
      invalid(
        "Replacement standings participant identity drifted."
      );
    }

    const calculatedRowsChanged = rowsDiffer(
      activeFinalization.rows,
      replacement.rows
    );
    if (
      replacement.standingsRowsChanged !==
      calculatedRowsChanged
    ) {
      invalid(
        "Replacement standings notification decision is inconsistent."
      );
    }
    const recipients = replacement.notifications
      .map((notification) => notification.userId)
      .sort();
    const activeMembers = [
      ...context.activeMemberUserIds,
    ].sort();
    if (
      calculatedRowsChanged
        ? recipients.length !== activeMembers.length ||
          recipients.some(
            (userId, index) =>
              userId !== activeMembers[index]
          )
        : recipients.length !== 0
    ) {
      invalid(
        "Correction notification recipients are inconsistent."
      );
    }
    return Object.freeze({
      ...replacement,
      priorFinalizationId:
        prior.finalization_id,
      priorFinalizationVersion: prior.version,
      seasonVersionAfter:
        command.expectedSeasonVersion + 1,
    });
  }

  function inspectFreshContext(context, command) {
    if (!context) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The matchup result was not found."
      );
    }
    if (
      context.aggregate.league_id !==
        command.leagueId ||
      context.aggregate.season_id !==
        command.seasonId ||
      context.aggregate.season_version !==
        command.expectedSeasonVersion ||
      context.result.result_id !==
        command.resultId ||
      context.result.result_version !==
        command.expectedResultVersion
    ) {
      conflict(
        "The correction aggregate changed."
      );
    }
    inspectAuthority(context, command);
    const current = inspectVersionChain(
      context,
      command.nowMs
    );
    if (
      command.correction.versionNumber !==
        command.expectedResultVersion + 1 ||
      command.correction.versionNumber !==
        current.version_number + 1 ||
      command.correction.supersedesVersionId !==
        current.result_version_id ||
      command.correction.sourceSnapshotId !==
        current.source_snapshot_id ||
      command.correction.homeTeamId !==
        context.matchup.home_team_id ||
      command.correction.awayTeamId !==
        context.matchup.away_team_id ||
      command.nowMs < current.created_at_ms
    ) {
      conflict(
        "The requested correction is not the direct next result version."
      );
    }

    const activeFinalization =
      inspectCanonicalHistory(context);
    if (activeFinalization === null) {
      if (
        command.replacement !== null ||
        context.aggregate.season_status !== "active" ||
        context.aggregate.current_season_id !==
          command.seasonId
      ) {
        conflict(
          "A pre-final correction requires the current active season."
        );
      }
      return Object.freeze({
        activeFinalization: null,
        replacement: null,
      });
    }
    if (
      !["active", "completed"].includes(
        context.aggregate.season_status
      ) ||
      (context.aggregate.season_status === "active" &&
        context.aggregate.current_season_id !==
          command.seasonId) ||
      (context.aggregate.season_status === "completed" &&
        context.aggregate.current_season_id ===
          command.seasonId)
    ) {
      conflict(
        "The canonical final season is unavailable for correction."
      );
    }
    return Object.freeze({
      activeFinalization,
      replacement: inspectReplacement(
        context,
        command,
        activeFinalization
      ),
    });
  }

  function runExactly(
    statement,
    parameters,
    message
  ) {
    if (statement.run(parameters).changes !== 1) {
      conflict(message);
    }
  }

  function writeCorrectionOutbox({
    command,
    resultVersion,
    replacement,
  }) {
    const postFinal = replacement !== null;
    const eventType = postFinal
      ? "standings.changed"
      : "matchup.changed";
    const aggregateType = postFinal
      ? "season"
      : "matchup_result";
    const aggregateId = postFinal
      ? command.seasonId
      : command.resultId;
    const version = postFinal
      ? replacement.seasonVersionAfter
      : resultVersion;
    return outboxWriter.write({
      id: postFinal
        ? replacement.outboxId
        : command.preFinalOutboxId,
      leagueId: command.leagueId,
      eventType,
      aggregateType,
      aggregateId,
      payload: createSocketEventMetadata({
        eventType,
        version,
        reasonCode: "correction_applied",
        occurredAtMs: command.nowMs,
        related: createEmptySocketRelated(),
      }),
      occurredAtMs: command.nowMs,
      audiences: [{ kind: "league" }],
    });
  }

  function writeCorrectionNotification({
    command,
    replacement,
    notification,
  }) {
    return notifications.insert({
      id: notification.id,
      userId: notification.userId,
      leagueId: command.leagueId,
      eventType: "standings_corrected",
      messageDataJson: JSON.stringify({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        snapshotId: replacement.snapshotId,
        resultVersionId:
          command.correction.resultVersionId,
      }),
      relatedFeature: "standings",
      relatedRecordId:
        replacement.finalizationId,
      deliveryStatus: "pending",
      createdAtMs: command.nowMs,
      deliveredAtMs: null,
      deduplicationKey:
        `standings_corrected:${command.leagueId}:` +
        `${command.seasonId}:` +
        `${command.correction.resultVersionId}:` +
        notification.userId,
    });
  }

  function initialFinalizationPreservesCorrection({
    finalizations,
    scope,
    version,
  }) {
    const initial = finalizations[0];
    if (
      !initial ||
      initial.cause !==
        "regular_season_completion" ||
      initial.replaces_finalization_id !== null
    ) {
      incompatible(
        "The initial canonical finalization evidence is invalid."
      );
    }
    const targetLinks = linksStatement
      .all({
        leagueId: scope.leagueId,
        seasonId: version.season_id,
        snapshotId:
          initial.standings_snapshot_id,
      })
      .filter(
        (link) =>
          link.matchup_result_id ===
          version.result_id
      );
    if (targetLinks.length !== 1) {
      incompatible(
        "The initial canonical result link is unavailable."
      );
    }
    const initialLink = targetLinks[0];
    if (
      initialLink.result_version_number <
      version.result_version_number
    ) {
      return false;
    }
    const versions = versionsStatement.all({
      leagueId: scope.leagueId,
      seasonId: version.season_id,
      resultId: version.result_id,
    });
    const targetIndex = versions.findIndex(
      (candidate) =>
        candidate.result_version_id ===
        version.result_version_id
    );
    const linkedIndex = versions.findIndex(
      (candidate) =>
        candidate.result_version_id ===
        initialLink.matchup_result_version_id
    );
    if (
      targetIndex < 0 ||
      linkedIndex < targetIndex ||
      versions[targetIndex].version_number !==
        version.result_version_number ||
      versions[linkedIndex].version_number !==
        initialLink.result_version_number
    ) {
      incompatible(
        "The initial canonical result-version chain is invalid."
      );
    }
    for (
      let index = targetIndex + 1;
      index <= linkedIndex;
      index += 1
    ) {
      const prior = versions[index - 1];
      const candidate = versions[index];
      if (
        candidate.version_number !==
          prior.version_number + 1 ||
        candidate.source_type !== "correction" ||
        candidate.supersedes_version_id !==
          prior.result_version_id
      ) {
        incompatible(
          "The initial canonical result version is not a direct correction descendant."
        );
      }
    }
    return true;
  }

  function readCorrectionResultInternal({
    leagueId,
    resultVersionId,
  }) {
    const scope = {
      leagueId: stableId(
        leagueId,
        "league identifier"
      ),
      resultVersionId: stableId(
        resultVersionId,
        "result-version identifier"
      ),
    };
    const version = uniqueRow(
      resultVersionEvidenceStatement,
      scope,
      "The corrected result version"
    );
    if (!version) return null;
    if (
      version.source_type !== "correction" ||
      !UUID_PATTERN.test(version.actor_user_id || "") ||
      typeof version.reason !== "string" ||
      version.reason.length < 1 ||
      version.result_version_number < 2 ||
      !UUID_PATTERN.test(
        version.supersedes_version_id || ""
      ) ||
      !Number.isSafeInteger(version.corrected_at_ms)
    ) {
      incompatible(
        "The corrected result-version evidence is invalid."
      );
    }

    const operations =
      operationByResultVersionStatement.all({
        leagueId: scope.leagueId,
        seasonId: version.season_id,
        resultVersionId: scope.resultVersionId,
      });
    if (operations.length !== 1) {
      incompatible(
        "The corrected result operation evidence is not unique."
      );
    }
    const operation = freezeRow(operations[0]);
    if (
      operation.actor_user_id !==
        version.actor_user_id ||
      operation.reason !== version.reason ||
      operation.started_at_ms !==
        version.corrected_at_ms ||
      operation.completed_at_ms !==
        version.corrected_at_ms ||
      !parseExactOperationMetadata(
        operation.metadata_json,
        version.result_id,
        version.result_version_id
      )
    ) {
      incompatible(
        "The corrected result operation evidence is inconsistent."
      );
    }

    const idempotency = uniqueRow(
      idempotencyByResultStatement,
      scope,
      "The correction idempotency result"
    );
    if (
      !idempotency ||
      idempotency.actor_user_id !==
        version.actor_user_id ||
      idempotency.operation !==
        MATCHUP_RESULT_CORRECTION_OPERATION ||
      idempotency.status !== "completed" ||
      idempotency.result_type !==
        MATCHUP_RESULT_CORRECTION_RESULT_TYPE ||
      idempotency.result_id !==
        version.result_version_id ||
      idempotency.completed_at_ms !==
        version.corrected_at_ms
    ) {
      incompatible(
        "The correction idempotency evidence is inconsistent."
      );
    }

    const finalizations = finalizationsStatement.all({
      leagueId: scope.leagueId,
      seasonId: version.season_id,
    });
    const ownedReplacements = finalizations.filter(
      (finalization) =>
        finalization.cause === "result_correction" &&
        finalization.idempotency_request_id ===
          idempotency.id
    );
    if (ownedReplacements.length > 1) {
      incompatible(
        "The correction replacement evidence is ambiguous."
      );
    }
    if (
      ownedReplacements.length === 0 &&
      finalizations.length > 0 &&
      !initialFinalizationPreservesCorrection({
        finalizations,
        scope,
        version,
      })
    ) {
      incompatible(
        "Canonical finalization history predates a correction without an owned replacement."
      );
    }

    let replacement = {
      standingsRowsChanged: false,
      snapshotId: null,
      snapshotVersion: null,
      resultSetHash: null,
      finalizationId: null,
      standingsOperationId: null,
    };
    if (ownedReplacements.length === 1) {
      const finalization =
        ownedReplacements[0];
      const snapshot = uniqueRow(
        snapshotStatement,
        {
          leagueId: scope.leagueId,
          seasonId: version.season_id,
          snapshotId:
            finalization.standings_snapshot_id,
        },
        "The correction replacement snapshot"
      );
      const prior = finalizations.find(
        (candidate) =>
          candidate.finalization_id ===
          finalization.replaces_finalization_id
      );
      if (!snapshot || !prior) {
        incompatible(
          "The correction replacement chain is incomplete."
        );
      }
      const links = freezeRows(
        linksStatement.all({
          leagueId: scope.leagueId,
          seasonId: version.season_id,
          snapshotId: snapshot.snapshot_id,
        })
      );
      const correctedLinks = links.filter(
        (link) =>
          link.matchup_result_version_id ===
          version.result_version_id
      );
      const standingsOperation = uniqueRow(
        standingsOperationByIdStatement,
        {
          leagueId: scope.leagueId,
          seasonId: version.season_id,
          operationId:
            finalization.standings_operation_id,
        },
        "The correction standings operation"
      );
      if (
        !["final", "superseded"].includes(
          finalization.status
        ) ||
        finalization.finalization_version !==
          snapshot.snapshot_version ||
        finalization.result_set_hash === null ||
        finalization.idempotency_request_id !==
          idempotency.id ||
        correctedLinks.length !== 1 ||
        correctedLinks[0].result_version_number !==
          version.result_version_number ||
        !standingsOperation ||
        standingsOperation.operation_type !==
          "correction_propagation" ||
        standingsOperation.status !== "succeeded" ||
        standingsOperation.standings_snapshot_id !==
          snapshot.snapshot_id ||
        standingsOperation.idempotency_request_id !==
          idempotency.id
      ) {
        incompatible(
          "The correction replacement evidence is inconsistent."
        );
      }
      const priorRows = freezeRows(
        rowsStatement.all({
          leagueId: scope.leagueId,
          seasonId: version.season_id,
          snapshotId: prior.standings_snapshot_id,
        })
      );
      const replacementRows = freezeRows(
        rowsStatement.all({
          leagueId: scope.leagueId,
          seasonId: version.season_id,
          snapshotId: snapshot.snapshot_id,
        })
      );
      replacement = {
        standingsRowsChanged: rowsDiffer(
          priorRows,
          replacementRows.map((row) => ({
            id: row.id,
            teamId: row.team_id,
            rank: row.rank,
            wins: row.wins,
            losses: row.losses,
            ties: row.ties,
            standingsPoints:
              row.standings_points,
            fantasyPointsForHundredths:
              row.fantasy_points_for_hundredths,
            fantasyPointsAgainstHundredths:
              row.fantasy_points_against_hundredths,
            fantasyPointsDifferentialHundredths:
              row
                .fantasy_point_differential_hundredths,
          }))
        ),
        snapshotId: snapshot.snapshot_id,
        snapshotVersion:
          snapshot.snapshot_version,
        resultSetHash:
          finalization.result_set_hash,
        finalizationId:
          finalization.finalization_id,
        standingsOperationId:
          finalization.standings_operation_id,
      };
    }

    return Object.freeze({
      result_id: version.result_id,
      result_version_id:
        version.result_version_id,
      result_version_number:
        version.result_version_number,
      result_version:
        version.result_version_number,
      league_id: version.league_id,
      season_id: version.season_id,
      matchup_week_id:
        operation.matchup_week_id,
      matchup_id: operation.matchup_id,
      corrected_at_ms: version.corrected_at_ms,
      standings_rows_changed:
        replacement.standingsRowsChanged,
      replacement_snapshot_id:
        replacement.snapshotId,
      replacement_snapshot_version:
        replacement.snapshotVersion,
      replacement_result_set_hash:
        replacement.resultSetHash,
      evidence: Object.freeze({
        correctionOperationId: operation.id,
        correctionOperationMetadataJson:
          operation.metadata_json,
        idempotencyRequestId: idempotency.id,
        idempotencyActorUserId:
          idempotency.actor_user_id,
        idempotencyOperation:
          idempotency.operation,
        idempotencyClientKey:
          idempotency.client_key,
        idempotencyRequestHash:
          idempotency.request_hash,
        idempotencyCompletedAtMs:
          idempotency.completed_at_ms,
        replacementFinalizationId:
          replacement.finalizationId,
        replacementStandingsOperationId:
          replacement.standingsOperationId,
      }),
    });
  }

  const correctionTransaction = database.transaction(
    (command) => {
      const existing = uniqueRow(
        idempotencyByScopeStatement,
        {
          leagueId: command.leagueId,
          actorUserId: command.actorUserId,
          clientKey: command.idempotency.clientKey,
        },
        "The correction idempotency scope"
      );
      if (existing) {
        if (
          existing.request_hash !==
            command.idempotency.requestHash
        ) {
          conflict(
            "The idempotency key was reused for a different correction."
          );
        }
        if (
          existing.status !== "completed" ||
          existing.result_type !==
            MATCHUP_RESULT_CORRECTION_RESULT_TYPE ||
          !UUID_PATTERN.test(existing.result_id || "")
        ) {
          conflict(
            "The correction idempotency request is unavailable."
          );
        }
        const durable = readCorrectionResultInternal({
          leagueId: command.leagueId,
          resultVersionId: existing.result_id,
        });
        if (!durable) {
          incompatible(
            "The completed correction result is unavailable."
          );
        }
        inspectCurrentAuthority(command);
        return durable;
      }

      const context = readContextInternal(command);
      const inspected = inspectFreshContext(
        context,
        command
      );
      runExactly(
        insertIdempotencyStatement,
        {
          id: command.idempotency.id,
          leagueId: command.leagueId,
          actorUserId: command.actorUserId,
          clientKey:
            command.idempotency.clientKey,
          requestHash:
            command.idempotency.requestHash,
          nowMs: command.nowMs,
          expiresAtMs:
            command.idempotency.expiresAtMs,
        },
        "The correction idempotency request could not start."
      );

      runExactly(
        insertResultVersionStatement,
        {
          ...command.correction,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          resultId: command.resultId,
          actorUserId: command.actorUserId,
          nowMs: command.nowMs,
        },
        "The corrected result version could not be appended."
      );
      runExactly(
        insertMatchupOperationStatement,
        {
          ...command.correction,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          weekId:
            context.matchup.matchup_week_id,
          matchupId: context.matchup.matchup_id,
          actorUserId: command.actorUserId,
          metadataJson: operationMetadata(
            command.resultId,
            command.correction.resultVersionId
          ),
          nowMs: command.nowMs,
        },
        "The result-correction operation could not be recorded."
      );
      if (
        context.matchup.matchup_status ===
        "correction_required"
      ) {
        runExactly(
          restoreMatchupStatusStatement,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            matchupId: context.matchup.matchup_id,
            expectedVersion:
              context.matchup.matchup_version,
            nowMs: command.nowMs,
          },
          "The matchup correction-required state could not be restored."
        );
        runExactly(
          restoreWeekStatusStatement,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            weekId:
              context.matchup.matchup_week_id,
            expectedVersion:
              context.matchup.week_version,
            nowMs: command.nowMs,
          },
          "The matchup-week correction-required state could not be restored."
        );
      }

      const replacement = inspected.replacement;
      if (replacement !== null) {
        finalStandingsRepository.insertFinalSnapshot({
          id: replacement.snapshotId,
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          snapshotVersion:
            replacement.snapshotVersion,
          sourceResultVersion:
            replacement.sourceResultVersion,
          nowMs: command.nowMs,
        });
        finalStandingsRepository.insertStandingsRows({
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          snapshotId: replacement.snapshotId,
          rows: replacement.rows,
        });
        finalStandingsRepository
          .insertResultVersionLinks({
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            snapshotId: replacement.snapshotId,
            links: replacement.links,
            nowMs: command.nowMs,
          });
        finalStandingsRepository.insertTeamIdentities({
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          snapshotId: replacement.snapshotId,
          identities: replacement.identities,
          nowMs: command.nowMs,
        });
        runExactly(
          insertStandingsOperationStatement,
          {
            standingsOperationId:
              replacement.standingsOperationId,
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            snapshotId: replacement.snapshotId,
            actorUserId: command.actorUserId,
            actorMembershipId:
              command.actorMembershipId,
            actorAuthority:
              command.actorAuthority,
            reason: command.correction.reason,
            metadataJson: JSON.stringify({
              resultId: command.resultId,
              resultSetHash:
                replacement.resultSetHash,
              resultVersionId:
                command.correction.resultVersionId,
              snapshotVersion:
                replacement.snapshotVersion,
              standingsRowsChanged:
                replacement.standingsRowsChanged,
            }),
            idempotencyRequestId:
              command.idempotency.id,
            nowMs: command.nowMs,
          },
          "The correction-propagation operation could not be recorded."
        );
        runExactly(
          supersedeFinalizationStatement,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            priorFinalizationId:
              replacement.priorFinalizationId,
            priorFinalizationVersion:
              replacement.priorFinalizationVersion,
            snapshotId: replacement.snapshotId,
            actorUserId: command.actorUserId,
            actorMembershipId:
              command.actorMembershipId,
            actorAuthority:
              command.actorAuthority,
            standingsOperationId:
              replacement.standingsOperationId,
            nowMs: command.nowMs,
          },
          "The prior canonical finalization could not be superseded."
        );
      }

      runExactly(
        updateResultStatement,
        {
          leagueId: command.leagueId,
          seasonId: command.seasonId,
          resultId: command.resultId,
          resultVersionId:
            command.correction.resultVersionId,
          supersedesVersionId:
            command.correction.supersedesVersionId,
          expectedResultVersion:
            command.expectedResultVersion,
          nowMs: command.nowMs,
        },
        "The matchup-result correction lost its compare-and-set race."
      );

      if (replacement !== null) {
        runExactly(
          insertFinalizationStatement,
          {
            finalizationId:
              replacement.finalizationId,
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            snapshotId: replacement.snapshotId,
            snapshotVersion:
              replacement.snapshotVersion,
            standingsRuleVersion:
              replacement.standingsRuleVersion,
            resultSetHash:
              replacement.resultSetHash,
            expectedMatchupCount:
              replacement.expectedMatchupCount,
            expectedWeekCount:
              replacement.expectedWeekCount,
            participantCount:
              replacement.participantCount,
            expectedSeasonVersion:
              command.expectedSeasonVersion,
            seasonVersionAfter:
              replacement.seasonVersionAfter,
            actorUserId: command.actorUserId,
            actorMembershipId:
              command.actorMembershipId,
            actorAuthority:
              command.actorAuthority,
            standingsOperationId:
              replacement.standingsOperationId,
            idempotencyRequestId:
              command.idempotency.id,
            priorFinalizationId:
              replacement.priorFinalizationId,
            nowMs: command.nowMs,
          },
          "The replacement canonical finalization could not be inserted."
        );
      }

      securityAudit.append(command.audit);
      if (replacement !== null) {
        for (const notification of
          replacement.notifications) {
          writeCorrectionNotification({
            command,
            replacement,
            notification,
          });
        }
      }
      writeCorrectionOutbox({
        command,
        resultVersion:
          command.correction.versionNumber,
        replacement,
      });
      if (replacement !== null) {
        runExactly(
          updateSeasonStatement,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
            expectedSeasonVersion:
              command.expectedSeasonVersion,
            nowMs: command.nowMs,
          },
          "The corrected standings season version could not advance."
        );
        const season = uniqueRow(
          seasonStatement,
          {
            leagueId: command.leagueId,
            seasonId: command.seasonId,
          },
          "The corrected standings season"
        );
        if (
          !season ||
          season.version !==
            replacement.seasonVersionAfter
        ) {
          conflict(
            "The corrected standings season version is inconsistent."
          );
        }
      }

      runExactly(
        completeIdempotencyStatement,
        {
          leagueId: command.leagueId,
          idempotencyRequestId:
            command.idempotency.id,
          actorUserId: command.actorUserId,
          resultVersionId:
            command.correction.resultVersionId,
          nowMs: command.nowMs,
        },
        "The correction idempotency request could not complete."
      );
      if (beforeCommit) beforeCommit();
      const durable = readCorrectionResultInternal({
        leagueId: command.leagueId,
        resultVersionId:
          command.correction.resultVersionId,
      });
      if (!durable) {
        incompatible(
          "The committed correction result could not be reconstructed."
        );
      }
      return durable;
    }
  );

  return Object.freeze({
    readCorrectionContext(options) {
      exactObject(
        options,
        ["leagueId", "seasonId", "resultId"],
        "An exact correction context lookup is required."
      );
      try {
        return publicContext(
          readContextInternal(options)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "readMatchupResultCorrectionContext",
          tableName: "matchup_results",
        });
      }
    },

    findIdempotency(options) {
      exactObject(
        options,
        [
          "leagueId",
          "actorUserId",
          "operation",
          "clientKey",
        ],
        "An exact correction idempotency lookup is required."
      );
      const operation = canonicalText(
        options.operation,
        128,
        "idempotency operation"
      );
      if (
        operation !==
        MATCHUP_RESULT_CORRECTION_OPERATION
      ) {
        invalid(
          "The matchup-result correction idempotency operation is required."
        );
      }
      try {
        return uniqueRow(
          idempotencyByScopeStatement,
          {
            leagueId: stableId(
              options.leagueId,
              "league identifier"
            ),
            actorUserId: stableId(
              options.actorUserId,
              "actor-user identifier"
            ),
            clientKey: canonicalText(
              options.clientKey,
              128,
              "idempotency key"
            ),
          },
          "The correction idempotency scope"
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findMatchupResultCorrectionIdempotency",
          tableName: "idempotency_requests",
        });
      }
    },

    findCorrectionResult(options) {
      exactObject(
        options,
        ["leagueId", "resultVersionId"],
        "An exact durable correction-result lookup is required."
      );
      try {
        return readCorrectionResultInternal(options);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "findDurableMatchupResultCorrection",
          tableName: "matchup_result_versions",
        });
      }
    },

    correct(rawCommand) {
      const command = normalizeCommand(rawCommand);
      try {
        return correctionTransaction.immediate(command);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "correctMatchupResultAtomically",
          tableName: "matchup_result_versions",
        });
      }
    },
  });
}

module.exports = {
  MATCHUP_RESULT_CORRECTION_AUDIT_EVENT,
  MATCHUP_RESULT_CORRECTION_FALLBACK_REASON,
  MATCHUP_RESULT_CORRECTION_OPERATION,
  MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
  createSqliteMatchupResultCorrectionRepository,
};
