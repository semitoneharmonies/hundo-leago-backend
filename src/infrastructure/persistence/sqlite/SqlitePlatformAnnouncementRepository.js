const { createSqliteLeagueCommunicationRepository } = require("./SqliteLeagueCommunicationRepository");
const { createSqliteRecordRepository } = require("./createSqliteRecordRepository");
const { getRepositoryDefinition } = require("./repositoryCatalog");

function createSqlitePlatformAnnouncementRepository({ database, notificationWriter } = {}) {
  const communications = createSqliteLeagueCommunicationRepository({ database, notificationWriter });
  const idempotency = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("idempotency_requests") });
  const events = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("operational_events") });
  const targets = database.prepare("SELECT id AS leagueId, name AS leagueName, version FROM leagues WHERE status <> 'deleted' ORDER BY id");
  const replay = database.prepare("SELECT * FROM idempotency_requests WHERE league_id IS NULL AND actor_user_id = ? AND operation = ? AND client_key = ?");
  const receipt = database.prepare("SELECT details_json FROM operational_events WHERE id = ? AND actor_user_id = ? AND league_id IS NULL AND event_type = 'platform.announcement_published' AND feature = 'platform_announcements' AND outcome = 'success'");
  return Object.freeze({
    transaction: communications.transaction,
    targets: () => targets.all(),
    recipients: communications.recipients,
    insert: communications.insert,
    notify: communications.notify,
    replay: (actorUserId, operation, key) => replay.get(actorUserId, operation, key) || null,
    receipt(id, actorUserId) {
      const row = receipt.get(id, actorUserId);
      return row ? JSON.parse(row.details_json) : null;
    },
    saveReceipt({ id, actorUserId, requestHash, result, nowMs }) {
      return events.insert({ id, league_id: null, season_id: null,
        event_type: "platform.announcement_published", feature: "platform_announcements", outcome: "success",
        actor_user_id: actorUserId, reason_code: null, details_json: JSON.stringify({ requestHash, result }),
        occurred_at_ms: nowMs });
    },
    saveIdempotency: record => idempotency.insert(record),
  });
}

module.exports = { createSqlitePlatformAnnouncementRepository };
