const { createHash } = require("node:crypto");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { createSqliteSharedGameEvidenceRepository } = require("./SqliteSharedGameEvidenceRepository");
const { createPlayerGameCoverageSetEvidence } = require("../../../domain/statistics/playerGameCoveragePolicy");
const { createPlayerGameObservationSetEvidence } = require("../../../domain/statistics/playerGameStatisticsPolicy");
const { normalizeExpandedSnapshot, expandedSnapshotHash } = require("../../../domain/statistics/expandedStatisticsSnapshotPolicy");
const { EXPANDED_SCORING_VERSION, normalizeScoringStats } = require("../../../domain/statistics/expandedScoringPolicy");
const { stableId } = require("../../../domain/statistics/sharedGameEvidencePolicy");

const sha = value => createHash("sha256").update(value).digest("hex");
function evidenceId(refreshId, kind, key = "") {
  stableId(refreshId);
  const bytes = createHash("sha256").update(JSON.stringify(["hundo.compact-statistics.v1", refreshId, kind, key])).digest();
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const coverageKey = row => `${row.playerId}\u0000${row.nhlGameId ?? row.disposition}`;
const gameKey = row => `${row.playerId}\u0000${row.nhlGameId}`;
const projectionId = (sourceId, season, playerId) => evidenceId(sourceId, "current-total", `${season}\u0000${playerId}`);
const available = database => database.pragma("user_version", { simple: true }) >= 70;

function totalPayload(row) {
  const value = { playerId: stableId(row.playerId), providerPlayerId: row.providerPlayerId,
    gamesPlayed: row.gamesPlayed, goals: row.goals, assists: row.assists, nhlPoints: row.nhlPoints,
    fantasyPointsHundredths: row.fantasyPointsHundredths, scoringStats: normalizeScoringStats(row.scoringStats) };
  if (typeof value.providerPlayerId !== "string" || !/^[1-9][0-9]*$/.test(value.providerPlayerId) ||
      [value.gamesPlayed, value.goals, value.assists, value.nhlPoints, value.fantasyPointsHundredths].some(n => !Number.isSafeInteger(n) || n < 0) ||
      value.nhlPoints !== value.goals + value.assists || value.fantasyPointsHundredths !== value.goals * 125 + value.assists * 100) {
    throw new TypeError("Invalid shared player totals.");
  }
  return JSON.stringify(value);
}
function totalHash(rows) { return sha(JSON.stringify([...rows].sort((a, b) => a.playerId.localeCompare(b.playerId)).map(totalPayload))); }
function projectEvidence(scope, totals, coverage, observations, expanded, expandedHash) {
  const { refreshId, statSourceId, nhlSeasonKey, completedAtMs, observedAtMs } = scope;
  const fields = { stat_source_id: statSourceId, refresh_id: refreshId, observation_set_id: evidenceId(refreshId, "set"),
    nhl_season_key: nhlSeasonKey, created_at_ms: completedAtMs, version: 1 };
  const identities = new Map(totals.map(row => [row.providerPlayerId, row.playerId]));
  return deepFreeze({
    totals: [...totals].sort((a, b) => a.playerId.localeCompare(b.playerId)).map(row => ({ id: evidenceId(refreshId, "total", row.playerId), stat_source_id: statSourceId, refresh_id: refreshId,
      nhl_season_key: nhlSeasonKey, player_id: row.playerId, games_played: row.gamesPlayed, goals: row.goals, assists: row.assists,
      nhl_points: row.nhlPoints, fantasy_points_hundredths: row.fantasyPointsHundredths, source_updated_at_ms: observedAtMs, created_at_ms: completedAtMs })),
    coverage: coverage.map(row => ({ ...fields, id: row.coverageEntryId, player_id: row.playerId, provider_player_id: row.providerPlayerId,
      provider_team_id: row.providerTeamId, disposition: row.disposition, nhl_game_id: row.nhlGameId, nhl_game_scheduled_starts_at_ms: row.nhlGameScheduledStartsAtMs })),
    observations: observations.map(row => ({ ...fields, id: row.observationId, player_id: row.playerId, nhl_game_id: row.nhlGameId,
      nhl_game_scheduled_starts_at_ms: row.nhlGameScheduledStartsAtMs, observed_game_state: row.observedGameState, goals: row.goals,
      assists: row.assists, nhl_points: row.nhlPoints, fantasy_points_hundredths: row.fantasyPointsHundredths, source_updated_at_ms: row.sourceUpdatedAtMs })),
    expandedScoring: { scoringRuleVersion: EXPANDED_SCORING_VERSION, evidenceSha256: expandedHash,
      totals: totals.map(row => ({ playerId: row.playerId, scoringStats: row.scoringStats })),
      playerGames: expanded.playerGameRows.map(row => ({ playerId: identities.get(row.playerId), nhlGameId: row.nhlGameId, gamesPlayed: row.gamesPlayed, scoringStats: row.scoringStats })) },
  });
}
function effectiveTotals(database, capture) {
  // Resolve versions entirely from the covering index before reading payloads.
  // The rowid set then reads table pages in physical order, avoiding random
  // payload reads for every superseded season total on a cold connection.
  return database.prepare(`WITH latest AS (
    SELECT player_id,MAX(revision) revision FROM shared_stat_total_changes
    WHERE stat_source_id=@stat_source_id AND nhl_season_key=@nhl_season_key AND revision<=@revision GROUP BY player_id
  ) SELECT current.* FROM shared_stat_total_changes current WHERE current.rowid IN (
    SELECT selected.rowid FROM latest JOIN shared_stat_total_changes selected
      ON selected.player_id=latest.player_id AND selected.revision=latest.revision
    WHERE selected.stat_source_id=@stat_source_id AND selected.nhl_season_key=@nhl_season_key
  ) AND current.payload_json IS NOT NULL ORDER BY current.player_id`).all(capture).map(row => {
      const value = JSON.parse(row.payload_json);
      if (value.playerId !== row.player_id || totalPayload(value) !== row.payload_json || sha(row.payload_json) !== row.payload_sha256) throw new Error("Shared total evidence is corrupt.");
      return value;
    });
}

function createCompactStatisticsStorage({ database }) {
  if (!available(database)) throw new Error("Compact statistics require schema 70.");
  const plans = new Map();
  const findHead = () => database.prepare(`SELECT c.*,m.totals_sha256,m.total_count FROM compact_stat_refreshes m
    JOIN shared_game_evidence_captures c ON c.refresh_id=m.refresh_id
    WHERE c.stat_source_id=? AND c.nhl_season_key=? ORDER BY c.revision DESC LIMIT 1`);
  return Object.freeze({
    createRowId: evidenceId,
    totalProjectionId: projectionId,
    async prepare(command) {
      const head = findHead().get(command.statSourceId, command.nhlSeasonKey);
      const old = head ? effectiveTotals(database, head) : [];
      if (head && (head.total_count !== old.length || totalHash(old) !== head.totals_sha256)) throw new Error("Shared total history does not match its seal.");
      const identities = new Map(database.prepare("SELECT external_value,player_id FROM player_external_ids WHERE provider=?").all(command.playerIdentityProvider).map(row => [row.external_value, row.player_id]));
      const expanded = normalizeExpandedSnapshot(command.expandedScoring, { nhlSeasonKey: command.nhlSeasonKey, totals: command.rows, observations: command.playerGameRows });
      const categories = new Map(expanded.totalsRows.map(row => [row.playerId, row.scoringStats]));
      const totals = [];
      for (const row of command.rows) {
        totals.push(JSON.parse(totalPayload({ ...row, playerId: identities.get(row.externalPlayerId), providerPlayerId: row.externalPlayerId, scoringStats: categories.get(row.externalPlayerId) })));
        if (totals.length % 256 === 0) await yieldToEventLoop();
      }
      if (new Set(totals.map(row => row.playerId)).size !== totals.length) throw new Error("Shared totals have ambiguous player identities.");
      const prior = new Map(old.map(row => [row.playerId, totalPayload(row)]));
      const changes = [];
      for (const row of totals) {
        const payload = totalPayload(row);
        if (prior.get(row.playerId) !== payload) changes.push({ playerId: row.playerId, payload, hash: sha(payload) });
        prior.delete(row.playerId);
      }
      for (const playerId of prior.keys()) changes.push({ playerId, payload: null, hash: null });
      const emptyCoverage = command.playerGameCoverage.filter(row => row.disposition !== "expected_game").map(row => ({
        playerId: row.playerId, providerPlayerId: row.providerPlayerId, providerTeamId: row.providerTeamId,
        disposition: row.disposition, nhlGameId: null, nhlGameScheduledStartsAtMs: null,
      })).sort((a, b) => a.playerId.localeCompare(b.playerId));
      const scope = { setId: evidenceId(command.refreshId, "set"), statSourceId: command.statSourceId, refreshId: command.refreshId,
        nhlSeasonKey: command.nhlSeasonKey, provider: command.provider, sourceVersion: command.sourceVersion, capturedAtMs: command.completedAtMs };
      await yieldToEventLoop();
      const coverageEvidence = createPlayerGameCoverageSetEvidence({ ...scope, requiredPlayers: command.requiredPlayers,
        coverage: command.playerGameCoverage.map(({ observedGameState, ...row }) => ({ ...row, coverageEntryId: evidenceId(command.refreshId, "coverage", coverageKey(row)) })) });
      await yieldToEventLoop();
      const observationEvidence = createPlayerGameObservationSetEvidence({ ...scope, observations: command.playerGameRows.map(row => {
        const playerId = identities.get(row.externalPlayerId);
        return { observationId: evidenceId(command.refreshId, "game", gameKey({ playerId, nhlGameId: row.nhlGameId })), playerId,
          nhlGameId: row.nhlGameId, nhlGameScheduledStartsAtMs: row.nhlGameScheduledStartsAtMs, observedGameState: row.observedGameState,
          goals: row.goals, assists: row.assists, nhlPoints: row.nhlPoints, fantasyPointsHundredths: row.fantasyPointsHundredths, sourceUpdatedAtMs: row.sourceUpdatedAtMs };
      }) });
      await yieldToEventLoop();
      const expandedHash = expandedSnapshotHash(expanded);
      await yieldToEventLoop();
      const result = projectEvidence({ ...command, observedAtMs: command.rows[0].sourceUpdatedAtMs }, totals,
        coverageEvidence.preimage.coverage, observationEvidence.preimage.observations, expanded, expandedHash);
      if (plans.size >= 4) plans.delete(plans.keys().next().value);
      plans.set(command.refreshId, { headId: head?.refresh_id ?? null, totals, changes, totalsHash: totalHash(totals),
        emptyJson: JSON.stringify(emptyCoverage), expandedHash, coverageEvidence, observationEvidence, expanded, result,
        totalIds: new Map(totals.map(row => [row.providerPlayerId, projectionId(command.statSourceId, command.nhlSeasonKey, row.playerId)])) });
    },
    evidence(command) {
      const plan = plans.get(command.refreshId);
      if (!plan) throw new Error("Prepared compact evidence is required.");
      return plan;
    },
    release(refreshId) { plans.delete(refreshId); },
    prime(refreshId) {
      const result = plans.get(refreshId)?.result;
      if (!result) throw new Error("Prepared scoring projection is unavailable.");
      saveCachedEvidence(database, refreshId, result);
    },
    persist(command, { coverageEvidence, observationEvidence }) {
      const plan = plans.get(command.refreshId);
      if (!plan || (findHead().get(command.statSourceId, command.nhlSeasonKey)?.refresh_id ?? null) !== plan.headId) throw new Error("Compact statistics preparation is stale.");
      const physical = database.prepare("SELECT * FROM player_stat_totals WHERE refresh_id=? ORDER BY player_id").all(command.refreshId);
      const expected = [...plan.totals].sort((a, b) => a.playerId.localeCompare(b.playerId));
      if (physical.length !== expected.length || physical.some((row, i) => row.player_id !== expected[i].playerId ||
          row.id !== projectionId(command.statSourceId, command.nhlSeasonKey, row.player_id) || row.goals !== expected[i].goals ||
          row.assists !== expected[i].assists || row.games_played !== expected[i].gamesPlayed)) throw new Error("Shared total identities changed before completion.");
      const capture = database.prepare("SELECT * FROM shared_game_evidence_captures WHERE refresh_id=? AND sealed=1").get(command.refreshId);
      if (!capture) throw new Error("Compact completion requires shared game evidence.");
      const insert = database.prepare(`INSERT INTO shared_stat_total_changes
        (id,stat_source_id,nhl_season_key,revision,player_id,payload_json,payload_sha256) VALUES (?,?,?,?,?,?,?)`);
      for (const row of plan.changes) if (insert.run(evidenceId(command.refreshId, "total-change", row.playerId), command.statSourceId, command.nhlSeasonKey, capture.revision, row.playerId, row.payload, row.hash).changes !== 1) throw new Error("Shared totals were not inserted.");
      const emptyHash = sha(plan.emptyJson);
      database.prepare("INSERT OR IGNORE INTO shared_empty_coverage_sets (sha256,payload_json) VALUES (?,?)").run(emptyHash, plan.emptyJson);
      if (database.prepare("SELECT payload_json FROM shared_empty_coverage_sets WHERE sha256=?").get(emptyHash)?.payload_json !== plan.emptyJson) throw new Error("Shared coverage was not stored intact.");
      const result = database.prepare(`INSERT INTO compact_stat_refreshes
        (refresh_id,format_version,total_count,totals_sha256,empty_coverage_sha256,
         required_player_count,coverage_entry_count,coverage_sha256,observation_sha256,expanded_sha256)
        VALUES (?,1,?,?,?,?,?,?,?,?)`).run(command.refreshId, plan.totals.length, plan.totalsHash, emptyHash,
          coverageEvidence.requiredPlayerCount, coverageEvidence.coverageEntryCount, coverageEvidence.coverageSha256,
          observationEvidence.evidenceSha256, plan.expandedHash);
      if (result.changes !== 1) throw new Error("Compact statistics were not sealed.");
    },
  });
}

function reconstructCompactStatistics(database, refreshId) {
  if (!available(database)) return null;
  const meta = database.prepare("SELECT m.*,e.payload_json AS empty_coverage_json FROM compact_stat_refreshes m LEFT JOIN shared_empty_coverage_sets e ON e.sha256=m.empty_coverage_sha256 WHERE m.refresh_id=?").get(refreshId);
  if (!meta) return null;
  const refresh = database.prepare("SELECT r.*,s.provider FROM stat_refreshes r JOIN stat_sources s ON s.id=r.stat_source_id WHERE r.id=?").get(refreshId);
  const capture = database.prepare("SELECT * FROM shared_game_evidence_captures WHERE refresh_id=?").get(refreshId);
  const root = database.prepare("SELECT * FROM stat_refresh_player_game_sets WHERE refresh_id=?").get(refreshId);
  const expandedRoot = database.prepare("SELECT * FROM expanded_stat_refreshes WHERE refresh_id=?").get(refreshId);
  if (!refresh || refresh.status !== "succeeded" || !root || !expandedRoot || meta.format_version !== 1 || !capture || capture.sealed !== 1 ||
      sha(meta.empty_coverage_json) !== meta.empty_coverage_sha256) throw new Error("Compact statistics have incomplete sealed evidence.");
  const shared = createSqliteSharedGameEvidenceRepository({ database }).read({ refreshId });
  const totals = effectiveTotals(database, capture);
  if (totals.length !== meta.total_count || totalHash(totals) !== meta.totals_sha256) throw new Error("Compact totals do not match their sealed capture.");
  const setId = evidenceId(refreshId, "set");
  const games = shared.records;
  const coverageInput = [...games.map(row => ({ playerId: row.playerId, providerPlayerId: row.providerPlayerId, providerTeamId: row.providerTeamId,
    disposition: "expected_game", nhlGameId: row.nhlGameId, nhlGameScheduledStartsAtMs: row.scheduledStartsAtMs })), ...JSON.parse(meta.empty_coverage_json)]
    .map(row => ({ ...row, coverageEntryId: evidenceId(refreshId, "coverage", coverageKey(row)) }));
  const observationsInput = games.map(row => ({ observationId: evidenceId(refreshId, "game", gameKey(row)), playerId: row.playerId,
    nhlGameId: row.nhlGameId, nhlGameScheduledStartsAtMs: row.scheduledStartsAtMs, observedGameState: row.gameState,
    goals: row.goals, assists: row.assists, nhlPoints: row.goals + row.assists, fantasyPointsHundredths: row.goals * 125 + row.assists * 100,
    sourceUpdatedAtMs: shared.observedAtMs }));
  const scope = { setId, statSourceId: refresh.stat_source_id, refreshId, nhlSeasonKey: refresh.nhl_season_key,
    provider: refresh.provider, sourceVersion: refresh.source_version, capturedAtMs: refresh.completed_at_ms };
  const requiredPlayers = [...new Map(coverageInput.map(row => [row.playerId, { playerId: row.playerId, providerPlayerId: row.providerPlayerId }])).values()];
  const coverage = createPlayerGameCoverageSetEvidence({ ...scope, requiredPlayers, coverage: coverageInput });
  const observations = createPlayerGameObservationSetEvidence({ ...scope, observations: observationsInput });
  if (root.id !== setId || coverage.coverageSha256 !== root.coverage_sha256 || observations.evidenceSha256 !== root.evidence_sha256 ||
      root.coverage_sha256 !== meta.coverage_sha256 || root.evidence_sha256 !== meta.observation_sha256 ||
      root.required_player_count !== requiredPlayers.length || root.coverage_entry_count !== coverageInput.length || root.observation_count !== games.length) throw new Error("Compact game evidence does not reconstruct its original seal.");
  const expanded = normalizeExpandedSnapshot({ scoringRuleVersion: EXPANDED_SCORING_VERSION,
    totalsRows: totals.map(row => ({ playerId: row.providerPlayerId, scoringStats: row.scoringStats })),
    playerGameRows: games.map(row => ({ playerId: row.providerPlayerId, nhlGameId: row.nhlGameId, gamesPlayed: row.gamesPlayed, scoringStats: row.scoringStats })),
  }, { nhlSeasonKey: refresh.nhl_season_key, totals: totals.map(row => ({ ...row, externalPlayerId: row.providerPlayerId })),
    observations: games.map(row => ({ ...row, externalPlayerId: row.providerPlayerId, observedGameState: row.gameState })) });
  if (expandedSnapshotHash(expanded) !== meta.expanded_sha256 || expandedRoot.evidence_sha256 !== meta.expanded_sha256 ||
      expandedRoot.total_count !== totals.length || expandedRoot.observation_count !== games.length) throw new Error("Compact expanded evidence does not match its seal.");
  return projectEvidence({ refreshId, statSourceId: refresh.stat_source_id, nhlSeasonKey: refresh.nhl_season_key,
    completedAtMs: refresh.completed_at_ms, observedAtMs: shared.observedAtMs }, totals,
    coverage.preimage.coverage, observations.preimage.observations, expanded, meta.expanded_sha256);
}

const readCaches = new WeakMap();
function saveCachedEvidence(database, refreshId, result) {
  let cache = readCaches.get(database);
  if (!cache) { cache = { values: new Map() }; readCaches.set(database, cache); }
  if (cache.values.size >= 2 && !cache.values.has(refreshId)) cache.values.delete(cache.values.keys().next().value);
  cache.values.set(refreshId, { stamp: cacheStamp(database, refreshId), result });
}
function cacheStamp(database, refreshId) {
  return `${database.pragma("data_version", { simple: true })}:${database.pragma("schema_version", { simple: true })}:${JSON.stringify(database.prepare(
    "SELECT r.*,s.provider,s.status AS source_status,s.version AS source_version_number FROM stat_refreshes r JOIN stat_sources s ON s.id=r.stat_source_id WHERE r.id=?"
  ).get(refreshId))}`;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function readCompactStatistics(database, refreshId) {
  if (!available(database)) return null;
  // Payloads and seals are immutable. Check parent/source state, external writes
  // and schema changes (including removal of an immutability trigger). Unrelated
  // writes on this connection cannot change sealed evidence or invalidate it.
  const stamp = cacheStamp(database, refreshId);
  let cache = readCaches.get(database);
  if (!cache) {
    cache = { values: new Map() }; readCaches.set(database, cache);
  }
  if (cache.values.get(refreshId)?.stamp === stamp) return cache.values.get(refreshId).result;
  const result = deepFreeze(reconstructCompactStatistics(database, refreshId));
  if (cache.values.size >= 2) cache.values.delete(cache.values.keys().next().value);
  cache.values.set(refreshId, { stamp, result });
  return result;
}

function materializeCompactExclusions(database, refreshId, observationIds) {
  const evidence = readCompactStatistics(database, refreshId);
  if (!evidence) return;
  if (!database.inTransaction) throw new Error("Baseline evidence materialization requires the lock transaction.");
  const observations = new Map(evidence.observations.map(row => [row.id, row]));
  const coverage = new Map(evidence.coverage.filter(row => row.disposition === "expected_game").map(row => [`${row.player_id}\u0000${row.nhl_game_id}`, row]));
  for (const id of observationIds) {
    const row = observations.get(id);
    if (!row) throw new Error("The compact baseline observation is unavailable.");
    for (const [table, value] of [["stat_refresh_player_game_coverage_entries", coverage.get(`${row.player_id}\u0000${row.nhl_game_id}`)], ["player_game_stat_observations", row]]) {
      if (!value) throw new Error("The compact baseline coverage is unavailable.");
      const old = database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(value.id);
      if (old) {
        if (Object.keys(value).some(key => old[key] !== value[key])) throw new Error("Existing compact baseline evidence changed.");
      } else {
        const columns = Object.keys(value);
        if (database.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(key => `@${key}`).join(",")})`).run(value).changes !== 1) throw new Error("Compact baseline evidence was not materialized.");
      }
    }
  }
}

function pruneCompactTotalProjections(database) {
  if (!available(database)) return 0;
  return database.transaction(() => {
    const old = database.prepare(`SELECT m.refresh_id FROM compact_stat_refreshes m JOIN stat_refreshes r ON r.id=m.refresh_id
      WHERE EXISTS (SELECT 1 FROM player_stat_totals p WHERE p.refresh_id=r.id)
      AND EXISTS (SELECT 1 FROM stat_refreshes n JOIN compact_stat_refreshes c ON c.refresh_id=n.id
        WHERE n.stat_source_id=r.stat_source_id AND n.nhl_season_key=r.nhl_season_key AND n.status='succeeded' AND n.completed_at_ms>r.completed_at_ms)
      ORDER BY r.completed_at_ms LIMIT 2`).all();
    for (const row of old) {
      // Validate reconstruction before deleting either expendable SQL projection.
      readCompactStatistics(database, row.refresh_id);
      database.prepare("DELETE FROM expanded_stat_totals WHERE refresh_id=?").run(row.refresh_id);
      database.prepare("DELETE FROM player_stat_totals WHERE refresh_id=?").run(row.refresh_id);
    }
    return old.length;
  }).immediate();
}

module.exports = { evidenceId, coverageKey, gameKey, createCompactStatisticsStorage, readCompactStatistics, materializeCompactExclusions, pruneCompactTotalProjections };
