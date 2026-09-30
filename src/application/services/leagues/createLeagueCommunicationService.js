const crypto = require("node:crypto");
const { fail, exact, validateMessage, digest, clientKey } = require("../../../domain/leagues/leagueCommunicationPolicy");

function publicMessage(row) {
  return { id: row.id, leagueId: row.league_id, kind: row.kind, title: row.title, body: row.body,
    pinned: Boolean(row.pinned), expiresAtMs: row.expires_at_ms, createdAtMs: row.created_at_ms,
    authorName: row.authorName || null, archivedAtMs: row.archived_at_ms, version: row.version };
}

function createLeagueCommunicationService({ repository, leagueAuthorization, clock, createId = crypto.randomUUID } = {}) {
  function now() {
    const value = clock.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("A safe clock is required");
    return value;
  }
  function available() { if (!repository) fail("COMMUNICATION_UNAVAILABLE"); }
  function liveMessage(input, nowMs) {
    const message = validateMessage(input);
    if (message.expiresAtMs !== null && message.expiresAtMs <= nowMs) fail();
    return message;
  }
  function previewResult(leagueId, authority, input, nowMs) {
    const message = liveMessage(input, nowMs);
    const recipients = message.notify ? repository.recipients(leagueId, message.audience, nowMs) : [];
    if (message.kind === "reminder" && !recipients.length) fail("COMMUNICATION_NO_RECIPIENTS");
    return { leagueId, message, recipients,
      previewHash: digest({ leagueId, actorUserId: authority.actorUserId, message, recipients }),
      recipientCount: recipients.length };
  }

  return {
    list({ leagueId, authenticated, history = false }) {
      (history ? leagueAuthorization.requireCommissioner : leagueAuthorization.requireActiveMembership)(authenticated, leagueId);
      available();
      const messages = repository.list(leagueId, history, now()).map(row => history
        ? { ...publicMessage(row), audience: row.audience, recipientCount: row.recipient_count,
          createdByUserId: row.created_by_user_id, archivedByUserId: row.archived_by_user_id }
        : publicMessage(row));
      return { leagueId, messages };
    },
    readiness({ leagueId, authenticated }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      available();
      const cards = repository.cardProgress(leagueId);
      return { leagueId, cards, total: cards.length, complete: cards.filter(c => c.status === "complete").length,
        empty: cards.filter(c => c.status === "empty").length };
    },
    preview({ leagueId, authenticated, input }) {
      const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
      available();
      return previewResult(leagueId, authority, input, now());
    },
    publish({ leagueId, authenticated, input, idempotencyKey }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      available();
      exact(input, ["message", "previewHash"]);
      const message = validateMessage(input.message);
      const key = clientKey(idempotencyKey);
      if (typeof input.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(input.previewHash)) fail();
      return repository.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
        const requestHash = digest(message);
        const prior = repository.replay(leagueId, authority.actorUserId, key);
        if (prior) {
          if (prior.request_hash !== requestHash) fail("COMMUNICATION_KEY_CONFLICT");
          return { leagueId, id: prior.id, recipientCount: prior.recipient_count, replayed: true };
        }
        const nowMs = now();
        const preview = previewResult(leagueId, authority, message, nowMs);
        if (preview.previewHash !== input.previewHash) fail("COMMUNICATION_PREVIEW_CHANGED");
        const id = createId();
        repository.insert({ ...message, id, leagueId, actorUserId: authority.actorUserId,
          clientKey: key, requestHash, nowMs, recipientCount: preview.recipientCount });
        for (const recipient of preview.recipients) {
          repository.notify({ id: createId(), userId: recipient.userId, leagueId,
            eventType: message.kind === "announcement" ? "league_announcement" : "league_reminder",
            messageDataJson: JSON.stringify({ title: message.title, message: message.body, leagueId, communicationId: id }),
            relatedFeature: "league_communication", relatedRecordId: id,
            deliveryStatus: "delivered", createdAtMs: nowMs, deliveredAtMs: nowMs,
            deduplicationKey: `league-communication:${id}:${recipient.userId}` });
        }
        return { leagueId, id, recipientCount: preview.recipientCount, replayed: false };
      });
    },
    archive({ leagueId, id, authenticated, input }) {
      leagueAuthorization.requireCommissioner(authenticated, leagueId);
      available();
      exact(input, ["version", "confirmed"]);
      if (input.confirmed !== true || !Number.isSafeInteger(input.version) || input.version < 1 ||
          !/^[a-f0-9-]{36}$/.test(id || "")) fail();
      return repository.transaction(() => {
        const authority = leagueAuthorization.requireCommissioner(authenticated, leagueId);
        const row = repository.find(leagueId, id);
        if (!row || row.kind !== "announcement") fail("COMMUNICATION_NOT_FOUND");
        if (row.archived_at_ms !== null) return { leagueId, id, archived: true };
        if (!repository.archive({ leagueId, id, version: input.version, actorUserId: authority.actorUserId, nowMs: now() })) {
          fail("COMMUNICATION_PREVIEW_CHANGED");
        }
        return { leagueId, id, archived: true };
      });
    },
  };
}

module.exports = { createLeagueCommunicationService };
