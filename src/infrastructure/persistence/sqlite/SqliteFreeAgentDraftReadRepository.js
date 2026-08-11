"use strict";

const {
  createHash,
} = require("node:crypto");

const {
  FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
  deriveFreeAgentDraftViewerPhase,
  parseFreeAgentDraftOccurrenceKey,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
  validateFreeAgentDraftReadinessAttemptEvidence,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);
const {
  serializeCanonicalJsonV1,
} = require(
  "../../../domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteLeagueLifecycleTransitionRepository,
} = require(
  "./SqliteLeagueLifecycleTransitionRepository"
);
const {
  normalizeCandidateEligiblePlayerName,
} = require(
  "../../../domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);
const {
  validateTeamName,
} = require("../../../domain/leagues/teamPolicy");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;
const DEFAULT_PUBLISHED_PAGE_SIZE = 50;
const MAXIMUM_PUBLISHED_PAGE_SIZE = 100;
const MAXIMUM_PUBLISHED_SEARCH_CODE_POINTS = 200;
const MAXIMUM_PUBLISHED_CURSOR_CODE_POINTS = 1_024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_PLAYER_NAME_SQL_FUNCTION =
  "hundo_fad_result_player_name_v1";
const ALLOCATION_STATUSES = Object.freeze([
  "pending",
  "automatic_award",
  "restricted_scheduled",
  "restricted_active",
  "restricted_fallback_open",
  "restricted_resolved",
  "fallback_open_resolved",
  "no_valid_offer",
  "invalid",
  "correction_required",
]);
const ACTIONABLE_RECOVERY_KINDS = Object.freeze([
  "deadline_retry",
  "allocation_retry",
  "restricted_activation",
  "queued_nomination_activation",
  "fallback_activation",
  "auction_resolution",
  "rollover_finalize",
  "completion",
]);

const FREE_AGENT_DRAFT_READ_REPOSITORY_CODES =
  Object.freeze({
    authorizationDenied:
      "FAD_READ_AUTHORIZATION_DENIED",
    cardsNotPublished:
      "FAD_CARDS_NOT_PUBLISHED",
    candidateCardNotFound:
      "CANDIDATE_CARD_NOT_FOUND",
  });

const FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS =
  Object.freeze([
    "readOpeningPreflightContext",
    "readNavigation",
    "readReadiness",
    "readOverview",
    "readPublishedCardSummaries",
    "readPublishedCardHistory",
    "readAllocationResults",
  ]);

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function selectRow(row, fields) {
  if (row === null || row === undefined) return null;
  return Object.fromEntries(
    fields.map(([output, stored]) => [
      output,
      row[stored],
    ])
  );
}

function selectRows(rows, fields) {
  return rows.map((row) => selectRow(row, fields));
}

function freeze(value) {
  return Object.freeze(value);
}

function allowedCapability() {
  return freeze({ allowed: true, reasonCode: null });
}

function blockedCapability(reasonCode) {
  return freeze({ allowed: false, reasonCode });
}

function teamProjection(row) {
  if (
    !row ||
    !UUID_PATTERN.test(row.team_id || "") ||
    typeof row.team_name !== "string" ||
    typeof row.primary_colour !== "string" ||
    typeof row.secondary_colour !== "string" ||
    typeof row.pattern_template !== "string"
  ) {
    incompatible(
      "A safe FAD team projection is unavailable."
    );
  }
  return freeze({
    teamId: row.team_id,
    name: row.team_name,
    primaryColour: row.primary_colour,
    secondaryColour: row.secondary_colour,
    tertiaryColour: row.tertiary_colour,
    patternTemplate: row.pattern_template,
    logoReference: row.logo_reference,
  });
}

function playerProjection(row) {
  if (
    row.correction_position_count > 1 ||
    row.source_position_count > 1
  ) {
    incompatible(
      "A FAD player has ambiguous current position evidence."
    );
  }
  const positionGroup =
    row.correction_position_count === 1
      ? row.corrected_position_group
      : row.source_position_count === 1
        ? row.source_position_group
        : null;
  if (
    !UUID_PATTERN.test(row.player_id || "") ||
    typeof row.player_full_name !== "string" ||
    !["F", "D"].includes(positionGroup)
  ) {
    incompatible(
      "A safe FAD player projection is unavailable."
    );
  }
  return freeze({
    playerId: row.player_id,
    fullName: row.player_full_name,
    positionGroup,
  });
}

function snapshotPlayerProjection(row) {
  if (
    !UUID_PATTERN.test(row.player_id || "") ||
    typeof row.player_full_name !== "string" ||
    !["F", "D"].includes(
      row.effective_position_group
    )
  ) {
    incompatible(
      "A safe published Candidate player projection is unavailable."
    );
  }
  return freeze({
    playerId: row.player_id,
    fullName: row.player_full_name,
    positionGroup:
      row.effective_position_group,
  });
}

function candidateSlotKey(group, number) {
  if (
    !["F", "D", "B"].includes(group) ||
    !Number.isSafeInteger(number) ||
    (
      group === "F" &&
      (number < 1 || number > 12)
    ) ||
    (
      group === "D" &&
      (number < 1 || number > 6)
    ) ||
    (
      group === "B" &&
      (number < 1 || number > 4)
    )
  ) {
    incompatible(
      "A canonical Candidate Card slot is unavailable."
    );
  }
  return `${group}${String(number).padStart(
    2,
    "0"
  )}`;
}

function publishedValidation(row) {
  if (row.occupant_kind === "empty") {
    return freeze({
      status: "valid",
      codes: freeze([]),
    });
  }
  const codes = [
    row.conflict_code,
    row.validation_code,
  ].filter(
    (code, index, values) =>
      code !== null &&
      values.indexOf(code) === index
  );
  const status =
    row.row_kind === "conflict"
      ? "invalid"
      : row.occupant_kind === "carryover"
        ? "valid"
        : row.eligibility_status;
  if (
    !["valid", "warning", "invalid"].includes(
      status
    )
  ) {
    incompatible(
      "Published Candidate validation is noncanonical."
    );
  }
  return freeze({
    status,
    codes: freeze(codes),
  });
}

function publishedLastEditor(row) {
  if (row.occupant_kind === "empty") return null;
  if (row.last_edited_by_authority === "system") {
    if (
      row.last_edited_by_user_id !== null ||
      row.editor_display_name !== null
    ) {
      incompatible(
        "Published Candidate system-editor evidence is invalid."
      );
    }
    return freeze({
      userId: null,
      displayName: null,
      authority: "system",
    });
  }
  if (
    !UUID_PATTERN.test(
      row.last_edited_by_user_id || ""
    ) ||
    typeof row.editor_display_name !== "string" ||
    row.editor_display_name.length < 1 ||
    ![
      "manager",
      "commissioner",
      "platform_administrator_as_commissioner",
    ].includes(row.last_edited_by_authority)
  ) {
    incompatible(
      "Published Candidate editor evidence is invalid."
    );
  }
  return freeze({
    userId: row.last_edited_by_user_id,
    displayName: row.editor_display_name,
    authority: row.last_edited_by_authority,
  });
}

function publishedSlotCapabilities() {
  const denied = blockedCapability("PHASE_CLOSED");
  return freeze({
    addCandidate: denied,
    editCandidate: denied,
    moveCandidate: denied,
    moveCarryover: denied,
    removeCandidate: denied,
  });
}

function helpRequestStatus(row, nowMs) {
  if (row.help_request_id === null) {
    return "not_requested";
  }
  if (row.help_request_status === "expired") {
    return "expired";
  }
  if (row.help_request_status !== "active") {
    incompatible(
      "A Candidate Card has an unknown help-request status."
    );
  }
  return nowMs < row.help_expires_at_ms
    ? "active"
    : "expired";
}

function cardSummary(row, nowMs) {
  return {
    teamId: row.team_id,
    team: teamProjection(row),
    cardId: row.card_id,
    cardVersion: row.card_version,
    lifecycleStatus: row.card_status,
    completenessCode: row.completeness_code,
    missingMandatoryCount:
      row.missing_mandatory_count,
    conflictCount: row.structural_conflict_count,
    capStatus: row.cap_status,
    allocationEligibility:
      row.allocation_eligibility,
    helpRequestStatus: helpRequestStatus(row, nowMs),
  };
}

function cardDescriptor(row, mode, evidence) {
  return freeze({
    mode,
    seasonId: row.season_id,
    fadId: row.fad_id,
    teamId: row.team_id,
    cardId: row.card_id,
    authorizationEvidence: evidence,
  });
}

function viewerPhase(row, nowMs) {
  try {
    return deriveFreeAgentDraftViewerPhase({
      status: row?.status ?? null,
      nowMs,
      cardsOpenedAtMs: row?.opened_at_ms ?? null,
      helpOpensAtMs: row?.help_opens_at_ms ?? null,
      candidateDeadlineAtMs:
        row?.candidate_deadline_at_ms ?? null,
    });
  } catch (error) {
    incompatible(
      "Persisted FAD viewer-clock evidence is invalid.",
      error
    );
  }
}

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function notFound(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.recordNotFound,
    message
  );
}

function exactObject(value, fields, message) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).sort().join("|") !==
      [...fields].sort().join("|")
  ) {
    invalid(message);
  }
}

function containsNonWhitespaceControl(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    const isControl =
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 8_232 ||
      codePoint === 8_233;
    return isControl && !/\s/u.test(character);
  });
}

function normalizeSearchText(value) {
  if (
    typeof value !== "string" ||
    containsNonWhitespaceControl(value)
  ) {
    invalid(
      "A canonical FAD result search is required."
    );
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (
    Array.from(normalized).length >
    MAXIMUM_PUBLISHED_SEARCH_CODE_POINTS
  ) {
    invalid(
      "A canonical FAD result search is required."
    );
  }
  return normalized;
}

function normalizePageLimit(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_PUBLISHED_PAGE_SIZE
  ) {
    invalid(
      "A bounded FAD published-read limit is required."
    );
  }
  return value;
}

function cursorFilterSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function decodePublishedCursor(
  value,
  filter,
  identityField,
  normalizeSortName =
    normalizeCandidateEligiblePlayerName
) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Array.from(value).length >
      MAXIMUM_PUBLISHED_CURSOR_CODE_POINTS ||
    !BASE64URL_PATTERN.test(value)
  ) {
    invalid(
      "A canonical FAD published-read cursor is required."
    );
  }
  let parsed;
  try {
    const json = Buffer.from(
      value,
      "base64url"
    ).toString("utf8");
    if (
      Buffer.from(json, "utf8").toString(
        "base64url"
      ) !== value
    ) {
      invalid(
        "A canonical FAD published-read cursor is required."
      );
    }
    parsed = JSON.parse(json);
  } catch (error) {
    if (
      error?.code ===
      REPOSITORY_ERROR_CODES.argumentInvalid
    ) {
      throw error;
    }
    invalid(
      "A canonical FAD published-read cursor is required."
    );
  }
  exactObject(
    parsed,
    [
      "filterSha256",
      identityField,
      "sortName",
      "version",
    ],
    "A canonical FAD published-read cursor is required."
  );
  if (
    parsed.version !== 1 ||
    !SHA256_PATTERN.test(
      parsed.filterSha256 || ""
    ) ||
    parsed.filterSha256 !==
      cursorFilterSha256(filter) ||
    !UUID_PATTERN.test(
      parsed[identityField] || ""
    )
  ) {
    invalid(
      "A canonical FAD published-read cursor is required."
    );
  }
  let sortName;
  try {
    sortName = normalizeSortName(parsed.sortName);
  } catch {
    invalid(
      "A canonical FAD published-read cursor is required."
    );
  }
  if (sortName !== parsed.sortName) {
    invalid(
      "A canonical FAD published-read cursor is required."
    );
  }
  return freeze({
    sortName,
    [identityField]: parsed[identityField],
  });
}

function encodePublishedCursor(
  filter,
  sortName,
  identityField,
  identityValue
) {
  return Buffer.from(
    JSON.stringify({
      filterSha256:
        cursorFilterSha256(filter),
      [identityField]: identityValue,
      sortName,
      version: 1,
    }),
    "utf8"
  ).toString("base64url");
}

function normalizedTeamSortName(value) {
  try {
    return validateTeamName(value).nameNormalized;
  } catch (error) {
    incompatible(
      "A safe FAD team sort name is unavailable.",
      error
    );
  }
}

function parseJsonArray(value, description) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new TypeError(description);
    }
    return parsed;
  } catch (error) {
    incompatible(description, error);
  }
}

function stableId(value) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(
      "A canonical Free Agent Draft read identifier is required."
    );
  }
  return value;
}

function nullableStableId(value) {
  return value === null ? null : stableId(value);
}

function safeTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAXIMUM_TIMESTAMP_MS
  ) {
    invalid(
      "A safe Free Agent Draft read timestamp is required."
    );
  }
  return value;
}

function normalizeOpeningInput(input) {
  exactObject(
    input,
    ["leagueId", "seasonId"],
    "An exact FAD opening-preflight read input is required."
  );
  return Object.freeze({
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
  });
}

function normalizeViewerInput(
  input,
  fields,
  description
) {
  exactObject(input, fields, description);
  return {
    leagueId: stableId(input.leagueId),
    viewerUserId: stableId(input.viewerUserId),
    viewerMembershipId: stableId(
      input.viewerMembershipId
    ),
    nowMs: safeTimestamp(input.nowMs),
  };
}

function normalizeNavigationInput(input) {
  const normalized = normalizeViewerInput(
    input,
    [
      "leagueId",
      "viewerUserId",
      "viewerMembershipId",
      "nowMs",
      "rosterSeasonId",
      "rosterTeamId",
    ],
    "An exact FAD navigation read input is required."
  );
  const rosterSeasonId = nullableStableId(
    input.rosterSeasonId
  );
  const rosterTeamId = nullableStableId(
    input.rosterTeamId
  );
  if (
    (rosterSeasonId === null) !==
    (rosterTeamId === null)
  ) {
    invalid(
      "FAD roster navigation requires both season and team identifiers or neither."
    );
  }
  return Object.freeze({
    ...normalized,
    rosterSeasonId,
    rosterTeamId,
  });
}

function normalizeReadinessInput(input) {
  return Object.freeze({
    ...normalizeViewerInput(
      input,
      [
        "leagueId",
        "seasonId",
        "viewerUserId",
        "viewerMembershipId",
        "nowMs",
      ],
      "An exact FAD readiness read input is required."
    ),
    seasonId: stableId(input.seasonId),
  });
}

function normalizeOverviewInput(input) {
  return Object.freeze({
    ...normalizeViewerInput(
      input,
      [
        "leagueId",
        "fadId",
        "viewerUserId",
        "viewerMembershipId",
        "nowMs",
      ],
      "An exact FAD overview read input is required."
    ),
    fadId: stableId(input.fadId),
  });
}

function normalizePublishedBase(
  input,
  fields,
  description
) {
  const normalized = normalizeViewerInput(
    input,
    fields,
    description
  );
  return {
    ...normalized,
    fadId: stableId(input.fadId),
  };
}

function normalizePublishedSummaryInput(input) {
  const normalized = normalizePublishedBase(
    input,
    [
      "leagueId",
      "fadId",
      "viewerUserId",
      "viewerMembershipId",
      "nowMs",
      "query",
    ],
    "An exact published Candidate Card collection input is required."
  );
  exactObject(
    input.query,
    ["cursor", "limit"],
    "An exact published Candidate Card query is required."
  );
  const limit = normalizePageLimit(
    input.query.limit
  );
  const filter = freeze({
    fadId: normalized.fadId,
    leagueId: normalized.leagueId,
    limit,
  });
  return freeze({
    ...normalized,
    query: freeze({
      limit,
      cursor: decodePublishedCursor(
        input.query.cursor,
        filter,
        "teamId",
        normalizedTeamSortName
      ),
      filter,
    }),
  });
}

function normalizePublishedHistoryInput(input) {
  return freeze({
    ...normalizePublishedBase(
      input,
      [
        "leagueId",
        "fadId",
        "teamId",
        "viewerUserId",
        "viewerMembershipId",
        "nowMs",
      ],
      "An exact published Candidate Card history input is required."
    ),
    teamId: stableId(input.teamId),
  });
}

function normalizeAllocationResultsInput(input) {
  const normalized = normalizePublishedBase(
    input,
    [
      "leagueId",
      "fadId",
      "viewerUserId",
      "viewerMembershipId",
      "nowMs",
      "query",
    ],
    "An exact FAD allocation-result collection input is required."
  );
  exactObject(
    input.query,
    ["cursor", "limit", "q", "status"],
    "An exact FAD allocation-result query is required."
  );
  const limit = normalizePageLimit(
    input.query.limit
  );
  const q = normalizeSearchText(input.query.q);
  const status = input.query.status;
  if (
    status !== null &&
    !ALLOCATION_STATUSES.includes(status)
  ) {
    invalid(
      "A canonical FAD allocation status is required."
    );
  }
  const filter = freeze({
    fadId: normalized.fadId,
    leagueId: normalized.leagueId,
    limit,
    q,
    status,
  });
  return freeze({
    ...normalized,
    query: freeze({
      q,
      status,
      limit,
      cursor: decodePublishedCursor(
        input.query.cursor,
        filter,
        "playerId"
      ),
      filter,
    }),
  });
}

function createSqliteFreeAgentDraftReadRepository({
  database,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function"
  ) {
    throw new TypeError(
      "createSqliteFreeAgentDraftReadRepository requires an opened database"
    );
  }

  let openingSeasonStatement;
  let openingLeagueSettingsStatement;
  let openingReadinessStatement;
  let openingReadinessJobStatement;
  let openingExistingFadStatement;
  let openingScheduleStatement;
  let openingScheduleOperationStatement;
  let openingScheduleJobBindingsStatement;
  let openingWeekOneStatement;
  let openingPriorSeasonStatement;
  let openingPriorRolloverStatement;
  let openingPriorRolloverItemsStatement;
  let openingEntryDraftStatement;
  let openingExemptionStatement;
  let openingTeamsStatement;
  let openingManagersStatement;
  let openingOwnershipsStatement;
  let openingContractsStatement;
  let openingAllContractsStatement;
  let openingContractYearsStatement;
  let openingAllContractYearsStatement;
  let openingRosterOrderSetsStatement;
  let openingRosterOrderEntriesStatement;
  let openingRetentionObligationsStatement;
  let openingRetentionYearsStatement;
  let openingBuyoutObligationsStatement;
  let openingBuyoutYearsStatement;
  let openingPriorContractYearsStatement;
  let openingPriorRetentionYearsStatement;
  let openingPriorBuyoutYearsStatement;
  let openingLeaguePositionsStatement;
  let openingPlayerSourcesStatement;
  let viewerAuthorityStatement;
  let readinessStatement;
  let readinessAttemptStatement;
  let readinessJobStatement;
  let currentFadStatement;
  let fadByIdStatement;
  let managedCardsStatement;
  let allCardsStatement;
  let rosterCardStatement;
  let nextRolloverStatement;
  let competitionWeekOneStatement;
  let overviewCountsStatement;
  let recoveryRowsStatement;
  let completionScheduleRecoveryStatement;
  let queuedNominationsStatement;
  let restrictedManagerActionsStatement;
  let rapidAuctionsStatement;
  let publishedSummaryPageStatement;
  let publishedSnapshotCountStatement;
  let publishedSnapshotStatement;
  let publishedSnapshotEntriesStatement;
  let publishedInterventionsStatement;
  let allocationByPlayerStatement;
  let allocationOfferEventStatement;
  let allocationResultPageStatement;
  let allocationOffersStatement;
  let allocationWinnerStatement;
  let allocationAuctionsStatement;
  let allocationParticipantsStatement;
  let allocationDrawsStatement;
  let allocationRecoveryStatement;

  const lifecycleReadRepository =
    createSqliteLeagueLifecycleTransitionRepository({
      database,
    });

  function unique(statement, parameters, description) {
    const rows = statement.all(parameters);
    if (rows.length > 1) {
      incompatible(`${description} is ambiguous.`);
    }
    return rows[0] || null;
  }

  function requireViewerAuthority(input) {
    const row = unique(
      viewerAuthorityStatement,
      input,
      "The FAD viewer membership"
    );
    if (
      !row ||
      row.user_status !== "active" ||
      row.membership_status !== "active" ||
      row.league_status === "deleted"
    ) {
      throw repositoryError(
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
          .authorizationDenied,
        "Current active league membership is required to read FAD state."
      );
    }
    const currentCommissioner =
      row.commissioner_membership_id ===
        input.viewerMembershipId &&
      row.permission_category === "commissioner";
    return freeze({
      ...row,
      administrative:
        currentCommissioner ||
        row.is_platform_administrator === 1,
    });
  }

  function requireAdministrativeAuthority(
    input,
    authority
  ) {
    if (!authority.administrative) {
      throw repositoryError(
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
          .authorizationDenied,
        "Current commissioner authority is required to read FAD readiness."
      );
    }
  }

  function requirePublishedFad(input) {
    const fad = unique(
      fadByIdStatement,
      input,
      "The published FAD"
    );
    if (!fad) {
      notFound(
        "The scoped Free Agent Draft was not found."
      );
    }
    if (fad.deadline_locked_at_ms === null) {
      throw repositoryError(
        FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
          .cardsNotPublished,
        "Candidate Cards are not published."
      );
    }
    return fad;
  }

  function requireUniqueTeamRows(rows, description) {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.team_id)) {
        incompatible(`${description} is ambiguous.`);
      }
      seen.add(row.team_id);
    }
    return rows;
  }

  function readManagedCards(input, fadId) {
    return requireUniqueTeamRows(
      managedCardsStatement.all({
        ...input,
        fadId,
      }),
      "A managed Candidate Card"
    );
  }

  function readAllCards(input, fad) {
    const rows = requireUniqueTeamRows(
      allCardsStatement.all({
        leagueId: input.leagueId,
        fadId: fad.id,
      }),
      "A FAD Candidate Card"
    );
    if (
      rows.length !== fad.participating_team_count
    ) {
      incompatible(
        "The FAD Candidate Card participant coverage is incomplete."
      );
    }
    return rows;
  }

  function readCompetitionWeek(input, fad) {
    const week = unique(
      competitionWeekOneStatement,
      {
        leagueId: input.leagueId,
        seasonId: fad.season_id,
        weekId:
          fad.current_competition_first_matchup_week_id,
      },
      "The current competition Week 1"
    );
    if (!week || week.sequence !== 1) {
      incompatible(
        "The current competition Week 1 is unavailable."
      );
    }
    return week;
  }

  function readinessAttemptRecord(row) {
    if (!row) return null;
    try {
      return validateFreeAgentDraftReadinessAttemptEvidence({
        id: row.id,
        leagueId: row.league_id,
        seasonId: row.season_id,
        readinessOperationId:
          row.readiness_operation_id,
        jobRunId: row.job_run_id,
        attemptNumber: row.attempt_number,
        observedReadinessVersion:
          row.observed_readiness_version,
        outcome: row.outcome,
        observedAtMs: row.observed_at_ms,
        recordedAtMs: row.recorded_at_ms,
        projectionJson: row.projection_json,
        projectionSha256: row.projection_sha256,
        version: row.version,
      });
    } catch (error) {
      incompatible(
        "Persisted FAD readiness attempt evidence is noncanonical.",
        error
      );
    }
  }

  function latestReadinessAttempt(scope, readiness) {
    const rows = readinessAttemptStatement.all({
      ...scope,
      operationId: readiness.id,
    });
    const attempt = readinessAttemptRecord(rows[0] || null);
    if (
      attempt &&
      (
        attempt.leagueId !== scope.leagueId ||
        attempt.seasonId !== scope.seasonId ||
        attempt.readinessOperationId !== readiness.id ||
        attempt.jobRunId !== readiness.job_run_id
      )
    ) {
      incompatible(
        "The latest FAD readiness attempt has split identity."
      );
    }
    if (
      ["blocked", "succeeded"].includes(
        readiness.status
      ) &&
      (
        !attempt ||
        attempt.attemptNumber !==
          readiness.attempt_count ||
        attempt.outcome !== readiness.status
      )
    ) {
      incompatible(
        "Terminal FAD readiness is missing its latest immutable attempt."
      );
    }
    if (
      readiness.status === "running" &&
      attempt &&
      ![
        readiness.attempt_count,
        readiness.attempt_count - 1,
      ].includes(attempt.attemptNumber)
    ) {
      incompatible(
        "Running FAD readiness has an invalid latest attempt number."
      );
    }
    if (
      readiness.status === "pending" && attempt
    ) {
      incompatible(
        "Pending FAD readiness cannot have completed attempt evidence."
      );
    }
    return attempt;
  }

  function canonicalReadinessJob(
    readiness,
    job,
    attempt,
    { currentSeasonId, nowMs }
  ) {
    if (!job || !attempt) return false;
    let blockers;
    let occurrence;
    try {
      blockers =
        normalizeFreeAgentDraftReadinessInternalDiagnostics(
          JSON.parse(readiness.blockers_json)
        );
      occurrence = parseFreeAgentDraftOccurrenceKey(
        job.occurrence_key
      );
    } catch {
      return false;
    }
    const triggerBindingMatches =
      occurrence.type === "readiness" &&
      occurrence.leagueId === readiness.league_id &&
      occurrence.seasonId === readiness.season_id &&
      (
        (
          readiness.trigger_kind ===
            "entry_draft_completed" &&
          readiness.entry_draft_id ===
            occurrence.triggerResourceId &&
          readiness.setup_exemption_id === null
        ) ||
        (
          readiness.trigger_kind ===
            "no_draft_initial_season2" &&
          readiness.setup_exemption_id ===
            occurrence.triggerResourceId &&
          readiness.entry_draft_id === null
        ) ||
        (
          readiness.trigger_kind ===
            "no_draft_inaugural" &&
          occurrence.triggerResourceId ===
            readiness.season_id &&
          readiness.entry_draft_id === null &&
          readiness.setup_exemption_id === null
        )
      );
    return (
      currentSeasonId === readiness.season_id &&
      triggerBindingMatches &&
      readiness.status === "blocked" &&
      readiness.attempt_count >= 1 &&
      readiness.attempt_count === attempt.attemptNumber &&
      attempt.outcome === "blocked" &&
      attempt.observedReadinessVersion + 1 ===
        readiness.version &&
      readiness.job_run_id === job.id &&
      readiness.readiness_occurrence_key ===
        job.occurrence_key &&
      readiness.season_id === job.season_id &&
      job.job_type === "fad_readiness" &&
      job.status === "failed" &&
      job.attempt_count === readiness.attempt_count &&
      readiness.version === job.version &&
      readiness.updated_at_ms === job.updated_at_ms &&
      job.scheduled_for_ms === readiness.created_at_ms &&
      job.created_at_ms === readiness.created_at_ms &&
      job.lease_owner === null &&
      job.lease_token === null &&
      job.lease_expires_at_ms === null &&
      readiness.lease_owner === null &&
      readiness.lease_token === null &&
      readiness.lease_expires_at_ms === null &&
      Array.isArray(blockers) &&
      blockers.length >= 1 &&
      serializeCanonicalJsonV1(blockers) ===
        readiness.blockers_json &&
      readiness.created_fad_id === null &&
      readiness.reminder_job_run_id === null &&
      readiness.deadline_job_run_id === null &&
      readiness.cards_opened_activity_id === null &&
      readiness.cards_opened_outbox_event_id === null &&
      readiness.matchup_schedule_version_before === null &&
      readiness.matchup_schedule_version_after === null &&
      readiness.schedule_recovery_id === null &&
      Number.isSafeInteger(readiness.started_at_ms) &&
      Number.isSafeInteger(readiness.terminal_at_ms) &&
      Number.isSafeInteger(readiness.next_retry_at_ms) &&
      readiness.terminal_at_ms >= readiness.started_at_ms &&
      readiness.next_retry_at_ms > readiness.terminal_at_ms &&
      readiness.updated_at_ms === readiness.terminal_at_ms &&
      job.started_at_ms === readiness.started_at_ms &&
      job.completed_at_ms === readiness.terminal_at_ms &&
      nowMs > job.completed_at_ms &&
      job.result_json === null &&
      job.last_error_code === "FAD_READINESS_BLOCKED" &&
      job.next_attempt_at_ms === readiness.next_retry_at_ms &&
      job.updated_at_ms === readiness.updated_at_ms
    );
  }

  try {
    database.function(
      RESULT_PLAYER_NAME_SQL_FUNCTION,
      { deterministic: true },
      (value) => {
        try {
          return normalizeCandidateEligiblePlayerName(
            value
          );
        } catch {
          return null;
        }
      }
    );
    openingSeasonStatement = database.prepare(`
      SELECT
        leagues.id AS league_id,
        leagues.status AS league_status,
        leagues.timezone,
        leagues.current_season_id,
        leagues.commissioner_membership_id,
        leagues.version AS league_version,
        seasons.id AS season_id,
        seasons.label AS season_label,
        seasons.nhl_season_key,
        seasons.status AS season_status,
        seasons.regular_season_starts_at_ms,
        seasons.regular_season_ends_at_ms,
        seasons.fantasy_playoffs_start_at_ms,
        seasons.fantasy_playoffs_end_at_ms,
        seasons.free_agent_draft_completed_at_ms,
        seasons.version AS season_version
      FROM leagues
      JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = @seasonId
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    openingLeagueSettingsStatement = database.prepare(`
      SELECT
        league_id,
        salary_cap_cents,
        maximum_teams,
        active_forward_slots,
        active_defence_slots,
        bench_slots,
        maximum_bench_aav_cents,
        injured_reserve_slots,
        prospect_slots_unlimited,
        version
      FROM league_settings
      WHERE league_id = @leagueId
      LIMIT 2
    `);
    openingReadinessStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_operations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
    openingReadinessJobStatement = database.prepare(`
      SELECT *
      FROM job_runs
      WHERE league_id = @leagueId
        AND id = @jobRunId
      LIMIT 2
    `);
    openingExistingFadStatement = database.prepare(`
      SELECT id AS fad_id, status, version
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
    openingScheduleStatement = database.prepare(`
      SELECT
        schedule_operation_id AS operation_id,
        schedule_version AS version,
        version AS generation_version,
        week_one_matchup_week_id AS week_id,
        week_one_starts_at_ms AS starts_at_ms,
        created_at_ms
      FROM season_matchup_schedule_generations
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND status = 'current'
      ORDER BY schedule_version
      LIMIT 2
    `);
    openingScheduleOperationStatement = database.prepare(`
      SELECT
        operation.id AS operation_id,
        operation.season_id,
        operation.operation_type,
        operation.status,
        operation.started_at_ms,
        operation.completed_at_ms
      FROM matchup_operations AS operation
      JOIN season_matchup_schedule_generations AS generation
        ON generation.league_id = operation.league_id
       AND generation.season_id = operation.season_id
       AND generation.schedule_operation_id = operation.id
       AND generation.status = 'current'
      WHERE operation.league_id = @leagueId
        AND operation.season_id = @seasonId
      LIMIT 2
    `);
    openingScheduleJobBindingsStatement = database.prepare(`
      SELECT
        binding.id AS binding_id,
        binding.job_run_id,
        binding.job_type,
        binding.schedule_operation_id,
        binding.schedule_version,
        binding.owning_matchup_week_id,
        binding.owning_matchup_id,
        binding.created_at_ms AS binding_created_at_ms,
        binding.version AS binding_version,
        job.status AS job_status,
        job.occurrence_key,
        job.scheduled_for_ms,
        job.attempt_count,
        job.lease_owner,
        job.lease_token,
        job.lease_expires_at_ms,
        job.started_at_ms,
        job.completed_at_ms,
        job.result_json,
        job.last_error_code,
        job.next_attempt_at_ms,
        job.created_at_ms AS job_created_at_ms,
        job.updated_at_ms AS job_updated_at_ms,
        job.version AS job_version
      FROM season_matchup_schedule_generations AS generation
      JOIN matchup_schedule_job_bindings AS binding
        ON binding.league_id = generation.league_id
       AND binding.season_id = generation.season_id
       AND binding.schedule_operation_id =
           generation.schedule_operation_id
       AND binding.schedule_version = generation.schedule_version
      JOIN job_runs AS job
        ON job.league_id = binding.league_id
       AND job.season_id = binding.season_id
       AND job.id = binding.job_run_id
       AND job.job_type = binding.job_type
      WHERE generation.league_id = @leagueId
        AND generation.season_id = @seasonId
        AND generation.status = 'current'
      ORDER BY binding.job_type,
               binding.owning_matchup_week_id,
               binding.owning_matchup_id,
               binding.id
    `);
    openingWeekOneStatement = database.prepare(`
      SELECT id AS week_id, sequence, starts_at_ms, version
      FROM matchup_weeks
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND sequence = 1
      ORDER BY id
      LIMIT 2
    `);
    openingPriorSeasonStatement = database.prepare(`
      SELECT
        id AS season_id,
        nhl_season_key,
        status,
        free_agent_draft_completed_at_ms,
        version
      FROM seasons
      WHERE league_id = @leagueId
        AND nhl_season_key < (
          SELECT nhl_season_key
          FROM seasons
          WHERE league_id = @leagueId
            AND id = @seasonId
        )
      ORDER BY nhl_season_key DESC, id
      LIMIT 1
    `);
    openingPriorRolloverStatement = database.prepare(`
      SELECT
        id AS rollover_id,
        from_season_id,
        to_season_id,
        completed_at_ms,
        manifest_sha256,
        status,
        version
      FROM season_rollovers
      WHERE league_id = @leagueId
        AND to_season_id = @seasonId
      ORDER BY completed_at_ms DESC, id
      LIMIT 2
    `);
    openingPriorRolloverItemsStatement = database.prepare(`
      SELECT *
      FROM season_rollover_items
      WHERE league_id = @leagueId
        AND rollover_id = @rolloverId
      ORDER BY effect_kind, entity_id, id
    `);
    openingEntryDraftStatement = database.prepare(`
      SELECT id AS entry_draft_id, status,
             completed_at_ms, version
      FROM entry_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
    openingExemptionStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_setup_exemptions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY created_at_ms, id
      LIMIT 2
    `);
    openingTeamsStatement = database.prepare(`
      SELECT
        id AS team_id,
        name AS team_name,
        status AS team_status,
        primary_colour,
        secondary_colour,
        tertiary_colour,
        pattern_template,
        logo_reference,
        version
      FROM teams
      WHERE league_id = @leagueId
        AND status = 'active'
      ORDER BY id
    `);
    openingManagersStatement = database.prepare(`
      SELECT
        assignment.id AS manager_assignment_id,
        assignment.team_id,
        assignment.user_id,
        assignment.membership_id,
        assignment.status AS assignment_status,
        assignment.accepted_at_ms,
        assignment.ended_at_ms,
        assignment.version,
        membership.status AS membership_status,
        users.status AS user_status
      FROM team_manager_assignments AS assignment
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
      LEFT JOIN users
        ON users.id = assignment.user_id
      WHERE assignment.league_id = @leagueId
        AND assignment.status = 'accepted'
        AND assignment.ended_at_ms IS NULL
      ORDER BY assignment.team_id, assignment.id
    `);
    openingOwnershipsStatement = database.prepare(`
      SELECT
        ownership.id AS ownership_id,
        ownership.team_id,
        ownership.player_id,
        ownership.ownership_kind,
        ownership.roster_category,
        ownership.position_group,
        ownership.slot_number,
        ownership.version,
        players.status AS player_status
      FROM player_ownerships AS ownership
      JOIN players ON players.id = ownership.player_id
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
      ORDER BY ownership.team_id, ownership.id
    `);
    openingContractsStatement = database.prepare(`
      SELECT
        id AS contract_id,
        player_id,
        current_team_id,
        contract_type,
        original_total_value_cents,
        original_term_years,
        aav_cents,
        start_season_id,
        status,
        version
      FROM contracts
      WHERE league_id = @leagueId
        AND status = 'active'
      ORDER BY current_team_id, player_id, id
    `);
    openingAllContractsStatement = database.prepare(`
      SELECT
        id AS contract_id,
        player_id,
        current_team_id,
        contract_type,
        original_total_value_cents,
        original_term_years,
        aav_cents,
        start_season_id,
        status,
        version
      FROM contracts
      WHERE league_id = @leagueId
      ORDER BY current_team_id, player_id, id
    `);
    openingContractYearsStatement = database.prepare(`
      SELECT
        contract_years.id AS contract_year_id,
        contract_years.contract_id,
        contract_years.season_id,
        contract_years.year_number,
        contract_years.aav_cents,
        contract_years.status
      FROM contract_years
      JOIN contracts
        ON contracts.league_id = contract_years.league_id
       AND contracts.id = contract_years.contract_id
      WHERE contract_years.league_id = @leagueId
        AND contract_years.season_id = @seasonId
      ORDER BY contract_years.contract_id,
               contract_years.year_number,
               contract_years.id
    `);
    openingAllContractYearsStatement = database.prepare(`
      SELECT contract_years.*
      FROM contract_years
      JOIN contracts
        ON contracts.league_id = contract_years.league_id
       AND contracts.id = contract_years.contract_id
      WHERE contract_years.league_id = @leagueId
      ORDER BY contract_years.contract_id,
               contract_years.year_number,
               contract_years.id
    `);
    openingRosterOrderSetsStatement = database.prepare(`
      SELECT *
      FROM roster_display_order_sets
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      ORDER BY team_id, id
    `);
    openingRosterOrderEntriesStatement = database.prepare(`
      SELECT entry.*
      FROM roster_display_order_entries AS entry
      JOIN roster_display_order_sets AS order_set
        ON order_set.league_id = entry.league_id
       AND order_set.id = entry.order_set_id
      WHERE order_set.league_id = @leagueId
        AND order_set.season_id = @seasonId
      ORDER BY order_set.team_id,
               entry.position_group,
               entry.display_order,
               entry.id
    `);
    openingRetentionObligationsStatement = database.prepare(`
      SELECT *
      FROM retention_obligations
      WHERE league_id = @leagueId
      ORDER BY responsible_team_id, player_id, id
    `);
    openingRetentionYearsStatement = database.prepare(`
      SELECT retention_years.*
      FROM retention_years
      JOIN retention_obligations AS obligation
        ON obligation.league_id = retention_years.league_id
       AND obligation.id =
           retention_years.retention_obligation_id
      WHERE retention_years.league_id = @leagueId
      ORDER BY retention_years.retention_obligation_id,
               retention_years.season_id,
               retention_years.id
    `);
    openingBuyoutObligationsStatement = database.prepare(`
      SELECT *
      FROM buyout_obligations
      WHERE league_id = @leagueId
      ORDER BY responsible_team_id, player_id, id
    `);
    openingBuyoutYearsStatement = database.prepare(`
      SELECT buyout_years.*
      FROM buyout_years
      JOIN buyout_obligations AS obligation
        ON obligation.league_id = buyout_years.league_id
       AND obligation.id =
           buyout_years.buyout_obligation_id
      WHERE buyout_years.league_id = @leagueId
      ORDER BY buyout_years.buyout_obligation_id,
               buyout_years.season_id,
               buyout_years.id
    `);
    openingPriorContractYearsStatement = database.prepare(`
      SELECT contract_years.*
      FROM contract_years
      JOIN contracts
        ON contracts.league_id = contract_years.league_id
       AND contracts.id = contract_years.contract_id
      WHERE contract_years.league_id = @leagueId
        AND contract_years.season_id = @sourceSeasonId
      ORDER BY contract_years.contract_id,
               contract_years.year_number,
               contract_years.id
    `);
    openingPriorRetentionYearsStatement = database.prepare(`
      SELECT retention_years.*
      FROM retention_years
      JOIN retention_obligations AS obligation
        ON obligation.league_id = retention_years.league_id
       AND obligation.id =
           retention_years.retention_obligation_id
      WHERE retention_years.league_id = @leagueId
        AND retention_years.season_id = @sourceSeasonId
      ORDER BY retention_years.retention_obligation_id,
               retention_years.id
    `);
    openingPriorBuyoutYearsStatement = database.prepare(`
      SELECT buyout_years.*
      FROM buyout_years
      JOIN buyout_obligations AS obligation
        ON obligation.league_id = buyout_years.league_id
       AND obligation.id =
           buyout_years.buyout_obligation_id
      WHERE buyout_years.league_id = @leagueId
        AND buyout_years.season_id = @sourceSeasonId
      ORDER BY buyout_years.buyout_obligation_id,
               buyout_years.id
    `);
    openingLeaguePositionsStatement = database.prepare(`
      SELECT id, player_id, position_group,
             effective_at_ms, version
      FROM league_player_positions
      WHERE league_id = @leagueId
        AND ended_at_ms IS NULL
        AND (
          EXISTS (
            SELECT 1
            FROM player_ownerships AS ownership
            WHERE ownership.league_id = @leagueId
              AND ownership.player_id =
                  league_player_positions.player_id
          )
          OR EXISTS (
            SELECT 1
            FROM contracts AS contract
            WHERE contract.league_id = @leagueId
              AND contract.player_id =
                  league_player_positions.player_id
          )
        )
      ORDER BY player_id, id
    `);
    openingPlayerSourcesStatement = database.prepare(`
      SELECT id, player_id, provider,
             normalized_position, active,
             effective_at_ms
      FROM player_source_state
      WHERE ended_at_ms IS NULL
        AND (
          EXISTS (
            SELECT 1
            FROM player_ownerships AS ownership
            WHERE ownership.league_id = @leagueId
              AND ownership.player_id =
                  player_source_state.player_id
          )
          OR EXISTS (
            SELECT 1
            FROM contracts AS contract
            WHERE contract.league_id = @leagueId
              AND contract.player_id =
                  player_source_state.player_id
          )
        )
      ORDER BY player_id, provider, id
    `);
    viewerAuthorityStatement = database.prepare(`
      SELECT
        leagues.status AS league_status,
        leagues.timezone,
        leagues.current_season_id,
        leagues.commissioner_membership_id,
        users.status AS user_status,
        membership.status AS membership_status,
        membership.permission_category,
        CASE WHEN EXISTS (
          SELECT 1
          FROM platform_roles
          WHERE platform_roles.user_id = @viewerUserId
            AND platform_roles.role = 'platform_administrator'
            AND platform_roles.status = 'active'
            AND platform_roles.ended_at_ms IS NULL
        ) THEN 1 ELSE 0 END
          AS is_platform_administrator
      FROM leagues
      JOIN users ON users.id = @viewerUserId
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = leagues.id
       AND membership.id = @viewerMembershipId
       AND membership.user_id = @viewerUserId
       AND membership.ended_at_ms IS NULL
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    readinessStatement = openingReadinessStatement;
    readinessAttemptStatement = database.prepare(`
      SELECT *
      FROM free_agent_draft_readiness_attempts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND readiness_operation_id = @operationId
      ORDER BY attempt_number DESC
      LIMIT 2
    `);
    readinessJobStatement = openingReadinessJobStatement;
    currentFadStatement = database.prepare(`
      SELECT *
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
      LIMIT 2
    `);
    fadByIdStatement = database.prepare(`
      SELECT *
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND id = @fadId
      LIMIT 2
    `);
    managedCardsStatement = database.prepare(`
      SELECT
        card.id AS card_id,
        card.league_id,
        card.season_id,
        card.fad_id,
        card.team_id,
        card.status AS card_status,
        card.completeness_code,
        card.missing_mandatory_count,
        card.structural_conflict_count,
        card.cap_status,
        card.allocation_eligibility,
        card.version AS card_version,
        team.name AS team_name,
        team.primary_colour,
        team.secondary_colour,
        team.tertiary_colour,
        team.pattern_template,
        team.logo_reference,
        assignment.id AS manager_assignment_id,
        help.id AS help_request_id,
        help.status AS help_request_status,
        help.requested_at_ms AS help_requested_at_ms,
        help.expires_at_ms AS help_expires_at_ms
      FROM candidate_cards AS card
      JOIN teams AS team
        ON team.league_id = card.league_id
       AND team.id = card.team_id
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = card.league_id
       AND assignment.team_id = card.team_id
       AND assignment.user_id = @viewerUserId
       AND assignment.membership_id = @viewerMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN candidate_card_help_requests AS help
        ON help.league_id = card.league_id
       AND help.fad_id = card.fad_id
       AND help.card_id = card.id
      WHERE card.league_id = @leagueId
        AND card.fad_id = @fadId
      ORDER BY card.team_id, card.id
    `);
    allCardsStatement = database.prepare(`
      SELECT
        card.id AS card_id,
        card.league_id,
        card.season_id,
        card.fad_id,
        card.team_id,
        card.status AS card_status,
        card.completeness_code,
        card.missing_mandatory_count,
        card.structural_conflict_count,
        card.cap_status,
        card.allocation_eligibility,
        card.version AS card_version,
        team.name AS team_name,
        team.primary_colour,
        team.secondary_colour,
        team.tertiary_colour,
        team.pattern_template,
        team.logo_reference,
        help.id AS help_request_id,
        help.status AS help_request_status,
        help.requested_at_ms AS help_requested_at_ms,
        help.expires_at_ms AS help_expires_at_ms
      FROM candidate_cards AS card
      JOIN teams AS team
        ON team.league_id = card.league_id
       AND team.id = card.team_id
      LEFT JOIN candidate_card_help_requests AS help
        ON help.league_id = card.league_id
       AND help.fad_id = card.fad_id
       AND help.card_id = card.id
      WHERE card.league_id = @leagueId
        AND card.fad_id = @fadId
      ORDER BY card.team_id, card.id
    `);
    rosterCardStatement = database.prepare(`
      SELECT
        card.id AS card_id,
        card.league_id,
        card.season_id,
        card.fad_id,
        card.team_id,
        fad.status AS fad_status,
        fad.opened_at_ms,
        fad.help_opens_at_ms,
        fad.candidate_deadline_at_ms,
        fad.deadline_locked_at_ms,
        assignment.id AS manager_assignment_id,
        help.id AS help_request_id,
        help.status AS help_request_status,
        help.expires_at_ms AS help_expires_at_ms
      FROM candidate_cards AS card
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      LEFT JOIN team_manager_assignments AS assignment
        ON assignment.league_id = card.league_id
       AND assignment.team_id = card.team_id
       AND assignment.user_id = @viewerUserId
       AND assignment.membership_id = @viewerMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN candidate_card_help_requests AS help
        ON help.league_id = card.league_id
       AND help.fad_id = card.fad_id
       AND help.card_id = card.id
      WHERE card.league_id = @leagueId
        AND card.season_id = @rosterSeasonId
        AND card.team_id = @rosterTeamId
      LIMIT 2
    `);
    nextRolloverStatement = database.prepare(`
      SELECT id AS rollover_id, rolls_over_at_ms
      FROM free_agent_draft_rollovers
      WHERE league_id = @leagueId
        AND fad_id = @fadId
        AND status <> 'completed'
      ORDER BY sequence, id
      LIMIT 1
    `);
    competitionWeekOneStatement = database.prepare(`
      SELECT
        week.id AS week_id,
        week.sequence,
        week.starts_at_ms,
        week.version
      FROM matchup_weeks AS week
      JOIN season_matchup_schedule_generations AS generation
        ON generation.league_id = week.league_id
       AND generation.season_id = week.season_id
       AND generation.week_one_matchup_week_id = week.id
       AND generation.week_one_starts_at_ms = week.starts_at_ms
       AND generation.status = 'current'
      WHERE week.league_id = @leagueId
        AND week.season_id = @seasonId
        AND week.id = @weekId
        AND week.sequence = 1
      LIMIT 2
    `);
    overviewCountsStatement = database.prepare(`
      SELECT
        (SELECT COUNT(*)
           FROM free_agent_draft_teams
          WHERE league_id = @leagueId
            AND fad_id = @fadId) AS participating_teams,
        (SELECT COUNT(*)
           FROM candidate_cards
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status <> 'open') AS cards_locked,
        (SELECT COUNT(*)
           FROM free_agent_draft_player_allocations
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status = 'pending') AS allocations_pending,
        (SELECT COUNT(*)
           FROM free_agent_draft_player_allocations
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status = 'automatic_award') AS allocations_automatic,
        (SELECT COUNT(*)
           FROM free_agent_draft_player_allocations
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status IN (
              'restricted_scheduled',
              'restricted_active'
            )) AS restricted_pending,
        (SELECT COUNT(*)
           FROM free_agent_draft_player_allocations
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status = 'restricted_fallback_open')
          AS restricted_fallback_pending,
        (SELECT COUNT(*)
           FROM auctions AS auction
           JOIN auction_contexts AS context
             ON context.league_id = auction.league_id
            AND context.auction_id = auction.id
          WHERE context.league_id = @leagueId
            AND context.fad_id = @fadId
            AND context.source_kind = 'fad_open_rapid'
            AND auction.status IN ('open', 'resolving'))
          AS rapid_auctions_open,
        (SELECT COUNT(*)
           FROM free_agent_draft_rollovers
          WHERE league_id = @leagueId
            AND fad_id = @fadId) AS rollovers_persisted,
        (SELECT COUNT(*)
           FROM free_agent_draft_rollovers
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status = 'completed') AS rollovers_completed,
        (SELECT COUNT(*)
           FROM free_agent_draft_recoveries
          WHERE league_id = @leagueId
            AND fad_id = @fadId
            AND status <> 'resolved') AS recoveries_open
    `);
    recoveryRowsStatement = database.prepare(`
      SELECT id AS recovery_id, kind, status
      FROM free_agent_draft_recoveries
      WHERE league_id = @leagueId
        AND fad_id = @fadId
      ORDER BY id
    `);
    completionScheduleRecoveryStatement = database.prepare(`
      SELECT id AS recovery_id,
             recovery_kind,
             matchup_operation_id
      FROM free_agent_draft_schedule_recoveries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND id = @scheduleRecoveryId
      LIMIT 2
    `);
    queuedNominationsStatement = database.prepare(`
      SELECT
        queue.id AS queue_id,
        queue.team_id,
        queue.player_id,
        player.full_name AS player_full_name,
        queue.opening_total_value_cents,
        queue.opening_term_years,
        queue.opening_aav_cents,
        queue.accepted_at_ms,
        queue.target_opening_rollover_id,
        queue.resolution_rollover_id,
        queue.status,
        (SELECT COUNT(*)
           FROM league_player_positions AS correction
          WHERE correction.league_id = queue.league_id
            AND correction.player_id = queue.player_id
            AND correction.ended_at_ms IS NULL)
          AS correction_position_count,
        (SELECT correction.position_group
           FROM league_player_positions AS correction
          WHERE correction.league_id = queue.league_id
            AND correction.player_id = queue.player_id
            AND correction.ended_at_ms IS NULL
          ORDER BY correction.id
          LIMIT 1) AS corrected_position_group,
        (SELECT COUNT(DISTINCT source.normalized_position)
           FROM player_source_state AS source
          WHERE source.player_id = queue.player_id
            AND source.ended_at_ms IS NULL
            AND source.active = 1
            AND source.normalized_position IN ('F', 'D'))
          AS source_position_count,
        (SELECT source.normalized_position
           FROM player_source_state AS source
          WHERE source.player_id = queue.player_id
            AND source.ended_at_ms IS NULL
            AND source.active = 1
            AND source.normalized_position IN ('F', 'D')
          GROUP BY source.normalized_position
          ORDER BY source.normalized_position
          LIMIT 1) AS source_position_group
      FROM free_agent_draft_nomination_queue AS queue
      JOIN players AS player ON player.id = queue.player_id
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = queue.league_id
       AND assignment.team_id = queue.team_id
       AND assignment.user_id = @viewerUserId
       AND assignment.membership_id = @viewerMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      WHERE queue.league_id = @leagueId
        AND queue.fad_id = @fadId
        AND queue.status = 'queued'
      ORDER BY queue.accepted_at_ms, queue.id
    `);
    restrictedManagerActionsStatement = database.prepare(`
      SELECT DISTINCT participant.team_id
      FROM free_agent_draft_auction_participants AS participant
      JOIN auctions AS auction
        ON auction.league_id = participant.league_id
       AND auction.id = participant.auction_id
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.auction_id = auction.id
       AND context.source_kind = 'fad_restricted'
       AND context.fad_id = participant.fad_id
      JOIN team_manager_assignments AS assignment
        ON assignment.league_id = participant.league_id
       AND assignment.team_id = participant.team_id
       AND assignment.user_id = @viewerUserId
       AND assignment.membership_id = @viewerMembershipId
       AND assignment.status = 'accepted'
       AND assignment.accepted_at_ms IS NOT NULL
       AND assignment.ended_at_ms IS NULL
      WHERE participant.league_id = @leagueId
        AND participant.fad_id = @fadId
        AND participant.status = 'active'
        AND participant.active_improvement_bid_id IS NULL
        AND auction.status = 'open'
        AND @nowMs < auction.resolves_at_ms
      ORDER BY participant.team_id
    `);
    rapidAuctionsStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM auctions AS auction
      JOIN auction_contexts AS context
        ON context.league_id = auction.league_id
       AND context.auction_id = auction.id
      WHERE context.league_id = @leagueId
        AND context.fad_id = @fadId
        AND context.source_kind = 'fad_open_rapid'
        AND auction.status = 'open'
        AND @nowMs < auction.resolves_at_ms
    `);
    publishedSummaryPageStatement =
      database.prepare(`
        SELECT
          snapshot.*,
          team.name AS team_name,
          team.name_normalized AS team_sort_name,
          team.primary_colour,
          team.secondary_colour,
          team.tertiary_colour,
          team.pattern_template,
          team.logo_reference
        FROM candidate_card_snapshots AS snapshot
        JOIN free_agent_drafts AS fad
          ON fad.league_id = snapshot.league_id
         AND fad.season_id = snapshot.season_id
         AND fad.id = snapshot.fad_id
         AND fad.deadline_locked_at_ms IS NOT NULL
        JOIN teams AS team
          ON team.league_id = snapshot.league_id
         AND team.id = snapshot.team_id
        WHERE snapshot.league_id = @leagueId
          AND snapshot.fad_id = @fadId
          AND (
            @cursorSortName IS NULL
            OR team.name_normalized > @cursorSortName
            OR (
              team.name_normalized = @cursorSortName
              AND team.id > @cursorTeamId
            )
          )
        ORDER BY team.name_normalized, team.id
        LIMIT @limitPlusOne
      `);
    publishedSnapshotCountStatement =
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM candidate_card_snapshots
        WHERE league_id = @leagueId
          AND fad_id = @fadId
      `);
    publishedSnapshotStatement =
      database.prepare(`
        SELECT
          snapshot.*,
          fad.status AS fad_status,
          fad.opened_at_ms,
          fad.help_opens_at_ms,
          fad.candidate_deadline_at_ms
        FROM candidate_card_snapshots AS snapshot
        JOIN candidate_cards AS card
          ON card.league_id = snapshot.league_id
         AND card.season_id = snapshot.season_id
         AND card.fad_id = snapshot.fad_id
         AND card.id = snapshot.card_id
         AND card.team_id = snapshot.team_id
         AND card.status = snapshot.locked_status
         AND card.version = snapshot.locked_card_version
        JOIN free_agent_drafts AS fad
          ON fad.league_id = snapshot.league_id
         AND fad.season_id = snapshot.season_id
         AND fad.id = snapshot.fad_id
         AND fad.deadline_locked_at_ms IS NOT NULL
        WHERE snapshot.league_id = @leagueId
          AND snapshot.fad_id = @fadId
          AND snapshot.team_id = @teamId
        LIMIT 2
      `);
    publishedSnapshotEntriesStatement =
      database.prepare(`
        SELECT
          entry.*,
          player.full_name AS player_full_name,
          editor.display_name AS editor_display_name
        FROM candidate_card_snapshot_entries AS entry
        LEFT JOIN players AS player
          ON player.id = entry.player_id
        LEFT JOIN users AS editor
          ON editor.id = entry.last_edited_by_user_id
        WHERE entry.league_id = @leagueId
          AND entry.season_id = @seasonId
          AND entry.fad_id = @fadId
          AND entry.snapshot_id = @snapshotId
          AND entry.card_id = @cardId
          AND entry.team_id = @teamId
        ORDER BY
          CASE entry.slot_group
            WHEN 'F' THEN 1
            WHEN 'D' THEN 2
            ELSE 3
          END,
          entry.slot_number,
          CASE entry.row_kind
            WHEN 'slot' THEN 1
            ELSE 2
          END,
          entry.id
      `);
    publishedInterventionsStatement =
      database.prepare(`
        SELECT revision.*, actor.display_name
        FROM candidate_card_revisions AS revision
        JOIN users AS actor
          ON actor.id = revision.actor_user_id
        WHERE revision.league_id = @leagueId
          AND revision.season_id = @seasonId
          AND revision.fad_id = @fadId
          AND revision.card_id = @cardId
          AND revision.team_id = @teamId
          AND revision.actor_authority IN (
            'commissioner',
            'platform_administrator_as_commissioner'
          )
        ORDER BY revision.occurred_at_ms, revision.id
      `);
    allocationByPlayerStatement =
      database.prepare(`
        SELECT *
        FROM free_agent_draft_player_allocations
        WHERE league_id = @leagueId
          AND fad_id = @fadId
          AND player_id = @playerId
        LIMIT 2
      `);
    allocationOfferEventStatement =
      database.prepare(`
        SELECT event.*
        FROM free_agent_draft_allocation_events AS event
        JOIN free_agent_draft_player_allocations AS allocation
          ON allocation.league_id = event.league_id
         AND allocation.id = event.allocation_id
         AND allocation.version = event.allocation_version
        WHERE event.league_id = @leagueId
          AND event.fad_id = @fadId
          AND event.allocation_id = @allocationId
          AND event.snapshot_entry_id = @snapshotEntryId
          AND event.event_kind = 'offer_considered'
        LIMIT 2
      `);
    allocationResultPageStatement =
      database.prepare(`
        SELECT
          allocation.*,
          player.full_name AS player_full_name,
          ${RESULT_PLAYER_NAME_SQL_FUNCTION}(
            player.full_name
          ) AS player_sort_name,
          (
            SELECT correction.position_group
            FROM league_player_positions AS correction
            WHERE correction.league_id = allocation.league_id
              AND correction.player_id = allocation.player_id
              AND correction.ended_at_ms IS NULL
            ORDER BY correction.id
            LIMIT 1
          ) AS corrected_position_group,
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = allocation.player_id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position IN ('F', 'D')
            GROUP BY source.normalized_position
            ORDER BY source.normalized_position
            LIMIT 1
          ) AS source_position_group,
          (
            SELECT COUNT(*)
            FROM league_player_positions AS correction
            WHERE correction.league_id = allocation.league_id
              AND correction.player_id = allocation.player_id
              AND correction.ended_at_ms IS NULL
          ) AS correction_position_count,
          (
            SELECT COUNT(DISTINCT source.normalized_position)
            FROM player_source_state AS source
            WHERE source.player_id = allocation.player_id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
              AND source.normalized_position IN ('F', 'D')
          ) AS source_position_count
        FROM free_agent_draft_player_allocations AS allocation
        JOIN players AS player
          ON player.id = allocation.player_id
        WHERE allocation.league_id = @leagueId
          AND allocation.fad_id = @fadId
          AND (
            @status IS NULL
            OR allocation.status = @status
          )
          AND (
            @q = ''
            OR instr(
              ${RESULT_PLAYER_NAME_SQL_FUNCTION}(
                player.full_name
              ),
              @q
            ) > 0
          )
          AND (
            @cursorSortName IS NULL
            OR ${RESULT_PLAYER_NAME_SQL_FUNCTION}(
              player.full_name
            ) > @cursorSortName
            OR (
              ${RESULT_PLAYER_NAME_SQL_FUNCTION}(
                player.full_name
              ) = @cursorSortName
              AND player.id > @cursorPlayerId
            )
          )
        ORDER BY player_sort_name, player.id
        LIMIT @limitPlusOne
      `);
    allocationOffersStatement =
      database.prepare(`
        SELECT
          offer.*,
          team.name AS team_name,
          team.primary_colour,
          team.secondary_colour,
          team.tertiary_colour,
          team.pattern_template,
          team.logo_reference,
          event.offer_valid,
          event.rank_position,
          event.offer_outcome_code
        FROM candidate_card_snapshot_entries AS offer
        JOIN candidate_card_snapshots AS snapshot
          ON snapshot.league_id = offer.league_id
         AND snapshot.id = offer.snapshot_id
        JOIN teams AS team
          ON team.league_id = offer.league_id
         AND team.id = offer.team_id
        LEFT JOIN free_agent_draft_allocation_events AS event
          ON event.league_id = offer.league_id
         AND event.fad_id = offer.fad_id
         AND event.allocation_id = @allocationId
         AND event.allocation_version = @allocationVersion
         AND event.event_kind = 'offer_considered'
         AND event.snapshot_entry_id = offer.id
        WHERE offer.league_id = @leagueId
          AND offer.fad_id = @fadId
          AND offer.player_id = @playerId
          AND offer.occupant_kind = 'candidate'
        ORDER BY
          CASE
            WHEN event.rank_position IS NULL THEN 1
            ELSE 0
          END,
          event.rank_position,
          offer.proposed_total_value_cents DESC,
          offer.proposed_aav_cents DESC,
          team.name_normalized,
          team.id,
          offer.id
      `);
    allocationWinnerStatement =
      database.prepare(`
        SELECT
          allocation.winning_snapshot_entry_id,
          allocation.winning_team_id,
          allocation.contract_id,
          allocation.ownership_id,
          snapshot_offer.slot_group AS snapshot_slot_group,
          snapshot_offer.slot_number AS snapshot_slot_number,
          snapshot_offer.player_id AS snapshot_player_id,
          snapshot_offer.team_id AS snapshot_team_id,
          contract.original_total_value_cents,
          contract.original_term_years,
          contract.aav_cents,
          contract.player_id AS contract_player_id,
          contract.current_team_id AS contract_team_id,
          contract.status AS contract_status,
          ownership.roster_category,
          ownership.position_group AS ownership_position_group,
          ownership.slot_number AS ownership_slot_number,
          ownership.player_id AS ownership_player_id,
          ownership.team_id AS ownership_team_id,
          ownership.season_id AS ownership_season_id,
          ownership.ownership_kind
        FROM free_agent_draft_player_allocations AS allocation
        LEFT JOIN candidate_card_snapshot_entries AS snapshot_offer
          ON snapshot_offer.league_id = allocation.league_id
         AND snapshot_offer.id = allocation.winning_snapshot_entry_id
        LEFT JOIN contracts AS contract
          ON contract.league_id = allocation.league_id
         AND contract.id = allocation.contract_id
        LEFT JOIN player_ownerships AS ownership
          ON ownership.league_id = allocation.league_id
         AND ownership.id = allocation.ownership_id
        WHERE allocation.league_id = @leagueId
          AND allocation.fad_id = @fadId
          AND allocation.id = @allocationId
        LIMIT 2
      `);
    allocationAuctionsStatement =
      database.prepare(`
        SELECT
          context.source_kind,
          context.fad_origin,
          auction.id AS auction_id,
          auction.status AS auction_status,
          resolution.winning_bid_id,
          resolution.contract_id AS resolution_contract_id,
          resolution.ownership_id AS resolution_ownership_id,
          resolution.outcome_code,
          resolution.status AS resolution_status
        FROM auction_contexts AS context
        JOIN auctions AS auction
          ON auction.league_id = context.league_id
         AND auction.id = context.auction_id
        LEFT JOIN auction_resolutions AS resolution
          ON resolution.league_id = auction.league_id
         AND resolution.auction_id = auction.id
        WHERE context.league_id = @leagueId
          AND context.fad_id = @fadId
          AND context.fad_allocation_id = @allocationId
        ORDER BY
          CASE context.source_kind
            WHEN 'fad_restricted' THEN 1
            ELSE 2
          END,
          auction.id
      `);
    allocationParticipantsStatement =
      database.prepare(`
        SELECT DISTINCT team_id
        FROM free_agent_draft_auction_participants
        WHERE league_id = @leagueId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
          AND auction_id = @auctionId
        ORDER BY team_id
      `);
    allocationDrawsStatement = database.prepare(`
      SELECT
        draw.*,
        context.source_kind,
        auction.status AS auction_status,
        auction.resolves_at_ms AS auction_resolves_at_ms,
        resolution.status AS resolution_status,
        resolution.outcome_code
      FROM free_agent_draft_draws AS draw
      JOIN auction_contexts AS context
        ON context.league_id = draw.league_id
       AND context.auction_id = draw.auction_id
       AND context.fad_id = draw.fad_id
      JOIN auctions AS auction
        ON auction.league_id = draw.league_id
       AND auction.id = draw.auction_id
      LEFT JOIN auction_resolutions AS resolution
        ON resolution.league_id = auction.league_id
       AND resolution.auction_id = auction.id
      WHERE draw.league_id = @leagueId
        AND draw.fad_id = @fadId
        AND draw.allocation_id = @allocationId
      ORDER BY draw.created_at_ms, draw.auction_id
    `);
    allocationRecoveryStatement =
      database.prepare(`
        SELECT status
        FROM free_agent_draft_recoveries
        WHERE league_id = @leagueId
          AND fad_id = @fadId
          AND allocation_id = @allocationId
        ORDER BY
          CASE status
            WHEN 'pending' THEN 1
            WHEN 'ready' THEN 2
            WHEN 'running' THEN 3
            WHEN 'correction_required' THEN 4
            ELSE 5
          END,
          updated_at_ms DESC,
          id DESC
        LIMIT 1
      `);
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The SQLite schema does not support FAD read projections.",
      { cause: error }
    );
  }

  function readOpeningPreflightContext(input) {
    const scope = normalizeOpeningInput(input);
    try {
      const season = unique(
        openingSeasonStatement,
        scope,
        "The FAD opening season"
      );
      if (!season) {
        notFound(
          "The scoped FAD opening season was not found."
        );
      }
      const readiness = unique(
        openingReadinessStatement,
        scope,
        "The FAD opening readiness operation"
      );
      const readinessJob = readiness?.job_run_id
        ? unique(
            openingReadinessJobStatement,
            {
              ...scope,
              jobRunId: readiness.job_run_id,
            },
            "The FAD opening readiness job"
          )
        : null;
      if (
        readiness &&
        (
          !readinessJob ||
          readinessJob.season_id !== scope.seasonId ||
          readinessJob.job_type !== "fad_readiness" ||
          readinessJob.occurrence_key !==
            readiness.readiness_occurrence_key ||
          readinessJob.scheduled_for_ms !==
            readiness.created_at_ms ||
          readinessJob.created_at_ms !==
            readiness.created_at_ms
        )
      ) {
        incompatible(
          "The FAD opening readiness operation and job are split."
        );
      }
      const priorSeason =
        openingPriorSeasonStatement.get(scope) || null;
      const priorSeasonRollovers =
        openingPriorRolloverStatement.all(scope);
      const priorSeasonRolloverReceipt =
        priorSeasonRollovers.length === 1
          ? lifecycleReadRepository
              .findDurableSeasonRolloverResult({
                leagueId: scope.leagueId,
                rolloverId:
                  priorSeasonRollovers[0].rollover_id,
              })
          : null;
      const priorSeasonRolloverOwnershipReceipt =
        priorSeasonRollovers.length === 1
          ? lifecycleReadRepository
              .findDurableSeasonRolloverOwnershipReceipt({
                leagueId: scope.leagueId,
                rolloverId:
                  priorSeasonRollovers[0].rollover_id,
              })
          : null;
      const priorSeasonRolloverItems =
        priorSeasonRollovers.length === 1
          ? openingPriorRolloverItemsStatement.all({
              leagueId: scope.leagueId,
              rolloverId:
                priorSeasonRollovers[0].rollover_id,
            })
          : [];
      const sourceScope = priorSeason
        ? {
            leagueId: scope.leagueId,
            sourceSeasonId: priorSeason.season_id,
          }
        : null;
      const currentSchedule = unique(
        openingScheduleStatement,
        scope,
        "The current matchup schedule generation"
      );
      const currentScheduleOperation = unique(
        openingScheduleOperationStatement,
        scope,
        "The current matchup schedule operation"
      );
      const currentScheduleJobBindings =
        openingScheduleJobBindingsStatement.all(scope);
      const firstMatchupWeek = unique(
        openingWeekOneStatement,
        scope,
        "The sequence-one matchup week"
      );
      if (
        currentSchedule &&
        (
          !currentScheduleOperation ||
          currentScheduleOperation.operation_id !==
            currentSchedule.operation_id ||
          currentScheduleOperation.season_id !==
            scope.seasonId ||
          currentScheduleOperation.operation_type !==
            "schedule_generate" ||
          currentScheduleOperation.status !== "succeeded" ||
          currentScheduleOperation.completed_at_ms !==
            currentSchedule.created_at_ms ||
          currentScheduleJobBindings.some(
            (binding) =>
              binding.schedule_operation_id !==
                currentSchedule.operation_id ||
              binding.schedule_version !==
                currentSchedule.version
          )
        )
      ) {
        incompatible(
          "The current matchup schedule evidence is split."
        );
      }
      if (
        currentSchedule &&
        firstMatchupWeek &&
        (
          firstMatchupWeek.week_id !==
            currentSchedule.week_id ||
          firstMatchupWeek.starts_at_ms !==
            currentSchedule.starts_at_ms
        )
      ) {
        incompatible(
          "The current matchup schedule and Week 1 are split."
        );
      }
      return deepFreeze({
        league: {
          leagueId: season.league_id,
          status: season.league_status,
          timeZone: season.timezone,
          currentSeasonId:
            season.current_season_id,
          commissionerMembershipId:
            season.commissioner_membership_id,
          version: season.league_version,
        },
        season: {
          seasonId: season.season_id,
          label: season.season_label,
          nhlSeasonKey: season.nhl_season_key,
          status: season.season_status,
          regularSeasonStartsAtMs:
            season.regular_season_starts_at_ms,
          regularSeasonEndsAtMs:
            season.regular_season_ends_at_ms,
          fantasyPlayoffsStartAtMs:
            season.fantasy_playoffs_start_at_ms,
          fantasyPlayoffsEndAtMs:
            season.fantasy_playoffs_end_at_ms,
          freeAgentDraftCompletedAtMs:
            season.free_agent_draft_completed_at_ms,
          version: season.season_version,
        },
        leagueSettings: selectRow(
          unique(
            openingLeagueSettingsStatement,
            scope,
            "The FAD opening league settings"
          ),
          [
            ["leagueId", "league_id"],
            ["salaryCapCents", "salary_cap_cents"],
            ["maximumTeams", "maximum_teams"],
            ["activeForwardSlots", "active_forward_slots"],
            ["activeDefenceSlots", "active_defence_slots"],
            ["benchSlots", "bench_slots"],
            ["maximumBenchAavCents", "maximum_bench_aav_cents"],
            ["injuredReserveSlots", "injured_reserve_slots"],
            ["prospectSlotsUnlimited", "prospect_slots_unlimited"],
            ["version", "version"],
          ]
        ),
        readinessOperation: selectRow(readiness, [
          ["operationId", "id"],
          ["leagueId", "league_id"],
          ["seasonId", "season_id"],
          ["occurrenceKey", "readiness_occurrence_key"],
          ["triggerKind", "trigger_kind"],
          ["entryDraftId", "entry_draft_id"],
          ["setupExemptionId", "setup_exemption_id"],
          ["jobRunId", "job_run_id"],
          ["status", "status"],
          ["attemptCount", "attempt_count"],
          ["leaseOwner", "lease_owner"],
          ["leaseToken", "lease_token"],
          ["leaseExpiresAtMs", "lease_expires_at_ms"],
          ["blockersJson", "blockers_json"],
          ["matchupScheduleVersionBefore", "matchup_schedule_version_before"],
          ["matchupScheduleVersionAfter", "matchup_schedule_version_after"],
          ["scheduleRecoveryId", "schedule_recovery_id"],
          ["createdFadId", "created_fad_id"],
          ["reminderJobRunId", "reminder_job_run_id"],
          ["deadlineJobRunId", "deadline_job_run_id"],
          ["cardsOpenedActivityId", "cards_opened_activity_id"],
          ["cardsOpenedOutboxEventId", "cards_opened_outbox_event_id"],
          ["startedAtMs", "started_at_ms"],
          ["nextRetryAtMs", "next_retry_at_ms"],
          ["terminalAtMs", "terminal_at_ms"],
          ["createdAtMs", "created_at_ms"],
          ["updatedAtMs", "updated_at_ms"],
          ["version", "version"],
        ]),
        readinessJob: selectRow(readinessJob, [
          ["jobRunId", "id"],
          ["leagueId", "league_id"],
          ["seasonId", "season_id"],
          ["jobType", "job_type"],
          ["occurrenceKey", "occurrence_key"],
          ["scheduledForMs", "scheduled_for_ms"],
          ["status", "status"],
          ["attemptCount", "attempt_count"],
          ["leaseOwner", "lease_owner"],
          ["leaseToken", "lease_token"],
          ["leaseExpiresAtMs", "lease_expires_at_ms"],
          ["startedAtMs", "started_at_ms"],
          ["completedAtMs", "completed_at_ms"],
          ["resultJson", "result_json"],
          ["lastErrorCode", "last_error_code"],
          ["nextAttemptAtMs", "next_attempt_at_ms"],
          ["createdAtMs", "created_at_ms"],
          ["updatedAtMs", "updated_at_ms"],
          ["version", "version"],
        ]),
        existingFad: selectRow(
          unique(
            openingExistingFadStatement,
            scope,
            "The existing season FAD"
          ),
          [
            ["fadId", "fad_id"],
            ["status", "status"],
            ["version", "version"],
          ]
        ),
        currentSchedule: selectRow(
          currentSchedule,
          [
            ["operationId", "operation_id"],
            ["version", "version"],
            ["generationVersion", "generation_version"],
            ["weekId", "week_id"],
            ["startsAtMs", "starts_at_ms"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        currentScheduleOperation: selectRow(
          currentScheduleOperation,
          [
            ["operationId", "operation_id"],
            ["seasonId", "season_id"],
            ["operationType", "operation_type"],
            ["status", "status"],
            ["startedAtMs", "started_at_ms"],
            ["completedAtMs", "completed_at_ms"],
          ]
        ),
        currentScheduleJobBindings: selectRows(
          currentScheduleJobBindings,
          [
            ["bindingId", "binding_id"],
            ["jobRunId", "job_run_id"],
            ["jobType", "job_type"],
            ["scheduleOperationId", "schedule_operation_id"],
            ["scheduleVersion", "schedule_version"],
            ["owningMatchupWeekId", "owning_matchup_week_id"],
            ["owningMatchupId", "owning_matchup_id"],
            ["bindingCreatedAtMs", "binding_created_at_ms"],
            ["bindingVersion", "binding_version"],
            ["jobStatus", "job_status"],
            ["occurrenceKey", "occurrence_key"],
            ["scheduledForMs", "scheduled_for_ms"],
            ["attemptCount", "attempt_count"],
            ["leaseOwner", "lease_owner"],
            ["leaseToken", "lease_token"],
            ["leaseExpiresAtMs", "lease_expires_at_ms"],
            ["startedAtMs", "started_at_ms"],
            ["completedAtMs", "completed_at_ms"],
            ["resultJson", "result_json"],
            ["lastErrorCode", "last_error_code"],
            ["nextAttemptAtMs", "next_attempt_at_ms"],
            ["jobCreatedAtMs", "job_created_at_ms"],
            ["jobUpdatedAtMs", "job_updated_at_ms"],
            ["jobVersion", "job_version"],
          ]
        ),
        firstMatchupWeek: selectRow(
          firstMatchupWeek,
          [
            ["weekId", "week_id"],
            ["sequence", "sequence"],
            ["startsAtMs", "starts_at_ms"],
            ["version", "version"],
          ]
        ),
        priorSeason: selectRow(priorSeason, [
          ["seasonId", "season_id"],
          ["nhlSeasonKey", "nhl_season_key"],
          ["status", "status"],
          ["freeAgentDraftCompletedAtMs", "free_agent_draft_completed_at_ms"],
          ["version", "version"],
        ]),
        priorSeasonRollovers: selectRows(
          priorSeasonRollovers,
          [
            ["rolloverId", "rollover_id"],
            ["fromSeasonId", "from_season_id"],
            ["toSeasonId", "to_season_id"],
            ["completedAtMs", "completed_at_ms"],
            ["manifestSha256", "manifest_sha256"],
            ["status", "status"],
            ["version", "version"],
          ]
        ),
        priorSeasonRolloverReceipt,
        priorSeasonRolloverOwnershipReceipt,
        priorSeasonRolloverItems: selectRows(
          priorSeasonRolloverItems,
          [
            ["itemId", "id"],
            ["leagueId", "league_id"],
            ["rolloverId", "rollover_id"],
            ["bindingId", "binding_id"],
            ["rolloverOccurrenceId", "rollover_occurrence_id"],
            ["rolloverAttemptId", "rollover_attempt_id"],
            ["idempotencyRequestId", "idempotency_request_id"],
            ["fromSeasonId", "from_season_id"],
            ["toSeasonId", "to_season_id"],
            ["effectKind", "effect_kind"],
            ["entityType", "entity_type"],
            ["entityId", "entity_id"],
            ["beforeJson", "before_json"],
            ["afterJson", "after_json"],
            ["payloadSha256", "payload_sha256"],
            ["contractEventId", "contract_event_id"],
            ["ownershipEventId", "ownership_event_id"],
            ["tradeEventId", "trade_event_id"],
            ["leagueActivityId", "league_activity_id"],
            ["causalAssetsJson", "causal_assets_json"],
            ["occurredAtMs", "occurred_at_ms"],
            ["createdAtMs", "created_at_ms"],
            ["version", "version"],
          ]
        ),
        entryDraft: selectRow(
          unique(
            openingEntryDraftStatement,
            scope,
            "The target-season Entry Draft"
          ),
          [
            ["entryDraftId", "entry_draft_id"],
            ["status", "status"],
            ["completedAtMs", "completed_at_ms"],
            ["version", "version"],
          ]
        ),
        setupExemptions: selectRows(
          openingExemptionStatement.all(scope),
          [
            ["exemptionId", "id"],
            ["leagueId", "league_id"],
            ["seasonId", "season_id"],
            ["exemptionKind", "exemption_kind"],
            ["migrationReportId", "migration_report_id"],
            ["reason", "reason"],
            ["authorizedByUserId", "authorized_by_user_id"],
            ["authorizedByMembershipId", "authorized_by_membership_id"],
            ["authorizedAuthority", "authorized_authority"],
            ["authorizedAtMs", "authorized_at_ms"],
            ["consumedFadId", "consumed_fad_id"],
            ["consumedAtMs", "consumed_at_ms"],
            ["createdAtMs", "created_at_ms"],
            ["updatedAtMs", "updated_at_ms"],
            ["version", "version"],
            ["idempotencyRequestId", "idempotency_request_id"],
            ["migrationReportSha256", "migration_report_sha256"],
            ["bootstrapIdentitySha256", "bootstrap_identity_sha256"],
            ["bootstrapIdempotencyRequestId", "bootstrap_idempotency_request_id"],
            ["bootstrapActivityId", "bootstrap_activity_id"],
            ["bootstrapSecurityAuditEventId", "bootstrap_security_audit_event_id"],
            ["bootstrapActorUserId", "bootstrap_actor_user_id"],
            ["authorizationActivityId", "authorization_activity_id"],
            ["authorizationSecurityAuditEventId", "authorization_security_audit_event_id"],
            ["commissionerNotificationId", "commissioner_notification_id"],
            ["outboxEventId", "outbox_event_id"],
          ]
        ),
        participatingTeams: selectRows(
          openingTeamsStatement.all(scope),
          [
            ["teamId", "team_id"],
            ["name", "team_name"],
            ["status", "team_status"],
            ["primaryColour", "primary_colour"],
            ["secondaryColour", "secondary_colour"],
            ["tertiaryColour", "tertiary_colour"],
            ["patternTemplate", "pattern_template"],
            ["logoReference", "logo_reference"],
            ["version", "version"],
          ]
        ),
        managerAssignments: selectRows(
          openingManagersStatement.all(scope),
          [
            ["managerAssignmentId", "manager_assignment_id"],
            ["teamId", "team_id"],
            ["userId", "user_id"],
            ["membershipId", "membership_id"],
            ["assignmentStatus", "assignment_status"],
            ["acceptedAtMs", "accepted_at_ms"],
            ["endedAtMs", "ended_at_ms"],
            ["version", "version"],
            ["membershipStatus", "membership_status"],
            ["userStatus", "user_status"],
          ]
        ),
        ownerships: selectRows(
          openingOwnershipsStatement.all(scope),
          [
            ["ownershipId", "ownership_id"],
            ["teamId", "team_id"],
            ["playerId", "player_id"],
            ["ownershipKind", "ownership_kind"],
            ["rosterCategory", "roster_category"],
            ["positionGroup", "position_group"],
            ["slotNumber", "slot_number"],
            ["version", "version"],
            ["playerStatus", "player_status"],
          ]
        ),
        activeContracts: selectRows(
          openingContractsStatement.all(scope),
          [
            ["contractId", "contract_id"],
            ["playerId", "player_id"],
            ["currentTeamId", "current_team_id"],
            ["contractType", "contract_type"],
            ["originalTotalValueCents", "original_total_value_cents"],
            ["originalTermYears", "original_term_years"],
            ["aavCents", "aav_cents"],
            ["startSeasonId", "start_season_id"],
            ["status", "status"],
            ["version", "version"],
          ]
        ),
        allContracts: selectRows(
          openingAllContractsStatement.all(scope),
          [
            ["contractId", "contract_id"],
            ["playerId", "player_id"],
            ["currentTeamId", "current_team_id"],
            ["contractType", "contract_type"],
            ["originalTotalValueCents", "original_total_value_cents"],
            ["originalTermYears", "original_term_years"],
            ["aavCents", "aav_cents"],
            ["startSeasonId", "start_season_id"],
            ["status", "status"],
            ["version", "version"],
          ]
        ),
        targetContractYears: selectRows(
          openingContractYearsStatement.all(scope),
          [
            ["contractYearId", "contract_year_id"],
            ["contractId", "contract_id"],
            ["seasonId", "season_id"],
            ["yearNumber", "year_number"],
            ["aavCents", "aav_cents"],
            ["status", "status"],
          ]
        ),
        allContractYears: selectRows(
          openingAllContractYearsStatement.all(scope),
          [
            ["contractYearId", "id"],
            ["leagueId", "league_id"],
            ["contractId", "contract_id"],
            ["seasonId", "season_id"],
            ["yearNumber", "year_number"],
            ["aavCents", "aav_cents"],
            ["status", "status"],
            ["rolloverAtMs", "rollover_at_ms"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        rosterOrderSets: selectRows(
          openingRosterOrderSetsStatement.all(scope),
          [
            ["orderSetId", "id"],
            ["leagueId", "league_id"],
            ["seasonId", "season_id"],
            ["teamId", "team_id"],
            ["updatedByUserId", "updated_by_user_id"],
            ["createdAtMs", "created_at_ms"],
            ["updatedAtMs", "updated_at_ms"],
            ["version", "version"],
          ]
        ),
        rosterOrderEntries: selectRows(
          openingRosterOrderEntriesStatement.all(scope),
          [
            ["orderEntryId", "id"],
            ["leagueId", "league_id"],
            ["orderSetId", "order_set_id"],
            ["ownershipId", "ownership_id"],
            ["positionGroup", "position_group"],
            ["displayOrder", "display_order"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        retentionObligations: selectRows(
          openingRetentionObligationsStatement.all(scope),
          [
            ["obligationId", "id"],
            ["leagueId", "league_id"],
            ["contractId", "contract_id"],
            ["playerId", "player_id"],
            ["originatingTeamId", "originating_team_id"],
            ["responsibleTeamId", "responsible_team_id"],
            ["retainedAavCents", "retained_aav_cents"],
            ["creationTradeId", "creation_trade_id"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
            ["updatedAtMs", "updated_at_ms"],
            ["version", "version"],
          ]
        ),
        retentionYears: selectRows(
          openingRetentionYearsStatement.all(scope),
          [
            ["retentionYearId", "id"],
            ["leagueId", "league_id"],
            ["retentionObligationId", "retention_obligation_id"],
            ["seasonId", "season_id"],
            ["retainedAavCents", "retained_aav_cents"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        buyoutObligations: selectRows(
          openingBuyoutObligationsStatement.all(scope),
          [
            ["obligationId", "id"],
            ["leagueId", "league_id"],
            ["contractId", "contract_id"],
            ["playerId", "player_id"],
            ["originatingTeamId", "originating_team_id"],
            ["responsibleTeamId", "responsible_team_id"],
            ["annualPenaltyBasisCents", "annual_penalty_basis_cents"],
            ["buyoutTransactionId", "buyout_transaction_id"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
            ["updatedAtMs", "updated_at_ms"],
            ["version", "version"],
          ]
        ),
        buyoutYears: selectRows(
          openingBuyoutYearsStatement.all(scope),
          [
            ["buyoutYearId", "id"],
            ["leagueId", "league_id"],
            ["buyoutObligationId", "buyout_obligation_id"],
            ["seasonId", "season_id"],
            ["penaltyCents", "penalty_cents"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        priorSeasonContractYears: selectRows(
          sourceScope
            ? openingPriorContractYearsStatement.all(sourceScope)
            : [],
          [
            ["contractYearId", "id"],
            ["leagueId", "league_id"],
            ["contractId", "contract_id"],
            ["seasonId", "season_id"],
            ["yearNumber", "year_number"],
            ["aavCents", "aav_cents"],
            ["status", "status"],
            ["rolloverAtMs", "rollover_at_ms"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        priorSeasonRetentionYears: selectRows(
          sourceScope
            ? openingPriorRetentionYearsStatement.all(sourceScope)
            : [],
          [
            ["retentionYearId", "id"],
            ["leagueId", "league_id"],
            ["retentionObligationId", "retention_obligation_id"],
            ["seasonId", "season_id"],
            ["retainedAavCents", "retained_aav_cents"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        priorSeasonBuyoutYears: selectRows(
          sourceScope
            ? openingPriorBuyoutYearsStatement.all(sourceScope)
            : [],
          [
            ["buyoutYearId", "id"],
            ["leagueId", "league_id"],
            ["buyoutObligationId", "buyout_obligation_id"],
            ["seasonId", "season_id"],
            ["penaltyCents", "penalty_cents"],
            ["status", "status"],
            ["createdAtMs", "created_at_ms"],
          ]
        ),
        leaguePositionOverrides: selectRows(
          openingLeaguePositionsStatement.all(scope),
          [
            ["positionOverrideId", "id"],
            ["playerId", "player_id"],
            ["positionGroup", "position_group"],
            ["effectiveAtMs", "effective_at_ms"],
            ["version", "version"],
          ]
        ),
        currentPlayerSources: selectRows(
          openingPlayerSourcesStatement.all(scope),
          [
            ["playerSourceStateId", "id"],
            ["playerId", "player_id"],
            ["provider", "provider"],
            ["normalizedPosition", "normalized_position"],
            ["active", "active"],
            ["effectiveAtMs", "effective_at_ms"],
          ]
        ),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadOpeningPreflightContext",
        tableName:
          "free_agent_draft_readiness_operations",
      });
    }
  }

  function readReadiness(input) {
    const scope = normalizeReadinessInput(input);
    try {
      const authority = requireViewerAuthority(scope);
      requireAdministrativeAuthority(scope, authority);
      const season = unique(
        openingSeasonStatement,
        scope,
        "The FAD readiness season"
      );
      if (!season) {
        notFound(
          "The scoped FAD readiness season was not found."
        );
      }
      const readiness = unique(
        readinessStatement,
        scope,
        "The FAD readiness operation"
      );
      if (!readiness) {
        return deepFreeze({
          leagueId: scope.leagueId,
          seasonId: scope.seasonId,
          operationId: null,
          operationVersion: null,
          status: "not_triggered",
          triggerKind: null,
          entryDraftId: null,
          exemptionId: null,
          serverNowMs: scope.nowMs,
          timeZone: season.timezone,
          observedSeasonVersion: null,
          firstMatchupWeekBefore: null,
          firstMatchupWeekAfter: null,
          candidateDeadlineAtMs: null,
          reminderAtMs: null,
          helpOpensAtMs: null,
          initialRollovers: [],
          priorSeasonRollover: null,
          participatingTeamCount: 0,
          teamProjections: [],
          blockers: [],
          warnings: [],
          resultFadId: null,
          retryReadiness: blockedCapability(
            "RECOVERY_NOT_AVAILABLE"
          ),
        });
      }
      const job = readiness.job_run_id
        ? unique(
            readinessJobStatement,
            {
              ...scope,
              jobRunId: readiness.job_run_id,
            },
            "The FAD readiness job"
          )
        : null;
      if (
        !job ||
        job.season_id !== scope.seasonId ||
        job.job_type !== "fad_readiness" ||
        job.occurrence_key !==
          readiness.readiness_occurrence_key ||
        job.scheduled_for_ms !== readiness.created_at_ms ||
        job.created_at_ms !== readiness.created_at_ms
      ) {
        incompatible(
          "The FAD readiness operation and canonical job are split."
        );
      }
      const attempt = latestReadinessAttempt(
        scope,
        readiness
      );
      const projection = attempt?.projection || null;
      if (
        readiness.created_fad_id !== null
      ) {
        const fad = unique(
          currentFadStatement,
          scope,
          "The readiness result FAD"
        );
        if (!fad || fad.id !== readiness.created_fad_id) {
          incompatible(
            "The FAD readiness result identity is unavailable."
          );
        }
      }
      return deepFreeze({
        leagueId: scope.leagueId,
        seasonId: scope.seasonId,
        operationId: readiness.id,
        operationVersion: readiness.version,
        status: readiness.status,
        triggerKind: readiness.trigger_kind,
        entryDraftId: readiness.entry_draft_id,
        exemptionId: readiness.setup_exemption_id,
        serverNowMs: scope.nowMs,
        timeZone: season.timezone,
        observedSeasonVersion:
          projection?.observedSeasonVersion ?? null,
        firstMatchupWeekBefore:
          projection?.firstMatchupWeekBefore ?? null,
        firstMatchupWeekAfter:
          projection?.firstMatchupWeekAfter ?? null,
        candidateDeadlineAtMs:
          projection?.candidateDeadlineAtMs ?? null,
        reminderAtMs:
          projection?.reminderAtMs ?? null,
        helpOpensAtMs:
          projection?.helpOpensAtMs ?? null,
        initialRollovers:
          projection?.initialRollovers || [],
        priorSeasonRollover:
          projection?.priorSeasonRollover ?? null,
        participatingTeamCount:
          projection?.participatingTeamCount ?? 0,
        teamProjections:
          projection?.teamProjections || [],
        blockers: projection?.blockers || [],
        warnings: projection?.warnings || [],
        resultFadId: readiness.created_fad_id,
        retryReadiness: canonicalReadinessJob(
          readiness,
          job,
          attempt,
          {
            currentSeasonId:
              authority.current_season_id,
            nowMs: scope.nowMs,
          }
        )
          ? allowedCapability()
          : blockedCapability(
              "RECOVERY_NOT_AVAILABLE"
            ),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadReadiness",
        tableName:
          "free_agent_draft_readiness_operations",
      });
    }
  }

  function rosterDescriptorForRow(
    row,
    authority,
    nowMs
  ) {
    if (row.deadline_locked_at_ms !== null) {
      return cardDescriptor(
        row,
        "published_card",
        null
      );
    }
    if (row.manager_assignment_id !== null) {
      return cardDescriptor(
        row,
        "private_card",
        freeze({
          kind: "manager_assignment",
          id: row.manager_assignment_id,
        })
      );
    }
    const activeHelp =
      authority.administrative &&
      row.help_request_id !== null &&
      row.help_request_status === "active" &&
      nowMs >= row.help_opens_at_ms &&
      nowMs < row.help_expires_at_ms &&
      nowMs < row.candidate_deadline_at_ms;
    return activeHelp
      ? cardDescriptor(
          row,
          "private_card",
          freeze({
            kind: "help_request",
            id: row.help_request_id,
          })
        )
      : null;
  }

  function currentRosterLinks({
    authority,
    fad,
    input,
    managedRows,
    allRows,
  }) {
    if (input.rosterSeasonId !== null) {
      const row = unique(
        rosterCardStatement,
        input,
        "The scoped Candidate Card roster descriptor"
      );
      if (!row) return [];
      const descriptor = rosterDescriptorForRow(
        row,
        authority,
        input.nowMs
      );
      return descriptor ? [descriptor] : [];
    }
    if (!fad) return [];
    if (fad.deadline_locked_at_ms !== null) {
      return allRows.map((row) =>
        cardDescriptor(row, "published_card", null)
      );
    }
    const descriptors = managedRows.map((row) =>
      cardDescriptor(
        row,
        "private_card",
        freeze({
          kind: "manager_assignment",
          id: row.manager_assignment_id,
        })
      )
    );
    if (authority.administrative) {
      const managedTeamIds = new Set(
        managedRows.map((row) => row.team_id)
      );
      for (const row of allRows) {
        if (managedTeamIds.has(row.team_id)) continue;
        const activeHelp =
          row.help_request_id !== null &&
          row.help_request_status === "active" &&
          input.nowMs >= fad.help_opens_at_ms &&
          input.nowMs < row.help_expires_at_ms &&
          input.nowMs < fad.candidate_deadline_at_ms;
        if (activeHelp) {
          descriptors.push(
            cardDescriptor(
              row,
              "private_card",
              freeze({
                kind: "help_request",
                id: row.help_request_id,
              })
            )
          );
        }
      }
    }
    return descriptors.sort((left, right) =>
      left.teamId.localeCompare(right.teamId)
    );
  }

  function cardUrgency({
    phase,
    row,
    restrictedTeamIds,
    rapidActive,
  }) {
    if (phase === "deadline_processing") {
      return "DEADLINE_PROCESSING";
    }
    const prepublication = [
      "cards_open",
      "help_window",
    ].includes(phase);
    if (
      prepublication &&
      (
        row.completeness_code === "conflicted" ||
        row.structural_conflict_count > 0
      )
    ) {
      return "CARD_CONFLICTED";
    }
    const incomplete =
      row.completeness_code !== "complete" ||
      row.cap_status !== "compliant" ||
      row.allocation_eligibility !== "eligible";
    if (
      prepublication &&
      phase === "help_window" &&
      incomplete
    ) {
      return "HELP_WINDOW_INCOMPLETE";
    }
    if (prepublication && incomplete) {
      return "CARD_INCOMPLETE";
    }
    if (restrictedTeamIds.has(row.team_id)) {
      return "RESTRICTED_ACTION_REQUIRED";
    }
    if (rapidActive) {
      return "RAPID_AUCTIONS_ACTIVE";
    }
    return "NONE";
  }

  function readNavigation(input) {
    const scope = normalizeNavigationInput(input);
    try {
      const authority = requireViewerAuthority(scope);
      const fad = authority.current_season_id
        ? unique(
            currentFadStatement,
            {
              leagueId: scope.leagueId,
              seasonId: authority.current_season_id,
            },
            "The current league FAD"
          )
        : null;
      const phase = viewerPhase(fad, scope.nowMs);
      const managedRows = fad
        ? readManagedCards(scope, fad.id)
        : [];
      const allRows = fad
        ? readAllCards(scope, fad)
        : [];
      const competitionWeek = fad
        ? readCompetitionWeek(scope, fad)
        : null;
      const restrictedTeamIds = fad
        ? new Set(
            restrictedManagerActionsStatement
              .all({
                ...scope,
                fadId: fad.id,
              })
              .map((row) => row.team_id)
          )
        : new Set();
      const rapidActive = fad
        ? rapidAuctionsStatement.get({
            ...scope,
            fadId: fad.id,
          }).count > 0
        : false;
      const managedCards = managedRows.map((row) =>
        freeze({
          ...cardSummary(row, scope.nowMs),
          managerAssignmentId:
            row.manager_assignment_id,
          urgencyCode: cardUrgency({
            phase,
            row,
            restrictedTeamIds,
            rapidActive,
          }),
        })
      );
      let urgencyCode = "NONE";
      for (const candidate of [
        "DEADLINE_PROCESSING",
        "CARD_CONFLICTED",
        "HELP_WINDOW_INCOMPLETE",
        "CARD_INCOMPLETE",
        "RESTRICTED_ACTION_REQUIRED",
        "RAPID_AUCTIONS_ACTIVE",
      ]) {
        if (
          managedCards.some(
            (card) => card.urgencyCode === candidate
          )
        ) {
          urgencyCode = candidate;
          break;
        }
      }
      if (
        urgencyCode === "NONE" &&
        phase === "deadline_processing"
      ) {
        urgencyCode = "DEADLINE_PROCESSING";
      }
      if (
        urgencyCode === "NONE" &&
        rapidActive
      ) {
        urgencyCode = "RAPID_AUCTIONS_ACTIVE";
      }
      const nextRollover =
        fad?.status === "rapid"
          ? nextRolloverStatement.get({
              leagueId: scope.leagueId,
              fadId: fad.id,
            }) || null
          : null;
      return deepFreeze({
        serverNowMs: scope.nowMs,
        timeZone: authority.timezone,
        fadId: fad?.id || null,
        seasonId: fad?.season_id || null,
        phase,
        showMainNavigation:
          Boolean(fad) &&
          fad.status !== "completed" &&
          scope.nowMs <
            competitionWeek.starts_at_ms,
        candidateDeadlineAtMs:
          fad?.candidate_deadline_at_ms ?? null,
        nextRolloverAtMs:
          nextRollover?.rolls_over_at_ms ?? null,
        frozenFadFirstMatchupStartsAtMs:
          fad?.first_matchup_starts_at_ms ?? null,
        competitionFirstMatchupStartsAtMs:
          competitionWeek?.starts_at_ms ?? null,
        managedCards,
        rosterLinks: currentRosterLinks({
          authority,
          fad,
          input: scope,
          managedRows,
          allRows,
        }),
        urgencyCode,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadNavigation",
        tableName: "free_agent_drafts",
      });
    }
  }

  function overviewCountProjection(
    row,
    { administrative, published }
  ) {
    if (
      !row ||
      Object.values(row).some(
        (value) =>
          !Number.isSafeInteger(value) || value < 0
      )
    ) {
      incompatible(
        "The FAD overview counts are invalid."
      );
    }
    const visible = administrative || published;
    return freeze({
      participatingTeams: row.participating_teams,
      cardsLocked: visible ? row.cards_locked : null,
      allocationsPending:
        visible ? row.allocations_pending : null,
      allocationsAutomatic:
        visible ? row.allocations_automatic : null,
      restrictedPending:
        visible ? row.restricted_pending : null,
      restrictedFallbackPending:
        visible
          ? row.restricted_fallback_pending
          : null,
      rapidAuctionsOpen:
        visible ? row.rapid_auctions_open : null,
      rolloversPersisted:
        visible ? row.rollovers_persisted : null,
      rolloversCompleted:
        visible ? row.rollovers_completed : null,
      recoveriesOpen:
        visible ? row.recoveries_open : null,
    });
  }

  function commissionerCardProjection(
    row,
    fad,
    nowMs
  ) {
    const status = helpRequestStatus(row, nowMs);
    const hasHelp = status !== "not_requested";
    const activePrivateHelp =
      status === "active" &&
      fad.deadline_locked_at_ms === null &&
      nowMs >= fad.help_opens_at_ms &&
      nowMs < fad.candidate_deadline_at_ms &&
      nowMs < row.help_expires_at_ms;
    return freeze({
      teamId: row.team_id,
      team: teamProjection(row),
      lifecycleStatus: row.card_status,
      completenessCode: row.completeness_code,
      missingMandatoryCount:
        row.missing_mandatory_count,
      conflictCount: row.structural_conflict_count,
      capStatus: row.cap_status,
      allocationEligibility:
        row.allocation_eligibility,
      helpRequestStatus: status,
      helpRequestId:
        hasHelp ? row.help_request_id : null,
      helpRequestedAtMs:
        hasHelp ? row.help_requested_at_ms : null,
      openPrivateCard: activePrivateHelp
        ? allowedCapability()
        : blockedCapability(
            hasHelp ? "PHASE_CLOSED" : "HELP_NOT_GRANTED"
          ),
    });
  }

  function readOverview(input) {
    const scope = normalizeOverviewInput(input);
    try {
      const authority = requireViewerAuthority(scope);
      const fad = unique(
        fadByIdStatement,
        scope,
        "The scoped FAD overview"
      );
      if (!fad) {
        notFound(
          "The scoped Free Agent Draft was not found."
        );
      }
      const phase = viewerPhase(fad, scope.nowMs);
      const allRows = readAllCards(scope, fad);
      const managedRows = readManagedCards(
        scope,
        fad.id
      );
      const competitionWeek = readCompetitionWeek(
        scope,
        fad
      );
      const published =
        fad.deadline_locked_at_ms !== null;
      const countsRow = overviewCountsStatement.get({
        leagueId: scope.leagueId,
        fadId: fad.id,
      });
      if (
        countsRow.participating_teams !==
          fad.participating_team_count
      ) {
        incompatible(
          "The FAD participant count is inconsistent."
        );
      }
      const managedCards = managedRows.map((row) =>
        freeze({
          ...cardSummary(row, scope.nowMs),
          managerAssignmentId:
            row.manager_assignment_id,
          cardDescriptor: published
            ? cardDescriptor(
                row,
                "published_card",
                null
              )
            : cardDescriptor(
                row,
                "private_card",
                freeze({
                  kind: "manager_assignment",
                  id: row.manager_assignment_id,
                })
              ),
        })
      );
      const commissionerCards =
        authority.administrative
          ? allRows.map((row) =>
              commissionerCardProjection(
                row,
                fad,
                scope.nowMs
              )
            )
          : [];
      const queuedNominations =
        queuedNominationsStatement
          .all({
            ...scope,
            fadId: fad.id,
          })
          .map((row) =>
            freeze({
              queueId: row.queue_id,
              teamId: row.team_id,
              player: playerProjection(row),
              totalValueCents:
                row.opening_total_value_cents,
              termYears: row.opening_term_years,
              aavCents: row.opening_aav_cents,
              submittedAtMs: row.accepted_at_ms,
              opensAtRolloverId:
                row.target_opening_rollover_id,
              targetRolloverId:
                row.resolution_rollover_id,
              status: row.status,
              cancel: blockedCapability(
                "PHASE_CLOSED"
              ),
            })
          );
      const recoveries = recoveryRowsStatement.all({
        leagueId: scope.leagueId,
        fadId: fad.id,
      });
      if (
        recoveries.some(
          (row) =>
            !ACTIONABLE_RECOVERY_KINDS.includes(
              row.kind
            ) ||
            ![
              "pending",
              "ready",
              "running",
              "resolved",
              "correction_required",
            ].includes(row.status)
        )
      ) {
        incompatible(
          "The FAD recovery projection is noncanonical."
        );
      }
      const actionableRecoveries = recoveries.filter(
        (row) =>
          ["pending", "ready"].includes(row.status)
      );
      let scheduleRecovery = null;
      if (fad.schedule_recovery_id !== null) {
        scheduleRecovery = unique(
          completionScheduleRecoveryStatement,
          {
            leagueId: scope.leagueId,
            seasonId: fad.season_id,
            fadId: fad.id,
            scheduleRecoveryId:
              fad.schedule_recovery_id,
          },
          "The FAD completion schedule recovery"
        );
        if (
          !scheduleRecovery ||
          scheduleRecovery.recovery_kind !== "completion"
        ) {
          incompatible(
            "The FAD completion schedule-recovery identity is invalid."
          );
        }
      }
      const nextRollover =
        nextRolloverStatement.get({
          leagueId: scope.leagueId,
          fadId: fad.id,
        }) || null;
      return deepFreeze({
        leagueId: fad.league_id,
        seasonId: fad.season_id,
        fadId: fad.id,
        version: fad.version,
        status: fad.status,
        phase,
        serverNowMs: scope.nowMs,
        timeZone: authority.timezone,
        openedAtMs: fad.opened_at_ms,
        reminderAtMs:
          fad.candidate_deadline_at_ms -
          FREE_AGENT_DRAFT_REMINDER_LEAD_MS,
        helpOpensAtMs: fad.help_opens_at_ms,
        candidateDeadlineAtMs:
          fad.candidate_deadline_at_ms,
        deadlineLockedAtMs:
          fad.deadline_locked_at_ms,
        allocationCompletedAtMs:
          fad.allocation_completed_at_ms,
        nextRolloverAtMs:
          nextRollover?.rolls_over_at_ms ?? null,
        frozenFadFirstMatchupStartsAtMs:
          fad.first_matchup_starts_at_ms,
        competitionFirstMatchupStartsAtMs:
          competitionWeek.starts_at_ms,
        scheduleRecoveryOperationId:
          scheduleRecovery?.matchup_operation_id ?? null,
        completedAtMs: fad.completed_at_ms,
        counts: overviewCountProjection(countsRow, {
          administrative: authority.administrative,
          published,
        }),
        viewer: freeze({
          managedCards,
          commissionerCards,
          queuedNominations,
        }),
        presentation: null,
        capabilities: freeze({
          viewPublishedCards: published
            ? allowedCapability()
            : blockedCapability("PHASE_CLOSED"),
          viewRecovery: authority.administrative
            ? allowedCapability()
            : blockedCapability("NOT_AUTHORIZED"),
          completeRecoveryAction:
            !authority.administrative
              ? blockedCapability("NOT_AUTHORIZED")
              : actionableRecoveries.length === 1
                ? allowedCapability()
                : blockedCapability(
                    "RECOVERY_NOT_AVAILABLE"
                  ),
        }),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadOverview",
        tableName: "free_agent_drafts",
      });
    }
  }

  function publishedSnapshotRows(snapshot) {
    const rows = publishedSnapshotEntriesStatement.all({
      leagueId: snapshot.league_id,
      seasonId: snapshot.season_id,
      fadId: snapshot.fad_id,
      snapshotId: snapshot.id,
      cardId: snapshot.card_id,
      teamId: snapshot.team_id,
    });
    const slots = rows.filter(
      (row) => row.row_kind === "slot"
    );
    const slotKeys = slots.map((row) =>
      candidateSlotKey(
        row.slot_group,
        row.slot_number
      )
    );
    if (
      slots.length !== 22 ||
      new Set(slotKeys).size !== 22 ||
      rows.filter(
        (row) => row.row_kind === "conflict"
      ).length !==
        snapshot.structural_conflict_count
    ) {
      incompatible(
        "The published Candidate Card does not contain its exact locked rows."
      );
    }
    return rows;
  }

  function offerEventFor(
    allocation,
    snapshotEntryId
  ) {
    return unique(
      allocationOfferEventStatement,
      {
        leagueId: allocation.league_id,
        fadId: allocation.fad_id,
        allocationId: allocation.id,
        snapshotEntryId,
      },
      "The current Candidate allocation offer event"
    );
  }

  function publishedCandidateOutcome(row) {
    if (row.occupant_kind === "carryover") {
      return freeze({
        code: "carryover",
        allocationId: null,
        auctionId: null,
      });
    }
    if (row.occupant_kind !== "candidate") {
      return null;
    }
    const allocation = unique(
      allocationByPlayerStatement,
      {
        leagueId: row.league_id,
        fadId: row.fad_id,
        playerId: row.player_id,
      },
      "The published Candidate allocation"
    );
    if (!allocation) {
      incompatible(
        "A published Candidate offer has no allocation."
      );
    }
    const event = offerEventFor(
      allocation,
      row.id
    );
    if (allocation.status === "pending") {
      if (event !== null) {
        incompatible(
          "A pending allocation has premature offer evidence."
        );
      }
      return null;
    }
    if (event === null) {
      if (allocation.status === "correction_required") {
        return null;
      }
      incompatible(
        "A processed Candidate allocation is missing offer evidence."
      );
    }
    const invalidOffer = [
      "invalid",
      "excluded_structural_conflict",
      "excluded_over_cap",
    ].includes(event.offer_outcome_code);
    let code;
    let auctionId = null;
    if (invalidOffer) {
      code = "invalid_offer";
    } else if (
      ["no_valid_offer", "invalid"].includes(
        allocation.status
      )
    ) {
      code = "invalid_offer";
    } else if (
      allocation.status === "automatic_award"
    ) {
      code =
        allocation.winning_snapshot_entry_id === row.id
          ? "automatic_win"
          : "automatic_loss";
    } else if (
      [
        "restricted_scheduled",
        "restricted_active",
      ].includes(allocation.status)
    ) {
      code =
        event.offer_outcome_code ===
        "restricted_tied"
          ? "restricted_pending"
          : "automatic_loss";
      auctionId =
        allocation.status === "restricted_scheduled"
          ? null
          : allocation.restricted_auction_id;
    } else if (
      allocation.status ===
      "restricted_fallback_open"
    ) {
      code =
        event.offer_outcome_code ===
        "restricted_tied"
          ? "fallback_pending"
          : "automatic_loss";
      auctionId = allocation.fallback_open_auction_id;
    } else if (
      allocation.status === "restricted_resolved"
    ) {
      if (
        event.offer_outcome_code !==
        "restricted_tied" &&
        event.offer_outcome_code !== "winner"
      ) {
        code = "automatic_loss";
      } else {
        code =
          allocation.winning_snapshot_entry_id === row.id
            ? "restricted_win"
            : "restricted_loss";
      }
      auctionId = allocation.restricted_auction_id;
    } else if (
      allocation.status === "fallback_open_resolved"
    ) {
      if (
        event.offer_outcome_code !==
        "restricted_tied"
      ) {
        code = "automatic_loss";
      } else if (
        allocation.decision_code ===
        "fallback_open_no_winner"
      ) {
        code = "fallback_no_winner";
      } else {
        code =
          allocation.winning_team_id === row.team_id
            ? "fallback_win"
            : "fallback_loss";
      }
      auctionId = allocation.fallback_open_auction_id;
    } else {
      return null;
    }
    return freeze({
      code,
      allocationId: allocation.id,
      auctionId,
    });
  }

  function completenessProjection(snapshot) {
    return freeze({
      code: snapshot.completeness_code,
      filledMandatoryCount:
        snapshot.filled_mandatory_count,
      missingMandatoryCount:
        snapshot.missing_mandatory_count,
      filledBenchCount:
        snapshot.filled_bench_count,
      emptyBenchCount:
        snapshot.empty_bench_count,
      blockingValidationCount:
        snapshot.blocking_validation_count,
      structuralConflictCount:
        snapshot.structural_conflict_count,
      carriedRosterStructuralConflictCount:
        snapshot
          .carried_roster_structural_conflict_count,
    });
  }

  function interventionProjection(snapshot) {
    return publishedInterventionsStatement
      .all({
        leagueId: snapshot.league_id,
        seasonId: snapshot.season_id,
        fadId: snapshot.fad_id,
        cardId: snapshot.card_id,
        teamId: snapshot.team_id,
      })
      .map((row) => {
        if (
          !UUID_PATTERN.test(row.actor_user_id || "") ||
          typeof row.display_name !== "string"
        ) {
          incompatible(
            "Published Candidate intervention evidence is invalid."
          );
        }
        return freeze({
          revisionId: row.id,
          entryId: row.affected_entry_id,
          action: row.action,
          actorUserId: row.actor_user_id,
          actorDisplayName: row.display_name,
          authority: row.actor_authority,
          occurredAtMs: row.occurred_at_ms,
        });
      });
  }

  function outcomeCounts(rows) {
    const counts = {
      automaticWins: 0,
      restrictedPending: 0,
      restrictedWins: 0,
      fallbackPending: 0,
      fallbackWins: 0,
      fallbackNoWinner: 0,
      losses: 0,
      invalidOffers: 0,
    };
    for (const row of rows) {
      if (row.occupant_kind !== "candidate") {
        continue;
      }
      const outcome = publishedCandidateOutcome(row);
      if (outcome === null) continue;
      const key = {
        automatic_win: "automaticWins",
        restricted_pending: "restrictedPending",
        restricted_win: "restrictedWins",
        fallback_pending: "fallbackPending",
        fallback_win: "fallbackWins",
        fallback_no_winner: "fallbackNoWinner",
        invalid_offer: "invalidOffers",
      }[outcome.code];
      if (key) {
        counts[key] += 1;
      } else if (
        [
          "automatic_loss",
          "restricted_loss",
          "fallback_loss",
        ].includes(outcome.code)
      ) {
        counts.losses += 1;
      }
    }
    return freeze(counts);
  }

  function publishedSummaryProjection(snapshot) {
    const rows = publishedSnapshotRows(snapshot);
    const conflicts = rows.filter(
      (row) => row.row_kind === "conflict"
    );
    const slots = rows.filter(
      (row) => row.row_kind === "slot"
    );
    const interventions =
      interventionProjection(snapshot);
    return freeze({
      leagueId: snapshot.league_id,
      seasonId: snapshot.season_id,
      fadId: snapshot.fad_id,
      teamId: snapshot.team_id,
      team: teamProjection(snapshot),
      snapshotId: snapshot.id,
      lockedCardVersion:
        snapshot.locked_card_version,
      lifecycleStatus: snapshot.locked_status,
      completeness:
        completenessProjection(snapshot),
      capStatus: snapshot.cap_status,
      allocationEligibility:
        snapshot.allocation_eligibility,
      allocationExclusionReason:
        snapshot.allocation_exclusion_reason,
      maximumPossibleCapCents:
        snapshot.maximum_possible_cap_cents,
      carriedCapUsageCents:
        snapshot.carried_cap_usage_cents,
      counts: freeze({
        carryovers: rows.filter(
          (row) =>
            row.occupant_kind === "carryover"
        ).length,
        candidates: rows.filter(
          (row) =>
            row.occupant_kind === "candidate"
        ).length,
        emptyMandatory: slots.filter(
          (row) =>
            ["F", "D"].includes(row.slot_group) &&
            row.occupant_kind === "empty"
        ).length,
        emptyBench: slots.filter(
          (row) =>
            row.slot_group === "B" &&
            row.occupant_kind === "empty"
        ).length,
        conflicts: conflicts.length,
      }),
      outcomeCounts: outcomeCounts(rows),
      commissionerInterventionCount:
        interventions.length,
      historyDescriptor: freeze({
        mode: "published_card",
        seasonId: snapshot.season_id,
        fadId: snapshot.fad_id,
        teamId: snapshot.team_id,
        cardId: snapshot.card_id,
      }),
    });
  }

  function readPublishedCardSummaries(input) {
    const scope = normalizePublishedSummaryInput(
      input
    );
    try {
      requireViewerAuthority(scope);
      const fad = requirePublishedFad(scope);
      const snapshotCount =
        publishedSnapshotCountStatement.get(scope).count;
      if (
        snapshotCount !==
        fad.participating_team_count
      ) {
        incompatible(
          "Published Candidate Card coverage is incomplete."
        );
      }
      const rows = publishedSummaryPageStatement.all({
        leagueId: scope.leagueId,
        fadId: scope.fadId,
        cursorSortName:
          scope.query.cursor?.sortName ?? null,
        cursorTeamId:
          scope.query.cursor?.teamId ?? null,
        limitPlusOne: scope.query.limit + 1,
      });
      const hasMore =
        rows.length > scope.query.limit;
      const pageRows = rows.slice(
        0,
        scope.query.limit
      );
      for (const row of pageRows) {
        if (
          normalizedTeamSortName(
            row.team_name
          ) !== row.team_sort_name
        ) {
          incompatible(
            "Published Candidate team ordering evidence is invalid."
          );
        }
      }
      const last =
        hasMore && pageRows.length > 0
          ? pageRows.at(-1)
          : null;
      return deepFreeze({
        data: pageRows.map(
          publishedSummaryProjection
        ),
        page: {
          nextCursor:
            last === null
              ? null
              : encodePublishedCursor(
                  scope.query.filter,
                  last.team_sort_name,
                  "teamId",
                  last.team_id
                ),
          hasMore,
        },
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readPublishedCandidateCardSummaries",
        tableName: "candidate_card_snapshots",
      });
    }
  }

  function publishedSlotProjection(row) {
    const empty = row.occupant_kind === "empty";
    const carryover =
      row.occupant_kind === "carryover";
    if (
      !["empty", "carryover", "candidate"].includes(
        row.occupant_kind
      )
    ) {
      incompatible(
        "A published Candidate slot occupant is invalid."
      );
    }
    return freeze({
      slotKey: candidateSlotKey(
        row.slot_group,
        row.slot_number
      ),
      slotGroup: row.slot_group,
      required: ["F", "D"].includes(
        row.slot_group
      ),
      occupantKind: row.occupant_kind,
      entryId: empty ? null : row.source_entry_id,
      entryVersion: empty
        ? null
        : row.source_entry_version,
      player: empty
        ? null
        : snapshotPlayerProjection(row),
      authoritativeRosterCategory: carryover
        ? row.source_roster_category
        : null,
      locked: carryover,
      totalValueCents: carryover
        ? row.carryover_original_total_value_cents
        : row.proposed_total_value_cents,
      termYears: carryover
        ? row.carryover_original_term_years
        : row.proposed_term_years,
      aavCents: carryover
        ? row.carryover_aav_cents
        : row.proposed_aav_cents,
      remainingYears: carryover
        ? row.remaining_years
        : null,
      validation: publishedValidation(row),
      outcome: empty
        ? null
        : publishedCandidateOutcome(row),
      lastEditedAtMs: empty
        ? null
        : row.last_edited_at_ms,
      lastEditedBy: publishedLastEditor(row),
      capabilities: publishedSlotCapabilities(),
    });
  }

  function publishedConflictProjection(row) {
    if (
      row.row_kind !== "conflict" ||
      row.occupant_kind === "empty" ||
      row.conflict_code === null
    ) {
      incompatible(
        "A published Candidate conflict is invalid."
      );
    }
    return freeze({
      entryId: row.source_entry_id,
      entryVersion: row.source_entry_version,
      player: snapshotPlayerProjection(row),
      intendedSlotKey: candidateSlotKey(
        row.slot_group,
        row.slot_number
      ),
      conflictCode: row.conflict_code,
      validation: publishedValidation(row),
      lastEditedBy: publishedLastEditor(row),
    });
  }

  function readPublishedCardHistory(input) {
    const scope = normalizePublishedHistoryInput(
      input
    );
    try {
      requireViewerAuthority(scope);
      requirePublishedFad(scope);
      const snapshot = unique(
        publishedSnapshotStatement,
        scope,
        "The published Candidate Card history"
      );
      if (!snapshot) {
        throw repositoryError(
          FREE_AGENT_DRAFT_READ_REPOSITORY_CODES
            .candidateCardNotFound,
          "The published Candidate Card was not found."
        );
      }
      const rows = publishedSnapshotRows(snapshot);
      const slots = rows
        .filter((row) => row.row_kind === "slot")
        .map(publishedSlotProjection);
      const conflicts = rows
        .filter(
          (row) => row.row_kind === "conflict"
        )
        .map(publishedConflictProjection);
      const phase = viewerPhase(
        {
          status: snapshot.fad_status,
          opened_at_ms: snapshot.opened_at_ms,
          help_opens_at_ms:
            snapshot.help_opens_at_ms,
          candidate_deadline_at_ms:
            snapshot.candidate_deadline_at_ms,
        },
        scope.nowMs
      );
      return deepFreeze({
        leagueId: snapshot.league_id,
        seasonId: snapshot.season_id,
        fadId: snapshot.fad_id,
        teamId: snapshot.team_id,
        cardId: snapshot.card_id,
        cardVersion:
          snapshot.locked_card_version,
        phase,
        visibilityMode: "published_history",
        accessReason:
          "published_league_history",
        authorizationEvidence: null,
        lifecycleStatus: snapshot.locked_status,
        completeness:
          completenessProjection(snapshot),
        capProjection: freeze({
          capLimitCents: snapshot.cap_limit_cents,
          carriedActivePlayerAmountCents:
            snapshot
              .carried_active_player_amount_cents,
          retentionObligationCents:
            snapshot.retention_obligation_cents,
          buyoutPenaltyCents:
            snapshot.buyout_penalty_cents,
          carriedCapUsageCents:
            snapshot.carried_cap_usage_cents,
          proposedCandidateAavCents:
            snapshot.proposed_candidate_aav_cents,
          maximumPossibleCapCents:
            snapshot.maximum_possible_cap_cents,
          maximumCapSpaceCents:
            snapshot.maximum_cap_space_cents,
        }),
        capStatus: snapshot.cap_status,
        allocationEligibility:
          snapshot.allocation_eligibility,
        allocationExclusionReason:
          snapshot.allocation_exclusion_reason,
        slots,
        conflicts,
        helpContext: null,
        commissionerInterventions:
          interventionProjection(snapshot),
        capabilities: freeze({
          editCard: blockedCapability(
            "PHASE_CLOSED"
          ),
          requestHelp: blockedCapability(
            "PHASE_CLOSED"
          ),
          viewPublishedHistory:
            allowedCapability(),
        }),
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation:
          "readPublishedCandidateCardHistory",
        tableName: "candidate_card_snapshots",
      });
    }
  }

  function rankedOfferProjection(
    row,
    allocation
  ) {
    const pending = allocation.status === "pending";
    if (
      pending &&
      (
        row.offer_valid !== null ||
        row.rank_position !== null ||
        row.offer_outcome_code !== null
      )
    ) {
      incompatible(
        "A pending allocation has premature ranked-offer evidence."
      );
    }
    if (
      !pending &&
      (
        ![0, 1].includes(row.offer_valid) ||
        row.offer_outcome_code === null
      )
    ) {
      incompatible(
        "A processed allocation has incomplete ranked-offer evidence."
      );
    }
    const derivedValid =
      ["valid", "warning"].includes(
        row.eligibility_status
      ) &&
      row.allocation_eligibility === "eligible";
    const rawOutcome = pending
      ? "pending"
      : row.offer_outcome_code;
    const outcomeCode = [
      "excluded_structural_conflict",
      "excluded_over_cap",
    ].includes(rawOutcome)
      ? "invalid"
      : rawOutcome;
    if (
      ![
        "pending",
        "winner",
        "lost_lower_total",
        "lost_lower_aav",
        "restricted_tied",
        "invalid",
      ].includes(outcomeCode)
    ) {
      incompatible(
        "A ranked Candidate outcome is noncanonical."
      );
    }
    const valid = pending
      ? derivedValid
      : row.offer_valid === 1;
    const validationCode =
      row.allocation_exclusion_reason ??
      row.validation_code;
    return freeze({
      snapshotEntryId: row.id,
      teamId: row.team_id,
      team: teamProjection(row),
      slotKey: candidateSlotKey(
        row.slot_group,
        row.slot_number
      ),
      totalValueCents:
        row.proposed_total_value_cents,
      termYears: row.proposed_term_years,
      aavCents: row.proposed_aav_cents,
      valid,
      validationCode,
      rank: pending ? null : row.rank_position,
      outcomeCode,
    });
  }

  function winnerProjection(allocation) {
    if (allocation.winning_team_id === null) {
      return null;
    }
    const row = unique(
      allocationWinnerStatement,
      {
        leagueId: allocation.league_id,
        fadId: allocation.fad_id,
        allocationId: allocation.id,
      },
      "The FAD allocation winner"
    );
    if (
      !row ||
      !UUID_PATTERN.test(row.winning_team_id || "") ||
      !UUID_PATTERN.test(row.contract_id || "") ||
      !UUID_PATTERN.test(row.ownership_id || "") ||
      !Number.isSafeInteger(
        row.original_total_value_cents
      ) ||
      !Number.isSafeInteger(
        row.original_term_years
      ) ||
      !Number.isSafeInteger(row.aav_cents) ||
      row.contract_player_id !==
        allocation.player_id ||
      row.contract_team_id !==
        row.winning_team_id ||
      row.contract_status !== "active" ||
      row.ownership_player_id !==
        allocation.player_id ||
      row.ownership_team_id !==
        row.winning_team_id ||
      row.ownership_season_id !==
        allocation.season_id ||
      row.ownership_kind !== "Rostered"
    ) {
      incompatible(
        "The FAD allocation winner is incomplete."
      );
    }
    let slotKey;
    if (row.winning_snapshot_entry_id !== null) {
      if (
        row.snapshot_player_id !==
          allocation.player_id ||
        row.snapshot_team_id !==
          row.winning_team_id
      ) {
        incompatible(
          "The FAD allocation winner does not match its Candidate snapshot."
        );
      }
      slotKey = candidateSlotKey(
        row.snapshot_slot_group,
        row.snapshot_slot_number
      );
    } else {
      if (
        allocation.status !==
        "fallback_open_resolved"
      ) {
        incompatible(
          "Only a league-wide fallback winner may omit its Candidate snapshot entry."
        );
      }
      const group =
        row.roster_category === "Bench"
          ? "B"
          : row.ownership_position_group;
      slotKey = candidateSlotKey(
        group,
        row.ownership_slot_number
      );
    }
    return freeze({
      teamId: row.winning_team_id,
      snapshotEntryId:
        row.winning_snapshot_entry_id,
      contractId: row.contract_id,
      ownershipId: row.ownership_id,
      slotKey,
      totalValueCents:
        row.original_total_value_cents,
      termYears: row.original_term_years,
      aavCents: row.aav_cents,
    });
  }

  function terminalAuctionStatus(row) {
    if (!row) return null;
    if (
      ["open", "resolving"].includes(
        row.auction_status
      )
    ) {
      return row.auction_status;
    }
    if (row.resolution_status === null) {
      if (row.auction_status === "cancelled") {
        return "cancelled";
      }
      if (row.auction_status === "failed") {
        return "failed";
      }
      incompatible(
        "A terminal FAD auction has no resolution."
      );
    }
    if (
      row.outcome_code === "winner"
    ) {
      return "resolved";
    }
    if (
      [
        "no_winner",
        "player_unavailable",
        "season_closed",
      ].includes(row.outcome_code)
    ) {
      return "no_winner";
    }
    if (row.resolution_status === "cancelled") {
      return "cancelled";
    }
    return "failed";
  }

  function auctionProjections(allocation) {
    const rows = allocationAuctionsStatement.all({
      leagueId: allocation.league_id,
      fadId: allocation.fad_id,
      allocationId: allocation.id,
    });
    if (
      allocation.status === "pending" &&
      rows.length !== 0
    ) {
      incompatible(
        "A pending FAD allocation has premature auction evidence."
      );
    }
    const restrictedRows = rows.filter(
      (row) => row.source_kind === "fad_restricted"
    );
    const fallbackRows = rows.filter(
      (row) =>
        row.source_kind === "fad_open_rapid" &&
        row.fad_origin ===
          "restricted_no_improvement_fallback"
    );
    if (
      restrictedRows.length > 1 ||
      fallbackRows.length > 1
    ) {
      incompatible(
        "A FAD allocation has ambiguous linked auctions."
      );
    }
    const restrictedAuction =
      restrictedRows[0] || null;
    const fallbackAuction = fallbackRows[0] || null;
    const hasRestricted =
      allocation.restricted_minimum_total_cents !==
        null ||
      [
        "restricted_scheduled",
        "restricted_active",
        "restricted_fallback_open",
        "restricted_resolved",
        "fallback_open_resolved",
      ].includes(allocation.status);
    let restricted = null;
    if (hasRestricted) {
      let status;
      if (
        allocation.status === "restricted_scheduled"
      ) {
        status = "scheduled";
      } else if (
        allocation.status ===
        "restricted_fallback_open"
      ) {
        status = "fallback_open";
      } else {
        status = terminalAuctionStatus(
          restrictedAuction
        );
      }
      if (
        status === null ||
        (
          allocation.status !==
            "restricted_scheduled" &&
          restrictedAuction === null
        )
      ) {
        incompatible(
          "Restricted FAD auction evidence is incomplete."
        );
      }
      const participantTeamIds =
        allocation.status === "restricted_scheduled" ||
        restrictedAuction === null
          ? []
          : allocationParticipantsStatement
              .all({
                leagueId: allocation.league_id,
                fadId: allocation.fad_id,
                allocationId: allocation.id,
                auctionId:
                  restrictedAuction.auction_id,
              })
              .map((row) => row.team_id);
      restricted = freeze({
        auctionId:
          allocation.status === "restricted_scheduled"
            ? null
            : restrictedAuction?.auction_id ?? null,
        status,
        participantTeamIds: freeze(
          participantTeamIds
        ),
        minimumTotalValueCents:
          allocation
            .restricted_minimum_total_cents,
        minimumTermYears:
          allocation
            .restricted_minimum_term_years,
        minimumAavCents:
          allocation
            .restricted_minimum_aav_cents,
      });
    }
    const fallback =
      fallbackAuction === null
        ? null
        : freeze({
            auctionId: fallbackAuction.auction_id,
            status:
              terminalAuctionStatus(fallbackAuction),
            minimumTotalValueCents:
              allocation
                .restricted_minimum_total_cents,
            winningBidId:
              fallbackAuction.winning_bid_id,
            contractId:
              fallbackAuction.resolution_contract_id,
            ownershipId:
              fallbackAuction.resolution_ownership_id,
            noWinnerReason:
              fallbackAuction.outcome_code !== null &&
              fallbackAuction.outcome_code !== "winner"
                ? fallbackAuction.outcome_code
                : null,
          });
    return freeze({
      restricted,
      fallback,
      auctionRows: freeze(rows),
    });
  }

  function drawProjection(row, allocation) {
    const auctionStatus = terminalAuctionStatus(row);
    if (["open", "resolving"].includes(auctionStatus)) {
      return null;
    }
    if (
      !["fad_restricted", "fad_open_rapid"].includes(
        row.source_kind
      ) ||
      !Buffer.isBuffer(row.nonce_bytes) ||
      row.nonce_bytes.length !== 32 ||
      !SHA256_PATTERN.test(row.commitment_hex || "")
    ) {
      incompatible(
        "FAD draw evidence is noncanonical."
      );
    }
    let commitment;
    try {
      commitment =
        createFreeAgentDraftAuctionDrawCommitment({
          auctionId: row.auction_id,
          nonceBytes: row.nonce_bytes,
        });
    } catch (error) {
      incompatible(
        "FAD draw commitment evidence is invalid.",
        error
      );
    }
    if (
      commitment.algorithmVersion !==
        row.algorithm_version ||
      commitment.commitmentHex !==
        row.commitment_hex
    ) {
      incompatible(
        "FAD draw commitment evidence does not verify."
      );
    }
    if (
      row.revealed_at_ms === null &&
      allocation.status !== "correction_required"
    ) {
      incompatible(
        "Terminal FAD draw evidence is not revealed."
      );
    }
    let drawReveal = null;
    if (row.revealed_at_ms !== null) {
      const orderedBidIds = parseJsonArray(
        row.ordered_tied_bid_ids_json,
        "FAD draw bid order is invalid."
      );
      const orderedTeamIds = parseJsonArray(
        row.ordered_tied_team_ids_json,
        "FAD draw team order is invalid."
      );
      if (
        orderedBidIds.length !==
          orderedTeamIds.length ||
        !orderedBidIds.every((id) =>
          UUID_PATTERN.test(id)
        ) ||
        !orderedTeamIds.every((id) =>
          UUID_PATTERN.test(id)
        )
      ) {
        incompatible(
          "FAD draw reveal order is invalid."
        );
      }
      const selectionUsed =
        orderedBidIds.length > 0;
      let expectedReveal;
      try {
        expectedReveal = selectionUsed
          ? createFreeAgentDraftAuctionDrawReveal({
              auctionId: row.auction_id,
              commitmentHex: row.commitment_hex,
              nonceBytes: row.nonce_bytes,
              rolloverAtMs:
                row.auction_resolves_at_ms,
              tiedBidIds: orderedBidIds,
            })
          : createFreeAgentDraftAuctionNoSelectionReveal({
              auctionId: row.auction_id,
              commitmentHex: row.commitment_hex,
              nonceBytes: row.nonce_bytes,
            });
      } catch (error) {
        incompatible(
          "FAD draw reveal evidence does not verify.",
          error
        );
      }
      const selectedTeamId = selectionUsed
        ? orderedTeamIds[
            expectedReveal.selectedIndex
          ]
        : null;
      if (
        expectedReveal.algorithmVersion !==
          row.algorithm_version ||
        expectedReveal.counter !==
          row.rejection_counter ||
        expectedReveal.digestHex !==
          row.selected_digest_hex ||
        expectedReveal.selectedIndex !==
          row.selected_index ||
        expectedReveal.selectedBidId !==
          row.selected_bid_id ||
        selectedTeamId !== row.selected_team_id ||
        (
          !selectionUsed &&
          orderedTeamIds.length !== 0
        )
      ) {
        incompatible(
          "FAD draw selection evidence is invalid."
        );
      }
      drawReveal = freeze({
        algorithmVersion:
          expectedReveal.algorithmVersion,
        nonceHex: expectedReveal.nonceHex,
        selectionUsed,
        orderedBidIds: freeze(orderedBidIds),
        counter: expectedReveal.counter,
        digestHex: expectedReveal.digestHex,
        selectedIndex:
          expectedReveal.selectedIndex,
        selectedBidId:
          expectedReveal.selectedBidId,
        selectedTeamId,
      });
    }
    return freeze({
      auctionId: row.auction_id,
      auctionType: row.source_kind,
      drawCommitment: row.commitment_hex,
      drawReveal,
    });
  }

  function allocationResultProjection(allocation) {
    if (
      !ALLOCATION_STATUSES.includes(
        allocation.status
      )
    ) {
      incompatible(
        "A FAD allocation has an unknown status."
      );
    }
    if (
      allocation.status === "pending" &&
      [
        allocation.decision_code,
        allocation.winning_snapshot_entry_id,
        allocation.winning_team_id,
        allocation.contract_id,
        allocation.ownership_id,
        allocation.restricted_auction_id,
        allocation.fallback_open_auction_id,
        allocation.restricted_minimum_total_cents,
        allocation.restricted_minimum_term_years,
        allocation.restricted_minimum_aav_cents,
        allocation.accounted_at_ms,
      ].some((value) => value !== null)
    ) {
      incompatible(
        "A pending FAD allocation has premature outcome evidence."
      );
    }
    const offerRows = allocationOffersStatement.all({
      leagueId: allocation.league_id,
      fadId: allocation.fad_id,
      allocationId: allocation.id,
      allocationVersion: allocation.version,
      playerId: allocation.player_id,
    });
    if (offerRows.length < 1) {
      incompatible(
        "A FAD allocation has no locked Candidate offers."
      );
    }
    const rankedOffers = offerRows.map((row) =>
      rankedOfferProjection(row, allocation)
    );
    const { restricted, fallback, auctionRows } =
      auctionProjections(allocation);
    const drawRows = allocationDrawsStatement.all({
        leagueId: allocation.league_id,
        fadId: allocation.fad_id,
        allocationId: allocation.id,
      });
    if (
      allocation.status === "pending" &&
      drawRows.length !== 0
    ) {
      incompatible(
        "A pending FAD allocation has premature draw evidence."
      );
    }
    const draws = drawRows
      .map((row) => drawProjection(row, allocation))
      .filter((draw) => draw !== null);
    const terminalAuctionIds = auctionRows
      .filter(
        (row) =>
          !["open", "resolving"].includes(
            terminalAuctionStatus(row)
          )
      )
      .map((row) => row.auction_id)
      .sort();
    const drawAuctionIds = draws
      .map((draw) => draw.auctionId)
      .sort();
    if (
      terminalAuctionIds.length !==
        drawAuctionIds.length ||
      terminalAuctionIds.some(
        (auctionId, index) =>
          auctionId !== drawAuctionIds[index]
      )
    ) {
      incompatible(
        "Terminal FAD auction draw coverage is incomplete."
      );
    }
    const recovery =
      allocationRecoveryStatement.get({
        leagueId: allocation.league_id,
        fadId: allocation.fad_id,
        allocationId: allocation.id,
      }) || null;
    if (
      recovery !== null &&
      ![
        "pending",
        "ready",
        "running",
        "resolved",
        "correction_required",
      ].includes(recovery.status)
    ) {
      incompatible(
        "FAD allocation recovery evidence is noncanonical."
      );
    }
    if (
      allocation.status === "pending" &&
      recovery !== null
    ) {
      incompatible(
        "A pending FAD allocation has premature recovery evidence."
      );
    }
    return freeze({
      allocationId: allocation.id,
      allocationVersion: allocation.version,
      player: playerProjection(allocation),
      status: allocation.status,
      decisionCode: allocation.decision_code,
      rankedOffers: freeze(rankedOffers),
      winner: winnerProjection(allocation),
      restricted,
      fallback,
      draws: freeze(draws),
      recoveryStatus: recovery?.status ?? null,
      resolvedAtMs: allocation.accounted_at_ms,
    });
  }

  function readAllocationResults(input) {
    const scope = normalizeAllocationResultsInput(
      input
    );
    try {
      requireViewerAuthority(scope);
      requirePublishedFad(scope);
      const rows = allocationResultPageStatement.all({
        leagueId: scope.leagueId,
        fadId: scope.fadId,
        q: scope.query.q,
        status: scope.query.status,
        cursorSortName:
          scope.query.cursor?.sortName ?? null,
        cursorPlayerId:
          scope.query.cursor?.playerId ?? null,
        limitPlusOne: scope.query.limit + 1,
      });
      const hasMore =
        rows.length > scope.query.limit;
      const pageRows = rows.slice(
        0,
        scope.query.limit
      );
      for (const row of pageRows) {
        if (
          typeof row.player_sort_name !== "string" ||
          normalizeCandidateEligiblePlayerName(
            row.player_full_name
          ) !== row.player_sort_name
        ) {
          incompatible(
            "FAD result player ordering evidence is invalid."
          );
        }
      }
      const last =
        hasMore && pageRows.length > 0
          ? pageRows.at(-1)
          : null;
      return deepFreeze({
        data: pageRows.map(
          allocationResultProjection
        ),
        page: {
          nextCursor:
            last === null
              ? null
              : encodePublishedCursor(
                  scope.query.filter,
                  last.player_sort_name,
                  "playerId",
                  last.player_id
                ),
          hasMore,
        },
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "readFadAllocationResults",
        tableName:
          "free_agent_draft_player_allocations",
      });
    }
  }

  const repository = {
    readOpeningPreflightContext,
    readNavigation,
    readReadiness,
    readOverview,
    readPublishedCardSummaries,
    readPublishedCardHistory,
    readAllocationResults,
  };
  if (
    Object.keys(repository).length !==
      FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS.length ||
    FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS.some(
      (method) =>
        typeof repository[method] !== "function"
    )
  ) {
    throw new TypeError(
      "The FAD read repository surface is incomplete."
    );
  }
  return Object.freeze(repository);
}

module.exports = {
  FREE_AGENT_DRAFT_READ_REPOSITORY_CODES,
  FREE_AGENT_DRAFT_READ_REPOSITORY_METHODS,
  createSqliteFreeAgentDraftReadRepository,
};
