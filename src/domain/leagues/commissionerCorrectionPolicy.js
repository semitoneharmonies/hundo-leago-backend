const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ROSTER_CATEGORIES = Object.freeze([
  "Active",
  "Bench",
  "Injured Reserve",
  "Prospect",
]);
const CONTRACT_STATUSES = Object.freeze([
  "active",
  "expired",
  "eliminated",
  "cancelled",
]);
const CONTRACT_YEAR_STATUSES = Object.freeze([
  "future",
  "current",
  "completed",
  "expired",
  "eliminated",
]);

const COMMISSIONER_CORRECTION_CODES = Object.freeze({
  inputInvalid: "COMMISSIONER_CORRECTION_INPUT_INVALID",
  stableIdInvalid: "COMMISSIONER_CORRECTION_STABLE_ID_INVALID",
  authorityInvalid: "COMMISSIONER_CORRECTION_AUTHORITY_INVALID",
  reasonInvalid: "COMMISSIONER_CORRECTION_REASON_INVALID",
  timestampInvalid: "COMMISSIONER_CORRECTION_TIMESTAMP_INVALID",
  versionInvalid: "COMMISSIONER_CORRECTION_VERSION_INVALID",
  rosterInvalid: "COMMISSIONER_CORRECTION_ROSTER_INVALID",
  contractInvalid: "COMMISSIONER_CORRECTION_CONTRACT_INVALID",
  scheduleInvalid: "COMMISSIONER_CORRECTION_SCHEDULE_INVALID",
  scopeMismatch: "COMMISSIONER_CORRECTION_SCOPE_MISMATCH",
  sourceChanged: "COMMISSIONER_CORRECTION_SOURCE_CHANGED",
  noChange: "COMMISSIONER_CORRECTION_NO_CHANGE",
  dependencyConflict: "COMMISSIONER_CORRECTION_DEPENDENCY_CONFLICT",
  idempotencyConflict: "COMMISSIONER_CORRECTION_IDEMPOTENCY_CONFLICT",
  confirmationRequired: "COMMISSIONER_CORRECTION_CONFIRMATION_REQUIRED",
});

class CommissionerCorrectionPolicyError extends Error {
  constructor(reasonCode) {
    super("The submitted commissioner correction is invalid.");
    this.name = "CommissionerCorrectionPolicyError";
    this.code = COMMISSIONER_CORRECTION_CODES.inputInvalid;
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new CommissionerCorrectionPolicyError(reasonCode);
}

function assertExactObject(input, expectedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(COMMISSIONER_CORRECTION_CODES.inputInvalid);
  }
  const keys = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.inputInvalid);
  }
}

function stableId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    fail(COMMISSIONER_CORRECTION_CODES.stableIdInvalid);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(COMMISSIONER_CORRECTION_CODES.versionInvalid);
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(COMMISSIONER_CORRECTION_CODES.timestampInvalid);
  }
  return value;
}

function optionalTimestamp(value) {
  return value === null ? null : safeTimestamp(value);
}

function optionalReason(value) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > 500 ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.reasonInvalid);
  }
  return value;
}

function optionalStableId(value) {
  return value === null ? null : stableId(value);
}

function calculateRoundedAavCents(totalValueCents, termYears) {
  const quotient = Math.floor(totalValueCents / termYears);
  const remainder = totalValueCents % termYears;
  return quotient + (remainder * 2 >= termYears ? 1 : 0);
}

function approved(value, values, reasonCode) {
  if (!values.includes(value)) fail(reasonCode);
  return value;
}

function confirmation(value) {
  if (typeof value !== "boolean") {
    fail(COMMISSIONER_CORRECTION_CODES.inputInvalid);
  }
  return value;
}

function commonCorrection(input) {
  if (
    !["commissioner", "platform_administrator"].includes(
      input.actorAuthority
    )
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.authorityInvalid);
  }
  return {
    correctionId: stableId(input.correctionId),
    activityId: stableId(input.activityId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    expectedVersion: positiveVersion(input.expectedVersion),
    confirmWarnings: confirmation(input.confirmWarnings),
    reason: optionalReason(input.reason),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  };
}

function rosterSlot(rosterCategory, positionGroup, value) {
  if (rosterCategory === "Prospect") {
    if (value !== null) fail(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
    return null;
  }
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) {
    fail(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
  }
  const maximum =
    rosterCategory === "Active"
      ? positionGroup === "F"
        ? 12
        : 6
      : 4;
  if (value < 1 || value > maximum) {
    fail(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
  }
  return value;
}

function validateRosterCorrection(input) {
  assertExactObject(input, [
    "correctionId",
    "ownershipEventId",
    "activityId",
    "leagueId",
    "seasonId",
    "ownershipId",
    "playerId",
    "expectedVersion",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "correctedTeamId",
    "correctedOwnershipKind",
    "correctedRosterCategory",
    "correctedPositionGroup",
    "correctedSlotNumber",
    "confirmWarnings",
    "reason",
    "occurredAtMs",
  ]);
  const common = commonCorrection(input);
  const correctedOwnershipKind = approved(
    input.correctedOwnershipKind,
    ["Rostered", "Prospect Right"],
    COMMISSIONER_CORRECTION_CODES.rosterInvalid
  );
  const correctedRosterCategory = approved(
    input.correctedRosterCategory,
    ROSTER_CATEGORIES,
    COMMISSIONER_CORRECTION_CODES.rosterInvalid
  );
  const correctedPositionGroup = approved(
    input.correctedPositionGroup,
    ["F", "D"],
    COMMISSIONER_CORRECTION_CODES.rosterInvalid
  );
  if (
    correctedOwnershipKind === "Prospect Right" &&
    correctedRosterCategory !== "Prospect"
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
  }
  return Object.freeze({
    ...common,
    type: "roster",
    ownershipEventId: stableId(input.ownershipEventId),
    ownershipId: stableId(input.ownershipId),
    playerId: stableId(input.playerId),
    correctedTeamId: stableId(input.correctedTeamId),
    correctedOwnershipKind,
    correctedRosterCategory,
    correctedPositionGroup,
    correctedSlotNumber: rosterSlot(
      correctedRosterCategory,
      correctedPositionGroup,
      input.correctedSlotNumber
    ),
  });
}

function validateRosterAddition(input) {
  assertExactObject(input, [
    "correctionId",
    "ownershipId",
    "ownershipEventId",
    "contractId",
    "contractEventId",
    "contractYearIds",
    "activityId",
    "leagueId",
    "seasonId",
    "playerId",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "teamId",
    "rosterCategory",
    "positionGroup",
    "slotNumber",
    "contractType",
    "originalTotalValueCents",
    "termYears",
    "confirmWarnings",
    "reason",
    "occurredAtMs",
  ]);
  if (
    !["commissioner", "platform_administrator"].includes(
      input.actorAuthority
    )
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.authorityInvalid);
  }
  const rosterCategory = approved(
    input.rosterCategory,
    ROSTER_CATEGORIES,
    COMMISSIONER_CORRECTION_CODES.rosterInvalid
  );
  const positionGroup = approved(
    input.positionGroup,
    ["F", "D"],
    COMMISSIONER_CORRECTION_CODES.rosterInvalid
  );
  const prospect = rosterCategory === "Prospect";
  const contractType = prospect
    ? input.contractType
    : approved(
        input.contractType,
        ["normal", "fantasy_elc"],
        COMMISSIONER_CORRECTION_CODES.contractInvalid
      );
  const termYears = input.termYears;
  const totalValueCents = input.originalTotalValueCents;
  if (prospect) {
    if (
      contractType !== null ||
      totalValueCents !== null ||
      termYears !== null ||
      input.contractId !== null ||
      input.contractEventId !== null ||
      !Array.isArray(input.contractYearIds) ||
      input.contractYearIds.length !== 0
    ) {
      fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
    }
  } else if (
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3 ||
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < termYears * 100 ||
    (termYears > 1 && totalValueCents % 100 !== 0) ||
    !Array.isArray(input.contractYearIds) ||
    input.contractYearIds.length !== termYears ||
    (
      contractType === "fantasy_elc" &&
      (totalValueCents !== 300 || termYears !== 3)
    )
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
  }
  const contractYearIds = prospect
    ? Object.freeze([])
    : Object.freeze(input.contractYearIds.map(stableId));
  if (new Set(contractYearIds).size !== contractYearIds.length) {
    fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
  }
  return Object.freeze({
    correctionId: stableId(input.correctionId),
    ownershipId: stableId(input.ownershipId),
    ownershipEventId: stableId(input.ownershipEventId),
    contractId: prospect ? null : stableId(input.contractId),
    contractEventId: prospect ? null : stableId(input.contractEventId),
    contractYearIds,
    activityId: stableId(input.activityId),
    leagueId: stableId(input.leagueId),
    seasonId: stableId(input.seasonId),
    playerId: stableId(input.playerId),
    actorUserId: stableId(input.actorUserId),
    actorMembershipId: stableId(input.actorMembershipId),
    actorAuthority: input.actorAuthority,
    teamId: stableId(input.teamId),
    ownershipKind: prospect ? "Prospect Right" : "Rostered",
    rosterCategory,
    positionGroup,
    slotNumber: rosterSlot(
      rosterCategory,
      positionGroup,
      input.slotNumber
    ),
    contractType,
    originalTotalValueCents: totalValueCents,
    termYears,
    aavCents: prospect
      ? null
      : calculateRoundedAavCents(totalValueCents, termYears),
    confirmWarnings: confirmation(input.confirmWarnings),
    reason: optionalReason(input.reason),
    occurredAtMs: safeTimestamp(input.occurredAtMs),
  });
}

function validateRosterRemoval(input) {
  assertExactObject(input, [
    "correctionId",
    "ownershipEventId",
    "contractEventId",
    "activityId",
    "leagueId",
    "seasonId",
    "ownershipId",
    "playerId",
    "expectedVersion",
    "contractId",
    "expectedContractVersion",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "confirmWarnings",
    "reason",
    "occurredAtMs",
  ]);
  const common = commonCorrection(input);
  const contractId = optionalStableId(input.contractId);
  const expectedContractVersion =
    input.expectedContractVersion === null
      ? null
      : positiveVersion(input.expectedContractVersion);
  if ((contractId === null) !== (expectedContractVersion === null)) {
    fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
  }
  return Object.freeze({
    ...common,
    type: "roster_removal",
    ownershipEventId: stableId(input.ownershipEventId),
    contractEventId: stableId(input.contractEventId),
    ownershipId: stableId(input.ownershipId),
    playerId: stableId(input.playerId),
    contractId,
    expectedContractVersion,
  });
}

function validateContractYear(value) {
  assertExactObject(value, [
    "id",
    "seasonId",
    "yearNumber",
    "status",
    "rolloverAtMs",
  ]);
  if (
    !Number.isSafeInteger(value.yearNumber) ||
    value.yearNumber < 1 ||
    value.yearNumber > 3
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
  }
  return Object.freeze({
    id: stableId(value.id),
    seasonId: stableId(value.seasonId),
    yearNumber: value.yearNumber,
    status: approved(
      value.status,
      CONTRACT_YEAR_STATUSES,
      COMMISSIONER_CORRECTION_CODES.scheduleInvalid
    ),
    rolloverAtMs: optionalTimestamp(value.rolloverAtMs),
  });
}

function validateContractSchedule(years, termYears, contractStatus) {
  if (!Array.isArray(years) || years.length !== termYears) {
    fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
  }
  const correctedYears = years.map(validateContractYear);
  const ids = new Set();
  const seasonIds = new Set();
  for (let index = 0; index < correctedYears.length; index += 1) {
    const year = correctedYears[index];
    if (
      year.yearNumber !== index + 1 ||
      ids.has(year.id) ||
      seasonIds.has(year.seasonId)
    ) {
      fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
    }
    ids.add(year.id);
    seasonIds.add(year.seasonId);
  }

  if (contractStatus === "active") {
    const currentIndex = correctedYears.findIndex(
      (year) => year.status === "current"
    );
    if (
      currentIndex < 0 ||
      correctedYears.filter((year) => year.status === "current").length !== 1 ||
      correctedYears.some((year, index) => {
        if (index < currentIndex) return year.status !== "completed";
        if (index > currentIndex) return year.status !== "future";
        return false;
      })
    ) {
      fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
    }
  } else if (
    correctedYears.some((year) =>
      ["current", "future"].includes(year.status)
    )
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
  }
  return Object.freeze(correctedYears);
}

function validateContractCorrection(input) {
  assertExactObject(input, [
    "correctionId",
    "contractEventId",
    "activityId",
    "leagueId",
    "seasonId",
    "contractId",
    "playerId",
    "expectedVersion",
    "actorUserId",
    "actorMembershipId",
    "actorAuthority",
    "correctedTeamId",
    "correctedContractType",
    "correctedOriginalTotalValueCents",
    "correctedOriginalTermYears",
    "correctedStartSeasonId",
    "correctedStatus",
    "correctedAuctionBuyoutLockExpiresAtMs",
    "correctedYears",
    "confirmWarnings",
    "reason",
    "occurredAtMs",
  ]);
  const common = commonCorrection(input);
  const contractType = approved(
    input.correctedContractType,
    ["normal", "fantasy_elc"],
    COMMISSIONER_CORRECTION_CODES.contractInvalid
  );
  const termYears = input.correctedOriginalTermYears;
  if (!Number.isSafeInteger(termYears) || termYears < 1 || termYears > 3) {
    fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
  }
  const totalValueCents = input.correctedOriginalTotalValueCents;
  if (
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < termYears * 100 ||
    (termYears > 1 && totalValueCents % 100 !== 0)
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
  }
  if (
    contractType === "fantasy_elc" &&
    (totalValueCents !== 300 || termYears !== 3)
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.contractInvalid);
  }
  const status = approved(
    input.correctedStatus,
    CONTRACT_STATUSES,
    COMMISSIONER_CORRECTION_CODES.contractInvalid
  );
  const years = validateContractSchedule(
    input.correctedYears,
    termYears,
    status
  );
  return Object.freeze({
    ...common,
    type: "contract",
    contractEventId: stableId(input.contractEventId),
    contractId: stableId(input.contractId),
    playerId: stableId(input.playerId),
    correctedTeamId: stableId(input.correctedTeamId),
    correctedContractType: contractType,
    correctedOriginalTotalValueCents: totalValueCents,
    correctedOriginalTermYears: termYears,
    correctedAavCents: calculateRoundedAavCents(
      totalValueCents,
      termYears
    ),
    correctedStartSeasonId: stableId(input.correctedStartSeasonId),
    correctedStatus: status,
    correctedAuctionBuyoutLockExpiresAtMs: optionalTimestamp(
      input.correctedAuctionBuyoutLockExpiresAtMs
    ),
    correctedYears: years,
  });
}

function assertCurrentRecord(current, correction, kind) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    fail(
      kind === "roster"
        ? COMMISSIONER_CORRECTION_CODES.rosterInvalid
        : COMMISSIONER_CORRECTION_CODES.contractInvalid
    );
  }
  const recordId = kind === "roster" ? correction.ownershipId : correction.contractId;
  if (
    current.id !== recordId ||
    current.league_id !== correction.leagueId ||
    current.player_id !== correction.playerId ||
    (kind === "roster" && current.season_id !== correction.seasonId)
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
  }
  if (current.version !== correction.expectedVersion) {
    fail(COMMISSIONER_CORRECTION_CODES.sourceChanged);
  }
  return current;
}

function assertWarningsConfirmed(warnings, confirmed) {
  if (!Array.isArray(warnings)) {
    fail(COMMISSIONER_CORRECTION_CODES.inputInvalid);
  }
  if (warnings.length > 0 && !confirmed) {
    fail(COMMISSIONER_CORRECTION_CODES.confirmationRequired);
  }
  return warnings;
}

function assertCommissionerAuthority(membership, correction) {
  if (
    !membership ||
    membership.id !== correction.actorMembershipId ||
    membership.league_id !== correction.leagueId ||
    membership.user_id !== correction.actorUserId ||
    membership.status !== "active" ||
    (
      correction.actorAuthority === "commissioner" &&
      membership.permission_category !== "commissioner"
    )
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.authorityInvalid);
  }
  return membership;
}

function assertNoDependentTransactions(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    fail(COMMISSIONER_CORRECTION_CODES.inputInvalid);
  }
  if (count > 0) {
    fail(COMMISSIONER_CORRECTION_CODES.dependencyConflict);
  }
}

function assertCorrectionChanged(before, after) {
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    JSON.stringify(before) === JSON.stringify(after)
  ) {
    fail(COMMISSIONER_CORRECTION_CODES.noChange);
  }
}

module.exports = {
  COMMISSIONER_CORRECTION_CODES,
  CommissionerCorrectionPolicyError,
  assertCommissionerAuthority,
  assertCorrectionChanged,
  assertCurrentRecord,
  assertNoDependentTransactions,
  assertWarningsConfirmed,
  validateContractCorrection,
  validateRosterAddition,
  validateRosterCorrection,
  validateRosterRemoval,
};
