const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
  FREE_AGENT_DRAFT_READINESS_POLICY_CODES,
  FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
  FreeAgentDraftReadinessPolicyError,
  createFreeAgentDraftReadinessMissingScheduleBlocker,
  createFreeAgentDraftReadinessAttemptEvidence,
  createFreeAgentDraftReadinessRetryReceipt,
  createFreeAgentDraftReadinessRetryRequest,
  createFreeAgentDraftReadinessTriggerPlan,
  normalizeFreeAgentDraftReadinessInternalDiagnostics,
  projectFreeAgentDraftReadinessPublicDiagnostics,
  validateFreeAgentDraftReadinessAttemptEvidence,
  validateFreeAgentDraftReadinessRetryReceipt,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);

const IDS = Object.freeze({
  league: "11111111-1111-4111-8111-111111111111",
  season: "22222222-2222-4222-8222-222222222222",
  readiness:
    "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
  receipt: "55555555-5555-4555-8555-555555555555",
  idempotency:
    "66666666-6666-4666-8666-666666666666",
  membership:
    "77777777-7777-4777-8777-777777777777",
  job: "88888888-8888-4888-8888-888888888888",
  entryDraft:
    "99999999-9999-4999-8999-999999999999",
  exemption:
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  attempt: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  week: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  priorSeason:
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  rollover:
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  teamA: "10101010-1010-4010-8010-101010101010",
  teamB: "20202020-2020-4020-8020-202020202020",
  assignment:
    "30303030-3030-4030-8030-303030303030",
});

const ACCEPTED_AT_MS = 1_780_000_000_000;
const DEADLINE_AT_MS = 1_800_000_000_000;
const INAUGURAL_OCCURRENCE =
  `fad-readiness:${IDS.league}:` +
  `${IDS.season}:${IDS.season}`;

function assertPolicyError(
  callback,
  code,
  reasonCode
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftReadinessPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function retryRequest(overrides = {}) {
  return {
    actorUserId: IDS.actor,
    leagueId: IDS.league,
    expectedVersion: 7,
    clientKey: "retry-key",
    body: {
      seasonId: IDS.season,
      readinessOperationId: IDS.readiness,
      confirmation:
        FREE_AGENT_DRAFT_READINESS_RETRY_CONFIRMATION,
    },
    ...overrides,
  };
}

function receiptInput(overrides = {}) {
  return {
    id: IDS.receipt,
    leagueId: IDS.league,
    seasonId: IDS.season,
    readinessOperationId: IDS.readiness,
    idempotencyRequestId: IDS.idempotency,
    actorUserId: IDS.actor,
    actorMembershipId: IDS.membership,
    actorAuthority: "commissioner",
    requestSha256:
      createFreeAgentDraftReadinessRetryRequest(
        retryRequest()
      ).requestSha256,
    acceptedFromVersion: 7,
    resultingReadinessVersion: 8,
    retryAttemptNumber: 2,
    jobRunId: IDS.job,
    occurrenceKey: INAUGURAL_OCCURRENCE,
    acceptedAtMs: ACCEPTED_AT_MS,
    ...overrides,
  };
}

function readinessRollovers() {
  return Array.from({ length: 7 }, (_, index) => {
    const opensAtMs =
      DEADLINE_AT_MS + index * 86_400_000;
    const rollsOverAtMs = opensAtMs + 86_400_000;
    return {
      creationCutoffAtMs:
        rollsOverAtMs - 3_600_000,
      opensAtMs,
      rollsOverAtMs,
      sequence: index + 1,
    };
  });
}

function safeTeam(teamId, overrides = {}) {
  return {
    logoReference: null,
    name: "Alpha Ravens",
    patternTemplate: "equal-two",
    primaryColour: "#102030",
    secondaryColour: "#f0a020",
    teamId,
    tertiaryColour: null,
    ...overrides,
  };
}

function teamProjection(
  teamId = IDS.teamA,
  overrides = {}
) {
  return {
    carryoverCount: 4,
    managerAssignmentId: IDS.assignment,
    managerReady: true,
    openBenchSlots: 3,
    openDefenceSlots: 5,
    openForwardSlots: 10,
    structuralConflictCount: 0,
    team: safeTeam(teamId),
    teamId,
    ...overrides,
  };
}

function attemptProjection(overrides = {}) {
  return {
    blockers: [
      {
        code: "FAD_MANAGER_MISSING",
        message:
          "Every participating team needs a current manager.",
        resourceId: IDS.teamA,
      },
    ],
    candidateDeadlineAtMs: DEADLINE_AT_MS,
    firstMatchupWeekAfter: {
      sequence: 1,
      startsAtMs: DEADLINE_AT_MS + 604_800_000,
      version: 4,
      weekId: IDS.week,
    },
    firstMatchupWeekBefore: {
      sequence: 1,
      startsAtMs: DEADLINE_AT_MS + 604_800_000,
      version: 3,
      weekId: IDS.week,
    },
    helpOpensAtMs: DEADLINE_AT_MS - 172_800_000,
    initialRollovers: readinessRollovers(),
    observedSeasonVersion: 5,
    participatingTeamCount: 1,
    priorSeasonRollover: {
      completedAtMs: ACCEPTED_AT_MS - 10_000,
      fromSeasonId: IDS.priorSeason,
      manifestSha256: "a".repeat(64),
      rolloverId: IDS.rollover,
      toSeasonId: IDS.season,
    },
    reminderAtMs: DEADLINE_AT_MS - 259_200_000,
    teamProjections: [teamProjection()],
    warnings: [
      {
        code: "FAD_WEEK_ONE_MOVED",
        message:
          "Week 1 must move to preserve the complete FAD period.",
        resourceId: IDS.week,
      },
    ],
    ...overrides,
  };
}

function attemptInput(overrides = {}) {
  return {
    attemptNumber: 1,
    id: IDS.attempt,
    jobRunId: IDS.job,
    leagueId: IDS.league,
    observedAtMs: ACCEPTED_AT_MS,
    observedReadinessVersion: 2,
    outcome: "blocked",
    projection: attemptProjection(),
    readinessOperationId: IDS.readiness,
    recordedAtMs: ACCEPTED_AT_MS + 1_000,
    seasonId: IDS.season,
    ...overrides,
  };
}

function persistedAttempt(evidence) {
  return Object.fromEntries(
    Object.entries(evidence).filter(
      ([key]) => key !== "projection"
    )
  );
}

describe("Free Agent Draft readiness policy", () => {
  test("owns the exact frozen missing-current-schedule blocker", () => {
    const blocker =
      createFreeAgentDraftReadinessMissingScheduleBlocker({
        seasonId: IDS.season,
      });

    assert.deepEqual(blocker, {
      code: "MATCHUP_SCHEDULE_MISSING",
      field: "firstMatchupStartsAtMs",
      message:
        "The first matchup schedule must be confirmed.",
      resourceId: IDS.season,
      resourceType: "season",
    });
    assert.equal(Object.isFrozen(blocker), true);
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessMissingScheduleBlocker({
          seasonId: "not-a-season-id",
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES.inputInvalid,
      "season_id_invalid"
    );
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessMissingScheduleBlocker({
          seasonId: IDS.season,
          reason: "override",
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES.inputInvalid,
      "missing_schedule_blocker_fields_invalid"
    );
  });

  test("builds all three server-owned trigger plans with one canonical readiness job", () => {
    const cases = [
      {
        triggerKind: "entry_draft_completed",
        triggerResourceId: IDS.entryDraft,
        entryDraftId: IDS.entryDraft,
        setupExemptionId: null,
      },
      {
        triggerKind: "no_draft_inaugural",
        triggerResourceId: IDS.season,
        entryDraftId: null,
        setupExemptionId: null,
      },
      {
        triggerKind:
          "no_draft_initial_season2",
        triggerResourceId: IDS.exemption,
        entryDraftId: null,
        setupExemptionId: IDS.exemption,
      },
    ];

    for (const candidate of cases) {
      const plan =
        createFreeAgentDraftReadinessTriggerPlan({
          operationId: IDS.readiness,
          jobRunId: IDS.job,
          leagueId: IDS.league,
          seasonId: IDS.season,
          createdAtMs: ACCEPTED_AT_MS,
          ...candidate,
        });
      assert.deepEqual(plan.job, {
        id: IDS.job,
        leagueId: IDS.league,
        seasonId: IDS.season,
        jobType:
          FREE_AGENT_DRAFT_READINESS_JOB_TYPE,
        occurrenceKey:
          `fad-readiness:${IDS.league}:` +
          `${IDS.season}:` +
          candidate.triggerResourceId,
        scheduledForMs: ACCEPTED_AT_MS,
        status: "pending",
        attemptCount: 0,
        version: 1,
      });
      assert.equal(
        plan.readiness.jobRunId,
        plan.job.id
      );
      assert.equal(
        plan.readiness.occurrenceKey,
        plan.job.occurrenceKey
      );
      assert.ok(Object.isFrozen(plan));
      assert.ok(Object.isFrozen(plan.readiness));
      assert.ok(Object.isFrozen(plan.job));
    }
  });

  test("rejects arbitrary inaugural identity and mixed trigger evidence", () => {
    const base = {
      operationId: IDS.readiness,
      jobRunId: IDS.job,
      leagueId: IDS.league,
      seasonId: IDS.season,
      createdAtMs: ACCEPTED_AT_MS,
      triggerKind: "no_draft_inaugural",
      triggerResourceId: IDS.entryDraft,
      entryDraftId: null,
      setupExemptionId: null,
    };
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessTriggerPlan(
          base
        ),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .inputInvalid,
      "trigger_evidence_invalid"
    );
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessTriggerPlan({
          ...base,
          triggerKind: "entry_draft_completed",
          triggerResourceId: IDS.entryDraft,
          entryDraftId: IDS.entryDraft,
          setupExemptionId: IDS.exemption,
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .inputInvalid,
      "trigger_evidence_invalid"
    );
  });

  test("creates and validates one immutable blocked readiness-attempt snapshot", () => {
    const evidence =
      createFreeAgentDraftReadinessAttemptEvidence(
        attemptInput()
      );
    assert.equal(
      evidence.projectionSha256,
      "4d34a166fdcc896370b7d29309b07970069991f7c7861f30d977b1d9a55a280a"
    );
    assert.deepEqual(
      validateFreeAgentDraftReadinessAttemptEvidence(
        persistedAttempt(evidence)
      ),
      evidence
    );
    assert.equal(evidence.version, 1);
    assert.equal(evidence.outcome, "blocked");
    assert.equal(evidence.projection.blockers.length, 1);
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(evidence.projection));
    assert.ok(
      Object.isFrozen(
        evidence.projection.initialRollovers
      )
    );
    assert.ok(
      Object.isFrozen(
        evidence.projection.teamProjections[0].team
      )
    );
  });

  test("pins a distinct succeeded readiness-attempt snapshot with no blockers", () => {
    const evidence =
      createFreeAgentDraftReadinessAttemptEvidence(
        attemptInput({
          outcome: "succeeded",
          projection: attemptProjection({ blockers: [] }),
        })
      );
    assert.equal(
      evidence.projectionSha256,
      "f341df0620bc29ec0e78b527f9671fbb570a692dd1f5e08b2e1f06c2d98f054a"
    );
    assert.deepEqual(evidence.projection.blockers, []);
    assert.deepEqual(
      validateFreeAgentDraftReadinessAttemptEvidence(
        persistedAttempt(evidence)
      ),
      evidence
    );
  });

  test("allows successful opening evidence to project an editable carried-roster conflict", () => {
    const warning = {
      code: "FAD_CARRYOVER_STRUCTURAL_CONFLICT",
      message:
        "The carried-roster conflict remains editable before the deadline.",
      resourceId: IDS.teamA,
    };
    const evidence =
      createFreeAgentDraftReadinessAttemptEvidence(
        attemptInput({
          outcome: "succeeded",
          projection: attemptProjection({
            blockers: [],
            teamProjections: [
              teamProjection(IDS.teamA, {
                carryoverCount: 5,
                structuralConflictCount: 1,
              }),
            ],
            warnings: [warning],
          }),
        })
      );
    assert.equal(evidence.outcome, "succeeded");
    assert.equal(
      evidence.projection.teamProjections[0]
        .structuralConflictCount,
      1
    );
    assert.deepEqual(
      evidence.projection.warnings,
      [warning]
    );
  });

  test("accepts the explicit pre-clock empty projection and preserves diagnostic order", () => {
    const first = attemptProjection().blockers[0];
    const second = {
      code: "FAD_ROLLOVER_MISSING",
      message:
        "The prior season rollover is not ready.",
      resourceId: IDS.rollover,
    };
    const evidence =
      createFreeAgentDraftReadinessAttemptEvidence(
        attemptInput({
          projection: attemptProjection({
            blockers: [first, second],
            candidateDeadlineAtMs: null,
            firstMatchupWeekAfter: null,
            firstMatchupWeekBefore: null,
            helpOpensAtMs: null,
            initialRollovers: [],
            participatingTeamCount: 0,
            priorSeasonRollover: null,
            reminderAtMs: null,
            teamProjections: [],
            warnings: [],
          }),
        })
      );
    assert.deepEqual(
      evidence.projection.blockers.map(
        (diagnostic) => diagnostic.code
      ),
      ["FAD_MANAGER_MISSING", "FAD_ROLLOVER_MISSING"]
    );
    assert.deepEqual(
      evidence.projection.initialRollovers,
      []
    );
    assert.equal(
      evidence.projection.candidateDeadlineAtMs,
      null
    );
  });

  test("projects ordered internal blockers to the exact public diagnostic shape", () => {
    const internal = [
      {
        code: "FAD_ROLLOVER_MISSING",
        field: null,
        message:
          "The prior season rollover is not ready.",
        resourceId: IDS.rollover,
        resourceType: "season_rollover",
      },
      {
        code: "FAD_MANAGER_MISSING",
        field: "managerAssignmentId",
        message:
          "Every participating team needs a current manager.",
        resourceId: IDS.teamA,
        resourceType: "team",
      },
    ];
    const canonical =
      normalizeFreeAgentDraftReadinessInternalDiagnostics(
        internal
      );
    const projected =
      projectFreeAgentDraftReadinessPublicDiagnostics(
        internal
      );
    assert.deepEqual(
      canonical.map((diagnostic) => diagnostic.code),
      ["FAD_MANAGER_MISSING", "FAD_ROLLOVER_MISSING"]
    );
    assert.deepEqual(
      projected,
      canonical.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        resourceId: diagnostic.resourceId,
      }))
    );
    assert.ok(Object.isFrozen(canonical));
    assert.ok(Object.isFrozen(canonical[0]));
    assert.ok(Object.isFrozen(projected));
    assert.ok(Object.isFrozen(projected[0]));
    assertPolicyError(
      () =>
        projectFreeAgentDraftReadinessPublicDiagnostics([
          { ...internal[0], extra: true },
        ]),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "readiness_internal_diagnostics_invalid"
    );
  });

  test("rejects malformed readiness-attempt clocks, rollovers, weeks, rollover evidence, teams, and diagnostics", () => {
    const diagnostic =
      attemptProjection().blockers[0];
    const cases = [
      [
        attemptInput({
          projection: {
            ...attemptProjection(),
            extra: true,
          },
        }),
        "readiness_attempt_projection_fields_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            reminderAtMs: null,
          }),
        }),
        "readiness_clock_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            helpOpensAtMs:
              DEADLINE_AT_MS - 172_800_001,
          }),
        }),
        "readiness_clock_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            initialRollovers: readinessRollovers().map(
              (rollover, index) =>
                index === 6
                  ? {
                      ...rollover,
                      rollsOverAtMs:
                        rollover.rollsOverAtMs + 1,
                    }
                  : rollover
            ),
          }),
        }),
        "initial_rollover_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            firstMatchupWeekAfter: {
              ...attemptProjection()
                .firstMatchupWeekAfter,
              extra: true,
            },
          }),
        }),
        "first_matchup_week_after_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            firstMatchupWeekAfter: {
              ...attemptProjection()
                .firstMatchupWeekAfter,
              sequence: 2,
            },
          }),
        }),
        "first_matchup_week_after_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            candidateDeadlineAtMs:
              DEADLINE_AT_MS + 1,
          }),
        }),
        "readiness_clock_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            firstMatchupWeekAfter: {
              ...attemptProjection()
                .firstMatchupWeekAfter,
              startsAtMs:
                attemptProjection()
                  .firstMatchupWeekBefore
                  .startsAtMs - 1,
            },
          }),
        }),
        "readiness_week_transition_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            priorSeasonRollover: {
              ...attemptProjection()
                .priorSeasonRollover,
              toSeasonId: IDS.priorSeason,
            },
          }),
        }),
        "prior_season_rollover_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            participatingTeamCount: 2,
          }),
        }),
        "team_projections_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            teamProjections: [
              teamProjection(IDS.teamB),
              teamProjection(IDS.teamA),
            ],
            participatingTeamCount: 2,
          }),
        }),
        "team_projections_order_invalid",
      ],
      ...[
        { openForwardSlots: 13 },
        { openDefenceSlots: 7 },
        { openBenchSlots: 5 },
        {
          carryoverCount: 0,
          structuralConflictCount: 1,
        },
        { carryoverCount: 5 },
      ].map((overrides) => [
        attemptInput({
          projection: attemptProjection({
            teamProjections: [
              teamProjection(IDS.teamA, overrides),
            ],
          }),
        }),
        "team_projection_invalid",
      ]),
      [
        attemptInput({
          projection: attemptProjection({
            teamProjections: [
              teamProjection(IDS.teamA, {
                managerReady: false,
              }),
            ],
          }),
        }),
        "team_projection_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            blockers: [
              { ...diagnostic, field: "manager" },
            ],
          }),
        }),
        "readiness_blockers_invalid",
      ],
      [
        attemptInput({
          projection: attemptProjection({
            blockers: [diagnostic, diagnostic],
          }),
        }),
        "readiness_blockers_invalid_duplicate",
      ],
      [
        attemptInput({
          projection: attemptProjection({ blockers: [] }),
        }),
        "readiness_attempt_outcome_invalid",
      ],
      [
        attemptInput({
          outcome: "succeeded",
        }),
        "readiness_attempt_outcome_invalid",
      ],
      [
        attemptInput({
          outcome: "succeeded",
          projection: attemptProjection({
            blockers: [],
            candidateDeadlineAtMs: null,
            firstMatchupWeekAfter: null,
            firstMatchupWeekBefore: null,
            helpOpensAtMs: null,
            initialRollovers: [],
            participatingTeamCount: 0,
            priorSeasonRollover: null,
            reminderAtMs: null,
            teamProjections: [],
            warnings: [],
          }),
        }),
        "readiness_attempt_success_projection_incomplete",
      ],
      [
        attemptInput({
          observedAtMs: DEADLINE_AT_MS,
          outcome: "succeeded",
          projection: attemptProjection({ blockers: [] }),
          recordedAtMs: DEADLINE_AT_MS,
        }),
        "readiness_attempt_success_projection_incomplete",
      ],
      [
        attemptInput({
          outcome: "succeeded",
          projection: attemptProjection({
            blockers: [],
            teamProjections: [
              teamProjection(IDS.teamA, {
                managerAssignmentId: null,
                managerReady: false,
              }),
            ],
          }),
        }),
        "readiness_attempt_success_projection_incomplete",
      ],
      [
        attemptInput({
          recordedAtMs: ACCEPTED_AT_MS - 1,
        }),
        "recorded_at_ms_invalid",
      ],
    ];
    for (const [input, reasonCode] of cases) {
      assertPolicyError(
        () =>
          createFreeAgentDraftReadinessAttemptEvidence(
            input
          ),
        FREE_AGENT_DRAFT_READINESS_POLICY_CODES
          .resultInvalid,
        reasonCode
      );
    }
  });

  test("fails closed for tampered persisted attempt JSON, hash, version, and receipt request hash", () => {
    const evidence =
      createFreeAgentDraftReadinessAttemptEvidence(
        attemptInput()
      );
    const persisted = persistedAttempt(evidence);
    assertPolicyError(
      () =>
        validateFreeAgentDraftReadinessAttemptEvidence({
          ...persisted,
          projectionJson: ` ${persisted.projectionJson}`,
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "readiness_attempt_projection_json_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftReadinessAttemptEvidence({
          ...persisted,
          projectionSha256: "0".repeat(64),
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "readiness_attempt_evidence_invalid"
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftReadinessAttemptEvidence({
          ...persisted,
          version: 2,
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "readiness_attempt_evidence_invalid"
    );
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessRetryReceipt(
          receiptInput({
            requestSha256: "0".repeat(64),
          })
        ),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "request_sha256_invalid"
    );
  });

  test("pins the exact T-128 request representation and hash while excluding the client key", () => {
    const request =
      createFreeAgentDraftReadinessRetryRequest(
        retryRequest()
      );
    assert.equal(
      request.requestJson,
      '{"actorUserId":"44444444-4444-4444-8444-444444444444","body":{"confirmation":"RETRY FREE AGENT DRAFT READINESS","readinessOperationId":"33333333-3333-4333-8333-333333333333","seasonId":"22222222-2222-4222-8222-222222222222"},"domain":"hundo-leago.free-agent-draft-readiness-retry-request","expectedVersion":7,"leagueId":"11111111-1111-4111-8111-111111111111","operation":"free_agent_draft.readiness.retry.v1","schemaVersion":1}'
    );
    assert.equal(
      request.requestSha256,
      "34b7bc6151b38360027923600024dac02493e90b8d18d57bcd6ab0ab1a984390"
    );
    const differentClientKey =
      createFreeAgentDraftReadinessRetryRequest(
        retryRequest({ clientKey: "another-key" })
      );
    assert.equal(
      differentClientKey.requestSha256,
      request.requestSha256
    );
    assert.ok(Object.isFrozen(request));
  });

  test("rejects unknown setup fields and an inexact retry confirmation", () => {
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessRetryRequest({
          ...retryRequest(),
          openingTimeMs: ACCEPTED_AT_MS,
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .inputInvalid,
      "retry_request_fields_invalid"
    );
    assertPolicyError(
      () =>
        createFreeAgentDraftReadinessRetryRequest({
          ...retryRequest(),
          body: {
            ...retryRequest().body,
            confirmation:
              "retry free agent draft readiness",
          },
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .inputInvalid,
      "confirmation_invalid"
    );
  });

  test("creates and validates the immutable exact 202 retry receipt data", () => {
    const receipt =
      createFreeAgentDraftReadinessRetryReceipt(
        receiptInput()
      );
    assert.deepEqual(receipt.data, {
      acceptedAtMs: ACCEPTED_AT_MS,
      acceptedFromVersion: 7,
      jobRunId: IDS.job,
      leagueId: IDS.league,
      occurrenceKey: INAUGURAL_OCCURRENCE,
      readinessOperationId: IDS.readiness,
      resultingReadinessVersion: 8,
      retryAttemptNumber: 2,
      retryReceiptId: IDS.receipt,
      seasonId: IDS.season,
      status: "accepted",
    });
    assert.equal(receipt.responseHttpStatus, 202);
    assert.equal(
      receipt.responseJson,
      '{"acceptedAtMs":1780000000000,"acceptedFromVersion":7,"jobRunId":"88888888-8888-4888-8888-888888888888","leagueId":"11111111-1111-4111-8111-111111111111","occurrenceKey":"fad-readiness:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:22222222-2222-4222-8222-222222222222","readinessOperationId":"33333333-3333-4333-8333-333333333333","resultingReadinessVersion":8,"retryAttemptNumber":2,"retryReceiptId":"55555555-5555-4555-8555-555555555555","seasonId":"22222222-2222-4222-8222-222222222222","status":"accepted"}'
    );
    assert.equal(
      receipt.responseSha256,
      "fd303052bdac7a298381ed9874bcba6c7bb6679525766894013e77d5bda0d5a1"
    );
    const validated =
      validateFreeAgentDraftReadinessRetryReceipt(
        Object.fromEntries(
          Object.entries(receipt).filter(
            ([key]) => key !== "data"
          )
        )
      );
    assert.deepEqual(validated, receipt);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.data));
  });

  test("fails closed for nonincrementing versions, wrong scope, authority, or persisted response evidence", () => {
    const cases = [
      [
        { resultingReadinessVersion: 7 },
        "resulting_readiness_version_invalid",
      ],
      [
        { resultingReadinessVersion: 9 },
        "resulting_readiness_version_invalid",
      ],
      [
        { actorAuthority: "platform_administrator" },
        "actor_authority_invalid",
      ],
      [
        {
          occurrenceKey:
            `fad-readiness:${IDS.league}:` +
            `${IDS.entryDraft}:${IDS.season}`,
        },
        "occurrence_key_invalid",
      ],
    ];
    for (const [overrides, reasonCode] of cases) {
      assertPolicyError(
        () =>
          createFreeAgentDraftReadinessRetryReceipt(
            receiptInput(overrides)
          ),
        FREE_AGENT_DRAFT_READINESS_POLICY_CODES
          .resultInvalid,
        reasonCode
      );
    }

    const receipt =
      createFreeAgentDraftReadinessRetryReceipt(
        receiptInput()
      );
    const persisted = Object.fromEntries(
      Object.entries(receipt).filter(
        ([key]) => key !== "data"
      )
    );
    assertPolicyError(
      () =>
        validateFreeAgentDraftReadinessRetryReceipt({
          ...persisted,
          responseSha256:
            "0".repeat(64),
        }),
      FREE_AGENT_DRAFT_READINESS_POLICY_CODES
        .resultInvalid,
      "retry_receipt_evidence_invalid"
    );
  });
});
