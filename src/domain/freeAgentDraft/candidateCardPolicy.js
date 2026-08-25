const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,100}$/;

const CANDIDATE_CARD_MANDATORY_SLOT_COUNT = 18;
const CANDIDATE_CARD_BENCH_SLOT_COUNT = 4;
const CANDIDATE_CARD_SLOT_COUNT =
  CANDIDATE_CARD_MANDATORY_SLOT_COUNT +
  CANDIDATE_CARD_BENCH_SLOT_COUNT;
const CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS = 400;
const CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS = 100;
const CANDIDATE_CARD_AAV_INCREMENT_CENTS = 25;

const CANDIDATE_CARD_CONTRACT_TYPES = Object.freeze([
  "normal",
  "fantasy_elc",
]);
const CANDIDATE_CARD_CARRYOVER_ROSTER_CATEGORIES =
  Object.freeze([
    "Active",
    "Bench",
    "Injured Reserve",
  ]);
const CANDIDATE_CARD_EFFECTIVE_POSITIONS =
  Object.freeze(["F", "D"]);
const CANDIDATE_CARD_ELIGIBILITY_STATUSES =
  Object.freeze(["valid", "warning", "invalid"]);
const CANDIDATE_CARD_EDITOR_AUTHORITIES =
  Object.freeze([
    "manager",
    "commissioner",
    "platform_administrator_as_commissioner",
  ]);

const CANDIDATE_CARD_POLICY_CODES = Object.freeze({
  inputInvalid: "CANDIDATE_CARD_INPUT_INVALID",
  slotInvalid: "CANDIDATE_SLOT_INVALID",
  slotOccupied: "CANDIDATE_SLOT_OCCUPIED",
  carryoverLocked: "CANDIDATE_CARRYOVER_LOCKED",
  playerIneligible: "CANDIDATE_PLAYER_INELIGIBLE",
  playerDuplicate: "CANDIDATE_PLAYER_DUPLICATE",
  contractInvalid: "CANDIDATE_CONTRACT_INVALID",
  benchAavExceeded: "CANDIDATE_BENCH_AAV_EXCEEDED",
  capExceeded: "CANDIDATE_CARD_CAP_EXCEEDED",
  capProjectionInvalid:
    "CANDIDATE_CAP_PROJECTION_INVALID",
});

class CandidateCardPolicyError extends Error {
  constructor(code, reasonCode) {
    super("The Candidate Card input is invalid.");
    this.name = "CandidateCardPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function fail(code, reasonCode) {
  throw new CandidateCardPolicyError(
    code,
    reasonCode
  );
}

function failInput(reasonCode) {
  fail(
    CANDIDATE_CARD_POLICY_CODES.inputInvalid,
    reasonCode
  );
}

function failSlot(reasonCode) {
  fail(
    CANDIDATE_CARD_POLICY_CODES.slotInvalid,
    reasonCode
  );
}

function failContract(reasonCode) {
  fail(
    CANDIDATE_CARD_POLICY_CODES.contractInvalid,
    reasonCode
  );
}

function failCap(reasonCode) {
  fail(
    CANDIDATE_CARD_POLICY_CODES
      .capProjectionInvalid,
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
  reasonCode = "input_fields_invalid"
) {
  if (!isPlainObject(value)) {
    failInput("input_invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    failInput(reasonCode);
  }
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
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function enumValue(
  value,
  accepted,
  reasonCode,
  reject = failInput
) {
  if (
    typeof value !== "string" ||
    !accepted.includes(value)
  ) {
    reject(reasonCode);
  }
  return value;
}

function safeBoolean(value, reasonCode) {
  if (typeof value !== "boolean") {
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

function safeNonnegativeAmount(
  value,
  reasonCode,
  reject = failInput
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    reject(reasonCode);
  }
  return value;
}

function safePositiveAmount(
  value,
  reasonCode,
  reject = failContract
) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    reject(reasonCode);
  }
  return value;
}

function safeTerm(value, reasonCode) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3
  ) {
    failContract(reasonCode);
  }
  return value;
}

function safeCode(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !SAFE_CODE_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function safeSum(values, reasonCode) {
  let result = 0;
  for (const value of values) {
    result += value;
    if (!Number.isSafeInteger(result)) {
      failCap(reasonCode);
    }
  }
  return result;
}

function calculateCandidateCardAavCents(
  totalValueCents,
  termYears
) {
  const total = safePositiveAmount(
    totalValueCents,
    "total_value_cents_invalid"
  );
  const term = safeTerm(
    termYears,
    "term_years_invalid"
  );
  const quotient = Math.floor(total / term);
  const remainder = total % term;
  return quotient + (
    remainder * 2 >= term
      ? 1
      : 0
  );
}

function assertCandidateCardSaveAllowed(evaluation) {
  if (
    !isPlainObject(evaluation) ||
    !["compliant", "over_cap"].includes(
      evaluation.capStatus
    )
  ) {
    failCap("cap_status_invalid");
  }
  if (evaluation.capStatus === "over_cap") {
    fail(
      CANDIDATE_CARD_POLICY_CODES.capExceeded,
      "active_aav_cap_exceeded"
    );
  }
  return evaluation;
}

function validateCandidateCardOfferAavCents(value) {
  const aavCents = safePositiveAmount(
    value,
    "aav_cents_invalid"
  );
  if (
    aavCents <
    CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS
  ) {
    failContract("minimum_aav_not_met");
  }
  if (
    aavCents %
      CANDIDATE_CARD_AAV_INCREMENT_CENTS !==
    0
  ) {
    failContract("aav_increment_invalid");
  }
  return aavCents;
}

function calculateCandidateCardTotalValueCents(
  aavCents,
  termYears
) {
  const aav = validateCandidateCardOfferAavCents(
    aavCents
  );
  const term = safeTerm(
    termYears,
    "term_years_invalid"
  );
  const total = aav * term;
  if (!Number.isSafeInteger(total)) {
    failContract("total_value_cents_invalid");
  }
  return total;
}

function validateCandidateCardContract(
  input = {}
) {
  requireExactObject(input, [
    "contractType",
    "originalTotalValueCents",
    "originalTermYears",
    "aavCents",
  ]);
  const contractType = enumValue(
    input.contractType,
    CANDIDATE_CARD_CONTRACT_TYPES,
    "contract_type_invalid",
    failContract
  );
  const originalTotalValueCents =
    safePositiveAmount(
      input.originalTotalValueCents,
      "total_value_cents_invalid"
    );
  const originalTermYears = safeTerm(
    input.originalTermYears,
    "term_years_invalid"
  );
  const aavCents = safePositiveAmount(
    input.aavCents,
    "aav_cents_invalid"
  );

  if (contractType === "fantasy_elc") {
    if (
      originalTotalValueCents !== 300 ||
      originalTermYears !== 3 ||
      aavCents !== 100
    ) {
      failContract(
        "fantasy_elc_terms_invalid"
      );
    }
  } else {
    const expectedAavCents =
      calculateCandidateCardAavCents(
        originalTotalValueCents,
        originalTermYears
      );
    const aavFirstContract =
      aavCents >= CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS &&
      aavCents % CANDIDATE_CARD_AAV_INCREMENT_CENTS === 0 &&
      originalTotalValueCents === aavCents * originalTermYears;
    const legacyContract =
      originalTotalValueCents >=
        originalTermYears * CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS &&
      (originalTermYears === 1 || originalTotalValueCents % 100 === 0) &&
      aavCents === expectedAavCents;
    if (!aavFirstContract && !legacyContract) {
      failContract(
        originalTotalValueCents <
          originalTermYears * CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS
          ? "minimum_aav_not_met"
          : aavCents !== expectedAavCents
            ? "aav_cents_mismatch"
            : "contract_precision_invalid"
      );
    }
  }

  return Object.freeze({
    contractType,
    originalTotalValueCents,
    originalTermYears,
    aavCents,
  });
}

function createCandidateCardOfferContract(
  input = {}
) {
  requireExactObject(input, [
    "aavCents",
    "termYears",
  ]);
  const aavCents =
    validateCandidateCardOfferAavCents(
      input.aavCents
    );
  const termYears = safeTerm(
    input.termYears,
    "term_years_invalid"
  );
  const totalValueCents =
    calculateCandidateCardTotalValueCents(
      aavCents,
      termYears
    );
  const contract =
    validateCandidateCardContract({
      contractType: "normal",
      originalTotalValueCents:
        totalValueCents,
      originalTermYears: termYears,
      aavCents,
    });
  return Object.freeze({
    contractType: contract.contractType,
    totalValueCents:
      contract.originalTotalValueCents,
    termYears:
      contract.originalTermYears,
    aavCents: contract.aavCents,
  });
}

function createCandidateCardPartialOfferContract(
  input = {}
) {
  requireExactObject(input, [
    "aavCents",
    "termYears",
  ]);
  const aavCents =
    input.aavCents === null
      ? null
      : validateCandidateCardOfferAavCents(
          input.aavCents
        );
  const termYears =
    input.termYears === null
      ? null
      : safeTerm(
          input.termYears,
          "term_years_invalid"
        );
  if (
    aavCents !== null &&
    termYears !== null
  ) {
    return createCandidateCardOfferContract({
      aavCents,
      termYears,
    });
  }
  return Object.freeze({
    contractType: "normal",
    totalValueCents: null,
    termYears,
    aavCents,
    incomplete: true,
  });
}

function validatePersistedCandidateCardPartialOfferContract(
  input = {}
) {
  requireExactObject(input, [
    "totalValueCents",
    "termYears",
    "aavCents",
  ]);
  const totalValueCents =
    input.totalValueCents === null
      ? null
      : safePositiveAmount(
          input.totalValueCents,
          "total_value_cents_invalid"
        );
  const termYears =
    input.termYears === null
      ? null
      : safeTerm(
          input.termYears,
          "term_years_invalid"
        );
  const aavCents =
    input.aavCents === null
      ? null
      : safePositiveAmount(
          input.aavCents,
          "aav_cents_invalid"
        );
  if (
    totalValueCents !== null &&
    termYears !== null &&
    aavCents !== null
  ) {
    const contract = validateCandidateCardContract({
      contractType: "normal",
      originalTotalValueCents: totalValueCents,
      originalTermYears: termYears,
      aavCents,
    });
    return Object.freeze({
      contractType: contract.contractType,
      totalValueCents:
        contract.originalTotalValueCents,
      termYears: contract.originalTermYears,
      aavCents: contract.aavCents,
    });
  }
  if (
    totalValueCents !== null &&
    aavCents !== null
  ) {
    failContract("incomplete_total_value_present");
  }
  return Object.freeze({
    contractType: "normal",
    totalValueCents,
    termYears,
    aavCents,
    incomplete: true,
  });
}

function buildSlotDescriptor(
  slotGroup,
  slotNumber
) {
  return Object.freeze({
    slotKey:
      `${slotGroup}` +
      String(slotNumber).padStart(2, "0"),
    slotGroup,
    slotNumber,
    mandatory: slotGroup !== "B",
  });
}

const CANDIDATE_CARD_SLOT_STRUCTURE =
  Object.freeze([
    ...Array.from(
      { length: 12 },
      (_, index) =>
        buildSlotDescriptor("F", index + 1)
    ),
    ...Array.from(
      { length: 6 },
      (_, index) =>
        buildSlotDescriptor("D", index + 1)
    ),
    ...Array.from(
      { length: 4 },
      (_, index) =>
        buildSlotDescriptor("B", index + 1)
    ),
  ]);

const CANDIDATE_CARD_SLOT_BY_KEY = new Map(
  CANDIDATE_CARD_SLOT_STRUCTURE.map(
    (slot) => [slot.slotKey, slot]
  )
);

const CANDIDATE_CARD_SLOT_KEYS =
  Object.freeze(
    CANDIDATE_CARD_SLOT_STRUCTURE.map(
      (slot) => slot.slotKey
    )
  );

function createCandidateCardSlotStructure() {
  return CANDIDATE_CARD_SLOT_STRUCTURE;
}

function parseCandidateCardSlotKey(value) {
  if (
    typeof value !== "string" ||
    !CANDIDATE_CARD_SLOT_BY_KEY.has(value)
  ) {
    failSlot("slot_key_invalid");
  }
  return CANDIDATE_CARD_SLOT_BY_KEY.get(value);
}

function effectivePosition(value) {
  return enumValue(
    value,
    CANDIDATE_CARD_EFFECTIVE_POSITIONS,
    "effective_position_invalid",
    (reasonCode) =>
      fail(
        CANDIDATE_CARD_POLICY_CODES
          .playerIneligible,
        reasonCode
      )
  );
}

function assertPositionSlotCompatibility(
  slot,
  position
) {
  if (
    slot.slotGroup !== "B" &&
    slot.slotGroup !== position
  ) {
    failSlot("slot_position_incompatible");
  }
}

function validatePlacement(
  placementState,
  conflictCode
) {
  const state = enumValue(
    placementState,
    ["placed", "conflict"],
    "placement_state_invalid"
  );
  if (state === "placed") {
    if (conflictCode !== null) {
      failInput(
        "placed_entry_conflict_code_present"
      );
    }
    return Object.freeze({
      placementState: state,
      conflictCode: null,
    });
  }
  return Object.freeze({
    placementState: state,
    conflictCode: safeCode(
      conflictCode,
      "conflict_code_invalid"
    ),
  });
}

function validateCandidateCardCarryover(
  input = {}
) {
  requireExactObject(input, [
    "entryId",
    "entryKind",
    "playerId",
    "ownershipId",
    "contractId",
    "effectivePositionGroup",
    "slotKey",
    "placementState",
    "conflictCode",
    "sourceRosterCategory",
    "contractType",
    "originalTotalValueCents",
    "originalTermYears",
    "aavCents",
    "remainingYears",
  ]);
  if (input.entryKind !== "carryover") {
    failInput("entry_kind_invalid");
  }
  const entryId = stableId(
    input.entryId,
    "entry_id_invalid"
  );
  const playerId = stableId(
    input.playerId,
    "player_id_invalid"
  );
  const ownershipId = stableId(
    input.ownershipId,
    "ownership_id_invalid"
  );
  const contractId = stableId(
    input.contractId,
    "contract_id_invalid"
  );
  const effectivePositionGroup =
    effectivePosition(
      input.effectivePositionGroup
    );
  const slot =
    parseCandidateCardSlotKey(
      input.slotKey
    );
  assertPositionSlotCompatibility(
    slot,
    effectivePositionGroup
  );
  const placement = validatePlacement(
    input.placementState,
    input.conflictCode
  );
  const sourceRosterCategory =
    enumValue(
      input.sourceRosterCategory,
      CANDIDATE_CARD_CARRYOVER_ROSTER_CATEGORIES,
      "source_roster_category_invalid"
    );
  const contract =
    validateCandidateCardContract({
      contractType: input.contractType,
      originalTotalValueCents:
        input.originalTotalValueCents,
      originalTermYears:
        input.originalTermYears,
      aavCents: input.aavCents,
    });
  if (
    !Number.isSafeInteger(
      input.remainingYears
    ) ||
    input.remainingYears < 1 ||
    input.remainingYears >
      contract.originalTermYears
  ) {
    failContract("remaining_years_invalid");
  }
  if (
    sourceRosterCategory === "Bench" &&
    slot.slotGroup !== "B"
  ) {
    failSlot(
      "bench_carryover_slot_incompatible"
    );
  }
  if (
    (
      sourceRosterCategory === "Active" ||
      sourceRosterCategory ===
        "Injured Reserve"
    ) &&
    slot.slotGroup !==
      effectivePositionGroup
  ) {
    failSlot(
      sourceRosterCategory ===
        "Injured Reserve"
        ? "injured_reserve_projection_slot_incompatible"
        : "active_carryover_slot_incompatible"
    );
  }
  if (
    slot.slotGroup === "B" &&
    placement.placementState === "placed" &&
    contract.aavCents >
      CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
  ) {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .benchAavExceeded,
      "bench_aav_exceeded"
    );
  }
  return deepFreeze({
    entryId,
    entryKind: "carryover",
    playerId,
    ownershipId,
    contractId,
    effectivePositionGroup,
    slotKey: slot.slotKey,
    slotGroup: slot.slotGroup,
    slotNumber: slot.slotNumber,
    placementState:
      placement.placementState,
    conflictCode: placement.conflictCode,
    sourceRosterCategory,
    contractType: contract.contractType,
    originalTotalValueCents:
      contract.originalTotalValueCents,
    originalTermYears:
      contract.originalTermYears,
    aavCents: contract.aavCents,
    remainingYears: input.remainingYears,
  });
}

function validateCandidateCardCandidate(
  input = {}
) {
  const hasPersistedAav =
    isPlainObject(input) &&
    Object.prototype.hasOwnProperty.call(
      input,
      "aavCents"
    );
  requireExactObject(input, [
    "entryId",
    "entryKind",
    "playerId",
    "effectivePositionGroup",
    "slotKey",
    "placementState",
    "conflictCode",
    "totalValueCents",
    "termYears",
    ...(hasPersistedAav ? ["aavCents"] : []),
    "eligibilityStatus",
    "validationCode",
  ]);
  if (input.entryKind !== "candidate") {
    failInput("entry_kind_invalid");
  }
  const entryId = stableId(
    input.entryId,
    "entry_id_invalid"
  );
  const playerId = stableId(
    input.playerId,
    "player_id_invalid"
  );
  const effectivePositionGroup =
    effectivePosition(
      input.effectivePositionGroup
    );
  const slot =
    parseCandidateCardSlotKey(
      input.slotKey
    );
  assertPositionSlotCompatibility(
    slot,
    effectivePositionGroup
  );
  const placement = validatePlacement(
    input.placementState,
    input.conflictCode
  );
  const persistedAavCents = hasPersistedAav
    ? input.aavCents
    : input.totalValueCents !== null &&
        input.termYears !== null
      ? calculateCandidateCardAavCents(
          input.totalValueCents,
          input.termYears
        )
      : null;
  const contract =
    validatePersistedCandidateCardPartialOfferContract({
      totalValueCents:
        input.totalValueCents,
      termYears: input.termYears,
      aavCents: persistedAavCents,
    });
  if (
    slot.slotGroup === "B" &&
    contract.aavCents !== null &&
    contract.aavCents >
      CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
  ) {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .benchAavExceeded,
      "bench_aav_exceeded"
    );
  }
  const eligibilityStatus = enumValue(
    input.eligibilityStatus,
    CANDIDATE_CARD_ELIGIBILITY_STATUSES,
    "eligibility_status_invalid",
    (reasonCode) =>
      fail(
        CANDIDATE_CARD_POLICY_CODES
          .playerIneligible,
        reasonCode
      )
  );
  let validationCode = null;
  if (contract.incomplete) {
    if (
      eligibilityStatus !== "invalid" ||
      input.validationCode !==
        "CANDIDATE_CONTRACT_INCOMPLETE"
    ) {
      failInput(
        "incomplete_candidate_validation_invalid"
      );
    }
    validationCode =
      "CANDIDATE_CONTRACT_INCOMPLETE";
  } else if (eligibilityStatus === "valid") {
    if (input.validationCode !== null) {
      failInput(
        "valid_candidate_validation_code_present"
      );
    }
  } else {
    validationCode = safeCode(
      input.validationCode,
      "validation_code_invalid"
    );
    if (
      validationCode ===
      "CANDIDATE_CONTRACT_INCOMPLETE"
    ) {
      failInput(
        "complete_candidate_incomplete_code_present"
      );
    }
  }
  return deepFreeze({
    entryId,
    entryKind: "candidate",
    playerId,
    effectivePositionGroup,
    slotKey: slot.slotKey,
    slotGroup: slot.slotGroup,
    slotNumber: slot.slotNumber,
    placementState:
      placement.placementState,
    conflictCode: placement.conflictCode,
    contractType: contract.contractType,
    totalValueCents:
      contract.totalValueCents,
    termYears: contract.termYears,
    aavCents: contract.aavCents,
    eligibilityStatus,
    validationCode,
  });
}

function validateCandidateCardEntry(value) {
  if (!isPlainObject(value)) {
    failInput("entry_invalid");
  }
  if (value.entryKind === "carryover") {
    return validateCandidateCardCarryover(
      value
    );
  }
  if (value.entryKind === "candidate") {
    return validateCandidateCardCandidate(
      value
    );
  }
  failInput("entry_kind_invalid");
}

function planCandidateCardCarryoverAction(
  input = {}
) {
  requireExactObject(input, [
    "action",
    "carryover",
    "targetSlotKey",
  ]);
  const action = enumValue(
    input.action,
    [
      "move",
      "remove",
      "replace_player",
      "edit_contract",
    ],
    "carryover_action_invalid"
  );
  const carryover =
    validateCandidateCardCarryover(
      input.carryover
    );
  if (action !== "move") {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .carryoverLocked,
      `carryover_${action}_not_permitted`
    );
  }
  if (carryover.placementState !== "placed") {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .carryoverLocked,
      "conflicted_carryover_move_not_permitted"
    );
  }
  if (
    carryover.sourceRosterCategory ===
    "Injured Reserve"
  ) {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .carryoverLocked,
      "injured_reserve_requires_roster_move"
    );
  }
  const targetSlot =
    parseCandidateCardSlotKey(
      input.targetSlotKey
    );
  assertPositionSlotCompatibility(
    targetSlot,
    carryover.effectivePositionGroup
  );
  if (
    targetSlot.slotKey ===
    carryover.slotKey
  ) {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .carryoverLocked,
      "carryover_move_no_change"
    );
  }
  if (
    targetSlot.slotGroup === "B" &&
    carryover.aavCents >
      CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS
  ) {
    fail(
      CANDIDATE_CARD_POLICY_CODES
        .benchAavExceeded,
      "bench_aav_exceeded"
    );
  }
  return deepFreeze({
    action: "move",
    entryId: carryover.entryId,
    playerId: carryover.playerId,
    ownershipId: carryover.ownershipId,
    contractId: carryover.contractId,
    contractType: carryover.contractType,
    originalTotalValueCents:
      carryover.originalTotalValueCents,
    originalTermYears:
      carryover.originalTermYears,
    aavCents: carryover.aavCents,
    remainingYears:
      carryover.remainingYears,
    currentSlotKey: carryover.slotKey,
    targetSlotKey: targetSlot.slotKey,
    targetRosterCategory:
      targetSlot.slotGroup === "B"
        ? "Bench"
        : "Active",
  });
}

function candidateParticipates(
  entry
) {
  return (
    entry.entryKind === "candidate" &&
    entry.placementState === "placed" &&
    entry.totalValueCents !== null &&
    entry.termYears !== null &&
    entry.aavCents !== null &&
    (
      entry.eligibilityStatus === "valid" ||
      entry.eligibilityStatus ===
        "warning"
    )
  );
}

function createCandidateOfferDisposition(
  entry,
  allocationEligibility
) {
  if (
    allocationEligibility ===
    "excluded_structural_conflict"
  ) {
    return Object.freeze({
      entryId: entry.entryId,
      playerId: entry.playerId,
      participates: false,
      disposition:
        "excluded_structural_conflict",
      reasonCode:
        "candidate_card_structural_conflict",
    });
  }
  if (
    allocationEligibility ===
    "excluded_over_cap"
  ) {
    return Object.freeze({
      entryId: entry.entryId,
      playerId: entry.playerId,
      participates: false,
      disposition: "excluded_over_cap",
      reasonCode: "candidate_card_over_cap",
    });
  }
  if (entry.placementState === "conflict") {
    return Object.freeze({
      entryId: entry.entryId,
      playerId: entry.playerId,
      participates: false,
      disposition: "excluded_invalid",
      reasonCode: entry.conflictCode,
    });
  }
  if (entry.eligibilityStatus === "invalid") {
    return Object.freeze({
      entryId: entry.entryId,
      playerId: entry.playerId,
      participates: false,
      disposition: "excluded_invalid",
      reasonCode: entry.validationCode,
    });
  }
  return Object.freeze({
    entryId: entry.entryId,
    playerId: entry.playerId,
    participates: true,
    disposition: "participates",
    reasonCode: null,
  });
}

function evaluateCandidateCard(input = {}) {
  requireExactObject(input, [
    "capLimitCents",
    "carriedActivePlayerAmountCents",
    "retentionObligationCents",
    "buyoutPenaltyCents",
    "entries",
  ]);
  if (!Array.isArray(input.entries)) {
    failInput("entries_invalid");
  }
  const entries = input.entries.map(
    validateCandidateCardEntry
  );
  const entryIds = new Set();
  const playerIds = new Set();
  const placedEntriesBySlot = new Map();
  for (const entry of entries) {
    if (entryIds.has(entry.entryId)) {
      failInput("entry_id_duplicate");
    }
    entryIds.add(entry.entryId);
    if (playerIds.has(entry.playerId)) {
      fail(
        CANDIDATE_CARD_POLICY_CODES
          .playerDuplicate,
        "candidate_player_duplicate"
      );
    }
    playerIds.add(entry.playerId);
    if (entry.placementState === "placed") {
      if (
        placedEntriesBySlot.has(
          entry.slotKey
        )
      ) {
        fail(
          CANDIDATE_CARD_POLICY_CODES
            .slotOccupied,
          "slot_occupied"
        );
      }
      placedEntriesBySlot.set(
        entry.slotKey,
        entry
      );
    }
  }

  const slots = CANDIDATE_CARD_SLOT_STRUCTURE.map(
    (slot) =>
      Object.freeze({
        ...slot,
        occupantEntryId:
          placedEntriesBySlot.get(
            slot.slotKey
          )?.entryId ?? null,
      })
  );
  const filledMandatory = slots.filter(
    (slot) =>
      slot.mandatory &&
      slot.occupantEntryId !== null
  ).length;
  const filledBench = slots.filter(
    (slot) =>
      !slot.mandatory &&
      slot.occupantEntryId !== null
  ).length;
  const missingMandatory =
    CANDIDATE_CARD_MANDATORY_SLOT_COUNT -
    filledMandatory;
  const emptyBench =
    CANDIDATE_CARD_BENCH_SLOT_COUNT -
    filledBench;
  const structuralConflictCount =
    entries.filter(
      (entry) =>
        entry.placementState === "conflict"
    ).length;
  const carriedRosterStructuralConflictCount =
    entries.filter(
      (entry) =>
        entry.entryKind === "carryover" &&
        entry.placementState === "conflict"
    ).length;
  const blockingValidationCount =
    entries.filter(
      (entry) =>
        entry.entryKind === "candidate" &&
        entry.eligibilityStatus === "invalid"
    ).length;

  let completenessCode;
  if (structuralConflictCount > 0) {
    completenessCode = "conflicted";
  } else if (
    missingMandatory === 0 &&
    blockingValidationCount === 0
  ) {
    completenessCode = "complete";
  } else {
    completenessCode = "incomplete";
  }

  const capLimitCents =
    safeNonnegativeAmount(
      input.capLimitCents,
      "cap_limit_cents_invalid",
      failCap
    );
  const carriedActivePlayerAmountCents =
    safeNonnegativeAmount(
      input.carriedActivePlayerAmountCents,
      "carried_active_player_amount_cents_invalid",
      failCap
    );
  const retentionObligationCents =
    safeNonnegativeAmount(
      input.retentionObligationCents,
      "retention_obligation_cents_invalid",
      failCap
    );
  const buyoutPenaltyCents =
    safeNonnegativeAmount(
      input.buyoutPenaltyCents,
      "buyout_penalty_cents_invalid",
      failCap
    );
  const carriedCapUsageCents = safeSum(
    [
      carriedActivePlayerAmountCents,
      retentionObligationCents,
      buyoutPenaltyCents,
    ],
    "carried_cap_usage_overflow"
  );
  const proposedCandidateAavCents =
    safeSum(
      entries
        .filter(
          (entry) =>
            entry.entryKind === "candidate" &&
            entry.placementState === "placed" &&
            entry.aavCents !== null &&
            (
              entry.slotGroup === "F" ||
              entry.slotGroup === "D"
            )
        )
        .map((entry) => entry.aavCents),
      "proposed_candidate_aav_overflow"
    );
  const maximumPossibleCapCents =
    safeSum(
      [
        carriedCapUsageCents,
        proposedCandidateAavCents,
      ],
      "maximum_possible_cap_overflow"
    );
  const maximumCapSpaceCents =
    capLimitCents -
    maximumPossibleCapCents;
  if (
    !Number.isSafeInteger(
      maximumCapSpaceCents
    )
  ) {
    failCap("maximum_cap_space_overflow");
  }
  const overCap =
    maximumPossibleCapCents >
    capLimitCents;
  const allocationEligibility =
    carriedRosterStructuralConflictCount > 0
      ? "excluded_structural_conflict"
      : overCap
        ? "excluded_over_cap"
        : "eligible";
  const allocationExclusionReason =
    allocationEligibility ===
    "excluded_structural_conflict"
      ? "candidate_card_structural_conflict"
      : allocationEligibility ===
          "excluded_over_cap"
        ? "candidate_card_over_cap"
        : null;
  const candidateOfferDispositions =
    entries
      .filter(
        (entry) =>
          entry.entryKind === "candidate"
      )
      .map((entry) =>
        createCandidateOfferDisposition(
          entry,
          allocationEligibility
        )
      );

  const lockedStatus =
    completenessCode === "complete"
      ? "locked_complete"
      : completenessCode === "conflicted"
        ? "locked_conflicted"
        : "locked_incomplete";

  return deepFreeze({
    slots,
    entries,
    conflicts: entries.filter(
      (entry) =>
        entry.placementState === "conflict"
    ),
    counts: {
      carryovers: entries.filter(
        (entry) =>
          entry.entryKind === "carryover"
      ).length,
      candidates: candidateOfferDispositions.length,
      emptyMandatory: missingMandatory,
      emptyBench,
      conflicts: structuralConflictCount,
      carriedRosterConflicts:
        carriedRosterStructuralConflictCount,
    },
    completeness: {
      code: completenessCode,
      filledMandatory,
      missingMandatory,
      filledBench,
      emptyBench,
      blockingValidationCount,
      structuralConflictCount,
      carriedRosterStructuralConflictCount,
    },
    lockedStatus,
    capStatus: overCap
      ? "over_cap"
      : "compliant",
    allocationEligibility,
    allocationExclusionReason,
    capProjection: {
      capLimitCents,
      carriedActivePlayerAmountCents,
      retentionObligationCents,
      buyoutPenaltyCents,
      carriedCapUsageCents,
      proposedCandidateAavCents,
      maximumPossibleCapCents,
      maximumCapSpaceCents,
    },
    candidateOfferDispositions,
  });
}

function evaluateCandidateCardHelpAuthority(
  input = {}
) {
  requireExactObject(input, [
    "actorAuthority",
    "activeLeagueMembership",
    "currentTeamManager",
    "currentCommissionerAuthority",
    "activeHelpRequest",
    "nowMs",
    "helpOpensAtMs",
    "candidateDeadlineAtMs",
  ]);
  const actorAuthority = enumValue(
    input.actorAuthority,
    CANDIDATE_CARD_EDITOR_AUTHORITIES,
    "actor_authority_invalid"
  );
  const activeLeagueMembership =
    safeBoolean(
      input.activeLeagueMembership,
      "active_league_membership_invalid"
    );
  const currentTeamManager = safeBoolean(
    input.currentTeamManager,
    "current_team_manager_invalid"
  );
  const currentCommissionerAuthority =
    safeBoolean(
      input.currentCommissionerAuthority,
      "current_commissioner_authority_invalid"
    );
  const activeHelpRequest = safeBoolean(
    input.activeHelpRequest,
    "active_help_request_invalid"
  );
  const nowMs = safeTimestamp(
    input.nowMs,
    "now_ms_invalid"
  );
  const helpOpensAtMs = safeTimestamp(
    input.helpOpensAtMs,
    "help_opens_at_ms_invalid"
  );
  const candidateDeadlineAtMs =
    safeTimestamp(
      input.candidateDeadlineAtMs,
      "candidate_deadline_at_ms_invalid"
    );
  if (
    helpOpensAtMs >=
    candidateDeadlineAtMs
  ) {
    failInput("help_window_invalid");
  }
  const beforeDeadline =
    nowMs < candidateDeadlineAtMs;
  const helpWindowOpen =
    nowMs >= helpOpensAtMs &&
    beforeDeadline;
  const managerReadAccess =
    actorAuthority === "manager" &&
    activeLeagueMembership &&
    currentTeamManager;
  const managerEditAccess =
    managerReadAccess && beforeDeadline;
  const commissionerAuthoritySelected =
    actorAuthority === "commissioner" ||
    actorAuthority ===
      "platform_administrator_as_commissioner";
  const helpAccess =
    activeLeagueMembership &&
    currentCommissionerAuthority &&
    commissionerAuthoritySelected &&
    activeHelpRequest &&
    helpWindowOpen;
  const accessSource = managerReadAccess
    ? "manager_assignment"
    : helpAccess
      ? "help_request"
      : "none";
  const canEdit =
    managerEditAccess || helpAccess;

  return Object.freeze({
    actorAuthority,
    helpWindowOpen,
    accessSource,
    canReadPrivateCard:
      managerReadAccess || helpAccess,
    canEditCandidateEntries: canEdit,
    canMoveEligibleCarryovers: canEdit,
    canRemoveCarryovers: false,
    canEditCarryoverContracts: false,
    canRequestHelp:
      managerEditAccess && helpWindowOpen,
  });
}

module.exports = {
  CANONICAL_UUID_PATTERN,
  CANDIDATE_CARD_AAV_INCREMENT_CENTS,
  CANDIDATE_CARD_BENCH_MAXIMUM_AAV_CENTS,
  CANDIDATE_CARD_BENCH_SLOT_COUNT,
  CANDIDATE_CARD_CARRYOVER_ROSTER_CATEGORIES,
  CANDIDATE_CARD_CONTRACT_TYPES,
  CANDIDATE_CARD_EDITOR_AUTHORITIES,
  CANDIDATE_CARD_EFFECTIVE_POSITIONS,
  CANDIDATE_CARD_ELIGIBILITY_STATUSES,
  CANDIDATE_CARD_MANDATORY_SLOT_COUNT,
  CANDIDATE_CARD_NORMAL_MINIMUM_AAV_CENTS,
  CANDIDATE_CARD_POLICY_CODES,
  CANDIDATE_CARD_SLOT_COUNT,
  CANDIDATE_CARD_SLOT_KEYS,
  CandidateCardPolicyError,
  assertCandidateCardSaveAllowed,
  calculateCandidateCardAavCents,
  calculateCandidateCardTotalValueCents,
  createCandidateCardOfferContract,
  createCandidateCardPartialOfferContract,
  createCandidateCardSlotStructure,
  evaluateCandidateCard,
  evaluateCandidateCardHelpAuthority,
  parseCandidateCardSlotKey,
  planCandidateCardCarryoverAction,
  validateCandidateCardCandidate,
  validateCandidateCardContract,
  validateCandidateCardCarryover,
};
