const crypto = require("node:crypto");
const { validatePageInput, encodeCursor } = require("../../../domain/activity/activityPolicy");
const { validateIdempotencyKey } = require("../../../domain/leagues/teamPolicy");

const OPERATION = "league.announcement.post.v1";
function fail(code) { const error = new Error("The league announcement request could not be completed."); error.code = code; throw error; }
function announcement(row) {
  if (!row) fail("ANNOUNCEMENT_RESULT_UNAVAILABLE");
  const metadata = JSON.parse(row.metadata_json);
  return Object.freeze({ id: row.id, leagueId: row.league_id, body: metadata.body, authorName: row.author_name || "Commissioner", createdAtMs: row.occurred_at_ms });
}

function createLeagueAnnouncementService({ repositoryContext, repository, leagueAuthorization, auditRepository, clock, secureRandom } = {}) {
  function list({ leagueId, query, authenticated } = {}) {
    const authority = leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    if (!repository) fail("ANNOUNCEMENT_UNAVAILABLE");
    const page = validatePageInput(query || {});
    const result = repository.listPage({ leagueId: authority.leagueId, nowMs: clock.nowMs(), ...page });
    const last = result.rows.at(-1);
    return { code: "LEAGUE_ANNOUNCEMENTS_FOUND", announcements: result.rows.map(announcement),
      page: { limit: page.limit, nextCursor: result.hasMore && last ? encodeCursor({ id: last.id, occurredAtMs: last.occurred_at_ms }) : null } };
  }

  function post({ leagueId, input, authenticated, idempotencyKey, requestCorrelationId = null } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.body !== "string") fail("ANNOUNCEMENT_INPUT_INVALID");
    const body = input.body.replace(/\r\n?/g, "\n").trim();
    // Plain text only; line breaks and tabs are intentional, other controls are not.
    if (!body || body.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body)) fail("ANNOUNCEMENT_INPUT_INVALID");
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = crypto.createHash("sha256").update(JSON.stringify({ operation: OPERATION, leagueId, body })).digest("hex");
    try {
      return repositoryContext.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
        if (!repository) fail("ANNOUNCEMENT_UNAVAILABLE");
        const previous = repository.findIdempotency({ leagueId: authority.leagueId, actorUserId: authority.actorUserId, operation: OPERATION, clientKey });
        if (previous) {
          if (previous.request_hash !== digest) fail("IDEMPOTENCY_KEY_REUSED");
          if (previous.status !== "completed" || previous.result_type !== "league_announcement") fail("ANNOUNCEMENT_RESULT_UNAVAILABLE");
          return { code: "LEAGUE_ANNOUNCEMENT_POSTED", announcement: announcement(repository.find({ leagueId: authority.leagueId, id: previous.result_id })) };
        }
        const nowMs = clock.nowMs();
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("A valid clock is required.");
        const id = secureRandom.id();
        repository.append({
          id, league_id: authority.leagueId, season_id: null, event_type: "league_announcement_posted",
          actor_user_id: authority.actorUserId, actor_authority: authority.authority, team_id: null, player_id: null,
          related_type: "league_announcement", related_id: id, display_summary: "A league announcement was posted.",
          reason: null, metadata_json: JSON.stringify({ schemaVersion: 1, body }), occurred_at_ms: nowMs,
        });
        auditRepository.append({
          id: secureRandom.id(), event_type: "league.announcement_posted", outcome: "success",
          actor_user_id: authority.actorUserId, target_user_id: null, league_id: authority.leagueId,
          session_id: authenticated.session.id, request_correlation_id: requestCorrelationId,
          reason_code: null, network_key_version: null, network_metadata_digest: null,
          client_metadata_json: JSON.stringify({ actorAuthority: authority.authority }), unknown_account_digest: null, occurred_at_ms: nowMs,
        });
        repository.saveIdempotency({
          id: secureRandom.id(), league_id: authority.leagueId, actor_user_id: authority.actorUserId,
          operation: OPERATION, client_key: clientKey, request_hash: digest, status: "completed",
          result_type: "league_announcement", result_id: id, created_at_ms: nowMs, completed_at_ms: nowMs,
          expires_at_ms: nowMs + 24 * 60 * 60 * 1000,
        });
        return { code: "LEAGUE_ANNOUNCEMENT_POSTED", announcement: announcement(repository.find({ leagueId: authority.leagueId, id })) };
      });
    } catch (error) {
      const domain = [error, error?.cause].find((item) => ["ANNOUNCEMENT_UNAVAILABLE", "LEAGUE_ID_INVALID", "LEAGUE_NOT_FOUND", "LEAGUE_COMMISSIONER_REQUIRED", "IDEMPOTENCY_KEY_REUSED", "ANNOUNCEMENT_RESULT_UNAVAILABLE"].includes(item?.code));
      throw domain || error;
    }
  }
  return Object.freeze({ list, post });
}

module.exports = { createLeagueAnnouncementService };
