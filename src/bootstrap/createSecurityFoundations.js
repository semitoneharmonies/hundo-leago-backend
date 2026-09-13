const {
  loadSecurityConfig,
} = require("../config/loadSecurityConfig");
const {
  createStructuredLogger,
} = require(
  "../infrastructure/logging/createStructuredLogger"
);
const {
  createSecureRandom,
} = require(
  "../infrastructure/security/createSecureRandom"
);
const {
  createSystemClock,
} = require(
  "../infrastructure/security/createSystemClock"
);

function assertClock(clock) {
  if (
    !clock ||
    typeof clock.nowMs !== "function" ||
    typeof clock.nowIso !== "function" ||
    typeof clock.sample !== "function"
  ) {
    throw new TypeError(
      "security foundations require a clock"
    );
  }
  return clock;
}

function assertSecureRandom(secureRandom) {
  if (
    !secureRandom ||
    typeof secureRandom.bytes !== "function" ||
    typeof secureRandom.token !== "function" ||
    typeof secureRandom.id !== "function"
  ) {
    throw new TypeError(
      "security foundations require secure randomness"
    );
  }
  return secureRandom;
}

function createSecurityFoundations({
  env,
  clock,
  secureRandom,
  now,
  randomBytes,
  randomUUID,
  loggerSink,
  loadConfig = loadSecurityConfig,
  createClock = createSystemClock,
  createRandom = createSecureRandom,
  createLogger = createStructuredLogger,
} = {}) {
  if (typeof loadConfig !== "function") {
    throw new TypeError(
      "createSecurityFoundations requires a config loader"
    );
  }
  if (typeof createClock !== "function") {
    throw new TypeError(
      "createSecurityFoundations requires a clock factory"
    );
  }
  if (typeof createRandom !== "function") {
    throw new TypeError(
      "createSecurityFoundations requires a randomness factory"
    );
  }
  if (typeof createLogger !== "function") {
    throw new TypeError(
      "createSecurityFoundations requires a logger factory"
    );
  }

  const config = loadConfig({ env });
  const resolvedClock = assertClock(
    clock || createClock({ now })
  );
  const resolvedSecureRandom = assertSecureRandom(
    secureRandom ||
      createRandom({ randomBytes, randomUUID })
  );

  const loggerOptions = {
    environment: config.appEnv,
    buildId: config.buildId,
    logLevel: config.logLevel,
    clock: resolvedClock,
    sensitiveValues: [
      config.rateLimitKey.value,
      config.auditMetadataKey.value,
      config.actionTokenDeliveryKey.value,
      config.email.apiKey.value,
      config.sportsDataIoLive.apiKey.value,
      config.sportsDataIoLive.capabilitySecret.value,
    ],
  };
  if (loggerSink !== undefined) {
    loggerOptions.sink = loggerSink;
  }

  const logger = createLogger(loggerOptions);

  return Object.freeze({
    config,
    clock: resolvedClock,
    secureRandom: resolvedSecureRandom,
    logger,
  });
}

module.exports = {
  createSecurityFoundations,
};
