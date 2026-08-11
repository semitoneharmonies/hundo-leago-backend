const crypto = require("node:crypto");

const {
  calculateStandings,
} = require(
  "../../../domain/matchups/matchupStandingsPolicy"
);
const {
  RESULT_SET_HASH_PATTERN,
  calculateStandingsResultSetHash,
  officialStandingsRowsChanged,
} = require(
  "../../../domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  FORBIDDEN_TEXT_PATTERN,
  UUID_PATTERN,
  validateMatchupResultCorrectionExpectedVersion,
  validateMatchupResultCorrectionIdempotencyKey,
  validateMatchupResultCorrectionInput,
  validateMatchupResultCorrectionLeagueId,
  validateMatchupResultCorrectionResultId,
  validateMatchupResultCorrectionSeasonId,
} = require(
  "../../../domain/matchups/matchupResultCorrectionPolicy"
);
const {
  COLOUR_PATTERN,
  MAXIMUM_LOGO_BYTES,
  MAXIMUM_LOGO_DIMENSION,
  SUPPORTED_LOGO_MEDIA_TYPES,
} = require(
  "../../../domain/leagues/teamProfilePolicy"
);
const {
  teamPatternColourCount,
} = require(
  "../../../domain/leagues/teamPatternPolicy"
);

const MATCHUP_RESULT_CORRECTION_OPERATION =
  "matchup.result.correct.v1";
const MATCHUP_RESULT_CORRECTION_RESULT_TYPE =
  "matchup_result_correction";
const MATCHUP_RESULT_CORRECTION_AUDIT_EVENT_TYPE =
  "matchup.result_corrected";
const MATCHUP_RESULT_CORRECTION_IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;

const VALID_LEAGUE_STATUSES = new Set([
  "active",
  "frozen",
]);
const VALID_SEASON_STATUSES = new Set([
  "active",
  "completed",
]);
const VALID_MATCHUP_STATUSES = new Set([
  "final",
  "correction_required",
]);
const VALID_RESULT_STATUSES = new Set([
  "official",
  "corrected",
]);
const VALID_OUTCOMES = new Set([
  "home_win",
  "away_win",
  "tie",
]);
const VALID_LOGO_MEDIA_TYPES = new Set(
  SUPPORTED_LOGO_MEDIA_TYPES
);

class MatchupResultCorrectionServiceError extends Error {
  constructor(code, { details, reasonCode } = {}) {
    super(
      "The matchup result could not be corrected."
    );
    this.name =
      "MatchupResultCorrectionServiceError";
    this.code = code;
    if (reasonCode !== undefined) {
      this.reasonCode = reasonCode;
    }
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function fail(code, options) {
  throw new MatchupResultCorrectionServiceError(
    code,
    options
  );
}

function failState(reasonCode) {
  fail("MATCHUP_RESULT_CORRECTION_STATE_INVALID", {
    reasonCode,
  });
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `matchup-result correction requires ${description}`
    );
  }
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

function isSafeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!isSafeTimestamp(nowMs)) {
    throw new TypeError(
      "matchup-result correction requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function createSecureIdFactory(secureRandom) {
  const generated = new Set();
  return function nextId() {
    const id = secureRandom.id();
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      generated.has(id)
    ) {
      throw new TypeError(
        "matchup-result correction requires unique canonical secure identifiers"
      );
    }
    generated.add(id);
    return id;
  };
}

function canonicalActorAuthority(authority) {
  if (
    !UUID_PATTERN.test(authority?.actorUserId || "") ||
    !UUID_PATTERN.test(authority?.membershipId || "")
  ) {
    fail("LEAGUE_COMMISSIONER_REQUIRED");
  }
  if (authority.authority === "commissioner") {
    return "commissioner";
  }
  if (
    authority.authority ===
      "platform_administrator" ||
    authority.authority ===
      "platform_administrator_as_commissioner"
  ) {
    return "platform_administrator_as_commissioner";
  }
  fail("LEAGUE_COMMISSIONER_REQUIRED");
}

function matchupResultCorrectionRequestHash({
  leagueId,
  seasonId,
  resultId,
  expectedResultVersion,
  input,
}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        awayScoreHundredths:
          input.awayScoreHundredths,
        confirmation: input.confirmed,
        expectedResultVersion,
        homeScoreHundredths:
          input.homeScoreHundredths,
        leagueId,
        operation:
          MATCHUP_RESULT_CORRECTION_OPERATION,
        writtenReason: input.writtenReason,
        resultId,
        seasonId,
      }),
      "utf8"
    )
    .digest("hex");
}

function internalResult(result, replayed) {
  const copy = { ...result };
  Object.defineProperty(copy, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(copy);
}

function booleanEvidence(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  fail(
    "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
  );
}

function safeCorrectionResult(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.result_id || "") ||
    !UUID_PATTERN.test(
      row.result_version_id || ""
    ) ||
    !UUID_PATTERN.test(row.league_id || "") ||
    !UUID_PATTERN.test(row.season_id || "") ||
    !UUID_PATTERN.test(
      row.matchup_week_id || ""
    ) ||
    !UUID_PATTERN.test(row.matchup_id || "") ||
    !Number.isSafeInteger(
      row.result_version_number
    ) ||
    row.result_version_number < 2 ||
    row.result_version !==
      row.result_version_number ||
    !isSafeTimestamp(row.corrected_at_ms)
  ) {
    fail(
      "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
    );
  }

  const standingsRowsChanged =
    booleanEvidence(row.standings_rows_changed);
  const replacementFields = [
    row.replacement_snapshot_id,
    row.replacement_snapshot_version,
    row.replacement_result_set_hash,
  ];
  const hasReplacement =
    row.replacement_snapshot_id !== null;
  if (
    hasReplacement
      ? !UUID_PATTERN.test(
          row.replacement_snapshot_id || ""
        ) ||
        !Number.isSafeInteger(
          row.replacement_snapshot_version
        ) ||
        row.replacement_snapshot_version < 1 ||
        !RESULT_SET_HASH_PATTERN.test(
          row.replacement_result_set_hash || ""
        )
      : replacementFields.some(
          (value) => value !== null
        ) || standingsRowsChanged
  ) {
    fail(
      "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
    );
  }

  return Object.freeze({
    code: "MATCHUP_RESULT_CORRECTED",
    result: Object.freeze({
      resultId: row.result_id,
      resultVersionId: row.result_version_id,
      resultVersionNumber:
        row.result_version_number,
      resultVersion: row.result_version,
      leagueId: row.league_id,
      seasonId: row.season_id,
      weekId: row.matchup_week_id,
      matchupId: row.matchup_id,
      correctedAtMs: row.corrected_at_ms,
      standingsReplacement: hasReplacement
        ? Object.freeze({
            snapshotId:
              row.replacement_snapshot_id,
            snapshotVersion:
              row.replacement_snapshot_version,
            resultSetHash:
              row.replacement_result_set_hash,
            standingsRowsChanged,
          })
        : null,
    }),
  });
}

function inspectDurableEvidence(
  row,
  {
    leagueId,
    seasonId,
    resultId,
    expectedResultVersion,
    actorUserId,
    clientKey,
    requestHash,
  }
) {
  const evidence = row?.evidence;
  const metadata = JSON.stringify({
    resultId,
    resultVersionId: row?.result_version_id,
  });
  const hasReplacement =
    row?.replacement_snapshot_id !== null;
  if (
    row?.league_id !== leagueId ||
    row?.season_id !== seasonId ||
    row?.result_id !== resultId ||
    row?.result_version_number !==
      expectedResultVersion + 1 ||
    !Number.isSafeInteger(
      expectedResultVersion + 1
    ) ||
    !evidence ||
    !UUID_PATTERN.test(
      evidence.correctionOperationId || ""
    ) ||
    evidence.correctionOperationMetadataJson !==
      metadata ||
    !UUID_PATTERN.test(
      evidence.idempotencyRequestId || ""
    ) ||
    evidence.idempotencyActorUserId !== actorUserId ||
    evidence.idempotencyOperation !==
      MATCHUP_RESULT_CORRECTION_OPERATION ||
    evidence.idempotencyClientKey !== clientKey ||
    evidence.idempotencyRequestHash !== requestHash ||
    evidence.idempotencyCompletedAtMs !==
      row.corrected_at_ms ||
    (hasReplacement
      ? !UUID_PATTERN.test(
          evidence.replacementFinalizationId || ""
        ) ||
        !UUID_PATTERN.test(
          evidence.replacementStandingsOperationId ||
            ""
        )
      : evidence.replacementFinalizationId !== null ||
        evidence.replacementStandingsOperationId !==
          null)
  ) {
    fail(
      "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
    );
  }
}

function inspectReplayEvidence(
  row,
  { existing, ...expected }
) {
  inspectDurableEvidence(row, expected);
  if (
    row?.result_version_id !==
      existing.result_id ||
    row?.evidence?.idempotencyRequestId !==
      existing.id ||
    row?.evidence?.idempotencyCompletedAtMs !==
      existing.completed_at_ms
  ) {
    fail(
      "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
    );
  }
}

function validateOutcome(
  homeScoreHundredths,
  awayScoreHundredths,
  outcome
) {
  if (
    !Number.isSafeInteger(homeScoreHundredths) ||
    homeScoreHundredths < 0 ||
    !Number.isSafeInteger(awayScoreHundredths) ||
    awayScoreHundredths < 0 ||
    !VALID_OUTCOMES.has(outcome) ||
    (outcome === "home_win" &&
      homeScoreHundredths <=
        awayScoreHundredths) ||
    (outcome === "away_win" &&
      awayScoreHundredths <=
        homeScoreHundredths) ||
    (outcome === "tie" &&
      homeScoreHundredths !==
        awayScoreHundredths)
  ) {
    failState("result_score_invalid");
  }
}

function inspectAggregate(
  aggregate,
  { leagueId, seasonId }
) {
  if (
    !aggregate ||
    aggregate.league_id !== leagueId ||
    !VALID_LEAGUE_STATUSES.has(
      aggregate.league_status
    ) ||
    aggregate.season_id !== seasonId ||
    !VALID_SEASON_STATUSES.has(
      aggregate.season_status
    ) ||
    !Number.isSafeInteger(
      aggregate.season_version
    ) ||
    aggregate.season_version < 1 ||
    !Number.isSafeInteger(
      aggregate.standings_rule_version
    ) ||
    aggregate.standings_rule_version < 1 ||
    (aggregate.current_season_id !== null &&
      !UUID_PATTERN.test(
        aggregate.current_season_id || ""
      )) ||
    (aggregate.season_status === "active" &&
      aggregate.current_season_id !== seasonId)
  ) {
    failState("season_state_invalid");
  }
  return aggregate;
}

function inspectMatchup(matchup) {
  if (
    !matchup ||
    !UUID_PATTERN.test(matchup.matchup_id || "") ||
    !UUID_PATTERN.test(
      matchup.matchup_week_id || ""
    ) ||
    !UUID_PATTERN.test(
      matchup.home_team_id || ""
    ) ||
    !UUID_PATTERN.test(
      matchup.away_team_id || ""
    ) ||
    matchup.home_team_id ===
      matchup.away_team_id ||
    !VALID_MATCHUP_STATUSES.has(
      matchup.matchup_status
    ) ||
    !VALID_MATCHUP_STATUSES.has(
      matchup.week_status
    ) ||
    matchup.matchup_status !==
      matchup.week_status ||
    !Number.isSafeInteger(
      matchup.matchup_version
    ) ||
    matchup.matchup_version < 1 ||
    !Number.isSafeInteger(matchup.week_version) ||
    matchup.week_version < 1
  ) {
    failState("matchup_state_invalid");
  }
  return matchup;
}

function inspectResultChain(
  result,
  versions,
  {
    resultId,
    matchup,
    expectedResultVersion,
  }
) {
  if (
    !result ||
    result.result_id !== resultId ||
    !UUID_PATTERN.test(
      result.current_version_id || ""
    ) ||
    !VALID_RESULT_STATUSES.has(
      result.result_status
    ) ||
    !Number.isSafeInteger(
      result.result_version
    ) ||
    result.result_version < 1 ||
    !isSafeTimestamp(result.finalized_at_ms)
  ) {
    failState("result_state_invalid");
  }
  if (
    result.result_version !==
    expectedResultVersion
  ) {
    fail(
      "MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED",
      {
        details: {
          currentVersion:
            result.result_version,
          refetch: true,
        },
      }
    );
  }
  if (
    !Array.isArray(versions) ||
    versions.length < 1 ||
    versions.length !== result.result_version
  ) {
    failState("result_version_chain_invalid");
  }

  const ids = new Set();
  let previous = null;
  for (
    let index = 0;
    index < versions.length;
    index += 1
  ) {
    const version = versions[index];
    const versionNumber = index + 1;
    validateOutcome(
      version?.home_score_hundredths,
      version?.away_score_hundredths,
      version?.outcome
    );
    if (
      !UUID_PATTERN.test(
        version?.result_version_id || ""
      ) ||
      ids.has(version.result_version_id) ||
      version.version_number !== versionNumber ||
      version.home_team_id !==
        matchup.home_team_id ||
      version.away_team_id !==
        matchup.away_team_id ||
      !UUID_PATTERN.test(
        version.source_snapshot_id || ""
      ) ||
      !isSafeTimestamp(version.created_at_ms) ||
      (previous &&
        version.created_at_ms <
          previous.created_at_ms)
    ) {
      failState("result_version_chain_invalid");
    }

    if (versionNumber === 1) {
      if (
        version.source_type !== "calculated" ||
        version.actor_user_id !== null ||
        version.reason !== null ||
        version.supersedes_version_id !== null
      ) {
        failState("result_version_chain_invalid");
      }
    } else if (
      version.source_type !== "correction" ||
      !UUID_PATTERN.test(
        version.actor_user_id || ""
      ) ||
      typeof version.reason !== "string" ||
      version.reason.length < 1 ||
      version.reason.length > 500 ||
      version.reason !== version.reason.trim() ||
      FORBIDDEN_TEXT_PATTERN.test(
        version.reason
      ) ||
      version.supersedes_version_id !==
        previous.result_version_id
    ) {
      failState("result_version_chain_invalid");
    }
    ids.add(version.result_version_id);
    previous = version;
  }

  if (
    result.current_version_id !==
      previous.result_version_id ||
    (versions.length === 1
      ? result.result_status !== "official"
      : result.result_status !== "corrected")
  ) {
    failState("result_version_chain_invalid");
  }
  return previous;
}

function inspectFinalizationRow(value) {
  if (
    !value ||
    !UUID_PATTERN.test(
      value.finalization_id || ""
    ) ||
    !UUID_PATTERN.test(
      value.standings_snapshot_id || ""
    ) ||
    !Number.isSafeInteger(
      value.finalization_version
    ) ||
    value.finalization_version < 1 ||
    !["final", "superseded"].includes(
      value.status
    ) ||
    ![
      "regular_season_completion",
      "result_correction",
    ].includes(value.cause) ||
    !Number.isSafeInteger(
      value.standings_rule_version
    ) ||
    value.standings_rule_version < 1 ||
    !RESULT_SET_HASH_PATTERN.test(
      value.result_set_hash || ""
    ) ||
    !Number.isSafeInteger(
      value.expected_matchup_count
    ) ||
    value.expected_matchup_count < 1 ||
    !Number.isSafeInteger(
      value.expected_week_count
    ) ||
    value.expected_week_count < 1 ||
    !Number.isSafeInteger(
      value.participant_count
    ) ||
    value.participant_count < 2 ||
    !Number.isSafeInteger(
      value.season_version_before
    ) ||
    value.season_version_before < 1 ||
    value.season_version_after !==
      value.season_version_before + 1 ||
    !UUID_PATTERN.test(
      value.standings_operation_id || ""
    ) ||
    !UUID_PATTERN.test(
      value.idempotency_request_id || ""
    ) ||
    !isSafeTimestamp(value.finalized_at_ms) ||
    (value.replaces_finalization_id !== null &&
      !UUID_PATTERN.test(
        value.replaces_finalization_id || ""
      ))
  ) {
    failState("canonical_finalization_invalid");
  }
  return value;
}

function inspectFinalizationHistory(
  finalizations,
  activeFinalization
) {
  if (!Array.isArray(finalizations)) {
    failState("canonical_finalization_history_invalid");
  }
  if (finalizations.length === 0) {
    if (activeFinalization !== null) {
      failState(
        "canonical_finalization_history_invalid"
      );
    }
    return null;
  }

  const ordered = finalizations
    .map(inspectFinalizationRow)
    .sort(
      (left, right) =>
        left.finalization_version -
          right.finalization_version ||
        left.finalization_id.localeCompare(
          right.finalization_id
        )
    );
  const ids = new Set();
  for (
    let index = 0;
    index < ordered.length;
    index += 1
  ) {
    const current = ordered[index];
    const previous =
      index === 0 ? null : ordered[index - 1];
    if (
      ids.has(current.finalization_id) ||
      (previous &&
        current.finalization_version !==
          previous.finalization_version + 1) ||
      (index === 0 &&
        (current.cause !==
          "regular_season_completion" ||
          current.replaces_finalization_id !==
            null)) ||
      (index > 0 &&
        (current.cause !==
          "result_correction" ||
          current.replaces_finalization_id !==
            previous.finalization_id)) ||
      (index < ordered.length - 1 &&
        current.status !== "superseded") ||
      (index === ordered.length - 1 &&
        current.status !== "final")
    ) {
      failState(
        "canonical_finalization_history_invalid"
      );
    }
    ids.add(current.finalization_id);
  }
  const active = ordered.at(-1);
  if (
    !activeFinalization ||
    activeFinalization.finalization
      ?.finalization_id !== active.finalization_id
  ) {
    failState(
      "canonical_finalization_history_invalid"
    );
  }
  return active;
}

function inspectIdentities(
  identities,
  expectedCount,
  snapshotId
) {
  if (
    !Array.isArray(identities) ||
    identities.length !== expectedCount
  ) {
    failState("standings_identities_invalid");
  }
  const rowIds = new Set();
  const ids = new Set();
  const normalized = [];
  for (const identity of identities) {
    const colourCount = teamPatternColourCount(
      identity?.pattern_template
    );
    const hasLogo =
      identity?.source_logo_object_id !== null;
    const logoValues = [
      identity?.logo_media_type,
      identity?.logo_byte_length,
      identity?.logo_width,
      identity?.logo_height,
      identity?.logo_content_sha256,
      identity?.logo_content_bytes,
    ];
    if (
      !UUID_PATTERN.test(identity?.id || "") ||
      rowIds.has(identity.id) ||
      identity.standings_snapshot_id !==
        snapshotId ||
      !UUID_PATTERN.test(identity?.team_id || "") ||
      ids.has(identity.team_id) ||
      typeof identity.team_display_name !==
        "string" ||
      identity.team_display_name.length < 1 ||
      identity.team_display_name.length > 120 ||
      identity.team_display_name !==
        identity.team_display_name.trim() ||
      FORBIDDEN_TEXT_PATTERN.test(
        identity.team_display_name
      ) ||
      !COLOUR_PATTERN.test(
        identity.primary_colour || ""
      ) ||
      !COLOUR_PATTERN.test(
        identity.secondary_colour || ""
      ) ||
      ![2, 3].includes(colourCount) ||
      (colourCount === 2 &&
        identity.tertiary_colour !== null) ||
      (colourCount === 3 &&
        !COLOUR_PATTERN.test(
          identity.tertiary_colour || ""
        )) ||
      (!hasLogo &&
        logoValues.some((entry) => entry !== null)) ||
      (hasLogo &&
        (!UUID_PATTERN.test(
          identity.source_logo_object_id || ""
        ) ||
          !VALID_LOGO_MEDIA_TYPES.has(
            identity.logo_media_type
          ) ||
          !Number.isSafeInteger(
            identity.logo_byte_length
          ) ||
          identity.logo_byte_length < 1 ||
          identity.logo_byte_length >
            MAXIMUM_LOGO_BYTES ||
          !Number.isSafeInteger(
            identity.logo_width
          ) ||
          identity.logo_width < 1 ||
          identity.logo_width >
            MAXIMUM_LOGO_DIMENSION ||
          !Number.isSafeInteger(
            identity.logo_height
          ) ||
          identity.logo_height < 1 ||
          identity.logo_height >
            MAXIMUM_LOGO_DIMENSION ||
          !RESULT_SET_HASH_PATTERN.test(
            identity.logo_content_sha256 || ""
          ) ||
          !Buffer.isBuffer(
            identity.logo_content_bytes
          ) ||
          identity.logo_content_bytes.length !==
            identity.logo_byte_length))
    ) {
      failState("standings_identities_invalid");
    }
    rowIds.add(identity.id);
    ids.add(identity.team_id);
    normalized.push(
      Object.freeze({
        teamId: identity.team_id,
        teamDisplayName:
          identity.team_display_name,
        primaryColour: identity.primary_colour,
        secondaryColour:
          identity.secondary_colour,
        tertiaryColour:
          identity.tertiary_colour,
        patternTemplate:
          identity.pattern_template,
        sourceLogoObjectId:
          identity.source_logo_object_id,
        logoMediaType: identity.logo_media_type,
        logoByteLength:
          identity.logo_byte_length,
        logoWidth: identity.logo_width,
        logoHeight: identity.logo_height,
        logoContentSha256:
          identity.logo_content_sha256,
        logoContentBytes: hasLogo
          ? Buffer.from(
              identity.logo_content_bytes
            )
          : null,
      })
    );
  }
  normalized.sort((left, right) =>
    left.teamId.localeCompare(right.teamId)
  );
  return Object.freeze({
    ids,
    identities: Object.freeze(normalized),
  });
}

function inspectSnapshotRows(
  rows,
  {
    snapshotId,
    identities,
    expectedCount,
  }
) {
  if (
    !Array.isArray(rows) ||
    rows.length !== expectedCount
  ) {
    failState("standings_rows_invalid");
  }
  const names = new Map(
    identities.map((identity) => [
      identity.teamId,
      identity.teamDisplayName,
    ])
  );
  const ids = new Set();
  return Object.freeze(
    rows.map((row) => {
      if (
        !UUID_PATTERN.test(row?.id || "") ||
        !UUID_PATTERN.test(row?.team_id || "") ||
        ids.has(row.team_id) ||
        row.standings_snapshot_id !== snapshotId ||
        !names.has(row.team_id) ||
        !Number.isSafeInteger(row.rank) ||
        row.rank < 1 ||
        !Number.isSafeInteger(row.wins) ||
        row.wins < 0 ||
        !Number.isSafeInteger(row.losses) ||
        row.losses < 0 ||
        !Number.isSafeInteger(row.ties) ||
        row.ties < 0 ||
        row.standings_points !==
          row.wins * 2 + row.ties ||
        !Number.isSafeInteger(
          row.fantasy_points_for_hundredths
        ) ||
        row.fantasy_points_for_hundredths < 0 ||
        !Number.isSafeInteger(
          row.fantasy_points_against_hundredths
        ) ||
        row.fantasy_points_against_hundredths < 0 ||
        row.fantasy_point_differential_hundredths !==
          row.fantasy_points_for_hundredths -
            row.fantasy_points_against_hundredths
      ) {
        failState("standings_rows_invalid");
      }
      ids.add(row.team_id);
      const gamesPlayed =
        row.wins + row.losses + row.ties;
      return Object.freeze({
        teamId: row.team_id,
        teamDisplayName: names.get(row.team_id),
        gamesPlayed,
        wins: row.wins,
        losses: row.losses,
        ties: row.ties,
        standingsPoints: row.standings_points,
        pointsPercentageHundredths:
          gamesPlayed === 0
            ? 0
            : Math.round(
                (row.standings_points * 10_000) /
                  (gamesPlayed * 2)
              ),
        fantasyPointsForHundredths:
          row.fantasy_points_for_hundredths,
        fantasyPointsAgainstHundredths:
          row.fantasy_points_against_hundredths,
        fantasyPointsDifferentialHundredths:
          row.fantasy_point_differential_hundredths,
        rank: row.rank,
      });
    })
  );
}

function inspectActiveLinks(
  links,
  {
    leagueId,
    seasonId,
    resultId,
    matchup,
    currentVersion,
    standingsRuleVersion,
    expectedCount,
    participantIds,
    expectedHash,
  }
) {
  if (
    !Array.isArray(links) ||
    links.length !== expectedCount
  ) {
    failState("standings_result_links_invalid");
  }
  const linkIds = new Set();
  const matchupIds = new Set();
  const resultIds = new Set();
  const versionIds = new Set();
  let target = null;
  let sourceResultVersion = 0;
  const normalized = [];
  for (const link of links) {
    validateOutcome(
      link?.home_score_hundredths,
      link?.away_score_hundredths,
      link?.outcome
    );
    if (
      !UUID_PATTERN.test(link?.id || "") ||
      linkIds.has(link.id) ||
      !UUID_PATTERN.test(
        link.matchup_week_id || ""
      ) ||
      !UUID_PATTERN.test(link.matchup_id || "") ||
      matchupIds.has(link.matchup_id) ||
      !UUID_PATTERN.test(
        link.matchup_result_id || ""
      ) ||
      resultIds.has(link.matchup_result_id) ||
      !UUID_PATTERN.test(
        link.matchup_result_version_id || ""
      ) ||
      versionIds.has(
        link.matchup_result_version_id
      ) ||
      !Number.isSafeInteger(
        link.result_version_number
      ) ||
      link.result_version_number < 1 ||
      !participantIds.has(link.home_team_id) ||
      !participantIds.has(link.away_team_id) ||
      link.home_team_id === link.away_team_id ||
      !UUID_PATTERN.test(
        link.source_snapshot_id || ""
      ) ||
      !["calculated", "correction"].includes(
        link.source_type
      ) ||
      !isSafeTimestamp(
        link.result_created_at_ms
      )
    ) {
      failState("standings_result_links_invalid");
    }
    if (
      link.source_type === "calculated"
        ? link.result_version_number !== 1 ||
          link.actor_user_id !== null ||
          link.reason !== null ||
          link.supersedes_version_id !== null
        : !UUID_PATTERN.test(
            link.actor_user_id || ""
          ) ||
          typeof link.reason !== "string" ||
          link.reason.length < 1 ||
          link.reason.length > 500 ||
          link.reason !== link.reason.trim() ||
          FORBIDDEN_TEXT_PATTERN.test(
            link.reason
          ) ||
          !UUID_PATTERN.test(
            link.supersedes_version_id || ""
          )
    ) {
      failState("standings_result_links_invalid");
    }
    if (
      !Number.isSafeInteger(
        sourceResultVersion +
          link.result_version_number
      )
    ) {
      failState("standings_result_links_invalid");
    }
    sourceResultVersion +=
      link.result_version_number;
    linkIds.add(link.id);
    matchupIds.add(link.matchup_id);
    resultIds.add(link.matchup_result_id);
    versionIds.add(
      link.matchup_result_version_id
    );
    const copy = Object.freeze({ ...link });
    normalized.push(copy);
    if (link.matchup_result_id === resultId) {
      if (
        target !== null ||
        link.matchup_id !== matchup.matchup_id ||
        link.matchup_week_id !==
          matchup.matchup_week_id ||
        link.matchup_result_version_id !==
          currentVersion.result_version_id ||
        link.result_version_number !==
          currentVersion.version_number ||
        link.home_team_id !==
          matchup.home_team_id ||
        link.away_team_id !==
          matchup.away_team_id ||
        link.home_score_hundredths !==
          currentVersion.home_score_hundredths ||
        link.away_score_hundredths !==
          currentVersion.away_score_hundredths ||
        link.outcome !== currentVersion.outcome ||
        link.source_snapshot_id !==
          currentVersion.source_snapshot_id ||
        link.source_type !==
          currentVersion.source_type ||
        link.actor_user_id !==
          currentVersion.actor_user_id ||
        link.reason !== currentVersion.reason ||
        link.supersedes_version_id !==
          currentVersion.supersedes_version_id ||
        link.result_created_at_ms !==
          currentVersion.created_at_ms
      ) {
        failState(
          "corrected_result_link_invalid"
        );
      }
      target = copy;
    }
  }
  if (!target) {
    failState("corrected_result_link_invalid");
  }
  normalized.sort((left, right) =>
    left.matchup_id.localeCompare(
      right.matchup_id
    ) ||
    left.matchup_result_id.localeCompare(
      right.matchup_result_id
    )
  );
  const calculatedHash =
    calculateStandingsResultSetHash({
      leagueId,
      seasonId,
      standingsRuleVersion: String(
        standingsRuleVersion
      ),
      results: normalized.map((link) => ({
        matchupId: link.matchup_id,
        matchupResultId:
          link.matchup_result_id,
        resultVersionId:
          link.matchup_result_version_id,
        resultVersion:
          link.result_version_number,
      })),
    });
  if (calculatedHash !== expectedHash) {
    failState("canonical_result_set_hash_invalid");
  }
  return Object.freeze({
    links: Object.freeze(normalized),
    sourceResultVersion,
    target,
  });
}

function calculateRows(identities, links) {
  try {
    return calculateStandings({
      participants: identities.map(
        (identity) => ({
          team_id: identity.teamId,
          team_display_name:
            identity.teamDisplayName,
        })
      ),
      results: links.map((link) => ({
        home_team_id: link.home_team_id,
        away_team_id: link.away_team_id,
        home_score_hundredths:
          link.home_score_hundredths,
        away_score_hundredths:
          link.away_score_hundredths,
      })),
    });
  } catch (error) {
    failState(
      error?.code ||
        "standings_calculation_failed"
    );
  }
}

function inspectActiveFinalization(
  activeFinalization,
  {
    activeHistoryRow,
    leagueId,
    seasonId,
    resultId,
    matchup,
    currentVersion,
  }
) {
  const finalization =
    activeFinalization?.finalization;
  const snapshot = activeFinalization?.snapshot;
  const finalizationKeys = [
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
    "standings_operation_id",
    "idempotency_request_id",
    "replaces_finalization_id",
    "finalized_at_ms",
  ];
  if (
    !finalization ||
    finalizationKeys.some(
      (key) =>
        finalization[key] !==
        activeHistoryRow[key]
    ) ||
    finalization.status !== "final" ||
    !snapshot ||
    snapshot.snapshot_id !==
      finalization.standings_snapshot_id ||
    snapshot.snapshot_version !==
      finalization.finalization_version ||
    snapshot.snapshot_status !== "final" ||
    !Number.isSafeInteger(
      snapshot.source_result_version
    ) ||
    snapshot.source_result_version < 1 ||
    !isSafeTimestamp(snapshot.calculated_at_ms) ||
    !isSafeTimestamp(snapshot.created_at_ms) ||
    snapshot.calculated_at_ms !==
      finalization.finalized_at_ms
  ) {
    failState("active_finalization_invalid");
  }
  const identityEvidence = inspectIdentities(
    activeFinalization.identities,
    finalization.participant_count,
    snapshot.snapshot_id
  );
  const priorRows = inspectSnapshotRows(
    activeFinalization.rows,
    {
      snapshotId: snapshot.snapshot_id,
      identities: identityEvidence.identities,
      expectedCount:
        finalization.participant_count,
    }
  );
  const linkEvidence = inspectActiveLinks(
    activeFinalization.links,
    {
      leagueId,
      seasonId,
      resultId,
      matchup,
      currentVersion,
      standingsRuleVersion:
        finalization.standings_rule_version,
      expectedCount:
        finalization.expected_matchup_count,
      participantIds: identityEvidence.ids,
      expectedHash: finalization.result_set_hash,
    }
  );
  if (
    snapshot.source_result_version !==
      linkEvidence.sourceResultVersion
  ) {
    failState("active_finalization_invalid");
  }
  const calculatedPriorRows = calculateRows(
    identityEvidence.identities,
    linkEvidence.links
  );
  if (
    officialStandingsRowsChanged(
      priorRows,
      calculatedPriorRows
    )
  ) {
    failState("canonical_standings_rows_invalid");
  }
  return Object.freeze({
    finalization,
    snapshot,
    identities: identityEvidence.identities,
    links: linkEvidence.links,
    priorRows,
    sourceResultVersion:
      linkEvidence.sourceResultVersion,
  });
}

function inspectActiveMemberUserIds(
  value,
  actorUserId
) {
  if (!Array.isArray(value) || value.length < 1) {
    failState("active_members_invalid");
  }
  const ids = new Set();
  for (const userId of value) {
    if (
      !UUID_PATTERN.test(userId || "") ||
      ids.has(userId)
    ) {
      failState("active_members_invalid");
    }
    ids.add(userId);
  }
  if (!ids.has(actorUserId)) {
    fail("LEAGUE_COMMISSIONER_REQUIRED");
  }
  return Object.freeze([...ids].sort());
}

function auditClientMetadata(
  value,
  actorAuthority
) {
  let metadata = {};
  if (value !== null && value !== undefined) {
    if (
      typeof value !== "string" ||
      value.length < 2 ||
      value.length > 2_048
    ) {
      throw new TypeError(
        "matchup-result correction requires safe audit client metadata"
      );
    }
    try {
      metadata = JSON.parse(value);
    } catch {
      throw new TypeError(
        "matchup-result correction requires safe audit client metadata"
      );
    }
    if (!isPlainObject(metadata)) {
      throw new TypeError(
        "matchup-result correction requires safe audit client metadata"
      );
    }
  }
  return JSON.stringify({
    ...metadata,
    actorAuthority,
  });
}

function auditRecord({
  id,
  audit,
  authority,
  actorAuthority,
  authenticated,
  leagueId,
  nowMs,
}) {
  if (!isPlainObject(audit)) {
    throw new TypeError(
      "matchup-result correction requires audit context"
    );
  }
  return Object.freeze({
    id,
    event_type:
      MATCHUP_RESULT_CORRECTION_AUDIT_EVENT_TYPE,
    outcome: "success",
    actor_user_id: authority.actorUserId,
    target_user_id: null,
    league_id: leagueId,
    session_id: authenticated?.session?.id,
    request_correlation_id:
      audit.requestCorrelationId || null,
    reason_code: null,
    network_key_version:
      audit.networkKeyVersion || null,
    network_metadata_digest:
      audit.networkMetadataDigest || null,
    client_metadata_json:
      auditClientMetadata(
        audit.clientMetadataJson,
        actorAuthority
      ),
    unknown_account_digest: null,
    occurred_at_ms: nowMs,
  });
}

function buildReplacement({
  active,
  aggregate,
  actorUserId,
  correction,
  leagueId,
  seasonId,
  resultId,
  activeMemberUserIds,
  nextId,
}) {
  const nextVersionNumber =
    correction.versionNumber;
  const nextLinks = active.links.map((link) =>
    link.matchup_result_id === resultId
      ? Object.freeze({
          ...link,
          matchup_result_version_id:
            correction.resultVersionId,
          result_version_number:
            nextVersionNumber,
          home_score_hundredths:
            correction.homeScoreHundredths,
          away_score_hundredths:
            correction.awayScoreHundredths,
          outcome: correction.outcome,
          source_type: "correction",
          actor_user_id: actorUserId,
          reason: correction.reason,
          supersedes_version_id:
            correction.supersedesVersionId,
          result_created_at_ms:
            correction.createdAtMs,
        })
      : link
  );
  const calculatedRows = calculateRows(
    active.identities,
    nextLinks
  );
  const standingsRowsChanged =
    officialStandingsRowsChanged(
      active.priorRows,
      calculatedRows
    );
  const resultSetHash =
    calculateStandingsResultSetHash({
      leagueId,
      seasonId,
      standingsRuleVersion: String(
        active.finalization
          .standings_rule_version
      ),
      results: nextLinks.map((link) => ({
        matchupId: link.matchup_id,
        matchupResultId:
          link.matchup_result_id,
        resultVersionId:
          link.matchup_result_version_id,
        resultVersion:
          link.result_version_number,
      })),
    });
  const snapshotVersion =
    active.snapshot.snapshot_version + 1;
  const sourceResultVersion =
    active.sourceResultVersion + 1;
  if (
    !Number.isSafeInteger(snapshotVersion) ||
    !Number.isSafeInteger(sourceResultVersion) ||
    !Number.isSafeInteger(
      aggregate.season_version + 1
    )
  ) {
    failState("replacement_version_exhausted");
  }
  const snapshotId = nextId();
  const standingsOperationId = nextId();
  const finalizationId = nextId();
  return Object.freeze({
    snapshotId,
    snapshotVersion,
    sourceResultVersion,
    standingsOperationId,
    finalizationId,
    resultSetHash,
    standingsRuleVersion:
      active.finalization.standings_rule_version,
    expectedMatchupCount:
      active.finalization.expected_matchup_count,
    expectedWeekCount:
      active.finalization.expected_week_count,
    participantCount:
      active.finalization.participant_count,
    rows: Object.freeze(
      calculatedRows.map((row) =>
        Object.freeze({
          id: nextId(),
          teamId: row.teamId,
          rank: row.rank,
          wins: row.wins,
          losses: row.losses,
          ties: row.ties,
          standingsPoints:
            row.standingsPoints,
          fantasyPointsForHundredths:
            row.fantasyPointsForHundredths,
          fantasyPointsAgainstHundredths:
            row.fantasyPointsAgainstHundredths,
          fantasyPointsDifferentialHundredths:
            row.fantasyPointsDifferentialHundredths,
        })
      )
    ),
    links: Object.freeze(
      nextLinks.map((link) =>
        Object.freeze({
          id: nextId(),
          matchupWeekId:
            link.matchup_week_id,
          matchupId: link.matchup_id,
          matchupResultId:
            link.matchup_result_id,
          resultVersionId:
            link.matchup_result_version_id,
          resultVersionNumber:
            link.result_version_number,
        })
      )
    ),
    identities: Object.freeze(
      active.identities.map((identity) =>
        Object.freeze({
          id: nextId(),
          ...identity,
          logoContentBytes:
            identity.logoContentBytes === null
              ? null
              : Buffer.from(
                  identity.logoContentBytes
                ),
        })
      )
    ),
    standingsRowsChanged,
    notifications: Object.freeze(
      standingsRowsChanged
        ? activeMemberUserIds.map((userId) =>
            Object.freeze({
              id: nextId(),
              userId,
            })
          )
        : []
    ),
    outboxId: nextId(),
  });
}

function createMatchupResultCorrectionService({
  repositoryContext,
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "an immediate repository transaction boundary"
  );
  requireMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  for (const method of [
    "correct",
    "findCorrectionResult",
    "findIdempotency",
    "readCorrectionContext",
  ]) {
    requireMethod(
      repository,
      method,
      "a matchup-result correction repository"
    );
  }
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function correct({
    leagueId,
    seasonId,
    resultId,
    input,
    expectedResultVersion,
    idempotencyKey,
    authenticated,
    auditContext,
  } = {}) {
    const canonicalLeagueId =
      validateMatchupResultCorrectionLeagueId(
        leagueId
      );
    const canonicalSeasonId =
      validateMatchupResultCorrectionSeasonId(
        seasonId
      );
    const canonicalResultId =
      validateMatchupResultCorrectionResultId(
        resultId
      );
    const canonicalInput =
      validateMatchupResultCorrectionInput(input);
    const expectedVersion =
      validateMatchupResultCorrectionExpectedVersion(
        expectedResultVersion
      );
    const clientKey =
      validateMatchupResultCorrectionIdempotencyKey(
        idempotencyKey
      );
    const requestHash =
      matchupResultCorrectionRequestHash({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        resultId: canonicalResultId,
        expectedResultVersion: expectedVersion,
        input: canonicalInput,
      });

    try {
      return repositoryContext.transaction(() => {
        const authority =
        leagueAuthorization.requireCommissioner(
          authenticated,
          canonicalLeagueId
        );
      const actorAuthority =
        canonicalActorAuthority(authority);
      const existing = repository.findIdempotency({
        leagueId: canonicalLeagueId,
        actorUserId: authority.actorUserId,
        operation:
          MATCHUP_RESULT_CORRECTION_OPERATION,
        clientKey,
      });
      if (existing) {
        if (
          existing.league_id !==
            canonicalLeagueId ||
          existing.actor_user_id !==
            authority.actorUserId ||
          existing.operation !==
            MATCHUP_RESULT_CORRECTION_OPERATION ||
          existing.client_key !== clientKey ||
          existing.request_hash !== requestHash
        ) {
          fail("IDEMPOTENCY_KEY_REUSED");
        }
        if (
          !UUID_PATTERN.test(existing.id || "") ||
          existing.status !== "completed" ||
          existing.result_type !==
            MATCHUP_RESULT_CORRECTION_RESULT_TYPE ||
          !UUID_PATTERN.test(
            existing.result_id || ""
          ) ||
          !isSafeTimestamp(
            existing.completed_at_ms
          )
        ) {
          fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
        }
        const durable =
          repository.findCorrectionResult({
            leagueId: canonicalLeagueId,
            resultVersionId: existing.result_id,
          });
        inspectReplayEvidence(durable, {
          existing,
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
          resultId: canonicalResultId,
          expectedResultVersion: expectedVersion,
          actorUserId: authority.actorUserId,
          clientKey,
          requestHash,
        });
        return internalResult(
          safeCorrectionResult(durable),
          true
        );
      }

      const context = repository.readCorrectionContext({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        resultId: canonicalResultId,
      });
      if (!context) {
        fail("MATCHUP_RESULT_CORRECTION_NOT_FOUND");
      }
      const aggregate = inspectAggregate(
        context.aggregate,
        {
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
        }
      );
      const matchup = inspectMatchup(
        context.matchup
      );
      const currentVersion = inspectResultChain(
        context.result,
        context.versions,
        {
          resultId: canonicalResultId,
          matchup,
          expectedResultVersion:
            expectedVersion,
        }
      );
      const activeHistoryRow =
        (() => {
          if (
            !Number.isSafeInteger(
              context
                .canonicalFinalizationHistoryCount
            ) ||
            context
              .canonicalFinalizationHistoryCount <
              0 ||
            !Array.isArray(
              context.finalizations
            ) ||
            context
              .canonicalFinalizationHistoryCount !==
              context.finalizations.length
          ) {
            failState(
              "canonical_finalization_history_invalid"
            );
          }
          return inspectFinalizationHistory(
            context.finalizations,
            context.activeFinalization
          );
        })();
      if (
        activeHistoryRow === null &&
        (aggregate.season_status !== "active" ||
          aggregate.current_season_id !==
            canonicalSeasonId)
      ) {
        failState(
          "pre_final_season_state_invalid"
        );
      }
      const active =
        activeHistoryRow === null
          ? null
          : inspectActiveFinalization(
              context.activeFinalization,
              {
                activeHistoryRow,
                leagueId: canonicalLeagueId,
                seasonId: canonicalSeasonId,
                resultId: canonicalResultId,
                matchup,
                currentVersion,
              }
            );
      const activeMemberUserIds =
        active === null
          ? Object.freeze([])
          : inspectActiveMemberUserIds(
              context.activeMemberUserIds,
              authority.actorUserId
            );

      const nowMs = safeNow(clock);
      if (
        nowMs < currentVersion.created_at_ms ||
        nowMs < context.result.finalized_at_ms ||
        (active !== null &&
          nowMs <
            active.finalization.finalized_at_ms)
      ) {
        failState("correction_chronology_invalid");
      }
      const expiresAtMs =
        nowMs +
        MATCHUP_RESULT_CORRECTION_IDEMPOTENCY_LIFETIME_MS;
      if (!Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError(
          "matchup-result correction requires a safe idempotency expiry"
        );
      }
      const nextId =
        createSecureIdFactory(secureRandom);
      const nextVersionNumber =
        currentVersion.version_number + 1;
      if (
        !Number.isSafeInteger(nextVersionNumber)
      ) {
        failState("result_version_exhausted");
      }
      const correction = Object.freeze({
        resultVersionId: nextId(),
        matchupOperationId: nextId(),
        versionNumber: nextVersionNumber,
        supersedesVersionId:
          currentVersion.result_version_id,
        sourceSnapshotId:
          currentVersion.source_snapshot_id,
        homeTeamId: matchup.home_team_id,
        awayTeamId: matchup.away_team_id,
        homeScoreHundredths:
          canonicalInput.homeScoreHundredths,
        awayScoreHundredths:
          canonicalInput.awayScoreHundredths,
        outcome: canonicalInput.outcome,
        reason: canonicalInput.reason,
        createdAtMs: nowMs,
      });
      const replacement =
        active === null
          ? null
          : buildReplacement({
              active,
              aggregate,
              actorUserId:
                authority.actorUserId,
              correction,
              leagueId: canonicalLeagueId,
              seasonId: canonicalSeasonId,
              resultId: canonicalResultId,
              activeMemberUserIds,
              nextId,
            });
      const idempotency = Object.freeze({
        id: nextId(),
        clientKey,
        requestHash,
        expiresAtMs,
      });
      const audit = auditRecord({
        id: nextId(),
        audit: auditContext,
        authority,
        actorAuthority,
        authenticated,
        leagueId: canonicalLeagueId,
        nowMs,
      });
      const preFinalOutboxId =
        replacement === null ? nextId() : null;
      const command = Object.freeze({
        leagueId: canonicalLeagueId,
        seasonId: canonicalSeasonId,
        resultId: canonicalResultId,
        expectedResultVersion: expectedVersion,
        expectedSeasonVersion:
          aggregate.season_version,
        actorUserId: authority.actorUserId,
        actorMembershipId:
          authority.membershipId,
        actorAuthority,
        idempotency,
        correction,
        replacement,
        preFinalOutboxId,
        audit,
        nowMs,
      });

        const durable = repository.correct(command);
        const projected =
          safeCorrectionResult(durable);
        inspectDurableEvidence(durable, {
          leagueId: canonicalLeagueId,
          seasonId: canonicalSeasonId,
          resultId: canonicalResultId,
          expectedResultVersion: expectedVersion,
          actorUserId: authority.actorUserId,
          clientKey,
          requestHash,
        });
        const durableReplacement =
          projected.result.standingsReplacement;
        if (
          (replacement === null) !==
            (durableReplacement === null) ||
          (replacement !== null &&
            (durableReplacement.snapshotVersion !==
              replacement.snapshotVersion ||
              durableReplacement.resultSetHash !==
                replacement.resultSetHash ||
              durableReplacement
                .standingsRowsChanged !==
                replacement.standingsRowsChanged))
        ) {
          fail(
            "MATCHUP_RESULT_CORRECTION_RESULT_UNAVAILABLE"
          );
        }
        const replayed =
          durable.evidence.idempotencyRequestId !==
            idempotency.id ||
          durable.result_version_id !==
            correction.resultVersionId;
        return internalResult(projected, replayed);
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            MatchupResultCorrectionServiceError ||
          candidate?.code ===
            "MATCHUP_RESULT_CORRECTION_INPUT_INVALID" ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) throw applicationError;
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_VERSION_CONFLICT"
        )
      ) {
        fail(
          "MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED",
          {
            details: {
              currentVersion: null,
              refetch: true,
            },
          }
        );
      }
      if (
        chain.some(
          (candidate) =>
            candidate?.code ===
            "REPOSITORY_RECORD_NOT_FOUND"
        )
      ) {
        fail(
          "MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED",
          {
            details: {
              currentVersion: null,
              refetch: true,
            },
          }
        );
      }
      const constraint = chain.find(
        (candidate) =>
          candidate?.code ===
            "REPOSITORY_CONSTRAINT"
      );
      if (constraint) {
        if (
          constraint?.details?.tableName ===
          "idempotency_requests"
        ) {
          fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
        }
        failState("repository_state_changed");
      }
      throw error;
    }
  }

  return Object.freeze({ correct });
}

module.exports = {
  MATCHUP_RESULT_CORRECTION_AUDIT_EVENT_TYPE,
  MATCHUP_RESULT_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
  MATCHUP_RESULT_CORRECTION_OPERATION,
  MATCHUP_RESULT_CORRECTION_RESULT_TYPE,
  MatchupResultCorrectionServiceError,
  createMatchupResultCorrectionService,
  matchupResultCorrectionRequestHash,
  safeCorrectionResult,
};
