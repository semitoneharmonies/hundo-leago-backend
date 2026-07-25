function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`public roster reads require ${description}`);
  }
}

function createPublicRosterService({ publicRosterRepository, clock } = {}) {
  assertMethod(publicRosterRepository, "read", "a public-roster repository");
  assertMethod(clock, "nowMs", "a clock");

  return Object.freeze({
    read({ leagueId, teamId } = {}) {
      const asOfDate = new Date(clock.nowMs()).toISOString().slice(0, 10);
      const roster = publicRosterRepository.read({
        leagueId,
        teamId,
        asOfDate,
      });
      return Object.freeze({
        code: "PUBLIC_ROSTER_FOUND",
        roster,
      });
    },
  });
}

module.exports = { createPublicRosterService };
