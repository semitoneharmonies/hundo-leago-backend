const crypto = require("node:crypto");

const {
  UUID_PATTERN,
  validateLeagueTradeDeadlineExpectedVersion,
  validateLeagueTradeDeadlineIdempotencyKey,
  validateLeagueTradeDeadlineInput,
  validateLeagueTradeDeadlineLeagueId,
} = require("../../../domain/leagues/leagueTradeDeadlinePolicy");

const LEAGUE_TRADE_DEADLINE_OPERATION =
  "league.setup.trade_deadline.v1";
const IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;

class LeagueTradeDeadlineError extends Error {
  constructor(code, { details } = {}) {
    super(
      "The league trade deadline cannot be recorded."
    );
    this.name = "LeagueTradeDeadlineError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({
        ...details,
      });
    }
  }
}

function fail(code, options) {
  throw new LeagueTradeDeadlineError(
    code,
    options
  );
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    (typeof current === "object" ||
      typeof current === "function") &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function requireMethod(
  value,
  method,
  description
) {
  if (
    !value ||
    typeof value[method] !== "function"
  ) {
    throw new TypeError(
      `league trade deadline requires ${description}`
    );
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new TypeError(
      "league trade deadline requires a safe UTC timestamp"
    );
  }
  return nowMs;
}

function secureId(secureRandom) {
  const value = secureRandom.id();
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    throw new TypeError(
      "league trade deadline requires canonical secure identifiers"
    );
  }
  return value;
}

function requestHash({
  leagueId,
  expectedLeagueVersion,
  tradeDeadlineAtMs,
}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        expectedLeagueVersion,
        leagueId,
        operation:
          LEAGUE_TRADE_DEADLINE_OPERATION,
        tradeDeadlineAtMs,
      }),
      "utf8"
    )
    .digest("hex");
}

function internalResult(result, replayed) {
  const copy = { ...result };
  Object.defineProperty(copy, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(copy);
}

function safeRecordedResult(
  row,
  {
    recordedAtMs =
      row?.recorded_at_ms,
    code =
      "LEAGUE_TRADE_DEADLINE_RECORDED",
  } = {}
) {
  if (
    !row ||
    !UUID_PATTERN.test(row.league_id || "") ||
    row.league_status !== "setup" ||
    typeof row.league_timezone !== "string" ||
    row.league_timezone.length < 1 ||
    row.league_timezone.length > 120 ||
    row.league_timezone !==
      row.league_timezone.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(
      row.league_timezone
    ) ||
    !Number.isSafeInteger(row.league_version) ||
    row.league_version < 1 ||
    !Number.isSafeInteger(
      row.trade_deadline_at_ms
    ) ||
    !Number.isSafeInteger(
      row.settings_version
    ) ||
    row.settings_version < 1 ||
    !Number.isSafeInteger(recordedAtMs) ||
    recordedAtMs < 0 ||
    row.trade_deadline_at_ms <= recordedAtMs
  ) {
    fail(
      "LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE"
    );
  }

  return Object.freeze({
    code,
    league: Object.freeze({
      id: row.league_id,
      status: row.league_status,
      timezone: row.league_timezone,
      version: row.league_version,
    }),
    settings: Object.freeze({
      tradeDeadlineAtMs:
        row.trade_deadline_at_ms,
      version: row.settings_version,
    }),
    recordedAtMs,
  });
}

function auditRecord({
  id,
  audit,
  authority,
  authenticated,
  leagueId,
  nowMs,
}) {
  return {
    id,
    event_type:
      "league.trade_deadline_recorded",
    outcome: "success",
    actor_user_id: authority.actorUserId,
    target_user_id: null,
    league_id: leagueId,
    session_id: authenticated.session.id,
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
  };
}

function createLeagueTradeDeadlineService({
  repositoryContext,
  leagueAuthorization,
  leagueTradeDeadlineRepository,
  auditRepository,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  requireMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league-commissioner authorization"
  );
  for (const method of [
    "appendRecordedActivity",
    "completeIdempotency",
    "findContext",
    "findCurrentAggregate",
    "findIdempotency",
    "findRecordedResult",
    "insertStartedIdempotency",
    "updateSettingsDeadline",
    "updateSetupLeagueVersion",
    "writeRecordedOutbox",
  ]) {
    requireMethod(
      leagueTradeDeadlineRepository,
      method,
      "a league trade-deadline repository"
    );
  }
  requireMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function record({
    leagueId,
    input,
    expectedLeagueVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId =
      validateLeagueTradeDeadlineLeagueId(
        leagueId
      );
    const canonicalInput =
      validateLeagueTradeDeadlineInput(input);
    const expectedVersion =
      validateLeagueTradeDeadlineExpectedVersion(
        expectedLeagueVersion
      );
    const clientKey =
      validateLeagueTradeDeadlineIdempotencyKey(
        idempotencyKey
      );
    const digest = requestHash({
      leagueId: canonicalLeagueId,
      expectedLeagueVersion:
        expectedVersion,
      tradeDeadlineAtMs:
        canonicalInput.tradeDeadlineAtMs,
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(
        () => {
          const authority =
            leagueAuthorization.requireCommissioner(
              authenticated,
              canonicalLeagueId
            );
          const existing =
            leagueTradeDeadlineRepository
              .findIdempotency({
                leagueId:
                  canonicalLeagueId,
                actorUserId:
                  authority.actorUserId,
                operation:
                  LEAGUE_TRADE_DEADLINE_OPERATION,
                clientKey,
              });

          if (existing) {
            if (
              existing.request_hash !==
                digest ||
              existing.league_id !==
                canonicalLeagueId
            ) {
              fail("IDEMPOTENCY_KEY_REUSED");
            }
            if (
              existing.status !== "completed" ||
              existing.result_type !==
                "league_trade_deadline" ||
              !UUID_PATTERN.test(
                existing.result_id || ""
              ) ||
              !Number.isSafeInteger(
                existing.completed_at_ms
              )
            ) {
              fail(
                "IDEMPOTENCY_REQUEST_UNAVAILABLE"
              );
            }
            const durable =
              leagueTradeDeadlineRepository
                .findRecordedResult({
                  leagueId:
                    canonicalLeagueId,
                  activityId:
                    existing.result_id,
                });
            if (
              durable?.recorded_at_ms !==
              existing.completed_at_ms
            ) {
              fail(
                "LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE"
              );
            }
            return internalResult(
              safeRecordedResult(durable),
              true
            );
          }

          const context =
            leagueTradeDeadlineRepository
              .findContext({
                leagueId:
                  canonicalLeagueId,
              });
          if (!context) {
            fail("LEAGUE_NOT_FOUND");
          }
          if (
            context.league_version !==
            expectedVersion
          ) {
            fail(
              "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED",
              {
                details: {
                  currentVersion:
                    context.league_version,
                  refetch: true,
                },
              }
            );
          }
          if (
            context.league_status !== "setup"
          ) {
            fail(
              "LEAGUE_TRADE_DEADLINE_NOT_ALLOWED"
            );
          }
          if (
            context.settings_league_id !==
              canonicalLeagueId ||
            !Number.isSafeInteger(
              context.settings_version
            ) ||
            context.settings_version < 1
          ) {
            fail(
              "LEAGUE_TRADE_DEADLINE_SETTINGS_INVALID"
            );
          }

          const nowMs = safeNow(clock);
          if (
            canonicalInput.tradeDeadlineAtMs <=
            nowMs
          ) {
            fail(
              "LEAGUE_TRADE_DEADLINE_NOT_FUTURE"
            );
          }
          const expiresAtMs =
            nowMs +
            IDEMPOTENCY_LIFETIME_MS;
          if (
            !Number.isSafeInteger(expiresAtMs)
          ) {
            throw new TypeError(
              "league trade deadline requires a safe idempotency expiry"
            );
          }
          const ids = Object.freeze({
            activity: secureId(secureRandom),
            audit: secureId(secureRandom),
            idempotency:
              secureId(secureRandom),
            outbox: secureId(secureRandom),
          });

          leagueTradeDeadlineRepository
            .insertStartedIdempotency({
              id: ids.idempotency,
              leagueId:
                canonicalLeagueId,
              actorUserId:
                authority.actorUserId,
              operation:
                LEAGUE_TRADE_DEADLINE_OPERATION,
              clientKey,
              requestHash: digest,
              createdAtMs: nowMs,
              expiresAtMs,
            });
          const settings =
            leagueTradeDeadlineRepository
              .updateSettingsDeadline({
                leagueId:
                  canonicalLeagueId,
                tradeDeadlineAtMs:
                  canonicalInput
                    .tradeDeadlineAtMs,
                expectedVersion:
                  context.settings_version,
                nowMs,
              });
          const league =
            leagueTradeDeadlineRepository
              .updateSetupLeagueVersion({
                leagueId:
                  canonicalLeagueId,
                expectedVersion:
                  context.league_version,
                nowMs,
              });
          const metadataJson =
            JSON.stringify({
              leagueId: league.id,
              leagueStatus: league.status,
              leagueTimezone:
                league.timezone,
              leagueVersion:
                league.version,
              recordedAtMs: nowMs,
              settingsVersion:
                settings.version,
              tradeDeadlineAtMs:
                settings
                  .trade_deadline_at_ms,
            });

          leagueTradeDeadlineRepository
            .appendRecordedActivity({
              id: ids.activity,
              leagueId:
                canonicalLeagueId,
              actorUserId:
                authority.actorUserId,
              actorAuthority:
                authority.authority,
              displaySummary:
                `${context.league_name} trade deadline was recorded.`,
              metadataJson,
              nowMs,
            });
          auditRepository.append(
            auditRecord({
              id: ids.audit,
              audit,
              authority,
              authenticated,
              leagueId:
                canonicalLeagueId,
              nowMs,
            })
          );
          leagueTradeDeadlineRepository
            .writeRecordedOutbox({
              id: ids.outbox,
              leagueId:
                canonicalLeagueId,
              leagueVersion:
                league.version,
              nowMs,
            });
          leagueTradeDeadlineRepository
            .completeIdempotency({
              id: ids.idempotency,
              leagueId:
                canonicalLeagueId,
              activityId: ids.activity,
              completedAtMs: nowMs,
            });

          const current =
            safeRecordedResult(
              leagueTradeDeadlineRepository
                .findCurrentAggregate({
                  leagueId:
                    canonicalLeagueId,
                }),
              { recordedAtMs: nowMs }
            );
          const durable =
            safeRecordedResult(
              leagueTradeDeadlineRepository
                .findRecordedResult({
                  leagueId:
                    canonicalLeagueId,
                  activityId:
                    ids.activity,
                })
            );
          if (
            JSON.stringify(current) !==
            JSON.stringify(durable)
          ) {
            fail(
              "LEAGUE_TRADE_DEADLINE_RESULT_UNAVAILABLE"
            );
          }
          return internalResult(
            durable,
            false
          );
        }
      );
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof
            LeagueTradeDeadlineError ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (applicationError) {
        throw applicationError;
      }

      const versionConflict = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      if (versionConflict) {
        fail(
          "LEAGUE_TRADE_DEADLINE_PRECONDITION_FAILED",
          {
            details: {
              currentVersion: null,
              refetch: true,
            },
          }
        );
      }

      const constraint = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_CONSTRAINT"
      );
      if (constraint) {
        if (
          constraint?.details?.tableName ===
          "idempotency_requests"
        ) {
          fail(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        fail(
          "LEAGUE_TRADE_DEADLINE_NOT_ALLOWED"
        );
      }
      throw error;
    }
  }

  return Object.freeze({ record });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  LEAGUE_TRADE_DEADLINE_OPERATION,
  LeagueTradeDeadlineError,
  createLeagueTradeDeadlineService,
  requestHash,
};
