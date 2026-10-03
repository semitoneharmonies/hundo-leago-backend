const { sha256Hex } = require("../shared/sha256");

function fail(code = "COMMUNICATION_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}

function text(value, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum ||
      /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) fail();
  return value.trim();
}

function validateMessage(value) {
  exact(value, ["kind", "title", "body", "audience", "pinned", "expiresAtMs", "notify"]);
  if (!["announcement", "reminder"].includes(value.kind) ||
      !["members", "managers", "unfinished_cards", "pending_invitations"].includes(value.audience) ||
      typeof value.pinned !== "boolean" || typeof value.notify !== "boolean" ||
      (value.expiresAtMs !== null && (!Number.isSafeInteger(value.expiresAtMs) ||
       value.expiresAtMs < 0 || value.expiresAtMs > 8_640_000_000_000_000))) fail();
  if (value.kind === "announcement" && value.audience !== "members") fail();
  if (value.kind === "reminder" && (value.pinned || value.expiresAtMs !== null || !value.notify)) fail();
  return { kind: value.kind, title: text(value.title, 120), body: text(value.body, 3000),
    audience: value.audience, pinned: value.pinned, expiresAtMs: value.expiresAtMs, notify: value.notify };
}

function digest(value) {
  return sha256Hex(JSON.stringify(value));
}

function clientKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) fail();
  return value;
}

module.exports = { fail, exact, validateMessage, digest, clientKey };
