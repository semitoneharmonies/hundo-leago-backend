const crypto = require("node:crypto");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  CANONICAL_UUID_PATTERN,
} = require(
  "../../../domain/freeAgentDraft/candidateCardPolicy"
);
const {
  FreeAgentDraftOpeningReadinessPolicyError,
  projectFreeAgentDraftCarryovers,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  createSqliteFreeAgentDraftReadRepository,
} = require("./SqliteFreeAgentDraftReadRepository");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const COMMAND_KEYS = Object.freeze([
  "leagueId",
  "seasonId",
  "fadId",
  "openedAtMs",
  "candidateDeadlineAtMs",
  "carryoverProjection",
  "participants",
]);
const PARTICIPANT_KEYS = Object.freeze([
  "teamId",
  "participantId",
  "cardId",
  "notificationId",
  "managerAssignmentId",
  "managerUserId",
  "managerMembershipId",
]);
const POSITION_SLOT_COUNTS = Object.freeze({
  F: 12,
  D: 6,
  B: 4,
});

function invalid(message, reasonCode) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message,
    {
      details: { reasonCode },
    }
  );
}

function conflict(message, reasonCode, details = {}) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.versionConflict,
    message,
    {
      details: {
        reasonCode,
        ...details,
      },
    }
  );
}

function incompatible(message, reasonCode, cause) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message,
    {
      cause,
      details: { reasonCode },
    }
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

function exactObject(value, keys, description) {
  if (!isPlainObject(value)) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_INVALID"
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    invalid(
      `An exact ${description} is required.`,
      "INPUT_FIELDS_INVALID"
    );
  }
  return value;
}

function canonicalId(value, description) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_PATTERN.test(value)
  ) {
    invalid(
      `A canonical ${description} is required.`,
      "IDENTIFIER_INVALID"
    );
  }
  return value;
}

function safeTimestamp(value, description) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid(
      `A safe ${description} is required.`,
      "TIMESTAMP_INVALID"
    );
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

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map((child) => canonicalJson(child))
      .join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:` +
          canonicalJson(value[key])
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(namespace) {
  const hex = crypto
    .createHash("sha256")
    .update(namespace, "utf8")
    .digest("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-` +
    hex.slice(20, 32)
  );
}

function slotKey(slotGroup, slotNumber) {
  return (
    slotGroup +
    String(slotNumber).padStart(2, "0")
  );
}

function normalizeCommand(command) {
  exactObject(
    command,
    COMMAND_KEYS,
    "Candidate Card opening command"
  );
  const leagueId = canonicalId(
    command.leagueId,
    "opening league identifier"
  );
  const seasonId = canonicalId(
    command.seasonId,
    "opening season identifier"
  );
  const fadId = canonicalId(
    command.fadId,
    "Free Agent Draft identifier"
  );
  const openedAtMs = safeTimestamp(
    command.openedAtMs,
    "Candidate Card opening timestamp"
  );
  const candidateDeadlineAtMs = safeTimestamp(
    command.candidateDeadlineAtMs,
    "Candidate Card deadline"
  );
  if (openedAtMs >= candidateDeadlineAtMs) {
    invalid(
      "Candidate Cards must open before their deadline.",
      "FAD_CLOCK_INVALID"
    );
  }
  if (!isPlainObject(command.carryoverProjection)) {
    invalid(
      "The expected Candidate carryover projection is required.",
      "CARRYOVER_PROJECTION_INVALID"
    );
  }
  if (
    !Array.isArray(command.participants) ||
    command.participants.length < 1
  ) {
    invalid(
      "Candidate Card opening requires every participant.",
      "PARTICIPANTS_INVALID"
    );
  }
  const participants = command.participants.map(
    (participant) => {
      exactObject(
        participant,
        PARTICIPANT_KEYS,
        "Candidate Card opening participant"
      );
      return Object.freeze({
        teamId: canonicalId(
          participant.teamId,
          "participant team identifier"
        ),
        participantId: canonicalId(
          participant.participantId,
          "FAD participant identifier"
        ),
        cardId: canonicalId(
          participant.cardId,
          "Candidate Card identifier"
        ),
        notificationId: canonicalId(
          participant.notificationId,
          "cards-opened notification identifier"
        ),
        managerAssignmentId: canonicalId(
          participant.managerAssignmentId,
          "current manager assignment identifier"
        ),
        managerUserId: canonicalId(
          participant.managerUserId,
          "current manager user identifier"
        ),
        managerMembershipId: canonicalId(
          participant.managerMembershipId,
          "current manager membership identifier"
        ),
      });
    }
  );
  for (const [description, values] of [
    ["team", participants.map(({ teamId }) => teamId)],
    [
      "participant",
      participants.map(({ participantId }) => participantId),
    ],
    ["card", participants.map(({ cardId }) => cardId)],
    [
      "notification",
      participants.map(({ notificationId }) => notificationId),
    ],
  ]) {
    if (new Set(values).size !== values.length) {
      invalid(
        `Candidate Card opening ${description} identifiers must be unique.`,
        "PARTICIPANTS_INVALID"
      );
    }
  }
  if (
    participants.some(
      (participant, index) =>
        index > 0 &&
        participants[index - 1].teamId >=
          participant.teamId
    )
  ) {
    invalid(
      "Candidate Card opening participants must use canonical team order.",
      "PARTICIPANT_ORDER_INVALID"
    );
  }
  return deepFreeze({
    leagueId,
    seasonId,
    fadId,
    openedAtMs,
    candidateDeadlineAtMs,
    carryoverProjection:
      command.carryoverProjection,
    participants,
  });
}

function assertSynchronous(value, description) {
  if (
    value &&
    typeof value.then === "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.transactionAsync,
      `${description} must be synchronous.`
    );
  }
}

function createSqliteCandidateCardOpeningWriter({
  database,
  capReadRepository,
  openingContextReader,
  beforeCommit,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardOpeningWriter requires an opened database"
    );
  }
  if (
    beforeCommit !== undefined &&
    typeof beforeCommit !== "function"
  ) {
    throw new TypeError(
      "Candidate Card opening beforeCommit must be a function"
    );
  }
  const capReader =
    capReadRepository === undefined
      ? createSqliteCapReadRepository({
          database,
        })
      : capReadRepository;
  if (
    !capReader ||
    typeof capReader.calculate !== "function"
  ) {
    throw new TypeError(
      "Candidate Card opening requires a cap-read repository"
    );
  }
  const contextReader =
    openingContextReader === undefined
      ? createSqliteFreeAgentDraftReadRepository({
          database,
        })
      : openingContextReader;
  if (
    !contextReader ||
    typeof contextReader.readOpeningPreflightContext !==
      "function"
  ) {
    throw new TypeError(
      "Candidate Card opening requires an opening-context reader"
    );
  }

  let fadStatement;
  let participantsStatement;
  let cardsStatement;
  let entriesStatement;
  let revisionsStatement;
  let insertCardStatement;
  let insertEntryStatement;
  let insertRevisionStatement;

  try {
    fadStatement = database.prepare(`
      SELECT
        id,
        league_id,
        season_id,
        participating_team_count,
        status,
        opening_authority,
        opened_at_ms,
        candidate_deadline_at_ms
      FROM free_agent_drafts
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND id = @fadId
      LIMIT 2
    `);
    participantsStatement = database.prepare(`
      SELECT
        participant.id AS participant_id,
        participant.team_id,
        participant.team_status_at_setup,
        participant.created_at_ms,
        team.status AS current_team_status,
        assignment.id AS assignment_id,
        assignment.user_id AS manager_user_id,
        assignment.membership_id AS manager_membership_id,
        membership.status AS membership_status,
        manager.status AS manager_user_status
      FROM free_agent_draft_teams AS participant
      JOIN teams AS team
        ON team.league_id = participant.league_id
       AND team.id = participant.team_id
      LEFT JOIN team_manager_assignments AS assignment
        ON assignment.league_id = participant.league_id
       AND assignment.team_id = participant.team_id
       AND assignment.status = 'accepted'
       AND assignment.ended_at_ms IS NULL
      LEFT JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
      LEFT JOIN users AS manager
        ON manager.id = assignment.user_id
      WHERE participant.league_id = @leagueId
        AND participant.season_id = @seasonId
        AND participant.fad_id = @fadId
      ORDER BY participant.team_id, assignment.id
    `);
    cardsStatement = database.prepare(`
      SELECT
        id,
        league_id,
        season_id,
        fad_id,
        team_id,
        status,
        completeness_code,
        filled_mandatory_count,
        missing_mandatory_count,
        filled_bench_count,
        empty_bench_count,
        blocking_validation_count,
        structural_conflict_count,
        carried_roster_structural_conflict_count,
        maximum_possible_cap_cents,
        locked_at_ms,
        created_at_ms,
        updated_at_ms,
        version,
        cap_status,
        allocation_eligibility,
        allocation_exclusion_reason
      FROM candidate_cards
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY team_id
    `);
    entriesStatement = database.prepare(`
      SELECT
        id,
        league_id,
        season_id,
        fad_id,
        card_id,
        team_id,
        entry_kind,
        player_id,
        effective_position_group,
        requested_slot_group,
        requested_slot_number,
        placement_state,
        conflict_code,
        carryover_ownership_id,
        carryover_contract_id,
        source_roster_category,
        carryover_original_total_value_cents,
        carryover_original_term_years,
        carryover_aav_cents,
        remaining_years,
        proposed_total_value_cents,
        proposed_term_years,
        proposed_aav_cents,
        eligibility_status,
        validation_code,
        last_acknowledgement_revision_id,
        created_by_user_id,
        created_by_membership_id,
        created_by_authority,
        last_edited_by_user_id,
        last_edited_by_membership_id,
        last_edited_by_authority,
        created_at_ms,
        updated_at_ms,
        version
      FROM candidate_card_entries
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY card_id, id
    `);
    revisionsStatement = database.prepare(`
      SELECT
        id,
        league_id,
        season_id,
        fad_id,
        card_id,
        team_id,
        resulting_card_version,
        action,
        affected_entry_id,
        player_id,
        actor_user_id,
        actor_membership_id,
        actor_authority,
        before_evidence_json,
        after_evidence_json,
        potential_illegality_acknowledged,
        warning_codes_json,
        occurred_at_ms,
        created_at_ms,
        version
      FROM candidate_card_revisions
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
      ORDER BY card_id, resulting_card_version, id
    `);
    insertCardStatement = database.prepare(`
      INSERT INTO candidate_cards (
        id,
        league_id,
        season_id,
        fad_id,
        team_id,
        status,
        completeness_code,
        filled_mandatory_count,
        missing_mandatory_count,
        filled_bench_count,
        empty_bench_count,
        blocking_validation_count,
        structural_conflict_count,
        carried_roster_structural_conflict_count,
        maximum_possible_cap_cents,
        locked_at_ms,
        created_at_ms,
        updated_at_ms,
        version,
        cap_status,
        allocation_eligibility,
        allocation_exclusion_reason
      ) VALUES (
        @id,
        @league_id,
        @season_id,
        @fad_id,
        @team_id,
        @status,
        @completeness_code,
        @filled_mandatory_count,
        @missing_mandatory_count,
        @filled_bench_count,
        @empty_bench_count,
        @blocking_validation_count,
        @structural_conflict_count,
        @carried_roster_structural_conflict_count,
        @maximum_possible_cap_cents,
        @locked_at_ms,
        @created_at_ms,
        @updated_at_ms,
        @version,
        @cap_status,
        @allocation_eligibility,
        @allocation_exclusion_reason
      )
    `);
    insertEntryStatement = database.prepare(`
      INSERT INTO candidate_card_entries (
        id,
        league_id,
        season_id,
        fad_id,
        card_id,
        team_id,
        entry_kind,
        player_id,
        effective_position_group,
        requested_slot_group,
        requested_slot_number,
        placement_state,
        conflict_code,
        carryover_ownership_id,
        carryover_contract_id,
        source_roster_category,
        carryover_original_total_value_cents,
        carryover_original_term_years,
        carryover_aav_cents,
        remaining_years,
        proposed_total_value_cents,
        proposed_term_years,
        proposed_aav_cents,
        eligibility_status,
        validation_code,
        last_acknowledgement_revision_id,
        created_by_user_id,
        created_by_membership_id,
        created_by_authority,
        last_edited_by_user_id,
        last_edited_by_membership_id,
        last_edited_by_authority,
        created_at_ms,
        updated_at_ms,
        version
      ) VALUES (
        @id,
        @league_id,
        @season_id,
        @fad_id,
        @card_id,
        @team_id,
        @entry_kind,
        @player_id,
        @effective_position_group,
        @requested_slot_group,
        @requested_slot_number,
        @placement_state,
        @conflict_code,
        @carryover_ownership_id,
        @carryover_contract_id,
        @source_roster_category,
        @carryover_original_total_value_cents,
        @carryover_original_term_years,
        @carryover_aav_cents,
        @remaining_years,
        @proposed_total_value_cents,
        @proposed_term_years,
        @proposed_aav_cents,
        @eligibility_status,
        @validation_code,
        @last_acknowledgement_revision_id,
        @created_by_user_id,
        @created_by_membership_id,
        @created_by_authority,
        @last_edited_by_user_id,
        @last_edited_by_membership_id,
        @last_edited_by_authority,
        @created_at_ms,
        @updated_at_ms,
        @version
      )
    `);
    insertRevisionStatement = database.prepare(`
      INSERT INTO candidate_card_revisions (
        id,
        league_id,
        season_id,
        fad_id,
        card_id,
        team_id,
        resulting_card_version,
        action,
        affected_entry_id,
        player_id,
        actor_user_id,
        actor_membership_id,
        actor_authority,
        before_evidence_json,
        after_evidence_json,
        potential_illegality_acknowledged,
        warning_codes_json,
        occurred_at_ms,
        created_at_ms,
        version
      ) VALUES (
        @id,
        @league_id,
        @season_id,
        @fad_id,
        @card_id,
        @team_id,
        @resulting_card_version,
        @action,
        @affected_entry_id,
        @player_id,
        @actor_user_id,
        @actor_membership_id,
        @actor_authority,
        @before_evidence_json,
        @after_evidence_json,
        @potential_illegality_acknowledged,
        @warning_codes_json,
        @occurred_at_ms,
        @created_at_ms,
        @version
      )
    `);
  } catch (error) {
    incompatible(
      "Candidate Card opening requires the complete FAD card schema.",
      "CANDIDATE_CARD_OPENING_SCHEMA_REQUIRED",
      error
    );
  }

  function requireFadScope(command) {
    const rows = fadStatement.all(command);
    if (rows.length !== 1) {
      conflict(
        "The Candidate Card opening FAD scope is unavailable or ambiguous.",
        "FAD_SCOPE_INVALID"
      );
    }
    const fad = rows[0];
    if (
      fad.status !== "cards_open" ||
      fad.opening_authority !== "system" ||
      fad.opened_at_ms !== command.openedAtMs ||
      fad.candidate_deadline_at_ms !==
        command.candidateDeadlineAtMs ||
      fad.participating_team_count !==
        command.participants.length
    ) {
      conflict(
        "Candidate Card opening no longer matches the current FAD clock and participant commitment.",
        "FAD_OPENING_STATE_CHANGED"
      );
    }
    return fad;
  }

  function requireParticipants(command) {
    const rows = participantsStatement.all(command);
    if (rows.length !== command.participants.length) {
      conflict(
        "Candidate Card opening requires the exact frozen all-team participant set.",
        "FAD_PARTICIPANTS_CHANGED"
      );
    }
    for (
      let index = 0;
      index < command.participants.length;
      index += 1
    ) {
      const expected = command.participants[index];
      const row = rows[index];
      if (
        row.team_id !== expected.teamId ||
        row.participant_id !== expected.participantId ||
        row.team_status_at_setup !== "active" ||
        row.current_team_status !== "active" ||
        row.created_at_ms !== command.openedAtMs ||
        row.assignment_id !==
          expected.managerAssignmentId ||
        row.manager_user_id !== expected.managerUserId ||
        row.manager_membership_id !==
          expected.managerMembershipId ||
        row.membership_status !== "active" ||
        row.manager_user_status !== "active"
      ) {
        conflict(
          "Candidate Card opening participant or current manager state changed.",
          "FAD_PARTICIPANT_AUTHORITY_CHANGED",
          { teamId: expected.teamId }
        );
      }
    }
  }

  function entryRecord(
    command,
    participant,
    entry
  ) {
    return Object.freeze({
      id: deterministicUuid(
        `candidate-card-entry:${command.fadId}:` +
          `${participant.cardId}:${entry.ownershipId}`
      ),
      league_id: command.leagueId,
      season_id: command.seasonId,
      fad_id: command.fadId,
      card_id: participant.cardId,
      team_id: participant.teamId,
      entry_kind: "carryover",
      player_id: entry.playerId,
      effective_position_group:
        entry.effectivePositionGroup,
      requested_slot_group:
        entry.requestedSlotGroup,
      requested_slot_number:
        entry.requestedSlotNumber,
      placement_state: entry.placementState,
      conflict_code: entry.conflictCode,
      carryover_ownership_id:
        entry.ownershipId,
      carryover_contract_id: entry.contractId,
      source_roster_category:
        entry.sourceRosterCategory,
      carryover_original_total_value_cents:
        entry.originalTotalValueCents,
      carryover_original_term_years:
        entry.originalTermYears,
      carryover_aav_cents: entry.aavCents,
      remaining_years: entry.remainingYears,
      proposed_total_value_cents: null,
      proposed_term_years: null,
      proposed_aav_cents: null,
      eligibility_status: null,
      validation_code: null,
      last_acknowledgement_revision_id: null,
      created_by_user_id: null,
      created_by_membership_id: null,
      created_by_authority: "system",
      last_edited_by_user_id: null,
      last_edited_by_membership_id: null,
      last_edited_by_authority: "system",
      created_at_ms: command.openedAtMs,
      updated_at_ms: command.openedAtMs,
      version: 1,
    });
  }

  function cardRecord(
    command,
    participant,
    entries,
    cap
  ) {
    const filledMandatoryCount = entries.filter(
      (entry) =>
        entry.placement_state === "placed" &&
        entry.requested_slot_group !== "B"
    ).length;
    const filledBenchCount = entries.filter(
      (entry) =>
        entry.placement_state === "placed" &&
        entry.requested_slot_group === "B"
    ).length;
    const structuralConflictCount = entries.filter(
      (entry) =>
        entry.placement_state === "conflict"
    ).length;
    const completenessCode =
      structuralConflictCount > 0
        ? "conflicted"
        : filledMandatoryCount === 18
          ? "complete"
          : "incomplete";
    return Object.freeze({
      id: participant.cardId,
      league_id: command.leagueId,
      season_id: command.seasonId,
      fad_id: command.fadId,
      team_id: participant.teamId,
      status: "open",
      completeness_code: completenessCode,
      filled_mandatory_count:
        filledMandatoryCount,
      missing_mandatory_count:
        18 - filledMandatoryCount,
      filled_bench_count: filledBenchCount,
      empty_bench_count: 4 - filledBenchCount,
      blocking_validation_count: 0,
      structural_conflict_count:
        structuralConflictCount,
      carried_roster_structural_conflict_count:
        structuralConflictCount,
      maximum_possible_cap_cents:
        cap.capUsageCents,
      locked_at_ms: null,
      created_at_ms: command.openedAtMs,
      updated_at_ms: command.openedAtMs,
      version: 1,
      cap_status: cap.overCap
        ? "over_cap"
        : "compliant",
      allocation_eligibility:
        structuralConflictCount > 0
          ? "excluded_structural_conflict"
          : cap.overCap
            ? "excluded_over_cap"
            : "eligible",
      allocation_exclusion_reason:
        structuralConflictCount > 0
          ? "candidate_card_structural_conflict"
          : cap.overCap
            ? "candidate_card_over_cap"
            : null,
    });
  }

  function slotProjection(entries) {
    const placedBySlot = new Map(
      entries
        .filter(
          (entry) =>
            entry.placement_state === "placed"
        )
        .map((entry) => [
          slotKey(
            entry.requested_slot_group,
            entry.requested_slot_number
          ),
          entry.id,
        ])
    );
    const slots = [];
    for (const slotGroup of ["F", "D", "B"]) {
      for (
        let slotNumber = 1;
        slotNumber <=
        POSITION_SLOT_COUNTS[slotGroup];
        slotNumber += 1
      ) {
        const key = slotKey(
          slotGroup,
          slotNumber
        );
        slots.push(
          Object.freeze({
            slotKey: key,
            mandatory: slotGroup !== "B",
            occupantEntryId:
              placedBySlot.get(key) ?? null,
          })
        );
      }
    }
    return Object.freeze(slots);
  }

  function revisionRecord(
    command,
    participant,
    card,
    entries,
    cap
  ) {
    const afterEvidenceJson = canonicalJson({
      card: {
        cardId: card.id,
        teamId: card.team_id,
        version: card.version,
        completenessCode:
          card.completeness_code,
        filledMandatoryCount:
          card.filled_mandatory_count,
        missingMandatoryCount:
          card.missing_mandatory_count,
        filledBenchCount:
          card.filled_bench_count,
        emptyBenchCount:
          card.empty_bench_count,
        structuralConflictCount:
          card.structural_conflict_count,
        carriedRosterStructuralConflictCount:
          card
            .carried_roster_structural_conflict_count,
        maximumPossibleCapCents:
          card.maximum_possible_cap_cents,
        capStatus: card.cap_status,
        allocationEligibility:
          card.allocation_eligibility,
        allocationExclusionReason:
          card.allocation_exclusion_reason,
      },
      opening: {
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        fadId: command.fadId,
        openedAtMs: command.openedAtMs,
        candidateDeadlineAtMs:
          command.candidateDeadlineAtMs,
        participantId:
          participant.participantId,
        notificationId:
          participant.notificationId,
        managerUserId:
          participant.managerUserId,
        managerMembershipId:
          participant.managerMembershipId,
        managerAssignmentId:
          participant.managerAssignmentId,
      },
      cap: {
        capLimitCents: cap.capLimitCents,
        carriedActivePlayerAmountCents:
          cap.breakdown.activePlayerCents,
        retentionObligationCents:
          cap.breakdown.retentionCents,
        buyoutPenaltyCents:
          cap.breakdown.buyoutCents,
      },
      slots: slotProjection(entries),
      conflicts: entries
        .filter(
          (entry) =>
            entry.placement_state === "conflict"
        )
        .map((entry) => ({
          entryId: entry.id,
          playerId: entry.player_id,
          ownershipId:
            entry.carryover_ownership_id,
          contractId:
            entry.carryover_contract_id,
          requestedSlotKey: slotKey(
            entry.requested_slot_group,
            entry.requested_slot_number
          ),
          conflictCode: entry.conflict_code,
        })),
    });
    if (
      Buffer.byteLength(
        afterEvidenceJson,
        "utf8"
      ) > 65536
    ) {
      conflict(
        "Candidate Card opening evidence exceeds its durable bound.",
        "CANDIDATE_CARD_OPENING_EVIDENCE_TOO_LARGE",
        { teamId: participant.teamId }
      );
    }
    return Object.freeze({
      id: deterministicUuid(
        `candidate-card-opened:${command.fadId}:` +
          participant.cardId
      ),
      league_id: command.leagueId,
      season_id: command.seasonId,
      fad_id: command.fadId,
      card_id: participant.cardId,
      team_id: participant.teamId,
      resulting_card_version: 1,
      action: "card_opened",
      affected_entry_id: null,
      player_id: null,
      actor_user_id: null,
      actor_membership_id: null,
      actor_authority: "system",
      before_evidence_json: '{"card":null}',
      after_evidence_json: afterEvidenceJson,
      potential_illegality_acknowledged: 0,
      warning_codes_json: "[]",
      occurred_at_ms: command.openedAtMs,
      created_at_ms: command.openedAtMs,
      version: 1,
    });
  }

  function openingPlan(command) {
    requireFadScope(command);
    requireParticipants(command);
    const context =
      contextReader.readOpeningPreflightContext({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
      });
    assertSynchronous(
      context,
      "Candidate Card opening-context read"
    );
    let carryoverProjection;
    try {
      carryoverProjection =
        projectFreeAgentDraftCarryovers({
          seasonId: command.seasonId,
          participatingTeams:
            context.participatingTeams,
          leagueSettings: context.leagueSettings,
          ownerships: context.ownerships,
          activeContracts: context.activeContracts,
          targetContractYears:
            context.targetContractYears,
          allContractYears:
            context.allContractYears,
          leaguePositionOverrides:
            context.leaguePositionOverrides,
          currentPlayerSources:
            context.currentPlayerSources,
        });
    } catch (error) {
      if (
        !(
          error instanceof
          FreeAgentDraftOpeningReadinessPolicyError
        )
      ) {
        throw error;
      }
      conflict(
        "The authoritative Candidate carryover state cannot be projected.",
        "CARRYOVER_PROJECTION_INVALID",
        {
          policyCode: error.code ?? null,
          policyReasonCode:
            error.reasonCode ?? null,
        }
      );
    }
    if (
      carryoverProjection.stateBlockers.length > 0
    ) {
      conflict(
        "The authoritative Candidate carryover state is blocked.",
        "CARRYOVER_PROJECTION_BLOCKED",
        {
          blockerCodes: [
            ...new Set(
              carryoverProjection.stateBlockers.map(
                ({ code }) => code
              )
            ),
          ].sort(),
        }
      );
    }
    if (
      !isDeepStrictEqual(
        command.carryoverProjection,
        carryoverProjection
      )
    ) {
      conflict(
        "The Candidate carryover projection changed before atomic opening.",
        "CARRYOVER_PROJECTION_CHANGED"
      );
    }
    if (
      carryoverProjection.teams.length !==
        command.participants.length ||
      carryoverProjection.teams.some(
        (team, index) =>
          team.teamId !==
          command.participants[index].teamId
      )
    ) {
      conflict(
        "The Candidate carryover projection no longer covers the frozen participant set.",
        "CARRYOVER_PARTICIPANTS_CHANGED"
      );
    }
    const cards = [];
    const entries = [];
    const revisions = [];
    for (
      let index = 0;
      index < command.participants.length;
      index += 1
    ) {
      const participant = command.participants[index];
      const teamProjection =
        carryoverProjection.teams[index];
      const teamEntries = Object.freeze(
        teamProjection.entries
          .map((entry) =>
            entryRecord(
              command,
              participant,
              entry
            )
          )
          .sort((left, right) =>
            left.id.localeCompare(right.id)
          )
      );
      const cap = capReader.calculate({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        teamId: participant.teamId,
      });
      if (!cap.complete) {
        conflict(
          "Candidate Card opening cap evidence is incomplete.",
          "CANDIDATE_CAP_STATE_INCOMPLETE",
          {
            teamId: participant.teamId,
            issueCodes: cap.issues.map(
              ({ code }) => code
            ),
          }
        );
      }
      const card = cardRecord(
        command,
        participant,
        teamEntries,
        cap
      );
      const revision = revisionRecord(
        command,
        participant,
        card,
        teamEntries,
        cap
      );
      cards.push(card);
      entries.push(...teamEntries);
      revisions.push(revision);
    }
    cards.sort((left, right) =>
      left.team_id.localeCompare(right.team_id)
    );
    entries.sort((left, right) =>
      left.card_id.localeCompare(right.card_id) ||
      left.id.localeCompare(right.id)
    );
    revisions.sort((left, right) =>
      left.card_id.localeCompare(right.card_id) ||
      left.id.localeCompare(right.id)
    );
    return deepFreeze({
      carryoverProjection,
      cards,
      entries,
      revisions,
    });
  }

  function storedState(command) {
    return {
      cards: cardsStatement.all(command),
      entries: entriesStatement.all(command),
      revisions: revisionsStatement.all(command),
    };
  }

  function assertExactState(command, plan) {
    const stored = storedState(command);
    if (
      !isDeepStrictEqual(stored.cards, plan.cards) ||
      !isDeepStrictEqual(stored.entries, plan.entries) ||
      !isDeepStrictEqual(
        stored.revisions,
        plan.revisions
      )
    ) {
      conflict(
        "Candidate Card opening replay does not exactly match every card, carryover, and opening revision.",
        "CANDIDATE_CARD_OPENING_REPLAY_MISMATCH"
      );
    }
  }

  function resultProjection(plan, replayed) {
    return deepFreeze({
      replayed,
      carryoverProjection:
        plan.carryoverProjection,
      cards: plan.cards.map((card) => ({
        id: card.id,
        teamId: card.team_id,
        version: card.version,
        completenessCode:
          card.completeness_code,
        carryoverCount: plan.entries.filter(
          (entry) => entry.card_id === card.id
        ).length,
        structuralConflictCount:
          card.structural_conflict_count,
        maximumPossibleCapCents:
          card.maximum_possible_cap_cents,
        openingRevisionId:
          plan.revisions.find(
            (revision) =>
              revision.card_id === card.id
          ).id,
      })),
    });
  }

  const openingTransaction =
    database.transaction((rawCommand) => {
      const command = normalizeCommand(
        rawCommand
      );
      const plan = openingPlan(command);
      const existing = storedState(command);
      if (
        existing.cards.length > 0 ||
        existing.entries.length > 0 ||
        existing.revisions.length > 0
      ) {
        assertExactState(command, plan);
        return resultProjection(plan, true);
      }

      for (const card of plan.cards) {
        if (insertCardStatement.run(card).changes !== 1) {
          conflict(
            "A Candidate Card could not be opened.",
            "CANDIDATE_CARD_OPENING_CHANGED"
          );
        }
      }
      for (const entry of plan.entries) {
        if (insertEntryStatement.run(entry).changes !== 1) {
          conflict(
            "A Candidate carryover could not be materialized.",
            "CANDIDATE_CARD_OPENING_CHANGED"
          );
        }
      }
      for (const revision of plan.revisions) {
        if (
          insertRevisionStatement.run(revision).changes !== 1
        ) {
          conflict(
            "A Candidate Card opening revision could not be recorded.",
            "CANDIDATE_CARD_OPENING_CHANGED"
          );
        }
      }
      assertExactState(command, plan);
      const result = resultProjection(
        plan,
        false
      );
      if (beforeCommit) {
        assertSynchronous(
          beforeCommit(
            deepFreeze({
              kind: "candidate_card_opening",
              command,
              result,
            })
          ),
          "Candidate Card opening beforeCommit"
        );
      }
      return result;
    });

  return Object.freeze({
    openAll(command) {
      try {
        return openingTransaction.immediate(
          command
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation:
            "openAllCandidateCards",
          tableName: "candidate_cards",
        });
      }
    },
  });
}

module.exports = {
  createSqliteCandidateCardOpeningWriter,
};
