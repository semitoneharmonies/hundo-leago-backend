const {
  calculateTeamLiveScore,
  describeLiveSource,
} = require("../../../domain/matchups/matchupScoringPolicy");
const {
  verifySealedLateLockEvidence,
  verifySealedPlayerGameSet,
} = require("../../../domain/matchups/matchupSealedEvidenceVerifier");

const MATCHUP_SCORING_SERVICE_CODES = Object.freeze({
  contextMissing: "MATCHUP_SCORING_CONTEXT_MISSING",
  stateInvalid: "MATCHUP_SCORING_STATE_INVALID",
  locksIncomplete: "MATCHUP_SCORING_LOCKS_INCOMPLETE",
  statisticsMissing: "MATCHUP_SCORING_STATISTICS_MISSING",
  playerGameStatisticsMissing: "MATCHUP_SCORING_PLAYER_GAME_STATISTICS_MISSING",
});

class MatchupScoringServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MatchupScoringServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MatchupScoringServiceError(code, message);
}

function playerGameRoot(row) {
  return {
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
  };
}

function coverageEntry(row) {
  return {
    coverageEntryId: row.id,
    playerId: row.player_id,
    providerPlayerId: row.provider_player_id,
    providerTeamId: row.provider_team_id,
    disposition: row.disposition,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
  };
}

function playerGameObservation(row) {
  return {
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
  };
}

function exclusionRoot(row) {
  return {
    exclusionSetId: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    matchupWeekId: row.matchup_week_id,
    matchupId: row.matchup_id,
    teamId: row.team_id,
    matchupRosterLockId: row.matchup_roster_lock_id,
    lateSnapshotAtMs: row.late_snapshot_at_ms,
    observationSnapshotId: row.observation_snapshot_id,
    observationSha256: row.observation_sha256,
    exclusionCount: row.exclusion_count,
    evidenceSchemaVersion: row.evidence_schema_version,
    evidenceSha256: row.evidence_sha256,
  };
}

function exclusionChild(row) {
  return {
    exclusionId: row.id,
    matchupRosterPlayerId: row.matchup_roster_player_id,
    playerId: row.player_id,
    nhlGameId: row.nhl_game_id,
    nhlGameScheduledStartsAtMs:
      row.nhl_game_scheduled_starts_at_ms,
    observedGameState: row.observed_game_state,
    baselinePlayerGameStatObservationId:
      row.baseline_player_game_stat_observation_id,
  };
}

function verifyOrFail(operation, message) {
  try {
    return operation();
  } catch (_error) {
    fail(
      MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
      message
    );
  }
}

function createMatchupScoringService({ repository } = {}) {
  if (!repository || typeof repository.readContext !== "function") {
    throw new TypeError("createMatchupScoringService requires a scoring repository");
  }

  function readScore(input, allowedStatuses) {
    const context = repository.readContext(input);
    if (!context) fail(MATCHUP_SCORING_SERVICE_CODES.contextMissing, "The matchup was not found.");
    if (!allowedStatuses.has(context.matchup.status)) {
      fail(MATCHUP_SCORING_SERVICE_CODES.stateInvalid, "The matchup is not score-readable.");
    }
    if (context.locks.length !== 2) {
      fail(MATCHUP_SCORING_SERVICE_CODES.locksIncomplete, "Both team lock decisions are required.");
    }
    if (!context.refresh) {
      fail(MATCHUP_SCORING_SERVICE_CODES.statisticsMissing, "No successful live statistics are available.");
    }
    if (
      !context.playerGameSet ||
      context.playerGameSet.stat_source_id !== context.refresh.stat_source_id ||
      context.playerGameSet.refresh_id !== context.refresh.id ||
      context.playerGameSet.nhl_season_key !== context.refresh.nhl_season_key ||
      context.playerGameSet.provider !== context.refresh.provider ||
      context.playerGameSet.source_version !== context.refresh.source_version ||
      context.playerGameSet.captured_at_ms !== context.refresh.completed_at_ms
    ) {
      fail(
        MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
        "The live statistics refresh is missing its sealed player-game evidence."
      );
    }
    const verifiedPlayerGames = verifyOrFail(
      () => verifySealedPlayerGameSet({
        root: playerGameRoot(context.playerGameSet),
        coverage: context.playerGameCoverage.map(coverageEntry),
        observations:
          context.playerGameObservations.map(playerGameObservation),
      }),
      "The live statistics refresh has invalid sealed player-game evidence."
    );
    const source = describeLiveSource({
      nowMs: input.nowMs,
      completedAtMs: context.refresh.completed_at_ms,
    });
    const lockByTeam = new Map(context.locks.map((lock) => [lock.team_id, lock]));
    const playersByLock = new Map();
    for (const player of context.lockedPlayers) {
      const list = playersByLock.get(player.matchup_roster_lock_id) || [];
      list.push(player);
      playersByLock.set(player.matchup_roster_lock_id, list);
    }
    const coverageByPlayer = new Map();
    const expectedCoverageByPair = new Map();
    for (const entry of verifiedPlayerGames.coverageEvidence.preimage.coverage) {
      const entries = coverageByPlayer.get(entry.playerId) || [];
      entries.push(entry);
      coverageByPlayer.set(entry.playerId, entries);
      if (entry.disposition === "expected_game") {
        expectedCoverageByPair.set(
          `${entry.playerId}\u0000${entry.nhlGameId}`,
          entry
        );
      }
    }
    for (const lock of context.locks) {
      if (lock.legal !== 1) continue;
      for (const player of playersByLock.get(lock.id) || []) {
        if (!coverageByPlayer.has(player.player_id)) {
          fail(
            MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
            "A legally locked player is missing current coverage evidence."
          );
        }
      }
    }
    const currentPlayerGames = new Map();
    for (const observation of
      verifiedPlayerGames.observationEvidence.preimage.observations) {
      const identity = `${observation.playerId}\u0000${observation.nhlGameId}`;
      if (currentPlayerGames.has(identity)) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "The current player-game evidence is ambiguous."
        );
      }
      currentPlayerGames.set(identity, observation);
    }

    const gameStatesBySnapshot = new Map();
    for (const row of context.gameStateObservations) {
      const rows =
        gameStatesBySnapshot.get(row.observation_snapshot_id) || [];
      rows.push({
        nhlGameId: row.nhl_game_id,
        nhlGameScheduledStartsAtMs:
          row.nhl_game_scheduled_starts_at_ms,
        observedGameState: row.observed_game_state,
      });
      gameStatesBySnapshot.set(row.observation_snapshot_id, rows);
    }
    const exclusionsBySet = new Map();
    for (const row of context.exclusions) {
      const rows = exclusionsBySet.get(row.exclusion_set_id) || [];
      rows.push(row);
      exclusionsBySet.set(row.exclusion_set_id, rows);
    }
    const baselineEvidenceByExclusionSet = new Map();
    for (const evidence of context.baselinePlayerGameEvidence || []) {
      if (baselineEvidenceByExclusionSet.has(evidence.exclusionSetId)) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "A late-lock baseline player-game root is ambiguous."
        );
      }
      baselineEvidenceByExclusionSet.set(
        evidence.exclusionSetId,
        evidence
      );
    }
    const exclusionRootByLock = new Map();
    const verifiedLateEvidenceByExclusionSet = new Map();
    for (const root of context.exclusionSets) {
      const lock = lockByTeam.get(root.team_id);
      const baselineEvidence =
        baselineEvidenceByExclusionSet.get(root.id);
      if (
        !lock ||
        !baselineEvidence ||
        baselineEvidence.baselineSnapshotId !==
          root.baseline_snapshot_id ||
        lock.id !== root.matchup_roster_lock_id ||
        lock.lock_type !== "late" ||
        lock.legal !== 1 ||
        lock.version !== root.matchup_roster_lock_version ||
        lock.baseline_snapshot_id !== root.baseline_snapshot_id ||
        lock.locked_at_ms !== root.late_snapshot_at_ms ||
        root.league_id !== context.matchup.league_id ||
        root.season_id !== context.matchup.season_id ||
        root.matchup_week_id !== context.matchup.matchup_week_id ||
        root.matchup_id !== context.matchup.id ||
        root.observation_provider !== context.playerGameSet.provider ||
        exclusionRootByLock.has(lock.id)
      ) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "Late-lock exclusion evidence is not bound to the exact matchup lock."
        );
      }
      const children = exclusionsBySet.get(root.id) || [];
      const verifiedLate = verifyOrFail(
        () => verifySealedLateLockEvidence({
          playerGameRoot: playerGameRoot(
            baselineEvidence.playerGameSet
          ),
          coverage:
            baselineEvidence.coverage.map(coverageEntry),
          playerGameObservations:
            baselineEvidence.observations.map(
              playerGameObservation
            ),
          selectedRosterPlayers:
            (playersByLock.get(lock.id) || []).map((player) => ({
              playerId: player.player_id,
              matchupRosterPlayerId: player.id,
            })),
          weekStartsAtMs: context.matchup.week_starts_at_ms,
          weekEndsAtMs: context.matchup.week_ends_at_ms,
          gameStateRoot: {
            observationSnapshotId: root.observation_snapshot_id,
            provider: root.observation_provider,
            sourceVersion: root.observation_source_version,
            observedAtMs: root.observation_observed_at_ms,
            freshnessStatus: root.observation_freshness_status,
            observationCount: root.observation_count,
            evidenceSchemaVersion:
              root.observation_evidence_schema_version,
            observationSha256: root.observation_sha256,
          },
          gameStates:
            gameStatesBySnapshot.get(root.observation_snapshot_id) || [],
          exclusionRoot: exclusionRoot(root),
          exclusions: children.map(exclusionChild),
        }),
        "The complete late-lock evidence bundle is invalid."
      );
      if (
        verifiedLate.gameState.observationSha256 !==
          root.observation_sha256 ||
        verifiedLate.playerGame.root.provider !==
          context.playerGameSet.provider
      ) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "The late-lock evidence is incompatible with the current live source."
        );
      }
      exclusionRootByLock.set(lock.id, root);
      verifiedLateEvidenceByExclusionSet.set(
        root.id,
        verifiedLate
      );
      baselineEvidenceByExclusionSet.delete(root.id);
      exclusionsBySet.delete(root.id);
    }
    if (
      exclusionsBySet.size !== 0 ||
      baselineEvidenceByExclusionSet.size !== 0
    ) {
      fail(
        MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
        "Late-lock evidence is missing its exact sealed root."
      );
    }
    for (const lock of context.locks) {
      if (
        (lock.lock_type === "late") !== exclusionRootByLock.has(lock.id)
      ) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "The matchup lock and exclusion-root sets do not match."
        );
      }
    }

    const exclusionsByTeam = new Map();
    for (const exclusion of context.exclusions) {
      const identity =
        `${exclusion.player_id}\u0000${exclusion.nhl_game_id}`;
      const coverage = expectedCoverageByPair.get(identity);
      const current = currentPlayerGames.get(
        identity
      );
      const verifiedLate =
        verifiedLateEvidenceByExclusionSet.get(
          exclusion.exclusion_set_id
        );
      const baselineCoverage =
        verifiedLate?.playerGame.coverageEvidence.preimage.coverage.find(
          (row) =>
            row.disposition === "expected_game" &&
            row.playerId === exclusion.player_id &&
            row.nhlGameId === exclusion.nhl_game_id
        );
      const baseline =
        verifiedLate?.playerGame.observationEvidence.preimage.observations.find(
          (row) =>
            row.observationId ===
              exclusion.baseline_player_game_stat_observation_id &&
            row.playerId === exclusion.player_id &&
            row.nhlGameId === exclusion.nhl_game_id
        );
      if (
        !verifiedLate ||
        !baselineCoverage ||
        !baseline ||
        !coverage ||
        coverage.nhlGameScheduledStartsAtMs !==
          exclusion.nhl_game_scheduled_starts_at_ms ||
        baselineCoverage.nhlGameScheduledStartsAtMs !==
          exclusion.nhl_game_scheduled_starts_at_ms ||
        baseline.nhlGameScheduledStartsAtMs !==
          exclusion.nhl_game_scheduled_starts_at_ms ||
        exclusion.baseline_provider !==
          verifiedLate.playerGame.root.provider ||
        exclusion.baseline_stat_source_id !==
          verifiedLate.playerGame.root.statSourceId ||
        exclusion.baseline_refresh_id !==
          verifiedLate.playerGame.root.refreshId ||
        exclusion.baseline_observation_set_id !==
          verifiedLate.playerGame.root.setId ||
        exclusion.baseline_nhl_season_key !==
          verifiedLate.playerGame.root.nhlSeasonKey ||
        exclusion.baseline_provider_player_id !==
          baselineCoverage.providerPlayerId ||
        exclusion.baseline_provider_team_id !==
          baselineCoverage.providerTeamId ||
        coverage.providerPlayerId !==
          baselineCoverage.providerPlayerId ||
        coverage.providerTeamId !==
          baselineCoverage.providerTeamId ||
        exclusion.baseline_source_updated_at_ms !==
          baseline.sourceUpdatedAtMs ||
        exclusion.baseline_goals !== baseline.goals ||
        exclusion.baseline_assists !== baseline.assists ||
        exclusion.baseline_fantasy_points_hundredths !==
          baseline.fantasyPointsHundredths ||
        !current ||
        current.nhlGameScheduledStartsAtMs !==
          exclusion.nhl_game_scheduled_starts_at_ms ||
        current.sourceUpdatedAtMs < baseline.sourceUpdatedAtMs
      ) {
        fail(
          MATCHUP_SCORING_SERVICE_CODES.playerGameStatisticsMissing,
          "An excluded NHL game is missing exact current player-game evidence."
        );
      }
      const teamExclusions = exclusionsByTeam.get(exclusion.team_id) || [];
      teamExclusions.push(Object.freeze({
        player_id: exclusion.player_id,
        nhl_game_id: exclusion.nhl_game_id,
        baseline_goals: baseline.goals,
        baseline_assists: baseline.assists,
        baseline_fantasy_points_hundredths:
          baseline.fantasyPointsHundredths,
        current_goals: current.goals,
        current_assists: current.assists,
        current_fantasy_points_hundredths:
          current.fantasyPointsHundredths,
      }));
      exclusionsByTeam.set(exclusion.team_id, teamExclusions);
    }
    const score = (teamId) => {
      const lock = lockByTeam.get(teamId);
      if (!lock) fail(MATCHUP_SCORING_SERVICE_CODES.locksIncomplete, "A team lock is missing.");
      return calculateTeamLiveScore({
        lock,
        lockedPlayers: playersByLock.get(lock.id) || [],
        currentTotals: context.totals,
        excludedPlayerGames: exclusionsByTeam.get(teamId) || [],
      });
    };
    return Object.freeze({
      matchupId: context.matchup.id,
      status: context.matchup.status,
      source: Object.freeze({
        provider: context.refresh.provider,
        refreshId: context.refresh.id,
        completedAtMs: context.refresh.completed_at_ms,
        ...source,
      }),
      home: score(context.matchup.home_team_id),
      away: score(context.matchup.away_team_id),
    });
  }

  function readLive(input) {
    return readScore(input, new Set(["live", "awaiting_data"]));
  }

  function readAtRefresh(input) {
    if (input?.refreshId === undefined) {
      fail(
        MATCHUP_SCORING_SERVICE_CODES.statisticsMissing,
        "A finalized statistics refresh is required."
      );
    }
    return readScore(input, new Set(["final"]));
  }

  return Object.freeze({ readAtRefresh, readLive });
}

module.exports = {
  MATCHUP_SCORING_SERVICE_CODES,
  MatchupScoringServiceError,
  createMatchupScoringService,
};
