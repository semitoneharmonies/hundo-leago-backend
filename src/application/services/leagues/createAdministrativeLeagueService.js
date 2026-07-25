const crypto = require("node:crypto");

const {
  validateIdempotencyKey,
  validateLeagueCreationInput,
} = require(
  "../../../domain/leagues/leagueCreationPolicy"
);

const OPERATION = "admin.league.create.v1";
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REPOSITORY_CONSTRAINT = "REPOSITORY_CONSTRAINT";

class LeagueNameUnavailableError extends Error {
  constructor(options = {}) {
    super("The league name is unavailable.", options);
    this.name = "LeagueNameUnavailableError";
    this.code = "LEAGUE_NAME_UNAVAILABLE";
  }
}

class LeagueIdempotencyConflictError extends Error {
  constructor(code = "IDEMPOTENCY_KEY_REUSED") {
    super("The idempotency key cannot be used for this request.");
    this.name = "LeagueIdempotencyConflictError";
    this.code = code;
  }
}

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `administrative league creation requires ${description}`
    );
  }
}

function validateSeasonContext(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !/^\d{4}$/.test(value.label || "") ||
    !/^\d{8}$/.test(value.nhlSeasonKey || "")
  ) {
    throw new TypeError(
      "administrative league creation requires the current season context"
    );
  }
  const year = Number(value.label);
  if (
    value.nhlSeasonKey !== `${year}${year + 1}`
  ) {
    throw new TypeError(
      "administrative league creation requires a reconciled season context"
    );
  }
  return Object.freeze({
    label: value.label,
    nhlSeasonKey: value.nhlSeasonKey,
  });
}

function requestHash(validated) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        nameNormalized: validated.nameNormalized,
        operation: OPERATION,
      }),
      "utf8"
    )
    .digest("hex");
}

function safeAggregate(row) {
  if (!row) {
    throw new LeagueIdempotencyConflictError(
      "IDEMPOTENCY_RESULT_UNAVAILABLE"
    );
  }
  return Object.freeze({
    code: "LEAGUE_CREATED",
    league: Object.freeze({
      id: row.league_id,
      name: row.league_name,
      status: row.league_status,
      timezone: row.league_timezone,
      currentSeasonId: row.current_season_id,
      version: row.league_version,
    }),
    season: Object.freeze({
      id: row.current_season_id,
      label: row.season_label,
      nhlSeasonKey: row.nhl_season_key,
      status: row.season_status,
      version: row.season_version,
    }),
    settings: Object.freeze({
      salaryCapCents: row.salary_cap_cents,
      tradeDeadlineAtMs: row.trade_deadline_at_ms,
      maximumTeams: row.maximum_teams,
      activeForwardSlots: row.active_forward_slots,
      activeDefenceSlots: row.active_defence_slots,
      benchSlots: row.bench_slots,
      maximumBenchAavCents: row.maximum_bench_aav_cents,
      injuredReserveSlots: row.injured_reserve_slots,
      prospectSlotsUnlimited:
        row.prospect_slots_unlimited === 1,
      scoringRuleVersion: row.scoring_rule_version,
      standingsRuleVersion: row.standings_rule_version,
      version: row.settings_version,
    }),
  });
}

function internalResult(aggregate, replayed) {
  const result = { ...aggregate };
  Object.defineProperty(result, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(result);
}

function createAdministrativeLeagueService({
  repositoryContext,
  platformAuthorization,
  leagueCreationRepository,
  auditRepository,
  clock,
  secureRandom,
  currentSeason,
} = {}) {
  assertMethod(
    repositoryContext,
    "transaction",
    "a repository transaction boundary"
  );
  assertMethod(
    platformAuthorization,
    "requireAdministrator",
    "platform authorization"
  );
  for (const method of [
    "appendCreationActivity",
    "completeIdempotency",
    "findCreationAggregate",
    "findIdempotency",
    "findLeagueByNormalizedName",
    "insertInitialSettings",
    "insertPlannedSeason",
    "insertSetupLeague",
    "insertStartedIdempotency",
    "setCurrentSeason",
  ]) {
    assertMethod(
      leagueCreationRepository,
      method,
      "a league-creation repository"
    );
  }
  assertMethod(
    auditRepository,
    "append",
    "a Security Audit repository"
  );
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  const season = validateSeasonContext(currentSeason);

  function create({
    input,
    idempotencyKey,
    authenticated,
    auditContext = null,
  } = {}) {
    const leagueInput = validateLeagueCreationInput(input);
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const digest = requestHash(leagueInput);
    const nowMs = clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError(
        "administrative league creation requires a safe UTC timestamp"
      );
    }
    const ids = Object.freeze({
      activity: secureRandom.id(),
      audit: secureRandom.id(),
      idempotency: secureRandom.id(),
      league: secureRandom.id(),
      season: secureRandom.id(),
    });
    const audit = auditContext || {};

    try {
      return repositoryContext.transaction(() => {
        const authority =
          platformAuthorization.requireAdministrator(authenticated);
        const existing =
          leagueCreationRepository.findIdempotency({
            actorUserId: authority.actorUserId,
            operation: OPERATION,
            clientKey,
          });
        if (existing) {
          if (existing.request_hash !== digest) {
            throw new LeagueIdempotencyConflictError();
          }
          if (
            existing.status !== "completed" ||
            existing.result_type !== "league" ||
            !existing.result_id
          ) {
            throw new LeagueIdempotencyConflictError(
              "IDEMPOTENCY_REQUEST_UNAVAILABLE"
            );
          }
          return internalResult(
            safeAggregate(
              leagueCreationRepository.findCreationAggregate(
                existing.result_id
              )
            ),
            true
          );
        }

        if (
          leagueCreationRepository.findLeagueByNormalizedName(
            leagueInput.nameNormalized
          )
        ) {
          throw new LeagueNameUnavailableError();
        }

        leagueCreationRepository.insertStartedIdempotency({
          id: ids.idempotency,
          actorUserId: authority.actorUserId,
          operation: OPERATION,
          clientKey,
          requestHash: digest,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + IDEMPOTENCY_LIFETIME_MS,
        });
        const insertedLeague =
          leagueCreationRepository.insertSetupLeague({
            id: ids.league,
            name: leagueInput.name,
            nameNormalized: leagueInput.nameNormalized,
            nowMs,
          });
        leagueCreationRepository.insertInitialSettings({
          leagueId: ids.league,
          nowMs,
        });
        leagueCreationRepository.insertPlannedSeason({
          id: ids.season,
          leagueId: ids.league,
          label: season.label,
          nhlSeasonKey: season.nhlSeasonKey,
          nowMs,
        });
        leagueCreationRepository.setCurrentSeason({
          leagueId: ids.league,
          seasonId: ids.season,
          expectedVersion: insertedLeague.version,
          nowMs,
        });
        leagueCreationRepository.appendCreationActivity({
          id: ids.activity,
          leagueId: ids.league,
          seasonId: ids.season,
          actorUserId: authority.actorUserId,
          displaySummary: `${leagueInput.name} was created in Setup.`,
          metadataJson: JSON.stringify({
            leagueStatus: "setup",
            seasonStatus: "planned",
          }),
          nowMs,
        });
        auditRepository.append({
          id: ids.audit,
          event_type: "platform_administration.league_created",
          outcome: "success",
          actor_user_id: authority.actorUserId,
          target_user_id: null,
          league_id: ids.league,
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
        });
        leagueCreationRepository.completeIdempotency({
          id: ids.idempotency,
          leagueId: ids.league,
          completedAtMs: nowMs,
        });
        return internalResult(
          safeAggregate(
            leagueCreationRepository.findCreationAggregate(
              ids.league
            )
          ),
          false
        );
      });
    } catch (error) {
      if (
        error instanceof LeagueNameUnavailableError ||
        error instanceof LeagueIdempotencyConflictError ||
        error?.cause instanceof LeagueNameUnavailableError ||
        error?.cause instanceof LeagueIdempotencyConflictError
      ) {
        throw error?.cause || error;
      }
      if (
        error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED" ||
        error?.cause?.code === "PLATFORM_ADMINISTRATOR_REQUIRED"
      ) {
        throw error?.cause || error;
      }
      if (
        error?.code === REPOSITORY_CONSTRAINT &&
        ["leagues", "idempotency_requests"].includes(
          error?.details?.tableName
        )
      ) {
        if (error.details.tableName === "leagues") {
          throw new LeagueNameUnavailableError({ cause: error });
        }
        throw new LeagueIdempotencyConflictError(
          "IDEMPOTENCY_REQUEST_UNAVAILABLE"
        );
      }
      throw error;
    }
  }

  return Object.freeze({ create });
}

module.exports = {
  IDEMPOTENCY_LIFETIME_MS,
  LeagueIdempotencyConflictError,
  LeagueNameUnavailableError,
  OPERATION,
  createAdministrativeLeagueService,
  requestHash,
  validateSeasonContext,
};
