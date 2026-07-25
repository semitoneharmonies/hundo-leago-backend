const {
  evaluateAuctionResolution,
} = require("../../../domain/auctions/auctionResolutionPolicy");

class AuctionResolutionCandidateNotFoundError extends Error {
  constructor() {
    super("The auction resolution candidate was not found.");
    this.name = "AuctionResolutionCandidateNotFoundError";
    this.code = "AUCTION_RESOLUTION_CANDIDATE_NOT_FOUND";
  }
}

function createAuctionResolutionDecisionService({ repository } = {}) {
  if (!repository || typeof repository.loadCandidate !== "function") {
    throw new TypeError(
      "auction resolution decisions require a candidate repository"
    );
  }

  return Object.freeze({
    decideDue({ leagueId, auctionId, nowMs } = {}) {
      const candidate = repository.loadCandidate({
        leagueId,
        auctionId,
        nowMs,
      });
      if (!candidate) throw new AuctionResolutionCandidateNotFoundError();
      return Object.freeze({
        auctionVersion: candidate.auctionVersion,
        seasonId: candidate.seasonId,
        decision: evaluateAuctionResolution({
          auction: candidate.auction,
          bids: candidate.bids,
        }),
      });
    },
  });
}

module.exports = {
  AuctionResolutionCandidateNotFoundError,
  createAuctionResolutionDecisionService,
};
