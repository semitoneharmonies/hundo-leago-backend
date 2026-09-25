"use strict";

const ACTUAL_OFFER_PRICING_RULE = "lowest_actual_winning_offer_v1";

function compareOffers(left, right) {
  return right.aavCents - left.aavCents ||
    right.termYears - left.termYears ||
    left.firstSubmittedAtMs - right.firstSubmittedAtMs ||
    left.id.localeCompare(right.id);
}

// History is read from this auction's immutable accepted bid events. Never
// synthesize an offer from a competing price or a lowest-AAV accumulator.
function selectActualWinningOffer({
  winner,
  competitor,
  bidHistory = [],
  validateOffer,
  dueAtMs = Number.MAX_SAFE_INTEGER,
  meetsFloor = () => true,
}) {
  const history = bidHistory.filter((event) => event && event.bidId === winner.id &&
    (event.teamId === undefined || event.teamId === winner.teamId));
  const hasCurrentOffer = history.some((offer) => offer.totalValueCents === winner.totalValueCents &&
    offer.termYears === winner.termYears && Number.isSafeInteger(offer.occurredAtMs) &&
    offer.occurredAtMs >= winner.firstSubmittedAtMs && offer.occurredAtMs <= dueAtMs);
  const offers = [...history, ...(hasCurrentOffer ? [] : [{
    totalValueCents: winner.totalValueCents,
    termYears: winner.termYears,
    occurredAtMs: winner.firstSubmittedAtMs,
  }])];
  const eligible = [];
  for (const offer of offers) {
    let contract;
    try {
      contract = validateOffer(offer.totalValueCents, offer.termYears);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(offer.occurredAtMs) ||
        offer.occurredAtMs < winner.firstSubmittedAtMs || offer.occurredAtMs > dueAtMs) continue;
    const candidate = { ...winner, ...contract };
    if (contract.aavCents > winner.aavCents ||
        !meetsFloor(candidate) ||
        (competitor && compareOffers(candidate, competitor) >= 0)) continue;
    eligible.push({
      totalValueCents: contract.totalValueCents,
      termYears: contract.termYears,
      aavCents: contract.aavCents,
      occurredAtMs: offer.occurredAtMs,
    });
  }
  eligible.sort((left, right) =>
    left.aavCents - right.aavCents ||
    left.termYears - right.termYears ||
    left.occurredAtMs - right.occurredAtMs
  );
  if (!eligible.length) throw new TypeError("No actual winning offer is eligible.");
  return Object.freeze(eligible[0]);
}

module.exports = {
  ACTUAL_OFFER_PRICING_RULE,
  compareOffers,
  selectActualWinningOffer,
};
