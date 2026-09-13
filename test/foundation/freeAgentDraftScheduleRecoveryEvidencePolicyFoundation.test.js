const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_CODES,
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_DOMAIN,
  FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION,
  createFreeAgentDraftScheduleRecoveryEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftScheduleRecoveryEvidencePolicy"
);

const OLD_WEEK_ONE_MS = Date.parse(
  "2026-10-05T07:00:00.000Z"
);
const SECOND_REMOVED_WEEK_MS = Date.parse(
  "2026-10-12T07:00:00.000Z"
);
const NEW_WEEK_ONE_MS = Date.parse(
  "2026-10-19T07:00:00.000Z"
);
const COMPLETED_AT_MS = Date.parse(
  "2026-09-28T20:00:00.000Z"
);
const SAME_JOB_INSTANT_MS = Date.parse(
  "2026-11-02T00:00:00.000Z"
);

function id(value) {
  return (
    "40000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  recovery: id(1),
  league: id(2),
  season: id(3),
  fad: id(4),
  oldOperation: id(5),
  newOperation: id(6),
  oldWeekOne: id(7),
  removedWeekTwo: id(8),
  newWeekOne: id(9),
  removedMatchupOne: id(10),
  removedMatchupTwo: id(11),
  cancelledOldJob: id(12),
  replacedOldJob: id(13),
  replacementJob: id(14),
});

function cancelledEffect(overrides = {}) {
  return {
    disposition: "cancelled",
    jobType: "matchup:baseline",
    oldJobRunId: IDS.cancelledOldJob,
    oldOccurrenceKey:
      `matchup:baseline:${IDS.league}:${IDS.season}:` +
      `${IDS.oldWeekOne}:${IDS.oldOperation}:7:` +
      OLD_WEEK_ONE_MS,
    oldScheduleOperationId: IDS.oldOperation,
    oldScheduleVersion: 7,
    newJobRunId: null,
    newOccurrenceKey: null,
    newScheduleOperationId: null,
    newScheduleVersion: null,
    ...overrides,
  };
}

function replacedEffect(overrides = {}) {
  return {
    disposition: "replaced",
    jobType: "matchup:lock",
    oldJobRunId: IDS.replacedOldJob,
    oldOccurrenceKey:
      `matchup:lock:${IDS.league}:${IDS.season}:` +
      `${IDS.newWeekOne}:${IDS.oldOperation}:7:` +
      SAME_JOB_INSTANT_MS,
    oldScheduleOperationId: IDS.oldOperation,
    oldScheduleVersion: 7,
    newJobRunId: IDS.replacementJob,
    newOccurrenceKey:
      `matchup:lock:${IDS.league}:${IDS.season}:` +
      `${IDS.newWeekOne}:${IDS.newOperation}:8:` +
      SAME_JOB_INSTANT_MS,
    newScheduleOperationId: IDS.newOperation,
    newScheduleVersion: 8,
    ...overrides,
  };
}

function recoveryInput(overrides = {}) {
  return {
    recoveryId: IDS.recovery,
    leagueId: IDS.league,
    seasonId: IDS.season,
    fadId: IDS.fad,
    recoveryKind: "pre_open",
    operationId: IDS.newOperation,
    oldScheduleOperationId: IDS.oldOperation,
    newScheduleOperationId: IDS.newOperation,
    oldScheduleVersion: 7,
    newScheduleVersion: 8,
    oldFirstMatchupWeekId: IDS.oldWeekOne,
    newFirstMatchupWeekId: IDS.newWeekOne,
    oldWeek1StartsAtMs: OLD_WEEK_ONE_MS,
    newWeek1StartsAtMs: NEW_WEEK_ONE_MS,
    completedAtMs: COMPLETED_AT_MS,
    removedWeeks: [
      {
        matchupWeekId: IDS.removedWeekTwo,
        sequence: 2,
        startsAtMs: SECOND_REMOVED_WEEK_MS,
      },
      {
        matchupWeekId: IDS.oldWeekOne,
        sequence: 1,
        startsAtMs: OLD_WEEK_ONE_MS,
      },
    ],
    removedMatchups: [
      {
        matchupId: IDS.removedMatchupTwo,
        matchupWeekId: IDS.removedWeekTwo,
      },
      {
        matchupId: IDS.removedMatchupOne,
        matchupWeekId: IDS.oldWeekOne,
      },
    ],
    jobEffects: [
      replacedEffect(),
      cancelledEffect(),
    ],
    ...overrides,
  };
}

function assertInputInvalid(callback, reasonCode = undefined) {
  assert.throws(callback, (error) => {
    assert.equal(
      error.code,
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_CODES
        .inputInvalid
    );
    if (reasonCode !== undefined) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

describe("FAD-05 schedule-recovery evidence policy", () => {
  test("seals the exact documented preimage in canonical order", () => {
    const input = recoveryInput();
    const evidence =
      createFreeAgentDraftScheduleRecoveryEvidence(input);

    assert.deepEqual(
      Object.keys(evidence.preimage),
      [
        "domain",
        "schemaVersion",
        "recoveryId",
        "leagueId",
        "seasonId",
        "fadId",
        "recoveryKind",
        "operationId",
        "oldScheduleOperationId",
        "newScheduleOperationId",
        "oldScheduleVersion",
        "newScheduleVersion",
        "oldFirstMatchupWeekId",
        "newFirstMatchupWeekId",
        "oldWeek1StartsAtMs",
        "newWeek1StartsAtMs",
        "completedAtMs",
        "removedWeeks",
        "removedMatchups",
        "jobEffects",
      ]
    );
    assert.equal(
      evidence.preimage.domain,
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_DOMAIN
    );
    assert.equal(
      evidence.preimage.schemaVersion,
      FREE_AGENT_DRAFT_SCHEDULE_RECOVERY_EVIDENCE_SCHEMA_VERSION
    );
    assert.deepEqual(
      evidence.preimage.removedWeeks.map(
        ({ matchupWeekId }) => matchupWeekId
      ),
      [IDS.oldWeekOne, IDS.removedWeekTwo]
    );
    assert.deepEqual(
      evidence.preimage.removedMatchups.map(
        ({ matchupId }) => matchupId
      ),
      [IDS.removedMatchupOne, IDS.removedMatchupTwo]
    );
    assert.deepEqual(
      evidence.preimage.jobEffects.map(
        ({ disposition }) => disposition
      ),
      ["cancelled", "replaced"]
    );
    assert.equal(
      evidence.preimage.jobEffects[0].newJobRunId,
      null
    );
    assert.equal(
      evidence.preimage.jobEffects[1].newOccurrenceKey.endsWith(
        `:${SAME_JOB_INSTANT_MS}`
      ),
      true
    );
    assert.equal(
      evidence.preimage.jobEffects[1].oldOccurrenceKey.endsWith(
        `:${SAME_JOB_INSTANT_MS}`
      ),
      true
    );
    assert.equal(
      evidence.evidenceSha256,
      "9f5259e4e9e90e576f76f597d1e694912eee382f946c6eab9a47fb0ef2e395c1"
    );
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.preimage), true);
    assert.equal(
      Object.isFrozen(evidence.preimage.removedWeeks),
      true
    );
    assert.equal(
      Object.isFrozen(evidence.preimage.removedWeeks[0]),
      true
    );
    assert.equal(input.removedWeeks[0].sequence, 2);
  });

  test("is independent of removed-child and job-effect input order", () => {
    const forward =
      createFreeAgentDraftScheduleRecoveryEvidence(
        recoveryInput()
      );
    const reverseInput = recoveryInput();
    reverseInput.removedWeeks.reverse();
    reverseInput.removedMatchups.reverse();
    reverseInput.jobEffects.reverse();
    const reverse =
      createFreeAgentDraftScheduleRecoveryEvidence(
        reverseInput
      );

    assert.equal(
      forward.evidenceSha256,
      reverse.evidenceSha256
    );
    assert.deepEqual(forward.preimage, reverse.preimage);
  });

  test("accepts exact replaced and cancelled job nullability", () => {
    const evidence =
      createFreeAgentDraftScheduleRecoveryEvidence(
        recoveryInput({
          recoveryKind: "completion",
          jobEffects: [
            cancelledEffect(),
            replacedEffect(),
          ],
        })
      );
    assert.deepEqual(
      evidence.preimage.jobEffects.map((effect) => ({
        disposition: effect.disposition,
        newJobRunId: effect.newJobRunId,
        newOccurrenceKey: effect.newOccurrenceKey,
        newScheduleOperationId:
          effect.newScheduleOperationId,
        newScheduleVersion: effect.newScheduleVersion,
      })),
      [
        {
          disposition: "cancelled",
          newJobRunId: null,
          newOccurrenceKey: null,
          newScheduleOperationId: null,
          newScheduleVersion: null,
        },
        {
          disposition: "replaced",
          newJobRunId: IDS.replacementJob,
          newOccurrenceKey:
            replacedEffect().newOccurrenceKey,
          newScheduleOperationId: IDS.newOperation,
          newScheduleVersion: 8,
        },
      ]
    );
  });

  test("rejects mixed replacement nullability", () => {
    assertInputInvalid(
      () => createFreeAgentDraftScheduleRecoveryEvidence(
        recoveryInput({
          jobEffects: [
            replacedEffect({ newJobRunId: null }),
          ],
        })
      ),
      "replaced_job_replacement_incomplete"
    );
    assertInputInvalid(
      () => createFreeAgentDraftScheduleRecoveryEvidence(
        recoveryInput({
          jobEffects: [
            cancelledEffect({
              newScheduleVersion: 8,
            }),
          ],
        })
      ),
      "cancelled_job_replacement_not_null"
    );
  });

  test("rejects malformed closed shapes and inconsistent evidence", () => {
    const extraTopLevel = recoveryInput();
    extraTopLevel.unexpected = true;

    const extraRemovedWeek = recoveryInput();
    extraRemovedWeek.removedWeeks = [
      {
        ...extraRemovedWeek.removedWeeks[1],
        unexpected: true,
      },
    ];

    const noncontiguousWeeks = recoveryInput({
      removedWeeks: [
        {
          matchupWeekId: IDS.oldWeekOne,
          sequence: 1,
          startsAtMs: OLD_WEEK_ONE_MS,
        },
        {
          matchupWeekId: IDS.removedWeekTwo,
          sequence: 3,
          startsAtMs: SECOND_REMOVED_WEEK_MS,
        },
      ],
    });

    const unknownRemovedMatchupWeek = recoveryInput({
      removedMatchups: [
        {
          matchupId: IDS.removedMatchupOne,
          matchupWeekId: id(99),
        },
      ],
    });

    const wrongJobGeneration = recoveryInput({
      jobEffects: [
        replacedEffect({ oldScheduleVersion: 6 }),
      ],
    });

    const wrongScheduleTransition = recoveryInput({
      newScheduleVersion: 9,
    });

    for (const malformed of [
      extraTopLevel,
      extraRemovedWeek,
      noncontiguousWeeks,
      unknownRemovedMatchupWeek,
      wrongJobGeneration,
      wrongScheduleTransition,
    ]) {
      assertInputInvalid(
        () =>
          createFreeAgentDraftScheduleRecoveryEvidence(
            malformed
          )
      );
    }
  });
});
