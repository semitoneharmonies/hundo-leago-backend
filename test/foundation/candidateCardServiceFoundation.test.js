"use strict";

const assert = require("node:assert/strict");
const {
  describe,
  test,
} = require("node:test");

const {
  CANDIDATE_CARD_SLOT_KEYS,
} = require(
  "../../src/domain/freeAgentDraft/candidateCardPolicy"
);
const {
  encodeCandidateEligiblePlayerCursor,
  normalizeCandidateEligiblePlayerQuery,
} = require(
  "../../src/domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);
const {
  CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
  CandidateCardNotFoundError,
  createCandidateCardService,
} = require(
  "../../src/application/services/freeAgentDraft/createCandidateCardService"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  fad: uuid(3),
  team: uuid(4),
  card: uuid(5),
  user: uuid(6),
  membership: uuid(7),
  assignment: uuid(8),
});

function capability(
  allowed,
  reasonCode = null
) {
  return {
    allowed,
    reasonCode,
  };
}

function emptySlot(slotKey) {
  return {
    slotKey,
    slotGroup: slotKey[0],
    required: slotKey[0] !== "B",
    occupantKind: "empty",
    entryId: null,
    entryVersion: null,
    player: null,
    authoritativeRosterCategory: null,
    locked: false,
    totalValueCents: null,
    termYears: null,
    aavCents: null,
    remainingYears: null,
    validation: {
      status: "valid",
      codes: [],
    },
    outcome: null,
    lastEditedAtMs: null,
    lastEditedBy: null,
    capabilities: {
      addCandidate: capability(true),
      editCandidate: capability(
        false,
        "ENTRY_NOT_EDITABLE"
      ),
      moveCandidate: capability(
        false,
        "ENTRY_NOT_EDITABLE"
      ),
      moveCarryover: capability(
        false,
        "ENTRY_NOT_EDITABLE"
      ),
      removeCandidate: capability(
        false,
        "ENTRY_NOT_EDITABLE"
      ),
    },
  };
}

function privateCard(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    teamId: IDS.team,
    cardId: IDS.card,
    cardVersion: 1,
    phase: "cards_open",
    visibilityMode: "private_editable",
    accessReason: "team_manager",
    authorizationEvidence: {
      kind: "manager_assignment",
      id: IDS.assignment,
    },
    lifecycleStatus: "open",
    completeness: {
      code: "incomplete",
      filledMandatoryCount: 0,
      missingMandatoryCount: 18,
      filledBenchCount: 0,
      emptyBenchCount: 4,
      blockingValidationCount: 0,
      structuralConflictCount: 0,
      carriedRosterStructuralConflictCount:
        0,
    },
    capProjection: {
      capLimitCents: 10_000,
      carriedActivePlayerAmountCents: 0,
      retentionObligationCents: 0,
      buyoutPenaltyCents: 0,
      carriedCapUsageCents: 0,
      proposedCandidateAavCents: 0,
      maximumPossibleCapCents: 0,
      maximumCapSpaceCents: 10_000,
    },
    capStatus: "compliant",
    allocationEligibility: "eligible",
    allocationExclusionReason: null,
    slots: CANDIDATE_CARD_SLOT_KEYS.map(
      emptySlot
    ),
    conflicts: [],
    helpContext: null,
    commissionerInterventions: [],
    capabilities: {
      editCard: capability(true),
      requestHelp: capability(
        false,
        "PHASE_CLOSED"
      ),
      viewPublishedHistory: capability(
        false,
        "PHASE_CLOSED"
      ),
    },
    ...overrides,
  };
}

function eligiblePlayer(
  {
    playerId = uuid(20),
    fullName = "Alpha Player",
    positionGroup = "F",
    maximumBenchAavCents = null,
  } = {}
) {
  return {
    player: {
      playerId,
      fullName,
      positionGroup,
    },
    effectivePositionGroup:
      positionGroup,
    activeState: "active",
    benchEligible: true,
    eligibilityCode: "eligible",
    contractLimits: {
      allowedTermsYears: [1, 2, 3],
      minimumTotalValueCentsByTerm: {
        1: 100,
        2: 200,
        3: 300,
      },
      maximumBenchAavCents,
    },
  };
}

function eligiblePage(
  overrides = {}
) {
  return {
    data: [eligiblePlayer()],
    page: {
      nextCursor: null,
      hasMore: false,
    },
    ...overrides,
  };
}

function previewCapability() {
  return capability(false, "PREVIEW_ONLY");
}

function previewSlot(slot) {
  return {
    ...slot,
    capabilities: {
      addCandidate: previewCapability(),
      editCandidate: previewCapability(),
      moveCandidate: previewCapability(),
      moveCarryover: previewCapability(),
      removeCandidate: previewCapability(),
    },
  };
}

function revisionPreview(overrides = {}) {
  const action = {
    type: "add",
    slotKey: "F01",
    playerId: uuid(20),
    totalValueCents: 600,
    termYears: 2,
  };
  const slots = CANDIDATE_CARD_SLOT_KEYS.map(
    (slotKey) => previewSlot(emptySlot(slotKey))
  );
  slots[0] = previewSlot({
    ...slots[0],
    occupantKind: "candidate",
    entryId: uuid(30),
    entryVersion: 1,
    player: {
      playerId: action.playerId,
      fullName: "Alpha Player",
      positionGroup: "F",
    },
    totalValueCents: 600,
    termYears: 2,
    aavCents: 300,
    lastEditedAtMs: 123_456,
    lastEditedBy: {
      userId: IDS.user,
      displayName: "Manager",
      authority: "manager",
    },
  });
  const projectedCard = privateCard({
    cardVersion: 2,
    visibilityMode: "private_read_only",
    completeness: {
      ...privateCard().completeness,
      filledMandatoryCount: 1,
      missingMandatoryCount: 17,
    },
    capProjection: {
      ...privateCard().capProjection,
      proposedCandidateAavCents: 300,
      maximumPossibleCapCents: 300,
      maximumCapSpaceCents: 9_700,
    },
    slots,
    capabilities: {
      editCard: previewCapability(),
      requestHelp: previewCapability(),
      viewPublishedHistory:
        previewCapability(),
    },
  });
  return {
    baseCardVersion: 1,
    action,
    projectedCard,
    projectedSlot: slots[0],
    warnings: [],
    ...overrides,
  };
}

function candidateMutationResult(
  mutation,
  overrides = {}
) {
  return {
    card: privateCard({
      cardVersion:
        mutation.expectedCardVersion + 1,
    }),
    revisionId: uuid(31),
    changedEntryId:
      mutation.action.type === "remove"
        ? null
        : mutation.action.type === "add"
          ? uuid(32)
          : mutation.action.entryId,
    ...overrides,
  };
}

function candidateHelpResult(
  command,
  overrides = {}
) {
  const dataOverrides =
    overrides.data || {};
  return {
    httpStatus:
      overrides.httpStatus ?? 201,
    data: {
      helpRequestId: uuid(60),
      leagueId: IDS.league,
      seasonId: IDS.season,
      fadId: IDS.fad,
      cardId: IDS.card,
      teamId: IDS.team,
      status: "active",
      message: command.message,
      requestedByUserId: IDS.user,
      requestedByDisplayName: "Manager",
      requestedAtMs: command.nowMs,
      expiresAtMs: command.nowMs + 10_000,
      version: 1,
      ...dataOverrides,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) =>
          !["httpStatus", "data"].includes(key)
      )
    ),
  };
}

function runtime({
  result = privateCard(),
  eligibleResult = eligiblePage(),
  previewResult = revisionPreview(),
  mutationResult = candidateMutationResult,
  saveResult = candidateMutationResult,
  helpResult = candidateHelpResult,
  nowMs = 123_456,
  secureIds = Array.from(
    { length: 40 },
    (_, index) => uuid(40 + index)
  ),
} = {}) {
  const authorizationCalls = [];
  const repositoryCalls = [];
  const secureRandomCalls = [];
  const leagueAuthorization = {
    requireActiveMembership(
      authenticated,
      leagueId
    ) {
      authorizationCalls.push({
        authenticated,
        leagueId,
      });
      return {
        actorUserId: IDS.user,
        membershipId: IDS.membership,
      };
    },
  };
  const repository = {
    readPrivateCurrent(command) {
      repositoryCalls.push(command);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    readEligiblePlayersCurrent(command) {
      repositoryCalls.push(command);
      if (eligibleResult instanceof Error) {
        throw eligibleResult;
      }
      return eligibleResult;
    },
    previewRevisionCurrent(command) {
      repositoryCalls.push(command);
      if (previewResult instanceof Error) {
        throw previewResult;
      }
      return previewResult;
    },
    mutateCurrent(command) {
      repositoryCalls.push(command);
      if (mutationResult instanceof Error) {
        throw mutationResult;
      }
      return typeof mutationResult ===
        "function"
        ? mutationResult(command)
        : mutationResult;
    },
    saveCurrent(command) {
      repositoryCalls.push(command);
      if (saveResult instanceof Error) {
        throw saveResult;
      }
      return typeof saveResult === "function"
        ? saveResult(command)
        : saveResult;
    },
    requestHelpCurrent(command) {
      repositoryCalls.push(command);
      if (helpResult instanceof Error) {
        throw helpResult;
      }
      return typeof helpResult === "function"
        ? helpResult(command)
        : helpResult;
    },
  };
  const clock = {
    nowMs() {
      return nowMs;
    },
  };
  let secureIdIndex = 0;
  const secureRandom = {
    id() {
      const value =
        secureIds[secureIdIndex];
      secureIdIndex += 1;
      secureRandomCalls.push(value);
      return value;
    },
  };
  return {
    service: createCandidateCardService({
      leagueAuthorization,
      repository,
      clock,
      secureRandom,
    }),
    authorizationCalls,
    repositoryCalls,
    secureRandomCalls,
  };
}

function command(overrides = {}) {
  return {
    authenticated: {
      valid: true,
    },
    leagueId: IDS.league,
    fadId: IDS.fad,
    teamId: IDS.team,
    ...overrides,
  };
}

function eligibleCommand(overrides = {}) {
  return {
    authenticated: {
      valid: true,
    },
    leagueId: IDS.league,
    fadId: IDS.fad,
    teamId: IDS.team,
    query: {
      slotKey: "F01",
    },
    ...overrides,
  };
}

function previewCommand(overrides = {}) {
  return {
    authenticated: {
      valid: true,
    },
    leagueId: IDS.league,
    fadId: IDS.fad,
    teamId: IDS.team,
    action: {
      type: "add",
      slotKey: "F01",
      playerId: uuid(20),
      totalValueCents: 600,
      termYears: 2,
    },
    ...overrides,
  };
}

function addCandidateCommand(overrides = {}) {
  return {
    ...command(),
    slotKey: "F01",
    input: {
      playerId: uuid(20),
      totalValueCents: 600,
      termYears: 2,
    },
    expectedCardVersion: 1,
    idempotencyKey: "candidate-add",
    ...overrides,
  };
}

function editCandidateCommand(
  overrides = {}
) {
  return {
    ...command(),
    entryId: uuid(30),
    input: {
      totalValueCents: 900,
      termYears: 3,
    },
    expectedCardVersion: 1,
    idempotencyKey: "candidate-edit",
    ...overrides,
  };
}

function moveEntryCommand(overrides = {}) {
  return {
    ...command(),
    entryId: uuid(30),
    input: {
      slotKey: "B04",
    },
    expectedCardVersion: 1,
    idempotencyKey: "candidate-move",
    ...overrides,
  };
}

function removeCandidateCommand(
  overrides = {}
) {
  return {
    ...command(),
    entryId: uuid(30),
    expectedCardVersion: 1,
    idempotencyKey: "candidate-remove",
    ...overrides,
  };
}

function requestHelpCommand(overrides = {}) {
  return {
    ...command(),
    input: {},
    idempotencyKey: "candidate-help",
    ...overrides,
  };
}

describe(
  "Candidate Card private-read service",
  () => {
    test(
      "requires exact dependencies",
      () => {
        assert.throws(
          () => createCandidateCardService(),
          /league membership authorization/u
        );
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository: {},
              clock: { nowMs() {} },
            }),
          /canonical Candidate Card repository/u
        );
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository: {
                readPrivateCurrent() {},
              },
              clock: { nowMs() {} },
            }),
          /Candidate eligible-player repository/u
        );
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository: {
                readPrivateCurrent() {},
                readEligiblePlayersCurrent() {},
              },
              clock: { nowMs() {} },
            }),
          /Candidate revision-preview repository/u
        );
        const repository = {
          readPrivateCurrent() {},
          readEligiblePlayersCurrent() {},
          previewRevisionCurrent() {},
        };
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository,
              clock: { nowMs() {} },
            }),
          /Candidate Card mutation repository/u
        );
        repository.mutateCurrent =
          function mutateCurrent() {};
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository,
              clock: { nowMs() {} },
            }),
          /whole-card save repository/u
        );
        repository.saveCurrent =
          function saveCurrent() {};
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository,
              clock: { nowMs() {} },
            }),
          /Candidate Card help repository/u
        );
        repository.requestHelpCurrent =
          function requestHelpCurrent() {};
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository,
              clock: {},
            }),
          /a clock/u
        );
        assert.throws(
          () =>
            createCandidateCardService({
              leagueAuthorization: {
                requireActiveMembership() {},
              },
              repository,
              clock: { nowMs() {} },
            }),
          /secure identifiers/u
        );
      }
    );

    test(
      "validates exact route input before authorization or repository access",
      () => {
        const instance = runtime();
        for (const request of [
          {},
          command({ extra: true }),
          command({ fadId: "not-a-uuid" }),
          null,
        ]) {
          assert.throws(
            () =>
              instance.service.privateCard(
                request
              ),
            (error) =>
              error?.code ===
              "CANDIDATE_CARD_INPUT_INVALID"
          );
        }
        assert.equal(
          instance.authorizationCalls.length,
          0
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "requires active membership and forwards only neutral viewer authority plus server time",
      () => {
        const projection = privateCard();
        const instance = runtime({
          result: projection,
          nowMs: 456_789,
        });
        const authenticated = {
          valid: true,
          opaque: "session",
        };
        const result =
          instance.service.privateCard(
            command({ authenticated })
          );
        assert.equal(result, projection);
        assert.deepEqual(
          instance.authorizationCalls,
          [
            {
              authenticated,
              leagueId: IDS.league,
            },
          ]
        );
        assert.deepEqual(
          instance.repositoryCalls,
          [
            {
              leagueId: IDS.league,
              fadId: IDS.fad,
              teamId: IDS.team,
              viewer: {
                userId: IDS.user,
                membershipId:
                  IDS.membership,
              },
              nowMs: 456_789,
            },
          ]
        );
      }
    );

    test(
      "collapses absent private scope to the stable Candidate Card not-found error",
      () => {
        const instance = runtime({
          result: null,
        });
        assert.throws(
          () =>
            instance.service.privateCard(
              command()
            ),
          (error) =>
            error instanceof
              CandidateCardNotFoundError &&
            error.code ===
              "CANDIDATE_CARD_NOT_FOUND"
        );
      }
    );

    test(
      "preserves authorized repository phase conflicts",
      () => {
        const conflict = new Error(
          "The private Candidate Card is closed."
        );
        conflict.code =
          "REPOSITORY_VERSION_CONFLICT";
        conflict.details = {
          reasonCode: "FAD_PHASE_CONFLICT",
        };
        const instance = runtime({
          result: conflict,
        });
        assert.throws(
          () =>
            instance.service.privateCard(
              command()
            ),
          (error) => error === conflict
        );
      }
    );

    test(
      "fails closed on malformed projections or an unsafe server clock",
      () => {
        const nestedCapabilityLeak =
          privateCard();
        nestedCapabilityLeak.slots[0]
          .capabilities.addCandidate = {
            allowed: true,
            reasonCode: null,
            ownershipId: uuid(99),
          };
        const malformedResults = [
          privateCard({ slots: [] }),
          privateCard({
            capProjection: {
              ...privateCard().capProjection,
              privateLedgerId: uuid(98),
            },
          }),
          privateCard({
            helpContext: {
              helpRequestId: uuid(90),
              status: "active",
              message: null,
              requestedByUserId: IDS.user,
              requestedByDisplayName:
                "Manager",
              requestedAtMs: 1,
              expiresAtMs: 2,
              version: 1,
            },
          }),
          nestedCapabilityLeak,
          privateCard({
            phase: "deadline_processing",
            visibilityMode: "private_editable",
          }),
        ];
        for (const result of malformedResults) {
          const malformed = runtime({ result });
          assert.throws(
            () =>
              malformed.service.privateCard(
                command()
              ),
            /canonical private Candidate Card projection/u
          );
        }
        const unsafeClock = runtime({
          nowMs: -1,
        });
        assert.throws(
          () =>
            unsafeClock.service.privateCard(
              command()
            ),
          /safe UTC timestamp/u
        );
        assert.equal(
          unsafeClock.repositoryCalls.length,
          0
        );
      }
    );
  }
);

describe(
  "Candidate eligible-player service",
  () => {
    test(
      "validates and route-binds the exact query before authorization or repository access",
      () => {
        const instance = runtime();
        for (const request of [
          {},
          eligibleCommand({ extra: true }),
          eligibleCommand({
            query: {},
          }),
          eligibleCommand({
            query: {
              slotKey: "F01",
              cardId: IDS.card,
            },
          }),
          eligibleCommand({
            leagueId: "not-a-uuid",
          }),
          null,
        ]) {
          assert.throws(
            () =>
              instance.service.eligiblePlayers(
                request
              ),
            (error) =>
              [
                "CANDIDATE_CARD_INPUT_INVALID",
                "CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID",
              ].includes(error?.code)
          );
        }
        assert.equal(
          instance.authorizationCalls.length,
          0
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "requires active membership and forwards only canonical query, neutral viewer, and server time",
      () => {
        const projection = eligiblePage();
        const instance = runtime({
          eligibleResult: projection,
          nowMs: 456_789,
        });
        const authenticated = {
          valid: true,
          opaque: "session",
        };
        assert.equal(
          instance.service.eligiblePlayers(
            eligibleCommand({
              authenticated,
              query: {
                slotKey: "F01",
                q: "  ALPHA   ",
                limit: "25",
              },
            })
          ),
          projection
        );
        assert.deepEqual(
          instance.authorizationCalls,
          [
            {
              authenticated,
              leagueId: IDS.league,
            },
          ]
        );
        assert.deepEqual(
          instance.repositoryCalls,
          [
            {
              query: {
                leagueId: IDS.league,
                fadId: IDS.fad,
                teamId: IDS.team,
                slotKey: "F01",
                q: "alpha",
                limit: 25,
                cursor: null,
              },
              viewer: {
                userId: IDS.user,
                membershipId:
                  IDS.membership,
              },
              nowMs: 456_789,
            },
          ]
        );
      }
    );

    test(
      "accepts only a recursively exact ordered page with a cursor bound to its final row",
      () => {
        const normalizedQuery =
          normalizeCandidateEligiblePlayerQuery(
            {
              slotKey: "F01",
              limit: 1,
            },
            {
              leagueId: IDS.league,
              fadId: IDS.fad,
              teamId: IDS.team,
            }
          );
        const page = eligiblePage({
          page: {
            nextCursor:
              encodeCandidateEligiblePlayerCursor(
                normalizedQuery,
                {
                  sortName: "alpha player",
                  playerId: uuid(20),
                }
              ),
            hasMore: true,
          },
        });
        const instance = runtime({
          eligibleResult: page,
        });
        assert.equal(
          instance.service.eligiblePlayers(
            eligibleCommand({
              query: {
                slotKey: "F01",
                limit: 1,
              },
            })
          ),
          page
        );
      }
    );

    test(
      "collapses absent private scope and preserves authorized lifecycle conflicts",
      () => {
        const missing = runtime({
          eligibleResult: null,
        });
        assert.throws(
          () =>
            missing.service.eligiblePlayers(
              eligibleCommand()
            ),
          (error) =>
            error instanceof
              CandidateCardNotFoundError &&
            error.code ===
              "CANDIDATE_CARD_NOT_FOUND"
        );
        const conflict = new Error(
          "The Candidate deadline passed."
        );
        conflict.code =
          "REPOSITORY_VERSION_CONFLICT";
        conflict.details = {
          reasonCode: "FAD_DEADLINE_PASSED",
        };
        const closed = runtime({
          eligibleResult: conflict,
        });
        assert.throws(
          () =>
            closed.service.eligiblePlayers(
              eligibleCommand()
            ),
          (error) => error === conflict
        );
      }
    );

    test(
      "fails closed on nested leaks, malformed limits, ordering drift, and invalid continuation evidence",
      () => {
        const leaked = eligiblePlayer();
        leaked.player.competingOfferCents = 900;
        const wrongLimits = eligiblePlayer();
        wrongLimits.contractLimits = {
          ...wrongLimits.contractLimits,
          maximumBenchAavCents: 400,
        };
        const reverseOrder = [
          eligiblePlayer({
            playerId: uuid(21),
            fullName: "Beta Player",
          }),
          eligiblePlayer({
            playerId: uuid(22),
            fullName: "Alpha Player",
          }),
        ];
        const malformedResults = [
          eligiblePage({ extra: true }),
          eligiblePage({ data: [leaked] }),
          eligiblePage({ data: [wrongLimits] }),
          eligiblePage({ data: reverseOrder }),
          eligiblePage({
            data: [],
            page: {
              nextCursor: "invalid",
              hasMore: true,
            },
          }),
        ];
        for (const eligibleResult of malformedResults) {
          const malformed = runtime({
            eligibleResult,
          });
          assert.throws(
            () =>
              malformed.service.eligiblePlayers(
                eligibleCommand()
              ),
            /canonical Candidate eligible-player page/u
          );
        }
        const unsafeClock = runtime({
          nowMs: -1,
        });
        assert.throws(
          () =>
            unsafeClock.service.eligiblePlayers(
              eligibleCommand()
            ),
          /safe UTC timestamp/u
        );
        assert.equal(
          unsafeClock.repositoryCalls.length,
          0
        );
      }
    );
  }
);

describe(
  "Candidate Card revision-preview service",
  () => {
    test(
      "validates the exact route and discriminated action before authorization or repository access",
      () => {
        const instance = runtime();
        const symbolicAction = {
          type: "remove",
          entryId: uuid(30),
        };
        symbolicAction[Symbol("hidden")] = true;
        for (const request of [
          {},
          previewCommand({ extra: true }),
          previewCommand({
            leagueId: "not-a-uuid",
          }),
          previewCommand({
            action: {
              type: "add",
              entryId: uuid(30),
              slotKey: "F01",
              playerId: uuid(20),
              totalValueCents: 600,
              termYears: 2,
            },
          }),
          previewCommand({
            action: symbolicAction,
          }),
          previewCommand({
            action: {
              type: "edit",
              entryId: uuid(30),
              totalValueCents: 199,
              termYears: 2,
            },
          }),
          null,
        ]) {
          assert.throws(
            () =>
              instance.service.previewRevision(
                request
              ),
            (error) =>
              [
                "CANDIDATE_CARD_INPUT_INVALID",
                "CANDIDATE_CONTRACT_INVALID",
              ].includes(error?.code)
          );
        }
        assert.equal(
          instance.authorizationCalls.length,
          0
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
      }
    );

    test(
      "requires active membership and forwards only normalized action, neutral viewer, and server time",
      () => {
        const projection = revisionPreview();
        const instance = runtime({
          previewResult: projection,
          nowMs: 456_789,
        });
        const authenticated = {
          valid: true,
          opaque: "session",
        };
        const request = previewCommand({
          authenticated,
        });
        assert.equal(
          instance.service.previewRevision(
            request
          ),
          projection
        );
        assert.deepEqual(
          instance.authorizationCalls,
          [
            {
              authenticated,
              leagueId: IDS.league,
            },
          ]
        );
        assert.deepEqual(
          instance.repositoryCalls,
          [
            {
              leagueId: IDS.league,
              fadId: IDS.fad,
              teamId: IDS.team,
              viewer: {
                userId: IDS.user,
                membershipId:
                  IDS.membership,
              },
              nowMs: 456_789,
              action: request.action,
            },
          ]
        );
      }
    );

    test(
      "collapses absent private scope and preserves authorized lifecycle or business failures",
      () => {
        const missing = runtime({
          previewResult: null,
        });
        assert.throws(
          () =>
            missing.service.previewRevision(
              previewCommand()
            ),
          (error) =>
            error instanceof
              CandidateCardNotFoundError &&
            error.code ===
              "CANDIDATE_CARD_NOT_FOUND"
        );
        const conflict = new Error(
          "The Candidate deadline passed."
        );
        conflict.code =
          "REPOSITORY_VERSION_CONFLICT";
        conflict.details = {
          reasonCode: "FAD_DEADLINE_PASSED",
        };
        const closed = runtime({
          previewResult: conflict,
        });
        assert.throws(
          () =>
            closed.service.previewRevision(
              previewCommand()
            ),
          (error) => error === conflict
        );
      }
    );

    test(
      "accepts only an exact route-bound next-version preview with disabled capabilities and canonical diagnostics",
      () => {
        const overCap = revisionPreview();
        overCap.projectedCard.capStatus =
          "over_cap";
        overCap.projectedCard
          .allocationEligibility =
          "excluded_over_cap";
        overCap.projectedCard
          .allocationExclusionReason =
          "maximum_possible_cap_exceeded";
        overCap.projectedCard.capProjection = {
          ...overCap.projectedCard
            .capProjection,
          capLimitCents: 200,
          maximumCapSpaceCents: -100,
        };
        overCap.warnings = [
          {
            code: "CANDIDATE_CARD_OVER_CAP",
            message:
              "The projected Candidate Card exceeds the salary cap.",
            resourceId: IDS.card,
          },
        ];
        const valid = runtime({
          previewResult: overCap,
        });
        assert.equal(
          valid.service.previewRevision(
            previewCommand()
          ),
          overCap
        );

        const capabilityLeak =
          revisionPreview();
        capabilityLeak.projectedCard.slots[0]
          .capabilities.addCandidate =
          capability(true);
        const slotMismatch = revisionPreview();
        slotMismatch.projectedSlot =
          slotMismatch.projectedCard.slots[1];
        const actionMismatch = revisionPreview({
          action: {
            ...revisionPreview().action,
            totalValueCents: 900,
          },
        });
        const warningMissing = revisionPreview();
        warningMissing.projectedCard.capStatus =
          "over_cap";
        warningMissing.projectedCard
          .allocationEligibility =
          "excluded_over_cap";
        warningMissing.projectedCard
          .allocationExclusionReason =
          "maximum_possible_cap_exceeded";
        const nestedLeak = revisionPreview();
        nestedLeak.projectedCard.slots[0]
          .privateContractId = uuid(99);
        const malformedResults = [
          revisionPreview({ extra: true }),
          revisionPreview({
            baseCardVersion: 0,
          }),
          revisionPreview({
            projectedCard: privateCard({
              ...revisionPreview()
                .projectedCard,
              cardVersion: 1,
            }),
          }),
          revisionPreview({
            projectedCard: {
              ...revisionPreview()
                .projectedCard,
              teamId: uuid(98),
            },
          }),
          capabilityLeak,
          slotMismatch,
          actionMismatch,
          warningMissing,
          nestedLeak,
        ];
        for (const previewResult of malformedResults) {
          const malformed = runtime({
            previewResult,
          });
          assert.throws(
            () =>
              malformed.service.previewRevision(
                previewCommand()
              ),
            /canonical (?:private )?Candidate Card/u
          );
        }
      }
    );

    test(
      "rejects an unsafe server clock before the repository call",
      () => {
        const instance = runtime({ nowMs: -1 });
        assert.throws(
          () =>
            instance.service.previewRevision(
              previewCommand()
            ),
          /safe UTC timestamp/u
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
      }
    );
  }
);

describe(
  "Candidate Card mutation service",
  () => {
    test(
      "validates exact route and body shapes plus mutation policy limits before authorization",
      () => {
        const symbolic =
          addCandidateCommand();
        symbolic[Symbol("hidden")] = true;
        const nonenumerable =
          removeCandidateCommand();
        Object.defineProperty(
          nonenumerable,
          "hidden",
          { value: true }
        );
        const tooLongKey =
          "\u{1f3d2}".repeat(129);
        const cases = [
          [
            "addCandidate",
            addCandidateCommand({
              extra: true,
            }),
          ],
          ["addCandidate", symbolic],
          [
            "addCandidate",
            addCandidateCommand({
              input: {
                playerId: uuid(20),
                totalValueCents: 600,
                termYears: 2,
                hidden: true,
              },
            }),
          ],
          [
            "editCandidate",
            editCandidateCommand({
              input: {
                totalValueCents: 900,
              },
            }),
          ],
          [
            "moveEntry",
            moveEntryCommand({
              input: {
                slotKey: "B04",
                extra: true,
              },
            }),
          ],
          ["removeCandidate", nonenumerable],
          [
            "removeCandidate",
            removeCandidateCommand({
              input: {},
            }),
          ],
          [
            "addCandidate",
            addCandidateCommand({
              expectedCardVersion:
                Number.MAX_SAFE_INTEGER,
            }),
          ],
          [
            "addCandidate",
            addCandidateCommand({
              idempotencyKey: tooLongKey,
            }),
          ],
        ];
        const instance = runtime();
        for (const [method, request] of cases) {
          assert.throws(
            () =>
              instance.service[method](
                request
              ),
            (error) =>
              error?.code ===
              "CANDIDATE_CARD_INPUT_INVALID"
          );
        }
        assert.throws(
          () =>
            instance.service.addCandidate(
              addCandidateCommand({
                slotKey: "B01",
                input: {
                  playerId: uuid(20),
                  totalValueCents: 401,
                  termYears: 1,
                },
              })
            ),
          (error) =>
            error?.code ===
            "CANDIDATE_BENCH_AAV_EXCEEDED"
        );
        assert.equal(
          instance.authorizationCalls.length,
          0
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
        assert.equal(
          instance.secureRandomCalls.length,
          0
        );
      }
    );

    test(
      "requires active membership and sends exact neutral route-scoped commands for all four operations",
      () => {
        assert.equal(
          CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
          86_400_000
        );
        const authenticated = {
          valid: true,
          opaque: "session",
        };
        const cases = [
          {
            method: "addCandidate",
            request: addCandidateCommand({
              authenticated,
              expectedCardVersion: 7,
              idempotencyKey:
                "  candidate-add  ",
            }),
            httpStatus: 201,
            clientKey: "candidate-add",
            action: {
              type: "add",
              slotKey: "F01",
              playerId: uuid(20),
              totalValueCents: 600,
              termYears: 2,
              entryId: uuid(42),
            },
            generatedIds: [
              uuid(40),
              uuid(41),
              uuid(42),
            ],
            changedEntryId: uuid(32),
          },
          {
            method: "editCandidate",
            request: editCandidateCommand({
              authenticated,
              expectedCardVersion: 7,
            }),
            httpStatus: 200,
            clientKey: "candidate-edit",
            action: {
              type: "edit",
              entryId: uuid(30),
              totalValueCents: 900,
              termYears: 3,
            },
            generatedIds: [
              uuid(40),
              uuid(41),
            ],
            changedEntryId: uuid(30),
          },
          {
            method: "moveEntry",
            request: moveEntryCommand({
              authenticated,
              expectedCardVersion: 7,
            }),
            httpStatus: 200,
            clientKey: "candidate-move",
            action: {
              type: "move",
              entryId: uuid(30),
              slotKey: "B04",
            },
            generatedIds: [
              uuid(40),
              uuid(41),
            ],
            changedEntryId: uuid(30),
          },
          {
            method: "removeCandidate",
            request:
              removeCandidateCommand({
                authenticated,
                expectedCardVersion: 7,
              }),
            httpStatus: 200,
            clientKey: "candidate-remove",
            action: {
              type: "remove",
              entryId: uuid(30),
            },
            generatedIds: [
              uuid(40),
              uuid(41),
            ],
            changedEntryId: null,
          },
        ];

        for (const item of cases) {
          const instance = runtime({
            nowMs: 456_789,
          });
          const result =
            instance.service[item.method](
              item.request
            );
          assert.deepEqual(
            Object.keys(result).sort(),
            ["data", "httpStatus"]
          );
          assert.equal(
            Object.isFrozen(result),
            true
          );
          assert.equal(
            Object.isFrozen(result.data),
            true
          );
          assert.equal(
            result.httpStatus,
            item.httpStatus
          );
          assert.deepEqual(result.data, {
            card: privateCard({
              cardVersion: 8,
            }),
            revisionId: uuid(31),
            changedEntryId:
              item.changedEntryId,
          });
          assert.notEqual(
            result.data.revisionId,
            uuid(41)
          );
          assert.deepEqual(
            instance.authorizationCalls,
            [
              {
                authenticated,
                leagueId: IDS.league,
              },
            ]
          );
          assert.deepEqual(
            instance.repositoryCalls,
            [
              {
                leagueId: IDS.league,
                fadId: IDS.fad,
                teamId: IDS.team,
                viewer: {
                  userId: IDS.user,
                  membershipId:
                    IDS.membership,
                },
                expectedCardVersion: 7,
                nowMs: 456_789,
                idempotency: {
                  requestId: uuid(40),
                  clientKey: item.clientKey,
                  expiresAtMs:
                    456_789 +
                    CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
                },
                revisionId: uuid(41),
                action: item.action,
              },
            ]
          );
          assert.deepEqual(
            instance.secureRandomCalls,
            item.generatedIds
          );
        }
      }
    );

    test(
      "accepts exact idempotency keys at the Unicode code-point limit",
      () => {
        const maximumKey =
          "\u{1f3d2}".repeat(128);
        const instance = runtime();
        instance.service.addCandidate(
          addCandidateCommand({
            idempotencyKey: maximumKey,
          })
        );
        assert.equal(
          instance.repositoryCalls[0]
            .idempotency.clientKey,
          maximumKey
        );
        assert.equal(
          [...maximumKey].length,
          128
        );
      }
    );

    test(
      "collapses null mutation scope and preserves repository failures",
      () => {
        const requests = [
          ["addCandidate", addCandidateCommand()],
          [
            "editCandidate",
            editCandidateCommand(),
          ],
          ["moveEntry", moveEntryCommand()],
          [
            "removeCandidate",
            removeCandidateCommand(),
          ],
        ];
        for (const [method, request] of requests) {
          const missing = runtime({
            mutationResult: null,
          });
          assert.throws(
            () =>
              missing.service[method](
                request
              ),
            (error) =>
              error instanceof
                CandidateCardNotFoundError &&
              error.code ===
                "CANDIDATE_CARD_NOT_FOUND"
          );
        }
        const conflict = new Error(
          "The Candidate deadline passed."
        );
        conflict.code =
          "REPOSITORY_VERSION_CONFLICT";
        const closed = runtime({
          mutationResult: conflict,
        });
        assert.throws(
          () =>
            closed.service.editCandidate(
              editCandidateCommand()
            ),
          (error) => error === conflict
        );
      }
    );

    test(
      "fails closed on malformed repository mutation results and changed-entry semantics",
      () => {
        const cases = [
          {
            method: "addCandidate",
            request: addCandidateCommand(),
            result: (mutation) => ({
              ...candidateMutationResult(
                mutation
              ),
              hidden: true,
            }),
          },
          {
            method: "addCandidate",
            request: addCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                {
                  card: privateCard({
                    cardVersion:
                      mutation
                        .expectedCardVersion,
                  }),
                }
              ),
          },
          {
            method: "addCandidate",
            request: addCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                { revisionId: "not-a-uuid" }
              ),
          },
          {
            method: "addCandidate",
            request: addCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                { changedEntryId: null }
              ),
          },
          {
            method: "editCandidate",
            request: editCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                { changedEntryId: uuid(99) }
              ),
          },
          {
            method: "moveEntry",
            request: moveEntryCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                { changedEntryId: uuid(99) }
              ),
          },
          {
            method: "removeCandidate",
            request:
              removeCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                { changedEntryId: uuid(99) }
              ),
          },
          {
            method: "removeCandidate",
            request:
              removeCandidateCommand(),
            result: (mutation) =>
              candidateMutationResult(
                mutation,
                {
                  card: privateCard({
                    cardVersion:
                      mutation
                        .expectedCardVersion +
                      1,
                    slots: [],
                  }),
                }
              ),
          },
        ];
        for (const item of cases) {
          const malformed = runtime({
            mutationResult: item.result,
          });
          assert.throws(
            () =>
              malformed.service[item.method](
                item.request
              ),
            /canonical (?:private )?Candidate Card/u
          );
        }
      }
    );

    test(
      "rejects unsafe mutation time and invalid or duplicate generated identifiers before persistence",
      () => {
        const unsafeClock = runtime({
          nowMs:
            8_640_000_000_000_000 -
            CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS +
            1,
        });
        assert.throws(
          () =>
            unsafeClock.service.addCandidate(
              addCandidateCommand()
            ),
          /overflow-safe UTC timestamp/u
        );
        assert.equal(
          unsafeClock.secureRandomCalls.length,
          0
        );
        assert.equal(
          unsafeClock.repositoryCalls.length,
          0
        );

        for (const secureIds of [
          ["not-a-uuid"],
          [uuid(40), uuid(40)],
        ]) {
          const invalidIds = runtime({
            secureIds,
          });
          assert.throws(
            () =>
              invalidIds.service.addCandidate(
                addCandidateCommand()
              ),
            /unique secure UUIDv4 identifiers/u
          );
          assert.equal(
            invalidIds.repositoryCalls.length,
            0
          );
        }
      }
    );
  }
);

describe(
  "Candidate Card help service",
  () => {
    test(
      "validates the exact route, body, message, and idempotency key before authorization",
      () => {
        const maximumMessage =
          "\u{1f3d2}".repeat(500);
        const maximumKey =
          "\u{1f511}".repeat(128);
        const invalid = [
          requestHelpCommand({ extra: true }),
          requestHelpCommand({
            leagueId: "not-a-uuid",
          }),
          requestHelpCommand({ input: null }),
          requestHelpCommand({ input: [] }),
          requestHelpCommand({
            input: { unknown: true },
          }),
          requestHelpCommand({
            input: { message: 1 },
          }),
          requestHelpCommand({
            input: {
              message: `${maximumMessage}\u{1f3d2}`,
            },
          }),
          requestHelpCommand({
            input: { message: "line one\nline two" },
          }),
          requestHelpCommand({
            idempotencyKey: `${maximumKey}\u{1f511}`,
          }),
          requestHelpCommand({
            idempotencyKey: "unsafe\u2028key",
          }),
        ];
        const instance = runtime();
        for (const request of invalid) {
          assert.throws(
            () => instance.service.requestHelp(request),
            (error) =>
              error?.code ===
              "CANDIDATE_CARD_INPUT_INVALID"
          );
        }
        assert.equal(
          instance.authorizationCalls.length,
          0
        );
        assert.equal(
          instance.repositoryCalls.length,
          0
        );
        assert.equal(
          instance.secureRandomCalls.length,
          0
        );
      }
    );

    test(
      "normalizes the approved body and sends one neutral route-scoped help command",
      () => {
        const authenticated = {
          valid: true,
          opaque: "session",
        };
        const instance = runtime({
          nowMs: 456_789,
        });
        const result = instance.service.requestHelp(
          requestHelpCommand({
            authenticated,
            input: {
              message: "  Please review my card.  ",
            },
            idempotencyKey: "  candidate-help  ",
          })
        );

        assert.deepEqual(result, {
          httpStatus: 201,
          data: {
            helpRequestId: uuid(60),
            leagueId: IDS.league,
            seasonId: IDS.season,
            fadId: IDS.fad,
            cardId: IDS.card,
            teamId: IDS.team,
            status: "active",
            message: "Please review my card.",
            requestedByUserId: IDS.user,
            requestedByDisplayName: "Manager",
            requestedAtMs: 456_789,
            expiresAtMs: 466_789,
            version: 1,
          },
        });
        assert.equal(Object.isFrozen(result), true);
        assert.equal(
          Object.isFrozen(result.data),
          true
        );
        assert.deepEqual(
          instance.authorizationCalls,
          [
            {
              authenticated,
              leagueId: IDS.league,
            },
          ]
        );
        assert.deepEqual(
          instance.repositoryCalls,
          [
            {
              leagueId: IDS.league,
              fadId: IDS.fad,
              teamId: IDS.team,
              viewer: {
                userId: IDS.user,
                membershipId: IDS.membership,
              },
              nowMs: 456_789,
              idempotency: {
                requestId: uuid(40),
                clientKey: "candidate-help",
                expiresAtMs:
                  456_789 +
                  CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
              },
              helpRequestId: uuid(41),
              message: "Please review my card.",
            },
          ]
        );
        assert.deepEqual(
          instance.secureRandomCalls,
          [uuid(40), uuid(41)]
        );
      }
    );

    test(
      "accepts an immutable 200 result for an already-active request without replacing its message",
      () => {
        const originalRequester = uuid(70);
        const instance = runtime({
          nowMs: 456_789,
          helpResult(command) {
            return candidateHelpResult(command, {
              httpStatus: 200,
              data: {
                message: "Original private message.",
                requestedByUserId:
                  originalRequester,
                requestedByDisplayName:
                  "Original Manager",
                requestedAtMs: 123,
                expiresAtMs: 456,
              },
            });
          },
        });
        const result = instance.service.requestHelp(
          requestHelpCommand({
            input: {
              message: "A replacement is ignored.",
            },
          })
        );
        assert.equal(result.httpStatus, 200);
        assert.equal(
          result.data.message,
          "Original private message."
        );
        assert.equal(
          result.data.requestedByUserId,
          originalRequester
        );
      }
    );

    test(
      "collapses absent scope, preserves repository failures, and accepts persisted replay identifiers",
      () => {
        const missing = runtime({
          helpResult: null,
        });
        assert.throws(
          () =>
            missing.service.requestHelp(
              requestHelpCommand()
            ),
          (error) =>
            error instanceof
              CandidateCardNotFoundError &&
            error.code ===
              "CANDIDATE_CARD_NOT_FOUND"
        );

        const conflict = new Error(
          "The help window is closed."
        );
        conflict.code =
          "REPOSITORY_VERSION_CONFLICT";
        const closed = runtime({
          helpResult: conflict,
        });
        assert.throws(
          () =>
            closed.service.requestHelp(
              requestHelpCommand()
            ),
          (error) => error === conflict
        );

        const replay = runtime({
          secureIds: [uuid(80), uuid(81)],
          helpResult(command) {
            return candidateHelpResult(command, {
              data: {
                helpRequestId: uuid(82),
                requestedAtMs: 100,
                expiresAtMs: 200,
              },
            });
          },
        });
        const result = replay.service.requestHelp(
          requestHelpCommand()
        );
        assert.equal(
          result.data.helpRequestId,
          uuid(82)
        );
        assert.deepEqual(
          replay.secureRandomCalls,
          [uuid(80), uuid(81)]
        );
      }
    );

    test(
      "fails closed on malformed help results and unsafe write timing or identifiers",
      () => {
        const malformedResults = [
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { hidden: true }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { httpStatus: 202 }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { data: { leagueId: uuid(99) } }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { data: { status: "expired" } }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { data: { message: " untrimmed " } }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { data: { requestedAtMs: 2, expiresAtMs: 2 } }
          ),
          candidateHelpResult(
            { message: null, nowMs: 1 },
            { data: { version: 2 } }
          ),
        ];
        for (const helpResult of malformedResults) {
          const malformed = runtime({ helpResult });
          assert.throws(
            () =>
              malformed.service.requestHelp(
                requestHelpCommand()
              ),
            /canonical Candidate Card help result/u
          );
        }

        const unsafeClock = runtime({
          nowMs:
            8_640_000_000_000_000 -
            CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS +
            1,
        });
        assert.throws(
          () =>
            unsafeClock.service.requestHelp(
              requestHelpCommand()
            ),
          /overflow-safe UTC timestamp/u
        );
        assert.equal(
          unsafeClock.repositoryCalls.length,
          0
        );

        for (const secureIds of [
          ["not-a-uuid"],
          [uuid(40), uuid(40)],
        ]) {
          const invalidIds = runtime({ secureIds });
          assert.throws(
            () =>
              invalidIds.service.requestHelp(
                requestHelpCommand()
              ),
            /unique secure UUIDv4 identifiers/u
          );
          assert.equal(
            invalidIds.repositoryCalls.length,
            0
          );
        }
      }
    );
  }
);

test("Candidate Card service sends one exact whole-card command and returns canonical sorted change identifiers", () => {
  const input = {
    slots: CANDIDATE_CARD_SLOT_KEYS.map(
      (slotKey, index) => ({
        slotKey,
        candidate: index === 0
          ? {
              playerId: uuid(90),
              totalValueCents: null,
              termYears: 2,
            }
          : null,
      })
    ),
  };
  const context = runtime({
    saveResult(command) {
      return {
        card: privateCard({
          cardVersion:
            command.expectedCardVersion + 1,
        }),
        revisionId: command.revisionId,
        changedEntryIds: [command.entryIds[0]],
      };
    },
  });
  const result = context.service.saveCard({
    authenticated: { valid: true },
    leagueId: IDS.league,
    fadId: IDS.fad,
    teamId: IDS.team,
    input,
    expectedCardVersion: 1,
    idempotencyKey: " whole-save ",
  });
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.data.changedEntryIds, [
    uuid(42),
  ]);
  assert.deepEqual(context.repositoryCalls, [
    {
      leagueId: IDS.league,
      fadId: IDS.fad,
      teamId: IDS.team,
      viewer: {
        userId: IDS.user,
        membershipId: IDS.membership,
      },
      expectedCardVersion: 1,
      nowMs: 123_456,
      idempotency: {
        requestId: uuid(40),
        clientKey: "whole-save",
        expiresAtMs:
          123_456 +
          CANDIDATE_CARD_MUTATION_IDEMPOTENCY_LIFETIME_MS,
      },
      revisionId: uuid(41),
      slots: [
        {
          slotKey: "F01",
          candidate: {
            playerId: uuid(90),
            totalValueCents: null,
            termYears: 2,
          },
        },
        ...CANDIDATE_CARD_SLOT_KEYS.slice(1).map(
          (slotKey) => ({
            slotKey,
            candidate: null,
          })
        ),
      ],
      entryIds: [
        uuid(42),
        ...Array(21).fill(null),
      ],
    },
  ]);
});
