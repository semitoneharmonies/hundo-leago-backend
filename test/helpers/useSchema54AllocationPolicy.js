"use strict";

// These retired restore protocols bind schema 54, which predates AAV-first
// decisions. Load its archived allocation policy before composing the fixture.
// Node's test-file isolation keeps this confined to the two historical suites.
const currentPath = require.resolve("../../src/domain/freeAgentDraft/candidateAllocationPolicy");
require(currentPath);
require.cache[currentPath].exports = require("../fixtures/schema54CandidateAllocationPolicy.cjs");
