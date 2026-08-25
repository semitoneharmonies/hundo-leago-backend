const LATE_LOCK_STATUSES = new Set([
  "awaiting_data",
  "completed",
  "not_applicable",
  "still_illegal",
]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const AWAITING_DATA_LATE_LOCK = Object.freeze({ status: "awaiting_data" });

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `auction resolution completion requires ${description}`
    );
  }
}

function safeLateLockProjection(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "auction resolution received an unsafe late-lock result"
    );
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "status" && keys !== "lockId,status") {
    throw new TypeError(
      "auction resolution received an unsafe late-lock result"
    );
  }
  if (!LATE_LOCK_STATUSES.has(value.status)) {
    throw new TypeError(
      "auction resolution received an unsafe late-lock result"
    );
  }
  if (
    Object.hasOwn(value, "lockId") &&
    (value.status !== "completed" || !UUID_PATTERN.test(value.lockId || ""))
  ) {
    throw new TypeError(
      "auction resolution received an unsafe late-lock result"
    );
  }
  return Object.freeze({
    status: value.status,
    ...(Object.hasOwn(value, "lockId") ? { lockId: value.lockId } : {}),
  });
}

function createAuctionResolutionService({
  repository,
  lateLockCoordinator,
  secureRandom,
} = {}) {
  assertMethod(repository, "completeDue", "an atomic completion repository");
  assertMethod(
    lateLockCoordinator,
    "coordinateCommittedRoster",
    "a late-lock coordinator"
  );
  assertMethod(secureRandom, "id", "secure stable identifiers");

  return Object.freeze({
    async resolveDue({
      leagueId,
      auctionId,
      occurrenceKey,
      expectedAuctionVersion,
      nowMs,
    } = {}) {
      const result = repository.completeDue({
        leagueId,
        auctionId,
        occurrenceKey,
        expectedAuctionVersion,
        nowMs,
        resolutionId: secureRandom.id(),
        contractId: secureRandom.id(),
        contractYearIds: [
          secureRandom.id(),
          secureRandom.id(),
          secureRandom.id(),
        ],
        contractEventId: secureRandom.id(),
        ownershipId: secureRandom.id(),
        ownershipEventId: secureRandom.id(),
        auctionEventId: secureRandom.id(),
        activityId: secureRandom.id(),
        outboxEventId: secureRandom.id(),
        futureSeasonIds: [secureRandom.id(), secureRandom.id()],
      });
      if (!result.committedRoster) return result;

      let lateLock = AWAITING_DATA_LATE_LOCK;
      try {
        lateLock = safeLateLockProjection(
          await lateLockCoordinator.coordinateCommittedRoster(
            Object.freeze({
              mutationKind: "auction_resolution",
              teams: Object.freeze([result.committedRoster]),
            })
          )
        );
      } catch {
        lateLock = AWAITING_DATA_LATE_LOCK;
      }
      return Object.freeze({ ...result, lateLock });
    },
  });
}

module.exports = { createAuctionResolutionService };
