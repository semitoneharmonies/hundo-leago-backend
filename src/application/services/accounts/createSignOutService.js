function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `sign out requires ${description}`
    );
  }
}

function createSignOutService({
  sessionService,
  auditRepository,
  clock,
  secureRandom,
} = {}) {
  assertMethod(
    sessionService,
    "revoke",
    "a session service"
  );
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(
    secureRandom,
    "id",
    "secure identifiers"
  );

  function signOut({
    session,
    user,
    auditContext = null,
  } = {}) {
    if (
      !session ||
      typeof session.id !== "string" ||
      !Number.isSafeInteger(session.version) ||
      !user ||
      typeof user.id !== "string"
    ) {
      throw new TypeError(
        "sign out requires an authenticated session"
      );
    }
    const audit = auditContext || {};
    const nowMs = clock.nowMs();
    sessionService.revoke({
      sessionId: session.id,
      expectedVersion: session.version,
      reason: "sign_out",
      transactionHook() {
        auditRepository.append({
          id: secureRandom.id(),
          event_type: "account.sign_out",
          outcome: "success",
          actor_user_id: user.id,
          target_user_id: user.id,
          league_id: null,
          session_id: session.id,
          request_correlation_id:
            audit.requestCorrelationId || null,
          reason_code: null,
          network_key_version:
            audit.networkKeyVersion || null,
          network_metadata_digest:
            audit.networkMetadataDigest || null,
          client_metadata_json:
            audit.clientMetadataJson || null,
          unknown_account_digest: null,
          occurred_at_ms: nowMs,
        });
      },
    });
    return Object.freeze({
      signedOut: true,
      code: "SESSION_SIGNED_OUT",
    });
  }

  return Object.freeze({ signOut });
}

module.exports = { createSignOutService };
