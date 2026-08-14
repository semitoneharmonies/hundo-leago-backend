const {
  validateAccountIdentity,
} = require("../../../domain/accounts/accountRegistrationPolicy");
const {
  validateLeagueCreationInput,
} = require("../../../domain/leagues/leagueCreationPolicy");
const {
  RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
  RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
  RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
  RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
  resetOriginalLeagueBootstrapRequestHash,
} = require("../../../domain/leagues/resetOriginalLeagueBootstrapPolicy");
const {
  isValidatedResetImportVerificationArtifact,
} = require("../../../infrastructure/migration/resetImportVerificationArtifact");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES =
  Object.freeze({
    artifactInvalid:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ARTIFACT_INVALID",
    conflict:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFLICT",
    inputInvalid:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAP_INPUT_INVALID",
  });

class ResetOriginalLeagueBootstrapError
  extends Error {
  constructor(code, options = {}) {
    super(
      "The reset original-league bootstrap request cannot be completed.",
      options
    );
    this.name =
      "ResetOriginalLeagueBootstrapError";
    this.code = code;
  }
}

function fail(code, options) {
  throw new ResetOriginalLeagueBootstrapError(
    code,
    options
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function exactObject(value, keys) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(
      (key) => !keys.includes(key)
    )
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .inputInvalid
    );
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `reset original-league bootstrap requires ${description}`
    );
  }
}

function normalizeRequest(request) {
  exactObject(request, [
    "appEnvironment",
    "artifact",
    "bootstrapAdministratorIdentity",
    "bootstrapUserId",
    "confirmation",
    "databaseResourceId",
    "leagueName",
    "operatingMode",
    "sourceBundleId",
    "verificationHash",
  ]);
  if (
    request.appEnvironment !== "staging" ||
    request.operatingMode !== "OFFSEASON_RESET" ||
    request.confirmation !==
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_CONFIRMATION ||
    !UUID_PATTERN.test(
      request.bootstrapUserId || ""
    )
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .inputInvalid
    );
  }
  let bootstrapAdministratorIdentity;
  try {
    bootstrapAdministratorIdentity =
      validateAccountIdentity(
        request.bootstrapAdministratorIdentity
      );
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .inputInvalid,
      { cause: error }
    );
  }
  if (
    !isValidatedResetImportVerificationArtifact(
      request.artifact
    )
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .artifactInvalid
    );
  }
  const { artifact } = request;
  if (
    artifact.payload?.environment !== "staging" ||
    artifact.payload?.verification?.environment !==
      "staging" ||
    artifact.payload?.verification?.status !==
      "verified" ||
    artifact.payload?.verification?.database
      ?.userVersion !== 50 ||
    !Array.isArray(
      artifact.payload.verification.database
        .migrationLedger
    ) ||
    !Array.isArray(
      artifact.payload.verification.database
        .targetTables
    ) ||
    artifact.binding.databaseResourceId !==
      request.databaseResourceId ||
    artifact.binding.sourceBundleId !==
      request.sourceBundleId ||
    artifact.binding.verificationHash !==
      request.verificationHash
  ) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .artifactInvalid
    );
  }
  let league;
  try {
    league = validateLeagueCreationInput({
      name: request.leagueName,
    });
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .inputInvalid,
      { cause: error }
    );
  }
  let requestHash;
  try {
    requestHash =
      resetOriginalLeagueBootstrapRequestHash({
        bootstrapUserId:
          request.bootstrapUserId,
        databaseResourceId:
          request.databaseResourceId,
        leagueNameNormalized:
          league.nameNormalized,
        sourceBundleId: request.sourceBundleId,
        stagingDescriptorSha256:
          artifact.binding
            .stagingDescriptorSha256,
        verificationHash:
          request.verificationHash,
      });
  } catch (error) {
    fail(
      RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
        .artifactInvalid,
      { cause: error }
    );
  }
  return Object.freeze({
    artifact,
    bootstrapAdministratorIdentity,
    bootstrapUserId: request.bootstrapUserId,
    expectedContinuityBaseline:
      artifact.payload.continuityBaseline,
    expectedMigrationLedger:
      artifact.payload.verification.database
        .migrationLedger,
    expectedTargetTables:
      artifact.payload.verification.database
        .targetTables,
    league,
    requestHash,
    verificationHash:
      request.verificationHash,
  });
}

function safeResult(state, replayed) {
  const result = {
    actorUserId: state.actorUserId,
    code:
      "RESET_ORIGINAL_LEAGUE_BOOTSTRAPPED",
    leagueId: state.leagueId,
    schemaVersion: state.schemaVersion,
    seasonId: state.seasonId,
    stateHash: state.stateHash,
  };
  Object.defineProperty(result, "replayed", {
    configurable: false,
    enumerable: false,
    value: replayed,
    writable: false,
  });
  return Object.freeze(result);
}

function unwrapServiceError(error) {
  if (
    error instanceof
    ResetOriginalLeagueBootstrapError
  ) {
    return error;
  }
  if (
    error?.cause instanceof
    ResetOriginalLeagueBootstrapError
  ) {
    return error.cause;
  }
  return error;
}

function createResetOriginalLeagueBootstrapService({
  repositoryContext,
  bootstrapRepository,
  leagueCreationRepository,
  auditRepository,
  authenticateDelivery,
  clock,
  secureRandom,
} = {}) {
  requireMethod(
    repositoryContext,
    "transaction",
    "an IMMEDIATE repository transaction boundary"
  );
  for (const method of [
    "assertCompletedBootstrapState",
    "assertPristineFirstAdministratorState",
  ]) {
    requireMethod(
      bootstrapRepository,
      method,
      "the reset bootstrap state repository"
    );
  }
  for (const method of [
    "appendCreationActivity",
    "completeIdempotency",
    "findCreationAggregate",
    "findIdempotency",
    "insertInitialSettings",
    "insertPlannedSeason",
    "insertSetupLeague",
    "insertStartedIdempotency",
    "setCurrentSeason",
  ]) {
    requireMethod(
      leagueCreationRepository,
      method,
      "the league-creation repository"
    );
  }
  requireMethod(
    auditRepository,
    "append",
    "the Security Audit repository"
  );
  requireMethod(clock, "nowMs", "a clock");
  requireMethod(
    secureRandom,
    "id",
    "secure identifier generation"
  );
  if (typeof authenticateDelivery !== "function") {
    throw new TypeError(
      "reset original-league bootstrap requires protected action-token authentication"
    );
  }

  function bootstrap(request) {
    const normalized = normalizeRequest(request);
    try {
      return repositoryContext.transaction(() => {
        const existing =
          leagueCreationRepository.findIdempotency({
            actorUserId:
              normalized.bootstrapUserId,
            operation:
              RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
            clientKey:
              normalized.verificationHash,
          });
        if (existing) {
          if (
            existing.request_hash !==
              normalized.requestHash ||
            existing.status !== "completed" ||
            existing.result_type !== "league" ||
            !UUID_PATTERN.test(
              existing.result_id || ""
            )
          ) {
            fail(
              RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
                .conflict
            );
          }
          const aggregate =
            leagueCreationRepository
              .findCreationAggregate(
                existing.result_id
              );
          if (
            !aggregate ||
            !UUID_PATTERN.test(
              aggregate.current_season_id || ""
            )
          ) {
            fail(
              RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
                .conflict
            );
          }
          return safeResult(
            bootstrapRepository
              .assertCompletedBootstrapState({
                authenticateDelivery,
                binding: {
                  leagueId: existing.result_id,
                  leagueName:
                    normalized.league.name,
                  leagueNameNormalized:
                    normalized.league
                      .nameNormalized,
                  requestHash:
                    normalized.requestHash,
                  seasonId:
                    aggregate.current_season_id,
                  verificationHash:
                    normalized.verificationHash,
                },
                expectedAdministratorIdentity:
                  normalized
                    .bootstrapAdministratorIdentity,
                expectedMigrationLedger:
                  normalized
                    .expectedMigrationLedger,
                expectedContinuityBaseline:
                  normalized
                    .expectedContinuityBaseline,
                expectedTargetTables:
                  normalized.expectedTargetTables,
                expectedUserId:
                  normalized.bootstrapUserId,
                pristineState: null,
              }),
            true
          );
        }

        const nowMs = clock.nowMs();
        if (
          !Number.isSafeInteger(nowMs) ||
          nowMs < 0 ||
          !Number.isSafeInteger(
            nowMs +
              RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS
          )
        ) {
          fail(
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES
              .inputInvalid
          );
        }
        const pristineState =
          bootstrapRepository
            .assertPristineFirstAdministratorState({
              authenticateDelivery,
              expectedAdministratorIdentity:
                normalized
                  .bootstrapAdministratorIdentity,
              expectedMigrationLedger:
                normalized
                  .expectedMigrationLedger,
              expectedContinuityBaseline:
                normalized
                  .expectedContinuityBaseline,
              expectedTargetTables:
                normalized.expectedTargetTables,
              expectedUserId:
                normalized.bootstrapUserId,
              nowMs,
            });
        const ids = Object.freeze({
          activity: secureRandom.id(),
          audit: secureRandom.id(),
          idempotency: secureRandom.id(),
          league: secureRandom.id(),
          season: secureRandom.id(),
        });
        leagueCreationRepository
          .insertStartedIdempotency({
            id: ids.idempotency,
            actorUserId:
              normalized.bootstrapUserId,
            operation:
              RESET_ORIGINAL_LEAGUE_BOOTSTRAP_OPERATION,
            clientKey:
              normalized.verificationHash,
            requestHash:
              normalized.requestHash,
            createdAtMs: nowMs,
            expiresAtMs:
              nowMs +
              RESET_ORIGINAL_LEAGUE_IDEMPOTENCY_LIFETIME_MS,
          });
        const league =
          leagueCreationRepository
            .insertSetupLeague({
              id: ids.league,
              name: normalized.league.name,
              nameNormalized:
                normalized.league
                  .nameNormalized,
              nowMs,
            });
        leagueCreationRepository
          .insertInitialSettings({
            leagueId: ids.league,
            nowMs,
          });
        leagueCreationRepository
          .insertPlannedSeason({
            id: ids.season,
            leagueId: ids.league,
            label:
              RESET_ORIGINAL_LEAGUE_SEASON_LABEL,
            nhlSeasonKey:
              RESET_ORIGINAL_LEAGUE_NHL_SEASON_KEY,
            nowMs,
          });
        leagueCreationRepository
          .setCurrentSeason({
            leagueId: ids.league,
            seasonId: ids.season,
            expectedVersion: league.version,
            nowMs,
          });
        leagueCreationRepository
          .appendCreationActivity({
            id: ids.activity,
            leagueId: ids.league,
            seasonId: ids.season,
            actorUserId:
              normalized.bootstrapUserId,
            displaySummary:
              `${normalized.league.name} was created in Setup.`,
            metadataJson:
              RESET_ORIGINAL_LEAGUE_ACTIVITY_METADATA_JSON,
            nowMs,
          });
        auditRepository.append({
          id: ids.audit,
          event_type:
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_AUDIT_EVENT,
          outcome: "success",
          actor_user_id:
            normalized.bootstrapUserId,
          target_user_id: null,
          league_id: ids.league,
          session_id: null,
          request_correlation_id: null,
          reason_code:
            RESET_ORIGINAL_LEAGUE_BOOTSTRAP_REASON,
          network_key_version: null,
          network_metadata_digest: null,
          client_metadata_json: null,
          unknown_account_digest: null,
          occurred_at_ms: nowMs,
        });
        leagueCreationRepository
          .completeIdempotency({
            id: ids.idempotency,
            leagueId: ids.league,
            completedAtMs: nowMs,
          });
        return safeResult(
          bootstrapRepository
            .assertCompletedBootstrapState({
              authenticateDelivery,
              binding: {
                leagueId: ids.league,
                leagueName:
                  normalized.league.name,
                leagueNameNormalized:
                  normalized.league
                    .nameNormalized,
                requestHash:
                  normalized.requestHash,
                seasonId: ids.season,
                verificationHash:
                  normalized.verificationHash,
              },
              expectedAdministratorIdentity:
                normalized
                  .bootstrapAdministratorIdentity,
              expectedMigrationLedger:
                normalized.expectedMigrationLedger,
              expectedContinuityBaseline:
                normalized
                  .expectedContinuityBaseline,
              expectedTargetTables:
                normalized.expectedTargetTables,
              expectedUserId:
                normalized.bootstrapUserId,
              pristineState,
            }),
          false
        );
      });
    } catch (error) {
      throw unwrapServiceError(error);
    }
  }

  return Object.freeze({ bootstrap });
}

module.exports = {
  RESET_ORIGINAL_LEAGUE_BOOTSTRAP_ERROR_CODES,
  ResetOriginalLeagueBootstrapError,
  createResetOriginalLeagueBootstrapService,
  normalizeRequest,
  safeResult,
};
