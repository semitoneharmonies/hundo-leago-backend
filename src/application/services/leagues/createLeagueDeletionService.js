const crypto = require("node:crypto");
const { validateIdempotencyKey } = require("../../../domain/leagues/leagueCreationPolicy");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function createLeagueDeletionService({
  repositoryContext, repository, platformAuthorization, auditRepository, clock, secureRandom,
} = {}) {
  function transaction(callback) {
    try { return repositoryContext.transaction(callback); }
    catch (error) {
      if (error.cause?.code && !error.cause.code.startsWith("SQLITE_")) throw error.cause;
      throw error;
    }
  }

  function authority(authenticated, leagueId) {
    const result = platformAuthorization.requireAdministrator(authenticated);
    if (typeof leagueId !== "string" || !UUID.test(leagueId)) fail("LEAGUE_DELETION_INVALID");
    return result;
  }

  function requireLeague(leagueId, actorUserId) {
    if (!repository.findLeague(leagueId)) fail("LEAGUE_NOT_FOUND");
    if (!repository.hasMembership(leagueId, actorUserId)) fail("PLATFORM_ADMINISTRATOR_REQUIRED");
  }

  function preview({ authenticated, leagueId }) {
    return transaction(() => {
      const { actorUserId } = authority(authenticated, leagueId);
      requireLeague(leagueId, actorUserId);
      return { code: "LEAGUE_DELETION_PREVIEW", ...repository.snapshot(leagueId) };
    });
  }

  function remove({ authenticated, leagueId, input, idempotencyKey, auditContext = {} }) {
    return transaction(() => {
      const { actorUserId } = authority(authenticated, leagueId);
      if (!input || Array.isArray(input) || Object.keys(input).length !== 3 ||
          input.confirmed !== true || typeof input.leagueName !== "string" ||
          typeof input.previewHash !== "string" || !/^[0-9a-f]{64}$/.test(input.previewHash)) {
        fail("LEAGUE_DELETION_INVALID");
      }
      let clientKey;
      try { clientKey = validateIdempotencyKey(idempotencyKey); }
      catch { fail("LEAGUE_DELETION_INVALID"); }
      const requestHash = crypto.createHash("sha256")
        .update(JSON.stringify({ leagueId, leagueName: input.leagueName, previewHash: input.previewHash }))
        .digest("hex");
      const receipt = repository.findReceipt(actorUserId, clientKey);
      if (receipt) {
        if (receipt.request_hash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED");
        if (receipt.status !== "completed") fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
        return repository.readResult(receipt.result_id);
      }
      requireLeague(leagueId, actorUserId);
      const snapshot = repository.snapshot(leagueId);
      if (input.leagueName !== snapshot.league.name || input.previewHash !== snapshot.previewHash) {
        fail("LEAGUE_DELETION_PREVIEW_CHANGED");
      }
      if (repository.hasRunningJobs(leagueId)) fail("LEAGUE_DELETION_BUSY");
      const nowMs = clock.nowMs();
      const result = {
        code: "LEAGUE_DELETED", league: snapshot.league,
        deletedRecords: snapshot.totalRecords,
      };
      const eventId = secureRandom.id();
      // Platform-level evidence has no FK to the league being erased. A failure
      // to record it rolls back the entire deletion and its trigger changes.
      repositoryContext.repositories.operational_events.insert({
        id: eventId, league_id: null, season_id: null,
        event_type: "platform_administration.league_deleted", feature: "league_administration",
        outcome: "success", actor_user_id: actorUserId, reason_code: "ADMINISTRATOR_CONFIRMED",
        details_json: JSON.stringify({ result, previewHash: snapshot.previewHash,
          counts: snapshot.counts, retainedCounts: snapshot.retainedCounts,
          retainedEvidence: repository.retainedEvidence(leagueId) }), occurred_at_ms: nowMs,
      });
      auditRepository.append({
        id: secureRandom.id(), event_type: "platform_administration.league_deleted",
        outcome: "success", actor_user_id: actorUserId, target_user_id: null, league_id: null,
        session_id: authenticated.session.id,
        request_correlation_id: auditContext.requestCorrelationId || null,
        reason_code: `league_deleted:${leagueId}`,
        network_key_version: auditContext.networkKeyVersion || null,
        network_metadata_digest: auditContext.networkMetadataDigest || null,
        client_metadata_json: auditContext.clientMetadataJson || null,
        unknown_account_digest: null, occurred_at_ms: nowMs,
      });
      repository.erase(leagueId);
      repositoryContext.repositories.idempotency_requests.insert({
        id: secureRandom.id(), league_id: null, actor_user_id: actorUserId,
        operation: "admin.league.delete.v1", client_key: clientKey, request_hash: requestHash,
        status: "completed", result_type: "league_deletion", result_id: eventId,
        created_at_ms: nowMs, completed_at_ms: nowMs, expires_at_ms: nowMs + 86400000,
      });
      return result;
    });
  }
  return Object.freeze({ preview, remove });
}

module.exports = { createLeagueDeletionService };
