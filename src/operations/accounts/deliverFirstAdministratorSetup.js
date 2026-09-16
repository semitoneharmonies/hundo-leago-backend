const {
  createAccountEmailDeliveryService,
  DEFAULT_MAXIMUM_ATTEMPTS,
} = require("../../application/services/accounts/createAccountEmailDeliveryService");
const { createFirstAdministratorSetupPolicy } = require("../../application/services/accounts/createFirstAdministratorSetupPolicy");
const { createActionTokenDeliveryEnvelope } = require("../../infrastructure/security/createActionTokenDeliveryEnvelope");
const { createOpaqueActionTokens } = require("../../infrastructure/security/createOpaqueActionTokens");
const { evaluateActionToken } = require("../../domain/accounts/accountActionTokenPolicy");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE = "FIRST_ADMINISTRATOR_DELIVERY_UNAVAILABLE";

function unavailable() {
  const error = new Error("The confirmed first-administrator setup delivery is unavailable.");
  error.code = ERROR_CODE;
  throw error;
}

async function deliverFirstAdministratorSetup({
  runtime, securityFoundations, eventId, recipientEmail, confirmation,
} = {}) {
  const config = runtime?.runtimeConfig;
  const setup = config?.firstAdministratorSetup;
  if (!setup || config.appEnv !== "production" || config.leagueWriteMode !== "closed" ||
      config.accountEmailDeliveryEnabled !== false || config.scheduledJobsEnabled !== false ||
      config.backupScheduleEnabled === true || config.security?.email?.deliveryMode !== "send" ||
      typeof eventId !== "string" || !UUID.test(eventId) ||
      typeof recipientEmail !== "string" || recipientEmail.trim() !== recipientEmail || !recipientEmail ||
      confirmation !== `${config.environmentId}:${config.databaseId}:${config.buildId}:${setup.userId}:${eventId}`) {
    unavailable();
  }
  const { database, repositories } = runtime;
  const { clock, secureRandom } = securityFoundations;
  const policy = createFirstAdministratorSetupPolicy({ database, config: setup, clock,
    appEnv: config.appEnv, buildId: config.buildId, leagueWriteMode: config.leagueWriteMode });
  const outbox = repositories.outbox;
  const deliveryKey = config.security.actionTokenDeliveryKey;
  const deliveryEnvelope = createActionTokenDeliveryEnvelope({ encodedKey: deliveryKey.value,
    keyVersion: deliveryKey.keyVersion, secureRandom });
  const opaqueTokens = createOpaqueActionTokens({ secureRandom });

  function inspect() {
    if (!policy.allows(setup.userId)) unavailable();
    const user = repositories.users.findById(setup.userId);
    if (user?.email_display !== recipientEmail) unavailable();
    const row = outbox.findById(eventId);
    if (!row || row.aggregate_id !== setup.userId || row.aggregate_type !== "user" || row.league_id !== null ||
        row.event_type !== "account.credential_setup_requested") unavailable();
    if (row.status === "published") return row;
    if (!["pending", "failed"].includes(row.status) || row.available_at_ms > clock.nowMs() ||
        row.attempt_count >= DEFAULT_MAXIMUM_ATTEMPTS) unavailable();
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { unavailable(); }
    if (!payload || payload.schemaVersion !== 1 || payload.deliveryKind !== "account_action_link" ||
        payload.purpose !== "administrator_setup" || payload.recipientUserId !== setup.userId ||
        typeof payload.tokenId !== "string" || !UUID.test(payload.tokenId)) unavailable();
    const token = database.prepare("SELECT user_id, token_digest, purpose, status, created_at_ms, expires_at_ms, consumed_at_ms, invalidated_at_ms FROM account_action_tokens WHERE id = ?").get(payload.tokenId);
    if (!token || token.user_id !== setup.userId || token.expires_at_ms !== payload.expiresAtMs ||
        evaluateActionToken(token, "administrator_setup", clock.nowMs()).valid !== true) unavailable();
    // A configuration or envelope error must not consume the only setup message.
    // Validate both decryption and the stored token before any claim or queue write.
    try {
      const opened = deliveryEnvelope.open({ envelope: payload.envelope, binding: {
        outboxEventId: eventId, publicFrontendOrigin: config.security.publicFrontendOrigin,
        purpose: payload.purpose, tokenId: payload.tokenId, userId: setup.userId,
      } });
      if (!opaqueTokens.matches(opened.rawToken, token.token_digest)) unavailable();
    } catch { unavailable(); }
    return row;
  }

  const selected = database.transaction(inspect).immediate();
  if (selected.status === "published") return Object.freeze({ eventId, outcome: "already_published" });
  // Reuse the existing delivery state machine through a repository restricted to one event.
  // It cannot enumerate, recover, claim or transition another queued message.
  const scopedOutbox = {
    findDue({ limit }) {
      if (limit !== 1) unavailable();
      return Object.freeze([selected]);
    },
    claimForDelivery(input) {
      if (input.eventId !== eventId || input.expectedVersion !== selected.version) unavailable();
      return database.transaction(() => {
        const current = inspect();
        if (current.status === "published" || current.version !== selected.version ||
            current.payload_json !== selected.payload_json) unavailable();
        return outbox.claimForDelivery({ ...input, nowMs: clock.nowMs() });
      }).immediate();
    },
    recoverInterrupted() { unavailable(); },
  };
  for (const method of ["markPublished", "markRetryableFailure", "discard"]) {
    scopedOutbox[method] = input => {
      if (input.eventId !== eventId) unavailable();
      return outbox[method](input);
    };
  }
  const service = createAccountEmailDeliveryService({
    outboxRepository: Object.freeze(scopedOutbox),
    userRepository: { findById(userId) {
      if (userId !== setup.userId || !policy.allows(userId)) return null;
      const user = repositories.users.findById(userId);
      return user?.email_display === recipientEmail ? user : null;
    } },
    deliveryEnvelope,
    emailAdapter: runtime.services.accountEmail.adapter,
    clock,
    publicFrontendOrigin: config.security.publicFrontendOrigin,
  });
  const results = await service.deliverDue({ limit: 1 });
  return results[0] || Object.freeze({ eventId, outcome: "not_claimed" });
}

module.exports = { ERROR_CODE, deliverFirstAdministratorSetup };
