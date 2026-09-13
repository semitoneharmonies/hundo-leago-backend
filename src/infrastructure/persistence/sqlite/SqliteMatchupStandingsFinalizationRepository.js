const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");
const {
  resolveSqliteNotificationWriter,
} = require("./SqliteNotificationWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;
const STANDINGS_FINALIZATION_OPERATION =
  "standings.finalize_regular_season.v1";
const STANDINGS_FINALIZATION_RESULT_TYPE =
  "standings_finalization";
const MATCHUP_RESULT_CORRECTION_OPERATION =
  "matchup.result.correct.v1";
const MATCHUP_RESULT_CORRECTION_RESULT_TYPE =
  "matchup_result_correction";
const IDEMPOTENCY_COLUMNS = Object.freeze([
  "id",
  "league_id",
  "actor_user_id",
  "operation",
  "client_key",
  "request_hash",
  "status",
  "result_type",
  "result_id",
  "created_at_ms",
  "completed_at_ms",
  "expires_at_ms",
]);
const ACTOR_AUTHORITIES = new Set([
  "commissioner",
  "platform_administrator_as_commissioner",
]);
const PATTERN_TEMPLATES = new Set([
  "even-two",
  "even-three",
  "wide-centre-stripe",
  "thin-centre-stripe",
  "triple-pinstripe",
  "double-accent-bands",
  "angular-peak",
  "mirrored-centre-band",
  "offset-outlined-stack",
  "layered-six-band",
  "alternating-ladder",
  "double-hairline",
  "double-light-top-accent",
  "layered-monochrome",
  "split-colour-block",
  "two-tone-stack",
  "outlined-block",
  "layered-contrast",
  "mirrored-seven-band",
  "accent-line-band",
  "outlined-centre",
  "two-stage-contrast",
  "layered-double-light",
  "tiger",
  "leopard",
  "cowhide",
  "camouflage",
  "snake-scales",
  "honeycomb",
  "checkerboard",
  "argyle",
  "chevrons",
  "ocean-waves",
  "two-colour-gradient",
  "three-colour-gradient",
]);
const TWO_COLOUR_PATTERNS = new Set([
  "even-two",
  "wide-centre-stripe",
  "thin-centre-stripe",
  "triple-pinstripe",
  "double-accent-bands",
  "angular-peak",
  "tiger",
  "cowhide",
  "honeycomb",
  "checkerboard",
  "two-colour-gradient",
]);
const MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
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

function boundedText(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    invalid(`Bounded canonical ${description} is required.`);
  }
  return value;
}

function safeTimestamp(value, description = "UTC timestamp") {
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

function digest(value, description) {
  if (
    typeof value !== "string" ||
    !DIGEST_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} digest is required.`);
  }
  return value;
}

function colour(value, description) {
  if (
    typeof value !== "string" ||
    !COLOUR_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} colour is required.`);
  }
  return value;
}

function actorAuthority(value) {
  if (!ACTOR_AUTHORITIES.has(value)) {
    invalid(
      "A supported standings-finalization authority is required."
    );
  }
  return value;
}

function canonicalJson(value, maximum, description) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > maximum
  ) {
    invalid(`Bounded ${description} JSON is required.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(`Valid ${description} JSON is required.`);
  }
  if (!isPlainObject(parsed)) {
    invalid(`${description} JSON must contain an object.`);
  }
  return value;
}

function freezeRow(row) {
  if (!row) return null;
  const copy = { ...row };
  if (Buffer.isBuffer(copy.logo_content_bytes)) {
    copy.logo_content_bytes = Buffer.from(
      copy.logo_content_bytes
    );
  }
  return Object.freeze(copy);
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function normalizeStandingsRow(value) {
  exactObject(
    value,
    [
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
    ],
    "An exact final standings row is required."
  );
  const wins = nonnegativeInteger(value.wins, "win count");
  const losses = nonnegativeInteger(
    value.losses,
    "loss count"
  );
  const ties = nonnegativeInteger(value.ties, "tie count");
  const standingsPoints = nonnegativeInteger(
    value.standingsPoints,
    "standings-points value"
  );
  const pointsFor = nonnegativeInteger(
    value.fantasyPointsForHundredths,
    "fantasy-points-for value"
  );
  const pointsAgainst = nonnegativeInteger(
    value.fantasyPointsAgainstHundredths,
    "fantasy-points-against value"
  );
  const differential = value.fantasyPointsDifferentialHundredths;
  if (
    !Number.isSafeInteger(differential) ||
    standingsPoints !== wins * 2 + ties ||
    differential !== pointsFor - pointsAgainst
  ) {
    invalid("A consistent final standings row is required.");
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

function normalizeResultVersionLink(value) {
  exactObject(
    value,
    [
      "id",
      "matchupWeekId",
      "matchupId",
      "matchupResultId",
      "resultVersionId",
      "resultVersionNumber",
    ],
    "An exact final standings result-version link is required."
  );
  return Object.freeze({
    id: stableId(
      value.id,
      "standings result-version-link identifier"
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
      "result version"
    ),
  });
}

function normalizeTeamIdentity(value) {
  exactObject(
    value,
    [
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
    ],
    "An exact final standings team identity is required."
  );
  const patternTemplate = value.patternTemplate;
  if (!PATTERN_TEMPLATES.has(patternTemplate)) {
    invalid(
      "A supported standings team pattern template is required."
    );
  }
  const tertiaryColour =
    value.tertiaryColour === null
      ? null
      : colour(value.tertiaryColour, "tertiary");
  if (
    TWO_COLOUR_PATTERNS.has(patternTemplate) !==
    (tertiaryColour === null)
  ) {
    invalid(
      "The standings team pattern and tertiary colour are inconsistent."
    );
  }

  const sourceLogoObjectId = optionalStableId(
    value.sourceLogoObjectId,
    "team-logo object identifier"
  );
  const nullableLogoValues = [
    value.logoMediaType,
    value.logoByteLength,
    value.logoWidth,
    value.logoHeight,
    value.logoContentSha256,
    value.logoContentBytes,
  ];
  const hasNoLogo =
    sourceLogoObjectId === null &&
    nullableLogoValues.every((item) => item === null);
  let logo;
  if (hasNoLogo) {
    logo = {
      sourceLogoObjectId: null,
      logoMediaType: null,
      logoByteLength: null,
      logoWidth: null,
      logoHeight: null,
      logoContentSha256: null,
      logoContentBytes: null,
    };
  } else {
    if (
      sourceLogoObjectId === null ||
      !MEDIA_TYPES.has(value.logoMediaType) ||
      !Number.isSafeInteger(value.logoByteLength) ||
      value.logoByteLength < 1 ||
      value.logoByteLength > 524_288 ||
      !Number.isSafeInteger(value.logoWidth) ||
      value.logoWidth < 1 ||
      value.logoWidth > 2048 ||
      !Number.isSafeInteger(value.logoHeight) ||
      value.logoHeight < 1 ||
      value.logoHeight > 2048 ||
      !Buffer.isBuffer(value.logoContentBytes) ||
      value.logoContentBytes.length !== value.logoByteLength
    ) {
      invalid("Complete inspected team-logo evidence is required.");
    }
    logo = {
      sourceLogoObjectId,
      logoMediaType: value.logoMediaType,
      logoByteLength: value.logoByteLength,
      logoWidth: value.logoWidth,
      logoHeight: value.logoHeight,
      logoContentSha256: digest(
        value.logoContentSha256,
        "team-logo content"
      ),
      logoContentBytes: Buffer.from(value.logoContentBytes),
    };
  }

  return Object.freeze({
    id: stableId(
      value.id,
      "standings team-identity identifier"
    ),
    teamId: stableId(value.teamId, "team identifier"),
    teamDisplayName: boundedText(
      value.teamDisplayName,
      120,
      "team display name"
    ),
    primaryColour: colour(
      value.primaryColour,
      "primary"
    ),
    secondaryColour: colour(
      value.secondaryColour,
      "secondary"
    ),
    tertiaryColour,
    patternTemplate,
    ...logo,
  });
}

function normalizeUniqueArray(
  value,
  normalize,
  identity,
  description
) {
  if (!Array.isArray(value) || value.length < 1) {
    invalid(`At least one ${description} is required.`);
  }
  const normalized = value.map(normalize);
  const identities = normalized.map(identity);
  if (new Set(identities).size !== identities.length) {
    invalid(`${description} values must be unique.`);
  }
  return normalized;
}

function createSqliteMatchupStandingsFinalizationRepository({
  database,
  leagueOutboxWriter,
  notificationWriter,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    invalid(
      "Standings finalization requires an opened SQLite database."
    );
  }

  let outboxWriter;
  let notifications;
  let aggregateStatement;
  let scheduleOperationsStatement;
  let scheduleGenerationsStatement;
  let scheduleCommandResultsStatement;
  let scheduleRecoveriesStatement;
  let correctionOperationsStatement;
  let weeksStatement;
  let resultsStatement;
  let byesStatement;
  let participantsStatement;
  let activeMembersStatement;
  let snapshotsStatement;
  let findIdempotencyByScopeStatement;
  let findIdempotencyByIdStatement;
  let findFinalizationResultStatement;
  let insertStartedIdempotencyStatement;
  let supersedeCurrentSnapshotStatement;
  let findSnapshotStatement;
  let insertSnapshotStatement;
  let insertStandingsRowStatement;
  let insertResultLinkStatement;
  let insertTeamIdentityStatement;
  let insertOperationStatement;
  let insertFinalizationStatement;
  let findFinalizationStatement;
  let advanceSeasonStatement;
  let findSeasonStatement;
  let completeIdempotencyStatement;

  try {
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    notifications = resolveSqliteNotificationWriter({
      database,
      notificationWriter,
    });
    aggregateStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.status AS league_status,
        leagues.timezone AS league_timezone,
        leagues.current_season_id AS current_season_id,
        seasons.id AS season_id,
        seasons.status AS season_status,
        seasons.version AS season_version,
        seasons.regular_season_starts_at_ms
          AS regular_season_starts_at_ms,
        seasons.fantasy_playoffs_start_at_ms
          AS fantasy_playoffs_start_at_ms,
        league_settings.scoring_rule_version
          AS scoring_rule_version,
        league_settings.standings_rule_version
          AS standings_rule_version
      FROM leagues
      JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = @seasonId
      LEFT JOIN league_settings
        ON league_settings.league_id = leagues.id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    scheduleOperationsStatement = database.prepare(`
      SELECT
        league_id AS operation_league_id,
        season_id AS operation_season_id,
        id AS schedule_operation_id,
        matchup_week_id AS operation_matchup_week_id,
        matchup_id AS operation_matchup_id,
        actor_user_id AS actor_user_id,
        status AS operation_status,
        reason AS reason,
        metadata_json AS metadata_json,
        started_at_ms AS started_at_ms,
        completed_at_ms AS completed_at_ms
      FROM matchup_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND operation_type = 'schedule_generate'
      ORDER BY started_at_ms ASC, id ASC
    `);
    scheduleGenerationsStatement = database.prepare(`
      SELECT
        league_id AS generation_league_id,
        season_id AS generation_season_id,
        schedule_version AS schedule_version,
        schedule_operation_id AS schedule_operation_id,
        week_one_matchup_week_id AS week_one_matchup_week_id,
        week_one_starts_at_ms AS week_one_starts_at_ms,
        status AS generation_status,
        created_at_ms AS generation_created_at_ms,
        superseded_at_ms AS generation_superseded_at_ms,
        version AS generation_version
      FROM season_matchup_schedule_generations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY schedule_version ASC, schedule_operation_id ASC
    `);
    scheduleCommandResultsStatement = database.prepare(`
      SELECT
        id AS command_result_id,
        league_id AS command_league_id,
        season_id AS command_season_id,
        action AS command_action,
        matchup_operation_id AS command_matchup_operation_id,
        actor_user_id AS command_actor_user_id,
        old_schedule_operation_id AS command_old_schedule_operation_id,
        old_schedule_version AS command_old_schedule_version,
        new_schedule_operation_id AS command_new_schedule_operation_id,
        new_schedule_version AS command_new_schedule_version,
        week_one_matchup_week_id AS command_week_one_matchup_week_id,
        previous_first_week_starts_at_ms
          AS command_previous_first_week_starts_at_ms,
        first_week_starts_at_ms AS command_first_week_starts_at_ms,
        shifted_week_count AS command_shifted_week_count,
        replaced_job_occurrence_count
          AS command_replaced_job_occurrence_count,
        created_at_ms AS command_created_at_ms,
        version AS command_version
      FROM matchup_schedule_command_results
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY new_schedule_version ASC, id ASC
    `);
    scheduleRecoveriesStatement = database.prepare(`
      SELECT
        id AS recovery_id,
        league_id AS recovery_league_id,
        season_id AS recovery_season_id,
        fad_id AS recovery_fad_id,
        recovery_kind AS recovery_kind,
        matchup_operation_id AS recovery_matchup_operation_id,
        old_schedule_operation_id AS recovery_old_schedule_operation_id,
        new_schedule_operation_id AS recovery_new_schedule_operation_id,
        old_first_matchup_week_id AS recovery_old_first_matchup_week_id,
        new_first_matchup_week_id AS recovery_new_first_matchup_week_id,
        old_schedule_version AS recovery_old_schedule_version,
        new_schedule_version AS recovery_new_schedule_version,
        old_week_one_starts_at_ms AS recovery_old_week_one_starts_at_ms,
        new_week_one_starts_at_ms AS recovery_new_week_one_starts_at_ms,
        completed_at_ms AS recovery_completed_at_ms,
        evidence_schema_version AS recovery_evidence_schema_version,
        evidence_sha256 AS recovery_evidence_sha256,
        created_at_ms AS recovery_created_at_ms,
        version AS recovery_version
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY new_schedule_version ASC, id ASC
    `);
    correctionOperationsStatement = database.prepare(`
      WITH correction_operations AS (
        SELECT
          matchup_operations.*,
          CASE
            WHEN json_valid(matchup_operations.metadata_json) = 1
              THEN matchup_operations.metadata_json
            ELSE '{}'
          END AS evidence_json
        FROM matchup_operations
        WHERE league_id = @leagueId
          AND season_id = @seasonId
          AND operation_type = 'result_correct'
      )
      SELECT
        correction_operations.id AS correction_operation_id,
        correction_operations.matchup_week_id AS matchup_week_id,
        correction_operations.matchup_id AS matchup_id,
        correction_operations.actor_user_id AS actor_user_id,
        correction_operations.status AS operation_status,
        correction_operations.reason AS reason,
        correction_operations.metadata_json AS metadata_json,
        correction_operations.started_at_ms AS started_at_ms,
        correction_operations.completed_at_ms AS completed_at_ms,
        json_extract(
          correction_operations.evidence_json,
          '$.resultId'
        ) AS metadata_result_id,
        json_extract(
          correction_operations.evidence_json,
          '$.resultVersionId'
        ) AS metadata_result_version_id,
        matched_version.id AS matched_result_version_id,
        matched_version.matchup_result_id
          AS matched_matchup_result_id,
        matched_version.version_number AS matched_version_number,
        matched_version.source_type AS matched_source_type,
        matched_version.actor_user_id AS matched_actor_user_id,
        matched_version.reason AS matched_reason,
        matched_version.created_at_ms AS matched_created_at_ms,
        matched_version.supersedes_version_id
          AS matched_supersedes_version_id,
        current_result.id AS current_matchup_result_id,
        current_result.current_version_id
          AS current_result_version_id,
        current_result.status AS current_result_status,
        current_result.matchup_id AS result_matchup_id
      FROM correction_operations
      LEFT JOIN matchup_result_versions AS matched_version
        ON matched_version.league_id =
          correction_operations.league_id
       AND matched_version.season_id =
          correction_operations.season_id
       AND matched_version.id = json_extract(
         correction_operations.evidence_json,
         '$.resultVersionId'
       )
      LEFT JOIN matchup_results AS current_result
        ON current_result.league_id =
          matched_version.league_id
       AND current_result.season_id =
          matched_version.season_id
       AND current_result.id =
          matched_version.matchup_result_id
      ORDER BY
        correction_operations.matchup_id ASC,
        correction_operations.completed_at_ms ASC,
        correction_operations.id ASC
    `);
    weeksStatement = database.prepare(`
      SELECT
        id,
        sequence,
        starts_at_ms,
        ends_at_ms,
        rolls_over_at_ms,
        status
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY sequence ASC, id ASC
    `);
    resultsStatement = database.prepare(`
      SELECT
        matchups.id AS matchup_id,
        matchups.matchup_week_id AS matchup_week_id,
        matchups.status AS matchup_status,
        matchups.home_team_id AS home_team_id,
        matchups.away_team_id AS away_team_id,
        matchup_results.id AS matchup_result_id,
        matchup_results.status AS result_status,
        matchup_results.current_version_id AS current_version_id,
        matchup_results.finalized_at_ms
          AS result_finalized_at_ms,
        matchup_result_versions.id AS result_version_id,
        matchup_result_versions.version_number
          AS version_number,
        matchup_result_versions.home_team_id
          AS version_home_team_id,
        matchup_result_versions.away_team_id
          AS version_away_team_id,
        matchup_result_versions.home_score_hundredths
          AS home_score_hundredths,
        matchup_result_versions.away_score_hundredths
          AS away_score_hundredths,
        matchup_result_versions.outcome AS outcome,
        matchup_result_versions.source_snapshot_id
          AS source_snapshot_id,
        matchup_result_versions.source_type AS source_type,
        matchup_result_versions.actor_user_id AS actor_user_id,
        matchup_result_versions.reason AS reason,
        matchup_result_versions.supersedes_version_id
          AS supersedes_version_id,
        superseded_version.id
          AS superseded_version_record_id,
        superseded_version.matchup_result_id
          AS superseded_version_matchup_result_id,
        superseded_version.version_number
          AS superseded_version_number,
        matchup_result_versions.created_at_ms
          AS result_version_created_at_ms,
        (
          SELECT COUNT(*)
          FROM matchup_results AS result_count
          WHERE result_count.league_id = matchups.league_id
            AND result_count.season_id = matchups.season_id
            AND result_count.matchup_id = matchups.id
        ) AS result_row_count,
        (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id = matchups.league_id
            AND history.season_id = matchups.season_id
            AND history.matchup_result_id = matchup_results.id
        ) AS result_version_count,
        (
          SELECT MAX(history.version_number)
          FROM matchup_result_versions AS history
          WHERE history.league_id = matchups.league_id
            AND history.season_id = matchups.season_id
            AND history.matchup_result_id = matchup_results.id
        ) AS latest_version_number,
        (
          SELECT previous.id
          FROM matchup_result_versions AS previous
          WHERE previous.league_id = matchups.league_id
            AND previous.season_id = matchups.season_id
            AND previous.matchup_result_id =
              matchup_results.id
            AND previous.version_number =
              matchup_result_versions.version_number - 1
          LIMIT 2
        ) AS previous_result_version_id,
        CASE
          WHEN matchup_result_versions.id IS NULL THEN 0
          WHEN matchup_result_versions.version_number = 1
            THEN
              matchup_result_versions.supersedes_version_id
                IS NULL
          ELSE EXISTS (
            SELECT 1
            FROM matchup_result_versions AS previous
            WHERE previous.league_id = matchups.league_id
              AND previous.season_id = matchups.season_id
              AND previous.matchup_result_id =
                matchup_results.id
              AND previous.version_number =
                matchup_result_versions.version_number - 1
              AND previous.id =
                matchup_result_versions.supersedes_version_id
          )
        END AS supersedes_previous_version,
        (
          SELECT COUNT(*)
          FROM matchup_result_versions AS history
          WHERE history.league_id = matchups.league_id
            AND history.season_id = matchups.season_id
            AND history.matchup_result_id = matchup_results.id
            AND NOT (
              (
                history.version_number = 1
                AND history.source_type = 'calculated'
                AND history.actor_user_id IS NULL
                AND history.reason IS NULL
                AND history.supersedes_version_id IS NULL
              )
              OR
              (
                history.version_number > 1
                AND history.source_type = 'correction'
                AND history.actor_user_id IS NOT NULL
                AND history.reason IS NOT NULL
                AND history.reason = trim(history.reason)
                AND length(history.reason) BETWEEN 1 AND 500
                AND EXISTS (
                  SELECT 1
                  FROM matchup_result_versions AS previous
                  WHERE previous.league_id = history.league_id
                    AND previous.season_id = history.season_id
                    AND previous.matchup_result_id =
                      history.matchup_result_id
                    AND previous.version_number =
                      history.version_number - 1
                    AND previous.id =
                      history.supersedes_version_id
                )
              )
            )
        ) AS invalid_version_chain_count,
        stat_snapshots.id AS source_snapshot_record_id,
        stat_snapshots.league_id AS source_snapshot_league_id,
        stat_snapshots.season_id AS source_snapshot_season_id,
        stat_snapshots.matchup_week_id
          AS source_snapshot_week_id,
        stat_snapshots.intended_use
          AS source_snapshot_intended_use,
        stat_snapshots.completeness_status
          AS source_snapshot_completeness,
        stat_snapshots.freshness_status
          AS source_snapshot_freshness,
        stat_snapshots.committed AS source_snapshot_committed
      FROM matchups
      LEFT JOIN matchup_results
        ON matchup_results.league_id = matchups.league_id
       AND matchup_results.season_id = matchups.season_id
       AND matchup_results.matchup_id = matchups.id
      LEFT JOIN matchup_result_versions
        ON matchup_result_versions.league_id =
          matchup_results.league_id
       AND matchup_result_versions.season_id =
          matchup_results.season_id
       AND matchup_result_versions.matchup_result_id =
          matchup_results.id
       AND matchup_result_versions.id =
          matchup_results.current_version_id
      LEFT JOIN stat_snapshots
        ON stat_snapshots.league_id =
          matchup_result_versions.league_id
       AND stat_snapshots.id =
          matchup_result_versions.source_snapshot_id
      LEFT JOIN matchup_result_versions AS superseded_version
        ON superseded_version.league_id =
          matchup_result_versions.league_id
       AND superseded_version.id =
          matchup_result_versions.supersedes_version_id
      WHERE matchups.league_id = @leagueId
        AND matchups.season_id = @seasonId
      ORDER BY matchups.id ASC
    `);
    byesStatement = database.prepare(`
      SELECT
        matchup_byes.id AS bye_id,
        matchup_byes.matchup_week_id AS matchup_week_id,
        matchup_byes.team_id AS team_id,
        matchup_weeks.id AS joined_week_id,
        matchup_weeks.season_id AS joined_week_season_id,
        matchup_weeks.sequence AS joined_week_sequence,
        matchup_weeks.status AS joined_week_status
      FROM matchup_byes
      LEFT JOIN matchup_weeks
        ON matchup_weeks.league_id =
          matchup_byes.league_id
       AND matchup_weeks.id =
          matchup_byes.matchup_week_id
      WHERE matchup_byes.league_id = @leagueId
        AND matchup_byes.season_id = @seasonId
      ORDER BY
        matchup_byes.matchup_week_id ASC,
        matchup_byes.team_id ASC,
        matchup_byes.id ASC
    `);
    participantsStatement = database.prepare(`
      WITH participants AS (
        SELECT home_team_id AS team_id
        FROM matchups
        WHERE league_id = @leagueId
          AND season_id = @seasonId
        UNION
        SELECT away_team_id AS team_id
        FROM matchups
        WHERE league_id = @leagueId
          AND season_id = @seasonId
        UNION
        SELECT team_id
        FROM matchup_byes
        WHERE league_id = @leagueId
          AND season_id = @seasonId
      )
      SELECT
        participants.team_id AS team_id,
        teams.name AS team_display_name,
        teams.status AS team_status,
        teams.primary_colour AS primary_colour,
        teams.secondary_colour AS secondary_colour,
        teams.tertiary_colour AS tertiary_colour,
        teams.pattern_template AS pattern_template,
        teams.logo_reference AS logo_reference,
        team_logo_objects.id AS source_logo_object_id,
        team_logo_objects.media_type AS logo_media_type,
        team_logo_objects.byte_length AS logo_byte_length,
        team_logo_objects.width AS logo_width,
        team_logo_objects.height AS logo_height,
        team_logo_objects.content_sha256
          AS logo_content_sha256,
        team_logo_objects.content_bytes AS logo_content_bytes
      FROM participants
      LEFT JOIN teams
        ON teams.league_id = @leagueId
       AND teams.id = participants.team_id
      LEFT JOIN team_logo_objects
        ON team_logo_objects.league_id = teams.league_id
       AND team_logo_objects.team_id = teams.id
       AND team_logo_objects.id = teams.logo_reference
      ORDER BY participants.team_id ASC
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
    snapshotsStatement = database.prepare(`
      SELECT
        standings_snapshots.id AS snapshot_id,
        standings_snapshots.snapshot_version
          AS snapshot_version,
        standings_snapshots.source_result_version
          AS source_result_version,
        standings_snapshots.status AS snapshot_status,
        standings_snapshots.calculated_at_ms
          AS calculated_at_ms,
        standings_snapshots.created_at_ms
          AS snapshot_created_at_ms,
        standings_snapshot_finalizations.id
          AS finalization_id,
        standings_snapshot_finalizations.status
          AS finalization_status,
        standings_snapshot_finalizations.evidence_schema_version
          AS evidence_schema_version,
        standings_snapshot_finalizations.cause
          AS finalization_cause,
        standings_snapshot_finalizations.standings_rule_version
          AS standings_rule_version,
        standings_snapshot_finalizations.result_set_hash
          AS result_set_hash,
        standings_snapshot_finalizations.result_set_hash_version
          AS result_set_hash_version,
        standings_snapshot_finalizations.expected_matchup_count
          AS expected_matchup_count,
        standings_snapshot_finalizations.finalized_matchup_count
          AS finalized_matchup_count,
        standings_snapshot_finalizations.expected_week_count
          AS expected_week_count,
        standings_snapshot_finalizations.weeks_counted
          AS weeks_counted,
        standings_snapshot_finalizations.participant_count
          AS participant_count,
        standings_snapshot_finalizations.standings_row_count
          AS standings_row_count,
        standings_snapshot_finalizations.completeness_status
          AS completeness_status,
        standings_snapshot_finalizations.season_version_before
          AS season_version_before,
        standings_snapshot_finalizations.season_version_after
          AS season_version_after,
        standings_snapshot_finalizations.standings_operation_id
          AS standings_operation_id,
        standings_snapshot_finalizations.idempotency_request_id
          AS idempotency_request_id,
        standings_operations.status AS operation_status,
        standings_operations.operation_type AS operation_type,
        idempotency_requests.status AS idempotency_status,
        idempotency_requests.result_type
          AS idempotency_result_type,
        idempotency_requests.result_id AS idempotency_result_id,
        (
          SELECT COUNT(*)
          FROM standings_snapshot_result_versions AS idempotency_result_link
          WHERE idempotency_result_link.league_id =
              standings_snapshot_finalizations.league_id
            AND idempotency_result_link.season_id =
              standings_snapshot_finalizations.season_id
            AND idempotency_result_link.standings_snapshot_id =
              standings_snapshot_finalizations.standings_snapshot_id
            AND idempotency_result_link.matchup_result_version_id =
              idempotency_requests.result_id
        ) AS idempotency_result_link_count
      FROM standings_snapshots
      LEFT JOIN standings_snapshot_finalizations
        ON standings_snapshot_finalizations.league_id =
          standings_snapshots.league_id
       AND standings_snapshot_finalizations.season_id =
          standings_snapshots.season_id
       AND standings_snapshot_finalizations.standings_snapshot_id =
          standings_snapshots.id
      LEFT JOIN standings_operations
        ON standings_operations.league_id =
          standings_snapshot_finalizations.league_id
       AND standings_operations.id =
          standings_snapshot_finalizations.standings_operation_id
      LEFT JOIN idempotency_requests
        ON idempotency_requests.league_id =
          standings_snapshot_finalizations.league_id
       AND idempotency_requests.id =
          standings_snapshot_finalizations.idempotency_request_id
      WHERE standings_snapshots.league_id = @leagueId
        AND standings_snapshots.season_id = @seasonId
      ORDER BY
        standings_snapshots.snapshot_version ASC,
        standings_snapshots.id ASC
    `);
    findIdempotencyByScopeStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE league_id = @leagueId " +
        "AND actor_user_id = @actorUserId " +
        "AND operation = @operation " +
        "AND client_key = @clientKey " +
        "ORDER BY created_at_ms DESC, id DESC LIMIT 2"
    );
    findIdempotencyByIdStatement = database.prepare(
      `SELECT ${IDEMPOTENCY_COLUMNS.join(", ")} ` +
        "FROM idempotency_requests " +
        "WHERE league_id = @leagueId AND id = @id LIMIT 2"
    );
    findFinalizationResultStatement = database.prepare(`
      SELECT
        standings_operations.id AS operation_id,
        standings_snapshots.id AS snapshot_id,
        standings_snapshots.snapshot_version AS snapshot_version,
        standings_snapshot_finalizations.league_id AS league_id,
        standings_snapshot_finalizations.season_id AS season_id,
        standings_snapshot_finalizations.season_version_after
          AS season_version,
        standings_snapshot_finalizations.standings_rule_version
          AS standings_rule_version,
        standings_snapshot_finalizations.result_set_hash
          AS result_set_hash,
        standings_snapshot_finalizations.expected_matchup_count
          AS expected_matchup_count,
        standings_snapshot_finalizations.finalized_matchup_count
          AS included_result_count,
        standings_snapshot_finalizations.participant_count
          AS participant_count,
        standings_snapshot_finalizations.finalized_at_ms
          AS finalized_at_ms
      FROM standings_snapshot_finalizations
      JOIN standings_snapshots
        ON standings_snapshots.league_id =
          standings_snapshot_finalizations.league_id
       AND standings_snapshots.season_id =
          standings_snapshot_finalizations.season_id
       AND standings_snapshots.id =
          standings_snapshot_finalizations.standings_snapshot_id
      JOIN standings_operations
        ON standings_operations.league_id =
          standings_snapshot_finalizations.league_id
       AND standings_operations.season_id =
          standings_snapshot_finalizations.season_id
       AND standings_operations.id =
          standings_snapshot_finalizations.standings_operation_id
       AND standings_operations.standings_snapshot_id =
          standings_snapshot_finalizations.standings_snapshot_id
       AND standings_operations.operation_type =
          'finalize_regular_season'
       AND standings_operations.status = 'succeeded'
      JOIN idempotency_requests
        ON idempotency_requests.league_id =
          standings_snapshot_finalizations.league_id
       AND idempotency_requests.id =
          standings_snapshot_finalizations.idempotency_request_id
       AND idempotency_requests.operation =
          'standings.finalize_regular_season.v1'
       AND idempotency_requests.status = 'completed'
       AND idempotency_requests.result_type =
          'standings_finalization'
       AND idempotency_requests.result_id =
          standings_snapshot_finalizations.id
      WHERE standings_snapshot_finalizations.league_id = @leagueId
        AND standings_snapshot_finalizations.id = @finalizationId
        AND standings_snapshot_finalizations.evidence_schema_version = 1
        AND standings_snapshot_finalizations.cause =
          'regular_season_completion'
        AND standings_snapshot_finalizations.status IN (
          'final',
          'superseded'
        )
      LIMIT 2
    `);
    insertStartedIdempotencyStatement = database.prepare(`
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
        @operation,
        @clientKey,
        @requestHash,
        'started',
        NULL,
        NULL,
        @createdAtMs,
        NULL,
        @expiresAtMs
      )
    `);
    supersedeCurrentSnapshotStatement = database.prepare(`
      UPDATE standings_snapshots
      SET status = 'superseded'
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @snapshotId
        AND status = 'current'
        AND NOT EXISTS (
          SELECT 1
          FROM standings_snapshot_finalizations
          WHERE standings_snapshot_finalizations.league_id =
            standings_snapshots.league_id
            AND standings_snapshot_finalizations.season_id =
              standings_snapshots.season_id
            AND standings_snapshot_finalizations.standings_snapshot_id =
              standings_snapshots.id
        )
    `);
    findSnapshotStatement = database.prepare(`
      SELECT *
      FROM standings_snapshots
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @snapshotId
      LIMIT 2
    `);
    insertSnapshotStatement = database.prepare(`
      INSERT INTO standings_snapshots (
        id,
        league_id,
        season_id,
        snapshot_version,
        source_result_version,
        status,
        calculated_at_ms,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @snapshotVersion,
        @sourceResultVersion,
        'final',
        @nowMs,
        @nowMs
      )
    `);
    insertStandingsRowStatement = database.prepare(`
      INSERT INTO standings_rows (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        team_id,
        rank,
        wins,
        losses,
        ties,
        standings_points,
        fantasy_points_for_hundredths,
        fantasy_points_against_hundredths,
        fantasy_point_differential_hundredths,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @snapshotId,
        @teamId,
        @rank,
        @wins,
        @losses,
        @ties,
        @standingsPoints,
        @fantasyPointsForHundredths,
        @fantasyPointsAgainstHundredths,
        @fantasyPointsDifferentialHundredths,
        (
          SELECT calculated_at_ms
          FROM standings_snapshots
          WHERE standings_snapshots.league_id = @leagueId
            AND standings_snapshots.season_id = @seasonId
            AND standings_snapshots.id = @snapshotId
        )
      )
    `);
    insertResultLinkStatement = database.prepare(`
      INSERT INTO standings_snapshot_result_versions (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        matchup_week_id,
        matchup_id,
        matchup_result_id,
        matchup_result_version_id,
        result_version_number,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @snapshotId,
        @matchupWeekId,
        @matchupId,
        @matchupResultId,
        @resultVersionId,
        @resultVersionNumber,
        @nowMs
      )
    `);
    insertTeamIdentityStatement = database.prepare(`
      INSERT INTO standings_snapshot_team_identities (
        id,
        league_id,
        season_id,
        standings_snapshot_id,
        team_id,
        team_display_name,
        primary_colour,
        secondary_colour,
        tertiary_colour,
        pattern_template,
        source_logo_object_id,
        logo_media_type,
        logo_byte_length,
        logo_width,
        logo_height,
        logo_content_sha256,
        logo_content_bytes,
        created_at_ms
      ) VALUES (
        @id,
        @leagueId,
        @seasonId,
        @snapshotId,
        @teamId,
        @teamDisplayName,
        @primaryColour,
        @secondaryColour,
        @tertiaryColour,
        @patternTemplate,
        @sourceLogoObjectId,
        @logoMediaType,
        @logoByteLength,
        @logoWidth,
        @logoHeight,
        @logoContentSha256,
        @logoContentBytes,
        @nowMs
      )
    `);
    insertOperationStatement = database.prepare(`
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
        @id,
        @leagueId,
        @seasonId,
        @snapshotId,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        'finalize_regular_season',
        'succeeded',
        NULL,
        @metadataJson,
        @idempotencyRequestId,
        @nowMs,
        @nowMs
      )
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
        @id,
        @leagueId,
        @seasonId,
        @snapshotId,
        @finalizationVersion,
        1,
        'final',
        'regular_season_completion',
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
        @seasonVersionBefore,
        @seasonVersionAfter,
        @actorUserId,
        @actorMembershipId,
        @actorAuthority,
        @operationId,
        @idempotencyRequestId,
        NULL,
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
    findFinalizationStatement = database.prepare(`
      SELECT *
      FROM standings_snapshot_finalizations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @finalizationId
      LIMIT 2
    `);
    advanceSeasonStatement = database.prepare(`
      UPDATE seasons
      SET updated_at_ms = @nowMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @seasonId
        AND status = 'active'
        AND version = @expectedVersion
        AND EXISTS (
          SELECT 1
          FROM leagues
          WHERE leagues.id = seasons.league_id
            AND leagues.current_season_id = seasons.id
            AND leagues.status IN ('active', 'frozen')
        )
    `);
    findSeasonStatement = database.prepare(`
      SELECT *
      FROM seasons
      WHERE league_id = @leagueId
        AND id = @seasonId
      LIMIT 2
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
        result_type = 'standings_finalization',
        result_id = @finalizationId,
        completed_at_ms = @completedAtMs
      WHERE id = @id
        AND league_id = @leagueId
        AND operation =
          'standings.finalize_regular_season.v1'
        AND status = 'started'
        AND result_type IS NULL
        AND result_id IS NULL
        AND completed_at_ms IS NULL
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation:
        "prepareMatchupStandingsFinalizationRepository",
    });
  }

  function uniqueRow(
    statement,
    parameters,
    { operation, tableName, message }
  ) {
    try {
      const rows = statement.all(parameters);
      if (rows.length > 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          message,
          { details: { operation, tableName } }
        );
      }
      return freezeRow(rows[0]);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation,
        tableName,
      });
    }
  }

  function executeInsert(
    statement,
    parameters,
    { operation, tableName }
  ) {
    try {
      const result = statement.run(parameters);
      if (result.changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.schemaIncompatible,
          "The standings-finalization insert did not write exactly one row.",
          { details: { operation, tableName } }
        );
      }
    } catch (error) {
      throw mapRepositoryError(error, {
        operation,
        tableName,
      });
    }
  }

  return Object.freeze({
    readFinalizationContext(options) {
      exactObject(
        options,
        ["leagueId", "seasonId"],
        "An exact standings-finalization context lookup is required."
      );
      const scope = {
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
      };
      const aggregate = uniqueRow(
        aggregateStatement,
        scope,
        {
          operation:
            "readStandingsFinalizationAggregate",
          tableName: "seasons",
          message:
            "The standings-finalization aggregate is not unique.",
        }
      );
      if (!aggregate) return null;
      try {
        const scheduleOperations = freezeRows(
          scheduleOperationsStatement.all(scope)
        );
        const scheduleGenerations = freezeRows(
          scheduleGenerationsStatement.all(scope)
        );
        const scheduleCommandResults = freezeRows(
          scheduleCommandResultsStatement.all(scope)
        );
        const scheduleRecoveries = freezeRows(
          scheduleRecoveriesStatement.all(scope)
        );
        const correctionOperations = freezeRows(
          correctionOperationsStatement.all(scope)
        );
        const weeks = freezeRows(
          weeksStatement.all(scope)
        );
        const results = freezeRows(
          resultsStatement.all(scope)
        );
        const byes = freezeRows(
          byesStatement.all(scope)
        );
        const participants = freezeRows(
          participantsStatement.all(scope)
        );
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
        const snapshots = freezeRows(
          snapshotsStatement.all(scope)
        );
        return Object.freeze({
          aggregate,
          scheduleOperations,
          scheduleGenerations,
          scheduleCommandResults,
          scheduleRecoveries,
          correctionOperations,
          weeks,
          results,
          byes,
          participants,
          activeMemberUserIds,
          snapshots,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "readStandingsFinalizationContext",
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
        "An exact standings-finalization idempotency lookup is required."
      );
      return uniqueRow(
        findIdempotencyByScopeStatement,
        {
          leagueId: stableId(
            options.leagueId,
            "league identifier"
          ),
          actorUserId: stableId(
            options.actorUserId,
            "actor-user identifier"
          ),
          operation: boundedText(
            options.operation,
            128,
            "idempotency operation"
          ),
          clientKey: boundedText(
            options.clientKey,
            128,
            "idempotency client key"
          ),
        },
        {
          operation:
            "findStandingsFinalizationIdempotency",
          tableName: "idempotency_requests",
          message:
            "The standings-finalization idempotency scope is not unique.",
        }
      );
    },

    findFinalizationResult(options) {
      exactObject(
        options,
        ["leagueId", "finalizationId"],
        "An exact durable standings-finalization result lookup is required."
      );
      return uniqueRow(
        findFinalizationResultStatement,
        {
          leagueId: stableId(
            options.leagueId,
            "league identifier"
          ),
          finalizationId: stableId(
            options.finalizationId,
            "standings-finalization identifier"
          ),
        },
        {
          operation:
            "findDurableStandingsFinalizationResult",
          tableName:
            "standings_snapshot_finalizations",
          message:
            "The durable standings-finalization result is not unique.",
        }
      );
    },

    insertStartedIdempotency(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "actorUserId",
          "operation",
          "clientKey",
          "requestHash",
          "createdAtMs",
          "expiresAtMs",
        ],
        "An exact started standings-finalization idempotency record is required."
      );
      const createdAtMs = safeTimestamp(
        options.createdAtMs,
        "idempotency creation timestamp"
      );
      const expiresAtMs = safeTimestamp(
        options.expiresAtMs,
        "idempotency expiry timestamp"
      );
      if (expiresAtMs <= createdAtMs) {
        invalid(
          "Standings-finalization idempotency expiry must follow creation."
        );
      }
      const parameters = {
        id: stableId(
          options.id,
          "idempotency identifier"
        ),
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        actorUserId: stableId(
          options.actorUserId,
          "actor-user identifier"
        ),
        operation: boundedText(
          options.operation,
          128,
          "idempotency operation"
        ),
        clientKey: boundedText(
          options.clientKey,
          128,
          "idempotency client key"
        ),
        requestHash: digest(
          options.requestHash,
          "request"
        ),
        createdAtMs,
        expiresAtMs,
      };
      executeInsert(
        insertStartedIdempotencyStatement,
        parameters,
        {
          operation:
            "insertStartedStandingsFinalizationIdempotency",
          tableName: "idempotency_requests",
        }
      );
      return uniqueRow(
        findIdempotencyByIdStatement,
        {
          id: parameters.id,
          leagueId: parameters.leagueId,
        },
        {
          operation:
            "readStartedStandingsFinalizationIdempotency",
          tableName: "idempotency_requests",
          message:
            "The started standings-finalization idempotency record is not unique.",
        }
      );
    },

    supersedeCurrentDerivedSnapshot(options) {
      exactObject(
        options,
        ["leagueId", "seasonId", "snapshotId"],
        "An exact current derived standings snapshot supersession is required."
      );
      const parameters = {
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
        snapshotId: stableId(
          options.snapshotId,
          "standings-snapshot identifier"
        ),
      };
      try {
        if (
          supersedeCurrentSnapshotStatement.run(
            parameters
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The current derived standings snapshot could not be superseded."
          );
        }
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "supersedeCurrentDerivedStandingsSnapshot",
          tableName: "standings_snapshots",
        });
      }
      return uniqueRow(
        findSnapshotStatement,
        parameters,
        {
          operation:
            "readSupersededDerivedStandingsSnapshot",
          tableName: "standings_snapshots",
          message:
            "The superseded derived standings snapshot is not unique.",
        }
      );
    },

    insertFinalSnapshot(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "snapshotVersion",
          "sourceResultVersion",
          "nowMs",
        ],
        "An exact final standings snapshot is required."
      );
      const parameters = {
        id: stableId(
          options.id,
          "standings-snapshot identifier"
        ),
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
        snapshotVersion: positiveInteger(
          options.snapshotVersion,
          "standings-snapshot version"
        ),
        sourceResultVersion: nonnegativeInteger(
          options.sourceResultVersion,
          "source-result version"
        ),
        nowMs: safeTimestamp(
          options.nowMs,
          "standings-finalization timestamp"
        ),
      };
      executeInsert(insertSnapshotStatement, parameters, {
        operation: "insertFinalStandingsSnapshot",
        tableName: "standings_snapshots",
      });
      return uniqueRow(
        findSnapshotStatement,
        {
          leagueId: parameters.leagueId,
          seasonId: parameters.seasonId,
          snapshotId: parameters.id,
        },
        {
          operation: "readInsertedFinalStandingsSnapshot",
          tableName: "standings_snapshots",
          message:
            "The inserted final standings snapshot is not unique.",
        }
      );
    },

    insertStandingsRows(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "snapshotId",
          "rows",
        ],
        "An exact final standings-row set is required."
      );
      const leagueId = stableId(
        options.leagueId,
        "league identifier"
      );
      const seasonId = stableId(
        options.seasonId,
        "season identifier"
      );
      const snapshotId = stableId(
        options.snapshotId,
        "standings-snapshot identifier"
      );
      const rows = normalizeUniqueArray(
        options.rows,
        normalizeStandingsRow,
        (row) => `${row.id}:${row.teamId}`,
        "final standings row"
      );
      const teamIds = rows.map((row) => row.teamId);
      const rowIds = rows.map((row) => row.id);
      if (
        new Set(teamIds).size !== teamIds.length ||
        new Set(rowIds).size !== rowIds.length
      ) {
        invalid(
          "Final standings rows require unique row and team identifiers."
        );
      }
      const inserted = [];
      for (const row of rows) {
        const parameters = {
          ...row,
          leagueId,
          seasonId,
          snapshotId,
        };
        executeInsert(
          insertStandingsRowStatement,
          parameters,
          {
            operation: "insertFinalStandingsRow",
            tableName: "standings_rows",
          }
        );
        inserted.push(
          uniqueRow(
            database.prepare(`
              SELECT *
              FROM standings_rows
              WHERE league_id = @leagueId
                AND id = @id
              LIMIT 2
            `),
            { leagueId, id: row.id },
            {
              operation:
                "readInsertedFinalStandingsRow",
              tableName: "standings_rows",
              message:
                "The inserted final standings row is not unique.",
            }
          )
        );
      }
      return Object.freeze(inserted);
    },

    insertResultVersionLinks(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "snapshotId",
          "links",
          "nowMs",
        ],
        "An exact final standings result-version-link set is required."
      );
      const leagueId = stableId(
        options.leagueId,
        "league identifier"
      );
      const seasonId = stableId(
        options.seasonId,
        "season identifier"
      );
      const snapshotId = stableId(
        options.snapshotId,
        "standings-snapshot identifier"
      );
      const nowMs = safeTimestamp(
        options.nowMs,
        "result-version-link creation timestamp"
      );
      const links = normalizeUniqueArray(
        options.links,
        normalizeResultVersionLink,
        (link) =>
          `${link.id}:${link.matchupId}:` +
          `${link.matchupResultId}:${link.resultVersionId}`,
        "final standings result-version link"
      );
      for (const key of [
        "id",
        "matchupId",
        "matchupResultId",
        "resultVersionId",
      ]) {
        const values = links.map((link) => link[key]);
        if (new Set(values).size !== values.length) {
          invalid(
            "Final standings result-version links must have unique source identities."
          );
        }
      }
      const inserted = [];
      for (const link of links) {
        const parameters = {
          ...link,
          leagueId,
          seasonId,
          snapshotId,
          nowMs,
        };
        executeInsert(
          insertResultLinkStatement,
          parameters,
          {
            operation:
              "insertFinalStandingsResultVersionLink",
            tableName:
              "standings_snapshot_result_versions",
          }
        );
        inserted.push(
          freezeRow({
            id: link.id,
            league_id: leagueId,
            season_id: seasonId,
            standings_snapshot_id: snapshotId,
            matchup_week_id: link.matchupWeekId,
            matchup_id: link.matchupId,
            matchup_result_id: link.matchupResultId,
            matchup_result_version_id:
              link.resultVersionId,
            result_version_number:
              link.resultVersionNumber,
            created_at_ms: nowMs,
          })
        );
      }
      return Object.freeze(inserted);
    },

    insertTeamIdentities(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "snapshotId",
          "identities",
          "nowMs",
        ],
        "An exact final standings team-identity set is required."
      );
      const leagueId = stableId(
        options.leagueId,
        "league identifier"
      );
      const seasonId = stableId(
        options.seasonId,
        "season identifier"
      );
      const snapshotId = stableId(
        options.snapshotId,
        "standings-snapshot identifier"
      );
      const nowMs = safeTimestamp(
        options.nowMs,
        "team-identity creation timestamp"
      );
      const identities = normalizeUniqueArray(
        options.identities,
        normalizeTeamIdentity,
        (identity) =>
          `${identity.id}:${identity.teamId}`,
        "final standings team identity"
      );
      const ids = identities.map((identity) => identity.id);
      const teamIds = identities.map(
        (identity) => identity.teamId
      );
      if (
        new Set(ids).size !== ids.length ||
        new Set(teamIds).size !== teamIds.length
      ) {
        invalid(
          "Final standings identities require unique row and team identifiers."
        );
      }
      const inserted = [];
      for (const identity of identities) {
        const parameters = {
          ...identity,
          leagueId,
          seasonId,
          snapshotId,
          nowMs,
        };
        executeInsert(
          insertTeamIdentityStatement,
          parameters,
          {
            operation:
              "insertFinalStandingsTeamIdentity",
            tableName:
              "standings_snapshot_team_identities",
          }
        );
        inserted.push(
          freezeRow({
            id: identity.id,
            league_id: leagueId,
            season_id: seasonId,
            standings_snapshot_id: snapshotId,
            team_id: identity.teamId,
            team_display_name:
              identity.teamDisplayName,
            primary_colour:
              identity.primaryColour,
            secondary_colour:
              identity.secondaryColour,
            tertiary_colour:
              identity.tertiaryColour,
            pattern_template:
              identity.patternTemplate,
            source_logo_object_id:
              identity.sourceLogoObjectId,
            logo_media_type:
              identity.logoMediaType,
            logo_byte_length:
              identity.logoByteLength,
            logo_width: identity.logoWidth,
            logo_height: identity.logoHeight,
            logo_content_sha256:
              identity.logoContentSha256,
            logo_content_bytes:
              identity.logoContentBytes,
            created_at_ms: nowMs,
          })
        );
      }
      return Object.freeze(inserted);
    },

    insertSucceededOperation(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "snapshotId",
          "actorUserId",
          "actorMembershipId",
          "actorAuthority",
          "idempotencyRequestId",
          "metadataJson",
          "nowMs",
        ],
        "An exact succeeded standings-finalization operation is required."
      );
      const parameters = {
        id: stableId(
          options.id,
          "standings-operation identifier"
        ),
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
        snapshotId: stableId(
          options.snapshotId,
          "standings-snapshot identifier"
        ),
        actorUserId: stableId(
          options.actorUserId,
          "actor-user identifier"
        ),
        actorMembershipId: stableId(
          options.actorMembershipId,
          "actor-membership identifier"
        ),
        actorAuthority: actorAuthority(
          options.actorAuthority
        ),
        idempotencyRequestId: stableId(
          options.idempotencyRequestId,
          "idempotency-request identifier"
        ),
        metadataJson: canonicalJson(
          options.metadataJson,
          16_384,
          "standings-operation metadata"
        ),
        nowMs: safeTimestamp(
          options.nowMs,
          "standings-operation timestamp"
        ),
      };
      executeInsert(
        insertOperationStatement,
        parameters,
        {
          operation:
            "insertSucceededStandingsFinalizationOperation",
          tableName: "standings_operations",
        }
      );
      return freezeRow(
        database
          .prepare(`
            SELECT *
            FROM standings_operations
            WHERE league_id = @leagueId
              AND id = @id
            LIMIT 2
          `)
          .get({
            leagueId: parameters.leagueId,
            id: parameters.id,
          })
      );
    },

    insertFinalizationEvidence(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "snapshotId",
          "finalizationVersion",
          "standingsRuleVersion",
          "resultSetHash",
          "expectedMatchupCount",
          "expectedWeekCount",
          "participantCount",
          "seasonVersionBefore",
          "actorUserId",
          "actorMembershipId",
          "actorAuthority",
          "operationId",
          "idempotencyRequestId",
          "nowMs",
        ],
        "An exact canonical standings-finalization evidence record is required."
      );
      const seasonVersionBefore = positiveInteger(
        options.seasonVersionBefore,
        "season version"
      );
      if (
        !Number.isSafeInteger(
          seasonVersionBefore + 1
        )
      ) {
        invalid(
          "The standings-finalization season version cannot be advanced safely."
        );
      }
      const parameters = {
        id: stableId(
          options.id,
          "standings-finalization identifier"
        ),
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
        snapshotId: stableId(
          options.snapshotId,
          "standings-snapshot identifier"
        ),
        finalizationVersion: positiveInteger(
          options.finalizationVersion,
          "standings-finalization version"
        ),
        standingsRuleVersion: positiveInteger(
          options.standingsRuleVersion,
          "standings-rule version"
        ),
        resultSetHash: digest(
          options.resultSetHash,
          "standings result-set"
        ),
        expectedMatchupCount: positiveInteger(
          options.expectedMatchupCount,
          "expected matchup count"
        ),
        expectedWeekCount: positiveInteger(
          options.expectedWeekCount,
          "expected week count"
        ),
        participantCount: positiveInteger(
          options.participantCount,
          "participant count"
        ),
        seasonVersionBefore,
        seasonVersionAfter:
          seasonVersionBefore + 1,
        actorUserId: stableId(
          options.actorUserId,
          "actor-user identifier"
        ),
        actorMembershipId: stableId(
          options.actorMembershipId,
          "actor-membership identifier"
        ),
        actorAuthority: actorAuthority(
          options.actorAuthority
        ),
        operationId: stableId(
          options.operationId,
          "standings-operation identifier"
        ),
        idempotencyRequestId: stableId(
          options.idempotencyRequestId,
          "idempotency-request identifier"
        ),
        nowMs: safeTimestamp(
          options.nowMs,
          "standings-finalization timestamp"
        ),
      };
      executeInsert(
        insertFinalizationStatement,
        parameters,
        {
          operation:
            "insertCanonicalStandingsFinalizationEvidence",
          tableName:
            "standings_snapshot_finalizations",
        }
      );
      return uniqueRow(
        findFinalizationStatement,
        {
          leagueId: parameters.leagueId,
          seasonId: parameters.seasonId,
          finalizationId: parameters.id,
        },
        {
          operation:
            "readInsertedStandingsFinalizationEvidence",
          tableName:
            "standings_snapshot_finalizations",
          message:
            "The inserted standings-finalization evidence is not unique.",
        }
      );
    },

    writeFinalizedNotification(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "finalizationId",
          "snapshotId",
          "userId",
          "nowMs",
        ],
        "An exact standings-finalized notification is required."
      );
      const leagueId = stableId(
        options.leagueId,
        "league identifier"
      );
      const seasonId = stableId(
        options.seasonId,
        "season identifier"
      );
      const finalizationId = stableId(
        options.finalizationId,
        "standings-finalization identifier"
      );
      const snapshotId = stableId(
        options.snapshotId,
        "standings-snapshot identifier"
      );
      const userId = stableId(
        options.userId,
        "notification user identifier"
      );
      const nowMs = safeTimestamp(
        options.nowMs,
        "notification timestamp"
      );
      try {
        return notifications.insert({
          id: stableId(
            options.id,
            "notification identifier"
          ),
          userId,
          leagueId,
          eventType: "standings_finalized",
          messageDataJson: JSON.stringify({
            leagueId,
            seasonId,
            snapshotId,
            standingsFinalizationId: finalizationId,
          }),
          relatedFeature: "standings",
          relatedRecordId: finalizationId,
          deliveryStatus: "pending",
          createdAtMs: nowMs,
          deliveredAtMs: null,
          deduplicationKey:
            `standings_finalized:${leagueId}:` +
            `${seasonId}:${finalizationId}:${userId}`,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "writeStandingsFinalizedNotification",
          tableName: "notifications",
        });
      }
    },

    writeFinalizedOutbox(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "seasonId",
          "snapshotId",
          "seasonVersion",
          "nowMs",
        ],
        "An exact standings-finalized outbox event is required."
      );
      const leagueId = stableId(
        options.leagueId,
        "league identifier"
      );
      const seasonId = stableId(
        options.seasonId,
        "season identifier"
      );
      stableId(
        options.snapshotId,
        "standings-snapshot identifier"
      );
      const seasonVersion = positiveInteger(
        options.seasonVersion,
        "season version"
      );
      const nowMs = safeTimestamp(
        options.nowMs,
        "outbox timestamp"
      );
      try {
        return outboxWriter.write({
          id: stableId(
            options.id,
            "outbox-event identifier"
          ),
          leagueId,
          eventType: "standings.changed",
          aggregateType: "season",
          aggregateId: seasonId,
          payload: createSocketEventMetadata({
            eventType: "standings.changed",
            version: seasonVersion,
            reasonCode: "standings_changed",
            occurredAtMs: nowMs,
            related: createEmptySocketRelated(),
          }),
          occurredAtMs: nowMs,
          audiences: [{ kind: "league" }],
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "writeStandingsFinalizedOutbox",
          tableName: "outbox_events",
        });
      }
    },

    advanceSeasonVersion(options) {
      exactObject(
        options,
        [
          "leagueId",
          "seasonId",
          "expectedVersion",
          "nowMs",
        ],
        "An exact standings-finalization season advance is required."
      );
      const parameters = {
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        seasonId: stableId(
          options.seasonId,
          "season identifier"
        ),
        expectedVersion: positiveInteger(
          options.expectedVersion,
          "expected season version"
        ),
        nowMs: safeTimestamp(
          options.nowMs,
          "season update timestamp"
        ),
      };
      try {
        if (
          advanceSeasonStatement.run(parameters).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The standings-finalization season version could not be advanced."
          );
        }
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "advanceStandingsFinalizationSeasonVersion",
          tableName: "seasons",
        });
      }
      return uniqueRow(
        findSeasonStatement,
        parameters,
        {
          operation:
            "readAdvancedStandingsFinalizationSeason",
          tableName: "seasons",
          message:
            "The advanced standings-finalization season is not unique.",
        }
      );
    },

    completeIdempotency(options) {
      exactObject(
        options,
        [
          "id",
          "leagueId",
          "finalizationId",
          "completedAtMs",
        ],
        "An exact standings-finalization idempotency completion is required."
      );
      const parameters = {
        id: stableId(
          options.id,
          "idempotency identifier"
        ),
        leagueId: stableId(
          options.leagueId,
          "league identifier"
        ),
        finalizationId: stableId(
          options.finalizationId,
          "standings-finalization identifier"
        ),
        completedAtMs: safeTimestamp(
          options.completedAtMs,
          "idempotency completion timestamp"
        ),
      };
      try {
        if (
          completeIdempotencyStatement.run(
            parameters
          ).changes !== 1
        ) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.versionConflict,
            "The standings-finalization idempotency record cannot be completed."
          );
        }
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "completeStandingsFinalizationIdempotency",
          tableName: "idempotency_requests",
        });
      }
      return uniqueRow(
        findIdempotencyByIdStatement,
        {
          id: parameters.id,
          leagueId: parameters.leagueId,
        },
        {
          operation:
            "readCompletedStandingsFinalizationIdempotency",
          tableName: "idempotency_requests",
          message:
            "The completed standings-finalization idempotency record is not unique.",
        }
      );
    },
  });
}

module.exports = {
  IDEMPOTENCY_COLUMNS,
  MATCHUP_RESULT_CORRECTION_OPERATION,
  MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
  STANDINGS_FINALIZATION_OPERATION,
  STANDINGS_FINALIZATION_RESULT_TYPE,
  createSqliteMatchupStandingsFinalizationRepository,
};
