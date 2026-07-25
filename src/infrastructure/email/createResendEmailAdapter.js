const {
  assertActionLinkMessage,
  assertSecurityNotification,
  assertVerificationMessage,
} = require("./createCaptureEmailAdapter");
const {
  renderAccountActionLink,
  renderEmailVerification,
  renderSecurityNotification,
} = require("./renderAccountEmail");

const RESEND_API_ORIGIN = "https://api.resend.com";
const RESEND_EMAIL_ENDPOINT = `${RESEND_API_ORIGIN}/emails`;
const RESEND_SANDBOX_RECIPIENT = "delivered@resend.dev";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_TIMEOUT_MS = 30_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

class AccountEmailProviderError extends Error {
  constructor({ retryable, statusCode = null } = {}) {
    super("Account email provider request failed.");
    this.name = "AccountEmailProviderError";
    this.code = retryable
      ? "ACCOUNT_EMAIL_PROVIDER_RETRYABLE"
      : "ACCOUNT_EMAIL_PROVIDER_TERMINAL";
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function assertApiKey(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 20 ||
    value.length > 256 ||
    !/^re_[A-Za-z0-9_]+$/.test(value)
  ) {
    throw new TypeError("Resend account email requires a valid API key");
  }
  return value;
}

function assertSender(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > 320
  ) {
    throw new TypeError("Resend account email requires a valid sender");
  }
  const bracketMatch = value.match(/^.{1,200} <([^<>]+)>$/u);
  const address = bracketMatch ? bracketMatch[1] : value;
  if (!EMAIL_PATTERN.test(address)) {
    throw new TypeError("Resend account email requires a valid sender");
  }
  return value;
}

function assertReplyTo(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > 254 ||
    !EMAIL_PATTERN.test(value)
  ) {
    throw new TypeError("Resend account email requires a valid reply-to address");
  }
  return value;
}

function providerFailure(retryable, statusCode = null) {
  return new AccountEmailProviderError({ retryable, statusCode });
}

function isRetryableResponse(status, errorType) {
  if (!Number.isSafeInteger(status)) return true;
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  return status === 409 && errorType === "concurrent_idempotent_requests";
}

async function safeResponseJson(response) {
  try {
    const text = await response.text();
    if (text.length > 16_384) return null;
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function createResendEmailAdapter({
  apiKey,
  deliveryMode,
  from,
  replyTo = null,
  fetchImplementation = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimeoutFunction = setTimeout,
  clearTimeoutFunction = clearTimeout,
} = {}) {
  const credential = assertApiKey(apiKey);
  const sender = assertSender(from);
  const replyAddress = assertReplyTo(replyTo);
  if (!["sandbox", "send"].includes(deliveryMode)) {
    throw new TypeError("Resend account email requires sandbox or send mode");
  }
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("Resend account email requires a fetch implementation");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAXIMUM_TIMEOUT_MS
  ) {
    throw new TypeError("Resend account email requires a bounded timeout");
  }
  if (
    typeof setTimeoutFunction !== "function" ||
    typeof clearTimeoutFunction !== "function"
  ) {
    throw new TypeError("Resend account email requires timer functions");
  }

  async function deliver(message, render) {
    if (
      typeof message.idempotencyKey !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(message.idempotencyKey)
    ) {
      throw new TypeError("Resend account email requires an idempotency key");
    }
    const rendered = render(message);
    const body = {
      from: sender,
      to: [
        deliveryMode === "sandbox"
          ? RESEND_SANDBOX_RECIPIENT
          : rendered.to,
      ],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    };
    if (replyAddress !== null) body.reply_to = replyAddress;

    const controller = new AbortController();
    const timeout = setTimeoutFunction(() => controller.abort(), timeoutMs);
    if (timeout && typeof timeout.unref === "function") timeout.unref();
    let response;
    try {
      response = await fetchImplementation(RESEND_EMAIL_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
          "User-Agent": "hundo-leago-backend/1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw providerFailure(true);
    } finally {
      clearTimeoutFunction(timeout);
    }

    const payload = await safeResponseJson(response);
    if (!response || response.ok !== true) {
      throw providerFailure(
        isRetryableResponse(response?.status, payload?.name),
        Number.isSafeInteger(response?.status) ? response.status : null
      );
    }
    if (typeof payload?.id !== "string" || payload.id.trim() === "") {
      throw providerFailure(true, response.status);
    }
    return Object.freeze({
      accepted: true,
      duplicate: false,
      providerMessageId: payload.id,
    });
  }

  return Object.freeze({
    async sendEmailVerification(message) {
      return deliver(
        assertVerificationMessage(message),
        renderEmailVerification
      );
    },
    async sendAccountActionLink(message) {
      return deliver(
        assertActionLinkMessage(message),
        renderAccountActionLink
      );
    },
    async sendSecurityNotification(message) {
      return deliver(
        assertSecurityNotification(message),
        renderSecurityNotification
      );
    },
  });
}

module.exports = {
  AccountEmailProviderError,
  DEFAULT_TIMEOUT_MS,
  MAXIMUM_TIMEOUT_MS,
  RESEND_API_ORIGIN,
  RESEND_EMAIL_ENDPOINT,
  RESEND_SANDBOX_RECIPIENT,
  createResendEmailAdapter,
};
