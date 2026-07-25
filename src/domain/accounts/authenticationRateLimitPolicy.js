const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const RATE_LIMIT_BUCKETS = Object.freeze({
  network: "network",
  subject: "subject",
});

const ATTEMPTS = "attempts";
const FAILURES = "failures";

function rule(limit, windowMs, counter) {
  return Object.freeze({
    limit,
    windowMs,
    counter,
  });
}

const AUTHENTICATION_RATE_LIMITS =
  Object.freeze({
    sign_in: Object.freeze({
      network: rule(20, 15 * MINUTE_MS, ATTEMPTS),
      subject: rule(5, 15 * MINUTE_MS, FAILURES),
    }),
    sign_up: Object.freeze({
      network: rule(5, HOUR_MS, ATTEMPTS),
      subject: rule(3, HOUR_MS, ATTEMPTS),
    }),
    verification_resend: Object.freeze({
      network: rule(10, HOUR_MS, ATTEMPTS),
      subject: rule(3, HOUR_MS, ATTEMPTS),
    }),
    password_reset_request: Object.freeze({
      network: rule(10, HOUR_MS, ATTEMPTS),
      subject: rule(3, HOUR_MS, ATTEMPTS),
    }),
    reactivation_request: Object.freeze({
      network: rule(10, HOUR_MS, ATTEMPTS),
      subject: rule(3, HOUR_MS, ATTEMPTS),
    }),
    administrator_setup_resend: Object.freeze({
      network: null,
      subject: rule(3, HOUR_MS, ATTEMPTS),
    }),
    action_token_completion: Object.freeze({
      network: rule(20, 15 * MINUTE_MS, ATTEMPTS),
      subject: rule(5, 15 * MINUTE_MS, FAILURES),
    }),
    password_change: Object.freeze({
      network: null,
      subject: rule(5, HOUR_MS, ATTEMPTS),
    }),
    account_deactivation: Object.freeze({
      network: null,
      subject: rule(5, HOUR_MS, ATTEMPTS),
    }),
  });

const AUTHENTICATION_RATE_LIMIT_ACTIONS =
  Object.freeze(
    Object.keys(AUTHENTICATION_RATE_LIMITS)
  );

function getAuthenticationRateLimitRule(
  action,
  bucket
) {
  if (
    !AUTHENTICATION_RATE_LIMIT_ACTIONS.includes(
      action
    ) ||
    !Object.values(RATE_LIMIT_BUCKETS).includes(
      bucket
    )
  ) {
    throw new TypeError(
      "an approved authentication rate-limit action and bucket are required"
    );
  }
  return AUTHENTICATION_RATE_LIMITS[action][
    bucket
  ];
}

function createRateLimitWindow(
  nowMs,
  windowMs
) {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1
  ) {
    throw new TypeError(
      "safe rate-limit window values are required"
    );
  }
  const windowStartedAtMs =
    Math.floor(nowMs / windowMs) * windowMs;
  const windowEndsAtMs =
    windowStartedAtMs + windowMs;
  if (!Number.isSafeInteger(windowEndsAtMs)) {
    throw new TypeError(
      "rate-limit window is outside the safe range"
    );
  }
  return Object.freeze({
    windowStartedAtMs,
    windowEndsAtMs,
  });
}

function retryAfterSeconds(
  nowMs,
  blockedUntilMs
) {
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(blockedUntilMs) ||
    nowMs < 0 ||
    blockedUntilMs <= nowMs
  ) {
    return 0;
  }
  return Math.ceil(
    (blockedUntilMs - nowMs) / 1000
  );
}

module.exports = {
  ATTEMPTS,
  AUTHENTICATION_RATE_LIMIT_ACTIONS,
  AUTHENTICATION_RATE_LIMITS,
  FAILURES,
  HOUR_MS,
  MINUTE_MS,
  RATE_LIMIT_BUCKETS,
  createRateLimitWindow,
  getAuthenticationRateLimitRule,
  retryAfterSeconds,
};
