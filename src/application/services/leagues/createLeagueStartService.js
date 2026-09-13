const crypto = require("node:crypto");
const {
  isDeepStrictEqual,
} = require("node:util");

const {
  createFreeAgentDraftReadinessTriggerPlan,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftReadinessPolicy"
);

const {
  LEAGUE_START_ORIGINS,
  UUID_PATTERN,
  validateLeagueStartExpectedVersion,
  validateLeagueStartIdempotencyKey,
  validateLeagueStartInput,
  validateLeagueStartLeagueId,
} = require("../../../domain/leagues/leagueStartPolicy");

const LEAGUE_START_OPERATION =
  "league.start.v1";
const IDEMPOTENCY_LIFETIME_MS =
  24 * 60 * 60 * 1000;

class LeagueStartError extends Error {
  constructor(code, { details } = {}) {
    super("The league cannot be started.");
    this.name = "LeagueStartError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({
        ...details,
      });
    }
  }
}

function fail(code, options) {
  throw new LeagueStartError(code, options);
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
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `league start requires ${description}`
    );
  }
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError(
      "league start requires a safe UTC timestamp"
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
      "league start requires canonical secure identifiers"
    );
  }
  return value;
}

function requestHash({
  leagueId,
  expectedLeagueVersion,
}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        expectedLeagueVersion,
        leagueId,
        operation: LEAGUE_START_OPERATION,
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

function safeStartedResult(
  row,
  { startedAtMs, code = "LEAGUE_STARTED" }
) {
  if (
    !row ||
    row.league_status !== "active" ||
    row.current_season_id === null ||
    row.season_id !== row.current_season_id ||
    row.season_status !== "active" ||
    row.activated_team_count < 4 ||
    row.activated_team_count !==
      row.non_erased_team_count ||
    !Number.isSafeInteger(row.league_version) ||
    row.league_version < 1 ||
    !Number.isSafeInteger(row.season_version) ||
    row.season_version < 1 ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < 0
  ) {
    fail("LEAGUE_START_RESULT_UNAVAILABLE");
  }
  return Object.freeze({
    code,
    league: Object.freeze({
      id: row.league_id,
      name: row.league_name,
      status: row.league_status,
      timezone: row.league_timezone,
      version: row.league_version,
      currentSeason: Object.freeze({
        id: row.season_id,
        label: row.season_label,
        nhlSeasonKey: row.nhl_season_key,
        status: row.season_status,
        version: row.season_version,
      }),
    }),
    activatedTeamCount:
      row.activated_team_count,
    startedAtMs,
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
    event_type: "league.started",
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

function requireFreshReadinessHandoff(
  result,
  plan
) {
  const readiness = result?.readiness;
  if (
    result?.replayed !== false ||
    !readiness ||
    !isDeepStrictEqual(readiness, {
      id: plan.readiness.operationId,
      leagueId: plan.readiness.leagueId,
      seasonId: plan.readiness.seasonId,
      occurrenceKey:
        plan.readiness.occurrenceKey,
      triggerKind:
        plan.readiness.triggerKind,
      entryDraftId:
        plan.readiness.entryDraftId,
      setupExemptionId:
        plan.readiness.setupExemptionId,
      jobRunId: plan.job.id,
      status: "pending",
      attemptCount: 0,
      blockers: [],
      matchupScheduleVersionBefore: null,
      matchupScheduleVersionAfter: null,
      scheduleRecoveryId: null,
      createdFadId: null,
      reminderJobRunId: null,
      deadlineJobRunId: null,
      cardsOpenedActivityId: null,
      cardsOpenedOutboxEventId: null,
      startedAtMs: null,
      nextRetryAtMs: null,
      terminalAtMs: null,
      createdAtMs:
        plan.readiness.createdAtMs,
      updatedAtMs:
        plan.readiness.createdAtMs,
      version: 1,
    })
  ) {
    fail("LEAGUE_START_RESULT_UNAVAILABLE");
  }
}

function createLeagueStartService({
  repositoryContext,
  leagueAuthorization,
  leagueStartRepository,
  freeAgentDraftReadinessHandoffWriter,
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
    "activatePlannedSeason",
    "activateSetupLeague",
    "activateSetupTeams",
    "appendStartedActivity",
    "classifyStartOrigin",
    "completeIdempotency",
    "findIdempotency",
    "findStartedAggregate",
    "findStartedResult",
    "findStartContext",
    "insertStartedIdempotency",
    "writeStartedOutbox",
  ]) {
    requireMethod(
      leagueStartRepository,
      method,
      "a league-start repository"
    );
  }
  requireMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  requireMethod(
    freeAgentDraftReadinessHandoffWriter,
    "write",
    "a FAD readiness handoff writer"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );

  function start({
    leagueId,
    input,
    expectedLeagueVersion,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const canonicalLeagueId =
      validateLeagueStartLeagueId(leagueId);
    validateLeagueStartInput(input);
    const expectedVersion =
      validateLeagueStartExpectedVersion(
        expectedLeagueVersion
      );
    const clientKey =
      validateLeagueStartIdempotencyKey(
        idempotencyKey
      );
    const digest = requestHash({
      leagueId: canonicalLeagueId,
      expectedLeagueVersion: expectedVersion,
    });
    const nowMs = safeNow(clock);
    const ids = Object.freeze({
      activity: secureId(secureRandom),
      audit: secureId(secureRandom),
      idempotency: secureId(secureRandom),
      outbox: secureId(secureRandom),
      readinessOperation: secureId(secureRandom),
      readinessJob: secureId(secureRandom),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority =
          leagueAuthorization.requireCommissioner(
            authenticated,
            canonicalLeagueId
          );
        const existing =
          leagueStartRepository.findIdempotency({
            leagueId: canonicalLeagueId,
            actorUserId:
              authority.actorUserId,
            operation: LEAGUE_START_OPERATION,
            clientKey,
          });
        if (existing) {
          if (
            existing.request_hash !== digest ||
            existing.league_id !==
              canonicalLeagueId
          ) {
            fail("IDEMPOTENCY_KEY_REUSED");
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !==
              "league_start" ||
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
            leagueStartRepository
              .findStartedResult({
                leagueId:
                  canonicalLeagueId,
                activityId:
                  existing.result_id,
              });
          if (
            durable?.started_at_ms !==
            existing.completed_at_ms
          ) {
            fail(
              "LEAGUE_START_RESULT_UNAVAILABLE"
            );
          }
          return internalResult(
            safeStartedResult(durable, {
              startedAtMs:
                durable.started_at_ms,
            }),
            true
          );
        }

        const context =
          leagueStartRepository.findStartContext({
            leagueId: canonicalLeagueId,
          });
        if (!context) {
          fail("LEAGUE_NOT_FOUND");
        }
        if (
          context.league_version !==
          expectedVersion
        ) {
          fail(
            "LEAGUE_START_PRECONDITION_FAILED",
            {
              details: {
                currentVersion:
                  context.league_version,
                refetch: true,
              },
            }
          );
        }
        if (context.league_status !== "setup") {
          fail("LEAGUE_START_NOT_ALLOWED");
        }
        if (
          context.settings_league_id !==
            canonicalLeagueId ||
          !Number.isSafeInteger(
            context.trade_deadline_at_ms
          ) ||
          context.trade_deadline_at_ms < 0 ||
          !Number.isSafeInteger(
            context.maximum_teams
          ) ||
          context.maximum_teams < 4 ||
          context.non_erased_team_count >
            context.maximum_teams
        ) {
          fail("LEAGUE_START_SETTINGS_INVALID");
        }
        if (
          context.season_count !== 1 ||
          context.current_season_id === null ||
          context.current_season_row_id !==
            context.current_season_id ||
          context.season_status !== "planned"
        ) {
          fail("LEAGUE_START_SEASON_INVALID");
        }
        if (
          context.non_erased_team_count !==
            context.setup_team_count ||
          context.invalid_team_state_count !== 0
        ) {
          fail(
            "LEAGUE_START_TEAM_STATE_INVALID"
          );
        }
        if (context.setup_team_count < 4) {
          fail(
            "LEAGUE_START_MINIMUM_TEAMS_REQUIRED"
          );
        }
        if (
          context.pending_launch_invitation_count !==
          0
        ) {
          fail(
            "LEAGUE_START_INVITATIONS_PENDING"
          );
        }
        if (
          context.invalid_accepted_invitation_count !==
          0
        ) {
          fail(
            "LEAGUE_START_INVITATION_STATE_INVALID"
          );
        }
        if (context.unmanaged_team_count !== 0) {
          fail(
            "LEAGUE_START_TEAM_MANAGER_REQUIRED"
          );
        }
        const startOrigin =
          leagueStartRepository.classifyStartOrigin({
            leagueId: canonicalLeagueId,
            seasonId: context.current_season_id,
          });
        if (
          !startOrigin ||
          ![
            LEAGUE_START_ORIGINS.ordinaryInaugural,
            LEAGUE_START_ORIGINS
              .resetOriginalInitialSeason2,
          ].includes(startOrigin.kind)
        ) {
          fail("LEAGUE_START_NOT_ALLOWED");
        }

        leagueStartRepository
          .insertStartedIdempotency({
            id: ids.idempotency,
            leagueId: canonicalLeagueId,
            actorUserId:
              authority.actorUserId,
            operation: LEAGUE_START_OPERATION,
            clientKey,
            requestHash: digest,
            createdAtMs: nowMs,
            expiresAtMs:
              nowMs +
              IDEMPOTENCY_LIFETIME_MS,
          });
        const teams =
          leagueStartRepository
            .activateSetupTeams({
              leagueId: canonicalLeagueId,
              expectedTeamCount:
                context.setup_team_count,
              nowMs,
            });
        const season =
          leagueStartRepository
            .activatePlannedSeason({
              leagueId: canonicalLeagueId,
              seasonId:
                context.current_season_id,
              expectedVersion:
                context.season_version,
              nowMs,
            });
        const league =
          leagueStartRepository
            .activateSetupLeague({
              leagueId: canonicalLeagueId,
              seasonId:
                context.current_season_id,
              expectedVersion:
                context.league_version,
              nowMs,
            });
        if (
          startOrigin.kind ===
          LEAGUE_START_ORIGINS.ordinaryInaugural
        ) {
          const readinessPlan =
            createFreeAgentDraftReadinessTriggerPlan({
              operationId:
                ids.readinessOperation,
              jobRunId: ids.readinessJob,
              leagueId: canonicalLeagueId,
              seasonId: season.id,
              triggerKind:
                "no_draft_inaugural",
              triggerResourceId: season.id,
              entryDraftId: null,
              setupExemptionId: null,
              createdAtMs: nowMs,
            });
          const readinessHandoff =
            freeAgentDraftReadinessHandoffWriter.write(
              {
                operationId:
                  readinessPlan.readiness
                    .operationId,
                jobRunId:
                  readinessPlan.job.id,
                leagueId:
                  readinessPlan.readiness.leagueId,
                seasonId:
                  readinessPlan.readiness.seasonId,
                triggerKind:
                  readinessPlan.readiness
                    .triggerKind,
                triggerResourceId: season.id,
                entryDraftId:
                  readinessPlan.readiness
                    .entryDraftId,
                setupExemptionId:
                  readinessPlan.readiness
                    .setupExemptionId,
                createdAtMs:
                  readinessPlan.readiness
                    .createdAtMs,
              }
            );
          requireFreshReadinessHandoff(
            readinessHandoff,
            readinessPlan
          );
        }
        const metadataJson = JSON.stringify({
          activatedTeamCount:
            teams.activatedTeamCount,
          leagueId: league.id,
          leagueName: league.name,
          leagueStatus: league.status,
          leagueTimezone: league.timezone,
          leagueVersion: league.version,
          seasonId: season.id,
          seasonLabel: season.label,
          nhlSeasonKey:
            season.nhl_season_key,
          seasonStatus: season.status,
          seasonVersion: season.version,
          startedAtMs: nowMs,
        });
        leagueStartRepository.appendStartedActivity({
          id: ids.activity,
          leagueId: canonicalLeagueId,
          seasonId: season.id,
          actorUserId:
            authority.actorUserId,
          actorAuthority:
            authority.authority,
          displaySummary:
            `${context.league_name} was started.`,
          metadataJson,
          nowMs,
        });
        auditRepository.append(
          auditRecord({
            id: ids.audit,
            audit,
            authority,
            authenticated,
            leagueId: canonicalLeagueId,
            nowMs,
          })
        );
        leagueStartRepository.writeStartedOutbox({
          id: ids.outbox,
          leagueId: canonicalLeagueId,
          leagueVersion: league.version,
          nowMs,
        });
        leagueStartRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: canonicalLeagueId,
          activityId: ids.activity,
          completedAtMs: nowMs,
        });
        const current = safeStartedResult(
          leagueStartRepository
            .findStartedAggregate({
              leagueId:
                canonicalLeagueId,
            }),
          { startedAtMs: nowMs }
        );
        const durable = safeStartedResult(
          leagueStartRepository
            .findStartedResult({
              leagueId:
                canonicalLeagueId,
              activityId: ids.activity,
            }),
          { startedAtMs: nowMs }
        );
        if (
          JSON.stringify(current) !==
          JSON.stringify(durable)
        ) {
          fail(
            "LEAGUE_START_RESULT_UNAVAILABLE"
          );
        }
        return internalResult(durable, false);
      });
    } catch (error) {
      const chain = errorChain(error);
      const applicationError = chain.find(
        (candidate) =>
          candidate instanceof LeagueStartError ||
          [
            "LEAGUE_COMMISSIONER_REQUIRED",
            "LEAGUE_NOT_FOUND",
          ].includes(candidate?.code)
      );
      if (
        applicationError
      ) {
        throw applicationError;
      }
      const versionConflict = chain.find(
        (candidate) =>
          candidate?.code ===
          "REPOSITORY_VERSION_CONFLICT"
      );
      if (
        versionConflict
      ) {
        fail(
          "LEAGUE_START_PRECONDITION_FAILED",
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
      if (
        constraint
      ) {
        if (
          constraint?.details?.tableName ===
          "idempotency_requests"
        ) {
          fail(
            "IDEMPOTENCY_REQUEST_UNAVAILABLE"
          );
        }
        fail("LEAGUE_START_NOT_ALLOWED");
      }
      throw error;
    }
  }

  return Object.freeze({ start });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  LEAGUE_START_OPERATION,
  LeagueStartError,
  createLeagueStartService,
  requestHash,
};
