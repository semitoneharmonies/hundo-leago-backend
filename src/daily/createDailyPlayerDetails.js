const { safePlayer } = require("../application/services/players/createPlayerReadService");
const { CANONICAL_UUID_PATTERN } = require("../domain/players/playerIdentityPolicy");
const { injuryProjection } = require("../domain/players/injuryStatusPolicy");

function seasonStatistics(row, currentNhlSeason) {
  try {
    const statistics = safePlayer(row).statistics;
    if (!currentNhlSeason || statistics?.nhlSeasonKey !== currentNhlSeason ||
        ![statistics.gamesPlayed, statistics.goals, statistics.assists].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isSafeInteger(statistics.fantasyPointsHundredths)) return null;
    const { gamesPlayed, goals, assists, fantasyPointsHundredths } = statistics;
    return { gamesPlayed, goals, assists, fantasyPointsHundredths };
  } catch { return null; }
}

function publicInjury(injury) {
  if (!injury || !["injured", "healthy", "unknown"].includes(injury.status)) return injuryProjection(null);
  const { status, source, observedAtMs, needsReview, stale } = injury;
  return { status, source, observedAtMs, needsReview, stale,
    ...(status === "injured" && injury.details ? { details: {
      timeline: injury.details.timeline, designation: injury.details.designation, reason: injury.details.reason,
    } } : {}),
  };
}

// Public global information is projected afresh, never saved into Daily slates or
// looked up through league membership, contracts, bids, or trade history.
function createDailyPlayerDetails({ playerRepository, currentNhlSeason } = {}) {
  if (typeof playerRepository?.findByExternalIdentifier !== "function" ||
      typeof playerRepository?.findDetailById !== "function") throw new TypeError("Daily player details require a global player reader.");
  function project(room) {
    const details = new Map();
    function player(entry) {
      const id = entry.id;
      if (!details.has(id)) {
        let value = { injury: injuryProjection(null), seasonStatistics: null };
        if (typeof id === "string" && /^[1-9]\d{0,14}$/.test(id)) {
          try {
            const identity = playerRepository.findByExternalIdentifier({ provider: "nhl", externalValue: id });
            const row = identity && CANONICAL_UUID_PATTERN.test(identity.id) ? playerRepository.findDetailById(identity.id) : null;
            if (row && row.id === identity.id) value = {
              injury: publicInjury(row.injury), seasonStatistics: seasonStatistics(row, currentNhlSeason),
            };
          } catch { /* An unavailable or ambiguous global identity must never be guessed. */ }
        }
        details.set(id, value);
      }
      return { ...entry, ...details.get(id) };
    }
    return { ...room,
      availablePlayers: room.availablePlayers.map(player),
      auctions: room.auctions.map(player),
      members: room.members.map(member => ({ ...member, roster: member.roster.map(player) })),
    };
  }
  return Object.freeze({ project });
}

module.exports = { createDailyPlayerDetails };
