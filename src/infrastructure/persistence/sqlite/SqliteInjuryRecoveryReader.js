const { setImmediate: yieldToEventLoop } = require('node:timers/promises');
const { prepareGameRecord, stableId, timestamp } = require('../../../domain/statistics/sharedGameEvidencePolicy');
const { assertNhlSeasonKey } = require('../../../domain/statistics/statisticsPolicy');

const MAX_CANDIDATES = 2000;
const MAX_GAMES = 128;
const DEFAULT_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const ACTIVE_SOURCES = "SELECT id FROM stat_sources WHERE provider='nhl-completed-games' AND status='active' ORDER BY id LIMIT 2";
const CAPTURE = `SELECT c.*,r.completed_at_ms FROM shared_game_evidence_captures c
  JOIN stat_refreshes r ON r.id=c.refresh_id AND r.stat_source_id=c.stat_source_id AND r.nhl_season_key=c.nhl_season_key
  WHERE c.stat_source_id=@statSourceId AND c.nhl_season_key=@nhlSeasonKey AND c.sealed=1 AND r.status='succeeded'
  ORDER BY c.revision DESC LIMIT 1`;
// Select revisions before filtering tombstones. A removed appearance must never
// fall back to an older positive record. Only one candidate's payloads are read.
const GAMES = `WITH latest AS (
  SELECT nhl_game_id,MAX(revision) revision FROM shared_game_evidence_changes
  WHERE stat_source_id=@statSourceId AND nhl_season_key=@nhlSeasonKey AND player_id=@playerId AND revision<=@revision
  GROUP BY nhl_game_id
) SELECT g.player_id,g.nhl_game_id,g.revision,g.payload_sha256,
  CASE WHEN length(g.payload_json)<=16384 THEN g.payload_json ELSE NULL END payload_json,
  origin.sealed AS origin_sealed,origin.observed_at_ms AS origin_observed_at_ms,
  origin.captured_at_ms AS origin_captured_at_ms,r.status AS origin_status,r.completed_at_ms AS origin_completed_at_ms
  FROM latest JOIN shared_game_evidence_changes g ON g.nhl_game_id=latest.nhl_game_id AND g.revision=latest.revision
  LEFT JOIN shared_game_evidence_captures origin ON origin.stat_source_id=g.stat_source_id
    AND origin.nhl_season_key=g.nhl_season_key AND origin.revision=g.revision
  LEFT JOIN stat_refreshes r ON r.id=origin.refresh_id AND r.stat_source_id=origin.stat_source_id
    AND r.nhl_season_key=origin.nhl_season_key
  WHERE g.stat_source_id=@statSourceId AND g.nhl_season_key=@nhlSeasonKey AND g.player_id=@playerId
    AND g.payload_json IS NOT NULL ORDER BY g.nhl_game_id LIMIT 129`;

function validTimes(observed, captured, completed, nowMs) {
  return [observed, captured, completed].every(value => Number.isSafeInteger(value) && value >= 0 && value <= nowMs)
    && observed <= captured && captured <= completed;
}

function createSqliteInjuryRecoveryReader({ database, nhlSeasonKey, maxCaptureAgeMs = DEFAULT_MAX_AGE_MS }) {
  const season = assertNhlSeasonKey(nhlSeasonKey);
  if (!database || typeof database.prepare !== 'function' || !Number.isSafeInteger(maxCaptureAgeMs) || maxCaptureAgeMs <= 0) {
    throw new TypeError('Valid injury recovery evidence configuration is required.');
  }
  return Object.freeze({ async read({ candidates, nowMs } = {}) {
    const warnings = [];
    const result = {};
    // Keep the requested player-ID dictionary contract while exposing sanitized
    // diagnostics to the scheduled job. No raw database errors leave this reader.
    Object.defineProperty(result, 'warnings', { value: warnings, enumerable: false });
    const warn = (code, playerId) => warnings.push(playerId ? { code, playerId } : { code });
    let requested;
    try {
      timestamp(nowMs);
      if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES || database.inTransaction) throw new Error();
      const seen = new Set();
      requested = candidates.map(candidate => {
        const playerId = stableId(candidate?.playerId), nhlPlayerId = candidate?.nhlPlayerId;
        const afterMs = timestamp(candidate?.afterMs);
        if (typeof nhlPlayerId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(nhlPlayerId) || afterMs > nowMs || seen.has(playerId)) throw new Error();
        seen.add(playerId);
        return { playerId, nhlPlayerId, afterMs };
      });
    } catch { warn('INJURY_RECOVERY_INPUT_INVALID'); return result; }
    if (!requested.length) return result;
    try {
      const sourcesQuery = database.prepare(ACTIVE_SOURCES);
      const sources = sourcesQuery.all();
      if (sources.length !== 1) { warn('INJURY_RECOVERY_SOURCE_AMBIGUOUS'); return result; }
      const statSourceId = stableId(sources[0].id);
      const capture = database.prepare(CAPTURE).get({ statSourceId, nhlSeasonKey: season });
      if (!capture || !Number.isSafeInteger(capture.revision) || capture.revision < 1 ||
          !validTimes(capture.observed_at_ms, capture.captured_at_ms, capture.completed_at_ms, nowMs) ||
          nowMs - capture.observed_at_ms > maxCaptureAgeMs) {
        warn('INJURY_RECOVERY_CAPTURE_UNAVAILABLE'); return result;
      }
      stableId(capture.refresh_id);
      const games = database.prepare(GAMES);
      for (let index = 0; index < requested.length; index++) {
        const candidate = requested[index];
        try {
          const rows = games.all({ statSourceId, nhlSeasonKey: season, playerId: candidate.playerId, revision: capture.revision });
          if (rows.length > MAX_GAMES) throw new Error();
          let latest = null;
          for (const row of rows) {
            if (row.origin_sealed !== 1 || row.origin_status !== 'succeeded' ||
                !validTimes(row.origin_observed_at_ms, row.origin_captured_at_ms, row.origin_completed_at_ms, nowMs) ||
                row.origin_observed_at_ms > capture.observed_at_ms || typeof row.payload_json !== 'string') throw new Error();
            const entry = prepareGameRecord(JSON.parse(row.payload_json)), record = entry.record;
            if (entry.payload !== row.payload_json || entry.sha256 !== row.payload_sha256 || record.playerId !== row.player_id ||
                record.playerId !== candidate.playerId || record.nhlGameId !== row.nhl_game_id || record.providerPlayerId !== candidate.nhlPlayerId ||
                (record.gameState === 'final' && record.scheduledStartsAtMs > capture.observed_at_ms)) throw new Error();
            if (record.gameState === 'final' && record.gamesPlayed === 1 && record.scheduledStartsAtMs > candidate.afterMs &&
                record.scheduledStartsAtMs <= nowMs && (!latest || record.scheduledStartsAtMs > latest.scheduledStartsAtMs)) latest = record;
          }
          if (latest) result[candidate.playerId] = Object.freeze({ source: 'nhl', trusted: true, final: true, participated: true,
            playerId: candidate.playerId, nhlPlayerId: candidate.nhlPlayerId, gameId: latest.nhlGameId,
            occurredAtMs: latest.scheduledStartsAtMs, observedAtMs: capture.observed_at_ms,
            refreshId: capture.refresh_id, revision: capture.revision });
        } catch { warn('INJURY_RECOVERY_CANDIDATE_UNVERIFIED', candidate.playerId); }
        if ((index + 1) % 16 === 0) await yieldToEventLoop();
      }
      const currentSources = sourcesQuery.all();
      if (currentSources.length !== 1 || currentSources[0].id !== statSourceId) {
        for (const key of Object.keys(result)) delete result[key];
        warn('INJURY_RECOVERY_SOURCE_CHANGED');
      }
    } catch {
      for (const key of Object.keys(result)) delete result[key];
      warn('INJURY_RECOVERY_EVIDENCE_UNAVAILABLE');
    }
    return result;
  } });
}

module.exports = { createSqliteInjuryRecoveryReader };
