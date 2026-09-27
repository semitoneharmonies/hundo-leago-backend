const { CANONICAL_UUID_PATTERN } = require('../../../domain/players/playerIdentityPolicy');
const { mapRepositoryError } = require('./SqliteRepositoryError');

// Saved public transactions only. Candidate offers, bids, and pending trades are
// deliberately not inputs to this projection. Opening a card performs no writes.
function createSqlitePlayerCardRepository({ database }) {
  const signings = database.prepare(`SELECT c.id, c.status, c.contract_type,
      c.acquisition_source_type, c.created_at_ms, s.label AS season_label,
      e.occurred_at_ms, e.metadata_json, e.source_type,
      t.id AS signing_team_id, t.name AS signing_team_name,
      ac.source_kind AS auction_source_kind
    FROM contracts c
    JOIN seasons s ON s.league_id = c.league_id AND s.id = c.start_season_id
    LEFT JOIN contract_events e ON e.league_id = c.league_id AND e.contract_id = c.id
      AND e.id = (SELECT first.id FROM contract_events first
        WHERE first.league_id = c.league_id AND first.contract_id = c.id
          AND first.event_type IN ('contract_created', 'fantasy_elc_created')
        ORDER BY first.occurred_at_ms, first.id LIMIT 1)
    LEFT JOIN teams t ON t.league_id = e.league_id AND t.id = e.team_id
    LEFT JOIN auction_resolutions ar ON ar.league_id = c.league_id
      AND ar.id = c.acquisition_source_id AND c.acquisition_source_type = 'auction_resolution'
      AND ar.contract_id = c.id AND ar.status IN ('resolved', 'recovered')
    LEFT JOIN auction_contexts ac ON ac.league_id = ar.league_id AND ac.auction_id = ar.auction_id
    WHERE c.league_id = @leagueId AND c.player_id = @playerId
    ORDER BY COALESCE(e.occurred_at_ms, c.created_at_ms) DESC, c.id`);
  const cap = database.prepare(`SELECT c.contract_type,
      COALESCE((SELECT SUM(y.retained_aav_cents) FROM retention_obligations r
        JOIN retention_years y ON y.league_id = r.league_id AND y.retention_obligation_id = r.id
          AND y.season_id = l.current_season_id AND y.status = 'current'
        WHERE r.league_id = c.league_id AND r.contract_id = c.id AND r.status = 'active'), 0) AS retained_aav_cents
    FROM contracts c JOIN leagues l ON l.id = c.league_id
    WHERE c.league_id = @leagueId AND c.player_id = @playerId AND c.status = 'active'`);
  const trades = database.prepare(`SELECT t.id FROM trades t
    WHERE t.league_id = @leagueId AND t.completed_at_ms IS NOT NULL
      AND EXISTS (SELECT 1 FROM trade_assets a
        LEFT JOIN contracts c ON c.league_id = a.league_id AND c.id = a.contract_id
        LEFT JOIN retention_obligations r ON r.league_id = a.league_id AND r.id = a.retention_obligation_id
        LEFT JOIN buyout_obligations b ON b.league_id = a.league_id AND b.id = a.buyout_obligation_id
        WHERE a.league_id = t.league_id AND a.trade_id = t.id
          AND (a.player_id = @playerId OR c.player_id = @playerId
            OR r.player_id = @playerId OR b.player_id = @playerId))
    ORDER BY t.completed_at_ms DESC, t.id`);
  const teams = database.prepare('SELECT id, name, primary_colour, secondary_colour, tertiary_colour, pattern_template FROM teams WHERE league_id = ?');
  const seasons = database.prepare('SELECT id, label FROM seasons WHERE league_id = ?');
  return Object.freeze({
    read({ leagueId, playerId }) {
      if (!CANONICAL_UUID_PATTERN.test(leagueId) || !CANONICAL_UUID_PATTERN.test(playerId)) {
        throw new TypeError('Player cards require canonical league and player identifiers.');
      }
      try {
        const input = { leagueId, playerId };
        return { signings: signings.all(input), cap: cap.get(input) || null, tradeIds: trades.all(input).map(row => row.id), teams: teams.all(leagueId), seasons: seasons.all(leagueId) };
      } catch (error) {
        throw mapRepositoryError(error, { operation: 'readPlayerCard', tableName: 'contracts' });
      }
    },
  });
}
module.exports = { createSqlitePlayerCardRepository };
