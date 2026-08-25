const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES,
  FreeAgentDraftOpeningReadinessPolicyError,
  finalizeFreeAgentDraftOpeningReadiness,
  inspectFreeAgentDraftOpeningReadiness,
  projectFreeAgentDraftCarryovers,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftOpeningReadinessPolicy"
);
const {
  createFreeAgentDraftReadinessAttemptEvidence,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  commissionerMembership: uuid(3),
  readiness: uuid(4),
  readinessJob: uuid(5),
  teamA: uuid(10),
  teamB: uuid(11),
  managerA: uuid(12),
  managerB: uuid(13),
  membershipA: uuid(14),
  membershipB: uuid(15),
  assignmentA: uuid(16),
  assignmentB: uuid(17),
  scheduleOperation: uuid(20),
  replacementScheduleOperation: uuid(23),
  weekOne: uuid(21),
  replacementWeek: uuid(22),
  entryDraft: uuid(30),
  exemption: uuid(31),
  priorSeason: uuid(32),
  rollover: uuid(33),
  attempt: uuid(34),
});

const OBSERVED_AT_MS = Date.parse(
  "2026-08-08T16:00:00.000Z"
);
const WEEK_ONE_AT_MS = Date.parse(
  "2026-10-12T07:00:00.000Z"
);
const PLAYOFFS_AT_MS = Date.parse(
  "2027-03-15T07:00:00.000Z"
);
const SEASON_END_AT_MS = Date.parse(
  "2027-04-12T07:00:00.000Z"
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function occurrence(triggerResourceId = IDS.season) {
  return (
    `fad-readiness:${IDS.league}:` +
    `${IDS.season}:${triggerResourceId}`
  );
}

function team(
  teamId = IDS.teamA,
  name = "Alpha Ravens"
) {
  return {
    teamId,
    name,
    status: "active",
    primaryColour: "#102030",
    secondaryColour: "#f0a020",
    tertiaryColour: null,
    patternTemplate: "equal-two",
    logoReference: null,
    version: 1,
  };
}

function manager({
  teamId = IDS.teamA,
  assignmentId = IDS.assignmentA,
  userId = IDS.managerA,
  membershipId = IDS.membershipA,
} = {}) {
  return {
    managerAssignmentId: assignmentId,
    teamId,
    userId,
    membershipId,
    assignmentStatus: "accepted",
    acceptedAtMs: OBSERVED_AT_MS - 10_000,
    endedAtMs: null,
    version: 1,
    membershipStatus: "active",
    userStatus: "active",
  };
}

function context() {
  const occurrenceKey = occurrence();
  const startedAtMs = OBSERVED_AT_MS - 100;
  const createdAtMs = OBSERVED_AT_MS - 10_000;
  return {
    activeContracts: [],
    allContracts: [],
    allContractYears: [],
    buyoutObligations: [],
    buyoutYears: [],
    currentPlayerSources: [],
    currentSchedule: {
      operationId: IDS.scheduleOperation,
      version: 1,
      generationVersion: 1,
      weekId: IDS.weekOne,
      startsAtMs: WEEK_ONE_AT_MS,
      createdAtMs: 4,
    },
    currentScheduleJobBindings: [],
    currentScheduleOperation: {
      operationId: IDS.scheduleOperation,
      seasonId: IDS.season,
      operationType: "schedule_generate",
      status: "succeeded",
      startedAtMs: 3,
      completedAtMs: 4,
    },
    entryDraft: null,
    existingFad: null,
    firstMatchupWeek: {
      weekId: IDS.weekOne,
      sequence: 1,
      startsAtMs: WEEK_ONE_AT_MS,
      version: 1,
    },
    league: {
      leagueId: IDS.league,
      status: "active",
      timeZone: "America/Vancouver",
      currentSeasonId: IDS.season,
      commissionerMembershipId:
        IDS.commissionerMembership,
      version: 1,
    },
    leaguePositionOverrides: [],
    leagueSettings: {
      leagueId: IDS.league,
      salaryCapCents: 100_000,
      maximumTeams: 20,
      activeForwardSlots: 12,
      activeDefenceSlots: 6,
      benchSlots: 4,
      maximumBenchAavCents: 400,
      injuredReserveSlots: 4,
      prospectSlotsUnlimited: 1,
      version: 1,
    },
    managerAssignments: [manager()],
    ownerships: [],
    participatingTeams: [team()],
    priorSeason: null,
    priorSeasonBuyoutYears: [],
    priorSeasonContractYears: [],
    priorSeasonRollovers: [],
    priorSeasonRolloverItems: [],
    priorSeasonRolloverOwnershipReceipt: null,
    priorSeasonRolloverReceipt: null,
    priorSeasonRetentionYears: [],
    readinessJob: {
      jobRunId: IDS.readinessJob,
      leagueId: IDS.league,
      seasonId: IDS.season,
      jobType: "fad_readiness",
      occurrenceKey,
      scheduledForMs: createdAtMs,
      status: "running",
      attemptCount: 1,
      leaseOwner: "fad-readiness-worker",
      leaseToken: "lease-token",
      leaseExpiresAtMs: OBSERVED_AT_MS + 60_000,
      startedAtMs,
      completedAtMs: null,
      resultJson: null,
      lastErrorCode: null,
      nextAttemptAtMs: null,
      createdAtMs,
      updatedAtMs: startedAtMs,
      version: 2,
    },
    readinessOperation: {
      operationId: IDS.readiness,
      leagueId: IDS.league,
      seasonId: IDS.season,
      occurrenceKey,
      triggerKind: "no_draft_inaugural",
      entryDraftId: null,
      setupExemptionId: null,
      jobRunId: IDS.readinessJob,
      status: "running",
      attemptCount: 1,
      leaseOwner: "fad-readiness-worker",
      leaseToken: "lease-token",
      leaseExpiresAtMs: OBSERVED_AT_MS + 60_000,
      blockersJson: "[]",
      matchupScheduleVersionBefore: null,
      matchupScheduleVersionAfter: null,
      scheduleRecoveryId: null,
      createdFadId: null,
      reminderJobRunId: null,
      deadlineJobRunId: null,
      cardsOpenedActivityId: null,
      cardsOpenedOutboxEventId: null,
      startedAtMs,
      nextRetryAtMs: null,
      terminalAtMs: null,
      createdAtMs,
      updatedAtMs: startedAtMs,
      version: 2,
    },
    retentionObligations: [],
    retentionYears: [],
    rosterOrderEntries: [],
    rosterOrderSets: [],
    season: {
      seasonId: IDS.season,
      label: "2026-27",
      nhlSeasonKey: "20262027",
      status: "active",
      regularSeasonStartsAtMs: WEEK_ONE_AT_MS,
      regularSeasonEndsAtMs: SEASON_END_AT_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_AT_MS,
      fantasyPlayoffsEndAtMs: SEASON_END_AT_MS,
      freeAgentDraftCompletedAtMs: null,
      version: 1,
    },
    setupExemptions: [],
    targetContractYears: [],
  };
}

function inspectionInput(
  currentContext = context(),
  observedAtMs = OBSERVED_AT_MS
) {
  return {
    observedAtMs,
    leagueId: IDS.league,
    seasonId: IDS.season,
    occurrenceKey:
      currentContext.readinessOperation.occurrenceKey,
    context: currentContext,
  };
}

function targetScheduleFor(
  inspection,
  overrides = {}
) {
  const recoveryRequired =
    inspection.scheduleDecision.recoveryRequired;
  return {
    operationId: recoveryRequired
      ? IDS.replacementScheduleOperation
      : inspection.currentSchedule.operationId,
    version:
      inspection.currentSchedule.version +
      (recoveryRequired ? 1 : 0),
    weekOneMatchupWeekId: recoveryRequired
      ? IDS.replacementWeek
      : inspection.currentSchedule.weekOneMatchupWeekId,
    weekOneStartsAtMs:
      inspection.scheduleDecision.firstWeekStartsAtMs,
    ...overrides,
  };
}

function finalizeSuccess(
  inspection,
  {
    openedAtMs = inspection.observedAtMs,
    targetSchedule = targetScheduleFor(inspection),
  } = {}
) {
  return finalizeFreeAgentDraftOpeningReadiness({
    inspection,
    openedAtMs,
    targetSchedule,
  });
}

function finalizeBlocked(inspection) {
  return finalizeFreeAgentDraftOpeningReadiness({
    inspection,
    openedAtMs: null,
    targetSchedule: null,
  });
}

function assertPolicyError(
  callback,
  code,
  reasonCode
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftOpeningReadinessPolicyError
    );
    assert.equal(error.code, code);
    if (reasonCode) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

function addCarryover(
  target,
  {
    base,
    teamId = IDS.teamA,
    position = "F",
    rosterCategory = "Active",
    slotNumber = 1,
    contractType = "normal",
    totalValueCents = 600,
    termYears = 2,
    aavCents = 300,
  }
) {
  const ownershipId = uuid(base);
  const playerId = uuid(base + 1);
  const contractId = uuid(base + 2);
  const currentYearId = uuid(base + 3);
  target.ownerships.push({
    ownershipId,
    teamId,
    playerId,
    ownershipKind: "Rostered",
    rosterCategory,
    positionGroup: position,
    slotNumber,
    version: 1,
    playerStatus: "active",
  });
  const contract = {
    contractId,
    playerId,
    currentTeamId: teamId,
    contractType,
    originalTotalValueCents: totalValueCents,
    originalTermYears: termYears,
    aavCents,
    startSeasonId: IDS.season,
    status: "active",
    version: 1,
  };
  target.activeContracts.push(contract);
  target.allContracts.push(clone(contract));
  target.targetContractYears.push({
    contractYearId: currentYearId,
    contractId,
    seasonId: IDS.season,
    yearNumber: 1,
    aavCents,
    status: "current",
  });
  for (
    let yearNumber = 1;
    yearNumber <= termYears;
    yearNumber += 1
  ) {
    target.allContractYears.push({
      contractYearId:
        yearNumber === 1
          ? currentYearId
          : uuid(base + 3 + yearNumber),
      leagueId: IDS.league,
      contractId,
      seasonId:
        yearNumber === 1
          ? IDS.season
          : uuid(base + 50 + yearNumber),
      yearNumber,
      aavCents,
      status:
        yearNumber === 1 ? "current" : "future",
      rolloverAtMs: null,
      createdAtMs: 1,
    });
  }
  target.currentPlayerSources.push({
    playerSourceStateId: uuid(base + 40),
    playerId,
    provider: "sportsdataio",
    normalizedPosition: position,
    active: true,
    effectiveAtMs: 1,
  });
  return {
    ownershipId,
    playerId,
    contractId,
  };
}

function addRetention(
  target,
  {
    base,
    contractId,
    amountCents,
    originatingTeamId = IDS.teamA,
    responsibleTeamId = IDS.teamA,
    status = "active",
    firstContractYearNumber = 1,
  }
) {
  const obligationId = uuid(base);
  const contract = target.allContracts.find(
    ({ contractId: id }) => id === contractId
  );
  assert.ok(contract);
  const contractYears = target.allContractYears
    .filter(({ contractId: id }) => id === contractId)
    .sort((left, right) => left.yearNumber - right.yearNumber)
    .filter(
      ({ yearNumber }) =>
        yearNumber >= firstContractYearNumber
    );
  target.retentionObligations.push({
    obligationId,
    leagueId: IDS.league,
    contractId,
    playerId: contract.playerId,
    originatingTeamId,
    responsibleTeamId,
    retainedAavCents: amountCents,
    creationTradeId: uuid(base + 1),
    status,
    createdAtMs: 1,
    updatedAtMs: 1,
    version: 1,
  });
  for (const [index, contractYear] of contractYears.entries()) {
    const activeStatus =
      contractYear.seasonId === IDS.season
        ? "current"
        : contractYear.yearNumber <
            contractYears.find(
              ({ seasonId }) => seasonId === IDS.season
            )?.yearNumber
          ? "completed"
          : "future";
    target.retentionYears.push({
      retentionYearId: uuid(base + 2 + index),
      leagueId: IDS.league,
      retentionObligationId: obligationId,
      seasonId: contractYear.seasonId,
      retainedAavCents: amountCents,
      status:
        status === "active"
          ? activeStatus
          : status === "cancelled"
            ? "cancelled"
            : "completed",
      createdAtMs: 1,
    });
  }
  return obligationId;
}

function addBuyout(
  target,
  {
    base,
    aavCents = 600,
    termYears = 2,
    teamId = IDS.teamA,
    playerId = uuid(base + 1),
    annualPenaltyBasisCents = Math.round(aavCents * 0.25),
  }
) {
  const contractId = uuid(base + 2);
  const obligationId = uuid(base + 3);
  const contract = {
    contractId,
    playerId,
    currentTeamId: teamId,
    contractType: "normal",
    originalTotalValueCents: aavCents * termYears,
    originalTermYears: termYears,
    aavCents,
    startSeasonId: IDS.season,
    status: "eliminated",
    version: 2,
  };
  target.allContracts.push(contract);
  for (let yearNumber = 1; yearNumber <= termYears; yearNumber += 1) {
    const contractYearId = uuid(base + 3 + yearNumber);
    const seasonId =
      yearNumber === 1
        ? IDS.season
        : uuid(base + 30 + yearNumber);
    target.allContractYears.push({
      contractYearId,
      leagueId: IDS.league,
      contractId,
      seasonId,
      yearNumber,
      aavCents,
      status: "eliminated",
      rolloverAtMs: 1,
      createdAtMs: 1,
    });
    if (yearNumber === 1) {
      target.targetContractYears.push({
        contractYearId,
        contractId,
        seasonId,
        yearNumber,
        aavCents,
        status: "eliminated",
      });
    }
    target.buyoutYears.push({
      buyoutYearId: uuid(base + 10 + yearNumber),
      leagueId: IDS.league,
      buyoutObligationId: obligationId,
      seasonId,
      penaltyCents: annualPenaltyBasisCents,
      status: yearNumber === 1 ? "current" : "future",
      createdAtMs: 1,
    });
  }
  target.buyoutObligations.push({
    obligationId,
    leagueId: IDS.league,
    contractId,
    playerId,
    originatingTeamId: teamId,
    responsibleTeamId: teamId,
    annualPenaltyBasisCents,
    buyoutTransactionId: uuid(base + 20),
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    version: 1,
  });
  return { contractId, obligationId, playerId };
}

function blockerCodes(source) {
  return inspectFreeAgentDraftOpeningReadiness(
    inspectionInput(source)
  ).internalBlockers.map(({ code }) => code);
}

describe("Free Agent Draft opening readiness policy", () => {
  test("opens an empty inaugural league with exact frozen clock and attempt evidence", () => {
    const source = context();
    const before = clone(source);
    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    const result = finalizeSuccess(inspection);

    assert.equal(inspection.readyForSchedulePlanning, true);
    assert.deepEqual(inspection.setup, {
      setupPath: "no_draft_inaugural",
      entryDraftId: null,
      setupExemptionId: null,
      priorSeasonRolloverId: null,
      noDraftReason: "Inaugural league season.",
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.opening.clock.candidateDeadlineAtMs,
      WEEK_ONE_AT_MS - 7 * 86_400_000);
    assert.equal(result.opening.clock.reminderAtMs,
      WEEK_ONE_AT_MS - 10 * 86_400_000);
    assert.equal(
      result.opening.clock.initialRollovers.length,
      7
    );
    assert.deepEqual(
      result.attemptProjection.teamProjections.map(
        ({
          carryoverCount,
          openForwardSlots,
          openDefenceSlots,
          openBenchSlots,
          structuralConflictCount,
        }) => ({
          carryoverCount,
          openForwardSlots,
          openDefenceSlots,
          openBenchSlots,
          structuralConflictCount,
        })
      ),
      [
        {
          carryoverCount: 0,
          openForwardSlots: 12,
          openDefenceSlots: 6,
          openBenchSlots: 4,
          structuralConflictCount: 0,
        },
      ]
    );
    const attempt =
      createFreeAgentDraftReadinessAttemptEvidence({
        id: IDS.attempt,
        leagueId: IDS.league,
        seasonId: IDS.season,
        readinessOperationId: IDS.readiness,
        jobRunId: IDS.readinessJob,
        attemptNumber: 1,
        observedReadinessVersion: 2,
        outcome: result.outcome,
        observedAtMs: OBSERVED_AT_MS,
        recordedAtMs: OBSERVED_AT_MS,
        projection: result.attemptProjection,
      });
    assert.equal(attempt.outcome, "succeeded");
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      Object.isFrozen(
        result.attemptProjection.teamProjections[0]
      ),
      true
    );
    assert.deepEqual(source, before);
  });

  test("accepts completed Entry Draft rollover and exact one-time Season 2 setup paths", () => {
    const continuing = context();
    const key = occurrence(IDS.entryDraft);
    continuing.readinessOperation.occurrenceKey = key;
    continuing.readinessJob.occurrenceKey = key;
    continuing.readinessOperation.triggerKind =
      "entry_draft_completed";
    continuing.readinessOperation.entryDraftId =
      IDS.entryDraft;
    continuing.entryDraft = {
      entryDraftId: IDS.entryDraft,
      status: "Complete",
      completedAtMs: OBSERVED_AT_MS - 50_000,
      version: 4,
    };
    continuing.priorSeason = {
      seasonId: IDS.priorSeason,
      nhlSeasonKey: "20252026",
      status: "completed",
      freeAgentDraftCompletedAtMs:
        OBSERVED_AT_MS - 100_000,
      version: 9,
    };
    continuing.priorSeasonRollovers = [
      {
        rolloverId: IDS.rollover,
        fromSeasonId: IDS.priorSeason,
        toSeasonId: IDS.season,
        completedAtMs: OBSERVED_AT_MS - 60_000,
        manifestSha256: "a".repeat(64),
        status: "succeeded",
        version: 1,
      },
    ];
    continuing.priorSeasonRolloverReceipt = {
      leagueId: IDS.league,
      rolloverId: IDS.rollover,
      rolloverAttemptId: uuid(35),
      fromSeasonId: IDS.priorSeason,
      toSeasonId: IDS.season,
      fromSeasonStatus: "completed",
      toSeasonStatus: "active",
      targetNhlSeasonKey: "20262027",
      nhlRegularSeasonStartsAtMs: WEEK_ONE_AT_MS,
      nhlRegularSeasonEndsAtMs: SEASON_END_AT_MS,
      fantasyPlayoffsStartAtMs: PLAYOFFS_AT_MS,
      fantasyPlayoffsEndAtMs: SEASON_END_AT_MS,
      sourceReadinessSchemaVersion: 1,
      sourceReadinessSha256: "b".repeat(64),
      entryDraftId: IDS.entryDraft,
      entryDraftRolloverBindingId: uuid(36),
      rolloverOccurrenceId: uuid(37),
      targetScheduleId: uuid(38),
      weekOneMatchupWeekId: IDS.weekOne,
      firstPickClockId: uuid(39),
      trigger: "scheduled_job",
      completedAtMs: OBSERVED_AT_MS - 60_000,
      summary: {
        contractsAdvanced: 0,
        contractsExpired: 0,
        ownershipsCarried: 0,
        ownershipsReleased: 0,
        retentionYearsAdvanced: 0,
        retentionObligationsCompleted: 0,
        buyoutYearsAdvanced: 0,
        buyoutObligationsCompleted: 0,
        tradesCancelled: 0,
      },
      version: 1,
    };
    continuing.priorSeasonRolloverOwnershipReceipt = {
      leagueId: IDS.league,
      rolloverId: IDS.rollover,
      fromSeasonId: IDS.priorSeason,
      toSeasonId: IDS.season,
      teams: [],
    };
    const continuingInspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(continuing)
      );
    assert.equal(
      continuingInspection.setup.setupPath,
      "completed_entry_draft"
    );
    assert.equal(
      continuingInspection.priorSeasonRollover.rolloverId,
      IDS.rollover
    );
    const malformedRollover = clone(continuing);
    malformedRollover.priorSeasonRolloverReceipt.summary
      .contractsAdvanced = 1;
    assert.equal(
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(malformedRollover)
      ).internalBlockers.some(
        ({ code }) => code === "FAD_ROLLOVER_INVALID"
      ),
      true
    );

    const seasonTwo = context();
    seasonTwo.season.label = "2026";
    const exemptionKey = occurrence(IDS.exemption);
    seasonTwo.readinessOperation.occurrenceKey =
      exemptionKey;
    seasonTwo.readinessJob.occurrenceKey = exemptionKey;
    seasonTwo.readinessOperation.triggerKind =
      "no_draft_initial_season2";
    seasonTwo.readinessOperation.setupExemptionId =
      IDS.exemption;
    seasonTwo.setupExemptions = [
      {
        exemptionId: IDS.exemption,
        leagueId: IDS.league,
        seasonId: IDS.season,
        exemptionKind: "initial_season2_transition",
        migrationReportId: uuid(40),
        reason: "Original league initial Season 2 transition.",
        authorizedByUserId: IDS.managerA,
        authorizedByMembershipId: IDS.membershipA,
        authorizedAuthority:
          "platform_administrator_as_commissioner",
        authorizedAtMs: OBSERVED_AT_MS - 80_000,
        consumedFadId: null,
        consumedAtMs: null,
        createdAtMs: OBSERVED_AT_MS - 80_000,
        updatedAtMs: OBSERVED_AT_MS - 80_000,
        version: 1,
        idempotencyRequestId: uuid(41),
        migrationReportSha256: "c".repeat(64),
        bootstrapIdentitySha256: "d".repeat(64),
        bootstrapIdempotencyRequestId: uuid(42),
        bootstrapActivityId: uuid(43),
        bootstrapSecurityAuditEventId: uuid(44),
        bootstrapActorUserId: uuid(45),
        authorizationActivityId: uuid(46),
        authorizationSecurityAuditEventId: uuid(47),
        commissionerNotificationId: uuid(48),
        outboxEventId: uuid(49),
      },
    ];
    const seasonTwoInspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(seasonTwo)
      );
    assert.deepEqual(seasonTwoInspection.setup, {
      setupPath: "no_draft_initial_season2",
      entryDraftId: null,
      setupExemptionId: IDS.exemption,
      priorSeasonRolloverId: null,
      noDraftReason:
        "Original league initial Season 2 transition.",
    });
    const malformedExemption = clone(seasonTwo);
    malformedExemption.setupExemptions[0]
      .migrationReportSha256 = "not-a-hash";
    assert.equal(
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(malformedExemption)
      ).internalBlockers.some(
        ({ code }) => code === "FAD_NO_DRAFT_PATH_INVALID"
      ),
      true
    );
    const malformedAuthority = clone(seasonTwo);
    malformedAuthority.setupExemptions[0]
      .authorizedAuthority = "commissioner";
    assert.equal(
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(malformedAuthority)
      ).internalBlockers.some(
        ({ code }) => code === "FAD_NO_DRAFT_PATH_INVALID"
      ),
      true
    );
  });

  test("collects exact missing-schedule, existing-FAD, and missing-manager blockers without a write plan", () => {
    const source = context();
    source.currentSchedule = null;
    source.currentScheduleOperation = null;
    source.firstMatchupWeek = null;
    source.existingFad = {
      fadId: uuid(100),
      status: "cards_open",
      version: 1,
    };
    source.managerAssignments = [];

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    const result = finalizeBlocked(inspection);

    assert.equal(inspection.readyForSchedulePlanning, false);
    assert.deepEqual(
      inspection.internalBlockers.map(({ code }) => code),
      [
        "FAD_ALREADY_EXISTS",
        "FAD_MANAGER_MISSING",
        "MATCHUP_SCHEDULE_MISSING",
      ]
    );
    assert.equal(result.outcome, "blocked");
    assert.equal(result.opening, null);
    assert.equal(
      result.attemptProjection.candidateDeadlineAtMs,
      null
    );
    assert.equal(
      result.attemptProjection.firstMatchupWeekAfter,
      null
    );
  });

  test("advances Week 1 by one or multiple whole local Mondays and records schedule generation version", () => {
    for (const [observedAtMs, expectedStart, advances] of [
      [
        WEEK_ONE_AT_MS - 7 * 86_400_000,
        Date.parse("2026-10-19T07:00:00.000Z"),
        1,
      ],
      [
        WEEK_ONE_AT_MS + 1,
        Date.parse("2026-10-26T07:00:00.000Z"),
        2,
      ],
    ]) {
      const source = context();
      source.readinessOperation.leaseExpiresAtMs =
        observedAtMs + 60_000;
      source.readinessJob.leaseExpiresAtMs =
        observedAtMs + 60_000;
      const inspection =
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(source, observedAtMs)
        );
      assert.equal(
        inspection.scheduleDecision.mondayAdvanceCount,
        advances
      );
      const result = finalizeSuccess(inspection);
      assert.equal(result.outcome, "succeeded");
      assert.equal(
        result.attemptProjection.firstMatchupWeekAfter
          .version,
        2
      );
      assert.equal(
        result.attemptProjection.firstMatchupWeekAfter
          .startsAtMs,
        expectedStart
      );
      assert.deepEqual(
        result.attemptProjection.warnings.map(
          ({ code }) => code
        ),
        ["FAD_WEEK_ONE_MOVED"]
      );
    }
  });

  test("uses league-local Monday arithmetic across the 169-hour fall DST boundary", () => {
    const source = context();
    const oldStart = Date.parse(
      "2026-10-26T07:00:00.000Z"
    );
    const observedAtMs =
      oldStart - 7 * 86_400_000;
    source.currentSchedule.startsAtMs = oldStart;
    source.firstMatchupWeek.startsAtMs = oldStart;
    source.readinessOperation.leaseExpiresAtMs =
      observedAtMs + 60_000;
    source.readinessJob.leaseExpiresAtMs =
      observedAtMs + 60_000;

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source, observedAtMs)
      );

    assert.equal(
      inspection.scheduleDecision.firstWeekStartsAtMs,
      Date.parse("2026-11-02T08:00:00.000Z")
    );
    assert.equal(
      inspection.scheduleDecision.firstWeekStartsAtMs -
        oldStart,
      169 * 60 * 60 * 1_000
    );
  });

  test("fails closed when no pre-playoff Monday remains or a replacement identity is stale", () => {
    const source = context();
    const lastWeek = Date.parse(
      "2027-03-08T08:00:00.000Z"
    );
    const observedAtMs =
      lastWeek - 7 * 86_400_000;
    source.currentSchedule.startsAtMs = lastWeek;
    source.firstMatchupWeek.startsAtMs = lastWeek;
    source.readinessOperation.leaseExpiresAtMs =
      observedAtMs + 60_000;
    source.readinessJob.leaseExpiresAtMs =
      observedAtMs + 60_000;
    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source, observedAtMs)
      );
    assert.deepEqual(
      inspection.internalBlockers.map(({ code }) => code),
      ["FAD_WEEK_ONE_RECOVERY_UNAVAILABLE"]
    );

    const recoverySource = context();
    const deadline = WEEK_ONE_AT_MS - 7 * 86_400_000;
    recoverySource.readinessOperation.leaseExpiresAtMs =
      deadline + 60_000;
    recoverySource.readinessJob.leaseExpiresAtMs =
      deadline + 60_000;
    const recoveryInspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(recoverySource, deadline)
      );
    assertPolicyError(
      () =>
        finalizeSuccess(recoveryInspection, {
          targetSchedule: targetScheduleFor(
            recoveryInspection,
            { version: 1 }
          ),
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .resultInvalid,
      "target_schedule_mismatch"
    );
  });

  test("projects normal and fantasy-ELC Active, Bench, and IR carryovers", () => {
    const source = context();
    addCarryover(source, {
      base: 200,
      position: "F",
      rosterCategory: "Active",
      slotNumber: 2,
    });
    addCarryover(source, {
      base: 220,
      position: "D",
      rosterCategory: "Active",
      slotNumber: 3,
    });
    addCarryover(source, {
      base: 240,
      position: "F",
      rosterCategory: "Bench",
      slotNumber: 1,
      contractType: "fantasy_elc",
      totalValueCents: 300,
      termYears: 3,
      aavCents: 100,
    });
    addCarryover(source, {
      base: 260,
      position: "D",
      rosterCategory: "Injured Reserve",
      slotNumber: null,
    });

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    const projection = inspection.teamProjections[0];

    assert.equal(inspection.readyForSchedulePlanning, true);
    assert.deepEqual(
      {
        carryoverCount: projection.carryoverCount,
        openForwardSlots: projection.openForwardSlots,
        openDefenceSlots: projection.openDefenceSlots,
        openBenchSlots: projection.openBenchSlots,
        structuralConflictCount:
          projection.structuralConflictCount,
      },
      {
        carryoverCount: 4,
        openForwardSlots: 11,
        openDefenceSlots: 4,
        openBenchSlots: 3,
        structuralConflictCount: 0,
      }
    );
    assert.equal(
      inspection.carryoverProjection.teams[0].entries
        .find(
          ({ sourceRosterCategory }) =>
            sourceRosterCategory === "Injured Reserve"
        ).requestedSlotNumber,
      1
    );
  });

  test("keeps deterministic slot collisions and ineligible Bench contracts as warnings, not blockers", () => {
    const source = context();
    const first = addCarryover(source, {
      base: 300,
      position: "F",
      rosterCategory: "Active",
      slotNumber: 1,
    });
    const second = addCarryover(source, {
      base: 320,
      position: "F",
      rosterCategory: "Active",
      slotNumber: 1,
    });
    addCarryover(source, {
      base: 340,
      position: "D",
      rosterCategory: "Bench",
      slotNumber: 1,
      totalValueCents: 500,
      termYears: 1,
      aavCents: 500,
    });
    source.ownerships.reverse();

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    const entries =
      inspection.carryoverProjection.teams[0].entries;

    assert.equal(inspection.readyForSchedulePlanning, true);
    assert.equal(
      entries.find(
        ({ ownershipId }) =>
          ownershipId === first.ownershipId
      ).placementState,
      "placed"
    );
    assert.equal(
      entries.find(
        ({ ownershipId }) =>
          ownershipId === second.ownershipId
      ).placementState,
      "conflict"
    );
    assert.equal(
      inspection.teamProjections[0]
        .structuralConflictCount,
      2
    );
    assert.deepEqual(
      inspection.internalWarnings.map(({ code }) => code),
      ["FAD_CARRYOVER_STRUCTURAL_CONFLICT"]
    );
    assert.equal(
      finalizeSuccess(inspection).outcome,
      "succeeded"
    );
  });

  test("treats prospect, retention, and buyout rows as non-slot state", () => {
    const source = context();
    source.ownerships.push({
      ownershipId: uuid(400),
      teamId: IDS.teamA,
      playerId: uuid(401),
      ownershipKind: "Prospect Right",
      rosterCategory: "Prospect",
      positionGroup: "F",
      slotNumber: null,
      version: 1,
      playerStatus: "active",
    });
    const carried = addCarryover(source, {
      base: 410,
      termYears: 1,
      totalValueCents: 300,
      aavCents: 300,
    });
    source.retentionObligations.push({
      obligationId: uuid(402),
      leagueId: IDS.league,
      contractId: carried.contractId,
      playerId: carried.playerId,
      originatingTeamId: IDS.teamA,
      responsibleTeamId: IDS.teamA,
      retainedAavCents: 50,
      creationTradeId: uuid(404),
      status: "active",
      createdAtMs: 1,
      updatedAtMs: 1,
      version: 1,
    });
    source.retentionYears.push({
      retentionYearId: uuid(405),
      leagueId: IDS.league,
      retentionObligationId: uuid(402),
      seasonId: IDS.season,
      retainedAavCents: 50,
      status: "current",
      createdAtMs: 1,
    });
    const eliminatedContract = {
      contractId: uuid(420),
      playerId: uuid(421),
      currentTeamId: IDS.teamA,
      contractType: "normal",
      originalTotalValueCents: 600,
      originalTermYears: 1,
      aavCents: 600,
      startSeasonId: IDS.season,
      status: "eliminated",
      version: 2,
    };
    source.allContracts.push(eliminatedContract);
    source.allContractYears.push({
      contractYearId: uuid(422),
      leagueId: IDS.league,
      contractId: eliminatedContract.contractId,
      seasonId: IDS.season,
      yearNumber: 1,
      aavCents: 600,
      status: "eliminated",
      rolloverAtMs: 1,
      createdAtMs: 1,
    });
    source.targetContractYears.push({
      contractYearId: uuid(422),
      contractId: eliminatedContract.contractId,
      seasonId: IDS.season,
      yearNumber: 1,
      aavCents: 600,
      status: "eliminated",
    });
    source.buyoutObligations.push({
      obligationId: uuid(403),
      leagueId: IDS.league,
      contractId: eliminatedContract.contractId,
      playerId: eliminatedContract.playerId,
      originatingTeamId: IDS.teamA,
      responsibleTeamId: IDS.teamA,
      annualPenaltyBasisCents: 150,
      buyoutTransactionId: uuid(423),
      status: "active",
      createdAtMs: 1,
      updatedAtMs: 1,
      version: 1,
    });
    source.buyoutYears.push({
      buyoutYearId: uuid(424),
      leagueId: IDS.league,
      buyoutObligationId: uuid(403),
      seasonId: IDS.season,
      penaltyCents: 150,
      status: "current",
      createdAtMs: 1,
    });

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    const projection = inspection.teamProjections[0];

    assert.deepEqual(inspection.internalBlockers, []);
    assert.equal(projection.carryoverCount, 1);
    assert.equal(projection.openForwardSlots, 11);
    assert.equal(projection.openDefenceSlots, 6);
    assert.equal(projection.openBenchSlots, 4);
  });

  test("requires exact full-term contract schedules and an exact target-year projection", async (t) => {
    await t.test("accepts an exact carried second contract year", () => {
      const source = context();
      const carried = addCarryover(source, {
        base: 1_980,
        termYears: 2,
      });
      const years = source.allContractYears
        .filter(({ contractId }) => contractId === carried.contractId)
        .sort((left, right) => left.yearNumber - right.yearNumber);
      const priorSeasonId = uuid(1_989);
      years[0].seasonId = priorSeasonId;
      years[0].status = "completed";
      years[0].rolloverAtMs = 2;
      years[1].seasonId = IDS.season;
      years[1].status = "current";
      for (const contract of [
        source.activeContracts[0],
        source.allContracts[0],
      ]) {
        contract.startSeasonId = priorSeasonId;
      }
      Object.assign(source.targetContractYears[0], {
        contractYearId: years[1].contractYearId,
        seasonId: IDS.season,
        yearNumber: 2,
        status: "current",
      });

      assert.deepEqual(blockerCodes(source), []);
    });

    const cases = [
      [
        "malformed contract economics",
        (source) => {
          addCarryover(source, { base: 2_000 });
          source.activeContracts[0].originalTotalValueCents += 1;
          source.allContracts[0].originalTotalValueCents += 1;
        },
      ],
      [
        "missing contract year",
        (source) => {
          const carried = addCarryover(source, {
            base: 2_020,
            termYears: 3,
            totalValueCents: 900,
          });
          source.allContractYears = source.allContractYears.filter(
            (year) =>
              year.contractId !== carried.contractId ||
              year.yearNumber !== 2
          );
        },
      ],
      [
        "contract start season mismatch",
        (source) => {
          addCarryover(source, { base: 2_040 });
          source.activeContracts[0].startSeasonId = uuid(2_049);
          source.allContracts[0].startSeasonId = uuid(2_049);
        },
      ],
      [
        "prior contract year is not completed",
        (source) => {
          const carried = addCarryover(source, {
            base: 2_060,
            termYears: 2,
          });
          const years = source.allContractYears
            .filter(({ contractId }) => contractId === carried.contractId)
            .sort((left, right) => left.yearNumber - right.yearNumber);
          const priorSeasonId = uuid(2_069);
          years[0].seasonId = priorSeasonId;
          years[0].status = "expired";
          years[1].seasonId = IDS.season;
          years[1].status = "current";
          for (const contract of [
            source.activeContracts[0],
            source.allContracts[0],
          ]) {
            contract.startSeasonId = priorSeasonId;
          }
          Object.assign(source.targetContractYears[0], {
            contractYearId: years[1].contractYearId,
            seasonId: IDS.season,
            yearNumber: 2,
            status: "current",
          });
        },
      ],
      [
        "target contract-year projection drift",
        (source) => {
          addCarryover(source, { base: 2_080 });
          source.targetContractYears[0].aavCents += 1;
        },
      ],
      [
        "invalid contract-year timestamp",
        (source) => {
          addCarryover(source, { base: 2_100 });
          source.allContractYears[0].createdAtMs = -1;
        },
      ],
      [
        "expired parent retains eliminated year states",
        (source) => {
          const { contractId } = addBuyout(source, {
            base: 2_120,
          });
          source.allContracts.find(
            ({ contractId: id }) => id === contractId
          ).status = "expired";
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, () => {
        const source = context();
        mutate(source);
        assert.equal(
          blockerCodes(source).includes(
            "FAD_CONTRACT_STATE_INVALID"
          ),
          true
        );
      });
    }
  });

  test("enforces retention schedules, the cumulative 50% ceiling, and three active slots", async (t) => {
    await t.test("exact odd-AAV floor and three slots pass", () => {
      const source = context();
      source.participatingTeams.push(
        team(IDS.teamB, "Beta Bears")
      );
      source.managerAssignments.push(
        manager({
          teamId: IDS.teamB,
          assignmentId: IDS.assignmentB,
          userId: IDS.managerB,
          membershipId: IDS.membershipB,
        })
      );
      for (let index = 0; index < 3; index += 1) {
        const carried = addCarryover(source, {
          base: 2_200 + index * 40,
          aavCents: index === 0 ? 301 : 400,
          totalValueCents: index === 0 ? 301 : 800,
          termYears: index === 0 ? 1 : 2,
          slotNumber: index + 1,
        });
        addRetention(source, {
          base: 2_300 + index * 10,
          contractId: carried.contractId,
          amountCents: index === 0 ? 75 : 100,
        });
        if (index === 0) {
          addRetention(source, {
            base: 2_305,
            contractId: carried.contractId,
            amountCents: 75,
            responsibleTeamId: IDS.teamB,
          });
        }
      }
      assert.deepEqual(
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(source)
        ).internalBlockers,
        []
      );
    });

    const cases = [
      [
        "one cent above the odd-AAV floor",
        (source) => {
          source.participatingTeams.push(
            team(IDS.teamB, "Beta Bears")
          );
          source.managerAssignments.push(
            manager({
              teamId: IDS.teamB,
              assignmentId: IDS.assignmentB,
              userId: IDS.managerB,
              membershipId: IDS.membershipB,
            })
          );
          const carried = addCarryover(source, {
            base: 2_400,
            aavCents: 301,
            totalValueCents: 301,
            termYears: 1,
          });
          addRetention(source, {
            base: 2_410,
            contractId: carried.contractId,
            amountCents: 75,
          });
          addRetention(source, {
            base: 2_415,
            contractId: carried.contractId,
            amountCents: 76,
            responsibleTeamId: IDS.teamB,
          });
        },
      ],
      [
        "fourth active retention slot",
        (source) => {
          for (let index = 0; index < 4; index += 1) {
            const carried = addCarryover(source, {
              base: 2_440 + index * 40,
              slotNumber: index + 1,
            });
            addRetention(source, {
              base: 2_600 + index * 10,
              contractId: carried.contractId,
              amountCents: 50,
            });
          }
        },
      ],
      [
        "duplicate responsible-team contract",
        (source) => {
          const carried = addCarryover(source, { base: 2_700 });
          addRetention(source, {
            base: 2_710,
            contractId: carried.contractId,
            amountCents: 50,
          });
          addRetention(source, {
            base: 2_720,
            contractId: carried.contractId,
            amountCents: 50,
          });
        },
      ],
      [
        "future-year amount drift",
        (source) => {
          const carried = addCarryover(source, { base: 2_740 });
          const obligationId = addRetention(source, {
            base: 2_750,
            contractId: carried.contractId,
            amountCents: 50,
          });
          source.retentionYears.find(
            (year) =>
              year.retentionObligationId === obligationId &&
              year.status === "future"
          ).retainedAavCents += 1;
        },
      ],
      [
        "obligation schedule is not a contract suffix",
        (source) => {
          const carried = addCarryover(source, {
            base: 2_780,
            termYears: 3,
            totalValueCents: 900,
          });
          const obligationId = addRetention(source, {
            base: 2_790,
            contractId: carried.contractId,
            amountCents: 50,
          });
          source.retentionYears.find(
            (year) =>
              year.retentionObligationId === obligationId &&
              year.status === "future"
          ).seasonId = uuid(2_799);
        },
      ],
      [
        "missing current retention year",
        (source) => {
          const carried = addCarryover(source, { base: 2_800 });
          const obligationId = addRetention(source, {
            base: 2_810,
            contractId: carried.contractId,
            amountCents: 50,
          });
          source.retentionYears.find(
            (year) =>
              year.retentionObligationId === obligationId &&
              year.status === "current"
          ).status = "future";
        },
      ],
      [
        "invalid retention timestamps",
        (source) => {
          const carried = addCarryover(source, { base: 2_820 });
          const obligationId = addRetention(source, {
            base: 2_830,
            contractId: carried.contractId,
            amountCents: 50,
          });
          source.retentionObligations.find(
            ({ obligationId: id }) => id === obligationId
          ).updatedAtMs = 0;
        },
      ],
      [
        "terminal parent retains a live year",
        (source) => {
          const carried = addCarryover(source, { base: 2_840 });
          const obligationId = addRetention(source, {
            base: 2_850,
            contractId: carried.contractId,
            amountCents: 50,
          });
          source.retentionObligations.find(
            ({ obligationId: id }) => id === obligationId
          ).status = "completed";
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, () => {
        const source = context();
        mutate(source);
        assert.equal(
          blockerCodes(source).includes(
            "FAD_RETENTION_STATE_INVALID"
          ),
          true
        );
      });
    }
  });

  test("enforces exact buyout basis rounding, eliminated schedules, and one obligation per contract", async (t) => {
    for (const [aavCents, expectedPenaltyCents] of [
      [101, 25],
      [102, 26],
      [103, 26],
      [104, 26],
    ]) {
      await t.test(`AAV ${aavCents} rounds to ${expectedPenaltyCents}`, () => {
        const source = context();
        addBuyout(source, {
          base: 3_000 + aavCents * 30,
          aavCents,
          termYears: 1,
          annualPenaltyBasisCents: expectedPenaltyCents,
        });
        assert.equal(
          blockerCodes(source).includes(
            "FAD_BUYOUT_STATE_INVALID"
          ),
          false
        );
      });
    }

    const cases = [
      [
        "wrong annual penalty basis",
        (source) => {
          addBuyout(source, {
            base: 6_200,
            annualPenaltyBasisCents: 149,
          });
        },
      ],
      [
        "future penalty amount drift",
        (source) => {
          const { obligationId } = addBuyout(source, {
            base: 6_240,
          });
          source.buyoutYears.find(
            (year) =>
              year.buyoutObligationId === obligationId &&
              year.status === "future"
          ).penaltyCents += 1;
        },
      ],
      [
        "future penalty schedule drift",
        (source) => {
          const { obligationId } = addBuyout(source, {
            base: 6_280,
          });
          source.buyoutYears.find(
            (year) =>
              year.buyoutObligationId === obligationId &&
              year.status === "future"
          ).seasonId = uuid(6_299);
        },
      ],
      [
        "missing current penalty year",
        (source) => {
          const { obligationId } = addBuyout(source, {
            base: 6_300,
          });
          source.buyoutYears.find(
            (year) =>
              year.buyoutObligationId === obligationId &&
              year.status === "current"
          ).status = "future";
        },
      ],
      [
        "duplicate obligation for one contract",
        (source) => {
          const { contractId, obligationId } = addBuyout(source, {
            base: 6_320,
          });
          const duplicateId = uuid(6_350);
          source.buyoutObligations.push({
            ...clone(
              source.buyoutObligations.find(
                ({ obligationId: id }) => id === obligationId
              )
            ),
            obligationId: duplicateId,
            contractId,
            buyoutTransactionId: uuid(6_351),
          });
        },
      ],
      [
        "eliminated suffix stops before the original term",
        (source) => {
          const { contractId, obligationId } = addBuyout(source, {
            base: 6_360,
          });
          const trailingContractYear = source.allContractYears.find(
            (year) =>
              year.contractId === contractId &&
              year.yearNumber === 2
          );
          trailingContractYear.status = "completed";
          source.buyoutYears = source.buyoutYears.filter(
            (year) =>
              !(
                year.buyoutObligationId === obligationId &&
                year.seasonId === trailingContractYear.seasonId
              )
          );
        },
      ],
      [
        "non-eliminated underlying contract",
        (source) => {
          const { contractId } = addBuyout(source, {
            base: 6_400,
          });
          source.allContracts.find(
            ({ contractId: id }) => id === contractId
          ).status = "expired";
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, () => {
        const source = context();
        mutate(source);
        assert.equal(
          blockerCodes(source).includes(
            "FAD_BUYOUT_STATE_INVALID"
          ),
          true
        );
      });
    }
  });

  test("accepts a new active re-signing independently of an older eliminated contract", () => {
    const source = context();
    const signing = addCarryover(source, { base: 6_500 });
    addBuyout(source, {
      base: 6_540,
      playerId: signing.playerId,
    });

    const inspection = inspectFreeAgentDraftOpeningReadiness(
      inspectionInput(source)
    );
    assert.deepEqual(inspection.internalBlockers, []);
    assert.equal(
      inspection.carryoverProjection.teams[0].entries.length,
      1
    );
    assert.equal(
      inspection.carryoverProjection.teams[0].entries[0]
        .contractId,
      signing.contractId
    );
  });

  test("blocks every malformed authoritative season-state category while preserving all-card atomicity", async (t) => {
    const cases = [
      [
        "orphan active contract",
        (source) => {
          addCarryover(source, { base: 800 });
          source.ownerships = [];
        },
        "FAD_CONTRACT_STATE_INVALID",
      ],
      [
        "cross-team duplicate ownership",
        (source) => {
          source.participatingTeams.push(
            team(IDS.teamB, "Beta Bears")
          );
          source.managerAssignments.push(
            manager({
              teamId: IDS.teamB,
              assignmentId: IDS.assignmentB,
              userId: IDS.managerB,
              membershipId: IDS.membershipB,
            })
          );
          const carried = addCarryover(source, {
            base: 820,
          });
          source.ownerships.push({
            ...clone(source.ownerships[0]),
            ownershipId: uuid(829),
            teamId: IDS.teamB,
            playerId: carried.playerId,
          });
        },
        "FAD_OWNERSHIP_STATE_INVALID",
      ],
      [
        "normal contract on a prospect right",
        (source) => {
          addCarryover(source, { base: 840 });
          Object.assign(source.ownerships[0], {
            ownershipKind: "Prospect Right",
            rosterCategory: "Prospect",
            slotNumber: null,
          });
        },
        "FAD_OWNERSHIP_STATE_INVALID",
      ],
      [
        "orphan retention obligation",
        (source) => {
          source.retentionObligations.push({
            obligationId: uuid(860),
            leagueId: IDS.league,
            contractId: uuid(861),
            playerId: uuid(862),
            originatingTeamId: IDS.teamA,
            responsibleTeamId: IDS.teamA,
            retainedAavCents: 50,
            creationTradeId: uuid(863),
            status: "active",
            createdAtMs: 1,
            updatedAtMs: 1,
            version: 1,
          });
        },
        "FAD_RETENTION_STATE_INVALID",
      ],
      [
        "orphan buyout obligation",
        (source) => {
          source.buyoutObligations.push({
            obligationId: uuid(880),
            leagueId: IDS.league,
            contractId: uuid(881),
            playerId: uuid(882),
            originatingTeamId: IDS.teamA,
            responsibleTeamId: IDS.teamA,
            annualPenaltyBasisCents: 150,
            buyoutTransactionId: uuid(883),
            status: "active",
            createdAtMs: 1,
            updatedAtMs: 1,
            version: 1,
          });
        },
        "FAD_BUYOUT_STATE_INVALID",
      ],
      [
        "orphan roster-order entry",
        (source) => {
          source.rosterOrderEntries.push({
            orderEntryId: uuid(900),
            leagueId: IDS.league,
            orderSetId: uuid(901),
            ownershipId: uuid(902),
            positionGroup: "F",
            displayOrder: 1,
            createdAtMs: 1,
          });
        },
        "FAD_ROSTER_ORDER_STATE_INVALID",
      ],
      [
        "inactive participating team",
        (source) => {
          source.participatingTeams[0].status = "inactive";
        },
        "FAD_PARTICIPATING_TEAMS_INVALID",
      ],
    ];

    for (const [name, mutate, expectedCode] of cases) {
      await t.test(name, () => {
        const source = context();
        mutate(source);
        const inspection =
          inspectFreeAgentDraftOpeningReadiness(
            inspectionInput(source)
          );
        assert.equal(
          inspection.internalBlockers.some(
            ({ code }) => code === expectedCode
          ),
          true
        );
        assert.equal(finalizeBlocked(inspection).opening, null);
      });
    }
  });

  test("blocks incomplete contract chains and effective-position drift without hiding other teams", () => {
    const source = context();
    source.participatingTeams.push(
      team(IDS.teamB, "Beta Bears")
    );
    source.managerAssignments.push(
      manager({
        teamId: IDS.teamB,
        assignmentId: IDS.assignmentB,
        userId: IDS.managerB,
        membershipId: IDS.membershipB,
      })
    );
    const carried = addCarryover(source, {
      base: 500,
      position: "F",
    });
    source.allContractYears = [];
    source.leaguePositionOverrides.push({
      positionOverrideId: uuid(550),
      playerId: carried.playerId,
      positionGroup: "D",
      effectiveAtMs: 1,
      version: 1,
    });

    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );

    assert.equal(inspection.readyForSchedulePlanning, false);
    assert.deepEqual(
      inspection.internalBlockers.map(({ code }) => code),
      [
        "FAD_CONTRACT_STATE_INVALID",
        "FAD_PLAYER_POSITION_INVALID",
      ]
    );
    assert.deepEqual(
      inspection.teamProjections.map(({ teamId }) => teamId),
      [IDS.teamA, IDS.teamB]
    );
    assert.equal(
      inspection.teamProjections[1].managerReady,
      true
    );
  });

  test("is byte-stable under shuffled source rows", () => {
    const source = context();
    source.participatingTeams.push(
      team(IDS.teamB, "Beta Bears")
    );
    source.managerAssignments.push(
      manager({
        teamId: IDS.teamB,
        assignmentId: IDS.assignmentB,
        userId: IDS.managerB,
        membershipId: IDS.membershipB,
      })
    );
    addCarryover(source, { base: 600 });
    addCarryover(source, {
      base: 620,
      teamId: IDS.teamB,
      position: "D",
    });
    const shuffled = clone(source);
    for (const key of [
      "participatingTeams",
      "managerAssignments",
      "ownerships",
      "activeContracts",
      "targetContractYears",
      "allContractYears",
      "currentPlayerSources",
    ]) {
      shuffled[key].reverse();
    }

    const first = inspectFreeAgentDraftOpeningReadiness(
      inspectionInput(source)
    );
    const second = inspectFreeAgentDraftOpeningReadiness(
      inspectionInput(shuffled)
    );

    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test("rejects malformed top-level fields, split schedule evidence, and expired or split leases", () => {
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness({
          ...inspectionInput(),
          openingTime: OBSERVED_AT_MS,
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "opening_readiness_fields_invalid"
    );

    const splitSchedule = context();
    splitSchedule.firstMatchupWeek.startsAtMs += 1;
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(splitSchedule)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "current_schedule_evidence_split"
    );

    const expired = context();
    expired.readinessOperation.leaseExpiresAtMs =
      OBSERVED_AT_MS;
    expired.readinessJob.leaseExpiresAtMs =
      OBSERVED_AT_MS;
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(expired)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "readiness_execution_split"
    );

    const splitLease = context();
    splitLease.readinessJob.leaseToken = "other-token";
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(splitLease)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "readiness_execution_split"
    );

    const dirtyRunning = context();
    dirtyRunning.readinessJob.resultJson = "{}";
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(dirtyRunning)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "readiness_execution_split"
    );

    const futureStarted = context();
    futureStarted.readinessOperation.startedAtMs =
      OBSERVED_AT_MS + 1;
    futureStarted.readinessOperation.updatedAtMs =
      OBSERVED_AT_MS + 1;
    futureStarted.readinessJob.startedAtMs =
      OBSERVED_AT_MS + 1;
    futureStarted.readinessJob.updatedAtMs =
      OBSERVED_AT_MS + 1;
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(futureStarted)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "readiness_execution_split"
    );

    const orphanScheduleOperation = context();
    orphanScheduleOperation.currentSchedule = null;
    orphanScheduleOperation.firstMatchupWeek = null;
    assertPolicyError(
      () =>
        inspectFreeAgentDraftOpeningReadiness(
          inspectionInput(orphanScheduleOperation)
        ),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "current_schedule_evidence_split"
    );
  });

  test("requires a trusted inspection, exact target schedule, fresh deadline, and live lease at finalization", () => {
    const inspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput()
      );
    const forged = Object.freeze({ ...inspection });
    assertPolicyError(
      () => finalizeSuccess(forged),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .resultInvalid,
      "opening_inspection_invalid"
    );
    assertPolicyError(
      () =>
        finalizeSuccess(inspection, {
          targetSchedule: targetScheduleFor(inspection, {
            operationId: IDS.replacementScheduleOperation,
          }),
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .resultInvalid,
      "target_schedule_mismatch"
    );
    assertPolicyError(
      () =>
        finalizeSuccess(inspection, {
          openedAtMs: inspection.leaseExpiresAtMs,
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .resultInvalid,
      "successful_opening_projection_incomplete"
    );

    const deadline = WEEK_ONE_AT_MS - 7 * 86_400_000;
    const lateSource = context();
    lateSource.readinessOperation.leaseExpiresAtMs =
      deadline + 60_000;
    lateSource.readinessJob.leaseExpiresAtMs =
      deadline + 60_000;
    const lateInspection =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(lateSource)
      );
    assertPolicyError(
      () =>
        finalizeSuccess(lateInspection, {
          openedAtMs: deadline,
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .resultInvalid,
      "opening_schedule_became_stale"
    );
  });

  test("uses one F/D provider position, ignores inactive or null sources, and lets an exact override win", () => {
    const source = context();
    const carried = addCarryover(source, { base: 920 });
    source.currentPlayerSources.push(
      {
        playerSourceStateId: uuid(970),
        playerId: carried.playerId,
        provider: "null-provider",
        normalizedPosition: null,
        active: true,
        effectiveAtMs: 2,
      },
      {
        playerSourceStateId: uuid(971),
        playerId: carried.playerId,
        provider: "inactive-provider",
        normalizedPosition: "D",
        active: false,
        effectiveAtMs: 2,
      }
    );
    assert.deepEqual(
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      ).internalBlockers,
      []
    );

    source.currentPlayerSources.push({
      playerSourceStateId: uuid(972),
      playerId: carried.playerId,
      provider: "conflicting-provider",
      normalizedPosition: "D",
      active: true,
      effectiveAtMs: 3,
    });
    const conflicted =
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      );
    assert.equal(
      conflicted.internalBlockers.some(
        ({ code }) => code === "FAD_PLAYER_POSITION_INVALID"
      ),
      true
    );

    source.leaguePositionOverrides.push({
      positionOverrideId: uuid(973),
      playerId: carried.playerId,
      positionGroup: "F",
      effectiveAtMs: 4,
      version: 1,
    });
    assert.deepEqual(
      inspectFreeAgentDraftOpeningReadiness(
        inspectionInput(source)
      ).internalBlockers,
      []
    );
  });

  test("blocks target-season, rollover, Entry Draft, exemption, and manager prerequisite variants", async (t) => {
    const cases = [
      [
        "target season not current",
        (source) => {
          source.league.currentSeasonId = uuid(900);
        },
        "FAD_TARGET_SEASON_NOT_READY",
      ],
      [
        "duplicate managers",
        (source) => {
          source.managerAssignments.push(
            manager({ assignmentId: uuid(901) })
          );
        },
        "FAD_MANAGER_INVALID",
      ],
      [
        "inaugural mixed with prior season",
        (source) => {
          source.priorSeason = {
            seasonId: IDS.priorSeason,
            status: "completed",
          };
        },
        "FAD_NO_DRAFT_PATH_INVALID",
      ],
      [
        "incomplete Entry Draft",
        (source) => {
          const key = occurrence(IDS.entryDraft);
          source.readinessOperation.occurrenceKey = key;
          source.readinessJob.occurrenceKey = key;
          source.readinessOperation.triggerKind =
            "entry_draft_completed";
          source.readinessOperation.entryDraftId =
            IDS.entryDraft;
          source.entryDraft = {
            entryDraftId: IDS.entryDraft,
            status: "Scheduled",
            completedAtMs: null,
            version: 1,
          };
        },
        "FAD_ENTRY_DRAFT_NOT_COMPLETE",
      ],
      [
        "missing Season 2 exemption",
        (source) => {
          const key = occurrence(IDS.exemption);
          source.readinessOperation.occurrenceKey = key;
          source.readinessJob.occurrenceKey = key;
          source.readinessOperation.triggerKind =
            "no_draft_initial_season2";
          source.readinessOperation.setupExemptionId =
            IDS.exemption;
        },
        "FAD_NO_DRAFT_PATH_INVALID",
      ],
    ];

    for (const [name, mutate, expectedCode] of cases) {
      await t.test(name, () => {
        const source = context();
        mutate(source);
        const inspection =
          inspectFreeAgentDraftOpeningReadiness(
            inspectionInput(source)
          );
        assert.equal(
          inspection.internalBlockers.some(
            ({ code }) => code === expectedCode
          ),
          true
        );
        assert.equal(
          finalizeBlocked(inspection).opening,
          null
        );
      });
    }
  });

  test("standalone carryover projection rejects noncanonical settings and returns frozen exact counts", () => {
    const source = context();
    addCarryover(source, { base: 700 });
    const projection = projectFreeAgentDraftCarryovers({
      seasonId: IDS.season,
      participatingTeams: source.participatingTeams,
      leagueSettings: source.leagueSettings,
      ownerships: source.ownerships,
      activeContracts: source.activeContracts,
      targetContractYears: source.targetContractYears,
      allContractYears: source.allContractYears,
      leaguePositionOverrides:
        source.leaguePositionOverrides,
      currentPlayerSources: source.currentPlayerSources,
    });
    assert.equal(projection.teams[0].carryoverCount, 1);
    assert.equal(Object.isFrozen(projection.teams[0].entries), true);

    assertPolicyError(
      () =>
        projectFreeAgentDraftCarryovers({
          seasonId: IDS.season,
          participatingTeams: source.participatingTeams,
          leagueSettings: {
            ...source.leagueSettings,
            benchSlots: 5,
          },
          ownerships: source.ownerships,
          activeContracts: source.activeContracts,
          targetContractYears: source.targetContractYears,
          allContractYears: source.allContractYears,
          leaguePositionOverrides:
            source.leaguePositionOverrides,
          currentPlayerSources:
            source.currentPlayerSources,
        }),
      FREE_AGENT_DRAFT_OPENING_READINESS_POLICY_CODES
        .inputInvalid,
      "candidate_slot_settings_invalid"
    );
  });
});
