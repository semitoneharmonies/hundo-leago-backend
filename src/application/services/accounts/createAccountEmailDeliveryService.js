const DEFAULT_MAXIMUM_ATTEMPTS = 5;
const RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
]);
const INTERRUPTED_CLAIM_GRACE_MS = 5 * 60 * 1000;
const EMAIL_VERIFICATION_PATH = "/verify-email";
const ACTION_LINK_PATHS = Object.freeze({
  administrator_setup: "/setup-account",
  password_reset: "/reset-password",
  self_reactivation: "/reactivate",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `account email delivery requires ${description}`
    );
  }
}

function safeOutcome(eventId, outcome) {
  return Object.freeze({ eventId, outcome });
}

function parsePayload(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.schemaVersion !== 1 ||
    typeof payload.recipientUserId !== "string"
  ) {
    return null;
  }
  if (payload.deliveryKind === "email_verification") {
    return payload.purpose === "email_verification" &&
      typeof payload.tokenId === "string" &&
      Number.isSafeInteger(payload.expiresAtMs) &&
      payload.expiresAtMs >= 0 &&
      payload.envelope !== null &&
      typeof payload.envelope === "object" &&
      !Array.isArray(payload.envelope)
      ? payload
      : null;
  }
  if (payload.deliveryKind === "account_action_link") {
    return ACTION_LINK_PATHS[payload.purpose] &&
      typeof payload.tokenId === "string" &&
      Number.isSafeInteger(payload.expiresAtMs) &&
      payload.expiresAtMs >= 0 &&
      payload.envelope !== null &&
      typeof payload.envelope === "object" &&
      !Array.isArray(payload.envelope)
      ? payload
      : null;
  }
  if (payload.deliveryKind === "security_notification") {
    return typeof payload.notificationKind === "string" &&
      Number.isSafeInteger(payload.occurredAtMs) &&
      payload.occurredAtMs >= 0
      ? payload
      : null;
  }
  return null;
}

function verificationUrl(
  publicFrontendOrigin,
  rawToken
) {
  const link = new URL(
    EMAIL_VERIFICATION_PATH,
    publicFrontendOrigin
  );
  link.hash = `token=${rawToken}`;
  return link.toString();
}

function actionUrl(
  publicFrontendOrigin,
  purpose,
  rawToken
) {
  const link = new URL(
    ACTION_LINK_PATHS[purpose],
    publicFrontendOrigin
  );
  link.hash = `token=${rawToken}`;
  return link.toString();
}

function createAccountEmailDeliveryService({
  outboxRepository,
  userRepository,
  deliveryEnvelope,
  emailAdapter,
  clock,
  publicFrontendOrigin,
  maximumAttempts = DEFAULT_MAXIMUM_ATTEMPTS,
} = {}) {
  for (const method of [
    "findDue",
    "claimForDelivery",
    "markPublished",
    "markRetryableFailure",
    "discard",
    "recoverInterrupted",
  ]) {
    assertMethod(
      outboxRepository,
      method,
      "a durable outbox repository"
    );
  }
  assertMethod(
    userRepository,
    "findById",
    "a user repository"
  );
  assertMethod(
    deliveryEnvelope,
    "open",
    "an encrypted delivery envelope"
  );
  assertMethod(
    emailAdapter,
    "sendEmailVerification",
    "an email adapter"
  );
  assertMethod(clock, "nowMs", "a clock");
  if (
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    maximumAttempts > RETRY_DELAYS_MS.length + 1
  ) {
    throw new TypeError(
      "account email delivery requires a bounded attempt limit"
    );
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicFrontendOrigin);
  } catch {
    throw new TypeError(
      "account email delivery requires a canonical frontend origin"
    );
  }
  if (
    parsedOrigin.origin !== publicFrontendOrigin ||
    !["http:", "https:"].includes(parsedOrigin.protocol)
  ) {
    throw new TypeError(
      "account email delivery requires a canonical frontend origin"
    );
  }

  function discard(claimed, nowMs, errorCode) {
    outboxRepository.discard({
      eventId: claimed.id,
      expectedVersion: claimed.version,
      nowMs,
      errorCode,
    });
    return safeOutcome(claimed.id, "discarded");
  }

  async function deliverClaimed(claimed) {
    const nowMs = clock.nowMs();
    const payload = parsePayload(claimed.payload_json);
    if (!payload) {
      return discard(
        claimed,
        nowMs,
        "EMAIL_PAYLOAD_INVALID"
      );
    }
    if (
      payload.deliveryKind !== "security_notification" &&
      nowMs >= payload.expiresAtMs
    ) {
      return discard(
        claimed,
        nowMs,
        "EMAIL_TOKEN_EXPIRED"
      );
    }
    const user = userRepository.findById(
      payload.recipientUserId
    );
    if (
      !user ||
      user.id !== claimed.aggregate_id ||
      (payload.deliveryKind === "email_verification" &&
        user.status !== "pending_verification") ||
      (payload.deliveryKind === "account_action_link" &&
        payload.purpose === "administrator_setup" &&
        user.status !== "pending_credential_setup") ||
      (payload.deliveryKind === "account_action_link" &&
        payload.purpose === "password_reset" &&
        user.status !== "active") ||
      (payload.deliveryKind === "account_action_link" &&
        payload.purpose === "self_reactivation" &&
        user.status !== "deactivated") ||
      typeof user.email_display !== "string" ||
      user.email_display.trim() === ""
    ) {
      return discard(
        claimed,
        nowMs,
        "EMAIL_RECIPIENT_UNAVAILABLE"
      );
    }

    let deliveryResult;
    try {
      if (payload.deliveryKind !== "security_notification") {
        let opened;
        try {
          opened = deliveryEnvelope.open({
            envelope: payload.envelope,
            binding: {
              outboxEventId: claimed.id,
              publicFrontendOrigin,
              purpose: payload.purpose,
              tokenId: payload.tokenId,
              userId: payload.recipientUserId,
            },
          });
        } catch {
          return discard(
            claimed,
            nowMs,
            "EMAIL_ENVELOPE_INVALID"
          );
        }
        if (payload.deliveryKind === "email_verification") {
          deliveryResult =
            await emailAdapter.sendEmailVerification({
              expiresAtMs: payload.expiresAtMs,
              idempotencyKey: claimed.id,
              to: user.email_display,
              verificationUrl: verificationUrl(
                publicFrontendOrigin,
                opened.rawToken
              ),
            });
        } else {
          assertMethod(
            emailAdapter,
            "sendAccountActionLink",
            "an account-action-link email adapter"
          );
          deliveryResult =
            await emailAdapter.sendAccountActionLink({
              actionKind: payload.purpose,
              actionUrl: actionUrl(
                publicFrontendOrigin,
                payload.purpose,
                opened.rawToken
              ),
              expiresAtMs: payload.expiresAtMs,
              idempotencyKey: claimed.id,
              to: user.email_display,
            });
        }
      } else {
        assertMethod(
          emailAdapter,
          "sendSecurityNotification",
          "a security-notification email adapter"
        );
        deliveryResult =
          await emailAdapter.sendSecurityNotification({
            idempotencyKey: claimed.id,
            notificationKind:
              payload.notificationKind,
            occurredAtMs: payload.occurredAtMs,
            to: user.email_display,
          });
      }
      if (deliveryResult?.accepted !== true) {
        const error = new Error(
          "The email adapter did not accept delivery."
        );
        error.retryable = true;
        throw error;
      }
    } catch (error) {
      const failedAtMs = clock.nowMs();
      if (
        error?.retryable === false ||
        claimed.attempt_count >= maximumAttempts ||
        (payload.deliveryKind !== "security_notification" &&
          failedAtMs >= payload.expiresAtMs)
      ) {
        return discard(
          claimed,
          failedAtMs,
          "EMAIL_DELIVERY_TERMINAL"
        );
      }
      const retryDelay =
        RETRY_DELAYS_MS[claimed.attempt_count - 1];
      const retryAtMs =
        payload.deliveryKind !== "security_notification"
          ? Math.min(
              failedAtMs + retryDelay,
              payload.expiresAtMs
            )
          : failedAtMs + retryDelay;
      if (retryAtMs <= failedAtMs) {
        return discard(
          claimed,
          failedAtMs,
          "EMAIL_TOKEN_EXPIRED"
        );
      }
      outboxRepository.markRetryableFailure({
        eventId: claimed.id,
        expectedVersion: claimed.version,
        nowMs: failedAtMs,
        availableAtMs: retryAtMs,
        errorCode: "EMAIL_DELIVERY_RETRYABLE",
      });
      return safeOutcome(claimed.id, "retry_scheduled");
    }
    outboxRepository.markPublished({
      eventId: claimed.id,
      expectedVersion: claimed.version,
      nowMs: clock.nowMs(),
    });
    return safeOutcome(claimed.id, "published");
  }

  async function deliverDue({ limit = 10 } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new TypeError(
        "account email delivery requires a bounded batch limit"
      );
    }
    const due = outboxRepository.findDue({
      nowMs: clock.nowMs(),
      limit,
    });
    const outcomes = [];
    for (const pending of due) {
      let claimed;
      try {
        claimed = outboxRepository.claimForDelivery({
          eventId: pending.id,
          expectedVersion: pending.version,
          nowMs: clock.nowMs(),
        });
      } catch (error) {
        if (
          [
            "REPOSITORY_VERSION_CONFLICT",
            "REPOSITORY_RECORD_NOT_FOUND",
          ].includes(error?.code)
        ) {
          continue;
        }
        throw error;
      }
      outcomes.push(await deliverClaimed(claimed));
    }
    return Object.freeze(outcomes);
  }

  function recoverInterrupted({ limit = 100 } = {}) {
    const nowMs = clock.nowMs();
    return outboxRepository.recoverInterrupted({
      nowMs,
      staleBeforeMs:
        Math.max(
          0,
          nowMs - INTERRUPTED_CLAIM_GRACE_MS
        ),
      limit,
    });
  }

  return Object.freeze({
    deliverDue,
    recoverInterrupted,
  });
}

module.exports = {
  ACTION_LINK_PATHS,
  DEFAULT_MAXIMUM_ATTEMPTS,
  EMAIL_VERIFICATION_PATH,
  INTERRUPTED_CLAIM_GRACE_MS,
  RETRY_DELAYS_MS,
  createAccountEmailDeliveryService,
};
