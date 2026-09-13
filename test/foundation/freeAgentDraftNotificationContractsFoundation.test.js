"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES,
  FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID,
  FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS,
  FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS,
  FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY,
  FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES,
  FREE_AGENT_DRAFT_NOTIFICATION_TYPES,
  FreeAgentDraftNotificationContractError,
  createFreeAgentDraftNotificationContract,
  createFreeAgentDraftNotificationDeduplicationKey,
  getFreeAgentDraftNotificationListCopy,
  validateFreeAgentDraftNotificationContract,
  validateFreeAgentDraftNotificationDeduplicationKey,
  validateFreeAgentDraftNotificationMessageData,
  validateFreeAgentDraftNotificationType,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftNotificationContracts"
);

const IDS = Object.freeze({
  league: "00000000-0000-4000-8000-000000000001",
  season: "00000000-0000-4000-8000-000000000002",
  fad: "00000000-0000-4000-8000-000000000003",
  teamOne: "00000000-0000-4000-8000-000000000004",
  teamTwo: "00000000-0000-4000-8000-000000000005",
  cardOne: "00000000-0000-4000-8000-000000000006",
  cardTwo: "00000000-0000-4000-8000-000000000007",
  recipient: "00000000-0000-4000-8000-000000000008",
  requester: "00000000-0000-4000-8000-000000000009",
  readiness: "00000000-0000-4000-8000-00000000000a",
  helpRequest: "00000000-0000-4000-8000-00000000000b",
  allocation: "00000000-0000-4000-8000-00000000000c",
  auction: "00000000-0000-4000-8000-00000000000d",
  player: "00000000-0000-4000-8000-00000000000e",
  recovery: "00000000-0000-4000-8000-00000000000f",
  scheduleRecovery:
    "00000000-0000-4000-8000-000000000010",
  exemption: "00000000-0000-4000-8000-000000000011",
});

const EXPECTED_COPY = Object.freeze({
  fad_cards_opened: "Your Candidate Card is ready.",
  fad_readiness_blocked:
    "Free Agent Draft readiness requires commissioner attention.",
  fad_deadline_approaching:
    "Your Candidate Card deadline is approaching.",
  fad_help_requested:
    "A manager has requested Candidate Card help.",
  fad_cards_locked:
    "Candidate Cards are locked and results are available.",
  fad_automatic_result:
    "Your Candidate Card results are available.",
  fad_restricted_eligible:
    "You are eligible to bid in a restricted FAD auction.",
  fad_restricted_fallback_opened:
    "A league-wide Free Agent Draft fallback auction is open.",
  fad_rapid_auction_result:
    "A Free Agent Draft auction has finished.",
  fad_correction_required:
    "Free Agent Draft recovery requires commissioner attention.",
  fad_week1_recovered:
    "Week 1 moved to complete the Free Agent Draft fairly.",
  fad_completed: "The Free Agent Draft is complete.",
  fad_setup_exemption_authorized:
    "Initial Season 2 Free Agent Draft exemption authorized.",
});

function privateCardDestination(
  teamId = IDS.teamOne,
  cardId = IDS.cardOne
) {
  return {
    kind: "private_card",
    leagueId: IDS.league,
    fadId: IDS.fad,
    teamId,
    cardId,
  };
}

function validCases() {
  return [
    {
      type: "fad_cards_opened",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        cardId: IDS.cardOne,
        candidateDeadlineAtMs: 1_800_000_000_000,
        destination: privateCardDestination(),
      },
      key: `fad:${IDS.fad}:cards-opened:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_readiness_blocked",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        readinessOperationId: IDS.readiness,
        errorCodes: [
          "FAD_ENTRY_DRAFT_NOT_COMPLETE",
          "FAD_MATCHUP_SCHEDULE_NOT_READY",
        ],
        destination: {
          kind: "commissioner_fad",
          leagueId: IDS.league,
          seasonId: IDS.season,
        },
      },
      key: `fad-readiness:${IDS.season}:blocked:${IDS.readiness}:${IDS.recipient}`,
    },
    {
      type: "fad_deadline_approaching",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        cardId: IDS.cardOne,
        candidateDeadlineAtMs: 1_800_000_000_000,
        completenessCode: "incomplete",
        missingMandatoryCount: 2,
        destination: privateCardDestination(),
      },
      key: `fad:${IDS.fad}:deadline-reminder:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_help_requested",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        cardId: IDS.cardOne,
        helpRequestId: IDS.helpRequest,
        requestingUserId: IDS.requester,
        requestingDisplayName: "Manager Example",
        destination: privateCardDestination(),
      },
      key: `fad:${IDS.fad}:help-requested:${IDS.helpRequest}:${IDS.recipient}`,
    },
    {
      type: "fad_cards_locked",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        destination: {
          kind: "fad_results",
          leagueId: IDS.league,
          fadId: IDS.fad,
        },
      },
      key: `fad:${IDS.fad}:cards-locked:${IDS.recipient}`,
    },
    {
      type: "fad_automatic_result",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        automaticWins: 4,
        losses: 8,
        restrictedPending: 2,
        invalidOffers: 1,
        destination: {
          kind: "fad_results",
          leagueId: IDS.league,
          fadId: IDS.fad,
        },
      },
      key: `fad:${IDS.fad}:automatic-result:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_restricted_eligible",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        allocationId: IDS.allocation,
        auctionId: IDS.auction,
        playerId: IDS.player,
        destination: {
          kind: "auction",
          leagueId: IDS.league,
          auctionId: IDS.auction,
        },
      },
      key: `fad:${IDS.fad}:restricted-eligible:${IDS.allocation}:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_restricted_fallback_opened",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        allocationId: IDS.allocation,
        auctionId: IDS.auction,
        playerId: IDS.player,
        resolvesAtMs: 1_800_086_400_000,
        destination: {
          kind: "auction",
          leagueId: IDS.league,
          auctionId: IDS.auction,
        },
      },
      key: `fad:${IDS.fad}:fallback-opened:${IDS.auction}:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_rapid_auction_result",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        teamId: IDS.teamOne,
        allocationId: null,
        auctionId: IDS.auction,
        playerId: IDS.player,
        outcomeCode: "lost",
        destination: {
          kind: "auction",
          leagueId: IDS.league,
          auctionId: IDS.auction,
        },
      },
      key: `fad:${IDS.fad}:rapid-result:${IDS.auction}:${IDS.teamOne}:${IDS.recipient}`,
    },
    {
      type: "fad_correction_required",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        allocationId: IDS.allocation,
        auctionId: null,
        recoveryId: IDS.recovery,
        playerId: IDS.player,
        errorCode: "FAD_ALLOCATION_REQUIRES_RECOVERY",
        destination: {
          kind: "fad_recovery",
          leagueId: IDS.league,
          fadId: IDS.fad,
          recoveryId: IDS.recovery,
        },
      },
      key: `fad:${IDS.fad}:correction-required:${IDS.recovery}:${IDS.recipient}`,
    },
    {
      type: "fad_week1_recovered",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        scheduleRecoveryOperationId: IDS.scheduleRecovery,
        competitionFirstMatchupStartsAtMs:
          1_800_604_800_000,
        destination: {
          kind: "fad_overview",
          leagueId: IDS.league,
          fadId: IDS.fad,
        },
      },
      key: `fad:${IDS.fad}:week1-recovered:${IDS.scheduleRecovery}:${IDS.recipient}`,
    },
    {
      type: "fad_completed",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        fadId: IDS.fad,
        completedAtMs: 1_800_604_800_000,
        destination: {
          kind: "fad_overview",
          leagueId: IDS.league,
          fadId: IDS.fad,
        },
      },
      key: `fad:${IDS.fad}:completed:${IDS.recipient}`,
    },
    {
      type: "fad_setup_exemption_authorized",
      messageData: {
        leagueId: IDS.league,
        seasonId: IDS.season,
        exemptionId: IDS.exemption,
        destination: {
          kind: "commissioner_fad",
          leagueId: IDS.league,
          seasonId: IDS.season,
        },
      },
      key: `fad_setup_exemption_authorized:${IDS.league}:${IDS.season}:${IDS.exemption}:${IDS.recipient}`,
    },
  ];
}

function contractError(reasonCode = null) {
  return (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftNotificationContractError
    );
    assert.equal(
      error.code,
      FREE_AGENT_DRAFT_NOTIFICATION_CONTRACT_INVALID
    );
    if (reasonCode !== null) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    assertDeepFrozen(child);
  }
}

function copy(value) {
  return structuredClone(value);
}

describe("FAD-14 notification contracts", () => {
  it("closes the exact thirteen-type registry, destination kinds, outcome codes, completeness codes, and list copy", () => {
    assert.deepEqual(FREE_AGENT_DRAFT_NOTIFICATION_TYPES, [
      "fad_cards_opened",
      "fad_readiness_blocked",
      "fad_deadline_approaching",
      "fad_help_requested",
      "fad_cards_locked",
      "fad_automatic_result",
      "fad_restricted_eligible",
      "fad_restricted_fallback_opened",
      "fad_rapid_auction_result",
      "fad_correction_required",
      "fad_week1_recovered",
      "fad_completed",
      "fad_setup_exemption_authorized",
    ]);
    assert.deepEqual(
      FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS,
      [
        "private_card",
        "commissioner_fad",
        "fad_results",
        "auction",
        "fad_recovery",
        "fad_overview",
      ]
    );
    assert.deepEqual(
      FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES,
      [
        "won",
        "lost",
        "invalid",
        "removed",
        "no_winner",
        "cancelled",
        "correction_required",
      ]
    );
    assert.deepEqual(
      FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES,
      ["complete", "incomplete", "conflicted"]
    );
    assert.deepEqual(
      FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY,
      EXPECTED_COPY
    );
    assertDeepFrozen(FREE_AGENT_DRAFT_NOTIFICATION_TYPES);
    assertDeepFrozen(
      FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS
    );
    assertDeepFrozen(
      FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES
    );
    assertDeepFrozen(
      FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES
    );
    assertDeepFrozen(FREE_AGENT_DRAFT_NOTIFICATION_LIST_COPY);
    assertDeepFrozen(FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS);

    for (const type of FREE_AGENT_DRAFT_NOTIFICATION_TYPES) {
      assert.equal(
        validateFreeAgentDraftNotificationType(type),
        type
      );
      assert.equal(
        getFreeAgentDraftNotificationListCopy(type),
        EXPECTED_COPY[type]
      );
      assert.equal(
        FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS[type]
          .listCopy,
        EXPECTED_COPY[type]
      );
    }
    for (const type of [
      "fad_allocation_corrected",
      "fad_cards_opened ",
      "free_agent_draft_started",
      null,
    ]) {
      assert.throws(
        () => validateFreeAgentDraftNotificationType(type),
        contractError("notification_type_invalid")
      );
    }
  });

  it("validates, clones, and deep-freezes every exact messageData and destination shape", () => {
    for (const fixture of validCases()) {
      const original = fixture.messageData;
      const validated =
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          original
        );
      assert.deepEqual(validated, original, fixture.type);
      assert.notEqual(validated, original, fixture.type);
      assert.notEqual(
        validated.destination,
        original.destination,
        fixture.type
      );
      if (fixture.type === "fad_readiness_blocked") {
        assert.notEqual(
          validated.errorCodes,
          original.errorCodes
        );
      }
      assertDeepFrozen(validated);

      const created = createFreeAgentDraftNotificationContract({
        type: fixture.type,
        recipientUserId: IDS.recipient,
        messageData: original,
      });
      assert.deepEqual(created, {
        type: fixture.type,
        recipientUserId: IDS.recipient,
        messageData: original,
        deduplicationKey: fixture.key,
        listCopy: EXPECTED_COPY[fixture.type],
      });
      assertDeepFrozen(created);
      assert.deepEqual(
        validateFreeAgentDraftNotificationContract(created),
        created
      );
    }
  });

  it("enforces exact messageData keys for every notification type", () => {
    for (const fixture of validCases()) {
      const extra = copy(fixture.messageData);
      extra.frontendUrl = "/leagues/private";
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            extra
          ),
        contractError("message_data_fields_invalid"),
        `${fixture.type} extra field`
      );

      const missing = copy(fixture.messageData);
      const removable = Object.keys(missing).find(
        (field) => field !== "destination"
      );
      delete missing[removable];
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            missing
          ),
        contractError("message_data_fields_invalid"),
        `${fixture.type} missing field`
      );
    }
  });

  it("enforces exact destination kinds, keys, and identities for every notification type", () => {
    for (const fixture of validCases()) {
      const extra = copy(fixture.messageData);
      extra.destination.url =
        "https://example.test/private";
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            extra
          ),
        contractError("destination_fields_invalid"),
        `${fixture.type} destination extra field`
      );

      const missing = copy(fixture.messageData);
      const destinationId = Object.keys(
        missing.destination
      ).find((field) => field !== "kind");
      delete missing.destination[destinationId];
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            missing
          ),
        contractError("destination_fields_invalid"),
        `${fixture.type} destination missing field`
      );

      const crossScope = copy(fixture.messageData);
      const crossScopeId = Object.keys(
        crossScope.destination
      ).find(
        (field) =>
          field !== "kind" && field in crossScope
      );
      crossScope.destination[crossScopeId] = IDS.teamTwo;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            crossScope
          ),
        contractError("destination_identity_mismatch"),
        `${fixture.type} destination identity`
      );

      const wrongKind = copy(fixture.messageData);
      wrongKind.destination.kind =
        FREE_AGENT_DRAFT_NOTIFICATION_DESTINATION_KINDS.find(
          (kind) => kind !== wrongKind.destination.kind
        );
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            wrongKind
          ),
        contractError(),
        `${fixture.type} destination kind`
      );
    }
  });

  it("accepts only the documented rapid outcomes and allocation nullability", () => {
    const fixture = validCases().find(
      ({ type }) => type === "fad_rapid_auction_result"
    );
    for (const outcomeCode of
      FREE_AGENT_DRAFT_NOTIFICATION_OUTCOME_CODES) {
      const messageData = copy(fixture.messageData);
      messageData.outcomeCode = outcomeCode;
      assert.equal(
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          messageData
        ).outcomeCode,
        outcomeCode
      );
    }
    const withAllocation = copy(fixture.messageData);
    withAllocation.allocationId = IDS.allocation;
    assert.equal(
      validateFreeAgentDraftNotificationMessageData(
        fixture.type,
        withAllocation
      ).allocationId,
      IDS.allocation
    );
    const invalidOutcome = copy(fixture.messageData);
    invalidOutcome.outcomeCode = "winner";
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          invalidOutcome
        ),
      contractError("outcome_code_invalid")
    );
    const invalidNull = copy(fixture.messageData);
    invalidNull.auctionId = null;
    invalidNull.destination.auctionId = null;
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          invalidNull
        ),
      contractError("auction_id_invalid")
    );
  });

  it("accepts canonical opaque UUID versions and rejects noncanonical ID text", () => {
    const fixture = validCases()[0];
    const versionOneLeagueId =
      "10000000-0000-1000-8000-000000000001";
    const canonical = copy(fixture.messageData);
    canonical.leagueId = versionOneLeagueId;
    canonical.destination.leagueId = versionOneLeagueId;
    assert.equal(
      validateFreeAgentDraftNotificationMessageData(
        fixture.type,
        canonical
      ).leagueId,
      versionOneLeagueId
    );
    for (const leagueId of [
      "ABCDEF00-0000-4000-8000-000000000001",
      "not-a-uuid",
      "00000000-0000-6000-8000-000000000001",
    ]) {
      const invalid = copy(fixture.messageData);
      invalid.leagueId = leagueId;
      invalid.destination.leagueId = leagueId;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            invalid
          ),
        contractError("league_id_invalid")
      );
    }
  });

  it("enforces correction allocation/auction causality and the exact safe error-code grammar", () => {
    const fixture = validCases().find(
      ({ type }) => type === "fad_correction_required"
    );
    const auctionOnly = copy(fixture.messageData);
    auctionOnly.allocationId = null;
    auctionOnly.auctionId = IDS.auction;
    assert.deepEqual(
      validateFreeAgentDraftNotificationMessageData(
        fixture.type,
        auctionOnly
      ).auctionId,
      IDS.auction
    );
    const both = copy(fixture.messageData);
    both.auctionId = IDS.auction;
    assert.deepEqual(
      validateFreeAgentDraftNotificationMessageData(
        fixture.type,
        both
      ).allocationId,
      IDS.allocation
    );
    const neither = copy(fixture.messageData);
    neither.allocationId = null;
    neither.auctionId = null;
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          neither
        ),
      contractError("correction_causality_invalid")
    );

    for (const errorCode of [
      "A",
      `A${"B".repeat(63)}`,
      "FAD_ALLOCATION_REQUIRES_RECOVERY",
    ]) {
      const messageData = copy(fixture.messageData);
      messageData.errorCode = errorCode;
      assert.equal(
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          messageData
        ).errorCode,
        errorCode
      );
    }
    for (const errorCode of [
      "",
      "lower_case",
      "1STARTS_WITH_NUMBER",
      "HAS-HYPHEN",
      `A${"B".repeat(64)}`,
      "Error: SQL at C:\\private\\database.sqlite",
      "https://provider.example/failure",
    ]) {
      const messageData = copy(fixture.messageData);
      messageData.errorCode = errorCode;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            fixture.type,
            messageData
          ),
        contractError("correction_error_code_invalid")
      );
    }
  });

  it("enforces canonical completeness, counts, timestamps, display names, and readiness codes", () => {
    const deadline = validCases().find(
      ({ type }) => type === "fad_deadline_approaching"
    );
    for (const completenessCode of
      FREE_AGENT_DRAFT_CARD_COMPLETENESS_CODES) {
      const messageData = copy(deadline.messageData);
      messageData.completenessCode = completenessCode;
      if (completenessCode === "complete") {
        messageData.missingMandatoryCount = 0;
      }
      assert.equal(
        validateFreeAgentDraftNotificationMessageData(
          deadline.type,
          messageData
        ).completenessCode,
        completenessCode
      );
    }
    for (const [field, value, reasonCode] of [
      ["completenessCode", "locked", "completeness_code_invalid"],
      ["missingMandatoryCount", -1, "missing_mandatory_count_invalid"],
      ["missingMandatoryCount", 1.5, "missing_mandatory_count_invalid"],
      ["missingMandatoryCount", 19, "missing_mandatory_count_invalid"],
      ["candidateDeadlineAtMs", -1, "candidate_deadline_invalid"],
    ]) {
      const messageData = copy(deadline.messageData);
      messageData[field] = value;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            deadline.type,
            messageData
          ),
        contractError(reasonCode)
      );
    }
    const inconsistentComplete = copy(deadline.messageData);
    inconsistentComplete.completenessCode = "complete";
    inconsistentComplete.missingMandatoryCount = 1;
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          deadline.type,
          inconsistentComplete
        ),
      contractError("completeness_summary_invalid")
    );

    const automatic = validCases().find(
      ({ type }) => type === "fad_automatic_result"
    );
    for (const field of [
      "automaticWins",
      "losses",
      "restrictedPending",
      "invalidOffers",
    ]) {
      const messageData = copy(automatic.messageData);
      messageData[field] = -1;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            automatic.type,
            messageData
          ),
        contractError()
      );
    }
    const excessiveTotal = copy(automatic.messageData);
    Object.assign(excessiveTotal, {
      automaticWins: 6,
      losses: 6,
      restrictedPending: 6,
      invalidOffers: 5,
    });
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          automatic.type,
          excessiveTotal
        ),
      contractError("automatic_result_counts_invalid")
    );

    const help = validCases().find(
      ({ type }) => type === "fad_help_requested"
    );
    for (const displayName of [
      " Manager Example",
      "Manager\nExample",
      "x".repeat(51),
      "https://example.test/private-card",
      "/api/v1/leagues/private",
    ]) {
      const messageData = copy(help.messageData);
      messageData.requestingDisplayName = displayName;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            help.type,
            messageData
          ),
        contractError("requesting_display_name_invalid")
      );
    }

    const readiness = validCases().find(
      ({ type }) => type === "fad_readiness_blocked"
    );
    for (const errorCodes of [
      [],
      ["DUPLICATE", "DUPLICATE"],
      ["raw exception message"],
      ["HAS-HYPHEN"],
    ]) {
      const messageData = copy(readiness.messageData);
      messageData.errorCodes = errorCodes;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            readiness.type,
            messageData
          ),
        contractError("error_codes_invalid")
      );
    }
  });

  it("constructs and validates every exact canonical deduplication key", () => {
    for (const fixture of validCases()) {
      const input = {
        type: fixture.type,
        recipientUserId: IDS.recipient,
        messageData: fixture.messageData,
      };
      assert.equal(
        createFreeAgentDraftNotificationDeduplicationKey(
          input
        ),
        fixture.key,
        fixture.type
      );
      assert.equal(
        validateFreeAgentDraftNotificationDeduplicationKey({
          ...input,
          deduplicationKey: fixture.key,
        }),
        fixture.key,
        fixture.type
      );
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationDeduplicationKey({
            ...input,
            deduplicationKey: `${fixture.key}:duplicate`,
          }),
        contractError("deduplication_key_invalid"),
        fixture.type
      );
    }
  });

  it("keeps team-scoped identity distinct for one user managing multiple teams and league-wide identity singular", () => {
    const teamScopedTypes = [
      "fad_cards_opened",
      "fad_deadline_approaching",
      "fad_automatic_result",
      "fad_restricted_eligible",
      "fad_restricted_fallback_opened",
      "fad_rapid_auction_result",
    ];
    for (const type of teamScopedTypes) {
      const first = validCases().find(
        (fixture) => fixture.type === type
      );
      const secondData = copy(first.messageData);
      secondData.teamId = IDS.teamTwo;
      if (secondData.destination.teamId !== undefined) {
        secondData.destination.teamId = IDS.teamTwo;
      }
      if (secondData.cardId !== undefined) {
        secondData.cardId = IDS.cardTwo;
        secondData.destination.cardId = IDS.cardTwo;
      }
      const firstKey =
        createFreeAgentDraftNotificationDeduplicationKey({
          type,
          recipientUserId: IDS.recipient,
          messageData: first.messageData,
        });
      const secondKey =
        createFreeAgentDraftNotificationDeduplicationKey({
          type,
          recipientUserId: IDS.recipient,
          messageData: secondData,
        });
      assert.notEqual(firstKey, secondKey, type);
      assert.match(firstKey, new RegExp(IDS.teamOne));
      assert.match(secondKey, new RegExp(IDS.teamTwo));
      assert.ok(
        FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS[
          type
        ].deduplicationIdentity.includes("teamId"),
        type
      );
    }

    for (const type of [
      "fad_cards_locked",
      "fad_correction_required",
      "fad_week1_recovered",
      "fad_completed",
      "fad_setup_exemption_authorized",
    ]) {
      assert.equal(
        FREE_AGENT_DRAFT_NOTIFICATION_CONTRACTS[
          type
        ].deduplicationIdentity.includes("teamId"),
        false,
        type
      );
    }
  });

  it("rejects private pre-deadline values, help text, raw routes, active bids, and non-contract recipient evidence", () => {
    const privacyMutations = [
      ["fad_cards_opened", "playerId", IDS.player],
      ["fad_cards_opened", "candidateOffer", { total: 600 }],
      ["fad_deadline_approaching", "slotKey", "F01"],
      ["fad_help_requested", "helpMessage", "private details"],
      ["fad_help_requested", "frontendUrl", "/leagues/private"],
      ["fad_rapid_auction_result", "activeBidValueCents", 500],
      ["fad_completed", "recipientMembershipId", IDS.recipient],
      ["fad_completed", "recipientAuthority", "commissioner"],
      [
        "fad_setup_exemption_authorized",
        "reason",
        "private exemption reason",
      ],
    ];
    for (const [type, field, value] of privacyMutations) {
      const fixture = validCases().find(
        (candidate) => candidate.type === type
      );
      const messageData = copy(fixture.messageData);
      messageData[field] = value;
      assert.throws(
        () =>
          validateFreeAgentDraftNotificationMessageData(
            type,
            messageData
          ),
        contractError("message_data_fields_invalid"),
        `${type}.${field}`
      );
    }
  });

  it("rejects accessor, symbol, prototype, and malformed contract evidence without executing input code", () => {
    const fixture = validCases()[0];
    const accessor = copy(fixture.messageData);
    Object.defineProperty(accessor, "leagueId", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          accessor
        ),
      contractError("message_data_fields_invalid")
    );

    const symbol = copy(fixture.messageData);
    symbol[Symbol("private")] = "secret";
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          symbol
        ),
      contractError("message_data_fields_invalid")
    );

    const exotic = Object.assign(
      Object.create({ inherited: true }),
      fixture.messageData
    );
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationMessageData(
          fixture.type,
          exotic
        ),
      contractError("message_data_fields_invalid")
    );

    const created = createFreeAgentDraftNotificationContract({
      type: fixture.type,
      recipientUserId: IDS.recipient,
      messageData: fixture.messageData,
    });
    assert.throws(
      () =>
        validateFreeAgentDraftNotificationContract({
          ...created,
          listCopy: "Changed copy",
        }),
      contractError("notification_contract_evidence_invalid")
    );
    assert.throws(
      () =>
        createFreeAgentDraftNotificationContract({
          type: fixture.type,
          recipientUserId: IDS.recipient,
          messageData: fixture.messageData,
          membershipId: IDS.recipient,
        }),
      contractError("notification_contract_fields_invalid")
    );
  });
});
