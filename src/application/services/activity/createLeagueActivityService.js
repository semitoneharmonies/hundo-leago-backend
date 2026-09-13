const {
  encodeCursor,
  validateActivityPageInput,
} = require("../../../domain/activity/activityPolicy");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`league activity requires ${description}`);
  }
}

function parseMetadata(value) {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("league activity requires object metadata");
  }
  return Object.freeze(parsed);
}

function projectRow(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    type: row.event_type,
    actor: Object.freeze({
      userId: row.actor_user_id,
      authority: row.actor_authority,
      displayName: row.actor_display_name,
    }),
    teamId: row.team_id,
    playerId: row.player_id,
    team: row.team_id
      ? Object.freeze({ id: row.team_id, name: row.team_name })
      : null,
    player: row.player_id
      ? Object.freeze({ id: row.player_id, name: row.player_full_name })
      : null,
    related: row.related_type
      ? Object.freeze({ type: row.related_type, id: row.related_id })
      : null,
    summary: row.display_summary,
    reason: row.reason,
    metadata: parseMetadata(row.metadata_json),
    occurredAtMs: row.occurred_at_ms,
  });
}

function createLeagueActivityService({
  leagueAuthorization,
  repository,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveMembership",
    "league-member authorization"
  );
  assertMethod(repository, "listPage", "a league-activity repository");

  function list({ leagueId, query, authenticated } = {}) {
    const authority = leagueAuthorization.requireActiveMembership(
      authenticated,
      leagueId
    );
    const page = validateActivityPageInput(query || {});
    const result = repository.listPage({
      leagueId: authority.leagueId,
      limit: page.limit,
      cursor: page.cursor,
      category: page.category,
    });
    const activity = Object.freeze(result.rows.map(projectRow));
    const last = result.rows.at(-1);
    return Object.freeze({
      code: "LEAGUE_ACTIVITY_FOUND",
      activity,
      page: Object.freeze({
        limit: page.limit,
        nextCursor:
          result.hasMore && last
            ? encodeCursor({ occurredAtMs: last.occurred_at_ms, id: last.id })
            : null,
      }),
    });
  }

  return Object.freeze({ list });
}

module.exports = { createLeagueActivityService };
