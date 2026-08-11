"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  ACTION_POLICIES,
  AUCTION_ADMINISTRATION_CODES,
  AUCTION_ADMINISTRATION_REASON_CODES,
  AUCTION_ADMINISTRATION_REQUEST_DOMAIN,
  AuctionAdministrationPolicyError,
  auctionAdministrationRequestProjection,
  getAuctionAdministrationActionPolicy,
  hashAuctionAdministrationRequest,
  serializeAuctionAdministrationRequest,
  validateAuctionAdministrationStoredResult,
} = require(
  "../../src/domain/auctions/auctionAdministrationPolicy"
);
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const AUCTION_ID =
  "22222222-2222-4222-8222-222222222222";
const BID_ID =
  "33333333-3333-4333-8333-333333333333";
const TEAM_ID =
  "44444444-4444-4444-8444-444444444444";
const SEASON_ID =
  "55555555-5555-4555-8555-555555555555";
const PLAYER_ID =
  "66666666-6666-4666-8666-666666666666";
const RESULT_ID =
  "77777777-7777-4777-8777-777777777777";
const IDEMPOTENCY_REQUEST_ID =
  "88888888-8888-4888-8888-888888888888";
const ACTOR_USER_ID =
  "99999999-9999-4999-8999-999999999999";
const ACTOR_MEMBERSHIP_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_RUN_ID =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_BID_ID =
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAD_ID =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FAD_ROLLOVER_ID =
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ALLOCATION_ID =
  "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RECOVERY_ID =
  "12121212-1212-4212-8212-121212121212";
const DRAW_COMMITMENT = "d".repeat(64);

const EXPECTED_VERSION = 7;
const CREATED_AT_MS = 3_000;
const REQUEST_SHA256 = Object.freeze({
  edit_bid:
    "f3650d1a7aacb002dc26892db9a4fe1f5e4869db59d60b18c4d61f7d22d088be",
  remove_bid:
    "6aed369fdb4659768638b217eb5dd8220d93ca758c97643419c90f660869736e",
  cancel_auction:
    "11c1ccb97023f274944b47f2723c74d8745d69037f6e05ed0660113162d2e518",
  request_resolution:
    "74e0ac626102e2b4ecaf54369d417b657cfc5ff42576c4713aca60910a11df67",
});
const REQUEST_CANONICAL_JSON = Object.freeze({
  edit_bid:
    '{"action":"edit_bid","auctionId":"22222222-2222-4222-8222-222222222222","bidId":"33333333-3333-4333-8333-333333333333","body":{"teamId":"44444444-4444-4444-8444-444444444444","termYears":2,"totalValueCents":600},"domain":"hundo-leago.auction-administration-request","leagueId":"11111111-1111-4111-8111-111111111111","preconditionKind":"bid","preconditionVersion":7,"schemaVersion":1}',
  remove_bid:
    '{"action":"remove_bid","auctionId":"22222222-2222-4222-8222-222222222222","bidId":"33333333-3333-4333-8333-333333333333","body":{"confirmation":"REMOVE AUCTION BID"},"domain":"hundo-leago.auction-administration-request","leagueId":"11111111-1111-4111-8111-111111111111","preconditionKind":"bid","preconditionVersion":7,"schemaVersion":1}',
  cancel_auction:
    '{"action":"cancel_auction","auctionId":"22222222-2222-4222-8222-222222222222","bidId":null,"body":{"confirmation":"CANCEL AUCTION"},"domain":"hundo-leago.auction-administration-request","leagueId":"11111111-1111-4111-8111-111111111111","preconditionKind":"auction","preconditionVersion":7,"schemaVersion":1}',
  request_resolution:
    '{"action":"request_resolution","auctionId":"22222222-2222-4222-8222-222222222222","bidId":null,"body":{"confirmation":"RESOLVE AUCTION"},"domain":"hundo-leago.auction-administration-request","leagueId":"11111111-1111-4111-8111-111111111111","preconditionKind":"auction","preconditionVersion":7,"schemaVersion":1}',
});

const ACTION_EXPECTATIONS = Object.freeze({
  edit_bid: Object.freeze({
    operation: "auction.bid.put",
    preconditionKind: "bid",
    bidLink: "required",
    resultVersionRule: "expected_plus_one",
    httpStatus: 200,
  }),
  remove_bid: Object.freeze({
    operation: "auction.bid.remove",
    preconditionKind: "bid",
    bidLink: "required",
    resultVersionRule: "expected_plus_one",
    httpStatus: 200,
  }),
  cancel_auction: Object.freeze({
    operation: "auction.cancel",
    preconditionKind: "auction",
    bidLink: "null",
    resultVersionRule: "greater_than_expected",
    httpStatus: 200,
  }),
  request_resolution: Object.freeze({
    operation: "auction.resolve.request",
    preconditionKind: "auction",
    bidLink: "null",
    resultVersionRule: "unchanged",
    httpStatus: 202,
  }),
});

function bodyFor(action) {
  if (action === "edit_bid") {
    return {
      teamId: TEAM_ID,
      totalValueCents: 600,
      termYears: 2,
    };
  }
  return {
    confirmation: {
      remove_bid: "REMOVE AUCTION BID",
      cancel_auction: "CANCEL AUCTION",
      request_resolution: "RESOLVE AUCTION",
    }[action],
  };
}

function requestFor(action, overrides = {}) {
  const isBidAction = [
    "edit_bid",
    "remove_bid",
  ].includes(action);
  return {
    leagueId: LEAGUE_ID,
    auctionId: AUCTION_ID,
    bidId: isBidAction ? BID_ID : null,
    action,
    preconditionKind: isBidAction
      ? "bid"
      : "auction",
    preconditionVersion: EXPECTED_VERSION,
    body: bodyFor(action),
    ...overrides,
  };
}

function allowedCapability() {
  return {
    allowed: true,
    reasonCode: null,
  };
}

function activeAuction(overrides = {}) {
  return {
    auctionId: AUCTION_ID,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    version: 5,
    player: {
      playerId: PLAYER_ID,
      fullName: "Alex Example",
      positionGroup: "F",
    },
    status: "active",
    openedAtMs: 1_000,
    resolvesAtMs: 2_000,
    resolvedAtMs: null,
    updatedAtMs: 1_500,
    bidCount: 1,
    participatingTeamCount: 1,
    sourceKind: "ordinary_weekly",
    fadOrigin: null,
    fadId: null,
    fadRolloverId: null,
    targetRolloverAtMs: null,
    creationCutoffAtMs: null,
    eligibleTeams: [],
    minimumContract: null,
    drawCommitment: null,
    viewerTeams: [],
    administrativeBids: [],
    result: null,
    capabilities: {
      view: allowedCapability(),
      adminCancel: allowedCapability(),
      adminResolve: allowedCapability(),
    },
    ...overrides,
  };
}

function cancelledAuction() {
  const resolvedAtMs = 2_000;
  return activeAuction({
    version: 9,
    status: "cancelled",
    resolvedAtMs,
    updatedAtMs: resolvedAtMs,
    result: {
      outcomeCode: "cancelled",
      winningTeam: null,
      submittedTotalValueCents: null,
      submittedTermYears: null,
      submittedAavCents: null,
      finalContractValueCents: null,
      finalAavCents: null,
      contractId: null,
      ownershipId: null,
      activityId: null,
      recoveryId: null,
      drawEvidence: null,
      resolvedAtMs,
    },
  });
}

function correctionRequiredAuction() {
  const resolvedAtMs = 3_000;
  return activeAuction({
    version: 9,
    status: "correction_required",
    resolvesAtMs: 3_601_000,
    resolvedAtMs,
    updatedAtMs: resolvedAtMs,
    bidCount: 1,
    participatingTeamCount: 2,
    sourceKind: "fad_restricted",
    fadOrigin: "candidate_tie_restricted",
    fadId: FAD_ID,
    fadRolloverId: FAD_ROLLOVER_ID,
    targetRolloverAtMs: 3_601_000,
    creationCutoffAtMs: 1_000,
    minimumContract: {
      totalValueCents: 500,
      termYears: 2,
      aavCents: 250,
    },
    drawCommitment: DRAW_COMMITMENT,
    result: {
      outcomeCode: "correction_required",
      winningTeam: null,
      submittedTotalValueCents: null,
      submittedTermYears: null,
      submittedAavCents: null,
      finalContractValueCents: null,
      finalAavCents: null,
      contractId: null,
      ownershipId: null,
      activityId: null,
      recoveryId: RECOVERY_ID,
      drawEvidence: {
        commitmentHex: DRAW_COMMITMENT,
        reveal: null,
      },
      resolvedAtMs,
    },
  });
}

function correctionRequiredAllocation(overrides = {}) {
  return {
    allocationId: ALLOCATION_ID,
    allocationVersion: 3,
    player: {
      playerId: PLAYER_ID,
      fullName: "Alex Example",
      positionGroup: "F",
    },
    status: "correction_required",
    decisionCode: "exact_total_and_term_tie",
    rankedOffers: [],
    winner: null,
    restricted: {
      auctionId: AUCTION_ID,
      status: "cancelled",
    },
    fallback: null,
    draws: [],
    recoveryStatus: "correction_required",
    resolvedAtMs: null,
    ...overrides,
  };
}

function restrictedCancellationData(
  allocationOverrides = {}
) {
  return {
    auction: correctionRequiredAuction(),
    fadAllocation: correctionRequiredAllocation(
      allocationOverrides
    ),
    recoveryId: RECOVERY_ID,
  };
}

function resolutionData(overrides = {}) {
  return {
    operationId: JOB_RUN_ID,
    occurrenceKey: `auction:${AUCTION_ID}:2000`,
    auctionId: AUCTION_ID,
    status: "pending",
    acceptedAtMs: CREATED_AT_MS,
    pollDescriptor: {
      kind: "auction",
      leagueId: LEAGUE_ID,
      auctionId: AUCTION_ID,
    },
    ...overrides,
  };
}

function responseDataFor(action) {
  if (action === "edit_bid") {
    return activeAuction();
  }
  if (action === "remove_bid") {
    return {
      auction: activeAuction(),
      removedBidId: BID_ID,
      restrictedParticipantStatus: null,
      fadAllocationVersion: null,
    };
  }
  if (action === "cancel_auction") {
    return {
      auction: cancelledAuction(),
      fadAllocation: null,
      recoveryId: null,
    };
  }
  return resolutionData();
}

function storedResultFor(
  action,
  overrides = {}
) {
  const expectation = ACTION_EXPECTATIONS[action];
  const data =
    overrides.data ?? responseDataFor(action);
  const responseJson =
    overrides.responseJson ??
    serializeCanonicalJsonV1(data);
  const responseSha256 =
    overrides.responseSha256 ??
    hashCanonicalJsonV1(data);
  const isBidAction =
    expectation.preconditionKind === "bid";
  const resultingResourceVersion = {
    edit_bid: 8,
    remove_bid: 8,
    cancel_auction: 9,
    request_resolution: 7,
  }[action];
  const row = {
    id: RESULT_ID,
    leagueId: LEAGUE_ID,
    seasonId: SEASON_ID,
    auctionId: AUCTION_ID,
    bidId: isBidAction ? BID_ID : null,
    idempotencyRequestId: IDEMPOTENCY_REQUEST_ID,
    jobRunId:
      action === "request_resolution"
        ? JOB_RUN_ID
        : null,
    action,
    actorUserId: ACTOR_USER_ID,
    actorMembershipId: ACTOR_MEMBERSHIP_ID,
    actorAuthority: "commissioner",
    requestSha256: REQUEST_SHA256[action],
    preconditionKind: expectation.preconditionKind,
    expectedResourceVersion: EXPECTED_VERSION,
    resultingResourceVersion,
    responseHttpStatus: expectation.httpStatus,
    responseJson,
    responseSha256,
    createdAtMs: CREATED_AT_MS,
    version: 1,
  };
  for (const [key, value] of Object.entries(
    overrides
  )) {
    if (
      !["data", "responseJson", "responseSha256"].includes(
        key
      )
    ) {
      row[key] = value;
    }
  }
  return row;
}

function assertPolicyError(
  callback,
  code,
  reasonCode
) {
  assert.throws(
    callback,
    (error) =>
      error instanceof
        AuctionAdministrationPolicyError &&
      error.code === code &&
      error.reasonCode === reasonCode
  );
}

describe(
  "auction administration action and request policy",
  () => {
    test("publishes the exact closed action map", () => {
      assert.deepEqual(
        Object.keys(ACTION_POLICIES).sort(),
        Object.keys(ACTION_EXPECTATIONS).sort()
      );
      for (const [
        action,
        expectation,
      ] of Object.entries(ACTION_EXPECTATIONS)) {
        assert.deepEqual(
          getAuctionAdministrationActionPolicy(
            action
          ),
          {
            action,
            ...expectation,
          }
        );
      }
      assertPolicyError(
        () =>
          getAuctionAdministrationActionPolicy(
            "withdraw_bid"
          ),
        AUCTION_ADMINISTRATION_CODES.actionInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .actionInvalid
      );
    });

    test("matches fixed independent SHA-256 vectors for every action", () => {
      for (const action of Object.keys(
        ACTION_EXPECTATIONS
      )) {
        assert.equal(
          serializeAuctionAdministrationRequest(
            requestFor(action)
          ),
          REQUEST_CANONICAL_JSON[action]
        );
        assert.equal(
          hashAuctionAdministrationRequest(
            requestFor(action)
          ),
          REQUEST_SHA256[action]
        );
      }
    });

    test("uses the exact request preimage and freezes its body", () => {
      const projection =
        auctionAdministrationRequestProjection(
          requestFor("edit_bid")
        );
      assert.deepEqual(projection, {
        domain:
          AUCTION_ADMINISTRATION_REQUEST_DOMAIN,
        schemaVersion: 1,
        leagueId: LEAGUE_ID,
        auctionId: AUCTION_ID,
        bidId: BID_ID,
        action: "edit_bid",
        preconditionKind: "bid",
        preconditionVersion: EXPECTED_VERSION,
        body: {
          teamId: TEAM_ID,
          totalValueCents: 600,
          termYears: 2,
        },
      });
      assert.equal(Object.isFrozen(projection), true);
      assert.equal(
        Object.isFrozen(projection.body),
        true
      );
      assert.throws(
        () => {
          projection.body.termYears = 3;
        },
        TypeError
      );
    });

    test("body, action, kind, version, and bid changes alter request identity", () => {
      const baseline =
        hashAuctionAdministrationRequest(
          requestFor("edit_bid")
        );
      const canonicalProjection =
        auctionAdministrationRequestProjection(
          requestFor("edit_bid")
        );
      const hashes = [
        hashAuctionAdministrationRequest(
          requestFor("edit_bid", {
            body: {
              teamId: TEAM_ID,
              totalValueCents: 700,
              termYears: 2,
            },
          })
        ),
        hashAuctionAdministrationRequest(
          requestFor("remove_bid")
        ),
        hashAuctionAdministrationRequest(
          requestFor("edit_bid", {
            preconditionVersion: 8,
          })
        ),
        hashAuctionAdministrationRequest(
          requestFor("edit_bid", {
            bidId: OTHER_BID_ID,
          })
        ),
        hashCanonicalJsonV1({
          ...canonicalProjection,
          preconditionKind: "auction",
        }),
      ];
      assert.equal(new Set(hashes).size, hashes.length);
      assert.equal(
        hashes.every((hash) => hash !== baseline),
        true
      );
    });

    test("rejects mismatched bid links and precondition kinds", () => {
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("edit_bid", {
              bidId: null,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdRequired
      );
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("cancel_auction", {
              bidId: BID_ID,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdMustBeNull
      );
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("edit_bid", {
              preconditionKind: "auction",
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .preconditionKindInvalid
      );
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("request_resolution", {
              preconditionKind: "bid",
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .preconditionKindInvalid
      );
    });

    test("does not interchange omitted and explicit-null fields", () => {
      const missingBid = requestFor("cancel_auction");
      delete missingBid.bidId;
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(missingBid),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .requestFieldsInvalid
      );

      const missingConfirmation =
        requestFor("cancel_auction");
      delete missingConfirmation.body.confirmation;
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            missingConfirmation
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .bodyFieldsInvalid
      );

      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("cancel_auction", {
              body: { confirmation: null },
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .confirmationInvalid
      );
    });

    test("rejects extra request/body fields and invalid edit values", () => {
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest({
            ...requestFor("remove_bid"),
            reason: "please",
          }),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .requestFieldsInvalid
      );
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("remove_bid", {
              body: {
                confirmation: "REMOVE AUCTION BID",
                reason: null,
              },
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .bodyFieldsInvalid
      );
      assertPolicyError(
        () =>
          hashAuctionAdministrationRequest(
            requestFor("edit_bid", {
              body: {
                teamId: TEAM_ID,
                totalValueCents: 550,
                termYears: 2,
              },
            })
          ),
        AUCTION_ADMINISTRATION_CODES.requestInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .totalValueInvalid
      );
    });
  }
);

describe(
  "auction administration persisted result policy",
  () => {
    test("accepts and freezes safe replay data for all four actions", () => {
      for (const action of Object.keys(
        ACTION_EXPECTATIONS
      )) {
        const result =
          validateAuctionAdministrationStoredResult(
            storedResultFor(action)
          );
        assert.equal(
          result.operation,
          ACTION_EXPECTATIONS[action].operation
        );
        assert.equal(
          result.responseHttpStatus,
          ACTION_EXPECTATIONS[action].httpStatus
        );
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.data), true);
        if (action === "edit_bid") {
          assert.equal(
            Object.isFrozen(result.data.player),
            true
          );
          assert.equal(
            Object.isFrozen(result.data.viewerTeams),
            true
          );
        }
        assert.throws(
          () => {
            result.data.injected = true;
          },
          TypeError
        );
      }
    });

    test(
      "accepts the canonical restricted T-082 recovery status and rejects invalid recovery-status shapes",
      () => {
        const accepted =
          validateAuctionAdministrationStoredResult(
            storedResultFor("cancel_auction", {
              data: restrictedCancellationData(),
            })
          );
        assert.equal(
          accepted.data.fadAllocation.recoveryStatus,
          "correction_required"
        );
        assert.equal(
          Object.isFrozen(accepted.data.fadAllocation),
          true
        );

        for (const recoveryStatus of [
          "failed",
          { status: "correction_required" },
        ]) {
          assertPolicyError(
            () =>
              validateAuctionAdministrationStoredResult(
                storedResultFor("cancel_auction", {
                  data: restrictedCancellationData({
                    recoveryStatus,
                  }),
                })
              ),
            AUCTION_ADMINISTRATION_CODES.resultInvalid,
            AUCTION_ADMINISTRATION_REASON_CODES.dataInvalid
          );
        }
      }
    );

    test("enforces exact resulting-version rules", () => {
      for (const action of [
        "edit_bid",
        "remove_bid",
      ]) {
        assertPolicyError(
          () =>
            validateAuctionAdministrationStoredResult(
              storedResultFor(action, {
                resultingResourceVersion: 9,
              })
            ),
          AUCTION_ADMINISTRATION_CODES.resultInvalid,
          AUCTION_ADMINISTRATION_REASON_CODES
            .resultingVersionInvalid
        );
      }
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("cancel_auction", {
              resultingResourceVersion: 7,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .resultingVersionInvalid
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("request_resolution", {
              resultingResourceVersion: 8,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .resultingVersionInvalid
      );
    });

    test("enforces each action's original 200 or 202 status", () => {
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("edit_bid", {
              responseHttpStatus: 202,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .responseHttpStatusInvalid
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("request_resolution", {
              responseHttpStatus: 200,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .responseHttpStatusInvalid
      );
    });

    test("rejects mismatched persisted bid/job links and preconditions", () => {
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("remove_bid", {
              bidId: null,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .bidIdRequired
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("cancel_auction", {
              jobRunId: JOB_RUN_ID,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .jobRunIdMustBeNull
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("request_resolution", {
              jobRunId: null,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .jobRunIdRequired
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("cancel_auction", {
              preconditionKind: "bid",
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .preconditionKindInvalid
      );
    });

    test("rejects malformed response data and T-083 status", () => {
      const badEditData = activeAuction();
      delete badEditData.capabilities;
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("edit_bid", {
              data: badEditData,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .auctionProjectionInvalid
      );

      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("request_resolution", {
              data: resolutionData({
                status: "succeeded",
              }),
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .dataInvalid
      );
    });

    test("rejects wrong or noncanonical response evidence", () => {
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("remove_bid", {
              responseSha256: "0".repeat(64),
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .responseSha256Invalid
      );

      const data = responseDataFor("remove_bid");
      const canonical =
        serializeCanonicalJsonV1(data);
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("remove_bid", {
              responseJson: ` ${canonical}`,
              responseSha256:
                hashCanonicalJsonV1(data),
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .responseSha256Invalid
      );
    });

    test("rejects malformed persisted status, version, and exact fields", () => {
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("edit_bid", {
              version: 2,
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .resultVersionInvalid
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult({
            ...storedResultFor("edit_bid"),
            mutableAuctionStatus: "resolved",
          }),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .resultFieldsInvalid
      );
      assertPolicyError(
        () =>
          validateAuctionAdministrationStoredResult(
            storedResultFor("edit_bid", {
              actorAuthority: "manager",
            })
          ),
        AUCTION_ADMINISTRATION_CODES.resultInvalid,
        AUCTION_ADMINISTRATION_REASON_CODES
          .actorAuthorityInvalid
      );
    });

    test("replays from immutable stored data without a mutable auction input", () => {
      const stored =
        storedResultFor("request_resolution");
      const replay =
        validateAuctionAdministrationStoredResult(
          stored
        );
      assert.deepEqual(replay.data, resolutionData());
      assert.equal(replay.responseHttpStatus, 202);
      assert.equal(replay.expectedResourceVersion, 7);
      assert.equal(replay.resultingResourceVersion, 7);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          replay,
          "currentAuction"
        ),
        false
      );
    });
  }
);
