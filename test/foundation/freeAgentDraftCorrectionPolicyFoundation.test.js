const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_CORRECTION_CODES,
  FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
  FREE_AGENT_DRAFT_CORRECTION_MODE,
  FREE_AGENT_DRAFT_CORRECTION_PREVIEW_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_REQUEST_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION,
  FreeAgentDraftCorrectionPolicyError,
  assertFreeAgentDraftCorrectionPreviewFingerprintCurrent,
  compareFreeAgentDraftCorrectionDecisions,
  compareFreeAgentDraftCorrectionPreviewFingerprints,
  createFreeAgentDraftCorrectionPreview,
  freeAgentDraftCorrectionApplyRequestProjection,
  freeAgentDraftCorrectionPreviewFingerprintProjection,
  hasFreeAgentDraftCorrectionPreviewFingerprintDrift,
  hashFreeAgentDraftCorrectionApplyRequest,
  hashFreeAgentDraftCorrectionPreview,
  projectFreeAgentDraftAllocationResultForPublic,
  projectFreeAgentDraftCorrectionApplyResultForPublic,
  projectFreeAgentDraftCorrectionPreviewForPublic,
  serializeFreeAgentDraftCorrectionApplyRequest,
  serializeFreeAgentDraftCorrectionPreviewFingerprint,
  validateFreeAgentDraftAllocationResultProjection,
  validateFreeAgentDraftPublicAllocationResultProjection,
  validateFreeAgentDraftCorrectionAfterSummary,
  validateFreeAgentDraftCorrectionApplyBody,
  validateFreeAgentDraftCorrectionApplyCommand,
  validateFreeAgentDraftCorrectionApplyResult,
  validateFreeAgentDraftCorrectionDecision,
  validateFreeAgentDraftCorrectionDelta,
  validateFreeAgentDraftCorrectionDiagnostic,
  validateFreeAgentDraftCorrectionExpectedAllocationVersion,
  validateFreeAgentDraftCorrectionIdempotencyKey,
  validateFreeAgentDraftCorrectionPreview,
  validateFreeAgentDraftCorrectionPreviewBody,
  validateFreeAgentDraftCorrectionPreviewCommand,
  validateFreeAgentDraftCorrectionPublicApplyResult,
  validateFreeAgentDraftCorrectionPublicPreview,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  fad: uuid(2),
  allocation: uuid(3),
  player: uuid(4),
  teamOne: uuid(5),
  teamTwo: uuid(6),
  teamThree: uuid(7),
  snapshotOne: uuid(8),
  snapshotTwo: uuid(9),
  contract: uuid(10),
  ownership: uuid(11),
  restrictedAuction: uuid(12),
  fallbackAuction: uuid(13),
  recovery: uuid(14),
  correction: uuid(15),
  activity: uuid(16),
  bidOne: uuid(17),
  bidTwo: uuid(18),
});

function safeTeam(teamId, name = "Snow Owls") {
  return {
    teamId,
    name,
    primaryColour: "#112233",
    secondaryColour: "#ffffff",
    tertiaryColour: null,
    patternTemplate: "mirrored-centre-band",
    logoReference: null,
  };
}

function safePlayer() {
  return {
    playerId: IDS.player,
    fullName: "Casey Candidate",
    positionGroup: "F",
  };
}

function rankedOffer({
  snapshotEntryId = IDS.snapshotOne,
  teamId = IDS.teamOne,
  teamName = "Snow Owls",
  slotKey = "F01",
  totalValueCents = 600,
  termYears = 2,
  aavCents = 300,
  valid = true,
  validationCode = null,
  rank = 1,
  outcomeCode = "winner",
} = {}) {
  return {
    snapshotEntryId,
    teamId,
    team: safeTeam(teamId, teamName),
    slotKey,
    totalValueCents,
    termYears,
    aavCents,
    valid,
    validationCode,
    rank,
    outcomeCode,
  };
}

function emptyAfterSummary(overrides = {}) {
  return {
    status: null,
    team: null,
    player: null,
    contractId: null,
    ownershipId: null,
    auctionId: null,
    totalValueCents: null,
    termYears: null,
    aavCents: null,
    rosterCategory: null,
    ...overrides,
  };
}

function invalidDecision(recoveryStatus) {
  return {
    status: "invalid",
    decisionCode: "invalid_snapshot",
    rankedOffers: [
      rankedOffer({
        valid: false,
        validationCode: "INVALID_SNAPSHOT",
        rank: null,
        outcomeCode: "invalid",
      }),
    ],
    winner: null,
    restricted: null,
    recoveryStatus,
  };
}

function automaticDecision() {
  return {
    status: "automatic_award",
    decisionCode: "sole_valid_offer",
    rankedOffers: [rankedOffer()],
    winner: {
      teamId: IDS.teamOne,
      snapshotEntryId: IDS.snapshotOne,
      contractId: IDS.contract,
      ownershipId: IDS.ownership,
      slotKey: "F01",
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
    },
    restricted: null,
    recoveryStatus: null,
  };
}

function restrictedDecision() {
  return {
    status: "restricted_scheduled",
    decisionCode: "exact_total_and_term_tie",
    rankedOffers: [
      rankedOffer({ outcomeCode: "restricted_tied" }),
    ],
    winner: null,
    restricted: {
      auctionId: null,
      status: "scheduled",
      participantTeamIds: [],
      minimumTotalValueCents: 600,
      minimumTermYears: 2,
      minimumAavCents: 300,
    },
    recoveryStatus: null,
  };
}

function fallbackAllocation() {
  return {
    allocationId: IDS.allocation,
    allocationVersion: 4,
    player: safePlayer(),
    status: "fallback_open_resolved",
    decisionCode: "fallback_open_result",
    rankedOffers: [
      rankedOffer({ outcomeCode: "restricted_tied" }),
      rankedOffer({
        snapshotEntryId: IDS.snapshotTwo,
        teamId: IDS.teamTwo,
        teamName: "Ice Foxes",
        slotKey: "F02",
        outcomeCode: "restricted_tied",
      }),
    ],
    winner: {
      teamId: IDS.teamThree,
      snapshotEntryId: null,
      contractId: IDS.contract,
      ownershipId: IDS.ownership,
      slotKey: "F03",
      totalValueCents: 900,
      termYears: 3,
      aavCents: 300,
    },
    restricted: {
      auctionId: IDS.restrictedAuction,
      status: "no_winner",
      participantTeamIds: [IDS.teamOne, IDS.teamTwo],
      minimumTotalValueCents: 600,
      minimumTermYears: 2,
      minimumAavCents: 300,
    },
    fallback: {
      auctionId: IDS.fallbackAuction,
      status: "resolved",
      minimumTotalValueCents: 600,
      winningBidId: IDS.bidOne,
      contractId: IDS.contract,
      ownershipId: IDS.ownership,
      noWinnerReason: null,
    },
    draws: [],
    recoveryStatus: "resolved",
    resolvedAtMs: 1_000_000,
  };
}

function previewCreateInput(overrides = {}) {
  return {
    leagueId: IDS.league,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    allocationVersion: 3,
    reversible: true,
    currentDecision: invalidDecision(
      "correction_required"
    ),
    recomputedDecision: invalidDecision("resolved"),
    deltas: [
      {
        resourceType: "recovery",
        resourceId: IDS.recovery,
        action: "resolve",
        beforeVersion: 2,
        afterSummary: emptyAfterSummary({
          status: "resolved",
        }),
      },
    ],
    warnings: [],
    blockers: [],
    ...overrides,
  };
}

function applyBody(overrides = {}) {
  return {
    mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    previewFingerprint: "a".repeat(64),
    reason:
      "Reconcile the result to the locked Candidate Card snapshot.",
    confirmation:
      FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
    ...overrides,
  };
}

function applyCommand(overrides = {}) {
  return {
    leagueId: IDS.league,
    fadId: IDS.fad,
    allocationId: IDS.allocation,
    expectedAllocationVersion: 3,
    idempotencyKey: "fad-correction-0001",
    body: applyBody(),
    ...overrides,
  };
}

function assertPolicyError(
  callback,
  code,
  reasonCode = null
) {
  assert.throws(callback, (error) => {
    assert.equal(
      error instanceof FreeAgentDraftCorrectionPolicyError,
      true
    );
    assert.equal(error.code, code);
    if (reasonCode !== null) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

describe("Free Agent Draft correction policy foundation", () => {
  test("accepts only the exact T-143 preview body", () => {
    const body =
      validateFreeAgentDraftCorrectionPreviewBody({
        mode: "recompute_locked_snapshot",
      });
    assert.deepEqual(body, {
      mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
    });
    assert.equal(Object.isFrozen(body), true);

    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPreviewBody({
          mode: "choose_winner",
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
      "correction_mode_invalid"
    );

    for (const forbiddenField of [
      "winner",
      "teamId",
      "totalValueCents",
      "termYears",
      "auctionId",
      "resolvesAtMs",
      "control",
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionPreviewBody({
            mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
            [forbiddenField]: "override",
          }),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "preview_body_fields_invalid"
      );
    }
  });

  test("accepts only the exact T-144 body and bounded header inputs", () => {
    const body = validateFreeAgentDraftCorrectionApplyBody(
      applyBody()
    );
    assert.deepEqual(body, applyBody());
    assert.equal(Object.isFrozen(body), true);
    assert.equal(
      validateFreeAgentDraftCorrectionExpectedAllocationVersion(
        3
      ),
      3
    );
    assert.equal(
      validateFreeAgentDraftCorrectionIdempotencyKey(
        "opaque-key"
      ),
      "opaque-key"
    );

    for (const forbiddenField of [
      "winner",
      "teamId",
      "totalValueCents",
      "termYears",
      "auctionId",
      "customDeadlineAtMs",
      "executeImmediately",
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionApplyBody(
            applyBody({ [forbiddenField]: "override" })
          ),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "apply_body_fields_invalid"
      );
    }

    for (const invalidReason of [
      "",
      " padded",
      "padded ",
      "a".repeat(501),
      "unsafe\nreason",
      "unsafe\ud800reason",
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionApplyBody(
            applyBody({ reason: invalidReason })
          ),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "reason_invalid"
      );
    }

    for (const invalidFingerprint of [
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionApplyBody(
            applyBody({
              previewFingerprint: invalidFingerprint,
            })
          ),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "preview_fingerprint_invalid"
      );
    }

    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionApplyBody(
          applyBody({ confirmation: "APPLY CORRECTION" })
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
      "confirmation_invalid"
    );
    for (const invalidVersion of [0, -1, 1.5, NaN]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionExpectedAllocationVersion(
            invalidVersion
          ),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "expected_allocation_version_invalid"
      );
    }
    for (const invalidKey of [
      "",
      " key",
      "key ",
      "a".repeat(129),
      "unsafe\nkey",
      "unsafe\ud800key",
    ]) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionIdempotencyKey(
            invalidKey
          ),
        FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
        "idempotency_key_invalid"
      );
    }
  });

  test("closes preview/apply command identity and canonical apply request", () => {
    const previewCommand =
      validateFreeAgentDraftCorrectionPreviewCommand({
        leagueId: IDS.league,
        fadId: IDS.fad,
        allocationId: IDS.allocation,
        body: { mode: FREE_AGENT_DRAFT_CORRECTION_MODE },
      });
    assert.equal(previewCommand.leagueId, IDS.league);
    assert.equal(Object.isFrozen(previewCommand), true);

    const command =
      validateFreeAgentDraftCorrectionApplyCommand(
        applyCommand()
      );
    assert.equal(command.expectedAllocationVersion, 3);
    assert.equal(command.idempotencyKey, "fad-correction-0001");
    assert.equal(Object.isFrozen(command), true);

    const projection =
      freeAgentDraftCorrectionApplyRequestProjection(
        applyCommand()
      );
    assert.deepEqual(projection, {
      domain: FREE_AGENT_DRAFT_CORRECTION_REQUEST_DOMAIN,
      schemaVersion:
        FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION,
      leagueId: IDS.league,
      fadId: IDS.fad,
      allocationId: IDS.allocation,
      mode: FREE_AGENT_DRAFT_CORRECTION_MODE,
      previewFingerprint: "a".repeat(64),
      reason:
        "Reconcile the result to the locked Candidate Card snapshot.",
      confirmation:
        FREE_AGENT_DRAFT_CORRECTION_CONFIRMATION,
    });
    const serialized =
      serializeFreeAgentDraftCorrectionApplyRequest(
        applyCommand()
      );
    assert.equal(
      hashFreeAgentDraftCorrectionApplyRequest(
        applyCommand()
      ),
      createHash("sha256")
        .update(serialized)
        .digest("hex")
    );
    assert.equal(
      serialized,
      `{"allocationId":"${IDS.allocation}","confirmation":"APPLY FAD CORRECTION","domain":"hundo-leago.fad-allocation-correction-request","fadId":"${IDS.fad}","leagueId":"${IDS.league}","mode":"recompute_locked_snapshot","previewFingerprint":"${"a".repeat(64)}","reason":"Reconcile the result to the locked Candidate Card snapshot.","schemaVersion":1}`
    );

    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionApplyCommand(
          applyCommand({ nowMs: 123 })
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.inputInvalid,
      "apply_command_fields_invalid"
    );
  });

  test("validates closed decision, diagnostic, delta, and after-summary shapes", () => {
    const decision =
      validateFreeAgentDraftCorrectionDecision(
        automaticDecision()
      );
    assert.equal(decision.status, "automatic_award");
    assert.equal(decision.winner.teamId, IDS.teamOne);
    assert.equal(Object.isFrozen(decision.rankedOffers), true);
    assert.equal(
      Object.isFrozen(decision.rankedOffers[0].team),
      true
    );
    assert.equal(
      compareFreeAgentDraftCorrectionDecisions(
        automaticDecision(),
        structuredClone(automaticDecision())
      ),
      true
    );

    const changedDecision = automaticDecision();
    changedDecision.decisionCode = "highest_total";
    assert.equal(
      compareFreeAgentDraftCorrectionDecisions(
        automaticDecision(),
        changedDecision
      ),
      false
    );

    const diagnostic =
      validateFreeAgentDraftCorrectionDiagnostic({
        code: "DOWNSTREAM_AUCTION_REVERSAL_REQUIRED",
        message: "The linked auction must be cancelled.",
        resourceId: IDS.restrictedAuction,
      });
    assert.equal(Object.isFrozen(diagnostic), true);

    const summary =
      validateFreeAgentDraftCorrectionAfterSummary(
        emptyAfterSummary({
          status: "Active",
          team: safeTeam(IDS.teamOne),
          player: safePlayer(),
          contractId: IDS.contract,
          totalValueCents: 600,
          termYears: 2,
          aavCents: 300,
          rosterCategory: "Active",
        }),
        "contract"
      );
    assert.equal(summary.status, "Active");
    assert.equal(summary.aavCents, 300);

    const delta = validateFreeAgentDraftCorrectionDelta({
      resourceType: "contract",
      resourceId: null,
      action: "create",
      beforeVersion: null,
      afterSummary: summary,
    });
    assert.equal(delta.action, "create");
    assert.equal(Object.isFrozen(delta.afterSummary), true);

    const badDecision = automaticDecision();
    badDecision.fallback = null;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionDecision(
          badDecision
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "decision_invalid"
    );
    const mismatchedWinner = automaticDecision();
    mismatchedWinner.winner.totalValueCents = 700;
    mismatchedWinner.winner.aavCents = 350;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionDecision(
          mismatchedWinner
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "decision_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionDiagnostic({
          code: "bad-code",
          message: "Message",
          resourceId: null,
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "diagnostic_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionAfterSummary(
          emptyAfterSummary({
            status: "Deleted",
          }),
          "contract"
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "after_summary_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionDelta({
          resourceType: "auction",
          resourceId: null,
          action: "cancel",
          beforeVersion: 2,
          afterSummary: emptyAfterSummary({
            status: "cancelled",
          }),
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "delta_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionDelta({
          resourceType: "sql_row",
          resourceId: IDS.contract,
          action: "update",
          beforeVersion: 1,
          afterSummary: emptyAfterSummary(),
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "delta_invalid"
    );
  });

  test("pins the correction preview canonical-json-v1 domain and SHA-256 vector", () => {
    const preview = createFreeAgentDraftCorrectionPreview(
      previewCreateInput()
    );
    const projection =
      freeAgentDraftCorrectionPreviewFingerprintProjection({
        leagueId: IDS.league,
        fadId: IDS.fad,
        preview,
      });
    assert.deepEqual(Object.keys(projection), [
      "domain",
      "schemaVersion",
      "leagueId",
      "fadId",
      "allocationId",
      "allocationVersion",
      "currentDecision",
      "recomputedDecision",
      "deltas",
      "warnings",
      "blockers",
      "confirmationText",
    ]);
    assert.equal(
      projection.domain,
      FREE_AGENT_DRAFT_CORRECTION_PREVIEW_DOMAIN
    );
    assert.equal(
      projection.schemaVersion,
      FREE_AGENT_DRAFT_CORRECTION_SCHEMA_VERSION
    );
    assert.equal(
      Object.hasOwn(projection, "previewFingerprint"),
      false
    );
    assert.equal(Object.hasOwn(projection, "reversible"), false);

    const canonical =
      serializeFreeAgentDraftCorrectionPreviewFingerprint({
        leagueId: IDS.league,
        fadId: IDS.fad,
        preview,
      });
    assert.equal(
      canonical.startsWith(
        `{"allocationId":"${IDS.allocation}","allocationVersion":3,"blockers":[]`
      ),
      true
    );
    assert.equal(
      hashFreeAgentDraftCorrectionPreview({
        leagueId: IDS.league,
        fadId: IDS.fad,
        preview,
      }),
      createHash("sha256").update(canonical).digest("hex")
    );
    assert.equal(
      preview.previewFingerprint,
      "2abef956578138a1c0e1f22bb5a67d5f7724f56e2d02ec570c90d5763f37eab1"
    );
    assert.equal(
      validateFreeAgentDraftCorrectionPreview({
        leagueId: IDS.league,
        fadId: IDS.fad,
        preview,
      }).previewFingerprint,
      preview.previewFingerprint
    );
  });

  test("detects every supplied or recomputed preview fingerprint drift", () => {
    const preview = createFreeAgentDraftCorrectionPreview(
      previewCreateInput()
    );
    assert.equal(
      compareFreeAgentDraftCorrectionPreviewFingerprints(
        preview.previewFingerprint,
        preview.previewFingerprint
      ),
      true
    );
    assert.equal(
      hasFreeAgentDraftCorrectionPreviewFingerprintDrift({
        previewFingerprint: preview.previewFingerprint,
        currentFingerprint: "f".repeat(64),
      }),
      true
    );
    assert.equal(
      assertFreeAgentDraftCorrectionPreviewFingerprintCurrent({
        previewFingerprint: preview.previewFingerprint,
        currentFingerprint: preview.previewFingerprint,
      }),
      preview.previewFingerprint
    );
    assertPolicyError(
      () =>
        assertFreeAgentDraftCorrectionPreviewFingerprintCurrent({
          previewFingerprint: preview.previewFingerprint,
          currentFingerprint: "f".repeat(64),
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.fingerprintDrift,
      "preview_fingerprint_drift"
    );

    const changedPreview = structuredClone(preview);
    changedPreview.warnings = [
      {
        code: "LEGALITY_WARNING",
        message: "The corrected roster may be illegal.",
        resourceId: IDS.teamOne,
      },
    ];
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPreview({
          leagueId: IDS.league,
          fadId: IDS.fad,
          preview: changedPreview,
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "preview_fingerprint_invalid"
    );

    const extraField = structuredClone(preview);
    extraField.selectedWinner = IDS.teamOne;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPreview({
          leagueId: IDS.league,
          fadId: IDS.fad,
          preview: extraField,
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "preview_invalid"
    );

    assertPolicyError(
      () =>
        createFreeAgentDraftCorrectionPreview(
          previewCreateInput({
            reversible: false,
            blockers: [],
          })
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "preview_invalid"
    );
  });

  test("projects a fully validated preview to an opaque all-money-null public shape", () => {
    const fullPreview = createFreeAgentDraftCorrectionPreview(
      previewCreateInput({
        currentDecision: automaticDecision(),
        recomputedDecision: restrictedDecision(),
        deltas: [
          {
            resourceType: "contract",
            resourceId: IDS.contract,
            action: "update",
            beforeVersion: 1,
            afterSummary: emptyAfterSummary({
              status: "Active",
              totalValueCents: 600,
              termYears: 2,
              aavCents: 300,
            }),
          },
        ],
      })
    );
    const publicPreview =
      projectFreeAgentDraftCorrectionPreviewForPublic(
        fullPreview
      );

    assert.equal(
      publicPreview.previewFingerprint,
      fullPreview.previewFingerprint
    );
    assert.deepEqual(
      publicPreview.currentDecision.rankedOffers.map(
        ({ totalValueCents, termYears, aavCents }) => ({
          totalValueCents,
          termYears,
          aavCents,
        })
      ),
      [
        {
          totalValueCents: null,
          termYears: null,
          aavCents: null,
        },
      ]
    );
    assert.deepEqual(
      {
        totalValueCents:
          publicPreview.currentDecision.winner.totalValueCents,
        termYears:
          publicPreview.currentDecision.winner.termYears,
        aavCents:
          publicPreview.currentDecision.winner.aavCents,
      },
      {
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }
    );
    assert.deepEqual(
      {
        minimumTotalValueCents:
          publicPreview.recomputedDecision.restricted
            .minimumTotalValueCents,
        minimumTermYears:
          publicPreview.recomputedDecision.restricted
            .minimumTermYears,
        minimumAavCents:
          publicPreview.recomputedDecision.restricted
            .minimumAavCents,
      },
      {
        minimumTotalValueCents: null,
        minimumTermYears: null,
        minimumAavCents: null,
      }
    );
    assert.deepEqual(
      {
        totalValueCents:
          publicPreview.deltas[0].afterSummary
            .totalValueCents,
        termYears:
          publicPreview.deltas[0].afterSummary.termYears,
        aavCents:
          publicPreview.deltas[0].afterSummary.aavCents,
      },
      {
        totalValueCents: null,
        termYears: null,
        aavCents: null,
      }
    );
    assert.equal(Object.isFrozen(publicPreview), true);
    assert.equal(
      Object.isFrozen(publicPreview.currentDecision.rankedOffers[0]),
      true
    );
    assert.equal(
      Object.isFrozen(publicPreview.deltas[0].afterSummary),
      true
    );

    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPublicPreview(
          fullPreview
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "public_preview_money_not_redacted"
    );

    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPreview({
          leagueId: IDS.league,
          fadId: IDS.fad,
          preview: publicPreview,
        }),
      FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
      "preview_invalid"
    );
    const opaqueFingerprint = structuredClone(publicPreview);
    opaqueFingerprint.previewFingerprint = "f".repeat(64);
    assert.equal(
      validateFreeAgentDraftCorrectionPublicPreview(
        opaqueFingerprint
      ).previewFingerprint,
      "f".repeat(64)
    );

    const partialCases = [];
    const partialOffer = structuredClone(publicPreview);
    partialOffer.currentDecision.rankedOffers[0].termYears = 2;
    partialCases.push(partialOffer);
    const partialWinner = structuredClone(publicPreview);
    partialWinner.currentDecision.winner.aavCents = 300;
    partialCases.push(partialWinner);
    const partialMinimum = structuredClone(publicPreview);
    partialMinimum.recomputedDecision.restricted.minimumTermYears = 2;
    partialCases.push(partialMinimum);
    const partialDelta = structuredClone(publicPreview);
    partialDelta.deltas[0].afterSummary.totalValueCents = 600;
    partialCases.push(partialDelta);
    for (const partial of partialCases) {
      assertPolicyError(
        () =>
          validateFreeAgentDraftCorrectionPublicPreview(partial),
        FREE_AGENT_DRAFT_CORRECTION_CODES.previewInvalid,
        "preview_invalid"
      );
    }
  });

  test("validates pending and automatic protected allocation result projections", () => {
    const pending =
      validateFreeAgentDraftAllocationResultProjection({
        allocationId: IDS.allocation,
        allocationVersion: 1,
        player: safePlayer(),
        status: "pending",
        decisionCode: null,
        rankedOffers: [
          rankedOffer({ rank: null, outcomeCode: "pending" }),
        ],
        winner: null,
        restricted: null,
        fallback: null,
        draws: [],
        recoveryStatus: null,
        resolvedAtMs: null,
      });
    assert.equal(pending.status, "pending");
    assert.equal(Object.isFrozen(pending), true);

    const decision = automaticDecision();
    const automatic =
      validateFreeAgentDraftAllocationResultProjection({
        allocationId: IDS.allocation,
        allocationVersion: 4,
        player: safePlayer(),
        ...decision,
        fallback: null,
        draws: [],
        resolvedAtMs: 1_000_000,
      });
    assert.equal(automatic.status, "automatic_award");
    assert.equal(automatic.winner.contractId, IDS.contract);

    const quarantined =
      validateFreeAgentDraftAllocationResultProjection({
        allocationId: IDS.allocation,
        allocationVersion: 2,
        player: safePlayer(),
        status: "correction_required",
        decisionCode: null,
        rankedOffers: [rankedOffer()],
        winner: null,
        restricted: null,
        fallback: null,
        draws: [],
        recoveryStatus: "correction_required",
        resolvedAtMs: null,
      });
    assert.equal(quarantined.decisionCode, null);

    const prematurePending = structuredClone(pending);
    prematurePending.resolvedAtMs = 1_000_000;
    assertPolicyError(
      () =>
        validateFreeAgentDraftAllocationResultProjection(
          prematurePending
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "allocation_result_invalid"
    );
  });

  test("validates the full protected restricted-fallback and draw shapes", () => {
    const offers = [
      rankedOffer({
        rank: 1,
        outcomeCode: "restricted_tied",
      }),
      rankedOffer({
        snapshotEntryId: IDS.snapshotTwo,
        teamId: IDS.teamTwo,
        teamName: "Ice Foxes",
        slotKey: "F02",
        rank: 1,
        outcomeCode: "restricted_tied",
      }),
    ];
    const allocation =
      validateFreeAgentDraftAllocationResultProjection({
        allocationId: IDS.allocation,
        allocationVersion: 8,
        player: safePlayer(),
        status: "fallback_open_resolved",
        decisionCode: "fallback_open_result",
        rankedOffers: offers,
        winner: {
          teamId: IDS.teamThree,
          snapshotEntryId: null,
          contractId: IDS.contract,
          ownershipId: IDS.ownership,
          slotKey: "F03",
          totalValueCents: 900,
          termYears: 3,
          aavCents: 300,
        },
        restricted: {
          auctionId: IDS.restrictedAuction,
          status: "no_winner",
          participantTeamIds: [IDS.teamOne, IDS.teamTwo],
          minimumTotalValueCents: 600,
          minimumTermYears: 2,
          minimumAavCents: 300,
        },
        fallback: {
          auctionId: IDS.fallbackAuction,
          status: "resolved",
          minimumTotalValueCents: 600,
          winningBidId: IDS.bidOne,
          contractId: IDS.contract,
          ownershipId: IDS.ownership,
          noWinnerReason: null,
        },
        draws: [
          {
            auctionId: IDS.restrictedAuction,
            auctionType: "fad_restricted",
            drawCommitment: "a".repeat(64),
            drawReveal: {
              algorithmVersion: 1,
              nonceHex: "1".repeat(64),
              selectionUsed: false,
              orderedBidIds: [],
              counter: null,
              digestHex: null,
              selectedIndex: null,
              selectedBidId: null,
              selectedTeamId: null,
            },
          },
          {
            auctionId: IDS.fallbackAuction,
            auctionType: "fad_open_rapid",
            drawCommitment: "b".repeat(64),
            drawReveal: {
              algorithmVersion: 1,
              nonceHex: "2".repeat(64),
              selectionUsed: true,
              orderedBidIds: [IDS.bidOne, IDS.bidTwo],
              counter: 0,
              digestHex: "c".repeat(64),
              selectedIndex: 0,
              selectedBidId: IDS.bidOne,
              selectedTeamId: IDS.teamThree,
            },
          },
        ],
        recoveryStatus: "resolved",
        resolvedAtMs: 2_000_000,
      });

    assert.deepEqual(allocation.restricted, {
      auctionId: IDS.restrictedAuction,
      status: "no_winner",
      participantTeamIds: [IDS.teamOne, IDS.teamTwo],
      minimumTotalValueCents: 600,
      minimumTermYears: 2,
      minimumAavCents: 300,
    });
    assert.equal(allocation.draws.length, 2);
    assert.equal(
      allocation.draws[1].drawReveal.selectedBidId,
      IDS.bidOne
    );

    const restrictedWinner = structuredClone(allocation);
    restrictedWinner.status = "restricted_resolved";
    restrictedWinner.decisionCode =
      "restricted_auction_result";
    restrictedWinner.winner = {
      ...restrictedWinner.winner,
      teamId: IDS.teamOne,
      snapshotEntryId: IDS.snapshotOne,
      slotKey: "F01",
      totalValueCents: 800,
      termYears: 2,
      aavCents: 400,
    };
    restrictedWinner.restricted.status = "resolved";
    restrictedWinner.fallback = null;
    restrictedWinner.draws = [restrictedWinner.draws[0]];
    assert.equal(
      validateFreeAgentDraftAllocationResultProjection(
        restrictedWinner
      ).winner.totalValueCents,
      800
    );

    const quarantinedFallback = structuredClone(allocation);
    quarantinedFallback.status = "correction_required";
    quarantinedFallback.decisionCode =
      "restricted_no_improvement_fallback";
    quarantinedFallback.winner = null;
    quarantinedFallback.fallback.status = "failed";
    quarantinedFallback.fallback.winningBidId = null;
    quarantinedFallback.fallback.contractId = null;
    quarantinedFallback.fallback.ownershipId = null;
    quarantinedFallback.recoveryStatus =
      "correction_required";
    quarantinedFallback.draws[1].drawReveal = null;
    assert.equal(
      validateFreeAgentDraftAllocationResultProjection(
        quarantinedFallback
      ).fallback.status,
      "failed"
    );
  });

  test("validates the exact T-144 result and committed delta identities", () => {
    const decision = automaticDecision();
    const allocation = {
      allocationId: IDS.allocation,
      allocationVersion: 4,
      player: safePlayer(),
      ...decision,
      fallback: null,
      draws: [],
      resolvedAtMs: 1_000_000,
    };
    const allocationDelta = {
      resourceType: "allocation",
      resourceId: IDS.allocation,
      action: "update",
      beforeVersion: 3,
      afterSummary: emptyAfterSummary({
        status: "automatic_award",
        team: safeTeam(IDS.teamOne),
        player: safePlayer(),
        contractId: IDS.contract,
        ownershipId: IDS.ownership,
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
        rosterCategory: "Active",
      }),
    };
    const activityDelta = {
      resourceType: "activity",
      resourceId: IDS.activity,
      action: "append",
      beforeVersion: null,
      afterSummary: emptyAfterSummary({
        status: "appended",
      }),
    };
    const result =
      validateFreeAgentDraftCorrectionApplyResult({
        correctionId: IDS.correction,
        allocation,
        appliedDeltas: [allocationDelta, activityDelta],
        activityId: IDS.activity,
        completedAtMs: 1_000_001,
      });
    assert.equal(result.correctionId, IDS.correction);
    assert.equal(result.allocation.allocationVersion, 4);
    assert.equal(result.appliedDeltas.length, 2);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.appliedDeltas), true);

    const missingActivity = structuredClone(result);
    missingActivity.appliedDeltas = [allocationDelta];
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionApplyResult(
          missingActivity
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "activity_delta_missing"
    );

    const unresolvedIdentity = structuredClone(result);
    unresolvedIdentity.appliedDeltas[1].resourceId = null;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionApplyResult(
          unresolvedIdentity
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "applied_deltas_invalid"
    );

    const extraField = structuredClone(result);
    extraField.winnerOverride = IDS.teamTwo;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionApplyResult(
          extraField
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "apply_result_fields_invalid"
    );
  });

  test("projects every T-144 monetary field to null and rejects partial public tuples", () => {
    const fullResult = {
      correctionId: IDS.correction,
      allocation: fallbackAllocation(),
      appliedDeltas: [
        {
          resourceType: "contract",
          resourceId: IDS.contract,
          action: "update",
          beforeVersion: 1,
          afterSummary: emptyAfterSummary({
            status: "Active",
            totalValueCents: 900,
            termYears: 3,
            aavCents: 300,
          }),
        },
        {
          resourceType: "activity",
          resourceId: IDS.activity,
          action: "append",
          beforeVersion: null,
          afterSummary: emptyAfterSummary({
            status: "appended",
          }),
        },
      ],
      activityId: IDS.activity,
      completedAtMs: 1_000_001,
    };
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPublicApplyResult(
          fullResult
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "public_apply_money_not_redacted"
    );
    const publicResult =
      projectFreeAgentDraftCorrectionApplyResultForPublic({
        ...fullResult,
      });

    for (const offer of publicResult.allocation.rankedOffers) {
      assert.deepEqual(
        [offer.totalValueCents, offer.termYears, offer.aavCents],
        [null, null, null]
      );
    }
    assert.deepEqual(
      [
        publicResult.allocation.winner.totalValueCents,
        publicResult.allocation.winner.termYears,
        publicResult.allocation.winner.aavCents,
      ],
      [null, null, null]
    );
    assert.deepEqual(
      [
        publicResult.allocation.restricted
          .minimumTotalValueCents,
        publicResult.allocation.restricted.minimumTermYears,
        publicResult.allocation.restricted.minimumAavCents,
      ],
      [null, null, null]
    );
    assert.equal(
      publicResult.allocation.fallback.minimumTotalValueCents,
      null
    );
    for (const delta of publicResult.appliedDeltas) {
      assert.deepEqual(
        [
          delta.afterSummary.totalValueCents,
          delta.afterSummary.termYears,
          delta.afterSummary.aavCents,
        ],
        [null, null, null]
      );
    }
    assert.equal(Object.isFrozen(publicResult), true);
    assert.equal(
      Object.isFrozen(publicResult.allocation.winner),
      true
    );
    assert.deepEqual(
      validateFreeAgentDraftCorrectionPublicApplyResult(
        publicResult
      ),
      publicResult
    );

    const partialAllocation = structuredClone(publicResult);
    partialAllocation.allocation.winner.termYears = 3;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPublicApplyResult(
          partialAllocation
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "allocation_result_invalid"
    );
    const partialDelta = structuredClone(publicResult);
    partialDelta.appliedDeltas[0].afterSummary.aavCents = 300;
    assertPolicyError(
      () =>
        validateFreeAgentDraftCorrectionPublicApplyResult(
          partialDelta
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "applied_deltas_invalid"
    );
  });

  test("projects standalone public allocation results to all-null money and rejects full or partial tuples", () => {
    const fullAllocation = fallbackAllocation();
    assertPolicyError(
      () =>
        validateFreeAgentDraftPublicAllocationResultProjection(
          fullAllocation
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "public_allocation_money_not_redacted"
    );

    const publicAllocation =
      projectFreeAgentDraftAllocationResultForPublic(
        fullAllocation
      );
    for (const offer of publicAllocation.rankedOffers) {
      assert.deepEqual(
        [offer.totalValueCents, offer.termYears, offer.aavCents],
        [null, null, null]
      );
    }
    assert.deepEqual(
      [
        publicAllocation.winner.totalValueCents,
        publicAllocation.winner.termYears,
        publicAllocation.winner.aavCents,
      ],
      [null, null, null]
    );
    assert.deepEqual(
      [
        publicAllocation.restricted.minimumTotalValueCents,
        publicAllocation.restricted.minimumTermYears,
        publicAllocation.restricted.minimumAavCents,
      ],
      [null, null, null]
    );
    assert.equal(
      publicAllocation.fallback.minimumTotalValueCents,
      null
    );
    assert.deepEqual(
      validateFreeAgentDraftPublicAllocationResultProjection(
        publicAllocation
      ),
      publicAllocation
    );

    const partialAllocation = structuredClone(publicAllocation);
    partialAllocation.rankedOffers[0].termYears = 2;
    assertPolicyError(
      () =>
        validateFreeAgentDraftPublicAllocationResultProjection(
          partialAllocation
        ),
      FREE_AGENT_DRAFT_CORRECTION_CODES.resultInvalid,
      "allocation_result_invalid"
    );
  });
});
