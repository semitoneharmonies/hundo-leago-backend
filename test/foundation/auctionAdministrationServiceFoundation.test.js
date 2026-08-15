"use strict";

const assert = require("node:assert/strict");
const {
  describe,
  test,
} = require("node:test");

const {
  AUCTION_ADMINISTRATION_CODES,
  AuctionAdministrationPolicyError,
} = require(
  "../../src/domain/auctions/auctionAdministrationPolicy"
);
const {
  AUCTION_ADMINISTRATION_REPOSITORY_CODES,
  AuctionAdministrationRepositoryError,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteAuctionAdministrationRepository"
);
const {
  AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS,
  createAuctionAdministrationService,
} = require(
  "../../src/application/services/auctions/createAuctionAdministrationService"
);

const NOW_MS = 10_000;
const DUE_AT_MS = 20_000;

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  auction: uuid(2),
  bid: uuid(3),
  team: uuid(4),
  commissionerUser: uuid(5),
  commissionerMembership: uuid(6),
  administratorUser: uuid(7),
  administratorMembership: uuid(8),
  result: uuid(9),
  idempotency: uuid(10),
  job: uuid(11),
  allocation: uuid(12),
  recovery: uuid(13),
});
const AUTHENTICATED = Object.freeze({
  valid: true,
  marker: "authenticated-request",
});

function authority({
  actorAuthority = "commissioner",
} = {}) {
  const administrator =
    actorAuthority !== "commissioner";
  return Object.freeze({
    authorized: true,
    leagueId: IDS.league,
    actorUserId: administrator
      ? IDS.administratorUser
      : IDS.commissionerUser,
    membershipId: administrator
      ? IDS.administratorMembership
      : IDS.commissionerMembership,
    authority: actorAuthority,
  });
}

function bodyFor(action) {
  if (action === "edit_bid") {
    return {
      teamId: IDS.team,
      aavCents: 300,
      termYears: 2,
    };
  }
  return {
    confirmation: {
      remove_bid: "REMOVE AUCTION BID",
      cancel_auction: "CANCEL AUCTION",
      request_resolution:
        "RESOLVE AUCTION",
    }[action],
  };
}

function methodOptions(
  action,
  {
    expectedVersion = 7,
    idempotencyKey =
      `service-${action}`,
    input = bodyFor(action),
  } = {}
) {
  const common = {
    leagueId: IDS.league,
    auctionId: IDS.auction,
    input,
    idempotencyKey,
    authenticated: AUTHENTICATED,
  };
  if (
    action === "edit_bid" ||
    action === "remove_bid"
  ) {
    return {
      ...common,
      bidId: IDS.bid,
      expectedBidVersion:
        expectedVersion,
    };
  }
  return {
    ...common,
    expectedAuctionVersion:
      expectedVersion,
  };
}

function invoke(service, action, options) {
  if (action === "edit_bid") {
    return service.editBid(options);
  }
  if (action === "remove_bid") {
    return service.removeBid(options);
  }
  if (action === "cancel_auction") {
    return service.cancelAuction(options);
  }
  return service.requestResolution(options);
}

function resultingVersion(command) {
  if (
    command.action ===
    "request_resolution"
  ) {
    return command.preconditionVersion;
  }
  return command.preconditionVersion + 1;
}

function dataFor(
  command,
  {
    sourceKind = "ordinary_weekly",
    resolutionStatus = "pending",
    acceptedAtMs = command.occurredAtMs,
    operationId = IDS.job,
  } = {}
) {
  if (command.action === "edit_bid") {
    return {
      sourceKind,
    };
  }
  if (command.action === "remove_bid") {
    return {
      auction: {
        sourceKind,
      },
      removedBidId: command.bidId,
      restrictedParticipantStatus:
        sourceKind === "fad_restricted"
          ? "removed"
          : null,
      fadAllocationVersion:
        sourceKind === "fad_restricted"
          ? 1
          : null,
    };
  }
  if (command.action === "cancel_auction") {
    return {
      auction: {
        sourceKind,
      },
      fadAllocation:
        sourceKind === "ordinary_weekly"
          ? null
          : {},
      recoveryId:
        sourceKind === "ordinary_weekly"
          ? null
          : uuid(99),
    };
  }
  return {
    operationId,
    occurrenceKey:
      `auction:${command.auctionId}:${DUE_AT_MS}`,
    auctionId: command.auctionId,
    status: resolutionStatus,
    acceptedAtMs,
    pollDescriptor: {
      kind: "auction",
      leagueId: command.leagueId,
      auctionId: command.auctionId,
    },
  };
}

function restrictedCancellationData(overrides = {}) {
  return {
    auction: {
      sourceKind: "fad_restricted",
      status: "correction_required",
      result: {
        recoveryId: IDS.recovery,
      },
    },
    fadAllocation: {
      allocationId: IDS.allocation,
      status: "correction_required",
      recoveryStatus: "correction_required",
    },
    recoveryId: IDS.recovery,
    ...overrides,
  };
}

function openRapidCancellationData(overrides = {}) {
  return {
    auction: {
      sourceKind: "fad_open_rapid",
      status: "cancelled",
      result: {
        recoveryId: IDS.recovery,
      },
    },
    fadAllocation: null,
    recoveryId: IDS.recovery,
    ...overrides,
  };
}

function resultFor(
  command,
  {
    actorAuthority = "commissioner",
    replayed = false,
    data = dataFor(command),
    jobRunId =
      command.action ===
      "request_resolution"
        ? IDS.job
        : null,
  } = {}
) {
  return {
    replayed,
    action: command.action,
    actorAuthority,
    httpStatus:
      command.action ===
      "request_resolution"
        ? 202
        : 200,
    data,
    evidence: {
      resultId: IDS.result,
      idempotencyRequestId:
        IDS.idempotency,
      jobRunId,
      requestSha256: "a".repeat(64),
      responseSha256: "b".repeat(64),
      preconditionKind:
        command.action === "edit_bid" ||
        command.action === "remove_bid"
          ? "bid"
          : "auction",
      expectedResourceVersion:
        command.preconditionVersion,
      resultingResourceVersion:
        resultingVersion(command),
      createdAtMs: command.occurredAtMs,
      version: 1,
    },
  };
}

function createHarness({
  nowMs = NOW_MS,
  actorAuthority = "commissioner",
  authorize,
  findReplay,
  administer,
} = {}) {
  const authorizationCalls = [];
  const replayProbeCalls = [];
  const repositoryCalls = [];
  const clockCalls = [];
  const selectedAuthority = authority({
    actorAuthority,
  });
  const persistedAuthority =
    actorAuthority === "commissioner"
      ? "commissioner"
      : "platform_administrator_as_commissioner";
  const repository = {
    findReplay(command) {
      replayProbeCalls.push(command);
      return findReplay
        ? findReplay(command)
        : null;
    },
    administer(command) {
      repositoryCalls.push(command);
      return administer
        ? administer(command)
        : resultFor(command, {
            actorAuthority:
              persistedAuthority,
          });
    },
  };
  const service =
    createAuctionAdministrationService({
      leagueAuthorization: {
        requireCommissioner(
          authenticated,
          leagueId
        ) {
          authorizationCalls.push({
            authenticated,
            leagueId,
          });
          return authorize
            ? authorize(
                authenticated,
                leagueId
              )
            : selectedAuthority;
        },
      },
      repository,
      clock: {
        nowMs() {
          clockCalls.push(true);
          return typeof nowMs === "function"
            ? nowMs()
            : nowMs;
        },
      },
    });
  return {
    authorizationCalls,
    clockCalls,
    replayProbeCalls,
    repositoryCalls,
    service,
    selectedAuthority,
  };
}

describe(
  "FAD-11 context-aware auction administration application service",
  () => {
    test(
      "requires only current authority, atomic administration persistence, and a server clock",
      () => {
        assert.throws(
          () =>
            createAuctionAdministrationService(),
          /authority/i
        );
        assert.throws(
          () =>
            createAuctionAdministrationService({
              leagueAuthorization: {
                requireCommissioner() {},
              },
            }),
          /repository/i
        );
        assert.throws(
          () =>
            createAuctionAdministrationService({
              leagueAuthorization: {
                requireCommissioner() {},
              },
              repository: {
                findReplay() {},
                administer() {},
              },
            }),
          /clock/i
        );
      }
    );

    test(
      "maps only expected commissioner denial to the safe auction-administration authorization code",
      () => {
        const leagueDenial = new Error(
          "sensitive league authorization detail"
        );
        leagueDenial.code =
          "LEAGUE_COMMISSIONER_REQUIRED";
        const deniedHarness = createHarness({
          authorize() {
            throw leagueDenial;
          },
        });

        assert.throws(
          () =>
            deniedHarness.service.cancelAuction(
              methodOptions(
                "cancel_auction"
              )
            ),
          (error) =>
            error !== leagueDenial &&
            error.code ===
              "AUCTION_ADMINISTRATION_AUTHORIZATION_DENIED" &&
            error.message ===
              "Current auction-administration authority is required."
        );
        assert.equal(
          deniedHarness.replayProbeCalls.length,
          0
        );
        assert.equal(
          deniedHarness.clockCalls.length,
          0
        );
        assert.equal(
          deniedHarness.repositoryCalls.length,
          0
        );

        const unexpected = new Error(
          "authorization dependency failed"
        );
        const unexpectedHarness = createHarness({
          authorize() {
            throw unexpected;
          },
        });
        assert.throws(
          () =>
            unexpectedHarness.service.cancelAuction(
              methodOptions(
                "cancel_auction"
              )
            ),
          (error) => error === unexpected
        );
        assert.equal(
          unexpectedHarness.replayProbeCalls.length,
          0
        );
        assert.equal(
          unexpectedHarness.clockCalls.length,
          0
        );
        assert.equal(
          unexpectedHarness.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "maps T-080 through T-083 to the exact policy action, precondition, confirmation, actor, clock, and idempotency command",
      () => {
        const harness = createHarness();
        const actions = [
          "edit_bid",
          "remove_bid",
          "cancel_auction",
          "request_resolution",
        ];
        const responses = actions.map(
          (action, index) =>
            invoke(
              harness.service,
              action,
              methodOptions(action, {
                expectedVersion:
                  index + 7,
              })
            )
        );

        assert.deepEqual(
          responses.map(
            ({ httpStatus }) =>
              httpStatus
          ),
          [200, 200, 200, 202]
        );
        assert.equal(
          responses.every(
            (response) =>
              Object.isFrozen(response) &&
              Object.isFrozen(
                response.evidence
              ) &&
              Object.isFrozen(
                response.data
              )
          ),
          true
        );
        assert.deepEqual(
          harness.authorizationCalls,
          actions.map(() => ({
            authenticated: AUTHENTICATED,
            leagueId: IDS.league,
          }))
        );
        assert.equal(
          harness.clockCalls.length,
          4
        );
        const expectedRepositoryRequests =
          actions.map(
            (action, index) => ({
              leagueId: IDS.league,
              auctionId: IDS.auction,
              bidId:
                action === "edit_bid" ||
                action === "remove_bid"
                  ? IDS.bid
                  : null,
              action,
              body:
                action === "edit_bid"
                  ? {
                      ...bodyFor(action),
                      totalValueCents: 600,
                    }
                  : bodyFor(action),
              preconditionVersion:
                index + 7,
              actorUserId:
                IDS.commissionerUser,
              actorMembershipId:
                IDS.commissionerMembership,
              idempotencyKey:
                `service-${action}`,
            })
          );
        assert.deepEqual(
          harness.replayProbeCalls,
          expectedRepositoryRequests
        );
        assert.deepEqual(
          harness.repositoryCalls,
          expectedRepositoryRequests.map(
            (request) => ({
              ...request,
              occurredAtMs: NOW_MS,
              idempotencyExpiresAtMs:
                NOW_MS +
                AUCTION_ADMINISTRATION_IDEMPOTENCY_LIFETIME_MS,
            })
          )
        );
      }
    );

    test(
      "preserves inherited member-platform-administrator identity while the repository independently derives the actual authority",
      () => {
        const harness = createHarness({
          actorAuthority:
            "platform_administrator",
        });
        const result =
          harness.service.removeBid(
            methodOptions("remove_bid")
          );

        assert.equal(
          result.actorAuthority,
          "platform_administrator_as_commissioner"
        );
        assert.equal(
          harness.repositoryCalls[0]
            .actorUserId,
          IDS.administratorUser
        );
        assert.equal(
          harness.repositoryCalls[0]
            .actorMembershipId,
          IDS.administratorMembership
        );
        assert.equal(
          Object.hasOwn(
            harness.repositoryCalls[0],
            "actorAuthority"
          ),
          false
        );
      }
    );

    test(
      "retains the original persisted actor authority on replay after the same actor's current administration role changes",
      () => {
        const harness = createHarness({
          actorAuthority:
            "platform_administrator",
          findReplay(command) {
            return resultFor({
              ...command,
              occurredAtMs: NOW_MS,
            }, {
              actorAuthority:
                "commissioner",
              replayed: true,
            });
          },
        });
        const replayed =
          harness.service.editBid(
            methodOptions("edit_bid")
          );

        assert.equal(
          replayed.replayed,
          true
        );
        assert.equal(
          replayed.actorAuthority,
          "commissioner"
        );
        assert.equal(
          harness.selectedAuthority
            .authority,
          "platform_administrator"
        );
        assert.equal(
          harness.clockCalls.length,
          0
        );
        assert.equal(
          harness.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "replays the stored status and body after later cancellation or correction without clock, ID, or mutable-state work",
      () => {
        let mutableStateReads = 0;
        let generatedIds = 0;
        const harness = createHarness({
          nowMs() {
            throw new Error(
              "replay must not sample the clock"
            );
          },
          findReplay(command) {
            return resultFor(
              {
                ...command,
                occurredAtMs: DUE_AT_MS,
              },
              {
                replayed: true,
                data: dataFor(command, {
                  acceptedAtMs: DUE_AT_MS,
                }),
              }
            );
          },
          administer() {
            mutableStateReads += 1;
            generatedIds += 1;
            throw new Error(
              "replay must not enter fresh administration"
            );
          },
        });

        const replayed =
          harness.service.requestResolution(
            methodOptions(
              "request_resolution"
            )
          );

        assert.equal(replayed.replayed, true);
        assert.equal(replayed.httpStatus, 202);
        assert.equal(
          replayed.data.status,
          "pending"
        );
        assert.equal(
          replayed.data.acceptedAtMs,
          DUE_AT_MS
        );
        assert.equal(
          replayed.data.operationId,
          IDS.job
        );
        assert.equal(
          harness.authorizationCalls.length,
          1
        );
        assert.equal(
          harness.replayProbeCalls.length,
          1
        );
        assert.equal(
          harness.clockCalls.length,
          0
        );
        assert.equal(
          harness.repositoryCalls.length,
          0
        );
        assert.equal(mutableStateReads, 0);
        assert.equal(generatedIds, 0);
      }
    );

    test(
      "requires current administration authority before an exact replay probe",
      () => {
        const denied =
          new AuctionAdministrationRepositoryError(
            AUCTION_ADMINISTRATION_REPOSITORY_CODES
              .authorizationDenied,
            "Current authority was revoked."
          );
        const harness = createHarness({
          authorize() {
            throw denied;
          },
          nowMs() {
            throw new Error(
              "denied replay must not sample the clock"
            );
          },
          findReplay() {
            throw new Error(
              "denied replay must not read stored results"
            );
          },
          administer() {
            throw new Error(
              "denied replay must not administer"
            );
          },
        });

        assert.throws(
          () =>
            harness.service.editBid(
              methodOptions("edit_bid")
            ),
          (error) => error === denied
        );
        assert.equal(
          harness.authorizationCalls.length,
          1
        );
        assert.equal(
          harness.replayProbeCalls.length,
          0
        );
        assert.equal(
          harness.clockCalls.length,
          0
        );
        assert.equal(
          harness.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "rejects malformed bodies, confirmations, versions, identifiers, and idempotency keys before authority, clock, or persistence",
      () => {
        const harness = createHarness();
        const cases = [
          () =>
            harness.service.editBid(
              methodOptions("edit_bid", {
                input: {
                  ...bodyFor("edit_bid"),
                  hiddenValue: 1,
                },
              })
            ),
          () =>
            harness.service.removeBid(
              methodOptions("remove_bid", {
                input: {
                  confirmation:
                    "REMOVE MY BID",
                },
              })
            ),
          () =>
            harness.service.cancelAuction(
              methodOptions(
                "cancel_auction",
                {
                  expectedVersion: 0,
                }
              )
            ),
          () =>
            harness.service.requestResolution({
              ...methodOptions(
                "request_resolution"
              ),
              auctionId: "not-an-id",
            }),
          () =>
            harness.service.editBid(
              methodOptions("edit_bid", {
                idempotencyKey:
                  " padded-key ",
              })
            ),
        ];
        for (const invokeInvalid of cases) {
          assert.throws(
            invokeInvalid,
            (error) =>
              error instanceof
                AuctionAdministrationPolicyError &&
              error.code ===
                AUCTION_ADMINISTRATION_CODES
                  .requestInvalid
          );
        }
        assert.equal(
          harness.authorizationCalls.length,
          0
        );
        assert.equal(
          harness.clockCalls.length,
          0
        );
        assert.equal(
          harness.repositoryCalls.length,
          0
        );
        assert.equal(
          harness.replayProbeCalls.length,
          0
        );
      }
    );

    test(
      "uses server time for a due-only T-083 durable occurrence request and returns the stored descriptor on replay without resolving inline",
      () => {
        let currentNow = DUE_AT_MS - 1;
        let stored = null;
        let successfulWrites = 0;
        const harness = createHarness({
          nowMs: () => currentNow,
          findReplay() {
            return stored
              ? {
                  ...stored,
                  replayed: true,
                }
              : null;
          },
          administer(command) {
            if (
              command.occurredAtMs <
              DUE_AT_MS
            ) {
              throw new AuctionAdministrationRepositoryError(
                AUCTION_ADMINISTRATION_REPOSITORY_CODES
                  .notDue,
                "The auction is not due."
              );
            }
            successfulWrites += 1;
            stored = resultFor(command, {
              data: dataFor(command, {
                acceptedAtMs:
                  command.occurredAtMs,
              }),
            });
            return stored;
          },
        });
        const options = methodOptions(
          "request_resolution"
        );

        assert.throws(
          () =>
            harness.service
              .requestResolution(options),
          (error) =>
            error instanceof
              AuctionAdministrationRepositoryError &&
            error.code ===
              AUCTION_ADMINISTRATION_REPOSITORY_CODES
                .notDue
        );
        assert.equal(successfulWrites, 0);

        currentNow = DUE_AT_MS;
        const accepted =
          harness.service.requestResolution(
            options
          );
        assert.equal(
          accepted.httpStatus,
          202
        );
        assert.equal(
          accepted.data.status,
          "pending"
        );
        assert.equal(
          accepted.data.operationId,
          IDS.job
        );
        assert.equal(
          accepted.evidence.jobRunId,
          IDS.job
        );
        assert.equal(
          accepted.data.occurrenceKey,
          `auction:${IDS.auction}:${DUE_AT_MS}`
        );

        currentNow = DUE_AT_MS + 5_000;
        const replayed =
          harness.service.requestResolution(
            options
          );
        assert.equal(replayed.replayed, true);
        assert.deepEqual(
          replayed.data,
          accepted.data
        );
        assert.equal(
          replayed.data.acceptedAtMs,
          DUE_AT_MS
        );
        assert.equal(successfulWrites, 1);
        assert.equal(
          harness.authorizationCalls.length,
          3
        );
        assert.equal(
          harness.repositoryCalls.length,
          2
        );
        assert.equal(
          harness.replayProbeCalls.length,
          3
        );
        assert.equal(
          harness.clockCalls.length,
          2
        );
        assert.deepEqual(
          Object.keys(harness.service).sort(),
          [
            "cancelAuction",
            "editBid",
            "removeBid",
            "requestResolution",
          ]
        );
        assert.equal(
          "resolveDue" in harness.service,
          false
        );
      }
    );

    test(
      "retains the atomic transaction replay fallback when a request completes after the read-only probe",
      () => {
        const harness = createHarness({
          findReplay() {
            return null;
          },
          administer(command) {
            return resultFor(command, {
              replayed: true,
            });
          },
        });

        const replayed =
          harness.service.editBid(
            methodOptions("edit_bid")
          );

        assert.equal(replayed.replayed, true);
        assert.equal(
          harness.authorizationCalls.length,
          1
        );
        assert.equal(
          harness.replayProbeCalls.length,
          1
        );
        assert.equal(
          harness.clockCalls.length,
          1
        );
        assert.equal(
          harness.repositoryCalls.length,
          1
        );
      }
    );

    test(
      "accepts context-bound T-080 and T-081 results while exposing no manager-withdrawal command",
      () => {
        for (const sourceKind of [
          "fad_open_rapid",
          "fad_restricted",
        ]) {
          for (const action of [
            "edit_bid",
            "remove_bid",
          ]) {
            const harness = createHarness({
              administer(command) {
                return resultFor(command, {
                  data: dataFor(command, {
                    sourceKind,
                  }),
                });
              },
            });
            const result = invoke(
              harness.service,
              action,
              methodOptions(action)
            );
            const auction = action === "edit_bid"
              ? result.data
              : result.data.auction;
            assert.equal(
              auction.sourceKind,
              sourceKind
            );
            if (
              action === "remove_bid" &&
              sourceKind === "fad_restricted"
            ) {
              assert.equal(
                result.data
                  .restrictedParticipantStatus,
                "removed"
              );
              assert.equal(
                result.data.fadAllocationVersion,
                1
              );
            }
            assert.equal(
              harness.repositoryCalls.length,
              1
            );
            assert.equal(
              "withdrawBid" in harness.service,
              false
            );
            assert.equal(
              "withdrawMine" in harness.service,
              false
            );
          }
        }
      }
    );

    test(
      "accepts the context-bound restricted T-082 cancellation result",
      () => {
        const expected = restrictedCancellationData();
        const harness = createHarness({
          administer(command) {
            return resultFor(command, {
              data: expected,
            });
          },
        });

        const result = harness.service.cancelAuction(
          methodOptions("cancel_auction")
        );

        assert.deepEqual(result.data, expected);
        assert.equal(
          result.data.auction.status,
          "correction_required"
        );
        assert.equal(
          result.data.fadAllocation.status,
          "correction_required"
        );
        assert.equal(
          result.data.recoveryId,
          IDS.recovery
        );
        assert.equal(
          harness.repositoryCalls.length,
          1
        );
      }
    );

    test(
      "rejects malformed restricted T-082 cancellation context pairings",
      () => {
        const missingAllocation =
          restrictedCancellationData();
        delete missingAllocation.fadAllocation;
        const missingRecovery =
          restrictedCancellationData();
        delete missingRecovery.recoveryId;
        const cases = [
          {
            label: "auction status",
            data: restrictedCancellationData({
              auction: {
                sourceKind: "fad_restricted",
                status: "cancelled",
                result: {
                  recoveryId: IDS.recovery,
                },
              },
            }),
          },
          {
            label: "missing allocation",
            data: missingAllocation,
          },
          {
            label: "allocation status",
            data: restrictedCancellationData({
              fadAllocation: {
                allocationId: IDS.allocation,
                status: "restricted_active",
                recoveryStatus: null,
              },
            }),
          },
          {
            label: "missing recovery",
            data: missingRecovery,
          },
          {
            label: "recovery identity",
            data: restrictedCancellationData({
              recoveryId: "not-a-uuid",
            }),
          },
          {
            label: "nested recovery identity",
            data: restrictedCancellationData({
              auction: {
                sourceKind: "fad_restricted",
                status: "correction_required",
                result: {
                  recoveryId: uuid(14),
                },
              },
            }),
          },
        ];

        for (const scenario of cases) {
          const harness = createHarness({
            administer(command) {
              return resultFor(command, {
                data: scenario.data,
              });
            },
          });
          assert.throws(
            () =>
              harness.service.cancelAuction(
                methodOptions("cancel_auction")
              ),
            (error) =>
              error instanceof
                AuctionAdministrationPolicyError &&
              error.code ===
                AUCTION_ADMINISTRATION_CODES
                  .resultInvalid &&
              error.reasonCode ===
                "service_cancellation_context_invalid",
            scenario.label
          );
          assert.equal(
            harness.repositoryCalls.length,
            1,
            scenario.label
          );
        }
      }
    );

    test(
      "accepts the context-bound failed open-rapid T-082 cancellation result",
      () => {
        const expected = openRapidCancellationData();
        const harness = createHarness({
          administer(command) {
            return resultFor(command, {
              data: expected,
            });
          },
        });

        const result = harness.service.cancelAuction(
          methodOptions("cancel_auction")
        );

        assert.deepEqual(result.data, expected);
        assert.equal(
          result.data.auction.status,
          "cancelled"
        );
        assert.equal(result.data.fadAllocation, null);
        assert.equal(
          result.data.auction.result.recoveryId,
          result.data.recoveryId
        );
        assert.equal(
          harness.repositoryCalls.length,
          1
        );
      }
    );

    test(
      "rejects malformed failed open-rapid T-082 cancellation context pairings",
      () => {
        const missingAllocation =
          openRapidCancellationData();
        delete missingAllocation.fadAllocation;
        const missingRecovery =
          openRapidCancellationData();
        delete missingRecovery.recoveryId;
        const cases = [
          {
            label: "auction status",
            data: openRapidCancellationData({
              auction: {
                sourceKind: "fad_open_rapid",
                status: "correction_required",
                result: {
                  recoveryId: IDS.recovery,
                },
              },
            }),
          },
          {
            label: "missing allocation",
            data: missingAllocation,
          },
          {
            label: "allocation must be null",
            data: openRapidCancellationData({
              fadAllocation: {},
            }),
          },
          {
            label: "missing recovery",
            data: missingRecovery,
          },
          {
            label: "recovery identity",
            data: openRapidCancellationData({
              recoveryId: "not-a-uuid",
            }),
          },
          {
            label: "missing nested recovery",
            data: openRapidCancellationData({
              auction: {
                sourceKind: "fad_open_rapid",
                status: "cancelled",
                result: null,
              },
            }),
          },
          {
            label: "nested recovery identity",
            data: openRapidCancellationData({
              auction: {
                sourceKind: "fad_open_rapid",
                status: "cancelled",
                result: {
                  recoveryId: uuid(14),
                },
              },
            }),
          },
        ];

        for (const scenario of cases) {
          const harness = createHarness({
            administer(command) {
              return resultFor(command, {
                data: scenario.data,
              });
            },
          });
          assert.throws(
            () =>
              harness.service.cancelAuction(
                methodOptions("cancel_auction")
              ),
            (error) =>
              error instanceof
                AuctionAdministrationPolicyError &&
              error.code ===
                AUCTION_ADMINISTRATION_CODES
                  .resultInvalid &&
              error.reasonCode ===
                "service_cancellation_context_invalid",
            scenario.label
          );
          assert.equal(
            harness.repositoryCalls.length,
            1,
            scenario.label
          );
        }
      }
    );

    test(
      "fails closed when persistence returns mismatched authority, malformed FAD context data, or a resolution descriptor not bound to its job",
      () => {
        const cases = [
          {
            action: "edit_bid",
            result(command) {
              return resultFor(command, {
                actorAuthority:
                  "platform_administrator_as_commissioner",
              });
            },
          },
          {
            action: "remove_bid",
            result(command) {
              return resultFor(command, {
                data: {
                  ...dataFor(command, {
                    sourceKind: "fad_restricted",
                  }),
                  restrictedParticipantStatus:
                    "active",
                },
              });
            },
          },
          {
            action:
              "request_resolution",
            result(command) {
              return resultFor(command, {
                data: dataFor(command, {
                  operationId: uuid(90),
                }),
              });
            },
          },
        ];
        for (const scenario of cases) {
          const harness = createHarness({
            administer(command) {
              return scenario.result(
                command
              );
            },
          });
          assert.throws(
            () =>
              invoke(
                harness.service,
                scenario.action,
                methodOptions(
                  scenario.action
                )
              ),
            (error) =>
              error instanceof
                AuctionAdministrationPolicyError &&
              error.code ===
                AUCTION_ADMINISTRATION_CODES
                  .resultInvalid
          );
        }
      }
    );

    test(
      "rejects an unsafe server clock after current authority but before persistence",
      () => {
        const harness = createHarness({
          nowMs: Number.MAX_SAFE_INTEGER,
        });
        assert.throws(
          () =>
            harness.service.cancelAuction(
              methodOptions(
                "cancel_auction"
              )
            ),
          /safe UTC timestamp/i
        );
        assert.equal(
          harness.authorizationCalls.length,
          1
        );
        assert.equal(
          harness.repositoryCalls.length,
          0
        );
        assert.equal(
          harness.replayProbeCalls.length,
          1
        );
      }
    );
  }
);
