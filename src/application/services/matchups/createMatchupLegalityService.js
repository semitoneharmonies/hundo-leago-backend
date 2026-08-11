const { randomUUID } = require("node:crypto");

const {
  evaluateMatchupLineupLegality,
} = require("../../../domain/matchups/matchupLegalityPolicy");
const {
  assertFreshBaselineSource,
  buildLockedPlayerBaselines,
} = require("../../../domain/matchups/matchupLockPolicy");
const {
  assertFreshNhlGameObservation,
  createMatchupLateLockExclusionSetEvidence,
  createNhlGameObservationSnapshotEvidence,
  isWholeGameExcluded,
} = require("../../../domain/matchups/matchupLateLockEvidencePolicy");
const {
  verifySealedLateLockEvidence,
  verifySealedPlayerGameSet,
} = require("../../../domain/matchups/matchupSealedEvidenceVerifier");

const MATCHUP_LEGALITY_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_LEGALITY_CONTEXT_MISSING",
  lockIdRequired: "MATCHUP_LEGALITY_LOCK_ID_REQUIRED",
  weekNotLive: "MATCHUP_LEGALITY_WEEK_NOT_LIVE",
  tooEarly: "MATCHUP_LEGALITY_TOO_EARLY",
  weekEnded: "MATCHUP_LEGALITY_WEEK_ENDED",
  normalLockMissing: "MATCHUP_LEGALITY_NORMAL_LOCK_MISSING",
  stillIllegal: "MATCHUP_LEGALITY_STILL_ILLEGAL",
  statisticsMissing: "MATCHUP_LEGALITY_STATISTICS_MISSING",
  playerGameStatisticsMissing:
    "MATCHUP_LEGALITY_PLAYER_GAME_STATISTICS_MISSING",
  gameStateProviderMissing:
    "MATCHUP_LEGALITY_GAME_STATE_PROVIDER_MISSING",
  gameStateUnavailable: "MATCHUP_LEGALITY_GAME_STATE_UNAVAILABLE",
  gameStateIncomplete: "MATCHUP_LEGALITY_GAME_STATE_INCOMPLETE",
  gameStateProviderMismatch:
    "MATCHUP_LEGALITY_GAME_STATE_PROVIDER_MISMATCH",
  clockRegressed: "MATCHUP_LEGALITY_CLOCK_REGRESSED",
  lockConflict: "MATCHUP_LEGALITY_LOCK_CONFLICT",
});

class MatchupLegalityServiceError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MatchupLegalityServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupLegalityServiceError(code, message);
}

function playerGameRoot(row) {
  return Object.freeze({
    setId: row.id,
    statSourceId: row.stat_source_id,
    refreshId: row.refresh_id,
    nhlSeasonKey: row.nhl_season_key,
    provider: row.provider,
    sourceVersion: row.source_version,
    capturedAtMs: row.captured_at_ms,
    requiredPlayerCount: row.required_player_count,
    coverageEntryCount: row.coverage_entry_count,
    expectedPlayerGameCount: row.expected_player_game_count,
    coverageSchemaVersion: row.coverage_schema_version,
    coverageSha256: row.coverage_sha256,
    observationCount: row.observation_count,
    evidenceSchemaVersion: row.evidence_schema_version,
    evidenceSha256: row.evidence_sha256,
  });
}

function coverageRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    coverageEntryId: row.id,
    playerId: row.player_id,
    providerPlayerId: row.provider_player_id,
    providerTeamId: row.provider_team_id,
    disposition: row.disposition,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
  })));
}

function observationRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({
    observationId: row.id,
    playerId: row.player_id,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,
    goals: row.goals,
    assists: row.assists,
    nhlPoints: row.nhl_points,
    fantasyPointsHundredths: row.fantasy_points_hundredths,
    sourceUpdatedAtMs: row.source_updated_at_ms,
  })));
}

function serverEmptyGameStateSourceVersion(lateSnapshotAtMs) {
  return `server-empty-game-state:${lateSnapshotAtMs}`;
}

function createMatchupLegalityService({
  repository,
  normalLockService,
  gameStateProvider = null,
  createId = randomUUID,
  nowMs = Date.now,
} = {}) {
  if (
    !repository ||
    typeof repository.readContext !== "function" ||
    typeof repository.persistIllegalLock !== "function" ||
    typeof repository.persistLateLockWithEvidence !== "function"
  ) {
    throw new TypeError("createMatchupLegalityService requires a matchup-lock repository");
  }
  if (!normalLockService || typeof normalLockService.lock !== "function") {
    throw new TypeError("createMatchupLegalityService requires the normal lock service");
  }
  if (typeof createId !== "function") {
    throw new TypeError("createMatchupLegalityService requires an ID factory");
  }
  if (typeof nowMs !== "function") {
    throw new TypeError("createMatchupLegalityService requires a server clock");
  }
  if (
    gameStateProvider !== null &&
    typeof gameStateProvider?.fetchGameStates !== "function"
  ) {
    throw new TypeError(
      "createMatchupLegalityService requires a valid NHL game-state provider"
    );
  }

  function requireContext(input) {
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_LEGALITY_SERVICE_CODES.contextMissing, "The matchup team was not found.");
    return context;
  }

  function validateWindow(context, nowMs, { late }) {
    if (context.week.status !== "live") {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.weekNotLive, "The matchup week is not live.");
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < context.week.locks_at_ms || (late && nowMs === context.week.locks_at_ms)) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.tooEarly, "The requested lock boundary has not arrived.");
    }
    if (nowMs >= context.week.ends_at_ms) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.weekEnded, "The matchup week has ended.");
    }
  }

  function lockAtBoundary(input) {
    if (!input?.lockId) fail(MATCHUP_LEGALITY_SERVICE_CODES.lockIdRequired, "A stable lock ID is required.");
    const context = requireContext(input);
    validateWindow(context, input.nowMs, { late: false });
    if (context.existingLocks.length > 0) {
      const existing = context.existingLocks[0];
      if (context.existingLocks.length !== 1 || existing.id !== input.lockId) {
        fail(MATCHUP_LEGALITY_SERVICE_CODES.lockConflict, "The team already has different lock evidence.");
      }
      if (existing.legal === 0) {
        return repository.persistIllegalLock({
          ...input,
          expectedWeekVersion: context.week.version,
          activePlayerFingerprint: JSON.stringify(context.activePlayers),
          locksAtMs: context.week.locks_at_ms,
          reasonCode: existing.legality_reason_code,
        });
      }
      return normalLockService.lock(input);
    }
    const decision = evaluateMatchupLineupLegality(context.activePlayers);
    if (decision.legal) return normalLockService.lock(input);
    return repository.persistIllegalLock({
      leagueId: context.week.league_id,
      seasonId: context.week.season_id,
      weekId: context.week.id,
      teamId: input.teamId,
      provider: input.provider,
      lockId: input.lockId,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      locksAtMs: context.week.locks_at_ms,
      reasonCode: decision.primaryReasonCode,
      nowMs: input.nowMs,
      ...(input.occurrenceExecution === undefined
        ? {}
        : { occurrenceExecution: input.occurrenceExecution }),
    });
  }

  async function lockLate(input) {
    if (!input?.lockId) fail(MATCHUP_LEGALITY_SERVICE_CODES.lockIdRequired, "A stable lock ID is required.");
    const context = requireContext({
      ...input,
      baselineCutoffAtMs: input.nowMs,
      requireSealedPlayerGameEvidence: true,
    });
    validateWindow(context, input.nowMs, { late: true });
    if (context.existingLocks.length !== 1 || context.existingLocks[0].id !== input.lockId) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.normalLockMissing, "The team's illegal normal lock is missing.");
    }
    const existing = context.existingLocks[0];
    const decision = evaluateMatchupLineupLegality(context.activePlayers);
    if (!decision.legal) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.stillIllegal, "The team roster is still illegal.");
    }
    if (!context.refresh) {
      fail(MATCHUP_LEGALITY_SERVICE_CODES.statisticsMissing, "No successful late baseline is available.");
    }
    if (!context.playerGameSet) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.playerGameStatisticsMissing,
        "The late baseline has no sealed player-game evidence."
      );
    }
    const playersWithCumulativeTotals = new Set(
      context.totals.map((row) => row.player_id)
    );
    if (
      context.activePlayers.some(
        (row) => !playersWithCumulativeTotals.has(row.player_id)
      )
    ) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.statisticsMissing,
        "A selected late-lock player has no cumulative baseline statistics."
      );
    }
    assertFreshBaselineSource({
      baselineAtMs: input.nowMs,
      refreshCompletedAtMs: context.refresh.completed_at_ms,
    });
    const baselines = buildLockedPlayerBaselines({
      activePlayers: context.activePlayers,
      totals: context.totals,
    });
    const players = baselines.map((player) => Object.freeze({
      ...player,
      snapshotPlayerId: createId(),
      lockPlayerId: createId(),
    }));
    const activePlayerIds = new Set(
      context.activePlayers.map((player) => player.player_id)
    );
    const sealedPlayerGame = verifySealedPlayerGameSet({
      root: playerGameRoot(context.playerGameSet),
      coverage: coverageRows(context.playerGameCoverage),
      observations: observationRows(
        context.playerGameObservations
      ),
    });
    const coverageByPlayer = new Map();
    for (const row of sealedPlayerGame.coverageEvidence.preimage.coverage) {
      const entries = coverageByPlayer.get(row.playerId) || [];
      entries.push(row);
      coverageByPlayer.set(row.playerId, entries);
    }
    for (const playerId of activePlayerIds) {
      if (!coverageByPlayer.has(playerId)) {
        fail(
          MATCHUP_LEGALITY_SERVICE_CODES.playerGameStatisticsMissing,
          "A selected late-lock player lacks affirmative coverage."
        );
      }
    }
    const candidatePlayerGames = [];
    const requiredGames = new Map();
    for (const playerId of activePlayerIds) {
      for (const row of coverageByPlayer.get(playerId)) {
        if (
          row.disposition !== "expected_game" ||
          row.nhlGameScheduledStartsAtMs <
            context.week.starts_at_ms ||
          row.nhlGameScheduledStartsAtMs >=
            context.week.ends_at_ms
        ) {
          continue;
        }
        candidatePlayerGames.push(row);
        const existingStart = requiredGames.get(row.nhlGameId);
        if (
          existingStart !== undefined &&
          existingStart !== row.nhlGameScheduledStartsAtMs
        ) {
          fail(
            MATCHUP_LEGALITY_SERVICE_CODES.gameStateIncomplete,
            "The sealed coverage has conflicting game starts."
          );
        }
        requiredGames.set(
          row.nhlGameId,
          row.nhlGameScheduledStartsAtMs
        );
      }
    }

    const requestedGames = Object.freeze(
      [...requiredGames.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nhlGameId, nhlGameScheduledStartsAtMs]) =>
          Object.freeze({
            nhlGameId,
            nhlGameScheduledStartsAtMs,
          })
        )
    );
    let gameStateResult;
    if (requestedGames.length === 0) {
      const observedAtMs = nowMs();
      gameStateResult = Object.freeze({
        provider: sealedPlayerGame.root.provider,
        sourceVersion:
          serverEmptyGameStateSourceVersion(observedAtMs),
        observedAtMs,
        games: Object.freeze([]),
      });
    } else {
      if (!gameStateProvider) {
        fail(
          MATCHUP_LEGALITY_SERVICE_CODES.gameStateProviderMissing,
          "No NHL game-state provider is configured."
        );
      }
      try {
        gameStateResult = await gameStateProvider.fetchGameStates({
          nhlSeasonKey: context.week.nhl_season_key,
          requestedAtMs: input.nowMs,
          games: requestedGames,
        });
      } catch (error) {
        throw new MatchupLegalityServiceError(
          MATCHUP_LEGALITY_SERVICE_CODES.gameStateUnavailable,
          "Fresh NHL game-state evidence is unavailable.",
          { cause: error }
        );
      }
    }
    if (
      gameStateResult === null ||
      typeof gameStateResult !== "object" ||
      Array.isArray(gameStateResult) ||
      !Array.isArray(gameStateResult.games)
    ) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.gameStateIncomplete,
        "The NHL game-state response is invalid."
      );
    }
    if (gameStateResult.provider !== sealedPlayerGame.root.provider) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.gameStateProviderMismatch,
        "Statistics and game-state evidence use incompatible providers."
      );
    }
    const lateSnapshotAtMs = requestedGames.length === 0
      ? gameStateResult.observedAtMs
      : nowMs();
    if (
      !Number.isSafeInteger(lateSnapshotAtMs) ||
      lateSnapshotAtMs < input.nowMs
    ) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.clockRegressed,
        "The server clock regressed during the NHL game-state fetch."
      );
    }
    validateWindow(context, lateSnapshotAtMs, { late: true });
    assertFreshBaselineSource({
      baselineAtMs: lateSnapshotAtMs,
      refreshCompletedAtMs: context.refresh.completed_at_ms,
    });
    assertFreshNhlGameObservation({
      observedAtMs: gameStateResult.observedAtMs,
      lateSnapshotAtMs,
    });
    const observationSnapshotId = createId();
    const observationEvidence =
      createNhlGameObservationSnapshotEvidence({
        observationSnapshotId,
        provider: gameStateResult.provider,
        sourceVersion: gameStateResult.sourceVersion,
        observedAtMs: gameStateResult.observedAtMs,
        freshnessStatus: "fresh",
        games: gameStateResult.games,
      });
    const observedGames = new Map();
    const excludedGames = new Set();
    for (const game of observationEvidence.preimage.games) {
      if (
        requiredGames.get(game.nhlGameId) !==
        game.nhlGameScheduledStartsAtMs
      ) {
        fail(
          MATCHUP_LEGALITY_SERVICE_CODES.gameStateIncomplete,
          "The NHL game-state response does not match the required games."
        );
      }
      observedGames.set(game.nhlGameId, game);
      if (isWholeGameExcluded({
        nhlGameScheduledStartsAtMs:
          game.nhlGameScheduledStartsAtMs,
        observedGameState: game.observedGameState,
        lateSnapshotAtMs,
      })) {
        excludedGames.add(game.nhlGameId);
      }
    }
    if (observedGames.size !== requiredGames.size) {
      fail(
        MATCHUP_LEGALITY_SERVICE_CODES.gameStateIncomplete,
        "The NHL game-state response is incomplete."
      );
    }
    const gameObservations =
      observationEvidence.preimage.games.map((game) =>
        Object.freeze({
          ...game,
          observationId: createId(),
        })
      );
    const observationByGame = new Map(
      gameObservations.map((game) => [game.nhlGameId, game])
    );
    const lockPlayerByPlayer = new Map(
      players.map((player) => [player.playerId, player.lockPlayerId])
    );
    const baselineByPair = new Map(
      sealedPlayerGame.observationEvidence.preimage.observations.map(
        (row) => [`${row.playerId}\u0000${row.nhlGameId}`, row]
      )
    );
    const relevantPlayerGames = candidatePlayerGames.filter(
      (row) =>
        row.nhlGameScheduledStartsAtMs <= lateSnapshotAtMs
    );
    const exclusions = relevantPlayerGames
      .filter((row) => excludedGames.has(row.nhlGameId))
      .map((row) => {
        const observation = observationByGame.get(row.nhlGameId);
        const baseline = baselineByPair.get(
          `${row.playerId}\u0000${row.nhlGameId}`
        );
        if (!baseline) {
          fail(
            MATCHUP_LEGALITY_SERVICE_CODES.playerGameStatisticsMissing,
            "An excluded covered pair lacks its baseline observation."
          );
        }
        return Object.freeze({
          exclusionId: createId(),
          matchupRosterPlayerId:
            lockPlayerByPlayer.get(row.playerId),
          playerId: row.playerId,
          observationId: observation.observationId,
          baselinePlayerGameStatObservationId:
            baseline.observationId,
          nhlGameId: row.nhlGameId,
          nhlGameScheduledStartsAtMs:
            row.nhlGameScheduledStartsAtMs,
          observedGameState: observation.observedGameState,
        });
      });
    const exclusionSetId = createId();
    const exclusionEvidence =
      createMatchupLateLockExclusionSetEvidence({
        exclusionSetId,
        leagueId: context.week.league_id,
        seasonId: context.week.season_id,
        matchupWeekId: context.week.id,
        matchupId: context.week.matchup_id,
        teamId: input.teamId,
        matchupRosterLockId: existing.id,
        lateSnapshotAtMs,
        observationSnapshotId,
        observationSha256: observationEvidence.observationSha256,
        exclusions: exclusions.map((row) => ({
          exclusionId: row.exclusionId,
          matchupRosterPlayerId: row.matchupRosterPlayerId,
          playerId: row.playerId,
          nhlGameId: row.nhlGameId,
          nhlGameScheduledStartsAtMs:
            row.nhlGameScheduledStartsAtMs,
          observedGameState: row.observedGameState,
          baselinePlayerGameStatObservationId:
            row.baselinePlayerGameStatObservationId,
        })),
      });
    verifySealedLateLockEvidence({
      playerGameRoot: sealedPlayerGame.root,
      coverage: sealedPlayerGame.coverageEvidence.preimage.coverage,
      playerGameObservations:
        sealedPlayerGame.observationEvidence.preimage.observations,
      selectedRosterPlayers: players.map((row) => ({
        playerId: row.playerId,
        matchupRosterPlayerId: row.lockPlayerId,
      })),
      weekStartsAtMs: context.week.starts_at_ms,
      weekEndsAtMs: context.week.ends_at_ms,
      gameStateRoot: {
        observationSnapshotId,
        provider: observationEvidence.preimage.provider,
        sourceVersion: observationEvidence.preimage.sourceVersion,
        observedAtMs: observationEvidence.preimage.observedAtMs,
        freshnessStatus: observationEvidence.preimage.freshnessStatus,
        observationCount: observationEvidence.observationCount,
        evidenceSchemaVersion:
          observationEvidence.preimage.schemaVersion,
        observationSha256: observationEvidence.observationSha256,
      },
      gameStates: observationEvidence.preimage.games,
      exclusionRoot: {
        exclusionSetId,
        leagueId: context.week.league_id,
        seasonId: context.week.season_id,
        matchupWeekId: context.week.id,
        matchupId: context.week.matchup_id,
        teamId: input.teamId,
        matchupRosterLockId: existing.id,
        lateSnapshotAtMs,
        observationSnapshotId,
        observationSha256: observationEvidence.observationSha256,
        exclusionCount: exclusionEvidence.exclusionCount,
        evidenceSchemaVersion:
          exclusionEvidence.preimage.schemaVersion,
        evidenceSha256: exclusionEvidence.evidenceSha256,
      },
      exclusions: exclusionEvidence.preimage.exclusions,
    });
    return repository.persistLateLockWithEvidence({
      leagueId: context.week.league_id,
      seasonId: context.week.season_id,
      weekId: context.week.id,
      matchupId: context.week.matchup_id,
      teamId: input.teamId,
      provider: input.provider,
      baselineCutoffAtMs: lateSnapshotAtMs,
      lockId: existing.id,
      expectedLockVersion: existing.version,
      expectedWeekVersion: context.week.version,
      activePlayerFingerprint: JSON.stringify(context.activePlayers),
      expectedPlayerGameSetId: context.playerGameSet.id,
      expectedPlayerGameCoverageSha256:
        context.playerGameSet.coverage_sha256,
      expectedPlayerGameEvidenceSha256:
        context.playerGameSet.evidence_sha256,
      playerGameRootFingerprint: JSON.stringify(
        context.playerGameSet
      ),
      playerGameCoverageFingerprint: JSON.stringify(
        context.playerGameCoverage
      ),
      playerGameFingerprint: JSON.stringify(
        context.playerGameObservations
      ),
      snapshotId: createId(),
      statSourceId: context.refresh.stat_source_id,
      refreshId: context.refresh.id,
      baselineAtMs: lateSnapshotAtMs,
      nowMs: lateSnapshotAtMs,
      players: Object.freeze(players),
      observationSnapshotId,
      observationProvider: observationEvidence.preimage.provider,
      observationSourceVersion:
        observationEvidence.preimage.sourceVersion,
      observationObservedAtMs:
        observationEvidence.preimage.observedAtMs,
      gameObservations: Object.freeze(gameObservations),
      exclusionSetId,
      exclusions: Object.freeze(exclusions),
      ...(input.occurrenceExecution === undefined
        ? {}
        : { occurrenceExecution: input.occurrenceExecution }),
    });
  }

  return Object.freeze({ lockAtBoundary, lockLate });
}

module.exports = {
  MATCHUP_LEGALITY_SERVICE_CODES,
  MatchupLegalityServiceError,
  createMatchupLegalityService,
};
