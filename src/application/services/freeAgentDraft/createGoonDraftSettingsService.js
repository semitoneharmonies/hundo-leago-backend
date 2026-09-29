"use strict";
const GOON_ID = "48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03";
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function createGoonDraftSettingsService({ repository, leagueAuthorization, clock }) {
  function validateScope(input) {
    if (input.leagueId !== GOON_ID) fail("FREE_AGENT_DRAFT_NOT_FOUND");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.fadId || "")) fail("FAD_READ_INPUT_INVALID");
  }
  return Object.freeze({
    read(input) {
      validateScope(input);
      leagueAuthorization.requireCommissioner(input.authenticated,input.leagueId);
      return repository.read(input);
    },
    update(input) {
      validateScope(input);
      const body=input.input;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join() !== "auctionCreationCutoffMinutes,rolloverIntervalMinutes" ||
          !Number.isSafeInteger(body.rolloverIntervalMinutes) || body.rolloverIntervalMinutes < 1 || body.rolloverIntervalMinutes > 10080 ||
          !Number.isSafeInteger(body.auctionCreationCutoffMinutes) || body.auctionCreationCutoffMinutes < 0 ||
          body.auctionCreationCutoffMinutes >= body.rolloverIntervalMinutes || body.auctionCreationCutoffMinutes > 1440 ||
          !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail("FAD_READ_INPUT_INVALID");
      return repository.update({ leagueId:input.leagueId,fadId:input.fadId,
        expectedVersion:input.expectedVersion,...body,nowMs:clock.nowMs() },
      () => leagueAuthorization.requireCommissioner(input.authenticated,input.leagueId));
    },
  });
}
module.exports = { createGoonDraftSettingsService };
