const {
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CandidateCardPolicyError,
  validateCandidateCardContract,
} = require("./candidateCardPolicy");
const {
  calculateBuyoutPenaltyCents,
} = require("../contracts/buyoutPolicy");
const {
  createFreeAgentDraftClock,
  parseFreeAgentDraftOccurrenceKey,
  UUID_PATTERN,
} = require("./freeAgentDraftPolicy");
const {
  FreeAgentDraftScheduleRecoveryPolicyError,
  planFreeAgentDraftPreOpenScheduleRecovery,
} = require("./freeAgentDraftScheduleRecoveryPolicy");
const {
  createFreeAgentDraftReadinessMissingScheduleBlocker,
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
  projectFreeAgentDraftReadinessPublicDiagnostics,
} = require("./freeAgentDraftReadinessPolicy");
const {
  compareUnicodeScalarStrings,
} = require("../leagues/seasonRolloverEvidencePolicy");

const FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES =
  Object.freeze({
    inputInvalid: "FAD_OPENING_READINESS_INPUT_INVALID",
    resultInvalid: "FAD_OPENING_READINESS_RESULT_INVALID",
  });

const INAUGURAL_REASON = "Inaugural league season.";
const POSITION_SLOT_COUNTS = Object.freeze({
  F: 12,
  D: 6,
  B: 4,
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const TRUSTED_INSPECTIONS = new WeakSet();

const CONTEXT_KEYS = Object.freeze([
  "activeContracts",
  "allContracts",
  "allContractYears",
  "buyoutObligations",
  "buyoutYears",
  "currentPlayerSources",
  "currentSchedule",
  "currentScheduleJobBindings",
  "currentScheduleOperation",
  "entryDraft",
  "existingFad",
  "firstMatchupWeek",
  "league",
  "leaguePositionOverrides",
  "leagueSettings",
  "managerAssignments",
  "ownerships",
  "participatingTeams",
  "priorSeason",
  "priorSeasonBuyoutYears",
  "priorSeasonContractYears",
  "priorSeasonRollovers",
  "priorSeasonRolloverItems",
  "priorSeasonRolloverOwnershipReceipt",
  "priorSeasonRolloverReceipt",
  "priorSeasonRetentionYears",
  "readinessJob",
  "readinessOperation",
  "retentionObligations",
  "retentionYears",
  "rosterOrderEntries",
  "rosterOrderSets",
  "season",
  "setupExemptions",
  "targetContractYears",
]);

class FreeAgentDraftOpeningReadinessPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super(`${code}: ${reasonCode}`);
    this.name =
      "FreeAgentDraftOpeningReadinessPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new FreeAgentDraftOpeningReadinessPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
      .inputInvalid,
    reasonCode
  );
}

function failResult(reasonCode) {
  fail(
    FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
      .resultInvalid,
    reasonCode
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

function requireExactObject(
  value,
  keys,
  reasonCode,
  reject = failInput
) {
  if (!isPlainObject(value)) {
    reject(reasonCode);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    reject(reasonCode);
  }
  return value;
}

function requireObject(value, reasonCode) {
  if (!isPlainObject(value)) {
    failInput(reasonCode);
  }
  return value;
}

function requireArray(value, reasonCode) {
  if (!Array.isArray(value)) {
    failInput(reasonCode);
  }
  return value;
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function stableId(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTimestamp(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function positiveInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failInput(reasonCode);
  }
  return value;
}

function nonnegativeInteger(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput(reasonCode);
  }
  return value;
}

function isStableId(value) {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value)
  );
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameSet(left, right) {
  return (
    left.size === right.size &&
    [...left].every((value) => right.has(value))
  );
}

function boundedText(
  value,
  maximumLength,
  reasonCode,
  { nullable = false } = {}
) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeTeam(team) {
  requireObject(team, "participating_team_invalid");
  return Object.freeze({
    logoReference:
      team.logoReference === null
        ? null
        : boundedText(
            team.logoReference,
            500,
            "team_logo_reference_invalid"
          ),
    name: boundedText(
      team.name,
      200,
      "team_name_invalid"
    ),
    patternTemplate: boundedText(
      team.patternTemplate,
      200,
      "team_pattern_template_invalid"
    ),
    primaryColour: boundedText(
      team.primaryColour,
      100,
      "team_primary_colour_invalid"
    ),
    secondaryColour: boundedText(
      team.secondaryColour,
      100,
      "team_secondary_colour_invalid"
    ),
    teamId: stableId(
      team.teamId,
      "team_id_invalid"
    ),
    tertiaryColour:
      team.tertiaryColour === null
        ? null
        : boundedText(
            team.tertiaryColour,
            100,
            "team_tertiary_colour_invalid"
          ),
  });
}

function diagnostic(
  code,
  field,
  resourceType,
  resourceId,
  message
) {
  return {
    code,
    field,
    resourceType,
    resourceId,
    message,
  };
}

function normalizeDiagnostics(value, reasonCode) {
  try {
    return normalizeFreeAgentDraftReadinessInternalDiagnostics(
      value
    );
  } catch {
    failResult(reasonCode);
  }
}

function addTeamStateBlocker(
  blockers,
  identities,
  code,
  teamId,
  field,
  resourceType,
  message
) {
  const identity = `${code}:${teamId}`;
  if (identities.has(identity)) return;
  identities.add(identity);
  blockers.push(
    diagnostic(
      code,
      field,
      resourceType,
      teamId,
      message
    )
  );
}

function addGlobalStateBlocker(
  blockers,
  identities,
  code,
  leagueId,
  field,
  message
) {
  if (identities.has(code)) return;
  identities.add(code);
  blockers.push(
    diagnostic(
      code,
      field,
      "league",
      leagueId,
      message
    )
  );
}

function candidateContractIsValid(contract) {
  try {
    validateCandidateCardContract({
      contractType: contract.contractType,
      originalTotalValueCents:
        contract.originalTotalValueCents,
      originalTermYears:
        contract.originalTermYears,
      aavCents: contract.aavCents,
    });
    return true;
  } catch (error) {
    if (!(error instanceof CandidateCardPolicyError)) {
      throw error;
    }
    return false;
  }
}

function exactRemainingContractSchedule(
  contract,
  years,
  seasonId
) {
  const remaining = years
    .filter(({ status }) =>
      ["current", "future"].includes(status)
    )
    .sort(
      (left, right) =>
        left.yearNumber - right.yearNumber ||
        compareUnicodeScalarStrings(
          left.contractYearId,
          right.contractYearId
        )
    );
  const current = remaining.filter(
    ({ status }) => status === "current"
  );
  if (
    current.length !== 1 ||
    current[0].seasonId !== seasonId ||
    remaining.length !==
      contract.originalTermYears -
        current[0].yearNumber +
        1 ||
    remaining.some(
      (year, index) =>
        year.yearNumber !==
          current[0].yearNumber + index ||
        year.aavCents !== contract.aavCents ||
        (index === 0
          ? year.status !== "current"
          : year.status !== "future")
    )
  ) {
    return null;
  }
  return remaining;
}

function eliminatedContractSchedule(
  years,
  seasonId
) {
  const current = years.filter(
    (year) =>
      year.seasonId === seasonId &&
      year.status === "eliminated"
  );
  if (current.length !== 1) return null;
  const remaining = years
    .filter(
      (year) =>
        year.status === "eliminated" &&
        year.yearNumber >= current[0].yearNumber
    )
    .sort(
      (left, right) =>
        left.yearNumber - right.yearNumber ||
        compareUnicodeScalarStrings(
          left.contractYearId,
          right.contractYearId
        )
    );
  if (
    remaining.length !==
      years.length - current[0].yearNumber + 1 ||
    remaining.some(
      (year, index) =>
        year.yearNumber !==
          current[0].yearNumber + index
    )
  ) {
    return null;
  }
  return remaining;
}

function terminalContractScheduleIsExact(contract, years) {
  if (contract.status === "expired") {
    return years.every((year, index) =>
      index === years.length - 1
        ? year.status === "expired"
        : year.status === "completed"
    );
  }
  if (
    contract.status === "eliminated" ||
    contract.status === "cancelled"
  ) {
    const firstEliminatedIndex = years.findIndex(
      ({ status }) => status === "eliminated"
    );
    return (
      firstEliminatedIndex >= 0 &&
      years.every((year, index) =>
        index < firstEliminatedIndex
          ? year.status === "completed"
          : year.status === "eliminated"
      )
    );
  }
  return false;
}

function obligationScheduleIsExact({
  obligation,
  obligationYears,
  contract,
  contractYears,
  seasonId,
  amountField,
  amountCents,
}) {
  if (obligationYears.length === 0) return false;
  const contractYearBySeason = new Map(
    contractYears.map((year) => [year.seasonId, year])
  );
  const mapped = obligationYears
    .map((year) => ({
      obligationYear: year,
      contractYear: contractYearBySeason.get(year.seasonId),
    }))
    .sort(
      (left, right) =>
        (left.contractYear?.yearNumber ?? Number.MAX_SAFE_INTEGER) -
          (right.contractYear?.yearNumber ?? Number.MAX_SAFE_INTEGER) ||
        compareUnicodeScalarStrings(
          left.obligationYear.seasonId,
          right.obligationYear.seasonId
        )
    );
  if (
    mapped.some(({ contractYear }) => !contractYear) ||
    mapped.length !==
      contract.originalTermYears -
        mapped[0].contractYear.yearNumber +
        1 ||
    mapped.some(
      ({ obligationYear, contractYear }, index) =>
        contractYear.yearNumber !==
          mapped[0].contractYear.yearNumber + index ||
        obligationYear[amountField] !== amountCents ||
        obligationYear.createdAtMs < obligation.createdAtMs
    )
  ) {
    return false;
  }
  if (obligation.status !== "active") {
    return mapped.every(({ obligationYear }) =>
      ["completed", "cancelled"].includes(
        obligationYear.status
      )
    );
  }
  const target = mapped.filter(
    ({ obligationYear }) =>
      obligationYear.seasonId === seasonId
  );
  if (
    target.length !== 1 ||
    target[0].obligationYear.status !== "current"
  ) {
    return false;
  }
  const targetYearNumber = target[0].contractYear.yearNumber;
  return mapped.every(({ obligationYear, contractYear }) => {
    const expectedStatus =
      contractYear.yearNumber < targetYearNumber
        ? "completed"
        : contractYear.yearNumber === targetYearNumber
          ? "current"
          : "future";
    return obligationYear.status === expectedStatus;
  });
}

function inspectAuthoritativeSeasonState({
  context,
  leagueId,
  seasonId,
  participatingTeams,
}) {
  const blockers = [];
  const identities = new Set();
  const participantIds = new Set(
    participatingTeams.map(({ teamId }) => teamId)
  );
  const markOwnership = () =>
    addGlobalStateBlocker(
      blockers,
      identities,
      "FAD_OWNERSHIP_STATE_INVALID",
      leagueId,
      "ownerships",
      "The target-season ownership and prospect-right state is internally inconsistent."
    );
  const markContract = () =>
    addGlobalStateBlocker(
      blockers,
      identities,
      "FAD_CONTRACT_STATE_INVALID",
      leagueId,
      "contracts",
      "The target-season contract state is internally inconsistent."
    );
  const markRetention = () =>
    addGlobalStateBlocker(
      blockers,
      identities,
      "FAD_RETENTION_STATE_INVALID",
      leagueId,
      "retentionObligations",
      "The target-season retained-salary state is internally inconsistent."
    );
  const markBuyout = () =>
    addGlobalStateBlocker(
      blockers,
      identities,
      "FAD_BUYOUT_STATE_INVALID",
      leagueId,
      "buyoutObligations",
      "The target-season buyout state is internally inconsistent."
    );
  const markRosterOrder = () =>
    addGlobalStateBlocker(
      blockers,
      identities,
      "FAD_ROSTER_ORDER_STATE_INVALID",
      leagueId,
      "rosterOrderEntries",
      "The target-season roster display order is internally inconsistent."
    );

  const allContracts = context.allContracts;
  const activeContracts = context.activeContracts;
  const allContractYears = context.allContractYears;
  const targetContractYears =
    context.targetContractYears;
  const contractById = new Map();
  const activeContractsByPlayer = new Map();
  for (const contract of allContracts) {
    const shapeValid =
      isStableId(contract.contractId) &&
      isStableId(contract.playerId) &&
      isStableId(contract.currentTeamId) &&
      isStableId(contract.startSeasonId) &&
      [
        "active",
        "expired",
        "eliminated",
        "cancelled",
      ].includes(contract.status) &&
      ["normal", "fantasy_elc"].includes(
        contract.contractType
      ) &&
      isPositiveInteger(contract.version) &&
      isPositiveInteger(
        contract.originalTotalValueCents
      ) &&
      isPositiveInteger(contract.originalTermYears) &&
      isPositiveInteger(contract.aavCents) &&
      candidateContractIsValid(contract);
    if (
      !shapeValid ||
      contractById.has(contract.contractId)
    ) {
      markContract();
      continue;
    }
    contractById.set(contract.contractId, contract);
    if (contract.status === "active") {
      if (
        !participantIds.has(contract.currentTeamId) ||
        !candidateContractIsValid(contract) ||
        activeContractsByPlayer.has(contract.playerId)
      ) {
        markContract();
      }
      activeContractsByPlayer.set(
        contract.playerId,
        contract
      );
    }
  }
  const projectedActiveById = new Map();
  for (const contract of activeContracts) {
    if (
      !isStableId(contract.contractId) ||
      projectedActiveById.has(contract.contractId)
    ) {
      markContract();
      continue;
    }
    projectedActiveById.set(
      contract.contractId,
      contract
    );
  }
  const authoritativeActive = [...contractById.values()]
    .filter(({ status }) => status === "active");
  if (
    projectedActiveById.size !==
      authoritativeActive.length ||
    authoritativeActive.some((contract) => {
      const projected = projectedActiveById.get(
        contract.contractId
      );
      return (
        !projected ||
        [
          "playerId",
          "currentTeamId",
          "contractType",
          "originalTotalValueCents",
          "originalTermYears",
          "aavCents",
          "startSeasonId",
          "status",
          "version",
        ].some(
          (field) =>
            projected[field] !== contract[field]
        )
      );
    })
  ) {
    markContract();
  }

  const yearsByContract = new Map();
  const yearIds = new Set();
  const contractYearNumbers = new Set();
  const contractYearSeasons = new Set();
  for (const year of allContractYears) {
    const numberIdentity =
      `${year.contractId}:${year.yearNumber}`;
    const seasonIdentity =
      `${year.contractId}:${year.seasonId}`;
    if (
      !isStableId(year.contractYearId) ||
      !isStableId(year.leagueId) ||
      year.leagueId !== leagueId ||
      !isStableId(year.contractId) ||
      !isStableId(year.seasonId) ||
      !isPositiveInteger(year.yearNumber) ||
      !isPositiveInteger(year.aavCents) ||
      !isNonnegativeInteger(year.createdAtMs) ||
      !(
        ["current", "future"].includes(year.status)
          ? year.rolloverAtMs === null
          : isNonnegativeInteger(year.rolloverAtMs) &&
            year.rolloverAtMs >= year.createdAtMs
      ) ||
      ![
        "future",
        "current",
        "completed",
        "expired",
        "eliminated",
      ].includes(year.status) ||
      !contractById.has(year.contractId) ||
      yearIds.has(year.contractYearId) ||
      contractYearNumbers.has(numberIdentity) ||
      contractYearSeasons.has(seasonIdentity)
    ) {
      markContract();
      continue;
    }
    yearIds.add(year.contractYearId);
    contractYearNumbers.add(numberIdentity);
    contractYearSeasons.add(seasonIdentity);
    if (!yearsByContract.has(year.contractId)) {
      yearsByContract.set(year.contractId, []);
    }
    yearsByContract.get(year.contractId).push(year);
    const parent = contractById.get(year.contractId);
    if (
      year.yearNumber > parent.originalTermYears ||
      year.aavCents !== parent.aavCents
    ) {
      markContract();
    }
  }
  const projectedTargetYearIds = new Set();
  for (const year of targetContractYears) {
    if (
      !isStableId(year.contractYearId) ||
      projectedTargetYearIds.has(year.contractYearId)
    ) {
      markContract();
      continue;
    }
    projectedTargetYearIds.add(year.contractYearId);
    const actual = allContractYears.find(
      ({ contractYearId }) =>
        contractYearId === year.contractYearId
    );
    if (
      !actual ||
      year.seasonId !== seasonId ||
      [
        "contractId",
        "seasonId",
        "yearNumber",
        "aavCents",
        "status",
      ].some(
        (field) => year[field] !== actual[field]
      )
    ) {
      markContract();
    }
  }
  const actualTargetYearIds = new Set(
    allContractYears
      .filter((year) => year.seasonId === seasonId)
      .map(({ contractYearId }) => contractYearId)
  );
  if (
    !sameSet(
      projectedTargetYearIds,
      actualTargetYearIds
    )
  ) {
    markContract();
  }
  for (const contract of contractById.values()) {
    const years = (
      yearsByContract.get(contract.contractId) || []
    ).sort(
      (left, right) =>
        left.yearNumber - right.yearNumber ||
        compareUnicodeScalarStrings(
          left.contractYearId,
          right.contractYearId
        )
    );
    if (
      years.length !== contract.originalTermYears ||
      years[0]?.seasonId !== contract.startSeasonId ||
      years.some(
        (year, index) =>
          year.yearNumber !== index + 1 ||
          year.aavCents !== contract.aavCents
      )
    ) {
      markContract();
    }
    if (
      contract.status === "active" &&
      (
        exactRemainingContractSchedule(
        contract,
        years,
        seasonId
        ) === null ||
        years.some((year) => {
          const currentYear = years.find(
            ({ status }) => status === "current"
          );
          if (!currentYear) return true;
          if (year.yearNumber < currentYear.yearNumber) {
            return year.status !== "completed";
          }
          return year.rolloverAtMs !== null;
        })
      )
    ) {
      markContract();
    }
    if (
      contract.status !== "active" &&
      (
        years.some(({ status }) =>
          ["current", "future"].includes(status)
        ) ||
        !terminalContractScheduleIsExact(contract, years)
      )
    ) {
      markContract();
    }
  }

  const ownershipById = new Map();
  const ownershipByPlayer = new Map();
  for (const ownership of context.ownerships) {
    const rostered =
      ownership.ownershipKind === "Rostered" &&
      ["Active", "Bench", "Injured Reserve"].includes(
        ownership.rosterCategory
      );
    const prospect =
      ownership.ownershipKind === "Prospect Right" &&
      ownership.rosterCategory === "Prospect";
    const slotMaximum =
      ownership.rosterCategory === "Active"
        ? POSITION_SLOT_COUNTS[ownership.positionGroup]
        : ["Bench", "Injured Reserve"].includes(
              ownership.rosterCategory
            )
          ? 4
          : null;
    const slotValid = prospect
      ? ownership.slotNumber === null
      : ownership.slotNumber === null ||
        (
          isPositiveInteger(ownership.slotNumber) &&
          ownership.slotNumber <= slotMaximum
        );
    if (
      !isStableId(ownership.ownershipId) ||
      !isStableId(ownership.teamId) ||
      !isStableId(ownership.playerId) ||
      !participantIds.has(ownership.teamId) ||
      !["F", "D"].includes(
        ownership.positionGroup
      ) ||
      ownership.playerStatus !== "active" ||
      !isPositiveInteger(ownership.version) ||
      !(rostered || prospect) ||
      !slotValid ||
      ownershipById.has(ownership.ownershipId) ||
      ownershipByPlayer.has(ownership.playerId)
    ) {
      markOwnership();
      continue;
    }
    ownershipById.set(
      ownership.ownershipId,
      ownership
    );
    ownershipByPlayer.set(
      ownership.playerId,
      ownership
    );
    const contract = activeContractsByPlayer.get(
      ownership.playerId
    );
    if (
      rostered
        ? !contract ||
          contract.currentTeamId !== ownership.teamId
        : contract &&
          (
            contract.currentTeamId !== ownership.teamId ||
            contract.contractType !== "fantasy_elc"
          )
    ) {
      markOwnership();
    }
  }
  for (const contract of activeContractsByPlayer.values()) {
    const ownership = ownershipByPlayer.get(
      contract.playerId
    );
    if (
      !ownership ||
      ownership.teamId !== contract.currentTeamId ||
      (
        ownership.rosterCategory === "Prospect" &&
        contract.contractType !== "fantasy_elc"
      )
    ) {
      markContract();
    }
  }

  function obligationYears(
    rows,
    {
      idField,
      parentField,
      amountField,
      parentById,
      mark,
    }
  ) {
    const result = new Map();
    const ids = new Set();
    const parentSeasons = new Set();
    for (const year of rows) {
      const parentSeason =
        `${year[parentField]}:${year.seasonId}`;
      if (
        !isStableId(year[idField]) ||
        !isStableId(year.leagueId) ||
        year.leagueId !== leagueId ||
        !isStableId(year[parentField]) ||
        !isStableId(year.seasonId) ||
        !isPositiveInteger(year[amountField]) ||
        !isNonnegativeInteger(year.createdAtMs) ||
        ![
          "future",
          "current",
          "completed",
          "cancelled",
        ].includes(year.status) ||
        !parentById.has(year[parentField]) ||
        ids.has(year[idField]) ||
        parentSeasons.has(parentSeason)
      ) {
        mark();
        continue;
      }
      ids.add(year[idField]);
      parentSeasons.add(parentSeason);
      if (!result.has(year[parentField])) {
        result.set(year[parentField], []);
      }
      result.get(year[parentField]).push(year);
    }
    return result;
  }

  const retentionById = new Map();
  const activeRetentionSlotsByTeam = new Map();
  const activeRetentionTeamContracts = new Set();
  const activeRetainedByContract = new Map();
  for (const obligation of context.retentionObligations) {
    if (
      !isStableId(obligation.obligationId) ||
      obligation.leagueId !== leagueId ||
      !isStableId(obligation.contractId) ||
      !isStableId(obligation.playerId) ||
      !isStableId(obligation.originatingTeamId) ||
      !isStableId(obligation.responsibleTeamId) ||
      !participantIds.has(obligation.originatingTeamId) ||
      !participantIds.has(obligation.responsibleTeamId) ||
      !isPositiveInteger(obligation.retainedAavCents) ||
      !(
        obligation.creationTradeId === null ||
        isStableId(obligation.creationTradeId)
      ) ||
      !["active", "completed", "cancelled"].includes(
        obligation.status
      ) ||
      !isNonnegativeInteger(obligation.createdAtMs) ||
      !isNonnegativeInteger(obligation.updatedAtMs) ||
      obligation.updatedAtMs < obligation.createdAtMs ||
      !isPositiveInteger(obligation.version) ||
      retentionById.has(obligation.obligationId)
    ) {
      markRetention();
      continue;
    }
    retentionById.set(
      obligation.obligationId,
      obligation
    );
    if (obligation.status === "active") {
      const teamContract =
        `${obligation.responsibleTeamId}:` +
        `${obligation.contractId}`;
      if (activeRetentionTeamContracts.has(teamContract)) {
        markRetention();
      }
      activeRetentionTeamContracts.add(teamContract);
      activeRetentionSlotsByTeam.set(
        obligation.responsibleTeamId,
        (activeRetentionSlotsByTeam.get(
          obligation.responsibleTeamId
        ) || 0) + 1
      );
      activeRetainedByContract.set(
        obligation.contractId,
        (activeRetainedByContract.get(
          obligation.contractId
        ) || 0) + obligation.retainedAavCents
      );
    }
  }
  if (
    [...activeRetentionSlotsByTeam.values()].some(
      (count) => count > 3
    )
  ) {
    markRetention();
  }
  const retentionYearsByParent = obligationYears(
    context.retentionYears,
    {
      idField: "retentionYearId",
      parentField: "retentionObligationId",
      amountField: "retainedAavCents",
      parentById: retentionById,
      mark: markRetention,
    }
  );
  for (const obligation of retentionById.values()) {
    const contract = contractById.get(
      obligation.contractId
    );
    const years =
      retentionYearsByParent.get(
        obligation.obligationId
      ) || [];
    const liveYears = years.filter(({ status }) =>
      ["current", "future"].includes(status)
    );
    if (
      !contract ||
      contract.playerId !== obligation.playerId
    ) {
      markRetention();
      continue;
    }
    if (obligation.status !== "active") {
      if (
        liveYears.length > 0 ||
        !obligationScheduleIsExact({
          obligation,
          obligationYears: years,
          contract,
          contractYears:
            yearsByContract.get(contract.contractId) || [],
          seasonId,
          amountField: "retainedAavCents",
          amountCents: obligation.retainedAavCents,
        })
      ) {
        markRetention();
      }
      continue;
    }
    const schedule =
      contract.status === "active"
        ? exactRemainingContractSchedule(
            contract,
            yearsByContract.get(contract.contractId) || [],
            seasonId
          )
        : contract.status === "eliminated"
          ? eliminatedContractSchedule(
              yearsByContract.get(contract.contractId) || [],
              seasonId
            )
          : null;
    if (
      schedule === null ||
      !obligationScheduleIsExact({
        obligation,
        obligationYears: years,
        contract,
        contractYears:
          yearsByContract.get(contract.contractId) || [],
        seasonId,
        amountField: "retainedAavCents",
        amountCents: obligation.retainedAavCents,
      }) ||
      !sameSet(
        new Set(liveYears.map(({ seasonId: id }) => id)),
        new Set(schedule.map(({ seasonId: id }) => id))
      )
    ) {
      markRetention();
    }
  }
  for (const [contractId, total] of activeRetainedByContract) {
    const contract = contractById.get(contractId);
    if (!contract || total * 2 > contract.aavCents) {
      markRetention();
    }
  }

  const buyoutById = new Map();
  const buyoutContracts = new Set();
  for (const obligation of context.buyoutObligations) {
    if (
      !isStableId(obligation.obligationId) ||
      obligation.leagueId !== leagueId ||
      !isStableId(obligation.contractId) ||
      !isStableId(obligation.playerId) ||
      !isStableId(obligation.originatingTeamId) ||
      !isStableId(obligation.responsibleTeamId) ||
      !participantIds.has(obligation.originatingTeamId) ||
      !participantIds.has(obligation.responsibleTeamId) ||
      !isPositiveInteger(
        obligation.annualPenaltyBasisCents
      ) ||
      !isStableId(obligation.buyoutTransactionId) ||
      !["active", "completed", "cancelled"].includes(
        obligation.status
      ) ||
      !isNonnegativeInteger(obligation.createdAtMs) ||
      !isNonnegativeInteger(obligation.updatedAtMs) ||
      obligation.updatedAtMs < obligation.createdAtMs ||
      !isPositiveInteger(obligation.version) ||
      buyoutById.has(obligation.obligationId) ||
      buyoutContracts.has(obligation.contractId)
    ) {
      markBuyout();
      continue;
    }
    buyoutById.set(obligation.obligationId, obligation);
    buyoutContracts.add(obligation.contractId);
  }
  const buyoutYearsByParent = obligationYears(
    context.buyoutYears,
    {
      idField: "buyoutYearId",
      parentField: "buyoutObligationId",
      amountField: "penaltyCents",
      parentById: buyoutById,
      mark: markBuyout,
    }
  );
  for (const obligation of buyoutById.values()) {
    const contract = contractById.get(
      obligation.contractId
    );
    const years =
      buyoutYearsByParent.get(obligation.obligationId) ||
      [];
    const liveYears = years.filter(({ status }) =>
      ["current", "future"].includes(status)
    );
    if (
      !contract ||
      contract.playerId !== obligation.playerId
    ) {
      markBuyout();
      continue;
    }
    if (obligation.status !== "active") {
      if (
        liveYears.length > 0 ||
        !obligationScheduleIsExact({
          obligation,
          obligationYears: years,
          contract,
          contractYears:
            yearsByContract.get(contract.contractId) || [],
          seasonId,
          amountField: "penaltyCents",
          amountCents: obligation.annualPenaltyBasisCents,
        })
      ) {
        markBuyout();
      }
      continue;
    }
    const schedule =
      contract.status === "eliminated"
        ? eliminatedContractSchedule(
            yearsByContract.get(contract.contractId) || [],
            seasonId
          )
        : null;
    if (
      schedule === null ||
      obligation.annualPenaltyBasisCents !==
        calculateBuyoutPenaltyCents(contract.aavCents) ||
      !obligationScheduleIsExact({
        obligation,
        obligationYears: years,
        contract,
        contractYears:
          yearsByContract.get(contract.contractId) || [],
        seasonId,
        amountField: "penaltyCents",
        amountCents: obligation.annualPenaltyBasisCents,
      }) ||
      !sameSet(
        new Set(liveYears.map(({ seasonId: id }) => id)),
        new Set(schedule.map(({ seasonId: id }) => id))
      )
    ) {
      markBuyout();
    }
  }

  const orderSetById = new Map();
  const orderSetTeams = new Set();
  for (const orderSet of context.rosterOrderSets) {
    if (
      !isStableId(orderSet.orderSetId) ||
      orderSet.leagueId !== leagueId ||
      orderSet.seasonId !== seasonId ||
      !participantIds.has(orderSet.teamId) ||
      !isStableId(orderSet.updatedByUserId) ||
      !isNonnegativeInteger(orderSet.createdAtMs) ||
      !isNonnegativeInteger(orderSet.updatedAtMs) ||
      orderSet.updatedAtMs < orderSet.createdAtMs ||
      !isPositiveInteger(orderSet.version) ||
      orderSetById.has(orderSet.orderSetId) ||
      orderSetTeams.has(orderSet.teamId)
    ) {
      markRosterOrder();
      continue;
    }
    orderSetById.set(orderSet.orderSetId, orderSet);
    orderSetTeams.add(orderSet.teamId);
  }
  const orderEntryIds = new Set();
  const orderOwnerships = new Set();
  const orderPositions = new Set();
  for (const entry of context.rosterOrderEntries) {
    const orderSet = orderSetById.get(entry.orderSetId);
    const ownership = ownershipById.get(entry.ownershipId);
    const ownershipIdentity =
      `${entry.orderSetId}:${entry.ownershipId}`;
    const positionIdentity =
      `${entry.orderSetId}:${entry.positionGroup}:` +
      `${entry.displayOrder}`;
    if (
      !isStableId(entry.orderEntryId) ||
      entry.leagueId !== leagueId ||
      !orderSet ||
      !ownership ||
      ownership.teamId !== orderSet.teamId ||
      ownership.positionGroup !== entry.positionGroup ||
      !["F", "D"].includes(entry.positionGroup) ||
      !isPositiveInteger(entry.displayOrder) ||
      !isNonnegativeInteger(entry.createdAtMs) ||
      orderEntryIds.has(entry.orderEntryId) ||
      orderOwnerships.has(ownershipIdentity) ||
      orderPositions.has(positionIdentity)
    ) {
      markRosterOrder();
      continue;
    }
    orderEntryIds.add(entry.orderEntryId);
    orderOwnerships.add(ownershipIdentity);
    orderPositions.add(positionIdentity);
  }

  return Object.freeze(blockers);
}

function lowestAvailable(used, slotGroup) {
  for (
    let slotNumber = 1;
    slotNumber <= POSITION_SLOT_COUNTS[slotGroup];
    slotNumber += 1
  ) {
    if (!used[slotGroup].has(slotNumber)) {
      return slotNumber;
    }
  }
  return null;
}

function effectivePositionForPlayer({
  playerId,
  leaguePositionOverrides,
  currentPlayerSources,
}) {
  const overrides = leaguePositionOverrides.filter(
    (row) => row.playerId === playerId
  );
  if (overrides.length > 1) return null;
  const overridePositions = new Set(
    overrides.map((row) => row.positionGroup)
  );
  if (overridePositions.size > 1) return null;
  if (overridePositions.size === 1) {
    const position = [...overridePositions][0];
    return ["F", "D"].includes(position)
      ? position
      : null;
  }
  const sourcePositions = new Set(
    currentPlayerSources
      .filter(
        (row) =>
          row.playerId === playerId &&
          (row.active === true || row.active === 1) &&
          ["F", "D"].includes(
            row.normalizedPosition
          )
      )
      .map((row) => row.normalizedPosition)
  );
  if (sourcePositions.size !== 1) return null;
  const position = [...sourcePositions][0];
  return ["F", "D"].includes(position)
    ? position
    : null;
}

function contractEvidenceForOwnership({
  ownership,
  seasonId,
  activeContracts,
  targetContractYears,
  allContractYears,
}) {
  const contracts = activeContracts.filter(
    (contract) =>
      contract.playerId === ownership.playerId &&
      contract.currentTeamId === ownership.teamId &&
      contract.status === "active" &&
      ["normal", "fantasy_elc"].includes(
        contract.contractType
      )
  );
  if (contracts.length !== 1) return null;
  const contract = contracts[0];
  try {
    validateCandidateCardContract({
      contractType: contract.contractType,
      originalTotalValueCents:
        contract.originalTotalValueCents,
      originalTermYears:
        contract.originalTermYears,
      aavCents: contract.aavCents,
    });
  } catch (error) {
    if (!(error instanceof CandidateCardPolicyError)) {
      throw error;
    }
    return null;
  }
  const currentYears = targetContractYears.filter(
    (year) =>
      year.contractId === contract.contractId &&
      year.seasonId === seasonId &&
      year.status === "current"
  );
  if (currentYears.length !== 1) return null;
  const currentYear = currentYears[0];
  if (
    currentYear.aavCents !== contract.aavCents ||
    !Number.isSafeInteger(currentYear.yearNumber) ||
    currentYear.yearNumber < 1 ||
    currentYear.yearNumber > contract.originalTermYears
  ) {
    return null;
  }
  const remainingYears = allContractYears
    .filter(
      (year) =>
        year.contractId === contract.contractId &&
        ["current", "future"].includes(year.status)
    )
    .sort(
      (left, right) =>
        left.yearNumber - right.yearNumber ||
        compareUnicodeScalarStrings(
          left.contractYearId,
          right.contractYearId
        )
    );
  const expectedRemaining =
    contract.originalTermYears -
    currentYear.yearNumber +
    1;
  if (
    remainingYears.length !== expectedRemaining ||
    remainingYears.some((year, index) => {
      const expectedYearNumber =
        currentYear.yearNumber + index;
      return (
        year.yearNumber !== expectedYearNumber ||
        year.aavCents !== contract.aavCents ||
        (index === 0
          ? year.status !== "current" ||
            year.contractYearId !==
              currentYear.contractYearId
          : year.status !== "future")
      );
    })
  ) {
    return null;
  }
  return Object.freeze({
    contract,
    currentYear,
    remainingYears: expectedRemaining,
  });
}

function projectFreeAgentDraftCarryovers(input = {}) {
  requireExactObject(
    input,
    [
      "activeContracts",
      "allContractYears",
      "currentPlayerSources",
      "leaguePositionOverrides",
      "leagueSettings",
      "ownerships",
      "participatingTeams",
      "seasonId",
      "targetContractYears",
    ],
    "carryover_projection_fields_invalid"
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid"
  );
  const participatingTeams = requireArray(
    input.participatingTeams,
    "participating_teams_invalid"
  )
    .map((team) => ({
      ...team,
      teamId: stableId(team.teamId, "team_id_invalid"),
    }))
    .sort((left, right) =>
      compareUnicodeScalarStrings(
        left.teamId,
        right.teamId
      )
    );
  if (
    new Set(
      participatingTeams.map(({ teamId }) => teamId)
    ).size !== participatingTeams.length
  ) {
    failInput("participating_team_duplicate");
  }
  const settings = requireObject(
    input.leagueSettings,
    "league_settings_invalid"
  );
  if (
    settings.activeForwardSlots !== 12 ||
    settings.activeDefenceSlots !== 6 ||
    settings.benchSlots !== 4 ||
    settings.maximumBenchAavCents !==
      CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
  ) {
    failInput("candidate_slot_settings_invalid");
  }
  const ownerships = requireArray(
    input.ownerships,
    "ownerships_invalid"
  );
  const activeContracts = requireArray(
    input.activeContracts,
    "active_contracts_invalid"
  );
  const targetContractYears = requireArray(
    input.targetContractYears,
    "target_contract_years_invalid"
  );
  const allContractYears = requireArray(
    input.allContractYears,
    "all_contract_years_invalid"
  );
  const leaguePositionOverrides = requireArray(
    input.leaguePositionOverrides,
    "position_overrides_invalid"
  );
  const currentPlayerSources = requireArray(
    input.currentPlayerSources,
    "player_sources_invalid"
  );

  const blockers = [];
  const warnings = [];
  const blockerIdentities = new Set();
  const participantIds = new Set(
    participatingTeams.map(({ teamId }) => teamId)
  );
  const ownershipIdSet = new Set();
  const playerTeamSet = new Set();
  for (const ownership of ownerships) {
    const teamId = stableId(
      ownership.teamId,
      "ownership_team_id_invalid"
    );
    const ownershipId = stableId(
      ownership.ownershipId,
      "ownership_id_invalid"
    );
    const playerId = stableId(
      ownership.playerId,
      "ownership_player_id_invalid"
    );
    const identity = `${teamId}:${playerId}`;
    const categoryIsRostered = [
      "Active",
      "Bench",
      "Injured Reserve",
    ].includes(ownership.rosterCategory);
    const categoryIsProspect =
      ownership.rosterCategory === "Prospect";
    if (
      ownershipIdSet.has(ownershipId) ||
      playerTeamSet.has(identity) ||
      !(
        (ownership.ownershipKind === "Rostered" &&
          categoryIsRostered) ||
        (ownership.ownershipKind === "Prospect Right" &&
          categoryIsProspect)
      )
    ) {
      addTeamStateBlocker(
        blockers,
        blockerIdentities,
        "FAD_OWNERSHIP_STATE_INVALID",
        teamId,
        "ownershipId",
        "team",
        "The target-season ownership state is internally inconsistent."
      );
    }
    ownershipIdSet.add(ownershipId);
    playerTeamSet.add(identity);
    if (!participantIds.has(teamId)) {
      addTeamStateBlocker(
        blockers,
        blockerIdentities,
        "FAD_OWNERSHIP_STATE_INVALID",
        teamId,
        "teamId",
        "team",
        "The target-season ownership state is internally inconsistent."
      );
    }
  }

  const teams = [];
  for (const team of participatingTeams) {
    const used = {
      F: new Set(),
      D: new Set(),
      B: new Set(),
    };
    const entries = [];
    const teamOwnerships = ownerships
      .filter(
        (ownership) =>
          ownership.teamId === team.teamId &&
          ownership.ownershipKind === "Rostered" &&
          [
            "Active",
            "Bench",
            "Injured Reserve",
          ].includes(ownership.rosterCategory)
      )
      .sort((left, right) =>
        compareUnicodeScalarStrings(
          left.ownershipId,
          right.ownershipId
        )
      );
    const normalized = [];
    for (const ownership of teamOwnerships) {
      const position = effectivePositionForPlayer({
        playerId: ownership.playerId,
        leaguePositionOverrides,
        currentPlayerSources,
      });
      if (
        position === null ||
        ownership.positionGroup !== position
      ) {
        addTeamStateBlocker(
          blockers,
          blockerIdentities,
          "FAD_PLAYER_POSITION_INVALID",
          team.teamId,
          "positionGroup",
          "team",
          "The target-season player position state is internally inconsistent."
        );
        continue;
      }
      const evidence = contractEvidenceForOwnership({
        ownership,
        seasonId,
        activeContracts,
        targetContractYears,
        allContractYears,
      });
      if (evidence === null) {
        addTeamStateBlocker(
          blockers,
          blockerIdentities,
          "FAD_CONTRACT_STATE_INVALID",
          team.teamId,
          "contractId",
          "team",
          "The target-season contract state is internally inconsistent."
        );
        continue;
      }
      normalized.push({
        ownership,
        position,
        evidence,
      });
    }

    const direct = normalized.filter(
      ({ ownership }) =>
        ownership.rosterCategory !==
        "Injured Reserve"
    );
    const injuredReserve = normalized.filter(
      ({ ownership }) =>
        ownership.rosterCategory ===
        "Injured Reserve"
    );
    for (const item of direct) {
      const { ownership, position, evidence } = item;
      const slotGroup =
        ownership.rosterCategory === "Bench"
          ? "B"
          : position;
      const slotNumber = ownership.slotNumber;
      const finiteSlot =
        Number.isSafeInteger(slotNumber) &&
        slotNumber >= 1 &&
        slotNumber <= POSITION_SLOT_COUNTS[slotGroup];
      const benchEligible =
        slotGroup !== "B" ||
        evidence.contract.aavCents <=
          CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS;
      const canPlace =
        finiteSlot &&
        benchEligible &&
        !used[slotGroup].has(slotNumber);
      const requestedSlotNumber = finiteSlot
        ? slotNumber
        : lowestAvailable(used, slotGroup) ?? 1;
      if (canPlace) used[slotGroup].add(slotNumber);
      entries.push({
        ownershipId: ownership.ownershipId,
        playerId: ownership.playerId,
        contractId: evidence.contract.contractId,
        effectivePositionGroup: position,
        sourceRosterCategory: ownership.rosterCategory,
        requestedSlotGroup: slotGroup,
        requestedSlotNumber,
        placementState: canPlace
          ? "placed"
          : "conflict",
        conflictCode: canPlace
          ? null
          : "CARRYOVER_SLOT_CONFLICT",
        originalTotalValueCents:
          evidence.contract.originalTotalValueCents,
        originalTermYears:
          evidence.contract.originalTermYears,
        aavCents: evidence.contract.aavCents,
        remainingYears: evidence.remainingYears,
      });
    }
    for (const item of injuredReserve) {
      const { ownership, position, evidence } = item;
      const available = lowestAvailable(used, position);
      const canPlace = available !== null;
      const requestedSlotNumber = available ?? 1;
      if (canPlace) used[position].add(available);
      entries.push({
        ownershipId: ownership.ownershipId,
        playerId: ownership.playerId,
        contractId: evidence.contract.contractId,
        effectivePositionGroup: position,
        sourceRosterCategory: ownership.rosterCategory,
        requestedSlotGroup: position,
        requestedSlotNumber,
        placementState: canPlace
          ? "placed"
          : "conflict",
        conflictCode: canPlace
          ? null
          : "CARRYOVER_SLOT_CONFLICT",
        originalTotalValueCents:
          evidence.contract.originalTotalValueCents,
        originalTermYears:
          evidence.contract.originalTermYears,
        aavCents: evidence.contract.aavCents,
        remainingYears: evidence.remainingYears,
      });
    }
    entries.sort((left, right) =>
      compareUnicodeScalarStrings(
        left.ownershipId,
        right.ownershipId
      )
    );
    const structuralConflictCount = entries.filter(
      ({ placementState }) =>
        placementState === "conflict"
    ).length;
    if (structuralConflictCount > 0) {
      warnings.push(
        diagnostic(
          "FAD_CARRYOVER_STRUCTURAL_CONFLICT",
          "candidateCard",
          "team",
          team.teamId,
          "The carried-roster conflict remains editable before the deadline."
        )
      );
    }
    teams.push({
      teamId: team.teamId,
      entries,
      carryoverCount: entries.length,
      openForwardSlots:
        POSITION_SLOT_COUNTS.F - used.F.size,
      openDefenceSlots:
        POSITION_SLOT_COUNTS.D - used.D.size,
      openBenchSlots:
        POSITION_SLOT_COUNTS.B - used.B.size,
      structuralConflictCount,
    });
  }

  return deepFreeze({
    teams,
    stateBlockers: normalizeDiagnostics(
      blockers,
      "carryover_blockers_invalid"
    ),
    structuralWarnings: normalizeDiagnostics(
      warnings,
      "carryover_warnings_invalid"
    ),
  });
}

function validateRunningExecution({
  observedAtMs,
  leagueId,
  seasonId,
  occurrenceKey,
  operation,
  job,
}) {
  requireObject(operation, "readiness_operation_missing");
  requireObject(job, "readiness_job_missing");
  let parsed;
  try {
    parsed = parseFreeAgentDraftOccurrenceKey(
      occurrenceKey
    );
  } catch {
    failInput("occurrence_key_invalid");
  }
  if (
    parsed.type !== "readiness" ||
    parsed.leagueId !== leagueId ||
    parsed.seasonId !== seasonId ||
    operation.operationId === undefined ||
    operation.leagueId !== leagueId ||
    operation.seasonId !== seasonId ||
    operation.occurrenceKey !== occurrenceKey ||
    operation.status !== "running" ||
    job.jobRunId !== operation.jobRunId ||
    job.leagueId !== leagueId ||
    job.seasonId !== seasonId ||
    job.jobType !== "fad_readiness" ||
    job.occurrenceKey !== occurrenceKey ||
    job.status !== "running" ||
    job.attemptCount !== operation.attemptCount ||
    job.version !== operation.version ||
    job.leaseOwner !== operation.leaseOwner ||
    job.leaseToken !== operation.leaseToken ||
    job.leaseExpiresAtMs !==
      operation.leaseExpiresAtMs ||
    job.startedAtMs !== operation.startedAtMs ||
    job.updatedAtMs !== operation.updatedAtMs ||
    job.scheduledForMs !== operation.createdAtMs ||
    job.createdAtMs !== operation.createdAtMs ||
    operation.blockersJson !== "[]" ||
    operation.matchupScheduleVersionBefore !== null ||
    operation.matchupScheduleVersionAfter !== null ||
    operation.scheduleRecoveryId !== null ||
    operation.createdFadId !== null ||
    operation.reminderJobRunId !== null ||
    operation.deadlineJobRunId !== null ||
    operation.cardsOpenedActivityId !== null ||
    operation.cardsOpenedOutboxEventId !== null ||
    operation.nextRetryAtMs !== null ||
    operation.terminalAtMs !== null ||
    job.completedAtMs !== null ||
    job.resultJson !== null ||
    job.lastErrorCode !== null ||
    job.nextAttemptAtMs !== null ||
    operation.createdAtMs > operation.startedAtMs ||
    operation.startedAtMs > observedAtMs ||
    operation.leaseExpiresAtMs <= observedAtMs
  ) {
    failInput("readiness_execution_split");
  }
  stableId(
    operation.operationId,
    "readiness_operation_id_invalid"
  );
  stableId(job.jobRunId, "readiness_job_id_invalid");
  positiveInteger(
    operation.attemptCount,
    "readiness_attempt_count_invalid"
  );
  positiveInteger(
    operation.version,
    "readiness_version_invalid"
  );
  boundedText(
    operation.leaseOwner,
    128,
    "readiness_lease_owner_invalid"
  );
  boundedText(
    operation.leaseToken,
    200,
    "readiness_lease_token_invalid"
  );
  safeTimestamp(
    operation.leaseExpiresAtMs,
    "readiness_lease_expiry_invalid"
  );
  safeTimestamp(
    operation.createdAtMs,
    "readiness_created_at_ms_invalid"
  );
  safeTimestamp(
    operation.startedAtMs,
    "readiness_started_at_ms_invalid"
  );
  return Object.freeze({
    leaseExpiresAtMs: operation.leaseExpiresAtMs,
    parsedOccurrence: parsed,
  });
}

const ROLLOVER_SUMMARY_KEYS = Object.freeze([
  "contractsAdvanced",
  "contractsExpired",
  "ownershipsCarried",
  "ownershipsReleased",
  "retentionYearsAdvanced",
  "retentionObligationsCompleted",
  "buyoutYearsAdvanced",
  "buyoutObligationsCompleted",
  "tradesCancelled",
]);
const ROLLOVER_EFFECT_SUMMARY_KEYS = Object.freeze({
  contract_advanced: "contractsAdvanced",
  contract_expired: "contractsExpired",
  ownership_carried: "ownershipsCarried",
  ownership_released: "ownershipsReleased",
  retention_year_advanced: "retentionYearsAdvanced",
  retention_obligation_completed:
    "retentionObligationsCompleted",
  buyout_year_advanced: "buyoutYearsAdvanced",
  buyout_obligation_completed:
    "buyoutObligationsCompleted",
  trade_cancelled: "tradesCancelled",
});

function priorRolloverEvidenceIsValid({
  root,
  receipt,
  ownershipReceipt,
  items,
  entryDraftId,
  leagueId,
  priorSeasonId,
  season,
  seasonId,
}) {
  if (
    !isPlainObject(receipt) ||
    receipt.rolloverId !== root.rolloverId ||
    receipt.leagueId !== leagueId ||
    receipt.fromSeasonId !== priorSeasonId ||
    receipt.toSeasonId !== seasonId ||
    receipt.fromSeasonStatus !== "completed" ||
    receipt.toSeasonStatus !== "active" ||
    receipt.entryDraftId !== entryDraftId ||
    receipt.completedAtMs !== root.completedAtMs ||
    receipt.sourceReadinessSchemaVersion !== 1 ||
    !SHA256_PATTERN.test(
      receipt.sourceReadinessSha256 || ""
    ) ||
    receipt.targetNhlSeasonKey !== season.nhlSeasonKey ||
    receipt.nhlRegularSeasonStartsAtMs !==
      season.regularSeasonStartsAtMs ||
    receipt.nhlRegularSeasonEndsAtMs !==
      season.regularSeasonEndsAtMs ||
    receipt.fantasyPlayoffsStartAtMs !==
      season.fantasyPlayoffsStartAtMs ||
    receipt.fantasyPlayoffsEndAtMs !==
      season.fantasyPlayoffsEndAtMs ||
    !isStableId(receipt.rolloverAttemptId) ||
    !isStableId(receipt.entryDraftRolloverBindingId) ||
    !isStableId(receipt.rolloverOccurrenceId) ||
    !isStableId(receipt.targetScheduleId) ||
    !isStableId(receipt.weekOneMatchupWeekId) ||
    !isStableId(receipt.firstPickClockId) ||
    ![
      "scheduled_job",
      "commissioner_retry",
    ].includes(receipt.trigger) ||
    !isPositiveInteger(receipt.version) ||
    receipt.version !== 1 ||
    !isPlainObject(receipt.summary)
  ) {
    return false;
  }
  const summaryKeys = Object.keys(receipt.summary).sort();
  if (
    summaryKeys.length !== ROLLOVER_SUMMARY_KEYS.length ||
    summaryKeys.some(
      (key, index) =>
        key !== [...ROLLOVER_SUMMARY_KEYS].sort()[index]
    ) ||
    ROLLOVER_SUMMARY_KEYS.some(
      (key) =>
        !isNonnegativeInteger(receipt.summary[key])
    ) ||
    items.length !==
      ROLLOVER_SUMMARY_KEYS.reduce(
        (total, key) => total + receipt.summary[key],
        0
      )
  ) {
    return false;
  }
  const itemIds = new Set();
  const effectCounts = Object.fromEntries(
    Object.keys(ROLLOVER_EFFECT_SUMMARY_KEYS).map(
      (effectKind) => [effectKind, 0]
    )
  );
  if (
    items.some((item) => {
      if (
        Object.hasOwn(effectCounts, item.effectKind)
      ) {
        effectCounts[item.effectKind] += 1;
      }
      const invalid =
        !isStableId(item.itemId) ||
        item.leagueId !== leagueId ||
        item.rolloverId !== root.rolloverId ||
        item.fromSeasonId !== priorSeasonId ||
        item.toSeasonId !== seasonId ||
        !isStableId(item.entityId) ||
        !SHA256_PATTERN.test(item.payloadSha256 || "") ||
        item.occurredAtMs !== root.completedAtMs ||
        item.version !== 1 ||
        !Object.hasOwn(
          ROLLOVER_EFFECT_SUMMARY_KEYS,
          item.effectKind
        ) ||
        itemIds.has(item.itemId);
      itemIds.add(item.itemId);
      return invalid;
    })
  ) {
    return false;
  }
  if (
    Object.entries(ROLLOVER_EFFECT_SUMMARY_KEYS).some(
      ([effectKind, summaryKey]) =>
        effectCounts[effectKind] !==
        receipt.summary[summaryKey]
    )
  ) {
    return false;
  }
  if (
    !isPlainObject(ownershipReceipt) ||
    ownershipReceipt.rolloverId !== root.rolloverId ||
    ownershipReceipt.leagueId !== leagueId ||
    ownershipReceipt.fromSeasonId !== priorSeasonId ||
    ownershipReceipt.toSeasonId !== seasonId ||
    !Array.isArray(ownershipReceipt.teams)
  ) {
    return false;
  }
  return ownershipReceipt.teams.every(
    (team) =>
      isPlainObject(team) &&
      team.leagueId === leagueId &&
      [priorSeasonId, seasonId].includes(team.seasonId) &&
      isStableId(team.teamId) &&
      Array.isArray(team.ownershipWitnesses) &&
      team.ownershipWitnesses.every(
        (witness) =>
          isStableId(witness.ownershipId) &&
          isPositiveInteger(witness.ownershipVersion) &&
          ["present", "deleted"].includes(witness.state)
      )
  );
}

function setupExemptionEvidenceIsValid({
  exemption,
  leagueId,
  season,
  seasonId,
}) {
  return (
    isPlainObject(exemption) &&
    exemption.leagueId === leagueId &&
    exemption.seasonId === seasonId &&
    exemption.exemptionKind ===
      "initial_season2_transition" &&
    season.label === "2026" &&
    season.nhlSeasonKey === "20262027" &&
    isStableId(exemption.migrationReportId) &&
    isStableId(exemption.authorizedByUserId) &&
    isStableId(exemption.authorizedByMembershipId) &&
    exemption.authorizedAuthority ===
      "platform_administrator_as_commissioner" &&
    isNonnegativeInteger(exemption.authorizedAtMs) &&
    isStableId(exemption.idempotencyRequestId) &&
    SHA256_PATTERN.test(
      exemption.migrationReportSha256 || ""
    ) &&
    SHA256_PATTERN.test(
      exemption.bootstrapIdentitySha256 || ""
    ) &&
    [
      "bootstrapIdempotencyRequestId",
      "bootstrapActivityId",
      "bootstrapSecurityAuditEventId",
      "bootstrapActorUserId",
      "authorizationActivityId",
      "authorizationSecurityAuditEventId",
      "commissionerNotificationId",
      "outboxEventId",
    ].every((field) => isStableId(exemption[field])) &&
    exemption.createdAtMs === exemption.authorizedAtMs &&
    exemption.updatedAtMs === exemption.authorizedAtMs &&
    exemption.version === 1 &&
    exemption.consumedFadId === null &&
    exemption.consumedAtMs === null &&
    typeof exemption.reason === "string" &&
    exemption.reason.length >= 1 &&
    exemption.reason.length <= 500 &&
    exemption.reason === exemption.reason.trim()
  );
}

function inspectSetupPath({
  context,
  operation,
  parsedOccurrence,
  leagueId,
  seasonId,
  blockers,
}) {
  const invalidNoDraft = (resourceId, resourceType) => {
    blockers.push(
      diagnostic(
        "FAD_NO_DRAFT_PATH_INVALID",
        "setupExemptionId",
        resourceType,
        resourceId,
        "The approved no-draft opening evidence is not ready."
      )
    );
    return null;
  };
  const triggerResourceId =
    parsedOccurrence.triggerResourceId;
  if (operation.triggerKind === "entry_draft_completed") {
    const draft = context.entryDraft;
    if (
      !draft ||
      draft.entryDraftId !== operation.entryDraftId ||
      triggerResourceId !== operation.entryDraftId ||
      operation.setupExemptionId !== null ||
      draft.status !== "Complete" ||
      !isNonnegativeInteger(draft.completedAtMs) ||
      draft.completedAtMs > operation.createdAtMs ||
      !isPositiveInteger(draft.version)
    ) {
      blockers.push(
        diagnostic(
          "FAD_ENTRY_DRAFT_NOT_COMPLETE",
          "entryDraftId",
          "entry_draft",
          operation.entryDraftId ||
            triggerResourceId,
          "The target season Entry Draft is not complete."
        )
      );
      return null;
    }
    const rollover = context.priorSeasonRollovers;
    if (rollover.length === 0) {
      blockers.push(
        diagnostic(
          "FAD_ROLLOVER_MISSING",
          "priorSeasonRolloverId",
          "season",
          seasonId,
          "The prior season rollover is not ready."
        )
      );
      return null;
    }
    const root = rollover.length === 1
      ? rollover[0]
      : null;
    const receipt =
      context.priorSeasonRolloverReceipt;
    const ownershipReceipt =
      context.priorSeasonRolloverOwnershipReceipt;
    const prior = context.priorSeason;
    const invalid =
      !root ||
      !prior ||
      prior.status !== "completed" ||
      !isNonnegativeInteger(
        prior.freeAgentDraftCompletedAtMs
      ) ||
      !isPositiveInteger(prior.version) ||
      root.status !== "succeeded" ||
      root.fromSeasonId !== prior.seasonId ||
      root.toSeasonId !== seasonId ||
      !isNonnegativeInteger(root.completedAtMs) ||
      prior.freeAgentDraftCompletedAtMs >
        root.completedAtMs ||
      root.completedAtMs > draft.completedAtMs ||
      root.version !== 1 ||
      !SHA256_PATTERN.test(root.manifestSha256 || "") ||
      !priorRolloverEvidenceIsValid({
        root,
        receipt,
        ownershipReceipt,
        items: context.priorSeasonRolloverItems,
        entryDraftId: draft.entryDraftId,
        leagueId,
        priorSeasonId: prior.seasonId,
        season: context.season,
        seasonId,
      }) ||
      context.priorSeasonContractYears.some(
        ({ status }) => status === "current"
      ) ||
      context.priorSeasonRetentionYears.some(
        ({ status }) => status === "current"
      ) ||
      context.priorSeasonBuyoutYears.some(
        ({ status }) => status === "current"
      );
    if (invalid) {
      blockers.push(
        diagnostic(
          "FAD_ROLLOVER_INVALID",
          "priorSeasonRolloverId",
          "season_rollover",
          root?.rolloverId || seasonId,
          "The prior season rollover evidence does not match current league state."
        )
      );
      return null;
    }
    return Object.freeze({
      setupPath: "completed_entry_draft",
      entryDraftId: draft.entryDraftId,
      setupExemptionId: null,
      priorSeasonRolloverId: root.rolloverId,
      noDraftReason: null,
    });
  }
  if (operation.triggerKind === "no_draft_inaugural") {
    if (
      triggerResourceId !== seasonId ||
      operation.entryDraftId !== null ||
      operation.setupExemptionId !== null ||
      context.entryDraft !== null ||
      context.priorSeason !== null ||
      context.priorSeasonRollovers.length !== 0 ||
      context.setupExemptions.length !== 0
    ) {
      return invalidNoDraft(seasonId, "season");
    }
    return Object.freeze({
      setupPath: "no_draft_inaugural",
      entryDraftId: null,
      setupExemptionId: null,
      priorSeasonRolloverId: null,
      noDraftReason: INAUGURAL_REASON,
    });
  }
  if (
    operation.triggerKind ===
    "no_draft_initial_season2"
  ) {
    const exemptions = context.setupExemptions;
    const exemption =
      exemptions.length === 1
        ? exemptions[0]
        : null;
    if (
      operation.entryDraftId !== null ||
      context.entryDraft !== null ||
      context.priorSeason !== null ||
      context.priorSeasonRollovers.length !== 0 ||
      !exemption ||
      exemption.exemptionId !==
        operation.setupExemptionId ||
      triggerResourceId !==
        operation.setupExemptionId ||
      !setupExemptionEvidenceIsValid({
        exemption,
        leagueId,
        season: context.season,
        seasonId,
      }) ||
      exemption.authorizedAtMs > operation.createdAtMs
    ) {
      return invalidNoDraft(
        operation.setupExemptionId ||
          triggerResourceId,
        "free_agent_draft_setup_exemption"
      );
    }
    return Object.freeze({
      setupPath: "no_draft_initial_season2",
      entryDraftId: null,
      setupExemptionId: exemption.exemptionId,
      priorSeasonRolloverId: null,
      noDraftReason: exemption.reason,
    });
  }
  return invalidNoDraft(
    triggerResourceId,
    "season"
  );
}

function scheduleInspection({
  context,
  observedAtMs,
  seasonId,
  blockers,
  warnings,
}) {
  const schedule = context.currentSchedule;
  if (schedule === null) {
    if (
      context.currentScheduleOperation !== null ||
      context.firstMatchupWeek !== null ||
      context.currentScheduleJobBindings.length !== 0
    ) {
      failInput("current_schedule_evidence_split");
    }
    blockers.push(
      createFreeAgentDraftReadinessMissingScheduleBlocker({
        seasonId,
      })
    );
    return {
      currentSchedule: null,
      firstMatchupWeekBefore: null,
      scheduleDecision: null,
    };
  }
  const operation = context.currentScheduleOperation;
  const week = context.firstMatchupWeek;
  if (
    !operation ||
    !week ||
    operation.operationId !== schedule.operationId ||
    operation.seasonId !== seasonId ||
    operation.operationType !== "schedule_generate" ||
    operation.status !== "succeeded" ||
    operation.completedAtMs !== schedule.createdAtMs ||
    schedule.weekId !== week.weekId ||
    schedule.startsAtMs !== week.startsAtMs ||
    week.sequence !== 1 ||
    !isPositiveInteger(week.version) ||
    !isNonnegativeInteger(schedule.createdAtMs) ||
    !isNonnegativeInteger(operation.startedAtMs) ||
    !isNonnegativeInteger(operation.completedAtMs) ||
    operation.startedAtMs > operation.completedAtMs ||
    context.currentScheduleJobBindings.some(
      (binding) =>
        binding.scheduleOperationId !==
          schedule.operationId ||
        binding.scheduleVersion !== schedule.version ||
        !isStableId(binding.bindingId) ||
        !isStableId(binding.jobRunId)
    )
  ) {
    failInput("current_schedule_evidence_split");
  }
  stableId(schedule.operationId, "schedule_operation_id_invalid");
  stableId(schedule.weekId, "week_id_invalid");
  positiveInteger(schedule.version, "schedule_version_invalid");
  positiveInteger(
    schedule.generationVersion,
    "schedule_generation_version_invalid"
  );
  safeTimestamp(schedule.startsAtMs, "week_one_starts_at_ms_invalid");
  const currentSchedule = Object.freeze({
    operationId: schedule.operationId,
    version: schedule.version,
    generationVersion: schedule.generationVersion,
    weekOneMatchupWeekId: schedule.weekId,
    weekOneStartsAtMs: schedule.startsAtMs,
    createdAtMs: schedule.createdAtMs,
  });
  const firstMatchupWeekBefore = Object.freeze({
    sequence: 1,
    startsAtMs: schedule.startsAtMs,
    version: schedule.version,
    weekId: schedule.weekId,
  });
  let scheduleDecision;
  try {
    scheduleDecision =
      planFreeAgentDraftPreOpenScheduleRecovery({
        readinessAtMs: observedAtMs,
        firstWeekStartsAtMs: schedule.startsAtMs,
        fantasyPlayoffsStartAtMs:
          context.season.fantasyPlayoffsStartAtMs,
        timeZone: context.league.timeZone,
      });
  } catch (error) {
    if (
      error instanceof
      FreeAgentDraftScheduleRecoveryPolicyError &&
      error.code ===
        "FAD_SCHEDULE_RECOVERY_UNAVAILABLE"
    ) {
      blockers.push(
        diagnostic(
          "FAD_WEEK_ONE_RECOVERY_UNAVAILABLE",
          "firstMatchupStartsAtMs",
          "season",
          seasonId,
          "No valid league-local Monday remains before the fantasy playoffs."
        )
      );
      return {
        currentSchedule,
        firstMatchupWeekBefore,
        scheduleDecision: null,
      };
    }
    failInput("schedule_recovery_clock_invalid");
  }
  if (scheduleDecision.recoveryRequired) {
    warnings.push(
      diagnostic(
        "FAD_WEEK_ONE_MOVED",
        "firstMatchupStartsAtMs",
        "matchup_week",
        schedule.weekId,
        "Week 1 must move to preserve the complete FAD period."
      )
    );
  }
  return {
    currentSchedule,
    firstMatchupWeekBefore,
    scheduleDecision,
  };
}

function inspectFreeAgentDraftOpeningReadiness(
  input = {}
) {
  requireExactObject(
    input,
    [
      "context",
      "leagueId",
      "observedAtMs",
      "occurrenceKey",
      "seasonId",
    ],
    "opening_readiness_fields_invalid"
  );
  const leagueId = stableId(
    input.leagueId,
    "league_id_invalid"
  );
  const seasonId = stableId(
    input.seasonId,
    "season_id_invalid"
  );
  const observedAtMs = safeTimestamp(
    input.observedAtMs,
    "observed_at_ms_invalid"
  );
  boundedText(
    input.occurrenceKey,
    500,
    "occurrence_key_invalid"
  );
  const context = requireExactObject(
    input.context,
    CONTEXT_KEYS,
    "opening_context_fields_invalid"
  );
  for (const key of CONTEXT_KEYS.filter(
    (key) =>
      key.endsWith("s") ||
      [
        "allContractYears",
        "currentPlayerSources",
        "leaguePositionOverrides",
        "managerAssignments",
        "participatingTeams",
        "priorSeasonRolloverItems",
        "setupExemptions",
        "targetContractYears",
      ].includes(key)
  )) {
    if (key === "leagueSettings") continue;
    requireArray(context[key], `${key}_invalid`);
  }
  const league = requireObject(
    context.league,
    "league_invalid"
  );
  const season = requireObject(
    context.season,
    "season_invalid"
  );
  if (
    league.leagueId !== leagueId ||
    season.seasonId !== seasonId
  ) {
    failInput("opening_scope_split");
  }
  positiveInteger(
    season.version,
    "season_version_invalid"
  );
  const execution = validateRunningExecution({
    observedAtMs,
    leagueId,
    seasonId,
    occurrenceKey: input.occurrenceKey,
    operation: context.readinessOperation,
    job: context.readinessJob,
  });
  const blockers = [];
  const warnings = [];
  if (
    league.status !== "active" ||
    league.currentSeasonId !== seasonId ||
    season.status !== "active" ||
    season.freeAgentDraftCompletedAtMs !== null
  ) {
    blockers.push(
      diagnostic(
        "FAD_TARGET_SEASON_NOT_READY",
        "seasonId",
        "season",
        seasonId,
        "The target season is not current and active for Free Agent Draft readiness."
      )
    );
  }
  if (context.existingFad !== null) {
    blockers.push(
      diagnostic(
        "FAD_ALREADY_EXISTS",
        "seasonId",
        "season",
        seasonId,
        "A Free Agent Draft already exists for the target season."
      )
    );
  }
  const setup = inspectSetupPath({
    context,
    operation: context.readinessOperation,
    parsedOccurrence: execution.parsedOccurrence,
    leagueId,
    seasonId,
    blockers,
  });
  const teams = context.participatingTeams
    .map((team) => ({
      ...team,
      teamId: stableId(team.teamId, "team_id_invalid"),
    }))
    .sort((left, right) =>
      compareUnicodeScalarStrings(
        left.teamId,
        right.teamId
      )
    );
  if (teams.length === 0) {
    blockers.push(
      diagnostic(
        "FAD_PARTICIPATING_TEAMS_MISSING",
        "participatingTeamCount",
        "league",
        leagueId,
        "The league needs at least one active participating team."
      )
    );
  }
  if (
    !isPositiveInteger(
      context.leagueSettings.maximumTeams
    ) ||
    teams.length > context.leagueSettings.maximumTeams ||
    teams.some(({ status }) => status !== "active")
  ) {
    blockers.push(
      diagnostic(
        "FAD_PARTICIPATING_TEAMS_INVALID",
        "participatingTeamCount",
        "league",
        leagueId,
        "Every participating team must be active and within the league team limit."
      )
    );
  }
  if (
    new Set(teams.map(({ teamId }) => teamId)).size !==
    teams.length
  ) {
    failInput("participating_team_duplicate");
  }
  const participantBindings = [];
  const managerByTeam = new Map();
  for (const assignment of context.managerAssignments) {
    if (!managerByTeam.has(assignment.teamId)) {
      managerByTeam.set(assignment.teamId, []);
    }
    managerByTeam.get(assignment.teamId).push(assignment);
  }
  const managerState = new Map();
  for (const team of teams) {
    const assignments = managerByTeam.get(team.teamId) || [];
    const valid = assignments.filter(
      (assignment) =>
        assignment.assignmentStatus === "accepted" &&
        assignment.endedAtMs === null &&
        assignment.membershipStatus === "active" &&
        assignment.userStatus === "active"
    );
    if (assignments.length === 0) {
      blockers.push(
        diagnostic(
          "FAD_MANAGER_MISSING",
          "managerAssignmentId",
          "team",
          team.teamId,
          "Every participating team needs a current manager."
        )
      );
      managerState.set(team.teamId, null);
      continue;
    }
    if (assignments.length !== 1 || valid.length !== 1) {
      blockers.push(
        diagnostic(
          "FAD_MANAGER_INVALID",
          "managerAssignmentId",
          "team",
          team.teamId,
          "The participating team manager assignment is not active and accepted."
        )
      );
      managerState.set(team.teamId, null);
      continue;
    }
    const assignment = valid[0];
    const binding = Object.freeze({
      managerAssignmentId: stableId(
        assignment.managerAssignmentId,
        "manager_assignment_id_invalid"
      ),
      managerMembershipId: stableId(
        assignment.membershipId,
        "manager_membership_id_invalid"
      ),
      managerUserId: stableId(
        assignment.userId,
        "manager_user_id_invalid"
      ),
      teamId: team.teamId,
    });
    managerState.set(team.teamId, binding);
    participantBindings.push(binding);
  }
  blockers.push(
    ...inspectAuthoritativeSeasonState({
      context,
      leagueId,
      seasonId,
      participatingTeams: teams,
    })
  );
  const carryoverProjection =
    projectFreeAgentDraftCarryovers({
      seasonId,
      participatingTeams: teams,
      leagueSettings: context.leagueSettings,
      ownerships: context.ownerships,
      activeContracts: context.activeContracts,
      targetContractYears: context.targetContractYears,
      allContractYears: context.allContractYears,
      leaguePositionOverrides:
        context.leaguePositionOverrides,
      currentPlayerSources:
        context.currentPlayerSources,
    });
  blockers.push(...carryoverProjection.stateBlockers);
  warnings.push(
    ...carryoverProjection.structuralWarnings
  );
  const schedule = scheduleInspection({
    context,
    observedAtMs,
    seasonId,
    blockers,
    warnings,
  });
  const carryoverByTeam = new Map(
    carryoverProjection.teams.map((team) => [
      team.teamId,
      team,
    ])
  );
  const teamProjections = teams.map((team) => {
    const manager = managerState.get(team.teamId);
    const carryover = carryoverByTeam.get(team.teamId);
    return Object.freeze({
      carryoverCount: carryover.carryoverCount,
      managerAssignmentId:
        manager?.managerAssignmentId ?? null,
      managerReady: manager !== null,
      openBenchSlots: carryover.openBenchSlots,
      openDefenceSlots: carryover.openDefenceSlots,
      openForwardSlots: carryover.openForwardSlots,
      structuralConflictCount:
        carryover.structuralConflictCount,
      team: safeTeam(team),
      teamId: team.teamId,
    });
  });
  let priorSeasonRollover = null;
  if (setup?.priorSeasonRolloverId) {
    const root = context.priorSeasonRollovers.find(
      ({ rolloverId }) =>
        rolloverId === setup.priorSeasonRolloverId
    );
    priorSeasonRollover = Object.freeze({
      completedAtMs: root.completedAtMs,
      fromSeasonId: root.fromSeasonId,
      manifestSha256: root.manifestSha256,
      rolloverId: root.rolloverId,
      toSeasonId: root.toSeasonId,
    });
  }
  const internalBlockers = normalizeDiagnostics(
    blockers,
    "opening_blockers_invalid"
  );
  const internalWarnings = normalizeDiagnostics(
    warnings,
    "opening_warnings_invalid"
  );
  const inspection = deepFreeze({
    kind:
      "free_agent_draft_opening_readiness_inspection_v1",
    carryoverProjection,
    currentSchedule: schedule.currentSchedule,
    firstMatchupWeekBefore:
      schedule.firstMatchupWeekBefore,
    internalBlockers,
    internalWarnings,
    leagueId,
    leaseExpiresAtMs: execution.leaseExpiresAtMs,
    observedAtMs,
    observedSeasonVersion: season.version,
    occurrenceKey: input.occurrenceKey,
    participantBindings,
    priorSeasonRollover,
    readyForSchedulePlanning:
      internalBlockers.length === 0,
    scheduleDecision: schedule.scheduleDecision,
    seasonId,
    setup,
    teamProjections,
  });
  TRUSTED_INSPECTIONS.add(inspection);
  return inspection;
}

const INSPECTION_KEYS = Object.freeze([
  "carryoverProjection",
  "currentSchedule",
  "firstMatchupWeekBefore",
  "internalBlockers",
  "internalWarnings",
  "kind",
  "leagueId",
  "leaseExpiresAtMs",
  "observedAtMs",
  "observedSeasonVersion",
  "occurrenceKey",
  "participantBindings",
  "priorSeasonRollover",
  "readyForSchedulePlanning",
  "scheduleDecision",
  "seasonId",
  "setup",
  "teamProjections",
]);

function normalizeTargetSchedule(value) {
  if (value === null) return null;
  requireExactObject(
    value,
    [
      "operationId",
      "version",
      "weekOneMatchupWeekId",
      "weekOneStartsAtMs",
    ],
    "target_schedule_fields_invalid",
    failResult
  );
  if (
    !isStableId(value.operationId) ||
    !isStableId(value.weekOneMatchupWeekId) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isSafeInteger(value.weekOneStartsAtMs) ||
    value.weekOneStartsAtMs < 0
  ) {
    failResult("target_schedule_invalid");
  }
  return Object.freeze({
    operationId: value.operationId,
    version: value.version,
    weekOneMatchupWeekId:
      value.weekOneMatchupWeekId,
    weekOneStartsAtMs: value.weekOneStartsAtMs,
  });
}

function finalizeFreeAgentDraftOpeningReadiness(
  input = {}
) {
  requireExactObject(
    input,
    ["inspection", "openedAtMs", "targetSchedule"],
    "opening_finalization_fields_invalid",
    failResult
  );
  const inspection = requireExactObject(
    input.inspection,
    INSPECTION_KEYS,
    "opening_inspection_fields_invalid",
    failResult
  );
  if (
    inspection.kind !==
      "free_agent_draft_opening_readiness_inspection_v1" ||
    !Object.isFrozen(inspection) ||
    !TRUSTED_INSPECTIONS.has(inspection)
  ) {
    failResult("opening_inspection_invalid");
  }
  const hasBlockers =
    inspection.internalBlockers.length > 0;
  const targetSchedule = normalizeTargetSchedule(
    input.targetSchedule
  );
  const openedAtMs =
    input.openedAtMs === null
      ? null
      : input.openedAtMs;
  if (hasBlockers) {
    if (
      targetSchedule !== null ||
      openedAtMs !== null
    ) {
      failResult("blocked_opening_must_not_bind_commit_state");
    }
  } else if (
    targetSchedule === null ||
    !isNonnegativeInteger(openedAtMs) ||
    openedAtMs < inspection.observedAtMs ||
    openedAtMs >= inspection.leaseExpiresAtMs ||
    inspection.setup === null ||
    inspection.scheduleDecision === null ||
    inspection.currentSchedule === null
  ) {
    failResult("successful_opening_projection_incomplete");
  }
  let firstMatchupWeekAfter = null;
  let clock = null;
  if (!hasBlockers) {
    const recoveryRequired =
      inspection.scheduleDecision.recoveryRequired;
    const current = inspection.currentSchedule;
    const targetMatches = recoveryRequired
      ? targetSchedule.operationId !==
          current.operationId &&
        targetSchedule.version === current.version + 1 &&
        targetSchedule.weekOneMatchupWeekId !==
          current.weekOneMatchupWeekId &&
        targetSchedule.weekOneStartsAtMs ===
          inspection.scheduleDecision.firstWeekStartsAtMs
      : targetSchedule.operationId ===
          current.operationId &&
        targetSchedule.version === current.version &&
        targetSchedule.weekOneMatchupWeekId ===
          current.weekOneMatchupWeekId &&
        targetSchedule.weekOneStartsAtMs ===
          current.weekOneStartsAtMs;
    if (!targetMatches) {
      failResult("target_schedule_mismatch");
    }
    try {
      const freshness =
        planFreeAgentDraftPreOpenScheduleRecovery({
          readinessAtMs: openedAtMs,
          firstWeekStartsAtMs:
            targetSchedule.weekOneStartsAtMs,
          fantasyPlayoffsStartAtMs:
            inspection.scheduleDecision
              .fantasyPlayoffsStartAtMs,
          timeZone:
            inspection.scheduleDecision.timeZone,
        });
      if (freshness.recoveryRequired) {
        failResult("opening_schedule_became_stale");
      }
      clock = createFreeAgentDraftClock({
        cardsOpenedAtMs: openedAtMs,
        firstMatchupStartsAtMs:
          targetSchedule.weekOneStartsAtMs,
      });
    } catch (error) {
      if (
        error instanceof
        FreeAgentDraftOpeningReadinessPolicyError
      ) {
        throw error;
      }
      failResult("opening_clock_invalid");
    }
    firstMatchupWeekAfter = Object.freeze({
      sequence: 1,
      startsAtMs: targetSchedule.weekOneStartsAtMs,
      version: targetSchedule.version,
      weekId: targetSchedule.weekOneMatchupWeekId,
    });
  }
  if (
    !hasBlockers &&
    (
      inspection.setup === null ||
      inspection.scheduleDecision === null ||
      firstMatchupWeekAfter === null
    )
  ) {
    failResult("successful_opening_projection_incomplete");
  }
  const publicBlockers =
    projectFreeAgentDraftReadinessPublicDiagnostics(
      inspection.internalBlockers
    );
  const publicWarnings =
    projectFreeAgentDraftReadinessPublicDiagnostics(
      inspection.internalWarnings
    );
  const attemptProjection = deepFreeze({
    blockers: publicBlockers,
    candidateDeadlineAtMs:
      clock?.candidateDeadlineAtMs ?? null,
    firstMatchupWeekAfter,
    firstMatchupWeekBefore:
      inspection.firstMatchupWeekBefore,
    helpOpensAtMs: clock?.helpOpensAtMs ?? null,
    initialRollovers:
      clock?.initialRollovers.map(
        ({
          creationCutoffAtMs,
          opensAtMs,
          rollsOverAtMs,
          sequence,
        }) => ({
          creationCutoffAtMs,
          opensAtMs,
          rollsOverAtMs,
          sequence,
        })
      ) ?? [],
    observedSeasonVersion:
      inspection.observedSeasonVersion,
    participatingTeamCount:
      inspection.teamProjections.length,
    priorSeasonRollover:
      inspection.priorSeasonRollover,
    reminderAtMs: clock?.reminderAtMs ?? null,
    teamProjections: inspection.teamProjections,
    warnings: publicWarnings,
  });
  const outcome = hasBlockers
    ? "blocked"
    : "succeeded";
  const opening = hasBlockers
    ? null
    : deepFreeze({
        clock,
        carryoverProjection:
          inspection.carryoverProjection,
        currentSchedule: inspection.currentSchedule,
        firstMatchupWeekAfter,
        participantBindings:
          inspection.participantBindings,
        scheduleRecoveryRequired:
          inspection.scheduleDecision.recoveryRequired,
        setup: inspection.setup,
        targetSchedule,
      });
  return deepFreeze({
    attemptProjection,
    internalBlockers: inspection.internalBlockers,
    internalWarnings: inspection.internalWarnings,
    opening,
    outcome,
  });
}

module.exports = {
  FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES,
  FreeAgentDraftOpeningReadinessPolicyError,
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
  projectFreeAgentDraftCarryovers,
};
