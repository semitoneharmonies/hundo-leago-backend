function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `auction resolution completion requires ${description}`
    );
  }
}

function createAuctionResolutionService({
  repository,
  secureRandom,
} = {}) {
  assertMethod(repository, "completeDue", "an atomic completion repository");
  assertMethod(secureRandom, "id", "secure stable identifiers");

  return Object.freeze({
    resolveDue({
      leagueId,
      auctionId,
      occurrenceKey,
      expectedAuctionVersion,
      nowMs,
    } = {}) {
      return repository.completeDue({
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
    },
  });
}

module.exports = { createAuctionResolutionService };
