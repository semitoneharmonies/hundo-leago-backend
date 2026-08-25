const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) ===
      Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactMessage(message, expected) {
  const keys = isPlainObject(message)
    ? Object.keys(message).sort()
    : [];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    typeof message.idempotencyKey !== "string" ||
    message.idempotencyKey.trim() === "" ||
    typeof message.to !== "string" ||
    !EMAIL_PATTERN.test(message.to)
  ) {
    throw new TypeError(
      "the captured account email is invalid"
    );
  }
}

function assertVerificationMessage(message) {
  const expected = [
    "expiresAtMs",
    "idempotencyKey",
    "to",
    "verificationUrl",
  ];
  exactMessage(message, expected);
  if (
    !Number.isSafeInteger(message.expiresAtMs) ||
    message.expiresAtMs < 0
  ) {
    throw new TypeError(
      "the captured verification email is invalid"
    );
  }
  let link;
  try {
    link = new URL(message.verificationUrl);
  } catch {
    throw new TypeError(
      "the captured verification email is invalid"
    );
  }
  if (
    !["http:", "https:"].includes(link.protocol) ||
    link.search !== "" ||
    !/^#token=[A-Za-z0-9_-]{43}$/.test(link.hash)
  ) {
    throw new TypeError(
      "the captured verification email is invalid"
    );
  }
  return Object.freeze({ ...message });
}

function assertSecurityNotification(message) {
  const expected = [
    "idempotencyKey",
    "notificationKind",
    "occurredAtMs",
    "to",
  ];
  exactMessage(message, expected);
  if (
    typeof message.notificationKind !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(
      message.notificationKind
    ) ||
    !Number.isSafeInteger(message.occurredAtMs) ||
    message.occurredAtMs < 0
  ) {
    throw new TypeError(
      "the captured security notification is invalid"
    );
  }
  return Object.freeze({ ...message });
}

function assertActionLinkMessage(message) {
  const expected = [
    "actionKind",
    "actionUrl",
    "expiresAtMs",
    "idempotencyKey",
    "to",
  ];
  exactMessage(message, expected);
  if (
    ![
      "administrator_setup",
      "password_reset",
      "self_reactivation",
    ].includes(
      message.actionKind
    ) ||
    !Number.isSafeInteger(message.expiresAtMs) ||
    message.expiresAtMs < 0
  ) {
    throw new TypeError(
      "the captured account action link is invalid"
    );
  }
  let link;
  try {
    link = new URL(message.actionUrl);
  } catch {
    throw new TypeError(
      "the captured account action link is invalid"
    );
  }
  if (
    !["http:", "https:"].includes(link.protocol) ||
    link.search !== "" ||
    !/^#token=[A-Za-z0-9_-]{43}$/.test(link.hash)
  ) {
    throw new TypeError(
      "the captured account action link is invalid"
    );
  }
  return Object.freeze({ ...message });
}

function createCaptureEmailAdapter() {
  const messages = new Map();

  function capture(message) {
    const previous = messages.get(
      message.idempotencyKey
    );
    if (previous) {
      return Object.freeze({
        accepted: true,
        duplicate: true,
        providerMessageId:
          previous.providerMessageId,
      });
    }
    const stored = Object.freeze({
      ...message,
      providerMessageId:
        `capture:${message.idempotencyKey}`,
    });
    messages.set(message.idempotencyKey, stored);
    return Object.freeze({
      accepted: true,
      duplicate: false,
      providerMessageId: stored.providerMessageId,
    });
  }

  return Object.freeze({
    async sendEmailVerification(message) {
      return capture(
        assertVerificationMessage(message)
      );
    },
    async sendSecurityNotification(message) {
      return capture(
        assertSecurityNotification(message)
      );
    },
    async sendAccountActionLink(message) {
      return capture(
        assertActionLinkMessage(message)
      );
    },
    listCaptured() {
      return Object.freeze([...messages.values()]);
    },
  });
}

module.exports = {
  assertActionLinkMessage,
  assertSecurityNotification,
  assertVerificationMessage,
  createCaptureEmailAdapter,
};
