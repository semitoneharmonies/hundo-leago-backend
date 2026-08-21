const {
  ACTIVITY_CODES,
  ActivityPolicyError,
  encodeCursor,
  validateNotificationId,
  validateNotificationIds,
  validateNotificationPageInput,
} = require("../../../domain/activity/activityPolicy");

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`notifications require ${description}`);
  }
}

function safeNow(clock) {
  const value = clock.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("notifications require a safe clock");
  }
  return value;
}

function projectRow(row) {
  let messageData;
  try {
    messageData = JSON.parse(row.message_data_json);
  } catch {
    throw new TypeError("notifications require valid message data");
  }
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    type: row.event_type,
    messageData: Object.freeze(messageData),
    related: row.related_feature
      ? Object.freeze({
          feature: row.related_feature,
          recordId: row.related_record_id,
        })
      : null,
    deliveryStatus: row.delivery_status,
    createdAtMs: row.created_at_ms,
    readAtMs: row.read_at_ms,
    deliveredAtMs: row.delivered_at_ms,
    version: row.version,
  });
}

function createNotificationService({
  leagueAuthorization,
  repository,
  clock,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireActiveUser",
    "active-user authorization"
  );
  for (const method of [
    "listPage",
    "markAllRead",
    "markBatchRead",
    "markRead",
  ]) {
    assertMethod(repository, method, "a notification repository");
  }
  assertMethod(clock, "nowMs", "a clock");

  function user(authenticated) {
    return leagueAuthorization.requireActiveUser(authenticated);
  }

  function list({ query, authenticated } = {}) {
    const authority = user(authenticated);
    const page = validateNotificationPageInput(query || {});
    const result = repository.listPage({
      userId: authority.actorUserId,
      limit: page.limit,
      cursor: page.cursor,
      readStatus: page.readStatus,
    });
    const notifications = Object.freeze(result.rows.map(projectRow));
    const last = result.rows.at(-1);
    return Object.freeze({
      code: "NOTIFICATIONS_FOUND",
      notifications,
      page: Object.freeze({
        limit: page.limit,
        nextCursor:
          result.hasMore && last
            ? encodeCursor({ occurredAtMs: last.created_at_ms, id: last.id })
            : null,
      }),
    });
  }

  function markBatchRead({ notificationIds, authenticated } = {}) {
    const authority = user(authenticated);
    const result = repository.markBatchRead({
      notificationIds: validateNotificationIds(notificationIds),
      userId: authority.actorUserId,
      readAtMs: safeNow(clock),
    });
    if (!result) {
      throw new ActivityPolicyError(ACTIVITY_CODES.notificationNotFound);
    }
    return Object.freeze({
      code: "NOTIFICATIONS_READ",
      changedCount: result.changedCount,
      readAtMs: result.readAtMs,
      notificationIds: Object.freeze([...result.notificationIds]),
    });
  }

  function markRead({ notificationId, authenticated } = {}) {
    const authority = user(authenticated);
    const result = repository.markRead({
      notificationId: validateNotificationId(notificationId),
      userId: authority.actorUserId,
      readAtMs: safeNow(clock),
    });
    if (!result) {
      throw new ActivityPolicyError(ACTIVITY_CODES.notificationNotFound);
    }
    return Object.freeze({
      code: "NOTIFICATION_READ",
      notification: projectRow(result),
    });
  }

  function markAllRead({ authenticated } = {}) {
    const authority = user(authenticated);
    const result = repository.markAllRead({
      userId: authority.actorUserId,
      readAtMs: safeNow(clock),
    });
    return Object.freeze({
      code: "NOTIFICATIONS_READ",
      changedCount: result.changedCount,
      readAtMs: result.readAtMs,
    });
  }

  return Object.freeze({ list, markAllRead, markBatchRead, markRead });
}

module.exports = { createNotificationService };
