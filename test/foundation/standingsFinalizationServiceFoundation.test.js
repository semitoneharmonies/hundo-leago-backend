const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  STANDINGS_FINALIZATION_CONFIRMATION,
  calculateStandingsResultSetHash,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  addLocalDays,
} = require(
  "../../src/domain/matchups/matchupSchedulePolicy"
);
const {
  FINALIZATION_AUDIT_EVENT_TYPE,
  STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS,
  STANDINGS_FINALIZATION_OPERATION,
  STANDINGS_FINALIZATION_RESULT_TYPE,
  createStandingsFinalizationService,
  standingsFinalizationRequestHash,
} = require(
  "../../src/application/services/matchups/createStandingsFinalizationService"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const LEAGUE_TIMEZONE = "America/Vancouver";
const REGULAR_SEASON_STARTS_AT_MS =
  Date.UTC(2026, 9, 1, 7);
const FIRST_WEEK_STARTS_AT_MS =
  Date.UTC(2026, 9, 5, 7);
const FANTASY_PLAYOFFS_START_AT_MS =
  addLocalDays(
    FIRST_WEEK_STARTS_AT_MS,
    7,
    LEAGUE_TIMEZONE
  );
const NOW_MS =
  FANTASY_PLAYOFFS_START_AT_MS + 1_000;
const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  commissioner: uuid(3),
  commissionerMembership: uuid(4),
  commissionerSession: uuid(5),
  member: uuid(6),
  memberMembership: uuid(7),
  memberSession: uuid(8),
  week: uuid(10),
  teamA: uuid(20),
  teamB: uuid(21),
  teamC: uuid(22),
  matchup: uuid(30),
  bye: uuid(39),
  matchupResult: uuid(31),
  resultVersion: uuid(32),
  sourceSnapshot: uuid(33),
  derivedSnapshot: uuid(40),
  replayFinalization: uuid(50),
  replayOperation: uuid(51),
  replaySnapshot: uuid(52),
  scheduleOperation: uuid(53),
  correctionOperation: uuid(54),
  priorWeek: uuid(55),
  replacementScheduleOperation: uuid(56),
  shiftCommandResult: uuid(57),
  recoveryScheduleOperation: uuid(58),
  scheduleRecovery: uuid(59),
  fad: uuid(60),
});

function readyContext() {
  return {
    aggregate: {
      league_id: IDS.league,
      league_status: "active",
      league_timezone: LEAGUE_TIMEZONE,
      current_season_id: IDS.season,
      season_id: IDS.season,
      season_status: "active",
      season_version: 7,
      regular_season_starts_at_ms:
        REGULAR_SEASON_STARTS_AT_MS,
      fantasy_playoffs_start_at_ms:
        FANTASY_PLAYOFFS_START_AT_MS,
      scoring_rule_version: 1,
      standings_rule_version: 1,
    },
    scheduleOperations: [
      {
        operation_league_id: IDS.league,
        operation_season_id: IDS.season,
        schedule_operation_id:
          IDS.scheduleOperation,
        operation_matchup_week_id: null,
        operation_matchup_id: null,
        actor_user_id: IDS.commissioner,
        operation_status: "succeeded",
        reason: null,
        metadata_json: JSON.stringify({
          participantCount: 2,
          participantTeamIds: [
            IDS.teamA,
            IDS.teamB,
          ].sort(),
          weekCount: 1,
          matchupCount: 1,
          jobOccurrenceCount: 0,
        }),
        started_at_ms: 1,
        completed_at_ms: 1,
      },
    ],
    scheduleGenerations: [
      {
        generation_league_id: IDS.league,
        generation_season_id: IDS.season,
        schedule_version: 1,
        schedule_operation_id: IDS.scheduleOperation,
        week_one_matchup_week_id: IDS.week,
        week_one_starts_at_ms:
          FIRST_WEEK_STARTS_AT_MS,
        generation_status: "current",
        generation_created_at_ms: 1,
        generation_superseded_at_ms: null,
        generation_version: 1,
      },
    ],
    scheduleCommandResults: [],
    scheduleRecoveries: [],
    correctionOperations: [],
    weeks: [
      {
        id: IDS.week,
        sequence: 1,
        starts_at_ms:
          FIRST_WEEK_STARTS_AT_MS,
        ends_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        rolls_over_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        status: "final",
      },
    ],
    results: [
      {
        matchup_id: IDS.matchup,
        matchup_week_id: IDS.week,
        matchup_status: "final",
        home_team_id: IDS.teamA,
        away_team_id: IDS.teamB,
        matchup_result_id: IDS.matchupResult,
        result_status: "official",
        current_version_id: IDS.resultVersion,
        result_finalized_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        result_version_id: IDS.resultVersion,
        version_number: 1,
        version_home_team_id: IDS.teamA,
        version_away_team_id: IDS.teamB,
        home_score_hundredths: 500,
        away_score_hundredths: 300,
        outcome: "home_win",
        source_snapshot_id: IDS.sourceSnapshot,
        source_type: "calculated",
        actor_user_id: null,
        reason: null,
        supersedes_version_id: null,
        result_version_created_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        result_row_count: 1,
        result_version_count: 1,
        latest_version_number: 1,
        source_snapshot_record_id: IDS.sourceSnapshot,
        source_snapshot_league_id: IDS.league,
        source_snapshot_season_id: IDS.season,
        source_snapshot_week_id: IDS.week,
        source_snapshot_intended_use:
          "matchup_final",
        source_snapshot_completeness: "complete",
        source_snapshot_freshness: "fresh",
        source_snapshot_committed: 1,
        superseded_version_record_id: null,
        superseded_version_matchup_result_id: null,
        superseded_version_number: null,
        previous_result_version_id: null,
        supersedes_previous_version: 0,
        invalid_version_chain_count: 0,
      },
    ],
    participants: [
      {
        team_id: IDS.teamA,
        team_display_name: "Alpha",
        team_status: "active",
        primary_colour: "#112233",
        secondary_colour: "#ddeeff",
        tertiary_colour: null,
        pattern_template: "even-two",
        logo_reference: null,
        source_logo_object_id: null,
        logo_media_type: null,
        logo_byte_length: null,
        logo_width: null,
        logo_height: null,
        logo_content_sha256: null,
        logo_content_bytes: null,
      },
      {
        team_id: IDS.teamB,
        team_display_name: "Bravo",
        team_status: "active",
        primary_colour: "#223344",
        secondary_colour: "#ccddee",
        tertiary_colour: "#778899",
        pattern_template: "even-three",
        logo_reference: null,
        source_logo_object_id: null,
        logo_media_type: null,
        logo_byte_length: null,
        logo_width: null,
        logo_height: null,
        logo_content_sha256: null,
        logo_content_bytes: null,
      },
    ],
    byes: [],
    activeMemberUserIds: [
      IDS.commissioner,
      IDS.member,
    ],
    snapshots: [
      {
        snapshot_id: IDS.derivedSnapshot,
        snapshot_version: 2,
        source_result_version: 1,
        snapshot_status: "current",
        calculated_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        snapshot_created_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        finalization_id: null,
        finalization_status: null,
        evidence_schema_version: null,
        finalization_cause: null,
        standings_rule_version: null,
        result_set_hash: null,
        result_set_hash_version: null,
        expected_matchup_count: null,
        finalized_matchup_count: null,
        expected_week_count: null,
        weeks_counted: null,
        participant_count: null,
        standings_row_count: null,
        completeness_status: null,
        season_version_before: null,
        season_version_after: null,
        standings_operation_id: null,
        idempotency_request_id: null,
        operation_status: null,
        operation_type: null,
        idempotency_status: null,
        idempotency_result_type: null,
        idempotency_result_id: null,
        idempotency_result_link_count: 0,
      },
    ],
  };
}

function withShiftedCurrentSchedule(context) {
  const previousStartsAtMs =
    FIRST_WEEK_STARTS_AT_MS - 7 * 24 * 60 * 60 * 1000;
  Object.assign(context.scheduleGenerations[0], {
    week_one_matchup_week_id: IDS.week,
    week_one_starts_at_ms: previousStartsAtMs,
    generation_status: "superseded",
    generation_superseded_at_ms: 2,
    generation_version: 2,
  });
  context.scheduleOperations.push({
    operation_league_id: IDS.league,
    operation_season_id: IDS.season,
    schedule_operation_id: IDS.replacementScheduleOperation,
    operation_matchup_week_id: null,
    operation_matchup_id: null,
    actor_user_id: IDS.commissioner,
    operation_status: "succeeded",
    reason: null,
    metadata_json: JSON.stringify({
      action: "shift_week_one",
      oldScheduleOperationId: IDS.scheduleOperation,
      oldScheduleVersion: 1,
      newScheduleVersion: 2,
      previousFirstWeekStartsAtMs: previousStartsAtMs,
      firstWeekStartsAtMs: FIRST_WEEK_STARTS_AT_MS,
      shiftedWeekCount: 1,
      replacedJobOccurrenceCount: 6,
      participantTeamIds: [IDS.teamA, IDS.teamB].sort(),
      responseSha256: "a".repeat(64),
    }),
    started_at_ms: 2,
    completed_at_ms: 2,
  });
  context.scheduleGenerations.push({
    generation_league_id: IDS.league,
    generation_season_id: IDS.season,
    schedule_version: 2,
    schedule_operation_id: IDS.replacementScheduleOperation,
    week_one_matchup_week_id: IDS.week,
    week_one_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    generation_status: "current",
    generation_created_at_ms: 2,
    generation_superseded_at_ms: null,
    generation_version: 1,
  });
  context.scheduleCommandResults.push({
    command_result_id: IDS.shiftCommandResult,
    command_league_id: IDS.league,
    command_season_id: IDS.season,
    command_action: "shift_week_one",
    command_matchup_operation_id: IDS.replacementScheduleOperation,
    command_actor_user_id: IDS.commissioner,
    command_old_schedule_operation_id: IDS.scheduleOperation,
    command_old_schedule_version: 1,
    command_new_schedule_operation_id: IDS.replacementScheduleOperation,
    command_new_schedule_version: 2,
    command_week_one_matchup_week_id: IDS.week,
    command_previous_first_week_starts_at_ms: previousStartsAtMs,
    command_first_week_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    command_shifted_week_count: 1,
    command_replaced_job_occurrence_count: 6,
    command_created_at_ms: 2,
    command_version: 1,
  });
  return context;
}

function withRecoveredCurrentSchedule(
  context,
  { recoveryKind = "completion" } = {}
) {
  const previousStartsAtMs =
    FIRST_WEEK_STARTS_AT_MS - 7 * 24 * 60 * 60 * 1000;
  Object.assign(context.scheduleGenerations[0], {
    week_one_matchup_week_id: IDS.priorWeek,
    week_one_starts_at_ms: previousStartsAtMs,
    generation_status: "superseded",
    generation_superseded_at_ms: 2,
    generation_version: 2,
  });
  context.scheduleOperations.push({
    operation_league_id: IDS.league,
    operation_season_id: IDS.season,
    schedule_operation_id: IDS.recoveryScheduleOperation,
    operation_matchup_week_id: null,
    operation_matchup_id: null,
    actor_user_id: null,
    operation_status: "succeeded",
    reason: `fad_${recoveryKind}_schedule_recovery`,
    metadata_json: JSON.stringify({
      fadId: IDS.fad,
      recoveryId: IDS.scheduleRecovery,
      recoveryKind,
      oldScheduleOperationId: IDS.scheduleOperation,
      oldScheduleVersion: 1,
      newScheduleVersion: 2,
    }),
    started_at_ms: 2,
    completed_at_ms: 2,
  });
  context.scheduleGenerations.push({
    generation_league_id: IDS.league,
    generation_season_id: IDS.season,
    schedule_version: 2,
    schedule_operation_id: IDS.recoveryScheduleOperation,
    week_one_matchup_week_id: IDS.week,
    week_one_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    generation_status: "current",
    generation_created_at_ms: 2,
    generation_superseded_at_ms: null,
    generation_version: 1,
  });
  context.scheduleRecoveries.push({
    recovery_id: IDS.scheduleRecovery,
    recovery_league_id: IDS.league,
    recovery_season_id: IDS.season,
    recovery_fad_id: IDS.fad,
    recovery_kind: recoveryKind,
    recovery_matchup_operation_id: IDS.recoveryScheduleOperation,
    recovery_old_schedule_operation_id: IDS.scheduleOperation,
    recovery_new_schedule_operation_id: IDS.recoveryScheduleOperation,
    recovery_old_first_matchup_week_id: IDS.priorWeek,
    recovery_new_first_matchup_week_id: IDS.week,
    recovery_old_schedule_version: 1,
    recovery_new_schedule_version: 2,
    recovery_old_week_one_starts_at_ms: previousStartsAtMs,
    recovery_new_week_one_starts_at_ms: FIRST_WEEK_STARTS_AT_MS,
    recovery_completed_at_ms: 2,
    recovery_evidence_schema_version: 1,
    recovery_evidence_sha256: "b".repeat(64),
    recovery_created_at_ms: 2,
    recovery_version: 1,
  });
  return context;
}

function resultSetHash(context) {
  return calculateStandingsResultSetHash({
    leagueId: context.aggregate.league_id,
    seasonId: context.aggregate.season_id,
    standingsRuleVersion: String(
      context.aggregate.standings_rule_version
    ),
    results: context.results.map((row) => ({
      matchupId: row.matchup_id,
      matchupResultId: row.matchup_result_id,
      resultVersionId: row.result_version_id,
      resultVersion: row.version_number,
    })),
  });
}

function command(harness, overrides = {}) {
  const input = overrides.input || {
    resultSetHash: harness.resultSetHash,
    confirmation:
      STANDINGS_FINALIZATION_CONFIRMATION,
  };
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    input,
    expectedSeasonVersion: 7,
    idempotencyKey: "t145-service-foundation",
    authenticated: {
      valid: true,
      user: { id: IDS.commissioner },
      session: {
        id: IDS.commissionerSession,
        userId: IDS.commissioner,
      },
    },
    auditContext: {
      requestCorrelationId: uuid(90),
      networkKeyVersion: 1,
      networkMetadataDigest: "d".repeat(64),
      clientMetadataJson:
        '{"networkSourceCategory":"direct"}',
    },
    ...overrides,
    input,
  };
}

function deepClone(value) {
  return structuredClone(value);
}

function createHarness({
  context = readyContext(),
  existing = null,
  replayResult = null,
  authority,
  failAt = null,
  failError,
  clockImplementation,
  idImplementation,
} = {}) {
  const state = {
    calls: [],
    persisted: [],
    transactionCount: 0,
    rollbackCount: 0,
    inTransaction: false,
    clockCalls: 0,
    idCalls: 0,
  };
  const canonicalContext =
    context === null ? null : deepClone(context);
  const canonicalAuthority = authority || {
    actorUserId: IDS.commissioner,
    membershipId: IDS.commissionerMembership,
    authority: "commissioner",
  };
  let idSequence = 1_000;

  function injected(method) {
    if (failAt !== method) return;
    throw (
      failError?.(method) ||
      new Error(`injected ${method} failure`)
    );
  }

  function read(method, options, value) {
    state.calls.push({ method, options });
    injected(method);
    return value;
  }

  function write(method, options) {
    const record = {
      method,
      options: deepClone(options),
    };
    state.calls.push(record);
    state.persisted.push(record);
    injected(method);
    return Object.freeze({ ...options });
  }

  function latestWrite(method) {
    return [...state.persisted]
      .reverse()
      .find((record) => record.method === method)
      ?.options;
  }

  function durableResult(options) {
    if (
      replayResult &&
      options.finalizationId ===
        IDS.replayFinalization
    ) {
      return replayResult;
    }
    const completed = latestWrite(
      "completeIdempotency"
    );
    const evidence = latestWrite(
      "insertFinalizationEvidence"
    );
    const snapshot = latestWrite(
      "insertFinalSnapshot"
    );
    const operation = latestWrite(
      "insertSucceededOperation"
    );
    if (
      !completed ||
      !evidence ||
      !snapshot ||
      !operation ||
      completed.finalizationId !==
        options.finalizationId
    ) {
      return null;
    }
    return {
      operation_id: operation.id,
      snapshot_id: snapshot.id,
      snapshot_version: snapshot.snapshotVersion,
      league_id: evidence.leagueId,
      season_id: evidence.seasonId,
      season_version:
        evidence.seasonVersionBefore + 1,
      standings_rule_version:
        evidence.standingsRuleVersion,
      result_set_hash: evidence.resultSetHash,
      expected_matchup_count:
        evidence.expectedMatchupCount,
      included_result_count:
        evidence.expectedMatchupCount,
      participant_count:
        evidence.participantCount,
      finalized_at_ms: evidence.nowMs,
    };
  }

  const repository = {
    readFinalizationContext(options) {
      return read(
        "readFinalizationContext",
        options,
        canonicalContext
      );
    },
    findIdempotency(options) {
      return read(
        "findIdempotency",
        options,
        existing
      );
    },
    findFinalizationResult(options) {
      state.calls.push({
        method: "findFinalizationResult",
        options,
      });
      injected("findFinalizationResult");
      return durableResult(options);
    },
    insertStartedIdempotency(options) {
      return write(
        "insertStartedIdempotency",
        options
      );
    },
    supersedeCurrentDerivedSnapshot(options) {
      return write(
        "supersedeCurrentDerivedSnapshot",
        options
      );
    },
    insertFinalSnapshot(options) {
      return write("insertFinalSnapshot", options);
    },
    insertStandingsRows(options) {
      return write("insertStandingsRows", options);
    },
    insertResultVersionLinks(options) {
      return write(
        "insertResultVersionLinks",
        options
      );
    },
    insertTeamIdentities(options) {
      return write("insertTeamIdentities", options);
    },
    insertSucceededOperation(options) {
      return write(
        "insertSucceededOperation",
        options
      );
    },
    insertFinalizationEvidence(options) {
      return write(
        "insertFinalizationEvidence",
        options
      );
    },
    writeFinalizedNotification(options) {
      return write(
        "writeFinalizedNotification",
        options
      );
    },
    writeFinalizedOutbox(options) {
      return write(
        "writeFinalizedOutbox",
        options
      );
    },
    advanceSeasonVersion(options) {
      return write(
        "advanceSeasonVersion",
        options
      );
    },
    completeIdempotency(options) {
      return write(
        "completeIdempotency",
        options
      );
    },
  };

  const repositoryContext = {
    transaction(callback) {
      state.transactionCount += 1;
      const persistedLength =
        state.persisted.length;
      state.inTransaction = true;
      try {
        return callback();
      } catch (error) {
        state.persisted.splice(persistedLength);
        state.rollbackCount += 1;
        throw error;
      } finally {
        state.inTransaction = false;
      }
    },
  };
  const leagueAuthorization = {
    requireCommissioner(authenticated, leagueId) {
      assert.equal(state.inTransaction, true);
      state.calls.push({
        method: "requireCommissioner",
        options: { authenticated, leagueId },
      });
      injected("requireCommissioner");
      if (canonicalAuthority instanceof Error) {
        throw canonicalAuthority;
      }
      return canonicalAuthority;
    },
  };
  const auditRepository = {
    append(record) {
      return write("audit.append", record);
    },
  };
  const clock = {
    nowMs() {
      state.clockCalls += 1;
      if (clockImplementation) {
        return clockImplementation();
      }
      return NOW_MS;
    },
  };
  const secureRandom = {
    id() {
      state.idCalls += 1;
      if (idImplementation) {
        return idImplementation();
      }
      const id = uuid(idSequence);
      idSequence += 1;
      return id;
    },
  };
  const service = createStandingsFinalizationService({
    repositoryContext,
    leagueAuthorization,
    standingsFinalizationRepository: repository,
    auditRepository,
    clock,
    secureRandom,
  });

  return {
    context: canonicalContext,
    repository,
    resultSetHash:
      context === null
        ? "a".repeat(64)
        : resultSetHash(context),
    service,
    state,
  };
}

function assertServiceError(
  action,
  code,
  reasonCode
) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error?.reasonCode, reasonCode);
    }
    return true;
  });
}

function assertNoWrites(harness) {
  assert.deepEqual(harness.state.persisted, []);
}

describe("T-145 standings-finalization application service", () => {
  test("persists one exact finalization graph in migration-compatible order and returns only the durable result", () => {
    const harness = createHarness();
    assert.ok(
      harness.context.weeks[0].starts_at_ms >
        harness.context.aggregate
          .regular_season_starts_at_ms,
      "the accepted fixture deliberately selects a later valid Week 1"
    );
    const request = command(harness);
    const result = harness.service.finalize(request);

    assert.deepEqual(result, {
      code: "STANDINGS_FINALIZED",
      finalization: {
        operationId: uuid(1_006),
        snapshotId: uuid(1_000),
        snapshotVersion: 3,
        leagueId: IDS.league,
        seasonId: IDS.season,
        seasonVersion: 8,
        standingsRuleVersion: 1,
        resultSetHash: harness.resultSetHash,
        expectedMatchupCount: 1,
        includedResultCount: 1,
        participantCount: 2,
        finalizedAtMs: NOW_MS,
      },
    });
    assert.equal(result.replayed, false);
    assert.deepEqual(Object.keys(result), [
      "code",
      "finalization",
    ]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.finalization));

    const persistedMethods =
      harness.state.persisted.map(
        ({ method }) => method
      );
    assert.deepEqual(persistedMethods, [
      "insertStartedIdempotency",
      "supersedeCurrentDerivedSnapshot",
      "insertFinalSnapshot",
      "insertStandingsRows",
      "insertResultVersionLinks",
      "insertTeamIdentities",
      "insertSucceededOperation",
      "insertFinalizationEvidence",
      "audit.append",
      "writeFinalizedNotification",
      "writeFinalizedNotification",
      "writeFinalizedOutbox",
      "advanceSeasonVersion",
      "completeIdempotency",
    ]);

    const byMethod = Object.fromEntries(
      harness.state.persisted.map((record) => [
        record.method,
        record.options,
      ])
    );
    const started =
      byMethod.insertStartedIdempotency;
    assert.equal(
      started.operation,
      STANDINGS_FINALIZATION_OPERATION
    );
    assert.equal(
      started.requestHash,
      standingsFinalizationRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        expectedSeasonVersion: 7,
        resultSetHash: harness.resultSetHash,
        confirmation:
          STANDINGS_FINALIZATION_CONFIRMATION,
      })
    );
    assert.equal(
      started.expiresAtMs,
      NOW_MS +
        STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS
    );
    assert.deepEqual(
      byMethod.supersedeCurrentDerivedSnapshot,
      {
        leagueId: IDS.league,
        seasonId: IDS.season,
        snapshotId: IDS.derivedSnapshot,
      }
    );
    assert.equal(
      byMethod.insertFinalSnapshot.sourceResultVersion,
      1
    );
    assert.deepEqual(
      byMethod.insertStandingsRows.rows.map(
        (row) => [
          row.teamId,
          row.wins,
          row.losses,
          row.standingsPoints,
          row.rank,
        ]
      ),
      [
        [IDS.teamA, 1, 0, 2, 1],
        [IDS.teamB, 0, 1, 0, 2],
      ]
    );
    assert.equal(
      byMethod.insertFinalizationEvidence
        .finalizationVersion,
      3
    );
    assert.equal(
      byMethod.insertSucceededOperation
        .actorAuthority,
      "commissioner"
    );
    assert.equal(
      byMethod.audit?.event_type,
      undefined
    );
    const audit = harness.state.persisted.find(
      ({ method }) => method === "audit.append"
    ).options;
    assert.equal(
      audit.event_type,
      FINALIZATION_AUDIT_EVENT_TYPE
    );
    assert.equal(
      audit.actor_user_id,
      IDS.commissioner
    );
    assert.equal(
      audit.session_id,
      IDS.commissionerSession
    );
    assert.deepEqual(
      JSON.parse(audit.client_metadata_json),
      {
        networkSourceCategory: "direct",
        actorAuthority: "commissioner",
      }
    );
    assert.deepEqual(
      harness.state.persisted
        .filter(
          ({ method }) =>
            method ===
            "writeFinalizedNotification"
        )
        .map(({ options }) => options.userId),
      [IDS.commissioner, IDS.member]
    );
    assert.equal(
      harness.state.clockCalls,
      1
    );
    assert.equal(
      harness.state.transactionCount,
      1
    );
  });

  test("accepts an exact superseded root followed by T-096 or either FAD-recovery kind", () => {
    for (const context of [
      withShiftedCurrentSchedule(readyContext()),
      withRecoveredCurrentSchedule(readyContext()),
      withRecoveredCurrentSchedule(readyContext(), {
        recoveryKind: "pre_open",
      }),
    ]) {
      const harness = createHarness({ context });
      const result = harness.service.finalize(
        command(harness)
      );
      assert.equal(result.code, "STANDINGS_FINALIZED");
      assert.equal(result.replayed, false);
      assert.equal(
        result.finalization.resultSetHash,
        harness.resultSetHash
      );
    }
  });

  test("fails closed on ambiguous, cross-scope, mismatched, or malformed schedule-generation lineage", () => {
    const cases = [
      (context) => {
        context.scheduleGenerations = [];
      },
      (context) => {
        context.scheduleGenerations.push({
          ...context.scheduleGenerations[0],
          schedule_version: 2,
          schedule_operation_id:
            IDS.replacementScheduleOperation,
        });
      },
      (context) => {
        context.scheduleGenerations[0]
          .generation_league_id = uuid(999);
      },
      (context) => {
        context.scheduleGenerations[0]
          .schedule_operation_id =
            IDS.replacementScheduleOperation;
      },
      (context) => {
        withShiftedCurrentSchedule(context);
        context.scheduleGenerations[0]
          .generation_superseded_at_ms = 3;
      },
      (context) => {
        withShiftedCurrentSchedule(context);
        context.scheduleGenerations[0]
          .generation_status = "unexpected";
      },
      (context) => {
        withShiftedCurrentSchedule(context);
        context.scheduleCommandResults[0]
          .command_old_schedule_operation_id =
            IDS.recoveryScheduleOperation;
      },
      (context) => {
        withRecoveredCurrentSchedule(context);
        context.scheduleOperations[1].reason =
          "fad_pre_open_schedule_recovery";
      },
      (context) => {
        withRecoveredCurrentSchedule(context);
        context.scheduleRecoveries = [];
      },
    ];
    for (const mutate of cases) {
      const context = readyContext();
      mutate(context);
      const harness = createHarness({ context });
      assertServiceError(
        () => harness.service.finalize(command(harness)),
        "STANDINGS_FINALIZATION_NOT_READY",
        "schedule_generation_evidence_invalid"
      );
      assertNoWrites(harness);
    }
  });

  test("requires exact once-per-week matchup or bye coverage for every participant", () => {
    const odd = readyContext();
    odd.scheduleOperations[0].metadata_json =
      JSON.stringify({
        participantCount: 3,
        participantTeamIds: [
          IDS.teamA,
          IDS.teamB,
          IDS.teamC,
        ].sort(),
        weekCount: 1,
        matchupCount: 1,
        jobOccurrenceCount: 0,
      });
    odd.participants.push({
      team_id: IDS.teamC,
      team_display_name: "Charlie",
      team_status: "active",
      primary_colour: "#334455",
      secondary_colour: "#bbccdd",
      tertiary_colour: null,
      pattern_template: "even-two",
      logo_reference: null,
      source_logo_object_id: null,
      logo_media_type: null,
      logo_byte_length: null,
      logo_width: null,
      logo_height: null,
      logo_content_sha256: null,
      logo_content_bytes: null,
    });
    odd.byes.push({
      bye_id: IDS.bye,
      matchup_week_id: IDS.week,
      team_id: IDS.teamC,
      joined_week_id: IDS.week,
      joined_week_season_id: IDS.season,
      joined_week_sequence: 1,
      joined_week_status: "final",
    });
    const accepted = createHarness({ context: odd });
    assert.equal(
      accepted.service.finalize(
        command(accepted)
      ).finalization.participantCount,
      3
    );

    for (const mutate of [
      (context) => {
        context.byes = [];
      },
      (context) => {
        context.byes[0].team_id = IDS.teamA;
      },
      (context) => {
        context.byes[0].joined_week_status =
          "awaiting_data";
      },
      (context) => {
        context.byes[0].joined_week_season_id =
          uuid(999);
      },
    ]) {
      const invalid = deepClone(odd);
      mutate(invalid);
      const harness = createHarness({
        context: invalid,
      });
      assertServiceError(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        "STANDINGS_FINALIZATION_NOT_READY"
      );
      assertNoWrites(harness);
    }
  });

  test("persists inherited active-member administrator authority distinctly", () => {
    const harness = createHarness({
      authority: {
        actorUserId: IDS.member,
        membershipId: IDS.memberMembership,
        authority: "platform_administrator",
      },
    });
    const result = harness.service.finalize(
      command(harness, {
        authenticated: {
          valid: true,
          user: { id: IDS.member },
          session: {
            id: IDS.memberSession,
            userId: IDS.member,
          },
        },
        idempotencyKey:
          "member-administrator-finalization",
      })
    );

    assert.equal(result.code, "STANDINGS_FINALIZED");
    const operation = harness.state.persisted.find(
      ({ method }) =>
        method === "insertSucceededOperation"
    ).options;
    assert.equal(operation.actorUserId, IDS.member);
    assert.equal(
      operation.actorMembershipId,
      IDS.memberMembership
    );
    assert.equal(
      operation.actorAuthority,
      "platform_administrator_as_commissioner"
    );
    const audit = harness.state.persisted.find(
      ({ method }) => method === "audit.append"
    ).options;
    assert.equal(audit.actor_user_id, IDS.member);
    assert.equal(audit.session_id, IDS.memberSession);
    assert.deepEqual(
      JSON.parse(audit.client_metadata_json),
      {
        networkSourceCategory: "direct",
        actorAuthority:
          "platform_administrator_as_commissioner",
      }
    );
  });

  test("returns an exact immutable replay before reading mutable context, clock, or identifiers", () => {
    const context = readyContext();
    const hash = resultSetHash(context);
    const requestHash =
      standingsFinalizationRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        expectedSeasonVersion: 7,
        resultSetHash: hash,
        confirmation:
          STANDINGS_FINALIZATION_CONFIRMATION,
      });
    const replayResult = {
      operation_id: IDS.replayOperation,
      snapshot_id: IDS.replaySnapshot,
      snapshot_version: 3,
      league_id: IDS.league,
      season_id: IDS.season,
      season_version: 8,
      standings_rule_version: 1,
      result_set_hash: hash,
      expected_matchup_count: 1,
      included_result_count: 1,
      participant_count: 2,
      finalized_at_ms: NOW_MS,
    };
    const harness = createHarness({
      context: {
        ...context,
        aggregate: {
          ...context.aggregate,
          league_status: "inactive",
          season_version: 99,
        },
      },
      existing: {
        id: uuid(60),
        league_id: IDS.league,
        actor_user_id: IDS.commissioner,
        operation:
          STANDINGS_FINALIZATION_OPERATION,
        client_key: "t145-service-foundation",
        request_hash: requestHash,
        status: "completed",
        result_type:
          STANDINGS_FINALIZATION_RESULT_TYPE,
        result_id: IDS.replayFinalization,
        created_at_ms: NOW_MS,
        completed_at_ms: NOW_MS,
        expires_at_ms:
          NOW_MS +
          STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS,
      },
      replayResult,
      clockImplementation() {
        throw new Error("replay called the clock");
      },
      idImplementation() {
        throw new Error(
          "replay generated an identifier"
        );
      },
    });
    harness.resultSetHash = hash;

    const replay = harness.service.finalize(
      command(harness)
    );

    assert.deepEqual(replay, {
      code: "STANDINGS_FINALIZED",
      finalization: {
        operationId: IDS.replayOperation,
        snapshotId: IDS.replaySnapshot,
        snapshotVersion: 3,
        leagueId: IDS.league,
        seasonId: IDS.season,
        seasonVersion: 8,
        standingsRuleVersion: 1,
        resultSetHash: hash,
        expectedMatchupCount: 1,
        includedResultCount: 1,
        participantCount: 2,
        finalizedAtMs: NOW_MS,
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(harness.state.clockCalls, 0);
    assert.equal(harness.state.idCalls, 0);
    assert.deepEqual(
      harness.state.calls.map(({ method }) => method),
      [
        "requireCommissioner",
        "findIdempotency",
        "findFinalizationResult",
      ]
    );
    assertNoWrites(harness);
  });

  test("reports the simultaneous different-key loser as already finalized before stale-version evaluation", () => {
    for (const evidence of [
      {
        cause: "regular_season_completion",
        operationType:
          "finalize_regular_season",
        resultType:
          STANDINGS_FINALIZATION_RESULT_TYPE,
      },
      {
        cause: "result_correction",
        operationType:
          "correction_propagation",
        resultType: "matchup_result_correction",
        resultId: IDS.resultVersion,
        resultLinkCount: 1,
      },
    ]) {
      const context = readyContext();
      context.aggregate.season_version = 8;
      Object.assign(context.snapshots[0], {
        snapshot_status: "final",
        finalization_id:
          IDS.replayFinalization,
        finalization_status: "final",
        evidence_schema_version: 1,
        finalization_cause: evidence.cause,
        operation_type:
          evidence.operationType,
        operation_status: "succeeded",
        idempotency_status: "completed",
        idempotency_result_type:
          evidence.resultType,
        idempotency_result_id:
          evidence.resultId ||
          IDS.replayFinalization,
        idempotency_result_link_count:
          evidence.resultLinkCount || 0,
      });
      const loser = createHarness({ context });

      assertServiceError(
        () =>
          loser.service.finalize(
            command(loser, {
              idempotencyKey:
                "simultaneous-different-key",
            })
          ),
        "STANDINGS_ALREADY_FINALIZED"
      );
      assert.equal(loser.state.clockCalls, 0);
      assert.equal(loser.state.idCalls, 0);
      assertNoWrites(loser);
    }

    const replacementContext = readyContext();
    replacementContext.aggregate.season_version = 9;
    const oldFinalizationId = uuid(53);
    Object.assign(replacementContext.snapshots[0], {
      snapshot_status: "superseded",
      finalization_id: oldFinalizationId,
      finalization_status: "superseded",
      evidence_schema_version: 1,
      finalization_cause:
        "regular_season_completion",
      operation_type: "finalize_regular_season",
      operation_status: "succeeded",
      idempotency_status: "completed",
      idempotency_result_type:
        STANDINGS_FINALIZATION_RESULT_TYPE,
      idempotency_result_id: oldFinalizationId,
    });
    replacementContext.snapshots.push({
      ...replacementContext.snapshots[0],
      snapshot_id: IDS.replaySnapshot,
      snapshot_version: 3,
      snapshot_status: "final",
      finalization_id: IDS.replayFinalization,
      finalization_status: "final",
      finalization_cause: "result_correction",
      operation_type: "correction_propagation",
      idempotency_result_type:
        "matchup_result_correction",
      idempotency_result_id:
        IDS.resultVersion,
      idempotency_result_link_count: 1,
    });
    const replaced = createHarness({
      context: replacementContext,
    });
    assertServiceError(
      () =>
        replaced.service.finalize(
          command(replaced, {
            idempotencyKey:
              "post-correction-different-key",
          })
        ),
      "STANDINGS_ALREADY_FINALIZED"
    );
    assertNoWrites(replaced);
  });

  test("validates route identifiers, body, version, and idempotency key before opening a transaction", () => {
    for (const overrides of [
      { leagueId: "not-a-league" },
      { seasonId: "not-a-season" },
      {
        input: {
          resultSetHash: "a".repeat(64),
          confirmation: "FINALIZE",
        },
      },
      { expectedSeasonVersion: 0 },
      { idempotencyKey: " trailing " },
    ]) {
      const harness = createHarness();
      assert.throws(() =>
        harness.service.finalize(
          command(harness, overrides)
        )
      );
      assert.equal(
        harness.state.transactionCount,
        0
      );
      assert.equal(harness.state.clockCalls, 0);
      assert.equal(harness.state.idCalls, 0);
      assertNoWrites(harness);
    }
  });

  test("fails readiness, provenance, authority, conflicts, and hash drift before the first write", () => {
    const cases = [
      {
        code: "STANDINGS_FINALIZATION_NOT_FOUND",
        context: null,
      },
      {
        code:
          "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
        mutate(context) {
          context.aggregate.season_version = 8;
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.weeks[0].status = "awaiting_data";
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.aggregate.scoring_rule_version =
            null;
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.scheduleOperations = [];
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.scheduleOperations.push({
            ...context.scheduleOperations[0],
            schedule_operation_id: uuid(999),
          });
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.scheduleOperations[0]
            .completed_at_ms = NOW_MS + 1;
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.scheduleOperations[0].metadata_json =
            JSON.stringify({
              participantCount: 3,
              participantTeamIds: [
                IDS.teamA,
                IDS.teamB,
                IDS.teamC,
              ].sort(),
              weekCount: 1,
              matchupCount: 1,
              jobOccurrenceCount: 0,
            });
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.scheduleOperations[0].metadata_json =
            JSON.stringify({
              participantCount: 2,
              participantTeamIds: [
                IDS.teamA,
                IDS.teamB,
              ].sort(),
              weekCount: 1,
              matchupCount: 1,
              unsupported: 0,
            });
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.results[0].result_version_count = 2;
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.results[0].invalid_version_chain_count =
            1;
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.results[0].result_status =
            "corrected";
        },
      },
      {
        code: "STANDINGS_FINALIZATION_NOT_READY",
        mutate(context) {
          context.participants[0].primary_colour =
            null;
        },
      },
      {
        code: "STANDINGS_ALREADY_FINALIZED",
        mutate(context) {
          Object.assign(context.snapshots[0], {
            snapshot_status: "final",
            finalization_id:
              IDS.replayFinalization,
            finalization_status: "final",
            evidence_schema_version: 1,
            finalization_cause:
              "regular_season_completion",
            operation_type:
              "finalize_regular_season",
            operation_status: "succeeded",
            idempotency_status: "completed",
            idempotency_result_type:
              STANDINGS_FINALIZATION_RESULT_TYPE,
            idempotency_result_id:
              IDS.replayFinalization,
          });
        },
      },
      {
        code:
          "STANDINGS_FINALIZATION_LEGACY_CONFLICT",
        mutate(context) {
          context.snapshots[0].snapshot_status =
            "final";
        },
      },
      {
        code:
          "STANDINGS_FINALIZATION_LEGACY_CONFLICT",
        mutate(context) {
          Object.assign(context.snapshots[0], {
            snapshot_status: "final",
            finalization_id:
              IDS.replayFinalization,
            finalization_status: "final",
            evidence_schema_version: 1,
            finalization_cause:
              "result_correction",
            operation_type:
              "correction_propagation",
            operation_status: "succeeded",
            idempotency_status: "completed",
            idempotency_result_type:
              "matchup_result_correction",
            idempotency_result_id:
              IDS.resultVersion,
            idempotency_result_link_count: 0,
          });
        },
      },
    ];

    for (const specification of cases) {
      const context =
        specification.context === null
          ? null
          : readyContext();
      specification.mutate?.(context);
      const harness = createHarness({ context });
      assertServiceError(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        specification.code
      );
      assertNoWrites(harness);
      assert.equal(harness.state.idCalls, 0);
    }

    const unauthorized = new Error(
      "commissioner required"
    );
    unauthorized.code =
      "LEAGUE_COMMISSIONER_REQUIRED";
    const denied = createHarness({
      authority: unauthorized,
    });
    assertServiceError(
      () =>
        denied.service.finalize(command(denied)),
      "LEAGUE_COMMISSIONER_REQUIRED"
    );
    assertNoWrites(denied);

    const drift = createHarness();
    assertServiceError(
      () =>
        drift.service.finalize(
          command(drift, {
            input: {
              resultSetHash: "f".repeat(64),
              confirmation:
                STANDINGS_FINALIZATION_CONFIRMATION,
            },
          })
        ),
      "STANDINGS_RESULT_SET_CHANGED"
    );
    assertNoWrites(drift);
    assert.equal(drift.state.idCalls, 0);
  });

  test("requires a coherent exact predecessor for corrected current result versions", () => {
    const corrected = readyContext();
    const result = corrected.results[0];
    const priorVersionId = uuid(34);
    const correctionActor = uuid(35);
    Object.assign(result, {
      result_status: "corrected",
      result_version_id: uuid(36),
      current_version_id: uuid(36),
      version_number: 2,
      latest_version_number: 2,
      result_version_count: 2,
      source_type: "correction",
      actor_user_id: correctionActor,
      reason: "Approved score correction",
      supersedes_version_id: priorVersionId,
      superseded_version_record_id:
        priorVersionId,
      previous_result_version_id:
        priorVersionId,
      superseded_version_matchup_result_id:
        IDS.matchupResult,
      superseded_version_number: 1,
      supersedes_previous_version: 1,
      invalid_version_chain_count: 0,
    });
    corrected.correctionOperations = [
      {
        correction_operation_id:
          IDS.correctionOperation,
        matchup_week_id: IDS.week,
        matchup_id: IDS.matchup,
        actor_user_id: correctionActor,
        operation_status: "succeeded",
        reason: "Approved score correction",
        metadata_json: JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId: uuid(36),
        }),
        started_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        completed_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        metadata_result_id: IDS.matchupResult,
        metadata_result_version_id: uuid(36),
        matched_result_version_id: uuid(36),
        matched_matchup_result_id:
          IDS.matchupResult,
        matched_version_number: 2,
        matched_source_type: "correction",
        matched_actor_user_id: correctionActor,
        matched_reason:
          "Approved score correction",
        matched_created_at_ms:
          FANTASY_PLAYOFFS_START_AT_MS,
        matched_supersedes_version_id:
          priorVersionId,
        current_matchup_result_id:
          IDS.matchupResult,
        current_result_version_id: uuid(36),
        current_result_status: "corrected",
        result_matchup_id: IDS.matchup,
      },
    ];
    const accepted = createHarness({
      context: corrected,
    });
    assert.equal(
      accepted.service.finalize(
        command(accepted)
      ).code,
      "STANDINGS_FINALIZED"
    );

    for (const mutate of [
      (row) => {
        row.superseded_version_record_id =
          uuid(37);
      },
      (row) => {
        row.superseded_version_matchup_result_id =
          uuid(38);
      },
      (row) => {
        row.superseded_version_number = 0;
      },
      (row) => {
        row.reason = " ";
      },
      (row) => {
        row.actor_user_id = null;
      },
      (row) => {
        row.result_version_count = 3;
      },
    ]) {
      const invalid = deepClone(corrected);
      mutate(invalid.results[0]);
      const harness = createHarness({
        context: invalid,
      });
      assertServiceError(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        "STANDINGS_FINALIZATION_NOT_READY"
      );
      assertNoWrites(harness);
    }

    for (const mutate of [
      (context) => {
        context.correctionOperations = [];
      },
      (context) => {
        context.correctionOperations.push({
          ...context.correctionOperations[0],
          correction_operation_id: uuid(55),
        });
      },
      (context) => {
        context.correctionOperations[0]
          .metadata_json = JSON.stringify({
          resultId: IDS.matchupResult,
          resultVersionId: uuid(56),
        });
      },
      (context) => {
        context.correctionOperations[0]
          .matched_actor_user_id =
          IDS.commissioner;
      },
      (context) => {
        context.correctionOperations[0]
          .completed_at_ms += 1;
      },
      (context) => {
        context.correctionOperations[0]
          .matchup_id = uuid(57);
      },
      (context) => {
        context.correctionOperations[0]
          .matched_version_number = 3;
      },
    ]) {
      const invalid = deepClone(corrected);
      mutate(invalid);
      const harness = createHarness({
        context: invalid,
      });
      assertServiceError(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        "STANDINGS_FINALIZATION_NOT_READY"
      );
      assertNoWrites(harness);
    }
  });

  test("rejects changed-payload replay and incomplete matching idempotency without mutable reads or writes", () => {
    const context = readyContext();
    const hash = resultSetHash(context);
    const base = {
      id: uuid(60),
      league_id: IDS.league,
      actor_user_id: IDS.commissioner,
      operation: STANDINGS_FINALIZATION_OPERATION,
      client_key: "t145-service-foundation",
      request_hash:
        standingsFinalizationRequestHash({
          leagueId: IDS.league,
          seasonId: IDS.season,
          expectedSeasonVersion: 7,
          resultSetHash: hash,
          confirmation:
            STANDINGS_FINALIZATION_CONFIRMATION,
        }),
      status: "completed",
      result_type:
        STANDINGS_FINALIZATION_RESULT_TYPE,
      result_id: IDS.replayFinalization,
      created_at_ms: NOW_MS,
      completed_at_ms: NOW_MS,
      expires_at_ms:
        NOW_MS +
        STANDINGS_FINALIZATION_IDEMPOTENCY_LIFETIME_MS,
    };
    const changed = createHarness({
      context,
      existing: base,
    });
    assertServiceError(
      () =>
        changed.service.finalize(
          command(changed, {
            input: {
              resultSetHash: "f".repeat(64),
              confirmation:
                STANDINGS_FINALIZATION_CONFIRMATION,
            },
          })
        ),
      "IDEMPOTENCY_KEY_REUSED"
    );
    assert.deepEqual(
      changed.state.calls.map(({ method }) => method),
      [
        "requireCommissioner",
        "findIdempotency",
      ]
    );
    assertNoWrites(changed);

    const incomplete = createHarness({
      context,
      existing: {
        ...base,
        status: "started",
        result_type: null,
        result_id: null,
        completed_at_ms: null,
      },
    });
    assertServiceError(
      () =>
        incomplete.service.finalize(
          command(incomplete)
        ),
      "IDEMPOTENCY_REQUEST_UNAVAILABLE"
    );
    assertNoWrites(incomplete);
  });

  test("rolls back every persistence, audit, notification, CAS, completion, and durable-read seam", () => {
    const seams = [
      "insertStartedIdempotency",
      "supersedeCurrentDerivedSnapshot",
      "insertFinalSnapshot",
      "insertStandingsRows",
      "insertResultVersionLinks",
      "insertTeamIdentities",
      "insertSucceededOperation",
      "insertFinalizationEvidence",
      "audit.append",
      "writeFinalizedNotification",
      "writeFinalizedOutbox",
      "advanceSeasonVersion",
      "completeIdempotency",
      "findFinalizationResult",
    ];
    for (const seam of seams) {
      const harness = createHarness({
        failAt: seam,
      });
      assert.throws(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        new RegExp(`injected ${seam} failure`)
      );
      assertNoWrites(harness);
      assert.equal(
        harness.state.rollbackCount,
        1,
        seam
      );
    }
  });

  test("maps repository concurrency conflicts to safe public service errors after rollback", () => {
    for (const specification of [
      {
        seam: "advanceSeasonVersion",
        error: {
          code: "REPOSITORY_VERSION_CONFLICT",
        },
        expected:
          "STANDINGS_FINALIZATION_PRECONDITION_FAILED",
      },
      {
        seam: "insertFinalizationEvidence",
        error: {
          code: "REPOSITORY_CONSTRAINT",
          details: {
            tableName:
              "standings_snapshot_finalizations",
          },
        },
        expected: "STANDINGS_ALREADY_FINALIZED",
      },
      {
        seam: "insertStartedIdempotency",
        error: {
          code: "REPOSITORY_CONSTRAINT",
          details: {
            tableName: "idempotency_requests",
          },
        },
        expected: "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      },
    ]) {
      const harness = createHarness({
        failAt: specification.seam,
        failError() {
          return Object.assign(
            new Error("repository conflict"),
            specification.error
          );
        },
      });
      assertServiceError(
        () =>
          harness.service.finalize(
            command(harness)
          ),
        specification.expected
      );
      assertNoWrites(harness);
      assert.equal(harness.state.rollbackCount, 1);
    }
  });
});
