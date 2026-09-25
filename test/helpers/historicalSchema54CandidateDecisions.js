"use strict";

const assert = require("node:assert/strict");
const { after } = require("node:test");
const policy = require("../../src/domain/freeAgentDraft/candidateAllocationPolicy");
const currentDecision = policy.decideCandidateAllocation;

// This isolated test process builds the retired schema-54 strict-restore
// fixture. Its competing offers have equal terms, so both ranking rules
// agree. Retain the historical decision label accepted by that sealed schema;
// never use this adapter for current-schema auction acceptance tests.
policy.decideCandidateAllocation = input => {
  const decision = currentDecision(input);
  assert.ok(new Set(decision.eligibleOffers.map(offer => offer.termYears)).size <= 1,
    "Historical fixture needs an explicit legacy policy for mixed-term offers");
  assert.notEqual(decision.decisionCode, "highest_equal_aav_term");
  if (decision.decisionCode !== "highest_aav") return decision;
  const [winner, runnerUp] = decision.eligibleOffers;
  assert.ok(winner.totalValueCents > runnerUp.totalValueCents);
  return Object.freeze({ ...decision, decisionCode: "highest_total" });
};
after(() => { policy.decideCandidateAllocation = currentDecision; });
