const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  STANDINGS_FINALIZATION_CODES,
  STANDINGS_FINALIZATION_CONFIRMATION,
  STANDINGS_RESULT_SET_SCHEMA_VERSION,
  StandingsFinalizationPolicyError,
  calculateStandingsResultSetHash,
  normalizeStandingsResultSetDescriptor,
  officialStandingsRowsChanged,
  serializeStandingsResultSetDescriptor,
  validateStandingsFinalizationExpectedVersion,
  validateStandingsFinalizationIdempotencyKey,
  validateStandingsFinalizationInput,
  validateStandingsFinalizationLeagueId,
  validateStandingsFinalizationSeasonId,
} = require(
  "../../src/domain/matchups/matchupStandingsFinalizationPolicy"
);

function uuid(value) {
  return (
    "00000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  league: uuid(1),
  season: uuid(2),
  matchupOne: uuid(10),
  matchupTwo: uuid(20),
  resultOne: uuid(110),
  resultTwo: uuid(120),
  versionOne: uuid(210),
  versionTwo: uuid(220),
  teamOne: uuid(310),
  teamTwo: uuid(320),
  teamThree: uuid(330),
});

const RESULT_ONE = Object.freeze({
  matchupId: IDS.matchupOne,
  matchupResultId: IDS.resultOne,
  resultVersionId: IDS.versionOne,
  resultVersion: 2,
});
const RESULT_TWO = Object.freeze({
  matchupId: IDS.matchupTwo,
  matchupResultId: IDS.resultTwo,
  resultVersionId: IDS.versionTwo,
  resultVersion: 7,
});
const CANONICAL_PAYLOAD =
  `{"leagueId":"${IDS.league}",` +
  `"seasonId":"${IDS.season}",` +
  '"standingsRuleVersion":"1",' +
  `"results":[{"matchupId":"${IDS.matchupOne}",` +
  `"matchupResultId":"${IDS.resultOne}",` +
  `"resultVersionId":"${IDS.versionOne}",` +
  '"resultVersion":2},' +
  `{"matchupId":"${IDS.matchupTwo}",` +
  `"matchupResultId":"${IDS.resultTwo}",` +
  `"resultVersionId":"${IDS.versionTwo}",` +
  '"resultVersion":7}]}';
const FIXED_VECTOR_HASH =
  "f51f84c3eccf946565f540d8c98d3d664a151b9080292fc9e6eabbcb988ed8ed";

function descriptor(results = [RESULT_TWO, RESULT_ONE]) {
  return {
    leagueId: IDS.league,
    seasonId: IDS.season,
    standingsRuleVersion: "1",
    results,
  };
}

function assertPolicyError(
  action,
  code,
  reasonCode
) {
  assert.throws(action, (error) => {
    assert.ok(
      error instanceof StandingsFinalizationPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

function standingsRow({
  teamId,
  teamDisplayName,
  rank,
  wins = 0,
  losses = 0,
  ties = 0,
  fantasyPointsForHundredths = 0,
  fantasyPointsAgainstHundredths = 0,
} = {}) {
  const gamesPlayed = wins + losses + ties;
  const standingsPoints = wins * 2 + ties;
  return {
    teamId,
    teamDisplayName,
    gamesPlayed,
    wins,
    losses,
    ties,
    standingsPoints,
    pointsPercentageHundredths:
      gamesPlayed === 0
        ? 0
        : Math.round(
            (standingsPoints * 10_000) /
              (gamesPlayed * 2)
          ),
    fantasyPointsForHundredths,
    fantasyPointsAgainstHundredths,
    fantasyPointsDifferentialHundredths:
      fantasyPointsForHundredths -
      fantasyPointsAgainstHundredths,
    rank,
  };
}

describe("T-145 standings-finalization request policy", () => {
  test("accepts only the exact body and preserves the canonical confirmation", () => {
    const input = {
      resultSetHash: "a".repeat(64),
      confirmation:
        STANDINGS_FINALIZATION_CONFIRMATION,
    };
    const validated =
      validateStandingsFinalizationInput(input);

    assert.deepEqual(validated, input);
    assert.notEqual(validated, input);
    assert.ok(Object.isFrozen(validated));
    assert.equal(
      STANDINGS_RESULT_SET_SCHEMA_VERSION,
      1
    );
  });

  test("rejects malformed bodies, unknown fields, hash spellings, and alternate confirmations", () => {
    for (const input of [
      undefined,
      null,
      [],
      "",
      {},
      {
        confirmation:
          STANDINGS_FINALIZATION_CONFIRMATION,
      },
      {
        expectedResultSetHash: "a".repeat(64),
        confirmation:
          STANDINGS_FINALIZATION_CONFIRMATION,
      },
      {
        resultSetHash: "a".repeat(64),
        confirmation:
          STANDINGS_FINALIZATION_CONFIRMATION,
        unknown: true,
      },
    ]) {
      assertPolicyError(
        () => validateStandingsFinalizationInput(input),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "body_invalid"
      );
    }

    for (const resultSetHash of [
      undefined,
      null,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationInput({
            resultSetHash,
            confirmation:
              STANDINGS_FINALIZATION_CONFIRMATION,
          }),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "result_set_hash_invalid"
      );
    }

    for (const confirmation of [
      undefined,
      null,
      "",
      "finalize regular season standings",
      `${STANDINGS_FINALIZATION_CONFIRMATION} `,
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationInput({
            resultSetHash: "a".repeat(64),
            confirmation,
          }),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "confirmation_invalid"
      );
    }
  });

  test("strictly validates league, season, and optimistic versions", () => {
    assert.equal(
      validateStandingsFinalizationLeagueId(
        IDS.league
      ),
      IDS.league
    );
    assert.equal(
      validateStandingsFinalizationSeasonId(
        IDS.season
      ),
      IDS.season
    );
    assert.equal(
      validateStandingsFinalizationExpectedVersion(
        1
      ),
      1
    );
    assert.equal(
      validateStandingsFinalizationExpectedVersion(
        Number.MAX_SAFE_INTEGER
      ),
      Number.MAX_SAFE_INTEGER
    );

    for (const leagueId of [
      undefined,
      null,
      "",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "00000000-0000-3000-8000-000000000001",
      "00000000-0000-4000-7000-000000000001",
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationLeagueId(
            leagueId
          ),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "league_id_invalid"
      );
    }
    for (const seasonId of [
      undefined,
      null,
      "",
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
      "00000000-0000-5000-8000-000000000002",
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationSeasonId(
            seasonId
          ),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "season_id_invalid"
      );
    }
    for (const expectedVersion of [
      undefined,
      null,
      "1",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationExpectedVersion(
            expectedVersion
          ),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "expected_version_invalid"
      );
    }
  });

  test("accepts bounded opaque idempotency keys and rejects unsafe spellings", () => {
    for (const idempotencyKey of [
      "a",
      "opaque intent / 2026",
      "x".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH),
    ]) {
      assert.equal(
        validateStandingsFinalizationIdempotencyKey(
          idempotencyKey
        ),
        idempotencyKey
      );
    }
    for (const idempotencyKey of [
      undefined,
      null,
      "",
      " leading",
      "trailing ",
      "line\nbreak",
      "c1\u0085control",
      "separator\u2028value",
      "x".repeat(
        MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1
      ),
    ]) {
      assertPolicyError(
        () =>
          validateStandingsFinalizationIdempotencyKey(
            idempotencyKey
          ),
        STANDINGS_FINALIZATION_CODES.inputInvalid,
        "idempotency_key_invalid"
      );
    }
  });
});

describe("T-145 canonical result-set hash v1", () => {
  test("matches the fixed UTF-8 SHA-256 vector and exact documented serialization", () => {
    assert.equal(
      serializeStandingsResultSetDescriptor(
        descriptor()
      ),
      CANONICAL_PAYLOAD
    );
    assert.equal(
      calculateStandingsResultSetHash(descriptor()),
      FIXED_VECTOR_HASH
    );
  });

  test("sorts without mutating input and produces the same digest for every input order", () => {
    const input = descriptor([
      { ...RESULT_TWO },
      { ...RESULT_ONE },
    ]);
    const originalOrder = input.results.map(
      ({ matchupId }) => matchupId
    );
    const normalized =
      normalizeStandingsResultSetDescriptor(input);

    assert.deepEqual(
      input.results.map(({ matchupId }) => matchupId),
      originalOrder
    );
    assert.deepEqual(
      normalized.results.map(
        ({ matchupId }) => matchupId
      ),
      [IDS.matchupOne, IDS.matchupTwo]
    );
    assert.ok(Object.isFrozen(normalized));
    assert.ok(Object.isFrozen(normalized.results));
    assert.ok(
      normalized.results.every(Object.isFrozen)
    );
    assert.equal(
      calculateStandingsResultSetHash(
        descriptor([RESULT_ONE, RESULT_TWO])
      ),
      calculateStandingsResultSetHash(
        descriptor([RESULT_TWO, RESULT_ONE])
      )
    );
  });

  test("binds every documented source-identity field into the digest", () => {
    const original =
      calculateStandingsResultSetHash(descriptor());
    const variants = [
      {
        ...descriptor(),
        leagueId: uuid(3),
      },
      {
        ...descriptor(),
        seasonId: uuid(4),
      },
      {
        ...descriptor(),
        standingsRuleVersion: "2",
      },
      descriptor([
        {
          ...RESULT_ONE,
          matchupId: uuid(11),
        },
        RESULT_TWO,
      ]),
      descriptor([
        {
          ...RESULT_ONE,
          matchupResultId: uuid(111),
        },
        RESULT_TWO,
      ]),
      descriptor([
        {
          ...RESULT_ONE,
          resultVersionId: uuid(211),
        },
        RESULT_TWO,
      ]),
      descriptor([
        {
          ...RESULT_ONE,
          resultVersion: 3,
        },
        RESULT_TWO,
      ]),
    ];

    for (const variant of variants) {
      assert.notEqual(
        calculateStandingsResultSetHash(variant),
        original
      );
    }
  });

  test("rejects duplicate matchup, result, and result-version identities", () => {
    const duplicateCases = [
      {
        reasonCode: "duplicate_matchup_id",
        results: [
          RESULT_ONE,
          {
            ...RESULT_TWO,
            matchupId: RESULT_ONE.matchupId,
          },
        ],
      },
      {
        reasonCode: "duplicate_matchup_result_id",
        results: [
          RESULT_ONE,
          {
            ...RESULT_TWO,
            matchupResultId:
              RESULT_ONE.matchupResultId,
          },
        ],
      },
      {
        reasonCode: "duplicate_result_version_id",
        results: [
          RESULT_ONE,
          {
            ...RESULT_TWO,
            resultVersionId:
              RESULT_ONE.resultVersionId,
          },
        ],
      },
    ];

    for (const { reasonCode, results } of duplicateCases) {
      assertPolicyError(
        () =>
          calculateStandingsResultSetHash(
            descriptor(results)
          ),
        STANDINGS_FINALIZATION_CODES.notReady,
        reasonCode
      );
    }
  });

  test("rejects malformed top-level and per-result descriptors", () => {
    const malformedTopLevel = [
      {
        value: undefined,
        reasonCode: "result_set_descriptor_invalid",
      },
      {
        value: [],
        reasonCode: "result_set_descriptor_invalid",
      },
      {
        value: {
          ...descriptor(),
          unknown: true,
        },
        reasonCode: "result_set_descriptor_invalid",
      },
      {
        value: {
          ...descriptor(),
          results: [],
        },
        reasonCode: "result_set_empty",
      },
      {
        value: {
          ...descriptor(),
          leagueId: "league",
        },
        reasonCode: "league_id_invalid",
      },
      {
        value: {
          ...descriptor(),
          seasonId: "season",
        },
        reasonCode: "season_id_invalid",
      },
      {
        value: {
          ...descriptor(),
          standingsRuleVersion: 1,
        },
        reasonCode:
          "standings_rule_version_invalid",
      },
      {
        value: {
          ...descriptor(),
          standingsRuleVersion: " rule ",
        },
        reasonCode:
          "standings_rule_version_invalid",
      },
    ];
    for (const {
      value,
      reasonCode,
    } of malformedTopLevel) {
      assertPolicyError(
        () =>
          normalizeStandingsResultSetDescriptor(value),
        STANDINGS_FINALIZATION_CODES.notReady,
        reasonCode
      );
    }

    const malformedResults = [
      {
        value: null,
        reasonCode: "result_descriptor_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          unknown: true,
        },
        reasonCode: "result_descriptor_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          matchupId: "matchup",
        },
        reasonCode: "matchup_id_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          matchupResultId: "result",
        },
        reasonCode: "matchup_result_id_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          resultVersionId: "version",
        },
        reasonCode: "result_version_id_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          resultVersion: 0,
        },
        reasonCode: "result_version_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          resultVersion: "2",
        },
        reasonCode: "result_version_invalid",
      },
      {
        value: {
          ...RESULT_ONE,
          resultVersion:
            Number.MAX_SAFE_INTEGER + 1,
        },
        reasonCode: "result_version_invalid",
      },
    ];
    for (const {
      value,
      reasonCode,
    } of malformedResults) {
      assertPolicyError(
        () =>
          normalizeStandingsResultSetDescriptor(
            descriptor([value])
          ),
        STANDINGS_FINALIZATION_CODES.notReady,
        reasonCode
      );
    }
  });
});

describe("T-097 official standings-row change comparison", () => {
  test("ignores array and display-name order while comparing official metrics and ranks", () => {
    const first = standingsRow({
      teamId: IDS.teamOne,
      teamDisplayName: "Alpha",
      rank: 1,
      wins: 1,
      fantasyPointsForHundredths: 500,
      fantasyPointsAgainstHundredths: 300,
    });
    const second = standingsRow({
      teamId: IDS.teamTwo,
      teamDisplayName: "Bravo",
      rank: 2,
      losses: 1,
      fantasyPointsForHundredths: 300,
      fantasyPointsAgainstHundredths: 500,
    });

    assert.equal(
      officialStandingsRowsChanged(
        [first, second],
        [
          {
            ...second,
            teamDisplayName: "Renamed Bravo",
          },
          first,
        ]
      ),
      false
    );
  });

  test("detects a changed official metric, rank, or participant set", () => {
    const first = standingsRow({
      teamId: IDS.teamOne,
      teamDisplayName: "Alpha",
      rank: 1,
      wins: 1,
      fantasyPointsForHundredths: 500,
      fantasyPointsAgainstHundredths: 300,
    });
    const second = standingsRow({
      teamId: IDS.teamTwo,
      teamDisplayName: "Bravo",
      rank: 2,
      losses: 1,
      fantasyPointsForHundredths: 300,
      fantasyPointsAgainstHundredths: 500,
    });

    assert.equal(
      officialStandingsRowsChanged(
        [first, second],
        [{ ...first, rank: 2 }, second]
      ),
      true
    );
    assert.equal(
      officialStandingsRowsChanged(
        [first, second],
        [
          standingsRow({
            teamId: IDS.teamOne,
            teamDisplayName: "Alpha",
            rank: 1,
            ties: 1,
            fantasyPointsForHundredths: 400,
            fantasyPointsAgainstHundredths: 400,
          }),
          second,
        ]
      ),
      true
    );
    assert.equal(
      officialStandingsRowsChanged(
        [first, second],
        [
          first,
          standingsRow({
            ...second,
            teamId: IDS.teamThree,
          }),
        ]
      ),
      true
    );
  });

  test("rejects empty, duplicate-team, and inconsistent row projections", () => {
    const row = standingsRow({
      teamId: IDS.teamOne,
      teamDisplayName: "Alpha",
      rank: 1,
    });
    assertPolicyError(
      () => officialStandingsRowsChanged([], [row]),
      STANDINGS_FINALIZATION_CODES.notReady,
      "standings_rows_invalid"
    );
    assertPolicyError(
      () =>
        officialStandingsRowsChanged(
          [row, { ...row }],
          [row]
        ),
      STANDINGS_FINALIZATION_CODES.notReady,
      "duplicate_standings_team_id"
    );
    assertPolicyError(
      () =>
        officialStandingsRowsChanged(
          [
            {
              ...row,
              standingsPoints: 1,
            },
          ],
          [row]
        ),
      STANDINGS_FINALIZATION_CODES.notReady,
      "standings_row_invalid"
    );
  });
});
