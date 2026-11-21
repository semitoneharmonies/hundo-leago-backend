const crypto = require("node:crypto");
const { fail, exact, validateMessage, digest, clientKey } = require("../../../domain/leagues/leagueCommunicationPolicy");

const OPERATION = "platform.announcement.publish.v1";

function broadcastId(actorUserId, key) {
  const hex = digest({ operation: OPERATION, actorUserId, key });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function createPlatformAnnouncementService({ repository, platformAuthorization, leagueAuthorization,
  auditRepository, clock, createId = crypto.randomUUID } = {}) {
  function now() {
    const value = clock.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("A safe clock is required.");
    return value;
  }
  function messageInput(input) {
    const message = validateMessage(input);
    if (message.kind !== "announcement" || message.audience !== "members") fail();
    return message;
  }
  function authorizeLeague(authenticated, leagueId) {
    const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
    // Platform administrators must retain the protected canonical membership.
    if (authority.permissionCategory !== "member") fail("LEAGUE_NOT_FOUND");
    return authority;
  }
  function targets(authenticated) {
    const authority = platformAuthorization.requireAdministrator(authenticated);
    if (!repository) fail("COMMUNICATION_UNAVAILABLE");
    const leagues = repository.targets().map(league => ({ ...league,
      authority: authorizeLeague(authenticated, league.leagueId) }));
    return { authority, leagues };
  }
  function previewResult(message, target, nowMs) {
    if (!target.leagues.length) fail("COMMUNICATION_NO_RECIPIENTS");
    if (message.expiresAtMs !== null && message.expiresAtMs <= nowMs) fail();
    const deliveries = target.leagues.map(league => ({ ...league,
      recipients: message.notify ? repository.recipients(league.leagueId, "members", nowMs) : [] }));
    const recipients = [...new Map(deliveries.flatMap(league => league.recipients)
      .map(recipient => [recipient.userId, recipient])).values()].sort((a, b) => a.userId.localeCompare(b.userId));
    const leagues = deliveries.map(league => ({ leagueId: league.leagueId, leagueName: league.leagueName,
      recipientCount: league.recipients.length }));
    const previewHash = digest({ operation: OPERATION, actorUserId: target.authority.actorUserId,
      roleVersion: target.authority.roleVersion, message, deliveries });
    return { public: { scope: "all_leagues", message, leagues, recipients,
      recipientCount: leagues.reduce((sum, league) => sum + league.recipientCount, 0),
      uniqueRecipientCount: recipients.length, previewHash }, deliveries };
  }
  function preview({ authenticated, input }) {
    const target = targets(authenticated);
    return previewResult(messageInput(input), target, now()).public;
  }
  function publish({ authenticated, input, idempotencyKey, requestCorrelationId = null }) {
    platformAuthorization.requireAdministrator(authenticated);
    if (!repository) fail("COMMUNICATION_UNAVAILABLE");
    exact(input, ["message", "previewHash"]);
    const message = messageInput(input.message);
    const key = clientKey(idempotencyKey);
    if (typeof input.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(input.previewHash)) fail();
    const requestHash = digest({ message, previewHash: input.previewHash });
    return repository.transaction(() => {
      const target = targets(authenticated);
      const actorUserId = target.authority.actorUserId;
      const id = broadcastId(actorUserId, key);
      const previous = repository.replay(actorUserId, OPERATION, key);
      const receipt = repository.receipt(id, actorUserId);
      if (previous && (previous.request_hash !== requestHash || previous.result_id !== id)) fail("COMMUNICATION_KEY_CONFLICT");
      if (previous && (previous.status !== "completed" || previous.result_type !== "platform_announcement")) fail("COMMUNICATION_FAILED");
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail("COMMUNICATION_KEY_CONFLICT");
        if (receipt.result?.scope !== "all_leagues" || receipt.result.id !== id ||
            !Array.isArray(receipt.result.leagues) || !receipt.result.leagues.length) fail("COMMUNICATION_FAILED");
        for (const league of receipt.result.leagues) authorizeLeague(authenticated, league.leagueId);
        return { ...receipt.result, replayed: true };
      }
      if (previous) fail("COMMUNICATION_FAILED");
      const nowMs = now();
      const checked = previewResult(message, target, nowMs);
      if (checked.public.previewHash !== input.previewHash) fail("COMMUNICATION_PREVIEW_CHANGED");
      const published = [];
      for (const league of checked.deliveries) {
        const communicationId = createId();
        repository.insert({ ...message, id: communicationId, leagueId: league.leagueId, actorUserId,
          clientKey: `platform:${id}`, requestHash, nowMs, recipientCount: league.recipients.length });
        for (const recipient of league.recipients) {
          repository.notify({ id: createId(), userId: recipient.userId, leagueId: league.leagueId,
            eventType: "league_announcement", messageDataJson: JSON.stringify({ title: message.title,
              message: message.body, leagueId: league.leagueId, communicationId }),
            relatedFeature: "league_communication", relatedRecordId: communicationId,
            deliveryStatus: "delivered", createdAtMs: nowMs, deliveredAtMs: nowMs,
            deduplicationKey: `league-communication:${communicationId}:${recipient.userId}` });
        }
        auditRepository.append({ id: createId(), event_type: "platform.announcement_posted", outcome: "success",
          actor_user_id: actorUserId, target_user_id: null, league_id: league.leagueId,
          session_id: authenticated.session.id, request_correlation_id: requestCorrelationId || id,
          reason_code: null, network_key_version: null, network_metadata_digest: null,
          client_metadata_json: JSON.stringify({ actorAuthority: "platform_administrator_as_commissioner" }),
          unknown_account_digest: null, occurred_at_ms: nowMs });
        published.push({ leagueId: league.leagueId, leagueName: league.leagueName,
          id: communicationId, recipientCount: league.recipients.length });
      }
      const result = { scope: "all_leagues", id, leagues: published,
        recipientCount: checked.public.recipientCount, uniqueRecipientCount: checked.public.uniqueRecipientCount,
        replayed: false };
      repository.saveReceipt({ id, actorUserId, requestHash, result, nowMs });
      repository.saveIdempotency({ id: createId(), league_id: null, actor_user_id: actorUserId,
        operation: OPERATION, client_key: key, request_hash: requestHash, status: "completed",
        result_type: "platform_announcement", result_id: id, created_at_ms: nowMs, completed_at_ms: nowMs,
        expires_at_ms: nowMs + 24 * 60 * 60 * 1000 });
      return result;
    });
  }
  return Object.freeze({ preview, publish });
}

module.exports = { OPERATION, broadcastId, createPlatformAnnouncementService };
