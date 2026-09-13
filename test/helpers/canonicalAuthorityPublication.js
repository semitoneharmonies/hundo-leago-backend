const assert = require("node:assert/strict");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readCanonicalAuthorityPublications(database) {
  return database
    .prepare(`
      SELECT
        outbox_events.id AS id,
        outbox_events.league_id AS leagueId,
        outbox_events.event_type AS eventType,
        outbox_events.aggregate_type AS aggregateType,
        outbox_events.aggregate_id AS aggregateId,
        outbox_events.created_at_ms AS occurredAtMs,
        outbox_events.status AS status,
        outbox_events.payload_json AS payloadJson,
        outbox_event_audiences.audience_kind AS audienceKind,
        outbox_event_audiences.team_id AS audienceTeamId,
        outbox_event_audiences.user_id AS audienceUserId
      FROM outbox_events
      JOIN outbox_event_audiences
        ON outbox_event_audiences.outbox_event_id = outbox_events.id
      ORDER BY outbox_events.created_at_ms, outbox_events.id
    `)
    .all()
    .map(({ payloadJson, ...row }) =>
      Object.freeze({
        ...row,
        payload: Object.freeze(JSON.parse(payloadJson)),
      })
    )
    .sort((left, right) =>
      left.payload.reasonCode.localeCompare(right.payload.reasonCode)
    );
}

function assertCanonicalAuthorityPublication(
  actual,
  {
    leagueId,
    eventType,
    aggregateType,
    resourceId,
    resourceVersion,
    reasonCode,
    occurredAtMs,
    teamId = null,
  }
) {
  assert.match(actual.id, UUID_PATTERN);
  assert.deepEqual(actual, {
    id: actual.id,
    leagueId,
    eventType,
    aggregateType,
    aggregateId: resourceId,
    occurredAtMs,
    status: "pending",
    audienceKind: "league",
    audienceTeamId: null,
    audienceUserId: null,
    payload: {
      eventId: actual.id,
      type: eventType,
      leagueId,
      resourceId,
      version: resourceVersion,
      reasonCode,
      occurredAt: occurredAtMs,
      related: {
        fadId: null,
        teamId,
        cardId: null,
        allocationId: null,
        auctionId: null,
        recoveryId: null,
        nominationQueueId: null,
        scheduleRecoveryOperationId: null,
      },
    },
  });
}

module.exports = {
  assertCanonicalAuthorityPublication,
  readCanonicalAuthorityPublications,
};
