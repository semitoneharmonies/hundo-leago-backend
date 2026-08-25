const SECURITY_NOTIFICATIONS = Object.freeze({
  administrator_setup_completed: Object.freeze({
    subject: "Your Hundo Leago administrator account is ready",
    detail:
      "Administrator credential setup completed for your Hundo Leago account.",
  }),
  account_deactivated: Object.freeze({
    subject: "Your Hundo Leago account was deactivated",
    detail: "Your Hundo Leago account was deactivated.",
  }),
  account_reactivated: Object.freeze({
    subject: "Your Hundo Leago account was reactivated",
    detail: "Your Hundo Leago account was reactivated.",
  }),
  password_changed: Object.freeze({
    subject: "Your Hundo Leago password was changed",
    detail: "The password for your Hundo Leago account was changed.",
  }),
  password_reset_completed: Object.freeze({
    subject: "Your Hundo Leago password was reset",
    detail: "Password reset completed for your Hundo Leago account.",
  }),
  session_replaced: Object.freeze({
    subject: "A new Hundo Leago sign-in replaced your previous session",
    detail:
      "A new sign-in replaced the previous active session for your Hundo Leago account.",
  }),
});

const ACTION_LINKS = Object.freeze({
  administrator_setup: Object.freeze({
    subject: "Set up your Hundo Leago administrator account",
    instruction:
      "Set a password to finish creating your Hundo Leago administrator account.",
    label: "Set up account",
  }),
  password_reset: Object.freeze({
    subject: "Reset your Hundo Leago password",
    instruction:
      "Use this secure link to choose a new password for your Hundo Leago account.",
    label: "Reset password",
  }),
  self_reactivation: Object.freeze({
    subject: "Reactivate your Hundo Leago account",
    instruction:
      "Use this secure link to reactivate your Hundo Leago account.",
    label: "Reactivate account",
  }),
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("account email requires a valid timestamp");
  }
  return new Date(value).toISOString();
}

function renderLinkMessage({
  to,
  subject,
  instruction,
  label,
  url,
  expiresAtMs,
}) {
  const expiresAt = formatTimestamp(expiresAtMs);
  const text = [
    "Hundo Leago",
    "",
    instruction,
    "",
    `${label}: ${url}`,
    "",
    `This link expires at ${expiresAt}.`,
    "",
    "If you did not request this action, you can ignore this email.",
  ].join("\n");
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">',
    "<h1>Hundo Leago</h1>",
    `<p>${escapeHtml(instruction)}</p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`,
    `<p>This link expires at ${escapeHtml(expiresAt)}.</p>`,
    "<p>If you did not request this action, you can ignore this email.</p>",
    "</body></html>",
  ].join("");
  return Object.freeze({ html, subject, text, to });
}

function renderEmailVerification(message) {
  return renderLinkMessage({
    to: message.to,
    subject: "Verify your Hundo Leago email",
    instruction:
      "Verify your email address to finish creating your Hundo Leago account.",
    label: "Verify email",
    url: message.verificationUrl,
    expiresAtMs: message.expiresAtMs,
  });
}

function renderAccountActionLink(message) {
  const template = ACTION_LINKS[message.actionKind];
  if (!template) {
    throw new TypeError("account email requires an approved action kind");
  }
  return renderLinkMessage({
    to: message.to,
    ...template,
    url: message.actionUrl,
    expiresAtMs: message.expiresAtMs,
  });
}

function renderSecurityNotification(message) {
  const template = SECURITY_NOTIFICATIONS[message.notificationKind];
  if (!template) {
    throw new TypeError(
      "account email requires an approved security notification"
    );
  }
  const occurredAt = formatTimestamp(message.occurredAtMs);
  const text = [
    "Hundo Leago",
    "",
    template.detail,
    "",
    `Recorded at ${occurredAt}.`,
    "",
    "If you did not perform this action, secure your account immediately.",
  ].join("\n");
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#17202a">',
    "<h1>Hundo Leago</h1>",
    `<p>${escapeHtml(template.detail)}</p>`,
    `<p>Recorded at ${escapeHtml(occurredAt)}.</p>`,
    "<p>If you did not perform this action, secure your account immediately.</p>",
    "</body></html>",
  ].join("");
  return Object.freeze({
    html,
    subject: template.subject,
    text,
    to: message.to,
  });
}

module.exports = {
  ACTION_LINKS,
  SECURITY_NOTIFICATIONS,
  escapeHtml,
  renderAccountActionLink,
  renderEmailVerification,
  renderSecurityNotification,
};
