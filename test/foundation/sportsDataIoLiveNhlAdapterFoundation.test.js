const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  PROVIDER_NAME,
  createSportsDataIoLiveNhlAdapter,
} = require(
  "../../src/infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter"
);

const NOW_MS = Date.parse("2026-10-12T18:00:00Z");
const GAME_ONE_START_MS = Date.parse("2026-10-12T17:00:00Z");
const GAME_TWO_START_MS = Date.parse("2026-10-12T16:00:00Z");
const HISTORICAL_GAME_START_MS = Date.parse(
  "2026-09-28T23:30:00Z"
);
const PLAYER_GAME_UPDATE_MS = Date.parse(
  "2026-10-12T17:30:45.123Z"
);
const REQUIREMENTS_SHA256 = "a".repeat(64);

function id(value) {
  return (
    "30000000-0000-4000-8000-" +
    String(value).padStart(12, "0")
  );
}

function requiredPlayers() {
  return [
    { playerId: id(1), providerPlayerId: "101" },
    { playerId: id(2), providerPlayerId: "102" },
    { playerId: id(3), providerPlayerId: "103" },
  ];
}

function requiredPlayerGame(overrides = {}) {
  return {
    playerId: id(1),
    providerPlayerId: "101",
    providerTeamId: "10",
    nhlGameId: "8001",
    nhlGameScheduledStartsAtMs: HISTORICAL_GAME_START_MS,
    ...overrides,
  };
}

function totalsRows() {
  return [
    {
      PlayerID: 103,
      Season: 2027,
      SeasonType: 1,
      Games: null,
      Goals: null,
      Assists: null,
    },
    {
      PlayerID: 102,
      Season: 2027,
      SeasonType: 1,
      Games: 2,
      Goals: 1,
      Assists: 2,
    },
    {
      PlayerID: 101,
      Season: 2027,
      SeasonType: 1,
      Games: 1,
      Goals: 0,
      Assists: 0,
    },
  ];
}

function activePlayerRows() {
  return [
    { PlayerID: 999, TeamID: 10, Status: "Active" },
    { PlayerID: 102, TeamID: 20, Status: "Injured Reserve" },
    { PlayerID: 101, TeamID: 10, Status: "Active" },
  ];
}

function freeAgentRows() {
  return [
    { PlayerID: 998, TeamID: null, Status: "Inactive" },
    { PlayerID: 103, TeamID: null, Status: "Inactive" },
  ];
}

function gameRow(overrides = {}) {
  return {
    GameID: 9001,
    Season: 2027,
    SeasonType: 1,
    Status: "InProgress",
    DateTimeUTC: "2026-10-12T17:00:00",
    HomeTeamID: 10,
    AwayTeamID: 30,
    ...overrides,
  };
}

function playerGameRow(overrides = {}) {
  return {
    PlayerID: 101,
    TeamID: 10,
    GameID: 9001,
    Season: 2027,
    SeasonType: 1,
    Games: 0,
    Goals: 0,
    Assists: 0,
    Updated: "2026-10-12T13:30:45.123",
    ...overrides,
  };
}

function historicalGameRow(overrides = {}) {
  return gameRow({
    GameID: 8001,
    Status: "Final",
    DateTimeUTC: "2026-09-28T23:30:00",
    HomeTeamID: 10,
    AwayTeamID: 30,
    ...overrides,
  });
}

function historicalPlayerGameRow(overrides = {}) {
  return playerGameRow({
    GameID: 8001,
    Games: 1,
    Goals: 1,
    Updated: "2026-09-28T20:00:00",
    ...overrides,
  });
}

function createFixture({
  totals = totalsRows(),
  activePlayers = activePlayerRows(),
  freeAgents = freeAgentRows(),
  games = [gameRow()],
  gamesByDate,
  playerGames = [
    playerGameRow(),
    playerGameRow({
      PlayerID: 999,
      Games: 1,
      Goals: 1,
    }),
  ],
  playerGamesByDate,
  now = NOW_MS,
  dateLookbackDays = 0,
  ok = true,
} = {}) {
  const requests = [];
  const adapter = createSportsDataIoLiveNhlAdapter({
    apiKey: "server-secret",
    dateLookbackDays,
    nowMs: () => now,
    async fetchImpl(url, options) {
      requests.push({ url, options });
      let body;
      if (url.endsWith("/scores/json/Players")) {
        body = activePlayers;
      } else if (url.endsWith("/scores/json/FreeAgents")) {
        body = freeAgents;
      } else if (url.includes("/PlayerSeasonStats/")) {
        body = totals;
      } else if (url.includes("/PlayerGameStatsByDate/")) {
        const date = url.slice(url.lastIndexOf("/") + 1);
        body = playerGamesByDate === undefined
          ? playerGames
          : playerGamesByDate[date] ?? [];
      } else if (url.includes("/GamesByDate/")) {
        const date = url.slice(url.lastIndexOf("/") + 1);
        body = gamesByDate === undefined
          ? games
          : gamesByDate[date] ?? [];
      } else {
        throw new Error(`Unexpected fixture URL: ${url}`);
      }
      return {
        ok,
        async json() {
          return body;
        },
      };
    },
  });
  return { adapter, requests };
}

function fetchSnapshot(
  adapter,
  players = requiredPlayers(),
  games = [],
  requirementsSha256 = REQUIREMENTS_SHA256
) {
  return adapter.fetchLiveSnapshot({
    nhlSeasonKey: "20262027",
    requiredPlayers: players,
    requiredPlayerGames: games,
    requirementsSha256,
  });
}

describe("FAD-05 SportsDataIO current-season live adapter", () => {
  test("returns the exact requested coverage and observation scope in canonical order", async () => {
    const { adapter, requests } = createFixture();
    const result = await fetchSnapshot(adapter);

    assert.equal(result.provider, PROVIDER_NAME);
    assert.equal(result.capturedAtMs, NOW_MS);
    assert.match(
      result.sourceVersion,
      /^sportsdataio-live-sha256-[a-f0-9]{64}$/
    );
    assert.deepEqual(result.playerGameCoverage, {
      schemaVersion: 1,
      throughAtMs: NOW_MS,
      players: [
        {
          playerId: id(1),
          providerPlayerId: "101",
          providerTeamId: "10",
          disposition: "expected_game",
          games: [{
            providerTeamId: "10",
            nhlGameId: "9001",
            nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
            observedGameState: "in_progress",
          }],
        },
        {
          playerId: id(2),
          providerPlayerId: "102",
          providerTeamId: "20",
          disposition: "no_due_game",
          games: [],
        },
        {
          playerId: id(3),
          providerPlayerId: "103",
          providerTeamId: null,
          disposition: "no_team",
          games: [],
        },
      ],
    });
    assert.deepEqual(result.playerGameRows, [{
      playerId: "101",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      observedGameState: "in_progress",
      goals: 0,
      assists: 0,
      sourceUpdatedAtMs: PLAYER_GAME_UPDATE_MS,
    }]);
    assert.deepEqual(result.totalsRows, [
      {
        playerId: "101",
        gamesPlayed: 1,
        goals: 0,
        assists: 0,
      },
      {
        playerId: "102",
        gamesPlayed: 2,
        goals: 1,
        assists: 2,
      },
      {
        playerId: "103",
        gamesPlayed: 0,
        goals: 0,
        assists: 0,
      },
    ]);
    assert.deepEqual(
      requests.map(({ url }) => url).sort(),
      [
        "https://api.sportsdata.io/v3/nhl/scores/json/FreeAgents",
        "https://api.sportsdata.io/v3/nhl/scores/json/GamesByDate/2026-10-12",
        "https://api.sportsdata.io/v3/nhl/scores/json/Players",
        "https://api.sportsdata.io/v3/nhl/stats/json/PlayerGameStatsByDate/2026-10-12",
        "https://api.sportsdata.io/v3/nhl/stats/json/PlayerSeasonStats/2027REG",
      ].sort()
    );
    for (const request of requests) {
      assert.deepEqual(request.options, {
        method: "GET",
        headers: {
          "Ocp-Apim-Subscription-Key": "server-secret",
        },
      });
    }
    assert.equal(Object.isFrozen(result.playerGameCoverage), true);
    assert.equal(
      Object.isFrozen(result.playerGameCoverage.players),
      true
    );
  });

  test("requires an exact lowercase requirements digest before provider access", async () => {
    const cases = [
      undefined,
      null,
      "",
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      ` ${REQUIREMENTS_SHA256}`,
    ];
    for (const digest of cases) {
      const { adapter, requests } = createFixture();
      const input = {
        nhlSeasonKey: "20262027",
        requiredPlayers: requiredPlayers(),
        requiredPlayerGames: [],
      };
      if (digest !== undefined) {
        input.requirementsSha256 = digest;
      }
      await assert.rejects(
        adapter.fetchLiveSnapshot(input),
        {
          code:
            "SPORTSDATAIO_LIVE_REQUIREMENTS_SHA256_INVALID",
        }
      );
      assert.equal(requests.length, 0);
    }
  });

  test("requires one exact sorted and unique internal/provider player scope", async () => {
    const cases = [
      null,
      [...requiredPlayers()].reverse(),
      [requiredPlayers()[0], requiredPlayers()[0]],
      [
        requiredPlayers()[0],
        {
          ...requiredPlayers()[1],
          providerPlayerId: "101",
        },
      ],
      [{
        ...requiredPlayers()[0],
        unexpected: true,
      }],
      [{
        playerId: "not-a-stable-id",
        providerPlayerId: "101",
      }],
      [{
        playerId: id(1),
        providerPlayerId: 101,
      }],
    ];
    for (const required of cases) {
      const { adapter, requests } = createFixture();
      await assert.rejects(
        fetchSnapshot(adapter, required),
        {
          code: "SPORTSDATAIO_LIVE_REQUIRED_PLAYERS_INVALID",
        }
      );
      assert.equal(requests.length, 0);
    }
  });

  test("requires an exact sorted, unique, and parent-bound historical player-game scope", async () => {
    const first = requiredPlayerGame();
    const second = requiredPlayerGame({
      playerId: id(2),
      providerPlayerId: "102",
      providerTeamId: "20",
      nhlGameId: "8002",
      nhlGameScheduledStartsAtMs:
        HISTORICAL_GAME_START_MS + 60_000,
    });
    const cases = [
      null,
      [second, first],
      [first, first],
      [first, {
        ...first,
        providerTeamId: "20",
      }],
      [first, {
        ...first,
        nhlGameScheduledStartsAtMs:
          HISTORICAL_GAME_START_MS + 1,
      }],
      [{
        ...first,
        providerPlayerId: "102",
      }],
      [{
        ...first,
        unexpected: true,
      }],
    ];

    for (const requiredGames of cases) {
      const { adapter, requests } = createFixture();
      await assert.rejects(
        adapter.fetchLiveSnapshot({
          nhlSeasonKey: "20262027",
          requiredPlayers: requiredPlayers(),
          requiredPlayerGames: requiredGames,
          requirementsSha256: REQUIREMENTS_SHA256,
        }),
        {
          code:
            "SPORTSDATAIO_LIVE_REQUIRED_PLAYER_GAMES_INVALID",
        }
      );
      assert.equal(requests.length, 0);
    }

    const { adapter, requests } = createFixture();
    await assert.rejects(
      adapter.fetchLiveSnapshot({
        nhlSeasonKey: "20262027",
        requiredPlayers: requiredPlayers(),
        requirementsSha256: REQUIREMENTS_SHA256,
      }),
      {
        code:
          "SPORTSDATAIO_LIVE_REQUIRED_PLAYER_GAMES_INVALID",
      }
    );
    assert.equal(requests.length, 0);
  });

  test("requires every due game and supports multiple games for one player", async () => {
    const secondGame = gameRow({
      GameID: 9002,
      DateTimeUTC: "2026-10-12T16:00:00",
      Status: "Final",
      HomeTeamID: 30,
      AwayTeamID: 10,
    });
    const { adapter } = createFixture({
      games: [gameRow(), secondGame],
      playerGames: [
        playerGameRow(),
        playerGameRow({
          GameID: 9002,
          Games: 1,
          Goals: 1,
          Updated: "2026-10-12T14:00:00",
        }),
      ],
    });

    const result = await fetchSnapshot(adapter);

    assert.deepEqual(
      result.playerGameCoverage.players[0].games,
      [
        {
          providerTeamId: "10",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
          observedGameState: "in_progress",
        },
        {
          providerTeamId: "10",
          nhlGameId: "9002",
          nhlGameScheduledStartsAtMs: GAME_TWO_START_MS,
          observedGameState: "final",
        },
      ]
    );
    assert.deepEqual(
      result.playerGameRows.map(({ nhlGameId }) => nhlGameId),
      ["9001", "9002"]
    );
  });

  test("fetches a two-week-old required game and keeps historical and current team identity per game", async () => {
    const currentGame = gameRow({
      HomeTeamID: 20,
      AwayTeamID: 30,
    });
    const { adapter, requests } = createFixture({
      activePlayers: activePlayerRows().map((row) =>
        row.PlayerID === 101
          ? { ...row, TeamID: 20 }
          : row.PlayerID === 102
            ? { ...row, TeamID: 40 }
          : row
      ),
      gamesByDate: {
        "2026-09-28": [historicalGameRow()],
        "2026-10-12": [currentGame],
      },
      playerGamesByDate: {
        "2026-09-28": [historicalPlayerGameRow()],
        "2026-10-12": [playerGameRow({ TeamID: 20 })],
      },
    });

    const result = await fetchSnapshot(
      adapter,
      requiredPlayers(),
      [requiredPlayerGame()]
    );

    assert.deepEqual(result.playerGameCoverage.players[0], {
      playerId: id(1),
      providerPlayerId: "101",
      providerTeamId: "20",
      disposition: "expected_game",
      games: [
        {
          providerTeamId: "10",
          nhlGameId: "8001",
          nhlGameScheduledStartsAtMs:
            HISTORICAL_GAME_START_MS,
          observedGameState: "final",
        },
        {
          providerTeamId: "20",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
          observedGameState: "in_progress",
        },
      ],
    });
    assert.deepEqual(
      result.playerGameRows.map(({ nhlGameId }) => nhlGameId),
      ["8001", "9001"]
    );
    assert.deepEqual(
      requests
        .map(({ url }) => url)
        .filter((url) => url.includes("/GamesByDate/"))
        .map((url) => url.slice(url.lastIndexOf("/") + 1)),
      ["2026-09-28", "2026-10-12"]
    );
    assert.deepEqual(
      requests
        .map(({ url }) => url)
        .filter((url) =>
          url.includes("/PlayerGameStatsByDate/")
        )
        .map((url) => url.slice(url.lastIndexOf("/") + 1)),
      ["2026-09-28", "2026-10-12"]
    );
  });

  test("uses the provider-Eastern historical date across the daylight-saving boundary", async () => {
    const dstGameStartMs = Date.parse(
      "2026-11-02T04:30:00Z"
    );
    const requiredGame = requiredPlayerGame({
      nhlGameId: "8002",
      nhlGameScheduledStartsAtMs: dstGameStartMs,
    });
    const { adapter, requests } = createFixture({
      now: Date.parse("2026-11-03T18:00:00Z"),
      gamesByDate: {
        "2026-11-01": [historicalGameRow({
          GameID: 8002,
          DateTimeUTC: "2026-11-02T04:30:00",
        })],
        "2026-11-03": [],
      },
      playerGamesByDate: {
        "2026-11-01": [historicalPlayerGameRow({
          GameID: 8002,
          Updated: "2026-11-02T00:30:00",
        })],
        "2026-11-03": [],
      },
    });

    const result = await fetchSnapshot(
      adapter,
      requiredPlayers(),
      [requiredGame]
    );

    assert.equal(
      result.playerGameCoverage.players[0]
        .games[0].nhlGameScheduledStartsAtMs,
      dstGameStartMs
    );
    assert.deepEqual(
      requests
        .map(({ url }) => url)
        .filter((url) => url.includes("ByDate"))
        .map((url) => url.slice(url.lastIndexOf("/") + 1)),
      ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-03"]
    );
  });

  test("sorts and deduplicates target dates that overlap the rolling window", async () => {
    const { adapter, requests } = createFixture({
      dateLookbackDays: 2,
      gamesByDate: {
        "2026-10-10": [],
        "2026-10-11": [],
        "2026-10-12": [gameRow()],
      },
      playerGamesByDate: {
        "2026-10-10": [],
        "2026-10-11": [],
        "2026-10-12": [playerGameRow()],
      },
    });
    const currentBinding = requiredPlayerGame({
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
    });

    const result = await fetchSnapshot(
      adapter,
      requiredPlayers(),
      [currentBinding]
    );

    const scheduleDates = requests
      .map(({ url }) => url)
      .filter((url) => url.includes("/GamesByDate/"))
      .map((url) => url.slice(url.lastIndexOf("/") + 1));
    const playerGameDates = requests
      .map(({ url }) => url)
      .filter((url) =>
        url.includes("/PlayerGameStatsByDate/")
      )
      .map((url) => url.slice(url.lastIndexOf("/") + 1));
    assert.deepEqual(scheduleDates, [
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    assert.deepEqual(playerGameDates, scheduleDates);
    assert.equal(
      result.playerGameCoverage.players[0].games.length,
      1
    );
    assert.equal(result.playerGameRows.length, 1);
  });

  test("excludes only future, cancelled, and postponed games from due coverage", async () => {
    const { adapter } = createFixture({
      games: [
        gameRow({ Status: "Canceled" }),
        gameRow({
          GameID: 9002,
          Status: "Postponed",
          DateTimeUTC: "2026-10-12T16:00:00",
        }),
        gameRow({
          GameID: 9003,
          Status: "Scheduled",
          DateTimeUTC: "2026-10-12T19:00:00",
        }),
      ],
      playerGames: [],
    });

    const result = await fetchSnapshot(adapter);

    assert.deepEqual(result.playerGameCoverage.players[0], {
      playerId: id(1),
      providerPlayerId: "101",
      providerTeamId: "10",
      disposition: "no_due_game",
      games: [],
    });
    assert.deepEqual(result.playerGameRows, []);
  });

  test("returns a required historical game for a player who is currently a free agent", async () => {
    const requiredGame = requiredPlayerGame({
      playerId: id(3),
      providerPlayerId: "103",
      providerTeamId: "30",
    });
    const { adapter } = createFixture({
      gamesByDate: {
        "2026-09-28": [historicalGameRow()],
        "2026-10-12": [],
      },
      playerGamesByDate: {
        "2026-09-28": [historicalPlayerGameRow({
          PlayerID: 103,
          TeamID: 30,
        })],
        "2026-10-12": [],
      },
    });

    const result = await fetchSnapshot(
      adapter,
      requiredPlayers(),
      [requiredGame]
    );

    assert.deepEqual(result.playerGameCoverage.players[2], {
      playerId: id(3),
      providerPlayerId: "103",
      providerTeamId: null,
      disposition: "expected_game",
      games: [{
        providerTeamId: "30",
        nhlGameId: "8001",
        nhlGameScheduledStartsAtMs:
          HISTORICAL_GAME_START_MS,
        observedGameState: "final",
      }],
    });
    assert.deepEqual(result.playerGameRows, [{
      playerId: "103",
      nhlGameId: "8001",
      nhlGameScheduledStartsAtMs:
        HISTORICAL_GAME_START_MS,
      observedGameState: "final",
      goals: 1,
      assists: 0,
      sourceUpdatedAtMs: Date.parse(
        "2026-09-29T00:00:00Z"
      ),
    }]);
  });

  test("fails closed for missing, duplicate, and conflicting membership", async (t) => {
    const cases = [
      {
        name: "missing required membership",
        fixture: {
          activePlayers: activePlayerRows().filter(
            ({ PlayerID }) => PlayerID !== 101
          ),
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
      {
        name: "duplicate active membership",
        fixture: {
          activePlayers: [
            ...activePlayerRows(),
            { PlayerID: 101, TeamID: 10 },
          ],
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "active and free-agent conflict",
        fixture: {
          freeAgents: [
            ...freeAgentRows(),
            { PlayerID: 101, TeamID: null },
          ],
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "active player without team",
        fixture: {
          activePlayers: activePlayerRows().map((row) =>
            row.PlayerID === 101
              ? { ...row, TeamID: null }
              : row
          ),
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "free agent with team",
        fixture: {
          freeAgents: freeAgentRows().map((row) =>
            row.PlayerID === 103
              ? { ...row, TeamID: 10 }
              : row
          ),
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "player-game team mismatch",
        fixture: {
          playerGames: [playerGameRow({ TeamID: 20 })],
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
    ];

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const { adapter } = createFixture(candidate.fixture);
        await assert.rejects(
          fetchSnapshot(adapter),
          { code: candidate.code }
        );
      });
    }
  });

  test("rejects a missing due PlayerGame row instead of manufacturing zero", async () => {
    const { adapter } = createFixture({ playerGames: [] });

    await assert.rejects(
      fetchSnapshot(adapter),
      { code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE" }
    );
  });

  test("fails closed when targeted historical schedule or PlayerGame evidence is not exact", async (t) => {
    const cases = [
      {
        name: "missing required schedule game",
        historicalGames: [],
        historicalPlayerGames: [],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
      {
        name: "wrong required schedule start",
        historicalGames: [historicalGameRow({
          DateTimeUTC: "2026-09-28T23:31:00",
        })],
        historicalPlayerGames: [historicalPlayerGameRow()],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "wrong required schedule team",
        historicalGames: [historicalGameRow({
          HomeTeamID: 20,
          AwayTeamID: 30,
        })],
        historicalPlayerGames: [historicalPlayerGameRow()],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "missing required PlayerGame",
        historicalGames: [historicalGameRow()],
        historicalPlayerGames: [],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
      {
        name: "wrong required PlayerGame team",
        historicalGames: [historicalGameRow()],
        historicalPlayerGames: [historicalPlayerGameRow({
          TeamID: 30,
        })],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "wrong required PlayerGame player",
        historicalGames: [historicalGameRow()],
        historicalPlayerGames: [historicalPlayerGameRow({
          PlayerID: 102,
        })],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
      {
        name: "required schedule returned only on another date",
        historicalGames: [],
        historicalPlayerGames: [],
        currentGames: [historicalGameRow()],
        currentPlayerGames: [historicalPlayerGameRow()],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
      {
        name: "required PlayerGame returned only on another date",
        historicalGames: [historicalGameRow()],
        historicalPlayerGames: [],
        currentPlayerGames: [historicalPlayerGameRow()],
        code: "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE",
      },
    ];

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const { adapter } = createFixture({
          gamesByDate: {
            "2026-09-28": candidate.historicalGames,
            "2026-10-12": candidate.currentGames ?? [],
          },
          playerGamesByDate: {
            "2026-09-28":
              candidate.historicalPlayerGames,
            "2026-10-12":
              candidate.currentPlayerGames ?? [],
          },
        });
        await assert.rejects(
          fetchSnapshot(
            adapter,
            requiredPlayers(),
            [requiredPlayerGame()]
          ),
          { code: candidate.code }
        );
      });
    }
  });

  test("rejects conflicting historical and current team bindings for the same game", async () => {
    const { adapter } = createFixture({
      activePlayers: activePlayerRows().map((row) =>
        row.PlayerID === 101
          ? { ...row, TeamID: 20 }
          : row
      ),
      games: [gameRow({
        HomeTeamID: 10,
        AwayTeamID: 20,
      })],
      playerGames: [playerGameRow()],
    });

    await assert.rejects(
      fetchSnapshot(
        adapter,
        requiredPlayers(),
        [requiredPlayerGame({
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
        })]
      ),
      { code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID" }
    );
  });

  test("accepts only explicit PlayerGame Games zero or one", async () => {
    for (const providerGames of [0, 1]) {
      const { adapter } = createFixture({
        playerGames: [playerGameRow({ Games: providerGames })],
      });
      const result = await fetchSnapshot(adapter);
      assert.equal(result.playerGameRows.length, 1);
      assert.equal(result.playerGameRows[0].goals, 0);
      assert.equal(result.playerGameRows[0].assists, 0);
    }

    for (const providerGames of [2, null]) {
      const { adapter } = createFixture({
        playerGames: [playerGameRow({ Games: providerGames })],
      });
      await assert.rejects(
        fetchSnapshot(adapter),
        { code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID" }
      );
    }
  });

  test("rejects nullable scoring instead of inferring an earned zero", async () => {
    for (const changed of [
      { Goals: null },
      { Assists: null },
      { Goals: undefined },
      { Assists: undefined },
    ]) {
      const { adapter } = createFixture({
        playerGames: [playerGameRow(changed)],
      });
      await assert.rejects(
        fetchSnapshot(adapter),
        { code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID" }
      );
    }
  });

  test("source version binds totals, membership, coverage, schedule, and rows", async () => {
    const baseline = await fetchSnapshot(createFixture().adapter);
    const reordered = await fetchSnapshot(createFixture({
      totals: [...totalsRows()].reverse(),
      activePlayers: [...activePlayerRows()].reverse(),
      freeAgents: [...freeAgentRows()].reverse(),
      games: [gameRow()],
      playerGames: [
        playerGameRow({
          PlayerID: 999,
          Games: 1,
          Goals: 1,
        }),
        playerGameRow(),
      ],
    }).adapter);
    assert.equal(baseline.sourceVersion, reordered.sourceVersion);

    const changedFixtures = [
      {
        totals: totalsRows().map((row) =>
          row.PlayerID === 102
            ? { ...row, Goals: 2 }
            : row
        ),
      },
      {
        activePlayers: activePlayerRows().map((row) =>
          row.PlayerID === 102
            ? { ...row, TeamID: 21 }
            : row
        ),
      },
      {
        games: [gameRow({ Status: "Final" })],
      },
      {
        playerGames: [
          playerGameRow({ Games: 1 }),
          playerGameRow({
            PlayerID: 999,
            Games: 1,
            Goals: 1,
          }),
        ],
      },
    ];
    for (const fixtureOptions of changedFixtures) {
      const changed = await fetchSnapshot(
        createFixture(fixtureOptions).adapter
      );
      assert.notEqual(changed.sourceVersion, baseline.sourceVersion);
    }

    const changedScope = requiredPlayers().map((player) =>
      player.providerPlayerId === "101"
        ? { ...player, playerId: id(4) }
        : player
    ).sort((left, right) =>
      left.playerId.localeCompare(right.playerId)
    );
    const scoped = await fetchSnapshot(
      createFixture().adapter,
      changedScope
    );
    assert.notEqual(scoped.sourceVersion, baseline.sourceVersion);

    const explicitCurrentBinding = await fetchSnapshot(
      createFixture().adapter,
      requiredPlayers(),
      [requiredPlayerGame({
        nhlGameId: "9001",
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      })]
    );
    assert.deepEqual(
      explicitCurrentBinding.playerGameCoverage,
      baseline.playerGameCoverage
    );
    assert.deepEqual(
      explicitCurrentBinding.playerGameRows,
      baseline.playerGameRows
    );
    assert.notEqual(
      explicitCurrentBinding.sourceVersion,
      baseline.sourceVersion
    );

    const differentRequirementsDigest = await fetchSnapshot(
      createFixture().adapter,
      requiredPlayers(),
      [],
      "b".repeat(64)
    );
    assert.deepEqual(
      differentRequirementsDigest.playerGameCoverage,
      baseline.playerGameCoverage
    );
    assert.deepEqual(
      differentRequirementsDigest.playerGameRows,
      baseline.playerGameRows
    );
    assert.notEqual(
      differentRequirementsDigest.sourceVersion,
      baseline.sourceVersion
    );
  });

  test("fails closed for invalid update time, game state, season, and provider response", async (t) => {
    const cases = [
      {
        name: "missing player-game update",
        fixture: {
          playerGames: [playerGameRow({ Updated: undefined })],
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "future player-game update",
        fixture: {
          playerGames: [playerGameRow({
            Updated: "2026-10-12T14:00:00.001",
          })],
        },
        code: "SPORTSDATAIO_LIVE_RESPONSE_INVALID",
      },
      {
        name: "unknown game state",
        fixture: { games: [gameRow({ Status: "Delayed" })] },
        code: "SPORTSDATAIO_LIVE_GAME_STATE_UNSUPPORTED",
      },
      {
        name: "wrong season",
        fixture: {
          totals: totalsRows().map((row) => ({
            ...row,
            Season: 2026,
          })),
        },
        code: "SPORTSDATAIO_LIVE_SEASON_MISMATCH",
      },
      {
        name: "provider rejection",
        fixture: { ok: false },
        code: "SPORTSDATAIO_LIVE_REQUEST_FAILED",
      },
    ];

    for (const candidate of cases) {
      await t.test(candidate.name, async () => {
        const { adapter } = createFixture(candidate.fixture);
        await assert.rejects(
          fetchSnapshot(adapter),
          { code: candidate.code }
        );
      });
    }
  });

  test("preserves exact requested game-state lookup behavior", async () => {
    const { adapter, requests } = createFixture({
      games: [gameRow({ Status: "F/OT" })],
    });
    const result = await adapter.fetchGameStates({
      nhlSeasonKey: "20262027",
      requestedAtMs: NOW_MS,
      games: [{
        nhlGameId: "9001",
        nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      }],
    });

    assert.equal(result.provider, PROVIDER_NAME);
    assert.equal(result.observedAtMs, NOW_MS);
    assert.deepEqual(result.games, [{
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
      observedGameState: "final",
    }]);
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "https://api.sportsdata.io/v3/nhl/scores/json/GamesByDate/2026-10-12",
      ]
    );
  });

  test("rejects a missing requested game-state row", async () => {
    const { adapter } = createFixture({ games: [] });
    await assert.rejects(
      adapter.fetchGameStates({
        nhlSeasonKey: "20262027",
        requestedAtMs: NOW_MS,
        games: [{
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_ONE_START_MS,
        }],
      }),
      { code: "SPORTSDATAIO_LIVE_GAME_STATE_INCOMPLETE" }
    );
  });
});
