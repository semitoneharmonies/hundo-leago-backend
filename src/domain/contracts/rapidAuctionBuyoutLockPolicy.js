const RAPID_AUCTION_KINDS = new Set(["fad_open_rapid", "fad_restricted"]);

// This evidence is loaded by the buyout repository, never accepted from HTTP.
// Keep the original lock timestamp as historical acquisition evidence.
function isRapidAuctionBuyoutLockExempt(contract, acquisition) {
  return Boolean(
    contract && acquisition &&
    contract.acquisition_source_type === "auction_resolution" &&
    acquisition.resolutionId === contract.acquisition_source_id &&
    acquisition.contractId === contract.id &&
    acquisition.leagueId === contract.league_id &&
    acquisition.seasonId === contract.start_season_id &&
    acquisition.playerId === contract.player_id &&
    acquisition.status === "resolved" &&
    acquisition.outcomeCode === "winner" &&
    typeof acquisition.fadId === "string" && acquisition.fadId.length === 36 &&
    RAPID_AUCTION_KINDS.has(acquisition.sourceKind)
  );
}

module.exports = { isRapidAuctionBuyoutLockExempt };
