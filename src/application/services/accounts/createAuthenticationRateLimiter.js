const {
  FAILURES,
  RATE_LIMIT_BUCKETS,
  createRateLimitWindow,
  getAuthenticationRateLimitRule,
  retryAfterSeconds,
} = require(
  "../../../domain/accounts/authenticationRateLimitPolicy"
);

const ALLOWED_RESULT = Object.freeze({
  allowed: true,
  code: "RATE_LIMIT_ALLOWED",
  retryAfterSeconds: 0,
});
const DELEGATED_RESULT = Object.freeze({
  allowed: true,
  code: "RATE_LIMIT_DELEGATED",
  retryAfterSeconds: 0,
});

function limited(nowMs, blockedUntilMs) {
  return Object.freeze({
    allowed: false,
    code: "RATE_LIMITED",
    retryAfterSeconds: retryAfterSeconds(
      nowMs,
      blockedUntilMs
    ),
  });
}

function createAuthenticationRateLimiter({
  repository,
  privacyDigest,
  clock,
  secureRandom,
} = {}) {
  for (const method of [
    "findWindow",
    "recordAttempt",
    "clearFailures",
    "cleanupExpired",
  ]) {
    if (
      !repository ||
      typeof repository[method] !== "function"
    ) {
      throw new TypeError(
        "authentication rate limiting requires a specialized repository"
      );
    }
  }
  if (
    !privacyDigest ||
    typeof privacyDigest.digest !== "function"
  ) {
    throw new TypeError(
      "authentication rate limiting requires a keyed privacy digest"
    );
  }
  if (!clock || typeof clock.nowMs !== "function") {
    throw new TypeError(
      "authentication rate limiting requires a clock"
    );
  }
  if (
    !secureRandom ||
    typeof secureRandom.id !== "function"
  ) {
    throw new TypeError(
      "authentication rate limiting requires secure identifiers"
    );
  }

  function identity(
    action,
    bucket,
    canonicalIdentifier,
    nowMs
  ) {
    const rule =
      getAuthenticationRateLimitRule(
        action,
        bucket
      );
    if (rule === null) {
      return { rule: null };
    }
    if (
      typeof canonicalIdentifier !== "string" ||
      canonicalIdentifier.length < 1 ||
      canonicalIdentifier.length > 320 ||
      canonicalIdentifier !==
        canonicalIdentifier.trim()
    ) {
      throw new TypeError(
        "a bounded canonical rate-limit identifier is required"
      );
    }
    const keyed = privacyDigest.digest(
      `${action}\0${bucket}\0${canonicalIdentifier}`
    );
    const window = createRateLimitWindow(
      nowMs,
      rule.windowMs
    );
    return {
      action,
      bucketDigest: keyed.digest,
      keyVersion: keyed.keyVersion,
      rule,
      ...window,
    };
  }

  function check({
    action,
    bucket,
    canonicalIdentifier,
  } = {}) {
    const nowMs = clock.nowMs();
    const target = identity(
      action,
      bucket,
      canonicalIdentifier,
      nowMs
    );
    if (target.rule === null) {
      return DELEGATED_RESULT;
    }
    const row = repository.findWindow(target);
    if (!row) return ALLOWED_RESULT;
    const count =
      target.rule.counter === FAILURES
        ? row.failure_count
        : row.attempt_count;
    if (
      row.blocked_until_ms > nowMs ||
      count >= target.rule.limit
    ) {
      return limited(
        nowMs,
        row.blocked_until_ms ||
          row.window_ends_at_ms
      );
    }
    return ALLOWED_RESULT;
  }

  function recordAttempt({
    action,
    bucket,
    canonicalIdentifier,
    failed = false,
  } = {}) {
    if (typeof failed !== "boolean") {
      throw new TypeError(
        "a rate-limit failure outcome is required"
      );
    }
    const nowMs = clock.nowMs();
    const target = identity(
      action,
      bucket,
      canonicalIdentifier,
      nowMs
    );
    if (target.rule === null) {
      return DELEGATED_RESULT;
    }
    const result = repository.recordAttempt({
      id: secureRandom.id(),
      action,
      keyVersion: target.keyVersion,
      bucketDigest: target.bucketDigest,
      windowStartedAtMs:
        target.windowStartedAtMs,
      windowEndsAtMs:
        target.windowEndsAtMs,
      nowMs,
      failed,
      blockCounter:
        target.rule.counter === FAILURES
          ? "failure_count"
          : "attempt_count",
      limit: target.rule.limit,
    });
    if (!result.allowed) {
      return limited(
        nowMs,
        result.row.blocked_until_ms ||
          result.row.window_ends_at_ms
      );
    }
    return ALLOWED_RESULT;
  }

  function clearSignInAccountFailures({
    canonicalIdentifier,
  } = {}) {
    const nowMs = clock.nowMs();
    const target = identity(
      "sign_in",
      RATE_LIMIT_BUCKETS.subject,
      canonicalIdentifier,
      nowMs
    );
    const row = repository.findWindow(target);
    if (!row) return false;
    repository.clearFailures({
      id: row.id,
      expectedVersion: row.version,
      nowMs,
    });
    return true;
  }

  function cleanupExpired({ limit } = {}) {
    return repository.cleanupExpired({
      nowMs: clock.nowMs(),
      limit,
    });
  }

  return Object.freeze({
    check,
    cleanupExpired,
    clearSignInAccountFailures,
    recordAttempt,
  });
}

module.exports = {
  ALLOWED_RESULT,
  DELEGATED_RESULT,
  createAuthenticationRateLimiter,
};
