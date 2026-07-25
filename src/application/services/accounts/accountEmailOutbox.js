const SECURITY_NOTIFICATION_EVENT_TYPES =
  Object.freeze({
    administrator_setup_completed:
      "account.credential_setup_completed_notification",
    account_deactivated:
      "account.deactivated_notification",
    account_reactivated:
      "account.reactivated_notification",
    password_changed:
      "account.password_changed_notification",
    password_reset_completed:
      "account.password_reset_completed_notification",
    session_replaced:
      "account.session_replaced_notification",
  });
const ACTION_LINK_EVENT_TYPES = Object.freeze({
  administrator_setup:
    "account.credential_setup_requested",
  password_reset:
    "account.password_reset_requested",
  self_reactivation:
    "account.reactivation_requested",
});

function createActionLinkOutboxRecord({
  id,
  userId,
  tokenId,
  purpose,
  expiresAtMs,
  envelope,
  nowMs,
} = {}) {
  const eventType = ACTION_LINK_EVENT_TYPES[purpose];
  if (!eventType) {
    throw new TypeError(
      "an approved account action link is required"
    );
  }
  return {
    id,
    league_id: null,
    event_type: eventType,
    aggregate_type: "user",
    aggregate_id: userId,
    payload_json: JSON.stringify({
      deliveryKind: "account_action_link",
      envelope,
      expiresAtMs,
      purpose,
      recipientUserId: userId,
      schemaVersion: 1,
      tokenId,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: nowMs,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    version: 1,
  };
}

function createSecurityNotificationOutboxRecord({
  id,
  userId,
  notificationKind,
  nowMs,
} = {}) {
  const eventType =
    SECURITY_NOTIFICATION_EVENT_TYPES[
      notificationKind
    ];
  if (!eventType) {
    throw new TypeError(
      "an approved security notification is required"
    );
  }
  return {
    id,
    league_id: null,
    event_type: eventType,
    aggregate_type: "user",
    aggregate_id: userId,
    payload_json: JSON.stringify({
      deliveryKind: "security_notification",
      notificationKind,
      occurredAtMs: nowMs,
      recipientUserId: userId,
      schemaVersion: 1,
    }),
    status: "pending",
    attempt_count: 0,
    available_at_ms: nowMs,
    published_at_ms: null,
    last_error_code: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    version: 1,
  };
}

module.exports = {
  ACTION_LINK_EVENT_TYPES,
  SECURITY_NOTIFICATION_EVENT_TYPES,
  createActionLinkOutboxRecord,
  createSecurityNotificationOutboxRecord,
};
