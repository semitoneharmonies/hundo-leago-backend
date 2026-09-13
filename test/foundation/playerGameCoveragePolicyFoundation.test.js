const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  PLAYER_GAME_COVERAGE_CODES,
  PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION,
  createPlayerGameCoverageRequirements,
  PLAYER_GAME_COVERAGE_SET_DOMAIN,
  PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION,
  createPlayerGameCoverageSetEvidence,
  normalizePlayerGameCoverageResponse,
  normalizeRequiredPlayerGameSet,
  normalizeRequiredPlayerSet,
} = require(
  "../../src/domain/statistics/playerGameCoveragePolicy"
);

const CAPTURED_AT_MS = Date.parse(
  "2026-10-12T08:00:00.000Z"
);
const GAME_ONE_START_MS = Date.parse(
  "2026-10-12T17:00:00.000Z"
);
const GAME_TWO_START_MS = Date.parse(
  "2026-10-13T01:00:00.000Z"
);
const SOURCE_UPDATED_AT_MS = Date.parse(
  "2026-10-12T07:59:45.000Z"
);

function id(value) {
  return (
    "70000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

const IDS = Object.freeze({
  set: id(1),
  source: id(2),
  refresh: id(3),
  playerA: id(4),
  playerB: id(5),
  playerC: id(6),
  entryAOne: id(7),
  entryATwo: id(8),
  entryB: id(9),
  entryC: id(10),
  extraEntry: id(11),
});

const REQUIRED_A = Object.freeze({
  playerId: IDS.playerA,
  providerPlayerId: "101",
});
const REQUIRED_B = Object.freeze({
  playerId: IDS.playerB,
  providerPlayerId: "102",
});
const REQUIRED_C = Object.freeze({
  playerId: IDS.playerC,
  providerPlayerId: "103",
});
const REQUIRED_GAME_A_ONE = Object.freeze({
  playerId: IDS.playerA,
  providerPlayerId: "101",
  providerTeamId: "10",
  nhlGameId: "9001",
  nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
});
const REQUIRED_GAME_A_TWO = Object.freeze({
  playerId: IDS.playerA,
  providerPlayerId: "101",
  providerTeamId: "20",
  nhlGameId: "9002",
  nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
});

function providerExpectedPlayer(overrides = {}) {
  return {
    playerId: IDS.playerA,
    providerPlayerId: "101",
    providerTeamId: "10",
    disposition: "expected_game",
    games: [
      {
        providerTeamId: "10",
        nhlGameId: "9001",
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
        observedGameState: "in_progress",
      },
    ],
    ...overrides,
  };
}

function providerNoDueGamePlayer(overrides = {}) {
  return {
    playerId: IDS.playerB,
    providerPlayerId: "102",
    providerTeamId: "20",
    disposition: "no_due_game",
    games: [],
    ...overrides,
  };
}

function providerNoTeamPlayer(overrides = {}) {
  return {
    playerId: IDS.playerC,
    providerPlayerId: "103",
    providerTeamId: null,
    disposition: "no_team",
    games: [],
    ...overrides,
  };
}

function providerResponse(players, overrides = {}) {
  return {
    schemaVersion: 1,
    throughAtMs: CAPTURED_AT_MS,
    players,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    externalPlayerId: "101",
    nhlGameId: "9001",
    nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
    observedGameState: "in_progress",
    goals: 0,
    assists: 0,
    nhlPoints: 0,
    fantasyPointsHundredths: 0,
    sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    ...overrides,
  };
}

function responseInput({
  requiredPlayers = [REQUIRED_A, REQUIRED_B, REQUIRED_C],
  requiredPlayerGames = [],
  players = [
    providerExpectedPlayer(),
    providerNoDueGamePlayer(),
    providerNoTeamPlayer(),
  ],
  observationRows = [observation()],
  response = providerResponse(players),
  capturedAtMs = CAPTURED_AT_MS,
} = {}) {
  return {
    requiredPlayers,
    requiredPlayerGames,
    response,
    observationRows,
    capturedAtMs,
  };
}

function expectedEvidenceEntry(overrides = {}) {
  return {
    coverageEntryId: IDS.entryAOne,
    playerId: IDS.playerA,
    providerPlayerId: "101",
    providerTeamId: "10",
    disposition: "expected_game",
    nhlGameId: "9001",
    nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
    ...overrides,
  };
}

function noDueGameEvidenceEntry(overrides = {}) {
  return {
    coverageEntryId: IDS.entryB,
    playerId: IDS.playerB,
    providerPlayerId: "102",
    providerTeamId: "20",
    disposition: "no_due_game",
    nhlGameId: null,
    nhlGameScheduledStartsAtMs: null,
    ...overrides,
  };
}

function noTeamEvidenceEntry(overrides = {}) {
  return {
    coverageEntryId: IDS.entryC,
    playerId: IDS.playerC,
    providerPlayerId: "103",
    providerTeamId: null,
    disposition: "no_team",
    nhlGameId: null,
    nhlGameScheduledStartsAtMs: null,
    ...overrides,
  };
}

function evidenceInput(overrides = {}) {
  return {
    setId: IDS.set,
    statSourceId: IDS.source,
    refreshId: IDS.refresh,
    nhlSeasonKey: "20262027",
    provider: "sportsdataio-live",
    sourceVersion: "capture-2026-10-12T08:00:00.000Z",
    capturedAtMs: CAPTURED_AT_MS,
    requiredPlayers: [REQUIRED_C, REQUIRED_A, REQUIRED_B],
    coverage: [
      noTeamEvidenceEntry(),
      expectedEvidenceEntry({
        coverageEntryId: IDS.entryATwo,
        nhlGameId: "9002",
        nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
      }),
      noDueGameEvidenceEntry(),
      expectedEvidenceEntry(),
    ],
    ...overrides,
  };
}

function assertCoverageError(
  callback,
  code,
  reasonCode = undefined
) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    if (reasonCode !== undefined) {
      assert.equal(error.reasonCode, reasonCode);
    }
    return true;
  });
}

function clone(value) {
  return structuredClone(value);
}

describe("FAD-05 player-game coverage policy", () => {
  test("normalizes the exact server-authored player identity set", () => {
    const input = [
      { ...REQUIRED_B, providerPlayerId: 102 },
      REQUIRED_A,
    ];
    const before = clone(input);
    const players = normalizeRequiredPlayerSet(input);

    assert.deepEqual(players, [REQUIRED_A, REQUIRED_B]);
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(players), true);
    assert.equal(Object.isFrozen(players[0]), true);

    for (const duplicate of [
      [REQUIRED_A, { ...REQUIRED_B, playerId: IDS.playerA }],
      [REQUIRED_A, {
        ...REQUIRED_B,
        providerPlayerId: REQUIRED_A.providerPlayerId,
      }],
    ]) {
      assertCoverageError(
        () => normalizeRequiredPlayerSet(duplicate),
        PLAYER_GAME_COVERAGE_CODES.inputInvalid,
        "required_player_identity_duplicate"
      );
    }
  });

  test("normalizes exact historical player-game requirements", () => {
    const input = [REQUIRED_GAME_A_TWO, REQUIRED_GAME_A_ONE];
    const before = clone(input);
    const games = normalizeRequiredPlayerGameSet(input, [
      REQUIRED_B,
      REQUIRED_A,
    ]);

    assert.deepEqual(games, [
      REQUIRED_GAME_A_ONE,
      REQUIRED_GAME_A_TWO,
    ]);
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(games), true);
    assert.equal(Object.isFrozen(games[0]), true);

    for (const [candidate, reasonCode] of [
      [
        [
          REQUIRED_GAME_A_ONE,
          { ...REQUIRED_GAME_A_ONE, providerTeamId: "11" },
        ],
        "required_player_game_identity_duplicate",
      ],
      [
        [{ ...REQUIRED_GAME_A_ONE, providerPlayerId: "999" }],
        "required_player_game_player_mismatch",
      ],
      [
        [{ ...REQUIRED_GAME_A_ONE, playerId: IDS.playerC }],
        "required_player_game_player_mismatch",
      ],
    ]) {
      assertCoverageError(
        () => normalizeRequiredPlayerGameSet(candidate, [
          REQUIRED_A,
          REQUIRED_B,
        ]),
        PLAYER_GAME_COVERAGE_CODES.inputInvalid,
        reasonCode
      );
    }
  });

  test("builds one canonical pre-fetch requirement snapshot", () => {
    const input = {
      nhlSeasonKey: "20262027",
      playerIdentityProvider: "sportsdataio-discovery-lab",
      requiredPlayers: [REQUIRED_C, REQUIRED_A, REQUIRED_B],
      requiredPlayerGames: [
        REQUIRED_GAME_A_TWO,
        REQUIRED_GAME_A_ONE,
      ],
    };
    const before = clone(input);
    const snapshot = createPlayerGameCoverageRequirements(input);

    assert.deepEqual(Object.keys(snapshot), [
      "schemaVersion",
      "nhlSeasonKey",
      "playerIdentityProvider",
      "requiredPlayers",
      "requiredPlayerGames",
      "requirementsSha256",
    ]);
    assert.equal(
      snapshot.schemaVersion,
      PLAYER_GAME_COVERAGE_REQUIREMENTS_SCHEMA_VERSION
    );
    assert.deepEqual(snapshot.requiredPlayers, [
      REQUIRED_A,
      REQUIRED_B,
      REQUIRED_C,
    ]);
    assert.deepEqual(snapshot.requiredPlayerGames, [
      REQUIRED_GAME_A_ONE,
      REQUIRED_GAME_A_TWO,
    ]);
    assert.equal(
      snapshot.requirementsSha256,
      "ffb7af0721a2eadb8b9c778f7d60c75f197107e883dba50c4b466302cc67027b"
    );
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.requiredPlayers), true);
    assert.equal(Object.isFrozen(snapshot.requiredPlayers[0]), true);
    assert.equal(Object.isFrozen(snapshot.requiredPlayerGames), true);
    assert.equal(Object.isFrozen(snapshot.requiredPlayerGames[0]), true);
    assert.deepEqual(input, before);
  });

  test("requirement snapshots are order-independent and support an empty set", () => {
    const forward = createPlayerGameCoverageRequirements({
      nhlSeasonKey: "20262027",
      playerIdentityProvider: "sportsdataio-discovery-lab",
      requiredPlayers: [REQUIRED_A, REQUIRED_B, REQUIRED_C],
      requiredPlayerGames: [
        REQUIRED_GAME_A_ONE,
        REQUIRED_GAME_A_TWO,
      ],
    });
    const reverse = createPlayerGameCoverageRequirements({
      nhlSeasonKey: "20262027",
      playerIdentityProvider: "sportsdataio-discovery-lab",
      requiredPlayers: [REQUIRED_C, REQUIRED_B, REQUIRED_A],
      requiredPlayerGames: [
        REQUIRED_GAME_A_TWO,
        REQUIRED_GAME_A_ONE,
      ],
    });
    const empty = createPlayerGameCoverageRequirements({
      nhlSeasonKey: "20262027",
      playerIdentityProvider: "sportsdataio-discovery-lab",
      requiredPlayers: [],
      requiredPlayerGames: [],
    });

    assert.deepEqual(forward, reverse);
    assert.deepEqual(empty.requiredPlayers, []);
    assert.deepEqual(empty.requiredPlayerGames, []);
    assert.match(empty.requirementsSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(
      empty.requirementsSha256,
      forward.requirementsSha256
    );
  });

  test("rejects malformed or open requirement snapshot inputs", () => {
    for (const malformed of [
      {
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "sportsdataio-discovery-lab",
        requiredPlayers: [],
      },
      {
        nhlSeasonKey: "20262027",
        playerIdentityProvider: "sportsdataio-discovery-lab",
        requiredPlayers: [],
        requiredPlayerGames: [],
        unexpected: true,
      },
      {
        nhlSeasonKey: "20262028",
        playerIdentityProvider: "sportsdataio-discovery-lab",
        requiredPlayers: [],
        requiredPlayerGames: [],
      },
      {
        nhlSeasonKey: "20262027",
        playerIdentityProvider: " sportsdataio-discovery-lab",
        requiredPlayers: [],
        requiredPlayerGames: [],
      },
    ]) {
      assertCoverageError(
        () => createPlayerGameCoverageRequirements(malformed),
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      );
    }
  });

  test("accepts multiple expected games and both terminal dispositions", () => {
    const secondGame = {
      providerTeamId: "10",
      nhlGameId: "9002",
      nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
      observedGameState: "scheduled",
    };
    const result = normalizePlayerGameCoverageResponse(
      responseInput({
        players: [
          providerNoTeamPlayer(),
          providerExpectedPlayer({
            games: [secondGame, providerExpectedPlayer().games[0]],
          }),
          providerNoDueGamePlayer(),
        ],
        observationRows: [
          observation({
            nhlGameId: "9002",
            nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
            observedGameState: "scheduled",
            goals: 1,
            nhlPoints: 1,
            fantasyPointsHundredths: 125,
          }),
          observation(),
        ],
      })
    );

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.throughAtMs, CAPTURED_AT_MS);
    assert.equal(result.requiredPlayerCount, 3);
    assert.equal(result.coverageEntryCount, 4);
    assert.equal(result.expectedPlayerGameCount, 2);
    assert.equal(result.observationCount, 2);
    assert.deepEqual(
      result.coverage.map((entry) => [
        entry.playerId,
        entry.disposition,
        entry.nhlGameId,
        entry.providerTeamId,
        entry.nhlGameScheduledStartsAtMs,
        entry.observedGameState,
      ]),
      [
        [
          IDS.playerA,
          "expected_game",
          "9001",
          "10",
          GAME_ONE_START_MS,
          "in_progress",
        ],
        [
          IDS.playerA,
          "expected_game",
          "9002",
          "10",
          GAME_TWO_START_MS,
          "scheduled",
        ],
        [IDS.playerB, "no_due_game", null, "20", null, null],
        [IDS.playerC, "no_team", null, null, null, null],
      ]
    );
    assert.equal(result.observationRows[0].goals, 0);
    assert.equal(result.observationRows[0].nhlPoints, 0);
  });

  test("normalization is independent of required, player, game, and observation order", () => {
    const secondGame = {
      providerTeamId: "10",
      nhlGameId: "9002",
      nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
      observedGameState: "final",
    };
    const expected = providerExpectedPlayer({
      games: [
        providerExpectedPlayer().games[0],
        secondGame,
      ],
    });
    const observations = [
      observation(),
      observation({
        nhlGameId: "9002",
        nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
        observedGameState: "final",
        goals: 2,
        assists: 1,
        nhlPoints: 3,
        fantasyPointsHundredths: 350,
      }),
    ];
    const forward = normalizePlayerGameCoverageResponse(
      responseInput({
        requiredPlayers: [REQUIRED_A, REQUIRED_B, REQUIRED_C],
        players: [
          expected,
          providerNoDueGamePlayer(),
          providerNoTeamPlayer(),
        ],
        observationRows: observations,
      })
    );
    const reversedExpected = providerExpectedPlayer({
      games: [...expected.games].reverse(),
    });
    const reverse = normalizePlayerGameCoverageResponse(
      responseInput({
        requiredPlayers: [REQUIRED_C, REQUIRED_B, REQUIRED_A],
        players: [
          providerNoTeamPlayer(),
          providerNoDueGamePlayer(),
          reversedExpected,
        ],
        observationRows: [...observations].reverse(),
      })
    );

    assert.deepEqual(forward, reverse);
  });

  test("keeps an exact historical game for a player who is now a free agent", () => {
    const result = normalizePlayerGameCoverageResponse(
      responseInput({
        requiredPlayers: [REQUIRED_A],
        requiredPlayerGames: [REQUIRED_GAME_A_ONE],
        players: [providerExpectedPlayer({ providerTeamId: null })],
        observationRows: [observation()],
      })
    );

    assert.deepEqual(result.requiredPlayerGames, [
      REQUIRED_GAME_A_ONE,
    ]);
    assert.deepEqual(result.coverage, [{
      playerId: IDS.playerA,
      providerPlayerId: "101",
      providerTeamId: "10",
      disposition: "expected_game",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      observedGameState: "in_progress",
    }]);
  });

  test("supports old-team history plus a new-team current game", () => {
    const currentGame = {
      providerTeamId: "20",
      nhlGameId: "9002",
      nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
      observedGameState: "scheduled",
    };
    const result = normalizePlayerGameCoverageResponse(
      responseInput({
        requiredPlayers: [REQUIRED_A],
        requiredPlayerGames: [REQUIRED_GAME_A_ONE],
        players: [providerExpectedPlayer({
          providerTeamId: "20",
          games: [currentGame, providerExpectedPlayer().games[0]],
        })],
        observationRows: [
          observation({
            nhlGameId: "9002",
            nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
            observedGameState: "scheduled",
          }),
          observation(),
        ],
      })
    );

    assert.deepEqual(
      result.coverage.map((entry) => [
        entry.nhlGameId,
        entry.providerTeamId,
      ]),
      [["9001", "10"], ["9002", "20"]]
    );
    assert.deepEqual(result.requiredPlayerGames, [
      REQUIRED_GAME_A_ONE,
    ]);
  });

  test("requires every non-historical game to use a non-null current team", () => {
    const extraGame = {
      providerTeamId: "20",
      nhlGameId: "9002",
      nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
      observedGameState: "scheduled",
    };
    const observationRows = [
      observation(),
      observation({
        nhlGameId: "9002",
        nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
        observedGameState: "scheduled",
      }),
    ];
    for (const player of [
      providerExpectedPlayer({
        providerTeamId: null,
        games: [providerExpectedPlayer().games[0], extraGame],
      }),
      providerExpectedPlayer({
        providerTeamId: "20",
        games: [
          providerExpectedPlayer().games[0],
          { ...extraGame, providerTeamId: "30" },
        ],
      }),
    ]) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(
          responseInput({
            requiredPlayers: [REQUIRED_A],
            requiredPlayerGames: [REQUIRED_GAME_A_ONE],
            players: [player],
            observationRows,
          })
        ),
        PLAYER_GAME_COVERAGE_CODES.responseInvalid,
        "expected_game_current_team_binding_mismatch"
      );
    }
  });

  test("rejects an omitted or rebound historical player game", () => {
    assertCoverageError(
      () => normalizePlayerGameCoverageResponse(
        responseInput({
          requiredPlayers: [REQUIRED_A],
          requiredPlayerGames: [REQUIRED_GAME_A_ONE],
          players: [providerExpectedPlayer({
            games: [{
              providerTeamId: "20",
              nhlGameId: "9002",
              nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
              observedGameState: "scheduled",
            }],
          })],
          observationRows: [observation({
            nhlGameId: "9002",
            nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
            observedGameState: "scheduled",
          })],
        })
      ),
      PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
      "required_player_game_set_mismatch"
    );

    assertCoverageError(
      () => normalizePlayerGameCoverageResponse(
        responseInput({
          requiredPlayers: [REQUIRED_A],
          requiredPlayerGames: [REQUIRED_GAME_A_ONE],
          players: [providerExpectedPlayer({
            games: [
              {
                ...providerExpectedPlayer().games[0],
                providerTeamId: "11",
              },
            ],
          })],
          observationRows: [observation()],
        })
      ),
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "required_player_game_binding_mismatch"
    );
  });

  test("rejects invalid provider schema, capture, and closed shapes", () => {
    const cases = [
      responseInput({
        response: providerResponse([], { schemaVersion: 2 }),
      }),
      responseInput({
        response: providerResponse([], {
          throughAtMs: CAPTURED_AT_MS + 1,
        }),
      }),
      responseInput({
        response: {
          ...providerResponse([]),
          unexpected: true,
        },
      }),
      responseInput({
        response: providerResponse(null),
      }),
      responseInput({
        players: [{
          ...providerExpectedPlayer(),
          unexpected: true,
        }],
      }),
      responseInput({
        players: [providerExpectedPlayer({
          games: [{
            ...providerExpectedPlayer().games[0],
            unexpected: true,
          }],
        })],
      }),
      responseInput({
        players: [providerExpectedPlayer({
          games: [{
            ...providerExpectedPlayer().games[0],
            providerTeamId: null,
          }],
        })],
      }),
    ];
    for (const malformed of cases) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(malformed),
        PLAYER_GAME_COVERAGE_CODES.responseInvalid
      );
    }
  });

  test("enforces provider team and game shapes for every disposition", () => {
    const cases = [
      providerExpectedPlayer({ providerTeamId: null }),
      providerExpectedPlayer({ games: [] }),
      providerNoDueGamePlayer({ providerTeamId: null }),
      providerNoDueGamePlayer({
        games: providerExpectedPlayer().games,
      }),
      providerNoTeamPlayer({ providerTeamId: "30" }),
      providerNoTeamPlayer({
        games: providerExpectedPlayer().games,
      }),
    ];
    for (const malformedPlayer of cases) {
      const required = [{
        playerId: malformedPlayer.playerId,
        providerPlayerId: malformedPlayer.providerPlayerId,
      }];
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(
          responseInput({
            requiredPlayers: required,
            players: [malformedPlayer],
            observationRows: [],
          })
        ),
        PLAYER_GAME_COVERAGE_CODES.responseInvalid
      );
    }
  });

  test("rejects missing, extra, equal-count wrong, duplicate, and mixed players", () => {
    const terminalA = providerNoTeamPlayer({
      playerId: IDS.playerA,
      providerPlayerId: "101",
    });
    const terminalB = providerNoTeamPlayer({
      playerId: IDS.playerB,
      providerPlayerId: "102",
    });
    const terminalC = providerNoTeamPlayer();

    for (const players of [
      [terminalA],
      [terminalA, terminalB, terminalC],
      [terminalA, terminalC],
    ]) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(
          responseInput({
            requiredPlayers: [REQUIRED_A, REQUIRED_B],
            players,
            observationRows: [],
          })
        ),
        PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
        "required_player_set_mismatch"
      );
    }

    assertCoverageError(
      () => normalizePlayerGameCoverageResponse(
        responseInput({
          requiredPlayers: [REQUIRED_A],
          players: [terminalA, { ...terminalA }],
          observationRows: [],
        })
      ),
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "provider_player_identity_duplicate"
    );
    assertCoverageError(
      () => normalizePlayerGameCoverageResponse(
        responseInput({
          requiredPlayers: [REQUIRED_A],
          players: [
            providerExpectedPlayer(),
            {
              ...terminalA,
              providerTeamId: "10",
              disposition: "no_due_game",
            },
          ],
          observationRows: [observation()],
        })
      ),
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "player_disposition_mixed"
    );
  });

  test("requires an explicit observation and never synthesizes an earned zero", () => {
    const input = responseInput({
      requiredPlayers: [REQUIRED_A],
      players: [providerExpectedPlayer()],
      observationRows: [observation()],
    });
    const result = normalizePlayerGameCoverageResponse(input);

    assert.deepEqual(result.observationRows, [observation()]);
    assert.equal(result.observationRows[0].goals, 0);
    assert.equal(result.observationRows[0].assists, 0);
    assert.equal(result.observationCount, 1);

    assertCoverageError(
      () => normalizePlayerGameCoverageResponse({
        ...input,
        observationRows: [],
      }),
      PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
      "expected_observation_set_mismatch"
    );
  });

  test("rejects missing, extra, duplicate, and wrong-identity observations", () => {
    const base = responseInput({
      requiredPlayers: [REQUIRED_A],
      players: [providerExpectedPlayer()],
      observationRows: [observation()],
    });
    for (const observationRows of [
      [],
      [observation(), observation({
        externalPlayerId: "102",
        nhlGameId: "9002",
      })],
      [observation({ externalPlayerId: "999" })],
    ]) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse({
          ...base,
          observationRows,
        }),
        PLAYER_GAME_COVERAGE_CODES.responseIncomplete,
        "expected_observation_set_mismatch"
      );
    }
    assertCoverageError(
      () => normalizePlayerGameCoverageResponse({
        ...base,
        observationRows: [observation(), observation()],
      }),
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "observation_identity_duplicate"
    );
  });

  test("rejects scheduled-start and observed-state binding mismatches", () => {
    for (const changed of [
      observation({
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS + 1,
      }),
      observation({ observedGameState: "final" }),
    ]) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(
          responseInput({
            requiredPlayers: [REQUIRED_A],
            players: [providerExpectedPlayer()],
            observationRows: [changed],
          })
        ),
        PLAYER_GAME_COVERAGE_CODES.responseInvalid,
        "expected_observation_binding_mismatch"
      );
    }
  });

  test("rejects duplicate expected games and malformed observations", () => {
    assertCoverageError(
      () => normalizePlayerGameCoverageResponse(
        responseInput({
          requiredPlayers: [REQUIRED_A],
          players: [providerExpectedPlayer({
            games: [
              providerExpectedPlayer().games[0],
              providerExpectedPlayer().games[0],
            ],
          })],
          observationRows: [observation()],
        })
      ),
      PLAYER_GAME_COVERAGE_CODES.responseInvalid,
      "expected_game_identity_duplicate"
    );

    for (const malformed of [
      { ...observation(), unexpected: true },
      observation({ nhlPoints: 1 }),
      observation({ sourceUpdatedAtMs: CAPTURED_AT_MS + 1 }),
    ]) {
      assertCoverageError(
        () => normalizePlayerGameCoverageResponse(
          responseInput({
            requiredPlayers: [REQUIRED_A],
            players: [providerExpectedPlayer()],
            observationRows: [malformed],
          })
        ),
        PLAYER_GAME_COVERAGE_CODES.responseInvalid
      );
    }
  });

  test("builds the exact documented coverage preimage and fixed digest", () => {
    const input = evidenceInput();
    const before = clone(input);
    const result = createPlayerGameCoverageSetEvidence(input);

    assert.deepEqual(Object.keys(result.preimage), [
      "domain",
      "schemaVersion",
      "setId",
      "statSourceId",
      "refreshId",
      "nhlSeasonKey",
      "provider",
      "sourceVersion",
      "capturedAtMs",
      "requiredPlayerCount",
      "coverageEntryCount",
      "expectedPlayerGameCount",
      "coverage",
    ]);
    assert.equal(
      result.preimage.domain,
      PLAYER_GAME_COVERAGE_SET_DOMAIN
    );
    assert.equal(
      result.preimage.schemaVersion,
      PLAYER_GAME_COVERAGE_SET_SCHEMA_VERSION
    );
    assert.equal(result.requiredPlayerCount, 3);
    assert.equal(result.coverageEntryCount, 4);
    assert.equal(result.expectedPlayerGameCount, 2);
    assert.deepEqual(
      result.preimage.coverage.map((entry) => [
        entry.playerId,
        entry.disposition,
        entry.nhlGameId,
        entry.coverageEntryId,
      ]),
      [
        [IDS.playerA, "expected_game", "9001", IDS.entryAOne],
        [IDS.playerA, "expected_game", "9002", IDS.entryATwo],
        [IDS.playerB, "no_due_game", null, IDS.entryB],
        [IDS.playerC, "no_team", null, IDS.entryC],
      ]
    );
    assert.equal(
      result.coverageSha256,
      "b9c04084d96e1e54d345c119490627ba24c6c50dd1d5961e6c587e5240bbcb14"
    );
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.preimage), true);
    assert.equal(Object.isFrozen(result.preimage.coverage), true);
    assert.equal(
      Object.isFrozen(result.preimage.coverage[0]),
      true
    );
    assert.deepEqual(input, before);
  });

  test("coverage evidence is independent of required-player and entry order", () => {
    const forwardInput = evidenceInput();
    const reverseInput = evidenceInput({
      requiredPlayers: [...forwardInput.requiredPlayers].reverse(),
      coverage: [...forwardInput.coverage].reverse(),
    });
    const forward = createPlayerGameCoverageSetEvidence(
      forwardInput
    );
    const reverse = createPlayerGameCoverageSetEvidence(
      reverseInput
    );

    assert.deepEqual(forward.preimage, reverse.preimage);
    assert.equal(forward.coverageSha256, reverse.coverageSha256);
  });

  test("enforces exact nullable evidence shapes", () => {
    const cases = [
      [expectedEvidenceEntry({ providerTeamId: null })],
      [expectedEvidenceEntry({ nhlGameId: null })],
      [expectedEvidenceEntry({
        nhlGameScheduledStartsAtMs: null,
      })],
      [noDueGameEvidenceEntry({ providerTeamId: null })],
      [noDueGameEvidenceEntry({ nhlGameId: "9001" })],
      [noDueGameEvidenceEntry({
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      })],
      [noTeamEvidenceEntry({ providerTeamId: "30" })],
      [noTeamEvidenceEntry({ nhlGameId: "9001" })],
      [noTeamEvidenceEntry({
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      })],
    ];
    for (const coverage of cases) {
      const entry = coverage[0];
      const requiredPlayers = [{
        playerId: entry.playerId,
        providerPlayerId: entry.providerPlayerId,
      }];
      assertCoverageError(
        () => createPlayerGameCoverageSetEvidence(
          evidenceInput({ requiredPlayers, coverage })
        ),
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      );
    }
  });

  test("rejects missing, extra, duplicate, mixed, and mismapped evidence", () => {
    const cases = [
      evidenceInput({
        coverage: [
          expectedEvidenceEntry(),
          noDueGameEvidenceEntry(),
        ],
      }),
      evidenceInput({
        coverage: [
          ...evidenceInput().coverage,
          expectedEvidenceEntry({
            coverageEntryId: IDS.extraEntry,
            playerId: id(99),
            providerPlayerId: "999",
          }),
        ],
      }),
      evidenceInput({
        coverage: [
          expectedEvidenceEntry(),
          expectedEvidenceEntry({
            coverageEntryId: IDS.entryATwo,
          }),
          noDueGameEvidenceEntry(),
          noTeamEvidenceEntry(),
        ],
      }),
      evidenceInput({
        coverage: [
          expectedEvidenceEntry(),
          noDueGameEvidenceEntry({
            coverageEntryId: IDS.entryATwo,
            playerId: IDS.playerA,
            providerPlayerId: "101",
            providerTeamId: "10",
          }),
          noDueGameEvidenceEntry(),
          noTeamEvidenceEntry(),
        ],
      }),
      evidenceInput({
        coverage: [
          expectedEvidenceEntry({ providerPlayerId: "999" }),
          noDueGameEvidenceEntry(),
          noTeamEvidenceEntry(),
        ],
      }),
      evidenceInput({
        coverage: [
          expectedEvidenceEntry(),
          noDueGameEvidenceEntry({
            coverageEntryId: IDS.entryAOne,
          }),
          noTeamEvidenceEntry(),
        ],
      }),
    ];
    for (const malformed of cases) {
      assertCoverageError(
        () => createPlayerGameCoverageSetEvidence(malformed),
        PLAYER_GAME_COVERAGE_CODES.inputInvalid
      );
    }
  });

  test("does not mutate response inputs and deeply freezes normalized output", () => {
    const input = responseInput({
      requiredPlayerGames: [REQUIRED_GAME_A_ONE],
    });
    const before = clone(input);
    const result = normalizePlayerGameCoverageResponse(input);

    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.requiredPlayers), true);
    assert.equal(Object.isFrozen(result.requiredPlayers[0]), true);
    assert.equal(Object.isFrozen(result.requiredPlayerGames), true);
    assert.equal(Object.isFrozen(result.requiredPlayerGames[0]), true);
    assert.equal(Object.isFrozen(result.coverage), true);
    assert.equal(Object.isFrozen(result.coverage[0]), true);
    assert.equal(Object.isFrozen(result.observationRows), true);
    assert.equal(Object.isFrozen(result.observationRows[0]), true);
  });
});
