const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MATCHUP_RESULT_CORRECTION_IDEMPOTENCY_LIFETIME_MS,
  MATCHUP_RESULT_CORRECTION_OPERATION,
  createMatchupResultCorrectionService,
  matchupResultCorrectionRequestHash,
} = require(
  "../../src/application/services/matchups/createMatchupResultCorrectionService"
);
const {
  calculateStandingsResultSetHash,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);
const {
  MatchupResultCorrectionPolicyError,
  validateMatchupResultCorrectionExpectedVersion,
  validateMatchupResultCorrectionIdempotencyKey,
  validateMatchupResultCorrectionInput,
  validateMatchupResultCorrectionLeagueId,
  validateMatchupResultCorrectionPreviewInput,
  validateMatchupResultCorrectionResultId,
  validateMatchupResultCorrectionSeasonId,
} = require(
  "../../src/domain/matchups/matchupResultCorrectionPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  commissioner: uuid(10),
  commissionerMembership: uuid(11),
  commissionerSession: uuid(12),
  manager: uuid(13),
  league: uuid(1),
  season: uuid(2),
  result: uuid(3),
  week: uuid(4),
  matchup: uuid(5),
  homeTeam: uuid(6),
  awayTeam: uuid(7),
  statSnapshot: uuid(8),
  resultVersionOne: uuid(9),
  canonicalSnapshot: uuid(20),
  canonicalFinalization: uuid(21),
  canonicalOperation: uuid(22),
  canonicalIdempotency: uuid(23),
  canonicalHomeRow: uuid(24),
  canonicalAwayRow: uuid(25),
  canonicalLink: uuid(26),
  canonicalHomeIdentity: uuid(27),
  canonicalAwayIdentity: uuid(28),
  requestCorrelation: uuid(29),
});

const NOW_MS = Date.parse(
  "2026-07-29T18:00:00.000Z"
);

describe("T097 matchup-result correction policy", () => {
  test("accepts only canonical command metadata and exact preview/apply bodies", () => {
    assert.equal(
      validateMatchupResultCorrectionLeagueId(
        IDS.league
      ),
      IDS.league
    );
    assert.equal(
      validateMatchupResultCorrectionSeasonId(
        IDS.season
      ),
      IDS.season
    );
    assert.equal(
      validateMatchupResultCorrectionResultId(
        IDS.result
      ),
      IDS.result
    );
    assert.equal(
      validateMatchupResultCorrectionExpectedVersion(
        3
      ),
      3
    );
    assert.equal(
      validateMatchupResultCorrectionIdempotencyKey(
        "opaque-correction-key"
      ),
      "opaque-correction-key"
    );
    assert.deepEqual(
      validateMatchupResultCorrectionPreviewInput({
        confirmed: false,
      }),
      { confirmed: false }
    );
    assert.deepEqual(
      validateMatchupResultCorrectionInput({
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 500,
        reason: "Provider correction approved",
      }),
      {
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 500,
        outcome: "tie",
        reason: "Provider correction approved",
        writtenReason: "Provider correction approved",
      }
    );
    assert.deepEqual(
      validateMatchupResultCorrectionInput({
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
      }),
      {
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
        outcome: "home_win",
        reason: "Official matchup result correction",
        writtenReason: null,
      }
    );
  });

  test("rejects malformed scope, preconditions, keys, scores, reasons, and overposting", () => {
    const valid = {
      confirmed: true,
      homeScoreHundredths: 500,
      awayScoreHundredths: 400,
      reason: "Provider correction approved",
    };
    const cases = [
      [
        () =>
          validateMatchupResultCorrectionLeagueId(
            "league"
          ),
        "league_id_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionSeasonId(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              .toUpperCase()
          ),
        "season_id_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionResultId(
            uuid(3).replace("-4000-", "-1000-")
          ),
        "result_id_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionExpectedVersion(
            0
          ),
        "expected_version_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionIdempotencyKey(
            ""
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionIdempotencyKey(
            "x".repeat(129)
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionIdempotencyKey(
            " padded "
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionIdempotencyKey(
            "line\u2028break"
          ),
        "idempotency_key_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionPreviewInput(
            { confirmed: true }
          ),
        "preview_body_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionPreviewInput({
            confirmed: false,
            reason: "unsupported",
          }),
        "preview_body_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            confirmed: false,
          }),
        "body_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            unsupported: true,
          }),
        "body_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            homeScoreHundredths: -1,
          }),
        "home_score_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            awayScoreHundredths: 1.5,
          }),
        "away_score_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            reason: " padded ",
          }),
        "reason_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            confirmed: true,
            homeScoreHundredths: 500,
            awayScoreHundredths: 400,
            reason: "",
          }),
        "reason_invalid",
      ],
      [
        () =>
          validateMatchupResultCorrectionInput({
            ...valid,
            reason: "line\u2029break",
          }),
        "reason_invalid",
      ],
    ];

    for (const [callback, reasonCode] of cases) {
      assert.throws(
        callback,
        (error) =>
          error instanceof
            MatchupResultCorrectionPolicyError &&
          error.code ===
            "MATCHUP_RESULT_CORRECTION_INPUT_INVALID" &&
          error.reasonCode === reasonCode,
        reasonCode
      );
    }
  });
});

function correctionInput(overrides = {}) {
  return {
    confirmed: true,
    homeScoreHundredths: 450,
    awayScoreHundredths: 375,
    reason: "Approved official scoring correction",
    ...overrides,
  };
}

function correctionCommand(overrides = {}) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    resultId: IDS.result,
    input: correctionInput(),
    expectedResultVersion: 1,
    idempotencyKey: "t097-correction-key",
    authenticated: {
      valid: true,
      user: { id: IDS.commissioner },
      session: {
        id: IDS.commissionerSession,
        userId: IDS.commissioner,
      },
    },
    auditContext: {
      requestCorrelationId:
        IDS.requestCorrelation,
      networkKeyVersion: null,
      networkMetadataDigest: null,
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "direct",
      }),
    },
    ...overrides,
  };
}

function calculatedVersion(overrides = {}) {
  return {
    result_version_id: IDS.resultVersionOne,
    version_number: 1,
    home_team_id: IDS.homeTeam,
    away_team_id: IDS.awayTeam,
    home_score_hundredths: 400,
    away_score_hundredths: 300,
    outcome: "home_win",
    source_snapshot_id: IDS.statSnapshot,
    source_type: "calculated",
    actor_user_id: null,
    reason: null,
    supersedes_version_id: null,
    created_at_ms: NOW_MS - 2_000,
    ...overrides,
  };
}

function baseContext(overrides = {}) {
  const version = calculatedVersion(
    overrides.version
  );
  return {
    aggregate: {
      league_id: IDS.league,
      league_status: "active",
      current_season_id: IDS.season,
      season_id: IDS.season,
      season_status: "active",
      season_version: 4,
      standings_rule_version: 1,
      ...overrides.aggregate,
    },
    matchup: {
      matchup_id: IDS.matchup,
      matchup_week_id: IDS.week,
      home_team_id: IDS.homeTeam,
      away_team_id: IDS.awayTeam,
      matchup_status: "final",
      matchup_version: 3,
      week_status: "final",
      week_version: 4,
      ...overrides.matchup,
    },
    result: {
      result_id: IDS.result,
      current_version_id:
        version.result_version_id,
      result_status: "official",
      result_version: 1,
      finalized_at_ms: NOW_MS - 2_000,
      ...overrides.result,
    },
    versions: overrides.versions || [version],
    finalizations: [],
    canonicalFinalizationHistoryCount: 0,
    activeFinalization: null,
    activeMemberUserIds: [
      IDS.commissioner,
      IDS.manager,
    ],
    ...overrides.context,
  };
}

function identity(
  id,
  teamId,
  teamDisplayName,
  primaryColour,
  secondaryColour
) {
  return {
    id,
    standings_snapshot_id:
      IDS.canonicalSnapshot,
    team_id: teamId,
    team_display_name: teamDisplayName,
    primary_colour: primaryColour,
    secondary_colour: secondaryColour,
    tertiary_colour: null,
    pattern_template: "even-two",
    source_logo_object_id: null,
    logo_media_type: null,
    logo_byte_length: null,
    logo_width: null,
    logo_height: null,
    logo_content_sha256: null,
    logo_content_bytes: null,
  };
}

function canonicalFinalization() {
  const resultSetHash =
    calculateStandingsResultSetHash({
      leagueId: IDS.league,
      seasonId: IDS.season,
      standingsRuleVersion: "1",
      results: [
        {
          matchupId: IDS.matchup,
          matchupResultId: IDS.result,
          resultVersionId:
            IDS.resultVersionOne,
          resultVersion: 1,
        },
      ],
    });
  return {
    finalization_id:
      IDS.canonicalFinalization,
    standings_snapshot_id:
      IDS.canonicalSnapshot,
    finalization_version: 1,
    status: "final",
    cause: "regular_season_completion",
    standings_rule_version: 1,
    result_set_hash: resultSetHash,
    expected_matchup_count: 1,
    expected_week_count: 1,
    participant_count: 2,
    season_version_before: 3,
    season_version_after: 4,
    standings_operation_id:
      IDS.canonicalOperation,
    idempotency_request_id:
      IDS.canonicalIdempotency,
    replaces_finalization_id: null,
    finalized_at_ms: NOW_MS - 1_000,
  };
}

function finalizedContext(overrides = {}) {
  const finalization = canonicalFinalization();
  const context = baseContext({
    ...overrides,
    context: undefined,
  });
  context.finalizations = [finalization];
  context.canonicalFinalizationHistoryCount = 1;
  context.activeFinalization = {
    finalization,
    snapshot: {
      snapshot_id: IDS.canonicalSnapshot,
      snapshot_version: 1,
      source_result_version: 1,
      snapshot_status: "final",
      calculated_at_ms:
        finalization.finalized_at_ms,
      created_at_ms:
        finalization.finalized_at_ms,
    },
    rows: [
      {
        id: IDS.canonicalHomeRow,
        standings_snapshot_id:
          IDS.canonicalSnapshot,
        team_id: IDS.homeTeam,
        rank: 1,
        wins: 1,
        losses: 0,
        ties: 0,
        standings_points: 2,
        fantasy_points_for_hundredths: 400,
        fantasy_points_against_hundredths: 300,
        fantasy_point_differential_hundredths: 100,
      },
      {
        id: IDS.canonicalAwayRow,
        standings_snapshot_id:
          IDS.canonicalSnapshot,
        team_id: IDS.awayTeam,
        rank: 2,
        wins: 0,
        losses: 1,
        ties: 0,
        standings_points: 0,
        fantasy_points_for_hundredths: 300,
        fantasy_points_against_hundredths: 400,
        fantasy_point_differential_hundredths: -100,
      },
    ],
    links: [
      {
        id: IDS.canonicalLink,
        matchup_week_id: IDS.week,
        matchup_id: IDS.matchup,
        matchup_result_id: IDS.result,
        matchup_result_version_id:
          IDS.resultVersionOne,
        result_version_number: 1,
        home_team_id: IDS.homeTeam,
        away_team_id: IDS.awayTeam,
        home_score_hundredths: 400,
        away_score_hundredths: 300,
        outcome: "home_win",
        source_snapshot_id: IDS.statSnapshot,
        source_type: "calculated",
        actor_user_id: null,
        reason: null,
        supersedes_version_id: null,
        result_created_at_ms: NOW_MS - 2_000,
      },
    ],
    identities: [
      identity(
        IDS.canonicalHomeIdentity,
        IDS.homeTeam,
        "Historical Home",
        "#112233",
        "#445566"
      ),
      identity(
        IDS.canonicalAwayIdentity,
        IDS.awayTeam,
        "Historical Away",
        "#223344",
        "#556677"
      ),
    ],
  };
  context.activeMemberUserIds = [
    IDS.commissioner,
    IDS.manager,
  ];
  if (overrides.context) {
    Object.assign(context, overrides.context);
  }
  return context;
}

function durableFromCommand(command) {
  const replacement = command.replacement;
  return {
    result_id: command.resultId,
    result_version_id:
      command.correction.resultVersionId,
    result_version_number:
      command.correction.versionNumber,
    result_version:
      command.correction.versionNumber,
    league_id: command.leagueId,
    season_id: command.seasonId,
    matchup_week_id: IDS.week,
    matchup_id: IDS.matchup,
    corrected_at_ms: command.nowMs,
    standings_rows_changed:
      replacement?.standingsRowsChanged ?? false,
    replacement_snapshot_id:
      replacement?.snapshotId ?? null,
    replacement_snapshot_version:
      replacement?.snapshotVersion ?? null,
    replacement_result_set_hash:
      replacement?.resultSetHash ?? null,
    evidence: {
      correctionOperationId:
        command.correction.matchupOperationId,
      correctionOperationMetadataJson:
        JSON.stringify({
          resultId: command.resultId,
          resultVersionId:
            command.correction.resultVersionId,
        }),
      idempotencyRequestId:
        command.idempotency.id,
      idempotencyActorUserId:
        command.actorUserId,
      idempotencyOperation:
        MATCHUP_RESULT_CORRECTION_OPERATION,
      idempotencyClientKey:
        command.idempotency.clientKey,
      idempotencyRequestHash:
        command.idempotency.requestHash,
      idempotencyCompletedAtMs: command.nowMs,
      replacementFinalizationId:
        replacement?.finalizationId ?? null,
      replacementStandingsOperationId:
        replacement?.standingsOperationId ?? null,
    },
  };
}

function createFixture({
  context = baseContext(),
  existing = null,
  durable = null,
  authority = null,
  nowMs = NOW_MS,
  repositoryError = null,
  correctImplementation = null,
  clockImplementation = null,
  secureIdImplementation = null,
} = {}) {
  const calls = [];
  let idSequence = 100;
  let transactionDepth = 0;
  const repository = {
    findIdempotency(input) {
      calls.push({
        method: "findIdempotency",
        input,
      });
      return existing;
    },
    findCorrectionResult(input) {
      calls.push({
        method: "findCorrectionResult",
        input,
      });
      return durable;
    },
    readCorrectionContext(input) {
      calls.push({
        method: "readCorrectionContext",
        input,
      });
      return context;
    },
    correct(input) {
      calls.push({ method: "correct", input });
      if (repositoryError) throw repositoryError;
      return correctImplementation
        ? correctImplementation(input)
        : durableFromCommand(input);
    },
  };
  const clock = {
    nowMs() {
      calls.push({ method: "clock" });
      return clockImplementation
        ? clockImplementation()
        : nowMs;
    },
  };
  const secureRandom = {
    id() {
      calls.push({ method: "secureId" });
      if (secureIdImplementation) {
        return secureIdImplementation();
      }
      idSequence += 1;
      return uuid(idSequence);
    },
  };
  const leagueAuthorization = {
    requireCommissioner(
      authenticated,
      leagueId
    ) {
      calls.push({
        method: "requireCommissioner",
        authenticated,
        leagueId,
        inTransaction: transactionDepth > 0,
      });
      return (
        authority || {
          actorUserId: IDS.commissioner,
          membershipId:
            IDS.commissionerMembership,
          authority: "commissioner",
        }
      );
    },
  };
  const repositoryContext = {
    transaction(callback) {
      calls.push({ method: "transaction" });
      transactionDepth += 1;
      try {
        return callback();
      } finally {
        transactionDepth -= 1;
      }
    },
  };
  return {
    calls,
    repository,
    service:
      createMatchupResultCorrectionService({
        repositoryContext,
        leagueAuthorization,
        repository,
        clock,
        secureRandom,
      }),
  };
}

function writeCalls(fixture) {
  return fixture.calls.filter(
    ({ method }) => method === "correct"
  );
}

describe("T097 matchup-result correction service", () => {
  test("appends a pre-final correction with mandatory audit, exact evidence, and no standings replacement", () => {
    const fixture = createFixture();
    const command = correctionCommand({
      input: {
        confirmed: true,
        homeScoreHundredths: 450,
        awayScoreHundredths: 375,
      },
    });
    const result = fixture.service.correct(command);

    assert.deepEqual(result, {
      code: "MATCHUP_RESULT_CORRECTED",
      result: {
        resultId: IDS.result,
        resultVersionId:
          writeCalls(fixture)[0].input.correction
            .resultVersionId,
        resultVersionNumber: 2,
        resultVersion: 2,
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        matchupId: IDS.matchup,
        correctedAtMs: NOW_MS,
        standingsReplacement: null,
      },
    });
    assert.equal(result.replayed, false);
    assert.deepEqual(
      fixture.calls
        .filter(({ method }) =>
          [
            "transaction",
            "requireCommissioner",
            "findIdempotency",
            "readCorrectionContext",
            "clock",
            "correct",
          ].includes(method)
        )
        .map(({ method }) => method),
      [
        "transaction",
        "requireCommissioner",
        "findIdempotency",
        "readCorrectionContext",
        "clock",
        "correct",
      ]
    );

    const persisted = writeCalls(fixture)[0].input;
    assert.equal(
      persisted.actorAuthority,
      "commissioner"
    );
    assert.equal(
      persisted.expectedSeasonVersion,
      4
    );
    assert.equal(
      persisted.correction.versionNumber,
      2
    );
    assert.equal(
      persisted.correction.supersedesVersionId,
      IDS.resultVersionOne
    );
    assert.equal(
      persisted.correction.reason,
      "Official matchup result correction"
    );
    assert.equal(persisted.replacement, null);
    assert.match(
      persisted.preFinalOutboxId,
      /^[0-9a-f-]{36}$/
    );
    assert.equal(
      persisted.idempotency.expiresAtMs,
      NOW_MS +
        MATCHUP_RESULT_CORRECTION_IDEMPOTENCY_LIFETIME_MS
    );
    assert.equal(
      persisted.idempotency.requestHash,
      matchupResultCorrectionRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.result,
        expectedResultVersion: 1,
        input:
          validateMatchupResultCorrectionInput(
            command.input
          ),
      })
    );
    assert.equal(
      persisted.audit.event_type,
      "matchup.result_corrected"
    );
    assert.equal(
      persisted.audit.actor_user_id,
      IDS.commissioner
    );
    assert.equal(
      persisted.audit.occurred_at_ms,
      NOW_MS
    );
    assert.deepEqual(
      JSON.parse(
        persisted.audit.client_metadata_json
      ),
      {
        networkSourceCategory: "direct",
        actorAuthority: "commissioner",
      }
    );
  });

  test("builds a complete post-final replacement from immutable identities and notifies active members when official rows change", () => {
    const fixture = createFixture({
      context: finalizedContext(),
    });
    const result = fixture.service.correct(
      correctionCommand({
        input: correctionInput({
          homeScoreHundredths: 250,
          awayScoreHundredths: 500,
        }),
      })
    );
    const command = writeCalls(fixture)[0].input;
    const replacement = command.replacement;

    assert.equal(
      result.result.standingsReplacement
        .standingsRowsChanged,
      true
    );
    assert.equal(
      result.result.standingsReplacement.snapshotId,
      replacement.snapshotId
    );
    assert.equal(
      result.result.standingsReplacement
        .snapshotVersion,
      2
    );
    assert.equal(command.preFinalOutboxId, null);
    assert.equal(
      replacement.standingsRuleVersion,
      1
    );
    assert.equal(replacement.sourceResultVersion, 2);
    assert.equal(replacement.rows.length, 2);
    assert.deepEqual(
      replacement.rows.map(
        ({ teamId, rank, wins, losses }) => ({
          teamId,
          rank,
          wins,
          losses,
        })
      ),
      [
        {
          teamId: IDS.awayTeam,
          rank: 1,
          wins: 1,
          losses: 0,
        },
        {
          teamId: IDS.homeTeam,
          rank: 2,
          wins: 0,
          losses: 1,
        },
      ]
    );
    assert.equal(replacement.links.length, 1);
    assert.equal(
      replacement.links[0].resultVersionId,
      command.correction.resultVersionId
    );
    assert.equal(
      replacement.links[0].resultVersionNumber,
      2
    );
    assert.deepEqual(
      replacement.identities.map(
        ({
          teamId,
          teamDisplayName,
          primaryColour,
          secondaryColour,
        }) => ({
          teamId,
          teamDisplayName,
          primaryColour,
          secondaryColour,
        })
      ),
      [
        {
          teamId: IDS.homeTeam,
          teamDisplayName: "Historical Home",
          primaryColour: "#112233",
          secondaryColour: "#445566",
        },
        {
          teamId: IDS.awayTeam,
          teamDisplayName: "Historical Away",
          primaryColour: "#223344",
          secondaryColour: "#556677",
        },
      ]
    );
    assert.deepEqual(
      replacement.notifications.map(
        ({ userId }) => userId
      ),
      [IDS.commissioner, IDS.manager].sort()
    );
    assert.equal(
      replacement.resultSetHash,
      calculateStandingsResultSetHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        standingsRuleVersion: "1",
        results: [
          {
            matchupId: IDS.matchup,
            matchupResultId: IDS.result,
            resultVersionId:
              command.correction.resultVersionId,
            resultVersion: 2,
          },
        ],
      })
    );
  });

  test("still replaces canonical provenance but sends no notification when official rows are unchanged", () => {
    const fixture = createFixture({
      context: finalizedContext(),
    });
    const result = fixture.service.correct(
      correctionCommand({
        input: correctionInput({
          homeScoreHundredths: 400,
          awayScoreHundredths: 300,
        }),
      })
    );
    const replacement =
      writeCalls(fixture)[0].input.replacement;
    assert(replacement);
    assert.equal(
      replacement.standingsRowsChanged,
      false
    );
    assert.deepEqual(replacement.notifications, []);
    assert.equal(
      result.result.standingsReplacement
        .standingsRowsChanged,
      false
    );
  });

  test("returns exact immutable replay before context, clock, identifiers, or writes", () => {
    const command = correctionCommand();
    const canonicalInput =
      validateMatchupResultCorrectionInput(
        command.input
      );
    const requestHash =
      matchupResultCorrectionRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.result,
        expectedResultVersion: 1,
        input: canonicalInput,
      });
    const idempotencyId = uuid(500);
    const resultVersionId = uuid(501);
    const operationId = uuid(502);
    const existing = {
      id: idempotencyId,
      league_id: IDS.league,
      actor_user_id: IDS.commissioner,
      operation:
        MATCHUP_RESULT_CORRECTION_OPERATION,
      client_key: command.idempotencyKey,
      request_hash: requestHash,
      status: "completed",
      result_type:
        "matchup_result_correction",
      result_id: resultVersionId,
      completed_at_ms: NOW_MS - 100,
    };
    const durable = {
      result_id: IDS.result,
      result_version_id: resultVersionId,
      result_version_number: 2,
      result_version: 2,
      league_id: IDS.league,
      season_id: IDS.season,
      matchup_week_id: IDS.week,
      matchup_id: IDS.matchup,
      corrected_at_ms: NOW_MS - 100,
      standings_rows_changed: 0,
      replacement_snapshot_id: null,
      replacement_snapshot_version: null,
      replacement_result_set_hash: null,
      evidence: {
        correctionOperationId: operationId,
        correctionOperationMetadataJson:
          JSON.stringify({
            resultId: IDS.result,
            resultVersionId,
          }),
        idempotencyRequestId: idempotencyId,
        idempotencyActorUserId:
          IDS.commissioner,
        idempotencyOperation:
          MATCHUP_RESULT_CORRECTION_OPERATION,
        idempotencyClientKey:
          command.idempotencyKey,
        idempotencyRequestHash: requestHash,
        idempotencyCompletedAtMs:
          NOW_MS - 100,
        replacementFinalizationId: null,
        replacementStandingsOperationId: null,
      },
    };
    const fixture = createFixture({
      existing,
      durable,
      context: new Proxy(
        {},
        {
          get() {
            throw new Error(
              "mutable context was read"
            );
          },
        }
      ),
      clockImplementation() {
        throw new Error("clock sampled");
      },
      secureIdImplementation() {
        throw new Error("identifier generated");
      },
    });

    const replay = fixture.service.correct(command);
    assert.deepEqual(replay, {
      code: "MATCHUP_RESULT_CORRECTED",
      result: {
        resultId: IDS.result,
        resultVersionId,
        resultVersionNumber: 2,
        resultVersion: 2,
        leagueId: IDS.league,
        seasonId: IDS.season,
        weekId: IDS.week,
        matchupId: IDS.matchup,
        correctedAtMs: NOW_MS - 100,
        standingsReplacement: null,
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(
      fixture.calls.find(
        ({ method }) =>
          method === "requireCommissioner"
      ).inTransaction,
      true
    );
    assert.deepEqual(
      fixture.calls.map(({ method }) => method),
      [
        "transaction",
        "requireCommissioner",
        "findIdempotency",
        "findCorrectionResult",
      ]
    );
  });

  test("returns the durable winner when a same-key transaction converges after the optimistic read", () => {
    const winner = Object.freeze({
      idempotencyId: uuid(550),
      operationId: uuid(551),
      resultVersionId: uuid(552),
      correctedAtMs: NOW_MS - 50,
    });
    let loserCommand;
    const fixture = createFixture({
      correctImplementation(command) {
        loserCommand = command;
        const durable =
          durableFromCommand(command);
        return {
          ...durable,
          result_version_id:
            winner.resultVersionId,
          corrected_at_ms:
            winner.correctedAtMs,
          evidence: {
            ...durable.evidence,
            correctionOperationId:
              winner.operationId,
            correctionOperationMetadataJson:
              JSON.stringify({
                resultId: IDS.result,
                resultVersionId:
                  winner.resultVersionId,
              }),
            idempotencyRequestId:
              winner.idempotencyId,
            idempotencyCompletedAtMs:
              winner.correctedAtMs,
          },
        };
      },
    });

    const result = fixture.service.correct(
      correctionCommand()
    );
    assert.equal(result.replayed, true);
    assert.equal(
      result.result.resultVersionId,
      winner.resultVersionId
    );
    assert.equal(
      result.result.correctedAtMs,
      winner.correctedAtMs
    );
    assert.notEqual(
      result.result.resultVersionId,
      loserCommand.correction.resultVersionId
    );
    assert.notEqual(
      winner.idempotencyId,
      loserCommand.idempotency.id
    );
  });

  test("binds omitted written reason distinctly from explicitly supplying the fallback text", () => {
    const omitted =
      validateMatchupResultCorrectionInput({
        confirmed: true,
        homeScoreHundredths: 450,
        awayScoreHundredths: 375,
      });
    const explicit =
      validateMatchupResultCorrectionInput({
        confirmed: true,
        homeScoreHundredths: 450,
        awayScoreHundredths: 375,
        reason:
          "Official matchup result correction",
      });
    assert.equal(omitted.reason, explicit.reason);
    assert.notEqual(
      matchupResultCorrectionRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.result,
        expectedResultVersion: 1,
        input: omitted,
      }),
      matchupResultCorrectionRequestHash({
        leagueId: IDS.league,
        seasonId: IDS.season,
        resultId: IDS.result,
        expectedResultVersion: 1,
        input: explicit,
      })
    );
  });

  test("accepts paired correction-required recovery state and rejects either mixed state without writes", () => {
    const recovery = createFixture({
      context: baseContext({
        matchup: {
          matchup_status:
            "correction_required",
          matchup_version: 8,
          week_status: "correction_required",
          week_version: 9,
        },
      }),
    });
    const recovered = recovery.service.correct(
      correctionCommand()
    );
    assert.equal(
      recovered.code,
      "MATCHUP_RESULT_CORRECTED"
    );
    assert.equal(writeCalls(recovery).length, 1);
    assert.equal(
      writeCalls(recovery)[0].input.resultId,
      IDS.result
    );

    for (const matchup of [
      {
        matchup_status: "final",
        matchup_version: 3,
        week_status: "correction_required",
        week_version: 4,
      },
      {
        matchup_status:
          "correction_required",
        matchup_version: 3,
        week_status: "final",
        week_version: 4,
      },
    ]) {
      const mixed = createFixture({
        context: baseContext({ matchup }),
      });
      assert.throws(
        () =>
          mixed.service.correct(
            correctionCommand()
          ),
        {
          code:
            "MATCHUP_RESULT_CORRECTION_STATE_INVALID",
        }
      );
      assert.equal(writeCalls(mixed).length, 0);
    }
  });

  test("rejects changed-key replay, stale state, missing resources, broken canonical history, and backdating without writes", () => {
    const baseCommand = correctionCommand();
    const canonicalInput =
      validateMatchupResultCorrectionInput(
        baseCommand.input
      );
    const existing = {
      id: uuid(600),
      league_id: IDS.league,
      actor_user_id: IDS.commissioner,
      operation:
        MATCHUP_RESULT_CORRECTION_OPERATION,
      client_key: baseCommand.idempotencyKey,
      request_hash:
        matchupResultCorrectionRequestHash({
          leagueId: IDS.league,
          seasonId: IDS.season,
          resultId: IDS.result,
          expectedResultVersion: 1,
          input: canonicalInput,
        }),
      status: "completed",
      result_type:
        "matchup_result_correction",
      result_id: uuid(601),
      completed_at_ms: NOW_MS,
    };
    const changedReplay = createFixture({
      existing,
    });
    assert.throws(
      () =>
        changedReplay.service.correct(
          correctionCommand({
            input: correctionInput({
              homeScoreHundredths: 451,
            }),
          })
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
    assert.equal(writeCalls(changedReplay).length, 0);

    const stale = createFixture();
    assert.throws(
      () =>
        stale.service.correct(
          correctionCommand({
            expectedResultVersion: 2,
          })
        ),
      {
        code:
          "MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED",
      }
    );
    assert.equal(writeCalls(stale).length, 0);

    const missing = createFixture({
      context: null,
    });
    assert.throws(
      () =>
        missing.service.correct(
          correctionCommand()
        ),
      {
        code:
          "MATCHUP_RESULT_CORRECTION_NOT_FOUND",
      }
    );
    assert.equal(writeCalls(missing).length, 0);

    const brokenHistoryContext = baseContext();
    brokenHistoryContext.finalizations = [
      canonicalFinalization(),
    ];
    brokenHistoryContext
      .canonicalFinalizationHistoryCount = 1;
    brokenHistoryContext.activeFinalization = null;
    const brokenHistory = createFixture({
      context: brokenHistoryContext,
    });
    assert.throws(
      () =>
        brokenHistory.service.correct(
          correctionCommand()
        ),
      {
        code:
          "MATCHUP_RESULT_CORRECTION_STATE_INVALID",
      }
    );
    assert.equal(writeCalls(brokenHistory).length, 0);

    const backdated = createFixture({
      nowMs: NOW_MS - 3_000,
    });
    assert.throws(
      () =>
        backdated.service.correct(
          correctionCommand()
        ),
      {
        code:
          "MATCHUP_RESULT_CORRECTION_STATE_INVALID",
      }
    );
    assert.equal(writeCalls(backdated).length, 0);
  });

  test("records inherited platform-administrator authority canonically and maps a transactional race safely", () => {
    const repositoryError = new Error(
      "private result race"
    );
    repositoryError.code =
      "REPOSITORY_VERSION_CONFLICT";
    const fixture = createFixture({
      authority: {
        actorUserId: IDS.commissioner,
        membershipId:
          IDS.commissionerMembership,
        authority: "platform_administrator",
      },
      repositoryError,
    });
    assert.throws(
      () =>
        fixture.service.correct(
          correctionCommand()
        ),
      (error) =>
        error?.code ===
          "MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED" &&
        error?.details?.refetch === true &&
        !error.message.includes("private result race")
    );
    const persisted = writeCalls(fixture)[0].input;
    assert.equal(
      persisted.actorAuthority,
      "platform_administrator_as_commissioner"
    );
    assert.deepEqual(
      JSON.parse(
        persisted.audit.client_metadata_json
      ),
      {
        networkSourceCategory: "direct",
        actorAuthority:
          "platform_administrator_as_commissioner",
      }
    );
  });

  test("requires audit context and canonical secure identifiers before entering the repository transaction", () => {
    const missingAudit = createFixture();
    assert.throws(
      () =>
        missingAudit.service.correct(
          correctionCommand({
            auditContext: undefined,
          })
        ),
      TypeError
    );
    assert.equal(writeCalls(missingAudit).length, 0);

    const duplicateId = uuid(700);
    const duplicateIds = createFixture({
      secureIdImplementation() {
        return duplicateId;
      },
    });
    assert.throws(
      () =>
        duplicateIds.service.correct(
          correctionCommand()
        ),
      TypeError
    );
    assert.equal(writeCalls(duplicateIds).length, 0);
  });
});
