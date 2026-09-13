"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_RECOVERY_ACTIONS,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_HTTP_STATUS,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES,
  FREE_AGENT_DRAFT_RECOVERY_ACTION_REQUEST_DOMAIN,
  FREE_AGENT_DRAFT_RECOVERY_IDEMPOTENCY_KEY_MAXIMUM_SCALARS,
  FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES,
  FREE_AGENT_DRAFT_RECOVERY_REASON_CODES,
  FREE_AGENT_DRAFT_RECOVERY_REASON_MAXIMUM_SCALARS,
  FreeAgentDraftRecoveryPolicyError,
  freeAgentDraftRecoveryActionRequestProjection,
  getFreeAgentDraftRecoveryActionPolicy,
  hashFreeAgentDraftRecoveryAcceptedOperation,
  hashFreeAgentDraftRecoveryActionRequest,
  normalizeFreeAgentDraftRecoveryActionBody,
  projectFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryAcceptedOperation,
  serializeFreeAgentDraftRecoveryActionRequest,
  validateFreeAgentDraftRecoveryAcceptedOperation,
  validateFreeAgentDraftRecoveryIdempotencyKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftRecoveryPolicy"
);
const {
  buildFreeAgentDraftAllocationOccurrenceKey,
  buildFreeAgentDraftCompletionOccurrenceKey,
  buildFreeAgentDraftDeadlineOccurrenceKey,
  buildFreeAgentDraftFallbackActivationOccurrenceKey,
  buildFreeAgentDraftNominationOpenOccurrenceKey,
  buildFreeAgentDraftRestrictedActivationOccurrenceKey,
  buildFreeAgentDraftRolloverOccurrenceKey,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftPolicy"
);
const {
  buildAuctionResolutionOccurrenceKey,
} = require(
  "../../src/domain/auctions/auctionResolutionPolicy"
);

const LEAGUE_ID =
  "11111111-1111-4111-8111-111111111111";
const FAD_ID =
  "22222222-2222-4222-8222-222222222222";
const ALLOCATION_ID =
  "33333333-3333-4333-8333-333333333333";
const QUEUE_ID =
  "44444444-4444-4444-8444-444444444444";
const AUCTION_ID =
  "55555555-5555-4555-8555-555555555555";
const ROLLOVER_ID =
  "66666666-6666-4666-8666-666666666666";
const OPERATION_ID =
  "77777777-7777-4777-8777-777777777777";
const PLAYER_ID =
  "88888888-8888-4888-8888-888888888888";
const OTHER_FAD_ID =
  "99999999-9999-4999-8999-999999999999";
const OTHER_RESOURCE_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DUE_AT_MS = 1_700_000;
const ACCEPTED_AT_MS = 1_650_000;
const REASON =
  "Retry the failed automatic allocation.";

const EXPECTED_POLICIES = Object.freeze({
  retry_deadline: Object.freeze({
    recoveryKind: "deadline_retry",
    operationKind: "deadline",
    occurrenceType: "deadline",
    jobType: "fad_deadline",
    resourceType: "free_agent_draft",
    resourceIdRule: "null",
  }),
  retry_allocation: Object.freeze({
    recoveryKind: "allocation_retry",
    operationKind: "allocation",
    occurrenceType: "allocate",
    jobType: "fad_allocation",
    resourceType: "allocation",
    resourceIdRule: "uuid",
  }),
  activate_restricted: Object.freeze({
    recoveryKind: "restricted_activation",
    operationKind: "restricted_activation",
    occurrenceType: "restricted_activate",
    jobType: "fad_restricted_activation",
    resourceType: "allocation",
    resourceIdRule: "uuid",
  }),
  activate_queued_nomination: Object.freeze({
    recoveryKind: "queued_nomination_activation",
    operationKind: "queued_nomination_activation",
    occurrenceType: "nomination_open",
    jobType: "fad_queued_nomination_activation",
    resourceType: "nomination_queue",
    resourceIdRule: "uuid",
  }),
  activate_fallback: Object.freeze({
    recoveryKind: "fallback_activation",
    operationKind: "fallback_activation",
    occurrenceType: "fallback_activate",
    jobType: "fad_fallback_activation",
    resourceType: "allocation",
    resourceIdRule: "uuid",
  }),
  retry_auction_resolution: Object.freeze({
    recoveryKind: "auction_resolution",
    operationKind: "auction_resolution",
    occurrenceType: "auction_resolution",
    jobType: "auction.resolve.target",
    resourceType: "auction",
    resourceIdRule: "uuid",
  }),
  finalize_rollover: Object.freeze({
    recoveryKind: "rollover_finalize",
    operationKind: "rollover",
    occurrenceType: "rollover",
    jobType: "fad_rollover",
    resourceType: "rollover",
    resourceIdRule: "uuid",
  }),
  complete_fad: Object.freeze({
    recoveryKind: "completion",
    operationKind: "completion",
    occurrenceType: "complete",
    jobType: "fad_completion",
    resourceType: "free_agent_draft",
    resourceIdRule: "null",
  }),
});

const RESOURCE_BY_ACTION = Object.freeze({
  retry_deadline: null,
  retry_allocation: ALLOCATION_ID,
  activate_restricted: ALLOCATION_ID,
  activate_queued_nomination: QUEUE_ID,
  activate_fallback: ALLOCATION_ID,
  retry_auction_resolution: AUCTION_ID,
  finalize_rollover: ROLLOVER_ID,
  complete_fad: null,
});

const OCCURRENCE_BY_ACTION = Object.freeze({
  retry_deadline:
    buildFreeAgentDraftDeadlineOccurrenceKey({
      fadId: FAD_ID,
      deadlineAtMs: DUE_AT_MS,
    }),
  retry_allocation:
    buildFreeAgentDraftAllocationOccurrenceKey({
      fadId: FAD_ID,
      playerId: PLAYER_ID,
    }),
  activate_restricted:
    buildFreeAgentDraftRestrictedActivationOccurrenceKey(
      {
        fadId: FAD_ID,
        allocationId: ALLOCATION_ID,
        activationAtMs: DUE_AT_MS,
      }
    ),
  activate_queued_nomination:
    buildFreeAgentDraftNominationOpenOccurrenceKey({
      fadId: FAD_ID,
      queueId: QUEUE_ID,
      rolloverAtMs: DUE_AT_MS,
    }),
  activate_fallback:
    buildFreeAgentDraftFallbackActivationOccurrenceKey(
      {
        fadId: FAD_ID,
        allocationId: ALLOCATION_ID,
        activationAtMs: DUE_AT_MS,
      }
    ),
  retry_auction_resolution:
    buildAuctionResolutionOccurrenceKey({
      auctionId: AUCTION_ID,
      dueAtMs: DUE_AT_MS,
    }),
  finalize_rollover:
    buildFreeAgentDraftRolloverOccurrenceKey({
      fadId: FAD_ID,
      sequence: 1,
      rolloverAtMs: DUE_AT_MS,
    }),
  complete_fad:
    buildFreeAgentDraftCompletionOccurrenceKey({
      fadId: FAD_ID,
    }),
});

const EXPECTED_REQUEST_JSON =
  '{"body":{"action":"retry_allocation","reason":"Retry the failed automatic allocation.","resourceId":"33333333-3333-4333-8333-333333333333"},"domain":"hundo-leago.free-agent-draft-recovery-action-request","fadId":"22222222-2222-4222-8222-222222222222","leagueId":"11111111-1111-4111-8111-111111111111","schemaVersion":1}';
const EXPECTED_REQUEST_SHA256 =
  "412ea51ca5231f8f67001905bb535d3f3b12433891c0b8ee891e987f341c430e";

function bodyFor(action, overrides = {}) {
  return {
    action,
    resourceId: RESOURCE_BY_ACTION[action],
    reason: REASON,
    ...overrides,
  };
}

function requestFor(
  action = "retry_allocation",
  overrides = {}
) {
  return {
    leagueId: LEAGUE_ID,
    fadId: FAD_ID,
    body: bodyFor(action),
    ...overrides,
  };
}

function acceptedOperationFor(
  action,
  overrides = {}
) {
  return {
    operationId: OPERATION_ID,
    occurrenceKey: OCCURRENCE_BY_ACTION[action],
    action,
    resourceId: RESOURCE_BY_ACTION[action],
    status: "pending",
    acceptedAtMs: ACCEPTED_AT_MS,
    pollDescriptor: {
      kind: "fad_recovery",
      leagueId: LEAGUE_ID,
      fadId: FAD_ID,
    },
    ...overrides,
  };
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
        FreeAgentDraftRecoveryPolicyError &&
      error.code === code &&
      error.reasonCode === reasonCode
  );
}

describe("FAD recovery action request policy", () => {
  test("publishes the exact closed action and operation/job/resource map", () => {
    assert.equal(
      FREE_AGENT_DRAFT_RECOVERY_ACTION_HTTP_STATUS,
      202
    );
    assert.equal(
      FREE_AGENT_DRAFT_RECOVERY_ACTION_REQUEST_DOMAIN,
      "hundo-leago.free-agent-draft-recovery-action-request"
    );
    assert.deepEqual(
      FREE_AGENT_DRAFT_RECOVERY_ACTIONS,
      Object.keys(EXPECTED_POLICIES)
    );
    assert.deepEqual(
      Object.keys(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES
      ),
      Object.keys(EXPECTED_POLICIES)
    );
    for (const [
      action,
      expected,
    ] of Object.entries(EXPECTED_POLICIES)) {
      const policy =
        getFreeAgentDraftRecoveryActionPolicy(
          action
        );
      assert.deepEqual(policy, {
        action,
        ...expected,
      });
      assert.equal(Object.isFrozen(policy), true);
    }
    assert.equal(
      Object.isFrozen(
        FREE_AGENT_DRAFT_RECOVERY_ACTIONS
      ),
      true
    );
    assert.equal(
      Object.isFrozen(
        FREE_AGENT_DRAFT_RECOVERY_ACTION_POLICIES
      ),
      true
    );
  });

  test("normalizes and freezes all eight exact body forms", () => {
    for (const action of Object.keys(
      EXPECTED_POLICIES
    )) {
      const normalized =
        normalizeFreeAgentDraftRecoveryActionBody(
          bodyFor(action)
        );
      assert.deepEqual(normalized, bodyFor(action));
      assert.equal(Object.isFrozen(normalized), true);
    }
  });

  test("binds one fixed canonical request representation and independent SHA-256 vector", () => {
    const projection =
      freeAgentDraftRecoveryActionRequestProjection(
        requestFor()
      );
    assert.deepEqual(projection, {
      body: bodyFor("retry_allocation"),
      domain:
        "hundo-leago.free-agent-draft-recovery-action-request",
      fadId: FAD_ID,
      leagueId: LEAGUE_ID,
      schemaVersion: 1,
    });
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(
      Object.isFrozen(projection.body),
      true
    );
    assert.equal(
      serializeFreeAgentDraftRecoveryActionRequest(
        requestFor()
      ),
      EXPECTED_REQUEST_JSON
    );
    assert.equal(
      crypto
        .createHash("sha256")
        .update(EXPECTED_REQUEST_JSON, "utf8")
        .digest("hex"),
      EXPECTED_REQUEST_SHA256
    );
    assert.equal(
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor()
      ),
      EXPECTED_REQUEST_SHA256
    );
  });

  test("changes request identity for every scoped intent field", () => {
    const baseline =
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor()
      );
    const hashes = [
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor("activate_restricted")
      ),
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor("retry_allocation", {
          leagueId: OTHER_FAD_ID,
        })
      ),
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor("retry_allocation", {
          fadId: OTHER_FAD_ID,
        })
      ),
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor("retry_allocation", {
          body: bodyFor("retry_allocation", {
            resourceId: OTHER_RESOURCE_ID,
          }),
        })
      ),
      hashFreeAgentDraftRecoveryActionRequest(
        requestFor("retry_allocation", {
          body: bodyFor("retry_allocation", {
            reason: "A different safe reason.",
          }),
        })
      ),
    ];
    assert.equal(new Set(hashes).size, hashes.length);
    assert.equal(
      hashes.every((hash) => hash !== baseline),
      true
    );
  });

  test("requires null only for whole-FAD actions and UUID resources for every scoped action", () => {
    for (const action of [
      "retry_deadline",
      "complete_fad",
    ]) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody(
            bodyFor(action, {
              resourceId: FAD_ID,
            })
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .resourceIdMustBeNull
      );
    }
    for (const action of Object.keys(
      EXPECTED_POLICIES
    ).filter(
      (value) =>
        ![
          "retry_deadline",
          "complete_fad",
        ].includes(value)
    )) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody(
            bodyFor(action, {
              resourceId: null,
            })
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .resourceIdRequired
      );
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody(
            bodyFor(action, {
              resourceId: "not-a-uuid",
            })
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .resourceIdInvalid
      );
    }
  });

  test("rejects recover_schedule, unknown actions, and every forbidden or unknown body field", () => {
    for (const action of [
      "recover_schedule",
      "retry_rollover",
      "RETRY_DEADLINE",
      "",
    ]) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody({
            action,
            resourceId: null,
            reason: REASON,
          }),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .actionInvalid
      );
    }

    const forbiddenFields = [
      "winnerId",
      "winningTeamId",
      "totalValueCents",
      "aavCents",
      "termYears",
      "deadlineAtMs",
      "rolloverAtMs",
      "activationAtMs",
      "cardId",
      "unlockCard",
      "scheduleId",
      "week1StartsAtMs",
      "participantIds",
      "unknown",
    ];
    for (const field of forbiddenFields) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody({
            ...bodyFor("retry_allocation"),
            [field]: "forbidden",
          }),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .bodyFieldsInvalid
      );
    }
  });

  test("requires exact ordinary data objects without symbols, hidden fields, or accessors", () => {
    for (const value of [
      null,
      [],
      new Date(),
      Object.assign(
        Object.create({ inherited: true }),
        bodyFor("retry_allocation")
      ),
    ]) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody(
            value
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .bodyFieldsInvalid
      );
    }

    const symbolBody = bodyFor("retry_allocation");
    symbolBody[Symbol("hidden")] = true;
    assertPolicyError(
      () =>
        normalizeFreeAgentDraftRecoveryActionBody(
          symbolBody
        ),
      FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
        .inputInvalid,
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .bodyFieldsInvalid
    );

    const hiddenBody = bodyFor("retry_allocation");
    Object.defineProperty(hiddenBody, "hidden", {
      value: true,
      enumerable: false,
    });
    assertPolicyError(
      () =>
        normalizeFreeAgentDraftRecoveryActionBody(
          hiddenBody
        ),
      FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
        .inputInvalid,
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .bodyFieldsInvalid
    );

    let getterRead = false;
    const accessorBody = bodyFor("retry_allocation");
    Object.defineProperty(accessorBody, "reason", {
      enumerable: true,
      get() {
        getterRead = true;
        return REASON;
      },
    });
    assertPolicyError(
      () =>
        normalizeFreeAgentDraftRecoveryActionBody(
          accessorBody
        ),
      FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
        .inputInvalid,
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .bodyFieldsInvalid
    );
    assert.equal(getterRead, false);
  });

  test("enforces one through 500 safe trimmed Unicode scalar values", () => {
    assert.equal(
      FREE_AGENT_DRAFT_RECOVERY_REASON_MAXIMUM_SCALARS,
      500
    );
    const maximumEmojiReason = "🏒".repeat(500);
    assert.equal(
      normalizeFreeAgentDraftRecoveryActionBody(
        bodyFor("retry_allocation", {
          reason: maximumEmojiReason,
        })
      ).reason,
      maximumEmojiReason
    );

    for (const reason of [
      "",
      " ",
      ` ${REASON}`,
      `${REASON} `,
      "x".repeat(501),
      "🏒".repeat(501),
      "line\nbreak",
      "tab\tvalue",
      "delete\u007fvalue",
      "control\u0085value",
      "separator\u2028value",
      "paragraph\u2029value",
      "unpaired-high-\ud800",
      "unpaired-low-\udc00",
    ]) {
      assertPolicyError(
        () =>
          normalizeFreeAgentDraftRecoveryActionBody(
            bodyFor("retry_allocation", {
              reason,
            })
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .reasonInvalid
      );
    }
  });

  test("accepts only a trimmed control-safe 1 through 128 scalar idempotency key", () => {
    assert.equal(
      FREE_AGENT_DRAFT_RECOVERY_IDEMPOTENCY_KEY_MAXIMUM_SCALARS,
      128
    );
    assert.equal(
      validateFreeAgentDraftRecoveryIdempotencyKey(
        "fad-recovery-action-one"
      ),
      "fad-recovery-action-one"
    );
    assert.equal(
      validateFreeAgentDraftRecoveryIdempotencyKey(
        "\u{1f3d2}".repeat(128)
      ),
      "\u{1f3d2}".repeat(128)
    );
    for (const value of [
      "",
      " ",
      " padded",
      "padded ",
      "x".repeat(129),
      "\u{1f3d2}".repeat(129),
      "line\nbreak",
      "tab\tvalue",
      "delete\u007fvalue",
      "separator\u2028value",
      "unpaired-high-\ud800",
      "unpaired-low-\udc00",
      null,
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftRecoveryIdempotencyKey(
            value
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .idempotencyKeyInvalid
      );
    }
  });

  test("requires the exact scoped canonical request envelope", () => {
    for (const input of [
      {
        ...requestFor(),
        actorUserId: OPERATION_ID,
      },
      {
        leagueId: LEAGUE_ID,
        fadId: FAD_ID,
      },
      [],
    ]) {
      assertPolicyError(
        () =>
          freeAgentDraftRecoveryActionRequestProjection(
            input
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .requestFieldsInvalid
      );
    }
    for (const [field, value, reasonCode] of [
      ["leagueId", "bad", "league_id_invalid"],
      ["fadId", "bad", "fad_id_invalid"],
    ]) {
      assertPolicyError(
        () =>
          freeAgentDraftRecoveryActionRequestProjection({
            ...requestFor(),
            [field]: value,
          }),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .inputInvalid,
        reasonCode
      );
    }
  });
});

describe("FAD recovery accepted-operation policy", () => {
  test("projects and deeply freezes both approved statuses for all eight actions", () => {
    let index = 0;
    for (const action of Object.keys(
      EXPECTED_POLICIES
    )) {
      const expected = acceptedOperationFor(action, {
        status:
          index % 2 === 0
            ? "pending"
            : "already_succeeded",
      });
      const projected =
        projectFreeAgentDraftRecoveryAcceptedOperation(
          expected
        );
      assert.deepEqual(projected, expected);
      assert.deepEqual(
        validateFreeAgentDraftRecoveryAcceptedOperation(
          expected
        ),
        expected
      );
      assert.equal(Object.isFrozen(projected), true);
      assert.equal(
        Object.isFrozen(projected.pollDescriptor),
        true
      );
      index += 1;
    }
  });

  test("serializes and hashes the exact immutable 202 representation", () => {
    const accepted = acceptedOperationFor(
      "retry_allocation"
    );
    const serialized =
      serializeFreeAgentDraftRecoveryAcceptedOperation(
        accepted
      );
    assert.equal(
      serialized,
      '{"acceptedAtMs":1650000,"action":"retry_allocation","occurrenceKey":"fad:22222222-2222-4222-8222-222222222222:allocate:88888888-8888-4888-8888-888888888888","operationId":"77777777-7777-4777-8777-777777777777","pollDescriptor":{"fadId":"22222222-2222-4222-8222-222222222222","kind":"fad_recovery","leagueId":"11111111-1111-4111-8111-111111111111"},"resourceId":"33333333-3333-4333-8333-333333333333","status":"pending"}'
    );
    assert.equal(
      hashFreeAgentDraftRecoveryAcceptedOperation(
        accepted
      ),
      crypto
        .createHash("sha256")
        .update(serialized, "utf8")
        .digest("hex")
    );
  });

  test("rejects unknown response fields, status, IDs, clock, and poll shapes", () => {
    const baseline = acceptedOperationFor(
      "retry_allocation"
    );
    const cases = [
      [
        { ...baseline, extra: true },
        "response_fields_invalid",
      ],
      [
        { ...baseline, operationId: "bad" },
        "operation_id_invalid",
      ],
      [
        { ...baseline, status: "succeeded" },
        "status_invalid",
      ],
      [
        { ...baseline, acceptedAtMs: -1 },
        "accepted_at_ms_invalid",
      ],
      [
        {
          ...baseline,
          pollDescriptor: {
            ...baseline.pollDescriptor,
            kind: "free_agent_draft",
          },
        },
        "poll_descriptor_invalid",
      ],
      [
        {
          ...baseline,
          pollDescriptor: {
            ...baseline.pollDescriptor,
            extra: true,
          },
        },
        "poll_descriptor_invalid",
      ],
      [
        {
          ...baseline,
          pollDescriptor: {
            ...baseline.pollDescriptor,
            leagueId: "bad",
          },
        },
        "poll_descriptor_invalid",
      ],
    ];
    for (const [value, reasonCode] of cases) {
      assertPolicyError(
        () =>
          projectFreeAgentDraftRecoveryAcceptedOperation(
            value
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .resultInvalid,
        reasonCode
      );
    }
  });

  test("rejects cross-FAD, wrong-kind, noncanonical, and resource-mismatched occurrences", () => {
    const cases = [
      acceptedOperationFor("retry_deadline", {
        occurrenceKey:
          buildFreeAgentDraftDeadlineOccurrenceKey({
            fadId: OTHER_FAD_ID,
            deadlineAtMs: DUE_AT_MS,
          }),
      }),
      acceptedOperationFor("retry_deadline", {
        occurrenceKey:
          buildFreeAgentDraftCompletionOccurrenceKey({
            fadId: FAD_ID,
          }),
      }),
      acceptedOperationFor("activate_restricted", {
        resourceId: OTHER_RESOURCE_ID,
      }),
      acceptedOperationFor(
        "activate_queued_nomination",
        { resourceId: OTHER_RESOURCE_ID }
      ),
      acceptedOperationFor(
        "retry_auction_resolution",
        { resourceId: OTHER_RESOURCE_ID }
      ),
      acceptedOperationFor(
        "retry_auction_resolution",
        {
          occurrenceKey:
            `auction:${AUCTION_ID}:01700000`,
        }
      ),
      acceptedOperationFor("finalize_rollover", {
        occurrenceKey:
          buildFreeAgentDraftCompletionOccurrenceKey({
            fadId: FAD_ID,
          }),
      }),
    ];
    for (const value of cases) {
      assertPolicyError(
        () =>
          projectFreeAgentDraftRecoveryAcceptedOperation(
            value
          ),
        FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
          .resultInvalid,
        FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
          .occurrenceKeyInvalid
      );
    }
  });

  test("applies the same exact resource nullability rules to accepted operations", () => {
    assertPolicyError(
      () =>
        projectFreeAgentDraftRecoveryAcceptedOperation(
          acceptedOperationFor("complete_fad", {
            resourceId: FAD_ID,
          })
        ),
      FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
        .resultInvalid,
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .resourceIdMustBeNull
    );
    assertPolicyError(
      () =>
        projectFreeAgentDraftRecoveryAcceptedOperation(
          acceptedOperationFor("retry_allocation", {
            resourceId: null,
          })
        ),
      FREE_AGENT_DRAFT_RECOVERY_POLICY_CODES
        .resultInvalid,
      FREE_AGENT_DRAFT_RECOVERY_REASON_CODES
        .resourceIdRequired
    );
  });
});
